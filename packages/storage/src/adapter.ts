import {
	copyClosure,
	copyExpectedHead,
	hasSharedBacking,
	isBlobDigest,
	isClosedRecord,
	isGenerationId,
	isStorageObjectId,
} from "./internal/validation.js";
import type {
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	ObjectStoreState,
	StorageObjectId,
	StoreResult,
} from "./types.js";

export type StorageAdapterCommand =
	| ReadObjectStateCommand
	| GetBlobCommand
	| BeginGenerationCommand
	| PutCachedBlobCommand
	| PromoteReferenceCommand
	| CompleteGenerationCommand
	| SwapHeadCommand
	| DiscardGenerationCommand;

type ReadObjectStateCommand = Readonly<{
	kind: "readObjectState";
	objectId: StorageObjectId;
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
	| ObjectStoreState
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

	if (kindDescriptor.value === "readObjectState") {
		if (!isClosedRecord(value, ["kind", "objectId"]) || !isStorageObjectId(value.objectId)) {
			return invalidPreparation();
		}
		const command: ReadObjectStateCommand = { kind: "readObjectState", objectId: value.objectId };
		return freezePrepared(command, [{ kind: "object-state", objectId: command.objectId }]);
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
		const closure = copyClosure(value.closure);
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
			!(bytesDescriptor.value instanceof Uint8Array) ||
			!isClosedRecord(value, ["kind", "objectId", "generationId", "digest", "bytes"])
		) {
			return invalidPreparation();
		}
		if (hasSharedBacking(bytesDescriptor.value)) return sharedPreparation();
		const scope = generationScope(value);
		if (scope === undefined || !isBlobDigest(value.digest)) return invalidPreparation();
		const command: PutCachedBlobCommand = {
			kind: "putCachedBlob",
			...scope,
			digest: value.digest,
			bytes: new Uint8Array(bytesDescriptor.value),
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
 *
 * This deliberately rejecting Phase 2c-a RED scaffold is replaced by the
 * shared transition-kernel evaluation in GREEN.
 * @param _prepared - Prepared command.
 * @param _facts - Exact authoritative facts loaded by the adapter transaction.
 * @returns A stable rejection with no writes.
 */
export function evaluateStorageAdapterCommand(
	_prepared: PreparedStorageAdapterCommand,
	_facts: readonly StorageAdapterFact[]
): StorageAdapterEvaluation {
	if (_facts.length === 1 && _facts[0]?.kind === "store-closed") {
		return Object.freeze({ result: { ok: false, reason: "STORE_CLOSED" }, writes: EMPTY_WRITES });
	}
	return Object.freeze({ result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: EMPTY_WRITES });
}
