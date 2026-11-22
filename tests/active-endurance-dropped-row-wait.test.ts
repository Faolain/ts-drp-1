import { describe, expect, it } from "vitest";

import {
	accountDroppedRows,
	type DroppedRowClock,
	type DroppedRowProbe,
	type LostRowReplacement,
} from "./fixtures/active-endurance/lost-disposition.js";

// App-mode conservation under CPU load (8 concurrent runs on 8 vCPU, debug/int7-stranded-diag @ fa6ef1a0): a
// dropped first copy of the creator's current epoch was not yet admitted when the check ran, because
// appSettle's re-offer waits at most 5 s and then falls through silently. Every one was admitted exactly by
// the next epoch (13 of 13 rows). The check must wait for the dropped rows themselves, bounded by the next
// adoption plus a fixed cap, record how long they took, and still fail a row that is never accounted for.
const CAP_MS = 30_000;
const OPTIONS = { capMs: CAP_MS, pollMs: 250 };

/**
 * A virtual clock: sleeping advances it, nothing waits in real time.
 * @returns The clock, starting at 0.
 */
function virtualClock(): DroppedRowClock & { at: number } {
	const clock = {
		at: 0,
		now: (): number => clock.at,
		sleep: (ms: number): Promise<void> => {
			clock.at += ms;
			return Promise.resolve();
		},
	};
	return clock;
}

/**
 * The receiver admits each digest from its scheduled time on; the author's plan and adoptions follow the clock too.
 * @param clock - The virtual clock.
 * @param admitAt - When the receiver admits each digest.
 * @param options - The author's plan, the next adoption and the hand-back state over time.
 * @param options.replacements - The author's plan entries at a time.
 * @param options.adoptionAt - When the receiver's next adoption happens.
 * @param options.handBack - The hand-back state at a time.
 * @returns The probe, counting the diagnostic dumps it produced.
 */
function probe(
	clock: DroppedRowClock,
	admitAt: Readonly<Record<string, number>>,
	options: {
		replacements?(now: number): readonly LostRowReplacement[];
		adoptionAt?: number;
		handBack?(now: number): "none" | "pending" | "reoffered-admitted";
	} = {}
): DroppedRowProbe & { diagnosed: number } {
	const value: DroppedRowProbe & { diagnosed: number } = {
		diagnosed: 0,
		replacements: () => Promise.resolve(options.replacements?.(clock.now()) ?? []),
		accepted: (digests) => Promise.resolve(digests.map((digest) => (admitAt[digest] ?? Infinity) <= clock.now())),
		handBack: () => Promise.resolve(options.handBack?.(clock.now()) ?? "none"),
		adoptions: () => Promise.resolve(options.adoptionAt !== undefined && clock.now() >= options.adoptionAt ? 1 : 0),
		progress: () => Promise.resolve(),
		diag: (row) => {
			value.diagnosed++;
			return Promise.resolve({ digest: row.digest, now: clock.now() });
		},
	};
	return value;
}

describe("endurance conservation: the check waits for the dropped rows themselves", () => {
	it("[RED] a dropped row admitted 6 s after the check (past the old 5 s settle wait) is accounted, with its latency", async () => {
		const clock = virtualClock();
		const result = await accountDroppedRows(
			[{ digest: "a", droppedAt: 0 }],
			probe(clock, { a: 6_000 }),
			clock,
			OPTIONS
		);
		expect(result).toEqual([{ digest: "a", how: "exact", acceptedDigests: ["a"], latencyMs: 6_000 }]);
	});

	it("[RED] a replacement chain completed 8 s after the check carries the move", async () => {
		const clock = virtualClock();
		const result = await accountDroppedRows(
			[{ digest: "a", droppedAt: 0 }],
			probe(
				clock,
				{ r1: 8_000 },
				{ replacements: (now) => (now >= 2_000 ? [{ sourceDigest: "a", replacementDigests: ["r1"] }] : []) }
			),
			clock,
			OPTIONS
		);
		expect(result).toEqual([{ digest: "a", how: "replaced", acceptedDigests: ["r1"], latencyMs: 8_000 }]);
	});

	it("[RED] the bound extends to the next adoption plus the cap", async () => {
		const clock = virtualClock();
		// Admitted at 45 s: after start + cap (30 s), before the adoption at 20 s plus the cap (50 s).
		const result = await accountDroppedRows(
			[{ digest: "a", droppedAt: 0 }],
			probe(clock, { a: 45_000 }, { adoptionAt: 20_000 }),
			clock,
			OPTIONS
		);
		expect(result[0]?.latencyMs).toBe(45_000);
	});

	it("[RED] a hand-back record re-offered and admitted accounts for the move", async () => {
		const clock = virtualClock();
		const result = await accountDroppedRows(
			[{ digest: "a", droppedAt: 0 }],
			probe(clock, {}, { handBack: (now) => (now >= 3_000 ? "reoffered-admitted" : "pending") }),
			clock,
			OPTIONS
		);
		expect(result[0]?.how).toBe("handed-back");
	});

	it("[RED] strict: a row never admitted, replaced or handed back fails at the bound with the diagnostic dump", async () => {
		const clock = virtualClock();
		const peers = probe(clock, {});
		await expect(accountDroppedRows([{ digest: "a", droppedAt: 0 }], peers, clock, OPTIONS)).rejects.toThrow(
			/dropped source a/
		);
		expect(peers.diagnosed).toBeGreaterThanOrEqual(1);
	});

	it("[control] strict: a hand-back record that is never re-offered fails at the bound", async () => {
		const clock = virtualClock();
		await expect(
			accountDroppedRows(
				[{ digest: "a", droppedAt: 0 }],
				probe(clock, {}, { handBack: () => "pending" }),
				clock,
				OPTIONS
			)
		).rejects.toThrow(/dropped source a/);
	});

	it("[control] strict: an incomplete replacement chain fails at the bound", async () => {
		const clock = virtualClock();
		await expect(
			accountDroppedRows(
				[{ digest: "a", droppedAt: 0 }],
				probe(clock, { r1: 1_000 }, { replacements: () => [{ sourceDigest: "a", replacementDigests: ["r1", "r2"] }] }),
				clock,
				OPTIONS
			)
		).rejects.toThrow(/dropped source a/);
	});

	it("[control] a row admitted before the check is accounted at once", async () => {
		const clock = virtualClock();
		clock.at = 1_000;
		const result = await accountDroppedRows(
			[{ digest: "a", droppedAt: 200 }],
			probe(clock, { a: 900 }),
			clock,
			OPTIONS
		);
		expect(result).toEqual([{ digest: "a", how: "exact", acceptedDigests: ["a"], latencyMs: 800 }]);
	});
});
