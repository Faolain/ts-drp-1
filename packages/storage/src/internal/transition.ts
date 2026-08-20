import type {
	ActiveGenerationSnapshot,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	PresentHead,
	StorageObjectId,
	StorageRejectionReason,
	StoreResult,
} from "../types.js";
import { acceptBlob, acceptPromotion, accepts, type Authorization, finish, next, start } from "./closure-verifier.js";
import { checkedHeadRevision, digestBlob, digestClosure } from "../values.js";
import {
	bytesEqual,
	cloneGeneration,
	cloneHead,
	compareCanonicalText,
	copyExpectedHead,
	copyGenerationRef,
	hasSharedBacking,
	headsEqual,
	isBlobDigest,
	isClosedArray,
	isClosedRecord,
	isGenerationId,
	isStorageObjectId,
} from "./validation.js";

type MutableGeneration = {
	objectId: StorageObjectId;
	generationId: GenerationId;
	baseExpectedHead: ExpectedHead;
	closureDigest: GenerationRecord["closureDigest"];
	closure: GenerationRef[];
	state: GenerationRecord["state"];
};

type MutableObject = {
	head: ExpectedHead;
	generations: Map<GenerationId, MutableGeneration>;
	generationIds: GenerationId[];
};

type SwapCandidate = Readonly<{
	object: MutableObject;
	generation: MutableGeneration;
	expectedHead: ExpectedHead;
}>;

type TransitionDurability = "ephemeral" | "strict";

const MAX_INTERNAL_GENERATION_PAGE_ROWS = 129;

/** Detached full-journal state retained for explicit reads and package-internal fixture seeding. */
export type TransitionObjectState = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
}>;

function rejected<T>(reason: Exclude<StorageRejectionReason, "SUBSTRATE_FAILURE">): StoreResult<T> {
	return { ok: false, reason };
}

function asRecord(value: MutableGeneration): GenerationRecord {
	return cloneGeneration(value);
}

function freezeRecoverySnapshot(snapshot: ActiveGenerationSnapshot): ActiveGenerationSnapshot {
	if (snapshot.kind === "empty") {
		return Object.freeze({
			...snapshot,
			head: Object.freeze({ ...snapshot.head }),
			references: Object.freeze([] as []),
		});
	}
	return Object.freeze({
		...snapshot,
		head: Object.freeze({ ...snapshot.head }),
		adoptedGeneration: Object.freeze({
			...snapshot.adoptedGeneration,
			baseExpectedHead: Object.freeze({ ...snapshot.adoptedGeneration.baseExpectedHead }),
			closure: Object.freeze(snapshot.adoptedGeneration.closure.map((reference) => Object.freeze({ ...reference }))),
		}),
		references: Object.freeze(snapshot.references.map((reference) => Object.freeze({ ...reference }))),
	});
}

/**
 * Owns the package's lifecycle, integrity and exact-CAS semantics. Runtime
 * adapters supply atomic persistence around these synchronous transitions.
 * @internal
 */
export class TransitionOwner {
	private readonly objects = new Map<StorageObjectId, MutableObject>();
	private readonly blobs = new Map<BlobDigest, Uint8Array>();
	private readonly promoted = new Set<string>();
	private closed = false;
	private poisoned = false;

	/**
	 *
	 * @param durability - Input value.
	 */
	public constructor(private readonly durability: TransitionDurability) {}

	private lifecycleFailure(): StoreResult<never> | undefined {
		if (this.closed) return rejected("STORE_CLOSED");
		if (this.poisoned) return rejected("STORE_POISONED");
		return undefined;
	}

	private latchIntegrityFailure<T>(reason: Exclude<StorageRejectionReason, "SUBSTRATE_FAILURE">): StoreResult<T> {
		this.poisoned = true;
		return rejected(reason);
	}

	/**
	 * Reads one detached head+journal snapshot.
	 * @param objectId - Input value.
	 * @returns A detached state or stable rejection.
	 */
	public readObjectState(objectId: StorageObjectId): StoreResult<TransitionObjectState> {
		if (!isStorageObjectId(objectId)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const object = this.objects.get(objectId);
		if (object === undefined) {
			return { ok: true, value: { head: { kind: "none", objectId }, generations: [] } };
		}
		return {
			ok: true,
			value: {
				head: cloneHead(object.head),
				generations: object.generationIds.map((generationId) => indexedGenerationRecord(object, generationId)),
			},
		};
	}

	/**
	 * Reads one detached head without materializing the object's journal.
	 * @param objectId - Canonical object identity.
	 * @returns The detached head or stable rejection.
	 */
	public readHead(objectId: StorageObjectId): StoreResult<ExpectedHead> {
		if (!isStorageObjectId(objectId)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const object = this.objects.get(objectId);
		return {
			ok: true,
			value: object === undefined ? { kind: "none", objectId } : cloneHead(object.head),
		};
	}

	/**
	 * Reads at most one internally bounded, detached generation page in canonical ID order.
	 * @param objectId - Canonical object identity.
	 * @param afterGenerationId - Exclusive canonical lower bound, or the beginning.
	 * @param limit - Maximum number of records to detach.
	 * @returns The detached page or stable rejection.
	 */
	public readGenerationPage(
		objectId: StorageObjectId,
		afterGenerationId: GenerationId | null,
		limit: number
	): StoreResult<readonly GenerationRecord[]> {
		if (
			!isStorageObjectId(objectId) ||
			(afterGenerationId !== null && !isGenerationId(afterGenerationId)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_INTERNAL_GENERATION_PAGE_ROWS
		) {
			return rejected("INVALID_ARGUMENT");
		}
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const object = this.objects.get(objectId);
		if (object === undefined) return { ok: true, value: [] };
		const start = firstGenerationAfter(object.generationIds, afterGenerationId);
		const end = Math.min(start + limit, object.generationIds.length);
		const generations: GenerationRecord[] = [];
		for (let index = start; index < end; index++) {
			const generationId = object.generationIds[index];
			if (generationId === undefined) throw new Error("ordered generation index is sparse");
			generations.push(indexedGenerationRecord(object, generationId));
		}
		return { ok: true, value: generations };
	}

	/**
	 * Reads one detached generation by its exact identity for command-owned write planning.
	 * @param objectId - Canonical object identity.
	 * @param generationId - Canonical generation identity.
	 * @returns The detached record, absence, or stable rejection.
	 */
	public readGenerationRecord(
		objectId: StorageObjectId,
		generationId: GenerationId
	): StoreResult<GenerationRecord | null> {
		if (!isStorageObjectId(objectId) || !isGenerationId(generationId)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const generation = this.findGeneration(objectId, generationId);
		return { ok: true, value: generation === undefined ? null : asRecord(generation) };
	}

	/**
	 * Reads fresh bytes for one global content-addressed blob.
	 * @param digest - Input value.
	 * @returns Fresh blob bytes, absence, or stable rejection.
	 */
	public getBlob(digest: BlobDigest): StoreResult<Uint8Array | null> {
		if (!isBlobDigest(digest)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const value = this.blobs.get(digest);
		return { ok: true, value: value === undefined ? null : new Uint8Array(value) };
	}

	/**
	 * Captures a new immutable Staged generation.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.baseExpectedHead - Input value.
	 * @param input.closure - Input value.
	 * @returns The staged record or stable rejection.
	 */
	public beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): StoreResult<GenerationRecord> {
		if (!isClosedRecord(input, ["objectId", "generationId", "baseExpectedHead", "closure"])) {
			return rejected("INVALID_ARGUMENT");
		}
		if (!isStorageObjectId(input.objectId) || !isGenerationId(input.generationId)) {
			return rejected("INVALID_ARGUMENT");
		}
		const baseExpectedHead = copyExpectedHead(input.baseExpectedHead, input.objectId);
		if (baseExpectedHead === undefined || !isClosedArray(input.closure)) return rejected("INVALID_ARGUMENT");
		const closure: GenerationRef[] = [];
		for (const value of input.closure) {
			const copied = copyGenerationRef(value);
			if (copied === undefined) return rejected("INVALID_ARGUMENT");
			closure.push(copied);
		}
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const existingObject = this.objects.get(input.objectId);
		if (existingObject?.generations.has(input.generationId) === true) return rejected("GENERATION_EXISTS");
		const currentHead = existingObject?.head ?? { kind: "none" as const, objectId: input.objectId };
		if (!headsEqual(currentHead, baseExpectedHead)) return rejected("BASE_HEAD_MISMATCH");
		if (closure.length === 0) return rejected("EMPTY_CLOSURE");
		closure.sort((left, right) => compareCanonicalText(left.digest, right.digest));
		for (let index = 1; index < closure.length; index++) {
			if (closure[index - 1]?.digest === closure[index]?.digest) {
				return rejected("DUPLICATE_CLOSURE_REFERENCE");
			}
		}
		const object = existingObject ?? this.object(input.objectId);
		const closureDigest = digestClosure(closure);
		if (!closureDigest.ok) return rejected("INVALID_ARGUMENT");
		const generation: MutableGeneration = {
			objectId: input.objectId,
			generationId: input.generationId,
			baseExpectedHead,
			closureDigest: closureDigest.value,
			closure,
			state: "Staged",
		};
		object.generations.set(input.generationId, generation);
		insertGenerationId(object.generationIds, input.generationId);
		return { ok: true, value: asRecord(generation) };
	}

	/**
	 * Inserts or idempotently observes one declared global cached blob.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.digest - Input value.
	 * @param input.bytes - Input value.
	 * @returns Whether insertion won or a stable rejection.
	 */
	public putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): StoreResult<{ inserted: boolean }> {
		if (typeof input !== "object" || input === null) return rejected("INVALID_ARGUMENT");
		const bytesDescriptor = Object.getOwnPropertyDescriptor(input, "bytes");
		if (
			bytesDescriptor === undefined ||
			!("value" in bytesDescriptor) ||
			!(bytesDescriptor.value instanceof Uint8Array)
		) {
			return rejected("INVALID_ARGUMENT");
		}
		if (hasSharedBacking(bytesDescriptor.value)) return rejected("SHARED_BUFFER_INPUT");
		const bytes = new Uint8Array(bytesDescriptor.value);
		if (!isClosedRecord(input, ["objectId", "generationId", "digest", "bytes"])) {
			return rejected("INVALID_ARGUMENT");
		}
		if (!isStorageObjectId(input.objectId) || !isGenerationId(input.generationId) || !isBlobDigest(input.digest)) {
			return rejected("INVALID_ARGUMENT");
		}
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged") return rejected("ILLEGAL_TRANSITION");
		if (!generation.closure.some(({ digest }) => digest === input.digest)) return rejected("BLOB_NOT_REFERENCED");
		const existing = this.blobs.get(input.digest);
		if (existing !== undefined) {
			return bytesEqual(existing, bytes) ? { ok: true, value: { inserted: false } } : rejected("IMMUTABLE_CONFLICT");
		}
		this.blobs.set(input.digest, bytes);
		return { ok: true, value: { inserted: true } };
	}

	/**
	 * Verifies one strict reference and records backend-owned promotion evidence.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.digest - Input value.
	 * @returns Success or a stable rejection.
	 */
	public promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): StoreResult<undefined> {
		if (!this.validGenerationDigestInput(input)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		if (this.durability === "ephemeral") return rejected("DURABILITY_UNAVAILABLE");
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged") return rejected("ILLEGAL_TRANSITION");
		const reference = generation.closure.find(({ digest }) => digest === input.digest);
		if (reference === undefined) return rejected("BLOB_NOT_REFERENCED");
		const blob = this.blobs.get(input.digest);
		if (blob === undefined) return rejected("BLOB_MISSING");
		if (!this.blobMatches(reference, blob)) return rejected("BLOB_CORRUPT");
		this.promoted.add(this.promotionKey(input.objectId, input.generationId, input.digest));
		return { ok: true, value: undefined };
	}

	/**
	 * Completes a staged generation only after every reference is promoted.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @returns The completed record or stable rejection.
	 */
	public completeGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): StoreResult<GenerationRecord> {
		if (!this.validGenerationInput(input)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged") return rejected("ILLEGAL_TRANSITION");
		const authorization = this.verifyGenerationClosure(generation, "candidate");
		if (!authorization.ok) return authorization;
		generation.state = "Complete";
		return { ok: true, value: asRecord(generation) };
	}

	/**
	 * Completes a staged generation using verifier-issued authority.
	 * @param input - Addressed staged generation.
	 * @param input.objectId - Canonical object identity.
	 * @param input.generationId - Canonical generation identity.
	 * @param authorization - Exact candidate-closure authorization.
	 * @returns The completed generation or stable rejection.
	 */
	public completeGenerationAuthorized(
		input: { objectId: StorageObjectId; generationId: GenerationId },
		authorization: Authorization
	): StoreResult<GenerationRecord> {
		if (!this.validGenerationInput(input)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged") return rejected("ILLEGAL_TRANSITION");
		if (!accepts(authorization, asRecord(generation), "candidate")) return rejected("INVALID_ARGUMENT");
		generation.state = "Complete";
		return { ok: true, value: asRecord(generation) };
	}

	/**
	 * Recovers and verifies the one active generation at a stable snapshot.
	 * @param objectId - Canonical object identity.
	 * @returns Frozen recovery metadata or the first integrity failure.
	 */
	public recoverActiveGeneration(objectId: StorageObjectId): StoreResult<ActiveGenerationSnapshot> {
		if (!isStorageObjectId(objectId)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;

		const object = this.objects.get(objectId);
		const head = object === undefined ? ({ kind: "none", objectId } as const) : cloneHead(object.head);
		let adoptedCount = 0;
		let adoptedGeneration: MutableGeneration | undefined;
		if (object !== undefined) {
			for (const generationId of object.generationIds) {
				const generation = indexedGeneration(object, generationId);
				if (generation.state !== "Adopted") continue;
				adoptedCount += 1;
				adoptedGeneration = adoptedCount === 1 ? generation : undefined;
			}
		}
		const relationalFailure =
			(head.kind === "none" && adoptedCount !== 0) ||
			(head.kind === "present" &&
				(adoptedCount !== 1 ||
					adoptedGeneration?.generationId !== head.generationId ||
					adoptedGeneration.closureDigest !== head.closureDigest));
		if (relationalFailure) return this.latchIntegrityFailure("NON_CANONICAL_RECORD");

		if (head.kind === "none") {
			return {
				ok: true,
				value: freezeRecoverySnapshot({
					kind: "empty",
					head,
					adoptedGeneration: null,
					recomputedClosureDigest: null,
					references: [],
				}),
			};
		}

		const generation = adoptedGeneration;
		if (generation === undefined) return this.latchIntegrityFailure("NON_CANONICAL_RECORD");
		const verification = this.verifyGenerationClosure(generation, "adopted");
		if (!verification.ok) {
			if (verification.reason === "SUBSTRATE_FAILURE") throw new Error("in-memory verifier returned substrate failure");
			return this.latchIntegrityFailure(verification.reason);
		}
		return {
			ok: true,
			value: freezeRecoverySnapshot({
				kind: "active",
				head: { ...head },
				adoptedGeneration: cloneGeneration(generation),
				recomputedClosureDigest: generation.closureDigest,
				references: generation.closure.map((reference) => ({ ...reference })),
			}),
		};
	}

	/**
	 * Atomically adopts one Complete generation under exact expected-head CAS.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.expectedHead - Input value.
	 * @returns The adopted head and superseded ID or stable rejection.
	 */
	public swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }> {
		const candidate = this.preflightSwap(input);
		if (!candidate.ok) return candidate;
		const authorization = this.verifyGenerationClosure(candidate.value.generation, "candidate");
		if (!authorization.ok) return authorization;
		return this.adoptVerifiedSwap(candidate.value, authorization.value);
	}

	/**
	 * Adopts a candidate using verifier-issued authority after semantic preflight.
	 * @param input - Exact compare-and-swap request.
	 * @param input.objectId - Canonical object identity.
	 * @param input.generationId - Complete candidate identity.
	 * @param input.expectedHead - Exact expected head.
	 * @param authorization - Exact candidate-closure authorization.
	 * @returns The adopted head and superseded generation, or stable rejection.
	 */
	public swapHeadAuthorized(
		input: {
			objectId: StorageObjectId;
			generationId: GenerationId;
			expectedHead: ExpectedHead;
		},
		authorization: Authorization
	): StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }> {
		const candidate = this.preflightSwap(input);
		if (!candidate.ok) return candidate;
		return this.adoptVerifiedSwap(candidate.value, authorization);
	}

	private preflightSwap(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): StoreResult<SwapCandidate> {
		if (!isClosedRecord(input, ["objectId", "generationId", "expectedHead"])) {
			return rejected("INVALID_ARGUMENT");
		}
		if (!isStorageObjectId(input.objectId) || !isGenerationId(input.generationId)) {
			return rejected("INVALID_ARGUMENT");
		}
		const expectedHead = copyExpectedHead(input.expectedHead, input.objectId);
		if (expectedHead === undefined) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const object = this.objects.get(input.objectId);
		const generation = object?.generations.get(input.generationId);
		if (object === undefined || generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Complete") return rejected("CANDIDATE_NOT_COMPLETE");
		if (!headsEqual(object.head, expectedHead)) return rejected("HEAD_CONFLICT");
		if (!headsEqual(generation.baseExpectedHead, expectedHead)) return rejected("BASE_HEAD_MISMATCH");
		if (expectedHead.kind === "present" && expectedHead.revision === Number.MAX_SAFE_INTEGER) {
			return rejected("REVISION_EXHAUSTED");
		}
		return { ok: true, value: { object, generation, expectedHead } };
	}

	private adoptVerifiedSwap(
		candidate: SwapCandidate,
		authorization: Authorization
	): StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }> {
		const { expectedHead, generation, object } = candidate;
		if (!accepts(authorization, asRecord(generation), "candidate")) return rejected("INVALID_ARGUMENT");
		const revision = checkedHeadRevision(expectedHead.kind === "none" ? 1 : expectedHead.revision + 1);
		let supersededGenerationId: GenerationId | null = null;
		if (object.head.kind === "present") {
			const previous = object.generations.get(object.head.generationId);
			if (previous !== undefined && previous.state === "Adopted") {
				previous.state = "Superseded";
				supersededGenerationId = previous.generationId;
			}
		}
		generation.state = "Adopted";
		const head: PresentHead = {
			kind: "present",
			objectId: generation.objectId,
			generationId: generation.generationId,
			revision,
			closureDigest: generation.closureDigest,
		};
		object.head = head;
		return { ok: true, value: { head: { ...head }, supersededGenerationId } };
	}

	private verifyGenerationClosure(
		generation: GenerationRecord,
		mode: "adopted" | "candidate"
	): StoreResult<Authorization> {
		const session = start(generation, mode);
		for (let request = next(session); request !== null; request = next(session)) {
			if (request.kind === "promotion") {
				acceptPromotion(
					session,
					this.promoted.has(this.promotionKey(generation.objectId, generation.generationId, request.reference.digest))
				);
			} else {
				acceptBlob(session, this.blobs.get(request.reference.digest));
			}
		}
		return finish(session);
	}

	/**
	 * Discards one Staged or Complete generation.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @returns The discarded record or stable rejection.
	 */
	public discardGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): StoreResult<GenerationRecord> {
		if (!this.validGenerationInput(input)) return rejected("INVALID_ARGUMENT");
		const lifecycleFailure = this.lifecycleFailure();
		if (lifecycleFailure !== undefined) return lifecycleFailure;
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged" && generation.state !== "Complete") {
			return rejected("ILLEGAL_TRANSITION");
		}
		generation.state = "Discarded";
		return { ok: true, value: asRecord(generation) };
	}

	/** Idempotently closes this transition owner. */
	public close(): void {
		this.closed = true;
	}

	/**
	 * Seeds modeled adapter state for package-internal conformance tests.
	 * @param state - Input value.
	 */
	public seedObjectState(state: TransitionObjectState): void {
		const generations = new Map(
			state.generations.map((record) => {
				const copied = cloneGeneration(record);
				return [copied.generationId, { ...copied, closure: copied.closure.map((item) => ({ ...item })) }];
			})
		);
		this.objects.set(state.head.objectId, {
			head: cloneHead(state.head),
			generations,
			generationIds: [...generations.keys()].sort(compareCanonicalText),
		});
	}

	/**
	 * Seeds a detached modeled backend blob for package-internal tests.
	 * @param digest - Input value.
	 * @param bytes - Input value.
	 */
	public seedBlob(digest: BlobDigest, bytes: Uint8Array): void {
		this.blobs.set(digest, new Uint8Array(bytes));
	}

	/**
	 * Marks modeled backend-owned promotion evidence for package-internal tests.
	 * @param objectId - Input value.
	 * @param generationId - Input value.
	 * @param digest - Input value.
	 */
	public markPromoted(objectId: StorageObjectId, generationId: GenerationId, digest: BlobDigest): void {
		this.promoted.add(this.promotionKey(objectId, generationId, digest));
	}

	private object(objectId: StorageObjectId): MutableObject {
		let value = this.objects.get(objectId);
		if (value === undefined) {
			value = { head: { kind: "none", objectId }, generations: new Map(), generationIds: [] };
			this.objects.set(objectId, value);
		}
		return value;
	}

	private findGeneration(objectId: StorageObjectId, generationId: GenerationId): MutableGeneration | undefined {
		return this.objects.get(objectId)?.generations.get(generationId);
	}

	private validGenerationInput(value: unknown): value is { objectId: StorageObjectId; generationId: GenerationId } {
		return (
			isClosedRecord(value, ["objectId", "generationId"]) &&
			isStorageObjectId(value.objectId) &&
			isGenerationId(value.generationId)
		);
	}

	private validGenerationDigestInput(value: unknown): value is {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	} {
		return (
			isClosedRecord(value, ["objectId", "generationId", "digest"]) &&
			isStorageObjectId(value.objectId) &&
			isGenerationId(value.generationId) &&
			isBlobDigest(value.digest)
		);
	}

	private blobMatches(reference: GenerationRef, blob: Uint8Array): boolean {
		if (blob.byteLength !== reference.byteLength) return false;
		const digest = digestBlob(blob);
		return digest.ok && digest.value === reference.digest;
	}

	private promotionKey(objectId: StorageObjectId, generationId: GenerationId, digest: BlobDigest): string {
		return `${objectId}\0${generationId}\0${digest}`;
	}
}

function firstGenerationAfter(generationIds: readonly GenerationId[], afterGenerationId: GenerationId | null): number {
	if (afterGenerationId === null) return 0;
	let lower = 0;
	let upper = generationIds.length;
	while (lower < upper) {
		const middle = lower + Math.floor((upper - lower) / 2);
		const generationId = generationIds[middle];
		if (generationId === undefined) throw new Error("ordered generation index is sparse");
		if (compareCanonicalText(generationId, afterGenerationId) <= 0) lower = middle + 1;
		else upper = middle;
	}
	return lower;
}

function insertGenerationId(generationIds: GenerationId[], generationId: GenerationId): void {
	const index = firstGenerationAfter(generationIds, generationId);
	generationIds.splice(index, 0, generationId);
}

function indexedGeneration(object: MutableObject, generationId: GenerationId): MutableGeneration {
	const generation = object.generations.get(generationId);
	if (generation === undefined) throw new Error("ordered generation index disagrees with the journal");
	return generation;
}

function indexedGenerationRecord(object: MutableObject, generationId: GenerationId): GenerationRecord {
	return asRecord(indexedGeneration(object, generationId));
}
