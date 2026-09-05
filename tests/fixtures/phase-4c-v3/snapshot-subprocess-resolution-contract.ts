import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-4c-v3/snapshot-subprocess-resolution-contract.ts",
	"tests/phase-4c-snapshot-subprocess-resolution-red.test.ts",
]);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"tests/fixtures/shared/workspace-package-subprocess.mjs",
	"tests/fixtures/phase-4c-v3/snapshot-stream-memory-child.mjs",
	"tests/phase-4c-snapshot-stream-red.test.ts",
]);

export const PACKAGE_RESOLUTION_CONTRACT = Object.freeze({
	anchor: "packages/compaction/package.json",
	child: "tests/fixtures/phase-4c-v3/snapshot-stream-memory-child.mjs",
	forbiddenMechanisms: Object.freeze([
		"Vite aliases",
		"NODE_PATH",
		"root shim package",
		"production-relative source imports",
		"stale or gitignored dist artifacts",
		"weakened memory limits",
		"new product APIs",
		"broad production dependency changes",
	]),
	currentChildBareImports: Object.freeze(["@noble/hashes/sha2", "@ts-drp/canonical"]),
	expectedBuiltImports: Object.freeze({
		"@noble/hashes/sha2": "node_modules/.pnpm/@noble+hashes@1.7.1/node_modules/@noble/hashes/esm/sha2.js",
		"@ts-drp/canonical": "packages/canonical/dist/src/index.js",
		"@ts-drp/compaction/snapshot-stream": "packages/compaction/dist/src/snapshot-stream.js",
	}),
	launcher: "tests/fixtures/shared/workspace-package-subprocess.mjs",
	requiredRootFailure: "@ts-drp/canonical",
});

/**
 * Reports whether the exact GREEN infrastructure owners exist.
 * @returns Closed readiness state for the three-file GREEN roster.
 */
export function subprocessResolutionReadiness(): Readonly<{ missing: readonly string[]; ready: boolean }> {
	const missing = REQUIRED_GREEN_PATHS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	if (!missing.includes(PACKAGE_RESOLUTION_CONTRACT.launcher)) {
		const child = readFileSync(resolve(REPOSITORY_ROOT, PACKAGE_RESOLUTION_CONTRACT.child), "utf8");
		if (
			child.includes("packages/compaction/src/") ||
			!child.includes('"@ts-drp/canonical"') ||
			!child.includes('"@ts-drp/compaction/snapshot-stream"')
		) {
			missing.push(PACKAGE_RESOLUTION_CONTRACT.child);
		}
	}
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}
