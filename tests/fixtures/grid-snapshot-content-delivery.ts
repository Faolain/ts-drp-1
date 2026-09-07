import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { decodeSnapshotManifest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	type SnapshotChunkDescriptor,
	snapshotQuarantineContract,
	type SnapshotQuarantineDeclaration,
} from "@ts-drp/storage/snapshot-transfer";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

const { maxManifestBytes, maxSnapshotBytes, snapshotChunkBytes } = snapshotQuarantineContract.limits;
const profile = { maxManifestBytes, maxSnapshotBytes, snapshotChunkBytes };
const suffix = "--drp-snapshot-quarantine-v1";
type Selection = Readonly<{ declaration: SnapshotQuarantineDeclaration; incarnation: string; key: IDBValidKey[] }>;

function requireShape(condition: unknown): asserts condition {
	if (!condition) throw new TypeError("F5B_SNAPSHOT_CONTENT_INVALID");
}

function primaryIdentity(name: string): RegExpExecArray {
	const identity = /^(d110c-f5b-parent-\d+-peer-)(0|[1-9]\d*)(-fresh)?$/u.exec(name);
	requireShape(identity !== null);
	return identity;
}

function requireIdentity(objectId: string, epoch: number, signal?: AbortSignal): void {
	signal?.throwIfAborted();
	requireShape(typeof objectId === "string" && objectId.length > 0 && Number.isSafeInteger(epoch) && epoch >= 0);
}

function nextRepresentableEpoch(epoch: number): number {
	// Validated epochs are nonnegative safe integers. Advance one IEEE-754 value,
	// not one integer: even malformed fractional neighboring keys must stay out.
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, epoch === 0 ? 0 : epoch);
	const low = bits.getUint32(4);
	bits.setUint32(4, low + 1);
	if (low === 0xffffffff) bits.setUint32(0, bits.getUint32(0) + 1);
	return bits.getFloat64(0);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = (): void => resolve(value.result);
		value.onerror = (): void => reject(value.error);
	});
}

async function readonlyTransaction<T>(
	database: IDBDatabase,
	names: string[],
	read: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
	const transaction = database.transaction(names, "readonly");
	const complete = new Promise<void>((resolve, reject) => {
		transaction.oncomplete = (): void => resolve();
		transaction.onabort = (): void => reject(transaction.error ?? new Error("F5B_SNAPSHOT_READ_ABORTED"));
		transaction.onerror = (): void => reject(transaction.error);
	});
	// Observe completion immediately, including synchronous schema/read failures.
	void complete.catch(() => undefined);
	try {
		const [value] = await Promise.all([read(transaction), complete]);
		return value;
	} catch (error) {
		try {
			transaction.abort();
		} catch {
			// It may already have completed or aborted.
		}
		await complete.catch(() => undefined);
		throw error;
	}
}

async function openSource(primary: string): Promise<IDBDatabase> {
	const opening = indexedDB.open(primary + suffix);
	opening.onupgradeneeded = (): void => {
		opening.transaction?.abort();
		opening.result.close();
	};
	const database = await request(opening);
	database.onversionchange = (): void => database.close();
	try {
		requireShape(database.version === 2);
		requireShape(JSON.stringify([...database.objectStoreNames]) === JSON.stringify(["chunks", "owner", "scopes"]));
		await readonlyTransaction(database, ["chunks", "owner", "scopes"], (transaction) => {
			for (const name of ["chunks", "owner", "scopes"]) {
				const store = transaction.objectStore(name);
				const keyPath =
					name === "owner"
						? "id"
						: ["objectId", "epoch", "anchor", "manifestDigest", ...(name === "chunks" ? ["index"] : [])];
				requireShape(!store.autoIncrement && JSON.stringify(store.keyPath) === JSON.stringify(keyPath));
				requireShape(JSON.stringify([...store.indexNames]) === JSON.stringify(name === "scopes" ? ["expiryAsc"] : []));
				if (name === "scopes") {
					const index = store.index("expiryAsc");
					requireShape(index.keyPath === "expiresAt" && !index.unique && !index.multiEntry);
				}
			}
			return Promise.resolve();
		});
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

function record(value: unknown): Record<string, unknown> {
	requireShape(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function header(value: unknown, key: IDBValidKey, objectId: string, epoch: number): Selection {
	const row = record(value);
	requireShape(row.objectId === objectId && row.epoch === epoch && row.state === "verified");
	requireShape(typeof row.anchor === "string" && typeof row.manifestDigest === "string");
	const expectedKey = [objectId, epoch, row.anchor, row.manifestDigest];
	requireShape(indexedDB.cmp(key, expectedKey) === 0);
	requireShape(typeof row.incarnation === "string" && row.incarnation.length > 0);
	requireShape(
		row.exactCanonicalManifestBytes instanceof Uint8Array &&
			row.exactCanonicalManifestBytes.byteLength <= maxManifestBytes
	);
	const decoded = decodeSnapshotManifest({
		exactCanonicalManifestBytes: row.exactCanonicalManifestBytes,
		expectedManifestDigest: row.manifestDigest,
		profile,
	});
	requireShape(
		decoded.manifest.objectId === objectId && decoded.manifest.epoch === epoch && decoded.manifest.anchor === row.anchor
	);
	requireShape(row.totalBytes === decoded.manifest.totalBytes && row.chunkCount === decoded.chunks.length);
	requireShape(Array.isArray(row.descriptors) && row.descriptors.length === decoded.chunks.length);
	const descriptors: unknown[] = row.descriptors;
	for (const [index, descriptor] of decoded.chunks.entries()) {
		const stored = record(descriptors[index]);
		requireShape(
			Object.keys(stored).length === 3 &&
				stored.index === descriptor.index &&
				stored.digest === descriptor.digest &&
				stored.byteLength === descriptor.byteLength
		);
	}
	return {
		declaration: {
			chunks: decoded.chunks,
			exactCanonicalManifestBytes: decoded.exactCanonicalManifestBytes,
			scope: {
				anchor: decoded.manifest.anchor,
				epoch: decoded.manifest.epoch,
				manifestDigest: decoded.manifestDigest,
				objectId: decoded.manifest.objectId,
			},
			totalBytes: decoded.manifest.totalBytes as number,
		},
		incarnation: row.incarnation,
		key: expectedKey,
	};
}

async function select(
	database: IDBDatabase,
	objectId: string,
	epoch: number,
	signal?: AbortSignal
): Promise<Selection> {
	signal?.throwIfAborted();
	const selected = await readonlyTransaction(
		database,
		["scopes"],
		(transaction) =>
			new Promise<Selection>((resolve, reject) => {
				// The next numeric value bounds every suffix type in this exact prefix.
				// No finite array sentinel can cover arbitrarily nested array-valued keys.
				const cursor = transaction
					.objectStore("scopes")
					.openCursor(IDBKeyRange.bound([objectId, epoch], [objectId, nextRepresentableEpoch(epoch)], false, true));
				let candidate: Selection | undefined;
				cursor.onerror = (): void => reject(cursor.error);
				cursor.onsuccess = (): void => {
					try {
						signal?.throwIfAborted();
						const current = cursor.result;
						if (current === null) {
							requireShape(candidate !== undefined);
							resolve(candidate);
							return;
						}
						requireShape(candidate === undefined);
						candidate = header(current.value, current.primaryKey, objectId, epoch);
						current.continue();
					} catch (error) {
						reject(error);
					}
				};
			})
	);
	signal?.throwIfAborted();
	return selected;
}

async function readChunk(
	database: IDBDatabase,
	selected: Selection,
	descriptor: SnapshotChunkDescriptor,
	signal: AbortSignal
): Promise<Uint8Array> {
	signal.throwIfAborted();
	const bytes = await readonlyTransaction(database, ["scopes", "chunks"], async (transaction) => {
		const { declaration, key, incarnation } = selected;
		const [value, chunk] = await Promise.all([
			request(transaction.objectStore("scopes").get(key)) as Promise<unknown>,
			request(transaction.objectStore("chunks").get([...key, descriptor.index])) as Promise<unknown>,
		]);
		const current = header(value, key, declaration.scope.objectId, declaration.scope.epoch);
		requireShape(
			current.incarnation === incarnation &&
				sameBytes(current.declaration.exactCanonicalManifestBytes, declaration.exactCanonicalManifestBytes)
		);
		const row = record(chunk);
		requireShape(
			row.objectId === declaration.scope.objectId &&
				row.epoch === declaration.scope.epoch &&
				row.anchor === declaration.scope.anchor &&
				row.manifestDigest === declaration.scope.manifestDigest
		);
		requireShape(
			row.index === descriptor.index && row.digest === descriptor.digest && row.byteLength === descriptor.byteLength
		);
		requireShape(
			row.exactBytes instanceof Uint8Array &&
				row.exactBytes.byteLength === descriptor.byteLength &&
				row.exactBytes.byteLength <= snapshotChunkBytes
		);
		return new Uint8Array(row.exactBytes);
	});
	signal.throwIfAborted();
	return bytes;
}

/**
 * Selects one verified declaration without admission, migration or payload reads.
 * @param input - Explicit local fixture identity and requested snapshot.
 * @returns A fresh declaration decoded from the selected bounded manifest.
 */
export async function readFixtureSnapshotDeclaration(
	input: Readonly<{ primaryDatabaseName: string; objectId: string; closedEpoch: number; signal?: AbortSignal }>
): Promise<SnapshotQuarantineDeclaration> {
	primaryIdentity(input.primaryDatabaseName);
	requireIdentity(input.objectId, input.closedEpoch, input.signal);
	const source = await openSource(input.primaryDatabaseName);
	try {
		return (await select(source, input.objectId, input.closedEpoch, input.signal)).declaration;
	} finally {
		source.close();
	}
}

/**
 * Delivers selected content through native destination verification and admission.
 * @param input - Creator and recipient fixture identities and requested snapshot.
 * @returns The captured declaration only after native completion succeeds.
 */
export async function deliverFixtureSnapshot(
	input: Readonly<{
		sourcePrimaryDatabaseName: string;
		targetPrimaryDatabaseName: string;
		objectId: string;
		closedEpoch: number;
		signal?: AbortSignal;
	}>
): Promise<SnapshotQuarantineDeclaration> {
	const origin = primaryIdentity(input.sourcePrimaryDatabaseName);
	const target = primaryIdentity(input.targetPrimaryDatabaseName);
	requireShape(origin[1] === target[1] && origin[2] === "0" && origin[3] === undefined && target[2] !== "0");
	requireIdentity(input.objectId, input.closedEpoch, input.signal);
	const source = await openSource(input.sourcePrimaryDatabaseName);
	try {
		const selected = await select(source, input.objectId, input.closedEpoch, input.signal);
		const destination = await createBrowserSnapshotQuarantineStore({
			primaryDatabaseName: input.targetPrimaryDatabaseName,
		});
		try {
			const scope = await destination.openScope(selected.declaration, { signal: input.signal });
			try {
				const verified = verifySnapshotStreamWithReceipt({
					exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.declaration.scope.manifestDigest,
					expectedScope: selected.declaration.scope,
					profile,
					quarantine: scope.verificationQuarantine,
					signal: input.signal,
					source: { read: (descriptor, options) => readChunk(source, selected, descriptor, options.signal) },
				});
				const [, receipt] = await Promise.all([verified.completion, verified.receipt]);
				await scope.complete(receipt, { signal: input.signal });
				return selected.declaration;
			} finally {
				await scope.release();
			}
		} finally {
			await destination.close();
		}
	} finally {
		source.close();
	}
}
