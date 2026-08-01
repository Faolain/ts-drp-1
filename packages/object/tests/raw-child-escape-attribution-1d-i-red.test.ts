/* eslint-disable @typescript-eslint/no-non-null-assertion -- committed vertices and snapshots are narrowed by controls */
import { DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
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

interface CustomPublicationRoot {
	alias: Child;
	mirrorMap: Map<string, Child>;
	mirrorSet: Set<Child>;
}

interface OwnPublicationRoot {
	ownAlias: Child;
	ownMirrorMap: Map<string, Child>;
	ownMirrorSet: Set<Child>;
}

interface FrozenPublicationRoot {
	frozenAlias: Child;
	frozenHolder: Readonly<{ child: Child }>;
	frozenMirrorSet: Set<Child>;
}

class EscapeMap extends Map<unknown, unknown> {
	declare ownChild?: Child;

	mutateFirstKey(value: number): void {
		const child = Map.prototype.keys.call(this).next().value as Child;
		child.value = value;
	}

	mutateDuplicatedValueAfterReinsert(value: number): void {
		const child = Map.prototype.get.call(this, "first") as Child;
		Map.prototype.delete.call(this, "first");
		Map.prototype.delete.call(this, "second");
		child.value = value;
		Map.prototype.set.call(this, "first", child);
		Map.prototype.set.call(this, "second", child);
	}

	mutateFirstKeyThenThrow(value: number, failure: unknown): never {
		this.mutateFirstKey(value);
		throw failure;
	}

	readOnly(): number {
		return Reflect.getOwnPropertyDescriptor(Map.prototype, "size")!.get!.call(this) as number;
	}

	throwWithoutMutation(failure: unknown): never {
		throw failure;
	}

	appendPrimitive(): void {
		Map.prototype.set.call(this, "added", 1);
	}

	prepareOwnChild(): void {
		this.ownChild = Map.prototype.values.call(this).next().value as Child;
	}

	mutateAcrossOwners(root: CustomPublicationRoot, value: number): void {
		const child = Map.prototype.keys.call(this).next().value as Child;
		// Snapshot reconstruction clones top-level fields independently. Relinking
		// their equal-byte children here changes identity but not the byte oracle.
		root.alias = child;
		Map.prototype.clear.call(root.mirrorMap);
		Map.prototype.set.call(root.mirrorMap, "first", child);
		Map.prototype.set.call(root.mirrorMap, "second", child);
		Set.prototype.clear.call(root.mirrorSet);
		Set.prototype.add.call(root.mirrorSet, child);
		child.value = value;
	}

	prepareOwnAcrossOwners(root: OwnPublicationRoot): void {
		const child = Map.prototype.values.call(this).next().value as Child;
		this.ownChild = child;
		root.ownAlias = child;
		Map.prototype.clear.call(root.ownMirrorMap);
		Map.prototype.set.call(root.ownMirrorMap, "entry", child);
		Set.prototype.clear.call(root.ownMirrorSet);
		Set.prototype.add.call(root.ownMirrorSet, child);
	}

	prepareFrozenRoot(root: FrozenPublicationRoot): void {
		const child = Map.prototype.keys.call(this).next().value as Child;
		root.frozenAlias = child;
		root.frozenHolder = Object.freeze({ child });
		Set.prototype.clear.call(root.frozenMirrorSet);
		Set.prototype.add.call(root.frozenMirrorSet, child);
	}
}

class EscapeSet extends Set<Child> {
	declare readonly inheritedChild: Child;

	mutateEntryAfterReinsert(value: number): void {
		const child = Set.prototype.values.call(this).next().value as Child;
		Set.prototype.delete.call(this, child);
		child.value = value;
		Set.prototype.add.call(this, child);
	}

	mutateEntryThenThrow(value: number, failure: unknown): never {
		const child = Set.prototype.values.call(this).next().value as Child;
		child.value = value;
		throw failure;
	}

	readOnly(): number {
		return Reflect.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(this) as number;
	}

	throwWithoutMutation(failure: unknown): never {
		throw failure;
	}

	appendPrimitive(): void {
		Set.prototype.add.call(this, { id: "added", value: 1 });
	}

	prepareInheritedChild(): void {
		const child = Set.prototype.values.call(this).next().value as Child;
		Object.defineProperty(Object.getPrototypeOf(this), "inheritedChild", {
			configurable: true,
			value: child,
		});
	}

	prepareInheritedAcrossOwners(root: InheritedPublicationRoot): void {
		const child = Set.prototype.values.call(this).next().value as Child;
		Object.defineProperty(Object.getPrototypeOf(this), "inheritedChild", {
			configurable: true,
			value: child,
		});
		root.inheritedAlias = child;
		Map.prototype.clear.call(root.inheritedMirrorMap);
		Map.prototype.set.call(root.inheritedMirrorMap, "entry", child);
		Set.prototype.clear.call(root.inheritedMirrorSet);
		Set.prototype.add.call(root.inheritedMirrorSet, child);
	}

	removeInheritedChild(): void {
		Reflect.deleteProperty(Object.getPrototypeOf(this), "inheritedChild");
	}
}

interface InheritedPublicationRoot {
	inheritedAlias: Child;
	inheritedMirrorMap: Map<string, Child>;
	inheritedMirrorSet: Set<Child>;
}

function frozenBytesByKey(value: object): Map<string, Uint8Array> {
	return new Map(
		stateFromDRP(value as IDRP).state.map(({ key, value: entry }) => [key, Uint8Array.from(serializeValue(entry))])
	);
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = frozenBytesByKey(value);
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
	state: T,
	expected: string[]
): void {
	const truth = byteDeltaKeys(before, state);
	expect(truth, "independently serialized top-level byte truth").toEqual(expected);
	expect([...tracked.changedKeys()].sort(), "tracker attribution must cover exactly the byte owners").toEqual(truth);
	expect(tracked.hasChanges()).toBe(truth.length > 0);
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("Phase 1d(i) raw children escaping custom collection methods", () => {
	it("charges every owner when a raw Map receiver mutates an existing key child", () => {
		const child = { id: "key", value: 0 };
		const state = {
			map: new EscapeMap([[child, "value"]]),
			mirrorMap: new Map([[child, "mirror"]]),
			mirrorSet: new Set([child]),
			alias: child,
		};
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.map.mutateFirstKey(1);

		expectExactAttribution(tracked, before, state, ["alias", "map", "mirrorMap", "mirrorSet"]);
	});

	it("keeps duplicate Map parent counts exact across remove, mutate, and reinsert", () => {
		const child = { id: "value", value: 0 };
		const state = {
			map: new EscapeMap([
				["first", child],
				["second", child],
			]),
			mirrorMap: new Map([["entry", child]]),
			alias: child,
		};
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.map.mutateDuplicatedValueAfterReinsert(2);

		expect(Map.prototype.get.call(state.map, "first")).toBe(child);
		expect(Map.prototype.get.call(state.map, "second")).toBe(child);
		expectExactAttribution(tracked, before, state, ["alias", "map", "mirrorMap"]);
	});

	it("charges every owner when a raw Set receiver removes, mutates, and reinserts an entry", () => {
		const child = { id: "entry", value: 0 };
		const state = {
			set: new EscapeSet([child]),
			mirrorMap: new Map([["entry", child]]),
			mirrorSet: new Set([child]),
			alias: child,
		};
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.set.mutateEntryAfterReinsert(3);

		expect([...state.set]).toEqual([child]);
		expectExactAttribution(tracked, before, state, ["alias", "mirrorMap", "mirrorSet", "set"]);
	});

	it.each([
		["Map key", (map: EscapeMap, _set: EscapeSet, failure: unknown): never => map.mutateFirstKeyThenThrow(4, failure)],
		["Set entry", (_map: EscapeMap, set: EscapeSet, failure: unknown): never => set.mutateEntryThenThrow(4, failure)],
	] as const)("preserves exact throwable identity and charges all byte owners for a mutated %s", (_label, invoke) => {
		const child = { id: "throw", value: 0 };
		const state = { map: new EscapeMap([[child, child]]), set: new EscapeSet([child]), alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);
		const failure = Object.freeze({ code: `raw-${_label}` });

		expect(caught(() => invoke(tracked.proxy.map, tracked.proxy.set, failure))).toBe(failure);
		expectExactAttribution(tracked, before, state, ["alias", "map", "set"]);
	});
});

describe("Phase 1d(i) raw children escaping collection member reads", () => {
	it("wraps a raw child returned by a non-function own Map member", () => {
		const child = { id: "own", value: 0 };
		const state = { map: new EscapeMap([["entry", child]]), mirrorSet: new Set([child]), alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);
		tracked.proxy.map.prepareOwnChild();

		tracked.proxy.map.ownChild!.value = 5;
		Reflect.deleteProperty(state.map, "ownChild");

		expectExactAttribution(tracked, before, state, ["alias", "map", "mirrorSet"]);
	});

	it("wraps a raw child returned by a non-function inherited Set member", () => {
		const child = { id: "inherited", value: 0 };
		const state = { set: new EscapeSet([child]), mirrorMap: new Map([["entry", child]]), alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);
		tracked.proxy.set.prepareInheritedChild();

		tracked.proxy.set.inheritedChild.value = 6;
		tracked.proxy.set.removeInheritedChild();

		expectExactAttribution(tracked, before, state, ["alias", "mirrorMap", "set"]);
	});
});

describe("Phase 1d(i) Proxy-invariant raw ordinary child", () => {
	it("charges all owners after a frozen holder must expose its raw non-writable value", () => {
		const child = { id: "frozen", value: 0 };
		const state = { frozenHolder: Object.freeze({ child }), mirrorSet: new Set([child]), alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.frozenHolder.child.value = 7;

		expectExactAttribution(tracked, before, state, ["alias", "frozenHolder", "mirrorSet"]);
	});
});

describe("Phase 1d(i) raw-child escape controls", () => {
	it("distinguishes conservative custom read candidates from zero serialized byte deltas", () => {
		const state = { map: new EscapeMap([["entry", 1]]), set: new EscapeSet([{ id: "entry", value: 0 }]) };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		expect(tracked.proxy.map.readOnly()).toBe(1);
		expect(tracked.proxy.set.readOnly()).toBe(1);

		expect(byteDeltaKeys(before, state)).toEqual([]);
		expect([...tracked.changedKeys()].sort(), "unknown methods are conservative tracker candidates").toEqual([
			"map",
			"set",
		]);
	});

	it("preserves no-op throw identity without inventing physical byte deltas", () => {
		const state = { map: new EscapeMap(), set: new EscapeSet() };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);
		const mapFailure = Object.freeze({ code: "map-no-op" });
		const setFailure = new Error("set no-op");

		expect(caught(() => tracked.proxy.map.throwWithoutMutation(mapFailure))).toBe(mapFailure);
		expect(caught(() => tracked.proxy.set.throwWithoutMutation(setFailure))).toBe(setFailure);
		expect(byteDeltaKeys(before, state), "no-op throws have no byte owners").toEqual([]);
		expect([...tracked.changedKeys()].sort(), "throwing unknown methods remain conservative candidates").toEqual([
			"map",
			"set",
		]);
	});

	it("attributes structural-only custom methods to only their collection owners", () => {
		const state = { map: new EscapeMap(), set: new EscapeSet() };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.map.appendPrimitive();
		tracked.proxy.set.appendPrimitive();

		expectExactAttribution(tracked, before, state, ["map", "set"]);
	});

	it("keeps captured proxy and specialized intrinsic reads governed", () => {
		const child = { id: "captured", value: 0 };
		const state = { map: new Map([["entry", child]]), set: new Set([child]), alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);
		const captured = tracked.proxy.map.get("entry")!;

		expect(captured).not.toBe(child);
		captured.value = 8;

		expectExactAttribution(tracked, before, state, ["alias", "map", "set"]);
	});

	it("keeps ordinary nested proxy mutation governed", () => {
		const child = { id: "ordinary", value: 0 };
		const state = { holder: { child }, alias: child };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.holder.child.value = 9;

		expectExactAttribution(tracked, before, state, ["alias", "holder"]);
	});

	it("preserves the native non-configurable, non-writable Proxy get invariant", () => {
		const child = { id: "invariant", value: 0 };
		const holder = Object.freeze({ child });
		const tracked = trackMutations({ holder });
		const hostile = new Proxy(holder, { get: (): Child => ({ id: "replacement", value: 0 }) });

		expect(tracked.proxy.holder.child).toBe(child);
		expect(() => hostile.child).toThrow(TypeError);
		expect([...tracked.changedKeys()]).toEqual([]);
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

class RawEscapeFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	customMap = new EscapeMap([[{ id: "custom", value: 0 }, "entry"]]);
	alias = { id: "custom", value: 0 };
	mirrorMap = new Map([
		["first", { id: "custom", value: 0 }],
		["second", { id: "custom", value: 0 }],
	]);
	mirrorSet = new Set([{ id: "custom", value: 0 }]);

	ownMap = new EscapeMap([["entry", { id: "own", value: 0 }]]);
	ownAlias = { id: "own", value: 0 };
	ownMirrorMap = new Map([["entry", { id: "own", value: 0 }]]);
	ownMirrorSet = new Set([{ id: "own", value: 0 }]);
	inheritedSet = new EscapeSet([{ id: "inherited", value: 0 }]);
	inheritedAlias = { id: "inherited", value: 0 };
	inheritedMirrorMap = new Map([["entry", { id: "inherited", value: 0 }]]);
	inheritedMirrorSet = new Set([{ id: "inherited", value: 0 }]);

	frozenMap = new EscapeMap([[{ id: "frozen", value: 0 }, "entry"]]);
	frozenAlias = { id: "frozen", value: 0 };
	frozenHolder: Readonly<{ child: Child }> = Object.freeze({ child: { id: "frozen", value: 0 } });
	frozenMirrorSet = new Set([{ id: "frozen", value: 0 }]);
	ballast = { stable: "unchanged" };

	customMethodEscape(value: number): void {
		// Nested collection subclasses are reconstructed as native Map/Set values.
		// Install the custom surface as an own method, which is the actual escape path.
		Object.defineProperty(this.customMap, "mutateAcrossOwners", {
			configurable: true,
			value: EscapeMap.prototype.mutateAcrossOwners,
		});
		try {
			this.customMap.mutateAcrossOwners(this, value);
		} finally {
			Reflect.deleteProperty(this.customMap, "mutateAcrossOwners");
		}
	}

	memberReadEscape(ownValue: number, inheritedValue: number): void {
		Object.defineProperty(this.ownMap, "prepareOwnAcrossOwners", {
			configurable: true,
			value: EscapeMap.prototype.prepareOwnAcrossOwners,
		});
		try {
			this.ownMap.prepareOwnAcrossOwners(this);
			this.ownMap.ownChild!.value = ownValue;
		} finally {
			Reflect.deleteProperty(this.ownMap, "ownChild");
			Reflect.deleteProperty(this.ownMap, "prepareOwnAcrossOwners");
		}

		Object.defineProperty(this.inheritedSet, "prepareInheritedAcrossOwners", {
			configurable: true,
			value: EscapeSet.prototype.prepareInheritedAcrossOwners,
		});
		try {
			this.inheritedSet.prepareInheritedAcrossOwners(this);
			this.inheritedSet.inheritedChild.value = inheritedValue;
		} finally {
			Reflect.deleteProperty(Object.getPrototypeOf(this.inheritedSet), "inheritedChild");
			Reflect.deleteProperty(this.inheritedSet, "prepareInheritedAcrossOwners");
		}
	}

	frozenInvariantEscape(value: number): void {
		// Property descriptors do not survive state reconstruction, so the raw setup
		// creates the frozen holder inside this operation before the invariant read.
		Object.defineProperty(this.frozenMap, "prepareFrozenRoot", {
			configurable: true,
			value: EscapeMap.prototype.prepareFrozenRoot,
		});
		try {
			this.frozenMap.prepareFrozenRoot(this);
			this.frozenHolder.child.value = value;
		} finally {
			Reflect.deleteProperty(this.frozenMap, "prepareFrozenRoot");
		}
	}

	readOnlyCustomMethods(): number {
		Object.defineProperty(this.customMap, "readOnly", { configurable: true, value: EscapeMap.prototype.readOnly });
		Object.defineProperty(this.inheritedSet, "readOnly", { configurable: true, value: EscapeSet.prototype.readOnly });
		try {
			return this.customMap.readOnly() + this.inheritedSet.readOnly();
		} finally {
			Reflect.deleteProperty(this.customMap, "readOnly");
			Reflect.deleteProperty(this.inheritedSet, "readOnly");
		}
	}
}

interface Harness {
	rawDRP: RawEscapeFixture;
	applier: DRPVertexApplier<RawEscapeFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<RawEscapeFixture>;
}

function harness(): Harness {
	const rawDRP = new RawEscapeFixture();
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
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<RawEscapeFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must author a vertex`).toBeDefined();
	return vertex!;
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

function expectPublicationTruth(
	h: Harness,
	opType: string,
	before: ReadonlyMap<string, Uint8Array>,
	expectedKeys: string[]
): void {
	const vertex = vertexFor(h, opType);
	const truth = byteDeltaKeys(before, h.rawDRP);
	expect(truth, "full-state byte oracle must identify the intended physical owners").toEqual(expectedKeys);
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex.hash
	);
	expect(publication, "the authored vertex must publish").toBeDefined();
	expect
		.soft(publication, "final byte-filtered publication keys must equal byte truth")
		.toMatchObject({ mode: "incremental", changed: { acl: [], drp: truth } });
	const stored = h.states.getDRPState(vertex.hash)!;
	expect
		.soft(
			DRPStateOtherTheWire.encode(serializeDRPState(stored)).finish(),
			"stored snapshot must match authored live bytes"
		)
		.toEqual(encodedState(h.rawDRP));
	expect
		.soft(encodedState(h.states.fromHash(vertex.hash)[0]!), "fromHash must reconstruct authored live bytes")
		.toEqual(encodedState(h.rawDRP));
}

describe("Phase 1d(i) raw-child escape publication", () => {
	it("publishes every owner changed by a raw custom Map receiver", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.customMethodEscape(11);

		expectPublicationTruth(h, "customMethodEscape", before, ["alias", "customMap", "mirrorMap", "mirrorSet"]);
	});

	it("publishes owners reached through own Map and inherited Set data members", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.memberReadEscape(12, 13);

		expectPublicationTruth(h, "memberReadEscape", before, [
			"inheritedAlias",
			"inheritedMirrorMap",
			"inheritedMirrorSet",
			"inheritedSet",
			"ownAlias",
			"ownMap",
			"ownMirrorMap",
			"ownMirrorSet",
		]);
	});

	it("publishes every owner changed below a Proxy-invariant frozen property", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.frozenInvariantEscape(14);

		expectPublicationTruth(h, "frozenInvariantEscape", before, [
			"frozenAlias",
			"frozenHolder",
			"frozenMap",
			"frozenMirrorSet",
		]);
	});

	it("byte-filters conservative read-only custom candidates at publication", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		expect(h.applier.drp!.readOnlyCustomMethods()).toBe(2);

		const vertex = vertexFor(h, "readOnlyCustomMethods");
		expect(byteDeltaKeys(before, h.rawDRP)).toEqual([]);
		const publication = h.probe.publications.find((candidate) => candidate.targetHash === vertex.hash);
		expect(publication).toMatchObject({ mode: "incremental", changed: { acl: [], drp: [] } });
		expect(encodedState(h.states.fromHash(vertex.hash)[0]!)).toEqual(encodedState(h.rawDRP));
	});
});
