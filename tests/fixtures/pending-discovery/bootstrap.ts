import type { RestartBootstrap } from "./types.js";
const keys = [
	"identity",
	"catalogDigest",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"pinnedGenesisAnchorDigest",
	"expectedPreviousRoomHead",
	"expectedNextRoomHead",
].sort();
/**
 * Run the named pending-only fixture seam.
 * @param value - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function validateBootstrap(value: unknown): RestartBootstrap {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		JSON.stringify(Reflect.ownKeys(value).sort()) !== JSON.stringify(keys)
	)
		throw new Error("PENDING_BOOTSTRAP_EXACT_KEYS");
	for (const key of keys) {
		const carrier = Reflect.get(value, key);
		if (key.startsWith("expected")) {
			if (
				carrier === null ||
				typeof carrier !== "object" ||
				JSON.stringify(Object.keys(carrier).sort()) !== JSON.stringify(["currentAnchorDigest", "epoch", "objectId"])
			)
				throw new Error("PENDING_HEAD_EXACT_KEYS");
		} else if (typeof carrier !== "string") throw new Error("PENDING_BOOTSTRAP_CARRIER_TYPE");
	}
	return value as RestartBootstrap;
}
