import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	test: {
		name: "cold-discovery-room-callsite",
		include: ["tests/cold-discovery-room-callsite.test.ts"],
		coverage: { enabled: false },
	},
});
