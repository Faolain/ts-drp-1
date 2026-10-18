import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {CompactMerkleAccumulator} from "@ts-drp/compaction";
import {settlementProfileFor} from "@ts-drp/protocol-v3/settlement-profile";
import {AHE_BOUNDED_READ_LIMITS, digestBlob, digestClosure} from "@ts-drp/storage";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";
import {deriveCreatorCloseHistory, encodeCreatorCloseHistory} from "../src/internal/creator-close-history.js";

// Actual owner bodies; the advance control/crypto openers below are explicitly
// controlled. These are reference-geometry controls, not native/authentication
// evidence. The original end-to-end factory controls remain independently owed.
const root = new URL("../src/", import.meta.url);
const references = readFileSync(new URL("internal/creator-adoption-references.ts", root), "utf8");
const advance = readFileSync(new URL("internal/creator-transition-advance.ts", root), "utf8");
const rollback = readFileSync(new URL("internal/creator-closed-rollback-data.ts", root), "utf8");
const close = readFileSync(new URL("creator-close.ts", root), "utf8");
function declaration(source: string, name: string): string {
	const file = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
	const node = file.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
	if (!node) throw new Error(`missing original owner: ${name}`);
	return node.getText(file).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const api = execute<{added(input: any): any[]; proposed(input: any): any[]; capacity(input: any): number | undefined;
	adopt(input: any): any[] | undefined; legacy(input: any): any[] | undefined}>(`
	${["creatorCloseAddedReferenceFields", "creatorCloseProposedReferenceFields", "creatorOrdinaryGenerationClosureCapacityForSizing",
		"deriveReferences", "deriveCreatorAdoptionReferences", "deriveLegacyCreatorAdoptionReferences"].map(name => declaration(references, name)).join("\n")}
	return {added: creatorCloseAddedReferenceFields,proposed:creatorCloseProposedReferenceFields,capacity:creatorOrdinaryGenerationClosureCapacityForSizing,
	 adopt:deriveCreatorAdoptionReferences,legacy:deriveLegacyCreatorAdoptionReferences};`, {AHE_BOUNDED_READ_LIMITS, digestBlob, digestClosure, deriveCreatorCloseHistory});
const value = <T>(result: {ok: true; value: T} | {ok: false}): T => {if (!result.ok) throw new Error("invalid geometry fixture"); return result.value;};
const ref = (bytes: Uint8Array) => ({digest: value(digestBlob(bytes)), byteLength: bytes.byteLength});
const candidate = (record: unknown) => {const bytes = encodeCanonical(record); return {bytes, ref: ref(bytes)};};
const sort = (a: {digest: string}, b: {digest: string}) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
function row(count: number, id = "0".repeat(64), state = "Adopted") {
	const closure = Array.from({length: count}, (_, index) => ref(encodeCanonical({id,index}))).sort(sort);
	return {objectId: "room", generationId: id, closure, closureDigest: value(digestClosure(closure)), state};
}
function input(current = row(10), successorMetadataCount = 1, old: ReturnType<typeof row>[] = []) {
	return {currentHead: {kind: "present", objectId: "room", generationId: current.generationId,
		closureDigest: current.closureDigest, revision: Number.MAX_SAFE_INTEGER - 2}, currentTrustRef: current.closure[0],
		generations: [current,...old], successorMetadataCount};
}
function proposal(profile: "creator-trusted-v1" | "creator-trusted-settlement-v1") {
	const accumulator = new CompactMerkleAccumulator(), historyRoot = Buffer.from(accumulator.root()).toString("hex");
	const projection = candidate({kind:"v3-live-generation-1",epoch:0});
	const trust = candidate({kind:"drp-anchor-trust-state",currentEpoch:0});
	const base = candidate({kind:"original-base", bytes:Uint8Array.of(1)});
	const metadata = (profile === "creator-trusted-v1" ? ["retirement", "aggregate"] : ["settlement"]).map(kind => candidate({kind}));
	const cut = candidate({kind:"drp-hard-epoch-cut",objectId:"room",epoch:0,historyRoot,historySize:0});
	const successorProjection = candidate({kind:"v3-live-generation-2",version:2,objectId:"room",epoch:1,historyRoot,historySize:0,
		compactHistory:accumulator.snapshot()});
	const history = {bytes: encodeCreatorCloseHistory(Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3",cut.bytes)).toString("hex"),accumulator.snapshot()),ref:{} as any};
	history.ref = ref(history.bytes);
	const successorTrust = candidate({kind:"drp-anchor-trust-state",currentEpoch:1}), qc = candidate({kind:"drp-seal-qc",phase:"commit"});
	const currentCandidates=[projection,trust,base], proposedInput = {currentReferences:currentCandidates.map(item=>item.ref).sort(sort),currentTrustRef:trust.ref,
		successorTrust:successorTrust.ref,cut:cut.ref,commitQc:qc.ref,history:history.ref,metadata};
	const proposed=api.proposed(proposedInput).sort(sort), proposedCandidates=[projection,base,successorTrust,cut,qc,history,...metadata];
	return {profile,projection,trust,base,metadata,cut,history,successorProjection,successorTrust,qc,currentCandidates,proposedInput,proposed,proposedCandidates};
}
describe("original producer finishing closure geometry",()=>{
	it("shares exactly the original close slots/filtering/sort and preserves current refs and object isolation for NONE/V1",()=>{
		for(const profile of ["creator-trusted-v1","creator-trusted-settlement-v1"] as const){
			const f=proposal(profile), currentBefore=encodeCanonical(f.proposedInput.currentReferences);
			const original=[...f.proposedInput.currentReferences.filter(({digest})=>digest!==f.trust.ref.digest &&
				!f.proposedInput.metadata.some((control:any)=>digest===control.priorRef?.digest)), f.successorTrust.ref,f.cut.ref,f.qc.ref,f.history.ref,
				...f.metadata.map(({ref})=>ref)].sort(sort);
			expect(encodeCanonical(f.proposed)).toEqual(encodeCanonical(original));
			expect(encodeCanonical(f.proposedInput.currentReferences)).toEqual(currentBefore);
			expect(f.proposed).not.toBe(f.proposedInput.currentReferences);
			expect(f.proposed.find(item=>item.digest===f.base.ref.digest)).toBe(f.base.ref);
			const current={objectId:"room",generationId:"0".repeat(64),state:"Adopted",closure:f.proposedInput.currentReferences,
				closureDigest:value(digestClosure(f.proposedInput.currentReferences))};
			const cap=api.capacity({...input(current),currentTrustRef:f.trust.ref,successorMetadataCount:f.metadata.length});
			expect(cap).toBe(f.proposed.length);
			const oldControl={...f.metadata[0]!,priorRef:f.base.ref};
			expect(api.proposed({...f.proposedInput,metadata:[oldControl,...f.metadata.slice(1)]})).toHaveLength(f.proposed.length-1);
		}
		expect(close).toContain("creatorCloseProposedReferenceFields({currentReferences: current.references");
	});
	it("bounds original advance normalization and both supported adoption layouts without constructing future native records",()=>{
		for(const profile of ["creator-trusted-v1","creator-trusted-settlement-v1"] as const){
			const f=proposal(profile), kinds=new Map(f.proposedCandidates.map(item=>[item.ref.digest,decodeCanonical(item.bytes)]));
			const pair={current:undefined,proposed:f.metadata[0]}, aggregate={current:undefined,proposed:f.metadata[1]};
			const inspect=execute<(input:any)=>any>(`${declaration(advance,"inspectCreatorTransitionAdvanceOwned")}\nreturn inspectCreatorTransitionAdvanceOwned;`,{
				createCreatorCanonicalSyntaxReader:()=>({}),settlementProfileFor,
				authenticatedSettlementPair:()=>pair,authenticatedRetirementPair:()=>pair,authenticatedAggregatePair:()=>aggregate,
				openCreatorTransitionSettlement:()=>undefined, sameRef:(a:any,b:any)=>a.digest===b.digest&&a.byteLength===b.byteLength,
				candidateSelection:(item:any)=>decodeCanonical(item.bytes),record:(item:any)=>decodeCanonical(item.bytes),
				exactCandidate:(item:any)=>item.ref.digest===value(digestBlob(item.bytes)),
				hex:(bytes:Uint8Array)=>Buffer.from(bytes).toString("hex"),hashDomain,
				openCreatorCloseHistory:()=>true,inspectCreatorTrustAdvance:(value:any)=>({ok:true,kind:"successor",input:value}),
				failure:(reason:string)=>({ok:false,reason})});
			const current={candidates:f.currentCandidates,closure:f.proposedInput.currentReferences};
			const advanced=inspect({current,proposed:{candidates:f.proposedCandidates,closure:f.proposed},mode:"stage",
				currentTrust:{profileId:profile},successorTrust:{profileId:profile},proofRefs:[f.cut.ref,f.qc.ref]});
			expect(advanced.ok).toBe(true);expect(advanced.proposed.closure.length).toBeLessThanOrEqual(f.proposed.length);
			const adoption={pendingReferences:advanced.proposed.closure,predecessorLiveRef:f.projection.ref,
				exactCanonicalProjectionBytes:f.successorProjection.bytes,exactCanonicalCutValueBytes:f.cut.bytes,
				predecessorExactCanonicalLatchedAclBytes:encodeCanonical({kind:"drp-v3-latched-acl",epoch:0})};
			const actual=api.adopt(adoption),legacy=api.legacy(adoption);
			expect(actual).toBeDefined();expect(actual!.length).toBeLessThanOrEqual(f.proposed.length);
			expect(legacy).toBeDefined();expect(legacy!.length).toBeLessThanOrEqual(f.proposed.length+1);
			expect(actual!.some(item=>kinds.get(item.digest)?.kind==="original-base")).toBe(true);
		}
	});
	it("retains larger old/legacy closures and all eight state/address/head occurrence sides",()=>{
		const old=row(128,"1".repeat(64),"Superseded"), f=input(row(10),1,[old]), before=encodeCanonical(f);
		expect(api.capacity(f)).toBe(128);expect(encodeCanonical(f)).toEqual(before);
		const file=ts.createSourceFile("original.ts",rollback,ts.ScriptTarget.Latest,true);let expression:string|undefined;
		const visit=(node:ts.Node):void=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="generationTransitions")expression=node.initializer!.getText(file);ts.forEachChild(node,visit);};visit(file);
		const width=execute<number>(`return ${expression};`,{sum:(...parts:number[])=>parts.reduce((a,b)=>a+b,0),
			generation:{byteLength:11},generationEnvelope:{byteLength:13},addressedGeneration:{byteLength:17},headEnvelope:{byteLength:19}});
		expect(width).toBe(8*(11+13+17+19));
		expect(rollback).toContain('inputNumber("generation.closureReferences", closureCapacity)');
		expect(rollback).toContain('parameters.set("generation.closureReferences", closureCapacity)');
	});
	it("refuses missing/ambiguous current trust or native closure correspondence, duplicates and exhausted original headroom",()=>{
		for(const change of ["missing-head","wrong-head","wrong-scope","wrong-state","missing-trust","trust-length","duplicate-ref","duplicate-generation","wrong-closure","metadata"] as const){
			const f=input();
			if(change==="missing-head")f.generations=[];
			if(change==="wrong-head")f.currentHead.generationId="f".repeat(64);
			if(change==="wrong-scope")f.generations[0]!.objectId="other";
			if(change==="wrong-state")f.generations[0]!.state="Superseded";
			if(change==="missing-trust")f.currentTrustRef=ref(Uint8Array.of(255));
			if(change==="trust-length")f.currentTrustRef={...f.currentTrustRef!,byteLength:f.currentTrustRef!.byteLength+1};
			if(change==="duplicate-ref")f.generations[0]!.closure.push(f.generations[0]!.closure[1]!);
			if(change==="duplicate-generation")f.generations.push({...f.generations[0]!});
			if(change==="wrong-closure")f.generations[0]!.closureDigest="f".repeat(64) as any;
			if(change==="metadata")f.successorMetadataCount=0;
			expect(api.capacity(f),change).toBeUndefined();
		}
		const limit=AHE_BOUNDED_READ_LIMITS.maxClosureReferences;
		expect(api.capacity(input(row(limit-4),1))).toBe(limit);
		expect(api.capacity(input(row(limit-5),2))).toBe(limit);
		expect(api.capacity(input(row(limit-4),2))).toBeUndefined();
		expect(api.capacity(input(row(8),2,[row(limit,"1".repeat(64),"Superseded")]))).toBe(limit);
	});
});
