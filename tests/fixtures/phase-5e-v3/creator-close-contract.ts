import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	type CloseSetHistoryCommitment,
	CompactMerkleAccumulator,
	deriveCloseSetHistoryCommitment,
	type EpochVertex,
} from "@ts-drp/compaction";
import { installCreatorAnchorTrustRoot } from "@ts-drp/protocol-v3";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type {
	CreatorCloseCandidateModules,
	ExactSealCarrier,
	SnapshotChunkDescriptor,
	SnapshotTransferProfile,
} from "./creator-close-types.js";
import { bytesHex, hexBytes, independentHashDomain } from "../phase-3a0-v3/controlled-anchor-trust.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
export const CREATOR_CLOSE_OWNER = "packages/protocol-v3/src/creator-close.ts";
export const CREATOR_PRIVATE_KEY_SEED_HEX = "31".repeat(32);
export const LOCAL_AUTHOR_PRIVATE_KEY_SEED_HEX = "52".repeat(32);
export const CREATOR_SIGNER_ID = "creator-finality";
export const OBJECT_ID = `creator:${"5".repeat(32)}`;
export const ZERO_DIGEST = "0".repeat(64);
export const SNAPSHOT_PROFILE: SnapshotTransferProfile = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

export const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8_192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4_096,
	maxSnapshotBytes: SNAPSHOT_PROFILE.maxSnapshotBytes,
	snapshotChunkBytes: SNAPSHOT_PROFILE.snapshotChunkBytes,
});

export const AVAILABILITY_POLICY = Object.freeze({
	minLocalCopies: 1,
	minMirrorReceipts: 0,
	minRollbackGenerations: 2,
	mode: "local-only",
});

const CREATOR_PUBLIC_KEY = ed25519.getPublicKey(hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX));
const LOCAL_AUTHOR_PUBLIC_KEY = ed25519.getPublicKey(hexBytes(LOCAL_AUTHOR_PRIVATE_KEY_SEED_HEX));

export const CREATOR_PUBLIC_KEY_HEX = bytesHex(CREATOR_PUBLIC_KEY);
export const LOCAL_AUTHOR_PUBLIC_KEY_HEX = bytesHex(LOCAL_AUTHOR_PUBLIC_KEY);
export const SIGNER_SET = Object.freeze([
	Object.freeze({ publicKey: CREATOR_PUBLIC_KEY_HEX, signerId: CREATOR_SIGNER_ID }),
]);
export const PROFILE = Object.freeze({
	cryptoSuiteId: "ed25519-sha256-v3",
	profileId: "creator-trusted-v1",
	quorum: 1,
	signers: SIGNER_SET,
});
export const EXACT_SIGNER_SET_BYTES = encodeCanonical(SIGNER_SET);
export const EXACT_PROFILE_BYTES = encodeCanonical(PROFILE);
export const EXACT_PARAMETERS_BYTES = encodeCanonical(PARAMETERS);
export const EXACT_AVAILABILITY_POLICY_BYTES = encodeCanonical(AVAILABILITY_POLICY);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"packages/protocol-v3/src/index.ts",
	"packages/protocol-v3/src/anchor-trust-singleton.ts",
	"packages/protocol-v3/src/creator-close.ts",
	"packages/protocol-v3/src/seal.ts",
	"packages/protocol-v3/src/snapshot-transfer.ts",
	"packages/protocol-v3/src/internal/creator-anchor-signing-request.ts",
	"packages/protocol-v3/src/internal/seal-authority-custody.ts",
	"packages/protocol-v3/package.json",
	"vite.config.mts",
	"tests/fixtures/phase-4c-v3/snapshot-stream-types.ts",
]);

export const MUTANT_REJECTIONS = Object.freeze({
	ACL_SWAP: "SNAPSHOT_BINDING_MISMATCH",
	APPLICATION_AUTHOR_AS_CREATOR: "SIGNER_NOT_AUTHORIZED",
	COMMIT_QC_AS_PREPARE: "COMMIT_QC_REQUIRED",
	CUT_CLOSE_SET_COUNT: "CUT_VALUE_MISMATCH",
	CUT_SNAPSHOT_MANIFEST: "SNAPSHOT_BINDING_MISMATCH",
	FOREIGN_COMMIT_QC: "COMMIT_QC_REJECTED",
	FOREIGN_CURRENT_TRUST: "UNTRUSTED_CURRENT_ANCHOR",
	POST_SIGN_VERTEX: "CERTIFIED_VALUE_MISMATCH",
	QC_SHORTCUT: "qc-binding-mismatch",
	SUCCESSOR_EPOCH_GAP: "EPOCH_GAP",
	SUCCESSOR_QC_OMITTED: "COMMIT_QC_REQUIRED",
	SUCCESSOR_SAME_EPOCH_DIFFERENT: "EPOCH_EQUIVOCATION",
	TRUST_RECORD_VERSION_2: "UNSUPPORTED_TRUST_STATE_VERSION",
});

interface SnapshotOracle {
	readonly aclDigest: string;
	readonly chunks: readonly Uint8Array[];
	readonly descriptors: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
	readonly stateDigest: string;
}

export interface CreatorCloseFixture {
	readonly anchorDigest: string;
	readonly commitment: CloseSetHistoryCommitment;
	readonly currentAnchor: Readonly<Record<string, unknown>>;
	readonly currentAnchorSignature: Uint8Array;
	readonly currentTrust: unknown;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalSuccessorAnchorPreimageBytes: Uint8Array;
	readonly mutatedCommitment: CloseSetHistoryCommitment;
	readonly mutatedExactCanonicalCutValueBytes: Uint8Array;
	readonly snapshot: SnapshotOracle;
	readonly successorAnchorDigest: string;
	readonly valueDigest: string;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function independentDigest(domain: string, ...parts: readonly Uint8Array[]): string {
	return bytesHex(independentHashDomain(domain, ...parts));
}

function splitPayload(bytes: Uint8Array): readonly Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_PROFILE.snapshotChunkBytes) {
		chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + SNAPSHOT_PROFILE.snapshotChunkBytes)));
	}
	return Object.freeze(chunks);
}

function buildSnapshotOracle(anchorDigest: string, archiveIndexRoot: string): SnapshotOracle {
	const exactCanonicalAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: [
			{
				author: LOCAL_AUTHOR_PUBLIC_KEY_HEX,
				finalityKey: CREATOR_PUBLIC_KEY_HEX,
				groups: ["admin", "finality", "writer"],
			},
		],
		objectId: OBJECT_ID,
		permissionless: false,
		version: 1,
	});
	const exactCanonicalApplicationBytes = encodeCanonical({
		counter: 7,
		padding: new Uint8Array(131_200).fill(0xa5),
	});
	const stateDigest = independentDigest("ts-drp/state/v3", exactCanonicalApplicationBytes);
	const aclDigest = independentDigest("ts-drp/latched-acl/v3", exactCanonicalAclBytes);
	const exactCanonicalPayloadBytes = encodeCanonical({
		acl: decodeCanonical(exactCanonicalAclBytes),
		anchor: anchorDigest,
		application: decodeCanonical(exactCanonicalApplicationBytes),
		archiveIndexRoot,
		blueprintDigest: "8".repeat(64),
		epoch: 0,
		kind: "drp-snapshot-payload",
		objectId: OBJECT_ID,
		protocolMajor: 3,
		schemaVersion: 1,
	});
	const payloadDigest = independentDigest("ts-drp/snapshot-payload/v3", exactCanonicalPayloadBytes);
	const chunks = splitPayload(exactCanonicalPayloadBytes);
	const descriptors = Object.freeze(
		chunks.map((chunk, index) =>
			Object.freeze({
				byteLength: chunk.byteLength,
				digest: independentDigest("ts-drp/snapshot-chunk/v3", encodeCanonical(index), chunk),
				index,
			})
		)
	);
	const exactCanonicalManifestBytes = encodeCanonical({
		aclDigest,
		anchor: anchorDigest,
		chunks: descriptors,
		encodingVersion: "drp-canonical-profile-1",
		epoch: 0,
		kind: "drp-snapshot-manifest",
		objectId: OBJECT_ID,
		payloadDigest,
		protocolMajor: 3,
		schemaVersion: 1,
		stateDigest,
		totalBytes: exactCanonicalPayloadBytes.byteLength,
	});
	return Object.freeze({
		aclDigest,
		chunks,
		descriptors,
		exactCanonicalManifestBytes,
		exactCanonicalPayloadBytes,
		manifestDigest: independentDigest("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes),
		payloadDigest,
		stateDigest,
	});
}

function vertex(
	input: Readonly<{
		anchorDigest: string;
		authorSequence: number;
		dependencies: readonly string[];
		logicalTime: number;
		value: number;
	}>
): Readonly<{ exactCanonicalPreimageBytes: Uint8Array; vertex: EpochVertex }> {
	const exactCanonicalPreimageBytes = encodeCanonical({
		anchor: input.anchorDigest,
		author: LOCAL_AUTHOR_PUBLIC_KEY_HEX,
		authorSequence: input.authorSequence,
		dependencies: input.dependencies,
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: input.logicalTime,
		objectId: OBJECT_ID,
		operation: { action: "add", value: input.value },
		protocolMajor: 3,
	});
	const hash = independentDigest("ts-drp/vertex/v3", exactCanonicalPreimageBytes);
	return Object.freeze({
		exactCanonicalPreimageBytes,
		vertex: {
			anchor: input.anchorDigest,
			dependencies: [...input.dependencies],
			epoch: 0,
			hash,
			kind: "drp-vertex",
			objectId: OBJECT_ID,
			operation: { action: "add", value: input.value },
		},
	});
}

function cutValue(
	input: Readonly<{
		anchorDigest: string;
		commitment: CloseSetHistoryCommitment;
		currentAnchor: Readonly<Record<string, unknown>>;
		snapshot: SnapshotOracle;
	}>
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		aclDigest: input.snapshot.aclDigest,
		archiveIndexRoot: input.currentAnchor.archiveIndexRoot,
		availabilityPolicyDigest: independentDigest("ts-drp/availability-policy/v3", EXACT_AVAILABILITY_POLICY_BYTES),
		blueprintDigest: input.currentAnchor.blueprintDigest,
		closeReason: "creator-requested",
		closeSetCount: input.commitment.closeSetCount,
		closeSetRoot: input.commitment.closeSetRoot,
		encodingVersion: "drp-canonical-profile-1",
		epoch: 0,
		historyRoot: input.commitment.historyRoot,
		historySize: input.commitment.historySize,
		kind: "drp-hard-epoch-cut",
		nextSignerSet: SIGNER_SET,
		objectId: OBJECT_ID,
		parameters: PARAMETERS,
		previousAnchor: input.anchorDigest,
		previousCutDigest: input.currentAnchor.cutDigest,
		previousHistoryRoot: input.currentAnchor.historyRoot,
		previousHistorySize: input.currentAnchor.historySize,
		protocolMajor: 3,
		snapshotManifestDigest: input.snapshot.manifestDigest,
		stateDigest: input.snapshot.stateDigest,
	});
}

/**
 * Builds the independent exact-byte Phase-5e creator-close fixture.
 * @returns Complete creator trust, graph, snapshot, cut and successor reference evidence.
 */
export async function createCreatorCloseFixture(): Promise<CreatorCloseFixture> {
	const previousHistory = new CompactMerkleAccumulator();
	const currentAnchor = Object.freeze({
		aclDigest: "2".repeat(64),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: "8".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: ZERO_DIGEST,
		epoch: 0,
		historyRoot: hex(previousHistory.root()),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: independentDigest("ts-drp/parameters/v3", EXACT_PARAMETERS_BYTES),
		previousAnchor: ZERO_DIGEST,
		profileDigest: independentDigest("ts-drp/profile/v3", EXACT_PROFILE_BYTES),
		protocolMajor: 3,
		signerSetDigest: independentDigest("ts-drp/signer-set/v3", EXACT_SIGNER_SET_BYTES),
		stateDigest: "7".repeat(64),
	});
	const exactCanonicalCurrentAnchorPreimageBytes = encodeCanonical(currentAnchor);
	const anchorDigest = independentDigest("ts-drp/epoch-anchor/v3", exactCanonicalCurrentAnchorPreimageBytes);
	const currentAnchorSignature = ed25519.sign(hexBytes(anchorDigest), hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX));
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: currentAnchorSignature,
		exactCanonicalGenesisAnchorPreimageBytes: exactCanonicalCurrentAnchorPreimageBytes,
		exactCanonicalProfileBytes: EXACT_PROFILE_BYTES,
		exactCanonicalSignerSetBytes: EXACT_SIGNER_SET_BYTES,
		pinnedGenesisAnchorDigest: anchorDigest,
	});
	if (!installed.ok) throw new Error(`creator fixture trust failed: ${installed.reason}`);

	const first = vertex({
		anchorDigest,
		authorSequence: 0,
		dependencies: [anchorDigest],
		logicalTime: 1,
		value: 1,
	});
	const second = vertex({
		anchorDigest,
		authorSequence: 1,
		dependencies: [first.vertex.hash],
		logicalTime: 2,
		value: 2,
	});
	const third = vertex({
		anchorDigest,
		authorSequence: 2,
		dependencies: [first.vertex.hash],
		logicalTime: 3,
		value: 3,
	});
	const vertices = new Map<string, EpochVertex>([
		[
			anchorDigest,
			{
				dependencies: [],
				epoch: 0,
				hash: anchorDigest,
				kind: "drp-epoch-anchor",
				objectId: OBJECT_ID,
			},
		],
		[first.vertex.hash, first.vertex],
		[second.vertex.hash, second.vertex],
		[third.vertex.hash, third.vertex],
	]);
	const charges = new Map([
		[first.vertex.hash, first.exactCanonicalPreimageBytes.byteLength],
		[second.vertex.hash, second.exactCanonicalPreimageBytes.byteLength],
		[third.vertex.hash, third.exactCanonicalPreimageBytes.byteLength],
	]);
	const commitment = await deriveCloseSetHistoryCommitment({
		authenticatedCanonicalPreimageByteLengths: charges,
		exactCanonicalEpochAnchorPreimageBytes: exactCanonicalCurrentAnchorPreimageBytes,
		frontier: [second.vertex.hash, third.vertex.hash],
		maxEpochBytes: PARAMETERS.maxEpochBytes,
		maxEpochVertices: PARAMETERS.maxEpochVertices,
		previousHistorySnapshot: previousHistory.snapshot(),
		vertices,
	});

	const mutatedThird = vertex({
		anchorDigest,
		authorSequence: 2,
		dependencies: [first.vertex.hash],
		logicalTime: 3,
		value: 4,
	});
	const mutatedVertices = new Map(vertices);
	mutatedVertices.delete(third.vertex.hash);
	mutatedVertices.set(mutatedThird.vertex.hash, mutatedThird.vertex);
	const mutatedCharges = new Map(charges);
	mutatedCharges.delete(third.vertex.hash);
	mutatedCharges.set(mutatedThird.vertex.hash, mutatedThird.exactCanonicalPreimageBytes.byteLength);
	const mutatedCommitment = await deriveCloseSetHistoryCommitment({
		authenticatedCanonicalPreimageByteLengths: mutatedCharges,
		exactCanonicalEpochAnchorPreimageBytes: exactCanonicalCurrentAnchorPreimageBytes,
		frontier: [second.vertex.hash, mutatedThird.vertex.hash],
		maxEpochBytes: PARAMETERS.maxEpochBytes,
		maxEpochVertices: PARAMETERS.maxEpochVertices,
		previousHistorySnapshot: previousHistory.snapshot(),
		vertices: mutatedVertices,
	});

	const snapshot = buildSnapshotOracle(anchorDigest, currentAnchor.archiveIndexRoot);
	const exactCanonicalCutValueBytes = encodeCanonical(cutValue({ anchorDigest, commitment, currentAnchor, snapshot }));
	const mutatedExactCanonicalCutValueBytes = encodeCanonical(
		cutValue({ anchorDigest, commitment: mutatedCommitment, currentAnchor, snapshot })
	);
	const valueDigest = independentDigest("ts-drp/hard-epoch-cut/v3", exactCanonicalCutValueBytes);
	const exactCanonicalSuccessorAnchorPreimageBytes = encodeCanonical({
		aclDigest: snapshot.aclDigest,
		archiveIndexRoot: currentAnchor.archiveIndexRoot,
		blueprintDigest: currentAnchor.blueprintDigest,
		cryptoSuiteId: currentAnchor.cryptoSuiteId,
		cutDigest: valueDigest,
		epoch: 1,
		historyRoot: commitment.historyRoot,
		historySize: commitment.historySize,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: currentAnchor.parametersDigest,
		previousAnchor: anchorDigest,
		profileDigest: currentAnchor.profileDigest,
		protocolMajor: 3,
		signerSetDigest: currentAnchor.signerSetDigest,
		stateDigest: snapshot.stateDigest,
	});
	return Object.freeze({
		anchorDigest,
		commitment,
		currentAnchor,
		currentAnchorSignature: Uint8Array.from(currentAnchorSignature),
		currentTrust: installed.trust,
		exactCanonicalCurrentAnchorPreimageBytes,
		exactCanonicalCutValueBytes,
		exactCanonicalSuccessorAnchorPreimageBytes,
		mutatedCommitment,
		mutatedExactCanonicalCutValueBytes,
		snapshot,
		successorAnchorDigest: independentDigest("ts-drp/epoch-anchor/v3", exactCanonicalSuccessorAnchorPreimageBytes),
		valueDigest,
	});
}

/**
 * Builds exact registered q=1 QC bytes from one already-signed vote carrier.
 * @param carrier - Exact registered vote preimage and detached signature.
 * @returns Canonical QC bytes and their registered digest.
 */
export function independentQc(carrier: ExactSealCarrier): Readonly<{
	exactCanonicalQcBytes: Uint8Array;
	qcDigest: string;
}> {
	const vote = decodeCanonical(carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
	const exactCanonicalQcBytes = encodeCanonical({
		epoch: vote.epoch,
		kind: "drp-seal-qc",
		objectId: vote.objectId,
		phase: vote.phase,
		proposalDigest: vote.proposalDigest,
		proposalHash: vote.proposalHash,
		round: vote.round,
		votes: [
			{
				signature: hex(carrier.signature),
				signerId: vote.signerId,
				voteDigest: independentDigest("ts-drp/seal-vote/v3", carrier.exactCanonicalPreimageBytes),
			},
		],
	});
	return Object.freeze({
		exactCanonicalQcBytes,
		qcDigest: independentDigest("ts-drp/seal-qc/v3", exactCanonicalQcBytes),
	});
}

/**
 * Authors the frozen v1 successor trust carrier after the anchor signature exists.
 * @param fixture - Independent creator close and successor evidence.
 * @param detachedCurrentAnchorSignature - Exact creator signature over the successor anchor digest.
 * @param version - Trust-state record version used by the negative version mutant.
 * @returns Exact canonical trust-state record bytes.
 */
export function successorTrustRecord(
	fixture: CreatorCloseFixture,
	detachedCurrentAnchorSignature: Uint8Array,
	version = 1
): Uint8Array {
	return trustRecordForAnchor(
		fixture,
		fixture.exactCanonicalSuccessorAnchorPreimageBytes,
		detachedCurrentAnchorSignature,
		version
	);
}

/**
 * Authors a frozen v1 trust carrier for one exact, independently signed anchor.
 * @param fixture - Independent creator close and genesis evidence.
 * @param exactCanonicalCurrentAnchorPreimageBytes - Exact candidate current-anchor preimage.
 * @param detachedCurrentAnchorSignature - Creator signature over the candidate anchor digest.
 * @param version - Trust-state record version used by the version mutant.
 * @returns Exact canonical trust-state record bytes.
 */
export function trustRecordForAnchor(
	fixture: CreatorCloseFixture,
	exactCanonicalCurrentAnchorPreimageBytes: Uint8Array,
	detachedCurrentAnchorSignature: Uint8Array,
	version = 1
): Uint8Array {
	const anchor = decodeCanonical(exactCanonicalCurrentAnchorPreimageBytes) as Readonly<{ epoch: number }>;
	return encodeCanonical({
		currentAnchorDigest: independentDigest("ts-drp/epoch-anchor/v3", exactCanonicalCurrentAnchorPreimageBytes),
		currentEpoch: anchor.epoch,
		detachedCurrentAnchorSignature,
		exactCanonicalCurrentAnchorPreimageBytes,
		exactCanonicalProfileBytes: EXACT_PROFILE_BYTES,
		exactCanonicalSignerSetBytes: EXACT_SIGNER_SET_BYTES,
		genesisAnchorDigest: fixture.anchorDigest,
		kind: "drp-anchor-trust-state",
		objectId: OBJECT_ID,
		profileId: "creator-trusted-v1",
		quorum: 1,
		version,
	});
}

/**
 * Returns the one causal product-owner readiness fact.
 * @returns Closed readiness plus the sole missing semantic owner.
 */
export function ownerReadiness(): Readonly<{ missing: readonly string[]; ready: boolean }> {
	const missing = existsSync(resolve(REPOSITORY_ROOT, CREATOR_CLOSE_OWNER)) ? [] : [CREATOR_CLOSE_OWNER];
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Loads the exact future module graph only after readiness becomes true.
 * @returns Candidate creator, request, seal and snapshot modules.
 */
export async function loadCreatorCloseModules(): Promise<CreatorCloseCandidateModules> {
	const specifiers = Object.freeze([
		"@ts-drp/protocol-v3/creator-close",
		"@ts-drp/protocol-v3/internal/creator-anchor-signing-request",
		"@ts-drp/protocol-v3/seal",
		"@ts-drp/protocol-v3/snapshot-transfer",
	]);
	const [creator, request, seal, snapshot] = await Promise.all(specifiers.map(async (specifier) => import(specifier)));
	return { creator, request, seal, snapshot } as unknown as CreatorCloseCandidateModules;
}

/**
 * Test-only SHA-256 helper for mutation/detachment evidence.
 * @param bytes - Exact carrier bytes.
 * @returns Lowercase SHA-256 digest.
 */
export function carrierSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
