import { readFileSync } from "node:fs";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { issuanceRetirementImage, reconstructIssuanceRetirementSourceRows, type IssuanceRetirementRows,
	type DurableIssuanceRetirementControl } from "../../issuance-store/src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// fix/maintenance-image-capacity (i) and the capture-journal detach: golden bytes for the closed-retirement
// install source (sourceProofDigest, decisionDigest) and the resume basis (summary resumeBasisDigest). These are
// persisted (coordinator and native retirement controls, drain plans) and re-derived on resume, so they must not
// change. The pins below were taken at 0aa72ee5 (before (i)) and hold unchanged at every later commit; a mid-drain
// journal's in-memory drainSource never enters them. Runs the owner's original source/label prefix with controlled
// authenticated facts; this checks identity bytes, it does not mint protocol authentication.
const raw = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("owner.ts", raw, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (!found) throw new Error(`missing source owner ${name}`);
	return found.getText(tree);
}
const whole = declaration("installClosedRetirementSource");
const prefix = whole.slice(whole.indexOf("const census = record(source.census)"), whole.indexOf("const firstCoordinator = await acquireCoordinator()"));
const helpers = ["closedRetirementBytes", "closedRetirementDigest", "closedRetirementEqual", "closedSigningDataImage", "closedSigningDataRows",
	"closedSigningSummaryResidualRows", "closedRetirementSourceCarrierFields", "closedRetirementDecisionCarrierFields"].map(declaration).join("\n");
const bindings = {encodeCanonical, decodeCanonical, hashDomain, compareBytes, issuanceRetirementImage, reconstructIssuanceRetirementSourceRows,
	CLOSED_RETIREMENT_BYTES: {maxBytes: 786_432, maxItems: 65_536, maxDepth: 128},
	requireLaw: (ok: boolean, reason: string) => {if (!ok) throw new Error(reason);}};
const js = ts.transpileModule(`${helpers}\nasync function read(source,cut) {const {input,summary,accounting}=source;
	const record=decodeCanonical; ${prefix} return {labels, resumeBasisDigest: summarySource?.resumeBasisDigest};}`, {
	compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
const read = new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings; ${js}; return read;`)(bindings) as
	(source: unknown, cut: {epoch: number}) => Promise<{labels: {throughEpoch: number; decisionDigest: string; sourceProofDigest: string};
		resumeBasisDigest?: string}>;

const scope = {objectId: "golden-room", author: "writer"};
const anchor = {objectId: scope.objectId, epoch: 1, anchorDigest: "a".repeat(64)};
const commits = Array.from({length: 3}, (_, sequence) => d109bCommit(scope, sequence, sequence));
const rows: IssuanceRetirementRows = {lineages: [{...scope, next: 3, exhausted: false, prunedThroughAuthorSequence: 0}],
	issued: commits.slice(1).map(commit => ({...scope, authorSequence: commit.authorSequence, ...commit.envelope})),
	outbox: commits.slice(1).map(commit => ({...scope, authorSequence: commit.authorSequence, digest: commit.envelope.digest,
		publishState: "published"})), plans: []};
const control: DurableIssuanceRetirementControl = {kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
	incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null};
// A closed scope header and one local row, as native canonical frames (the hash input is their exact bytes).
const header = encodeCanonical(["scopes", [anchor.objectId, anchor.epoch, anchor.anchorDigest],
	{object_id: anchor.objectId, epoch: anchor.epoch, anchor_digest: anchor.anchorDigest, next_journal_sequence: 1}]);
const entry = encodeCanonical(["accepted_entries", [anchor.objectId, anchor.epoch, anchor.anchorDigest, 0],
	{journal_sequence: 0, vertex_digest: "b".repeat(64), local_author: scope.author, local_author_sequence: 0}]);
const journal = {control: null, exactCanonicalControlCarriers: [], image: {imageDigest: "1".repeat(64), scopeCount: 1, rowCount: 1,
	byteCharge: header.byteLength + entry.byteLength}, canonicalRows: [header, entry]};
// What a mid-drain read carries beside those fields: the adapter's reconstruction of the pre-drain journal.
const drainSource = {control: {revision: 2}, image: {imageDigest: "2".repeat(64)}, canonicalRows: [header, entry, Uint8Array.of(9, 9)]};
const prefixes = [{scope: anchor, highWatermark: 1, rows: [{journalSequence: 0, vertexDigest: "b".repeat(64), author: scope.author,
	authorSequence: 0, nativeFrameDigest: "3".repeat(64)}]}];

function source(mode: "install" | "resume", withDrainSource: boolean) {
	const view = withDrainSource ? {...journal, drainSource} : journal;
	return {input: {objectId: scope.objectId}, summary: {cuts: [], floor: {epoch: 3}}, accounting: {charge: () => true},
		census: encodeCanonical({nativeIssuance: {rows, image: issuanceRetirementImage(rows, scope.objectId), control}}),
		aheControl: null, signingRows: [], floor: {stable: {epoch: 3}}, rows: [], snapshots: [], snapshotImage: {image: {imageDigest: "4".repeat(64)}},
		journal: view, journalPhysical: view, journalReconstructed: false,
		journalDetails: {collectiblePrefixes: mode === "install" ? prefixes : []}, signingDetails: [],
		...(mode === "resume" ? {signingSummaries: {entries: [], sourceDataDigest: "5".repeat(64), eligibilityFence: {epoch: 2}}} : {}),
		acquireIssuance: {readPlanBefore: () => Promise.resolve(null)}};
}

const GOLDEN = {
	install: {sourceProofDigest: "500b80c41937a10340b568507d95afa4c2d0a58114834cb7d34c974e8832d4a3",
		decisionDigest: "c3921c4c2dbf25a8a41f5f11232e88bd2bf0312172b79006e774fcee18867837"},
	resume: {sourceProofDigest: "446b50865df65cd51af1b73f2a7cae55c77726b22b0b2ffa4f3cd05749f0e201",
		decisionDigest: "8784288f19b5358878c60a782c1997f95f2517683d9a970e20965e748be3fd26",
		resumeBasisDigest: "bbbe7c79a4c1f391c43e34f3ce7b2ee7447215948fb01f8fbaf429a52a930783"},
};

describe("closed retirement identity bytes (golden)", () => {
	it("install source digest is unchanged, with or without a mid-drain drainSource on the journal", async () => {
		for (const withDrainSource of [false, true]) {
			const {labels, resumeBasisDigest} = await read(source("install", withDrainSource), {epoch: 3});
			expect(resumeBasisDigest).toBeUndefined();
			expect({sourceProofDigest: labels.sourceProofDigest, decisionDigest: labels.decisionDigest}, `drainSource ${withDrainSource}`)
				.toEqual(GOLDEN.install);
		}
	});
	it("resume basis digest is unchanged, with or without a mid-drain drainSource on the journal", async () => {
		for (const withDrainSource of [false, true]) {
			const {labels, resumeBasisDigest} = await read(source("resume", withDrainSource), {epoch: 3});
			expect({sourceProofDigest: labels.sourceProofDigest, decisionDigest: labels.decisionDigest, resumeBasisDigest},
				`drainSource ${withDrainSource}`).toEqual(GOLDEN.resume);
		}
	});
});
