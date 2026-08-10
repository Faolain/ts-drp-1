import { type Phase2hAggregate, type Phase2hAggregationInput } from "./phase-2h-a-aggregate.js";
import { type Phase2hRecordExpectation, type Phase2hRecordValidation } from "./phase-2h-a-record.js";
import { PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_REQUIRED_TUPLE_IDS } from "./phase-2h-a-registry.js";

export interface Phase2hContractSubject {
	aggregate(input: Phase2hAggregationInput): Phase2hAggregate;
	validateRecord(value: unknown, expected: Phase2hRecordExpectation): Phase2hRecordValidation;
}

/**
 * Authorized 2h-a RED candidate. It truthfully reports the inert zero-record
 * campaign but deliberately has no record-validation or diagnostic behavior.
 * GREEN must implement this seam; tests never import the reference oracle as
 * the candidate. GREEN cleanup must promote the validated record/aggregate
 * functions into one natural test-infrastructure owner, wire this subject to
 * that owner, and remove the reference/inert parallel ownership. It must not
 * retain two implementations or add a ceremonial delegate around copied logic.
 */
export const PHASE_2H_A_INERT_CANDIDATE: Phase2hContractSubject = Object.freeze({
	aggregate(input: Phase2hAggregationInput): Phase2hAggregate {
		return Object.freeze({
			artifactKind: "ts-drp/ahe-storage-validation/v1",
			duplicateTupleIds: Object.freeze([]),
			extraTupleIds: Object.freeze([]),
			gitSha: input.gitSha,
			invalidRecordIds: Object.freeze([]),
			missingKillPoints: PHASE_2H_KILL_TUPLE_IDS,
			missingTupleIds: PHASE_2H_REQUIRED_TUPLE_IDS,
			records: Object.freeze([]),
			requiredTupleIds: PHASE_2H_REQUIRED_TUPLE_IDS,
			runId: input.runId,
			schemaVersion: 1,
			verdict: "fail",
		});
	},
	validateRecord(): Phase2hRecordValidation {
		return Object.freeze({ errors: Object.freeze(["candidate rejects every record"]), record: null });
	},
});
