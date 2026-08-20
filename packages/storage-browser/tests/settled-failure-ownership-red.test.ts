import { describe, expect, it } from "vitest";

import { parseProcessForest } from "./fixtures/process-forest.js";
import {
	inspectSettledFailureOwnership,
	ownershipFromSettledFailure,
	SettledRunFailure,
} from "./fixtures/settled-failure-ownership.js";

const PROFILE = "/tmp/settled-failure-control";
const FOREST = [
	" 901 1 900 Fri Aug  7 16:00:00 2026 S node test-controller.js",
	" 410 901 410 Fri Aug  7 16:00:01 2026 S node browser-child.js",
	` 420 410 420 Fri Aug  7 16:00:02 2026 S chromium --user-data-dir=${PROFILE}`,
	" 421 420 420 Fri Aug  7 16:00:03 2026 S chromium --type=renderer",
].join("\n");

describe("settled failure ownership model", () => {
	it("proves only the exact child/browser groups and excludes the controller", () => {
		const ownership = inspectSettledFailureOwnership(parseProcessForest(FOREST), 410, PROFILE, 901);
		expect(ownership.evidenceState).toBe("captured");
		expect(ownership.ownedGroups).toEqual([410, 420]);
		expect(ownership.validatedGroups).toEqual([410, 420]);
		expect(ownership.recordedForest.some(({ pgid }) => pgid === 900)).toBe(false);
	});

	it("keeps ambiguous exact-profile groups owned but unvalidated", () => {
		const ambiguous = parseProcessForest(
			`${FOREST}\n 440 410 440 Fri Aug  7 16:00:04 2026 S chromium --user-data-dir=${PROFILE}`
		);
		const ownership = inspectSettledFailureOwnership(ambiguous, 410, PROFILE, 901);
		expect(ownership.ownedGroups).toEqual([410, 420, 440]);
		expect(ownership.validatedGroups).toEqual([]);
	});

	it("preserves structured ownership without trusting ordinary errors", () => {
		const ownership = inspectSettledFailureOwnership(parseProcessForest(FOREST), 410, PROFILE, 901);
		expect(ownershipFromSettledFailure(new SettledRunFailure(new Error("injected"), ownership))).toBe(ownership);
		expect(ownershipFromSettledFailure(new Error("untrusted"))).toEqual({
			evidenceState: "captured",
			ownedGroups: [],
			recordedForest: [],
			validatedGroups: [],
		});
	});
});
