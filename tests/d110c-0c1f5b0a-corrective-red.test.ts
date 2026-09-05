import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

import {
	contract as anchorContract,
	bytesHex,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	inspectCreatorAuthorSettlementAdvance,
	inspectCreatorTransitionAdvance,
} from "../packages/node/src/internal/creator-transition-advance.js";
import { openCurrentEpochAuthorAuthorization } from "../packages/protocol-v3/src/author-authorization.js";
import {
	completeCreatorAuthorIssuanceFrontiers,
	completeCreatorAuthorSettlement,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
	openCreatorAuthorSettlement,
	prepareCreatorAuthorIssuanceFrontiers,
	prepareCreatorAuthorSettlement,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import {
	completeCreatorIssuanceRetirement,
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	prepareCreatorIssuanceRetirement,
} from "../packages/protocol-v3/src/creator-issuance-retirement.js";
import { mintCreatorAnchorTrustSuccessor } from "../packages/protocol-v3/src/internal/seal-authority-custody.js";
import {
	type CurrentAnchorTrust,
	installCreatorAnchorTrustRoot,
	openCurrentAnchorTrust,
} from "../packages/protocol-v3/src/public.js";

const LEGACY_PROFILE = "creator-trusted-v1";
const SETTLEMENT_PROFILE = "creator-trusted-settlement-v1";
const AUTHORIZATION_DOMAIN = "ts-drp/author-authorization/v3";
const AUTHORIZATION_PROFILE = "creator-author-authorization-v1";
const SETTLEMENT_AUTHORIZATION_MAX_BYTES = 65_536;
const CREATOR_SEED = hexBytes(anchorContract.privateKeySeedHex);
const AUTHOR = bytesHex(ed25519.getPublicKey(CREATOR_SEED));
const SNAPSHOT_MANIFEST_DIGEST = "9".repeat(64);

interface Candidate {
	readonly bytes: Uint8Array;
	readonly ref: GenerationRef;
}

interface EpochPair {
	readonly currentRecordBytes: Uint8Array;
	readonly currentTrust: CurrentAnchorTrust;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly successorAnchorDigest: string;
	readonly successorRecordBytes: Uint8Array;
	readonly successorTrust: CurrentAnchorTrust;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function authorAuthorizationBytes(authors: readonly string[]): Uint8Array {
	return encodeCanonical({
		authors,
		epoch: 0,
		kind: "drp-author-authorization",
		objectId: anchorContract.objectId,
		profileId: AUTHORIZATION_PROFILE,
		protocolMajor: 3,
		version: 1,
	});
}

function creatorMaterial(profileId: string, aclDigest: string): ReturnType<typeof makeCreatorMaterial> {
	const base = makeCreatorMaterial({ profileId });
	const anchor = Object.freeze({ ...base.anchor, aclDigest });
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(anchorContract.anchorDigestDomain, anchorBytes));
	return Object.freeze({
		...base,
		anchor,
		anchorBytes,
		anchorDigest,
		signature: ed25519.sign(hexBytes(anchorDigest), CREATOR_SEED),
	});
}

function installInput(material: ReturnType<typeof creatorMaterial>): Readonly<Record<string, unknown>> {
	return Object.freeze({
		detachedGenesisSignature: Uint8Array.from(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.from(material.anchorBytes),
		exactCanonicalProfileBytes: Uint8Array.from(material.profileBytes),
		exactCanonicalSignerSetBytes: Uint8Array.from(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
}

function openEpochPair(profileId: string, currentAclDigest: string, successorAclDigest: string): EpochPair | undefined {
	const material = creatorMaterial(profileId, currentAclDigest);
	const installed = installCreatorAnchorTrustRoot(installInput(material) as never);
	expect(installed.ok, `${profileId}:install:${installed.ok ? "ok" : installed.reason}`).toBe(true);
	if (!installed.ok) return undefined;
	const opened = openCurrentAnchorTrust({
		exactCanonicalTrustStateRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
		expectedObjectId: String(material.anchor.objectId),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
	expect(opened.ok, `${profileId}:open:${opened.ok ? "ok" : opened.reason}`).toBe(true);
	if (!opened.ok) return undefined;

	const successorAnchor = Object.freeze({
		...material.anchor,
		aclDigest: successorAclDigest,
		cutDigest: "6".repeat(64),
		epoch: 1,
		historyRoot: "7".repeat(64),
		historySize: 1,
		previousAnchor: material.anchorDigest,
		stateDigest: "8".repeat(64),
	});
	const successorAnchorBytes = encodeCanonical(successorAnchor);
	const successorAnchorDigest = hex(hashDomain("ts-drp/epoch-anchor/v3", successorAnchorBytes));
	const successorSignature = ed25519.sign(hexBytes(successorAnchorDigest), CREATOR_SEED);
	const successorTrust = mintCreatorAnchorTrustSuccessor(opened.trust, successorAnchorBytes, successorSignature);
	expect(successorTrust, `${profileId}:successor`).toMatchObject({
		currentAnchorDigest: successorAnchorDigest,
		currentEpoch: 1,
		profileId,
	});
	if (successorTrust === undefined) return undefined;
	const successorRecordBytes = encodeCanonical({
		currentAnchorDigest: successorAnchorDigest,
		currentEpoch: 1,
		detachedCurrentAnchorSignature: successorSignature,
		exactCanonicalCurrentAnchorPreimageBytes: successorAnchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		genesisAnchorDigest: material.anchorDigest,
		kind: "drp-anchor-trust-state",
		objectId: material.anchor.objectId,
		profileId,
		quorum: 1,
		version: 1,
	});
	return Object.freeze({
		currentRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
		currentTrust: opened.trust,
		genesisAnchorDigest: material.anchorDigest,
		objectId: String(material.anchor.objectId),
		successorAnchorDigest,
		successorRecordBytes,
		successorTrust,
	});
}

function candidate(bytes: Uint8Array): Candidate {
	const digested = digestBlob(bytes);
	if (!digested.ok) throw new TypeError("corrective candidate digest failed");
	return Object.freeze({
		bytes: Uint8Array.from(bytes),
		ref: Object.freeze({ byteLength: bytes.byteLength, digest: digested.value }),
	});
}

function sortedRefs(candidates: readonly Candidate[]): readonly GenerationRef[] {
	return Object.freeze(candidates.map(({ ref }) => ref).sort((left, right) => left.digest.localeCompare(right.digest)));
}

function proofCandidates(pair: EpochPair): Readonly<{ cut: Candidate; qc: Candidate }> {
	const cut = candidate(
		encodeCanonical({
			epoch: 0,
			kind: "drp-hard-epoch-cut",
			objectId: pair.objectId,
			previousAnchor: pair.currentTrust.currentAnchorDigest,
			snapshotManifestDigest: SNAPSHOT_MANIFEST_DIGEST,
		})
	);
	const qc = candidate(
		encodeCanonical({
			epoch: 0,
			kind: "drp-seal-qc",
			objectId: pair.objectId,
			phase: "commit",
		})
	);
	return Object.freeze({ cut, qc });
}

function completePrepared(
	prepared: Readonly<{ readonly digest?: string; readonly ok: boolean; readonly preparation?: object }>,
	complete: (input: unknown) => Readonly<{ readonly exactCanonicalRecordBytes?: Uint8Array; readonly ok: boolean }>
): Uint8Array | undefined {
	expect(prepared).toMatchObject({ ok: true });
	if (!prepared.ok || prepared.digest === undefined || prepared.preparation === undefined) return undefined;
	const completed = complete({
		detachedSignature: ed25519.sign(hexBytes(prepared.digest), CREATOR_SEED),
		preparation: prepared.preparation,
	});
	expect(completed).toMatchObject({ ok: true });
	return completed.exactCanonicalRecordBytes;
}

function settlementCandidate(pair: EpochPair, proof: ReturnType<typeof proofCandidates>): Candidate | undefined {
	const prepared = prepareCreatorAuthorSettlement({
		commitQcRef: proof.qc.ref,
		currentAclDigest: "2".repeat(64),
		currentTrust: pair.currentTrust,
		cutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", proof.cut.bytes)),
		frontiers: [[AUTHOR, 0, 0]],
		historyRoot: "7".repeat(64),
		historySize: 1,
		priorCheckpointDigest: CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
		priorCheckpointKind: "genesis",
		snapshotManifestDigest: SNAPSHOT_MANIFEST_DIGEST,
		successorAclDigest: "3".repeat(64),
		successorTrust: pair.successorTrust,
	});
	const bytes = completePrepared(prepared, completeCreatorAuthorSettlement);
	return bytes === undefined ? undefined : candidate(bytes);
}

function transition(
	pair: EpochPair,
	proof: ReturnType<typeof proofCandidates>,
	control: readonly Candidate[]
): Parameters<typeof inspectCreatorTransitionAdvance>[0] {
	const currentTrust = candidate(pair.currentRecordBytes);
	const successorTrust = candidate(pair.successorRecordBytes);
	const proposed = Object.freeze([successorTrust, proof.cut, proof.qc, ...control]);
	return Object.freeze({
		current: Object.freeze({ candidates: Object.freeze([currentTrust]), closure: sortedRefs([currentTrust]) }),
		currentTrust: pair.currentTrust,
		mode: "verify" as const,
		proofRefs: Object.freeze([proof.cut.ref, proof.qc.ref]),
		proposed: Object.freeze({ candidates: proposed, closure: sortedRefs(proposed) }),
		successorTrust: pair.successorTrust,
	});
}

function legacyControls(pair: EpochPair, proof: ReturnType<typeof proofCandidates>): readonly Candidate[] | undefined {
	const retirement = completePrepared(
		prepareCreatorIssuanceRetirement({
			admittedAuthorSequence: 0,
			author: AUTHOR,
			commitQcRef: proof.qc.ref,
			currentTrust: pair.currentTrust,
			cutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", proof.cut.bytes)),
			observedLineage: { exhausted: false, next: 1 },
			priorAdmittedAuthorSequence: null,
			priorRetirementCandidateDigest: CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
			snapshotManifestDigest: SNAPSHOT_MANIFEST_DIGEST,
			successorTrust: pair.successorTrust,
		}),
		completeCreatorIssuanceRetirement
	);
	const aggregate = completePrepared(
		prepareCreatorAuthorIssuanceFrontiers({
			commitQcRef: proof.qc.ref,
			currentAclDigest: "2".repeat(64),
			currentTrust: pair.currentTrust,
			cutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", proof.cut.bytes)),
			frontiers: [[AUTHOR, 0]],
			priorAggregateCandidateDigest: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
			snapshotManifestDigest: SNAPSHOT_MANIFEST_DIGEST,
			successorAclDigest: "3".repeat(64),
			successorTrust: pair.successorTrust,
		}),
		completeCreatorAuthorIssuanceFrontiers
	);
	return retirement === undefined || aggregate === undefined
		? undefined
		: Object.freeze([candidate(retirement), candidate(aggregate)]);
}

function openAuthorization(
	profileId: string,
	bytes: Uint8Array
): ReturnType<typeof openCurrentEpochAuthorAuthorization> | undefined {
	const aclDigest = hex(hashDomain(AUTHORIZATION_DOMAIN, bytes));
	const pair = openEpochPair(profileId, aclDigest, "3".repeat(64));
	if (pair === undefined) return undefined;
	const material = creatorMaterial(profileId, aclDigest);
	return openCurrentEpochAuthorAuthorization({
		detachedAnchorSignature: material.signature,
		exactCanonicalAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalAuthorAuthorizationBytes: bytes,
		trust: pair.currentTrust,
	});
}

describe("D.110c-0c1f5b0a final-review corrective RED", () => {
	it("installs and reopens genuine settlement-profile trust without rewriting its profile, then settles with successor floor trust", () => {
		const pair = openEpochPair(SETTLEMENT_PROFILE, "2".repeat(64), "3".repeat(64));
		if (pair === undefined) return;
		expect(pair.currentTrust.profileId).toBe(SETTLEMENT_PROFILE);
		expect(pair.successorTrust.profileId).toBe(SETTLEMENT_PROFILE);
		const proof = proofCandidates(pair);
		const settlement = settlementCandidate(pair, proof);
		if (settlement === undefined) return;
		expect(
			openCreatorAuthorSettlement({
				exactCanonicalRecordBytes: settlement.bytes,
				expectedCommitQcRef: proof.qc.ref,
				expectedCurrentAclDigest: "2".repeat(64),
				expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", proof.cut.bytes)),
				expectedSnapshotManifestDigest: SNAPSHOT_MANIFEST_DIGEST,
				expectedSuccessorAclDigest: "3".repeat(64),
				floorTrust: pair.successorTrust,
			})
		).toMatchObject({ ok: true });
	});

	it("normalizes exactly one settlement checkpoint and no legacy carriers while retaining legacy cardinalities", () => {
		const legacyPair = openEpochPair(LEGACY_PROFILE, "2".repeat(64), "3".repeat(64));
		if (legacyPair === undefined) return;
		const legacyProof = proofCandidates(legacyPair);
		const legacy = legacyControls(legacyPair, legacyProof);
		if (legacy === undefined) return;
		expect(inspectCreatorTransitionAdvance(transition(legacyPair, legacyProof, legacy))).toMatchObject({ ok: true });
		for (const controls of [[legacy[0]], [legacy[1]], [...legacy, legacy[0]], [...legacy, legacy[1]]] as const) {
			expect(inspectCreatorTransitionAdvance(transition(legacyPair, legacyProof, controls))).toMatchObject({
				ok: false,
			});
		}

		const settlementPair = openEpochPair(SETTLEMENT_PROFILE, "2".repeat(64), "3".repeat(64));
		if (settlementPair === undefined) return;
		const settlementProof = proofCandidates(settlementPair);
		const settlement = settlementCandidate(settlementPair, settlementProof);
		if (settlement === undefined) return;
		expect(inspectCreatorTransitionAdvance(transition(settlementPair, settlementProof, [settlement]))).toMatchObject({
			ok: true,
		});
		const legacyRetirement = candidate(encodeCanonical({ kind: CREATOR_ISSUANCE_RETIREMENT_KIND }));
		const legacyAggregate = candidate(encodeCanonical({ kind: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND }));
		for (const controls of [
			[],
			[settlement, settlement],
			[settlement, legacyRetirement],
			[settlement, legacyAggregate],
		] as const) {
			expect(inspectCreatorTransitionAdvance(transition(settlementPair, settlementProof, controls))).toMatchObject({
				ok: false,
			});
		}
	});

	it("uses the settlement author-authorization ceiling for 256 authors while preserving legacy byte and author caps", () => {
		const authors64 = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(64, "0"));
		const authors65 = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, "0"));
		expect(openAuthorization(LEGACY_PROFILE, authorAuthorizationBytes(authors64))).toMatchObject({ ok: true });
		expect(openAuthorization(LEGACY_PROFILE, authorAuthorizationBytes(authors65))).toEqual({
			ok: false,
			reason: "acl-schema-invalid",
		});
		expect(openAuthorization(LEGACY_PROFILE, new Uint8Array(8_192))).toEqual({
			ok: false,
			reason: "acl-decode-failed",
		});
		expect(openAuthorization(LEGACY_PROFILE, new Uint8Array(8_193))).toEqual({ ok: false, reason: "malformed-input" });

		const authors256 = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(64, "0"));
		const authors257 = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, "0"));
		const carrier256 = authorAuthorizationBytes(authors256);
		expect(carrier256.byteLength).toBeGreaterThan(8_192);
		expect(carrier256.byteLength).toBeLessThan(SETTLEMENT_AUTHORIZATION_MAX_BYTES);
		expect(openAuthorization(SETTLEMENT_PROFILE, carrier256)).toMatchObject({ ok: true });
		expect(openAuthorization(SETTLEMENT_PROFILE, authorAuthorizationBytes(authors257))).toEqual({
			ok: false,
			reason: "acl-schema-invalid",
		});
		expect(openAuthorization(SETTLEMENT_PROFILE, new Uint8Array(SETTLEMENT_AUTHORIZATION_MAX_BYTES))).toEqual({
			ok: false,
			reason: "acl-decode-failed",
		});
		expect(openAuthorization(SETTLEMENT_PROFILE, new Uint8Array(SETTLEMENT_AUTHORIZATION_MAX_BYTES + 1))).toEqual({
			ok: false,
			reason: "malformed-input",
		});
	});

	it("binds genesis advance to the exported settlement sentinel and retains settled-v1 digest adjacency", () => {
		const currentAcl = Object.freeze({ epoch: 0, members: Object.freeze([{ author: AUTHOR }]) });
		const successorAcl = Object.freeze({ epoch: 1, members: Object.freeze([{ author: AUTHOR }]) });
		const genesis = Object.freeze({
			closedEpoch: 0,
			frontiers: Object.freeze([[AUTHOR, 0, 0]]),
			priorCheckpointDigest: CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
			priorCheckpointKind: "genesis",
			successorEpoch: 1,
		});
		expect(CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL).toBe(
			hex(
				hashDomain(
					"ts-drp/creator-author-settlement/genesis/v1",
					encodeCanonical({ kind: "drp-creator-author-settlement-genesis", version: 1 })
				)
			)
		);
		expect(
			inspectCreatorAuthorSettlementAdvance({ currentAcl, predecessor: null, proposed: genesis, successorAcl })
		).toMatchObject({ ok: true });
		expect(
			inspectCreatorAuthorSettlementAdvance({
				currentAcl,
				predecessor: null,
				proposed: { ...genesis, priorCheckpointDigest: "f".repeat(64) },
				successorAcl,
			})
		).toMatchObject({ ok: false });

		const predecessor = Object.freeze({
			candidateDigest: "a".repeat(64),
			closedEpoch: 0,
			frontiers: Object.freeze([[AUTHOR, 0, 0]]),
			successorEpoch: 1,
		});
		const settledCurrentAcl = Object.freeze({ ...currentAcl, epoch: 1 });
		const settledSuccessorAcl = Object.freeze({ ...successorAcl, epoch: 2 });
		const settled = Object.freeze({
			closedEpoch: 1,
			frontiers: Object.freeze([[AUTHOR, 0, 1]]),
			priorCheckpointDigest: predecessor.candidateDigest,
			priorCheckpointKind: "settled-v1",
			successorEpoch: 2,
		});
		expect(
			inspectCreatorAuthorSettlementAdvance({
				currentAcl: settledCurrentAcl,
				predecessor,
				proposed: settled,
				successorAcl: settledSuccessorAcl,
			})
		).toMatchObject({ ok: true });
		expect(
			inspectCreatorAuthorSettlementAdvance({
				currentAcl: settledCurrentAcl,
				predecessor,
				proposed: { ...settled, priorCheckpointDigest: "b".repeat(64) },
				successorAcl: settledSuccessorAcl,
			})
		).toMatchObject({ ok: false });
	});
});
