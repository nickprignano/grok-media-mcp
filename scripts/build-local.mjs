// Bundles local mode into one file, dist/grok-media-mcp.mjs. The only package left outside the
// bundle is the native credential-store module, which npm installs per platform.
import { build } from "esbuild";

await build({
	entryPoints: ["src/local/main.ts"],
	outfile: "dist/grok-media-mcp.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["@napi-rs/keyring"],
	legalComments: "eof",
	// Bundled CommonJS packages call require(); give them one.
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	logLevel: "warning",
});
