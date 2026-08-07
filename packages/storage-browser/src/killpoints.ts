import manifest from "../killpoints.json" with { type: "json" };

export const KILL_POINT_MANIFEST = Object.freeze(manifest);

export type KillPointId = keyof typeof manifest;
export type KillEdge = "before" | "after";

export interface KillPoint {
	readonly edge: KillEdge;
	readonly id: KillPointId;
}

export interface KillHit extends KillPoint {
	readonly transactionDurability: "not-reached" | "strict";
}

const EDGES: readonly KillEdge[] = Object.freeze(["before", "after"]);

/**
 * Returns the manifest-derived fourteen ordered kill tuples.
 * @returns Frozen before/after tuples in ordinal order.
 */
export function orderedKillPoints(): readonly KillPoint[] {
	const entries = Object.entries(KILL_POINT_MANIFEST);
	const ordinals = entries.map((entry) => entry[1]).sort((left, right) => left - right);
	if (entries.length !== 7 || ordinals.some((ordinal, index) => ordinal !== index)) {
		throw new TypeError("kill-point manifest must be an ID-to-ordinal bijection over 0..6");
	}
	return Object.freeze(
		entries
			.sort((left, right) => left[1] - right[1])
			.flatMap(([id]) => EDGES.map((edge) => Object.freeze({ id: id as KillPointId, edge })))
	);
}
