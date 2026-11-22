import { describe, expect, it } from "vitest";

import {
	childGroupStoppedForFreeze,
	freezeCurrentOwnedUnion,
	type ProcessIdentity,
} from "./fixtures/process-forest.js";

const CHILD_PID = 410;
const BROWSER_PID = 420;
const ZYGOTE_PID = 421;
const CONTENT_PID = 422;
const CONTROLLER_PGID = 100;
const EXECUTABLE = "/opt/playwright/chromium/chrome";
const PROFILE = "/tmp/staged-freeze-profile";

type RequiredFreezeAuthority = Readonly<{
	readonly browserRoot: ProcessIdentity;
	readonly childRoot: ProcessIdentity;
	readonly contentProcessClass: "chromium-renderer" | "firefox-contentproc" | "webkit-webcontent";
	readonly controllerPgid: number;
	readonly executablePath: string;
	readonly initialForest: readonly ProcessIdentity[];
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly scope: "phase2e6" | "phase2h";
}>;

type CorrectiveFreezeAuthority = RequiredFreezeAuthority;
type ChildStopAuthorityIsMandatory = Parameters<typeof childGroupStoppedForFreeze>[1] extends RequiredFreezeAuthority
	? true
	: false;

function identity(pid: number, ppid: number, pgid: number, command: string, state = "S"): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state });
}

function initialForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CHILD_PID, CONTROLLER_PGID, CHILD_PID, "node browser-child.js"),
		identity(411, CHILD_PID, CHILD_PID, "node child-sidecar.js"),
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
		identity(ZYGOTE_PID, BROWSER_PID, BROWSER_PID, `${EXECUTABLE} --type=zygote --user-data-dir=${PROFILE}`),
		identity(CONTENT_PID, ZYGOTE_PID, BROWSER_PID, `${EXECUTABLE} --type=renderer --user-data-dir=${PROFILE}`),
	]);
}

function authority(): CorrectiveFreezeAuthority {
	const initial = initialForest();
	return Object.freeze({
		browserRoot: initial[2] as ProcessIdentity,
		childRoot: initial[0] as ProcessIdentity,
		contentProcessClass: "chromium-renderer",
		controllerPgid: CONTROLLER_PGID,
		executablePath: EXECUTABLE,
		initialForest: initial,
		platform: "linux",
		profilePath: PROFILE,
		scope: "phase2h",
	});
}

describe("staged process-forest freeze governance", () => {
	it("accepts child-first stop despite browser leaf churn and freezes the current two-group union", () => {
		const childStopAuthorityIsMandatory: ChildStopAuthorityIsMandatory = true;
		expect(childStopAuthorityIsMandatory).toBe(true);
		const childStopped = Object.freeze([
			identity(CHILD_PID, CONTROLLER_PGID, CHILD_PID, "node browser-child.js", "T"),
			identity(411, CHILD_PID, CHILD_PID, "node child-sidecar.js", "T"),
			identity(BROWSER_PID, CHILD_PID, BROWSER_PID, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
			identity(ZYGOTE_PID, BROWSER_PID, BROWSER_PID, `${EXECUTABLE} --type=zygote --user-data-dir=${PROFILE}`),
			identity(CONTENT_PID + 1, ZYGOTE_PID, BROWSER_PID, `${EXECUTABLE} --type=renderer --user-data-dir=${PROFILE}`),
		]);
		expect(childGroupStoppedForFreeze(childStopped, authority())).toBe(true);
		const allStopped = childStopped.map((item) =>
			item.pgid === BROWSER_PID ? Object.freeze({ ...item, state: "T" }) : item
		);
		const frozen = freezeCurrentOwnedUnion(allStopped, authority());
		expect(frozen?.map(({ pid }) => pid)).toEqual([CHILD_PID, 411, BROWSER_PID, ZYGOTE_PID, CONTENT_PID + 1]);
		expect(Object.isFrozen(frozen)).toBe(true);
	});

	it("rejects a running child member, replaced root, or renderer-free browser group", () => {
		const initial = initialForest();
		const childPartiallyStopped = initial.map((item) =>
			item.pid === CHILD_PID ? Object.freeze({ ...item, state: "T" }) : item
		);
		expect(childGroupStoppedForFreeze(childPartiallyStopped, authority())).toBe(false);
		const replacedRoot = initial.map((item) =>
			Object.freeze({ ...item, state: "T", ...(item.pid === BROWSER_PID ? { birthToken: "reused" } : {}) })
		);
		expect(freezeCurrentOwnedUnion(replacedRoot, authority())).toBeUndefined();
		const noRenderer = initial
			.filter(({ pid }) => pid !== CONTENT_PID)
			.map((item) => Object.freeze({ ...item, state: "T" }));
		expect(freezeCurrentOwnedUnion(noRenderer, authority())).toBeUndefined();
		const wrongExecutableReplacement = initial.map((item) =>
			item.pid === CONTENT_PID
				? identity(CONTENT_PID + 1, ZYGOTE_PID, BROWSER_PID, item.command.replace(EXECUTABLE, `${EXECUTABLE}2`), "T")
				: Object.freeze({ ...item, state: "T" })
		);
		expect.soft(freezeCurrentOwnedUnion(wrongExecutableReplacement, authority())).toBeUndefined();
		const wrongProfileReplacement = initial.map((item) =>
			item.pid === CONTENT_PID
				? identity(CONTENT_PID + 1, ZYGOTE_PID, BROWSER_PID, item.command.replace(PROFILE, `${PROFILE}2`), "T")
				: Object.freeze({ ...item, state: "T" })
		);
		expect.soft(freezeCurrentOwnedUnion(wrongProfileReplacement, authority())).toBeUndefined();
	});
});
