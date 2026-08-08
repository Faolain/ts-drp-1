import { type KillPoint } from "../../src/killpoints.js";

/**
 * Returns the deliberately non-vacuous expected recovery for one tuple.
 * @param point - Manifest-derived tuple.
 * @returns New only at transaction-complete/after; old otherwise.
 */
export function expectedFixtureState(point: KillPoint): "old" | "new" {
	return point.id === "transaction-complete" && point.edge === "after" ? "new" : "old";
}

/**
 * Returns the exact Worker-owned durability expected at one literal hit.
 * @param point - Manifest-derived tuple.
 * @returns The frozen three-not-reached/eleven-strict value.
 */
export function expectedHitDurability(point: KillPoint): "not-reached" | "strict" {
	return point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
		? "not-reached"
		: "strict";
}
