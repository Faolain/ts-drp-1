import { describe, expect, it } from "vitest";

import protocolConfig from "../playwright.protocol-v2.config.js";
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
import type { Phase2hValidationRecord } from "./fixtures/phase-2h-a-record.js";
import {
	type Phase2hEngineName,
	PHASE_2H_KILL_TUPLE_IDS,
	PHASE_2H_REQUIRED_TUPLE_IDS,
} from "./fixtures/phase-2h-a-registry.js";

type CampaignCheckpoint = "browser-surfaces-complete" | "non-kill-complete" | "campaign-complete";

interface CampaignCheckpointOptions {
	readonly checkpoint: CampaignCheckpoint;
	readonly engine: Phase2hEngineName;
	validateProcessRecord?(record: Phase2hValidationRecord): void;
}

type CampaignCheckpointErrors = (aggregate: Phase2hAggregate, options: CampaignCheckpointOptions) => readonly string[];

const BROWSER_SURFACE_SCENARIOS = new Set(["browser-store", "crypto-digest", "worker-responsiveness"]);
const NON_KILL_COUNT = 15;
const COMPOSED_CHECKPOINT_MODULE = "./fixtures/phase-2h-d-composed-campaign.js";

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

function webkitBrowserSurfaceCheckpoint(): Phase2hAggregate {
	return aggregate(
		new Set(
			phase2hControlRecords().flatMap(({ engine, scenario, tupleId }) => {
				if (engine.name !== "webkit") return [tupleId];
				return BROWSER_SURFACE_SCENARIOS.has(scenario) ? [tupleId] : [];
			})
		)
	);
}

function webkitNonKillCheckpoint(): Phase2hAggregate {
	return aggregate(
		new Set([
			...PHASE_2H_REQUIRED_TUPLE_IDS.slice(0, NON_KILL_COUNT),
			...PHASE_2H_KILL_TUPLE_IDS.filter((tupleId) => !tupleId.endsWith("/webkit")),
		])
	);
}

function completeCheckpoint(): Phase2hAggregate {
	return aggregate(new Set(PHASE_2H_REQUIRED_TUPLE_IDS));
}

async function checkpointErrors(): Promise<CampaignCheckpointErrors> {
	const module = (await import(COMPOSED_CHECKPOINT_MODULE).catch(() => Object.freeze({}))) as Readonly<
		Record<string, unknown>
	>;
	const candidate = Reflect.get(module, "phase2hCampaignCheckpointErrors");
	expect(
		candidate,
		"missing bounded composed-campaign checkpoint owner; intermediate specs must not encode a closed-world snapshot"
	).toBeTypeOf("function");
	return candidate as CampaignCheckpointErrors;
}

function executionSchedule(): readonly string[] {
	const files = Array.isArray(protocolConfig.testMatch) ? protocolConfig.testMatch.map(String) : [];
	const projects = protocolConfig.projects?.map(({ name }) => String(name)) ?? [];
	return projects.flatMap((project) => files.map((file) => `${project}:${file}`));
}

describe("Phase 2h-d composed campaign corrective RED", () => {
	it("pins the single-worker project-batched schedule that makes later-phase records visible to WebKit b/c", () => {
		const schedule = executionSchedule();
		const browserSurfaces = "phase-2h-b-browser-surfaces-red.pw.ts";
		const capacityQuota = "phase-2h-c-capacity-quota-red.pw.ts";
		const processProducer = "phase-2h-d-process-death-producer.pw.ts";
		const processBoundary = "phase-2h-d-process-death-red.pw.ts";

		expect(protocolConfig.workers).toBe(1);
		expect(protocolConfig.fullyParallel).toBe(false);
		expect(schedule).toHaveLength(12);
		expect(schedule.indexOf(`webkit:${browserSurfaces}`)).toBeGreaterThan(
			schedule.indexOf(`firefox:${processProducer}`)
		);
		expect(schedule.indexOf(`webkit:${capacityQuota}`)).toBeGreaterThan(schedule.indexOf(`firefox:${processProducer}`));
		expect(schedule.at(-1)).toBe(`webkit:${processBoundary}`);
	});

	it("RED: accepts monotonic prior-project growth at the WebKit browser-surface and non-kill checkpoints", async () => {
		const errors = await checkpointErrors();
		const browserSurface = webkitBrowserSurfaceCheckpoint();
		const nonKill = webkitNonKillCheckpoint();

		expect(browserSurface.records).toHaveLength(49);
		expect(browserSurface.missingKillPoints).toHaveLength(18);
		expect(errors(browserSurface, { checkpoint: "browser-surfaces-complete", engine: "webkit" })).toEqual([]);
		expect(nonKill.records).toHaveLength(51);
		expect(nonKill.missingKillPoints).toHaveLength(18);
		expect(errors(nonKill, { checkpoint: "non-kill-complete", engine: "webkit" })).toEqual([]);
	});

	it("RED: intermediate checkpoints still fail closed on missing owned records or dirty diagnostics", async () => {
		const errors = await checkpointErrors();
		const observed = webkitNonKillCheckpoint();
		const withoutOwnedQuota = aggregate(
			new Set(observed.records.map(({ tupleId }) => tupleId).filter((tupleId) => tupleId !== "quota-fault/webkit"))
		);

		expect(errors(withoutOwnedQuota, { checkpoint: "non-kill-complete", engine: "webkit" })).not.toEqual([]);
		for (const field of ["duplicateTupleIds", "extraTupleIds", "invalidRecordIds"] as const) {
			const dirty = Object.freeze({ ...observed, [field]: Object.freeze(["injected-diagnostic"]) });
			expect(errors(dirty, { checkpoint: "non-kill-complete", engine: "webkit" }), field).not.toEqual([]);
		}
	});

	it("RED: the final WebKit boundary requires the exact ordered 69-record pass and validates all 54 causal records", async () => {
		const errors = await checkpointErrors();
		const observed = completeCheckpoint();
		const validated: string[] = [];

		expect(
			errors(observed, {
				checkpoint: "campaign-complete",
				engine: "webkit",
				validateProcessRecord: (record) => validated.push(record.tupleId),
			})
		).toEqual([]);
		expect(observed.records.map(({ tupleId }) => tupleId)).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
		expect(observed.missingTupleIds).toEqual([]);
		expect(observed.missingKillPoints).toEqual([]);
		expect(observed.verdict).toBe("pass");
		expect(validated).toEqual(PHASE_2H_KILL_TUPLE_IDS);

		const incomplete = webkitNonKillCheckpoint();
		expect(errors(incomplete, { checkpoint: "campaign-complete", engine: "webkit" })).not.toEqual([]);
	});

	it("RED: the final owner propagates causal-evidence validation failure instead of accepting census alone", async () => {
		const errors = await checkpointErrors();
		const observed = completeCheckpoint();
		const defectiveTuple = PHASE_2H_KILL_TUPLE_IDS[17];
		if (defectiveTuple === undefined) throw new TypeError("process-death control tuple is absent");

		expect(() =>
			errors(observed, {
				checkpoint: "campaign-complete",
				engine: "webkit",
				validateProcessRecord: (record) => {
					if (record.tupleId === defectiveTuple) throw new TypeError(`causal evidence rejected: ${record.tupleId}`);
				},
			})
		).toThrow(`causal evidence rejected: ${defectiveTuple}`);
	});
});
