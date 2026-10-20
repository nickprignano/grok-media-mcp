// The xAI key, kept in the operating system's credential store (Windows Credential Manager,
// macOS Keychain, Linux Secret Service). Where that store isn't available, a key file in the
// data folder readable only by this user. The XAI_API_KEY environment variable also works, but
// Claude Desktop keeps the env block of its config in plain text, so it is the last resort.
// The key is never printed, logged or sent anywhere but api.x.ai.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = "grok-media-mcp";
const ACCOUNT = "xai-api-key";

export type KeySource = "credential store" | "key file" | "environment";

export interface KeyLookup {
	key?: string;
	source?: KeySource;
	problem?: string;
}

interface Store {
	get(): string | undefined;
	set(value: string): void;
	remove(): boolean;
}

/**
 * The native credential store on Windows and macOS, or undefined where its module is missing.
 * Linux uses the key file: its default store can be the kernel keyring, which forgets the key at
 * logout.
 */
async function credentialStore(useStore: boolean): Promise<Store | undefined> {
	if (!useStore || (process.platform !== "win32" && process.platform !== "darwin")) return undefined;
	try {
		const { Entry } = await import("@napi-rs/keyring");
		const entry = new Entry(SERVICE, ACCOUNT);
		entry.getPassword(); // throws here if the platform store can't be reached
		return {
			get: () => entry.getPassword() ?? undefined,
			set: (value) => entry.setPassword(value),
			remove: () => entry.deleteCredential(),
		};
	} catch {
		return undefined;
	}
}

function keyFile(dir: string): Store {
	const file = join(dir, "xai-key");
	return {
		get: () => (existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined),
		set: (value) => {
			writeFileSync(file, value, { mode: 0o600 });
			chmodSync(file, 0o600);
		},
		remove: () => {
			if (!existsSync(file)) return false;
			rmSync(file);
			return true;
		},
	};
}

export function validKey(value: string): boolean {
	return /^[\x21-\x7e]{20,200}$/.test(value);
}

/** Tests pass useStore false so they never touch the real credential store. */
export interface KeyOptions {
	useStore?: boolean;
	env?: NodeJS.ProcessEnv;
}

export async function findKey(dir: string, options: KeyOptions = {}): Promise<KeyLookup> {
	const env = options.env ?? process.env;
	const store = await credentialStore(options.useStore ?? true);
	const stored = store?.get();
	const filed = keyFile(dir).get();
	const fromEnv = env.XAI_API_KEY?.trim() || undefined;
	const found = [stored, filed, fromEnv].filter(Boolean).length;
	if (found > 1) {
		// Two copies hide which one is live and leave a stale key behind after a rotation.
		return { problem: "more than one xAI key is set (credential store, key file or XAI_API_KEY). Keep one: run grok-media-mcp remove-key, then set-key" };
	}
	if (stored) return { key: stored, source: "credential store" };
	if (filed) return { key: filed, source: "key file" };
	if (fromEnv) return { key: fromEnv, source: "environment" };
	return { problem: "no xAI key is set. The owner runs grok-media-mcp set-key in a terminal" };
}

/** Saves the key, preferring the credential store. Returns where it went. */
export async function saveKey(dir: string, value: string, options: KeyOptions = {}): Promise<KeySource> {
	const store = await credentialStore(options.useStore ?? true);
	if (store) {
		store.set(value);
		keyFile(dir).remove();
		return "credential store";
	}
	keyFile(dir).set(value);
	return "key file";
}

export async function removeKey(dir: string, options: KeyOptions = {}): Promise<KeySource[]> {
	const removed: KeySource[] = [];
	const store = await credentialStore(options.useStore ?? true);
	if (store?.remove()) removed.push("credential store");
	if (keyFile(dir).remove()) removed.push("key file");
	return removed;
}
