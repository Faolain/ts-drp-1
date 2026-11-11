import { describe, expect, it } from "vitest";
import { ISSUANCE_CAPACITY_FORECAST_EXCEEDED, issuanceCapacityRefusal } from "../src/creator-close.js";

// One typed capacity reason for a local issue refused before signing, on the creator and on a
// Writer (fix/maintenance-image-capacity): apps see ISSUANCE_CAPACITY_FORECAST_EXCEEDED and
// retry after a rollover, whichever bound refused.
describe("issuance capacity refusal", () => {
	it.each([
		"MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:792907/786432",
		"MAINTENANCE_FUTURE_PROOF_ENVELOPE_EXHAUSTED:1/0",
		"issuance source custody plan exceeds original native read bound",
		"issuance retirement refused: unsigned postimage exceeds byte bound",
		"issuance retirement refused: unsigned postimage exceeds row bound",
		"creator issuance maintenance proof reserve is exhausted:4194000+512/4194304",
		"creator next-epoch admission proof reserve is exhausted:4194305/4194304",
	])("types %s", reason => {
		const typed = issuanceCapacityRefusal(reason)!;
		expect(typed.startsWith(`${ISSUANCE_CAPACITY_FORECAST_EXCEEDED}:`)).toBe(true);
		expect(typed).toContain(reason);
		// Already typed text is not wrapped twice.
		expect(issuanceCapacityRefusal(typed)).toBe(typed);
	});
	it("leaves other refusals alone", () => {
		for (const reason of ["v3 local issue signature was not admitted", "issuance retirement fence",
			"creator incremental proof reserve is exhausted"])
			expect(issuanceCapacityRefusal(reason)).toBeUndefined();
	});
});
