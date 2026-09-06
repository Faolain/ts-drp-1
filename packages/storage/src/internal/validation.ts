import type {
	BlobDigest,
	ClosureDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	HeadRevision,
	StorageObjectId,
} from "../types.js";

const HEX_64 = /^[0-9a-f]{64}$/u;
const OBJECT_SALT = /^[0-9a-f]{32}$/u;
const GENERATION_STATES = new Set(["Staged", "Complete", "Adopted", "Superseded", "Discarded"]);

/**
 * Compares canonical ASCII identifiers without locale-dependent collation.
 * @param left - Left identifier.
 * @param right - Right identifier.
 * @returns Their exact code-unit order.
 */
export function compareCanonicalText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Returns whether a byte view is backed by shared memory.
 * @param bytes - Input value.
 * @returns Whether the backing buffer is shared.
 */
export function hasSharedBacking(bytes: Uint8Array): boolean {
	return typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer;
}

/**
 * Compares two byte sequences without retaining either input.
 * @param left - Input value.
 * @param right - Input value.
 * @returns Whether every byte is equal.
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * Returns whether a string contains only paired UTF-16 surrogate code units.
 * @param value - Input value.
 * @returns Whether the string is well formed.
 */
export function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * Checks the greenfield creator-bound storage identity spelling.
 * @param value - Input value.
 * @returns Whether the value is a canonical storage object ID.
 */
export function isStorageObjectId(value: unknown): value is StorageObjectId {
	if (typeof value !== "string" || value.length > 1024 || !isWellFormedUtf16(value)) return false;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator !== value.lastIndexOf(":")) return false;
	const creator = value.slice(0, separator);
	const salt = value.slice(separator + 1);
	for (let index = 0; index < creator.length; index++) {
		const unit = creator.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
	}
	return OBJECT_SALT.test(salt);
}

/**
 * Checks a canonical generation identifier.
 * @param value - Input value.
 * @returns Whether the value is canonical.
 */
export function isGenerationId(value: unknown): value is GenerationId {
	return typeof value === "string" && HEX_64.test(value);
}

/**
 * Checks a canonical blob digest.
 * @param value - Input value.
 * @returns Whether the value is canonical.
 */
export function isBlobDigest(value: unknown): value is BlobDigest {
	return typeof value === "string" && HEX_64.test(value);
}

/**
 * Checks a canonical closure digest.
 * @param value - Input value.
 * @returns Whether the value is canonical.
 */
export function isClosureDigest(value: unknown): value is ClosureDigest {
	return typeof value === "string" && HEX_64.test(value);
}

/**
 * Checks a non-sentinel head revision.
 * @param value - Input value.
 * @returns Whether the value is a positive safe integer.
 */
export function isHeadRevision(value: unknown): value is HeadRevision {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Checks that a value is an exact ordinary/null-prototype data record.
 * @param value - Input value.
 * @param keys - Input value.
 * @returns Whether the record has exactly the requested data fields.
 */
export function isClosedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		return false;
	}
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			return false;
		}
	}
	return true;
}

/**
 * Checks that an array is dense and has no expandos or accessors.
 * @param value - Input value.
 * @returns Whether the array is exact and dense.
 */
export function isClosedArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			return false;
		}
	}
	return true;
}

/**
 * Validates and copies one generation reference.
 * @param value - Input value.
 * @returns A detached reference or undefined.
 */
export function copyGenerationRef(value: unknown): GenerationRef | undefined {
	if (!isClosedRecord(value, ["digest", "byteLength"])) return undefined;
	if (!isBlobDigest(value.digest)) return undefined;
	if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
		return undefined;
	}
	return { digest: value.digest, byteLength: value.byteLength };
}

/**
 * Validates, copies and digest-sorts a non-empty duplicate-free closure.
 * @param value - Input value.
 * @returns A detached sorted closure or undefined.
 */
export function copyClosure(value: unknown): readonly GenerationRef[] | undefined {
	if (!isClosedArray(value) || value.length === 0) return undefined;
	const closure: GenerationRef[] = [];
	for (const item of value) {
		const copied = copyGenerationRef(item);
		if (copied === undefined) return undefined;
		closure.push(copied);
	}
	closure.sort((left, right) => compareCanonicalText(left.digest, right.digest));
	for (let index = 1; index < closure.length; index++) {
		if (closure[index - 1]?.digest === closure[index]?.digest) return undefined;
	}
	return closure;
}

/**
 * Copies a valid exact head, optionally requiring its object scope.
 * @param value - Input value.
 * @param objectId - Input value.
 * @returns A detached head or undefined.
 */
export function copyExpectedHead(value: unknown, objectId?: StorageObjectId): ExpectedHead | undefined {
	if (isClosedRecord(value, ["kind", "objectId"]) && value.kind === "none" && isStorageObjectId(value.objectId)) {
		if (objectId !== undefined && value.objectId !== objectId) return undefined;
		return { kind: "none", objectId: value.objectId };
	}
	if (
		isClosedRecord(value, ["kind", "objectId", "generationId", "revision", "closureDigest"]) &&
		value.kind === "present" &&
		isStorageObjectId(value.objectId) &&
		isGenerationId(value.generationId) &&
		isHeadRevision(value.revision) &&
		isClosureDigest(value.closureDigest)
	) {
		if (objectId !== undefined && value.objectId !== objectId) return undefined;
		return {
			kind: "present",
			objectId: value.objectId,
			generationId: value.generationId,
			revision: value.revision,
			closureDigest: value.closureDigest,
		};
	}
	return undefined;
}

/**
 * Copies a syntactically valid exact generation record.
 * @param value - Input value.
 * @returns A detached generation or undefined.
 */
export function copyGenerationRecord(value: unknown): GenerationRecord | undefined {
	if (!isClosedRecord(value, ["objectId", "generationId", "baseExpectedHead", "closureDigest", "closure", "state"])) {
		return undefined;
	}
	if (
		!isStorageObjectId(value.objectId) ||
		!isGenerationId(value.generationId) ||
		!isClosureDigest(value.closureDigest) ||
		typeof value.state !== "string" ||
		!GENERATION_STATES.has(value.state)
	) {
		return undefined;
	}
	const baseExpectedHead = copyExpectedHead(value.baseExpectedHead, value.objectId);
	if (baseExpectedHead === undefined || !isClosedArray(value.closure) || value.closure.length === 0) return undefined;
	const closure: GenerationRef[] = [];
	for (const item of value.closure) {
		const copied = copyGenerationRef(item);
		if (copied === undefined) return undefined;
		const previous = closure[closure.length - 1];
		if (previous !== undefined && compareCanonicalText(previous.digest, copied.digest) >= 0) return undefined;
		closure.push(copied);
	}
	return {
		objectId: value.objectId,
		generationId: value.generationId,
		baseExpectedHead,
		closureDigest: value.closureDigest,
		closure,
		state: value.state as GenerationRecord["state"],
	};
}

/**
 * Compares exact head union arms and fields.
 * @param left - Input value.
 * @param right - Input value.
 * @returns Whether the heads are exactly equal.
 */
export function headsEqual(left: ExpectedHead, right: ExpectedHead): boolean {
	if (left.kind !== right.kind || left.objectId !== right.objectId) return false;
	return (
		left.kind === "none" ||
		(right.kind === "present" &&
			left.generationId === right.generationId &&
			left.revision === right.revision &&
			left.closureDigest === right.closureDigest)
	);
}

/**
 * Copies a head already known to be valid.
 * @param value - Input value.
 * @returns A detached head.
 */
export function cloneHead(value: ExpectedHead): ExpectedHead {
	return value.kind === "none" ? { ...value } : { ...value };
}

/**
 * Deep-copies a generation record without codec round-tripping blob bytes.
 * @param value - Input value.
 * @returns A detached generation record.
 */
export function cloneGeneration(value: GenerationRecord): GenerationRecord {
	return {
		...value,
		baseExpectedHead: cloneHead(value.baseExpectedHead),
		closure: value.closure.map((item) => ({ ...item })),
	};
}
