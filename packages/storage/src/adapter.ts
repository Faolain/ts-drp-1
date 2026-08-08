import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
} from "./codecs.js";
import { TransitionOwner } from "./internal/transition.js";
import {
	bytesEqual,
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
		const closure = copyStructuralClosure(value.closure);
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
 * @param prepared - Prepared command.
 * @param facts - Exact authoritative facts loaded by the adapter transaction.
 * @returns The shared-kernel result and exact deterministic write set.
 */
export function evaluateStorageAdapterCommand(
	prepared: PreparedStorageAdapterCommand,
	facts: readonly StorageAdapterFact[]
): StorageAdapterEvaluation {
	const canonical = canonicalPrepared(prepared);
	if (canonical === undefined) return invalidEvaluation();
	if (isClosedArray(facts) && facts.length === 1 && isClosedStoreFact(facts[0])) {
		return Object.freeze({ result: { ok: false, reason: "STORE_CLOSED" }, writes: EMPTY_WRITES });
	}
	const loaded = copyAndValidateFacts(canonical.command, facts);
	if (loaded === undefined) return invalidEvaluation();

	const owner = new TransitionOwner("strict");
	for (const state of loaded.objects.values()) owner.seedObjectState(state);
	for (const fact of loaded.blobs.values()) {
		if (fact.bytes !== null) owner.seedBlob(fact.digest, fact.bytes);
	}
	for (const fact of loaded.promotions.values()) {
		owner.markPromoted(fact.objectId, fact.generationId, fact.digest);
	}
	const before = objectScope(canonical.command);
	const beforeState = before === undefined ? undefined : owner.readObjectState(before);
	const result = execute(owner, canonical.command);
	if (!result.ok) return Object.freeze({ result, writes: EMPTY_WRITES });

	const writes: StorageAdapterWrite[] = [];
	if (canonical.command.kind === "putCachedBlob" && (result.value as Readonly<{ inserted: boolean }>).inserted) {
		writes.push({
			kind: "insert-blob",
			digest: canonical.command.digest,
			bytes: new Uint8Array(canonical.command.bytes),
		});
	} else if (canonical.command.kind === "promoteReference" && !loaded.promotions.has(promotionKey(canonical.command))) {
		writes.push({
			kind: "insert-promotion",
			objectId: canonical.command.objectId,
			generationId: canonical.command.generationId,
			digest: canonical.command.digest,
		});
	} else if (
		canonical.command.kind === "beginGeneration" ||
		canonical.command.kind === "completeGeneration" ||
		canonical.command.kind === "swapHead" ||
		canonical.command.kind === "discardGeneration"
	) {
		const afterState = owner.readObjectState(canonical.command.objectId);
		if (!afterState.ok || beforeState === undefined || !beforeState.ok) return invalidEvaluation();
		appendStateWrites(writes, beforeState.value, afterState.value);
	}
	return Object.freeze({ result, writes: Object.freeze(writes) });
}

type LoadedFacts = Readonly<{
	objects: Map<StorageObjectId, ObjectStoreState>;
	blobs: Map<BlobDigest, Readonly<{ digest: BlobDigest; bytes: Uint8Array | null }>>;
	promotions: Map<string, Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>>;
}>;

function invalidEvaluation(): StorageAdapterEvaluation {
	return Object.freeze({ result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: EMPTY_WRITES });
}

function isClosedStoreFact(value: unknown): value is Readonly<{ kind: "store-closed" }> {
	return isClosedRecord(value, ["kind"]) && value.kind === "store-closed";
}

function requirementKey(requirement: StorageAdapterLoadRequirement): string {
	switch (requirement.kind) {
		case "object-state":
			return `object-state\0${requirement.objectId}`;
		case "blob":
			return `blob\0${requirement.digest}`;
		case "promotion":
			return `promotion\0${requirement.objectId}\0${requirement.generationId}\0${requirement.digest}`;
		case "generation-closure":
			return `generation-closure\0${requirement.objectId}\0${requirement.generationId}`;
	}
}

function canonicalPrepared(value: unknown): PreparedStorageAdapterCommand | undefined {
	if (!isClosedRecord(value, ["command", "requirements"]) || !isClosedArray(value.requirements)) return undefined;
	const prepared = prepareStorageAdapterCommand(value.command);
	if (!prepared.ok || prepared.value.requirements.length !== value.requirements.length) return undefined;
	for (let index = 0; index < prepared.value.requirements.length; index++) {
		const supplied = value.requirements[index];
		const expected = prepared.value.requirements[index];
		if (expected === undefined || !isRequirement(supplied) || requirementKey(supplied) !== requirementKey(expected)) {
			return undefined;
		}
	}
	return prepared.value;
}

function isRequirement(value: unknown): value is StorageAdapterLoadRequirement {
	if (isClosedRecord(value, ["kind", "objectId"]) && value.kind === "object-state") {
		return isStorageObjectId(value.objectId);
	}
	if (isClosedRecord(value, ["kind", "digest"]) && value.kind === "blob") return isBlobDigest(value.digest);
	if (isClosedRecord(value, ["kind", "objectId", "generationId", "digest"]) && value.kind === "promotion") {
		return isStorageObjectId(value.objectId) && isGenerationId(value.generationId) && isBlobDigest(value.digest);
	}
	return (
		isClosedRecord(value, ["kind", "objectId", "generationId"]) &&
		value.kind === "generation-closure" &&
		isStorageObjectId(value.objectId) &&
		isGenerationId(value.generationId)
	);
}

function copyAndValidateFacts(command: StorageAdapterCommand, facts: unknown): LoadedFacts | undefined {
	if (!isClosedArray(facts)) return undefined;
	const objects = new Map<StorageObjectId, ObjectStoreState>();
	const blobs = new Map<BlobDigest, Readonly<{ digest: BlobDigest; bytes: Uint8Array | null }>>();
	const promotions = new Map<
		string,
		Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>
	>();
	for (const fact of facts) {
		if (isClosedRecord(fact, ["kind", "objectId", "headRecord", "generationRecords"]) && fact.kind === "object-state") {
			if (!isStorageObjectId(fact.objectId) || objects.has(fact.objectId) || !isClosedArray(fact.generationRecords)) {
				return undefined;
			}
			let head: ExpectedHead = { kind: "none", objectId: fact.objectId };
			if (fact.headRecord !== null) {
				const bytes = copyBytes(fact.headRecord);
				if (bytes === undefined) return undefined;
				const decoded = decodeHeadRecordV1(bytes);
				if (!decoded.ok || decoded.value.kind !== "present" || decoded.value.objectId !== fact.objectId)
					return undefined;
				head = decoded.value;
			}
			const generations: GenerationRecord[] = [];
			const ids = new Set<GenerationId>();
			for (const recordBytes of fact.generationRecords) {
				const bytes = copyBytes(recordBytes);
				if (bytes === undefined) return undefined;
				const decoded = decodeGenerationRecordV1(bytes);
				if (!decoded.ok || decoded.value.objectId !== fact.objectId || ids.has(decoded.value.generationId)) {
					return undefined;
				}
				ids.add(decoded.value.generationId);
				generations.push(decoded.value);
			}
			const adopted = generations.filter(({ state }) => state === "Adopted");
			if (head.kind === "none" && adopted.length !== 0) return undefined;
			if (
				head.kind === "present" &&
				(adopted.length !== 1 ||
					adopted[0]?.generationId !== head.generationId ||
					adopted[0].closureDigest !== head.closureDigest)
			) {
				return undefined;
			}
			objects.set(fact.objectId, { head, generations });
			continue;
		}
		if (isClosedRecord(fact, ["kind", "digest", "bytes"]) && fact.kind === "blob") {
			if (!isBlobDigest(fact.digest) || blobs.has(fact.digest)) return undefined;
			if (fact.bytes === null) blobs.set(fact.digest, { digest: fact.digest, bytes: null });
			else {
				const bytes = copyBytes(fact.bytes);
				if (bytes === undefined) return undefined;
				blobs.set(fact.digest, { digest: fact.digest, bytes });
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
			const objectId = fact.objectId as StorageObjectId;
			const generationId = fact.generationId as GenerationId;
			const digest = fact.digest as BlobDigest;
			const key = promotionKey({ objectId, generationId, digest });
			if (promotions.has(key)) return undefined;
			promotions.set(key, { objectId, generationId, digest });
			continue;
		}
		return undefined;
	}
	const loaded = { objects, blobs, promotions };
	return exactFactsForCommand(command, loaded) ? loaded : undefined;
}

function copyBytes(value: unknown): Uint8Array | undefined {
	if (!(value instanceof Uint8Array) || hasSharedBacking(value)) return undefined;
	return new Uint8Array(value);
}

function exactFactsForCommand(command: StorageAdapterCommand, facts: LoadedFacts): boolean {
	const objectIds = new Set<StorageObjectId>();
	const blobIds = new Set<BlobDigest>();
	const allowedPromotions = new Set<string>();
	if (command.kind === "getBlob") blobIds.add(command.digest);
	else if (command.kind === "readObjectState") objectIds.add(command.objectId);
	else {
		objectIds.add(command.objectId);
		if (command.kind === "putCachedBlob" || command.kind === "promoteReference") blobIds.add(command.digest);
		if (command.kind === "promoteReference") allowedPromotions.add(promotionKey(command));
		if (command.kind === "completeGeneration") {
			const generation = facts.objects
				.get(command.objectId)
				?.generations.find(({ generationId }) => generationId === command.generationId);
			for (const reference of generation?.closure ?? []) {
				allowedPromotions.add(promotionKey({ ...command, digest: reference.digest }));
			}
		}
	}
	if (facts.objects.size !== objectIds.size || facts.blobs.size !== blobIds.size) return false;
	for (const id of objectIds) if (!facts.objects.has(id)) return false;
	for (const id of blobIds) if (!facts.blobs.has(id)) return false;
	for (const key of facts.promotions.keys()) if (!allowedPromotions.has(key)) return false;
	return true;
}

function promotionKey(value: { objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }): string {
	return `${value.objectId}\0${value.generationId}\0${value.digest}`;
}

function objectScope(command: StorageAdapterCommand): StorageObjectId | undefined {
	return command.kind === "getBlob" ? undefined : command.objectId;
}

function execute(owner: TransitionOwner, command: StorageAdapterCommand): StoreResult<StorageAdapterResultValue> {
	switch (command.kind) {
		case "readObjectState":
			return owner.readObjectState(command.objectId);
		case "getBlob":
			return owner.getBlob(command.digest);
		case "beginGeneration":
			return owner.beginGeneration({
				objectId: command.objectId,
				generationId: command.generationId,
				baseExpectedHead: command.baseExpectedHead,
				closure: command.closure,
			});
		case "putCachedBlob":
			return owner.putCachedBlob({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
				bytes: command.bytes,
			});
		case "promoteReference":
			return owner.promoteReference({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
			});
		case "completeGeneration":
			return owner.completeGeneration({ objectId: command.objectId, generationId: command.generationId });
		case "swapHead":
			return owner.swapHead({
				objectId: command.objectId,
				generationId: command.generationId,
				expectedHead: command.expectedHead,
			});
		case "discardGeneration":
			return owner.discardGeneration({ objectId: command.objectId, generationId: command.generationId });
	}
}

function appendStateWrites(writes: StorageAdapterWrite[], before: ObjectStoreState, after: ObjectStoreState): void {
	const previous = new Map(before.generations.map((generation) => [generation.generationId, generation]));
	for (const generation of after.generations) {
		const record = encodeGenerationRecordV1(generation);
		const old = previous.get(generation.generationId);
		if (old !== undefined && bytesEqual(record, encodeGenerationRecordV1(old))) continue;
		writes.push({
			kind: "replace-generation",
			objectId: generation.objectId,
			generationId: generation.generationId,
			record: new Uint8Array(record),
		});
	}
	if (after.head.kind === "present") {
		const record = encodeHeadRecordV1(after.head);
		if (before.head.kind === "present" && bytesEqual(record, encodeHeadRecordV1(before.head))) return;
		writes.push({ kind: "replace-head", objectId: after.head.objectId, record: new Uint8Array(record) });
	}
}
