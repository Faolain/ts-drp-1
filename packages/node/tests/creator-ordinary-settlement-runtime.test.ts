import {readFileSync} from "node:fs";
import * as canonical from "@ts-drp/canonical";
import {copySettlementPlan, settlementReplacementLastLogicalTimeFromPreimage} from "../../issuance-store/src/contract.js";
import * as contract from "../../issuance-store/src/contract.js";
import * as issuanceTypes from "../../issuance-store/src/types.js";
import {captureIssuanceNativeSignInput, issuanceUnsignedSuccessorFenceRevisionDeltas,
	issuanceUnsignedSuccessorFenceWidths} from "../../issuance-store/src/retirement.js";
import {readCreatorOrdinaryPreimageCapacityForSizing} from "../src/internal/creator-closed-rollback-data.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Actual owner bodies, controlled lifetime/current-registration responses and
// real original codec/plan primitives. These do not mint nominal native holds
// or test signature/policy authentication; original native controls still do.
const {encodeCanonical, decodeCanonical, compareBytes, hashDomain} = canonical;
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8"),
	tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true);
const closeSource = readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8"),
	closeTree = ts.createSourceFile("creator-close.ts", closeSource, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const owner = name === "deriveCreatorAuthorSettlementFrontier" ? closeTree : tree;
	const node = owner.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === name);
	if (node === undefined) throw new Error(`missing original owner ${name}`);
	return node.getText(owner).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const code = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${code}`)(bindings) as T;
}
function method(): string {
	let found: ts.PropertyAssignment | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "readOrdinarySettlementCapacity") {
			if (found !== undefined) throw new Error("duplicate runtime owner"); found = node;
		}
		ts.forEachChild(node, visit);
	};
	visit(tree); if (found === undefined) throw new Error("missing runtime settlement method");
	return found.initializer.getText(tree);
}
const common = {ObjectFreeze: Object.freeze, NumberIsSafeInteger: Number.isSafeInteger, encodeCanonical, decodeCanonical,
	AUTHOR_FENCE_ACTION: "$drp.author-fence.v1", copySettlementPlan,
	sameBytes: (a: Uint8Array, b: Uint8Array) => compareBytes(a,b) === 0};
const shared = execute<{frontier: Function; preview: Function}>(`${declaration("deriveCreatorAuthorSettlementFrontier")}
	${declaration("previewCreatorOrdinarySuccessorSettlement")}
	return {frontier: deriveCreatorAuthorSettlementFrontier, preview: previewCreatorOrdinarySuccessorSettlement};`, common);
const scope = {objectId: "room", author: "f".repeat(64)}, anchor = "a".repeat(64);
function preimage(sequence: number, epoch = 0, author = scope.author, operation: object = {action: "placeBlock"}) {
	return encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId, epoch, anchor, author,
		authorSequence: sequence, logicalTime: sequence + 1, dependencies: [anchor], operation});
}
function fixture(epoch = 0, received = false) {
	const sequence = epoch === 0 ? 0 : 3, unsigned = preimage(received ? 7 : sequence, epoch, received ? "e".repeat(64) : scope.author),
		sourceIdentity = {}, machine = {}, machineIdentity = {}, child = {}, graphVersion = 2;
	const plan: any = {scope, revision: 0, fenceSequence: null, entries: []};
	const rows: any = {lineages: [{...scope, next: received ? sequence : sequence, exhausted: false, prunedThroughAuthorSequence: null}],
		issued: [], outbox: [], plans: [plan]};
	const registration: any = {issuanceScope: scope, graphVersion, blueprintMachine: machine, blueprintMachineIdentity: machineIdentity,
		payload: {}, historicalIssuance: epoch === 0 ? undefined : {scopeAuthorMatches: true}, closeAuthors: new Map(), closeVertices: new Map()};
	if (epoch > 0) {
		const bytes = preimage(2, epoch), digest = hashDomain("ts-drp/vertex/v3", bytes), key = Buffer.from(digest).toString("hex");
		rows.issued.push({...scope, authorSequence: 2, canonicalPreimageBytes: bytes, digest, signature: new Uint8Array(64)});
		rows.outbox.push({...scope, authorSequence: 2, digest, publishState: "pending"});
		registration.closeAuthors.set(key, {...scope, authorSequence: 2});
		registration.closeVertices.set(key, {kind: "drp-vertex", operation: {action: "placeBlock"}});
	}
	const candidateDigest = Buffer.from(hashDomain("ts-drp/vertex/v3", unsigned)).toString("hex"),
		enrolled: any = {unsignedBytes: unsigned.slice(), sourceIdentity, machine, machineIdentity, value: {
			successorFenceCount: 1, runtime: {graphVersion}, currentSignedPreimagesHaveSettlementSource: false,
			candidate: {digest: candidateDigest, exactCanonicalEpochVertexBytes: encodeCanonical({kind: "drp-vertex", operation: {action: "placeBlock"}})}}};
	const state = {revoked: false, checks: 0, callbacks: 0, available: true}, native: any = {rows, control: null};
	const facts: any = {currentDimensions: enrolled, receivedAppend: received ? {} : undefined,
		check: () => {state.checks++; if(state.revoked) throw new Error("original-runtime-revoked");}};
	const api = execute<any>(`${["deriveCreatorAuthorSettlementFrontier", "previewCreatorOrdinarySuccessorSettlement", "settlementOwnRowClass"].map(declaration).join("\n")}
		// Controlled invocation DATA, not a source/replacement capability. The
		// separate source-linked controls exercise original capture/verifier bodies.
		let sourceLinkedApplicationCapture = {effects: [], completedNative: []};
		const lifetime = {readOrdinarySettlementCapacity: ${method()},
			revokeSourceData() {sourceLinkedApplicationCapture = undefined;}}; return lifetime;`, {
		...common, facts, registration, trust: {profileId: "creator-trusted-settlement-v1", currentEpoch: epoch}, value: {},
		issuanceBorrowAvailable: true, issuanceChild: child, nativeChildren: new Set([child]), nativeIssuanceCapture: native, currentJournalCapture: [],
		creatorOrdinaryIssuanceSourceIdentity: () => sourceIdentity, settlementProfileFor: (profile: string) => profile === "creator-trusted-settlement-v1" ? "v1" : "none",
		sameScope: (a: any,b: any) => a.objectId === b.objectId && a.author === b.author,
		ordinaryPreviewAppendCandidate: (_owner: unknown, bytes: Uint8Array) => captureIssuanceNativeSignInput({scope: {objectId: scope.objectId,
			author: received ? "e".repeat(64) : scope.author}, exactCanonicalUnsignedVertexBytes: bytes}),
		settlementFrontierFromHistory: (history: unknown) => history === undefined ? undefined : {admissionEpoch: 0, currentEpoch: epoch, terminalThrough: 1},
		validSettlementFrontierContext: () => true, prospectiveCensusRecord: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
		isDigestHex: (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
		readCreatorOrdinaryPreimageCapacityForSizing, issuanceUnsignedSuccessorFenceRevisionDeltas,
		settlementReplacementLastLogicalTimeFromPreimage,
	});
	const preview = (input: any) => {state.callbacks++; return {plan: {...(input.priorPlan ?? plan),
		revision: input.priorPlan === null ? 0 : input.priorPlan.revision + Number(input.priorPlan.fenceSequence !== null), fenceSequence: null},
		fenceLogicalTime: input.minimumLogicalTime, continuationLogicalTime: input.minimumLogicalTime};};
	return {api, state, facts, rows, plan, native, enrolled, registration, unsigned, preview};
}

describe("same-owner V1 ordinary settlement scalar preparation", () => {
	it("preserves exact local/nonlocal slot ambiguity, regression, fence and contiguous suffix law", () => {
		const base = {author: scope.author, issuanceAuthor: scope.author, admissionEpoch: 0, boundary: null,
			slots: new Map([[0,"zero"],[2,"fence"],[3,"three"]]), duplicate: false,
			vertices: new Map([["fence",{operation:{action: "$drp.author-fence.v1",version:1,fenceSequence:2}}]])};
		expect(shared.frontier(base)).toEqual([scope.author,0,3]);
		expect(() => shared.frontier({...base, duplicate:true})).toThrow("ambiguous");
		expect(() => shared.frontier({...base,boundary:0})).toThrow("regressed");
		expect(shared.frontier({...base,author:"foreign",duplicate:true,boundary:1})).toEqual(["foreign",0,1]);
		expect(shared.frontier({...base,slots:new Map([[0,"zero"],[2,"gap"]]),vertices:new Map()})).toEqual([scope.author,0,0]);
	});
	it("retains whole completed entries/sourceOrigin and rejects changed reset, unresolved source or unstable callback", () => {
		const entry = {sourceObjectId:"old-room",sourceSequence:0,sourceDigest:new Uint8Array(32),disposition:"expire",replacementSequence:null},
			plan = {scope,revision:127,fenceSequence:4,entries:[entry]}, base = {scope,epoch:2,priorPlan:plan,priorFenceEpoch:1,lastTime:4,sequence:5};
		const preview = (input:any) => ({plan:{...input.priorPlan,revision:128,fenceSequence:null},fenceLogicalTime:6,continuationLogicalTime:6});
		expect(encodeCanonical(shared.preview({...base,preview}).plan.entries)).toEqual(encodeCanonical(plan.entries));
		for (const change of [(value:any) => ({...value,revision:127}), (value:any) => ({...value,entries:[]}),
			(value:any) => ({...value,entries:[{...entry,sourceObjectId:"other-room"}]}),
			(value:any) => ({...value,entries:[{...entry,disposition:"rebase"}]})])
			expect(() => shared.preview({...base,preview:(input:any)=>({...preview(input),plan:change(preview(input).plan)})})).toThrow();
		let clock=6; const unstable = shared.preview({...base,preview:(input:any)=>({...preview(input),fenceLogicalTime:clock++})});
		expect(unstable.checkPreview()).toBe(false);
		for (const key of ["lastTime","sequence","epoch"]) expect(() => shared.preview({...base,[key]:Number.MAX_SAFE_INTEGER,preview})).toThrow();
	});
	it("delivers local and received scalar data without changing native rows or enrolled candidate", () => {
		for(const [epoch,received] of [[0,false],[1,false],[1,true]] as const) {
			const f=fixture(epoch,received), before=encodeCanonical(f.rows), candidate=f.unsigned.slice(), result=f.api.readOrdinarySettlementCapacity(f.unsigned,f.preview);
			expect(result?.successorFenceCount).toBe(1); expect(result?.canonicalSuccessorFencePreimageByteLength).toBeGreaterThan(f.unsigned.byteLength);
			expect(result?.nativeControlRevisionDelta).toBe(received ? 5 : epoch===0 ? 8 : 9);
			expect(encodeCanonical(f.rows)).toEqual(before); expect(f.unsigned).toEqual(candidate); expect(f.state.callbacks).toBe(2);
		}
	});
	it("refuses foreign/mutated/no-longer-current candidate, unrepresented issued work and pending/source debt", () => {
		for(const change of [(f:any)=>{f.enrolled.sourceIdentity={};},(f:any)=>{f.registration.graphVersion++;},
			(f:any)=>{f.api.revokeSourceData();}, (f:any)=>{f.rows.lineages[0].pendingUnsigned={};},
			(f:any)=>{f.rows.issued.push({...scope,authorSequence:9,canonicalPreimageBytes:preimage(9,1)});},
			(f:any)=>{f.rows.issued[0].author="e".repeat(64);},(f:any)=>{f.rows.plans[0].entries=[{disposition:"rebase",replacementSequence:null}];},
			(f:any)=>{f.rows.plans.push({scope:{...scope,author:"e".repeat(64)},entries:[{disposition:"manual-review",replacementSequence:null}]});},
			(f:any)=>{f.native.control={active:{},revision:0};}, (f:any)=>{f.native.control={active:null,revision:Number.MAX_SAFE_INTEGER};}]) {
			const f=fixture(1); change(f); expect(f.api.readOrdinarySettlementCapacity(f.unsigned,f.preview)).toBeUndefined();
		}
		const changed=fixture(1); const altered=changed.unsigned.slice(); altered[0]^=1;
		expect(changed.api.readOrdinarySettlementCapacity(altered,changed.preview)).toBeUndefined();
		const revoked=fixture();revoked.state.revoked=true;
		expect(()=>revoked.api.readOrdinarySettlementCapacity(revoked.unsigned,revoked.preview)).toThrow("original-runtime-revoked");expect(revoked.state.callbacks).toBe(0);
		const during=fixture();expect(()=>during.api.readOrdinarySettlementCapacity(during.unsigned,(input:any)=>{during.state.revoked=true;return during.preview(input);})).toThrow("original-runtime-revoked");
		const mutation=fixture();expect(mutation.api.readOrdinarySettlementCapacity(mutation.unsigned,(input:any)=>{mutation.unsigned[0]=0;return mutation.preview(input);})).toBeUndefined();
	});
	it("bounds the ORIGINAL fence PRE factory at integer/length/UTF8 boundaries", () => {
		const start=source.indexOf("\t\tconst fenceSequence = horizonSequence + 1;"), end=source.indexOf("\n\t\tconst unknownFencePreimageWidth",start);
		expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
		const factory = `${declaration("prospectiveCensusCountWidth")}\n${declaration("prospectiveCensusRecordWidth")}\n${source.slice(start,end)}\nreturn fencePreimageByteLength;`;
		for(const sequence of [126,127,Number.MAX_SAFE_INTEGER-2]) for(const epoch of [0,127,128]) {
			const unsigned={kind:"drp-vertex",protocolMajor:3,objectId:"r".repeat(256),author:scope.author,anchor,
				authorSequence:sequence,epoch,logicalTime:1,dependencies:[anchor],operation:{action:"placeBlock",title:"日本語😀"}};
			const bound=readCreatorOrdinaryPreimageCapacityForSizing(encodeCanonical(unsigned))!;
			const actual=execute<number>(factory,{...common,horizonSequence:sequence,unsigned,candidate:{scope:{objectId:unsigned.objectId,author:scope.author}},
				epoch,anchorRead:{anchorDigest:anchor},receivedAppend:false});
			expect(bound.canonicalPreimageByteLength).toBeGreaterThanOrEqual(actual);
		}
	});
	it("preserves original native fence phase widths and counter counts without image construction in scalar seam", () => {
		const file=readFileSync(new URL("../../issuance-store/src/retirement.ts",import.meta.url),"utf8");
		const start=file.indexOf("\tconst revisionDeltas = issuanceUnsignedSuccessorFenceRevisionDeltas({"), end=file.indexOf("\n\tconst bytesWidth =",start);
		const old=`\tconst immediateDelta = input === undefined ? 0 : (inherited === undefined ? 1 : 0) + (inherited?.phase === "entered" ? 0 : 1) + 1;
\tconst beforeFenceDelta = continuation === undefined ? rows.outbox.filter(r => r.objectId === scope.objectId && r.author === scope.author && r.publishState === "pending").length + Number(input !== undefined) + (planChanged ? 1 : 0) : continuation.final.controlRevisionDelta + (planChanged ? 1 : 0);`;
		const oracleSource=(file.slice(0,start)+old+file.slice(end)).replace("const controlRevisionDelta = revisionDeltas[phase];",
			"const controlRevisionDelta = beforeFenceDelta + (phase === 'reserved' ? 1 : phase === 'entered' ? 2 : 3);");
		const compiled=ts.transpileModule(oracleSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
		const exports:any={};new Function("exports","require",compiled)(exports,(name:string)=>name==="@ts-drp/canonical"?canonical:name==="./contract.js"?contract:issuanceTypes);
		for(const sequence of [0,127,128]) for(const received of [false,true]) {
			const bytes=preimage(sequence),digest=hashDomain("ts-drp/vertex/v3",bytes),plan={scope,revision:0,fenceSequence:null,entries:[]},
				rows={lineages:[{...scope,next:sequence+Number(received),exhausted:false,prunedThroughAuthorSequence:sequence===0?null:sequence-1}],
					issued:received?[{...scope,authorSequence:sequence,canonicalPreimageBytes:bytes,digest,signature:new Uint8Array(64)}]:[],
					outbox:received?[{...scope,authorSequence:sequence,digest,publishState:"pending" as const}]:[],plans:[plan]},
				intent=received?undefined:{kind:"v3-issuance-pending-unsigned-1" as const,authorSequence:sequence,canonicalPreimageBytes:bytes,digest},
				successor={plan,canonicalPreimageByteLength:8334};
			expect(issuanceUnsignedSuccessorFenceWidths(rows,scope,intent,null,successor)).toEqual(exports.issuanceUnsignedSuccessorFenceWidths(rows,scope,intent,null,successor));
			const continuation: []=[];
			expect(issuanceUnsignedSuccessorFenceWidths(rows,scope,intent,null,{...successor,continuation}))
				.toEqual(exports.issuanceUnsignedSuccessorFenceWidths(rows,scope,intent,null,{...successor,continuation}));
			if(intent!==undefined) for(const phase of ["reserved","entered"] as const) {
				const control={kind:"v3-issuance-retirement-control-1" as const,objectId:scope.objectId,incarnation:"a".repeat(64),
					revision:sequence+127,sequence:0,active:null,completed:null};
				const inherited={...rows,lineages:[{...rows.lineages[0]!,pendingUnsigned:{...intent,incarnation:control.incarnation,phase}}]};
				expect(issuanceUnsignedSuccessorFenceWidths(inherited,scope,intent,control,successor))
					.toEqual(exports.issuanceUnsignedSuccessorFenceWidths(inherited,scope,intent,control,successor));
			}
		}
		for(const inheritedPhase of [undefined,"reserved","entered"] as const) for(const hasImmediateIntent of [true,false])
			for(const pendingAcknowledgementCount of [0,127,128]) for(const planChanged of [true,false]) {
				const value=issuanceUnsignedSuccessorFenceRevisionDeltas({hasImmediateIntent,inheritedPhase,pendingAcknowledgementCount,planChanged});
				expect(value.final-value.reserved).toBe(2);expect(value.published-value.final).toBe(1);
				expect(value.immediate).toBe(hasImmediateIntent ? Number(inheritedPhase===undefined)+Number(inheritedPhase!=="entered")+1 : 0);
				const continued=issuanceUnsignedSuccessorFenceRevisionDeltas({hasImmediateIntent,inheritedPhase,pendingAcknowledgementCount,planChanged,continuationControlRevisionDelta:128});
				expect(continued.beforeFence).toBe(128+Number(planChanged));
			}
		expect(()=>issuanceUnsignedSuccessorFenceRevisionDeltas({hasImmediateIntent:true,inheritedPhase:undefined,pendingAcknowledgementCount:Number.MAX_SAFE_INTEGER,planChanged:true})).toThrow();
	});
});
