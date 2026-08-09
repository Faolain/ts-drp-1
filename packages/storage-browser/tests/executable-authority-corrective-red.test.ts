import { describe, expect, it } from "vitest";

import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { inspectSettledRunOwnership } from "./fixtures/settled-run-lifecycle.js";

const PROFILE = "/tmp/executable-authority";
const EXECUTABLE = "/opt/chromium/chrome";
const BROWSER_PID = 420;

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state: "S" });
}

function forest(executable: string, profile = PROFILE): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(901, 1, 900, "node test-controller.js"),
		identity(BROWSER_PID, 1, BROWSER_PID, `${executable} --user-data-dir=${profile}`),
		identity(421, BROWSER_PID, BROWSER_PID, `${executable} --type=renderer`),
	]);
}

function inspect(processes: readonly ProcessIdentity[]): ReturnType<typeof inspectSettledRunOwnership> {
	return inspectSettledRunOwnership(processes, {
		childPid: 410,
		chromiumExecutablePath: EXECUTABLE,
		controllerPid: 901,
		profilePath: PROFILE,
	});
}

describe("parent-authoritative browser executable governance", () => {
	it("validates the exact executable/profile browser group", () => {
		const ownership = inspect(forest(EXECUTABLE));
		expect(ownership.evidenceState).toBe("captured");
		expect(ownership.ownedGroups).toEqual([BROWSER_PID]);
		expect(ownership.validatedGroups).toEqual([BROWSER_PID]);
	});

	it("retains mismatched executable ownership without granting signal authority", () => {
		const ownership = inspect(forest("/opt/chromium-headless-shell"));
		expect(ownership.evidenceState).toBe("unknown");
		expect(ownership.ownedGroups).toEqual([BROWSER_PID]);
		expect(ownership.validatedGroups).toEqual([]);
	});

	it("does not claim a substring profile", () => {
		const ownership = inspect(forest(EXECUTABLE, `${PROFILE}-other`));
		expect(ownership.ownedGroups).toEqual([]);
		expect(ownership.validatedGroups).toEqual([]);
	});
});
