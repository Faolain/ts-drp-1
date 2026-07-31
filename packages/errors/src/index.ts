const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");

/**
 * Stable machine-readable error codes published by the deterministic DRP packages.
 *
 * Published codes are append-only API commitments. Messages remain diagnostic text.
 */
export const DRP_ERROR_CODES = Object.freeze([
	"ADMISSIBLE",
	"ADMISSION_CONTEXT_INVALID",
	"ADMISSION_CONTEXT_UNPREPARED",
	"ADOPTION_COMMIT_EXHAUSTED",
	"APPLY_INVARIANT",
	"AUTHORIZATION_EXCEPTION",
	"AUTHORIZATION_UNAVAILABLE",
	"AUTHOR_KEY_RESOLVER_UNAVAILABLE",
	"CANONICAL_DECODING",
	"CANONICAL_ENCODING",
	"CAUSALITY_VIOLATION",
	"CONFLICT_RESOLVER_FAILED",
	"CRYPTO_SUITE_UNAVAILABLE",
	"CYCLE",
	"DEPENDENCY_ACCEPTANCE_ORACLE_UNAVAILABLE",
	"DEPENDENCY_DOMAIN_MISMATCH",
	"DEPENDENCY_RESOLVER_UNAVAILABLE",
	"DEPENDENCY_WRONG_ANCHOR",
	"DEPENDENCY_WRONG_EPOCH",
	"DETERMINISTIC_INVARIANT_VALIDATOR_UNAVAILABLE",
	"DRP_VALIDATION",
	"DUPLICATE_DEPENDENCY",
	"DUPLICATE_VERTEX",
	"EMPTY_QC",
	"EPOCH_CAPACITY_EXCEEDED",
	"EPOCH_FULL",
	"FUTURE_EPOCH",
	"FUTURE_PROTOCOL",
	"INVALID_ANCHOR",
	"INVALID_BYTE_CHARGES",
	"INVALID_CONFLICT_ACTION",
	"INVALID_CONFLICT_RESULT",
	"INVALID_DEPENDENCIES",
	"INVALID_DEPENDENCY_ENVELOPE",
	"INVALID_HASH",
	"INVALID_LOGICAL_TIME",
	"INVALID_MULTIPLE_RESULT",
	"INVALID_OPERATION_SCHEMA",
	"INVALID_ORDER",
	"INVALID_SIGNATURE",
	"INVALID_TIMESTAMP",
	"INVALID_VERTEX",
	"INVALID_VERTEX_KIND",
	"INVARIANT_VIOLATION",
	"KEY_HASH_MISMATCH",
	"LEGACY_PROTOCOL",
	"LIMIT_EXCEEDED",
	"MALFORMED_VERTEX",
	"MISSING_ANCHOR",
	"MISSING_CONFLICT_RESOLVER",
	"MISSING_CURRENT_EPOCH_DEPENDENCIES",
	"MISSING_DEPENDENCIES",
	"MISSING_DEPENDENCY",
	"MISSING_VERTEX",
	"MIXED_QC",
	"MULTIPLE_ROOTS",
	"NON_ANTICHAIN_DEPENDENCIES",
	"NON_CANONICAL_ENVELOPE",
	"NON_CONVERGENT_CONFLICT_POLICY",
	"OBJECT_ACL_DETERMINISTIC",
	"OPERATION_SCHEMA_VALIDATOR_UNAVAILABLE",
	"ROOT_ACL_MUTATION_FORBIDDEN",
	"STALE_EPOCH",
	"UNACCEPTED_DEPENDENCIES",
	"UNAUTHORIZED",
	"UNKNOWN_MODE",
	"UNSUPPORTED_PROFILE",
	"VERTEX_VALIDATION_FAILED",
	"WRONG_ANCHOR",
	"WRONG_EPOCH",
	"WRONG_OBJECT",
] as const);

/** Every stable public DRP error code. */
export type DRPErrorCode = (typeof DRP_ERROR_CODES)[number];

const DRP_ERROR_CODE_SET: ReadonlySet<string> = new Set(DRP_ERROR_CODES);

/** Base class for stable, machine-classifiable DRP failures. */
export class DRPError extends Error {
	readonly [DRP_ERROR_BRAND] = true;

	/**
	 * Creates a coded DRP error.
	 * @param code - Stable machine-readable error code.
	 * @param message - Human-readable diagnostic text.
	 * @param options - Standard error options, including a causal throwable.
	 */
	constructor(
		readonly code: DRPErrorCode,
		message?: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "DRPError";
	}
}

/**
 * Recognizes catalogued DRP errors across duplicate installed package copies.
 * Hostile accessors and proxies are treated as non-members.
 * @param value - Candidate value.
 * @returns Whether the value carries the global brand and a registered code.
 */
export function isDRPError(value: unknown): value is DRPError {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		return Reflect.get(value, DRP_ERROR_BRAND) === true && DRP_ERROR_CODE_SET.has(Reflect.get(value, "code"));
	} catch {
		return false;
	}
}
