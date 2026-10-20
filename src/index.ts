import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { type AuthEnv, type Props, handleAuth } from "./auth";
import { budgetStub } from "./budget";
import { missingSettings, publicHost } from "./config";
import { serveFile } from "./files";
import { handleInbox } from "./inbox";
import { buildServer } from "./tools";
import { toolDeps } from "./worker-backend";

export { Budget } from "./budget";

const mcpApi = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// The grant's email is checked on every call, so changing ALLOWED_EMAIL locks out old grants.
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!props?.email || props.email.toLowerCase() !== env.ALLOWED_EMAIL.trim().toLowerCase()) {
			return new Response("Forbidden", { status: 403 });
		}
		const handler = createMcpHandler(() => buildServer(toolDeps(env)), {
			route: "/mcp",
			allowedHostnames: [publicHost(env)],
			corsOptions: false,
		});
		return handler(request, env, ctx);
	},
};

const site = {
	async fetch(request: Request, env: AuthEnv): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/authorize" || pathname === "/callback") return handleAuth(request, env);
		if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return handleInbox(request, env);
		if (pathname.startsWith("/f/")) return serveFile(request, env, (id) => budgetStub(env).getFile(id));
		if (pathname === "/") return new Response("grok-media-mcp\n", { headers: { "content-type": "text/plain" } });
		return new Response("Not found", { status: 404 });
	},
};

// The resource URL is every token's audience and can't be in the repo, so the provider is built
// from PUBLIC_URL on the first request.
let provider: OAuthProvider<Env> | undefined;
let providerFor: string | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
	if (!provider || providerFor !== env.PUBLIC_URL) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApi,
			defaultHandler: site as unknown as ExportedHandler<Env>,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			// No clientRegistrationEndpoint: dynamic client registration stays off. Claude connects
			// with its Client ID Metadata Document, and /authorize only accepts Claude's.
			clientIdMetadataDocumentEnabled: true,
			accessTokenTTL: 3600,
			refreshTokenTTL: 30 * 24 * 3600,
			resourceMetadata: {
				resource: `${env.PUBLIC_URL}/mcp`,
				authorization_servers: [env.PUBLIC_URL],
				resource_name: "Grok media",
			},
		});
		providerFor = env.PUBLIC_URL;
	}
	return provider;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const missing = missingSettings(env);
		if (missing.length) {
			// Names only, never values. Visible to anyone who reaches the host, so keep it short.
			console.log(JSON.stringify({ event: "not_configured", missing }));
			return new Response("Not configured yet. See README.md, Host your own copy.\n", { status: 503 });
		}
		// Only the custom domain is served: any other Host (a workers.dev or preview URL) is refused.
		if (new URL(request.url).host !== publicHost(env)) return new Response("Not found", { status: 404 });
		return getProvider(env).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
