import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const originalTestFiles = [
	"tests/canonical-adversarial.test.ts",
	"tests/porting-rules.test.ts",
	"tests/registry.test.ts",
];

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		coverage: {
			enabled: false,
		},
		exclude: ["**/node_modules/**", "**/dist/**", "**/conformance/**"],
		include: process.env.PROTOCOL_V2_TEST_PROFILE === "original-22" ? originalTestFiles : ["tests/**/*.test.ts"],
	},
});
