import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		coverage: {
			enabled: false,
		},
		exclude: ["**/node_modules/**", "**/dist/**"],
		include: ["tests/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
