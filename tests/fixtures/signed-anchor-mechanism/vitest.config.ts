import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
	resolve: { alias: {
		"@ts-drp/canonical/domain-hash-stream": resolve("packages/canonical/dist/src/domain-hash-stream.js"),
		"@ts-drp/canonical": resolve("packages/canonical/dist/src/index.js"),
	} },
	test: {
		include: ["tests/signed-anchor-mechanism-node-red.test.ts"],
		testTimeout: 90000,
		hookTimeout: 90000,
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
	},
});
