import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	assertSettlementPlanProgressTransition,
	copySettlementPlan,
	type SettlementPlan,
} from "../src/contract.js";
import {
	closeIssuanceRetirementProtectedRecords,
	settlementEntryPermitsSourceRelease,
	settlementPlanPermitsAuthenticatedPruning,
	type DurableIssuanceRetirementControl,
	type IssuanceRetirementRows,
} from "../src/retirement.js";

// fix/creator-replaced-source-resolution, design (b) (held-anchor-retention.qnt releaseFenceOverLost):
// a completed replacement entry (rebase or transform, its replacement issued) may carry a write-once
// replaced-source frontier resolution: the author's signed receipt that the creator's frontier proved
// the source never admitted (displaced, fence-guarded, window-expired). It stops the entry needing the
// plan's current fence to let its source go. The store law is structural only; the native reopen
// census authenticates the receipt on every open and fails closed.

const scope = { objectId: "replaced-room", author: "writer" };
const context = (marker: string) => {
	const exactCanonicalContextBytes = encodeCanonical({ marker });
	return { digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes };
};
const receipt = context("replaced-source-receipt");
const fenceContext = context("fence-context");
const bytes = (seed: number, length: number) => Uint8Array.from({ length }, (_, index) => (seed + index) % 256);

type Entry = SettlementPlan["entries"][number];
const resolved = { sourceResolutionDigest: receipt.digest, sourceResolutionKind: "frontier", sourceResolutionScope: "replaced-source" } as const;
const rebase = (extra: Record<string, unknown> = {}): Entry =>
	({ sourceSequence: 2, sourceDigest: bytes(3, 32), disposition: "rebase", replacementSequence: 3, ...extra }) as Entry;
const plan = (entries: readonly Entry[], fenceSequence: number | null = null, revision = 4): SettlementPlan => {
	const contexts = [receipt, fenceContext].filter(value => entries.some(entry =>
		[entry.sourceContextDigest, entry.sourceResolutionDigest].some(digest => digest !== undefined &&
			Buffer.from(digest).equals(Buffer.from(value.digest)))));
	return { scope, revision, fenceSequence, entries: [...entries],
		...(contexts.length === 0 ? {} : { sourceContexts: contexts.sort((a, b) => Buffer.compare(a.digest, b.digest)) }) };
};

describe("store law: a replaced-source frontier resolution", () => {
	it("is accepted on a completed rebase or transform entry, with or without a retained source context", () => {
		expect(copySettlementPlan(plan([rebase(resolved)]), scope)?.entries[0]).toMatchObject(resolved);
		expect(copySettlementPlan(plan([rebase({ ...resolved, disposition: "transform" })]), scope)?.entries[0]).toMatchObject(resolved);
		expect(copySettlementPlan(plan([rebase({ ...resolved, sourceContextDigest: fenceContext.digest })]), scope)?.entries[0])
			.toMatchObject(resolved);
	});

	it("is refused on an entry with no replacement, on a terminal, manual-review or inherited entry, and on a portable source", () => {
		for (const extra of [
			{ replacementSequence: null },
			{ disposition: "manual-review", replacementSequence: null },
			{ disposition: "expire", replacementSequence: null, sourceContextDigest: fenceContext.digest },
			{ disposition: "committed", replacementSequence: null, sourceContextDigest: fenceContext.digest },
			{ sourceObjectId: "other-room" },
		]) expect(copySettlementPlan(plan([rebase({ ...resolved, ...extra })]), scope), JSON.stringify(Object.keys(extra))).toBeUndefined();
	});

	it("needs all three fields, and the scope names exactly one value", () => {
		const { sourceResolutionScope: _scope, ...noScope } = resolved;
		const { sourceResolutionKind: _kind, ...noKind } = resolved;
		const { sourceResolutionDigest: _digest, ...noDigest } = resolved;
		for (const extra of [noScope, noKind, noDigest, { ...resolved, sourceResolutionScope: "source" }])
			expect(copySettlementPlan(plan([rebase(extra)]), scope), JSON.stringify(extra)).toBeUndefined();
	});

	it("an expire frontier resolution keeps its form (no scope)", () => {
		const expire = { sourceSequence: 2, sourceDigest: bytes(3, 32), disposition: "expire", replacementSequence: null,
			sourceContextDigest: fenceContext.digest, sourceResolutionDigest: receipt.digest, sourceResolutionKind: "frontier" } as Entry;
		expect(copySettlementPlan(plan([expire]), scope)?.entries[0]).not.toHaveProperty("sourceResolutionScope");
		expect(copySettlementPlan(plan([{ ...expire, sourceResolutionScope: "replaced-source" } as Entry]), scope)).toBeUndefined();
	});

	it("arrives once on a completed entry and never changes or leaves after", () => {
		const before = plan([rebase()], null, 4);
		const after = plan([rebase(resolved)], null, 5);
		expect(() => assertSettlementPlanProgressTransition(before, after)).not.toThrow();
		const other = context("other-receipt");
		const changed: SettlementPlan = { ...plan([rebase({ ...resolved, sourceResolutionDigest: other.digest })], null, 6),
			sourceContexts: [other] };
		expect(() => assertSettlementPlanProgressTransition(after, changed)).toThrow();
		expect(() => assertSettlementPlanProgressTransition(after, plan([rebase()], null, 6))).toThrow();
		// Not with the replacement in the same write: the entry must already be completed.
		expect(() => assertSettlementPlanProgressTransition(plan([rebase({ replacementSequence: null })], null, 4), after)).toThrow();
	});
});

describe("retirement law: a fenceless plan lets a frontier-resolved replaced source go", () => {
	const control: DurableIssuanceRetirementControl = { kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
		incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null };
	function row(sequence: number, epoch: number, operation: unknown) {
		return { ...scope, authorSequence: sequence, canonicalPreimageBytes: encodeCanonical({ author: scope.author,
			authorSequence: sequence, epoch, kind: "drp-vertex", objectId: scope.objectId, operation, protocolMajor: 3 }),
		digest: bytes(sequence + 1, 32), signature: bytes(sequence + 65, 64) };
	}
	function image(entry: Entry, fenceSequence: number | null = null): IssuanceRetirementRows {
		const issued = [row(0, 0, { action: "causalJoin" }), row(1, 0, { action: "message" }), row(2, 1, { action: "message" }),
			row(3, 6, { action: "message", rebased: true })];
		return {
			lineages: [{ ...scope, next: 4, exhausted: false, prunedThroughAuthorSequence: null }],
			issued,
			outbox: issued.map(value => ({ ...scope, authorSequence: value.authorSequence, digest: value.digest,
				publishState: "published" as const })),
			plans: [plan([{ ...entry, sourceDigest: issued[2]!.digest }], fenceSequence)],
		};
	}
	const held = (rows: IssuanceRetirementRows) => closeIssuanceRetirementProtectedRecords({ control, rows, throughEpoch: 5,
		protectedRecords: [] }).map(value => value.authorSequence);

	it("without a fence the resolved source is not held; the unresolved one is", () => {
		expect(held(image(rebase(resolved)))).not.toContain(2);
		expect(held(image(rebase()))).toContain(2);
	});

	it("under a current fence nothing changes", () => {
		expect(held(image(rebase(resolved), 1))).not.toContain(2);
		expect(held(image(rebase(), 1))).not.toContain(2);
	});

	it("the per-entry release clause counts the resolution; the whole-plan pruning predicate is unchanged", () => {
		expect(settlementEntryPermitsSourceRelease(null, rebase(resolved))).toBe(true);
		expect(settlementEntryPermitsSourceRelease(null, rebase())).toBe(false);
		expect(settlementEntryPermitsSourceRelease(1, rebase())).toBe(true);
		expect(settlementEntryPermitsSourceRelease(null, { sourceSequence: 5, sourceDigest: bytes(9, 32),
			disposition: "manual-review", replacementSequence: null } as Entry)).toBe(false);
		// Prefix pruning of a fenceless plan still needs every entry terminal.
		expect(settlementPlanPermitsAuthenticatedPruning({ fenceSequence: null, entries: [rebase(resolved)] })).toBe(false);
		expect(settlementPlanPermitsAuthenticatedPruning({ fenceSequence: 1, entries: [rebase(resolved)] })).toBe(true);
	});
});
