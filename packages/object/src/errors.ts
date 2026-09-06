import { DRPError } from "@ts-drp/errors";
import { type ApplyResult, type Hash } from "@ts-drp/types";

const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");

/** The frontier changed too often for a bounded adoption commit to succeed. */
export class AdoptionCommitExhaustedError extends DRPError {
	readonly vertexHash: Hash;
	readonly attempts: number;
	partialResult?: ApplyResult;

	/**
	 * @param vertexHash - Vertex whose prepared adoption could not commit.
	 * @param attempts - Number of bounded frontier CAS attempts.
	 */
	constructor(vertexHash: Hash, attempts: number) {
		super("ADOPTION_COMMIT_EXHAUSTED", `Failed to commit vertex ${vertexHash} after ${attempts} frontier CAS attempts`);
		this.name = "AdoptionCommitExhaustedError";
		this.vertexHash = vertexHash;
		this.attempts = attempts;
	}
}

/** An internal apply invariant failed while preserving any available partial result. */
export class ApplyInvariantError extends AggregateError {
	readonly [DRP_ERROR_BRAND] = true;
	readonly code = "APPLY_INVARIANT";
	partialResult?: ApplyResult;

	/**
	 * @param errors - Failures that caused the invariant violation.
	 * @param message - Human-readable diagnostic text.
	 * @param options - Standard aggregate-error options.
	 */
	constructor(errors: Iterable<unknown>, message?: string, options?: ErrorOptions) {
		super(errors, message, options);
		this.name = "ApplyInvariantError";
	}
}

/** A request attempted to replace the locally derived root ACL authority. */
export class RootACLMutationError extends DRPError {
	/**
	 * @param message - Human-readable diagnostic text.
	 */
	constructor(message: string) {
		super("ROOT_ACL_MUTATION_FORBIDDEN", message);
		this.name = "RootACLMutationError";
	}
}
