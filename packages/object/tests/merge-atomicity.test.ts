import "./helpers/trusted-vertex-ingest.js";

import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { expectGraphWellFormedAfterFailure } from "./merge-failure-invariants.js";
import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

const transientAttempts = new Map<string, number>();

class TransientFailureDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	append(value: string): void {
		this.values.push(value);
	}

	failTransiently(controlId: string): never {
		transientAttempts.set(controlId, (transientAttempts.get(controlId) ?? 0) + 1);
		throw new Error("retryable blueprint failure");
	}
}

function makeVertex(opType: string, value: unknown[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[HashGraph.rootHash],
		timestamp
	);
}

async function observeApply(
	receiver: DRPObject<TransientFailureDRP>,
	vertices: Vertex[]
): Promise<
	| {
			status: "resolved";
			result: Awaited<ReturnType<DRPObject<TransientFailureDRP>["applyVertices"]>> & {
				quarantined?: string[];
			};
	  }
	| { status: "rejected"; error: string }
> {
	try {
		return { status: "resolved", result: await receiver.applyVertices(vertices) };
	} catch (error) {
		return { status: "rejected", error: error instanceof Error ? error.message : String(error) };
	}
}

describe("per-vertex merge atomicity", () => {
	it("commits a valid vertex while quarantining a later transient failure without poisoning redelivery", async () => {
		const controlId = "transient-redelivery";
		transientAttempts.set(controlId, 0);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: new TransientFailureDRP(),
		});
		const mergeNotifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") mergeNotifications.push(...vertices.map(({ hash }) => hash));
		});
		const valid = makeVertex("append", ["survives quarantine"], 1);
		const transient = makeVertex("failTransiently", [controlId], 2);

		const firstDelivery = await observeApply(receiver, [valid, transient]);
		const redelivery = await observeApply(receiver, [transient]);
		const [validACLState, validDRPState] = receiver.getStates(valid.hash);
		const [transientACLState, transientDRPState] = receiver.getStates(transient.hash);
		expect(
			{
				firstDelivery,
				knownInvalidContainsTransient: receiver["_applier"]["knownInvalidVertexHashes"].has(transient.hash),
				liveValues: receiver.drp?.values,
				mergeNotifications,
				redelivery,
				transientAttempts: transientAttempts.get(controlId),
				transientSurfaces: {
					aclState: transientACLState,
					drpState: transientDRPState,
					finality: receiver.finalityStore.states.has(transient.hash),
					graph: receiver.vertices.some(({ hash }) => hash === transient.hash),
				},
				validSurfaces: {
					aclState: validACLState !== undefined,
					drpState: validDRPState !== undefined,
					finality: receiver.finalityStore.states.has(valid.hash),
					graph: receiver.vertices.some(({ hash }) => hash === valid.hash),
				},
			},
			"a transient vertex must be retriable quarantine while its valid batch peer commits on every surface"
		).toEqual({
			firstDelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [], quarantined: [transient.hash] },
			},
			knownInvalidContainsTransient: false,
			liveValues: ["survives quarantine"],
			mergeNotifications: [valid.hash],
			redelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [], quarantined: [transient.hash] },
			},
			transientAttempts: 6,
			transientSurfaces: {
				aclState: undefined,
				drpState: undefined,
				finality: false,
				graph: false,
			},
			validSurfaces: {
				aclState: true,
				drpState: true,
				finality: true,
				graph: true,
			},
		});

		await expectGraphWellFormedAfterFailure(
			receiver,
			101,
			"quarantining one vertex must leave a reachable graph and a usable applier"
		);
	});
});
