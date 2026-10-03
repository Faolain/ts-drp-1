import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/rollback-same-u-complement-red.test.ts"],
		testTimeout: 90_000,
		hookTimeout: 90_000,
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
		retry: 0,
	},
});
