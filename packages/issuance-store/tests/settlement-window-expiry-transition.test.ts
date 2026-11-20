import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { assertSettlementPlanProgressTransition, copySettlementPlan, type SettlementPlan } from "../src/contract.js";

// fix/browser-rollover-member-stall, blocker (b) of rule R (replacement retarget).
//
// An install whose epoch the creator has already sealed defers its replacements (rule R): the displaced
// row's entry stays an unreplaced replacement decision (disposition rebase or transform, replacementSequence
// null, no progress, no refusal). A later install's merge resolves it by the settlement window
// (v3-room mergedSettlementPlan: "Only an unreplaced replacement decision may become the window's
// expiry"), in the same plan write that gives the move back (one unconsumed hand-back record per
// operation). Before R that node path was dead (every eligible row was replaced at the install that
// merged it), and the store's progress law refused any disposition change outside a retained
// resolution, so the deferred row's window expiry failed the install ("settlement retained source
// changed").
//
// The law admits exactly that change, and only with the move given back in the same write:
// - unreplaced rebase/transform without context, resolution, progress, refusal, inheritance or portable
//   source -> expire, every other field equal, with at least one unconsumed hand-back record of that
//   source (sequence and digest) in the next plan;
// - never for a replaced entry, an entry with progress, a refused transform, a retained or resolved
//   entry, an inherited or portable entry, a manual-review entry, or without the hand-back.

const scope = { objectId: "window-room", author: "writer" };
const bytes = (seed: number, length: number) => Uint8Array.from({ length }, (_, index) => (seed + index) % 256);
type Entry = SettlementPlan["entries"][number];
type HandBack = NonNullable<SettlementPlan["handBacks"]>[number];
const sourceDigest = bytes(3, 32);
const entry = (extra: Record<string, unknown> = {}): Entry =>
	({ sourceSequence: 2, sourceDigest, disposition: "rebase", replacementSequence: null, ...extra }) as Entry;
const handBack = (extra: Partial<HandBack> = {}): HandBack => ({
	sourceSequence: 2,
	sourceDigest,
	sourceEpoch: 5,
	intent: 0,
	exactCanonicalOperationBytes: encodeCanonical({ action: "place", id: "block-1-3" }),
	reissueSequence: null,
	...extra,
});
const plan = (entries: readonly Entry[], revision: number, handBacks?: readonly HandBack[]): SettlementPlan => ({
	scope,
	revision,
	fenceSequence: 7,
	entries: [...entries],
	...(handBacks === undefined ? {} : { handBacks: [...handBacks] }),
});

describe("store law: the settlement window expires a deferred (unreplaced) replacement decision", () => {
	it("the fixtures are valid plans", () => {
		expect(copySettlementPlan(plan([entry()], 4), scope)).toBeDefined();
		expect(copySettlementPlan(plan([entry({ disposition: "expire" })], 5, [handBack()]), scope)).toBeDefined();
	});

	it("admits rebase -> expire and transform -> expire in the plan write that gives the move back", () => {
		for (const disposition of ["rebase", "transform"] as const) {
			const before = plan([entry({ disposition })], 4);
			const after = plan([entry({ disposition: "expire" })], 5, [handBack()]);
			expect(() => assertSettlementPlanProgressTransition(before, after), disposition).not.toThrow();
		}
		// A move of several operations: one record per operation.
		expect(() =>
			assertSettlementPlanProgressTransition(
				plan([entry()], 4),
				plan([entry({ disposition: "expire" })], 5, [handBack(), handBack({ intent: 1 })])
			)
		).not.toThrow();
	});

	it("refuses the expiry without the move given back in the same write", () => {
		const before = plan([entry()], 4);
		expect(() => assertSettlementPlanProgressTransition(before, plan([entry({ disposition: "expire" })], 5))).toThrow(
			"settlement retained source changed"
		);
		// A record of another source, or of this sequence with another digest, does not give this move back.
		for (const other of [handBack({ sourceSequence: 9 }), handBack({ sourceDigest: bytes(40, 32) })])
			expect(() =>
				assertSettlementPlanProgressTransition(before, plan([entry({ disposition: "expire" })], 5, [other]))
			).toThrow("settlement retained source changed");
	});

	it("refuses the expiry of anything but an unreplaced, unrefused, unretained own replacement decision", () => {
		const progress = {
			replacementProgress: { chunks: [], intentCount: 2, intentDigest: bytes(9, 32), version: 1 },
		};
		const refusal = { disposition: "transform", transformRefusal: { reason: "refused", proposedIntentDigest: bytes(11, 32) } };
		for (const extra of [{ replacementSequence: 3 }, progress, refusal, { disposition: "manual-review" }]) {
			const before = plan([entry(extra)], 4);
			const after = plan([entry({ ...extra, disposition: "expire" })], 5, [handBack()]);
			expect(() => assertSettlementPlanProgressTransition(before, after), JSON.stringify(Object.keys(extra))).toThrow();
		}
	});

	it("an expired entry never changes back, and other fields never change with the expiry", () => {
		const expired = plan([entry({ disposition: "expire" })], 5, [handBack()]);
		expect(() => assertSettlementPlanProgressTransition(expired, plan([entry()], 6, [handBack()]))).toThrow();
		expect(() =>
			assertSettlementPlanProgressTransition(
				plan([entry()], 4),
				plan([entry({ disposition: "expire", sourceDigest: bytes(40, 32) })], 5, [handBack({ sourceDigest: bytes(40, 32) })])
			)
		).toThrow();
	});
});
