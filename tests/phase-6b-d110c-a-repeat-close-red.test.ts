import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import {
	D110C_A_HOSTILE_CARRIERS,
	openD110cARepeatCloseFixture,
} from "./fixtures/phase-6b-d110c-a/repeat-close-contract.js";

describe("D.110c-a authenticated repeat-close carrier RED", () => {
	it("extends authenticated compact history through one genuine adopted epoch-one close", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openD110cARepeatCloseFixture();
		try {
			const evidence = fixture.evidence;
			if (process.env.D110C_A_RECORD_EVIDENCE === "1") {
				process.stdout.write(
					`D110C_A_GREEN_EVIDENCE=${JSON.stringify({
						afterReferenceCount: evidence.afterHead.references.length,
						beforeReferenceCount: evidence.beforeHead.references.length,
						closeOrder: evidence.independentHistory.closeOrder,
						closureBytes: evidence.closureBytes,
						epoch: evidence.closeResult.epoch,
						historyRoot: evidence.independentHistory.historyRoot,
						historySize: evidence.independentHistory.historySize,
						previousHistoryRoot: evidence.independentHistory.previousRoot,
						previousHistorySize: evidence.independentHistory.previous.size,
						successorEpoch: evidence.closeResult.successorEpoch,
					})}\n`
				);
			}
			expect(evidence.issued).toMatchObject({ kind: "accepted", ok: true });
			expect(evidence.published).toEqual({ kind: "published", ok: true });
			expect(evidence.hostileCarrierRefusals).toHaveLength(D110C_A_HOSTILE_CARRIERS.length);
			expect(evidence.hostileCarrierRefusals.map(({ carrier }) => carrier)).toEqual(D110C_A_HOSTILE_CARRIERS);
			for (const refusal of evidence.hostileCarrierRefusals) {
				expect(refusal).toEqual({
					carrier: refusal.carrier,
					durableHeadUnchanged: true,
					reason: "CREATOR_CLOSE_UNAVAILABLE",
					roomHeadUnchanged: true,
				});
			}
			expect(evidence.overflowRefusal).toBe("CREATOR_CLOSE_UNAVAILABLE");
			expect(evidence.closeAttempts).toBe(1);
			expect(evidence.closeResult).toMatchObject({
				closedVertexCount: evidence.independentHistory.closeOrder.length,
				epoch: 1,
				lifecycle: "successor-pending-adoption",
				ok: true,
				successorEpoch: 2,
			});
			expect(evidence.afterHead.head.revision).toBe(evidence.beforeHead.head.revision + 1);
			expect(evidence.afterHead.head).not.toEqual(evidence.beforeHead.head);
			for (const reference of [
				evidence.closeResult.commitQcRef,
				evidence.closeResult.cutValueRef,
				evidence.closeResult.successorTrustRef,
			]) {
				expect(evidence.afterHead.references).toContainEqual(reference);
			}
			expect(evidence.cutValue).toMatchObject({
				epoch: 1,
				historyRoot: evidence.independentHistory.historyRoot,
				historySize: evidence.independentHistory.historySize,
				previousHistoryRoot: evidence.independentHistory.previousRoot,
				previousHistorySize: evidence.independentHistory.previous.size,
			});
			expect(evidence.previousHistoryAfter).toEqual(evidence.independentHistory.previous);
			expect(evidence.previousHistoryAfter).not.toBe(evidence.independentHistory.previous);
			expect(evidence.afterHead.references).toHaveLength(evidence.beforeHead.references.length - 1);
			expect(evidence.closureBytes.delta).toBe(-318);
			expect(evidence.duplicateCloseErrors).toEqual({
				concurrent: "creator close authority is unavailable",
				sequential: "creator close authority is unavailable",
			});
			expect(evidence.rebindReturnedSameHandle).toBe(true);
			expect(evidence.stalePredecessorError).toBe("creator close authority is unavailable");
			expect(evidence.actorStatusBeforeClose).toMatchObject({
				closeAuthority: "available",
				continuity: "continuous",
				lifecycle: "active",
			});
			expect(evidence.actorStatusAfterClose).toMatchObject({
				closeAuthority: "unavailable",
				continuity: "continuous",
				lifecycle: "successor-pending-adoption",
			});
			expect(evidence.roomHeadBefore).toMatchObject({ epoch: 1 });
			expect(evidence.roomHeadAfter).toEqual(evidence.roomHeadBefore);
			expect(evidence.providerPresent).toBe(false);
			expect(evidence.replacementActivationCalls).toBe(0);
			expect(evidence.runtimeIdentity.creatorCloseSourceUrl).toMatch(/packages\/node\/src\/creator-close\.ts$/u);
			expect(evidence.runtimeIdentity.storageNodeBuiltUrl).toMatch(/packages\/storage-node\/dist\/src\/index\.js$/u);
			expect(evidence.runtimeIdentity.node).toBe(process.version);
		} finally {
			await fixture.close();
		}
	});
});
