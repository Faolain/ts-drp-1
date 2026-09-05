import { consumeSnapshotVerificationReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import {
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	type SnapshotChunkDescriptor,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantinePort,
	type SnapshotQuarantineScope,
	type SnapshotQuarantineScopeKey,
	type SnapshotQuarantineStatus,
	type SnapshotQuarantineStore,
	type SnapshotVerificationQuarantine,
	type SnapshotVerificationReceipt,
	type VerifiedSnapshotQuarantineReference,
} from "@ts-drp/storage/snapshot-transfer";

export interface BrowserSnapshotQuarantineStoreOptions {
	readonly primaryDatabaseName: string;
}

type FailureCode =
	| "aborted"
	| "closed"
	| "conflict"
	| "expired"
	| "incomplete"
	| "invalid-carrier"
	| "malformed-input"
	| "poisoned"
	| "receipt-invalid"
	| "storage-failed"
	| "unsupported-schema";

type CapturedDeclaration = Readonly<{
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly scope: SnapshotQuarantineScopeKey;
	readonly totalBytes: number;
}>;

type ScopeRow = Readonly<{
	readonly anchor: string;
	readonly chunkCount: number;
	readonly epoch: number;
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly expiresAt: number;
	readonly manifestDigest: string;
	readonly objectId: string;
	readonly state: "open" | "poisoned" | "verified";
	readonly totalBytes: number;
}>;

type ChunkRow = Readonly<{
	readonly anchor: string;
	readonly byteLength: number;
	readonly digest: string;
	readonly epoch: number;
	readonly exactBytes: Uint8Array;
	readonly index: number;
	readonly manifestDigest: string;
	readonly objectId: string;
}>;

const MAX_MANIFEST_BYTES = 212_387;
const MAX_CHUNKS = 2_048;
const MAX_BYTES = 268_435_456;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(Uint8Array.prototype);
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(intrinsicTypedArrayPrototype, "buffer")
	?.get as (this: Uint8Array) => ArrayBufferLike;
const intrinsicTypedArrayByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteLength"
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArrayByteOffsetGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteOffset"
)?.get as (this: Uint8Array) => number;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"resizable"
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;

class QuarantineError extends Error {
	readonly code: FailureCode;

	constructor(code: FailureCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
	}
}

function failure(code: FailureCode, message: string, cause?: unknown): QuarantineError {
	return new QuarantineError(code, message, cause);
}

function promiseCapture<Result>(operation: () => Promise<Result>): Promise<Result> {
	try {
		return operation();
	} catch (error) {
		return Promise.reject(error);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw failure("aborted", "snapshot quarantine operation was aborted", signal.reason);
}

function exactRecord(value: unknown, fields: readonly string[]): value is Readonly<Record<string, unknown>> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).length === fields.length &&
		fields.every((field) => Reflect.has(value, field))
	);
}

function exactBytes(value: unknown, label: string, maximum: number): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) throw new TypeError();
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, value, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, value, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, value, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) throw new TypeError();
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if (byteLength <= 0 || byteOffset !== 0 || byteLength !== bufferByteLength || byteLength > maximum || resizable) {
			throw new TypeError();
		}
		const copy = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, copy, [value]);
		return copy;
	} catch (error) {
		throw failure("invalid-carrier", `${label} carrier is invalid`, error);
	}
}

function hex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function captureScope(value: unknown): SnapshotQuarantineScopeKey {
	if (!exactRecord(value, ["anchor", "epoch", "manifestDigest", "objectId"])) {
		throw failure("malformed-input", "snapshot quarantine scope is malformed");
	}
	const { anchor, epoch, manifestDigest, objectId } = value;
	if (
		!hex64(anchor) ||
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		epoch < 0 ||
		!hex64(manifestDigest) ||
		typeof objectId !== "string" ||
		objectId.length === 0
	) {
		throw failure("malformed-input", "snapshot quarantine scope is malformed");
	}
	return Object.freeze({ anchor, epoch, manifestDigest, objectId });
}

function captureDescriptor(value: unknown): SnapshotChunkDescriptor {
	if (!exactRecord(value, ["byteLength", "digest", "index"])) {
		throw failure("malformed-input", "snapshot chunk descriptor is malformed");
	}
	const { byteLength, digest, index } = value;
	if (
		typeof byteLength !== "number" ||
		!Number.isSafeInteger(byteLength) ||
		byteLength <= 0 ||
		byteLength > 131_072 ||
		!hex64(digest) ||
		typeof index !== "number" ||
		!Number.isSafeInteger(index) ||
		index < 0
	) {
		throw failure("malformed-input", "snapshot chunk descriptor is malformed");
	}
	return Object.freeze({ byteLength, digest, index });
}

function captureDeclaration(value: unknown): CapturedDeclaration {
	if (!exactRecord(value, ["chunks", "exactCanonicalManifestBytes", "scope", "totalBytes"])) {
		throw failure("malformed-input", "snapshot quarantine declaration is malformed");
	}
	if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > MAX_CHUNKS) {
		throw failure("malformed-input", "snapshot quarantine descriptor count is invalid");
	}
	const chunks = Object.freeze(value.chunks.map(captureDescriptor));
	for (let index = 0; index < chunks.length; index += 1) {
		if (chunks[index]?.index !== index) throw failure("malformed-input", "snapshot descriptors are not contiguous");
	}
	const sum = chunks.reduce((total, descriptor) => total + descriptor.byteLength, 0);
	if (
		typeof value.totalBytes !== "number" ||
		!Number.isSafeInteger(value.totalBytes) ||
		value.totalBytes <= 0 ||
		value.totalBytes > MAX_BYTES ||
		value.totalBytes !== sum
	) {
		throw failure("malformed-input", "snapshot quarantine totalBytes is invalid");
	}
	return Object.freeze({
		chunks,
		exactCanonicalManifestBytes: exactBytes(value.exactCanonicalManifestBytes, "snapshot manifest", MAX_MANIFEST_BYTES),
		scope: captureScope(value.scope),
		totalBytes: value.totalBytes,
	});
}

function captureOptions(value: unknown): string {
	if (
		!exactRecord(value, ["primaryDatabaseName"]) ||
		typeof value.primaryDatabaseName !== "string" ||
		value.primaryDatabaseName === ""
	) {
		throw failure("malformed-input", "browser snapshot quarantine options are malformed");
	}
	return value.primaryDatabaseName;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function scopeKey(scope: SnapshotQuarantineScopeKey): IDBValidKey[] {
	return [scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest];
}

function chunkKey(scope: SnapshotQuarantineScopeKey, index: number): IDBValidKey[] {
	return [...scopeKey(scope), index];
}

function chunkRange(scope: SnapshotQuarantineScopeKey): IDBKeyRange {
	return IDBKeyRange.bound([...scopeKey(scope), 0], [...scopeKey(scope), MAX_CHUNKS]);
}

function selectorRange(scope: SnapshotQuarantineScopeKey): IDBKeyRange {
	return IDBKeyRange.bound(
		[scope.objectId, scope.epoch, scope.anchor, ""],
		[scope.objectId, scope.epoch, scope.anchor, "\uffff"]
	);
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb-request-failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new Error("indexeddb-transaction-aborted")),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("indexeddb-transaction-failed")),
			{ once: true }
		);
	});
}

function strictTransaction(database: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode): IDBTransaction {
	return database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
}

async function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.addEventListener(
			"upgradeneeded",
			(event) => {
				if (event.oldVersion !== 0) {
					request.transaction?.abort();
					return;
				}
				const scopes = request.result.createObjectStore("scopes", {
					keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
				});
				scopes.createIndex("expiryAsc", "expiresAt", { unique: false });
				request.result.createObjectStore("chunks", {
					keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"],
				});
			},
			{ once: true }
		);
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb-open-failed")), {
			once: true,
		});
	});
}

function sameKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function admitSchema(database: IDBDatabase): void {
	if (
		database.version !== 1 ||
		JSON.stringify([...database.objectStoreNames]) !== JSON.stringify(["chunks", "scopes"])
	) {
		throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
	}
	const transaction = database.transaction(["chunks", "scopes"], "readonly");
	const chunks = transaction.objectStore("chunks");
	const scopes = transaction.objectStore("scopes");
	if (
		!sameKeyPath(chunks.keyPath, ["objectId", "epoch", "anchor", "manifestDigest", "index"]) ||
		chunks.autoIncrement ||
		!sameKeyPath(scopes.keyPath, ["objectId", "epoch", "anchor", "manifestDigest"]) ||
		scopes.autoIncrement ||
		JSON.stringify([...scopes.indexNames]) !== JSON.stringify(["expiryAsc"])
	) {
		throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
	}
}

async function deleteChunks(transaction: IDBTransaction, scope: SnapshotQuarantineScopeKey): Promise<void> {
	const chunks = transaction.objectStore("chunks");
	const keys = await requestResult(chunks.getAllKeys(chunkRange(scope)));
	for (const key of keys) chunks.delete(key);
}

async function deleteScope(transaction: IDBTransaction, scope: SnapshotQuarantineScopeKey): Promise<void> {
	await deleteChunks(transaction, scope);
	transaction.objectStore("scopes").delete(scopeKey(scope));
}

function fromScopeRow(value: unknown): ScopeRow {
	if (
		!exactRecord(value, [
			"anchor",
			"chunkCount",
			"epoch",
			"exactCanonicalManifestBytes",
			"expiresAt",
			"manifestDigest",
			"objectId",
			"state",
			"totalBytes",
		])
	) {
		throw failure("poisoned", "browser snapshot quarantine scope row is malformed");
	}
	return value as ScopeRow;
}

/**
 * Creates the isolated strict-durability browser snapshot quarantine store.
 * @param options - Exact primary IndexedDB name owner.
 * @returns Closed durable snapshot-quarantine capability.
 */
export async function createBrowserSnapshotQuarantineStore(
	options: BrowserSnapshotQuarantineStoreOptions
): Promise<SnapshotQuarantineStore<SnapshotVerificationReceipt>> {
	const primaryDatabaseName = captureOptions(options);
	const estimate = await navigator.storage.estimate();
	if ((estimate.quota ?? 0) - (estimate.usage ?? 0) < MAX_BYTES) {
		throw failure("storage-failed", "browser storage quota is below the snapshot ceiling");
	}
	let database: IDBDatabase;
	try {
		database = await openDatabase(`${primaryDatabaseName}--drp-snapshot-quarantine-v1`);
		admitSchema(database);
	} catch (error) {
		if (error instanceof QuarantineError) throw error;
		throw failure("unsupported-schema", "browser snapshot quarantine admission failed", error);
	}
	database.addEventListener("versionchange", () => database.close());
	let closed = false;
	let closing: Promise<void> | undefined;
	let tail = Promise.resolve();
	const schedule = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
		if (closed) return Promise.reject(failure("closed", "snapshot quarantine store is closed"));
		const selected = tail.then(operation);
		tail = selected.then(
			() => undefined,
			() => undefined
		);
		return selected;
	};
	const sweep = async (now: number): Promise<number> => {
		const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
		const scopes = transaction.objectStore("scopes");
		const rows = (await requestResult(scopes.index("expiryAsc").getAll(IDBKeyRange.upperBound(now)))) as ScopeRow[];
		for (const row of rows) await deleteScope(transaction, row);
		await transactionComplete(transaction);
		return rows.length;
	};

	const openScope = (
		declarationInput: SnapshotQuarantineDeclaration,
		optionsInput: Readonly<{ readonly signal?: AbortSignal }> = {}
	): Promise<SnapshotQuarantineScope<SnapshotVerificationReceipt>> => {
		return promiseCapture(() => {
			const declaration = captureDeclaration(declarationInput);
			const signal = optionsInput.signal;
			throwIfAborted(signal);
			return schedule(async () => {
				throwIfAborted(signal);
				await sweep(Date.now());
				try {
					const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
					const scopes = transaction.objectStore("scopes");
					const selectedKey = await requestResult(scopes.getKey(selectorRange(declaration.scope)));
					if (
						selectedKey !== undefined &&
						JSON.stringify(selectedKey) !== JSON.stringify(scopeKey(declaration.scope))
					) {
						transaction.abort();
						throw failure("conflict", "snapshot quarantine manifest conflicts with the occupied scope");
					}
					const raw = await requestResult(scopes.get(scopeKey(declaration.scope)));
					if (raw === undefined) {
						const row: ScopeRow = Object.freeze({
							...declaration.scope,
							chunkCount: declaration.chunks.length,
							exactCanonicalManifestBytes: new Uint8Array(declaration.exactCanonicalManifestBytes),
							expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
							state: "open",
							totalBytes: declaration.totalBytes,
						});
						scopes.add(row);
					} else {
						const row = fromScopeRow(raw);
						if (
							!sameBytes(row.exactCanonicalManifestBytes, declaration.exactCanonicalManifestBytes) ||
							row.totalBytes !== declaration.totalBytes ||
							row.chunkCount !== declaration.chunks.length
						) {
							transaction.abort();
							throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
						}
					}
					await transactionComplete(transaction);
				} catch (error) {
					if (error instanceof QuarantineError) throw error;
					throw failure("storage-failed", "browser snapshot quarantine open failed", error);
				}

				let released = false;
				let canceled = false;
				const ensureSession = (): void => {
					if (released) throw failure("closed", "snapshot quarantine scope is closed");
				};
				const descriptorAt = (value: unknown): SnapshotChunkDescriptor => {
					const descriptor = captureDescriptor(value);
					const expected = declaration.chunks[descriptor.index];
					if (
						expected === undefined ||
						expected.byteLength !== descriptor.byteLength ||
						expected.digest !== descriptor.digest
					) {
						throw failure("malformed-input", "snapshot chunk descriptor is foreign to this scope");
					}
					return expected;
				};
				const queryStatus = async (): Promise<SnapshotQuarantineStatus> => {
					const transaction = strictTransaction(database, ["chunks", "scopes"], "readonly");
					const [rawScope, keys] = await Promise.all([
						requestResult(transaction.objectStore("scopes").get(scopeKey(declaration.scope))),
						requestResult(transaction.objectStore("chunks").getAllKeys(chunkRange(declaration.scope))),
					]);
					await transactionComplete(transaction);
					if (rawScope === undefined)
						throw failure(canceled ? "closed" : "expired", "snapshot quarantine scope is absent");
					const row = fromScopeRow(rawScope);
					const occupied = new Set(keys.map((key) => Number((key as IDBValidKey[])[4])));
					return Object.freeze({
						expiresAt: row.expiresAt,
						kind: row.state,
						missingIndices: Object.freeze(
							declaration.chunks.filter(({ index }) => !occupied.has(index)).map(({ index }) => index)
						),
					});
				};
				const verificationQuarantine: SnapshotVerificationQuarantine = Object.freeze({
					open(portSignal: AbortSignal): SnapshotQuarantinePort {
						ensureSession();
						let portClosed = false;
						const ensurePort = (): void => {
							ensureSession();
							if (portClosed) throw failure("closed", "snapshot quarantine port is closed");
							throwIfAborted(portSignal);
						};
						const port: SnapshotQuarantinePort = Object.freeze({
							discard: () => {
								if (portClosed) return Promise.resolve();
								portClosed = true;
								return Promise.resolve();
							},
							read: (descriptorInput: SnapshotChunkDescriptor) => {
								return promiseCapture(() => {
									const descriptor = descriptorAt(descriptorInput);
									ensurePort();
									return schedule(async () => {
										ensurePort();
										const transaction = strictTransaction(database, ["chunks"], "readonly");
										const raw = await requestResult(
											transaction.objectStore("chunks").get(chunkKey(declaration.scope, descriptor.index))
										);
										await transactionComplete(transaction);
										if (raw === undefined) return undefined;
										const row = raw as ChunkRow;
										const bytes = exactBytes(row.exactBytes, "persisted snapshot chunk", descriptor.byteLength);
										if (
											row.digest !== descriptor.digest ||
											row.byteLength !== descriptor.byteLength ||
											bytes.byteLength !== descriptor.byteLength
										) {
											throw failure("poisoned", "snapshot quarantine chunk row is corrupt");
										}
										return new Uint8Array(bytes);
									});
								});
							},
							write: (descriptorInput: SnapshotChunkDescriptor, exactBytesInput: Uint8Array) => {
								return promiseCapture(() => {
									const descriptor = descriptorAt(descriptorInput);
									const bytes = exactBytes(exactBytesInput, "snapshot chunk", descriptor.byteLength);
									if (bytes.byteLength !== descriptor.byteLength) {
										throw failure("malformed-input", "snapshot chunk length is invalid");
									}
									ensurePort();
									return schedule(async () => {
										ensurePort();
										let conflict = false;
										const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
										try {
											const scopes = transaction.objectStore("scopes");
											const chunks = transaction.objectStore("chunks");
											const rawScope = await requestResult(scopes.get(scopeKey(declaration.scope)));
											if (rawScope === undefined) throw failure("expired", "snapshot quarantine scope is absent");
											const scopeRow = fromScopeRow(rawScope);
											if (scopeRow.state === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
											if (scopeRow.state === "verified")
												throw failure("closed", "verified snapshot quarantine is immutable");
											const raw = await requestResult(chunks.get(chunkKey(declaration.scope, descriptor.index)));
											if (raw !== undefined) {
												const existing = raw as ChunkRow;
												if (
													existing.digest !== descriptor.digest ||
													existing.byteLength !== descriptor.byteLength ||
													!sameBytes(existing.exactBytes, bytes)
												) {
													scopes.put({ ...scopeRow, state: "poisoned" } satisfies ScopeRow);
													conflict = true;
												}
											} else {
												chunks.add({
													...declaration.scope,
													byteLength: descriptor.byteLength,
													digest: descriptor.digest,
													exactBytes: new Uint8Array(bytes),
													index: descriptor.index,
												} satisfies ChunkRow);
												scopes.put({
													...scopeRow,
													expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
												} satisfies ScopeRow);
											}
											await transactionComplete(transaction);
										} catch (error) {
											if (error instanceof QuarantineError) throw error;
											throw failure("storage-failed", "browser snapshot chunk write failed", error);
										}
										if (conflict) throw failure("conflict", "snapshot chunk conflicts with occupied bytes");
									});
								});
							},
						});
						return port;
					},
				});

				const scope: SnapshotQuarantineScope<SnapshotVerificationReceipt> = Object.freeze({
					cancel: (cancelOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) => {
						throwIfAborted(cancelOptions.signal);
						if (canceled) return Promise.resolve();
						return schedule(async () => {
							throwIfAborted(cancelOptions.signal);
							try {
								const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
								await deleteScope(transaction, declaration.scope);
								await transactionComplete(transaction);
								canceled = true;
							} catch (error) {
								throw failure("storage-failed", "browser snapshot quarantine cancel failed", error);
							}
						});
					},
					complete: (
						receipt: SnapshotVerificationReceipt,
						completeOptions: Readonly<{ readonly signal?: AbortSignal }> = {}
					) => {
						throwIfAborted(completeOptions.signal);
						return schedule(async () => {
							ensureSession();
							throwIfAborted(completeOptions.signal);
							const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
							try {
								const scopes = transaction.objectStore("scopes");
								const [rawScope, keys] = await Promise.all([
									requestResult(scopes.get(scopeKey(declaration.scope))),
									requestResult(transaction.objectStore("chunks").getAllKeys(chunkRange(declaration.scope))),
								]);
								if (rawScope === undefined) throw failure("expired", "snapshot quarantine scope is absent");
								const row = fromScopeRow(rawScope);
								if (row.state === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
								if (row.state !== "open" && row.state !== "verified")
									throw failure("poisoned", "snapshot quarantine state is invalid");
								const occupied = new Set(keys.map((key) => Number((key as IDBValidKey[])[4])));
								if (
									keys.length !== declaration.chunks.length ||
									declaration.chunks.some(({ index }) => !occupied.has(index))
								) {
									throw failure("incomplete", "snapshot quarantine is incomplete");
								}
								let completion;
								try {
									completion = consumeSnapshotVerificationReceipt({
										expectedScope: declaration.scope,
										quarantine: verificationQuarantine,
										receipt,
									});
								} catch (error) {
									throw failure("receipt-invalid", "snapshot verification receipt is invalid", error);
								}
								if (
									completion.chunkCount !== declaration.chunks.length ||
									completion.exactByteLength !== declaration.totalBytes ||
									completion.manifestDigest !== declaration.scope.manifestDigest
								) {
									throw failure("receipt-invalid", "snapshot verification completion does not match the scope");
								}
								if (row.state === "open") scopes.put({ ...row, state: "verified" } satisfies ScopeRow);
								await transactionComplete(transaction);
							} catch (error) {
								try {
									transaction.abort();
								} catch {
									// The transaction may already have aborted or completed.
								}
								if (error instanceof QuarantineError) throw error;
								throw failure("storage-failed", "browser snapshot quarantine completion failed", error);
							}
							return Object.freeze({
								chunkCount: declaration.chunks.length,
								exactByteLength: declaration.totalBytes,
								scope: declaration.scope,
							}) satisfies VerifiedSnapshotQuarantineReference;
						});
					},
					missingIndices: (missingOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) => {
						throwIfAborted(missingOptions.signal);
						return schedule(async () => {
							ensureSession();
							throwIfAborted(missingOptions.signal);
							return (await queryStatus()).missingIndices;
						});
					},
					release: () => {
						released = true;
						return Promise.resolve();
					},
					scope: declaration.scope,
					status: (statusOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) => {
						throwIfAborted(statusOptions.signal);
						return schedule(async () => {
							ensureSession();
							throwIfAborted(statusOptions.signal);
							return queryStatus();
						});
					},
					verificationQuarantine,
				});
				return scope;
			});
		});
	};

	const sweepExpired = (options: Readonly<{ readonly signal?: AbortSignal }> = {}): Promise<number> => {
		throwIfAborted(options.signal);
		return schedule(async () => {
			throwIfAborted(options.signal);
			try {
				return await sweep(Date.now());
			} catch (error) {
				throw failure("storage-failed", "browser snapshot quarantine sweep failed", error);
			}
		});
	};

	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closed = true;
		closing = tail.then(() => database.close());
		return closing;
	};

	return Object.freeze({ close, openScope, sweepExpired });
}
