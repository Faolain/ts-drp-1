import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import { MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS, SETTLEMENT_REPLACEMENT_MAX_INTENTS } from "./types.js";
import type {
	DurableIssuanceError,
	DurableIssuanceErrorCode,
	DurableIssuanceRetryClass,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableSignedEnvelope,
	SettlementPlan,
	SettlementPlanEntry,
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
 * Derives the final submitted operation logical time from one validated commit.
 * @param commit - Validated durable issue commit.
 * @returns The positive final logical time, or undefined for an invalid preimage.
 */
export function settlementReplacementLastLogicalTime(commit: DurableIssueCommit): number | undefined {
	try {
		const decoded: unknown = decodeCanonical(commit.envelope.canonicalPreimageBytes);
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

function copySettlementPlanEntry(value: unknown): SettlementPlanEntry | undefined {
	const hasProgress =
		typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "replacementProgress");
	if (
		!isClosedDurableIssuanceRecord(value, [
			"disposition",
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
			value.disposition !== "manual-review")
	) {
		return undefined;
	}
	const sourceDigest = copyDurableIssuanceBytes(value.sourceDigest);
	const replacementProgress = hasProgress ? copySettlementReplacementProgress(value.replacementProgress) : undefined;
	if (
		sourceDigest === undefined ||
		(hasProgress && replacementProgress === undefined) ||
		(replacementProgress !== undefined && (value.disposition === "expire" || value.disposition === "manual-review"))
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
export function copySettlementPlan(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["entries", "fenceSequence", "revision", "scope"]) ||
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
	const entries: SettlementPlanEntry[] = [];
	let prior = -1;
	for (const rawEntry of value.entries) {
		const entry = copySettlementPlanEntry(rawEntry);
		if (entry === undefined || entry.sourceSequence <= prior) return undefined;
		entries.push(entry);
		prior = entry.sourceSequence;
	}
	return {
		entries,
		fenceSequence: value.fenceSequence,
		revision: value.revision,
		scope: copyDurableIssueScope(scope),
	};
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
		fenceSequence: plan.fenceSequence,
		revision: plan.revision,
		scope: copyDurableIssueScope(plan.scope),
	};
}

/**
 * Refuses a CAS rewrite that would alter or remove durable replacement progress.
 * @param current - Current durable plan, if present.
 * @param next - Proposed next plan revision.
 */
export function assertSettlementPlanProgressTransition(current: SettlementPlan | null, next: SettlementPlan): void {
	if (current === null) return;
	for (const prior of current.entries) {
		const candidate = next.entries.find((entry) => entry.sourceSequence === prior.sourceSequence);
		if (prior.replacementProgress !== undefined && prior.replacementSequence === null) {
			if (
				candidate === undefined ||
				candidate.disposition !== prior.disposition ||
				candidate.replacementSequence !== prior.replacementSequence ||
				!durableIssuanceBytesEqual(candidate.sourceDigest, prior.sourceDigest) ||
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
		} else if (
			prior.replacementProgress === undefined &&
			prior.replacementSequence !== null &&
			candidate?.replacementProgress !== undefined
		) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "linked settlement replacement cannot be upgraded");
		} else if (prior.replacementProgress === undefined && candidate?.replacementProgress !== undefined) {
			if (
				candidate.replacementProgress.chunks.length !== 0 ||
				prior.replacementSequence !== null ||
				candidate.replacementSequence !== null ||
				candidate.disposition !== prior.disposition ||
				!durableIssuanceBytesEqual(candidate.sourceDigest, prior.sourceDigest)
			) {
				throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement replacement upgrade changed");
			}
		}
	}
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
}> {
	try {
		if (!isClosedDurableIssuanceRecord(value, ["expectedRevision", "plan", "scope"])) {
			throw new DurableIssuanceInvalidArgumentError("settlement plan write must be an exact record");
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
		return { expectedRevision: value.expectedRevision, plan, scope };
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
	if (effect.kind === "fence") {
		if (plan.fenceSequence !== null || plan.entries.some((entry) => entry.disposition === "manual-review")) {
			throw createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "settlement fence precondition changed");
		}
		return { ...cloneSettlementPlan(plan), fenceSequence: authorSequence, revision: plan.revision + 1 };
	}
	const index = plan.entries.findIndex((entry) => entry.sourceSequence === effect.sourceSequence);
	const entry = plan.entries[index];
	if (entry === undefined || entry.replacementSequence !== null || entry.disposition === "manual-review") {
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
