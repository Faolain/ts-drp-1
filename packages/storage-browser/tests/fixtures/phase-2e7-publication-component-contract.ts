// Phase 2g-a supersedes the old singleton roster with one additive, neutral
// capacity binding while preserving the root-only package boundary.
export const PHASE_2E7_PUBLIC_RUNTIME_KEYS = Object.freeze([
	"createBrowserAheDurableStore",
	"createBrowserStorageCapacityPort",
] as const);

export const PHASE_2E7_PACKAGE_FILES = Object.freeze([
	"src",
	"dist",
	"!dist/test",
	"!dist/tests",
	"!dist/playwright*",
	"!**/*.tsbuildinfo",
] as const);

export const PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS = Object.freeze({
	config: "packages/storage-browser/playwright.phase-2e6-real-process-death.config.ts",
	frozenTest: "packages/storage-browser/tests/phase-2e6-real-process-death.pw.ts",
	staleTest: "packages/storage-browser/tests/phase-2e6-real-process-death-red.pw.ts",
} as const);

/** Files whose only remaining authority is the superseded Phase 2b toy campaign. */
export const PHASE_2E7_TOY_REMOVE_PATHS = Object.freeze([
	"packages/storage-browser/killpoints.json",
	"packages/storage-browser/playwright.storage-browser.config.ts",
	"packages/storage-browser/src/internal/instrumented-idb.ts",
	"packages/storage-browser/src/killpoints.ts",
	"packages/storage-browser/tests/assets/oracle-entry.ts",
	"packages/storage-browser/tests/assets/page-entry.ts",
	"packages/storage-browser/tests/assets/seed-entry.ts",
	"packages/storage-browser/tests/assets/worker-entry.ts",
	"packages/storage-browser/tests/crash-driver.pw.ts",
	"packages/storage-browser/tests/fixture-oracle-controls.test.ts",
	"packages/storage-browser/tests/fixtures/fixture-records.ts",
	"packages/storage-browser/tests/fixtures/inert-campaign.ts",
	"packages/storage-browser/tests/fixtures/oracle-idb.ts",
	"packages/storage-browser/tests/fixtures/worker-protocol.ts",
	"packages/storage-browser/tests/global-setup.ts",
	"packages/storage-browser/tests/global-teardown.ts",
	"packages/storage-browser/tests/process/arming-child.ts",
	"packages/storage-browser/tests/process/browser-smoke-child.ts",
	"packages/storage-browser/tests/process/crash-child.ts",
	"packages/storage-browser/tests/process/inert-role.ts",
	"packages/storage-browser/tests/process/settled-child.ts",
	"packages/storage-browser/tests/worker-protocol-controls.test.ts",
] as const);

/** Mixed controls stay, but these obsolete toy assertions/import edges must be removed. */
export const PHASE_2E7_TOY_REWRITE_PATHS = Object.freeze([
	"packages/storage-browser/tests/artifact-schema-controls.test.ts",
	"packages/storage-browser/tests/asset-server-controls.test.ts",
	"packages/storage-browser/tests/cleanup-authority-corrective-red.test.ts",
	"packages/storage-browser/tests/corrective-clean-checkout-red.test.ts",
	"packages/storage-browser/tests/corrective-failure-finalization-red.test.ts",
	"packages/storage-browser/tests/corrective-persisted-artifacts-red.test.ts",
	"packages/storage-browser/tests/executable-authority-corrective-red.test.ts",
	"packages/storage-browser/tests/fixtures/artifacts.ts",
	"packages/storage-browser/tests/fixtures/asset-server.ts",
	"packages/storage-browser/tests/fixtures/corrective-artifact-fixtures.ts",
	"packages/storage-browser/tests/fixtures/idb-ownership-checker.ts",
	"packages/storage-browser/tests/fixtures/phase-2e5-browser-inventory-authority.ts",
	"packages/storage-browser/tests/fixtures/run-finalizer.ts",
	"packages/storage-browser/tests/fixtures/settled-failure-ownership.ts",
	"packages/storage-browser/tests/fixtures/settled-run-lifecycle.ts",
	"packages/storage-browser/tests/idb-ownership-controls.test.ts",
	"packages/storage-browser/tests/idb-ownership-nested-controls.test.ts",
	"packages/storage-browser/tests/linux-failure-cleanup-authority-red.test.ts",
	"packages/storage-browser/tests/phase-2e5-browser-inventory-governance-red.test.ts",
	"packages/storage-browser/tests/real-chrome-cleanup-authority-red.test.ts",
	"packages/storage-browser/tests/settled-failure-ownership-red.test.ts",
	"packages/storage-browser/tests/settled-run-lifecycle-red.test.ts",
	"packages/storage-browser/tests/staged-freeze-churn-red.test.ts",
	"packages/storage-browser/tests/structural-controls.test.ts",
	"packages/storage-browser/tsconfig.build.json",
	"packages/storage-browser/tsconfig.json",
] as const);

export const PHASE_2E7_RETAINED_GOVERNANCE_PATHS = Object.freeze([
	"packages/storage-browser/tests/asset-server-controls.test.ts",
	"packages/storage-browser/tests/fixtures/asset-server.ts",
	"packages/storage-browser/tests/fixtures/idb-ownership-checker.ts",
	"packages/storage-browser/tests/fixtures/process-forest.ts",
	"packages/storage-browser/tests/process-forest-controls.test.ts",
	"packages/storage-browser/tests/idb-ownership-controls.test.ts",
	"packages/storage-browser/tests/idb-ownership-nested-controls.test.ts",
	"packages/storage-browser/tests/staged-freeze-churn-red.test.ts",
] as const);

export const PHASE_2E7_TOY_IMPORT_EDGES = Object.freeze([
	Object.freeze({ from: "packages/storage-browser/tsconfig.json", to: "playwright.storage-browser.config.ts" }),
	Object.freeze({ from: "packages/storage-browser/tsconfig.build.json", to: "playwright.storage-browser.config.ts" }),
	Object.freeze({
		from: "packages/storage-browser/tests/fixtures/idb-ownership-checker.ts",
		to: "src/internal/instrumented-idb.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/fixtures/idb-ownership-checker.ts",
		to: "tests/fixtures/oracle-idb.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/phase-2e5-browser-inventory-governance-red.test.ts",
		to: "playwright.storage-browser.config.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/fixtures/phase-2e5-browser-inventory-authority.ts",
		to: "playwright.storage-browser.config.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/artifact-schema-controls.test.ts",
		to: "fixtures/fixture-records.js",
	}),
	Object.freeze({ from: "packages/storage-browser/tests/asset-server-controls.test.ts", to: "page-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/asset-server-controls.test.ts", to: "worker-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/asset-server.ts", to: "page-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/asset-server.ts", to: "worker-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/asset-server.ts", to: "seed-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/asset-server.ts", to: "oracle-entry.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/artifacts.ts", to: "./fixture-records.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/artifacts.ts", to: "./worker-protocol.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/artifacts.ts", to: "internal/instrumented-idb.js" }),
	Object.freeze({ from: "packages/storage-browser/tests/fixtures/artifacts.ts", to: "src/killpoints.js" }),
	Object.freeze({
		from: "packages/storage-browser/tests/fixtures/corrective-artifact-fixtures.ts",
		to: "./fixture-records.js",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/fixtures/corrective-artifact-fixtures.ts",
		to: "src/killpoints.js",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/idb-ownership-nested-controls.test.ts",
		to: "tests/assets/page-entry.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/idb-ownership-nested-controls.test.ts",
		to: "tests/assets/seed-entry.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/idb-ownership-nested-controls.test.ts",
		to: "tests/assets/oracle-entry.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/structural-controls.test.ts",
		to: "../src/killpoints.js",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/structural-controls.test.ts",
		to: "./fixtures/inert-campaign.js",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/executable-authority-corrective-red.test.ts",
		to: "process/arming-child.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/executable-authority-corrective-red.test.ts",
		to: "process/crash-child.ts",
	}),
	Object.freeze({
		from: "packages/storage-browser/tests/executable-authority-corrective-red.test.ts",
		to: "process/settled-child.ts",
	}),
	...[
		"cleanup-authority-corrective-red.test.ts",
		"corrective-failure-finalization-red.test.ts",
		"executable-authority-corrective-red.test.ts",
		"settled-failure-ownership-red.test.ts",
		"settled-run-lifecycle-red.test.ts",
		"staged-freeze-churn-red.test.ts",
	].map((owner) => Object.freeze({ from: `packages/storage-browser/tests/${owner}`, to: "crash-driver.pw.ts" })),
] as const);

export interface Phase2e7ClosureObservation {
	readonly publicRuntimeKeys: readonly string[];
	readonly exportSubpaths: readonly string[];
	readonly toyPathsPresent: readonly string[];
	readonly toyImportEdgesPresent: readonly string[];
	readonly telemetryFieldsPresent: readonly string[];
	readonly staleAuthorityPathsPresent: readonly string[];
	readonly agentNamedArtifactPathsPresent: readonly string[];
	readonly rollbackControl:
		| undefined
		| Readonly<{
				candidateState: string;
				expectedHead: string;
				result: string;
		  }>;
}

/**
 * Applies the finite Phase 2e7 publication, retirement, and hygiene oracle.
 * @param observed - One closed observation of the owned boundary.
 * @returns Every violated closure category.
 */
export function phase2e7ClosureErrors(observed: Phase2e7ClosureObservation): readonly string[] {
	const errors: string[] = [];
	if (JSON.stringify(observed.publicRuntimeKeys) !== JSON.stringify(PHASE_2E7_PUBLIC_RUNTIME_KEYS))
		errors.push("public runtime surface is not closed");
	if (JSON.stringify(observed.exportSubpaths) !== JSON.stringify(["."]))
		errors.push("package exports a non-root subpath");
	if (observed.toyPathsPresent.length > 0) errors.push("superseded Phase 2b toy paths remain");
	if (observed.toyImportEdgesPresent.length > 0) errors.push("superseded Phase 2b import edges remain");
	if (observed.telemetryFieldsPresent.length > 0) errors.push("decorative Phase 2e6 telemetry remains");
	if (observed.staleAuthorityPathsPresent.length > 0) errors.push("stale RED authority name remains");
	if (observed.agentNamedArtifactPathsPresent.length > 0) errors.push("agent-named artifact custody remains");
	if (
		observed.rollbackControl?.candidateState !== "Complete" ||
		observed.rollbackControl.expectedHead !== "stale" ||
		observed.rollbackControl.result !== "HEAD_CONFLICT"
	)
		errors.push("rollback control does not reach the stale-head guard with a Complete candidate");
	return errors;
}
