import { describe, expect, it } from "vitest";

import { processFailureBase } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun, type FinalizeFailedRunInput } from "./fixtures/run-finalizer.js";
import { inspectSettledRunOwnership, profileDispositionFor } from "./fixtures/settled-run-lifecycle.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-linux-profile";
const EXECUTABLE = "/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome";
const CONTROLLER_PID = 804;
const CONTROLLER_PGID = 800;
const CHILD_PID = 3895;
const BROWSER_PID = 3907;

function failureBase(): FinalizeFailedRunInput["base"] {
	return processFailureBase();
}

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({
		birthToken: `Sat Aug  8 05:47:${String(pid % 60).padStart(2, "0")} 2026`,
		command,
		pgid,
		pid,
		ppid,
		state: "T",
	});
}

function controller(): ProcessIdentity {
	return identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node playwright-controller.js");
}

function child(): ProcessIdentity {
	return identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, "node crash-child.js");
}

function chrome(pid: number, ppid: number, pgid: number, argumentsValue: string, profile = PROFILE): ProcessIdentity {
	return identity(pid, ppid, pgid, `${EXECUTABLE} ${argumentsValue} --user-data-dir=${profile}`);
}

function linuxChromeForest(childPresent: boolean): readonly ProcessIdentity[] {
	return Object.freeze([
		controller(),
		...(childPresent ? [child()] : []),
		chrome(BROWSER_PID, childPresent ? CHILD_PID : 1, BROWSER_PID, "--headless --remote-debugging-pipe"),
		chrome(3914, BROWSER_PID, BROWSER_PID, "--type=zygote --no-zygote-sandbox"),
		chrome(3915, BROWSER_PID, BROWSER_PID, "--type=zygote"),
		chrome(3935, 3914, BROWSER_PID, "--type=gpu-process"),
		chrome(3936, BROWSER_PID, BROWSER_PID, "--type=utility --utility-sub-type=network"),
		chrome(3960, 3915, BROWSER_PID, "--type=utility --utility-sub-type=storage"),
		chrome(3979, 3915, BROWSER_PID, "--type=renderer"),
		chrome(4000, 3915, BROWSER_PID, "--type=renderer --disable-gpu-compositing"),
	]);
}

function inspect(
	forest: readonly ProcessIdentity[],
	trustedChildIdentity?: ProcessIdentity
): ReturnType<typeof inspectSettledRunOwnership> {
	return inspectSettledRunOwnership(forest, {
		childPid: CHILD_PID,
		chromiumExecutablePath: EXECUTABLE,
		controllerPid: CONTROLLER_PID,
		profilePath: PROFILE,
		...(trustedChildIdentity === undefined ? {} : { trustedChildIdentity }),
	});
}

function finalize(ownership: ReturnType<typeof inspect>): {
	readonly disposition: ReturnType<typeof profileDispositionFor>;
	readonly signaled: readonly number[];
	readonly unresolved: readonly number[];
} {
	const signaled: number[] = [];
	const observation = finalizeFailedRun(
		{
			base: failureBase(),
			code: "SETUP_FAILED",
			detail: "SETUP_FAILED: injected Linux cleanup failure",
			ownedGroups: ownership.ownedGroups,
			partialEvidence: { recordedForest: ownership.recordedForest },
			stage: "seed",
			validatedGroups: ownership.validatedGroups,
		},
		{
			killValidatedGroup: (pgid): void => {
				signaled.push(pgid);
			},
			writeArtifact: (): void => undefined,
		}
	);
	return Object.freeze({
		disposition: profileDispositionFor({
			kind: "failed-finalized",
			finalization: observation,
			ownershipEvidenceState: ownership.evidenceState,
		}),
		signaled: Object.freeze(signaled),
		unresolved: observation.unresolvedOwnedGroups,
	});
}

function expectValidatedCleanup(
	forest: readonly ProcessIdentity[],
	expectedGroups: readonly number[],
	trustedChildIdentity?: ProcessIdentity
): void {
	const ownership = inspect(forest, trustedChildIdentity);
	const result = finalize(ownership);

	expect.soft(ownership.evidenceState).toBe("captured");
	expect.soft(ownership.ownedGroups).toEqual(expectedGroups);
	expect.soft(ownership.validatedGroups).toEqual(expectedGroups);
	expect.soft(result.signaled).toEqual(expectedGroups);
	expect.soft(result.unresolved).toEqual([]);
	expect(result.disposition).toBe("remove");
}

function expectSafeAmbiguity(forest: readonly ProcessIdentity[], expectedOwnedGroups: readonly number[]): void {
	const trustedChildIdentity = forest.find(({ pid }) => pid === CHILD_PID);
	const ownership = inspect(forest, trustedChildIdentity);
	const result = finalize(ownership);

	expect.soft(ownership.evidenceState).toBe("unknown");
	expect.soft(ownership.ownedGroups).toEqual(expectedOwnedGroups);
	expect.soft(ownership.validatedGroups).toEqual([]);
	expect.soft(result.signaled).toEqual([]);
	expect.soft(result.unresolved).toEqual(expectedOwnedGroups);
	expect(result.disposition).toBe("retain");
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b Linux failure cleanup authority correction", () => {
	it("finalizes the child and browser groups when Linux Chrome helpers share the root executable", () => {
		const forest = linuxChromeForest(true);
		const trustedChildIdentity = forest.find(({ pid }) => pid === CHILD_PID);
		if (trustedChildIdentity === undefined) throw new TypeError("missing trusted child identity");
		expectValidatedCleanup(forest, [CHILD_PID, BROWSER_PID], trustedChildIdentity);
	});

	it("finalizes only the reparented browser group after the trusted child disappeared", () => {
		expectValidatedCleanup(linuxChromeForest(false), [BROWSER_PID]);
	});

	it("retains ownership when a second exact-profile group-leading root competes for authority", () => {
		const competingRoot = chrome(4100, CHILD_PID, 4100, "--headless --remote-debugging-pipe");
		const competingRenderer = chrome(4101, 4100, 4100, "--type=renderer");
		expectSafeAmbiguity([...linuxChromeForest(true), competingRoot, competingRenderer], [CHILD_PID, BROWSER_PID, 4100]);
	});

	it("retains a helper-only exact-profile group with no group-leading browser root", () => {
		const helperOnly = Object.freeze([
			controller(),
			chrome(3914, 9999, BROWSER_PID, "--type=zygote"),
			chrome(3979, 3914, BROWSER_PID, "--type=renderer"),
		]);
		expectSafeAmbiguity(helperOnly, [BROWSER_PID]);
	});

	it("retains ownership when renderer ancestry crosses out of the browser group", () => {
		const forest = linuxChromeForest(false)
			.filter(({ pid }) => pid !== 4000)
			.map((processIdentity) =>
				processIdentity.pid === 3979 ? chrome(processIdentity.pid, 9999, 4100, "--type=renderer") : processIdentity
			);
		expectSafeAmbiguity(forest, [BROWSER_PID, 4100]);
	});
});
