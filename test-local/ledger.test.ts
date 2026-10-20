import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { USD, readCaps } from "../src/config";
import type { ReserveInput } from "../src/ledger";
import { openLedger } from "../src/local/db";
import { CEILINGS, loadSettings } from "../src/local/settings";
import { ledgerAt, tempDir } from "./helpers";

const NOW = Date.parse("2026-10-20T12:00:00Z");
let n = 0;
const input = (quoted: number): ReserveInput => ({ tool: "make_image", model: "m", params: {}, prompt: "a fox", quoted, dedupe: `d${n++}` });

describe("local ledger", () => {
	it("keeps the caps across two connections to one file", () => {
		const file = join(tempDir(), "ledger.db");
		const a = ledgerAt(file);
		const b = ledgerAt(file);
		a.arm("blog", NOW);
		expect(b.reserve(input(1.4 * USD), NOW).ok).toBe(true);
		expect(a.reserve(input(1.4 * USD), NOW + 61_000).ok).toBe(true);
		expect(b.reserve(input(0.3 * USD), NOW + 122_000)).toEqual({ ok: false, reason: expect.stringContaining("arming session") });
	});

	it("blocks a second writer while a reservation is being checked", () => {
		const file = join(tempDir(), "ledger.db");
		const a = openLedger(file, () => readCaps({}), 100);
		const b = openLedger(file, () => readCaps({}), 100);
		try {
			a.ledger.arm("blog", NOW);
			// Hold a's write lock as reserve does, and try b's reserve inside it.
			const sqlA = (a.ledger as unknown as { sql: { transaction<T>(fn: () => T): T } }).sql;
			sqlA.transaction(() => {
				expect(() => b.ledger.reserve(input(1000), NOW)).toThrow(/locked|busy/i);
			});
			expect(b.ledger.reserve(input(1000), NOW).ok).toBe(true);
		} finally {
			a.close();
			b.close();
		}
	});

	it("never lets racing processes pass the session cap", async () => {
		const dir = tempDir();
		const file = join(dir, "ledger.db");
		const caps = readCaps({ CALLS_PER_MINUTE: "1000" });
		const setup = ledgerAt(file, caps);
		setup.arm("testing", NOW);
		const script = join(dir, "race.mjs");
		await build({
			stdin: {
				contents: `
					import { openLedger } from ${JSON.stringify(resolve("src/local/db.ts"))};
					import { readCaps } from ${JSON.stringify(resolve("src/config.ts"))};
					const { ledger, close } = openLedger(process.argv[2], () => readCaps({ CALLS_PER_MINUTE: "1000" }));
					let ok = 0;
					for (let i = 0; i < 10; i++) {
						const r = ledger.reserve({ tool: "t", model: "m", params: {}, prompt: "", quoted: 300000, dedupe: process.pid + "-" + i }, ${NOW + 1000});
						if (r.ok) ok++;
					}
					close();
					console.log(ok);
				`,
				resolveDir: process.cwd(),
				loader: "ts",
			},
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: script,
			logLevel: "silent",
		});
		const runs = await Promise.all(
			Array.from({ length: 4 }, () =>
				new Promise<number>((done, fail) => {
					const child = spawn(process.execPath, ["--no-warnings", script, file], { stdio: ["ignore", "pipe", "inherit"] });
					let out = "";
					child.stdout.on("data", (chunk) => (out += chunk));
					child.on("error", fail);
					child.on("close", () => done(Number(out.trim())));
				}),
			),
		);
		expect(runs.reduce((a, b) => a + b, 0)).toBe(10); // $3 session cap / $0.30
		expect(setup.status(NOW + 2000).spentThisSession).toBe(3 * USD);
	});

	it("refuses paid calls when the clock is set back", () => {
		const ledger = ledgerAt(join(tempDir(), "ledger.db"));
		ledger.arm("blog", NOW);
		expect(ledger.reserve(input(1000), NOW).ok).toBe(true);
		ledger.arm("blog", NOW - 86_400_000);
		expect(ledger.reserve(input(1000), NOW - 86_400_000 + 1)).toEqual({ ok: false, reason: expect.stringContaining("clock") });
	});
});

describe("settings", () => {
	it("lets config.json lower the caps but never raise them", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), JSON.stringify({ caps: { per_day_usd: 2, per_month_usd: 500, arm_hours: 1 }, family_names: "Zebulon" }));
		const settings = loadSettings(dir);
		expect(settings.caps.perDay).toBe(2 * USD);
		expect(settings.caps.perMonth).toBe(CEILINGS.perMonth);
		expect(settings.caps.armHours).toBe(1);
		expect(settings.familyNames).toBe("Zebulon");
		expect(settings.warnings.join()).toContain("perMonth");
	});

	it("falls back to the defaults when config.json is broken", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), "{ not json");
		const settings = loadSettings(dir);
		expect(settings.caps).toEqual(CEILINGS);
		expect(settings.warnings.length).toBe(1);
	});
});
