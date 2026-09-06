import { describe, expect, it } from "vitest";

import { runDependencyBoundScenario, runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import {
	batchEntry,
	byteBoundaryEntries,
	itemBoundaryEntries,
	maximalEntries,
} from "./fixtures/phase-3f-c/application-batching-fixture.js";

describe("Phase 3f-c node-owned application batching RED", () => {
	it("issues two captured operations as one genuine signed applicationBatch vertex", async () => {
		const operations = Object.freeze([
			batchEntry(18, Object.freeze({ action: "add", value: 2 })),
			batchEntry(19, Object.freeze({ action: "set", value: 9 })),
		]);
		const result = await runFrontierScenario(1, { operations });
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.signerCalls).toBe(1);
		expect(result.journalAppends).toBe(1);
		expect(result.admittedDigests).toHaveLength(1);
		expect(result.issued).toHaveLength(1);
		expect(result.issued[0]).toMatchObject({
			logicalTime: 18,
			operation: {
				action: "applicationBatch",
				batch: { entries: operations, version: 1 },
			},
		});
		expect(result.issued[0]?.dependencies).toEqual(result.initialTips);
	});

	it("uses one signer, sequence, journal row, and admitted vertex for sixteen children", async () => {
		const operations = maximalEntries("counter");
		const result = await runFrontierScenario(1, { operations });
		expect(result.result).toMatchObject({ ok: true, kind: "accepted", authorSequence: 1 });
		expect(result).toMatchObject({ signerCalls: 1, journalAppends: 1 });
		expect(result.issued).toHaveLength(1);
		expect(result.admittedDigests).toEqual([result.issued[0]?.digest]);
		expect(Reflect.get(Reflect.get(result.issued[0]?.operation, "batch"), "entries")).toEqual(operations);
	});

	it("reduces a wide frontier before issuing exactly one application batch", async () => {
		const operations = Object.freeze([
			batchEntry(18, { action: "add", value: 1 }),
			batchEntry(19, { action: "set", value: 2 }),
		]);
		const result = await runFrontierScenario(17, { operations });
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.issued.map(({ operation }) => Reflect.get(operation, "action"))).toEqual([
			"causalJoin",
			"applicationBatch",
		]);
		expect(result).toMatchObject({ signerCalls: 2, journalAppends: 2 });
		expect(result.issued[1]?.dependencies).toEqual([result.initialTips.at(-1), result.issued[0]?.digest].sort());
	});

	it("returns an exact entry-count split before signing seventeen application operations", async () => {
		const result = await runFrontierScenario(1, { operations: maximalEntries("counter", 17) });
		expect(result.result).toEqual({
			detail: expect.any(String),
			kind: "split-required",
			ok: false,
			prefixLength: 16,
		});
		expect(result).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		expect(result.issued).toHaveLength(0);
	});

	it("uses the genuine node preflight for the exact byte ceiling and one-byte-over split", async () => {
		const exact = await runFrontierScenario(1, {
			batchBoundaryProfile: true,
			operations: byteBoundaryEntries(false),
			seedOperation: Object.freeze({ action: "payload", text: "seed" }),
		});
		expect(exact.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(exact).toMatchObject({ signerCalls: 1, journalAppends: 1 });
		const over = await runFrontierScenario(1, {
			batchBoundaryProfile: true,
			operations: byteBoundaryEntries(true),
			seedOperation: Object.freeze({ action: "payload", text: "seed" }),
		});
		expect(over.result).toMatchObject({ ok: false, kind: "split-required", prefixLength: 1 });
		expect(over).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		expect(over.issued).toHaveLength(0);
	});

	it("uses the genuine node preflight for the exact item ceiling and one-item-over rejection", async () => {
		const exact = await runFrontierScenario(1, {
			batchBoundaryProfile: true,
			operations: itemBoundaryEntries(false),
			seedOperation: Object.freeze({ action: "payload", text: "seed" }),
		});
		expect(exact.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(exact).toMatchObject({ signerCalls: 1, journalAppends: 1 });
		const over = await runFrontierScenario(1, {
			batchBoundaryProfile: true,
			operations: itemBoundaryEntries(true),
			seedOperation: Object.freeze({ action: "payload", text: "seed" }),
		});
		expect(over.result).toEqual({
			detail: expect.any(String),
			kind: "split-required",
			ok: false,
			prefixLength: 1,
		});
		expect(over).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		expect(over.issued).toHaveLength(0);
	});

	it("rejects structural, aliased, reserved, unknown, depth, and item-budget inputs before signing", async () => {
		const callerBatch = await runFrontierScenario(1, {
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						batchEntry(2, { action: "add", value: 1 }),
						batchEntry(3, { action: "set", value: 2 }),
					]),
					version: 1,
				}),
			}),
		});
		expect(callerBatch.result.ok).toBe(false);
		expect(callerBatch).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		expect(callerBatch.issued).toHaveLength(0);

		const deep: Record<string, unknown> = { action: "add", value: 1 };
		let cursor = deep;
		for (let depth = 0; depth < 9; depth += 1) {
			const next: Record<string, unknown> = {};
			cursor.child = next;
			cursor = next;
		}
		const sharedOperation = Object.freeze({ action: "add", value: 1 });
		const accessorOperation = {} as Record<string, unknown>;
		Object.defineProperty(accessorOperation, "action", { enumerable: true, get: () => "add" });
		const symbolOperation = { action: "add", value: 1 } as Record<PropertyKey, unknown>;
		symbolOperation[Symbol("hidden")] = true;
		const sparse = new Array(2) as Array<
			Readonly<{ logicalTime: number; operation: Readonly<Record<string, unknown>> }>
		>;
		sparse[0] = Object.freeze({ logicalTime: 2, operation: sharedOperation });
		const cases: readonly unknown[] = [
			Object.freeze([batchEntry(2, { action: "add", value: 1 }), batchEntry(2, { action: "set", value: 2 })]),
			Object.freeze([batchEntry(2, { action: "add", value: 1 }), batchEntry(3, { action: "acl" })]),
			Object.freeze([batchEntry(2, { action: "add", value: 1 }), batchEntry(3, { action: "join" })]),
			Object.freeze([batchEntry(2, { action: "add", value: 1 }), batchEntry(3, { action: "causalJoin" })]),
			Object.freeze([
				batchEntry(2, { action: "add", value: 1 }),
				batchEntry(3, { action: "applicationBatch", batch: { entries: [], version: 1 } }),
			]),
			Object.freeze([batchEntry(2, { action: "add", value: 1 }), batchEntry(3, { action: "unknown" })]),
			Object.freeze([
				Object.freeze({ logicalTime: 2, operation: Object.freeze(deep) }),
				batchEntry(3, { action: "add", value: 2 }),
			]),
			Object.freeze([
				Object.freeze({ logicalTime: 2, operation: sharedOperation }),
				Object.freeze({ logicalTime: 3, operation: sharedOperation }),
			]),
			sparse,
			Object.freeze([
				Object.freeze({ extra: true, logicalTime: 2, operation: sharedOperation }),
				Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 2 }) }),
			]),
			Object.freeze([
				Object.freeze({ logicalTime: 2, operation: accessorOperation }),
				Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 2 }) }),
			]),
			Object.freeze([
				Object.freeze({ logicalTime: 2, operation: symbolOperation }),
				Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 2 }) }),
			]),
			Object.freeze([
				Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", text: "\ud800" }) }),
				Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 2 }) }),
			]),
		];
		for (const operations of cases) {
			const result = await runFrontierScenario(1, { operations: operations as never });
			expect(result.result.ok).toBe(false);
			expect(result.signerCalls).toBe(0);
			expect(result.journalAppends).toBe(0);
			expect(result.issued).toHaveLength(0);
		}
	});

	it("keeps signer, authentication, and journal failures batch-owned and retryable", async () => {
		const operations = Object.freeze([
			batchEntry(2, { action: "add", value: 1 }),
			batchEntry(3, { action: "set", value: 2 }),
		]);
		const signer = await runFrontierScenario(1, { failSignerAtIssuedOrdinal: 0, operations, retryAfterFailure: true });
		expect(signer.result).toMatchObject({ ok: false, kind: "issuance-rejected" });
		expect(signer.retryResult).toMatchObject({ ok: true, kind: "accepted" });
		expect(signer.issued).toHaveLength(1);
		const transaction = await runFrontierScenario(1, { failTransactionAtIssuedOrdinal: 0, operations });
		expect(transaction.result).toMatchObject({ ok: false, kind: "issuance-rejected" });
		expect(transaction).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		expect(transaction.issued).toHaveLength(0);
		const wrongSignature = await runFrontierScenario(1, { operations, wrongSignatureAtIssuedOrdinal: 0 });
		expect(wrongSignature.result).toMatchObject({ ok: false, kind: "admission-rejected" });
		expect(wrongSignature.journalAppends).toBe(0);
		const journal = await runFrontierScenario(1, { failJournalAtIssuedOrdinal: 0, operations });
		expect(journal.result).toMatchObject({ ok: false, kind: "journal-rejected" });
		expect(journal.admittedDigests).toHaveLength(0);
	});

	it("serializes signer reentry into the next snapshot instead of the active batch", async () => {
		const result = await runFrontierScenario(1, {
			operations: Object.freeze([
				batchEntry(2, { action: "add", value: 1 }),
				batchEntry(3, { action: "set", value: 2 }),
			]),
			reenterFromSigner: true,
		});
		expect(result.synchronousReentry).toBe(false);
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.nestedResult).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.issued.map(({ operation }) => operation)).toEqual([
			{
				action: "applicationBatch",
				batch: {
					entries: [
						{ logicalTime: 2, operation: { action: "add", value: 1 } },
						{ logicalTime: 3, operation: { action: "set", value: 2 } },
					],
					version: 1,
				},
			},
			{ action: "add", value: 9 },
		]);
	});

	it("contains malformed recovered and received batches without publishing a valid prefix", async () => {
		const validEntry = Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 1 }) });
		const nested = Object.freeze({
			action: "applicationBatch",
			batch: Object.freeze({
				entries: Object.freeze([
					validEntry,
					Object.freeze({
						logicalTime: 3,
						operation: Object.freeze({ action: "applicationBatch", batch: { entries: [], version: 1 } }),
					}),
				]),
				version: 1,
			}),
		});
		const malformedBatches = [
			nested,
			Object.freeze({ action: "applicationBatch", batch: Object.freeze({ entries: [], version: 1 }) }),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: Object.freeze([validEntry, { ...validEntry }]), version: 1 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: Object.freeze([validEntry, { ...validEntry, logicalTime: 3 }]), version: 2 }),
			}),
			Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						validEntry,
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "causalJoin" }) }),
					]),
					version: 1,
				}),
			}),
		] as const;
		for (const malformedBatch of malformedBatches) {
			const recovered = await runDependencyBoundScenario(1, "recovered-local", malformedBatch);
			expect(recovered.result).toMatchObject({ ok: true, descriptor: { recoveredVertexCount: 2 } });
		}
		const recoveredReceived = await runDependencyBoundScenario(1, "recovered-received", nested);
		expect(recoveredReceived.result).toMatchObject({ ok: true, descriptor: { recoveredVertexCount: 2 } });
		const transitive = await runDependencyBoundScenario(
			1,
			"recovered-local",
			nested,
			Object.freeze({ action: "add", value: 9 })
		);
		expect(transitive.result).toMatchObject({ ok: true, descriptor: { recoveredVertexCount: 2 } });
		const live = await runDependencyBoundScenario(1, "live-received", nested);
		expect(live.result).toMatchObject({ ok: true, kind: "routed" });
		expect(live).toMatchObject({ appendedCount: 1, sinkCount: 0 });
	});
});
