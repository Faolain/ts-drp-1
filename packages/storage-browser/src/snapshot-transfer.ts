import { encodeCanonical } from "@ts-drp/canonical";
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
	type SnapshotRecoveryProtection,
	type SnapshotRecoveryRoleInventory,
	type SnapshotRecoveryStore,
	snapshotRetirementContract,
	type SnapshotRetirementControl,
	type SnapshotRetirementControlRead,
	type SnapshotRetirementImage,
	type SnapshotVerificationQuarantine,
	type SnapshotVerificationReceipt,
	type VerifiedSnapshotQuarantineReference,
} from "@ts-drp/storage/snapshot-transfer";
import {
	roomRetentionControlDigest,
	RoomRetentionRefusal,
	type RoomRetentionLabels,
	type RoomRetentionProofBook,
	type RoomRetentionSelection,
} from "@ts-drp/storage";

import {
	isNativeReadReservationTransaction,
	nativeReadonlyTransaction,
	nativeReadReservationCheck,
	NativeReadReservationOwner,
	needsNativeReadReservationTurn,
	type RoomRetirementSession,
	runNativeReservedRead,
	visitCountedRange,
} from "./internal/native-read-reservation.js";
import {
	chargeRetentionRow,
	type RoomRetentionContext,
	type RoomRetentionDraftDelete,
	type RoomRetentionDraftRewrite,
	type RoomRetentionSection,
	type RoomRetentionSectionDraft,
	type RoomRetentionTarget,
	retentionStale,
	retentionValueDigest,
} from "./internal/room-retention.js";
import { openBrowserRoomOwnerConnection, roomStoreName, roomStoreNames } from "./internal/schema-idb.js";

export interface BrowserSnapshotQuarantineStoreOptions {
	readonly primaryDatabaseName: string;
	readonly recoveryLimits?: SnapshotRecoveryLimits;
}

type ScopeRow = Readonly<{
	readonly exactReceivedCertificateWrapperBytes: Uint8Array | null;
	readonly retention: SnapshotQuarantineStatus["retention"];
	readonly incarnation: string;
	readonly descriptors: readonly SnapshotChunkDescriptor[] | Readonly<Record<string, unknown>> | null;
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
		const request = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "chunks")).openCursor(range);
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

function strictTransaction(
	database: IDBDatabase,
	logical: readonly string[],
	mode: IDBTransactionMode
): IDBTransaction {
	// Logical snapshot store names; a room connection names them in the snapshot namespace (14a).
	const stores = roomStoreNames(database, "snapshot", logical);
	return mode === "readonly"
		? nativeReadonlyTransaction(database, stores)
		: database.transaction(stores, mode, { durability: "strict" });
}

type OwnerRow = SnapshotRecoveryOwnerStatus & Readonly<{ id: "owner" }>;
function sameKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}
function admitSchema(database: IDBDatabase, transaction: IDBTransaction, version: 1 | 2 | 3 | 4): void {
	const names =
		version === 1
			? ["chunks", "scopes"]
			: version === 4
				? ["chunks", "owner", "retirementControls", "scopes"]
				: ["chunks", "owner", "scopes"];
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
	if (version >= 2) {
		const owner = transaction.objectStore("owner");
		if (owner.keyPath !== "id" || owner.autoIncrement || owner.indexNames.length !== 0)
			throw failure("unsupported-schema", "browser snapshot owner schema is unsupported");
	}
	if (version === 4) {
		const control = transaction.objectStore("retirementControls");
		if (control.keyPath !== null || control.autoIncrement || control.indexNames.length !== 0)
			throw failure("unsupported-schema", "snapshot retirement control schema is unsupported");
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
		const request = indexedDB.open(name, 4);
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
				if (event.oldVersion === 3) {
					admitSchema(database, transaction, 3);
					database.createObjectStore("retirementControls");
					return;
				}
				if (event.oldVersion === 2) {
					admitSchema(database, transaction, 2);
					database.createObjectStore("retirementControls");
					const cursorRequest = transaction.objectStore("scopes").openCursor();
					cursorRequest.addEventListener("success", () => {
						try {
							const cursor = cursorRequest.result;
							if (cursor === null) return;
							const raw = cursor.value as Record<string, unknown>;
							if (Object.hasOwn(raw, "exactReceivedCertificateWrapperBytes"))
								throw failure("poisoned", "version two scope has unowned certificate fields");
							const row = fromScopeRow({ ...raw, exactReceivedCertificateWrapperBytes: null });
							cursor.update(row);
							cursor.continue();
						} catch (error) {
							upgradeError = error;
							transaction.abort();
						}
					});
					return;
				}
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
				database.createObjectStore("retirementControls");
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
							exactReceivedCertificateWrapperBytes: null,
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
	if (mode === "readonly" && needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => transact(database, mode, operation, options));
	const transaction = strictTransaction(database, ["chunks", "owner", "retirementControls", "scopes"], mode);
	if (isNativeReadReservationTransaction(transaction)) {
		throwIfAborted(options.signal);
		const result = await operation(transaction);
		await nativeReadReservationCheck(transaction);
		throwIfAborted(options.signal);
		return result;
	}
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
	const store = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "owner"));
	const [raw, count] = await Promise.all([requestResult(store.get("owner")), requestResult(store.count())]);
	if (
		count !== 1 ||
		(!exactRecord(raw, [
			"id",
			"limits",
			"recoveryScopes",
			"recoveryContentBytes",
			"legacyUnclassifiedScopes",
			"legacyUnclassifiedContentBytes",
			"migration",
		]) &&
			!exactRecord(raw, [
				"id",
				"limits",
				"recoveryScopes",
				"recoveryContentBytes",
				"legacyUnclassifiedScopes",
				"legacyUnclassifiedContentBytes",
				"migration",
				"classificationIntent",
			])) ||
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
	const classificationIntent = Object.hasOwn(raw, "classificationIntent")
		? snapshotQuarantineContract.captureClassificationIntent(raw.classificationIntent)
		: undefined;
	if (classificationIntent !== undefined) {
		const bytes = await requestResult(
			transaction
				.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
				.get(classificationIntent.objectId)
		);
		if (bytes === undefined) throw failure("poisoned", "snapshot inherited intent control is absent");
		const control = snapshotRetirementContract.decodeControl(bytes);
		if (
			control.objectId !== classificationIntent.objectId ||
			control.active !== null ||
			control.completed === null ||
			control.completed.decisionDigest !== classificationIntent.decisionDigest ||
			control.completed.sourceProofDigest !== classificationIntent.sourceProofDigest
		)
			throw failure("poisoned", "snapshot inherited intent control disagrees with its pointer");
	}
	const migration =
		legacyUnclassifiedScopes === 0 && classificationIntent === undefined ? "ready" : "classification-required";
	if (raw.migration !== migration)
		throw failure("unsupported-schema", "browser snapshot owner migration state is unsupported");
	return Object.freeze({
		limits,
		recoveryScopes,
		recoveryContentBytes,
		legacyUnclassifiedScopes,
		legacyUnclassifiedContentBytes,
		migration,
		...(classificationIntent === undefined ? {} : { classificationIntent }),
	});
}

async function deleteChunks(transaction: IDBTransaction, scope: SnapshotQuarantineScopeKey): Promise<void> {
	const chunks = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"));
	const keys = await requestResult(chunks.getAllKeys(chunkRange(scope)));
	for (const key of keys) chunks.delete(key);
}

async function deleteScope(transaction: IDBTransaction, scope: SnapshotQuarantineScopeKey): Promise<void> {
	const bytes = await requestResult(
		transaction.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls")).get(scope.objectId)
	);
	if (bytes !== undefined) {
		const control = snapshotRetirementContract.decodeControl(bytes),
			raw = await requestResult(
				transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).get(scopeKey(scope))
			);
		if (control.objectId !== scope.objectId) throw failure("poisoned", "snapshot retirement control key disagrees");
		if (
			raw !== undefined &&
			snapshotRetirementContract.protected(
				control,
				snapshotQuarantineContract.captureScope({
					objectId: scope.objectId,
					epoch: scope.epoch,
					anchor: scope.anchor,
					manifestDigest: scope.manifestDigest,
				}),
				fromScopeRow(raw).incarnation
			)
		)
			throw failure("recovery-owned", "snapshot native protected hole cannot be deleted");
	}
	await deleteChunks(transaction, scope);
	transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).delete(scopeKey(scope));
}

function fromScopeRow(value: unknown): ScopeRow {
	if (
		!exactRecord(value, [
			"exactReceivedCertificateWrapperBytes",
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
	const certificate = snapshotQuarantineContract.openReceivedCertificate(
		row.incarnation,
		row.exactReceivedCertificateWrapperBytes
	);
	if (certificate !== null && (row.retention !== "recovery" || row.state !== "verified"))
		throw failure("poisoned", "certificate is not owned by verified recovery custody");
	if (
		typeof row.incarnation !== "string" ||
		row.incarnation.length === 0 ||
		!["open", "verified", "poisoned"].includes(row.state) ||
		!["temporary", "recovery", "legacy-unclassified"].includes(row.retention) ||
		(row.retention === "legacy-unclassified") !== (row.descriptors === null) ||
		(row.descriptors !== null &&
			!Array.isArray(row.descriptors) &&
			!exactRecord(row.descriptors, ["kind", "version", "chunks", "retirement"]))
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
			candidate.version !== 4 ||
			JSON.stringify([...candidate.objectStoreNames]) !==
				JSON.stringify(["chunks", "owner", "retirementControls", "scopes"])
		) {
			throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
		}
		await transact(candidate, "readonly", async (transaction) => {
			admitSchema(candidate, transaction, 4);
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
	return createSnapshotStoreOver(acquired, primaryDatabaseName);
}

/**
 * Opens the snapshot owner inside a ready version-7 room database (slice 14a). Every
 * operation, row format and refusal is the dedicated store's; only its stores live in
 * the `snapshot:` namespace and its held read views cover only that namespace. It never
 * creates or upgrades the room database. The owner row is written once, on the first
 * open of an empty namespace, exactly as the dedicated database's creation writes it.
 * @param options - The room database name and optional durable policy.
 * @returns The admitted snapshot quarantine owner.
 */
export async function createBrowserRoomSnapshotQuarantineStore(
	options: Readonly<{ databaseName: string; recoveryLimits?: SnapshotRecoveryLimits }>
): Promise<SnapshotRecoveryStore<SnapshotVerificationReceipt>> {
	if (!exactRecord(options, ["databaseName"]) && !exactRecord(options, ["databaseName", "recoveryLimits"]))
		throw failure("malformed-input", "browser snapshot quarantine options are malformed");
	const databaseName = options.databaseName;
	if (typeof databaseName !== "string" || databaseName === "")
		throw failure("malformed-input", "browser snapshot quarantine options are malformed");
	const recoveryLimits = Object.prototype.hasOwnProperty.call(options, "recoveryLimits")
		? snapshotQuarantineContract.captureRecoveryLimits(options.recoveryLimits)
		: undefined;
	let acquired: IDBDatabase | undefined;
	try {
		try {
			acquired = await openBrowserRoomOwnerConnection(databaseName, "snapshot");
		} catch (error) {
			throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported", error);
		}
		const candidate = acquired;
		const initialized = await transact(candidate, "readonly", async (transaction) =>
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "snapshot", "owner")).count())
		);
		if (initialized === 0)
			await transact(
				candidate,
				"readwrite",
				async (transaction) => {
					const owner = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "owner"));
					if ((await requestResult(owner.count())) !== 0) return;
					// An owner row is absent only before the first open of an empty namespace.
					const scopes = await requestResult(
						transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).count()
					);
					if (scopes !== 0) throw failure("poisoned", "snapshot owner row is missing");
					await requestResult(
						owner.add(initialOwner(recoveryLimits ?? snapshotQuarantineContract.defaultRecoveryLimits))
					);
				},
				{ requireStrictDurability: true }
			);
		await transact(candidate, "readonly", async (transaction) => {
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
	return createSnapshotStoreOver(acquired, databaseName, true);
}

function createSnapshotStoreOver(
	database: IDBDatabase,
	primaryDatabaseName: string,
	room = false
): SnapshotRecoveryStore<SnapshotVerificationReceipt> {
	const readReservations = new NativeReadReservationOwner(database);
	let closed = false,
		terminated = false,
		closing: Promise<void> | undefined;
	let tail = Promise.resolve();
	type BorrowedExclusion = { check(): Promise<void>; release(): Promise<void> };
	const dependencyGuards = new Set<{
		invalidate(): void;
		join(): Promise<void>;
		owns(scopes: readonly SnapshotQuarantineScopeKey[]): boolean;
		borrow(): BorrowedExclusion;
		protection: SnapshotRecoveryProtection;
	}>();
	const dependencyName = (scope: SnapshotQuarantineScopeKey): string =>
		`ts-drp:snapshot-recovery-dependency:v1:${JSON.stringify([primaryDatabaseName, scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest])}`;
	let locks: LockManager | undefined;
	let requestLock: LockManager["request"] | undefined;
	try {
		locks = typeof navigator === "undefined" ? undefined : navigator.locks;
		requestLock = locks?.request;
	} catch {
		// An inaccessible optional host capability is unsupported, never a lease.
		locks = undefined;
		requestLock = undefined;
	}
	database.addEventListener("versionchange", () => {
		closed = true;
		terminated = true;
		for (const guard of dependencyGuards) guard.invalidate();
		void readReservations.close().catch(() => undefined);
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
	const readControl = async (
		transaction: IDBTransaction,
		objectId: string
	): Promise<SnapshotRetirementControl | null> => {
		const bytes = await requestResult(
			transaction.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls")).get(objectId)
		);
		if (bytes === undefined) return null;
		const control = snapshotRetirementContract.decodeControl(bytes);
		if (control.objectId !== objectId) throw failure("poisoned", "snapshot retirement control key disagrees");
		return control;
	};
	const guardScope = async (
		transaction: IDBTransaction,
		scope: SnapshotQuarantineScopeKey,
		incarnation?: string
	): Promise<void> => {
		if (!snapshotRetirementContract.allows(await readControl(transaction, scope.objectId), scope, incarnation))
			throw failure("stale-scope", "snapshot scope is retired");
	};
	const nativeImage = async (
		transaction: IDBTransaction,
		objectId: string,
		classificationSource = false
	): Promise<SnapshotRetirementImage> => {
		const owner = await ownerStatus(transaction);
		const restoredOwner = classificationSource ? snapshotQuarantineContract.classificationSourceOwner(owner) : owner;
		const remaining = new Set(
			classificationSource ? owner.classificationIntent!.promoted.map((row) => JSON.stringify(scopeKey(row.scope))) : []
		);
		// Exact bounded observations also cover inherited debt. This read is not
		// classification authority; all scope mutation admission remains closed.
		const range = IDBKeyRange.bound([objectId], [objectId + "\0"], false, true);
		const [count, chunkCount] = await Promise.all([
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).count(range)),
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "snapshot", "chunks")).count(range)),
		]);
		if (count > snapshotRetirementContract.maxScopes || chunkCount > snapshotRetirementContract.maxChunks)
			throw failure("recovery-full", "snapshot retirement capture exceeds native entitlement");
		let imageDigest = snapshotRetirementContract.imageDigest({ objectId, owner: restoredOwner }),
			metadataBytes = 0,
			presentBytes = 0;
		const scopes: SnapshotRetirementImage["scopes"][number][] = [];
		const declarations = new Map<string, SnapshotQuarantineDeclaration>();
		const cursor = async (store: string, visit: (value: unknown, key: IDBValidKey) => void): Promise<void> =>
			new Promise((resolve, reject) => {
				const request = transaction.objectStore(roomStoreName(transaction.db, "snapshot", store)).openCursor(range);
				request.addEventListener("error", () => reject(request.error));
				request.addEventListener("success", () => {
					try {
						const value = request.result;
						if (value === null) {
							resolve();
							return;
						}
						visit(value.value, value.primaryKey);
						value.continue();
					} catch (error) {
						reject(error);
					}
				});
			});
		// Scope metadata rows are bounded by the count above: visit the counted
		// range in bounded pages in this SAME transaction, in cursor order.
		await visitCountedRange(
			transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")),
			range,
			count + 1,
			(value, key) => {
				const row = fromScopeRow(value),
					scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
						objectId: row.objectId,
						epoch: row.epoch,
						anchor: row.anchor,
						manifestDigest: row.manifestDigest,
					});
				if (row.objectId !== objectId || JSON.stringify(key) !== JSON.stringify(scopeKey(scope)))
					throw failure("poisoned", "snapshot retirement scope key disagrees");
				const observation = snapshotQuarantineContract.validateRecoveryManifest(scope, row);
				const prior = classificationSource
					? owner.classificationIntent!.promoted.find(
							(pair) => JSON.stringify(scopeKey(pair.scope)) === JSON.stringify(scopeKey(scope))
						)
					: undefined;
				if (
					prior !== undefined &&
					(row.retention !== "recovery" ||
						row.state !== "verified" ||
						row.incarnation !== prior.incarnation ||
						observation.declaration.totalBytes + row.exactCanonicalManifestBytes.byteLength !== prior.contentBytes ||
						JSON.stringify(row.descriptors) !== JSON.stringify(observation.declaration.chunks))
				)
					throw failure("poisoned", "snapshot inherited postimage disagrees with exact source subset");
				const sourceRow = prior === undefined ? row : { ...row, retention: "legacy-unclassified", descriptors: null };
				if (prior !== undefined) remaining.delete(JSON.stringify(scopeKey(scope)));
				metadataBytes += encodeCanonical(sourceRow, { maxDepth: 8, maxItems: 32768 }).byteLength;
				if (metadataBytes > snapshotRetirementContract.maxImageBytes)
					throw failure("recovery-full", "snapshot retirement metadata exceeds native entitlement");
				declarations.set(JSON.stringify(scopeKey(scope)), observation.declaration);
				scopes.push(Object.freeze({ scope, incarnation: row.incarnation }));
				imageDigest = snapshotRetirementContract.imageDigest({ prior: imageDigest, row: sourceRow });
			}
		);
		if (remaining.size !== 0) throw failure("incomplete", "snapshot inherited source subset is missing");
		await cursor("chunks", (value, key) => {
			if (
				!exactRecord(value, [
					"anchor",
					"byteLength",
					"digest",
					"epoch",
					"exactBytes",
					"index",
					"manifestDigest",
					"objectId",
				])
			)
				throw failure("poisoned", "snapshot retirement chunk shape is invalid");
			const row = value as unknown as ChunkRow;
			const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
					objectId: row.objectId,
					epoch: row.epoch,
					anchor: row.anchor,
					manifestDigest: row.manifestDigest,
				}),
				declaration = declarations.get(JSON.stringify(scopeKey(scope)));
			if (
				row.objectId !== objectId ||
				declaration === undefined ||
				JSON.stringify(key) !== JSON.stringify(chunkKey(scope, row.index))
			)
				throw failure("poisoned", "snapshot retirement chunk is orphaned or mismatched");
			const descriptor = { index: row.index, digest: row.digest, byteLength: row.byteLength };
			snapshotQuarantineContract.validateRecoveryChunk(declaration, descriptor, row.exactBytes);
			presentBytes += row.exactBytes.byteLength;
			if (presentBytes > snapshotQuarantineContract.limits.maxSnapshotBytes)
				throw failure("recovery-full", "snapshot retirement chunks exceed native entitlement");
			imageDigest = snapshotRetirementContract.imageDigest({
				prior: imageDigest,
				key: scopeKey(scope),
				index: descriptor.index,
				digest: descriptor.digest,
				byteLength: descriptor.byteLength,
			});
		});
		return Object.freeze({ imageDigest, scopeCount: count, chunkCount, metadataBytes, scopes: Object.freeze(scopes) });
	};
	const sweep = async (transaction: IDBTransaction, now: number): Promise<number> => {
		if ((await ownerStatus(transaction)).migration !== "ready") return 0;
		const scopes = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"));
		let deleted = 0;
		const visit = async (row: ScopeRow): Promise<void> => {
			if (row.retention === "temporary") {
				const selected = snapshotQuarantineContract.captureScope({
						objectId: row.objectId,
						epoch: row.epoch,
						anchor: row.anchor,
						manifestDigest: row.manifestDigest,
					}),
					control = await readControl(transaction, row.objectId);
				if (
					!snapshotRetirementContract.allows(control, selected, row.incarnation) ||
					snapshotRetirementContract.protected(control, selected, row.incarnation)
				)
					return;
				await deleteScope(transaction, row);
				deleted += 1;
			}
		};
		// Advance only after this row's original protected-control checks and
		// native deletion requests finish. Retain no expired-cohort array; the
		// original transaction still commits all selected deletions atomically.
		await new Promise<void>((resolve, reject) => {
			const request = scopes.index("expiryAsc").openCursor(IDBKeyRange.upperBound(now));
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => {
				const cursor = request.result;
				if (cursor === null) {
					resolve();
					return;
				}
				void visit(cursor.value as ScopeRow)
					.then(() => cursor.continue())
					.catch(reject);
			});
		});
		return deleted;
	};
	const recorded = async (
		transaction: IDBTransaction,
		declaration: CapturedDeclaration,
		incarnation?: string
	): Promise<ScopeRow | undefined> => {
		const raw = await requestResult(
			transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).get(selectorRange(declaration.scope))
		);
		if (raw === undefined) return undefined;
		const row = fromScopeRow(raw);
		if (incarnation !== undefined && row.incarnation !== incarnation)
			throw failure("stale-scope", "snapshot quarantine handle belongs to an earlier incarnation");
		if (transaction.mode === "readwrite") await guardScope(transaction, declaration.scope, row.incarnation);
		if (
			row.manifestDigest !== declaration.scope.manifestDigest ||
			!sameBytes(row.exactCanonicalManifestBytes, declaration.exactCanonicalManifestBytes) ||
			row.totalBytes !== declaration.totalBytes ||
			row.chunkCount !== declaration.chunks.length ||
			(row.descriptors !== null &&
				JSON.stringify(
					snapshotQuarantineContract.captureRecoveryDescriptorCarrier(
						row.descriptors,
						declaration.scope,
						row.incarnation
					).chunks
				) !== JSON.stringify(declaration.chunks))
		)
			throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
		if (row.descriptors === null) {
			await new Promise<void>((resolve, reject) => {
				const request = transaction
					.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
					.openCursor(chunkRange(declaration.scope));
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
		const keys = await requestResult(
			transaction
				.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
				.getAllKeys(chunkRange(declaration.scope))
		);
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
		const scopes = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"));
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
	const acquireDependencyLocks = async (
		scopes: readonly SnapshotQuarantineScopeKey[],
		mode: "shared" | "exclusive"
	): Promise<SnapshotRecoveryProtection> => {
		if (closed) throw failure("closed", "snapshot quarantine store is closed");
		if (typeof requestLock !== "function" || locks === undefined)
			throw failure("recovery-full", "snapshot retirement exclusion is unsupported");
		let alive = true;
		let nativeFailed = false;
		let finishAcquisition!: () => void;
		const acquisitionFinished = new Promise<void>((resolve) => {
			finishAcquisition = resolve;
		});
		let unlock!: () => void;
		const held = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const names = new Set<string>();
		const admitted = new Set<Promise<void>>();
		const requests: Promise<PromiseSettledResult<void>>[] = [];
		const invalidate = (): void => {
			alive = false;
			if (admitted.size === 0) unlock();
		};
		const joinRequests = async (): Promise<void> => {
			const settled = await Promise.all(requests);
			const causes = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason as unknown] : []));
			if (causes.length === 1) throw causes[0];
			if (causes.length > 1)
				throw new AggregateError(causes, "snapshot dependency lock release failed", { cause: causes[0] });
		};
		let releasing: Promise<void> | undefined;
		const release = (): Promise<void> => {
			invalidate();
			return (releasing ??= acquisitionFinished
				.then(async () => {
					await Promise.all([...admitted]);
					await joinRequests();
				})
				.finally(() => {
					dependencyGuards.delete(owner);
				}));
		};
		const protection: SnapshotRecoveryProtection = Object.freeze({
			check: function (this: SnapshotRecoveryProtection): Promise<void> {
				return promiseCapture(() => {
					if (this !== protection) throw failure("invalid-carrier", "snapshot protection is foreign or copied");
					if (!alive || closed || names.size !== scopes.length)
						throw failure("stale-scope", "snapshot dependency lock is no longer held");
					return Promise.resolve();
				});
			},
			release: function (this: SnapshotRecoveryProtection): Promise<void> {
				return promiseCapture(() => {
					if (this !== protection) throw failure("invalid-carrier", "snapshot protection is foreign or copied");
					return release();
				});
			},
		});
		const owner = {
			invalidate,
			join: release,
			protection,
			owns: (selected: readonly SnapshotQuarantineScopeKey[]): boolean =>
				mode === "exclusive" &&
				alive &&
				!closed &&
				names.size === scopes.length &&
				selected.every((scope) => names.has(dependencyName(scope))),
			borrow: (): BorrowedExclusion => {
				if (mode !== "exclusive" || !alive || closed || nativeFailed || names.size !== scopes.length)
					throw failure("stale-scope", "snapshot retirement lock is no longer admitted");
				let finish!: () => void;
				const pending = new Promise<void>((resolve) => {
					finish = resolve;
				});
				admitted.add(pending);
				let completed = false;
				return {
					// Public invalidation prevents new admissions, but an already
					// admitted native transaction retains its physical lock through readback.
					check: (): Promise<void> =>
						promiseCapture(() => {
							if (completed || nativeFailed || names.size !== scopes.length)
								throw failure("stale-scope", "snapshot retirement lock was lost");
							return Promise.resolve();
						}),
					release: (): Promise<void> => {
						if (!completed) {
							completed = true;
							admitted.delete(pending);
							finish();
							if (!alive && admitted.size === 0) unlock();
						}
						return Promise.resolve();
					},
				};
			},
		};
		dependencyGuards.add(owner);
		try {
			for (const scope of scopes) {
				if (!alive || closed) throw failure("closed", "snapshot quarantine store is closed");
				// A closed primitive tuple is unambiguous and includes the actual
				// native database identity. Web Locks supplies the browser partition.
				const name = dependencyName(scope);
				let grant!: () => void;
				let refuse!: (cause: unknown) => void;
				const granted = new Promise<void>((resolve, reject) => {
					grant = resolve;
					refuse = reject;
				});
				const requested = Reflect.apply(requestLock, locks, [
					name,
					{ mode, ifAvailable: true },
					async (lock: Lock | null) => {
						if (lock === null) {
							refuse(failure("recovery-full", "snapshot dependency is held by another operation"));
							return;
						}
						if (!alive || closed) {
							refuse(failure("closed", "snapshot quarantine store is closed"));
							return;
						}
						if (lock.name !== name || lock.mode !== mode) {
							refuse(failure("storage-failed", "snapshot dependency lock grant is foreign"));
							return;
						}
						names.add(name);
						grant();
						try {
							await held;
						} finally {
							names.delete(name);
						}
					},
				]) as Promise<void>;
				requests.push(
					Promise.resolve(requested).then(
						() => ({ status: "fulfilled" as const, value: undefined }),
						(reason: unknown) => {
							nativeFailed = true;
							invalidate();
							refuse(reason);
							return { status: "rejected" as const, reason };
						}
					)
				);
				await granted;
			}
			await schedule(() =>
				transact(database, "readonly", async (transaction) => {
					await protection.check();
					for (const scope of scopes) {
						const metadata = await readRecoveryMetadata(transaction, scope);
						if (
							metadata === undefined ||
							!["recovery", "legacy-unclassified"].includes(metadata.observation.retention) ||
							metadata.observation.state !== "verified"
						)
							throw failure("stale-scope", "snapshot dependency is not verified native recovery custody");
					}
					await protection.check();
				})
			);
			await protection.check();
			return protection;
		} catch (primary) {
			invalidate();
			try {
				await joinRequests();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "snapshot lock acquisition and release failed", {
					cause: primary,
				});
			}
			throw primary;
		} finally {
			finishAcquisition();
			if (!alive) dependencyGuards.delete(owner);
		}
	};
	const acquireRecoveryDependencyProtection: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryDependencyProtection"]
	> = (input) =>
		promiseCapture(() => {
			const scope = snapshotQuarantineContract.captureRecoveryDependencyScope(input);
			if (closed) throw failure("closed", "snapshot quarantine store is closed");
			if (typeof requestLock !== "function") return Promise.resolve(Object.freeze({ kind: "unsupported" as const }));
			return acquireDependencyLocks([scope], "shared").then((protection) =>
				Object.freeze({ kind: "held" as const, protection })
			);
		});
	const acquireRecoveryRetirementExclusion: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryRetirementExclusion"]
	> = (input) =>
		promiseCapture(() =>
			acquireDependencyLocks(snapshotQuarantineContract.captureRecoveryRetirementScopes(input), "exclusive")
		);
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
						const scopes = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"));
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
	const lookupReceivedRecoveryCertificate: SnapshotRecoveryStore<SnapshotVerificationReceipt>["lookupReceivedRecoveryCertificate"] =
		(input) =>
			promiseCapture(() => {
				const selector = snapshotQuarantineContract.captureRecoverySelector(input);
				return schedule(() =>
					transact(database, "readonly", async (transaction) => {
						const rows = await requestResult(
							transaction
								.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
								.getAll(recoverySelectorRange({ ...selector, manifestDigest: "0".repeat(64) }), 2)
						);
						if (rows.length > 1) throw failure("conflict", "snapshot recovery identity has ambiguous custody");
						if (rows.length === 0) return null;
						const row = fromScopeRow(rows[0]);
						if (row.objectId !== selector.objectId || row.epoch !== selector.epoch || row.anchor !== selector.anchor)
							throw failure("poisoned", "snapshot recovery selector disagrees with native identity");
						const scope = snapshotQuarantineContract.captureScope({
							objectId: row.objectId,
							epoch: row.epoch,
							anchor: row.anchor,
							manifestDigest: row.manifestDigest,
						});
						snapshotQuarantineContract.validateRecoveryManifest(scope, row);
						const bytes = snapshotQuarantineContract.openReceivedCertificate(
							row.incarnation,
							row.exactReceivedCertificateWrapperBytes
						);
						return bytes === null
							? null
							: Object.freeze({ scope, incarnation: row.incarnation, exactReceivedCertificateBytes: bytes });
					})
				);
			});
	const inventories = new WeakMap<
		object,
		Readonly<{ objectId: string } & Omit<SnapshotRecoveryRoleInventory, "custody">>
	>();
	const roleInventory = async (
		transaction: IDBTransaction,
		objectId: string
	): Promise<Omit<SnapshotRecoveryRoleInventory, "custody">> => {
		const owner = await ownerStatus(transaction);
		if (owner.legacyUnclassifiedScopes > MAX_CHUNKS)
			throw failure("recovery-full", "snapshot inherited census exceeds bounded work");
		if (owner.recoveryScopes > snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes)
			throw failure("recovery-full", "snapshot role census exceeds the bounded recovery pool");
		const range = IDBKeyRange.bound([objectId], [objectId + "\0"], false, true);
		const rows: ScopeRow[] = [];
		const legacyScopes: NonNullable<SnapshotRecoveryRoleInventory["legacyScopes"]>[number][] = [];
		let legacyManifestBytes = 0;
		// The same ordered range in bounded pages (one past the work bound so
		// overflow still refuses at the same row), visited in cursor order.
		let scanned = 0;
		await visitCountedRange(
			transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")),
			range,
			MAX_CHUNKS + 1,
			(value, key) => {
				if (++scanned > MAX_CHUNKS) throw failure("recovery-full", "snapshot role census exceeds bounded work");
				const row = fromScopeRow(value);
				if (row.objectId !== objectId || JSON.stringify(key) !== JSON.stringify(scopeKey(row)))
					throw failure("poisoned", "snapshot role census key disagrees with its row");
				if (row.retention === "legacy-unclassified") {
					legacyManifestBytes += row.exactCanonicalManifestBytes.byteLength;
					if (
						!Number.isSafeInteger(legacyManifestBytes) ||
						legacyManifestBytes > snapshotRetirementContract.maxImageBytes
					)
						throw failure("recovery-full", "snapshot inherited manifests exceed bounded work");
					const scope = snapshotQuarantineContract.captureScope({
						objectId,
						epoch: row.epoch,
						anchor: row.anchor,
						manifestDigest: row.manifestDigest,
					});
					const observation = snapshotQuarantineContract.validateRecoveryManifest(scope, row);
					legacyScopes.push(
						Object.freeze({
							scope,
							incarnation: row.incarnation,
							state: observation.state,
							expiresAt: observation.expiresAt,
							contentBytes: snapshotQuarantineContract.recoveryContentBytes(
								row.totalBytes,
								row.exactCanonicalManifestBytes.byteLength
							),
						})
					);
				}
				if (row.retention === "recovery") {
					if (rows.length === snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes)
						throw failure("recovery-full", "snapshot role census exceeds the bounded recovery pool");
					rows.push(row);
				}
			}
		);
		const scopes = [];
		for (const row of rows) {
			const scope = snapshotQuarantineContract.captureScope({
				objectId,
				epoch: row.epoch,
				anchor: row.anchor,
				manifestDigest: row.manifestDigest,
			});
			const metadata = await readRecoveryMetadata(transaction, scope);
			if (
				metadata === undefined ||
				metadata.observation.state !== "verified" ||
				metadata.observation.retention !== "recovery"
			)
				throw failure("poisoned", "snapshot role census is not verified");
			await validateRecoveryClosure(transaction, metadata.observation.declaration);
			const carrier = snapshotQuarantineContract.captureRecoveryDescriptorCarrier(
				row.descriptors,
				scope,
				metadata.incarnation
			);
			scopes.push(
				Object.freeze({
					scope,
					incarnation: metadata.incarnation,
					contentBytes: snapshotQuarantineContract.addRecoveryContentBytes(
						snapshotQuarantineContract.recoveryContentBytes(
							row.totalBytes,
							row.exactCanonicalManifestBytes.byteLength,
							row.exactReceivedCertificateWrapperBytes?.byteLength ?? 0
						),
						carrier.extraContentBytes
					),
					...(carrier.retirement === undefined ? {} : { retirement: carrier.retirement }),
				})
			);
		}
		if (
			scopes.length > owner.recoveryScopes ||
			scopes.reduce((sum, row) => sum + row.contentBytes, 0) > owner.recoveryContentBytes
		)
			throw failure("poisoned", "snapshot role accounting is inconsistent");
		if (
			legacyScopes.length > owner.legacyUnclassifiedScopes ||
			legacyScopes.reduce((sum, row) => snapshotQuarantineContract.addRecoveryContentBytes(sum, row.contentBytes), 0) >
				owner.legacyUnclassifiedContentBytes
		)
			throw failure("poisoned", "snapshot inherited accounting is inconsistent");
		return Object.freeze({
			scopes: Object.freeze(scopes),
			owner,
			...(owner.migration === "ready" ? {} : { legacyScopes: Object.freeze(legacyScopes) }),
		});
	};
	const captureRecoveryRoleInventory: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["captureRecoveryRoleInventory"]
	> = (input, options = {}) =>
		promiseCapture(() => {
			const objectId = snapshotQuarantineContract.captureRecoveryRoleObject(input),
				signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				transact(
					database,
					"readonly",
					async (transaction) => {
						throwIfAborted(signal);
						const captured = await roleInventory(transaction, objectId),
							custody = Object.freeze({});
						throwIfAborted(signal);
						inventories.set(custody, Object.freeze({ objectId, ...captured }));
						return Object.freeze({ custody, ...captured });
					},
					{ signal }
				)
			);
		});
	const reconcileRecoveryRoles: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["reconcileRecoveryRoles"]
	> = (input, options = {}) =>
		promiseCapture(() => {
			const custody = snapshotQuarantineContract.captureRecoveryRoleCustody(input),
				signal = options.signal;
			const inventory = inventories.get(custody);
			if (inventory === undefined)
				throw failure("invalid-carrier", "snapshot role inventory is foreign, copied or consumed");
			const captured = snapshotQuarantineContract.captureRecoveryRoleProtection(input);
			inventories.delete(captured.custody);
			throwIfAborted(signal);
			const decision =
				captured.retirementDecision === undefined
					? undefined
					: snapshotQuarantineContract.consumeRecoveryRoleRetirementDecision(
							captured.retirementDecision,
							store,
							captured.custody,
							captured.protectedScopes
						);
			const keys = new Set(captured.protectedScopes.map((scope) => JSON.stringify(scopeKey(scope))));
			if (
				decision?.classification === undefined &&
				captured.protectedScopes.some(
					(scope) =>
						scope.objectId !== inventory.objectId ||
						!inventory.scopes.some((row) => JSON.stringify(scopeKey(row.scope)) === JSON.stringify(scopeKey(scope)))
				)
			)
				throw failure("incomplete", "snapshot protected role is absent from the captured census");
			const retiring =
				decision?.classification === undefined
					? inventory.scopes.filter((row) => !keys.has(JSON.stringify(scopeKey(row.scope))))
					: [];
			const exclusionScopes =
				decision?.classification === undefined
					? retiring.map((row) => row.scope)
					: (inventory.legacyScopes ?? [])
							.filter((row) => keys.has(JSON.stringify(scopeKey(row.scope))))
							.map((row) => row.scope);
			return (async () => {
				let acquiredProtection: SnapshotRecoveryProtection | undefined;
				let borrowed: BorrowedExclusion | undefined;
				let primary: unknown;
				let failed = false;
				try {
					if (exclusionScopes.length !== 0) {
						const scopes = snapshotQuarantineContract.captureRecoveryRetirementScopes({
							scopes: exclusionScopes,
						});
						let owner = [...dependencyGuards].find((guard) => guard.owns(scopes));
						if (owner === undefined) {
							// Acquire outside the scheduled RW: native lock admission itself
							// joins the original scheduled readonly metadata validation.
							acquiredProtection = await acquireDependencyLocks(scopes, "exclusive");
							owner = [...dependencyGuards].find(
								(guard) => guard.protection === acquiredProtection && guard.owns(scopes)
							);
						}
						if (owner === undefined) throw failure("stale-scope", "snapshot backend exclusion is unavailable");
						borrowed = owner.borrow();
					}
					return await schedule(async () => {
						await borrowed?.check();
						const readImage = async (
							transaction: IDBTransaction,
							roles?: Omit<SnapshotRecoveryRoleInventory, "custody">
						) => {
							const selected = roles ?? (await roleInventory(transaction, inventory.objectId));
							const rows = await Promise.all(
								[...selected.scopes, ...(selected.legacyScopes ?? [])].map((row) =>
									requestResult(
										transaction
											.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
											.get(scopeKey(row.scope))
									)
								)
							);
							return {
								roles: selected,
								rows,
								control: await readControl(transaction, inventory.objectId),
								...(decision?.classification === undefined
									? {}
									: { nativeImage: await nativeImage(transaction, inventory.objectId) }),
							};
						};
						let beforeImage: Awaited<ReturnType<typeof readImage>> | undefined;
						let afterImage: Awaited<ReturnType<typeof readImage>> | undefined;
						let receipt:
							| Awaited<
									ReturnType<NonNullable<SnapshotRecoveryStore<SnapshotVerificationReceipt>["reconcileRecoveryRoles"]>>
							  >
							| undefined;
						const errors: unknown[] = [];
						try {
							receipt = await transact(
								database,
								"readwrite",
								async (transaction) => {
									throwIfAborted(signal);
									await borrowed?.check();
									const current = await roleInventory(transaction, inventory.objectId);
									if (
										JSON.stringify(current) !==
										JSON.stringify({
											scopes: inventory.scopes,
											owner: inventory.owner,
											...(inventory.legacyScopes === undefined ? {} : { legacyScopes: inventory.legacyScopes }),
										})
									)
										throw failure("stale-scope", "snapshot role inventory changed before retirement");
									beforeImage = await readImage(transaction, current);
									if (decision?.classification !== undefined) {
										if (
											(await nativeImage(transaction, inventory.objectId)).imageDigest !==
											decision.classification.expectedImageDigest
										)
											throw failure("stale-scope", "snapshot inherited whole source changed before classification");
										const result = snapshotQuarantineContract.recoveryClassificationAccounting(
											current,
											decision,
											await readControl(transaction, inventory.objectId)
										);
										for (const row of result.promoted) {
											const raw = fromScopeRow(
												await requestResult(
													transaction
														.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
														.get(scopeKey(row.scope))
												)
											);
											const observation = snapshotQuarantineContract.validateRecoveryManifest(row.scope, raw);
											await validateRecoveryClosure(transaction, observation.declaration);
											await requestResult(
												transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).put({
													...raw,
													retention: "recovery",
													descriptors: observation.declaration.chunks,
												} satisfies ScopeRow)
											);
										}
										await requestResult(
											transaction
												.objectStore(roomStoreName(transaction.db, "snapshot", "owner"))
												.put({ ...result.owner, id: "owner" } satisfies OwnerRow)
										);
										afterImage = await readImage(transaction);
										await borrowed?.check();
										return Object.freeze({
											retiredScopes: Object.freeze([]),
											recoveryScopes: result.owner.recoveryScopes,
											recoveryContentBytes: result.owner.recoveryContentBytes,
										});
									}
									if (current.owner.migration !== "ready")
										throw failure("migration-required", "snapshot legacy classification is required");
									if (
										captured.protectedScopes.some(
											(scope) =>
												scope.objectId !== inventory.objectId ||
												!current.scopes.some(
													(row) => JSON.stringify(scopeKey(row.scope)) === JSON.stringify(scopeKey(scope))
												)
										)
									)
										throw failure("incomplete", "snapshot protected role is absent from the complete census");
									const retired = current.scopes.filter((row) => !keys.has(JSON.stringify(scopeKey(row.scope))));
									const priorFrontier = await readControl(transaction, inventory.objectId);
									const frontier = snapshotRetirementContract.turnoverFrontier(
										priorFrontier,
										decision,
										retired.map((row) => ({ scope: row.scope, incarnation: row.incarnation }))
									);
									if (
										current.scopes.some(
											(row) =>
												keys.has(JSON.stringify(scopeKey(row.scope))) &&
												!snapshotRetirementContract.allows(frontier, row.scope, row.incarnation)
										) ||
										retired.some((row) => snapshotRetirementContract.protected(frontier, row.scope, row.incarnation))
									)
										throw failure(
											"stale-scope",
											"snapshot role reconciliation contradicts the native protected frontier"
										);
									const recoveryScopes = current.owner.recoveryScopes - retired.length;
									let recoveryContentBytes =
										current.owner.recoveryContentBytes - retired.reduce((sum, row) => sum + row.contentBytes, 0);
									if (recoveryScopes < 0 || recoveryContentBytes < 0)
										throw failure("poisoned", "snapshot role accounting would underflow");
									if (decision !== undefined) {
										const survivor = current.scopes.find(
											(row) => JSON.stringify(scopeKey(row.scope)) === JSON.stringify(scopeKey(decision.survivorScope))
										);
										if (
											survivor === undefined ||
											!keys.has(JSON.stringify(scopeKey(survivor.scope))) ||
											retired.length === 0
										)
											throw failure(
												"invalid-carrier",
												"snapshot retirement survivor or classified scopes are unavailable"
											);
										const raw = fromScopeRow(
											await requestResult(
												transaction
													.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
													.get(scopeKey(survivor.scope))
											)
										);
										const update = snapshotQuarantineContract.recoveryRetirementCarrier(
											decision,
											{ scope: survivor.scope, incarnation: survivor.incarnation },
											retired.map((row) => ({ scope: row.scope, incarnation: row.incarnation })),
											raw.descriptors
										);
										recoveryContentBytes += update.contentByteDelta;
										if (
											!Number.isSafeInteger(recoveryContentBytes) ||
											recoveryContentBytes < 0 ||
											recoveryContentBytes > current.owner.limits.maxRecoveryContentBytes
										)
											throw failure("recovery-full", "snapshot retirement metadata exceeds the recovery budget");
										await requestResult(
											transaction
												.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
												.put({ ...raw, descriptors: update.carrier } satisfies ScopeRow)
										);
									}
									if (frontier !== priorFrontier && frontier !== null)
										await requestResult(
											transaction
												.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
												.put(snapshotRetirementContract.encodeControl(frontier), inventory.objectId)
										);
									throwIfAborted(signal);
									await borrowed?.check();
									for (const row of retired) await deleteScope(transaction, row.scope);
									await requestResult(
										transaction
											.objectStore(roomStoreName(transaction.db, "snapshot", "owner"))
											.put({ ...current.owner, id: "owner", recoveryScopes, recoveryContentBytes } satisfies OwnerRow)
									);
									afterImage = await readImage(transaction);
									await borrowed?.check();
									return Object.freeze({
										retiredScopes: Object.freeze(retired.map((row) => row.scope)),
										recoveryScopes,
										recoveryContentBytes,
									});
								},
								{ signal, requireStrictDurability: true }
							);
						} catch (error) {
							errors.push(error);
						}
						// Keep the physical exclusion through the native terminal AND
						// exact bounded survivor readback. Aborted/uncertain operations
						// retain their primary error even if an old/new image is known.
						try {
							await borrowed?.check();
							await transact(database, "readonly", async (transaction) => {
								const actual = await readImage(transaction);
								const encoded = JSON.stringify(actual);
								if (
									receipt !== undefined
										? afterImage === undefined || encoded !== JSON.stringify(afterImage)
										: (beforeImage !== undefined || afterImage !== undefined) &&
											encoded !== JSON.stringify(beforeImage) &&
											encoded !== JSON.stringify(afterImage)
								)
									throw failure("stale-scope", "snapshot retirement survivor readback disagrees with native outcome");
								if (receipt !== undefined)
									for (const row of retiring) {
										if (
											(await requestResult(
												transaction
													.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
													.getKey(scopeKey(row.scope))
											)) !== undefined ||
											(await requestResult(
												transaction
													.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
													.count(chunkRange(row.scope))
											)) !== 0
										)
											throw failure("poisoned", "snapshot retirement still has native retired material");
									}
								await borrowed?.check();
							});
						} catch (error) {
							errors.push(error);
						}
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1)
							throw new AggregateError(errors, "snapshot retirement and readback failed", { cause: errors[0] });
						if (receipt === undefined)
							throw failure("storage-failed", "snapshot retirement native result is unavailable");
						return receipt;
					});
				} catch (error) {
					primary = error;
					failed = true;
				} finally {
					const releases = await Promise.allSettled([
						...(borrowed === undefined ? [] : [borrowed.release()]),
						...(acquiredProtection === undefined ? [] : [acquiredProtection.release()]),
					]);
					const causes = releases.flatMap((outcome) =>
						outcome.status === "rejected" ? [outcome.reason as unknown] : []
					);
					if (failed && causes.length !== 0)
						throw new AggregateError([primary, ...causes], "snapshot backend retirement cleanup failed", {
							cause: primary,
						});
					if (failed) throw primary;
					if (causes.length === 1) throw causes[0];
					if (causes.length > 1)
						throw new AggregateError(causes, "snapshot backend exclusion release failed", { cause: causes[0] });
				}
				throw primary;
			})();
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
									transaction
										.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
										.getKey(recoverySelectorRange(declaration.scope))
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
											transaction
												.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
												.get(chunkKey(declaration.scope, descriptor.index))
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
					await guardScope(transaction, declaration.scope);
					await mutable(transaction);
					// Reserve the complete declaration before scope birth. Remaining
					// native temporary rows (including protected past-TTL rows) are
					// the authority; release of a handle does not free durable custody.
					let scopes = 1,
						reserved = declaration.totalBytes;
					snapshotQuarantineContract.assertTemporaryAdmission(scopes, reserved);
					await new Promise<void>((resolve, reject) => {
						const scan = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).openCursor();
						scan.addEventListener("error", () => reject(scan.error));
						scan.addEventListener("success", () => {
							const cursor = scan.result;
							if (cursor === null) {
								resolve();
								return;
							}
							void (async (): Promise<void> => {
								const row = fromScopeRow(cursor.value);
								if (row.retention === "temporary") {
									snapshotQuarantineContract.assertTemporaryAdmission(++scopes, reserved);
									const selected = snapshotQuarantineContract.captureRecoveryDependencyScope({
										objectId: row.objectId,
										epoch: row.epoch,
										anchor: row.anchor,
										manifestDigest: row.manifestDigest,
									});
									const metadata = await readRecoveryMetadata(transaction, selected);
									if (metadata === undefined) throw failure("poisoned", "temporary snapshot metadata is absent");
									reserved = snapshotQuarantineContract.addRecoveryContentBytes(
										reserved,
										metadata.observation.declaration.totalBytes
									);
									snapshotQuarantineContract.assertTemporaryAdmission(scopes, reserved);
								}
								cursor.continue();
							})().catch(reject);
						});
					});
					const incarnation = crypto.randomUUID();
					transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).add({
						...declaration.scope,
						exactReceivedCertificateWrapperBytes: null,
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
												transaction
													.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
													.get(chunkKey(declaration.scope, descriptor.index))
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
											const chunks = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "chunks")),
												scopes = transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"));
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
					retainForRecovery: (options = {}) =>
						promiseCapture(() => {
							const { signal, exactReceivedCertificateBytes } =
								snapshotQuarantineContract.captureRetentionOptions(options);
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
										const existingCertificate = snapshotQuarantineContract.openReceivedCertificate(
											row.incarnation,
											row.exactReceivedCertificateWrapperBytes
										);
										if (row.retention === "recovery") {
											if (
												exactReceivedCertificateBytes !== undefined &&
												(existingCertificate === null || !sameBytes(existingCertificate, exactReceivedCertificateBytes))
											)
												throw failure(
													existingCertificate === null ? "recovery-owned" : "conflict",
													"received recovery certificate cannot be added or replaced"
												);
											return;
										}
										const wrapper =
											exactReceivedCertificateBytes === undefined
												? null
												: snapshotQuarantineContract.wrapReceivedCertificate(
														row.incarnation,
														exactReceivedCertificateBytes
													);
										const recoveryScopes = snapshotQuarantineContract.addRecoveryContentBytes(owner.recoveryScopes, 1);
										const recoveryContentBytes = snapshotQuarantineContract.addRecoveryContentBytes(
											owner.recoveryContentBytes,
											snapshotQuarantineContract.recoveryContentBytes(
												declaration.totalBytes,
												declaration.exactCanonicalManifestBytes.byteLength,
												wrapper?.byteLength ?? 0
											)
										);
										if (
											recoveryScopes > owner.limits.maxRecoveryScopes ||
											recoveryContentBytes > owner.limits.maxRecoveryContentBytes
										)
											throw failure("recovery-full", "snapshot recovery capacity is full");
										await requestResult(
											transaction.objectStore(roomStoreName(transaction.db, "snapshot", "scopes")).put({
												...row,
												retention: "recovery",
												exactReceivedCertificateWrapperBytes: wrapper,
											} satisfies ScopeRow)
										);
										await requestResult(
											transaction
												.objectStore(roomStoreName(transaction.db, "snapshot", "owner"))
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
										transaction
											.objectStore(roomStoreName(transaction.db, "snapshot", "chunks"))
											.count(chunkRange(declaration.scope))
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
										transaction
											.objectStore(roomStoreName(transaction.db, "snapshot", "scopes"))
											.put({ ...row, state: "verified" } satisfies ScopeRow);
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
	const readRetirementAdmissionImage: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["readRetirementAdmissionImage"]
	> = (input) =>
		promiseCapture(() => {
			const objectId = snapshotRetirementContract.captureObject(input);
			return schedule(async () => {
				const captured = await transact(database, "readonly", async (transaction) =>
					Object.freeze({
						control: await readControl(transaction, objectId),
						image: await nativeImage(transaction, objectId),
						...((await ownerStatus(transaction)).classificationIntent?.objectId === objectId
							? { classificationSource: await nativeImage(transaction, objectId, true) }
							: {}),
					})
				);
				if (closed) throw failure("closed", "snapshot source owner closed during capture");
				return captured;
			});
		});
	const readRetirementImage: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["readRetirementImage"]
	> = async (input) => {
		const captured = await readRetirementAdmissionImage(input);
		if (captured.image.scopeCount === 0 && captured.control === null)
			throw failure("incomplete", "snapshot retirement object is not installed");
		return captured;
	};
	const acquireRetirementControl: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRetirementControl"]
	> = (input) =>
		promiseCapture(() => {
			const objectId = snapshotRetirementContract.captureObject(input);
			return schedule(async () => {
				let captured = await transact(database, "readonly", async (transaction) => ({
					control: await readControl(transaction, objectId),
					image: await nativeImage(transaction, objectId),
				}));
				if (captured.image.scopeCount === 0 && captured.control === null)
					throw failure("incomplete", "snapshot retirement object is not installed");
				if (captured.control === null) {
					const born: SnapshotRetirementControl = {
						kind: "snapshot-retirement-control-1",
						objectId,
						incarnation: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
						revision: 0,
						sequence: 0,
						active: null,
						completed: null,
					};
					let primary: unknown;
					try {
						await transact(database, "readwrite", async (transaction) => {
							if (
								(await readControl(transaction, objectId)) !== null ||
								(await nativeImage(transaction, objectId)).imageDigest !== captured.image.imageDigest
							)
								throw failure("stale-scope", "snapshot control birth image changed");
							await requestResult(
								transaction
									.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
									.add(snapshotRetirementContract.encodeControl(born), objectId)
							);
						});
					} catch (error) {
						primary = error;
					}
					const after = await transact(database, "readonly", async (transaction) => ({
						control: await readControl(transaction, objectId),
						image: await nativeImage(transaction, objectId),
					}));
					if (
						after.control === null ||
						!sameBytes(
							snapshotRetirementContract.encodeControl(after.control),
							snapshotRetirementContract.encodeControl(born)
						) ||
						after.image.imageDigest !== captured.image.imageDigest
					) {
						if (primary !== undefined) throw primary;
						throw failure("storage-failed", "snapshot control birth outcome is unknown");
					}
					captured = after;
				}
				const reservation = await readReservations.acquire({ objectId });
				try {
					captured = await transact(database, "readonly", async (transaction) => ({
						control: await readControl(transaction, objectId),
						image: await nativeImage(transaction, objectId),
					}));
					await reservation.check();
					if (closed || captured.control === null)
						throw failure("closed", "snapshot retirement owner closed during capture");
				} catch (primary) {
					try {
						await reservation.release();
					} catch (cleanup) {
						throw new AggregateError([primary, cleanup], "snapshot retirement capture release failed", {
							cause: primary,
						});
					}
					throw primary;
				}
				const control = captured.control,
					expected = snapshotRetirementContract.encodeControl(control),
					image = captured.image;
				return snapshotRetirementContract.createRead(
					control,
					image,
					(next) =>
						schedule(async () => {
							let primary: unknown;
							try {
								await transact(database, "readwrite", async (transaction) => {
									const actual = await readControl(transaction, objectId);
									if (
										actual === null ||
										!sameBytes(snapshotRetirementContract.encodeControl(actual), expected) ||
										(await nativeImage(transaction, objectId)).imageDigest !== image.imageDigest
									)
										throw failure("stale-scope", "snapshot retirement native image changed");
									await requestResult(
										transaction
											.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
											.put(snapshotRetirementContract.encodeControl(next), objectId)
									);
								});
							} catch (error) {
								primary = error;
							}
							const after = await transact(database, "readonly", async (transaction) => ({
								control: await readControl(transaction, objectId),
								image: await nativeImage(transaction, objectId),
							}));
							if (
								after.control !== null &&
								sameBytes(
									snapshotRetirementContract.encodeControl(after.control),
									snapshotRetirementContract.encodeControl(next)
								) &&
								after.image.imageDigest === image.imageDigest
							)
								return after.control;
							if (primary !== undefined) throw primary;
							throw failure("storage-failed", "snapshot retirement delivery outcome is unknown");
						}),
					() => reservation.release()
				);
			});
		});
	// Slice 14a: the original acquisition and transitions inside one room retirement
	// session. The session's strict transaction excludes every other writer for its
	// whole life, so no held read view is taken (it would wait behind the session);
	// birth and every transition recheck exact control and the whole native image in
	// that same transaction, and nothing is read back, because the session commits
	// whole or not at all. A refused transition fails the session.
	const acquireRetirementControlInSession = (
		session: RoomRetirementSession,
		input: unknown
	): Promise<SnapshotRetirementControlRead> =>
		promiseCapture(async () => {
			const objectId = snapshotRetirementContract.captureObject(input);
			if (closed || terminated) throw failure("closed", "snapshot quarantine store is closed");
			const captured = await session.run(async (transaction) => {
				const control = await readControl(transaction, objectId),
					image = await nativeImage(transaction, objectId);
				if (control !== null || image.scopeCount === 0) return { control, image };
				const born: SnapshotRetirementControl = {
					kind: "snapshot-retirement-control-1",
					objectId,
					incarnation: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
					revision: 0,
					sequence: 0,
					active: null,
					completed: null,
				};
				await requestResult(
					transaction
						.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
						.add(snapshotRetirementContract.encodeControl(born), objectId)
				);
				return { control: born, image };
			});
			if (captured.control === null) throw failure("incomplete", "snapshot retirement object is not installed");
			const control = captured.control,
				expected = snapshotRetirementContract.encodeControl(control),
				image = captured.image;
			return snapshotRetirementContract.createRead(
				control,
				image,
				async (next) => {
					if (closed || terminated) throw failure("closed", "snapshot quarantine store is closed");
					await session.run(async (transaction) => {
						const actual = await readControl(transaction, objectId);
						if (
							actual === null ||
							!sameBytes(snapshotRetirementContract.encodeControl(actual), expected) ||
							(await nativeImage(transaction, objectId)).imageDigest !== image.imageDigest
						)
							throw failure("stale-scope", "snapshot retirement native image changed");
						await requestResult(
							transaction
								.objectStore(roomStoreName(transaction.db, "snapshot", "retirementControls"))
								.put(snapshotRetirementContract.encodeControl(next), objectId)
						);
					});
					return next;
				},
				() => Promise.resolve()
			);
		});
	/**
	 * Slices 14a/14b step B: this owner's retention section. Inside the acting room
	 * transaction it re-reads the owner row, the control, every scope row of the object
	 * and the original recovery census, and plans the original role turnover (the
	 * selection's retired recovery scopes, exactly the census minus the kept roles) and
	 * the original prepare and commit over the post-turnover image, as the existing
	 * turnover and install compose them. Every scope row, the owner row and the control
	 * are charged at their exact canonical length; chunk payloads stay under this owner's
	 * own bounded accounting and are named by digest only. Deleting needs the original
	 * creator turnover authority (consumed only when writing) and the retired scopes'
	 * exclusive dependency guard, borrowed and checked before the first write.
	 * @param authority - The creator's turnover authority, required when scopes retire.
	 * @returns The section.
	 */
	const retentionSection = (authority?: Readonly<{ capability: object; custody: object }>): RoomRetentionSection =>
		Object.freeze<RoomRetentionSection>({
			owner: "snapshot" as const,
			prepare: ({ session, selection, book, context }) =>
				session.run(async (transaction) => {
					if (closed || terminated) throw failure("closed", "snapshot quarantine store is closed");
					try {
						return await planSnapshotRetention(transaction, session, selection, book, context, authority);
					} catch (error) {
						if (error instanceof RoomRetentionRefusal || !isError(error)) throw error;
						if (error.code === "poisoned" || error.code === "unsupported-schema" || error.code === "invalid-carrier")
							throw new RoomRetentionRefusal("RETENTION_CORRUPT", `snapshot:${error.code}`);
						if (error.code === "recovery-full")
							throw new RoomRetentionRefusal("RETENTION_CAPACITY", `snapshot:${error.code}`);
						return retentionStale(`snapshot:${error.code}`);
					}
				}),
		});
	const planSnapshotRetention = async (
		transaction: IDBTransaction,
		session: RoomRetirementSession,
		selection: RoomRetentionSelection,
		book: RoomRetentionProofBook,
		context: RoomRetentionContext,
		authority: Readonly<{ capability: object; custody: object }> | undefined
	): Promise<RoomRetentionSectionDraft> => {
		const objectId = selection.objectId,
			through = selection.throughEpoch,
			chosen = selection.snapshot;
		const objectStore = (logical: string): IDBObjectStore =>
			transaction.objectStore(roomStoreName(transaction.db, "snapshot", logical));
		const ownerRaw: unknown = await requestResult(objectStore("owner").get("owner"));
		const ownerBefore = chargeRetentionRow(book, "snapshot", "owner", "owner", ownerRaw);
		const owner = await ownerStatus(transaction);
		if (owner.migration !== "ready" || owner.classificationIntent !== undefined) retentionStale("snapshot:migration");
		const controlRaw: unknown = await requestResult(objectStore("retirementControls").get(objectId));
		if (controlRaw === undefined) return retentionStale("snapshot:control-absent");
		const base = chargeRetentionRow(book, "snapshot", "retirementControls", objectId, controlRaw);
		const control = snapshotRetirementContract.decodeControl(controlRaw);
		if (control.objectId !== objectId) throw failure("poisoned", "snapshot retirement control key disagrees");
		if (control.active !== null) retentionStale("snapshot:active");
		// Survivors (14b): with a turnover, every recovery scope and chunk (survivors and
		// retired alike) is exactly the image the verification saw. Accounting unchanged.
		const survivorImage = selection.survivors.snapshotImage;
		if (chosen.retire.length !== 0 && survivorImage === null) retentionStale("snapshot:survivors-unnamed");
		if (survivorImage !== null) {
			// Any byte that differs from the verified image, including a row this owner's own
			// reader classifies as poisoned, is a stale decision here (zero writes).
			let current: string;
			try {
				current = (await nativeImage(transaction, objectId)).imageDigest;
			} catch (error) {
				if (isError(error) && error.code === "poisoned") return retentionStale("snapshot:survivors");
				throw error;
			}
			if (current !== survivorImage) retentionStale("snapshot:survivors");
		}
		const range = IDBKeyRange.bound([objectId], [objectId + "\0"], false, true);
		const count = await requestResult(objectStore("scopes").count(range));
		if (count > snapshotRetirementContract.maxScopes)
			throw new RoomRetentionRefusal("RETENTION_CAPACITY", "snapshot:scopes");
		const rawRows: unknown[] = await requestResult(objectStore("scopes").getAll(range, count + 1));
		if (rawRows.length !== count) retentionStale("snapshot:scope-census");
		const rows = rawRows.map((raw) => {
			const row = fromScopeRow(raw);
			const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
				objectId: row.objectId,
				epoch: row.epoch,
				anchor: row.anchor,
				manifestDigest: row.manifestDigest,
			});
			if (row.objectId !== objectId) throw failure("poisoned", "snapshot retirement scope key disagrees");
			const key = scopeKey(scope) as (string | number)[];
			return Object.freeze({
				raw: raw as ScopeRow,
				row,
				scope,
				key,
				id: JSON.stringify(key),
				digest: chargeRetentionRow(book, "snapshot", "scopes", key, raw),
			});
		});
		// The original recovery census (verified recovery rows, closures, accounting).
		const inventory = await roleInventory(transaction, objectId);
		const named = new Map<string, string>();
		for (const pair of chosen.retire) {
			const id = JSON.stringify(scopeKey(pair.scope));
			if (named.has(id) || pair.scope.objectId !== objectId) retentionStale("snapshot:retire-scope");
			named.set(id, pair.incarnation);
		}
		const retired = inventory.scopes.filter((row) => named.has(JSON.stringify(scopeKey(row.scope))));
		if (
			retired.length !== named.size ||
			retired.some((row) => named.get(JSON.stringify(scopeKey(row.scope))) !== row.incarnation)
		)
			retentionStale("snapshot:retire-census");
		const kept = inventory.scopes.filter((row) => !named.has(JSON.stringify(scopeKey(row.scope))));
		// Acting: the caller must hold the retired scopes' exclusive dependency guard.
		if (
			authority !== undefined &&
			retired.length !== 0 &&
			![...dependencyGuards].some((guard) =>
				guard.owns(
					snapshotQuarantineContract.captureRecoveryRetirementScopes({ scopes: retired.map((row) => row.scope) })
				)
			)
		)
			retentionStale("snapshot:exclusion");
		const deletes: RoomRetentionDraftDelete[] = [];
		const rewrites: RoomRetentionDraftRewrite[] = [];
		let frontier: SnapshotRetirementControl = control;
		let survivorValue: ScopeRow | undefined;
		let ownerValue: Record<string, unknown> | undefined;
		if (retired.length !== 0) {
			const turnover = chosen.turnover;
			if (turnover === null) return retentionStale("snapshot:turnover");
			const survivorScope = snapshotQuarantineContract.captureScope(turnover.survivorScope);
			let decision: Parameters<typeof snapshotRetirementContract.turnoverFrontier>[1];
			if (authority === undefined)
				// Planning: the same fields, never written; the write path consumes the authority.
				decision = Object.freeze({
					certificateDigest: turnover.certificateDigest,
					currentHead: Object.freeze({ ...turnover.currentHead }),
					survivorScope,
					priorRetirementControl: control,
				});
			else {
				let consumed: ReturnType<typeof snapshotQuarantineContract.consumeRecoveryRoleRetirementDecision>;
				try {
					consumed = snapshotQuarantineContract.consumeRecoveryRoleRetirementDecision(
						authority.capability,
						store,
						authority.custody,
						kept.map((row) => row.scope)
					);
				} catch {
					// Not the genuine turnover authority this decision was verified with.
					return retentionStale("snapshot:authority");
				}
				if (
					consumed.classification !== undefined ||
					consumed.priorRetirementControl === undefined ||
					consumed.certificateDigest !== turnover.certificateDigest ||
					JSON.stringify(consumed.currentHead) !== JSON.stringify(turnover.currentHead) ||
					JSON.stringify(scopeKey(consumed.survivorScope)) !== JSON.stringify(scopeKey(survivorScope))
				)
					return retentionStale("snapshot:authority");
				decision = consumed;
			}
			if (
				decision === undefined ||
				decision.currentHead.objectId !== objectId ||
				decision.currentHead.epoch !== survivorScope.epoch + 1
			)
				return retentionStale("snapshot:head");
			const pairs = retired.map((row) => ({ scope: row.scope, incarnation: row.incarnation }));
			const next = snapshotRetirementContract.turnoverFrontier(control, decision, pairs);
			if (next === null) return retentionStale("snapshot:frontier");
			frontier = next;
			if (
				kept.some((row) => !snapshotRetirementContract.allows(frontier, row.scope, row.incarnation)) ||
				retired.some((row) => snapshotRetirementContract.protected(frontier, row.scope, row.incarnation))
			)
				retentionStale("snapshot:frontier-roles");
			const survivor = kept.find(
				(row) => JSON.stringify(scopeKey(row.scope)) === JSON.stringify(scopeKey(survivorScope))
			);
			const survivorRow = rows.find((row) => row.id === JSON.stringify(scopeKey(survivorScope)));
			if (survivor === undefined || survivorRow === undefined) return retentionStale("snapshot:survivor");
			const update = snapshotQuarantineContract.recoveryRetirementCarrier(
				decision,
				{ scope: survivor.scope, incarnation: survivor.incarnation },
				pairs,
				survivorRow.row.descriptors
			);
			const recoveryScopes = owner.recoveryScopes - retired.length;
			const recoveryContentBytes =
				owner.recoveryContentBytes - retired.reduce((sum, row) => sum + row.contentBytes, 0) + update.contentByteDelta;
			if (
				recoveryScopes < 0 ||
				!Number.isSafeInteger(recoveryContentBytes) ||
				recoveryContentBytes < 0 ||
				recoveryContentBytes > owner.limits.maxRecoveryContentBytes
			)
				throw new RoomRetentionRefusal("RETENTION_CAPACITY", "snapshot:accounting");
			survivorValue = { ...survivorRow.raw, descriptors: update.carrier } as ScopeRow;
			rewrites.push(
				Object.freeze({
					store: "scopes",
					key: survivorRow.key,
					before: survivorRow.digest,
					after: retentionValueDigest("scopes", survivorRow.key, survivorValue),
					value: survivorValue,
				})
			);
			ownerValue = { ...owner, id: "owner", recoveryScopes, recoveryContentBytes };
			rewrites.push(
				Object.freeze({
					store: "owner",
					key: "owner",
					before: ownerBefore,
					after: retentionValueDigest("owner", "owner", ownerValue),
					value: ownerValue,
				})
			);
			for (const row of retired) {
				const scopeRow = rows.find((candidate) => candidate.id === JSON.stringify(scopeKey(row.scope)));
				if (scopeRow === undefined) return retentionStale("snapshot:retired-row");
				// 14e: bounded before it is issued (the owner's per-scope chunk bound, plus one).
				const chunkBound = snapshotQuarantineContract.limits.maxChunks;
				const chunks: unknown[] = await requestResult(objectStore("chunks").getAll(chunkRange(row.scope), chunkBound + 1));
				if (chunks.length > chunkBound) throw new RoomRetentionRefusal("RETENTION_CAPACITY", "snapshot:chunks");
				for (const chunk of chunks) {
					const index = (chunk as Partial<ChunkRow>).index;
					if (typeof index !== "number") throw failure("poisoned", "snapshot retirement chunk shape is invalid");
					const key = chunkKey(row.scope, index) as (string | number)[];
					// Chunk payloads are this owner's own bounded accounting (14e): digested, not charged.
					deletes.push(
						Object.freeze({ store: "chunks", key, digest: chargeRetentionRow(book, "snapshot", "chunks", key, chunk, false) })
					);
				}
				deletes.push(Object.freeze({ store: "scopes", key: scopeRow.key, digest: scopeRow.digest }));
			}
		} else if (chosen.turnover !== null) retentionStale("snapshot:turnover");
		const retiredIds = new Set(retired.map((row) => JSON.stringify(scopeKey(row.scope))));
		const survivors = rows
			.filter((row) => !retiredIds.has(row.id))
			.map((row) => Object.freeze({ scope: row.scope, incarnation: row.row.incarnation }));
		context.snapshotSurvivors = Object.freeze(survivors);
		// The install's snapshot preparation: every post-turnover scope at or below the frontier.
		const holes = survivors.filter((row) => row.scope.epoch <= through);
		if (holes.length > snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes)
			throw new RoomRetentionRefusal("RETENTION_CAPACITY", "snapshot:holes");
		const prior = frontier.completed;
		const holeKey = (pair: Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>): string =>
			JSON.stringify([pair.scope.epoch, pair.scope.anchor, pair.scope.manifestDigest, pair.incarnation]);
		if (
			prior !== null &&
			(through < prior.throughEpoch ||
				holes.some(
					(hole) =>
						hole.scope.epoch <= prior.throughEpoch && !prior.protectedScopes.some((p) => holeKey(p) === holeKey(hole))
				))
		)
			retentionStale("snapshot:advance");
		if (frontier.revision >= Number.MAX_SAFE_INTEGER - 1 || frontier.sequence === Number.MAX_SAFE_INTEGER)
			retentionStale("snapshot:revision");
		const turned = frontier;
		return Object.freeze<RoomRetentionSectionDraft>({
			owner: "snapshot" as const,
			base,
			control: roomRetentionControlDigest(snapshotRetirementContract.encodeControl(control)),
			through,
			deletes: Object.freeze(deletes),
			rewrites: Object.freeze(rewrites),
			compose: async (labels: RoomRetentionLabels) => {
				let bytes: Uint8Array;
				try {
					const preparation = snapshotRetirementContract.capturePreparation(
						{
							decisionDigest: labels.decisionDigest,
							sourceProofDigest: labels.sourceProofDigest,
							throughEpoch: through,
							protectedScopes: holes,
						},
						objectId
					);
					const prepared: SnapshotRetirementControl = {
						...turned,
						revision: turned.revision + 1,
						sequence: turned.sequence + 1,
						active: { sequence: turned.sequence + 1, preparation },
					};
					bytes = snapshotRetirementContract.encodeControl({
						...prepared,
						revision: prepared.revision + 1,
						active: null,
						completed: preparation,
					});
				} catch {
					return retentionStale("snapshot:transition");
				}
				return Object.freeze({
					value: bytes,
					digest: retentionValueDigest("retirementControls", objectId, bytes),
					control: roomRetentionControlDigest(bytes),
				});
			},
			write: (target: RoomRetentionTarget, writeBook: RoomRetentionProofBook) =>
				session.run(async (writer) => {
					const writeStore = (logical: string): IDBObjectStore =>
						writer.objectStore(roomStoreName(writer.db, "snapshot", logical));
					let borrowed: BorrowedExclusion | undefined;
					if (retired.length !== 0) {
						const scopes = snapshotQuarantineContract.captureRecoveryRetirementScopes({
							scopes: retired.map((row) => row.scope),
						});
						const guard = [...dependencyGuards].find((candidate) => candidate.owns(scopes));
						if (guard === undefined) return retentionStale("snapshot:exclusion");
						borrowed = guard.borrow();
					}
					try {
						await borrowed?.check();
						if (survivorValue !== undefined) {
							writeBook.write({ kind: "rewrite", owner: "snapshot", store: "scopes" });
							await requestResult(writeStore("scopes").put(survivorValue));
						}
						for (const row of deletes) {
							writeBook.write({ kind: "delete", owner: "snapshot", store: row.store });
							await requestResult(writeStore(row.store).delete(row.key as IDBValidKey));
						}
						if (ownerValue !== undefined) {
							writeBook.write({ kind: "rewrite", owner: "snapshot", store: "owner" });
							await requestResult(writeStore("owner").put(ownerValue));
						}
						writeBook.write({ kind: "control", owner: "snapshot" });
						await requestResult(writeStore("retirementControls").put(target.value, objectId));
						await borrowed?.check();
					} finally {
						await borrowed?.release();
					}
				}),
		});
	};
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closed = true;
		const guards = [...dependencyGuards];
		for (const guard of guards) guard.invalidate();
		closing = Promise.allSettled([tail, readReservations.close(), ...guards.map((guard) => guard.join())]).then(
			(settled) => {
				terminated = true;
				database.close();
				const causes = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason as unknown] : []));
				if (causes.length === 1) throw causes[0];
				if (causes.length > 1) throw new AggregateError(causes, "snapshot owner close failed", { cause: causes[0] });
			}
		);
		return closing;
	};
	const store = Object.freeze({
		close,
		readRetirementImage,
		readRetirementAdmissionImage,
		acquireRetirementControl,
		captureRecoveryRoleInventory,
		reconcileRecoveryRoles,
		inspectRecovery,
		lookupRecoveryDeclaration,
		lookupReceivedRecoveryCertificate,
		acquireRecoveryRead,
		acquireRecoveryDependencyProtection,
		acquireRecoveryRetirementExclusion,
		recoveryStatus,
		openScope,
		sweepExpired,
	});
	if (room)
		roomSnapshotRetirement.set(store, {
			databaseName: primaryDatabaseName,
			acquire: acquireRetirementControlInSession,
			section: retentionSection,
		});
	return store;
}

// Genuine room-mode snapshot owners, with their room database and session acquisition.
const roomSnapshotRetirement = new WeakMap<
	object,
	Readonly<{
		databaseName: string;
		acquire(session: RoomRetirementSession, input: unknown): Promise<SnapshotRetirementControlRead>;
		section(authority?: Readonly<{ capability: object; custody: object }>): RoomRetentionSection;
	}>
>();

/**
 * Slice 14b: the snapshot retention section of a genuine room-mode snapshot owner of
 * the given room database.
 * @param store - Candidate snapshot owner.
 * @param databaseName - The session's room database.
 * @param authority - The creator's turnover authority, for a decision that retires scopes.
 * @returns The section.
 */
export function browserRoomSnapshotRetentionSection(
	store: unknown,
	databaseName: string,
	authority?: Readonly<{ capability: object; custody: object }>
): RoomRetentionSection {
	const entry = typeof store === "object" && store !== null ? roomSnapshotRetirement.get(store) : undefined;
	if (entry === undefined || entry.databaseName !== databaseName) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return entry.section(authority);
}

/**
 * Slice 14a: the snapshot retirement acquisition inside a room retirement session. Only
 * the exact genuine room-mode snapshot owner of the session's own database is accepted.
 * @param store - Candidate snapshot owner.
 * @param databaseName - The session's room database.
 * @param session - The open room retirement session.
 * @param input - The exact object address.
 * @returns The original retirement read, its transitions bound to the session.
 */
export function acquireBrowserRoomSnapshotRetirement(
	store: unknown,
	databaseName: string,
	session: RoomRetirementSession,
	input: unknown
): Promise<SnapshotRetirementControlRead> {
	const entry = typeof store === "object" && store !== null ? roomSnapshotRetirement.get(store) : undefined;
	if (entry === undefined || entry.databaseName !== databaseName) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return entry.acquire(session, input);
}
