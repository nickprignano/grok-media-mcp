// The Worker's storage for the tools: R2 for files, the Images binding for previews, signed
// /f/ links to hand files out, and the Budget Durable Object for the ledger.

import { budgetStub } from "./budget";
import { LIMITS } from "./config";
import { putMedia, signLink } from "./files";
import type { MediaBackend } from "./tools";
import { readCapped } from "./util";
import { XaiClient } from "./xai";

export function toolDeps(env: Env, fetcher?: typeof fetch): MediaBackend {
	return {
		ledger: budgetStub(env),
		xai: new XaiClient(env.XAI_API_KEY, fetcher),
		familyNames: env.FAMILY_NAMES,
		now: () => Date.now(),
		putMedia: (key, bytes, mime, sidecar) => putMedia(env, key, bytes, mime, sidecar),
		putPreview: async (key, bytes) => {
			await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
		},
		readMedia: async (record, maxBytes) => {
			const object = await env.MEDIA.get(record.key);
			return object ? readCapped(object.body, maxBytes) : undefined;
		},
		preview: async (bytes) => {
			try {
				const result = await env.IMAGES.input(new Response(bytes).body!)
					.transform({ width: 512, height: 512, fit: "scale-down" })
					.output({ format: "image/jpeg", quality: 75 });
				return new Uint8Array(await result.response().arrayBuffer());
			} catch {
				return undefined;
			}
		},
		describe: async (record) => {
			const now = Date.now();
			return {
				link: await signLink(env, record, "file", now),
				...(record.previewKey ? { preview_link: await signLink(env, record, "preview", now) } : {}),
			};
		},
		wording: {
			inputs: "uploaded on the inbox page",
			files: `Links work for ${LIMITS.linkSeconds / 3600} hour (previews 15 minutes) and download the file. Don't paste them into shared chats.`,
			noKey: "the server has no xAI key. The owner sets the XAI_API_KEY secret in the Cloudflare dashboard",
		},
		// Workers Logs get the outcome only.
		log: (event) => console.log(JSON.stringify(event)),
	};
}

