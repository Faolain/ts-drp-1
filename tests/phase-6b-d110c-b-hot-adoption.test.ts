import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import {
	D110C_B_HOT_ADOPTION_COMPLETE,
	openD110cBHotAdoptionFixture,
	runD110cBPostTransferMutants,
} from "./fixtures/phase-6b-d110c-b/hot-adoption-contract.js";

describe("D.110c-b general hot adoption GREEN", () => {
	it("advances the genuine epoch-one close to one exact epoch-two active owner", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openD110cBHotAdoptionFixture();
		try {
			const evidence = fixture.evidence;
			expect(evidence.diagnostic).toBe(D110C_B_HOT_ADOPTION_COMPLETE);
			expect(evidence.verification).toMatchObject({ descriptor: { epoch: 2 }, ok: true });
			expect(evidence.commit).toMatchObject({
				descriptor: { epoch: 2 },
				lifecycle: "successor-prepared",
				ok: true,
				recovery: "active-new",
			});
			expect(evidence.duplicateCommit).toMatchObject({
				descriptor: { epoch: 2 },
				ok: true,
				recovery: "active-new",
			});
			expect(evidence.activation).toMatchObject({
				handle: { epoch: 2 },
				lifecycle: "active",
				ok: true,
				recovery: "active-new",
				trust: { currentEpoch: 2 },
			});
			expect(evidence.duplicateActivation).toMatchObject({ lifecycle: "active", ok: true });
			expect(evidence.duplicateHandleIdentity).toBe(true);
			expect(evidence.activeAuthority).toMatchObject({ epoch: 2 });
			expect(evidence.mutants).toMatchObject({
				aheadFloor: { kind: "D110C_FLOOR_MISMATCH", ok: false },
				crossGenesis: { kind: "chain-invalid", ok: false },
				crossObject: { kind: "chain-invalid", ok: false },
				differentBindings: { kind: "authority-unavailable", ok: false },
				laggingFloor: { kind: "D110C_FLOOR_MISMATCH", ok: false },
				malformedFloor: { kind: "D110C_FLOOR_INVALID", ok: false },
				missingHotInput: { kind: "malformed-input", ok: false },
				nonExactSuccessor: { kind: "chain-invalid", ok: false },
				preTransferRefusal: { kind: "preparation-rejected", ok: false },
				sameEpochDifferentAnchor: { kind: "chain-invalid", ok: false },
				skippedPredecessor: { kind: "chain-invalid", ok: false },
				stalePredecessor: { kind: "stale-head", ok: false },
				substitutedFloor: { kind: "D110C_FLOOR_MISMATCH", ok: false },
			});
			expect(evidence.oldIssue).toEqual({
				detail: "v3 plane is not accepting local issues",
				kind: "not-active",
				ok: false,
			});
			expect(evidence.issued).toMatchObject({ kind: "accepted", ok: true });
			expect(evidence.published).toEqual({ kind: "published", ok: true });
			expect(evidence.closeEpoch).toBe(1);
			expect(evidence.successorEpoch).toBe(2);
			expect(evidence.durableHeadAfterVerification).not.toEqual(evidence.durableHeadBeforeVerification);
			const postTransfer = await runD110cBPostTransferMutants();
			expect(postTransfer.terminalize).toEqual({
				oldIssue: {
					detail: "v3 plane is not accepting local issues",
					kind: "not-active",
					ok: false,
				},
				result: {
					detail: "creator predecessor could not be terminalized",
					kind: "source-unavailable",
					ok: false,
				},
			});
			expect(postTransfer.retirement).toEqual({
				oldIssue: {
					detail: "v3 plane is not accepting local issues",
					kind: "not-active",
					ok: false,
				},
				result: {
					detail: "creator successor active ownership changed during replacement",
					kind: "authority-unavailable",
					ok: false,
				},
			});
			process.stdout.write(`${D110C_B_HOT_ADOPTION_COMPLETE}\n`);
		} finally {
			await fixture.close();
		}
	});
});
