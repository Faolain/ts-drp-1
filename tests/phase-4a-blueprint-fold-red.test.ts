import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-4a-v3/blueprint-fold-contract.json" with { type: "json" };
import blueprintPackage from "./fixtures/phase-4a-v3/blueprint-package.json" with { type: "json" };
import { type EpochVertex as CompactionEpochVertex, topologicalOrder } from "../packages/compaction/src/index.js";
import {
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintRuntime,
} from "../packages/protocol-v3/src/public.js";

interface ApplicationModule {
	applyPreparedBlueprintOperation(input: {
		readonly expectedBlueprintDigest: string;
		readonly operation: unknown;
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
		readonly state: unknown;
	}): Readonly<{ readonly output: unknown; readonly state: unknown }>;
}

interface BlueprintStateSnapshot {
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

interface BlueprintStateMachineInstance {
	adopt(staged: BlueprintStateMachineInstance): BlueprintStateSnapshot;
	apply(operation: unknown): unknown;
	fork(): BlueprintStateMachineInstance;
	snapshot(): BlueprintStateSnapshot;
}

interface BlueprintStateMachineConstructor {
	new (input: {
		readonly exactCanonicalInitialStateBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
		readonly expectedInitialStateDigest: string;
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
	}): BlueprintStateMachineInstance;
}

interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
	readonly operation?: unknown;
}

interface FoldResult {
	adopt(): BlueprintStateSnapshot;
	readonly order: readonly string[];
	readonly outputs: readonly unknown[];
	readonly staged: BlueprintStateSnapshot;
}

interface BlueprintFoldModule {
	BlueprintStateMachine: BlueprintStateMachineConstructor;
	foldBlueprintEpoch(input: {
		readonly anchorHash: string;
		authorize(input: Readonly<{ readonly hash: string; readonly operation: unknown }>): boolean;
		readonly machine: BlueprintStateMachineInstance;
		readonly vertices: ReadonlyMap<string, EpochVertex>;
	}): FoldResult;
}

interface OracleStateMachineInstance<State, Operation> {
	adopt(snapshot: State): void;
	apply(operation: Operation): State;
	fork(): OracleStateMachineInstance<State, Operation>;
	snapshot(): State;
}

interface OracleModule {
	DeterministicStateMachine: new <State, Operation>(input: {
		readonly initialState: State;
		reduce(state: State, operation: Operation): State;
		validateState?(state: State): void;
	}) => OracleStateMachineInstance<State, Operation>;
}

interface ApplicationState {
	readonly map: Readonly<Record<string, string>>;
	readonly set: readonly string[];
	readonly total: number;
}

interface BlueprintPackage {
	readonly implementation: {
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly runtimeProfile: string;
	};
	readonly kind: string;
	readonly manifest: unknown;
	readonly protocolMajor: number;
	readonly schemaVersion: number;
}

interface RuntimePreparationSurface {
	prepareBlueprintAdmission: typeof prepareBlueprintAdmission;
	prepareBlueprintRuntime: typeof prepareBlueprintRuntime;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-4a-v3");
const APPLICATION_SOURCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/blueprint-application.ts");
const FOLD_SOURCE = resolve(REPOSITORY_ROOT, "packages/compaction/src/blueprint-fold.ts");
const STAGED_TYPE_SOURCE = resolve(REPOSITORY_ROOT, "packages/types/src/staged-state-machine.ts");
const ORACLE_SOURCE = resolve(REPOSITORY_ROOT, "packages/test-utils/src/deterministic-state-machine.ts");
const PROTOCOL_INDEX_SOURCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/index.ts");
const APPLICATION_MODULE_PATH: string = "../packages/protocol-v3/src/blueprint-application.js";
const FOLD_MODULE_PATH: string = "../packages/compaction/src/blueprint-fold.js";
const ORACLE_MODULE_PATH: string = "../packages/test-utils/src/deterministic-state-machine.js";
const FOREIGN_PROTOCOL_MODULE_PATH: string = "../packages/protocol-v3/src/index.js?phase4a-foreign";
const artifactBytes = new Uint8Array(readFileSync(resolve(FIXTURE_DIRECTORY, contract.files.artifact)));
const exactCanonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
const expectedBlueprintDigest = hex(hashDomain(contract.domains.blueprint, exactCanonicalBlueprintPackageBytes));
const exactCanonicalInitialStateBytes = encodeCanonical(contract.initialState);
const expectedInitialStateDigest = hex(hashDomain(contract.domains.state, exactCanonicalInitialStateBytes));
const phase4aReady =
	existsSync(APPLICATION_SOURCE) &&
	existsSync(FOLD_SOURCE) &&
	existsSync(STAGED_TYPE_SOURCE) &&
	existsSync(ORACLE_SOURCE);

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalClone<T>(value: T): T {
	return decodeCanonical(encodeCanonical(value)) as T;
}

function errorCode(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof Error && "code" in error ? String(error.code) : undefined;
	}
	throw new Error("expected action to throw");
}

function packageArtifactDigest(): string {
	return (blueprintPackage as BlueprintPackage).implementation.artifactDigest;
}

function prepareRuntimeWith(
	surface: RuntimePreparationSurface,
	packageValue: unknown = blueprintPackage
): Promise<PreparedBlueprintRuntime> {
	const canonicalPackageBytes = encodeCanonical(packageValue);
	const blueprintDigest = hex(hashDomain(contract.domains.blueprint, canonicalPackageBytes));
	const admission = surface.prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: canonicalPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	return surface.prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes: canonicalPackageBytes,
		exactArtifactBytes: artifactBytes,
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

function prepareFixtureRuntime(): Promise<PreparedBlueprintRuntime> {
	return prepareRuntimeWith({ prepareBlueprintAdmission, prepareBlueprintRuntime });
}

async function loadPhase4a(): Promise<{
	readonly application: ApplicationModule;
	readonly fold: BlueprintFoldModule;
}> {
	const [application, fold] = await Promise.all([import(APPLICATION_MODULE_PATH), import(FOLD_MODULE_PATH)]);
	return {
		application: application as ApplicationModule,
		fold: fold as BlueprintFoldModule,
	};
}

async function loadOracle(): Promise<OracleModule> {
	return (await import(ORACLE_MODULE_PATH)) as OracleModule;
}

function stateBytes(value: unknown): Uint8Array {
	return encodeCanonical(value, contract.limits);
}

function stateDigest(bytes: Uint8Array): string {
	return hex(hashDomain(contract.domains.state, bytes));
}

function privateDispatchSourceAccepted(source: string): boolean {
	return (
		/preparedBlueprintRuntimes\.get\(/u.test(source) &&
		/(?:runtimeState|preparedRuntime)\.reducers/u.test(source) &&
		!/preparedBlueprintRuntime\.reducers/u.test(source)
	);
}

function canonicalCloneSourceAccepted(source: string): boolean {
	return /deepCloneCanonical/u.test(source) && !/structuredClone/u.test(source);
}

function stateAtExactByteLimit(): Readonly<Record<string, unknown>> {
	let low = 0;
	let high = contract.limits.maxBytes;
	while (low <= high) {
		const length = Math.floor((low + high) / 2);
		const value = { payload: "x".repeat(length) };
		const byteLength = encodeCanonical(value).byteLength;
		if (byteLength === contract.limits.maxBytes) return value;
		if (byteLength < contract.limits.maxBytes) low = length + 1;
		else high = length - 1;
	}
	throw new Error("fixture cannot reach the exact application-state byte limit");
}

function nestedState(depth: number): unknown {
	let value: unknown = null;
	for (let index = 0; index < depth; index++) value = [value];
	return value;
}

function itemBoundState(itemLimit: number, over = false): Readonly<Record<string, unknown>> {
	if (itemLimit < 6) throw new RangeError("item-bound fixture requires a typed-array item");
	if (over) {
		const firstRejectedLength = Math.floor((itemLimit - 5) / 2) + 1;
		return { payload: Array.from({ length: firstRejectedLength }, () => null) };
	}
	const exactLength = Math.floor((itemLimit - 6) / 2);
	const payload: unknown[] = Array.from({ length: exactLength }, () => null);
	payload[0] = new Uint32Array([0]);
	return { payload };
}

function depthBoundState(depthLimit: number): Readonly<Record<string, unknown>> {
	if (depthLimit < 1) throw new RangeError("depth-bound fixture requires a record root");
	return { payload: nestedState(depthLimit - 1) };
}

function orderedApplicationVertices(vertices: ReadonlyMap<string, EpochVertex>): EpochVertex[] {
	return topologicalOrder(vertices as ReadonlyMap<string, CompactionEpochVertex>, contract.graph.anchorHash)
		.filter((hash) => hash !== contract.graph.anchorHash)
		.map((hash) => vertices.get(hash) as EpochVertex);
}

function oracleTransition(
	state: ApplicationState,
	operation: Readonly<Record<string, unknown>>
): {
	readonly output: unknown;
	readonly state: ApplicationState;
} {
	switch (operation.action) {
		case "add_mul": {
			const total = (state.total + (operation.add as number)) * (operation.multiplier as number);
			return { output: total, state: { ...state, total } };
		}
		case "map_set": {
			const value = operation.value as string;
			return { output: value, state: { ...state, map: { ...state.map, [operation.key as string]: value } } };
		}
		case "set_add": {
			const value = operation.value as string;
			return {
				output: value,
				state: { ...state, set: state.set.includes(value) ? state.set : [...state.set, value] },
			};
		}
		default:
			throw new TypeError(`oracle received unsupported operation ${String(operation.action)}`);
	}
}

function legacyProjection(operations: readonly Readonly<Record<string, unknown>>[]): {
	readonly outputs: readonly unknown[];
	readonly state: ApplicationState;
} {
	const map = new Map<string, string>();
	const set = new Set<string>();
	let total = 1;
	const outputs: unknown[] = [];
	for (const operation of operations) {
		switch (operation.action) {
			case "add_mul":
				total = (total + (operation.add as number)) * (operation.multiplier as number);
				outputs.push(total);
				break;
			case "map_set":
				map.set(operation.key as string, operation.value as string);
				outputs.push(operation.value);
				break;
			case "set_add":
				set.add(operation.value as string);
				outputs.push(operation.value);
				break;
			default:
				throw new TypeError(`legacy projection received unsupported operation ${String(operation.action)}`);
		}
	}
	return { outputs, state: { map: Object.fromEntries(map), set: [...set], total } };
}

async function independentExpectation(vertices: ReadonlyMap<string, EpochVertex>): Promise<{
	readonly order: readonly string[];
	readonly outputs: readonly unknown[];
	readonly state: ApplicationState;
}> {
	const { DeterministicStateMachine } = await loadOracle();
	const ordered = orderedApplicationVertices(vertices);
	const outputs: unknown[] = [];
	const oracle = new DeterministicStateMachine<ApplicationState, Readonly<Record<string, unknown>>>({
		initialState: canonicalClone(contract.initialState) as ApplicationState,
		reduce(state, operation): ApplicationState {
			const transition = oracleTransition(state, operation);
			outputs.push(transition.output);
			return transition.state;
		},
	});
	for (const vertex of ordered) oracle.apply(vertex.operation as Readonly<Record<string, unknown>>);
	const operations = ordered.map((vertex) => vertex.operation as Readonly<Record<string, unknown>>);
	const legacy = legacyProjection(operations);
	const state = oracle.snapshot();
	expect(state).toEqual(legacy.state);
	expect(outputs).toEqual(legacy.outputs);
	return { order: ordered.map(({ hash }) => hash), outputs, state };
}

function graph(insertionOrder: readonly number[] = [0, 1, 2]): Map<string, EpochVertex> {
	const anchorHash = contract.graph.anchorHash;
	const anchor: EpochVertex = {
		dependencies: [],
		epoch: contract.graph.epoch,
		hash: anchorHash,
		kind: "drp-epoch-anchor",
		objectId: contract.graph.objectId,
	};
	const entries: Array<readonly [string, EpochVertex]> = [[anchorHash, anchor]];
	for (const index of insertionOrder) {
		const fixture = contract.graph.vertices[index];
		if (fixture === undefined) throw new Error(`missing graph fixture ${index}`);
		entries.push([
			fixture.hash,
			{
				anchor: anchorHash,
				dependencies: [...fixture.dependencies],
				epoch: contract.graph.epoch,
				hash: fixture.hash,
				kind: "drp-vertex",
				objectId: contract.graph.objectId,
				operation: canonicalClone(fixture.operation),
			},
		]);
	}
	return new Map(entries);
}

function machine(
	constructor: BlueprintStateMachineConstructor,
	runtime: PreparedBlueprintRuntime,
	bytes = exactCanonicalInitialStateBytes,
	digest = expectedInitialStateDigest
): BlueprintStateMachineInstance {
	return new constructor({
		exactCanonicalInitialStateBytes: bytes,
		expectedBlueprintDigest,
		expectedInitialStateDigest: digest,
		preparedBlueprintRuntime: runtime,
	});
}

describe("Phase 4a blueprint state machine/fold tests-only RED", () => {
	it("has exactly one readiness boundary for the four missing natural owners", () => {
		const missing = [
			["types staged-state-machine contract", STAGED_TYPE_SOURCE],
			["test-utils deterministic state-machine oracle", ORACLE_SOURCE],
			["protocol-v3 application seam", APPLICATION_SOURCE],
			["compaction fold subpath", FOLD_SOURCE],
		].filter(([, path]) => !existsSync(path as string));
		expect(missing, "Phase 4a GREEN must add all four natural owners").toEqual([]);
	});

	it("pins the signed prerequisites, exact bounds, failure classes and causal mutant roster", () => {
		expect(contract.schemaVersion).toBe("phase-4a-blueprint-fold-red-v1");
		expect(contract.lineage).toEqual({
			phase0jRuntimeCommit: "a9aa765886a9f4bc4e92cfd95e9532cf8c3983c1",
			phase0nPolicyCommit: "6fd009266d58c4c55843f4faf54b68d38466beba",
			phase4aPlanCommit: "3c21a0157b258cd9ae214a9b401b9cc6d5933170",
		});
		expect(contract.limits).toEqual({ maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
		expect(new Set(contract.requiredFailureClasses).size).toBe(10);
		expect(new Set(contract.causalMutants).size).toBe(11);
		expect(contract.causalMutants).toEqual(
			expect.arrayContaining([
				"missing-runtime-provenance",
				"public-reducer-table-dispatch",
				"wrong-reducer-selection",
				"omitted-authorization",
				"authorize-after-reduce",
				"direct-state-mutation",
				"structured-clone",
				"promise-acceptance",
				"skipped-canonical-validation",
				"partial-adoption",
				"anchor-application",
			])
		);
	});

	it("binds the exact self-contained artifact to its canonical package and current Phase 0j runtime", async () => {
		expect(packageArtifactDigest()).toBe(hex(hashDomain(contract.domains.artifact, artifactBytes)));
		expect(sha256(artifactBytes)).toMatch(/^[0-9a-f]{64}$/u);
		const runtime = await prepareFixtureRuntime();
		expect(runtime.blueprintDigest).toBe(expectedBlueprintDigest);
		expect(runtime.artifactDigest).toBe(packageArtifactDigest());
		expect(Object.keys(runtime.reducers)).toEqual([
			"add_mul",
			"emit",
			"malformed_accessor",
			"malformed_extra",
			"malformed_inherited",
			"malformed_symbol",
			"map_set",
			"mutate_bytes",
			"mutate_bytes_then_throw",
			"mutate_inputs",
			"mutate_then_throw",
			"replace_state",
			"return_promise",
			"return_thenable",
			"set_add",
			"throw_sync",
		]);
	});

	it("proves the exact byte, depth and decoded-item boundary fixtures against the frozen codec", () => {
		const exactItemBound = itemBoundState(contract.limits.maxItems);
		const accepted = [stateAtExactByteLimit(), exactItemBound, depthBoundState(contract.limits.maxDepth)];
		for (const value of accepted) {
			const bytes = encodeCanonical(value);
			expect(() => decodeCanonical(bytes, contract.limits)).not.toThrow();
		}
		expect(() =>
			decodeCanonical(encodeCanonical(exactItemBound), {
				...contract.limits,
				maxItems: contract.limits.maxItems - 1,
			})
		).toThrow();
		for (const value of [
			{ payload: `${stateAtExactByteLimit().payload as string}x` },
			itemBoundState(contract.limits.maxItems, true),
			depthBoundState(contract.limits.maxDepth + 1),
		]) {
			const bytes = encodeCanonical(value);
			expect(() => decodeCanonical(bytes, contract.limits)).toThrow();
		}
	});
});

describe.skipIf(!phase4aReady)("Phase 4a prepared application seam", () => {
	it("uses genuine private provenance and schema instead of the public reducer table", async () => {
		const [{ application }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		const applied = application.applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation: { action: "map_set", key: "alpha", value: "one" },
			preparedBlueprintRuntime: runtime,
			state: canonicalClone(contract.initialState),
		});
		expect(applied).toEqual({
			output: "one",
			state: { map: { alpha: "one" }, set: [], total: 1 },
		});

		for (const substituted of [
			Object.freeze({ ...runtime }),
			Object.create(runtime) as PreparedBlueprintRuntime,
			new Proxy(runtime, {}),
		]) {
			expect(
				errorCode(() =>
					application.applyPreparedBlueprintOperation({
						expectedBlueprintDigest,
						operation: { action: "map_set", key: "alpha", value: "substituted" },
						preparedBlueprintRuntime: substituted,
						state: canonicalClone(contract.initialState),
					})
				)
			).toBe("BLUEPRINT_RUNTIME_PROVENANCE");
		}

		const crossPairedPackage = canonicalClone(blueprintPackage) as {
			manifest: { operations: Array<{ argumentSchema: { fields: Array<{ required: boolean }> } }> };
		};
		const changedField = crossPairedPackage.manifest.operations.find(
			(operation) => operation.argumentSchema.fields.length > 0
		)?.argumentSchema.fields[0];
		if (changedField === undefined) throw new Error("cross-paired fixture has no argument field");
		changedField.required = false;
		const crossPairedRuntime = await prepareRuntimeWith(
			{ prepareBlueprintAdmission, prepareBlueprintRuntime },
			crossPairedPackage
		);
		expect(
			errorCode(() =>
				application.applyPreparedBlueprintOperation({
					expectedBlueprintDigest,
					operation: { action: "map_set", key: "alpha", value: "one" },
					preparedBlueprintRuntime: crossPairedRuntime,
					state: canonicalClone(contract.initialState),
				})
			)
		).toBe("BLUEPRINT_DIGEST_MISMATCH");

		const foreignSurface = (await import(FOREIGN_PROTOCOL_MODULE_PATH)) as RuntimePreparationSurface;
		const foreignRuntime = await prepareRuntimeWith(foreignSurface);
		expect(
			errorCode(() =>
				application.applyPreparedBlueprintOperation({
					expectedBlueprintDigest,
					operation: { action: "map_set", key: "alpha", value: "one" },
					preparedBlueprintRuntime: foreignRuntime,
					state: canonicalClone(contract.initialState),
				})
			)
		).toBe("BLUEPRINT_RUNTIME_PROVENANCE");

		expect(
			errorCode(() =>
				application.applyPreparedBlueprintOperation({
					expectedBlueprintDigest: "f".repeat(64),
					operation: { action: "map_set", key: "alpha", value: "one" },
					preparedBlueprintRuntime: runtime,
					state: canonicalClone(contract.initialState),
				})
			)
		).toBe("BLUEPRINT_DIGEST_MISMATCH");

		for (const operation of [
			{ action: "undeclared" },
			{ key: "alpha", type: "map_set", value: "one" },
			{ action: "map_set", key: "alpha" },
			{ action: "map_set", extra: true, key: "alpha", value: "one" },
			Object.create({ action: "map_set", key: "alpha", value: "one" }),
		]) {
			expect(
				errorCode(() =>
					application.applyPreparedBlueprintOperation({
						expectedBlueprintDigest,
						operation,
						preparedBlueprintRuntime: runtime,
						state: canonicalClone(contract.initialState),
					})
				)
			).toBe("BLUEPRINT_OPERATION_INVALID");
		}
	});

	it("keeps dispatch in the private index owner and package roots isolated", () => {
		const applicationSource = readFileSync(APPLICATION_SOURCE, "utf8");
		const indexSource = readFileSync(PROTOCOL_INDEX_SOURCE, "utf8");
		const compactionRoot = readFileSync(resolve(REPOSITORY_ROOT, "packages/compaction/src/index.ts"), "utf8");
		const foldSource = readFileSync(FOLD_SOURCE, "utf8");
		const protocolPackage = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/package.json"), "utf8")
		) as { exports: Readonly<Record<string, unknown>> };
		const compactionPackage = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/compaction/package.json"), "utf8")
		) as { exports: Readonly<Record<string, unknown>> };

		expect(applicationSource).toMatch(
			/export\s*\{\s*applyPreparedBlueprintOperation\s*\}\s*from\s*["']\.\/index\.js["']/u
		);
		expect(privateDispatchSourceAccepted(indexSource)).toBe(true);
		expect(
			privateDispatchSourceAccepted(
				indexSource.replace(/(?:runtimeState|preparedRuntime)\.reducers/u, "preparedBlueprintRuntime.reducers")
			)
		).toBe(false);
		const cloneOwners = `${indexSource}\n${foldSource}`;
		expect(canonicalCloneSourceAccepted(cloneOwners)).toBe(true);
		expect(canonicalCloneSourceAccepted(cloneOwners.replace(/deepCloneCanonical/u, "structuredClone"))).toBe(false);
		expect(compactionRoot).not.toMatch(/blueprint-fold/u);
		expect(protocolPackage.exports).toHaveProperty("./blueprint-application");
		expect(compactionPackage.exports).toHaveProperty("./blueprint-fold");
	});

	it("detaches both reducer inputs and rejects throws, promises and hostile thenables", async () => {
		const [{ application }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		const state = canonicalClone(contract.initialState);
		const operation = { action: "mutate_inputs", value: 7 };
		const stateBefore = encodeCanonical(state);
		const operationBefore = encodeCanonical(operation);
		const applied = application.applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation,
			preparedBlueprintRuntime: runtime,
			state,
		});
		expect(applied).toEqual({ output: 7, state: { map: {}, set: [], total: 7 } });
		expect(compareBytes(encodeCanonical(state), stateBefore)).toBe(0);
		expect(compareBytes(encodeCanonical(operation), operationBefore)).toBe(0);

		for (const [action, expectedCode] of [
			["throw_sync", "BLUEPRINT_REDUCER_FAILED"],
			["return_promise", "BLUEPRINT_REDUCER_ASYNC"],
			["return_thenable", "BLUEPRINT_REDUCER_ASYNC"],
		] as const) {
			expect(
				errorCode(() =>
					application.applyPreparedBlueprintOperation({
						expectedBlueprintDigest,
						operation: { action },
						preparedBlueprintRuntime: runtime,
						state: canonicalClone(contract.initialState),
					})
				)
			).toBe(expectedCode);
		}

		const failingState = canonicalClone(contract.initialState);
		const failingOperation = { action: "mutate_then_throw", value: 23 };
		const failingStateBefore = encodeCanonical(failingState);
		const failingOperationBefore = encodeCanonical(failingOperation);
		expect(
			errorCode(() =>
				application.applyPreparedBlueprintOperation({
					expectedBlueprintDigest,
					operation: failingOperation,
					preparedBlueprintRuntime: runtime,
					state: failingState,
				})
			)
		).toBe("BLUEPRINT_REDUCER_FAILED");
		expect(compareBytes(encodeCanonical(failingState), failingStateBefore)).toBe(0);
		expect(compareBytes(encodeCanonical(failingOperation), failingOperationBefore)).toBe(0);

		const byteOperation = { action: "mutate_bytes", value: { bytes: Uint8Array.of(1, 2, 3) } };
		const byteOperationBefore = encodeCanonical(byteOperation);
		const byteApplied = application.applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation: byteOperation,
			preparedBlueprintRuntime: runtime,
			state: canonicalClone(contract.initialState),
		});
		expect((byteApplied.output as { bytes: Uint8Array }).bytes).toEqual(Uint8Array.of(255, 2, 3));
		expect(compareBytes(encodeCanonical(byteOperation), byteOperationBefore)).toBe(0);

		const failingByteOperation = {
			action: "mutate_bytes_then_throw",
			value: { bytes: Uint8Array.of(4, 5, 6) },
		};
		const failingByteOperationBefore = encodeCanonical(failingByteOperation);
		expect(
			errorCode(() =>
				application.applyPreparedBlueprintOperation({
					expectedBlueprintDigest,
					operation: failingByteOperation,
					preparedBlueprintRuntime: runtime,
					state: canonicalClone(contract.initialState),
				})
			)
		).toBe("BLUEPRINT_REDUCER_FAILED");
		expect(compareBytes(encodeCanonical(failingByteOperation), failingByteOperationBefore)).toBe(0);

		for (const action of ["malformed_accessor", "malformed_extra", "malformed_inherited", "malformed_symbol"]) {
			expect(
				errorCode(() =>
					application.applyPreparedBlueprintOperation({
						expectedBlueprintDigest,
						operation: { action },
						preparedBlueprintRuntime: runtime,
						state: canonicalClone(contract.initialState),
					})
				)
			).toBe("BLUEPRINT_RESULT_INVALID");
		}

		const objectOperation = { action: "emit", value: { nested: { count: 1 } } };
		const detached = application.applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation: objectOperation,
			preparedBlueprintRuntime: runtime,
			state: canonicalClone(contract.initialState),
		});
		(detached.output as { nested: { count: number } }).nested.count = 99;
		(detached.state as { total: number }).total = 99;
		expect(objectOperation).toEqual({ action: "emit", value: { nested: { count: 1 } } });
		const repeated = application.applyPreparedBlueprintOperation({
			expectedBlueprintDigest,
			operation: objectOperation,
			preparedBlueprintRuntime: runtime,
			state: canonicalClone(contract.initialState),
		});
		expect(repeated.output).toEqual({ nested: { count: 1 } });
		expect(repeated.state).toEqual(contract.initialState);
	});
});

describe.skipIf(!phase4aReady)("Phase 4a bounded staged machine", () => {
	it("binds exact canonical genesis bytes and returns detached snapshots", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		const emptyStateBytes = encodeCanonical({});
		const empty = machine(fold.BlueprintStateMachine, runtime, emptyStateBytes, stateDigest(emptyStateBytes));
		expect(compareBytes(empty.snapshot().exactCanonicalStateBytes, emptyStateBytes)).toBe(0);
		const sourceCarrier = new Uint8Array(exactCanonicalInitialStateBytes);
		const original = machine(fold.BlueprintStateMachine, runtime, sourceCarrier);
		const first = original.snapshot();
		expect(first.stateDigest).toBe(expectedInitialStateDigest);
		expect(compareBytes(first.exactCanonicalStateBytes, exactCanonicalInitialStateBytes)).toBe(0);
		first.exactCanonicalStateBytes.fill(0);
		const second = original.snapshot();
		expect(compareBytes(second.exactCanonicalStateBytes, exactCanonicalInitialStateBytes)).toBe(0);
		sourceCarrier.fill(0);
		expect(compareBytes(original.snapshot().exactCanonicalStateBytes, exactCanonicalInitialStateBytes)).toBe(0);

		const negativeZero = Uint8Array.of(0x04, 0x80, 0, 0, 0, 0, 0, 0, 0);
		for (const invalidBytes of [
			new Uint8Array(),
			new Uint8Array([...exactCanonicalInitialStateBytes, 0]),
			negativeZero,
		]) {
			expect(
				errorCode(() => machine(fold.BlueprintStateMachine, runtime, invalidBytes, stateDigest(invalidBytes)))
			).toBe("INVALID_APPLICATION_STATE");
		}
		expect(
			errorCode(() => machine(fold.BlueprintStateMachine, runtime, exactCanonicalInitialStateBytes, "f".repeat(64)))
		).toBe("INVALID_APPLICATION_STATE");

		if (typeof SharedArrayBuffer === "function") {
			const shared = new Uint8Array(new SharedArrayBuffer(exactCanonicalInitialStateBytes.byteLength));
			shared.set(exactCanonicalInitialStateBytes);
			expect(errorCode(() => machine(fold.BlueprintStateMachine, runtime, shared, expectedInitialStateDigest))).toBe(
				"INVALID_APPLICATION_STATE"
			);
		}

		const detachable = new Uint8Array(exactCanonicalInitialStateBytes);
		structuredClone(detachable.buffer, { transfer: [detachable.buffer] });
		expect(errorCode(() => machine(fold.BlueprintStateMachine, runtime, detachable, expectedInitialStateDigest))).toBe(
			"INVALID_APPLICATION_STATE"
		);

		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		const sparse = Array.from({ length: 2 }, () => 0);
		delete sparse[0];
		class UnsupportedState {
			public readonly value = 1;
		}
		for (const invalidValue of [new Date(0), new UnsupportedState(), accessor, sparse]) {
			expect(() => stateBytes(invalidValue)).toThrow();
		}
	});

	it("enforces each application-value bound at initial, next-state and output boundaries", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		const atBytes = stateAtExactByteLimit();
		const atItems = itemBoundState(contract.limits.maxItems);
		const atDepth = depthBoundState(contract.limits.maxDepth);
		for (const accepted of [atBytes, atItems, atDepth]) {
			const bytes = stateBytes(accepted);
			expect(() => machine(fold.BlueprintStateMachine, runtime, bytes, stateDigest(bytes))).not.toThrow();
			const nextStateMachine = machine(fold.BlueprintStateMachine, runtime);
			expect(nextStateMachine.apply({ action: "replace_state", value: accepted })).toBeNull();
			expect(decodeCanonical(nextStateMachine.snapshot().exactCanonicalStateBytes)).toEqual(accepted);
			const outputMachine = machine(fold.BlueprintStateMachine, runtime);
			expect(outputMachine.apply({ action: "emit", value: accepted })).toEqual(accepted);
			expect(decodeCanonical(outputMachine.snapshot().exactCanonicalStateBytes)).toEqual(contract.initialState);
		}

		const overBytes = { payload: `${(atBytes as { payload: string }).payload}x` };
		const overItems = itemBoundState(contract.limits.maxItems, true);
		const overDepth = depthBoundState(contract.limits.maxDepth + 1);
		for (const rejected of [overBytes, overItems, overDepth]) {
			const bytes = encodeCanonical(rejected);
			expect(errorCode(() => machine(fold.BlueprintStateMachine, runtime, bytes, stateDigest(bytes)))).toBe(
				"INVALID_APPLICATION_STATE"
			);
		}

		const staged = machine(fold.BlueprintStateMachine, runtime);
		for (const [action, value] of [
			["replace_state", overBytes],
			["replace_state", overItems],
			["replace_state", overDepth],
			["emit", overBytes],
			["emit", overItems],
			["emit", overDepth],
		] as const) {
			expect(errorCode(() => staged.fork().apply({ action, value }))).toBe("INVALID_APPLICATION_STATE");
		}
	});

	it("forks and adopts explicitly without sharing staged state", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		const original = machine(fold.BlueprintStateMachine, runtime);
		const staged = original.fork();
		expect(staged.apply({ action: "map_set", key: "alpha", value: "one" })).toBe("one");
		expect(decodeCanonical(original.snapshot().exactCanonicalStateBytes)).toEqual(contract.initialState);
		expect(decodeCanonical(staged.snapshot().exactCanonicalStateBytes)).toEqual({
			map: { alpha: "one" },
			set: [],
			total: 1,
		});
		const adopted = original.adopt(staged);
		expect(decodeCanonical(adopted.exactCanonicalStateBytes)).toEqual({ map: { alpha: "one" }, set: [], total: 1 });
		expect(errorCode(() => original.adopt(staged))).toBe("BLUEPRINT_ALREADY_ADOPTED");
	});
});

describe.skipIf(!phase4aReady)("Phase 4a atomic epoch fold", () => {
	it("uses deterministic order, explicit authorization and one-use adoption", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		for (const insertionOrder of [
			[0, 1, 2],
			[2, 1, 0],
			[1, 0, 2],
		]) {
			const vertices = graph(insertionOrder);
			const expected = await independentExpectation(vertices);
			const original = machine(fold.BlueprintStateMachine, runtime);
			const authorizationOrder: string[] = [];
			const result = fold.foldBlueprintEpoch({
				anchorHash: contract.graph.anchorHash,
				authorize({ hash }): boolean {
					authorizationOrder.push(hash);
					return true;
				},
				machine: original,
				vertices,
			});
			expect(result.order).toEqual(expected.order);
			expect(authorizationOrder).toEqual(expected.order);
			expect(result.outputs).toEqual(expected.outputs);
			expect(decodeCanonical(result.staged.exactCanonicalStateBytes)).toEqual(expected.state);
			expect(decodeCanonical(original.snapshot().exactCanonicalStateBytes)).toEqual(contract.initialState);
			const redelivery = fold.foldBlueprintEpoch({
				anchorHash: contract.graph.anchorHash,
				authorize: () => true,
				machine: original,
				vertices,
			});
			expect(redelivery.staged).toEqual(result.staged);
			const adopted = result.adopt();
			expect(decodeCanonical(adopted.exactCanonicalStateBytes)).toEqual(expected.state);
			expect(errorCode(() => result.adopt())).toBe("BLUEPRINT_ALREADY_ADOPTED");
			expect(errorCode(() => redelivery.adopt())).toBe("BLUEPRINT_ALREADY_ADOPTED");
		}

		const byteVertices = graph();
		const byteHash = contract.graph.vertices[2]?.hash as string;
		const byteVertex = byteVertices.get(byteHash) as EpochVertex;
		byteVertices.set(byteHash, {
			...byteVertex,
			operation: { action: "mutate_bytes", value: { bytes: Uint8Array.of(7, 8, 9) } },
		});
		const byteGraphBefore = encodeCanonical(
			[...byteVertices].map(([hash, vertex]) => ({ hash, operation: vertex.operation ?? null }))
		);
		const byteFold = fold.foldBlueprintEpoch({
			anchorHash: contract.graph.anchorHash,
			authorize: () => true,
			machine: machine(fold.BlueprintStateMachine, runtime),
			vertices: byteVertices,
		});
		expect(byteFold.outputs.at(-1)).toEqual({ bytes: Uint8Array.of(255, 8, 9) });
		expect(
			compareBytes(
				encodeCanonical([...byteVertices].map(([hash, vertex]) => ({ hash, operation: vertex.operation ?? null }))),
				byteGraphBefore
			)
		).toBe(0);
	});

	it("fails atomically before unauthorized reduction and never applies the anchor", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		for (const [authorize, expectedCode] of [
			[undefined, "BLUEPRINT_AUTHORIZATION_REQUIRED"],
			[(): boolean => false, "BLUEPRINT_AUTHORIZATION_REJECTED"],
			[(): string => "yes", "BLUEPRINT_AUTHORIZATION_REJECTED"],
			[
				(): never => {
					throw new Error("no authority");
				},
				"BLUEPRINT_AUTHORIZATION_REJECTED",
			],
		] as const) {
			const original = machine(fold.BlueprintStateMachine, runtime);
			const before = original.snapshot();
			const input = {
				anchorHash: contract.graph.anchorHash,
				authorize,
				machine: original,
				vertices: graph(),
			} as Parameters<BlueprintFoldModule["foldBlueprintEpoch"]>[0];
			expect(errorCode(() => fold.foldBlueprintEpoch(input))).toBe(expectedCode);
			const after = original.snapshot();
			expect(after.stateDigest).toBe(before.stateDigest);
			expect(compareBytes(after.exactCanonicalStateBytes, before.exactCanonicalStateBytes)).toBe(0);
		}

		const rejectedBeforeReduce = graph();
		const firstHash = orderedApplicationVertices(rejectedBeforeReduce)[0]?.hash as string;
		const first = rejectedBeforeReduce.get(firstHash) as EpochVertex;
		rejectedBeforeReduce.set(firstHash, { ...first, operation: { action: "throw_sync" } });
		const rejectedMachine = machine(fold.BlueprintStateMachine, runtime);
		expect(
			errorCode(() =>
				fold.foldBlueprintEpoch({
					anchorHash: contract.graph.anchorHash,
					authorize: () => false,
					machine: rejectedMachine,
					vertices: rejectedBeforeReduce,
				})
			)
		).toBe("BLUEPRINT_AUTHORIZATION_REJECTED");

		const withAnchorOperation = graph();
		withAnchorOperation.set(contract.graph.anchorHash, {
			...(withAnchorOperation.get(contract.graph.anchorHash) as EpochVertex),
			operation: { action: "add_mul", add: 99, multiplier: 99 },
		});
		const original = machine(fold.BlueprintStateMachine, runtime);
		const expected = await independentExpectation(withAnchorOperation);
		const result = fold.foldBlueprintEpoch({
			anchorHash: contract.graph.anchorHash,
			authorize: () => true,
			machine: original,
			vertices: withAnchorOperation,
		});
		expect(result.outputs).toEqual(expected.outputs);
	});

	it("preserves the original machine and graph bytes after reducer failure", async () => {
		const [{ fold }, runtime] = await Promise.all([loadPhase4a(), prepareFixtureRuntime()]);
		for (const [action, expectedCode] of [
			["throw_sync", "BLUEPRINT_REDUCER_FAILED"],
			["mutate_then_throw", "BLUEPRINT_REDUCER_FAILED"],
			["mutate_bytes_then_throw", "BLUEPRINT_REDUCER_FAILED"],
			["return_promise", "BLUEPRINT_REDUCER_ASYNC"],
			["return_thenable", "BLUEPRINT_REDUCER_ASYNC"],
		] as const) {
			const vertices = graph();
			const failingHash = contract.graph.vertices[2]?.hash as string;
			const failing = vertices.get(failingHash) as EpochVertex;
			vertices.set(failingHash, {
				...failing,
				operation: {
					action,
					...(action === "mutate_then_throw" ? { value: 31 } : {}),
					...(action === "mutate_bytes_then_throw" ? { value: { bytes: Uint8Array.of(10, 11) } } : {}),
				},
			});
			const graphBefore = encodeCanonical(
				[...vertices].map(([hash, vertex]) => ({ hash, operation: vertex.operation ?? null }))
			);
			const original = machine(fold.BlueprintStateMachine, runtime);
			const stateBefore = original.snapshot();
			expect(
				errorCode(() =>
					fold.foldBlueprintEpoch({
						anchorHash: contract.graph.anchorHash,
						authorize: () => true,
						machine: original,
						vertices,
					})
				)
			).toBe(expectedCode);
			const stateAfter = original.snapshot();
			expect(compareBytes(stateAfter.exactCanonicalStateBytes, stateBefore.exactCanonicalStateBytes)).toBe(0);
			expect(
				compareBytes(
					encodeCanonical([...vertices].map(([hash, vertex]) => ({ hash, operation: vertex.operation ?? null }))),
					graphBefore
				)
			).toBe(0);
		}
	});
});
