import { PHASE_2E6_DECLARED_EDGES } from "./phase-2e6-real-process-death-contract.js";

export const PHASE_2H_ENGINES = Object.freeze(["chromium", "firefox", "webkit"] as const);
export type Phase2hEngineName = (typeof PHASE_2H_ENGINES)[number];

export const PHASE_2H_SCENARIOS = Object.freeze([
	"crypto-digest",
	"worker-responsiveness",
	"browser-store",
	"capacity",
	"quota-fault",
	"process-death",
] as const);
export type Phase2hScenario = (typeof PHASE_2H_SCENARIOS)[number];

export const PHASE_2H_NON_KILL_SCENARIOS = Object.freeze([
	"crypto-digest",
	"worker-responsiveness",
	"browser-store",
	"capacity",
	"quota-fault",
] as const);

export const PHASE_2H_CONTRACT_EDGE_IDS = Object.freeze([
	"begin-generation-empty/request-02-put-generations/after",
	"begin-generation-empty/transaction-terminal-complete/after",
	"begin-generation-certificate-match/request-02-put-generations/after",
	"begin-generation-certificate-match/transaction-terminal-complete/after",
	"put-cached-blob-staged/request-03-add-blobs/after",
	"put-cached-blob-staged/transaction-terminal-complete/after",
	"promote-reference-staged/request-04-add-promotions/after",
	"promote-reference-staged/transaction-terminal-complete/after",
	"complete-generation-empty-recovery/request-05-put-generations/after",
	"complete-generation-empty-recovery/transaction-terminal-complete/after",
	"swap-head-certificate-match/request-04-put-generations/after",
	"swap-head-certificate-match/request-05-put-objects/after",
	"swap-head-certificate-match/transaction-terminal-complete/after",
	"swap-head-fresh-recovery/request-05-put-generations/after",
	"swap-head-fresh-recovery/request-06-put-objects/after",
	"swap-head-fresh-recovery/transaction-terminal-complete/after",
	"discard-generation-staged/request-02-put-generations/after",
	"discard-generation-staged/transaction-terminal-complete/after",
] as const);

export interface Phase2hTupleDescriptor {
	readonly edge: (typeof PHASE_2E6_DECLARED_EDGES)[number] | null;
	readonly engine: Phase2hEngineName;
	readonly killEdge: "after:request" | "after:transaction-terminal" | null;
	readonly killPointId: string | null;
	readonly scenario: Phase2hScenario;
	readonly tupleId: string;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

const authoritativeIds = PHASE_2E6_DECLARED_EDGES.map(({ id }) => id);
if (!sameStrings(authoritativeIds, PHASE_2H_CONTRACT_EDGE_IDS)) {
	throw new TypeError("Phase 2h process-death edge projection drifted from the ratified 18-edge contract");
}

const nonKill = PHASE_2H_NON_KILL_SCENARIOS.flatMap((scenario) =>
	PHASE_2H_ENGINES.map(
		(engine): Phase2hTupleDescriptor =>
			Object.freeze({
				edge: null,
				engine,
				killEdge: null,
				killPointId: null,
				scenario,
				tupleId: `${scenario}/${engine}`,
			})
	)
);

const kill = PHASE_2E6_DECLARED_EDGES.flatMap((edge) =>
	PHASE_2H_ENGINES.map(
		(engine): Phase2hTupleDescriptor =>
			Object.freeze({
				edge,
				engine,
				killEdge: `${edge.edge}:${edge.target}`,
				killPointId: edge.id,
				scenario: "process-death",
				tupleId: `${edge.id}/${engine}`,
			})
	)
);

export const PHASE_2H_TUPLES: readonly Phase2hTupleDescriptor[] = Object.freeze([...nonKill, ...kill]);
export const PHASE_2H_REQUIRED_TUPLE_IDS: readonly string[] = Object.freeze(
	PHASE_2H_TUPLES.map(({ tupleId }) => tupleId)
);
export const PHASE_2H_KILL_TUPLE_IDS: readonly string[] = Object.freeze(kill.map(({ tupleId }) => tupleId));

if (
	PHASE_2E6_DECLARED_EDGES.length !== 18 ||
	PHASE_2H_REQUIRED_TUPLE_IDS.length !== 69 ||
	PHASE_2H_KILL_TUPLE_IDS.length !== 54 ||
	new Set(PHASE_2H_REQUIRED_TUPLE_IDS).size !== PHASE_2H_REQUIRED_TUPLE_IDS.length
) {
	throw new TypeError("Phase 2h 15 + 18 × 3 registry checksum failed");
}

const tupleById = new Map(PHASE_2H_TUPLES.map((tuple) => [tuple.tupleId, tuple]));

/**
 * Resolves one exact registry member without accepting aliases.
 * @param value - Candidate tuple identity.
 * @returns The derived tuple descriptor when present.
 */
export function phase2hTuple(value: unknown): Phase2hTupleDescriptor | undefined {
	return typeof value === "string" ? tupleById.get(value) : undefined;
}
