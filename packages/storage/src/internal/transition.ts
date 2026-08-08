import type {
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	ObjectStoreState,
	PresentHead,
	StorageObjectId,
	StorageRejectionReason,
	StoreResult,
} from "../types.js";
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
};

type TransitionDurability = "ephemeral" | "strict";

function rejected<T>(reason: Exclude<StorageRejectionReason, "SUBSTRATE_FAILURE">): StoreResult<T> {
	return { ok: false, reason };
}

function asRecord(value: MutableGeneration): GenerationRecord {
	return cloneGeneration(value);
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

	/**
	 *
	 * @param durability - Input value.
	 */
	public constructor(private readonly durability: TransitionDurability) {}

	/**
	 * Reads one detached head+journal snapshot.
	 * @param objectId - Input value.
	 * @returns A detached state or stable rejection.
	 */
	public readObjectState(objectId: StorageObjectId): StoreResult<ObjectStoreState> {
		if (!isStorageObjectId(objectId)) return rejected("INVALID_ARGUMENT");
		if (this.closed) return rejected("STORE_CLOSED");
		const object = this.objects.get(objectId);
		if (object === undefined) {
			return { ok: true, value: { head: { kind: "none", objectId }, generations: [] } };
		}
		return {
			ok: true,
			value: {
				head: cloneHead(object.head),
				generations: [...object.generations.values()]
					.sort((left, right) => compareCanonicalText(left.generationId, right.generationId))
					.map(asRecord),
			},
		};
	}

	/**
	 * Reads fresh bytes for one global content-addressed blob.
	 * @param digest - Input value.
	 * @returns Fresh blob bytes, absence, or stable rejection.
	 */
	public getBlob(digest: BlobDigest): StoreResult<Uint8Array | null> {
		if (!isBlobDigest(digest)) return rejected("INVALID_ARGUMENT");
		if (this.closed) return rejected("STORE_CLOSED");
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
		if (this.closed) return rejected("STORE_CLOSED");
		const existingObject = this.objects.get(input.objectId);
		if (existingObject?.generations.has(input.generationId) === true) return rejected("GENERATION_EXISTS");
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
		if (this.closed) return rejected("STORE_CLOSED");
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
		if (this.closed) return rejected("STORE_CLOSED");
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
		if (this.closed) return rejected("STORE_CLOSED");
		const generation = this.findGeneration(input.objectId, input.generationId);
		if (generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Staged") return rejected("ILLEGAL_TRANSITION");
		for (const reference of [...generation.closure].sort((left, right) =>
			compareCanonicalText(left.digest, right.digest)
		)) {
			if (!this.promoted.has(this.promotionKey(input.objectId, input.generationId, reference.digest))) {
				return rejected("BLOB_UNPROMOTED");
			}
		}
		generation.state = "Complete";
		return { ok: true, value: asRecord(generation) };
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
		if (!isClosedRecord(input, ["objectId", "generationId", "expectedHead"])) {
			return rejected("INVALID_ARGUMENT");
		}
		if (!isStorageObjectId(input.objectId) || !isGenerationId(input.generationId)) {
			return rejected("INVALID_ARGUMENT");
		}
		const expectedHead = copyExpectedHead(input.expectedHead, input.objectId);
		if (expectedHead === undefined) return rejected("INVALID_ARGUMENT");
		if (this.closed) return rejected("STORE_CLOSED");
		const object = this.objects.get(input.objectId);
		const generation = object?.generations.get(input.generationId);
		if (object === undefined || generation === undefined) return rejected("GENERATION_NOT_FOUND");
		if (generation.state !== "Complete") return rejected("CANDIDATE_NOT_COMPLETE");
		if (!headsEqual(object.head, expectedHead)) return rejected("HEAD_CONFLICT");
		if (!headsEqual(generation.baseExpectedHead, expectedHead)) return rejected("BASE_HEAD_MISMATCH");
		if (expectedHead.kind === "present" && expectedHead.revision === Number.MAX_SAFE_INTEGER) {
			return rejected("REVISION_EXHAUSTED");
		}
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
			objectId: input.objectId,
			generationId: input.generationId,
			revision,
			closureDigest: generation.closureDigest,
		};
		object.head = head;
		return { ok: true, value: { head: { ...head }, supersededGenerationId } };
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
		if (this.closed) return rejected("STORE_CLOSED");
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
	public seedObjectState(state: ObjectStoreState): void {
		this.objects.set(state.head.objectId, {
			head: cloneHead(state.head),
			generations: new Map(
				state.generations.map((record) => {
					const copied = cloneGeneration(record);
					return [copied.generationId, { ...copied, closure: copied.closure.map((item) => ({ ...item })) }];
				})
			),
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
			value = { head: { kind: "none", objectId }, generations: new Map() };
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
