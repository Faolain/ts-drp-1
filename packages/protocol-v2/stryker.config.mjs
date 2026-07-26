export default {
	ignorePatterns: [
		"**",
		"!.github/workflows/protocol-v2-registry.yml",
		"!docs/production-hardening/production-hardening-tdd-plan-v2.md",
		"!eslint.config.mjs",
		"!package.json",
		"!pnpm-lock.yaml",
		"!tsconfig.json",
		"!vite.config.mts",
		"!packages/protocol-v2/conformance/ahe-reference/src/**/*.js",
		"!packages/protocol-v2/package.json",
		"!packages/protocol-v2/registry/**/*.json",
		"!packages/protocol-v2/src/**/*.ts",
		"!packages/protocol-v2/stryker.config.mjs",
		"!packages/protocol-v2/tests/**/*",
		"!packages/protocol-v2/tsconfig*.json",
		"!packages/protocol-v2/vitest.config.mts",
	],
	mutate: ["packages/protocol-v2/src/**/*.ts"],
	testFiles: ["packages/protocol-v2/tests/**/*.test.ts"],
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	// Vitest's per-test selection can miss failures after shared ESM modules have
	// already been evaluated. Run every mutant against the whole package suite.
	coverageAnalysis: "off",
	concurrency: 4,
	reporters: ["clear-text", "json"],
	jsonReporter: {
		fileName: process.env.STRYKER_JSON_REPORT ?? "reports/mutation/mutation.json",
	},
	vitest: {
		configFile: "packages/protocol-v2/vitest.config.mts",
		related: false,
	},
};
