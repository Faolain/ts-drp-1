import type * as Canonical from "@ts-drp/canonical";
import { describe, expect, it, vi } from "vitest";

const codecFailure = vi.hoisted(() => ({
	armed: false,
	sentinel: new Error("private-codec-detail-0l"),
}));

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const original = await importOriginal<typeof Canonical>();
	return {
		...original,
		encodeCanonical: (value: unknown): Uint8Array => {
			if (
				codecFailure.armed &&
				value !== null &&
				typeof value === "object" &&
				Reflect.get(value, "operation") !== undefined
			) {
				throw codecFailure.sentinel;
			}
			return original.encodeCanonical(value);
		},
	};
});

import { CausalityIndex, type EpochVertex, LinearizationError, linearizeEpoch } from "../src/index.js";

const hashes = Array.from({ length: 4 }, (_, index) => index.toString(16).padStart(64, "0"));
const anchorHash = hashes[0] as string;

function concurrentGraph(): Map<string, EpochVertex> {
	return new Map([
		[
			anchorHash,
			{
				dependencies: [],
				epoch: 9,
				hash: anchorHash,
				kind: "drp-epoch-anchor",
				objectId: "phase-0l",
			},
		],
		[
			hashes[1] as string,
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 9,
				hash: hashes[1] as string,
				kind: "drp-vertex",
				objectId: "phase-0l",
				operation: { conflictKey: "shared", value: 1 },
			},
		],
		[
			hashes[2] as string,
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 9,
				hash: hashes[2] as string,
				kind: "drp-vertex",
				objectId: "phase-0l",
				operation: { conflictKey: "shared", value: 2 },
			},
		],
	]);
}

function capture(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected action to throw");
}

describe("Phase 0l compaction wrapper taxonomy RED", () => {
	it.each(["pair", "multiple"] as const)(
		"preserves a %s resolver throwable as exact cause without copying its private detail",
		(mode) => {
			const sentinel = new Error(`private-${mode}-resolver-detail-0l`);
			const error = capture(() =>
				linearizeEpoch({
					anchorHash,
					mode,
					resolveConflicts: () => {
						throw sentinel;
					},
					vertices: concurrentGraph(),
				})
			);

			expect(error).toBeInstanceOf(LinearizationError);
			expect(error).toMatchObject({ code: "CONFLICT_RESOLVER_FAILED" });
			expect((error as Error).cause).toBe(sentinel);
			expect((error as Error).message).not.toContain(sentinel.message);
		}
	);

	it("preserves the canonical codec throwable as the exact INVALID_VERTEX cause", () => {
		codecFailure.armed = true;
		try {
			const error = capture(() =>
				linearizeEpoch({
					anchorHash,
					mode: "none",
					vertices: concurrentGraph(),
				})
			);

			expect(error).toBeInstanceOf(LinearizationError);
			expect(error).toMatchObject({ code: "INVALID_VERTEX" });
			expect((error as Error).cause).toBe(codecFailure.sentinel);
			expect((error as Error).message).not.toContain(codecFailure.sentinel.message);
		} finally {
			codecFailure.armed = false;
		}
	});
});

describe("Phase 0l compaction preservation controls", () => {
	it("passes through a caller-thrown LinearizationError by exact identity", () => {
		const sentinel = new LinearizationError("INVALID_CONFLICT_ACTION", "caller-owned");

		const error = capture(() =>
			linearizeEpoch({
				anchorHash,
				mode: "pair",
				resolveConflicts: () => {
					throw sentinel;
				},
				vertices: concurrentGraph(),
			})
		);

		expect(error).toBe(sentinel);
	});

	it("preserves the exact three-key pending EpochFullOutcome", () => {
		const graph = concurrentGraph();
		const index = new CausalityIndex(new Map([[anchorHash, graph.get(anchorHash) as EpochVertex]]), undefined, {
			maxEpochVertices: 1,
		});

		const outcome = index.append(hashes[1] as string, graph.get(hashes[1] as string) as EpochVertex);

		expect(outcome).toEqual({
			code: "EPOCH_FULL",
			latchByHash: false,
			status: "pending",
		});
		expect(Object.keys(outcome as object).sort()).toEqual(["code", "latchByHash", "status"]);
	});
});
