import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

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

const PHASE_5C_LEGACY_SCHEMA_AUTHORITY = Object.freeze({
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

export const PHASE_5C_SCHEMA_AUTHORITY = Object.freeze({
	stores: Object.freeze([
		...PHASE_5C_LEGACY_SCHEMA_AUTHORITY.stores,
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "sealEvidence",
		}),
	]),
	version: 3,
} as const);

export const PHASE_5E_SCHEMA_AUTHORITY = PHASE_5C_SCHEMA_AUTHORITY;

// Same native stores; v4 gives storageMeta addressed local-control semantics.
export const AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY = Object.freeze({
	stores: PHASE_5E_SCHEMA_AUTHORITY.stores,
	version: 4,
} as const);
// Same stores; v5 fences obsolete signing writers before a permanent round
// frontier can be persisted in an existing signerState row.
export const SIGNING_FRONTIER_SCHEMA_AUTHORITY = Object.freeze({
	stores: AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY.stores,
	version: 5,
} as const);
// Same stores; v6 closes v5 writers which do not inspect addressed signing intents.
export const SIGNING_PARTICIPANT_SCHEMA_AUTHORITY = Object.freeze({
	stores: SIGNING_FRONTIER_SCHEMA_AUTHORITY.stores,
	version: 6,
} as const);
export const CURRENT_BROWSER_SCHEMA_VERSION = SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.version;

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
export const PHASE_5E_SCHEMA_VERSION = PHASE_5E_SCHEMA_AUTHORITY.version;
export const PHASE_5E_SEAL_EVIDENCE_STORE = "sealEvidence" as const;

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
	authority:
		| typeof PHASE_2D_SCHEMA_AUTHORITY
		| typeof PHASE_5C_LEGACY_SCHEMA_AUTHORITY
		| typeof PHASE_5C_SCHEMA_AUTHORITY
		| typeof PHASE_5E_SCHEMA_AUTHORITY
		| typeof AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY
		| typeof SIGNING_FRONTIER_SCHEMA_AUTHORITY
		| typeof SIGNING_PARTICIPANT_SCHEMA_AUTHORITY,
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

/**
 * Validates the live original native catalog inside the caller's transaction.
 * @param transaction
 */
export function assertCurrentBrowserSchema(transaction: IDBTransaction): void {
	const room = roomConnections.get(transaction.db);
	if (room !== undefined) {
		const exact =
			transaction.db.version === ROOM_DATABASE_VERSION &&
			(room === "all"
				? exactRoomCatalog(transaction.db, transaction)
				: exactRoomStores(transaction.db, ROOM_NAMESPACE_STORES[room], transaction));
		if (!exact) throw new BrowserStorageSchemaError();
		return;
	}
	if (!hasExactSchema(transaction.db, SIGNING_PARTICIPANT_SCHEMA_AUTHORITY, transaction)) {
		throw new BrowserStorageSchemaError();
	}
}

/**
 * Store set for one schema-checked AHE local-control transaction, not cross-DB custody.
 * @param database - The AHE connection; a room connection names only the AHE namespace.
 * @returns The physical store names.
 */
export function browserAheControlStores(database?: IDBDatabase): string[] {
	if (database !== undefined && roomConnections.has(database)) return ROOM_AHE_STORES.map((store) => store.name);
	return AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY.stores.map((store) => store.name);
}

function validLegacyIncarnation(row: unknown): boolean {
	if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
	const descriptors = Object.getOwnPropertyDescriptors(row);
	const key = descriptors.key,
		value = descriptors.value;
	return (
		Reflect.ownKeys(descriptors).length === 2 &&
		key !== undefined &&
		"value" in key &&
		key.value === "incarnation" &&
		value !== undefined &&
		"value" in value &&
		typeof value.value === "string" &&
		/^[0-9a-f]{32}$/u.test(value.value)
	);
}

// No native control existed in the supported legacy versions. Unknown metadata,
// including a pre-populated kind1/kind2 namespace, is not migration entitlement.
function validateEmptyControlMigration(transaction: IDBTransaction): void {
	const request = transaction.objectStore(PHASE_5C_STORAGE_META_STORE).getAll(undefined, 2);
	request.addEventListener(
		"success",
		() => {
			if (request.result.length !== 1 || !validLegacyIncarnation(request.result[0])) transaction.abort();
		},
		{ once: true }
	);
}

// Legacy writers never owned this field. Preserve all legacy bytes, but do not
// adopt a seeded frontier as native retirement authority during migration.
function validateNoLegacySigningFrontier(transaction: IDBTransaction): void {
	const cursor = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE).openCursor();
	cursor.addEventListener("success", () => {
		const row = cursor.result;
		if (row === null) return;
		if (typeof row.value !== "object" || row.value === null || Object.hasOwn(row.value, "retiredBeforeRound")) {
			transaction.abort();
			return;
		}
		row.continue();
	});
}

// A v5 writer did not own the new namespace. Preserve legitimate round floors
// and existing AHE metadata byte-for-byte; do not adopt a seeded signing intent.
function validateNoLegacySigningControl(transaction: IDBTransaction): void {
	const request = transaction.objectStore(PHASE_5C_STORAGE_META_STORE).openKeyCursor();
	request.onsuccess = (): void => {
		const cursor = request.result;
		if (cursor === null) return;
		if (typeof cursor.key !== "string" || cursor.key.startsWith("signing-retirement:")) {
			transaction.abort();
			return;
		}
		cursor.continue();
	};
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
		const request = indexedDB.open(databaseName, CURRENT_BROWSER_SCHEMA_VERSION);
		let blockedTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const clearBlockedTimer = (): void => {
			if (blockedTimer !== undefined) clearTimeout(blockedTimer);
		};
		request.addEventListener(
			"upgradeneeded",
			(event) => {
				const transaction = request.transaction;
				if (
					settled ||
					transaction === null ||
					(event.oldVersion !== 0 &&
						event.oldVersion !== 1 &&
						event.oldVersion !== 2 &&
						event.oldVersion !== 3 &&
						event.oldVersion !== 4 &&
						event.oldVersion !== 5)
				) {
					request.transaction?.abort();
					return;
				}
				if (event.oldVersion === 0) {
					if (request.result.objectStoreNames.length !== 0) {
						transaction.abort();
						return;
					}
					createStores(request.result, PHASE_5E_SCHEMA_AUTHORITY.stores);
					transaction.objectStore(PHASE_5C_STORAGE_META_STORE).add({
						key: "incarnation",
						value: randomIncarnation(),
					});
				} else if (event.oldVersion === 1) {
					if (!hasExactSchema(request.result, PHASE_2D_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
					createStores(request.result, PHASE_5E_SCHEMA_AUTHORITY.stores.slice(PHASE_2D_SCHEMA_AUTHORITY.stores.length));
					transaction.objectStore(PHASE_5C_STORAGE_META_STORE).add({
						key: "incarnation",
						value: randomIncarnation(),
					});
				} else if (event.oldVersion === 2) {
					if (!hasExactSchema(request.result, PHASE_5C_LEGACY_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
					createStores(
						request.result,
						PHASE_5E_SCHEMA_AUTHORITY.stores.slice(PHASE_5C_LEGACY_SCHEMA_AUTHORITY.stores.length)
					);
					validateEmptyControlMigration(transaction);
				} else if (event.oldVersion === 3) {
					if (!hasExactSchema(request.result, PHASE_5E_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
					validateEmptyControlMigration(transaction);
				} else if (event.oldVersion === 4) {
					if (!hasExactSchema(request.result, AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
					// Existing addressed AHE controls/debt are preserved, not reclassified.
				} else {
					if (!hasExactSchema(request.result, SIGNING_FRONTIER_SCHEMA_AUTHORITY, transaction, true)) {
						transaction.abort();
						return;
					}
				}
				if (event.oldVersion !== 0 && event.oldVersion <= 4) validateNoLegacySigningFrontier(transaction);
				if (event.oldVersion >= 4) validateNoLegacySigningControl(transaction);
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
				if (!hasExactSchema(database, SIGNING_PARTICIPANT_SCHEMA_AUTHORITY)) {
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

// ---------------------------------------------------------------------------
// Room database (slice 14a): the main database `N` at version 7 hosts every
// browser retention owner in a disjoint store namespace. Only this module
// creates or upgrades it; owners open it at exactly version 7 and never upgrade.
// ---------------------------------------------------------------------------

export const ROOM_DATABASE_VERSION = 7;
/** Owners that live in the room database. Signing keeps the unprefixed version-6 store names. */
export type RoomNamespace = "ahe" | "issuance" | "journal" | "signing" | "snapshot";
type RoomIndexAuthority = Readonly<{ name: string; keyPath: string | readonly string[]; unique: boolean }>;
type RoomStoreAuthority = Readonly<{
	name: string;
	keyPath: string | readonly string[] | null;
	indexes: readonly RoomIndexAuthority[];
}>;
const roomStore = (
	name: string,
	keyPath: string | readonly string[] | null,
	indexes: readonly RoomIndexAuthority[] = []
): RoomStoreAuthority => Object.freeze({ name, keyPath, indexes: Object.freeze(indexes) });
const ROOM_AHE_STORES = Object.freeze(
	AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY.stores
		.filter((store) =>
			[
				PHASE_2D_OBJECTS_STORE,
				PHASE_2D_GENERATIONS_STORE,
				PHASE_2D_BLOBS_STORE,
				PHASE_2D_PROMOTIONS_STORE,
				PHASE_5C_STORAGE_META_STORE,
			].includes(store.name as never)
		)
		.map((store) => roomStore(`ahe:${store.name}`, store.keyPath))
);
const ROOM_NAMESPACE_STORES: Readonly<Record<RoomNamespace, readonly RoomStoreAuthority[]>> = Object.freeze({
	ahe: ROOM_AHE_STORES,
	// Signing owns the whole version-6 catalog of `N`, as before; its legacy AHE-named
	// stores stay empty in room mode. Its transactions keep their version-6 scopes.
	signing: Object.freeze(
		SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.stores.map((store) => roomStore(store.name, store.keyPath))
	),
	snapshot: Object.freeze([
		roomStore(
			"snapshot:scopes",
			["objectId", "epoch", "anchor", "manifestDigest"],
			[{ name: "expiryAsc", keyPath: "expiresAt", unique: false }]
		),
		roomStore("snapshot:chunks", ["objectId", "epoch", "anchor", "manifestDigest", "index"]),
		roomStore("snapshot:owner", "id"),
		roomStore("snapshot:retirementControls", null),
	]),
	journal: Object.freeze([
		roomStore("journal:scopes", ["objectId", "epoch", "anchorDigest"]),
		roomStore(
			"journal:acceptedEntries",
			["objectId", "epoch", "anchorDigest", "journalSequence"],
			[
				{ name: "digestUniq", keyPath: ["objectId", "epoch", "anchorDigest", "vertexDigest"], unique: true },
				{
					name: "localRefUniq",
					keyPath: ["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"],
					unique: true,
				},
			]
		),
		roomStore("journal:retirementControls", "objectId"),
	]),
	issuance: Object.freeze([
		roomStore("issuance:lineages", ["objectId", "author"]),
		roomStore("issuance:settlementPlans", ["objectId", "author"]),
		roomStore("issuance:issuedRecords", ["objectId", "author", "authorSequence"]),
		roomStore("issuance:issuanceOutbox", ["objectId", "author", "authorSequence"]),
		roomStore("issuance:retirementControls", "objectId"),
	]),
});
const ROOM_LAYOUT_STORE = "room:layout";
/** Every store of the version-7 room database: version 6 (signing plus the unused legacy AHE stores), the namespaces and the layout. */
const ROOM_CATALOG: readonly RoomStoreAuthority[] = Object.freeze([
	...SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.stores.map((store) => roomStore(store.name, store.keyPath)),
	...ROOM_NAMESPACE_STORES.ahe,
	...ROOM_NAMESPACE_STORES.snapshot,
	...ROOM_NAMESPACE_STORES.journal,
	...ROOM_NAMESPACE_STORES.issuance,
	roomStore(ROOM_LAYOUT_STORE, null),
]);
const ROOM_LAYOUT_KEY = "layout",
	ROOM_READY_KEY = "ready";
const ROOM_LAYOUT_LIMITS = Object.freeze({ maxBytes: 65_536, maxItems: 1_024, maxDepth: 8 });
const roomLayoutBytes = (): Uint8Array =>
	encodeCanonical({ version: 1, kind: "room-database-layout-1" }, ROOM_LAYOUT_LIMITS);
/** Ready record. `sources` lists the migrated legacy databases (slice 14d); empty for a room created at version 7. */
export function roomReadyRecordBytes(
	sources: readonly Readonly<{ database: string; fencedVersion: number; receiptDigest: string }>[]
): Uint8Array {
	return encodeCanonical(
		{
			version: 1,
			kind: "room-database-ready-1",
			sources: sources.map((source) => ({
				database: source.database,
				fencedVersion: source.fencedVersion,
				receiptDigest: source.receiptDigest,
			})),
		},
		ROOM_LAYOUT_LIMITS
	);
}

// Keyed by the connection object; typed `object` so no raw IDB type is a receiver here.
const roomConnections = new WeakMap<object, RoomNamespace | "all">();

/**
 * Physical store name of an owner's logical store on this connection.
 * @param database - The owner's connection (legacy connections are not registered).
 * @param namespace - The owner's own namespace.
 * @param logical - The owner's version-6/legacy store name.
 * @returns The namespaced name on a room connection, else the logical name.
 */
export function roomStoreName(database: IDBDatabase, namespace: RoomNamespace, logical: string): string {
	return roomConnections.has(database) && namespace !== "signing" ? `${namespace}:${logical}` : logical;
}

/**
 * Physical names of several of an owner's logical stores on this connection.
 * @param database - The owner's connection.
 * @param namespace - The owner's own namespace.
 * @param logical - The owner's logical store names.
 * @returns The physical store names, in the same order.
 */
export function roomStoreNames(database: IDBDatabase, namespace: RoomNamespace, logical: readonly string[]): string[] {
	return logical.map((name) => roomStoreName(database, namespace, name));
}

/**
 * Logical name of a store seen through an owner's namespace.
 * @param namespace - The owner's own namespace.
 * @param physical - The physical store name.
 * @returns The name without its namespace prefix.
 */
export function roomLogicalStoreName(namespace: RoomNamespace, physical: string): string {
	return physical.startsWith(`${namespace}:`) ? physical.slice(namespace.length + 1) : physical;
}

/** True when the connection was opened by this module as a room-database connection. */
export function isRoomConnection(database: IDBDatabase): boolean {
	return roomConnections.has(database);
}

/**
 * Stores a held read view of this connection covers. A room owner's view
 * covers only its own namespace, so it never blocks another owner's writer.
 * @param database - Any owner connection.
 * @returns The store names for a whole-owner readonly view.
 */
export function roomOwnerStoreNames(database: IDBDatabase): string[] {
	const namespace = roomConnections.get(database);
	if (namespace === undefined || namespace === "all") return Array.from(database.objectStoreNames);
	return ROOM_NAMESPACE_STORES[namespace].map((store) => store.name);
}

function exactRoomStores(
	database: IDBDatabase,
	stores: readonly RoomStoreAuthority[],
	transaction: IDBTransaction
): boolean {
	try {
		return stores.every((expected) => {
			if (!database.objectStoreNames.contains(expected.name)) return false;
			const actual = transaction.objectStore(expected.name);
			if (
				actual.autoIncrement ||
				!exactKeyPath(actual.keyPath, expected.keyPath) ||
				actual.indexNames.length !== expected.indexes.length
			)
				return false;
			return expected.indexes.every((index) => {
				if (!actual.indexNames.contains(index.name)) return false;
				const native = actual.index(index.name);
				return exactKeyPath(native.keyPath, index.keyPath) && native.unique === index.unique && !native.multiEntry;
			});
		});
	} catch {
		return false;
	}
}

function exactRoomCatalog(database: IDBDatabase, transaction: IDBTransaction): boolean {
	return (
		database.version === ROOM_DATABASE_VERSION &&
		database.objectStoreNames.length === ROOM_CATALOG.length &&
		exactRoomStores(database, ROOM_CATALOG, transaction)
	);
}

function equalRoomBytes(left: unknown, right: Uint8Array): boolean {
	return (
		left instanceof Uint8Array && left.length === right.length && left.every((byte, index) => byte === right[index])
	);
}

/** Reads the layout records. Undefined when they are not exact; a corrupt layout is never repaired. */
function readRoomLayout(transaction: IDBTransaction): Promise<"ready" | "migrating" | undefined> {
	return new Promise((resolve, reject) => {
		const listed: unknown[] = [],
			rows: unknown[] = [];
		const cursor = transaction.objectStore(ROOM_LAYOUT_STORE).openCursor();
		cursor.addEventListener("success", () => {
			const current = cursor.result;
			// At most two records exist; a third is refused below without reading further.
			if (current !== null && listed.length < 3) {
				listed.push(current.key);
				rows.push(current.value);
				current.continue();
				return;
			}
			{
				if (listed.length === 0 || listed[0] !== ROOM_LAYOUT_KEY) {
					resolve(undefined);
					return;
				}
				if (!equalRoomBytes(rows[0], roomLayoutBytes())) {
					resolve(undefined);
					return;
				}
				if (listed.length === 1) {
					resolve("migrating");
					return;
				}
				if (listed.length !== 2 || listed[1] !== ROOM_READY_KEY || !validRoomReadyRecord(rows[1])) {
					resolve(undefined);
					return;
				}
				resolve("ready");
			}
		});
		cursor.addEventListener("error", () => reject(cursor.error), { once: true });
	});
}

function validRoomReadyRecord(value: unknown): boolean {
	if (!(value instanceof Uint8Array)) return false;
	try {
		const decoded = decodeCanonical(value, ROOM_LAYOUT_LIMITS) as Readonly<Record<string, unknown>>;
		const sources = decoded.sources;
		if (!Array.isArray(sources)) return false;
		return equalRoomBytes(value, roomReadyRecordBytes(sources as never));
	} catch {
		return false;
	}
}

function createRoomStores(database: IDBDatabase, stores: readonly RoomStoreAuthority[]): void {
	for (const authority of stores) {
		const store = database.createObjectStore(authority.name, {
			autoIncrement: false,
			...(authority.keyPath === null ? {} : { keyPath: copyKeyPath(authority.keyPath) }),
		});
		for (const index of authority.indexes)
			store.createIndex(index.name, copyKeyPath(index.keyPath), { unique: index.unique, multiEntry: false });
	}
}

function openRoom(
	databaseName: string,
	upgrade: ((event: IDBVersionChangeEvent, request: IDBOpenDBRequest) => void) | undefined,
	onVersionChange?: () => void
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, ROOM_DATABASE_VERSION);
		let blockedTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const clearBlockedTimer = (): void => {
			if (blockedTimer !== undefined) clearTimeout(blockedTimer);
		};
		request.addEventListener(
			"upgradeneeded",
			(event) => {
				if (settled || request.transaction === null || upgrade === undefined) {
					request.transaction?.abort();
					return;
				}
				try {
					upgrade(event, request);
				} catch {
					request.transaction.abort();
				}
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
				settled = true;
				clearBlockedTimer();
				database.addEventListener("versionchange", () => {
					database.close();
					onVersionChange?.();
				});
				resolve(database);
			},
			{ once: true }
		);
	});
}

function roomTransactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("room transaction aborted")), {
			once: true,
		});
	});
}

/**
 * Creates or upgrades the room database to version 7. From version 0 it writes the
 * version-6 stores, both incarnations and a ready layout; from an exact version 6 it
 * adds the namespaces and a migrating layout, keeping every version-6 row. Any other
 * version or catalog refuses with zero changes.
 * @param input - The room database name.
 * @param input.databaseName
 * @returns The layout state; owners open only a ready room database.
 */
export async function prepareBrowserRoomDatabase(
	input: Readonly<{ databaseName: string }>
): Promise<Readonly<{ state: "ready" | "migrating" }>> {
	const databaseName = input.databaseName;
	if (typeof databaseName !== "string" || databaseName.length === 0) throw new TypeError("INVALID_ARGUMENT");
	const database = await openRoom(databaseName, (event, request) => {
		const transaction = request.transaction!;
		const created = request.result;
		if (event.oldVersion === 0) {
			if (created.objectStoreNames.length !== 0) throw new BrowserStorageSchemaError();
			createStores(created, PHASE_5E_SCHEMA_AUTHORITY.stores);
			transaction.objectStore(PHASE_5C_STORAGE_META_STORE).add({ key: "incarnation", value: randomIncarnation() });
		} else if (
			event.oldVersion !== SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.version ||
			!hasExactSchema(created, SIGNING_PARTICIPANT_SCHEMA_AUTHORITY, transaction, true)
		)
			throw new BrowserStorageSchemaError();
		createRoomStores(created, ROOM_CATALOG.slice(SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.stores.length));
		const layout = transaction.objectStore(ROOM_LAYOUT_STORE);
		layout.add(roomLayoutBytes(), ROOM_LAYOUT_KEY);
		if (event.oldVersion === 0) {
			// Nothing to migrate: the AHE namespace gets its own incarnation and the room is ready.
			transaction.objectStore(`ahe:${PHASE_5C_STORAGE_META_STORE}`).add({
				key: "incarnation",
				value: randomIncarnation(),
			});
			layout.add(roomReadyRecordBytes([]), ROOM_READY_KEY);
		}
	});
	try {
		const transaction = database.transaction([...database.objectStoreNames], "readonly");
		const done = roomTransactionDone(transaction);
		if (!exactRoomCatalog(database, transaction)) {
			transaction.abort();
			await done.catch(() => undefined);
			throw new BrowserStorageSchemaError();
		}
		const state = await readRoomLayout(transaction);
		await done;
		if (state === undefined) throw new BrowserStorageSchemaError();
		return Object.freeze({ state });
	} finally {
		database.close();
	}
}

/**
 * Opens one owner's own connection to a ready version-7 room database. Never creates or
 * upgrades it. Checks only the owner's namespace catalog and the ready layout.
 * @param databaseName - The room database name.
 * @param namespace - The owner's namespace.
 * @param onVersionChange - Synchronous owner callback that closes its lifecycle.
 * @returns The registered owner connection; its held views cover only its namespace.
 * @internal
 */
export async function openBrowserRoomOwnerConnection(
	databaseName: string,
	namespace: RoomNamespace | "all",
	onVersionChange?: () => void
): Promise<IDBDatabase> {
	if (typeof databaseName !== "string" || databaseName.length === 0) throw new TypeError("INVALID_ARGUMENT");
	const database = await openRoom(databaseName, undefined, onVersionChange);
	try {
		const stores = namespace === "all" ? ROOM_CATALOG : ROOM_NAMESPACE_STORES[namespace];
		const transaction = database.transaction(
			[...stores.map((store) => store.name), ROOM_LAYOUT_STORE].filter(
				(name, index, names) => names.indexOf(name) === index && database.objectStoreNames.contains(name)
			),
			"readonly"
		);
		const done = roomTransactionDone(transaction);
		const exact =
			database.version === ROOM_DATABASE_VERSION &&
			database.objectStoreNames.contains(ROOM_LAYOUT_STORE) &&
			(namespace === "all" ? exactRoomCatalog(database, transaction) : exactRoomStores(database, stores, transaction));
		if (!exact) {
			transaction.abort();
			await done.catch(() => undefined);
			throw new BrowserStorageSchemaError();
		}
		const state = await readRoomLayout(transaction);
		await done;
		if (state !== "ready") throw new BrowserStorageSchemaError();
		roomConnections.set(database, namespace);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

/**
 * Closes a room connection opened by {@link openBrowserRoomOwnerConnection} for a
 * sibling owner that may not close raw connections itself.
 * @param database - The room connection.
 */
export function closeBrowserRoomConnection(database: IDBDatabase): void {
	database.close();
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
