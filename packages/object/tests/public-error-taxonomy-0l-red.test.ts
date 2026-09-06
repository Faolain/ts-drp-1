import "./helpers/trusted-vertex-ingest.js";

import { DRPState, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { InvalidHashError } from "@ts-drp/validation";
import { describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import * as objectRoot from "../src/index.js";

type ErrorRoot = {
	DRP_ERROR_CODES: readonly string[];
	isDRPError(value: unknown): boolean;
};

const errorRootSpecifier = "@ts-drp/errors";

async function loadErrorRoot(): Promise<ErrorRoot> {
	return (await import(errorRootSpecifier)) as ErrorRoot;
}

async function capture(action: () => unknown | Promise<unknown>): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("expected action to throw");
}

async function expectRootCatalogued(error: unknown): Promise<void> {
	const errors = await loadErrorRoot();
	const code = Reflect.get(error as object, "code");

	expect(error).toBeInstanceOf(Error);
	expect(typeof code).toBe("string");
	expect(errors.DRP_ERROR_CODES).toContain(code);
	expect(errors.isDRPError(error)).toBe(true);
	expect(Object.values(objectRoot)).toContain((error as Error).constructor);
}

class NumberLog implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

function receiver(): objectRoot.DRPObject<NumberLog> {
	return new objectRoot.DRPObject({
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new NumberLog(),
		peerId: "receiver",
	});
}

function operationVertex(timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType: "append", value: [timestamp] }),
		[HashGraph.rootHash],
		timestamp
	);
}

describe("Phase 0l object public error taxonomy RED", () => {
	it("catalogues both root-ACL refusal guards through root-importable branded classes", async () => {
		const object = receiver();
		const setStateError = await capture(() => object.setACLState(HashGraph.rootHash, DRPState.create()));
		const mergeError = await capture(() => object.merge([], DRPState.create()));

		await expectRootCatalogued(setStateError);
		await expectRootCatalogued(mergeError);
	});

	it("escapes adoption CAS exhaustion as the root-importable coded public class", async () => {
		const object = receiver();
		const applier = object["_applier"] as unknown as Record<string, unknown>;
		const originalTryCommit = applier.tryCommitPreparedVertex;
		applier.tryCommitPreparedVertex = (): string => "retry";
		try {
			const operation = {
				currentDRP: undefined,
				isACL: false,
				vertex: {
					dependencies: [HashGraph.rootHash],
					hash: "f".repeat(64),
				},
			};
			const callContext = {};
			const error = await capture(() =>
				Reflect.apply(applier.commitPreparedVertex as (...args: unknown[]) => unknown, applier, [
					operation,
					callContext,
				])
			);

			expect((error as Error).constructor).toBe(Reflect.get(objectRoot, "AdoptionCommitExhaustedError"));
			expect(error).toMatchObject({ attempts: 3, vertexHash: operation.vertex.hash });
			await expectRootCatalogued(error);
		} finally {
			applier.tryCommitPreparedVertex = originalTryCommit;
		}
	});

	it("escapes an apply invariant as the root-importable coded class rather than bare AggregateError", async () => {
		const object = receiver();
		const applier = object["_applier"] as unknown as Record<string, unknown>;
		const error = await capture(() =>
			Reflect.apply(applier.prepareHintedAdoption as (...args: unknown[]) => unknown, applier, [
				{ currentDRP: undefined, isACL: false, vertex: { hash: "e".repeat(64) } },
				[HashGraph.rootHash],
				{},
			])
		);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as Error).constructor).toBe(Reflect.get(objectRoot, "ApplyInvariantError"));
		await expectRootCatalogued(error);
	});

	it("root-exports the existing deterministic ACL cross-copy recognizer", () => {
		expect(Reflect.get(objectRoot, "isObjectACLDeterministicError")).toEqual(expect.any(Function));
	});
});

describe("Phase 0l validation classification and result-shape controls", () => {
	it.each([
		["unknown graph failure remains quarantined", new Error("unknown-graph-access-0l"), "quarantined"],
		["known InvalidHashError remains deterministic invalid", new InvalidHashError("known-invalid-0l"), "invalid"],
	] as const)("%s", async (_label, sentinel, expected) => {
		const object = receiver();
		const graph = object["hashGraph"];
		const originalGet = graph.vertices.get.bind(graph.vertices);
		const get = vi.spyOn(graph.vertices, "get").mockImplementation((hash) => {
			if (hash === HashGraph.rootHash) throw sentinel;
			return originalGet(hash);
		});
		const vertex = operationVertex(expected === "invalid" ? 2 : 1);

		try {
			const result = await object.applyVertices([vertex]);

			expect(result.applied).toBe(false);
			expect(result.invalid).toEqual(expected === "invalid" ? [vertex.hash] : []);
			expect(result.quarantined).toEqual(expected === "quarantined" ? [vertex.hash] : undefined);
			expect(Object.keys(result).sort()).toEqual(
				expected === "quarantined"
					? ["applied", "invalid", "missing", "quarantined"]
					: ["applied", "invalid", "missing"]
			);
		} finally {
			get.mockRestore();
		}
	});

	it("preserves exact successful ApplyResult and MergeResult keysets", async () => {
		const object = receiver();

		const applyResult = await object.applyVertices([]);
		const mergeResult = await object.merge([]);

		expect(applyResult).toEqual({ applied: true, invalid: [], missing: [] });
		expect(Object.keys(applyResult).sort()).toEqual(["applied", "invalid", "missing"]);
		expect(mergeResult).toEqual([true, [], []]);
		expect(Object.keys(mergeResult)).toEqual(["0", "1", "2"]);
	});
});
