import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/journal-anchor-read-*-red.test.ts"],
		testTimeout: 90_000,
		hookTimeout: 90_000,
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
	},
});
