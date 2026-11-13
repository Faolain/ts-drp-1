import { readFileSync } from "node:fs";

import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import ts from "typescript";

// The owner's journal observation projection (C1), compiled from its own declarations for source-transpiling harnesses:
// creatorIssuanceMaintenanceObservationCarriers holds a drain control's plan by digest through
// closedJournalObservationControl. Bindings are the owner's own primitives (the close's one encode cap).
const CLOSED_RETIREMENT_BYTES = { maxBytes: 786_432, maxItems: 65_536, maxDepth: 128 };
export const CLOSED_JOURNAL_OBSERVATION_OWNERS = ["closedJournalDrainPlanCarriers", "closedJournalObservationRowsDigest",
	"closedJournalObservationControl"] as const;

const source = readFileSync(new URL("../../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found === undefined) throw new Error(`missing source owner ${name}`);
	return found.getText(parsed);
}

/** The owner's closedJournalObservationControl (and its plan owner), compiled with the owner's primitives. */
export function compileClosedJournalObservationOwner(maintenanceWidthAtom: symbol = Symbol("maintenance-width")): Readonly<{
	closedJournalObservationControl: (control: unknown, digestOf?: (items: unknown) => unknown) => unknown;
	closedJournalDrainPlanCarriers: (plan: unknown, digestOf: (items: unknown) => unknown,
		build?: Readonly<{ record: (fields: Record<string, unknown>) => unknown; array: (items: readonly unknown[]) => unknown }>) =>
		Readonly<{ plan: unknown; observed: unknown }>;
	closedJournalObservationRowsDigest: (items: unknown) => string;
}> {
	const closedRetirementBytes = (value: unknown) => encodeCanonical(value, CLOSED_RETIREMENT_BYTES);
	const closedRetirementDigest = (domain: string, ...bytes: readonly Uint8Array[]) =>
		[...hashDomain(domain, ...bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	const requireLaw = (ok: boolean, reason = "internal-invariant") => { if (!ok) throw new TypeError(reason); };
	return new Function("closedRetirementBytes", "closedRetirementDigest", "requireLaw", "maintenanceWidthAtom",
		`"use strict"; ${CLOSED_JOURNAL_OBSERVATION_OWNERS.map(name => ts.transpile(declaration(name), { target: ts.ScriptTarget.ES2022 }))
			.join("\n")}; return {${CLOSED_JOURNAL_OBSERVATION_OWNERS.join(", ")}};`)(
		closedRetirementBytes, closedRetirementDigest, requireLaw, maintenanceWidthAtom);
}
