import type {
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	ObjectStoreState,
	PresentHead,
	StorageObjectId,
	StoreResult,
} from "../types.js";
import { digestClosure, permissiveHeadRevision } from "../values.js";

type MutableGeneration = {
	objectId: StorageObjectId;
	generationId: GenerationId;
	baseExpectedHead: ExpectedHead;
	closureDigest: GenerationRecord["closureDigest"];
	closure: readonly GenerationRef[];
	state: GenerationRecord["state"];
};

type MutableObject = {
	head: ExpectedHead;
	generations: Map<GenerationId, MutableGeneration>;
};

/**
 * Deliberately permissive RED transition owner. GREEN replaces these accepting
 * transitions without creating a second oracle.
 * @internal
 */
export class PermissiveTransitionOwner {
	private readonly objects = new Map<StorageObjectId, MutableObject>();
	private readonly blobs = new Map<BlobDigest, Uint8Array>();
	private readonly promoted = new Set<string>();

	private object(objectId: StorageObjectId): MutableObject {
		let value = this.objects.get(objectId);
		if (value === undefined) {
			value = { head: { kind: "none", objectId }, generations: new Map() };
			this.objects.set(objectId, value);
		}
		return value;
	}

	/**
	 *
	 * @param objectId
	 */
	readObjectState(objectId: StorageObjectId): StoreResult<ObjectStoreState> {
		const object = this.object(objectId);
		return {
			ok: true,
			value: {
				head: object.head,
				generations: [...object.generations.values()].sort((left, right) =>
					left.generationId.localeCompare(right.generationId)
				),
			},
		};
	}

	/**
	 *
	 * @param digest
	 */
	getBlob(digest: BlobDigest): StoreResult<Uint8Array | null> {
		return { ok: true, value: this.blobs.get(digest) ?? null };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 * @param input.baseExpectedHead
	 * @param input.closure
	 */
	beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): StoreResult<GenerationRecord> {
		const closureDigest = digestClosure(input.closure);
		if (!closureDigest.ok) return closureDigest;
		const generation: MutableGeneration = {
			...input,
			closureDigest: closureDigest.value,
			state: "Staged",
		};
		this.object(input.objectId).generations.set(input.generationId, generation);
		return { ok: true, value: generation };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 * @param input.digest
	 * @param input.bytes
	 */
	putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): StoreResult<{ inserted: boolean }> {
		this.blobs.set(input.digest, input.bytes);
		return { ok: true, value: { inserted: true } };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 * @param input.digest
	 */
	promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): StoreResult<undefined> {
		this.promoted.add(this.promotionKey(input.objectId, input.generationId, input.digest));
		return { ok: true, value: undefined };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 */
	completeGeneration(input: { objectId: StorageObjectId; generationId: GenerationId }): StoreResult<GenerationRecord> {
		const generation = this.requireGeneration(input.objectId, input.generationId);
		generation.state = "Complete";
		return { ok: true, value: generation };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 * @param input.expectedHead
	 */
	swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }> {
		const object = this.object(input.objectId);
		const generation = this.requireGeneration(input.objectId, input.generationId);
		let supersededGenerationId: GenerationId | null = null;
		for (const previous of object.generations.values()) {
			if (previous.state === "Adopted") {
				previous.state = "Superseded";
				supersededGenerationId = previous.generationId;
			}
		}
		generation.state = "Adopted";
		const revision = input.expectedHead.kind === "none" ? 1 : input.expectedHead.revision + 1;
		const head: PresentHead = {
			kind: "present",
			objectId: input.objectId,
			generationId: input.generationId,
			revision: permissiveHeadRevision(revision),
			closureDigest: generation.closureDigest,
		};
		object.head = head;
		return { ok: true, value: { head, supersededGenerationId } };
	}

	/**
	 *
	 * @param input
	 * @param input.objectId
	 * @param input.generationId
	 */
	discardGeneration(input: { objectId: StorageObjectId; generationId: GenerationId }): StoreResult<GenerationRecord> {
		const generation = this.requireGeneration(input.objectId, input.generationId);
		generation.state = "Discarded";
		return { ok: true, value: generation };
	}

	/**
	 *
	 * @param state
	 */
	seedObjectState(state: ObjectStoreState): void {
		this.objects.set(state.head.objectId, {
			head: state.head,
			generations: new Map(state.generations.map((record) => [record.generationId, { ...record }])),
		});
	}

	/**
	 *
	 * @param digest
	 * @param bytes
	 */
	seedBlob(digest: BlobDigest, bytes: Uint8Array): void {
		this.blobs.set(digest, bytes);
	}

	/**
	 *
	 * @param objectId
	 * @param generationId
	 * @param digest
	 */
	markPromoted(objectId: StorageObjectId, generationId: GenerationId, digest: BlobDigest): void {
		this.promoted.add(this.promotionKey(objectId, generationId, digest));
	}

	private requireGeneration(objectId: StorageObjectId, generationId: GenerationId): MutableGeneration {
		const generation = this.object(objectId).generations.get(generationId);
		if (generation === undefined) throw new Error("RED scaffold requires a seeded generation");
		return generation;
	}

	private promotionKey(objectId: StorageObjectId, generationId: GenerationId, digest: BlobDigest): string {
		return `${objectId}\0${generationId}\0${digest}`;
	}
}
