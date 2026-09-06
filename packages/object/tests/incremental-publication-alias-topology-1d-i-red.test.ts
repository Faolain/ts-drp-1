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
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
		});
	}
}

class AliasTopologyFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: "excluded" };
	ballast = { bytes: "x".repeat(64 * 1024) };
	a = { value: 0 };
	b = { value: 0 };

	aliasThenMutate(value: number): void {
		this.b = this.a;
		this.a.value = value;
	}

	replaceThenMutateDetached(value: number): void {
		const detached = this.b;
		this.b = this.a;
		detached.value = value;
	}
}

interface Harness {
	rawDRP: AliasTopologyFixture;
	applier: DRPVertexApplier<AliasTopologyFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<AliasTopologyFixture>;
}

function harness(peerId: "local" | "remote"): Harness {
	const rawDRP = new AliasTopologyFixture();
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
	) => DRPVertexApplier<AliasTopologyFixture>;
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

function expectTrackedKeys(tracked: { changedKeys(): ReadonlySet<string> }, before: DRPState, value: object): void {
	expect([...tracked.changedKeys()].sort()).toEqual(canonicalDelta(before, canonicalState(value)).keys);
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit`).toBeDefined();
	return vertex!;
}

function assertAliasPublication(h: Harness, vertex: Vertex, before: DRPState): void {
	const expected = canonicalState(h.rawDRP);
	const delta = canonicalDelta(before, expected);
	expect(delta.keys).toEqual(["a", "b"]);
	const publication = h.probe.publications.find(
		(candidate) =>
			candidate.kind === "vertex" && candidate.targetHash === vertex.hash && candidate.outcome === "published"
	);
	expect(publication).toMatchObject({ mode: "incremental", changed: { acl: [], drp: delta.keys } });

	const stored = h.states.getDRPState(vertex.hash)!;
	expect(encodedState(stored)).toEqual(encodedState(expected));
	const [reconstructed] = h.states.fromHash(vertex.hash);
	expect(encodedState(canonicalState(reconstructed!))).toEqual(encodedState(expected));

	const copies = h.probe.copies.filter(({ publicationId }) => publicationId === publication?.publicationId);
	expect(copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort()).toEqual(["drp:a:post", "drp:b:post"]);
	expect(copies.some(({ key }) => key === "ballast")).toBe(false);
	expect(copies.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThan(20 * delta.mutatedBytes);
}

describe("Phase 1d(i) alias-topology mutation attribution", () => {
	it("keeps the existing shared-owner and equal-replacement no-op controls", () => {
		const shared = { value: 0 };
		const initiallyShared = { a: shared, b: shared, untouched: { value: 0 } };
		const sharedBefore = canonicalState(initiallyShared);
		const sharedTracked = trackMutations(initiallyShared);
		sharedTracked.proxy.a.value = 1;
		expectTrackedKeys(sharedTracked, sharedBefore, initiallyShared);
		expect([...sharedTracked.changedKeys()].sort()).toEqual(["a", "b"]);

		const equalReplacement = { a: { value: 0 }, b: { value: 0 }, untouched: { value: 0 } };
		const replacementBefore = canonicalState(equalReplacement);
		const replacementTracked = trackMutations(equalReplacement);
		replacementTracked.proxy.b = replacementTracked.proxy.a;
		expect(equalReplacement.a).toBe(equalReplacement.b);
		expectTrackedKeys(replacementTracked, replacementBefore, equalReplacement);
		expect([...replacementTracked.changedKeys()]).toEqual([]);
	});

	it("registers a semantic- and byte-equal top-level alias before its later mutation", () => {
		const state = { a: { value: 0 }, b: { value: 0 }, untouched: { value: 0 } };
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldNew = tracked.proxy.a;

		tracked.proxy.b = heldNew;
		heldNew.value = 1;

		expect(state.a).toBe(state.b);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["a", "b"]);
	});

	it("registers newly assigned aliases through ordinary nested object and Array writes", () => {
		const state = {
			source: { value: 0 },
			object: { child: { value: 0 } },
			array: [{ value: 0 }],
			untouched: { value: 0 },
		};
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldNew = tracked.proxy.source;

		tracked.proxy.object.child = heldNew;
		tracked.proxy.array[0] = heldNew;
		heldNew.value = 1;

		expect(state.object.child).toBe(state.source);
		expect(state.array[0]).toBe(state.source);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["array", "object", "source"]);
	});

	it("registers a deep-equal Map.set replacement while preserving exact key attribution", () => {
		const state = {
			source: { value: 0 },
			map: new Map([["slot", { value: 0 }]]),
			untouched: { value: 0 },
		};
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldNew = tracked.proxy.source;

		tracked.proxy.map.set("slot", heldNew);
		heldNew.value = 1;

		expect(state.map.get("slot")).toBe(state.source);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["map", "source"]);
	});

	it("registers an alias assigned through a Set entry reached by the ordinary iteration API", () => {
		const state = {
			source: { value: 0 },
			set: new Set([{ child: { value: 0 } }]),
			untouched: { value: 0 },
		};
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldNew = tracked.proxy.source;

		for (const entry of tracked.proxy.set.values()) entry.child = heldNew;
		heldNew.value = 1;

		expect([...state.set][0].child).toBe(state.source);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["set", "source"]);
	});

	it("removes stale ownership from a held proxy after an equal replacement", () => {
		const state = { a: { value: 0 }, b: { value: 0 }, untouched: { value: 0 } };
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldOld = tracked.proxy.b;
		const heldNew = tracked.proxy.a;

		tracked.proxy.b = heldNew;
		heldOld.value = 9;

		expect(state.a.value).toBe(0);
		expect(state.b.value).toBe(0);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()]).toEqual([]);

		heldNew.value = 1;
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["a", "b"]);
	});

	it("updates alias ownership through an enumerable accessor", () => {
		const source = { value: 0 };
		let slot = { value: 0 };
		const container = {} as { slot: { value: number } };
		Object.defineProperty(container, "slot", {
			enumerable: true,
			configurable: true,
			get: () => slot,
			set: (value: { value: number }) => {
				slot = value;
			},
		});
		const state = { source, container, untouched: { value: 0 } };
		const before = canonicalState(state);
		const tracked = trackMutations(state);
		const heldNew = tracked.proxy.source;

		tracked.proxy.container.slot = heldNew;
		heldNew.value = 1;

		expect(state.container.slot).toBe(state.source);
		expectTrackedKeys(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["container", "source"]);
	});

	it("handles cyclic equal graphs without losing their current owners", () => {
		interface CyclicValue {
			value: number;
			self: CyclicValue;
		}
		const a = { value: 0 } as CyclicValue;
		a.self = a;
		const b = { value: 0 } as CyclicValue;
		b.self = b;
		const state = { a, b, untouched: { value: 0 } };
		const tracked = trackMutations(state);

		expect(() => {
			tracked.proxy.b = tracked.proxy.a;
			tracked.proxy.a.value = 1;
		}).not.toThrow();
		expect(state.a).toBe(state.b);
		expect(state.a.self).toBe(state.a);
		expect([...tracked.changedKeys()].sort()).toEqual(["a", "b"]);
	});
});

describe("Phase 1d(i) alias-topology publication boundaries", () => {
	it("does not publish canonical no-op work through a stale detached owner", () => {
		const h = harness("local");

		h.applier.drp!.replaceThenMutateDetached(9);

		expect({
			vertices: h.hashGraph.getAllVertices().length,
			publications: h.probe.publications.length,
			copies: h.probe.copies.length,
		}).toEqual({ vertices: 1, publications: 0, copies: 0 });
		expect(h.rawDRP.a).not.toBe(h.rawDRP.b);
		expect(h.rawDRP).toMatchObject({ a: { value: 0 }, b: { value: 0 } });
	});

	it("publishes and reconstructs both current owners on single-head local authoring", () => {
		const h = harness("local");
		const before = h.states.getDRPState(HashGraph.rootHash)!;

		h.applier.drp!.aliasThenMutate(1);

		expect(h.rawDRP.a).toBe(h.rawDRP.b);
		assertAliasPublication(h, vertexFor(h, "aliasThenMutate"), before);
	});

	it("publishes and reconstructs both current owners on exact-cut linear remote replay", async () => {
		const sender = harness("local");
		sender.applier.drp!.aliasThenMutate(1);
		const vertex = vertexFor(sender, "aliasThenMutate");
		const receiver = harness("remote");
		const before = receiver.states.getDRPState(HashGraph.rootHash)!;

		await expect(receiver.applier.applyVertices(trustedTestVertices([vertex]))).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(receiver.rawDRP.a).toBe(receiver.rawDRP.b);
		assertAliasPublication(receiver, vertex, before);
	});
});
