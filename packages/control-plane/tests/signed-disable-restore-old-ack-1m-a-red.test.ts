import {
	type DisableConsumerState,
	type DisableLatchState,
	type DisableLatchStatePort,
	SignedDisableController,
} from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

import {
	committedState,
	DISABLE_SCOPE,
	emptyLatchState,
	OPERATOR_AUTHORITY,
	OPERATOR_AUTHORITY_SET_VERSION,
	OPERATOR_PUBLIC_KEY,
	signedDisable,
} from "./signed-disable-1m-a-fixtures.js";

type CommitOutcome = { readonly outcome: "committed" | "rejected" };

interface PendingAcknowledgment {
	readonly counter: number;
	readonly outcome: CommitOutcome;
	resolve(value: CommitOutcome): void;
}

interface PendingLoad {
	readonly snapshot: DisableLatchState;
	resolve(value: DisableLatchState): void;
}

/**
 * NON-PRODUCTION HONEST ATOMIC-CAS/DEFERRED-LOAD TEST FIXTURE.
 *
 * CAS checks and stores before returning a truthful acknowledgment. Loads
 * capture a detached tuple when called; only the selected completion is held.
 * This is not a default store, scheduler, queue, durability model, or
 * compatibility/concurrency framework.
 */
class HonestAtomicRestoreOldAckPort implements DisableLatchStatePort {
	readonly acknowledgmentOrder: number[] = [];
	readonly capturedLoadCounters: number[] = [];
	readonly commitOrder: number[] = [];
	#deferNextLoad = false;
	#deferredAcknowledgmentCounter: number | undefined;
	#pendingAcknowledgment: PendingAcknowledgment | undefined;
	#pendingLoad: PendingLoad | undefined;
	#state: DisableLatchState;

	constructor(initial: DisableLatchState) {
		this.#state = cloneState(initial);
	}

	load(): Promise<unknown> {
		const snapshot = cloneState(this.#state);
		this.capturedLoadCounters.push(snapshot.highestCounter);
		if (!this.#deferNextLoad) return Promise.resolve(snapshot);
		this.#deferNextLoad = false;
		return new Promise((resolve) => {
			if (this.#pendingLoad !== undefined) throw new Error("a deferred load is already pending");
			this.#pendingLoad = { resolve, snapshot };
		});
	}

	compareAndCommit(expected: DisableLatchState, next: DisableLatchState): Promise<unknown> {
		const counter = next.highestCounter;
		const outcome: CommitOutcome = statesEqual(this.#state, expected)
			? { outcome: "committed" }
			: { outcome: "rejected" };
		if (outcome.outcome === "committed") {
			this.#state = cloneState(next);
			this.commitOrder.push(counter);
		}

		if (this.#deferredAcknowledgmentCounter === counter) {
			this.#deferredAcknowledgmentCounter = undefined;
			return new Promise((resolve) => {
				if (this.#pendingAcknowledgment !== undefined) {
					throw new Error("a deferred acknowledgment is already pending");
				}
				this.#pendingAcknowledgment = { counter, outcome, resolve };
			});
		}

		return Promise.resolve(outcome).then((acknowledgment) => {
			this.acknowledgmentOrder.push(counter);
			return acknowledgment;
		});
	}

	deferAcknowledgment(counter: number): void {
		this.#deferredAcknowledgmentCounter = counter;
	}

	deferNextLoad(): void {
		this.#deferNextLoad = true;
	}

	pendingLoadSnapshot(): DisableLatchState {
		const pending = this.#pendingLoad;
		if (pending === undefined) throw new Error("no deferred load is pending");
		return cloneState(pending.snapshot);
	}

	releaseAcknowledgment(): void {
		const pending = this.#pendingAcknowledgment;
		if (pending === undefined) throw new Error("no deferred acknowledgment is pending");
		this.#pendingAcknowledgment = undefined;
		this.acknowledgmentOrder.push(pending.counter);
		pending.resolve(pending.outcome);
	}

	releaseLoad(): void {
		const pending = this.#pendingLoad;
		if (pending === undefined) throw new Error("no deferred load is pending");
		this.#pendingLoad = undefined;
		pending.resolve(cloneState(pending.snapshot));
	}

	stored(): DisableLatchState {
		return cloneState(this.#state);
	}
}

describe("Phase 1m-a restore composed with an older truthful acknowledgment corrective RED", () => {
	it("keeps the newer restore publication token when an older acknowledgment arrives while blocked", async () => {
		const prior = emptyLatchState();
		const first = signedDisable(1);
		const second = signedDisable(2);
		const third = signedDisable(3);
		const firstState = committedState(prior, first, 1);
		const secondState = committedState(firstState, second, 2);
		const thirdState = committedState(secondState, third, 3);
		const port = new HonestAtomicRestoreOldAckPort(prior);
		const controller = createController(port);
		await expect(controller.restore()).resolves.toEqual(enabledState());

		port.deferAcknowledgment(1);
		const applyingFirst = controller.apply(first);
		expect(port.stored()).toEqual(firstState);
		await expect(controller.restore()).resolves.toEqual(disabledState(1));
		await expect(controller.apply(second)).resolves.toEqual({ applied: true, counter: 2 });
		expect(port.stored()).toEqual(secondState);
		expect(controller.consumerState()).toEqual(disabledState(2));

		port.deferNextLoad();
		const restoringNewer = controller.restore();
		expect(port.pendingLoadSnapshot()).toEqual(secondState);
		expect(port.capturedLoadCounters).toEqual([0, 1, 2]);
		expect(controller.consumerState()).toEqual(blockedState());

		port.releaseAcknowledgment();
		await expect(applyingFirst).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.commitOrder).toEqual([1, 2]);
		expect(port.acknowledgmentOrder).toEqual([2, 1]);
		expect(port.stored()).toEqual(secondState);
		expect.soft(controller.consumerState()).toEqual(blockedState());

		port.releaseLoad();
		await expect.soft(restoringNewer).resolves.toEqual(disabledState(2));
		expect.soft(controller.consumerState()).toEqual(disabledState(2));
		await expect.soft(controller.apply(second)).resolves.toEqual({ applied: false, reason: "replay" });
		await expect.soft(controller.apply(third)).resolves.toEqual({ applied: true, counter: 3 });
		expect.soft(port.stored()).toEqual(thirdState);
		expect.soft(controller.consumerState()).toEqual(disabledState(3));
		expect.soft(port.commitOrder).toEqual([1, 2, 3]);
	});
});

function createController(statePort: DisableLatchStatePort): SignedDisableController {
	return new SignedDisableController({
		authority: {
			authorityId: OPERATOR_AUTHORITY,
			authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION,
			publicKey: { bytes: OPERATOR_PUBLIC_KEY, format: "raw" },
		},
		scope: DISABLE_SCOPE,
		statePort,
	});
}

function blockedState(): DisableConsumerState {
	return { highestCounter: null, status: "blocked" };
}

function enabledState(): DisableConsumerState {
	return { highestCounter: 0, status: "enabled" };
}

function disabledState(counter: number): DisableConsumerState {
	return { highestCounter: counter, status: "disabled" };
}

function cloneState(state: DisableLatchState): DisableLatchState {
	return {
		...state,
		envelopeBytes: state.envelopeBytes === null ? null : new Uint8Array(state.envelopeBytes),
		envelopeDigest: state.envelopeDigest === null ? null : new Uint8Array(state.envelopeDigest),
	};
}

function statesEqual(left: DisableLatchState, right: DisableLatchState): boolean {
	return (
		left.stateVersion === right.stateVersion &&
		left.authoritySetVersion === right.authoritySetVersion &&
		left.scope === right.scope &&
		left.envelopeVersion === right.envelopeVersion &&
		left.highestCounter === right.highestCounter &&
		left.latch === right.latch &&
		bytesEqual(left.envelopeBytes, right.envelopeBytes) &&
		bytesEqual(left.envelopeDigest, right.envelopeDigest)
	);
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
	if (left === null || right === null) return left === right;
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
