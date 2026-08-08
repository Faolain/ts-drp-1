import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as processForest from "./fixtures/process-forest.js";

type ProcessIdentity = processForest.ProcessIdentity;

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const CHILD_PID = 410;
const CHILD_SIDECAR_PID = 411;
const BROWSER_PID = 420;
const INITIAL_RENDERER_PID = 421;
const CURRENT_RENDERER_PID = 422;

interface StagedFreezeAuthority {
	readonly browserRoot: ProcessIdentity;
	readonly childRoot: ProcessIdentity;
	readonly initialForest: readonly ProcessIdentity[];
}

interface StagedFreezeModule {
	childGroupStoppedForFreeze(forest: readonly ProcessIdentity[], authority: StagedFreezeAuthority): boolean;
	freezeCurrentOwnedUnion(
		forest: readonly ProcessIdentity[],
		authority: StagedFreezeAuthority
	): readonly ProcessIdentity[] | undefined;
}

const stagedFreezeModule = processForest as typeof processForest & Partial<StagedFreezeModule>;

function legacyInitialUnion(
	forest: readonly ProcessIdentity[],
	authority: StagedFreezeAuthority
): readonly ProcessIdentity[] | undefined {
	const byPid = new Map(forest.map((process) => [process.pid, process]));
	const current = authority.initialForest.map((process) => byPid.get(process.pid));
	if (current.some((process, index) => process?.birthToken !== authority.initialForest[index]?.birthToken)) {
		return undefined;
	}
	return Object.freeze(current as readonly ProcessIdentity[]);
}

const LEGACY_WHOLE_UNION: StagedFreezeModule = Object.freeze({
	childGroupStoppedForFreeze: (forest: readonly ProcessIdentity[], freezeAuthority: StagedFreezeAuthority): boolean => {
		const union = legacyInitialUnion(forest, freezeAuthority);
		return (
			union !== undefined &&
			union.filter(({ pgid }) => pgid === freezeAuthority.childRoot.pgid).every(({ state }) => /T|Z/u.test(state))
		);
	},
	freezeCurrentOwnedUnion: (
		forest: readonly ProcessIdentity[],
		freezeAuthority: StagedFreezeAuthority
	): readonly ProcessIdentity[] | undefined => {
		const union = legacyInitialUnion(forest, freezeAuthority);
		return union?.every(({ state }) => /T|Z/u.test(state)) ? union : undefined;
	},
});

function stagedFreeze(): StagedFreezeModule {
	return typeof stagedFreezeModule.childGroupStoppedForFreeze === "function" &&
		typeof stagedFreezeModule.freezeCurrentOwnedUnion === "function"
		? (stagedFreezeModule as typeof processForest & StagedFreezeModule)
		: LEGACY_WHOLE_UNION;
}

function identity(
	pid: number,
	ppid: number,
	pgid: number,
	command: string,
	state: string,
	birthToken = `Fri Aug  7 23:20:${String(pid % 60).padStart(2, "0")} 2026`
): ProcessIdentity {
	return Object.freeze({ birthToken, command, pgid, pid, ppid, state });
}

function initialForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CHILD_PID, 100, CHILD_PID, "node crash-child.js", "S"),
		identity(CHILD_SIDECAR_PID, CHILD_PID, CHILD_PID, "node crash-sidecar.js", "S"),
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, "chromium --browser", "S"),
		identity(INITIAL_RENDERER_PID, BROWSER_PID, BROWSER_PID, "chromium --type=renderer", "S"),
	]);
}

function authority(initial = initialForest()): StagedFreezeAuthority {
	return Object.freeze({
		browserRoot: initial.find(({ pid }) => pid === BROWSER_PID) as ProcessIdentity,
		childRoot: initial.find(({ pid }) => pid === CHILD_PID) as ProcessIdentity,
		initialForest: initial,
	});
}

function afterChildStopWithBrowserChurn(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CHILD_PID, 100, CHILD_PID, "node crash-child.js", "T"),
		identity(CHILD_SIDECAR_PID, CHILD_PID, CHILD_PID, "node crash-sidecar.js", "T"),
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, "chromium --browser", "S"),
		identity(CURRENT_RENDERER_PID, BROWSER_PID, BROWSER_PID, "chromium --type=renderer", "S"),
	]);
}

function afterChildStopWithDepartedBrowserLeaf(): readonly ProcessIdentity[] {
	return Object.freeze(afterChildStopWithBrowserChurn().filter(({ pid }) => pid !== CURRENT_RENDERER_PID));
}

function afterChildStopWithoutBrowserChurn(): readonly ProcessIdentity[] {
	return Object.freeze(
		initialForest().map((process) => (process.pgid === CHILD_PID ? Object.freeze({ ...process, state: "T" }) : process))
	);
}

function afterBothGroupsStop(): readonly ProcessIdentity[] {
	return Object.freeze(
		afterChildStopWithBrowserChurn().map((process) =>
			process.pgid === BROWSER_PID ? Object.freeze({ ...process, state: "T" }) : process
		)
	);
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b staged freeze tolerates pre-freeze browser churn", () => {
	it("preserves the unchanged two-group stop path", () => {
		const freeze = stagedFreeze();
		const unchanged = Object.freeze(initialForest().map((process) => Object.freeze({ ...process, state: "T" })));

		expect(freeze.childGroupStoppedForFreeze(unchanged, authority())).toBe(true);
		expect(freeze.freezeCurrentOwnedUnion(unchanged, authority())?.map(({ pid }) => pid)).toEqual([
			CHILD_PID,
			CHILD_SIDECAR_PID,
			BROWSER_PID,
			INITIAL_RENDERER_PID,
		]);
	});

	it.each([
		{ label: "departed", forest: afterChildStopWithDepartedBrowserLeaf() },
		{ label: "replacement", forest: afterChildStopWithBrowserChurn() },
	] as const)("stops the exact child group without depending on a $label browser leaf", ({ forest }) => {
		const freeze = stagedFreeze();

		expect(
			freeze.childGroupStoppedForFreeze(forest, authority()),
			"browser leaves may depart or change before browser SIGSTOP"
		).toBe(true);
	});

	it.each([
		{
			label: "running child member",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.map((process) =>
					process.pid === CHILD_SIDECAR_PID ? Object.freeze({ ...process, state: "S" }) : process
				),
		},
		{
			label: "missing child member",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.filter(({ pid }) => pid !== CHILD_SIDECAR_PID),
		},
		{
			label: "replaced child member birth",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.map((process) =>
					process.pid === CHILD_SIDECAR_PID
						? Object.freeze({ ...process, birthToken: `${process.birthToken}-reused` })
						: process
				),
		},
	] as const)("does not complete stage one with a $label", ({ mutate }) => {
		const freeze = stagedFreeze();
		expect(freeze.childGroupStoppedForFreeze(mutate(afterChildStopWithBrowserChurn()), authority())).toBe(false);
	});

	it.each(
		(["child", "browser"] as const).flatMap((root) =>
			(["pid", "birthToken", "command", "ppid", "pgid"] as const).map((field) => ({ root, field }))
		)
	)("does not authorize browser SIGSTOP after a replaced $root-root $field", ({ root, field }) => {
		const freeze = stagedFreeze();
		const rootPid = root === "child" ? CHILD_PID : BROWSER_PID;
		const forest = afterChildStopWithoutBrowserChurn().map((process) => {
			if (process.pid !== rootPid) return process;
			if (field === "pid") return Object.freeze({ ...process, pid: process.pid + 100 });
			if (field === "birthToken") return Object.freeze({ ...process, birthToken: `${process.birthToken}-reused` });
			if (field === "command") return Object.freeze({ ...process, command: `${process.command} --replaced` });
			if (field === "ppid") return Object.freeze({ ...process, ppid: process.ppid + 100 });
			return Object.freeze({ ...process, pgid: process.pgid === CHILD_PID ? BROWSER_PID : CHILD_PID });
		});

		expect(freeze.childGroupStoppedForFreeze(forest, authority())).toBe(false);
	});

	it("freezes the current authorized two-group union after browser stop", () => {
		const freeze = stagedFreeze();
		const outsider = identity(900, 1, 900, "unrelated daemon", "S");
		const stopped = Object.freeze([...afterBothGroupsStop(), outsider]);
		const snapshot = freeze.freezeCurrentOwnedUnion(stopped, authority());

		expect(snapshot?.map(({ pid }) => pid)).toEqual([CHILD_PID, CHILD_SIDECAR_PID, BROWSER_PID, CURRENT_RENDERER_PID]);
		expect(snapshot?.some(({ pid }) => pid === INITIAL_RENDERER_PID)).toBe(false);
		expect(
			snapshot?.some(({ pid }) => pid === outsider.pid),
			"unvalidated PGIDs never enter kill/death evidence"
		).toBe(false);
		expect(Object.isFrozen(snapshot), "the exact final snapshot becomes later death evidence").toBe(true);
	});

	it.each([
		{
			label: "missing child root",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.filter(({ pid }) => pid !== CHILD_PID),
		},
		{
			label: "missing browser root",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.filter(({ pid }) => pid !== BROWSER_PID),
		},
		...(["birthToken", "command", "ppid", "pgid"] as const).map((field) => ({
			label: `replaced browser-root ${field}`,
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.map((process) => {
					if (process.pid !== BROWSER_PID) return process;
					if (field === "birthToken") return Object.freeze({ ...process, birthToken: `${process.birthToken}-reused` });
					if (field === "command") return Object.freeze({ ...process, command: "malicious-browser" });
					if (field === "ppid") return Object.freeze({ ...process, ppid: 1 });
					return Object.freeze({ ...process, pgid: CHILD_PID });
				}),
		})),
		{
			label: "running current browser member",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.map((process) =>
					process.pid === CURRENT_RENDERER_PID ? Object.freeze({ ...process, state: "S" }) : process
				),
		},
		{
			label: "renderer-free browser group",
			mutate: (forest: readonly ProcessIdentity[]): readonly ProcessIdentity[] =>
				forest.map((process) =>
					process.pid === CURRENT_RENDERER_PID
						? Object.freeze({ ...process, command: "chromium --type=gpu-process" })
						: process
				),
		},
	] as const)("refuses a final snapshot with a $label", ({ mutate }) => {
		const freeze = stagedFreeze();
		expect(freeze.freezeCurrentOwnedUnion(mutate(afterBothGroupsStop()), authority())).toBeUndefined();
	});
});

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(TEST_DIRECTORY, "crash-driver.pw.ts");

function sourceFile(): ts.SourceFile {
	return ts.createSourceFile(
		DRIVER_PATH,
		fs.readFileSync(DRIVER_PATH, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
}

function callsNamed(root: ts.Node, name: string): readonly ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return calls;
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b driver uses the staged freeze contract", () => {
	it("replaces whole-initial-union polling with the shared two-stage helper", () => {
		const driver = sourceFile();
		const childChecks = callsNamed(driver, "childGroupStoppedForFreeze");
		const finalSnapshots = callsNamed(driver, "freezeCurrentOwnedUnion");
		const childStops = driver.getText().indexOf('process.kill(-groups.childPgid, "SIGSTOP")');
		const browserStops = driver.getText().indexOf('process.kill(-groups.browserPgid, "SIGSTOP")');

		expect.soft(childChecks, "the child-stop poll uses the shared helper exactly once").toHaveLength(1);
		expect.soft(finalSnapshots, "the browser-stop poll freezes the current union exactly once").toHaveLength(1);
		expect.soft(childStops).toBeGreaterThanOrEqual(0);
		expect.soft(browserStops).toBeGreaterThan(childStops);
		if (childChecks.length === 1 && finalSnapshots.length === 1) {
			expect.soft(childChecks[0]?.getStart()).toBeGreaterThan(childStops);
			expect.soft(childChecks[0]?.getStart()).toBeLessThan(browserStops);
			expect.soft(finalSnapshots[0]?.getStart()).toBeGreaterThan(browserStops);
		}
		expect(callsNamed(driver, "sameUnion"), "the stale whole-initial-union comparator is removed").toHaveLength(0);
	});
});
