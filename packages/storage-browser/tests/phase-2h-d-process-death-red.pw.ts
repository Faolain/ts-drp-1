import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { phase2e6CaseErrors } from "./fixtures/phase-2e6-real-process-death-validator.js";
import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { assertPhase2hWorkerPlaywrightVersion, type Phase2hRunLayout } from "./fixtures/phase-2h-a-publication.js";
import type { Phase2hValidationRecord } from "./fixtures/phase-2h-a-record.js";
import {
	type Phase2hEngineName,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_TUPLES,
} from "./fixtures/phase-2h-a-registry.js";
import { phase2hCampaignCheckpointErrors } from "./fixtures/phase-2h-d-composed-campaign.js";
import { resolvePhase2hPlaywrightIdentity } from "./fixtures/phase-2h-playwright-identity.js";

const ACCEPTED_NON_KILL_COUNT = 15;
const PROCESS_EDGES_PER_ENGINE = 18;
const PROCESS_FOREST_COMMAND = "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=";

const CONTENT_PROCESS_CLASS = Object.freeze({
	chromium: "chromium-renderer",
	firefox: "firefox-contentproc",
	webkit: "webkit-webcontent",
} as const);
const PLAYWRIGHT_IDENTITY = resolvePhase2hPlaywrightIdentity(fileURLToPath(import.meta.url));

test.beforeAll(() => {
	assertPhase2hWorkerPlaywrightVersion(process.env, PLAYWRIGHT_IDENTITY.playwrightVersion);
});

function engineName(value: string): Phase2hEngineName {
	if (value !== "chromium" && value !== "firefox" && value !== "webkit")
		throw new TypeError(`unexpected Phase 2h browser project ${value}`);
	return value;
}

function currentLayout(): Phase2hRunLayout {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const gitSha = process.env.PHASE_2H_A_GIT_SHA;
	const runId = process.env.PHASE_2H_A_RUN_ID;
	if (gitSha === undefined || runId === undefined) throw new TypeError("Phase 2h invocation identity is absent");
	const outputBase = path.join(packageDirectory, "test-results/phase-2h");
	return Object.freeze({
		aggregatePath: path.join(outputBase, "ahe-storage-validation.json"),
		browserVersions: PLAYWRIGHT_IDENTITY.browserVersions,
		gitSha,
		outputBase,
		playwrightVersion: PLAYWRIGHT_IDENTITY.playwrightVersion,
		runId,
		runRoot: path.join(outputBase, runId),
	});
}

function processEvidence(record: Phase2hValidationRecord): void {
	const tuple = PHASE_2H_TUPLES.find(({ tupleId }) => tupleId === record.tupleId);
	expect.soft(tuple?.scenario, `${record.tupleId}: registry scenario`).toBe("process-death");
	if (tuple?.edge === null || tuple?.edge === undefined) return;
	const scenario = record.scenarioEvidence;
	expect.soft(scenario.tag, `${record.tupleId}: scenario tag`).toBe("process-death");
	if (scenario.tag !== "process-death") return;
	expect.soft(scenario.edgeId, `${record.tupleId}: edge identity`).toBe(tuple.edge.id);
	expect.soft(scenario.edgeTarget, `${record.tupleId}: edge target`).toBe(tuple.edge.target);
	expect
		.soft(scenario.expectedState, `${record.tupleId}: old/new image oracle`)
		.toBe(tuple.edge.target === "request" ? "old" : "new");
	expect.soft(scenario.armReachCount, `${record.tupleId}: one arm reach`).toBe(1);
	expect
		.soft(scenario.tracePrefixLength, `${record.tupleId}: trace prefix length`)
		.toBe(scenario.caseEvidence.tracePrefix.length);
	expect.soft(scenario.caseEvidence.unsupported, `${record.tupleId}: supported hard kill`).toBe(false);
	expect
		.soft(
			phase2e6CaseErrors(tuple.edge, scenario.caseEvidence, {
				contentProcessClass: CONTENT_PROCESS_CLASS[tuple.engine],
				platform: record.os.platform,
				scope: "phase2h",
			}),
			`${record.tupleId}: source oracle`
		)
		.toEqual([]);

	const hardKill = record.hardKillEvidence;
	expect.soft(hardKill, `${record.tupleId}: hard-kill evidence`).not.toBeNull();
	if (hardKill === null) return;
	expect.soft(hardKill.mechanism, `${record.tupleId}: hard-kill mechanism`).toBe("posix-two-pgid-sigstop-sigkill/v1");
	expect.soft(hardKill.processForestCommand, `${record.tupleId}: process forest command`).toBe(PROCESS_FOREST_COMMAND);
	expect
		.soft(hardKill.browserRootLocator, `${record.tupleId}: browser identity pin`)
		.toBe("profile-and-executable-argument-match");
	expect
		.soft(hardKill.contentProcessClass, `${record.tupleId}: engine content process`)
		.toBe(CONTENT_PROCESS_CLASS[tuple.engine]);
	expect.soft(hardKill.caseEvidence, `${record.tupleId}: one case-evidence owner`).toEqual(scenario.caseEvidence);
	expect.soft(hardKill.armingMeasurement.engine, `${record.tupleId}: arming engine`).toBe(tuple.engine);
	expect.soft(hardKill.armingMeasurement.outcome, `${record.tupleId}: arming support`).toBe("supported");
	expect.soft(record.recoveredHead, `${record.tupleId}: genuinely recovered head`).not.toBeNull();
	if (record.recoveredHead?.kind === "present")
		expect
			.soft(record.fullClosureDigest, `${record.tupleId}: full recovered closure`)
			.toBe(record.recoveredHead.closureDigest);
}

test("RED: publishes the exact ordered 18-edge hard-process-death batch for this engine", ({ browserName }) => {
	const engine = engineName(browserName);
	const layout = currentLayout();
	const aggregate = aggregatePhase2h({
		...readPhase2hRunEntries(layout.runRoot),
		browserVersions: layout.browserVersions,
		gitSha: layout.gitSha,
		playwrightVersion: layout.playwrightVersion,
		runId: layout.runId,
	});
	const acceptedIds = aggregate.records.map(({ tupleId }) => tupleId);
	const acceptedNonKill = PHASE_2H_REQUIRED_TUPLE_IDS.slice(0, ACCEPTED_NON_KILL_COUNT).filter((tupleId) =>
		tupleId.endsWith(`/${engine}`)
	);
	for (const tupleId of acceptedNonKill)
		expect.soft(acceptedIds, `${tupleId}: accepted positive control`).toContain(tupleId);
	expect.soft(aggregate.duplicateTupleIds, `${engine}: duplicate census`).toEqual([]);
	expect.soft(aggregate.extraTupleIds, `${engine}: extra census`).toEqual([]);
	expect.soft(aggregate.invalidRecordIds, `${engine}: invalid census`).toEqual([]);

	const required = PHASE_2H_TUPLES.filter(
		({ engine: tupleEngine, scenario }) => tupleEngine === engine && scenario === "process-death"
	);
	expect.soft(required, `${engine}: exact source-derived process registry`).toHaveLength(PROCESS_EDGES_PER_ENGINE);
	const records = new Map(aggregate.records.map((record) => [record.tupleId, record]));
	for (const tuple of required) {
		const record = records.get(tuple.tupleId);
		expect.soft(record, `${tuple.tupleId}: missing real process-death producer`).toBeDefined();
		if (record !== undefined) processEvidence(record);
	}
	const ownAccepted = required.flatMap(({ tupleId }) => {
		const record = records.get(tupleId);
		return record === undefined ? [] : [record];
	});
	expect
		.soft(
			ownAccepted.map(({ tupleId }) => tupleId),
			`${engine}: ordered complete project batch`
		)
		.toEqual(required.map(({ tupleId }) => tupleId));

	if (engine === "webkit")
		expect
			.soft(
				phase2hCampaignCheckpointErrors(aggregate, {
					checkpoint: "campaign-complete",
					engine,
					validateProcessRecord: processEvidence,
				}),
				"complete composed campaign"
			)
			.toEqual([]);
});
