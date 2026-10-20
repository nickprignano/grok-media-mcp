import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in workerd through Miniflare with made-up settings. xAI and Access are mocked;
// nothing here reaches a real account or spends money.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					XAI_API_KEY: "test-xai-key",
					ACCESS_CLIENT_ID: "test-client-id",
					ACCESS_CLIENT_SECRET: "test-client-secret",
					ACCESS_ISSUER: "https://team.example.com/cdn-cgi/access/sso/oidc/test-client-id",
					INBOX_ACCESS_AUD: "test-inbox-aud",
					COOKIE_ENCRYPTION_KEY: "test-cookie-key-0123456789abcdef0123456789",
					LINK_SIGNING_KEY: "test-link-key-0123456789abcdef0123456789abc",
					PUBLIC_URL: "https://media.example.com",
					ALLOWED_EMAIL: "owner@example.com",
					FAMILY_NAMES: "Zebulon, Quintessa Marie",
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
