/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices */
import { type Hash, type IDRP, SemanticsType } from "@ts-drp/types";
import { cloneDeep } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { type MutationTrackingResult, trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager } from "../src/state.js";

interface Child {
	value: number;
}

interface Link {
	child: Child;
}

class ReplacingMap extends Map<string, Child | Link> {
	replace(next: Link): void {
		Map.prototype.set.call(this, "entry", next);
	}
}

class ReplacingSet extends Set<Child | Link> {
	replace(next: Link): void {
		const previous = Set.prototype.values.call(this).next().value as Child | Link | undefined;
		if (previous !== undefined) Set.prototype.delete.call(this, previous);
		Set.prototype.add.call(this, next);
	}
}

type MapWithReplace = Map<string, Child | Link> & { replace(next: Link): void };

function installMapReplace(map: Map<string, Child | Link>): MapWithReplace {
	const surface = map as MapWithReplace;
	surface.replace = function (this: Map<string, Child | Link>, next: Link): void {
		Map.prototype.set.call(this, "entry", next);
	};
	return surface;
}

function oneShotThrowingLink(child: Child): Link {
	let armed = true;
	const link = {} as Link;
	Object.defineProperty(link, "child", {
		configurable: true,
		enumerable: true,
		get: () => {
			if (armed) {
				armed = false;
				throw new Error("one-shot collection traversal failure");
			}
			return child;
		},
	});
	return link;
}

function repairLink(link: Link, child: Child): void {
	Object.defineProperty(link, "child", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: child,
	});
}

interface MapFailureState {
	m: ReplacingMap;
	n: ReplacingMap;
	alias: Child;
}

interface MapFailureScenario {
	oldChild: Child;
	newChild: Child;
	toxic: Link;
	state: MapFailureState;
	tracked: MutationTrackingResult<MapFailureState>;
	invoke(): void;
	repair(): void;
	relinkSecondOwner(): void;
	readNewChild(): Child;
}

function mapFailureScenario(): MapFailureScenario {
	const oldChild = { value: 0 };
	const newChild = { value: 9 };
	const toxic = oneShotThrowingLink(newChild);
	const state = {
		m: new ReplacingMap([["entry", oldChild]]),
		n: new ReplacingMap([["entry", { child: { value: 9 } }]]),
		alias: oldChild,
	};
	const tracked = trackMutations(state);

	return {
		oldChild,
		newChild,
		toxic,
		state,
		tracked,
		invoke: (): void => tracked.proxy.m.replace(toxic),
		repair: (): void => repairLink(toxic, newChild),
		relinkSecondOwner: (): void => {
			tracked.proxy.n = state.m;
		},
		readNewChild: (): Child => (tracked.proxy.n.get("entry") as Link).child,
	};
}

interface SetFailureState {
	s: ReplacingSet;
	n: ReplacingSet;
	alias: Child;
}

interface SetFailureScenario {
	oldChild: Child;
	newChild: Child;
	toxic: Link;
	state: SetFailureState;
	tracked: MutationTrackingResult<SetFailureState>;
	invoke(): void;
	repair(): void;
	relinkSecondOwner(): void;
	readNewChild(): Child;
}

function setFailureScenario(): SetFailureScenario {
	const oldChild = { value: 0 };
	const newChild = { value: 9 };
	const toxic = oneShotThrowingLink(newChild);
	const state = {
		s: new ReplacingSet([oldChild]),
		n: new ReplacingSet([{ child: { value: 9 } }]),
		alias: oldChild,
	};
	const tracked = trackMutations(state);

	return {
		oldChild,
		newChild,
		toxic,
		state,
		tracked,
		invoke: (): void => tracked.proxy.s.replace(toxic),
		repair: (): void => repairLink(toxic, newChild),
		relinkSecondOwner: (): void => {
			tracked.proxy.n = state.s;
		},
		readNewChild: (): Child => ([...tracked.proxy.n][0] as Link).child,
	};
}

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

class CollectionFailureFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	m = new Map<string, Child | Link>([["entry", { value: 0 }]]);

	caughtMapReplacement(value: number): void {
		const child = { value };
		const toxic = oneShotThrowingLink(child);
		const surface = installMapReplace(this.m);
		try {
			surface.replace(toxic);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "one-shot collection traversal failure") throw error;
		}
		repairLink(toxic, child);
		delete (surface as Partial<MapWithReplace>).replace;
	}

	successfulMapReplacement(value: number): void {
		const surface = installMapReplace(this.m);
		surface.replace({ child: { value } });
		delete (surface as Partial<MapWithReplace>).replace;
	}

	uncaughtMapReplacement(value: number): void {
		const surface = installMapReplace(this.m);
		try {
			surface.replace(oneShotThrowingLink({ value }));
		} finally {
			delete (surface as Partial<MapWithReplace>).replace;
		}
	}
}

interface Harness {
	rawDRP: CollectionFailureFixture;
	applier: DRPVertexApplier<CollectionFailureFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
}

function harness(): Harness {
	const rawDRP = new CollectionFailureFixture();
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
	) => DRPVertexApplier<CollectionFailureFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe };
}

function publicationFor(h: Harness, opType: string): PublicationRecord {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must author a vertex`).toBeDefined();
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex!.hash
	);
	expect(publication, `positive control: ${opType} must publish`).toBeDefined();
	return publication!;
}

describe("Phase 1d(i) custom Map reconciliation failure atomicity", () => {
	it("charges a physical replacement even when new-subtree discovery throws", () => {
		const scenario = mapFailureScenario();

		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();

		expect(scenario.state.m.get("entry")).toBe(scenario.toxic);
		expect([...scenario.tracked.changedKeys()].sort()).toEqual(["m"]);
		expect(scenario.tracked.hasChanges()).toBe(true);
	});

	it("removes the old entry parent before a caught reconciliation failure", () => {
		const scenario = mapFailureScenario();
		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();
		scenario.relinkSecondOwner();
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);

		scenario.tracked.proxy.alias.value = 1;

		expect(scenario.oldChild.value).toBe(1);
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);
	});

	it("attaches the recovered new descendant to a silently relinked owner", () => {
		const scenario = mapFailureScenario();
		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();
		scenario.relinkSecondOwner();
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);

		scenario.readNewChild().value = 10;

		expect(scenario.newChild.value).toBe(10);
		expect([...scenario.tracked.changedKeys()].sort()).toEqual(["m", "n"]);
	});

	it("keeps successful custom-method parent reconciliation as a positive control", () => {
		const oldChild = { value: 0 };
		const newChild = { value: 9 };
		const next = { child: newChild };
		const state = {
			m: new ReplacingMap([["entry", oldChild]]),
			n: new ReplacingMap([["entry", { child: { value: 9 } }]]),
			alias: oldChild,
		};
		const tracked = trackMutations(state);

		tracked.proxy.m.replace(next);
		tracked.proxy.n = state.m;
		expect([...tracked.changedKeys()].sort()).toEqual(["m"]);

		(tracked.proxy.n.get("entry") as Link).child.value = 10;
		tracked.proxy.alias.value = 1;

		expect([...tracked.changedKeys()].sort()).toEqual(["alias", "m", "n"]);
	});
});

describe("Phase 1d(i) custom Set reconciliation failure atomicity", () => {
	it("charges a physical replacement even when new-subtree discovery throws", () => {
		const scenario = setFailureScenario();

		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();

		expect(scenario.state.s.has(scenario.toxic)).toBe(true);
		expect(scenario.state.s.has(scenario.oldChild)).toBe(false);
		expect([...scenario.tracked.changedKeys()].sort()).toEqual(["s"]);
		expect(scenario.tracked.hasChanges()).toBe(true);
	});

	it("removes the old entry parent before a caught reconciliation failure", () => {
		const scenario = setFailureScenario();
		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();
		scenario.relinkSecondOwner();
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);

		scenario.tracked.proxy.alias.value = 1;

		expect(scenario.oldChild.value).toBe(1);
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);
	});

	it("attaches the recovered new descendant to a silently relinked owner", () => {
		const scenario = setFailureScenario();
		expect(scenario.invoke).toThrow("one-shot collection traversal failure");
		scenario.repair();
		scenario.relinkSecondOwner();
		expect(scenario.tracked.changedKeys().has("n")).toBe(false);

		scenario.readNewChild().value = 10;

		expect(scenario.newChild.value).toBe(10);
		expect([...scenario.tracked.changedKeys()].sort()).toEqual(["n", "s"]);
	});

	it("keeps successful custom-method parent reconciliation as a positive control", () => {
		const oldChild = { value: 0 };
		const newChild = { value: 9 };
		const next = { child: newChild };
		const state = {
			s: new ReplacingSet([oldChild]),
			n: new ReplacingSet([{ child: { value: 9 } }]),
			alias: oldChild,
		};
		const tracked = trackMutations(state);

		tracked.proxy.s.replace(next);
		tracked.proxy.n = state.s;
		expect([...tracked.changedKeys()].sort()).toEqual(["s"]);

		([...tracked.proxy.n][0] as Link).child.value = 10;
		tracked.proxy.alias.value = 1;

		expect([...tracked.changedKeys()].sort()).toEqual(["alias", "n", "s"]);
	});
});

describe("Phase 1d(i) collection reconciliation operation controls", () => {
	it("publishes a caught failure whose repaired final Map state is valid", () => {
		const h = harness();

		h.applier.drp!.caughtMapReplacement(7);

		expect(publicationFor(h, "caughtMapReplacement").changed.drp).toEqual(["m"]);
		expect((h.rawDRP.m.get("entry") as Link).child.value).toBe(7);
	});

	it("publishes the equivalent successful custom Map replacement", () => {
		const h = harness();

		h.applier.drp!.successfulMapReplacement(7);

		expect(publicationFor(h, "successfulMapReplacement").changed.drp).toEqual(["m"]);
		expect((h.rawDRP.m.get("entry") as Link).child.value).toBe(7);
	});

	it("aborts an uncaught reconciliation failure without publishing partial state", () => {
		const h = harness();

		expect(() => h.applier.drp!.uncaughtMapReplacement(7)).toThrow("one-shot collection traversal failure");

		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.probe.publications).toEqual([]);
		expect(h.rawDRP.m.get("entry")).toEqual({ value: 0 });
	});
});
