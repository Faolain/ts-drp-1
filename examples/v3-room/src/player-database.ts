import { hashDomain } from "@ts-drp/canonical";

/**
 * Owner decision A (2026-10-28): one room database per player.
 *
 * The node assumes one writing author per room database. The shipped pages named a room's
 * database by its objectId alone, so two identity slots of one browser origin (several authors,
 * Web Lock slots) shared one database, and both their installs and a slot handover failed
 * (RED 2725235d). Every room database is now named by room and author, under a new domain tag.
 *
 * A device that used the shared (v1) database migrates it once, before the room opens
 * (migrateV3RoomPlayerDatabase), under a Web Lock on the shared name:
 * - "claimed": only this author has issuance rows there. Every database of the room is copied
 *   whole under the player's name: the same schema, records and keys.
 * - "claimed-filtered": other authors have issuance rows there too (two slots wrote; the node
 *   already refuses that layout). The copy keeps the room's AHE, snapshots and journal, as a device
 *   that received the other authors' vertices holds them: their issuance rows (lineage, issued,
 *   outbox, settlement plan) are dropped and each of their local journal rows becomes the received
 *   row of the same signed vertex. Their rows stay theirs: each of them migrates its own copy.
 * - "fresh": this author has no issuance rows there. Nothing is copied: it never signed in this
 *   room on this device, and it catches up from the room (decision B, sync before sending).
 * - "present": the player's database already exists (migrated, or opened new). Nothing changes.
 *
 * Crash safety: the shared databases are only read, never changed or deleted, so they stay the
 * source of truth until the copy is complete. A pending marker database is created before the first
 * copy and deleted after the last one; each database is copied in its own version-change
 * transaction (it exists complete or not at all). A run that finds the marker deletes the player's
 * databases and copies again; a run that finds a player's database and no marker changes nothing.
 * The room layout keeps all owners in one database, so its copy is a single transaction.
 */
export type V3RoomPlayerDatabaseApplication = "chat" | "canvas" | "zone";

const PREFIX: Readonly<Record<V3RoomPlayerDatabaseApplication, string>> = Object.freeze({
	chat: "ts-drp-v3-chat--",
	canvas: "ts-drp-v3-canvas--",
	zone: "ts-drp-v3-zone--",
});
const LEGACY_DOMAIN: Readonly<Record<V3RoomPlayerDatabaseApplication, string>> = Object.freeze({
	chat: "ts-drp/chat-database/v1",
	canvas: "ts-drp/canvas-database/v1",
	zone: "ts-drp/d9346-zone-database/v1",
});
const PLAYER_DOMAIN: Readonly<Record<V3RoomPlayerDatabaseApplication, string>> = Object.freeze({
	chat: "ts-drp/chat-database/v2",
	canvas: "ts-drp/canvas-database/v2",
	zone: "ts-drp/d9346-zone-database/v2",
});

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The room database of one player: room and author, domain-separated (v2).
 * @param input - The application, room and author (public key hex).
 * @returns The database name.
 */
export function v3RoomPlayerDatabaseName(
	input: Readonly<{ application: V3RoomPlayerDatabaseApplication; objectId: string; author: string }>
): string {
	return (
		PREFIX[input.application] +
		hex(hashDomain(PLAYER_DOMAIN[input.application], new TextEncoder().encode(`${input.objectId}\u0000${input.author}`)))
	);
}

/**
 * The shared (objectId-only, v1) room database name the pages used before decision A.
 * @param input - The application and room.
 * @returns The legacy database name.
 */
export function v3RoomLegacyDatabaseName(
	input: Readonly<{ application: V3RoomPlayerDatabaseApplication; objectId: string }>
): string {
	return PREFIX[input.application] + hex(hashDomain(LEGACY_DOMAIN[input.application], new TextEncoder().encode(input.objectId)));
}

// Every database a room's name `N` can own on the browser hosts: the room database (or the six
// layout's signing/seal database) and the six layout's AHE, journal, snapshot and issuance databases.
const SUFFIXES = ["", "--ahe", "--drp-live-journal-v1", "--drp-snapshot-quarantine-v1", "--drp-issuance-v1"] as const;
const PENDING_SUFFIX = "--player-migration-pending";
const ISSUANCE_STORES = new Set(["lineages", "issuedRecords", "issuanceOutbox", "settlementPlans"]);
const JOURNAL_ENTRIES = "acceptedEntries";

export type V3RoomPlayerDatabaseMigration = Readonly<{
	kind: "present" | "fresh" | "claimed" | "claimed-filtered";
	/** Authors with issuance rows for the room in the shared database (empty unless read). */
	writers: readonly string[];
	/** Databases copied, by player name. */
	copied: readonly string[];
}>;

/** A shared database the migration cannot copy faithfully; it changed nothing. */
export class V3RoomPlayerDatabaseMigrationUnavailable extends Error {
	readonly code = "V3_ROOM_PLAYER_DATABASE_MIGRATION_UNAVAILABLE";
	constructor(detail: string) {
		super(`V3_ROOM_PLAYER_DATABASE_MIGRATION_UNAVAILABLE: ${detail}`);
		this.name = "V3RoomPlayerDatabaseMigrationUnavailable";
	}
}

type StoreSchema = Readonly<{
	name: string;
	keyPath: string | string[] | null;
	autoIncrement: boolean;
	indexes: readonly Readonly<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>[];
}>;
type DatabaseImage = Readonly<{
	name: string;
	version: number;
	stores: readonly StoreSchema[];
	records: Map<string, { key: IDBValidKey; value: unknown }[]>;
}>;

const factory = (): IDBFactory => {
	const value = Reflect.get(globalThis, "indexedDB") as IDBFactory | undefined;
	if (value === undefined) throw new V3RoomPlayerDatabaseMigrationUnavailable("IndexedDB is unavailable");
	return value;
};

function request<T>(selected: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		selected.onsuccess = (): void => resolve(selected.result);
		selected.onerror = (): void => reject(selected.error ?? new Error("IndexedDB request failed"));
	});
}

/** Opens an existing database without creating it; undefined when it does not exist. */
function openExisting(name: string): Promise<IDBDatabase | undefined> {
	return new Promise((resolve, reject) => {
		let absent = false;
		const opening = factory().open(name);
		opening.onupgradeneeded = (event): void => {
			if (event.oldVersion !== 0) return;
			absent = true;
			opening.transaction?.abort();
		};
		opening.onsuccess = (): void => resolve(opening.result);
		opening.onerror = (): void => {
			if (absent) resolve(undefined);
			else reject(opening.error ?? new Error("IndexedDB open failed"));
		};
		opening.onblocked = (): void => reject(new V3RoomPlayerDatabaseMigrationUnavailable(`${name} is blocked`));
	});
}

async function exists(name: string): Promise<boolean> {
	const database = await openExisting(name);
	database?.close();
	return database !== undefined;
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const deleting = factory().deleteDatabase(name);
		deleting.onsuccess = (): void => resolve();
		deleting.onerror = (): void => reject(deleting.error ?? new Error("IndexedDB delete failed"));
		deleting.onblocked = (): void => reject(new V3RoomPlayerDatabaseMigrationUnavailable(`${name} delete is blocked`));
	});
}

/** One read-only transaction over every store: a consistent image of the database. */
async function readImage(name: string): Promise<DatabaseImage | undefined> {
	const database = await openExisting(name);
	if (database === undefined) return undefined;
	try {
		const names = Array.from(database.objectStoreNames);
		const records = new Map<string, { key: IDBValidKey; value: unknown }[]>();
		const stores: StoreSchema[] = [];
		if (names.length > 0) {
			const transaction = database.transaction(names, "readonly");
			for (const storeName of names) {
				const store = transaction.objectStore(storeName);
				const keyPath = store.keyPath as string | string[] | null;
				stores.push(
					Object.freeze({
						name: storeName,
						keyPath: Array.isArray(keyPath) ? [...keyPath] : keyPath,
						autoIncrement: store.autoIncrement,
						indexes: Array.from(store.indexNames, (indexName) => {
							const index = store.index(indexName);
							const indexKeyPath = index.keyPath as string | string[];
							return Object.freeze({
								name: indexName,
								keyPath: Array.isArray(indexKeyPath) ? [...indexKeyPath] : indexKeyPath,
								unique: index.unique,
								multiEntry: index.multiEntry,
							});
						}),
					})
				);
				const rows: { key: IDBValidKey; value: unknown }[] = [];
				records.set(storeName, rows);
				const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
				if (keys.length !== values.length) throw new V3RoomPlayerDatabaseMigrationUnavailable(`${name} changed while read`);
				for (let index = 0; index < keys.length; index++) rows.push({ key: keys[index]!, value: values[index] });
			}
		}
		return Object.freeze({ name, version: database.version, stores: Object.freeze(stores), records });
	} finally {
		database.close();
	}
}

/** Creates `name` at the image's version with its exact schema and records, in one version change. */
function writeImage(name: string, image: DatabaseImage): Promise<void> {
	return new Promise((resolve, reject) => {
		let refused: Error | undefined;
		const opening = factory().open(name, image.version);
		opening.onupgradeneeded = (event): void => {
			const transaction = opening.transaction;
			if (transaction === null) return;
			if (event.oldVersion !== 0) {
				refused = new V3RoomPlayerDatabaseMigrationUnavailable(`${name} already exists`);
				transaction.abort();
				return;
			}
			try {
				for (const schema of image.stores) {
					const store = opening.result.createObjectStore(schema.name, {
						keyPath: schema.keyPath,
						autoIncrement: schema.autoIncrement,
					});
					for (const index of schema.indexes)
						store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
					const inline = schema.keyPath !== null;
					for (const row of image.records.get(schema.name) ?? [])
						if (inline) store.add(row.value);
						else store.add(row.value, row.key);
				}
			} catch (error) {
				refused = error instanceof Error ? error : new Error(String(error));
				transaction.abort();
			}
		};
		opening.onsuccess = (): void => {
			opening.result.close();
			resolve();
		};
		opening.onerror = (): void => reject(refused ?? opening.error ?? new Error("IndexedDB copy failed"));
		opening.onblocked = (): void => reject(new V3RoomPlayerDatabaseMigrationUnavailable(`${name} is blocked`));
	});
}

const logical = (storeName: string): string => storeName.slice(storeName.indexOf(":") + 1);
const field = (value: unknown, key: string): unknown =>
	value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;

/** Authors with issuance rows for `objectId` in the images. */
function issuanceWriters(images: readonly DatabaseImage[], objectId: string): string[] {
	const writers = new Set<string>();
	for (const image of images)
		for (const [storeName, rows] of image.records) {
			if (!ISSUANCE_STORES.has(logical(storeName))) continue;
			for (const { value } of rows)
				if (field(value, "objectId") === objectId && typeof field(value, "author") === "string")
					writers.add(field(value, "author") as string);
		}
	return [...writers].sort();
}

/**
 * Drops the other authors' issuance rows of `objectId` and turns their local journal rows into the
 * received rows of the same signed vertices (the bytes and signature their issued records hold).
 */
function filterImages(images: readonly DatabaseImage[], objectId: string, author: string): void {
	const signed = new Map<string, { preimage: Uint8Array; signature: Uint8Array }>();
	for (const image of images)
		for (const [storeName, rows] of image.records) {
			if (logical(storeName) !== "issuedRecords") continue;
			for (const { value } of rows) {
				const preimage = field(value, "canonicalPreimageBytes");
				const signature = field(value, "signature");
				if (preimage instanceof Uint8Array && signature instanceof Uint8Array)
					signed.set(JSON.stringify([field(value, "objectId"), field(value, "author"), field(value, "authorSequence")]), {
						preimage,
						signature,
					});
			}
		}
	for (const image of images)
		for (const [storeName, rows] of image.records) {
			const name = logical(storeName);
			if (name === JOURNAL_ENTRIES) {
				for (const row of rows) {
					const value = row.value;
					if (field(value, "objectId") !== objectId || field(value, "sourceKind") !== "local-issued") continue;
					const local = field(value, "localAuthor");
					if (local === author) continue;
					const vertex = signed.get(JSON.stringify([objectId, local, field(value, "localAuthorSequence")]));
					if (vertex === undefined)
						throw new V3RoomPlayerDatabaseMigrationUnavailable(
							`another author's journal row ${String(field(value, "journalSequence"))} has no issued record`
						);
					row.value = {
						anchorDigest: field(value, "anchorDigest"),
						detachedSignature: vertex.signature,
						epoch: field(value, "epoch"),
						exactCanonicalPreimageBytes: vertex.preimage,
						journalSequence: field(value, "journalSequence"),
						objectId,
						sourceKind: "received",
						vertexDigest: field(value, "vertexDigest"),
					};
				}
				continue;
			}
			if (!ISSUANCE_STORES.has(name)) continue;
			const kept = rows.filter(({ value }) => field(value, "objectId") !== objectId || field(value, "author") === author);
			rows.splice(0, rows.length, ...kept);
		}
}

/** Serializes the migration of one shared database across this origin's tabs. */
async function withMigrationLock<T>(legacyName: string, action: () => Promise<T>): Promise<T> {
	const locks = Reflect.get(globalThis.navigator ?? {}, "locks") as LockManager | undefined;
	if (locks === undefined) return action();
	return locks.request(`ts-drp-v3-room-player-migration:${legacyName}`, { mode: "exclusive" }, action) as Promise<T>;
}

/**
 * Migrates the shared room database into this player's database, once (see the module comment).
 * @param input - The shared and player names, the room and this author; `testHooks.afterWrite`
 * runs after each copied database commits (a throw there is a crash before the migration ends).
 * @returns What it did.
 */
export async function migrateV3RoomPlayerDatabase(
	input: Readonly<{
		legacyName: string;
		playerName: string;
		objectId: string;
		author: string;
		testHooks?: Readonly<{ afterWrite?(database: string): void }>;
	}>
): Promise<V3RoomPlayerDatabaseMigration> {
	const { legacyName, playerName, objectId, author } = input;
	if (legacyName === playerName) throw new TypeError("v3 room player database must differ from the shared database");
	return withMigrationLock(legacyName, async () => {
		const pending = `${playerName}${PENDING_SUFFIX}`;
		const targets = SUFFIXES.map((suffix) => `${playerName}${suffix}`);
		if (await exists(pending)) {
			// A torn copy: the shared databases are intact, so start over.
			for (const target of targets) await deleteDatabase(target);
		} else {
			for (const target of targets)
				if (await exists(target)) return Object.freeze({ kind: "present", writers: Object.freeze([]), copied: Object.freeze([]) });
		}
		const images: DatabaseImage[] = [];
		for (const suffix of SUFFIXES) {
			const image = await readImage(`${legacyName}${suffix}`);
			if (image !== undefined) images.push(image);
		}
		const writers = Object.freeze(issuanceWriters(images, objectId));
		if (!writers.includes(author)) {
			if (await exists(pending)) await deleteDatabase(pending);
			return Object.freeze({ kind: "fresh", writers, copied: Object.freeze([]) });
		}
		const kind = writers.length === 1 ? "claimed" : "claimed-filtered";
		if (kind === "claimed-filtered") filterImages(images, objectId, author);
		if (!(await exists(pending))) await writeImage(pending, Object.freeze({ name: pending, version: 1, stores: [], records: new Map() }));
		const copied: string[] = [];
		for (const image of images) {
			const target = `${playerName}${image.name.slice(legacyName.length)}`;
			await writeImage(target, image);
			copied.push(target);
			input.testHooks?.afterWrite?.(target);
		}
		await deleteDatabase(pending);
		return Object.freeze({ kind, writers, copied: Object.freeze(copied) });
	});
}

/**
 * The page's room database: migrates the shared (v1) database once, then names the player's own.
 * @param input - The application, room and this page's author.
 * @returns The player's database name and what the migration did.
 */
export async function prepareV3RoomPlayerDatabase(
	input: Readonly<{ application: V3RoomPlayerDatabaseApplication; objectId: string; author: string }>
): Promise<Readonly<{ databaseName: string; migration: V3RoomPlayerDatabaseMigration }>> {
	const databaseName = v3RoomPlayerDatabaseName(input);
	const migration = await migrateV3RoomPlayerDatabase({
		legacyName: v3RoomLegacyDatabaseName(input),
		playerName: databaseName,
		objectId: input.objectId,
		author: input.author,
	});
	return Object.freeze({ databaseName, migration });
}
