/* eslint-disable import/export -- runtime mutant intentionally shadows four re-exported decisions. */
// Runtime mutant fixture: this exercises real adapter behavior and is not a production substitute.
import * as real from "@ts-drp/live-journal";
export * from "@ts-drp/live-journal"; // Preserve every real runtime export except the explicit mutants below.

type AnyDecision = (...arguments_: readonly unknown[]) => unknown;

const capture = real.captureLiveJournalInput as AnyDecision;
const duplicate = real.decideLiveJournalDuplicate as AnyDecision;
const observation = real.classifyLiveJournalMutationObservation as AnyDecision;
const snapshot = real.deriveLiveJournalSnapshot as AnyDecision;

function mode(): unknown {
	return Reflect.get(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__");
}

/**
 * Mutates the real captured-input result only while the external harness arms it.
 * @param arguments_ The genuine shared owner's arguments.
 * @returns The genuine or externally mutated decision.
 */
export function captureLiveJournalInput(...arguments_: readonly unknown[]): unknown {
	const result = capture(...arguments_);
	return mode() === "capture" ? flipDecision(result) : result;
}

function flipDecision(value: unknown): unknown {
	if (typeof value === "boolean") return !value;
	if (typeof value === "string") return `phase-3a1b-p4-mutated:${value}`;
	if (typeof value !== "object" || value === null) return Symbol("phase-3a1b-p4-mutated-decision");
	return new Proxy(value, {
		get(target, key, receiver): unknown {
			const actual = Reflect.get(target, key, receiver);
			if (typeof actual === "boolean") return !actual;
			if (typeof actual === "string") return `phase-3a1b-p4-mutated:${actual}`;
			throw new TypeError("PHASE_3A1B_P4_SHARED_DECISION_RESULT_CONSUMED");
		},
	});
}

/**
 * Replaces only the duplicate decision when the external harness arms it.
 * @param arguments_ The real helper's arguments.
 * @returns The real or deliberately flipped decision.
 */
export function decideLiveJournalDuplicate(...arguments_: readonly unknown[]): unknown {
	const result = duplicate(...arguments_);
	return mode() === "duplicate" ? flipDecision(result) : result;
}

/**
 * Replaces only the post-commit observation decision when the external harness arms it.
 * @param arguments_ The real helper's arguments.
 * @returns The real or deliberately flipped decision.
 */
export function classifyLiveJournalMutationObservation(...arguments_: readonly unknown[]): unknown {
	const result = observation(...arguments_);
	return mode() === "observation" ? flipDecision(result) : result;
}

/**
 * Mutates the real snapshot derivation only while the external harness arms it.
 * @param arguments_ The genuine shared owner's arguments.
 * @returns The genuine or externally mutated decision.
 */
export function deriveLiveJournalSnapshot(...arguments_: readonly unknown[]): unknown {
	const result = snapshot(...arguments_);
	return mode() === "snapshot" ? flipDecision(result) : result;
}
