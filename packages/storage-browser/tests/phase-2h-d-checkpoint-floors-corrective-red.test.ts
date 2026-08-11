import { describe, expect, it } from "vitest";

import {
	aggregatePhase2h,
	type Phase2hAggregate,
	type Phase2hRawEntry,
	phase2hStructuralEntries,
} from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlRecords,
	phase2hRecordEntry,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { type Phase2hEngineName, PHASE_2H_ENGINES } from "./fixtures/phase-2h-a-registry.js";
import {
	type Phase2hCampaignCheckpoint,
	phase2hCampaignCheckpointErrors,
} from "./fixtures/phase-2h-d-composed-campaign.js";

const BROWSER_SURFACE_SCENARIOS = new Set(["browser-store", "crypto-digest", "worker-responsiveness"]);
const NON_KILL_SCENARIOS = new Set([
	"browser-store",
	"capacity",
	"crypto-digest",
	"quota-fault",
	"worker-responsiveness",
]);

interface IntermediateCase {
	readonly checkpoint: Exclude<Phase2hCampaignCheckpoint, "campaign-complete">;
	readonly engine: Phase2hEngineName;
	readonly floor: number;
}

const INTERMEDIATE_CASES: readonly IntermediateCase[] = Object.freeze([
	Object.freeze({ checkpoint: "browser-surfaces-complete", engine: "chromium", floor: 3 }),
	Object.freeze({ checkpoint: "browser-surfaces-complete", engine: "firefox", floor: 26 }),
	Object.freeze({ checkpoint: "browser-surfaces-complete", engine: "webkit", floor: 49 }),
	Object.freeze({ checkpoint: "non-kill-complete", engine: "chromium", floor: 5 }),
	Object.freeze({ checkpoint: "non-kill-complete", engine: "firefox", floor: 28 }),
	Object.freeze({ checkpoint: "non-kill-complete", engine: "webkit", floor: 51 }),
]);

const PRIOR_ENGINE_CASES = INTERMEDIATE_CASES.filter(({ engine }) => engine !== "chromium");

function aggregate(tupleIds: ReadonlySet<string>): Phase2hAggregate {
	const entries: Phase2hRawEntry[] = [...phase2hStructuralEntries()];
	for (const record of phase2hControlRecords()) {
		if (tupleIds.has(record.tupleId)) entries.push(phase2hRecordEntry(record));
	}
	return aggregatePhase2h({
		entries,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function exactFloor({ checkpoint, engine }: IntermediateCase): ReadonlySet<string> {
	const currentEngineIndex = PHASE_2H_ENGINES.indexOf(engine);
	const currentScenarios = checkpoint === "browser-surfaces-complete" ? BROWSER_SURFACE_SCENARIOS : NON_KILL_SCENARIOS;
	return new Set(
		phase2hControlRecords().flatMap((record) => {
			const recordEngineIndex = PHASE_2H_ENGINES.indexOf(record.engine.name);
			if (recordEngineIndex < currentEngineIndex) return [record.tupleId];
			if (record.engine.name === engine && currentScenarios.has(record.scenario)) return [record.tupleId];
			return [];
		})
	);
}

function laterRegisteredTuple(input: IntermediateCase): string {
	const floor = exactFloor(input);
	const record = phase2hControlRecords().find(
		({ engine, tupleId }) => engine.name === input.engine && !floor.has(tupleId)
	);
	if (record === undefined) throw new TypeError(`missing later registered ${input.checkpoint}/${input.engine} tuple`);
	return record.tupleId;
}

function priorProcessTuple(input: IntermediateCase): string {
	const engineIndex = PHASE_2H_ENGINES.indexOf(input.engine);
	const priorEngine = PHASE_2H_ENGINES[engineIndex - 1];
	const record = phase2hControlRecords().find(
		({ engine, scenario }) => engine.name === priorEngine && scenario === "process-death"
	);
	if (record === undefined)
		throw new TypeError(`missing prior process-death ${input.checkpoint}/${input.engine} tuple`);
	return record.tupleId;
}

describe("Phase 2h-d intermediate project-completion floors corrective RED", () => {
	it.each(INTERMEDIATE_CASES)("accepts the exact $floor-record $checkpoint floor for $engine", (input) => {
		const observed = aggregate(exactFloor(input));
		expect(observed.records).toHaveLength(input.floor);
		expect(phase2hCampaignCheckpointErrors(observed, input)).toEqual([]);
	});

	it.each(INTERMEDIATE_CASES)(
		"accepts registered monotonic growth after the $checkpoint floor for $engine",
		(input) => {
			const tupleIds = new Set(exactFloor(input));
			tupleIds.add(laterRegisteredTuple(input));
			expect(phase2hCampaignCheckpointErrors(aggregate(tupleIds), input)).toEqual([]);
		}
	);

	it.each(PRIOR_ENGINE_CASES)(
		"RED: rejects $checkpoint for $engine when a prior project process-death tuple is absent",
		(input) => {
			const tupleIds = new Set(exactFloor(input));
			const omittedTuple = priorProcessTuple(input);
			tupleIds.delete(omittedTuple);
			const currentStage = [...exactFloor(input)].filter((tupleId) => tupleId.endsWith(`/${input.engine}`));

			expect(currentStage.every((tupleId) => tupleIds.has(tupleId))).toBe(true);
			expect(aggregate(tupleIds).records).toHaveLength(input.floor - 1);
			expect(phase2hCampaignCheckpointErrors(aggregate(tupleIds), input)).not.toEqual([]);
		}
	);

	it.each([{ checkpoint: "browser-surfaces-complete" }, { checkpoint: "non-kill-complete" }] as const)(
		"RED: unsupported runtime engine fails closed at the $checkpoint checkpoint",
		({ checkpoint }) => {
			const unsupportedEngine = "servo" as unknown as Phase2hEngineName;
			expect(
				phase2hCampaignCheckpointErrors(aggregate(new Set()), { checkpoint, engine: unsupportedEngine })
			).not.toEqual([]);
		}
	);

	it("rejects dirty diagnostics at every otherwise-valid intermediate floor", () => {
		for (const input of INTERMEDIATE_CASES) {
			const observed = aggregate(exactFloor(input));
			for (const field of ["duplicateTupleIds", "extraTupleIds", "invalidRecordIds"] as const) {
				const dirty = Object.freeze({ ...observed, [field]: Object.freeze(["injected-diagnostic"]) });
				expect(
					phase2hCampaignCheckpointErrors(dirty, input),
					`${input.checkpoint}/${input.engine}/${field}`
				).not.toEqual([]);
			}
		}
	});
});
