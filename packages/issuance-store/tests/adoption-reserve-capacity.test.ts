import { describe, expect, it } from "vitest";

import { issuanceOrdinaryFinishingCapacityWidths, type IssuanceRetirementRows } from "../src/retirement.js";

const scope = { objectId: "adoption-reserve-capacity", author: "writer" };
const geometry = {
	maxContextByteLength: 74_107,
	maxCompletionByteLength: 70_432,
	maxCompletionMemberByteLength: 512,
	maxExpiryByteLength: 1_024,
	maxNativeReadByteLength: 786_432,
};
const empty: IssuanceRetirementRows = { lineages: [], issued: [], outbox: [], plans: [] };
const preimage = 512;

function widths(
	count: number,
	adoptionReserveFenceCount: 0 | 1 | 2,
	sourceCustody = true
): ReturnType<typeof issuanceOrdinaryFinishingCapacityWidths> {
	return issuanceOrdinaryFinishingCapacityWidths({
		rows: empty,
		scope,
		control: null,
		maxAdditionalCurrentIssued: count,
		maxCanonicalPreimageByteLength: preimage,
		successorFenceCount: 1,
		adoptionReserveFenceCount,
		...(sourceCustody ? { sourceCustody: geometry } : {}),
	});
}

describe("ordinary admission reserves the adoption fence's own successor fence", () => {
	it.each([
		[1, true, 1],
		[7, true, 1],
		[7, false, 1],
		[1, true, 2],
		[7, true, 2],
		[7, false, 2],
	] as const)(
		"with %i ordinary rows (custody %s) a reserve of %i is exactly that many more fence-shaped records in every successor phase",
		(count, custody, reserve) => {
			const reserved = widths(count, reserve, custody),
				oneMore = widths(count + reserve, 0, custody);
			for (const phase of ["successorPending", "successorFinal"] as const) {
				expect(reserved[phase].canonicalRowsBytes).toBe(oneMore[phase].canonicalRowsBytes);
				expect(reserved.canonicalRowsShape[phase]).toEqual(oneMore.canonicalRowsShape[phase]);
			}
			expect(reserved.planRewriteResource).toEqual(oneMore.planRewriteResource);
			const unreserved = widths(count, 0, custody);
			expect(reserved.successorFinal.canonicalRowsBytes).toBeGreaterThan(unreserved.successorFinal.canonicalRowsBytes);
			// Current work and the current close keep their exact unreserved widths.
			expect(reserved.ordinaryPending).toEqual(unreserved.ordinaryPending);
			expect(reserved.ordinaryFinal).toEqual(unreserved.ordinaryFinal);
			expect(reserved.currentAdmission).toEqual(unreserved.currentAdmission);
		}
	);

	it("the retention reserve (2) is one fence-shaped record more than the adoption reserve (1)", () => {
		const two = widths(7, 2),
			one = widths(8, 1);
		for (const phase of ["successorPending", "successorFinal"] as const)
			expect(two[phase].canonicalRowsBytes).toBe(one[phase].canonicalRowsBytes);
		expect(two.successorFinal.canonicalRowsBytes).toBeGreaterThan(widths(7, 1).successorFinal.canonicalRowsBytes);
	});

	it("refuses a reserve beyond the retention horizon", () => {
		expect(() => widths(1, 3 as 2)).toThrow();
	});

	it.each([1, 2] as const)("refuses a reserve of %i without the successor fence it follows", (reserve) => {
		expect(() =>
			issuanceOrdinaryFinishingCapacityWidths({
				rows: empty,
				scope,
				control: null,
				maxAdditionalCurrentIssued: 1,
				maxCanonicalPreimageByteLength: preimage,
				successorFenceCount: 0,
				adoptionReserveFenceCount: reserve,
			})
		).toThrow();
	});
});
