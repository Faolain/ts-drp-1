import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		coverage: {
			enabled: false,
		},
		// This original divergence control belongs to the retired HashGraph engine.
		exclude: ["**/node_modules/**", "**/dist/**", "tests/order-exhaustive.test.ts"],
		include: ["tests/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
