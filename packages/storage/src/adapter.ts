import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
} from "./codecs.js";
import { type TransitionObjectState, TransitionOwner } from "./internal/transition.js";
import {
	copyExpectedHead,
	copyGenerationRef,
	hasSharedBacking,
	isBlobDigest,
	isClosedArray,
	isClosedRecord,
	isGenerationId,
	isStorageObjectId,
} from "./internal/validation.js";
import type {
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationPage,
	GenerationPageCursor,
	GenerationRecord,
	GenerationRef,
	StorageObjectId,
	StoreResult,
} from "./types.js";

export type StorageAdapterCommand =
	| ReadHeadCommand
	| ReadGenerationPageCommand
	| GetBlobCommand
	| BeginGenerationCommand
	| PutCachedBlobCommand
	| PromoteReferenceCommand
	| CompleteGenerationCommand
	| SwapHeadCommand
	| DiscardGenerationCommand;

type ReadHeadCommand = Readonly<{
	kind: "readHead";
	objectId: StorageObjectId;
}>;

type ReadGenerationPageCommand = Readonly<{
	kind: "readGenerationPage";
	objectId: StorageObjectId;
	cursor?: GenerationPageCursor;
	limit: number;
}>;

type GetBlobCommand = Readonly<{
	kind: "getBlob";
	digest: BlobDigest;
}>;

type BeginGenerationCommand = Readonly<{
	kind: "beginGeneration";
	objectId: StorageObjectId;
	generationId: GenerationId;
	baseExpectedHead: ExpectedHead;
	closure: readonly GenerationRef[];
}>;

type PutCachedBlobCommand = Readonly<{
	kind: "putCachedBlob";
	objectId: StorageObjectId;
	generationId: GenerationId;
	digest: BlobDigest;
	bytes: Uint8Array;
}>;

type PromoteReferenceCommand = Readonly<{
	kind: "promoteReference";
	objectId: StorageObjectId;
	generationId: GenerationId;
	digest: BlobDigest;
}>;

type CompleteGenerationCommand = Readonly<{
	kind: "completeGeneration";
	objectId: StorageObjectId;
	generationId: GenerationId;
}>;

type SwapHeadCommand = Readonly<{
	kind: "swapHead";
	objectId: StorageObjectId;
	generationId: GenerationId;
	expectedHead: ExpectedHead;
}>;

type DiscardGenerationCommand = Readonly<{
	kind: "discardGeneration";
	objectId: StorageObjectId;
	generationId: GenerationId;
}>;

export type StorageAdapterLoadRequirement =
	| Readonly<{ kind: "object-state"; objectId: StorageObjectId }>
	| Readonly<{ kind: "head"; objectId: StorageObjectId }>
	| Readonly<{
			kind: "generation-page";
			objectId: StorageObjectId;
			afterGenerationId: GenerationId | null;
			limitPlusOne: number;
	  }>
	| Readonly<{ kind: "blob"; digest: BlobDigest }>
	| Readonly<{
			kind: "promotion";
			objectId: StorageObjectId;
			generationId: GenerationId;
			digest: BlobDigest;
	  }>
	| Readonly<{
			kind: "generation-closure";
			objectId: StorageObjectId;
			generationId: GenerationId;
	  }>;

export type PreparedStorageAdapterCommand = Readonly<{
	command: StorageAdapterCommand;
	requirements: readonly StorageAdapterLoadRequirement[];
}>;

export type StorageAdapterFact =
	| Readonly<{ kind: "store-closed" }>
	| Readonly<{
			kind: "head";
			objectId: StorageObjectId;
			headRecord: Uint8Array | null;
	  }>
	| Readonly<{
			kind: "generation-page";
			objectId: StorageObjectId;
			afterGenerationId: GenerationId | null;
			generationRecords: readonly Uint8Array[];
	  }>
	| Readonly<{
			kind: "object-state";
			objectId: StorageObjectId;
			headRecord: Uint8Array | null;
			generationRecords: readonly Uint8Array[];
	  }>
	| Readonly<{ kind: "blob"; digest: BlobDigest; bytes: Uint8Array | null }>
	| Readonly<{
			kind: "promotion";
			objectId: StorageObjectId;
			generationId: GenerationId;
			digest: BlobDigest;
	  }>;

export type StorageAdapterWrite =
	| Readonly<{
			kind: "replace-generation";
			objectId: StorageObjectId;
			generationId: GenerationId;
			record: Uint8Array;
	  }>
	| Readonly<{ kind: "replace-head"; objectId: StorageObjectId; record: Uint8Array }>
	| Readonly<{ kind: "insert-blob"; digest: BlobDigest; bytes: Uint8Array }>
	| Readonly<{
			kind: "insert-promotion";
			objectId: StorageObjectId;
			generationId: GenerationId;
			digest: BlobDigest;
	  }>;

export type StorageAdapterResultValue =
	| ExpectedHead
	| GenerationPage
	| Uint8Array
	| GenerationRecord
	| Readonly<{ inserted: boolean }>
	| Readonly<{
			head: Exclude<ExpectedHead, { kind: "none" }>;
			supersededGenerationId: GenerationId | null;
	  }>
	| null
	| undefined;

export type StorageAdapterEvaluation = Readonly<{
	result: StoreResult<StorageAdapterResultValue>;
	writes: readonly StorageAdapterWrite[];
}>;

const EMPTY_WRITES: readonly StorageAdapterWrite[] = Object.freeze([]);
const MAX_GENERATION_PAGE_ROWS = 128;
const GENERATION_PAGE_CURSOR_PREFIX = "ts-drp-storage/generation-page/v1\0";

type PersistedStorageReason = "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA";

type PersistedGenerationRow = Readonly<{
	objectId: unknown;
	generationId: unknown;
	record: unknown;
}>;

type PersistedHeadRow = Readonly<{ objectId: unknown; record: unknown }> | null;

type PersistedObjectStateSource =
	| Readonly<{
			kind: "adapter-fact";
			objectId: StorageObjectId;
			headRecord: unknown;
			generationRecords: readonly unknown[];
	  }>
	| Readonly<{
			kind: "physical";
			objectId: StorageObjectId;
			headRow: PersistedHeadRow;
			generationRows: readonly PersistedGenerationRow[];
	  }>;

type ClassifiedPersistedObjectState = Readonly<{
	fact: Extract<StorageAdapterFact, { kind: "object-state" }>;
	state: TransitionObjectState;
}>;

type PersistedStateSource =
	| Readonly<{ kind: "head"; objectId: StorageObjectId; row: PersistedHeadRow }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; row: PersistedGenerationRow }>
	| PersistedObjectStateSource;

type ClassifiedPersistedState =
	| Readonly<{ kind: "head"; head: ExpectedHead; record: Uint8Array | null }>
	| Readonly<{ kind: "generation"; generation: GenerationRecord; record: Uint8Array }>
	| (ClassifiedPersistedObjectState & Readonly<{ kind: "object-state" }>);

/** A semantic persisted-state failure, kept distinct from substrate exceptions. */
export class PersistedStorageError extends Error {
	/**
	 * Creates an internal semantic failure.
	 * @param reason - Stable persisted-state rejection reason.
	 */
	public constructor(public readonly reason: PersistedStorageReason) {
		super(reason);
		this.name = "PersistedStorageError";
	}
}

type PersistedClassification<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; reason: PersistedStorageReason }>;

function persistedFailure<T>(reason: PersistedStorageReason): PersistedClassification<T> {
	return { ok: false, reason };
}

function mergePersistedReasons(
	left: PersistedStorageReason | undefined,
	right: PersistedStorageReason
): PersistedStorageReason {
	return left === "UNSUPPORTED_STORAGE_SCHEMA" || right === "UNSUPPORTED_STORAGE_SCHEMA"
		? "UNSUPPORTED_STORAGE_SCHEMA"
		: "NON_CANONICAL_RECORD";
}

function copyPersistedBytes(value: unknown): Uint8Array | undefined {
	return value instanceof Uint8Array && !hasSharedBacking(value) ? new Uint8Array(value) : undefined;
}

/**
 * Classifies one persisted head row and detaches its canonical value and bytes.
 * @param objectId - Object whose physical row was addressed.
 * @param row - Raw physical head row, or null when absent.
 * @returns Detached canonical head or its stable persisted rejection.
 */
function classifyPersistedHead(
	objectId: StorageObjectId,
	row: PersistedHeadRow
): PersistedClassification<Readonly<{ head: ExpectedHead; record: Uint8Array | null }>> {
	if (row === null) return { ok: true, value: { head: { kind: "none", objectId }, record: null } };
	if (row.record === null) {
		return row.objectId === objectId
			? { ok: true, value: { head: { kind: "none", objectId }, record: null } }
			: persistedFailure("NON_CANONICAL_RECORD");
	}
	const record = copyPersistedBytes(row.record);
	if (record === undefined) return persistedFailure("NON_CANONICAL_RECORD");
	const decoded = decodeHeadRecordV1(record);
	if (!decoded.ok) {
		return persistedFailure(decoded.reason === "UNSUPPORTED_STORAGE_SCHEMA" ? decoded.reason : "NON_CANONICAL_RECORD");
	}
	if (row.objectId !== objectId || decoded.value.kind !== "present" || decoded.value.objectId !== objectId) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	return { ok: true, value: { head: decoded.value, record } };
}

/**
 * Classifies one physically keyed generation row and detaches its canonical value and bytes.
 * @param objectId - Object whose physical range was addressed.
 * @param row - Raw physical generation row.
 * @returns Detached canonical generation or its stable persisted rejection.
 */
function classifyPersistedGeneration(
	objectId: StorageObjectId,
	row: PersistedGenerationRow
): PersistedClassification<Readonly<{ generation: GenerationRecord; record: Uint8Array }>> {
	const record = copyPersistedBytes(row.record);
	if (record === undefined) return persistedFailure("NON_CANONICAL_RECORD");
	const decoded = decodeGenerationRecordV1(record);
	if (!decoded.ok) {
		return persistedFailure(decoded.reason === "UNSUPPORTED_STORAGE_SCHEMA" ? decoded.reason : "NON_CANONICAL_RECORD");
	}
	if (
		row.objectId !== objectId ||
		decoded.value.objectId !== objectId ||
		row.generationId !== decoded.value.generationId
	) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	return { ok: true, value: { generation: decoded.value, record } };
}

function classifyPersistedGenerations(
	objectId: StorageObjectId,
	rows: readonly PersistedGenerationRow[]
): PersistedClassification<Readonly<{ generations: readonly GenerationRecord[]; records: readonly Uint8Array[] }>> {
	const generations: GenerationRecord[] = [];
	const records: Uint8Array[] = [];
	const ids = new Set<GenerationId>();
	let failure: PersistedStorageReason | undefined;
	for (const row of rows) {
		const classified = classifyPersistedGeneration(objectId, row);
		if (!classified.ok) {
			failure = mergePersistedReasons(failure, classified.reason);
			continue;
		}
		if (ids.has(classified.value.generation.generationId)) {
			failure = mergePersistedReasons(failure, "NON_CANONICAL_RECORD");
			continue;
		}
		ids.add(classified.value.generation.generationId);
		generations.push(classified.value.generation);
		records.push(classified.value.record);
	}
	return failure === undefined
		? { ok: true, value: { generations: Object.freeze(generations), records: Object.freeze(records) } }
		: persistedFailure(failure);
}

/**
 * Owns persisted full-journal decoding, physical-key binding and relational precedence.
 * Strict backends supply physical rows; the adapter-fact branch preserves direct fact validation.
 * @param source - Physical backend rows or a direct adapter fact.
 * @returns Detached canonical journal state or its stable persisted rejection.
 */
function classifyPersistedObjectState(
	source: PersistedObjectStateSource
): PersistedClassification<ClassifiedPersistedObjectState> {
	const physical = source.kind === "physical";
	let headClassification: ReturnType<typeof classifyPersistedHead>;
	let rows: readonly PersistedGenerationRow[];
	if (physical) {
		headClassification = classifyPersistedHead(source.objectId, source.headRow);
		rows = source.generationRows;
	} else {
		headClassification =
			source.headRecord === null
				? classifyPersistedHead(source.objectId, null)
				: classifyPersistedHead(source.objectId, { objectId: source.objectId, record: source.headRecord });
		rows = source.generationRecords.map((record) => {
			const bytes = copyPersistedBytes(record);
			if (bytes === undefined) return { objectId: source.objectId, generationId: undefined, record };
			const decoded = decodeGenerationRecordV1(bytes);
			return {
				objectId: source.objectId,
				generationId: decoded.ok ? decoded.value.generationId : undefined,
				record: bytes,
			};
		});
	}
	const generationsClassification = classifyPersistedGenerations(source.objectId, rows);
	if (!headClassification.ok || !generationsClassification.ok) {
		const headReason = headClassification.ok ? undefined : headClassification.reason;
		const generationReason = generationsClassification.ok ? undefined : generationsClassification.reason;
		return persistedFailure(
			headReason === undefined
				? (generationReason as PersistedStorageReason)
				: generationReason === undefined
					? headReason
					: mergePersistedReasons(headReason, generationReason)
		);
	}
	const { head, record: headRecord } = headClassification.value;
	const { generations, records: generationRecords } = generationsClassification.value;
	const adopted = generations.filter(({ state }) => state === "Adopted");
	if (head.kind === "none" ? adopted.length !== 0 : adopted.length !== 1) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	if (
		head.kind === "present" &&
		(adopted[0]?.generationId !== head.generationId || adopted[0].closureDigest !== head.closureDigest)
	) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	return {
		ok: true,
		value: {
			fact: Object.freeze({
				generationRecords,
				headRecord,
				kind: "object-state",
				objectId: source.objectId,
			}),
			state: { generations, head },
		},
	};
}

/**
 * Classifies one tagged persisted head, generation or full-journal source.
 * This is the strict backends' only semantic persisted-state entrypoint.
 * @param source - Raw physical rows or one direct adapter fact.
 * @returns Detached canonical state or its stable persisted rejection.
 */
export function classifyPersistedState(
	source: PersistedStateSource
): PersistedClassification<ClassifiedPersistedState> {
	if (source.kind === "head") {
		const classified = classifyPersistedHead(source.objectId, source.row);
		return classified.ok ? { ok: true, value: { kind: "head", ...classified.value } } : classified;
	}
	if (source.kind === "generation") {
		const classified = classifyPersistedGeneration(source.objectId, source.row);
		return classified.ok ? { ok: true, value: { kind: "generation", ...classified.value } } : classified;
	}
	const classified = classifyPersistedObjectState(source);
	return classified.ok ? { ok: true, value: { kind: "object-state", ...classified.value } } : classified;
}

function invalidPreparation(): StoreResult<PreparedStorageAdapterCommand> {
	return { ok: false, reason: "INVALID_ARGUMENT" };
}

function sharedPreparation(): StoreResult<PreparedStorageAdapterCommand> {
	return { ok: false, reason: "SHARED_BUFFER_INPUT" };
}

function freezePrepared(
	command: StorageAdapterCommand,
	requirements: readonly StorageAdapterLoadRequirement[]
): StoreResult<PreparedStorageAdapterCommand> {
	return {
		ok: true,
		value: Object.freeze({ command: Object.freeze(command), requirements: Object.freeze([...requirements]) }),
	};
}

function generationScope(
	value: Record<string, unknown>
): Readonly<{ objectId: StorageObjectId; generationId: GenerationId }> | undefined {
	if (!isStorageObjectId(value.objectId) || !isGenerationId(value.generationId)) return undefined;
	return { objectId: value.objectId, generationId: value.generationId };
}

function copyStructuralClosure(value: unknown): readonly GenerationRef[] | undefined {
	if (!isClosedArray(value)) return undefined;
	const closure: GenerationRef[] = [];
	for (const item of value) {
		const copied = copyGenerationRef(item);
		if (copied === undefined) return undefined;
		closure.push(copied);
	}
	return closure;
}

function validPageLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GENERATION_PAGE_ROWS;
}

function encodeGenerationPageCursor(objectId: StorageObjectId, generationId: GenerationId): GenerationPageCursor {
	return `${GENERATION_PAGE_CURSOR_PREFIX}${objectId}\0${generationId}` as GenerationPageCursor;
}

function decodeGenerationPageCursor(
	value: unknown
): Readonly<{ objectId: StorageObjectId; generationId: GenerationId }> | undefined {
	if (typeof value !== "string" || !value.startsWith(GENERATION_PAGE_CURSOR_PREFIX)) return undefined;
	const payload = value.slice(GENERATION_PAGE_CURSOR_PREFIX.length);
	const separator = payload.indexOf("\0");
	if (separator <= 0 || separator !== payload.lastIndexOf("\0")) return undefined;
	const objectId = payload.slice(0, separator);
	const generationId = payload.slice(separator + 1);
	if (!isStorageObjectId(objectId) || !isGenerationId(generationId)) return undefined;
	return encodeGenerationPageCursor(objectId, generationId) === value ? { objectId, generationId } : undefined;
}

/**
 * Validates and detaches one closed adapter command before substrate I/O.
 * @param value - Untrusted adapter command input.
 * @returns The detached command and exact authoritative load requirements.
 */
export function prepareStorageAdapterCommand(value: unknown): StoreResult<PreparedStorageAdapterCommand> {
	if (typeof value !== "object" || value === null) return invalidPreparation();
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
	if (kindDescriptor === undefined || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") {
		return invalidPreparation();
	}

	if (kindDescriptor.value === "readHead") {
		if (!isClosedRecord(value, ["kind", "objectId"]) || !isStorageObjectId(value.objectId)) {
			return invalidPreparation();
		}
		const command: ReadHeadCommand = { kind: "readHead", objectId: value.objectId };
		return freezePrepared(command, [{ kind: "head", objectId: command.objectId }]);
	}

	if (kindDescriptor.value === "readGenerationPage") {
		const keys = Object.prototype.hasOwnProperty.call(value, "cursor")
			? ["kind", "objectId", "cursor", "limit"]
			: ["kind", "objectId", "limit"];
		if (!isClosedRecord(value, keys) || !isStorageObjectId(value.objectId) || !validPageLimit(value.limit)) {
			return invalidPreparation();
		}
		let afterGenerationId: GenerationId | null = null;
		let cursor: GenerationPageCursor | undefined;
		if (keys.length === 4) {
			const decoded = decodeGenerationPageCursor(value.cursor);
			if (decoded === undefined || decoded.objectId !== value.objectId) return invalidPreparation();
			afterGenerationId = decoded.generationId;
			cursor = value.cursor as GenerationPageCursor;
		}
		const command: ReadGenerationPageCommand = {
			kind: "readGenerationPage",
			objectId: value.objectId,
			...(cursor === undefined ? {} : { cursor }),
			limit: value.limit,
		};
		return freezePrepared(command, [
			{
				afterGenerationId,
				kind: "generation-page",
				limitPlusOne: command.limit + 1,
				objectId: command.objectId,
			},
		]);
	}

	if (kindDescriptor.value === "getBlob") {
		if (!isClosedRecord(value, ["kind", "digest"]) || !isBlobDigest(value.digest)) return invalidPreparation();
		const command: GetBlobCommand = { kind: "getBlob", digest: value.digest };
		return freezePrepared(command, [{ kind: "blob", digest: command.digest }]);
	}

	if (kindDescriptor.value === "beginGeneration") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId", "baseExpectedHead", "closure"])) {
			return invalidPreparation();
		}
		const scope = generationScope(value);
		if (scope === undefined) return invalidPreparation();
		const baseExpectedHead = copyExpectedHead(value.baseExpectedHead, scope.objectId);
		const closure = copyStructuralClosure(value.closure);
		if (baseExpectedHead === undefined || closure === undefined) return invalidPreparation();
		const command: BeginGenerationCommand = {
			kind: "beginGeneration",
			...scope,
			baseExpectedHead,
			closure,
		};
		return freezePrepared(command, [{ kind: "object-state", objectId: command.objectId }]);
	}

	if (kindDescriptor.value === "putCachedBlob") {
		const bytesDescriptor = Object.getOwnPropertyDescriptor(value, "bytes");
		if (
			bytesDescriptor === undefined ||
			!("value" in bytesDescriptor) ||
			!(bytesDescriptor.value instanceof Uint8Array)
		) {
			return invalidPreparation();
		}
		if (hasSharedBacking(bytesDescriptor.value)) return sharedPreparation();
		const bytes = new Uint8Array(bytesDescriptor.value);
		if (!isClosedRecord(value, ["kind", "objectId", "generationId", "digest", "bytes"])) {
			return invalidPreparation();
		}
		const scope = generationScope(value);
		if (scope === undefined || !isBlobDigest(value.digest)) return invalidPreparation();
		const command: PutCachedBlobCommand = {
			kind: "putCachedBlob",
			...scope,
			digest: value.digest,
			bytes,
		};
		return freezePrepared(command, [
			{ kind: "object-state", objectId: command.objectId },
			{ kind: "blob", digest: command.digest },
		]);
	}

	if (kindDescriptor.value === "promoteReference") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId", "digest"])) return invalidPreparation();
		const scope = generationScope(value);
		if (scope === undefined || !isBlobDigest(value.digest)) return invalidPreparation();
		const command: PromoteReferenceCommand = { kind: "promoteReference", ...scope, digest: value.digest };
		return freezePrepared(command, [
			{ kind: "object-state", objectId: command.objectId },
			{ kind: "blob", digest: command.digest },
			{ kind: "promotion", ...scope, digest: command.digest },
		]);
	}

	if (kindDescriptor.value === "completeGeneration") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId"])) return invalidPreparation();
		const scope = generationScope(value);
		if (scope === undefined) return invalidPreparation();
		const command: CompleteGenerationCommand = { kind: "completeGeneration", ...scope };
		return freezePrepared(command, [
			{ kind: "object-state", objectId: command.objectId },
			{ kind: "generation-closure", ...scope },
		]);
	}

	if (kindDescriptor.value === "swapHead") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId", "expectedHead"])) {
			return invalidPreparation();
		}
		const scope = generationScope(value);
		if (scope === undefined) return invalidPreparation();
		const expectedHead = copyExpectedHead(value.expectedHead, scope.objectId);
		if (expectedHead === undefined) return invalidPreparation();
		const command: SwapHeadCommand = { kind: "swapHead", ...scope, expectedHead };
		return freezePrepared(command, [{ kind: "object-state", objectId: command.objectId }]);
	}

	if (kindDescriptor.value === "discardGeneration") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId"])) return invalidPreparation();
		const scope = generationScope(value);
		if (scope === undefined) return invalidPreparation();
		const command: DiscardGenerationCommand = { kind: "discardGeneration", ...scope };
		return freezePrepared(command, [{ kind: "object-state", objectId: command.objectId }]);
	}

	return invalidPreparation();
}

/**
 * Evaluates a detached command over exact backend-owned facts.
 * @param prepared - Prepared command.
 * @param facts - Exact authoritative facts loaded by the adapter transaction.
 * @returns The shared-kernel result and exact deterministic write set.
 */
export function evaluateStorageAdapterCommand(
	prepared: PreparedStorageAdapterCommand,
	facts: readonly StorageAdapterFact[]
): StorageAdapterEvaluation {
	const canonical = canonicalPrepared(prepared);
	if (canonical === undefined) return invalidEvaluation();
	if (isClosedArray(facts) && facts.length === 1 && isClosedStoreFact(facts[0])) {
		return Object.freeze({ result: { ok: false, reason: "STORE_CLOSED" }, writes: EMPTY_WRITES });
	}
	const loaded = copyAndValidateFacts(canonical.command, facts);
	if (loaded === undefined) return invalidEvaluation();

	const owner = new TransitionOwner("strict");
	for (const state of loaded.objects.values()) owner.seedObjectState(state);
	for (const fact of loaded.blobs.values()) {
		if (fact.bytes !== null) owner.seedBlob(fact.digest, fact.bytes);
	}
	for (const fact of loaded.promotions.values()) {
		owner.markPromoted(fact.objectId, fact.generationId, fact.digest);
	}
	const result = execute(owner, canonical.command, loaded);
	if (!result.ok) return Object.freeze({ result, writes: EMPTY_WRITES });

	const writes: StorageAdapterWrite[] = [];
	if (canonical.command.kind === "putCachedBlob" && (result.value as Readonly<{ inserted: boolean }>).inserted) {
		writes.push({
			kind: "insert-blob",
			digest: canonical.command.digest,
			bytes: new Uint8Array(canonical.command.bytes),
		});
	} else if (canonical.command.kind === "promoteReference" && !loaded.promotions.has(promotionKey(canonical.command))) {
		writes.push({
			kind: "insert-promotion",
			objectId: canonical.command.objectId,
			generationId: canonical.command.generationId,
			digest: canonical.command.digest,
		});
	} else if (
		canonical.command.kind === "beginGeneration" ||
		canonical.command.kind === "completeGeneration" ||
		canonical.command.kind === "discardGeneration"
	) {
		const generation = result.value as GenerationRecord;
		writes.push(generationWrite(generation));
	} else if (canonical.command.kind === "swapHead") {
		const swap = result.value as Readonly<{
			head: Exclude<ExpectedHead, { kind: "none" }>;
			supersededGenerationId: GenerationId | null;
		}>;
		if (swap.supersededGenerationId !== null) {
			const superseded = owner.readGenerationRecord(canonical.command.objectId, swap.supersededGenerationId);
			if (!superseded.ok || superseded.value === null) return invalidEvaluation();
			writes.push(generationWrite(superseded.value));
		}
		const candidate = owner.readGenerationRecord(canonical.command.objectId, canonical.command.generationId);
		if (!candidate.ok || candidate.value === null) return invalidEvaluation();
		writes.push(generationWrite(candidate.value));
		writes.push({
			kind: "replace-head",
			objectId: canonical.command.objectId,
			record: encodeHeadRecordV1(swap.head),
		});
	}
	return Object.freeze({ result, writes: Object.freeze(writes) });
}

type LoadedFacts = Readonly<{
	objects: Map<StorageObjectId, TransitionObjectState>;
	heads: Map<StorageObjectId, ExpectedHead>;
	pages: Map<
		StorageObjectId,
		Readonly<{ afterGenerationId: GenerationId | null; records: readonly GenerationRecord[] }>
	>;
	blobs: Map<BlobDigest, Readonly<{ digest: BlobDigest; bytes: Uint8Array | null }>>;
	promotions: Map<string, Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>>;
}>;

function generationWrite(generation: GenerationRecord): StorageAdapterWrite {
	return {
		kind: "replace-generation",
		objectId: generation.objectId,
		generationId: generation.generationId,
		record: encodeGenerationRecordV1(generation),
	};
}

function invalidEvaluation(): StorageAdapterEvaluation {
	return Object.freeze({ result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: EMPTY_WRITES });
}

function isClosedStoreFact(value: unknown): value is Readonly<{ kind: "store-closed" }> {
	return isClosedRecord(value, ["kind"]) && value.kind === "store-closed";
}

function requirementKey(requirement: StorageAdapterLoadRequirement): string {
	switch (requirement.kind) {
		case "object-state":
			return `object-state\0${requirement.objectId}`;
		case "head":
			return `head\0${requirement.objectId}`;
		case "generation-page":
			return `generation-page\0${requirement.objectId}\0${requirement.afterGenerationId ?? ""}\0${requirement.limitPlusOne}`;
		case "blob":
			return `blob\0${requirement.digest}`;
		case "promotion":
			return `promotion\0${requirement.objectId}\0${requirement.generationId}\0${requirement.digest}`;
		case "generation-closure":
			return `generation-closure\0${requirement.objectId}\0${requirement.generationId}`;
	}
}

function canonicalPrepared(value: unknown): PreparedStorageAdapterCommand | undefined {
	if (!isClosedRecord(value, ["command", "requirements"]) || !isClosedArray(value.requirements)) return undefined;
	const prepared = prepareStorageAdapterCommand(value.command);
	if (!prepared.ok || prepared.value.requirements.length !== value.requirements.length) return undefined;
	for (let index = 0; index < prepared.value.requirements.length; index++) {
		const supplied = value.requirements[index];
		const expected = prepared.value.requirements[index];
		if (expected === undefined || !isRequirement(supplied) || requirementKey(supplied) !== requirementKey(expected)) {
			return undefined;
		}
	}
	return prepared.value;
}

function isRequirement(value: unknown): value is StorageAdapterLoadRequirement {
	if (isClosedRecord(value, ["kind", "objectId"]) && value.kind === "object-state") {
		return isStorageObjectId(value.objectId);
	}
	if (isClosedRecord(value, ["kind", "objectId"]) && value.kind === "head") {
		return isStorageObjectId(value.objectId);
	}
	if (
		isClosedRecord(value, ["kind", "objectId", "afterGenerationId", "limitPlusOne"]) &&
		value.kind === "generation-page"
	) {
		return (
			isStorageObjectId(value.objectId) &&
			(value.afterGenerationId === null || isGenerationId(value.afterGenerationId)) &&
			typeof value.limitPlusOne === "number" &&
			Number.isSafeInteger(value.limitPlusOne) &&
			value.limitPlusOne >= 2 &&
			value.limitPlusOne <= MAX_GENERATION_PAGE_ROWS + 1
		);
	}
	if (isClosedRecord(value, ["kind", "digest"]) && value.kind === "blob") return isBlobDigest(value.digest);
	if (isClosedRecord(value, ["kind", "objectId", "generationId", "digest"]) && value.kind === "promotion") {
		return isStorageObjectId(value.objectId) && isGenerationId(value.generationId) && isBlobDigest(value.digest);
	}
	return (
		isClosedRecord(value, ["kind", "objectId", "generationId"]) &&
		value.kind === "generation-closure" &&
		isStorageObjectId(value.objectId) &&
		isGenerationId(value.generationId)
	);
}

function copyAndValidateFacts(command: StorageAdapterCommand, facts: unknown): LoadedFacts | undefined {
	if (!isClosedArray(facts)) return undefined;
	const objects = new Map<StorageObjectId, TransitionObjectState>();
	const heads = new Map<StorageObjectId, ExpectedHead>();
	const pages = new Map<
		StorageObjectId,
		Readonly<{ afterGenerationId: GenerationId | null; records: readonly GenerationRecord[] }>
	>();
	const blobs = new Map<BlobDigest, Readonly<{ digest: BlobDigest; bytes: Uint8Array | null }>>();
	const promotions = new Map<
		string,
		Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>
	>();
	for (const fact of facts) {
		if (isClosedRecord(fact, ["kind", "objectId", "headRecord"]) && fact.kind === "head") {
			if (!isStorageObjectId(fact.objectId) || heads.has(fact.objectId)) return undefined;
			const head = decodeHeadFact(fact.objectId, fact.headRecord);
			if (head === undefined) return undefined;
			heads.set(fact.objectId, head);
			continue;
		}
		if (
			isClosedRecord(fact, ["kind", "objectId", "afterGenerationId", "generationRecords"]) &&
			fact.kind === "generation-page"
		) {
			if (
				!isStorageObjectId(fact.objectId) ||
				pages.has(fact.objectId) ||
				(fact.afterGenerationId !== null && !isGenerationId(fact.afterGenerationId)) ||
				!isClosedArray(fact.generationRecords)
			) {
				return undefined;
			}
			const records: GenerationRecord[] = [];
			let previous = fact.afterGenerationId as GenerationId | null;
			for (const recordBytes of fact.generationRecords) {
				const bytes = copyBytes(recordBytes);
				if (bytes === undefined) return undefined;
				const decoded = decodeGenerationRecordV1(bytes);
				if (
					!decoded.ok ||
					decoded.value.objectId !== fact.objectId ||
					(previous !== null && decoded.value.generationId <= previous)
				) {
					return undefined;
				}
				records.push(decoded.value);
				previous = decoded.value.generationId;
			}
			pages.set(fact.objectId, { afterGenerationId: fact.afterGenerationId as GenerationId | null, records });
			continue;
		}
		if (isClosedRecord(fact, ["kind", "objectId", "headRecord", "generationRecords"]) && fact.kind === "object-state") {
			if (!isStorageObjectId(fact.objectId) || objects.has(fact.objectId) || !isClosedArray(fact.generationRecords)) {
				return undefined;
			}
			const classified = classifyPersistedObjectState({
				generationRecords: fact.generationRecords,
				headRecord: fact.headRecord,
				kind: "adapter-fact",
				objectId: fact.objectId,
			});
			if (!classified.ok) return undefined;
			objects.set(fact.objectId, classified.value.state);
			continue;
		}
		if (isClosedRecord(fact, ["kind", "digest", "bytes"]) && fact.kind === "blob") {
			if (!isBlobDigest(fact.digest) || blobs.has(fact.digest)) return undefined;
			if (fact.bytes === null) blobs.set(fact.digest, { digest: fact.digest, bytes: null });
			else {
				const bytes = copyBytes(fact.bytes);
				if (bytes === undefined) return undefined;
				blobs.set(fact.digest, { digest: fact.digest, bytes });
			}
			continue;
		}
		if (
			isClosedRecord(fact, ["kind", "objectId", "generationId", "digest"]) &&
			fact.kind === "promotion" &&
			isStorageObjectId(fact.objectId) &&
			isGenerationId(fact.generationId) &&
			isBlobDigest(fact.digest)
		) {
			const objectId = fact.objectId as StorageObjectId;
			const generationId = fact.generationId as GenerationId;
			const digest = fact.digest as BlobDigest;
			const key = promotionKey({ objectId, generationId, digest });
			if (promotions.has(key)) return undefined;
			promotions.set(key, { objectId, generationId, digest });
			continue;
		}
		return undefined;
	}
	const loaded = { objects, heads, pages, blobs, promotions };
	return exactFactsForCommand(command, loaded) ? loaded : undefined;
}

function decodeHeadFact(objectId: StorageObjectId, value: unknown): ExpectedHead | undefined {
	if (value === null) return { kind: "none", objectId };
	const bytes = copyBytes(value);
	if (bytes === undefined) return undefined;
	const decoded = decodeHeadRecordV1(bytes);
	return decoded.ok && decoded.value.kind === "present" && decoded.value.objectId === objectId
		? decoded.value
		: undefined;
}

function copyBytes(value: unknown): Uint8Array | undefined {
	if (!(value instanceof Uint8Array) || hasSharedBacking(value)) return undefined;
	return new Uint8Array(value);
}

function exactFactsForCommand(command: StorageAdapterCommand, facts: LoadedFacts): boolean {
	const objectIds = new Set<StorageObjectId>();
	const blobIds = new Set<BlobDigest>();
	const allowedPromotions = new Set<string>();
	if (command.kind === "getBlob") blobIds.add(command.digest);
	else if (command.kind === "readHead") {
		return (
			facts.heads.size === 1 &&
			facts.heads.has(command.objectId) &&
			facts.pages.size === 0 &&
			facts.objects.size === 0 &&
			facts.blobs.size === 0 &&
			facts.promotions.size === 0
		);
	} else if (command.kind === "readGenerationPage") {
		const page = facts.pages.get(command.objectId);
		const cursor = command.cursor === undefined ? undefined : decodeGenerationPageCursor(command.cursor);
		return (
			page !== undefined &&
			facts.pages.size === 1 &&
			facts.heads.size === 0 &&
			facts.objects.size === 0 &&
			facts.blobs.size === 0 &&
			facts.promotions.size === 0 &&
			page.afterGenerationId === (cursor?.generationId ?? null) &&
			page.records.length <= command.limit + 1
		);
	} else {
		objectIds.add(command.objectId);
		if (command.kind === "putCachedBlob" || command.kind === "promoteReference") blobIds.add(command.digest);
		if (command.kind === "promoteReference") allowedPromotions.add(promotionKey(command));
		if (command.kind === "completeGeneration") {
			const generation = facts.objects
				.get(command.objectId)
				?.generations.find(({ generationId }) => generationId === command.generationId);
			for (const reference of generation?.closure ?? []) {
				allowedPromotions.add(promotionKey({ ...command, digest: reference.digest }));
			}
		}
	}
	if (
		facts.heads.size !== 0 ||
		facts.pages.size !== 0 ||
		facts.objects.size !== objectIds.size ||
		facts.blobs.size !== blobIds.size
	) {
		return false;
	}
	for (const id of objectIds) if (!facts.objects.has(id)) return false;
	for (const id of blobIds) if (!facts.blobs.has(id)) return false;
	for (const key of facts.promotions.keys()) if (!allowedPromotions.has(key)) return false;
	return true;
}

function promotionKey(value: { objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }): string {
	return `${value.objectId}\0${value.generationId}\0${value.digest}`;
}

function execute(
	owner: TransitionOwner,
	command: StorageAdapterCommand,
	loaded: LoadedFacts
): StoreResult<StorageAdapterResultValue> {
	switch (command.kind) {
		case "readHead": {
			const head = loaded.heads.get(command.objectId);
			return head === undefined ? { ok: false, reason: "INVALID_ARGUMENT" } : { ok: true, value: head };
		}
		case "readGenerationPage": {
			const page = loaded.pages.get(command.objectId);
			if (page === undefined) return { ok: false, reason: "INVALID_ARGUMENT" };
			const generations = page.records.slice(0, command.limit);
			const lastGeneration = generations.at(-1);
			return {
				ok: true,
				value: {
					generations,
					nextCursor:
						page.records.length > command.limit && lastGeneration !== undefined
							? encodeGenerationPageCursor(command.objectId, lastGeneration.generationId)
							: null,
				},
			};
		}
		case "getBlob":
			return owner.getBlob(command.digest);
		case "beginGeneration":
			return owner.beginGeneration({
				objectId: command.objectId,
				generationId: command.generationId,
				baseExpectedHead: command.baseExpectedHead,
				closure: command.closure,
			});
		case "putCachedBlob":
			return owner.putCachedBlob({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
				bytes: command.bytes,
			});
		case "promoteReference":
			return owner.promoteReference({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
			});
		case "completeGeneration":
			return owner.completeGeneration({ objectId: command.objectId, generationId: command.generationId });
		case "swapHead":
			return owner.swapHead({
				objectId: command.objectId,
				generationId: command.generationId,
				expectedHead: command.expectedHead,
			});
		case "discardGeneration":
			return owner.discardGeneration({ objectId: command.objectId, generationId: command.generationId });
	}
}
