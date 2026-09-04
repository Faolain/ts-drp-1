import "fake-indexeddb/auto";

import { beforeAll, describe, expect, it } from "vitest";

import {
	encodedAclBoundary,
	stageOpenBoundary,
	W0_LEGACY_ACL_MAX_CANONICAL_BYTES,
} from "./fixtures/phase-6b-d110c-0c1k/w0-contract.js";
import {
	exerciseAcceptedAclLifecycle,
	exerciseAuthorShareRuntime,
	exerciseCreatorCloseOversize,
	rejectedAclLifecycle,
	W0_AUTHOR_SHARE,
	W0_FRONTIERS_CEILING,
	W0_FRONTIERS_KIND,
	W0_MAX_EPOCH_VERTICES,
} from "./fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.110c-0c1k W0 real lifecycle and capacity RED", () => {
	it("stages, opens, recovers, closes, and adopts a genuine 31-member full legacy ACL", async () => {
		const lifecycle = await exerciseAcceptedAclLifecycle(31).then(
			(value) => value,
			(error: unknown) => (error instanceof Error ? error.message : String(error))
		);
		expect(encodedAclBoundary(31)).toEqual({ byteLength: 6_297, fitsLegacyCeiling: true });
		expect(W0_LEGACY_ACL_MAX_CANONICAL_BYTES).toBe(8_192);
		expect.soft(stageOpenBoundary(31), "stage/open parity").toEqual({ openOk: true, stageOk: true });
		expect(lifecycle).toEqual({
			closeCount: 2,
			committedRecovery: "active-new",
		});
	});

	for (const [memberCount, byteLength, authority] of [
		[64, 12_864, "legacy byte ceiling"],
		[65, 13_063, "legacy cardinality"],
	] as const) {
		it(`rejects ${memberCount} full members consistently by ${authority}`, async () => {
			const rejected = await rejectedAclLifecycle(memberCount);
			expect(encodedAclBoundary(memberCount)).toEqual({ byteLength, fitsLegacyCeiling: false });
			expect.soft(stageOpenBoundary(memberCount), "stage/open parity").toEqual({ openOk: false, stageOk: false });
			expect(rejected).toMatch(
				/(?:live preparation failed: invalid-input|durable recovery failed: authorization-rejected)/iu
			);
		});
	}
	it("accepts a fitting recognized close record and rejects its oversized kind loudly at runtime", async () => {
		await expect(exerciseCreatorCloseOversize()).resolves.toEqual({
			fittingAccepted: true,
			oversizeFailure: `creator close ${W0_FRONTIERS_KIND} record exceeds its canonical byte ceiling`,
		});
		expect(W0_FRONTIERS_CEILING).toBe(8_192);
	});

	it("caps one authenticated writer, counts fence/join vertices, preserves another writer and closes below global capacity", async () => {
		const measured = await exerciseAuthorShareRuntime();
		expect(measured).toMatchObject({
			causalJoinCount: 1,
			closeCount: measured.journalCount,
			fenceCount: 1,
			globalCapacityRemaining: W0_MAX_EPOCH_VERTICES - measured.journalCount,
			offenderCount: W0_AUTHOR_SHARE,
			offenderOverflowAdmitted: false,
			otherWriterProgressed: true,
		});
		expect(measured.globalCapacityRemaining).toBeGreaterThan(0);
	}, 120_000);
});
