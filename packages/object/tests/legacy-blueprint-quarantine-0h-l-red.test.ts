import "./helpers/trusted-vertex-ingest.js";

import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

const applicationAttempts = new Map<string, number>();
// Test-harness termination ceiling only: Phase 0h requires a bounded policy but does not choose its production count.
const HARNESS_ATTEMPT_CEILING_PER_OFFER = 32;

class AsyncPoisonDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	async alwaysReject(controlId: string): Promise<never> {
		applicationAttempts.set(controlId, (applicationAttempts.get(controlId) ?? 0) + 1);
		await Promise.resolve();
		throw new Error("controlled retryable application failure");
	}
}

interface ObservedApply {
	status: "rejected" | "resolved";
	result?: {
		applied: boolean;
		invalid: string[];
		missing: string[];
		quarantined?: string[];
	};
	error?: {
		message: string;
		name: string;
		partialResult?: unknown;
	};
}

function makeVertex(opType: string, value: unknown[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[HashGraph.rootHash],
		timestamp
	);
}

async function observeApply(receiver: DRPObject<AsyncPoisonDRP>, vertices: Vertex[]): Promise<ObservedApply> {
	try {
		return { status: "resolved", result: await receiver.applyVertices(vertices) };
	} catch (error) {
		return {
			status: "rejected",
			error: {
				message: error instanceof Error ? error.message : String(error),
				name: error instanceof Error ? error.name : typeof error,
				partialResult:
					typeof error === "object" && error !== null && "partialResult" in error
						? (error as { partialResult?: unknown }).partialResult
						: undefined,
			},
		};
	}
}

function committedSurfaces(receiver: DRPObject<AsyncPoisonDRP>, vertex: Vertex): Record<string, boolean> {
	const [aclState, drpState] = receiver.getStates(vertex.hash);
	return {
		aclState: aclState !== undefined,
		drpState: drpState !== undefined,
		finality: receiver.finalityStore.states.has(vertex.hash),
		graph: receiver.vertices.some(({ hash }) => hash === vertex.hash),
		notified: false,
	};
}

describe("Phase 0h-L legacy bounded application quarantine", () => {
	it("bounds an asynchronous poison vertex per offer while unrelated peers commit across redelivery", async () => {
		const controlId = "async-poison-redelivery";
		applicationAttempts.set(controlId, 0);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: new AsyncPoisonDRP(),
		});
		const mergeNotifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") mergeNotifications.push(...vertices.map(({ hash }) => hash));
		});

		const poison = makeVertex("alwaysReject", [controlId], 1);
		const firstPeer = makeVertex("append", [11], 2);
		const secondPeer = makeVertex("append", [22], 3);

		const firstDelivery = await observeApply(receiver, [poison, firstPeer]);
		const attemptsAfterFirstDelivery = applicationAttempts.get(controlId);
		const secondDelivery = await observeApply(receiver, [poison, secondPeer]);
		const attemptsAfterSecondDelivery = applicationAttempts.get(controlId);
		const firstOfferAttempts = attemptsAfterFirstDelivery ?? 0;
		const secondOfferAttempts = (attemptsAfterSecondDelivery ?? 0) - firstOfferAttempts;

		const firstPeerSurfaces = committedSurfaces(receiver, firstPeer);
		firstPeerSurfaces.notified = mergeNotifications.includes(firstPeer.hash);
		const secondPeerSurfaces = committedSurfaces(receiver, secondPeer);
		secondPeerSurfaces.notified = mergeNotifications.includes(secondPeer.hash);
		const [poisonACLState, poisonDRPState] = receiver.getStates(poison.hash);

		expect(
			{
				attemptPolicy: {
					firstOfferBounded: firstOfferAttempts <= HARNESS_ATTEMPT_CEILING_PER_OFFER,
					firstOfferRetried: firstOfferAttempts > 1,
					secondOfferBounded: secondOfferAttempts <= HARNESS_ATTEMPT_CEILING_PER_OFFER,
					secondOfferRetried: secondOfferAttempts > 1,
				},
				firstDelivery,
				firstPeerSurfaces,
				knownInvalidContainsPoison: receiver["_applier"]["knownInvalidVertexHashes"].has(poison.hash),
				liveValues: receiver.drp?.values.toSorted((left, right) => left - right),
				poisonSurfaces: {
					aclState: poisonACLState,
					drpState: poisonDRPState,
					finality: receiver.finalityStore.states.has(poison.hash),
					graph: receiver.vertices.some(({ hash }) => hash === poison.hash),
					notified: mergeNotifications.includes(poison.hash),
				},
				secondDelivery,
				secondPeerSurfaces,
			},
			"legacy application exceptions must be retried, settle within the harness ceiling, and let each offer's unrelated peer commit"
		).toEqual({
			attemptPolicy: {
				firstOfferBounded: true,
				firstOfferRetried: true,
				secondOfferBounded: true,
				secondOfferRetried: true,
			},
			firstDelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [], quarantined: [poison.hash] },
			},
			firstPeerSurfaces: {
				aclState: true,
				drpState: true,
				finality: true,
				graph: true,
				notified: true,
			},
			knownInvalidContainsPoison: false,
			liveValues: [11, 22],
			poisonSurfaces: {
				aclState: undefined,
				drpState: undefined,
				finality: false,
				graph: false,
				notified: false,
			},
			secondDelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [], quarantined: [poison.hash] },
			},
			secondPeerSurfaces: {
				aclState: true,
				drpState: true,
				finality: true,
				graph: true,
				notified: true,
			},
		});
	});
});
