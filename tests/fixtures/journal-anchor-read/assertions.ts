import type { AnchorCase } from "./material.js";

export interface AnchorEvidence {
	readonly before: unknown;
	readonly after: unknown;
	readonly expectedBytes: readonly number[];
	readonly expectedScope: unknown;
	readonly getterReads: number;
	readonly results: readonly unknown[];
	readonly traces: readonly Record<string, unknown>[];
}

/**
 *
 * @param value - Actual native report, including independently expected material.
 * @param id - One causal scenario, not a Cartesian policy matrix.
 * @returns The exact accessor outcomes required by the accepted contract.
 */
export function expectedAnchorOutcomes(value: AnchorEvidence, id: AnchorCase): readonly unknown[] {
	const present = {
		exactCanonicalAnchorPreimageBytes: value.expectedBytes,
		frozen: true,
		kind: "present",
		ok: true,
		scope: value.expectedScope,
		scopeFrozen: true,
	};
	const missing = { kind: "missing", ok: true };
	const budget = { kind: "read-budget-exceeded", ok: false };
	const poison = { kind: "store-poisoned", ok: false };
	if (id === "genesis" || id === "non-genesis" || id === "capture") return [present, present];
	if (id === "neighbor-missing") return [missing];
	if (id === "smaller-budget" || id === "zero") return [budget, missing, present];
	if (id === "oversize") return [budget, missing];
	if (id === "invalid-input") return Array(11).fill({ kind: "malformed-input", ok: false });
	if (id === "close") return [{ kind: "store-closed", ok: false }, true];
	if (id === "capture-close") return [{ kind: "store-closed", ok: false }];
	if (id === "executing-close") return [present, { kind: "store-closed", ok: false }];
	if (id === "independent-session") return [{ kind: "store-closed", ok: false }, present];
	if (id === "poison-close") return [poison, poison];
	if (id === "native-failure") return [{ kind: "substrate-failure", ok: false }, missing, present];
	if (id === "replace-delete") return [present, missing, poison];
	if (id === "unrelated-carriers") return [present];
	return [poison];
}
