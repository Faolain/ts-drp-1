import { describe, expect, it } from "vitest";

import { runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import { maximalEntries } from "./fixtures/phase-3f-c/application-batching-fixture.js";

describe("Phase 3f-c shared-room batch measurement", () => {
	it("measures one, two, sixteen, and seventeen captured requests at the genuine signing boundary", async () => {
		const one = await runFrontierScenario(1, { operations: maximalEntries("counter", 1) });
		expect(one).toMatchObject({ signerCalls: 1, journalAppends: 1 });
		expect(one.issued).toHaveLength(1);
		expect(one.issued[0]?.operation).toMatchObject({ action: "add" });

		for (const count of [2, 16] as const) {
			const result = await runFrontierScenario(1, { operations: maximalEntries("counter", count) });
			expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
			expect(result).toMatchObject({ signerCalls: 1, journalAppends: 1 });
			expect(result.issued).toHaveLength(1);
			expect(result.issued[0]?.operation).toMatchObject({
				action: "applicationBatch",
				batch: { entries: maximalEntries("counter", count), version: 1 },
			});
		}

		const split = await runFrontierScenario(1, { operations: maximalEntries("counter", 17) });
		expect(split.result).toMatchObject({ ok: false, kind: "split-required", prefixLength: 16 });
		expect(split).toMatchObject({ signerCalls: 0, journalAppends: 0 });
		const prefix = await runFrontierScenario(1, { operations: maximalEntries("counter", 16) });
		const suffix = await runFrontierScenario(1, { operations: maximalEntries("counter", 17).slice(16) });
		expect(prefix.issued).toHaveLength(1);
		expect(suffix.issued).toHaveLength(1);
		expect(prefix.signerCalls + suffix.signerCalls).toBe(2);
	});
});
