// Media files in R2 and the signed /f/ links that serve them.

import { LIMITS } from "./config";
import { hmac, hmacValid, randomId, utcDay } from "./util";

export type MediaKind = "image" | "video" | "audio";
export type FileSource = "generated" | "inbox";
export type LinkKind = "file" | "preview";

// The only types /f/ will serve. Never SVG, HTML or anything a browser runs.
export const SERVABLE: Record<string, { kind: MediaKind; ext: string }> = {
	"image/png": { kind: "image", ext: "png" },
	"image/jpeg": { kind: "image", ext: "jpg" },
	"image/webp": { kind: "image", ext: "webp" },
	"video/mp4": { kind: "video", ext: "mp4" },
	"audio/mpeg": { kind: "audio", ext: "mp3" },
	"audio/wav": { kind: "audio", ext: "wav" },
	"audio/ogg": { kind: "audio", ext: "ogg" },
	"audio/flac": { kind: "audio", ext: "flac" },
	"audio/mp4": { kind: "audio", ext: "m4a" },
};

export interface FileRecord {
	id: string;
	key: string;
	kind: MediaKind;
	mime: string;
	source: FileSource;
	size: number;
	created: number;
	prompt?: string;
	previewKey?: string;
}

/** Finds the media type from the file's first bytes, ignoring any name or declared type. */
export function sniffType(bytes: Uint8Array): string | undefined {
	const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v);
	const ascii = (offset: number, text: string) => at(offset, ...[...text].map((c) => c.charCodeAt(0)));
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
	if (ascii(0, "OggS")) return "audio/ogg";
	if (ascii(0, "fLaC")) return "audio/flac";
	if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
	if (ascii(4, "ftyp")) {
		const brand = String.fromCharCode(...bytes.subarray(8, 12));
		return /^M4A|^M4B/.test(brand) ? "audio/mp4" : "video/mp4";
	}
	return undefined;
}

/**
 * Drops APP1 (EXIF, XMP) and APP13 (IPTC) segments from a JPEG so no location or camera data
 * survives. Runs after the Images re-encode as a second line of defence.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
	const keep: Uint8Array[] = [bytes.subarray(0, 2)];
	let offset = 2;
	while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
		const marker = bytes[offset + 1];
		if (marker === 0xda) break; // start of scan: the rest is image data
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		const end = offset + 2 + length;
		if (length < 2 || end > bytes.length) break;
		if (marker !== 0xe1 && marker !== 0xed) keep.push(bytes.subarray(offset, end));
		offset = end;
	}
	keep.push(bytes.subarray(offset));
	const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of keep) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export function newFileKey(kind: MediaKind, mime: string, now = Date.now()): { id: string; key: string } {
	const id = randomId(16);
	return { id, key: `${utcDay(now)}/${kind}-${id}.${SERVABLE[mime]?.ext ?? "bin"}` };
}

export interface Sidecar {
	prompt?: string;
	model?: string;
	params?: Record<string, unknown>;
	costMicro?: number;
	created: number;
	session?: string;
	xaiRequestId?: string;
	source: FileSource;
}

export async function putMedia(
	env: Env,
	key: string,
	bytes: Uint8Array,
	mime: string,
	sidecar: Sidecar,
): Promise<void> {
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
	await env.MEDIA.put(`${key}.json`, JSON.stringify(sidecar), {
		httpMetadata: { contentType: "application/json" },
	});
}

export async function signLink(env: Env, record: FileRecord, kind: LinkKind = "file", now = Date.now()): Promise<string> {
	const ttl = kind === "preview" ? LIMITS.previewLinkSeconds : LIMITS.linkSeconds;
	const exp = Math.floor(now / 1000) + ttl;
	const sig = await hmac(env.LINK_SIGNING_KEY, `${record.id}|${exp}|${kind}`);
	const params = new URLSearchParams({ exp: String(exp), sig });
	if (kind === "preview") params.set("k", "preview");
	return `${env.PUBLIC_URL}/f/${record.id}?${params}`;
}

const FILE_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
};

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: FILE_HEADERS });
}

/** GET /f/<id>?exp=&sig=[&k=preview]. No cookies are read or set here. */
export async function serveFile(
	request: Request,
	env: Env,
	lookup: (id: string) => Promise<FileRecord | null>,
	now = Date.now(),
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	const url = new URL(request.url);
	const id = url.pathname.slice("/f/".length);
	const exp = Number(url.searchParams.get("exp"));
	const sig = url.searchParams.get("sig") ?? "";
	const kind: LinkKind = url.searchParams.get("k") === "preview" ? "preview" : "file";
	if (!/^[a-z0-9]{16}$/.test(id) || !Number.isInteger(exp) || exp < now / 1000) return notFound();
	if (!(await hmacValid(env.LINK_SIGNING_KEY, `${id}|${exp}|${kind}`, sig))) return notFound();

	const record = await lookup(id);
	if (!record || now - record.created > LIMITS.fileDays * 86_400_000) return notFound();
	const key = kind === "preview" ? record.previewKey : record.key;
	if (!key) return notFound();
	const object = await env.MEDIA.get(key);
	if (!object) return notFound();

	const mime = kind === "preview" ? "image/jpeg" : record.mime;
	const type = SERVABLE[mime];
	if (!type) return notFound();
	const name = `${record.kind}-${record.id}${kind === "preview" ? "-preview" : ""}.${type.ext}`;
	return new Response(request.method === "HEAD" ? null : object.body, {
		headers: {
			...FILE_HEADERS,
			"Content-Type": mime,
			"Content-Disposition": `attachment; filename="${name}"`,
			"Content-Length": String(object.size),
		},
	});
}
