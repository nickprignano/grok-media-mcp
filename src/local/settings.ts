// config.json in the data folder: the caps and the private family-name list. The caps here can
// only lower the built-in defaults; raising them means changing src/config.ts and rebuilding,
// so a script that edits this file can't lift the spend limits.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Caps, USD, readCaps } from "../config";

export interface LocalSettings {
	caps: Caps;
	familyNames: string;
	/** Problems reading config.json. The defaults are used meanwhile. */
	warnings: string[];
}

export const CEILINGS: Caps = readCaps({});

const TEMPLATE = {
	caps: {
		per_call_usd: CEILINGS.perCall / USD,
		per_session_usd: CEILINGS.perSession / USD,
		per_day_usd: CEILINGS.perDay / USD,
		per_month_usd: CEILINGS.perMonth / USD,
		calls_per_minute: CEILINGS.callsPerMinute,
		arm_hours: CEILINGS.armHours,
	},
	family_names: "",
	_note: "Caps can only be lowered here. family_names: comma-separated names the server must refuse.",
};

export function configPath(dir: string): string {
	return join(dir, "config.json");
}

export function writeDefaultConfig(dir: string): boolean {
	const file = configPath(dir);
	if (existsSync(file)) return false;
	writeFileSync(file, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { mode: 0o600 });
	return true;
}

export function loadSettings(dir: string): LocalSettings {
	const file = configPath(dir);
	const warnings: string[] = [];
	let raw: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			warnings.push("config.json could not be read; using the default caps and no family names");
		}
	}
	const c = (raw.caps ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : undefined);
	const wanted = readCaps({
		CAP_PER_CALL_USD: str(c.per_call_usd),
		CAP_PER_SESSION_USD: str(c.per_session_usd),
		CAP_PER_DAY_USD: str(c.per_day_usd),
		CAP_PER_MONTH_USD: str(c.per_month_usd),
		CALLS_PER_MINUTE: str(c.calls_per_minute),
		ARM_HOURS: str(c.arm_hours),
	});
	const caps = {} as Caps;
	for (const name of Object.keys(CEILINGS) as (keyof Caps)[]) {
		if (wanted[name] > CEILINGS[name]) warnings.push(`config.json asks for a higher ${name} than the built-in cap; the built-in cap applies`);
		caps[name] = Math.min(wanted[name], CEILINGS[name]);
	}
	return { caps, familyNames: typeof raw.family_names === "string" ? raw.family_names : "", warnings };
}
