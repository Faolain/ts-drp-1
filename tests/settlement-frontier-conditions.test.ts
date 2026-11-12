import { describe, expect, it } from "vitest";

import { runFrontierScenario, type FrontierScenarioResult } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import { deriveCreatorAuthorSettlementFrontier } from "../packages/node/src/creator-close.js";

// The two conditions the frontier-classification path (departed-carrier pin) rests on. The creator's
// signed frontier is [author, admissionEpoch, terminalThrough]; a far-behind member classifies its own
// retained rows against it. That is sound only if (i) a silent author's frontier carries forward
// unchanged and (ii) an author's admitted rows of one epoch form a gap-free run, so terminalThrough
// separates admitted rows from rows that never entered history.

/** Every digest reachable from `from` through issued dependencies (anchor/initial tips are leaves). */
function ancestors(result: FrontierScenarioResult, from: string): ReadonlySet<string> {
	const byDigest = new Map(result.issued.map((vertex) => [vertex.digest, vertex]));
	const reached = new Set<string>();
	const pending = [...(byDigest.get(from)?.dependencies ?? [])];
	while (pending.length > 0) {
		const digest = pending.pop() as string;
		if (reached.has(digest)) continue;
		reached.add(digest);
		pending.push(...(byDigest.get(digest)?.dependencies ?? []));
	}
	return reached;
}

/** For each own issued row after the first: does it depend on the author's previous issued row? */
function predecessorClosure(result: FrontierScenarioResult) {
	return result.issued.slice(1).map((vertex, index) => ({
		sequence: vertex.authorSequence,
		action: Reflect.get(vertex.operation, "action"),
		dependsOnPrevious: ancestors(result, vertex.digest).has((result.issued[index] as { digest: string }).digest),
	}));
}

describe("settlement frontier conditions", () => {
	it("(i) a silent author's frontier carries forward unchanged", () => {
		// deriveAuthorSettlement passes every continuing member its previous signed tuple (and throws if the
		// predecessor lacks it); with no slots in the closing epoch nothing may move.
		for (const [admissionEpoch, boundary] of [
			[0, null],
			[3, 0],
			[5, 41],
		] as const)
			expect(
				deriveCreatorAuthorSettlementFrontier({
					author: "b".repeat(64),
					issuanceAuthor: "a".repeat(64),
					admissionEpoch,
					boundary,
					slots: new Map(),
					duplicate: false,
					vertices: new Map(),
				})
			).toEqual(["b".repeat(64), admissionEpoch, boundary]);
	});

	it("(i) a silent issuance author's frontier carries forward unchanged", () => {
		expect(
			deriveCreatorAuthorSettlementFrontier({
				author: "a".repeat(64),
				issuanceAuthor: "a".repeat(64),
				admissionEpoch: 2,
				boundary: 9,
				slots: new Map(),
				duplicate: false,
				vertices: new Map(),
			})
		).toEqual(["a".repeat(64), 2, 9]);
	});

	it("(ii) the frontier stops at the first missing slot: an admitted row above a gap is not terminal", () => {
		// The law itself is contiguous: terminalThrough is sound only if admission never leaves a gap.
		const slots = new Map([
			[10, "d10"],
			[12, "d12"],
		]);
		expect(
			deriveCreatorAuthorSettlementFrontier({
				author: "b".repeat(64),
				issuanceAuthor: "a".repeat(64),
				admissionEpoch: 0,
				boundary: 9,
				slots,
				duplicate: false,
				vertices: new Map(),
			})
		).toEqual(["b".repeat(64), 0, 10]);
	});

	it("(ii) an application row depends on every earlier own row of its epoch", async () => {
		for (const width of [2, 17, 64]) {
			const result = await runFrontierScenario(width);
			const final = result.issued.at(-1) as { digest: string };
			const reached = ancestors(result, final.digest);
			for (const earlier of result.issued.slice(0, -1)) expect(reached.has(earlier.digest)).toBe(true);
		}
	});

	// Condition (ii): every own row of an epoch depends on the author's previous own row, so admitting any
	// row admits every earlier own row of its epoch and the creator's contiguous frontier separates admitted
	// rows from rows that never entered history. A causalJoin used to depend on tips.slice(0, maxDependencies)
	// of the hash-sorted frontier, which need not reach the author's previous row (64 tips: join 66 did not
	// depend on join 65): a join delivered before its predecessor, or whose predecessor admission refused,
	// was admitted above a gap. A join now always covers the author's latest own row.
	for (const width of [17, 33, 49, 64])
		it(`(ii) every own row depends on the author's previous own row (${width}-tip reduction)`, async () => {
			const result = await runFrontierScenario(width);
			expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
			const closure = predecessorClosure(result);
			expect(closure.at(-1)?.action).toBe("add");
			expect(closure.filter(({ dependsOnPrevious }) => !dependsOnPrevious)).toEqual([]);
			// Each issued row stays within the dependency bound.
			expect(result.issued.every(({ dependencies }) => dependencies.length > 0 && dependencies.length <= 16)).toBe(
				true
			);
		});
});
