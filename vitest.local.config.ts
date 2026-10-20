import { defineConfig } from "vitest/config";

// Local mode's tests run in plain Node on Windows, macOS and Linux. xAI is mocked, the
// credential store is never touched, and every test gets its own temporary data folder.
export default defineConfig({
	test: {
		include: ["test-local/**/*.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
