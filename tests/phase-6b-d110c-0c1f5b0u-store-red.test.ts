import "fake-indexeddb/auto";

import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runNativeHistoricalReplacement } from "./fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.js";
import {
	code,
	commit,
	failure,
	legacyEntry,
	plan,
	progress,
	PROGRESS_SCOPE,
	progressEffect,
	progressEntry,
	snapshot,
} from "./fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.js";
import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

async function withStore(
	kind: "browser" | "memory" | "node",
	run: (store: DurableIssuanceStore) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0u-store-"));
	const store =
		kind === "memory"
			? createEphemeralDurableIssuanceStore()
			: kind === "browser"
				? await createBrowserDurableIssuanceStore({ primaryDatabaseName: directory })
				: createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	try {
		await run(store);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function selectedCommit(sequence: number, operation: unknown, logicalTime = 7): never {
	const prior = commit(sequence, progressEffect(0, 2), logicalTime, 2);
	const envelope = Object.freeze({
		...(prior.envelope as object),
		canonicalPreimageBytes: encodeCanonical({
			author: PROGRESS_SCOPE.author,
			authorSequence: sequence,
			epoch: 0,
			kind: "drp-vertex",
			logicalTime,
			objectId: PROGRESS_SCOPE.objectId,
			operation,
			protocolMajor: 3,
		}),
	});
	return Object.freeze({
		...prior,
		envelope,
		issuedRecord: { authorSequence: sequence, envelope, scope: PROGRESS_SCOPE },
		outboxEntry: { authorSequence: sequence, envelope, scope: PROGRESS_SCOPE },
	}) as never;
}

function batch(times: readonly number[]): unknown {
	return {
		action: "applicationBatch",
		batch: {
			entries: times.map((logicalTime) => ({ logicalTime, operation: { action: "add", value: 1 } })),
			version: 1,
		},
	};
}

describe("D.110c-0c1f5b0u exact store logical-time owner", () => {
	it("pins a real Node-assembled sixteen-entry progress chunk to its final child logical time", async () => {
		// Since ea4eb158 Node assembles a replacement only through its owning displaced
		// source, so the sixteen-entry chunk comes from the genuine historical
		// replacement (a real close and cold adoption, then source.issueReplacement).
		const result = await runNativeHistoricalReplacement(false, false, false, false, false, false, false, false, 16);
		expect(result.replacement, JSON.stringify(result)).toMatchObject({ ok: true });
		const chunk = result.progressChunk as {
			effect: never;
			operations: readonly { logicalTime: number }[];
			planBefore: never;
			planAfter: unknown;
			row: DurableIssueCommit;
			history: readonly DurableIssueCommit[];
		};
		expect(chunk.operations).toHaveLength(16);
		const last = (chunk.operations.at(-1) as { logicalTime: number }).logicalTime;
		const pinned = { entries: [{ replacementProgress: { chunks: [{ lastLogicalTime: last, throughIntent: 16 }] } }] };
		expect(snapshot(chunk.planAfter as never), "D110C_0C1F5B0U_NODE_STORE_PINS_FINAL_CHILD").toMatchObject(pinned);
		const scope = chunk.row.issuedRecord.scope;
		const realStore = createEphemeralDurableIssuanceStore();
		try {
			for (const row of chunk.history)
				await realStore.transactIssue(scope, (sequence) => {
					expect(sequence).toBe(row.authorSequence);
					return Promise.resolve(row);
				});
			// A first write carries revision 0; the plan content is the exact pre-chunk native plan.
			await realStore.transactWriteSettlementPlan({
				expectedRevision: null,
				plan: { ...(chunk.planBefore as object), revision: 0 } as never,
				scope,
			});
			await realStore.transactIssue(scope, (sequence) => {
				expect(sequence).toBe(chunk.row.authorSequence);
				return Promise.resolve({ ...chunk.row, planEffect: chunk.effect });
			});
			// The memory store keeps the transaction instruction on its row; the signed bytes are the native ones.
			expect(await realStore.readIssued(scope, chunk.row.authorSequence)).toEqual({ ...chunk.row, planEffect: chunk.effect });
			expect(snapshot(await realStore.readSettlementPlan(scope)), "D110C_0C1F5B0U_REPLAYED_STORE_PINS_FINAL_CHILD").toMatchObject(
				pinned
			);
		} finally {
			await realStore.close();
		}
	}, 120_000);
	it.each(["entries", "batch.entries"] as const)(
		"ordinary %s fields do not impersonate an application batch",
		async (field) => {
			await withStore("memory", async (store) => {
				await store.transactWriteSettlementPlan({
					expectedRevision: null,
					plan: plan() as never,
					scope: PROGRESS_SCOPE,
				});
				const entries = [{ logicalTime: 1000, operation: { action: "add", value: 1 } }];
				const operation = { action: "add", value: 1, ...(field === "entries" ? { entries } : { batch: { entries } }) };
				await store.transactIssue(PROGRESS_SCOPE, (sequence) => Promise.resolve(selectedCommit(sequence, operation)));
				expect(
					snapshot(await store.readSettlementPlan(PROGRESS_SCOPE)),
					"D110C_0C1F5B0U_ORDINARY_FIELD_FLOOR_COLLISION"
				).toMatchObject({ entries: [{ replacementProgress: { chunks: [{ lastLogicalTime: 7 }] } }] });
			});
		}
	);
	it("genuine nested applicationBatch derives the final child rather than outer time", async () => {
		await withStore("memory", async (store) => {
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan() as never, scope: PROGRESS_SCOPE });
			await store.transactIssue(PROGRESS_SCOPE, (sequence) => Promise.resolve(selectedCommit(sequence, batch([7, 9]))));
			expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
				entries: [{ replacementProgress: { chunks: [{ lastLogicalTime: 9 }] } }],
			});
		});
	});
	it.each([
		["negative", [-1, 9]],
		["non-integer", [7.5, 9]],
		["duplicate", [9, 9]],
		["regressed", [10, 9]],
	] as const)("rejects %s child time without publishing a durable chunk", async (_name, times) => {
		await withStore("memory", async (store) => {
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan() as never, scope: PROGRESS_SCOPE });
			const before = snapshot(await store.readSettlementPlan(PROGRESS_SCOPE));
			const rejected = await failure(
				store.transactIssue(PROGRESS_SCOPE, (sequence) => Promise.resolve(selectedCommit(sequence, batch(times))))
			);
			expect.soft(code(rejected), "D110C_0C1F5B0U_INVALID_CHILD_TIME_ACCEPTED").toBe("ISSUANCE_COMMIT_INVALID");
			expect.soft(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toEqual(before);
			expect.soft(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 0 });
			expect.soft(await store.readIssued(PROGRESS_SCOPE, 0)).toBeNull();
		});
	});
	it("refuses a structurally batch-shaped carrier beyond the canonical operation ceiling", async () => {
		await withStore("memory", async (store) => {
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan() as never, scope: PROGRESS_SCOPE });
			const operation = {
				action: "applicationBatch",
				batch: {
					entries: [
						{ logicalTime: 7, operation: { action: "add", payload: "x".repeat(65_536) } },
						{ logicalTime: 9, operation: { action: "add", value: 1 } },
					],
					version: 1,
				},
			};
			const before = snapshot(await store.readSettlementPlan(PROGRESS_SCOPE));
			const rejected = await failure(
				store.transactIssue(PROGRESS_SCOPE, (sequence) => Promise.resolve(selectedCommit(sequence, operation)))
			);
			expect.soft(code(rejected), "D110C_0C1F5B0U_BATCH_CEILING_BYPASSED").toBe("ISSUANCE_COMMIT_INVALID");
			expect.soft(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toEqual(before);
			expect.soft(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 0 });
		});
	});
});

describe("D.110c-0c1f5b0u zero-chunk origination ownership", () => {
	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a nonempty legacy CAS while retaining empty upgrade and atomic append",
		async (kind) => {
			await withStore(kind, async (store) => {
				const legacy = plan(legacyEntry());
				await store.transactWriteSettlementPlan({
					expectedRevision: null,
					plan: legacy as never,
					scope: PROGRESS_SCOPE,
				});
				const forged = plan(
					progressEntry(progress(3, [{ lastLogicalTime: 9, replacementSequence: 0, throughIntent: 2 }])),
					1
				);
				const rejected = await failure(
					store.transactWriteSettlementPlan({ expectedRevision: 0, plan: forged as never, scope: PROGRESS_SCOPE })
				);
				expect
					.soft(code(rejected), "D110C_0C1F5B0U_NONEMPTY_PROGRESS_ORIGINATED_BY_CAS")
					.toBe("ISSUANCE_RETRY_REQUIRED");
				expect.soft(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toEqual(snapshot(legacy));
				expect.soft(await store.readIssued(PROGRESS_SCOPE, 0)).toBeNull();
				expect.soft(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 0 });
			});
			await withStore(kind, async (store) => {
				await store.transactWriteSettlementPlan({
					expectedRevision: null,
					plan: plan(legacyEntry()) as never,
					scope: PROGRESS_SCOPE,
				});
				await store.transactWriteSettlementPlan({
					expectedRevision: 0,
					plan: plan(progressEntry(), 1) as never,
					scope: PROGRESS_SCOPE,
				});
				await store.transactIssue(PROGRESS_SCOPE, (sequence) =>
					Promise.resolve(selectedCommit(sequence, batch([7, 9])))
				);
				expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
					revision: 2,
					entries: [
						{ replacementProgress: { chunks: [{ lastLogicalTime: 9, replacementSequence: 0, throughIntent: 2 }] } },
					],
				});
			});
		}
	);
});
