import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import {
	D110C_B_EPOCH_PINNED_PREDECESSOR,
	openD110cBHotAdoptionFixture,
} from "./fixtures/phase-6b-d110c-b/hot-adoption-contract.js";

describe("D.110c-b general hot adoption RED", () => {
	it("rejects the genuine epoch-one close at the epoch-pinned predecessor selector", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openD110cBHotAdoptionFixture();
		try {
			const evidence = fixture.evidence;
			expect(evidence.diagnostic).toBe(D110C_B_EPOCH_PINNED_PREDECESSOR);
			expect(evidence.issued).toMatchObject({ kind: "accepted", ok: true });
			expect(evidence.published).toEqual({ kind: "published", ok: true });
			expect(evidence.closeEpoch).toBe(1);
			expect(evidence.successorEpoch).toBe(2);
			expect(evidence.verification).toEqual({
				detail: "creator successor trust chain is invalid",
				kind: "chain-invalid",
				ok: false,
			});
			expect(evidence.durableHeadAfterVerification).toEqual(evidence.durableHeadBeforeVerification);
			process.stdout.write(`${D110C_B_EPOCH_PINNED_PREDECESSOR}\n`);
		} finally {
			await fixture.close();
		}
	});
});
