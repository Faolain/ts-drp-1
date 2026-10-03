import { resolve } from "node:path";
import { mergeConfig } from "vitest/config";

import base from "../../../vite.config.mts";
export default mergeConfig(base, {
	root: resolve(import.meta.dirname, "../../.."),
	test: {
		name: "bounded-active-read-red",
		include: [
			"packages/storage-node/tests/bounded-active-read-red.test.ts",
			"packages/storage/tests/bounded-active-read-red.test.ts",
		],
		maxWorkers: 1,
		minWorkers: 1,
	},
});
