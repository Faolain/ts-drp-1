import "./helpers/trusted-vertex-ingest.js";

import {
	ActionType,
	DrpType,
	type IDRP,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

// Test-harness termination ceiling only. Phase 0h requires bounded handling but
// deliberately does not select the production retry count.
const HARNESS_RESOLVER_CALL_CEILING_PER_OFFER = 32;

const resolverState = new Map<string, { calls: number; throws: boolean }>();

class ResolverProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	constructor(
		readonly controlId: string,
		throws: boolean
	) {
		resolverState.set(controlId, { calls: 0, throws });
	}

	append(value: number): void {
		this.values.push(value);
	}

	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		// Adoption clones preserve this enumerable id without needing to rerun
		// the constructor, so calls made on either the live instance or a replay
		// clone remain observable by the harness.
		const state = resolverState.get(this.controlId);
		if (!state) throw new Error("resolver probe state is missing");
		state.calls++;
		if (state.throws) throw new Error("controlled legacy resolver failure");
		return { action: ActionType.Nop };
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
	error?: string;
}

function resolverCalls(drp: ResolverProbeDRP): number {
	return resolverState.get(drp.controlId)?.calls ?? 0;
}

function makeVertex(value: number, dependencies: string[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType: "append", value: [value] }),
		dependencies,
		timestamp
	);
}

async function observeApply(receiver: DRPObject<ResolverProbeDRP>, vertices: Vertex[]): Promise<ObservedApply> {
	try {
		const result = await receiver.applyVertices(vertices);
		return {
			status: "resolved",
			result: {
				applied: result.applied,
				invalid: result.invalid,
				missing: result.missing,
				quarantined: (result as typeof result & { quarantined?: string[] }).quarantined,
			},
		};
	} catch (error) {
		return { status: "rejected", error: error instanceof Error ? error.message : String(error) };
	}
}

function vertexSurfaces(
	receiver: DRPObject<ResolverProbeDRP>,
	vertex: Vertex,
	mergeNotifications: string[]
): Record<string, boolean> {
	const [aclState, drpState] = receiver.getStates(vertex.hash);
	return {
		aclState: aclState !== undefined,
		drpState: drpState !== undefined,
		finality: receiver.finalityStore.states.has(vertex.hash),
		graph: receiver.vertices.some(({ hash }) => hash === vertex.hash),
		notified: mergeNotifications.includes(vertex.hash),
	};
}

function graphValues(receiver: DRPObject<ResolverProbeDRP>): number[] {
	return receiver.vertices
		.filter((vertex) => vertex.operation?.opType === "append")
		.map((vertex) => vertex.operation?.value[0])
		.filter((value): value is number => typeof value === "number")
		.sort((left, right) => left - right);
}

describe("Phase 0h-L legacy resolver-exception quarantine", () => {
	it("bounds a throwing concurrent resolver per offer without poisoning or losing later causal work", async () => {
		const throwingDRP = new ResolverProbeDRP("throwing-resolver", true);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: throwingDRP,
		});
		const mergeNotifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") mergeNotifications.push(...vertices.map(({ hash }) => hash));
		});

		const left = makeVertex(10, [HashGraph.rootHash], 1);
		const poison = makeVertex(99, [HashGraph.rootHash], 2);
		const healthyChild = makeVertex(20, [left.hash], 3);
		const laterChild = makeVertex(30, [healthyChild.hash], 4);

		const leftDelivery = await observeApply(receiver, [left]);
		const callsBeforeFirstOffer = resolverCalls(throwingDRP);
		const firstOffer = await observeApply(receiver, [poison, healthyChild]);
		const callsAfterFirstOffer = resolverCalls(throwingDRP);
		const knownInvalidAfterFirstOffer = receiver["_applier"]["knownInvalidVertexHashes"].has(poison.hash);
		const secondOffer = await observeApply(receiver, [poison, laterChild]);
		const callsAfterSecondOffer = resolverCalls(throwingDRP);
		const firstOfferCalls = callsAfterFirstOffer - callsBeforeFirstOffer;
		const secondOfferCalls = callsAfterSecondOffer - callsAfterFirstOffer;

		expect(
			{
				firstOffer,
				healthySurfaces: {
					healthyChild: vertexSurfaces(receiver, healthyChild, mergeNotifications),
					laterChild: vertexSurfaces(receiver, laterChild, mergeNotifications),
					left: vertexSurfaces(receiver, left, mergeNotifications),
				},
				leftDelivery,
				nonsemanticPoison: {
					knownInvalidAfterFirstOffer,
					knownInvalidAfterSecondOffer: receiver["_applier"]["knownInvalidVertexHashes"].has(poison.hash),
					surfaces: vertexSurfaces(receiver, poison, mergeNotifications),
				},
				resolverPolicy: {
					firstOfferBounded: firstOfferCalls <= HARNESS_RESOLVER_CALL_CEILING_PER_OFFER,
					firstOfferRetried: firstOfferCalls > 1,
					secondOfferBounded: secondOfferCalls <= HARNESS_RESOLVER_CALL_CEILING_PER_OFFER,
					secondOfferRetried: secondOfferCalls > 1,
				},
				secondOffer,
				semanticState: {
					graphValues: graphValues(receiver),
					liveValues: receiver.drp?.values.toSorted((leftValue, rightValue) => leftValue - rightValue),
					mergeNotifications,
				},
			},
			"a resolver exception belongs to the submitted concurrent vertex: bounded quarantine must preserve committed surfaces and keep later work independently live"
		).toEqual({
			firstOffer: {
				status: "resolved",
				result: { applied: false, invalid: [], missing: [], quarantined: [poison.hash] },
			},
			healthySurfaces: {
				healthyChild: { aclState: true, drpState: true, finality: true, graph: true, notified: true },
				laterChild: { aclState: true, drpState: true, finality: true, graph: true, notified: true },
				left: { aclState: true, drpState: true, finality: true, graph: true, notified: true },
			},
			leftDelivery: {
				status: "resolved",
				result: { applied: true, invalid: [], missing: [], quarantined: undefined },
			},
			nonsemanticPoison: {
				knownInvalidAfterFirstOffer: false,
				knownInvalidAfterSecondOffer: false,
				surfaces: { aclState: false, drpState: false, finality: false, graph: false, notified: false },
			},
			resolverPolicy: {
				firstOfferBounded: true,
				firstOfferRetried: true,
				secondOfferBounded: true,
				secondOfferRetried: true,
			},
			secondOffer: {
				status: "resolved",
				result: { applied: false, invalid: [], missing: [], quarantined: [poison.hash] },
			},
			semanticState: {
				graphValues: [10, 20, 30],
				liveValues: [10, 20, 30],
				mergeNotifications: [left.hash, healthyChild.hash, laterChild.hash],
			},
		});
	});

	it("exercises the concurrent resolver seam and commits normally when the resolver does not throw", async () => {
		const acceptingDRP = new ResolverProbeDRP("accepting-resolver", false);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: acceptingDRP,
		});
		const mergeNotifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") mergeNotifications.push(...vertices.map(({ hash }) => hash));
		});
		const left = makeVertex(1, [HashGraph.rootHash], 1);
		const concurrent = makeVertex(2, [HashGraph.rootHash], 2);

		const leftDelivery = await observeApply(receiver, [left]);
		const concurrentDelivery = await observeApply(receiver, [concurrent]);

		expect({
			concurrentDelivery,
			leftDelivery,
			resolverWasExercised: resolverCalls(acceptingDRP) > 0,
			semanticState: {
				graphValues: graphValues(receiver),
				liveValues: receiver.drp?.values.toSorted((leftValue, rightValue) => leftValue - rightValue),
				mergeNotifications,
			},
			surfaces: {
				concurrent: vertexSurfaces(receiver, concurrent, mergeNotifications),
				left: vertexSurfaces(receiver, left, mergeNotifications),
			},
		}).toEqual({
			concurrentDelivery: {
				status: "resolved",
				result: { applied: true, invalid: [], missing: [], quarantined: undefined },
			},
			leftDelivery: {
				status: "resolved",
				result: { applied: true, invalid: [], missing: [], quarantined: undefined },
			},
			resolverWasExercised: true,
			semanticState: {
				graphValues: [1, 2],
				liveValues: [1, 2],
				mergeNotifications: [left.hash, concurrent.hash],
			},
			surfaces: {
				concurrent: { aclState: true, drpState: true, finality: true, graph: true, notified: true },
				left: { aclState: true, drpState: true, finality: true, graph: true, notified: true },
			},
		});
	});
});
