import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type D110c0b1RedFixture,
	openD110c0b1RedFixture,
} from "./fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.js";
import { inspectBoundedCreatorTrustAdvance } from "../packages/control-plane/src/creator-trust-checkpoint-advance.js";
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
