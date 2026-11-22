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
	EphemeralDisableLatchStatePort,
	OPERATOR_AUTHORITY,
	OPERATOR_AUTHORITY_SET_VERSION,
	OPERATOR_PUBLIC_KEY,
	signedDisable,
} from "./signed-disable-1m-a-fixtures.js";

type LateLoadOutcome = "reject" | "success" | "throw";

interface PendingCommit {
	readonly expected: DisableLatchState;
	readonly next: DisableLatchState;
	reject(reason: unknown): void;
	resolve(value: unknown): void;
}

interface PendingLoad {
	reject(reason: unknown): void;
	resolve(value: unknown): void;
	readonly snapshot: unknown;
}

/**
 * NON-PRODUCTION DEFERRED-LOAD/ATOMIC-CAS TEST FIXTURE.
 *
 * This fixture exposes one bounded load/CAS interleaving. It is neither a
 * default store nor evidence of durability, restart, or crash recovery.
 */
class DeferredLoadAtomicCasPort implements DisableLatchStatePort {
	readonly #atomicPort: EphemeralDisableLatchStatePort;
	#deferCommit = false;
	#deferLoad = false;
	#pendingCommit: PendingCommit | undefined;
	#pendingLoad: PendingLoad | undefined;

	constructor(initial: DisableLatchState) {
		this.#atomicPort = new EphemeralDisableLatchStatePort(initial);
	}

	load(): Promise<unknown> {
		const snapshot = this.#atomicPort.stored();
		if (!this.#deferLoad) return Promise.resolve(snapshot);
		this.#deferLoad = false;
		return new Promise((resolve, reject) => {
			if (this.#pendingLoad !== undefined) throw new Error("a deferred load is already pending");
			this.#pendingLoad = { reject, resolve, snapshot };
		});
	}

	compareAndCommit(expected: DisableLatchState, next: DisableLatchState): Promise<unknown> {
		if (!this.#deferCommit) return this.#atomicPort.compareAndCommit(expected, next);
		this.#deferCommit = false;
		return new Promise((resolve, reject) => {
			if (this.#pendingCommit !== undefined) throw new Error("a deferred commit is already pending");
			this.#pendingCommit = { expected, next, reject, resolve };
		});
	}

	deferNextCommit(): void {
		this.#deferCommit = true;
	}

	deferNextLoad(): void {
		this.#deferLoad = true;
	}

	commitPending(): void {
		const pending = this.#pendingCommit;
		if (pending === undefined) throw new Error("no deferred commit is pending");
		this.#pendingCommit = undefined;
		void this.#atomicPort.compareAndCommit(pending.expected, pending.next).then(pending.resolve, pending.reject);
	}

	settlePendingLoad(outcome: LateLoadOutcome): void {
		const pending = this.#pendingLoad;
		if (pending === undefined) throw new Error("no deferred load is pending");
		this.#pendingLoad = undefined;
		if (outcome === "success") {
			pending.resolve(pending.snapshot);
			return;
		}
		if (outcome === "reject") {
			pending.reject(new Error("deferred load rejected"));
			return;
		}
		pending.resolve(
			Promise.resolve().then(() => {
				throw new Error("deferred load threw");
			})
		);
	}

	stored(): unknown {
		return this.#atomicPort.stored();
	}
}

describe("Phase 1m-a signed-disable restore race corrective RED", () => {
	it("does not let an older restored enabled tuple overwrite a newer committed disable", async () => {
		const prior = emptyLatchState();
		const envelope = signedDisable(1);
		const committed = committedState(prior, envelope, 1);
		const port = new DeferredLoadAtomicCasPort(prior);
		const controller = createRaceController(port);
		await expect(controller.restore()).resolves.toEqual(enabledState());

		port.deferNextCommit();
		const applying = controller.apply(envelope);
		port.deferNextLoad();
		const restoring = controller.restore();

		port.commitPending();
		await expect(applying).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.stored()).toEqual(committed);
		expect(controller.consumerState()).toEqual(disabledState());

		port.settlePendingLoad("success");
		await restoring;
		expect.soft(port.stored()).toEqual(committed);
		expect.soft(controller.consumerState()).toEqual(disabledState());
		await expect.soft(controller.apply(envelope)).resolves.toEqual({ applied: false, reason: "replay" });
	});

	it.each(["reject", "throw"] as const)(
		"keeps a newer committed disable observable when the older load later %ss",
		async (outcome) => {
			const prior = emptyLatchState();
			const envelope = signedDisable(1);
			const committed = committedState(prior, envelope, 1);
			const port = new DeferredLoadAtomicCasPort(prior);
			const controller = createRaceController(port);
			await expect(controller.restore()).resolves.toEqual(enabledState());

			port.deferNextCommit();
			const applying = controller.apply(envelope);
			port.deferNextLoad();
			const restoring = controller.restore();

			port.commitPending();
			await expect(applying).resolves.toEqual({ applied: true, counter: 1 });
			expect(port.stored()).toEqual(committed);
			expect(controller.consumerState()).toEqual(disabledState());

			port.settlePendingLoad(outcome);
			await restoring;
			expect.soft(port.stored()).toEqual(committed);
			expect.soft(controller.consumerState()).toEqual(disabledState());
		}
	);
});

function createRaceController(statePort: DisableLatchStatePort): SignedDisableController {
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

function disabledState(): DisableConsumerState {
	return { highestCounter: 1, status: "disabled" };
}
