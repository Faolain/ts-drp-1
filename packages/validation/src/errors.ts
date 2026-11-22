import { DRPError } from "@ts-drp/errors";
import { type ZodError } from "zod";

/**
 * A custom error class for DRP validation errors
 */
export class DRPValidationError extends DRPError {
	zodError: ZodError;

	/**
	 * @param zodError - The zod error
	 */
	constructor(zodError: ZodError) {
		super("DRP_VALIDATION", zodError.message, { cause: zodError });
		this.zodError = zodError;
		this.name = "DRPValidationError";
	}
}

/**
 * A custom error class for invalid hash errors
 */
export class InvalidHashError extends DRPError {
	/**
	 * @param message - The message of the error
	 */
	constructor(message: string = "Invalid hash") {
		super("INVALID_HASH", message);
		this.name = "InvalidHashError";
	}
}

/**
 * A custom error class for invalid dependencies errors
 */
export class InvalidDependenciesError extends DRPError {
	/**
	 * @param message - The message of the error
	 */
	constructor(message: string = "Invalid dependencies") {
		super("INVALID_DEPENDENCIES", message);
		this.name = "InvalidDependenciesError";
	}
}

/**
 * A custom error class for invalid timestamp errors
 */
export class InvalidTimestampError extends DRPError {
	/**
	 * @param message - The message of the error
	 */
	constructor(message: string = "Invalid timestamp") {
		super("INVALID_TIMESTAMP", message);
		this.name = "InvalidTimestampError";
	}
}

/** An unexpected caller-supplied graph access failure during vertex validation. */
export class VertexValidationError extends DRPError {
	/**
	 * @param cause - Exact caller-supplied throwable that interrupted validation.
	 * @param message - Human-readable diagnostic text.
	 */
	constructor(cause: unknown, message: string = "Vertex validation failed") {
		super("VERTEX_VALIDATION_FAILED", message, { cause });
		this.name = "VertexValidationError";
	}
}
