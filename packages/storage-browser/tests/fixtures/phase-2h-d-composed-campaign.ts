import type { Phase2hAggregate } from "./phase-2h-a-aggregate.js";
import type { Phase2hValidationRecord } from "./phase-2h-a-record.js";
import {
	type Phase2hEngineName,
	PHASE_2H_ENGINES,
	PHASE_2H_KILL_TUPLE_IDS,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_TUPLES,
} from "./phase-2h-a-registry.js";

export type Phase2hCampaignCheckpoint = "browser-surfaces-complete" | "non-kill-complete" | "campaign-complete";

export interface Phase2hCampaignCheckpointOptions {
	readonly checkpoint: Phase2hCampaignCheckpoint;
	readonly engine: Phase2hEngineName;
	validateProcessRecord?(record: Phase2hValidationRecord): void;
}

const BROWSER_SURFACE_SCENARIOS = new Set(["browser-store", "crypto-digest", "worker-responsiveness"]);
const NON_KILL_TUPLE_IDS = Object.freeze(PHASE_2H_REQUIRED_TUPLE_IDS.slice(0, 15));

function completedEngines(engine: Phase2hEngineName): ReadonlySet<Phase2hEngineName> {
	const index = PHASE_2H_ENGINES.indexOf(engine);
	return new Set(PHASE_2H_ENGINES.slice(0, index + 1));
}

function missingRequiredRecords(aggregate: Phase2hAggregate, requiredTupleIds: readonly string[]): readonly string[] {
	const accepted = new Set(aggregate.records.map(({ tupleId }) => tupleId));
	return requiredTupleIds.filter((tupleId) => !accepted.has(tupleId));
}

function diagnosticErrors(aggregate: Phase2hAggregate): string[] {
	const errors: string[] = [];
	for (const field of ["duplicateTupleIds", "extraTupleIds", "invalidRecordIds"] as const) {
		if (aggregate[field].length > 0) errors.push(`${field} must be empty`);
	}
	return errors;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Checks the three explicit boundaries of the serial Phase 2h browser campaign.
 * Intermediate boundaries require every phase-owned record produced through the
 * current project and permit monotonic growth from prior projects. The final
 * WebKit boundary closes the complete ordered census and its causal evidence.
 * @param aggregate - Current parent-owned campaign aggregate.
 * @param options - One of the three bounded checkpoint contracts.
 * @returns Checkpoint violations; an empty array means the boundary is valid.
 */
export function phase2hCampaignCheckpointErrors(
	aggregate: Phase2hAggregate,
	options: Phase2hCampaignCheckpointOptions
): readonly string[] {
	const errors = diagnosticErrors(aggregate);
	const engines = completedEngines(options.engine);

	if (options.checkpoint === "browser-surfaces-complete") {
		const required = PHASE_2H_TUPLES.filter(
			({ engine, scenario }) => engines.has(engine) && BROWSER_SURFACE_SCENARIOS.has(scenario)
		).map(({ tupleId }) => tupleId);
		for (const tupleId of missingRequiredRecords(aggregate, required)) errors.push(`missing ${tupleId}`);
		return errors;
	}

	if (options.checkpoint === "non-kill-complete") {
		const required = NON_KILL_TUPLE_IDS.filter((tupleId) =>
			[...engines].some((engine) => tupleId.endsWith(`/${engine}`))
		);
		for (const tupleId of missingRequiredRecords(aggregate, required)) errors.push(`missing ${tupleId}`);
		return errors;
	}

	if (options.engine !== "webkit") errors.push("campaign-complete is owned by webkit");
	const acceptedTupleIds = aggregate.records.map(({ tupleId }) => tupleId);
	if (!sameStrings(acceptedTupleIds, PHASE_2H_REQUIRED_TUPLE_IDS)) errors.push("records must be the exact ordered 69");
	if (aggregate.missingTupleIds.length > 0) errors.push("missingTupleIds must be empty");
	if (aggregate.missingKillPoints.length > 0) errors.push("missingKillPoints must be empty");
	if (aggregate.verdict !== "pass") errors.push("verdict must be pass");
	if (options.validateProcessRecord === undefined) {
		errors.push("process-record validator is required");
		return errors;
	}
	const records = new Map(aggregate.records.map((record) => [record.tupleId, record]));
	for (const tupleId of PHASE_2H_KILL_TUPLE_IDS) {
		const record = records.get(tupleId);
		if (record === undefined) continue;
		options.validateProcessRecord(record);
	}
	return errors;
}
