import { env, exports } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { vi } from "vitest";
import { budgetStub } from "../src/budget";
import { buildServer, toolDeps } from "../src/tools";

export const HOST = "media.example.com";
export const BASE = `https://${HOST}`;

/** The Worker's default export, called the way Cloudflare calls it. */
export const self = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default;

// A 1x1 PNG.
export const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
	(c) => c.charCodeAt(0),
);
export const PNG_B64 = btoa(String.fromCharCode(...PNG));
// The start of an MP4 file: enough for the type check.
export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]);

export function budget() {
	return budgetStub(env);
}

export interface ToolCall {
	text: string;
	isError: boolean;
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
	const handler = createMcpHandler(() => buildServer(toolDeps(env)), {
		route: "/mcp",
		allowedHostnames: [HOST],
		corsOptions: false,
	});
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	const response = await handler(
		new Request(`${BASE}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
				host: HOST,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		}),
		env,
		ctx,
	);
	const body = await response.text();
	const line = body.split("\n").find((l) => l.startsWith("data: "));
	const message = JSON.parse(line ? line.slice(6) : body);
	if (message.error) throw new Error(`MCP error: ${JSON.stringify(message.error)}`);
	const content = message.result.content as ToolCall["content"];
	return { content, isError: Boolean(message.result.isError), text: content.find((c) => c.type === "text")?.text ?? "" };
}

type Route = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

/** Replaces global fetch. Unmatched requests fail the test instead of reaching the network. */
export function mockFetch(...routes: Route[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push({ url: url.toString(), init });
		for (const route of routes) {
			const response = await route(url, init);
			if (response) return response;
		}
		throw new Error(`unexpected fetch to ${url}`);
	});
	return { calls, spy };
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Empties the shared Budget object between tests. */
export async function resetBudget(): Promise<void> {
	const { runInDurableObject } = await import("cloudflare:test");
	await runInDurableObject(budget(), (_instance, state: DurableObjectState) => {
		for (const table of ["ledger", "files", "jobs", "arm", "monthly", "meta"]) state.storage.sql.exec(`DELETE FROM ${table}`);
	});
}
