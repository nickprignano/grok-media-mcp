// /inbox: the owner's own page, behind a Cloudflare Access self-hosted app on /inbox*. The Worker
// also checks the Access JWT itself on every request, so a gap in the Access config fails closed.
//
// GET  /inbox          arm state, arm form, upload form, recent uploads
// POST /inbox/arm      arm generating tools for ARM_HOURS (ticking "not for kids' use")
// POST /inbox/disarm   disarm now
// POST /inbox/upload   upload one image or audio file to use as a tool input

import { type ArmState, budgetStub } from "./budget";
import { LIMITS, formatUsd } from "./config";
import { type FileRecord, SERVABLE, newFileKey, putMedia, sniffType, stripJpegMetadata } from "./files";
import { verifyAccessJwt } from "./jwt";
import { SizeError, escapeHtml, hmac, hmacValid, randomId, readCapped } from "./util";

const CSRF_COOKIE = "__Host-inbox-csrf";

const HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
};

export function teamDomain(env: Env): string {
	return new URL(env.ACCESS_ISSUER).origin;
}

async function accessUser(request: Request, env: Env): Promise<string | undefined> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token || !env.INBOX_ACCESS_AUD) return undefined;
	try {
		const claims = await verifyAccessJwt(token, {
			jwksUrl: `${teamDomain(env)}/cdn-cgi/access/certs`,
			issuer: teamDomain(env),
			audience: env.INBOX_ACCESS_AUD,
			email: env.ALLOWED_EMAIL,
		});
		return claims.sub;
	} catch {
		return undefined;
	}
}

function cookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

/** Same-origin fetch metadata, a matching Origin, and a double-submit token bound to the user. */
async function postAllowed(request: Request, env: Env, form: FormData, user: string): Promise<boolean> {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site !== null && site !== "same-origin") return false;
	const origin = request.headers.get("Origin");
	if (origin !== env.PUBLIC_URL) return false;
	const token = String(form.get("csrf") ?? "");
	const fromCookie = cookie(request, CSRF_COOKIE);
	if (!token || token !== fromCookie) return false;
	const [nonce, signature] = token.split(".");
	return Boolean(nonce && signature && (await hmacValid(env.COOKIE_ENCRYPTION_KEY, `inbox|${user}|${nonce}`, signature)));
}

function render(body: string, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Grok media inbox</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}.box{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.armed{border-color:#c0392b;background:#fdecea}.warn{background:#fff4e5;border:1px solid #f0b357;padding:.5rem .75rem;border-radius:6px}button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #888;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #ddd}code{font-size:.9rem}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}.armed{background:#3a1512}.warn{background:#3a2a10}button{background:#2a2a2a;color:#eee}td,th{border-color:#333}}</style>
<body>${body}</body></html>`,
		{ status, headers: { ...HEADERS, ...headers } },
	);
}

function armBox(state: ArmState, csrf: string): string {
	if (state.armed && state.until) {
		return `<div class="box armed"><strong>Armed</strong> until ${escapeHtml(new Date(state.until).toISOString().replace("T", " ").slice(0, 16))} UTC${state.purpose ? ` for <em>${escapeHtml(state.purpose)}</em>` : ""}. Chats can spend money now.
<form method="post" action="/inbox/disarm"><input type="hidden" name="csrf" value="${csrf}"><p><button>Disarm now</button></p></form></div>`;
	}
	return `<div class="box"><strong>Disarmed.</strong> Generating tools refuse until you arm the server. Reading tools still work.
<form method="post" action="/inbox/arm"><input type="hidden" name="csrf" value="${csrf}">
<p><label>What for: <select name="purpose"><option>blog</option><option>personal</option><option>testing</option></select></label></p>
<p><label><input type="checkbox" name="not_for_kids" value="yes" required> This is not for anything a child or teen uses, and won't depict one.</label></p>
<p><button>Arm</button></p></form></div>`;
}

export async function handleInbox(request: Request, env: Env): Promise<Response> {
	const user = await accessUser(request, env);
	if (!user) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
	const url = new URL(request.url);
	const budget = budgetStub(env);

	if (request.method === "POST") {
		let form: FormData;
		try {
			// Bounded by Cloudflare's request size limit; the file itself is checked below.
			form = await request.formData();
		} catch {
			return render("<p>That upload could not be read.</p>", {}, 400);
		}
		if (!(await postAllowed(request, env, form, user))) {
			return render('<p>That form expired. <a href="/inbox">Reload the inbox</a>.</p>', {}, 403);
		}
		let message = "";
		if (url.pathname === "/inbox/arm") {
			if (form.get("not_for_kids") !== "yes") return render('<p>Tick the box to arm. <a href="/inbox">Back</a></p>', {}, 400);
			const purpose = String(form.get("purpose") ?? "personal").replace(/[^a-z]/g, "").slice(0, 20) || "personal";
			await budget.arm(purpose);
			message = "Armed.";
		} else if (url.pathname === "/inbox/disarm") {
			await budget.disarm();
			message = "Disarmed.";
		} else if (url.pathname === "/inbox/upload") {
			message = await upload(env, budget, form.get("file"));
		} else {
			return new Response("Not found", { status: 404 });
		}
		return new Response(null, { status: 303, headers: { Location: `/inbox?m=${encodeURIComponent(message)}`, "Cache-Control": "no-store" } });
	}

	if (url.pathname !== "/inbox") return new Response("Not found", { status: 404 });
	const nonce = randomId(16);
	const csrf = `${nonce}.${await hmac(env.COOKIE_ENCRYPTION_KEY, `inbox|${user}|${nonce}`)}`;
	const state = await budget.armState();
	const status = await budget.status();
	const uploads = await budget.listFiles({ source: "inbox", limit: 10 });
	const message = (url.searchParams.get("m") ?? "").slice(0, 200);
	return render(
		`<h1>Grok media inbox</h1>
${message ? `<p><strong>${escapeHtml(message)}</strong></p>` : ""}
${armBox(state, csrf)}
<p>Spent today ${formatUsd(status.spentToday)} of ${formatUsd(status.caps.perDay)}, this month ${formatUsd(status.spentThisMonth)} of ${formatUsd(status.caps.perMonth)}.</p>
<h2>Upload an input</h2>
<p class="warn">Only your own photos and recordings: no other people, and no kids.</p>
<form method="post" action="/inbox/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${csrf}">
<p><input type="file" name="file" accept="image/png,image/jpeg,image/webp,audio/*" required></p>
<p><button>Upload</button></p></form>
<p>Images up to 20 MB are re-encoded, which removes location and camera data. Audio up to 25 MB. Files are deleted after 30 days.</p>
<h2>Recent uploads</h2>
${uploads.length ? `<table><tr><th>File id</th><th>Type</th><th>Uploaded (UTC)</th></tr>${uploads.map(uploadRow).join("")}</table>` : "<p>None yet.</p>"}`,
		{ "Set-Cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600` },
	);
}

function uploadRow(file: FileRecord): string {
	return `<tr><td><code>${escapeHtml(file.id)}</code></td><td>${escapeHtml(file.kind)}</td><td>${escapeHtml(new Date(file.created).toISOString().replace("T", " ").slice(0, 16))}</td></tr>`;
}

async function upload(env: Env, budget: ReturnType<typeof budgetStub>, entry: File | string | null): Promise<string> {
	if (!entry || typeof entry === "string") return "No file was attached.";
	let bytes: Uint8Array;
	try {
		bytes = await readCapped(entry.stream(), LIMITS.audioBytes);
	} catch (error) {
		return error instanceof SizeError ? "That file is too large." : "That file could not be read.";
	}
	const sniffed = sniffType(bytes);
	const type = sniffed ? SERVABLE[sniffed] : undefined;
	if (!sniffed || !type || type.kind === "video") return "Only PNG, JPEG or WebP images and MP3, WAV, OGG, FLAC or M4A audio.";

	let mime = sniffed;
	if (type.kind === "image") {
		if (bytes.byteLength > LIMITS.imageBytes) return "Images can be up to 20 MB.";
		try {
			// Decode and re-encode: drops EXIF (including location) and breaks polyglot files.
			const result = await env.IMAGES.input(new Response(bytes).body!).output({ format: "image/jpeg", quality: 92 });
			bytes = stripJpegMetadata(new Uint8Array(await result.response().arrayBuffer()));
			mime = "image/jpeg";
		} catch {
			return "That image could not be decoded.";
		}
		if (sniffType(bytes) !== "image/jpeg") return "That image could not be re-encoded.";
	}

	const created = Date.now();
	const kind = SERVABLE[mime].kind;
	const { id, key } = newFileKey(kind, mime, created);
	await putMedia(env, key, bytes, mime, { created, source: "inbox" });
	await budget.addFile({ id, key, kind, mime, source: "inbox", size: bytes.byteLength, created });
	return `Uploaded. File id: ${id}`;
}
