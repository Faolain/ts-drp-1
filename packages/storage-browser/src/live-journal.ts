import {
	type AppendAcceptedVertexInput,
	type AppendAcceptedVertexResult,
	captureLiveJournalInput,
	classifyLiveJournalMutationObservation,
	decideLiveJournalDuplicate,
	deriveLiveJournalSnapshot,
	type DurableLiveJournalStore,
	type InstallLiveJournalGenesisInput,
	type InstallLiveJournalGenesisResult,
	type LiveJournalAcceptedRow,
	type LiveJournalFailureKind,
	type LiveJournalPageInput,
	type LiveJournalPageResult,
	type LiveJournalReadinessInput,
	type LiveJournalReadinessResult,
	type LiveJournalScope,
	type LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";

export interface BrowserDurableLiveJournalStoreOptions {
	readonly primaryDatabaseName: string;
}

type StoredScope = Readonly<{
	readonly scope: LiveJournalScope;
	readonly nextJournalSequence: number;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
	readonly parametersDigest: string;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
}>;
type StoredRow = LiveJournalAcceptedRow;
type PendingRow =
	| Omit<Extract<StoredRow, { readonly sourceKind: "received" }>, "journalSequence">
	| Omit<Extract<StoredRow, { readonly sourceKind: "local-issued" }>, "journalSequence">;
type DurableSnapshot = Readonly<{ readonly scope: StoredScope; readonly rows: readonly StoredRow[] }>;
type RawScope = Readonly<Record<string, unknown>>;
type RawRow = Readonly<Record<string, unknown>>;

const RAW_SCOPE_KEYS = [
	"anchorDigest",
	"detachedAnchorSignature",
	"epoch",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"nextJournalSequence",
	"objectId",
	"parametersDigest",
] as const;
const RAW_RECEIVED_KEYS = [
	"anchorDigest",
	"detachedSignature",
	"epoch",
	"exactCanonicalPreimageBytes",
	"journalSequence",
	"objectId",
	"sourceKind",
	"vertexDigest",
] as const;
const RAW_LOCAL_KEYS = [
	"anchorDigest",
	"epoch",
	"journalSequence",
	"localAuthor",
	"localAuthorSequence",
	"objectId",
	"sourceKind",
	"vertexDigest",
] as const;

class CorruptLiveJournalError extends Error {}

function failureError(kind: "durability-unavailable" | "unsupported-schema"): Error & { readonly kind: string } {
	return Object.assign(new Error(kind), { kind });
}

function captureOptions(value: unknown): string {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("malformed-input");
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryDatabaseName");
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			keys.length !== 1 ||
			keys[0] !== "primaryDatabaseName" ||
			descriptor === undefined ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== "string" ||
			descriptor.value.length === 0 ||
			descriptor.value.includes("\0")
		) {
			throw new TypeError("malformed-input");
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof TypeError && error.message === "malformed-input") throw error;
		throw new TypeError("malformed-input");
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
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

function strictTransaction(database: IDBDatabase, stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
	const transaction = database.transaction(stores, mode, { durability: "strict" });
	if (mode === "readwrite" && transaction.durability !== "strict") {
		transaction.abort();
		throw failureError("durability-unavailable");
	}
	return transaction;
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.addEventListener("upgradeneeded", (event) => {
			if ((event as IDBVersionChangeEvent).oldVersion !== 0 || request.transaction === null) {
				request.transaction?.abort();
				return;
			}
			const database = request.result;
			database.createObjectStore("scopes", {
				autoIncrement: false,
				keyPath: ["objectId", "epoch", "anchorDigest"],
			});
			const entries = database.createObjectStore("acceptedEntries", {
				autoIncrement: false,
				keyPath: ["objectId", "epoch", "anchorDigest", "journalSequence"],
			});
			entries.createIndex("digestUniq", ["objectId", "epoch", "anchorDigest", "vertexDigest"], {
				multiEntry: false,
				unique: true,
			});
			entries.createIndex("localRefUniq", ["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"], {
				multiEntry: false,
				unique: true,
			});
		});
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(failureError("unsupported-schema")), { once: true });
		request.addEventListener("blocked", () => reject(failureError("unsupported-schema")), { once: true });
	});
}

function exactKeyPath(value: string | string[] | null, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
	);
}

async function admit(database: IDBDatabase): Promise<void> {
	try {
		if (database.version !== 1 || [...database.objectStoreNames].join(",") !== "acceptedEntries,scopes") {
			throw failureError("unsupported-schema");
		}
		const transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readwrite");
		const scopes = transaction.objectStore("scopes");
		const entries = transaction.objectStore("acceptedEntries");
		const digest = entries.index("digestUniq");
		const local = entries.index("localRefUniq");
		if (
			scopes.autoIncrement ||
			entries.autoIncrement ||
			!exactKeyPath(scopes.keyPath, ["objectId", "epoch", "anchorDigest"]) ||
			[...scopes.indexNames].length !== 0 ||
			!exactKeyPath(entries.keyPath, ["objectId", "epoch", "anchorDigest", "journalSequence"]) ||
			[...entries.indexNames].join(",") !== "digestUniq,localRefUniq" ||
			!exactKeyPath(digest.keyPath, ["objectId", "epoch", "anchorDigest", "vertexDigest"]) ||
			!digest.unique ||
			digest.multiEntry ||
			!exactKeyPath(local.keyPath, ["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"]) ||
			!local.unique ||
			local.multiEntry
		) {
			transaction.abort();
			throw failureError("unsupported-schema");
		}
		await transactionComplete(transaction);
	} catch (error) {
		if (typeof error === "object" && error !== null && Reflect.get(error, "kind") === "durability-unavailable") {
			throw error;
		}
		throw failureError("unsupported-schema");
	}
}

function scopeKey(scope: LiveJournalScope): [string, 0, string] {
	return [scope.objectId, scope.epoch, scope.anchorDigest];
}

function scopeSelectorRange(scope: Pick<LiveJournalScope, "objectId" | "epoch">): IDBKeyRange {
	return IDBKeyRange.bound([scope.objectId, scope.epoch, ""], [scope.objectId, scope.epoch, "\uffff"]);
}

function rowRange(scope: LiveJournalScope): IDBKeyRange {
	return IDBKeyRange.bound([...scopeKey(scope), 0], [...scopeKey(scope), Number.MAX_SAFE_INTEGER]);
}

function rawScope(input: StoredScope): RawScope {
	return {
		anchorDigest: input.scope.anchorDigest,
		detachedAnchorSignature: new Uint8Array(input.detachedAnchorSignature),
		epoch: input.scope.epoch,
		exactCanonicalAnchorPreimageBytes: new Uint8Array(input.exactCanonicalAnchorPreimageBytes),
		exactCanonicalParametersCarrierBytes: new Uint8Array(input.exactCanonicalParametersCarrierBytes),
		nextJournalSequence: input.nextJournalSequence,
		objectId: input.scope.objectId,
		parametersDigest: input.parametersDigest,
	};
}

function rawRow(input: PendingRow, journalSequence: number): RawRow {
	return input.sourceKind === "received"
		? {
				anchorDigest: input.scope.anchorDigest,
				detachedSignature: new Uint8Array(input.detachedSignature),
				epoch: input.scope.epoch,
				exactCanonicalPreimageBytes: new Uint8Array(input.exactCanonicalPreimageBytes),
				journalSequence,
				objectId: input.scope.objectId,
				sourceKind: "received",
				vertexDigest: input.vertexDigest,
			}
		: {
				anchorDigest: input.scope.anchorDigest,
				epoch: input.scope.epoch,
				journalSequence,
				localAuthor: input.author,
				localAuthorSequence: input.authorSequence,
				objectId: input.scope.objectId,
				sourceKind: "local-issued",
				vertexDigest: input.vertexDigest,
			};
}

function exactRaw(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const actual = Reflect.ownKeys(value);
	if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)))
		return undefined;
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
	}
	return value as Readonly<Record<string, unknown>>;
}

function exclusiveBytes(value: unknown, length?: number): Uint8Array | undefined {
	if (!(value instanceof Uint8Array) || value.byteLength === 0) return undefined;
	if (length !== undefined && value.byteLength !== length) return undefined;
	if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) return undefined;
	return new Uint8Array(value);
}

function fromRawScope(value: unknown): StoredScope {
	const raw = exactRaw(value, RAW_SCOPE_KEYS);
	if (raw === undefined) throw new CorruptLiveJournalError();
	const anchor = exclusiveBytes(raw.exactCanonicalAnchorPreimageBytes);
	const signature = exclusiveBytes(raw.detachedAnchorSignature, 64);
	const parameters = exclusiveBytes(raw.exactCanonicalParametersCarrierBytes);
	if (anchor === undefined || signature === undefined || parameters === undefined) throw new CorruptLiveJournalError();
	return {
		detachedAnchorSignature: signature,
		exactCanonicalAnchorPreimageBytes: anchor,
		exactCanonicalParametersCarrierBytes: parameters,
		nextJournalSequence: raw.nextJournalSequence as number,
		parametersDigest: raw.parametersDigest as string,
		scope: { anchorDigest: raw.anchorDigest as string, epoch: raw.epoch as 0, objectId: raw.objectId as string },
	};
}

function fromRawRow(value: unknown): StoredRow {
	if (typeof value !== "object" || value === null) throw new CorruptLiveJournalError();
	const sourceKind = Reflect.get(value, "sourceKind");
	const keys =
		sourceKind === "received" ? RAW_RECEIVED_KEYS : sourceKind === "local-issued" ? RAW_LOCAL_KEYS : undefined;
	const raw = keys === undefined ? undefined : exactRaw(value, keys);
	if (raw === undefined) throw new CorruptLiveJournalError();
	const scope = {
		anchorDigest: raw.anchorDigest as string,
		epoch: raw.epoch as 0,
		objectId: raw.objectId as string,
	};
	if (sourceKind === "received") {
		const bytes = exclusiveBytes(raw.exactCanonicalPreimageBytes);
		const signature = exclusiveBytes(raw.detachedSignature, 64);
		if (bytes === undefined || signature === undefined) throw new CorruptLiveJournalError();
		return {
			detachedSignature: signature,
			exactCanonicalPreimageBytes: bytes,
			journalSequence: raw.journalSequence as number,
			scope,
			sourceKind: "received",
			vertexDigest: raw.vertexDigest as string,
		};
	}
	return {
		author: raw.localAuthor as string,
		authorSequence: raw.localAuthorSequence as number,
		journalSequence: raw.journalSequence as number,
		scope,
		sourceKind: "local-issued",
		vertexDigest: raw.vertexDigest as string,
	};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameGenesis(left: StoredScope, right: StoredScope): boolean {
	return (
		left.scope.objectId === right.scope.objectId &&
		left.scope.epoch === right.scope.epoch &&
		left.scope.anchorDigest === right.scope.anchorDigest &&
		left.parametersDigest === right.parametersDigest &&
		sameBytes(left.exactCanonicalAnchorPreimageBytes, right.exactCanonicalAnchorPreimageBytes) &&
		sameBytes(left.detachedAnchorSignature, right.detachedAnchorSignature) &&
		sameBytes(left.exactCanonicalParametersCarrierBytes, right.exactCanonicalParametersCarrierBytes)
	);
}

function existingProbe(row: StoredRow | undefined): Readonly<Record<string, unknown>> | null {
	if (row === undefined) return null;
	return row.sourceKind === "received"
		? {
				detachedSignature: row.detachedSignature,
				exactCanonicalPreimageBytes: row.exactCanonicalPreimageBytes,
				journalSequence: row.journalSequence,
				sourceKind: row.sourceKind,
				vertexDigest: row.vertexDigest,
			}
		: {
				author: row.author,
				authorSequence: row.authorSequence,
				journalSequence: row.journalSequence,
				sourceKind: row.sourceKind,
				vertexDigest: row.vertexDigest,
			};
}

async function readSnapshot(database: IDBDatabase, scope: LiveJournalScope): Promise<DurableSnapshot | null> {
	const transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readonly");
	const scopeRequest = transaction.objectStore("scopes").get(scopeKey(scope));
	const rowsRequest = transaction.objectStore("acceptedEntries").getAll(rowRange(scope));
	const [storedScope, rawRows] = await Promise.all([requestResult(scopeRequest), requestResult(rowsRequest)]);
	await transactionComplete(transaction);
	if (storedScope === undefined) return null;
	return { rows: (rawRows as unknown[]).map(fromRawRow), scope: fromRawScope(storedScope) };
}

const WRONG_SCOPE_SNAPSHOT = Symbol("wrong-scope-snapshot");

async function readReplaySnapshot(
	database: IDBDatabase,
	scope: LiveJournalScope
): Promise<DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT> {
	const transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readonly");
	const scopes = transaction.objectStore("scopes");
	const scopeRequest = scopes.get(scopeKey(scope));
	const selectorRequest = scopes.getKey(scopeSelectorRange(scope));
	const rowsRequest = transaction.objectStore("acceptedEntries").getAll(rowRange(scope));
	const [storedScope, selectedKey, rawRows] = await Promise.all([
		requestResult(scopeRequest),
		requestResult(selectorRequest),
		requestResult(rowsRequest),
	]);
	await transactionComplete(transaction);
	if (storedScope === undefined) return selectedKey === undefined ? null : WRONG_SCOPE_SNAPSHOT;
	return { rows: (rawRows as unknown[]).map(fromRawRow), scope: fromRawScope(storedScope) };
}

function failed(kind: LiveJournalFailureKind): Readonly<{ readonly kind: LiveJournalFailureKind; readonly ok: false }> {
	return Object.freeze({ kind, ok: false });
}

function captureAddressedClosure(snapshot: DurableSnapshot): DurableSnapshot | undefined {
	try {
		const captured = deriveLiveJournalSnapshot({ durable: snapshot } as never);
		if (captured.ok !== true) return undefined;
		return { rows: captured.rows, scope: snapshot.scope };
	} catch {
		return undefined;
	}
}

type WriterOutcome = Readonly<{
	readonly before: DurableSnapshot | null;
	readonly idempotent: boolean;
	readonly rejected?: LiveJournalFailureKind;
	readonly row?: StoredRow;
}>;

function installWriter(database: IDBDatabase, input: StoredScope): Promise<WriterOutcome> {
	return new Promise((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let outcome: WriterOutcome | undefined;
		const scopes = transaction.objectStore("scopes");
		const request = scopes.get(scopeKey(input.scope));
		const rowsRequest = transaction.objectStore("acceptedEntries").getAll(rowRange(input.scope));
		let scopeLoaded = false;
		let rowsLoaded = false;
		let processed = false;
		const processClosure = (): void => {
			if (!scopeLoaded || !rowsLoaded || processed) return;
			processed = true;
			try {
				const rows = (rowsRequest.result as unknown[]).map(fromRawRow);
				const existing = request.result === undefined ? null : fromRawScope(request.result);
				let before: DurableSnapshot | null = null;
				if (existing === null) {
					if (rows.length !== 0) {
						outcome = { before, idempotent: false, rejected: "store-poisoned" };
						transaction.abort();
						return;
					}
					scopes.add(rawScope(input));
					outcome = { before, idempotent: false };
					return;
				}
				before = captureAddressedClosure({ rows, scope: existing }) ?? null;
				if (before === null) {
					outcome = { before, idempotent: false, rejected: "store-poisoned" };
					transaction.abort();
				} else if (sameGenesis(before.scope, input)) outcome = { before, idempotent: true };
				else {
					outcome = { before, idempotent: false, rejected: "genesis-conflict" };
					transaction.abort();
				}
			} catch {
				outcome = { before: null, idempotent: false, rejected: "store-poisoned" };
				transaction.abort();
			}
		};
		request.addEventListener(
			"success",
			() => {
				scopeLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		rowsRequest.addEventListener(
			"success",
			() => {
				rowsLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		transaction.addEventListener(
			"complete",
			() => resolve(outcome ?? { before: null, idempotent: false, rejected: "internal-invariant" }),
			{ once: true }
		);
		transaction.addEventListener(
			"abort",
			() =>
				outcome?.rejected === undefined
					? reject(transaction.error ?? new Error("indexeddb-transaction-aborted"))
					: resolve(outcome),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => {
				if (outcome?.rejected === undefined) reject(transaction.error ?? new Error("indexeddb-transaction-failed"));
			},
			{ once: true }
		);
	});
}

function appendWriter(database: IDBDatabase, initial: PendingRow): Promise<WriterOutcome> {
	return new Promise((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let candidate = initial;
		let outcome: WriterOutcome | undefined;
		const scopes = transaction.objectStore("scopes");
		const entries = transaction.objectStore("acceptedEntries");
		const scopeRequest = scopes.get(scopeKey(candidate.scope));
		const rowsRequest = entries.getAll(rowRange(candidate.scope));
		const rejectWriter = (kind: LiveJournalFailureKind, before: DurableSnapshot | null): void => {
			outcome = { before, idempotent: false, rejected: kind };
			transaction.abort();
		};
		let scopeLoaded = false;
		let rowsLoaded = false;
		let processed = false;
		const processClosure = (): void => {
			if (!scopeLoaded || !rowsLoaded || processed) return;
			processed = true;
			try {
				const rows = (rowsRequest.result as unknown[]).map(fromRawRow);
				const scope = scopeRequest.result === undefined ? null : fromRawScope(scopeRequest.result);
				if (scope === null && rows.length !== 0) {
					rejectWriter("store-poisoned", null);
					return;
				}
				if (scope === null) {
					const selector = scopes.getKey(scopeSelectorRange(candidate.scope));
					selector.addEventListener(
						"success",
						() => rejectWriter(selector.result === undefined ? "not-installed" : "wrong-scope", null),
						{ once: true }
					);
					return;
				}
				const before = captureAddressedClosure({ rows, scope });
				if (before === undefined) {
					rejectWriter("store-poisoned", null);
					return;
				}
				const structural = captureLiveJournalInput("received", candidate);
				if (structural.ok !== true) {
					rejectWriter(structural.kind, before);
					return;
				}
				candidate = structural.value as PendingRow;
				const digestRow = before.rows.find(({ vertexDigest }) => vertexDigest === candidate.vertexDigest);
				let referenceRow: StoredRow | undefined;
				if (candidate.sourceKind === "local-issued") {
					const { author, authorSequence } = candidate;
					referenceRow = before.rows.find(
						(row) => row.sourceKind === "local-issued" && row.author === author && row.authorSequence === authorSequence
					);
				}
				const decision = decideLiveJournalDuplicate({
					candidate,
					digestRow: existingProbe(digestRow),
					referenceRow: existingProbe(referenceRow),
				} as never);
				if (decision.action === "conflict") {
					rejectWriter("evidence-conflict", before);
					return;
				}
				if (decision.action === "idempotent") {
					const retained = digestRow ?? referenceRow;
					if (retained === undefined) rejectWriter("internal-invariant", before);
					else outcome = { before, idempotent: true, row: retained };
					return;
				}
				if (decision.action !== "append") {
					rejectWriter("internal-invariant", before);
					return;
				}
				const sequence = scope.nextJournalSequence;
				const stored = rawRow(candidate, sequence);
				const add = entries.add(stored);
				add.addEventListener(
					"success",
					() => {
						scopes.put(rawScope({ ...scope, nextJournalSequence: sequence + 1 }));
						outcome = { before, idempotent: false, row: fromRawRow(stored) };
					},
					{ once: true }
				);
			} catch {
				rejectWriter("store-poisoned", null);
			}
		};
		scopeRequest.addEventListener(
			"success",
			() => {
				scopeLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		rowsRequest.addEventListener(
			"success",
			() => {
				rowsLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		transaction.addEventListener(
			"complete",
			() => resolve(outcome ?? { before: null, idempotent: false, rejected: "internal-invariant" }),
			{ once: true }
		);
		transaction.addEventListener(
			"abort",
			() =>
				outcome?.rejected === undefined
					? reject(transaction.error ?? new Error("indexeddb-transaction-aborted"))
					: resolve(outcome),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => {
				if (outcome?.rejected === undefined) reject(transaction.error ?? new Error("indexeddb-transaction-failed"));
			},
			{ once: true }
		);
	});
}

/**
 * Creates the strict Browser live-journal capability.
 * @param options - Exact primary IndexedDB name options.
 * @returns A strict five-method live-journal capability.
 */
export async function createBrowserDurableLiveJournalStore(
	options: BrowserDurableLiveJournalStoreOptions
): Promise<DurableLiveJournalStore> {
	const primaryDatabaseName = captureOptions(options);
	const database = await openDatabase(`${primaryDatabaseName}--drp-live-journal-v1`);
	try {
		await admit(database);
	} catch (error) {
		database.close();
		throw error;
	}
	database.addEventListener("versionchange", () => database.close());
	let closed = false;
	let poisoned = false;
	let closePromise: Promise<void> | undefined;
	const unavailable = (): ReturnType<typeof failed> | undefined =>
		poisoned ? failed("store-poisoned") : closed ? failed("store-closed") : undefined;

	const observe = (
		actual: DurableSnapshot | null | undefined,
		before: DurableSnapshot | null,
		target: Readonly<Record<string, unknown>>
	): LiveJournalFailureKind | undefined => {
		let decision: unknown;
		try {
			decision = classifyLiveJournalMutationObservation({ actual, before, target } as never);
		} catch {
			decision = "mixed";
		}
		if (decision === "exact-new") return undefined;
		if (decision === "exact-old") return "substrate-failure";
		if (decision === "unreadable") return "outcome-unknown";
		if (decision === "mixed") {
			poisoned = true;
			return "store-poisoned";
		}
		return "internal-invariant";
	};

	const postWriteSnapshot = async (scope: LiveJournalScope): Promise<DurableSnapshot | null | undefined> => {
		try {
			return await readSnapshot(database, scope);
		} catch {
			return undefined;
		}
	};

	const installGenesis = async (input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		try {
			captured = captureLiveJournalInput("install", input);
			if (captured.ok !== true) return failed(captured.kind);
		} catch {
			return failed("malformed-input");
		}
		const selected = captured.value as Readonly<{ readonly stored: StoredScope; readonly parametersDigest: string }>;
		let outcome: WriterOutcome;
		try {
			outcome = await installWriter(database, selected.stored);
		} catch {
			return failed("substrate-failure");
		}
		const actual = await postWriteSnapshot(selected.stored.scope);
		if (outcome.rejected !== undefined) {
			if (outcome.rejected === "store-poisoned") poisoned = true;
			if (actual === undefined && outcome.rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual) === undefined) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed(outcome.rejected);
		}
		const kind = observe(actual, outcome.before, { kind: "install", scope: selected.stored });
		if (kind !== undefined) return failed(kind);
		return Object.freeze({
			idempotent: outcome.idempotent,
			ok: true,
			parametersDigest: selected.parametersDigest,
			scope: Object.freeze({ ...selected.stored.scope }),
		});
	};

	const appendAccepted = async (input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		try {
			captured = captureLiveJournalInput("append", input);
			if (captured.ok !== true) return failed(captured.kind);
		} catch {
			return failed("malformed-input");
		}
		const candidate = captured.value as PendingRow;
		let outcome: WriterOutcome;
		try {
			outcome = await appendWriter(database, candidate);
		} catch {
			return failed("substrate-failure");
		}
		const actual = await postWriteSnapshot(candidate.scope);
		if (outcome.rejected !== undefined) {
			if (outcome.rejected === "store-poisoned") poisoned = true;
			if (actual === undefined && outcome.rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual) === undefined) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed(outcome.rejected);
		}
		if (outcome.row === undefined) return failed("internal-invariant");
		const kind = observe(actual, outcome.before, { kind: "append", row: outcome.row });
		if (kind !== undefined) return failed(kind);
		return Object.freeze({
			idempotent: outcome.idempotent,
			journalSequence: outcome.row.journalSequence,
			ok: true,
			scope: Object.freeze({ ...outcome.row.scope }),
			sourceKind: outcome.row.sourceKind,
			vertexDigest: outcome.row.vertexDigest,
		});
	};

	const readiness = async (input: LiveJournalReadinessInput): Promise<LiveJournalReadinessResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let scope: LiveJournalScope;
		try {
			const captured = captureLiveJournalInput("readiness", input);
			if (captured.ok !== true) return failed(captured.kind);
			scope = captured.value as LiveJournalScope;
		} catch {
			return failed("malformed-input");
		}
		let durable: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
		try {
			durable = await readReplaySnapshot(database, scope);
		} catch (error) {
			if (error instanceof CorruptLiveJournalError) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed("substrate-failure");
		}
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return Object.freeze({ kind: "not-installed", ok: true, ready: false });
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshot({ durable } as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				poisoned = true;
				return failed("store-poisoned");
			}
		} catch {
			return failed("internal-invariant");
		}
		return Object.freeze({
			ok: true,
			ready: true,
			rowCount: (derived.rows as readonly unknown[]).length,
			scope: Object.freeze({ ...scope }),
			snapshot: derived.token as LiveJournalSnapshotToken,
		});
	};

	const readPage = async (input: LiveJournalPageInput): Promise<LiveJournalPageResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let page: Readonly<Record<string, unknown>>;
		try {
			const captured = captureLiveJournalInput("page", input);
			if (captured.ok !== true) return failed(captured.kind);
			page = captured.value as Readonly<Record<string, unknown>>;
		} catch {
			return failed("malformed-input");
		}
		const scope = page.scope as LiveJournalScope;
		let durable: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
		try {
			durable = await readReplaySnapshot(database, scope);
		} catch (error) {
			if (error instanceof CorruptLiveJournalError) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed("substrate-failure");
		}
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return failed("not-installed");
		const supplied = page.snapshot as LiveJournalSnapshotToken;
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshot({
				durable,
				highWatermark: supplied.highWatermark,
				supplied,
			} as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				const kind = derived.kind as LiveJournalFailureKind;
				if (kind === "store-poisoned") poisoned = true;
				return failed(kind);
			}
		} catch {
			return failed("internal-invariant");
		}
		const rows = (derived.rows as readonly StoredRow[]).filter(
			({ journalSequence }) => journalSequence > (page.afterSequence as number)
		);
		const selected = Object.freeze(rows.slice(0, page.limit as number));
		const nextSequence =
			selected.length < rows.length ? (selected[selected.length - 1]?.journalSequence ?? null) : null;
		return Object.freeze({
			nextSequence,
			ok: true,
			rows: selected,
			scope: Object.freeze({ ...scope }),
			snapshot: derived.token,
		}) as LiveJournalPageResult;
	};

	const close = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		closePromise = Promise.resolve().then(() => {
			database.close();
		});
		return closePromise;
	};

	return Object.freeze({ appendAccepted, close, installGenesis, readiness, readPage });
}
