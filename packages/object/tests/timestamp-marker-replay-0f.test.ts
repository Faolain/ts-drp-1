import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { DRP_VERTEX_FUTURE_TOLERANCE_MS, InvalidTimestampError, validateVertex } from "@ts-drp/validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL, createVertex, DRPObject, HashGraph } from "../src/index.js";

const BASE_TIME = 1_000_000;

function operationVertex(label: string, opType: string = "rethrowSynchronously"): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value: [label] }),
		[HashGraph.rootHash],
		BASE_TIME
	);
}

function expectSelfConsistentHash(vertex: Vertex): void {
	expect(vertex.hash).toBe(computeHash(vertex.peerId, vertex.operation, vertex.dependencies, vertex.timestamp));
}

function captureReceiverFutureError(): { error: InvalidTimestampError; futureVertex: Vertex } {
	const timestamp = BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1;
	const futureVertex = createVertex(
		"future-sender",
		Operation.create({ drpType: DrpType.DRP, opType: "capture", value: ["genuine-receiver-future"] }),
		[HashGraph.rootHash],
		timestamp
	);
	expectSelfConsistentHash(futureVertex);

	const validation = validateVertex(futureVertex, new HashGraph("validation-receiver"), BASE_TIME);
	expect(validation.success).toBe(false);
	expect(validation.error).toBeInstanceOf(InvalidTimestampError);
	if (!(validation.error instanceof InvalidTimestampError)) {
		throw new Error("Expected public validateVertex to return an InvalidTimestampError");
	}
	return { error: validation.error, futureVertex };
}

async function applyBlueprintReplay(
	replayError: InvalidTimestampError,
	asyncShape: boolean
): Promise<{
	attempts: number;
	result: Awaited<ReturnType<DRPObject<IDRP>["applyVertices"]>>;
	vertex: Vertex;
	receiver: DRPObject<IDRP>;
}> {
	let attempts = 0;

	class MarkerReplayingDRP implements IDRP {
		semanticsType = SemanticsType.pair;

		rethrowSynchronously(): never {
			attempts++;
			throw replayError;
		}

		async rethrowAsynchronously(): Promise<never> {
			attempts++;
			await Promise.resolve();
			throw replayError;
		}
	}

	const receiver = new DRPObject<IDRP>({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new MarkerReplayingDRP(),
	});
	const opType = asyncShape ? "rethrowAsynchronously" : "rethrowSynchronously";
	const vertex = operationVertex(`marker-replay-${opType}`, opType);
	expectSelfConsistentHash(vertex);
	const result = await receiver.applyVertices([vertex]);

	return { attempts, result, vertex, receiver };
}

function expectTerminalReplay({
	attempts,
	result,
	vertex,
	receiver,
}: Awaited<ReturnType<typeof applyBlueprintReplay>>): void {
	expect(attempts, "the blueprint replay fixture must execute exactly once").toBe(1);
	expect(result).toEqual({ applied: false, invalid: [vertex.hash], missing: [] });
	expect(result.missing, "application-stage marker replay must stay outside recovery").not.toContain(vertex.hash);
	expect(
		receiver["_applier"]["knownInvalidVertexHashes"].has(vertex.hash),
		"terminal marker replay must preserve pre-0f invalid memory"
	).toBe(true);
	expect(receiver.vertices.some(({ hash }) => hash === vertex.hash)).toBe(false);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Phase 0f receiver-future marker replay containment", () => {
	it("preserves the exact public InvalidTimestampError compatibility contract", () => {
		const { error, futureVertex } = captureReceiverFutureError();
		const expectedMessage = `Vertex ${futureVertex.hash} has invalid timestamp ${futureVertex.timestamp} - ${BASE_TIME} = ${
			futureVertex.timestamp - BASE_TIME
		} > ${DRP_VERTEX_FUTURE_TOLERANCE_MS}`;
		const expected = new InvalidTimestampError(expectedMessage);

		expect(error.constructor).toBe(InvalidTimestampError);
		expect(error).toBeInstanceOf(InvalidTimestampError);
		expect(error.name).toBe("InvalidTimestampError");
		expect(error.message).toBe(expectedMessage);
		expect(error).toStrictEqual(expected);
	});

	it.each([
		["synchronous", false],
		["asynchronous", true],
	])("keeps an exact genuine receiver-future error replay %s terminal and non-missing", async (_label, asyncShape) => {
		vi.useFakeTimers({ now: BASE_TIME });
		const replay = await applyBlueprintReplay(captureReceiverFutureError().error, asyncShape);
		expectTerminalReplay(replay);
	});

	const forgedVariants = [
		{
			label: "constructor-forged",
			forge(genuine: InvalidTimestampError): InvalidTimestampError {
				const CapturedConstructor = genuine.constructor as typeof InvalidTimestampError;
				return new CapturedConstructor(genuine.message);
			},
		},
		{
			label: "prototype-forged descriptor copy",
			forge(genuine: InvalidTimestampError): InvalidTimestampError {
				const forged = Object.create(Object.getPrototypeOf(genuine)) as InvalidTimestampError;
				Object.defineProperties(forged, Object.getOwnPropertyDescriptors(genuine));
				return forged;
			},
		},
	] as const;

	it.each(
		forgedVariants.flatMap(({ label, forge }) => [
			[`${label} synchronous`, forge, false] as const,
			[`${label} asynchronous`, forge, true] as const,
		])
	)("keeps a %s replay terminal and non-missing", async (_label, forge, asyncShape) => {
		vi.useFakeTimers({ now: BASE_TIME });
		const genuine = captureReceiverFutureError().error;
		const forged = forge(genuine);

		expect(forged).not.toBe(genuine);
		expect(forged).toBeInstanceOf(InvalidTimestampError);
		expect(forged.name).toBe(genuine.name);
		expect(forged.message).toBe(genuine.message);
		expectTerminalReplay(await applyBlueprintReplay(forged, asyncShape));
	});
});
