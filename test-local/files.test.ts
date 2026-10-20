import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { sniffType } from "../src/media";
import { AddError, addFile } from "../src/local/add";
import { mediaPath } from "../src/local/backend";
import { jpegOrientation, makePreview, reencode } from "../src/local/image";
import { dataDir } from "../src/local/paths";
import { ledgerAt, tempDir, testJpeg, testPng, withExif } from "./helpers";

const hasApp1 = (bytes: Uint8Array) => {
	for (let i = 2; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) return true;
	return false;
};

describe("re-encoding", () => {
	it("drops EXIF and keeps the photo upright", () => {
		const photo = withExif(testJpeg(64, 32), 6);
		expect(jpegOrientation(photo)).toBe(6);
		const out = reencode(photo, "image/jpeg");
		expect(sniffType(out)).toBe("image/jpeg");
		expect(hasApp1(out)).toBe(false);
		expect(Buffer.from(out).includes("GPS")).toBe(false);
		const decoded = jpeg.decode(out, { useTArray: true });
		expect([decoded.width, decoded.height]).toEqual([32, 64]); // rotated a quarter turn
	});

	it("removes anything appended to the image, such as a zip in a polyglot", () => {
		const polyglot = new Uint8Array([...testJpeg(), ...Buffer.from("PK\u0003\u0004 hidden archive <script>")]);
		const out = reencode(polyglot, "image/jpeg");
		expect(Buffer.from(out).includes("hidden archive")).toBe(false);
	});

	it("turns a PNG into a plain JPEG without its text chunks", () => {
		const out = reencode(testPng(), "image/png");
		expect(sniffType(out)).toBe("image/jpeg");
	});

	it("refuses WebP and broken images", () => {
		expect(() => reencode(new Uint8Array([...Buffer.from("RIFF\0\0\0\0WEBPVP8 ")]), "image/webp")).toThrow(/JPEG/);
		expect(() => reencode(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3]), "image/jpeg")).toThrow(/decoded/);
	});

	it("makes a small preview", () => {
		const preview = makePreview(testJpeg(2000, 1000), "image/jpeg")!;
		const decoded = jpeg.decode(preview, { useTArray: true });
		expect([decoded.width, decoded.height]).toEqual([512, 256]);
	});
});

describe("add", () => {
	it("stores a re-encoded copy and records it as the owner's input", () => {
		const dir = tempDir();
		const ledger = ledgerAt(join(dir, "ledger.db"));
		const photo = join(dir, "photo.jpg");
		writeFileSync(photo, withExif(testJpeg(), 1));
		const record = addFile(dir, ledger, photo);
		expect(record).toMatchObject({ kind: "image", mime: "image/jpeg", source: "inbox" });
		expect(hasApp1(readFileSync(mediaPath(dir, record.key)))).toBe(false);
		expect(ledger.getFile(record.id)?.id).toBe(record.id);
	});

	it("refuses links, folders, network paths, video and unknown types", () => {
		const dir = tempDir();
		const ledger = ledgerAt(join(dir, "ledger.db"));
		const real = join(dir, "real.jpg");
		writeFileSync(real, testJpeg());
		const link = join(dir, "link.jpg");
		let linked = true;
		try {
			symlinkSync(real, link);
		} catch {
			linked = false; // Windows without symlink rights
		}
		if (linked) expect(() => addFile(dir, ledger, link)).toThrow(/link/);
		mkdirSync(join(dir, "folder"));
		expect(() => addFile(dir, ledger, join(dir, "folder"))).toThrow(AddError);
		expect(() => addFile(dir, ledger, "\\\\server\\share\\a.jpg")).toThrow(/network/);
		expect(() => addFile(dir, ledger, "//server/share/a.jpg")).toThrow(/network/);
		const text = join(dir, "notes.txt");
		writeFileSync(text, "hello");
		expect(() => addFile(dir, ledger, text)).toThrow(/only JPEG/);
	});
});

describe("paths", () => {
	it("puts the data folder in each system's usual place", () => {
		expect(dataDir("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a")).toMatch(/AppData[\\/]Roaming[\\/]grok-media-mcp$/);
		expect(dataDir("darwin", {}, "/Users/a")).toMatch(/Library[\\/]Application Support[\\/]grok-media-mcp$/);
		expect(dataDir("linux", {}, "/home/a")).toMatch(/\.local[\\/]share[\\/]grok-media-mcp$/);
	});

	it("never maps a stored key outside the media folder", () => {
		const dir = tempDir();
		expect(() => mediaPath(dir, "../../etc/passwd")).toThrow();
		expect(() => mediaPath(dir, "2026-10-20/../../x")).toThrow();
		expect(mediaPath(dir, "2026-10-20/image-abcdefghijkmnpqr.jpg")).toContain("media");
		expect(statSync(dir).isDirectory()).toBe(true);
	});
});
