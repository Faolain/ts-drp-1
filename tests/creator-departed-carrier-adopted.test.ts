import { expect, it } from "vitest";

import { creatorDepartedCloseAdopted } from "../packages/node/src/internal/creator-successor-serving.js";

// fix/skip-scope-carrier: a creator serves a departed scope's carrier (epoch m's Cut, QC, successor
// trust and closed membership) only once it adopted that close's successor, epoch m + 1. The check
// used the successor-serving gate, which also refuses while ANY adoption runs: a member's departed
// request that reached the creator during a later rollover's adoption was answered "unavailable"
// and its departed scope stayed protected. In a 54-epoch slow-member run (arm B, carrier on) 4 of
// 14 departed requests were refused that way ("not-adopted") although the creator was 3 or more
// epochs past them; those four scopes were exactly the protected ones besides scope 0 and the
// scopes still holding the member's own unsettled rows.
const serving = { serving: true, adopting: false } as const;

it("a departed close whose successor is adopted is served while a later adoption runs", () => {
	// Adopted projection at m + 2 or later: m + 1's adoption finished before the running one began.
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: 21, adopting: true })).toBe(true);
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: 20, adopting: true })).toBe(true);
});

it("the newest close is served only once no adoption runs (its own tail may still be running)", () => {
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: 19, adopting: true })).toBe(false);
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: 19, adopting: false })).toBe(true);
});

it("a close whose successor is not adopted, or a room that does not serve, is never served", () => {
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: 18 })).toBe(false);
	expect(creatorDepartedCloseAdopted(18, { ...serving, projectionEpoch: null })).toBe(false);
	expect(creatorDepartedCloseAdopted(18, { serving: false, projectionEpoch: 25, adopting: false })).toBe(false);
});
