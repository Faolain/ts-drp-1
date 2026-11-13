import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {describe, expect, it} from "vitest";
import {assertSettlementPlanProgressTransition, copySettlementPlan} from "../src/contract.js";
import {issuanceSourceCustodyPlanResourceForSizing} from "../src/retirement.js";
import {SETTLEMENT_HAND_BACK_LIMITS, SETTLEMENT_REPLACEMENT_DIGEST_LIMITS, type SettlementPlan} from "../src/types.js";

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
// - the HB reserve, and the member frontier when the geometry gives one.
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
	// reserved, so fill all of them, each with one operation byte (see OPERATION).
	const handBacks = changeable === 0 ? [] : Array.from({length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords}, (_, intent) => ({
		sourceSequence: Number.MAX_SAFE_INTEGER - 1, sourceDigest: new Uint8Array(32).fill(5), sourceEpoch: Number.MAX_SAFE_INTEGER,
		intent, exactCanonicalOperationBytes: new Uint8Array(OPERATION).fill(6), reissueSequence: null}));
	const raw = {scope, revision: prior.revision + 1, fenceSequence: null, entries: [...entries, ...potentials],
		sourceContexts: sorted(contexts), memberFrontier: frontier, ...(displaced ? {completedSourceCustody: true as const} : {}),
		...(handBacks.length === 0 ? {} : {handBacks})};
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
