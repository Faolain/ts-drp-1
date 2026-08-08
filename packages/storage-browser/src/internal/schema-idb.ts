export const PHASE_2D_SCHEMA_VERSION = 1;
export const PHASE_2D_GENERATIONS_STORE = "generations";
export const PHASE_2D_VOTES_STORE = "votes";
export const PHASE_2D_VOTES_OBJECT_EPOCH_INDEX = "by-object-epoch";

export interface Phase2dStorageDecisionBinding {
	readonly chosen: "idb-strict" | "unselected";
	readonly linkSha256: string;
}

export interface Phase2dBrowserDatabase {
	readonly version: number;
	close(): void;
}

export interface OpenPhase2dBrowserDatabaseOptions {
	readonly databaseName: string;
	readonly testOnlyDecisionBinding?: Phase2dStorageDecisionBinding;
}

export interface StrictMutationProbeOptions {
	readonly databaseName: string;
	readonly testOnlyForcedObservedDurability?: "default" | "relaxed" | "strict";
}

export interface StrictMutationProbeResult {
	readonly observedDurability: "default" | "relaxed" | "strict";
	readonly committed: true;
}

export interface UpgradeProbeOptions {
	readonly blockedTimeoutMilliseconds: number;
	readonly databaseName: string;
	readonly targetVersion: number;
}

const RED_SCAFFOLD_ERROR = new Error("Phase 2d1 schema RED scaffold has no IndexedDB implementation");

/**
 * Returns the production-selected substrate evidence binding.
 * @returns The selected and digest-bound substrate authority.
 */
export function getPhase2dStorageDecisionBinding(): Phase2dStorageDecisionBinding {
	return Object.freeze({ chosen: "unselected", linkSha256: "" });
}

/**
 * Opens the production browser database after schema and decision validation.
 * @param options - Isolated database name and optional private causal decision seam.
 * @returns An opaque, cooperatively closing database handle.
 */
export function openPhase2dBrowserDatabase(
	options: OpenPhase2dBrowserDatabaseOptions
): Promise<Phase2dBrowserDatabase> {
	void options;
	return Promise.reject(RED_SCAFFOLD_ERROR);
}

/**
 * Private RED-only mutation probe; this module is not a published package subpath.
 * @param options - Isolated database name and optional forced live observation.
 * @returns The live durability and commit outcome.
 */
export function testOnlyAttemptStrictMutation(options: StrictMutationProbeOptions): Promise<StrictMutationProbeResult> {
	void options;
	return Promise.reject(RED_SCAFFOLD_ERROR);
}

/**
 * Private RED-only upgrade probe; this module is not a published package subpath.
 * @param options - Isolated database, target version, and blocked-event bound.
 * @returns Completion when the bounded upgrade succeeds.
 */
export function testOnlyRequestPhase2dUpgrade(options: UpgradeProbeOptions): Promise<void> {
	void options;
	return Promise.reject(RED_SCAFFOLD_ERROR);
}
