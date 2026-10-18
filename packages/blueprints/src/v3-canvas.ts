import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import {
	blueprint,
	CANVAS_LIMITS,
	createCanvasStateKernel,
	fromCanvasWireOperation,
	toCanvasWireOperation,
} from "./v3-canvas-kernel.js";
import type { CanvasOperation, CanvasState, CanvasStateKernel } from "./v3-canvas-types.js";

export { blueprint, CANVAS_LIMITS, createCanvasStateKernel, fromCanvasWireOperation, toCanvasWireOperation };
export type {
	CanvasOffset,
	CanvasOperation,
	CanvasRgb,
	CanvasState,
	CanvasStateKernel,
	CanvasWireOperation,
} from "./v3-canvas-types.js";

// Codec law: a pixel is a 2-byte array prefix + three at-most-9-byte integers.
// Decode counts each collection slot AND value: 8 items/pixel + 17 header items.
export const CANVAS_SNAPSHOT_LIMITS = Object.freeze({
	maxBytes: 128 + 29 * CANVAS_LIMITS.maxPixels,
	maxDepth: 3,
	maxItems: 17 + 8 * CANVAS_LIMITS.maxPixels,
});

// Closed {author, operation}: 64 ASCII author bytes, at most four operation
// fields and seven bounded integer coordinates/channels; <=39 decoder items.
const RETRY_LIMITS = Object.freeze({ maxBytes: 192, maxDepth: 3, maxItems: 39 });

export interface CanvasAcceptedOperation {
	/** Already authenticated by the protocol owner; this kernel does not verify signatures. */
	readonly vertexDigest: string;
	readonly author: string;
	readonly epoch: number;
	readonly operationIndex: number;
	readonly operation: CanvasOperation;
}

export interface CanvasProjectionInput {
	readonly epoch: number;
	readonly operations: readonly CanvasAcceptedOperation[];
	readonly base?: Readonly<{ epoch: number; state: unknown }>;
}

export interface V3CanvasDescriptor {
	readonly artifactId: "v3-additive-rgb-canvas.v1";
	readonly initialState: CanvasState;
	readonly kernel: CanvasStateKernel;
	readonly batchableOperationActions: readonly ["paint", "splash"];
	readonly displacementPolicies: Readonly<{ paint: "rebase"; splash: "rebase" }>;
	canonicalStateBytes(state: unknown): Uint8Array;
	restoreState(bytes: Uint8Array): CanvasState;
	projectAcceptedOperations(input: CanvasProjectionInput): CanvasState;
}

/**
 * Pure schema/transition descriptor; does not manufacture a host or catalog receipt.
 * @param width - Admitted canvas width.
 * @param height - Admitted canvas height.
 * @returns Shared kernel, projection and canonical snapshot operations.
 */
export function createV3CanvasDescriptor(width: number, height: number): V3CanvasDescriptor {
	const kernel = createCanvasStateKernel();
	const initialState = kernel.createState(width, height);
	const canonicalStateBytes = (value: unknown): Uint8Array => {
		const state = kernel.captureState(value);
		if (state.width !== width || state.height !== height) throw new TypeError("canvas snapshot dimensions differ");
		return encodeCanonical(state, CANVAS_SNAPSHOT_LIMITS);
	};
	const restoreState = (bytes: Uint8Array): CanvasState => {
		const state = kernel.captureState(decodeCanonical(bytes, CANVAS_SNAPSHOT_LIMITS));
		if (state.width !== width || state.height !== height) throw new TypeError("canvas snapshot dimensions differ");
		const exact = canonicalStateBytes(state);
		if (exact.byteLength !== bytes.byteLength || !exact.every((n, i) => n === bytes[i]))
			throw new TypeError("canvas snapshot is not canonical");
		return state;
	};
	const projectAcceptedOperations = (input: CanvasProjectionInput): CanvasState => {
		if (
			!Number.isSafeInteger(input.epoch) ||
			input.epoch < 0 ||
			(input.epoch === 0 ? input.base !== undefined : input.base?.epoch !== input.epoch - 1)
		)
			throw new TypeError("canvas snapshot/current epoch boundary differs");
		let state = kernel.captureState(input.base?.state ?? initialState);
		if (state.width !== width || state.height !== height) throw new TypeError("canvas projection dimensions differ");
		const seen = new Map<string, Uint8Array>();
		for (const row of input.operations) {
			if (
				typeof row.vertexDigest !== "string" ||
				!/^[0-9a-f]{64}$/u.test(row.vertexDigest) ||
				typeof row.author !== "string" ||
				!/^[0-9a-f]{64}$/u.test(row.author) ||
				row.epoch !== input.epoch ||
				!Number.isSafeInteger(row.operationIndex) ||
				row.operationIndex < 0
			)
				throw new TypeError("invalid authenticated canvas operation identity");
			const operation = kernel.captureOperation(row.operation);
			const bytes = encodeCanonical({ author: row.author, operation }, RETRY_LIMITS);
			const key = `${row.vertexDigest}:${row.operationIndex}`;
			const prior = seen.get(key);
			if (prior !== undefined) {
				if (prior.byteLength !== bytes.byteLength || !prior.every((n, i) => n === bytes[i]))
					throw new TypeError("canvas authenticated retry conflicts");
				continue;
			}
			seen.set(key, bytes);
			state = kernel.apply(state, operation).state;
		}
		return state;
	};
	return Object.freeze({
		artifactId: blueprint.artifactId,
		initialState,
		kernel,
		batchableOperationActions: Object.freeze(["paint", "splash"] as const),
		displacementPolicies: Object.freeze({ paint: "rebase" as const, splash: "rebase" as const }),
		canonicalStateBytes,
		restoreState,
		projectAcceptedOperations,
	});
}
