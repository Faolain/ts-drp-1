import { mergeConfig } from "vitest/config";
import base from "../../../vite.config.mts";

export default mergeConfig(base, {
	test: {
		include: ["tests/fixtures/sealed-reopen/worker.child.ts"],
		coverage: { enabled: false },
		maxWorkers: 1,
		minWorkers: 1,
	},
});
