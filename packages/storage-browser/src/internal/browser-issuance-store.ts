import { encodeCanonical } from "@ts-drp/canonical";
import {
	applySettlementPlanEffect,
	assertDurableIssueScope,
	assertSettlementPlanProgressTransition,
	captureSettlementPlanWriteInput,
	classifyDurableIssuanceTerminalSuppression,
	cloneDurableIssueCommit,
	cloneSettlementPlan,
	compareDurableIssuanceCompoundKeys,
	copyAndValidateDurableIssueCommit,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	copySettlementPlan,
	createDurableIssuanceFailure,
	DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT,
	type DurableBuildAndSign,
	DurableIssuanceContractError,
	DurableIssuanceInvalidArgumentError,
	type DurableIssuanceNativeOutboxRecord,
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	DurableIssuanceUnknownOutcomeError,
	type DurableIssueCommit,
	type DurableIssuedRecord,
	type DurableIssueScope,
	type DurableLineage,
	type DurableOutboxPageInput,
	type DurableOutboxPublicationTransitionInput,
	durablePreimageMatchesScopeAndSequence,
	type DurableUnsignedVertexSignAdmission,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
	isValidDurableScopeField,
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
	type SettlementPlan,
	type SettlementPlanEntry,
	settlementPlanHasExactEffectLink,
	settlementReplacementLastLogicalTime,
} from "@ts-drp/issuance-store";
import {
	advanceIssuanceRetirementControl,
	assertIssuanceInheritedTargetPruningAllowed,
	assertIssuanceRetirementPlanAllowed,
	assertIssuanceRetirementPreparationRows,
	assertIssuanceRetirementPruningAllowed,
	bindDurableIssuancePruningMaintenance,
	captureDurableIssuancePruningInput,
	captureDurableIssuanceRecoveryCensusInput,
	captureIssuanceNativeSignContext,
	issuanceSettlementReplacementReserveCharge,
	captureIssuanceNativeSignInput,
	captureIssuancePendingUnsignedIntent,
	captureIssuanceRetirementObject,
	captureIssuanceRetirementPreparation,
	createDurableIssuancePruningReceipt,
	createDurableIssuancePruningState,
	createDurableIssuanceRecordPrunedError,
	createIssuanceRetirementControlRead,
	decodeDurableIssuancePreimage,
	decodeIssuanceRetirementControl,
	durableIssuanceAddressIsPruned,
	durableIssuanceLineageConsumed,
	durableIssuanceLineagesEqual,
	type DurableIssuancePendingUnsignedIntent,
	type DurableIssuancePruningReceipt,
	type DurableIssuancePruningState,
	DurableIssuanceRecordPrunedError,
	type DurableIssuanceRecoveryCensus,
	type DurableIssuanceRecoveryCensusInput,
	type DurableIssuanceRecoveryCensusReader,
	type DurableIssuanceRecoveryCensusCurrentProbe,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementControlRead,
	type DurableIssuanceRetirementPreparation,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementAllows,
	issuanceRetirementBytesEqual,
	issuanceRetirementCommitRows,
	issuanceRetirementHex,
	issuanceRetirementImage,
	issuanceRetirementRefusal,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementFloor,
	issuanceRetirementTransitionRows,
	issuanceRetirementTransitionPlanBefore,
	type IssuanceRetirementRows,
	issuanceUnsignedPostimageCharge,
	joinIssuanceNativeSign,
	assertSettlementExpiryPublicationExclusive,
	settlementEntryIsAuthenticatedExpiry,
	settlementPlanPermitsAuthenticatedPruning,
} from "@ts-drp/issuance-store/maintenance";
import {
	roomRetentionControlDigest,
	type RoomRetentionLabels,
	type RoomRetentionProofBook,
	RoomRetentionRefusal,
} from "@ts-drp/storage/room-head";

import {
	captureNativeReadReservationInput,
	isNativeReadReservationTransaction,
	nativeReadonlyTransaction,
	nativeReadReservationTransaction,
	nativeReadReservationCheck,
	NativeReadReservationOwner,
	type NativeReadReservationPort,
	needsNativeReadReservationTurn,
	type RoomRetirementSession,
	runNativeReservedRead,
	visitCountedRange,
} from "./native-read-reservation.js";
import {
	chargeRetentionRow,
	type RoomRetentionSection,
	type RoomRetentionSectionDraft,
	type RoomRetentionTarget,
	retentionStale,
	retentionValueDigest,
} from "./room-retention.js";
import { openBrowserRoomOwnerConnection, roomStoreName, roomStoreNames } from "./schema-idb.js";

const DATABASE_SUFFIX = "--drp-issuance-v1";
const DATABASE_VERSION = 3;
const STORE_NAMES = ["lineages", "issuedRecords", "issuanceOutbox", "settlementPlans", "retirementControls"] as const;
const LINEAGE_KEY_PATH = ["objectId", "author"] as const;
const RECORD_KEY_PATH = ["objectId", "author", "authorSequence"] as const;

interface NativeIssuedRecord extends DurableIssueScope {
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface NativeOutboxRecord extends DurableIssueScope {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: "pending" | "published";
}

type ParsedOutboxPage = Readonly<{
	afterKey: readonly [string, string, number] | null;
	limit: number;
	scope?: DurableIssueScope;
}>;

type NativeIssueCurrency = {
	readonly imageDigest: string;
	readonly controlBytes: Uint8Array;
};
type NativeIssueReservation = {
	readonly pending: DurableIssuancePendingUnsignedIntent;
	readonly currency?: NativeIssueCurrency;
};
type NativeIssueJob = {
	readonly transaction: IDBTransaction;
	readonly terminal: Promise<void>;
	readonly readback: Promise<readonly unknown[]>;
	readonly pending: DurableIssuancePendingUnsignedIntent;
	readonly currency?: NativeIssueCurrency;
	readonly turn: ReturnType<typeof issuanceWriteTurn>;
};

// The original strict writer stays alive through the admitted callback and its
// builder. Requests resume only in its own native event turn, never an RO upgrade.
function issuanceWriteTurn(transaction: IDBTransaction): {
	run<T>(operation: () => Promise<T>): Promise<T>;
	stop(): void;
} {
	let running = true;
	const queued: Array<{ start(): void; reject(cause: unknown): void }> = [];
	const reject = (cause: unknown): void => {
		running = false;
		for (const job of queued.splice(0)) job.reject(cause);
	};
	transaction.addEventListener(
		"abort",
		() => reject(transaction.error ?? new DOMException("issuance job aborted", "AbortError")),
		{ once: true }
	);
	transaction.addEventListener("complete", () => reject(new Error("issuance job joined")), { once: true });
	const pump = (): void => {
		if (!running) return;
		try {
			const request = transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).getKey("");
			request.addEventListener(
				"success",
				() => {
					pump();
					for (const job of queued.splice(0)) job.start();
				},
				{ once: true }
			);
			request.addEventListener("error", () => reject(request.error), { once: true });
		} catch (cause) {
			reject(cause);
		}
	};
	pump();
	return {
		run<T>(operation: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve, rejectJob) => {
				if (!running) {
					rejectJob(new Error("issuance job is no longer admitted"));
					return;
				}
				queued.push({
					reject: rejectJob,
					start: () => {
						try {
							void operation().then(resolve, rejectJob);
						} catch (cause) {
							rejectJob(cause);
						}
					},
				});
			});
		},
		stop(): void {
			running = false;
		},
	};
}

interface NativeSettlementPlan extends DurableIssueScope {
	readonly sourceContexts?: SettlementPlan["sourceContexts"];
	readonly handBacks?: SettlementPlan["handBacks"];
	readonly entries: readonly (SettlementPlanEntry & {
		readonly replacementProgress?: SettlementPlanEntry["replacementProgress"];
	})[];
	readonly fenceSequence: number | null;
	readonly revision: number;
}

interface TerminalReadback {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: DurableIssuanceNativeOutboxRecord | null;
	readonly prunedThroughAuthorSequence: number | null;
}

function invalid(message: string): DurableIssuanceInvalidArgumentError {
	return new DurableIssuanceInvalidArgumentError(message);
}

function substrate(
	message: string,
	retryClass: "transient" | "resource-exhausted" | "permanent"
): DurableIssuanceContractError {
	return createDurableIssuanceFailure("ISSUANCE_SUBSTRATE_FAILURE", message, retryClass);
}

function errorName(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "name") === "string"
		? (Reflect.get(error, "name") as string)
		: undefined;
}

function mapOpenError(error: unknown): Error {
	const name = errorName(error);
	if (name === "VersionError" || name === "AbortError") {
		return createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database schema is unsupported");
	}
	if (name === "QuotaExceededError") return substrate("issuance database quota is exhausted", "resource-exhausted");
	return substrate("issuance database could not be opened", "transient");
}

function mapSubstrateError(error: unknown, message: string): Error {
	if (errorName(error) === "QuotaExceededError") return substrate(message, "resource-exhausted");
	return substrate(message, "transient");
}

function sameKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((part, index) => part === expected[index])
	);
}

function verifyStore(store: IDBObjectStore, keyPath: readonly string[]): void {
	if (store.autoIncrement || !sameKeyPath(store.keyPath, keyPath) || store.indexNames.length !== 0) {
		throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", `unsupported ${store.name} schema`);
	}
}

function exactStoreNames(database: IDBDatabase): boolean {
	const actual = [...database.objectStoreNames].sort();
	const expected = [...STORE_NAMES].sort();
	return actual.length === expected.length && expected.every((name, index) => actual[index] === name);
}

function captureOptions(value: unknown): string {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw invalid("options must be a plain record");
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw invalid("options must be a plain record");
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== "primaryDatabaseName")
			throw invalid("options must contain only primaryDatabaseName");
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryDatabaseName");
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
			throw invalid("primaryDatabaseName must be an enumerable data property");
		}
		if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
			throw invalid("primaryDatabaseName must be a non-empty primitive string");
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw invalid("options could not be inspected as a closed record");
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
	const held = nativeReadReservationCheck(transaction);
	if (held !== undefined) return held;
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
			{
				once: true,
			}
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new DOMException("transaction failed", "AbortError")),
			{
				once: true,
			}
		);
	});
}

function strictTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
	let transaction: IDBTransaction;
	try {
		transaction = database.transaction(roomStoreNames(database, "issuance", STORE_NAMES), mode, { durability: "strict" });
	} catch (error) {
		throw mapSubstrateError(error, "strict issuance transaction is unavailable");
	}
	if (mode === "readwrite" && transaction.durability !== "strict") {
		try {
			transaction.abort();
		} catch {
			// The transaction may already have become inactive.
		}
		throw createDurableIssuanceFailure("ISSUANCE_DURABILITY_UNAVAILABLE", "IndexedDB did not retain strict durability");
	}
	return transaction;
}

function copyNativeLineage(
	value: unknown,
	scope: DurableIssueScope
):
	| (DurableLineage & {
			readonly prunedThroughAuthorSequence: number | null;
			readonly pendingUnsigned?: DurableIssuancePendingUnsignedIntent;
	  })
	| undefined {
	const record = typeof value === "object" && value !== null ? value : undefined;
	const current = record !== undefined && Object.hasOwn(record, "prunedThroughAuthorSequence");
	const pending = record !== undefined && Object.hasOwn(record, "pendingUnsigned");
	const exact = isClosedDurableIssuanceRecord(value, [
		"author",
		"exhausted",
		"next",
		"objectId",
		...(current ? ["prunedThroughAuthorSequence"] : []),
		...(pending ? ["pendingUnsigned"] : []),
	]);
	if (
		!exact ||
		value.author !== scope.author ||
		value.objectId !== scope.objectId ||
		typeof value.exhausted !== "boolean" ||
		!isValidDurableAuthorSequence(value.next) ||
		(value.exhausted && value.next !== Number.MAX_SAFE_INTEGER)
	) {
		return undefined;
	}
	const watermark = current ? value.prunedThroughAuthorSequence : null;
	if (
		watermark !== null &&
		(!isValidDurableAuthorSequence(watermark) ||
			!durableIssuanceLineageConsumed({ exhausted: value.exhausted, next: value.next }, watermark))
	) {
		return undefined;
	}
	let pendingUnsigned: DurableIssuancePendingUnsignedIntent | undefined;
	if (pending) {
		try {
			pendingUnsigned = captureIssuancePendingUnsignedIntent(value.pendingUnsigned, scope);
		} catch {
			return undefined;
		}
		if (value.exhausted || pendingUnsigned.authorSequence !== value.next) return undefined;
	}
	return {
		exhausted: value.exhausted,
		next: value.next,
		prunedThroughAuthorSequence: watermark,
		...(pendingUnsigned === undefined ? {} : { pendingUnsigned }),
	};
}

function copyNativeIssued(value: unknown): NativeIssuedRecord | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, [
			"author",
			"authorSequence",
			"canonicalPreimageBytes",
			"digest",
			"objectId",
			"signature",
		]) ||
		!isValidDurableScopeField(value.author) ||
		!isValidDurableScopeField(value.objectId) ||
		!isValidDurableAuthorSequence(value.authorSequence)
	) {
		return undefined;
	}
	const canonicalPreimageBytes = copyDurableIssuanceBytes(value.canonicalPreimageBytes);
	const digest = copyDurableIssuanceBytes(value.digest);
	const signature = copyDurableIssuanceBytes(value.signature);
	if (canonicalPreimageBytes === undefined || digest === undefined || signature === undefined) return undefined;
	return {
		author: value.author,
		authorSequence: value.authorSequence,
		canonicalPreimageBytes,
		digest,
		objectId: value.objectId,
		signature,
	};
}

function copyNativeOutbox(value: unknown): NativeOutboxRecord | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["author", "authorSequence", "digest", "objectId", "publishState"]) ||
		!isValidDurableScopeField(value.author) ||
		!isValidDurableScopeField(value.objectId) ||
		!isValidDurableAuthorSequence(value.authorSequence) ||
		(value.publishState !== "pending" && value.publishState !== "published")
	) {
		return undefined;
	}
	const digest = copyDurableIssuanceBytes(value.digest);
	if (digest === undefined) return undefined;
	return {
		author: value.author,
		authorSequence: value.authorSequence,
		digest,
		objectId: value.objectId,
		publishState: value.publishState,
	};
}

function copyNativeSettlementPlan(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	const hasContexts = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceContexts");
	const hasHandBacks = typeof value === "object" && value !== null && Object.hasOwn(value, "handBacks");
	if (
		!isClosedDurableIssuanceRecord(value, ["author", "entries", "fenceSequence", "objectId", "revision",
			...(hasContexts ? ["sourceContexts"] : []), ...(hasHandBacks ? ["handBacks"] : [])]) ||
		value.author !== scope.author ||
		value.objectId !== scope.objectId
	) {
		return undefined;
	}
	return copySettlementPlan(
		{
			entries: value.entries,
			...(hasContexts ? {sourceContexts: value.sourceContexts} : {}),
			...(hasHandBacks ? {handBacks: value.handBacks} : {}),
			fenceSequence: value.fenceSequence,
			revision: value.revision,
			scope,
		},
		scope
	);
}

function nativeSettlementPlan(plan: SettlementPlan): NativeSettlementPlan {
	const detached = cloneSettlementPlan(plan);
	return {
		...copyDurableIssueScope(detached.scope),
		entries: detached.entries,
		...(detached.sourceContexts === undefined ? {} : {sourceContexts: detached.sourceContexts}),
		...(detached.handBacks === undefined ? {} : {handBacks: detached.handBacks}),
		fenceSequence: detached.fenceSequence,
		revision: detached.revision,
	};
}

function commitFromIssued(row: NativeIssuedRecord): DurableIssueCommit {
	const scope = { author: row.author, objectId: row.objectId };
	const envelope = {
		canonicalPreimageBytes: row.canonicalPreimageBytes,
		digest: row.digest,
		signature: row.signature,
	};
	// The shared clone detaches all three envelope graphs in one synchronous call.
	return cloneDurableIssueCommit({
		authorSequence: row.authorSequence,
		envelope,
		issuedRecord: { authorSequence: row.authorSequence, envelope, scope },
		outboxEntry: { authorSequence: row.authorSequence, envelope, scope },
	});
}

function nativeIssued(candidate: DurableIssueCommit): NativeIssuedRecord {
	return {
		...copyDurableIssueScope(candidate.issuedRecord.scope),
		authorSequence: candidate.authorSequence,
		canonicalPreimageBytes: new Uint8Array(candidate.envelope.canonicalPreimageBytes),
		digest: new Uint8Array(candidate.envelope.digest),
		signature: new Uint8Array(candidate.envelope.signature),
	};
}

function nativeOutbox(candidate: DurableIssueCommit): NativeOutboxRecord {
	return {
		...copyDurableIssueScope(candidate.outboxEntry.scope),
		authorSequence: candidate.authorSequence,
		digest: new Uint8Array(candidate.envelope.digest),
		publishState: "pending",
	};
}

async function browserRetirementControl(
	transaction: IDBTransaction,
	objectId: string
): Promise<DurableIssuanceRetirementControl | null> {
	const raw: unknown = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls")).get(objectId));
	if (raw === undefined) return null;
	if (!isClosedDurableIssuanceRecord(raw, ["objectId", "record"]) || raw.objectId !== objectId)
		throw issuanceRetirementRefusal("issuance retirement control unclassified");
	return decodeIssuanceRetirementControl(raw.record);
}
async function browserRetirementRows(
	transaction: IDBTransaction,
	objectId: string,
	limits: Readonly<{ maxRows: number; maxBytes: number }> = ISSUANCE_RETIREMENT_LIMITS,
	seed?: { keysMatch: boolean; encodedRowBytes: number }
): Promise<IssuanceRetirementRows> {
	const names = ["lineages", "issuedRecords", "issuanceOutbox", "settlementPlans"] as const;
	const range = IDBKeyRange.bound([objectId], [objectId, []]);
	const counts = await Promise.all(names.map((name) => requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", name)).count(range))));
	const count = counts.reduce((total, rows) => total + rows, 0);
	if (count > limits.maxRows) throw issuanceRetirementRefusal("issuance retirement native census exceeds bound");
	let bytes = 0;
	// The counts bound every range. Visit each counted range in bounded pages in
	// this SAME transaction; rows are classified and charged in the original
	// store and key order before the next page is read.
	const collect = async <T>(name: (typeof names)[number], parse: (raw: unknown) => T | undefined): Promise<T[]> => {
		const output: T[] = [];
		await visitCountedRange(transaction.objectStore(roomStoreName(transaction.db, "issuance", name)), range, counts[names.indexOf(name)]! + 1, (value, key) => {
			const row = parse(value);
			if (!row) throw issuanceRetirementRefusal("issuance retirement native row unclassified");
			if (seed !== undefined) {
				const address = name === "settlementPlans" ? Reflect.get(row as object, "scope") : row;
				const expected = typeof address === "object" && address !== null ?
					[Reflect.get(address, "objectId"), Reflect.get(address, "author"),
						...(name === "issuedRecords" || name === "issuanceOutbox" ? [Reflect.get(address, "authorSequence")] : [])] : [];
				if (!Array.isArray(key) || key.length !== expected.length || !key.every((part, index) => part === expected[index]))
					seed.keysMatch = false;
			}
			bytes += encodeCanonical(row, {
				maxBytes: limits.maxBytes,
				maxDepth: 16,
				maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32,
			}).length;
			if (bytes > limits.maxBytes)
				throw issuanceRetirementRefusal("issuance retirement native image exceeds bound");
			if (seed !== undefined) seed.encodedRowBytes = bytes;
			output.push(row);
		});
		return output;
	};
	return {
		lineages: await collect("lineages", (raw) => {
			if (typeof raw !== "object" || raw === null) return undefined;
			const scope = { objectId, author: Reflect.get(raw, "author") as string };
			if (!isValidDurableScopeField(scope.author)) return undefined;
			const l = copyNativeLineage(raw, scope);
			return l && { ...scope, ...l };
		}),
		issued: await collect("issuedRecords", copyNativeIssued),
		outbox: await collect("issuanceOutbox", copyNativeOutbox),
		plans: await collect("settlementPlans", (raw) => {
			if (typeof raw !== "object" || raw === null) return undefined;
			return copyNativeSettlementPlan(raw, { objectId, author: Reflect.get(raw, "author") as string });
		}),
	};
}

/**
 * Rule A's one plan-before side row per object lives in the retirement-control store under a key no
 * object id can take (an object id never contains U+0000), so neither IndexedDB layout changes
 * schema; legacy code never reads it, and refuses the control-2 control beside it.
 * @param objectId - The addressed object.
 * @returns The side row's key.
 */
function browserRetirementPlanBeforeKey(objectId: string): string {
	return `${objectId}\u0000plan-before`;
}

/**
 * Applies a control transition's side-row effect in the transition's own transaction.
 * @param transaction - The transition transaction.
 * @param current - The actual current control.
 * @param next - The proposed control.
 * @param rows - The native rows before the transition.
 */
async function browserWriteRetirementPlanBefore(transaction: IDBTransaction, current: DurableIssuanceRetirementControl,
	next: DurableIssuanceRetirementControl, rows: IssuanceRetirementRows): Promise<void> {
	const planBefore = issuanceRetirementTransitionPlanBefore(current, next, rows);
	if (planBefore === undefined) return;
	const store = transaction.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls"));
	const key = browserRetirementPlanBeforeKey(current.objectId);
	if (planBefore === null) await requestResult(store.delete(key));
	else await requestResult(store.put({ objectId: key, record: planBefore }));
}

/**
 * Reads rule A's side row.
 * @param transaction - A readonly or readwrite transaction over the control store.
 * @param objectId - The addressed object.
 * @returns The exact side-row bytes, or null.
 */
async function browserReadRetirementPlanBefore(transaction: IDBTransaction, objectId: string): Promise<Uint8Array | null> {
	const raw: unknown = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance",
		"retirementControls")).get(browserRetirementPlanBeforeKey(objectId)));
	if (raw === undefined) return null;
	const record = typeof raw === "object" && raw !== null ? Reflect.get(raw, "record") : undefined;
	if (!(record instanceof Uint8Array)) throw issuanceRetirementRefusal("issuance retirement plan before is malformed");
	return new Uint8Array(record);
}

async function browserWriteRetirementPlanChanges(transaction: IDBTransaction,
	before: IssuanceRetirementRows, after: IssuanceRetirementRows): Promise<void> {
	for (let index = 0; index < before.plans.length; index++) {
		if (before.plans[index] === after.plans[index]) continue;
		await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans"))
			.put(nativeSettlementPlan(after.plans[index]!)));
	}
}

/** Private data for ONE object in ONE genuine readonly transaction. No
 * authentication, control, classification or protocol currency is retained. */
interface HeldIssuanceRecoveryImage {
	readonly transaction: IDBTransaction;
	readonly objectId: string;
	readonly rows: IssuanceRetirementRows;
	readonly image: DurableIssuanceRecoveryCensus["image"];
	readonly encodedRowBytes: number;
	readonly limits: Readonly<{maxRows: number; maxBytes: number}>;
	readonly lineages: ReadonlyMap<string, IssuanceRetirementRows["lineages"][number]>;
	readonly issued: ReadonlyMap<string, ReadonlyMap<number, NativeIssuedRecord>>;
	readonly outbox: ReadonlyMap<string, ReadonlyMap<number, NativeOutboxRecord>>;
	readonly plans: ReadonlyMap<string, SettlementPlan>;
	readonly globalOutboxComplete: boolean;
	// Consumed by the original reader only; cleared with this exact held basis.
	readonly enrollment: {value?: Readonly<{observation: WeakRef<DurableIssuanceRecoveryCensus>;
		input: DurableIssuanceRecoveryCensusInput; exactValueBytes: Uint8Array}>};
}

function copyRecoveryCensusRows(rows: IssuanceRetirementRows): IssuanceRetirementRows {
	return {
		lineages: rows.lineages.map(row => ({...row, ...(row.pendingUnsigned === undefined ? {} : {
			pendingUnsigned: captureIssuancePendingUnsignedIntent(row.pendingUnsigned, copyDurableIssueScope(row)) })})),
		issued: rows.issued.map(row => ({...row, canonicalPreimageBytes: new Uint8Array(row.canonicalPreimageBytes),
			digest: new Uint8Array(row.digest), signature: new Uint8Array(row.signature)})),
		outbox: rows.outbox.map(row => ({...row, digest: new Uint8Array(row.digest)})),
		plans: rows.plans.map(cloneSettlementPlan),
	};
}
async function browserRetirementRow(
	transaction: IDBTransaction,
	scope: DurableIssueScope,
	seq: number,
	preimage: Uint8Array,
	digest: Uint8Array
): Promise<void> {
	if (
		!issuanceRetirementAllows(await browserRetirementControl(transaction, scope.objectId), scope, seq, preimage, digest)
	)
		throw issuanceRetirementRefusal("issued epoch is retired");
}
async function browserBumpRetirement(transaction: IDBTransaction, objectId: string): Promise<void> {
	const control = await browserRetirementControl(transaction, objectId);
	if (control)
		await requestResult(
			transaction
				.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls"))
				.put({ objectId, record: encodeIssuanceRetirementControl(advanceIssuanceRetirementControl(control)) })
		);
}

class BrowserIssuanceImplementation {
	readonly #database: IDBDatabase;
	readonly #readReservations: NativeReadReservationOwner;
	// A basis is valid only inside this exact, still-held native readonly image.
	// Retain no issued/outbox history and never reuse across native transactions.
	readonly #validatedOutboxReadImages = new WeakSet<IDBTransaction>();
	#heldRecoveryImage?: HeldIssuanceRecoveryImage;
	readonly #transactions = new Set<IDBTransaction>();
	readonly #retirementOperations = new Set<Promise<unknown>>();
	readonly #signReleases = new Set<() => Promise<void>>();
	#closed = false;
	#closePromise?: Promise<void>;
	#resolveClose?: () => void;
	#poison?: DurableIssuanceContractError;

	constructor(database: IDBDatabase) {
		this.#database = database;
		this.#readReservations = new NativeReadReservationOwner(database);
	}

	async acquireNativeReadReservation(input: {
		readonly objectId: string;
	}): ReturnType<NativeReadReservationOwner["acquire"]> {
		this.#assertAvailable();
		const objectId = captureNativeReadReservationInput(input);
		if (!isValidDurableScopeField(objectId)) throw invalid("reservation objectId is malformed");
		const held = await this.#readReservations.acquire({ objectId });
		let transaction: IDBTransaction | undefined;
		try { transaction = this.#readReservations.view(); }
		catch (primary) {
			try { await held.release(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "native issuance read acquisition cleanup failed", {cause: primary}); }
			throw primary;
		}
		let releaseTask: Promise<void> | undefined;
		return Object.freeze({check: () => held.check(), release: () => releaseTask ??= (async () => {
			try { await held.release(); }
			finally { if (this.#heldRecoveryImage?.transaction === transaction) this.#heldRecoveryImage = undefined; }
		})()});
	}

	readBoundedRecoveryCensus(input: unknown): Promise<DurableIssuanceRecoveryCensus> {
		this.#assertAvailable();
		const captured = captureDurableIssuanceRecoveryCensusInput(input);
		return this.#trackRetirement(
			this.#runReservedRead(async () => {
				this.#assertAvailable();
				const transaction = this.#startTransaction("readonly"),
					terminal = transactionResult(transaction);
				try {
					const prior = this.#recoveryImage(transaction, captured.objectId);
					// A smaller entitlement retains the original native read/codec
					// refusal order, rather than projecting a new refusal from a cache.
					const existing = prior !== undefined && captured.limits.maxRows >= prior.limits.maxRows &&
						captured.limits.maxBytes >= prior.limits.maxBytes ? prior : undefined;
					const seed = {keysMatch: true, encodedRowBytes: 0};
					if (existing !== undefined) {
						if (existing.image.lineageCount + existing.image.issuedCount + existing.image.outboxCount + existing.image.planCount > captured.limits.maxRows)
							throw issuanceRetirementRefusal("issuance retirement native census exceeds bound");
						if (existing.encodedRowBytes > captured.limits.maxBytes)
							throw issuanceRetirementRefusal("issuance retirement native image exceeds bound");
					}
					const rows = existing?.rows ?? await browserRetirementRows(transaction, captured.objectId, captured.limits, seed);
					const image = existing?.image ?? issuanceRetirementImage(rows, captured.objectId);
					const control = await browserRetirementControl(transaction, captured.objectId);
					if (image.logicalBytes > captured.limits.maxBytes)
						throw issuanceRetirementRefusal("issuance recovery census exceeds byte entitlement");
					await terminal;
					this.#assertAvailable();
					if (existing === undefined && isNativeReadReservationTransaction(transaction) &&
						this.#heldRecoveryImage === undefined && seed.keysMatch)
						await this.#captureRecoveryImage(transaction, captured.objectId, rows, image, seed.encodedRowBytes, captured.limits);
					// Ordinary transactions have already emitted completion at terminal;
					// only a held view has an additional, fresh native currency check.
					if (isNativeReadReservationTransaction(transaction)) await transactionResult(transaction);
					this.#assertAvailable();
					const observation = { rows: this.#heldRecoveryImage?.rows === rows ? copyRecoveryCensusRows(rows) : rows, image, control };
					const basis = this.#heldRecoveryImage;
					if (basis?.transaction === transaction && basis.objectId === captured.objectId) {
						try { basis.enrollment.value = Object.freeze({observation: new WeakRef(observation), input: captured,
							exactValueBytes: encodeCanonical(observation)}); }
						catch { basis.enrollment.value = undefined; } // Optional reuse never narrows the original full read.
					}
					return observation;
				} catch (error) {
					// A borrowed transaction belongs to the original reservation owner.
					if (!isNativeReadReservationTransaction(transaction)) {
						try {
							transaction.abort();
						} catch {
							/* Original terminal may have joined. */
						}
					}
					await terminal.catch(() => undefined);
					throw error;
				}
			})
		);
	}

	captureRecoveryCensusCurrentProbe(input: DurableIssuanceRecoveryCensusInput,
		observation: DurableIssuanceRecoveryCensus): DurableIssuanceRecoveryCensusCurrentProbe | undefined {
		this.#assertAvailable();
		const basis = this.#heldRecoveryImage, enrollment = basis?.enrollment.value;
		if (basis === undefined || enrollment === undefined || enrollment.observation.deref() !== observation) return undefined;
		try {
			const captured = captureDurableIssuanceRecoveryCensusInput(input);
			if (!isClosedDurableIssuanceRecord(observation, ["rows", "image", "control"]) ||
				captured.objectId !== enrollment.input.objectId || captured.limits.maxRows !== enrollment.input.limits.maxRows ||
				captured.limits.maxBytes !== enrollment.input.limits.maxBytes ||
				nativeReadReservationTransaction(this.#database) !== basis.transaction ||
				!issuanceRetirementBytesEqual(encodeCanonical(observation), enrollment.exactValueBytes)) return undefined;
		} catch { return undefined; } // Copied, mutated or wrong-entitlement data cannot enroll.
		basis.enrollment.value = undefined;
		const reference = new WeakRef(basis), transactionReference = new WeakRef(basis.transaction), objectId = basis.objectId;
		const implementation = this;
		const probe: DurableIssuanceRecoveryCensusCurrentProbe = Object.freeze({
			checkCurrent: function (this: DurableIssuanceRecoveryCensusCurrentProbe): Promise<boolean> {
				if (this !== probe) return Promise.reject(invalid("native census probe is foreign"));
				return implementation.#trackRetirement(implementation.#checkRecoveryCensusCurrent(reference, transactionReference, objectId));
			},
		});
		return probe;
	}

	async #checkRecoveryCensusCurrent(reference: WeakRef<HeldIssuanceRecoveryImage>, transactionReference: WeakRef<IDBTransaction>,
		objectId: string): Promise<boolean> {
		this.#assertAvailable();
		const transaction = transactionReference.deref();
		if (transaction === undefined || nativeReadReservationTransaction(this.#database) !== transaction) return false;
		// A genuine fresh request/terminal check in the SAME native all-store view.
		// No census rows, control carriers or image checksum are copied/redecoded.
		await this.#runReservedRead(async () => {
			if (nativeReadReservationTransaction(this.#database) !== transaction) return;
			await transactionResult(transaction);
		});
		this.#assertAvailable();
		if (nativeReadReservationTransaction(this.#database) !== transaction) return false;
		const basis = reference.deref();
		return basis !== undefined && this.#heldRecoveryImage === basis && basis.transaction === transaction && basis.objectId === objectId;
	}

	#recoveryImage(transaction: IDBTransaction, objectId: string): HeldIssuanceRecoveryImage | undefined {
		this.#assertAvailable();
		const image = this.#heldRecoveryImage;
		return isNativeReadReservationTransaction(transaction) && image?.transaction === transaction && image.objectId === objectId ? image : undefined;
	}

	async #captureRecoveryImage(transaction: IDBTransaction, objectId: string, rows: IssuanceRetirementRows,
		image: DurableIssuanceRecoveryCensus["image"], encodedRowBytes: number,
		limits: Readonly<{maxRows: number; maxBytes: number}>): Promise<void> {
		// The original image has already validated native schema, preimage,
		// lineage/watermark, plan and every issued-to-outbox pair. Validate the
		// reverse direction and exact addresses before these data replace reads.
		const lineages = new Map(rows.lineages.map(row => [row.author, row]));
		const plans = new Map(rows.plans.map(row => [row.scope.author, row]));
		const indexRows = <T extends {readonly author: string; readonly authorSequence: number}>(values: readonly T[]) => {
			const index = new Map<string, Map<number, T>>();
			for (const row of values) {
				let author = index.get(row.author);
				if (author === undefined) index.set(row.author, author = new Map());
				if (author.has(row.authorSequence)) return undefined;
				author.set(row.authorSequence, row);
			}
			return index;
		};
		const issued = indexRows(rows.issued), outbox = indexRows(rows.outbox);
		if (issued === undefined || outbox === undefined || lineages.size !== rows.lineages.length || plans.size !== rows.plans.length ||
			rows.outbox.some(row => !issued.get(row.author)?.has(row.authorSequence))) return;
		const counted = await Promise.allSettled(["lineages", "issuedRecords", "issuanceOutbox"].map(name =>
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", name)).count())));
		const counts: number[] = [];
		for (const result of counted) {
			if (result.status === "rejected") throw result.reason;
			counts.push(result.value);
		}
		await transactionResult(transaction);
		this.#assertAvailable();
		if (this.#heldRecoveryImage !== undefined) return;
		this.#heldRecoveryImage = Object.freeze({transaction, objectId, rows, image, encodedRowBytes, limits, lineages, enrollment: {},
			issued, outbox, plans, globalOutboxComplete: counts[0] === rows.lineages.length &&
				counts[1] === rows.issued.length && counts[2] === rows.outbox.length});
	}

	#trackRetirement<T>(operation: Promise<T>): Promise<T> {
		this.#retirementOperations.add(operation);
		void operation.then(
			() => this.#retirementOperations.delete(operation),
			() => this.#retirementOperations.delete(operation)
		);
		return operation;
	}
	withNativeSignAdmission(input: unknown, sign: () => Promise<Uint8Array>): Promise<Uint8Array> {
		return this.#trackRetirement(this.#withNativeSignAdmission(input, sign));
	}
	async #withNativeSignAdmission(input: unknown, sign: () => Promise<Uint8Array>): Promise<Uint8Array> {
		this.#assertAvailable();
		const captured = captureIssuanceNativeSignInput(input);
		if (typeof sign !== "function") throw invalid("native sign continuation must be a function");
		if (this.#readReservations.view()) throw issuanceRetirementRefusal("issuance native read view already held");
		const held = await this.acquireNativeReadReservation({ objectId: captured.scope.objectId });
		const release = (): Promise<void> => held.release();
		this.#signReleases.add(release);
		try {
			return await joinIssuanceNativeSign(
				async () => {
					this.#assertAvailable();
					await held.check();
					await this.#runReservedRead(async () => {
						const transaction = this.#startTransaction("readonly");
						const raw = await requestResult(
							transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([captured.scope.objectId, captured.scope.author])
						);
						const lineage =
							raw === undefined
								? { next: 0, exhausted: false, prunedThroughAuthorSequence: null }
								: copyNativeLineage(raw, captured.scope);
						if (!lineage || lineage.exhausted || lineage.next !== captured.sequence)
							throw issuanceRetirementRefusal("native sign lineage changed");
						await browserRetirementRow(transaction, captured.scope, captured.sequence, captured.bytes, captured.digest);
					});
				},
				release,
				sign
			);
		} finally {
			this.#signReleases.delete(release);
		}
	}
	acquireRetirementControl(input: { readonly objectId: string }): Promise<DurableIssuanceRetirementControlRead> {
		return this.#trackRetirement(this.#acquireRetirementControl(input));
	}
	async readRetirementPlanBefore(input: { readonly objectId: string }): Promise<Uint8Array | null> {
		this.#assertAvailable();
		const objectId = captureIssuanceRetirementObject(input);
		const transaction = this.#startTransaction("readonly"), terminal = transactionResult(transaction);
		try {
			const bytes = await browserReadRetirementPlanBefore(transaction, objectId);
			await terminal;
			return bytes;
		} catch (error) {
			await terminal.catch(() => undefined);
			throw error;
		}
	}
	/**
	 * Slice 14a: the original acquisition inside a room retirement session, with this
	 * store's lifetime and held-view refusals checked before every session operation.
	 * @param session - The open room retirement session of this store's database.
	 * @param input - Exact addressed object.
	 * @returns The original retirement read, its transitions bound to the session.
	 */
	acquireRetirementControlInSession(
		session: RoomRetirementSession,
		input: { readonly objectId: string }
	): Promise<DurableIssuanceRetirementControlRead> {
		const guard = (): void => {
			this.#assertAvailable();
			if (this.#readReservations.view())
				throw issuanceRetirementRefusal("join issuance native readonly reservation before retirement");
		};
		return this.#trackRetirement(
			Promise.resolve().then(() => acquireBrowserRoomIssuanceRetirement(session, input, guard))
		);
	}
	async #acquireRetirementControl(input: { readonly objectId: string }): Promise<DurableIssuanceRetirementControlRead> {
		this.#assertAvailable();
		const objectId = captureIssuanceRetirementObject(input);
		if (this.#readReservations.view())
			throw issuanceRetirementRefusal("join issuance native readonly reservation before retirement");
		let snapshot = await this.#retirementSnapshot(objectId);
		this.#assertAvailable();
		if (snapshot.control === null) {
			const born: DurableIssuanceRetirementControl = {
				kind: "v3-issuance-retirement-control-1",
				objectId,
				incarnation: issuanceRetirementHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
				revision: 0,
				sequence: 0,
				active: null,
				completed: null,
			};
			const transaction = this.#startTransaction("readwrite"),
				terminal = transactionResult(transaction);
			let primary: unknown;
			try {
				const rows = await browserRetirementRows(transaction, objectId);
				if (
					(await browserRetirementControl(transaction, objectId)) !== null ||
					issuanceRetirementImage(rows, objectId).imageDigest !== snapshot.image.imageDigest
				)
					throw issuanceRetirementRefusal("issuance retirement birth stale");
				await requestResult(
					transaction.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls")).add({ objectId, record: encodeIssuanceRetirementControl(born) })
				);
				await terminal;
			} catch (error) {
				primary = error;
				try {
					transaction.abort();
				} catch {
					/* Original terminal may have joined. */
				}
				await terminal.catch(() => undefined);
			}
			const observed = await this.#retirementSnapshot(objectId);
			if (
				!observed.control ||
				!issuanceRetirementBytesEqual(
					encodeIssuanceRetirementControl(observed.control),
					encodeIssuanceRetirementControl(born)
				) ||
				observed.image.imageDigest !== snapshot.image.imageDigest
			)
				throw primary ?? issuanceRetirementRefusal("issuance retirement birth changed");
			snapshot = observed;
		}
		const control = snapshot.control as DurableIssuanceRetirementControl,
			image = snapshot.image;
		return createIssuanceRetirementControlRead(control, image, (next, p) =>
			this.#trackRetirement(this.#compareRetirement(control, snapshot.rows, image.imageDigest, next, p))
		);
	}
	async #compareRetirement(
		control: DurableIssuanceRetirementControl,
		capturedRows: IssuanceRetirementRows,
		imageDigest: string,
		next: DurableIssuanceRetirementControl,
		p?: DurableIssuanceRetirementPreparation
	): Promise<DurableIssuanceRetirementControl> {
		this.#assertAvailable();
		if (this.#readReservations.view())
			throw issuanceRetirementRefusal("join issuance native readonly reservation before retirement");
		const expectedRows = issuanceRetirementTransitionRows(control, next, capturedRows);
		const expectedImage = issuanceRetirementImage(expectedRows, control.objectId);
		const objectId = control.objectId,
			transaction = this.#startTransaction("readwrite"),
			terminal = transactionResult(transaction);
		let primary: unknown;
		try {
			const current = await browserRetirementControl(transaction, objectId),
				rows = await browserRetirementRows(transaction, objectId);
			if (
				!current ||
				!issuanceRetirementBytesEqual(
					encodeIssuanceRetirementControl(current),
					encodeIssuanceRetirementControl(control)
				) ||
				issuanceRetirementImage(rows, objectId).imageDigest !== imageDigest
			)
				throw issuanceRetirementRefusal("issuance retirement source stale");
			if (p) assertIssuanceRetirementPreparationRows(current, p, rows);
			const targetRows = issuanceRetirementTransitionRows(current, next, rows);
			if (issuanceRetirementImage(targetRows, objectId).imageDigest !== expectedImage.imageDigest)
				throw issuanceRetirementRefusal("issuance retirement target stale");
			await browserWriteRetirementPlanBefore(transaction, current, next, rows);
			await browserWriteRetirementPlanChanges(transaction, rows, targetRows);
			await requestResult(
				transaction.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls")).put({ objectId, record: encodeIssuanceRetirementControl(next) })
			);
			await terminal;
		} catch (error) {
			primary = error;
			try {
				transaction.abort();
			} catch {
				/* Readback owns terminal ambiguity. */
			}
			await terminal.catch(() => undefined);
		}
		let observed;
		try {
			observed = await this.#retirementSnapshot(objectId);
		} catch {
			throw new DurableIssuanceContractError("ISSUANCE_OUTCOME_UNKNOWN", "issuance retirement outcome unknown");
		}
		if (
			observed.control &&
			issuanceRetirementBytesEqual(
				encodeIssuanceRetirementControl(observed.control),
				encodeIssuanceRetirementControl(next)
			) &&
			observed.image.imageDigest === expectedImage.imageDigest
		)
			return observed.control;
		if (
			observed.control &&
			issuanceRetirementBytesEqual(
				encodeIssuanceRetirementControl(observed.control),
				encodeIssuanceRetirementControl(control)
			) &&
			observed.image.imageDigest === imageDigest
		)
			throw primary ?? issuanceRetirementRefusal("issuance retirement unchanged");
		throw primary instanceof DurableIssuanceContractError || primary instanceof DurableIssuanceInvalidArgumentError
			? primary
			: new DurableIssuanceContractError("ISSUANCE_OUTCOME_UNKNOWN", "issuance retirement readback ambiguous");
	}
	async #retirementSnapshot(objectId: string): Promise<{
		rows: IssuanceRetirementRows;
		image: ReturnType<typeof issuanceRetirementImage>;
		control: DurableIssuanceRetirementControl | null;
	}> {
		const transaction = this.#startTransaction("readonly"),
			terminal = transactionResult(transaction);
		try {
			const rows = await browserRetirementRows(transaction, objectId),
				control = await browserRetirementControl(transaction, objectId);
			const image = issuanceRetirementImage(rows, objectId);
			await terminal;
			return { rows, image, control };
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				/* Preserve source failure. */
			}
			await terminal.catch(() => undefined);
			throw error;
		}
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		const releases = Array.from(this.#signReleases);
		this.#database.onversionchange = null;
		this.#database.close();
		const operationsJoined = new Promise<void>((resolve) => {
			this.#resolveClose = resolve;
			this.#finishCloseIfIdle();
		});
		// Connection close preserves admitted transactions. Release exclusion
		// only after admitted crypto joins, never merely after close invocation.
		this.#closePromise = Promise.allSettled(this.#retirementOperations).then(async () => {
			const joined = await Promise.allSettled([
				operationsJoined,
				this.#readReservations.close(),
				...releases.map((release) => release()),
			]);
			const failures = joined
				.filter((r): r is PromiseRejectedResult => r.status === "rejected")
				.map((r) => r.reason as unknown);
			// The original native owner has now joined every admitted read. No
			// privately retained image outlives that reservation/close boundary.
			this.#heldRecoveryImage = undefined;
			if (failures.length === 1) throw failures[0];
			if (failures.length) throw new AggregateError(failures, "native sign close failed", { cause: failures[0] });
		});
		return this.#closePromise;
	}

	versionchange(): void {
		void this.close().catch(() => undefined);
	}

	async compareAndMarkOutboxPublished(input: DurableOutboxPublicationTransitionInput): Promise<void> {
		// Publication owns ISSUANCE_INVALID_ARGUMENT, ISSUANCE_RECOVERY_CORRUPT,
		// ISSUANCE_STORE_CLOSED, ISSUANCE_SUBSTRATE_FAILURE, and
		// ISSUANCE_OUTCOME_UNKNOWN without delegating to terminal suppression.
		this.#assertAvailable();
		const captured = this.#capturePublicationInput(input);
		let transaction: IDBTransaction;
		try {
			transaction = this.#startTransaction("readwrite");
		} catch (error) {
			this.#assertAvailable();
			throw error;
		}
		const terminal = transactionResult(transaction);
		let reason: Error | undefined;
		try {
			const key = [captured.scope.objectId, captured.scope.author, captured.authorSequence];
			const rawLineage = await requestResult(
				transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([captured.scope.objectId, captured.scope.author])
			);
			const rawIssued = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuedRecords")).get(key));
			const rawOutbox = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox")).get(key));
			let observation: TerminalReadback;
			try {
				observation = this.#terminalFromRaw(captured.scope, rawLineage, rawIssued, rawOutbox);
			} catch (error) {
				reason = error instanceof Error ? error : this.#latchCorruption("publication closure is unreadable");
				transaction.abort();
				throw reason;
			}
			const status = this.#publicationStatus(observation, captured);
			if (observation.issuedRecord) {
				try {
					await browserRetirementRow(
						transaction,
						captured.scope,
						captured.authorSequence,
						observation.issuedRecord.envelope.canonicalPreimageBytes,
						observation.issuedRecord.envelope.digest
					);
				} catch (error) {
					reason = error instanceof Error ? error : issuanceRetirementRefusal("issued epoch is retired");
					transaction.abort();
					throw reason;
				}
			}
			if (status === "never-issued") reason = invalid("publication address has never been issued");
			else if (status === "pruned") {
				reason = createDurableIssuanceRecordPrunedError(captured.scope, captured.authorSequence);
			} else if (status === "foreign-digest") {
				reason = invalid("publication digest does not identify the issued closure");
			} else if (status === "corrupt") {
				reason = this.#latchCorruption("publication closure is incomplete or malformed");
			}
			if (reason === undefined && (status === "pending" || status === "published")) {
				const rawPlan = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans"))
					.get([captured.scope.objectId, captured.scope.author]));
				const plan = rawPlan === undefined ? null : copyNativeSettlementPlan(rawPlan, captured.scope);
				if (plan === undefined) reason = this.#latchCorruption("stored settlement plan is malformed");
				else {
					try {
						assertSettlementExpiryPublicationExclusive(plan, [{authorSequence: captured.authorSequence, publishState: "published"}]);
					} catch (error) {
						reason = error instanceof Error ? error : issuanceRetirementRefusal("settlement source expiry and publication are exclusive");
					}
				}
			}
			if (reason === undefined && status === "pending") {
				const row = observation.outboxRecord;
				if (row === null) throw this.#latchCorruption("publication outbox row disappeared");
				const writtenKey = await requestResult(
					transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox")).put({
						author: row.scope.author,
						authorSequence: row.authorSequence,
						digest: new Uint8Array(row.digest),
						objectId: row.scope.objectId,
						publishState: "published",
					})
				);
				if (!this.#sameNativeRecordKey(writtenKey, captured.scope, captured.authorSequence)) {
					reason = this.#latchCorruption("publication put returned an impossible key");
					transaction.abort();
				}
			}
			if (reason !== undefined) transaction.abort();
			await browserBumpRetirement(transaction, captured.scope.objectId);
			await terminal;
			if (reason !== undefined) throw reason;
		} catch {
			await terminal.catch(() => undefined);
			if (reason !== undefined) throw reason;
			if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
			return this.#classifyPublicationReadback(captured, "ambiguous");
		}
		this.#assertAvailable();
		return this.#classifyPublicationReadback(captured, "success");
	}

	async readLineage(scope: DurableIssueScope): Promise<DurableLineage> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		if (needsNativeReadReservationTurn(this.#database)) return this.#runReservedRead(() => this.readLineage(detached));
		const transaction = this.#startTransaction("readonly");
		try {
			const image = this.#recoveryImage(transaction, detached.objectId);
			if (image !== undefined) {
				const lineage = image.lineages.get(detached.author);
				await transactionResult(transaction);
				this.#assertAvailable();
				return lineage === undefined ? {exhausted: false, next: 0} : {exhausted: lineage.exhausted, next: lineage.next};
			}
			const raw = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([detached.objectId, detached.author]));
			await transactionResult(transaction);
			if (raw === undefined) return { exhausted: false, next: 0 };
			const lineage = copyNativeLineage(raw, detached);
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			return { exhausted: lineage.exhausted, next: lineage.next };
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "lineage read failed");
		}
	}

	async readSettlementPlan(scope: DurableIssueScope): Promise<SettlementPlan | null> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		if (needsNativeReadReservationTurn(this.#database))
			return this.#runReservedRead(() => this.readSettlementPlan(detached));
		const transaction = this.#startTransaction("readonly");
		try {
			const image = this.#recoveryImage(transaction, detached.objectId);
			if (image !== undefined) {
				const plan = image.plans.get(detached.author);
				await transactionResult(transaction);
				this.#assertAvailable();
				return plan === undefined ? null : cloneSettlementPlan(plan);
			}
			const raw = await requestResult(
				transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans")).get([detached.objectId, detached.author])
			);
			await transactionResult(transaction);
			if (raw === undefined) return null;
			const plan = copyNativeSettlementPlan(raw, detached);
			if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			return cloneSettlementPlan(plan);
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "settlement plan read failed");
		}
	}

	async transactWriteSettlementPlan(input: unknown): Promise<SettlementPlan> {
		const captured = captureSettlementPlanWriteInput(input);
		this.#assertAvailable();
		const transaction = this.#startTransaction("readwrite");
		const terminal = transactionResult(transaction);
		let reason: Error | undefined;
		try {
			const plans = transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans"));
			const key = [captured.scope.objectId, captured.scope.author];
			const raw = await requestResult(plans.get(key));
			const current = raw === undefined ? null : copyNativeSettlementPlan(raw, captured.scope);
			if (raw !== undefined && current === undefined) {
				reason = this.#latchCorruption("stored settlement plan is malformed");
				transaction.abort();
			} else if ((current?.revision ?? null) !== captured.expectedRevision) {
				reason = createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement plan revision changed");
				transaction.abort();
			} else {
				try {
					assertSettlementPlanProgressTransition(current ?? null, captured.plan);
				} catch (error) {
					reason =
						error instanceof Error
							? error
							: createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement plan progress changed");
					transaction.abort();
				}
			}
			if (reason === undefined) {
				const outbox = transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox"));
				const states: { authorSequence: number; publishState: "pending" | "published" }[] = [];
				for (const entry of captured.plan.entries) {
					if (entry.sourceObjectId !== undefined || !settlementEntryIsAuthenticatedExpiry(entry)) continue;
					const raw: unknown = await requestResult(outbox.get([captured.scope.objectId, captured.scope.author, entry.sourceSequence]));
					if (raw === undefined) continue;
					const state: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "publishState") : undefined;
					if (state !== "pending" && state !== "published") throw this.#latchCorruption("stored outbox publication state is malformed");
					states.push({authorSequence: entry.sourceSequence, publishState: state});
				}
				assertSettlementExpiryPublicationExclusive(captured.plan, states);
				const retired = await browserRetirementControl(transaction, captured.scope.objectId);
				if (retired)
					assertIssuanceRetirementPlanAllowed(
						retired,
						captured.plan,
						await browserRetirementRows(transaction, captured.scope.objectId)
					);
				const writtenKey = await requestResult(plans.put(nativeSettlementPlan(captured.plan)));
				await browserBumpRetirement(transaction, captured.scope.objectId);
				if (!this.#sameNativePlanKey(writtenKey, captured.scope)) {
					reason = this.#latchCorruption("settlement plan put returned an impossible key");
					transaction.abort();
				}
			}
			await terminal;
			if (reason !== undefined) throw reason;
			return cloneSettlementPlan(captured.plan);
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// The transaction may already be terminal.
			}
			await terminal.catch(() => undefined);
			if (reason !== undefined) throw reason;
			if (error instanceof DurableIssuanceContractError || error instanceof DurableIssuanceInvalidArgumentError) {
				throw error;
			}
			if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
			throw mapSubstrateError(error, "settlement plan write failed");
		}
	}

	async readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (!isValidDurableAuthorSequence(authorSequence)) throw invalid("authorSequence must be a safe ordinal");
		const detached = copyDurableIssueScope(scope);
		if (needsNativeReadReservationTurn(this.#database))
			return this.#runReservedRead(() => this.readIssued(detached, authorSequence));
		const transaction = this.#startTransaction("readonly");
		try {
			const image = this.#recoveryImage(transaction, detached.objectId);
			if (image !== undefined) {
				const row = image.issued.get(detached.author)?.get(authorSequence);
				// Native complete-image validation and exact key correspondence
				// establish the same pair/lineage/watermark laws as the point path.
				// Every delivery still checks the real held transaction freshly.
				await transactionResult(transaction);
				this.#assertAvailable();
				return row === undefined ? null : commitFromIssued(row);
			}
			const key = [detached.objectId, detached.author, authorSequence];
			const [rawIssued, rawOutbox, rawLineage] = await Promise.all([
				requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuedRecords")).get(key)),
				requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox")).get(key)),
				requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([detached.objectId, detached.author])),
			]);
			await transactionResult(transaction);
			const lineage =
				rawLineage === undefined
					? { exhausted: false, next: 0, prunedThroughAuthorSequence: null }
					: copyNativeLineage(rawLineage, detached);
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			if (rawIssued === undefined && rawOutbox === undefined) {
				if (
					durableIssuanceLineageConsumed(lineage, authorSequence) &&
					!durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, authorSequence)
				) {
					throw this.#latchCorruption("consumed issued closure is absent above the pruning watermark");
				}
				return null;
			}
			const row = rawIssued === undefined ? undefined : copyNativeIssued(rawIssued);
			const outbox = rawOutbox === undefined ? undefined : copyNativeOutbox(rawOutbox);
			if (
				row === undefined ||
				outbox === undefined ||
				lineage === undefined ||
				row.objectId !== detached.objectId ||
				row.author !== detached.author ||
				row.authorSequence !== authorSequence ||
				outbox.objectId !== detached.objectId ||
				outbox.author !== detached.author ||
				outbox.authorSequence !== authorSequence ||
				!this.#bytesEqual(row.digest, outbox.digest) ||
				!durableIssuanceLineageConsumed(lineage, authorSequence) ||
				durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, authorSequence)
			) {
				throw this.#latchCorruption("stored issued closure is incomplete or malformed");
			}
			return commitFromIssued(row);
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "issued-record read failed");
		}
	}

	async readOutboxPage(input: DurableOutboxPageInput = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
		this.#assertAvailable();
		const parsed = this.#parsePageInput(input);
		if (needsNativeReadReservationTurn(this.#database)) {
			const captured: DurableOutboxPageInput = {
				...parsed,
				afterKey: parsed.afterKey === null ? null : [parsed.afterKey[0], parsed.afterKey[1], parsed.afterKey[2]],
			};
			return this.#runReservedRead(() => this.readOutboxPage(captured));
		}
		const transaction = this.#startTransaction("readonly");
		try {
			const image = this.#heldRecoveryImage;
			if (image?.transaction === transaction && isNativeReadReservationTransaction(transaction) &&
				(image.globalOutboxComplete || (parsed.scope?.objectId === image.objectId && this.#validatedOutboxReadImages.has(transaction)))) {
				const records: DurableIssuanceOutboxRecord[] = [];
				for (const row of image.rows.outbox) {
					if (parsed.scope !== undefined && !this.#sameScope(row, parsed.scope)) continue;
					if (parsed.afterKey !== null && compareDurableIssuanceCompoundKeys(this.#issuedKey(row), parsed.afterKey) <= 0) continue;
					const issued = image.issued.get(row.author)?.get(row.authorSequence);
					if (issued === undefined) throw this.#latchCorruption("outbox has no matching issued record");
					records.push({commit: commitFromIssued(issued), publishState: row.publishState});
					if (records.length === parsed.limit) break;
				}
				await transactionResult(transaction);
				this.#assertAvailable();
				if (image.globalOutboxComplete) this.#validatedOutboxReadImages.add(transaction);
				return records;
			}
			if (isNativeReadReservationTransaction(transaction) && this.#validatedOutboxReadImages.has(transaction)) {
				return await this.#readValidatedOutboxPage(transaction, parsed);
			}
			const terminal = transactionResult(transaction);
			// Observe terminal failure even if validation refuses before its join.
			void terminal.catch(() => undefined);
			let records: readonly DurableIssuanceOutboxRecord[];
			try {
				records = await this.#scanOutboxPage(transaction, parsed);
			} finally {
				await terminal;
			}
			if (isNativeReadReservationTransaction(transaction)) await transactionResult(transaction);
			this.#assertAvailable();
			if (isNativeReadReservationTransaction(transaction)) this.#validatedOutboxReadImages.add(transaction);
			return records;
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "outbox read failed");
		}
	}

	// Validate the whole held image, retaining only three heads and the requested page.
	#scanOutboxPage(
		transaction: IDBTransaction,
		parsed: ParsedOutboxPage
	): Promise<readonly DurableIssuanceOutboxRecord[]> {
		return new Promise((resolve, reject) => {
			const requests = ["lineages", "issuedRecords", "issuanceOutbox"].map((name) =>
				transaction.objectStore(roomStoreName(transaction.db, "issuance", name)).openCursor()
			);
			const ready = [false, false, false];
			const cursors: (IDBCursorWithValue | null)[] = [null, null, null];
			let lineage: { scope: DurableIssueScope; value: NonNullable<ReturnType<typeof copyNativeLineage>> } | null = null;
			let issued: NativeIssuedRecord | null = null;
			let outbox: NativeOutboxRecord | null = null;
			const page: DurableIssuanceOutboxRecord[] = [];
			let settled = false;
			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const advance = (index: number): void => {
				const cursor = cursors[index];
				if (cursor === null || cursor === undefined) throw new Error("outbox cursor exhausted");
				ready[index] = false;
				cursors[index] = null;
				// Continuation stays in the native success-event transaction turn.
				cursor.continue();
			};
			const step = (): void => {
				if (settled || !ready.every(Boolean)) return;
				if (issued === null || outbox === null) {
					if (issued !== null || outbox !== null) throw this.#latchCorruption("issued/outbox closure is incomplete");
					if (lineage !== null) {
						advance(0);
						return;
					}
					settled = true;
					resolve(page);
					return;
				}
				if (
					compareDurableIssuanceCompoundKeys(this.#issuedKey(issued), this.#issuedKey(outbox)) !== 0 ||
					!this.#bytesEqual(issued.digest, outbox.digest)
				)
					throw this.#latchCorruption("outbox has no matching issued record");
				const scopeOrder =
					lineage === null
						? 1
						: compareDurableIssuanceCompoundKeys(
								[lineage.scope.objectId, lineage.scope.author, 0],
								[issued.objectId, issued.author, 0]
							);
				if (scopeOrder < 0) {
					advance(0);
					return;
				}
				if (
					lineage === null ||
					scopeOrder !== 0 ||
					!durableIssuanceLineageConsumed(lineage.value, issued.authorSequence) ||
					durableIssuanceAddressIsPruned(lineage.value.prunedThroughAuthorSequence, issued.authorSequence)
				)
					throw this.#latchCorruption("stored outbox closure was not consumed by lineage");
				if (
					page.length < parsed.limit &&
					(parsed.scope === undefined || this.#sameScope(issued, parsed.scope)) &&
					(parsed.afterKey === null || compareDurableIssuanceCompoundKeys(this.#issuedKey(issued), parsed.afterKey) > 0)
				)
					page.push({ commit: commitFromIssued(issued), publishState: outbox.publishState });
				advance(1);
				advance(2);
			};
			for (let index = 0; index < requests.length; index++) {
				const request = requests[index];
				if (request === undefined) throw new Error("outbox cursor request missing");
				request.addEventListener("error", () => fail(request.error), { once: true });
				request.addEventListener("success", () => {
					if (settled) return;
					try {
						const cursor = request.result;
						cursors[index] = cursor;
						ready[index] = true;
						if (index === 0) {
							lineage = null;
							if (cursor !== null) {
								const raw: unknown = cursor.value;
								if (
									typeof raw !== "object" ||
									raw === null ||
									!isValidDurableScopeField(Reflect.get(raw, "author")) ||
									!isValidDurableScopeField(Reflect.get(raw, "objectId"))
								)
									throw this.#latchCorruption("stored lineage is malformed");
								const scope = {
									author: Reflect.get(raw, "author") as string,
									objectId: Reflect.get(raw, "objectId") as string,
								};
								const value = copyNativeLineage(raw, scope);
								if (value === undefined) throw this.#latchCorruption("stored lineage is malformed");
								lineage = { scope, value };
							}
						} else if (index === 1) {
							issued = cursor === null ? null : (copyNativeIssued(cursor.value) ?? null);
							if (cursor !== null && issued === null) throw this.#latchCorruption("stored issued record is malformed");
						} else {
							outbox = cursor === null ? null : (copyNativeOutbox(cursor.value) ?? null);
							if (cursor !== null && outbox === null) throw this.#latchCorruption("stored outbox record is malformed");
						}
						step();
					} catch (error) {
						fail(error);
					}
				});
			}
		});
	}

	async #readValidatedOutboxPage(
		transaction: IDBTransaction,
		parsed: ParsedOutboxPage
	): Promise<readonly DurableIssuanceOutboxRecord[]> {
		let range: IDBKeyRange | undefined;
		if (parsed.scope !== undefined) {
			const { objectId, author } = parsed.scope;
			const first: readonly [string, string, number] = [objectId, author, 0];
			if (parsed.afterKey !== null && compareDurableIssuanceCompoundKeys(parsed.afterKey, first) >= 0) {
				if (parsed.afterKey[0] !== objectId || parsed.afterKey[1] !== author) {
					await transactionResult(transaction);
					this.#assertAvailable();
					return [];
				}
				range = IDBKeyRange.bound([...parsed.afterKey], [objectId, author, []], true, true);
			} else {
				range = IDBKeyRange.bound([objectId, author], [objectId, author, []], false, true);
			}
		} else if (parsed.afterKey !== null) {
			range = IDBKeyRange.lowerBound([...parsed.afterKey], true);
		}
		const rawRows = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox")).getAll(range, parsed.limit));
		const result: DurableIssuanceOutboxRecord[] = [];
		for (const raw of rawRows) {
			const row = copyNativeOutbox(raw);
			if (row === undefined) throw this.#latchCorruption("stored outbox record is malformed");
			// Reuse the original exact pair/lineage reader and shared detachment law.
			const commit = await this.readIssued({ objectId: row.objectId, author: row.author }, row.authorSequence);
			if (commit === null || !this.#bytesEqual(commit.envelope.digest, row.digest)) {
				throw this.#latchCorruption("outbox has no matching issued record");
			}
			result.push({ commit, publishState: row.publishState });
		}
		await transactionResult(transaction);
		this.#assertAvailable();
		return result;
	}

	async #reserveUnsigned(
		scope: DurableIssueScope,
		prior: DurableLineage,
		bytes: Uint8Array,
		context?: Parameters<DurableUnsignedVertexSignAdmission>[2]
	): Promise<NativeIssueReservation> {
		const captured = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: bytes });
		if (captured.sequence !== prior.next) throw issuanceRetirementRefusal("unsigned intent ordinal changed");
		const capturedContext = captureIssuanceNativeSignContext(context);
		const transaction = this.#startTransaction("readwrite"),
			terminal = transactionResult(transaction);
		let inheritedEntered = false;
		try {
			let rows = await browserRetirementRows(transaction, scope.objectId);
			const raw = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([scope.objectId, scope.author]));
			const lineage =
				raw === undefined
					? { next: 0, exhausted: false, prunedThroughAuthorSequence: null }
					: copyNativeLineage(raw, scope);
			if (!lineage) throw issuanceRetirementRefusal("unsigned intent lineage changed");
			const existing = "pendingUnsigned" in lineage ? lineage.pendingUnsigned : undefined;
			inheritedEntered = existing?.phase === "entered";
			if (!durableIssuanceLineagesEqual(lineage, prior))
				throw issuanceRetirementRefusal("unsigned intent lineage changed");
			let control = await browserRetirementControl(transaction, scope.objectId);
			if (capturedContext?.expectedIssuanceImageDigest !== undefined) {
				const image = issuanceRetirementImage(rows, scope.objectId);
				const expectedControl = capturedContext.expectedIssuanceControlBytes;
				if (
					image.imageDigest !== capturedContext.expectedIssuanceImageDigest ||
					(expectedControl === null
						? control !== null
						: control === null ||
							expectedControl === undefined ||
							!issuanceRetirementBytesEqual(encodeIssuanceRetirementControl(control), expectedControl))
				)
					throw issuanceRetirementRefusal("native issuance quote currency changed");
			}
			if (control === null)
				control = {
					kind: "v3-issuance-retirement-control-1",
					objectId: scope.objectId,
					incarnation: issuanceRetirementHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
					revision: 0,
					sequence: 0,
					active: null,
					completed: null,
				};
			const plan =
				capturedContext?.planEffect === undefined ? undefined : rows.plans.find((p) => this.#sameScope(p.scope, scope));
			if (capturedContext?.planEffect !== undefined && plan === undefined)
				throw issuanceRetirementRefusal("unsigned settlement plan is absent");
			const pending = captureIssuancePendingUnsignedIntent(
				{
					kind: "v3-issuance-pending-unsigned-1",
					incarnation: control.incarnation,
					authorSequence: captured.sequence,
					canonicalPreimageBytes: captured.bytes,
					digest: captured.digest,
					phase: existing?.phase ?? "reserved",
					...(plan === undefined
						? {}
						: { planEffect: capturedContext?.planEffect, exactCanonicalPlanBytes: encodeCanonical(plan) }),
				},
				scope
			);
			if (existing !== undefined && !this.#bytesEqual(encodeCanonical(existing), encodeCanonical(pending)))
				throw issuanceRetirementRefusal("another unsigned intent owns the selected ordinal");
			await browserRetirementRow(transaction, scope, prior.next, captured.bytes, captured.digest);
			if (raw === undefined) rows = { ...rows, lineages: [...rows.lineages, { ...scope, ...lineage }] };
			issuanceUnsignedPostimageCharge(rows, scope, pending);
			// A fresh Writer move only: a resumed intent is already durable and is never refused here.
			if (existing === undefined && capturedContext?.settlementReplacementReserve !== undefined)
				issuanceSettlementReplacementReserveCharge(rows, scope, pending, capturedContext.settlementReplacementReserve);
			const pendingRows = {
				...rows,
				lineages: rows.lineages.map((l) => (this.#sameScope(l, scope) ? { ...l, pendingUnsigned: pending } : l)),
			};
			const pendingImage = issuanceRetirementImage(pendingRows, scope.objectId);
			this.#assertAvailable();
			if (existing === undefined) {
				if ((await browserRetirementControl(transaction, scope.objectId)) === null)
					await requestResult(
						transaction
							.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls"))
							.add({ objectId: scope.objectId, record: encodeIssuanceRetirementControl(control) })
					);
				await requestResult(
					// Validation normalizes an absent watermark for arithmetic, not a native rewrite.
					transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).put({
						...(raw === undefined ? { ...scope, ...lineage } : raw),
						pendingUnsigned: pending,
					})
				);
				await browserBumpRetirement(transaction, scope.objectId);
			}
			// This exact post-reserved source is volatile custody for the next
			// writer, not persistent quote authority or a second budget ledger.
			const currency =
				capturedContext?.expectedIssuanceImageDigest === undefined
					? undefined
					: {
							imageDigest: pendingImage.imageDigest,
							controlBytes: encodeIssuanceRetirementControl(
								existing === undefined ? advanceIssuanceRetirementControl(control) : control
							),
						};
			await terminal;
			return { pending, ...(currency === undefined ? {} : { currency }) };
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				/* Original terminal owns outcome. */
			}
			await terminal.catch(() => undefined);
			if (
				inheritedEntered &&
				!this.#hasCode(error, "ISSUANCE_STORE_CLOSED") &&
				!this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT") &&
				!this.#hasCode(error, "ISSUANCE_OUTCOME_UNKNOWN")
			)
				throw new DurableIssuanceUnknownOutcomeError(scope, { cause: error });
			throw error;
		}
	}

	async #beginIssueJob(scope: DurableIssueScope, reservation: NativeIssueReservation): Promise<NativeIssueJob> {
		const { pending } = reservation;
		if (this.#readReservations.view()) throw issuanceRetirementRefusal("join issuance native read view before signing");
		// The entered marker joins durably before crypto. An inherited entered
		// marker never becomes a no-entry cancellation merely because this attempt closes.
		const marker = this.#startTransaction("readwrite"),
			markerTerminal = transactionResult(marker);
		void markerTerminal.catch(() => undefined);
		const entered = captureIssuancePendingUnsignedIntent({ ...pending, phase: "entered" }, scope);
		let transaction: IDBTransaction | undefined;
		let terminal: Promise<void> | undefined;
		let observedTerminal: Promise<void> | undefined;
		let readback: Promise<readonly unknown[]> | undefined;
		let turn: ReturnType<typeof issuanceWriteTurn> | undefined;
		let markerJoined = false;
		let inheritedEntered = pending.phase === "entered";
		try {
			// Queue the original writer BEFORE the entered marker can join. No
			// foreign same-intent signer may interpose between that durable marker
			// and this attempt's native job. Entered debt still never clears from
			// local no-entry knowledge.
			transaction = this.#startTransaction("readwrite");
			terminal = transactionResult(transaction);
			void terminal.catch(() => undefined);
			turn = issuanceWriteTurn(transaction);
			// Born while open, behind this exact writer. Only its committed
			// terminal postimage is read here, never uncommitted RW state as NEW.
			const observation = this.#startTransaction("readonly");
			observedTerminal = transactionResult(observation);
			void observedTerminal.catch(() => undefined);
			const observationJoined = observedTerminal;
			const key = [scope.objectId, scope.author, pending.authorSequence];
			readback = Promise.all([
				requestResult(observation.objectStore(roomStoreName(observation.db, "issuance", "lineages")).get([scope.objectId, scope.author])),
				requestResult(observation.objectStore(roomStoreName(observation.db, "issuance", "issuedRecords")).get(key)),
				requestResult(observation.objectStore(roomStoreName(observation.db, "issuance", "issuanceOutbox")).get(key)),
				requestResult(observation.objectStore(roomStoreName(observation.db, "issuance", "settlementPlans")).get([scope.objectId, scope.author])),
			]).then(
				async (raw) => {
					await observationJoined;
					return raw;
				},
				async (error: unknown) => {
					await observationJoined.catch(() => undefined);
					throw error;
				}
			);
			void readback.catch(() => undefined);
			const raw = await requestResult(marker.objectStore(roomStoreName(marker.db, "issuance", "lineages")).get([scope.objectId, scope.author]));
			const lineage = copyNativeLineage(raw, scope);
			const control = await browserRetirementControl(marker, scope.objectId);
			inheritedEntered ||=
				lineage?.pendingUnsigned?.phase === "entered" ||
				(lineage !== undefined && durableIssuanceLineageConsumed(lineage, pending.authorSequence));
			if (
				!lineage?.pendingUnsigned ||
				!control ||
				control.incarnation !== pending.incarnation ||
				!this.#bytesEqual(encodeCanonical(lineage.pendingUnsigned), encodeCanonical(pending))
			)
				throw issuanceRetirementRefusal("unsigned intent marker changed");
			const markerRows =
				reservation.currency === undefined ? undefined : await browserRetirementRows(marker, scope.objectId);
			if (
				reservation.currency !== undefined &&
				markerRows !== undefined &&
				(issuanceRetirementImage(markerRows, scope.objectId).imageDigest !== reservation.currency.imageDigest ||
					!issuanceRetirementBytesEqual(encodeIssuanceRetirementControl(control), reservation.currency.controlBytes))
			)
				throw issuanceRetirementRefusal("native issuance reserved currency changed");
			await browserRetirementRow(marker, scope, pending.authorSequence, pending.canonicalPreimageBytes, pending.digest);
			this.#assertAvailable();
			if (pending.phase !== "entered") {
				await requestResult(marker.objectStore(roomStoreName(marker.db, "issuance", "lineages")).put({ ...raw, pendingUnsigned: entered }));
				await browserBumpRetirement(marker, scope.objectId);
			}
			const currency =
				markerRows === undefined
					? undefined
					: {
							imageDigest: issuanceRetirementImage(
								{
									...markerRows,
									lineages: markerRows.lineages.map((row) =>
										this.#sameScope(row, scope) ? { ...row, pendingUnsigned: entered } : row
									),
								},
								scope.objectId
							).imageDigest,
							controlBytes: encodeIssuanceRetirementControl(
								pending.phase === "entered" ? control : advanceIssuanceRetirementControl(control)
							),
						};
			await markerTerminal;
			markerJoined = true;
			return {
				transaction,
				terminal,
				readback,
				pending: entered,
				...(currency === undefined ? {} : { currency }),
				turn,
			};
		} catch (error) {
			turn?.stop();
			try {
				marker.abort();
			} catch {
				/* Preserve original terminal. */
			}
			try {
				transaction?.abort();
			} catch {
				/* Preserve original terminal. */
			}
			await markerTerminal.catch(() => undefined);
			await terminal?.catch(() => undefined);
			await readback?.catch(() => undefined);
			await observedTerminal?.catch(() => undefined);
			if (
				(inheritedEntered || markerJoined) &&
				!this.#hasCode(error, "ISSUANCE_STORE_CLOSED") &&
				!this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT") &&
				!this.#hasCode(error, "ISSUANCE_OUTCOME_UNKNOWN")
			)
				throw new DurableIssuanceUnknownOutcomeError(scope, { cause: error });
			throw error;
		}
	}

	async #jobReadback(
		job: NativeIssueJob,
		scope: DurableIssueScope,
		candidate?: DurableIssueCommit,
		expectedPlan?: SettlementPlan
	): Promise<TerminalReadback> {
		const [rawLineage, rawIssued, rawOutbox, rawPlan] = await job.readback;
		const observed = this.#terminalFromRaw(scope, rawLineage, rawIssued, rawOutbox);
		if (candidate?.planEffect !== undefined) {
			const plan = rawPlan === undefined ? null : copyNativeSettlementPlan(rawPlan, scope);
			if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			this.#assertPlanEffectReadback(plan, observed, candidate, expectedPlan);
		}
		return observed;
	}

	async transactIssue(scope: DurableIssueScope, buildAndSign: DurableBuildAndSign): Promise<DurableIssueCommit> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (typeof buildAndSign !== "function") throw invalid("buildAndSign must be a function");
		const detached = copyDurableIssueScope(scope);
		const prior = await this.readLineage(detached);
		if (prior.exhausted) throw createDurableIssuanceFailure("ISSUANCE_EXHAUSTED", "author sequence is exhausted");
		let job: NativeIssueJob | undefined;
		let hookEntered = false;
		let inheritedEntered = false;
		let resolveJoined: (() => void) | undefined;
		let admittedSigning: Promise<Uint8Array> | undefined;
		const enterNativeAdmission: DurableUnsignedVertexSignAdmission = async (bytes, sign, context) => {
			this.#assertAvailable();
			if (typeof sign !== "function") throw invalid("sign must be a function");
			if (this.#readReservations.view())
				throw issuanceRetirementRefusal("join issuance native read view before signing");
			const reservation = await this.#reserveUnsigned(detached, prior, bytes, context);
			inheritedEntered = reservation.pending.phase === "entered";
			const owned = await this.#beginIssueJob(detached, reservation);
			job = owned;
			await owned.turn.run(async () => {
				this.#assertAvailable();
				const raw = await requestResult(
					owned.transaction.objectStore(roomStoreName(owned.transaction.db, "issuance", "lineages")).get([detached.objectId, detached.author])
				);
				const current = copyNativeLineage(raw, detached);
				const control = await browserRetirementControl(owned.transaction, detached.objectId);
				if (
					!control ||
					control.incarnation !== owned.pending.incarnation ||
					!current?.pendingUnsigned ||
					!this.#bytesEqual(encodeCanonical(current.pendingUnsigned), encodeCanonical(owned.pending))
				)
					throw issuanceRetirementRefusal("unsigned native job changed");
				await browserRetirementRow(
					owned.transaction,
					detached,
					prior.next,
					owned.pending.canonicalPreimageBytes,
					owned.pending.digest
				);
				const rows = await browserRetirementRows(owned.transaction, detached.objectId);
				if (
					owned.currency !== undefined &&
					(issuanceRetirementImage(rows, detached.objectId).imageDigest !== owned.currency.imageDigest ||
						!issuanceRetirementBytesEqual(encodeIssuanceRetirementControl(control), owned.currency.controlBytes))
				)
					throw issuanceRetirementRefusal("native issuance entered currency changed");
				issuanceUnsignedPostimageCharge(rows, detached, owned.pending);
			});
			this.#assertAvailable();
			const signature = await sign();
			this.#assertAvailable();
			if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
				throw invalid("native registered signature is malformed");
			return new Uint8Array(signature);
		};
		const nativeAdmission: DurableUnsignedVertexSignAdmission = (bytes, sign, context) => {
			this.#assertAvailable();
			if (hookEntered) throw issuanceRetirementRefusal("issuance native job already entered");
			hookEntered = true;
			const joined = new Promise<void>((resolve) => {
				resolveJoined = resolve;
			});
			void this.#trackRetirement(joined);
			admittedSigning = enterNativeAdmission(bytes, sign, context);
			void admittedSigning.catch(() => undefined);
			return admittedSigning;
		};
		try {
			const built = await buildAndSign(prior.next, nativeAdmission);
			// Even a raw builder that neglects the hook's returned promise cannot
			// detach an entered native signer from its original issue/close owner.
			await admittedSigning;
			const candidate = copyAndValidateDurableIssueCommit(built, detached, prior.next);
			this.#assertAvailable();
			return await this.#commitCandidate(detached, prior, candidate, job);
		} catch (error) {
			await admittedSigning?.catch(() => undefined);
			if (job !== undefined) {
				// A committed entered marker is durable crypto debt even when this
				// attempt did not enter its local callback. Only paired NEW clears it.
				job.turn.stop();
				try {
					job.transaction.abort();
				} catch {
					/* Original terminal owns outcome. */
				}
				await job.terminal.catch(() => undefined);
				await job.readback.catch(() => undefined);
				if (
					job.pending.phase === "entered" &&
					!this.#hasCode(error, "ISSUANCE_OUTCOME_UNKNOWN") &&
					!this.#hasCode(error, "ISSUANCE_STORE_CLOSED") &&
					!this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT")
				)
					throw new DurableIssuanceUnknownOutcomeError(detached, { cause: error });
			}
			if (
				inheritedEntered &&
				!this.#hasCode(error, "ISSUANCE_OUTCOME_UNKNOWN") &&
				!this.#hasCode(error, "ISSUANCE_STORE_CLOSED") &&
				!this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT")
			)
				throw new DurableIssuanceUnknownOutcomeError(detached, { cause: error });
			throw error;
		} finally {
			resolveJoined?.();
		}
	}

	async inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		if (needsNativeReadReservationTurn(this.#database))
			return this.#runReservedRead(() => this.inspectPruningState(detached));
		const transaction = this.#startTransaction("readonly");
		try {
			const raw = await requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([detached.objectId, detached.author]));
			await transactionResult(transaction);
			const lineage =
				raw === undefined
					? { exhausted: false, next: 0, prunedThroughAuthorSequence: null }
					: copyNativeLineage(raw, detached);
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			return createDurableIssuancePruningState(
				detached,
				{ exhausted: lineage.exhausted, next: lineage.next },
				lineage.prunedThroughAuthorSequence
			);
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "pruning-state inspection failed");
		}
	}

	async pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt> {
		return this.#prunePrefix(input, true);
	}

	async prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt> {
		return this.#prunePrefix(input, false);
	}

	async #prunePrefix(input: unknown, authenticatedSettled: boolean): Promise<DurableIssuancePruningReceipt> {
		const captured = captureDurableIssuancePruningInput(input);
		this.#assertAvailable();
		const transaction = this.#startTransaction("readwrite");
		const terminal = transactionResult(transaction);
		try {
			const lineages = transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages"));
			const issuedRecords = transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuedRecords"));
			const issuanceOutbox = transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox"));
			const settlementPlans = transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans"));
			const lineageKey = [captured.scope.objectId, captured.scope.author];
			const rawLineage = await requestResult(lineages.get(lineageKey));
			const current =
				rawLineage === undefined
					? { exhausted: false, next: 0, prunedThroughAuthorSequence: null }
					: copyNativeLineage(rawLineage, captured.scope);
			if (current === undefined) throw this.#latchCorruption("stored lineage is malformed");
			if ("pendingUnsigned" in current) throw issuanceRetirementRefusal("join pending unsigned custody before pruning");
			const lineage = { exhausted: current.exhausted, next: current.next };
			let plan: SettlementPlan | null | undefined;
			if (authenticatedSettled) {
				const rawPlan = await requestResult(settlementPlans.get([captured.scope.objectId, captured.scope.author]));
				plan = rawPlan === undefined ? null : copyNativeSettlementPlan(rawPlan, captured.scope);
				if (rawPlan !== undefined && plan === undefined) {
					throw this.#latchCorruption("stored settlement plan is malformed");
				}
				if (!settlementPlanPermitsAuthenticatedPruning(plan ?? null)) {
					throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement plan is incomplete");
				}
			}
			if (
				captured.expectedPrunedThroughAuthorSequence !== null &&
				(captured.expectedPrunedThroughAuthorSequence > captured.throughAuthorSequence ||
					!durableIssuanceLineageConsumed(captured.expectedLineage, captured.expectedPrunedThroughAuthorSequence))
			) {
				throw invalid("expected pruning state is internally impossible");
			}
			if (
				current.prunedThroughAuthorSequence === captured.throughAuthorSequence &&
				durableIssuanceLineagesEqual(lineage, captured.expectedLineage)
			) {
				await terminal;
				return createDurableIssuancePruningReceipt(captured, lineage, null);
			}
			if (
				current.prunedThroughAuthorSequence !== captured.expectedPrunedThroughAuthorSequence ||
				!durableIssuanceLineagesEqual(lineage, captured.expectedLineage)
			) {
				throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "issuance pruning state changed");
			}
			if (
				(current.prunedThroughAuthorSequence !== null &&
					captured.throughAuthorSequence <= current.prunedThroughAuthorSequence) ||
				!durableIssuanceLineageConsumed(lineage, captured.throughAuthorSequence)
			) {
				throw invalid("selected pruning boundary is invalid");
			}
			const from = current.prunedThroughAuthorSequence === null ? 0 : current.prunedThroughAuthorSequence + 1;
			assertIssuanceRetirementPruningAllowed(
				await browserRetirementControl(transaction, captured.scope.objectId),
				captured.scope,
				from,
				captured.throughAuthorSequence
			);
			assertIssuanceInheritedTargetPruningAllowed(
				(await browserRetirementRows(transaction, captured.scope.objectId)).plans,
				captured.scope,
				from,
				captured.throughAuthorSequence
			);
			if (!authenticatedSettled) {
				const rawPlan = await requestResult(settlementPlans.get([captured.scope.objectId, captured.scope.author]));
				plan = rawPlan === undefined ? null : copyNativeSettlementPlan(rawPlan, captured.scope);
				if (rawPlan !== undefined && plan === undefined) {
					throw this.#latchCorruption("stored settlement plan is malformed");
				}
			}
			if (
				!authenticatedSettled &&
				plan?.entries.some(
					(entry) =>
						entry.replacementSequence === null &&
						entry.sourceSequence >= from &&
						entry.sourceSequence <= captured.throughAuthorSequence
				)
			) {
				throw createDurableIssuanceFailure(
					"ISSUANCE_RETRY_REQUIRED",
					"settlement plan still references the selected prefix"
				);
			}
			for (let pageFrom = from; pageFrom <= captured.throughAuthorSequence; pageFrom += 64) {
				const pageThrough = Math.min(captured.throughAuthorSequence, pageFrom + 63);
				for (let authorSequence = pageFrom; authorSequence <= pageThrough; authorSequence += 1) {
					const key = [captured.scope.objectId, captured.scope.author, authorSequence];
					const rawIssued = await requestResult(issuedRecords.get(key));
					const rawOutbox = await requestResult(issuanceOutbox.get(key));
					const issued = rawIssued === undefined ? undefined : copyNativeIssued(rawIssued);
					const outbox = rawOutbox === undefined ? undefined : copyNativeOutbox(rawOutbox);
					if (
						issued === undefined ||
						outbox === undefined ||
						issued.authorSequence !== authorSequence ||
						outbox.authorSequence !== authorSequence ||
						!this.#bytesEqual(issued.digest, outbox.digest)
					) {
						throw this.#latchCorruption("selected issuance prefix is incomplete or malformed");
					}
					const decoded = decodeDurableIssuancePreimage(issued.canonicalPreimageBytes, captured.scope, authorSequence);
					if (decoded === undefined) throw this.#latchCorruption("selected issuance preimage is malformed");
					if (
						(authenticatedSettled && decoded.epoch > captured.closedEpoch) ||
						(!authenticatedSettled && decoded.epoch !== captured.closedEpoch)
					) {
						throw invalid("selected issuance row belongs to another epoch");
					}
					if (!authenticatedSettled && outbox.publishState === "pending") {
						throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "selected issuance prefix is not published");
					}
				}
			}
			for (let authorSequence = from; authorSequence <= captured.throughAuthorSequence; authorSequence += 1) {
				const key = [captured.scope.objectId, captured.scope.author, authorSequence];
				await requestResult(issuedRecords.delete(key));
				await requestResult(issuanceOutbox.delete(key));
			}
			const writtenKey = await requestResult(
				lineages.put({
					...captured.scope,
					exhausted: lineage.exhausted,
					next: lineage.next,
					prunedThroughAuthorSequence: captured.throughAuthorSequence,
				})
			);
			if (
				!Array.isArray(writtenKey) ||
				writtenKey[0] !== captured.scope.objectId ||
				writtenKey[1] !== captured.scope.author
			) {
				throw this.#latchCorruption("watermark put returned an impossible key");
			}
			await browserBumpRetirement(transaction, captured.scope.objectId);
			await terminal;
			return createDurableIssuancePruningReceipt(captured, lineage, from);
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// The transaction may already be terminal.
			}
			await terminal.catch(() => undefined);
			if (
				error instanceof DurableIssuanceContractError ||
				error instanceof DurableIssuanceInvalidArgumentError ||
				error instanceof DurableIssuanceRecordPrunedError
			) {
				throw error;
			}
			if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
			throw mapSubstrateError(error, "issuance pruning failed");
		}
	}

	async terminalObservationForTest(scope: DurableIssueScope, authorSequence: number): Promise<TerminalReadback> {
		return this.#readTerminal(scope, authorSequence);
	}

	async #commitCandidate(
		scope: DurableIssueScope,
		prior: DurableLineage,
		candidate: DurableIssueCommit,
		job?: NativeIssueJob
	): Promise<DurableIssueCommit> {
		let transaction: IDBTransaction;
		try {
			transaction = job?.transaction ?? this.#startTransaction("readwrite");
		} catch (error) {
			this.#assertAvailable();
			throw error;
		}
		let reason: Error | undefined;
		let expectedPlan: SettlementPlan | undefined;
		const terminal = job?.terminal ?? transactionResult(transaction);
		try {
			const write = async (): Promise<void> => {
				const lineages = transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages"));
				const issued = transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuedRecords"));
				const outbox = transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox"));
				const plans = transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans"));
				const rawPrior = await requestResult(lineages.get([scope.objectId, scope.author]));
				const current =
					rawPrior === undefined
						? { exhausted: false, next: 0, prunedThroughAuthorSequence: null }
						: copyNativeLineage(rawPrior, scope);
				if (current === undefined) {
					reason = this.#latchCorruption("stored lineage is malformed");
					transaction.abort();
				} else if (!durableIssuanceLineagesEqual(current, prior)) {
					reason = createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "author sequence changed while signing");
					transaction.abort();
				} else {
					if (this.#closed) {
						reason = createDurableIssuanceFailure("ISSUANCE_STORE_CLOSED", "durable issuance store is closed");
						transaction.abort();
						throw reason;
					}
					if (
						job === undefined
							? "pendingUnsigned" in current
							: !("pendingUnsigned" in current) ||
								!this.#bytesEqual(encodeCanonical(current.pendingUnsigned), encodeCanonical(job.pending)) ||
								!this.#bytesEqual(candidate.envelope.canonicalPreimageBytes, job.pending.canonicalPreimageBytes) ||
								!this.#bytesEqual(candidate.envelope.digest, job.pending.digest) ||
								!this.#bytesEqual(
									encodeCanonical(candidate.planEffect ?? null),
									encodeCanonical(job.pending.planEffect ?? null)
								)
					) {
						reason = issuanceRetirementRefusal("issued candidate does not own the exact unsigned intent");
						transaction.abort();
						throw reason;
					}
					try {
						await browserRetirementRow(
							transaction,
							scope,
							candidate.authorSequence,
							candidate.envelope.canonicalPreimageBytes,
							candidate.envelope.digest
						);
					} catch (error) {
						reason = error instanceof Error ? error : issuanceRetirementRefusal("issued epoch is retired");
						transaction.abort();
						throw reason;
					}
					let updatedPlan: SettlementPlan | undefined;
					if (candidate.planEffect !== undefined) {
						const rawPlan = await requestResult(plans.get([scope.objectId, scope.author]));
						if (rawPlan === undefined) {
							reason = createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement plan is absent");
							transaction.abort();
						} else {
							const plan = copyNativeSettlementPlan(rawPlan, scope);
							if (plan === undefined) {
								reason = this.#latchCorruption("stored settlement plan is malformed");
								transaction.abort();
							} else {
								try {
									updatedPlan = applySettlementPlanEffect(
										plan,
										candidate.planEffect,
										candidate.authorSequence,
										settlementReplacementLastLogicalTime(candidate)
									);
									expectedPlan = updatedPlan;
								} catch (error) {
									reason = error instanceof Error ? error : invalid("settlement plan effect failed");
									transaction.abort();
								}
							}
						}
						if (reason !== undefined) {
							await terminal;
							throw reason;
						}
					}
					const next = {
						...scope,
						exhausted: prior.next === Number.MAX_SAFE_INTEGER,
						next: prior.next === Number.MAX_SAFE_INTEGER ? prior.next : prior.next + 1,
						...(current.prunedThroughAuthorSequence === null
							? {}
							: { prunedThroughAuthorSequence: current.prunedThroughAuthorSequence }),
					};
					await requestResult(rawPrior === undefined ? lineages.add(next) : lineages.put(next));
					await requestResult(issued.add(nativeIssued(candidate)));
					await requestResult(outbox.add(nativeOutbox(candidate)));
					if (updatedPlan !== undefined) await requestResult(plans.put(nativeSettlementPlan(updatedPlan)));
					if (updatedPlan !== undefined) {
						try {
							const retired = await browserRetirementControl(transaction, scope.objectId);
							if (retired)
								assertIssuanceRetirementPlanAllowed(
									retired,
									updatedPlan,
									await browserRetirementRows(transaction, scope.objectId)
								);
						} catch (error) {
							reason = error instanceof Error ? error : issuanceRetirementRefusal("settlement plan effect refused");
							transaction.abort();
							throw reason;
						}
					}
					await browserBumpRetirement(transaction, scope.objectId);
				}
			};
			if (job === undefined) await write();
			else await job.turn.run(write);
			job?.turn.stop();
			await terminal;
			if (reason !== undefined) throw reason;
			const observation =
				job === undefined
					? await this.#readTerminal(scope, candidate.authorSequence, candidate, expectedPlan)
					: await this.#jobReadback(job, scope, candidate, expectedPlan);
			const committed = classifyDurableIssuanceTerminalSuppression({
				candidate,
				observation,
				priorLineage: prior,
				scope,
			});
			return committed;
		} catch (error) {
			if (job !== undefined) {
				job.turn.stop();
				try {
					transaction.abort();
				} catch {
					/* Original terminal owns outcome. */
				}
			}
			await terminal.catch(() => undefined);
			if (reason !== undefined) throw reason;
			if (this.#poison !== undefined) throw this.#poison;
			let observation: TerminalReadback;
			try {
				observation =
					job === undefined
						? await this.#readTerminal(scope, candidate.authorSequence, candidate, expectedPlan)
						: await this.#jobReadback(job, scope, candidate, expectedPlan);
			} catch {
				if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
				return classifyDurableIssuanceTerminalSuppression({
					candidate,
					observation: { unreadable: true },
					priorLineage: prior,
					scope,
				});
			}
			try {
				const committed = classifyDurableIssuanceTerminalSuppression({
					candidate,
					observation,
					priorLineage: prior,
					scope,
				});
				return committed;
			} catch (classified) {
				if (this.#hasCode(classified, "ISSUANCE_RECOVERY_CORRUPT")) {
					throw this.#latchCorruption("terminal issuance readback is corrupt");
				}
				if (job?.pending.phase === "entered") throw new DurableIssuanceUnknownOutcomeError(scope, { cause: error });
				throw classified;
			}
		}
	}

	#assertPlanEffectReadback(
		plan: SettlementPlan | null,
		observation: TerminalReadback,
		candidate: DurableIssueCommit,
		expectedPlan?: SettlementPlan
	): void {
		const effect = candidate.planEffect;
		if (effect === undefined) return;
		const linked = settlementPlanHasExactEffectLink(plan, effect, candidate.authorSequence);
		if ((observation.issuedRecord !== null) !== linked) {
			throw this.#latchCorruption("issued row and settlement plan link are inconsistent");
		}
		if (
			linked &&
			(plan === null ||
				expectedPlan === undefined ||
				JSON.stringify(cloneSettlementPlan(plan)) !== JSON.stringify(cloneSettlementPlan(expectedPlan)))
		) {
			throw this.#latchCorruption("settlement plan differs from the committed revision and exact effect");
		}
	}

	async #readTerminal(
		scope: DurableIssueScope,
		authorSequence: number,
		candidate?: DurableIssueCommit,
		expectedPlan?: SettlementPlan
	): Promise<TerminalReadback> {
		if (needsNativeReadReservationTurn(this.#database))
			return this.#runReservedRead(() => this.#readTerminal(scope, authorSequence, candidate, expectedPlan));
		const transaction = this.#startTransaction("readonly");
		const key = [scope.objectId, scope.author, authorSequence];
		const [rawLineage, rawIssued, rawOutbox, rawPlan] = await Promise.all([
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "lineages")).get([scope.objectId, scope.author])),
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuedRecords")).get(key)),
			requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "issuanceOutbox")).get(key)),
			candidate?.planEffect === undefined
				? Promise.resolve(undefined)
				: requestResult(transaction.objectStore(roomStoreName(transaction.db, "issuance", "settlementPlans")).get([scope.objectId, scope.author])),
		]);
		await transactionResult(transaction);
		const observation = this.#terminalFromRaw(scope, rawLineage, rawIssued, rawOutbox);
		if (candidate?.planEffect !== undefined) {
			const plan = rawPlan === undefined ? null : copyNativeSettlementPlan(rawPlan, scope);
			if (plan === undefined) {
				throw this.#latchCorruption("stored settlement plan is malformed");
			}
			this.#assertPlanEffectReadback(plan, observation, candidate, expectedPlan);
		}
		return observation;
	}

	#terminalFromRaw(
		scope: DurableIssueScope,
		rawLineage: unknown,
		rawIssued: unknown,
		rawOutbox: unknown
	): TerminalReadback {
		const lineage =
			rawLineage === undefined
				? { exhausted: false, next: 0, prunedThroughAuthorSequence: null }
				: copyNativeLineage(rawLineage, scope);
		const issued = rawIssued === undefined ? null : copyNativeIssued(rawIssued);
		const outbox = rawOutbox === undefined ? null : copyNativeOutbox(rawOutbox);
		if (lineage === undefined || issued === undefined || outbox === undefined) {
			throw this.#latchCorruption("terminal readback contains a malformed row");
		}
		return {
			issuedRecord:
				issued === null
					? null
					: {
							authorSequence: issued.authorSequence,
							envelope: {
								canonicalPreimageBytes: issued.canonicalPreimageBytes,
								digest: issued.digest,
								signature: issued.signature,
							},
							scope: { author: issued.author, objectId: issued.objectId },
						},
			lineage: { exhausted: lineage.exhausted, next: lineage.next },
			outboxRecord:
				outbox === null
					? null
					: {
							authorSequence: outbox.authorSequence,
							digest: outbox.digest,
							publishState: outbox.publishState,
							scope: { author: outbox.author, objectId: outbox.objectId },
						},
			prunedThroughAuthorSequence: lineage.prunedThroughAuthorSequence,
		};
	}

	#capturePublicationInput(input: DurableOutboxPublicationTransitionInput): DurableOutboxPublicationTransitionInput {
		try {
			if (!isClosedDurableIssuanceRecord(input, ["authorSequence", "digest", "scope"])) {
				throw invalid("publication input must be an exact own-data record");
			}
			assertDurableIssueScope(input.scope);
			const scope = copyDurableIssueScope(input.scope);
			if (!isValidDurableAuthorSequence(input.authorSequence)) {
				throw invalid("publication input contains an invalid ordinal");
			}
			const digest = copyDurableIssuanceBytes(input.digest);
			if (digest === undefined) throw invalid("publication input contains an invalid digest");
			return { authorSequence: input.authorSequence, digest, scope };
		} catch (error) {
			if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
			throw invalid("publication input could not be inspected as a closed record");
		}
	}

	#sameNativeRecordKey(value: IDBValidKey, scope: DurableIssueScope, authorSequence: number): boolean {
		return (
			Array.isArray(value) &&
			value.length === 3 &&
			value[0] === scope.objectId &&
			value[1] === scope.author &&
			value[2] === authorSequence
		);
	}

	#sameNativePlanKey(value: IDBValidKey, scope: DurableIssueScope): boolean {
		return Array.isArray(value) && value.length === 2 && value[0] === scope.objectId && value[1] === scope.author;
	}

	#publicationStatus(
		observation: TerminalReadback,
		input: DurableOutboxPublicationTransitionInput
	): "corrupt" | "foreign-digest" | "never-issued" | "pending" | "pruned" | "published" {
		const { issuedRecord, lineage, outboxRecord, prunedThroughAuthorSequence } = observation;
		const consumed = durableIssuanceLineageConsumed(lineage, input.authorSequence);
		if (issuedRecord === null && outboxRecord === null && !consumed) return "never-issued";
		if (
			issuedRecord === null &&
			outboxRecord === null &&
			consumed &&
			durableIssuanceAddressIsPruned(prunedThroughAuthorSequence, input.authorSequence)
		) {
			return "pruned";
		}
		if (issuedRecord === null || outboxRecord === null || !consumed) return "corrupt";
		if (durableIssuanceAddressIsPruned(prunedThroughAuthorSequence, input.authorSequence)) return "corrupt";
		if (
			issuedRecord.authorSequence !== input.authorSequence ||
			outboxRecord.authorSequence !== input.authorSequence ||
			!this.#sameScope(issuedRecord.scope, input.scope) ||
			!this.#sameScope(outboxRecord.scope, input.scope) ||
			!this.#bytesEqual(issuedRecord.envelope.digest, outboxRecord.digest) ||
			!durablePreimageMatchesScopeAndSequence(
				issuedRecord.envelope.canonicalPreimageBytes,
				input.scope,
				input.authorSequence
			)
		) {
			return "corrupt";
		}
		if (!this.#bytesEqual(issuedRecord.envelope.digest, input.digest)) return "foreign-digest";
		return outboxRecord.publishState;
	}

	async #classifyPublicationReadback(
		input: DurableOutboxPublicationTransitionInput,
		commit: "ambiguous" | "success"
	): Promise<void> {
		this.#assertAvailable();
		let observation: TerminalReadback;
		try {
			observation = await this.#readTerminal(input.scope, input.authorSequence);
		} catch (error) {
			if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
			if (error instanceof DurableIssuanceContractError) throw error;
			throw new DurableIssuanceUnknownOutcomeError(input.scope);
		}
		this.#assertAvailable();
		const status = this.#publicationStatus(observation, input);
		if (status === "published") return;
		if (status === "pruned") throw createDurableIssuanceRecordPrunedError(input.scope, input.authorSequence);
		if (status === "pending" && commit === "ambiguous") {
			throw substrate("publication commit did not become durable", "transient");
		}
		throw this.#latchCorruption("publication terminal readback is incomplete or malformed");
	}

	async #runReservedRead<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await runNativeReservedRead(this.#database, operation);
		} catch (error) {
			this.#assertAvailable();
			if (error instanceof DurableIssuanceContractError || error instanceof DurableIssuanceInvalidArgumentError)
				throw error;
			throw mapSubstrateError(error, "reserved issuance read failed");
		}
	}

	#startTransaction(mode: IDBTransactionMode): IDBTransaction {
		this.#assertAvailable();
		const transaction =
			mode === "readonly"
				? nativeReadonlyTransaction(this.#database, roomStoreNames(this.#database, "issuance", STORE_NAMES))
				: strictTransaction(this.#database, mode);
		if (isNativeReadReservationTransaction(transaction)) return transaction;
		this.#transactions.add(transaction);
		const settled = (): void => {
			this.#transactions.delete(transaction);
			this.#finishCloseIfIdle();
		};
		transaction.addEventListener("complete", settled, { once: true });
		transaction.addEventListener("abort", settled, { once: true });
		return transaction;
	}

	#finishCloseIfIdle(): void {
		if (this.#closed && this.#transactions.size === 0) this.#resolveClose?.();
	}

	#assertAvailable(): void {
		if (this.#poison !== undefined) throw this.#poison;
		if (this.#closed) throw createDurableIssuanceFailure("ISSUANCE_STORE_CLOSED", "durable issuance store is closed");
	}

	#latchCorruption(message: string): DurableIssuanceContractError {
		this.#poison ??= Object.freeze(createDurableIssuanceFailure("ISSUANCE_RECOVERY_CORRUPT", message));
		return this.#poison;
	}

	#parsePageInput(input: DurableOutboxPageInput): ParsedOutboxPage {
		if (!this.#closedPageInput(input)) throw invalid("page input must be a closed record");
		if (input.scope !== undefined) assertDurableIssueScope(input.scope);
		const limit = input.limit === undefined ? DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT : input.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT) {
			throw invalid("page limit is outside the closed range");
		}
		const afterKey = input.afterKey ?? null;
		if (
			afterKey !== null &&
			(!Array.isArray(afterKey) ||
				afterKey.length !== 3 ||
				!isValidDurableScopeField(afterKey[0]) ||
				!isValidDurableScopeField(afterKey[1]) ||
				!isValidDurableAuthorSequence(afterKey[2]))
		) {
			throw invalid("afterKey must be a valid compound key");
		}
		return {
			afterKey: afterKey as readonly [string, string, number] | null,
			limit,
			...(input.scope === undefined ? {} : { scope: copyDurableIssueScope(input.scope) }),
		};
	}

	#closedPageInput(value: unknown): value is DurableOutboxPageInput {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const allowed = ["afterKey", "limit", "scope"];
		return Reflect.ownKeys(value).every((key) => {
			if (typeof key !== "string" || !allowed.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		});
	}

	#issuedKey(issued: DurableIssueScope & { readonly authorSequence: number }): readonly [string, string, number] {
		return [issued.objectId, issued.author, issued.authorSequence];
	}

	#sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
		return left.author === right.author && left.objectId === right.objectId;
	}

	#bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	#hasCode(error: unknown, code: string): boolean {
		return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
	}

	#isClosedFailure(error: unknown): boolean {
		return error === this.#poison || this.#hasCode(error, "ISSUANCE_STORE_CLOSED");
	}
}

const implementationByStore = new WeakMap<DurableIssuanceStore, BrowserIssuanceImplementation>();
// The pruning maintenance capability each genuine facade minted (slice 14a): a node may
// hold only a facade it re-bound to that same capability, never the original facade.
const implementationByMaintenance = new WeakMap<object, BrowserIssuanceImplementation>();

async function openIssuanceDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let upgraded = false;
		let settled = false;
		let request: IDBOpenDBRequest;
		try {
			request = globalThis.indexedDB.open(name, DATABASE_VERSION);
		} catch (error) {
			reject(mapOpenError(error));
			return;
		}
		request.addEventListener("upgradeneeded", (event) => {
			try {
				if (event.oldVersion === 0 && request.result.objectStoreNames.length === 0) {
					request.result.createObjectStore("lineages", { autoIncrement: false, keyPath: [...LINEAGE_KEY_PATH] });
					request.result.createObjectStore("issuedRecords", { autoIncrement: false, keyPath: [...RECORD_KEY_PATH] });
					request.result.createObjectStore("issuanceOutbox", { autoIncrement: false, keyPath: [...RECORD_KEY_PATH] });
				} else if (
					(event.oldVersion !== 1 && event.oldVersion !== 2) ||
					request.result.objectStoreNames.length !== (event.oldVersion === 1 ? 3 : 4) ||
					!["issuanceOutbox", "issuedRecords", "lineages"].every((name) =>
						request.result.objectStoreNames.contains(name)
					)
				) {
					throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database cannot be upgraded");
				}
				if (event.oldVersion === 1 || event.oldVersion === 2) {
					const transaction = request.transaction;
					if (transaction === null) {
						throw createDurableIssuanceFailure(
							"ISSUANCE_UNSUPPORTED_SCHEMA",
							"issuance database migration transaction is absent"
						);
					}
					verifyStore(transaction.objectStore("lineages"), LINEAGE_KEY_PATH);
					verifyStore(transaction.objectStore("issuedRecords"), RECORD_KEY_PATH);
					verifyStore(transaction.objectStore("issuanceOutbox"), RECORD_KEY_PATH);
					if (event.oldVersion === 2) verifyStore(transaction.objectStore("settlementPlans"), LINEAGE_KEY_PATH);
				}
				upgraded = true;
				if (event.oldVersion !== 2)
					request.result.createObjectStore("settlementPlans", { autoIncrement: false, keyPath: [...LINEAGE_KEY_PATH] });
				request.result.createObjectStore("retirementControls", { autoIncrement: false, keyPath: "objectId" });
			} catch (error) {
				request.transaction?.abort();
				if (!settled) {
					settled = true;
					reject(error);
				}
			}
		});
		request.addEventListener("blocked", () => {
			if (!settled) {
				settled = true;
				reject(substrate("issuance database open was blocked", "transient"));
			}
		});
		request.addEventListener("error", () => {
			if (!settled) {
				settled = true;
				reject(mapOpenError(request.error));
			}
		});
		request.addEventListener("success", () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			if (request.result.version !== DATABASE_VERSION || !exactStoreNames(request.result)) {
				request.result.close();
				reject(createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database shape is unsupported"));
				return;
			}
			void upgraded;
			resolve(request.result);
		});
	});
}

async function admitDatabase(database: IDBDatabase): Promise<void> {
	let transaction: IDBTransaction | undefined;
	try {
		transaction = strictTransaction(database, "readwrite");
		verifyStore(transaction.objectStore("lineages"), LINEAGE_KEY_PATH);
		verifyStore(transaction.objectStore("issuedRecords"), RECORD_KEY_PATH);
		verifyStore(transaction.objectStore("issuanceOutbox"), RECORD_KEY_PATH);
		verifyStore(transaction.objectStore("settlementPlans"), LINEAGE_KEY_PATH);
		const controls = transaction.objectStore("retirementControls");
		if (controls.keyPath !== "objectId" || controls.autoIncrement || controls.indexNames.length !== 0)
			throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance retirement schema unsupported");
		await transactionResult(transaction);
	} catch (error) {
		try {
			transaction?.abort();
		} catch {
			// The admission transaction may already be terminal.
		}
		if (error instanceof DurableIssuanceContractError) throw error;
		throw mapSubstrateError(error, "issuance database admission failed");
	}
}

/**
 * Creates one strict-durability browser issuance capability over a dedicated derived IndexedDB database.
 * @param options - Untrusted exact browser factory options.
 * @returns The eight-method shared issuance capability.
 */
export async function createBrowserDurableIssuanceStoreImplementation(
	options: unknown
): Promise<DurableIssuanceStore & NativeReadReservationPort> {
	const primaryDatabaseName = captureOptions(options);
	const database = await openIssuanceDatabase(`${primaryDatabaseName}${DATABASE_SUFFIX}`);
	return createIssuanceStoreOver(database, admitDatabase);
}

/**
 * Creates the issuance capability inside a ready version-7 room database (slice 14a).
 * Every operation, row format and refusal is the dedicated store's; only its stores
 * live in the `issuance:` namespace and its held read views cover only that namespace.
 * It never creates or upgrades the room database.
 * @param options - Untrusted exact options naming the room database.
 * @returns The eight-method shared issuance capability.
 */
export async function createBrowserRoomDurableIssuanceStoreImplementation(
	options: unknown
): Promise<DurableIssuanceStore & NativeReadReservationPort> {
	const databaseName = captureRoomOptions(options);
	let database: IDBDatabase;
	try {
		database = await openBrowserRoomOwnerConnection(databaseName, "issuance");
	} catch {
		throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance room database is unsupported");
	}
	// The room connection already checked the exact issuance namespace catalog; admission
	// keeps only the strict read-write durability check of the dedicated database.
	const store = await createIssuanceStoreOver(database, async (admitted) => {
		const transaction = strictTransaction(admitted, "readwrite");
		await transactionResult(transaction);
	});
	const implementation = implementationByStore.get(store);
	if (implementation !== undefined) roomIssuanceDatabases.set(implementation, databaseName);
	return store;
}

// Genuine room-mode issuance owners, with their room database name.
const roomIssuanceDatabases = new WeakMap<BrowserIssuanceImplementation, string>();

/**
 * Slice 14a: the issuance retirement acquisition of one genuine room-mode issuance
 * store inside a room retirement session of its own database.
 * @param store - Candidate issuance facade.
 * @param databaseName - The session's room database.
 * @param session - The open room retirement session.
 * @param input - Exact addressed object.
 * @returns The original retirement read, its transitions bound to the session.
 */
export function acquireBrowserRoomIssuanceStoreRetirement(
	store: unknown,
	databaseName: string,
	session: RoomRetirementSession,
	input: { readonly objectId: string }
): Promise<DurableIssuanceRetirementControlRead> {
	// The owner is named by its genuine facade or by the pruning maintenance capability
	// that facade minted; either resolves to the one native owner it belongs to.
	const owner =
		typeof store === "object" && store !== null
			? (implementationByStore.get(store as DurableIssuanceStore) ?? implementationByMaintenance.get(store))
			: undefined;
	const implementation = owner !== undefined && roomIssuanceDatabases.get(owner) === databaseName ? owner : undefined;
	if (implementation === undefined) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return implementation.acquireRetirementControlInSession(session, input);
}

/**
 * Slices 14a/14b step B: the issuance owner's retention section (role 16: nothing is
 * deleted). Inside the acting room transaction it reads the control and the original
 * bounded row census of the object, charges both, and rechecks the original preparation
 * row law for the planner's protected records. Ordinary issuance mutations advance the
 * control's revision by one and nothing else, so the decision's base is the control
 * without that counter; the target is composed in the acting transaction from the
 * control actually read, through the original prepare and commit transitions.
 * @param databaseName - The session's room database.
 * @param store - A genuine room-mode issuance store (or its maintenance capability) of
 * this database, when the caller holds one.
 * @returns The section.
 */
export function browserRoomIssuanceRetentionSection(databaseName: string, store?: unknown): RoomRetentionSection {
	if (store !== undefined) {
		const owner =
			typeof store === "object" && store !== null
				? (implementationByStore.get(store as DurableIssuanceStore) ?? implementationByMaintenance.get(store))
				: undefined;
		if (owner === undefined || roomIssuanceDatabases.get(owner) !== databaseName)
			throw new TypeError("RETENTION_FOREIGN_OWNER");
	}
	return Object.freeze<RoomRetentionSection>({
		owner: "issuance" as const,
		prepare: ({ session, selection, book }) =>
			session.run(async (transaction) => {
				const objectId = selection.objectId,
					through = selection.throughEpoch,
					chosen = selection.issuance;
				const raw: unknown = await requestResult(
					transaction.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls")).get(objectId)
				);
				if (raw === undefined) return retentionStale("issuance:control-absent");
				chargeRetentionRow(book, "issuance", "retirementControls", objectId, raw);
				let control: DurableIssuanceRetirementControl | null;
				let rows: IssuanceRetirementRows;
				let image: ReturnType<typeof issuanceRetirementImage>;
				try {
					control = await browserRetirementControl(transaction, objectId);
					rows = await browserRetirementRows(transaction, objectId);
					image = issuanceRetirementImage(rows, objectId);
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : "";
					if (message.includes("exceeds bound"))
						throw new RoomRetentionRefusal("RETENTION_CAPACITY", "issuance:census");
					throw new RoomRetentionRefusal("RETENTION_CORRUPT", "issuance:census");
				}
				if (control === null) return retentionStale("issuance:control-absent");
				if (control.active !== null) retentionStale("issuance:active");
				for (const row of [...rows.lineages, ...rows.issued, ...rows.outbox, ...rows.plans])
					book.charge(
						"issuance",
						encodeCanonical(row, {
							maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
							maxDepth: 16,
							maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32,
						}).byteLength
					);
				const protectedRecords = chosen.protectedRecords.map((record) => ({ ...record }));
				// Rule H: the selection's floor (present exactly when it selected under control-2).
				const floorEpoch = chosen.floorEpoch;
				const preparation = (labels: Readonly<{ decisionDigest: string; sourceProofDigest: string }>) =>
					issuanceRetirementPreparationWithPlanRewrite(control, captureIssuanceRetirementPreparation({
						decisionDigest: labels.decisionDigest,
						sourceProofDigest: labels.sourceProofDigest,
						throughEpoch: through,
						...(floorEpoch === undefined ? {} : { floorEpoch }),
						protectedRecords,
					}), rows);
				const current = control;
				const probe = preparation({ decisionDigest: "0".repeat(64), sourceProofDigest: "0".repeat(64) });
				// The original preparation row law, label-independent, before anything is written.
				try {
					if (current.completed !== null && (probe.throughEpoch < current.completed.throughEpoch ||
						issuanceRetirementFloor(probe) < issuanceRetirementFloor(current.completed)))
						return retentionStale("issuance:advance");
					assertIssuanceRetirementPreparationRows(current, probe, rows);
				} catch (cause) {
					if (cause instanceof RoomRetentionRefusal) throw cause;
					return retentionStale(`issuance:rows:${cause instanceof Error ? cause.message : ""}`);
				}
				const targetRows = issuanceRetirementCommitRows(current, probe, rows);
				book.charge("issuance", encodeCanonical(probe).byteLength);
				const rewrites = Object.freeze(rows.plans.flatMap((before, index) => {
					const after = targetRows.plans[index]!;
					if (after === before) return [];
					const key = [objectId, after.scope.author], value = nativeSettlementPlan(after);
					chargeRetentionRow(book, "issuance", "settlementPlans", key, value);
					return [Object.freeze({store: "settlementPlans", key,
						before: retentionValueDigest("settlementPlans", key, nativeSettlementPlan(before)),
						after: retentionValueDigest("settlementPlans", key, value), value})];
				}));
				const { revision: _revision, ...state } = current;
				let planBefore: Uint8Array | null | undefined;
				const section: RoomRetentionSectionDraft = Object.freeze({
					owner: "issuance" as const,
					// Ordinary mutations advance only the revision counter: the base is the rest.
					base: retentionValueDigest("retirementControls", objectId, state),
					control: roomRetentionControlDigest(encodeIssuanceRetirementControl(current)),
					through,
					deletes: Object.freeze([]),
					rewrites,
					compose: async (labels: RoomRetentionLabels) => {
						let committed: DurableIssuanceRetirementControl;
						try {
							const prepared = await createIssuanceRetirementControlRead(current, image, async (next) => next).prepareFence(
								preparation(labels)
							);
							committed = await createIssuanceRetirementControlRead(prepared, image, async (next) => next).commitPrepared();
							planBefore = issuanceRetirementTransitionPlanBefore(prepared, committed, rows);
						} catch {
							return retentionStale("issuance:transition");
						}
						const value = { objectId, record: encodeIssuanceRetirementControl(committed) };
						chargeRetentionRow(book, "issuance", "retirementControls", objectId, value);
						return Object.freeze({
							value,
							digest: retentionValueDigest("retirementControls", objectId, value),
							control: roomRetentionControlDigest(value.record),
						});
					},
					write: (target: RoomRetentionTarget, writeBook: RoomRetentionProofBook) =>
						session.run(async (writer) => {
							for (const row of rewrites) {
								writeBook.write({ kind: "rewrite", owner: "issuance", store: "settlementPlans" });
								await requestResult(writer.objectStore(roomStoreName(writer.db, "issuance", "settlementPlans")).put(row.value));
							}
							writeBook.write({ kind: "control", owner: "issuance" });
							const controls = writer.objectStore(roomStoreName(writer.db, "issuance", "retirementControls"));
							// Rule A: the committed preparation's BEFORE images (or none) in the same transaction.
							if (planBefore === null) await requestResult(controls.delete(browserRetirementPlanBeforeKey(objectId)));
							else if (planBefore !== undefined)
								await requestResult(controls.put({ objectId: browserRetirementPlanBeforeKey(objectId), record: planBefore }));
							await requestResult(controls.put(target.value));
						}),
				});
				return section;
			}),
	});
}

function captureRoomOptions(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("options must be a plain record");
	const keys = Reflect.ownKeys(value);
	const descriptor = Object.getOwnPropertyDescriptor(value, "databaseName");
	if (
		keys.length !== 1 ||
		keys[0] !== "databaseName" ||
		descriptor === undefined ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "string" ||
		descriptor.value.length === 0
	)
		throw invalid("options must contain only databaseName");
	return descriptor.value;
}

async function createIssuanceStoreOver(
	database: IDBDatabase,
	admit: (database: IDBDatabase) => Promise<void>
): Promise<DurableIssuanceStore & NativeReadReservationPort> {
	const implementation = new BrowserIssuanceImplementation(database);
	database.onversionchange = (): void => implementation.versionchange();
	try {
		await admit(database);
		const store = Object.freeze(Object.assign(Object.create(null) as DurableIssuanceStore & NativeReadReservationPort, {
			acquireNativeReadReservation: (input: { readonly objectId: string }) =>
				implementation.acquireNativeReadReservation(input),
			close: (): Promise<void> => implementation.close(),
			compareAndMarkOutboxPublished: (input: DurableOutboxPublicationTransitionInput) =>
				implementation.compareAndMarkOutboxPublished(input),
			readIssued: (scope: DurableIssueScope, authorSequence: number) =>
				implementation.readIssued(scope, authorSequence),
			readLineage: (scope: DurableIssueScope) => implementation.readLineage(scope),
			readOutboxPage: (input?: DurableOutboxPageInput) => implementation.readOutboxPage(input),
			readSettlementPlan: (scope: DurableIssueScope) => implementation.readSettlementPlan(scope),
			transactIssue: (scope: DurableIssueScope, buildAndSign: DurableBuildAndSign) =>
				implementation.transactIssue(scope, buildAndSign),
			transactWriteSettlementPlan: (input: unknown) => implementation.transactWriteSettlementPlan(input),
		}));
		implementationByStore.set(store, implementation);
		const readBoundedRecoveryCensus: DurableIssuanceRecoveryCensusReader = input => implementation.readBoundedRecoveryCensus(input);
		Object.defineProperty(readBoundedRecoveryCensus, "captureCurrentProbe", {value: function (this: DurableIssuanceRecoveryCensusReader,
			input: DurableIssuanceRecoveryCensusInput, observation: DurableIssuanceRecoveryCensus): DurableIssuanceRecoveryCensusCurrentProbe | undefined {
			if (this !== readBoundedRecoveryCensus) return undefined;
			return implementation.captureRecoveryCensusCurrentProbe(input, observation);
		}});
		Object.freeze(readBoundedRecoveryCensus);
		const maintenance = Object.freeze({
			readBoundedRecoveryCensus,
			withNativeSignAdmission: (input: unknown, sign: () => Promise<Uint8Array>) =>
				implementation.withNativeSignAdmission(input, sign),
			acquireRetirementControl: (input: { readonly objectId: string }) =>
				implementation.acquireRetirementControl(input),
			readRetirementPlanBefore: (input: { readonly objectId: string }) => implementation.readRetirementPlanBefore(input),
			inspectPruningState: (scope: DurableIssueScope) => implementation.inspectPruningState(scope),
			pruneAuthenticatedSettledPrefix: (input: unknown) => implementation.pruneAuthenticatedSettledPrefix(input),
			prunePublishedPrefix: (input: unknown) => implementation.prunePublishedPrefix(input),
		});
		if (!bindDurableIssuancePruningMaintenance(store, maintenance)) {
			throw new TypeError("browser issuance maintenance was already bound");
		}
		implementationByMaintenance.set(maintenance, implementation);
		return store;
	} catch (error) {
		database.onversionchange = null;
		database.close();
		throw error;
	}
}

/**
 * Private test-only access to a consistent native terminal observation.
 * @internal
 * @param store - Candidate facade created by this module.
 * @returns Its private implementation, if owned by this module.
 */
export function browserIssuanceImplementationForTest(
	store: DurableIssuanceStore
): BrowserIssuanceImplementation | undefined {
	return implementationByStore.get(store);
}

/**
 * Resolves the private pruning implementation for one exact browser facade.
 * @param store - Candidate ordinary issuance facade.
 * @returns Its private maintenance capability, when identity matches.
 */
export function browserIssuancePruningMaintenanceForStore(store: DurableIssuanceStore):
	| Readonly<{
			readBoundedRecoveryCensus(input: unknown): Promise<DurableIssuanceRecoveryCensus>;
			inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
			pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
			prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
	  }>
	| undefined {
	const implementation = implementationByStore.get(store);
	if (implementation === undefined) return undefined;
	return Object.freeze({
		readBoundedRecoveryCensus: (input: unknown) => implementation.readBoundedRecoveryCensus(input),
		acquireRetirementControl: (input: { readonly objectId: string }) => implementation.acquireRetirementControl(input),
		readRetirementPlanBefore: (input: { readonly objectId: string }) => implementation.readRetirementPlanBefore(input),
		inspectPruningState: (scope: DurableIssueScope) => implementation.inspectPruningState(scope),
		pruneAuthenticatedSettledPrefix: (input: unknown) => implementation.pruneAuthenticatedSettledPrefix(input),
		prunePublishedPrefix: (input: unknown) => implementation.prunePublishedPrefix(input),
	});
}

/**
 * Slice 14a: the original issuance retirement acquisition inside a room retirement
 * session. Capture, birth and every transition run the original row census, image
 * digest, control CAS and preparation-row checks on the session's strict transaction;
 * nothing is read back, because the session commits whole or not at all. A refused
 * transition fails the session.
 * @param session - The open room retirement session.
 * @param input - The exact object address.
 * @returns The original retirement read, its transitions bound to the session.
 */
export async function acquireBrowserRoomIssuanceRetirement(
	session: RoomRetirementSession,
	input: { readonly objectId: string },
	guard: () => void = () => undefined
): Promise<DurableIssuanceRetirementControlRead> {
	const objectId = captureIssuanceRetirementObject(input);
	guard();
	const snapshot = await session.run(async (transaction) => {
		const rows = await browserRetirementRows(transaction, objectId),
			control = await browserRetirementControl(transaction, objectId),
			image = issuanceRetirementImage(rows, objectId);
		if (control !== null) return { control, image, rows };
		const born: DurableIssuanceRetirementControl = {
			kind: "v3-issuance-retirement-control-1",
			objectId,
			incarnation: issuanceRetirementHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
			revision: 0,
			sequence: 0,
			active: null,
			completed: null,
		};
		await requestResult(
			transaction
				.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls"))
				.add({ objectId, record: encodeIssuanceRetirementControl(born) })
		);
		return { control: born, image, rows };
	});
	const control = snapshot.control,
		image = snapshot.image;
	return createIssuanceRetirementControlRead(control, image, async (next, p) => {
		guard();
		const expectedRows = issuanceRetirementTransitionRows(control, next, snapshot.rows);
		const expectedImage = issuanceRetirementImage(expectedRows, objectId);
		await session.run(async (transaction) => {
			const current = await browserRetirementControl(transaction, objectId),
				rows = await browserRetirementRows(transaction, objectId);
			if (
				!current ||
				!issuanceRetirementBytesEqual(
					encodeIssuanceRetirementControl(current),
					encodeIssuanceRetirementControl(control)
				) ||
				issuanceRetirementImage(rows, objectId).imageDigest !== image.imageDigest
			)
				throw issuanceRetirementRefusal("issuance retirement source stale");
			if (p) assertIssuanceRetirementPreparationRows(current, p, rows);
			const targetRows = issuanceRetirementTransitionRows(current, next, rows);
			if (issuanceRetirementImage(targetRows, objectId).imageDigest !== expectedImage.imageDigest)
				throw issuanceRetirementRefusal("issuance retirement target stale");
			await browserWriteRetirementPlanBefore(transaction, current, next, rows);
			await browserWriteRetirementPlanChanges(transaction, rows, targetRows);
			await requestResult(
				transaction
					.objectStore(roomStoreName(transaction.db, "issuance", "retirementControls"))
					.put({ objectId, record: encodeIssuanceRetirementControl(next) })
			);
		});
		return next;
	});
}
