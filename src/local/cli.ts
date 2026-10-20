// The command line. With no command it runs the MCP server over stdio, which is what Claude
// Desktop and Claude Code start. The other commands are for the owner in a terminal; the ones
// that open spending (arm) or send a file toward xAI (add) refuse to run without a terminal,
// so a model with shell access can't run them for the owner.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { formatUsd } from "../config";
import { buildServer, VERSION } from "../tools";
import { AddError, addFile } from "./add";
import { type LocalDeps, localBackend, mediaPath, upkeep } from "./backend";
import { openLedger } from "./db";
import { findKey, removeKey, saveKey, validKey } from "./key";
import { dataDir } from "./paths";
import { configPath, loadSettings, writeDefaultConfig } from "./settings";

const PURPOSES = ["blog", "personal", "testing"];

const HELP = `grok-media-mcp ${VERSION}: Grok images, video and speech for Claude, with spend caps.

  grok-media-mcp                 run the MCP server (Claude Desktop and Claude Code start this)
  grok-media-mcp set-key         save your xAI key in the system credential store (typed hidden, or piped in)
  grok-media-mcp remove-key      delete the saved key
  grok-media-mcp arm [purpose]   allow paid calls for a few hours (purpose: blog, personal or testing)
  grok-media-mcp disarm          stop paid calls now
  grok-media-mcp status          armed or not, spend, caps, where things are
  grok-media-mcp add <file>      add your own JPEG/PNG image or audio file as a tool input
  grok-media-mcp where           print the data folder

Settings (caps can only go down, family names to refuse): config.json in the data folder.`;

function out(line: string): void {
	process.stderr.write(`${line}\n`);
}

function setup(dir: string) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeDefaultConfig(dir);
	const settings = loadSettings(dir);
	const { ledger, close } = openLedger(join(dir, "ledger.db"), () => settings.caps);
	return { settings, ledger, close };
}

function needTerminal(what: string): boolean {
	if (process.stdin.isTTY) return true;
	out(`${what} only runs in a terminal you type into (PowerShell, Windows Terminal, or Terminal on a Mac), not from a script or another program.`);
	return false;
}

async function ask(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

/** Reads a line without echoing it. From a pipe it reads the first line. */
async function readSecret(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		let text = "";
		for await (const chunk of stdin) text += chunk;
		return text.split(/\r?\n/)[0].trim();
	}
	process.stderr.write(prompt);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	return new Promise((resolve, reject) => {
		let value = "";
		const done = (error?: Error) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
			process.stderr.write("\n");
			if (error) reject(error);
			else resolve(value.trim());
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") return done();
				if (ch === "\u0003") return done(new Error("cancelled"));
				if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
				else if (ch >= " ") value += ch;
			}
		};
		stdin.on("data", onData);
	});
}

async function serve(dir: string): Promise<number> {
	const { settings, ledger } = setup(dir);
	for (const warning of settings.warnings) out(`grok-media-mcp: ${warning}`);
	const key = await findKey(dir);
	if (key.problem) out(`grok-media-mcp: ${key.problem}. Free tools still work.`);
	const deps: LocalDeps = { dir, ledger, key: key.key, familyNames: settings.familyNames };
	const backend = localBackend(deps);
	const tick = async () => {
		try {
			await upkeep(deps);
		} catch (error) {
			out(`grok-media-mcp: upkeep failed: ${error instanceof Error ? error.message : "error"}`);
		}
	};
	await tick();
	setInterval(tick, 30_000).unref();
	serveStdio(() => buildServer(backend), { onerror: (error) => out(`grok-media-mcp: ${error.message}`) });
	return 0;
}

async function status(dir: string): Promise<number> {
	const { settings, ledger, close } = setup(dir);
	const key = await findKey(dir);
	const s = ledger.status();
	out(`Data folder:  ${dir}`);
	out(`Settings:     ${configPath(dir)}`);
	out(`xAI key:      ${key.source ? `set (${key.source})` : key.problem}`);
	out(`Armed:        ${s.armed ? `yes, until ${new Date(s.until!).toLocaleString()} (${s.purpose})` : "no"}`);
	out(`Spent:        today ${formatUsd(s.spentToday)} of ${formatUsd(s.caps.perDay)}, this month ${formatUsd(s.spentThisMonth)} of ${formatUsd(s.caps.perMonth)}, this arming ${formatUsd(s.spentThisSession)} of ${formatUsd(s.caps.perSession)}`);
	out(`Per call:     up to ${formatUsd(s.caps.perCall)}, ${s.caps.callsPerMinute} calls a minute`);
	if (s.pendingVideos) out(`Videos:       ${s.pendingVideos} still rendering`);
	for (const warning of settings.warnings) out(`Warning:      ${warning}`);
	close();
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const dir = dataDir();
	const [command, ...rest] = argv;
	switch (command) {
		case undefined:
		case "serve":
			return serve(dir);
		case "help":
		case "--help":
		case "-h":
			out(HELP);
			return 0;
		case "--version":
			out(VERSION);
			return 0;
		case "where":
			out(dir);
			return 0;
		case "status":
			return status(dir);
		case "set-key": {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const value = await readSecret("Paste your xAI key (it won't show), then press Enter: ");
			if (!validKey(value)) {
				out("That doesn't look like a key. Nothing was saved.");
				return 1;
			}
			await removeKey(dir);
			const where = await saveKey(dir, value);
			out(`Saved in the ${where}.${where === "key file" ? " Only your user account can read it." : ""}`);
			if (process.env.XAI_API_KEY) out("XAI_API_KEY is also set in this environment: remove it, or the server will refuse to pick one.");
			return 0;
		}
		case "remove-key": {
			const removed = await removeKey(dir);
			out(removed.length ? `Removed from the ${removed.join(" and the ")}.` : "No saved key was found.");
			return 0;
		}
		case "arm": {
			if (!needTerminal("arm")) return 1;
			const purpose = rest[0] ?? "personal";
			if (!PURPOSES.includes(purpose)) {
				out(`Purpose must be one of: ${PURPOSES.join(", ")}.`);
				return 1;
			}
			const { ledger, settings, close } = setup(dir);
			const answer = await ask(
				`Arm for ${settings.caps.armHours} hours (${purpose})? Confirm this is not for anything children or teens use, and shows no children or family. [y/N] `,
			);
			if (answer.toLowerCase() !== "y") {
				out("Not armed.");
				close();
				return 1;
			}
			const state = ledger.arm(purpose);
			out(`Armed until ${new Date(state.until!).toLocaleString()}. Run grok-media-mcp disarm to stop sooner.`);
			close();
			return 0;
		}
		case "disarm": {
			const { ledger, close } = setup(dir);
			ledger.disarm();
			out("Disarmed.");
			close();
			return 0;
		}
		case "add": {
			if (!rest[0]) {
				out("Usage: grok-media-mcp add <file>");
				return 1;
			}
			if (!needTerminal("add")) return 1;
			const answer = await ask("Only your own photos and recordings: no other people, and no kids. Add it? [y/N] ");
			if (answer.toLowerCase() !== "y") {
				out("Not added.");
				return 1;
			}
			const { ledger, close } = setup(dir);
			try {
				const record = addFile(dir, ledger, rest[0]);
				out(`Added. File id: ${record.id}`);
				out(`Stored at ${mediaPath(dir, record.key)}${record.kind === "image" ? " (re-encoded: location and camera data removed)" : ""}.`);
				return 0;
			} catch (error) {
				out(`Not added: ${error instanceof AddError ? error.message : "the file could not be read"}.`);
				return 1;
			} finally {
				close();
			}
		}
		default:
			out(`Unknown command: ${command}\n\n${HELP}`);
			return 1;
	}
}
