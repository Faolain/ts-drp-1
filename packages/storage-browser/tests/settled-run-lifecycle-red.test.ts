import { describe, expect, it } from "vitest";

import type { ProcessIdentity } from "./fixtures/process-forest.js";
import {
	disposeProfileWhenAllowed,
	inspectSettledRunOwnership,
	profileDispositionFor,
} from "./fixtures/settled-run-lifecycle.js";

const PROFILE = "/tmp/settled-run-lifecycle";
const EXECUTABLE = "/opt/chromium";

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state: "S" });
}

function context(): Parameters<typeof inspectSettledRunOwnership>[1] {
	return { childPid: 410, chromiumExecutablePath: EXECUTABLE, controllerPid: 901, profilePath: PROFILE };
}

describe("settled run lifecycle", () => {
	it("validates a reparented exact-profile browser group", () => {
		const forest = Object.freeze([
			identity(901, 1, 900, "node test-controller.js"),
			identity(420, 1, 420, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
			identity(421, 420, 420, `${EXECUTABLE} --type=renderer`),
		]);
		const ownership = inspectSettledRunOwnership(forest, context());
		expect(ownership.evidenceState).toBe("captured");
		expect(ownership.ownedGroups).toEqual([420]);
		expect(ownership.validatedGroups).toEqual([420]);
	});

	it("fails closed for ambiguous roots and incomplete ownership evidence", () => {
		const forest = Object.freeze([
			identity(901, 1, 900, "node test-controller.js"),
			identity(420, 1, 420, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
			identity(421, 420, 420, `${EXECUTABLE} --type=renderer`),
			identity(440, 1, 440, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
			identity(441, 440, 440, `${EXECUTABLE} --type=renderer`),
		]);
		const ownership = inspectSettledRunOwnership(forest, context());
		expect(ownership.ownedGroups).toEqual([420, 440]);
		expect(ownership.validatedGroups).toEqual([]);
		expect(
			profileDispositionFor({
				kind: "failed-finalized",
				finalization: { unresolvedOwnedGroups: ownership.ownedGroups },
				ownershipEvidenceState: ownership.evidenceState,
			})
		).toBe("retain");
	});

	it("applies profile disposal only after the closed policy grants it", () => {
		const removed: string[] = [];
		expect(disposeProfileWhenAllowed(PROFILE, "retain", (value) => removed.push(value))).toBe(false);
		expect(disposeProfileWhenAllowed(PROFILE, "remove", (value) => removed.push(value))).toBe(true);
		expect(removed).toEqual([PROFILE]);
		expect(profileDispositionFor({ kind: "pass" })).toBe("remove");
		expect(profileDispositionFor({ kind: "finalization-failed" })).toBe("retain");
	});
});
