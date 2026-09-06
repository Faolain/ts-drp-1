/* eslint-disable import/order -- auth mock must register before object imports */
import { trustedTestVertices } from "./helpers/trusted-vertex-ingest.js";

/* eslint-disable @typescript-eslint/no-non-null-assertion -- committed vertices and snapshots are narrowed by positive controls */
import { type DRPState, DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { deepEqual } from "fast-equals";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

type SnapshotSide = "acl" | "drp";

interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	baselineHashes: readonly Hash[];
	changed: Readonly<Record<SnapshotSide, readonly string[]>>;
}

interface CopyObservation {
	publicationId: string;
	side: SnapshotSide;
	key: string;
	image: "pre" | "post";
	bytes: number;
}

type PublicationObserverEvent =
	| { type: "copy"; value: unknown; metadata: Omit<CopyObservation, "bytes"> }
	| { type: "publication"; record: PublicationRecord };

class PublicationProbe {
	readonly copies: CopyObservation[] = [];
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") {
			this.copies.push({ ...event.metadata, bytes: serializeValue(event.value).byteLength });
			return cloneDeep(event.value);
		}
		this.publications.push({
			...event.record,
			baselineHashes: [...event.record.baselineHashes],
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
		});
	}
}

class ContextAliasFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context: { caller: string; localOnly: { value: number }; link?: { value: number } } = {
		caller: "",
		localOnly: { value: 0 },
	};
	ballast = { bytes: "x".repeat(64 * 1024) };
	a = { value: 0 };
	b = { value: 0 };

	mutatePrivateContext(value: number): void {
		this.context.localOnly.value = value;
	}

	aliasThroughContext(value: number): void {
		this.context.link = this.a;
		this.context.link.value = value;
	}

	aliasThroughContextAndMutateB(aValue: number, bValue: number): void {
		this.context.link = this.a;
		this.context.link.value = aValue;
		this.b.value = bValue;
	}
}

interface Harness {
	rawDRP: ContextAliasFixture;
	applier: DRPVertexApplier<ContextAliasFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<ContextAliasFixture>;
}

function harness(peerId: "local" | "remote"): Harness {
	const rawDRP = new ContextAliasFixture();
	const rawACL = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph(peerId, rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
	const states = new DRPObjectStateManager(rawACL, rawDRP);
	const probe = new PublicationProbe();
	const options = {
		drp: rawDRP,
		acl: rawACL,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<ContextAliasFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function canonicalState(value: object): DRPState {
	return stateFromDRP(value as IDRP);
}

function encodedState(state: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

function equalBytes(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function byKey(state: DRPState): Map<string, unknown> {
	return new Map(state.state.map(({ key, value }) => [key, value]));
}

function canonicalDelta(before: DRPState, after: DRPState): { keys: string[]; mutatedBytes: number } {
	const beforeByKey = byKey(before);
	const afterByKey = byKey(after);
	const keys: string[] = [];
	let mutatedBytes = 0;
	for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
		const beforePresent = beforeByKey.has(key);
		const afterPresent = afterByKey.has(key);
		const beforeValue = beforeByKey.get(key);
		const afterValue = afterByKey.get(key);
		if (beforePresent === afterPresent && deepEqual(beforeValue, afterValue) && equalBytes(beforeValue, afterValue)) {
			continue;
		}
		keys.push(key);
		mutatedBytes += Math.max(
			beforePresent ? serializeValue(beforeValue).byteLength : 0,
			afterPresent ? serializeValue(afterValue).byteLength : 0
		);
	}
	return { keys: keys.sort(), mutatedBytes };
}

function frozenTopLevelBytes(value: object): Map<string, Uint8Array> {
	const frozen = new Map<string, Uint8Array>();
	for (const [key, entryValue] of Object.entries(value)) {
		if (key === "context" || typeof entryValue === "function") continue;
		frozen.set(key, Uint8Array.from(serializeValue(entryValue)));
	}
	return frozen;
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = frozenTopLevelBytes(value);
	const changed: string[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const beforeBytes = before.get(key);
		const afterBytes = after.get(key);
		if (
			beforeBytes !== undefined &&
			afterBytes !== undefined &&
			beforeBytes.byteLength === afterBytes.byteLength &&
			beforeBytes.every((byte, index) => byte === afterBytes[index])
		) {
			continue;
		}
		changed.push(key);
	}
	return changed.sort();
}

function expectMutation<T extends object>(state: T, mutate: (proxy: T) => void, expectedKeys: string[]): void {
	const before = frozenTopLevelBytes(state);
	const tracked = trackMutations(state);
	mutate(tracked.proxy);
	const groundTruthKeys = byteDeltaKeys(before, state);
	expect(groundTruthKeys).toEqual(expectedKeys);
	expect([...tracked.changedKeys()].sort()).toEqual(groundTruthKeys);
	expect(tracked.hasChanges()).toBe(expectedKeys.length > 0);
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must author a vertex`).toBeDefined();
	return vertex!;
}

function assertExactPublication(h: Harness, vertex: Vertex, before: DRPState, expectedKeys: string[]): void {
	const expected = canonicalState(h.rawDRP);
	const delta = canonicalDelta(before, expected);
	expect(delta.keys).toEqual(expectedKeys);

	const publication = h.probe.publications.find(
		(candidate) =>
			candidate.kind === "vertex" && candidate.targetHash === vertex.hash && candidate.outcome === "published"
	);
	expect(publication).toMatchObject({
		mode: "incremental",
		baselineHashes: [HashGraph.rootHash],
		changed: { acl: [], drp: expectedKeys },
	});
	expect(publication?.changed.drp).not.toContain("context");

	const stored = h.states.getDRPState(vertex.hash)!;
	expect(encodedState(stored), "stored bytes must equal the post-operation canonical state").toEqual(
		encodedState(expected)
	);
	const [reconstructed] = h.states.fromHash(vertex.hash);
	expect(encodedState(canonicalState(reconstructed!)), "fromHash must reconstruct the post-operation state").toEqual(
		encodedState(expected)
	);

	const copies = h.probe.copies.filter(({ publicationId }) => publicationId === publication?.publicationId);
	expect(copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort()).toEqual(
		expectedKeys.map((key) => `drp:${key}:post`).sort()
	);
	expect(copies.some(({ key }) => key === "ballast" || key === "context")).toBe(false);
	expect(copies.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThan(20 * delta.mutatedBytes);
}

interface MechanismCase {
	name: string;
	run(): void;
}

const contextPathMechanisms: MechanismCase[] = [
	{
		name: "nested object, context-first",
		run: (): void => {
			const shared = { value: 0 };
			const state = { context: { link: shared }, a: { child: shared }, untouched: { value: 0 } };
			expectMutation(
				state,
				(proxy) => {
					void proxy.context.link;
					void proxy.a.child;
					proxy.context.link.value = 1;
				},
				["a"]
			);
			expect(state.context.link).toBe(state.a.child);
		},
	},
	{
		name: "nested object, governed-first",
		run: (): void => {
			const shared = { value: 0 };
			const state = { context: { link: shared }, a: { child: shared }, untouched: { value: 0 } };
			expectMutation(
				state,
				(proxy) => {
					void proxy.a.child;
					void proxy.context.link;
					proxy.context.link.value = 1;
				},
				["a"]
			);
		},
	},
	{
		name: "Array element",
		run: (): void => {
			const shared = { value: 0 };
			const state = { context: { link: [shared] }, array: [shared], untouched: { value: 0 } };
			expectMutation(state, (proxy) => (proxy.context.link[0].value = 1), ["array"]);
		},
	},
	{
		name: "Map key",
		run: (): void => {
			const key = { id: 0 };
			const map = new Map([[key, "value"]]);
			const state = { context: { link: key }, map, untouched: { value: 0 } };
			expectMutation(state, (proxy) => (proxy.context.link.id = 1), ["map"]);
		},
	},
	{
		name: "Map value",
		run: (): void => {
			const value = { value: 0 };
			const map = new Map([["key", value]]);
			const state = { context: { link: value }, map, untouched: { value: 0 } };
			expectMutation(state, (proxy) => (proxy.context.link.value = 1), ["map"]);
		},
	},
	{
		name: "Map.set",
		run: (): void => {
			const map = new Map<string, { value: number }>();
			const state = { context: { link: map }, map, untouched: { value: 0 } };
			expectMutation(state, (proxy) => void proxy.context.link.set("key", { value: 1 }), ["map"]);
		},
	},
	{
		name: "Map.delete",
		run: (): void => {
			const map = new Map([["key", { value: 0 }]]);
			const state = { context: { link: map }, map, untouched: { value: 0 } };
			expectMutation(state, (proxy) => void proxy.context.link.delete("key"), ["map"]);
		},
	},
	{
		name: "Map.clear",
		run: (): void => {
			const map = new Map([["key", { value: 0 }]]);
			const state = { context: { link: map }, map, untouched: { value: 0 } };
			expectMutation(state, (proxy) => proxy.context.link.clear(), ["map"]);
		},
	},
	{
		name: "Set entry",
		run: (): void => {
			const entry = { value: 0 };
			const set = new Set([entry]);
			const state = { context: { link: entry }, set, untouched: { value: 0 } };
			expectMutation(state, (proxy) => (proxy.context.link.value = 1), ["set"]);
		},
	},
	{
		name: "Set.add",
		run: (): void => {
			const set = new Set<{ value: number }>();
			const state = { context: { link: set }, set, untouched: { value: 0 } };
			expectMutation(state, (proxy) => void proxy.context.link.add({ value: 1 }), ["set"]);
		},
	},
	{
		name: "Set.delete",
		run: (): void => {
			const entry = { value: 0 };
			const set = new Set([entry]);
			const state = { context: { link: set }, set, untouched: { value: 0 } };
			expectMutation(state, (proxy) => void proxy.context.link.delete(entry), ["set"]);
		},
	},
	{
		name: "Date setter",
		run: (): void => {
			const date = new Date("2025-01-01T00:00:00.000Z");
			const state = { context: { link: date }, date, untouched: { value: 0 } };
			expectMutation(state, (proxy) => void proxy.context.link.setUTCFullYear(2026), ["date"]);
		},
	},
	{
		name: "cycle",
		run: (): void => {
			interface Cyclic {
				value: number;
				self: Cyclic;
			}
			const cyclic = { value: 0 } as Cyclic;
			cyclic.self = cyclic;
			const state = { context: { link: cyclic }, cyclic, untouched: { value: 0 } };
			const tracked = trackMutations(state);
			tracked.proxy.context.link.value = 1;
			expect([...tracked.changedKeys()]).toEqual(["cyclic"]);
			expect(tracked.hasChanges()).toBe(true);
			expect(state.cyclic.self).toBe(state.cyclic);
		},
	},
	{
		name: "multiple governed owners",
		run: (): void => {
			const shared = { value: 0 };
			const state = { context: { link: shared }, a: shared, b: shared, untouched: { value: 0 } };
			expectMutation(state, (proxy) => (proxy.context.link.value = 1), ["a", "b"]);
			expect(state.a).toBe(state.b);
			expect(state.context.link).toBe(state.a);
		},
	},
];

describe("Phase 1d(i) context aliases charge current governed owners", () => {
	it.each(contextPathMechanisms)("$name", ({ run }) => run());

	it("keeps pure replica-local writes silent across supported mutable values", () => {
		const cyclic = { value: 0 } as { value: number; self: unknown };
		cyclic.self = cyclic;
		const state = {
			context: {
				nested: { value: 0 },
				array: [{ value: 0 }],
				map: new Map([["key", { value: 0 }]]),
				set: new Set([{ value: 0 }]),
				date: new Date("2025-01-01T00:00:00.000Z"),
				cyclic,
			},
			governed: { value: 0 },
		};
		const tracked = trackMutations(state);
		tracked.proxy.context.nested.value = 1;
		tracked.proxy.context.array.push({ value: 1 });
		tracked.proxy.context.map.set("added", { value: 1 });
		tracked.proxy.context.set.add({ value: 1 });
		tracked.proxy.context.date.setUTCFullYear(2026);
		tracked.proxy.context.cyclic.value = 1;

		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
	});

	it("keeps a held context alias silent after every governed owner detaches", () => {
		const shared = { value: 0 };
		const state = { context: { link: shared }, a: shared, b: shared };
		const tracked = trackMutations(state);
		const held = tracked.proxy.context.link;

		tracked.proxy.a = { value: 0 };
		tracked.proxy.b = { value: 0 };
		held.value = 9;

		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
		expect(state.context.link.value).toBe(9);
		expect(state.a.value).toBe(0);
		expect(state.b.value).toBe(0);
	});

	it("never adds context after a context read followed by a governed mutation", () => {
		const shared = { value: 0 };
		const state = { context: { link: shared }, governed: shared };
		const tracked = trackMutations(state);

		void tracked.proxy.context.link;
		tracked.proxy.governed.value = 1;

		expect([...tracked.changedKeys()]).toEqual(["governed"]);
		expect(tracked.hasChanges()).toBe(true);
	});

	it("does not let a context read pollute a later detached governed proxy", () => {
		const shared = { value: 0 };
		const state = { context: { link: shared }, governed: shared };
		const tracked = trackMutations(state);

		void tracked.proxy.context.link;
		const heldGoverned = tracked.proxy.governed;
		tracked.proxy.governed = { value: 0 };
		heldGoverned.value = 9;

		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
	});
});

describe("Phase 1d(i) context-alias tracking work", () => {
	it("bounds deterministic owner-graph visits for repeated Array, Map, and Set structural writes", () => {
		let visits = 0;
		const countedNode = (value: number): { readonly value: number } => {
			const node = {} as { readonly value: number };
			Object.defineProperty(node, "value", {
				enumerable: true,
				configurable: true,
				get: () => {
					visits++;
					return value;
				},
			});
			return node;
		};
		const state = {
			context: { localOnly: true },
			array: [] as { readonly value: number }[],
			map: new Map<number, { readonly value: number }>(),
			set: new Set<{ readonly value: number }>(),
			untouched: { value: 0 },
		};
		const tracked = trackMutations(state);
		visits = 0;
		const structuralWritesPerCollection = 128;
		const startedAt = performance.now();
		for (let index = 0; index < structuralWritesPerCollection; index++) {
			tracked.proxy.array.push(countedNode(index));
			tracked.proxy.map.set(index, countedNode(index));
			tracked.proxy.set.add(countedNode(index));
		}
		const elapsedMs = performance.now() - startedAt;
		const structuralWrites = 3 * structuralWritesPerCollection;
		const finalStateNodes = 3 * structuralWritesPerCollection + 5;
		const bound = 20 * (structuralWrites + finalStateNodes);

		expect([...tracked.changedKeys()].sort()).toEqual(["array", "map", "set"]);
		expect(
			visits,
			`graph visits must be linear-ish: visits=${visits}, bound=${bound}, diagnostic elapsedMs=${elapsedMs.toFixed(1)}`
		).toBeLessThan(bound);
	});
});

describe("Phase 1d(i) context-alias publication boundaries", () => {
	it("does not author or publish pure replica-local context work", () => {
		const h = harness("local");
		const root = h.states.getDRPState(HashGraph.rootHash)!;
		const rootBytes = encodedState(root);

		h.applier.drp!.mutatePrivateContext(7);

		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.probe.publications).toEqual([]);
		expect(h.probe.copies).toEqual([]);
		expect(encodedState(h.states.getDRPState(HashGraph.rootHash)!)).toEqual(rootBytes);
		expect(root.state.map(({ key }) => key)).not.toContain("context");
	});

	it("authors a vertex when the only governed effect is reached through context", () => {
		const h = harness("local");
		const before = h.states.getDRPState(HashGraph.rootHash)!;

		h.applier.drp!.aliasThroughContext(9);

		const vertex = vertexFor(h, "aliasThroughContext");
		expect(h.rawDRP.a.value).toBe(9);
		assertExactPublication(h, vertex, before, ["a"]);
	});

	it("publishes exact local bytes when a mid-operation context alias joins another governed write", () => {
		const h = harness("local");
		const before = h.states.getDRPState(HashGraph.rootHash)!;

		h.applier.drp!.aliasThroughContextAndMutateB(7, 2);

		const vertex = vertexFor(h, "aliasThroughContextAndMutateB");
		expect(h.rawDRP).toMatchObject({ a: { value: 7 }, b: { value: 2 } });
		assertExactPublication(h, vertex, before, ["a", "b"]);
	});

	it("publishes exact linear-remote bytes without a stored-versus-full-replay split", async () => {
		const sender = harness("local");
		sender.applier.drp!.aliasThroughContextAndMutateB(7, 2);
		const vertex = vertexFor(sender, "aliasThroughContextAndMutateB");
		const receiver = harness("remote");
		const before = receiver.states.getDRPState(HashGraph.rootHash)!;

		await expect(receiver.applier.applyVertices(trustedTestVertices([vertex]))).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(receiver.rawDRP).toMatchObject({ a: { value: 7 }, b: { value: 2 } });
		expect(
			encodedState(receiver.states.getDRPState(vertex.hash)!),
			"the exact stored cut must match full replay before reconstruction or fetch/checkpoint seeding"
		).toEqual(encodedState(canonicalState(receiver.rawDRP)));
		assertExactPublication(receiver, vertex, before, ["a", "b"]);
	});
});
