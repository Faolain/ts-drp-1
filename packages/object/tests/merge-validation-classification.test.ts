import "./helpers/trusted-vertex-ingest.js";

/**
 * Contract B: ApplyResult gains `invalid: Hash[]`, and MergeResult gains the
 * corresponding third tuple element: `[merged, missing, invalid]`. `missing`
 * contains re-requestable vertices whose dependencies are not yet available or
 * whose timestamps are not yet eligible, including their pending descendants.
 * Terminal rejections are reported in `invalid`. `applied` / `merged` is false
 * when either rejection list is non-empty.
 */
import { SetDRP } from "@ts-drp/blueprints";
import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

const FUTURE_TOLERANCE_MS = 60_000;
const BASE_TIME = Date.UTC(2025, 0, 1);

type ExtendedMergeResult = [merged: boolean, missing: string[], invalid: string[]];

function makeAddVertex(peerId: string, value: number, dependencies: string[], timestamp: number): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] });
	const hash = computeHash(peerId, operation, dependencies, timestamp);
	return { hash, peerId, operation, dependencies, timestamp, signature: new Uint8Array() };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("DRPObject clock-skew merge", () => {
	it("merges vertices minted by a replica whose clock is five seconds ahead", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const acl = createACL({ admins: ["replica-a", "replica-b"] });
		const replicaA = new DRPObject({ peerId: "replica-a", acl, drp: new SetDRP<number>() });
		const replicaB = new DRPObject({ peerId: "replica-b", acl, drp: new SetDRP<number>() });

		vi.setSystemTime(BASE_TIME + 5_000);
		replicaB.drp?.add(42);
		vi.setSystemTime(BASE_TIME);

		const mergeResult = (await replicaA.merge(replicaB.vertices)) as unknown as ExtendedMergeResult;
		expect(mergeResult).toEqual([true, [], []]);
		expect(replicaA.drp?.query_getValues()).toEqual(replicaB.drp?.query_getValues());
	});
});

describe("DRPObject validation-error classification", () => {
	it("reports unresolved dependencies and not-yet-eligible timestamps as re-requestable", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const acl = createACL({ admins: ["receiver", "sender"] });
		const receiver = new DRPObject({ peerId: "receiver", acl, drp: new SetDRP<number>() });
		const missingDependencyVertex = makeAddVertex("sender", 1, ["not-present"], BASE_TIME);
		const invalidTimestampVertex = makeAddVertex(
			"sender",
			2,
			[HashGraph.rootHash],
			BASE_TIME + FUTURE_TOLERANCE_MS + 1
		);

		const result = (await receiver.merge([
			missingDependencyVertex,
			invalidTimestampVertex,
		])) as unknown as ExtendedMergeResult;
		expect(result).toEqual([false, [missingDependencyVertex.hash, invalidTimestampVertex.hash], []]);
	});

	it("keeps a child and its not-yet-eligible parent re-requestable", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const acl = createACL({ admins: ["receiver", "sender"] });
		const receiver = new DRPObject({ peerId: "receiver", acl, drp: new SetDRP<number>() });
		const invalidParent = makeAddVertex("sender", 1, [HashGraph.rootHash], BASE_TIME + FUTURE_TOLERANCE_MS + 1);
		const child = makeAddVertex("sender", 2, [invalidParent.hash], invalidParent.timestamp + 1);

		const result = (await receiver.merge([child, invalidParent])) as unknown as ExtendedMergeResult;

		expect(result[0]).toBe(false);
		expect(result[1]).toEqual([child.hash, invalidParent.hash]);
		expect(result[2]).toEqual([]);
	});
});

describe("DRPObject transient application failures", () => {
	it("retries an operation that throws once without permanently poisoning its hash", async () => {
		let throwsRemaining = 1;
		class FlakyLogDRP implements IDRP {
			semanticsType = SemanticsType.pair;
			log: string[] = [];

			async add(value: string): Promise<void> {
				this.log.push(value);
				await Promise.resolve();
				if (throwsRemaining-- > 0) throw new Error("transient application failure");
			}

			query_log(): string[] {
				return [...this.log];
			}
		}

		const acl = createACL({ admins: ["receiver", "sender", "fresh"] });
		const receiver = new DRPObject({ peerId: "receiver", acl, drp: new FlakyLogDRP() });
		const vertex = createVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["once"] }),
			[HashGraph.rootHash],
			Date.now()
		);

		await expect(receiver.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(
			receiver.drp?.query_log(),
			"a failed attempt's partial mutation must not accumulate in the fresh successful candidate"
		).toEqual(["once"]);
		expect(receiver.vertices.some((candidate) => candidate.hash === vertex.hash)).toBe(true);
		expect(receiver["_applier"]["knownInvalidVertexHashes"].has(vertex.hash)).toBe(false);

		await expect(receiver.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(receiver.drp?.query_log(), "redelivery of a committed hash must remain idempotent").toEqual(["once"]);

		throwsRemaining = 0;
		const fresh = new DRPObject({ peerId: "fresh", acl, drp: new FlakyLogDRP() });
		await fresh.applyVertices([vertex]);
		expect(receiver.drp?.query_log()).toEqual(["once"]);
		expect(receiver.drp?.query_log()).toEqual(fresh.drp?.query_log());
	});
});
