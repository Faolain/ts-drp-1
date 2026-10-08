import { decodeCanonical } from "@ts-drp/canonical";
import { decodeGenerationRecordV1, decodeHeadRecordV1 } from "@ts-drp/storage";

export interface GridStorageCensusRow {
	readonly database: string;
	readonly store: string;
	readonly epoch: string;
	readonly retentionStatus: string;
	readonly rows: number;
	readonly logicalPayloadBytes: number;
}

export interface GridStorageCensusInput {
	readonly factory: IDBFactory;
	readonly databaseNames: readonly string[];
	readonly currentEpoch: number;
	readonly now: number;
}

interface GenerationMetadata {
	readonly objectId: string;
	readonly state: string;
	readonly parent: string | undefined;
	readonly digests: readonly string[];
}

interface Association {
	readonly epoch: string;
	readonly retentionStatus: string;
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function textField(value: unknown, key: string): string | undefined {
	const selected = field(value, key);
	return typeof selected === "string" ? selected : undefined;
}

function epochOf(value: unknown): string {
	const epoch = field(value, "epoch") ?? field(value, "currentEpoch") ?? field(value, "closedEpoch");
	return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? String(epoch) : "unknown";
}

function carrierEpoch(value: unknown): string {
	if (!(value instanceof Uint8Array)) return "unknown";
	try {
		return epochOf(decodeCanonical(value));
	} catch {
		// Not every stored byte field is a canonical epoch-bearing carrier.
		return "unknown";
	}
}

function key(...parts: unknown[]): string {
	return JSON.stringify(parts);
}

function combinedEpoch(epochs: Iterable<string>): string {
	const unique = new Set(epochs);
	if (unique.has("unknown")) return "unknown";
	if (unique.size > 1) return "shared";
	return unique.values().next().value ?? "unknown";
}

function epochStatus(epoch: string, currentEpoch: number): string {
	if (epoch === "unknown" || epoch === "shared") return epoch;
	const number = Number(epoch);
	return number === currentEpoch ? "current-epoch" : number < currentEpoch ? "closed-epoch" : "future-epoch";
}

/** Logical content only: string values and binary leaves, never numeric size metadata or property names. */
function payloadBytes(value: unknown, seen = new WeakSet<object>()): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (value === null || typeof value !== "object" || seen.has(value)) return 0;
	seen.add(value);
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (value instanceof Map) {
		let bytes = 0;
		for (const [entryKey, entry] of value) bytes += payloadBytes(entryKey, seen) + payloadBytes(entry, seen);
		return bytes;
	}
	if (value instanceof Set) {
		let bytes = 0;
		for (const entry of value) bytes += payloadBytes(entry, seen);
		return bytes;
	}
	let bytes = 0;
	for (const entry of Object.values(value)) bytes += payloadBytes(entry, seen);
	return bytes;
}

function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name);
		let failure: Error | undefined;
		request.onupgradeneeded = (): void => {
			failure = new Error(`GRID_CENSUS_DATABASE_DISAPPEARED:${name}`);
			// A deletion between databases() and open() must not recreate a database.
			request.transaction?.abort();
		};
		request.onblocked = (): void => {
			failure = new Error(`GRID_CENSUS_DATABASE_BLOCKED:${name}`);
			reject(failure);
		};
		request.onerror = (): void => reject(failure ?? request.error ?? new Error(`GRID_CENSUS_OPEN_FAILED:${name}`));
		request.onsuccess = (): void => {
			if (failure !== undefined) {
				request.result.close();
				reject(failure);
			} else resolve(request.result);
		};
	});
}

function transactionDone(transaction: IDBTransaction): Promise<Error | undefined> {
	return new Promise((resolve) => {
		let failure: Error | undefined;
		transaction.onerror = (): void => {
			failure = transaction.error ?? new Error("GRID_CENSUS_TRANSACTION_FAILED");
		};
		transaction.onabort = (): void =>
			resolve(transaction.error ?? failure ?? new Error("GRID_CENSUS_TRANSACTION_ABORTED"));
		transaction.oncomplete = (): void => resolve(failure);
	});
}

function scan(transaction: IDBTransaction, store: string, visit: (value: unknown) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = transaction.objectStore(store).openCursor();
		request.onerror = (): void => reject(request.error ?? new Error(`GRID_CENSUS_CURSOR_FAILED:${store}`));
		request.onsuccess = (): void => {
			try {
				const cursor = request.result;
				if (cursor === null) {
					resolve();
					return;
				}
				visit(cursor.value);
				cursor.continue();
			} catch (error) {
				reject(error);
			}
		};
	});
}

async function censusDatabase(database: IDBDatabase, input: GridStorageCensusInput): Promise<GridStorageCensusRow[]> {
	const names = [...database.objectStoreNames].sort();
	if (names.length === 0) return [];
	const transaction = database.transaction(names, "readonly");
	const done = transactionDone(transaction);
	// These maps contain only detached scalar metadata/digest strings, never cursor rows or bytes.
	const heads = new Map<string, string>();
	const generations = new Map<string, GenerationMetadata>();
	const blobEpochs = new Map<string, string>();
	const blobOwners = new Map<string, Set<string>>();
	const scopes = new Map<string, Association>();
	const issuedEpochs = new Map<string, string>();
	const buckets = new Map<string, GridStorageCensusRow>();
	const ahe = ["objects", "generations", "blobs", "promotions"].every((name) => names.includes(name));
	const quarantine = names.includes("scopes") && names.includes("chunks");
	try {
		if (ahe) {
			await scan(transaction, "objects", (row) => {
				const bytes = field(row, "record");
				if (bytes === null || bytes === undefined) return;
				if (!(bytes instanceof Uint8Array)) throw new Error("GRID_CENSUS_INVALID_HEAD_RECORD");
				const decoded = decodeHeadRecordV1(bytes);
				if (!decoded.ok || decoded.value.objectId !== field(row, "objectId")) {
					throw new Error("GRID_CENSUS_INVALID_HEAD_RECORD");
				}
				if (decoded.value.kind === "present") heads.set(decoded.value.objectId, decoded.value.generationId);
			});
			await scan(transaction, "generations", (row) => {
				const bytes = field(row, "record");
				if (!(bytes instanceof Uint8Array)) throw new Error("GRID_CENSUS_INVALID_GENERATION_RECORD");
				const decoded = decodeGenerationRecordV1(bytes);
				if (
					!decoded.ok ||
					decoded.value.objectId !== field(row, "objectId") ||
					decoded.value.generationId !== field(row, "generationId")
				) {
					throw new Error("GRID_CENSUS_INVALID_GENERATION_RECORD");
				}
				const generation = decoded.value;
				const identity = key(generation.objectId, generation.generationId);
				generations.set(identity, {
					objectId: generation.objectId,
					state: generation.state,
					parent:
						generation.baseExpectedHead.kind === "present"
							? key(generation.objectId, generation.baseExpectedHead.generationId)
							: undefined,
					digests: generation.closure.map((reference) => reference.digest),
				});
				for (const reference of generation.closure) {
					const owners = blobOwners.get(reference.digest) ?? new Set<string>();
					owners.add(identity);
					blobOwners.set(reference.digest, owners);
				}
			});
			await scan(transaction, "promotions", (row) => {
				const digest = textField(row, "digest");
				if (digest === undefined) return;
				const owners = blobOwners.get(digest) ?? new Set<string>();
				owners.add(key(field(row, "objectId"), field(row, "generationId")));
				blobOwners.set(digest, owners);
			});
			await scan(transaction, "blobs", (row) => {
				const digest = textField(row, "digest");
				if (digest !== undefined) blobEpochs.set(digest, carrierEpoch(field(row, "bytes")));
			});
		}
		if (quarantine) {
			await scan(transaction, "scopes", (row) => {
				const expiry = field(row, "expiresAt");
				const state = textField(row, "state") ?? "unknown";
				const expiryStatus =
					typeof expiry === "number" && Number.isFinite(expiry)
						? expiry <= input.now
							? "expired"
							: "unexpired"
						: "unknown-expiry";
				scopes.set(
					key(field(row, "objectId"), field(row, "epoch"), field(row, "anchor"), field(row, "manifestDigest")),
					{
						epoch: epochOf(row),
						retentionStatus: `${state}-${expiryStatus}`,
					}
				);
			});
		}
		if (names.includes("issuedRecords")) {
			await scan(transaction, "issuedRecords", (row) => {
				issuedEpochs.set(
					key(field(row, "objectId"), field(row, "author"), field(row, "authorSequence")),
					carrierEpoch(field(row, "canonicalPreimageBytes"))
				);
			});
		}
		const rollback = new Set<string>();
		for (const [objectId, generationId] of heads) {
			let parent = generations.get(key(objectId, generationId))?.parent;
			// Actual retained rollback pair, not every historical Superseded generation.
			for (let depth = 0; depth < 2 && parent !== undefined; depth += 1) {
				if (!generations.has(parent)) break;
				rollback.add(parent);
				parent = generations.get(parent)?.parent;
			}
		}
		const generationAssociation = (identity: string): Association => {
			const generation = generations.get(identity);
			if (generation === undefined) return { epoch: "unknown", retentionStatus: "unknown" };
			const epoch = combinedEpoch(generation.digests.map((digest) => blobEpochs.get(digest) ?? "unknown"));
			let retentionStatus = generation.state.toLowerCase();
			if (identity === key(generation.objectId, heads.get(generation.objectId))) retentionStatus = "active";
			else if (rollback.has(identity)) retentionStatus = "rollback";
			return { epoch, retentionStatus };
		};
		const associate = (store: string, row: unknown): Association => {
			if (quarantine && (store === "scopes" || store === "chunks")) {
				return (
					scopes.get(
						key(field(row, "objectId"), field(row, "epoch"), field(row, "anchor"), field(row, "manifestDigest"))
					) ?? { epoch: epochOf(row), retentionStatus: "unknown" }
				);
			}
			if (ahe && (store === "generations" || store === "promotions")) {
				return generationAssociation(key(field(row, "objectId"), field(row, "generationId")));
			}
			if (ahe && store === "objects") {
				const objectId = textField(row, "objectId");
				return generationAssociation(key(objectId, objectId === undefined ? undefined : heads.get(objectId)));
			}
			if (ahe && store === "blobs") {
				const digest = textField(row, "digest") ?? "";
				const owners = blobOwners.get(digest);
				return {
					epoch: blobEpochs.get(digest) ?? "unknown",
					retentionStatus:
						owners === undefined || owners.size === 0
							? "unknown"
							: owners.size > 1
								? "shared"
								: generationAssociation(owners.values().next().value as string).retentionStatus,
				};
			}
			let epoch = epochOf(row);
			if (store === "issuedRecords" || store === "issuanceOutbox") {
				epoch =
					issuedEpochs.get(key(field(row, "objectId"), field(row, "author"), field(row, "authorSequence"))) ??
					"unknown";
			}
			return { epoch, retentionStatus: epochStatus(epoch, input.currentEpoch) };
		};
		for (const store of names) {
			let populated = false;
			await scan(transaction, store, (row) => {
				populated = true;
				const { epoch, retentionStatus } = associate(store, row);
				const identity = key(store, epoch, retentionStatus);
				const previous = buckets.get(identity);
				buckets.set(identity, {
					database: database.name,
					store,
					epoch,
					retentionStatus,
					rows: (previous?.rows ?? 0) + 1,
					logicalPayloadBytes: (previous?.logicalPayloadBytes ?? 0) + payloadBytes(row),
				});
			});
			if (!populated)
				buckets.set(key(store, "unknown", "empty"), {
					database: database.name,
					store,
					epoch: "unknown",
					retentionStatus: "empty",
					rows: 0,
					logicalPayloadBytes: 0,
				});
		}
		const failure = await done;
		if (failure !== undefined) throw failure;
		return [...buckets.values()];
	} catch (error) {
		try {
			transaction.abort();
		} catch {
			/* Already terminal; preserve the primary error. */
		}
		await done;
		throw error;
	}
}

/** Read existing named databases only; returned facts own no row objects, views, handles, or transactions. */
export async function censusGridStorage(input: GridStorageCensusInput): Promise<readonly GridStorageCensusRow[]> {
	if (!Number.isSafeInteger(input.currentEpoch) || input.currentEpoch < 0 || !Number.isFinite(input.now)) {
		throw new TypeError("GRID_CENSUS_INVALID_CLOCK_OR_EPOCH");
	}
	const names = [...new Set(input.databaseNames)].sort();
	if (names.some((name) => typeof name !== "string" || name.length === 0))
		throw new TypeError("GRID_CENSUS_INVALID_DATABASE_NAME");
	const existing = new Set((await input.factory.databases()).map((database) => database.name));
	for (const name of names) if (!existing.has(name)) throw new Error(`GRID_CENSUS_DATABASE_MISSING:${name}`);
	const rows: GridStorageCensusRow[] = [];
	for (const name of names) {
		const database = await openExisting(input.factory, name);
		try {
			rows.push(...(await censusDatabase(database, input)));
		} finally {
			database.close();
		}
	}
	return rows.sort((left, right) =>
		key(left.database, left.store, left.epoch, left.retentionStatus).localeCompare(
			key(right.database, right.store, right.epoch, right.retentionStatus)
		)
	);
}
