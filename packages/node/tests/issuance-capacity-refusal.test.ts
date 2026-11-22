import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import "../src/index.js";
import { ISSUANCE_CAPACITY_FORECAST_EXCEEDED, issuanceCapacityRefusal, issuanceCapacityRefusalOf } from "../src/creator-close.js";

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
		"creator issuance maintenance prefix sizing is unavailable: MAINTENANCE_SUMMARY_CONTINUATION_UNAVAILABLE:summary[]:creator maintenance encoded width exceeds its bound",
		"v3 local issue transaction failed: creator closed rollback refusal: proof-budget-exceeded",
		"issuance retirement refused: unsigned postimage exceeds row bound with its settlement replacement reserve",
	])("types %s", reason => {
		const typed = issuanceCapacityRefusal(reason)!;
		expect(typed.startsWith(`${ISSUANCE_CAPACITY_FORECAST_EXCEEDED}:`)).toBe(true);
		expect(typed).toContain(reason);
		// Already typed text is not wrapped twice.
		expect(issuanceCapacityRefusal(typed)).toBe(typed);
	});
	it("types a received move's maintenance refusal as the local issue path does, never by its bare Refusal kind", () => {
		// The creator's received-append admission logged "received-maintenance-capture:proof-budget-exceeded"
		// and told the rollover policy nothing: it typed the Refusal's bare kind, which names no bound. A
		// closed-rollback Refusal is typed data, not an Error, and names itself through its string form.
		const refusal = (kind: string) => ({ toString: () => `creator closed rollback refusal: ${kind}` });
		const typed = issuanceCapacityRefusalOf(refusal("proof-budget-exceeded"))!;
		expect(typed.startsWith(`${ISSUANCE_CAPACITY_FORECAST_EXCEEDED}:`)).toBe(true);
		expect(issuanceCapacityRefusal("proof-budget-exceeded")).toBeUndefined(); // The bare kind, as it was read.
		expect(issuanceCapacityRefusalOf(new TypeError("MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:786437/786432"))).toContain("MAINTENANCE_NATIVE_IMAGE_EXHAUSTED");
		for (const other of [refusal("chain-invalid"), new TypeError("v3 local issue signature was not admitted"), undefined])
			expect(issuanceCapacityRefusalOf(other)).toBeUndefined();
		// Both admission paths (received append and local issue) type through this one reader.
		const live = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		expect(live).toContain("const capacity = issuanceCapacityRefusalOf(error);");
		expect(live).toContain("v3 local issue transaction failed: ${issuanceCapacityRefusalOf(error) ??");
		expect(live).not.toMatch(/issuanceCapacityRefusal\(reason\)/u);
	});
	it("leaves other refusals alone", () => {
		for (const reason of ["v3 local issue signature was not admitted", "issuance retirement fence",
			"creator incremental proof reserve is exhausted", "creator maintenance encoded width is invalid",
			"creator closed rollback refusal: chain-invalid",
			"creator issuance maintenance prefix sizing is unavailable: MAINTENANCE_POST_ADOPTION_CENSUS_UNAVAILABLE"])
			expect(issuanceCapacityRefusal(reason)).toBeUndefined();
	});
});
