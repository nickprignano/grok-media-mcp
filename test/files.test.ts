import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type FileRecord, serveFile, signLink, sniffType, stripJpegMetadata } from "../src/files";
import { BASE, MP4, PNG } from "./helpers";

const record = (overrides: Partial<FileRecord> = {}): FileRecord => ({
	id: "abcdefghijkmnpqr",
	key: "2026-10-20/image-abcdefghijkmnpqr.png",
	kind: "image",
	mime: "image/png",
	source: "generated",
	size: PNG.length,
	created: Date.now(),
	...overrides,
});

describe("type sniffing", () => {
	it("reads the type from the bytes", () => {
		expect(sniffType(PNG)).toBe("image/png");
		expect(sniffType(MP4)).toBe("video/mp4");
		expect(sniffType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
		expect(sniffType(new TextEncoder().encode("<!doctype html><script>alert(1)</script>"))).toBeUndefined();
	});
});

describe("JPEG metadata stripping", () => {
	it("drops APP1 (EXIF) and APP13 segments and keeps the rest", () => {
		const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
		const app1 = [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66];
		const app13 = [0xff, 0xed, 0x00, 0x03, 0x01];
		const scan = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
		const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...app13, ...scan]);
		expect([...stripJpegMetadata(jpeg)]).toEqual([0xff, 0xd8, ...app0, ...scan]);
	});
});

describe("signed links", () => {
	it("serves a signed file as an attachment with locked-down headers and no cookies", async () => {
		const file = record();
		await env.MEDIA.put(file.key, PNG);
		const link = await signLink(env, file);
		expect(link.startsWith(`${BASE}/f/${file.id}?`)).toBe(true);
		const response = await serveFile(new Request(link), env, async () => file);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
	});

	it("refuses a tampered, expired or wrong-kind link", async () => {
		const file = record();
		await env.MEDIA.put(file.key, PNG);
		const link = new URL(await signLink(env, file));
		const lookup = async () => file;

		const tampered = new URL(link);
		tampered.searchParams.set("exp", String(Number(link.searchParams.get("exp")) + 60));
		expect((await serveFile(new Request(tampered), env, lookup)).status).toBe(404);

		const asPreview = new URL(link);
		asPreview.searchParams.set("k", "preview");
		expect((await serveFile(new Request(asPreview), env, lookup)).status).toBe(404);

		const later = Date.now() + 2 * 3600 * 1000;
		expect((await serveFile(new Request(link), env, lookup, later)).status).toBe(404);
	});

	it("refuses files older than 30 days and types it does not serve", async () => {
		const old = record({ created: Date.now() - 31 * 86_400_000 });
		await env.MEDIA.put(old.key, PNG);
		expect((await serveFile(new Request(await signLink(env, old)), env, async () => old)).status).toBe(404);

		const svg = record({ mime: "image/svg+xml" });
		expect((await serveFile(new Request(await signLink(env, svg)), env, async () => svg)).status).toBe(404);
	});
});
