/* eslint-disable import/order -- auth mock must register before object imports */
import { trustedTestVertices } from "./helpers/trusted-vertex-ingest.js";

/* eslint-disable @typescript-eslint/no-non-null-assertion -- authored vertices and stored snapshots are positively narrowed */
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

interface ValueBox {
	value: number;
}

interface AliasCarrier {
	alias?: ValueBox;
	trigger?: number;
	slot?: number;
}

function byteState(value: object): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value as IDRP))).finish();
}

function snapshotBytes(value: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(value)).finish();
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

function caughtIdentity(run: () => void): unknown {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	return caught;
}

describe("Phase 1d(i) D.92.6 native accessor bookkeeping oracle", () => {
	it("does not invoke accessors while defining, assigning through, or deleting their properties", () => {
		let getterCalls = 0;
		let setterCalls = 0;
		const target = {} as { slot?: number };
		Object.defineProperty(target, "slot", {
			configurable: true,
			get(): number {
				getterCalls++;
				return 1;
			},
			set(_value: number) {
				setterCalls++;
			},
		});

		expect(getterCalls, "definition itself does not execute the installed getter").toBe(0);
		target.slot = 2;
		expect({ getterCalls, setterCalls }, "assignment invokes the setter but never reads the getter").toEqual({
			getterCalls: 0,
			setterCalls: 1,
		});
		expect(delete target.slot).toBe(true);
		expect(getterCalls, "deletion does not read the removed accessor").toBe(0);
	});
});

describe("Phase 1d(i) D.92.6 direct ordinary-accessor attribution RED", () => {
	it("stages definition without mutation, then attributes the intended proxy-receiver getter read", () => {
		const state = {
			carrier: {} as AliasCarrier,
			secondary: { value: 0 },
			anchor: { value: 0 },
		};
		const tracked = trackMutations(state);
		Object.defineProperty(tracked.proxy.carrier, "alias", {
			configurable: true,
			value: tracked.proxy.secondary,
			writable: true,
		});
		let getterCalls = 0;
		Object.defineProperty(tracked.proxy.carrier, "trigger", {
			configurable: true,
			get(this: AliasCarrier): number {
				getterCalls++;
				this.alias!.value = 1;
				return this.alias!.value;
			},
		});

		expect.soft(state.secondary.value, "bookkeeping must not invoke the newly installed getter").toBe(0);
		expect.soft(getterCalls).toBe(0);
		expect(tracked.proxy.carrier.trigger).toBe(1);
		tracked.proxy.anchor.value = 1;

		expect.soft(getterCalls, "only the explicit user read invokes the getter").toBe(1);
		expect.soft(state.secondary.value).toBe(1);
		expect.soft([...tracked.changedKeys()].sort()).toEqual(["anchor", "carrier", "secondary"]);
		expect.soft(tracked.hasRawEgress()).toBe(false);
		expect.soft([...tracked.rawEgressCandidateKeys()]).toEqual([]);
	});

	it("invokes only the setter, with the tracked receiver, for ordinary accessor assignment", () => {
		const state = { carrier: {} as AliasCarrier, secondary: { value: 0 } };
		const tracked = trackMutations(state);
		Object.defineProperty(tracked.proxy.carrier, "alias", {
			configurable: true,
			value: tracked.proxy.secondary,
			writable: true,
		});
		let getterCalls = 0;
		let setterCalls = 0;
		Object.defineProperty(tracked.proxy.carrier, "slot", {
			configurable: true,
			get(this: AliasCarrier): number {
				getterCalls++;
				this.alias!.value = -1;
				return this.alias!.value;
			},
			set(this: AliasCarrier, value: number) {
				setterCalls++;
				this.alias!.value = value;
			},
		});

		tracked.proxy.carrier.slot = 7;

		expect.soft({ getterCalls, setterCalls }).toEqual({ getterCalls: 0, setterCalls: 1 });
		expect.soft(state.secondary.value).toBe(7);
		expect.soft([...tracked.changedKeys()].sort()).toEqual(["carrier", "secondary"]);
		expect.soft(tracked.hasRawEgress()).toBe(false);
	});

	it("deletes an accessor without invoking it for a preimage", () => {
		const state = { carrier: {} as AliasCarrier, secondary: { value: 0 } };
		const tracked = trackMutations(state);
		Object.defineProperty(tracked.proxy.carrier, "alias", {
			configurable: true,
			value: tracked.proxy.secondary,
			writable: true,
		});
		let getterCalls = 0;
		Object.defineProperty(tracked.proxy.carrier, "trigger", {
			configurable: true,
			get(this: AliasCarrier): number {
				getterCalls++;
				this.alias!.value = 9;
				return this.alias!.value;
			},
		});

		expect(delete tracked.proxy.carrier.trigger).toBe(true);

		expect.soft(getterCalls).toBe(0);
		expect.soft(state.secondary.value).toBe(0);
		expect.soft([...tracked.changedKeys()]).toEqual(["carrier"]);
		expect.soft(tracked.hasRawEgress()).toBe(false);
	});

	it("preserves an explicit getter throwable after its tracked mutation", () => {
		const failure = new Error("D926 accessor throw");
		const state = { carrier: {} as AliasCarrier, secondary: { value: 0 } };
		const tracked = trackMutations(state);
		Object.defineProperty(tracked.proxy.carrier, "alias", {
			configurable: true,
			value: tracked.proxy.secondary,
			writable: true,
		});
		const definitionCaught = caughtIdentity(() => {
			Object.defineProperty(tracked.proxy.carrier, "trigger", {
				configurable: true,
				get(this: AliasCarrier): never {
					this.alias!.value = 5;
					throw failure;
				},
			});
		});

		const caught = caughtIdentity(() => void tracked.proxy.carrier.trigger);

		expect.soft(definitionCaught, "definition must not execute or throw from the installed getter").toBeUndefined();
		expect.soft(caught).toBe(failure);
		expect.soft(state.secondary.value).toBe(5);
		expect.soft([...tracked.changedKeys()].sort()).toEqual(["carrier", "secondary"]);
		expect.soft(tracked.hasRawEgress()).toBe(false);
	});

	it("keeps clean and context-only accessors outside governed attribution", () => {
		const state = {
			carrier: {} as AliasCarrier,
			context: { local: { value: 0 } },
		};
		const tracked = trackMutations(state);
		Object.defineProperty(tracked.proxy.context, "peek", {
			configurable: true,
			get(): number {
				this.local.value = 1;
				return this.local.value;
			},
		});
		Object.defineProperty(tracked.proxy.carrier, "trigger", {
			configurable: true,
			get(): number {
				return 11;
			},
		});

		expect(tracked.proxy.carrier.trigger).toBe(11);
		expect((tracked.proxy.context as typeof state.context & { peek: number }).peek).toBe(1);
		expect.soft(state.context).toEqual({ local: { value: 1 } });
		expect.soft([...tracked.changedKeys()]).toEqual(["carrier"]);
		expect.soft(tracked.hasRawEgress()).toBe(false);
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

interface OperationObservation {
	afterDefinition: number;
	afterRead: number;
}

class AccessorBookkeepingFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: "excluded" };
	hiddenCarrier: AliasCarrier = {};
	enumerableCarrier: AliasCarrier = { alias: { value: 0 } };
	secondaryHidden = { value: 0 };
	secondaryEnumerable = { value: 0 };
	anchor = { value: 0 };
	ballastAlpha = { stable: "alpha" };
	ballastBeta = { stable: "beta" };

	mutateThroughHiddenAccessor(): OperationObservation {
		Object.defineProperty(this.hiddenCarrier, "alias", {
			configurable: true,
			value: this.secondaryHidden,
			writable: true,
		});
		Object.defineProperty(this.hiddenCarrier, "trigger", {
			configurable: true,
			get(this: AliasCarrier): number {
				this.alias!.value = 1;
				return this.alias!.value;
			},
		});
		const afterDefinition = this.secondaryHidden.value;
		const afterRead = this.hiddenCarrier.trigger!;
		this.anchor.value = 1;
		return { afterDefinition, afterRead };
	}

	mutateThroughEnumerableAlias(): OperationObservation {
		Object.defineProperty(this.enumerableCarrier, "alias", {
			configurable: true,
			enumerable: true,
			value: this.secondaryEnumerable,
			writable: true,
		});
		Object.defineProperty(this.enumerableCarrier, "trigger", {
			configurable: true,
			get(this: AliasCarrier): number {
				this.alias!.value = 2;
				return this.alias!.value;
			},
		});
		const afterDefinition = this.secondaryEnumerable.value;
		const afterRead = this.enumerableCarrier.trigger!;
		this.anchor.value = 2;
		return { afterDefinition, afterRead };
	}
}

interface Harness {
	rawDRP: AccessorBookkeepingFixture;
	applier: DRPVertexApplier<AccessorBookkeepingFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<AccessorBookkeepingFixture>;
}

function harness(peerId: "local" | "remote"): Harness {
	const rawDRP = new AccessorBookkeepingFixture();
	const acl = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph(peerId, acl.resolveConflicts?.bind(acl), undefined, rawDRP.semanticsType);
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
	) => DRPVertexApplier<AccessorBookkeepingFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must author a vertex`).toBeDefined();
	return vertex!;
}

function publicationFor(h: Harness, hash: Hash): PublicationRecord {
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === hash && candidate.outcome === "published"
	);
	expect(publication, "positive control: the accepted vertex must publish").toBeDefined();
	return publication!;
}

function expectPublicationTruth(
	h: Harness,
	vertex: Vertex,
	before: ReadonlyMap<string, Uint8Array>,
	expectedChanged: string[],
	expectedCompared: string[]
): void {
	const publication = publicationFor(h, vertex.hash);
	const live = stateFromDRP(h.rawDRP);
	expect.soft(byteDeltaKeys(before, h.rawDRP), "independent live byte delta").toEqual(expectedChanged);
	expect.soft(publication).toMatchObject({
		mode: "incremental",
		changed: { acl: [], drp: expectedChanged },
		work: {
			acl: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
			drp: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
		},
	});

	const comparisons = h.probe.comparisons
		.filter(
			(event) =>
				event.metadata.publicationId === publication.publicationId &&
				event.metadata.phase === "publisher-capture" &&
				event.metadata.side === "drp"
		)
		.map((event) => event.metadata.key)
		.sort();
	expect.soft(comparisons, "only attributed candidates receive bounded equality work").toEqual(expectedCompared);
	expect.soft(new Set(comparisons).size).toBe(comparisons.length);

	const copies = h.probe.copies
		.filter((copy) => copy.publicationId === publication.publicationId && copy.side === "drp" && copy.image === "post")
		.map((copy) => copy.key)
		.sort();
	expect.soft(copies, "only byte-changed keys are detached").toEqual(expectedChanged);
	expect.soft(copies).not.toContain("ballastAlpha");
	expect.soft(copies).not.toContain("ballastBeta");
	expect.soft(snapshotBytes(h.states.getDRPState(vertex.hash)!)).toEqual(snapshotBytes(live));
	expect.soft(byteState(h.states.fromHash(vertex.hash)[0]!)).toEqual(snapshotBytes(live));
}

describe("Phase 1d(i) D.92.6 real accessor publication RED", () => {
	it("publishes hidden-accessor secondary truth and filters the byte-clean carrier", () => {
		const h = harness("local");
		const before = bytesByKey(h.rawDRP);

		expect.soft(h.applier.drp!.mutateThroughHiddenAccessor()).toEqual({ afterDefinition: 0, afterRead: 1 });

		expect.soft(h.rawDRP.secondaryHidden.value).toBe(1);
		expect.soft(h.rawDRP.anchor.value).toBe(1);
		expectPublicationTruth(
			h,
			vertexFor(h, "mutateThroughHiddenAccessor"),
			before,
			["anchor", "secondaryHidden"],
			["anchor", "hiddenCarrier", "secondaryHidden"]
		);
	});

	it("preserves enumerable-alias truth on exact-cut linear remote replay", async () => {
		const sender = harness("local");
		expect.soft(sender.applier.drp!.mutateThroughEnumerableAlias()).toEqual({ afterDefinition: 0, afterRead: 2 });
		const vertex = vertexFor(sender, "mutateThroughEnumerableAlias");
		const receiver = harness("remote");
		const before = bytesByKey(receiver.rawDRP);

		await expect(receiver.applier.applyVertices(trustedTestVertices([vertex]))).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect.soft(receiver.rawDRP.secondaryEnumerable.value).toBe(2);
		expect.soft(receiver.rawDRP.enumerableCarrier.alias).toBe(receiver.rawDRP.secondaryEnumerable);
		expect.soft(receiver.rawDRP.anchor.value).toBe(2);
		expectPublicationTruth(
			receiver,
			vertex,
			before,
			["anchor", "enumerableCarrier", "secondaryEnumerable"],
			["anchor", "enumerableCarrier", "secondaryEnumerable"]
		);
	});
});
