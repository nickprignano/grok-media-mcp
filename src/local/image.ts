// Image decode and re-encode in plain JavaScript (no native image library), for two jobs:
// re-encoding images the owner adds, which drops every byte that isn't pixels (location and
// camera data, comments, colour profiles, anything appended to the file); and small previews.

import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { stripJpegMetadata } from "../media";

const MAX_PIXELS = 50_000_000;

export class ImageError extends Error {}

interface Pixels {
	width: number;
	height: number;
	/** RGBA, 4 bytes a pixel. */
	data: Uint8Array;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function decode(bytes: Uint8Array, mime: string): Pixels {
	try {
		if (mime === "image/jpeg") {
			const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 1024 });
			return orient({ width: image.width, height: image.height, data: image.data }, jpegOrientation(bytes));
		}
		if (mime === "image/png") {
			const { width, height } = pngSize(bytes);
			if (!width || !height || width * height > MAX_PIXELS) throw new ImageError("the image is too large");
			const image = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
			return { width: image.width, height: image.height, data: image.data };
		}
	} catch (error) {
		if (error instanceof ImageError) throw error;
		throw new ImageError("the image could not be decoded");
	}
	throw new ImageError("only JPEG and PNG images can be added. Export a WebP or other image as JPEG first");
}

/** Flattens any transparency onto white and encodes as a baseline JPEG with no metadata. */
export function encodeJpeg(pixels: Pixels, quality: number): Uint8Array {
	const data = new Uint8Array(pixels.data);
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3] / 255;
		if (alpha < 1) {
			for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * alpha + 255 * (1 - alpha));
			data[i + 3] = 255;
		}
	}
	const encoded = jpeg.encode({ width: pixels.width, height: pixels.height, data }, quality);
	return stripJpegMetadata(new Uint8Array(encoded.data));
}

/** Area-averages down so the longer side is at most `max`. Never scales up. */
export function scaleDown(pixels: Pixels, max: number): Pixels {
	const scale = Math.min(1, max / Math.max(pixels.width, pixels.height));
	if (scale === 1) return pixels;
	const width = Math.max(1, Math.round(pixels.width * scale));
	const height = Math.max(1, Math.round(pixels.height * scale));
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor((y * pixels.height) / height);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * pixels.height) / height));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor((x * pixels.width) / width);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * pixels.width) / width));
			const sum = [0, 0, 0, 0];
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * pixels.width + sx) * 4;
					for (let c = 0; c < 4; c++) sum[c] += pixels.data[i + c];
				}
			}
			const n = (y1 - y0) * (x1 - x0);
			const o = (y * width + x) * 4;
			for (let c = 0; c < 4; c++) out[o + c] = Math.round(sum[c] / n);
		}
	}
	return { width, height, data: out };
}

/** Decodes and re-encodes an image the owner adds. The result is always a plain JPEG. */
export function reencode(bytes: Uint8Array, mime: string): Uint8Array {
	return encodeJpeg(decode(bytes, mime), 92);
}

/** A JPEG preview, longer side 512 px, or undefined for types this can't decode. */
export function makePreview(bytes: Uint8Array, mime: string): Uint8Array | undefined {
	try {
		return encodeJpeg(scaleDown(decode(bytes, mime), 512), 75);
	} catch {
		return undefined;
	}
}

/** The EXIF orientation (1-8) of a JPEG, or 1. */
export function jpegOrientation(bytes: Uint8Array): number {
	let offset = 2;
	while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
		const marker = bytes[offset + 1];
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		if (marker === 0xda || length < 2) break;
		const start = offset + 4;
		if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(start, start + 4)) === "Exif") {
			return tiffOrientation(bytes.subarray(start + 6, offset + 2 + length));
		}
		offset += 2 + length;
	}
	return 1;
}

function tiffOrientation(tiff: Uint8Array): number {
	if (tiff.length < 8) return 1;
	const little = tiff[0] === 0x49;
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	const u16 = (at: number) => view.getUint16(at, little);
	const ifd = view.getUint32(4, little);
	if (ifd + 2 > tiff.length) return 1;
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > tiff.length) break;
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

/** Applies an EXIF orientation so the re-encoded image (which has no EXIF) still looks upright. */
export function orient(pixels: Pixels, orientation: number): Pixels {
	if (orientation <= 1 || orientation > 8) return pixels;
	const { width: w, height: h, data } = pixels;
	const swap = orientation >= 5;
	const width = swap ? h : w;
	const height = swap ? w : h;
	const out = new Uint8Array(data.length);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let nx: number;
			let ny: number;
			switch (orientation) {
				case 2: nx = w - 1 - x; ny = y; break;
				case 3: nx = w - 1 - x; ny = h - 1 - y; break;
				case 4: nx = x; ny = h - 1 - y; break;
				case 5: nx = y; ny = x; break;
				case 6: nx = h - 1 - y; ny = x; break;
				case 7: nx = h - 1 - y; ny = w - 1 - x; break;
				default: nx = y; ny = w - 1 - x; break; // 8
			}
			const from = (y * w + x) * 4;
			const to = (ny * width + nx) * 4;
			out[to] = data[from];
			out[to + 1] = data[from + 1];
			out[to + 2] = data[from + 2];
			out[to + 3] = data[from + 3];
		}
	}
	return { width, height, data: out };
}
