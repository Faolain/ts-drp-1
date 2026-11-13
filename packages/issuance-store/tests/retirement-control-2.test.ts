import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import {
	captureIssuanceRetirementControl,
	closeIssuanceRetirementProtectedRecords,
	decodeIssuanceRetirementControl,
	encodeIssuanceRetirementControl,
	issuanceRetirementAllows,
	issuanceRetirementControlKind,
	issuanceRetirementPlanRewriteResourceForSizing,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementTransitionPlanBefore,
	issuanceRetirementTransitionRows,
	reconstructIssuanceRetirementSourceRows,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementPreparation,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Control-2 (fix/maintenance-image-capacity; model packages/node/formal/issuance-image-capacity.qnt):
// rule A names a retirement's plan images by digest and moves the BEFORE images to one native side row
// at commit; rule H protects rows above an epoch floor without one hole record per row. Legacy
// (control-1) controls keep their exact bytes and semantics until this code prepares under them.

const scope = {objectId: "retirement-room", author: "writer"};
const control: DurableIssuanceRetirementControl = {kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
	incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null};
const labels = {decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 3};
function fixture(): IssuanceRetirementRows {
	// Five published own moves, one per epoch 0..4, and a plan whose entries 0..2 were rebased onto 1..3.
	const commits = Array.from({length: 5}, (_, sequence) => d109bCommit(scope, sequence, sequence));
	return {lineages: [{...scope, next: 5, exhausted: false, prunedThroughAuthorSequence: null}],
		issued: commits.map(commit => ({...scope, authorSequence: commit.authorSequence, ...commit.envelope})),
		outbox: commits.map(commit => ({...scope, authorSequence: commit.authorSequence,
			digest: commit.envelope.digest, publishState: "published"})),
		plans: [{scope, revision: 7, fenceSequence: 4, entries: [0, 1, 2].map(sequence => ({
			sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			disposition: "rebase", replacementSequence: sequence + 1}))}]};
}
/** The authenticated prefix pruner's effect: rows through `through` are gone. */
function pruneThrough(rows: IssuanceRetirementRows, through: number): IssuanceRetirementRows {
	return {...rows, lineages: rows.lineages.map(lineage => ({...lineage, prunedThroughAuthorSequence: through})),
		issued: rows.issued.filter(row => row.authorSequence > through),
		outbox: rows.outbox.filter(row => row.authorSequence > through)};
}
function prepare(rows: IssuanceRetirementRows, floorEpoch: number | undefined,
	base: DurableIssuanceRetirementControl = control): DurableIssuanceRetirementPreparation {
	const protectedRecords = closeIssuanceRetirementProtectedRecords({control: base, rows, throughEpoch: labels.throughEpoch,
		...(floorEpoch === undefined ? {} : {floorEpoch}), protectedRecords: []});
	return issuanceRetirementPreparationWithPlanRewrite(base,
		{...labels, ...(floorEpoch === undefined ? {} : {floorEpoch}), protectedRecords}, rows);
}
function commitOf(rows: IssuanceRetirementRows, p: DurableIssuanceRetirementPreparation,
	base: DurableIssuanceRetirementControl = control) {
	const prepared = decodeIssuanceRetirementControl(encodeIssuanceRetirementControl({...base,
		revision: base.revision + 1, sequence: base.sequence + 1, active: {sequence: base.sequence + 1, preparation: p}}));
	const completed = decodeIssuanceRetirementControl(encodeIssuanceRetirementControl({...prepared,
		revision: prepared.revision + 1, active: null, completed: p}));
	return {prepared, completed, target: issuanceRetirementTransitionRows(prepared, completed, rows),
		planBefore: issuanceRetirementTransitionPlanBefore(prepared, completed, rows)};
}

describe("issuance retirement control-2", () => {
	it("rule A: names the rewritten plans by digest and reconstructs the source from the commit's side row", () => {
		const rows = pruneThrough(decodeCanonical(encodeCanonical(fixture())) as IssuanceRetirementRows, 1);
		const p = prepare(rows, 1);
		expect(p.planRewrite?.kind).toBe("v3-issuance-retirement-plan-rewrite-2");
		const {prepared, completed, target, planBefore} = commitOf(rows, p);
		expect(prepared.kind).toBe("v3-issuance-retirement-control-2");
		expect(completed.kind).toBe("v3-issuance-retirement-control-2");
		// The control carries no plan image: its encoding is far below one plan's.
		expect(encodeIssuanceRetirementControl(completed).byteLength).toBeLessThan(encodeCanonical(rows.plans[0]).byteLength + 600);
		expect(target.plans[0]!.entries.map(entry => entry.sourceSequence)).toEqual([2]);
		expect(planBefore).toBeInstanceOf(Uint8Array);
		expect(reconstructIssuanceRetirementSourceRows(completed, p, target, planBefore!)).toEqual(rows);
		// The side row is required, and only this decision's opens.
		expect(() => reconstructIssuanceRetirementSourceRows(completed, p, target)).toThrow("plan before is unavailable");
		const other = {...p, decisionDigest: "d".repeat(64)};
		expect(() => reconstructIssuanceRetirementSourceRows(completed, other, target, planBefore!)).toThrow("stale");
	});

	it("rule A: a commit without a digest rewrite deletes the side row; a metadata transition keeps it", () => {
		const rows = decodeCanonical(encodeCanonical(fixture())) as IssuanceRetirementRows;
		const p = prepare(rows, 1);
		expect(p.planRewrite).toBeUndefined();
		const {prepared, completed} = commitOf(rows, p);
		expect(issuanceRetirementTransitionPlanBefore(prepared, completed, rows)).toBeNull();
		expect(issuanceRetirementTransitionPlanBefore(completed, {...completed, revision: completed.revision + 1}, rows)).toBeUndefined();
	});

	it("rule H: rows above the floor are kept without a listed record; rows at or below it retire unless listed", () => {
		const rows = decodeCanonical(encodeCanonical(fixture())) as IssuanceRetirementRows;
		const hole = {author: scope.author, authorSequence: 1, digest: Buffer.from(rows.issued[1]!.digest).toString("hex")};
		const prepareWith = (floorEpoch: number | undefined, seeds: typeof hole[]) => {
			const protectedRecords = closeIssuanceRetirementProtectedRecords({control, rows, throughEpoch: labels.throughEpoch,
				...(floorEpoch === undefined ? {} : {floorEpoch}), protectedRecords: seeds});
			return issuanceRetirementPreparationWithPlanRewrite(control,
				{...labels, ...(floorEpoch === undefined ? {} : {floorEpoch}), protectedRecords}, rows);
		};
		const allowed = (p: DurableIssuanceRetirementPreparation) => {
			const {completed} = commitOf(rows, p);
			return rows.issued.filter(row => issuanceRetirementAllows(completed, row, row.authorSequence,
				row.canonicalPreimageBytes, row.digest)).map(row => row.authorSequence);
		};
		// No exceptions: floor 1 keeps epochs 2..4 implicitly; the legacy form (floor = cut 3) keeps only 4.
		expect(allowed(prepareWith(1, []))).toEqual([2, 3, 4]);
		expect(allowed(prepareWith(undefined, []))).toEqual([4]);
		// Keeping sequence 1 closes over its replacement chain 1 -> 2 -> 3: the floored form lists only
		// the record at or below its floor, the legacy form lists all three.
		const floored = prepareWith(1, [hole]), legacy = prepareWith(undefined, [hole]);
		expect(floored.protectedRecords.map(value => value.authorSequence)).toEqual([1]);
		expect(legacy.protectedRecords.map(value => value.authorSequence)).toEqual([1, 2, 3]);
		expect(allowed(floored)).toEqual([1, 2, 3, 4]);
		expect(allowed(legacy)).toEqual([1, 2, 3, 4]);
	});

	it("keeps legacy controls as control-1 and refuses a floored preparation under the legacy kind", () => {
		const rows = pruneThrough(decodeCanonical(encodeCanonical(fixture())) as IssuanceRetirementRows, 1);
		const legacy = prepare(rows, undefined);
		expect(legacy.planRewrite?.kind).toBe("v3-issuance-retirement-plan-rewrite-1");
		const {prepared, completed, planBefore} = commitOf(rows, legacy);
		expect(prepared.kind).toBe("v3-issuance-retirement-control-1");
		expect(completed.kind).toBe("v3-issuance-retirement-control-1");
		expect(planBefore).toBeNull();
		expect(issuanceRetirementControlKind(null, legacy)).toBe("v3-issuance-retirement-control-1");
		// Stored bytes must name the kind their preparations need.
		const floored = prepare(rows, 1);
		const mislabelled = encodeCanonical({...control, revision: 1, sequence: 1, active: {sequence: 1, preparation: floored}});
		expect(() => decodeIssuanceRetirementControl(mislabelled)).toThrow();
	});

	it("never lowers the floor below the completed preparation's", () => {
		const rows = decodeCanonical(encodeCanonical(fixture())) as IssuanceRetirementRows;
		const {completed} = commitOf(rows, prepare(rows, 1));
		const lower = {...prepare(rows, 0, completed)};
		expect(() => captureIssuanceRetirementControl({...completed, sequence: completed.sequence + 1,
			active: {sequence: completed.sequence + 1, preparation: lower}})).toThrow();
		// A legacy completed preparation's floor is its cut: the first floored one may not go below it.
		const {completed: legacyCompleted} = commitOf(rows, prepare(rows, undefined));
		expect(() => captureIssuanceRetirementControl({...legacyCompleted, sequence: legacyCompleted.sequence + 1,
			active: {sequence: legacyCompleted.sequence + 1, preparation: {...prepare(rows, 2, legacyCompleted)}}})).toThrow();
		expect(captureIssuanceRetirementControl({...legacyCompleted, sequence: legacyCompleted.sequence + 1,
			active: {sequence: legacyCompleted.sequence + 1, preparation: {...prepare(rows, 3, legacyCompleted)}}}).kind)
			.toBe("v3-issuance-retirement-control-2");
	});

	it("sizes the digest rewrite independently of the plan's bytes", () => {
		const rows = fixture();
		const big = issuanceRetirementPlanRewriteResourceForSizing(rows.plans)!;
		const small = issuanceRetirementPlanRewriteResourceForSizing([{...rows.plans[0]!, entries: rows.plans[0]!.entries.slice(0, 1)}])!;
		expect(big.byteLength).toBe(small.byteLength);
		expect(small.byteLength).toBeLessThan(512);
	});
});
