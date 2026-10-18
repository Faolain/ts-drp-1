import { encodeCanonical } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, type EpochVertex, topologicalOrder } from "@ts-drp/compaction";
import { executeBounded } from "@ts-drp/worker-host";
import { serveWorkerTasks } from "@ts-drp/worker-host/worker";

const OPERATION_VERTICES = 4_096;
const TOTAL_VERTICES = OPERATION_VERTICES + 1;
const ANCHOR_HASH = "0".repeat(64);
const OBJECT_ID = "phase-2f-c-real-workload";

function hashForSequence(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function workloadGraph(): ReadonlyMap<string, EpochVertex> {
	const vertices = new Map<string, EpochVertex>();
	vertices.set(ANCHOR_HASH, {
		dependencies: [],
		epoch: 1,
		hash: ANCHOR_HASH,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
	});
	for (let sequence = OPERATION_VERTICES; sequence >= 1; sequence--) {
		const hash = hashForSequence(sequence);
		vertices.set(hash, {
			anchor: ANCHOR_HASH,
			dependencies: [ANCHOR_HASH],
			epoch: 1,
			hash,
			kind: "drp-vertex",
			objectId: OBJECT_ID,
			operation: { conflictKey: `key-${sequence % 64}`, value: sequence },
		});
	}
	return vertices;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

serveWorkerTasks(globalThis, {
	"operation-workload": async (payload, { emit, signal }) => {
		if (payload.byteLength !== 0) throw new TypeError("operation workload payload must be empty");

		const vertices = workloadGraph();
		const orderedHashes = topologicalOrder(vertices, ANCHOR_HASH);
		const order: number[] = [];
		const accumulator = new CompactMerkleAccumulator();
		let workerCounter = 0;

		const orderedVertices = executeBounded(
			orderedHashes,
			(hash): EpochVertex => {
				const vertex = vertices.get(hash);
				if (vertex === undefined) throw new Error(`ordered vertex ${hash} is missing`);
				return vertex;
			},
			{ batchSize: 256, maxBufferedResults: 1, maxItems: TOTAL_VERTICES, signal }
		);
		for await (const { value: vertex } of orderedVertices) {
			accumulator.append(encodeCanonical(vertex));
			order.push(Number.parseInt(vertex.hash.slice(-8), 16));
			workerCounter++;
		}

		const summary = {
			count: order.length,
			items: workerCounter,
			order,
			root: hex(accumulator.root()),
			workerCounter,
			workerScope: globalThis.constructor.name,
		};
		emit(new TextEncoder().encode(JSON.stringify(summary)));
	},
});
