import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { localBackend, upkeep } from "../src/local/backend";
import { buildServer } from "../src/tools";
import { json, ledgerAt, mockFetch, tempDir, testJpeg } from "./helpers";

const KEY = "xai-test-0123456789abcdefghij";

/** A JSON-RPC client over in-memory pipes, speaking to the server the way Claude Desktop does. */
function connect(backend: ReturnType<typeof localBackend>) {
	const toServer = new PassThrough();
	const fromServer = new PassThrough();
	serveStdio(() => buildServer(backend), { transport: new StdioServerTransport(toServer, fromServer) });
	let buffer = "";
	const waiting = new Map<number, (message: Record<string, unknown>) => void>();
	fromServer.on("data", (chunk) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const message = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			waiting.get(message.id)?.(message);
		}
	});
	let id = 0;
	const request = (method: string, params: unknown) =>
		new Promise<Record<string, unknown>>((done) => {
			waiting.set(++id, done);
			toServer.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }).then(() =>
		toServer.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`),
	);
	return {
		async call(name: string, args: Record<string, unknown> = {}) {
			await ready;
			const reply = await request("tools/call", { name, arguments: args });
			return reply.result as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
		},
		close: () => toServer.end(),
	};
}

function setup(options: { key?: string; routes?: Parameters<typeof mockFetch> } = {}) {
	const dir = tempDir();
	const ledger = ledgerAt(join(dir, "ledger.db"));
	const mock = mockFetch(...(options.routes ?? []));
	const deps = { dir, ledger, key: "key" in options ? options.key : KEY, familyNames: "Zebulon", fetcher: mock.fetcher, log: () => {} };
	return { dir, ledger, deps, calls: mock.calls, client: connect(localBackend(deps)) };
}

const IMAGE_ROUTE = (url: URL) =>
	url.pathname === "/v1/images/generations"
		? json({ data: [{ b64_json: Buffer.from(testJpeg(1024, 1024)).toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 400_000_000 } })
		: undefined;

describe("local server", () => {
	it("refuses paid tools until armed, without calling xAI", async () => {
		const { client, calls } = setup({ routes: [IMAGE_ROUTE] });
		const result = await client.call("make_image", { prompt: "a fox in snow" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("grok-media-mcp arm");
		expect(calls).toEqual([]);
		client.close();
	});

	it("makes an image, saves it on disk and returns its path and a preview", async () => {
		const { client, ledger, calls } = setup({ routes: [IMAGE_ROUTE] });
		ledger.arm("testing");
		const result = await client.call("make_image", { prompt: "a fox in snow" });
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(result.content[0].text!);
		expect(body.cost).toBe("$0.04");
		const path = body.files[0].path as string;
		expect(existsSync(path)).toBe(true);
		expect(existsSync(body.files[0].preview_path)).toBe(true);
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(calls[0].init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
		const status = JSON.parse((await client.call("media_budget")).content[0].text!);
		expect(status.spent_today).toBe("$0.04");
		client.close();
	});

	it("applies the content rules and the private family list before anything is spent", async () => {
		const { client, ledger, calls } = setup({ routes: [IMAGE_ROUTE] });
		ledger.arm("testing");
		const kid = await client.call("make_image", { prompt: "a 12 year old at the beach" });
		expect(kid.isError).toBe(true);
		const family = await client.call("make_image", { prompt: "portrait of Zebulon" });
		expect(family.isError).toBe(true);
		expect(family.content[0].text).not.toContain("Zebulon");
		expect(calls).toEqual([]);
		client.close();
	});

	it("says how to set the key when none is set", async () => {
		const { client, ledger } = setup({ key: undefined });
		ledger.arm("testing");
		const result = await client.call("make_image", { prompt: "a fox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("set-key");
		client.close();
	});

	it("finishes a video when video_status is asked, and stores it locally", async () => {
		const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2")]);
		const { client, ledger, deps } = setup({
			routes: [
				(url) => (url.pathname === "/v1/videos/generations" ? json({ request_id: "req-1" }) : undefined),
				(url) => (url.pathname === "/v1/videos/req-1" ? json({ status: "done", video: { url: "https://vidgen.x.ai/v/1.mp4", respect_moderation: true }, usage: { cost_in_usd_ticks: 1_000_000_000 } }) : undefined),
				(url) => (url.hostname === "vidgen.x.ai" ? new Response(MP4) : undefined),
			],
		});
		ledger.arm("testing");
		const started = JSON.parse((await client.call("make_video", { prompt: "waves on a beach", seconds: 2, tier: "lite" })).content[0].text!);
		expect(started.status).toBe("pending");
		const early = JSON.parse((await client.call("video_status", { job_id: started.job_id })).content[0].text!);
		expect(early.status).toBe("pending"); // not due yet
		await upkeep({ ...deps, now: () => Date.now() + 20_000 });
		const done = JSON.parse((await client.call("video_status", { job_id: started.job_id })).content[0].text!);
		expect(done.status).toBe("done");
		expect(readFileSync(done.files[0].path).subarray(4, 8).toString()).toBe("ftyp");
		client.close();
	});
});

describe("the built command", () => {
	const bundle = resolve("dist/grok-media-mcp.mjs");

	it.skipIf(!existsSync(bundle))("answers over stdio with nothing but protocol on stdout", async () => {
		const home = tempDir();
		const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), XDG_DATA_HOME: "", XAI_API_KEY: "" };
		const child = spawn(process.execPath, [bundle], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		const lines = [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		];
		for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
		await new Promise((done) => setTimeout(done, 1500));
		child.stdin.end();
		await new Promise((done) => child.on("close", done));
		const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
		expect(messages.map((m) => m.id)).toEqual([1, 2]);
		expect(messages[1].result.tools.map((t: { name: string }) => t.name)).toContain("make_image");
	});
});
