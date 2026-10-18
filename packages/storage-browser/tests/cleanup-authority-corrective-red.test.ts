import { describe, expect, it } from "vitest";

import { processFailureBase } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun } from "./fixtures/run-finalizer.js";
import { captureSettledRunOwnership, profileDispositionFor } from "./fixtures/settled-run-lifecycle.js";

const PROFILE = "/tmp/process-cleanup-authority";
const EXECUTABLE = "/opt/chromium";
const CONTROLLER_PID = 901;
const CHILD_PID = 410;
const BROWSER_PID = 420;

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state: "S" });
}

const child = identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, "node browser-child.js");

function context(): Parameters<typeof captureSettledRunOwnership>[1] {
	return {
		childPid: CHILD_PID,
		chromiumExecutablePath: EXECUTABLE,
		controllerPid: CONTROLLER_PID,
		profilePath: PROFILE,
		trustedChildIdentity: child,
	};
}

function validForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, 900, "node test-controller.js"),
		child,
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
		identity(421, BROWSER_PID, BROWSER_PID, `${EXECUTABLE} --type=renderer`),
	]);
}

describe("process cleanup authority", () => {
	it("captures and signals only the validated child/browser groups", () => {
		const ownership = captureSettledRunOwnership(validForest, context());
		const signaled: number[] = [];
		const finalization = finalizeFailedRun(
			{
				base: processFailureBase(),
				code: "SETUP_FAILED",
				detail: "SETUP_FAILED: injected cleanup control",
				ownedGroups: ownership.ownedGroups,
				partialEvidence: { recordedForest: ownership.recordedForest },
				stage: "setup",
				validatedGroups: ownership.validatedGroups,
			},
			{
				killValidatedGroup: (pgid): void => void signaled.push(pgid),
				writeArtifact: (): void => undefined,
			}
		);
		expect(ownership.evidenceState).toBe("captured");
		expect(signaled).toEqual([CHILD_PID, BROWSER_PID]);
		expect(finalization.unresolvedOwnedGroups).toEqual([]);
		expect(
			profileDispositionFor({ kind: "failed-finalized", finalization, ownershipEvidenceState: ownership.evidenceState })
		).toBe("remove");
	});

	it("turns process-table capture failure into unknown evidence with no signal authority", () => {
		const ownership = captureSettledRunOwnership(() => {
			throw new TypeError("injected capture failure");
		}, context());
		expect(ownership.evidenceState).toBe("unknown");
		expect(ownership.ownedGroups).toEqual([CHILD_PID]);
		expect(ownership.validatedGroups).toEqual([]);
	});
});
