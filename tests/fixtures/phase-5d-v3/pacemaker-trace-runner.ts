import type {
	ItfTrace,
	ItfTraceState,
	PacemakerEvent,
	PacemakerStatus,
	PacemakerTraceDriver,
} from "./pacemaker-types.js";

const TRACE_KEYS = [
	"#meta",
	"durableCommitQcCount",
	"durablePrepareQcCount",
	"durableRevision",
	"futureBucketCount",
	"lastEvent",
	"n",
	"phase",
	"pendingRoundChangeCount",
	"round",
	"valueDigest",
] as const;
const TRACE_VARS = [
	"lastEvent",
	"n",
	"round",
	"phase",
	"valueDigest",
	"durableRevision",
	"futureBucketCount",
	"pendingRoundChangeCount",
	"durablePrepareQcCount",
	"durableCommitQcCount",
];

function exactKeys(value: object): readonly string[] {
	return Reflect.ownKeys(value)
		.filter((key): key is string => typeof key === "string")
		.sort();
}

/**
 * Rejects malformed or semantically inconsistent closed ITF traces.
 * @param trace - Candidate trace.
 */
export function assertClosedItfTrace(trace: ItfTrace): void {
	if (trace["#meta"].format !== "ITF" || trace.vars.join(",") !== TRACE_VARS.join(",")) {
		throw new Error("TRACE_SCHEMA_MISMATCH");
	}
	if (trace.states.length < 2) throw new Error("TRACE_TOO_SHORT");
	for (const [index, state] of trace.states.entries()) {
		if (state["#meta"].index !== index || exactKeys(state).join(",") !== [...TRACE_KEYS].sort().join(",")) {
			throw new Error("TRACE_SCHEMA_MISMATCH");
		}
		if (![4, 5, 6, 7].includes(state.n) || !Number.isSafeInteger(state.round) || state.round < 0) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		const previous = trace.states[index - 1];
		if (previous === undefined) {
			if (
				state.lastEvent !== "init" ||
				state.round !== 0 ||
				state.durableRevision !== 0 ||
				state.pendingRoundChangeCount !== 0 ||
				state.durablePrepareQcCount !== 0 ||
				state.durableCommitQcCount !== 0
			) {
				throw new Error("TRACE_STATE_MISMATCH");
			}
			continue;
		}
		if (state.n !== previous.n || state.durableRevision < previous.durableRevision) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			state.pendingRoundChangeCount < 0 ||
			state.durablePrepareQcCount < 0 ||
			state.durableCommitQcCount < 0 ||
			state.durablePrepareQcCount < previous.durablePrepareQcCount ||
			state.durableCommitQcCount < previous.durableCommitQcCount
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		const unchangedRound = new Set([
			"commit-qc",
			"commit-vote",
			"crash",
			"far-future-one",
			"finalized",
			"one-round-change",
			"prepare-qc",
			"prepare-vote",
			"proposal",
			"restart",
			"round-change",
		]);
		if (unchangedRound.has(state.lastEvent) && state.round !== previous.round) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "timeout" && state.round !== previous.round + 1) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			state.lastEvent === "timeout" &&
			(state.durableRevision !== previous.durableRevision + 1 ||
				state.pendingRoundChangeCount !== previous.pendingRoundChangeCount + 1)
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "proposal" && state.durableRevision !== previous.durableRevision + 1) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			state.lastEvent === "prepare-qc" &&
			(state.durableRevision !== previous.durableRevision + (previous.lastEvent === "proposal" ? 2 : 1) ||
				state.durablePrepareQcCount !== previous.durablePrepareQcCount + 1 ||
				state.pendingRoundChangeCount !== previous.pendingRoundChangeCount)
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			state.lastEvent === "commit-qc" &&
			(state.durableRevision !== previous.durableRevision + 1 ||
				state.durableCommitQcCount !== previous.durableCommitQcCount + 1 ||
				state.pendingRoundChangeCount !== previous.pendingRoundChangeCount)
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			(state.lastEvent === "crash" || state.lastEvent === "restart" || state.lastEvent === "round-change") &&
			(state.durableRevision !== previous.durableRevision ||
				state.pendingRoundChangeCount !== previous.pendingRoundChangeCount ||
				state.durablePrepareQcCount !== previous.durablePrepareQcCount ||
				state.durableCommitQcCount !== previous.durableCommitQcCount)
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (
			(state.lastEvent === "f-plus-one-catchup" || state.lastEvent === "far-future-qc") &&
			state.round <= previous.round
		) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "one-round-change" && (state.futureBucketCount !== 1 || state.round !== 0)) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "far-future-one" && state.futureBucketCount !== 0) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "commit-qc" && state.phase !== "finalized") {
			throw new Error("TRACE_STATE_MISMATCH");
		}
		if (state.lastEvent === "crash" && state.pendingRoundChangeCount === 0) {
			throw new Error("TRACE_STATE_MISMATCH");
		}
	}
}

function matchesState(expected: ItfTraceState, actual: PacemakerStatus): boolean {
	return (
		actual.round === expected.round &&
		actual.phase === expected.phase &&
		actual.durableRevision === expected.durableRevision &&
		actual.bufferedFutureRounds === expected.futureBucketCount &&
		actual.pendingRoundChangeCount === expected.pendingRoundChangeCount &&
		actual.durablePrepareQcCount === expected.durablePrepareQcCount &&
		actual.durableCommitQcCount === expected.durableCommitQcCount &&
		(actual.finalizedValueDigest ?? actual.lockedValueDigest ?? "") === expected.valueDigest
	);
}

/**
 * Replays a checked ITF trace against a future product driver.
 * @param trace - Checked closed trace.
 * @param driver - Product-backed replay driver.
 */
export async function replayCheckedTrace(
	trace: ItfTrace,
	driver: PacemakerTraceDriver
): Promise<readonly PacemakerEvent[]> {
	assertClosedItfTrace(trace);
	try {
		for (const state of trace.states) {
			const actual = await driver.apply(state);
			if (!matchesState(state, actual)) {
				throw new Error(
					`TRACE_STATE_MISMATCH:${state["#meta"].index}:${JSON.stringify({ actual, expected: state })}`
				);
			}
		}
		return driver.events();
	} finally {
		await driver.close();
	}
}

/**
 * Converts an ordered product event stream into a model replay program.
 * @param events - Consecutive product events.
 * @param importPath - Module path used by the generated executable replay.
 * @returns Standalone Quint replay source.
 */
export function implementationEventsToQuintTest(
	events: readonly PacemakerEvent[],
	importPath = "../packages/seal/formal/seal-pacemaker"
): string {
	let previous = -1;
	const steps = events.flatMap((event) => {
		if (
			exactKeys(event).join(",") !== "anchor,epoch,kind,objectId,phase,qcDigest,round,sequence,signerId,valueDigest"
		) {
			throw new Error("MODEL_REPLAY_REQUIRED");
		}
		if (
			event.epoch !== 0 ||
			typeof event.anchor !== "string" ||
			typeof event.objectId !== "string" ||
			typeof event.signerId !== "string" ||
			!Number.isSafeInteger(event.round) ||
			event.round < 0 ||
			!Number.isSafeInteger(event.sequence) ||
			event.sequence < 0 ||
			(event.qcDigest !== null && !/^[0-9a-f]{64}$/u.test(event.qcDigest)) ||
			!/^([0-9a-f]{64}|value-X)$/u.test(event.valueDigest)
		) {
			throw new Error("MODEL_REPLAY_REQUIRED");
		}
		if (event.kind === "restart" && event.sequence === 0) previous = -1;
		if (event.sequence !== previous + 1) throw new Error("MODEL_REPLAY_REQUIRED");
		previous = event.sequence;
		const candidate = `qc(${event.round}, "${event.phase}", "${event.valueDigest}", 4)`;
		switch (event.kind) {
			case "vote_cast":
				return [`      .then(persistVoteSet(${candidate}))`];
			case "qc_formed":
				return [`      .then(formQc("A", ${candidate}))`];
			case "lock_acquired":
				return [`      .then(deliverPrepareQc("A", ${candidate}, 0))`];
			case "finalized":
				return [`      .then(deliverCommitQc("A", ${candidate}, 0))`];
			case "round_entered":
				return ['      .then(enterRound("A"))'];
			case "restart":
				return ["      .then(restart)"];
			default:
				throw new Error(`MODEL_EVENT_UNSUPPORTED:${event.kind}`);
		}
	});
	return [
		"module generatedPacemakerReplay {",
		`  import sealPacemaker.* from "${importPath}"`,
		"  run replay =",
		"    initN(4)",
		...steps,
		"}",
		"",
	].join("\n");
}

function actionsForState(state: ItfTraceState): readonly string[] {
	const transitionValueDigest =
		state.lastEvent === "proposal" && state.valueDigest === "" ? "value-X" : state.valueDigest;
	const candidate = `qc(${state.round}, "${state.lastEvent.startsWith("commit") ? "commit" : "prepare"}", ${JSON.stringify(transitionValueDigest)}, ${state.n})`;
	const commitCandidate = `qc(${state.round}, "commit", ${JSON.stringify(state.valueDigest)}, ${state.n})`;
	switch (state.lastEvent) {
		case "proposal":
			return [
				`acceptProposal("A", bundle(${state.round}, ${JSON.stringify(transitionValueDigest)}, ${state.n}))`,
				`persistVoteSet(${candidate})`,
			];
		case "prepare-vote":
			return [`persistVoteSet(${candidate})`];
		case "prepare-qc":
			return [
				`formQc("A", ${candidate})`,
				`deliverPrepareQc("A", ${candidate}, 0)`,
				`persistCommitVoteSet(${commitCandidate})`,
			];
		case "commit-vote":
			return [`persistCommitVoteSet(${candidate})`];
		case "commit-qc":
			return [`formQc("A", ${candidate})`, `deliverCommitQc("A", ${candidate}, 0)`];
		case "timeout":
			return ['enterRound("A")'];
		case "one-round-change":
			return [`observeFutureRound("A", ${state.round + 1}, 1)`];
		case "f-plus-one-catchup":
			return [`observeFutureRound("A", ${state.round}, 2)`];
		case "far-future-one":
			return ['observeFutureRound("A", 10, 1)'];
		case "far-future-qc":
			return [`observeFutureQc("A", qc(${state.round}, "prepare", ${JSON.stringify(state.valueDigest)}, ${state.n}))`];
		case "crash":
			return ["crash"];
		case "restart":
			return ["restart"];
		case "finalized":
		case "init":
		case "round-change":
			return [];
		default:
			throw new Error(`TRACE_EVENT_UNSUPPORTED:${state.lastEvent}`);
	}
}

/**
 * Converts one closed ITF trace into an executable Quint run against the real model actions.
 * @param trace - Hash-bound trace selected by the product RED manifest.
 * @param importPath - Module-relative path to the shipped pacemaker model.
 * @returns Standalone Quint module source with state checks after every step.
 */
export function checkedTraceToQuintModule(trace: ItfTrace, importPath: string): string {
	assertClosedItfTrace(trace);
	const initial = trace.states[0];
	if (initial === undefined) throw new Error("TRACE_TOO_SHORT");
	const expressions = [`initN(${initial.n})`];
	for (const state of trace.states) {
		expressions.push(...actionsForState(state));
		const modelValueDigest =
			state.lastEvent === "proposal" && state.valueDigest === "" ? "value-X" : state.valueDigest;
		const value = JSON.stringify(modelValueDigest);
		expressions.push(
			`check(state.enteredRound.get("A") == ${state.round} and state.phase.get("A") == "${state.phase}" and state.revision == ${state.durableRevision} and state.futureRounds.size() == ${state.futureBucketCount} and state.durableOutbox.size() == ${state.pendingRoundChangeCount} and state.durablePrepareQcs.size() == ${state.durablePrepareQcCount} and state.durableCommitQcs.size() == ${state.durableCommitQcCount} and (if (state.finalizedValue.get("A") != EMPTY) state.finalizedValue.get("A") else if (state.lockedValue.get("A") != EMPTY) state.lockedValue.get("A") else state.proposedValue.get("A")) == ${value})`
		);
	}
	return [
		"module checkedPacemakerTrace {",
		`  import sealPacemaker.* from "${importPath}"`,
		"  run checkedTrace =",
		`    ${expressions[0]}`,
		...expressions.slice(1).map((expression) => `      .then(${expression})`),
		"}",
		"",
	].join("\n");
}
