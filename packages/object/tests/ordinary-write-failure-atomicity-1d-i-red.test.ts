/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices and snapshots */
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
	value: number;
}

interface Link {
	child: Child;
}

function oneShotThrowingLink(thrown: unknown, child: Child = { value: 7 }): Link {
	let armed = true;
	const link = {} as Link;
	Object.defineProperty(link, "child", {
		configurable: true,
		enumerable: true,
		get: () => {
			if (armed) {
				armed = false;
				throw thrown;
			}
			return child;
		},
	});
	return link;
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

function expectCommittedAndCharged<T extends object>(
	tracked: MutationTrackingResult<T>,
	physicalValue: unknown,
	toxic: Link,
	owner: string
): void {
	expect(physicalValue, "the already-executed ordinary write must survive discovery failure").toBe(toxic);
	expect([...tracked.changedKeys()].sort(), "the physical write must charge its owning top-level key").toEqual([owner]);
	expect(tracked.hasChanges()).toBe(true);
}

const ordinarySetPreimages: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
	["null", (): Record<string, unknown> => ({ link: null })],
	["undefined", (): Record<string, unknown> => ({ link: undefined })],
	["absent", (): Record<string, unknown> => ({})],
	["an existing object", (): Record<string, unknown> => ({ link: { child: { value: -1 } } })],
];

// Contract: once an ordinary reflection write has physically committed, a later
// discovery failure does not roll it back; it must conservatively charge the
// owner, matching the accepted custom collection reconciliation behavior.
describe("Phase 1d(i) ordinary set failure capture", () => {
	it.each(ordinarySetPreimages)("preserves and charges a set over %s", (_name, initialOwner) => {
		const state = { owner: initialOwner(), untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot ordinary set traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => {
			tracked.proxy.owner.link = toxic;
		});

		expect(caught, "the caller must receive and may swallow the exact traversal Error").toBe(failure);
		expectCommittedAndCharged(tracked, state.owner.link, toxic, "owner");
		expect(tracked.changedKeys().has("untouched")).toBe(false);
	});

	it("preserves a swallowed non-Error throw by identity and still charges the physical write", () => {
		const state = { owner: { link: null as Link | null }, untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = Object.freeze({ code: "NON_ERROR_TRAVERSAL_FAILURE" });
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => {
			tracked.proxy.owner.link = toxic;
		});

		expect(caught, "non-Error traversal values must propagate without wrapping").toBe(failure);
		expectCommittedAndCharged(tracked, state.owner.link, toxic, "owner");
	});
});

describe("Phase 1d(i) ordinary defineProperty and Array failure capture", () => {
	it("preserves and charges a defineProperty value committed before discovery fails", () => {
		const state = { owner: { link: null as Link | null }, untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot defineProperty traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => {
			Object.defineProperty(tracked.proxy.owner, "link", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: toxic,
			});
		});

		expect(caught).toBe(failure);
		expectCommittedAndCharged(tracked, state.owner.link, toxic, "owner");
	});

	it("preserves and charges a direct Array index write committed before discovery fails", () => {
		const state = { items: [null] as Array<Link | null>, untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot Array index traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => {
			tracked.proxy.items[0] = toxic;
		});

		expect(caught).toBe(failure);
		expectCommittedAndCharged(tracked, state.items[0], toxic, "items");
	});

	it("preserves and charges an Array push element committed before discovery fails", () => {
		const state = { items: [] as Link[], untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot Array push traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => {
			tracked.proxy.items.push(toxic);
		});

		expect(caught).toBe(failure);
		expect(state.items).toHaveLength(1);
		expectCommittedAndCharged(tracked, state.items[0], toxic, "items");
	});
});

describe("Phase 1d(i) discover-before-mutation collection controls", () => {
	it("does not physically commit or dirty a governed Map.set whose discovery fails", () => {
		const state = { governed: new Map<string, Link>(), untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot governed Map traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => tracked.proxy.governed.set("entry", toxic));

		expect(caught).toBe(failure);
		expect(state.governed.has("entry")).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
	});

	it("does not physically commit or dirty a governed Set.add whose discovery fails", () => {
		const state = { governed: new Set<Link>(), untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const failure = new Error("one-shot governed Set traversal failure");
		const toxic = oneShotThrowingLink(failure);

		const caught = caughtIdentity(() => tracked.proxy.governed.add(toxic));

		expect(caught).toBe(failure);
		expect(state.governed.has(toxic)).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
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

class OrdinaryFailureFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	a = { link: null as Link | null };
	b = { value: 0 };
	ballast = { stable: "unchanged" };

	swallowAThenMutateB(value: number): void {
		const failure = new Error("one-shot operation traversal failure");
		const toxic = oneShotThrowingLink(failure, { value });
		const caught = caughtIdentity(() => {
			this.a.link = toxic;
		});
		if (caught !== failure) throw caught;
		this.b.value = value;
	}
}

interface Harness {
	applier: DRPVertexApplier<OrdinaryFailureFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<OrdinaryFailureFixture>;
}

function harness(): Harness {
	const drp = new OrdinaryFailureFixture();
	const acl = createACL({ admins: ["local"] });
	const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
	const states = new DRPObjectStateManager(acl, drp);
	const probe = new PublicationProbe();
	const options = {
		drp,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<OrdinaryFailureFixture>;
	return { applier: new Applier(options), hashGraph, probe, states };
}

function encodedState(state: ReturnType<typeof stateFromDRP>): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

function equalBytes(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function byteDeltaKeys(before: ReturnType<typeof stateFromDRP>, after: ReturnType<typeof stateFromDRP>): string[] {
	const beforeByKey = new Map(before.state.map(({ key, value }) => [key, value]));
	const afterByKey = new Map(after.state.map(({ key, value }) => [key, value]));
	return [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
		.filter(
			(key) => beforeByKey.has(key) !== afterByKey.has(key) || !equalBytes(beforeByKey.get(key), afterByKey.get(key))
		)
		.sort();
}

describe("Phase 1d(i) swallowed ordinary traversal failure publication", () => {
	it("publishes the full executed byte delta and stores a byte-exact reconstruction", () => {
		const h = harness();
		const baseline = h.states.getDRPState(HashGraph.rootHash)!;

		h.applier.drp!.swallowAThenMutateB(11);

		const vertex = h.hashGraph
			.getAllVertices()
			.find((candidate) => candidate.operation?.opType === "swallowAThenMutateB");
		expect(vertex, "positive control: swallowing the traversal failure must still author key B").toBeDefined();
		const publication = h.probe.publications.find(
			(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex!.hash
		);
		expect(publication, "positive control: the authored vertex must publish").toBeDefined();
		const executed = stateFromDRP(h.applier.drp);
		const groundTruth = byteDeltaKeys(baseline, executed);
		expect(groundTruth, "positive control: both the failed-write owner and later mutation changed bytes").toEqual([
			"a",
			"b",
		]);

		expect.soft(publication).toMatchObject({ mode: "incremental" });
		expect
			.soft(publication?.changed.drp, "incremental attribution must cover the complete executed byte delta")
			.toEqual(groundTruth);
		const stored = h.states.getDRPState(vertex!.hash)!;
		expect
			.soft(encodedState(stored), "stored snapshot bytes must equal the full-capture oracle")
			.toEqual(encodedState(executed));
		const reconstructed = h.states.fromHash(vertex!.hash)[0]!;
		expect
			.soft(encodedState(stateFromDRP(reconstructed)), "fromHash must reconstruct the executed instance byte-for-byte")
			.toEqual(encodedState(executed));
	});
});
