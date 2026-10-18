import { DrpType, type IHashGraph, Operation, Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { describe, expect, it } from "vitest";

import * as validationErrors from "../src/errors.js";
import * as validationRoot from "../src/index.js";
import * as validationVertex from "../src/vertex.js";

const timestamp = 1_750_000_000_000;

function vertexWithDependency(): Vertex {
	const peerId = "phase-0l-validator";
	const operation = Operation.create({ drpType: DrpType.DRP, opType: "append", value: [1] });
	const dependencies = ["dependency"];
	return Vertex.create({
		dependencies,
		hash: computeHash(peerId, operation, dependencies, timestamp),
		operation,
		peerId,
		timestamp,
	});
}

function graphThrowing(sentinel: unknown): IHashGraph {
	return {
		vertices: {
			get(): never {
				throw sentinel;
			},
		},
	} as unknown as IHashGraph;
}

describe("Phase 0l validation wrapper taxonomy RED", () => {
	it.each([
		["Error", new Error("validation-error-sentinel-0l")],
		["non-Error", Object.freeze({ sentinel: "validation-non-error-0l" })],
	] as const)("wraps an unknown %s graph-access failure with exact cause", (_kind, sentinel) => {
		const result = validationVertex.validateVertex(vertexWithDependency(), graphThrowing(sentinel), timestamp, {
			skipHashValidation: true,
		});
		const error = result.error as Error & { code?: unknown };

		expect(result.success).toBe(false);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBe(sentinel);
		expect(error.cause).toBe(sentinel);
		expect(typeof error.code).toBe("string");
		expect(Object.values(validationRoot)).toContain(error.constructor);
		expect(Object.values(validationErrors)).toContain(error.constructor);
		expect(Object.keys(result).sort()).toEqual(["error", "success"]);
	});
});

describe("Phase 0l validation identity and result-shape controls", () => {
	it.each([
		new validationErrors.InvalidHashError("known-hash"),
		new validationErrors.InvalidDependenciesError("known-dependencies"),
		new validationErrors.InvalidTimestampError("known-timestamp"),
	])("passes a known Invalid* graph-access failure through by exact identity", (sentinel) => {
		const result = validationRoot.validateVertex(vertexWithDependency(), graphThrowing(sentinel), timestamp, {
			skipHashValidation: true,
		});

		expect(result).toEqual({ error: sentinel, success: false });
		expect(result.error).toBe(sentinel);
	});

	it("keeps successful ValidationResult keys exact", () => {
		const dependency = Vertex.create({ hash: "dependency", peerId: "dependency", timestamp });
		const graph = { vertices: new Map([[dependency.hash, dependency]]) } as unknown as IHashGraph;

		const result = validationRoot.validateVertex(vertexWithDependency(), graph, timestamp, {
			skipHashValidation: true,
		});

		expect(result).toEqual({ success: true });
		expect(Object.keys(result)).toEqual(["success"]);
	});
});
