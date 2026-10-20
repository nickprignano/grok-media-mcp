import { LIMITS } from "./config";
import { type FileRecord, putMedia } from "./files";
import { utcDay } from "./util";
import { downloadMedia } from "./xai";

/** Copies a finished video from xAI into R2 under the file id the job was given at the start. */
export async function storeDownloadedVideo(
	env: Env,
	input: {
		fileId: string;
		url: string;
		prompt: string;
		model: string;
		params: Record<string, unknown>;
		session: string;
		xaiRequestId: string;
		fetcher: typeof fetch;
		now: number;
	},
): Promise<FileRecord> {
	const bytes = await downloadMedia(input.url, LIMITS.videoBytes, input.fetcher);
	const key = `${utcDay(input.now)}/video-${input.fileId}.mp4`;
	await putMedia(env, key, bytes, "video/mp4", {
		prompt: input.prompt,
		model: input.model,
		params: input.params,
		created: input.now,
		session: input.session,
		xaiRequestId: input.xaiRequestId,
		source: "generated",
	});
	return {
		id: input.fileId,
		key,
		kind: "video",
		mime: "video/mp4",
		source: "generated",
		size: bytes.byteLength,
		created: input.now,
		prompt: input.prompt,
	};
}
