import { ACLGroup, DrpType, type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
import { beforeEach, describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
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

class HardeningLogDRP implements IDRP {
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

function makeReceiver(peerId: string): DRPObject<HardeningLogDRP> {
	return new DRPObject({
		peerId,
		acl: createACL({ admins: [peerId] }),
		drp: new HardeningLogDRP(),
	});
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function findVertex(
	receiver: DRPObject<HardeningLogDRP>,
	drpType: DrpType,
	opType: string,
	value: unknown
): Vertex | undefined {
	return receiver.vertices.find(
		(vertex) =>
			vertex.operation?.drpType === drpType && vertex.operation.opType === opType && vertex.operation.value[0] === value
	);
}

async function passMicrotaskSentinel(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("Phase 0g(i) local mutation lane hardening", () => {
	beforeEach(() => {
		barriers.clear();
	});

	it("drains a rejected async call before the queued call and restores the synchronous idle path", async () => {
		const receiver = makeReceiver("rejection-recovery");
		const baselineResult: unknown = receiver.drp?.append("baseline");
		const baseline = findVertex(receiver, DrpType.DRP, "append", "baseline");
		const rejectionBarrier = installBarrier("rejection-recovery-active");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const active = receiver.drp?.rejectAfter("rejection-recovery-active");
			const activeSettlement = Promise.resolve(active).then(
				() => ({ status: "fulfilled" as const, message: "" }),
				(error: unknown) => ({
					status: "rejected" as const,
					message: error instanceof Error ? error.message : String(error),
				})
			);
			await rejectionBarrier.entered.promise;

			const queuedReturn: unknown = receiver.drp?.append("queued-after-rejection");
			await passMicrotaskSentinel();
			const beforeRelease = {
				baselineResult,
				baselineHash: baseline?.hash,
				queuedReturnIsThenable: isThenable(queuedReturn),
				queuedExecutedBeforeRelease: receiver.drp?.values.includes("queued-after-rejection"),
				queuedVertexBeforeRelease: findVertex(receiver, DrpType.DRP, "append", "queued-after-rejection") !== undefined,
			};
			let queuedSettlement:
				| { status: "pending" }
				| { status: "fulfilled"; value: unknown }
				| { status: "rejected"; reason: unknown } = { status: "pending" };
			void Promise.resolve(queuedReturn).then(
				(value) => {
					queuedSettlement = { status: "fulfilled", value };
				},
				(reason: unknown) => {
					queuedSettlement = { status: "rejected", reason };
				}
			);

			rejectionBarrier.release.resolve();
			const activeOutcome = await activeSettlement;
			await passMicrotaskSentinel();

			expect({ beforeRelease, activeOutcome, queuedSettlement }).toEqual({
				beforeRelease: {
					baselineResult: "appended:baseline",
					baselineHash: expect.any(String),
					queuedReturnIsThenable: true,
					queuedExecutedBeforeRelease: false,
					queuedVertexBeforeRelease: false,
				},
				activeOutcome: {
					status: "rejected",
					message: "controlled rejection:rejection-recovery-active",
				},
				queuedSettlement: {
					status: "fulfilled",
					value: "appended:queued-after-rejection",
				},
			});

			const queued = findVertex(receiver, DrpType.DRP, "append", "queued-after-rejection");
			const idleReturn: unknown = receiver.drp?.append("idle-after-recovery");
			const idle = findVertex(receiver, DrpType.DRP, "append", "idle-after-recovery");
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});

			expect({
				queuedDependencies: queued?.dependencies,
				idleReturn,
				idleReturnIsThenable: isThenable(idleReturn),
				idleDependencies: idle?.dependencies,
				unhandled,
			}).toEqual({
				queuedDependencies: [baseline?.hash],
				idleReturn: "appended:idle-after-recovery",
				idleReturnIsThenable: false,
				idleDependencies: [queued?.hash],
				unhandled: [],
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("shares one lane between DRP and ACL calls and authors the contended grant from the DRP frontier", async () => {
		const receiver = makeReceiver("shared-acl-drp-lane");
		const activeBarrier = installBarrier("shared-acl-drp-lane-active");
		const activeReturn = receiver.drp?.appendAfter("shared-acl-drp-lane-active", "drp-first");
		await activeBarrier.entered.promise;

		const grantReturn: unknown = receiver.acl.grant("new-finality-signer", ACLGroup.Finality);
		await passMicrotaskSentinel();
		const beforeRelease = {
			grantReturnIsThenable: isThenable(grantReturn),
			grantVisibleBeforeRelease: receiver.acl.query_isFinalitySigner("new-finality-signer"),
			grantVertexBeforeRelease: findVertex(receiver, DrpType.ACL, "grant", "new-finality-signer") !== undefined,
		};

		activeBarrier.release.resolve();
		const [activeResult, grantResult] = await Promise.all([
			Promise.resolve(activeReturn),
			Promise.resolve(grantReturn),
		]);
		const active = findVertex(receiver, DrpType.DRP, "appendAfter", "shared-acl-drp-lane-active");
		const grant = findVertex(receiver, DrpType.ACL, "grant", "new-finality-signer");

		expect({
			beforeRelease,
			activeResult,
			grantResult,
			grantVisible: receiver.acl.query_isFinalitySigner("new-finality-signer"),
			activeHash: active?.hash,
			grantDependencies: grant?.dependencies,
		}).toEqual({
			beforeRelease: {
				grantReturnIsThenable: true,
				grantVisibleBeforeRelease: false,
				grantVertexBeforeRelease: false,
			},
			activeResult: "appended:drp-first",
			grantResult: undefined,
			grantVisible: true,
			activeHash: expect.any(String),
			grantDependencies: [active?.hash],
		});
	});

	it("makes a synchronous DRP call conditionally asynchronous only while the local lane is contended", async () => {
		const receiver = makeReceiver("conditional-sync-contract");
		const activeBarrier = installBarrier("conditional-sync-contract-active");
		const activeReturn = receiver.drp?.appendAfter("conditional-sync-contract-active", "async-first");
		await activeBarrier.entered.promise;

		const queuedReturn: unknown = receiver.drp?.append("sync-behind-async");
		await passMicrotaskSentinel();
		const beforeRelease = {
			queuedReturnIsThenable: isThenable(queuedReturn),
			stateBeforeRelease: [...(receiver.drp?.values ?? [])],
			queuedVertexBeforeRelease: findVertex(receiver, DrpType.DRP, "append", "sync-behind-async") !== undefined,
		};

		activeBarrier.release.resolve();
		const [activeResult, queuedResult] = await Promise.all([
			Promise.resolve(activeReturn),
			Promise.resolve(queuedReturn),
		]);
		const active = findVertex(receiver, DrpType.DRP, "appendAfter", "conditional-sync-contract-active");
		const queued = findVertex(receiver, DrpType.DRP, "append", "sync-behind-async");
		const idleReturn: unknown = receiver.drp?.append("sync-when-idle");
		const idle = findVertex(receiver, DrpType.DRP, "append", "sync-when-idle");

		expect({
			beforeRelease,
			activeResult,
			queuedResult,
			stateAfterDrain: receiver.drp?.values,
			activeHash: active?.hash,
			queuedDependencies: queued?.dependencies,
			idleReturn,
			idleReturnIsThenable: isThenable(idleReturn),
			idleDependencies: idle?.dependencies,
		}).toEqual({
			beforeRelease: {
				queuedReturnIsThenable: true,
				stateBeforeRelease: [],
				queuedVertexBeforeRelease: false,
			},
			activeResult: "appended:async-first",
			queuedResult: "appended:sync-behind-async",
			stateAfterDrain: ["async-first", "sync-behind-async", "sync-when-idle"],
			activeHash: expect.any(String),
			queuedDependencies: [active?.hash],
			idleReturn: "appended:sync-when-idle",
			idleReturnIsThenable: false,
			idleDependencies: [queued?.hash],
		});
	});

	it("queues a subscriber's reentrant public mutation without deadlock and links it after the publishing vertex", async () => {
		const receiver = makeReceiver("subscriber-reentrancy");
		const activeBarrier = installBarrier("subscriber-reentrancy-active");
		let nestedReturn: unknown;
		let nestedCalls = 0;

		receiver.subscribe((_object, origin, vertices) => {
			const publishedActive = vertices.some(
				(vertex) =>
					vertex.operation?.drpType === DrpType.DRP &&
					vertex.operation.opType === "appendAfter" &&
					vertex.operation.value[0] === "subscriber-reentrancy-active"
			);
			if (origin !== "callFn" || !publishedActive) return;
			nestedCalls++;
			nestedReturn = receiver.drp?.append("subscriber-nested");
		});

		const activeReturn = receiver.drp?.appendAfter("subscriber-reentrancy-active", "published-first");
		await activeBarrier.entered.promise;
		const nestedCallsBeforeRelease = nestedCalls;

		activeBarrier.release.resolve();
		const activeResult = await activeReturn;
		expect({
			activeResult,
			nestedCallsBeforeRelease,
			nestedCalls,
			nestedReturnIsThenable: isThenable(nestedReturn),
		}).toEqual({
			activeResult: "appended:published-first",
			nestedCallsBeforeRelease: 0,
			nestedCalls: 1,
			nestedReturnIsThenable: true,
		});

		const nestedResult = await Promise.resolve(nestedReturn);
		const active = findVertex(receiver, DrpType.DRP, "appendAfter", "subscriber-reentrancy-active");
		const nested = findVertex(receiver, DrpType.DRP, "append", "subscriber-nested");

		expect({
			nestedResult,
			activeHash: active?.hash,
			nestedDependencies: nested?.dependencies,
			finalState: receiver.drp?.values,
		}).toEqual({
			nestedResult: "appended:subscriber-nested",
			activeHash: expect.any(String),
			nestedDependencies: [active?.hash],
			finalState: ["published-first", "subscriber-nested"],
		});
	});

	it("keeps independent objects progressing while another object's local lane is parked", async () => {
		const parked = makeReceiver("hardening-independent-parked");
		const progressing = makeReceiver("hardening-independent-progressing");
		const parkedBarrier = installBarrier("hardening-independent-parked");
		const progressingBarrier = installBarrier("hardening-independent-progressing");

		const parkedReturn = parked.drp?.appendAfter("hardening-independent-parked", "parked");
		await parkedBarrier.entered.promise;
		const progressingReturn = progressing.drp?.appendAfter("hardening-independent-progressing", "progressing");
		await progressingBarrier.entered.promise;

		expect({
			progressingEntered: progressingBarrier.invocations,
			progressingVertexBeforeItsRelease:
				findVertex(progressing, DrpType.DRP, "appendAfter", "hardening-independent-progressing") !== undefined,
		}).toEqual({
			progressingEntered: 1,
			progressingVertexBeforeItsRelease: false,
		});

		progressingBarrier.release.resolve();
		await progressingReturn;
		expect(findVertex(progressing, DrpType.DRP, "appendAfter", "hardening-independent-progressing")?.hash).toEqual(
			expect.any(String)
		);

		parkedBarrier.release.resolve();
		await parkedReturn;
	});
});
