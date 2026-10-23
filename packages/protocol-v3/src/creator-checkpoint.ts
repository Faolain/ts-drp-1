import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { openCurrentAnchorTrust } from "./anchor-trust-singleton.js";
import { openCreatorForwardPromotionSuccessorTrust, openCreatorSuccessorTrust } from "./creator-close.js";
import { type CurrentAnchorTrust, verifyEd25519RegisteredDigest } from "./index.js";
import { decodeCanonicalWithExactness } from "./internal/canonical-exactness.js";
import {
	mintCreatorAnchorTrustCheckpointPredecessor,
	resolveCreatorAnchorTrustMaterial,
} from "./internal/seal-authority-custody.js";
import { settlementProfileFor } from "./settlement-profile.js";
import { CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES } from "./creator-author-issuance-frontiers.js";

const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const INPUT_KEYS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalCommitQcBytes",
	"exactCanonicalCurrentTrustStateRecordBytes",
	"exactCanonicalCutValueBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalPredecessorTrustStateRecordBytes",
	"expectedCurrentHead",
	"expectedObjectId",
	"pinnedGenesisAnchorDigest",
]);
const HEAD_KEYS = Object.freeze(["currentAnchorDigest", "epoch", "objectId"]);
const TRUST_KEYS = Object.freeze([
	"currentAnchorDigest",
	"currentEpoch",
	"detachedCurrentAnchorSignature",
	"exactCanonicalCurrentAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"genesisAnchorDigest",
	"kind",
	"objectId",
	"profileId",
	"quorum",
	"version",
]);

const REATTACHMENT_KEYS = Object.freeze([
	"kind", "version", "exactCanonicalPredecessorTrustStateRecordBytes",
	"exactCanonicalPredecessorAclBytes", "exactCanonicalPredecessorSettlementBytes",
]);

/** Immutable transport syntax, not authority or a skipped-source classification. */
export interface CreatorReattachmentCheckpoint {
	readonly exactCanonicalPredecessorTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalPredecessorAclBytes: Uint8Array;
	readonly exactCanonicalPredecessorSettlementBytes: Uint8Array;
}

function reattachmentFields(input: CreatorReattachmentCheckpoint): Readonly<Record<string, unknown>> {
	return { kind: "creator-reattachment-checkpoint-1", version: 1, ...input };
}

/** Exact maximum of the existing trust, ACL and signed-settlement carrier limits. */
export const CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES = encodeCanonical(reattachmentFields({
	exactCanonicalPredecessorTrustStateRecordBytes: new Uint8Array(8192),
	exactCanonicalPredecessorAclBytes: new Uint8Array(65_536),
	exactCanonicalPredecessorSettlementBytes: new Uint8Array(CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES),
})).byteLength;

/**
 * Decodes detached bounded syntax; the checkpoint and settlement owners still authenticate every carrier.
 * @param input - Exact canonical transport bytes.
 * @returns Copied predecessor carriers, or undefined for any malformed field.
 */
export function decodeCreatorReattachmentCheckpoint(input: unknown): CreatorReattachmentCheckpoint | undefined {
	try {
		const bytes = copiedBytes(input, CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES);
		if (bytes === undefined) return undefined;
		const limits = { maxBytes: CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES, maxDepth: 2, maxItems: 64 };
		const { value, exact } = decodeCanonicalWithExactness(bytes, limits);
		if (!plainRecord(value) || !exactKeys(value, REATTACHMENT_KEYS) ||
			value.kind !== "creator-reattachment-checkpoint-1" || value.version !== 1 ||
			(!exact && compareBytes(encodeCanonical(value, limits), bytes) !== 0)) return undefined;
		// The canonical decoder may return views into its captured input. These
		// freshly decoded fields cannot carry caller-defined accessors.
		const field = (value: unknown, maximum: number): Uint8Array | undefined =>
			value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maximum
				? Uint8Array.from(value) : undefined;
		const trust = field(value.exactCanonicalPredecessorTrustStateRecordBytes, 8192);
		const acl = field(value.exactCanonicalPredecessorAclBytes, 65_536);
		const settlement = field(value.exactCanonicalPredecessorSettlementBytes, CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES);
		return trust === undefined || acl === undefined || settlement === undefined ? undefined : Object.freeze({
			exactCanonicalPredecessorTrustStateRecordBytes: trust,
			exactCanonicalPredecessorAclBytes: acl,
			exactCanonicalPredecessorSettlementBytes: settlement,
		});
	} catch { return undefined; }
}

/**
 * Encodes only the same bounded syntax accepted by the decoder, without granting checkpoint authority.
 * @param input - Predecessor carriers authenticated separately by the exporting owner.
 * @returns Exact detached transport bytes.
 */
export function encodeCreatorReattachmentCheckpoint(input: CreatorReattachmentCheckpoint): Uint8Array {
	if (!plainRecord(input) || !exactKeys(input, REATTACHMENT_KEYS.slice(2)))
		throw new TypeError("creator reattachment checkpoint fields are invalid");
	const bytes = encodeCanonical(reattachmentFields(input), {
		maxBytes: CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES, maxDepth: 2, maxItems: 64,
	});
	if (decodeCreatorReattachmentCheckpoint(bytes) === undefined)
		throw new TypeError("creator reattachment checkpoint bounds are invalid");
	return bytes;
}

export type CreatorCheckpointFailureReason =
	| "commit-qc-rejected"
	| "current-rejected"
	| "custody-unavailable"
	| "expected-head-mismatch"
	| "genesis-rejected"
	| "lineage-invalid"
	| "malformed-input"
	| "predecessor-rejected";

export interface CreatorCheckpointHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface OpenCreatorCheckpointTrustInput {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalCurrentTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalPredecessorTrustStateRecordBytes: Uint8Array;
	readonly expectedCurrentHead: CreatorCheckpointHead;
	readonly expectedObjectId: string;
	readonly pinnedGenesisAnchorDigest: string;
}

export type OpenCreatorCheckpointTrustResult =
	| Readonly<{ readonly ok: false; readonly reason: CreatorCheckpointFailureReason }>
	| Readonly<{
			readonly currentTrust: CurrentAnchorTrust;
			readonly ok: true;
			readonly predecessorTrust: CurrentAnchorTrust;
	  }>;

interface TrustRecord extends Readonly<Record<string, unknown>> {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly detachedCurrentAnchorSignature: Uint8Array;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
}

function failure(reason: CreatorCheckpointFailureReason): OpenCreatorCheckpointTrustResult {
	return Object.freeze({ ok: false as const, reason });
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		actual.every((key) => typeof key === "string" && keys.includes(key)) &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function copiedBytes(value: unknown, maximum = 65_536): Uint8Array | undefined {
	if (
		!(value instanceof Uint8Array) ||
		Object.getPrototypeOf(value) !== Uint8Array.prototype ||
		value.byteOffset !== 0 ||
		value.buffer.byteLength !== value.byteLength ||
		value.byteLength === 0 ||
		value.byteLength > maximum
	) {
		return undefined;
	}
	return Uint8Array.from(value);
}

function exactRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	try {
		const { value: decoded, exact } = decodeCanonicalWithExactness(bytes);
		if (!plainRecord(decoded) || (!exact && compareBytes(encodeCanonical(decoded), bytes) !== 0)) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function trustRecord(
	bytes: Uint8Array,
	expectedObjectId: string,
	pinnedGenesisAnchorDigest: string
): TrustRecord | undefined {
	const decoded = exactRecord(bytes);
	if (
		decoded === undefined ||
		!exactKeys(decoded, TRUST_KEYS) ||
		decoded.kind !== "drp-anchor-trust-state" ||
		decoded.version !== 1 ||
		typeof decoded.profileId !== "string" ||
		(decoded.profileId !== "creator-trusted-v1" && settlementProfileFor(decoded.profileId) === "none") ||
		decoded.quorum !== 1 ||
		decoded.objectId !== expectedObjectId ||
		decoded.genesisAnchorDigest !== pinnedGenesisAnchorDigest ||
		typeof decoded.currentEpoch !== "number" ||
		!Number.isSafeInteger(decoded.currentEpoch) ||
		decoded.currentEpoch < 1 ||
		typeof decoded.currentAnchorDigest !== "string" ||
		!DIGEST_HEX.test(decoded.currentAnchorDigest) ||
		!(decoded.detachedCurrentAnchorSignature instanceof Uint8Array) ||
		decoded.detachedCurrentAnchorSignature.byteLength !== 64 ||
		!(decoded.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
		!(decoded.exactCanonicalProfileBytes instanceof Uint8Array) ||
		!(decoded.exactCanonicalSignerSetBytes instanceof Uint8Array)
	) {
		return undefined;
	}
	const anchor = exactRecord(decoded.exactCanonicalCurrentAnchorPreimageBytes);
	if (
		anchor?.kind !== "drp-epoch-anchor" ||
		anchor.objectId !== expectedObjectId ||
		anchor.epoch !== decoded.currentEpoch ||
		decoded.currentAnchorDigest !==
			bytesHex(hashDomain("ts-drp/epoch-anchor/v3", decoded.exactCanonicalCurrentAnchorPreimageBytes))
	) {
		return undefined;
	}
	return decoded as TrustRecord;
}

function bytesHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function validHead(value: unknown): value is CreatorCheckpointHead {
	return (
		plainRecord(value) &&
		exactKeys(value, HEAD_KEYS) &&
		typeof value.currentAnchorDigest === "string" &&
		DIGEST_HEX.test(value.currentAnchorDigest) &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		typeof value.objectId === "string"
	);
}

/**
 * Opens one bounded creator checkpoint from pinned genesis and an immediate predecessor/current pair.
 * @param input - Exact genesis, pair, Cut/QC, and independently authenticated current-head carriers.
 * @returns Genuine predecessor/current trust capabilities or one frozen fail-closed reason.
 */
export function openCreatorCheckpointTrust(input: unknown): OpenCreatorCheckpointTrustResult {
	return openCheckpoint(input, false);
}

/**
 * Opens only the explicit signed promoted variant, retaining the same independent genesis and floor checks.
 * @param input - Exact signed adjacent checkpoint and independently trusted genesis/floor.
 * @returns The authenticated current and predecessor trust for this explicit variant.
 */
export function openCreatorForwardPromotionCheckpointTrust(input: unknown): OpenCreatorCheckpointTrustResult {
	return openCheckpoint(input, true);
}

function openCheckpoint(input: unknown, promotion: boolean): OpenCreatorCheckpointTrustResult {
	try {
		if (!plainRecord(input) || !exactKeys(input, INPUT_KEYS)) return failure("malformed-input");
		const expectedObjectId = input.expectedObjectId;
		const pinnedGenesisAnchorDigest = input.pinnedGenesisAnchorDigest;
		if (
			typeof expectedObjectId !== "string" ||
			typeof pinnedGenesisAnchorDigest !== "string" ||
			!DIGEST_HEX.test(pinnedGenesisAnchorDigest) ||
			!validHead(input.expectedCurrentHead) ||
			input.expectedCurrentHead.objectId !== expectedObjectId
		) {
			return failure("malformed-input");
		}
		const genesisAnchorBytes = copiedBytes(input.exactCanonicalGenesisAnchorPreimageBytes);
		const genesisSignature = copiedBytes(input.detachedGenesisSignature, 64);
		const predecessorBytes = copiedBytes(input.exactCanonicalPredecessorTrustStateRecordBytes, 8192);
		const currentBytes = copiedBytes(input.exactCanonicalCurrentTrustStateRecordBytes, 8192);
		const cutBytes = copiedBytes(input.exactCanonicalCutValueBytes);
		const qcBytes = copiedBytes(input.exactCanonicalCommitQcBytes);
		if (
			genesisAnchorBytes === undefined ||
			genesisSignature?.byteLength !== 64 ||
			predecessorBytes === undefined ||
			currentBytes === undefined ||
			cutBytes === undefined ||
			qcBytes === undefined
		) {
			return failure("malformed-input");
		}
		const predecessor = trustRecord(predecessorBytes, expectedObjectId, pinnedGenesisAnchorDigest);
		if (predecessor === undefined) return failure("predecessor-rejected");
		const current = trustRecord(currentBytes, expectedObjectId, pinnedGenesisAnchorDigest);
		if (current === undefined) return failure("current-rejected");
		const genesisRecordBytes = encodeCanonical({
			currentAnchorDigest: pinnedGenesisAnchorDigest,
			currentEpoch: 0,
			detachedCurrentAnchorSignature: genesisSignature,
			exactCanonicalCurrentAnchorPreimageBytes: genesisAnchorBytes,
			exactCanonicalProfileBytes: predecessor.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: predecessor.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: pinnedGenesisAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId: expectedObjectId,
			profileId: predecessor.profileId,
			quorum: 1,
			version: 1,
		});
		const genesis = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: genesisRecordBytes,
			expectedObjectId,
			pinnedGenesisAnchorDigest,
		});
		if (!genesis.ok) return failure("genesis-rejected");
		const genesisMaterial = resolveCreatorAnchorTrustMaterial(genesis.trust);
		if (genesisMaterial === undefined) return failure("custody-unavailable");
		if (
			!sameBytes(predecessor.exactCanonicalProfileBytes, genesisMaterial.exactCanonicalProfileBytes) ||
			!sameBytes(predecessor.exactCanonicalSignerSetBytes, genesisMaterial.exactCanonicalSignerSetBytes) ||
			!verifyEd25519RegisteredDigest(
				predecessor.detachedCurrentAnchorSignature,
				hexBytes(predecessor.currentAnchorDigest),
				genesisMaterial.publicKey
			)
		) {
			return failure("predecessor-rejected");
		}
		if (
			!sameBytes(current.exactCanonicalProfileBytes, predecessor.exactCanonicalProfileBytes) ||
			!sameBytes(current.exactCanonicalSignerSetBytes, predecessor.exactCanonicalSignerSetBytes) ||
			!verifyEd25519RegisteredDigest(
				current.detachedCurrentAnchorSignature,
				hexBytes(current.currentAnchorDigest),
				genesisMaterial.publicKey
			)
		) {
			return failure("current-rejected");
		}
		const currentAnchor = exactRecord(current.exactCanonicalCurrentAnchorPreimageBytes);
		if (
			current.currentEpoch !== predecessor.currentEpoch + 1 ||
			currentAnchor?.previousAnchor !== predecessor.currentAnchorDigest
		) {
			return failure("lineage-invalid");
		}
		const predecessorTrust = mintCreatorAnchorTrustCheckpointPredecessor(
			genesis.trust,
			predecessor.exactCanonicalCurrentAnchorPreimageBytes,
			predecessor.detachedCurrentAnchorSignature
		);
		if (predecessorTrust === undefined) return failure("custody-unavailable");
		const openedCurrent = (promotion ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
			currentTrust: predecessorTrust,
			exactCanonicalCommitQcBytes: qcBytes,
			exactCanonicalCutValueBytes: cutBytes,
			exactCanonicalTrustStateRecordBytes: currentBytes,
		});
		if (!openedCurrent.ok) return failure("commit-qc-rejected");
		if (
			input.expectedCurrentHead.currentAnchorDigest !== openedCurrent.trust.currentAnchorDigest ||
			input.expectedCurrentHead.epoch !== openedCurrent.trust.currentEpoch ||
			input.expectedCurrentHead.objectId !== openedCurrent.trust.objectId
		) {
			return failure("expected-head-mismatch");
		}
		return Object.freeze({ currentTrust: openedCurrent.trust, ok: true as const, predecessorTrust });
	} catch {
		return failure("malformed-input");
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return compareBytes(left, right) === 0;
}

function hexBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}
