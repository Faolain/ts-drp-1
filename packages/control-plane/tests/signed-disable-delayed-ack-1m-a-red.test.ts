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

interface PendingAcknowledgment {
	readonly outcome: CommitOutcome;
	resolve(value: CommitOutcome): void;
}

type CommitOutcome = { readonly outcome: "committed" | "rejected" };

/**
 * NON-PRODUCTION HONEST ATOMIC-CAS/DELAYED-ACK TEST FIXTURE.
 *
 * `compareAndCommit` checks and mutates the tuple synchronously. Only its
 * truthful acknowledgment may be delayed. This is neither a default store nor
 * a scheduler, queue, durability model, or compatibility owner.
 */
class HonestAtomicDelayedAckPort implements DisableLatchStatePort {
	readonly acknowledgmentOrder: number[] = [];
	readonly commitOrder: number[] = [];
	readonly #deferredCounters = new Set<number>();
	readonly #microtaskLatencies = new Map<number, number>();
	readonly #pendingAcknowledgments = new Map<number, PendingAcknowledgment>();
	#state: DisableLatchState;

	constructor(initial: DisableLatchState) {
		this.#state = cloneState(initial);
	}

	load(): Promise<unknown> {
		return Promise.resolve(cloneState(this.#state));
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

		if (this.#deferredCounters.delete(counter)) {
			return new Promise((resolve) => {
				if (this.#pendingAcknowledgments.has(counter)) {
					throw new Error(`counter ${counter} already has a pending acknowledgment`);
				}
				this.#pendingAcknowledgments.set(counter, { outcome, resolve });
			});
		}

		const microtasks = this.#microtaskLatencies.get(counter) ?? 0;
		return acknowledgeAfterMicrotasks(microtasks, outcome, () => {
			this.acknowledgmentOrder.push(counter);
		});
	}

	deferAcknowledgment(counter: number): void {
		this.#deferredCounters.add(counter);
	}

	delayAcknowledgment(counter: number, microtasks: number): void {
		this.#microtaskLatencies.set(counter, microtasks);
	}

	releaseAcknowledgment(counter: number): void {
		const pending = this.#pendingAcknowledgments.get(counter);
		if (pending === undefined) throw new Error(`counter ${counter} has no pending acknowledgment`);
		this.#pendingAcknowledgments.delete(counter);
		this.acknowledgmentOrder.push(counter);
		pending.resolve(pending.outcome);
	}

	stored(): DisableLatchState {
		return cloneState(this.#state);
	}
}

describe("Phase 1m-a delayed truthful CAS acknowledgment corrective RED", () => {
	it("keeps E2 published when E1's explicitly deferred truthful acknowledgment arrives last", async () => {
		const prior = emptyLatchState();
		const first = signedDisable(1);
		const second = signedDisable(2);
		const third = signedDisable(3);
		const firstState = committedState(prior, first, 1);
		const secondState = committedState(firstState, second, 2);
		const thirdState = committedState(secondState, third, 3);
		const port = new HonestAtomicDelayedAckPort(prior);
		port.deferAcknowledgment(1);
		const controller = createController(port);
		await expect(controller.restore()).resolves.toEqual(enabledState());

		const applyingFirst = controller.apply(first);
		expect(port.stored()).toEqual(firstState);
		await expect(controller.restore()).resolves.toEqual(disabledState(1));
		await expect(controller.apply(second)).resolves.toEqual({ applied: true, counter: 2 });
		expect(port.stored()).toEqual(secondState);
		expect(controller.consumerState()).toEqual(disabledState(2));
		expect(port.acknowledgmentOrder).toEqual([2]);

		port.releaseAcknowledgment(1);
		await expect(applyingFirst).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.commitOrder).toEqual([1, 2]);
		expect(port.acknowledgmentOrder).toEqual([2, 1]);
		expect(port.stored()).toEqual(secondState);

		const afterOldAcknowledgment = controller.consumerState();
		const replay = await controller.apply(second);
		const advance = await controller.apply(third);
		expect.soft(afterOldAcknowledgment).toEqual(disabledState(2));
		expect.soft(replay).toEqual({ applied: false, reason: "replay" });
		expect.soft(advance).toEqual({ applied: true, counter: 3 });
		expect.soft(port.stored()).toEqual(thirdState);
		expect.soft(controller.consumerState()).toEqual(disabledState(3));
	});

	it("keeps E2 published under naturally unequal honest acknowledgment latency", async () => {
		const prior = emptyLatchState();
		const first = signedDisable(1);
		const second = signedDisable(2);
		const third = signedDisable(3);
		const firstState = committedState(prior, first, 1);
		const secondState = committedState(firstState, second, 2);
		const thirdState = committedState(secondState, third, 3);
		const port = new HonestAtomicDelayedAckPort(prior);
		port.delayAcknowledgment(1, 32);
		const controller = createController(port);
		await controller.restore();

		const applyingFirst = controller.apply(first);
		expect(port.stored()).toEqual(firstState);
		await expect(controller.restore()).resolves.toEqual(disabledState(1));
		await expect(controller.apply(second)).resolves.toEqual({ applied: true, counter: 2 });
		expect(port.acknowledgmentOrder).toEqual([2]);
		expect(port.stored()).toEqual(secondState);
		expect(controller.consumerState()).toEqual(disabledState(2));

		await expect(applyingFirst).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.commitOrder).toEqual([1, 2]);
		expect(port.acknowledgmentOrder).toEqual([2, 1]);
		expect(port.stored()).toEqual(secondState);

		const afterOldAcknowledgment = controller.consumerState();
		const replay = await controller.apply(second);
		const advance = await controller.apply(third);
		expect.soft(afterOldAcknowledgment).toEqual(disabledState(2));
		expect.soft(replay).toEqual({ applied: false, reason: "replay" });
		expect.soft(advance).toEqual({ applied: true, counter: 3 });
		expect.soft(port.stored()).toEqual(thirdState);
		expect.soft(controller.consumerState()).toEqual(disabledState(3));
	});

	it("preserves an ordinary honest losing CAS and retry after refreshing", async () => {
		const prior = emptyLatchState();
		const first = signedDisable(1);
		const second = signedDisable(2);
		const port = new HonestAtomicDelayedAckPort(prior);
		const winner = createController(port);
		const loser = createController(port);
		await Promise.all([winner.restore(), loser.restore()]);

		const winningApply = winner.apply(first);
		const losingApply = loser.apply(first);
		await expect(winningApply).resolves.toEqual({ applied: true, counter: 1 });
		await expect(losingApply).resolves.toEqual({ applied: false, reason: "state-commit-failed" });
		expect(port.stored()).toEqual(committedState(prior, first, 1));

		await expect(loser.restore()).resolves.toEqual(disabledState(1));
		await expect(loser.apply(first)).resolves.toEqual({ applied: false, reason: "replay" });
		await expect(loser.apply(second)).resolves.toEqual({ applied: true, counter: 2 });
		expect(port.stored()).toEqual(committedState(committedState(prior, first, 1), second, 2));
		expect(loser.consumerState()).toEqual(disabledState(2));
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

function enabledState(): DisableConsumerState {
	return { highestCounter: 0, status: "enabled" };
}

function disabledState(counter: number): DisableConsumerState {
	return { highestCounter: counter, status: "disabled" };
}

function acknowledgeAfterMicrotasks(
	microtasks: number,
	outcome: CommitOutcome,
	onAcknowledged: () => void
): Promise<unknown> {
	let acknowledgment = Promise.resolve();
	for (let index = 0; index < microtasks; index += 1) {
		acknowledgment = acknowledgment.then(() => undefined);
	}
	return acknowledgment.then(() => {
		onAcknowledged();
		return outcome;
	});
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
