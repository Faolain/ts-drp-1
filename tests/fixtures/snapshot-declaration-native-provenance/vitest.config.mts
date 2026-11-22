import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	test: {
		include: ["tests/snapshot-declaration-provenance-native-red.test.ts"],
		coverage: { enabled: false },
		testTimeout: 20000,
	},
});
