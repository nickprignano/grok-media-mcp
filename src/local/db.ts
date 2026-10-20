// The ledger in a local SQLite file. Every write transaction is BEGIN IMMEDIATE, which takes
// the file's write lock up front: a Claude Desktop and a Claude Code server running at once
// still see each other's reservations, so the caps hold across both.

import type { Caps } from "../config";
import { Ledger, type SqlDb, type SqlValue } from "../ledger";

export const LOCAL_ARM_HINT = "The owner arms it in a terminal with: grok-media-mcp arm";

export function openSql(file: string, busyMs = 10_000): { sql: SqlDb; close(): void } {
	// Loaded here, not imported at the top, so the entry point can quiet Node 22's warning first.
	const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(file);
	db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
	let depth = 0;
	const sql: SqlDb = {
		exec: (query) => db.exec(query),
		all: <T>(query: string, ...args: SqlValue[]) => db.prepare(query).all(...args) as T[],
		run: (query, ...args) => Number(db.prepare(query).run(...args).changes),
		transaction: <T>(fn: () => T): T => {
			if (depth > 0) return fn();
			db.exec("BEGIN IMMEDIATE");
			depth++;
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// no transaction left to roll back; keep the original error
				}
				throw error;
			} finally {
				depth--;
			}
		},
	};
	return { sql, close: () => db.close() };
}

export function openLedger(file: string, caps: () => Caps, busyMs?: number): { ledger: Ledger; close(): void } {
	const { sql, close } = openSql(file, busyMs);
	return { ledger: new Ledger(sql, { caps, armHint: LOCAL_ARM_HINT, guardClock: true }), close };
}
