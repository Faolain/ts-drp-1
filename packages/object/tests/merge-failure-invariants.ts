import { DrpType, type IDRP, Operation, type Vertex } from "@ts-drp/types";
import { expect } from "vitest";

import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import type { DRPObject } from "../src/index.js";

interface GraphObservation {
	dependencyHoles: { dependency: string; vertex: string }[];
	duplicateFrontier: string[];
	expectedFrontier: string[];
	frontier: string[];
	topologicalError?: string;
	topologicalHashes: string[];
	vertexHashes: string[];
}

function observeGraph<T extends IDRP>(receiver: DRPObject<T>): GraphObservation {
	const graph = receiver["hashGraph"];
	const vertices = receiver.vertices;
	const vertexHashes = vertices.map(({ hash }) => hash).sort();
	const vertexHashSet = new Set(vertexHashes);
	const dependencyHoles = vertices
		.flatMap((vertex) =>
			vertex.dependencies
				.filter((dependency) => !vertexHashSet.has(dependency))
				.map((dependency) => ({ dependency, vertex: vertex.hash }))
		)
		.sort((left, right) => `${left.vertex}:${left.dependency}`.localeCompare(`${right.vertex}:${right.dependency}`));
	const hashesWithChildren = new Set(vertices.flatMap(({ dependencies }) => dependencies));
	const expectedFrontier = vertexHashes.filter((hash) => !hashesWithChildren.has(hash)).sort();
	const frontier = graph.getFrontier();
	const duplicateFrontier = frontier.filter((hash, index) => frontier.indexOf(hash) !== index).sort();
	let topologicalHashes: string[] = [];
	let topologicalError: string | undefined;
	try {
		topologicalHashes = graph.topologicalSort(true).sort();
	} catch (error) {
		topologicalError = error instanceof Error ? error.message : String(error);
	}

	return {
		dependencyHoles,
		duplicateFrontier,
		expectedFrontier,
		frontier: [...frontier].sort(),
		topologicalError,
		topologicalHashes,
		vertexHashes,
	};
}

/**
 * Asserts that a batch containing a transient blueprint failure reported that failure,
 * WITHOUT pinning how it reported it.
 *
 * These suites are regression pins: they must pass at the program baseline `7f9e66a`,
 * where a transient failure rejects the whole batch, AND they must keep holding under
 * the per-vertex semantics of plan appendix D.3(b), where the batch resolves and the
 * transient vertex is reported in `quarantined`. Pinning `rejects.toThrow` as a
 * "positive control" would encode the very batch-scoped contract D.3(b) rejects, and
 * would make these pins unsatisfiable alongside the inverted `merge-atomicity.test.ts`.
 *
 * What is genuinely invariant across both semantics — and is what these suites exist to
 * protect — is that the transient vertex leaves no trace and no COMMITTED vertex is
 * removed. That is asserted by the callers and by `expectGraphWellFormedAfterFailure`.
 * @param batch - the in-flight `applyVertices` promise
 * @param transientHash - hash of the vertex whose blueprint method throws
 * @param assertionMessage - context for the failure message
 * @returns how the batch reported the transient failure
 */
export async function expectTransientReported(
	batch: Promise<unknown>,
	transientHash: string,
	assertionMessage: string
): Promise<"rejected" | "quarantined"> {
	try {
		const result = (await batch) as { applied: boolean; invalid: string[]; quarantined?: string[] };
		expect(
			{
				quarantinedTransient: (result.quarantined ?? []).includes(transientHash),
				treatedAsDeterministicallyInvalid: result.invalid.includes(transientHash),
			},
			`${assertionMessage} — a resolving batch must report the transient vertex as retriable quarantine, never as shared deterministic invalidity`
		).toEqual({ quarantinedTransient: true, treatedAsDeterministicallyInvalid: false });
		return "quarantined";
	} catch (error) {
		if (error instanceof Error && error.message.includes("controlled transient merge failure")) return "rejected";
		throw error;
	}
}

/**
 * Checks the graph's full reachability/frontier contract and proves that the
 * applier is not permanently wedged by applying one ordinary follow-up vertex.
 */
export async function expectGraphWellFormedAfterFailure<T extends IDRP>(
	receiver: DRPObject<T>,
	followUpValue: number,
	assertionMessage: string
): Promise<Vertex> {
	const before = observeGraph(receiver);
	const graph = receiver["hashGraph"];
	const timestamp = Math.max(...receiver.vertices.map(({ timestamp }) => timestamp), 0) + 1;
	const followUp = createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType: "append", value: [followUpValue] }),
		graph.getFrontier(),
		timestamp
	);

	let followUpStatus: "resolved" | "rejected" = "resolved";
	let followUpApplied = false;
	let followUpMissing: string[] = [];
	let followUpInvalid: string[] = [];
	let followUpQuarantined: string[] = [];
	let followUpError: string | undefined;
	try {
		const result = (await receiver.applyVertices([followUp])) as Awaited<ReturnType<DRPObject<T>["applyVertices"]>> & {
			quarantined?: string[];
		};
		followUpApplied = result.applied;
		followUpMissing = result.missing;
		followUpInvalid = result.invalid;
		followUpQuarantined = result.quarantined ?? [];
	} catch (error) {
		followUpStatus = "rejected";
		followUpError = error instanceof Error ? error.message : String(error);
	}
	const after = observeGraph(receiver);

	expect(
		{
			after: {
				dependencyHoles: after.dependencyHoles,
				duplicateFrontier: after.duplicateFrontier,
				frontierMatchesChildlessVertices: after.frontier.toSorted().join() === after.expectedFrontier.join(),
				topologicalError: after.topologicalError,
				topologicalReachesEveryVertex: after.topologicalHashes.join() === after.vertexHashes.join(),
			},
			before: {
				dependencyHoles: before.dependencyHoles,
				duplicateFrontier: before.duplicateFrontier,
				frontierMatchesChildlessVertices: before.frontier.toSorted().join() === before.expectedFrontier.join(),
				hasNonRootVertex: before.vertexHashes.some((hash) => hash !== HashGraph.rootHash),
				topologicalError: before.topologicalError,
				topologicalReachesEveryVertex: before.topologicalHashes.join() === before.vertexHashes.join(),
			},
			followUp: {
				applied: followUpApplied,
				error: followUpError,
				inGraph: receiver.vertices.some(({ hash }) => hash === followUp.hash),
				invalid: followUpInvalid,
				missing: followUpMissing,
				quarantined: followUpQuarantined,
				status: followUpStatus,
			},
		},
		assertionMessage
	).toEqual({
		after: {
			dependencyHoles: [],
			duplicateFrontier: [],
			frontierMatchesChildlessVertices: true,
			topologicalError: undefined,
			topologicalReachesEveryVertex: true,
		},
		before: {
			dependencyHoles: [],
			duplicateFrontier: [],
			frontierMatchesChildlessVertices: true,
			hasNonRootVertex: true,
			topologicalError: undefined,
			topologicalReachesEveryVertex: true,
		},
		followUp: {
			applied: true,
			error: undefined,
			inGraph: true,
			invalid: [],
			missing: [],
			quarantined: [],
			status: "resolved",
		},
	});

	return followUp;
}
