import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { LIVE_JOURNAL_RETIREMENT_LIMITS, type LiveJournalScope } from "@ts-drp/live-journal";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { SEAL_CANONICAL_RECORD_MAX_BYTES } from "@ts-drp/protocol-v3/seal";
import {
	openCreatorCheckpointTrust,
	openCreatorForwardPromotionCheckpointTrust,
} from "@ts-drp/protocol-v3/creator-checkpoint";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";

/** Received-only durable material. These bytes carry no authority until reopened against the
 * immutable genesis and the original signed journal header on each classification. */
export const RECEIVED_CLOSE_MEMBERSHIP_KIND = "creator-received-close-membership-1" as const;
export const RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES = SEAL_CANONICAL_RECORD_MAX_BYTES;
const LIMITS = { maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxDepth: 32, maxItems: 65_536 };
const KEYS =
	"exactCanonicalCommitQcBytes,exactCanonicalCutValueBytes,exactCanonicalMembershipBytes,exactCanonicalSuccessorTrustStateRecordBytes,kind";
export interface ReceivedClosedJournalAuthorityMaterial {
	readonly scope: LiveJournalScope;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array;
}
export interface ReceivedClosedJournalAuthority {
	readonly scope: LiveJournalScope;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly closedAclDigest: string;
	readonly profileId: "creator-trusted-settlement-v1" | "creator-trusted-v1";
	readonly suiteId: string;
}
export interface ReceivedClosedJournalHeader {
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
}
export interface ReceivedCloseMembership extends Omit<ReceivedClosedJournalAuthorityMaterial, "scope"> {
	readonly exactCanonicalMembershipBytes: Uint8Array;
}
export type ReceivedCloseAuthorityRecords = Pick<ReceivedCloseMembership,
	"exactCanonicalCommitQcBytes" | "exactCanonicalSuccessorTrustStateRecordBytes">;
export interface ReceivedClosedJournalAuthorityRead {
	readonly scope: LiveJournalScope;
	readonly header: ReceivedClosedJournalHeader;
	readonly exactCanonicalMembershipBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
}
function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bytes(value: unknown, bound: number): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > bound)
		throw new TypeError("received journal membership field exceeds its bound");
	return Uint8Array.from(value);
}
/** Syntax capture only. The original membership opener and checkpoint owner independently
 * authenticate its two parts before this envelope can justify retirement. */
export function openReceivedCloseMembership(value: Uint8Array): ReceivedCloseMembership | undefined {
	try {
		const exact = bytes(value, LIMITS.maxBytes);
		const outer = plainRecord(decodeCanonical(exact, LIMITS));
		if (
			outer === undefined ||
			outer.kind !== RECEIVED_CLOSE_MEMBERSHIP_KIND ||
			Object.keys(outer).sort().join(",") !== KEYS ||
			compareBytes(exact, encodeCanonical(outer, LIMITS)) !== 0
		)
			return undefined;
		const membership = bytes(outer.exactCanonicalMembershipBytes, LIMITS.maxBytes);
		const cut = bytes(outer.exactCanonicalCutValueBytes, RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES);
		const inner = plainRecord(decodeCanonical(membership, LIMITS));
		if (
			inner?.kind !== "creator-close-membership-1" ||
			inner.cutValueDigest !== hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut))
		)
			return undefined;
		return Object.freeze({
			exactCanonicalMembershipBytes: membership,
			exactCanonicalCutValueBytes: cut,
			exactCanonicalCommitQcBytes: bytes(outer.exactCanonicalCommitQcBytes, RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES),
			exactCanonicalSuccessorTrustStateRecordBytes: bytes(
				outer.exactCanonicalSuccessorTrustStateRecordBytes,
				RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES
			),
		});
	} catch {
		return undefined;
	}
}
/** Captures the complete received authority in the same write as the original membership.
 * The native image ceiling bounds all retained envelopes and every copied byte is charged by
 * the caller's existing whole-image reservation. */
export function encodeReceivedCloseMembership(input: ReceivedCloseMembership): Uint8Array {
	const encoded = encodeCanonical(
		{
			kind: RECEIVED_CLOSE_MEMBERSHIP_KIND,
			exactCanonicalMembershipBytes: bytes(input.exactCanonicalMembershipBytes, LIMITS.maxBytes),
			exactCanonicalCutValueBytes: bytes(input.exactCanonicalCutValueBytes, RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES),
			exactCanonicalCommitQcBytes: bytes(input.exactCanonicalCommitQcBytes, RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES),
			exactCanonicalSuccessorTrustStateRecordBytes: bytes(
				input.exactCanonicalSuccessorTrustStateRecordBytes,
				RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES
			),
		},
		LIMITS
	);
	if (openReceivedCloseMembership(encoded) === undefined)
		throw new TypeError("received journal membership differs from its Cut");
	return encoded;
}

/**
 * Re-verifies kept material against the creator's immutable trust and returns the scope's Cut
 * authority, or undefined (never used) on any mismatch. The predecessor trust state (e) is
 * rebuilt from the scope's own signed header and the pinned genesis carriers; the checkpoint
 * owner verifies both anchor signatures under the genesis signer set, their lineage, and the
 * Cut/QC successor equation, and the result must name exactly this scope.
 * @param input - Kept material, the scope's signed header and the pinned genesis trust state.
 * @returns The re-verified authority, or undefined.
 */
export function verifyReceivedClosedJournalAuthority(
	input: Readonly<{
		material: ReceivedClosedJournalAuthorityMaterial;
		header: ReceivedClosedJournalHeader;
		exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
	}>
): ReceivedClosedJournalAuthority | undefined {
	try {
		const { material, header } = input;
		const scope = material.scope;
		const genesis = plainRecord(decodeCanonical(input.exactCanonicalPinnedGenesisTrustStateRecordBytes));
		const cut = plainRecord(decodeCanonical(material.exactCanonicalCutValueBytes));
		const anchor = plainRecord(decodeCanonical(header.exactCanonicalAnchorPreimageBytes));
		const successor = plainRecord(decodeCanonical(material.exactCanonicalSuccessorTrustStateRecordBytes));
		if (
			genesis === undefined ||
			cut === undefined ||
			anchor === undefined ||
			successor === undefined ||
			genesis.kind !== "drp-anchor-trust-state" ||
			genesis.currentEpoch !== 0 ||
			genesis.objectId !== scope.objectId ||
			(genesis.profileId !== "creator-trusted-settlement-v1" && genesis.profileId !== "creator-trusted-v1") ||
			typeof genesis.currentAnchorDigest !== "string" ||
			!(genesis.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(genesis.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			!(genesis.exactCanonicalProfileBytes instanceof Uint8Array) ||
			!(genesis.exactCanonicalSignerSetBytes instanceof Uint8Array) ||
			!Number.isSafeInteger(scope.epoch) ||
			scope.epoch < 0 ||
			cut.objectId !== scope.objectId ||
			cut.epoch !== scope.epoch ||
			cut.previousAnchor !== scope.anchorDigest ||
			anchor.objectId !== scope.objectId ||
			anchor.epoch !== scope.epoch ||
			hex(hashDomain("ts-drp/epoch-anchor/v3", header.exactCanonicalAnchorPreimageBytes)) !== scope.anchorDigest ||
			typeof anchor.aclDigest !== "string" ||
			typeof anchor.cryptoSuiteId !== "string" ||
			successor.currentEpoch !== scope.epoch + 1 ||
			typeof successor.currentAnchorDigest !== "string"
		)
			return undefined;
		const authority = Object.freeze({
			scope: Object.freeze({ ...scope }),
			exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes.slice(),
			closedAclDigest: anchor.aclDigest,
			profileId: genesis.profileId,
			suiteId: anchor.cryptoSuiteId,
		});
		if (scope.epoch === 0) {
			// The genesis scope closes the pinned genesis trust itself. Its predecessor is
			// not a checkpoint trust record: the original genesis-successor state equation
			// (QC, Cut binding and successor anchor) authenticates it from the pin.
			if (genesis.currentAnchorDigest !== scope.anchorDigest || Object.hasOwn(cut, "forwardPromotion"))
				return undefined;
			const pin = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: input.exactCanonicalPinnedGenesisTrustStateRecordBytes.slice(),
				expectedObjectId: scope.objectId,
				pinnedGenesisAnchorDigest: genesis.currentAnchorDigest,
			});
			if (!pin.ok || pin.trust.currentEpoch !== 0 || pin.trust.currentAnchorDigest !== scope.anchorDigest)
				return undefined;
			const opened = openCreatorSuccessorTrust({
				currentTrust: pin.trust,
				exactCanonicalCommitQcBytes: material.exactCanonicalCommitQcBytes.slice(),
				exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes.slice(),
				exactCanonicalTrustStateRecordBytes: material.exactCanonicalSuccessorTrustStateRecordBytes.slice(),
			});
			return opened.ok &&
				opened.trust.objectId === scope.objectId &&
				opened.trust.currentEpoch === 1 &&
				opened.trust.currentAnchorDigest === successor.currentAnchorDigest
				? authority
				: undefined;
		}
		const predecessorRecordBytes = encodeCanonical({
			currentAnchorDigest: scope.anchorDigest,
			currentEpoch: scope.epoch,
			detachedCurrentAnchorSignature: header.detachedAnchorSignature.slice(),
			exactCanonicalCurrentAnchorPreimageBytes: header.exactCanonicalAnchorPreimageBytes.slice(),
			exactCanonicalProfileBytes: genesis.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: genesis.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: genesis.currentAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId: scope.objectId,
			profileId: genesis.profileId,
			quorum: 1,
			version: 1,
		});
		const open = Object.hasOwn(cut, "forwardPromotion")
			? openCreatorForwardPromotionCheckpointTrust
			: openCreatorCheckpointTrust;
		const opened = open({
			detachedGenesisSignature: genesis.detachedCurrentAnchorSignature.slice(),
			exactCanonicalCommitQcBytes: material.exactCanonicalCommitQcBytes.slice(),
			exactCanonicalCurrentTrustStateRecordBytes: material.exactCanonicalSuccessorTrustStateRecordBytes.slice(),
			exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes.slice(),
			exactCanonicalGenesisAnchorPreimageBytes: genesis.exactCanonicalCurrentAnchorPreimageBytes.slice(),
			exactCanonicalPredecessorTrustStateRecordBytes: predecessorRecordBytes,
			expectedCurrentHead: {
				currentAnchorDigest: successor.currentAnchorDigest,
				epoch: scope.epoch + 1,
				objectId: scope.objectId,
			},
			expectedObjectId: scope.objectId,
			pinnedGenesisAnchorDigest: genesis.currentAnchorDigest,
		});
		if (
			!opened.ok ||
			opened.predecessorTrust.currentEpoch !== scope.epoch ||
			opened.predecessorTrust.currentAnchorDigest !== scope.anchorDigest ||
			opened.predecessorTrust.objectId !== scope.objectId ||
			opened.currentTrust.currentEpoch !== scope.epoch + 1
		)
			return undefined;
		return authority;
	} catch {
		return undefined;
	}
}
