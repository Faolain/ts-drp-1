import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing, canonicalRecordResourceForSizing,
	canonicalArrayResourceForSizing, canonicalArrayResourcesForSizing, canonicalValueResourceForSizing} from "@ts-drp/canonical/resource";
import {captureJournalRetirementDrainPlan} from "../../live-journal/src/retirement.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Actual original classifier loop/guard and shared scalar/program expressions.
// These are resource/branch controls, not membership, signature or native grants.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const node = tree.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === name);
	if (!node) throw new Error(`missing original owner: ${name}`); return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128};
const original = execute<{compiler(): any; evaluate(program: any, parameters: Map<string, number>): Map<string, number> | undefined;
	book(initial: any[]): any; nonlocal(rows: Uint8Array[], scope: any): boolean;
	groups(frames: any[], currentKey: string, additional: any): Map<string, {count:number;receivedFrameByteLengths:number[];pageCount:number;localPossible:boolean}>;
	prepared(projection:any,currentKey:string,additional:any):Map<string,any>; classifierResult(input:any,compiler?:any):any;
	collectible(source:any,key:string):0|1; replay(input:any):any; fullReplay(input:any):any; retained(cuts:any[],epoch:number):any[]}>(`
	${["maintenanceWidthSum", "maintenanceVarUintWidth", "creatorCanonicalCapacityForSizing", "createCreatorNoneResourceProgramCompiler",
		"evaluateCreatorNoneResourceProgramForSizing", "closedJournalScopeHasNonLocalRows", "createCreatorClosedRollbackProofAccounting",
		"creatorOrdinaryJournalDescriptorGroupsForSizing", "creatorOrdinaryPreparedDescriptorGroupsForSizing",
		"creatorOrdinaryJournalClassifierResultCapacityForSizing", "creatorOrdinaryJournalScopeCollectibleForSizing", "closedJournalProtectedReplayScopes",
		"creatorFinishingRetainedSummaryCutsForSizing", "creatorFinishingCanProjectJournalReplayForSizing", "creatorFinishingKnownJournalReplayScopesForSizing"].map(declaration).join("\n")}
	return {compiler:createCreatorNoneResourceProgramCompiler,evaluate:evaluateCreatorNoneResourceProgramForSizing,
	 book:createCreatorClosedRollbackProofAccounting,nonlocal:closedJournalScopeHasNonLocalRows,groups:creatorOrdinaryJournalDescriptorGroupsForSizing,
	 prepared:creatorOrdinaryPreparedDescriptorGroupsForSizing,classifierResult:creatorOrdinaryJournalClassifierResultCapacityForSizing,
	 collectible:creatorOrdinaryJournalScopeCollectibleForSizing,replay:creatorFinishingKnownJournalReplayScopesForSizing,
	 fullReplay:closedJournalProtectedReplayScopes,retained:creatorFinishingRetainedSummaryCutsForSizing};`, {
	CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limits.maxBytes, CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720,
	LIVE_JOURNAL_RETIREMENT_LIMITS: {maxRows: 8192},
	canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing, canonicalRecordResourceForSizing,
	canonicalArrayResourceForSizing, canonicalArrayResourcesForSizing, decodeCanonical, compareBytes,
	closedRetirementEqual: (a: unknown,b: unknown) => compareBytes(encodeCanonical(a),encodeCanonical(b)) === 0,
	proofMaterialOwners: new WeakMap()});
let classifierLoop: ts.ForOfStatement | undefined;
let descriptorStatements: string[] | undefined, membershipRow: string | undefined;
const initializers = new Map<string,string>();
let pageProgram: ts.IfStatement | undefined;
function visit(node: ts.Node): void {
	if (ts.isBlock(node)) {
		const statements = node.statements.map(statement=>statement.getText(tree));
		const start = statements.findIndex(statement=>statement.startsWith("const localDescriptor ="));
		const end = statements.findIndex(statement=>statement.startsWith("const successorDescriptorCount ="));
		if(start>=0&&end>start) descriptorStatements=statements.slice(start,end);
	}
	if(ts.isExpressionStatement(node)&&node.getText(tree).startsWith("rows.push(Object.freeze({ journalSequence: ordinal")) membershipRow=node.getText(tree);
	if (ts.isForOfStatement(node) && node.expression.getText(tree) === "potentialJournalScopes" && node.getText(tree).includes("journalClassifierWidths.push")) classifierLoop=node;
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ["publicRow","token","pageCounts","pages"].includes(node.name.text)) {
		// The static schema declarations are in the scalar owner's scope; the
		// original scenario token below has a different initializer and no record.
		if (node.name.text !== "token" || node.initializer.getText(tree).startsWith("record(")) initializers.set(node.name.text,node.initializer.getText(tree));
	}
	if (ts.isIfStatement(node) && node.getText(tree).includes('throw new TypeError("ORDINARY_NONE_PROGRAM_PAGE_DRIFT")') &&
		node.expression.getText(tree) === "compiler !== undefined") pageProgram=node;
	ts.forEachChild(node,visit);
}visit(tree);
if (!classifierLoop || !pageProgram || !descriptorStatements || !membershipRow || initializers.size !== 4) throw new Error("original classifier seams unavailable");
const scope={objectId:"room",epoch:1,anchorDigest:"a".repeat(64)},author="b".repeat(64),digest="c".repeat(64);
const classify = execute<(rows: Uint8Array[], scopes: any[], authenticated?: any[], append?: any) => {widths:number[]; records:any[]}>(`
	${declaration("closedJournalScopeHasNonLocalRows")}
	return (canonicalRows,potentialJournalScopes,authenticatedMembershipPrefixes=[],append) => {
	 const capture={journal:{canonicalRows}},objectId="room",epoch=scope.epoch,trust={currentAnchorDigest:scope.anchorDigest};
	 const immediateJournalAppend=append,currentContinuationAppends=[],journalClassifierWidths=[],journalTokens=new Map(),records=[];
	 const maintenanceCanonicalWidth=value=>{records.push(value);return encodeCanonical(value).byteLength;};
	 ${classifierLoop.getText(tree)}
	 return {widths:journalClassifierWidths,records};
	};`, {scope,digest,decodeCanonical,encodeCanonical,
	closedRetirementEqual:(a:unknown,b:unknown)=>compareBytes(encodeCanonical(a),encodeCanonical(b))===0});
const geometry = execute<(counts:number[],compiler?:any)=>{row:any;pages:number[];term:any}>(`
	return (counts,compiler) => {
	 const backend=compiler?.backend(limits),primitive=backend?.primitive??(value=>canonicalPrimitiveResourceForSizing(value,limits));
	 const record=backend?.record??(fields=>canonicalRecordResourceForSizing(fields,limits));
	 const array=backend?.array??((count,child)=>canonicalArrayResourceForSizing(count,child,limits));
	 const bytes=backend?.bytes??(count=>canonicalBytesResourceForSizing(count,limits));
	 const integer=primitive(Number.MAX_SAFE_INTEGER),digest=bytes(64),authorWidth=primitive(author);
	 const journalScope=record({objectId:scope.objectId,epoch:integer,anchorDigest:digest});
	 const publicRow=${initializers.get("publicRow")};
	 const token=${initializers.get("token")};
	 const descriptorGroups=new Map(counts.slice(0,-1).map((count,index)=>[index,{pageCount:count}]));
	 const current={successorFenceCount:counts.at(-1)};
	 const descriptorPageCounts=counts.slice(0,-1).map((count,index)=>compiler?.inputNumber("count."+index,count)??count);
	 const successorDescriptorCount=compiler?.inputNumber("successor",counts.at(-1))??counts.at(-1);
	 const pageCounts=${initializers.get("pageCounts")};const pages=${initializers.get("pages")};
	 const sum=(...values)=>values.reduce((a,b)=>a+b,0),width=value=>compiler.references(value).byteLength;
	 let pageTerm;${pageProgram.getText(tree)}
	 return {row:publicRow,pages,term:pageTerm};
	};`, {limits,scope,author,canonicalPrimitiveResourceForSizing,canonicalBytesResourceForSizing,canonicalRecordResourceForSizing,canonicalArrayResourceForSizing});
const descriptorGeometry=execute<(nativeFrames:any[],received:boolean,compiler?:any,replay?:any[])=>{groups:Map<string,any>;rows:any[];physicalRows:any}>(`
	return (nativeFrames,received,compiler,replay)=>{
	 const backend=compiler?.backend(limits),primitive=backend?.primitive??(value=>canonicalPrimitiveResourceForSizing(value,limits));
	 const record=backend?.record??(fields=>canonicalRecordResourceForSizing(fields,limits));
	 const tuple=backend?.tuple??(values=>canonicalArrayResourcesForSizing(values,limits));
	 const bytes=backend?.bytes??(count=>canonicalBytesResourceForSizing(count,limits));
	 const integer=primitive(Number.MAX_SAFE_INTEGER),digest=bytes(64),authorWidth=primitive(author),runtime=scope;
	 const input={received},journal={additionalFrameByteLength:9000};
	 const source={maintenanceResourceFacts:{ordinaryJournalReplayScopes:replay}};
	 const inputNumber=(key,value)=>compiler?.inputNumber(key,value)??value,width=value=>compiler.references(value).byteLength;
	 const sum=(...values)=>values.reduce((a,b)=>a+b,0);
	 ${descriptorStatements.join("\n")}
	 const physicalRows=canonicalArrayResourcesForSizing(nativeFrames.map(frame=>canonicalBytesResourceForSizing(frame.raw.byteLength,limits)),limits);
	 if(compiler){groupRows.forEach((row,index)=>compiler.outputResource("group."+index,row));}
	 return {groups:descriptorGroups,rows:groupRows,physicalRows};
	};`,{limits,scope,author,canonicalPrimitiveResourceForSizing,canonicalBytesResourceForSizing,canonicalRecordResourceForSizing,
	canonicalArrayResourcesForSizing,creatorOrdinaryJournalDescriptorGroupsForSizing:original.groups,creatorOrdinaryJournalScopeCollectibleForSizing:original.collectible});
const originalMembershipRow=execute<(kind:string,bytes:Uint8Array)=>any>(`
	return (kind,bytes)=>{const rows=[],ordinal=Number.MAX_SAFE_INTEGER,authorSequence=Number.MAX_SAFE_INTEGER;
	 ${membershipRow} return rows[0];};`,{author,digest,journalRetirementFrameDigest:()=>digest});
const parsed=(rows:Uint8Array[])=>rows.map(raw=>{const frame=decodeCanonical(raw) as any[];return{raw,frame,key:frame[1],row:frame[2]};});
const currentKey=JSON.stringify([scope.objectId,scope.epoch,scope.anchorDigest]);
const parameters=(groups:Map<string,any>,replay?:any[])=>new Map([...groups.entries()].flatMap(([key,group],index)=>[
	[`journal.group.${index}.count`,group.count],[`journal.group.${index}.receivedCount`,group.receivedFrameByteLengths.length],
	[`journal.group.${index}.receivedPayloadSum`,group.receivedFrameByteLengths.reduce((sum:number,length:number)=>sum+canonicalBytesResourceForSizing(length,limits).byteLength,0)],
	[`journal.group.${index}.pageCount`,group.pageCount],
	[`journal.group.${index}.localPossible`,Number(group.localPossible)],
	[`journal.group.${index}.collectible`,original.collectible({maintenanceResourceFacts:{ordinaryJournalReplayScopes:replay}},key)]] as [string,number][]));
function frames(count:number,sql:boolean,received=false):Uint8Array[]{
	return Array.from({length:count},(_,index)=>encodeCanonical([sql?"accepted_entries":"acceptedEntries",
		[scope.objectId,scope.epoch,scope.anchorDigest,index],sql?
			{source_kind:received&&index===0?"received":"local-issued",journal_sequence:index,vertex_digest:digest,local_author:author,local_author_sequence:index,
				...(received&&index===0?{received_preimage:new Uint8Array(8334),received_signature:new Uint8Array(64)}:{})}:
			{sourceKind:received&&index===0?"received":"local-issued",journalSequence:index,vertexDigest:digest,localAuthor:author,localAuthorSequence:index,
				...(received&&index===0?{exactCanonicalPreimageBytes:new Uint8Array(8334),detachedSignature:new Uint8Array(64)}:{})}]));
}
const historicalScope={...scope,epoch:0};
const historical=(rows:Uint8Array[])=>rows.map(bytes=>{const frame=decodeCanonical(bytes) as any[];frame[1][1]=0;return encodeCanonical(frame);});
describe("original all-local classifier page resource geometry",()=>{
	it("captures only the original held CURRENT/FUTURE replay intersection, without unknown future Cut identities",()=>{
		// Controlled authenticated inputs; this exercises the original producer
		// recipe and field projection, not signatures, native leases or role grants.
		const previous="d".repeat(64),genesis="e".repeat(64),trust={objectId:scope.objectId,currentEpoch:2,currentAnchorDigest:scope.anchorDigest},
			cuts=[{objectId:scope.objectId,epoch:1,closedAnchorDigest:previous,successorAnchorDigest:scope.anchorDigest},
				{objectId:scope.objectId,epoch:0,closedAnchorDigest:genesis,successorAnchorDigest:previous}],
			basis={currentTrust:trust,cuts,installedCount:0,hasPending:false,hasForwardPromotion:false,hasRecoveryRoles:true},
			replay=original.replay(basis),currentScope={...scope,epoch:2},futureScope={...scope,epoch:3,anchorDigest:"f".repeat(64)},
			fullFuture=original.fullReplay({currentScope:futureScope,cuts:[{objectId:scope.objectId,epoch:2,closedAnchorDigest:scope.anchorDigest,
				successorAnchorDigest:futureScope.anchorDigest},...original.retained(cuts,2)],sourceTrust:trust,
				protectedRoleScopes:[{objectId:scope.objectId,epoch:2,anchor:scope.anchorDigest},{objectId:scope.objectId,epoch:1,anchor:previous}]}).protectedReplayScopes,
			fullCurrent=original.fullReplay({currentScope,cuts,sourceTrust:undefined,protectedRoleScopes:[]}).protectedReplayScopes;
		expect(replay).toEqual([currentScope,{objectId:scope.objectId,epoch:1,anchorDigest:previous}]);
		for(const item of replay){expect(fullFuture).toContainEqual(item);expect(fullCurrent).toContainEqual(item);}
		for(const changed of [{installedCount:1},{hasPending:true},{hasForwardPromotion:true},{hasRecoveryRoles:false}])expect(original.replay({...basis,...changed})).toBeUndefined();
		expect(original.replay({...basis,cuts:[{...cuts[0],objectId:"foreign-room"}]})).toBeUndefined();
		const key=(item:any)=>JSON.stringify([item.objectId,item.epoch,item.anchorDigest]),owner={maintenanceResourceFacts:{ordinaryJournalReplayScopes:replay}};
		expect(original.collectible(owner,key(currentScope))).toBe(0);expect(original.collectible(owner,key({objectId:scope.objectId,epoch:0,anchorDigest:genesis}))).toBe(1);
		expect(original.collectible(owner,key({...currentScope,anchorDigest:"wrong"}))).toBe(1);expect(original.collectible(owner,key({...currentScope,objectId:"foreign"}))).toBe(1);
		expect(source).toContain("resolveCreatorSnapshotRecoveryCloseHold(capture.closeHold");
		expect(declaration("composeProspectiveCreatorMaintenancePrefixesForSizing")).toContain("creatorFinishingRetainedSummaryCutsForSizing(facts.summary.cuts, epoch)");
	});
	it("keeps complete physical rows while NEW drain descriptors/pages exclude positively protected scopes",()=>{
		const replay=[scope],compiler=original.compiler(),cold=descriptorGeometry(parsed(frames(127,false)),false,compiler,replay),program=compiler.finish();
		for(const sql of [false,true])for(const received of [false,true]){
			const rows=frames(129,sql,received),current=descriptorGeometry(parsed(rows),received,undefined,replay),values=original.evaluate(program,parameters(current.groups,replay));
			expect(current.rows[0]).toEqual(canonicalArrayResourcesForSizing([],limits));
			expect(current.physicalRows.byteLength).toBe(encodeCanonical(rows).byteLength);
			expect(current.physicalRows.byteLength).toBeGreaterThan(current.rows[0].byteLength);
			expect(values?.get("group.0.bytes")).toBe(current.rows[0].byteLength);
			expect(cold.groups.size).toBe(current.groups.size);expect(current.groups.get(currentKey)!.count).toBe(130); // Raw geometry was not filtered.
		}
		const invalid=frames(1,false).map(bytes=>{const frame=decodeCanonical(bytes) as any[];frame[2].sourceKind="corrupt";return encodeCanonical(frame);});
		expect(()=>descriptorGeometry(parsed(invalid),true,undefined,replay)).toThrow("SOURCE_KIND_INVALID");
	});
	it("matches the native refusal of protected NEW prefixes, without shrinking the physical source",()=>{
		const oldScope={...scope,epoch:0},row={journalSequence:0,vertexDigest:digest,author,authorSequence:0,nativeFrameDigest:digest};
		const baseControl={kind:"v3-live-journal-retirement-control-2",objectId:scope.objectId,incarnation:digest,
			revision:1,sequence:1,active:null,drain:null,completed:{throughEpoch:scope.epoch,decisionDigest:digest,
				sourceProofDigest:digest,protectedScopes:[scope]}};
		const sourceImage={imageDigest:digest,scopeCount:2,rowCount:2,byteCharge:4096};
		const prefix=(selected:any)=>({scope:selected,highWatermark:1,rows:[row]});
		expect(()=>captureJournalRetirementDrainPlan({baseControl,sourceImage,prefixes:[prefix(oldScope),prefix(scope)]}))
			.toThrow("malformed-input");
		expect(captureJournalRetirementDrainPlan({baseControl,sourceImage,prefixes:[prefix(oldScope)]}).prefixes)
			.toEqual([prefix(oldScope)]);
		const raw=[...historical(frames(1,false)),...frames(1,false)],before=encodeCanonical(raw),projected=descriptorGeometry(parsed(raw),false,undefined,[scope]);
		expect(projected.groups.size).toBe(2);
		expect(projected.rows[0].byteLength).toBeGreaterThan(2);
		expect(projected.rows[1]).toEqual(canonicalArrayResourcesForSizing([],limits));
		expect(projected.physicalRows.byteLength).toBe(before.byteLength);
		expect(encodeCanonical(raw)).toEqual(before);
		// No verified intersection means no omission; a same-epoch foreign anchor
		// does not select the protected group either.
		for(const replay of [undefined,[{...scope,anchorDigest:"f".repeat(64)}]])
			expect(descriptorGeometry(parsed(raw),false,undefined,replay).rows.every((value:any)=>value.byteLength>2)).toBe(true);
	});
	it("matches the original local/received membership descriptor fields while preserving full received frames",()=>{
		for(const sql of [false,true])for(const count of [1,127,128,129])for(const received of [false,true]){
			const raw=frames(count,sql,received),result=descriptorGeometry(parsed(raw),false);
			const rows=raw.map(bytes=>originalMembershipRow((decodeCanonical(bytes) as any[])[2][sql?"source_kind":"sourceKind"],bytes));
			rows.push(originalMembershipRow("local-issued",new Uint8Array(9000)));
			expect(result.rows[0].byteLength).toBe(encodeCanonical(rows).byteLength);
			expect(Object.keys(rows.at(-1)).sort()).toEqual(["author","authorSequence","journalSequence","nativeFrameDigest","vertexDigest"]);
			if(received){expect(rows[0].exactCanonicalNativeFrameBytes).toEqual(raw[0]);expect(rows[0].exactCanonicalNativeFrameBytes).not.toBe(raw[0]);}
			expect(result.groups.get(currentKey)!.pageCount).toBe(received?0:count+1);
		}
	});
	it("refreshes one compiled descriptor/page program when an all-local scope gains a received row",()=>{
		const local=parsed(frames(127,false)),compiler=original.compiler(),cold=descriptorGeometry(local,false,compiler);
		const coldPages=geometry([128,1],compiler);compiler.outputNumber("pages",coldPages.term);const program=compiler.finish();
		for(const sql of [false,true])for(const received of [false,true]){
			const raw=frames(129,sql,received),current=descriptorGeometry(parsed(raw),received),group=current.groups.get(currentKey)!;
			const input=parameters(current.groups);input.set("count.0",group.pageCount);input.set("successor",1);
			const result=original.evaluate(program,input);
			expect(result?.get("group.0.bytes")).toBe(current.rows[0].byteLength);
			expect(result?.get("group.0.items")).toBe(current.rows[0].items);
			expect(result?.get("group.0.depth")).toBe(current.rows[0].maxDepth);
			expect(result?.get("pages")).toBe(geometry([group.pageCount,1]).pages.reduce((a,b)=>a+b,0));
			if(received)expect(group.receivedFrameByteLengths).toContain(raw[0]!.byteLength);
		}
		expect(cold.groups.get(currentKey)!.receivedFrameByteLengths).toEqual([]);
	});
	it("keeps future unknown-kind descriptor maximum AND all-local page alternatives without granting a prefix",()=>{
		for(const sql of [false,true]){
			const local=parsed(frames(127,sql)),additional={count:4,frameByteLength:9000,sourceKind:"either"};
			const unknown=original.groups(local,currentKey,additional).get(currentKey)!;
			expect(unknown.count).toBe(131);expect(unknown.receivedFrameByteLengths).toEqual(Array(4).fill(9000));expect(unknown.pageCount).toBe(131);
			expect(unknown.localPossible).toBe(true);
			const received=original.groups(local,currentKey,{...additional,sourceKind:"received"}).get(currentKey)!;
			expect(received.receivedFrameByteLengths).toEqual(unknown.receivedFrameByteLengths);expect(received.pageCount).toBe(0);
			expect(received.localPossible).toBe(false);
			const mixed=original.groups(parsed(frames(127,sql,true)),currentKey,additional).get(currentKey)!;
			expect(mixed.pageCount).toBe(0);expect(mixed.receivedFrameByteLengths).toHaveLength(5);
			expect(mixed.localPossible).toBe(false);
			expect(original.groups(local,currentKey,{count:0,frameByteLength:9000,sourceKind:"received"}).get(currentKey)!.pageCount).toBe(127);
			const invalid=frames(1,sql).map(bytes=>{const frame=decodeCanonical(bytes) as any[];frame[2][sql?"source_kind":"sourceKind"]="unknown";return encodeCanonical(frame);});
			expect(()=>original.groups(parsed(invalid),currentKey,additional)).toThrow("SOURCE_KIND_INVALID");
		}
	});
	it("preserves empty-local readiness and fresh prepared/raw branch parity without treating unknown future frames as factual received work",()=>{
		for(const sql of [false,true])for(const count of [0,1,129])for(const received of [false,true]) {
			const header=encodeCanonical(["scopes",[scope.objectId,scope.epoch,scope.anchorDigest],{}]);
			const actual=[header,...frames(count,sql,received)],physical=original.groups(parsed(actual),currentKey,{count:0,frameByteLength:0,sourceKind:"local-issued"}).get(currentKey)!;
			const projection={snapshot:{groups:[{scope,count:physical.count,receivedCount:physical.receivedFrameByteLengths.length,
				receivedCanonicalPayloadSum:physical.receivedFrameByteLengths.reduce((sum,length)=>sum+canonicalBytesResourceForSizing(length,limits).byteLength,0),
				pageable:physical.localPossible}]}};
			for(const sourceKind of ["local-issued","received","either"])for(const added of [0,1,4]) {
				const additional={count:added,frameByteLength:9000,sourceKind},raw=original.groups(parsed(actual),currentKey,additional).get(currentKey)!;
				const prepared=original.prepared(projection,currentKey,additional).get(currentKey)!;
				expect(prepared).toEqual({count:raw.count,receivedCount:raw.receivedFrameByteLengths.length,
					receivedPayloadSum:raw.receivedFrameByteLengths.reduce((sum,length)=>sum+canonicalBytesResourceForSizing(length,limits).byteLength,0),
					pageCount:raw.pageCount,localPossible:raw.localPossible});
				if(count===0&&added===0)expect(raw.localPossible).toBe(true); // readiness can run even with zero pages.
			}
		}
	});
	it("bounds every collectible/retained split and null/token branch without charging incompatible readiness",()=>{
		const token={kind:"v3-live-journal-snapshot-token-1",scope,highWatermark:129,genesisDigest:digest,
			parametersDigest:digest,orderedRowDigest:digest,snapshotDigest:digest};
		const row={journalSequence:0,vertexDigest:digest,author,authorSequence:0,nativeFrameDigest:digest};
		const retained={scope,reason:"source-coverage-incomplete"};
		const base={provenance:"held-closed-cut-membership-and-original-vertices",sourceImageDigest:digest,
			protectedReplayScopes:[scope],collectiblePrefixes:[],retainedScopes:[],disposition:"retain-signed-headers-and-high-watermarks-no-drain"};
		const resource=(value:unknown)=>canonicalValueResourceForSizing(value,128,limits,"exact");
		for(const size of [1,3,127,128,129]) {
			const nullPrefix={scope,highWatermark:1,rows:[row],snapshot:null},tokenPrefix={...nullPrefix,snapshot:token};
			const compiler=original.compiler();
			const groups=Array.from({length:size},(_,i)=>({nullPrefix:resource(nullPrefix),
				tokenPrefix:resource(tokenPrefix),collectible:compiler.inputNumber(`eligible.${i}`,1),
				localPossible:compiler.inputNumber(`local.${i}`,1)}));
			const input={base:resource(base),retained:resource(retained),groups};
			const cold=original.classifierResult(input,compiler);compiler.outputNumber("result",cold.resultTerm);compiler.outputNumber("ready",cold.readinessTerm);
			const program=compiler.finish();
			for(const split of [0,Math.floor(size/2),size])for(const local of [0,1])for(const protectedAll of [false,true]) {
				const parameters=new Map(groups.flatMap((_,i)=>[[`eligible.${i}`,protectedAll?0:1],[`local.${i}`,local]]) as [string,number][]);
				const scalar=original.classifierResult({...input,groups:groups.map(group=>({...group,collectible:protectedAll?0:1,localPossible:local}))});
				const result=original.evaluate(program,parameters);
				expect(result?.get("result")).toBe(scalar.resultWidth);expect(result?.get("ready")).toBe(protectedAll?0:size*local);
				const selected=protectedAll?0:split;
				const actual={...base,collectiblePrefixes:Array(selected).fill(local?tokenPrefix:nullPrefix),retainedScopes:Array(size-selected).fill(retained)};
				expect(scalar.resultWidth).toBeGreaterThanOrEqual(encodeCanonical(actual).byteLength);
				if(local===0&&!protectedAll)expect(scalar.readinessCount).toBe(0); // received is not membership authority.
			}
			const invalid=new Map(groups.flatMap((_,i)=>[[`eligible.${i}`,1],[`local.${i}`,i===0?2:1]]) as [string,number][]);
			expect(original.evaluate(program,invalid)).toBeUndefined();
		}
	});
	it("dominates original SQL/camel public reference pages across 128 boundaries and maximum counters",()=>{
		for(const sql of [false,true])for(const count of [0,1,127,128,129,256]){
			const result=classify(historical(frames(count,sql)),[historicalScope]);
			const pages=result.records.filter(value=>Array.isArray(value.rows)),capacity=geometry([count,0]);
			expect(pages).toHaveLength(Math.ceil(count/128));expect(capacity.pages).toHaveLength(pages.length);
			pages.forEach((page,index)=>{
				expect(page.rows.length).toBeLessThanOrEqual(128);
				expect(capacity.pages[index]).toBeGreaterThanOrEqual(encodeCanonical(page).byteLength);
				for(const row of page.rows)expect(Object.keys(row).sort()).toEqual(["author","authorSequence","journalSequence","scope","sourceKind","vertexDigest"]);
			});
			const maxRow={scope:{...scope,epoch:Number.MAX_SAFE_INTEGER},journalSequence:Number.MAX_SAFE_INTEGER,vertexDigest:digest,
				sourceKind:"local-issued",author,authorSequence:Number.MAX_SAFE_INTEGER};
			expect(capacity.row.byteLength).toBe(encodeCanonical(maxRow).byteLength);
		}
	});
	it("refuses received/mixed scopes before any row/page encoding and keeps authenticated-prefix branch separate",()=>{
		for(const sql of [false,true]){
			const mixed=historical(frames(129,sql,true));
			expect(original.nonlocal(mixed,historicalScope)).toBe(true);
			expect(classify(mixed,[historicalScope])).toEqual({widths:[],records:[]});
			expect(classify(historical(frames(129,sql)),[historicalScope],[{scope:historicalScope}])).toEqual({widths:[],records:[]});
			// A received row in another scope does not change this all-local scope.
			const local=frames(1,sql),both=[...local,...mixed];
			expect(original.nonlocal(both,scope)).toBe(false);
			const append={author,authorSequence:1,vertexDigest:digest};
			expect(classify(both,[scope],[],append).records.find(value=>Array.isArray(value.rows)).rows).toHaveLength(2);
		}
	});
	it("evaluates the same compiled row/page expressions with fresh counts and no bootstrap PRE parameter",()=>{
		const compiler=original.compiler(),cold=geometry([127,1],compiler);compiler.outputNumber("pages",cold.term);const program=compiler.finish();
		for(const count of [0,1,127,128,129,256])for(const successor of [0,1]){
			const result=original.evaluate(program,new Map([["count.0",count],["successor",successor]]));
			expect(result?.get("pages")).toBe(geometry([count,successor]).pages.reduce((a,b)=>a+b,0));
		}
		expect(source).not.toContain('"preimage.maximum"');
	});
	it("keeps whole native received wrappers, standalone PRE/signature and prior UNKNOWN in the original book",()=>{
		const book=original.book([]),preimage=encodeCanonical({operation:{action:"installRoster",bytes:new Uint8Array(8334)}}),signature=new Uint8Array(64).fill(7);
		const wrapper=encodeCanonical({control:null,image:{rowCount:1},canonicalRows:frames(1,false,true)});
		for(const bytes of [preimage,signature,wrapper])expect(book.charge(bytes)).toBe(true);
		expect(book.chargeUnknownEncodedLength(128)).toBe(true);expect(book.chargeUnknownEncodedLength(128)).toBe(true);
		const before=book.chargedBytes;geometry([128,1]);
		expect(book.chargedBytes).toBe(before);expect(before).toBe(preimage.byteLength+64+wrapper.byteLength+256);
		for(const originalTerm of ["journal.canonicalRowByteLengthsTotal", "journalWrapper.byteLength", "runtimeWidths.currentClose", "futureNative.futureLeaf"])
			expect(source).toContain(originalTerm);
	});
});
