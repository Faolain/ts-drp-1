import "fake-indexeddb/auto";

import { compareBytes, decodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	D110C_0C1A_RED_TOKEN,
	D110C_0C1A_RETIREMENT_KIND,
	openD110c0c1aRetirementCheckpointFixture,
} from "./fixtures/phase-6b-d110c-0c1a/retirement-checkpoint-contract.js";

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
			expect(retirementCandidates[0]?.value.kind).toBe(D110C_0C1A_RETIREMENT_KIND);
			expect(fixture.evidence.proposed.references).toContainEqual(retirementCandidates[0]?.ref);
		} finally {
			await fixture.close();
		}
	});
});
