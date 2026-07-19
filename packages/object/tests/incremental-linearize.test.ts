/**
 * RED acceptance contracts for incremental linearization and snapshot pruning.
 *
 * Existing acceptance surface (kept green; intentionally not duplicated here):
 * - linearize-reference.test.ts: optimized output is identical to the legacy reference.
 * - proptest/convergence.test.ts: randomized gossip replicas converge.
 * - perf-contracts.test.ts: existing linearization, conflict-free, state, and hash gates.
 *
 * A/B are RED until incremental replay and snapshot pruning land. C is a GREEN
 * parity pin: a future checkpoint implementation must invalidate/rebuild when a
 * concurrent vertex arrives below its retained checkpoint.
 */
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
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, test } from "vitest";

import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { createPermissionlessACL, DRPObject } from "../src/index.js";

const describePerformance = process.env.RUN_PERFORMANCE_TESTS === "true" ? describe : describe.skip;
const SMALL_GRAPH_SIZE = 2_000;
const LARGE_GRAPH_SIZE = 8_000;
const LOCAL_SAMPLE_COUNT = 50;
const REMOTE_BATCH_SIZE = 10;
const GROWTH_LIMIT = 3;
const SNAPSHOT_HISTORY_SIZE = 5_000;
// Allows a generous 512-vertex replay suffix plus as many as 256 checkpoints.
const MAX_RETAINED_SNAPSHOTS = 768;

type TestMap = MapDRP<string, number[]>;

interface WindowMeasurement {
	graphSize: number;
	localMeanMs: number;
	mergeMeanMs: number;
}

interface GrowthMeasurement {
	small: WindowMeasurement;
	large: WindowMeasurement;
	localRatio: number;
	mergeRatio: number;
}

let syntheticTimestamp = Date.now() - 1_000_000;

function makeObject(peerId: string): DRPObject<TestMap> {
	return new DRPObject({
		peerId,
		id: "incremental-linearize-contract",
		acl: createPermissionlessACL(["writer-a", "writer-b"]),
		drp: new MapDRP<string, number[]>(),
		config: { log_config: { level: "silent" } },
	});
}

function mapOperation(index: number, writer: number): Operation {
	return Operation.create({
		drpType: DrpType.DRP,
		opType: "set",
		value: [`player-${index % 50}`, [writer, index]],
	});
}

function appendSyntheticBatch(peerId: string, dependencies: string[], count: number, indexBase: number): Vertex[] {
	const vertices: Vertex[] = [];
	let nextDependencies = dependencies;
	// A directly seeded head may be ahead of wall time; validation permits the
	// same 60s skew as production gossip, so keep later synthetic children monotonic.
	syntheticTimestamp = Math.max(syntheticTimestamp, Date.now());
	for (let offset = 0; offset < count; offset++) {
		const vertex = createVertex(
			peerId,
			mapOperation(indexBase + offset, peerId === "writer-a" ? 0 : 1),
			nextDependencies,
			++syntheticTimestamp
		);
		vertices.push(vertex);
		nextDependencies = [vertex.hash];
	}
	return vertices;
}

/**
 * Adds the established two-writer/private-batch/gossip topology without timing setup replay.
 * @param object - Shared object whose graph receives the history.
 * @param targetSize - Desired non-root vertex count.
 * @param indexBase - Unique operation-label base for this growth phase.
 */
function seedGossipHistory(object: DRPObject<TestMap>, targetSize: number, indexBase: number): void {
	const graph = object["hashGraph"];
	let nonRootSize = graph.vertices.size - 1;
	let heads = graph.getFrontier();
	let round = 0;

	while (nonRootSize < targetSize) {
		const remaining = targetSize - nonRootSize;
		const perWriter = Math.min(REMOTE_BATCH_SIZE, Math.floor(remaining / 2));
		if (perWriter === 0) throw new Error(`targetSize must advance in pairs (remaining=${remaining})`);

		const left = appendSyntheticBatch("writer-a", heads, perWriter, indexBase + round * 20);
		const right = appendSyntheticBatch("writer-b", heads, perWriter, indexBase + round * 20 + 10);
		for (const vertex of [...left, ...right]) graph.addVertex(vertex);
		heads = [left.at(-1)?.hash, right.at(-1)?.hash].filter((hash): hash is string => hash !== undefined);
		nonRootSize += left.length + right.length;
		round++;
	}
}

function ensureLCAHasSnapshot(object: DRPObject<TestMap>): void {
	const graph = object["hashGraph"];
	const lca = graph.getLCA(graph.getFrontier()).lca;
	const [drpState, aclState] = object.getStates(lca);
	if (drpState && aclState) return;

	const [rootDRPState, rootACLState] = object.getStates(HashGraph.rootHash);
	if (!rootDRPState || !rootACLState) throw new Error("root snapshots are missing");
	object.setDRPState(lca, rootDRPState);
	object.setACLState(lca, rootACLState);
}

async function measureWindow(object: DRPObject<TestMap>, operationBase: number): Promise<WindowMeasurement> {
	ensureLCAHasSnapshot(object);
	const localSamples: number[] = [];
	const mergeSamples: number[] = [];

	for (let round = 0; round < LOCAL_SAMPLE_COUNT / REMOTE_BATCH_SIZE; round++) {
		const sharedHeads = object["hashGraph"].getFrontier();
		const remote = appendSyntheticBatch("writer-b", sharedHeads, REMOTE_BATCH_SIZE, operationBase + round * 20 + 10);

		for (let offset = 0; offset < REMOTE_BATCH_SIZE; offset++) {
			const index = operationBase + round * 20 + offset;
			const startedAt = performance.now();
			object.drp?.set(`player-${index % 50}`, [0, index]);
			localSamples.push(performance.now() - startedAt);
		}

		const mergeStartedAt = performance.now();
		const result = await object.applyVertices(remote);
		mergeSamples.push(performance.now() - mergeStartedAt);
		expect(result, "calibration workload must merge cleanly").toMatchObject({
			applied: true,
			missing: [],
			invalid: [],
		});
	}

	return {
		graphSize: object.vertices.length - 1,
		localMeanMs: localSamples.reduce((total, sample) => total + sample, 0) / localSamples.length,
		mergeMeanMs: mergeSamples.reduce((total, sample) => total + sample, 0) / mergeSamples.length,
	};
}

async function measureGrowth(): Promise<GrowthMeasurement> {
	const object = makeObject("writer-a");
	seedGossipHistory(object, SMALL_GRAPH_SIZE, 0);
	const small = await measureWindow(object, 100_000);
	seedGossipHistory(object, LARGE_GRAPH_SIZE, 200_000);
	const large = await measureWindow(object, 300_000);
	const localRatio = large.localMeanMs / small.localMeanMs;
	const mergeRatio = large.mergeMeanMs / small.mergeMeanMs;

	console.info(
		`[incremental-linearize] local mean: 2k=${small.localMeanMs.toFixed(2)}ms, ` +
			`8k=${large.localMeanMs.toFixed(2)}ms, ratio=${localRatio.toFixed(2)}x`
	);
	console.info(
		`[incremental-linearize] merge-10 mean: 2k=${small.mergeMeanMs.toFixed(2)}ms, ` +
			`8k=${large.mergeMeanMs.toFixed(2)}ms, ratio=${mergeRatio.toFixed(2)}x`
	);

	return { small, large, localRatio, mergeRatio };
}

function stableState(object: DRPObject<TestMap>): string {
	const entries = object.drp?.query_entries() ?? [];
	entries.sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify(entries);
}

function linearizedHashes(object: DRPObject<TestMap>): string[] {
	return object["hashGraph"].linearizeVertices().map((vertex) => vertex.hash);
}

function makeDeepBranchGraph(seed: number, branchDepth: number): { main: Vertex[]; branch: Vertex } {
	const main: Vertex[] = [];
	let dependencies = [HashGraph.rootHash];
	const timestampBase = Date.now() - 2_000_000 + seed * 10_000;

	for (let index = 1; index <= SNAPSHOT_HISTORY_SIZE; index++) {
		const vertex = createVertex(
			`main-${seed}`,
			mapOperation(seed * 10_000 + index, 0),
			dependencies,
			timestampBase + index
		);
		main.push(vertex);
		dependencies = [vertex.hash];
	}

	const branch = createVertex(
		`branch-${seed}`,
		mapOperation(seed * 10_000 + SNAPSHOT_HISTORY_SIZE + branchDepth, 1),
		[main[branchDepth - 1].hash],
		timestampBase + SNAPSHOT_HISTORY_SIZE + branchDepth + 1
	);
	return { main, branch };
}

async function expectCleanMerge<T extends IDRP>(object: DRPObject<T>, vertices: Vertex[]): Promise<void> {
	const result = await object.applyVertices(vertices);
	expect(result).toMatchObject({ applied: true, missing: [], invalid: [] });
}

describePerformance("A. flat per-operation cost (RED)", () => {
	let growth: GrowthMeasurement;

	beforeAll(async () => {
		growth = await measureGrowth();
	}, 120_000);

	test("mean local-op cost grows by at most 3x from 2k to 8k vertices", () => {
		expect(growth.localRatio, `local 8k/2k ratio; samples=${LOCAL_SAMPLE_COUNT}`).toBeLessThanOrEqual(GROWTH_LIMIT);
	});

	test("mean 10-vertex remote-merge cost grows by at most 3x from 2k to 8k vertices", () => {
		expect(
			growth.mergeRatio,
			`merge-10 8k/2k ratio; samples=${LOCAL_SAMPLE_COUNT / REMOTE_BATCH_SIZE}`
		).toBeLessThanOrEqual(GROWTH_LIMIT);
	});
});

describe("B. bounded snapshot memory (RED)", () => {
	test("retains at most a replay suffix plus checkpoints after 5k vertices", () => {
		const object = makeObject("writer-a");
		for (let index = 0; index < SNAPSHOT_HISTORY_SIZE; index++) {
			object.drp?.set(`player-${index % 50}`, [0, index]);
		}

		const drpSnapshots = object["_states"]["drpStates"].size;
		const aclSnapshots = object["_states"]["aclStates"].size;
		console.info(
			`[incremental-linearize] snapshots after ${SNAPSHOT_HISTORY_SIZE} vertices: ` +
				`drp=${drpSnapshots}, acl=${aclSnapshots}, bound=${MAX_RETAINED_SNAPSHOTS}`
		);

		expect(Math.max(drpSnapshots, aclSnapshots), "largest retained per-vertex snapshot map").toBeLessThanOrEqual(
			MAX_RETAINED_SNAPSHOTS
		);
	}, 30_000);
});

describe("C. late deep concurrency checkpoint parity (GREEN protection pin)", () => {
	test.each([
		{ seed: 7, branchDepth: 97 },
		{ seed: 29, branchDepth: 509 },
	])(
		"seed=$seed branchDepth=$branchDepth agrees with full replay",
		async ({ seed, branchDepth }) => {
			const { main, branch } = makeDeepBranchGraph(seed, branchDepth);
			const inOrder = makeObject(`in-order-${seed}`);
			const late = makeObject(`late-${seed}`);
			const fresh = makeObject(`fresh-${seed}`);

			await expectCleanMerge(inOrder, [...main.slice(0, branchDepth), branch]);
			await expectCleanMerge(inOrder, main.slice(branchDepth));

			await expectCleanMerge(late, main);
			await expectCleanMerge(late, [branch]);

			await expectCleanMerge(fresh, [...main.slice(0, branchDepth), branch, ...main.slice(branchDepth)]);

			const expectedState = stableState(fresh);
			const expectedOrder = linearizedHashes(fresh);
			expect(stableState(inOrder), "branch delivered when its ancestor becomes available").toBe(expectedState);
			expect(stableState(late), "deep concurrent branch delivered last").toBe(expectedState);
			expect(linearizedHashes(inOrder), "in-order linearization").toEqual(expectedOrder);
			expect(linearizedHashes(late), "late-delivery linearization").toEqual(expectedOrder);
		},
		60_000
	);
});

class AppendLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	log: string[] = [];

	add(value: string): void {
		this.log.push(value);
	}

	query_log(): string[] {
		return [...this.log];
	}
}

class CheckpointKVDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	kv = new Map<string, string>();

	set(key: string, value: string): void {
		this.kv.set(key, value);
	}

	query_entries(): [string, string][] {
		return [...this.kv.entries()].sort(([left], [right]) => left.localeCompare(right));
	}

	resolveConflicts(vertices: Vertex[]): ResolveConflictsType {
		const [left, right] = vertices;
		if (!left?.operation || !right?.operation || left.operation.value[0] !== right.operation.value[0]) {
			return { action: ActionType.Nop };
		}
		return left.hash > right.hash ? { action: ActionType.DropRight } : { action: ActionType.DropLeft };
	}
}

function makeCheckpointObject<T extends IDRP>(peerId: string, id: string, drp: T): DRPObject<T> {
	return new DRPObject({
		peerId,
		id,
		acl: createPermissionlessACL(["writer-a", "writer-b"]),
		drp,
		config: { log_config: { level: "silent" } },
	});
}

describe("D. checkpoint causal-barrier differential", () => {
	test("multi-head suffix keeps the off-origin branch and never reapplies the checkpoint origin", async () => {
		let timestamp = Date.now() - 1_000_000;
		const vertex = (peerId: string, label: string, dependencies: string[]): Vertex =>
			createVertex(
				peerId,
				Operation.create({ drpType: DrpType.DRP, opType: "add", value: [label] }),
				dependencies,
				++timestamp
			);
		const chain: Vertex[] = [];
		let dependencies = [HashGraph.rootHash];
		for (let index = 1; index <= 260; index++) {
			const next = vertex("writer-a", `a${index}`, dependencies);
			chain.push(next);
			dependencies = [next.hash];
		}
		const branch = vertex("writer-b", "b1", [chain[199].hash]);
		const left = vertex("writer-a", "cA", [chain[259].hash]);
		const right = vertex("writer-b", "cB", [branch.hash]);
		const merge = vertex("writer-a", "m", [left.hash, right.hash].sort());
		const all = [...chain.slice(0, 200), branch, ...chain.slice(200), left, right, merge];

		const incremental = makeCheckpointObject("receiver", "checkpoint-off-origin", new AppendLogDRP());
		await expectCleanMerge(incremental, chain.slice(0, 200));
		await expectCleanMerge(incremental, [branch, ...chain.slice(200)]);
		await expectCleanMerge(incremental, [left, right]);
		await expectCleanMerge(incremental, [merge]);

		const fresh = makeCheckpointObject("fresh", "checkpoint-off-origin", new AppendLogDRP());
		await expectCleanMerge(fresh, all);
		expect(incremental.drp?.query_log()).toEqual(fresh.drp?.query_log());
		expect(incremental.drp?.query_log().filter((label) => label === "a260")).toHaveLength(1);
		expect(incremental.drp?.query_log()).toContain("cB");
	});

	test("cross-cut conflict can still drop a pre-cut operation by falling back to full replay", async () => {
		let timestamp = Date.now() - 2_000_000;
		const vertex = (peerId: string, key: string, value: string, dependencies: string[]): Vertex =>
			createVertex(
				peerId,
				Operation.create({ drpType: DrpType.DRP, opType: "set", value: [key, value] }),
				dependencies,
				++timestamp
			);
		const chain: Vertex[] = [];
		let dependencies = [HashGraph.rootHash];
		for (let index = 1; index <= 260; index++) {
			const next = vertex("writer-a", `a${index}`, `v${index}`, dependencies);
			chain.push(next);
			dependencies = [next.hash];
		}
		const beforeCut = vertex("writer-b", "X", "before", [chain[199].hash]);
		const afterCut = vertex("writer-a", "X", "after", [chain[259].hash]);
		const branchTail = vertex("writer-b", "branch", "tail", [beforeCut.hash]);
		const merge = vertex("writer-a", "merge", "done", [afterCut.hash, branchTail.hash].sort());
		const all = [...chain.slice(0, 200), beforeCut, ...chain.slice(200), afterCut, branchTail, merge];

		const incremental = makeCheckpointObject("receiver", "checkpoint-cross-cut", new CheckpointKVDRP());
		await expectCleanMerge(incremental, chain.slice(0, 200));
		await expectCleanMerge(incremental, [beforeCut, ...chain.slice(200)]);
		await expectCleanMerge(incremental, [afterCut, branchTail]);
		await expectCleanMerge(incremental, [merge]);

		const fresh = makeCheckpointObject("fresh", "checkpoint-cross-cut", new CheckpointKVDRP());
		await expectCleanMerge(fresh, all);
		expect(incremental.drp?.query_entries()).toEqual(fresh.drp?.query_entries());
		expect(incremental.drp?.kv.get("X")).toBe(fresh.drp?.kv.get("X"));
	});
});
