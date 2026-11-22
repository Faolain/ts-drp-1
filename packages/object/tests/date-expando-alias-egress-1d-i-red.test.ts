/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow authored vertices and snapshots */
import { type DRPState, DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { type ComparisonEvent } from "../src/publication/copy-capability.js";
import { type PublicationObserverEvent, type PublicationRecord } from "../src/publication/publisher.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface Child {
	value: number;
}

interface AliasDate extends Date {
	holder?: Child;
	peek?: number;
	marker?: number;
}

class InheritedAliasDate extends Date {
	holder?: Child;

	get inheritedPeek(): number {
		if (!this.holder) throw new Error("Date holder missing");
		this.holder.value = 77;
		Date.prototype.setTime.call(this, 300);
		return this.holder.value;
	}
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

describe("Phase 1d(i) D.92.5-D Date expando alias candidacy", () => {
	it("widens when assignment unwraps a governed alias before an own accessor mutates it", () => {
		const date: AliasDate = new Date(100);
		const state = { date, alias: { value: 0 } };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.date.holder = tracked.proxy.alias;
		Object.defineProperty(tracked.proxy.date, "peek", {
			configurable: true,
			get(this: AliasDate): number {
				if (!this.holder) throw new Error("Date holder missing");
				this.holder.value = 41;
				return this.holder.value;
			},
		});
		expect(tracked.proxy.date.peek).toBe(41);

		expect
			.soft(date.holder, "the Date handler stores the governed raw target, never its tracking Proxy")
			.toBe(state.alias);
		expect.soft(date.getTime(), "the alias-only accessor leaves serialized Date bytes unchanged").toBe(100);
		expect.soft(byteDeltaKeys(before, state)).toEqual(["alias"]);
		expect.soft(tracked.hasRawEgress(), "the handler-created raw alias must widen candidacy").toBe(true);
		expect.soft(tracked.hasChanges(), "raw-egress candidacy keeps the operation publication-eligible").toBe(true);
		expect.soft([...tracked.changedKeys()], "the raw alias write is recovered by the publisher union").toEqual([]);
		expect.soft(new Set(tracked.rawEgressCandidateKeys())).toEqual(new Set(["alias", "date"]));
	});

	it("widens defineProperty before an inherited accessor changes both timestamp and alias", () => {
		const date = new InheritedAliasDate(100);
		const state = { date, alias: { value: 0 } };
		const before = frozenBytesByKey(state);
		const tracked = trackMutations(state);

		Object.defineProperty(tracked.proxy.date, "holder", {
			configurable: true,
			value: tracked.proxy.alias,
			writable: true,
		});
		expect(tracked.proxy.date.inheritedPeek).toBe(77);

		expect.soft(date.holder).toBe(state.alias);
		expect.soft(date.getTime()).toBe(300);
		expect.soft(byteDeltaKeys(before, state)).toEqual(["alias", "date"]);
		expect.soft(tracked.hasRawEgress(), "defineProperty has the same raw-reference ownership boundary").toBe(true);
		expect.soft(tracked.hasChanges()).toBe(true);
		expect.soft([...tracked.changedKeys()], "timestamp attribution remains exact alongside egress").toEqual(["date"]);
		expect.soft(new Set(tracked.rawEgressCandidateKeys())).toEqual(new Set(["alias", "date"]));
	});

	it("keeps primitive expandos and idempotent native Date work clean", () => {
		const date: AliasDate = new Date(100);
		const tracked = trackMutations({ date, alias: { value: 0 } });

		tracked.proxy.date.marker = 7;
		expect(tracked.proxy.date.marker).toBe(7);
		expect(tracked.proxy.date.setTime(100)).toBe(100);
		Reflect.deleteProperty(tracked.proxy.date, "marker");

		expect(date.getTime()).toBe(100);
		expect(tracked.hasRawEgress()).toBe(false);
		expect(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect([...tracked.rawEgressCandidateKeys()]).toEqual([]);
	});
});

type SnapshotSide = "acl" | "drp";

interface CopyEvent {
	publicationId: string;
	side: SnapshotSide;
	key: string;
	image: "pre" | "post";
}

class PublicationProbe {
	readonly comparisons: ComparisonEvent[] = [];
	readonly copies: CopyEvent[] = [];
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
			work: event.record.work ? { acl: { ...event.record.work.acl }, drp: { ...event.record.work.drp } } : undefined,
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

class DateExpandoPublicationFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: true };
	date: AliasDate = new InheritedAliasDate(100);
	alias = { value: 0 };
	trigger = { value: 0 };
	ballastAlpha = { stable: "alpha" };
	ballastBeta = { stable: "beta" };

	assignThenOwnAccessor(): number {
		this.date.holder = this.alias;
		Object.defineProperty(this.date, "peek", {
			configurable: true,
			get(this: AliasDate): number {
				if (!this.holder) throw new Error("Date holder missing");
				this.holder.value = 51;
				return this.holder.value;
			},
		});
		try {
			const observed = this.date.peek!;
			this.trigger.value = 1;
			return observed;
		} finally {
			Reflect.deleteProperty(this.date, "peek");
			Reflect.deleteProperty(this.date, "holder");
		}
	}

	defineThenTimestampAccessor(): number {
		Object.defineProperty(this.date, "holder", {
			configurable: true,
			value: this.alias,
			writable: true,
		});
		Object.defineProperty(this.date, "peek", {
			configurable: true,
			get(this: AliasDate): number {
				if (!this.holder) throw new Error("Date holder missing");
				this.holder.value = 77;
				Date.prototype.setTime.call(this, 300);
				return this.holder.value;
			},
		});
		try {
			const observed = this.date.peek!;
			this.trigger.value = 2;
			return observed;
		} finally {
			Reflect.deleteProperty(this.date, "peek");
			Reflect.deleteProperty(this.date, "holder");
		}
	}

	primitiveIdempotentControl(): number {
		this.date.marker = 9;
		try {
			const observed = this.date.marker;
			this.date.setTime(this.date.getTime());
			return observed;
		} finally {
			Reflect.deleteProperty(this.date, "marker");
		}
	}
}

interface Harness {
	rawDRP: DateExpandoPublicationFixture;
	applier: DRPVertexApplier<DateExpandoPublicationFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<DateExpandoPublicationFixture>;
}

function harness(): Harness {
	const rawDRP = new DateExpandoPublicationFixture();
	const acl = createACL({ admins: ["local"] });
	const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, rawDRP.semanticsType);
	const states = new DRPObjectStateManager(acl, rawDRP);
	const probe = new PublicationProbe();
	const options = {
		drp: rawDRP,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
		comparisonObserver: probe.observeComparison.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<DateExpandoPublicationFixture>;
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

function encodedSnapshot(value: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(value)).finish();
}

function expectPublicationTruth(
	h: Harness,
	opType: string,
	before: ReadonlyMap<string, Uint8Array>,
	expectedChanged: string[]
): void {
	const vertex = vertexFor(h, opType);
	const publication = publicationFor(h, vertex.hash);
	const after = frozenBytesByKey(h.rawDRP);
	const governedUnion = new Set([...before.keys(), ...after.keys()]);

	expect.soft(byteDeltaKeys(before, h.rawDRP), "independent live byte truth").toEqual(expectedChanged);
	expect.soft(publication).toMatchObject({
		mode: "incremental",
		changed: { acl: [], drp: expectedChanged },
		work: {
			acl: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
			drp: { egressWidenings: 1, comparedKeys: governedUnion.size, comparisonPasses: 1 },
		},
	});

	const compared = h.probe.comparisons
		.filter(
			(event) =>
				event.metadata.publicationId === publication.publicationId &&
				event.metadata.phase === "publisher-capture" &&
				event.metadata.side === "drp"
		)
		.map((event) => event.metadata.key)
		.sort();
	expect.soft(compared).toEqual([...before.keys()].filter((key) => after.has(key)).sort());
	expect.soft(new Set(compared).size, "the all-governed union is compared exactly once").toBe(compared.length);

	const copied = h.probe.copies
		.filter((copy) => copy.publicationId === publication.publicationId && copy.side === "drp" && copy.image === "post")
		.map((copy) => copy.key)
		.sort();
	expect.soft(copied, "only byte-changed governed keys are detached").toEqual(expectedChanged);
	expect.soft(copied).not.toContain("ballastAlpha");
	expect.soft(copied).not.toContain("ballastBeta");
	expect.soft(encodedSnapshot(h.states.getDRPState(vertex.hash)!)).toEqual(encodedState(h.rawDRP));
	expect.soft(encodedState(h.states.fromHash(vertex.hash)[0]!)).toEqual(encodedState(h.rawDRP));
}

describe("Phase 1d(i) D.92.5-D Date expando alias publication", () => {
	it("publishes alias bytes changed by an own accessor after handler assignment", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		expect(h.applier.drp!.assignThenOwnAccessor()).toBe(51);

		expect.soft(h.rawDRP.date.getTime()).toBe(100);
		expect.soft(h.rawDRP.alias.value).toBe(51);
		expectPublicationTruth(h, "assignThenOwnAccessor", before, ["alias", "trigger"]);
	});

	it("publishes Date and alias bytes changed after handler defineProperty", () => {
		const h = harness();
		const before = frozenBytesByKey(h.rawDRP);

		expect(h.applier.drp!.defineThenTimestampAccessor()).toBe(77);

		expect.soft(h.rawDRP.date.getTime()).toBe(300);
		expect.soft(h.rawDRP.alias.value).toBe(77);
		expectPublicationTruth(h, "defineThenTimestampAccessor", before, ["alias", "date", "trigger"]);
	});

	it("does not author a vertex for primitive expando and idempotent native work", () => {
		const h = harness();

		expect(h.applier.drp!.primitiveIdempotentControl()).toBe(9);

		expect(h.rawDRP.date.getTime()).toBe(100);
		expect(h.rawDRP.alias.value).toBe(0);
		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.probe.publications).toEqual([]);
		expect(h.probe.copies).toEqual([]);
	});
});
