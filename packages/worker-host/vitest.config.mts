import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			"@ts-drp/worker-host": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		},
	},
	test: {
		coverage: { enabled: false },
		exclude: ["**/node_modules/**", "**/dist/**"],
		include: ["tests/**/*.test.ts"],
		testTimeout: 4_000,
	},
});
