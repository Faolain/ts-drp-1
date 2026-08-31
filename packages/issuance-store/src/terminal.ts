import {
	durableIssuanceBytesEqual as bytesEqual,
	cloneDurableIssueCommit as cloneCommit,
	copyDurableIssueScope as cloneScope,
	copyAndValidateDurableIssueCommit as copyAndValidateCommit,
	copyDurableIssuanceBytes as copyBytes,
	copyDurableIssuedRecord as copyIssuedRecord,
	createDurableIssuanceFailure as failure,
	DurableIssuanceInvalidArgumentError as InvalidArgumentFailure,
	isClosedDurableIssuanceRecord as isRecord,
	durablePreimageMatchesScopeAndSequence as preimageMatches,
	durableIssueScopesEqual as sameScope,
	DurableIssuanceUnknownOutcomeError as UnknownOutcomeFailure,
	assertDurableIssueScope as validateScope,
	isValidDurableAuthorSequence as validOrdinal,
} from "./contract.js";
import {
	createDurableIssuanceRecordPrunedError,
	durableIssuanceAddressIsPruned,
	durableIssuanceLineageConsumed,
	durableIssuanceLineagesEqual,
} from "./maintenance.js";
import type {
	DurableIssuancePublishState,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableLineage,
} from "./types.js";

export interface DurableIssuanceNativeOutboxRecord {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: DurableIssuancePublishState;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuanceTerminalObservation {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: DurableIssuanceNativeOutboxRecord | null;
	readonly prunedThroughAuthorSequence: number | null;
}

export interface DurableIssuanceTerminalClassificationInput {
	readonly candidate: DurableIssueCommit;
	readonly observation: DurableIssuanceTerminalObservation | { readonly unreadable: true };
	readonly priorLineage: DurableLineage;
	readonly scope: DurableIssueScope;
}

function copyExactLineage(value: unknown, source: "caller" | "durable-observation"): DurableLineage {
	const exact =
		isRecord(value, ["exhausted", "next"]) && typeof value.exhausted === "boolean" && validOrdinal(value.next)
			? { exhausted: value.exhausted, next: value.next }
			: undefined;
	if (exact === undefined || (exact.exhausted && exact.next !== Number.MAX_SAFE_INTEGER)) {
		if (source === "caller") throw new InvalidArgumentFailure("prior lineage must be an exact safe lineage record");
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "durable observation contains a malformed lineage");
	}
	return exact;
}

function recordMatches(record: DurableIssuedRecord, expected: DurableIssuedRecord, requireEnvelope: boolean): boolean {
	return (
		record.authorSequence === expected.authorSequence &&
		sameScope(record.scope, expected.scope) &&
		(!requireEnvelope ||
			(bytesEqual(record.envelope.canonicalPreimageBytes, expected.envelope.canonicalPreimageBytes) &&
				bytesEqual(record.envelope.digest, expected.envelope.digest) &&
				bytesEqual(record.envelope.signature, expected.envelope.signature)))
	);
}

function copyNativeOutboxRecord(value: unknown): DurableIssuanceNativeOutboxRecord | undefined {
	if (
		!isRecord(value, ["authorSequence", "digest", "publishState", "scope"]) ||
		!validOrdinal(value.authorSequence) ||
		(value.publishState !== "pending" && value.publishState !== "published")
	) {
		return undefined;
	}
	const digest = copyBytes(value.digest);
	try {
		validateScope(value.scope);
	} catch {
		return undefined;
	}
	if (digest === undefined) return undefined;
	return {
		authorSequence: value.authorSequence,
		digest,
		publishState: value.publishState,
		scope: cloneScope(value.scope),
	};
}

function outboxMatchesIssued(outbox: DurableIssuanceNativeOutboxRecord, issued: DurableIssuedRecord): boolean {
	return (
		outbox.authorSequence === issued.authorSequence &&
		sameScope(outbox.scope, issued.scope) &&
		bytesEqual(outbox.digest, issued.envelope.digest)
	);
}

/**
 * Classifies one bounded terminal readback under the shared token-free ambiguity policy.
 * @param input - Private candidate, exact prior lineage and consistent durable observation.
 * @returns A fresh detached commit when durable rows prove the candidate succeeded.
 */
export function classifyDurableIssuanceTerminalSuppression(
	input: DurableIssuanceTerminalClassificationInput
): DurableIssueCommit {
	validateScope(input.scope);
	const scope = cloneScope(input.scope);
	const priorLineage = copyExactLineage(input.priorLineage, "caller");
	if (priorLineage.exhausted) {
		throw new InvalidArgumentFailure("prior lineage must remain selectable during terminal classification");
	}
	let candidate: DurableIssueCommit;
	try {
		candidate = copyAndValidateCommit(input.candidate, scope, priorLineage.next);
	} catch {
		throw new InvalidArgumentFailure("candidate must close the exact prior-lineage ordinal");
	}
	if ("unreadable" in input.observation) throw new UnknownOutcomeFailure(scope);
	if (!isRecord(input.observation, ["issuedRecord", "lineage", "outboxRecord", "prunedThroughAuthorSequence"])) {
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "durable observation has an invalid closed shape");
	}
	const { issuedRecord, lineage, outboxRecord, prunedThroughAuthorSequence } = input.observation;
	const observedLineage = copyExactLineage(lineage, "durable-observation");
	if (
		prunedThroughAuthorSequence !== null &&
		(!validOrdinal(prunedThroughAuthorSequence) ||
			!durableIssuanceLineageConsumed(observedLineage, prunedThroughAuthorSequence))
	) {
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "durable observation contains an invalid pruning watermark");
	}
	const isConsumed = durableIssuanceLineageConsumed(observedLineage, candidate.authorSequence);
	const isPruned = durableIssuanceAddressIsPruned(prunedThroughAuthorSequence, candidate.authorSequence);
	const observedIssued = issuedRecord === null ? null : copyIssuedRecord(issuedRecord);
	const observedOutbox = outboxRecord === null ? null : copyNativeOutboxRecord(outboxRecord);
	if (isPruned && (issuedRecord !== null || outboxRecord !== null)) {
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "pruned durable address still contains issuance rows");
	}
	if (
		(issuedRecord !== null && observedIssued === undefined) ||
		(outboxRecord !== null && observedOutbox === undefined)
	) {
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "terminal readback contains a malformed durable row");
	}

	if (
		observedIssued !== null &&
		observedIssued !== undefined &&
		observedOutbox !== null &&
		observedOutbox !== undefined &&
		isConsumed &&
		recordMatches(observedIssued, candidate.issuedRecord, true) &&
		outboxMatchesIssued(observedOutbox, observedIssued)
	) {
		return cloneCommit(candidate);
	}
	if (issuedRecord === null && outboxRecord === null && isConsumed && isPruned) {
		throw createDurableIssuanceRecordPrunedError(scope, candidate.authorSequence);
	}
	if (issuedRecord === null && outboxRecord === null && durableIssuanceLineagesEqual(observedLineage, priorLineage)) {
		throw failure("ISSUANCE_SUBSTRATE_FAILURE", "commit was definitively not applied", "transient");
	}
	if (
		observedIssued !== null &&
		observedIssued !== undefined &&
		observedOutbox !== null &&
		observedOutbox !== undefined &&
		isConsumed &&
		recordMatches(observedIssued, candidate.issuedRecord, false) &&
		preimageMatches(observedIssued.envelope.canonicalPreimageBytes, scope, candidate.authorSequence) &&
		outboxMatchesIssued(observedOutbox, observedIssued)
	) {
		throw failure("ISSUANCE_RETRY_REQUIRED", "another candidate committed the selected ordinal");
	}
	throw failure("ISSUANCE_RECOVERY_CORRUPT", "terminal readback does not form one durable closure");
}
