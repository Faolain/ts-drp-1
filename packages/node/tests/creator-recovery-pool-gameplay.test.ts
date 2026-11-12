import {readFileSync} from "node:fs";
import * as ts from "typescript";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	resolveRecoveryPoolAutoMaintenanceOptions,
	startRecoveryPoolAutoScheduler,
	type RecoveryPoolAutoMaintenanceOutcome,
} from "../src/internal/recovery-pool-auto.js";
import type {CreatorRecoveryPoolResult} from "../src/internal/creator-recovery-pool.js";

// Execute the actual v3-live bodies with controlled premises (queue, capture,
// authentication). Native retirement and admission are not exercised here; the
// integrated Grid benchmark's concurrent mode covers them end to end.
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("live.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
	const nodes = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (nodes.length !== 1) throw new Error(`missing actual function:${name}:${nodes.length}`);
	return nodes[0]!.getText(tree);
}
function load(names: string[], bindings: Record<string, unknown>) {
	const js = ts.transpileModule(`${names.map(declaration).join("\n")}\nreturn ${names.at(-1)};`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
}

function ingressFixture() {
	const calls: string[] = [], registration: any = {blueprintClosing: false};
	class InputCaptureCapacityError extends Error {}
	const enqueue = load(["enqueueCapturedV3Ingress", "settleIngressJob", "enqueueV3Ingress"], {
		currentRegistration: () => true, InputCaptureCapacityError,
		// Same-epoch carry bookkeeping (no carry is open in this fixture).
		ingressJobsInFlight: new WeakMap(), pendingIngressCarries: new WeakMap(), deletePendingIngressCarry: () => undefined,
		ingressFailureLog: (reason: string) => {calls.push(`log:${reason}`);},
		captureV3Ingress: () => ({exactWireBytes: Uint8Array.of(1), sender: "peer", transport: "gossip"}),
		authenticateV3Ingress: async () => {calls.push("authenticate");},
		enqueueRegistrationTask: (_: unknown, capture: (custody: object) => () => Promise<void>) => {
			calls.push("enqueue"); return capture({})();
		},
	});
	return {calls, registration, enqueue: () => enqueue(registration, {type: 1}) as Promise<void>};
}

describe("ingress during a quiescent pool boundary", () => {
	it("queues arrivals behind an entered pool boundary instead of dropping them", async () => {
		const f = ingressFixture();
		f.registration.blueprintClosing = true; f.registration.readinessMaintenanceEntered = true;
		await f.enqueue();
		expect(f.calls).toEqual(["enqueue", "authenticate"]);
	});

	it("keeps dropping arrivals at a real close or after a failed boundary", async () => {
		for (const entered of [undefined, false]) {
			const f = ingressFixture();
			f.registration.blueprintClosing = true; f.registration.readinessMaintenanceEntered = entered;
			await f.enqueue();
			expect(f.calls).toEqual([]);
		}
		const open = ingressFixture();
		await open.enqueue();
		expect(open.calls).toEqual(["enqueue", "authenticate"]);
	});
});

function boundaryFixture() {
	const calls: string[] = [], snapshots = {}, plane = {}, store = {}, floor = {}, journal = {}, issuance = {};
	const trust = {objectId: "room", currentEpoch: 3, currentAnchorDigest: "anchor", profileId: "profile", genesisAnchorDigest: "genesis"};
	const registration: any = {payload: {input: {store, settlementFloor: floor}, trust: {trust, head: {kind: "present"}}, provenance: {objectId: "room"}},
		authorization: {kind: "latched-acl"}, issuanceScope: {objectId: "room", author: "writer"},
		liveJournalStore: journal, issuanceStore: issuance, snapshotReadiness: {owner: snapshots}, mode: "genesis-active",
		terminalState: "active", blueprintClosing: false, blueprintFolded: false, blueprintHandle: {},
		pendingIngress: new Map(), pendingIngressBytes: 0};
	const state = {slotOpen: false, sealFails: false};
	const run = load(["creatorRetirementResumeRequested", "runCreatorOrdinaryReadinessMaintenance"], {
		ObjectFreeze: Object.freeze, sameHead: () => true, sameCreatorRoomHead: () => true,
		currentRegistration: (value: object) => value === registration,
		creatorOrdinaryIssuanceRetainedSourceBindings: () => [],
		preparedMigrationTargetFloors: new WeakMap(), sameScope: () => true,
		// One FIFO slot: record when it is held so `after` can be shown inside it.
		enqueueRegistrationTask: async (_: unknown, capture: () => () => Promise<void>) => {
			state.slotOpen = true;
			try { await capture()(); } finally { state.slotOpen = false; calls.push("slot-released"); }
		},
		captureCreatorRecoveryRuntime: () => ({live: () => true, sourceBound: true}),
		sealCreatorRecoveryDependencies: async () => {
			calls.push(`seal:entered=${registration.readinessMaintenanceEntered}`);
			if (state.sealFails) throw new Error("seal failed");
			return {};
		},
		resolveRecoveryCloseHold: () => ({release: async () => {calls.push("release");}}),
		consumeCreatorRecoverySourceRetirement: async () => [],
	});
	const consume = async (seal: () => Promise<object>) => {await seal(); return "complete" as const;};
	return {calls, registration, state,
		run: (options?: object) => run(registration, plane, snapshots, consume, options) as Promise<"ran" | "deferred">};
}

describe("pool boundary queue slot", () => {
	it("marks only an entered opt-in pool boundary as queueing, then clears it", async () => {
		const pool = boundaryFixture();
		await expect(pool.run({deferrable: true})).resolves.toBe("ran");
		expect(pool.calls).toEqual(["seal:entered=true", "release", "slot-released"]);
		expect(pool.registration.readinessMaintenanceEntered).toBe(false);
		expect(pool.registration.blueprintClosing).toBe(false);
		const original = boundaryFixture();
		await expect(original.run()).resolves.toBe("ran");
		expect(original.calls).toEqual(["seal:entered=false", "release", "slot-released"]);
	});

	it("runs the post-boundary capture after release but inside the same slot", async () => {
		const f = boundaryFixture();
		const seen: unknown[] = [];
		await f.run({deferrable: true, after: async () => {
			seen.push({slotOpen: f.state.slotOpen, closing: f.registration.blueprintClosing,
				queueing: f.registration.readinessMaintenanceEntered});
			f.calls.push("after");
		}});
		expect(seen).toEqual([{slotOpen: true, closing: false, queueing: false}]);
		expect(f.calls).toEqual(["seal:entered=true", "release", "after", "slot-released"]);
	});

	it("never runs the post-boundary capture for a deferred or failed boundary", async () => {
		const deferred = boundaryFixture();
		deferred.registration.pendingIngress.set("pending", {});
		const after = vi.fn(async () => undefined);
		await expect(deferred.run({deferrable: true, after})).resolves.toBe("deferred");
		const failed = boundaryFixture(); failed.state.sealFails = true;
		await expect(failed.run({deferrable: true, after})).rejects.toThrow();
		expect(after).not.toHaveBeenCalled();
		// The halt stays and arrivals revert to the closing gate's drop rule.
		expect(failed.registration.operationAdmissionHalted).toBe(true);
		expect(failed.registration.blueprintClosing).toBe(true);
		expect(failed.registration.readinessMaintenanceEntered).toBe(false);
	});

	it("propagates a failed post-boundary capture to the caller", async () => {
		const f = boundaryFixture();
		await expect(f.run({deferrable: true, after: async () => {throw new Error("capture failed");}})).rejects.toThrow("capture failed");
		expect(f.registration.blueprintClosing).toBe(false);
	});
});

describe("automatic idle recovery-pool maintenance", () => {
	beforeEach(() => {vi.useFakeTimers();});
	afterEach(() => {vi.useRealTimers();});

	function scheduler(results: (CreatorRecoveryPoolResult | Error)[], options: object = {}) {
		const room = {activity: [1] as unknown[], busy: false, epoch: 4 as number | undefined, open: true};
		const outcomes: RecoveryPoolAutoMaintenanceOutcome[] = [];
		const maintain = vi.fn(async (): Promise<CreatorRecoveryPoolResult> => {
			const next = results.shift() ?? {kind: "not-needed"};
			if (next instanceof Error) throw next;
			return next;
		});
		const handle = startRecoveryPoolAutoScheduler({
			options: {idleMilliseconds: 100, maxBackoffMilliseconds: 400, onResult: outcome => outcomes.push(outcome), ...options},
			activity: () => [...room.activity], busy: () => room.busy, epoch: () => room.epoch, open: () => room.open,
			maintain, now: () => Date.now(),
			setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
			clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
		return {room, outcomes, maintain, handle};
	}

	it("runs once per epoch after an idle period", async () => {
		const s = scheduler([{kind: "maintained"}]);
		await vi.advanceTimersByTimeAsync(99);
		expect(s.maintain).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		s.room.epoch = 5;
		await vi.advanceTimersByTimeAsync(100);
		expect(s.maintain).toHaveBeenCalledTimes(2);
		expect(s.outcomes.map(o => [o.kind, o.epoch])).toEqual([["result", 4], ["result", 5]]);
		s.handle.stop();
	});

	it("waits while the room is active or busy", async () => {
		const s = scheduler([]);
		for (let step = 0; step < 5; step++) {
			s.room.activity = [step + 2];
			await vi.advanceTimersByTimeAsync(100);
		}
		s.room.busy = true;
		await vi.advanceTimersByTimeAsync(300);
		s.room.epoch = undefined; s.room.busy = false;
		await vi.advanceTimersByTimeAsync(300);
		expect(s.maintain).not.toHaveBeenCalled();
		s.room.epoch = 4;
		await vi.advanceTimersByTimeAsync(100);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		s.handle.stop();
	});

	it("backs off exponentially on busy results, capped, and settles afterwards", async () => {
		const busy = {kind: "deferred", reason: "busy"} as const;
		const s = scheduler([busy, busy, busy, busy, {kind: "maintained"}]);
		const at: number[] = [];
		s.maintain.mockImplementation(async () => {at.push(Date.now()); return [busy, busy, busy, busy][at.length - 1] ?? {kind: "maintained"};});
		const start = Date.now();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(at.map(t => t - start)).toEqual([100, 300, 700, 1_100, 1_500]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(at).toHaveLength(5);
		s.handle.stop();
	});

	it("does not retry an unsupported epoch and stops after a failure", async () => {
		const s = scheduler([{kind: "deferred", reason: "unsupported"}, new Error("halted")]);
		await vi.advanceTimersByTimeAsync(500);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		s.room.epoch = 5;
		await vi.advanceTimersByTimeAsync(100);
		expect(s.maintain).toHaveBeenCalledTimes(2);
		s.room.epoch = 6;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.maintain).toHaveBeenCalledTimes(2);
		expect(s.outcomes.at(-1)?.kind).toBe("failed");
	});

	it("ignores a throwing observer and stops on close or stop()", async () => {
		const s = scheduler([{kind: "maintained"}], {onResult: () => {throw new Error("observer");}});
		await vi.advanceTimersByTimeAsync(100);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		s.room.epoch = 5; s.room.open = false;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.maintain).toHaveBeenCalledTimes(1);
		const t = scheduler([]);
		t.handle.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(t.maintain).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects invalid bounds", () => {
		for (const options of [{idleMilliseconds: 0}, {idleMilliseconds: 1.5}, {idleMilliseconds: 100, maxBackoffMilliseconds: 50},
			{onResult: 1 as unknown as () => void}])
			expect(() => resolveRecoveryPoolAutoMaintenanceOptions(options)).toThrow(TypeError);
		expect(resolveRecoveryPoolAutoMaintenanceOptions({})).toEqual({idleMilliseconds: 1_000, maxBackoffMilliseconds: 30_000});
	});
});
