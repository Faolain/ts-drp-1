import { describe, expect, it } from "vitest";

import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun, type FinalizeFailedRunInput } from "./fixtures/run-finalizer.js";
import { inspectSettledRunOwnership, profileDispositionFor } from "./fixtures/settled-run-lifecycle.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-real-chrome-profile";
const ROOT_EXECUTABLE = "/opt/playwright/chromium/chrome";
const HELPER_EXECUTABLE = "/opt/playwright/chromium/Chrome Helper";
const RENDERER_EXECUTABLE = "/opt/playwright/chromium/Chrome Helper (Renderer)";
const CONTROLLER_PID = 901;
const CONTROLLER_PGID = 900;
const CHILD_PID = 410;
const BROWSER_PID = 420;

const PASS_CANDIDATE = validCorrectiveCampaign().find((artifact) => artifact.runKind === "discovery");
if (PASS_CANDIDATE?.runKind !== "discovery") throw new TypeError("missing discovery fixture");
const PASS = PASS_CANDIDATE;

function failureBase(): FinalizeFailedRunInput["base"] {
	return Object.freeze({
		schemaVersion: PASS.schemaVersion,
		browser: PASS.browser,
		databaseName: PASS.databaseName,
		expectedDigests: PASS.expectedDigests,
		gitSha: PASS.gitSha,
		objectId: PASS.objectId,
		platform: PASS.platform,
		profilePath: PASS.profilePath,
		runId: PASS.runId,
		runKind: PASS.runKind,
	});
}

function identity(
	pid: number,
	ppid: number,
	pgid: number,
	command: string,
	birthToken = `Sat Aug  8 00:02:${String(pid % 60).padStart(2, "0")} 2026`
): ProcessIdentity {
	return Object.freeze({ birthToken, command, pgid, pid, ppid, state: "S" });
}

function controller(): ProcessIdentity {
	return identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node playwright-controller.js");
}

function child(): ProcessIdentity {
	return identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, "node settled-child.js");
}

function browserRoot(ppid: number, pid = BROWSER_PID, pgid = pid): ProcessIdentity {
	return identity(pid, ppid, pgid, `${ROOT_EXECUTABLE} --headless --user-data-dir=${PROFILE}`);
}

function gpuHelper(pid = 421, pgid = BROWSER_PID): ProcessIdentity {
	return identity(pid, BROWSER_PID, pgid, `${HELPER_EXECUTABLE} --type=gpu-process --user-data-dir=${PROFILE}`);
}

function zygoteHelper(pid = 422, pgid = BROWSER_PID): ProcessIdentity {
	return identity(pid, BROWSER_PID, pgid, `${HELPER_EXECUTABLE} --type=zygote --user-data-dir=${PROFILE}`);
}

function rendererHelper(pid = 423, ppid = 422, pgid = BROWSER_PID, typeArgument = "--type=renderer"): ProcessIdentity {
	return identity(pid, ppid, pgid, `${RENDERER_EXECUTABLE} ${typeArgument} --user-data-dir=${PROFILE}`);
}

function storageHelper(pid = 424, pgid = BROWSER_PID): ProcessIdentity {
	return identity(
		pid,
		BROWSER_PID,
		pgid,
		`${HELPER_EXECUTABLE} --type=utility --utility-sub-type=storage --user-data-dir=${PROFILE}`
	);
}

function realisticForest(childPresent: boolean): readonly ProcessIdentity[] {
	return Object.freeze([
		controller(),
		...(childPresent ? [child()] : []),
		browserRoot(childPresent ? CHILD_PID : 1),
		gpuHelper(),
		zygoteHelper(),
		rendererHelper(),
		storageHelper(),
	]);
}

function inspect(
	forest: readonly ProcessIdentity[],
	trustedChildIdentity?: ProcessIdentity
): ReturnType<typeof inspectSettledRunOwnership> {
	return inspectSettledRunOwnership(forest, {
		childPid: CHILD_PID,
		chromiumExecutablePath: ROOT_EXECUTABLE,
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
			detail: "SETUP_FAILED: injected real Chrome cleanup failure",
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

function expectSafeAmbiguity(forest: readonly ProcessIdentity[], expectedOwnedGroups: readonly number[]): void {
	const observedChild = forest.find(({ pid }) => pid === CHILD_PID);
	const ownership = inspect(forest, observedChild);
	const result = finalize(ownership);

	expect.soft(ownership.evidenceState).toBe("unknown");
	expect.soft(ownership.ownedGroups).toEqual(expectedOwnedGroups);
	expect.soft(ownership.validatedGroups).toEqual([]);
	expect.soft(result.signaled).toEqual([]);
	expect.soft(result.unresolved).toEqual(expectedOwnedGroups);
	expect(result.disposition).toBe("retain");
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b real Chrome cleanup authority correction", () => {
	it("validates and finalizes one full Chrome process tree without requiring helper executable equality", () => {
		const forest = realisticForest(true);
		const trustedChildIdentity = forest.find(({ pid }) => pid === CHILD_PID);
		if (trustedChildIdentity === undefined) throw new TypeError("missing trusted child identity");

		const ownership = inspect(forest, trustedChildIdentity);
		const result = finalize(ownership);

		expect.soft(ownership.evidenceState).toBe("captured");
		expect.soft(ownership.ownedGroups).toEqual([CHILD_PID, BROWSER_PID]);
		expect.soft(ownership.recordedForest.map(({ pid }) => pid)).toEqual([410, 420, 421, 422, 423, 424]);
		expect.soft(ownership.validatedGroups).toEqual([CHILD_PID, BROWSER_PID]);
		expect.soft(result.signaled).toEqual([CHILD_PID, BROWSER_PID]);
		expect.soft(result.unresolved).toEqual([]);
		expect(result.disposition).toBe("remove");
	});

	it("validates only the reparented full Chrome group after the trusted child disappeared", () => {
		const ownership = inspect(realisticForest(false));
		const result = finalize(ownership);

		expect.soft(ownership.evidenceState).toBe("captured");
		expect.soft(ownership.ownedGroups).toEqual([BROWSER_PID]);
		expect.soft(ownership.recordedForest.map(({ pid }) => pid)).toEqual([420, 421, 422, 423, 424]);
		expect.soft(ownership.validatedGroups).toEqual([BROWSER_PID]);
		expect.soft(result.signaled).toEqual([BROWSER_PID]);
		expect.soft(result.unresolved).toEqual([]);
		expect(result.disposition).toBe("remove");
	});

	it.each([
		{
			label: "minimal direct renderer",
			forest: Object.freeze([controller(), browserRoot(1), rendererHelper(423, BROWSER_PID)]),
			expectedPids: [420, 423],
		},
		{
			label: "transitive zygote renderer",
			forest: Object.freeze([controller(), browserRoot(1), zygoteHelper(), rendererHelper()]),
			expectedPids: [420, 422, 423],
		},
		{
			label: "permuted heterogeneous helpers",
			forest: Object.freeze([
				controller(),
				storageHelper(),
				rendererHelper(),
				browserRoot(1),
				zygoteHelper(),
				gpuHelper(),
			]),
			expectedPids: [424, 423, 420, 422, 421],
		},
	] as const)("does not make $label count, order, or helper paths an ambiguity", ({ forest, expectedPids }) => {
		const ownership = inspect(forest);
		const result = finalize(ownership);

		expect.soft(ownership.evidenceState).toBe("captured");
		expect.soft(ownership.ownedGroups).toEqual([BROWSER_PID]);
		expect.soft(ownership.recordedForest.map(({ pid }) => pid)).toEqual(expectedPids);
		expect.soft(ownership.validatedGroups).toEqual([BROWSER_PID]);
		expect.soft(result.signaled).toEqual([BROWSER_PID]);
		expect.soft(result.unresolved).toEqual([]);
		expect(result.disposition).toBe("remove");
	});

	it("keeps exact-profile matches spanning a second browser group unresolved", () => {
		const outsideRenderer = identity(441, 1, 440, `${RENDERER_EXECUTABLE} --type=renderer --user-data-dir=${PROFILE}`);
		expectSafeAmbiguity([...realisticForest(true), outsideRenderer], [CHILD_PID, BROWSER_PID, 440]);
	});

	it("keeps multiple bound-executable browser roots unresolved", () => {
		const secondRoot = browserRoot(CHILD_PID, 440, 440);
		expectSafeAmbiguity([...realisticForest(true), secondRoot], [CHILD_PID, BROWSER_PID, 440]);
	});

	it.each([
		{
			label: "renderer outside the root group",
			forest: Object.freeze([controller(), browserRoot(1), rendererHelper(423, BROWSER_PID, 440)]),
			expectedOwned: [BROWSER_PID, 440],
		},
		{
			label: "renderer outside the root ancestry",
			forest: Object.freeze([controller(), browserRoot(1), rendererHelper(423, 999, BROWSER_PID)]),
			expectedOwned: [BROWSER_PID],
		},
		{
			label: "missing renderer",
			forest: Object.freeze([controller(), browserRoot(1), gpuHelper(), storageHelper()]),
			expectedOwned: [BROWSER_PID],
		},
		{
			label: "renderer argument lookalike",
			forest: Object.freeze([
				controller(),
				browserRoot(1),
				rendererHelper(423, BROWSER_PID, BROWSER_PID, "--type=renderer-extra"),
			]),
			expectedOwned: [BROWSER_PID],
		},
		{
			label: "helper processes without an exact root",
			forest: Object.freeze([controller(), gpuHelper(), zygoteHelper(), rendererHelper()]),
			expectedOwned: [BROWSER_PID],
		},
	] as const)("retains profile authority for $label", ({ forest, expectedOwned }) => {
		expectSafeAmbiguity(forest, expectedOwned);
	});

	it.each([
		{
			label: "duplicate identity",
			forest: [
				...realisticForest(false),
				identity(
					423,
					422,
					BROWSER_PID,
					`${RENDERER_EXECUTABLE} --type=renderer --user-data-dir=${PROFILE}`,
					"duplicate"
				),
			],
		},
		{
			label: "malformed identity",
			forest: [
				...realisticForest(false),
				identity(
					Number.NaN,
					BROWSER_PID,
					BROWSER_PID,
					`${HELPER_EXECUTABLE} --type=utility --user-data-dir=${PROFILE}`
				),
			],
		},
	] as const)("retains all discoverable browser ownership for $label", ({ forest }) => {
		expectSafeAmbiguity(forest, [BROWSER_PID]);
	});

	it.each([
		{
			label: "root executable suffix",
			forest: Object.freeze([
				controller(),
				identity(BROWSER_PID, 1, BROWSER_PID, `${ROOT_EXECUTABLE}-other --headless --user-data-dir=${PROFILE}`),
			]),
			expectedEvidence: "unknown",
			expectedOwned: [BROWSER_PID],
			expectedDisposition: "retain",
		},
		{
			label: "root executable prefix",
			forest: Object.freeze([
				controller(),
				identity(BROWSER_PID, 1, BROWSER_PID, `/wrapper${ROOT_EXECUTABLE} --headless --user-data-dir=${PROFILE}`),
			]),
			expectedEvidence: "unknown",
			expectedOwned: [BROWSER_PID],
			expectedDisposition: "retain",
		},
		{
			label: "profile suffix",
			forest: Object.freeze([
				controller(),
				identity(BROWSER_PID, 1, BROWSER_PID, `${ROOT_EXECUTABLE} --headless --user-data-dir=${PROFILE}-other`),
			]),
			expectedEvidence: "captured",
			expectedOwned: [],
			expectedDisposition: "remove",
		},
		{
			label: "profile prefix",
			forest: Object.freeze([
				controller(),
				identity(BROWSER_PID, 1, BROWSER_PID, `${ROOT_EXECUTABLE} --headless --user-data-dir=prefix${PROFILE}`),
			]),
			expectedEvidence: "captured",
			expectedOwned: [],
			expectedDisposition: "remove",
		},
	] as const)("does not accept a $label as exact authority", (control) => {
		const ownership = inspect(control.forest);
		const result = finalize(ownership);

		expect.soft(ownership.evidenceState).toBe(control.expectedEvidence);
		expect.soft(ownership.ownedGroups).toEqual(control.expectedOwned);
		expect.soft(ownership.validatedGroups).toEqual([]);
		expect.soft(result.signaled).toEqual([]);
		expect.soft(result.unresolved).toEqual(control.expectedOwned);
		expect(result.disposition).toBe(control.expectedDisposition);
	});
});
