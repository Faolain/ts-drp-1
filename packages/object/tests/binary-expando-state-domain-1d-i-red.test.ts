import "./helpers/trusted-vertex-ingest.js";

import { DRPState, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";
import { trackMutations } from "../src/proxy.js";
import { detachStatePayload } from "../src/state-payload.js";
import { type DRPObjectStateManager } from "../src/state.js";

type BinaryWithExpandos = object;

interface ReplicaLocalContext {
	caller: string;
	nested: {
		scratch: Uint8Array & Record<"metadata", { local: string; owner: unknown }>;
		alias: Uint8Array & Record<"metadata", { local: string; owner: unknown }>;
		data: DataView & Record<"metadata", { local: string }>;
	};
	buffer: Buffer;
	backing: ArrayBuffer;
}

interface Captured<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
}

interface RootCycleState {
	context: { local: string; root: RootCycleState };
	governed: object;
	assigned: string;
	defined?: string;
	deleted: string;
}

function capture<T>(run: () => T): Captured<T> {
	try {
		return { ok: true, value: run() };
	} catch (error) {
		return { ok: false, error };
	}
}

function addExpando<T extends object, K extends PropertyKey, V>(
	value: T,
	key: K,
	contents: V,
	enumerable: boolean
): T & Record<K, V> {
	Reflect.defineProperty(value, key, {
		configurable: true,
		enumerable,
		value: contents,
		writable: true,
	});
	return value as T & Record<K, V>;
}

function expandoCases(): Array<readonly [string, BinaryWithExpandos]> {
	const families: Array<readonly [string, () => object]> = [
		["TypedArray", (): object => new Uint16Array([2, 3])],
		["BigInt TypedArray", (): object => new BigInt64Array([BigInt(5)])],
		["Node Buffer", (): object => Buffer.from([7, 8])],
		["DataView", (): object => new DataView(new ArrayBuffer(4))],
		["ArrayBuffer", (): object => new ArrayBuffer(4)],
	];
	if (typeof SharedArrayBuffer !== "undefined") {
		families.push(["SharedArrayBuffer", (): object => new SharedArrayBuffer(4)]);
	}
	const shapes: Array<readonly [string, () => PropertyKey, boolean]> = [
		["string/enumerable", (): PropertyKey => "metadata", true],
		["string/non-enumerable", (): PropertyKey => "metadata", false],
		["symbol/enumerable", (): PropertyKey => Symbol("metadata"), true],
		["symbol/non-enumerable", (): PropertyKey => Symbol("metadata"), false],
	];
	return families.flatMap(([family, create]) =>
		shapes.map(([shape, key, enumerable]) => [`${family}/${shape}`, addExpando(create(), key(), "local", enumerable)])
	);
}

function replicaLocalContext(): ReplicaLocalContext {
	const scratch = new Uint8Array([1, 2, 3]);
	const metadata: { local: string; owner: unknown } = { local: "context", owner: scratch };
	const expandedScratch = addExpando(scratch, "metadata", metadata, true);
	return {
		caller: "",
		nested: {
			scratch: expandedScratch,
			alias: expandedScratch,
			data: addExpando(new DataView(new ArrayBuffer(4)), "metadata", { local: "data-view" }, true),
		},
		buffer: Buffer.from([4, 5, 6]),
		backing: Uint8Array.from([7, 8, 9]).buffer,
	};
}

function rootCycleState(): RootCycleState {
	const state = {
		context: { local: "before", root: undefined as unknown as RootCycleState },
		governed: { stable: true },
		assigned: "before",
		deleted: "present",
	};
	state.context.root = state;
	return state;
}

class BinaryExpandoFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = replicaLocalContext();
	payload = new Uint8Array([3, 5, 8]);
	marker = "root";

	installInvalid(value: number): void {
		const next = addExpando(new Uint8Array([value]), "metadata", { value }, true);
		this.payload = next;
	}

	observeContextMetadata(): string {
		return `${this.context.nested.scratch.metadata.local}:${this.context.nested.data.metadata.local}`;
	}

	touch(label: string): void {
		if (this.context.nested.scratch.metadata.local !== "context") {
			throw new Error("replica-local context metadata missing during adoption");
		}
		this.marker = label;
	}
}

function remoteVertex(
	opType: string,
	value: unknown[],
	dependencies: string[] = [HashGraph.rootHash],
	timestamp = 1
): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value });
	return createVertex("writer", operation, dependencies, timestamp);
}

describe("Phase 1d(i) D.92.3-P3a-prime binary state domain", () => {
	it("rejects own expandos across the governed binary family and descriptor shapes", () => {
		const results = expandoCases().map(([label, value]) => ({
			label,
			rejectedAsTypeError: capture(() => detachStatePayload(value)).error instanceof TypeError,
		}));

		expect(results).toEqual(results.map(({ label }) => ({ label, rejectedAsTypeError: true })));
	});

	it("validates before sealing and rejects an expando acquired before non-extensibility", () => {
		const invalid = addExpando(new Uint8Array([1, 2]), "metadata", "present-before-seal", true);
		Object.preventExtensions(invalid);

		const invalidResult = capture(() => detachStatePayload(invalid));
		expect.soft(invalidResult.error).toBeInstanceOf(TypeError);
		expect.soft(Object.hasOwn(invalid, "metadata"), "rejection must not silently erase the expando").toBe(true);

		const clean = new Uint8Array([4, 6]);
		const copy = detachStatePayload(clean);
		expect.soft([...copy]).toEqual([4, 6]);
		expect.soft(Object.isExtensible(clean), "detachment does not mutate the caller-owned source").toBe(true);
		expect.soft(Object.isExtensible(copy), "the validated governed copy is sealed").toBe(false);
	});

	it("rejects invalid snapshot ingress before installing a stored cut", () => {
		const object = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local"] }),
			drp: new BinaryExpandoFixture(),
		});
		const invalid = addExpando(new DataView(new ArrayBuffer(4)), Symbol("local"), 1, false);
		const snapshot = DRPState.create({ state: [{ key: "payload", value: invalid }] });

		const ingress = capture(() => object.setDRPState("invalid-binary-cut", snapshot));
		expect.soft(ingress.error).toBeInstanceOf(TypeError);
		expect(object.getStates("invalid-binary-cut")).toEqual([undefined, undefined]);
	});

	it("rejects invalid initial governed discovery", () => {
		const governed = addExpando(new Uint8Array([1]), "metadata", "invalid", true);
		expect(() => trackMutations({ governed })).toThrow(TypeError);
	});

	it("leaves replica-local context binaries extensible and uncharged", () => {
		const scratch = addExpando(new Uint8Array([2, 3]), "metadata", { local: true }, true);
		const state = { context: { nested: { scratch } }, governed: { stable: true } };
		const tracked = trackMutations(state);
		tracked.proxy.context.nested.scratch[0] = 9;

		expect.soft(tracked.proxy.context.nested.scratch.metadata).toEqual({ local: true });
		expect.soft([...scratch]).toEqual([9, 3]);
		expect.soft(Object.isExtensible(scratch), "replica-local binaries are not governed or sealed").toBe(true);
		expect.soft(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it("re-enters governed handling when replica-local context cycles to the tracked root", () => {
		const invalidState = rootCycleState();
		const original = invalidState.governed;
		const invalid = addExpando(new Uint8Array([1, 2]), "metadata", "invalid", true);
		const invalidTracked = trackMutations(invalidState);

		invalidTracked.proxy.context.local = "after";
		expect.soft(invalidState.context.local, "the real context remains writable").toBe("after");
		expect.soft(invalidTracked.hasChanges(), "the real context remains uncharged").toBe(false);
		expect.soft([...invalidTracked.changedKeys()]).toEqual([]);

		const rejected = capture(() => Reflect.set(invalidTracked.proxy.context.root, "governed", invalid));
		expect.soft(rejected, "the root alias rejects an expanded governed binary").toEqual({ ok: true, value: false });
		expect.soft(invalidState.governed, "rejection leaves the prior identity installed").toBe(original);
		expect.soft(Object.isExtensible(invalid), "validation runs before sealing").toBe(true);
		expect.soft(Object.isSealed(invalid), "rejected caller input remains unsealed").toBe(false);
		expect.soft(invalidTracked.hasChanges(), "rejection creates no dirty charge").toBe(false);
		expect.soft([...invalidTracked.changedKeys()]).toEqual([]);

		const ordinaryState = rootCycleState();
		const ordinaryTracked = trackMutations(ordinaryState);
		const rootAlias = ordinaryTracked.proxy.context.root;
		const results = [
			Reflect.set(rootAlias, "assigned", "after"),
			Reflect.defineProperty(rootAlias, "defined", {
				configurable: true,
				enumerable: true,
				value: "created",
				writable: true,
			}),
			Reflect.deleteProperty(rootAlias, "deleted"),
		];

		expect.soft(results, "ordinary root-alias writes still succeed").toEqual([true, true, true]);
		expect.soft(ordinaryState.assigned).toBe("after");
		expect.soft(ordinaryState.defined).toBe("created");
		expect.soft("deleted" in ordinaryState).toBe(false);
		expect.soft(ordinaryTracked.hasChanges()).toBe(true);
		expect([...ordinaryTracked.changedKeys()].sort()).toEqual(["assigned", "defined", "deleted"]);
	});

	it("copies view metadata and Buffer/ArrayBuffer contents through construction and reconstruction", () => {
		const object = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local", "writer"] }),
			drp: new BinaryExpandoFixture(),
		});
		const states = (object as unknown as { _states: DRPObjectStateManager<BinaryExpandoFixture> })._states;
		const [reconstructed] = states.fromHash(HashGraph.rootHash);
		if (reconstructed === undefined) throw new Error("positive control: reconstructed DRP missing");

		expect.soft(reconstructed.context.nested.scratch.metadata).toMatchObject({ local: "context" });
		expect.soft(reconstructed.context.nested.alias).toBe(reconstructed.context.nested.scratch);
		expect.soft(reconstructed.context.nested.scratch.metadata.owner).toBe(reconstructed.context.nested.scratch);
		expect.soft(reconstructed.context.nested.data.metadata).toEqual({ local: "data-view" });
		expect.soft(Object.isExtensible(reconstructed.context.nested.scratch)).toBe(true);
		expect.soft(Object.isExtensible(reconstructed.context.nested.data)).toBe(true);
		expect.soft([reconstructed.context.buffer[0], reconstructed.context.buffer[1]]).toEqual([4, 5]);
		expect([...new Uint8Array(reconstructed.context.backing)]).toEqual([7, 8, 9]);
	});

	it("reconstructs nested context for an intercepted clean operation without charging or committing", () => {
		const object = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local", "writer"] }),
			drp: new BinaryExpandoFixture(),
		});
		const drp = object.drp;
		if (drp === undefined) throw new Error("positive control: DRP missing");

		expect(drp.observeContextMetadata()).toBe("context:data-view");
		expect.soft(Object.isExtensible(drp.context.nested.scratch)).toBe(true);
		expect(object.vertices).toHaveLength(1);
	});

	it("does not bless a context identity when the same expando reaches governed state", () => {
		const rawShared = new Uint8Array([1, 2]);
		const shared = addExpando(rawShared, "metadata", { local: "alias", owner: rawShared }, true);
		const fixture = new BinaryExpandoFixture();
		fixture.context.nested.scratch = shared;
		fixture.payload = shared;

		expect(
			() =>
				new DRPObject({
					peerId: "local",
					acl: createACL({ admins: ["local"] }),
					drp: fixture,
				})
		).toThrow(TypeError);
		expect
			.soft(Object.isExtensible(shared), "the rejected governed identity is not sealed after validation fails")
			.toBe(true);
	});

	it("preserves context metadata through one real dependent-batch adoption clone", async () => {
		const object = new DRPObject({
			peerId: "remote",
			acl: createACL({ admins: ["remote", "writer"] }),
			drp: new BinaryExpandoFixture(),
		});
		const first = remoteVertex("touch", ["one"], [HashGraph.rootHash], 20);
		const second = remoteVertex("touch", ["two"], [first.hash], 21);

		await expect(object.applyVertices([first, second])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect.soft(object.drp?.marker).toBe("two");
		expect(object.vertices.some(({ hash }) => hash === second.hash)).toBe(true);
	});

	it("seals clean discovered binaries so tracked set and defineProperty cannot create expandos", () => {
		const payload = new Uint8Array([1, 2, 3]);
		const tracked = trackMutations({ payload, untouched: { stable: true } });
		const symbolKey = Symbol("metadata");

		expect.soft(Object.isExtensible(payload), "initial governed discovery seals the raw identity").toBe(false);
		expect.soft(Reflect.set(tracked.proxy.payload, "metadata", 1), "set rejects an expando").toBe(false);
		expect
			.soft(
				Reflect.defineProperty(tracked.proxy.payload, symbolKey, {
					configurable: true,
					enumerable: false,
					value: 2,
				}),
				"defineProperty rejects an expando"
			)
			.toBe(false);
		expect.soft(Object.hasOwn(payload, "metadata")).toBe(false);
		expect.soft(Object.hasOwn(payload, symbolKey)).toBe(false);
		expect.soft(tracked.hasChanges(), "rejected writes do not dirty state").toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it("rejects pre-expanded values atomically at tracked assignment boundaries", () => {
		const assigned = addExpando(new ArrayBuffer(4), "metadata", "invalid", true);
		const setState = { payload: { stable: true } as object };
		const setTracked = trackMutations(setState);
		const setResult = capture(() => Reflect.set(setTracked.proxy, "payload", assigned));
		expect.soft(setResult).toEqual({ ok: true, value: false });
		expect.soft(setState.payload).toEqual({ stable: true });
		expect.soft(Object.isExtensible(assigned), "invalid input is rejected before sealing").toBe(true);
		expect.soft(setTracked.hasChanges()).toBe(false);

		const defined = addExpando(new DataView(new ArrayBuffer(4)), Symbol("metadata"), "invalid", false);
		const defineState = { payload: { stable: true } as object };
		const defineTracked = trackMutations(defineState);
		const defineResult = capture(() =>
			Reflect.defineProperty(defineTracked.proxy, "payload", {
				configurable: true,
				enumerable: true,
				value: defined,
				writable: true,
			})
		);
		expect.soft(defineResult).toEqual({ ok: true, value: false });
		expect.soft(defineState.payload).toEqual({ stable: true });
		expect.soft(Object.isExtensible(defined), "invalid input is rejected before sealing").toBe(true);
		expect.soft(defineTracked.hasChanges()).toBe(false);
	});

	it("rejects nested pre-expanded values atomically at tracked assignment boundaries", () => {
		const assignments = [
			{
				label: "set",
				apply: (target: { payload: object }, value: object): boolean => Reflect.set(target, "payload", value),
			},
			{
				label: "defineProperty",
				apply: (target: { payload: object }, value: object): boolean =>
					Reflect.defineProperty(target, "payload", {
						configurable: true,
						enumerable: true,
						value,
						writable: true,
					}),
			},
		] as const;

		for (const assignment of assignments) {
			const invalid = addExpando(new Uint8Array([1, 2]), "metadata", "nested-invalid", true);
			const wrapper = { nested: invalid };
			const original = { stable: true };
			const state = { payload: original };
			const tracked = trackMutations(state);

			const result = capture(() => assignment.apply(tracked.proxy, wrapper));
			expect.soft(result, `${assignment.label} rejects without throwing`).toEqual({ ok: true, value: false });
			expect.soft(state.payload, `${assignment.label} leaves the original state installed`).toBe(original);
			expect
				.soft(Object.isExtensible(invalid), `${assignment.label} rejects the invalid input before sealing`)
				.toBe(true);
			expect.soft(tracked.hasChanges(), `${assignment.label} does not dirty state`).toBe(false);
			expect.soft([...tracked.changedKeys()], `${assignment.label} charges no state key`).toEqual([]);
		}
	});

	it("seals a clean pre-derived shared view when governed discovery wraps it", () => {
		const backing = new ArrayBuffer(8);
		const source = new Uint8Array(backing);
		const derived = source.subarray(2, 6);
		const state = { payload: null as Uint8Array | null, untouched: { stable: true } };
		const tracked = trackMutations(state);

		tracked.proxy.payload = derived;
		const wrapped = tracked.proxy.payload;
		expect.soft(wrapped).not.toBeNull();
		if (wrapped === null) throw new Error("positive control: governed derived view missing");
		expect.soft(Object.isExtensible(derived), "new governed derived identity is sealed during discovery").toBe(false);
		expect.soft(Object.isExtensible(wrapped), "later wrapping preserves the validated invariant").toBe(false);
		expect.soft(derived.buffer, "sealing does not alter the raw shared-backing identity").toBe(backing);
		expect([...tracked.changedKeys()]).toEqual(["payload"]);
	});

	it("keeps wrapper metadata durable and attributes canonical numeric writes exactly", () => {
		const source = {
			payload: { bytes: new Uint8Array([1, 2, 3]), metadata: { label: "durable" } },
			untouched: { stable: true },
		};
		const copy = detachStatePayload(source);
		expect.soft(copy.payload.metadata).toEqual({ label: "durable" });
		expect.soft(copy.payload.metadata).not.toBe(source.payload.metadata);
		copy.payload.bytes.set([7, 8], 1);
		expect.soft([...copy.payload.bytes], "non-extensibility preserves native bulk element writes").toEqual([1, 7, 8]);

		const tracked = trackMutations(source);
		tracked.proxy.payload.metadata.label = "updated";
		tracked.proxy.payload.bytes[1] = 9;
		expect.soft([...source.payload.bytes]).toEqual([1, 9, 3]);
		expect.soft(source.payload.metadata.label).toBe("updated");
		expect([...tracked.changedKeys()]).toEqual(["payload"]);
	});

	it("fails closed for local authoring and the same real remote replay", async () => {
		const local = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local", "writer"] }),
			drp: new BinaryExpandoFixture(),
		});
		const localDRP = local.drp;
		if (localDRP === undefined) throw new Error("positive control: local DRP missing");
		const localResult = capture(() => localDRP.installInvalid(9));
		expect.soft(localResult.error).toBeInstanceOf(TypeError);
		expect.soft([...localDRP.payload]).toEqual([3, 5, 8]);
		expect.soft(local.vertices).toHaveLength(1);

		const remote = new DRPObject({
			peerId: "remote",
			acl: createACL({ admins: ["remote", "writer"] }),
			drp: new BinaryExpandoFixture(),
		});
		const remoteDRP = remote.drp;
		if (remoteDRP === undefined) throw new Error("positive control: remote DRP missing");
		const vertex = remoteVertex("installInvalid", [9]);
		await expect(remote.applyVertices([vertex])).resolves.toEqual({
			applied: false,
			invalid: [],
			missing: [],
			quarantined: [vertex.hash],
		});
		expect.soft([...remoteDRP.payload]).toEqual([3, 5, 8]);
		expect(remote.vertices.some(({ hash }) => hash === vertex.hash)).toBe(false);
	});
});
