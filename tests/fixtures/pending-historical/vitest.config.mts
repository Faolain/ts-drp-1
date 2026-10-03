import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";

import rootConfig from "../../../vite.config.mts";

// Source-only historical seam/cleanup runner; no native restart or repository coverage claim.
// Root selected run is separately retained with its original coverage threshold and budget.
export default mergeConfig(rootConfig, {
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	test: {
		name: "pending-historical-source-only",
		include: [
			"tests/cold-discovery-room-callsite.test.ts",
			"tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts",
			"tests/pending-historical-owned-snapshot.test.ts",
		],
		coverage: { enabled: false },
	},
});
