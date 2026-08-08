export const PHASE_2D_SCHEMA_VERSION = 1;
export const PHASE_2D_GENERATIONS_STORE = "generations";
export const PHASE_2D_VOTES_STORE = "votes";
export const PHASE_2D_VOTES_OBJECT_EPOCH_INDEX = "by-object-epoch";

const PHASE_2D_GENERATION_KEY_PATH = Object.freeze(["objectId", "generationId"]);
const PHASE_2D_VOTE_INDEX_KEY_PATH = Object.freeze(["objectId", "epoch"]);
const PHASE_2D_DECISION_LINK_SHA256 = "40f0175e5d7a0c4aa9855e61324639b71045ffbcf197c12caf788824c2d8e19c";

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

const PHASE_2D_STORAGE_DECISION = Object.freeze({
	chosen: "idb-strict" as const,
	linkSha256: PHASE_2D_DECISION_LINK_SHA256,
});

class BrowserStorageCapabilityError extends Error {
	readonly code = "STORAGE_DECISION_MISMATCH";

	constructor() {
		super("Phase 2d requires the accepted idb-strict decision link");
		this.name = "BrowserStorageCapabilityError";
	}
}

class StrictDurabilityCapabilityError extends Error {
	readonly code = "NON_STRICT_DURABILITY";

	constructor() {
		super("strict IndexedDB durability is required");
		this.name = "StrictDurabilityCapabilityError";
	}
}

class BrowserStorageBlockedError extends Error {
	readonly code = "UPGRADE_BLOCKED";

	constructor() {
		super("browser storage schema upgrade blocked by another connection");
		this.name = "BrowserStorageBlockedError";
	}
}

class BrowserStorageSchemaError extends Error {
	readonly code = "UNEXPECTED_SCHEMA_VERSION";

	constructor() {
		super("unexpected browser storage schema/version");
		this.name = "BrowserStorageSchemaError";
	}
}

function exactKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((part, index) => part === expected[index])
	);
}

function hasExactSchema(database: IDBDatabase): boolean {
	if (
		database.version !== PHASE_2D_SCHEMA_VERSION ||
		database.objectStoreNames.length !== 2 ||
		!database.objectStoreNames.contains(PHASE_2D_GENERATIONS_STORE) ||
		!database.objectStoreNames.contains(PHASE_2D_VOTES_STORE)
	) {
		return false;
	}

	try {
		const transaction = database.transaction([PHASE_2D_GENERATIONS_STORE, PHASE_2D_VOTES_STORE]);
		const generations = transaction.objectStore(PHASE_2D_GENERATIONS_STORE);
		const votes = transaction.objectStore(PHASE_2D_VOTES_STORE);
		if (
			generations.autoIncrement ||
			!exactKeyPath(generations.keyPath, PHASE_2D_GENERATION_KEY_PATH) ||
			votes.autoIncrement ||
			votes.keyPath !== null ||
			votes.indexNames.length !== 1 ||
			!votes.indexNames.contains(PHASE_2D_VOTES_OBJECT_EPOCH_INDEX)
		) {
			return false;
		}
		const voteIndex = votes.index(PHASE_2D_VOTES_OBJECT_EPOCH_INDEX);
		return !voteIndex.multiEntry && !voteIndex.unique && exactKeyPath(voteIndex.keyPath, PHASE_2D_VOTE_INDEX_KEY_PATH);
	} catch {
		return false;
	}
}

function requireAcceptedDecision(binding: Phase2dStorageDecisionBinding): void {
	if (
		binding.chosen !== PHASE_2D_STORAGE_DECISION.chosen ||
		binding.linkSha256 !== PHASE_2D_STORAGE_DECISION.linkSha256
	) {
		throw new BrowserStorageCapabilityError();
	}
}

function classifyOpenError(error: DOMException | null): Error {
	if (error?.name === "AbortError" || error?.name === "VersionError") return new BrowserStorageSchemaError();
	return error ?? new Error("browser storage database open failed");
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, PHASE_2D_SCHEMA_VERSION);
		request.addEventListener(
			"upgradeneeded",
			(event) => {
				if (event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) {
					request.transaction?.abort();
					return;
				}
				request.result.createObjectStore(PHASE_2D_GENERATIONS_STORE, {
					keyPath: [...PHASE_2D_GENERATION_KEY_PATH],
				});
				const votes = request.result.createObjectStore(PHASE_2D_VOTES_STORE);
				votes.createIndex(PHASE_2D_VOTES_OBJECT_EPOCH_INDEX, [...PHASE_2D_VOTE_INDEX_KEY_PATH]);
			},
			{ once: true }
		);
		request.addEventListener("error", () => reject(classifyOpenError(request.error)), { once: true });
		request.addEventListener(
			"success",
			() => {
				const database = request.result;
				if (!hasExactSchema(database)) {
					database.close();
					reject(new BrowserStorageSchemaError());
					return;
				}
				database.addEventListener("versionchange", () => database.close());
				resolve(database);
			},
			{ once: true }
		);
	});
}

/**
 * Returns the production-selected substrate evidence binding.
 * @returns The selected and digest-bound substrate authority.
 */
export function getPhase2dStorageDecisionBinding(): Phase2dStorageDecisionBinding {
	return PHASE_2D_STORAGE_DECISION;
}

/**
 * Opens the production browser database after schema and decision validation.
 * @param options - Isolated database name and optional private causal decision seam.
 * @returns An opaque, cooperatively closing database handle.
 */
export async function openPhase2dBrowserDatabase(
	options: OpenPhase2dBrowserDatabaseOptions
): Promise<Phase2dBrowserDatabase> {
	requireAcceptedDecision(options.testOnlyDecisionBinding ?? PHASE_2D_STORAGE_DECISION);
	const database = await openDatabase(options.databaseName);
	return Object.freeze({
		version: database.version,
		close: (): void => database.close(),
	});
}

/**
 * Private schema-lifecycle mutation probe; this module is not a published package subpath.
 * @param options - Isolated database name and optional forced live observation.
 * @returns The live durability and commit outcome.
 */
export async function testOnlyAttemptStrictMutation(
	options: StrictMutationProbeOptions
): Promise<StrictMutationProbeResult> {
	const database = await openDatabase(options.databaseName);
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(PHASE_2D_GENERATIONS_STORE, "readwrite", { durability: "strict" });
		const observedDurability = options.testOnlyForcedObservedDurability ?? transaction.durability;
		if (observedDurability !== "strict") {
			transaction.addEventListener(
				"abort",
				() => {
					database.close();
					reject(new StrictDurabilityCapabilityError());
				},
				{ once: true }
			);
			transaction.abort();
			return;
		}

		transaction.addEventListener(
			"complete",
			() => {
				database.close();
				resolve(Object.freeze({ committed: true, observedDurability: "strict" }));
			},
			{ once: true }
		);
		const fail = (): void => {
			database.close();
			reject(transaction.error ?? new Error("browser storage mutation failed"));
		};
		transaction.addEventListener("abort", fail, { once: true });
		transaction.addEventListener("error", fail, { once: true });
		transaction.objectStore(PHASE_2D_GENERATIONS_STORE).add({
			generationId: "strict-mutation-probe",
			objectId: "phase-2d1",
		});
	});
}

/**
 * Private schema-lifecycle upgrade probe; this module is not a published package subpath.
 * @param options - Isolated database, target version, and blocked-event bound.
 * @returns Completion when the bounded upgrade succeeds.
 */
export function testOnlyRequestPhase2dUpgrade(options: UpgradeProbeOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(options.databaseName, options.targetVersion);
		let blockedTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const clearBlockedTimer = (): void => {
			if (blockedTimer !== undefined) clearTimeout(blockedTimer);
		};
		request.addEventListener("upgradeneeded", () => {
			if (settled) request.transaction?.abort();
		});
		request.addEventListener(
			"blocked",
			() => {
				blockedTimer ??= setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new BrowserStorageBlockedError());
				}, options.blockedTimeoutMilliseconds);
			},
			{ once: true }
		);
		request.addEventListener(
			"error",
			() => {
				if (settled) return;
				settled = true;
				clearBlockedTimer();
				reject(classifyOpenError(request.error));
			},
			{ once: true }
		);
		request.addEventListener(
			"success",
			() => {
				request.result.close();
				if (settled) return;
				settled = true;
				clearBlockedTimer();
				resolve();
			},
			{ once: true }
		);
	});
}
