// `grok-media-mcp add <file>`: copies one of the owner's own images or recordings in as a tool
// input. Images are decoded and re-encoded as plain JPEG; audio is copied as is.

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS } from "../config";
import type { Ledger } from "../ledger";
import { type FileRecord, SERVABLE, newFileKey, sniffType } from "../media";
import { writeMedia } from "./backend";
import { ImageError, reencode } from "./image";

export class AddError extends Error {}

export function addFile(dir: string, ledger: Ledger, input: string, now = Date.now()): FileRecord {
	// UNC shares and \\?\ device paths can reach other machines or devices.
	if (/^[\\/]{2}/.test(input)) throw new AddError("network and device paths aren't accepted; copy the file to this computer first");
	const path = resolve(input);
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(path);
	} catch {
		throw new AddError("that file doesn't exist");
	}
	if (info.isSymbolicLink()) throw new AddError("that's a link; give the real file");
	if (!info.isFile()) throw new AddError("that isn't a file");
	if (info.size > LIMITS.audioBytes) throw new AddError("files can be up to 25 MB");

	let bytes: Uint8Array = new Uint8Array(readFileSync(path));
	const sniffed = sniffType(bytes);
	const type = sniffed ? SERVABLE[sniffed] : undefined;
	if (!sniffed || !type || type.kind === "video") throw new AddError("only JPEG or PNG images and MP3, WAV, OGG, FLAC or M4A audio");

	let mime = sniffed;
	if (type.kind === "image") {
		if (bytes.byteLength > LIMITS.imageBytes) throw new AddError("images can be up to 20 MB");
		try {
			bytes = reencode(bytes, sniffed);
		} catch (error) {
			throw new AddError(error instanceof ImageError ? error.message : "the image could not be re-encoded");
		}
		if (sniffType(bytes) !== "image/jpeg") throw new AddError("the image could not be re-encoded");
		mime = "image/jpeg";
	}

	const kind = SERVABLE[mime].kind;
	const { id, key } = newFileKey(kind, mime, now);
	writeMedia(dir, key, bytes);
	const record: FileRecord = { id, key, kind, mime, source: "inbox", size: bytes.byteLength, created: now };
	ledger.addFile(record);
	return record;
}
