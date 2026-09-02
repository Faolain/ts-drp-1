import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { openD110cARepeatCloseRedFixture } from "./fixtures/phase-6b-d110c-a/repeat-close-contract.js";

describe("D.110c-a authenticated repeat-close carrier RED", () => {
	it("fails the genuine adopted epoch-one close only at the empty previous-history carrier", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		const fixture = await openD110cARepeatCloseRedFixture();
		try {
			const evidence = fixture.evidence;
			expect(evidence.issued).toMatchObject({ kind: "accepted", ok: true });
			expect(evidence.published).toEqual({ kind: "published", ok: true });
			expect(evidence.closeAttempts).toBe(1);
			expect(evidence.closeResult).toBeUndefined();
			expect(evidence.closeError).toEqual({
				code: "INVALID_ANCHOR",
				message: "previous history snapshot does not match the authenticated anchor",
				name: "LinearizationError",
			});
			expect(evidence.beforeHead).toEqual(evidence.afterHead);
			expect(evidence.actorStatusBeforeClose).toMatchObject({
				closeAuthority: "available",
				continuity: "continuous",
				lifecycle: "active",
			});
			expect(evidence.actorStatusAfterFailure).toMatchObject({
				closeAuthority: "available",
				continuity: "continuous",
				lifecycle: "sealed",
			});
			expect(evidence.adoptionProbe).toMatchObject({ kind: "sealed-live-unavailable", ok: false });
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
