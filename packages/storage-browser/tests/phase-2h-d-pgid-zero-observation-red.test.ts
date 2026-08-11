import { describe, expect, it } from "vitest";

import { parseFailureArtifact } from "./fixtures/artifacts.js";
import { processFailureBase } from "./fixtures/corrective-artifact-fixtures.js";
import {
	executePinnedCampaignSignalSequence,
	revalidateStoppedCleanupIdentities,
} from "./fixtures/phase-2e6-process-death-runner.js";
import { phase2e6CaseErrors } from "./fixtures/phase-2e6-real-process-death-validator.js";
import {
	phase2hControlRecords,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { type Phase2hValidationRecord, validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";
import { PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";
import {
	freezeCurrentOwnedUnion,
	locateBrowserRoot,
	parseProcessForest,
	type ProcessCampaignAuthority,
	processClosure,
	type ProcessIdentity,
	validateTwoGroupForest,
} from "./fixtures/process-forest.js";

const PROFILE = "/tmp/phase-2h-pgid-zero/profile";
const CHROMIUM = "/opt/playwright/chromium/chrome";
const CONTROLLER_PID = 90;
const CONTROLLER_PGID = 80;
const CHILD_PID = 100;
const BROWSER_PID = 200;

const COMPLETE_HOST_FOREST = [
	" 2 0 0 Mon Aug 10 20:00:00 2026 S [kthreadd]",
	` ${CONTROLLER_PID} 1 ${CONTROLLER_PGID} Mon Aug 10 20:00:01 2026 S node playwright-controller.js`,
	` ${CHILD_PID} ${CONTROLLER_PID} ${CHILD_PID} Mon Aug 10 20:00:02 2026 T node phase-2e6-crash-child.js`,
	` ${BROWSER_PID} ${CHILD_PID} ${BROWSER_PID} Mon Aug 10 20:00:03 2026 T ${CHROMIUM} --user-data-dir=${PROFILE}`,
	` 201 ${BROWSER_PID} ${BROWSER_PID} Mon Aug 10 20:00:04 2026 T ${CHROMIUM} --type=zygote --user-data-dir=${PROFILE}`,
	` 202 201 ${BROWSER_PID} Mon Aug 10 20:00:05 2026 T ${CHROMIUM} --type=renderer --user-data-dir=${PROFILE}`,
].join("\n");

function identity(pid: number, ppid: number, pgid: number, command: string, state = "T"): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state });
}

function positiveForest(state = "T"): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node playwright-controller.js", state),
		identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, "node phase-2e6-crash-child.js", state),
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, `${CHROMIUM} --user-data-dir=${PROFILE}`, state),
		identity(201, BROWSER_PID, BROWSER_PID, `${CHROMIUM} --type=zygote --user-data-dir=${PROFILE}`, state),
		identity(202, 201, BROWSER_PID, `${CHROMIUM} --type=renderer --user-data-dir=${PROFILE}`, state),
	]);
}

function requiredIdentity(forest: readonly ProcessIdentity[], pid: number): ProcessIdentity {
	const found = forest.find((identity) => identity.pid === pid);
	if (found === undefined) throw new TypeError(`missing process identity ${pid}`);
	return found;
}

function authorityFor(
	forest: readonly ProcessIdentity[],
	patch: Partial<ProcessCampaignAuthority> = {}
): ProcessCampaignAuthority {
	return Object.freeze({
		browserRoot: requiredIdentity(forest, BROWSER_PID),
		childRoot: requiredIdentity(forest, CHILD_PID),
		contentProcessClass: "chromium-renderer",
		controllerPgid: CONTROLLER_PGID,
		executablePath: CHROMIUM,
		platform: "linux",
		profilePath: PROFILE,
		scope: "phase2h",
		...patch,
	});
}

function processControlRecord(): Phase2hValidationRecord {
	const tupleId = PHASE_2H_KILL_TUPLE_IDS[0];
	const record = phase2hControlRecords().find((candidate) => candidate.tupleId === tupleId);
	if (record === undefined || record.hardKillEvidence === null || record.scenarioEvidence.tag !== "process-death")
		throw new TypeError("Phase 2h process-death control is absent");
	return record;
}

function replaceCaseEvidence(
	record: Phase2hValidationRecord,
	patch: Partial<NonNullable<Phase2hValidationRecord["hardKillEvidence"]>["caseEvidence"]>
): Phase2hValidationRecord {
	if (record.hardKillEvidence === null || record.scenarioEvidence.tag !== "process-death")
		throw new TypeError("Phase 2h process-death control is incomplete");
	const caseEvidence = Object.freeze({ ...record.scenarioEvidence.caseEvidence, ...patch });
	return Object.freeze({
		...record,
		hardKillEvidence: Object.freeze({ ...record.hardKillEvidence, caseEvidence }),
		scenarioEvidence: Object.freeze({ ...record.scenarioEvidence, caseEvidence }),
	});
}

function validateRecord(record: unknown): ReturnType<typeof validatePhase2hRecord> {
	return validatePhase2hRecord(record, {
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		project: "chromium",
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function failureArtifact(): unknown {
	return {
		...processFailureBase(),
		code: "SETUP_FAILED",
		detail: "SETUP_FAILED: passive PGID-zero control",
		partialEvidence: { cleanup: { unresolvedOwnedGroups: [], validatedGroups: [CHILD_PID, BROWSER_PID] } },
		stage: "setup",
		verdict: "fail",
	};
}

describe("Phase 2h-d passive PGID-zero observation corrective RED", () => {
	it("RED: retains a real host-wide PGID-zero row while validating the unchanged positive campaign closure", () => {
		const complete = parseProcessForest(COMPLETE_HOST_FOREST);
		expect(complete[0]).toEqual({
			birthToken: "Mon Aug 10 20:00:00 2026",
			command: "[kthreadd]",
			pgid: 0,
			pid: 2,
			ppid: 0,
			state: "S",
		});
		expect(complete).toHaveLength(6);

		const campaign = authorityFor(complete);
		const closure = processClosure(complete, CHILD_PID);
		expect(closure.map(({ pid }) => pid)).toEqual([CHILD_PID, BROWSER_PID, 201, 202]);
		expect(validateTwoGroupForest(closure, CHILD_PID, BROWSER_PID, campaign)).toEqual({
			browserPgid: BROWSER_PID,
			childPgid: CHILD_PID,
			ownedPids: [CHILD_PID, BROWSER_PID, 201, 202],
		});
		expect(validateTwoGroupForest(complete, CHILD_PID, BROWSER_PID, campaign)).toEqual({
			browserPgid: BROWSER_PID,
			childPgid: CHILD_PID,
			ownedPids: [CHILD_PID, BROWSER_PID, 201, 202],
		});
	});

	it("keeps zero outside every root, controller, witness, owned-closure, and freeze authority", () => {
		const control = positiveForest();
		const campaign = authorityFor(control);
		const zeroAt = (pid: number): readonly ProcessIdentity[] =>
			control.map((row) => (row.pid === pid ? Object.freeze({ ...row, pgid: 0 }) : row));
		const ownedZero = Object.freeze([...control, identity(203, 202, 0, "owned descendant")]);

		for (const mutant of [zeroAt(CHILD_PID), zeroAt(BROWSER_PID), zeroAt(202), ownedZero]) {
			expect(() =>
				validateTwoGroupForest(mutant, CHILD_PID, BROWSER_PID, {
					...campaign,
					browserRoot: requiredIdentity(mutant, BROWSER_PID),
					childRoot: requiredIdentity(mutant, CHILD_PID),
				})
			).toThrow();
		}

		expect(() => validateTwoGroupForest(control, CHILD_PID, BROWSER_PID, { ...campaign, controllerPgid: 0 })).toThrow();
		expect(
			freezeCurrentOwnedUnion(control, { ...campaign, controllerPgid: 0, initialForest: control })
		).toBeUndefined();
		expect(freezeCurrentOwnedUnion(ownedZero, { ...campaign, initialForest: ownedZero })).toBeUndefined();
	});

	it("rejects zero cleanup and signal authority without invoking a real process signal", async () => {
		for (const patch of [
			{ controllerPgid: 0 },
			{ childRoot: { ...requiredIdentity(positiveForest(), CHILD_PID), pgid: 0 } },
			{ browserRoot: { ...requiredIdentity(positiveForest(), BROWSER_PID), pgid: 0 } },
		] satisfies readonly Partial<ProcessCampaignAuthority>[]) {
			const control = positiveForest("S");
			const signals: { signal: string; target: number }[] = [];
			await expect(
				executePinnedCampaignSignalSequence({
					authority: authorityFor(control, patch),
					captureForest: () => control,
					signal: (target, signal) => signals.push({ signal, target }),
				})
			).rejects.toThrow();
			expect(signals).toEqual([]);
		}

		const zeroCandidate = identity(CHILD_PID, CONTROLLER_PID, 0, "node phase-2e6-crash-child.js");
		const resumed: number[] = [];
		const cleanup = revalidateStoppedCleanupIdentities([zeroCandidate], [zeroCandidate], (pid) => resumed.push(pid));
		expect(cleanup.groups).toEqual([]);
		expect(cleanup.errors).not.toEqual([]);
		expect(resumed).toEqual([CHILD_PID]);
		expect([...cleanup.groups, ...resumed].some((target) => Object.is(-target, -0))).toBe(false);
	});

	it("preserves the positive Phase 2e6, Phase 2h, failure-artifact, and signal-order controls", async () => {
		const positiveSignals: { signal: string; target: number }[] = [];
		const stopped = positiveForest();
		await expect(
			executePinnedCampaignSignalSequence({
				authority: authorityFor(stopped),
				captureForest: () => stopped,
				signal: (target, signal) => positiveSignals.push({ signal, target }),
			})
		).resolves.toEqual(stopped.slice(1));
		expect(positiveSignals).toEqual([
			{ signal: "SIGSTOP", target: -CHILD_PID },
			{ signal: "SIGSTOP", target: -BROWSER_PID },
			{ signal: "SIGKILL", target: -BROWSER_PID },
			{ signal: "SIGKILL", target: -CHILD_PID },
		]);

		const control = processControlRecord();
		if (control.scenarioEvidence.tag !== "process-death") throw new TypeError("process control changed shape");
		const tuple = PHASE_2H_TUPLES.find(({ tupleId }) => tupleId === control.tupleId);
		if (tuple === undefined || tuple.edge === null) throw new TypeError("process control tuple is absent");
		expect(
			phase2e6CaseErrors(tuple.edge, control.scenarioEvidence.caseEvidence, {
				contentProcessClass: "chromium-renderer",
				platform: "linux",
				scope: "phase2h",
			})
		).toEqual([]);
		expect(validateRecord(control).errors).toEqual([]);
		expect(() => parseFailureArtifact(failureArtifact())).not.toThrow();
	});

	it("RED: rejects a persisted zero controller authority", () => {
		const control = processControlRecord();
		if (control.scenarioEvidence.tag !== "process-death") throw new TypeError("process control changed shape");
		const result = validateRecord(replaceCaseEvidence(control, { controllerPgid: 0 }));
		expect(result.record).toBeNull();
		expect(result.errors).not.toEqual([]);
	});

	it("keeps killed-group and failure-artifact evidence positive-only", () => {
		const control = processControlRecord();
		if (control.scenarioEvidence.tag !== "process-death") throw new TypeError("process control changed shape");
		const killedGroups = control.scenarioEvidence.caseEvidence.killedGroups.map((group, index) =>
			index === 0 ? { ...group, pgid: 0 } : group
		) as never;
		const result = validateRecord(replaceCaseEvidence(control, { killedGroups }));
		expect(result.record).toBeNull();
		expect(result.errors).not.toEqual([]);

		for (const partialEvidence of [
			{ cleanup: { unresolvedOwnedGroups: [], validatedGroups: [0] } },
			{ cleanup: { unresolvedOwnedGroups: [0], validatedGroups: [] } },
			{
				cleanup: { unresolvedOwnedGroups: [], validatedGroups: [] },
				recordedForest: [identity(2, 0, 0, "[kthreadd]")],
			},
		])
			expect(() => parseFailureArtifact({ ...(failureArtifact() as object), partialEvidence })).toThrow();
	});

	it("preserves malformed, unsafe, duplicate, and ambiguous fail-closed controls", () => {
		for (const malformed of [
			"410 100 nope malformed",
			"410 100 -1 Mon Aug 10 20:00:00 2026 T node child.js",
			"0 0 0 Mon Aug 10 20:00:00 2026 S kernel",
			"9007199254740992 1 1 Mon Aug 10 20:00:00 2026 S unsafe",
		])
			expect(() => parseProcessForest(malformed)).toThrow();

		const control = positiveForest();
		const duplicate = [...control, { ...requiredIdentity(control, 202), command: "duplicate renderer" }];
		const ambiguousRoot = [...control, identity(300, CHILD_PID, 300, `${CHROMIUM} --user-data-dir=${PROFILE}`)];
		expect(() => validateTwoGroupForest(duplicate, CHILD_PID, BROWSER_PID, authorityFor(control))).toThrow();
		expect(() => locateBrowserRoot(ambiguousRoot, CHILD_PID, PROFILE, authorityFor(control))).toThrow(
			"expected one browser root, observed 2"
		);
	});
});
