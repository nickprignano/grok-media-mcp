// The only code that talks to xAI. The key is read from the Worker secret and sent only in the
// Authorization header to api.x.ai; it is never logged, stored or returned.

import { XAI_API, XAI_MEDIA_HOST, ticksToMicro } from "./config";
import { fromBase64, readCapped, toBase64 } from "./util";

/** xAI refused or failed. `accepted` says whether xAI may have started (and billed) the work. */
export class XaiError extends Error {
	constructor(
		message: string,
		public status: number,
		public accepted: boolean,
	) {
		super(message);
	}
}

type Fetcher = typeof fetch;

export interface XaiImage {
	bytes: Uint8Array;
	mime: string;
}

export interface ImageResult {
	images: XaiImage[];
	costMicro?: number;
	requestId?: string;
}

export interface VideoStatus {
	status: "pending" | "done" | "failed" | "expired";
	url?: string;
	costMicro?: number;
	moderated?: boolean;
	error?: string;
}

export class XaiClient {
	constructor(
		private apiKey: string,
		private fetcher: Fetcher = fetch,
	) {}

	/**
	 * One request. Retries only when xAI cannot have accepted it: a 429 or a connection error.
	 * Anything after xAI answers with another status is never retried.
	 */
	private async call(path: string, init: RequestInit, attempts = 3): Promise<Response> {
		let lastError = "no response";
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
			let response: Response;
			try {
				response = await this.fetcher(`${XAI_API}${path}`, {
					...init,
					headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.apiKey}` },
					redirect: "error",
				});
			} catch {
				lastError = "could not reach xAI";
				continue;
			}
			if (response.status === 429) {
				lastError = "xAI rate limit";
				await response.body?.cancel();
				continue;
			}
			if (!response.ok) {
				// Error bodies are not logged or returned in full: they can echo the prompt.
				const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
				throw new XaiError(`xAI answered ${response.status}: ${detail}`, response.status, response.status >= 500);
			}
			return response;
		}
		throw new XaiError(lastError, 0, false);
	}

	private async json(path: string, body: unknown): Promise<Record<string, unknown>> {
		const response = await this.call(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		try {
			return (await response.json()) as Record<string, unknown>;
		} catch {
			throw new XaiError("xAI sent an unreadable answer", response.status, true);
		}
	}

	private async images(path: string, body: Record<string, unknown>): Promise<ImageResult> {
		const result = await this.json(path, { ...body, response_format: "b64_json" });
		const data = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
		const images: XaiImage[] = [];
		for (const item of data) {
			if (typeof item.b64_json !== "string") continue;
			images.push({ bytes: fromBase64(item.b64_json), mime: typeof item.mime_type === "string" ? item.mime_type : "image/jpeg" });
		}
		if (!images.length) throw new XaiError("xAI returned no image (it may have been moderated)", 200, true);
		const usage = result.usage as Record<string, unknown> | undefined;
		return {
			images,
			costMicro: ticksToMicro(usage?.cost_in_usd_ticks),
			requestId: typeof result.id === "string" ? result.id : undefined,
		};
	}

	generateImages(input: { model: string; prompt: string; n: number; aspectRatio?: string }): Promise<ImageResult> {
		return this.images("/v1/images/generations", {
			model: input.model,
			prompt: input.prompt,
			n: input.n,
			aspect_ratio: input.aspectRatio,
		});
	}

	editImages(input: { model: string; prompt: string; sources: XaiImage[] }): Promise<ImageResult> {
		const refs = input.sources.map((source) => ({ url: dataUrl(source) }));
		return this.images("/v1/images/edits", {
			model: input.model,
			prompt: input.prompt,
			...(refs.length === 1 ? { image: refs[0] } : { images: refs }),
		});
	}

	async startVideo(input: {
		model: string;
		prompt: string;
		seconds: number;
		resolution: string;
		aspectRatio?: string;
		startImage?: XaiImage;
	}): Promise<string> {
		const result = await this.json("/v1/videos/generations", {
			model: input.model,
			prompt: input.prompt,
			duration: input.seconds,
			resolution: input.resolution,
			aspect_ratio: input.aspectRatio,
			image: input.startImage ? { url: dataUrl(input.startImage) } : undefined,
		});
		if (typeof result.request_id !== "string" || !result.request_id) {
			throw new XaiError("xAI did not return a video job id", 200, true);
		}
		return result.request_id;
	}

	async videoStatus(requestId: string): Promise<VideoStatus> {
		const response = await this.call(`/v1/videos/${encodeURIComponent(requestId)}`, { method: "GET" }, 2);
		const result = (await response.json()) as Record<string, unknown>;
		const video = result.video as Record<string, unknown> | undefined;
		const usage = result.usage as Record<string, unknown> | undefined;
		const costMicro = ticksToMicro(usage?.cost_in_usd_ticks);
		const status = String(result.status ?? "pending");
		if (status === "done") {
			if (video?.respect_moderation === false || typeof video?.url !== "string" || !video.url) {
				return { status: "failed", moderated: true, error: "xAI moderated the video", costMicro };
			}
			return { status: "done", url: video.url, costMicro };
		}
		if (status === "expired") return { status: "expired", costMicro };
		if (status === "failed" || result.error) {
			const error = result.error as Record<string, unknown> | undefined;
			return { status: "failed", error: String(error?.code ?? "failed"), costMicro };
		}
		return { status: "pending" };
	}

	async speech(input: { text: string; voice: string; format: "mp3" | "wav" }): Promise<{ bytes: Uint8Array; mime: string; seconds?: number }> {
		const response = await this.call("/v1/tts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: input.text,
				voice_id: input.voice,
				language: "auto",
				output_format: { codec: input.format },
			}),
		});
		const mime = input.format === "mp3" ? "audio/mpeg" : "audio/wav";
		// xAI's docs show both a JSON body with base64 audio and raw audio; accept either.
		if ((response.headers.get("content-type") ?? "").includes("application/json")) {
			const result = (await response.json()) as Record<string, unknown>;
			if (typeof result.audio !== "string") throw new XaiError("xAI returned no audio", 200, true);
			return { bytes: fromBase64(result.audio), mime, seconds: typeof result.duration === "number" ? result.duration : undefined };
		}
		return { bytes: await readCapped(response.body, 25 * 1024 * 1024), mime };
	}

	async transcribe(input: { audio: Uint8Array; mime: string }): Promise<{ text: string; seconds?: number; language?: string }> {
		const form = new FormData();
		form.append("file", new Blob([input.audio], { type: input.mime }), "audio");
		const response = await this.call("/v1/stt", { method: "POST", body: form });
		const result = (await response.json()) as Record<string, unknown>;
		return {
			text: typeof result.text === "string" ? result.text : "",
			seconds: typeof result.duration === "number" ? result.duration : undefined,
			language: typeof result.language === "string" ? result.language : undefined,
		};
	}
}

function dataUrl(image: XaiImage): string {
	return `data:${image.mime};base64,${toBase64(image.bytes)}`;
}

/** Downloads generated media, only over https from an xAI host, and only up to maxBytes. */
export async function downloadMedia(url: string, maxBytes: number, fetcher: Fetcher = fetch): Promise<Uint8Array> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new XaiError("xAI sent a bad media link", 0, true);
	}
	if (parsed.protocol !== "https:" || !XAI_MEDIA_HOST.test(parsed.hostname) || parsed.port) {
		throw new XaiError("xAI media link is not on an allowed host", 0, true);
	}
	const response = await fetcher(parsed.toString(), { redirect: "error" });
	if (!response.ok) throw new XaiError(`media download failed (${response.status})`, response.status, true);
	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) {
		await response.body?.cancel();
		throw new XaiError("media is larger than the size cap", 0, true);
	}
	return readCapped(response.body, maxBytes);
}
