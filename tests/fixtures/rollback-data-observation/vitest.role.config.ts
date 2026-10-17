import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../../vite.config.mts";
export default defineConfig({
	resolve: { alias: workspaceAliases },
	test: {
		include: ["tests/protected-recovery-role-node-red.test.ts"],
		testTimeout: 90000,
		hookTimeout: 90000,
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
	},
});
