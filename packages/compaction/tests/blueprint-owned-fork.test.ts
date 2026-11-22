import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {prepareBlueprintAdmission, prepareBlueprintRuntime, type PreparedBlueprintRuntime} from "../../protocol-v3/src/public.js";
import {BlueprintStateMachine, foldBlueprintEpoch} from "../src/blueprint-fold.js";
import type {EpochVertex} from "../src/types.js";
import blueprintPackage from "../../../tests/fixtures/phase-4a-v3/blueprint-package.json" with {type: "json"};

const calls = vi.hoisted(() => ({encode: 0, decode: 0, clone: 0, hash: 0, apply: 0}));
vi.mock("@ts-drp/canonical", async importOriginal => {
	const actual = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {...actual,
		encodeCanonical: (...args: Parameters<typeof actual.encodeCanonical>) => {calls.encode++; return actual.encodeCanonical(...args);},
		decodeCanonical: (...args: Parameters<typeof actual.decodeCanonical>) => {calls.decode++; return actual.decodeCanonical(...args);},
		deepCloneCanonical: (...args: Parameters<typeof actual.deepCloneCanonical>) => {calls.clone++; return actual.deepCloneCanonical(...args);},
		hashDomain: (...args: Parameters<typeof actual.hashDomain>) => {calls.hash++; return actual.hashDomain(...args);},
	};
});
vi.mock("@ts-drp/protocol-v3/blueprint-application", async importOriginal => {
	const actual = await importOriginal<typeof import("@ts-drp/protocol-v3/blueprint-application")>();
	return {...actual, applyPreparedBlueprintOperation: (...args: Parameters<typeof actual.applyPreparedBlueprintOperation>) => {
		calls.apply++; return actual.applyPreparedBlueprintOperation(...args);
	}, applyPreparedBlueprintOperationToCanonicalState: (...args: Parameters<typeof actual.applyPreparedBlueprintOperationToCanonicalState>) => {
		calls.apply++; return actual.applyPreparedBlueprintOperationToCanonicalState(...args);
	}};
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
let runtimePromise: Promise<PreparedBlueprintRuntime> | undefined;
function runtime() {
	return runtimePromise ??= (() => {
		const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
		const expectedBlueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes));
		const preparedBlueprintAdmission = prepareBlueprintAdmission({canonicalBlueprintPackageBytes, expectedBlueprintDigest});
		return prepareBlueprintRuntime({canonicalBlueprintPackageBytes, expectedBlueprintDigest, preparedBlueprintAdmission,
			exactArtifactBytes: new Uint8Array(readFileSync(new URL("../../../tests/fixtures/phase-4a-v3/application-blueprint.mjs", import.meta.url)))});
	})();
}
function input(runtime: PreparedBlueprintRuntime, state: unknown = {map: {}, set: [], total: 1}, maxApplicationStateBytes?: number) {
	const bytes = encodeCanonical(state);
	return {exactCanonicalInitialStateBytes: bytes, expectedBlueprintDigest: runtime.blueprintDigest,
		expectedInitialStateDigest: hex(hashDomain("ts-drp/state/v3", bytes)), preparedBlueprintRuntime: runtime,
		...(maxApplicationStateBytes === undefined ? {} : {maxApplicationStateBytes})};
}
const state = (machine: BlueprintStateMachine): any => decodeCanonical(machine.snapshot().exactCanonicalStateBytes);
const reset = () => {for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;};
const code = (run: () => unknown) => {try {run(); return undefined;} catch (error) {
	return error instanceof Error && "code" in error ? error.code : undefined;
}};
function graph(entries: {hash: string; operation: unknown}[]) {
	const anchorHash = "0".repeat(64), objectId = "owned-fork", epoch = 1;
	const vertices = new Map<string, EpochVertex>([[anchorHash, {hash: anchorHash, kind: "drp-epoch-anchor", objectId, epoch, dependencies: []}]]);
	for (const entry of entries) vertices.set(entry.hash, {hash: entry.hash, kind: "drp-vertex", objectId, epoch,
		anchor: anchorHash, dependencies: [anchorHash], operation: entry.operation as NonNullable<EpochVertex["operation"]>});
	return {anchorHash, vertices};
}

describe("owned blueprint fork/adopt representations", () => {
	it("fork and adopt perform no canonical traversal, digest or reducer probe regardless of owned state size", async () => {
		const prepared = await runtime();
		for (const size of [16, 16_000]) {
			const parent = new BlueprintStateMachine(input(prepared, {bytes: new Uint8Array(size)}));
			reset(); const staged = parent.fork();
			expect(calls).toEqual({encode: 0, decode: 0, clone: 0, hash: 0, apply: 0});
			const snapshot = parent.adopt(staged);
			expect(calls).toEqual({encode: 0, decode: 0, clone: 0, hash: 0, apply: 0});
			snapshot.exactCanonicalStateBytes.fill(0);
			expect(state(parent)).toEqual({bytes: new Uint8Array(size)});
		}
	});
	it("isolates parent, stage, consumed-stage descendants, caller bytes and output aliases in both directions", async () => {
		const prepared = await runtime(), source = input(prepared), parent = new BlueprintStateMachine(source);
		source.exactCanonicalInitialStateBytes.fill(0);
		const stage = parent.fork(), operation = {action: "mutate_inputs", value: 5};
		stage.apply(operation); expect(operation.value).toBe(5); expect(state(parent).total).toBe(1);
		parent.adopt(stage); expect(state(parent).total).toBe(5);
		stage.apply({action: "mutate_inputs", value: 8}); expect(state(parent).total).toBe(5);
		parent.apply({action: "mutate_inputs", value: 11}); expect(state(stage).total).toBe(8);
		const descendant = stage.fork(); descendant.apply({action: "mutate_inputs", value: 13}); stage.adopt(descendant);
		expect(state(stage).total).toBe(13); expect(state(parent).total).toBe(11);
		const bytes = Uint8Array.of(1, 2), output = stage.apply({action: "mutate_bytes", value: {bytes}}) as {bytes: Uint8Array};
		expect(bytes).toEqual(Uint8Array.of(1, 2)); output.bytes.fill(9);
		expect(state(stage).total).toBe(13); expect(state(parent).total).toBe(11);
	});
	it("preserves failed reducer atomicity, stale/foreign adoption refusal and per-fork state/output limits", async () => {
		const prepared = await runtime(), parent = new BlueprintStateMachine(input(prepared)), stage = parent.fork();
		const before = parent.snapshot();
		expect(code(() => stage.apply({action: "mutate_then_throw", value: 99}))).toBe("BLUEPRINT_REDUCER_FAILED");
		expect(stage.snapshot()).toEqual(before); expect(parent.snapshot()).toEqual(before);
		const foreign = new BlueprintStateMachine(input(prepared)).fork();
		expect(code(() => parent.adopt(foreign))).toBe("BLUEPRINT_ALREADY_ADOPTED");
		parent.apply({action: "emit", value: {}});
		expect(code(() => parent.adopt(stage))).toBe("BLUEPRINT_ALREADY_ADOPTED");
		const fresh = parent.fork(); parent.adopt(fresh);
		expect(code(() => parent.adopt(fresh))).toBe("BLUEPRINT_ALREADY_ADOPTED");
		const bounded = new BlueprintStateMachine(input(prepared, {map: {}, set: [], total: 1}, 64)), child = bounded.fork();
		const boundedBefore = child.snapshot();
		expect(code(() => child.apply({action: "replace_state", value: {bytes: new Uint8Array(100)}}))).toBe("INVALID_APPLICATION_STATE");
		expect(child.snapshot()).toEqual(boundedBefore);
		expect(code(() => child.apply({action: "emit", value: {bytes: new Uint8Array(100)}}))).toBe("INVALID_APPLICATION_STATE");
		expect(child.snapshot()).toEqual(boundedBefore); expect(bounded.snapshot()).toEqual(boundedBefore);
	});
	it("leaves unknown, proxied and foreign public inputs on original validation boundaries", async () => {
		const prepared = await runtime(), valid = input(prepared);
		expect(code(() => new BlueprintStateMachine({...valid, expectedInitialStateDigest: "f".repeat(64)}))).toBe("INVALID_APPLICATION_STATE");
		expect(code(() => new BlueprintStateMachine({...valid, preparedBlueprintRuntime: {...prepared}}))).toBe("BLUEPRINT_RUNTIME_PROVENANCE");
		expect(code(() => new BlueprintStateMachine({...valid, expectedBlueprintDigest: "invalid"}))).toBe("BLUEPRINT_DIGEST_MISMATCH");
		const proxied = new Proxy({...valid, expectedInitialStateDigest: "f".repeat(64)}, {
			get(target, key, receiver) {return Reflect.get(target, key, receiver);},
		});
		expect(code(() => new BlueprintStateMachine(proxied))).toBe("INVALID_APPLICATION_STATE");
		const reopened = new BlueprintStateMachine({...valid, exactCanonicalInitialStateBytes: valid.exactCanonicalInitialStateBytes.slice()});
		expect(reopened.snapshot()).toEqual(new BlueprintStateMachine(valid).snapshot());
	});
	it("reexecutes noncommutative reordered folds with fresh per-vertex authorization/context and matches a fresh full oracle", async () => {
		const prepared = await runtime(), parent = new BlueprintStateMachine(input(prepared));
		const b = {hash: "b".repeat(64), operation: {action: "add_mul", add: 2, multiplier: 3}};
		const a = {hash: "a".repeat(64), operation: {action: "add_mul", add: 1, multiplier: 2}};
		const auth: string[] = [], contexts: string[] = [];
		const run = (selected: BlueprintStateMachine, entries: typeof a[], author: string) => foldBlueprintEpoch({machine: selected, ...graph(entries),
			authorize: ({hash}) => {auth.push(hash); return true;}, executionContext: ({hash}) => {contexts.push(hash); return {author};}});
		reset(); const first = run(parent, [b], "1".repeat(64));
		expect(calls.apply).toBe(1); expect((decodeCanonical(first.staged.exactCanonicalStateBytes) as any).total).toBe(9);
		const changed = run(parent, [b, a], "2".repeat(64));
		expect(calls.apply).toBe(3); expect(auth).toEqual([b.hash, a.hash, b.hash]); expect(contexts).toEqual(auth);
		const oracle = run(new BlueprintStateMachine(input(prepared)), [a, b], "2".repeat(64));
		expect(changed.staged).toEqual(oracle.staged); expect(changed.outputs).toEqual(oracle.outputs);
		expect((decodeCanonical(changed.staged.exactCanonicalStateBytes) as any).total).toBe(18);
		const mutatedGraph = graph([a, b]); (mutatedGraph.vertices.get(a.hash)!.operation as any).add = 4;
		const next = foldBlueprintEpoch({machine: parent, ...mutatedGraph, authorize: () => true});
		expect((decodeCanonical(next.staged.exactCanonicalStateBytes) as any).total).toBe(36);
		parent.apply({action: "mutate_inputs", value: 7});
		expect(code(() => changed.adopt())).toBe("BLUEPRINT_ALREADY_ADOPTED");
		const rebased = run(parent, [a, b], "3".repeat(64));
		// The caller intentionally changed a.operation.add to4 above. Recompute
		// from the changed base AND changed operation, not a remembered prefix.
		expect((decodeCanonical(rebased.staged.exactCanonicalStateBytes) as any).total).toBe(72);
		const freshBase = new BlueprintStateMachine(input(prepared, {map: {}, set: [], total: 7}));
		expect(rebased.staged).toEqual(run(freshBase, [a, b], "3".repeat(64)).staged);
	});
});
