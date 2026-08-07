import { TransitionOwner } from "./internal/transition.js";
import type {
	AheDurableStore,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	ObjectStoreState,
	PresentHead,
	StorageObjectId,
	StoreCapabilities,
	StoreResult,
} from "./types.js";

const EPHEMERAL_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "ephemeral",
	signingEligibility: "never",
});

class MemoryAheDurableStore implements AheDurableStore {
	public readonly capabilities = EPHEMERAL_CAPABILITIES;
	private readonly owner = new TransitionOwner("ephemeral");

	public constructor() {
		Object.freeze(this);
	}

	/**
	 * Reads one detached object state.
	 * @param objectId - Input value.
	 * @returns The asynchronous store result.
	 */
	public readObjectState(objectId: StorageObjectId): Promise<StoreResult<ObjectStoreState>> {
		return Promise.resolve(this.owner.readObjectState(objectId));
	}

	/**
	 * Reads fresh bytes for one cached blob.
	 * @param digest - Input value.
	 * @returns The asynchronous store result.
	 */
	public getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return Promise.resolve(this.owner.getBlob(digest));
	}

	/**
	 * Begins one ephemeral staged generation.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.baseExpectedHead - Input value.
	 * @param input.closure - Input value.
	 * @returns The asynchronous store result.
	 */
	public beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.beginGeneration(input));
	}

	/**
	 * Caches detached bytes for one declared reference.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.digest - Input value.
	 * @param input.bytes - Input value.
	 * @returns The asynchronous store result.
	 */
	public putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): Promise<StoreResult<{ inserted: boolean }>> {
		return Promise.resolve(this.owner.putCachedBlob(input));
	}

	/**
	 * Always rejects because memory cannot produce strict promotion evidence.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.digest - Input value.
	 * @returns The asynchronous store result.
	 */
	public promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): Promise<StoreResult<undefined>> {
		return Promise.resolve(this.owner.promoteReference(input));
	}

	/**
	 * Checks the closure, but can never succeed without strict promotion.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @returns The asynchronous store result.
	 */
	public completeGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.completeGeneration(input));
	}

	/**
	 * Can only adopt a Complete candidate, which memory cannot create publicly.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @param input.expectedHead - Input value.
	 * @returns The asynchronous store result.
	 */
	public swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>> {
		return Promise.resolve(this.owner.swapHead(input));
	}

	/**
	 * Discards one eligible ephemeral generation.
	 * @param input - Input value.
	 * @param input.objectId - Input value.
	 * @param input.generationId - Input value.
	 * @returns The asynchronous store result.
	 */
	public discardGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.discardGeneration(input));
	}

	/**
	 * Idempotently closes the in-memory model.
	 * @returns A promise resolved after closure.
	 */
	public close(): Promise<void> {
		this.owner.close();
		return Promise.resolve();
	}
}

/**
 * Creates the honest ephemeral store model.
 * @returns A new ephemeral store.
 */
export function createMemoryAheDurableStore(): AheDurableStore {
	return new MemoryAheDurableStore();
}
