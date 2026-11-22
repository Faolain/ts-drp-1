import { SetDRP } from "@ts-drp/blueprints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPObject } from "../src/index.js";

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

function receiver(): DRPObject<SetDRP<string>> {
	return new DRPObject({
		peerId: "phase-0q-c-object",
		acl: createACL({ admins: ["phase-0q-c-object"] }),
		drp: new SetDRP<string>(),
	});
}

async function flushDetachedSettlement(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

describe("Phase 0q-c detached DRPObject observer rejection containment", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports an exact rejecting-thenable reason once without undoing committed state or skipping a later observer", async () => {
		const object = receiver();
		const rejection = new Error("controlled DRPObject async observer rejection");
		const thenable = new ControlledThenable();
		const laterObserver = vi.fn();
		const report = vi.spyOn(object["log"], "error").mockImplementation(() => {});

		object.subscribe(() => returnThroughVoidBoundary(thenable));
		object.subscribe(laterObserver);

		let escaped: unknown;
		try {
			object.drp?.add("committed");
		} catch (error) {
			escaped = error;
		}
		await flushDetachedSettlement();
		thenable.reject(rejection);
		await flushDetachedSettlement();
		const [notifiedObject, notifiedOrigin, notifiedVertices] = laterObserver.mock.calls[0] ?? [];

		expect({
			escaped,
			laterCallCount: laterObserver.mock.calls.length,
			liveValues: object.drp?.query_getValues(),
			notifiedOrigin,
			notifiedValue: notifiedVertices?.[0]?.operation?.value,
			reports: report.mock.calls,
			sameObjectReference: notifiedObject === object,
		}).toEqual({
			escaped: undefined,
			laterCallCount: 1,
			liveValues: ["committed"],
			notifiedOrigin: "callFn",
			notifiedValue: ["committed"],
			reports: [["DRPObject subscriber callback rejected", rejection]],
			sameObjectReference: true,
		});
	});

	it("runs the later observer before a delayed thenable settles", async () => {
		const object = receiver();
		const thenable = new ControlledThenable();
		const order: string[] = [];
		const report = vi.spyOn(object["log"], "error").mockImplementation(() => {});

		object.subscribe(() => {
			order.push("thenable-observer");
			return returnThroughVoidBoundary(thenable);
		});
		object.subscribe(() => {
			order.push("later-observer");
		});

		object.drp?.add("no-backpressure");
		const beforeSettlement = [...order];
		thenable.resolve();
		await flushDetachedSettlement();

		expect({ beforeSettlement, reports: report.mock.calls }).toEqual({
			beforeSettlement: ["thenable-observer", "later-observer"],
			reports: [],
		});
	});

	it("does not report undefined or non-thenable observer returns", async () => {
		const object = receiver();
		const observations: string[] = [];
		const report = vi.spyOn(object["log"], "error").mockImplementation(() => {});

		object.subscribe(() => {
			observations.push("undefined");
		});
		object.subscribe(() => {
			observations.push("non-thenable");
			return 42;
		});

		object.drp?.add("ordinary-returns");
		await flushDetachedSettlement();

		expect({
			liveValues: object.drp?.query_getValues(),
			observations,
			reports: report.mock.calls,
		}).toEqual({
			liveValues: ["ordinary-returns"],
			observations: ["undefined", "non-thenable"],
			reports: [],
		});
	});
});
