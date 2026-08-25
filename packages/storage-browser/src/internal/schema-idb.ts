const PHASE_2D_DECISION_LINK_SHA256 = "40f0175e5d7a0c4aa9855e61324639b71045ffbcf197c12caf788824c2d8e19c";
const PHASE_5C_BLOCKED_OPEN_TIMEOUT_MILLISECONDS = 250;

export const PHASE_2D_SCHEMA_AUTHORITY = Object.freeze({
	stores: Object.freeze([
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: "objectId",
			name: "objects",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId"]),
			name: "generations",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: "digest",
			name: "blobs",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId", "digest"]),
			name: "promotions",
		}),
	]),
	version: 1,
} as const);

export const PHASE_5C_SCHEMA_AUTHORITY = Object.freeze({
	stores: Object.freeze([
		...PHASE_2D_SCHEMA_AUTHORITY.stores,
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "key", name: "storageMeta" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteSlots",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "signerState",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteOutbox",
		}),
	]),
	version: 2,
} as const);

export const PHASE_2D_SCHEMA_VERSION = PHASE_2D_SCHEMA_AUTHORITY.version;
export const PHASE_2D_OBJECTS_STORE = PHASE_2D_SCHEMA_AUTHORITY.stores[0].name;
export const PHASE_2D_GENERATIONS_STORE = PHASE_2D_SCHEMA_AUTHORITY.stores[1].name;
export const PHASE_2D_BLOBS_STORE = PHASE_2D_SCHEMA_AUTHORITY.stores[2].name;
export const PHASE_2D_PROMOTIONS_STORE = PHASE_2D_SCHEMA_AUTHORITY.stores[3].name;
export const PHASE_5C_SCHEMA_VERSION = PHASE_5C_SCHEMA_AUTHORITY.version;
export const PHASE_5C_STORAGE_META_STORE = "storageMeta" as const;
export const PHASE_5C_VOTE_SLOTS_STORE = "voteSlots" as const;
export const PHASE_5C_SIGNER_STATE_STORE = "signerState" as const;
export const PHASE_5C_VOTE_OUTBOX_STORE = "voteOutbox" as const;

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

class BrowserStorageBlockedError extends Error {
	readonly code = "UPGRADE_BLOCKED";

	constructor() {
		super("browser storage schema upgrade blocked by another connection");
		this.name = "BrowserStorageBlockedError";
	}
}

class BrowserStorageSchemaError extends Error {
	readonly code = "UNEXPECTED_SCHEMA_VERSION";
	readonly reason = "UNSUPPORTED_STORAGE_SCHEMA";

	constructor() {
		super("unexpected browser storage schema/version");
		this.name = "BrowserStorageSchemaError";
	}
}

function exactKeyPath(actual: string | string[] | null, expected: string | readonly string[] | null): boolean {
	if (!Array.isArray(expected)) return actual === expected;
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((part, index) => part === expected[index])
	);
}

function hasExactSchema(
	database: IDBDatabase,
	authority: typeof PHASE_2D_SCHEMA_AUTHORITY | typeof PHASE_5C_SCHEMA_AUTHORITY,
	transaction?: IDBTransaction,
	ignoreVersion = false
): boolean {
	if (
		(!ignoreVersion && database.version !== authority.version) ||
		database.objectStoreNames.length !== authority.stores.length ||
		authority.stores.some((store) => !database.objectStoreNames.contains(store.name))
	) {
		return false;
	}

	try {
		const selectedTransaction = transaction ?? database.transaction(authority.stores.map((store) => store.name));
		return authority.stores.every((expectedStore) => {
			const actualStore = selectedTransaction.objectStore(expectedStore.name);
			if (
				actualStore.autoIncrement !== expectedStore.autoIncrement ||
				!exactKeyPath(actualStore.keyPath, expectedStore.keyPath) ||
				actualStore.indexNames.length !== 0
			) {
				return false;
			}
			return true;
		});
	} catch {
		return false;
	}
}

function createStores(
	database: IDBDatabase,
	stores: readonly Readonly<{
		autoIncrement: false;
		indexes: readonly never[];
		keyPath: string | readonly string[];
		name: string;
	}>[]
): void {
	for (const storeAuthority of stores) {
		database.createObjectStore(storeAuthority.name, {
			autoIncrement: storeAuthority.autoIncrement,
			keyPath: copyKeyPath(storeAuthority.keyPath),
		});
	}
}

function randomIncarnation(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyKeyPath(keyPath: string | readonly string[]): string | string[] {
	return typeof keyPath === "string" ? keyPath : [...keyPath];
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

function openDatabase(databaseName: string, onVersionChange?: () => void): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, PHASE_5C_SCHEMA_VERSION);
		let blockedTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const clearBlockedTimer = (): void => {
			if (blockedTimer !== undefined) clearTimeout(blockedTimer);
		};
		request.addEventListener(
			"upgradeneeded",
			(event) => {
				const transaction = request.transaction;
				if (settled || transaction === null || (event.oldVersion !== 0 && event.oldVersion !== 1)) {
					request.transaction?.abort();
					return;
				}
				if (event.oldVersion === 0) {
					if (request.result.objectStoreNames.length !== 0) {
						transaction.abort();
						return;
					}
					createStores(request.result, PHASE_5C_SCHEMA_AUTHORITY.stores);
				} else {
					if (!hasExactSchema(request.result, PHASE_2D_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
					createStores(request.result, PHASE_5C_SCHEMA_AUTHORITY.stores.slice(PHASE_2D_SCHEMA_AUTHORITY.stores.length));
				}
				transaction.objectStore(PHASE_5C_STORAGE_META_STORE).add({ key: "incarnation", value: randomIncarnation() });
			},
			{ once: true }
		);
		request.addEventListener(
			"blocked",
			() => {
				blockedTimer ??= setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new BrowserStorageBlockedError());
				}, PHASE_5C_BLOCKED_OPEN_TIMEOUT_MILLISECONDS);
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
				const database = request.result;
				if (settled) {
					database.close();
					return;
				}
				if (!hasExactSchema(database, PHASE_5C_SCHEMA_AUTHORITY)) {
					database.close();
					settled = true;
					clearBlockedTimer();
					reject(new BrowserStorageSchemaError());
					return;
				}
				database.addEventListener("versionchange", () => {
					database.close();
					onVersionChange?.();
				});
				settled = true;
				clearBlockedTimer();
				resolve(database);
			},
			{ once: true }
		);
	});
}

/**
 * Opens the private data-owner connection without exposing a native IDB type.
 * @param options - Isolated database and accepted decision binding.
 * @param onVersionChange - Synchronous owner callback that closes its lifecycle.
 * @returns The schema-validated connection as an owner-local opaque value.
 * @internal
 */
export async function openPhase2dInternalDatabase(
	options: OpenPhase2dBrowserDatabaseOptions,
	onVersionChange: () => void
): Promise<unknown> {
	requireAcceptedDecision(options.testOnlyDecisionBinding ?? PHASE_2D_STORAGE_DECISION);
	return openDatabase(options.databaseName, onVersionChange);
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
