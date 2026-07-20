import { describe, expect, it } from "vitest";

import { ObjectSet } from "../src/set/index.js";

describe("ObjectSet", () => {
	it("keeps constructor and mutation membership unique", () => {
		const values = new ObjectSet(["alpha", "alpha", "beta"]);

		expect(values.size).toBe(2);
		expect(values.has("alpha")).toBe(true);
		expect(values.has("beta")).toBe(true);
		expect(values.add("alpha")).toBe(values);
		expect(values.size).toBe(2);
		expect(values.delete("missing")).toBe(false);
		expect(values.delete("alpha")).toBe(true);
		expect(values.has("alpha")).toBe(false);
		expect(values.size).toBe(1);

		values.clear();

		expect(values.size).toBe(0);
		expect(values.has("beta")).toBe(false);
	});

	it("preserves insertion order and identity for every supported key type", () => {
		const symbol = Symbol("symbol");
		const values = new ObjectSet<string | number | symbol>([2, "1", symbol, 1]);

		expect([...values.values()]).toEqual([2, "1", symbol, 1]);
		expect([...values.keys()]).toEqual([2, "1", symbol, 1]);
		expect([...values]).toEqual([2, "1", symbol, 1]);
		expect([...values.entries()]).toEqual([
			[2, 2],
			["1", "1"],
			[symbol, symbol],
			[1, 1],
		]);
	});

	it("implements the Set forEach callback contract", () => {
		const values = new ObjectSet(["alpha", "beta"]);
		const context = { visited: [] as string[] };

		values.forEach(function (this: typeof context, value, duplicate, owner) {
			expect(duplicate).toBe(value);
			expect(owner).toBe(values);
			this.visited.push(value);
		}, context);

		expect(context.visited).toEqual(["alpha", "beta"]);
	});

	it("exposes a stable ObjectSet diagnostic brand", () => {
		const values = new ObjectSet();

		expect(values.toString()).toBe("[object ObjectSet]");
		expect(values[Symbol.toStringTag]).toBe("ObjectSet");
		expect(Object.prototype.toString.call(values)).toBe("[object ObjectSet]");
	});
});
