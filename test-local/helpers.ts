import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, vi } from "vitest";
import { readCaps } from "../src/config";
import { openLedger } from "../src/local/db";

const dirs: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const close of closers.splice(0)) close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "grok-media-test-"));
	dirs.push(dir);
	return dir;
}

export function ledgerAt(file: string, caps = readCaps({})) {
	const opened = openLedger(file, () => caps);
	closers.push(opened.close);
	return opened.ledger;
}

/** A w x h JPEG with a red left half and a blue right half. */
export function testJpeg(width = 64, height = 32): Uint8Array {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			data.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
		}
	}
	return new Uint8Array(jpeg.encode({ width, height, data }, 90).data);
}

export function testPng(width = 20, height = 10): Uint8Array {
	const png = new PNG({ width, height });
	png.data.fill(200);
	return new Uint8Array(PNG.sync.write(png));
}

/** Inserts an APP1 Exif segment (big-endian TIFF, one IFD0 entry: orientation) after SOI. */
export function withExif(jpg: Uint8Array, orientation: number, extra = "GPS 41.8781 -87.6298"): Uint8Array {
	const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0];
	const payload = [...Buffer.from("Exif\0\0"), ...tiff, ...Buffer.from(extra)];
	const length = payload.length + 2;
	const segment = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
	return new Uint8Array([...jpg.subarray(0, 2), ...segment, ...jpg.subarray(2)]);
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Route = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

export function mockFetch(...routes: Route[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		calls.push({ url: url.href, init });
		for (const route of routes) {
			const response = await route(url, init);
			if (response) return response;
		}
		throw new Error(`unexpected fetch ${url.href}`);
	}) as typeof fetch;
	return { fetcher, calls };
}
