import { MapDRP } from "@ts-drp/blueprints";
import { type Vertex } from "@ts-drp/types";
import { bench, describe } from "vitest";

import { createPermissionlessACL, DRPObject } from "../../src/index.js";

const LOCAL_OPERATION_COUNTS = (process.env.BENCH_LOCAL_OPS ?? "1000,5000,20000").split(",").map(Number);
const MERGE_ROUND_COUNTS = (process.env.BENCH_MERGE_ROUNDS ?? "25,100,250").split(",").map(Number);
const OPS_PER_PEER_PER_ROUND = Number(process.env.BENCH_ROUND_OPS ?? 5);
const PLAYERS = Number(process.env.BENCH_PLAYERS ?? 50);
const singleCycle = { iterations: 1, time: 0, warmupIterations: 1, warmupTime: 0 };

function makeObject(peerId: string, peers = [peerId]): DRPObject<MapDRP<string, number[]>> {
	return new DRPObject({
		peerId,
		acl: createPermissionlessACL(peers),
		drp: new MapDRP<string, number[]>(),
		config: { log_config: { level: "silent" } },
	});
}

describe("DRPObject workload growth", () => {
	for (const operationCount of LOCAL_OPERATION_COUNTS) {
		bench(
			`single writer grows to ${operationCount} vertices`,
			() => {
				const object = makeObject("peer1");
				for (let operation = 0; operation < operationCount; operation++) {
					object.drp?.set(`player${operation % PLAYERS}`, [
						Math.fround(operation * 0.37),
						Math.fround(operation * 0.11),
					]);
				}
			},
			singleCycle
		);
	}

	for (const roundCount of MERGE_ROUND_COUNTS) {
		bench(
			`two replicas gossip for ${roundCount} rounds`,
			async () => {
				const peers = ["peer1", "peer2"];
				const left = makeObject(peers[0], peers);
				const right = makeObject(peers[1], peers);
				let operation = 0;

				for (let round = 0; round < roundCount; round++) {
					const leftVertices: Vertex[] = [];
					const rightVertices: Vertex[] = [];
					for (let offset = 0; offset < OPS_PER_PEER_PER_ROUND; offset++) {
						left.drp?.set(`player${operation % PLAYERS}`, [operation * 0.3, operation * 0.7]);
						operation++;
						right.drp?.set(`player${operation % PLAYERS}`, [operation * 0.4, operation * 0.9]);
						operation++;
					}

					for (const vertex of left.vertices.slice(-OPS_PER_PEER_PER_ROUND)) {
						if (vertex.peerId === peers[0]) leftVertices.push(vertex);
					}
					for (const vertex of right.vertices.slice(-OPS_PER_PEER_PER_ROUND)) {
						if (vertex.peerId === peers[1]) rightVertices.push(vertex);
					}

					await right.merge(leftVertices);
					await left.merge(rightVertices);
				}

				const leftState = JSON.stringify(left.drp?.query_entries().sort());
				const rightState = JSON.stringify(right.drp?.query_entries().sort());
				if (leftState !== rightState) throw new Error("benchmark replicas did not converge");
			},
			singleCycle
		);
	}
});
