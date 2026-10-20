// Local mode's storage for the tools: files under the data folder, the ledger in SQLite, and
// paths (not links) to hand files out. Nothing listens on a port.

import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LIMITS } from "../config";
import type { Ledger } from "../ledger";
import type { MediaBackend } from "../tools";
import { type StoreVideo, pollVideos } from "../videos";
import { utcDay } from "../util";
import { XaiClient, downloadMedia } from "../xai";
import { makePreview } from "./image";

export interface LocalDeps {
	dir: string;
	ledger: Ledger;
	key?: string;
	familyNames: string;
	fetcher?: typeof fetch;
	now?: () => number;
	log?: (event: Record<string, unknown>) => void;
}

export function mediaDir(dir: string): string {
	return join(dir, "media");
}

/** The file for a stored key, refusing anything that would land outside the media folder. */
export function mediaPath(dir: string, key: string): string {
	const root = resolve(mediaDir(dir));
	const path = resolve(root, ...key.split("/"));
	const rel = relative(root, path);
	if (!rel || rel.startsWith("..") || resolve(root, rel) !== path || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}[\\/][a-z]+-[a-z0-9]{16}\.[a-z0-9]+(\.preview\.jpg)?$/.test(rel)) {
		throw new Error("bad media key");
	}
	return path;
}

export function writeMedia(dir: string, key: string, bytes: Uint8Array): string {
	const path = mediaPath(dir, key);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, bytes, { mode: 0o600 });
	return path;
}

function storeVideo(deps: LocalDeps): StoreVideo {
	return async (job, url, at) => {
		const bytes = await downloadMedia(url, LIMITS.videoBytes, deps.fetcher);
		const key = `${utcDay(at)}/video-${job.file_id}.mp4`;
		writeMedia(deps.dir, key, bytes);
		return { id: job.file_id, key, kind: "video", mime: "video/mp4", source: "generated", size: bytes.byteLength, created: at, prompt: job.prompt };
	};
}

export function localBackend(deps: LocalDeps): MediaBackend {
	const { dir, ledger } = deps;
	const now = deps.now ?? (() => Date.now());
	const xai = deps.key ? new XaiClient(deps.key, deps.fetcher) : undefined;

	const checkVideos = async (only?: string) => {
		if (xai) await pollVideos(ledger, xai, storeVideo(deps), now(), only);
	};

	return {
		ledger,
		xai,
		familyNames: deps.familyNames,
		now,
		putMedia: async (key, bytes) => {
			writeMedia(dir, key, bytes);
		},
		putPreview: async (key, bytes) => {
			writeMedia(dir, key, bytes);
		},
		readMedia: async (record, maxBytes) => {
			let path: string;
			try {
				path = realpathSync(mediaPath(dir, record.key));
			} catch {
				return undefined;
			}
			// A symlink planted in the media folder must not pull in a file from elsewhere.
			if (!path.startsWith(realpathSync(mediaDir(dir)) + sep)) return undefined;
			if (statSync(path).size > maxBytes) return undefined;
			return new Uint8Array(readFileSync(path));
		},
		preview: async (bytes, mime) => makePreview(bytes, mime),
		describe: async (record) => ({
			path: mediaPath(dir, record.key),
			...(record.previewKey ? { preview_path: mediaPath(dir, record.previewKey) } : {}),
		}),
		checkVideo: (jobId) => checkVideos(jobId),
		wording: {
			inputs: "added with the grok-media-mcp add command",
			files: `Files are on this computer at the paths shown and are deleted after ${LIMITS.fileDays} days.`,
			noKey: "no xAI key is set. The owner runs grok-media-mcp set-key in a terminal",
		},
		log: deps.log ?? ((event) => process.stderr.write(`${JSON.stringify(event)}\n`)),
	};
}

/** Sweeps reservations, polls due videos and, once a day, deletes files older than 30 days. */
export async function upkeep(deps: LocalDeps): Promise<void> {
	const { dir, ledger } = deps;
	const now = (deps.now ?? Date.now)();
	ledger.sweepReservations(now);
	if (deps.key) await pollVideos(ledger, new XaiClient(deps.key, deps.fetcher), storeVideo(deps), now);
	if (ledger.maintenanceDue(now)) {
		for (const file of ledger.prune(now)) {
			for (const key of [file.key, ...(file.preview_key ? [file.preview_key] : [])]) {
				try {
					rmSync(mediaPath(dir, key), { force: true });
				} catch {
					// a bad key is skipped, never followed
				}
			}
			ledger.forgetFile(file.id);
		}
	}
}
