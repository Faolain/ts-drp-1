import {
	evaluateStorageAdapterCommand,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterFact,
} from "./adapter.js";
import { encodeGenerationRecordV1, encodeHeadRecordV1 } from "./codecs.js";
import { TransitionOwner } from "./internal/transition.js";
import type {
	ActiveGenerationSnapshot,
	AheDurableStore,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationPage,
	GenerationPageCursor,
	GenerationRecord,
	GenerationRef,
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
	 * Reads one detached head.
	 * @param objectId - Input value.
	 * @returns The asynchronous store result.
	 */
	public readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>> {
		return Promise.resolve(this.evaluateRead({ kind: "readHead", objectId }) as StoreResult<ExpectedHead>);
	}

	/**
	 * Reads one detached, deterministic, bounded generation page.
	 * @param input - Page request.
	 * @param input.objectId - Canonical object identity.
	 * @param input.cursor - Optional opaque exclusive continuation.
	 * @param input.limit - Maximum public page size.
	 * @returns The asynchronous store result.
	 */
	public readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: GenerationPageCursor;
		readonly limit: number;
	}): Promise<StoreResult<GenerationPage>> {
		return Promise.resolve(
			this.evaluateRead(commandWithKind("readGenerationPage", input)) as StoreResult<GenerationPage>
		);
	}

	/**
	 * Reads fresh bytes for one cached blob.
	 * @param digest - Input value.
	 * @returns The asynchronous store result.
	 */
	public getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return Promise.resolve(this.owner.getBlob(digest));
	}
	public recoverActiveGeneration(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>> {
		return Promise.resolve(this.owner.recoverActiveGeneration(objectId));
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

	private evaluateRead(command: unknown): StoreResult<unknown> {
		const prepared = prepareStorageAdapterCommand(command);
		if (!prepared.ok) return prepared;
		if (prepared.value.command.kind !== "readHead" && prepared.value.command.kind !== "readGenerationPage") {
			return { ok: false, reason: "INVALID_ARGUMENT" };
		}
		const facts = this.readFacts(prepared.value);
		if (!facts.ok) {
			return evaluateStorageAdapterCommand(prepared.value, [{ kind: "store-closed" }]).result;
		}
		return evaluateStorageAdapterCommand(prepared.value, facts.value).result;
	}

	private readFacts(prepared: PreparedStorageAdapterCommand): StoreResult<readonly StorageAdapterFact[]> {
		if (prepared.command.kind === "readHead") {
			const head = this.owner.readHead(prepared.command.objectId);
			if (!head.ok) return head;
			return {
				ok: true,
				value: [
					{
						headRecord: head.value.kind === "none" ? null : encodeHeadRecordV1(head.value),
						kind: "head",
						objectId: prepared.command.objectId,
					},
				],
			};
		}
		if (prepared.command.kind !== "readGenerationPage") return { ok: true, value: [] };
		const requirement = prepared.requirements[0];
		if (requirement?.kind !== "generation-page") return { ok: true, value: [] };
		const generations = this.owner.readGenerationPage(
			requirement.objectId,
			requirement.afterGenerationId,
			requirement.limitPlusOne
		);
		if (!generations.ok) return generations;
		return {
			ok: true,
			value: [
				{
					afterGenerationId: requirement.afterGenerationId,
					generationRecords: generations.value.map(encodeGenerationRecordV1),
					kind: "generation-page",
					objectId: requirement.objectId,
				},
			],
		};
	}
}

function commandWithKind(kind: "readGenerationPage", input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind, invalidInput: input };
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.prototype.hasOwnProperty.call(descriptors, "kind")) return { kind, invalidInput: true };
	const command = { kind } as Record<PropertyKey, unknown>;
	Object.defineProperties(command, descriptors);
	return command;
}

/**
 * Creates the honest ephemeral store model.
 * @returns A new ephemeral store.
 */
export function createMemoryAheDurableStore(): AheDurableStore {
	return new MemoryAheDurableStore();
}
