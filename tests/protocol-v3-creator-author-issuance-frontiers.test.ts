import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { beforeAll, describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { d108d1bChatAuthorities } from "./fixtures/phase-6a-v3/creator-successor-local-author-contract.js";
import {
	createRecoverableFinalitySigner,
	signCreatorIssuanceRetirementRequest,
} from "../packages/keychain/src/finality.js";
import {
	completeCreatorAuthorIssuanceFrontiers,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES,
	openCreatorAuthorIssuanceFrontiers,
	prepareCreatorAuthorIssuanceFrontiers,
	resolveCreatorAuthorIssuanceFrontiers,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { openCreatorSuccessorTrust } from "../packages/protocol-v3/src/creator-close.js";

interface Candidate {
	readonly bytes: Uint8Array;
	readonly ref: Readonly<{ readonly byteLength: number; readonly digest: string }>;
}

interface CarrierFixture {
	readonly candidate: Candidate;
	readonly currentTrust: Parameters<typeof prepareCreatorAuthorIssuanceFrontiers>[0] extends never ? never : unknown;
	readonly decoded: Readonly<Record<string, unknown>>;
	readonly openInput: Readonly<Record<string, unknown>>;
	readonly successorTrust: unknown;
}

const KIND = "drp-creator-author-issuance-frontiers-state";
const MAXIMUM_SAFE = Number.MAX_SAFE_INTEGER;

function record(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_0C1F2_RECORD_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function exactCandidate(candidates: readonly Candidate[], kind: string): Candidate {
	const matches = candidates.filter(({ bytes }) => record(bytes).kind === kind);
	if (matches.length !== 1) throw new TypeError(`D110C_0C1F2_CANDIDATE_INVALID:${kind}`);
	return matches[0] as Candidate;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

async function carrierFixture(): Promise<CarrierFixture & Readonly<{ close(): Promise<void> }>> {
	const authorities = d108d1bChatAuthorities();
	const creator = authorities.find(({ id }) => id === "alice");
	const writer = authorities.find(({ id }) => id === "bob");
	if (creator === undefined || writer === undefined) throw new TypeError("D110C_0C1F2_AUTHORITY_UNAVAILABLE");
	const fixture = await openGenuineCreatorAdoptionFixture({
		authorizedPrivateKeySeedHexes: [creator.privateKeySeedHex, writer.privateKeySeedHex],
		establishedPeerPrivateKeySeedHex: writer.privateKeySeedHex,
	});
	const candidate = exactCandidate(fixture.evidence.proposed.candidates, KIND);
	const cut = fixture.evidence.proposed.candidates.find(
		({ ref }) => ref.digest === fixture.evidence.closeResult.cutValueRef.digest
	);
	const qc = fixture.evidence.proposed.candidates.find(
		({ ref }) => ref.digest === fixture.evidence.closeResult.commitQcRef.digest
	);
	const trust = fixture.evidence.proposed.candidates.find(
		({ ref }) => ref.digest === fixture.evidence.closeResult.successorTrustRef.digest
	);
	if (cut === undefined || qc === undefined || trust === undefined) {
		await fixture.close();
		throw new TypeError("D110C_0C1F2_PROOF_UNAVAILABLE");
	}
	const successor = openCreatorSuccessorTrust({
		currentTrust: fixture.evidence.currentTrust,
		exactCanonicalCommitQcBytes: qc.bytes,
		exactCanonicalCutValueBytes: cut.bytes,
		exactCanonicalTrustStateRecordBytes: trust.bytes,
	});
	if (!successor.ok) {
		await fixture.close();
		throw new TypeError(`D110C_0C1F2_SUCCESSOR_UNAVAILABLE:${successor.reason}`);
	}
	const decoded = record(candidate.bytes);
	return Object.freeze({
		candidate,
		close: () => fixture.close(),
		currentTrust: fixture.evidence.currentTrust,
		decoded,
		openInput: Object.freeze({
			currentTrust: fixture.evidence.currentTrust,
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: decoded.currentAclDigest,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: record(cut.bytes).snapshotManifestDigest,
			expectedSuccessorAclDigest: decoded.successorAclDigest,
			floorTrust: successor.trust,
		}),
		successorTrust: successor.trust,
	});
}

function maximumRecord(): Readonly<Record<string, unknown>> {
	const frontiers = Array.from({ length: 64 }, (_, index) => [index.toString(16).padStart(64, "0"), MAXIMUM_SAFE]);
	return Object.freeze({
		closedAnchorDigest: "1".repeat(64),
		closedEpoch: MAXIMUM_SAFE - 1,
		commitQcRef: Object.freeze({ byteLength: MAXIMUM_SAFE, digest: "2".repeat(64) }),
		currentAclDigest: "3".repeat(64),
		cutValueDigest: "4".repeat(64),
		detachedCreatorSignature: new Uint8Array(64).fill(0xff),
		frontiers,
		genesisAnchorDigest: "5".repeat(64),
		kind: KIND,
		objectId: "o".repeat(256),
		priorAggregateCandidateDigest: "6".repeat(64),
		protocolMajor: 3,
		snapshotManifestDigest: "7".repeat(64),
		successorAclDigest: "8".repeat(64),
		successorAnchorDigest: "9".repeat(64),
		successorEpoch: MAXIMUM_SAFE,
		version: 1,
	});
}

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.110c-0c1f2 creator author-issuance frontier carrier", () => {
	it("reproduces the exact legal maximum tuple shape below the unchanged ceiling", () => {
		const exactCanonicalRecordBytes = encodeCanonical(maximumRecord());
		expect(exactCanonicalRecordBytes.byteLength).toBe(6_241);
		expect(exactCanonicalRecordBytes.byteLength).toBeLessThan(CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES);
		expect(CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES).toBe(8_192);
	});

	it("round-trips the genuine creator-signed carrier and consumes preparation once", async () => {
		const fixture = await carrierFixture();
		try {
			const opened = openCreatorAuthorIssuanceFrontiers(fixture.openInput);
			expect(opened).toMatchObject({ ok: true });
			if (!opened.ok) return;
			const identity = resolveCreatorAuthorIssuanceFrontiers(opened.capability);
			expect(identity?.frontiers).toEqual(fixture.decoded.frontiers);
			expect(resolveCreatorAuthorIssuanceFrontiers(Object.freeze({}) as never)).toBeUndefined();

			const prepared = prepareCreatorAuthorIssuanceFrontiers({
				commitQcRef: fixture.decoded.commitQcRef,
				currentAclDigest: fixture.decoded.currentAclDigest,
				currentTrust: fixture.currentTrust,
				cutValueDigest: fixture.decoded.cutValueDigest,
				frontiers: fixture.decoded.frontiers,
				priorAggregateCandidateDigest: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
				snapshotManifestDigest: fixture.decoded.snapshotManifestDigest,
				successorAclDigest: fixture.decoded.successorAclDigest,
				successorTrust: fixture.successorTrust,
			});
			expect(prepared).toMatchObject({ ok: true });
			if (!prepared.ok) return;
			const signer = await createRecoverableFinalitySigner({
				seed: hexBytes(contract.privateKeySeedHex),
			});
			const detachedSignature = await signCreatorIssuanceRetirementRequest({
				request: prepared.signingRequest,
				signer: signer.signer,
			});
			const completed = completeCreatorAuthorIssuanceFrontiers({
				detachedSignature,
				preparation: prepared.preparation,
			});
			expect(completed).toMatchObject({ ok: true });
			if (!completed.ok) return;
			expect(completed.exactCanonicalRecordBytes).toEqual(fixture.candidate.bytes);
			expect(completeCreatorAuthorIssuanceFrontiers({ detachedSignature, preparation: prepared.preparation })).toEqual({
				ok: false,
				reason: "PREPARATION_UNAVAILABLE",
			});
		} finally {
			await fixture.close();
		}
	});

	it("rejects every malformed tuple/vector form and permits an exact empty writer set", async () => {
		const fixture = await carrierFixture();
		try {
			const base = fixture.decoded.frontiers as readonly (readonly [string, number | null])[];
			const first = base[0] as readonly [string, number | null];
			const second = base[1] as readonly [string, number | null];
			const sparse = Array(2) as unknown[];
			sparse[0] = first[0];
			const invalid = [
				[{ author: first[0], admittedAuthorSequence: first[1] }],
				[[first[0]]],
				[[first[0], first[1], 0]],
				[[first[1], first[0]]],
				[sparse],
				[[null, first[1]]],
				[[first[0], -1]],
				[first, first],
				[second, first],
				Array.from({ length: 65 }, (_, index) => [index.toString(16).padStart(64, "0"), null]),
			] as const;
			const common = {
				commitQcRef: fixture.decoded.commitQcRef,
				currentAclDigest: fixture.decoded.currentAclDigest,
				currentTrust: fixture.currentTrust,
				cutValueDigest: fixture.decoded.cutValueDigest,
				priorAggregateCandidateDigest: fixture.decoded.priorAggregateCandidateDigest,
				snapshotManifestDigest: fixture.decoded.snapshotManifestDigest,
				successorAclDigest: fixture.decoded.successorAclDigest,
				successorTrust: fixture.successorTrust,
			};
			for (const frontiers of invalid) {
				expect(prepareCreatorAuthorIssuanceFrontiers({ ...common, frontiers })).toMatchObject({ ok: false });
			}
			expect(prepareCreatorAuthorIssuanceFrontiers({ ...common, frontiers: [] })).toMatchObject({ ok: true });
		} finally {
			await fixture.close();
		}
	});

	it("fails closed for every authenticated field, tuple, signature, and size substitution", async () => {
		const fixture = await carrierFixture();
		try {
			const decoded = fixture.decoded;
			const signature = Uint8Array.from(decoded.detachedCreatorSignature as Uint8Array);
			signature[0] = (signature[0] as number) ^ 1;
			const frontiers = decoded.frontiers as readonly (readonly [string, number | null])[];
			const first = frontiers[0] as readonly [string, number | null];
			const mutants = [
				{ ...decoded, objectId: `${String(decoded.objectId)}-foreign` },
				{ ...decoded, genesisAnchorDigest: "0".repeat(64) },
				{ ...decoded, closedEpoch: Number(decoded.closedEpoch) + 1 },
				{ ...decoded, closedAnchorDigest: "0".repeat(64) },
				{ ...decoded, successorEpoch: Number(decoded.successorEpoch) + 1 },
				{ ...decoded, successorAnchorDigest: "0".repeat(64) },
				{ ...decoded, currentAclDigest: "0".repeat(64) },
				{ ...decoded, successorAclDigest: "0".repeat(64) },
				{ ...decoded, cutValueDigest: "0".repeat(64) },
				{ ...decoded, commitQcRef: { ...(decoded.commitQcRef as object), digest: "0".repeat(64) } },
				{ ...decoded, snapshotManifestDigest: "0".repeat(64) },
				{ ...decoded, priorAggregateCandidateDigest: "0".repeat(64) },
				{ ...decoded, frontiers: [{ author: first[0], admittedAuthorSequence: first[1] }] },
				{ ...decoded, frontiers: [[first[0], first[1], 0]] },
				{ ...decoded, frontiers: [first, first] },
				{ ...decoded, detachedCreatorSignature: signature },
			] as const;
			for (const mutant of mutants) {
				expect(
					openCreatorAuthorIssuanceFrontiers({
						...fixture.openInput,
						exactCanonicalRecordBytes: encodeCanonical(mutant),
					})
				).toMatchObject({ ok: false });
			}
			expect(
				openCreatorAuthorIssuanceFrontiers({
					...fixture.openInput,
					exactCanonicalRecordBytes: new Uint8Array(CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES + 1),
				})
			).toMatchObject({ ok: false });
		} finally {
			await fixture.close();
		}
	});
});
