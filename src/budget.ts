// One Durable Object, one instance ("global"): the spend ledger, the caps, the arming switch,
// the file index and the video jobs. A single writer makes the caps exact however many chats
// call at once. Every check-and-reserve runs in one synchronous SQLite transaction.

import { DurableObject } from "cloudflare:workers";
import { type Caps, LIMITS, PRICES_AS_OF, pricesAgeDays, readCaps } from "./config";
import type { FileRecord, FileSource, MediaKind } from "./files";
import { randomId, utcDay, utcMonth } from "./util";
import { XaiClient, XaiError } from "./xai";
import { storeDownloadedVideo } from "./video-store";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

export interface LedgerView extends Record<string, SqlStorageValue> {
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

interface JobRow extends Record<string, SqlStorageValue> {
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

export class Budget extends DurableObject<Env> {
	private sql: SqlStorage;
	/** Swapped in tests to mock xAI. */
	fetcher: typeof fetch = (input, init) => fetch(input, init);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
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
		`);
	}

	// --- arming ---------------------------------------------------------------------------

	arm(purpose: string, now = Date.now()): ArmState {
		const hours = readCaps(this.env).armHours;
		const until = now + hours * HOUR;
		const session = randomId(8);
		this.sql.exec(
			"INSERT OR REPLACE INTO arm (k, until, session, purpose, armed_at) VALUES (1, ?, ?, ?, ?)",
			until,
			session,
			purpose.slice(0, 40),
			now,
		);
		this.ensureAlarm(now);
		return { armed: true, until, session, purpose };
	}

	disarm(): ArmState {
		this.sql.exec("UPDATE arm SET until = 0 WHERE k = 1");
		return { armed: false };
	}

	armState(now = Date.now()): ArmState {
		const row = this.sql.exec<{ until: number; session: string; purpose: string | null }>(
			"SELECT until, session, purpose FROM arm WHERE k = 1",
		).toArray()[0];
		if (!row || row.until <= now) return { armed: false };
		return { armed: true, until: row.until, session: row.session, purpose: row.purpose ?? undefined };
	}

	// --- spend ----------------------------------------------------------------------------

	/** Settled calls count at their actual cost, open reservations at their quote. */
	private spentSince(since: number, session?: string): number {
		const row = this.sql
			.exec<{ total: number | null }>(
				`SELECT SUM(CASE WHEN status = 'reserved' THEN quoted ELSE COALESCE(actual, 0) END) AS total
				 FROM ledger WHERE ts >= ? AND status IN ('reserved', 'settled', 'failed')
				 ${session ? "AND session = ?" : ""}`,
				...(session ? [since, session] : [since]),
			)
			.one();
		return row.total ?? 0;
	}

	private sweepReservations(now: number): void {
		// A reservation nobody settled may still have been billed: count it at its quote.
		this.sql.exec(
			`UPDATE ledger SET status = 'settled', actual = quoted, reason = 'reservation expired unsettled'
			 WHERE status = 'reserved' AND expires IS NOT NULL AND expires < ?`,
			now,
		);
	}

	reserve(input: ReserveInput, now = Date.now()): ReserveResult {
		const result = this.ctx.storage.transactionSync((): ReserveResult => {
			this.sweepReservations(now);
			const previous = this.sql
				.exec<{ status: string; result: string | null }>(
					`SELECT status, result FROM ledger WHERE dedupe = ? AND ts > ? AND status IN ('reserved', 'settled')
					 ORDER BY ts DESC LIMIT 1`,
					input.dedupe,
					now - LIMITS.dedupeMinutes * MINUTE,
				)
				.toArray()[0];
			if (previous?.result) return { ok: false, duplicate: JSON.parse(previous.result) };
			if (previous) return { ok: false, reason: "an identical request is already running" };

			const arm = this.armState(now);
			const caps = readCaps(this.env);
			const startOfDay = Date.parse(`${utcDay(now)}T00:00:00Z`);
			const startOfMonth = Date.parse(`${utcMonth(now)}-01T00:00:00Z`);
			const callsLastMinute = this.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM ledger WHERE ts > ? AND status IN ('reserved', 'settled', 'failed')",
					now - MINUTE,
				)
				.one().n;

			let reason: string | undefined;
			if (!arm.armed) {
				reason = "the server is not armed. The owner arms it for a few hours on the inbox page";
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
			this.sql.exec(
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
		this.ensureAlarm(now);
		return result;
	}

	/** Records the real cost. Safe to call more than once: only the first call counts. */
	settle(id: string, input: SettleInput): boolean {
		const cursor = this.sql.exec(
			`UPDATE ledger SET status = 'settled', actual = ?, file_ids = ?, xai_request_id = ?, result = ?, expires = NULL
			 WHERE id = ? AND status = 'reserved'`,
			Math.max(0, Math.round(input.actual)),
			input.fileIds ? JSON.stringify(input.fileIds) : null,
			input.xaiRequestId ?? null,
			input.result === undefined ? null : JSON.stringify(input.result),
			id,
		);
		return cursor.rowsWritten > 0;
	}

	/** The call failed. If xAI may have accepted it, it still counts at its quote. */
	fail(id: string, reason: string, accepted: boolean): void {
		this.sql.exec(
			`UPDATE ledger SET status = 'failed', actual = CASE WHEN ? THEN quoted ELSE 0 END, reason = ?, dedupe = NULL, expires = NULL
			 WHERE id = ? AND status = 'reserved'`,
			accepted ? 1 : 0,
			reason.slice(0, 200),
			id,
		);
	}

	/** A request refused before it reached the caps, such as by the content rules. */
	logRefusal(tool: string, prompt: string, reason: string, now = Date.now()): void {
		this.sql.exec(
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
		const lastSession = arm.session ?? this.sql.exec<{ session: string }>("SELECT session FROM arm WHERE k = 1").toArray()[0]?.session;
		return {
			...arm,
			spentToday: this.spentSince(Date.parse(`${utcDay(now)}T00:00:00Z`)),
			spentThisMonth: this.spentSince(Date.parse(`${utcMonth(now)}-01T00:00:00Z`)),
			spentThisSession: lastSession ? this.spentSince(0, lastSession) : 0,
			caps: readCaps(this.env),
			pricesAsOf: PRICES_AS_OF,
			pricesAgeDays: pricesAgeDays(now),
			pendingVideos: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").one().n,
		};
	}

	recentLedger(limit = 20): LedgerView[] {
		return this.sql
			.exec<LedgerView>(
				"SELECT ts, tool, model, quoted, actual, status, reason, file_ids FROM ledger ORDER BY ts DESC LIMIT ?",
				Math.min(limit, 100),
			)
			.toArray();
	}

	// --- files ----------------------------------------------------------------------------

	addFile(record: FileRecord): void {
		this.sql.exec(
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
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>("SELECT * FROM files WHERE id = ?", id)
			.toArray()[0];
		return row ? toFileRecord(row) : null;
	}

	listFiles(options: { since?: number; kind?: MediaKind; source?: FileSource; limit?: number } = {}): FileRecord[] {
		const where = ["created >= ?"];
		const args: SqlStorageValue[] = [options.since ?? 0];
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
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY created DESC LIMIT ?`,
				...args,
			)
			.toArray()
			.map(toFileRecord);
	}

	// --- video jobs -----------------------------------------------------------------------

	/** Hands a reservation to a video job: the job's own expiry replaces the 15-minute one. */
	addVideoJob(input: { ledgerId: string; xaiId: string; prompt: string; model: string; params: Record<string, unknown>; session: string }, now = Date.now()): JobView {
		const id = randomId(12);
		const fileId = randomId(16);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO jobs (id, xai_id, ledger_id, file_id, status, created, next_poll, prompt, model, params, session)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
				id,
				input.xaiId,
				input.ledgerId,
				fileId,
				now,
				now + 15_000,
				input.prompt.slice(0, 500),
				input.model,
				JSON.stringify(input.params),
				input.session,
			);
			this.sql.exec(
				"UPDATE ledger SET expires = NULL, xai_request_id = ?, result = ? WHERE id = ?",
				input.xaiId,
				JSON.stringify({ job_id: id }),
				input.ledgerId,
			);
		});
		this.ensureAlarm(now, now + 15_000);
		return { id, status: "pending", created: now };
	}

	getJob(id: string): JobView | null {
		const row = this.sql
			.exec<{ id: string; status: string; file_id: string; error: string | null; created: number }>(
				"SELECT id, status, file_id, error, created FROM jobs WHERE id = ?",
				id,
			)
			.toArray()[0];
		if (!row) return null;
		return {
			id: row.id,
			status: row.status as JobView["status"],
			fileId: row.status === "done" ? row.file_id : undefined,
			error: row.error ?? undefined,
			created: row.created,
		};
	}

	/** Polls one job. Idempotent: the file key is fixed when the job is made, settle counts once. */
	private async pollJob(job: JobRow, now: number): Promise<void> {
		if (now - job.created > LIMITS.videoJobHours * HOUR) {
			this.finishJob(job, "expired", "no result within the time limit");
			this.sql.exec("UPDATE ledger SET status = 'settled', actual = quoted, expires = NULL WHERE id = ? AND status = 'reserved'", job.ledger_id);
			return;
		}
		const xai = new XaiClient(this.env.XAI_API_KEY, this.fetcher);
		const state = await xai.videoStatus(job.xai_id);
		if (state.status === "pending") {
			this.sql.exec("UPDATE jobs SET next_poll = ? WHERE id = ?", now + 15_000, job.id);
			return;
		}
		if (state.status === "done" && state.url) {
			const record = await storeDownloadedVideo(this.env, {
				fileId: job.file_id,
				url: state.url,
				prompt: job.prompt,
				model: job.model,
				params: JSON.parse(job.params),
				session: job.session,
				xaiRequestId: job.xai_id,
				fetcher: this.fetcher,
				now,
			});
			this.addFile(record);
			const quoted = this.sql.exec<{ quoted: number }>("SELECT quoted FROM ledger WHERE id = ?", job.ledger_id).one().quoted;
			this.settle(job.ledger_id, {
				actual: state.costMicro ?? quoted,
				fileIds: [job.file_id],
				xaiRequestId: job.xai_id,
				result: { job_id: job.id },
			});
			this.finishJob(job, "done");
			return;
		}
		// Failed, moderated or expired at xAI: charge what xAI reports, else nothing.
		this.settle(job.ledger_id, { actual: state.costMicro ?? 0, xaiRequestId: job.xai_id, result: { job_id: job.id } });
		this.sql.exec("UPDATE ledger SET dedupe = NULL WHERE id = ?", job.ledger_id); // a retry starts a new video
		this.finishJob(job, state.status === "expired" ? "expired" : "failed", state.error ?? state.status);
	}

	private finishJob(job: JobRow, status: string, error?: string): void {
		this.sql.exec("UPDATE jobs SET status = ?, error = ? WHERE id = ? AND status = 'pending'", status, error ?? null, job.id);
	}

	// --- alarm ----------------------------------------------------------------------------

	private ensureAlarm(now: number, at?: number): void {
		const wanted = at ?? now + LIMITS.reservationMinutes * MINUTE + 1000;
		void this.ctx.storage.getAlarm().then((current) => {
			if (current === null || current > wanted) return this.ctx.storage.setAlarm(wanted);
		});
	}

	/**
	 * Polls video jobs, sweeps stale reservations and, once a day, prunes old ledger rows and
	 * expired files. Every step catches its own errors and the alarm always reschedules, so one
	 * bad job can't stop the rest. Running it twice in a row is harmless.
	 */
	async alarm(): Promise<void> {
		await this.runMaintenance(Date.now());
	}

	async runMaintenance(now: number): Promise<void> {
		try {
			this.sweepReservations(now);
			const due = this.sql
				.exec<JobRow>("SELECT * FROM jobs WHERE status = 'pending' AND next_poll <= ? ORDER BY next_poll LIMIT 10", now)
				.toArray();
			for (const job of due) {
				try {
					await this.pollJob(job, now);
				} catch (error) {
					const attempts = job.attempts + 1;
					const permanent = error instanceof XaiError && error.status >= 400 && error.status < 500 && error.status !== 429;
					if (permanent || attempts >= 20) {
						this.settle(job.ledger_id, { actual: this.quoteOf(job.ledger_id), xaiRequestId: job.xai_id, result: { job_id: job.id } });
						this.finishJob(job, "failed", error instanceof Error ? error.message.slice(0, 200) : "failed");
					} else {
						this.sql.exec(
							"UPDATE jobs SET attempts = ?, next_poll = ? WHERE id = ?",
							attempts,
							now + Math.min(15_000 * 2 ** attempts, 10 * MINUTE),
							job.id,
						);
					}
				}
			}
			const last = Number(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'maintenance'").toArray()[0]?.v ?? 0);
			if (now - last > DAY) {
				await this.dailyCleanup(now);
				this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('maintenance', ?)", String(now));
			}
		} finally {
			await this.scheduleNext(now);
		}
	}

	private quoteOf(ledgerId: string): number {
		return this.sql.exec<{ quoted: number }>("SELECT quoted FROM ledger WHERE id = ?", ledgerId).toArray()[0]?.quoted ?? 0;
	}

	private async dailyCleanup(now: number): Promise<void> {
		// Ledger rows older than 90 days fold into monthly totals.
		const cutoff = now - LIMITS.ledgerDays * DAY;
		this.ctx.storage.transactionSync(() => {
			const old = this.sql
				.exec<{ ts: number; actual: number | null; status: string }>(
					"SELECT ts, actual, status FROM ledger WHERE ts < ?",
					cutoff,
				)
				.toArray();
			for (const row of old) {
				const counts = row.status === "settled" || row.status === "failed";
				this.sql.exec(
					`INSERT INTO monthly (month, calls, cost) VALUES (?, ?, ?)
					 ON CONFLICT (month) DO UPDATE SET calls = calls + excluded.calls, cost = cost + excluded.cost`,
					utcMonth(row.ts),
					counts ? 1 : 0,
					counts ? (row.actual ?? 0) : 0,
				);
			}
			this.sql.exec("DELETE FROM ledger WHERE ts < ?", cutoff);
			this.sql.exec("DELETE FROM jobs WHERE created < ? AND status != 'pending'", cutoff);
		});
		// Files older than 30 days are deleted even if the R2 lifecycle rule is missing.
		const expired = this.sql
			.exec<{ id: string; key: string; preview_key: string | null }>(
				"SELECT id, key, preview_key FROM files WHERE created < ? LIMIT 500",
				now - LIMITS.fileDays * DAY,
			)
			.toArray();
		for (const file of expired) {
			const keys = [file.key, `${file.key}.json`, ...(file.preview_key ? [file.preview_key] : [])];
			await this.env.MEDIA.delete(keys);
			this.sql.exec("DELETE FROM files WHERE id = ?", file.id);
		}
	}

	private async scheduleNext(now: number): Promise<void> {
		const nextPoll = this.sql
			.exec<{ t: number | null }>("SELECT MIN(next_poll) AS t FROM jobs WHERE status = 'pending'")
			.one().t;
		const nextExpiry = this.sql
			.exec<{ t: number | null }>("SELECT MIN(expires) AS t FROM ledger WHERE status = 'reserved' AND expires IS NOT NULL")
			.one().t;
		const candidates = [now + DAY, nextPoll, nextExpiry === null ? null : nextExpiry + 1000].filter(
			(t): t is number => typeof t === "number",
		);
		await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...candidates)));
	}
}

function toFileRecord(row: Record<string, SqlStorageValue>): FileRecord {
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

export function budgetStub(env: Env): DurableObjectStub<Budget> {
	return env.BUDGET.get(env.BUDGET.idFromName("global")) as DurableObjectStub<Budget>;
}
