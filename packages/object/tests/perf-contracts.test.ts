import { MapDRP } from "@ts-drp/blueprints";
import {
	ActionType,
	DrpType,
	type IDRP,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import type * as HashUtils from "@ts-drp/utils/hash";
import { performance } from "node:perf_hooks";
import { describe, expect, test, vi } from "vitest";

const hashObservations = vi.hoisted(() => ({ computations: 0 }));

// Both local creation and validation import this package boundary. Wrapping the
// real implementation makes duplicate hashing observable without a source hook.
vi.mock("@ts-drp/utils/hash", async (importOriginal) => {
	const original = await importOriginal<typeof HashUtils>();
	return {
		...original,
		computeHash(...args: Parameters<typeof original.computeHash>): ReturnType<typeof original.computeHash> {
			hashObservations.computations++;
			return original.computeHash(...args);
		},
	};
});

import { HashGraph } from "../src/hashgraph/index.js";
import { createPermissionlessACL, DRPObject } from "../src/index.js";

const requestedPerfLimitScale = Number.parseFloat(process.env.PERF_LIMIT_SCALE ?? "1");
const PERF_LIMIT_SCALE =
	Number.isFinite(requestedPerfLimitScale) && requestedPerfLimitScale > 0 ? requestedPerfLimitScale : 1;
const LINEARIZATION_VERTEX_COUNT = 5_000;
const LINEARIZATION_LIMIT_MS = 200 * PERF_LIMIT_SCALE;
const CONFLICT_FREE_LIMIT_MS = 200 * PERF_LIMIT_SCALE;
const MAP_ENTRY_COUNT = 5_000;
const TIMED_MAP_OPERATIONS = 50;
const STATE_EQUALITY_LIMIT_MS = 1_000 * PERF_LIMIT_SCALE;

let timestampSeed = 1_700_000_000_000;

function operation(label: string, key = label): Operation {
	return Operation.create({
		drpType: DrpType.DRP,
		opType: "set",
		value: [key, label],
	});
}

function addVertex(
	graph: HashGraph,
	label: string,
	dependencies = graph.getFrontier(),
	timestamp = ++timestampSeed
): Vertex {
	const vertex = graph.createVertex(operation(label), dependencies, timestamp);
	graph.addVertex(vertex);
	return vertex;
}

function seededVertexAdder(graph: HashGraph, timestamp: number) {
	return (label: string, dependencies = graph.getFrontier()): Vertex =>
		addVertex(graph, label, dependencies, ++timestamp);
}

function buildChainGraph(vertexCount: number): HashGraph {
	const graph = new HashGraph("chain-peer", undefined, undefined, SemanticsType.pair);
	for (let index = 0; index < vertexCount; index++) {
		addVertex(graph, `chain-${index}`, graph.getFrontier());
	}
	return graph;
}

/**
 * Builds private writer heads within a round, then gossips them together.
 * @param vertexCount - Total non-root vertices.
 * @param roundSize - Per-writer operations between gossip points.
 * @returns The populated graph.
 */
function buildTwoWriterGraph(vertexCount: number, roundSize = 5): HashGraph {
	const graph = new HashGraph("two-writer-peer", undefined, undefined, SemanticsType.pair);
	let added = 0;
	let heads = graph.getFrontier();

	while (added < vertexCount) {
		const nextHeads: string[] = [];
		for (let writer = 0; writer < 2 && added < vertexCount; writer++) {
			let dependencies = heads;
			let lastHash: string | undefined;
			for (let offset = 0; offset < roundSize && added < vertexCount; offset++) {
				const vertex = addVertex(graph, `writer-${writer}-${added}`, dependencies);
				dependencies = [vertex.hash];
				lastHash = vertex.hash;
				added++;
			}
			if (lastHash) nextHeads.push(lastHash);
		}
		heads = nextHeads.length > 0 ? nextHeads : heads;
	}

	return graph;
}

function timedLinearization(graph: HashGraph): number {
	const startedAt = performance.now();
	graph.linearizeVertices();
	return performance.now() - startedAt;
}

function warmUpLinearization(): void {
	buildTwoWriterGraph(96, 3).linearizeVertices();
}

function labels(graph: HashGraph): string[] {
	return graph.linearizeVertices().map((vertex) => String(vertex.operation?.value[1]));
}

class ConflictFreeMapBlueprint implements IDRP {
	semanticsType = SemanticsType.pair;
	private readonly values = new Map<string, string>();

	set(key: string, value: string): void {
		this.values.set(key, value);
	}
}

describe("linearizeVertices output parity pins", () => {
	// These are green parity pins, not RED tests. The optimized implementation
	// must reproduce the current operation order exactly.
	test("preserves a fixed seeded chain order", () => {
		const graph = new HashGraph("parity-chain", undefined, undefined, SemanticsType.pair);
		const add = seededVertexAdder(graph, 1_700_000_000_000);
		for (const label of ["alpha", "bravo", "charlie", "delta", "echo"]) add(label);

		expect(labels(graph)).toMatchInlineSnapshot(`
			[
			  "alpha",
			  "bravo",
			  "charlie",
			  "delta",
			  "echo",
			]
		`);
	});

	test("preserves a fixed seeded diamond with a Drop-producing resolver", () => {
		const dropRightBranch = (vertices: Vertex[]): ResolveConflictsType => {
			const left = String(vertices[0].operation?.value[1]);
			const right = String(vertices[1].operation?.value[1]);
			if (left === "right") return { action: ActionType.DropLeft };
			if (right === "right") return { action: ActionType.DropRight };
			return { action: ActionType.Nop };
		};
		const graph = new HashGraph("parity-diamond", undefined, dropRightBranch, SemanticsType.pair);
		const add = seededVertexAdder(graph, 1_700_000_000_005);
		const base = add("base", [HashGraph.rootHash]);
		const left = add("left", [base.hash]);
		const right = add("right", [base.hash]);
		const join = add("join", [left.hash, right.hash]);
		add("tail", [join.hash]);

		expect(labels(graph)).toMatchInlineSnapshot(`
			[
			  "base",
			  "left",
			  "join",
			  "tail",
			]
		`);
	});

	test("preserves a fixed seeded interleaved DAG with Drop and Swap resolution", () => {
		let dropCount = 0;
		let swapCount = 0;
		const resolve = (vertices: Vertex[]): ResolveConflictsType => {
			const left = String(vertices[0].operation?.value[1]);
			const right = String(vertices[1].operation?.value[1]);
			if (left.includes("drop")) {
				dropCount++;
				return { action: ActionType.DropLeft };
			}
			if (right.includes("drop")) {
				dropCount++;
				return { action: ActionType.DropRight };
			}
			if (left > right) {
				swapCount++;
				return { action: ActionType.Swap };
			}
			return { action: ActionType.Nop };
		};
		const graph = new HashGraph("parity-two-writer", undefined, resolve, SemanticsType.pair);
		const add = seededVertexAdder(graph, 1_700_000_000_010);
		const a1 = add("a1", [HashGraph.rootHash]);
		const aDrop = add("a2-drop", [a1.hash]);
		const b1 = add("b1", [HashGraph.rootHash]);
		const b2 = add("b2", [b1.hash]);
		const merge1 = add("merge1", [aDrop.hash, b2.hash]);
		const a3 = add("a3", [merge1.hash]);
		const b3 = add("b3", [merge1.hash]);
		add("merge2", [a3.hash, b3.hash]);

		expect(labels(graph)).toMatchInlineSnapshot(`
			[
			  "a1",
			  "b2",
			  "b1",
			  "merge1",
			  "a3",
			  "b3",
			  "merge2",
			]
		`);
		expect({ dropCount, swapCount }).toEqual({ dropCount: 1, swapCount: 1 });
	});
});

describe("performance contracts (RED until optimized)", () => {
	test(`linearizes a ${LINEARIZATION_VERTEX_COUNT}-vertex single-writer chain within ${LINEARIZATION_LIMIT_MS}ms`, () => {
		warmUpLinearization();
		const graph = buildChainGraph(LINEARIZATION_VERTEX_COUNT);
		const elapsed = timedLinearization(graph);
		console.info(`[perf-contract] chain N=${LINEARIZATION_VERTEX_COUNT}: ${elapsed.toFixed(1)}ms`);

		expect(elapsed, "single-writer full-graph linearization").toBeLessThanOrEqual(LINEARIZATION_LIMIT_MS);
	}, 30_000);

	test(`linearizes a ${LINEARIZATION_VERTEX_COUNT}-vertex two-writer DAG within ${LINEARIZATION_LIMIT_MS}ms`, () => {
		warmUpLinearization();
		const graph = buildTwoWriterGraph(LINEARIZATION_VERTEX_COUNT);
		const elapsed = timedLinearization(graph);
		console.info(`[perf-contract] two-writer N=${LINEARIZATION_VERTEX_COUNT}: ${elapsed.toFixed(1)}ms`);

		expect(elapsed, "two-writer full-graph linearization").toBeLessThanOrEqual(LINEARIZATION_LIMIT_MS);
	}, 30_000);

	test(`uses the conflict-free blueprint shortcut for ${LINEARIZATION_VERTEX_COUNT} vertices within ${CONFLICT_FREE_LIMIT_MS}ms`, () => {
		warmUpLinearization();
		const object = new DRPObject({
			peerId: "conflict-free-peer",
			acl: createPermissionlessACL("conflict-free-peer"),
			drp: new ConflictFreeMapBlueprint(),
			config: { log_config: { level: "silent" } },
		});
		// Direct population isolates linearization while retaining the resolver
		// wiring produced by a real conflict-free DRPObject blueprint.
		const graph = object["hashGraph"];
		for (let index = 0; index < LINEARIZATION_VERTEX_COUNT; index++) {
			addVertex(graph, `conflict-free-${index}`, graph.getFrontier());
		}
		const elapsed = timedLinearization(graph);
		console.info(`[perf-contract] conflict-free N=${LINEARIZATION_VERTEX_COUNT}: ${elapsed.toFixed(1)}ms`);

		expect(elapsed, "conflict-free topological-order shortcut").toBeLessThanOrEqual(CONFLICT_FREE_LIMIT_MS);
	}, 30_000);

	test(`applies ${TIMED_MAP_OPERATIONS} local operations to a ${MAP_ENTRY_COUNT}-entry MapDRP within ${STATE_EQUALITY_LIMIT_MS}ms`, () => {
		const warmDRP = new MapDRP<string, number>();
		for (let index = 0; index < 32; index++) warmDRP.set(`warm-${index}`, index);
		const warmObject = new DRPObject({
			peerId: "state-warm-peer",
			acl: createPermissionlessACL("state-warm-peer"),
			drp: warmDRP,
			config: { log_config: { level: "silent" } },
		});
		warmObject.drp?.set("warm-extra", 33);

		const drp = new MapDRP<string, number>();
		for (let index = 0; index < MAP_ENTRY_COUNT; index++) drp.set(`key-${index}`, index);
		const object = new DRPObject({
			peerId: "state-peer",
			acl: createPermissionlessACL("state-peer"),
			drp,
			config: { log_config: { level: "silent" } },
		});

		const startedAt = performance.now();
		for (let index = 0; index < TIMED_MAP_OPERATIONS; index++) {
			// Updating tail entries preserves Map size and makes equality walk
			// nearly all 5,000 entries before it can observe each change.
			object.drp?.set(`key-${MAP_ENTRY_COUNT - 1 - index}`, -index - 1);
		}
		const elapsed = performance.now() - startedAt;
		console.info(
			`[perf-contract] state equality entries=${MAP_ENTRY_COUNT}, ops=${TIMED_MAP_OPERATIONS}: ${elapsed.toFixed(1)}ms`
		);

		expect(object.drp?.query_get(`key-${MAP_ENTRY_COUNT - TIMED_MAP_OPERATIONS}`)).toBe(-TIMED_MAP_OPERATIONS);
		expect(elapsed, "state equality for local MapDRP operations").toBeLessThanOrEqual(STATE_EQUALITY_LIMIT_MS);
	}, 30_000);
});

describe("hash computation contract (RED until local vertices are trusted once)", () => {
	test("hashes a locally-created vertex exactly once", () => {
		const object = new DRPObject({
			peerId: "hash-once-peer",
			acl: createPermissionlessACL("hash-once-peer"),
			drp: new MapDRP<string, number>(),
			config: { log_config: { level: "silent" } },
		});
		hashObservations.computations = 0;

		object.drp?.set("only-local-op", 1);

		expect(hashObservations.computations, "one hash during local vertex creation").toBe(1);
	});
});
