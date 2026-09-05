import type { IDRP, IDRPObject } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "../src/logger.js";
import { DRPObjectStore } from "../src/store/object.js";

function object(id: string): IDRPObject<IDRP> {
	return { id } as unknown as IDRPObject<IDRP>;
}

describe("Phase 0q-b2 post-commit object-store publication", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports a subscriber failure without undoing the stored object, escaping put, or skipping later subscribers", () => {
		const store = new DRPObjectStore();
		const previous = object("previous");
		const replacement = object("replacement");
		const observerFailure = new Error("controlled object-store observer failure");
		const laterObserver = vi.fn();
		const report = vi.spyOn(log, "error").mockImplementation(() => {});

		store.put("target", previous);
		store.subscribe("target", () => {
			throw observerFailure;
		});
		store.subscribe("target", laterObserver);

		let escaped: unknown;
		try {
			store.put("target", replacement);
		} catch (error) {
			escaped = error;
		}

		expect({
			escaped,
			stored: store.get("target"),
			laterCalls: laterObserver.mock.calls,
			reports: report.mock.calls,
		}).toEqual({
			escaped: undefined,
			stored: replacement,
			laterCalls: [["target", replacement]],
			reports: [["::objectStore: Subscriber callback failed", observerFailure]],
		});
	});
});
