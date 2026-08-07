import { describe, expect, it } from "vitest";

import { aggregatePassArtifacts } from "./fixtures/artifacts.js";
import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";

type MutableRecord = Record<string, unknown>;

interface RuntimeMutant {
	readonly label: string;
	mutate(campaign: MutableRecord[]): void;
}

function record(value: unknown, label: string): MutableRecord {
	if (typeof value !== "object" || value === null) throw new TypeError(`${label} must be an object`);
	return value as MutableRecord;
}

function records(value: unknown, label: string): MutableRecord[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
	return value.map((item) => record(item, label));
}

function cloneCampaign(): MutableRecord[] {
	return structuredClone(validCorrectiveCampaign()) as unknown as MutableRecord[];
}

function tuple(campaign: MutableRecord[]): MutableRecord {
	const artifact = campaign.find((candidate) => candidate.runKind === "tuple");
	if (artifact === undefined) throw new TypeError("tuple fixture is absent");
	return artifact;
}

function control(campaign: MutableRecord[], runKind: "discovery" | "arming"): MutableRecord {
	const artifact = campaign.find((candidate) => candidate.runKind === runKind);
	if (artifact === undefined) throw new TypeError(`${runKind} fixture is absent`);
	return artifact;
}

const RUNTIME_MUTANTS: readonly RuntimeMutant[] = Object.freeze([
	{
		label: "rejects a recovered digest that disagrees with the tuple state",
		mutate: (campaign): void => {
			tuple(campaign).recoveredFixtureRecordsDigest = record(tuple(campaign).expectedDigests, "digests").new;
		},
	},
	{
		label: "rejects tuple scalar durability that disagrees with the terminal hit",
		mutate: (campaign): void => {
			const observedHits = records(tuple(campaign).observedHits, "tuple hits");
			const terminal = observedHits.at(-1);
			if (terminal === undefined) throw new TypeError("terminal tuple hit is absent");
			terminal.transactionDurability = "strict";
		},
	},
	{
		label: "rejects a discovery hit stream that violates the exact 3/11 durability sequence",
		mutate: (campaign): void => {
			for (const hit of records(control(campaign, "discovery").observedHits, "discovery hits")) {
				hit.transactionDurability = "strict";
			}
		},
	},
	{
		label: "rejects an arming hit stream that violates the exact 3/11 durability sequence",
		mutate: (campaign): void => {
			for (const hit of records(control(campaign, "arming").observedHits, "arming hits")) {
				hit.transactionDurability = "strict";
			}
		},
	},
	{
		label: "rejects killed-group roots that disagree with the child and browser roots",
		mutate: (campaign): void => {
			const group = records(tuple(campaign).killedGroups, "killed groups")[0];
			if (group === undefined) throw new TypeError("browser killed group is absent");
			group.rootPid = 99_001;
		},
	},
	{
		label: "rejects killed-group PGIDs that disagree with root process identities",
		mutate: (campaign): void => {
			const group = records(tuple(campaign).killedGroups, "killed groups")[0];
			if (group === undefined) throw new TypeError("browser killed group is absent");
			group.pgid = 99_002;
		},
	},
	{
		label: "rejects a death proof whose recorded forest omits an owned renderer",
		mutate: (campaign): void => {
			const forest = tuple(campaign).recordedForest;
			if (!Array.isArray(forest) || forest.length < 3) throw new TypeError("tuple forest fixture is incomplete");
			forest.pop();
		},
	},
	{
		label: "rejects death identities that disagree with the recorded forest birth identity",
		mutate: (campaign): void => {
			const death = records(tuple(campaign).recordedProcessDeaths, "process deaths")[0];
			if (death === undefined) throw new TypeError("process death is absent");
			death.birthToken = "Fri Aug  7 23:59:59 2026";
		},
	},
	{
		label: "rejects process-death cardinality that does not cover the recorded forest",
		mutate: (campaign): void => {
			const deaths = tuple(campaign).recordedProcessDeaths;
			if (!Array.isArray(deaths) || deaths.length === 0) throw new TypeError("process deaths are absent");
			deaths.pop();
		},
	},
	{
		label: "rejects a reused-process claim whose birth token proves the original process survived",
		mutate: (campaign): void => {
			const death = records(tuple(campaign).recordedProcessDeaths, "process deaths")[0];
			if (death === undefined) throw new TypeError("process death is absent");
			death.outcome = "reused";
			death.currentBirthToken = death.birthToken;
		},
	},
]);

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b corrective persisted pass revalidation", () => {
	it("accepts the self-contained exact sixteen-artifact positive control", () => {
		expect(aggregatePassArtifacts(cloneCampaign())).toEqual({
			artifactCount: 16,
			tupleCount: 14,
			discoveryCount: 1,
			armingCount: 1,
			old: 13,
			new: 1,
			mixed: 0,
			notReachedDurability: 3,
			strictDurability: 11,
			missingKillPoints: [],
		});
	});

	it.each(RUNTIME_MUTANTS)("$label", ({ mutate }) => {
		const campaign = cloneCampaign();
		mutate(campaign);
		expect(() => aggregatePassArtifacts(campaign)).toThrow(TypeError);
	});
});
