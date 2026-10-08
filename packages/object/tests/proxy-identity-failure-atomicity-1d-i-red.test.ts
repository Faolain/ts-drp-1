/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices */
import { type Hash, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeValue } from "@ts-drp/utils/serialization";
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

interface CompositeCase {
	name: string;
	make(child: Child): object;
	child(composite: object): Child;
}

interface Attribution {
	canonicalKeys: string[];
	changedKeys: string[];
	hasChanges: boolean;
}

const compositeCases: CompositeCase[] = [
	{
		name: "object",
		make: (child) => ({ child }),
		child: (composite) => (composite as { child: Child }).child,
	},
	{
		name: "Array",
		make: (child) => [child],
		child: (composite) => (composite as Child[])[0]!,
	},
	{
		name: "Map",
		make: (child) => new Map([["child", child]]),
		child: (composite) => (composite as Map<string, Child>).get("child")!,
	},
	{
		name: "Set",
		make: (child) => new Set([child]),
		child: (composite) => [...(composite as Set<Child>)][0]!,
	},
];

function frozenBytes(value: object): Map<string, Uint8Array> {
	return new Map(Object.entries(value).map(([key, entry]) => [key, Uint8Array.from(serializeValue(entry))]));
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = frozenBytes(value);
	const changed: string[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const left = before.get(key);
		const right = after.get(key);
		if (
			left !== undefined &&
			right !== undefined &&
			left.byteLength === right.byteLength &&
			left.every((byte, index) => byte === right[index])
		) {
			continue;
		}
		changed.push(key);
	}
	return changed.sort();
}

function attribution<T extends object>(
	tracked: MutationTrackingResult<T>,
	before: ReadonlyMap<string, Uint8Array>,
	state: T
): Attribution {
	return {
		canonicalKeys: byteDeltaKeys(before, state),
		changedKeys: [...tracked.changedKeys()].sort(),
		hasChanges: tracked.hasChanges(),
	};
}

function proxyDerivedCompositeResult(mechanism: CompositeCase, observeLink: boolean): Attribution[] {
	const b = { value: 0 };
	const state = { a: { link: mechanism.make(b) }, b, untouched: { value: 0 } };
	const before = frozenBytes(state);
	const tracked = trackMutations(state);
	const trackedB = tracked.proxy.b;

	tracked.proxy.a.link = mechanism.make(trackedB);
	const afterRelink = attribution(tracked, before, state);
	if (observeLink) void mechanism.child(tracked.proxy.a.link);
	tracked.proxy.b.value = 1;

	return [afterRelink, attribution(tracked, before, state)];
}

function oneShotThrowingLink(child: Child): { child: Child } {
	let armed = true;
	const link = {} as { child: Child };
	Object.defineProperty(link, "child", {
		configurable: true,
		enumerable: true,
		get: () => {
			if (armed) {
				armed = false;
				throw new Error("one-shot traversal failure");
			}
			return child;
		},
	});
	return link;
}

function repairLink(link: { child: Child }, child: Child): void {
	Object.defineProperty(link, "child", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: child,
	});
}

function recoveredTraversalResult(accessBeforeRelink: boolean): Attribution {
	const state = { owner: { link: null as { child: Child } | null }, untouched: { value: 0 } };
	const before = frozenBytes(state);
	const tracked = trackMutations(state);
	const child = { value: 0 };
	const link = oneShotThrowingLink(child);

	expect(() => {
		tracked.proxy.owner.link = link;
	}).toThrow("one-shot traversal failure");
	repairLink(link, child);

	let held: Child;
	if (accessBeforeRelink) {
		held = tracked.proxy.owner.link!.child;
		tracked.proxy.owner.link = link;
	} else {
		tracked.proxy.owner.link = link;
		held = tracked.proxy.owner.link!.child;
	}
	held.value = 1;

	expect(state.owner.link).toBe(link);
	expect(state.owner.link!.child).toBe(child);
	return attribution(tracked, before, state);
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

class TrackerFailureFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	b = { value: 0 };
	a = { link: { child: { value: 0 } } };
	recovered = { link: null as { child: Child } | null };

	relinkProxyDerivedAndMutate(value: number): void {
		this.a.link = { child: this.b };
		this.b.value = value;
	}

	recoverCaughtTraversalAndMutate(value: number): void {
		const child = { value: 0 };
		const link = oneShotThrowingLink(child);
		try {
			this.recovered.link = link;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "one-shot traversal failure") throw error;
		}
		repairLink(link, child);
		this.recovered.link = link;
		this.recovered.link.child.value = value;
	}

	uncaughtTraversalFailure(): void {
		this.recovered.link = oneShotThrowingLink({ value: 0 });
	}
}

interface Harness {
	rawDRP: TrackerFailureFixture;
	applier: DRPVertexApplier<TrackerFailureFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
}

function harness(): Harness {
	const rawDRP = new TrackerFailureFixture();
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
	) => DRPVertexApplier<TrackerFailureFixture>;
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

describe("Phase 1d(i) proxy-derived composite identity attribution", () => {
	it.each(compositeCases)(
		"charges both canonical owners through a tracked $name value, independent of reads",
		(mechanism) => {
			const expected = [
				{ canonicalKeys: [], changedKeys: [], hasChanges: false },
				{ canonicalKeys: ["a", "b"], changedKeys: ["a", "b"], hasChanges: true },
			];

			expect(proxyDerivedCompositeResult(mechanism, false)).toEqual(expected);
			expect(proxyDerivedCompositeResult(mechanism, true)).toEqual(expected);
		}
	);

	it.each(compositeCases)("does not fork $name aliases into a proxy-of-proxy identity on reread", (mechanism) => {
		const b = { value: 0 };
		const state = { a: { link: mechanism.make(b) }, b };
		const tracked = trackMutations(state);
		const first = tracked.proxy.b;

		tracked.proxy.a.link = mechanism.make(first);

		expect(mechanism.child(tracked.proxy.a.link)).toBe(first);
		expect(tracked.proxy.b).toBe(first);
	});

	it("keeps proxy-derived equal relinks silent until a governed byte changes", () => {
		for (const mechanism of compositeCases) {
			const b = { value: 0 };
			const state = { a: { link: mechanism.make(b) }, b, untouched: { value: 0 } };
			const before = frozenBytes(state);
			const tracked = trackMutations(state);

			tracked.proxy.a.link = mechanism.make(tracked.proxy.b);

			expect(attribution(tracked, before, state), mechanism.name).toEqual({
				canonicalKeys: [],
				changedKeys: [],
				hasChanges: false,
			});
		}
	});

	it("keeps a detached proxy-derived alias silent while retaining the current owner", () => {
		for (const mechanism of compositeCases) {
			const b = { value: 0 };
			const state = { a: { link: mechanism.make(b) }, b, untouched: { value: 0 } };
			const before = frozenBytes(state);
			const tracked = trackMutations(state);
			const held = tracked.proxy.b;

			tracked.proxy.a.link = mechanism.make(held);
			tracked.proxy.a.link = mechanism.make({ value: 0 });
			held.value = 1;

			expect(attribution(tracked, before, state), mechanism.name).toEqual({
				canonicalKeys: ["b"],
				changedKeys: ["b"],
				hasChanges: true,
			});
		}
	});

	it("exposes exact tracker keys through an ordinary local DRP operation", () => {
		const h = harness();

		h.applier.drp!.relinkProxyDerivedAndMutate(1);

		expect(publicationFor(h, "relinkProxyDerivedAndMutate").changed.drp).toEqual(["a", "b"]);
		expect(h.rawDRP.a.link.child).toBe(h.rawDRP.b);
		expect(h.rawDRP.b.value).toBe(1);
	});
});

describe("Phase 1d(i) graph-initialization failure atomicity", () => {
	it("retries a repaired traversal without access-order-dependent attribution", () => {
		const expected = { canonicalKeys: ["owner"], changedKeys: ["owner"], hasChanges: true };
		const accessAfterRelink = recoveredTraversalResult(false);
		const accessBeforeRelink = recoveredTraversalResult(true);

		expect(accessAfterRelink).toEqual(accessBeforeRelink);
		expect(accessAfterRelink).toEqual(expected);
	});

	it("authors a caught, repaired, and valid final blueprint state", () => {
		const h = harness();

		h.applier.drp!.recoverCaughtTraversalAndMutate(7);

		expect(publicationFor(h, "recoverCaughtTraversalAndMutate").changed.drp).toEqual(["recovered"]);
		expect(h.rawDRP.recovered.link?.child.value).toBe(7);
	});

	it("tracks the same valid final graph when initialization does not fail", () => {
		const state = { owner: { link: null as { child: Child } | null }, untouched: { value: 0 } };
		const before = frozenBytes(state);
		const tracked = trackMutations(state);
		const child = { value: 0 };

		tracked.proxy.owner.link = { child };
		tracked.proxy.owner.link.child.value = 1;

		expect(attribution(tracked, before, state)).toEqual({
			canonicalKeys: ["owner"],
			changedKeys: ["owner"],
			hasChanges: true,
		});
	});

	it("aborts an uncaught traversal failure without claiming a successful state", () => {
		const h = harness();

		expect(() => h.applier.drp!.uncaughtTraversalFailure()).toThrow("one-shot traversal failure");
		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.probe.publications).toEqual([]);
		expect(h.rawDRP.recovered.link).toBeNull();
	});
});
