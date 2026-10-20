// Polls xAI video jobs and stores finished videos. Shared by the Worker's alarm and local mode.
// Idempotent: the file id is fixed when the job starts, and settle counts once.

import { LIMITS } from "./config";
import { HOUR, type JobRow, type Ledger } from "./ledger";
import type { FileRecord } from "./media";
import { type XaiClient, XaiError } from "./xai";

/** Downloads a finished video from xAI and stores it under the job's file id. */
export type StoreVideo = (job: JobRow, url: string, now: number) => Promise<FileRecord>;

/** Polls the due jobs (or just the one named). One bad job never stops the rest. */
export async function pollVideos(ledger: Ledger, xai: XaiClient, store: StoreVideo, now: number, only?: string): Promise<void> {
	for (const job of ledger.claimDueJobs(now, { id: only })) {
		try {
			await pollJob(ledger, xai, store, job, now);
		} catch (error) {
			const attempts = job.attempts + 1;
			const permanent = error instanceof XaiError && error.status >= 400 && error.status < 500 && error.status !== 429;
			if (permanent || attempts >= 20) {
				ledger.settle(job.ledger_id, { actual: ledger.quoteOf(job.ledger_id), xaiRequestId: job.xai_id, result: { job_id: job.id } });
				ledger.finishJob(job.id, "failed", error instanceof Error ? error.message.slice(0, 200) : "failed");
			} else {
				ledger.pollLater(job.id, now + Math.min(15_000 * 2 ** attempts, 600_000), attempts);
			}
		}
	}
}

async function pollJob(ledger: Ledger, xai: XaiClient, store: StoreVideo, job: JobRow, now: number): Promise<void> {
	if (now - job.created > LIMITS.videoJobHours * HOUR) {
		ledger.finishJob(job.id, "expired", "no result within the time limit");
		ledger.settle(job.ledger_id, { actual: ledger.quoteOf(job.ledger_id), xaiRequestId: job.xai_id, result: { job_id: job.id } });
		return;
	}
	const state = await xai.videoStatus(job.xai_id);
	if (state.status === "pending") {
		ledger.pollLater(job.id, now + 15_000);
		return;
	}
	if (state.status === "done" && state.url) {
		const record = await store(job, state.url, now);
		ledger.addFile(record);
		ledger.settle(job.ledger_id, {
			actual: state.costMicro ?? ledger.quoteOf(job.ledger_id),
			fileIds: [job.file_id],
			xaiRequestId: job.xai_id,
			result: { job_id: job.id },
		});
		ledger.finishJob(job.id, "done");
		return;
	}
	// Failed, moderated or expired at xAI: charge what xAI reports, else nothing.
	ledger.settle(job.ledger_id, { actual: state.costMicro ?? 0, xaiRequestId: job.xai_id, result: { job_id: job.id } });
	ledger.clearDedupe(job.ledger_id);
	ledger.finishJob(job.id, state.status === "expired" ? "expired" : "failed", state.error ?? state.status);
}
