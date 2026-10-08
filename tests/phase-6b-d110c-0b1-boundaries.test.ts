import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type D110c0b1RedFixture,
	openD110c0b1RedFixture,
} from "./fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.js";
import { inspectBoundedCreatorTrustAdvance } from "../packages/control-plane/src/creator-trust-checkpoint-advance.js";
import {
	inspectCreatorTransitionAdvance,
	type InspectCreatorTransitionAdvanceInput,
} from "../packages/node/src/internal/creator-transition-advance.js";
import {
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	openCreatorAuthorIssuanceFrontiers,
	resolveCreatorAuthorIssuanceFrontiers,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { openCreatorCheckpointTrust } from "../packages/protocol-v3/src/creator-checkpoint.js";

type Candidate = Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>;

function record(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("expected canonical record");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function withRecord(bytes: Uint8Array, values: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...record(bytes), ...values });
}

function changedSignature(bytes: Uint8Array): Uint8Array {
	const signature = Uint8Array.from(record(bytes).detachedCurrentAnchorSignature as Uint8Array);
	signature[0] = (signature[0] as number) ^ 1;
	return withRecord(bytes, { detachedCurrentAnchorSignature: signature });
}

function changedByte(bytes: Uint8Array): Uint8Array {
	const changed = Uint8Array.from(bytes);
	changed[changed.byteLength - 1] = (changed[changed.byteLength - 1] as number) ^ 1;
	return changed;
}

function mutatedCandidate(candidate: Candidate, values: Readonly<Record<string, unknown>>): Candidate {
	const bytes = withRecord(candidate.bytes, values);
	const digest = digestBlob(bytes);
	if (!digest.ok) throw new TypeError("mutant digest failed");
	return Object.freeze({ bytes, ref: Object.freeze({ byteLength: bytes.byteLength, digest: digest.value }) });
}

function replaceRef(
	refs: readonly GenerationRef[],
	previous: GenerationRef,
	replacement: GenerationRef
): readonly GenerationRef[] {
	return Object.freeze(
		refs
			.map((ref) => (ref.digest === previous.digest ? replacement : ref))
			.sort((left, right) => left.digest.localeCompare(right.digest))
	);
}

function replaceCandidate(
	candidates: readonly Candidate[],
	previous: Candidate,
	replacement: Candidate
): readonly Candidate[] {
	return Object.freeze(
		candidates.map((candidate) => (candidate.ref.digest === previous.ref.digest ? replacement : candidate))
	);
}

function findCandidate(candidates: readonly Candidate[], ref: GenerationRef): Candidate {
	const candidate = candidates.find((entry) => entry.ref.digest === ref.digest);
	if (candidate === undefined) throw new TypeError("missing fixture candidate");
	return candidate;
}

function aggregateCandidate(candidates: readonly Candidate[]): Candidate {
	const matches = candidates.filter(
		(candidate) => record(candidate.bytes).kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
	);
	if (matches.length !== 1) throw new TypeError("expected one genuine aggregate candidate");
	return matches[0] as Candidate;
}

function checkpointAnchorAclDigest(trustStateRecordBytes: Uint8Array): string {
	const anchorBytes = record(trustStateRecordBytes).exactCanonicalCurrentAnchorPreimageBytes;
	if (!(anchorBytes instanceof Uint8Array)) throw new TypeError("checkpoint anchor bytes unavailable");
	const aclDigest = record(anchorBytes).aclDigest;
	if (typeof aclDigest !== "string") throw new TypeError("checkpoint ACL digest unavailable");
	return aclDigest;
}

function fullTransition(fixture: D110c0b1RedFixture): InspectCreatorTransitionAdvanceInput {
	const { boundedInput, checkpointInput, retirementTransition } = fixture.evidence;
	const checkpoint = openCreatorCheckpointTrust(checkpointInput);
	if (!checkpoint.ok) throw new TypeError("genuine checkpoint authority unavailable");
	return Object.freeze({
		current: Object.freeze({
			candidates: retirementTransition.current.candidates,
			closure: retirementTransition.current.references,
		}),
		currentTrust: checkpoint.predecessorTrust,
		mode: "verify" as const,
		proofRefs: boundedInput.proofRefs,
		proposed: Object.freeze({
			candidates: retirementTransition.proposed.candidates,
			closure: retirementTransition.proposed.references,
		}),
		successorTrust: checkpoint.currentTrust,
	});
}

describe("D.110c-0b1 bounded protocol and control boundaries", () => {
	let fixture: D110c0b1RedFixture;

	beforeAll(async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		fixture = await openD110c0b1RedFixture();
	});

	afterAll(async () => {
		await fixture?.close();
	});

	it("authenticates the full aggregate-bearing closure before trust-only projection", () => {
		const transition = fullTransition(fixture);
		const currentAggregate = aggregateCandidate(transition.current.candidates);
		const proposedAggregate = aggregateCandidate(transition.proposed.candidates);
		const inspected = inspectCreatorTransitionAdvance(transition);
		expect(inspected).toMatchObject({ kind: "successor", ok: true });
		if (!inspected.ok) throw new TypeError("genuine full transition rejected");
		expect(inspected.proposed).toBe(transition.proposed);
		expect(transition.current.closure).toHaveLength(7);
		expect(transition.proposed.closure).toHaveLength(6);
		const signature = Uint8Array.from(record(proposedAggregate.bytes).detachedCreatorSignature as Uint8Array);
		signature[0] = (signature[0] as number) ^ 1;
		const invalidSignature = mutatedCandidate(proposedAggregate, { detachedCreatorSignature: signature });
		const wrongPredecessor = mutatedCandidate(proposedAggregate, { priorAggregateCandidateDigest: "f".repeat(64) });
		const replaced = (replacement: Candidate): InspectCreatorTransitionAdvanceInput["proposed"] =>
			Object.freeze({
				candidates: replaceCandidate(transition.proposed.candidates, proposedAggregate, replacement),
				closure: replaceRef(transition.proposed.closure, proposedAggregate.ref, replacement.ref),
			});
		const mutants = [
			{
				name: "missing aggregate",
				input: {
					...transition,
					proposed: {
						candidates: transition.proposed.candidates.filter(
							(candidate) => candidate.ref.digest !== proposedAggregate.ref.digest
						),
						closure: transition.proposed.closure.filter((ref) => ref.digest !== proposedAggregate.ref.digest),
					},
				},
			},
			{
				name: "duplicate aggregate",
				input: {
					...transition,
					proposed: {
						candidates: [...transition.proposed.candidates, proposedAggregate],
						closure: [...transition.proposed.closure, proposedAggregate.ref].sort((left, right) =>
							left.digest.localeCompare(right.digest)
						),
					},
				},
			},
			{ name: "invalid signature with recomputed ref", input: { ...transition, proposed: replaced(invalidSignature) } },
			{
				name: "current aggregate substituted for proposed",
				input: { ...transition, proposed: replaced(currentAggregate) },
			},
			{ name: "tampered signed predecessor bytes", input: { ...transition, proposed: replaced(wrongPredecessor) } },
			{
				name: "genuine wrong predecessor authority",
				input: { ...transition, currentTrust: transition.successorTrust },
			},
			{
				name: "wrong commit QC",
				input: {
					...transition,
					proofRefs: [transition.proofRefs[0], fixture.evidence.boundedInput.retiringProofRefs[1]],
				},
			},
		];
		for (const { name, input } of mutants) {
			expect(inspectCreatorTransitionAdvance(input), name).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		}
	});

	it("opens both aggregates against independent authenticated checkpoint and closure bindings", () => {
		const transition = fullTransition(fixture);
		expect(inspectCreatorTransitionAdvance(transition)).toMatchObject({ kind: "successor", ok: true });
		const { boundedInput, checkpointInput, durableReferences } = fixture.evidence;
		const currentAggregate = aggregateCandidate(transition.current.candidates);
		const proposedAggregate = aggregateCandidate(transition.proposed.candidates);
		const currentCut = findCandidate(transition.current.candidates, boundedInput.retiringProofRefs[0]);
		const currentQc = findCandidate(transition.current.candidates, boundedInput.retiringProofRefs[1]);
		const currentAcl = findCandidate(transition.current.candidates, boundedInput.retiringPredecessorAclRef);
		const proposedCut = findCandidate(transition.proposed.candidates, boundedInput.proofRefs[0]);
		const proposedQc = findCandidate(transition.proposed.candidates, boundedInput.proofRefs[1]);
		// The checkpoint opener above authenticates these exact trust-record bytes before their ACLs are decoded.
		const epochOneAclDigest = checkpointAnchorAclDigest(checkpointInput.exactCanonicalPredecessorTrustStateRecordBytes);
		const epochTwoAclDigest = checkpointAnchorAclDigest(checkpointInput.exactCanonicalCurrentTrustStateRecordBytes);
		const currentInput = Object.freeze({
			exactCanonicalRecordBytes: currentAggregate.bytes,
			expectedCommitQcRef: currentQc.ref,
			expectedCurrentAclDigest: Buffer.from(hashDomain("ts-drp/latched-acl/v3", currentAcl.bytes)).toString("hex"),
			expectedCutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", currentCut.bytes)).toString("hex"),
			expectedSnapshotManifestDigest: record(currentCut.bytes).snapshotManifestDigest,
			expectedSuccessorAclDigest: epochOneAclDigest,
			floorTrust: transition.currentTrust,
		});
		const proposedInput = Object.freeze({
			currentTrust: transition.currentTrust,
			exactCanonicalRecordBytes: proposedAggregate.bytes,
			expectedCommitQcRef: proposedQc.ref,
			expectedCurrentAclDigest: epochOneAclDigest,
			expectedCutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proposedCut.bytes)).toString("hex"),
			expectedSnapshotManifestDigest: record(proposedCut.bytes).snapshotManifestDigest,
			expectedSuccessorAclDigest: epochTwoAclDigest,
			floorTrust: transition.successorTrust,
		});
		const openedCurrent = openCreatorAuthorIssuanceFrontiers(currentInput);
		const openedProposed = openCreatorAuthorIssuanceFrontiers(proposedInput);
		expect(openedCurrent).toMatchObject({ ok: true });
		expect(openedProposed).toMatchObject({ ok: true });
		if (!openedCurrent.ok || !openedProposed.ok) throw new TypeError("independent aggregate opening failed");
		expect(resolveCreatorAuthorIssuanceFrontiers(openedCurrent.capability)).toMatchObject({
			closedAnchorDigest: checkpointInput.pinnedGenesisAnchorDigest,
			closedEpoch: 0,
			successorAnchorDigest: transition.currentTrust.currentAnchorDigest,
			successorEpoch: 1,
		});
		expect(resolveCreatorAuthorIssuanceFrontiers(openedProposed.capability)).toMatchObject({
			closedAnchorDigest: transition.currentTrust.currentAnchorDigest,
			closedEpoch: 1,
			priorAggregateCandidateDigest: currentAggregate.ref.digest,
			successorAnchorDigest: transition.successorTrust.currentAnchorDigest,
			successorEpoch: 2,
		});
		for (const [candidate, references] of [
			[currentAggregate, durableReferences.current],
			[proposedAggregate, durableReferences.proposed],
			[proposedAggregate, durableReferences.active],
		] as const) {
			expect(references.filter((ref) => ref.digest === candidate.ref.digest)).toEqual([candidate.ref]);
			expect(digestBlob(candidate.bytes)).toEqual({ ok: true, value: candidate.ref.digest });
			expect(candidate.ref.byteLength).toBe(candidate.bytes.byteLength);
		}
		expect(durableReferences.proposed).not.toContainEqual(currentAggregate.ref);
		expect(durableReferences.active).not.toContainEqual(currentAggregate.ref);
		for (const input of [currentInput, proposedInput]) {
			expect(openCreatorAuthorIssuanceFrontiers({ ...input, expectedCurrentAclDigest: "f".repeat(64) })).toEqual({
				ok: false,
				reason: "IDENTITY_INVALID",
			});
			expect(openCreatorAuthorIssuanceFrontiers({ ...input, expectedCutValueDigest: "f".repeat(64) })).toEqual({
				ok: false,
				reason: "IDENTITY_INVALID",
			});
		}
	});

	it("opens the genuine immediate predecessor and current checkpoint from pinned genesis", () => {
		const input = fixture.evidence.checkpointInput;
		const opened = openCreatorCheckpointTrust(input);
		expect(opened).toMatchObject({
			currentTrust: { currentEpoch: 2, objectId: input.expectedObjectId },
			ok: true,
			predecessorTrust: { currentEpoch: 1, objectId: input.expectedObjectId },
		});
		expect(Object.keys(opened).sort()).toEqual(["currentTrust", "ok", "predecessorTrust"]);
		expect(
			openCreatorCheckpointTrust({
				...input,
				expectedCurrentHead: Object.freeze({ ...input.expectedCurrentHead, epoch: 1 }),
			})
		).toEqual({ ok: false, reason: "expected-head-mismatch" });
		expect(openCreatorCheckpointTrust({ ...input, unexpected: true })).toEqual({
			ok: false,
			reason: "malformed-input",
		});
		expect(
			openCreatorCheckpointTrust({
				...input,
				detachedGenesisSignature: changedByte(input.detachedGenesisSignature),
			})
		).toEqual({ ok: false, reason: "genesis-rejected" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				exactCanonicalPredecessorTrustStateRecordBytes: changedSignature(
					input.exactCanonicalPredecessorTrustStateRecordBytes
				),
			})
		).toEqual({ ok: false, reason: "predecessor-rejected" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				exactCanonicalCurrentTrustStateRecordBytes: changedSignature(input.exactCanonicalCurrentTrustStateRecordBytes),
			})
		).toEqual({ ok: false, reason: "current-rejected" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				exactCanonicalPredecessorTrustStateRecordBytes: input.exactCanonicalCurrentTrustStateRecordBytes,
			})
		).toEqual({ ok: false, reason: "lineage-invalid" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				exactCanonicalCutValueBytes: changedByte(input.exactCanonicalCutValueBytes),
			})
		).toEqual({ ok: false, reason: "commit-qc-rejected" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				pinnedGenesisAnchorDigest: "f".repeat(64),
			})
		).toEqual({ ok: false, reason: "predecessor-rejected" });
		expect(
			openCreatorCheckpointTrust({
				...input,
				expectedCurrentHead: Object.freeze({ ...input.expectedCurrentHead, currentAnchorDigest: "f".repeat(64) }),
			})
		).toEqual({ ok: false, reason: "expected-head-mismatch" });
	});

	it("retires exactly the stale Cut QC and predecessor ACL from the genuine staged closure", () => {
		const input = fixture.evidence.boundedInput;
		expect(inspectBoundedCreatorTrustAdvance(input)).toEqual({ kind: "successor", ok: true });
		expect(input.current.closure).toHaveLength(5);
		expect(input.proposed.closure).toHaveLength(4);
		for (const ref of [...input.retiringProofRefs, input.retiringPredecessorAclRef]) {
			expect(input.proposed.closure).not.toContainEqual(ref);
		}
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				retiringPredecessorAclRef: input.retiringProofRefs[0],
			})
		).toEqual({ ok: false, reason: "RETIRING_PREDECESSOR_ACL_INVALID" });
		expect(inspectBoundedCreatorTrustAdvance({ ...input, retiringProofRefs: [] })).toEqual({
			ok: false,
			reason: "RETIRING_PROOF_REFS_INVALID",
		});
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				proposed: Object.freeze({
					...input.proposed,
					closure: Object.freeze([...input.proposed.closure, input.retiringProofRefs[0]]),
				}),
			})
		).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				retiringProofRefs: Object.freeze([input.retiringProofRefs[0], input.retiringProofRefs[0]]),
			})
		).toEqual({ ok: false, reason: "RETIRING_PROOF_REFS_INVALID" });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				retiringProofRefs: Object.freeze([input.retiringPredecessorAclRef, input.retiringProofRefs[1]]),
			})
		).toEqual({ ok: false, reason: "RETIRING_PROOF_REFS_INVALID" });

		const retiringCut = findCandidate(input.current.candidates, input.retiringProofRefs[0]);
		const wrongEpochCut = mutatedCandidate(retiringCut, { epoch: 9 });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				current: Object.freeze({
					candidates: replaceCandidate(input.current.candidates, retiringCut, wrongEpochCut),
					closure: replaceRef(input.current.closure, retiringCut.ref, wrongEpochCut.ref),
				}),
				retiringProofRefs: Object.freeze([wrongEpochCut.ref, input.retiringProofRefs[1]]),
			})
		).toEqual({ ok: false, reason: "RETIRING_PROOF_REFS_INVALID" });

		const retiringQc = findCandidate(input.current.candidates, input.retiringProofRefs[1]);
		const wrongPhaseQc = mutatedCandidate(retiringQc, { phase: "prepare" });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				current: Object.freeze({
					candidates: replaceCandidate(input.current.candidates, retiringQc, wrongPhaseQc),
					closure: replaceRef(input.current.closure, retiringQc.ref, wrongPhaseQc.ref),
				}),
				retiringProofRefs: Object.freeze([input.retiringProofRefs[0], wrongPhaseQc.ref]),
			})
		).toEqual({ ok: false, reason: "RETIRING_PROOF_REFS_INVALID" });

		const retiringAcl = findCandidate(input.current.candidates, input.retiringPredecessorAclRef);
		const crossObjectAcl = mutatedCandidate(retiringAcl, { objectId: "d110c-0b1-cross-object" });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				current: Object.freeze({
					candidates: replaceCandidate(input.current.candidates, retiringAcl, crossObjectAcl),
					closure: replaceRef(input.current.closure, retiringAcl.ref, crossObjectAcl.ref),
				}),
				retiringPredecessorAclRef: crossObjectAcl.ref,
			})
		).toEqual({ ok: false, reason: "RETIRING_PREDECESSOR_ACL_INVALID" });

		const newCut = findCandidate(input.proposed.candidates, input.proofRefs[0]);
		const crossObjectNewCut = mutatedCandidate(newCut, { objectId: "d110c-0b1-cross-object" });
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				proofRefs: Object.freeze([crossObjectNewCut.ref, input.proofRefs[1]]),
				proposed: Object.freeze({
					candidates: replaceCandidate(input.proposed.candidates, newCut, crossObjectNewCut),
					closure: replaceRef(input.proposed.closure, newCut.ref, crossObjectNewCut.ref),
				}),
			})
		).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });

		const unrelated = input.proposed.candidates.find((candidate) => {
			const kind = record(candidate.bytes).kind;
			return kind !== "drp-anchor-trust-state" && !input.proofRefs.some((ref) => ref.digest === candidate.ref.digest);
		});
		if (unrelated === undefined) throw new TypeError("missing unrelated retained candidate");
		expect(
			inspectBoundedCreatorTrustAdvance({
				...input,
				proposed: Object.freeze({
					candidates: Object.freeze(
						input.proposed.candidates.filter((candidate) => candidate.ref.digest !== unrelated.ref.digest)
					),
					closure: Object.freeze(input.proposed.closure.filter((ref) => ref.digest !== unrelated.ref.digest)),
				}),
			})
		).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
	});
});
