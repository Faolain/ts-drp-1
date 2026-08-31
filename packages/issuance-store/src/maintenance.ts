import { decodeCanonical } from "@ts-drp/canonical";

import {
	assertDurableIssueScope,
	copyDurableIssueScope,
	DurableIssuanceInvalidArgumentError,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
} from "./contract.js";
import type { DurableIssuanceError, DurableIssueScope, DurableLineage } from "./types.js";

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

export interface DurableIssuancePruningState {
	readonly lineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number | null;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuancePruningInput {
	readonly closedEpoch: number;
	readonly commitQcRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
	readonly expectedLineage: DurableLineage;
	readonly expectedPrunedThroughAuthorSequence: number | null;
	readonly scope: DurableIssueScope;
	readonly snapshotManifestDigest: string;
	readonly throughAuthorSequence: number;
}

export interface DurableIssuancePruningReceipt {
	readonly closedEpoch: number;
	readonly commitQcRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
	readonly deletedAuthorSequenceRange: Readonly<{ readonly from: number; readonly through: number }> | null;
	readonly observedLineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number;
	readonly scope: DurableIssueScope;
	readonly snapshotManifestDigest: string;
}

export interface DurableIssuancePruningMaintenance {
	inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
	prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
}

/** Exact non-poisoning evidence that a caller-known ordinal was already pruned. */
export class DurableIssuanceRecordPrunedError extends Error implements DurableIssuanceError {
	readonly authorSequence: number;
	readonly code = "ISSUANCE_RECORD_PRUNED" as const;
	readonly scope: DurableIssueScope;

	/**
	 * Creates caller-known evidence for an ordinal already removed by pruning.
	 * @param scope - Caller-known issuance scope.
	 * @param authorSequence - Caller-known pruned ordinal.
	 */
	constructor(scope: DurableIssueScope, authorSequence: number) {
		super("durable issuance record was pruned");
		Object.defineProperty(this, "name", { configurable: true, value: "DurableIssuanceError" });
		this.authorSequence = authorSequence;
		this.scope = copyDurableIssueScope(scope);
	}
}

function invalid(message: string): DurableIssuanceInvalidArgumentError {
	return new DurableIssuanceInvalidArgumentError(message);
}

function copyLineage(value: unknown): DurableLineage {
	if (
		!isClosedDurableIssuanceRecord(value, ["exhausted", "next"]) ||
		typeof value.exhausted !== "boolean" ||
		!isValidDurableAuthorSequence(value.next) ||
		(value.exhausted && value.next !== Number.MAX_SAFE_INTEGER)
	) {
		throw invalid("expectedLineage must be an exact safe lineage record");
	}
	return { exhausted: value.exhausted, next: value.next };
}

function copyWatermark(value: unknown): number | null {
	if (value === null) return null;
	if (!isValidDurableAuthorSequence(value)) throw invalid("pruning watermark must be null or a safe ordinal");
	return value;
}

/**
 * Validates and detaches one closed pruning request.
 * @param value - Untrusted request value.
 * @returns A detached validated pruning request.
 */
export function captureDurableIssuancePruningInput(value: unknown): DurableIssuancePruningInput {
	try {
		if (
			!isClosedDurableIssuanceRecord(value, [
				"closedEpoch",
				"commitQcRef",
				"expectedLineage",
				"expectedPrunedThroughAuthorSequence",
				"scope",
				"snapshotManifestDigest",
				"throughAuthorSequence",
			]) ||
			!isValidDurableAuthorSequence(value.closedEpoch) ||
			!isValidDurableAuthorSequence(value.throughAuthorSequence) ||
			!isClosedDurableIssuanceRecord(value.commitQcRef, ["byteLength", "digest"]) ||
			!Number.isSafeInteger(value.commitQcRef.byteLength) ||
			Number(value.commitQcRef.byteLength) < 1 ||
			typeof value.commitQcRef.digest !== "string" ||
			!HEX_DIGEST.test(value.commitQcRef.digest) ||
			typeof value.snapshotManifestDigest !== "string" ||
			!HEX_DIGEST.test(value.snapshotManifestDigest)
		) {
			throw invalid("pruning input must be one exact validated record");
		}
		assertDurableIssueScope(value.scope);
		return {
			closedEpoch: value.closedEpoch,
			commitQcRef: { byteLength: Number(value.commitQcRef.byteLength), digest: value.commitQcRef.digest },
			expectedLineage: copyLineage(value.expectedLineage),
			expectedPrunedThroughAuthorSequence: copyWatermark(value.expectedPrunedThroughAuthorSequence),
			scope: copyDurableIssueScope(value.scope),
			snapshotManifestDigest: value.snapshotManifestDigest,
			throughAuthorSequence: value.throughAuthorSequence,
		};
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw invalid("pruning input could not be inspected as a closed record");
	}
}

/**
 * Compares two lineage CAS values.
 * @param left - First lineage value.
 * @param right - Second lineage value.
 * @returns Whether both lineage fields are equal.
 */
export function durableIssuanceLineagesEqual(left: DurableLineage, right: DurableLineage): boolean {
	return left.exhausted === right.exhausted && left.next === right.next;
}

/**
 * Tests whether a lineage has consumed an ordinal.
 * @param lineage - Observed durable lineage.
 * @param authorSequence - Ordinal to classify.
 * @returns Whether the lineage has consumed the ordinal.
 */
export function durableIssuanceLineageConsumed(lineage: DurableLineage, authorSequence: number): boolean {
	return lineage.next > authorSequence || (lineage.exhausted && lineage.next === authorSequence);
}

/**
 * Tests the explicit inclusive pruning-watermark relation.
 * @param watermark - Inclusive watermark or no pruning state.
 * @param authorSequence - Ordinal to classify.
 * @returns Whether the ordinal is at or below a real watermark.
 */
export function durableIssuanceAddressIsPruned(watermark: number | null, authorSequence: number): boolean {
	return watermark !== null && authorSequence <= watermark;
}

/**
 * Decodes only the closed v3 vertex fields needed by the issuance owner.
 * @param canonicalPreimageBytes - Canonical preimage bytes to decode.
 * @param scope - Expected issuance scope.
 * @param authorSequence - Expected issuance ordinal.
 * @returns The validated epoch or `undefined` for any mismatch.
 */
export function decodeDurableIssuancePreimage(
	canonicalPreimageBytes: Uint8Array,
	scope: DurableIssueScope,
	authorSequence: number
): Readonly<{ readonly epoch: number }> | undefined {
	try {
		const decoded: unknown = decodeCanonical(canonicalPreimageBytes);
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
		const record = decoded as Record<string, unknown>;
		if (
			record.kind === "drp-vertex" &&
			record.protocolMajor === 3 &&
			isValidDurableAuthorSequence(record.epoch) &&
			record.authorSequence === authorSequence &&
			record.author === scope.author &&
			record.objectId === scope.objectId
		) {
			return Object.freeze({ epoch: record.epoch });
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Creates a deeply detached immutable pruning-state observation.
 * @param scope - Observed issuance scope.
 * @param lineage - Observed lineage CAS value.
 * @param prunedThroughAuthorSequence - Observed inclusive watermark.
 * @returns A frozen detached observation.
 */
export function createDurableIssuancePruningState(
	scope: DurableIssueScope,
	lineage: DurableLineage,
	prunedThroughAuthorSequence: number | null
): DurableIssuancePruningState {
	return Object.freeze({
		lineage: Object.freeze({ ...lineage }),
		prunedThroughAuthorSequence,
		scope: Object.freeze(copyDurableIssueScope(scope)),
	});
}

/**
 * Creates a deeply detached immutable pruning receipt.
 * @param input - Captured pruning request.
 * @param observedLineage - Transactionally observed lineage.
 * @param deletedFrom - First removed ordinal or `null` for replay.
 * @returns A frozen detached receipt.
 */
export function createDurableIssuancePruningReceipt(
	input: DurableIssuancePruningInput,
	observedLineage: DurableLineage,
	deletedFrom: number | null
): DurableIssuancePruningReceipt {
	return Object.freeze({
		closedEpoch: input.closedEpoch,
		commitQcRef: Object.freeze({ ...input.commitQcRef }),
		deletedAuthorSequenceRange:
			deletedFrom === null ? null : Object.freeze({ from: deletedFrom, through: input.throughAuthorSequence }),
		observedLineage: Object.freeze({ ...observedLineage }),
		prunedThroughAuthorSequence: input.throughAuthorSequence,
		scope: Object.freeze(copyDurableIssueScope(input.scope)),
		snapshotManifestDigest: input.snapshotManifestDigest,
	});
}

/**
 * Creates frozen non-poisoning evidence for a caller-known pruned address.
 * @param scope - Caller-known issuance scope.
 * @param authorSequence - Caller-known pruned ordinal.
 * @returns A closed frozen pruned-address error.
 */
export function createDurableIssuanceRecordPrunedError(
	scope: DurableIssueScope,
	authorSequence: number
): DurableIssuanceRecordPrunedError {
	return Object.freeze(new DurableIssuanceRecordPrunedError(scope, authorSequence));
}
