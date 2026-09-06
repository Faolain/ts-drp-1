/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixture construction proves every indexed history member */
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
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { type OperationJournal } from "../src/operation.js";
import { createPublicationCapability } from "../src/publication/copy-capability.js";
import { type LinearizationCheckpoint, PublicationPublisher } from "../src/publication/publisher.js";
import { type PrunedStateSnapshots } from "../src/state-store.js";
import { DRPObjectStateManager } from "../src/state.js";

const PRE_CHECKPOINT_TAIL = 2;
const SMALL_HISTORY = 12;
const LARGE_HISTORY = 192;

class PruneFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	value = "root";
}

/** Transparent graph-map observer: entries, order and lookup behavior remain the native Map contract. */
class CountingGraphMap<K, V> extends Map<K, V> {
	graphTraversalYields = 0;

	private observeIterator<T>(source: Iterator<T>): IterableIterator<T> {
		const increment = (): void => {
			this.graphTraversalYields++;
		};
		return {
			next(): IteratorResult<T> {
				const result = source.next();
				if (!result.done) increment();
				return result;
			},
			[Symbol.iterator](): IterableIterator<T> {
				return this;
			},
		};
	}

	override keys(): MapIterator<K> {
		return this.observeIterator(super.keys()) as MapIterator<K>;
	}

	override values(): MapIterator<V> {
		return this.observeIterator(super.values()) as MapIterator<V>;
	}

	override entries(): MapIterator<[K, V]> {
		return this.observeIterator(super.entries()) as MapIterator<[K, V]>;
	}

	override [Symbol.iterator](): MapIterator<[K, V]> {
		return this.observeIterator(super[Symbol.iterator]()) as MapIterator<[K, V]>;
	}

	override forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
		super.forEach((value, key) => {
			this.graphTraversalYields++;
			callbackfn.call(thisArg, value, key, this);
		});
	}

	resetObservations(): void {
		this.graphTraversalYields = 0;
	}
}

class TestJournal implements OperationJournal {
	readonly undos: Array<() => void> = [];

	record(undo: () => void): void {
		this.undos.push(undo);
	}

	rollback(): void {
		for (let index = this.undos.length - 1; index >= 0; index--) this.undos[index]!();
	}
}

interface Measurement {
	graphSize: number;
	graphKeyYieldsAtPrune: number;
	retainedSize: number;
	prunedSnapshotPairs: number;
}

function snapshot(label: string): DRPState {
	return DRPState.create({
		state: [DRPStateEntry.create({ key: "value", value: { label } })],
	});
}

function wireBytes(state: DRPState): number[] {
	return Array.from(DRPStateOtherTheWire.encode(serializeDRPState(state)).finish());
}

function checkpoint(
	frontier: Hash[],
	vertexCount: number,
	aclState: DRPState,
	drpState: DRPState
): LinearizationCheckpoint {
	return { frontier, origin: [...frontier].sort()[0]!, vertexCount, state: { aclState, drpState } };
}

function chain(graph: HashGraph, count: number): Vertex[] {
	const vertices: Vertex[] = [];
	let dependencies = [HashGraph.rootHash];
	for (let index = 0; index < count; index++) {
		const vertex = createVertex(
			"remote",
			Operation.create({ drpType: DrpType.DRP, opType: "setValue", value: [`value-${index}`] }),
			dependencies,
			index + 1
		);
		vertices.push(vertex);
		graph.addVertex(vertex);
		dependencies = [vertex.hash];
	}
	return vertices;
}

function measureCheckpointPrune(historySize: number): Measurement {
	const drp = new PruneFixture();
	const acl = createACL({ admins: ["local", "remote"] });
	const graph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
	const history = chain(graph, historySize);
	const expectedGraphOrder = [...graph.vertices.keys()];
	const countingVertices = new CountingGraphMap(graph.vertices);
	graph.vertices = countingVertices;

	// Positive control: the observer delegates the exact real key sequence, then
	// resets so only checkpoint-prune work is charged to the causal assertion.
	expect(Array.from(countingVertices.keys())).toEqual(expectedGraphOrder);
	expect(countingVertices.graphTraversalYields).toBe(graph.vertices.size);
	countingVertices.resetObservations();

	const states = new DRPObjectStateManager(acl, drp);
	const rootACL = states.getACLState(HashGraph.rootHash)!;
	const rootDRP = states.getDRPState(HashGraph.rootHash)!;
	const priorFrontier = history.at(-(PRE_CHECKPOINT_TAIL + 1))!;
	const penultimate = history.at(-2)!;
	const currentFrontier = history.at(-1)!;
	const missingCheckpointFrontier = history[0]!;
	const obsolete = history[1]!;
	const priorACL = snapshot("prior-acl");
	const priorDRP = snapshot("prior-drp");
	const penultimateACL = snapshot("penultimate-acl");
	const penultimateDRP = snapshot("penultimate-drp");
	const currentACL = snapshot("current-acl");
	const currentDRP = snapshot("current-drp");
	const obsoleteACL = snapshot("obsolete-acl");
	const obsoleteDRP = snapshot("obsolete-drp");
	states.setACLState(priorFrontier.hash, priorACL);
	states.setDRPState(priorFrontier.hash, priorDRP);
	states.setACLState(penultimate.hash, penultimateACL);
	states.setDRPState(penultimate.hash, penultimateDRP);
	states.setACLState(currentFrontier.hash, currentACL);
	states.setDRPState(currentFrontier.hash, currentDRP);
	states.setACLState(obsolete.hash, obsoleteACL);
	states.setDRPState(obsolete.hash, obsoleteDRP);

	const checkpoints = [
		checkpoint([HashGraph.rootHash], 1, rootACL, rootDRP),
		// A retained checkpoint frontier may legitimately have no per-vertex snapshot.
		checkpoint([missingCheckpointFrontier.hash], 2, rootACL, rootDRP),
		checkpoint([priorFrontier.hash], graph.vertices.size - PRE_CHECKPOINT_TAIL, priorACL, priorDRP),
	];
	const checkpointsBefore = [...checkpoints];
	const wireBefore = new Map<Hash, [number[], number[]]>([
		[HashGraph.rootHash, [wireBytes(rootACL), wireBytes(rootDRP)]],
		[priorFrontier.hash, [wireBytes(priorACL), wireBytes(priorDRP)]],
		[currentFrontier.hash, [wireBytes(currentACL), wireBytes(currentDRP)]],
	]);

	let retainedAtPrune: Hash[] | undefined;
	let completedIterationsAtPrune: number[] | undefined;
	let pruned: PrunedStateSnapshots | undefined;
	const originalPrune = states.prune.bind(states);
	states.prune = (retained): PrunedStateSnapshots => {
		retainedAtPrune = [...retained];
		completedIterationsAtPrune = [countingVertices.graphTraversalYields];
		pruned = originalPrune(retained);
		return pruned;
	};

	const journal = new TestJournal();
	try {
		const publisher = new PublicationPublisher(
			{
				acl,
				drp,
				hashGraph: graph,
				states,
				checkpoints,
				checkpointSuffixSize: 1,
				rootHash: HashGraph.rootHash,
			},
			createPublicationCapability()
		);
		publisher.advanceCheckpointIfNeeded(journal);
	} finally {
		states.prune = originalPrune;
	}

	const expectedRetained = [
		HashGraph.rootHash,
		missingCheckpointFrontier.hash,
		priorFrontier.hash,
		currentFrontier.hash,
	];
	expect(retainedAtPrune, "retained-set construction must stay distinct from the owner-store prune scan").toEqual(
		expectedRetained
	);
	expect(checkpoints.at(-1)?.frontier).toEqual([currentFrontier.hash]);
	expect(checkpoints.at(-1)?.state).toEqual({ aclState: currentACL, drpState: currentDRP });
	expect(states.getACLState(HashGraph.rootHash)).toBe(rootACL);
	expect(states.getDRPState(HashGraph.rootHash)).toBe(rootDRP);
	expect(states.getACLState(priorFrontier.hash)).toBe(priorACL);
	expect(states.getDRPState(priorFrontier.hash)).toBe(priorDRP);
	expect(states.getACLState(currentFrontier.hash)).toBe(currentACL);
	expect(states.getDRPState(currentFrontier.hash)).toBe(currentDRP);
	expect(states.getACLState(missingCheckpointFrontier.hash)).toBeUndefined();
	expect(states.getDRPState(missingCheckpointFrontier.hash)).toBeUndefined();
	expect(states.getACLState(obsolete.hash)).toBeUndefined();
	expect(states.getDRPState(obsolete.hash)).toBeUndefined();
	expect(states.getACLState(penultimate.hash)).toBeUndefined();
	expect(states.getDRPState(penultimate.hash)).toBeUndefined();
	for (const [hash, [aclBytes, drpBytes]] of wireBefore) {
		expect(wireBytes(states.getACLState(hash)!)).toEqual(aclBytes);
		expect(wireBytes(states.getDRPState(hash)!)).toEqual(drpBytes);
	}

	const graphKeyYieldsAtPrune = completedIterationsAtPrune?.reduce((total, count) => total + count, 0) ?? 0;
	const prunedSnapshotPairs = Math.min(pruned?.acl.length ?? 0, pruned?.drp.length ?? 0);
	journal.rollback();
	expect(checkpoints).toEqual(checkpointsBefore);
	expect(states.getACLState(obsolete.hash)).toBe(obsoleteACL);
	expect(states.getDRPState(obsolete.hash)).toBe(obsoleteDRP);
	expect(states.getACLState(penultimate.hash)).toBe(penultimateACL);
	expect(states.getDRPState(penultimate.hash)).toBe(penultimateDRP);

	return {
		graphSize: graph.vertices.size,
		graphKeyYieldsAtPrune,
		retainedSize: expectedRetained.length,
		prunedSnapshotPairs,
	};
}

describe("Phase 1d(iii) checkpoint-pruning history independence", () => {
	it("preserves retained snapshot identity, missing cuts, wire bytes and rollback at the real prune boundary", () => {
		const small = measureCheckpointPrune(SMALL_HISTORY);
		expect(small).toMatchObject({
			graphSize: SMALL_HISTORY + 1,
			retainedSize: 4,
			prunedSnapshotPairs: 2,
		});
	});

	it("bounds graph-key work by checkpoint frontiers plus the small tail, not total vertex history", () => {
		const small = measureCheckpointPrune(SMALL_HISTORY);
		const large = measureCheckpointPrune(LARGE_HISTORY);
		const permittedGrowth = large.retainedSize + PRE_CHECKPOINT_TAIL + large.prunedSnapshotPairs;

		expect(
			large.graphKeyYieldsAtPrune,
			`graph-key yields at prune: small=${small.graphKeyYieldsAtPrune}/${small.graphSize}, ` +
				`large=${large.graphKeyYieldsAtPrune}/${large.graphSize}, permittedGrowth=${permittedGrowth}`
		).toBeLessThanOrEqual(small.graphKeyYieldsAtPrune + permittedGrowth);
	});
});
