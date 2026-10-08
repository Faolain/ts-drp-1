import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL("../..", import.meta.url)),
	resolve: {
		alias: {
			"@ts-drp/canonical": fileURLToPath(new URL("../canonical/src/index.ts", import.meta.url)),
		},
	},
	test: {
		coverage: {
			enabled: false,
		},
		include: [
			"tests/phase-2l-a-shared-issuance-contract.test.ts",
			"tests/phase-2l-a-b2-b3-corrective.test.ts",
			"tests/phase-2l-a-b4-b5-semantic-lineage-null.test.ts",
			"tests/phase-2l-a-b6-b7-terminal-input-poison.test.ts",
		],
	},
});
