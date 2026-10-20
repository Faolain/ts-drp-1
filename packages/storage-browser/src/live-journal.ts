import { encodeCanonical } from "@ts-drp/canonical";
import {
	advanceJournalRetirementMutationControl,
	captureJournalRetirementControl,
	type AppendAcceptedVertexInput,
	type AppendAcceptedVertexResult,
	captureJournalRetirementObject,
	captureJournalClosedMembershipInput,
	captureLiveJournalAnchorReadObservation,
	captureLiveJournalHistoricalAnchorImportInput,
	captureLiveJournalInput,
	captureSourceBoundJournalAppendInput,
	captureLiveJournalSignedAnchorReadInput,
	captureLiveJournalSignedAnchorReadObservation,
	classifyLiveJournalMutationObservation,
	createJournalRetirementControlCodec,
	createJournalRetirementImageCapture,
	createLiveJournalSnapshotValidation,
	decideLiveJournalDuplicate,
	decodeJournalRetirementControl,
	decodeJournalRetirementNativeCarriers,
	encodeJournalRetirementNativeCarriers,
	deriveLiveJournalSnapshot,
	deriveLiveJournalSnapshotReadiness,
	type DurableLiveJournalStore,
	encodeJournalRetirementControl,
	type InstallLiveJournalGenesisInput,
	type InstallLiveJournalGenesisResult,
	journalRetirementAllows,
	journalRetirementCanonicalRow,
	type JournalRetirementDrainRow,
	journalRetirementFrameDigest,
	journalRetirementDrainItemCount,
	type JournalRetirementDrainItem,
	journalRetirementImage,
	journalRetirementImageCountsFit,
	journalRetirementMutationAllows,
	LIVE_JOURNAL_RETIREMENT_BATCH_ROWS,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	type LiveJournalAcceptedRow,
	type LiveJournalAnchorReadInput,
	type LiveJournalAnchorReadResult,
	type LiveJournalFailureKind,
	type LiveJournalHistoricalAnchorImportInput,
	type LiveJournalHistoricalAnchorImportResult,
	type LiveJournalPageInput,
	type LiveJournalPageResult,
	type LiveJournalReadinessInput,
	type LiveJournalReadinessResult,
	type LiveJournalRetirementControl,
	type LiveJournalRetirementControlRead,
	type LiveJournalRetirementDrainSource,
	type LiveJournalRetirementImage,
	type LiveJournalRetirementImageObservation,
	type LiveJournalRetirementImageCurrentProbe,
	type LiveJournalRetirementImageReader,
	type LiveJournalRetirementResult,
	type LiveJournalScope,
	type LiveJournalSignedAnchorReadInput,
	type LiveJournalSignedAnchorReadResult,
	type LiveJournalSnapshotToken,
	reconstructJournalRetirementDrainSource,
} from "@ts-drp/live-journal";
import { roomRetentionControlDigest, RoomRetentionRefusal } from "@ts-drp/storage/room-head";

export interface BrowserDurableLiveJournalStoreOptions {
	readonly primaryDatabaseName: string;
}

import {
	captureNativeReadReservationInput,
	isNativeReadReservationTransaction,
	nativeReadonlyTransaction,
	nativeReadReservationCheck,
	NativeReadReservationOwner,
	type NativeReadReservationPort,
	nativeReadReservationTransaction,
	needsNativeReadReservationTurn,
	type RoomRetirementSession,
	runNativeReservedRead,
	visitCountedRange,
} from "./internal/native-read-reservation.js";
import {
	chargeRetentionRow,
	type RoomRetentionDraftDelete,
	type RoomRetentionDraftRewrite,
	type RoomRetentionSection,
	type RoomRetentionSectionDraft,
	retentionStale,
	retentionValueDigest,
} from "./internal/room-retention.js";
import {
	openBrowserRoomOwnerConnection,
	roomStoreName,
	roomStoreNames,
} from "./internal/schema-idb.js";

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

function failureError(kind: LiveJournalFailureKind): Error & { readonly kind: string } {
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
	const held = nativeReadReservationCheck(transaction);
	if (held !== undefined) return held;
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

function strictTransaction(database: IDBDatabase, logical: string | string[], mode: IDBTransactionMode): IDBTransaction {
	// Logical journal store names; a room connection names them in the journal namespace (14a).
	const stores =
		typeof logical === "string" ? roomStoreName(database, "journal", logical) : roomStoreNames(database, "journal", logical);
	const transaction =
		mode === "readonly"
			? nativeReadonlyTransaction(database, stores)
			: database.transaction(stores, mode, { durability: "strict" });
	if (mode === "readwrite" && transaction.durability !== "strict") {
		transaction.abort();
		throw failureError("durability-unavailable");
	}
	return transaction;
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 3);
		let rejected = false;
		request.addEventListener("upgradeneeded", (event) => {
			const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
			if ((oldVersion !== 0 && oldVersion !== 1 && oldVersion !== 2) || request.transaction === null) {
				request.transaction?.abort();
				return;
			}
			const database = request.result;
			if (oldVersion === 2) {
				try {
					if ([...database.objectStoreNames].join(",") !== "acceptedEntries,retirementControls,scopes")
						throw failureError("unsupported-schema");
					checkJournalSchema(request.transaction);
					const controls = request.transaction.objectStore("retirementControls");
					if (controls.keyPath !== "objectId" || controls.autoIncrement || controls.indexNames.length !== 0)
						throw failureError("unsupported-schema");
					const cursor = controls.openCursor();
					cursor.addEventListener("success", () => {
						try {
							const current = cursor.result;
							if (current === null) return;
							const raw = exactRaw(current.value, ["objectId", "record"]);
							if (raw === undefined || raw.objectId !== current.primaryKey) throw new CorruptLiveJournalError();
							const control = decodeJournalRetirementControl(raw.record);
							if (control.objectId !== raw.objectId) throw new CorruptLiveJournalError();
							current.update(nativeRetirementRecord(control));
							current.continue();
						} catch {
							request.transaction?.abort();
						}
					});
				} catch {
					request.transaction.abort();
				}
				return;
			}
			if (oldVersion === 1) {
				try {
					if ([...database.objectStoreNames].join(",") !== "acceptedEntries,scopes")
						throw failureError("unsupported-schema");
					checkJournalSchema(request.transaction);
					database.createObjectStore("retirementControls", { keyPath: "objectId", autoIncrement: false });
				} catch {
					request.transaction.abort();
				}
				return;
			}
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
			database.createObjectStore("retirementControls", { keyPath: "objectId", autoIncrement: false });
		});
		request.addEventListener(
			"success",
			() => {
				if (rejected) request.result.close();
				else resolve(request.result);
			},
			{ once: true }
		);
		const refuse = (): void => {
			rejected = true;
			reject(failureError("unsupported-schema"));
		};
		request.addEventListener("error", refuse, { once: true });
		request.addEventListener("blocked", refuse, { once: true });
	});
}

function exactKeyPath(value: string | string[] | null, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
	);
}

function checkJournalSchema(transaction: IDBTransaction): void {
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
		throw failureError("unsupported-schema");
	}
}

async function admit(database: IDBDatabase): Promise<void> {
	try {
		if (
			database.version !== 3 ||
			[...database.objectStoreNames].join(",") !== "acceptedEntries,retirementControls,scopes"
		) {
			throw failureError("unsupported-schema");
		}
		const transaction = strictTransaction(database, ["acceptedEntries", "retirementControls", "scopes"], "readwrite");
		checkJournalSchema(transaction);
		const controls = transaction.objectStore("retirementControls");
		if (controls.keyPath !== "objectId" || controls.autoIncrement || controls.indexNames.length !== 0) {
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

const JOURNAL_STORES = ["acceptedEntries", "retirementControls", "scopes"];
function retirementControl(
	raw: unknown,
	objectId: string,
	codec?: ReturnType<typeof createJournalRetirementControlCodec>
): LiveJournalRetirementControl | null {
	if (raw === undefined) {codec?.clear(); return null;}
	const r = retirementNativeCarriers(raw, objectId);
	const control = (codec?.decode ?? decodeJournalRetirementNativeCarriers)(r.record, r.planRecord);
	if (control.objectId !== objectId) throw new CorruptLiveJournalError();
	return control;
}
function retirementNativeCarriers(raw: unknown, objectId: string): Readonly<Record<string, unknown>> {
	const hasPlan = raw !== null && typeof raw === "object" && Object.hasOwn(raw, "planRecord");
	const r = exactRaw(raw, ["objectId", "record", ...(hasPlan ? ["planRecord"] : [])]);
	if (r === undefined) throw new CorruptLiveJournalError();
	if (r.objectId !== objectId) throw new CorruptLiveJournalError();
	return r;
}
function nativeRetirementRecord(control: LiveJournalRetirementControl) {
	const bytes = encodeJournalRetirementNativeCarriers(control);
	return capturedNativeRetirementRecord(control.objectId, bytes);
}
function capturedNativeRetirementRecord(
	objectId: string,
	bytes: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>
) {
	return {
		objectId,
		record: bytes.controlBytes,
		...(bytes.planBytes === undefined ? {} : { planRecord: bytes.planBytes }),
	};
}
function sameRetirementNativeCarriers(a: LiveJournalRetirementControl, b: LiveJournalRetirementControl): boolean {
	const left = encodeJournalRetirementNativeCarriers(a),
		right = encodeJournalRetirementNativeCarriers(b);
	return sameCapturedRetirementNativeCarriers(left, right);
}
function sameCapturedRetirementNativeCarriers(
	left: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>,
	right: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>
): boolean {
	return (
		sameBytes(left.controlBytes, right.controlBytes) &&
		(left.planBytes === undefined || right.planBytes === undefined
			? left.planBytes === right.planBytes
			: sameBytes(left.planBytes, right.planBytes))
	);
}
function retirementFailure(error: unknown): LiveJournalFailureKind {
	return error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-exhausted")
		? error.message
		: "store-poisoned";
}
function admitRetirementControl(raw: unknown, selected: LiveJournalScope): LiveJournalRetirementControl | null {
	const control = retirementControl(raw, selected.objectId);
	if (!journalRetirementAllows(control, selected)) throw new Error("retirement-fenced");
	if (control?.revision === Number.MAX_SAFE_INTEGER) throw new Error("retirement-exhausted");
	return control;
}
function advanceRetirementControl(transaction: IDBTransaction, control: LiveJournalRetirementControl | null): void {
	if (control !== null) {
		if (control.drain != null) {
			if (control.drain.cursor < journalRetirementDrainItemCount(control.drain.plan))
				throw new Error("retirement-fenced");
			for (const prefix of control.drain.plan.prefixes) {
				const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")),
					request = scopes.get(scopeKey(prefix.scope));
				request.addEventListener(
					"success",
					() => {
						if (request.result === undefined) return;
						const retained = { ...request.result } as Record<string, unknown>;
						if (Object.hasOwn(retained, "closedMembershipBytes")) {
							delete retained.closedMembershipBytes;
							scopes.put(retained);
						}
					},
					{ once: true }
				);
			}
		}
		const next = advanceJournalRetirementMutationControl(control);
		transaction.objectStore(roomStoreName(transaction.db, "journal", "retirementControls")).put(nativeRetirementRecord(next));
	}
}
function admitRetirementMutation(control: LiveJournalRetirementControl | null, selected: LiveJournalScope): void {
	if (!journalRetirementMutationAllows(control, selected)) throw new Error("retirement-fenced");
}
async function checkReplayRetirement(transaction: IDBTransaction, selected: LiveJournalScope,
	codec: ReturnType<typeof createJournalRetirementControlCodec>): Promise<void> {
	const raw = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "journal", "retirementControls")).get(selected.objectId));
	if (raw === undefined) {codec.clear(); return;}
	const carriers = retirementNativeCarriers(raw, selected.objectId);
	const fence = codec.readFence(carriers.record, carriers.planRecord, selected);
	if (fence.objectId !== selected.objectId) throw new CorruptLiveJournalError();
	if (!fence.allowed) {
		await transactionComplete(transaction);
		throw new Error("retirement-fenced");
	}
}

function scopeKey(scope: LiveJournalScope): [string, number, string] {
	return [scope.objectId, scope.epoch, scope.anchorDigest];
}

type RetirementSnapshot = Readonly<{
	control: LiveJournalRetirementControl | null;
	image: LiveJournalRetirementImage;
	frames: readonly Uint8Array[];
	scopes: readonly unknown[];
	rows: readonly unknown[];
}>;
async function retirementSnapshot(
	database: IDBDatabase,
	objectId: string,
	write?: Readonly<{
		expected: LiveJournalRetirementControl | null;
		imageDigest: string;
		next: LiveJournalRetirementControl;
		nextCarriers?: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>;
		expectedCarriers?: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>;
	deletions?: readonly JournalRetirementDrainItem[];
	}>,
	captureRows = false,
	ownedTransaction?: IDBTransaction,
	codec?: ReturnType<typeof createJournalRetirementControlCodec>
): Promise<RetirementSnapshot> {
	// Read-only source capture borrows the original admitted native turn. A write
	// still requires its actual owner to revoke and join that view first.
	if (ownedTransaction === undefined && write === undefined && needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => retirementSnapshot(database, objectId, write, captureRows, undefined, codec));
	if (write !== undefined && nativeReadReservationTransaction(database) !== undefined)
		throw new Error("retirement-transition");
	const transaction =
		ownedTransaction ?? strictTransaction(database, JOURNAL_STORES, write === undefined ? "readonly" : "readwrite");
	const borrowed = ownedTransaction !== undefined || isNativeReadReservationTransaction(transaction);
	const terminal = borrowed ? undefined : signedTransactionTerminal(transaction);
	let result: RetirementSnapshot | undefined, primary: unknown,
		imageCapture: ReturnType<typeof createJournalRetirementImageCapture> | undefined;
	try {
		const range = IDBKeyRange.bound([objectId], [objectId, []]);
		// Room mode (slice 14a) namespaces the journal stores; the transaction's own
		// catalog names the physical store, so this body needs no foreign helper.
		const journalStore = (logical: string): IDBObjectStore =>
			transaction.objectStore(
				transaction.objectStoreNames.contains(`journal:${logical}`) ? `journal:${logical}` : logical
			);
		const scopesStore = journalStore("scopes"),
			rowsStore = journalStore("acceptedEntries");
		const [scopeCount, rowCount] = await Promise.all([
			requestResult(scopesStore.count(range)),
			requestResult(rowsStore.count(range)),
		]);
		if (!journalRetirementImageCountsFit(scopeCount, rowCount)) throw new Error("retirement-fenced");
		imageCapture = createJournalRetirementImageCapture();
		// The counts above already bound both stores. Visit each counted range in
		// bounded pages inside this SAME transaction instead of one cursor round
		// trip per row; values and key order are those the cursor walked.
		const collect = async (store: IDBObjectStore, count: number, table: "scopes" | "acceptedEntries") => {
			const rows: unknown[] = [],
				frames: Uint8Array[] = [];
			await visitCountedRange(store, range, count + 1, (row, primaryKey) => {
				// Capture this actual IDB row once, charging it before the next
				// page is read. The same detached canonical segments own its
				// optional frame and complete image; no native currency or
				// authorization is retained/reused across transactions.
				const frame = imageCapture!.append(table, row, captureRows ? primaryKey : undefined);
				if (captureRows) {
					frames.push(frame!);
				}
				rows.push(row);
			});
			return { rows, frames };
		};
		const [scopeCapture, rowCapture] = await Promise.all([collect(scopesStore, scopeCount, "scopes"), collect(rowsStore, rowCount, "acceptedEntries")]);
		const scopes = scopeCapture.rows,
			rows = rowCapture.rows;
		if (scopes.length !== scopeCount || rows.length !== rowCount) throw new CorruptLiveJournalError();
		const image = imageCapture.finish();
		const controlStore = journalStore("retirementControls");
		const control = retirementControl(await requestResult(controlStore.get(objectId)), objectId, codec);
		result = { control, image, frames: [...scopeCapture.frames, ...rowCapture.frames], scopes, rows };
		if (write !== undefined) {
			const equal =
				control === null || write.expected === null
					? control === write.expected
					: write.expectedCarriers === undefined
						? sameRetirementNativeCarriers(control, write.expected)
						: sameCapturedRetirementNativeCarriers((codec?.encode ?? encodeJournalRetirementNativeCarriers)(control), write.expectedCarriers);
			if (!equal || image.imageDigest !== write.imageDigest) throw new Error("retirement-stale");
			const drainHeaders = write.next.drain == null ? [] : scopes.map(fromRawScope);
			if (write.next.drain != null && control?.drain == null) {
				for (const prefix of write.next.drain.plan.prefixes) {
					const headers = drainHeaders.filter(
						(candidate) => indexedDB.cmp(scopeKey(candidate.scope), scopeKey(prefix.scope)) === 0
					);
					const count = rows.filter((raw) => {
						const row = raw as RawRow;
						return (
							row.objectId === objectId &&
							row.epoch === prefix.scope.epoch &&
							row.anchorDigest === prefix.scope.anchorDigest
						);
					}).length;
					if (
						headers.length !== 1 ||
						headers[0]?.nextJournalSequence !== prefix.highWatermark ||
						count !== prefix.highWatermark
					)
						throw new Error("retirement-stale");
					for (const row of prefix.rows) validateRetirementRow(rows, { scope: prefix.scope, row });
				}
			}
			if (write.deletions !== undefined) {
				const state = write.next.drain;
				if (
					state == null ||
					write.deletions.length === 0 ||
					write.deletions.length > LIVE_JOURNAL_RETIREMENT_BATCH_ROWS
				)
					throw new Error("retirement-transition");
				const deleting = new Set<string>();
				const deletingHeaders = new Set<string>();
				for (const selected of write.deletions) {
					if (selected.scope.objectId !== objectId) throw new Error("retirement-stale");
					if (!("row" in selected)) {
						const key = scopeKey(selected.scope), encodedKey = JSON.stringify(key);
						const found = scopes.filter(raw => indexedDB.cmp(scopeKey(fromRawScope(raw).scope), key) === 0);
						if (found.length !== 1 || deletingHeaders.has(encodedKey) || rows.some(raw => {
							const row = raw as RawRow;
							return row.objectId === objectId && row.epoch === selected.scope.epoch && row.anchorDigest === selected.scope.anchorDigest;
						}) || !sameBytes(journalRetirementCanonicalRow("scopes", key, found[0]), selected.exactCanonicalNativeFrameBytes)) throw new Error("retirement-stale");
						deletingHeaders.add(encodedKey);
						continue;
					}
					const prefix = state.plan.prefixes.find(
						(candidate) =>
							candidate.scope.objectId === objectId &&
							candidate.scope.epoch === selected.scope.epoch &&
							candidate.scope.anchorDigest === selected.scope.anchorDigest
					);
					const headers = drainHeaders.filter(
						(candidate) => indexedDB.cmp(scopeKey(candidate.scope), scopeKey(selected.scope)) === 0
					);
					if (prefix === undefined || headers.length !== 1 || headers[0]?.nextJournalSequence !== prefix.highWatermark)
						throw new Error("retirement-stale");
					const key = [...scopeKey(selected.scope), selected.row.journalSequence];
					const encodedKey = JSON.stringify(key);
					if (deleting.has(encodedKey)) throw new Error("retirement-stale");
					validateRetirementRow(rows, selected);
					deleting.add(encodedKey);
				}
				const residual = rows.filter((raw) => {
					const row = raw as RawRow;
					return !deleting.has(JSON.stringify([row.objectId, row.epoch, row.anchorDigest, row.journalSequence]));
				});
				const residualScopes = scopes.filter(raw => !deletingHeaders.has(JSON.stringify(scopeKey(fromRawScope(raw).scope))));
				if (journalRetirementImage(residualScopes, residual).imageDigest !== state.residualImageDigest)
					throw new Error("retirement-stale");
				// Delete detail only: original signed headers/high watermarks remain native.
				// The same strict transaction atomically publishes the bounded cursor below.
				await Promise.all(
					write.deletions.map((selected) =>
						"row" in selected ? requestResult(rowsStore.delete([...scopeKey(selected.scope), selected.row.journalSequence]))
							: requestResult(scopesStore.delete(scopeKey(selected.scope)))
					)
				);
			}
			await requestResult(controlStore.put(write.nextCarriers === undefined
				? nativeRetirementRecord(write.next)
				: capturedNativeRetirementRecord(write.next.objectId, write.nextCarriers)));
		}
	} catch (error) {
		primary = error;
		if (!borrowed)
			try {
				transaction.abort();
			} catch {
				/* The native transaction may already be terminal; preserve primary/readback. */
			}
	} finally {
		imageCapture?.release();
	}
	const committed =
		ownedTransaction !== undefined ? true : borrowed ? (await transactionComplete(transaction), true) : await terminal;
	if (primary !== undefined) throw primary;
	if (!committed || result === undefined) throw new Error("substrate-failure");
	return result;
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
function retirementFrame(selected: JournalRetirementDrainRow): Uint8Array {
	if (selected.row.exactCanonicalNativeFrameBytes !== undefined)
		return selected.row.exactCanonicalNativeFrameBytes.slice();
	return journalRetirementCanonicalRow(
		"acceptedEntries",
		[...scopeKey(selected.scope), selected.row.journalSequence],
		rawRow(
			{
				sourceKind: "local-issued",
				scope: selected.scope,
				vertexDigest: selected.row.vertexDigest,
				author: selected.row.author,
				authorSequence: selected.row.authorSequence,
			},
			selected.row.journalSequence
		)
	);
}
function validateRetirementRow(rows: readonly unknown[], selected: JournalRetirementDrainRow): void {
	const matches = rows.filter((raw) => {
		const row = raw as RawRow;
		return (
			row.objectId === selected.scope.objectId &&
			row.epoch === selected.scope.epoch &&
			row.anchorDigest === selected.scope.anchorDigest &&
			row.journalSequence === selected.row.journalSequence
		);
	});
	if (matches.length !== 1) throw new Error("retirement-stale");
	const exact = matches[0],
		row = fromRawRow(exact),
		frame = journalRetirementCanonicalRow(
			"acceptedEntries",
			[...scopeKey(selected.scope), selected.row.journalSequence],
			exact
		);
	if (
		row.sourceKind !== (selected.row.exactCanonicalNativeFrameBytes === undefined ? "local-issued" : "received") ||
		row.vertexDigest !== selected.row.vertexDigest ||
		!sameBytes(frame, retirementFrame(selected)) ||
		journalRetirementFrameDigest(frame) !== selected.row.nativeFrameDigest
	)
		throw new Error("retirement-stale");
}
function retirementDrainSource(captured: Pick<RetirementSnapshot, "control" | "image" | "frames">): LiveJournalRetirementDrainSource | undefined {
	return reconstructJournalRetirementDrainSource(captured.control, captured.image, captured.frames, retirementFrame);
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
	const hasMembership = typeof value === "object" && value !== null && Object.hasOwn(value, "closedMembershipBytes");
	const raw = exactRaw(value, hasMembership ? [...RAW_SCOPE_KEYS, "closedMembershipBytes"] : RAW_SCOPE_KEYS);
	if (raw === undefined) throw new CorruptLiveJournalError();
	if (hasMembership) {
		const membership = exclusiveBytes(raw.closedMembershipBytes);
		if (
			membership === undefined ||
			membership.length === 0 ||
			membership.length > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
		)
			throw new CorruptLiveJournalError();
	}
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
		scope: { anchorDigest: raw.anchorDigest as string, epoch: raw.epoch as number, objectId: raw.objectId as string },
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
		epoch: raw.epoch as number,
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
function sameNullableBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
	return left === null || right === null ? left === right : sameBytes(left, right);
}

function sameInstalledScope(left: StoredScope, right: StoredScope): boolean {
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
	if (needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => readSnapshot(database, scope));
	const transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readonly");
	const scopeRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")).get(scopeKey(scope));
	const rowsRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries")).getAll(rowRange(scope));
	const [storedScope, rawRows] = await Promise.all([requestResult(scopeRequest), requestResult(rowsRequest)]);
	await transactionComplete(transaction);
	if (storedScope === undefined) return null;
	return { rows: (rawRows as unknown[]).map(fromRawRow), scope: fromRawScope(storedScope) };
}

const WRONG_SCOPE_SNAPSHOT = Symbol("wrong-scope-snapshot");
type ReplaySnapshotRead = Readonly<{
	readonly durable: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
	readonly transaction: IDBTransaction;
}>;

async function readReplaySnapshot(database: IDBDatabase, scope: LiveJournalScope,
	codec: ReturnType<typeof createJournalRetirementControlCodec>): Promise<ReplaySnapshotRead> {
	if (needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => readReplaySnapshot(database, scope, codec));
	const transaction = strictTransaction(database, JOURNAL_STORES, "readonly");
	await checkReplayRetirement(transaction, scope, codec);
	const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes"));
	const scopeRequest = scopes.get(scopeKey(scope));
	const selectorRequest = scopes.getKey(scopeSelectorRange(scope));
	const rowsRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries")).getAll(rowRange(scope));
	const [storedScope, selectedKey, rawRows] = await Promise.all([
		requestResult(scopeRequest),
		requestResult(selectorRequest),
		requestResult(rowsRequest),
	]);
	await transactionComplete(transaction);
	if (storedScope === undefined)
		return { durable: selectedKey === undefined ? null : WRONG_SCOPE_SNAPSHOT, transaction };
	return { durable: { rows: (rawRows as unknown[]).map(fromRawRow), scope: fromRawScope(storedScope) }, transaction };
}

function sameSnapshotToken(left: LiveJournalSnapshotToken, right: LiveJournalSnapshotToken): boolean {
	return (
		left.kind === right.kind &&
		left.scope.objectId === right.scope.objectId &&
		left.scope.epoch === right.scope.epoch &&
		left.scope.anchorDigest === right.scope.anchorDigest &&
		left.highWatermark === right.highWatermark &&
		left.genesisDigest === right.genesisDigest &&
		left.parametersDigest === right.parametersDigest &&
		left.orderedRowDigest === right.orderedRowDigest &&
		left.snapshotDigest === right.snapshotDigest
	);
}

async function readReservedReadiness(
	database: IDBDatabase,
	verified: WeakMap<IDBTransaction, Map<string, LiveJournalSnapshotToken>>,
	scope: LiveJournalScope,
	codec: ReturnType<typeof createJournalRetirementControlCodec>
): Promise<LiveJournalReadinessResult | undefined> {
	if (needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => readReservedReadiness(database, verified, scope, codec));
	const transaction = nativeReadReservationTransaction(database);
	if (transaction === undefined) return undefined;
	await checkReplayRetirement(transaction, scope, codec);
	const token = verified.get(transaction)?.get(JSON.stringify(scopeKey(scope)));
	if (
		token === undefined ||
		token.scope.objectId !== scope.objectId ||
		token.scope.epoch !== scope.epoch ||
		token.scope.anchorDigest !== scope.anchorDigest
	)
		return undefined;
	// A page can retain a valid older prefix token. It is not complete readiness.
	const raw = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")).get(scopeKey(scope)));
	if (raw === undefined || fromRawScope(raw).nextJournalSequence !== token.highWatermark) return undefined;
	await transactionComplete(transaction);
	return Object.freeze({
		ok: true,
		ready: true,
		rowCount: token.highWatermark,
		scope: Object.freeze({ ...scope }),
		snapshot: token,
	});
}

async function readReservedPage(
	database: IDBDatabase,
	verified: WeakMap<IDBTransaction, Map<string, LiveJournalSnapshotToken>>,
	page: Readonly<Record<string, unknown>>,
	codec: ReturnType<typeof createJournalRetirementControlCodec>
): Promise<LiveJournalPageResult | undefined> {
	if (needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => readReservedPage(database, verified, page, codec));
	const transaction = nativeReadReservationTransaction(database);
	if (transaction === undefined) return undefined;
	const supplied = page.snapshot as LiveJournalSnapshotToken;
	const token = verified.get(transaction)?.get(JSON.stringify(scopeKey(supplied.scope)));
	await checkReplayRetirement(transaction, page.scope as LiveJournalScope, codec);
	if (token === undefined || !sameSnapshotToken(token, supplied)) return undefined;
	const after = page.afterSequence as number;
	const limit = page.limit as number;
	const remaining = Math.max(0, token.highWatermark - after - 1);
	// The existing reservation keeps this exact native readonly transaction alive:
	// its fully validated image cannot overlap ANY native readwrite transaction.
	// IDBDatabase.version is a schema version, never a reusable data-version guard.
	const rawRows =
		remaining === 0
			? []
			: await requestResult(
					transaction
						.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries"))
						.getAll(
							IDBKeyRange.bound(
								[...scopeKey(token.scope), after + 1],
								[...scopeKey(token.scope), token.highWatermark - 1]
							),
							limit + 1
						)
				);
	await transactionComplete(transaction);
	if (rawRows.length !== Math.min(remaining, limit + 1)) throw new CorruptLiveJournalError();
	const rows = (rawRows as unknown[]).slice(0, limit).map((raw, index) => {
		const row = fromRawRow(raw);
		if (
			row.journalSequence !== after + index + 1 ||
			row.scope.objectId !== token.scope.objectId ||
			row.scope.epoch !== token.scope.epoch ||
			row.scope.anchorDigest !== token.scope.anchorDigest
		)
			throw new CorruptLiveJournalError();
		return Object.freeze({ ...row, scope: Object.freeze({ ...row.scope }) });
	});
	return Object.freeze({
		nextSequence: rawRows.length > limit ? (rows[rows.length - 1]?.journalSequence ?? null) : null,
		ok: true,
		rows: Object.freeze(rows),
		scope: Object.freeze({ ...token.scope }),
		snapshot: token,
	});
}

function failed(kind: LiveJournalFailureKind): Readonly<{ readonly kind: LiveJournalFailureKind; readonly ok: false }> {
	return Object.freeze({ kind, ok: false });
}

function captureAddressedClosure(snapshot: DurableSnapshot,
	validation?: ReturnType<typeof createLiveJournalSnapshotValidation>): DurableSnapshot | undefined {
	try {
		const captured = deriveLiveJournalSnapshot({ durable: snapshot, validation } as never);
		if (captured.ok !== true) return undefined;
		return { rows: captured.rows, scope: snapshot.scope };
	} catch {
		return undefined;
	}
}

type SignedScopeRead =
	| Readonly<{ readonly ok: true; readonly stored: StoredScope | null }>
	| Extract<LiveJournalSignedAnchorReadResult, { readonly ok: false }>;

function captureSignedRawScope(input: LiveJournalSignedAnchorReadInput, raw: unknown): SignedScopeRead {
	if (raw === undefined) return { ok: true, stored: null };
	const fields: Record<string, unknown> = {};
	try {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failed("store-poisoned");
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) return failed("store-poisoned");
		const keys = Reflect.ownKeys(raw);
		const expectedKeys: readonly string[] = Object.hasOwn(raw, "closedMembershipBytes")
			? [...RAW_SCOPE_KEYS, "closedMembershipBytes"]
			: RAW_SCOPE_KEYS;
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
		) {
			return failed("store-poisoned");
		}
		if (Object.hasOwn(raw, "closedMembershipBytes")) {
			const witness = Object.getOwnPropertyDescriptor(raw, "closedMembershipBytes");
			if (witness === undefined || !("value" in witness) || !witness.enumerable) return failed("store-poisoned");
			const bytes = exclusiveBytes(witness.value);
			if (bytes === undefined || bytes.length === 0 || bytes.length > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes)
				return failed("store-poisoned");
		}
		for (const key of RAW_SCOPE_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(raw, key);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
				return failed("store-poisoned");
			fields[key] = descriptor.value;
		}
	} catch {
		return failed("store-poisoned");
	}
	// IDB already cloned this entire row. Only the detached output is locally byte-bounded.
	const captured = captureLiveJournalSignedAnchorReadObservation(input, {
		detachedAnchorSignature: fields.detachedAnchorSignature,
		exactCanonicalAnchorPreimageBytes: fields.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: fields.exactCanonicalParametersCarrierBytes,
		nextJournalSequence: fields.nextJournalSequence,
		parametersDigest: fields.parametersDigest,
		scope: { anchorDigest: fields.anchorDigest, epoch: fields.epoch, objectId: fields.objectId },
	});
	return captured.ok ? { ok: true, stored: captured.value } : captured;
}

function signedTransactionTerminal(transaction: IDBTransaction): Promise<boolean> {
	const held = nativeReadReservationCheck(transaction);
	if (held !== undefined)
		return held.then(
			() => true,
			() => false
		);
	// A request/error event is not terminal: join the genuine complete or abort event.
	let requestFailed = false;
	return new Promise((resolve) => {
		transaction.addEventListener("error", () => {
			requestFailed = true;
		});
		transaction.addEventListener("complete", () => resolve(!requestFailed), { once: true });
		transaction.addEventListener("abort", () => resolve(false), { once: true });
	});
}

function addressedEntryExists(key: IDBValidKey | undefined, scope: LiveJournalScope): boolean {
	const prefix = scopeKey(scope);
	return Array.isArray(key) && key.length >= 3 && prefix.every((part, index) => key[index] === part);
}

type EmptyClosureRead =
	| Readonly<{ readonly ok: true; readonly kind: "empty"; readonly snapshot: DurableSnapshot | null }>
	| Readonly<{ readonly ok: true; readonly kind: "populated" }>
	| Extract<LiveJournalSignedAnchorReadResult, { readonly ok: false }>;

function captureEmptyClosure(
	input: LiveJournalSignedAnchorReadInput,
	raw: unknown,
	key: IDBValidKey | undefined
): EmptyClosureRead {
	const captured = captureSignedRawScope(input, raw);
	if (!captured.ok) return captured;
	const exists = addressedEntryExists(key, input.scope);
	if (captured.stored === null) return exists ? failed("store-poisoned") : { kind: "empty", ok: true, snapshot: null };
	if ((captured.stored.nextJournalSequence === 0) === exists) return failed("store-poisoned");
	if (exists) return { kind: "populated", ok: true };
	const snapshot = captureAddressedClosure({ rows: [], scope: captured.stored });
	return snapshot === undefined ? failed("store-poisoned") : { kind: "empty", ok: true, snapshot };
}

async function readEmptyClosure(
	database: IDBDatabase,
	input: LiveJournalSignedAnchorReadInput
): Promise<EmptyClosureRead> {
	if (needsNativeReadReservationTurn(database))
		return runNativeReservedRead(database, () => readEmptyClosure(database, input));
	const transaction = strictTransaction(database, ["acceptedEntries", "scopes"], "readonly");
	const terminal = signedTransactionTerminal(transaction);
	let result: EmptyClosureRead | undefined;
	try {
		const scopeRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")).get(scopeKey(input.scope));
		// One complete-prefix lower-bound key probe includes nonnumeric sequence keys.
		const entryRequest = transaction
			.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries"))
			.getKey(IDBKeyRange.lowerBound(scopeKey(input.scope)));
		const [raw, key] = await Promise.all([requestResult(scopeRequest), requestResult(entryRequest)]);
		result = captureEmptyClosure(input, raw, key);
	} catch {
		// Join the terminal below even when the request or capture failed.
	}
	if (!(await terminal) || result === undefined) throw new Error("indexeddb-read-failed");
	return result;
}

type HistoricalWriterOutcome = Readonly<{
	readonly admitted: boolean;
	readonly before: DurableSnapshot | null;
	readonly idempotent: boolean;
	readonly rejected?: Extract<LiveJournalHistoricalAnchorImportResult, { readonly ok: false }>;
}>;

async function historicalAnchorWriter(
	database: IDBDatabase,
	input: StoredScope,
	maxBytes: number
): Promise<HistoricalWriterOutcome> {
	const transaction = strictTransaction(database, JOURNAL_STORES, "readwrite");
	const terminal = signedTransactionTerminal(transaction);
	let outcome: HistoricalWriterOutcome = { admitted: false, before: null, idempotent: false };
	try {
		const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes"));
		const scopeRequest = scopes.get(scopeKey(input.scope));
		const entryRequest = transaction
			.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries"))
			.getKey(IDBKeyRange.lowerBound(scopeKey(input.scope)));
		const controlRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "retirementControls")).get(input.scope.objectId);
		const [raw, key, controlRaw] = await Promise.all([
			requestResult(scopeRequest),
			requestResult(entryRequest),
			requestResult(controlRequest),
		]);
		const control = admitRetirementControl(controlRaw, input.scope);
		const closure = captureEmptyClosure({ maxBytes, scope: input.scope }, raw, key);
		if (!closure.ok) outcome = { ...outcome, rejected: closure };
		else if (closure.kind === "populated")
			outcome = { ...outcome, rejected: Object.freeze({ kind: "import-populated", ok: false }) };
		else {
			const before = closure.snapshot;
			if (before !== null && !sameInstalledScope(before.scope, input)) {
				outcome = { ...outcome, before, rejected: failed("genesis-conflict") };
			} else {
				outcome = { admitted: true, before, idempotent: before !== null };
				if (before === null) {
					admitRetirementMutation(control, input.scope);
					await requestResult(scopes.add(rawScope(input)));
				}
			}
		}
		if (outcome.rejected !== undefined) transaction.abort();
		else if (!outcome.idempotent) advanceRetirementControl(transaction, control);
	} catch (error) {
		if (retirementFailure(error) !== "store-poisoned")
			outcome = { ...outcome, rejected: failed(retirementFailure(error)) };
		try {
			transaction.abort();
		} catch {
			// It may already be terminal. Never infer rollback from the caught error.
		}
	}
	await terminal;
	return outcome;
}

type WriterOutcome = Readonly<{
	readonly before: DurableSnapshot | null;
	readonly idempotent: boolean;
	readonly rejected?: LiveJournalFailureKind;
	readonly row?: StoredRow;
	readonly nativeImage?: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
}>;

function installWriter(database: IDBDatabase, input: StoredScope): Promise<WriterOutcome> {
	return new Promise((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = strictTransaction(database, JOURNAL_STORES, "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let outcome: WriterOutcome | undefined;
		const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes"));
		const request = scopes.get(scopeKey(input.scope));
		const rowsRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries")).getAll(rowRange(input.scope));
		const controlRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "retirementControls")).get(input.scope.objectId);
		let controlLoaded = false;
		controlRequest.addEventListener(
			"success",
			() => {
				controlLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		let scopeLoaded = false;
		let rowsLoaded = false;
		let processed = false;
		const processClosure = (): void => {
			if (!scopeLoaded || !rowsLoaded || !controlLoaded || processed) return;
			processed = true;
			try {
				const control = admitRetirementControl(controlRequest.result, input.scope);
				const rows = (rowsRequest.result as unknown[]).map(fromRawRow);
				const existing = request.result === undefined ? null : fromRawScope(request.result);
				let before: DurableSnapshot | null = null;
				if (existing === null) {
					if (rows.length !== 0) {
						outcome = { before, idempotent: false, rejected: "store-poisoned" };
						transaction.abort();
						return;
					}
					admitRetirementMutation(control, input.scope);
					scopes.add(rawScope(input));
					advanceRetirementControl(transaction, control);
					outcome = { before, idempotent: false };
					return;
				}
				before = captureAddressedClosure({ rows, scope: existing }) ?? null;
				if (before === null) {
					outcome = { before, idempotent: false, rejected: "store-poisoned" };
					transaction.abort();
				} else if (sameInstalledScope(before.scope, input)) {
					outcome = { before, idempotent: true };
				} else {
					outcome = { before, idempotent: false, rejected: "genesis-conflict" };
					transaction.abort();
				}
			} catch (error) {
				outcome = { before: null, idempotent: false, rejected: retirementFailure(error) };
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

function appendWriter(
	database: IDBDatabase,
	initial: PendingRow,
	expectedNativeImage?: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>,
	validation?: ReturnType<typeof createLiveJournalSnapshotValidation>
): Promise<WriterOutcome> {
	return new Promise((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = strictTransaction(database, JOURNAL_STORES, "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let candidate = initial;
		let outcome: WriterOutcome | undefined;
		const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes"));
		const entries = transaction.objectStore(roomStoreName(transaction.db, "journal", "acceptedEntries"));
		const scopeRequest = scopes.get(scopeKey(candidate.scope));
		const rowsRequest = entries.getAll(rowRange(candidate.scope));
		const rejectWriter = (kind: LiveJournalFailureKind, before: DurableSnapshot | null): void => {
			outcome = { before, idempotent: false, rejected: kind };
			transaction.abort();
		};
		const controlRequest = transaction.objectStore(roomStoreName(transaction.db, "journal", "retirementControls")).get(candidate.scope.objectId);
		let controlLoaded = false;
		controlRequest.addEventListener(
			"success",
			() => {
				controlLoaded = true;
				processClosure();
			},
			{ once: true }
		);
		let scopeLoaded = false;
		let rowsLoaded = false;
		let processed = false;
		let currencyLoaded = expectedNativeImage === undefined;
		let sourceImage: RetirementSnapshot | undefined;
		const processClosure = (): void => {
			if (!scopeLoaded || !rowsLoaded || !controlLoaded || !currencyLoaded || processed) return;
			processed = true;
			try {
				const control = admitRetirementControl(controlRequest.result, candidate.scope);
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
				const before = captureAddressedClosure({ rows, scope }, validation);
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
					else {
						outcome = {
							before,
							idempotent: true,
							row: retained,
							...(sourceImage === undefined
								? {}
								: {
										nativeImage: Object.freeze({
											imageDigest: sourceImage.image.imageDigest,
											controlBytes:
												sourceImage.control === null ? null : encodeJournalRetirementControl(sourceImage.control),
										}),
									}),
						};
					}
					return;
				}
				if (decision.action !== "append") {
					rejectWriter("internal-invariant", before);
					return;
				}
				admitRetirementMutation(control, candidate.scope);
				const sequence = scope.nextJournalSequence;
				const stored = rawRow(candidate, sequence);
				const add = entries.add(stored);
				add.addEventListener(
					"success",
					() => {
						// Preserve opaque header evidence while advancing ordinary detail.
						const postScope = { ...scopeRequest.result, nextJournalSequence: sequence + 1 };
						scopes.put(postScope);
						advanceRetirementControl(transaction, control);
						const postRows =
							sourceImage === undefined
								? undefined
								: [...sourceImage.rows, stored].sort((left, right) => {
										const a = fromRawRow(left),
											b = fromRawRow(right);
										return indexedDB.cmp(
											[...scopeKey(a.scope), a.journalSequence],
											[...scopeKey(b.scope), b.journalSequence]
										);
									});
						const postImage =
							sourceImage === undefined || postRows === undefined
								? undefined
								: journalRetirementImage(
										sourceImage.scopes.map((value) => {
											const selectedScope = fromRawScope(value).scope;
											if (indexedDB.cmp(scopeKey(selectedScope), scopeKey(scope.scope)) === 0) return postScope;
											if (
												control?.drain?.plan.prefixes.some(
													(prefix) => indexedDB.cmp(scopeKey(prefix.scope), scopeKey(selectedScope)) === 0
												)
											) {
												const retained = { ...(value as Record<string, unknown>) };
												delete retained.closedMembershipBytes;
												return retained;
											}
											return value;
										}),
										postRows
									);
						const postControl =
							sourceImage?.control == null
								? null
								: encodeJournalRetirementControl(advanceJournalRetirementMutationControl(sourceImage.control));
						outcome = {
							before,
							idempotent: false,
							row: fromRawRow(stored),
							...(postImage === undefined
								? {}
								: { nativeImage: Object.freeze({ imageDigest: postImage.imageDigest, controlBytes: postControl }) }),
						};
					},
					{ once: true }
				);
			} catch (error) {
				rejectWriter(retirementFailure(error), null);
			}
		};
		if (expectedNativeImage !== undefined) {
			// Reuse the original bounded whole-object capture inside this exact RW.
			// Foreign mutations after the joined RO cannot be mistaken for our own preimage.
			void retirementSnapshot(database, initial.scope.objectId, undefined, false, transaction).then(
				(actual) => {
					const controlBytes = actual.control === null ? null : encodeJournalRetirementControl(actual.control);
					if (
						actual.image.imageDigest !== expectedNativeImage.imageDigest ||
						(controlBytes === null || expectedNativeImage.controlBytes === null
							? controlBytes !== expectedNativeImage.controlBytes
							: !sameBytes(controlBytes, expectedNativeImage.controlBytes))
					) {
						rejectWriter("retirement-stale", null);
						return;
					}
					sourceImage = actual;
					currencyLoaded = true;
					processClosure();
				},
				() => rejectWriter("retirement-stale", null)
			);
		}
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
 * @returns The strict live-journal capability.
 */
export async function createBrowserDurableLiveJournalStore(
	options: BrowserDurableLiveJournalStoreOptions
): Promise<DurableLiveJournalStore & NativeReadReservationPort> {
	const primaryDatabaseName = captureOptions(options);
	const database = await openDatabase(`${primaryDatabaseName}--drp-live-journal-v1`);
	try {
		await admit(database);
	} catch (error) {
		database.close();
		throw error;
	}
	return createJournalStoreOver(database);
}

/**
 * Creates the strict live-journal capability inside a ready version-7 room database
 * (slice 14a). Every operation, row format and refusal is the dedicated store's; only
 * its stores live in the `journal:` namespace and its held read views cover only that
 * namespace. It never creates or upgrades the room database.
 * @param options - The room database name.
 * @returns The strict live-journal capability over its own room connection.
 */
export async function createBrowserRoomLiveJournalStore(
	options: Readonly<{ databaseName: string }>
): Promise<DurableLiveJournalStore & NativeReadReservationPort> {
	const databaseName = captureRoomOptions(options);
	let database: IDBDatabase;
	try {
		database = await openBrowserRoomOwnerConnection(databaseName, "journal");
	} catch {
		throw failureError("unsupported-schema");
	}
	try {
		// The room connection already checked the exact journal namespace catalog.
		const transaction = strictTransaction(database, JOURNAL_STORES, "readwrite");
		await transactionComplete(transaction);
	} catch (error) {
		database.close();
		if (typeof error === "object" && error !== null && Reflect.get(error, "kind") === "durability-unavailable")
			throw error;
		throw failureError("unsupported-schema");
	}
	return createJournalStoreOver(database, databaseName);
}

function captureRoomOptions(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("malformed-input");
	const keys = Reflect.ownKeys(value);
	const descriptor = Object.getOwnPropertyDescriptor(value, "databaseName");
	if (
		keys.length !== 1 ||
		keys[0] !== "databaseName" ||
		descriptor === undefined ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "string" ||
		descriptor.value.length === 0 ||
		descriptor.value.includes("\0")
	)
		throw new TypeError("malformed-input");
	return descriptor.value;
}

function createJournalStoreOver(
	database: IDBDatabase,
	roomDatabaseName?: string
): DurableLiveJournalStore & NativeReadReservationPort {
	const readReservations = new NativeReadReservationOwner(database);
	const retirementCodec = createJournalRetirementControlCodec();
	const readRetirementSnapshot = (
		objectId: string,
		write?: Parameters<typeof retirementSnapshot>[2],
		captureRows = false,
		ownedTransaction?: IDBTransaction
	): Promise<RetirementSnapshot> => retirementSnapshot(database, objectId, write, captureRows, ownedTransaction, retirementCodec);
	database.addEventListener("versionchange", () => {
		void close().catch(() => undefined);
	});
	let closed = false;
	let poisoned = false;
	// One bounded raw retirement basis, valid only in this facade's exact held
	// native readonly transaction. Never used by mutation or native readback.
	let heldRetirementImage: Readonly<{
		transaction: IDBTransaction;
		objectId: string;
		controlBytes?: Uint8Array;
		planBytes?: Uint8Array;
		image: LiveJournalRetirementImage;
		frames: readonly Uint8Array[];
		/** One weak nominal enrollment; no additional retained frame union. */
		enrollment: {observation?: WeakRef<LiveJournalRetirementImageObservation>};
	}> | undefined;
	// Pure leaf facts survive native transactions, not native currency. Every
	// consumer still captures the complete fresh native closure before matching.
	let snapshotValidation = createLiveJournalSnapshotValidation();
	const resetSnapshotValidation = (): void => {
		snapshotValidation.release();
		if (!closed && !poisoned) snapshotValidation = createLiveJournalSnapshotValidation();
	};
	const poison = (): void => {
		poisoned = true;
		retirementCodec.release();
		snapshotValidation.release();
		heldRetirementImage = undefined;
		verifiedReplay = new WeakMap();
	};
	const invalidateHeldRetirementImage = (event: Event): void => {
		if (heldRetirementImage?.transaction === event.target) heldRetirementImage = undefined;
	};
	// Object changes within one native book must not accumulate listeners.
	// Weak identities retain no ended transaction or authority.
	const observedRetirementTransactions = new WeakSet<IDBTransaction>();
	let closePromise: Promise<void> | undefined;
	const retirementOperations = new Set<Promise<unknown>>();
	const trackRetirement = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operation();
		retirementOperations.add(result);
		void result.then(
			() => retirementOperations.delete(result),
			() => retirementOperations.delete(result)
		);
		return result;
	};
	// One exact held native image, with at most the existing protected-scope
	// count of verified prefix tokens and NO retained accepted rows/payloads.
	// Alternating current/historical scopes must not invalidate each other's
	// pure validation while this same all-store native RO excludes every writer.
	let verifiedReplay = new WeakMap<IDBTransaction, Map<string, LiveJournalSnapshotToken>>();
	const rememberVerifiedReplay = (transaction: IDBTransaction, token: LiveJournalSnapshotToken): void => {
		if (!isNativeReadReservationTransaction(transaction) || nativeReadReservationTransaction(database) !== transaction ||
			unavailable() !== undefined) return;
		let tokens = verifiedReplay.get(transaction);
		if (tokens === undefined) {
			verifiedReplay = new WeakMap();
			tokens = new Map(); verifiedReplay.set(transaction, tokens);
		}
		const key = JSON.stringify(scopeKey(token.scope));
		if (!tokens.has(key) && tokens.size >= LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes) return;
		tokens.set(key, token);
	};
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
			poison();
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

	const install = async (
		operation: "install" | "installEpochAnchor",
		input: InstallLiveJournalGenesisInput
	): Promise<InstallLiveJournalGenesisResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		try {
			captured = captureLiveJournalInput(operation, input);
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
		// A definite fence refusal joins the native abort before any mutation.
		// Retained headers may now have drained detail, not a live replay prefix.
		if (outcome.rejected === "retirement-fenced") return failed(outcome.rejected);
		const actual = await postWriteSnapshot(selected.stored.scope);
		if (outcome.rejected !== undefined) {
			if (outcome.rejected === "store-poisoned") poison();
			if (actual === undefined && outcome.rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual) === undefined) {
				poison();
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
	const installGenesis = (input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult> =>
		install("install", input);
	const installEpochAnchor = (input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult> =>
		install("installEpochAnchor", input);

	const appendAccepted = async (input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		let expectedNativeImage: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }> | undefined;
		try {
			const expected = Object.getOwnPropertyDescriptor(input, "expectedNativeImage");
			if (expected !== undefined) {
				const owned = captureSourceBoundJournalAppendInput(input);
				if (!owned.ok) return failed(owned.kind);
				expectedNativeImage = owned.value.expectedNativeImage;
				captured = Object.freeze({ ok: true, value: owned.value.row });
			} else captured = captureLiveJournalInput("append", input);
			if (captured.ok !== true) return failed(captured.kind);
		} catch {
			return failed("malformed-input");
		}
		const candidate = captured.value as PendingRow;
		let outcome: WriterOutcome;
		try {
			outcome = await appendWriter(database, candidate, expectedNativeImage, snapshotValidation);
		} catch {
			return failed("substrate-failure");
		}
		// Preserve the definite joined native refusal; applying full-prefix
		// validation to deliberately drained old detail would poison this facade.
		if (outcome.rejected === "retirement-fenced") return failed(outcome.rejected);
		const actual = await postWriteSnapshot(candidate.scope);
		if (outcome.rejected !== undefined) {
			if (outcome.rejected === "store-poisoned") poison();
			if (actual === undefined && outcome.rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual, snapshotValidation) === undefined) {
				poison();
				return failed("store-poisoned");
			}
			return failed(outcome.rejected);
		}
		if (outcome.row === undefined) return failed("internal-invariant");
		const kind = observe(actual, outcome.before, { kind: "append", row: outcome.row });
		if (kind !== undefined) return failed(kind);
		if (expectedNativeImage !== undefined) {
			if (outcome.nativeImage === undefined) return failed("internal-invariant");
			try {
				const complete = await readRetirementSnapshot(candidate.scope.objectId);
				const controlBytes = complete.control === null ? null : encodeJournalRetirementControl(complete.control);
				if (
					complete.image.imageDigest !== outcome.nativeImage.imageDigest ||
					(controlBytes === null || outcome.nativeImage.controlBytes === null
						? controlBytes !== outcome.nativeImage.controlBytes
						: !sameBytes(controlBytes, outcome.nativeImage.controlBytes))
				)
					return failed("outcome-unknown");
			} catch {
				return failed("outcome-unknown");
			}
		}
		return Object.freeze({
			idempotent: outcome.idempotent,
			journalSequence: outcome.row.journalSequence,
			ok: true,
			scope: Object.freeze({ ...outcome.row.scope }),
			sourceKind: outcome.row.sourceKind,
			vertexDigest: outcome.row.vertexDigest,
			...(outcome.nativeImage === undefined ? {} : { nativeImage: outcome.nativeImage }),
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
		let transaction: IDBTransaction;
		try {
			const reserved = await readReservedReadiness(database, verifiedReplay, scope, retirementCodec);
			if (reserved !== undefined) return reserved;
			({ durable, transaction } = await readReplaySnapshot(database, scope, retirementCodec));
		} catch (error) {
			if (error instanceof Error && error.message === "retirement-fenced") return failed("stale-snapshot");
			if (error instanceof CorruptLiveJournalError) {
				poison();
				return failed("store-poisoned");
			}
			return failed("substrate-failure");
		}
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return Object.freeze({ kind: "not-installed", ok: true, ready: false });
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshotReadiness({ durable, validation: snapshotValidation } as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				poison();
				return failed("store-poisoned");
			}
		} catch {
			return failed("internal-invariant");
		}
		rememberVerifiedReplay(transaction, derived.token as LiveJournalSnapshotToken);
		return Object.freeze({
			ok: true,
			ready: true,
			rowCount: derived.rowCount as number,
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
		let transaction: IDBTransaction;
		try {
			const reserved = await readReservedPage(database, verifiedReplay, page, retirementCodec);
			if (reserved !== undefined) return reserved;
			({ durable, transaction } = await readReplaySnapshot(database, scope, retirementCodec));
		} catch (error) {
			if (error instanceof Error && error.message === "retirement-fenced") return failed("stale-snapshot");
			if (error instanceof CorruptLiveJournalError) {
				poison();
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
				validation: snapshotValidation,
				highWatermark: supplied.highWatermark,
				supplied,
			} as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				const kind = derived.kind as LiveJournalFailureKind;
				if (kind === "store-poisoned") poison();
				return failed(kind);
			}
		} catch {
			return failed("internal-invariant");
		}
		rememberVerifiedReplay(transaction, derived.token as LiveJournalSnapshotToken);
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

	const readAnchorPreimage = async (input: LiveJournalAnchorReadInput): Promise<LiveJournalAnchorReadResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalInput("anchorRead", input);
		if (!captured.ok) return failed(captured.kind);
		const selected = captured.value as LiveJournalAnchorReadInput;
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => readAnchorPreimage(selected));
			} catch {
				return unavailable() ?? failed("substrate-failure");
			}
		}
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		let result: LiveJournalAnchorReadResult;
		try {
			const transaction = strictTransaction(database, ["scopes"], "readonly");
			const request = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")).get(scopeKey(selected.scope));
			const observation = requestResult(request).then((raw: unknown): LiveJournalAnchorReadResult => {
				if (raw === undefined) return Object.freeze({ kind: "missing", ok: true });
				// IndexedDB has already cloned the whole row. Inspect only required own fields;
				// unrelated parameter/signature carriers are neither enumerated nor copied here.
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failed("store-poisoned");
				const fields: Record<string, unknown> = {};
				for (const key of ["objectId", "epoch", "anchorDigest", "exactCanonicalAnchorPreimageBytes"]) {
					const descriptor = Object.getOwnPropertyDescriptor(raw, key);
					if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
						return failed("store-poisoned");
					fields[key] = descriptor.value;
				}
				return captureLiveJournalAnchorReadObservation(selected, {
					exactCanonicalAnchorPreimageBytes: fields.exactCanonicalAnchorPreimageBytes,
					scope: { anchorDigest: fields.anchorDigest, epoch: fields.epoch, objectId: fields.objectId },
				});
			});
			[result] = await Promise.all([observation, transactionComplete(transaction)]);
			await nativeReadReservationCheck(transaction);
		} catch {
			return failed("substrate-failure");
		}
		if (!result.ok && result.kind === "store-poisoned") poison();
		return result;
	};

	const readSignedAnchorEnvelope = async function (
		input: LiveJournalSignedAnchorReadInput
	): Promise<LiveJournalSignedAnchorReadResult> {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalSignedAnchorReadInput(input);
		if (!captured.ok) return captured;
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => readSignedAnchorEnvelope(captured.value));
			} catch {
				return unavailable() ?? failed("substrate-failure");
			}
		}
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		let result: SignedScopeRead | undefined;
		try {
			const transaction = strictTransaction(database, ["scopes"], "readonly");
			const terminal = signedTransactionTerminal(transaction);
			try {
				const request = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")).get(scopeKey(captured.value.scope));
				result = captureSignedRawScope(captured.value, await requestResult(request));
			} catch {
				// A failed request must still join its admitted transaction terminal.
			}
			if (!(await terminal) || result === undefined) return failed("substrate-failure");
			await nativeReadReservationCheck(transaction);
		} catch {
			return failed("substrate-failure");
		}
		if (!result.ok) {
			if (result.kind === "store-poisoned") poison();
			return result;
		}
		if (result.stored === null) return Object.freeze({ kind: "missing", ok: true });
		const stored = result.stored;
		return Object.freeze({
			kind: "present",
			ok: true,
			parametersDigest: stored.parametersDigest,
			scope: stored.scope,
			envelope: Object.freeze({
				objectId: stored.scope.objectId,
				exactCanonicalAnchorPreimageBytes: stored.exactCanonicalAnchorPreimageBytes,
				detachedAnchorSignature: stored.detachedAnchorSignature,
				exactCanonicalParametersCarrierBytes: stored.exactCanonicalParametersCarrierBytes,
			}),
		});
	};

	const importHistoricalAnchor = async (
		input: LiveJournalHistoricalAnchorImportInput
	): Promise<LiveJournalHistoricalAnchorImportResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalHistoricalAnchorImportInput(input);
		if (!captured.ok) return captured;
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		const selected = captured.value;
		let outcome: HistoricalWriterOutcome;
		try {
			outcome = await historicalAnchorWriter(database, selected.stored, selected.maxBytes);
		} catch {
			return failed("substrate-failure");
		}
		if (outcome.rejected !== undefined) {
			if (outcome.rejected.kind === "store-poisoned") poison();
			return outcome.rejected;
		}
		if (!outcome.admitted) return failed("substrate-failure");
		let actual: DurableSnapshot | null | undefined;
		try {
			const closure = await readEmptyClosure(database, { maxBytes: selected.maxBytes, scope: selected.stored.scope });
			if (!closure.ok) {
				if (closure.kind === "store-poisoned") {
					poison();
					return closure;
				}
				actual = undefined;
			} else actual = closure.kind === "empty" ? closure.snapshot : undefined;
		} catch {
			actual = undefined;
		}
		const kind = observe(actual, outcome.before, { kind: "install", scope: selected.stored });
		return kind === undefined
			? Object.freeze({
					idempotent: outcome.idempotent,
					ok: true,
					parametersDigest: selected.parametersDigest,
					scope: selected.stored.scope,
				})
			: failed(kind);
	};

	const recordClosedMembership: NonNullable<DurableLiveJournalStore["recordClosedMembership"]> = (input) =>
		trackRetirement(async () => {
			const blocked = unavailable();
			if (blocked !== undefined) return blocked;
			let selected: ReturnType<typeof captureJournalClosedMembershipInput>;
			try {
				selected = captureJournalClosedMembershipInput(input);
			} catch {
				return failed("malformed-input");
			}
			if (nativeReadReservationTransaction(database) !== undefined) return failed("retirement-transition");
			resetSnapshotValidation();
			let transaction: IDBTransaction;
			try {
				transaction = strictTransaction(database, JOURNAL_STORES, "readwrite");
			} catch {
				return failed("substrate-failure");
			}
			const terminal = signedTransactionTerminal(transaction);
			let attempted = false,
				idempotent = false,
				refusal: LiveJournalFailureKind | undefined;
			let expectedAfter: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }> | undefined;
			try {
				const before = await readRetirementSnapshot(selected.scope.objectId, undefined, true, transaction);
				const beforeBytes = before.control === null ? null : encodeJournalRetirementControl(before.control);
				if (
					before.image.imageDigest !== selected.expectedNativeImage.imageDigest ||
					!sameNullableBytes(beforeBytes, selected.expectedNativeImage.controlBytes)
				)
					throw failureError("retirement-stale");
				const scopes = transaction.objectStore(roomStoreName(transaction.db, "journal", "scopes")),
					raw = await requestResult(scopes.get(scopeKey(selected.scope)));
				if (raw === undefined) throw failureError("not-installed");
				fromRawScope(raw);
				const row = raw as Record<string, unknown>;
				if (Object.hasOwn(row, "closedMembershipBytes")) {
					if (!sameBytes(row.closedMembershipBytes as Uint8Array, selected.exactCanonicalMembershipBytes))
						throw failureError("evidence-conflict");
					idempotent = true;
					expectedAfter = { imageDigest: before.image.imageDigest, controlBytes: beforeBytes };
				} else {
					const control = admitRetirementControl(
						before.control === null ? undefined : nativeRetirementRecord(before.control),
						selected.scope
					);
					admitRetirementMutation(control, selected.scope);
					const clearScopes = control?.drain?.plan.prefixes.map((prefix) => prefix.scope) ?? [];
					const postScopes = before.scopes.map((value) => {
						const scope = fromRawScope(value).scope,
							retained = { ...(value as Record<string, unknown>) };
						if (clearScopes.some((clear) => indexedDB.cmp(scopeKey(clear), scopeKey(scope)) === 0))
							delete retained.closedMembershipBytes;
						if (indexedDB.cmp(scopeKey(selected.scope), scopeKey(scope)) === 0)
							retained.closedMembershipBytes = selected.exactCanonicalMembershipBytes;
						return retained;
					});
					const after = journalRetirementImage(postScopes, before.rows);
					let frameBytes = 0;
					for (const value of postScopes)
						frameBytes += journalRetirementCanonicalRow("scopes", scopeKey(fromRawScope(value).scope), value).length;
					for (const value of before.rows) {
						const row = fromRawRow(value);
						frameBytes += journalRetirementCanonicalRow(
							"acceptedEntries",
							[...scopeKey(row.scope), row.journalSequence],
							value
						).length;
					}
					if (frameBytes > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw failureError("retirement-fenced");
					const next = control === null ? null : advanceJournalRetirementMutationControl(control);
					expectedAfter = {
						imageDigest: after.imageDigest,
						controlBytes: next === null ? null : encodeJournalRetirementControl(next),
					};
					attempted = true;
					scopes.put({ ...row, closedMembershipBytes: selected.exactCanonicalMembershipBytes });
					advanceRetirementControl(transaction, control);
				}
			} catch (error) {
				refusal =
					error instanceof Error && "kind" in error
						? (error as Error & { kind: LiveJournalFailureKind }).kind
						: error instanceof Error &&
							  (error.message === "retirement-fenced" || error.message === "retirement-exhausted")
							? error.message
							: "substrate-failure";
				try {
					transaction.abort();
				} catch {
					/* Already terminal; joined readback determines attempted work. */
				}
			}
			await terminal;
			verifiedReplay = new WeakMap();
			if (!attempted && refusal !== undefined) return failed(refusal);
			if (expectedAfter === undefined) return failed("outcome-unknown");
			try {
				const actual = await readRetirementSnapshot(selected.scope.objectId, undefined, true);
				const afterReadback = unavailable();
				if (afterReadback !== undefined) return afterReadback;
				const bytes = actual.control === null ? null : encodeJournalRetirementControl(actual.control);
				if (
					actual.image.imageDigest === expectedAfter.imageDigest &&
					sameNullableBytes(bytes, expectedAfter.controlBytes)
				)
					return { ok: true, value: { idempotent, ...expectedAfter } };
				if (
					actual.image.imageDigest === selected.expectedNativeImage.imageDigest &&
					sameNullableBytes(bytes, selected.expectedNativeImage.controlBytes)
				)
					return failed("substrate-failure");
				return failed("outcome-unknown");
			} catch {
				return failed("outcome-unknown");
			}
		});
	const readRetirementImage: LiveJournalRetirementImageReader = (
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementImageObservation>> =>
		trackRetirement(async () => {
			const blocked = unavailable();
			if (blocked !== undefined) return blocked;
			let objectId: string;
			try {
				objectId = captureJournalRetirementObject(input);
			} catch {
				return failed("malformed-input");
			}
			const afterInput = unavailable();
			if (afterInput !== undefined) return afterInput;
			try {
				const transaction = nativeReadReservationTransaction(database);
				if (heldRetirementImage !== undefined &&
					(heldRetirementImage.transaction !== transaction || heldRetirementImage.objectId !== objectId))
					heldRetirementImage = undefined;
				const basis = heldRetirementImage;
				let captured: Pick<RetirementSnapshot, "control" | "image" | "frames">;
				if (transaction !== undefined && basis !== undefined) {
					captured = {
						control: basis.controlBytes === undefined ? null :
							retirementCodec.decode(basis.controlBytes.slice(), basis.planBytes?.slice()),
						image: Object.freeze({...basis.image}),
						frames: basis.frames.map(bytes => bytes.slice()),
					};
					// Content is immutable under native exclusion, but currency is not
					// cached: enter the original request turn and check this exact book.
					await runNativeReservedRead(database, () => transactionComplete(transaction));
					if (nativeReadReservationTransaction(database) !== transaction)
						throw new Error("NATIVE_READ_RESERVATION_RELEASED");
				} else captured = await readRetirementSnapshot(objectId, undefined, true);
				const afterCapture = unavailable();
				if (afterCapture !== undefined) return afterCapture;
				if (captured.image.scopeCount === 0) return failed("not-installed");
				const drainSource = retirementDrainSource(captured);
				if (basis === undefined && transaction !== undefined) {
					// Do not change an already successful original read's outcome if
					// its reservation was concurrently released after native readback.
					let current: IDBTransaction | undefined;
					try { current = nativeReadReservationTransaction(database); } catch { /* no reusable basis */ }
					if (current === transaction) {
						const carriers = captured.control === null ? undefined : retirementCodec.encode(captured.control);
						const installed = Object.freeze({transaction, objectId,
							...(carriers === undefined ? {} : carriers),
							image: Object.freeze({...captured.image}),
							frames: Object.freeze(captured.frames.map(bytes => bytes.slice())), enrollment: {}});
						heldRetirementImage = installed;
						if (!observedRetirementTransactions.has(transaction)) {
							observedRetirementTransactions.add(transaction);
							transaction.addEventListener("abort", invalidateHeldRetirementImage, {once: true});
							transaction.addEventListener("complete", invalidateHeldRetirementImage, {once: true});
						}
					}
				}
				const observation: LiveJournalRetirementImageObservation = Object.freeze({
					control: captured.control,
					exactCanonicalControlCarriers: Object.freeze(
						captured.control === null
							? []
							: (() => {
									const bytes = retirementCodec.encode(captured.control);
									return [bytes.controlBytes, ...(bytes.planBytes === undefined ? [] : [bytes.planBytes])];
								})()
					),
					image: captured.image,
					canonicalRows: Object.freeze(captured.frames),
					...(drainSource === undefined ? {} : { drainSource }),
				});
				if (transaction !== undefined && heldRetirementImage?.transaction === transaction && heldRetirementImage.objectId === objectId)
					heldRetirementImage.enrollment.observation = new WeakRef(observation);
				return Object.freeze({ok: true, value: observation});
			} catch (error) {
				heldRetirementImage = undefined;
				return failed(
					error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-stale")
						? error.message
						: "substrate-failure"
				);
			}
		});
	// Only weak identities escape through a probe. It cannot prolong a retired
	// frame union or native transaction's lifetime after the original owner joins.
	const createCurrentProbe = (reference: WeakRef<NonNullable<typeof heldRetirementImage>>,
		transactionReference: WeakRef<IDBTransaction>, objectId: string): LiveJournalRetirementImageCurrentProbe => {
		const probe: LiveJournalRetirementImageCurrentProbe = Object.freeze({
			checkCurrent: function (this: LiveJournalRetirementImageCurrentProbe): Promise<LiveJournalRetirementResult<null>> {
				if (this !== probe) return Promise.resolve(failed("malformed-input"));
				return trackRetirement(async () => {
					const blocked = unavailable(); if (blocked !== undefined) return blocked;
					try {
						const transaction = transactionReference.deref();
						if (transaction === undefined || nativeReadReservationTransaction(database) !== transaction)
							return failed("retirement-released");
						// Fresh original native request turn, even on harmless basis
						// eviction. Never reconstruct/copy the complete journal here.
						await runNativeReservedRead(database, () => transactionComplete(transaction));
						const after = unavailable(); if (after !== undefined) return after;
						if (nativeReadReservationTransaction(database) !== transaction) return failed("retirement-released");
						const basis = reference.deref();
						return basis !== undefined && heldRetirementImage === basis && basis.objectId === objectId
							? Object.freeze({ok: true, value: null}) : failed("retirement-stale");
					} catch { return failed("substrate-failure"); }
				});
			},
		});
		return probe;
	};
	Object.defineProperty(readRetirementImage, "captureCurrentProbe", {value: function (this: LiveJournalRetirementImageReader,
		observation: LiveJournalRetirementImageObservation): LiveJournalRetirementImageCurrentProbe | undefined {
		if (this !== readRetirementImage || unavailable() !== undefined) return undefined;
		const basis = heldRetirementImage;
		if (basis === undefined || basis.enrollment.observation?.deref() !== observation) return undefined;
		// Consume the weak enrollment. A later harmless read can enroll another
		// observation, but an admitted probe remains bound to this SAME basis.
		basis.enrollment.observation = undefined;
		try {
			if (nativeReadReservationTransaction(database) !== basis.transaction) return undefined;
			const control = basis.controlBytes === undefined ? null :
				retirementCodec.decode(basis.controlBytes.slice(), basis.planBytes?.slice());
			const carriers = observation.control === null ? undefined : encodeJournalRetirementNativeCarriers(observation.control);
			const expectedCarriers = basis.controlBytes === undefined ? [] : [basis.controlBytes, ...(basis.planBytes === undefined ? [] : [basis.planBytes])];
			if ((carriers === undefined) !== (basis.controlBytes === undefined) || carriers !== undefined &&
				(!sameBytes(carriers.controlBytes, basis.controlBytes!) || !sameNullableBytes(carriers.planBytes ?? null, basis.planBytes ?? null)) ||
				observation.exactCanonicalControlCarriers.length !== expectedCarriers.length ||
				observation.exactCanonicalControlCarriers.some((bytes, index) => !sameBytes(bytes, expectedCarriers[index]!)) ||
				observation.canonicalRows.length !== basis.frames.length || observation.canonicalRows.some((bytes, index) => !sameBytes(bytes, basis.frames[index]!)) ||
				!sameBytes(encodeCanonical(observation.image), encodeCanonical(basis.image))) return undefined;
			const drainSource = retirementDrainSource({control, image: basis.image, frames: basis.frames});
			if ((drainSource === undefined) !== (observation.drainSource === undefined) || drainSource !== undefined &&
				!sameBytes(encodeCanonical(drainSource), encodeCanonical(observation.drainSource))) return undefined;
		} catch { return undefined; } // Mutated/copy/unqualified data cannot mint a current probe.
		return createCurrentProbe(new WeakRef(basis), new WeakRef(basis.transaction), basis.objectId);
	}});
	Object.freeze(readRetirementImage);
	const acquireRetirementControl = (
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>> =>
		trackRetirement(async () => {
			const blocked = unavailable();
			if (blocked !== undefined) return blocked;
			let objectId: string;
			try {
				objectId = captureJournalRetirementObject(input);
			} catch {
				return failed("malformed-input");
			}
			const afterInput = unavailable();
			if (afterInput !== undefined) return afterInput;
			resetSnapshotValidation();
			let captured: RetirementSnapshot;
			try {
				// Control birth/CAS must never borrow a foreign source reservation.
				if (nativeReadReservationTransaction(database) !== undefined) throw new Error("retirement-transition");
				captured = await readRetirementSnapshot(objectId, undefined, true);
				if (captured.image.scopeCount === 0) return failed("not-installed");
				if (captured.control === null) {
					const beforeBirth = unavailable();
					if (beforeBirth !== undefined) return beforeBirth;
					const bytes = new Uint8Array(32);
					crypto.getRandomValues(bytes);
					const born: LiveJournalRetirementControl = {
						kind: "v3-live-journal-retirement-control-1",
						objectId,
						incarnation: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
						revision: 0,
						sequence: 0,
						active: null,
						completed: null,
					};
					let writeError: unknown;
					try {
						await readRetirementSnapshot(objectId, {
							expected: null,
							imageDigest: captured.image.imageDigest,
							next: born,
						});
					} catch (error) {
						writeError = error;
					}
					if (writeError instanceof Error && writeError.message === "retirement-stale")
						return failed("retirement-stale");
					const readback = await readRetirementSnapshot(objectId, undefined, true);
					if (
						readback.control === null ||
						!sameBytes(encodeJournalRetirementControl(readback.control), encodeJournalRetirementControl(born)) ||
						readback.image.imageDigest !== captured.image.imageDigest
					)
						return failed("outcome-unknown");
					captured = readback;
				}
			} catch (error) {
				return failed(
					error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-transition")
						? error.message
						: "substrate-failure"
				);
			}
			const current = captured.control;
			if (current === null) return failed("internal-invariant");
			const afterCapture = unavailable();
			if (afterCapture !== undefined) return afterCapture;
			const expectedCarriers = retirementCodec.encode(current);
			let drainSource: LiveJournalRetirementDrainSource | undefined;
			try {
				drainSource = retirementDrainSource(captured);
			} catch {
				return failed("retirement-stale");
			}
			return {
				ok: true,
				value: retirementCodec.createRead(
					current,
					captured.image,
					(next, deletions, nextCarriers) =>
						trackRetirement(async () => {
							const blocked = unavailable();
							if (blocked !== undefined) return blocked;
							let writeError: unknown;
							try {
								await readRetirementSnapshot(objectId, {
									expected: current,
									expectedCarriers,
									imageDigest: captured.image.imageDigest,
									next,
									nextCarriers,
									...(deletions === undefined ? {} : { deletions }),
								});
							} catch (error) {
								writeError = error;
							}
							if (writeError instanceof Error && writeError.message === "retirement-stale")
								return failed("retirement-stale");
							try {
								const actual = await readRetirementSnapshot(objectId);
								if (actual.control === null) return failed("outcome-unknown");
								const expectedImage =
									deletions === undefined ? captured.image.imageDigest : next.drain?.residualImageDigest;
								if (sameCapturedRetirementNativeCarriers(retirementCodec.encode(actual.control), nextCarriers) && actual.image.imageDigest === expectedImage)
									return { ok: true, value: actual.control };
								if (
									sameRetirementNativeCarriers(actual.control, current) &&
									actual.image.imageDigest === captured.image.imageDigest
								)
									return failed("substrate-failure");
								return failed("outcome-unknown");
							} catch {
								return failed("outcome-unknown");
							}
						}),
					captured.frames,
					drainSource
				),
			};
		});
	// Slice 14a: the original acquisition and transitions inside one room retirement
	// session. Capture, birth and every one-use transition run the same retirementSnapshot
	// body on the session's strict transaction (its in-transaction currency checks are the
	// authority); nothing is read back, because the session commits whole or not at all.
	// Any thrown refusal fails the session, so no partial transition can commit.
	const acquireRetirementControlInSession = (
		session: RoomRetirementSession,
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>> =>
		trackRetirement(async () => {
			const blocked = unavailable();
			if (blocked !== undefined) return blocked;
			let objectId: string;
			try {
				objectId = captureJournalRetirementObject(input);
			} catch {
				return failed("malformed-input");
			}
			resetSnapshotValidation();
			let captured: RetirementSnapshot;
			try {
				// A held view of this owner would block the session's writer.
				if (nativeReadReservationTransaction(database) !== undefined) throw new Error("retirement-transition");
				captured = await session.run(async (transaction) => {
					const snapshot = await readRetirementSnapshot(objectId, undefined, true, transaction);
					if (snapshot.image.scopeCount === 0 || snapshot.control !== null) return snapshot;
					const bytes = new Uint8Array(32);
					crypto.getRandomValues(bytes);
					const born: LiveJournalRetirementControl = {
						kind: "v3-live-journal-retirement-control-1",
						objectId,
						incarnation: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
						revision: 0,
						sequence: 0,
						active: null,
						completed: null,
					};
					await readRetirementSnapshot(
						objectId,
						{ expected: null, imageDigest: snapshot.image.imageDigest, next: born },
						false,
						transaction
					);
					return { ...snapshot, control: born };
				});
				if (captured.image.scopeCount === 0) return failed("not-installed");
			} catch (error) {
				return failed(
					error instanceof Error &&
						(error.message === "retirement-fenced" ||
							error.message === "retirement-transition" ||
							error.message === "retirement-stale")
						? error.message
						: "substrate-failure"
				);
			}
			const current = captured.control;
			if (current === null) return failed("internal-invariant");
			const afterCapture = unavailable();
			if (afterCapture !== undefined) return afterCapture;
			const expectedCarriers = retirementCodec.encode(current);
			let drainSource: LiveJournalRetirementDrainSource | undefined;
			try {
				drainSource = retirementDrainSource(captured);
			} catch {
				return failed("retirement-stale");
			}
			return {
				ok: true,
				value: retirementCodec.createRead(
					current,
					captured.image,
					(next, deletions, nextCarriers) =>
						trackRetirement(async () => {
							const blocked = unavailable();
							if (blocked !== undefined) return blocked;
							try {
								await session.run((transaction) =>
									readRetirementSnapshot(
										objectId,
										{
											expected: current,
											expectedCarriers,
											imageDigest: captured.image.imageDigest,
											next,
											nextCarriers,
											...(deletions === undefined ? {} : { deletions }),
										},
										false,
										transaction
									)
								);
							} catch (error) {
								return failed(
									error instanceof Error &&
										(error.message === "retirement-stale" || error.message === "retirement-transition")
										? error.message
										: "substrate-failure"
								);
							}
							return { ok: true, value: next };
						}),
					captured.frames,
					drainSource
				),
			};
		});
	const close = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		retirementCodec.clear();
		snapshotValidation.release();
		verifiedReplay = new WeakMap();
		heldRetirementImage = undefined;
		const reservationsJoined = readReservations.close();
		closePromise = Promise.all([reservationsJoined, Promise.allSettled([...retirementOperations])])
			.then(() => undefined)
			.finally(() => {
				retirementCodec.release();
				database.close();
			});
		return closePromise;
	};

	const facade = Object.freeze({
		recordClosedMembership,
		readRetirementImage,
		acquireRetirementControl,
		acquireNativeReadReservation: async (input: { readonly objectId: string }) => {
			const blocked = unavailable();
			if (blocked !== undefined) return Promise.reject(new Error(blocked.kind));
			const objectId = captureNativeReadReservationInput(input);
			if (objectId.length > 1024) return Promise.reject(new TypeError("malformed-input"));
			const held = await readReservations.acquire({ objectId });
			heldRetirementImage = undefined;
			verifiedReplay = new WeakMap();
			const transaction = nativeReadReservationTransaction(database);
			return Object.freeze({check: () => held.check(), release: () => {
				// Revoke reuse synchronously, before the native owner joins work.
				if (heldRetirementImage?.transaction === transaction) heldRetirementImage = undefined;
				if (transaction !== undefined) verifiedReplay.delete(transaction);
				return held.release();
			}});
		},
		appendAccepted,
		close,
		installEpochAnchor,
		installGenesis,
		importHistoricalAnchor,
		readAnchorPreimage,
		readSignedAnchorEnvelope,
		readiness,
		readPage,
	});
	if (roomDatabaseName !== undefined)
		roomJournalRetirement.set(facade, { databaseName: roomDatabaseName, acquire: acquireRetirementControlInSession });
	return facade;
}

// Genuine room-mode journal facades, with their room database and session acquisition.
const roomJournalRetirement = new WeakMap<
	object,
	Readonly<{
		databaseName: string;
		acquire(
			session: RoomRetirementSession,
			input: Readonly<{ objectId: string }>
		): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>>;
	}>
>();

/**
 * Slice 14a: the journal retirement acquisition inside a room retirement session. Only
 * the exact genuine room-mode journal of the session's own database is accepted.
 * @param store - Candidate journal facade.
 * @param databaseName - The session's room database.
 * @param session - The open room retirement session.
 * @param input - The exact object address.
 * @returns The original retirement result, its transitions bound to the session.
 */
export function acquireBrowserRoomJournalRetirement(
	store: unknown,
	databaseName: string,
	session: RoomRetirementSession,
	input: Readonly<{ objectId: string }>
): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>> {
	const entry = typeof store === "object" && store !== null ? roomJournalRetirement.get(store) : undefined;
	if (entry === undefined || entry.databaseName !== databaseName) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return entry.acquire(session, input);
}

function sameJournalScope(left: LiveJournalScope, right: LiveJournalScope): boolean {
	return left.objectId === right.objectId && left.epoch === right.epoch && left.anchorDigest === right.anchorDigest;
}

function journalRetentionCorrupt(detail: string): never {
	throw new RoomRetentionRefusal("RETENTION_CORRUPT", `journal:${detail}`);
}

/**
 * Slices 14a/14b step B: the journal owner's retention section. Inside the acting room
 * transaction it re-reads the control and every header of the object, the complete row
 * range of each collectible prefix (bounded by its high watermark plus one) and each
 * retired header, and names every row by the digest of its exact bytes. A prefix row
 * retires only when its exact frame hashes to the verified native frame digest the
 * planner carried; a header only when it is empty, outside the genesis anchor, and
 * already fenced by the current control. The target control is the original prepare and
 * commit of the same preparation the per-owner install composes (journal rows before
 * their header: a prefix header stays, its membership carrier stripped exactly as the
 * existing completed-drain acknowledgement strips it).
 */
const journalRetentionSection: RoomRetentionSection = Object.freeze<RoomRetentionSection>({
	owner: "journal" as const,
	prepare: ({ session, selection, book }) =>
		session.run(async (transaction) => {
			const objectId = selection.objectId,
				through = selection.throughEpoch,
				chosen = selection.journal;
			const store = (logical: string): IDBObjectStore =>
				transaction.objectStore(roomStoreName(transaction.db, "journal", logical));
			const rawControl: unknown = await requestResult(store("retirementControls").get(objectId));
			if (rawControl === undefined) retentionStale("journal:control-absent");
			chargeRetentionRow(book, "journal", "retirementControls", objectId, rawControl);
			let control: LiveJournalRetirementControl;
			try {
				const decoded = retirementControl(rawControl, objectId);
				if (decoded === null) return journalRetentionCorrupt("control");
				control = decoded;
			} catch {
				return journalRetentionCorrupt("control");
			}
			if (control.active !== null) retentionStale("journal:active");
			const drain = control.drain ?? null;
			if (drain !== null && drain.cursor !== journalRetirementDrainItemCount(drain.plan))
				retentionStale("journal:drain");
			// Every ordinary journal mutation advances the revision and clears a completed
			// drain (LJ advanceJournalRetirementMutationControl); the base is the rest.
			const { revision: _revision, drain: _drain, ...state } = control as LiveJournalRetirementControl & {
				drain?: unknown;
			};
			const base = retentionValueDigest("retirementControls", objectId, state);
			const range = IDBKeyRange.bound([objectId], [objectId, []]);
			const scopeCount = await requestResult(store("scopes").count(range));
			if (!journalRetirementImageCountsFit(scopeCount, 0))
				throw new RoomRetentionRefusal("RETENTION_CAPACITY", "journal:scopes");
			const headerRows: unknown[] = await requestResult(store("scopes").getAll(range, scopeCount + 1));
			if (headerRows.length !== scopeCount) retentionStale("journal:scope-census");
			const headers = headerRows.map((raw) => {
				let stored: StoredScope;
				try {
					stored = fromRawScope(raw);
				} catch {
					return journalRetentionCorrupt("header");
				}
				if (stored.scope.objectId !== objectId) journalRetentionCorrupt("header-object");
				const key = scopeKey(stored.scope);
				return Object.freeze({
					raw: raw as Readonly<Record<string, unknown>>,
					scope: stored.scope,
					key,
					next: stored.nextJournalSequence,
					digest: chargeRetentionRow(book, "journal", "scopes", key, raw),
				});
			});
			// Survivors (14b): every closed header is exactly the verified one, a header this
			// boundary's prefixes rewrite, or a header this decision deletes; nothing else.
			const frameOf = (header: (typeof headers)[number]): string =>
				journalRetirementFrameDigest(journalRetirementCanonicalRow("scopes", header.key, header.raw));
			const expected = new Map(
				selection.survivors.journalHeaders.map((row) => [JSON.stringify(scopeKey(row.scope)), row.nativeFrameDigest])
			);
			const rewritten = new Set(selection.survivors.journalRewritten.map((scope) => JSON.stringify(scopeKey(scope))));
			const retiring = new Set(chosen.headers.map((row) => JSON.stringify(scopeKey(row.scope))));
			for (const header of headers) {
				if (header.scope.epoch > through) continue;
				const id = JSON.stringify(header.key);
				const digest = expected.get(id);
				if (digest !== undefined ? frameOf(header) !== digest : !rewritten.has(id) && !retiring.has(id))
					retentionStale("journal:survivor");
			}
			for (const id of expected.keys())
				if (!headers.some((header) => JSON.stringify(header.key) === id)) retentionStale("journal:survivor-missing");
			const deletes: RoomRetentionDraftDelete[] = [],
				rewrites: RoomRetentionDraftRewrite[] = [];
			const named = new Set<string>(),
				deletedHeaders = new Set<string>(),
				stripped = new Set<string>();
			const strip = (header: (typeof headers)[number]): void => {
				const id = JSON.stringify(header.key);
				if (deletedHeaders.has(id) || stripped.has(id) || !Object.hasOwn(header.raw, "closedMembershipBytes")) return;
				stripped.add(id);
				const value: Record<string, unknown> = { ...header.raw };
				delete value.closedMembershipBytes;
				rewrites.push(
					Object.freeze({
						store: "scopes",
						key: header.key,
						before: header.digest,
						after: retentionValueDigest("scopes", header.key, value),
						value: Object.freeze(value),
					})
				);
			};
			for (const retired of chosen.headers) {
				const scope = retired.scope,
					id = JSON.stringify(scopeKey(scope));
				if (
					scope.objectId !== objectId ||
					scope.epoch === 0 ||
					scope.anchorDigest === chosen.genesisAnchorDigest ||
					scope.epoch > through ||
					named.has(id)
				)
					retentionStale("journal:header-scope");
				named.add(id);
				const found = headers.filter((header) => sameJournalScope(header.scope, scope));
				const header = found[0];
				if (found.length !== 1 || header === undefined) retentionStale("journal:header-missing");
				if (journalRetirementFrameDigest(journalRetirementCanonicalRow("scopes", header.key, header.raw)) !== retired.nativeFrameDigest)
					retentionStale("journal:header-changed");
				if ((await requestResult(store("acceptedEntries").count(IDBKeyRange.bound(header.key, [...header.key, []])))) !== 0)
					retentionStale("journal:header-rows");
				// Only a header the current control already fences: its rows retired earlier.
				if (journalRetirementAllows(control, scope)) retentionStale("journal:header-unfenced");
				deletedHeaders.add(id);
				deletes.push(Object.freeze({ store: "scopes", key: header.key, digest: header.digest }));
			}
			for (const prefix of chosen.prefixes) {
				const scope = prefix.scope,
					id = JSON.stringify(scopeKey(scope));
				if (scope.objectId !== objectId || scope.epoch > through || named.has(id)) retentionStale("journal:prefix-scope");
				named.add(id);
				const found = headers.filter((header) => sameJournalScope(header.scope, scope));
				const header = found[0];
				if (
					found.length !== 1 ||
					header === undefined ||
					header.next !== prefix.highWatermark ||
					prefix.highWatermark === 0 ||
					prefix.rows.length !== prefix.highWatermark
				)
					retentionStale("journal:prefix-header");
				// The header the decision rewrites is exactly the verified one.
				if (frameOf(header) !== prefix.headerFrameDigest) retentionStale("journal:prefix-header-changed");
				// The complete row range, one past the named count: an unnamed row refuses.
				const rows: unknown[] = await requestResult(
					store("acceptedEntries").getAll(IDBKeyRange.bound(header.key, [...header.key, []]), prefix.highWatermark + 1)
				);
				if (rows.length !== prefix.highWatermark) retentionStale("journal:prefix-census");
				for (const [index, raw] of rows.entries()) {
					const selected = prefix.rows[index];
					let row: StoredRow;
					try {
						row = fromRawRow(raw);
					} catch {
						return journalRetentionCorrupt("row");
					}
					if (selected === undefined || row.journalSequence !== selected.journalSequence || !sameJournalScope(row.scope, scope))
						retentionStale("journal:prefix-row-key");
					const key = [...header.key, row.journalSequence];
					// The exact stored bytes must be the bytes whose membership was verified.
					if (journalRetirementFrameDigest(journalRetirementCanonicalRow("acceptedEntries", key, raw)) !== selected.nativeFrameDigest)
						retentionStale("journal:prefix-row-changed");
					deletes.push(
						Object.freeze({
							store: "acceptedEntries",
							key,
							digest: chargeRetentionRow(book, "journal", "acceptedEntries", key, raw),
						})
					);
				}
				strip(header);
			}
			// A completed original drain's prefix headers keep their carrier until the next
			// ordinary mutation strips it (LJ advanceRetirementControl). This write is such a
			// mutation, so it performs that acknowledgement too; it is not part of the
			// decision (an ordinary append between planning and acting performs it instead).
			const acknowledged = (drain?.plan.prefixes ?? []).flatMap((prefix) =>
				headers.filter(
					(header) =>
						sameJournalScope(header.scope, prefix.scope) &&
						!deletedHeaders.has(JSON.stringify(header.key)) &&
						!stripped.has(JSON.stringify(header.key)) &&
						Object.hasOwn(header.raw, "closedMembershipBytes")
				)
			);
			const prior = control.completed;
			const protectedScopes = headers
				.map((header) => header.scope)
				.filter(
					(scope) =>
						scope.epoch <= through &&
						!chosen.prefixes.some((prefix) => sameJournalScope(prefix.scope, scope)) &&
						(prior === null ||
							scope.epoch > prior.throughEpoch ||
							prior.protectedScopes.some((hole) => sameJournalScope(hole, scope)))
				)
				.map((scope) => Object.freeze({ objectId: scope.objectId, epoch: scope.epoch, anchorDigest: scope.anchorDigest }));
			if (protectedScopes.length > LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes)
				throw new RoomRetentionRefusal("RETENTION_CAPACITY", "journal:protected-scopes");
			return Object.freeze<RoomRetentionSectionDraft>({
				owner: "journal" as const,
				base,
				control: roomRetentionControlDigest(encodeJournalRetirementControl(control)),
				through,
				deletes: Object.freeze(deletes),
				rewrites: Object.freeze(rewrites),
				compose: async (labels: Readonly<{ throughEpoch: number; decisionDigest: string; sourceProofDigest: string }>) => {
					const preparation = {
						decisionDigest: labels.decisionDigest,
						sourceProofDigest: labels.sourceProofDigest,
						throughEpoch: through,
						protectedScopes,
					};
					let committed: LiveJournalRetirementControl;
					try {
						// The original prepare (monotone frontier, revision and sequence) then commit.
						const idle = control.kind === "v3-live-journal-retirement-control-2" ? { ...control, drain: null } : control;
						const prepared = captureJournalRetirementControl({
							...idle,
							revision: control.revision + 1,
							sequence: control.sequence + 1,
							active: { sequence: control.sequence + 1, preparation },
						});
						committed = captureJournalRetirementControl({
							...prepared,
							revision: control.revision + 2,
							active: null,
							completed: prepared.active!.preparation,
						});
					} catch {
						return retentionStale("journal:transition");
					}
					const value = nativeRetirementRecord(committed);
					return Object.freeze({
						value,
						digest: retentionValueDigest("retirementControls", objectId, value),
						control: roomRetentionControlDigest(encodeJournalRetirementControl(committed)),
					});
				},
				write: (target, writeBook) =>
					session.run(async (writer) => {
						const writeStore = (logical: string): IDBObjectStore =>
							writer.objectStore(roomStoreName(writer.db, "journal", logical));
						for (const row of deletes) {
							writeBook.write({ kind: "delete", owner: "journal", store: row.store });
							await requestResult(writeStore(row.store).delete(row.key as IDBValidKey));
						}
						for (const row of rewrites) {
							writeBook.write({ kind: "rewrite", owner: "journal", store: row.store });
							await requestResult(writeStore(row.store).put(row.value));
						}
						for (const header of acknowledged) {
							const value: Record<string, unknown> = { ...header.raw };
							delete value.closedMembershipBytes;
							writeBook.write({ kind: "rewrite", owner: "journal", store: "scopes" });
							await requestResult(writeStore("scopes").put(value));
						}
						writeBook.write({ kind: "control", owner: "journal" });
						await requestResult(writeStore("retirementControls").put(target.value));
					}),
			});
		}),
});

/**
 * Slice 14b: the journal retention section of a genuine room-mode journal of the given
 * room database.
 * @param store - Candidate journal facade.
 * @param databaseName - The session's room database.
 * @returns The section.
 */
export function browserRoomJournalRetentionSection(store: unknown, databaseName: string): RoomRetentionSection {
	const entry = typeof store === "object" && store !== null ? roomJournalRetirement.get(store) : undefined;
	if (entry === undefined || entry.databaseName !== databaseName) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return journalRetentionSection;
}
