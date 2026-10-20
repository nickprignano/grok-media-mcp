#!/usr/bin/env node
// Entry point. stdout carries the MCP protocol, so before anything else loads, every console
// method is sent to stderr: one stray console.log would corrupt the connection.

import { Console } from "node:console";

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

// node:sqlite is stable in Node 24 but prints an "experimental" warning on 22; it's expected.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
	if (String(typeof warning === "string" ? warning : warning.message).includes("SQLite")) return;
	emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

// Everything this creates (ledger, files, key file) is readable by this user only.
if (process.platform !== "win32") process.umask(0o077);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
	console.error(`grok-media-mcp needs Node.js 22.13 or newer (24 LTS recommended); this is ${process.versions.node}.`);
	process.exit(1);
}

const { main } = await import("./cli");
process.exitCode = await main(process.argv.slice(2));
export {};
