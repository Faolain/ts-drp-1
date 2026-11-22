import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";

import base from "../../../vite.config.mts";
const config = mergeConfig(base, {
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	test: {
		root: fileURLToPath(new URL("../../../", import.meta.url)),
		name: "bounded-active-read-red",
		include: [
			"tests/phase-6a-creator-adoption-red.test.ts",
			"packages/storage-node/tests/retirement-image-cas.test.ts",
			"packages/storage-node/tests/bounded-active-read-red.test.ts",
			"packages/storage/tests/bounded-active-read-red.test.ts",
		],
		maxWorkers: 1,
		minWorkers: 1,
	},
});
export default {
	...config,
	resolve: {
		...config.resolve,
		alias: [
			{
				find: "@ts-drp/protocol-v3/internal/creator-forward-promotion",
				replacement: fileURLToPath(
					new URL("../../../packages/protocol-v3/src/internal/creator-forward-promotion.ts", import.meta.url)
				),
			},
			...Object.entries(base.resolve!.alias as Record<string, string>).map(([find, replacement]) => ({
				find,
				replacement,
			})),
		],
	},
};
