import { classifyPersistedState } from "./persisted-state.js";
import { AHE_BOUNDED_READ_LIMITS as LIMITS } from "../types.js";
import type {
	AheBoundedReadAcquisition,
	AheBoundedReadInput,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	PresentHead,
	StorageObjectId,
	StoreResult,
} from "../types.js";
import { digestBlob } from "../values.js";
import { hasSharedBacking, headsEqual, isClosedRecord, isGenerationId, isStorageObjectId } from "./validation.js";

/** Native scalar guards use this marker without projecting an oversized value. */
export class BoundedReadBudgetError extends Error {}

export type BoundedReadRequest =
	| Readonly<{ kind: "head"; objectId: StorageObjectId }>
	| Readonly<{ kind: "keys"; objectId: StorageObjectId }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; generationId: GenerationId }>
	| Readonly<{ kind: "promotion"; objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>
	| Readonly<{ kind: "blob"; digest: BlobDigest }>
	| Readonly<{ kind: "blob-preflight"; references: readonly GenerationRef[] }>;

export type BoundedReadObservation = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
	blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
}>;

/**
 * Capture exact closed arguments before scheduling native work.
 * @param value - Untrusted closed acquisition arguments.
 * @returns Detached immutable arguments or pre-I/O refusal.
 */
export function prepareBoundedRead(value: unknown): StoreResult<AheBoundedReadInput> {
	if (
		!isClosedRecord(value, ["objectId", "ancestorCount", "limits"]) ||
		!isStorageObjectId(value.objectId) ||
		(value.ancestorCount !== 0 && value.ancestorCount !== 2) ||
		!isClosedRecord(value.limits, Object.keys(LIMITS))
	)
		return { ok: false, reason: "INVALID_ARGUMENT" };
	for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[])
		if (value.limits[key] !== LIMITS[key]) return { ok: false, reason: "INVALID_ARGUMENT" };
	return {
		ok: true,
		value: Object.freeze({ objectId: value.objectId, ancestorCount: value.ancestorCount, limits: LIMITS }),
	};
}

/**
 * Only actual persisted integrity failures latch the existing owner.
 * @param result - Terminal bounded observation result.
 * @returns Whether the existing integrity latch must apply.
 */
export function isBoundedReadCorruption(result: StoreResult<unknown>): boolean {
	return (
		!result.ok &&
		[
			"NON_CANONICAL_RECORD",
			"UNSUPPORTED_STORAGE_SCHEMA",
			"ILLEGAL_TRANSITION",
			"BASE_HEAD_MISMATCH",
			"HEAD_CONFLICT",
			"GENERATION_NOT_FOUND",
			"BLOB_CORRUPT",
			"ADOPTED_BLOB_UNPROMOTED",
			"ADOPTED_BLOB_MISSING",
			"ADOPTED_BLOB_CORRUPT",
		].includes(result.reason)
	);
}

/**
 * Same bounded persisted classifier for acquisition and freshness.
 * @param objectId - Exact physical object scope.
 * @yields One bounded head request.
 * @returns Shared classified head or refusal.
 */
export function* boundedHeadSteps(
	objectId: StorageObjectId
): Generator<BoundedReadRequest, StoreResult<ExpectedHead>, unknown> {
	const raw = yield { kind: "head", objectId };
	if (raw !== null && !isClosedRecord(raw, ["objectId", "record"]))
		return { ok: false, reason: "NON_CANONICAL_RECORD" };
	const result = classifyPersistedState(
		{ kind: "head", objectId, row: raw === null ? null : { objectId: raw.objectId, record: raw.record } },
		"bounded-active-read"
	);
	return result.ok && result.value.kind === "head"
		? { ok: true, value: result.value.head }
		: (result as StoreResult<ExpectedHead>);
}

/**
 * Serial request protocol; each backend drives it within one native snapshot.
 * @param input - Synchronously captured approved observer request.
 * @yields Each bounded exact native request serially.
 * @returns Complete selected data or whole refusal.
 */
export function* boundedActiveReadSteps(
	input: AheBoundedReadInput
): Generator<BoundedReadRequest, StoreResult<BoundedReadObservation>, unknown> {
	const headResult = yield* boundedHeadSteps(input.objectId);
	if (!headResult.ok) return headResult;
	const head = headResult.value;
	const keys = yield { kind: "keys", objectId: input.objectId };
	if (!Array.isArray(keys)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
	for (const key of keys) if (!isGenerationId(key)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
	if (keys.length > LIMITS.maxObjectGenerations) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	const selected: GenerationRecord[] = [];
	const visited = new Set<GenerationId>();
	function* read(id: GenerationId): Generator<BoundedReadRequest, StoreResult<GenerationRecord>, unknown> {
		const raw = yield { kind: "generation", objectId: input.objectId, generationId: id };
		if (raw === null) return { ok: false, reason: "GENERATION_NOT_FOUND" };
		if (!isClosedRecord(raw, ["objectId", "generationId", "record"]))
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		const classified = classifyPersistedState(
			{
				kind: "generation",
				objectId: input.objectId,
				row: { objectId: raw.objectId, generationId: raw.generationId, record: raw.record },
			},
			"bounded-active-read"
		);
		return classified.ok && classified.value.kind === "generation"
			? { ok: true, value: classified.value.generation }
			: (classified as StoreResult<GenerationRecord>);
	}
	if (head.kind === "present") {
		let expected = head;
		for (let index = 0; index <= input.ancestorCount; index++) {
			if (visited.has(expected.generationId)) return { ok: false, reason: "BASE_HEAD_MISMATCH" };
			const record = yield* read(expected.generationId);
			if (!record.ok) return record;
			const generation = record.value;
			if (generation.state !== (index === 0 ? "Adopted" : "Superseded"))
				return { ok: false, reason: "ILLEGAL_TRANSITION" };
			if (generation.closureDigest !== expected.closureDigest) return { ok: false, reason: "HEAD_CONFLICT" };
			selected.push(generation);
			visited.add(generation.generationId);
			if (index < input.ancestorCount) {
				const base = generation.baseExpectedHead;
				if (base.kind !== "present" || base.revision + 1 !== expected.revision)
					return { ok: false, reason: "BASE_HEAD_MISMATCH" };
				expected = base;
			}
		}
	}
	let adoptedCount = head.kind === "present" ? 1 : 0;
	for (const id of keys as GenerationId[]) {
		if (visited.has(id)) continue;
		const record = yield* read(id);
		if (!record.ok) return record;
		if (record.value.state === "Adopted") adoptedCount++;
	}
	if (adoptedCount !== (head.kind === "present" ? 1 : 0)) return { ok: false, reason: "ILLEGAL_TRANSITION" };
	const unique = new Map<BlobDigest, GenerationRef>();
	let union = 0;
	for (const generation of selected)
		for (const ref of generation.closure) {
			if (ref.byteLength > LIMITS.maxBlobBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			const prior = unique.get(ref.digest);
			if (prior !== undefined) {
				if (prior.byteLength !== ref.byteLength) return { ok: false, reason: "BLOB_CORRUPT" };
			} else {
				union += ref.byteLength;
				if (union > LIMITS.maxUnionBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
				unique.set(ref.digest, ref);
			}
		}
	for (const generation of selected)
		for (const ref of generation.closure) {
			const promoted = yield {
				kind: "promotion",
				objectId: input.objectId,
				generationId: generation.generationId,
				digest: ref.digest,
			};
			if (promoted !== true) return { ok: false, reason: "ADOPTED_BLOB_UNPROMOTED" };
		}
	const blobs: Array<Readonly<{ ref: GenerationRef; bytes: Uint8Array }>> = [];
	// SQLite can preflight scalar lengths without requesting values. IDB cannot
	// avoid its native structured clone and admits each exact get immediately below.
	const admitted = yield { kind: "blob-preflight", references: [...unique.values()] };
	if (admitted !== true) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	for (const ref of unique.values()) {
		const raw = yield { kind: "blob", digest: ref.digest };
		if (raw === null) return { ok: false, reason: "ADOPTED_BLOB_MISSING" };
		if (!(raw instanceof Uint8Array) || hasSharedBacking(raw)) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		if (raw.byteLength > LIMITS.maxBlobBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		if (raw.byteLength !== ref.byteLength) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		const digest = digestBlob(raw);
		if (!digest.ok || digest.value !== ref.digest) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		blobs.push(Object.freeze({ ref: Object.freeze({ ...ref }), bytes: new Uint8Array(raw) }));
	}
	return { ok: true, value: { head, generations: selected, blobs } };
}

/**
 * Detached public output and private freshness/release identity, with no native lease.
 * @param observation - Complete data from one successful native snapshot.
 * @param check - Owner-scheduled bounded freshness observation.
 * @returns Frozen structural output with independent handle lifetime.
 */
export function createBoundedReadAcquisition(
	observation: BoundedReadObservation,
	check: (head: PresentHead, released: () => boolean) => Promise<StoreResult<ExpectedHead>>
): AheBoundedReadAcquisition {
	if (observation.head.kind === "none")
		return Object.freeze({ kind: "empty", head: Object.freeze({ ...observation.head }) });
	const captured = Object.freeze({ ...observation.head });
	let released = false;
	const checks = new Set<Promise<unknown>>();
	const generations = Object.freeze(
		observation.generations.map((generation) =>
			Object.freeze({
				...generation,
				baseExpectedHead: Object.freeze({ ...generation.baseExpectedHead }),
				closure: Object.freeze(generation.closure.map((ref) => Object.freeze({ ...ref }))),
			})
		)
	);
	const reader = Object.freeze({
		head: Object.freeze({ ...captured }),
		generations,
		blobs: Object.freeze(observation.blobs),
		checkCurrent(): Promise<StoreResult<Readonly<{ kind: "current" }>>> {
			let resolveCheck!: (result: StoreResult<Readonly<{ kind: "current" }>>) => void;
			let rejectCheck!: (cause: unknown) => void;
			const pending = new Promise<StoreResult<Readonly<{ kind: "current" }>>>((resolve, reject) => {
				resolveCheck = resolve;
				rejectCheck = reject;
			});
			checks.add(pending);
			void pending.then(
				() => checks.delete(pending),
				() => checks.delete(pending)
			);
			try {
				void check(captured, () => released).then(
					(result) =>
						resolveCheck(
							!result.ok
								? result
								: headsEqual(captured, result.value)
									? { ok: true, value: Object.freeze({ kind: "current" }) }
									: { ok: false, reason: "READ_STALE_HEAD" }
						),
					rejectCheck
				);
			} catch (cause) {
				rejectCheck(cause);
			}
			return pending;
		},
		release(): Promise<void> {
			released = true;
			return Promise.all([...checks]).then(() => undefined);
		},
	});
	return Object.freeze({ kind: "present", reader });
}
