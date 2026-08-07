import { PermissiveTransitionOwner } from "./internal/transition.js";
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
	readonly capabilities = EPHEMERAL_CAPABILITIES;
	private readonly owner = new PermissiveTransitionOwner();

	readObjectState(objectId: StorageObjectId): Promise<StoreResult<ObjectStoreState>> {
		return Promise.resolve(this.owner.readObjectState(objectId));
	}

	getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return Promise.resolve(this.owner.getBlob(digest));
	}

	beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.beginGeneration(input));
	}

	putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): Promise<StoreResult<{ inserted: boolean }>> {
		return Promise.resolve(this.owner.putCachedBlob(input));
	}

	promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): Promise<StoreResult<undefined>> {
		return Promise.resolve(this.owner.promoteReference(input));
	}

	completeGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.completeGeneration(input));
	}

	swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>> {
		return Promise.resolve(this.owner.swapHead(input));
	}

	discardGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return Promise.resolve(this.owner.discardGeneration(input));
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

/**
 *
 */
export function createMemoryAheDurableStore(): AheDurableStore {
	return new MemoryAheDurableStore();
}
