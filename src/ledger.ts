// The spend ledger, the caps, the arming switch, the file index and the video jobs, over any
// SQLite: the Worker's Durable Object storage or a local node:sqlite file. Every
// check-and-reserve runs in one transaction, so caps hold however many callers race.

import { type Caps, LIMITS, PRICES_AS_OF, pricesAgeDays } from "./config";
import type { FileRecord, FileSource, MediaKind } from "./media";
import { randomId, utcDay, utcMonth } from "./util";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type SqlValue = string | number | null;

/** The few SQLite operations the ledger needs. `transaction` must hold the write lock for its whole run. */
export interface SqlDb {
	exec(sql: string): void;
	all<T>(sql: string, ...args: SqlValue[]): T[];
	run(sql: string, ...args: SqlValue[]): number;
	transaction<T>(fn: () => T): T;
}

export interface ReserveInput {
	tool: string;
	model: string;
	params: Record<string, unknown>;
	prompt: string;
	quoted: number;
	dedupe: string;
}

export type ReserveResult =
	| { ok: true; id: string; session: string }
	| { ok: false; reason: string }
	| { ok: false; duplicate: unknown };

export interface SettleInput {
	actual: number;
	fileIds?: string[];
	xaiRequestId?: string;
	result?: unknown;
}

export interface ArmState {
	armed: boolean;
	until?: number;
	session?: string;
	purpose?: string;
}

export interface BudgetStatus extends ArmState {
	spentToday: number;
	spentThisMonth: number;
	spentThisSession: number;
	caps: Caps;
	pricesAsOf: string;
	pricesAgeDays: number;
	pendingVideos: number;
}

export interface LedgerView {
	ts: number;
	tool: string;
	model: string | null;
	quoted: number;
	actual: number | null;
	status: string;
	reason: string | null;
	file_ids: string | null;
}

export interface JobView {
	id: string;
	status: "pending" | "done" | "failed" | "expired";
	fileId?: string;
	error?: string;
	created: number;
}

export interface JobRow {
	id: string;
	xai_id: string;
	ledger_id: string;
	file_id: string;
	status: string;
	created: number;
	attempts: number;
	next_poll: number;
	prompt: string;
	model: string;
	params: string;
	session: string;
}

export interface ExpiredFile {
	id: string;
	key: string;
	preview_key: string | null;
}

export interface LedgerOptions {
	caps: () => Caps;
	/** How the owner arms the server, for the refusal message. */
	armHint: string;
	/**
	 * Refuse paid calls when the clock reads earlier than the newest ledger row. Local mode turns
	 * this on: a computer's clock can be set back to reopen today's or this month's cap.
	 */
	guardClock?: boolean;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS ledger (
		id TEXT PRIMARY KEY, ts INTEGER NOT NULL, tool TEXT NOT NULL, model TEXT, params TEXT,
		prompt TEXT, quoted INTEGER NOT NULL DEFAULT 0, actual INTEGER, status TEXT NOT NULL,
		file_ids TEXT, xai_request_id TEXT, reason TEXT, session TEXT, dedupe TEXT,
		result TEXT, expires INTEGER
	);
	CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts);
	CREATE INDEX IF NOT EXISTS ledger_dedupe ON ledger (dedupe);
	CREATE TABLE IF NOT EXISTS files (
		id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
		source TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, prompt TEXT,
		preview_key TEXT
	);
	CREATE INDEX IF NOT EXISTS files_created ON files (created);
	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY, xai_id TEXT NOT NULL, ledger_id TEXT NOT NULL, file_id TEXT NOT NULL,
		status TEXT NOT NULL, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		next_poll INTEGER NOT NULL, prompt TEXT, model TEXT, params TEXT, session TEXT, error TEXT
	);
	CREATE TABLE IF NOT EXISTS arm (
		k INTEGER PRIMARY KEY CHECK (k = 1), until INTEGER NOT NULL, session TEXT NOT NULL,
		purpose TEXT, armed_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS monthly (month TEXT PRIMARY KEY, calls INTEGER NOT NULL, cost INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const CLOCK_SLACK = 10 * MINUTE;
const POLL_EVERY = 15_000;

export class Ledger {
	constructor(
		private sql: SqlDb,
		private options: LedgerOptions,
	) {
		sql.exec(SCHEMA);
	}

	get caps(): Caps {
		return this.options.caps();
	}

	// --- arming ---------------------------------------------------------------------------

	arm(purpose: string, now = Date.now()): ArmState {
		const until = now + this.caps.armHours * HOUR;
		const session = randomId(8);
		this.sql.run(
			"INSERT OR REPLACE INTO arm (k, until, session, purpose, armed_at) VALUES (1, ?, ?, ?, ?)",
			until,
			session,
			purpose.slice(0, 40),
			now,
		);
		return { armed: true, until, session, purpose };
	}

	disarm(): ArmState {
		this.sql.run("UPDATE arm SET until = 0 WHERE k = 1");
		return { armed: false };
	}

	armState(now = Date.now()): ArmState {
		const row = this.sql.all<{ until: number; session: string; purpose: string | null }>(
			"SELECT until, session, purpose FROM arm WHERE k = 1",
		)[0];
		if (!row || row.until <= now) return { armed: false };
		return { armed: true, until: row.until, session: row.session, purpose: row.purpose ?? undefined };
	}

	// --- spend ----------------------------------------------------------------------------

	/** Settled calls count at their actual cost, open reservations at their quote. */
	private spentSince(since: number, session?: string): number {
		const row = this.sql.all<{ total: number | null }>(
			`SELECT SUM(CASE WHEN status = 'reserved' THEN quoted ELSE COALESCE(actual, 0) END) AS total
			 FROM ledger WHERE ts >= ? AND status IN ('reserved', 'settled', 'failed')
			 ${session ? "AND session = ?" : ""}`,
			...(session ? [since, session] : [since]),
		)[0];
		return row?.total ?? 0;
	}

	sweepReservations(now: number): void {
		// A reservation nobody settled may still have been billed: count it at its quote.
		this.sql.run(
			`UPDATE ledger SET status = 'settled', actual = quoted, reason = 'reservation expired unsettled'
			 WHERE status = 'reserved' AND expires IS NOT NULL AND expires < ?`,
			now,
		);
	}

	reserve(input: ReserveInput, now = Date.now()): ReserveResult {
		return this.sql.transaction((): ReserveResult => {
			this.sweepReservations(now);
			const previous = this.sql.all<{ status: string; result: string | null }>(
				`SELECT status, result FROM ledger WHERE dedupe = ? AND ts > ? AND status IN ('reserved', 'settled')
				 ORDER BY ts DESC LIMIT 1`,
				input.dedupe,
				now - LIMITS.dedupeMinutes * MINUTE,
			)[0];
			if (previous?.result) return { ok: false, duplicate: JSON.parse(previous.result) };
			if (previous) return { ok: false, reason: "an identical request is already running" };

			const arm = this.armState(now);
			const caps = this.caps;
			const startOfDay = Date.parse(`${utcDay(now)}T00:00:00Z`);
			const startOfMonth = Date.parse(`${utcMonth(now)}-01T00:00:00Z`);
			const callsLastMinute = this.sql.all<{ n: number }>(
				"SELECT COUNT(*) AS n FROM ledger WHERE ts > ? AND status IN ('reserved', 'settled', 'failed')",
				now - MINUTE,
			)[0].n;
			const newest = this.options.guardClock
				? (this.sql.all<{ t: number | null }>("SELECT MAX(ts) AS t FROM ledger")[0].t ?? 0)
				: 0;

			let reason: string | undefined;
			if (!arm.armed) {
				reason = `the server is not armed. ${this.options.armHint}`;
			} else if (newest - now > CLOCK_SLACK) {
				reason = "the computer's clock is earlier than the last recorded call. Fix the clock and try again";
			} else if (input.quoted > caps.perCall) {
				reason = `the quote is over the per-call cap`;
			} else if (this.spentSince(0, arm.session) + input.quoted > caps.perSession) {
				reason = "it would pass the cap for this arming session";
			} else if (this.spentSince(startOfDay) + input.quoted > caps.perDay) {
				reason = "it would pass today's cap";
			} else if (this.spentSince(startOfMonth) + input.quoted > caps.perMonth) {
				reason = "it would pass this month's cap";
			} else if (callsLastMinute >= caps.callsPerMinute) {
				reason = "too many calls in the last minute";
			}

			const id = randomId(12);
			this.sql.run(
				`INSERT INTO ledger (id, ts, tool, model, params, prompt, quoted, status, reason, session, dedupe, expires)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				now,
				input.tool,
				input.model,
				JSON.stringify(input.params),
				input.prompt.slice(0, 500),
				input.quoted,
				reason ? "refused" : "reserved",
				reason ?? null,
				arm.session ?? null,
				reason ? null : input.dedupe,
				reason ? null : now + LIMITS.reservationMinutes * MINUTE,
			);
			return reason ? { ok: false, reason } : { ok: true, id, session: arm.session! };
		});
	}

	/** Records the real cost. Safe to call more than once: only the first call counts. */
	settle(id: string, input: SettleInput): boolean {
		const changed = this.sql.run(
			`UPDATE ledger SET status = 'settled', actual = ?, file_ids = ?, xai_request_id = ?, result = ?, expires = NULL
			 WHERE id = ? AND status = 'reserved'`,
			Math.max(0, Math.round(input.actual)),
			input.fileIds ? JSON.stringify(input.fileIds) : null,
			input.xaiRequestId ?? null,
			input.result === undefined ? null : JSON.stringify(input.result),
			id,
		);
		return changed > 0;
	}

	/** The call failed. If xAI may have accepted it, it still counts at its quote. */
	fail(id: string, reason: string, accepted: boolean): void {
		this.sql.run(
			`UPDATE ledger SET status = 'failed', actual = CASE WHEN ? THEN quoted ELSE 0 END, reason = ?, dedupe = NULL, expires = NULL
			 WHERE id = ? AND status = 'reserved'`,
			accepted ? 1 : 0,
			reason.slice(0, 200),
			id,
		);
	}

	/** A request refused before it reached the caps, such as by the content rules. */
	logRefusal(tool: string, prompt: string, reason: string, now = Date.now()): void {
		this.sql.run(
			"INSERT INTO ledger (id, ts, tool, prompt, quoted, status, reason, session) VALUES (?, ?, ?, ?, 0, 'refused', ?, ?)",
			randomId(12),
			now,
			tool,
			prompt.slice(0, 500),
			reason,
			this.armState(now).session ?? null,
		);
	}

	status(now = Date.now()): BudgetStatus {
		this.sweepReservations(now);
		const arm = this.armState(now);
		const lastSession = arm.session ?? this.sql.all<{ session: string }>("SELECT session FROM arm WHERE k = 1")[0]?.session;
		return {
			...arm,
			spentToday: this.spentSince(Date.parse(`${utcDay(now)}T00:00:00Z`)),
			spentThisMonth: this.spentSince(Date.parse(`${utcMonth(now)}-01T00:00:00Z`)),
			spentThisSession: lastSession ? this.spentSince(0, lastSession) : 0,
			caps: this.caps,
			pricesAsOf: PRICES_AS_OF,
			pricesAgeDays: pricesAgeDays(now),
			pendingVideos: this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")[0].n,
		};
	}

	recentLedger(limit = 20): LedgerView[] {
		return this.sql.all<LedgerView>(
			"SELECT ts, tool, model, quoted, actual, status, reason, file_ids FROM ledger ORDER BY ts DESC LIMIT ?",
			Math.min(limit, 100),
		);
	}

	// --- files ----------------------------------------------------------------------------

	addFile(record: FileRecord): void {
		this.sql.run(
			`INSERT OR REPLACE INTO files (id, key, kind, mime, source, size, created, prompt, preview_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.id,
			record.key,
			record.kind,
			record.mime,
			record.source,
			record.size,
			record.created,
			record.prompt?.slice(0, 500) ?? null,
			record.previewKey ?? null,
		);
	}

	getFile(id: string): FileRecord | null {
		const row = this.sql.all<Record<string, SqlValue>>("SELECT * FROM files WHERE id = ?", id)[0];
		return row ? toFileRecord(row) : null;
	}

	listFiles(options: { since?: number; kind?: MediaKind; source?: FileSource; limit?: number } = {}): FileRecord[] {
		const where = ["created >= ?"];
		const args: SqlValue[] = [options.since ?? 0];
		if (options.kind) {
			where.push("kind = ?");
			args.push(options.kind);
		}
		if (options.source) {
			where.push("source = ?");
			args.push(options.source);
		}
		args.push(Math.min(options.limit ?? 20, 50));
		return this.sql
			.all<Record<string, SqlValue>>(`SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY created DESC LIMIT ?`, ...args)
			.map(toFileRecord);
	}

	// --- video jobs -----------------------------------------------------------------------

	/** Hands a reservation to a video job: the job's own expiry replaces the 15-minute one. */
	addVideoJob(
		input: { ledgerId: string; xaiId: string; prompt: string; model: string; params: Record<string, unknown>; session: string },
		now = Date.now(),
	): JobView {
		const id = randomId(12);
		const fileId = randomId(16);
		this.sql.transaction(() => {
			this.sql.run(
				`INSERT INTO jobs (id, xai_id, ledger_id, file_id, status, created, next_poll, prompt, model, params, session)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
				id,
				input.xaiId,
				input.ledgerId,
				fileId,
				now,
				now + POLL_EVERY,
				input.prompt.slice(0, 500),
				input.model,
				JSON.stringify(input.params),
				input.session,
			);
			this.sql.run(
				"UPDATE ledger SET expires = NULL, xai_request_id = ?, result = ? WHERE id = ?",
				input.xaiId,
				JSON.stringify({ job_id: id }),
				input.ledgerId,
			);
		});
		return { id, status: "pending", created: now };
	}

	getJob(id: string): JobView | null {
		const row = this.sql.all<{ id: string; status: string; file_id: string; error: string | null; created: number }>(
			"SELECT id, status, file_id, error, created FROM jobs WHERE id = ?",
			id,
		)[0];
		if (!row) return null;
		return {
			id: row.id,
			status: row.status as JobView["status"],
			fileId: row.status === "done" ? row.file_id : undefined,
			error: row.error ?? undefined,
			created: row.created,
		};
	}

	/**
	 * Takes up to `limit` due jobs (or the one named) and pushes their next poll a minute out, so a
	 * second process polling at the same moment skips them.
	 */
	claimDueJobs(now: number, options: { id?: string; limit?: number } = {}): JobRow[] {
		return this.sql.transaction(() => {
			const due = this.sql.all<JobRow>(
				`SELECT * FROM jobs WHERE status = 'pending' AND next_poll <= ? ${options.id ? "AND id = ?" : ""} ORDER BY next_poll LIMIT ?`,
				...(options.id ? [now, options.id] : [now]),
				options.limit ?? 10,
			);
			for (const job of due) this.sql.run("UPDATE jobs SET next_poll = ? WHERE id = ?", now + MINUTE, job.id);
			return due;
		});
	}

	pollLater(jobId: string, at: number, attempts?: number): void {
		if (attempts === undefined) this.sql.run("UPDATE jobs SET next_poll = ? WHERE id = ?", at, jobId);
		else this.sql.run("UPDATE jobs SET attempts = ?, next_poll = ? WHERE id = ?", attempts, at, jobId);
	}

	finishJob(jobId: string, status: string, error?: string): void {
		this.sql.run("UPDATE jobs SET status = ?, error = ? WHERE id = ? AND status = 'pending'", status, error ?? null, jobId);
	}

	quoteOf(ledgerId: string): number {
		return this.sql.all<{ quoted: number }>("SELECT quoted FROM ledger WHERE id = ?", ledgerId)[0]?.quoted ?? 0;
	}

	/** A failed video's request may be retried at once: it must start a new video, not replay. */
	clearDedupe(ledgerId: string): void {
		this.sql.run("UPDATE ledger SET dedupe = NULL WHERE id = ?", ledgerId);
	}

	// --- upkeep ---------------------------------------------------------------------------

	maintenanceDue(now: number): boolean {
		const last = Number(this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = 'maintenance'")[0]?.v ?? 0);
		return now - last > DAY;
	}

	/**
	 * Folds ledger rows older than 90 days into monthly totals and returns files older than 30
	 * days. The caller deletes their bytes, then calls forgetFile for each.
	 */
	prune(now: number): ExpiredFile[] {
		const cutoff = now - LIMITS.ledgerDays * DAY;
		this.sql.transaction(() => {
			const old = this.sql.all<{ ts: number; actual: number | null; status: string }>(
				"SELECT ts, actual, status FROM ledger WHERE ts < ?",
				cutoff,
			);
			for (const row of old) {
				const counts = row.status === "settled" || row.status === "failed";
				this.sql.run(
					`INSERT INTO monthly (month, calls, cost) VALUES (?, ?, ?)
					 ON CONFLICT (month) DO UPDATE SET calls = calls + excluded.calls, cost = cost + excluded.cost`,
					utcMonth(row.ts),
					counts ? 1 : 0,
					counts ? (row.actual ?? 0) : 0,
				);
			}
			this.sql.run("DELETE FROM ledger WHERE ts < ?", cutoff);
			this.sql.run("DELETE FROM jobs WHERE created < ? AND status != 'pending'", cutoff);
			this.sql.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('maintenance', ?)", String(now));
		});
		return this.sql.all<ExpiredFile>(
			"SELECT id, key, preview_key FROM files WHERE created < ? LIMIT 500",
			now - LIMITS.fileDays * DAY,
		);
	}

	forgetFile(id: string): void {
		this.sql.run("DELETE FROM files WHERE id = ?", id);
	}

	/** When upkeep should next run: the next due video poll or reservation expiry, at most a day out. */
	nextWake(now: number): number {
		const nextPoll = this.sql.all<{ t: number | null }>("SELECT MIN(next_poll) AS t FROM jobs WHERE status = 'pending'")[0].t;
		const nextExpiry = this.sql.all<{ t: number | null }>(
			"SELECT MIN(expires) AS t FROM ledger WHERE status = 'reserved' AND expires IS NOT NULL",
		)[0].t;
		const candidates = [now + DAY, nextPoll, nextExpiry === null ? null : nextExpiry + 1000].filter(
			(t): t is number => typeof t === "number",
		);
		return Math.max(now + 1000, Math.min(...candidates));
	}
}

function toFileRecord(row: Record<string, SqlValue>): FileRecord {
	return {
		id: String(row.id),
		key: String(row.key),
		kind: row.kind as MediaKind,
		mime: String(row.mime),
		source: row.source as FileSource,
		size: Number(row.size),
		created: Number(row.created),
		prompt: row.prompt === null ? undefined : String(row.prompt),
		previewKey: row.preview_key === null ? undefined : String(row.preview_key),
	};
}
