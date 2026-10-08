import "./helpers/trusted-vertex-ingest.js";

import { DrpType, type IDRP, Operation, SemanticsType, Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { expectGraphWellFormedAfterFailure, expectTransientReported } from "./merge-failure-invariants.js";
import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

interface AsyncOperationControl {
	entered: Deferred;
	release: Deferred;
}

const controls = new Map<string, AsyncOperationControl>();

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function control(id: string): AsyncOperationControl {
	const operationControl = { entered: deferred(), release: deferred() };
	controls.set(id, operationControl);
	return operationControl;
}

class GatedLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	async failAfterRelease(controlId: string): Promise<void> {
		const operationControl = controls.get(controlId);
		if (!operationControl) throw new Error(`Missing operation control ${controlId}`);
		operationControl.entered.resolve();
		await operationControl.release.promise;
		throw new Error("controlled transient merge failure");
	}
}

function makeVertex(
	opType: string,
	value: unknown[],
	dependencies: string[],
	timestamp: number,
	peerId = "sender"
): Vertex {
	return createVertex(peerId, Operation.create({ drpType: DrpType.DRP, opType, value }), dependencies, timestamp);
}

function makeReceiver(): DRPObject<GatedLogDRP> {
	return new DRPObject({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new GatedLogDRP(),
	});
}

function subscribe(receiver: DRPObject<GatedLogDRP>): { local: string[]; merge: string[] } {
	const notifications = { local: [] as string[], merge: [] as string[] };
	receiver.subscribe((_object, origin, vertices) => {
		if (origin === "callFn") notifications.local.push(...vertices.map(({ hash }) => hash));
		if (origin === "merge") notifications.merge.push(...vertices.map(({ hash }) => hash));
	});
	return notifications;
}

describe("merge concurrency regression schedules", () => {
	it("keeps A reachable when a notified local child commits before B makes [A, B] fail", async () => {
		const failure = control("local-child");
		const receiver = makeReceiver();
		const notifications = subscribe(receiver);
		const a = makeVertex("append", [1], [HashGraph.rootHash], 1);
		const b = makeVertex("failAfterRelease", ["local-child"], [a.hash], 2);

		const failingBatch = receiver.applyVertices([a, b]);
		await failure.entered.promise;

		receiver.drp?.append(2);
		const childHash = notifications.local.at(-1);
		expect(childHash, "positive control: the interleaved local child must be notified").toBeDefined();
		expect(
			receiver.vertices.find(({ hash }) => hash === childHash)?.dependencies,
			"positive control: the interleaved local call must actually build on A"
		).toContain(a.hash);

		failure.release.resolve();
		await expectTransientReported(failingBatch, b.hash, "positive control: B must take the controlled transient path");

		expect(
			{
				aInGraph: receiver.vertices.some(({ hash }) => hash === a.hash),
				childInGraph: receiver.vertices.some(({ hash }) => hash === childHash),
				childParentInGraph: receiver.vertices
					.find(({ hash }) => hash === childHash)
					?.dependencies.every((dependency) => receiver.vertices.some(({ hash }) => hash === dependency)),
				localNotification: notifications.local.includes(childHash ?? ""),
			},
			"rollback must not delete A after a notified local transaction commits its child"
		).toEqual({
			aInGraph: true,
			childInGraph: true,
			childParentInGraph: true,
			localNotification: true,
		});

		await expectGraphWellFormedAfterFailure(
			receiver,
			1001,
			"a local-child interleaving must preserve reachability and allow later merges"
		);
	});

	it("keeps A reachable when a notified overlapping peer merge commits A's child before B fails", async () => {
		const failure = control("peer-child");
		const receiver = makeReceiver();
		const notifications = subscribe(receiver);
		const a = makeVertex("append", [10], [HashGraph.rootHash], 10);
		const b = makeVertex("failAfterRelease", ["peer-child"], [a.hash], 11);
		const child = makeVertex("append", [20], [a.hash], 12);

		const failingBatch = receiver.applyVertices([a, b]);
		await failure.entered.promise;
		const childResult = await receiver.applyVertices([child]);
		expect(
			{
				childResult,
				notified: notifications.merge.includes(child.hash),
				parentAtCommit: receiver.vertices.some(({ hash }) => hash === a.hash),
			},
			"positive control: the overlapping peer child must commit and notify while A exists"
		).toEqual({
			childResult: { applied: true, missing: [], invalid: [] },
			notified: true,
			parentAtCommit: true,
		});

		failure.release.resolve();
		await expectTransientReported(failingBatch, b.hash, "positive control: B must take the controlled transient path");
		expect(
			{
				aInGraph: receiver.vertices.some(({ hash }) => hash === a.hash),
				childInGraph: receiver.vertices.some(({ hash }) => hash === child.hash),
				childParentInGraph: child.dependencies.every((dependency) =>
					receiver.vertices.some(({ hash }) => hash === dependency)
				),
			},
			"rollback must not orphan a child committed by an overlapping peer merge"
		).toEqual({ aInGraph: true, childInGraph: true, childParentInGraph: true });

		await expectGraphWellFormedAfterFailure(
			receiver,
			1002,
			"a peer-child interleaving must preserve reachability and allow later merges"
		);
	});

	it("restores childless B to a multi-head frontier after concurrent merges consume its anchors", async () => {
		const failure = control("multi-head");
		const receiver = makeReceiver();
		const a = makeVertex("append", [100], [HashGraph.rootHash], 20);
		const b = makeVertex("append", [200], [HashGraph.rootHash], 21);
		const c = makeVertex("append", [300], [HashGraph.rootHash], 22);
		await expect(
			receiver.applyVertices([a, b, c]),
			"positive control: A, B, and C must establish the intended three-head frontier"
		).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(receiver["hashGraph"].getFrontier()).toEqual([a.hash, b.hash, c.hash]);

		const onlyB = makeVertex("append", [400], [b.hash], 23);
		const poison = makeVertex("failAfterRelease", ["multi-head"], [onlyB.hash], 24);
		const consumesAAndC = makeVertex("append", [500], [a.hash, c.hash], 25);
		const failingBatch = receiver.applyVertices([onlyB, poison]);
		await failure.entered.promise;
		const concurrentResult = await receiver.applyVertices([consumesAAndC]);
		expect(
			{
				concurrentResult,
				consumedA: !receiver["hashGraph"].getFrontier().includes(a.hash),
				consumedC: !receiver["hashGraph"].getFrontier().includes(c.hash),
			},
			"positive control: the concurrent committed merge must consume both restoration anchors"
		).toEqual({
			concurrentResult: { applied: true, missing: [], invalid: [] },
			consumedA: true,
			consumedC: true,
		});

		failure.release.resolve();
		await expectTransientReported(
			failingBatch,
			poison.hash,
			"positive control: the second batch vertex must fail after onlyB was inserted"
		);

		const bChildren = receiver["hashGraph"].forwardEdges.get(b.hash) ?? [];
		expect(
			{
				bChildless: bChildren.length === 0,
				bPresentWhenChildless: bChildren.length !== 0 || receiver["hashGraph"].getFrontier().includes(b.hash),
			},
			"a rolled-back only-B child must restore B to the frontier whenever B becomes childless"
		).toEqual({
			bChildless: !receiver.vertices.some(({ hash }) => hash === onlyB.hash),
			bPresentWhenChildless: true,
		});

		await expectGraphWellFormedAfterFailure(
			receiver,
			1003,
			"multi-head rollback must retain exactly every childless head and every applied operation"
		);
		expect(
			receiver.drp?.values,
			"no operation from A, B, C, or the committed concurrent merge may disappear from live state"
		).toEqual(expect.arrayContaining([100, 200, 300, 500, 1003]));
	});

	it("retains one complete same-hash survivor when an overlapping batch observes a distinct decoded instance", async () => {
		const failure = control("same-hash");
		const receiver = makeReceiver();
		const notifications = subscribe(receiver);
		const shared = makeVertex("append", [700], [HashGraph.rootHash], 30);
		const decodedShared = Vertex.decode(Vertex.encode(shared).finish());
		expect(decodedShared, "positive control: decoding must produce a distinct Vertex instance").not.toBe(shared);
		expect(decodedShared.hash).toBe(shared.hash);

		const poison = makeVertex("failAfterRelease", ["same-hash"], [shared.hash], 31);
		const child = makeVertex("append", [800], [shared.hash], 32);
		const failingBatch = receiver.applyVertices([shared, poison]);
		await failure.entered.promise;

		const overlappingResult = await receiver.applyVertices([decodedShared, child]);
		expect(
			{
				childNotified: notifications.merge.includes(child.hash),
				overlappingResult,
				sharedPresentAtCommit: receiver.vertices.some(({ hash }) => hash === shared.hash),
			},
			"positive control: the overlapping batch must commit a notified child while observing the shared hash"
		).toEqual({
			childNotified: true,
			overlappingResult: { applied: true, missing: [], invalid: [] },
			sharedPresentAtCommit: true,
		});

		failure.release.resolve();
		await expectTransientReported(
			failingBatch,
			poison.hash,
			"positive control: the owner batch must reach its controlled failure"
		);
		const frontier = receiver["hashGraph"].getFrontier();
		const [aclState, drpState] = receiver.getStates(shared.hash);
		expect(
			{
				duplicateFrontierEntries: frontier.filter((hash, index) => frontier.indexOf(hash) !== index),
				finality: receiver.finalityStore.states.has(shared.hash),
				sameHashGraphEntries: receiver.vertices.filter(({ hash }) => hash === shared.hash).length,
				snapshots: [aclState !== undefined, drpState !== undefined],
			},
			"the same-hash survivor must remain singular and complete after the overlapping owner rolls back"
		).toEqual({
			duplicateFrontierEntries: [],
			finality: true,
			sameHashGraphEntries: 1,
			snapshots: [true, true],
		});

		await expectGraphWellFormedAfterFailure(
			receiver,
			1004,
			"same-hash overlap must preserve the survivor's reachability and later merge liveness"
		);
	});
});
