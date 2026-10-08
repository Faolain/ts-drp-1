/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices */
import { DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { type MutationTrackingResult, trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface Child {
	value: number;
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

function caughtIdentity(run: () => unknown): { failed: boolean; value: unknown } {
	try {
		return { failed: false, value: run() };
	} catch (error) {
		return { failed: true, value: error };
	}
}

function ownMethod(target: object, property: PropertyKey, value: (...args: never[]) => unknown): void {
	Object.defineProperty(target, property, { configurable: true, value });
}

class PartialMapIterator extends Map<string, Child> {
	private armed = false;

	constructor(
		entries: ReadonlyArray<readonly [string, Child]>,
		private readonly throwAfterFirst: boolean
	) {
		super(entries);
	}

	*[Symbol.iterator](): MapIterator<[string, Child]> {
		if (!this.armed) {
			yield* Map.prototype.entries.call(this);
			return;
		}
		const first = Map.prototype.entries.call(this).next();
		if (!first.done) {
			yield first.value as [string, Child];
			if (this.throwAfterFirst) throw "map iterator failure";
		}
	}

	arm(): void {
		this.armed = true;
	}

	disarm(): void {
		this.armed = false;
	}
}

class PartialSetIterator extends Set<Child> {
	private armed = false;

	constructor(
		values: readonly Child[],
		private readonly throwAfterFirst: boolean
	) {
		super(values);
	}

	*[Symbol.iterator](): SetIterator<Child> {
		if (!this.armed) {
			yield* Set.prototype.values.call(this);
			return;
		}
		const first = Set.prototype.values.call(this).next();
		if (!first.done) {
			yield first.value as Child;
			if (this.throwAfterFirst) throw "set iterator failure";
		}
	}

	arm(): void {
		this.armed = true;
	}

	disarm(): void {
		this.armed = false;
	}
}

describe("Phase 1d(i) intrinsic Map specialized dispatch", () => {
	it("ignores a no-op set override, returns the governed receiver, and creates no phantom parent", () => {
		const child = { value: 0 };
		const state = { map: new Map<string, Child>(), alias: child };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(function (this: Map<string, Child>): Map<string, Child> {
			return this;
		});
		ownMethod(state.map, "set", hostile as (...args: never[]) => unknown);

		const result = tracked.proxy.map.set("entry", child);
		Reflect.deleteProperty(state.map, "set");

		expect(hostile).not.toHaveBeenCalled();
		expect(result).toBe(tracked.proxy.map);
		expect(Map.prototype.get.call(state.map, "entry")).toBe(child);
		tracked.proxy.alias.value = 1;
		expectExactAttribution(tracked, before, state);
	});

	it("books the physical value rather than a different value written by an override", () => {
		const requested = { value: 0 };
		const substituted = { value: 0 };
		const state = {
			map: new Map<string, Child>(),
			fresh: new Map<string, Child>([["entry", substituted]]),
			requested,
			substituted,
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(function (this: Map<string, Child>, key: string): Map<string, Child> {
			Map.prototype.set.call(this, key, substituted);
			return this;
		});
		ownMethod(state.map, "set", hostile as (...args: never[]) => unknown);

		const result = tracked.proxy.map.set("entry", requested);
		Reflect.deleteProperty(state.map, "set");
		tracked.proxy.fresh = state.map;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.substituted.value = 1;

		expect(hostile).not.toHaveBeenCalled();
		expect(result).toBe(tracked.proxy.map);
		expect(Map.prototype.get.call(state.map, "entry")).toBe(requested);
		expectExactAttribution(tracked, before, state);
	});

	it("uses intrinsic has/get inside set and attaches the physical child to a fresh owner", () => {
		const child = { value: 0 };
		const state = {
			map: new Map<string, Child>(),
			fresh: new Map<string, Child>([["entry", { value: 0 }]]),
			alias: child,
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostileHas = vi.fn(() => true);
		const hostileGet = vi.fn(() => ({ value: 999 }));
		ownMethod(state.map, "has", hostileHas as (...args: never[]) => unknown);
		ownMethod(state.map, "get", hostileGet as (...args: never[]) => unknown);

		tracked.proxy.map.set("entry", child);
		Reflect.deleteProperty(state.map, "has");
		Reflect.deleteProperty(state.map, "get");
		tracked.proxy.fresh = state.map;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.alias.value = 1;

		expect(hostileHas).not.toHaveBeenCalled();
		expect(hostileGet).not.toHaveBeenCalled();
		expect(tracked.changedKeys().has("fresh")).toBe(true);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		["object", Object.freeze({ code: "set failure" })],
		["falsy", 0],
	])("does not dispatch a commit-then-throw set override with a %s throwable", (_label, failure) => {
		const state = { map: new Map<string, number>() };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(function (this: Map<string, number>): never {
			Map.prototype.set.call(this, "entry", 99);
			throw failure;
		});
		ownMethod(state.map, "set", hostile as (...args: never[]) => unknown);

		const outcome = caughtIdentity(() => tracked.proxy.map.set("entry", 1));
		Reflect.deleteProperty(state.map, "set");

		expect(outcome.failed).toBe(false);
		expect(outcome.value).toBe(tracked.proxy.map);
		expect(hostile).not.toHaveBeenCalled();
		expect([...state.map]).toEqual([["entry", 1]]);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		[
			"deletes but lies false",
			function (this: Map<string, Child>, key: string): boolean {
				Map.prototype.delete.call(this, key);
				return false;
			},
		],
		[
			"lies true without deleting",
			function (): boolean {
				return true;
			},
		],
		[
			"deletes then throws",
			function (this: Map<string, Child>, key: string): never {
				Map.prototype.delete.call(this, key);
				throw Object.freeze({ code: "delete failure" });
			},
		],
	])("uses physical intrinsic delete semantics when an override %s", (_label, override) => {
		const child = { value: 0 };
		const state = { map: new Map<string, Child>([["entry", child]]), fresh: new Map<string, Child>(), alias: child };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(override);
		ownMethod(state.map, "delete", hostile as (...args: never[]) => unknown);

		const outcome = caughtIdentity(() => tracked.proxy.map.delete("entry"));
		Reflect.deleteProperty(state.map, "delete");
		tracked.proxy.fresh = state.map;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.alias.value = 1;

		expect(outcome).toEqual({ failed: false, value: true });
		expect(hostile).not.toHaveBeenCalled();
		expect(state.map.size).toBe(0);
		expectExactAttribution(tracked, before, state);
	});
});

describe("Phase 1d(i) intrinsic Set specialized dispatch", () => {
	it("ignores a no-op add override, returns the governed receiver, and creates no phantom parent", () => {
		const child = { value: 0 };
		const state = { set: new Set<Child>(), alias: child };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(function (this: Set<Child>): Set<Child> {
			return this;
		});
		ownMethod(state.set, "add", hostile as (...args: never[]) => unknown);

		const result = tracked.proxy.set.add(child);
		Reflect.deleteProperty(state.set, "add");

		expect(hostile).not.toHaveBeenCalled();
		expect(result).toBe(tracked.proxy.set);
		expect(Set.prototype.has.call(state.set, child)).toBe(true);
		tracked.proxy.alias.value = 1;
		expectExactAttribution(tracked, before, state);
	});

	it("uses intrinsic has inside add and attaches the physical child to a fresh owner", () => {
		const child = { value: 0 };
		const state = { set: new Set<Child>(), fresh: new Set<Child>([{ value: 0 }]), alias: child };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostileHas = vi.fn(() => true);
		ownMethod(state.set, "has", hostileHas as (...args: never[]) => unknown);

		tracked.proxy.set.add(child);
		Reflect.deleteProperty(state.set, "has");
		tracked.proxy.fresh = state.set;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.alias.value = 1;

		expect(hostileHas).not.toHaveBeenCalled();
		expect(tracked.changedKeys().has("fresh")).toBe(true);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		["object", Object.freeze({ code: "add failure" })],
		["falsy", false],
	])("does not dispatch a commit-then-throw add override with a %s throwable", (_label, failure) => {
		const child = { value: 0 };
		const state = { set: new Set<Child>() };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(function (this: Set<Child>): never {
			Set.prototype.add.call(this, child);
			throw failure;
		});
		ownMethod(state.set, "add", hostile as (...args: never[]) => unknown);

		const outcome = caughtIdentity(() => tracked.proxy.set.add(child));
		Reflect.deleteProperty(state.set, "add");

		expect(outcome.failed).toBe(false);
		expect(outcome.value).toBe(tracked.proxy.set);
		expect(hostile).not.toHaveBeenCalled();
		expect([...state.set]).toEqual([child]);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		[
			"deletes but lies false",
			function (this: Set<Child>, value: Child): boolean {
				Set.prototype.delete.call(this, value);
				return false;
			},
		],
		[
			"lies true without deleting",
			function (): boolean {
				return true;
			},
		],
		[
			"deletes then throws",
			function (this: Set<Child>, value: Child): never {
				Set.prototype.delete.call(this, value);
				throw "set delete failure";
			},
		],
	])("uses physical intrinsic delete semantics when an override %s", (_label, override) => {
		const child = { value: 0 };
		const state = { set: new Set<Child>([child]), fresh: new Set<Child>(), alias: child };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(override);
		ownMethod(state.set, "delete", hostile as (...args: never[]) => unknown);

		const outcome = caughtIdentity(() => tracked.proxy.set.delete(child));
		Reflect.deleteProperty(state.set, "delete");
		tracked.proxy.fresh = state.set;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.alias.value = 1;

		expect(outcome).toEqual({ failed: false, value: true });
		expect(hostile).not.toHaveBeenCalled();
		expect(state.set.size).toBe(0);
		expectExactAttribution(tracked, before, state);
	});
});

describe("Phase 1d(i) intrinsic collection clear and iteration", () => {
	it.each([
		[
			"Map",
			(): { collection: Map<string, Child>; alias: Child } => {
				const alias = { value: 0 };
				return { collection: new Map([["entry", alias]]), alias };
			},
		],
		[
			"Set",
			(): { collection: Set<Child>; alias: Child } => {
				const alias = { value: 0 };
				return { collection: new Set([alias]), alias };
			},
		],
	])("ignores a no-op %s clear override and charges the actual intrinsic clear", (_label, make) => {
		const { collection, alias } = make();
		const state = { collection, alias };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const hostile = vi.fn(() => undefined);
		ownMethod(collection, "clear", hostile as (...args: never[]) => unknown);

		const result = tracked.proxy.collection.clear();
		Reflect.deleteProperty(collection, "clear");

		expect(result).toBeUndefined();
		expect(hostile).not.toHaveBeenCalled();
		expect(collection.size).toBe(0);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		[
			"Map",
			(): { collection: Map<string, Child>; alias: Child } => {
				const alias = { value: 0 };
				return { collection: new Map([["entry", alias]]), alias };
			},
		],
		[
			"Set",
			(): { collection: Set<Child>; alias: Child } => {
				const alias = { value: 0 };
				return { collection: new Set([alias]), alias };
			},
		],
	])("does not dispatch a commit-then-throw %s clear override", (_label, make) => {
		const { collection, alias } = make();
		const state = { collection, alias };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);
		const failure = Object.freeze({ code: `${_label} clear failure` });
		const hostile = vi.fn(function (this: Map<unknown, unknown> | Set<unknown>): never {
			if (this instanceof Map) Map.prototype.clear.call(this);
			else Set.prototype.clear.call(this);
			throw failure;
		});
		ownMethod(collection, "clear", hostile as (...args: never[]) => unknown);

		const outcome = caughtIdentity(() => tracked.proxy.collection.clear());
		Reflect.deleteProperty(collection, "clear");

		expect(outcome).toEqual({ failed: false, value: undefined });
		expect(hostile).not.toHaveBeenCalled();
		expect(collection.size).toBe(0);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		[
			"Map",
			(first: Child, second: Child): PartialMapIterator =>
				new PartialMapIterator(
					[
						["first", first],
						["second", second],
					],
					true
				),
		],
		["Set", (first: Child, second: Child): PartialSetIterator => new PartialSetIterator([first, second], true)],
	])("bypasses a yield-then-throw subclass %s iterator during clear", (_label, make) => {
		const first = { value: 0 };
		const second = { value: 0 };
		const collection = make(first, second);
		const state = { collection, first, second };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		collection.arm();
		const outcome = caughtIdentity(() => tracked.proxy.collection.clear());
		collection.disarm();
		tracked.proxy.first.value = 1;

		expect(outcome).toEqual({ failed: false, value: undefined });
		expect(collection.size).toBe(0);
		expectExactAttribution(tracked, before, state);
	});

	it.each([
		[
			"Map",
			(first: Child, second: Child): PartialMapIterator =>
				new PartialMapIterator(
					[
						["first", first],
						["second", second],
					],
					false
				),
		],
		["Set", (first: Child, second: Child): PartialSetIterator => new PartialSetIterator([first, second], false)],
	])("does not leave a phantom edge after a partial-return subclass %s iterator", (_label, make) => {
		const first = { value: 0 };
		const second = { value: 0 };
		const collection = make(first, second);
		const fresh = _label === "Map" ? new PartialMapIterator([], false) : new PartialSetIterator([], false);
		const state = { collection, fresh, first, second };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		collection.arm();
		tracked.proxy.collection.clear();
		collection.disarm();
		tracked.proxy.fresh = state.collection;
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		tracked.proxy.second.value = 1;

		expect(collection.size).toBe(0);
		expect(tracked.changedKeys().has("fresh")).toBe(false);
		expectExactAttribution(tracked, before, state);
	});

	it("uses intrinsic Map reads, iteration, and forEach despite own overrides", () => {
		const child = { value: 1 };
		const state = { map: new Map<string, Child>([["entry", child]]) };
		const tracked = trackMutations(state);
		const hostile = vi.fn((): never => {
			throw new Error("hostile Map read");
		});
		for (const property of ["has", "get", "entries", "keys", "values", Symbol.iterator, "forEach"] as const) {
			ownMethod(state.map, property, hostile as (...args: never[]) => unknown);
		}
		let seenValue: unknown;
		let seenKey: unknown;
		let seenOwner: unknown;

		const outcomes = [
			caughtIdentity(() => tracked.proxy.map.has("entry")),
			caughtIdentity(() => tracked.proxy.map.get("entry")),
			caughtIdentity(() => [...tracked.proxy.map.entries()]),
			caughtIdentity(() => [...tracked.proxy.map.keys()]),
			caughtIdentity(() => [...tracked.proxy.map.values()]),
			caughtIdentity(() => [...tracked.proxy.map]),
			caughtIdentity(() =>
				tracked.proxy.map.forEach((value, key, owner) => {
					seenValue = value;
					seenKey = key;
					seenOwner = owner;
				})
			),
		];

		expect(outcomes.map(({ failed }) => failed)).toEqual([false, false, false, false, false, false, false]);
		expect(outcomes[0]!.value).toBe(true);
		expect(outcomes[1]!.value).not.toBe(child);
		expect(outcomes[2]!.value).toEqual([["entry", outcomes[1]!.value]]);
		expect(outcomes[3]!.value).toEqual(["entry"]);
		expect(outcomes[4]!.value).toEqual([outcomes[1]!.value]);
		expect(outcomes[5]!.value).toEqual([["entry", outcomes[1]!.value]]);
		expect(seenValue).toBe(outcomes[1]!.value);
		expect(seenKey).toBe("entry");
		expect(seenOwner).toBe(tracked.proxy.map);
		expect(hostile).not.toHaveBeenCalled();
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it("uses intrinsic Set reads, iteration, and forEach despite own overrides", () => {
		const child = { value: 1 };
		const state = { set: new Set<Child>([child]) };
		const tracked = trackMutations(state);
		const hostile = vi.fn((): never => {
			throw new Error("hostile Set read");
		});
		for (const property of ["has", "entries", "keys", "values", Symbol.iterator, "forEach"] as const) {
			ownMethod(state.set, property, hostile as (...args: never[]) => unknown);
		}
		let seenValue: unknown;
		let seenKey: unknown;
		let seenOwner: unknown;

		const outcomes = [
			caughtIdentity(() => tracked.proxy.set.has(child)),
			caughtIdentity(() => [...tracked.proxy.set.entries()]),
			caughtIdentity(() => [...tracked.proxy.set.keys()]),
			caughtIdentity(() => [...tracked.proxy.set.values()]),
			caughtIdentity(() => [...tracked.proxy.set]),
			caughtIdentity(() =>
				tracked.proxy.set.forEach((value, key, owner) => {
					seenValue = value;
					seenKey = key;
					seenOwner = owner;
				})
			),
		];
		const wrapped = (outcomes[2]!.value as Child[])[0];

		expect(outcomes.map(({ failed }) => failed)).toEqual([false, false, false, false, false, false]);
		expect(outcomes[0]!.value).toBe(true);
		expect(wrapped).not.toBe(child);
		expect(outcomes[1]!.value).toEqual([[wrapped, wrapped]]);
		expect(outcomes[3]!.value).toEqual([wrapped]);
		expect(outcomes[4]!.value).toEqual([wrapped]);
		expect(seenValue).toBe(wrapped);
		expect(seenKey).toBe(wrapped);
		expect(seenOwner).toBe(tracked.proxy.set);
		expect(hostile).not.toHaveBeenCalled();
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it("keeps native Map.set and Set.add receiver and attribution controls exact", () => {
		const mapChild = { value: 0 };
		const setChild = { value: 0 };
		const state = { map: new Map<string, Child>(), set: new Set<Child>(), mapChild, setChild };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		expect(tracked.proxy.map.set("entry", mapChild)).toBe(tracked.proxy.map);
		expect(tracked.proxy.set.add(setChild)).toBe(tracked.proxy.set);
		expectExactAttribution(tracked, before, state);
	});

	it("keeps native Map.delete and Set.delete result and attribution controls exact", () => {
		const mapChild = { value: 0 };
		const setChild = { value: 0 };
		const state = {
			map: new Map<string, Child>([["entry", mapChild]]),
			set: new Set<Child>([setChild]),
			mapChild,
			setChild,
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		expect(tracked.proxy.map.delete("entry")).toBe(true);
		expect(tracked.proxy.set.delete(setChild)).toBe(true);
		expectExactAttribution(tracked, before, state);
	});

	it("keeps native Map.clear and Set.clear result and attribution controls exact", () => {
		const mapChild = { value: 0 };
		const setChild = { value: 0 };
		const state = {
			map: new Map<string, Child>([["entry", mapChild]]),
			set: new Set<Child>([setChild]),
			mapChild,
			setChild,
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		expect(tracked.proxy.map.clear()).toBeUndefined();
		expect(tracked.proxy.set.clear()).toBeUndefined();
		expectExactAttribution(tracked, before, state);
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

class HostileCollectionFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	map = new Map<string, number>([["held", 1]]);
	set = new Set<number>();
	other = { value: 0 };
	ballast = { stable: "unchanged" };

	lyingMapDelete(value: number): void {
		ownMethod(this.map, "delete", function (this: Map<string, number>, key: string): boolean {
			Map.prototype.delete.call(this, key);
			return false;
		});
		this.map.delete("held");
		Reflect.deleteProperty(this.map, "delete");
		this.other.value = value;
	}

	throwingMapSet(value: number): void {
		const failure = Object.freeze({ code: "map set failure" });
		ownMethod(this.map, "set", function (this: Map<string, number>, key: string, next: number): never {
			Map.prototype.set.call(this, key, next);
			throw failure;
		});
		try {
			this.map.set("added", value);
		} catch (error) {
			if (error !== failure) throw error;
		}
		Reflect.deleteProperty(this.map, "set");
		this.other.value = value;
	}

	throwingSetAdd(value: number): void {
		ownMethod(this.set, "add", function (this: Set<number>, next: number): never {
			Set.prototype.add.call(this, next);
			throw 0;
		});
		try {
			this.set.add(value);
		} catch (error) {
			if (error !== 0) throw error;
		}
		Reflect.deleteProperty(this.set, "add");
		this.other.value = value;
	}
}

interface Harness {
	rawDRP: HostileCollectionFixture;
	applier: DRPVertexApplier<HostileCollectionFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<HostileCollectionFixture>;
}

function harness(): Harness {
	const rawDRP = new HostileCollectionFixture();
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
	) => DRPVertexApplier<HostileCollectionFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

function expectPublicationTruth(h: Harness, opType: string, before: ReadonlyMap<string, Uint8Array>): void {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit`).toBeDefined();
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex!.hash
	);
	expect(publication, `positive control: ${opType} must publish`).toBeDefined();
	const groundTruth = byteDeltaKeys(before, h.rawDRP);
	expect(groundTruth).toEqual(opType === "throwingSetAdd" ? ["other", "set"] : ["map", "other"]);
	expect
		.soft(publication, "published changed keys must equal full-capture byte truth")
		.toMatchObject({ mode: "incremental", changed: { acl: [], drp: groundTruth } });
	const stored = h.states.getDRPState(vertex!.hash)!;
	expect
		.soft(DRPStateOtherTheWire.encode(serializeDRPState(stored)).finish(), "stored snapshot must equal live bytes")
		.toEqual(encodedState(h.rawDRP));
	expect
		.soft(encodedState(h.states.fromHash(vertex!.hash)[0]!), "fromHash must equal live bytes")
		.toEqual(encodedState(h.rawDRP));
}

describe("Phase 1d(i) hostile specialized dispatch publication", () => {
	it("publishes a lying-delete Map operation from physical state truth", () => {
		const h = harness();
		const before = bytesByKey(h.rawDRP);

		h.applier.drp!.lyingMapDelete(1);

		expect(h.rawDRP.map.size).toBe(0);
		expectPublicationTruth(h, "lyingMapDelete", before);
	});

	it("publishes an override commit-then-object-throw Map.set operation", () => {
		const h = harness();
		const before = bytesByKey(h.rawDRP);

		h.applier.drp!.throwingMapSet(2);

		expect([...h.rawDRP.map]).toEqual([
			["held", 1],
			["added", 2],
		]);
		expectPublicationTruth(h, "throwingMapSet", before);
	});

	it("publishes an override commit-then-falsy-throw Set.add operation", () => {
		const h = harness();
		const before = bytesByKey(h.rawDRP);

		h.applier.drp!.throwingSetAdd(3);

		expect([...h.rawDRP.set]).toEqual([3]);
		expectPublicationTruth(h, "throwingSetAdd", before);
	});
});
