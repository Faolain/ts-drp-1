import type { IDRP, IDRPObject } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { DRPObjectStore } from "../src/store/object.js";

function object(id: string): IDRPObject<IDRP> {
	return { id } as unknown as IDRPObject<IDRP>;
}

describe("DRPObjectStore", () => {
	it("replaces objects in place while notifying only matching subscribers in registration order", () => {
		const store = new DRPObjectStore();
		const events: string[] = [];
		const first = object("first");
		const replacement = object("replacement");
		const other = object("other");

		store.subscribe("target", (id, value) => events.push(`first:${id}:${value.id}`));
		store.subscribe("target", (id, value) => events.push(`second:${id}:${value.id}`));
		store.subscribe("other", (id, value) => events.push(`other:${id}:${value.id}`));

		store.put("target", first);
		store.put("other", other);
		store.put("target", replacement);

		expect(events).toEqual([
			"first:target:first",
			"second:target:first",
			"other:other:other",
			"first:target:replacement",
			"second:target:replacement",
		]);
		expect(store.get("target")).toBe(replacement);
		expect([...store.values()]).toEqual([replacement, other]);
	});

	it("removes only the requested subscription and clears subscribers when purging an object", () => {
		const store = new DRPObjectStore();
		const removed = vi.fn();
		const retained = vi.fn();
		const value = object("value");

		store.subscribe("target", removed);
		store.subscribe("target", retained);
		store.unsubscribe("target", removed);
		store.unsubscribe("missing", removed);
		store.put("target", value);

		expect(removed).not.toHaveBeenCalled();
		expect(retained).toHaveBeenCalledOnce();
		expect(retained).toHaveBeenCalledWith("target", value);

		store.remove("target");
		expect(store.get("target")).toBeUndefined();
		expect([...store.values()]).toEqual([]);

		store.put("target", object("replacement"));
		expect(retained).toHaveBeenCalledOnce();
	});
});
