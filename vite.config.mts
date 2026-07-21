import path from "node:path";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			"@ts-drp/routing-node/constants": path.resolve(__dirname, "packages/routing-node/src/constants.ts"),
			"@ts-drp/membership": path.resolve(__dirname, "packages/membership/src/index.ts"),
			"@ts-drp/network": path.resolve(__dirname, "packages/network/src/index.ts"),
			"@ts-drp/object": path.resolve(__dirname, "packages/object/src/index.ts"),
			"@ts-drp/relay-policy": path.resolve(__dirname, "packages/relay-policy/src/index.ts"),
			"@ts-drp/rendezvous": path.resolve(__dirname, "packages/rendezvous/src/index.ts"),
			"@ts-drp/routing-browser": path.resolve(__dirname, "packages/routing-browser/src/index.ts"),
			"@ts-drp/routing-node": path.resolve(__dirname, "packages/routing-node/src/index.ts"),
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
