import { consumeSnapshotVerificationReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import {
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	type SnapshotChunkDescriptor,
	snapshotQuarantineContract,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantinePort,
	type SnapshotQuarantineScope,
	type SnapshotQuarantineScopeKey,
	type SnapshotQuarantineStatus,
	type SnapshotQuarantineStore,
	type SnapshotRecoveryChunkReader,
	type SnapshotRecoveryDeclarationLookup,
	type SnapshotRecoveryInspection,
	type SnapshotRecoveryLimits,
	type SnapshotRecoveryOwnerStatus,
	type SnapshotRecoveryStore,
	type SnapshotVerificationQuarantine,
	type SnapshotVerificationReceipt,
	type VerifiedSnapshotQuarantineReference,
} from "@ts-drp/storage/snapshot-transfer";

export interface BrowserSnapshotQuarantineStoreOptions {
	readonly primaryDatabaseName: string;
	readonly recoveryLimits?: SnapshotRecoveryLimits;
}

type ScopeRow = Readonly<{
	readonly retention: SnapshotQuarantineStatus["retention"];
	readonly incarnation: string;
	readonly descriptors: readonly SnapshotChunkDescriptor[] | null;
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

const {
	captureDeclaration,
	captureDescriptor,
	captureExactBytes: exactBytes,
	createError: failure,
	isError,
} = snapshotQuarantineContract;
type CapturedDeclaration = SnapshotQuarantineDeclaration;
const MAX_CHUNKS = snapshotQuarantineContract.limits.maxChunks;

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
		fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
	);
}

function captureOptions(value: unknown): {
	primaryDatabaseName: string;
	recoveryLimits: SnapshotRecoveryLimits | undefined;
} {
	if (!exactRecord(value, ["primaryDatabaseName"]) && !exactRecord(value, ["primaryDatabaseName", "recoveryLimits"])) {
		throw failure("malformed-input", "browser snapshot quarantine options are malformed");
	}
	const primaryDatabaseName = value.primaryDatabaseName;
	if (typeof primaryDatabaseName !== "string" || primaryDatabaseName === "") {
		throw failure("malformed-input", "browser snapshot quarantine options are malformed");
	}
	return {
		primaryDatabaseName,
		recoveryLimits: Object.prototype.hasOwnProperty.call(value, "recoveryLimits")
			? snapshotQuarantineContract.captureRecoveryLimits(value.recoveryLimits)
			: undefined,
	};
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

async function validateRecoveryClosure(transaction: IDBTransaction, declaration: CapturedDeclaration): Promise<void> {
	snapshotQuarantineContract.validateRecoveryManifest(declaration);
	const prefix = scopeKey(declaration.scope);
	const range = IDBKeyRange.bound(
		prefix,
		[
			declaration.scope.objectId,
			declaration.scope.epoch,
			declaration.scope.anchor,
			declaration.scope.manifestDigest + "\0",
		],
		false,
		true
	);
	await new Promise<void>((resolve, reject) => {
		let count = 0;
		const request = transaction.objectStore("chunks").openCursor(range);
		request.addEventListener("error", () => reject(request.error));
		request.addEventListener("success", () => {
			try {
				const cursor = request.result;
				if (cursor === null) {
					if (count !== declaration.chunks.length)
						throw failure("incomplete", "snapshot quarantine closure is incomplete");
					resolve();
					return;
				}
				const key = cursor.primaryKey;
				const row = cursor.value as ChunkRow;
				if (
					!Array.isArray(key) ||
					key.length !== 5 ||
					!prefix.every((part, index) => key[index] === part) ||
					row === null ||
					typeof row !== "object" ||
					key[4] !== row.index ||
					row.objectId !== declaration.scope.objectId ||
					row.epoch !== declaration.scope.epoch ||
					row.anchor !== declaration.scope.anchor ||
					row.manifestDigest !== declaration.scope.manifestDigest
				)
					throw failure("poisoned", "snapshot recovery chunk key disagrees with its row");
				snapshotQuarantineContract.validateRecoveryChunk(
					declaration,
					{
						index: row.index,
						digest: row.digest,
						byteLength: row.byteLength,
					},
					row.exactBytes
				);
				count += 1;
				cursor.continue();
			} catch (error) {
				reject(error);
			}
		});
	});
}

function selectorRange(scope: SnapshotQuarantineScopeKey): IDBKeyRange {
	return IDBKeyRange.bound(
		[scope.objectId, scope.epoch, scope.anchor, ""],
		[scope.objectId, scope.epoch, scope.anchor, "\uffff"]
	);
}

function recoverySelectorRange(scope: SnapshotQuarantineScopeKey): IDBKeyRange {
	// Include every fourth-key class, even corrupt occupancy that is not a digest string.
	return IDBKeyRange.bound(
		[scope.objectId, scope.epoch, scope.anchor],
		[scope.objectId, scope.epoch, scope.anchor + "\0"],
		false,
		true
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

function transactionComplete(
	transaction: IDBTransaction,
	onError: (error: unknown) => void,
	onTerminal: () => void
): Promise<"complete" | "abort"> {
	return new Promise((resolve) => {
		const settle = (terminal: "complete" | "abort"): void => {
			onTerminal();
			resolve(terminal);
		};
		transaction.addEventListener("complete", () => settle("complete"), { once: true });
		transaction.addEventListener("abort", () => settle("abort"), { once: true });
		transaction.addEventListener("error", (event) => {
			// A prevented request error can be followed by a successful commit.
			if (!event.defaultPrevented) onError(event.target instanceof IDBRequest ? event.target.error : transaction.error);
		});
	});
}

function strictTransaction(database: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode): IDBTransaction {
	return database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
}

type OwnerRow = SnapshotRecoveryOwnerStatus & Readonly<{ id: "owner" }>;
function sameKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}
function admitSchema(database: IDBDatabase, transaction: IDBTransaction, version: 1 | 2): void {
	const names = version === 1 ? ["chunks", "scopes"] : ["chunks", "owner", "scopes"];
	if (JSON.stringify([...database.objectStoreNames]) !== JSON.stringify(names))
		throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
	const chunks = transaction.objectStore("chunks"),
		scopes = transaction.objectStore("scopes");
	if (
		!sameKeyPath(chunks.keyPath, ["objectId", "epoch", "anchor", "manifestDigest", "index"]) ||
		chunks.autoIncrement ||
		chunks.indexNames.length !== 0 ||
		!sameKeyPath(scopes.keyPath, ["objectId", "epoch", "anchor", "manifestDigest"]) ||
		scopes.autoIncrement ||
		JSON.stringify([...scopes.indexNames]) !== JSON.stringify(["expiryAsc"])
	)
		throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
	const expiry = scopes.index("expiryAsc");
	if (expiry.keyPath !== "expiresAt" || expiry.unique || expiry.multiEntry)
		throw failure("unsupported-schema", "browser snapshot quarantine expiry index is unsupported");
	if (version === 2) {
		const owner = transaction.objectStore("owner");
		if (owner.keyPath !== "id" || owner.autoIncrement || owner.indexNames.length !== 0)
			throw failure("unsupported-schema", "browser snapshot owner schema is unsupported");
	}
}
function initialOwner(limits: SnapshotRecoveryLimits, count = 0, bytes = 0): OwnerRow {
	return {
		id: "owner",
		limits,
		recoveryScopes: 0,
		recoveryContentBytes: 0,
		legacyUnclassifiedScopes: count,
		legacyUnclassifiedContentBytes: bytes,
		migration: count === 0 ? "ready" : "classification-required",
	};
}
async function openDatabase(name: string, supplied: SnapshotRecoveryLimits | undefined): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 2);
		let refused = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let upgradeError: unknown;
		const disarm = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		};
		request.addEventListener("blocked", () => {
			if (timer !== undefined || refused) return;
			timer = setTimeout(() => {
				refused = true;
				reject(failure("storage-failed", "snapshot quarantine migration-blocked"));
			}, 1000);
		});
		request.addEventListener("upgradeneeded", (event) => {
			disarm();
			const transaction = request.transaction;
			if (transaction === null) {
				reject(failure("storage-failed", "snapshot upgrade transaction is absent"));
				return;
			}
			if (refused) {
				transaction.abort();
				return;
			}
			try {
				const database = request.result;
				if (event.oldVersion === 1) admitSchema(database, transaction, 1);
				else if (event.oldVersion === 0) {
					if (database.objectStoreNames.length !== 0)
						throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
					const scopes = database.createObjectStore("scopes", {
						keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
					});
					scopes.createIndex("expiryAsc", "expiresAt", { unique: false });
					database.createObjectStore("chunks", { keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"] });
				} else throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
				const owner = database.createObjectStore("owner", { keyPath: "id" });
				const limits = supplied ?? snapshotQuarantineContract.defaultRecoveryLimits;
				let count = 0,
					bytes = 0;
				const cursorRequest = transaction.objectStore("scopes").openCursor();
				cursorRequest.addEventListener("success", () => {
					try {
						const cursor = cursorRequest.result;
						if (cursor === null) {
							owner.add(initialOwner(limits, count, bytes));
							return;
						}
						const row = cursor.value as ScopeRow;
						count = snapshotQuarantineContract.addRecoveryContentBytes(count, 1);
						bytes = snapshotQuarantineContract.addRecoveryContentBytes(
							bytes,
							snapshotQuarantineContract.recoveryContentBytes(
								row.totalBytes,
								row.exactCanonicalManifestBytes.byteLength
							)
						);
						cursor.update({
							...row,
							retention: "legacy-unclassified",
							incarnation: crypto.randomUUID(),
							descriptors: null,
						});
						cursor.continue();
					} catch (error) {
						upgradeError = error;
						transaction.abort();
					}
				});
			} catch (error) {
				upgradeError = error;
				transaction.abort();
			}
		});
		request.addEventListener(
			"success",
			() => {
				disarm();
				if (refused) {
					request.result.close();
					return;
				}
				resolve(request.result);
			},
			{ once: true }
		);
		request.addEventListener(
			"error",
			() => {
				disarm();
				if (refused) return;
				const error = upgradeError ?? request.error;
				reject(
					isError(error)
						? error
						: failure(
								request.error?.name === "VersionError" ? "unsupported-schema" : "storage-failed",
								"browser snapshot quarantine admission failed",
								error
							)
				);
			},
			{ once: true }
		);
	});
}
async function transact<Result>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (transaction: IDBTransaction) => Promise<Result>,
	options: Readonly<{ signal?: AbortSignal; requireStrictDurability?: boolean }> = {}
): Promise<Result> {
	const transaction = strictTransaction(database, ["chunks", "owner", "scopes"], mode);
	let firstFailure: unknown;
	let failed = false;
	let cancellationAccepted = false;
	const rememberFailure = (error: unknown): void => {
		if (!failed && !cancellationAccepted) {
			failed = true;
			firstFailure = error;
		}
	};
	const cancel = (): void => {
		try {
			transaction.abort();
			cancellationAccepted = true;
		} catch {
			// Already committing or terminal: only the native outcome can settle us.
		}
	};
	const signal = options.signal;
	const done = transactionComplete(transaction, rememberFailure, () => signal?.removeEventListener("abort", cancel));
	signal?.addEventListener("abort", cancel, { once: true });
	let result: Result | undefined;
	let operationSucceeded = false;
	try {
		if (options.requireStrictDurability === true && transaction.durability !== "strict")
			throw failure("storage-failed", "strict snapshot recovery durability is unsupported");
		if (signal?.aborted === true) cancel();
		if (!cancellationAccepted) {
			result = await operation(transaction);
			operationSucceeded = true;
		}
	} catch (error) {
		rememberFailure(error);
		try {
			transaction.abort();
		} catch {
			// Preserve earlier failure, including uncertain completion.
		}
	}
	const terminal = await done;
	if (terminal === "complete" && operationSucceeded) return result as Result;
	if (failed) {
		if (isError(firstFailure)) throw firstFailure;
		throw failure("storage-failed", "browser snapshot quarantine transaction failed", firstFailure);
	}
	if (terminal === "abort" && cancellationAccepted)
		throw failure("aborted", "snapshot quarantine operation was aborted", signal?.reason);
	throw failure("storage-failed", "browser snapshot quarantine transaction aborted", transaction.error);
}
async function ownerStatus(transaction: IDBTransaction): Promise<SnapshotRecoveryOwnerStatus> {
	const store = transaction.objectStore("owner");
	const [raw, count] = await Promise.all([requestResult(store.get("owner")), requestResult(store.count())]);
	if (
		count !== 1 ||
		!exactRecord(raw, [
			"id",
			"limits",
			"recoveryScopes",
			"recoveryContentBytes",
			"legacyUnclassifiedScopes",
			"legacyUnclassifiedContentBytes",
			"migration",
		]) ||
		raw.id !== "owner"
	)
		throw failure("unsupported-schema", "browser snapshot owner metadata is unsupported");
	const limits = snapshotQuarantineContract.captureRecoveryLimits(raw.limits);
	const checked = (value: unknown): number => {
		if (typeof value !== "number") throw failure("storage-failed", "snapshot owner accounting is invalid");
		return snapshotQuarantineContract.addRecoveryContentBytes(0, value);
	};
	const recoveryScopes = checked(raw.recoveryScopes),
		recoveryContentBytes = checked(raw.recoveryContentBytes);
	const legacyUnclassifiedScopes = checked(raw.legacyUnclassifiedScopes),
		legacyUnclassifiedContentBytes = checked(raw.legacyUnclassifiedContentBytes);
	const migration = legacyUnclassifiedScopes === 0 ? "ready" : "classification-required";
	if (raw.migration !== migration)
		throw failure("unsupported-schema", "browser snapshot owner migration state is unsupported");
	return Object.freeze({
		limits,
		recoveryScopes,
		recoveryContentBytes,
		legacyUnclassifiedScopes,
		legacyUnclassifiedContentBytes,
		migration,
	});
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
			"retention",
			"incarnation",
			"descriptors",
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
	const row = value as ScopeRow;
	if (
		typeof row.incarnation !== "string" ||
		row.incarnation.length === 0 ||
		!["open", "verified", "poisoned"].includes(row.state) ||
		!["temporary", "recovery", "legacy-unclassified"].includes(row.retention) ||
		(row.retention === "legacy-unclassified") !== (row.descriptors === null) ||
		(row.descriptors !== null && !Array.isArray(row.descriptors))
	)
		throw failure("poisoned", "browser snapshot quarantine scope row is malformed");
	return row;
}

/**
 * Opens the dedicated strict-durability, versioned snapshot owner.
 * @param options - Exact primary database identity and optional durable policy.
 * @returns The admitted snapshot quarantine owner.
 */
export async function createBrowserSnapshotQuarantineStore(
	options: BrowserSnapshotQuarantineStoreOptions
): Promise<SnapshotRecoveryStore<SnapshotVerificationReceipt>> {
	const { primaryDatabaseName, recoveryLimits } = captureOptions(options);
	let acquired: IDBDatabase | undefined;
	try {
		const candidate = await openDatabase(`${primaryDatabaseName}--drp-snapshot-quarantine-v1`, recoveryLimits);
		acquired = candidate;
		if (
			candidate.version !== 2 ||
			JSON.stringify([...candidate.objectStoreNames]) !== JSON.stringify(["chunks", "owner", "scopes"])
		) {
			throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
		}
		await transact(candidate, "readonly", async (transaction) => {
			admitSchema(candidate, transaction, 2);
			const persisted = (await ownerStatus(transaction)).limits;
			if (
				recoveryLimits !== undefined &&
				(persisted.maxRecoveryScopes !== recoveryLimits.maxRecoveryScopes ||
					persisted.maxRecoveryContentBytes !== recoveryLimits.maxRecoveryContentBytes)
			)
				throw failure("policy-mismatch", "snapshot recovery policy differs from the durable owner");
		});
	} catch (error) {
		acquired?.close();
		if (isError(error)) throw error;
		throw failure("storage-failed", "browser snapshot quarantine admission failed", error);
	}
	const database = acquired;
	let closed = false,
		terminated = false,
		closing: Promise<void> | undefined;
	let tail = Promise.resolve();
	database.addEventListener("versionchange", () => {
		closed = true;
		terminated = true;
		database.close();
	});
	const schedule = <Result>(operation: () => Promise<Result>): Promise<Result> => {
		if (closed) return Promise.reject(failure("closed", "snapshot quarantine store is closed"));
		const selected = tail
			.then(() => {
				if (terminated) throw failure("closed", "snapshot quarantine store is closed");
				return operation();
			})
			.catch((error: unknown) => {
				if (isError(error)) throw error;
				throw failure("storage-failed", "browser snapshot quarantine operation failed", error);
			});
		tail = selected.then(
			() => undefined,
			() => undefined
		);
		return selected;
	};
	const mutable = async (transaction: IDBTransaction): Promise<void> => {
		if ((await ownerStatus(transaction)).migration !== "ready")
			throw failure("migration-required", "snapshot legacy classification is required");
	};
	const sweep = async (transaction: IDBTransaction, now: number): Promise<number> => {
		if ((await ownerStatus(transaction)).migration !== "ready") return 0;
		const scopes = transaction.objectStore("scopes");
		const rows = (await requestResult(scopes.index("expiryAsc").getAll(IDBKeyRange.upperBound(now)))) as ScopeRow[];
		let deleted = 0;
		for (const row of rows)
			if (row.retention === "temporary") {
				await deleteScope(transaction, row);
				deleted += 1;
			}
		return deleted;
	};
	const recorded = async (
		transaction: IDBTransaction,
		declaration: CapturedDeclaration,
		incarnation?: string
	): Promise<ScopeRow | undefined> => {
		const raw = await requestResult(transaction.objectStore("scopes").get(selectorRange(declaration.scope)));
		if (raw === undefined) return undefined;
		const row = fromScopeRow(raw);
		if (incarnation !== undefined && row.incarnation !== incarnation)
			throw failure("stale-scope", "snapshot quarantine handle belongs to an earlier incarnation");
		if (
			row.manifestDigest !== declaration.scope.manifestDigest ||
			!sameBytes(row.exactCanonicalManifestBytes, declaration.exactCanonicalManifestBytes) ||
			row.totalBytes !== declaration.totalBytes ||
			row.chunkCount !== declaration.chunks.length ||
			(row.descriptors !== null && JSON.stringify(row.descriptors) !== JSON.stringify(declaration.chunks))
		)
			throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
		if (row.descriptors === null) {
			await new Promise<void>((resolve, reject) => {
				const request = transaction.objectStore("chunks").openCursor(chunkRange(declaration.scope));
				request.addEventListener("error", () => reject(request.error));
				request.addEventListener("success", () => {
					const cursor = request.result;
					if (cursor === null) {
						resolve();
						return;
					}
					const chunk = cursor.value as ChunkRow,
						expected = declaration.chunks[chunk.index];
					if (expected === undefined || expected.digest !== chunk.digest || expected.byteLength !== chunk.byteLength) {
						reject(failure("conflict", "snapshot legacy chunk identity conflicts with declaration"));
						return;
					}
					cursor.continue();
				});
			});
		}
		return row;
	};
	const statusOf = async (
		transaction: IDBTransaction,
		declaration: CapturedDeclaration,
		row: ScopeRow
	): Promise<SnapshotQuarantineStatus> => {
		const keys = await requestResult(transaction.objectStore("chunks").getAllKeys(chunkRange(declaration.scope)));
		const occupied = new Set(keys.map((key) => Number((key as IDBValidKey[])[4])));
		return Object.freeze({
			expiresAt: row.expiresAt,
			kind: row.state,
			retention: row.retention,
			missingIndices: Object.freeze(
				declaration.chunks.filter(({ index }) => !occupied.has(index)).map(({ index }) => index)
			),
		});
	};
	const readRecoveryMetadata = async (
		transaction: IDBTransaction,
		scope: SnapshotQuarantineScopeKey,
		read?: Readonly<{ declaration: SnapshotQuarantineDeclaration; incarnation?: string }>
	): Promise<
		{ observation: Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>; incarnation: string } | undefined
	> => {
		const scopes = transaction.objectStore("scopes");
		let raw: unknown = await requestResult(scopes.get(scopeKey(scope)));
		if (raw === undefined && read?.incarnation !== undefined)
			raw = await requestResult(scopes.get(recoverySelectorRange(scope)));
		if (raw === undefined) return undefined;
		const row = fromScopeRow(raw);
		if (
			row.objectId !== scope.objectId ||
			row.epoch !== scope.epoch ||
			row.anchor !== scope.anchor ||
			typeof row.manifestDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(row.manifestDigest) ||
			(read?.incarnation === undefined && row.manifestDigest !== scope.manifestDigest)
		)
			throw failure("poisoned", "snapshot exact key disagrees with durable metadata");
		const actualScope = { ...scope, manifestDigest: row.manifestDigest };
		return {
			observation: snapshotQuarantineContract.validateRecoveryManifest(actualScope, row, read),
			incarnation: row.incarnation,
		};
	};
	const lookupRecoveryDeclaration: SnapshotRecoveryStore<SnapshotVerificationReceipt>["lookupRecoveryDeclaration"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			const scope = snapshotQuarantineContract.captureScope(input);
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				transact(
					database,
					"readonly",
					async (transaction) => {
						throwIfAborted(signal);
						const scopes = transaction.objectStore("scopes");
						const metadata = await readRecoveryMetadata(transaction, scope);
						if (metadata === undefined) {
							// Advance the third component, admitting every fourth-key class.
							const range = recoverySelectorRange(scope);
							if ((await requestResult(scopes.getKey(range))) !== undefined)
								throw failure("conflict", "snapshot identity is occupied by another digest");
							return Object.freeze({ kind: "missing" as const });
						}
						return metadata.observation;
					},
					{ signal }
				)
			);
		});
	const acquireRecoveryRead: SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryRead"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			const declaration = captureDeclaration(input);
			snapshotQuarantineContract.validateRecoveryManifest(declaration);
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(async () => {
				if (closed) throw failure("closed", "snapshot quarantine store is closed");
				throwIfAborted(signal);
				const metadata = await transact(
					database,
					"readonly",
					async (transaction) => {
						throwIfAborted(signal);
						const found = await readRecoveryMetadata(transaction, declaration.scope, { declaration });
						if (found === undefined) {
							if (
								(await requestResult(
									transaction.objectStore("scopes").getKey(recoverySelectorRange(declaration.scope))
								)) !== undefined
							)
								throw failure("conflict", "snapshot identity is occupied by another digest");
							throwIfAborted(signal);
							return undefined;
						}
						throwIfAborted(signal);
						return found;
					},
					{ signal }
				);
				if (metadata === undefined) return Object.freeze({ kind: "missing" as const });
				let released = false;
				let drain = Promise.resolve();
				const ensureReader = (): void => {
					if (released || closed) throw failure("closed", "snapshot recovery reader is closed");
				};
				const reader: SnapshotRecoveryChunkReader = Object.freeze({
					read: (input: SnapshotChunkDescriptor, options: Readonly<{ signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const descriptor = captureDescriptor(input, declaration);
							const readSignal = options.signal;
							ensureReader();
							throwIfAborted(readSignal);
							const selected = schedule(() => {
								ensureReader();
								throwIfAborted(readSignal);
								return transact(
									database,
									"readonly",
									async (transaction) => {
										throwIfAborted(readSignal);
										const current = await readRecoveryMetadata(transaction, declaration.scope, {
											declaration,
											incarnation: metadata.incarnation,
										});
										if (current === undefined) {
											throwIfAborted(readSignal);
											return undefined;
										}
										throwIfAborted(readSignal);
										const raw: unknown = await requestResult(
											transaction.objectStore("chunks").get(chunkKey(declaration.scope, descriptor.index))
										);
										if (raw === undefined) {
											throwIfAborted(readSignal);
											return undefined;
										}
										// IDB already structured-cloned this native result. Bound it before copying or hashing.
										if (
											!exactRecord(raw, [
												"anchor",
												"byteLength",
												"digest",
												"epoch",
												"exactBytes",
												"index",
												"manifestDigest",
												"objectId",
											]) ||
											raw.objectId !== declaration.scope.objectId ||
											raw.epoch !== declaration.scope.epoch ||
											raw.anchor !== declaration.scope.anchor ||
											raw.manifestDigest !== declaration.scope.manifestDigest ||
											raw.index !== descriptor.index ||
											raw.digest !== descriptor.digest ||
											raw.byteLength !== descriptor.byteLength ||
											!(raw.exactBytes instanceof Uint8Array) ||
											raw.exactBytes.byteLength !== descriptor.byteLength
										)
											throw failure("poisoned", "snapshot recovery chunk row is corrupt");
										snapshotQuarantineContract.validateRecoveryChunk(declaration, descriptor, raw.exactBytes);
										throwIfAborted(readSignal);
										return new Uint8Array(raw.exactBytes);
									},
									{ signal: readSignal }
								);
							});
							drain = selected.then(
								() => undefined,
								() => undefined
							);
							return selected;
						}),
					release: () => {
						released = true;
						return drain;
					},
				});
				return Object.freeze({
					...metadata.observation,
					state: metadata.observation.state as "open" | "verified",
					reader,
				});
			});
		});
	const inspectRecovery: SnapshotQuarantineStore<SnapshotVerificationReceipt>["inspectRecovery"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			const declaration = captureDeclaration(input),
				signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				transact(database, "readonly", async (transaction): Promise<SnapshotRecoveryInspection> => {
					throwIfAborted(signal);
					const row = await recorded(transaction, declaration);
					return row === undefined
						? Object.freeze({ kind: "missing" })
						: Object.freeze({ kind: "present", status: await statusOf(transaction, declaration, row) });
				})
			);
		});

	const recoveryStatus: SnapshotQuarantineStore<SnapshotVerificationReceipt>["recoveryStatus"] = (options = {}) =>
		promiseCapture(() => {
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				transact(database, "readonly", async (transaction) => {
					throwIfAborted(signal);
					return ownerStatus(transaction);
				})
			);
		});
	const openScope: SnapshotQuarantineStore<SnapshotVerificationReceipt>["openScope"] = (input, options = {}) =>
		promiseCapture(() => {
			const declaration = captureDeclaration(input),
				signal = options.signal;
			throwIfAborted(signal);
			return schedule(async () => {
				throwIfAborted(signal);
				const incarnation = await transact(database, "readwrite", async (transaction) => {
					await sweep(transaction, Date.now());
					const existing = await recorded(transaction, declaration);
					if (existing !== undefined) return existing.incarnation;
					await mutable(transaction);
					const incarnation = crypto.randomUUID();
					transaction.objectStore("scopes").add({
						...declaration.scope,
						chunkCount: declaration.chunks.length,
						exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
						expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
						state: "open",
						totalBytes: declaration.totalBytes,
						retention: "temporary",
						incarnation,
						descriptors: declaration.chunks,
					} satisfies ScopeRow);
					return incarnation;
				});
				let released = false,
					canceled = false;
				const ensureSession = (): void => {
					if (released || terminated) throw failure("closed", "snapshot quarantine scope is closed");
				};
				const descriptorAt = (input: unknown): SnapshotChunkDescriptor => {
					const descriptor = captureDescriptor(input),
						expected = declaration.chunks[descriptor.index];
					if (
						expected === undefined ||
						expected.digest !== descriptor.digest ||
						expected.byteLength !== descriptor.byteLength
					)
						throw failure("malformed-input", "snapshot chunk descriptor is foreign to this scope");
					return expected;
				};
				const liveRow = async (transaction: IDBTransaction): Promise<ScopeRow> => {
					const row = await recorded(transaction, declaration, incarnation);
					if (row === undefined) throw failure("expired", "snapshot quarantine scope is absent");
					return row;
				};
				const verificationQuarantine: SnapshotVerificationQuarantine = Object.freeze({
					open(portSignal: AbortSignal): SnapshotQuarantinePort {
						ensureSession();
						if (closed) throw failure("closed", "snapshot quarantine store is closed");
						let portClosed = false;
						const ensurePort = (): void => {
							ensureSession();
							if (portClosed) throw failure("closed", "snapshot quarantine port is closed");
							throwIfAborted(portSignal);
						};
						return Object.freeze({
							discard: () => {
								portClosed = true;
								return Promise.resolve();
							},
							read: (input: SnapshotChunkDescriptor) =>
								promiseCapture(() => {
									const descriptor = descriptorAt(input);
									ensurePort();
									return schedule(() =>
										transact(database, "readonly", async (transaction) => {
											ensurePort();
											if ((await recorded(transaction, declaration, incarnation)) === undefined) return undefined;
											const row = (await requestResult(
												transaction.objectStore("chunks").get(chunkKey(declaration.scope, descriptor.index))
											)) as ChunkRow | undefined;
											if (row === undefined) return undefined;
											const bytes = exactBytes(row.exactBytes, "persisted snapshot chunk", descriptor.byteLength);
											if (
												row.digest !== descriptor.digest ||
												row.byteLength !== descriptor.byteLength ||
												bytes.byteLength !== descriptor.byteLength
											)
												throw failure("poisoned", "snapshot quarantine chunk row is corrupt");
											return bytes;
										})
									);
								}),
							write: (input: SnapshotChunkDescriptor, bytesInput: Uint8Array) =>
								promiseCapture(() => {
									const descriptor = descriptorAt(input),
										bytes = exactBytes(bytesInput, "snapshot chunk", descriptor.byteLength);
									if (bytes.byteLength !== descriptor.byteLength)
										throw failure("malformed-input", "snapshot chunk length is invalid");
									ensurePort();
									return schedule(async () => {
										const conflict = await transact(database, "readwrite", async (transaction) => {
											ensurePort();
											const row = await liveRow(transaction);
											await mutable(transaction);
											if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
												throw failure("poisoned", "snapshot quarantine is poisoned");
											if (row.state === "verified")
												throw failure("closed", "verified snapshot quarantine is immutable");
											const chunks = transaction.objectStore("chunks"),
												scopes = transaction.objectStore("scopes");
											const existing = (await requestResult(
												chunks.get(chunkKey(declaration.scope, descriptor.index))
											)) as ChunkRow | undefined;
											if (existing !== undefined) {
												if (
													existing.digest !== descriptor.digest ||
													existing.byteLength !== descriptor.byteLength ||
													!sameBytes(existing.exactBytes, bytes)
												) {
													scopes.put({ ...row, state: "poisoned" } satisfies ScopeRow);
													return true;
												}
												return false;
											}
											chunks.add({
												...declaration.scope,
												byteLength: descriptor.byteLength,
												digest: descriptor.digest,
												exactBytes: bytes,
												index: descriptor.index,
											} satisfies ChunkRow);
											scopes.put({
												...row,
												expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
											} satisfies ScopeRow);
											return false;
										});
										if (conflict) throw failure("conflict", "snapshot chunk conflicts with occupied bytes");
									});
								}),
						});
					},
				});
				const queryStatus = (options: Readonly<{ signal?: AbortSignal }> = {}): Promise<SnapshotQuarantineStatus> =>
					promiseCapture(() => {
						const signal = options.signal;
						ensureSession();
						throwIfAborted(signal);
						return schedule(() =>
							transact(database, "readonly", async (transaction) => {
								ensureSession();
								throwIfAborted(signal);
								return statusOf(transaction, declaration, await liveRow(transaction));
							})
						);
					});
				const scope: SnapshotQuarantineScope<SnapshotVerificationReceipt> = Object.freeze({
					scope: declaration.scope,
					verificationQuarantine,
					release: () => {
						released = true;
						return Promise.resolve();
					},
					retainForRecovery: (options: Readonly<{ readonly signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const signal = options.signal;
							ensureSession();
							throwIfAborted(signal);
							return schedule(() => {
								ensureSession();
								throwIfAborted(signal);
								return transact(
									database,
									"readwrite",
									async (transaction) => {
										const row = await liveRow(transaction);
										const owner = await ownerStatus(transaction);
										if (owner.migration !== "ready")
											throw failure("migration-required", "snapshot legacy classification is required");
										if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
											throw failure("poisoned", "snapshot quarantine is poisoned");
										if (row.retention === "temporary" && row.expiresAt <= Date.now())
											throw failure("expired", "temporary snapshot quarantine has expired");
										if (row.state !== "verified") throw failure("incomplete", "snapshot quarantine is not verified");
										await validateRecoveryClosure(transaction, declaration);
										if (row.retention === "recovery") return;
										const recoveryScopes = snapshotQuarantineContract.addRecoveryContentBytes(owner.recoveryScopes, 1);
										const recoveryContentBytes = snapshotQuarantineContract.addRecoveryContentBytes(
											owner.recoveryContentBytes,
											snapshotQuarantineContract.recoveryContentBytes(
												declaration.totalBytes,
												declaration.exactCanonicalManifestBytes.byteLength
											)
										);
										if (
											recoveryScopes > owner.limits.maxRecoveryScopes ||
											recoveryContentBytes > owner.limits.maxRecoveryContentBytes
										)
											throw failure("recovery-full", "snapshot recovery capacity is full");
										await requestResult(
											transaction.objectStore("scopes").put({ ...row, retention: "recovery" } satisfies ScopeRow)
										);
										await requestResult(
											transaction
												.objectStore("owner")
												.put({ ...owner, id: "owner", recoveryScopes, recoveryContentBytes } satisfies OwnerRow)
										);
									},
									{ signal, requireStrictDurability: true }
								);
							});
						}),
					status: queryStatus,
					missingIndices: (options: Readonly<{ signal?: AbortSignal }> = {}) =>
						queryStatus(options).then((status) => status.missingIndices),
					cancel: (options: Readonly<{ signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const signal = options.signal;
							ensureSession();
							throwIfAborted(signal);
							if (closed) throw failure("closed", "snapshot quarantine store is closed");
							if (canceled) return Promise.resolve();
							return schedule(async () => {
								ensureSession();
								throwIfAborted(signal);
								await transact(database, "readwrite", async (transaction) => {
									const row = await recorded(transaction, declaration, incarnation);
									await mutable(transaction);
									if (row?.retention === "recovery")
										throw failure("recovery-owned", "snapshot recovery ownership prevents cancellation");
									await deleteScope(transaction, declaration.scope);
								});
								canceled = true;
							});
						}),
					complete: (receipt: SnapshotVerificationReceipt, options: Readonly<{ signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const signal = options.signal;
							ensureSession();
							throwIfAborted(signal);
							return schedule(() =>
								transact(database, "readwrite", async (transaction) => {
									ensureSession();
									throwIfAborted(signal);
									const row = await liveRow(transaction);
									await mutable(transaction);
									if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
										throw failure("poisoned", "snapshot quarantine is poisoned");
									if (row.state !== "open" && row.state !== "verified")
										throw failure("poisoned", "snapshot quarantine state is invalid");
									const status = await statusOf(transaction, declaration, row);
									const count = await requestResult(
										transaction.objectStore("chunks").count(chunkRange(declaration.scope))
									);
									if (status.missingIndices.length !== 0 || count !== declaration.chunks.length)
										throw failure("incomplete", "snapshot quarantine is incomplete");
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
									)
										throw failure("receipt-invalid", "snapshot verification completion does not match the scope");
									if (row.state === "open")
										transaction.objectStore("scopes").put({ ...row, state: "verified" } satisfies ScopeRow);
									return Object.freeze({
										chunkCount: declaration.chunks.length,
										exactByteLength: declaration.totalBytes,
										scope: declaration.scope,
									}) satisfies VerifiedSnapshotQuarantineReference;
								})
							);
						}),
				});
				return scope;
			});
		});
	const sweepExpired: SnapshotQuarantineStore<SnapshotVerificationReceipt>["sweepExpired"] = (options = {}) =>
		promiseCapture(() => {
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				transact(database, "readwrite", async (transaction) => {
					throwIfAborted(signal);
					return sweep(transaction, Date.now());
				})
			);
		});
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closed = true;
		closing = tail.then(() => {
			terminated = true;
			database.close();
		});
		return closing;
	};
	return Object.freeze({
		close,
		inspectRecovery,
		lookupRecoveryDeclaration,
		acquireRecoveryRead,
		recoveryStatus,
		openScope,
		sweepExpired,
	});
}
