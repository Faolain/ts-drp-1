import { describe, expect, it } from "vitest";

import { maximalEntries } from "./fixtures/phase-3f-c/application-batching-fixture.js";
import { runSharedPlaneScenario } from "./fixtures/phase-3g/rebase-outbox-fixture.js";

describe("Phase 3g authenticated-plane rebase outbox RED", () => {
	it("uses one real issue/close/reopen lineage and publishes only the current target row", async () => {
		const result = await runSharedPlaneScenario();
		expect(result.sourceSessionClosedBeforeTargetOpen).toBe(true);
		expect(result.sourceAuthorityPrepared).toBe(true);
		expect(result.sourceContextAuthor).toBe(result.sourceRowAuthor);
		expect(result.sourceRowAuthor).toBe(result.targetAuthor);
		expect(result.sourceAnchor).not.toBe(result.targetAnchor);
		expect(result.sourceIssue).toMatchObject({ authorSequence: 1, kind: "accepted", ok: true });
		expect(result.recovery).toMatchObject({
			ok: true,
			descriptor: {
				recoveredVertices: [expect.objectContaining({ anchor: result.targetAnchor, authorSequence: 2 })],
			},
		});
		expect(result.rebaseOutbox).toEqual({
			kind: "displaced",
			ok: true,
			source: {
				author: result.sourceRowAuthor,
				authorSequence: 1,
				intents: [
					{
						logicalTime: 3,
						operation: { action: "add", value: 1 },
						operationCount: 1,
						operationIndex: 0,
					},
				],
				vertexDigest: result.sourceDigest,
			},
		});
		expect(result.publication).toEqual({ kind: "published", ok: true });
		expect(result.networkPublishedDigests).toEqual([result.targetDigest]);
		expect(result.outbox).toEqual([
			{ authorSequence: 0, digest: expect.any(String), publishState: "published" },
			{ authorSequence: 1, digest: result.sourceDigest, publishState: "pending" },
			{ authorSequence: 2, digest: result.targetDigest, publishState: "published" },
		]);
	});

	it("expands genuine two and sixteen child source batches in signed order", async () => {
		for (const count of [2, 16] as const) {
			const result = await runSharedPlaneScenario({ sourceOperationProfile: `batch-${count}` });
			expect(result.sourceIssue).toMatchObject({ authorSequence: 1, kind: "accepted", ok: true });
			expect(result.recovery).toMatchObject({ ok: true });
			expect(result.rebaseOutbox).toEqual({
				kind: "displaced",
				ok: true,
				source: {
					author: result.sourceRowAuthor,
					authorSequence: 1,
					intents: maximalEntries("counter", count).map((entry, operationIndex) => ({
						...entry,
						operationCount: count,
						operationIndex,
					})),
					vertexDigest: result.sourceDigest,
				},
			});
		}
	});

	it("enumerates two genuine source rows in author-sequence order without re-deriving the first", async () => {
		const twoRows = await runSharedPlaneScenario({ twoSourceRows: true });
		expect(twoRows.recovery).toMatchObject({ ok: true });
		expect(twoRows.rebaseOutboxes).toEqual([
			{
				kind: "displaced",
				ok: true,
				source: expect.objectContaining({
					author: twoRows.sourceRowAuthor,
					authorSequence: 1,
					vertexDigest: twoRows.sourceDigests[0],
				}),
			},
			{
				kind: "displaced",
				ok: true,
				source: expect.objectContaining({
					author: twoRows.sourceRowAuthor,
					authorSequence: 2,
					vertexDigest: twoRows.sourceDigests[1],
				}),
			},
		]);
		expect(twoRows.completion).toEqual({ kind: "published", ok: true });
		expect(twoRows.networkPublishedDigests).toEqual([twoRows.targetDigest]);
		expect(twoRows.outbox.map(({ authorSequence, publishState }) => ({ authorSequence, publishState }))).toEqual([
			{ authorSequence: 0, publishState: "published" },
			{ authorSequence: 1, publishState: "published" },
			{ authorSequence: 2, publishState: "pending" },
			{ authorSequence: 3, publishState: "published" },
		]);
	});

	it("rejects signed malformed, nested, mixed-control and over-limit prior batches", async () => {
		for (const sourceOperationProfile of [
			"malformed-batch",
			"nested-batch",
			"mixed-control-batch",
			"over-limit-batch",
		] as const) {
			const result = await runSharedPlaneScenario({ sourceOperationProfile });
			expect(result.sourceIssue).toEqual({ kind: "hostile-stored", ok: true });
			expect(result.recovery).toMatchObject({ ok: false });
			expect(result.rebaseOutbox).toBeUndefined();
			expect(result.networkPublishedDigests).toEqual([]);
		}
	});

	it("never treats missing or creator-signature-corrupt source authority as displacement", async () => {
		for (const options of [{ omitSourceAuthority: true }, { sourceCreatorSignatureCorrupt: true }] as const) {
			const result = await runSharedPlaneScenario(options);
			expect(result.sourceAuthorityPrepared).toBe(false);
			expect(result.recovery).toMatchObject({ ok: false });
			expect(result.rebaseOutbox).toBeUndefined();
			expect(result.networkPublishedDigests).toEqual([]);
			expect(result.outbox.find(({ authorSequence }) => authorSequence === 1)?.publishState).toBe("pending");
		}
		const noCurrentTarget = await runSharedPlaneScenario({ omitTargetBootstrap: true });
		expect(noCurrentTarget.recovery).toMatchObject({ ok: false });
		expect(noCurrentTarget.targetDigest).toBeUndefined();
		expect(noCurrentTarget.networkPublishedDigests).toEqual([]);
	});

	it("rejects mixed source authorization bytes and a target-capability substitution", async () => {
		for (const sourceAuthorityMutation of [
			"acl-context",
			"authorization-bytes",
			"blueprint-context",
			"creator-context",
			"object-context",
			"target-capability",
		] as const) {
			const result = await runSharedPlaneScenario({ sourceAuthorityMutation });
			expect(result.sourceAuthorityPrepared).toBe(true);
			expect(result.recovery).toMatchObject({ ok: false });
			expect(result.rebaseOutbox).toBeUndefined();
			expect(result.outbox.find(({ authorSequence }) => authorSequence === 1)?.publishState).toBe("pending");
			if (sourceAuthorityMutation === "creator-context") {
				expect(result.sourceContextAuthor).not.toBe(result.sourceRowAuthor);
				expect(result.sourceRowAuthor).toBe(result.targetAuthor);
			}
		}
	});

	it("rejects target authorization bytes and a source-capability substitution", async () => {
		for (const targetAuthorityMutation of ["authorization-bytes", "source-capability"] as const) {
			const result = await runSharedPlaneScenario({ targetAuthorityMutation });
			expect(result.recovery).toMatchObject({ ok: false });
			expect(result.rebaseOutbox).toBeUndefined();
			expect(result.networkPublishedDigests).toEqual([]);
			expect(result.outbox.find(({ authorSequence }) => authorSequence === 1)?.publishState).toBe("pending");
		}
	});

	it("reopens the target against the same lineage without issuing a duplicate target bootstrap", async () => {
		const result = await runSharedPlaneScenario({ reopenTarget: true });
		expect(result.recovery).toMatchObject({ ok: true });
		expect(result.reopenRecovery).toMatchObject({ ok: true });
		expect(result.outbox.map(({ authorSequence }) => authorSequence)).toEqual([0, 1, 2]);
		expect(result.outbox.filter(({ digest }) => digest === result.targetDigest)).toHaveLength(1);
	});

	it("recovers a pending target replacement committed after recovery without allocating a duplicate", async () => {
		const result = await runSharedPlaneScenario({ targetReplacementAfterRecoveryBeforeRead: true });
		expect(result.recovery).toMatchObject({ ok: true });
		expect(result.reopenRecovery).toMatchObject({ ok: true });
		expect(result.targetReplacementLogicalTime).toBe(7);
		expect(result.rebaseOutbox).toEqual({
			kind: "displaced",
			ok: true,
			source: {
				author: result.sourceRowAuthor,
				authorSequence: 1,
				intents: [],
				vertexDigest: result.sourceDigest,
			},
		});
		expect(result.completion).toEqual({ kind: "published", ok: true });
		expect(result.lineageNext).toBe(4);
		expect(result.outbox.filter(({ digest }) => digest === result.targetReplacementDigest)).toHaveLength(1);
		expect(result.outbox.find(({ digest }) => digest === result.sourceDigest)?.publishState).toBe("published");
	});
});
