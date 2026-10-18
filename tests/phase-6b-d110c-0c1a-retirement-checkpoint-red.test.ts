import "fake-indexeddb/auto";

import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableLineage,
} from "@ts-drp/issuance-store";
import { digestBlob } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { openD110c0b1RedFixture } from "./fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.js";
import {
	D110C_0C1A_RED_TOKEN,
	D110C_0C1A_RETIREMENT_KIND,
	openD110c0c1aRetirementCheckpointFixture,
} from "./fixtures/phase-6b-d110c-0c1a/retirement-checkpoint-contract.js";
import {
	createRecoverableFinalitySigner,
	signCreatorAnchorRequest,
	signCreatorIssuanceRetirementRequest,
} from "../packages/keychain/src/finality.js";
import { deriveCreatorIssuanceRetirementBoundary } from "../packages/node/src/internal/creator-issuance-retirement-boundary.js";
import { inspectCreatorTransitionAdvance } from "../packages/node/src/internal/creator-transition-advance.js";
import {
	completeCreatorAuthorIssuanceFrontiers,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	prepareCreatorAuthorIssuanceFrontiers,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { openCreatorCheckpointTrust } from "../packages/protocol-v3/src/creator-checkpoint.js";
import {
	completeCreatorIssuanceRetirement,
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	openCreatorIssuanceRetirement,
	prepareCreatorIssuanceRetirement,
	resolveCreatorIssuanceRetirement,
} from "../packages/protocol-v3/src/creator-issuance-retirement.js";

interface Candidate {
	readonly bytes: Uint8Array;
	readonly ref: Readonly<{ readonly byteLength: number; readonly digest: string }>;
}

function derivationStore(
	input: Readonly<{
		issued: ReadonlyMap<number, DurableIssueCommit>;
		lineage: DurableLineage;
		rows: readonly DurableIssuanceOutboxRecord[];
	}>
): DurableIssuanceStore {
	return Object.freeze({
		close: () => Promise.resolve(),
		compareAndMarkOutboxPublished: () => Promise.resolve(),
		readIssued: (_scope, authorSequence) => Promise.resolve(input.issued.get(authorSequence) ?? null),
		readLineage: () => Promise.resolve(input.lineage),
		readOutboxPage: () => Promise.resolve(input.rows),
		transactIssue: () => Promise.reject(new TypeError("D110C_0C1A_TEST_STORE_READ_ONLY")),
	});
}

function record(value: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(value);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_0C1A_RECORD_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function uniqueCandidate(candidates: readonly Candidate[], kind: string, epoch: number, phase?: string): Candidate {
	const matches = candidates.filter((candidate) => {
		const decoded = record(candidate.bytes);
		const candidateEpoch =
			decoded.kind === "drp-anchor-trust-state"
				? decoded.currentEpoch
				: decoded.kind === D110C_0C1A_RETIREMENT_KIND
					? decoded.closedEpoch
					: decoded.epoch;
		return decoded.kind === kind && candidateEpoch === epoch && (phase === undefined || decoded.phase === phase);
	});
	if (matches.length !== 1) throw new TypeError(`D110C_0C1A_CANDIDATE_INVALID:${kind}:${epoch}`);
	return matches[0] as (typeof matches)[number];
}

function uniqueKindCandidate(candidates: readonly Candidate[], kind: string): Candidate {
	const matches = candidates.filter((candidate) => record(candidate.bytes).kind === kind);
	if (matches.length !== 1) throw new TypeError(`D110C_0C1A_KIND_CANDIDATE_INVALID:${kind}`);
	return matches[0] as (typeof matches)[number];
}

describe("D.110c-0c1a creator issuance-retirement checkpoint RED", () => {
	it("requires one authenticated retirement carrier after a genuine dense creator close", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openD110c0c1aRetirementCheckpointFixture();
		try {
			const { closeIdentity, closeResult, durableReplayVerified, history, lineage, retirementCandidates, rows } =
				fixture.evidence;
			expect(closeResult).toMatchObject({
				closedVertexCount: history.closeSetCount,
				epoch: 0,
				lifecycle: "successor-pending-adoption",
				ok: true,
				successorEpoch: 1,
			});
			expect(lineage).toEqual({ exhausted: false, next: 3 });
			expect(rows.map(({ authorSequence }) => authorSequence)).toEqual([0, 1, 2]);
			expect(rows.map(({ digest }) => digest)).toEqual(history.closeSetOrder);
			expect(rows.map(({ journalSequence }) => journalSequence)).toEqual([0, 1, 2]);
			expect(rows.map(({ journalSourceKind }) => journalSourceKind)).toEqual([
				"received",
				"local-issued",
				"local-issued",
			]);
			expect(rows.map(({ outbox }) => outbox.publishState)).toEqual(["pending", "pending", "pending"]);
			for (const row of rows) {
				const preimage = decodeCanonical(row.canonicalPreimageBytes) as Readonly<Record<string, unknown>>;
				expect(preimage).toMatchObject({
					authorSequence: row.authorSequence,
					objectId: row.outbox.commit.outboxEntry.scope.objectId,
				});
				expect(preimage.author).toBe(row.outbox.commit.outboxEntry.scope.author);
				expect(row.issued.authorSequence).toBe(row.authorSequence);
				expect(row.outbox.commit.authorSequence).toBe(row.authorSequence);
				expect(compareBytes(row.issued.envelope.canonicalPreimageBytes, row.canonicalPreimageBytes)).toBe(0);
				expect(compareBytes(row.outbox.commit.envelope.canonicalPreimageBytes, row.canonicalPreimageBytes)).toBe(0);
				expect(compareBytes(row.issued.envelope.digest, row.outbox.commit.envelope.digest)).toBe(0);
				expect(compareBytes(row.issued.envelope.signature, row.signature)).toBe(0);
				expect(compareBytes(row.outbox.commit.envelope.signature, row.signature)).toBe(0);
				expect(history.closeSetOrder).toContain(row.digest);
			}
			expect(durableReplayVerified).toBe(true);
			expect(history.closeSetCount).toBe(3);
			expect(closeIdentity.cut).toMatchObject({
				closeSetCount: history.closeSetCount,
				closeSetRoot: history.closeSetRoot,
				epoch: 0,
				historyRoot: history.historyRoot,
				historySize: history.historySize,
				objectId: rows[0]?.outbox.commit.outboxEntry.scope.objectId,
				snapshotManifestDigest: closeIdentity.snapshotManifestDigest,
			});
			expect(closeIdentity.commitQc).toMatchObject({
				epoch: 0,
				kind: "drp-seal-qc",
				objectId: closeIdentity.cut.objectId,
				phase: "commit",
			});
			expect(closeIdentity.successorTrust).toMatchObject({
				currentAnchorDigest: closeResult.successorAnchorDigest,
				currentEpoch: closeResult.successorEpoch,
				kind: "drp-anchor-trust-state",
				objectId: closeIdentity.cut.objectId,
			});
			expect(closeIdentity).toMatchObject({
				commitQcRefExact: true,
				cutRefExact: true,
				successorOpened: true,
				successorTrustRefExact: true,
			});

			const refusal = Object.freeze({ code: D110C_0C1A_RED_TOKEN, subclass: "missing-carrier" as const });
			if (process.env.D110C_0C1A_RECORD_EVIDENCE === "1") {
				process.stdout.write(
					`D110C_0C1A_RED_EVIDENCE=${JSON.stringify({
						closeSetCount: history.closeSetCount,
						closeSetRoot: history.closeSetRoot,
						durableReplayVerified,
						historyRoot: history.historyRoot,
						historySize: history.historySize,
						lineage,
						publishStates: rows.map(({ outbox }) => outbox.publishState),
						refusal,
						retirementCandidateCount: retirementCandidates.length,
						rowDigests: rows.map(({ digest }) => digest),
						rowKeys: rows.map(({ authorSequence }) => authorSequence),
						successorAnchorDigest: closeResult.successorAnchorDigest,
					})}\n`
				);
			}
			if (retirementCandidates.length === 0) {
				expect(refusal).toEqual({ code: D110C_0C1A_RED_TOKEN, subclass: "missing-carrier" });
				throw new TypeError(D110C_0C1A_RED_TOKEN);
			}
			expect(retirementCandidates).toHaveLength(1);
			const candidate = retirementCandidates[0];
			if (candidate === undefined) throw new TypeError("D110C_0C1A_GREEN_CANDIDATE_UNAVAILABLE");
			expect(candidate.value.kind).toBe(D110C_0C1A_RETIREMENT_KIND);
			expect(fixture.evidence.proposed.references).toContainEqual(candidate.ref);
			const expectedOpen = Object.freeze({
				expectedCommitQcRef: closeResult.commitQcRef,
				expectedCutValueDigest: Buffer.from(
					hashDomain("ts-drp/hard-epoch-cut/v3", encodeCanonical(closeIdentity.cut))
				).toString("hex"),
				expectedSnapshotManifestDigest: closeIdentity.snapshotManifestDigest,
				floorTrust: fixture.evidence.successorTrust,
			});
			expect(
				openCreatorIssuanceRetirement({
					...expectedOpen,
					exactCanonicalRecordBytes: candidate.bytes,
				})
			).toMatchObject({ ok: true });
			const mutatedSignature = Uint8Array.from(candidate.value.detachedCreatorSignature as Uint8Array);
			mutatedSignature[0] = (mutatedSignature[0] as number) ^ 1;
			const mutants = Object.freeze([
				Object.freeze({ ...candidate.value, author: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, objectId: `${String(candidate.value.objectId)}-foreign` }),
				Object.freeze({ ...candidate.value, genesisAnchorDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, closedAnchorDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, successorAnchorDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, cutValueDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, snapshotManifestDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, priorRetirementCandidateDigest: "0".repeat(64) }),
				Object.freeze({ ...candidate.value, admittedAuthorSequence: 1 }),
				Object.freeze({ ...candidate.value, observedLineage: { exhausted: true, next: 3 } }),
				Object.freeze({ ...candidate.value, detachedCreatorSignature: mutatedSignature }),
			]);
			for (const mutant of mutants) {
				expect(
					openCreatorIssuanceRetirement({
						...expectedOpen,
						exactCanonicalRecordBytes: encodeCanonical(mutant),
					})
				).toMatchObject({ ok: false });
			}
			expect(
				openCreatorIssuanceRetirement({
					...expectedOpen,
					exactCanonicalRecordBytes: new Uint8Array(8193),
				})
			).toMatchObject({ ok: false });
			const transition = Object.freeze({
				current: {
					candidates: fixture.evidence.current.candidates,
					closure: fixture.evidence.current.references,
				},
				currentTrust: fixture.evidence.currentTrust,
				mode: "verify" as const,
				proofRefs: [closeResult.cutValueRef, closeResult.commitQcRef],
				proposed: {
					candidates: fixture.evidence.proposed.candidates,
					closure: fixture.evidence.proposed.references,
				},
				successorTrust: fixture.evidence.successorTrust,
			});
			expect(inspectCreatorTransitionAdvance(transition)).toMatchObject({ ok: true });
			expect(
				inspectCreatorTransitionAdvance({
					...transition,
					proposed: {
						candidates: transition.proposed.candidates.filter(({ ref }) => ref.digest !== candidate.ref.digest),
						closure: transition.proposed.closure.filter(({ digest }) => digest !== candidate.ref.digest),
					},
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
			expect(
				inspectCreatorTransitionAdvance({
					...transition,
					proposed: {
						candidates: [...transition.proposed.candidates, candidate],
						closure: [...transition.proposed.closure, candidate.ref],
					},
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
			expect(
				inspectCreatorTransitionAdvance({
					...transition,
					proposed: {
						candidates: transition.proposed.candidates,
						closure: transition.proposed.closure.filter(({ digest }) => digest !== candidate.ref.digest),
					},
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
			expect(
				inspectCreatorTransitionAdvance({
					...transition,
					proposed: {
						candidates: transition.proposed.candidates.filter(({ ref }) => ref.digest !== candidate.ref.digest),
						closure: transition.proposed.closure,
					},
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
			expect(
				inspectCreatorTransitionAdvance({
					...transition,
					proposed: {
						candidates: transition.proposed.candidates,
						closure: [...transition.proposed.closure, candidate.ref],
					},
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });

			const recreated = prepareCreatorIssuanceRetirement({
				admittedAuthorSequence: candidate.value.admittedAuthorSequence,
				author: candidate.value.author,
				commitQcRef: closeResult.commitQcRef,
				currentTrust: fixture.evidence.currentTrust,
				cutValueDigest: candidate.value.cutValueDigest,
				observedLineage: candidate.value.observedLineage,
				priorAdmittedAuthorSequence: candidate.value.priorAdmittedAuthorSequence,
				priorRetirementCandidateDigest: candidate.value.priorRetirementCandidateDigest,
				snapshotManifestDigest: candidate.value.snapshotManifestDigest,
				successorTrust: fixture.evidence.successorTrust,
			});
			expect(recreated).toMatchObject({ ok: true });
			if (!recreated.ok) throw new TypeError("D110C_0C1A_GREEN_PREPARATION_UNAVAILABLE");
			const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
			await expect(
				signCreatorAnchorRequest({ request: recreated.signingRequest as never, signer: signer.signer })
			).rejects.toThrow("untrusted or consumed creator-anchor signing request");
			const detachedSignature = await signCreatorIssuanceRetirementRequest({
				request: recreated.signingRequest,
				signer: signer.signer,
			});
			await expect(
				signCreatorIssuanceRetirementRequest({
					request: recreated.signingRequest,
					signer: signer.signer,
				})
			).rejects.toThrow("untrusted or consumed creator issuance-retirement signing request");
			const completed = completeCreatorIssuanceRetirement({
				detachedSignature,
				preparation: recreated.preparation,
			});
			expect(completed).toMatchObject({ ok: true });
			if (!completed.ok) throw new TypeError("D110C_0C1A_GREEN_COMPLETION_UNAVAILABLE");
			expect(completed.exactCanonicalRecordBytes).toEqual(candidate.bytes);
			expect(
				completeCreatorIssuanceRetirement({
					detachedSignature,
					preparation: recreated.preparation,
				})
			).toEqual({ ok: false, reason: "PREPARATION_UNAVAILABLE" });
		} finally {
			await fixture.close();
		}
	});

	it("replaces the authenticated epoch-one carrier when the admitted boundary does not advance", async () => {
		const fixture = await openD110c0b1RedFixture();
		try {
			const { checkpointInput, retirementTransition } = fixture.evidence;
			const checkpoint = openCreatorCheckpointTrust(checkpointInput);
			expect(checkpoint).toMatchObject({ ok: true });
			if (!checkpoint.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_CHECKPOINT_FAILED");
			const currentCarrier = uniqueCandidate(retirementTransition.current.candidates, D110C_0C1A_RETIREMENT_KIND, 0);
			const ordinaryProposedCarrier = uniqueCandidate(
				retirementTransition.proposed.candidates,
				D110C_0C1A_RETIREMENT_KIND,
				1
			);
			const currentAggregate = uniqueKindCandidate(
				retirementTransition.current.candidates,
				CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
			);
			const ordinaryProposedAggregate = uniqueKindCandidate(
				retirementTransition.proposed.candidates,
				CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
			);
			const currentCut = uniqueCandidate(retirementTransition.current.candidates, "drp-hard-epoch-cut", 0);
			const currentQc = uniqueCandidate(retirementTransition.current.candidates, "drp-seal-qc", 0, "commit");
			const proposedCut = uniqueCandidate(retirementTransition.proposed.candidates, "drp-hard-epoch-cut", 1);
			const proposedQc = uniqueCandidate(retirementTransition.proposed.candidates, "drp-seal-qc", 1, "commit");
			const currentCutRecord = record(currentCut.bytes);
			const proposedCutRecord = record(proposedCut.bytes);
			const openedCurrent = openCreatorIssuanceRetirement({
				exactCanonicalRecordBytes: currentCarrier.bytes,
				expectedCommitQcRef: currentQc.ref,
				expectedCutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", currentCut.bytes)).toString("hex"),
				expectedSnapshotManifestDigest: currentCutRecord.snapshotManifestDigest,
				floorTrust: checkpoint.predecessorTrust,
			});
			expect(openedCurrent).toMatchObject({ ok: true });
			if (!openedCurrent.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_OPEN_FAILED");
			const currentIdentity = resolveCreatorIssuanceRetirement(openedCurrent.capability);
			expect(currentIdentity).toBeDefined();
			if (currentIdentity === undefined) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_IDENTITY_FAILED");
			const ordinaryProposedRecord = record(ordinaryProposedCarrier.bytes);
			const prepared = prepareCreatorIssuanceRetirement({
				admittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				author: currentIdentity.author,
				commitQcRef: proposedQc.ref,
				currentTrust: checkpoint.predecessorTrust,
				cutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proposedCut.bytes)).toString("hex"),
				observedLineage: ordinaryProposedRecord.observedLineage,
				priorAdmittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				priorRetirementCandidateDigest: currentCarrier.ref.digest,
				snapshotManifestDigest: proposedCutRecord.snapshotManifestDigest,
				successorTrust: checkpoint.currentTrust,
			});
			expect(prepared).toMatchObject({ ok: true });
			if (!prepared.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_PREPARE_FAILED");
			const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
			const signature = await signCreatorIssuanceRetirementRequest({
				request: prepared.signingRequest,
				signer: signer.signer,
			});
			const completed = completeCreatorIssuanceRetirement({
				detachedSignature: signature,
				preparation: prepared.preparation,
			});
			expect(completed).toMatchObject({ ok: true });
			if (!completed.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_COMPLETE_FAILED");
			const sameBoundaryRef = digestBlob(completed.exactCanonicalRecordBytes);
			expect(sameBoundaryRef).toMatchObject({ ok: true });
			if (!sameBoundaryRef.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_DIGEST_FAILED");
			const replacement = Object.freeze({
				bytes: completed.exactCanonicalRecordBytes,
				ref: Object.freeze({
					byteLength: completed.exactCanonicalRecordBytes.byteLength,
					digest: sameBoundaryRef.value,
				}),
			});
			const ordinaryAggregateRecord = record(ordinaryProposedAggregate.bytes);
			const replacementFrontiers = (
				ordinaryAggregateRecord.frontiers as readonly (readonly [string, number | null])[]
			).map(([author, boundary]) =>
				Object.freeze([
					author,
					author === currentIdentity.author ? currentIdentity.admittedAuthorSequence : boundary,
				] as const)
			);
			const preparedAggregate = prepareCreatorAuthorIssuanceFrontiers({
				commitQcRef: proposedQc.ref,
				currentAclDigest: ordinaryAggregateRecord.currentAclDigest,
				currentTrust: checkpoint.predecessorTrust,
				cutValueDigest: ordinaryAggregateRecord.cutValueDigest,
				frontiers: replacementFrontiers,
				priorAggregateCandidateDigest: currentAggregate.ref.digest,
				snapshotManifestDigest: ordinaryAggregateRecord.snapshotManifestDigest,
				successorAclDigest: ordinaryAggregateRecord.successorAclDigest,
				successorTrust: checkpoint.currentTrust,
			});
			expect(preparedAggregate).toMatchObject({ ok: true });
			if (!preparedAggregate.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_AGGREGATE_PREPARE_FAILED");
			const aggregateSignature = await signCreatorIssuanceRetirementRequest({
				request: preparedAggregate.signingRequest,
				signer: signer.signer,
			});
			const completedAggregate = completeCreatorAuthorIssuanceFrontiers({
				detachedSignature: aggregateSignature,
				preparation: preparedAggregate.preparation,
			});
			expect(completedAggregate).toMatchObject({ ok: true });
			if (!completedAggregate.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_AGGREGATE_COMPLETE_FAILED");
			const aggregateReplacementDigest = digestBlob(completedAggregate.exactCanonicalRecordBytes);
			expect(aggregateReplacementDigest).toMatchObject({ ok: true });
			if (!aggregateReplacementDigest.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_AGGREGATE_DIGEST_FAILED");
			const aggregateReplacement = Object.freeze({
				bytes: completedAggregate.exactCanonicalRecordBytes,
				ref: Object.freeze({
					byteLength: completedAggregate.exactCanonicalRecordBytes.byteLength,
					digest: aggregateReplacementDigest.value,
				}),
			});
			const proposed = Object.freeze({
				candidates: Object.freeze(
					retirementTransition.proposed.candidates.map((candidate) => {
						if (candidate.ref.digest === ordinaryProposedCarrier.ref.digest) return replacement;
						return candidate.ref.digest === ordinaryProposedAggregate.ref.digest ? aggregateReplacement : candidate;
					})
				),
				closure: Object.freeze(
					retirementTransition.proposed.references.map((ref) => {
						if (ref.digest === ordinaryProposedCarrier.ref.digest) return replacement.ref;
						return ref.digest === ordinaryProposedAggregate.ref.digest ? aggregateReplacement.ref : ref;
					})
				),
			});
			const openedProposed = openCreatorIssuanceRetirement({
				exactCanonicalRecordBytes: replacement.bytes,
				expectedCommitQcRef: proposedQc.ref,
				expectedCutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proposedCut.bytes)).toString("hex"),
				expectedSnapshotManifestDigest: proposedCutRecord.snapshotManifestDigest,
				floorTrust: checkpoint.currentTrust,
			});
			expect(openedProposed).toMatchObject({ ok: true });
			if (!openedProposed.ok) throw new TypeError("D110C_0C1A_SAME_BOUNDARY_SUCCESSOR_OPEN_FAILED");
			const proposedIdentity = resolveCreatorIssuanceRetirement(openedProposed.capability);
			expect(proposedIdentity).toMatchObject({
				admittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				closedEpoch: 1,
				priorAdmittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				priorRetirementCandidateDigest: currentCarrier.ref.digest,
				successorEpoch: 2,
			});
			expect(retirementTransition.current.references).toContainEqual(currentCarrier.ref);
			expect(proposed.closure).not.toContainEqual(currentCarrier.ref);
			expect(proposed.closure).toContainEqual(replacement.ref);
			const sameBoundaryAdvance = inspectCreatorTransitionAdvance({
				current: {
					candidates: retirementTransition.current.candidates,
					closure: retirementTransition.current.references,
				},
				currentTrust: checkpoint.predecessorTrust,
				mode: "verify",
				proofRefs: [proposedCut.ref, proposedQc.ref],
				proposed,
				successorTrust: checkpoint.currentTrust,
			});
			expect(sameBoundaryAdvance, JSON.stringify(sameBoundaryAdvance)).toMatchObject({ ok: true });

			const forkPrepared = prepareCreatorIssuanceRetirement({
				admittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				author: currentIdentity.author,
				commitQcRef: proposedQc.ref,
				currentTrust: checkpoint.predecessorTrust,
				cutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proposedCut.bytes)).toString("hex"),
				observedLineage: ordinaryProposedRecord.observedLineage,
				priorAdmittedAuthorSequence: currentIdentity.admittedAuthorSequence,
				priorRetirementCandidateDigest: currentCarrier.ref.digest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
				snapshotManifestDigest: proposedCutRecord.snapshotManifestDigest,
				successorTrust: checkpoint.currentTrust,
			});
			expect(forkPrepared).toMatchObject({ ok: true });
			if (!forkPrepared.ok) throw new TypeError("D110C_0C1A_FORK_PREPARE_FAILED");
			const forkSignature = await signCreatorIssuanceRetirementRequest({
				request: forkPrepared.signingRequest,
				signer: signer.signer,
			});
			const forkCompleted = completeCreatorIssuanceRetirement({
				detachedSignature: forkSignature,
				preparation: forkPrepared.preparation,
			});
			expect(forkCompleted).toMatchObject({ ok: true });
			if (!forkCompleted.ok) throw new TypeError("D110C_0C1A_FORK_COMPLETE_FAILED");
			const forkDigest = digestBlob(forkCompleted.exactCanonicalRecordBytes);
			expect(forkDigest).toMatchObject({ ok: true });
			if (!forkDigest.ok) throw new TypeError("D110C_0C1A_FORK_DIGEST_FAILED");
			const forkCandidate = Object.freeze({
				bytes: forkCompleted.exactCanonicalRecordBytes,
				ref: Object.freeze({
					byteLength: forkCompleted.exactCanonicalRecordBytes.byteLength,
					digest: forkDigest.value,
				}),
			});
			const forkedProposed = Object.freeze({
				candidates: Object.freeze(
					retirementTransition.proposed.candidates.map((candidate) =>
						candidate.ref.digest === ordinaryProposedCarrier.ref.digest ? forkCandidate : candidate
					)
				),
				closure: Object.freeze(
					retirementTransition.proposed.references.map((ref) =>
						ref.digest === ordinaryProposedCarrier.ref.digest ? forkCandidate.ref : ref
					)
				),
			});
			expect(
				inspectCreatorTransitionAdvance({
					current: {
						candidates: retirementTransition.current.candidates,
						closure: retirementTransition.current.references,
					},
					currentTrust: checkpoint.predecessorTrust,
					mode: "verify",
					proofRefs: [proposedCut.ref, proposedQc.ref],
					proposed: forkedProposed,
					successorTrust: checkpoint.currentTrust,
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
			expect(
				prepareCreatorIssuanceRetirement({
					admittedAuthorSequence: currentIdentity.admittedAuthorSequence,
					author: currentIdentity.author,
					commitQcRef: proposedQc.ref,
					currentTrust: checkpoint.predecessorTrust,
					cutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proposedCut.bytes)).toString("hex"),
					observedLineage: ordinaryProposedRecord.observedLineage,
					priorAdmittedAuthorSequence: null,
					priorRetirementCandidateDigest: CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
					snapshotManifestDigest: proposedCutRecord.snapshotManifestDigest,
					successorTrust: checkpoint.currentTrust,
				})
			).toEqual({ ok: false, reason: "IDENTITY_INVALID" });
		} finally {
			await fixture.close();
		}
	});

	it("fails closed for every frozen issuance-boundary derivation mutant", async () => {
		const fixture = await openD110c0c1aRetirementCheckpointFixture();
		try {
			const { currentTrust, issuanceScope, lineage, rows } = fixture.evidence;
			const [row0, row1, row2] = rows;
			if (row0 === undefined || row1 === undefined || row2 === undefined) {
				throw new TypeError("D110C_0C1A_DERIVATION_FIXTURE_INCOMPLETE");
			}
			const outboxRows = rows.map(({ outbox }) => outbox);
			const issued = new Map(rows.map((row) => [row.authorSequence, row.issued] as const));
			const graph = new Set(rows.map(({ digest }) => digest));
			const derive = (
				input: Readonly<{
					graph?: ReadonlySet<string>;
					issued?: ReadonlyMap<number, DurableIssueCommit>;
					lineage?: DurableLineage;
					maxEpochVertices?: number;
					rows?: readonly DurableIssuanceOutboxRecord[];
				}>
			): ReturnType<typeof deriveCreatorIssuanceRetirementBoundary> =>
				deriveCreatorIssuanceRetirementBoundary({
					currentAnchorDigest: currentTrust.currentAnchorDigest,
					currentEpoch: currentTrust.currentEpoch,
					graphVertexDigests: input.graph ?? graph,
					issuanceScope,
					issuanceStore: derivationStore({
						issued: input.issued ?? issued,
						lineage: input.lineage ?? lineage,
						rows: input.rows ?? outboxRows,
					}),
					maxEpochVertices: input.maxEpochVertices ?? 8,
					priorAdmittedAuthorSequence: null,
				});

			await expect(derive({})).resolves.toEqual({
				admittedAuthorSequence: 2,
				observedLineage: { exhausted: false, next: 3 },
			});
			await expect(derive({ graph: new Set([row0.digest, row1.digest]) })).resolves.toEqual({
				admittedAuthorSequence: 1,
				observedLineage: { exhausted: false, next: 3 },
			});

			const substituted = new Map(issued);
			substituted.set(1, row2.issued);
			const rejectionCases = Object.freeze([
				Object.freeze({
					lineage: { exhausted: false, next: 2 },
					name: "gapped-address",
					rows: [row0.outbox, row2.outbox],
				}),
				Object.freeze({
					lineage: { exhausted: false, next: 4 },
					name: "duplicate-address",
					rows: [row0.outbox, row0.outbox, row1.outbox, row2.outbox],
				}),
				Object.freeze({ issued: substituted, name: "issued-outbox-substitution" }),
				Object.freeze({ graph: new Set([row0.digest, row2.digest]), name: "graph-reentry-after-omission" }),
				Object.freeze({ lineage: { exhausted: false, next: 4 }, name: "incomplete-lineage" }),
				Object.freeze({ lineage: { exhausted: true, next: 3 }, name: "exhausted-lineage" }),
				Object.freeze({ maxEpochVertices: 2, name: "over-limit-scan" }),
				Object.freeze({ lineage: { exhausted: false, next: 0 }, name: "empty-initialization", rows: [] }),
			] as const);
			for (const rejection of rejectionCases) {
				await expect(derive(rejection)).rejects.toThrow(D110C_0C1A_RED_TOKEN);
			}
		} finally {
			await fixture.close();
		}
	});
});
