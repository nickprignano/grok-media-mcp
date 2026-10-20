const encoder = new TextEncoder();

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

/** A random id from an unambiguous alphabet (no 0/o, 1/l). 16 chars is about 80 bits. */
export function randomId(length = 16): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
	return out;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function base64url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string) {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

export async function hmac(secret: string, data: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
	return base64url(new Uint8Array(signature));
}

/** Constant-time check of an HMAC produced by hmac(). */
export async function hmacValid(secret: string, data: string, signature: string): Promise<boolean> {
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(signature);
	} catch {
		return false;
	}
	return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(data));
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Stable JSON for hashing: object keys sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function utcMonth(ms: number): string {
	return new Date(ms).toISOString().slice(0, 7);
}

/** Reads a body into memory, refusing once it passes maxBytes. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
	if (!body) throw new Error("empty body");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new SizeError(maxBytes);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export class SizeError extends Error {
	constructor(public maxBytes: number) {
		super(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
	}
}
