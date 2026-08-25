import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { SealPhase } from "./seal-types.js";

export const OBJECT_ID = "object:phase-5";
export const ANCHOR = "11".repeat(32);
export const ZERO_DIGEST = "00".repeat(32);
export const SIGNER_IDS = Object.freeze(["A", "B", "C", "Z"]);
export const QUORUM = 3;

export const CUT_VALUE = Object.freeze({
	aclDigest: "16".repeat(32),
	archiveIndexRoot: "19".repeat(32),
	availabilityPolicyDigest: "1a".repeat(32),
	blueprintDigest: "18".repeat(32),
	closeReason: "scheduled",
	closeSetCount: 3,
	closeSetRoot: "13".repeat(32),
	encodingVersion: "drp-canonical-profile-1",
	epoch: 0,
	historyRoot: "14".repeat(32),
	historySize: 7,
	kind: "drp-hard-epoch-cut",
	nextSignerSet: Object.freeze(
		SIGNER_IDS.map((signerId, index) =>
			Object.freeze({ publicKey: (index + 145).toString(16).padStart(2, "0").repeat(32), signerId })
		)
	),
	objectId: OBJECT_ID,
	parameters: Object.freeze({
		maxDependencies: 32,
		maxEpochBytes: 1_048_576,
		maxEpochVertices: 1024,
		maxPendingBytes: 8_388_608,
		maxPendingEntries: 4096,
		maxSnapshotBytes: 16_777_216,
		snapshotChunkBytes: 65_536,
	}),
	previousAnchor: ANCHOR,
	previousCutDigest: ZERO_DIGEST,
	previousHistoryRoot: ZERO_DIGEST,
	previousHistorySize: 0,
	protocolMajor: 3,
	snapshotManifestDigest: "17".repeat(32),
	stateDigest: "15".repeat(32),
});

export const CUT_VALUE_FIELDS = Object.freeze(Reflect.ownKeys(CUT_VALUE).sort());

export const EXACT_CUT_VALUE_BYTES = encodeCanonical(CUT_VALUE);
export const VALUE_DIGEST = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", EXACT_CUT_VALUE_BYTES)).toString("hex");

/**
 * Builds the independent round-bearing proposal record.
 * @param round - Safe-integer seal round.
 * @returns Frozen proposal record.
 */
export function proposal(round: number): Readonly<Record<string, unknown>> {
	return Object.freeze({
		epoch: 0,
		kind: "drp-seal-proposal",
		objectId: OBJECT_ID,
		round,
		valueDigest: VALUE_DIGEST,
	});
}

/**
 * Computes the governed round-bearing proposal hash.
 * @param round - Safe-integer seal round.
 * @returns Lowercase proposal digest.
 */
export function proposalHash(round: number): string {
	return Buffer.from(hashDomain("ts-drp/seal-proposal/v3", encodeCanonical(proposal(round)))).toString("hex");
}

/**
 * Builds one independent canonical vote preimage value.
 * @param input - Exact phase, round and signer identity.
 * @returns Frozen vote-preimage record.
 */
export function votePreimage(
	input: Readonly<{ phase: SealPhase; round: number; signerId: string }>
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		epoch: 0,
		kind: "drp-seal-vote",
		objectId: OBJECT_ID,
		phase: input.phase,
		proposalDigest: VALUE_DIGEST,
		proposalHash: proposalHash(input.round),
		round: input.round,
		signerId: input.signerId,
	});
}

/**
 * Encodes the durable exact-slot identity for the oracle.
 * @param input - Exact phase, round and signer identity.
 * @returns Stable compound-key string.
 */
export function slotKey(input: Readonly<{ phase: SealPhase; round: number; signerId: string }>): string {
	return JSON.stringify([OBJECT_ID, 0, input.round, input.phase, input.signerId]);
}
