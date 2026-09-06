export const WORKER_HOST_ERROR_CODES = Object.freeze([
	"worker-host-aborted",
	"worker-host-cancelled",
	"worker-host-closed",
	"worker-host-consumer-abandoned",
	"worker-host-handshake-timeout",
	"worker-host-invalid-option",
	"worker-host-item-failed",
	"worker-host-limit-exceeded",
	"worker-host-protocol-violation",
	"worker-host-queue-overflow",
	"worker-host-source-failed",
	"worker-host-task-failed",
	"worker-host-worker-terminated",
] as const);

export type WorkerHostErrorCode = (typeof WORKER_HOST_ERROR_CODES)[number];

const WORKER_HOST_ERROR_CODE_SET: ReadonlySet<string> = new Set(WORKER_HOST_ERROR_CODES);
const WORKER_HOST_ERROR_BRAND = Symbol.for("@ts-drp/worker-host/WorkerHostError");

/** Construction details for a branded worker-host failure. */
export interface WorkerHostErrorOptions {
	readonly cause?: unknown;
	readonly detail?: Readonly<Record<string, unknown>>;
	readonly suppressed?: readonly unknown[];
}

/** The sole coded error class exposed by the worker-host package. */
export class WorkerHostError extends Error {
	readonly code: WorkerHostErrorCode;
	readonly detail: Readonly<Record<string, unknown>>;
	readonly suppressed: readonly unknown[];

	/**
	 * Creates one branded error.
	 * @param code - Registered worker-host error code.
	 * @param message - Human-readable failure summary.
	 * @param options - Immutable detail, cause, and suppressed failures.
	 */
	constructor(code: WorkerHostErrorCode, message: string, options: WorkerHostErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WorkerHostError";
		this.code = code;
		this.detail = Object.freeze({ ...options.detail });
		this.suppressed = Object.freeze([...(options.suppressed ?? [])]);
		Object.defineProperty(this, WORKER_HOST_ERROR_BRAND, {
			configurable: false,
			enumerable: false,
			value: true,
			writable: false,
		});
	}
}

/**
 * Returns whether a value carries the worker-host brand and a registered code.
 * @param value - Candidate value.
 * @returns Whether the candidate belongs to the worker-host taxonomy.
 */
export function isWorkerHostError(value: unknown): value is WorkerHostError {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		const candidate = value as Readonly<Record<PropertyKey, unknown>>;
		return (
			candidate[WORKER_HOST_ERROR_BRAND] === true &&
			typeof candidate.code === "string" &&
			WORKER_HOST_ERROR_CODE_SET.has(candidate.code)
		);
	} catch {
		return false;
	}
}

/**
 * Creates a consistently coded synchronous configuration error.
 * @param name - Invalid option name.
 * @param value - Rejected option value.
 * @returns The branded invalid-option error.
 */
export function invalidOption(name: string, value: unknown): WorkerHostError {
	return new WorkerHostError("worker-host-invalid-option", `Invalid ${name}`, {
		detail: { name, value },
	});
}
