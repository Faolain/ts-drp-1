// Analyzer fixtures only: these programs are not production substitutes or adapter acceptance gates.
import { expect } from "vitest";

import { sharedDecisionViolations } from "../analyzers/shared-decision-analyzer.js";

const SHARED_RUNTIME_EXPORTS = Object.freeze([
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);

/** Runs positive and negative analyzer fixtures without gating production syntax. */
export function assertSharedDecisionAnalyzerCases(): void {
	const control = `import { ${SHARED_RUNTIME_EXPORTS.filter((name) => !name.startsWith("LIVE_JOURNAL_")).join(
		", "
	)} } from "@ts-drp/live-journal";\nexport function owner() { const captured = captureLiveJournalInput({}); if (captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (observed) return observed; const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate; return deriveLiveJournalSnapshot({}); }`;
	expect(sharedDecisionViolations(control, "control.ts")).toEqual([]);
	const frozenFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
		(name) => !name.startsWith("LIVE_JOURNAL_")
	).join(
		", "
	)} } from "@ts-drp/live-journal";\nexport function createStore() { return Object.freeze({ installGenesis: async (input: unknown) => { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; }, appendAccepted: async (input: unknown) => { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; }, readiness: async (input: unknown) => { const snapshot = deriveLiveJournalSnapshot(input); return snapshot; }, readPage: async () => true, close: async () => true }); }`;
	expect(sharedDecisionViolations(frozenFacadeControl, "frozen-facade-control.ts")).toEqual([]);
	const localShorthandFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
		(name) => !name.startsWith("LIVE_JOURNAL_")
	).join(
		", "
	)} } from "@ts-drp/live-journal";\nexport function createStore() { const installGenesis = async (input: unknown) => { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; }; const appendAccepted = async (input: unknown) => { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; }; const readiness = async (input: unknown) => deriveLiveJournalSnapshot(input); const readPage = async () => true; const close = async () => true; return Object.freeze({ installGenesis, appendAccepted, readiness, readPage, close }); }`;
	expect(sharedDecisionViolations(localShorthandFacadeControl, "local-shorthand-facade-control.ts")).toEqual([]);
	const classFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
		(name) => !name.startsWith("LIVE_JOURNAL_")
	).join(
		", "
	)} } from "@ts-drp/live-journal";\nclass Store { async installGenesis(input: unknown) { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; } async appendAccepted(input: unknown) { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; } async readiness(input: unknown) { return deriveLiveJournalSnapshot(input); } async readPage() { return true; } async close() { return true; } } export function createStore() { return Object.freeze(new Store()); }`;
	expect(sharedDecisionViolations(classFacadeControl, "class-facade-control.ts")).toEqual([]);
	expect(
		sharedDecisionViolations(
			control.replace("const duplicate = decideLiveJournalDuplicate({})", "void decideLiveJournalDuplicate({})"),
			"discarded.ts"
		)
	).toContain("discarded-result:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			control.replace(
				"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
				"function dead() { return null; decideLiveJournalDuplicate({}); }"
			),
			"dead.ts"
		)
	).toContain("unreachable:decideLiveJournalDuplicate");
	const immediateControl = control
		.replace(
			"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
			"const duplicate = runImmediateLiveJournalDecision(() => decideLiveJournalDuplicate({})); if (duplicate) return duplicate;"
		)
		.replace(
			"export function owner()",
			"const runImmediateLiveJournalDecision = (callback: () => unknown) => callback();\nexport function owner()"
		);
	expect(sharedDecisionViolations(immediateControl, "immediate-control.ts")).toEqual([]);
	expect(
		sharedDecisionViolations(immediateControl.replace("=> callback();", "=> true;"), "ignored-callback.ts")
	).toContain("unreachable:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			immediateControl.replace("const runImmediateLiveJournalDecision =", "let runImmediateLiveJournalDecision ="),
			"reassigned-invoker.ts"
		)
	).toContain("unreachable:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			control.replace(
				"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
				"const unused = () => decideLiveJournalDuplicate({});"
			),
			"uninvoked-callback.ts"
		)
	).toContain("unreachable:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			control.replace("if (duplicate) return duplicate;", "if (false) return duplicate;"),
			"uncontrolled.ts"
		)
	).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			control.replace(
				"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
				"const duplicate = decideLiveJournalDuplicate({}); const Never = class { value() { return duplicate; } }; void Never; return true;"
			),
			"nested-class-never-controls.ts"
		)
	).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
	expect(
		sharedDecisionViolations(
			control.replace(
				"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
				"const duplicate = decideLiveJournalDuplicate({}); const never = () => duplicate; return true;"
			),
			"nested-never-controls.ts"
		)
	).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
	const aliased = control
		.replace("decideLiveJournalDuplicate", "decideLiveJournalDuplicate as decideDuplicate")
		.replaceAll("decideLiveJournalDuplicate({})", "decideDuplicate({})");
	expect(sharedDecisionViolations(aliased, "aliased-control.ts")).toEqual([]);
	const namespace = control
		.replace(/import \{[^;]+\} from "@ts-drp\/live-journal";/u, 'import * as journal from "@ts-drp/live-journal";')
		.replaceAll("captureLiveJournalInput(", "journal.captureLiveJournalInput(")
		.replaceAll("classifyLiveJournalMutationObservation(", "journal.classifyLiveJournalMutationObservation(")
		.replaceAll("decideLiveJournalDuplicate(", "journal.decideLiveJournalDuplicate(")
		.replaceAll("deriveLiveJournalSnapshot(", "journal.deriveLiveJournalSnapshot(");
	expect(sharedDecisionViolations(namespace, "namespace-control.ts")).toEqual([]);
	const delegated = control
		.replace("export function owner()", "function delegatedOwner()")
		.concat("\nexport function owner() { return delegatedOwner(); }");
	expect(sharedDecisionViolations(delegated, "delegated-control.ts")).toEqual([]);
	// Analyzer fixtures only: these event programs are semantic corpus cases, never production substitutes.
	const eventDrivenPositive = control.replace(
		"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
		'let eventDecision: unknown; const eventTarget = new EventTarget(); eventTarget.addEventListener("decision", () => { eventDecision = decideLiveJournalDuplicate({}); }, { once: true }); eventTarget.dispatchEvent(new Event("decision")); if (eventDecision) return eventDecision;'
	);
	expect(sharedDecisionViolations(eventDrivenPositive, "event-callback-controls-outcome.ts")).toEqual([]);
	const eventDrivenNegative = control.replace(
		"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
		'let eventDecision: unknown; const eventTarget = new EventTarget(); eventTarget.addEventListener("decision", () => { eventDecision = decideLiveJournalDuplicate({}); }, { once: true }); if (eventDecision) return eventDecision;'
	);
	expect(sharedDecisionViolations(eventDrivenNegative, "event-callback-never-dispatched.ts")).toContain(
		"unreachable:decideLiveJournalDuplicate"
	);
}
