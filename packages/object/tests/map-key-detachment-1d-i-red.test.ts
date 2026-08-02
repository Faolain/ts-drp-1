/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required snapshots and vertices */
import {
	DRPState,
	DRPStateEntry,
	DRPStateOtherTheWire,
	DrpType,
	type Hash,
	type IDRP,
	Operation,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface GraphKey {
	label: string;
	nested: { value: number };
	self?: GraphKey;
}

interface StateGraph {
	direct: GraphKey;
	primary: Map<GraphKey, unknown>;
	secondary: Map<GraphKey, unknown>;
	members: Set<GraphKey>;
}

interface PublicationCopyMetadata {
	publicationId: string;
	side: "acl" | "drp";
	key: string;
	image: "pre" | "post";
}

interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	baselineHashes: readonly Hash[];
	frontier: readonly Hash[];
	changed: Readonly<Record<"acl" | "drp", readonly string[]>>;
	fallbackReason?: string;
}

type PublicationObserverEvent =
	| { type: "copy"; value: unknown; metadata: PublicationCopyMetadata }
	| { type: "publication"; record: PublicationRecord };

class GraphFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	payload: StateGraph;
	revision = "root";

	constructor(payload: StateGraph = graph("root")) {
		this.payload = payload;
	}

	replacePayload(payload: StateGraph): void {
		this.payload = payload;
	}

	touch(revision: string): void {
		this.revision = revision;
	}
}

function graph(label: string, cyclic = false): StateGraph {
	const shared: GraphKey = { label: `${label}-shared`, nested: { value: 1 } };
	if (cyclic) shared.self = shared;
	const equalA: GraphKey = { label: `${label}-equal`, nested: { value: 2 } };
	const equalB: GraphKey = { label: `${label}-equal`, nested: { value: 2 } };
	return {
		direct: shared,
		primary: new Map<GraphKey, unknown>([
			[shared, shared],
			[equalA, { slot: "a" }],
			[equalB, { slot: "b" }],
		]),
		secondary: new Map([[shared, shared]]),
		members: new Set([shared]),
	};
}

function firstKey(value: StateGraph): GraphKey {
	return Map.prototype.keys.call(value.primary).next().value as GraphKey;
}

function graphFacts(source: StateGraph, copy: StateGraph): Record<string, boolean | number> {
	const sourceKey = firstKey(source);
	const primaryEntries = [...Map.prototype.entries.call(copy.primary)] as [GraphKey, unknown][];
	const copiedKey = primaryEntries[0][0];
	const secondaryKey = Map.prototype.keys.call(copy.secondary).next().value as GraphKey;
	return {
		rootDetached: copy !== source,
		mapKeyDetached: copiedKey !== sourceKey,
		keyEqualsValue: copiedKey === primaryEntries[0][1],
		crossMapAlias: copiedKey === secondaryKey,
		setAlias: Set.prototype.has.call(copy.members, copiedKey),
		propertyAlias: copiedKey === copy.direct,
		cyclePreserved: sourceKey.self === sourceKey ? copiedKey.self === copiedKey : copiedKey.self === undefined,
		distinctEqualKeys: primaryEntries[1][0] !== primaryEntries[2][0],
		mapSize: copy.primary.size,
	};
}

function expectDetachedGraph(source: StateGraph, copy: StateGraph, label: string): void {
	expect.soft(graphFacts(source, copy), label).toEqual({
		rootDetached: true,
		mapKeyDetached: true,
		keyEqualsValue: true,
		crossMapAlias: true,
		setAlias: true,
		propertyAlias: true,
		cyclePreserved: true,
		distinctEqualKeys: true,
		mapSize: 3,
	});
	if (firstKey(source).self !== firstKey(source)) {
		expect(serializeValue(copy), `${label}: exact payload bytes`).toEqual(serializeValue(source));
	}
}

function snapshot(key: string, value: unknown): DRPState {
	return DRPState.create({ state: [DRPStateEntry.create({ key, value })] });
}

function valueAt(state: DRPState, key = "payload"): StateGraph {
	return state.state.find((entry) => entry.key === key)!.value as StateGraph;
}

function encodedState(state: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

interface Harness {
	applier: DRPVertexApplier<GraphFixture>;
	drp: GraphFixture;
	hashGraph: HashGraph;
	states: DRPObjectStateManager<GraphFixture>;
}

function harness(
	payload: StateGraph = graph("root"),
	publicationObserver?: (event: PublicationObserverEvent) => unknown
): Harness {
	const drp = new GraphFixture(payload);
	const acl = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
	const states = new DRPObjectStateManager(acl, drp);
	const options = {
		drp,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver,
	};
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<GraphFixture>;
	return { applier: new Applier(options), drp, hashGraph, states };
}

function remoteVertex(opType: string, value: unknown[], dependencies: Hash[], timestamp: number): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value });
	return {
		hash: computeHash("remote", operation, dependencies, timestamp),
		peerId: "remote",
		dependencies,
		operation,
		timestamp,
		signature: new Uint8Array(),
	};
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit`).toBeDefined();
	return vertex!;
}

describe("Phase 1d(i) D.92.3 graph-aware state-payload detachment RED", () => {
	it("clones Map keys and values through one stack while keeping top-level entries independent", () => {
		const source = graph("capture", true);
		const instance = {
			semanticsType: SemanticsType.pair,
			first: source,
			second: source,
		} as IDRP & { first: StateGraph; second: StateGraph };

		const captured = stateFromDRP(instance);
		const first = valueAt(captured, "first");
		const second = valueAt(captured, "second");
		expectDetachedGraph(source, first, "stateFromDRP first entry");
		expectDetachedGraph(source, second, "stateFromDRP second entry");
		expect(firstKey(first), "independent top-level entries must not share their identity stack").not.toBe(
			firstKey(second)
		);
	});

	it.each([
		{
			name: "fromStates/applyState",
			copy: (manager: DRPObjectStateManager<GraphFixture>, source: StateGraph): StateGraph => {
				const [drp] = manager.fromStates(snapshot("payload", source), stateFromDRP(createACL({ admins: ["local"] })));
				return drp!.payload;
			},
		},
		{
			name: "fromHash",
			copy: (manager: DRPObjectStateManager<GraphFixture>, source: StateGraph): StateGraph => {
				const hash = "stored-drl-cut";
				manager.setDRPState(hash, snapshot("payload", source));
				manager.setACLState(hash, stateFromDRP(createACL({ admins: ["local"] })));
				return manager.fromHash(hash)[0]!.payload;
			},
		},
		{
			name: "fromHashACL",
			copy: (manager: DRPObjectStateManager<GraphFixture>, source: StateGraph): StateGraph => {
				const hash = "stored-acl-cut";
				manager.setACLState(hash, snapshot("payload", source));
				return (manager.fromHashACL(hash) as unknown as IDRP & { payload: StateGraph }).payload;
			},
		},
	] as const)("detaches the $name reconstruction boundary", ({ copy }) => {
		const manager = new DRPObjectStateManager(createACL({ admins: ["local"] }), new GraphFixture());
		const source = graph("reconstruct");
		expectDetachedGraph(source, copy(manager, source), "reconstructed state payload");
	});

	it("keeps ACL and DRP reconstruction sides independently owned", () => {
		const manager = new DRPObjectStateManager(createACL({ admins: ["local"] }), new GraphFixture());
		const source = graph("pair");
		const [drp, acl] = manager.fromStates(snapshot("payload", source), snapshot("payload", source));
		const drpCopy = drp!.payload;
		const aclCopy = (acl as unknown as IDRP & { payload: StateGraph }).payload;
		expectDetachedGraph(source, drpCopy, "DRP pair side");
		expectDetachedGraph(source, aclCopy, "ACL pair side");
		expect(firstKey(drpCopy), "ACL/DRP pair sides must not share an identity stack").not.toBe(firstKey(aclCopy));
	});

	it("detaches public ACL/DRP setter inputs and every getter result without changing wire bytes", () => {
		const object = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local"] }),
			drp: new GraphFixture(),
		});
		const source = graph("public");
		const aclInput = snapshot("payload", source);
		const drpInput = snapshot("payload", source);
		const hash = "public-owned-cut";
		object.setACLState(hash, aclInput);
		object.setDRPState(hash, drpInput);

		const first = object.getStates(hash);
		const second = object.getStates(hash);
		expectDetachedGraph(source, valueAt(first[0]!), "public ACL copy-out");
		expectDetachedGraph(source, valueAt(first[1]!), "public DRP copy-out");
		expect(firstKey(valueAt(first[0]!)), "ACL/DRP copy-in must be independent").not.toBe(firstKey(valueAt(first[1]!)));
		expect(firstKey(valueAt(first[1]!)), "each getStates call must be independent").not.toBe(
			firstKey(valueAt(second[1]!))
		);
		expect(encodedState(first[0]!)).toEqual(encodedState(aclInput));
		expect(encodedState(first[1]!)).toEqual(encodedState(drpInput));
	});

	it("detaches default per-vertex publication", () => {
		const source = graph("publication");
		const defaultHarness = harness();
		defaultHarness.applier.drp!.replacePayload(source);
		const published = vertexFor(defaultHarness, "replacePayload");
		expectDetachedGraph(
			source,
			valueAt(defaultHarness.states.getDRPState(published.hash)!),
			"default publication copy"
		);
	});

	it("retains the injected publication-copy/observer seam and exact copy count", () => {
		const events: PublicationObserverEvent[] = [];
		const injected = harness(graph("observer-root"), (event) => {
			events.push(event);
			return event.type === "copy" ? structuredClone(event.value) : undefined;
		});
		const observedSource = graph("observer");
		injected.applier.drp!.replacePayload(observedSource);
		const observedVertex = vertexFor(injected, "replacePayload");
		expectDetachedGraph(
			observedSource,
			valueAt(injected.states.getDRPState(observedVertex.hash)!),
			"injected publication copy"
		);
		expect(
			events
				.filter((event): event is Extract<PublicationObserverEvent, { type: "copy" }> => event.type === "copy")
				.map(({ metadata }) => `${metadata.side}:${metadata.key}:${metadata.image}`)
		).toEqual(["drp:payload:post"]);
	});

	it.each(["local", "remote"] as const)(
		"detaches %s operation history when an argument becomes state",
		async (lane) => {
			const h = harness();
			const source = graph(`${lane}-operation`);
			let vertex: Vertex;
			if (lane === "local") {
				h.applier.drp!.replacePayload(source);
				vertex = vertexFor(h, "replacePayload");
			} else {
				vertex = remoteVertex("replacePayload", [source], [HashGraph.rootHash], 10);
				await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
				vertex = h.hashGraph.getVertex(vertex.hash)!;
			}
			const historical = vertex.operation!.value[0] as StateGraph;
			expectDetachedGraph(source, historical, `${lane} operation value`);
		}
	);

	it("keeps dependent-batch adoption clones detached after the canonical hint is reused", async () => {
		const source = graph("hint");
		const h = harness(source);
		const first = remoteVertex("touch", ["one"], [HashGraph.rootHash], 20);
		const second = remoteVertex("touch", ["two"], [first.hash], 21);
		await expect(h.applier.applyVertices([first, second])).resolves.toEqual({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(h.drp.revision).toBe("two");
		expectDetachedGraph(source, h.drp.payload, "cloneEnumerableInstance adoption");
	});

	it("keeps sibling snapshots immutable and the concurrent fallback independently owned", async () => {
		const source = graph("siblings");
		const h = harness(source);
		const left = remoteVertex("touch", ["left"], [HashGraph.rootHash], 30);
		const right = remoteVertex("touch", ["right"], [HashGraph.rootHash], 31);
		await expect(h.applier.applyVertices([left, right])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		const rootBefore = encodedState(h.states.getDRPState(HashGraph.rootHash)!);
		const leftBefore = encodedState(h.states.getDRPState(left.hash)!);
		const rightBefore = encodedState(h.states.getDRPState(right.hash)!);
		expectDetachedGraph(source, valueAt(h.states.getDRPState(right.hash)!), "concurrent fallback copy");

		firstKey(source).nested.value = 99;
		expect(encodedState(h.states.getDRPState(HashGraph.rootHash)!)).toEqual(rootBefore);
		expect(encodedState(h.states.getDRPState(left.hash)!)).toEqual(leftBefore);
		expect(encodedState(h.states.getDRPState(right.hash)!)).toEqual(rightBefore);
	});

	it("retains detached checkpoint payloads while old vertex snapshots are pruned", () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
		try {
			const source = graph("checkpoint");
			const h = harness(source);
			for (let index = 1; index <= 35; index++) h.applier.drp!.touch(`revision-${index}`);
			const internals = h.applier as unknown as {
				checkpoints: { state: { drpState: DRPState }; frontier: Hash[] }[];
			};
			const stateMaps = h.states as unknown as { drpStates: Map<Hash, DRPState> };
			expect(internals.checkpoints.length).toBeGreaterThan(1);
			expect(stateMaps.drpStates.size, "checkpoint pruning must remove at least one obsolete vertex cut").toBeLessThan(
				h.hashGraph.vertices.size
			);
			for (const checkpoint of [internals.checkpoints[0], internals.checkpoints.at(-1)!]) {
				expectDetachedGraph(source, valueAt(checkpoint.state.drpState), `checkpoint ${checkpoint.frontier.join(",")}`);
			}
		} finally {
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});
});

describe("Phase 1d(i) D.92.3 detachment failure semantics", () => {
	it("uses captured Map/Set traversal intrinsics instead of hostile instance iterators", () => {
		const source = graph("intrinsics");
		const sentinel = new Error("hostile collection iterator must not run");
		Object.defineProperty(source.primary, Symbol.iterator, {
			configurable: true,
			value: (): never => {
				throw sentinel;
			},
		});
		Object.defineProperty(source.members, Symbol.iterator, {
			configurable: true,
			value: (): never => {
				throw sentinel;
			},
		});
		let copy: StateGraph;
		try {
			copy = valueAt(stateFromDRP(new GraphFixture(source)));
		} finally {
			Reflect.deleteProperty(source.primary, Symbol.iterator);
			Reflect.deleteProperty(source.members, Symbol.iterator);
		}
		expectDetachedGraph(source, copy!, "captured collection intrinsics");
	});

	it("fails closed without setter installation for incompatible collection receivers and throwing traversal", () => {
		const object = new DRPObject({
			peerId: "local",
			acl: createACL({ admins: ["local"] }),
			drp: new GraphFixture(),
		});
		const proxyGraph = graph("proxy");
		proxyGraph.primary = new Proxy(proxyGraph.primary, {});
		expect(() => object.setDRPState("proxy-cut", snapshot("payload", proxyGraph))).toThrow(TypeError);
		expect(object.getStates("proxy-cut")).toEqual([undefined, undefined]);

		const sentinel = new Error("controlled traversal failure");
		const hostile = {
			first: { safe: true },
			get second(): never {
				throw sentinel;
			},
		};
		let thrown: unknown;
		try {
			object.setDRPState("throwing-cut", snapshot("payload", hostile));
		} catch (error) {
			thrown = error;
		}
		expect(thrown, "the original traversal throwable must remain primary").toBe(sentinel);
		expect(object.getStates("throwing-cut")).toEqual([undefined, undefined]);
	});

	it("rolls a failed publication back atomically and preserves its primary throwable", () => {
		const sentinel = new Error("controlled publication-copy failure");
		const publications: PublicationRecord[] = [];
		const h = harness(graph("rollback-root"), (event) => {
			if (event.type === "publication") {
				publications.push(event.record);
				return undefined;
			}
			if (event.metadata.key === "payload") throw sentinel;
			return structuredClone(event.value);
		});
		const source = graph("rollback");
		let thrown: unknown;
		try {
			h.applier.drp!.replacePayload(source);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(sentinel);
		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(publications).toHaveLength(1);
		expect(publications[0]).toMatchObject({ kind: "vertex", outcome: "rolled-back" });
		expect(h.states.getDRPState(publications[0].targetHash!)).toBeUndefined();
	});

	it("reuses an unchanged detached entry and copies only the authored top-level key", () => {
		const copies: PublicationCopyMetadata[] = [];
		const h = harness(graph("unchanged"), (event) => {
			if (event.type !== "copy") return undefined;
			copies.push(event.metadata);
			return structuredClone(event.value);
		});
		const rootPayload = h.states.getDRPState(HashGraph.rootHash)!.state.find(({ key }) => key === "payload")!;
		h.applier.drp!.touch("changed");
		const vertex = vertexFor(h, "touch");
		const storedPayload = h.states.getDRPState(vertex.hash)!.state.find(({ key }) => key === "payload")!;
		expect(storedPayload, "unchanged-entry comparison must preserve exact entry identity").toBe(rootPayload);
		expect(copies.map(({ side, key, image }) => `${side}:${key}:${image}`)).toEqual(["drp:revision:post"]);
	});
});
