import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findKey, removeKey, saveKey, validKey } from "../src/local/key";
import { tempDir } from "./helpers";

const opts = { useStore: false, env: {} };
const KEY = "xai-test-0123456789abcdefghij";

describe("key", () => {
	it("saves to a key file only this user can read when there is no credential store", async () => {
		const dir = tempDir();
		expect(await saveKey(dir, KEY, opts)).toBe("key file");
		if (process.platform !== "win32") expect(statSync(join(dir, "xai-key")).mode & 0o077).toBe(0);
		expect(await findKey(dir, opts)).toEqual({ key: KEY, source: "key file" });
		expect(await removeKey(dir, opts)).toEqual(["key file"]);
		expect((await findKey(dir, opts)).problem).toContain("set-key");
	});

	it("uses the environment variable, but refuses when two keys are set", async () => {
		const dir = tempDir();
		expect(await findKey(dir, { useStore: false, env: { XAI_API_KEY: KEY } })).toEqual({ key: KEY, source: "environment" });
		await saveKey(dir, KEY, opts);
		const both = await findKey(dir, { useStore: false, env: { XAI_API_KEY: KEY } });
		expect(both.key).toBeUndefined();
		expect(both.problem).toContain("more than one");
	});

	it("rejects things that are not keys", () => {
		expect(validKey("")).toBe(false);
		expect(validKey("short")).toBe(false);
		expect(validKey("has spaces in it 0123456789")).toBe(false);
		expect(validKey(KEY)).toBe(true);
	});
});
