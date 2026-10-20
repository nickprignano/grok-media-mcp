// Login. claude.ai is the OAuth client; this Worker is the authorization server; Cloudflare
// Access (an OIDC "SaaS" app with a one-email policy) is the identity step.
//
// GET  /authorize  only Claude's own client ids and redirect URI; always shows the consent page
// POST /authorize  approve or deny; on approve, send the browser to Access
// GET  /callback   back from Access: verify the ID token fully, then finish the OAuth grant

import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { verifyAccessJwt } from "./jwt";
import { base64url, escapeHtml } from "./util";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export interface Props extends Record<string, unknown> {
	email: string;
	sub: string;
}

interface OidcConfig {
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	issuer: string;
}

let oidcCache: { issuer: string; config: OidcConfig; at: number } | undefined;

/** Access publishes the endpoints; only the issuer is configured, and it must match. */
export async function oidcConfig(env: Env): Promise<OidcConfig> {
	if (oidcCache && oidcCache.issuer === env.ACCESS_ISSUER && Date.now() - oidcCache.at < 3_600_000) return oidcCache.config;
	const response = await fetch(`${env.ACCESS_ISSUER}/.well-known/openid-configuration`);
	if (!response.ok) throw new Error(`Access discovery failed (${response.status})`);
	const config = (await response.json()) as OidcConfig;
	if (config.issuer !== env.ACCESS_ISSUER) throw new Error("Access discovery names a different issuer");
	const origin = new URL(env.ACCESS_ISSUER).origin;
	for (const url of [config.authorization_endpoint, config.token_endpoint, config.jwks_uri]) {
		if (typeof url !== "string" || new URL(url).origin !== origin) throw new Error("Access discovery points off its own host");
	}
	oidcCache = { issuer: env.ACCESS_ISSUER, config, at: Date.now() };
	return config;
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Only Claude may connect: its CIMD client id and its exact redirect URI. */
export function clientAllowed(env: Env, clientId: string, redirectUri: string): boolean {
	const prefixes = list(env.ALLOWED_CLIENT_ID_PREFIXES);
	const redirects = list(env.ALLOWED_REDIRECT_URIS);
	return prefixes.some((prefix) => prefix.startsWith("https://") && clientId.startsWith(prefix)) && redirects.includes(redirectUri);
}

const PAGE_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"X-Frame-Options": "DENY",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
};

function page(title: string, body: string, status = 200, headers?: Headers): Response {
	const merged = new Headers(headers);
	for (const [name, value] of Object.entries(PAGE_HEADERS)) merged.set(name, value);
	return new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}h1{font-size:1.4rem}.warn{background:#fff4e5;border:1px solid #f0b357;padding:.75rem 1rem;border-radius:6px}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;border-radius:6px;border:1px solid #888;background:#f4f4f4;cursor:pointer}button.go{background:#1a1a1a;color:#fff;border-color:#1a1a1a}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}.warn{background:#3a2a10;border-color:#a57422}button{background:#2a2a2a;color:#eee}button.go{background:#eee;color:#111}}</style>
<body>${body}</body></html>`,
		{ status, headers: merged },
	);
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app's name is not verified.";
	return page(
		"Connect Grok media",
		`<h1>Allow ${escapeHtml(details.clientName)} to use Grok media?</h1>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p class="warn"><strong>Only allow this if you just clicked Connect in claude.ai yourself.</strong> If a link brought you here, choose Deny: someone may be trying to connect their own account to your credit.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="go" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`,
		200,
		headers,
	);
}

async function sha256Base64url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return base64url(new Uint8Array(digest));
}

export async function handleAuth(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const oauth = env.OAUTH_PROVIDER;
	try {
		if (url.pathname === "/authorize" && request.method === "GET") {
			const authRequest = await oauth.parseAuthRequest(request);
			if (!clientAllowed(env, authRequest.clientId, authRequest.redirectUri)) {
				return page("Not allowed", "<h1>This app can't connect here</h1><p>Only Claude can connect to this server.</p>", 403);
			}
			const details = await oauth.describeConsent(authRequest);
			const consent = await oauth.beginConsent(authRequest);
			return consentPage(details, consent.handle, consent.headers);
		}

		if (url.pathname === "/authorize" && request.method === "POST") {
			const form = await request.formData();
			const handle = String(form.get("handle") ?? "");
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}
			const approved = await oauth.approveConsent(request, handle);
			if (!clientAllowed(env, approved.request.clientId, approved.request.redirectUri)) {
				return page("Not allowed", "<h1>This app can't connect here</h1>", 403);
			}
			const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
			const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
			const { state, headers } = await oauth.beginUpstream(approved.request, {
				data: { verifier, nonce },
				headers: approved.headers,
			});
			const oidc = await oidcConfig(env);
			const target = new URL(oidc.authorization_endpoint);
			target.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
			target.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/callback`);
			target.searchParams.set("response_type", "code");
			target.searchParams.set("scope", "openid email profile");
			target.searchParams.set("state", state);
			target.searchParams.set("nonce", nonce);
			target.searchParams.set("code_challenge", await sha256Base64url(verifier));
			target.searchParams.set("code_challenge_method", "S256");
			headers.set("Location", target.toString());
			return new Response(null, { status: 302, headers });
		}

		if (url.pathname === "/callback" && request.method === "GET") {
			const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; nonce: string }>(request);
			const code = url.searchParams.get("code");
			if (url.searchParams.get("error") || !code) {
				headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
				return new Response(null, { status: 302, headers });
			}
			const oidc = await oidcConfig(env);
			const tokenResponse = await fetch(oidc.token_endpoint, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: `${env.PUBLIC_URL}/callback`,
					client_id: env.ACCESS_CLIENT_ID,
					client_secret: env.ACCESS_CLIENT_SECRET,
					code_verifier: data.verifier,
				}),
			});
			if (!tokenResponse.ok) {
				await tokenResponse.body?.cancel();
				return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Access did not accept the login. Start again from claude.ai.</p>", 502);
			}
			const tokens = (await tokenResponse.json()) as { id_token?: string };
			if (!tokens.id_token) return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Access sent no ID token.</p>", 502);
			let claims;
			try {
				claims = await verifyAccessJwt(tokens.id_token, {
					jwksUrl: oidc.jwks_uri,
					issuer: env.ACCESS_ISSUER,
					audience: env.ACCESS_CLIENT_ID,
					email: env.ALLOWED_EMAIL,
				});
			} catch (error) {
				console.log(JSON.stringify({ event: "login_refused", reason: error instanceof Error ? error.message : "invalid" }));
				headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
				return new Response(null, { status: 302, headers });
			}
			if (claims.nonce !== undefined && claims.nonce !== data.nonce) {
				headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
				return new Response(null, { status: 302, headers });
			}
			const props: Props = { email: claims.email, sub: claims.sub };
			const { redirectTo } = await oauth.completeAuthorization({
				request: original,
				userId: claims.sub,
				metadata: { label: "claude.ai" },
				scope: original.scope,
				props,
			});
			headers.set("Location", redirectTo);
			return new Response(null, { status: 302, headers });
		}
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
			return page("Can't continue", `<h1>Can't continue</h1><p>${escapeHtml(message)}</p><p>Start again from claude.ai.</p>`, 400);
		}
		throw error;
	}
	return new Response("Not found", { status: 404 });
}
