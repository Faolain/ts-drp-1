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
	type PreparedBlueprintRuntime,
} from "@ts-drp/protocol-v3/blueprint-application";
import type { IStagedStateMachine } from "@ts-drp/types";

import { topologicalOrder } from "./linearize.js";
import type { EpochVertex } from "./types.js";

const APPLICATION_STATE_DOMAIN = "ts-drp/state/v3";
const APPLICATION_LIMITS: Readonly<CanonicalLimits> = Object.freeze({
	maxBytes: 32_768,
	maxDepth: 16,
	maxItems: 16_384,
});
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"resizable"
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(intrinsicUint8ArrayPrototype);
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(intrinsicTypedArrayPrototype, "buffer")
	?.get as (this: Uint8Array) => ArrayBufferLike;
const intrinsicTypedArrayByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteLength"
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArrayByteOffsetGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteOffset"
)?.get as (this: Uint8Array) => number;

export interface BlueprintStateSnapshot {
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

export interface BlueprintStateMachineInput {
	readonly exactCanonicalInitialStateBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
	readonly expectedInitialStateDigest: string;
	readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
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

function applicationStateBytes(value: unknown): Uint8Array {
	try {
		const bytes = encodeCanonical(value, APPLICATION_LIMITS);
		decodeCanonical(bytes, APPLICATION_LIMITS);
		return bytes;
	} catch (error) {
		return applicationStateFailure("application value is outside the bounded canonical domain", error);
	}
}

function decodeInitialState(
	input: Uint8Array,
	expectedDigest: string
): { readonly bytes: Uint8Array; readonly value: unknown } {
	let bytes: Uint8Array;
	try {
		if (intrinsicObjectGetPrototypeOf(input) !== intrinsicUint8ArrayPrototype) {
			return applicationStateFailure("initial application state must use an unshared Uint8Array");
		}
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, input, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, input, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) {
			return applicationStateFailure("initial application state must use an unshared Uint8Array");
		}
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if (byteLength === 0 || byteOffset !== 0 || byteLength !== bufferByteLength || resizable) {
			return applicationStateFailure("initial application state must use one full, attached byte buffer");
		}
		bytes = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, bytes, [input]);
	} catch (error) {
		return applicationStateFailure("initial application state bytes are unreadable", error);
	}
	if (!/^[0-9a-f]{64}$/u.test(expectedDigest) || stateDigest(bytes) !== expectedDigest) {
		return applicationStateFailure("initial application state digest does not match exact bytes");
	}
	try {
		const value = decodeCanonical(bytes, APPLICATION_LIMITS);
		const reencoded = encodeCanonical(value, APPLICATION_LIMITS);
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
	#baseGeneration: object | undefined;
	#exactCanonicalStateBytes: Uint8Array;
	#generation: object = {};
	#parent: BlueprintStateMachine | undefined;
	#state: unknown;
	#stateDigest: string;

	constructor(input: BlueprintStateMachineInput) {
		const initial = decodeInitialState(input.exactCanonicalInitialStateBytes, input.expectedInitialStateDigest);
		this.#expectedBlueprintDigest = input.expectedBlueprintDigest;
		this.#preparedBlueprintRuntime = input.preparedBlueprintRuntime;
		this.#exactCanonicalStateBytes = initial.bytes;
		this.#state = initial.value;
		this.#stateDigest = input.expectedInitialStateDigest;
	}

	adopt(staged: IStagedStateMachine<BlueprintStateSnapshot, unknown, unknown>): BlueprintStateSnapshot {
		if (!(staged instanceof BlueprintStateMachine) || staged.#parent !== this) {
			throw new DRPError("BLUEPRINT_ALREADY_ADOPTED", "staged machine does not belong to this parent");
		}
		if (staged.#baseGeneration !== this.#generation) {
			throw new DRPError("BLUEPRINT_ALREADY_ADOPTED", "staged transition is stale or already adopted");
		}
		const nextBytes = new intrinsicUint8Array(staged.#exactCanonicalStateBytes);
		const nextState = deepCloneCanonical(staged.#state);
		this.#exactCanonicalStateBytes = nextBytes;
		this.#state = nextState;
		this.#stateDigest = staged.#stateDigest;
		this.#generation = {};
		staged.#baseGeneration = undefined;
		staged.#parent = undefined;
		return this.snapshot();
	}

	apply(operation: unknown): unknown {
		const result = applyPreparedBlueprintOperation({
			expectedBlueprintDigest: this.#expectedBlueprintDigest,
			operation,
			preparedBlueprintRuntime: this.#preparedBlueprintRuntime,
			state: this.#state,
		});
		const nextStateBytes = applicationStateBytes(result.state);
		const outputBytes = applicationStateBytes(result.output);
		const nextState = decodeCanonical(nextStateBytes, APPLICATION_LIMITS);
		const output = decodeCanonical(outputBytes, APPLICATION_LIMITS);
		this.#exactCanonicalStateBytes = nextStateBytes;
		this.#state = nextState;
		this.#stateDigest = stateDigest(nextStateBytes);
		this.#generation = {};
		return output;
	}

	fork(): BlueprintStateMachine {
		const fork = new BlueprintStateMachine({
			exactCanonicalInitialStateBytes: this.#exactCanonicalStateBytes,
			expectedBlueprintDigest: this.#expectedBlueprintDigest,
			expectedInitialStateDigest: this.#stateDigest,
			preparedBlueprintRuntime: this.#preparedBlueprintRuntime,
		});
		fork.#baseGeneration = this.#generation;
		fork.#parent = this;
		return fork;
	}

	snapshot(): BlueprintStateSnapshot {
		return Object.freeze({
			exactCanonicalStateBytes: new intrinsicUint8Array(this.#exactCanonicalStateBytes),
			stateDigest: this.#stateDigest,
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
		outputs.push(stagedMachine.apply(vertex.operation));
	}
	return Object.freeze({
		adopt: (): BlueprintStateSnapshot => input.machine.adopt(stagedMachine),
		order: Object.freeze([...order]),
		outputs: Object.freeze(outputs.map((output) => deepCloneCanonical(output))),
		staged: stagedMachine.snapshot(),
	});
}
