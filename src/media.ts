// Media types, type sniffing, metadata stripping and file records. Shared by the Worker and
// local mode: nothing here touches R2, the network or the file system.

import { randomId, utcDay } from "./util";

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
