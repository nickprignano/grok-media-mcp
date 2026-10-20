import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearJwksCache } from "../src/jwt";
import { base64url } from "../src/util";
import { BASE, PNG, budget, json, mockFetch, resetBudget, self } from "./helpers";

const ISSUER = env.ACCESS_ISSUER;
const TEAM = "https://team.example.com";
const CLAUDE_CLIENT = "https://claude.ai/oauth/mcp-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let keys: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };

beforeAll(async () => {
	keys = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	publicJwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});
beforeEach(async () => {
	clearJwksCache();
	await resetBudget();
});
afterEach(() => vi.restoreAllMocks());

async function signJwt(claims: Record<string, unknown>): Promise<string> {
	const enc = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	const body = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body));
	return `${body}.${base64url(new Uint8Array(signature))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const fetchWorker = (path: string, init?: RequestInit) => self.fetch(new Request(`${BASE}${path}`, init));

function accessRoutes(idClaims?: Record<string, unknown>) {
	return [
		(url: URL) => (url.toString() === `${ISSUER}/.well-known/openid-configuration` ? json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorization`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }) : undefined),
		(url: URL) => (url.toString() === `${ISSUER}/jwks` || url.toString() === `${TEAM}/cdn-cgi/access/certs` ? json({ keys: [publicJwk] }) : undefined),
		async (url: URL) => (url.toString() === `${ISSUER}/token` && idClaims ? json({ access_token: "upstream", id_token: await signJwt(idClaims) }) : undefined),
		(url: URL) =>
			url.toString() === CLAUDE_CLIENT
				? json({ client_id: CLAUDE_CLIENT, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })
				: undefined,
		(url: URL) =>
			url.hostname === "evil.example.org"
				? json({ client_id: url.toString(), client_name: "Claude", redirect_uris: ["https://evil.example.org/cb"], token_endpoint_auth_method: "none" })
				: undefined,
	];
}

describe("exposure", () => {
	it("refuses any host but the configured one", async () => {
		const response = await self.fetch(new Request("https://grok-media-mcp.someone.workers.dev/mcp"));
		expect(response.status).toBe(404);
	});

	it("fails closed when settings are missing, naming no values", async () => {
		const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
		const response = await worker.fetch(new Request(`${BASE}/mcp`), { ...env, ALLOWED_EMAIL: "" }, ctx);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("example");
	});

	it("asks for a token on /mcp, pointing at the resource metadata", async () => {
		const response = await fetchWorker("/mcp", { method: "POST" });
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
	});

	it("advertises CIMD and no dynamic registration", async () => {
		const metadata = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
		expect(metadata.client_id_metadata_document_supported).toBe(true);
		expect(metadata.registration_endpoint).toBeUndefined();
		expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
		expect((await fetchWorker("/register", { method: "POST" })).status).toBe(404);
		const resource = (await (await fetchWorker("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
		expect(resource.resource).toBe(`${BASE}/mcp`);
	});
});

describe("login", () => {
	const authorizeUrl = (clientId: string, redirect: string) =>
		`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state: "s1", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${BASE}/mcp` })}`;

	it("refuses any client that is not Claude", async () => {
		mockFetch(...accessRoutes());
		const response = await fetchWorker(authorizeUrl("https://evil.example.org/client.json", "https://evil.example.org/cb"));
		expect(response.status).toBe(403);
	});

	async function consentThenAccess(idClaims: Record<string, unknown>) {
		mockFetch(...accessRoutes(idClaims));
		const page = await fetchWorker(authorizeUrl(CLAUDE_CLIENT, CLAUDE_REDIRECT));
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Only allow this if you just clicked Connect in claude.ai yourself");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		const handle = html.match(/name="handle" value="([^"]+)"/)![1];
		const consentCookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

		const approve = await fetchWorker("/authorize", {
			method: "POST",
			headers: { cookie: consentCookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
			body: new URLSearchParams({ handle, decision: "approve" }),
			redirect: "manual",
		});
		expect(approve.status).toBe(302);
		const toAccess = new URL(approve.headers.get("location")!);
		expect(toAccess.toString().startsWith(`${ISSUER}/authorization`)).toBe(true);
		expect(toAccess.searchParams.get("code_challenge_method")).toBe("S256");
		const upstreamCookie = approve.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		return fetchWorker(`/callback?${new URLSearchParams({ code: "abc", state: toAccess.searchParams.get("state")! })}`, {
			headers: { cookie: upstreamCookie },
			redirect: "manual",
		});
	}

	it("completes for the allowed email and sends Claude a code", async () => {
		const response = await consentThenAccess({ iss: ISSUER, aud: env.ACCESS_CLIENT_ID, exp: now() + 300, iat: now(), sub: "u1", email: "Owner@Example.com" });
		expect(response.status).toBe(302);
		const back = new URL(response.headers.get("location")!);
		expect(back.origin + back.pathname).toBe(CLAUDE_REDIRECT);
		expect(back.searchParams.get("code")).toBeTruthy();
		expect(back.searchParams.get("state")).toBe("s1");
	});

	it.each([
		["another email", { email: "someone@example.com" }],
		["a wrong audience", { aud: "other-app" }],
		["a wrong issuer", { iss: "https://other.example.com" }],
		["an expired token", { exp: now() - 600 }],
		["a token not valid yet", { nbf: now() + 600 }],
	])("denies %s", async (_label, change) => {
		const response = await consentThenAccess({ iss: ISSUER, aud: env.ACCESS_CLIENT_ID, exp: now() + 300, iat: now(), sub: "u1", email: "owner@example.com", ...change });
		expect(response.status).toBe(302);
		const back = new URL(response.headers.get("location")!);
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.get("code")).toBeNull();
	});
});

describe("inbox", () => {
	const inboxJwt = (email = "owner@example.com") => signJwt({ iss: TEAM, aud: [env.INBOX_ACCESS_AUD], exp: now() + 300, iat: now(), sub: "u1", email });

	it("is forbidden without a valid Access JWT for the allowed email", async () => {
		mockFetch(...accessRoutes());
		expect((await fetchWorker("/inbox")).status).toBe(403);
		expect((await fetchWorker("/inbox", { headers: { "Cf-Access-Jwt-Assertion": await inboxJwt("someone@example.com") } })).status).toBe(403);
	});

	async function openInbox() {
		mockFetch(...accessRoutes());
		const jwt = await inboxJwt();
		const page = await fetchWorker("/inbox", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
		expect(page.status).toBe(200);
		const html = await page.text();
		const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
		const cookie = page.headers.getSetCookie()[0].split(";")[0];
		const post = (path: string, body: FormData, origin = BASE) =>
			fetchWorker(path, { method: "POST", body, headers: { "Cf-Access-Jwt-Assertion": jwt, cookie, origin, "sec-fetch-site": "same-origin" }, redirect: "manual" });
		return { html, csrf, post };
	}

	it("arms only with the kids box ticked and a valid CSRF token from the same origin", async () => {
		const { html, csrf, post } = await openInbox();
		expect(html).toContain("Disarmed");
		const form = (fields: Record<string, string>) => {
			const f = new FormData();
			for (const [k, v] of Object.entries(fields)) f.set(k, v);
			return f;
		};
		expect((await post("/inbox/arm", form({ csrf, purpose: "blog" }))).status).toBe(400);
		expect((await post("/inbox/arm", form({ csrf: "forged.token", purpose: "blog", not_for_kids: "yes" }))).status).toBe(403);
		expect((await post("/inbox/arm", form({ csrf, purpose: "blog", not_for_kids: "yes" }), "https://evil.example.org")).status).toBe(403);
		expect((await budget().armState()).armed).toBe(false);
		expect((await post("/inbox/arm", form({ csrf, purpose: "blog", not_for_kids: "yes" }))).status).toBe(303);
		expect(await budget().armState()).toMatchObject({ armed: true, purpose: "blog" });
		expect((await post("/inbox/disarm", form({ csrf }))).status).toBe(303);
		expect((await budget().armState()).armed).toBe(false);
	});

	it("re-encodes uploaded images and refuses other file types", async () => {
		const { csrf, post } = await openInbox();
		const upload = (bytes: Uint8Array, name: string) => {
			const f = new FormData();
			f.set("csrf", csrf);
			f.set("file", new File([bytes], name));
			return post("/inbox/upload", f);
		};
		const svg = await upload(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.png");
		expect(decodeURIComponent(svg.headers.get("location")!)).toContain("Only PNG");
		const ok = await upload(PNG, "me.png");
		const message = decodeURIComponent(ok.headers.get("location")!);
		expect(message).toContain("Uploaded");
		const id = message.match(/File id: ([a-z0-9]{16})/)![1];
		const file = await budget().getFile(id);
		expect(file).toMatchObject({ source: "inbox", kind: "image", mime: "image/jpeg" });
	});
});
