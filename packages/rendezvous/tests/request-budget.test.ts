import { RequestBudget } from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

describe("RequestBudget", () => {
	it("validates limits and counts, reports remaining capacity, and does not consume failed reservations", () => {
		for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => new RequestBudget(invalid)).toThrow("positive safe integer");
		}

		const budget = new RequestBudget(3);
		budget.consume(2);
		expect(budget.consumed).toBe(2);
		expect(budget.remaining).toBe(1);
		expect(() => budget.consume(2)).toThrow("request cap exhausted (2/3)");
		expect(budget.consumed).toBe(2);
		for (const invalid of [0, -1, 1.5]) {
			expect(() => budget.consume(invalid)).toThrow("positive safe integer");
		}
		budget.consume();
		expect(budget.remaining).toBe(0);
	});
});
