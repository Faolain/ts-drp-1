import { DrpType, type IDRP, Operation, SemanticsType } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import {
	DRP_VERTEX_FUTURE_TOLERANCE_MS,
	InvalidTimestampError,
	isReceiverClockPendingValidationResult,
	validateVertex,
} from "@ts-drp/validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL, createVertex, DRPObject, HashGraph } from "../src/index.js";

const BASE_TIME = 1_000_000;

function createReceiver<T extends IDRP>(drp: T): DRPObject<T> {
	return new DRPObject({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp,
	});
}

function captureReceiverFutureError(): InvalidTimestampError {
	const futureVertex = createVertex(
		"future-sender",
		Operation.create({ drpType: DrpType.DRP, opType: "capture", value: ["accessor-replay-source"] }),
		[HashGraph.rootHash],
		BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1
	);
	const validation = validateVertex(futureVertex, new HashGraph("validation-receiver"), BASE_TIME);

	expect(validation.success).toBe(false);
	expect(validation.error).toBeInstanceOf(InvalidTimestampError);
	if (!(validation.error instanceof InvalidTimestampError)) {
		throw new Error("Expected public validateVertex to return an InvalidTimestampError");
	}
	return validation.error;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Phase 0f receiver-future accessor replay containment", () => {
	it("keeps a finite vertex terminal and unbranded when receiver time is negative infinity", () => {
		const vertex = createVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "boundary", value: ["negative-infinity-receiver"] }),
			[HashGraph.rootHash],
			BASE_TIME
		);
		const result = validateVertex(vertex, new HashGraph("validation-receiver"), Number.NEGATIVE_INFINITY);

		expect(result.success).toBe(false);
		expect(result.error).toBeInstanceOf(InvalidTimestampError);
		expect(result.error?.constructor).toBe(InvalidTimestampError);
		expect(isReceiverClockPendingValidationResult(result)).toBe(false);
	});

	it("uses one hash-bound timestamp snapshot across hash, dependency, and receiver checks", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		let executionAttempts = 0;

		class StableSnapshotDRP implements IDRP {
			semanticsType = SemanticsType.pair;

			add(): void {
				executionAttempts++;
			}
		}

		const hashBoundTimestamp = BASE_TIME;
		const laterFutureTimestamp = BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1;
		const vertex = createVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["stable-timestamp-snapshot"] }),
			[HashGraph.rootHash],
			hashBoundTimestamp
		);
		const vertexHash = vertex.hash;
		const timestampReadOutcomes: number[] = [];
		Object.defineProperty(vertex, "timestamp", {
			configurable: true,
			enumerable: true,
			get(): number {
				const value =
					timestampReadOutcomes.length === 1 || timestampReadOutcomes.length === 2
						? laterFutureTimestamp
						: hashBoundTimestamp;
				timestampReadOutcomes.push(value);
				return value;
			},
		});

		const receiver = createReceiver(new StableSnapshotDRP());
		const firstOffer = await receiver.applyVertices([vertex]);
		const reoffer = await receiver.applyVertices([vertex]);

		expect(
			{
				accepted: receiver.vertices.some(({ hash }) => hash === vertexHash),
				executionAttempts,
				firstOffer,
				remembered: receiver["_applier"]["knownInvalidVertexHashes"].has(vertexHash),
				reoffer,
				timestampReadOutcomes,
			},
			"a later accessor value must not earn pending provenance for a hash bound to the first timestamp snapshot"
		).toEqual({
			accepted: true,
			executionAttempts: 1,
			firstOffer: { applied: true, invalid: [], missing: [] },
			remembered: false,
			reoffer: { applied: true, invalid: [], missing: [] },
			timestampReadOutcomes: [hashBoundTimestamp],
		});
	});

	it("reports the exact validated hash without rereading caller-controlled hash or dependencies for pending", async () => {
		vi.useFakeTimers({ now: BASE_TIME });

		class PendingDRP implements IDRP {
			semanticsType = SemanticsType.pair;

			add(): void {}
		}

		const vertex = createVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["pending-provenance-hash"] }),
			[HashGraph.rootHash],
			BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1
		);
		const validatedHash = vertex.hash;
		const unvalidatedHash = `${validatedHash}-later-accessor-value`;
		const hashReadOutcomes: string[] = [];
		Object.defineProperty(vertex, "hash", {
			configurable: true,
			enumerable: true,
			get(): string {
				const value = hashReadOutcomes.length % 2 === 0 ? unvalidatedHash : validatedHash;
				hashReadOutcomes.push(value);
				return value;
			},
		});
		let dependencyReads = 0;
		Object.defineProperty(vertex, "dependencies", {
			configurable: true,
			enumerable: true,
			get(): string[] {
				dependencyReads++;
				return [HashGraph.rootHash];
			},
		});

		const receiver = createReceiver(new PendingDRP());
		const result = await receiver.applyVertices([vertex]);

		expect(
			{
				accepted: receiver.vertices.some(({ hash }) => hash === validatedHash),
				dependencyReads,
				hashReadOutcomes,
				remembered: receiver["_applier"]["knownInvalidVertexHashes"].has(validatedHash),
				result,
			},
			"pending provenance must carry the validated hash and be consumed before outer dependency/hash accessors"
		).toEqual({
			accepted: false,
			dependencyReads: 1,
			hashReadOutcomes: [unvalidatedHash, validatedHash],
			remembered: false,
			result: { applied: false, invalid: [], missing: [validatedHash] },
		});
	});

	it("binds pending provenance to the validation invocation that produced it", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const capturedError = captureReceiverFutureError();
		let executionAttempts = 0;

		class AccessorReplayDRP implements IDRP {
			semanticsType = SemanticsType.pair;

			add(): void {
				executionAttempts++;
			}
		}

		const finiteTimestamp = BASE_TIME;
		const vertex = createVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["accessor-replay"] }),
			[HashGraph.rootHash],
			finiteTimestamp
		);
		const vertexHash = vertex.hash;
		expect(vertexHash).toBe(computeHash(vertex.peerId, vertex.operation, vertex.dependencies, finiteTimestamp));

		// The stable-snapshot contract makes the old third-read throw fixture obsolete. Throwing the captured
		// genuine error on the first read retains the replay-containment purpose and pins a single observation.
		const timestampReadOutcomes: ("finite" | "throw-captured")[] = [];
		Object.defineProperty(vertex, "timestamp", {
			configurable: true,
			enumerable: true,
			get(): number {
				timestampReadOutcomes.push("throw-captured");
				throw capturedError;
			},
		});

		const receiver = createReceiver(new AccessorReplayDRP());
		const result = await receiver.applyVertices([vertex]);

		expect(
			{
				accepted: receiver.vertices.some(({ hash }) => hash === vertexHash),
				executionAttempts,
				remembered: receiver["_applier"]["knownInvalidVertexHashes"].has(vertexHash),
				result,
				timestampReadOutcomes,
				timestampReads: timestampReadOutcomes.length,
			},
			"a first-read replay of a captured genuine public error must be terminal and unbranded for this invocation"
		).toEqual({
			accepted: false,
			executionAttempts: 0,
			remembered: true,
			result: { applied: false, invalid: [vertexHash], missing: [] },
			timestampReadOutcomes: ["throw-captured"],
			timestampReads: 1,
		});
	});
});
