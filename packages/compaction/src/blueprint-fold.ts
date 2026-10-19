import {
	type CanonicalLimits,
	compareBytes,
	decodeCanonical,
	deepCloneCanonical,
	encodeCanonical,
	hashDomain,
} from "@ts-drp/canonical";
import { DRPError } from "@ts-drp/errors";
import {
	applyPreparedBlueprintOperation,
	applyPreparedBlueprintOperationToCanonicalState,
	type BlueprintExecutionContext,
	type PreparedBlueprintRuntime,
} from "@ts-drp/protocol-v3/blueprint-application";
import type { IStagedStateMachine } from "@ts-drp/types";

import { copyExactByteCarrier, copyTrustedBytes } from "./exact-byte-carrier.js";
import { topologicalOrder } from "./linearize.js";
import type { EpochVertex } from "./types.js";

const APPLICATION_STATE_DOMAIN = "ts-drp/state/v3";
const APPLICATION_LIMITS: Readonly<CanonicalLimits> = Object.freeze({
	maxBytes: 32_768,
	maxDepth: 16,
	maxItems: 16_384,
});
export interface BlueprintStateSnapshot {
	readonly blueprintDigest: string;
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

export interface BlueprintStateMachineInput {
	/** Negotiated encoded state/output byte ceiling; standalone callers retain the original default. */
	readonly maxApplicationStateBytes?: number;
	readonly exactCanonicalInitialStateBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
	readonly expectedInitialStateDigest: string;
	readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
}

/** Never exported or delivered to a callback. The private brand, rather than
 * a prototype/shape/symbol property, selects a genuine owner's fork capture. */
class OwnedBlueprintForkInput implements BlueprintStateMachineInput {
	readonly #source: BlueprintStateMachine;
	constructor(source: BlueprintStateMachine, readonly exactCanonicalInitialStateBytes: Uint8Array,
		readonly expectedBlueprintDigest: string, readonly expectedInitialStateDigest: string,
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime, readonly maxApplicationStateBytes: number) {
		this.#source = source;
	}
	static source(input: BlueprintStateMachineInput): BlueprintStateMachine | undefined {
		return typeof input === "object" && input !== null && #source in input ? input.#source : undefined;
	}
}

function hex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function stateDigest(bytes: Uint8Array): string {
	return hex(hashDomain(APPLICATION_STATE_DOMAIN, bytes));
}

function applicationStateFailure(message: string, cause?: unknown): never {
	throw new DRPError("INVALID_APPLICATION_STATE", message, cause === undefined ? undefined : { cause });
}

function assertPreparedRuntimeProvenance(
	expectedBlueprintDigest: string,
	preparedBlueprintRuntime: PreparedBlueprintRuntime
): void {
	try {
		applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation: null,
			preparedBlueprintRuntime,
			state: null,
		});
	} catch (error) {
		if (error instanceof DRPError && error.code === "BLUEPRINT_OPERATION_INVALID") return;
		throw error;
	}
	throw new DRPError("BLUEPRINT_OPERATION_INVALID", "null unexpectedly matched a prepared blueprint operation");
}

function validatedApplicationState(
	value: unknown,
	limits: Readonly<CanonicalLimits>
): { readonly bytes: Uint8Array; readonly value: unknown } {
	try {
		const bytes = encodeCanonical(value, limits);
		// The decode is both bounded validation and a detached canonical value.
		// Its result belongs to this apply only; it carries no admission authority.
		return { bytes, value: decodeCanonical(bytes, limits) };
	} catch (error) {
		return applicationStateFailure("application value is outside the bounded canonical domain", error);
	}
}

function decodeInitialState(
	input: Uint8Array,
	expectedDigest: string,
	limits: Readonly<CanonicalLimits>
): { readonly bytes: Uint8Array; readonly value: unknown } {
	let bytes: Uint8Array;
	try {
		bytes = copyExactByteCarrier(input, "initial application state");
	} catch (error) {
		return applicationStateFailure("initial application state bytes are unreadable", error);
	}
	if (!/^[0-9a-f]{64}$/u.test(expectedDigest) || stateDigest(bytes) !== expectedDigest) {
		return applicationStateFailure("initial application state digest does not match exact bytes");
	}
	try {
		const value = decodeCanonical(bytes, limits);
		const reencoded = encodeCanonical(value, limits);
		if (compareBytes(bytes, reencoded) !== 0) {
			return applicationStateFailure("initial application state bytes are noncanonical");
		}
		return { bytes, value };
	} catch (error) {
		if (error instanceof DRPError) throw error;
		return applicationStateFailure("initial application state bytes are invalid", error);
	}
}

/** A bounded v3 blueprint state machine with explicit fork/adopt semantics. */
export class BlueprintStateMachine implements IStagedStateMachine<BlueprintStateSnapshot, unknown, unknown> {
	readonly #expectedBlueprintDigest: string;
	readonly #preparedBlueprintRuntime: PreparedBlueprintRuntime;
	readonly #applicationLimits: Readonly<CanonicalLimits>;
	#baseGeneration: object | undefined;
	#exactCanonicalStateBytes: Uint8Array;
	#generation: object = {};
	#parent: BlueprintStateMachine | undefined;
	/** A pure function of the owned immutable bytes, hashed on first read: an
	 * epoch fold publishes one digest, not one per intermediate state. */
	#stateDigest: string | undefined;

	constructor(input: BlueprintStateMachineInput) {
		const owned = OwnedBlueprintForkInput.source(input);
		if (owned !== undefined) {
			// Only replacement-only private representations are shared. apply()
			// passes state through the original runtime's detached input boundary,
			// then publishes independently validated replacements; snapshot()
			// always copies bytes. No caller/reducer can mutate these retained facts.
			this.#applicationLimits = owned.#applicationLimits;
			this.#expectedBlueprintDigest = owned.#expectedBlueprintDigest;
			this.#preparedBlueprintRuntime = owned.#preparedBlueprintRuntime;
			this.#exactCanonicalStateBytes = owned.#exactCanonicalStateBytes;
			this.#stateDigest = owned.#stateDigest;
			return;
		}
		const maxBytes = input.maxApplicationStateBytes ?? APPLICATION_LIMITS.maxBytes;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			applicationStateFailure("configured application byte ceiling is invalid");
		this.#applicationLimits = Object.freeze({ ...APPLICATION_LIMITS, maxBytes });
		const initial = decodeInitialState(input.exactCanonicalInitialStateBytes, input.expectedInitialStateDigest, this.#applicationLimits);
		if (!/^[0-9a-f]{64}$/u.test(input.expectedBlueprintDigest)) {
			throw new DRPError("BLUEPRINT_DIGEST_MISMATCH", "expected blueprint digest is invalid");
		}
		assertPreparedRuntimeProvenance(input.expectedBlueprintDigest, input.preparedBlueprintRuntime);
		this.#expectedBlueprintDigest = input.expectedBlueprintDigest;
		this.#preparedBlueprintRuntime = input.preparedBlueprintRuntime;
		this.#exactCanonicalStateBytes = initial.bytes;
		this.#stateDigest = input.expectedInitialStateDigest;
	}

	adopt(staged: IStagedStateMachine<BlueprintStateSnapshot, unknown, unknown>): BlueprintStateSnapshot {
		if (!(staged instanceof BlueprintStateMachine) || staged.#parent !== this) {
			throw new DRPError("BLUEPRINT_ALREADY_ADOPTED", "staged machine does not belong to this parent");
		}
		if (staged.#baseGeneration !== this.#generation) {
			throw new DRPError("BLUEPRINT_ALREADY_ADOPTED", "staged transition is stale or already adopted");
		}
		// Both machines own these unexposed immutable representations. Even a
		// consumed stage may keep applying/forking: those paths detach inputs and
		// replace fields, so neither machine can mutate the other's state.
		this.#exactCanonicalStateBytes = staged.#exactCanonicalStateBytes;
		this.#stateDigest = staged.#stateDigest;
		this.#generation = {};
		staged.#baseGeneration = undefined;
		staged.#parent = undefined;
		return this.snapshot();
	}

	apply(operation: unknown, executionContext?: BlueprintExecutionContext): unknown {
		// The owned bytes are the exact encoding of the validated state, so the
		// runtime decodes them for the reducer instead of re-encoding that state,
		// and returns the next state as the bytes its clone would have decoded.
		const result = applyPreparedBlueprintOperationToCanonicalState({
			expectedBlueprintDigest: this.#expectedBlueprintDigest,
			...(executionContext === undefined ? {} : { executionContext }),
			exactCanonicalStateBytes: this.#exactCanonicalStateBytes,
			operation,
			preparedBlueprintRuntime: this.#preparedBlueprintRuntime,
			stateLimits: this.#applicationLimits,
		});
		// Complete both validations before publishing any machine field. State
		// and output are independently decoded, even when the reducer aliases them.
		// Bytes that decode within the application limits are exactly what
		// validatedApplicationState(clone) would publish (encoding the decoded
		// clone reproduces them); otherwise that validation runs for its refusal.
		const nextState = result.stateWithinLimits ? { bytes: result.exactCanonicalStateBytes } :
			validatedApplicationState(decodeCanonical(result.exactCanonicalStateBytes), this.#applicationLimits);
		const output = validatedApplicationState(result.output, this.#applicationLimits);
		this.#exactCanonicalStateBytes = nextState.bytes;
		this.#stateDigest = undefined;
		this.#generation = {};
		return output.value;
	}

	#digest(): string {
		return this.#stateDigest ??= stateDigest(this.#exactCanonicalStateBytes);
	}

	fork(): BlueprintStateMachine {
		const fork = new BlueprintStateMachine(new OwnedBlueprintForkInput(this, this.#exactCanonicalStateBytes,
			this.#expectedBlueprintDigest, this.#digest(), this.#preparedBlueprintRuntime, this.#applicationLimits.maxBytes));
		fork.#baseGeneration = this.#generation;
		fork.#parent = this;
		return fork;
	}

	snapshot(): BlueprintStateSnapshot {
		return Object.freeze({
			blueprintDigest: this.#expectedBlueprintDigest,
			exactCanonicalStateBytes: copyTrustedBytes(this.#exactCanonicalStateBytes),
			stateDigest: this.#digest(),
		});
	}
}

export interface BlueprintAuthorizationInput {
	readonly hash: string;
	readonly operation: unknown;
}

export interface FoldBlueprintEpochInput {
	readonly anchorHash: string;
	readonly authorize?: ((input: BlueprintAuthorizationInput) => boolean) | undefined;
	readonly executionContext?: ((input: BlueprintAuthorizationInput) => BlueprintExecutionContext) | undefined;
	readonly machine: BlueprintStateMachine;
	readonly vertices: ReadonlyMap<string, EpochVertex>;
}

export interface FoldBlueprintEpochResult {
	adopt(): BlueprintStateSnapshot;
	readonly order: readonly string[];
	readonly outputs: readonly unknown[];
	readonly staged: BlueprintStateSnapshot;
}

/** Applies one complete active epoch atomically to an isolated machine fork. */
export function foldBlueprintEpoch(input: FoldBlueprintEpochInput): FoldBlueprintEpochResult {
	const order = topologicalOrder(input.vertices, input.anchorHash).filter((hash) => hash !== input.anchorHash);
	const stagedMachine = input.machine.fork();
	const outputs: unknown[] = [];
	for (const hash of order) {
		const vertex = input.vertices.get(hash);
		if (vertex === undefined) throw new DRPError("INVALID_APPLICATION_STATE", `ordered vertex ${hash} is missing`);
		if (input.authorize === undefined) {
			throw new DRPError("BLUEPRINT_AUTHORIZATION_REQUIRED", "blueprint authorization is required");
		}
		let authorized: unknown;
		try {
			authorized = input.authorize(Object.freeze({ hash, operation: deepCloneCanonical(vertex.operation) }));
		} catch (error) {
			throw new DRPError("BLUEPRINT_AUTHORIZATION_REJECTED", "blueprint authorization threw", { cause: error });
		}
		if (authorized !== true) {
			throw new DRPError("BLUEPRINT_AUTHORIZATION_REJECTED", "blueprint operation was not authorized");
		}
		let executionContext: BlueprintExecutionContext | undefined;
		if (input.executionContext !== undefined) {
			try {
				executionContext = input.executionContext(
					Object.freeze({ hash, operation: deepCloneCanonical(vertex.operation) })
				);
				if (executionContext === undefined) throw new TypeError("blueprint execution context is unavailable");
			} catch (error) {
				throw new DRPError("BLUEPRINT_AUTHORIZATION_REJECTED", "blueprint execution context resolution failed", {
					cause: error,
				});
			}
		}
		outputs.push(stagedMachine.apply(vertex.operation, executionContext));
	}
	return Object.freeze({
		adopt: (): BlueprintStateSnapshot => input.machine.adopt(stagedMachine),
		order: Object.freeze([...order]),
		outputs: Object.freeze(outputs.map((output) => deepCloneCanonical(output))),
		staged: stagedMachine.snapshot(),
	});
}
