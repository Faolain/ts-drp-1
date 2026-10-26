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
	adoptionReserveFenceCount: 0 | 1,
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
		[1, true],
		[7, true],
		[7, false],
	] as const)(
		"with %i ordinary rows (custody %s) the reserve is exactly one more fence-shaped record in every successor phase",
		(count, custody) => {
			const reserved = widths(count, 1, custody),
				oneMore = widths(count + 1, 0, custody);
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

	it("refuses a reserve without the successor fence it follows", () => {
		expect(() =>
			issuanceOrdinaryFinishingCapacityWidths({
				rows: empty,
				scope,
				control: null,
				maxAdditionalCurrentIssued: 1,
				maxCanonicalPreimageByteLength: preimage,
				successorFenceCount: 0,
				adoptionReserveFenceCount: 1,
			})
		).toThrow();
	});
});
