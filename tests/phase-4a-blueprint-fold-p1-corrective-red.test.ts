import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-4a-v3/blueprint-fold-contract.json" with { type: "json" };
import blueprintPackage from "./fixtures/phase-4a-v3/blueprint-package.json" with { type: "json" };
import {
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintRuntime,
} from "../packages/protocol-v3/src/public.js";

interface BlueprintStateSnapshot {
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

interface BlueprintStateMachineInstance {
	adopt(staged: BlueprintStateMachineInstance): BlueprintStateSnapshot;
	apply(operation: unknown): unknown;
	fork(): BlueprintStateMachineInstance;
}

interface BlueprintStateMachineConstructor {
	new (input: {
		readonly exactCanonicalInitialStateBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
		readonly expectedInitialStateDigest: string;
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
	}): BlueprintStateMachineInstance;
}

interface FoldModule {
	BlueprintStateMachine: BlueprintStateMachineConstructor;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-4a-v3");
const FOLD_SOURCE = resolve(REPOSITORY_ROOT, "packages/compaction/src/blueprint-fold.ts");
const APPLICATION_SOURCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/blueprint-application.ts");
const STAGED_TYPE_SOURCE = resolve(REPOSITORY_ROOT, "packages/types/src/staged-state-machine.ts");
const ORACLE_SOURCE = resolve(REPOSITORY_ROOT, "packages/test-utils/src/deterministic-state-machine.ts");
const FOLD_MODULE_PATH: string = "../packages/compaction/src/blueprint-fold.js";
const TYPE_PROJECT = "tests/fixtures/phase-4a-v3/tsconfig.corrective.json";
const productReady = [FOLD_SOURCE, APPLICATION_SOURCE, STAGED_TYPE_SOURCE, ORACLE_SOURCE].every(existsSync);

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function digest(bytes: Uint8Array): string {
	return hex(hashDomain("ts-drp/state/v3", bytes));
}

function errorCode(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof Error && "code" in error ? String(error.code) : undefined;
	}
	throw new Error("expected action to throw");
}

async function fixtureRuntime(): Promise<PreparedBlueprintRuntime> {
	const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
	const expectedBlueprintDigest = hex(hashDomain(contract.domains.blueprint, canonicalBlueprintPackageBytes));
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest,
	});
	return prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes,
		exactArtifactBytes: new Uint8Array(readFileSync(resolve(FIXTURE_DIRECTORY, contract.files.artifact))),
		expectedBlueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

function machine(
	Constructor: BlueprintStateMachineConstructor,
	runtime: PreparedBlueprintRuntime
): BlueprintStateMachineInstance {
	const bytes = encodeCanonical(contract.initialState);
	return new Constructor({
		exactCanonicalInitialStateBytes: bytes,
		expectedBlueprintDigest: runtime.blueprintDigest,
		expectedInitialStateDigest: digest(bytes),
		preparedBlueprintRuntime: runtime,
	});
}

function digestOnlyAdoption(parentDigest: string, childBaseDigest: string): boolean {
	return parentDigest === childBaseDigest;
}

function generationBoundAdoption(current: object, child: { base: object; consumed: boolean }): boolean {
	return !child.consumed && child.base === current;
}

function shadowableByteBoundary(input: Uint8Array): boolean {
	return (
		input instanceof Uint8Array &&
		input.buffer instanceof ArrayBuffer &&
		input.byteOffset === 0 &&
		input.byteLength === input.buffer.byteLength
	);
}

describe("Phase 4a product-P1 corrective tests-only RED", () => {
	it("has one readiness boundary for the still-unrestored product fold", () => {
		expect(
			[FOLD_SOURCE, APPLICATION_SOURCE, STAGED_TYPE_SOURCE, ORACLE_SOURCE].filter((path) => !existsSync(path)),
			"restore the reviewed Phase 4a product GREEN after this RED is signed"
		).toEqual([]);
	});

	it("keeps the old digest-only and shadowable-carrier behaviors causal", () => {
		const generationA = {};
		const generationB = {};
		const generationAAfterAba = {};
		const noOpChild = { base: generationA, consumed: false };
		expect(generationBoundAdoption(generationA, noOpChild)).toBe(true);
		noOpChild.consumed = true;
		expect(generationBoundAdoption(generationB, noOpChild)).toBe(false);
		expect(generationBoundAdoption(generationAAfterAba, { base: generationA, consumed: false })).toBe(false);
		expect(digestOnlyAdoption("a", "a")).toBe(true);
		expect(digestOnlyAdoption("a", "a")).toBe(true);
		expect(digestOnlyAdoption("a", "a"), "A→B→A resurrects a digest-bound stale child").toBe(true);

		class SharedBytes extends Uint8Array {}
		const shared = new SharedBytes(new SharedArrayBuffer(3));
		shared.set([1, 2, 3]);
		Object.defineProperties(shared, {
			buffer: { value: new ArrayBuffer(3) },
			byteLength: { value: 3 },
			byteOffset: { value: 0 },
		});
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
		expect(Reflect.apply(intrinsicBuffer as (this: Uint8Array) => ArrayBufferLike, shared, [])).toBeInstanceOf(
			SharedArrayBuffer
		);
		expect(Object.getPrototypeOf(shared)).not.toBe(Uint8Array.prototype);
		expect(shadowableByteBoundary(shared)).toBe(true);
	});
});

describe.skipIf(!productReady)("Phase 4a product-P1 corrective GREEN", () => {
	it("consumes no-op children and rejects stale children after a digest ABA cycle", async () => {
		const [{ BlueprintStateMachine }, runtime] = await Promise.all([
			import(FOLD_MODULE_PATH) as Promise<FoldModule>,
			fixtureRuntime(),
		]);
		const parent = machine(BlueprintStateMachine, runtime);
		const noOp = parent.fork();
		parent.adopt(noOp);
		expect(errorCode(() => parent.adopt(noOp))).toBe("BLUEPRINT_ALREADY_ADOPTED");

		const stale = parent.fork();
		const toB = parent.fork();
		toB.apply({ action: "replace_state", value: { map: { phase: "b" }, set: [], total: 1 } });
		parent.adopt(toB);
		const backToA = parent.fork();
		backToA.apply({ action: "replace_state", value: contract.initialState });
		parent.adopt(backToA);
		expect(errorCode(() => parent.adopt(stale))).toBe("BLUEPRINT_ALREADY_ADOPTED");
	});

	it("rejects shared subclass bytes despite shadowed slots and replaced ambient constructors", async () => {
		const [{ BlueprintStateMachine }, runtime] = await Promise.all([
			import(FOLD_MODULE_PATH) as Promise<FoldModule>,
			fixtureRuntime(),
		]);
		const NativeUint8Array = globalThis.Uint8Array;
		const NativeArrayBuffer = globalThis.ArrayBuffer;
		class SharedBytes extends NativeUint8Array {}
		const canonical = encodeCanonical(contract.initialState);
		const shared = new SharedBytes(new SharedArrayBuffer(canonical.byteLength));
		shared.set(canonical);
		Object.defineProperties(shared, {
			buffer: { value: new NativeArrayBuffer(canonical.byteLength) },
			byteLength: { value: canonical.byteLength },
			byteOffset: { value: 0 },
		});
		try {
			Object.defineProperty(globalThis, "Uint8Array", { configurable: true, value: SharedBytes, writable: true });
			Object.defineProperty(globalThis, "ArrayBuffer", {
				configurable: true,
				value: class AmbientArrayBuffer extends NativeArrayBuffer {},
				writable: true,
			});
			expect(
				errorCode(
					() =>
						new BlueprintStateMachine({
							exactCanonicalInitialStateBytes: shared,
							expectedBlueprintDigest: runtime.blueprintDigest,
							expectedInitialStateDigest: digest(canonical),
							preparedBlueprintRuntime: runtime,
						})
				)
			).toBe("INVALID_APPLICATION_STATE");
		} finally {
			Object.defineProperty(globalThis, "Uint8Array", {
				configurable: true,
				value: NativeUint8Array,
				writable: true,
			});
			Object.defineProperty(globalThis, "ArrayBuffer", {
				configurable: true,
				value: NativeArrayBuffer,
				writable: true,
			});
		}
	});

	it("accepts the public add_mul operation type without a cast", () => {
		const result = spawnSync("pnpm", ["exec", "tsc", "-p", TYPE_PROJECT], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});
});
