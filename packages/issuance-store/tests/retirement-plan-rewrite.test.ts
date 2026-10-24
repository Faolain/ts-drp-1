import { encodeCanonical, decodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import {
	assertIssuanceRetirementPreparationRows,
	closeIssuanceRetirementProtectedRecords,
	encodeIssuanceRetirementControl,
	decodeIssuanceRetirementControl,
	issuanceRetirementCommitRows,
	issuanceRetirementImage,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementPlanRewriteResourceForSizing,
	reconstructIssuanceRetirementSourceRows,
	settlementPlanPermitsAuthenticatedPruning,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementPreparation,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";
import { copySettlementPlan, assertSettlementPlanProgressTransition } from "../src/contract.js";

const scope = {objectId: "retirement-room", author: "writer"};
const control: DurableIssuanceRetirementControl = {kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
	incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null};
const labels = {decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 3};
function fixture(): IssuanceRetirementRows {
	const commits = Array.from({length: 5}, (_, sequence) => d109bCommit(scope, sequence, sequence));
	return {lineages: [{...scope, next: 5, exhausted: false, prunedThroughAuthorSequence: null}],
		issued: commits.map(commit => ({...scope, authorSequence: commit.authorSequence, ...commit.envelope})),
		outbox: commits.map(commit => ({...scope, authorSequence: commit.authorSequence,
			digest: commit.envelope.digest, publishState: "published"})),
		plans: [{scope, revision: 7, fenceSequence: 4, entries: [0, 1, 2].map(sequence => ({
			sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			disposition: "rebase", replacementSequence: sequence + 1}))}]};
}
function hole(rows: IssuanceRetirementRows, sequence: number) {
	const row = rows.issued[sequence]!;
	return {author: scope.author, authorSequence: sequence, digest: Buffer.from(row.digest).toString("hex")};
}
function prepare(rows: IssuanceRetirementRows, sequences: number[]): DurableIssuanceRetirementPreparation {
	const protectedRecords = closeIssuanceRetirementProtectedRecords({control, rows, throughEpoch: labels.throughEpoch,
		protectedRecords: sequences.map(sequence => hole(rows, sequence))});
	return issuanceRetirementPreparationWithPlanRewrite(control, {...labels, protectedRecords}, rows);
}

describe("native retirement plan law", () => {
	it("retains shared source proof through its last consumer and rejects substituted or orphaned references", () => {
		const original = fixture();
		const contexts = [0, 1].map(source => {const bytes = encodeCanonical({source});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", bytes), exactCanonicalContextBytes: bytes};});
		const plan = {...original.plans[0]!, sourceContexts: [...contexts].sort((a,b) => Buffer.compare(a.digest,b.digest)),
			entries: original.plans[0]!.entries.map((entry,index) => ({...entry, sourceContextDigest: contexts[index === 2 ? 1 : 0]!.digest}))};
		const rows = {...original, plans: [plan]};
		const copied = copySettlementPlan(plan, scope)!;
		expect(copied).toEqual(plan);
		expect(copied.sourceContexts![0]!.exactCanonicalContextBytes).not.toBe(plan.sourceContexts[0]!.exactCanonicalContextBytes);
		const partial = issuanceRetirementCommitRows(control, prepare(rows, [2]), rows).plans[0]!;
		expect(partial.entries.map(entry => entry.sourceSequence)).toEqual([2]);
		expect(partial.sourceContexts).toEqual([contexts[1]]);
		const complete = issuanceRetirementCommitRows(control, prepare(rows, []), rows).plans[0]!;
		expect(complete.entries).toEqual([]);
		expect(complete.sourceContexts).toBeUndefined();
		const heldRows = {...rows, plans: [{...plan, entries: plan.entries.map((entry,index) => index === 0 ?
			{...entry, disposition: "manual-review" as const, replacementSequence: null} : entry)}]};
		const held = issuanceRetirementCommitRows(control, prepare(heldRows, []), heldRows).plans[0]!;
		expect(held.entries.map(entry => entry.sourceSequence)).toEqual([0]);
		expect(held.sourceContexts).toEqual([contexts[0]]);
		expect(copySettlementPlan({...plan, sourceContexts: [contexts[0]]}, scope)).toBeUndefined();
		expect(copySettlementPlan({...plan, sourceContexts: [...plan.sourceContexts, plan.sourceContexts[0]]}, scope)).toBeUndefined();
		expect(copySettlementPlan({...plan, sourceContexts: plan.sourceContexts.map(context => ({...context,
			exactCanonicalContextBytes: encodeCanonical({source: "swapped"})}))}, scope)).toBeUndefined();
		const unbound = {...plan, entries: plan.entries.map(({sourceContextDigest: _source, ...entry}) => entry), sourceContexts: undefined};
		expect(() => assertSettlementPlanProgressTransition(plan, unbound)).toThrow("retained source changed");
	});
	it("admits a source resolution only as authenticated completion until an expiry verifier exists", () => {
		const original = fixture();
		const [source, proof] = [0, 1].map(marker => {const bytes = encodeCanonical({marker});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", bytes), exactCanonicalContextBytes: bytes};});
		const reviewed = {...original.plans[0]!.entries[0]!, disposition: "manual-review" as const, replacementSequence: null,
			sourceContextDigest: source!.digest};
		const prior = copySettlementPlan({...original.plans[0]!, entries: [reviewed], sourceContexts: [source]}, scope)!;
		expect(prior).toBeDefined();
		const resolved = (disposition: "committed" | "expire") => ({...prior, revision: prior.revision + 1,
			entries: [{...reviewed, disposition, sourceResolutionDigest: proof!.digest}],
			sourceContexts: [source!, proof!].sort((a, b) => Buffer.compare(a.digest, b.digest))});
		const committed = copySettlementPlan(resolved("committed"), scope)!;
		expect(committed).toBeDefined();
		expect(() => assertSettlementPlanProgressTransition(prior, committed)).not.toThrow();
		expect(copySettlementPlan(resolved("expire"), scope)).toBeUndefined();
		expect(() => assertSettlementPlanProgressTransition(prior, resolved("expire"))).toThrow("retained source changed");
	});
	it("permits fence-less pruning only when every entry is an authenticated terminal resolution", () => {
		const digest = (marker: number) => hashDomain("ts-drp/settlement-source-context/v1", encodeCanonical({marker}));
		const terminal = (disposition: "committed" | "expire", sequence: number) => ({sourceSequence: sequence,
			sourceDigest: digest(100 + sequence), sourceContextDigest: digest(sequence), sourceResolutionDigest: digest(50 + sequence),
			disposition, replacementSequence: null});
		type Entries = NonNullable<Parameters<typeof settlementPlanPermitsAuthenticatedPruning>[0]>["entries"];
		const permits = (fenceSequence: number | null, entries: Entries) =>
			settlementPlanPermitsAuthenticatedPruning({fenceSequence, entries});
		// A fully removed author has no Writer grant and therefore no FENCE.
		expect(permits(null, [terminal("committed", 0)])).toBe(true);
		expect(permits(null, [terminal("committed", 0), terminal("expire", 1)])).toBe(true);
		expect(permits(null, [terminal("expire", 0)])).toBe(true);
		// Negatives: an unauthenticated terminal, an open review, or replacement work
		// still needs the mandatory fence (or is never prunable).
		const {sourceResolutionDigest: _r, ...unresolvedExpire} = terminal("expire", 2);
		const {sourceResolutionDigest: _c, ...unresolvedCommit} = terminal("committed", 3);
		const {sourceContextDigest: _x, ...contextless} = terminal("committed", 4);
		expect(permits(null, [terminal("committed", 0), unresolvedExpire])).toBe(false);
		expect(permits(null, [unresolvedCommit])).toBe(false);
		expect(permits(null, [contextless])).toBe(false);
		expect(permits(null, [terminal("committed", 0), {...terminal("committed", 5), disposition: "manual-review"}])).toBe(false);
		expect(permits(null, [terminal("committed", 0), {...terminal("committed", 6), disposition: "rebase", replacementSequence: 9}])).toBe(false);
		expect(permits(null, [])).toBe(false);
		expect(settlementPlanPermitsAuthenticatedPruning(null)).toBe(false);
		// The fenced rule is unchanged.
		expect(permits(4, [unresolvedExpire, unresolvedCommit])).toBe(true);
		expect(permits(4, [{...terminal("committed", 5), disposition: "manual-review"}])).toBe(false);
		expect(permits(4, [])).toBe(true);
	});
	it("closes retained replacement chains to a fixed point", () => {
		const rows = fixture(), p = prepare(rows, [0]);
		expect(p.protectedRecords.map(value => value.authorSequence)).toEqual([0, 1, 2, 3]);
		expect(p.planRewrite).toBeUndefined();
		expect(() => assertIssuanceRetirementPreparationRows(control, {...labels, protectedRecords: [hole(rows, 0)]}, rows))
			.toThrow("not dependency closed");
	});
	it("drops only retired sources and reconstructs the exact original image", () => {
		const rows = fixture(), p = prepare(rows, [1]);
		expect(p.protectedRecords.map(value => value.authorSequence)).toEqual([1, 2, 3]);
		expect(p.planRewrite?.plans).toHaveLength(1);
		expect(encodeCanonical(p.planRewrite).byteLength).toBeLessThanOrEqual(
			issuanceRetirementPlanRewriteResourceForSizing(rows.plans)!.byteLength);
		assertIssuanceRetirementPreparationRows(control, p, rows);
		const target = issuanceRetirementCommitRows(control, p, rows);
		expect(target.plans[0]!.entries.map(entry => entry.sourceSequence)).toEqual([1, 2]);
		expect(target.plans[0]!.revision).toBe(8);
		expect(target.plans[0]!.fenceSequence).toBe(4);
		const completed = {...control, revision: 2, sequence: 1, completed: p};
		expect(reconstructIssuanceRetirementSourceRows(completed, p, target)).toEqual(rows);
		expect(issuanceRetirementImage(target, scope.objectId).imageDigest).toBe(p.planRewrite!.targetImageDigest);
		expect(decodeIssuanceRetirementControl(encodeIssuanceRetirementControl(completed))).toEqual(completed);
	});
	it("rejects missing, substituted and independently changed rewrite evidence", () => {
		const rows = fixture(), p = prepare(rows, [1]);
		expect(() => assertIssuanceRetirementPreparationRows(control, {...labels, protectedRecords: p.protectedRecords}, rows))
			.toThrow("rewrite differs");
		const after = decodeCanonical(p.planRewrite!.plans[0]!.after) as Record<string, unknown>;
		const substituted = {...p, planRewrite: {...p.planRewrite!, plans: [{before: p.planRewrite!.plans[0]!.before,
			after: encodeCanonical({...after, entries: []})}]}};
		expect(() => assertIssuanceRetirementPreparationRows(control, substituted, rows)).toThrow("rewrite differs");
		const target = issuanceRetirementCommitRows(control, p, rows);
		const changed = {...target, plans: [{...target.plans[0]!, revision: 9}]};
		expect(() => reconstructIssuanceRetirementSourceRows({...control, completed: p}, p, changed)).toThrow("target changed");
		expect(() => assertIssuanceRetirementPreparationRows(control,
			{...p, protectedRecords: [{...p.protectedRecords[0]!, digest: "d".repeat(64)}]}, rows)).toThrow();
	});
	it("keeps unresolved reviews and refuses permanent-hole resurrection", () => {
		const original = fixture();
		const rows: IssuanceRetirementRows = {...original, plans: [{...original.plans[0]!, entries: [
			{...original.plans[0]!.entries[0]!, disposition: "manual-review", replacementSequence: null},
			...original.plans[0]!.entries.slice(1)]}]};
		const p = prepare(rows, []);
		expect(p.protectedRecords.map(value => value.authorSequence)).toEqual([0]);
		const retired: DurableIssuanceRetirementControl = {...control, completed: {...labels, protectedRecords: []}};
		expect(() => closeIssuanceRetirementProtectedRecords({control: retired, rows, throughEpoch: 3,
			protectedRecords: []})).toThrow("permanently retired");
	});
	it("retains the exact native source while a portable replacement consumes it", () => {
		const original = fixture(), target = original.issued[3]!, source = original.issued[2]!;
		const row = {...target, canonicalPreimageBytes: encodeCanonical({
			...(decodeCanonical(target.canonicalPreimageBytes) as object), settlementSource: {
				sourceObjectId: scope.objectId, sourceAuthor: scope.author, sourceSequence: 2,
				sourceDigest: Buffer.from(source.digest).toString("hex")}})};
		const rows = {...original, issued: original.issued.map(value => value === target ? row : value)};
		expect(prepare(rows, [3]).protectedRecords.map(value => value.authorSequence)).toEqual([2, 3]);
	});
	it("releases a 32-replacement portable dependency chain when its endpoint no longer needs replay", () => {
		const last = 32, fence = last + 1;
		const commits = Array.from({length: fence + 1}, (_, sequence) => d109bCommit(scope, sequence, sequence));
		const issued = commits.map((commit, sequence) => ({...scope, authorSequence: sequence, ...commit.envelope,
			...(sequence > 0 && sequence <= last ? {canonicalPreimageBytes: encodeCanonical({
				...(decodeCanonical(commit.envelope.canonicalPreimageBytes) as object), settlementSource: {
					sourceObjectId: scope.objectId, sourceAuthor: scope.author, sourceSequence: sequence - 1,
					sourceDigest: Buffer.from(commits[sequence - 1]!.envelope.digest).toString("hex")}})} : {})}));
		const rows: IssuanceRetirementRows = {lineages: [{...scope, next: fence + 1, exhausted: false,
			prunedThroughAuthorSequence: null}], issued,
			outbox: issued.map(row => ({...scope, authorSequence: row.authorSequence, digest: row.digest, publishState: "published"})),
			plans: [{scope, revision: 9, fenceSequence: fence, entries: Array.from({length: last}, (_, sequence) => ({
				sourceSequence: sequence, sourceDigest: issued[sequence]!.digest, disposition: "rebase", replacementSequence: sequence + 1}))}]};
		const pending = closeIssuanceRetirementProtectedRecords({control, rows, throughEpoch: last, protectedRecords: [hole(rows, last)]});
		expect(pending).toHaveLength(last + 1);
		// The signed census/replay owner supplies the endpoint's terminal disposition.
		// This law test establishes release after that fact, not eventual delivery of it.
		const completed = closeIssuanceRetirementProtectedRecords({control, rows, throughEpoch: last, protectedRecords: []});
		expect(completed).toEqual([]);
		const p = issuanceRetirementPreparationWithPlanRewrite(control, {...labels, throughEpoch: last, protectedRecords: completed}, rows);
		assertIssuanceRetirementPreparationRows(control, p, rows);
		expect(issuanceRetirementCommitRows(control, p, rows).plans[0]).toEqual({...rows.plans[0], revision: 10, entries: []});
	});
	it("keeps external replacement custody separate from colliding local ordinals", () => {
		const original = fixture(), target = original.issued[1]!;
		for (const sequence of [0, 10]) {
			const sourceDigest = new Uint8Array(32).fill(170);
			const rows: IssuanceRetirementRows = {...original,
				issued: original.issued.map(row => row !== target ? row : {...row, canonicalPreimageBytes: encodeCanonical({
					...(decodeCanonical(row.canonicalPreimageBytes) as object), settlementSource: {
						sourceObjectId: "original-room", sourceAuthor: scope.author, sourceSequence: sequence,
						sourceDigest: Buffer.from(sourceDigest).toString("hex")}})}),
				plans: [{...original.plans[0]!, entries: [{sourceObjectId: "original-room", sourceSequence: sequence,
					sourceDigest, disposition: "rebase", replacementSequence: 1}]}]};
			const p = prepare(rows, [1]);
			expect(p.protectedRecords.map(value => value.authorSequence)).toEqual([1]);
			expect(p.planRewrite).toBeUndefined();
			expect(() => assertIssuanceRetirementPreparationRows(control, p, rows)).not.toThrow();
			const swapped = {...rows, plans: [{...rows.plans[0]!, entries: [{...rows.plans[0]!.entries[0]!,
				 sourceDigest: new Uint8Array(32).fill(171)}]}]};
			expect(() => prepare(swapped, [1])).toThrow("external source dependency is absent");
		}
	});
});
