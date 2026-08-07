import { parseStorageObjectId } from "@ts-drp/storage";

import { FIXTURE_OBJECT_ID } from "../fixtures/fixture-records.js";

/**
 * Reports the closed RED failure for one isolated child role.
 * @param role - Isolated child role.
 */
export function reportInertRole(role: "settled" | "arming" | "crash"): void {
	const parsed = parseStorageObjectId(FIXTURE_OBJECT_ID);
	if (!parsed.ok) throw new TypeError(`invalid Phase 2b ${role}-child object ID`);
	process.send?.({
		kind: "failure",
		version: 1,
		code: "DRIVER_NOT_IMPLEMENTED",
		detail: `${role} role is inert in RED`,
	});
}
