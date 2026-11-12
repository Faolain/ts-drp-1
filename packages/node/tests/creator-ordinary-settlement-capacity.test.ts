import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {canonicalArrayResourcesForSizing, canonicalBytesResourceForSizing, canonicalRecordResourceForSizing, canonicalValueResourceForSizing} from "@ts-drp/canonical/resource";
import {issuanceOrdinaryFinishingCapacityWidths} from "../../issuance-store/src/retirement.js";
import {captureJournalRetirementControl, encodeJournalRetirementNativeCarriers, journalRetirementNativeProgressFields, LIVE_JOURNAL_RETIREMENT_LIMITS} from "../../live-journal/src/retirement.js";
import {boundPreparedFields, boundCompletedFields, boundCompletionPayload} from "@ts-drp/storage";
import {createCreatorClosedRollbackProofAccounting, createCreatorNoneResourceProgramCompiler, evaluateCreatorNoneResourceProgramForSizing,
	creatorOrdinaryPreimageResourceGeometryForSizing, readCreatorOrdinaryPreimageCapacityForSizing,
	captureCreatorOrdinaryFinishingWindowLimitsForSizing} from "../src/internal/creator-closed-rollback-data.js";
import {creatorAuthenticatedEpochVertexFields} from "../src/internal/runtime-reclamation.js";
import {CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE} from "../src/internal/creator-source-custody.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Controlled numerical seams only. No fixture mints a proof, runtime hold,
// native grant, signed source or paid accounting credit. The production runtime
// producer and original full finishing differential have their own controls.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = tree.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found.length !== 1) throw new Error(`missing original numerical owner: ${name}:${found.length}`);
	return found[0]!.getText(tree).replace(/^export /, "");
}
// 974f78d0/3a28ab80: every finishing/sizing owner applies the retained-fence
// reserve through these two original helpers and the custody constant. Extract
// them (never a stub) whenever an extracted owner references them.
const RESERVE_HELPERS = ["settlementAdoptionReserveFences", "settlementAdoptionReserveProtections"] as const;
function withReserveHelpers(names: readonly string[], bindings: Record<string, unknown>) {
	const code = names.map(declaration).join("\n");
	const helpers = RESERVE_HELPERS.filter(name => !names.includes(name) && new RegExp(`\\b${name}\\(`).test(code));
	const reserve = helpers.length === 0 || "CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE" in bindings ? {} : {CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE};
	// 1515daab: sizing owners also take accepted source custody geometry from
	// creatorSourceCustodyGeometryForSizing (authenticated anchor + latched ACL).
	// As in the same commit's readiness-producer test, custody stays a controlled
	// premise here (no custody alternative); its numerical reserve is owned by
	// packages/issuance-store/tests/source-custody-capacity.test.ts.
	const custody = /\bcreatorSourceCustodyGeometryForSizing\(/.test(code) && !("creatorSourceCustodyGeometryForSizing" in bindings) ?
		{creatorSourceCustodyGeometryForSizing: () => undefined} : {};
	return {names: [...names, ...helpers], bindings: {...bindings, ...reserve, ...custody}};
}
function execute<T>(requested: readonly string[], result: string, requestedBindings: Record<string, unknown>): T {
	const {names, bindings} = withReserveHelpers(requested, requestedBindings);
	const js = ts.transpileModule(names.map(declaration).join("\n"),
		{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings;\n${js}\nreturn ${result};`)(bindings) as T;
}
function builderExpression(name: string, firstRootChild?: number): string {
	const owner = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildCreatorOrdinaryFinishingResourceProgramForSizing");
	if (owner === undefined) throw Error("missing actual pure builder");
	const matches: ts.VariableDeclaration[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
		ts.forEachChild(node, visit);
	}
	visit(owner); if (matches.length !== 1 || matches[0]!.initializer === undefined) throw Error(`missing actual builder expression:${name}`);
	const expression = matches[0]!.initializer!;
	if (firstRootChild === undefined) return expression.getText(tree);
	const array = ts.isCallExpression(expression) && expression.expression.getText(tree) === "Object.freeze" ? expression.arguments[0] : expression;
	const first = array !== undefined && ts.isArrayLiteralExpression(array) ? array.elements[0] : undefined;
	if (first === undefined || !ts.isCallExpression(first) || first.arguments[firstRootChild] === undefined)
		throw Error(`missing actual root child:${name}:${firstRootChild}`);
	return first.arguments[firstRootChild]!.getText(tree);
}
const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128};
const sum = (parts: readonly number[]): number => {
	let total = 0; for (const part of parts) {
		if (!Number.isSafeInteger(part) || part < 0 || !Number.isSafeInteger(total + part)) throw new TypeError("width-invalid");
		total += part;
	} return total;
};
function fixture(fenceCount: 0 | 1 = 1) {
	const bytes = Uint8Array.of(1, 2, 3), preview = () => undefined, reader = () => undefined;
	const state = {calls: 0, result: {successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: 512,
		nativeControlRevisionDelta: 7} as Record<string, number> | undefined, error: undefined as Error | undefined};
	const runtime = {readOrdinarySettlementCapacity(candidate: Uint8Array, callback: unknown) {
		expect(this).toBe(runtime); expect(candidate).toBe(bytes); expect(callback).toBe(preview); state.calls++;
		if (state.error !== undefined) throw state.error; return state.result;
	}};
	const facts = {current: {successorFenceCount: fenceCount, runtime: {profileId: fenceCount === 0 ? "creator-trusted-v1" :
		"creator-trusted-settlement-v1", pendingIngressCount: 0, pendingIngressBytes: 0, drainingPendingIngress: false},
		candidate: {control: false}, blueprint: {maxItems: 16384, maxDepth: 16, maxApplicationStateBytes: 65536}},
		proofFacts: {runtime, capture: {nativeIssuance: {rows: {lineages: [], plans: []}}, ahe: {control: null}}},
		sourceFacts: {material: {installedPromotionSource: null}, capacity: {}},
		applicationResource: {reader, value: {byteLength: 32, items: 3, maxDepth: 1}}};
	const options = {reader, actualProducerChunkBytes: 131072, storageIncarnation: "current", settlementPreview: preview};
	const resolve = execute<(facts: any, bytes: Uint8Array, options: any) => any>(
		["creatorOrdinarySettlementCapacityFactsForSizing"], "creatorOrdinarySettlementCapacityFactsForSizing",
		{CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes});
	const eligible = execute<(facts: any, options: any) => boolean>(
		["creatorOrdinaryResourceCurrentFactsEligible"], "creatorOrdinaryResourceCurrentFactsEligible",
		{snapshotQuarantineContract: {limits: {snapshotChunkBytes: 131072}}});
	return {facts, options, bytes, preview, runtime, state, resolve, eligible};
}

describe("ordinary settlement finite capacity through existing owners (no proof authority)", () => {
	it("keeps generation source metadata separate from full journal/evidence source and preserves OLD generation completion in serial PREP", () => {
		// Actual original install/completeAhe expressions and shared field codecs.
		// Complete source selection, authentication and native currency are explicit
		// controlled premises; these data do not establish retirement authority.
		const originalOwner = (owner: string, name: string): string => {
			const body = tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===owner), matches: ts.VariableDeclaration[]=[];
			if(body===undefined)throw Error(`missing original:${owner}`);
			function visit(node:ts.Node):void{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name)matches.push(node);ts.forEachChild(node,visit);}
			visit(body);if(matches.length!==1||matches[0]!.initializer===undefined)throw Error(`missing original:${owner}:${name}`);
			return matches[0]!.initializer!.getText(tree);
		};
		const digest="a".repeat(64), max=Number.MAX_SAFE_INTEGER,
			prefixes=[{scope:{objectId:"room",epoch:0,anchorDigest:digest},highWatermark:1,rows:[{
				journalSequence:0,vertexDigest:digest,author:"writer",authorSequence:1,nativeFrameDigest:digest,
				exactCanonicalNativeFrameBytes:new Uint8Array(8334)}]}],
			headers={retiredEmptyHeaders:[{scope:{objectId:"room",epoch:0,anchorDigest:digest},exactCanonicalNativeFrameBytes:new Uint8Array(257)}],protectedHeaderScopes:[]},
			ordinary={head:{objectId:"room"},floorEpoch:1,floorAnchor:digest,decisionDigest:digest,sourceProofDigest:digest,
				generationRecordDigests:[digest],snapshotScopes:[],protectedIndices:[],retireIndices:[],domains:[]},
			partition={recordDigests:[digest],identities:[],protectedIndices:[],retireIndices:[]},
			oldCompletion={generationDrain:{source:{bytes:new Uint8Array(4096)},phase:"complete"}},
			old={kind:"ahe-retirement-control-3",objectId:"room",incarnation:digest,revision:1,sequence:2,
				active:null,completed:oldCompletion,binding:null,nominee:null},
			data:any={summary:{floor:1},floor:{stable:1},rows:[],snapshots:[],snapshotImage:{image:{scopes:[]}},
				journal:{image:{rowCount:1}},journalDetails:{collectiblePrefixes:prefixes},journalHeaders:headers,signingDetails:[],generationSource:{complete:true}};
		const fields=execute<(value:any)=>any>(["closedRetirementSourceCarrierFields"],"closedRetirementSourceCarrierFields",{}),
			decision=execute<(value:any)=>any>(["closedRetirementDecisionCarrierFields"],"closedRetirementDecisionCarrierFields",{});
		const scopeBindings={source:data,summary:data.summary,generationPlan:data.generationSource,postAheRows:[],evidenceDraining:false,
			closedRetirementBytes:encodeCanonical,closedRetirementSourceCarrierFields:fields};
		const nativeJs=ts.transpileModule(["journalPrefixes","draining","sourceBytes"].map(name=>`const ${name}=${originalOwner("installClosedRetirementSource",name)};`).join("\n"),
			{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
			native=new Function("bindings",`const {${Object.keys(scopeBindings).join(",")}}=bindings;${nativeJs};return {journalPrefixes,sourceBytes};`)(scopeBindings);
		expect(native.journalPrefixes).toEqual([]);const decoded=decodeCanonical(native.sourceBytes) as any;
		expect(decoded.journalPrefixes).toEqual([]);expect(decoded.journalHeaders).toEqual(headers);expect(decoded).not.toHaveProperty("signingDetails");
		const footprint=(value:unknown)=>canonicalValueResourceForSizing(value,128,limits,"exact"),
			bindings={sourceSummary:footprint(data.summary),floor:footprint(data.floor),generations:footprint([]),snapshotPairs:footprint([]),
				snapshotImage:footprint(data.snapshotImage.image),journalImage:footprint(data.journal.image),journalHeaders:footprint(headers),
				artifacts:{cut:footprint({epoch:1})},digest:footprint(digest),closedRetirementSourceCarrierFields:fields,closedRetirementDecisionCarrierFields:decision,
				record:(value:any)=>canonicalRecordResourceForSizing(value,limits),tuple:(values:any)=>canonicalArrayResourcesForSizing(values,limits),sum:(...values:number[])=>sum(values)};
		const resourceBody=["generationSourceCarrier","generationDecisionCarrier","generationSourceAndDecision"].map(name=>`const ${name}=${builderExpression(name)};`).join("\n"),
			resourceJs=ts.transpileModule(resourceBody,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
			resource=new Function("bindings",`const {${Object.keys(bindings).join(",")}}=bindings;${resourceJs};return {generationSourceCarrier,generationDecisionCarrier,generationSourceAndDecision};`)(bindings),
			decisionBytes=encodeCanonical(decision({cut:{epoch:1},sourceProofDigest:digest,generationSource:true,summarySource:false,evidenceDraining:false,journalDraining:true}));
		expect(resource.generationSourceAndDecision).toBe(native.sourceBytes.byteLength+decisionBytes.byteLength);
		const fullEvidenceSource=fields({...decoded,journalPrefixes:prefixes,signingDetails:[{fullEvidence:new Uint8Array(512)}]});
		expect(encodeCanonical(fullEvidenceSource).byteLength).toBeGreaterThan(resource.generationSourceCarrier.byteLength+8334);
		const serialEmitted:any[]=[],completeBindings={boundPreparedFields,boundCompletedFields,boundCompletionPayload,sourceEpoch:1,digest,snapshotScopes:[],lHead:ordinary.head,
			maintenanceCanonicalWidth:(value:unknown)=>encodeCanonical(value).byteLength,aheControls:(value:any)=>serialEmitted.push(value),add:()=>{}};
		const completeJs=ts.transpileModule(`return ${originalOwner("composeProspectiveCreatorMaintenancePrefixesForSizing","completeAhe")};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
		new Function("bindings",`const {${Object.keys(completeBindings).join(",")}}=bindings;${completeJs}`)(completeBindings)(old,ordinary,partition);
		expect(serialEmitted).toHaveLength(3);expect(serialEmitted[1].completed).toEqual(oldCompletion);
		expect(serialEmitted[1].active.preparation).not.toHaveProperty("generationSource");expect(serialEmitted[2].completed).not.toHaveProperty("generationDrain");
		const controlBindings={boundPreparedFields,boundCompletedFields,boundCompletionPayload,aheBase:Object.fromEntries(Object.entries(old).map(([key,value])=>[key,footprint(value)])),
			aheCompletedBound:footprint(oldCompletion),preparation:footprint(ordinary),partition:footprint(partition),integer:footprint(max),digest:footprint(digest),
			snapshotHoles:footprint([]),recordDigests:footprint(partition.recordDigests),identities:footprint(partition.identities),domains:footprint([]),record:bindings.record};
		const controlJs=ts.transpileModule(["serialAhePreparedFields","serialAhePrepared","serialAheCompleted"].map(name=>`const ${name}=${builderExpression(name)};`).join("\n"),
			{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
			controls=new Function("bindings",`const {${Object.keys(controlBindings).join(",")}}=bindings;${controlJs};return {serialAhePrepared,serialAheCompleted};`)(controlBindings);
		expect(controls.serialAhePrepared.byteLength).toBeGreaterThanOrEqual(encodeCanonical(serialEmitted[1]).byteLength);
		expect(controls.serialAheCompleted.byteLength).toBeGreaterThanOrEqual(encodeCanonical(serialEmitted[2]).byteLength);
		const metadataBindings={...bindings,...controls,participantBounds:[footprint(old),footprint(old),footprint(old),footprint(old)],
			participantPreps:[footprint(null),footprint(null),footprint({preparationBytes:new Uint8Array(257)}),footprint(null)],
			floorImage:footprint({oldFloor:1}),ahePoint:footprint({head:1}),preparation:footprint(ordinary),partition:footprint(partition),
			generationPreparation:footprint({...ordinary,generationSource:{bytes:new Uint8Array(4096)}}),aheControl:footprint(old),
			sourceAndDecision:encodeCanonical(fullEvidenceSource).byteLength+decisionBytes.byteLength,
			generationSourceAndDecision:resource.generationSourceAndDecision};
		const metadataJs=ts.transpileModule(["metadataControlBytes","metadataEpisode","generationMetadataEpisode"].map(name=>`const ${name}=${builderExpression(name)};`).join("\n"),
			{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
			measure=(value:typeof metadataBindings)=>new Function("bindings",`const {${Object.keys(value).join(",")}}=bindings;${metadataJs};return [metadataEpisode,generationMetadataEpisode];`)(value),
			baseline=measure(metadataBindings),changed=measure({...metadataBindings,sourceAndDecision:metadataBindings.sourceAndDecision+8334});
		expect(changed).toEqual([baseline[0]+8334,baseline[1]]); // No evidence source occurs in GEN metadata.
		const widerPreparation = measure({...metadataBindings, participantPreps: metadataBindings.participantPreps.map((value: ReturnType<typeof footprint>, index: number) =>
			index === 2 ? {...value, byteLength:value.byteLength + 131} : value)});
		expect(widerPreparation).toEqual([baseline[0]+131, baseline[1]+131]);
		const compiler=createCreatorNoneResourceProgramCompiler(),compiledBindings={...metadataBindings,compiler,record:compiler.backend(limits).record,
			width:(value:any)=>compiler.references(value).byteLength,sourceDecisionTerm:compiler.inputNumber("test.evidenceSource",metadataBindings.sourceAndDecision),
			generationSourceCarrier:resource.generationSourceCarrier,generationDecisionCarrier:resource.generationDecisionCarrier};
		const metadataTermJs=ts.transpileModule(["metadataControlTerm","metadataTerm","generationMetadataTerm"].map(name=>`const ${name}=${builderExpression(name)};`).join("\n"),
			{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
			terms=new Function("bindings",`const {${Object.keys(compiledBindings).join(",")}}=bindings;${metadataTermJs};return [metadataTerm,generationMetadataTerm];`)(compiledBindings);
		terms.forEach((term:any,index:number)=>compiler.outputNumber(`metadata.${index}`,term));const program=compiler.finish();
		for(const extra of [0,8334]){const values=evaluateCreatorNoneResourceProgramForSizing(program,new Map([["test.evidenceSource",metadataBindings.sourceAndDecision+extra]]));
			expect([values?.get("metadata.0"),values?.get("metadata.1")]).toEqual([baseline[0]+extra,baseline[1]]);}
		// Every changing native/RAW carrier remains independently charged; source
		// branch selection creates no exact-byte credit in this actual book.
		const book=createCreatorClosedRollbackProofAccounting([],true);expect(book.chargeUnknownEncodedLength(74)).toBe(true);
		const raw=serialEmitted.map(value=>encodeCanonical(value));for(const bytes of [...raw,native.sourceBytes,decisionBytes])expect(book.charge(bytes)).toBe(true);
		expect(book.chargedBytes).toBe(74+sum(raw.map(bytes=>bytes.byteLength))+native.sourceBytes.byteLength+decisionBytes.byteLength);
	});
	it("keeps enclosing journal observations in ordinary I/jobs and native limits, not close/CURRENT/serial source charge roots", () => {
		// Actual scalar/compiled composition expressions with controlled resource
		// footprints. These assert lifetime algebra, not native/source authority.
		const footprint = (byteLength: number) => ({byteLength, items: 1, maxDepth: 0});
		const base: Record<string, any> = {runtimeEnvelope: 120, signingPhysical: 130,
			journal: {canonicalRowByteLengthsTotal: 140}, journalWrapper: footprint(1000), nativeProgress: footprint(11),
			journalPlan: footprint(150), snapshotWrapper: footprint(13), protectedHeaders: footprint(14), journalHeaders: footprint(15),
			floorPoint: footprint(16), aheControl: footprint(17), classifier: 180, summarySource: footprint(19),
			currentTurnover: 20, generationTransitions: 21, floorImage: footprint(22), metadataEpisode: 230, generationMetadataEpisode: 210, drain: 240, headerOnlyDrain: 241,
			generationSource: footprint(25), aheFrame: footprint(26), futureInventory: footprint(27), newFact: footprint(28),
			successorJobs: [500], lifetimeBase: (phase: string) => (phase === "closeAdopt" ? 4000 : 300) + 74}; // Prior UNKNOWN stays in each book.
		const scalarBody = ["rawSourcePhysical", "envelopes"].map(name => `const ${name}=${builderExpression(name)};`).join("\n") +
			`\nconst closeEnvelope=${builderExpression("envelopes", 0)}, currentEnvelope=${builderExpression("envelopes", 1)};`;
		const scalar = (wrapperBytes: number, supplement: number, closeDominates = true) => {
			const bindings = {...base, journalWrapper: footprint(wrapperBytes), journalRawSupplement: supplement, sum: (...parts: number[]) => sum(parts),
				lifetimeBase: closeDominates ? base.lifetimeBase : (phase: string) => (phase === "currentTurnover" ? 4000 : 300) + 74};
			const js = ts.transpileModule(scalarBody, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js};return {rawSourcePhysical,envelopes,closeEnvelope,currentEnvelope};`)(bindings);
		};
		for (const supplement of [0, 127, 128]) {
			const expected = scalar(1000, supplement), changed = scalar(2000, supplement);
			// ea4eb158: each fresh RAW source also owns one complete ready snapshot
			// inventory (futureInventory, 27); the journal wrapper stays outside.
			expect(expected.rawSourcePhysical).toBe(sum([120, 130, 140, 11, 150, 13, 13, 27, 14, 15, 16, 17, 180, 19, supplement]));
			expect(changed.closeEnvelope).toBe(expected.closeEnvelope);
			expect(changed.currentEnvelope).toBe(expected.currentEnvelope);
			expect(expected.envelopes[0]).toBe(expected.closeEnvelope); expect(changed.envelopes).toEqual(expected.envelopes);
			const currentBefore = scalar(1000, supplement, false), currentAfter = scalar(2000, supplement, false);
			expect(currentBefore.envelopes[0]).toBe(currentBefore.currentEnvelope);
			expect(currentAfter.envelopes).toEqual(currentBefore.envelopes);
			const compiler = createCreatorNoneResourceProgramCompiler(), width = (value: {byteLength: number}) => compiler.number(value.byteLength),
				bindings = {...base, compiler, width, journalRawSupplement: supplement,
					inputNumber: (key: string, value: number) => compiler.inputNumber(key, value), runtimeEnvelopeTerm: compiler.number(base.runtimeEnvelope),
					signingPhysicalTerm: compiler.number(base.signingPhysical), classifierTerm: compiler.number(base.classifier),
					metadataTerm: compiler.number(base.metadataEpisode), generationMetadataTerm: compiler.number(base.generationMetadataEpisode),
					drainTerm: compiler.number(base.drain), headerOnlyDrainTerm: compiler.number(base.headerOnlyDrain),
					currentTurnoverTerm: compiler.number(base.currentTurnover), successorJobTerms: [compiler.number(500)],
					lifetimeBaseTerm: (phase: string) => compiler.number(base.lifetimeBase(phase))};
			const body = ["rawSourcePhysicalTerm", "roots"].map(name => `const ${name}=${builderExpression(name)};`).join("\n") +
				`\nconst closeEnvelope=${builderExpression("roots", 0)}, currentEnvelope=${builderExpression("roots", 1)};`,
				js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
				compiled = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js};return {roots,closeEnvelope,currentEnvelope};`)(bindings);
			compiled.roots.forEach((root: any, index: number) => compiler.outputNumber(`test.${index}`, root));
			compiler.outputNumber("test.close", compiled.closeEnvelope); compiler.outputNumber("test.current", compiled.currentEnvelope);
			const parameters = new Map(compiler.captureParameters()), programme = compiler.finish(), result = evaluateCreatorNoneResourceProgramForSizing(programme, parameters);
			expect([0, 1, 2, 3].map(index => result?.get(`test.${index}`))).toEqual(expected.envelopes);
			expect(result?.get("test.close")).toBe(expected.closeEnvelope); expect(result?.get("test.current")).toBe(expected.currentEnvelope);
		}
		const builder = declaration("buildCreatorOrdinaryFinishingResourceProgramForSizing");
		expect(builder).toContain("journalWrapper.byteLength > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes");
		expect(builder).toContain("creatorIssuanceMaintenanceObservationCarriers({"); // Full successor jobs unchanged.
		expect(declaration("creatorIssuanceMaintenanceObservationCarriers")).toContain("drainSource: input.journal.drainSource");
		expect(declaration("acquireCreatorIssuanceMaintenanceProof")).toContain("creatorIssuanceMaintenanceObservationCarriers({"); // Immediate ordinary I is unchanged.
		expect(() => builderExpression("physical")).toThrow("missing actual builder expression:physical");
		expect(() => builderExpression("physicalTerm")).toThrow("missing actual builder expression:physicalTerm");
	});
	it("reserves one prospective row-plan plus independent header-only drain, retaining distinct OLD plans and all progress", () => {
		// Actual original reservation bodies, native encoder and accounting union.
		// Context/classification are controlled premises, not authority minted here.
		const locals = new Map<string, ts.VariableDeclaration[]>();
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
				["journalNativeCarrierFields", "addJournalNativeControl", "sourcePhysicalWidths"].includes(node.name.text))
				locals.set(node.name.text, [...(locals.get(node.name.text) ?? []), node]);
			ts.forEachChild(node, visit);
		}
		visit(tree);
		const original = (name: string) => {
			const matches = locals.get(name); if (matches?.length !== 1 || matches[0]!.initializer === undefined) throw Error(`original reservation:${name}`);
			return matches[0]!.initializer!;
		};
		const sourceBody = original("sourcePhysicalWidths");
		if (!ts.isArrowFunction(sourceBody) || !ts.isBlock(sourceBody.body)) throw Error("original source capture");
		const originalCapture = sourceBody.body.statements.slice(0, 2).map(statement => statement.getText(tree)).join("\n");
		expect(originalCapture).toContain("reservedJournalPlan = journalNativeCarriers.length === 2");
		const digest = "a".repeat(64), base = {kind: "v3-live-journal-retirement-control-2", objectId: "room", incarnation: digest,
			revision: 2, sequence: 1, active: null, drain: null,
			completed: {decisionDigest: digest, sourceProofDigest: digest, throughEpoch: 0, protectedScopes: []}},
			plan = {baseControl: base, sourceImage: {imageDigest: digest, scopeCount: 1, rowCount: 17, byteCharge: 4096},
				prefixes: [{scope: {objectId: "room", epoch: 0, anchorDigest: digest}, highWatermark: 17,
					rows: Array.from({length: 17}, (_, journalSequence) => ({journalSequence, vertexDigest: journalSequence.toString(16).padStart(64, "0"),
						author: "writer", authorSequence: journalSequence + 1, nativeFrameDigest: digest}))}]},
			controls = [0, 16, 17].map((cursor, batches) => ({...base, revision: 3 + batches,
				drain: {plan, cursor, batches, residualImageDigest: digest}})),
			native = controls.map(control => encodeJournalRetirementNativeCarriers(control as any)),
			planBytes = native[0]!.planBytes!;
		for (const sourceControl of [base, controls[0]]) {
			const emitted: unknown[] = [], bindings = {digest, journalRetirementNativeProgressFields,
				maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength, add: (value: unknown) => emitted.push(value)};
			const body = `const journalNativeCarrierFields=${original("journalNativeCarrierFields").getText(tree)};
			 let reservedJournalPlan; const addJournalNativeControl=${original("addJournalNativeControl").getText(tree)};
			 return (sourceControl, controls) => {const maintenanceParticipants=[null,sourceControl]; ${originalCapture}
			 journalNativeCarriers.forEach(add); controls.forEach(addJournalNativeControl);};`,
				js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings)(sourceControl, controls);
			expect(emitted.filter(value => value === plan)).toHaveLength(1); // Fresh evidence OR later summary source, not both books added.
		}
		const headerPlan = {...plan, prefixes: [], retiredEmptyHeaders: [{scope: {objectId: "room", epoch: 1, anchorDigest: digest},
				exactCanonicalNativeFrameBytes: new Uint8Array(257)}], protectedHeaderScopes: [{objectId: "room", epoch: 0, anchorDigest: digest}]},
			headerPlanBytes = encodeCanonical(headerPlan), // Controlled field carrier; no native header/classification authority is asserted.
			oldPlan = {...plan, sourceImage: {...plan.sourceImage, imageDigest: "b".repeat(64)}},
			oldNative = encodeJournalRetirementNativeCarriers({...controls[0]!, drain: {...controls[0]!.drain, plan: oldPlan}} as any),
			book = createCreatorClosedRollbackProofAccounting([], true), unknown = 74;
		expect(book.chargeUnknownEncodedLength(unknown)).toBe(true);
		for (const carrier of [oldNative.planBytes!, planBytes, headerPlanBytes, ...native.map(row => row.controlBytes), planBytes.slice(), oldNative.planBytes!.slice()])
			expect(book.charge(carrier)).toBe(true);
		expect(book.chargedBytes).toBe(unknown + oldNative.planBytes!.byteLength + planBytes.byteLength + headerPlanBytes.byteLength + sum(native.map(row => row.controlBytes.byteLength)));
		const supplement = execute<(journal: any, protectedMaterial: Uint8Array[]) => number>([
			"closedJournalNativeControlCarriers", "closedJournalReconstructedControlCarriers", "creatorOrdinaryJournalRawSupplementForSizing"],
			"creatorOrdinaryJournalRawSupplementForSizing", {compareBytes, encodeJournalRetirementNativeCarriers, maintenanceWidthSum: sum,
				requireLaw: (ok: boolean) => {if (!ok) throw Error("invalid native carriers");}});
		expect(supplement({control: {...controls[0]!, drain: {...controls[0]!.drain, plan: oldPlan}}, canonicalRows: [],
			exactCanonicalControlCarriers: [oldNative.controlBytes, oldNative.planBytes], drainSource: {control: base, canonicalRows: []}},
			[oldNative.controlBytes, encodeJournalRetirementNativeCarriers(base as any).controlBytes])).toBe(oldNative.planBytes!.byteLength);
		const footprint = (byteLength: number) => ({byteLength, items: 1, maxDepth: 0}), zero = footprint(0),
			maxProgress = Math.max(...native.map(row => row.controlBytes.byteLength)),
			bindings = {signingPlan: zero, signingControlFrame: zero, aheFrame: zero, signingBatches: 1, participantBounds: [zero, zero, zero, zero],
				journalPlan: footprint(planBytes.byteLength), journalHeaderPlan: footprint(headerPlanBytes.byteLength), journalBatches: native.length, nativeProgress: footprint(maxProgress), evidenceEntries: zero,
				summarySource: zero, sum: (...parts: number[]) => sum(parts)};
		const scalarJs = ts.transpileModule(`const headerOnlyDrain=${builderExpression("headerOnlyDrain")};const drain=${builderExpression("drain")};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			scalar = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${scalarJs};return drain;`)(bindings);
		expect(headerPlanBytes.byteLength).toBeGreaterThan(0); expect(headerPlanBytes.byteLength).toBeLessThan(planBytes.byteLength);
		expect(scalar).toBe(headerPlanBytes.byteLength + native.length * maxProgress); // No second full row-plan in drain; independent headers remain.
		expect(unknown + oldNative.planBytes!.byteLength + planBytes.byteLength + scalar).toBeGreaterThanOrEqual(book.chargedBytes);
		const actualResource = (value: unknown) => canonicalValueResourceForSizing(value, limits.maxDepth, limits, "exact"),
			schemaBindings = {completed: [zero, actualResource(base)],
			digest: actualResource(digest), integer: actualResource(Number.MAX_SAFE_INTEGER),
			retiredEmptyHeaders: actualResource(headerPlan.retiredEmptyHeaders),
			protectedHeaders: actualResource(headerPlan.protectedHeaderScopes),
			prefixes: actualResource(plan.prefixes),
			record: (fields: any) => canonicalRecordResourceForSizing(fields, limits), tuple: (children: any) => canonicalArrayResourcesForSizing(children, limits)},
			schemaJs = ts.transpileModule(["journalPlanFields", "journalPlan", "journalHeaderPlan"].map(name => `const ${name}=${builderExpression(name)};`).join("\n"),
				{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			schemas = new Function("bindings", `const {${Object.keys(schemaBindings).join(",")}}=bindings;${schemaJs};return {journalPlan,journalHeaderPlan};`)(schemaBindings);
		expect(schemas.journalHeaderPlan.byteLength).toBeGreaterThanOrEqual(headerPlanBytes.byteLength);
		expect(schemas.journalPlan.byteLength).toBeGreaterThan(schemas.journalHeaderPlan.byteLength);
		const compiler = createCreatorNoneResourceProgramCompiler(), width = (value: {byteLength: number}) => compiler.number(value.byteLength),
			compiledBindings = {...bindings, compiler, width, signingBatchTerm: compiler.number(1), journalBatchTerm: compiler.number(native.length)},
			compiledJs = ts.transpileModule(`const headerOnlyDrainTerm=${builderExpression("headerOnlyDrainTerm")};const drainTerm=${builderExpression("drainTerm")};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			compiled = new Function("bindings", `const {${Object.keys(compiledBindings).join(",")}}=bindings;${compiledJs};return drainTerm;`)(compiledBindings);
		compiler.outputNumber("drain", compiled);
		expect(evaluateCreatorNoneResourceProgramForSizing(compiler.finish(), new Map())?.get("drain")).toBe(scalar);
		expect(builderExpression("journalHeaderPlan")).toBe("record({...journalPlanFields, prefixes: tuple([])})");
		expect(builderExpression("envelopes")).toContain("4 * aheFrame.byteLength, headerOnlyDrain)");
		expect(builderExpression("roots")).toContain("compiler.product(4, width(aheFrame)), headerOnlyDrainTerm)");
		const generationBindings = {sum: (...parts: number[]) => sum(parts), lifetimeBase: () => unknown, rawSourcePhysical: oldNative.planBytes!.byteLength + planBytes.byteLength,
			metadataEpisode: 0, generationMetadataEpisode: 0, generationSource: footprint(1_000_000), aheFrame: zero, headerOnlyDrain: scalar, drain: scalar,
			currentTurnover: 0, generationTransitions: 0, floorImage: zero, aheControl: zero, successorJobs: [], futureInventory: zero, newFact: zero},
			generationJs = ts.transpileModule(`const envelopes=${builderExpression("envelopes")};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			generation = new Function("bindings", `const {${Object.keys(generationBindings).join(",")}}=bindings;${generationJs};return envelopes[2];`)(generationBindings);
		expect(generation).toBe(unknown + oldNative.planBytes!.byteLength + planBytes.byteLength + 1_000_000 + scalar);
	});
	it("retains every distinct reconstructed close/CURRENT/serial RAW header, row and native resume-control carrier", () => {
		// Genuine codec/native field encoder, controlled already-captured data.
		// No byte shape grants membership, source selection, or resume authority.
		const control = (revision: number) => ({kind: "v3-live-journal-retirement-control-2", objectId: "room",
			incarnation: "1".repeat(64), revision, sequence: 0, active: null, completed: null, drain: null});
		const prior = control(0), current = control(1), original = encodeJournalRetirementNativeCarriers(prior as any),
			present = encodeJournalRetirementNativeCarriers(current as any), header = encodeCanonical(["scopes", ["room", 0], {fullHeaderPRE: new Uint8Array(4096)}]),
			row = encodeCanonical(["acceptedEntries", ["room", 0, 0], {fullPRE: new Uint8Array(8334), signature: new Uint8Array(64)}]),
			physical = encodeCanonical(["scopes", ["room", 1], {header: "current"}]);
		const supplement = execute<(journal: any, protectedMaterial: Uint8Array[]) => number>([
			"closedJournalNativeControlCarriers", "closedJournalReconstructedControlCarriers", "creatorOrdinaryJournalRawSupplementForSizing"],
			"creatorOrdinaryJournalRawSupplementForSizing", {compareBytes, encodeJournalRetirementNativeCarriers, maintenanceWidthSum: sum,
				requireLaw: (ok: boolean) => {if (!ok) throw Error("invalid native carriers");}});
		const journal = {control: current, exactCanonicalControlCarriers: [present.controlBytes], canonicalRows: [physical],
			drainSource: {control: prior, canonicalRows: [header, row, physical], image: {imageDigest: "original"}}};
		const before = encodeCanonical(journal), expected = row.byteLength + present.controlBytes.byteLength + original.controlBytes.byteLength;
		expect(supplement(journal, [header.slice()])).toBe(expected);
		expect(supplement(journal, [])).toBe(expected + header.byteLength); // Missing old header cannot acquire equality credit.
		expect(supplement(journal, [header, row, original.controlBytes, present.controlBytes])).toBe(0);
		const altered = header.slice(); altered[altered.length - 1] ^= 1;
		expect(supplement(journal, [altered])).toBe(expected + header.byteLength);
		expect(supplement({...journal, drainSource: {...journal.drainSource, canonicalRows: [header, row, row, physical]}}, [header])).toBe(expected);
		const changed = control(2), changedBytes = encodeJournalRetirementNativeCarriers(changed as any).controlBytes;
		expect(supplement({...journal, drainSource: {...journal.drainSource, control: changed}}, [header, original.controlBytes]))
			.toBe(row.byteLength + present.controlBytes.byteLength + changedBytes.byteLength);
		expect(() => supplement({...journal, exactCanonicalControlCarriers: []}, [])).toThrow("invalid native carriers");
		expect(supplement({get drainSource() {return undefined;}}, [])).toBe(0);
		expect(encodeCanonical(journal)).toEqual(before);
	});
	it("does not open a settlement producer for NONE and requires a fresh original producer for each V1 attempt", () => {
		const none = fixture(0); expect(none.resolve(none.facts, none.bytes, none.options)).toBe(none.facts);
		expect(none.state.calls).toBe(0); expect(none.eligible(none.facts, none.options)).toBe(true);
		const f = fixture(); const first = f.resolve(f.facts, f.bytes, f.options), second = f.resolve(f.facts, f.bytes, f.options);
		expect(first).not.toBe(f.facts); expect(second).not.toBe(first); expect(Object.isFrozen(first)).toBe(true);
		expect(first.settlementCapacity).toBe(f.state.result); expect(f.state.calls).toBe(2);
		expect(f.eligible(f.facts, f.options)).toBe(false); expect(f.eligible(first, f.options)).toBe(true);
		expect(Object.hasOwn(f.facts, "settlementCapacity")).toBe(false);
	});
	it("declines unavailable and invalid primitive dimensions, and does not catch a genuine producer error", () => {
		const missing = fixture(); expect(missing.resolve(missing.facts, missing.bytes, {...missing.options, settlementPreview: undefined})).toBeUndefined();
		expect(missing.state.calls).toBe(0);
		const absent = fixture(); delete (absent.runtime as Partial<typeof absent.runtime>).readOrdinarySettlementCapacity;
		expect(absent.resolve(absent.facts, absent.bytes, absent.options)).toBeUndefined();
		for (const invalid of [undefined, {successorFenceCount: 0, canonicalSuccessorFencePreimageByteLength: 512, nativeControlRevisionDelta: 7},
			{successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: 0, nativeControlRevisionDelta: 7},
			{successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: limits.maxBytes + 1, nativeControlRevisionDelta: 7},
			{successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: 512, nativeControlRevisionDelta: Number.NaN}]) {
			const f = fixture(); f.state.result = invalid;
			expect(f.resolve(f.facts, f.bytes, f.options)).toBeUndefined(); expect(f.state.calls).toBe(1);
		}
		const failed = fixture(); failed.state.error = new Error("original-current-native-refusal");
		expect(() => failed.resolve(failed.facts, failed.bytes, failed.options)).toThrow(failed.state.error);
	});
	it("resolves once before cached arithmetic and scalar fallback, without changing the delivered result", () => {
		const f = fixture(), result = Object.freeze({knownCarriers: [f.bytes.slice()], unknownEncodedLengths: [101, 202],
			fullFutureProofEnvelopeByteLengths: [303, 404]}), events: string[] = [];
		const cell = Object.freeze({kind: "ordinary-resource-program", program: {}});
		Object.assign(f.facts.sourceFacts.capacity, {template: {kind: "creator-finishing-source-programs-1", ordinary: cell}});
		let warm = true;
		const derive = execute<(facts: any, proof: object, bytes: Uint8Array, options: any) => any>(
			["creatorOrdinarySettlementCapacityFactsForSizing", "deriveCreatorOrdinaryFinishingCapacityForSizing"],
			"deriveCreatorOrdinaryFinishingCapacityForSizing", {
				CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes,
				isCreatorOrdinarySourceResourceProgram: (value: unknown) => value === cell,
				deriveCreatorOrdinarySourceResourceProgramForSizing: (_cell: object, facts: any) => {
					events.push("warm"); expect(facts.settlementCapacity).toBe(f.state.result); return warm ? result : undefined;
				},
				deriveCreatorOrdinaryFinishingCapacityScalarForSizing: (facts: any) => {
					events.push("scalar"); expect(facts.settlementCapacity).toBe(f.state.result); return {capacity: result};
				}, createCreatorNoneResourceProgramCompiler: () => {throw new Error("unexpected cold compiler");},
			});
		expect(derive(f.facts, {}, f.bytes, f.options).capacity).toEqual(result); expect(f.state.calls).toBe(1);
		warm = false; expect(derive(f.facts, {}, f.bytes, f.options).capacity).toBe(result);
		expect(f.state.calls).toBe(2); expect(events).toEqual(["warm", "warm", "scalar"]);
		expect(result.unknownEncodedLengths).toEqual([101, 202]); expect(result.knownCarriers[0]).toEqual(f.bytes);
	});
	it("keeps sufficient windows evaluation-free and handles inconclusive declaration-valid demand using only prepared arithmetic", () => {
		// Actual private delivery/meter bodies; authenticated capture/currentness
		// are controlled premises here, not replaced by this numerical fixture.
		const identity = {}, reader = () => undefined, oldObservation = encodeCanonical({old: "OBS"}),
			signing = encodeCanonical({signing: "exact"}), parametersBytes = encodeCanonical({parameters: "exact"}),
			unsigned = new Uint8Array(256), operation = encodeCanonical({action: "placeBlock", id: "x", kind: "stone", x: 0, y: 0});
		const policy = {maxAdditionalLocalRows: 8, maxAdditionalReceivedRows: 4, maxAdditionalActions: 32,
			maxAdditionalOperationBytes: 1024, maxAdditionalPreimageBytes: 4096, maxAdditionalEpochVertexBytes: 3072,
			maxCanonicalOperationByteLength: 1024, maxCanonicalPreimageByteLength: 1024, maxCanonicalEpochVertexByteLength: 1024,
			maxSuccessorFencePreimageByteLength: 1024, maxReceivedPendingIngressByteLength: 2048,
			maxApplicationBytes: 16384, maxApplicationItems: 4096, maxApplicationDepth: 8};
		const context = {objectId: "room", epoch: 3, anchorDigest: "anchor", profileId: "creator-trusted-v1",
			storageIncarnation: "store", snapshotChunkBytes: 131072};
		const program = {context, sourceIdentity: identity, preparedSigning: {rows: [signing]}, preparedMaterial: true, preparedParameters: []};
		const certificate = {ordinaryProofEnvelopeByteLength: 500, nativeUnknownByteLength: 11, runtimeUnknownByteLength: 22,
			fullFutureProofEnvelopeByteLengths: Object.freeze([101, 202, 303, 404])};
		const window = {declaredLimits: policy, limits: policy, certificate, application: {byteLength: 16384, items: 4096, maxDepth: 8}, priorUnknownByteLength: 7,
			acceptedActions: 0, acceptedOperationBytes: 0, acceptedPreimageBytes: 0, acceptedEpochVertexBytes: 0};
		const geometry = {graphVersion: 3, baseGraphCount: 3, basePreimageCount: 2, acceptedCount: 0, localIssuedCount: 0,
			journal: {parametersBytes}};
		const facts: any = {sourceFacts: {identity, runtimeCensusObservation: {bytes: oldObservation},
			nativeIssuance: {rows: {issued: [], outbox: []}}, journal: {image: {rowCount: 3, scopeCount: 1}},
			capacity: {template: {kind: "creator-finishing-source-programs-1", ordinary: program},
				readiness: {reader, sourceIdentity: identity, geometry, window}}},
			current: {runtime: {...context, graphVersion: 3, kind: "local-issuance", epochBytes: 512},
				parameters: {snapshotChunkBytes: 131072, maxEpochVertices: 8192, maxEpochBytes: 8388608}, currentEpochVertexCount: 3,
				currentSignedPreimageByteLengths: [256, 256], successorFenceCount: 0,
				candidate: {operationCount: 1, control: false, exactCanonicalOperationBytes: operation, exactCanonicalEpochVertexBytes: new Uint8Array(192)},
				pendingIngress: {roots: []}}, applicationResource: {value: {byteLength: 32, items: 3, maxDepth: 1}},
			knownResourceTotals: {unknownEncodedBytes: 7}, proofFacts: {capture: {signingRows: [signing.slice()],
				nativeIssuance: {rows: {issued: [], outbox: []}}, journal: {image: {rowCount: 3, scopeCount: 1}},
				replacedRuntimeCensusObservation: oldObservation.slice()}}};
		let received: any, settlements = 0, projected = 10, pureEnabled = false, pureCalls = 0, suffixCalls = 0;
		let pureCapacity: any = Object.freeze({knownCarriers: [unsigned.slice()], unknownEncodedLengths: [13, 17],
			fullFutureProofEnvelopeByteLengths: Object.freeze([111, 222, 333, 444])});
		const suffixCapacity = Object.freeze({capacity: {...pureCapacity, fullFutureProofEnvelopeByteLengths: [555, 666, 777, 888]}});
		const proof = {accounting: {maxBytes: 1000}, readReceivedAppendSizing: () => received};
		const reconstruct = () => {throw Error("ordinary window reconstructed a future scenario");};
		const derive = execute<any>(["creatorOrdinarySizingRecord", "captureCreatorOrdinaryFinishingWindowLimitsForSizing",
			"creatorOrdinaryFinishingWindowCandidateUsageForSizing", "creatorOrdinaryFinishingWindowCanAdmitForSizing",
			"deriveCreatorOrdinaryFinishingCapacityForSizing"], "deriveCreatorOrdinaryFinishingCapacityForSizing", {
			encodeCanonical, compareBytes, maintenanceWidthSum: sum,
			LIVE_JOURNAL_RETIREMENT_LIMITS, AHE_BOUNDED_READ_LIMITS: {maxBlobBytes: 65536, maxUnionBytes: 786432},
			CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes,
			creatorOrdinarySettlementCapacityFactsForSizing: (value: unknown) => {settlements++; return value;},
			creatorOrdinaryResourceCurrentFactsEligible: () => true, isCreatorOrdinarySourceResourceProgram: (value: unknown) => value === program,
			proofMaterialOwners: new Map([[proof.accounting, {projectByteLengths: () => ({whole: projected})}]]),
			deriveCreatorOrdinarySourceResourceProgramForSizing: (selected: any, current: any, held: any, bytes: Uint8Array) => {
				if (!pureEnabled) return reconstruct(); pureCalls++;
				expect(selected).toBe(program); expect(current).toBe(facts); expect(held).toBe(proof); expect(bytes).toBe(unsigned);
				return pureCapacity;
			},
			creatorOrdinarySuffixCapacityForSizing: (current: any, held: any, bytes: Uint8Array, actual: any, suffix: any) => {
				suffixCalls++; expect(current).toBe(facts); expect(held).toBe(proof); expect(bytes).toBe(unsigned);
				expect(actual.capacity).toBe(pureCapacity); expect(suffix.additionalLocalVertices).toBe(5);
				expect(geometry.acceptedCount).toBe(0); expect(geometry.localIssuedCount).toBe(0);
				return suffixCapacity;
			},
			creatorOrdinaryPreimageResourceGeometryForSizing: () => ({canonicalPreimageByteLength: 512, canonicalEpochVertexByteLength: 384}),
			deriveCreatorOrdinaryFinishingCapacityScalarForSizing: reconstruct,
			createCreatorNoneResourceProgramCompiler: reconstruct,
		});
		const options = {reader, storageIncarnation: "store", window: policy};
		const run = () => derive(facts, proof, unsigned, options);
		const first = run(); expect(first.capacity.unknownEncodedLengths).toEqual([11, 22]);
		expect(first.capacity.fullFutureProofEnvelopeByteLengths).toBe(certificate.fullFutureProofEnvelopeByteLengths);
		expect(first.capacity.knownCarriers).toEqual([unsigned, parametersBytes, facts.current.candidate.exactCanonicalEpochVertexBytes, operation]);
		unsigned[0] = 1; expect(first.capacity.knownCarriers[0]![0]).toBe(0); // Detached caller-visible data.
		for (const change of [() => {window.acceptedActions = 32;}, () => {facts.current.runtime.epoch = 4;},
			() => {facts.proofFacts.capture.signingRows = [new Uint8Array(1)];},
			() => {facts.proofFacts.capture.replacedRuntimeCensusObservation = new Uint8Array(1);},
			() => {facts.applicationResource.value.byteLength = 16385;}, () => {facts.knownResourceTotals.unknownEncodedBytes = 8;},
			() => {projected = 468;}]) {
			change(); expect(run()).toBeUndefined();
			window.acceptedActions = 0; facts.current.runtime.epoch = 3; facts.proofFacts.capture.signingRows = [signing.slice()];
			facts.proofFacts.capture.replacedRuntimeCensusObservation = oldObservation.slice();
			facts.applicationResource.value.byteLength = 32; facts.knownResourceTotals.unknownEncodedBytes = 7; projected = 10;
		}
		received = {signature: new Uint8Array(64)}; facts.current.runtime.kind = "received-append";
		expect(run().capacity.unknownEncodedLengths).toEqual([0, 22]);
		expect(settlements).toBe(9); // Fresh settlement eligibility on every attempt.
		expect(pureCalls).toBe(0); expect(suffixCalls).toBe(0); // Original sufficient window stays evaluation-free.
		pureEnabled = true; received = undefined; facts.current.runtime.kind = "local-issuance";
		context.profileId = "creator-trusted-settlement-v1"; facts.current.runtime.profileId = context.profileId;
		facts.current.successorFenceCount = 1;
		facts.settlementCapacity = {successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: 512, nativeControlRevisionDelta: 1};
		window.limits = {...policy, maxAdditionalLocalRows: 1}; facts.current.candidate.control = true;
		facts.current.runtime.issuanceScope = {author: "b".repeat(64)};
		const suffix = {additionalLocalVertices: 5, applicationOperationCount: 1, graphVersion: 3, exactCanonicalApplicationOperationBytes: operation};
		Reflect.set(options, "suffix", suffix);
		expect(run()).toBe(suffixCapacity); expect(pureCalls).toBe(1); expect(suffixCalls).toBe(1);
		expect(window.acceptedActions).toBe(0); expect(window.acceptedPreimageBytes).toBe(0);
		pureCapacity = undefined; expect(run()).toBeUndefined(); expect(pureCalls).toBe(2); expect(suffixCalls).toBe(1);
		pureCapacity = suffixCapacity.capacity;
		for (const change of [() => {suffix.additionalLocalVertices = 9;}, () => {window.acceptedActions = 32;},
			() => {facts.current.runtime.epoch = 4;}, () => {facts.knownResourceTotals.unknownEncodedBytes = 8;},
			() => {facts.applicationResource.value.byteLength = 16385;}, () => {facts.current.runtime.kind = "received-append";}]) {
			change(); expect(run()).toBeUndefined(); expect(pureCalls).toBe(2); expect(suffixCalls).toBe(1);
			suffix.additionalLocalVertices = 5; window.acceptedActions = 0; facts.current.runtime.epoch = 3;
			facts.knownResourceTotals.unknownEncodedBytes = 7; facts.applicationResource.value.byteLength = 32;
			facts.current.runtime.kind = "local-issuance";
		}
		Reflect.deleteProperty(options, "suffix"); Reflect.deleteProperty(window, "certificate");
		expect(run().capacity).toBe(pureCapacity); expect(pureCalls).toBe(3); expect(suffixCalls).toBe(1);
		Reflect.deleteProperty(program, "preparedParameters"); expect(run()).toBeUndefined(); expect(pureCalls).toBe(3);
	});
	it("retains the same prepared source DATA without a sufficient rectangle only after complete boundary delivery", async () => {
		const owner = tree.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "prepareCreatorOrdinarySourceReadinessForSizing");
		if (owner?.body === undefined) throw Error("missing actual readiness owner");
		const statements = [...owner.body.statements], first = statements.findIndex(node => ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "selectedWindow"));
		if (first < 0) throw Error("missing actual readiness publication");
		const code = ts.transpileModule(`return async () => {${statements.slice(first).map(node => node.getText(tree)).join("\n")}};`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
		for (const outcome of ["inconclusive", "certified", "revoked", "native-failure"] as const) {
			const events: string[] = [], identity = {}, application = {}, program = {}, reader = () => undefined,
				windowLimits = {maxAdditionalLocalRows: 5, maxAdditionalReceivedRows: 128}, windowApplication = {byteLength: 10240, items: 4096, maxDepth: 8};
			const frame = {alive: true, headerConsumersRevoked: false, accounting: {}}, source: any = {identity, capacity: {}}, geometry = {};
			const certificate = {ordinaryProofEnvelopeByteLength: 100, fullFutureProofEnvelopeByteLengths: [200]},
				selected = outcome === "certified" ? {limits: {...windowLimits, maxAdditionalLocalRows: 1}, certificate} : undefined;
			const bindings = {source, frame, windowLimits, windowApplication, windowObservation: {}, geometry, application,
				preparation: {current: {runtime: {epoch: 3}}}, options: {reader},
				derived: {program, commit() {events.push("commit"); source.capacity.template = program;}},
				proofMaterialOwners: new Map([[frame.accounting, {captureKnownResourceTotals: () => ({unknownEncodedBytes: 7})}]]),
				selectCreatorOrdinaryFinishingWindowForSizing: () => {events.push("select"); return selected;},
				check: async () => {events.push("fresh-check"); if (outcome === "revoked") frame.alive = false;
					if (outcome === "native-failure") throw Error("original-native-delivery-failure");}};
			const run = new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings;\n${code}`)(bindings);
			// The owner now stages its publication and returns it; the caller
			// publishes only after its own complete delivery. Nothing is visible before.
			let publish: unknown;
			if (outcome === "native-failure") await expect(run()).rejects.toThrow("original-native-delivery-failure");
			else publish = await run();
			expect(source.capacity).toEqual({}); expect(events).toEqual(["select", "fresh-check"]);
			if (outcome === "revoked" || outcome === "native-failure") {
				expect(publish).toBeUndefined();
			} else {
				expect(typeof publish).toBe("function"); (publish as () => void)();
				expect(events).toEqual(["select", "fresh-check", "commit"]);
				expect(source.capacity.template).toBe(program); expect(source.capacity.application).toBe(application);
				expect(source.capacity.readiness.sourceIdentity).toBe(identity); expect(source.capacity.readiness.geometry).toBe(geometry);
				expect(source.capacity.readiness.window).toMatchObject({declaredLimits: windowLimits, application: windowApplication,
					priorUnknownByteLength: 7, acceptedActions: 0, acceptedOperationBytes: 0, acceptedPreimageBytes: 0, acceptedEpochVertexBytes: 0});
				expect(source.capacity.readiness.window.limits).toEqual(selected?.limits ?? windowLimits);
				expect(source.capacity.readiness.window.certificate).toBe(selected?.certificate);
			}
		}
	});
	it("retains all original NONE and V1 eligibility refusals instead of authorizing from a profile", () => {
		const changes: ((facts: any) => void)[] = [f => {f.current.runtime.profileId = "other";},
			f => {f.current.runtime.pendingIngressCount = 1;}, f => {f.current.runtime.pendingIngressBytes = 1;},
			f => {f.current.runtime.drainingPendingIngress = true;}, f => {f.current.candidate.control = true;},
			f => {f.proofFacts.capture.nativeIssuance.rows.lineages.push({pendingUnsigned: {}});},
			f => {f.sourceFacts.material.installedPromotionSource = {};}, f => {f.proofFacts.capture.ahe.control = {nominee: {}};},
			f => {f.proofFacts.capture.ahe.control = {completed: {generationDrain: {phase: "pending"}}};},
			f => {f.applicationResource.value.items = 16385;}, f => {f.applicationResource.value.maxDepth = 17;},
			f => {f.applicationResource.value.byteLength = 65537;}];
		for (const fenceCount of [0, 1] as const) for (const change of changes) {
			const f = fixture(fenceCount), facts = f.resolve(f.facts, f.bytes, f.options); change(facts);
			expect(f.eligible(facts, f.options)).toBe(false);
		}
		const none = fixture(0); none.facts.proofFacts.capture.nativeIssuance.rows.plans.push({} as never);
		expect(none.eligible(none.facts, none.options)).toBe(false);
		const v1 = fixture(), facts = v1.resolve(v1.facts, v1.bytes, v1.options);
		facts.proofFacts.capture.nativeIssuance.rows.plans.push({scope: {objectId: "foreign"}, entries: [{sourceOrigin: "retained"}]});
		expect(v1.eligible(facts, v1.options)).toBe(true); // Producer proves terminality, not this numeric predicate.
	});
	it("passes complete old plans, foreign PRE/outbox and plan scopes to the original native width owners without mutation", () => {
		const f = fixture(), facts = f.resolve(f.facts, f.bytes, f.options), scope = {objectId: "room", author: "1".repeat(64)},
			foreign = {...scope, author: "2".repeat(64)}, planOnly = {...scope, author: "3".repeat(64)};
		const canonicalPreimageBytes = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: "room", author: foreign.author,
			authorSequence: 0, epoch: 3, anchor: "a".repeat(64), dependencies: [], logicalTime: 0,
			operation: {action: "placeBlock", payload: "full-foreign-PRE-".repeat(128)}});
		const issued = {...foreign, authorSequence: 0, canonicalPreimageBytes, digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
			signature: new Uint8Array(64)};
		const rows = {lineages: [{...scope, next: 0, exhausted: false, prunedThroughAuthorSequence: null},
			{...foreign, next: 1, exhausted: false, prunedThroughAuthorSequence: null},
			{...planOnly, next: 0, exhausted: false, prunedThroughAuthorSequence: null}], issued: [issued],
			outbox: [{...foreign, authorSequence: 0, digest: issued.digest, publishState: "pending" as const}],
			plans: [{scope, revision: 0, fenceSequence: null, entries: []},
				{scope: foreign, revision: 0, fenceSequence: null, entries: [{sourceSequence: 0, sourceDigest: issued.digest,
					disposition: "expire" as const, replacementSequence: null}]},
				{scope: planOnly, revision: 0, fenceSequence: null, entries: []}]};
		facts.proofFacts.capture.nativeIssuance = {rows, control: null};
		Object.assign(facts.current.runtime, {objectId: "room", epoch: 3, anchorDigest: "a".repeat(64), issuanceScope: scope});
		// 1515daab: the native owner also reads the registered epoch-vertex domain
		// for source custody sizing (a controlled premise here, see execute()).
		Object.assign(facts.current, {nativeCounts: {currentJournalRows: 1}, candidate: {exactCanonicalEpochVertexBytes: Uint8Array.of(5)},
			parameters: {maxEpochVertices: 8192}});
		let request: any;
		Object.assign(facts.proofFacts.runtime, {readCapacityLeafWidths: () => ({canonicalPreimageByteLength: 127, canonicalEpochVertexByteLength: 128}),
			readCapacityWidths: (input: unknown) => {request = input; return {currentClose: 10, successorReserved: 20, successorEntered: 30, successorFinal: 40};}});
		const native = execute<(facts: any, bytes: Uint8Array, frames: any[]) => any>(
			["creatorOrdinaryResourceNativeCapacityForSizing"], "creatorOrdinaryResourceNativeCapacityForSizing",
			{issuanceOrdinaryFinishingCapacityWidths});
		const before = encodeCanonical(rows), result = native(facts, f.bytes, []);
		expect(request.successorFenceCount).toBe(1); expect(request.successorFencePreimageByteLength).toBe(512);
		expect(request.maxDebtDescriptors).toBe(3); expect(request.maxIssuerDescriptors).toBe(1);
		expect(result.preimage).toBe(512); expect(request.maxAdditionalCurrentJournalRows).toBe(1);
		expect(request.canonicalEpochVertexByteLength).toBe(1);
		expect(encodeCanonical(rows)).toEqual(before);
		// 974f78d0/3a28ab80: local work also reserves the retained adoption fences.
		const expected = issuanceOrdinaryFinishingCapacityWidths({rows, scope, control: null,
			maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: 512, successorFenceCount: 1, adoptionReserveFenceCount: 2});
		expect(result.issuance).toEqual(expected); // Old foreign PRE, debt and plans remain exact, not a future-row maximum.
		facts.current.runtime.kind = "received-append";
		const received = native(facts, f.bytes, []);
		expect(received.issuance).toEqual(issuanceOrdinaryFinishingCapacityWidths({rows, scope, control: null,
			maxAdditionalCurrentIssued: 0, maxCanonicalPreimageByteLength: 512, successorFenceCount: 1, adoptionReserveFenceCount: 0}));
		expect(received.issuance.ordinaryFinal.rowCount).toBe(result.issuance.ordinaryFinal.rowCount - 2);
		expect(received.issuance.ordinaryFinal.canonicalRowsBytes).toBeLessThan(result.issuance.ordinaryFinal.canonicalRowsBytes);
		expect(received.issuance.successorFinal.rowCount).toBe(received.issuance.ordinaryFinal.rowCount + 2);
		expect(encodeCanonical(rows)).toEqual(before);
		facts.current.runtime.kind = "local-issuance";
		const largerPreimage = encodeCanonical({...decodeCanonical(canonicalPreimageBytes) as Record<string, unknown>,
			operation: {action: "placeBlock", payload: "full-foreign-PRE-".repeat(128) + "x".repeat(1000)}}),
			largerDigest = hashDomain("ts-drp/vertex/v3", largerPreimage),
			largerRows = {...rows, issued: [{...issued, canonicalPreimageBytes: largerPreimage, digest: largerDigest}],
				outbox: rows.outbox.map(row => ({...row, digest: largerDigest})),
				plans: rows.plans.map(plan => ({...plan, entries: plan.entries.map(entry => ({...entry, sourceDigest: largerDigest}))}))};
		facts.proofFacts.capture.nativeIssuance = {rows: largerRows, control: null};
		const larger = native(facts, f.bytes, []);
		expect(larger.preimage).toBe(512);
		expect(larger.issuance.ordinaryFinal.canonicalRowsBytes - result.issuance.ordinaryFinal.canonicalRowsBytes).toBe(1000);
		expect(result.issuance.successorPending.nativeCensusBytes).toBeGreaterThan(result.issuance.ordinaryFinal.nativeCensusBytes);
		expect(result.issuance.canonicalRowsShape.successorPending.items).toBeGreaterThan(result.issuance.canonicalRowsShape.ordinaryFinal.items);
		// A symbolic boundary sample is not an entitlement. Each genuine quote
		// supplies its actual NEW candidate and independently wider genuine fence.
		const wideCandidate = new Uint8Array(16_384);
		facts.settlementCapacity.canonicalSuccessorFencePreimageByteLength = 32_768;
		const wide = native(facts, wideCandidate, []);
		expect(request.canonicalPreimageByteLength).toBe(32_768);
		expect(request.successorFencePreimageByteLength).toBe(32_768);
		expect(wide.issuance).toEqual(issuanceOrdinaryFinishingCapacityWidths({rows: largerRows, scope, control: null,
			maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: 32_768, successorFenceCount: 1, adoptionReserveFenceCount: 2}));
		expect(wide.issuance.ordinaryFinal.canonicalRowsBytes).toBeGreaterThan(larger.issuance.ordinaryFinal.canonicalRowsBytes);
	});
	it("replays the captured E3 refusal and fixes only the impossible NEW protected-prefix plan", () => {
		// Exact immutable numerical input captured from the original native failure.
		// This is a resource-law regression, not a signature/native-currency grant
		// or conformance claim for the newly compiled complete candidate.
		const fixture=JSON.parse(readFileSync(new URL("./fixtures/creator-ordinary-e3-resource-program.json",import.meta.url),"utf8")) as {
			program:Parameters<typeof evaluateCreatorNoneResourceProgramForSizing>[0]; parameters:[string,number][];
			newPlanNode:number;classifiedPlanNode:number;wrapperNode:number;originalWrapperBytes:number};
		const parameters=new Map(fixture.parameters),before=encodeCanonical(fixture.program);
		expect(evaluateCreatorNoneResourceProgramForSizing(fixture.program,parameters)).toBeUndefined();
		expect(fixture.originalWrapperBytes).toBe(2117228);
		const full=fixture.program.nodes[fixture.newPlanNode]!,projected=fixture.program.nodes[fixture.classifiedPlanNode]!;
		expect(full.kind).toBe("sum");expect(projected.kind).toBe("sum");
		if(full.kind!=="sum"||projected.kind!=="sum")throw Error("recorded original plan shape changed");
		expect(full.children).toHaveLength(projected.children.length);
		expect(full.children.filter((node,index)=>node!==projected.children[index])).toHaveLength(1);
		const program={...fixture.program,nodes:fixture.program.nodes.map((node,index)=>index===fixture.newPlanNode?projected:node),
			outputs:{...fixture.program.outputs,"captured.wrapper":fixture.wrapperNode}};
		const result=evaluateCreatorNoneResourceProgramForSizing(program,parameters);
		expect(result).toBeDefined();
		expect(result!.get("captured.wrapper")).toBeLessThanOrEqual(2097152);
		expect(result!.get("envelope.1")).toBe(4076517);
		for(const index of [0,1,2,3])expect(result!.get(`envelope.${index}`)).toBeLessThanOrEqual(4194304);
		expect(parameters.get("journal.rows.bytes")).toBe(664607); // Complete physical vector is not projected.
		expect(parameters.get("ordinary.nativeUnknown")).toBe(35251);
		expect(parameters.get("ordinary.runtimeUnknown")).toBe(99209);
		expect(encodeCanonical(fixture.program)).toEqual(before);
		expect(builderExpression("semanticJournalProgress")).toContain("plan: journalPlan");
	});
	it("retains the complete old resumable journal plan when the NEW plan projection is smaller", () => {
		const objectId="room",digest="a".repeat(64),author="b".repeat(64),scope={objectId,epoch:0,anchorDigest:digest};
		const baseControl={kind:"v3-live-journal-retirement-control-2",objectId,incarnation:digest,revision:1,sequence:1,
			active:null,completed:{throughEpoch:1,decisionDigest:digest,sourceProofDigest:digest,protectedScopes:[]},drain:null};
		const rows=Array.from({length:129},(_,index)=>({journalSequence:index,vertexDigest:digest,author,authorSequence:index,nativeFrameDigest:digest}));
		const plan={baseControl,sourceImage:{imageDigest:digest,scopeCount:1,rowCount:rows.length,byteCharge:100000},
			prefixes:[{scope,highWatermark:rows.length,rows}]};
		const old=captureJournalRetirementControl({...baseControl,revision:2,
			drain:{plan,cursor:0,batches:0,residualImageDigest:digest}}),before=encodeCanonical(old);
		const compiler=createCreatorNoneResourceProgramCompiler(),backend=compiler.backend(limits),
			actual=(value:unknown)=>canonicalValueResourceForSizing(value,128,limits,"exact"),
			fields=Object.fromEntries(Object.entries(old).map(([key,value])=>[key,actual(value)]));
		const bindings={maximum:backend.maximum,record:backend.record,semanticJournalProgress:backend.bytes(512),
			baseFields:[undefined,fields],integer:backend.primitive(Number.MAX_SAFE_INTEGER)};
		const js=ts.transpileModule(`return ${builderExpression("journalControl")};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
		const width=new Function("bindings",`const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		const completeOld=actual({...old,revision:Number.MAX_SAFE_INTEGER,sequence:Number.MAX_SAFE_INTEGER});
		expect(width).toEqual(completeOld);
		expect(width.byteLength).toBeGreaterThan(bindings.semanticJournalProgress.byteLength);
		expect(encodeCanonical(old)).toEqual(before);
		expect(old.drain?.plan.prefixes[0]?.rows).toHaveLength(129);
	});
	it("refreshes the original journal-wrapper programme constraint for a wide real NEW leaf, rather than inheriting a historical sample", () => {
		// Controlled native geometry, not native authority. Execute the actual
		// enclosing/drain wrapper expressions and original compiler/evaluator.
		// OLD rows remain in both wrappers; only the independently input NEW leaf changes.
		const compiler = createCreatorNoneResourceProgramCompiler(), backend = compiler.backend(limits),
			oldRows = canonicalValueResourceForSizing([new Uint8Array(648_000)], 128, limits, "exact"),
			seed = canonicalArrayResourcesForSizing([oldRows, canonicalBytesResourceForSizing(512, limits)], limits),
			parameters = (rows: any) => new Map([["journal.rows.bytes", rows.byteLength], ["journal.rows.items", rows.items], ["journal.rows.depth", rows.maxDepth]]),
			bindings = {capture: {journal: {}}, nil: backend.primitive(null), completed: [undefined, backend.bytes(128)],
				actual: (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact"), maximum: backend.maximum, record: backend.record,
				journalImage: backend.bytes(64), journalControl: backend.bytes(790_000), journal: {canonicalRows: seed},
				inputResource: (name: string, value: any) => compiler.inputResource(name, value)};
		const js = ts.transpileModule(["journalDrainSource", "journalWrapper"].map(name => `const ${name}=${builderExpression(name)};`).join("\n"),
			{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			wrapper = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js};return journalWrapper;`)(bindings);
		compiler.limit(compiler.references(wrapper).byteLength, 2_097_152, 1);
		compiler.outputResource("wrapper", wrapper); const program = compiler.finish();
		expect(evaluateCreatorNoneResourceProgramForSizing(program, parameters(seed))?.get("wrapper.bytes")).toBeLessThan(2_097_152);
		const actualSmallCandidate = canonicalArrayResourcesForSizing([oldRows, canonicalBytesResourceForSizing(4096, limits)], limits),
			obsoleteHistoricalRectangle = canonicalArrayResourcesForSizing([oldRows, canonicalBytesResourceForSizing(7448, limits)], limits);
		expect(evaluateCreatorNoneResourceProgramForSizing(program, parameters(actualSmallCandidate))?.get("wrapper.bytes")).toBeLessThan(2_097_152);
		expect(evaluateCreatorNoneResourceProgramForSizing(program, parameters(obsoleteHistoricalRectangle))).toBeUndefined();
		const largerCandidateOrFence = canonicalArrayResourcesForSizing([oldRows, canonicalBytesResourceForSizing(32_768, limits)], limits);
		expect(evaluateCreatorNoneResourceProgramForSizing(program, parameters(largerCandidateOrFence))).toBeUndefined();
		expect(source).toContain("[journalWrapper, LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, 65_536, 128]");
	});
	it("keeps one complete future leaf and independent byte/item/depth maxima, without merging separate native jobs; NONE adds zero", () => {
		const future = execute<(facts: any, native: any, frame: number) => any>(
			["creatorOrdinaryFutureNativeResourceForSizing"], "creatorOrdinaryFutureNativeResourceForSizing", {
				canonicalBytesResourceForSizing, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes, maintenanceWidthSum: sum,
			});
		const native = {fencePreimage: 512, issuance: {
			ordinaryFinal: {canonicalRowsBytes: 100, nativeCensusBytes: 110}, successorPending: {canonicalRowsBytes: 200, nativeCensusBytes: 210},
			successorFinal: {canonicalRowsBytes: 180, nativeCensusBytes: 190},
			canonicalRowsShape: {ordinaryFinal: {items: 10, maxDepth: 4}, successorPending: {items: 30, maxDepth: 6}, successorFinal: {items: 20, maxDepth: 7}}},
			runtimeWidths: {successorReserved: 11, successorEntered: 12, successorFinal: 13}};
		const none = future({current: {successorFenceCount: 0}}, native, 0);
		expect(none).toEqual({rows: {byteLength: 100, items: 10, maxDepth: 4}, unionRows: {byteLength: 100, items: 10, maxDepth: 4}, futureLeaf: 0});
		const v1 = future({current: {successorFenceCount: 1}}, native, 99), width = (length: number) => canonicalBytesResourceForSizing(length, limits).byteLength;
		expect(v1.rows).toEqual({byteLength: 200, items: 30, maxDepth: 7});
		// The union-limited census point image holds FINAL rows only (ordinaryFinal or successorFinal).
		expect(v1.unionRows).toEqual({byteLength: 180, items: 20, maxDepth: 7});
		expect(v1.futureLeaf).toBe(width(512) + width(64) + width(32) + 99);
		for (const bytes of [127, 128, 16383, 16384]) expect(future({current: {successorFenceCount: 1}}, {...native, fencePreimage: bytes}, 99).futureLeaf)
			.toBeGreaterThanOrEqual(bytes);
		expect(() => future({current: {successorFenceCount: 1}}, {...native, fencePreimage: Number.MAX_SAFE_INTEGER}, 99)).toThrow();
	});
	it("keeps whole settlement-linked material and requires owned APP data rather than parsing authority", () => {
		expect(declaration("creatorOrdinaryApplicationResourceInput")).toContain("creatorOrdinaryApplicationResourceMaterialForSizing");
		const body = declaration("creatorOrdinaryApplicationResourceMaterialForSizing");
		expect(body).toContain('Object.hasOwn(value, "settlementSource")');
		expect(body).toContain("current.sourceLinkedApplicationEffects");
		expect(body).toContain("sourceFacts.sourceLinkedApplicationEffects");
		expect(body).toContain("compareBytes(row.exactCanonicalPreimageBytes, bytes) === 0");
		expect(body).toContain("matches.length === 0 || matches.some");
		expect(body).toContain("ordinary source-linked APP effect is unavailable");
		expect(body).toContain("captureKnownProtectedMaterial()");
		expect(body).toContain("native.outbox"); expect(body).toContain("current.pendingIngress");
		const combined = declaration("reserveCreatorOrdinaryFinishingCapacity");
		expect(combined).toContain("await owner.check()"); expect(combined).toContain("proof.accounting.chargedBytes !== chargedBytes");
		expect(combined).toContain("creatorOrdinaryCurrentDimensionStampMatchesForSizing");
		expect(combined).toContain("owner.frame.pending.add(task)");
	});
});

describe("candidate-free complete ordinary window certificate", () => {
	// Original compiler/evaluator, issuance codec and certificate function. The
	// prepared runtime/journal geometry and source authenticity are controlled
	// numerical premises; these fixtures confer no native or admission authority.
	function windowFixture(localCount = 2, receivedCount = 3) {
		const identity = {}, author = "b".repeat(64), anchor = "a".repeat(64), scope = {objectId: "window-room", author};
		const currentScope = {objectId: scope.objectId, epoch: 3, anchorDigest: anchor};
		const oldPreimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId,
			author, authorSequence: 0, epoch: 3, anchor, dependencies: [anchor], logicalTime: 1,
			operation: {action: "placeBlock", id: "old", kind: "stone", x: 1, y: 2}});
		const rows = {lineages: [{...scope, next: 1, exhausted: false, prunedThroughAuthorSequence: null}],
			issued: [{...scope, authorSequence: 0, canonicalPreimageBytes: oldPreimage,
				digest: hashDomain("ts-drp/vertex/v3", oldPreimage), signature: new Uint8Array(64)}],
			outbox: [{...scope, authorSequence: 0, digest: hashDomain("ts-drp/vertex/v3", oldPreimage), publishState: "published" as const}], plans: []};
		const native = {rows, control: null};
		const compiler = createCreatorNoneResourceProgramCompiler();
		const number = (key: string, value = 1) => compiler.inputNumber(key, value);
		for (const [key, value] of [["artifacts.anchor.bytes", 200], ["artifacts.chunkCount", 1], ["artifacts.payload.bytes", 300],
			["artifacts.manifest.bytes", 200], ["membership.bytes", 250]] as const) compiler.outputNumber(key, value);
		number("graph.count"); number("witness.count"); number("witness.payloadSum");
		compiler.inputResource("application", {byteLength: 100, items: 10, maxDepth: 2});
		const checkpoint = compiler.checkpoint();
		for (const [key, value] of [["signing.epochs", 1], ["signing.evidence", 1], ["signing.summary", 5]] as const) number(key, value);
		const material = Object.fromEntries(["currentTurnover", "closeAdopt", "successorJob", "serial", "cold"].map(phase =>
			[phase, number(`material.${phase}`, 1000)]));
		const ordinaryNative = number("ordinary.nativeUnknown"), ordinaryRuntime = number("ordinary.runtimeUnknown"),
			priorUnknown = number("material.priorUnknown"), newKnown = number("material.newKnown"), futureLeaf = number("settlement.futureLeaf");
		const pageCount = number("journal.group.0.pageCount", 1), received = number("journal.group.0.receivedCount", 0),
			payload = number("journal.group.0.receivedPayloadSum", 0), localPossible = number("journal.group.0.localPossible", 1);
		compiler.limit(localPossible, 1);
		const classifier = compiler.maximum(compiler.product(pageCount, 500), compiler.sum(compiler.product(received, 200), payload));
		for (const [index, phase] of ["closeAdopt", "serial", "successorJob", "cold"].entries())
			compiler.outputNumber(`envelope.${index}`, compiler.sum(material[phase]!, priorUnknown, newKnown,
				ordinaryNative, ordinaryRuntime, futureLeaf, classifier));
		const program = compiler.finish(), key = JSON.stringify([scope.objectId, 3, anchor]);
		const calls = {runtime: [] as any[], journal: [] as any[], currentJournal: [] as any[], issuance: [] as any[], evaluated: [] as Map<string, number>[], declines: [] as unknown[]};
		const runtimeProject = (request: any) => {
			calls.runtime.push(structuredClone(request));
			const value = 200 + request.futureRows.localCount * 50 + request.futureRows.receivedCount * 100 +
				request.futureRows.receivedPreimageBytes + request.futureRows.receivedEpochVertexBytes +
				(request.receivedPendingIngressByteLength ?? 0);
			return {currentClose: value, successorReserved: value + 10, successorEntered: value + 20, successorFinal: value + 30,
				runtimeCensusOverheadShape: Object.fromEntries(["currentClose", "successorReserved", "successorEntered", "successorFinal"].map(phase =>
					[phase, {items: 100, maxDepth: 6}]))};
		};
		const journalProjection = {snapshot: {scopeCount: 1, rowCount: 1,
			headerDrain: {count: 1, descriptors: {byteLength: 200, items: 12, maxDepth: 3}},
			currentHeader: {ordinal: 1, parametersByteLength: 2, sql: false},
			groups: [{scope: currentScope, count: 1, receivedCount: 0, receivedCanonicalPayloadSum: 0, pageable: true}]},
			quoteCurrent: (request: any) => {
				calls.currentJournal.push(structuredClone(request));
				const raw = 500 + request.maxAdditionalCurrentRows * 300 + request.futureRows.receivedPreimageBytes;
				return {scopeCount: 1, rowCount: 1 + request.maxAdditionalCurrentRows,
					canonicalRows: {byteLength: raw + 50, items: 1 + 2 * (2 + request.maxAdditionalCurrentRows), maxDepth: 1}};
			},
			quote: (request: any) => {
				calls.journal.push(structuredClone(request));
				const maximum = Math.max(request.canonicalPreimageByteLength, request.successorFencePreimageByteLength);
				const raw = 500 + request.maxAdditionalCurrentRows * 300 + request.futureRows.receivedPreimageBytes +
					request.successorFencePreimageByteLength + request.closedMembershipByteLength;
				return {scopeCount: 2, rowCount: 2 + request.maxAdditionalCurrentRows,
					canonicalRowByteLengthsTotal: raw, additionalFrameByteLength: maximum + 300,
					canonicalRows: {byteLength: raw + 50, items: 2 * (4 + request.maxAdditionalCurrentRows), maxDepth: 1},
					newHeaderFrame: {byteLength: 200, items: 20, maxDepth: 4}, successorFenceFrameByteLength: maximum + 300};
			}};
		const observation: any = {journal: {control: null, exactCanonicalControlCarriers: [], canonicalRows: [encodeCanonical(["old", 1])],
			image: {scopeCount: 1, rowCount: 1, imageDigest: "journal"}}, snapshot: {control: null, image: {chunkCount: 0}},
			ahe: {control: null}, floorImage: {control: null}, nativeIssuance: native, signingRows: []};
		const preparation: any = {current: {runtime: {objectId: scope.objectId, epoch: 3, anchorDigest: anchor,
			profileId: "creator-trusted-settlement-v1", issuanceScope: scope, graphVersion: 1, epochBytes: oldPreimage.byteLength,
			pendingIngressCount: 0, pendingIngressBytes: 0, drainingPendingIngress: false},
			parameters: {maxEpochVertices: 8192, maxEpochBytes: 8_388_608, snapshotChunkBytes: 131072},
			blueprint: {maxApplicationStateBytes: 65536, maxItems: 16384, maxDepth: 16},
			currentEpochVertexCount: 2, currentSignedPreimageByteLengths: [oldPreimage.byteLength], successorFenceCount: 1},
			nativeCapacity: {runtimeWidths: {project: runtimeProject}, receivedPreimages: [], preimage: 512, fencePreimage: 512}};
		const geometry: any = {graphVersion: 1, baseGraphCount: 2, basePreimageCount: 1,
			baseWitnessPayloadBytes: canonicalBytesResourceForSizing(oldPreimage.byteLength).byteLength,
			acceptedCount: 0, localIssuedCount: 0, acceptedWitnessPayloadBytes: 0,
			journalObservationFields: {control: {byteLength: 1, items: 1, maxDepth: 0}, image: {byteLength: 100, items: 20, maxDepth: 1},
				canonicalRows: {byteLength: 100, items: 3, maxDepth: 1}},
			journal: {projection: journalProjection, imageDigest: "journal", parametersBytes: encodeCanonical({}), canonicalRows: observation.journal.canonicalRows}};
		const profile: any = {sourceIdentity: identity, preparedMaterial: true, preparedParameters: compiler.captureParameters(), program,
			firstStageThroughNode: checkpoint, context: {objectId: scope.objectId, epoch: 3, anchorDigest: anchor,
				profileId: "creator-trusted-settlement-v1", snapshotChunkBytes: 131072},
			preparedSigning: {rows: [], control: null}, journalScopeKeys: [key], sourceBasis: {generationCount: 3,
				physicalSnapshotCount: 1, protectedSnapshotCount: 1, recoveryScopes: 0, retiredSnapshotCount: 0,
				recoveryContentBytes: 0, retiredSnapshotContentBytes: 0, maxRecoveryScopes: 10, maxRecoveryContentBytes: 1_000_000}};
		const sourceFacts: any = {identity, nativeIssuance: native, head: {revision: 1}, knownProtectedMaterial: [oldPreimage],
			material: {installedPromotionSource: null}, capacity: {material: {project: () => ({whole: 1000, protected: 800}),
				projectAdmission: () => ({whole: 900, protected: 800})}}, maintenanceResourceFacts: {ordinaryJournalReplayScopes: []}};
		const window = {maxAdditionalActions: 16, maxAdditionalOperationBytes: 5000,
			maxAdditionalLocalRows: localCount, maxAdditionalReceivedRows: receivedCount,
			maxAdditionalPreimageBytes: 2000, maxAdditionalEpochVertexBytes: 1500,
			maxCanonicalOperationByteLength: 512, maxCanonicalPreimageByteLength: 1024, maxCanonicalEpochVertexByteLength: 768,
			maxSuccessorFencePreimageByteLength: 2048, maxReceivedPendingIngressByteLength: 300,
			maxApplicationBytes: 512, maxApplicationItems: 64, maxApplicationDepth: 4};
		const run = execute<(input: any) => any>(["creatorOrdinarySizingRecord", "creatorOrdinaryFinishingLifetimeMaterialForSizing",
			"creatorOrdinaryPreparedDescriptorGroupsForSizing", "creatorOrdinaryJournalScopeCollectibleForSizing",
			"creatorOrdinaryFutureNativeResourceForSizing", "creatorOrdinaryAssertCounterHorizon", "prepareCreatorOrdinaryFinishingWindowForSizing"],
			"prepareCreatorOrdinaryFinishingWindowForSizing", {compareBytes, encodeCanonical, closedRetirementBytes: encodeCanonical,
				globalThis: {__warmProofEvent: (event: unknown) => calls.declines.push(event)},
				closedRetirementEqual: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
				canonicalBytesResourceForSizing, canonicalRecordResourceForSizing,
				canonicalPrimitiveResourceForSizing: (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact"),
				maintenanceWidthSum: sum, issuanceOrdinaryFinishingCapacityWidths: (request: Parameters<typeof issuanceOrdinaryFinishingCapacityWidths>[0]) => {
					calls.issuance.push(structuredClone(request)); return issuanceOrdinaryFinishingCapacityWidths(request);
				}, LIVE_JOURNAL_RETIREMENT_LIMITS,
				creatorOrdinaryPreimageResourceGeometryForSizing,
				closedJournalNativeControlCarriers: (value: any) => value.control === null ? [encodeCanonical(null)] : value.exactCanonicalControlCarriers,
				creatorOrdinaryJournalRawSupplementForSizing: () => 0,
				evaluateCreatorNoneResourceProgramForSizing: (program: any, values: Map<string, number>, checkpoint?: number) => {
					if (checkpoint === undefined) calls.evaluated.push(new Map(values));
					return evaluateCreatorNoneResourceProgramForSizing(program, values, checkpoint);
				}, snapshotRetirementContract: {maxChunks: 100},
				snapshotQuarantineContract: {recoveryContentBytes: (payload: number, manifest: number) => payload + manifest},
				CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes});
		const input: any = {source: sourceFacts, preparation, observation, profile, geometry,
			application: {byteLength: 400, items: 40, maxDepth: 3}, limits: window,
			knownResourceTotals: {knownBytes: 1000, protectedBytes: 800, unknownEncodedBytes: 74}};
		return {run, input, calls};
	}
	it("window certificate operation-leaf correlation covers adversarial exact PRE/derivative schemas and variable batches at sixteen dependencies", () => {
		const author = "b".repeat(64), anchor = "a".repeat(64), maximum = Number.MAX_SAFE_INTEGER;
		const placement = (index: number, width: number) => ({action: "placeBlock", id: `块-${index}`, kind: "🧱".repeat(width),
			x: maximum - index, y: -maximum + index});
		const batch = (count: number, width: number) => ({action: "applicationBatch", batch: {version: 1,
			entries: Array.from({length: count}, (_, index) => ({logicalTime: maximum - count + index, operation: placement(index, width)}))}});
		const operations = [{action: "causalJoin"}, placement(1, 127), batch(2, 128), batch(16, 16),
			{action: "installRoster", roster: {entries: Array.from({length: 64}, (_, order) => ({
				author: order.toString(16).padStart(64, "0"), peerId: `peer-${order}`, order}))}},
			placement(2, 512), batch(2, 64), {action: "causalJoin"}];
		const encodedOperations = operations.map(operation => encodeCanonical(operation, {maxBytes: 9000, maxItems: 1024, maxDepth: 8}));
		const operationTotal = sum(encodedOperations.map(bytes => bytes.byteLength));
		expect(operationTotal).toBeLessThanOrEqual(32768);
		for (const objectId of ["r", "r".repeat(64), "r".repeat(256)]) {
			const probe = creatorOrdinaryPreimageResourceGeometryForSizing({objectId, author, anchor, canonicalOperationByteLength: 65_536})!;
			const preimageContext = probe.canonicalPreimageByteLength - 65_536, vertexContext = probe.canonicalEpochVertexByteLength - 65_536;
			for (const order of [operations.map((_, index) => index), operations.map((_, index) => operations.length - index - 1)]) {
				let actualPreimages = 0, actualVertices = 0;
				for (const index of order) {
					const dependencies = Array.from({length: 16}, (_, dependency) => dependency === 0 ? anchor : dependency.toString(16).padStart(64, "0"));
					const fields = {kind: "drp-vertex" as const, protocolMajor: 3, objectId, epoch: maximum, anchor, author,
						authorSequence: maximum - index, logicalTime: maximum - index, dependencies, operation: operations[index]!};
					const preimage = encodeCanonical(fields), vertex = encodeCanonical(creatorAuthenticatedEpochVertexFields({...fields, hash: "c".repeat(64)}));
					expect(readCreatorOrdinaryPreimageCapacityForSizing(preimage)).toBeDefined();
					expect(preimage.byteLength - encodedOperations[index]!.byteLength).toBe(preimageContext);
					expect(vertex.byteLength - encodedOperations[index]!.byteLength).toBe(vertexContext);
					actualPreimages += preimage.byteLength; actualVertices += vertex.byteLength;
				}
				expect(actualPreimages).toBe(operations.length * preimageContext + operationTotal);
				expect(actualVertices).toBe(operations.length * vertexContext + operationTotal);
			}
		}
	});
	it("window certificate intersects independently metered operation and PRE budgets for NEW subsets without shrinking OLD or fence material", () => {
		const f = windowFixture(8, 0);
		Object.assign(f.input.limits, {maxAdditionalOperationBytes: 32768, maxAdditionalPreimageBytes: 131072,
			maxAdditionalEpochVertexBytes: 131072, maxCanonicalOperationByteLength: 9000,
			maxCanonicalPreimageByteLength: 10000, maxCanonicalEpochVertexByteLength: 10000});
		const runtime = f.input.preparation.current.runtime;
		const geometry = creatorOrdinaryPreimageResourceGeometryForSizing({objectId: runtime.objectId, author: runtime.issuanceScope.author,
			anchor: runtime.anchorDigest, canonicalOperationByteLength: 65_536})!;
		const preimageContext = geometry.canonicalPreimageByteLength - 65_536;
		const old = encodeCanonical(f.input.observation.nativeIssuance.rows);
		const certificate = f.run(f.input);
		expect(certificate, JSON.stringify(f.calls.declines)).toBeDefined();
		expect(f.calls.issuance[0].maxAdditionalCurrentPreimageBytes).toBe(32768 + 8 * preimageContext);
		expect(f.calls.issuance[0].maxCanonicalPreimageByteLength).toBe(10000); // Existing independent leaf maximum.
		expect(f.calls.journal[0].successorFencePreimageByteLength).toBe(2048); // No future fence deduction.
		expect(encodeCanonical(f.input.observation.nativeIssuance.rows)).toEqual(old);
		const broad = windowFixture(8, 0); Object.assign(broad.input.limits, f.input.limits, {maxAdditionalOperationBytes: 72000});
		const originalRectangle = broad.run(broad.input);
		expect(originalRectangle).toBeDefined();
		expect(broad.calls.issuance[0].maxAdditionalCurrentPreimageBytes).toBe(80000);
		expect(certificate.ordinaryProofEnvelopeByteLength).toBeLessThan(originalRectangle.ordinaryProofEnvelopeByteLength);
		// The same correlation applies to received and whole-window RAW sums.
		const mixed = windowFixture(2, 3); Object.assign(mixed.input.limits, f.input.limits,
			{maxAdditionalLocalRows: 2, maxAdditionalReceivedRows: 3, maxAdditionalOperationBytes: 512});
		expect(mixed.run(mixed.input), JSON.stringify(mixed.calls.declines)).toBeDefined();
		const received = mixed.calls.runtime.find(call => call.receivedPendingIngressByteLength !== undefined).futureRows;
		expect(received.receivedPreimageBytes).toBe(512 + 3 * preimageContext);
		expect(received.receivedEpochVertexBytes).toBe(512 + 3 * (geometry.canonicalEpochVertexByteLength - 65_536));
	});
	it("window certificate separates all-local prefix paging from received prefixes and derives the fence ceiling from enforced operation geometry", () => {
		const f = windowFixture(), before = encodeCanonical(f.input.limits), certificate = f.run(f.input);
		const runtime = f.input.preparation.current.runtime;
		const fenceCeiling = creatorOrdinaryPreimageResourceGeometryForSizing({objectId: runtime.objectId,
			author: runtime.issuanceScope.author, anchor: runtime.anchorDigest,
			canonicalOperationByteLength: f.input.limits.maxCanonicalOperationByteLength})!.canonicalPreimageByteLength;
		expect(certificate, JSON.stringify(f.calls.declines)).toBeDefined(); expect(f.calls.runtime).toHaveLength(3); expect(f.calls.journal).toHaveLength(2);
		expect(f.calls.runtime[0].futureRows).toEqual({localCount: 2, receivedCount: 0, receivedPreimageBytes: 0,
			receivedEpochVertexBytes: 0, issuerDescriptorGrowth: 2});
		expect(f.calls.runtime[1].futureRows).toEqual({localCount: 2, receivedCount: 3, receivedPreimageBytes: 2000,
			receivedEpochVertexBytes: 1500, issuerDescriptorGrowth: 2});
		expect(f.calls.runtime[0]).not.toHaveProperty("receivedPendingIngressByteLength");
		expect(f.calls.runtime[1].receivedPendingIngressByteLength).toBe(300);
		expect(f.calls.runtime[2].futureRows).toEqual(f.calls.runtime[1].futureRows);
		expect(f.calls.runtime[2]).not.toHaveProperty("receivedPendingIngressByteLength");
		expect(fenceCeiling).toBeLessThan(2048);
		expect(f.calls.issuance.every(call => call.maxOrdinaryPreimageByteLength === 1024 && call.maxCanonicalPreimageByteLength === fenceCeiling)).toBe(true);
		expect(f.calls.journal.every(call => call.successorFencePreimageByteLength === fenceCeiling)).toBe(true);
		const [local, received] = f.calls.evaluated;
		expect(local!.get("journal.group.0.pageCount")).toBe(3); expect(local!.get("journal.group.0.localPossible")).toBe(1);
		expect(received!.get("journal.group.0.pageCount")).toBe(0); expect(received!.get("journal.group.0.localPossible")).toBe(0);
		expect(received!.get("journal.group.0.receivedCount")).toBe(3);
		expect(received!.get("material.priorUnknown")).toBe(74); expect(received!.get("settlement.fencePreimage")).toBe(fenceCeiling);
		expect(received!.get("application.bytes")).toBe(512); expect(received!.get("application.items")).toBe(64);
		expect(received!.get("application.depth")).toBe(4); // Declared cap, not the smaller boundary sample.
		for (const [index, width] of certificate.fullFutureProofEnvelopeByteLengths.entries()) {
			const exact = f.calls.evaluated.map(parameters => evaluateCreatorNoneResourceProgramForSizing(f.input.profile.program, parameters)!.get(`envelope.${index}`)!);
			expect(width).toBe(Math.max(...exact));
		}
		expect(certificate.nativeUnknownByteLength).toBeGreaterThan(2048);
		expect(certificate.ordinaryProofEnvelopeByteLength).toBeLessThanOrEqual(1_310_720);
		expect(encodeCanonical(f.input.limits)).toEqual(before); expect(Object.isFrozen(certificate)).toBe(true);
		expect(Object.values(certificate).every(value => typeof value === "number" || Array.isArray(value))).toBe(true);
	});
	it("covers the original complete scalar geometry and internal fence schema without treating arbitrary public control bytes as a fixed shape", () => {
		for (const objectId of ["room", "r".repeat(256)]) for (const operationMaximum of [1, 127, 128, 512, 2048, 16384, 65536]) {
			const author = "b".repeat(64), anchor = "a".repeat(64), maximum = Number.MAX_SAFE_INTEGER;
			const ceiling = creatorOrdinaryPreimageResourceGeometryForSizing({objectId, author, anchor,
				canonicalOperationByteLength: operationMaximum})!.canonicalPreimageByteLength;
			for (const dependencies of [[], [anchor], Array.from({length: 16}, (_, i) => i.toString(16).padStart(64, "0"))]) {
				// Original finishing constructor, including all registered PRE fields.
				const fence = {kind: "drp-vertex", protocolMajor: 3, objectId, author, anchor,
					epoch: maximum, authorSequence: maximum, logicalTime: maximum, dependencies,
					operation: {action: "$drp.author-fence.v1", fenceSequence: maximum, version: 1}};
				expect(encodeCanonical(fence).byteLength).toBeLessThanOrEqual(ceiling);
				const scalar = readCreatorOrdinaryPreimageCapacityForSizing(encodeCanonical(fence))!;
				expect(scalar.canonicalPreimageByteLength).toBeLessThanOrEqual(ceiling);
				const enlargedPublic = {...fence, operation: {...fence.operation, extra: "x".repeat(2000)}};
				const enlarged = readCreatorOrdinaryPreimageCapacityForSizing(encodeCanonical(enlargedPublic))!;
				expect(enlarged.canonicalPreimageByteLength).toBeGreaterThan(scalar.canonicalPreimageByteLength);
				// The actual reader charges all extra bytes even for a reserved
				// action; a smaller ordinary profile cannot hide them in the fixed
				// internal-constructor allowance. Actual admission meters are tested
				// independently by the existing whole-window refusal controls.
				if (operationMaximum <= 512) expect(enlarged.canonicalPreimageByteLength).toBeGreaterThan(ceiling);
			}
		}
		const baseline = windowFixture(), before = baseline.run(baseline.input);
		const broadDeclaration = windowFixture(); broadDeclaration.input.limits.maxSuccessorFencePreimageByteLength = 16384;
		const after = broadDeclaration.run(broadDeclaration.input);
		expect(after, JSON.stringify(broadDeclaration.calls.declines)).toEqual(before);
		const tooSmall = windowFixture(); tooSmall.input.limits.maxSuccessorFencePreimageByteLength = 1;
		expect(tooSmall.run(tooSmall.input)).toBeUndefined();
		expect(tooSmall.calls.declines).toContainEqual({kind: "ordinary-window-certificate-declined", reason: "window-fence-native-schema"});
	});
	it("window certificate separates current empty-ingress/local-issue geometry from complete future ingress/fence lifetimes", () => {
		const baseline = windowFixture(), before = baseline.run(baseline.input);
		expect(before, JSON.stringify(baseline.calls.declines)).toBeDefined();
		const future = windowFixture(); future.input.limits.maxReceivedPendingIngressByteLength += 1000;
		future.input.limits.maxSuccessorFencePreimageByteLength += 4096;
		const after = future.run(future.input);
		expect(after, JSON.stringify(future.calls.declines)).toBeDefined();
		expect(after.ordinaryProofEnvelopeByteLength).toBe(before.ordinaryProofEnvelopeByteLength);
		expect(after.nativeUnknownByteLength).toBe(before.nativeUnknownByteLength);
		expect(after.runtimeUnknownByteLength).toBe(before.runtimeUnknownByteLength);
		expect(after.fullFutureProofEnvelopeByteLengths.every((value: number, index: number) => value > before.fullFutureProofEnvelopeByteLengths[index])).toBe(true);
	});
	it("window certificate keeps current ordinary journal reads separate from complete close/adopt geometry without shrinking finishing lifetimes", () => {
		const baseline = windowFixture(), before = baseline.run(baseline.input);
		expect(before, JSON.stringify(baseline.calls.declines)).toBeDefined();
		expect(baseline.calls.currentJournal).toHaveLength(2);
		for (const [index, current] of baseline.calls.currentJournal.entries()) {
			const finishing = baseline.calls.journal[index]!;
			expect(current).toEqual({maxAdditionalCurrentRows: finishing.maxAdditionalCurrentRows,
				canonicalPreimageByteLength: finishing.canonicalPreimageByteLength,
				canonicalAuthorByteLength: finishing.canonicalAuthorByteLength, futureRows: finishing.futureRows});
			expect(current).not.toHaveProperty("closedMembershipByteLength");
			expect(current).not.toHaveProperty("successorFenceCount");
			expect(current).not.toHaveProperty("successorAnchorByteLength");
		}
		const future = windowFixture(), futureOwner = future.input.geometry.journal.projection;
		const quote = futureOwner.quote;
		futureOwner.quote = (request: any) => {
			const result = quote(request);
			return {...result, canonicalRows: {...result.canonicalRows, byteLength: result.canonicalRows.byteLength + 100_000}};
		};
		const after = future.run(future.input);
		expect(after, JSON.stringify(future.calls.declines)).toBeDefined();
		expect(after.ordinaryProofEnvelopeByteLength).toBe(before.ordinaryProofEnvelopeByteLength);
		expect(after.fullFutureProofEnvelopeByteLengths[0]).toBe(before.fullFutureProofEnvelopeByteLengths[0] + 100_000);
		expect(after.fullFutureProofEnvelopeByteLengths.slice(1)).toEqual(before.fullFutureProofEnvelopeByteLengths.slice(1));
		expect(after.nativeUnknownByteLength).toBe(before.nativeUnknownByteLength);
		expect(after.runtimeUnknownByteLength).toBe(before.runtimeUnknownByteLength);
		const current = windowFixture(), currentOwner = current.input.geometry.journal.projection;
		const quoteCurrent = currentOwner.quoteCurrent;
		currentOwner.quoteCurrent = (request: any) => {
			const result = quoteCurrent(request);
			return {...result, canonicalRows: {...result.canonicalRows, byteLength: result.canonicalRows.byteLength + 10_000}};
		};
		const enlarged = current.run(current.input);
		expect(enlarged, JSON.stringify(current.calls.declines)).toBeDefined();
		expect(enlarged.ordinaryProofEnvelopeByteLength).toBe(before.ordinaryProofEnvelopeByteLength + 10_000);
		expect(enlarged.fullFutureProofEnvelopeByteLengths).toEqual(before.fullFutureProofEnvelopeByteLengths);
	});
	it("window certificate keeps prior UNKNOWN/old resumable controls and protected growth in their original separate lifetimes", () => {
		const f = windowFixture(0, 3), before = f.run(f.input);
		expect(before, JSON.stringify(f.calls.declines)).toBeDefined();
		expect(f.calls.runtime.every(call => call.maxIssuerDescriptors === 1 && call.futureRows.issuerDescriptorGrowth === 0)).toBe(true);
		const changed = windowFixture(0, 3);
		changed.input.knownResourceTotals.unknownEncodedBytes += 200;
		const after = changed.run(changed.input);
		expect(after.ordinaryProofEnvelopeByteLength - before.ordinaryProofEnvelopeByteLength).toBe(200);
		expect(after.fullFutureProofEnvelopeByteLengths).toEqual(before.fullFutureProofEnvelopeByteLengths.map((width: number) => width + 200));
		const oldControl = {revision: 1, sequence: 0, active: null, completed: {resumeSource: new Uint8Array(8192)}};
		const resource = canonicalValueResourceForSizing(oldControl, 128, limits, "exact");
		changed.input.observation.journal.control = oldControl;
		changed.input.observation.journal.exactCanonicalControlCarriers = [encodeCanonical(oldControl)];
		changed.input.geometry.journalObservationFields.control = resource;
		const retained = changed.run(changed.input);
		expect(retained.ordinaryProofEnvelopeByteLength).toBeGreaterThan(after.ordinaryProofEnvelopeByteLength + 8192);
		for (const parameters of changed.calls.evaluated.slice(-2)) {
			expect(parameters.get("material.closeAdopt")).toBeGreaterThan(parameters.get("material.serial")! + 8192);
			expect(parameters.get("ordinary.signatureUnknown")).toBe(0);
		}
	});
	it("window certificate declines missing geometry, changed source/signing, exhausted counters and malformed/oversized budgets without effects", () => {
		for (const change of [
			(f: ReturnType<typeof windowFixture>) => {f.input.geometry.journal = undefined;},
			(f: ReturnType<typeof windowFixture>) => {f.input.profile.sourceIdentity = {};},
			(f: ReturnType<typeof windowFixture>) => {f.input.profile.preparedSigning.rows = [Uint8Array.of(1)];},
			(f: ReturnType<typeof windowFixture>) => {f.input.limits.maxAdditionalPreimageBytes = Number.MAX_SAFE_INTEGER;},
			(f: ReturnType<typeof windowFixture>) => {f.input.limits.maxSuccessorFencePreimageByteLength = 0;},
			(f: ReturnType<typeof windowFixture>) => {f.input.application.items = 16385;},
			(f: ReturnType<typeof windowFixture>) => {f.input.application.byteLength = 513;},
			(f: ReturnType<typeof windowFixture>) => {f.input.application.items = 65;},
			(f: ReturnType<typeof windowFixture>) => {f.input.application.maxDepth = 5;},
			(f: ReturnType<typeof windowFixture>) => {f.input.observation.journal.control = {revision: Number.MAX_SAFE_INTEGER, sequence: 0, active: null};},
		]) {
			const f = windowFixture(); change(f); expect(f.run(f.input)).toBeUndefined();
		}
		let accessed = 0;
		const accessor = windowFixture(); Object.defineProperty(accessor.input.limits, "maxAdditionalActions", {enumerable: true, get() {accessed++; return 16;}});
		expect(accessor.run(accessor.input)).toBeUndefined(); expect(accessed).toBe(0); expect(accessor.calls.runtime).toHaveLength(0);
		const f = windowFixture(), first = f.run(f.input), saved = structuredClone(first);
		f.input.limits.maxAdditionalPreimageBytes = 500; f.input.application.byteLength = 50;
		expect(first).toEqual(saved); // No mutable declaration/profile/owner is retained.
	});
	it("selects a fully certified effective window only at the boundary, retaining OLD/UNKNOWN and coherent enforced aggregate caps", () => {
		const f = windowFixture(); f.input.limits.maxAdditionalOperationBytes = 1000;
		const declared = structuredClone(f.input.limits), old = encodeCanonical(f.input.observation);
		const upper = f.run(f.input), base = f.run({...f.input, limits: {...declared, maxAdditionalReceivedRows: 0}});
		expect(upper).toBeDefined(); expect(base).toBeDefined();
		const pressure = 900 + 1_310_720 - Math.ceil((upper.ordinaryProofEnvelopeByteLength + base.ordinaryProofEnvelopeByteLength) / 2);
		f.input.source.capacity.material.projectAdmission = () => ({whole: pressure, protected: 800});
		const probes: any[] = [], certificates = new Map<object, object>();
		const select = execute<(input: any) => any>(["selectCreatorOrdinaryFinishingWindowForSizing"],
			"selectCreatorOrdinaryFinishingWindowForSizing", {captureCreatorOrdinaryFinishingWindowLimitsForSizing,
				prepareCreatorOrdinaryFinishingWindowForSizing: (input: any) => {
					probes.push(input.limits); const certificate = f.run(input);
					if (certificate !== undefined) certificates.set(certificate, input.limits);
					return certificate;
				}});
		const chosen = select(f.input);
		expect(chosen).toBeDefined();
		expect(chosen.limits.maxAdditionalReceivedRows).toBeLessThanOrEqual(declared.maxAdditionalReceivedRows);
		expect(chosen.limits.maxAdditionalReceivedRows).toBeGreaterThanOrEqual(0);
		expect(chosen.limits.maxAdditionalLocalRows).toBeGreaterThanOrEqual(1);
		expect(chosen.limits.maxAdditionalLocalRows).toBeLessThan(declared.maxAdditionalLocalRows);
		expect(certificates.get(chosen.certificate)).toBe(chosen.limits); // Never a certificate from another probe.
		expect(chosen.certificate.ordinaryProofEnvelopeByteLength).toBeLessThanOrEqual(1_310_720);
		expect(chosen.certificate.fullFutureProofEnvelopeByteLengths.every((width: number) => width <= 4_194_304)).toBe(true);
		for (const key of Object.keys(declared)) expect(chosen.limits[key]).toBeLessThanOrEqual(declared[key]);
		const selectedRows = chosen.limits.maxAdditionalLocalRows + chosen.limits.maxAdditionalReceivedRows,
			declaredRows = declared.maxAdditionalLocalRows + declared.maxAdditionalReceivedRows;
		expect(selectedRows).toBeLessThan(declaredRows);
		for (const key of ["maxAdditionalActions", "maxAdditionalOperationBytes", "maxAdditionalPreimageBytes", "maxAdditionalEpochVertexBytes"])
			expect(chosen.limits[key]).toBe(Math.max(1, Math.floor(declared[key] * selectedRows / declaredRows)));
		for (const key of ["maxCanonicalOperationByteLength", "maxCanonicalPreimageByteLength", "maxCanonicalEpochVertexByteLength",
			"maxSuccessorFencePreimageByteLength", "maxReceivedPendingIngressByteLength", "maxApplicationBytes", "maxApplicationItems", "maxApplicationDepth"])
			expect(chosen.limits[key]).toBe(declared[key]);
		expect(probes.length).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(declaredRows)));
		expect(encodeCanonical(f.input.observation)).toEqual(old); expect(f.input.limits).toEqual(declared);
		expect(Object.isFrozen(chosen)).toBe(true); expect(Object.isFrozen(chosen.limits)).toBe(true);
		f.input.limits.maxAdditionalReceivedRows = 1;
		expect(chosen.limits).toEqual(certificates.get(chosen.certificate));
	});
	it("does not activate any effective window when even one complete new row cannot be certified", () => {
		const f = windowFixture(); f.input.limits.maxAdditionalOperationBytes = 1000;
		f.input.source.capacity.material.projectAdmission = () => ({whole: 1_310_720, protected: 800});
		let probes = 0;
		const select = execute<(input: any) => any>(["selectCreatorOrdinaryFinishingWindowForSizing"],
			"selectCreatorOrdinaryFinishingWindowForSizing", {captureCreatorOrdinaryFinishingWindowLimitsForSizing,
				prepareCreatorOrdinaryFinishingWindowForSizing: (input: any) => {probes++; return f.run(input);}});
		expect(select(f.input)).toBeUndefined(); expect(probes).toBe(2);
		let accessed = 0;
		Object.defineProperty(f.input.limits, "maxAdditionalActions", {enumerable: true, get() {accessed++; return 16;}});
		expect(select(f.input)).toBeUndefined(); expect(accessed).toBe(0); expect(probes).toBe(2);
	});
});
