import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/signed-anchor-mechanism-node-red.test.ts"],
		testTimeout: 90000,
		hookTimeout: 90000,
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
	},
});
