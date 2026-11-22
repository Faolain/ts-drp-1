import { describe, expect, it } from "vitest";

import { lostRowDisposition, type LostRowReplacement } from "./fixtures/active-endurance/lost-disposition.js";

// Grid app-mode conservation (perf/integration-7 @ fc88a547): a Writer's epoch-0 move whose first copy the
// scripted wire dropped is rebased into epoch 1 by the Writer's settlement after its install. Those
// rebased moves count toward the next epoch's budget, so the creator can close epoch 1 while the tail
// of that batch is in flight; the replacement is then rebased again into epoch 2, where the creator
// admits it. Observed chain (sandbox, run time1): seq 10 (epoch 0) -> seq 20 (epoch 1, missed the epoch-1
// close) -> seq 24 (epoch 2, admitted). The move is carried; the conservation check must follow the
// Writer's durable replacement chain to its end rather than stop at the first hop, and stay strict.
const admittedBy =
	(set: ReadonlySet<string>) =>
	(digests: readonly string[]): Promise<readonly boolean[]> =>
		Promise.resolve(digests.map((digest) => set.has(digest)));

describe("endurance conservation: a dropped first copy is carried by the Writer's replacement chain", () => {
	it("[RED] carried across two rebases: source -> epoch-1 replacement (closed without) -> epoch-2 replacement (admitted)", async () => {
		const plan: LostRowReplacement[] = [
			{ sourceDigest: "source-e0", replacementDigests: ["replacement-e1"] },
			{ sourceDigest: "replacement-e1", replacementDigests: ["replacement-e2"] },
		];
		const result = await lostRowDisposition("source-e0", plan, admittedBy(new Set(["replacement-e2"])));
		expect(result).toEqual({ carried: true, acceptedDigests: ["replacement-e2"] });
	});

	it("[RED] carried when one chunk of a chunked replacement was itself replaced and the rest admitted", async () => {
		const plan: LostRowReplacement[] = [
			{ sourceDigest: "source", replacementDigests: ["chunk-a", "chunk-b"] },
			{ sourceDigest: "chunk-b", replacementDigests: ["chunk-b2"] },
		];
		const result = await lostRowDisposition("source", plan, admittedBy(new Set(["chunk-a", "chunk-b2"])));
		expect(result).toEqual({ carried: true, acceptedDigests: ["chunk-a", "chunk-b2"] });
	});

	it("[control] the exact source admitted", async () => {
		const result = await lostRowDisposition("source", [], admittedBy(new Set(["source"])));
		expect(result).toEqual({ carried: true, acceptedDigests: ["source"] });
	});

	it("[control] one replacement hop admitted", async () => {
		const plan = [{ sourceDigest: "source", replacementDigests: ["r1"] }];
		expect((await lostRowDisposition("source", plan, admittedBy(new Set(["r1"])))).carried).toBe(true);
	});

	it("[control] strict: a chain whose last replacement the creator never admitted is a lost move", async () => {
		const plan = [
			{ sourceDigest: "source", replacementDigests: ["r1"] },
			{ sourceDigest: "r1", replacementDigests: ["r2"] },
		];
		expect(await lostRowDisposition("source", plan, admittedBy(new Set()))).toEqual({ carried: false, acceptedDigests: [] });
	});

	it("[control] strict: no plan entry (or one that expired the move) and no admission is a lost move", async () => {
		expect((await lostRowDisposition("source", [], admittedBy(new Set()))).carried).toBe(false);
		const expired = [{ sourceDigest: "source", replacementDigests: [] }];
		expect((await lostRowDisposition("source", expired, admittedBy(new Set()))).carried).toBe(false);
	});

	it("[control] strict: a chunked replacement with one chunk neither admitted nor replaced is a lost move", async () => {
		const plan = [{ sourceDigest: "source", replacementDigests: ["chunk-a", "chunk-b"] }];
		expect((await lostRowDisposition("source", plan, admittedBy(new Set(["chunk-a"])))).carried).toBe(false);
	});

	it("[control] strict: a replacement cycle that never reaches an admitted digest is a lost move", async () => {
		const plan = [
			{ sourceDigest: "source", replacementDigests: ["r1"] },
			{ sourceDigest: "r1", replacementDigests: ["source"] },
		];
		expect((await lostRowDisposition("source", plan, admittedBy(new Set()))).carried).toBe(false);
	});
});
