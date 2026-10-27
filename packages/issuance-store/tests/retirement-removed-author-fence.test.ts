import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import {
	assertIssuanceRetirementPreparationRows,
	closeIssuanceRetirementProtectedRecords,
	issuanceRetirementCommitRows,
	issuanceRetirementFenceIsReleasable,
	issuanceRetirementPreparationWithPlanRewrite,
	type DurableIssuanceRetirementControl,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import type { SettlementPlan } from "../src/contract.js";

// Releasing a removed author's retained FENCE (FENCE-DESIGN.md candidate A; model
// formal/removed-author-fence-release.qnt). The T9 shape: seq 0 join, seq 1 the
// join-time `$drp.author-fence.v1` no-op kept as `expire` with no resolution, seq 2
// abandoned work with an authenticated expiry, and no current fence (removed author).

const scope = { objectId: "fence-room", author: "removed" };
const control: DurableIssuanceRetirementControl = { kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
	incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null };
const labels = { decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 3 };
const bytes = (seed: number, length: number) => Uint8Array.from({ length }, (_, index) => (seed + index) % 256);
const FENCE = (sequence: number) => ({ action: "$drp.author-fence.v1", fenceSequence: sequence, version: 1 });
const context = (marker: string) => {
	const exactCanonicalContextBytes = encodeCanonical({ marker });
	return { digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes };
};
const [sourceContext, resolution, otherContext] = [context("source"), context("resolution"), context("other")];

function row(sequence: number, epoch: number, operation: unknown) {
	return { ...scope, authorSequence: sequence, canonicalPreimageBytes: encodeCanonical({ author: scope.author,
		authorSequence: sequence, epoch, kind: "drp-vertex", objectId: scope.objectId, operation, protocolMajor: 3 }),
	digest: bytes(sequence + 1, 32), signature: bytes(sequence + 65, 64) };
}

type Entry = SettlementPlan["entries"][number];
function image(options: { fenceSequence?: number | null; fenceOperation?: unknown; fenceEpoch?: number;
	abandoned?: Partial<Entry>; extra?: Entry[] } = {}): IssuanceRetirementRows {
	const issued = [row(0, 0, { action: "causalJoin" }), row(1, options.fenceEpoch ?? 0, options.fenceOperation ?? FENCE(1)),
		row(2, 1, { action: "message" })];
	const fence: Entry = { sourceSequence: 1, sourceDigest: issued[1]!.digest, sourceContextDigest: sourceContext.digest,
		disposition: "expire", replacementSequence: null };
	const abandoned: Entry = { sourceSequence: 2, sourceDigest: issued[2]!.digest, sourceContextDigest: sourceContext.digest,
		sourceResolutionDigest: resolution.digest, disposition: "expire", replacementSequence: null, ...options.abandoned };
	const entries = [fence, abandoned, ...(options.extra ?? [])].sort((a, b) => a.sourceSequence - b.sourceSequence);
	const referenced = [sourceContext, resolution, otherContext].filter(value => entries.some(entry =>
		[entry.sourceContextDigest, entry.sourceResolutionDigest].some(digest => digest !== undefined &&
			Buffer.from(digest).equals(Buffer.from(value.digest)))));
	return {
		lineages: [{ ...scope, next: 3, exhausted: false, prunedThroughAuthorSequence: null }],
		issued,
		outbox: issued.map(value => ({ ...scope, authorSequence: value.authorSequence, digest: value.digest,
			publishState: value.authorSequence === 2 ? "pending" as const : "published" as const })),
		plans: [{ scope, revision: 4, fenceSequence: options.fenceSequence ?? null, entries,
			sourceContexts: referenced.sort((a, b) => Buffer.compare(a.digest, b.digest)) }],
	};
}
const hole = (rows: IssuanceRetirementRows, sequence: number) =>
	({ author: scope.author, authorSequence: sequence, digest: Buffer.from(rows.issued[sequence]!.digest).toString("hex") });
const held = (rows: IssuanceRetirementRows, selected: number[] = []) =>
	closeIssuanceRetirementProtectedRecords({ control, rows, throughEpoch: labels.throughEpoch,
		protectedRecords: selected.map(sequence => hole(rows, sequence)) }).map(value => value.authorSequence);

describe("removed author's retained FENCE release", () => {
	it("releases the fence once nothing below it is unresolved and the plan has no current fence", () => {
		const rows = image();
		expect(issuanceRetirementFenceIsReleasable(rows, rows.issued[1]!)).toBe(true);
		expect(held(rows)).toEqual([]);
		const p = issuanceRetirementPreparationWithPlanRewrite(control, { ...labels, protectedRecords: [] }, rows);
		expect(() => assertIssuanceRetirementPreparationRows(control, p, rows)).not.toThrow();
		const target = issuanceRetirementCommitRows(control, p, rows);
		// R4: the durable lineage never moves. The entry stays as custody while the
		// row is physically present; only its protection leaves.
		expect(target.lineages).toEqual(rows.lineages);
		expect(target.plans[0]!.entries.map(entry => entry.sourceSequence)).toEqual([1, 2]);
	});

	it("R1: the plan's current fence stays protected", () => {
		const rows = image();
		const fenced = { ...rows, plans: [{ ...rows.plans[0]!, fenceSequence: 1, entries: rows.plans[0]!.entries.slice(1) }] };
		expect(held(fenced)).toEqual([1]);
	});

	it("R2: unresolved work keeps the fence below it", () => {
		const rows = image({ abandoned: { disposition: "manual-review", sourceResolutionDigest: undefined } });
		expect(issuanceRetirementFenceIsReleasable(rows, rows.issued[1]!)).toBe(false);
		expect(held(rows)).toEqual([1, 2]);
	});

	it("R2: an unresolved application expiry keeps the fence", () => {
		const rows = image({ abandoned: { sourceResolutionDigest: undefined, sourceContextDigest: undefined } });
		expect(held(rows)).toEqual([1, 2]);
	});

	it("R2: unpublished work the plan does not classify keeps the fence", () => {
		const base = image();
		const issued = [...base.issued, row(3, 2, { action: "message" })];
		const rows: IssuanceRetirementRows = { ...base, issued, lineages: [{ ...base.lineages[0]!, next: 4 }],
			outbox: [...base.outbox, { ...scope, authorSequence: 3, digest: issued[3]!.digest, publishState: "pending" }] };
		expect(issuanceRetirementFenceIsReleasable(rows, rows.issued[1]!)).toBe(false);
		expect(held(rows)).toEqual([1]);
	});

	it("only the author's own self-fence no-op is a retained fence", () => {
		for (const fenceOperation of [{ action: "message" }, FENCE(0), { ...FENCE(1), version: 2 }]) {
			const rows = image({ fenceOperation });
			expect(issuanceRetirementFenceIsReleasable(rows, rows.issued[1]!)).toBe(false);
			expect(held(rows)).toEqual([1]);
		}
	});

	it("R3 belongs to the original selector: a selected fence stays, and one inside the window is never retired", () => {
		const rows = image();
		expect(held(rows, [1])).toEqual([1]);
		const recent = image({ fenceEpoch: labels.throughEpoch + 1 });
		const p = issuanceRetirementPreparationWithPlanRewrite(control, { ...labels, protectedRecords: [] }, recent);
		expect(p.protectedRecords).toEqual([]);
		expect(issuanceRetirementCommitRows(control, p, recent).plans[0]!.entries.map(entry => entry.sourceSequence)).toEqual([1, 2]);
	});

	it("an in-flight preparation that still protects the fence (written by the old law) stays valid and unchanged", () => {
		const rows = image();
		const p = issuanceRetirementPreparationWithPlanRewrite(control, { ...labels,
			protectedRecords: closeIssuanceRetirementProtectedRecords({ control, rows, throughEpoch: labels.throughEpoch,
				protectedRecords: [hole(rows, 1)] }) }, rows);
		expect(p.protectedRecords.map(value => value.authorSequence)).toEqual([1]);
		expect(p.planRewrite).toBeUndefined();
		expect(() => assertIssuanceRetirementPreparationRows(control, p, rows)).not.toThrow();
	});

	it("several retained fences of a removed author release together", () => {
		const base = image();
		const issued = [...base.issued, row(3, 1, FENCE(3))];
		const rows: IssuanceRetirementRows = { ...base, issued,
			lineages: [{ ...base.lineages[0]!, next: 4 }],
			outbox: [...base.outbox, { ...scope, authorSequence: 3, digest: issued[3]!.digest, publishState: "published" }],
			plans: [{ ...base.plans[0]!, entries: [...base.plans[0]!.entries, { sourceSequence: 3, sourceDigest: issued[3]!.digest,
				sourceContextDigest: sourceContext.digest, disposition: "expire", replacementSequence: null }] }] };
		expect(held(rows)).toEqual([]);
	});
});
