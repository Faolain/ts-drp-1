import type { IDRP, IDRPObject } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "../src/logger.js";
import { DRPObjectStore } from "../src/store/object.js";

type FulfilledHandler = (value: undefined) => unknown;
type RejectedHandler = (reason: unknown) => unknown;

class ControlledThenable {
	private fulfilledHandlers: FulfilledHandler[] = [];
	private rejectedHandlers: RejectedHandler[] = [];
	private settlement: { status: "fulfilled" } | { reason: unknown; status: "rejected" } | undefined;

	then(onFulfilled?: FulfilledHandler | null, onRejected?: RejectedHandler | null): ControlledThenable {
		if (onFulfilled) this.fulfilledHandlers.push(onFulfilled);
		if (onRejected) this.rejectedHandlers.push(onRejected);
		if (this.settlement) this.enqueue(this.settlement, onFulfilled, onRejected);
		return this;
	}

	resolve(): void {
		if (this.settlement) throw new Error("controlled thenable already settled");
		this.settlement = { status: "fulfilled" };
		for (const handler of this.fulfilledHandlers) queueMicrotask(() => handler(undefined));
	}

	reject(reason: unknown): void {
		if (this.settlement) throw new Error("controlled thenable already settled");
		this.settlement = { reason, status: "rejected" };
		for (const handler of this.rejectedHandlers) queueMicrotask(() => handler(reason));
	}

	private enqueue(
		settlement: { status: "fulfilled" } | { reason: unknown; status: "rejected" },
		onFulfilled?: FulfilledHandler | null,
		onRejected?: RejectedHandler | null
	): void {
		if (settlement.status === "fulfilled" && onFulfilled) queueMicrotask(() => onFulfilled(undefined));
		if (settlement.status === "rejected" && onRejected) queueMicrotask(() => onRejected(settlement.reason));
	}
}

// Model the published callback's compile-time `void` boundary while retaining
// the JavaScript return value that the leaf loop must inspect at runtime.
function returnThroughVoidBoundary(value: unknown): void {
	return value as never;
}

function object(id: string): IDRPObject<IDRP> {
	return { id } as unknown as IDRPObject<IDRP>;
}

async function flushDetachedSettlement(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

describe("Phase 0q-c detached object-store subscriber rejection containment", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports an exact rejecting-thenable reason once without undoing the stored reference or skipping a later subscriber", async () => {
		const store = new DRPObjectStore();
		const previous = object("previous");
		const replacement = object("replacement");
		const rejection = new Error("controlled object-store async subscriber rejection");
		const thenable = new ControlledThenable();
		const laterSubscriber = vi.fn();
		const report = vi.spyOn(log, "error").mockImplementation(() => {});

		store.put("target", previous);
		store.subscribe("target", () => returnThroughVoidBoundary(thenable));
		store.subscribe("target", laterSubscriber);

		let escaped: unknown;
		try {
			store.put("target", replacement);
		} catch (error) {
			escaped = error;
		}
		await flushDetachedSettlement();
		thenable.reject(rejection);
		await flushDetachedSettlement();

		expect({
			escaped,
			laterCalls: laterSubscriber.mock.calls,
			reports: report.mock.calls,
			stored: store.get("target"),
		}).toEqual({
			escaped: undefined,
			laterCalls: [["target", replacement]],
			reports: [["::objectStore: Subscriber callback rejected", rejection]],
			stored: replacement,
		});
	});

	it("runs the later subscriber before a delayed thenable settles", async () => {
		const store = new DRPObjectStore();
		const replacement = object("replacement");
		const thenable = new ControlledThenable();
		const order: string[] = [];
		const report = vi.spyOn(log, "error").mockImplementation(() => {});

		store.subscribe("target", () => {
			order.push("thenable-subscriber");
			return returnThroughVoidBoundary(thenable);
		});
		store.subscribe("target", () => {
			order.push("later-subscriber");
		});

		store.put("target", replacement);
		const beforeSettlement = [...order];
		thenable.resolve();
		await flushDetachedSettlement();

		expect({ beforeSettlement, reports: report.mock.calls, stored: store.get("target") }).toEqual({
			beforeSettlement: ["thenable-subscriber", "later-subscriber"],
			reports: [],
			stored: replacement,
		});
	});

	it("does not report undefined or non-thenable subscriber returns", async () => {
		const store = new DRPObjectStore();
		const replacement = object("replacement");
		const observations: string[] = [];
		const report = vi.spyOn(log, "error").mockImplementation(() => {});

		store.subscribe("target", () => {
			observations.push("undefined");
		});
		store.subscribe("target", () => {
			observations.push("non-thenable");
			return 42;
		});

		store.put("target", replacement);
		await flushDetachedSettlement();

		expect({ observations, reports: report.mock.calls, stored: store.get("target") }).toEqual({
			observations: ["undefined", "non-thenable"],
			reports: [],
			stored: replacement,
		});
	});
});
