const OBJECT_ACL_DETERMINISTIC_ERROR = Symbol.for("@ts-drp/object/ObjectACLDeterministicError");

/**
 * Marker for deterministic domain rejections raised by the built-in ACL.
 * Custom ACLs may reuse this public type when they enforce the same
 * replica-independent rejection contract.
 */
export class ObjectACLDeterministicError extends Error {
	readonly [OBJECT_ACL_DETERMINISTIC_ERROR] = true;
}

/**
 * Recognizes the marker across duplicate installed copies of `@ts-drp/object`.
 * `instanceof` alone would silently turn deterministic rejections from another
 * copy into transient quarantine.
 * @param error - Candidate rejection.
 * @returns Whether the candidate carries the deterministic ACL marker.
 */
export function isObjectACLDeterministicError(error: unknown): error is ObjectACLDeterministicError {
	if (error instanceof ObjectACLDeterministicError) return true;
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
	try {
		return Reflect.get(error, OBJECT_ACL_DETERMINISTIC_ERROR) === true;
	} catch {
		return false;
	}
}
