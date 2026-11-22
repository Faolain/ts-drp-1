import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	test: {
		include: ["tests/snapshot-declaration-downstream-provenance-red.test.ts"],
		coverage: { enabled: false },
		testTimeout: 120000,
	},
});
