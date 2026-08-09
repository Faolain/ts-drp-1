import { describe, expect, it } from "vitest";

import {
	childGroupStoppedForFreeze,
	freezeCurrentOwnedUnion,
	type ProcessIdentity,
} from "./fixtures/process-forest.js";

const CHILD_PID = 410;
const BROWSER_PID = 420;

function identity(pid: number, ppid: number, pgid: number, command: string, state = "S"): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state });
}

function initialForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CHILD_PID, 100, CHILD_PID, "node browser-child.js"),
		identity(411, CHILD_PID, CHILD_PID, "node child-sidecar.js"),
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, "chromium --browser"),
		identity(421, BROWSER_PID, BROWSER_PID, "chromium --type=renderer"),
	]);
}

function authority(): Parameters<typeof childGroupStoppedForFreeze>[1] {
	const initial = initialForest();
	return Object.freeze({
		browserRoot: initial[2] as ProcessIdentity,
		childRoot: initial[0] as ProcessIdentity,
		initialForest: initial,
	});
}

describe("staged process-forest freeze governance", () => {
	it("accepts child-first stop despite browser leaf churn and freezes the current two-group union", () => {
		const childStopped = Object.freeze([
			identity(CHILD_PID, 100, CHILD_PID, "node browser-child.js", "T"),
			identity(411, CHILD_PID, CHILD_PID, "node child-sidecar.js", "T"),
			identity(BROWSER_PID, CHILD_PID, BROWSER_PID, "chromium --browser"),
			identity(422, BROWSER_PID, BROWSER_PID, "chromium --type=renderer"),
		]);
		expect(childGroupStoppedForFreeze(childStopped, authority())).toBe(true);
		const allStopped = childStopped.map((item) =>
			item.pgid === BROWSER_PID ? Object.freeze({ ...item, state: "T" }) : item
		);
		const frozen = freezeCurrentOwnedUnion(allStopped, authority());
		expect(frozen?.map(({ pid }) => pid)).toEqual([CHILD_PID, 411, BROWSER_PID, 422]);
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
		const noRenderer = initial.filter(({ pid }) => pid !== 421).map((item) => Object.freeze({ ...item, state: "T" }));
		expect(freezeCurrentOwnedUnion(noRenderer, authority())).toBeUndefined();
	});
});
