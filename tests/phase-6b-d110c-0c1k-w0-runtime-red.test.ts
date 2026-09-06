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
	W0_AUTHOR_SHARE_MULTIPLIER,
	W0_FRONTIERS_CEILING,
	W0_FRONTIERS_KIND,
	W0_MAX_EPOCH_VERTICES,
	W0_WRITER_COUNT,
} from "./fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

describe("D.110c-0c1k W0 real lifecycle and capacity RED", () => {
	for (const [memberCount, byteLength] of [
		[31, 3_450],
		[64, 7_014],
	] as const) {
		it(`stages, opens, recovers, closes, and adopts a genuine ${memberCount}-member writer-only ACL`, async () => {
			const lifecycle = await exerciseAcceptedAclLifecycle(memberCount).then(
				(value) => value,
				(error: unknown) => (error instanceof Error ? error.message : String(error))
			);
			expect(encodedAclBoundary(memberCount, "writer-only")).toEqual({
				byteLength,
				fitsLegacyCeiling: true,
			});
			expect(W0_LEGACY_ACL_MAX_CANONICAL_BYTES).toBe(8_192);
			expect.soft(stageOpenBoundary(memberCount, "writer-only"), "stage/open parity").toEqual({
				openOk: true,
				stageOk: true,
			});
			expect(lifecycle).toEqual({
				closeCount: 2,
				committedRecovery: "active-new",
			});
		});
	}

	for (const [memberCount, shape, byteLength, authority] of [
		[65, "writer-only", 7_122, "legacy cardinality"],
		[41, "full-shape", 8_261, "legacy byte ceiling"],
	] as const) {
		it(`rejects ${memberCount} ${shape} members consistently by ${authority}`, async () => {
			const rejected = await rejectedAclLifecycle(memberCount, shape);
			expect(encodedAclBoundary(memberCount, shape)).toEqual({
				byteLength,
				fitsLegacyCeiling: memberCount === 65,
			});
			expect.soft(stageOpenBoundary(memberCount, shape), "stage/open parity").toEqual({
				openOk: false,
				stageOk: false,
			});
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

	it("caps one legacy-profile writer, rejects the reserved fence, counts the causal join, preserves another writer and closes below global capacity", async () => {
		const measured = await exerciseAuthorShareRuntime();
		console.info("W0_CURRENT_PROFILE_OBSERVATION", JSON.stringify(measured));
		expect(measured, JSON.stringify(measured)).toMatchObject({
			attemptedFenceDeliveredToApplication: false,
			attemptedFenceJournaled: false,
			causalJoinCount: 1,
			closeCount: 1_514,
			closedApplicationState: 1_652,
			expectedApplicationState: 1_652,
			expectedJournalCount: 1_514,
			fenceCount: 0,
			journalCount: 1_514,
			offenderApplicationCount: W0_AUTHOR_SHARE,
			offenderCount: W0_AUTHOR_SHARE,
			offenderFenceCount: 0,
			offenderOverflowAdmitted: false,
			offenderOverflowJournaled: false,
			otherWriterProgressed: true,
			profileId: "creator-trusted-v1",
		});
		expectAccounting(measured);
	}, 120_000);

	it("charges a settlement-profile offender's own signed fence to its share, refuses its next add, preserves another writer and genuinely closes", async () => {
		const measured = await exerciseAuthorShareRuntime("creator-trusted-settlement-v1");
		console.info("W0_CURRENT_PROFILE_OBSERVATION", JSON.stringify(measured));
		expect(measured, JSON.stringify(measured)).toMatchObject({
			attemptedFenceDeliveredToApplication: false,
			attemptedFenceJournaled: true,
			causalJoinCount: 0,
			closeCount: 1_496,
			closedApplicationState: 1_496,
			expectedApplicationState: 1_496,
			expectedJournalCount: 1_496,
			fenceCount: 1,
			journalCount: 1_496,
			offenderApplicationCount: W0_AUTHOR_SHARE - 1,
			offenderCount: W0_AUTHOR_SHARE,
			offenderFenceCount: 1,
			offenderOverflowAdmitted: false,
			offenderOverflowJournaled: false,
			otherWriterProgressed: true,
			profileId: "creator-trusted-settlement-v1",
		});
		expectAccounting(measured);
	}, 120_000);
});

function expectAccounting(measured: Awaited<ReturnType<typeof exerciseAuthorShareRuntime>>): void {
	const diagnostic = JSON.stringify(measured);
	expect([W0_WRITER_COUNT, W0_MAX_EPOCH_VERTICES, W0_AUTHOR_SHARE_MULTIPLIER, W0_AUTHOR_SHARE]).toEqual([
		22, 8_192, 4, 1_492,
	]);
	expect(measured.exactInputRowsMatch, diagnostic).toBe(true);
	expect(measured.exactCloseSetChargesMatch, diagnostic).toBe(true);
	expect(measured.journalCanonicalBytes, diagnostic).toBe(measured.closeCanonicalBytes);
	expect(measured.journalCount, diagnostic).toBe(measured.expectedJournalCount);
	expect(measured.closedApplicationState, diagnostic).toBe(measured.expectedApplicationState);
	expect(measured.offenderSequences, diagnostic).toEqual(Array.from({ length: W0_AUTHOR_SHARE }, (_, index) => index));
	expect(measured.attemptedFenceCanonicalBytes, diagnostic).toBeGreaterThan(0);
	expect(measured.globalGraphOccupancy, diagnostic).toBe(measured.journalCount + 1);
	expect(measured.globalCapacityRemaining, diagnostic).toBe(W0_MAX_EPOCH_VERTICES - measured.globalGraphOccupancy);
	expect(measured.globalCapacityRemaining, diagnostic).toBeGreaterThan(0);
}
