import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			"@ts-drp/room-worker/page": fileURLToPath(new URL("./src/page.ts", import.meta.url)),
			"@ts-drp/room-worker/worker": fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
			"@ts-drp/room-worker": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		},
	},
	test: {
		coverage: { enabled: false },
		exclude: ["**/node_modules/**", "**/dist/**"],
		include: ["tests/**/*.test.ts"],
		testTimeout: 5_000,
	},
});
