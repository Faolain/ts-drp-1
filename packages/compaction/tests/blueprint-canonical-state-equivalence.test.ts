import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	applyPreparedBlueprintOperation,
	applyPreparedBlueprintOperationToCanonicalState,
} from "@ts-drp/protocol-v3/blueprint-application";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import blueprintPackage from "../../../tests/fixtures/phase-4a-v3/blueprint-package.json" with { type: "json" };
import {
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintRuntime,
} from "../../protocol-v3/src/public.js";
import { BlueprintStateMachine, foldBlueprintEpoch } from "../src/blueprint-fold.js";
import type { EpochVertex } from "../src/types.js";

const calls = vi.hoisted(() => ({ stateHash: 0 }));
vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...actual,
		hashDomain: (...args: Parameters<typeof actual.hashDomain>) => {
			if (args[0] === "ts-drp/state/v3") calls.stateHash++;
			return actual.hashDomain(...args);
		},
	};
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
let runtimePromise: Promise<PreparedBlueprintRuntime> | undefined;
function runtime() {
	return (runtimePromise ??= (() => {
		const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
		const expectedBlueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes));
		const preparedBlueprintAdmission = prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes,
			expectedBlueprintDigest,
		});
		return prepareBlueprintRuntime({
			canonicalBlueprintPackageBytes,
			expectedBlueprintDigest,
			preparedBlueprintAdmission,
			exactArtifactBytes: new Uint8Array(
				readFileSync(new URL("../../../tests/fixtures/phase-4a-v3/application-blueprint.mjs", import.meta.url))
			),
		});
	})());
}
const initial = { map: {}, set: [], total: 1 };
function input(prepared: PreparedBlueprintRuntime, maxApplicationStateBytes?: number) {
	const bytes = encodeCanonical(initial);
	return {
		exactCanonicalInitialStateBytes: bytes,
		expectedBlueprintDigest: prepared.blueprintDigest,
		expectedInitialStateDigest: hex(hashDomain("ts-drp/state/v3", bytes)),
		preparedBlueprintRuntime: prepared,
		...(maxApplicationStateBytes === undefined ? {} : { maxApplicationStateBytes }),
	};
}
const failure = (run: () => unknown): unknown => {
	try {
		return { ok: run() };
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause;
		return {
			code: (error as { code?: string }).code,
			message: (error as Error).message,
			cause: cause instanceof Error ? cause.constructor.name : undefined,
		};
	}
};

/** The pre-change machine, written against the public original runtime API. */
class OracleMachine {
	#value: unknown;
	bytes: Uint8Array;
	readonly #limits;
	constructor(
		private readonly prepared: PreparedBlueprintRuntime,
		maxBytes = 32_768
	) {
		this.#limits = Object.freeze({ maxBytes, maxDepth: 16, maxItems: 16_384 });
		this.bytes = encodeCanonical(initial);
		this.#value = decodeCanonical(this.bytes, this.#limits);
	}
	#validated(value: unknown) {
		try {
			const bytes = encodeCanonical(value, this.#limits);
			return { bytes, value: decodeCanonical(bytes, this.#limits) };
		} catch (error) {
			throw Object.assign(new Error("application value is outside the bounded canonical domain", { cause: error }), {
				code: "INVALID_APPLICATION_STATE",
			});
		}
	}
	apply(operation: unknown): unknown {
		const result = applyPreparedBlueprintOperation({
			expectedBlueprintDigest: this.prepared.blueprintDigest,
			operation,
			preparedBlueprintRuntime: this.prepared,
			state: this.#value,
		});
		const state = this.#validated(result.state),
			output = this.#validated(result.output);
		this.bytes = state.bytes;
		this.#value = state.value;
		return output.value;
	}
	digest(): string {
		return hex(hashDomain("ts-drp/state/v3", this.bytes));
	}
}

const nested = (depth: number): unknown => (depth === 0 ? 0 : [nested(depth - 1)]);
const OPERATIONS: unknown[] = [
	{ action: "add_mul", add: 2, multiplier: 3 },
	{ action: "map_set", key: "k", value: { a: [1, "x", null] } },
	{ action: "set_add", value: "s" },
	{ action: "emit", value: { bytes: Uint8Array.of(1, 2, 3) } },
	{ action: "mutate_inputs", value: 7 },
	{ action: "replace_state", value: { map: { z: "é😀" }, set: [-0, 1.5], total: -3 } },
	{ action: "replace_state", value: nested(16) },
	{ action: "replace_state", value: nested(17) },
	{ action: "replace_state", value: nested(129) },
	{ action: "replace_state", value: { bytes: new Uint8Array(40_000) } },
	{ action: "replace_state", value: Array.from({ length: 20_000 }, () => null) },
	{ action: "replace_state", value: new Map([[1, 2]]) },
	{ action: "emit", value: nested(20) },
	{ action: "throw_sync" },
	{ action: "malformed_extra" },
	{ action: "add_mul", add: 1, multiplier: 2 },
];

describe("canonical-state blueprint application", () => {
	it("publishes the same bytes, digests, outputs and refusals as the original state-value path", async () => {
		const prepared = await runtime(),
			seen = new Set<unknown>();
		for (const maxBytes of [32_768, 64, 300_000]) {
			const machine = new BlueprintStateMachine(input(prepared, maxBytes)),
				oracle = new OracleMachine(prepared, maxBytes);
			for (const operation of OPERATIONS) {
				const actual = failure(() => machine.apply(operation)),
					expected = failure(() => oracle.apply(operation));
				expect(actual).toEqual(expected);
				seen.add((expected as { code?: string }).code ?? "ok");
				expect(machine.snapshot().exactCanonicalStateBytes).toEqual(oracle.bytes);
				expect(machine.snapshot().stateDigest).toBe(oracle.digest());
			}
		}
		expect([...seen].sort()).toEqual([
			"BLUEPRINT_OPERATION_INVALID",
			"BLUEPRINT_REDUCER_FAILED",
			"BLUEPRINT_RESULT_INVALID",
			"INVALID_APPLICATION_STATE",
			"ok",
		]);
	});
	it("returns the clone's exact bytes and refuses exactly where the clone's decode refuses", async () => {
		const prepared = await runtime(),
			state = encodeCanonical(initial);
		for (const operation of OPERATIONS)
			for (const stateLimits of [
				{ maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 },
				{ maxBytes: 512 * 1024 * 1024, maxDepth: 200, maxItems: 2_000_000 },
			]) {
				const base = {
					expectedBlueprintDigest: prepared.blueprintDigest,
					operation,
					preparedBlueprintRuntime: prepared,
				};
				const original = failure(() => applyPreparedBlueprintOperation({ ...base, state: initial }));
				const bytes = failure(() =>
					applyPreparedBlueprintOperationToCanonicalState({ ...base, exactCanonicalStateBytes: state, stateLimits })
				);
				if ("ok" in (original as object)) {
					const value = (original as { ok: { state: unknown; output: unknown } }).ok,
						result = (
							bytes as {
								ok: {
									exactCanonicalStateBytes: Uint8Array;
									output: unknown;
									stateWithinLimits: boolean;
								};
							}
						).ok;
					expect(result.exactCanonicalStateBytes).toEqual(encodeCanonical(value.state));
					expect(result.output).toEqual(value.output);
					expect(result.stateWithinLimits).toBe(
						"ok" in (failure(() => decodeCanonical(result.exactCanonicalStateBytes, stateLimits)) as object)
					);
				} else expect(bytes).toEqual(original);
			}
	});
	it("hashes an epoch fold's staged state once, not once per vertex", async () => {
		const prepared = await runtime(),
			machine = new BlueprintStateMachine(input(prepared));
		const anchorHash = "0".repeat(64),
			objectId = "fold-digest",
			epoch = 1;
		const vertices = new Map<string, EpochVertex>([
			[anchorHash, { hash: anchorHash, kind: "drp-epoch-anchor", objectId, epoch, dependencies: [] }],
		]);
		let previous = anchorHash;
		for (let index = 0; index < 6; index++) {
			const hash = index.toString(16).padStart(64, "a");
			vertices.set(hash, {
				hash,
				kind: "drp-vertex",
				objectId,
				epoch,
				anchor: anchorHash,
				dependencies: [previous],
				operation: { action: "add_mul", add: index, multiplier: 2 } as NonNullable<EpochVertex["operation"]>,
			});
			previous = hash;
		}
		calls.stateHash = 0;
		const folded = foldBlueprintEpoch({ machine, anchorHash, vertices, authorize: () => true });
		expect(calls.stateHash).toBe(1);
		expect(folded.adopt()).toEqual(folded.staged);
		expect(calls.stateHash).toBe(1);
		const oracle = new OracleMachine(prepared);
		for (let index = 0; index < 6; index++) oracle.apply({ action: "add_mul", add: index, multiplier: 2 });
		expect(folded.staged.stateDigest).toBe(oracle.digest());
		expect(folded.staged.exactCanonicalStateBytes).toEqual(oracle.bytes);
	});
});
