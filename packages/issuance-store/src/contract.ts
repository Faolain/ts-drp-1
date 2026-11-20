import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { durablePreimageHeader } from "./preimage-header.js";
import { MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS, MAXIMUM_DURABLE_ISSUE_BATCH_COMMITS, SETTLEMENT_HAND_BACK_LIMITS, SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES, SETTLEMENT_REPLACEMENT_MAX_INTENTS, SETTLEMENT_REPLACEMENT_DIGEST_LIMITS } from "./types.js";
import type {
	DurableIssuanceError,
	DurableIssuanceErrorCode,
	DurableIssuanceRetryClass,
	DurableIssueBatchInput,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableSignedEnvelope,
	SettlementHandBack,
	SettlementHandBackKey,
	SettlementHandBackReason,
	SettlementInheritance,
	SettlementPlan,
	SettlementPlanEntry,
	SettlementReissueOrigin,
	SettlementSourceContext,
	SettlementReplacementChunk,
	SettlementReplacementProgress,
} from "./types.js";

type SettlementPlanEffect = NonNullable<DurableIssueCommit["planEffect"]>;

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

	/**
	 * @param scope - Caller-known scope, copied before exposure.
	 * @param options
	 */
	constructor(scope: DurableIssueScope, options?: ErrorOptions) {
		super("durable issuance commit outcome is unknown", options);
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
		const header = durablePreimageHeader(canonicalPreimageBytes);
		return header.author === scope.author && header.objectId === scope.objectId && header.authorSequence === authorSequence;
	} catch {
		return false;
	}
}

/**
 * Derives the final submitted operation logical time from one validated commit.
 * @param commit - Validated durable issue commit.
 * @returns The positive final logical time, or undefined for an invalid preimage.
 */
export function settlementReplacementLastLogicalTime(commit: DurableIssueCommit): number | undefined {
	return settlementReplacementLastLogicalTimeFromPreimage(commit.envelope.canonicalPreimageBytes);
}

/**
 * Original replacement clock derivation, usable before irreversible signing.
 * @param exactUnsignedBytes
 */
export function settlementReplacementLastLogicalTimeFromPreimage(exactUnsignedBytes: Uint8Array): number | undefined {
	try {
		const decoded: unknown = decodeCanonical(exactUnsignedBytes);
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
		const record = decoded as Record<string, unknown>;
		let logicalTime = record.logicalTime;
		const operation = record.operation;
		if (
			typeof operation === "object" &&
			operation !== null &&
			Reflect.get(operation, "action") === "applicationBatch"
		) {
			if (!isClosedDurableIssuanceRecord(operation, ["action", "batch"])) return undefined;
			const batch = operation.batch;
			if (!isClosedDurableIssuanceRecord(batch, ["entries", "version"]) || batch.version !== 1) return undefined;
			const entries = batch.entries;
			if (!Array.isArray(entries) || entries.length < 2 || entries.length > SETTLEMENT_REPLACEMENT_MAX_INTENTS)
				return undefined;
			let previous = -1;
			for (const entry of entries) {
				if (
					!isClosedDurableIssuanceRecord(entry, ["logicalTime", "operation"]) ||
					!Number.isSafeInteger(entry.logicalTime) ||
					(entry.logicalTime as number) <= previous
				)
					return undefined;
				previous = entry.logicalTime as number;
			}
			const limits = { maxBytes: 65_536, maxDepth: 8, maxItems: 1_024 };
			const bytes = encodeCanonical(operation, limits);
			if (!durableIssuanceBytesEqual(bytes, encodeCanonical(decodeCanonical(bytes, limits), limits))) return undefined;
			logicalTime = previous;
		}
		return Number.isSafeInteger(logicalTime) && (logicalTime as number) > 0 ? (logicalTime as number) : undefined;
	} catch {
		return undefined;
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
		...(commit.planEffect === undefined
			? {}
			: {
					planEffect:
						commit.planEffect.kind === "fence"
							? { kind: "fence" as const }
							: commit.planEffect.kind === "hand-back"
								? {
										intent: commit.planEffect.intent,
										kind: "hand-back" as const,
										...(commit.planEffect.originSequence === undefined
											? {}
											: { originSequence: commit.planEffect.originSequence }),
										sourceSequence: commit.planEffect.sourceSequence,
									}
							: "fromIntent" in commit.planEffect
								? {
										fromIntent: commit.planEffect.fromIntent,
										intentDigest: new Uint8Array(commit.planEffect.intentDigest),
										kind: "replacement" as const,
										sourceSequence: commit.planEffect.sourceSequence,
										throughIntent: commit.planEffect.throughIntent,
									}
								: { kind: "replacement" as const, sourceSequence: commit.planEffect.sourceSequence },
				}),
	};
}

/**
 * Validates and detaches one optional settlement-plan issue effect.
 * @param value - Untrusted candidate effect.
 * @returns The detached effect, or undefined when invalid.
 */
export function copySettlementPlanEffect(value: unknown): SettlementPlanEffect | undefined {
	const withOrigin = isClosedDurableIssuanceRecord(value, ["intent", "kind", "originSequence", "sourceSequence"]);
	if (withOrigin || isClosedDurableIssuanceRecord(value, ["intent", "kind", "sourceSequence"])) {
		return value.kind === "hand-back" &&
			isValidDurableAuthorSequence(value.sourceSequence) &&
			isValidDurableAuthorSequence(value.intent) &&
			value.intent < SETTLEMENT_HAND_BACK_LIMITS.maxRecords &&
			(!withOrigin ||
				(isValidDurableAuthorSequence(value.originSequence) && value.originSequence <= value.sourceSequence))
			? {
					intent: value.intent,
					kind: "hand-back",
					...(withOrigin ? { originSequence: value.originSequence as number } : {}),
					sourceSequence: value.sourceSequence,
				}
			: undefined;
	}
	if (!isClosedDurableIssuanceRecord(value, ["kind"])) {
		if (isClosedDurableIssuanceRecord(value, ["kind", "sourceSequence"])) {
			return value.kind === "replacement" && isValidDurableAuthorSequence(value.sourceSequence)
				? { kind: "replacement", sourceSequence: value.sourceSequence }
				: undefined;
		}
		if (
			!isClosedDurableIssuanceRecord(value, [
				"fromIntent",
				"intentDigest",
				"kind",
				"sourceSequence",
				"throughIntent",
			]) ||
			value.kind !== "replacement" ||
			!isValidDurableAuthorSequence(value.sourceSequence) ||
			!isValidDurableAuthorSequence(value.fromIntent) ||
			!isValidDurableAuthorSequence(value.throughIntent) ||
			value.fromIntent >= value.throughIntent ||
			value.throughIntent > SETTLEMENT_REPLACEMENT_MAX_INTENTS
		) {
			return undefined;
		}
		const intentDigest = copyDurableIssuanceBytes(value.intentDigest);
		return intentDigest?.byteLength === 32
			? {
					fromIntent: value.fromIntent,
					intentDigest,
					kind: "replacement",
					sourceSequence: value.sourceSequence,
					throughIntent: value.throughIntent,
				}
			: undefined;
	}
	return value.kind === "fence" ? { kind: "fence" } : undefined;
}

function copySettlementReplacementChunk(value: unknown): SettlementReplacementChunk | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["lastLogicalTime", "replacementSequence", "throughIntent"]) ||
		!isValidDurableAuthorSequence(value.replacementSequence) ||
		!Number.isSafeInteger(value.throughIntent) ||
		(value.throughIntent as number) < 1 ||
		!Number.isSafeInteger(value.lastLogicalTime) ||
		(value.lastLogicalTime as number) < 1
	) {
		return undefined;
	}
	return {
		lastLogicalTime: value.lastLogicalTime as number,
		replacementSequence: value.replacementSequence,
		throughIntent: value.throughIntent as number,
	};
}

function copySettlementReplacementProgress(value: unknown): SettlementReplacementProgress | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["chunks", "intentCount", "intentDigest", "version"]) ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.intentCount) ||
		(value.intentCount as number) < 1 ||
		(value.intentCount as number) > SETTLEMENT_REPLACEMENT_MAX_INTENTS ||
		!Array.isArray(value.chunks) ||
		value.chunks.length > (value.intentCount as number)
	) {
		return undefined;
	}
	const intentDigest = copyDurableIssuanceBytes(value.intentDigest);
	if (intentDigest?.byteLength !== 32) return undefined;
	const chunks: SettlementReplacementChunk[] = [];
	let priorSequence = -1;
	let priorThrough = 0;
	let priorLogicalTime = 0;
	for (const rawChunk of value.chunks) {
		const chunk = copySettlementReplacementChunk(rawChunk);
		if (
			chunk === undefined ||
			chunk.replacementSequence <= priorSequence ||
			chunk.throughIntent <= priorThrough ||
			chunk.throughIntent > (value.intentCount as number) ||
			chunk.lastLogicalTime <= priorLogicalTime
		) {
			return undefined;
		}
		chunks.push(chunk);
		priorSequence = chunk.replacementSequence;
		priorThrough = chunk.throughIntent;
		priorLogicalTime = chunk.lastLogicalTime;
	}
	return { chunks, intentCount: value.intentCount as number, intentDigest, version: 1 };
}

/**
 * Detaches a retained target reference without granting migration authority.
 * @param value - Untrusted native reference.
 * @returns The exact structural reference, or undefined.
 */
function copySettlementInheritance(value: unknown): SettlementInheritance | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, [
			"sourceObjectId",
			"targetObjectId",
			"targetAuthor",
			"targetAuthorSequence",
			"targetVertexDigest",
		]) ||
		!isValidDurableScopeField(value.sourceObjectId) ||
		!isValidDurableScopeField(value.targetObjectId) ||
		value.sourceObjectId === value.targetObjectId ||
		!isValidDurableScopeField(value.targetAuthor) ||
		!isValidDurableAuthorSequence(value.targetAuthorSequence)
	)
		return undefined;
	const targetVertexDigest = copyDurableIssuanceBytes(value.targetVertexDigest);
	if (targetVertexDigest?.byteLength !== 32) return undefined;
	return {
		sourceObjectId: value.sourceObjectId,
		targetObjectId: value.targetObjectId,
		targetAuthor: value.targetAuthor,
		targetAuthorSequence: value.targetAuthorSequence,
		targetVertexDigest,
	};
}

function copySettlementPlanEntry(value: unknown): SettlementPlanEntry | undefined {
	const hasSourceContext = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceContextDigest");
	const hasSourceResolution = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceResolutionDigest");
	const hasResolutionKind = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceResolutionKind");
	const hasResolutionScope = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceResolutionScope");
	const hasSourceObjectId =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "sourceObjectId");
	const hasTransformRefusal =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "transformRefusal");
	const hasProgress =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "replacementProgress");
	const hasInheritance =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "inheritance");
	const hasHandedBack = typeof value === "object" && value !== null && Object.hasOwn(value, "handedBack");
	if (
		!isClosedDurableIssuanceRecord(value, [
			"disposition",
			...(hasHandedBack ? ["handedBack"] : []),
			...(hasSourceObjectId ? ["sourceObjectId"] : []),
			...(hasSourceContext ? ["sourceContextDigest"] : []),
			...(hasSourceResolution ? ["sourceResolutionDigest"] : []),
			...(hasResolutionKind ? ["sourceResolutionKind"] : []),
			...(hasResolutionScope ? ["sourceResolutionScope"] : []),
			...(hasTransformRefusal ? ["transformRefusal"] : []),
			...(hasInheritance ? ["inheritance"] : []),
			...(hasProgress ? ["replacementProgress"] : []),
			"replacementSequence",
			"sourceDigest",
			"sourceSequence",
		]) ||
		!isValidDurableAuthorSequence(value.sourceSequence) ||
		(value.replacementSequence !== null && !isValidDurableAuthorSequence(value.replacementSequence)) ||
		(value.disposition !== "expire" &&
			value.disposition !== "rebase" &&
			value.disposition !== "transform" &&
			value.disposition !== "manual-review" &&
			value.disposition !== "committed" &&
			value.disposition !== "inherited")
	) {
		return undefined;
	}
	const sourceDigest = copyDurableIssuanceBytes(value.sourceDigest);
	const sourceContextDigest = hasSourceContext ? copyDurableIssuanceBytes(value.sourceContextDigest) : undefined;
	const sourceResolutionDigest = hasSourceResolution ? copyDurableIssuanceBytes(value.sourceResolutionDigest) : undefined;
	const replacementProgress = hasProgress ? copySettlementReplacementProgress(value.replacementProgress) : undefined;
	const inheritance = hasInheritance ? copySettlementInheritance(value.inheritance) : undefined;
	const rawRefusal = hasTransformRefusal ? value.transformRefusal : undefined;
	const refusalDigest =
		rawRefusal !== undefined && typeof rawRefusal === "object" && rawRefusal !== null
			? copyDurableIssuanceBytes(Reflect.get(rawRefusal, "proposedIntentDigest"))
			: undefined;
	const transformRefusal =
		rawRefusal !== undefined &&
		isClosedDurableIssuanceRecord(rawRefusal, ["version", "kind", "proposedIntentDigest", "reason"]) &&
		rawRefusal.version === 1 &&
		rawRefusal.kind === "admission-refused" &&
		(rawRefusal.reason === "capacity" ||
			rawRefusal.reason === "identity-conflict" ||
			rawRefusal.reason === "encoding") &&
		refusalDigest?.byteLength === 32
			? {
					version: 1 as const,
					kind: "admission-refused" as const,
					reason: rawRefusal.reason as "capacity" | "identity-conflict" | "encoding",
					proposedIntentDigest: refusalDigest,
				}
			: undefined;
	const rawHandedBack = hasHandedBack ? value.handedBack : undefined;
	const handedBack =
		rawHandedBack !== undefined &&
		isClosedDurableIssuanceRecord(rawHandedBack, ["fromIntent", "reason"]) &&
		isValidDurableAuthorSequence(rawHandedBack.fromIntent) &&
		isSettlementHandBackReason(rawHandedBack.reason)
			? { fromIntent: rawHandedBack.fromIntent, reason: rawHandedBack.reason }
			: undefined;
	if (
		sourceDigest === undefined ||
		(hasHandedBack &&
			(handedBack === undefined ||
				value.disposition !== "expire" ||
				value.replacementSequence !== null ||
				hasSourceContext ||
				hasSourceResolution ||
				hasInheritance ||
				(replacementProgress === undefined
					? handedBack.fromIntent !== 0
					: handedBack.fromIntent !== (replacementProgress.chunks.at(-1)?.throughIntent ?? 0) ||
						handedBack.fromIntent >= replacementProgress.intentCount))) ||
		(hasSourceContext && sourceContextDigest?.byteLength !== 32) ||
		// A resolution is exactly one of two signed terminal proofs: received-close
		// completion (`committed`) or local-author expiry (`expire`). Each has its
		// own native reopen verifier; neither may carry replacement work.
		(hasSourceResolution && (sourceResolutionDigest?.byteLength !== 32 || (!hasResolutionScope && (!hasSourceContext ||
			(value.disposition !== "committed" && value.disposition !== "expire"))))) ||
		(value.disposition === "expire" && hasSourceResolution && (value.replacementSequence !== null || hasInheritance)) ||
		// A frontier resolution is a signed expiry decided on the creator's signed frontier; a replacement
		// resolution releases a replaced source whose replacement is committed (replaced-source scope only).
		(hasResolutionKind && ((value.sourceResolutionKind !== "frontier" && value.sourceResolutionKind !== "replacement") ||
			!hasSourceResolution || (value.sourceResolutionKind === "replacement" && !hasResolutionScope) ||
			(!hasResolutionScope && value.disposition !== "expire") || hasProgress || hasTransformRefusal)) ||
		// A replaced-source resolution: the frontier resolution of a completed single replacement's source.
		(hasResolutionScope && (value.sourceResolutionScope !== "replaced-source" || !hasResolutionKind || !hasSourceResolution ||
			(value.disposition !== "rebase" && value.disposition !== "transform") || value.replacementSequence === null ||
			hasProgress || hasTransformRefusal || hasSourceObjectId || hasInheritance)) ||
		(value.disposition === "committed" && (!hasSourceResolution || value.replacementSequence !== null || hasProgress || hasInheritance)) ||
		(hasSourceObjectId && (!isValidDurableScopeField(value.sourceObjectId) || value.disposition === "inherited")) ||
		(hasTransformRefusal && (transformRefusal === undefined || (value.disposition !== "transform" && !hasHandedBack))) ||
		(hasProgress && replacementProgress === undefined) ||
		(hasInheritance && inheritance === undefined) ||
		(value.disposition === "inherited"
			? inheritance === undefined || value.replacementSequence !== null || hasProgress || sourceDigest.byteLength !== 32
			: hasInheritance) ||
		(replacementProgress !== undefined &&
			((value.disposition === "expire" && !hasHandedBack) || value.disposition === "manual-review"))
	) {
		return undefined;
	}
	if (replacementProgress !== undefined) {
		const finalChunk = replacementProgress.chunks.at(-1);
		const complete = finalChunk?.throughIntent === replacementProgress.intentCount;
		if ((complete ? finalChunk.replacementSequence : null) !== value.replacementSequence) return undefined;
	}
	return {
		disposition: value.disposition,
		...(handedBack === undefined ? {} : { handedBack }),
		...(sourceContextDigest === undefined ? {} : { sourceContextDigest }),
		...(sourceResolutionDigest === undefined ? {} : { sourceResolutionDigest }),
		...(hasResolutionKind ? { sourceResolutionKind: value.sourceResolutionKind as "frontier" | "replacement" } : {}),
		...(hasResolutionScope ? { sourceResolutionScope: "replaced-source" as const } : {}),
		...(hasSourceObjectId ? { sourceObjectId: value.sourceObjectId as string } : {}),
		...(transformRefusal === undefined ? {} : { transformRefusal }),
		...(inheritance === undefined ? {} : { inheritance }),
		...(replacementProgress === undefined ? {} : { replacementProgress }),
		replacementSequence: value.replacementSequence,
		sourceDigest,
		sourceSequence: value.sourceSequence,
	};
}

/**
 * Validates and detaches one exact settlement plan for its selected scope.
 * @param value - Untrusted candidate plan.
 * @param scope - Validated scope the plan must match.
 * @returns The detached plan, or undefined when invalid.
 */
function isSettlementHandBackReason(value: unknown): value is SettlementHandBackReason {
	return value === "application-state-limit" || value === "admission-rejected" || value === "transient-exhausted";
}

function copySettlementHandBack(value: unknown): SettlementHandBack | undefined {
	const hasReason = typeof value === "object" && value !== null && Object.hasOwn(value, "reason");
	const hasOrigin = typeof value === "object" && value !== null && Object.hasOwn(value, "originSequence");
	if (
		!isClosedDurableIssuanceRecord(value, [
			...(hasReason ? ["reason"] : []),
			"exactCanonicalOperationBytes",
			"intent",
			...(hasOrigin ? ["originSequence"] : []),
			"reissueSequence",
			"sourceDigest",
			"sourceEpoch",
			"sourceSequence",
		]) ||
		(hasReason && !isSettlementHandBackReason(value.reason)) ||
		!isValidDurableAuthorSequence(value.sourceSequence) ||
		// Written only when it differs from the source (the origin is always older).
		(hasOrigin &&
			(!isValidDurableAuthorSequence(value.originSequence) || value.originSequence >= value.sourceSequence)) ||
		!isValidDurableAuthorSequence(value.sourceEpoch) ||
		!isValidDurableAuthorSequence(value.intent) ||
		value.intent >= SETTLEMENT_HAND_BACK_LIMITS.maxRecords ||
		(value.reissueSequence !== null &&
			(!isValidDurableAuthorSequence(value.reissueSequence) || value.reissueSequence <= value.sourceSequence))
	)
		return undefined;
	const sourceDigest = copyDurableIssuanceBytes(value.sourceDigest);
	const operation = copyDurableIssuanceBytes(value.exactCanonicalOperationBytes);
	if (
		sourceDigest?.byteLength !== 32 ||
		operation === undefined ||
		operation.byteLength === 0 ||
		operation.byteLength > SETTLEMENT_HAND_BACK_LIMITS.maxOperationBytes
	)
		return undefined;
	return {
		...(hasReason ? { reason: value.reason as SettlementHandBackReason } : {}),
		exactCanonicalOperationBytes: operation,
		intent: value.intent,
		...(hasOrigin ? { originSequence: value.originSequence as number } : {}),
		reissueSequence: value.reissueSequence,
		sourceDigest,
		sourceEpoch: value.sourceEpoch,
		sourceSequence: value.sourceSequence,
	};
}

/**
 * The author's order of hand-back records: by the move's origin (originSequence ?? sourceSequence), then
 * by the carrier row (the chunks of one replaced move carry its intents in order), then by intent.
 * @param left - One record.
 * @param right - The other.
 * @returns Negative, zero or positive by that order.
 */
export function compareSettlementHandBacks(
	left: Pick<SettlementHandBack, "intent" | "originSequence" | "sourceSequence">,
	right: Pick<SettlementHandBack, "intent" | "originSequence" | "sourceSequence">
): number {
	return (
		(left.originSequence ?? left.sourceSequence) - (right.originSequence ?? right.sourceSequence) ||
		left.sourceSequence - right.sourceSequence ||
		left.intent - right.intent
	);
}

/**
 * Validates a plan's hand-back records: present only when non-empty, in the author's order
 * (compareSettlementHandBacks) without duplicates, and within SETTLEMENT_HAND_BACK_LIMITS.
 * @param value - Untrusted records.
 * @returns The detached records, or undefined when invalid.
 */
function copySettlementHandBacks(value: unknown): SettlementHandBack[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > SETTLEMENT_HAND_BACK_LIMITS.maxRecords) return undefined;
	const records: SettlementHandBack[] = [];
	const keys = new Set<string>();
	let bytes = 0;
	for (const raw of value) {
		const record = copySettlementHandBack(raw);
		const prior = records.at(-1);
		const key = record === undefined ? "" : `${record.sourceSequence}:${record.intent}`;
		if (
			record === undefined ||
			(prior !== undefined && compareSettlementHandBacks(prior, record) >= 0) ||
			keys.has(key) ||
			(bytes += record.exactCanonicalOperationBytes.byteLength) > SETTLEMENT_HAND_BACK_LIMITS.maxOperationBytes
		)
			return undefined;
		keys.add(key);
		records.push(record);
	}
	return records;
}

/**
 * Validates a plan's reissue origins: present only when non-empty, sorted by reissueSequence without
 * duplicates, each origin older than its reissue, at most SETTLEMENT_HAND_BACK_LIMITS.maxRecords.
 * @param value - Untrusted entries.
 * @returns The detached entries, or undefined when invalid.
 */
function copySettlementReissueOrigins(value: unknown): SettlementReissueOrigin[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > SETTLEMENT_HAND_BACK_LIMITS.maxRecords)
		return undefined;
	const entries: SettlementReissueOrigin[] = [];
	for (const raw of value) {
		const prior = entries.at(-1);
		if (
			!isClosedDurableIssuanceRecord(raw, ["originSequence", "reissueSequence"]) ||
			!isValidDurableAuthorSequence(raw.reissueSequence) ||
			!isValidDurableAuthorSequence(raw.originSequence) ||
			raw.originSequence >= raw.reissueSequence ||
			(prior !== undefined && raw.reissueSequence <= prior.reissueSequence)
		)
			return undefined;
		entries.push({ originSequence: raw.originSequence, reissueSequence: raw.reissueSequence });
	}
	return entries;
}

/**
 * The plan's hand-back records with `added` merged in (ordered), or undefined when that would exceed
 * SETTLEMENT_HAND_BACK_LIMITS or name an existing record: the caller then records none of them.
 * @param current - The plan's records (absent when none).
 * @param added - New unconsumed records for one resolved source.
 * @returns The merged records, or undefined.
 */
export function settlementHandBacksWith(
	current: readonly SettlementHandBack[] | undefined,
	added: readonly SettlementHandBack[]
): readonly SettlementHandBack[] | undefined {
	const merged = [...(current ?? []), ...added].sort(compareSettlementHandBacks);
	return copySettlementHandBacks(merged);
}

/**
 * The origin of the move an own row carries: the plan's replacement links are walked back from `sequence`
 * (a replacement, or a chunk of one, links to its source) until a reissued row (a reissueOrigins entry,
 * whose origin it returns with the entry) or the move's first row (its own sequence). Plan data only.
 * @param plan - The durable plan (absent when none).
 * @param sequence - The carrier row.
 * @returns The move's origin, and the reissueOrigins entry it was read from, if any.
 */
export function settlementMoveOrigin(
	plan: Pick<SettlementPlan, "entries" | "reissueOrigins"> | null | undefined,
	sequence: number
): Readonly<{ originSequence: number; reissue?: SettlementReissueOrigin }> {
	let current = sequence;
	// A chain is at most one link per plan entry; the bound only guards a malformed plan.
	for (let depth = 0; depth <= (plan?.entries.length ?? 0); depth++) {
		const reissue = plan?.reissueOrigins?.find((entry) => entry.reissueSequence === current);
		if (reissue !== undefined) return { originSequence: reissue.originSequence, reissue };
		const link = plan?.entries.find(
			(entry) =>
				entry.sourceObjectId === undefined &&
				entry.sourceSequence < current &&
				(entry.replacementSequence === current ||
					entry.replacementProgress?.chunks.some((chunk) => chunk.replacementSequence === current) === true)
		);
		if (link === undefined) break;
		current = link.sourceSequence;
	}
	return { originSequence: current };
}

/**
 * The origin of the move an own row carried, for a row read back from the author's history (the
 * given-back moves' supersession): settlementMoveOrigin, and, when the chain ends at a row the plan holds
 * a hand-back record of with an origin, that record's origin. A reissued move given back again keeps its
 * origin only on its new record: the same write drops its reissueOrigins entry, so the reissued row
 * alone would read as a move of its own (and as a newer move of its own identity). Plan data only.
 * @param plan - The durable plan (absent when none).
 * @param sequence - The own row.
 * @returns The move's origin.
 */
export function settlementOwnRowOrigin(
	plan: Pick<SettlementPlan, "entries" | "handBacks" | "reissueOrigins"> | null | undefined,
	sequence: number
): number {
	const { originSequence, reissue } = settlementMoveOrigin(plan, sequence);
	if (reissue !== undefined) return originSequence;
	return (
		plan?.handBacks?.find((record) => record.sourceSequence === originSequence && record.originSequence !== undefined)
			?.originSequence ?? originSequence
	);
}

/**
 * The hand-back records of one expired or frontier-resolved own row, each carrying its move's origin
 * (settlementMoveOrigin) when it differs from the row, merged into the plan's records; and the plan's
 * reissue origins without the entry that origin was read from (the move is settled: the entry's job
 * passes to the new records in the same write). Undefined when the records do not fit.
 * @param plan - The durable plan, for links and reissue origins.
 * @param current - The records so far in this write (unconsumed ones).
 * @param origins - The reissue origins so far in this write.
 * @param added - The row's new unconsumed records, without origins.
 * @returns The merged records and remaining origins, or undefined.
 */
export function settlementHandBacksAtOrigin(
	plan: Pick<SettlementPlan, "entries" | "reissueOrigins"> | null | undefined,
	current: readonly SettlementHandBack[] | undefined,
	origins: readonly SettlementReissueOrigin[] | undefined,
	added: readonly SettlementHandBack[]
):
	| Readonly<{
			handBacks: readonly SettlementHandBack[];
			reissueOrigins: readonly SettlementReissueOrigin[] | undefined;
	  }>
	| undefined {
	const source = added[0]?.sourceSequence;
	if (source === undefined || added.some((record) => record.sourceSequence !== source)) return undefined;
	const origin = settlementMoveOrigin(plan, source);
	const handBacks = settlementHandBacksWith(
		current,
		origin.originSequence === source
			? added
			: added.map((record) => ({ ...record, originSequence: origin.originSequence }))
	);
	if (handBacks === undefined) return undefined;
	const remaining =
		origin.reissue === undefined
			? origins
			: origins?.filter((entry) => entry.reissueSequence !== origin.reissue?.reissueSequence);
	return { handBacks, reissueOrigins: remaining === undefined || remaining.length === 0 ? undefined : remaining };
}

/**
 * The window's hand-back records for one plan merge: each expiring own row (in sequence order) gives
 * its operations back as unconsumed records carrying the move's origin, and the reissue-origin entry
 * that origin was read from is dropped in the same write. Consumed records are dropped (they hold no
 * record slot; the reissue's entry keeps the move's origin). A row whose records do not fit the record
 * bound is not expired now (deferred: it stays live and is given back by a later merge) and drops
 * nothing: every reissue-origin entry stays.
 * @param plan - The durable plan before the merge.
 * @param expiring - The rows the window expires, each with its operations' exact canonical bytes.
 * @returns The merged records and origins, the rows expired, and the deferred moves.
 */
export function settlementWindowHandBacks(
	plan: SettlementPlan | null,
	expiring: readonly Readonly<{
		sourceSequence: number;
		sourceDigest: Uint8Array;
		sourceEpoch: number;
		operations: readonly Uint8Array[];
	}>[]
): Readonly<{
	handBacks: readonly SettlementHandBack[] | undefined;
	reissueOrigins: readonly SettlementReissueOrigin[] | undefined;
	expired: ReadonlySet<number>;
	deferredMoves: number;
}> {
	let handBacks: readonly SettlementHandBack[] | undefined = plan?.handBacks?.filter(
		(record) => record.reissueSequence === null
	);
	let reissueOrigins = plan?.reissueOrigins;
	const expired = new Set<number>();
	let deferredMoves = 0;
	for (const row of [...expiring].sort((left, right) => left.sourceSequence - right.sourceSequence)) {
		const recorded = settlementHandBacksAtOrigin(
			plan,
			handBacks,
			reissueOrigins,
			row.operations.map((operation, intent) => ({
				exactCanonicalOperationBytes: operation,
				intent,
				reissueSequence: null,
				sourceDigest: row.sourceDigest,
				sourceEpoch: row.sourceEpoch,
				sourceSequence: row.sourceSequence,
			}))
		);
		if (recorded === undefined) {
			deferredMoves += row.operations.length;
			continue;
		}
		handBacks = recorded.handBacks;
		reissueOrigins = recorded.reissueOrigins;
		expired.add(row.sourceSequence);
	}
	return {
		handBacks: handBacks === undefined || handBacks.length === 0 ? undefined : handBacks,
		reissueOrigins,
		expired,
		deferredMoves,
	};
}

/**
 * The newest row carrying a reissued move: the plan's replacement links are followed forward from the
 * reissued row (a replacement, or the newest chunk of one, replaces its source).
 * @param plan - The durable plan.
 * @param reissueSequence - The reissued row.
 * @returns The chain's last carrier.
 */
export function settlementReissueLastCarrier(plan: Pick<SettlementPlan, "entries">, reissueSequence: number): number {
	return settlementReissueChain(plan, reissueSequence).last;
}

/**
 * The rows carrying a reissued move, oldest first: the reissued row, then each replacement the plan links
 * forward from it; `last` is the newest (settlementReissueLastCarrier).
 * @param plan - The durable plan, or null.
 * @param reissueSequence - The reissued row.
 * @returns The chain's rows and its last carrier.
 */
function settlementReissueChain(
	plan: Pick<SettlementPlan, "entries"> | null,
	reissueSequence: number
): Readonly<{ rows: readonly number[]; last: number }> {
	const rows = [reissueSequence];
	let current = reissueSequence;
	for (let depth = 0; plan !== null && depth <= plan.entries.length; depth++) {
		const entry = plan.entries.find(
			(candidate) => candidate.sourceObjectId === undefined && candidate.sourceSequence === current
		);
		const next =
			entry === undefined
				? undefined
				: (entry.replacementSequence ?? entry.replacementProgress?.chunks.at(-1)?.replacementSequence);
		if (next === undefined || next <= current) break;
		rows.push(next);
		current = next;
	}
	return { rows, last: current };
}

/**
 * The reissue origins a plan write keeps: an entry is dropped once the creator's signed frontier in the
 * installed settlement capability ADMITTED its chain's last carrier, never on local acceptance or relay
 * evidence, and never because the reissued row was replaced. Being at or below the frontier
 * (`admittedThrough`, terminalThrough) is not enough: the frontier can pass a displaced row (a later own
 * fence admitted), and such a row is still given back later (its window expiry or its frontier
 * resolution), which needs the entry for the move's origin. So an entry is kept while its last carrier
 * is displaced in this write (`displaced`) or has an own plan entry other than "committed" (displaced,
 * retained, expired or replaced). Model settlement-window.qnt settlementAuthorOrder, variant terminalDrop.
 * @param plan - The durable plan before the write (for the replacement links and dispositions).
 * @param origins - The entries so far in this write.
 * @param admittedThrough - The signed frontier's terminal author sequence, or null without one.
 * @param displaced - The own rows this write knows displaced (its displaced sources).
 * @returns The entries kept (undefined when none).
 */
export function settlementReissueOriginsUnsettled(
	plan: Pick<SettlementPlan, "entries">,
	origins: readonly SettlementReissueOrigin[] | undefined,
	admittedThrough: number | null,
	displaced: ReadonlySet<number> = new Set()
): readonly SettlementReissueOrigin[] | undefined {
	if (origins === undefined || admittedThrough === null) return origins;
	const admitted = (sequence: number): boolean =>
		sequence <= admittedThrough &&
		!displaced.has(sequence) &&
		!plan.entries.some(
			(entry) =>
				entry.sourceObjectId === undefined && entry.sourceSequence === sequence && entry.disposition !== "committed"
		);
	const kept = origins.filter((entry) => !admitted(settlementReissueLastCarrier(plan, entry.reissueSequence)));
	return kept.length === 0 ? undefined : kept.length === origins.length ? origins : kept;
}

/**
 * The settlement backlog V3RoomLocalBacklogFull bounds, in moves (as hand-back records count them, one
 * per intent). Each move is counted exactly once:
 * - each live replaced move, by the entry of its newest displaced row whose replacement is not itself
 *   displaced, or which is not yet replaced;
 * - each retained source's moves (manual-review);
 * - every unconsumed hand-back record;
 * - every reissued move (a reissueOrigins entry, kept until the plan write that sees the move settled),
 *   pending on its chain's last carrier. A chain with a row whose own entry or record counts it above is
 *   counted there instead; a displaced row without one counts here (reissue, displace, replace and
 *   expire keep the count: tests/settlement-reissue-origins-store.test.ts).
 * A reissue moves one unit from the record term to the entry term, so the total does not grow. A move
 * whose newest row is a replacement or a reissue is `pending`: it leaves the count once a creator row
 * reaches every such row (the creator admitted it), the evidence that removes new moves. A row counts
 * all its moves: Grid batches moves made together into one row, and each of them needs its own record
 * when the window gives it back, so counting the row once let the Writer accept moves past the record
 * bound.
 * @param plan - The durable plan.
 * @param displaced - The displaced own rows of the last rebase scan, with their moves.
 * @returns The moves counted until the next plan write, and the pending ones.
 */
export function settlementBacklogMoves(
	plan: Pick<SettlementPlan, "entries" | "handBacks" | "reissueOrigins"> | null,
	displaced: ReadonlyMap<number, number>
): Readonly<{ fixed: number; pending: readonly Readonly<{ rows: readonly number[]; moves: number }>[] }> {
	// A row the scan no longer lists counts one move (it is retired or proven, never more than its record).
	const moves = (sequence: number): number => Math.max(1, displaced.get(sequence) ?? 1);
	let fixed = 0;
	const pending: Readonly<{ rows: readonly number[]; moves: number }>[] = [];
	// The own rows whose plan entry or record counts their move above: a reissued chain through one of
	// them is counted there, not again by its reissueOrigins entry.
	const counted = new Set<number>();
	for (const entry of plan?.entries ?? []) {
		if (entry.sourceObjectId !== undefined) continue;
		if (entry.disposition === "manual-review") {
			fixed += moves(entry.sourceSequence);
			counted.add(entry.sourceSequence);
			continue;
		}
		if (entry.disposition !== "rebase" && entry.disposition !== "transform") continue;
		if (!displaced.has(entry.sourceSequence)) continue;
		if (entry.replacementSequence !== null && displaced.has(entry.replacementSequence)) continue;
		if (entry.replacementProgress?.chunks.some((chunk) => displaced.has(chunk.replacementSequence)) === true) continue;
		const rows = [
			...(entry.replacementSequence === null ? [] : [entry.replacementSequence]),
			...(entry.replacementProgress?.chunks.map((chunk) => chunk.replacementSequence) ?? []),
		];
		counted.add(entry.sourceSequence);
		if (rows.length === 0) fixed += moves(entry.sourceSequence);
		else pending.push(Object.freeze({ rows: Object.freeze([...new Set(rows)]), moves: moves(entry.sourceSequence) }));
	}
	const entries = new Set((plan?.reissueOrigins ?? []).map((entry) => entry.reissueSequence));
	for (const record of plan?.handBacks ?? []) {
		counted.add(record.sourceSequence);
		if (record.reissueSequence === null) fixed += 1;
		// A consumed record written before reissueOrigins existed has no entry: its reissue counts here.
		else if (!entries.has(record.reissueSequence))
			pending.push(Object.freeze({ rows: Object.freeze([record.reissueSequence]), moves: 1 }));
	}
	for (const reissued of entries) {
		// Skipped only when a row of its chain is counted above. A displaced row with no counting entry yet
		// (a displaced last carrier the scan has not given an entry, or a chain whose every row is
		// displaced) still counts here, on the last carrier, which no creator row reaches while it is
		// displaced: counting it zero times let the Writer accept moves past the record bound.
		const chain = settlementReissueChain(plan, reissued);
		if (chain.rows.some((sequence) => counted.has(sequence))) continue;
		pending.push(Object.freeze({ rows: Object.freeze([chain.last]), moves: 1 }));
	}
	return Object.freeze({ fixed, pending: Object.freeze(pending) });
}

function settlementHandBacksEqual(left: SettlementHandBack, right: SettlementHandBack): boolean {
	return (
		left.sourceSequence === right.sourceSequence &&
		left.reason === right.reason &&
		left.sourceEpoch === right.sourceEpoch &&
		left.intent === right.intent &&
		left.originSequence === right.originSequence &&
		left.reissueSequence === right.reissueSequence &&
		durableIssuanceBytesEqual(left.sourceDigest, right.sourceDigest) &&
		durableIssuanceBytesEqual(left.exactCanonicalOperationBytes, right.exactCanonicalOperationBytes)
	);
}

export function copySettlementPlan(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	const hasContexts = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceContexts");
	const hasHandBacks = typeof value === "object" && value !== null && Object.hasOwn(value, "handBacks");
	const hasMemberFrontier = typeof value === "object" && value !== null && Object.hasOwn(value, "memberFrontier");
	const hasCompletedSourceCustody = typeof value === "object" && value !== null && Object.hasOwn(value, "completedSourceCustody");
	const hasReissueOrigins = typeof value === "object" && value !== null && Object.hasOwn(value, "reissueOrigins");
	if (
		!isClosedDurableIssuanceRecord(value, ["entries", "fenceSequence", "revision", "scope",
			...(hasContexts ? ["sourceContexts"] : []), ...(hasHandBacks ? ["handBacks"] : []),
			...(hasMemberFrontier ? ["memberFrontier"] : []),
			...(hasCompletedSourceCustody ? ["completedSourceCustody"] : []),
			...(hasReissueOrigins ? ["reissueOrigins"] : []),
		]) ||
		(hasCompletedSourceCustody && value.completedSourceCustody !== true) ||
		!Array.isArray(value.entries) ||
		!isValidDurableAuthorSequence(value.revision) ||
		(value.fenceSequence !== null && !isValidDurableAuthorSequence(value.fenceSequence))
	) {
		return undefined;
	}
	try {
		assertDurableIssueScope(value.scope);
	} catch {
		return undefined;
	}
	if (!durableIssueScopesEqual(value.scope, scope)) return undefined;
	const handBacks = hasHandBacks ? copySettlementHandBacks(value.handBacks) : undefined;
	if (hasHandBacks && handBacks === undefined) return undefined;
	const memberFrontier = hasMemberFrontier ? copySettlementMemberFrontier(value.memberFrontier) : undefined;
	if (hasMemberFrontier && memberFrontier === undefined) return undefined;
	const reissueOrigins = hasReissueOrigins ? copySettlementReissueOrigins(value.reissueOrigins) : undefined;
	if (hasReissueOrigins && reissueOrigins === undefined) return undefined;
	const entries: SettlementPlanEntry[] = [];
	let prior = -1;
	for (const rawEntry of value.entries) {
		const entry = copySettlementPlanEntry(rawEntry);
		if (
			entry === undefined ||
			entry.sourceSequence <= prior ||
			entry.sourceObjectId === scope.objectId ||
			(entry.inheritance !== undefined && entry.inheritance.targetObjectId !== scope.objectId)
		)
			return undefined;
		entries.push(entry);
		prior = entry.sourceSequence;
	}
	const sourceContexts: SettlementSourceContext[] = [];
	if (hasContexts) {
		if (!Array.isArray(value.sourceContexts) || value.sourceContexts.length === 0 ||
			value.sourceContexts.length > entries.length * 2) return undefined;
		let priorDigest = "";
		let contextBytes = 0;
		for (const raw of value.sourceContexts) {
			if (!isClosedDurableIssuanceRecord(raw, ["digest", "exactCanonicalContextBytes"])) return undefined;
			const digest = copyDurableIssuanceBytes(raw.digest);
			const bytes = copyDurableIssuanceBytes(raw.exactCanonicalContextBytes);
			if (digest?.byteLength !== 32 || bytes === undefined ||
				(contextBytes += bytes.byteLength) > SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes ||
				!durableIssuanceBytesEqual(digest, hashDomain("ts-drp/settlement-source-context/v1", bytes))) return undefined;
			const key = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
			if (key <= priorDigest || !entries.some(entry => [entry.sourceContextDigest, entry.sourceResolutionDigest]
				.some(reference => reference !== undefined && durableIssuanceBytesEqual(reference, digest)))) return undefined;
			priorDigest = key;
			sourceContexts.push({digest, exactCanonicalContextBytes: bytes});
		}
	}
	if (entries.some(entry => [entry.sourceContextDigest, entry.sourceResolutionDigest].some(reference =>
		reference !== undefined && !sourceContexts.some(context => durableIssuanceBytesEqual(reference, context.digest))))) return undefined;
	return {
		entries,
		...(hasContexts ? { sourceContexts } : {}),
		fenceSequence: value.fenceSequence,
		...(handBacks === undefined ? {} : { handBacks }),
		...(memberFrontier === undefined ? {} : { memberFrontier }),
		...(hasCompletedSourceCustody ? { completedSourceCustody: true as const } : {}),
		...(reissueOrigins === undefined ? {} : { reissueOrigins }),
		revision: value.revision,
		scope: copyDurableIssueScope(scope),
	};
}

/**
 * Validates and detaches a plan's last-member frontier record: exact bytes within
 * SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES whose digest is their source-context-domain hash. The store
 * checks only shape; Node authenticates the signed statement on every open.
 * @param value - Untrusted record.
 * @returns The detached record, or undefined when invalid.
 */
function copySettlementMemberFrontier(value: unknown): SettlementSourceContext | undefined {
	if (!isClosedDurableIssuanceRecord(value, ["digest", "exactCanonicalContextBytes"])) return undefined;
	const digest = copyDurableIssuanceBytes(value.digest);
	const bytes = copyDurableIssuanceBytes(value.exactCanonicalContextBytes);
	return digest?.byteLength !== 32 || bytes === undefined || bytes.byteLength === 0 ||
		bytes.byteLength > SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES ||
		!durableIssuanceBytesEqual(digest, hashDomain("ts-drp/settlement-source-context/v1", bytes))
		? undefined
		: { digest, exactCanonicalContextBytes: bytes };
}

/** Last-consumer projection for the original atomic retirement/plan owners. */
export function settlementSourceContextsForEntries(plan: SettlementPlan, entries: readonly SettlementPlanEntry[]):
	readonly SettlementSourceContext[] | undefined {
	const retained = plan.sourceContexts?.filter(context => entries.some(entry => [entry.sourceContextDigest, entry.sourceResolutionDigest]
		.some(reference => reference !== undefined && durableIssuanceBytesEqual(reference, context.digest))));
	return retained?.length === 0 ? undefined : retained;
}

/** A deterministic text image of a plan (its detached clone, bytes as hex) for exact comparison. */
function settlementPlanImage(plan: SettlementPlan): string {
	return JSON.stringify(cloneSettlementPlan(plan), (_key, value: unknown) =>
		value instanceof Uint8Array ? Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") : value
	);
}

/**
 * Deeply detaches a previously validated settlement plan.
 * @param plan - Validated plan to detach.
 * @returns A deep copy of the plan.
 */
export function cloneSettlementPlan(plan: SettlementPlan): SettlementPlan {
	return {
		entries: plan.entries.map((entry) => ({
			disposition: entry.disposition,
			...(entry.handedBack === undefined ? {} : { handedBack: { ...entry.handedBack } }),
			...(entry.sourceContextDigest === undefined ? {} : {sourceContextDigest: new Uint8Array(entry.sourceContextDigest)}),
			...(entry.sourceResolutionDigest === undefined ? {} : {sourceResolutionDigest: new Uint8Array(entry.sourceResolutionDigest)}),
			...(entry.sourceResolutionKind === undefined ? {} : {sourceResolutionKind: entry.sourceResolutionKind}),
			...(entry.sourceResolutionScope === undefined ? {} : {sourceResolutionScope: entry.sourceResolutionScope}),
			...(entry.sourceObjectId === undefined ? {} : { sourceObjectId: entry.sourceObjectId }),
			...(entry.transformRefusal === undefined
				? {}
				: {
						transformRefusal: {
							...entry.transformRefusal,
							proposedIntentDigest: new Uint8Array(entry.transformRefusal.proposedIntentDigest),
						},
					}),
			...(entry.inheritance === undefined
				? {}
				: {
						inheritance: {
							...entry.inheritance,
							targetVertexDigest: new Uint8Array(entry.inheritance.targetVertexDigest),
						},
					}),
			...(entry.replacementProgress === undefined
				? {}
				: {
						replacementProgress: {
							chunks: entry.replacementProgress.chunks.map((chunk) => ({ ...chunk })),
							intentCount: entry.replacementProgress.intentCount,
							intentDigest: new Uint8Array(entry.replacementProgress.intentDigest),
							version: 1 as const,
						},
					}),
			replacementSequence: entry.replacementSequence,
			sourceDigest: new Uint8Array(entry.sourceDigest),
			sourceSequence: entry.sourceSequence,
		})),
		...(plan.sourceContexts === undefined ? {} : {sourceContexts: plan.sourceContexts.map(context => ({
			digest: new Uint8Array(context.digest), exactCanonicalContextBytes: new Uint8Array(context.exactCanonicalContextBytes),
		}))}),
		fenceSequence: plan.fenceSequence,
		...(plan.handBacks === undefined
			? {}
			: {
					handBacks: plan.handBacks.map((record) => ({
						...(record.reason === undefined ? {} : { reason: record.reason }),
						exactCanonicalOperationBytes: new Uint8Array(record.exactCanonicalOperationBytes),
						intent: record.intent,
						...(record.originSequence === undefined ? {} : { originSequence: record.originSequence }),
						reissueSequence: record.reissueSequence,
						sourceDigest: new Uint8Array(record.sourceDigest),
						sourceEpoch: record.sourceEpoch,
						sourceSequence: record.sourceSequence,
					})),
				}),
		...(plan.memberFrontier === undefined
			? {}
			: {
					memberFrontier: {
						digest: new Uint8Array(plan.memberFrontier.digest),
						exactCanonicalContextBytes: new Uint8Array(plan.memberFrontier.exactCanonicalContextBytes),
					},
				}),
		...(plan.completedSourceCustody === true ? { completedSourceCustody: true as const } : {}),
		...(plan.reissueOrigins === undefined
			? {}
			: {
					reissueOrigins: plan.reissueOrigins.map((entry) => ({
						originSequence: entry.originSequence,
						reissueSequence: entry.reissueSequence,
					})),
				}),
		revision: plan.revision,
		scope: copyDurableIssueScope(plan.scope),
	};
}

/**
 * Freezes retained settlement identities and progress; issue effects own links and chunks.
 * @param current - Current durable plan, if present.
 * @param next - Proposed next plan revision.
 * @param declined - The unconsumed hand-back record the application declines in this write, if any:
 * the write is then exactly the current plan without that record (next revision), nothing else.
 */
export function assertSettlementPlanProgressTransition(
	current: SettlementPlan | null,
	next: SettlementPlan,
	declined?: SettlementHandBackKey
): void {
	if (declined !== undefined) {
		const record = current?.handBacks?.find(
			(value) => value.sourceSequence === declined.sourceSequence && value.intent === declined.intent
		);
		if (current === null || record === undefined || record.reissueSequence !== null)
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back decline is unavailable");
		const remaining = current.handBacks!.filter((value) => value !== record);
		const { handBacks: _dropped, ...rest } = current;
		const expected: SettlementPlan = { ...rest, revision: current.revision + 1, ...(remaining.length === 0 ? {} : { handBacks: remaining }) };
		const proposed: SettlementPlan = next.handBacks?.length === 0 ? (({ handBacks: _empty, ...value }) => value)(next) : next;
		if (settlementPlanImage(expected) !== settlementPlanImage(proposed))
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back decline changed the plan");
		return;
	}
	// Hand-back records: a plan write adds records only unconsumed, never alters one, and drops only
	// consumed or declined ones; consumption belongs to the reissued row's own issuance transaction, a
	// decline to the application's own declineHandBack write (above).
	for (const record of next.handBacks ?? []) {
		const prior = current?.handBacks?.find(
			(value) => value.sourceSequence === record.sourceSequence && value.intent === record.intent
		);
		if (prior === undefined ? record.reissueSequence !== null : !settlementHandBacksEqual(prior, record))
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back changed");
	}
	for (const prior of current?.handBacks ?? []) {
		if (
			prior.reissueSequence === null &&
			!next.handBacks?.some((value) => value.sourceSequence === prior.sourceSequence && value.intent === prior.intent)
		)
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back changed");
	}
	// Reissue origins: only the hand-back effect (the reissued row's own issuance transaction) adds one;
	// a plan write keeps an entry unchanged or drops it (the move settled: admitted or expired).
	for (const entry of next.reissueOrigins ?? []) {
		const prior = current?.reissueOrigins?.find((value) => value.reissueSequence === entry.reissueSequence);
		if (prior?.originSequence !== entry.originSequence)
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement reissue origin changed");
	}
	if (current === null) return;
	// The last-member frontier is written once and never changed or cleared.
	if (current.memberFrontier !== undefined && (next.memberFrontier === undefined ||
		!durableIssuanceBytesEqual(current.memberFrontier.digest, next.memberFrontier.digest) ||
		!durableIssuanceBytesEqual(current.memberFrontier.exactCanonicalContextBytes, next.memberFrontier.exactCanonicalContextBytes)))
		throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement member frontier changed");
	// The completed-source custody marker is written once and never cleared.
	if (current.completedSourceCustody === true && next.completedSourceCustody !== true)
		throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement completed-source custody changed");
	for (const prior of current.entries) {
		const candidate = next.entries.find((entry) => entry.sourceSequence === prior.sourceSequence);
		if (candidate === undefined) {
			if (prior.replacementProgress !== undefined && prior.replacementSequence === null) {
				throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement progress changed");
			}
			continue;
		}
		// A refused replay's hand-back arrives once, with the one-way change of an unreplaced, unresolved
		// rebase/transform decision to `expire`, and never changes or leaves after.
		const handBackArrives =
			prior.handedBack === undefined &&
			candidate.handedBack !== undefined &&
			candidate.disposition === "expire" &&
			(prior.disposition === "rebase" || prior.disposition === "transform") &&
			prior.replacementSequence === null &&
			prior.sourceContextDigest === undefined &&
			prior.sourceResolutionDigest === undefined;
		if (
			prior.handedBack !== undefined
				? candidate.handedBack === undefined ||
					candidate.handedBack.fromIntent !== prior.handedBack.fromIntent ||
					candidate.handedBack.reason !== prior.handedBack.reason
				: candidate.handedBack !== undefined && !handBackArrives
		)
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back entry changed");
		if (
			(candidate.disposition !== prior.disposition && !handBackArrives && !(prior.sourceContextDigest !== undefined &&
				prior.sourceResolutionDigest === undefined && candidate.sourceResolutionDigest !== undefined &&
				prior.disposition !== "expire" && prior.disposition !== "committed" && prior.disposition !== "inherited" &&
				prior.replacementSequence === null && prior.replacementProgress === undefined &&
				(candidate.disposition === "committed" || candidate.disposition === "expire"))) ||
			candidate.sourceObjectId !== prior.sourceObjectId ||
			(prior.sourceContextDigest !== undefined && (candidate.sourceContextDigest === undefined ||
				!durableIssuanceBytesEqual(prior.sourceContextDigest, candidate.sourceContextDigest))) ||
			// A source context arrives once: on unresolved work (custody of retained work), or on a completed
			// replacement entry (custody of its still-present source when its author is removed). An entry
			// already terminal (expire, committed, inherited) never gains one.
			(prior.sourceContextDigest === undefined && candidate.sourceContextDigest !== undefined &&
				!settlementEntryMayGainSourceContext(prior)) ||
			(prior.sourceResolutionDigest !== undefined && (candidate.sourceResolutionDigest === undefined ||
				!durableIssuanceBytesEqual(prior.sourceResolutionDigest, candidate.sourceResolutionDigest))) ||
			// A resolution arrives only with the one-way unresolved->terminal change above;
			// an already-terminal (e.g. retained-fence) expiry never gains one later.
			// (A replaced-source resolution is the exception: it arrives on an entry already completed by
			// its replacement, whose disposition and replacement never change.)
			(prior.sourceResolutionDigest === undefined && candidate.sourceResolutionDigest !== undefined &&
				candidate.disposition === prior.disposition && !(candidate.sourceResolutionScope === "replaced-source" &&
					prior.replacementSequence !== null && prior.replacementProgress === undefined)) ||
			// The resolution scope arrives with its resolution and never changes after.
			(prior.sourceResolutionDigest !== undefined && candidate.sourceResolutionScope !== prior.sourceResolutionScope) ||
			// The resolution kind arrives with its resolution and never changes after.
			(prior.sourceResolutionDigest !== undefined && candidate.sourceResolutionKind !== prior.sourceResolutionKind) ||
			(prior.sourceResolutionDigest === undefined && candidate.sourceResolutionKind !== undefined &&
				candidate.sourceResolutionDigest === undefined) ||
			(prior.transformRefusal !== undefined &&
				(candidate.transformRefusal === undefined ||
					candidate.transformRefusal.reason !== prior.transformRefusal.reason ||
					!durableIssuanceBytesEqual(
						candidate.transformRefusal.proposedIntentDigest,
						prior.transformRefusal.proposedIntentDigest
					))) ||
			(prior.transformRefusal === undefined &&
				candidate.transformRefusal !== undefined &&
				(current.fenceSequence !== null ||
					prior.replacementSequence !== null ||
					prior.replacementProgress !== undefined)) ||
			candidate.replacementSequence !== prior.replacementSequence ||
			(candidate.inheritance === undefined || prior.inheritance === undefined
				? candidate.inheritance !== prior.inheritance
				: candidate.inheritance.targetObjectId !== prior.inheritance.targetObjectId ||
					candidate.inheritance.sourceObjectId !== prior.inheritance.sourceObjectId ||
					candidate.inheritance.targetAuthor !== prior.inheritance.targetAuthor ||
					candidate.inheritance.targetAuthorSequence !== prior.inheritance.targetAuthorSequence ||
					!durableIssuanceBytesEqual(candidate.inheritance.targetVertexDigest, prior.inheritance.targetVertexDigest)) ||
			!durableIssuanceBytesEqual(candidate.sourceDigest, prior.sourceDigest)
		) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement retained source changed");
		}
		if (prior.replacementProgress !== undefined) {
			if (
				candidate.replacementProgress === undefined ||
				candidate.replacementProgress.intentCount !== prior.replacementProgress.intentCount ||
				!durableIssuanceBytesEqual(
					candidate.replacementProgress.intentDigest,
					prior.replacementProgress.intentDigest
				) ||
				candidate.replacementProgress.chunks.length !== prior.replacementProgress.chunks.length ||
				candidate.replacementProgress.chunks.some((chunk, index) => {
					const before = prior.replacementProgress?.chunks[index];
					return (
						before === undefined ||
						chunk.lastLogicalTime !== before.lastLogicalTime ||
						chunk.replacementSequence !== before.replacementSequence ||
						chunk.throughIntent !== before.throughIntent
					);
				})
			) {
				throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement progress changed");
			}
		} else if (candidate.replacementProgress !== undefined) {
			if (prior.replacementSequence !== null || candidate.replacementProgress.chunks.length !== 0) {
				throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement upgrade changed");
			}
		}
	}
}

/**
 * Whether an entry without a source context may gain one in a plan write: unresolved work (no
 * replacement yet; custody of retained work), or a completed replacement entry (`rebase`/`transform`
 * with its replacement; a progress record, if any, is complete; custody of its source when its author
 * is removed).
 * @param prior - The entry as currently stored.
 * @returns Whether the context may arrive.
 */
export function settlementEntryMayGainSourceContext(prior: SettlementPlanEntry): boolean {
	if (prior.disposition === "expire" || prior.disposition === "committed" || prior.disposition === "inherited") return false;
	if (prior.replacementSequence === null) return true;
	return prior.disposition === "rebase" || prior.disposition === "transform";
}

/**
 * Validates and detaches one exact settlement-plan CAS write request.
 * @param value - Untrusted write request.
 * @returns The validated detached write request.
 */
export function captureSettlementPlanWriteInput(value: unknown): Readonly<{
	readonly expectedRevision: number | null;
	readonly plan: SettlementPlan;
	readonly scope: DurableIssueScope;
	readonly declineHandBack?: SettlementHandBackKey;
}> {
	try {
		const declining = typeof value === "object" && value !== null && Object.hasOwn(value, "declineHandBack");
		if (!isClosedDurableIssuanceRecord(value, ["expectedRevision", "plan", "scope", ...(declining ? ["declineHandBack"] : [])])) {
			throw new DurableIssuanceInvalidArgumentError("settlement plan write must be an exact record");
		}
		let declineHandBack: SettlementHandBackKey | undefined;
		if (declining) {
			const key = value.declineHandBack;
			if (
				!isClosedDurableIssuanceRecord(key, ["intent", "sourceSequence"]) ||
				!isValidDurableAuthorSequence(key.sourceSequence) ||
				!isValidDurableAuthorSequence(key.intent)
			)
				throw new DurableIssuanceInvalidArgumentError("settlement hand-back decline key is invalid");
			declineHandBack = Object.freeze({ sourceSequence: key.sourceSequence as number, intent: key.intent as number });
		}
		assertDurableIssueScope(value.scope);
		const scope = copyDurableIssueScope(value.scope);
		if (value.expectedRevision !== null && !isValidDurableAuthorSequence(value.expectedRevision)) {
			throw new DurableIssuanceInvalidArgumentError("expected settlement plan revision must be null or safe");
		}
		const plan = copySettlementPlan(value.plan, scope);
		const nextRevision = value.expectedRevision === null ? 0 : value.expectedRevision + 1;
		if (plan === undefined || !Number.isSafeInteger(nextRevision) || plan.revision !== nextRevision) {
			throw new DurableIssuanceInvalidArgumentError("settlement plan must be valid and carry the next revision");
		}
		return { expectedRevision: value.expectedRevision, plan, scope, ...(declineHandBack === undefined ? {} : { declineHandBack }) };
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw new DurableIssuanceInvalidArgumentError("settlement plan write could not be inspected");
	}
}

/**
 * Applies a validated issue effect to a validated settlement plan.
 * @param plan - Current validated plan.
 * @param effect - Validated issue effect.
 * @param authorSequence - Sequence allocated to the issue.
 * @param lastLogicalTime - Node-derived final operation logical time for a progress chunk.
 * @returns The detached next plan revision.
 */
export function applySettlementPlanEffect(
	plan: SettlementPlan,
	effect: SettlementPlanEffect,
	authorSequence: number,
	lastLogicalTime?: number
): SettlementPlan {
	if (plan.revision === Number.MAX_SAFE_INTEGER) {
		throw createDurableIssuanceFailure("ISSUANCE_RECOVERY_CORRUPT", "settlement plan revision is exhausted");
	}
	if (effect.kind === "hand-back") {
		const index = plan.handBacks?.findIndex(
			(record) => record.sourceSequence === effect.sourceSequence && record.intent === effect.intent
		) ?? -1;
		const record = plan.handBacks?.[index];
		const originSequence = record === undefined ? undefined : (record.originSequence ?? record.sourceSequence);
		const origins = plan.reissueOrigins ?? [];
		if (
			record === undefined ||
			originSequence === undefined ||
			record.reissueSequence !== null ||
			authorSequence <= record.sourceSequence ||
			(effect.originSequence !== undefined && effect.originSequence !== originSequence) ||
			// The entry bound (the backlog term; an entry never takes a record slot): a full set refuses the
			// reissue, which leaves the record unconsumed and listed.
			origins.length >= SETTLEMENT_HAND_BACK_LIMITS.maxRecords ||
			origins.some((entry) => entry.reissueSequence >= authorSequence)
		) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement hand-back precondition changed");
		}
		const detached = cloneSettlementPlan(plan);
		return {
			...detached,
			handBacks: detached.handBacks!.map((value, valueIndex) =>
				valueIndex === index ? { ...value, reissueSequence: authorSequence } : value
			),
			// Atomic with the consumption: the reissued row maps back to its move's origin.
			reissueOrigins: [...(detached.reissueOrigins ?? []), { originSequence, reissueSequence: authorSequence }],
			revision: plan.revision + 1,
		};
	}
	if (effect.kind === "fence") {
		if (plan.fenceSequence !== null || plan.entries.some((entry) => entry.disposition === "manual-review" && entry.sourceContextDigest === undefined)) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement fence precondition changed");
		}
		return { ...cloneSettlementPlan(plan), fenceSequence: authorSequence, revision: plan.revision + 1 };
	}
	const index = plan.entries.findIndex((entry) => entry.sourceSequence === effect.sourceSequence);
	const entry = plan.entries[index];
	if (
		entry === undefined ||
		entry.replacementSequence !== null ||
		entry.sourceContextDigest !== undefined ||
		entry.disposition === "manual-review" ||
		entry.disposition === "inherited"
	) {
		throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement precondition changed");
	}
	const detached = cloneSettlementPlan(plan);
	if ("fromIntent" in effect) {
		if (!Number.isSafeInteger(lastLogicalTime) || (lastLogicalTime as number) < 1) {
			throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "settlement chunk logical time is invalid");
		}
		const progress = entry.replacementProgress;
		if (
			progress === undefined ||
			!durableIssuanceBytesEqual(progress.intentDigest, effect.intentDigest) ||
			(progress.chunks.at(-1)?.throughIntent ?? 0) !== effect.fromIntent
		) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement progress changed");
		}
		if (effect.throughIntent > progress.intentCount) {
			throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "settlement replacement range is invalid");
		}
		const priorChunk = progress.chunks.at(-1);
		if (
			(priorChunk !== undefined && authorSequence <= priorChunk.replacementSequence) ||
			(priorChunk !== undefined && (lastLogicalTime as number) <= priorChunk.lastLogicalTime)
		) {
			throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "settlement replacement chunk is not monotonic");
		}
		const nextProgress: SettlementReplacementProgress = {
			...progress,
			chunks: [
				...progress.chunks,
				{
					lastLogicalTime: lastLogicalTime as number,
					replacementSequence: authorSequence,
					throughIntent: effect.throughIntent,
				},
			],
		};
		const entries = detached.entries.map((candidate, candidateIndex) =>
			candidateIndex === index
				? {
						...candidate,
						replacementProgress: nextProgress,
						replacementSequence: effect.throughIntent === progress.intentCount ? authorSequence : null,
					}
				: candidate
		);
		return { ...detached, entries, revision: plan.revision + 1 };
	}
	if (entry.replacementProgress !== undefined) {
		throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement effect form changed");
	}
	const entries = detached.entries.map((candidate, candidateIndex) =>
		candidateIndex === index ? { ...candidate, replacementSequence: authorSequence } : candidate
	);
	return { ...detached, entries, revision: plan.revision + 1 };
}

/**
 * Tests whether durable plan state contains the exact selected issue effect link.
 * @param plan - Durable plan observed after an ambiguous transaction outcome.
 * @param effect - Effect carried by the candidate commit.
 * @param authorSequence - Sequence allocated to the candidate commit.
 * @returns Whether the exact link is durably present.
 */
export function settlementPlanHasExactEffectLink(
	plan: SettlementPlan | null,
	effect: SettlementPlanEffect,
	authorSequence: number
): boolean {
	if (effect.kind === "fence") return plan?.fenceSequence === authorSequence;
	if (effect.kind === "hand-back") {
		const record = plan?.handBacks?.find(
			(candidate) =>
				candidate.sourceSequence === effect.sourceSequence &&
				candidate.intent === effect.intent &&
				candidate.reissueSequence === authorSequence
		);
		// The same transaction wrote the reissue's origin entry (a plan written before the field has none).
		return (
			record !== undefined &&
			(plan?.reissueOrigins === undefined ||
				plan.reissueOrigins.some(
					(entry) =>
						entry.reissueSequence === authorSequence &&
						entry.originSequence === (record.originSequence ?? record.sourceSequence)
				))
		);
	}
	const entry = plan?.entries.find((candidate) => candidate.sourceSequence === effect.sourceSequence);
	if (!("fromIntent" in effect)) return entry?.replacementSequence === authorSequence;
	const progress = entry?.replacementProgress;
	if (progress === undefined || !durableIssuanceBytesEqual(progress.intentDigest, effect.intentDigest)) return false;
	const index = progress.chunks.findIndex((chunk) => chunk.replacementSequence === authorSequence);
	const chunk = progress.chunks[index];
	return (
		chunk !== undefined &&
		chunk.throughIntent === effect.throughIntent &&
		(index === 0 ? 0 : progress.chunks[index - 1]?.throughIntent) === effect.fromIntent &&
		(effect.throughIntent === progress.intentCount
			? entry?.replacementSequence === authorSequence
			: entry?.replacementSequence === null)
	);
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
	const hasPlanEffect =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "planEffect");
	if (
		!isClosedDurableIssuanceRecord(value, [
			"authorSequence",
			"envelope",
			"issuedRecord",
			"outboxEntry",
			...(hasPlanEffect ? ["planEffect"] : []),
		]) ||
		value.authorSequence !== authorSequence
	) {
		throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "commit has an invalid top-level shape or ordinal");
	}
	const envelope = copyDurableSignedEnvelope(value.envelope);
	const issuedRecord = copyDurableIssuedRecord(value.issuedRecord);
	const outboxEntry = copyDurableIssuedRecord(value.outboxEntry);
	const planEffect = hasPlanEffect ? copySettlementPlanEffect(value.planEffect) : undefined;
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
		!durablePreimageMatchesScopeAndSequence(envelope.canonicalPreimageBytes, scope, authorSequence) ||
		(hasPlanEffect && planEffect === undefined)
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
		...(planEffect === undefined ? {} : { planEffect }),
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

/**
 * Captures one batched issue request (transactIssueBatch) as a detached closed record.
 * @param value - Untrusted batch input.
 * @returns The detached input.
 */
export function captureDurableIssueBatchInput(value: unknown): DurableIssueBatchInput {
	try {
		if (!isClosedDurableIssuanceRecord(value, ["count", "expectedPlanRevision", "scope"]))
			throw new DurableIssuanceInvalidArgumentError("batch input must be an exact own-data record");
		assertDurableIssueScope(value.scope);
		if (
			!Number.isSafeInteger(value.count) ||
			(value.count as number) < 1 ||
			(value.count as number) > MAXIMUM_DURABLE_ISSUE_BATCH_COMMITS
		)
			throw new DurableIssuanceInvalidArgumentError("batch count is outside the closed range");
		if (value.expectedPlanRevision !== null && !isValidDurableAuthorSequence(value.expectedPlanRevision))
			throw new DurableIssuanceInvalidArgumentError("batch expected plan revision is invalid");
		return {
			count: value.count as number,
			expectedPlanRevision: value.expectedPlanRevision as number | null,
			scope: copyDurableIssueScope(value.scope),
		};
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw new DurableIssuanceInvalidArgumentError("batch input could not be inspected as a closed record");
	}
}

/**
 * The batch's first author sequence, or the exhaustion refusal when `count` consecutive sequences from
 * the lineage do not exist (the last one may be Number.MAX_SAFE_INTEGER, which exhausts the lineage).
 * @param lineage - The lineage the batch starts from.
 * @param count - Commits in the batch.
 * @returns The first sequence.
 */
export function durableIssueBatchFirstSequence(
	lineage: Readonly<{ exhausted: boolean; next: number }>,
	count: number
): number {
	if (lineage.exhausted || lineage.next > Number.MAX_SAFE_INTEGER - (count - 1))
		throw createDurableIssuanceFailure("ISSUANCE_EXHAUSTED", "author sequence lineage cannot hold the batch");
	return lineage.next;
}

/**
 * The lineage after a committed batch.
 * @param first - The batch's first author sequence.
 * @param count - Commits in the batch.
 * @returns The advanced lineage.
 */
export function durableLineageAfterBatch(first: number, count: number): { exhausted: boolean; next: number } {
	const last = first + count - 1;
	return last === Number.MAX_SAFE_INTEGER ? { exhausted: true, next: last } : { exhausted: false, next: last + 1 };
}

/**
 * Closes and detaches a batch's commits: exactly `count` of them, commit `i` at `first + i` and
 * validated exactly as a single commit (copyAndValidateDurableIssueCommit). Plan effects are carried by
 * every commit of the batch or by none (a settlement batch never mixes ordinary moves with its work).
 * @param value - Untrusted builder result.
 * @param scope - Selected issuance scope.
 * @param first - The batch's first author sequence.
 * @param count - Commits in the batch.
 * @returns The detached commits, in sequence order.
 */
export function copyAndValidateDurableIssueBatch(
	value: unknown,
	scope: DurableIssueScope,
	first: number,
	count: number
): readonly DurableIssueCommit[] {
	let entries: readonly unknown[];
	try {
		if (!Array.isArray(value) || value.length !== count || Object.getPrototypeOf(value) !== Array.prototype)
			throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch has an invalid commit count");
		entries = Array.from({ length: count }, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
				throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch commit list is not dense");
			return descriptor.value as unknown;
		});
	} catch (error) {
		if (error instanceof DurableIssuanceContractError) throw error;
		throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch commit list could not be inspected");
	}
	const commits = entries.map((entry, index) => copyAndValidateDurableIssueCommit(entry, scope, first + index));
	assertDurableIssueBatchEffects(commits.map((commit) => commit.planEffect));
	return commits;
}

/**
 * Applies a batch's plan effects in commit order, each with the single-commit validation and one
 * revision step (applySettlementPlanEffect). Any refusal refuses the whole batch.
 * @param plan - The durable plan before the batch (null: absent).
 * @param commits - The batch's validated commits.
 * @returns The plan after every effect (the input plan when the batch carries none).
 */
export function applySettlementPlanEffects(
	plan: SettlementPlan | null,
	commits: readonly DurableIssueCommit[]
): SettlementPlan | null {
	let current = plan;
	for (const commit of commits) {
		if (commit.planEffect === undefined) continue;
		if (current === null) throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement plan is absent");
		current = applySettlementPlanEffect(
			current,
			commit.planEffect,
			commit.authorSequence,
			settlementReplacementLastLogicalTime(commit)
		);
	}
	return current;
}

/**
 * Checks the batch's crypto admission request against the commits the builder returned: one intent
 * per commit, the exact unsigned bytes and the same plan effect.
 * @param intents - The admitted unsigned intents.
 * @param commits - The batch's validated commits.
 * @returns Whether they agree exactly.
 */
export function durableIssueBatchMatchesIntents(
	intents: readonly Readonly<{ canonicalPreimageBytes: Uint8Array; digest: Uint8Array; planEffect?: SettlementPlanEffect }>[],
	commits: readonly DurableIssueCommit[]
): boolean {
	return (
		intents.length === commits.length &&
		commits.every((commit, index) => {
			const intent = intents[index]!;
			return (
				durableIssuanceBytesEqual(intent.canonicalPreimageBytes, commit.envelope.canonicalPreimageBytes) &&
				durableIssuanceBytesEqual(intent.digest, commit.envelope.digest) &&
				durableIssuanceBytesEqual(encodeCanonical(intent.planEffect ?? null), encodeCanonical(commit.planEffect ?? null))
			);
		})
	);
}

/**
 * The batch rules on plan effects, checked on the admitted intents before any crypto and again on the
 * commits: effects on every commit or on none; one effect per settlement source and at most one fence;
 * a hand-back (a re-offered move) never shares a batch with settlement work. A source split into
 * several replacement chunks spends one batch per chunk, so each chunk is applied against the progress
 * the previous one committed.
 * @param effects - The batch's plan effects in commit order (undefined: none).
 */
export function assertDurableIssueBatchEffects(effects: readonly (SettlementPlanEffect | undefined)[]): void {
	const present = effects.filter((effect): effect is SettlementPlanEffect => effect !== undefined);
	if (present.length !== 0 && present.length !== effects.length)
		throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch mixes plan-effect and ordinary commits");
	const handBacks = present.filter((effect) => effect.kind === "hand-back").length;
	if (handBacks !== 0 && handBacks !== present.length)
		throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch mixes hand-back and settlement effects");
	const targets = new Set<string>();
	for (const effect of present) {
		const target =
			effect.kind === "fence"
				? "fence"
				: effect.kind === "hand-back"
					? `hand-back:${effect.sourceSequence}:${effect.intent}`
					: `replacement:${effect.sourceSequence}`;
		if (targets.has(target))
			throw createDurableIssuanceFailure("ISSUANCE_COMMIT_INVALID", "batch repeats a settlement effect target");
		targets.add(target);
	}
}
