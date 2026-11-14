import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	applySettlementPlanEffect,
	assertSettlementPlanProgressTransition,
	copySettlementPlan,
} from "../src/contract.js";
import { issuanceSourceCustodyPlanResourceForSizing } from "../src/retirement.js";
import {
	SETTLEMENT_HAND_BACK_LIMITS,
	SETTLEMENT_REPLACEMENT_DIGEST_LIMITS,
	type SettlementPlan,
} from "../src/types.js";

// G22 (one bound): the merged custody sizing must be at least the written plan for every way the
// changeable sources can end. The changeable sources are the potential rows and the existing
// unresolved entries. Each case below writes the widest legal successor of one prior plan for one
// disposition, and checks it against the sized resource.
//
// The merged charged set (issuanceSourceCustodyPlanResourceForSizing):
// - every existing entry and context stays whole.
// - one open current-epoch context.
// - Rule D (issuance-image-capacity.qnt D): each potential row and each unresolved entry ends either
//   as a member of a new completion, or with one expiry receipt. Terminal entries may also be members.
// - one replaced-source receipt for each completed replacement that is still resolvable, and for each
//   potential row (a replaced potential row stays a possible completion member).
// - one displaced-source context when a completed replacement still lacks its context, plus the
//   completed-source custody marker.
// - the HB reserve, each record with its move's origin (track 46), the reissue-origin reserve (one entry
//   per record slot that could still yield one, consumed records included, within the entry bound of 64),
//   and the member frontier when
//   the geometry gives one.
const scope = {objectId: "source-custody-sizing-dispositions", author: "writer"};
const geometry = {maxContextByteLength: 74_107, maxCompletionByteLength: 70_432, maxCompletionMemberByteLength: 512,
	maxExpiryByteLength: 1_024, maxNativeReadByteLength: 786_432, maxMemberFrontierByteLength: 4_096};
const DOMAIN = "ts-drp/settlement-source-context/v1";
/** The widest own source preimage. It bounds the operation bytes of one reserved hand-back record. */
const OPERATION = 1;
type Entry = SettlementPlan["entries"][number];
type Context = {digest: Uint8Array; exactCanonicalContextBytes: Uint8Array};

let marker = 0;
/** A context of exactly `size` bytes whose digest no other context in the test shares. */
const context = (size: number): Context => {
	const exactCanonicalContextBytes = new Uint8Array(size).fill(0xa5);
	exactCanonicalContextBytes.set(new Uint8Array(new Uint32Array([++marker]).buffer).subarray(0, Math.min(4, size)));
	return {digest: hashDomain(DOMAIN, exactCanonicalContextBytes), exactCanonicalContextBytes};
};
const sorted = (contexts: readonly Context[]) => [...contexts].sort((a, b) => Buffer.compare(a.digest, b.digest));

type Disposition = "manual-review" | "expire-frontier" | "committed-member" | "split" | "replaced-source";
const DISPOSITIONS: readonly Disposition[] = ["manual-review", "expire-frontier", "committed-member", "split", "replaced-source"];

/**
 * The prior plan: one committed entry (terminal), `unresolved` manual-review entries with a source
 * context, and `replaced` completed transform replacements without a context or a resolution
 * (replacedSourceResolvable and completedWithoutContext).
 */
function priorPlan(unresolved: number, replaced: number): Readonly<{plan: SettlementPlan; source: Context}> {
	const source = context(4_096), completion = context(2_048);
	const entries: Entry[] = [{sourceSequence: 0, sourceDigest: new Uint8Array(32).fill(1), sourceContextDigest: source.digest,
		sourceResolutionDigest: completion.digest, disposition: "committed", replacementSequence: null}];
	for (let index = 0; index < unresolved; index++) entries.push({sourceSequence: 1 + index, sourceDigest: new Uint8Array(32).fill(2),
		sourceContextDigest: source.digest, disposition: "manual-review", replacementSequence: null});
	for (let index = 0; index < replaced; index++) entries.push({sourceSequence: 1 + unresolved + index,
		sourceDigest: new Uint8Array(32).fill(3), disposition: "transform", replacementSequence: Number.MAX_SAFE_INTEGER - index});
	const plan = copySettlementPlan({scope, revision: 7, fenceSequence: null, entries,
		sourceContexts: sorted([source, completion])}, scope);
	if (plan === undefined) throw new Error("prior plan fixture invalid");
	return {plan, source};
}

/** The widest legal successor in which every changeable source ends with `disposition`. */
function writtenPlan(prior: SettlementPlan, potential: number, disposition: Disposition): SettlementPlan {
	const contexts: Context[] = [...(prior.sourceContexts ?? [])];
	const open = context(geometry.maxContextByteLength);
	const unresolved = prior.entries.filter(entry => entry.disposition === "manual-review");
	const terminal = prior.entries.length - unresolved.length;
	// Who joins the completion. In "split", the first half of the changeable sources join and the rest expire.
	const changeable = unresolved.length + potential;
	const joins = (index: number): boolean => disposition === "committed-member" ||
		(disposition === "split" && index < Math.ceil(changeable / 2)) ||
		// replaced-source: the unresolved entries expire (their widest end). Every potential row is a completion
		// member: the first one commits, which keeps the completion referenced, and the others are replaced and
		// resolved as replaced sources.
		(disposition === "replaced-source" && index === unresolved.length);
	const members = disposition === "replaced-source" ? potential
		: Array.from({length: changeable}, (_, index) => index).filter(joins).length;
	const completion = members === 0 ? undefined
		: context(geometry.maxCompletionByteLength + (terminal + members) * geometry.maxCompletionMemberByteLength);
	if (completion !== undefined) contexts.push(completion);
	const receipt = (size = geometry.maxExpiryByteLength) => { const value = context(size); contexts.push(value); return value.digest; };
	const end = (entry: Entry, index: number): Entry => {
		if (disposition === "manual-review") return entry;
		if (joins(index)) return {...entry, disposition: "committed", sourceResolutionDigest: completion!.digest};
		if (disposition === "replaced-source" && index > unresolved.length) return {...entry, disposition: "transform", replacementSequence: Number.MAX_SAFE_INTEGER - 1_000 - index,
			sourceResolutionDigest: receipt(), sourceResolutionKind: "replacement", sourceResolutionScope: "replaced-source"};
		return {...entry, disposition: "expire", sourceResolutionDigest: receipt(), sourceResolutionKind: "frontier"};
	};
	let displaced = false;
	const entries = prior.entries.map(entry => {
		if (entry.disposition === "manual-review") return end(entry, unresolved.indexOf(entry));
		if (entry.disposition !== "transform") return entry;
		// Every completed replacement gains its replaced-source resolution (the wider "replacement" kind)
		// and receipt. The first one also gains its displaced source's context (one per close).
		const withContext = displaced ? {} : {sourceContextDigest: (() => { displaced = true; const value = context(geometry.maxContextByteLength); contexts.push(value); return value.digest; })()};
		return {...entry, ...withContext, sourceResolutionDigest: receipt(), sourceResolutionKind: "replacement" as const,
			sourceResolutionScope: "replaced-source" as const};
	});
	const base = prior.entries.length;
	const potentials = Array.from({length: potential}, (_, index) => end({sourceSequence: base + index,
		sourceDigest: new Uint8Array(32).fill(4), sourceContextDigest: open.digest, disposition: "manual-review",
		replacementSequence: null}, unresolved.length + index));
	if (potential > 0) contexts.push(open);
	const frontier = context(geometry.maxMemberFrontierByteLength);
	// A frontier resolution may add hand-back records. While any changeable source remains, every free slot is
	// reserved, so fill all of them, each with one operation byte (see OPERATION) and its move's origin at the
	// widest integer (a resolved row that carried a reissued or replaced move).
	const handBacks =
		changeable === 0
			? []
			: Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, (_, intent) => ({
					sourceSequence: Number.MAX_SAFE_INTEGER - 1,
					sourceDigest: new Uint8Array(32).fill(5),
					sourceEpoch: Number.MAX_SAFE_INTEGER,
					intent,
					exactCanonicalOperationBytes: new Uint8Array(OPERATION).fill(6),
					reissueSequence: null,
					originSequence: Number.MAX_SAFE_INTEGER - 2,
				}));
	const raw = {
		scope,
		revision: prior.revision + 1,
		fenceSequence: null,
		entries: [...entries, ...potentials],
		sourceContexts: sorted(contexts),
		memberFrontier: frontier,
		...(displaced ? { completedSourceCustody: true as const } : {}),
		...(handBacks.length === 0 ? {} : { handBacks }),
	};
	const plan = copySettlementPlan(raw, scope);
	if (plan === undefined) throw new Error(`written plan invalid for ${disposition}`);
	return plan;
}

describe("merged custody sizing covers every written disposition (G22)", () => {
	// [unresolved existing entries, completed replacements, potential rows]
	it.each([[0, 0, 1], [3, 2, 4], [0, 32, 0], [16, 0, 32], [24, 24, 48], [0, 1, 96]])(
		"sized >= written for %i unresolved, %i replaced and %i potential", (unresolved, replaced, potential) => {
			const {plan: prior} = priorPlan(unresolved, replaced);
			const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, potential, geometry, OPERATION);
			for (const disposition of DISPOSITIONS) {
				if (potential === 0 && unresolved === 0 && disposition !== "manual-review") continue;
				const written = writtenPlan(prior, potential, disposition);
				// The successor is a legal write of the prior plan, so the sizing has to cover it.
				expect(() => assertSettlementPlanProgressTransition(prior, written), disposition).not.toThrow();
				expect(written.sourceContexts!.reduce((sum, value) => sum + value.exactCanonicalContextBytes.byteLength, 0))
					.toBeLessThanOrEqual(SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes);
				const canonical = encodeCanonical(written, {maxBytes: resource.byteLength, maxItems: resource.items, maxDepth: resource.maxDepth});
				expect(canonical.byteLength, `${disposition}: canonical width`).toBeLessThanOrEqual(resource.byteLength);
				const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
				expect(Buffer.byteLength(native), `${disposition}: native carrier`).toBeLessThanOrEqual(resource.nativeStorageByteLength);
			}
		});
	it("charges the replaced-source receipts of existing completed replacements beyond the rule D split", () => {
		// Same prior entries, with and without resolvable completed replacements: each one adds at least its receipt.
		const without = issuanceSourceCustodyPlanResourceForSizing(scope, priorPlan(4, 0).plan, 8, geometry);
		const withReplaced = issuanceSourceCustodyPlanResourceForSizing(scope, priorPlan(4, 6).plan, 8, geometry);
		expect(withReplaced.byteLength - without.byteLength).toBeGreaterThan(6 * geometry.maxExpiryByteLength + geometry.maxContextByteLength);
	});
});

// Track 46 (reissueOrigins): every new written shape is sized. A record carries its move's origin; every
// record slot that could still yield one reserves one reissue-origin entry, a separate bound from the records
// (64 unconsumed records plus 64 entries); the reissue's admission sizes the plan after its own effect
// (consumption plus the entry), and later writes stay within the reserve.
describe("reissue origins are sized (G22; CLOSED_RETIREMENT_BYTES unchanged)", () => {
	const defined = <T>(value: T | undefined, label: string): T => {
		if (value === undefined) throw new Error(`${label}: fixture undefined`);
		return value;
	};
	const measured = (
		written: SettlementPlan,
		resource: ReturnType<typeof issuanceSourceCustodyPlanResourceForSizing>,
		label: string
	): void => {
		const canonical = encodeCanonical(written, {
			maxBytes: resource.byteLength,
			maxItems: resource.items,
			maxDepth: resource.maxDepth,
		});
		expect(canonical.byteLength, `${label}: canonical width`).toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({
			kind: "canonical-settlement-plan-1",
			bytes: Buffer.from(canonical).toString("base64"),
		});
		expect(Buffer.byteLength(native), `${label}: native carrier`).toBeLessThanOrEqual(resource.nativeStorageByteLength);
	};
	/**
	 * A prior plan with unconsumed hand-back records (each of one operation byte) and reissue-origin entries.
	 * @param records - How many unconsumed records.
	 * @param origins - How many reissueOrigins entries.
	 * @returns The plan.
	 */
	const withRecords = (records: number, origins: number): SettlementPlan => {
		const { plan } = priorPlan(2, 0);
		const value = copySettlementPlan(
			{
				...plan,
				...(records === 0
					? {}
					: {
							handBacks: Array.from({ length: records }, (_, index) => ({
								sourceSequence: 1_000 + index,
								sourceDigest: new Uint8Array(32).fill(5),
								sourceEpoch: 1,
								intent: 0,
								exactCanonicalOperationBytes: new Uint8Array(OPERATION).fill(6),
								reissueSequence: null,
								originSequence: index,
							})),
						}),
				...(origins === 0
					? {}
					: {
							reissueOrigins: Array.from({ length: origins }, (_, index) => ({
								originSequence: Number.MAX_SAFE_INTEGER - 1_000 - origins + index,
								reissueSequence: Number.MAX_SAFE_INTEGER - 999 - origins + index,
							})),
						}),
			},
			scope
		);
		if (value === undefined) throw new Error("prior plan fixture invalid");
		return value;
	};
	/**
	 * Every unconsumed record consumed by its own reissue (each effect adds its entry), in record order.
	 * @param prior - The plan with the records.
	 * @param from - The first reissued row's author sequence.
	 * @returns The plan after every reissue.
	 */
	const consumeAll = (prior: SettlementPlan, from: number): SettlementPlan => {
		let plan = prior;
		for (const [index, record] of (prior.handBacks ?? []).entries())
			plan = applySettlementPlanEffect(
				plan,
				{
					kind: "hand-back",
					sourceSequence: record.sourceSequence,
					intent: record.intent,
					originSequence: record.originSequence ?? record.sourceSequence,
				},
				from + index
			);
		return plan;
	};

	it("plan with 64 entries: 64 records consumed after the sizing are within it", () => {
		const prior = withRecords(SETTLEMENT_HAND_BACK_LIMITS.maxRecords, 0);
		const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 4, geometry, OPERATION);
		const written = consumeAll(prior, 2_000_000);
		expect(written.reissueOrigins).toHaveLength(64);
		measured(written, resource, "64 consumed with 64 entries");
	});

	it("consumption at the entry bound: 63 entries plus one more reissue", () => {
		const prior = withRecords(1, SETTLEMENT_HAND_BACK_LIMITS.maxRecords - 1);
		const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 0, geometry, OPERATION);
		const written = consumeAll(prior, Number.MAX_SAFE_INTEGER - 10);
		expect(written.reissueOrigins).toHaveLength(64);
		measured(written, resource, "entry bound");
		// The bound itself refuses the next reissue (a separate record, unconsumed).
		const records = defined(written.handBacks, "records");
		const full = defined(
			copySettlementPlan(
				{
					...written,
					handBacks: [
						...records,
						{
							...defined(records[0], "first record"),
							sourceSequence: 5_000,
							reissueSequence: null,
							originSequence: 4_000,
						},
					],
				},
				scope
			),
			"full plan"
		);
		expect(() =>
			applySettlementPlanEffect(
				full,
				{ kind: "hand-back", sourceSequence: 5_000, intent: 0 },
				Number.MAX_SAFE_INTEGER - 1
			)
		).toThrow();
	});

	it("consumed records still reserve their slots' entries: 64 consumed records whose entries settled", () => {
		// Model issuance-image-capacity.qnt, O (mutant originReserveIgnoresConsumed): a window write drops the
		// consumed records, new records take their slots and are reissued in turn. The plan sized while the
		// consumed records were still present covers the 64 entries those reissues write.
		const consumed = consumeAll(withRecords(SETTLEMENT_HAND_BACK_LIMITS.maxRecords, 0), 2_000_000);
		const { reissueOrigins: _settled, ...withoutEntries } = consumed;
		const prior = defined(copySettlementPlan(withoutEntries, scope), "prior plan");
		expect(prior.reissueOrigins).toBeUndefined();
		expect(defined(prior.handBacks, "records").every((record) => record.reissueSequence !== null)).toBe(true);
		const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 0, geometry, OPERATION);
		expect(consumed.reissueOrigins).toHaveLength(64);
		measured(consumed, resource, "64 consumed records and 64 new entries");
	});

	it("records with origin and 64 entries in one plan: 64 unconsumed records plus 64 entries", () => {
		// The record and entry bounds are separate: the prior's 64 entries take no record slot, so a frontier
		// resolution may still fill every free record slot (each with its origin).
		const prior = withRecords(0, SETTLEMENT_HAND_BACK_LIMITS.maxRecords);
		const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 4, geometry, OPERATION);
		const written = writtenPlan(prior, 4, "expire-frontier");
		const withEntries = defined(
			copySettlementPlan({ ...written, reissueOrigins: prior.reissueOrigins }, scope),
			"plan with entries"
		);
		expect(withEntries.handBacks).toHaveLength(64);
		expect(defined(withEntries.handBacks, "records").every((record) => record.originSequence !== undefined)).toBe(true);
		expect(withEntries.reissueOrigins).toHaveLength(64);
		expect(() => assertSettlementPlanProgressTransition(prior, withEntries)).not.toThrow();
		measured(withEntries, resource, "64 records with origin plus 64 entries");
	});

	it("an unconsumed record without an origin is charged at both widest widths: consumed (bb6455fe) and with an origin", () => {
		// Both G22 charges apply to the same record: its reissue sets reissueSequence (up to MAX_SAFE_INTEGER)
		// and a record carries originSequence (up to MAX_SAFE_INTEGER); neither replaces the other.
		const { plan } = priorPlan(2, 0);
		const record = {
			sourceSequence: 1_000,
			sourceDigest: new Uint8Array(32).fill(5),
			sourceEpoch: 1,
			intent: 0,
			exactCanonicalOperationBytes: new Uint8Array(OPERATION).fill(6),
			reissueSequence: null,
		};
		const prior = defined(copySettlementPlan({ ...plan, handBacks: [record] }, scope), "prior plan");
		expect(defined(prior.handBacks, "records")[0]?.originSequence).toBeUndefined();
		for (const count of [0, 4]) {
			const resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, count, geometry, OPERATION);
			// Its reissue at the widest author sequence: consumed, plus its reissue-origin entry.
			const written = consumeAll(prior, Number.MAX_SAFE_INTEGER - 1);
			expect(written.handBacks?.[0]?.reissueSequence).toBe(Number.MAX_SAFE_INTEGER - 1);
			expect(written.reissueOrigins).toHaveLength(1);
			measured(written, resource, `reissue of an unconsumed record without origin, ${count} sources`);
			// The widest legal record both charges cover: consumed at the maximum reissueSequence and with an
			// origin (an origin is below the record's own source, so at most 999 here).
			const widest = defined(
				copySettlementPlan(
					{
						...written,
						handBacks: [{ ...record, reissueSequence: Number.MAX_SAFE_INTEGER, originSequence: 999 }],
						reissueOrigins: [{ originSequence: 999, reissueSequence: Number.MAX_SAFE_INTEGER }],
					},
					scope
				),
				"widest plan"
			);
			measured(widest, resource, `widest record, ${count} sources`);
			// With a one-byte origin only the consumed-width charge widens the record: less than both charges.
			const consumedWidthOnly = issuanceSourceCustodyPlanResourceForSizing(
				scope,
				defined(copySettlementPlan({ ...plan, handBacks: [{ ...record, originSequence: 1 }] }, scope), "with origin"),
				count,
				geometry,
				OPERATION
			);
			expect(resource.byteLength).toBeGreaterThan(consumedWidthOnly.byteLength);
		}
	});

	it("measured widths: an origin adds 25 bytes per record, an entry is 53 bytes, 64 entries add 3,410", () => {
		const max = Number.MAX_SAFE_INTEGER;
		const recordFields = {
			sourceSequence: max,
			sourceDigest: new Uint8Array(32),
			sourceEpoch: max,
			intent: max,
			exactCanonicalOperationBytes: new Uint8Array(OPERATION),
			reissueSequence: max,
		};
		expect(
			encodeCanonical({ ...recordFields, originSequence: max }).byteLength - encodeCanonical(recordFields).byteLength
		).toBe(25);
		const entry = { originSequence: max, reissueSequence: max };
		expect(encodeCanonical(entry).byteLength).toBe(53);
		const entries = Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, () => entry);
		expect(encodeCanonical({ reissueOrigins: entries }).byteLength - encodeCanonical({}).byteLength).toBe(3_410);
	});
});
