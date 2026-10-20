// Media files in R2 and the signed /f/ links that serve them.

import { LIMITS } from "./config";
import type { FileRecord, LinkKind, Sidecar } from "./media";
import { SERVABLE } from "./media";
import { hmac, hmacValid } from "./util";

export * from "./media";

export async function putMedia(
	env: Env,
	key: string,
	bytes: Uint8Array,
	mime: string,
	sidecar: Sidecar,
): Promise<void> {
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
	await env.MEDIA.put(`${key}.json`, JSON.stringify(sidecar), {
		httpMetadata: { contentType: "application/json" },
	});
}

export async function signLink(env: Env, record: FileRecord, kind: LinkKind = "file", now = Date.now()): Promise<string> {
	const ttl = kind === "preview" ? LIMITS.previewLinkSeconds : LIMITS.linkSeconds;
	const exp = Math.floor(now / 1000) + ttl;
	const sig = await hmac(env.LINK_SIGNING_KEY, `${record.id}|${exp}|${kind}`);
	const params = new URLSearchParams({ exp: String(exp), sig });
	if (kind === "preview") params.set("k", "preview");
	return `${env.PUBLIC_URL}/f/${record.id}?${params}`;
}

const FILE_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
};

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: FILE_HEADERS });
}

/** GET /f/<id>?exp=&sig=[&k=preview]. No cookies are read or set here. */
export async function serveFile(
	request: Request,
	env: Env,
	lookup: (id: string) => Promise<FileRecord | null>,
	now = Date.now(),
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	const url = new URL(request.url);
	const id = url.pathname.slice("/f/".length);
	const exp = Number(url.searchParams.get("exp"));
	const sig = url.searchParams.get("sig") ?? "";
	const kind: LinkKind = url.searchParams.get("k") === "preview" ? "preview" : "file";
	if (!/^[a-z0-9]{16}$/.test(id) || !Number.isInteger(exp) || exp < now / 1000) return notFound();
	if (!(await hmacValid(env.LINK_SIGNING_KEY, `${id}|${exp}|${kind}`, sig))) return notFound();

	const record = await lookup(id);
	if (!record || now - record.created > LIMITS.fileDays * 86_400_000) return notFound();
	const key = kind === "preview" ? record.previewKey : record.key;
	if (!key) return notFound();
	const object = await env.MEDIA.get(key);
	if (!object) return notFound();

	const mime = kind === "preview" ? "image/jpeg" : record.mime;
	const type = SERVABLE[mime];
	if (!type) return notFound();
	const name = `${record.kind}-${record.id}${kind === "preview" ? "-preview" : ""}.${type.ext}`;
	return new Response(request.method === "HEAD" ? null : object.body, {
		headers: {
			...FILE_HEADERS,
			"Content-Type": mime,
			"Content-Disposition": `attachment; filename="${name}"`,
			"Content-Length": String(object.size),
		},
	});
}
