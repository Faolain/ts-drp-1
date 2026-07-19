import path from "node:path";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			"@ts-drp/network": path.resolve(__dirname, "packages/network/src/index.ts"),
			"@ts-drp/object": path.resolve(__dirname, "packages/object/src/index.ts"),
			"@ts-drp/test-utils": path.resolve(__dirname, "packages/test-utils/src/index.ts"),
			"@ts-drp/utils/serialization": path.resolve(__dirname, "packages/utils/src/serialization/index.ts"),
			"@ts-drp/validation/message": path.resolve(__dirname, "packages/validation/src/schemas/message.ts"),
			"@ts-drp/validation/errors": path.resolve(__dirname, "packages/validation/src/errors.ts"),
			"@ts-drp/validation": path.resolve(__dirname, "packages/validation/src/index.ts"),
		},
	},
	test: {
		exclude: ["**/node_modules", "**/e2e", "**/dist"],
		coverage: {
			enabled: true,
			reporter: ["text", "lcov", "json-summary", "json"],
			include: ["packages/**/*.{ts,tsx}"],
			exclude: ["**/node_modules/**", "**/__tests__/**", "**/tests/**", "**/proto/**", "**/dist/**", "**/version.ts"],
		},
		testTimeout: 10000,
	},
});
