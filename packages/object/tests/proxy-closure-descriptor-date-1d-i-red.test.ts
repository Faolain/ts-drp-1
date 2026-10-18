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
import { type ComparisonEvent } from "../src/publication/copy-capability.js";
import { type PublicationRecord, type PublicationWorkCounters } from "../src/publication/publisher.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface Child {
	value: number;
}

interface DescriptorSurface {
	owner: object;
	reference: Child;
	getter(): Child;
	setter(value: Child): void;
}

function descriptorSurface(owner: object, value: number): DescriptorSurface {
	const reference = { value };
	const getter = (): Child => reference;
	const setter = (_value: Child): void => {};
	Object.defineProperties(owner, {
		reference: {
			configurable: false,
			enumerable: false,
			value: reference,
			writable: false,
		},
		accessor: {
			configurable: false,
			enumerable: false,
			get: getter,
			set: setter,
		},
		primitive: {
			configurable: true,
			enumerable: false,
			value,
			writable: true,
		},
	});
	return { owner, reference, getter, setter };
}

type DescriptorReader = (owner: object, property: string) => PropertyDescriptor | undefined;

const descriptorReaders: ReadonlyArray<readonly [string, DescriptorReader]> = [
	[
		"Object.getOwnPropertyDescriptor",
		(owner, property): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(owner, property),
	],
	[
		"Object.getOwnPropertyDescriptors",
		(owner, property): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptors(owner)[property],
	],
	[
		"Reflect.getOwnPropertyDescriptor",
		(owner, property): PropertyDescriptor | undefined => Reflect.getOwnPropertyDescriptor(owner, property),
	],
];

function expectUnmodifiedDescriptor(
	actualOwner: object,
	proxyOwner: object,
	reader: DescriptorReader,
	surface: DescriptorSurface
): void {
	const expectedReference = Reflect.getOwnPropertyDescriptor(actualOwner, "reference");
	const actualReference = reader(proxyOwner, "reference");
	expect.soft(actualReference, "reference descriptor must remain exactly compatible").toEqual(expectedReference);
	expect.soft(actualReference?.value, "descriptor data identity is intentionally raw").toBe(surface.reference);

	const expectedAccessor = Reflect.getOwnPropertyDescriptor(actualOwner, "accessor");
	const actualAccessor = reader(proxyOwner, "accessor");
	expect.soft(actualAccessor, "accessor descriptor must remain exactly compatible").toEqual(expectedAccessor);
	expect.soft(actualAccessor?.get, "raw getter function identity must be preserved").toBe(surface.getter);
	expect.soft(actualAccessor?.set, "raw setter function identity must be preserved").toBe(surface.setter);
}

function rawEgress<T extends object>(tracked: MutationTrackingResult<T>): boolean {
	return tracked.hasRawEgress();
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
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

describe("Phase 1d(i) D.92.5-A descriptor-read signaling", () => {
	it.each(descriptorReaders)("signals %s without rewriting descriptors", (_name, reader) => {
		const root = {
			nested: {},
			map: new Map(),
			set: new Set(),
			date: new Date(0),
		};
		const surfaces = [
			descriptorSurface(root, 1),
			descriptorSurface(root.nested, 2),
			descriptorSurface(root.map, 3),
			descriptorSurface(root.set, 4),
			descriptorSurface(root.date, 5),
		];
		const tracked = trackMutations(root);
		const proxyOwners = [tracked.proxy, tracked.proxy.nested, tracked.proxy.map, tracked.proxy.set, tracked.proxy.date];

		for (let index = 0; index < surfaces.length; index++) {
			expectUnmodifiedDescriptor(surfaces[index]!.owner, proxyOwners[index]!, reader, surfaces[index]!);
		}
		surfaces[0]!.reference.value = 99;

		expect.soft(rawEgress(tracked), "a raw reference descriptor must widen candidacy monotonically").toBe(true);
		expect.soft(tracked.hasChanges(), "raw egress alone makes the operation publication-eligible").toBe(true);
		expect.soft([...tracked.changedKeys()], "descriptor observation is not a trap-observed write").toEqual([]);
		expect.soft(rawEgress(tracked), "the signal must remain monotone after the raw mutation").toBe(true);

		const accessorRoot = { nested: {}, map: new Map(), set: new Set(), date: new Date(0) };
		const accessorSurfaces = [
			descriptorSurface(accessorRoot, 11),
			descriptorSurface(accessorRoot.nested, 12),
			descriptorSurface(accessorRoot.map, 13),
			descriptorSurface(accessorRoot.set, 14),
			descriptorSurface(accessorRoot.date, 15),
		];
		const accessorTracked = trackMutations(accessorRoot);
		const accessorOwners = [
			accessorTracked.proxy,
			accessorTracked.proxy.nested,
			accessorTracked.proxy.map,
			accessorTracked.proxy.set,
			accessorTracked.proxy.date,
		];
		for (let index = 0; index < accessorSurfaces.length; index++) {
			const descriptor = reader(accessorOwners[index]!, "accessor");
			expect.soft(descriptor?.get).toBe(accessorSurfaces[index]!.getter);
			expect.soft(descriptor?.set).toBe(accessorSurfaces[index]!.setter);
		}
		expect.soft(rawEgress(accessorTracked), "raw accessor identities must independently widen candidacy").toBe(true);
		expect.soft([...accessorTracked.changedKeys()]).toEqual([]);
	});

	it("does not signal for primitive-only descriptors and key enumeration", () => {
		const state = { one: 1, two: "two", three: true, four: null };
		const tracked = trackMutations(state);

		for (const [, reader] of descriptorReaders) {
			expect(reader(tracked.proxy, "one")).toEqual(Reflect.getOwnPropertyDescriptor(state, "one"));
		}
		expect(Object.keys(tracked.proxy)).toEqual(["one", "two", "three", "four"]);
		expect(rawEgress(tracked)).toBe(false);
		expect(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it("keeps root and nested context descriptor escapes replica-local", () => {
		const context = { nested: { secret: { value: 1 } } };
		const state = { context, governed: { value: 1 } };
		const tracked = trackMutations(state);

		const rootDescriptor = Object.getOwnPropertyDescriptor(tracked.proxy, "context");
		const nestedDescriptor = Reflect.getOwnPropertyDescriptor(tracked.proxy.context.nested, "secret");
		expect(rootDescriptor?.value).toBe(context);
		expect(nestedDescriptor?.value).toBe(context.nested.secret);
		context.nested.secret.value = 2;

		expect(rawEgress(tracked)).toBe(false);
		expect(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect(state.governed).toEqual({ value: 1 });
	});

	it("preserves the primary failure identity after an internal descriptor read", () => {
		const state: Record<string, unknown> = { payload: { value: 1 } };
		const tracked = trackMutations(state);
		const failure = Object.freeze({ code: "descriptor-primary" });
		Object.defineProperty(state, "failure", {
			configurable: true,
			enumerable: true,
			get(): never {
				throw failure;
			},
		});

		expect(caught(() => Object.assign({}, tracked.proxy))).toBe(failure);
		expect.soft(rawEgress(tracked), "the earlier reference descriptor must still signal before failure").toBe(true);
		expect.soft(tracked.hasChanges()).toBe(true);
		expect.soft([...tracked.changedKeys()]).toEqual([]);
	});

	it("keeps all dirty readers O(1) after descriptor egress", () => {
		const counters = { ownKeys: 0, descriptors: 0, reads: 0 };
		const raw = new Proxy(
			{ payload: { value: 1 }, ballast: { stable: true } },
			{
				ownKeys(target): ArrayLike<string | symbol> {
					counters.ownKeys++;
					return Reflect.ownKeys(target);
				},
				getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
					counters.descriptors++;
					return Reflect.getOwnPropertyDescriptor(target, property);
				},
				get(target, property, receiver): unknown {
					counters.reads++;
					return Reflect.get(target, property, receiver);
				},
			}
		);
		const tracked = trackMutations(raw);
		Object.getOwnPropertyDescriptor(tracked.proxy, "payload");
		expect.soft(rawEgress(tracked)).toBe(true);
		counters.ownKeys = 0;
		counters.descriptors = 0;
		counters.reads = 0;

		for (let index = 0; index < 100; index++) {
			tracked.hasChanges();
			tracked.changedKeys();
			tracked.hasRawEgress();
			tracked.rawEgressCandidateKeys();
		}
		expect(counters).toEqual({ ownKeys: 0, descriptors: 0, reads: 0 });
	});

	it("retains the native SameValue invariant as a negative control", () => {
		const actual = Object.freeze({ value: 1 });
		const target = Object.defineProperty({}, "frozen", {
			configurable: false,
			value: actual,
			writable: false,
		});
		const invalid = new Proxy(target, {
			get(): object {
				return { value: 1 };
			},
		});

		expect(() => Reflect.get(invalid, "frozen")).toThrow(TypeError);
		expect(Reflect.getOwnPropertyDescriptor(new Proxy(target, {}), "frozen")).toEqual(
			Reflect.getOwnPropertyDescriptor(target, "frozen")
		);
	});
});

type SnapshotSide = "acl" | "drp";

interface PublicationCopyMetadata {
	publicationId: string;
	side: SnapshotSide;
	key: string;
	image: "pre" | "post";
}

type PublicationObserverEvent =
	| { type: "copy"; value: unknown; metadata: PublicationCopyMetadata }
	| { type: "publication"; record: PublicationRecord };

class PublicationProbe {
	readonly comparisons: ComparisonEvent[] = [];
	readonly copies: PublicationCopyMetadata[] = [];
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") {
			this.copies.push({ ...event.metadata });
			return cloneDeep(event.value);
		}
		this.publications.push({
			...event.record,
			baselineHashes: [...event.record.baselineHashes],
			frontier: [...event.record.frontier],
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
			work: event.record.work
				? {
						acl: { ...event.record.work.acl },
						drp: { ...event.record.work.drp },
					}
				: undefined,
		});
	}

	observeComparison(event: ComparisonEvent): void {
		this.comparisons.push({
			...event,
			metadata: { ...event.metadata },
			pair: { ...event.pair },
			counters: { ...event.counters },
		});
	}
}

interface DateWithExtra extends Date {
	extra?: Child;
	warp?(next: number): number;
	frozenFn?(): string;
	missing?: unknown;
}

class ProxyClosureFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: { value: 0 } };
	descriptorPayload = { value: 0 };
	date: DateWithExtra = new Date(0);
	dateAlias = { value: 0 };
	ballastAlpha = { stable: "unchanged-alpha" };
	ballastBeta = { stable: "unchanged-beta" };

	descriptorEscape(value: number): void {
		const descriptor = Object.getOwnPropertyDescriptor(this, "descriptorPayload");
		if (!descriptor || !("value" in descriptor)) throw new Error("descriptor payload missing");
		(descriptor.value as Child).value = value;
	}

	descriptorReadOnly(): {
		keys: string[];
		spreadValue: number;
		assignedValue: number;
		jsonValue: number;
	} {
		const keys = Object.keys(this);
		const spread = { ...this };
		const assigned = Object.assign({}, this);
		const json = JSON.parse(JSON.stringify(this)) as { descriptorPayload: Child };
		return {
			keys,
			spreadValue: spread.descriptorPayload.value,
			assignedValue: assigned.descriptorPayload.value,
			jsonValue: json.descriptorPayload.value,
		};
	}

	dateExpandoAlias(value: number): void {
		const shared = { value: 0 };
		Object.defineProperty(this.date, "extra", {
			configurable: true,
			enumerable: true,
			value: shared,
			writable: true,
		});
		this.dateAlias = shared;
		const escaped = this.date.extra;
		if (!escaped) throw new Error("Date expando missing");
		escaped.value = value;
	}

	customDateMethod(next: number): void {
		Object.defineProperty(this.date, "warp", {
			configurable: true,
			value(this: Date, timestamp: number): number {
				return Date.prototype.setTime.call(this, timestamp);
			},
		});
		try {
			this.date.warp!(next);
		} finally {
			Reflect.deleteProperty(this.date, "warp");
		}
	}
}

interface Harness {
	rawDRP: ProxyClosureFixture;
	applier: DRPVertexApplier<ProxyClosureFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<ProxyClosureFixture>;
}

function harness(): Harness {
	const rawDRP = new ProxyClosureFixture();
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
		comparisonObserver: probe.observeComparison.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<ProxyClosureFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must author a vertex`).toBeDefined();
	return vertex!;
}

function publicationFor(h: Harness, targetHash: Hash): PublicationRecord {
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === targetHash
	);
	expect(publication, "the authored vertex must publish").toBeDefined();
	return publication!;
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

function expectedWork(keys: number): PublicationWorkCounters {
	return { egressWidenings: 1, comparedKeys: keys, comparisonPasses: 1 };
}

function expectPublicationTruth(
	h: Harness,
	opType: string,
	before: ReadonlyMap<string, Uint8Array>,
	expectedChanged: string[],
	egress: "required" | "optional",
	allowedUnchangedCandidates: readonly string[] = []
): PublicationRecord {
	const vertex = vertexFor(h, opType);
	const truth = byteDeltaKeys(before, h.rawDRP);
	expect(truth, "independent top-level byte truth").toEqual(expectedChanged);
	const publication = publicationFor(h, vertex.hash);
	expect.soft(publication).toMatchObject({
		mode: "incremental",
		changed: { acl: [], drp: expectedChanged },
	});
	const after = frozenBytesByKey(h.rawDRP);
	const governedUnion = new Set([...before.keys(), ...after.keys()]);
	const widened = publication.work?.drp.egressWidenings === 1;
	if (egress === "required") expect.soft(widened, "this raw descriptor path must widen candidacy").toBe(true);
	if (widened) {
		expect.soft(publication.work?.drp).toEqual(expectedWork(governedUnion.size));
	} else {
		expect.soft(publication.work?.drp).toEqual({ egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 });
	}
	expect.soft(publication.work?.acl).toEqual({ egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 });

	const comparisons = h.probe.comparisons.filter(
		(event) =>
			event.metadata.publicationId === publication.publicationId &&
			event.metadata.phase === "publisher-capture" &&
			event.metadata.side === "drp"
	);
	const actualCompared = comparisons.map((event) => event.metadata.key).sort();
	if (widened) {
		const expectedCompared = [...before.keys()].filter((key) => after.has(key)).sort();
		expect.soft(actualCompared, "raw egress compares the governed intersection").toEqual(expectedCompared);
	} else {
		const requiredCompared = expectedChanged.filter((key) => before.has(key) && after.has(key)).sort();
		expect.soft(actualCompared.filter((key) => requiredCompared.includes(key))).toEqual(requiredCompared);
		for (const key of actualCompared) {
			expect
				.soft(
					requiredCompared.includes(key) || allowedUnchangedCandidates.includes(key),
					`unexpected non-egress comparison candidate ${key}`
				)
				.toBe(true);
		}
	}
	expect.soft(new Set(comparisons.map((event) => event.metadata.key)).size).toBe(comparisons.length);
	for (const event of comparisons) {
		expect
			.soft(event.result, `comparison result for ${event.metadata.key}`)
			.toBe(!expectedChanged.includes(event.metadata.key));
		if (
			event.pair.left !== null &&
			event.pair.right !== null &&
			typeof event.pair.left === "object" &&
			typeof event.pair.right === "object"
		) {
			expect.soft(event.pair.left, `baseline ${event.metadata.key} must be detached`).not.toBe(event.pair.right);
		}
	}

	const copied = h.probe.copies
		.filter((copy) => copy.publicationId === publication.publicationId && copy.side === "drp" && copy.image === "post")
		.map((copy) => copy.key)
		.sort();
	expect
		.soft(copied, "only byte-changed present fields are copied")
		.toEqual(expectedChanged.filter((key) => after.has(key)));
	expect.soft(copied).not.toContain("ballastAlpha");
	expect.soft(copied).not.toContain("ballastBeta");
	expect
		.soft(DRPStateOtherTheWire.encode(serializeDRPState(h.states.getDRPState(vertex.hash)!)).finish())
		.toEqual(encodedState(h.rawDRP));
	expect.soft(encodedState(h.states.fromHash(vertex.hash)[0]!)).toEqual(encodedState(h.rawDRP));
	return publication;
}

describe("Phase 1d(i) D.92.5-A real publication", () => {
	it("publishes bytes mutated through a root data descriptor", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.descriptorEscape(91);

		expectPublicationTruth(h, "descriptorEscape", before, ["descriptorPayload"], "required");
	});

	it("bounds Object.keys, spread, assign, and JSON read-only widening", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		const observed = h.applier.drp!.descriptorReadOnly();
		expect(new Set(observed.keys)).toEqual(new Set(Object.keys(h.rawDRP)));
		expect(observed).toMatchObject({ spreadValue: 0, assignedValue: 0, jsonValue: 0 });

		const publication = expectPublicationTruth(h, "descriptorReadOnly", before, [], "required");
		expect(
			h.probe.copies.filter((copy) => copy.publicationId === publication.publicationId),
			"read-only widening must copy neither side"
		).toEqual([]);
	});
});

describe("Phase 1d(i) D.92.5-B Date parity", () => {
	it("wraps a configurable Date reference member or signals conservative egress", () => {
		const shared = { value: 0 };
		const date: DateWithExtra = new Date(0);
		Object.defineProperty(date, "extra", { configurable: true, enumerable: true, value: shared, writable: true });
		const state = { date, alias: shared };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		const member = tracked.proxy.date.extra!;
		expect
			.soft(member !== shared || rawEgress(tracked), "a configurable Date reference must not escape silently")
			.toBe(true);
		member.value = 7;

		expect(byteDeltaKeys(before, state)).toEqual(["alias"]);
		expect.soft(tracked.hasChanges()).toBe(true);
		const trapKeys = [...tracked.changedKeys()].sort();
		if (rawEgress(tracked)) {
			expect.soft([[], ["alias"]], "a conservative implementation may also wrap").toContainEqual(trapKeys);
		} else {
			expect.soft(trapKeys, "wrapping must attribute the separately governed alias").toEqual(["alias"]);
		}
	});

	it("unwraps Date expando assignments and makes later alias mutation observable", () => {
		const shared = { value: 0 };
		const date: DateWithExtra = new Date(0);
		const state = { date, alias: shared };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.date.extra = tracked.proxy.alias;
		expect.soft(date.extra, "raw Date state must never retain a tracker Proxy").toBe(shared);
		expect.soft(byteDeltaKeys(before, state), "Date expandos are not serialized state").toEqual([]);
		const member = tracked.proxy.date.extra!;
		member.value = 8;

		expect(byteDeltaKeys(before, state)).toEqual(["alias"]);
		expect.soft(tracked.hasChanges()).toBe(true);
		expect.soft(member !== shared || rawEgress(tracked)).toBe(true);
	});

	it("preserves frozen Date function SameValue and undefined-getter symmetry", () => {
		const frozenFn = (): string => "same";
		const frozenDate: DateWithExtra = new Date(0);
		Object.defineProperty(frozenDate, "frozenFn", {
			configurable: false,
			value: frozenFn,
			writable: false,
		});
		const frozen = trackMutations({ date: frozenDate });
		let actual: unknown;
		const failure = caught(() => {
			actual = frozen.proxy.date.frozenFn;
		});
		expect.soft(failure, "frozen own functions must not cause a Proxy invariant TypeError").toBeUndefined();
		expect.soft(actual, "the non-writable function must be returned SameValue").toBe(frozenFn);
		expect.soft(rawEgress(frozen)).toBe(true);
		expect.soft([...frozen.changedKeys()]).toEqual([]);

		const undefinedDate: DateWithExtra = new Date(0);
		Object.defineProperty(undefinedDate, "missing", { configurable: false, get: undefined, set: undefined });
		const undefinedGetter = trackMutations({ date: undefinedDate });
		expect(undefinedGetter.proxy.date.missing).toBeUndefined();
		expect.soft(rawEgress(undefinedGetter), "Date must match the other invariant handlers").toBe(true);
		expect.soft([...undefinedGetter.changedKeys()]).toEqual([]);
	});

	it("preserves native Date reads, idempotent setters, and effective setters", () => {
		const state = { date: new Date(1_700_000_000_000) };
		const tracked = trackMutations(state);
		const initial = state.date.getTime();

		expect(tracked.proxy.date.getTime()).toBe(initial);
		expect(tracked.proxy.date.toISOString()).toBe(new Date(initial).toISOString());
		expect(tracked.proxy.date.setTime(initial)).toBe(initial);
		expect(tracked.hasChanges()).toBe(false);
		expect(rawEgress(tracked)).toBe(false);

		expect(tracked.proxy.date.setTime(initial + 1_000)).toBe(initial + 1_000);
		expect(state.date.getTime()).toBe(initial + 1_000);
		expect(tracked.hasChanges()).toBe(true);
		expect([...tracked.changedKeys()]).toEqual(["date"]);
	});

	it("publishes a separately governed alias changed through a Date expando", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.dateExpandoAlias(92);

		expectPublicationTruth(h, "dateExpandoAlias", before, ["dateAlias"], "optional", ["date"]);
	});

	it("detects an operation-created custom Date method that changes timestamp", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		h.applier.drp!.customDateMethod(1_800_000_000_000);

		expectPublicationTruth(h, "customDateMethod", before, ["date"], "optional");
	});

	it("pins that Date expandos and descriptors still do not survive reconstruction", () => {
		const rawDRP = new ProxyClosureFixture();
		const extra = { value: 9 };
		Object.defineProperty(rawDRP.date, "extra", {
			configurable: false,
			enumerable: true,
			value: extra,
			writable: false,
		});
		rawDRP.dateAlias = extra;
		const acl = createACL({ admins: ["local"] });
		const states = new DRPObjectStateManager(acl, rawDRP);

		const reconstructed = states.fromHash(HashGraph.rootHash)[0]!;
		expect(reconstructed.date.getTime()).toBe(rawDRP.date.getTime());
		expect(reconstructed.date.extra).toBeUndefined();
		expect(Reflect.getOwnPropertyDescriptor(reconstructed.date, "extra")).toBeUndefined();
		expect(reconstructed.dateAlias).toEqual(extra);
		expect(reconstructed.dateAlias).not.toBe(extra);
	});
});
