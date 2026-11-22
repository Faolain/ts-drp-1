/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required vertices and snapshots */
import { type DRPState, DRPStateOtherTheWire, type Hash, type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
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

interface AccessorDate extends Date {
	ownPrimitive?: number;
	prototypeCallable?(): string;
	stable?: number;
	throwing?: never;
	jump?: number;
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

function defineTimestampGetter(date: Date, property: PropertyKey, timestamp: number, result: unknown): void {
	Object.defineProperty(date, property, {
		configurable: true,
		get(this: Date): unknown {
			Date.prototype.setTime.call(this, timestamp);
			return result;
		},
	});
}

describe("Phase 1d(i) D.92.5-C Date accessor resolution tracking", () => {
	it("attributes an own configurable primitive getter before returning its value", () => {
		const date = new Date(10) as AccessorDate;
		defineTimestampGetter(date, "ownPrimitive", 20, 7);
		const tracked = trackMutations({ date });

		expect(tracked.proxy.date.ownPrimitive).toBe(7);
		expect.soft(date.getTime(), "the getter really committed the timestamp").toBe(20);
		expect.soft(tracked.hasChanges()).toBe(true);
		expect.soft([...tracked.changedKeys()]).toEqual(["date"]);
	});

	it("attributes a prototype configurable callable getter before any delayed wrapper runs", () => {
		const returned = (): string => "not-invoked";
		class PrototypeAccessorDate extends Date {
			get prototypeCallable(): () => string {
				Date.prototype.setTime.call(this, 30);
				return returned;
			}
		}
		const date = new PrototypeAccessorDate(10);
		const descriptor = Reflect.getOwnPropertyDescriptor(PrototypeAccessorDate.prototype, "prototypeCallable");
		expect(descriptor?.configurable).toBe(true);
		const tracked = trackMutations({ date });

		const callable = tracked.proxy.date.prototypeCallable;
		expect(typeof callable).toBe("function");
		expect.soft(date.getTime(), "property resolution itself committed the timestamp").toBe(30);
		expect.soft(tracked.hasChanges(), "attribution cannot wait for the returned function").toBe(true);
		expect.soft([...tracked.changedKeys()]).toEqual(["date"]);
	});

	it("keeps an idempotent accessor read clean", () => {
		const date = new Date(40) as AccessorDate;
		defineTimestampGetter(date, "stable", 40, 11);
		const tracked = trackMutations({ date });

		expect(tracked.proxy.date.stable).toBe(11);
		expect(date.getTime()).toBe(40);
		expect(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasRawEgress()).toBe(false);
	});

	it("preserves a getter throw exactly while attributing its committed timestamp", () => {
		const date = new Date(50) as AccessorDate;
		const failure = Object.freeze({ code: "date-accessor-primary" });
		Object.defineProperty(date, "throwing", {
			configurable: true,
			get(this: Date): never {
				Date.prototype.setTime.call(this, 60);
				throw failure;
			},
		});
		const tracked = trackMutations({ date });

		expect(caught(() => tracked.proxy.date.throwing)).toBe(failure);
		expect.soft(date.getTime(), "the throwing getter committed before failing").toBe(60);
		expect.soft(tracked.hasChanges()).toBe(true);
		expect.soft([...tracked.changedKeys()]).toEqual(["date"]);
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

class DateAccessorPublicationFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: true };
	date: AccessorDate = new Date(100);
	secondary = { value: 0 };
	ballastAlpha = { stable: "alpha" };
	ballastBeta = { stable: "beta" };

	accessorThenWrite(timestamp: number, value: number): number {
		defineTimestampGetter(this.date, "jump", timestamp, 17);
		try {
			const observed = this.date.jump!;
			this.secondary.value = value;
			return observed;
		} finally {
			Reflect.deleteProperty(this.date, "jump");
		}
	}

	idempotentAccessorRead(): number {
		defineTimestampGetter(this.date, "jump", this.date.getTime(), 19);
		try {
			return this.date.jump!;
		} finally {
			Reflect.deleteProperty(this.date, "jump");
		}
	}
}

interface Harness {
	rawDRP: DateAccessorPublicationFixture;
	applier: DRPVertexApplier<DateAccessorPublicationFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<DateAccessorPublicationFixture>;
}

function harness(): Harness {
	const rawDRP = new DateAccessorPublicationFixture();
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
	) => DRPVertexApplier<DateAccessorPublicationFixture>;
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

describe("Phase 1d(i) D.92.5-C Date accessor publication", () => {
	it("publishes an accessor timestamp alongside a second governed write with bounded work", () => {
		const h = harness();

		expect(h.applier.drp!.accessorThenWrite(200, 1)).toBe(17);

		const vertex = vertexFor(h, "accessorThenWrite");
		const publication = publicationFor(h, vertex.hash);
		expect.soft(h.rawDRP.date.getTime()).toBe(200);
		expect.soft(h.rawDRP.secondary.value).toBe(1);
		expect.soft(publication).toMatchObject({
			mode: "incremental",
			changed: { acl: [], drp: ["date", "secondary"] },
			work: {
				acl: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
				drp: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
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
		expect.soft(compared, "only the two attributed governed keys are compared").toEqual(["date", "secondary"]);
		const copied = h.probe.copies
			.filter(
				(copy) => copy.publicationId === publication.publicationId && copy.side === "drp" && copy.image === "post"
			)
			.map((copy) => copy.key)
			.sort();
		expect.soft(copied).toEqual(["date", "secondary"]);
		expect.soft(copied).not.toContain("ballastAlpha");
		expect.soft(copied).not.toContain("ballastBeta");
		expect.soft(encodedSnapshot(h.states.getDRPState(vertex.hash)!)).toEqual(encodedState(h.rawDRP));
		expect.soft(encodedState(h.states.fromHash(vertex.hash)[0]!)).toEqual(encodedState(h.rawDRP));
	});

	it("does not author or publish an idempotent accessor-only operation", () => {
		const h = harness();

		expect(h.applier.drp!.idempotentAccessorRead()).toBe(19);

		expect(h.rawDRP.date.getTime()).toBe(100);
		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.probe.publications).toEqual([]);
		expect(h.probe.copies).toEqual([]);
	});
});
