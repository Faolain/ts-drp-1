import { describe, expect, it } from "vitest";

import { PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./fixtures/phase-2e5-browser-request-inventory.js";
import {
	type Phase2e6CampaignEvidence,
	type Phase2e6CaseEvidence,
	phase2e6ExpectedTracePrefix,
	phase2e6OracleImages,
	PHASE_2E6_DECLARED_EDGES,
} from "./fixtures/phase-2e6-real-process-death-contract.js";
import {
	type Phase2e6ArtifactEnvelope,
	phase2e6CampaignErrors,
	phase2e6CampaignFromArtifacts,
	phase2e6RunId,
} from "./fixtures/phase-2e6-real-process-death-validator.js";

function partialImage(label: string): Phase2e6CaseEvidence["recoveredImage"] {
	return Object.freeze({
		blobs: Object.freeze([{ bytes: [1, 2, 3], digest: `${label}-blob` }]),
		generations: Object.freeze([{ generationId: `${label}-generation`, record: [4, 5] }]),
		objects: Object.freeze([{ objectId: "creator:0123456789abcdef0123456789abcdef", record: [6] }]),
		promotions: Object.freeze([{ digest: `${label}-blob`, generationId: `${label}-generation` }]),
	});
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing ${label}`);
	return value;
}

function validCampaign(): Phase2e6CampaignEvidence {
	const cases = PHASE_2E6_DECLARED_EDGES.map((edge, ordinal): Phase2e6CaseEvidence => {
		const row = required(
			PHASE_2E5_BROWSER_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId),
			"row"
		);
		const expectedState = edge.target === "request" ? "old" : "new";
		const oldHead = row.operation === "swapHead" ? `head-${ordinal}` : null;
		const childPid = 10_000 + ordinal * 10;
		const browserPid = childPid + 1;
		const profilePath = `/tmp/phase-2e6-profile-${ordinal}`;
		const child = Object.freeze({
			birthToken: `child-${ordinal}`,
			command: "node crash-child",
			pgid: childPid,
			pid: childPid,
			ppid: 9000,
			state: "T",
		});
		const browserRoot = Object.freeze({
			birthToken: `browser-${ordinal}`,
			command: `/opt/chromium --browser --user-data-dir=${profilePath}`,
			pgid: browserPid,
			pid: browserPid,
			ppid: childPid,
			state: "T",
		});
		const renderer = Object.freeze({
			birthToken: `renderer-${ordinal}`,
			command: "chromium --type=renderer",
			pgid: browserPid,
			pid: childPid + 2,
			ppid: browserPid,
			state: "T",
		});
		const forest = Object.freeze([child, browserRoot, renderer]);
		return Object.freeze({
			armReachCount: 1,
			browserExecutable: "/opt/chromium",
			browserRoot,
			child,
			childExit: Object.freeze({ code: null, signal: "SIGKILL" }),
			controllerPgid: 9000,
			databaseName: `phase-2e6-${ordinal}`,
			databaseCreateCountAfterSeed: 0,
			databaseDeleteCount: 0,
			databaseIdentityPreserved: true,
			edgeId: edge.id,
			expectedState,
			frozenForest: forest,
			initialForest: forest,
			killedGroups: Object.freeze([
				Object.freeze({
					absent: true as const,
					killAccepted: true as const,
					pgid: browserPid,
					role: "browser" as const,
					rootPid: browserPid,
				}),
				Object.freeze({
					absent: true as const,
					killAccepted: true as const,
					pgid: childPid,
					role: "child" as const,
					rootPid: childPid,
				}),
			] as const),
			mainThreadAtomicsWaitCalls: 0,
			operationTransactionCount: 1,
			publicResultDeliveries: 0,
			profilePath,
			reachedRequestedArm: true,
			recoveredDatabaseName: `phase-2e6-${ordinal}`,
			recordedProcessDeaths: Object.freeze(
				forest.map(({ birthToken, pid }) =>
					Object.freeze({ birthToken, currentBirthToken: null, outcome: "absent" as const, pid })
				)
			),
			recoveredImage: phase2e6OracleImages(edge.scenarioId)[expectedState],
			recoveryResult: "OK",
			scenarioOperation: row.operation,
			sentinelRetained: true,
			tracePrefix: phase2e6ExpectedTracePrefix(edge),
			unsupported: false,
			workerCrossOriginIsolated: true,
			workerRealm: true,
			writeRequestCount: phase2e6ExpectedTracePrefix(edge).filter(
				({ id, kind }) => kind === "request-success" && /-(?:add|put)-/u.test(id)
			).length,
			head:
				row.operation === "swapHead"
					? Object.freeze({
							kind: "swap" as const,
							monotone: true,
							new: `head-${ordinal + 1}`,
							old: oldHead,
							recovered: expectedState === "old" ? oldHead : `head-${ordinal + 1}`,
						})
					: Object.freeze({ kind: "unchanged" as const, old: oldHead, recovered: oldHead }),
		});
	});
	return Object.freeze({
		cases: Object.freeze(cases),
		competingRecovery: Object.freeze({ future: "MONOTONE", rollback: "MONOTONE", same: "MONOTONE" }),
		staleExpectedRevision: "HEAD_CONFLICT",
	});
}

function replaceCase(
	campaign: Phase2e6CampaignEvidence,
	index: number,
	patch: Partial<Phase2e6CaseEvidence>
): Phase2e6CampaignEvidence {
	return {
		...campaign,
		cases: campaign.cases.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
	};
}

describe("Phase 2e6 real process-death acceptance contract", () => {
	it("derives exactly the durability-distinguishing matrix and occurrence-sensitive prefixes", () => {
		expect(PHASE_2E6_DECLARED_EDGES).toHaveLength(18);
		expect(PHASE_2E6_DECLARED_EDGES.filter(({ target }) => target === "request")).toHaveLength(10);
		expect(PHASE_2E6_DECLARED_EDGES.filter(({ target }) => target === "transaction-terminal")).toHaveLength(8);
		expect(new Set(PHASE_2E6_DECLARED_EDGES.map(({ id }) => id)).size).toBe(PHASE_2E6_DECLARED_EDGES.length);
		for (const edge of PHASE_2E6_DECLARED_EDGES) {
			const prefix = phase2e6ExpectedTracePrefix(edge);
			expect(prefix.at(-1)?.kind).toBe(edge.target === "request" ? "request-success" : "transaction-complete");
			expect(new Set(prefix.map(({ id }) => id)).size).toBe(prefix.length);
		}
		const orderedRows = phase2e6OracleImages("begin-generation-certificate-match").new
			.generations as readonly Readonly<{ generationId: string; objectId: string }>[];
		expect(orderedRows.map(({ generationId, objectId }) => [objectId, generationId])).toEqual([
			[`phase-2e6-object:${"a".repeat(32)}`, "a".repeat(64)],
			[`phase-2e6-object:${"a".repeat(32)}`, "b".repeat(64)],
			[`phase-2e6-sentinel:${"f".repeat(32)}`, "f".repeat(64)],
		]);
	});

	it("rejects every required causal and anti-vacuity mutant", () => {
		const control = validCampaign();
		expect(phase2e6CampaignErrors(control)).toEqual([]);
		const first = required(control.cases[0], "first case");
		const swapIndex = control.cases.findIndex(({ scenarioOperation }) => scenarioOperation === "swapHead");
		const malformed: readonly Phase2e6CampaignEvidence[] = [
			{ ...control, cases: control.cases.slice(1) },
			{ ...control, cases: [first, ...control.cases] },
			{ ...control, cases: [required(control.cases[1], "second case"), first, ...control.cases.slice(2)] },
			replaceCase(control, 0, { reachedRequestedArm: false, armReachCount: 0 }),
			replaceCase(control, 0, { armReachCount: 2 }),
			replaceCase(control, 0, { unsupported: true }),
			replaceCase(control, 0, { browserRoot: first.child }),
			replaceCase(control, 0, { killedGroups: [] as unknown as Phase2e6CaseEvidence["killedGroups"] }),
			replaceCase(control, 0, { childExit: { code: 0, signal: null } }),
			replaceCase(control, 0, { recordedProcessDeaths: first.recordedProcessDeaths.slice(1) }),
			replaceCase(control, 0, {
				recordedProcessDeaths: first.recordedProcessDeaths.map((death, index) =>
					index === 0 ? { ...death, currentBirthToken: death.birthToken, outcome: "reused" } : death
				),
			}),
			replaceCase(control, 0, { writeRequestCount: 0 }),
			replaceCase(control, 0, { databaseDeleteCount: 1, databaseIdentityPreserved: false }),
			replaceCase(control, 0, { databaseCreateCountAfterSeed: 1 }),
			replaceCase(control, 0, { recoveredImage: partialImage("partial") }),
			replaceCase(control, 0, { publicResultDeliveries: 1 }),
			replaceCase(control, 0, { operationTransactionCount: 2 }),
			replaceCase(control, 0, { tracePrefix: first.tracePrefix.slice(0, -1) }),
			replaceCase(control, swapIndex, {
				head: { kind: "swap", old: "old", new: "new", recovered: "old", monotone: false },
			}),
			{ ...control, staleExpectedRevision: "OK" as "HEAD_CONFLICT" },
			{ ...control, competingRecovery: { ...control.competingRecovery, rollback: "REGRESSED" as "MONOTONE" } },
		];
		for (const mutant of malformed) expect(phase2e6CampaignErrors(mutant)).not.toEqual([]);
	});

	it("binds every closed artifact to the reviewed candidate, campaign, edge, profile, and database", () => {
		const control = validCampaign();
		const provenance = Object.freeze({ campaignId: "phase-2e6-contract", gitSha: "a".repeat(40) });
		const artifacts = control.cases.map(
			(evidence, index): Phase2e6ArtifactEnvelope =>
				Object.freeze({
					campaignId: provenance.campaignId,
					evidence,
					gitSha: provenance.gitSha,
					runId: phase2e6RunId(required(PHASE_2E6_DECLARED_EDGES[index], "edge"), index),
					schemaVersion: 1,
				})
		);
		const controls = {
			competingRecovery: control.competingRecovery,
			staleExpectedRevision: control.staleExpectedRevision,
		};
		expect(phase2e6CampaignErrors(phase2e6CampaignFromArtifacts(artifacts, controls, provenance))).toEqual([]);

		const withArtifact = (index: number, artifact: unknown): readonly unknown[] =>
			artifacts.map((value, itemIndex) => (itemIndex === index ? artifact : value));
		const first = required(artifacts[0], "first artifact");
		const second = required(artifacts[1], "second artifact");
		const malformed: readonly (readonly unknown[])[] = [
			withArtifact(0, { ...first, gitSha: "b".repeat(40) }),
			withArtifact(0, { ...first, campaignId: "another-campaign" }),
			withArtifact(0, { ...first, runId: "wrong-edge" }),
			withArtifact(0, { ...first, extra: true }),
			withArtifact(1, { ...second, evidence: { ...second.evidence, profilePath: first.evidence.profilePath } }),
			withArtifact(1, { ...second, evidence: { ...second.evidence, databaseName: first.evidence.databaseName } }),
		];
		for (const values of malformed) expect(() => phase2e6CampaignFromArtifacts(values, controls, provenance)).toThrow();
	});
});
