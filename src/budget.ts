// One Durable Object, one instance ("global"), holding the ledger (src/ledger.ts) in its SQLite
// storage. A single writer makes the caps exact however many chats call at once. The alarm
// polls video jobs, sweeps stale reservations and, once a day, prunes old rows and files.

import { DurableObject } from "cloudflare:workers";
import { readCaps } from "./config";
import {
	type ArmState,
	type BudgetStatus,
	type JobView,
	Ledger,
	type LedgerView,
	type ReserveInput,
	type ReserveResult,
	type SettleInput,
	type SqlDb,
	type SqlValue,
} from "./ledger";
import type { FileRecord, FileSource, MediaKind } from "./media";
import { storeDownloadedVideo } from "./video-store";
import { pollVideos } from "./videos";
import { XaiClient } from "./xai";

export type { ArmState, BudgetStatus, JobView, LedgerView, ReserveInput, ReserveResult, SettleInput } from "./ledger";

export const ARM_HINT = "The owner arms it for a few hours on the inbox page";

function durableSql(ctx: DurableObjectState): SqlDb {
	const sql = ctx.storage.sql;
	return {
		exec: (query) => void sql.exec(query),
		all: <T>(query: string, ...args: SqlValue[]) => sql.exec(query, ...args).toArray() as T[],
		run: (query, ...args) => sql.exec(query, ...args).rowsWritten,
		transaction: (fn) => ctx.storage.transactionSync(fn),
	};
}

export class Budget extends DurableObject<Env> {
	private ledger: Ledger;
	/** Swapped in tests to mock xAI. */
	fetcher: typeof fetch = (input, init) => fetch(input, init);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ledger = new Ledger(durableSql(ctx), { caps: () => readCaps(env), armHint: ARM_HINT });
	}

	arm(purpose: string, now = Date.now()): ArmState {
		const state = this.ledger.arm(purpose, now);
		this.ensureAlarm(now);
		return state;
	}

	disarm(): ArmState {
		return this.ledger.disarm();
	}

	armState(now = Date.now()): ArmState {
		return this.ledger.armState(now);
	}

	reserve(input: ReserveInput, now = Date.now()): ReserveResult {
		const result = this.ledger.reserve(input, now);
		this.ensureAlarm(now);
		return result;
	}

	settle(id: string, input: SettleInput): boolean {
		return this.ledger.settle(id, input);
	}

	fail(id: string, reason: string, accepted: boolean): void {
		this.ledger.fail(id, reason, accepted);
	}

	logRefusal(tool: string, prompt: string, reason: string, now = Date.now()): void {
		this.ledger.logRefusal(tool, prompt, reason, now);
	}

	status(now = Date.now()): BudgetStatus {
		return this.ledger.status(now);
	}

	recentLedger(limit = 20): LedgerView[] {
		return this.ledger.recentLedger(limit);
	}

	addFile(record: FileRecord): void {
		this.ledger.addFile(record);
	}

	getFile(id: string): FileRecord | null {
		return this.ledger.getFile(id);
	}

	listFiles(options: { since?: number; kind?: MediaKind; source?: FileSource; limit?: number } = {}): FileRecord[] {
		return this.ledger.listFiles(options);
	}

	addVideoJob(
		input: { ledgerId: string; xaiId: string; prompt: string; model: string; params: Record<string, unknown>; session: string },
		now = Date.now(),
	): JobView {
		const job = this.ledger.addVideoJob(input, now);
		this.ensureAlarm(now, now + 15_000);
		return job;
	}

	getJob(id: string): JobView | null {
		return this.ledger.getJob(id);
	}

	private ensureAlarm(now: number, at?: number): void {
		const wanted = at ?? now + 15 * 60_000 + 1000;
		void this.ctx.storage.getAlarm().then((current) => {
			if (current === null || current > wanted) return this.ctx.storage.setAlarm(wanted);
		});
	}

	async alarm(): Promise<void> {
		await this.runMaintenance(Date.now());
	}

	/** Safe to run twice in a row; the alarm always reschedules. */
	async runMaintenance(now: number): Promise<void> {
		try {
			this.ledger.sweepReservations(now);
			const xai = new XaiClient(this.env.XAI_API_KEY, this.fetcher);
			await pollVideos(this.ledger, xai, (job, url, at) => storeDownloadedVideo(this.env, {
				fileId: job.file_id,
				url,
				prompt: job.prompt,
				model: job.model,
				params: JSON.parse(job.params),
				session: job.session,
				xaiRequestId: job.xai_id,
				fetcher: this.fetcher,
				now: at,
			}), now);
			if (this.ledger.maintenanceDue(now)) {
				// Files older than 30 days are deleted even if the R2 lifecycle rule is missing.
				for (const file of this.ledger.prune(now)) {
					await this.env.MEDIA.delete([file.key, `${file.key}.json`, ...(file.preview_key ? [file.preview_key] : [])]);
					this.ledger.forgetFile(file.id);
				}
			}
		} finally {
			await this.ctx.storage.setAlarm(this.ledger.nextWake(now));
		}
	}
}

export function budgetStub(env: Env): DurableObjectStub<Budget> {
	return env.BUDGET.get(env.BUDGET.idFromName("global")) as DurableObjectStub<Budget>;
}
