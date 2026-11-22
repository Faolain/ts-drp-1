import {
	type BlobDigest,
	type ClosureDigest,
	digestBlob,
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type HeadRevision,
	parseGenerationId,
	parseHeadRevision,
	type ParseResult,
	parseStorageObjectId,
	type StorageObjectId,
} from "../src/index.js";

export const OBJECT_A = must(parseStorageObjectId(`creator-a:${"a".repeat(32)}`));
export const OBJECT_B = must(parseStorageObjectId(`creator-b:${"b".repeat(32)}`));
export const GENERATION_A = must(parseGenerationId("1".repeat(64)));
export const GENERATION_B = must(parseGenerationId("2".repeat(64)));
export const GENERATION_C = must(parseGenerationId("3".repeat(64)));
export const REVISION_ONE = must(parseHeadRevision(1));

/**
 *
 * @param result - Input value.
 * @returns The successful fixture value.
 */
export function must<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(`fixture parse failed: ${result.reason}`);
	return result.value;
}

/**
 *
 * @param values - Input value.
 * @returns A byte array containing the values.
 */
export function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

/**
 *
 * @param value - Input value.
 * @returns A storage reference for the bytes.
 */
export function ref(value: Uint8Array): GenerationRef {
	return { digest: must(digestBlob(value)), byteLength: value.byteLength };
}

/**
 *
 * @param objectId - Input value.
 * @returns An explicit no-head value.
 */
export function noHead(objectId: StorageObjectId = OBJECT_A): ExpectedHead {
	return { kind: "none", objectId };
}

/**
 *
 * @param input - Input value.
 * @param input.objectId - Input value.
 * @param input.generationId - Input value.
 * @param input.revision - Input value.
 * @param input.closureDigest - Input value.
 * @returns A present-head fixture.
 */
export function presentHead(input: {
	objectId?: StorageObjectId;
	generationId?: GenerationId;
	revision?: HeadRevision;
	closureDigest: ClosureDigest;
}): ExpectedHead {
	return {
		kind: "present",
		objectId: input.objectId ?? OBJECT_A,
		generationId: input.generationId ?? GENERATION_A,
		revision: input.revision ?? REVISION_ONE,
		closureDigest: input.closureDigest,
	};
}

/**
 *
 * @param input - Input value.
 * @param input.objectId - Input value.
 * @param input.generationId - Input value.
 * @param input.baseExpectedHead - Input value.
 * @param input.closure - Input value.
 * @param input.state - Input value.
 * @returns A generation-record fixture.
 */
export function record(
	input: {
		objectId?: StorageObjectId;
		generationId?: GenerationId;
		baseExpectedHead?: ExpectedHead;
		closure?: readonly GenerationRef[];
		state?: GenerationRecord["state"];
	} = {}
): GenerationRecord {
	const objectId = input.objectId ?? OBJECT_A;
	const closure = input.closure ?? [ref(bytes(1))];
	return {
		objectId,
		generationId: input.generationId ?? GENERATION_A,
		baseExpectedHead: input.baseExpectedHead ?? noHead(objectId),
		closureDigest: must(digestClosure(closure)),
		closure,
		state: input.state ?? "Staged",
	};
}

/**
 *
 * @param value - Input value.
 * @returns The blob digest for the bytes.
 */
export function digestOf(value: Uint8Array): BlobDigest {
	return must(digestBlob(value));
}
