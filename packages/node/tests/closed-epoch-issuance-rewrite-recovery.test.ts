import { readFileSync } from "node:fs";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { issuanceRetirementImage, issuanceRetirementPreparationWithPlanRewrite, issuanceRetirementCommitRows,
	reconstructIssuanceRetirementSourceRows, type IssuanceRetirementRows, type DurableIssuanceRetirementControl } from "../../issuance-store/src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Execute the original source/label selection prefix with controlled authenticated
// facts. This verifies recovery identity; it does not mint protocol authentication.
const raw = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("owner.ts", raw, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (!found) throw new Error(`missing source owner ${name}`);
	return found.getText(tree);
}
const whole = declaration("installClosedRetirementSource");
const prefix = whole.slice(whole.indexOf("const census = record(source.census)"), whole.indexOf("const firstCoordinator = await acquireCoordinator()"));
const helpers = ["closedRetirementBytes", "closedRetirementDigest", "closedSigningDataImage", "closedSigningDataRows",
	"closedRetirementSourceCarrierFields", "closedRetirementDecisionCarrierFields"].map(declaration).join("\n");
const bindings = {encodeCanonical, decodeCanonical, hashDomain, compareBytes, issuanceRetirementImage,
	reconstructIssuanceRetirementSourceRows, CLOSED_RETIREMENT_BYTES: {maxBytes: 4194304, maxItems: 65536, maxDepth: 128},
	requireLaw: (ok: boolean, reason: string) => {if (!ok) throw new Error(reason);}};
const js = ts.transpileModule(`${helpers}\nfunction read(source,cut) {const {input,summary,accounting}=source;
	const record=decodeCanonical; ${prefix} return {labels, issuanceImage, completedRewrite};}`, {
	compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
const read = new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings; ${js}; return read;`)(bindings) as
	(source: any, cut: {epoch: number}) => {labels: {throughEpoch: number; decisionDigest: string; sourceProofDigest: string};
		issuanceImage: {imageDigest: string}; completedRewrite: unknown};

function fixture() {
	const scope = {objectId: "retirement-room", author: "writer"};
	const commits = Array.from({length: 5}, (_, sequence) => d109bCommit(scope, sequence, sequence));
	// Rows 0 and 1 are already pruned: their completed entries are the rewrite's drops. A completed
	// entry whose source the store still holds is custody and stays (578ad4ef), so a fixture whose
	// sources are all held has no plan rewrite to recover.
	const held = commits.filter(commit => commit.authorSequence > 1);
	const rows: IssuanceRetirementRows = {lineages: [{...scope, next: 5, exhausted: false, prunedThroughAuthorSequence: 1}],
		issued: held.map(commit => ({...scope, authorSequence: commit.authorSequence, ...commit.envelope})),
		outbox: held.map(commit => ({...scope, authorSequence: commit.authorSequence, digest: commit.envelope.digest, publishState: "published"})),
		plans: [{scope, revision: 7, fenceSequence: 4, entries: [0, 1, 2].map(sequence => ({sourceSequence: sequence,
			sourceDigest: commits[sequence]!.envelope.digest, disposition: "rebase", replacementSequence: sequence + 1}))}]};
	const control: DurableIssuanceRetirementControl = {kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
		incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null};
	const census = (value: IssuanceRetirementRows, current: DurableIssuanceRetirementControl | null) =>
		encodeCanonical({nativeIssuance: {rows: value, image: issuanceRetirementImage(value, scope.objectId), control: current}});
	const journal = {image: {imageDigest: "1".repeat(64)}, canonicalRows: [], control: null};
	const source = {input: {objectId: scope.objectId}, summary: {}, accounting: {charge: () => true},
		census: census(rows, control), aheControl: null, signingRows: [], floor: {}, rows: [], snapshots: [], snapshotImage: {image: {}},
		journal, journalDetails: {collectiblePrefixes: []}, signingDetails: [],
		// An unreconstructed source observes the physical journal as its journal (8ab3c8cb).
		journalPhysical: journal, journalReconstructed: false};
	const cut = {epoch: 3}, labels = read(source, cut).labels;
	const p = issuanceRetirementPreparationWithPlanRewrite(control, {...labels, protectedRecords: []}, rows);
	if (p.planRewrite === undefined) throw new Error("fixture must exercise a plan rewrite");
	const target = issuanceRetirementCommitRows(control, p, rows), completed = {...control, revision: 2, sequence: 1, completed: p};
	const retry = {...source, census: census(target, completed), aheControl: {active: null, completed: labels}};
	return {source, retry, target, completed, census, labels, p, cut};
}

describe("issuance rewrite source recovery", () => {
	it("reconstructs the exact old source only for a matching whole-source retry", () => {
		const f = fixture();
		// The rewrite drops the pruned sources' completed entries and keeps the held one (custody).
		expect(f.target.plans[0]!.entries.map(entry => entry.sourceSequence)).toEqual([2]);
		expect(f.p.planRewrite!.sourceImageDigest).not.toBe(f.p.planRewrite!.targetImageDigest);
		expect(read(f.retry, f.cut)).toMatchObject({labels: f.labels, completedRewrite: f.p,
			issuanceImage: {imageDigest: f.p.planRewrite!.sourceImageDigest}});
		expect(read({...f.retry, aheControl: {active: {preparation: f.labels}, completed: null}}, f.cut).labels).toEqual(f.labels);
	});
	it("uses fresh native rows after global completion when another owner's source changes", () => {
		const f = fixture();
		for (const change of [{journal: {...f.retry.journal, image: {imageDigest: "2".repeat(64)}}},
			{snapshotImage: {image: {changed: true}}}, {floor: {changed: true}}]) {
			const fresh = {...f.retry, ...change}, result = read(fresh, f.cut);
			expect(result.completedRewrite).toBeUndefined();
			expect(result.issuanceImage.imageDigest).toBe(f.p.planRewrite!.targetImageDigest);
			expect(result.labels).toEqual(read({...fresh, aheControl: null}, f.cut).labels);
			expect(result.labels).not.toEqual(f.labels);
		}
	});
	it("refuses source or target drift while the global intent remains active", () => {
		const f = fixture(), active = {...f.retry, aheControl: {active: {preparation: f.labels}, completed: null}};
		expect(() => read({...active, journal: {...active.journal, image: {imageDigest: "2".repeat(64)}}}, f.cut)).toThrow("floor-stale");
		const changed = {...f.target, plans: [{...f.target.plans[0]!, revision: f.target.plans[0]!.revision + 1}]};
		expect(() => read({...active, census: f.census(changed, f.completed)}, f.cut)).toThrow("floor-stale");
	});
});
