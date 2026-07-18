/**
 * Seeded randomized-simulation harness for DRPObject convergence properties.
 *
 * No fast-check dependency is available in this repo, so this implements a
 * small deterministic PRNG-based property harness with manual shrinking.
 * Every failure message contains the seed + config needed to reproduce it.
 *
 * Determinism: callers MUST enable vitest fake timers (see tests) — vertex
 * hashes include Date.now() timestamps, so the harness drives a virtual clock
 * to make whole runs reproducible from a seed.
 */
import {
	ActionType,
	type ApplyResult,
	type IDRP,
	type IHashGraph,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Seeded PRNG (mulberry32)                                            */
/* ------------------------------------------------------------------ */

export class SeededRandom {
	private s: number;

	constructor(seed: number) {
		this.s = seed >>> 0;
		if (this.s === 0) this.s = 0x9e3779b9;
	}

	/** float in [0, 1) */
	next(): number {
		let t = (this.s += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/**
	 * integer in [0, maxExclusive)
	 * @param maxExclusive
	 */
	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}

	/**
	 * integer in [min, max] inclusive
	 * @param min
	 * @param max
	 */
	intBetween(min: number, max: number): number {
		return min + this.int(max - min + 1);
	}

	chance(p: number): boolean {
		return this.next() < p;
	}

	pick<T>(arr: T[]): T {
		return arr[this.int(arr.length)];
	}

	/**
	 * returns a shuffled copy
	 * @param arr
	 */
	shuffle<T>(arr: T[]): T[] {
		const out = [...arr];
		for (let i = out.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}
}

/* ------------------------------------------------------------------ */
/* Box-movement game DRPs (2D and 3D)                                  */
/* ------------------------------------------------------------------ */

export interface Pos {
	x: number;
	y: number;
	z?: number;
}

/**
 * A map of boxId -> position. Concurrent moves of the same box are resolved
 * deterministically: the vertex with the greater hash wins (loser dropped).
 * Moves of different boxes commute (Nop).
 *
 * Besides the position map, the state keeps `oplog`, an append-only trace of
 * every applied move. Positions alone are LWW-like and mask most linearization
 * decisions (only the last surviving write per box is visible); the oplog
 * makes the state a function of the FULL linearized, non-dropped op sequence,
 * so any nondeterminism in ordering or conflict resolution shows up as a
 * state divergence.
 */
abstract class BoxGameBase implements IDRP {
	semanticsType = SemanticsType.pair;
	positions = new Map<string, Pos>();
	oplog: string[] = [];

	protected record(boxId: string, pos: Pos): void {
		this.positions.set(boxId, pos);
		this.oplog.push(`${boxId}@${pos.x},${pos.y}${pos.z !== undefined ? `,${pos.z}` : ""}`);
	}

	query_positions(): [string, Pos][] {
		return [...this.positions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	}

	query_log(): string[] {
		return this.oplog;
	}

	resolveConflicts(vertices: Vertex[]): ResolveConflictsType {
		const [left, right] = vertices;
		if (!left?.operation || !right?.operation) return { action: ActionType.Nop };
		// different boxes -> operations commute
		if (left.operation.value[0] !== right.operation.value[0]) return { action: ActionType.Nop };
		if (left.hash === right.hash) return { action: ActionType.Nop };
		// same box moved concurrently: deterministic winner by vertex hash
		return left.hash > right.hash ? { action: ActionType.DropRight } : { action: ActionType.DropLeft };
	}
}

export class BoxGame2D extends BoxGameBase {
	move(boxId: string, x: number, y: number): void {
		this.record(boxId, { x, y });
	}
}

export class BoxGame3D extends BoxGameBase {
	move(boxId: string, x: number, y: number, z: number): void {
		this.record(boxId, { x, y, z });
	}
}

export type BoxGame = BoxGame2D | BoxGame3D;

/* ------------------------------------------------------------------ */
/* Replicas                                                            */
/* ------------------------------------------------------------------ */

export interface Replica {
	peerId: string;
	obj: {
		drp?: BoxGame;
		vertices: Vertex[];
		applyVertices(vertices: Vertex[]): Promise<ApplyResult>;
	};
	hashGraph: IHashGraph;
}

export type ReplicaFactory = (peerId: string, peerIds: string[], dims: 2 | 3, objectId: string) => Replica;

export const CLOCK_BASE = 1_700_000_000_000;

/** Reset the (fake) clock to the base so runs are reproducible per seed. */
export function resetClock(): void {
	vi.setSystemTime(CLOCK_BASE);
}

export function makeReplicas(
	n: number,
	dims: 2 | 3,
	createReplica: ReplicaFactory,
	objectId = "proptest-object"
): Replica[] {
	const peerIds = Array.from({ length: n }, (_, i) => `peer${i}`);
	return peerIds.map((peerId) => createReplica(peerId, peerIds, dims, objectId));
}

export function hashGraphOf(r: Replica): IHashGraph {
	return r.hashGraph;
}

/* ------------------------------------------------------------------ */
/* Fingerprints & diagnostics                                          */
/* ------------------------------------------------------------------ */

export function stateFingerprint(r: Replica): string {
	const drp = r.obj.drp;
	if (!drp) return "null";
	return JSON.stringify({ positions: drp.query_positions(), log: drp.query_log() });
}

export function sortedFrontier(r: Replica): string[] {
	return hashGraphOf(r).getFrontier().sort();
}

export function vertexHashes(r: Replica): string[] {
	return r.obj.vertices.map((v) => v.hash).sort();
}

export function linearizedHashes(r: Replica): string[] {
	return hashGraphOf(r)
		.linearizeVertices()
		.map((v) => v.hash);
}

const short = (h: string): string => h.slice(0, 8);

export function divergenceReport(replicas: Replica[]): string {
	const union = new Set<string>();
	for (const r of replicas) for (const h of vertexHashes(r)) union.add(h);
	const lines: string[] = [];
	for (const r of replicas) {
		const have = new Set(vertexHashes(r));
		const missing = [...union].filter((h) => !have.has(h)).map(short);
		lines.push(
			`  ${r.peerId}: vertices=${have.size}/${union.size}` +
				` frontier=[${sortedFrontier(r).map(short).join(",")}]` +
				` missing=[${missing.join(",")}]` +
				` state=${stateFingerprint(r)}`
		);
	}
	return lines.join("\n");
}

export function convergenceProblems(replicas: Replica[]): string[] {
	const problems: string[] = [];
	const ref = replicas[0];
	for (const r of replicas.slice(1)) {
		if (stateFingerprint(r) !== stateFingerprint(ref)) problems.push(`state mismatch: ${ref.peerId} vs ${r.peerId}`);
		if (JSON.stringify(sortedFrontier(r)) !== JSON.stringify(sortedFrontier(ref)))
			problems.push(`frontier mismatch: ${ref.peerId} vs ${r.peerId}`);
		if (JSON.stringify(vertexHashes(r)) !== JSON.stringify(vertexHashes(ref)))
			problems.push(`vertex-set mismatch: ${ref.peerId} vs ${r.peerId}`);
	}
	return problems;
}

export function isConverged(replicas: Replica[]): boolean {
	return convergenceProblems(replicas).length === 0;
}

export function assertConverged(replicas: Replica[], context: string): void {
	const problems = convergenceProblems(replicas);
	if (problems.length > 0) {
		throw new Error(
			`NOT CONVERGED (${context}):\n${problems.map((p) => `  - ${p}`).join("\n")}\n${divergenceReport(replicas)}`
		);
	}
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

export interface SimConfig {
	seed: number;
	replicaCount: number;
	ops: number;
	/** constructs object-layer replicas when an existing set is not supplied */
	createReplica?: ReplicaFactory;
	/** number of distinct box ids — small so concurrent same-key moves are common */
	boxes?: number;
	dims?: 2 | 3;
	/** probability that a replica gossips its vertices after a local op */
	sendProbability?: number;
	/** probability an enqueued message is duplicated */
	duplicateProbability?: number;
	/** probability an enqueued message carries only a random subset (models loss/partial sync) */
	subsetProbability?: number;
	/** max delivery delay, in op-steps */
	maxDelaySteps?: number;
	/**
	 * minimum ms the virtual clock advances per op (default 1). 0 allows
	 * different peers to create vertices with identical timestamps.
	 */
	minTickMs?: number;
	/** optional partition: groups of replica indices; gossip stays within a group */
	partitions?: number[][];
}

interface PendingMessage {
	to: number;
	vertices: Vertex[];
	due: number;
}

export interface SimStats {
	deliveries: number;
	mergeCalls: number;
	missingReports: number;
}

async function safeMerge(replica: Replica, vertices: Vertex[], stats: SimStats): Promise<void> {
	stats.mergeCalls++;
	let result: { applied: boolean; missing: string[] };
	try {
		result = await replica.obj.applyVertices(vertices);
	} catch (err) {
		throw new Error(
			`merge threw on ${replica.peerId} (merge must never throw): ${err instanceof Error ? err.stack : String(err)}`
		);
	}
	if (!result.applied) stats.missingReports += result.missing.length;
}

/**
 * Runs the randomized op/gossip phase. Returns replicas in whatever
 * (usually diverged) state the gossip left them, plus stats.
 * Deterministic given (seed, config) under fake timers.
 * @param cfg
 * @param replicas
 */
export async function runSim(
	cfg: SimConfig,
	replicas?: Replica[]
): Promise<{ replicas: Replica[]; rand: SeededRandom; stats: SimStats }> {
	const {
		seed,
		replicaCount,
		ops,
		createReplica,
		boxes = 3,
		dims = 2,
		sendProbability = 0.6,
		duplicateProbability = 0.15,
		subsetProbability = 0.2,
		maxDelaySteps = 5,
		minTickMs = 1,
		partitions,
	} = cfg;

	// only reset the clock for a fresh replica set; continuing an existing set
	// must keep time monotonic or vertex timestamp validation would reject deps
	if (!replicas) resetClock();
	const rand = new SeededRandom(seed);
	if (!replicas && !createReplica) throw new Error("runSim requires createReplica when replicas are not supplied");
	const reps = replicas ?? makeReplicas(replicaCount, dims, createReplica as ReplicaFactory);
	const boxIds = Array.from({ length: boxes }, (_, i) => `box${i}`);
	const stats: SimStats = { deliveries: 0, mergeCalls: 0, missingReports: 0 };

	const groupOf = (i: number): number[] => {
		if (!partitions) return reps.map((_, k) => k);
		return partitions.find((g) => g.includes(i)) ?? [i];
	};

	const pending: PendingMessage[] = [];

	const enqueue = (from: number, step: number): void => {
		const peers = groupOf(from).filter((i) => i !== from);
		if (peers.length === 0) return;
		const to = rand.pick(peers);
		let vertices = reps[from].obj.vertices;
		if (rand.chance(subsetProbability)) {
			// random subset — may omit dependencies, receiver must cope
			vertices = vertices.filter(() => rand.chance(0.7));
		}
		// random reordering of the batch
		vertices = rand.shuffle(vertices);
		const msg: PendingMessage = { to, vertices, due: step + rand.int(maxDelaySteps + 1) };
		pending.push(msg);
		if (rand.chance(duplicateProbability)) {
			pending.push({ ...msg, due: step + rand.int(maxDelaySteps + 1) });
		}
	};

	const deliverDue = async (step: number): Promise<void> => {
		for (let i = 0; i < pending.length; i++) {
			if (pending[i].due <= step) {
				const [msg] = pending.splice(i, 1);
				i--;
				stats.deliveries++;
				await safeMerge(reps[msg.to], msg.vertices, stats);
			}
		}
	};

	for (let step = 0; step < ops; step++) {
		vi.advanceTimersByTime(minTickMs + rand.int(3)); // monotonic virtual clock
		const actorIdx = rand.int(reps.length);
		const actor = reps[actorIdx];
		const box = rand.pick(boxIds);
		if (actor.obj.drp instanceof BoxGame3D) {
			actor.obj.drp.move(box, rand.int(100), rand.int(100), rand.int(100));
		} else {
			(actor.obj.drp as BoxGame2D).move(box, rand.int(100), rand.int(100));
		}
		if (rand.chance(sendProbability)) enqueue(actorIdx, step);
		await deliverDue(step);
	}

	// drain remaining in random order
	for (const msg of rand.shuffle(pending)) {
		vi.advanceTimersByTime(1);
		stats.deliveries++;
		await safeMerge(reps[msg.to], msg.vertices, stats);
	}

	return { replicas: reps, rand, stats };
}

/**
 * Full anti-entropy: every replica repeatedly merges every other replica's
 * full vertex list (natural, causally-consistent order) until converged.
 * One round should suffice; throws with diagnostics if maxRounds is exceeded
 * (that is a convergence/lockup bug).
 * @param replicas
 * @param rand
 * @param stats
 * @param maxRounds
 */
export async function antiEntropy(
	replicas: Replica[],
	rand: SeededRandom,
	stats: SimStats,
	maxRounds = 5
): Promise<number> {
	for (let round = 1; round <= maxRounds; round++) {
		vi.advanceTimersByTime(1);
		const pairs: [number, number][] = [];
		for (let i = 0; i < replicas.length; i++) {
			for (let j = 0; j < replicas.length; j++) if (i !== j) pairs.push([i, j]);
		}
		for (const [from, to] of rand.shuffle(pairs)) {
			await safeMerge(replicas[to], replicas[from].obj.vertices, stats);
		}
		if (isConverged(replicas)) return round;
	}
	throw new Error(
		`anti-entropy did not converge after ${maxRounds} full rounds — replicas are stuck:\n${divergenceReport(replicas)}`
	);
}

/* ------------------------------------------------------------------ */
/* Property runner with manual shrinking                               */
/* ------------------------------------------------------------------ */

export interface Shrinkable {
	ops: number;
	replicaCount: number;
}

/**
 * Runs `run(seed, ops, replicaCount)` for every seed. On failure, shrinks
 * (ops, then replicaCount, halving/decrementing while the failure persists)
 * and throws an error containing the seed + minimal failing configuration.
 * @param name
 * @param seeds
 * @param base
 * @param run
 */
export async function checkProperty(
	name: string,
	seeds: number[],
	base: Shrinkable,
	run: (seed: number, ops: number, replicaCount: number) => Promise<void>
): Promise<void> {
	for (const seed of seeds) {
		try {
			await run(seed, base.ops, base.replicaCount);
		} catch (original) {
			const minimal = await shrink(seed, base, run, original);
			const origMsg = original instanceof Error ? original.message : String(original);
			const minMsg = minimal.err instanceof Error ? minimal.err.message : String(minimal.err);
			throw new Error(
				`PROPERTY VIOLATION [${name}]\n` +
					`  reproduce: seed=${seed} ops=${base.ops} replicas=${base.replicaCount}\n` +
					`  minimal:   seed=${seed} ops=${minimal.ops} replicas=${minimal.replicaCount}\n` +
					`--- minimal failure ---\n${minMsg}\n` +
					`--- original failure ---\n${origMsg}`
			);
		}
	}
}

async function shrink(
	seed: number,
	base: Shrinkable,
	run: (seed: number, ops: number, replicaCount: number) => Promise<void>,
	originalErr: unknown
): Promise<Shrinkable & { err: unknown }> {
	let best: Shrinkable & { err: unknown } = { ...base, err: originalErr };
	let progress = true;
	while (progress) {
		progress = false;
		const candidates: Shrinkable[] = [
			{ ops: Math.floor(best.ops / 2), replicaCount: best.replicaCount },
			{ ops: best.ops - 1, replicaCount: best.replicaCount },
			{ ops: best.ops, replicaCount: best.replicaCount - 1 },
		];
		for (const c of candidates) {
			if (c.ops < 1 || c.replicaCount < 2) continue;
			if (c.ops === best.ops && c.replicaCount === best.replicaCount) continue;
			try {
				await run(seed, c.ops, c.replicaCount);
			} catch (err) {
				best = { ...c, err };
				progress = true;
				break;
			}
		}
	}
	return best;
}
