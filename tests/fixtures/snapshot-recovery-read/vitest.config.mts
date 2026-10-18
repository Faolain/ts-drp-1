import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

import ordinary from "../../../vite.config.mjs";

export default mergeConfig(
	ordinary,
	defineConfig({
		root: fileURLToPath(new URL("../../../", import.meta.url)),
		test: { include: [fileURLToPath(new URL("../../snapshot-recovery-read-native-red.test.ts", import.meta.url))] },
	})
);
