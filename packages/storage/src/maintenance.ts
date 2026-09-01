import {
	copyExpectedHead,
	copyGenerationRecord,
	hasSharedBacking,
	headsEqual,
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
	GenerationRecord,
	PresentHead,
	StorageObjectId,
} from "./types.js";
import { digestBlob, digestClosure } from "./values.js";

export const AHE_RECLAMATION_LOCAL_ONLY_POLICY_DIGEST =
	"53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";

export const AHE_RECLAMATION_ERROR_CODES = Object.freeze([
	"AHE_RECLAMATION_INVALID_ARGUMENT",
	"AHE_RECLAMATION_RETRY_REQUIRED",
	"AHE_RECLAMATION_CORRUPT",
	"AHE_RECLAMATION_STORE_CLOSED",
	"AHE_RECLAMATION_STORE_POISONED",
	"AHE_RECLAMATION_SUBSTRATE_FAILURE",
] as const);

export type AheReclamationErrorCode = (typeof AHE_RECLAMATION_ERROR_CODES)[number];

export type AheReclamationInput = Readonly<{
	activeGenerationId: GenerationId;
	availabilityPolicyDigest: string;
	closedEpoch: number;
	expectedHead: PresentHead;
	lineageFloor: Readonly<{
		deleteGenerationIds: readonly GenerationId[];
		expectedBaseExpectedHead: ExpectedHead;
		generationId: GenerationId;
		replacementBaseExpectedHead: Readonly<{ kind: "none"; objectId: StorageObjectId }>;
	}>;
	objectId: StorageObjectId;
	rollbackGenerationIds: readonly [GenerationId, GenerationId];
}>;

export type AheReclamationReceipt = Readonly<{
	activeGenerationId: GenerationId;
	availabilityPolicyDigest: string;
	closedEpoch: number;
	deletedBlobDigests: readonly BlobDigest[];
	deletedGenerationIds: readonly GenerationId[];
	deletedPromotionCount: number;
	expectedHead: PresentHead;
	floor: Readonly<{
		expectedFormerBaseExpectedHead: ExpectedHead;
		generationId: GenerationId;
		normalizedThisCall: boolean;
		replacementBaseExpectedHead: Readonly<{ kind: "none"; objectId: StorageObjectId }>;
	}>;
	objectId: StorageObjectId;
	reclaimedGenerationIds: readonly GenerationId[];
	rollbackGenerationIds: readonly [GenerationId, GenerationId];
}>;

export interface AheReclamationMaintenance {
	reclaimClosedEpoch(input: unknown): Promise<AheReclamationReceipt>;
}

export type AheReclamationPromotion = Readonly<{
	digest: BlobDigest;
	generationId: GenerationId;
	objectId: StorageObjectId;
}>;

export type AheReclamationBlobObservation = Readonly<{
	bytes: Uint8Array;
	digest: BlobDigest;
}>;

export type AheReclamationSnapshot = Readonly<{
	blobs: readonly AheReclamationBlobObservation[];
	generations: readonly GenerationRecord[];
	head: ExpectedHead;
	promotions: readonly AheReclamationPromotion[];
}>;

export type AheReclamationDecision = Readonly<{
	deleteBlobDigests: readonly BlobDigest[];
	deleteGenerationIds: readonly GenerationId[];
	deletePromotions: readonly AheReclamationPromotion[];
	floor: Readonly<{
		generation: GenerationRecord;
		normalizedThisCall: boolean;
		rewrittenGeneration: GenerationRecord;
	}>;
	input: AheReclamationInput;
}>;

/** Closed reclamation failure shared by the strict native owners. */
export class AheReclamationError extends Error {
	readonly code: AheReclamationErrorCode;

	/**
	 * Creates one classified reclamation failure.
	 * @param code - Closed public error code.
	 * @param message - Stable diagnostic summary.
	 * @param options - Optional substrate cause.
	 */
	constructor(code: AheReclamationErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		Object.defineProperty(this, "name", { configurable: true, value: "AheReclamationError" });
	}
}

function failure(code: AheReclamationErrorCode, message: string, cause?: unknown): AheReclamationError {
	return Object.freeze(new AheReclamationError(code, message, cause === undefined ? undefined : { cause }));
}

function invalid(message: string): never {
	throw failure("AHE_RECLAMATION_INVALID_ARGUMENT", message);
}

function retry(message: string): never {
	throw failure("AHE_RECLAMATION_RETRY_REQUIRED", message);
}

function corrupt(message: string): never {
	throw failure("AHE_RECLAMATION_CORRUPT", message);
}

function cloneHead(head: ExpectedHead): ExpectedHead {
	return Object.freeze({ ...head });
}

function cloneGeneration(generation: GenerationRecord): GenerationRecord {
	return Object.freeze({
		...generation,
		baseExpectedHead: cloneHead(generation.baseExpectedHead),
		closure: Object.freeze(generation.closure.map((reference) => Object.freeze({ ...reference }))),
	});
}

function copyGenerationIds(value: unknown): readonly GenerationId[] {
	if (!isClosedArray(value)) invalid("deleteGenerationIds must be one exact dense array");
	const ids: GenerationId[] = [];
	for (const candidate of value) {
		if (!isGenerationId(candidate)) invalid("deleteGenerationIds must contain canonical generation IDs");
		ids.push(candidate);
	}
	if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= (ids[index - 1] ?? id))) {
		invalid("deleteGenerationIds must be unique and canonically ordered");
	}
	return Object.freeze(ids);
}

function copyRollbackIds(value: unknown): readonly [GenerationId, GenerationId] {
	if (!isClosedArray(value) || value.length !== 2 || !isGenerationId(value[0]) || !isGenerationId(value[1])) {
		invalid("rollbackGenerationIds must contain exactly two canonical IDs");
	}
	if (value[0] === value[1]) invalid("rollbackGenerationIds must be distinct");
	return Object.freeze([value[0], value[1]] as const);
}

/**
 * Validates, detaches, and deeply freezes the AHE subset emitted by D.109a.
 * @param value - Untrusted reclamation request.
 * @returns Exact captured maintenance input.
 */
export function captureAheReclamationInput(value: unknown): AheReclamationInput {
	try {
		if (
			!isClosedRecord(value, [
				"activeGenerationId",
				"availabilityPolicyDigest",
				"closedEpoch",
				"expectedHead",
				"lineageFloor",
				"objectId",
				"rollbackGenerationIds",
			]) ||
			!isStorageObjectId(value.objectId) ||
			!isGenerationId(value.activeGenerationId) ||
			value.availabilityPolicyDigest !== AHE_RECLAMATION_LOCAL_ONLY_POLICY_DIGEST ||
			!Number.isSafeInteger(value.closedEpoch) ||
			Number(value.closedEpoch) < 0 ||
			!isClosedRecord(value.lineageFloor, [
				"deleteGenerationIds",
				"expectedBaseExpectedHead",
				"generationId",
				"replacementBaseExpectedHead",
			]) ||
			!isGenerationId(value.lineageFloor.generationId)
		) {
			invalid("reclamation input must be one exact validated record");
		}
		const expectedHead = copyExpectedHead(value.expectedHead, value.objectId);
		const expectedBaseExpectedHead = copyExpectedHead(value.lineageFloor.expectedBaseExpectedHead, value.objectId);
		const replacementBaseExpectedHead = copyExpectedHead(
			value.lineageFloor.replacementBaseExpectedHead,
			value.objectId
		);
		if (
			expectedHead?.kind !== "present" ||
			expectedHead.generationId !== value.activeGenerationId ||
			expectedBaseExpectedHead === undefined ||
			replacementBaseExpectedHead?.kind !== "none"
		) {
			invalid("reclamation input identities must agree");
		}
		const rollbackGenerationIds = copyRollbackIds(value.rollbackGenerationIds);
		const deleteGenerationIds = copyGenerationIds(value.lineageFloor.deleteGenerationIds);
		if (deleteGenerationIds.length === 0 && expectedBaseExpectedHead.kind === "present") {
			invalid("an empty reclamation prefix cannot retain a former floor parent");
		}
		const retained = new Set<GenerationId>([
			value.activeGenerationId,
			rollbackGenerationIds[0],
			rollbackGenerationIds[1],
		]);
		if (
			retained.size !== 3 ||
			value.lineageFloor.generationId !== rollbackGenerationIds[1] ||
			deleteGenerationIds.some((generationId) => retained.has(generationId))
		) {
			invalid("reclamation input generations must be disjoint and floor-bound");
		}
		return Object.freeze({
			activeGenerationId: value.activeGenerationId,
			availabilityPolicyDigest: value.availabilityPolicyDigest,
			closedEpoch: Number(value.closedEpoch),
			expectedHead: cloneHead(expectedHead) as PresentHead,
			lineageFloor: Object.freeze({
				deleteGenerationIds,
				expectedBaseExpectedHead: cloneHead(expectedBaseExpectedHead),
				generationId: value.lineageFloor.generationId,
				replacementBaseExpectedHead: cloneHead(replacementBaseExpectedHead) as Readonly<{
					kind: "none";
					objectId: StorageObjectId;
				}>,
			}),
			objectId: value.objectId,
			rollbackGenerationIds,
		});
	} catch (error) {
		if (error instanceof AheReclamationError) throw error;
		throw failure("AHE_RECLAMATION_INVALID_ARGUMENT", "reclamation input could not be inspected", error);
	}
}

function generationKey(objectId: StorageObjectId, generationId: GenerationId): string {
	return `${objectId}\0${generationId}`;
}

function promotionKey(promotion: AheReclamationPromotion): string {
	return `${promotion.objectId}\0${promotion.generationId}\0${promotion.digest}`;
}

function copyPromotions(value: unknown): readonly AheReclamationPromotion[] {
	if (!isClosedArray(value)) corrupt("promotion scan was not a dense array");
	const promotions: AheReclamationPromotion[] = [];
	const keys = new Set<string>();
	for (const candidate of value) {
		if (
			!isClosedRecord(candidate, ["digest", "generationId", "objectId"]) ||
			!isStorageObjectId(candidate.objectId) ||
			!isGenerationId(candidate.generationId) ||
			!isBlobDigest(candidate.digest)
		) {
			corrupt("promotion scan contained a malformed row");
		}
		const promotion = Object.freeze({
			digest: candidate.digest,
			generationId: candidate.generationId,
			objectId: candidate.objectId,
		});
		const key = promotionKey(promotion);
		if (keys.has(key)) corrupt("promotion scan contained a duplicate row");
		keys.add(key);
		promotions.push(promotion);
	}
	return Object.freeze(promotions);
}

function copyGenerations(value: unknown): readonly GenerationRecord[] {
	if (!isClosedArray(value)) corrupt("generation scan was not a dense array");
	const generations: GenerationRecord[] = [];
	const keys = new Set<string>();
	for (const candidate of value) {
		const generation = copyGenerationRecord(candidate);
		if (generation === undefined) corrupt("generation scan contained a malformed row");
		const key = generationKey(generation.objectId, generation.generationId);
		if (keys.has(key)) corrupt("generation scan contained a duplicate identity");
		keys.add(key);
		const recomputed = digestClosure(generation.closure);
		if (!recomputed.ok || recomputed.value !== generation.closureDigest) {
			corrupt("generation scan contained an invalid closure digest");
		}
		generations.push(cloneGeneration(generation));
	}
	return Object.freeze(generations);
}

function copyBlobFacts(value: unknown): ReadonlyMap<BlobDigest, Readonly<{ byteLength: number; valid: boolean }>> {
	if (!isClosedArray(value)) corrupt("blob observation scan was not a dense array");
	const blobs = new Map<BlobDigest, Readonly<{ byteLength: number; valid: boolean }>>();
	for (const candidate of value) {
		if (
			!isClosedRecord(candidate, ["bytes", "digest"]) ||
			!isBlobDigest(candidate.digest) ||
			!(candidate.bytes instanceof Uint8Array) ||
			hasSharedBacking(candidate.bytes) ||
			blobs.has(candidate.digest)
		) {
			corrupt("blob observation scan contained a malformed or duplicate row");
		}
		const recomputed = digestBlob(candidate.bytes);
		blobs.set(
			candidate.digest,
			Object.freeze({
				byteLength: candidate.bytes.byteLength,
				valid: recomputed.ok && recomputed.value === candidate.digest,
			})
		);
	}
	return blobs;
}

function verifyPromotionsAndBlobs(
	generations: readonly GenerationRecord[],
	promotions: readonly AheReclamationPromotion[],
	blobs: ReadonlyMap<BlobDigest, Readonly<{ byteLength: number; valid: boolean }>>
): void {
	const byGeneration = new Map<string, Set<BlobDigest>>();
	const records = new Map(
		generations.map((generation) => [generationKey(generation.objectId, generation.generationId), generation])
	);
	for (const promotion of promotions) {
		const key = generationKey(promotion.objectId, promotion.generationId);
		const generation = records.get(key);
		const reference = generation?.closure.find(({ digest }) => digest === promotion.digest);
		if (generation === undefined || reference === undefined)
			corrupt("promotion did not belong to its generation closure");
		const blob = blobs.get(promotion.digest);
		if (blob === undefined || !blob.valid || blob.byteLength !== reference.byteLength) {
			corrupt("promoted blob was missing, corrupt, or had the wrong length");
		}
		const observed = byGeneration.get(key) ?? new Set<BlobDigest>();
		observed.add(promotion.digest);
		byGeneration.set(key, observed);
	}
	for (const generation of generations) {
		const observed = byGeneration.get(generationKey(generation.objectId, generation.generationId)) ?? new Set();
		const required =
			generation.state === "Complete" || generation.state === "Adopted" || generation.state === "Superseded";
		if (
			required &&
			(observed.size !== generation.closure.length || generation.closure.some(({ digest }) => !observed.has(digest)))
		) {
			corrupt("complete generation did not have its exact promotion set");
		}
	}
}

function parentMatches(child: GenerationRecord, parent: GenerationRecord, childRevision: number): boolean {
	return (
		child.baseExpectedHead.kind === "present" &&
		child.baseExpectedHead.objectId === parent.objectId &&
		child.baseExpectedHead.generationId === parent.generationId &&
		child.baseExpectedHead.closureDigest === parent.closureDigest &&
		child.baseExpectedHead.revision === childRevision - 1
	);
}

function sameIds(left: readonly GenerationId[], right: readonly GenerationId[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Produces the one pure deletion decision consumed inside native transactions.
 * @param request - Untrusted D.109a AHE subset.
 * @param snapshot - Complete decoded generation/promotion scan plus required blob observations.
 * @returns Frozen floor rewrite and exact physical deletion set.
 */
export function classifyAheReclamation(request: unknown, snapshot: AheReclamationSnapshot): AheReclamationDecision {
	const input = captureAheReclamationInput(request);
	try {
		if (!isClosedRecord(snapshot, ["blobs", "generations", "head", "promotions"])) {
			corrupt("native snapshot was not one exact record");
		}
		const head = copyExpectedHead(snapshot.head, input.objectId);
		if (head === undefined) corrupt("native head was malformed or cross-object");
		if (!headsEqual(head, input.expectedHead)) retry("head changed before reclamation");
		const generations = copyGenerations(snapshot.generations);
		const promotions = copyPromotions(snapshot.promotions);
		const blobs = copyBlobFacts(snapshot.blobs);
		verifyPromotionsAndBlobs(generations, promotions, blobs);

		const target = generations.filter(({ objectId }) => objectId === input.objectId);
		const byId = new Map(target.map((generation) => [generation.generationId, generation]));
		const active = byId.get(input.activeGenerationId);
		if (
			active === undefined ||
			active.state !== "Adopted" ||
			active.closureDigest !== input.expectedHead.closureDigest
		) {
			corrupt("active head did not bind one adopted generation");
		}
		const firstId = input.rollbackGenerationIds[0];
		const floorId = input.rollbackGenerationIds[1];
		if (active.baseExpectedHead.kind !== "present") corrupt("active generation did not retain a rollback parent");
		const first = byId.get(active.baseExpectedHead.generationId);
		if (first === undefined || first.baseExpectedHead.kind !== "present") {
			corrupt("retained rollback lineage contained a gap");
		}
		const floor = byId.get(first.baseExpectedHead.generationId);
		if (floor === undefined) corrupt("retained rollback lineage contained a gap");
		if (first.generationId !== firstId || floor.generationId !== floorId) {
			retry("planned rollback generations changed before reclamation");
		}
		if (
			first.state !== "Superseded" ||
			floor.state !== "Superseded" ||
			!parentMatches(active, first, input.expectedHead.revision) ||
			!parentMatches(first, floor, active.baseExpectedHead.revision)
		) {
			corrupt("retained rollback lineage was invalid");
		}

		const retained = new Set([active.generationId, first.generationId, floor.generationId]);
		const selected: GenerationRecord[] = [];
		let replay = false;
		let normalizedThisCall = false;
		if (headsEqual(floor.baseExpectedHead, input.lineageFloor.expectedBaseExpectedHead)) {
			normalizedThisCall = !headsEqual(
				input.lineageFloor.expectedBaseExpectedHead,
				input.lineageFloor.replacementBaseExpectedHead
			);
			let cursor = floor.baseExpectedHead;
			let expectedRevision = first.baseExpectedHead.kind === "present" ? first.baseExpectedHead.revision : 0;
			const visited = new Set<GenerationId>();
			while (cursor.kind === "present") {
				if (visited.has(cursor.generationId)) corrupt("reclamation prefix contained a cycle");
				const generation = byId.get(cursor.generationId);
				if (
					generation === undefined ||
					generation.state !== "Superseded" ||
					cursor.objectId !== input.objectId ||
					cursor.closureDigest !== generation.closureDigest ||
					cursor.revision !== expectedRevision - 1
				) {
					corrupt("reclamation prefix contained a gap or invalid parent");
				}
				visited.add(generation.generationId);
				selected.push(generation);
				expectedRevision = cursor.revision;
				cursor = generation.baseExpectedHead;
			}
			if (cursor.objectId !== input.objectId) corrupt("reclamation prefix terminated in another object");
		} else if (headsEqual(floor.baseExpectedHead, input.lineageFloor.replacementBaseExpectedHead)) {
			replay = true;
			if (input.lineageFloor.deleteGenerationIds.some((generationId) => byId.has(generationId))) {
				corrupt("normalized floor retained part of the requested prefix");
			}
		} else {
			retry("lineage floor changed before reclamation");
		}

		const selectedIds = selected.map(({ generationId }) => generationId).sort();
		if (!replay && !sameIds(selectedIds, input.lineageFloor.deleteGenerationIds)) {
			retry("requested generation prefix no longer matches the complete lineage");
		}
		const extras = target.filter(
			({ generationId }) => !retained.has(generationId) && !selectedIds.includes(generationId)
		);
		if (extras.length !== 0) {
			const requestedPrefix = new Set(input.lineageFloor.deleteGenerationIds);
			if (
				replay &&
				extras.some(
					({ baseExpectedHead }) =>
						baseExpectedHead.kind === "present" && requestedPrefix.has(baseExpectedHead.generationId)
				)
			) {
				corrupt("normalized replay retained a dangling parent into the reclaimed prefix");
			}
			retry("target generation set changed before reclamation");
		}

		const selectedSet = new Set(selectedIds);
		const deletePromotions = promotions.filter(
			({ generationId, objectId }) => objectId === input.objectId && selectedSet.has(generationId)
		);
		const candidateDigests = new Set(deletePromotions.map(({ digest }) => digest));
		const remainingGenerationReferences = new Set(
			generations
				.filter(({ generationId, objectId }) => objectId !== input.objectId || !selectedSet.has(generationId))
				.flatMap(({ closure }) => closure.map(({ digest }) => digest))
		);
		const remainingPromotionReferences = new Set(
			promotions
				.filter(({ generationId, objectId }) => objectId !== input.objectId || !selectedSet.has(generationId))
				.map(({ digest }) => digest)
		);
		const deleteBlobDigests = [...candidateDigests]
			.filter((digest) => !remainingGenerationReferences.has(digest) && !remainingPromotionReferences.has(digest))
			.sort();
		const rewrittenGeneration = cloneGeneration({
			...floor,
			baseExpectedHead: input.lineageFloor.replacementBaseExpectedHead,
		});
		return Object.freeze({
			deleteBlobDigests: Object.freeze(deleteBlobDigests),
			deleteGenerationIds: Object.freeze(normalizedThisCall ? selectedIds : []),
			deletePromotions: Object.freeze(normalizedThisCall ? deletePromotions : []),
			floor: Object.freeze({
				generation: cloneGeneration(floor),
				normalizedThisCall,
				rewrittenGeneration,
			}),
			input,
		});
	} catch (error) {
		if (error instanceof AheReclamationError) throw error;
		throw failure("AHE_RECLAMATION_CORRUPT", "native snapshot could not be inspected", error);
	}
}

/**
 * Constructs the detached immutable receipt after exact native row counts pass.
 * @param decision - Shared classifier decision used by the transaction.
 * @returns Frozen receipt containing actual writes for this call.
 */
export function createAheReclamationReceipt(decision: AheReclamationDecision): AheReclamationReceipt {
	const { input } = decision;
	return Object.freeze({
		activeGenerationId: input.activeGenerationId,
		availabilityPolicyDigest: input.availabilityPolicyDigest,
		closedEpoch: input.closedEpoch,
		deletedBlobDigests: Object.freeze([...decision.deleteBlobDigests]),
		deletedGenerationIds: Object.freeze([...decision.deleteGenerationIds]),
		deletedPromotionCount: decision.deletePromotions.length,
		expectedHead: cloneHead(input.expectedHead) as PresentHead,
		floor: Object.freeze({
			expectedFormerBaseExpectedHead: cloneHead(input.lineageFloor.expectedBaseExpectedHead),
			generationId: input.lineageFloor.generationId,
			normalizedThisCall: decision.floor.normalizedThisCall,
			replacementBaseExpectedHead: cloneHead(input.lineageFloor.replacementBaseExpectedHead) as Readonly<{
				kind: "none";
				objectId: StorageObjectId;
			}>,
		}),
		objectId: input.objectId,
		reclaimedGenerationIds: Object.freeze([...input.lineageFloor.deleteGenerationIds]),
		rollbackGenerationIds: Object.freeze([...input.rollbackGenerationIds]) as readonly [GenerationId, GenerationId],
	});
}

/**
 * Creates one frozen lifecycle or substrate error without widening the code set.
 * @param code - Closed error code.
 * @param message - Diagnostic summary.
 * @param cause - Optional substrate cause.
 * @returns Frozen classified error.
 */
export function createAheReclamationError(
	code: AheReclamationErrorCode,
	message: string,
	cause?: unknown
): AheReclamationError {
	return failure(code, message, cause);
}
