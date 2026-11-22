import "./helpers/trusted-vertex-ingest.js";

import { DRPStateOtherTheWire, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { beforeEach, describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { AdoptionCommitExhaustedError, ApplyInvariantError, DRPObject } from "../src/index.js";
import { stateFromDRP } from "../src/state.js";

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

class OneShotBarrier {
	readonly entered = deferred();
	readonly release = deferred();
	invocations = 0;

	async wait(): Promise<void> {
		this.invocations++;
		if (this.invocations !== 1) return;
		this.entered.resolve();
		await this.release.promise;
	}
}

interface ApplyResultLike {
	readonly applied: boolean;
	readonly invalid: string[];
	readonly missing: string[];
	readonly quarantined?: string[];
}

type ApplyOutcome =
	| { readonly status: "resolved"; readonly result: ApplyResultLike }
	| { readonly status: "rejected"; readonly error: unknown; readonly partialResult?: ApplyResultLike };

const barriers = new Map<string, OneShotBarrier>();
let exclusiveReplayFailures = 0;

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function installBarrier(id: string): OneShotBarrier {
	const barrier = new OneShotBarrier();
	barriers.set(id, barrier);
	return barrier;
}

class AtomicLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	append(value: string): void {
		this.values.push(value);
	}

	async appendAfter(controlId: string, value: string): Promise<string> {
		const barrier = barriers.get(controlId);
		if (!barrier) throw new Error(`Missing barrier ${controlId}`);
		await barrier.wait();
		this.values.push(value);
		return `appended:${value}`;
	}
}

class ExclusiveClaimDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	owner?: string;

	claim(owner: string): void {
		if (this.owner !== undefined && this.owner !== owner) {
			exclusiveReplayFailures++;
			throw new Error(`exclusive claim already belongs to ${this.owner}`);
		}
		this.owner = owner;
	}
}

function makeLogReceiver(peerId: string): DRPObject<AtomicLogDRP> {
	return new DRPObject({
		peerId,
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new AtomicLogDRP(),
	});
}

function makeClaimReceiver(): DRPObject<ExclusiveClaimDRP> {
	return new DRPObject({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new ExclusiveClaimDRP(),
	});
}

function remoteVertex(opType: string, value: unknown[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[HashGraph.rootHash],
		timestamp
	);
}

function encodedStates<T extends IDRP>(receiver: DRPObject<T>, hash: string): (number[] | undefined)[] {
	return receiver
		.getStates(hash)
		.map((state) =>
			state === undefined ? undefined : Array.from(DRPStateOtherTheWire.encode(serializeDRPState(state)).finish())
		);
}

function operationVertex(receiver: DRPObject<AtomicLogDRP>, opType: string, marker: string): Vertex | undefined {
	return receiver.vertices.find(
		(vertex) => vertex.operation?.opType === opType && vertex.operation.value.includes(marker)
	);
}

async function settleApply<T extends IDRP>(receiver: DRPObject<T>, vertices: Vertex[]): Promise<ApplyOutcome> {
	try {
		return { status: "resolved", result: await receiver.applyVertices(vertices) };
	} catch (error) {
		const partialResult =
			typeof error === "object" && error !== null && "partialResult" in error
				? (error as { partialResult?: ApplyResultLike }).partialResult
				: undefined;
		return { status: "rejected", error, partialResult };
	}
}

function expectedAccounting(uncommitted: Vertex[]): ApplyResultLike {
	if (uncommitted.length === 0) return { applied: true, missing: [], invalid: [] };
	return {
		applied: false,
		missing: [],
		invalid: [],
		quarantined: uncommitted.map(({ hash }) => hash),
	};
}

function vertexSurfaces<T extends IDRP>(
	receiver: DRPObject<T>,
	vertex: Vertex,
	notifications: readonly string[]
): {
	readonly finality: boolean;
	readonly graph: boolean;
	readonly notified: boolean;
	readonly snapshots: boolean;
} {
	const [aclState, drpState] = receiver.getStates(vertex.hash);
	return {
		finality: receiver.finalityStore.states.has(vertex.hash),
		graph: receiver.vertices.some(({ hash }) => hash === vertex.hash),
		notified: notifications.includes(vertex.hash),
		snapshots: aclState !== undefined || drpState !== undefined,
	};
}

function notificationEligible<T extends IDRP>(receiver: DRPObject<T>, hash: string): boolean {
	const applier = receiver["_applier"] as unknown as {
		notificationQueue: { vertices: Vertex[] }[];
	};
	return applier.notificationQueue.some(({ vertices }) => vertices.some((vertex) => vertex.hash === hash));
}

function logSnapshotMatchesValue(receiver: DRPObject<AtomicLogDRP>, vertex: Vertex, value: string): boolean {
	const [, snapshot] = receiver.getStates(vertex.hash);
	if (snapshot === undefined) return true;
	const expected = new AtomicLogDRP();
	expected.append(value);
	return (
		JSON.stringify(Array.from(DRPStateOtherTheWire.encode(serializeDRPState(snapshot)).finish())) ===
		JSON.stringify(Array.from(DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(expected))).finish()))
	);
}

function claimSnapshotMatchesOwner(receiver: DRPObject<ExclusiveClaimDRP>, vertex: Vertex): boolean {
	const [, snapshot] = receiver.getStates(vertex.hash);
	if (snapshot === undefined) return true;
	const owner = vertex.operation?.value[0];
	if (typeof owner !== "string") return false;
	const expected = new ExclusiveClaimDRP();
	expected.claim(owner);
	return (
		JSON.stringify(Array.from(DRPStateOtherTheWire.encode(serializeDRPState(snapshot)).finish())) ===
		JSON.stringify(Array.from(DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(expected))).finish()))
	);
}

describe("Phase 0q-a authoritative-state atomicity RED", () => {
	beforeEach(() => {
		barriers.clear();
		exclusiveReplayFailures = 0;
	});

	it("re-prepares an async local call after a remote merge commits across its suspension", async () => {
		const receiver = makeLogReceiver("receiver");
		const barrier = installBarrier("local-crosses-merge");
		const notifications: { hashes: string[]; origin: string; values: string[] }[] = [];
		receiver.subscribe((object, origin, vertices) => {
			notifications.push({
				hashes: vertices.map(({ hash }) => hash),
				origin,
				values: [...(object.drp?.values ?? [])],
			});
		});

		const localCall = receiver.drp?.appendAfter("local-crosses-merge", "local");
		await barrier.entered.promise;
		const remote = remoteVertex("append", ["remote"], 40);
		const remoteResult = await receiver.applyVertices([remote]);
		const whileSuspended = {
			localAbsent: operationVertex(receiver, "appendAfter", "local-crosses-merge") === undefined,
			remoteCommitted: receiver.vertices.some(({ hash }) => hash === remote.hash),
			remoteLive: receiver.drp?.values,
			remoteNotified: notifications.some(({ hashes, origin }) => origin === "merge" && hashes.includes(remote.hash)),
		};

		barrier.release.resolve();
		const localResult = await localCall;
		const local = operationVertex(receiver, "appendAfter", "local-crosses-merge");
		expect(local, "positive control: the local operation must publish after the barrier releases").toBeDefined();

		const serial = makeLogReceiver("serial");
		const serialResult = await serial.applyVertices([remote, local as Vertex]);
		const retainedHashes = [remote.hash, local?.hash].filter((hash): hash is string => hash !== undefined);
		const sameStoredStateBytes = retainedHashes.every((hash) => {
			const interleaved = encodedStates(receiver, hash);
			if (interleaved.every((state) => state === undefined)) return true;
			return JSON.stringify(interleaved) === JSON.stringify(encodedStates(serial, hash));
		});

		expect(
			{
				graphHashesEqual:
					receiver.vertices
						.map(({ hash }) => hash)
						.sort()
						.join() ===
					serial.vertices
						.map(({ hash }) => hash)
						.sort()
						.join(),
				localResult,
				notificationOrder: notifications.map(({ origin }) => origin),
				remoteResult,
				sameLiveState: JSON.stringify(receiver.drp?.values) === JSON.stringify(serial.drp?.values),
				sameStoredStateBytes,
				serialResult,
				whileSuspended,
			},
			"the local publication must CAS/reprepare after the merge instead of erasing its committed live state"
		).toEqual({
			graphHashesEqual: true,
			localResult: "appended:local",
			notificationOrder: ["merge", "callFn"],
			remoteResult: { applied: true, missing: [], invalid: [] },
			sameLiveState: true,
			sameStoredStateBytes: true,
			serialResult: { applied: true, missing: [], invalid: [] },
			whileSuspended: {
				localAbsent: true,
				remoteCommitted: true,
				remoteLive: ["remote"],
				remoteNotified: true,
			},
		});
	});

	it("leaves no torn trace when a multi-candidate canonical replay rejects one exclusive claim", async () => {
		const receiver = makeClaimReceiver();
		const notifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") notifications.push(...vertices.map(({ hash }) => hash));
		});
		const first = remoteVertex("claim", ["first"], 1);
		const second = remoteVertex("claim", ["second"], 2);
		const candidates = [first, second];
		const outcome = await settleApply(receiver, candidates);

		const committed = candidates.filter((vertex) => receiver.vertices.some(({ hash }) => hash === vertex.hash));
		const uncommitted = candidates.filter((vertex) => !committed.includes(vertex));
		const surfaces = candidates.map((vertex) => vertexSurfaces(receiver, vertex, notifications));
		const accounting = outcome.status === "resolved" ? outcome.result : outcome.partialResult;
		const expectedOwner =
			committed.length === 1
				? (committed[0].operation?.value[0] as string | undefined)
				: committed.length === 0
					? undefined
					: "impossible-multiple-exclusive-owners";

		expect(
			{
				accounting,
				exactAccounting: JSON.stringify(accounting) === JSON.stringify(expectedAccounting(uncommitted)),
				liveStateMatchesCommittedGraph: receiver.drp?.owner === expectedOwner,
				noCandidateHasMixedAuthoritativeSurfaces: surfaces.every(
					(surface) =>
						(surface.graph && surface.finality && surface.notified) ||
						(!surface.graph && !surface.finality && !surface.notified && !surface.snapshots)
				),
				noInvalidCombinedCommit: committed.length <= 1,
				replayFailureCrossed: exclusiveReplayFailures > 0,
				snapshotsValidWhenPresent: candidates.every((vertex) => claimSnapshotMatchesOwner(receiver, vertex)),
			},
			"a failing final replay must quarantine or reject only uncommitted candidates, never publish a torn graph"
		).toEqual({
			accounting: expectedAccounting(uncommitted),
			exactAccounting: true,
			liveStateMatchesCommittedGraph: true,
			noCandidateHasMixedAuthoritativeSurfaces: true,
			noInvalidCombinedCommit: true,
			replayFailureCrossed: true,
			snapshotsValidWhenPresent: true,
		});
	});

	it("still commits a successful multi-candidate mutation on every authoritative surface", async () => {
		const receiver = makeLogReceiver("receiver");
		const notifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") notifications.push(...vertices.map(({ hash }) => hash));
		});
		const first = remoteVertex("append", ["first"], 10);
		const second = remoteVertex("append", ["second"], 11);

		const result = await receiver.applyVertices([first, second]);
		const surfaces = [first, second].map((vertex) => vertexSurfaces(receiver, vertex, notifications));
		expect({
			liveValues: receiver.drp?.values.toSorted(),
			result,
			snapshotsValidWhenPresent:
				logSnapshotMatchesValue(receiver, first, "first") && logSnapshotMatchesValue(receiver, second, "second"),
			surfacesCommitted: surfaces.every(({ finality, graph, notified }) => finality && graph && notified),
		}).toEqual({
			liveValues: ["first", "second"],
			result: { applied: true, missing: [], invalid: [] },
			snapshotsValidWhenPresent: true,
			surfacesCommitted: true,
		});
	});

	it("attaches exact partial accounting when frontier CAS retries are exhausted", async () => {
		const receiver = makeLogReceiver("receiver");
		const candidate = remoteVertex("append", ["cas-exhausted"], 20);
		const applier = receiver["_applier"] as unknown as Record<string, unknown>;
		const originalTryCommit = applier.tryCommitPreparedVertex;
		let retryAttempts = 0;
		applier.tryCommitPreparedVertex = (): string => {
			retryAttempts++;
			return "retry";
		};

		try {
			const outcome = await settleApply(receiver, [candidate]);
			const error = outcome.status === "rejected" ? outcome.error : undefined;
			expect({
				candidateSurfaces: vertexSurfaces(receiver, candidate, []),
				errorIsAdoptionExhaustion: error instanceof AdoptionCommitExhaustedError,
				exactPartialResult:
					outcome.status === "rejected" &&
					JSON.stringify(outcome.partialResult) === JSON.stringify(expectedAccounting([candidate])),
				retryAttempts,
				status: outcome.status,
			}).toEqual({
				candidateSurfaces: { finality: false, graph: false, notified: false, snapshots: false },
				errorIsAdoptionExhaustion: true,
				exactPartialResult: true,
				retryAttempts: 3,
				status: "rejected",
			});
		} finally {
			applier.tryCommitPreparedVertex = originalTryCommit;
		}
	});

	it("attaches exact partial accounting when commit and rollback fail synchronously", async () => {
		const receiver = makeLogReceiver("receiver");
		const notifications: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "merge") notifications.push(...vertices.map(({ hash }) => hash));
		});
		const candidate = remoteVertex("append", ["invariant-candidate"], 30);
		const applier = receiver["_applier"] as unknown as {
			advanceCheckpointIfNeeded(...arguments_: unknown[]): void;
		};
		const hashGraph = receiver["hashGraph"];
		const originalAdvanceCheckpoint = applier.advanceCheckpointIfNeeded;
		const originalRemoveVertex = hashGraph.removeVertex;
		const primary = new Error("forced commit failure");
		const rollback = new Error("forced rollback failure");
		let checkpointCalls = 0;
		let graphInsertedBeforePrimary = false;
		let insertedVertex: Vertex | undefined;
		let liveStateBeforePrimary: string[] | undefined;
		let removeCalls = 0;
		let removedCandidateIdentity = false;
		let surfacesBeforePrimary: { finality: boolean; graph: boolean; notified: boolean; snapshots: boolean } | undefined;
		applier.advanceCheckpointIfNeeded = (): never => {
			checkpointCalls++;
			insertedVertex = hashGraph.vertices.get(candidate.hash);
			graphInsertedBeforePrimary = insertedVertex !== undefined;
			liveStateBeforePrimary = receiver.drp?.values;
			surfacesBeforePrimary = vertexSurfaces(receiver, candidate, notifications);
			throw primary;
		};
		hashGraph.removeVertex = (vertex, frontierRestorePoints): never => {
			removeCalls++;
			const removed = Reflect.apply(originalRemoveVertex, hashGraph, [vertex, frontierRestorePoints]) as boolean;
			removedCandidateIdentity ||= vertex === insertedVertex && removed;
			throw rollback;
		};

		try {
			const outcome = await settleApply(receiver, [candidate]);
			const error = outcome.status === "rejected" ? outcome.error : undefined;
			const aggregateErrors = error instanceof ApplyInvariantError ? error.errors : [];

			expect(
				{
					aggregateHasPrimaryIdentity: aggregateErrors[0] === primary,
					aggregateHasRollbackIdentity: aggregateErrors[1] === rollback,
					candidateNotificationEligible: notificationEligible(receiver, candidate.hash),
					candidateSurfaces: vertexSurfaces(receiver, candidate, notifications),
					checkpointCalls,
					errorIsApplyInvariant: error instanceof ApplyInvariantError,
					graphInsertedBeforePrimary,
					liveStateBeforePrimary,
					liveStateRestored: receiver.drp?.values,
					notifications,
					partialResult: outcome.status === "rejected" ? outcome.partialResult : undefined,
					removeCalls,
					removedCandidateIdentity,
					status: outcome.status,
					surfacesBeforePrimary,
				},
				"applyVertices must expose exact accounting while the journal removes every authoritative trace"
			).toEqual({
				aggregateHasPrimaryIdentity: true,
				aggregateHasRollbackIdentity: true,
				candidateNotificationEligible: false,
				candidateSurfaces: { finality: false, graph: false, notified: false, snapshots: false },
				checkpointCalls: 1,
				errorIsApplyInvariant: true,
				graphInsertedBeforePrimary: true,
				liveStateBeforePrimary: ["invariant-candidate"],
				liveStateRestored: [],
				notifications: [],
				partialResult: expectedAccounting([candidate]),
				removeCalls: 1,
				removedCandidateIdentity: true,
				status: "rejected",
				surfacesBeforePrimary: { finality: true, graph: true, notified: false, snapshots: true },
			});
		} finally {
			applier.advanceCheckpointIfNeeded = originalAdvanceCheckpoint;
			hashGraph.removeVertex = originalRemoveVertex;
		}
	});
});
