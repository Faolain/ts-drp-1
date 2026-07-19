import { DrpType, type IHashGraph, Operation, Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { describe, expect, it } from "vitest";

import * as validation from "../src/index.js";

const FUTURE_TOLERANCE_MS = 60_000;
const BASE_TIME = Date.UTC(2025, 0, 1);

function makeVertex(timestamp: number, dependency: Vertex): Vertex {
	const peerId = "peer-clock-skew";
	const operation = Operation.create({ drpType: DrpType.DRP, opType: "set", value: [timestamp] });
	const dependencies = [dependency.hash];
	const hash = computeHash(peerId, operation, dependencies, timestamp);
	return Vertex.create({ hash, peerId, operation, dependencies, timestamp });
}

function makeDependency(timestamp: number): Vertex {
	return Vertex.create({ hash: `dependency-${timestamp}`, peerId: "dependency-peer", timestamp });
}

function graphContaining(vertex: Vertex): IHashGraph {
	return { vertices: new Map([[vertex.hash, vertex]]) } as unknown as IHashGraph;
}

describe("DRP vertex future timestamp tolerance", () => {
	it("exports the shared 60 second future-tolerance constant", () => {
		expect(validation).toHaveProperty("DRP_VERTEX_FUTURE_TOLERANCE_MS", FUTURE_TOLERANCE_MS);
	});

	it("accepts a vertex exactly at the receiver-clock tolerance boundary", () => {
		const dependency = makeDependency(BASE_TIME);
		const vertex = makeVertex(BASE_TIME + FUTURE_TOLERANCE_MS, dependency);

		expect(validation.validateVertex(vertex, graphContaining(dependency), BASE_TIME)).toEqual({ success: true });
	});

	it("rejects a vertex beyond the receiver-clock tolerance boundary", () => {
		const timestamp = BASE_TIME + FUTURE_TOLERANCE_MS + 1;
		const dependency = makeDependency(BASE_TIME);
		const vertex = makeVertex(timestamp, dependency);

		const result = validation.validateVertex(vertex, graphContaining(dependency), BASE_TIME);
		expect(result).toMatchObject({
			success: false,
			error: {
				name: "InvalidTimestampError",
				message: `Vertex ${vertex.hash} has invalid timestamp ${timestamp} - ${BASE_TIME} = ${FUTURE_TOLERANCE_MS + 1} > ${FUTURE_TOLERANCE_MS}`,
			},
		});
	});
});

describe("DRP vertex dependency timestamp tolerance", () => {
	it("accepts a dependency exactly one tolerance window ahead of its vertex", () => {
		const dependency = makeDependency(BASE_TIME);
		const vertex = makeVertex(BASE_TIME - FUTURE_TOLERANCE_MS, dependency);

		expect(validation.validateVertex(vertex, graphContaining(dependency), BASE_TIME)).toEqual({ success: true });
	});

	it("rejects a dependency more than one tolerance window ahead of its vertex", () => {
		const timestamp = BASE_TIME - FUTURE_TOLERANCE_MS - 1;
		const dependency = makeDependency(BASE_TIME);
		const vertex = makeVertex(timestamp, dependency);

		const result = validation.validateVertex(vertex, graphContaining(dependency), BASE_TIME);
		expect(result).toMatchObject({
			success: false,
			error: {
				name: "InvalidTimestampError",
				message: `Vertex ${vertex.hash} has invalid timestamp ${BASE_TIME} - ${timestamp} = ${FUTURE_TOLERANCE_MS + 1} > ${FUTURE_TOLERANCE_MS}`,
			},
		});
	});
});
