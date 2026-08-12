import { decodeCanonical } from "@ts-drp/canonical";

import { MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS } from "./types.js";
import type {
	DurableIssuanceError,
	DurableIssuanceErrorCode,
	DurableIssuanceRetryClass,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableSignedEnvelope,
} from "./types.js";

/** Closed failure used by durable issuance adapters and conformance controls. */
export class DurableIssuanceContractError extends Error implements DurableIssuanceError {
	readonly code: DurableIssuanceErrorCode;
	readonly retryClass?: DurableIssuanceRetryClass;

	/**
	 * @param code - Closed issuance failure code.
	 * @param message - Non-authoritative diagnostic text.
	 * @param retryClass - Optional closed substrate retry classification.
	 */
	constructor(code: DurableIssuanceErrorCode, message: string, retryClass?: DurableIssuanceRetryClass) {
		super(message);
		this.name = "DurableIssuanceError";
		this.code = code;
		if (retryClass !== undefined) this.retryClass = retryClass;
	}
}

/** Typed public-misuse rejection. */
export class DurableIssuanceInvalidArgumentError extends TypeError implements DurableIssuanceError {
	readonly code = "ISSUANCE_INVALID_ARGUMENT" as const;

	/** @param message - Non-authoritative diagnostic text. */
	constructor(message: string) {
		super(message);
		this.name = "DurableIssuanceTypeError";
	}
}

/** Token-free unknown-outcome error carrying only the caller-known scope. */
export class DurableIssuanceUnknownOutcomeError extends Error implements DurableIssuanceError {
	readonly code = "ISSUANCE_OUTCOME_UNKNOWN" as const;
	readonly scope: DurableIssueScope;

	/** @param scope - Caller-known scope, copied before exposure. */
	constructor(scope: DurableIssueScope) {
		super("durable issuance commit outcome is unknown");
		Object.defineProperty(this, "name", { configurable: true, value: "DurableIssuanceError" });
		this.scope = copyDurableIssueScope(scope);
	}
}

/**
 * Creates a closed issuance failure.
 * @param code - Closed issuance failure code.
 * @param message - Non-authoritative diagnostic text.
 * @param retryClass - Optional closed substrate retry classification.
 * @returns A typed issuance failure.
 */
export function createDurableIssuanceFailure(
	code: Exclude<DurableIssuanceErrorCode, "ISSUANCE_INVALID_ARGUMENT" | "ISSUANCE_OUTCOME_UNKNOWN">,
	message: string,
	retryClass?: DurableIssuanceRetryClass
): DurableIssuanceContractError {
	return new DurableIssuanceContractError(code, message, retryClass);
}

/**
 * Tests for one plain, exact, enumerable data-property record.
 * @param value - Untrusted candidate.
 * @param keys - Exact allowed string keys.
 * @returns Whether the candidate has the closed record shape.
 */
export function isClosedDurableIssuanceRecord(
	value: unknown,
	keys: readonly string[]
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		return false;
	}
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
	});
}

/**
 * Tests one primitive scope field against the v1 UTF-16 bound.
 * @param value - Untrusted candidate.
 * @returns Whether the value is a valid scope field.
 */
export function isValidDurableScopeField(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS;
}

/**
 * Validates an exact durable issuance scope.
 * @param value - Untrusted candidate.
 */
export function assertDurableIssueScope(value: unknown): asserts value is DurableIssueScope {
	if (
		!isClosedDurableIssuanceRecord(value, ["author", "objectId"]) ||
		!isValidDurableScopeField(value.author) ||
		!isValidDurableScopeField(value.objectId)
	) {
		throw new DurableIssuanceInvalidArgumentError("scope must contain bounded primitive author and objectId strings");
	}
}

/**
 * Copies a validated scope into a plain record.
 * @param scope - Valid durable issuance scope.
 * @returns A detached scope record.
 */
export function copyDurableIssueScope(scope: DurableIssueScope): DurableIssueScope {
	return { author: scope.author, objectId: scope.objectId };
}

/**
 * Compares scope values without relying on object identity.
 * @param left - First scope.
 * @param right - Second scope.
 * @returns Whether both scope fields are equal.
 */
export function durableIssueScopesEqual(left: DurableIssueScope, right: DurableIssueScope): boolean {
	return left.author === right.author && left.objectId === right.objectId;
}

/**
 * Tests the closed nonnegative safe author-sequence domain.
 * @param value - Untrusted candidate.
 * @returns Whether the value is a valid author sequence.
 */
export function isValidDurableAuthorSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Copies a nonempty unshared byte view.
 * @param value - Untrusted byte candidate.
 * @returns Detached bytes, or undefined for an invalid view.
 */
export function copyDurableIssuanceBytes(value: unknown): Uint8Array | undefined {
	if (!(value instanceof Uint8Array) || value.byteLength === 0) return undefined;
	if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) return undefined;
	return new Uint8Array(value);
}

/**
 * Compares two byte strings by value.
 * @param left - First byte string.
 * @param right - Second byte string.
 * @returns Whether both byte strings are equal.
 */
export function durableIssuanceBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * Validates and detaches an exact signed-envelope record without cryptographic verification.
 * @param value - Untrusted envelope candidate.
 * @returns A detached envelope, or undefined for an invalid shape.
 */
export function copyDurableSignedEnvelope(value: unknown): DurableSignedEnvelope | undefined {
	if (!isClosedDurableIssuanceRecord(value, ["canonicalPreimageBytes", "digest", "signature"])) return undefined;
	const canonicalPreimageBytes = copyDurableIssuanceBytes(value.canonicalPreimageBytes);
	const digest = copyDurableIssuanceBytes(value.digest);
	const signature = copyDurableIssuanceBytes(value.signature);
	if (canonicalPreimageBytes === undefined || digest === undefined || signature === undefined) return undefined;
	return { canonicalPreimageBytes, digest, signature };
}

/**
 * Validates and detaches an exact issued-record shape.
 * @param value - Untrusted issued-record candidate.
 * @returns A detached record, or undefined for an invalid shape.
 */
export function copyDurableIssuedRecord(value: unknown): DurableIssuedRecord | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["authorSequence", "envelope", "scope"]) ||
		!isValidDurableAuthorSequence(value.authorSequence)
	) {
		return undefined;
	}
	const envelope = copyDurableSignedEnvelope(value.envelope);
	try {
		assertDurableIssueScope(value.scope);
	} catch {
		return undefined;
	}
	if (envelope === undefined) return undefined;
	return { authorSequence: value.authorSequence, envelope, scope: copyDurableIssueScope(value.scope) };
}

/**
 * Confirms only the selected scope and ordinal inside a canonical preimage.
 * @param canonicalPreimageBytes - Candidate canonical preimage bytes.
 * @param scope - Selected issuance scope.
 * @param authorSequence - Selected author sequence.
 * @returns Whether the three structural fields match.
 */
export function durablePreimageMatchesScopeAndSequence(
	canonicalPreimageBytes: Uint8Array,
	scope: DurableIssueScope,
	authorSequence: number
): boolean {
	try {
		const decoded: unknown = decodeCanonical(canonicalPreimageBytes);
		return (
			typeof decoded === "object" &&
			decoded !== null &&
			!Array.isArray(decoded) &&
			(decoded as Record<string, unknown>).author === scope.author &&
			(decoded as Record<string, unknown>).objectId === scope.objectId &&
			(decoded as Record<string, unknown>).authorSequence === authorSequence
		);
	} catch {
		return false;
	}
}

/**
 * Deep-copies one validated envelope.
 * @param envelope - Valid envelope.
 * @returns A detached envelope.
 */
export function cloneDurableSignedEnvelope(envelope: DurableSignedEnvelope): DurableSignedEnvelope {
	return {
		canonicalPreimageBytes: new Uint8Array(envelope.canonicalPreimageBytes),
		digest: new Uint8Array(envelope.digest),
		signature: new Uint8Array(envelope.signature),
	};
}

/**
 * Deep-copies one validated commit graph.
 * @param commit - Valid commit.
 * @returns A detached commit graph.
 */
export function cloneDurableIssueCommit(commit: DurableIssueCommit): DurableIssueCommit {
	return {
		authorSequence: commit.authorSequence,
		envelope: cloneDurableSignedEnvelope(commit.envelope),
		issuedRecord: {
			authorSequence: commit.authorSequence,
			envelope: cloneDurableSignedEnvelope(commit.issuedRecord.envelope),
			scope: copyDurableIssueScope(commit.issuedRecord.scope),
		},
		outboxEntry: {
			authorSequence: commit.authorSequence,
			envelope: cloneDurableSignedEnvelope(commit.outboxEntry.envelope),
			scope: copyDurableIssueScope(commit.outboxEntry.scope),
		},
	};
}

/**
 * Closes and detaches a structural commit for the selected scope and ordinal.
 * @param value - Untrusted commit candidate.
 * @param scope - Selected issuance scope.
 * @param authorSequence - Selected author sequence.
 * @returns A detached closed commit.
 */
export function copyAndValidateDurableIssueCommit(
	value: unknown,
	scope: DurableIssueScope,
	authorSequence: number
): DurableIssueCommit {
	if (
		!isClosedDurableIssuanceRecord(value, ["authorSequence", "envelope", "issuedRecord", "outboxEntry"]) ||
		value.authorSequence !== authorSequence
	) {
		throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "commit has an invalid top-level shape or ordinal");
	}
	const envelope = copyDurableSignedEnvelope(value.envelope);
	const issuedRecord = copyDurableIssuedRecord(value.issuedRecord);
	const outboxEntry = copyDurableIssuedRecord(value.outboxEntry);
	if (
		envelope === undefined ||
		issuedRecord === undefined ||
		outboxEntry === undefined ||
		issuedRecord.authorSequence !== authorSequence ||
		outboxEntry.authorSequence !== authorSequence ||
		!durableIssueScopesEqual(issuedRecord.scope, scope) ||
		!durableIssueScopesEqual(outboxEntry.scope, scope) ||
		!durableIssuanceBytesEqual(envelope.canonicalPreimageBytes, issuedRecord.envelope.canonicalPreimageBytes) ||
		!durableIssuanceBytesEqual(envelope.canonicalPreimageBytes, outboxEntry.envelope.canonicalPreimageBytes) ||
		!durableIssuanceBytesEqual(envelope.digest, issuedRecord.envelope.digest) ||
		!durableIssuanceBytesEqual(envelope.digest, outboxEntry.envelope.digest) ||
		!durableIssuanceBytesEqual(envelope.signature, issuedRecord.envelope.signature) ||
		!durableIssuanceBytesEqual(envelope.signature, outboxEntry.envelope.signature) ||
		!durablePreimageMatchesScopeAndSequence(envelope.canonicalPreimageBytes, scope, authorSequence)
	) {
		throw createDurableIssuanceFailure(
			"ISSUANCE_COMMIT_INVALID",
			"commit fields do not form one closed issuance record"
		);
	}
	return {
		authorSequence,
		envelope,
		issuedRecord: {
			authorSequence,
			envelope: cloneDurableSignedEnvelope(envelope),
			scope: copyDurableIssueScope(scope),
		},
		outboxEntry: {
			authorSequence,
			envelope: cloneDurableSignedEnvelope(envelope),
			scope: copyDurableIssueScope(scope),
		},
	};
}

export type DurableIssuanceCompoundKey = readonly [string, string, number];

/**
 * Compares compound issuance keys by JavaScript UTF-16 code units and then ordinal.
 * @param left - First compound key.
 * @param right - Second compound key.
 * @returns A negative value, zero, or a positive value according to the ordering.
 */
export function compareDurableIssuanceCompoundKeys(
	left: DurableIssuanceCompoundKey,
	right: DurableIssuanceCompoundKey
): number {
	if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
	if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
	return left[2] - right[2];
}
