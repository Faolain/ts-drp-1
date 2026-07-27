import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

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

const barriers = new Map<string, OneShotBarrier>();

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

class SerializedLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	append(value: string): string {
		this.values.push(value);
		return `appended:${value}`;
	}

	async appendAfter(controlId: string, value: string): Promise<string> {
		const barrier = barriers.get(controlId);
		if (!barrier) throw new Error(`Missing barrier ${controlId}`);
		await barrier.wait();
		this.values.push(value);
		return `appended:${value}`;
	}

	async rejectAfter(controlId: string): Promise<never> {
		const barrier = barriers.get(controlId);
		if (!barrier) throw new Error(`Missing barrier ${controlId}`);
		await barrier.wait();
		throw new Error(`controlled rejection:${controlId}`);
	}
}

function makeReceiver(peerId = "receiver"): DRPObject<SerializedLogDRP> {
	return new DRPObject({
		peerId,
		acl: createACL({ admins: [peerId, "sender"] }),
		drp: new SerializedLogDRP(),
	});
}

function remoteVertex(opType: string, values: unknown[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value: values }),
		[HashGraph.rootHash],
		timestamp
	);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function operationVertex(receiver: DRPObject<SerializedLogDRP>, value: string): Vertex | undefined {
	return receiver.vertices.find(
		(vertex) => vertex.operation?.opType === "append" && vertex.operation.value[0] === value
	);
}

describe("Phase 0g(i) per-object mutation serialization", () => {
	it.each([
		{ outcome: "commit" as const, opType: "appendAfter" },
		{ outcome: "reject" as const, opType: "rejectAfter" },
	])(
		"keeps a synchronous local call linearized and published while a parked merge will $outcome",
		async ({ outcome, opType }) => {
			const receiver = makeReceiver();
			const controlId = `parked-${outcome}`;
			const barrier = installBarrier(controlId);
			const remote =
				outcome === "commit" ? remoteVertex(opType, [controlId, "remote"], 1) : remoteVertex(opType, [controlId], 1);
			const publications: {
				origin: string;
				hashes: string[];
				absentAtPublication: string[];
			}[] = [];
			receiver.subscribe((object, origin, vertices) => {
				const committed = new Set(object.vertices.map(({ hash }) => hash));
				publications.push({
					origin,
					hashes: vertices.map(({ hash }) => hash),
					absentAtPublication: vertices.map(({ hash }) => hash).filter((hash) => !committed.has(hash)),
				});
			});

			const merge = receiver.applyVertices([remote]);
			await barrier.entered.promise;

			const publicationCountBeforeLocalCall = publications.length;
			const localReturn: unknown = receiver.drp?.append("local");
			const local = operationVertex(receiver, "local");
			const publicationCountAfterLocalCall = publications.length;

			expect(
				{
					localCommittedBeforeMergeRelease: local !== undefined,
					localPublishedBeforeMergeRelease: publicationCountAfterLocalCall === publicationCountBeforeLocalCall + 1,
					localReturn,
					localReturnIsThenable: isThenable(localReturn),
					remoteCommittedBeforeRelease: receiver.vertices.some(({ hash }) => hash === remote.hash),
				},
				"a synchronous blueprint call must retain its synchronous return and commit latency while the merge is parked"
			).toEqual({
				localCommittedBeforeMergeRelease: true,
				localPublishedBeforeMergeRelease: true,
				localReturn: "appended:local",
				localReturnIsThenable: false,
				remoteCommittedBeforeRelease: false,
			});

			barrier.release.resolve();
			const mergeOutcome = await merge.then(
				(result) => ({ status: "fulfilled" as const, result }),
				(error: unknown) => ({
					status: "rejected" as const,
					message: error instanceof Error ? error.message : String(error),
				})
			);
			const finalHashes = new Set(receiver.vertices.map(({ hash }) => hash));

			expect(
				{
					localDependencies: local?.dependencies,
					mergeCommitted: finalHashes.has(remote.hash),
					mergeOutcome: mergeOutcome.status,
					notificationOrigins: publications.map(({ origin }) => origin),
					publishedButAbsentAtPublication: publications.flatMap(({ absentAtPublication }) => absentAtPublication),
					publishedButAbsentFinally: publications
						.flatMap(({ hashes }) => hashes)
						.filter((hash) => !finalHashes.has(hash)),
				},
				"the local commit must linearize before the parked merge and every publication must name a committed vertex"
			).toEqual({
				localDependencies: [HashGraph.rootHash],
				mergeCommitted: outcome === "commit",
				mergeOutcome: outcome === "commit" ? "fulfilled" : "rejected",
				notificationOrigins: outcome === "commit" ? ["callFn", "merge"] : ["callFn"],
				publishedButAbsentAtPublication: [],
				publishedButAbsentFinally: [],
			});
		}
	);

	it("keeps uncontended synchronous blueprint calls non-thenable and immediately visible", () => {
		const receiver = makeReceiver("uncontended");
		const published: string[] = [];
		receiver.subscribe((_object, origin, vertices) => {
			if (origin === "callFn") published.push(...vertices.map(({ hash }) => hash));
		});

		const result: unknown = receiver.drp?.append("now");
		const vertex = operationVertex(receiver, "now");

		expect({
			result,
			returnIsThenable: isThenable(result),
			vertexPresentOnReturn: vertex !== undefined,
			publishedBeforeReturn: vertex !== undefined && published.includes(vertex.hash),
		}).toEqual({
			result: "appended:now",
			returnIsThenable: false,
			vertexPresentOnReturn: true,
			publishedBeforeReturn: true,
		});
	});

	it("chains two un-awaited asynchronous local calls through the first authored hash", async () => {
		const receiver = makeReceiver("local-chain");
		const firstBarrier = installBarrier("local-chain-first");
		const secondBarrier = installBarrier("local-chain-second");

		const firstCall = receiver.drp?.appendAfter("local-chain-first", "first");
		await firstBarrier.entered.promise;
		const secondCall = receiver.drp?.appendAfter("local-chain-second", "second");
		const secondEnteredBeforeFirstReleased = secondBarrier.invocations !== 0;

		firstBarrier.release.resolve();
		await firstCall;
		await secondBarrier.entered.promise;
		secondBarrier.release.resolve();
		await secondCall;

		const first = receiver.vertices.find(
			(vertex) => vertex.operation?.opType === "appendAfter" && vertex.operation.value[1] === "first"
		);
		const second = receiver.vertices.find(
			(vertex) => vertex.operation?.opType === "appendAfter" && vertex.operation.value[1] === "second"
		);

		expect(
			{
				firstHash: first?.hash,
				secondEnteredBeforeFirstReleased,
				secondDependencies: second?.dependencies,
			},
			"completion order is insufficient: the second locally authored vertex must be causally linked to the first"
		).toEqual({
			firstHash: expect.any(String),
			secondEnteredBeforeFirstReleased: false,
			secondDependencies: [first?.hash],
		});
	});

	it("does not serialize local mutations belonging to independent objects", async () => {
		const left = makeReceiver("object-local-left");
		const right = makeReceiver("object-local-right");
		const leftBarrier = installBarrier("object-local-left");
		const rightBarrier = installBarrier("object-local-right");

		const leftCall = left.drp?.appendAfter("object-local-left", "left");
		await leftBarrier.entered.promise;
		const rightCall = right.drp?.appendAfter("object-local-right", "right");
		const rightEnteredWhileLeftWasParked = rightBarrier.invocations !== 0;

		leftBarrier.release.resolve();
		rightBarrier.release.resolve();
		await Promise.all([leftCall, rightCall]);

		expect(
			rightEnteredWhileLeftWasParked,
			"the mutation lane is per object; a process-global mutex must not block an independent object"
		).toBe(true);
	});

	it("preserves owner DRP and ACL identities across seed-pinned overlapping merge schedules", async () => {
		// These seeds cover all four start-order × release-order pairs.
		const seeds = [0x1, 0x2, 0x7, 0x8];

		for (const seed of seeds) {
			const receiver = makeReceiver(`schedule-${seed}`);
			const applier = receiver["_applier"];
			const ownerDRP = receiver.drp;
			const ownerACL = receiver.acl;
			const ownerFinalityStore = receiver["_finalityStore"];
			const ownerHashGraph = receiver["hashGraph"];
			const ownerStates = receiver["_states"];
			const assertOwnerIdentities = (phase: string): void => {
				const message = `seed=${seed} phase=${phase}: owner stores must never be rebound or cross-wired`;
				expect(receiver.acl, message).toBe(ownerACL);
				expect(receiver.drp, message).toBe(ownerDRP);
				expect(applier.acl, message).toBe(ownerACL);
				expect(applier.drp, message).toBe(ownerDRP);
				expect(applier["finalityStore"], message).toBe(ownerFinalityStore);
				expect(applier["hashGraph"], message).toBe(ownerHashGraph);
				expect(applier["states"], message).toBe(ownerStates);
			};
			const controls = [0, 1].map((index) => {
				const controlId = `schedule-${seed}-${index}`;
				return { barrier: installBarrier(controlId), controlId, index };
			});
			const startOrder = seededOrder(seed);
			const releaseOrder = seededOrder((seed + 0x9e3779b9) >>> 0);
			const pending: Promise<unknown>[] = [];

			for (const index of startOrder) {
				const { controlId } = controls[index];
				pending[index] = receiver.applyVertices([
					remoteVertex("appendAfter", [controlId, `remote-${index}`], 10 + index),
				]);
			}
			assertOwnerIdentities("both-started");

			const enteredBeforeRelease = releaseOrder.filter((index) => controls[index].barrier.invocations !== 0);
			const firstToRelease = enteredBeforeRelease[0];
			if (firstToRelease === undefined) {
				throw new Error(`seed=${seed}: at least the first scheduled merge must enter its blueprint`);
			}
			const actualReleaseOrder = [firstToRelease, ...releaseOrder.filter((index) => index !== firstToRelease)] as [
				number,
				number,
			];

			for (const index of actualReleaseOrder) {
				await controls[index].barrier.entered.promise;
				controls[index].barrier.release.resolve();
				await pending[index];
				assertOwnerIdentities(`settled-${index}`);
			}
		}
	});
});

function seededOrder(seed: number): [number, number] {
	let state = seed >>> 0;
	state ^= state << 13;
	state ^= state >>> 17;
	state ^= state << 5;
	return (state >>> 0) % 2 === 0 ? [0, 1] : [1, 0];
}
