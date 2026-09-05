import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
} from "./codecs.js";
import { acceptBlob, acceptPromotion, type Authorization, finish, next, start } from "./internal/closure-verifier.js";
import { TransitionOwner } from "./internal/transition.js";
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
	| Readonly<{ kind: "head"; objectId: StorageObjectId }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; generationId: GenerationId }>
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
			kind: "generation";
			objectId: StorageObjectId;
			generationId: GenerationId;
			generationRecord: Uint8Array | null;
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

export const storageAdapterClosureVerifier = Object.freeze({ start, next, acceptPromotion, acceptBlob, finish });

type PersistedStorageReason = "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA";

type PersistedGenerationRow = Readonly<{
	objectId: unknown;
	generationId: unknown;
	record: unknown;
}>;

type PersistedHeadRow = Readonly<{ objectId: unknown; record: unknown }> | null;

type PersistedStateSource =
	| Readonly<{ kind: "head"; objectId: StorageObjectId; row: PersistedHeadRow }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; row: PersistedGenerationRow }>;

type ClassifiedPersistedState =
	| Readonly<{ kind: "head"; head: ExpectedHead; record: Uint8Array | null }>
	| Readonly<{ kind: "generation"; generation: GenerationRecord; record: Uint8Array }>;

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
	const classified = classifyPersistedGeneration(source.objectId, source.row);
	return classified.ok ? { ok: true, value: { kind: "generation", ...classified.value } } : classified;
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
		return freezePrepared(command, [
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", objectId: command.objectId, generationId: command.generationId },
		]);
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
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", objectId: command.objectId, generationId: command.generationId },
			{ kind: "blob", digest: command.digest },
		]);
	}

	if (kindDescriptor.value === "promoteReference") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId", "digest"])) return invalidPreparation();
		const scope = generationScope(value);
		if (scope === undefined || !isBlobDigest(value.digest)) return invalidPreparation();
		const command: PromoteReferenceCommand = { kind: "promoteReference", ...scope, digest: value.digest };
		return freezePrepared(command, [
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", objectId: command.objectId, generationId: command.generationId },
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
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", ...scope },
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
		return freezePrepared(command, [
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", ...scope },
		]);
	}

	if (kindDescriptor.value === "discardGeneration") {
		if (!isClosedRecord(value, ["kind", "objectId", "generationId"])) return invalidPreparation();
		const scope = generationScope(value);
		if (scope === undefined) return invalidPreparation();
		const command: DiscardGenerationCommand = { kind: "discardGeneration", ...scope };
		return freezePrepared(command, [
			{ kind: "head", objectId: command.objectId },
			{ kind: "generation", ...scope },
		]);
	}

	return invalidPreparation();
}
type LoadedFacts = Readonly<{
	heads: Map<StorageObjectId, ExpectedHead>;
	generations: Map<string, GenerationRecord | null>;
	pages: Map<
		StorageObjectId,
		Readonly<{ afterGenerationId: GenerationId | null; records: readonly GenerationRecord[] }>
	>;
	blobs: Map<BlobDigest, Readonly<{ digest: BlobDigest; bytes: Uint8Array | null }>>;
	promotions: Map<string, Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>>;
}>;

function generationKey(objectId: StorageObjectId, generationId: GenerationId): string {
	return `${objectId}\0${generationId}`;
}
function promotionKey(value: { objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }): string {
	return `${value.objectId}\0${value.generationId}\0${value.digest}`;
}
function decodeHeadFact(objectId: StorageObjectId, value: unknown): ExpectedHead | undefined {
	if (value === null) return { kind: "none", objectId };
	const bytes = copyFactBytes(value);
	if (bytes === undefined) return undefined;
	const decoded = decodeHeadRecordV1(bytes);
	return decoded.ok && decoded.value.kind === "present" && decoded.value.objectId === objectId
		? decoded.value
		: undefined;
}
function copyFactBytes(value: unknown): Uint8Array | undefined {
	return value instanceof Uint8Array && !hasSharedBacking(value) ? new Uint8Array(value) : undefined;
}
function loadFacts(command: StorageAdapterCommand, facts: unknown): LoadedFacts | undefined {
	if (!isClosedArray(facts)) return undefined;
	const loaded: LoadedFacts = {
		heads: new Map(),
		generations: new Map(),
		pages: new Map(),
		blobs: new Map(),
		promotions: new Map(),
	};
	for (const fact of facts) {
		if (isClosedRecord(fact, ["kind", "objectId", "headRecord"]) && fact.kind === "head") {
			if (!isStorageObjectId(fact.objectId) || loaded.heads.has(fact.objectId)) return undefined;
			const head = decodeHeadFact(fact.objectId, fact.headRecord);
			if (head === undefined) return undefined;
			loaded.heads.set(fact.objectId, head);
			continue;
		}
		if (isClosedRecord(fact, ["kind", "objectId", "generationId", "generationRecord"]) && fact.kind === "generation") {
			if (!isStorageObjectId(fact.objectId) || !isGenerationId(fact.generationId)) return undefined;
			const key = generationKey(fact.objectId, fact.generationId);
			if (loaded.generations.has(key)) return undefined;
			if (fact.generationRecord === null) loaded.generations.set(key, null);
			else {
				const bytes = copyFactBytes(fact.generationRecord);
				if (bytes === undefined) return undefined;
				const decoded = decodeGenerationRecordV1(bytes);
				if (!decoded.ok || decoded.value.objectId !== fact.objectId || decoded.value.generationId !== fact.generationId)
					return undefined;
				loaded.generations.set(key, decoded.value);
			}
			continue;
		}
		if (
			isClosedRecord(fact, ["kind", "objectId", "afterGenerationId", "generationRecords"]) &&
			fact.kind === "generation-page"
		) {
			if (
				!isStorageObjectId(fact.objectId) ||
				loaded.pages.has(fact.objectId) ||
				(fact.afterGenerationId !== null && !isGenerationId(fact.afterGenerationId)) ||
				!isClosedArray(fact.generationRecords)
			)
				return undefined;
			const records: GenerationRecord[] = [];
			let previous = fact.afterGenerationId as GenerationId | null;
			for (const raw of fact.generationRecords) {
				const bytes = copyFactBytes(raw);
				if (bytes === undefined) return undefined;
				const decoded = decodeGenerationRecordV1(bytes);
				if (
					!decoded.ok ||
					decoded.value.objectId !== fact.objectId ||
					(previous !== null && decoded.value.generationId <= previous)
				)
					return undefined;
				records.push(decoded.value);
				previous = decoded.value.generationId;
			}
			loaded.pages.set(fact.objectId, { afterGenerationId: fact.afterGenerationId as GenerationId | null, records });
			continue;
		}
		if (isClosedRecord(fact, ["kind", "digest", "bytes"]) && fact.kind === "blob") {
			if (!isBlobDigest(fact.digest) || loaded.blobs.has(fact.digest)) return undefined;
			if (fact.bytes === null) loaded.blobs.set(fact.digest, { digest: fact.digest, bytes: null });
			else {
				const bytes = copyFactBytes(fact.bytes);
				if (bytes === undefined) return undefined;
				loaded.blobs.set(fact.digest, { digest: fact.digest, bytes });
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
			const value = fact as { objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest };
			const key = promotionKey(value);
			if (loaded.promotions.has(key)) return undefined;
			loaded.promotions.set(key, value);
			continue;
		}
		return undefined;
	}
	return exactFacts(command, loaded) ? loaded : undefined;
}
function exactFacts(command: StorageAdapterCommand, facts: LoadedFacts): boolean {
	if (command.kind === "readHead")
		return (
			facts.heads.size === 1 &&
			facts.heads.has(command.objectId) &&
			facts.generations.size === 0 &&
			facts.pages.size === 0 &&
			facts.blobs.size === 0 &&
			facts.promotions.size === 0
		);
	if (command.kind === "readGenerationPage") {
		const page = facts.pages.get(command.objectId);
		const cursor = command.cursor === undefined ? undefined : decodeGenerationPageCursor(command.cursor);
		return (
			page !== undefined &&
			facts.pages.size === 1 &&
			facts.heads.size === 0 &&
			facts.generations.size === 0 &&
			facts.blobs.size === 0 &&
			facts.promotions.size === 0 &&
			page.afterGenerationId === (cursor?.generationId ?? null) &&
			page.records.length <= command.limit + 1
		);
	}
	if (command.kind === "getBlob")
		return (
			facts.blobs.size === 1 &&
			facts.blobs.has(command.digest) &&
			facts.heads.size === 0 &&
			facts.generations.size === 0 &&
			facts.pages.size === 0 &&
			facts.promotions.size === 0
		);
	if (!facts.generations.has(generationKey(command.objectId, command.generationId)) || facts.pages.size !== 0)
		return false;
	if (facts.heads.size !== 1 || !facts.heads.has(command.objectId)) return false;
	const blobCommand = command.kind === "putCachedBlob" || command.kind === "promoteReference" ? command : undefined;
	if (
		facts.blobs.size !== (blobCommand === undefined ? 0 : 1) ||
		(blobCommand !== undefined && !facts.blobs.has(blobCommand.digest))
	)
		return false;
	const promotionCount = command.kind === "promoteReference" && facts.promotions.has(promotionKey(command)) ? 1 : 0;
	if (facts.promotions.size !== promotionCount) return false;
	if (command.kind === "swapHead") {
		const head = facts.heads.get(command.objectId);
		const dynamic = head?.kind === "present" && head.generationId !== command.generationId ? head.generationId : null;
		return (
			facts.generations.size === 1 + (dynamic === null ? 0 : 1) &&
			(dynamic === null || facts.generations.has(generationKey(command.objectId, dynamic)))
		);
	}
	return facts.generations.size === 1;
}
function seedOwner(command: StorageAdapterCommand, loaded: LoadedFacts): TransitionOwner {
	const owner = new TransitionOwner("strict");
	if ("objectId" in command)
		owner.seedObjectState({
			head: loaded.heads.get(command.objectId) ?? { kind: "none", objectId: command.objectId },
			generations: [...loaded.generations.values()].filter((value): value is GenerationRecord => value !== null),
		});
	for (const blob of loaded.blobs.values()) if (blob.bytes !== null) owner.seedBlob(blob.digest, blob.bytes);
	for (const value of loaded.promotions.values()) owner.markPromoted(value.objectId, value.generationId, value.digest);
	return owner;
}

/**
 * Evaluates a detached command over exact bounded facts.
 * @param prepared - Canonical prepared command and its exact load requirements.
 * @param facts - Detached facts loaded for those requirements.
 * @param authorization - Optional opaque candidate-closure authorization.
 * @returns The stable result and bounded persistence writes.
 */
export function evaluateStorageAdapterCommand(
	prepared: PreparedStorageAdapterCommand,
	facts: readonly StorageAdapterFact[],
	authorization?: unknown
): StorageAdapterEvaluation {
	const canonical = canonicalPrepared(prepared);
	if (canonical === undefined) return invalidEvaluation();
	if (
		isClosedArray(facts) &&
		facts.length === 1 &&
		isClosedRecord(facts[0], ["kind"]) &&
		facts[0].kind === "store-closed"
	)
		return { result: { ok: false, reason: "STORE_CLOSED" }, writes: EMPTY_WRITES };
	const loaded = loadFacts(canonical.command, facts);
	if (loaded === undefined) return invalidEvaluation();
	const owner = seedOwner(canonical.command, loaded);
	const command = canonical.command;
	let result: StoreResult<StorageAdapterResultValue>;
	if (command.kind === "readHead") {
		const head = loaded.heads.get(command.objectId);
		result = head === undefined ? { ok: false, reason: "INVALID_ARGUMENT" } : { ok: true, value: head };
	} else if (command.kind === "readGenerationPage") {
		const page = loaded.pages.get(command.objectId);
		if (page === undefined) result = { ok: false, reason: "INVALID_ARGUMENT" };
		else {
			const generations = page.records.slice(0, command.limit);
			const last = generations.at(-1);
			result = {
				ok: true,
				value: {
					generations,
					nextCursor:
						page.records.length > command.limit && last !== undefined
							? encodeGenerationPageCursor(command.objectId, last.generationId)
							: null,
				},
			};
		}
	} else if (command.kind === "getBlob") result = owner.getBlob(command.digest);
	else if (command.kind === "beginGeneration")
		result = owner.beginGeneration({
			objectId: command.objectId,
			generationId: command.generationId,
			baseExpectedHead: command.baseExpectedHead,
			closure: command.closure,
		});
	else if (command.kind === "putCachedBlob")
		result = owner.putCachedBlob({
			objectId: command.objectId,
			generationId: command.generationId,
			digest: command.digest,
			bytes: command.bytes,
		});
	else if (command.kind === "promoteReference")
		result = owner.promoteReference({
			objectId: command.objectId,
			generationId: command.generationId,
			digest: command.digest,
		});
	else if (command.kind === "completeGeneration")
		result = owner.completeGenerationAuthorized(
			{ objectId: command.objectId, generationId: command.generationId },
			authorization as Authorization
		);
	else if (command.kind === "swapHead")
		result = owner.swapHeadAuthorized(
			{ objectId: command.objectId, generationId: command.generationId, expectedHead: command.expectedHead },
			authorization as Authorization
		);
	else result = owner.discardGeneration({ objectId: command.objectId, generationId: command.generationId });
	if (!result.ok) return { result, writes: EMPTY_WRITES };
	const writes: StorageAdapterWrite[] = [];
	if (command.kind === "putCachedBlob" && (result.value as { inserted: boolean }).inserted)
		writes.push({ kind: "insert-blob", digest: command.digest, bytes: new Uint8Array(command.bytes) });
	else if (command.kind === "promoteReference" && !loaded.promotions.has(promotionKey(command)))
		writes.push({
			kind: "insert-promotion",
			objectId: command.objectId,
			generationId: command.generationId,
			digest: command.digest,
		});
	else if (
		command.kind === "beginGeneration" ||
		command.kind === "completeGeneration" ||
		command.kind === "discardGeneration"
	)
		writes.push(generationWrite(result.value as GenerationRecord));
	else if (command.kind === "swapHead") {
		const swap = result.value as {
			head: Exclude<ExpectedHead, { kind: "none" }>;
			supersededGenerationId: GenerationId | null;
		};
		if (swap.supersededGenerationId !== null) {
			const previous = owner.readGenerationRecord(command.objectId, swap.supersededGenerationId);
			if (!previous.ok || previous.value === null) return invalidEvaluation();
			writes.push(generationWrite(previous.value));
		}
		const candidate = owner.readGenerationRecord(command.objectId, command.generationId);
		if (!candidate.ok || candidate.value === null) return invalidEvaluation();
		writes.push(generationWrite(candidate.value), {
			kind: "replace-head",
			objectId: command.objectId,
			record: encodeHeadRecordV1(swap.head),
		});
	}
	return { result, writes: Object.freeze(writes) };
}
function generationWrite(generation: GenerationRecord): StorageAdapterWrite {
	return {
		kind: "replace-generation",
		objectId: generation.objectId,
		generationId: generation.generationId,
		record: encodeGenerationRecordV1(generation),
	};
}
function invalidEvaluation(): StorageAdapterEvaluation {
	return { result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: EMPTY_WRITES };
}
function requirementKey(requirement: StorageAdapterLoadRequirement): string {
	switch (requirement.kind) {
		case "head":
			return `head\0${requirement.objectId}`;
		case "generation":
			return `generation\0${requirement.objectId}\0${requirement.generationId}`;
		case "generation-page":
			return `generation-page\0${requirement.objectId}\0${requirement.afterGenerationId ?? ""}\0${requirement.limitPlusOne}`;
		case "blob":
			return `blob\0${requirement.digest}`;
		case "promotion":
			return `promotion\0${requirement.objectId}\0${requirement.generationId}\0${requirement.digest}`;
	}
}
function isRequirement(value: unknown): value is StorageAdapterLoadRequirement {
	if (isClosedRecord(value, ["kind", "objectId"]) && value.kind === "head") return isStorageObjectId(value.objectId);
	if (isClosedRecord(value, ["kind", "objectId", "generationId"]) && value.kind === "generation")
		return isStorageObjectId(value.objectId) && isGenerationId(value.generationId);
	if (
		isClosedRecord(value, ["kind", "objectId", "afterGenerationId", "limitPlusOne"]) &&
		value.kind === "generation-page"
	)
		return (
			isStorageObjectId(value.objectId) &&
			(value.afterGenerationId === null || isGenerationId(value.afterGenerationId)) &&
			typeof value.limitPlusOne === "number" &&
			Number.isSafeInteger(value.limitPlusOne) &&
			value.limitPlusOne >= 2 &&
			value.limitPlusOne <= MAX_GENERATION_PAGE_ROWS + 1
		);
	if (isClosedRecord(value, ["kind", "digest"]) && value.kind === "blob") return isBlobDigest(value.digest);
	return (
		isClosedRecord(value, ["kind", "objectId", "generationId", "digest"]) &&
		value.kind === "promotion" &&
		isStorageObjectId(value.objectId) &&
		isGenerationId(value.generationId) &&
		isBlobDigest(value.digest)
	);
}
function canonicalPrepared(value: unknown): PreparedStorageAdapterCommand | undefined {
	if (!isClosedRecord(value, ["command", "requirements"]) || !isClosedArray(value.requirements)) return undefined;
	const prepared = prepareStorageAdapterCommand(value.command);
	if (!prepared.ok || prepared.value.requirements.length !== value.requirements.length) return undefined;
	for (let index = 0; index < prepared.value.requirements.length; index++) {
		const supplied = value.requirements[index];
		const expected = prepared.value.requirements[index];
		if (expected === undefined || !isRequirement(supplied) || requirementKey(supplied) !== requirementKey(expected))
			return undefined;
	}
	return prepared.value;
}

// recoverActiveGeneration is the mandatory backend transaction owner; the
// controller above supplies its one-reference-at-a-time closure verification.
