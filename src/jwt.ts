// Verifies Cloudflare Access JWTs: the OIDC ID token from the login and the
// Cf-Access-Jwt-Assertion header on /inbox. RS256 only, which is what Access signs with.

import { fromBase64 } from "./util";

const SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 30 * 1000;

interface Jwk extends JsonWebKey {
	kid?: string;
}

interface CachedKeys {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

const jwksCache = new Map<string, CachedKeys>();

export class JwtError extends Error {}

async function loadKeys(jwksUrl: string, force: boolean): Promise<CachedKeys> {
	const cached = jwksCache.get(jwksUrl);
	const now = Date.now();
	if (cached && now - cached.fetchedAt < (force ? REFETCH_MIN_MS : JWKS_TTL_MS)) return cached;
	const response = await fetch(jwksUrl, { headers: { accept: "application/json" } });
	if (!response.ok) throw new JwtError(`signing keys unavailable (${response.status})`);
	const body = (await response.json()) as { keys?: Jwk[] };
	const keys = new Map<string, CryptoKey>();
	for (const jwk of body.keys ?? []) {
		if (jwk.kty !== "RSA" || !jwk.kid) continue;
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		keys.set(jwk.kid, key);
	}
	const entry = { keys, fetchedAt: now };
	jwksCache.set(jwksUrl, entry);
	return entry;
}

export interface VerifyOptions {
	jwksUrl: string;
	issuer: string;
	audience: string;
	email: string;
	now?: number;
}

export interface VerifiedClaims {
	sub: string;
	email: string;
	[claim: string]: unknown;
}

function decodePart(part: string): Record<string, unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(fromBase64(part)));
	} catch {
		throw new JwtError("malformed token");
	}
}

/**
 * Checks signature, iss, aud, exp, nbf and that the email is the one allowed address.
 * Never loosen any of these to make a login pass: fix the configuration instead.
 */
export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<VerifiedClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new JwtError("malformed token");
	const header = decodePart(parts[0]);
	const claims = decodePart(parts[1]);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new JwtError("unexpected algorithm");

	let key = (await loadKeys(options.jwksUrl, false)).keys.get(header.kid);
	if (!key) key = (await loadKeys(options.jwksUrl, true)).keys.get(header.kid);
	if (!key) throw new JwtError("unknown signing key");

	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64(parts[2]), signed);
	if (!valid) throw new JwtError("bad signature");

	const now = Math.floor((options.now ?? Date.now()) / 1000);
	if (claims.iss !== options.issuer) throw new JwtError("wrong issuer");
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(options.audience)) throw new JwtError("wrong audience");
	if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) throw new JwtError("expired");
	if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) throw new JwtError("not yet valid");
	if (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > now) throw new JwtError("issued in the future");
	if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("no subject");
	if (typeof claims.email !== "string" || claims.email.toLowerCase() !== options.email.trim().toLowerCase()) {
		throw new JwtError("this login is not allowed");
	}
	return claims as VerifiedClaims;
}

/** For tests. */
export function clearJwksCache(): void {
	jwksCache.clear();
}
