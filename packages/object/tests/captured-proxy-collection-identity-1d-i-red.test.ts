/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices and entries */
import { DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { type MutationTrackingResult, trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface Child {
	id: string;
	value: number;
}

interface Box {
	inner: Child;
}

class CapturingMap extends Map<unknown, unknown> {
	pending?: Child;

	putPending(value: unknown): void {
		Map.prototype.set.call(this, this.pending, value);
	}

	putBox(box: Box, value: unknown): void {
		Map.prototype.set.call(this, box.inner, value);
	}

	putValue(key: unknown, box: Box): void {
		Map.prototype.set.call(this, key, box.inner);
	}

	putThenThrow(box: Box, value: unknown, failure: unknown): never {
		Map.prototype.set.call(this, box.inner, value);
		throw failure;
	}

	returnThis(): this {
		return this;
	}
}

class CapturingSet extends Set<unknown> {
	pending?: Child;

	clearThenAddPending(): void {
		Set.prototype.clear.call(this);
		Set.prototype.add.call(this, this.pending);
	}

	addBox(box: Box): void {
		Set.prototype.add.call(this, box.inner);
	}

	addThenThrow(box: Box, failure: unknown): never {
		Set.prototype.add.call(this, box.inner);
		throw failure;
	}

	returnThis(): this {
		return this;
	}
}

type MapWithClosure = CapturingMap & { putCaptured(value: unknown): void };
type SetWithClosure = CapturingSet & { addCaptured(): void };

function installCapturedMapMethod(map: CapturingMap, captured: Child): MapWithClosure {
	const surface = map as MapWithClosure;
	Object.defineProperty(surface, "putCaptured", {
		configurable: true,
		value(this: CapturingMap, value: unknown): void {
			Map.prototype.set.call(this, captured, value);
		},
	});
	return surface;
}

function installCapturedSetMethod(set: CapturingSet, captured: Child): SetWithClosure {
	const surface = set as SetWithClosure;
	Object.defineProperty(surface, "addCaptured", {
		configurable: true,
		value(this: CapturingSet): void {
			Set.prototype.add.call(this, captured);
		},
	});
	return surface;
}

function bytesByKey(value: object): Map<string, Uint8Array> {
	return new Map(
		stateFromDRP(value as IDRP).state.map(({ key, value: entry }) => [key, Uint8Array.from(serializeValue(entry))])
	);
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = bytesByKey(value);
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((key) => {
			const left = before.get(key);
			const right = after.get(key);
			return (
				left === undefined ||
				right === undefined ||
				left.byteLength !== right.byteLength ||
				left.some((byte, index) => byte !== right[index])
			);
		})
		.sort();
}

function expectExactAttribution<T extends object>(
	tracked: MutationTrackingResult<T>,
	before: ReadonlyMap<string, Uint8Array>,
	state: T
): void {
	expect([...tracked.changedKeys()].sort()).toEqual(byteDeltaKeys(before, state));
}

function caughtIdentity(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("Phase 1d(i) captured-proxy Map canonical identity", () => {
	it("collapses a closure-captured key into the existing raw key with deterministic last-write value", () => {
		const rawKey: Child = { id: "key", value: 0 };
		const state = { map: new CapturingMap([[rawKey, "before"]]), alias: rawKey, untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.map.keys()][0] as Child;
		const surface = installCapturedMapMethod(state.map, captured);

		(tracked.proxy.map as MapWithClosure).putCaptured("after");

		expect(captured).not.toBe(rawKey);
		expect(state.map.size).toBe(1);
		expect([...state.map.keys()]).toEqual([rawKey]);
		expect([...state.map.keys()][0]).toBe(rawKey);
		expect(state.map.get(rawKey)).toBe("after");
		expect(tracked.proxy.map.has(rawKey)).toBe(true);
		expect(tracked.proxy.map.has(captured)).toBe(true);
		expect(tracked.proxy.map.get(rawKey)).toBe("after");
		expect(tracked.proxy.map.get(captured)).toBe("after");
		delete (surface as Partial<MapWithClosure>).putCaptured;
	});

	it("normalizes a key captured through a collection own data property without a closure", () => {
		const rawKey: Child = { id: "key", value: 0 };
		const state = { map: new CapturingMap([[rawKey, 1]]) };
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.map.entries()][0]![0] as Child;

		tracked.proxy.map.pending = captured;
		tracked.proxy.map.putPending(2);

		expect([...state.map.entries()]).toEqual([[rawKey, 2]]);
		expect([...state.map.keys()][0]).toBe(rawKey);
	});

	it("normalizes captured proxies nested below unknown-method arguments in keys and values", () => {
		const rawKey: Child = { id: "key", value: 0 };
		const rawValue: Child = { id: "value", value: 0 };
		const state = { map: new CapturingMap([[rawKey, rawValue]]) };
		const tracked = trackMutations(state);
		const [capturedKey, capturedValue] = [...tracked.proxy.map.entries()][0]! as [Child, Child];

		tracked.proxy.map.putBox({ inner: capturedKey }, "replacement");
		tracked.proxy.map.putValue("value-slot", { inner: capturedValue });

		expect([...state.map.keys()]).toEqual([rawKey, "value-slot"]);
		expect([...state.map.keys()][0]).toBe(rawKey);
		expect(state.map.get(rawKey)).toBe("replacement");
		expect(state.map.get("value-slot")).toBe(rawValue);
		expect(tracked.proxy.map.get("value-slot")).toBe(capturedValue);
	});

	it("deletes a normalized captured key through either governed identity without an orphan", () => {
		for (const deleteWithCaptured of [false, true]) {
			const rawKey: Child = { id: "key", value: 0 };
			const state = { map: new CapturingMap([[rawKey, 1]]) };
			const tracked = trackMutations(state);
			const captured = [...tracked.proxy.map.keys()][0] as Child;
			installCapturedMapMethod(state.map, captured);
			(tracked.proxy.map as MapWithClosure).putCaptured(2);

			expect(tracked.proxy.map.delete(deleteWithCaptured ? captured : rawKey)).toBe(true);
			expect(state.map.size).toBe(0);
			expect(tracked.proxy.map.has(rawKey)).toBe(false);
			expect(tracked.proxy.map.has(captured)).toBe(false);
			expect(tracked.proxy.map.delete(captured)).toBe(false);
		}
	});

	it("preserves exact throw identity while canonicalizing and charging a surviving insertion", () => {
		const rawKey: Child = { id: "key", value: 0 };
		const state = { map: new CapturingMap([[rawKey, 1]]), untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.map.keys()][0] as Child;
		const failure = Object.freeze({ code: "MAP_INSERTED_THEN_THROWN" });

		const caught = caughtIdentity(() => tracked.proxy.map.putThenThrow({ inner: captured }, 2, failure));

		expect(caught).toBe(failure);
		expect([...state.map.entries()]).toEqual([[rawKey, 2]]);
		expect([...state.map.keys()][0]).toBe(rawKey);
		expect([...tracked.changedKeys()]).toEqual(["map"]);
		expect(tracked.changedKeys().has("untouched")).toBe(false);
	});

	it("reconciles collapsed key refcounts so delete fully detaches the Map owner", () => {
		const rawKey: Child = { id: "key", value: 0 };
		const state = {
			map: new CapturingMap([[rawKey, 1]]),
			fresh: new CapturingMap(),
			alias: rawKey,
			untouched: { value: 0 },
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.map.keys()][0] as Child;
		const surface = installCapturedMapMethod(state.map, captured);
		(tracked.proxy.map as MapWithClosure).putCaptured(2);
		delete (surface as Partial<MapWithClosure>).putCaptured;
		expect(tracked.proxy.map.delete(rawKey)).toBe(true);
		expect(state.map.size).toBe(0);
		tracked.proxy.fresh = state.map;
		expect(tracked.changedKeys().has("fresh")).toBe(false);

		captured.value = 1;

		expectExactAttribution(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["alias", "map"]);
		expect(byteDeltaKeys(before, state)).toEqual(["alias", "map"]);
	});
});

describe("Phase 1d(i) captured-proxy Set canonical identity", () => {
	it("clear-then-add of an iterated proxy stores the raw value and stays governed-addressable", () => {
		const rawValue: Child = { id: "value", value: 0 };
		const state = { set: new CapturingSet([rawValue]), alias: rawValue };
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.set.values()][0] as Child;

		tracked.proxy.set.pending = captured;
		tracked.proxy.set.clearThenAddPending();

		expect([...state.set]).toEqual([rawValue]);
		expect([...state.set][0]).toBe(rawValue);
		expect(tracked.proxy.set.has(rawValue)).toBe(true);
		expect(tracked.proxy.set.has(captured)).toBe(true);
		expect(tracked.proxy.set.delete(captured)).toBe(true);
		expect(state.set.size).toBe(0);
	});

	it("normalizes closure and nested-argument insertions without raw/proxy duplicates", () => {
		const rawValue: Child = { id: "value", value: 0 };
		const state = { set: new CapturingSet([rawValue]) };
		const tracked = trackMutations(state);
		const [capturedFromEntry] = [...tracked.proxy.set.entries()][0]! as [Child, Child];
		const surface = installCapturedSetMethod(state.set, capturedFromEntry);

		(tracked.proxy.set as SetWithClosure).addCaptured();
		tracked.proxy.set.addBox({ inner: capturedFromEntry });

		expect(state.set.size).toBe(1);
		expect([...state.set]).toEqual([rawValue]);
		expect([...state.set][0]).toBe(rawValue);
		delete (surface as Partial<SetWithClosure>).addCaptured;
	});

	it("preserves exact throw identity while canonicalizing and charging a surviving addition", () => {
		const rawValue: Child = { id: "value", value: 0 };
		const state = { set: new CapturingSet([rawValue]), untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.set][0] as Child;
		tracked.proxy.set.clear();
		const failure = new Error("set inserted then threw");

		const caught = caughtIdentity(() => tracked.proxy.set.addThenThrow({ inner: captured }, failure));

		expect(caught).toBe(failure);
		expect([...state.set]).toEqual([rawValue]);
		expect([...state.set][0]).toBe(rawValue);
		expect([...tracked.changedKeys()]).toEqual(["set"]);
		expect(tracked.changedKeys().has("untouched")).toBe(false);
	});

	it("fully detaches a normalized entry so later child mutation charges only byte owners", () => {
		const rawValue: Child = { id: "value", value: 0 };
		const state = {
			set: new CapturingSet([rawValue]),
			fresh: new CapturingSet(),
			alias: rawValue,
			untouched: { value: 0 },
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const captured = [...tracked.proxy.set][0] as Child;
		tracked.proxy.set.pending = captured;
		tracked.proxy.set.clearThenAddPending();
		delete state.set.pending;
		expect(tracked.proxy.set.delete(rawValue)).toBe(true);
		expect(state.set.size).toBe(0);
		tracked.proxy.fresh = state.set;
		expect(tracked.changedKeys().has("fresh")).toBe(false);

		captured.value = 1;

		expectExactAttribution(tracked, before, state);
		expect([...tracked.changedKeys()].sort()).toEqual(["alias", "set"]);
		expect(byteDeltaKeys(before, state)).toEqual(["alias", "set"]);
	});
});

describe("Phase 1d(i) governed collection controls", () => {
	it("keeps normal set/add canonical, chainable, and silent on primitive no-ops", () => {
		const raw: Child = { id: "value", value: 0 };
		const state = { map: new CapturingMap(), set: new CapturingSet(), alias: raw };
		const tracked = trackMutations(state);
		const captured = tracked.proxy.alias;

		expect(tracked.proxy.map.set(captured, captured)).toBe(tracked.proxy.map);
		expect(tracked.proxy.set.add(captured)).toBe(tracked.proxy.set);
		expect([...state.map.entries()]).toEqual([[raw, raw]]);
		expect([...state.set]).toEqual([raw]);
		const changedAfterInsert = [...tracked.changedKeys()].sort();

		tracked.proxy.map.set(captured, captured);
		tracked.proxy.set.add(captured);
		tracked.proxy.map.set("primitive", 1);
		tracked.proxy.map.set("primitive", 1);
		tracked.proxy.set.add(1);
		tracked.proxy.set.add(1);

		expect([...tracked.changedKeys()].sort()).toEqual([...new Set([...changedAfterInsert, "map", "set"])]);
	});

	it("keeps unknown methods returning the raw receiver chainable as the governed proxy", () => {
		const state = { map: new CapturingMap(), set: new CapturingSet() };
		const tracked = trackMutations(state);

		expect(tracked.proxy.map.returnThis()).toBe(tracked.proxy.map);
		expect(tracked.proxy.set.returnThis()).toBe(tracked.proxy.set);
	});
});

type SnapshotSide = "acl" | "drp";

interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	changed: Readonly<Record<SnapshotSide, readonly string[]>>;
}

type PublicationObserverEvent =
	| { type: "copy"; value: unknown; metadata: unknown }
	| { type: "publication"; record: PublicationRecord };

class PublicationProbe {
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") return cloneDeep(event.value);
		this.publications.push({
			...event.record,
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
		});
	}
}

class CapturedProxyFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	key: Child = { id: "key", value: 0 };
	map = new CapturingMap([[this.key, "before"]]);
	set = new CapturingSet([this.key]);
	other = { value: 0 };
	ballast = { stable: "unchanged" };

	canonicalizeCapturedCollections(value: number): void {
		const capturedKey = [...this.map.keys()][0] as Child;
		const map = this.map as CapturingMap;
		Object.defineProperty(map, "putBox", {
			configurable: true,
			value(this: Map<unknown, unknown>, box: Box, next: unknown): void {
				Map.prototype.set.call(this, box.inner, next);
			},
		});
		map.putBox({ inner: capturedKey }, "after");
		delete (map as Partial<CapturingMap>).putBox;
		const capturedValue = [...this.set.values()][0] as Child;
		const set = this.set as CapturingSet;
		Object.defineProperties(set, {
			pending: { configurable: true, writable: true, value: capturedValue },
			clearThenAddPending: {
				configurable: true,
				value(this: CapturingSet): void {
					Set.prototype.clear.call(this);
					Set.prototype.add.call(this, this.pending);
				},
			},
		});
		set.clearThenAddPending();
		delete (set as Partial<CapturingSet>).pending;
		delete (set as Partial<CapturingSet>).clearThenAddPending;
		this.other.value = value;
	}
}

interface Harness {
	rawDRP: CapturedProxyFixture;
	applier: DRPVertexApplier<CapturedProxyFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<CapturedProxyFixture>;
}

function harness(): Harness {
	const rawDRP = new CapturedProxyFixture();
	const rawACL = createACL({ admins: ["local"] });
	const hashGraph = new HashGraph("local", rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
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
	) => DRPVertexApplier<CapturedProxyFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

describe("Phase 1d(i) captured-proxy collection publication", () => {
	it("publishes canonical collection state with exact changed keys and byte-exact reconstruction", () => {
		const h = harness();
		const before = bytesByKey(h.rawDRP);

		h.applier.drp!.canonicalizeCapturedCollections(7);

		const vertex = h.hashGraph
			.getAllVertices()
			.find((candidate) => candidate.operation?.opType === "canonicalizeCapturedCollections");
		expect(vertex, "positive control: the operation must commit").toBeDefined();
		const publication = h.probe.publications.find(
			(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex!.hash
		);
		expect(publication, "positive control: the operation must publish").toBeDefined();
		const groundTruth = byteDeltaKeys(before, h.rawDRP);
		expect(groundTruth).toEqual(["map", "other"]);
		expect
			.soft(publication, "published changed keys must equal the full-state byte ground truth")
			.toMatchObject({ mode: "incremental", changed: { acl: [], drp: groundTruth } });

		expect
			.soft([...h.rawDRP.map.entries()], "the published live Map must have one canonical key")
			.toEqual([[h.rawDRP.key, "after"]]);
		expect.soft([...h.rawDRP.set], "the published live Set must retain one canonical value").toEqual([h.rawDRP.key]);
		const stored = h.states.getDRPState(vertex!.hash)!;
		expect
			.soft(encodedState(h.states.fromHash(vertex!.hash)[0]!), "fromHash must match the executed full-state bytes")
			.toEqual(encodedState(h.rawDRP));
		expect
			.soft(
				DRPStateOtherTheWire.encode(serializeDRPState(stored)).finish(),
				"the stored snapshot must match the executed full-state bytes"
			)
			.toEqual(encodedState(h.rawDRP));
	});
});
