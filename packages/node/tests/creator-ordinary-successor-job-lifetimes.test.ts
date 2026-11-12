import {readFileSync} from "node:fs";
import {compareBytes, encodeCanonical} from "@ts-drp/canonical";
import {canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing, canonicalRecordResourceForSizing,
	canonicalArrayResourceForSizing, canonicalArrayResourcesForSizing, canonicalValueResourceForSizing} from "@ts-drp/canonical/resource";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";
import { compileClosedJournalObservationOwner } from "./helpers/closed-journal-observation-owner.js";

// Actual scalar/program expressions against the UNCHANGED original composer
// literal and codec. These controls prove numerical lifetime composition, not
// authenticated source selection, native currency or a fabricated proof grant.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (!found) throw new Error(`missing owner ${name}`); return found.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128};
const initializers = new Map<string, string>(); let originalJob: string | undefined, observationLimits: string | undefined;
function visit(node: ts.Node): void {
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
		["successorObservations", "successorJobs", "successorJobTerms", "envelopes", "roots"].includes(node.name.text)) {
		if (["successorObservations", "successorJobs", "successorJobTerms"].includes(node.name.text) ||
			node.initializer.getText(tree).includes("currentTurnover")) initializers.set(node.name.text, node.initializer.getText(tree));
	}
	if (ts.isCallExpression(node) && node.expression.getText(tree) === "maintenanceWidthSum" && node.arguments.length === 2 &&
		node.arguments[1]!.getText(tree).startsWith("`successor-job-${index}")) {
		if (!ts.isArrayLiteralExpression(node.arguments[0]!)) throw new Error("independent original job literal changed");
		originalJob = node.arguments[0]!.getText(tree);
	}
	if (ts.isExpressionStatement(node) && node.getText(tree).startsWith("successorObservations.forEach")) observationLimits = node.getText(tree);
	ts.forEachChild(node, visit);
} visit(tree);
if (!originalJob || !observationLimits || initializers.size !== 5) throw new Error("original lifetime seams unavailable");
const bindings = {CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes, CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720,
	canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing, canonicalRecordResourceForSizing,
	canonicalArrayResourceForSizing, canonicalArrayResourcesForSizing, compareBytes,
	closedRetirementEqual: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
	// The owner's journal observation projection (C1).
	closedJournalObservationControl: compileClosedJournalObservationOwner().closedJournalObservationControl};
const original = execute<{compiler(): any; evaluate(program: any, parameters: Map<string, number>): Map<string, number> | undefined;
	book(): any; parts(input: any): number[]; observations(input: any): any[]; exact(input: any): number}>(`
	${["maintenanceWidthSum", "maintenanceVarUintWidth", "creatorCanonicalCapacityForSizing", "createCreatorNoneResourceProgramCompiler",
		"evaluateCreatorNoneResourceProgramForSizing", "createCreatorClosedRollbackProofAccounting", "creatorSuccessorJobProofEnvelopePartsForSizing",
		"creatorIssuanceMaintenanceObservationCarriers"].map(declaration).join("\n")}
	return {compiler:createCreatorNoneResourceProgramCompiler,evaluate:evaluateCreatorNoneResourceProgramForSizing,
	 book:()=>createCreatorClosedRollbackProofAccounting([]),parts:creatorSuccessorJobProofEnvelopePartsForSizing,
	 observations:creatorIssuanceMaintenanceObservationCarriers,exact:input=>{
	 const {base:fullFutureBase,unsignedPreimage, census:phaseCensusWidth,observations,signingData,finalSigning:finalSigningWidth,
	 signingControl:signingControlFrame,aheControl:aheControlFrame}=input;
	 const phase={canonicalUnsignedVertexByteLength:unsignedPreimage};return maintenanceWidthSum(${originalJob});}};`,
	{...bindings, proofMaterialOwners: new WeakMap()});
const sum = (...parts: number[]) => parts.reduce((a, b) => a + b, 0);
const resource = (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact");
const scalar = execute<(f: any) => number[]>(`
	${declaration("creatorSuccessorJobProofEnvelopePartsForSizing")}
	return f=>{const {base,fencePreimage,runtimeEnvelopeTerms,successorObservations,signingData,signing,signingControlFrame,aheFrame,
	 physical,currentTurnover,generationTransitions,floorImage,aheControl,metadataEpisode,generationMetadataEpisode,drain,headerOnlyDrain,generationSource,futureInventory,newFact}=f;
	 // This fixture gives every lifetime the same full base/physical corpus;
	 // production now names those source-owned projections explicitly.
	 const lifetimeBase=()=>base,rawSourcePhysical=physical;
	 const current={successorFenceCount:f.fenceCount};const successorJobs=${initializers.get("successorJobs")};
	 return ${initializers.get("envelopes")};};`, {sum});
function fixture(epoch = 0, preimage = 512, rows = 1, fenceCount: 0 | 1 = 1) {
	const old = encodeCanonical({fullPRE: new Uint8Array(8334).fill(7), signature: new Uint8Array(64).fill(3)});
	const book = original.book(); expect(book.charge(old)).toBe(true);
	expect(book.chargeUnknownEncodedLength(127)).toBe(true); expect(book.chargeUnknownEncodedLength(127)).toBe(true);
	const scope = {objectId: "room", epoch, anchorDigest: "a".repeat(64)}, max = Number.MAX_SAFE_INTEGER;
	const journalRows = Array.from({length: rows}, (_, i) => encodeCanonical({scope, sequence: i,
		PRE: i === 0 ? old : encodeCanonical({action: "placeBlock", x: i})}));
	const journal = {control: {kind: "journal", revision: max, completed: {rows}}, image: {scopeCount: 3, rowCount: rows},
		canonicalRows: journalRows, drainSource: {control: {revision: max}, canonicalRows: journalRows}};
	const snapshot = {control: {revision: max, active: null}, image: {scopeCount: 4, scopes: [scope]}};
	const ahe = {control: {revision: max, completed: {epoch}}, head: {revision: max}, imageDigest: "b".repeat(64), metadataBytes: max};
	const floor = {stable: {objectId: "room", epoch, currentAnchorDigest: scope.anchorDigest}, pending: null};
	const floorImage = {scope: {objectId: "room"}, state: floor, control: {revision: max}, imageDigest: "c".repeat(64), metadataBytes: max};
	const inventory = {scopes: Array.from({length: 4}, () => ({scope, contentBytes: 127, retirement: {protectedScopes: [scope]}})), owner: {recoveryScopes: 4}};
	const observationValues = original.observations({journal, snapshot, ahe, floor, floorImage, snapshotInventory: inventory});
	const native = {rows: {issued: [{PRE: new Uint8Array(preimage), signature: new Uint8Array(64)}]},
		image: {revision: max, issuedCount: max}, control: {revision: max, completed: {epoch}}};
	const census = encodeCanonical(native).byteLength, runtimeEnvelopeTerms = [31, 127, 128, 255].map(n => n + census);
	const signingData = [encodeCanonical(["sealEvidence", scope, {PRE: old}]), encodeCanonical(["voteSlots", scope, {signature: new Uint8Array(64)}])];
	const finalSigning = signingData.reduce((total, raw) => total + raw.byteLength, 0) + 128;
	return {book, fenceCount, base: book.chargedBytes + 40_000 + (fenceCount ? preimage + 64 + 32 : 0), fencePreimage: preimage,
		runtimeEnvelopeTerms, successorObservations: observationValues.map(resource), observationValues,
		signingData, signing: {finalPhaseBytes: finalSigning}, signingControlFrame: resource(["storageMeta", "signing", {revision: max}]),
		aheFrame: resource(["storageMeta", "ahe", {revision: max}]),
		physical: 2 * census + sum(...observationValues.map(value => encodeCanonical(value).byteLength)), currentTurnover: 127,
		generationTransitions: 128, floorImage: resource(floorImage), aheControl: resource(ahe.control), metadataEpisode: 16_384,
		generationMetadataEpisode: 16_000,
		drain: rows * 127, headerOnlyDrain: rows * 17, generationSource: resource({rows, generation: epoch}), futureInventory: resource(inventory), newFact: resource({epoch})};
}
const compiled = execute<(f: any, compiler: any) => {program: any; parameters: Map<string, number>}>(`
	${declaration("creatorSuccessorJobProofEnvelopePartsForSizing")}
	return(f,compiler)=>{const parameters=new Map();
	 const inputNumber=(key,value)=>{parameters.set(key,value);return compiler.inputNumber(key,value);};
	 const inputResource=(key,value)=>{for(const [field,n]of Object.entries({bytes:value.byteLength,items:value.items,depth:value.maxDepth}))parameters.set(key+"."+field,n);
	 return compiler.inputResource(key,value);};const width=value=>compiler.references(value).byteLength;
	 const current={successorFenceCount:f.fenceCount},fencePreimage=f.fencePreimage,signingData=f.signingData;
	 const baseTerm=inputNumber("base",f.base),physicalTerm=inputNumber("physical",f.physical),currentTurnoverTerm=inputNumber("turnover",f.currentTurnover),
	 generationTransitions=inputNumber("generation",f.generationTransitions),metadataTerm=inputNumber("metadata",f.metadataEpisode),
	 generationMetadataTerm=inputNumber("generationMetadata",f.generationMetadataEpisode),drainTerm=inputNumber("drain",f.drain),
	 headerOnlyDrainTerm=inputNumber("headerOnlyDrain",f.headerOnlyDrain);
	 const lifetimeBaseTerm=()=>baseTerm,rawSourcePhysicalTerm=physicalTerm;
	 const runtimeEnvelopeTerms=f.runtimeEnvelopeTerms.map((n,i)=>inputNumber("runtime."+i,n));
	 const successorObservations=f.successorObservations.map((r,i)=>inputResource("observation."+i,r));
	 const signingControlFrame=inputResource("signing.control",f.signingControlFrame),aheFrame=inputResource("ahe.frame",f.aheFrame),
	 floorImage=inputResource("floor",f.floorImage),aheControl=inputResource("ahe.control",f.aheControl),
	 generationSource=inputResource("source",f.generationSource),futureInventory=inputResource("inventory",f.futureInventory),newFact=inputResource("fact",f.newFact);
	 compiler.outputNumber("signing.finalPhaseBytes",inputNumber("signing.final",f.signing.finalPhaseBytes));
	 const successorJobTerms=${initializers.get("successorJobTerms")};${observationLimits}
	 const roots=${initializers.get("roots")};roots.forEach((root,i)=>compiler.outputNumber("envelope."+i,root));
	 return {program:compiler.finish(),parameters};};`, {sum, AHE_BOUNDED_READ_LIMITS: {maxUnionBytes: 786432},
	LIVE_JOURNAL_RETIREMENT_LIMITS: {maxImageBytes: 786432}, CLOSED_RETIREMENT_BYTES: {maxBytes: 786432, maxItems: 65_536, maxDepth: 128}});

describe("successor native jobs use distinct complete proof lifetimes", () => {
	it("matches the unchanged original formula, retaining six observations and every repeated readback within each job", () => {
		for (const epoch of [0, 3, 4]) for (const width of [127, 128, 8334]) {
			const f = fixture(epoch, width, 2);
			for (const phase of [1, 2]) {
				const input = {base: f.base, unsignedPreimage: width, census: f.runtimeEnvelopeTerms[phase],
					observations: f.observationValues.map(value => encodeCanonical(value).byteLength), signingData: f.signingData,
					finalSigning: f.signing.finalPhaseBytes, signingControl: f.signingControlFrame.byteLength, aheControl: f.aheFrame.byteLength};
				const parts = original.parts({...input, signingData: f.signingData.map(raw => raw.byteLength)});
				expect(parts).toHaveLength(3 + 6 + f.signingData.length + 6);
				expect(sum(...parts)).toBe(original.exact(input));
				expect(scalar(f)[0]).toBeGreaterThanOrEqual(original.exact(input));
			}
		}
	});
	it("keeps current book/PRE/duplicate UNKNOWN untouched and separates reservation growth from later serial/cold books", () => {
		const f = fixture(4, 8334, 3), before = f.book.chargedBytes, baseline = scalar(f);
		const reserved = {...f, runtimeEnvelopeTerms: [...f.runtimeEnvelopeTerms]}; reserved.runtimeEnvelopeTerms[1] += 800_000;
		const changed = scalar(reserved); expect(changed[0]).toBeGreaterThanOrEqual(baseline[0]);
		expect(changed.slice(1)).toEqual(baseline.slice(1)); expect(f.book.chargedBytes).toBe(before);
		expect(before).toBe(encodeCanonical({fullPRE: new Uint8Array(8334).fill(7), signature: new Uint8Array(64).fill(3)}).byteLength + 254);
		// Independent original serial/cold laws retain their full bases/material;
		// the scalar's later books still dominate those same complete carriers.
		expect(baseline[1]).toBe(f.base + f.physical + f.metadataEpisode + f.drain);
		expect(baseline[2]).toBe(f.base + f.physical + f.generationMetadataEpisode + f.generationSource.byteLength + 4 * f.aheFrame.byteLength + f.headerOnlyDrain);
		expect(baseline[3]).toBe(f.base + 2 * f.futureInventory.byteLength + f.newFact.byteLength);
	});
	it("evaluates actual compiled job/root expressions at fresh width, count and later-epoch alternatives without old scalar aliases", () => {
		const seed = fixture(3, 127, 1), {program} = compiled(seed, original.compiler());
		for (const epoch of [0, 3, 4]) for (const width of [127, 128, 8334]) for (const count of [1, 127, 128]) {
			const f = fixture(epoch, width, count), {parameters} = compiled(f, original.compiler());
			const values = original.evaluate(program, parameters); expect(values).toBeDefined();
			expect([0, 1, 2, 3].map(i => values!.get(`envelope.${i}`))).toEqual(scalar(f));
		}
		const {parameters} = compiled(seed, original.compiler()); parameters.delete("settlement.fencePreimage");
		expect(original.evaluate(program, parameters)).toBeUndefined();
	});
	it("preserves observation and program limits and leaves NONE without successor jobs", () => {
		const f = fixture(), {program, parameters} = compiled(f, original.compiler());
		parameters.set("observation.5.bytes", 786433); expect(original.evaluate(program, parameters)).toBeUndefined();
		// The journal observation (index 0) is one carrier under the close's per-carrier encode cap too.
		const journal = compiled(f, original.compiler());
		journal.parameters.set("observation.0.bytes", 786433); expect(original.evaluate(journal.program, journal.parameters)).toBeUndefined();
		const none = fixture(4, 512, 2, 0), result = scalar(none), compiledNone = compiled(none, original.compiler());
		expect(result[0]).toBe(none.base + none.physical + none.currentTurnover + none.generationTransitions +
			2 * none.floorImage.byteLength + 6 * none.aheControl.byteLength);
		expect([0, 1, 2, 3].map(i => original.evaluate(compiledNone.program, compiledNone.parameters)!.get(`envelope.${i}`))).toEqual(result);
		const cached = declaration("deriveCreatorOrdinarySourceResourceProgramForSizing"), signing = declaration("readCreatorPlacementSigningCapacityForSizing");
		expect(cached).toContain('parameters.set("settlement.fencePreimage", fencePreimage)');
		expect(cached).toContain('parameters.set("settlement.futureLeaf", futureNative.futureLeaf)');
		expect(signing).toContain('outputNumber("signing.finalPhaseBytes"');
		expect(signing).toContain("correlatedPhases[correlatedPhases.length - 1]!.frames.map");
	});
});
