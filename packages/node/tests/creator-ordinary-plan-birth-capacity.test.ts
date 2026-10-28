import {readFileSync} from "node:fs";
import {decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {canonicalValueResourceForSizing} from "@ts-drp/canonical/resource";
import {issuanceOrdinaryFinishingCapacityWidths, issuanceOrdinarySuccessorPlanResourceForSizing,
	issuanceUnsignedSuccessorFenceWidths} from "../../issuance-store/src/retirement.js";
import type {IssuanceRetirementRows} from "../../issuance-store/src/retirement.js";
import type {SettlementPlan} from "../../issuance-store/src/types.js";
import {settlementSourceContextsForEntries} from "../../issuance-store/src/contract.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Resource/constructor controls, not native custody, authorization or a proof.
// Invoke the ORIGINAL unchanged room merge body for sources=[] as the oracle.
const roomSource = readFileSync(new URL("../src/v3-room.ts", import.meta.url), "utf8");
const roomTree = ts.createSourceFile("v3-room.ts", roomSource, ts.ScriptTarget.Latest, true);
let mergeDeclaration: ts.VariableDeclaration | undefined;
function find(node: ts.Node): void {
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "mergedSettlementPlan") {
		if (mergeDeclaration !== undefined) throw new Error("ambiguous original room merge");
		mergeDeclaration = node;
	}
	ts.forEachChild(node, find);
}
find(roomTree);
if (mergeDeclaration?.initializer === undefined) throw new Error("missing original room merge");
// 34b08cd7: the merge carries each retained entry's exact source contexts
// through the genuine settlementSourceContextsForEntries.
const originalMerge = new Function("settlementScope", "sameSettlementEntry", "settlementSourceContextsForEntries", ts.transpileModule(
	`const mergedSettlementPlan = ${mergeDeclaration.initializer.getText(roomTree)};\nreturn mergedSettlementPlan;`,
	{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText);
const scope = Object.freeze({objectId: "room", author: "a".repeat(64)});
const limits = {maxBytes: 4_194_304, maxItems: 131_072, maxDepth: 128};
const equal = (left: unknown, right: unknown) => Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
function successor(prior: SettlementPlan | null, priorFenceEpoch: number | undefined, epoch: number): SettlementPlan {
	return originalMerge(scope, equal, settlementSourceContextsForEntries)([], prior)(priorFenceEpoch, epoch);
}
function rows(plan?: SettlementPlan): IssuanceRetirementRows {
	return {lineages: [{...scope, next: 0, exhausted: false, prunedThroughAuthorSequence: null}],
		issued: [], outbox: [], plans: plan === undefined ? [] : [plan]};
}
function dominates(bound: {byteLength: number; items: number; maxDepth: number}, value: unknown): void {
	const actual = canonicalValueResourceForSizing(value, 128, limits, "exact");
	expect(bound.byteLength).toBeGreaterThanOrEqual(actual.byteLength);
	expect(bound.items).toBe(actual.items);
	expect(bound.maxDepth).toBe(actual.maxDepth);
}

describe("original issuer candidate-free plan-birth resource projection", () => {
	it("bounds original null-plan birth and fence effect without installing a plan or fabricating a candidate", () => {
		const before = rows(), encoded = encodeCanonical(before);
		const plan = successor(null, undefined, 1);
		expect(plan).toEqual({scope, entries: [], revision: 0, fenceSequence: null});
		const resource = issuanceOrdinarySuccessorPlanResourceForSizing(scope, null);
		dominates(resource, {...plan, revision: Number.MAX_SAFE_INTEGER, fenceSequence: Number.MAX_SAFE_INTEGER});
		expect(Object.keys(resource).sort()).toEqual(["byteLength", "items", "maxDepth"]);
		const bound = issuanceOrdinaryFinishingCapacityWidths({rows: before, scope, control: null,
			maxAdditionalCurrentIssued: 0, maxCanonicalPreimageByteLength: 512, successorFenceCount: 1});
		const oracle = issuanceUnsignedSuccessorFenceWidths(before, scope, undefined, null,
			{plan, canonicalPreimageByteLength: 512});
		for (const phase of ["reserved", "entered", "final"] as const) {
			const projected = phase === "final" ? bound.successorFinal : bound.successorPending;
			expect(projected.canonicalRowsBytes).toBeGreaterThanOrEqual(oracle[phase].canonicalRowsBytes);
			expect(projected.nativeCensusBytes).toBeGreaterThanOrEqual(oracle[phase].nativeCensusBytes);
		}
		expect(encodeCanonical(before)).toEqual(encoded); expect(before.plans).toEqual([]);
	});
	it("preserves complete original entries, scope and fence-reset law at wide counter boundaries", () => {
		for (const revision of [0, 127, 128, Number.MAX_SAFE_INTEGER - 2]) {
			const prior: SettlementPlan = {scope, revision, fenceSequence: 127, entries: [{sourceSequence: 0,
				sourceObjectId: "source-room", sourceDigest: new Uint8Array(32).fill(9), disposition: "rebase", replacementSequence: 128}]};
			const bytes = encodeCanonical(prior), merged = successor(prior, 0, 1);
			expect(merged.revision).toBe(revision + 1); expect(merged.fenceSequence).toBeNull();
			expect(merged.entries).toEqual(prior.entries);
			const resource = issuanceOrdinarySuccessorPlanResourceForSizing(scope, prior);
			dominates(resource, {...merged, revision: Number.MAX_SAFE_INTEGER, fenceSequence: Number.MAX_SAFE_INTEGER});
			const input = rows(prior), bound = issuanceOrdinaryFinishingCapacityWidths({rows: input, scope, control: null,
				maxAdditionalCurrentIssued: 0, maxCanonicalPreimageByteLength: 8334, successorFenceCount: 1});
			const oracle = issuanceUnsignedSuccessorFenceWidths(input, scope, undefined, null,
				{plan: merged, canonicalPreimageByteLength: 8334});
			expect(bound.successorPending.nativeCensusBytes).toBeGreaterThanOrEqual(oracle.entered.nativeCensusBytes);
			expect(bound.successorFinal.nativeCensusBytes).toBeGreaterThanOrEqual(oracle.final.nativeCensusBytes);
			expect(encodeCanonical(prior)).toEqual(bytes);
		}
	});
	it("returns detached scalar geometry; mutations of the original prior plan cannot mutate a prepared result", () => {
		const prior = {scope: {...scope}, revision: 0, fenceSequence: null,
			entries: [{sourceSequence: 0, sourceDigest: new Uint8Array(32), disposition: "expire" as const, replacementSequence: null}]};
		const bound = issuanceOrdinarySuccessorPlanResourceForSizing(scope, prior), copy = {...bound};
		prior.entries[0]!.sourceDigest.fill(3); prior.scope.author = "b".repeat(64); prior.entries.length = 0;
		expect(bound).toEqual(copy); expect(Object.isFrozen(bound)).toBe(true);
	});
	it("preserves malformed-scope/plan and exhausted-revision refusal, and does not relax NONE plan exclusion", () => {
		for (const prior of [{scope, entries: [], revision: Number.MAX_SAFE_INTEGER, fenceSequence: null},
			{scope: {...scope, author: "b".repeat(64)}, entries: [], revision: 0, fenceSequence: null},
			{scope, entries: [], revision: 0, fenceSequence: null, extra: true}]) {
			expect(() => issuanceOrdinarySuccessorPlanResourceForSizing(scope, prior as SettlementPlan)).toThrow();
		}
		const plan = successor(null, undefined, 1);
		expect(() => issuanceOrdinaryFinishingCapacityWidths({rows: rows(plan), scope, control: null,
			maxAdditionalCurrentIssued: 0, maxCanonicalPreimageByteLength: 512, successorFenceCount: 0})).toThrow();
		expect((decodeCanonical(encodeCanonical(rows())) as {plans: unknown[]}).plans).toEqual([]);
	});
	it("dominates the original first reserve plus successor fence with absent or existing original lineage", () => {
		const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId, author: scope.author,
			authorSequence: 0, epoch: 0, anchor: "0".repeat(64), logicalTime: 1, dependencies: ["0".repeat(64)],
			operation: {action: "installRoster", roster: {members: []}}});
		const intent = {kind: "v3-issuance-pending-unsigned-1" as const, authorSequence: 0,
			canonicalPreimageBytes: preimage, digest: hashDomain("ts-drp/vertex/v3", preimage)};
		for (const present of [false, true]) {
			const before = present ? rows() : {...rows(), lineages: []}, encoded = encodeCanonical(before);
			const bound = issuanceOrdinaryFinishingCapacityWidths({rows: before, scope, control: null,
				maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: preimage.byteLength, successorFenceCount: 1});
			const oracle = issuanceUnsignedSuccessorFenceWidths(before, scope, intent, null,
				{plan: successor(null, undefined, 1), canonicalPreimageByteLength: preimage.byteLength});
			for (const phase of ["reserved", "entered", "final"] as const) {
				const projected = phase === "final" ? bound.successorFinal : bound.successorPending;
				expect(projected.canonicalRowsBytes).toBeGreaterThanOrEqual(oracle[phase].canonicalRowsBytes);
				expect(projected.nativeCensusBytes).toBeGreaterThanOrEqual(oracle[phase].nativeCensusBytes);
			}
			expect(encodeCanonical(before)).toEqual(encoded);
		}
	});
});
