import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Actual private numerical bodies under controlled nominal/native owners.
// These tests do not claim signatures, native exclusion or source authority.
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const matches = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (matches.length !== 1) throw new Error(`missing actual private body:${name}`);
	return matches[0]!.getText(tree).replace(/^export /, "");
}
function nestedExpression(name: string): string {
	const matches: string[] = [];
	function walk(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined)
			matches.push(node.initializer.getText(tree));
		if (ts.isPropertyAssignment(node) && node.name.getText(tree) === name) matches.push(node.initializer.getText(tree));
		ts.forEachChild(node, walk);
	}
	walk(tree); if (matches.length !== 1) throw new Error(`missing actual private expression:${name}:${matches.length}`);
	return matches[0]!;
}
function evaluate<T>(body: string, result: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js};return ${result};`)(bindings) as T;
}
const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const common = {ObjectFreeze: Object.freeze, Uint8ArrayConstructor: Uint8Array, encodeCanonical, sameBytes: equal,
	ReflectApply: Reflect.apply, MapPrototypeSet: Map.prototype.set, MapPrototypeGet: Map.prototype.get};

const rollbackSource = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const rollbackTree = ts.createSourceFile("rollback.ts", rollbackSource, ts.ScriptTarget.Latest, true);
function rollbackDeclaration(name: string): ts.FunctionDeclaration {
	const nodes = rollbackTree.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (nodes.length !== 1) throw new Error(`missing actual rollback owner:${name}:${nodes.length}`);
	return nodes[0]!;
}
function rollbackLocalInitializer(owner: string, name: string): string {
	const matches: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer)
			matches.push(node.initializer.getText(rollbackTree));
		ts.forEachChild(node, visit);
	};
	visit(rollbackDeclaration(owner));
	if (matches.length !== 1) throw new Error(`missing original lexical lifecycle:${owner}:${name}:${matches.length}`);
	return matches[0]!;
}

function numericalLifecycleFixture() {
	let join!: () => void;
	const pending = new Promise<void>(resolve => {join = resolve;});
	const numerical = {current: {} as object | undefined}, events: string[] = [];
	const frame = {alive: true, headerConsumersRevoked: false, pending: new Set([pending]), accounting: {}, reader: {}};
	const api = evaluate<{begin(): Promise<void>; release(): Promise<void>; state(): {released: boolean; writeStarted: boolean}}>(`
		let released=false,writeStarted=false,beginTask,endTask,releaseTask,journalProbe={},issuanceProbe={},revokeJournalCapture;
		const capturedFrame=frame, owned=[], signing=undefined, reader=undefined;
		const runtime={release:async()=>{events.push("runtime-release");},endReadPhase:async()=>{events.push("read-phase-joined");}};
		const issuer={release:async()=>{events.push("issuer-release");}}, journalHold=issuer;
		const check=async()=>{};
		const release=${rollbackLocalInitializer("acquireCreatorOrdinaryIssuanceMaintenanceProof", "release")};
		const begin=${rollbackLocalInitializer("acquireCreatorOrdinaryIssuanceMaintenanceProof", "begin")};
	`, "({begin,release,state:()=>({released,writeStarted})})", {
		frame, numerical, events, ledgers: new Map(), frames: new Map(),
		joinSourceReleases: async (operations: (() => Promise<void>)[]) => {for (const operation of operations) await operation();},
		requireLaw: (valid: boolean, reason: string) => {if (!valid) throw new Error(reason);},
		Refusal: Error, failure: (reason: string) => reason,
	});
	return {api, numerical, events, frame, join};
}

function acceptedNumericalFixture(withWindow = false) {
	const preimage = encodeCanonical({candidate: 3}), derivative = encodeCanonical({derivative: 3}),
		baseState = encodeCanonical({base: true}), sourceHandle = {}, sourceIdentity = {};
	const state = {active: true, sourceAvailable: true, issuanceAvailable: true, constructions: 1, charges: 0,
		sourceIdentity, baseState};
	const dimensions = {candidate: {exactCanonicalEpochVertexBytes: derivative.slice(), operationCount: 1,
			exactCanonicalOperationBytes: encodeCanonical({action: "placeBlock", id: "x", kind: "stone", x: 0, y: 0}), control: false},
		parameters: {maxEpochVertices: 8192, maxEpochBytes: 8388608}, currentEpochVertexCount: 1,
		runtime: {graphVersion: 3, kind: "local-issuance", epochBytes: 0},
		blueprint: {baseStateDigest: "base-digest", exactCanonicalBaseStateBytes: baseState.slice()}};
	const machine = {snapshot: () => ({stateDigest: "base-digest", exactCanonicalStateBytes: state.baseState})}, machineIdentity = {};
	const registration: {blueprintMachine: object; blueprintMachineIdentity: object} = {blueprintMachine: machine, blueprintMachineIdentity: machineIdentity};
	const originalDimensionBytes = encodeCanonical(dimensions);
	const facts = {currentDimensions: {unsignedBytes: preimage.slice(), value: dimensions,
		valueIntact: () => equal(encodeCanonical(dimensions), originalDimensionBytes), sourceIdentity, machine, machineIdentity},
		check: () => {if (!state.active) throw new Error("original runtime revoked");}};
	const lifetime = {resolveCurrentDimensions: undefined as unknown as (value: unknown, bytes: Uint8Array) => unknown,
		readCurrentDimensions: () => {state.constructions++; throw new Error("unexpected repeated construction");}};
	lifetime.resolveCurrentDimensions = evaluate<(...args: any[]) => unknown>(`function resolve(value, bytes) {
		const issuanceBorrowAvailable = state.issuanceAvailable;
		let preparedCapacityCapture;
		const resolveDimensions = ${(() => {
			let initializer: ts.Expression | undefined;
			const visit = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "resolveDimensions")
					initializer = node.initializer;
				ts.forEachChild(node, visit);
			};
			visit(tree);
			if (initializer === undefined) throw new Error("missing actual private numerical resolver");
			return initializer.getText(tree);
		})()};
		return (${nestedExpression("resolveCurrentDimensions")}).call(this, value, bytes);
	}`, "resolve", {lifetime, facts, registration, state, sameBytes: equal, encodeCanonical,
		creatorOrdinaryIssuanceSourceIdentity: () => state.sourceIdentity});
	const accepted: Uint8Array[][] = [];
	const material = {appendAccepted: (bytes: Uint8Array[]) => {accepted.push(bytes.map(value => value.slice())); return material;}};
	const sourceFacts: any = {identity: sourceIdentity, capacity: {material, readiness: {geometry:
		{graphVersion: 3, acceptedCount: 0, localIssuedCount: 0, acceptedWitnessPayloadBytes: 0},
		...(withWindow ? {window: {acceptedActions: 0, acceptedOperationBytes: 0, acceptedPreimageBytes: 0, acceptedEpochVertexBytes: 0}} : {})}}};
	const proof = {accounting: {chargedBytes: 100, charge: () => {state.charges++; return true;}}};
	const owner = {source: sourceHandle, runtime: lifetime,
		numerical: {current: {unsignedBytes: preimage.slice(), value: dimensions}} as {
			current?: Readonly<{unsignedBytes: Uint8Array; value: typeof dimensions}>}};
	const capture = evaluate<(proof: unknown, bytes: Uint8Array) => ((signed: {
		exactCanonicalPreimageBytes: Uint8Array; detachedSignature: Uint8Array; exactCanonicalEpochVertexBytes: Uint8Array}) => void) | undefined>(
		["resolveCreatorOrdinaryNumericalDimensions", "creatorOrdinaryFinishingWindowCandidateUsageForSizing", "captureCreatorOrdinaryAcceptedResourceUpdateForSizing"]
			.map(name => rollbackDeclaration(name).getText(rollbackTree).replace(/^export /, "")).join("\n"),
		"captureCreatorOrdinaryAcceptedResourceUpdateForSizing", {
			creatorOrdinaryIssuanceProofFacts: (value: unknown) => value === proof && state.active ? owner : undefined,
			creatorOrdinaryIssuanceSourceFacts: (value: unknown) => value === sourceHandle && state.sourceAvailable ? sourceFacts : undefined,
			proofMaterialOwners: new Map([[proof.accounting, {}]]), compareBytes, encodeCanonical,
			canonicalBytesResourceForSizing: (length: number) => ({byteLength: encodeCanonical(new Uint8Array(length)).byteLength}),
		});
	return {preimage, derivative, dimensions, registration, owner, proof, state, accepted, capture, sourceFacts};
}

describe("original accepted-close numerical effect index", () => {
	it("meters a finishing window once at the original accepted-effect boundary and keeps uncertain effects protected", () => {
		const f = acceptedNumericalFixture(true), before = f.sourceFacts.capacity.readiness.window;
		const update = f.capture(f.proof, f.preimage)!;
		expect(f.sourceFacts.capacity.readiness.window).toBe(before); expect(f.accepted).toEqual([]);
		const signed = {exactCanonicalPreimageBytes: f.preimage.slice(), detachedSignature: new Uint8Array(64), exactCanonicalEpochVertexBytes: f.derivative.slice()};
		update(signed);
		const after = f.sourceFacts.capacity.readiness;
		expect(after.window).toMatchObject({acceptedActions: 1, acceptedOperationBytes: f.dimensions.candidate.exactCanonicalOperationBytes.byteLength,
			acceptedPreimageBytes: f.preimage.byteLength, acceptedEpochVertexBytes: f.derivative.byteLength});
		expect(after.geometry).toMatchObject({graphVersion: 4, acceptedCount: 1, localIssuedCount: 1});
		update(signed); expect(f.sourceFacts.capacity.readiness).toBe(after); expect(f.accepted).toHaveLength(1);
		const uncertain = acceptedNumericalFixture(true), original = uncertain.sourceFacts.capacity.material;
		uncertain.capture(uncertain.proof, uncertain.preimage)!(undefined as never);
		expect(uncertain.sourceFacts.capacity.readiness).toBeUndefined(); expect(uncertain.sourceFacts.capacity.material).toBe(original);
		expect(uncertain.accepted).toEqual([]); expect(uncertain.state.charges).toBe(0);
	});
	it("keeps protected read wrappers in their own quote, not in the next accepted-effect index", () => {
		// Actual accounting, index, accepted callback and prepared-program material
		// assembly; nominal proof/runtime ownership is controlled, not native auth.
		const proofMaterialOwners = new WeakMap<object, any>(), reader = () => undefined;
		const functions = ["projectCreatorProofMaterialByteLengths", "createCreatorClosedRollbackProofAccounting",
			"createCreatorOrdinaryFinishingMaterialIndex", "creatorOrdinaryFinishingLifetimeMaterialForSizing",
			"resolveCreatorOrdinaryNumericalDimensions", "captureCreatorOrdinaryAcceptedResourceUpdateForSizing"].map(name =>
			rollbackDeclaration(name).getText(rollbackTree).replace(/^export /, "")).join("\n");
		const blocks: ts.IfStatement[] = [];
		function visit(node: ts.Node): void {
			if (ts.isIfStatement(node) && node.expression.getText(rollbackTree) === "profile.preparedMaterial === true") blocks.push(node);
			ts.forEachChild(node, visit);
		}
		visit(rollbackDeclaration("deriveCreatorOrdinarySourceResourceProgramForSizing"));
		if (blocks.length !== 1) throw new Error(`missing actual provisional material block:${blocks.length}`);
		let activeProof: any, proofFacts: any;
		const sourceToken = {}, sourceFacts: any = {identity: {}, capacity: {}};
		const api = evaluate<any>(`${functions}\nfunction provisional(proof, facts) {
			const source=sourceFacts, options={reader}, profile={preparedMaterial:true}, parameters=new Map(), knownCarriers=[];
			${blocks[0]!.getText(rollbackTree)}
			return parameters;
		}`, "({createCreatorClosedRollbackProofAccounting,createCreatorOrdinaryFinishingMaterialIndex,captureCreatorOrdinaryAcceptedResourceUpdateForSizing,provisional})", {
			proofMaterialOwners, reader, sourceFacts, compareBytes,
			closedRetirementEqual: (a: unknown, b: unknown) => equal(encodeCanonical(a), encodeCanonical(b)),
			CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4_194_304,
			creatorOrdinaryIssuanceProofFacts: (proof: unknown) => proof === activeProof ? proofFacts : undefined,
			creatorOrdinaryIssuanceSourceFacts: (source: unknown) => source === sourceToken ? sourceFacts : undefined,
			canonicalBytesResourceForSizing: (length: number) => ({byteLength: encodeCanonical(new Uint8Array(length)).byteLength}),
			sum: (...values: number[]) => values.reduce((total, value) => total + value, 0),
		});
		const baseline = api.createCreatorClosedRollbackProofAccounting([]), baselineOwner = proofMaterialOwners.get(baseline)!;
		const raw = encodeCanonical({source: "old full signed PRE"}), scoped = encodeCanonical({source: "old native and snapshot bytes"}),
			scope = {objectId: "room", epoch: 0, anchor: "a".repeat(64), manifestDigest: "b".repeat(64)},
			ref = {digest: "c".repeat(64), byteLength: scoped.byteLength};
		expect(baseline.charge(raw)).toBe(true);
		expect(baselineOwner.chargeNativeReader({bytes: scoped, ref})).toBe(true);
		expect(baselineOwner.chargeSnapshotTarget(scoped, scope)).toBe(true);
		sourceFacts.capacity.material = api.createCreatorOrdinaryFinishingMaterialIndex(baselineOwner.captureKnownMaterial(), baselineOwner.captureKnownMaterialUses());
		sourceFacts.capacity.readiness = {reader, sourceIdentity: sourceFacts.identity,
			geometry: {graphVersion: 0, acceptedCount: 0, localIssuedCount: 0, acceptedWitnessPayloadBytes: 0}};
		const initial = sourceFacts.capacity.material;
		let acceptedBytes = 0;
		for (let ordinal = 0; ordinal < 2; ordinal++) {
			const accounting = api.createCreatorClosedRollbackProofAccounting([]), owner = proofMaterialOwners.get(accounting)!;
			const page = encodeCanonical({rows: Array.from({length: ordinal + 1}, (_, row) => ({row, payload: new Uint8Array(256)}))}),
				readback = encodeCanonical({commit: {ordinal, payload: new Uint8Array(128 + ordinal)}}),
				preimage = encodeCanonical({preimage: ordinal}), derivative = encodeCanonical({derivative: ordinal}),
				signature = new Uint8Array(64).fill(ordinal + 1);
			for (const bytes of [page, readback, preimage, derivative, signature]) expect(accounting.charge(bytes)).toBe(true);
			expect(owner.chargeNativeReader({bytes: scoped, ref})).toBe(true);
			expect(owner.chargeSnapshotTarget(scoped, scope)).toBe(true);
			expect(accounting.chargeUnknownEncodedLength(37)).toBe(true);
			expect(accounting.chargeUnknownEncodedLength(37)).toBe(true);
			activeProof = {accounting};
			const dimensions = {candidate: {exactCanonicalEpochVertexBytes: derivative},
				runtime: {graphVersion: ordinal, kind: "local-issuance"}};
			proofFacts = {source: sourceToken, numerical: {current: {unsignedBytes: preimage.slice(), value: dimensions}}, runtime: {
				readCurrentDimensions: () => {throw new Error("unexpected repeated current-dimension construction");},
				resolveCurrentDimensions: (value: unknown, bytes: Uint8Array) => value === dimensions && equal(bytes, preimage) ? value : undefined}};
			const persistentBefore = sourceFacts.capacity.material, beforeCharge = accounting.chargedBytes,
				beforeUses = owner.captureKnownMaterialUses();
			const update = api.captureCreatorOrdinaryAcceptedResourceUpdateForSizing(activeProof, preimage);
			expect(sourceFacts.capacity.material).toBe(persistentBefore);
			// A quote must use the SAME owner's numeric view, not detach the
			// protected corpus or construct a persistent accepted-effect version.
			proofMaterialOwners.set(accounting, Object.freeze({...owner,
				captureKnownProtectedMaterial: () => {throw new Error("unexpected provisional material clone");}}));
			sourceFacts.capacity.material = Object.freeze({...persistentBefore,
				appendAccepted: () => {throw new Error("unexpected provisional accepted enrollment");}});
			const projected = api.provisional(activeProof, {knownResourceTotals: owner.captureKnownResourceTotals()});
			sourceFacts.capacity.material = persistentBefore;
			const acceptedThisCall = preimage.byteLength + derivative.byteLength + signature.byteLength;
			for (const phase of ["currentTurnover", "closeAdopt", "successorJob", "serial", "cold"])
				expect(projected.get(`material.${phase}`)).toBe(raw.byteLength + scoped.byteLength + acceptedBytes + acceptedThisCall + page.byteLength + readback.byteLength);
			expect(projected.get("material.priorUnknown")).toBe(74);
			expect(accounting.chargedBytes).toBe(beforeCharge); // Numerical projection never spends/refunds.
			const signed = {exactCanonicalPreimageBytes: preimage, detachedSignature: signature, exactCanonicalEpochVertexBytes: derivative};
			update(signed); acceptedBytes += acceptedThisCall;
			const after = sourceFacts.capacity.material;
			expect(after.project()).toEqual({whole: raw.byteLength + scoped.byteLength + acceptedBytes, protected: raw.byteLength + scoped.byteLength + acceptedBytes});
			expect(after.project([scope], [])).toEqual({whole: raw.byteLength + scoped.byteLength + acceptedBytes, protected: raw.byteLength + acceptedBytes});
			update(signed); expect(sourceFacts.capacity.material).toBe(after); // Same accepted callback cannot double-enroll.
			expect(after.appendAccepted([preimage, signature, derivative]).project()).toEqual(after.project());
			expect(accounting.chargedBytes).toBe(beforeCharge); expect(owner.captureKnownResourceTotals().unknownEncodedBytes).toBe(74);
			expect(owner.captureKnownMaterialUses()).toEqual(beforeUses);
		}
		expect(initial.project([scope], [])).toEqual({whole: raw.byteLength + scoped.byteLength, protected: raw.byteLength});
	});

	it("reuses delivered numerical data through the original runtime resolver and detaches its one-use accepted fields", () => {
		const f = acceptedNumericalFixture(), before = f.state.constructions;
		const update = f.capture(f.proof, f.preimage);
		expect(update).toBeTypeOf("function"); expect(f.state.constructions).toBe(before);
		// Capturing the update copies only its accepted numerical fields. The
		// original one-use callback cannot observe a later borrowed-buffer change.
		const signed = {exactCanonicalPreimageBytes: f.preimage.slice(), detachedSignature: new Uint8Array(64).fill(3),
			exactCanonicalEpochVertexBytes: f.derivative.slice()};
		f.dimensions.candidate.exactCanonicalEpochVertexBytes.fill(9);
		f.owner.numerical.current!.unsignedBytes.fill(8);
		update!(signed); expect(f.accepted).toHaveLength(1);
		expect(f.accepted[0]).toEqual([signed.exactCanonicalPreimageBytes, signed.detachedSignature, signed.exactCanonicalEpochVertexBytes]);
		update!(signed); expect(f.accepted).toHaveLength(1); expect(f.state.constructions).toBe(before);
		expect(f.state.charges).toBe(0);
	});

	it("refuses missing, stale, mutated, foreign-candidate or revoked numerical data without reconstructing it", () => {
		for (const kind of ["missing", "candidate", "captured-candidate", "dimensions", "revoked", "source-owner",
			"source-context", "machine", "machine-identity", "base-state", "read-phase"] as const) {
			const f = acceptedNumericalFixture(); let bytes = f.preimage;
			if (kind === "missing") f.owner.numerical.current = undefined;
			if (kind === "candidate") bytes = Uint8Array.of(99);
			if (kind === "captured-candidate") f.owner.numerical.current!.unsignedBytes.fill(7);
			if (kind === "dimensions") f.dimensions.candidate.exactCanonicalEpochVertexBytes.fill(7);
			if (kind === "revoked") f.state.active = false;
			if (kind === "source-owner") f.state.sourceAvailable = false;
			if (kind === "source-context") f.state.sourceIdentity = {};
			if (kind === "machine") f.registration.blueprintMachine = {};
			if (kind === "machine-identity") f.registration.blueprintMachineIdentity = {};
			if (kind === "base-state") f.state.baseState = Uint8Array.of(99);
			if (kind === "read-phase") f.state.issuanceAvailable = false;
			expect(f.capture(f.proof, bytes), kind).toBeUndefined();
			expect(f.state.constructions, kind).toBe(1);
			expect(f.accepted, kind).toEqual([]); expect(f.state.charges, kind).toBe(0);
		}
	});

	it("revokes numerical reuse immediately at original begin/release entries and joins admitted work", async () => {
		const writing = numericalLifecycleFixture(), write = writing.api.begin();
		expect(writing.numerical.current).toBeUndefined(); expect(writing.frame.headerConsumersRevoked).toBe(true);
		expect(writing.api.state().writeStarted).toBe(false);
		await Promise.resolve(); expect(writing.events).toEqual([]);
		writing.join(); await write;
		expect(writing.api.state().writeStarted).toBe(true);
		expect(writing.events).toEqual(["read-phase-joined", "issuer-release"]);
		await writing.api.release(); expect(writing.frame.alive).toBe(false);

		const releasing = numericalLifecycleFixture(); let delivered = false;
		const release = releasing.api.release().then(() => {delivered = true;});
		expect(releasing.numerical.current).toBeUndefined(); expect(releasing.frame.alive).toBe(false);
		expect(releasing.api.state().released).toBe(true);
		await Promise.resolve(); expect(delivered).toBe(false); expect(releasing.events).toEqual([]);
		releasing.join(); await release;
		expect(delivered).toBe(true); expect(releasing.events).toEqual(["runtime-release"]);
		await expect(releasing.api.begin()).rejects.toThrow("snapshot-unavailable");
	});

	it("updates only the original retained identity and delivers detached bytes without retaining a proof owner", () => {
		const registration = {closeVertices: new Map(), closeAuthors: new Map()}, counts = new Map(), charges = new Map();
		let current = true;
		const api = evaluate<any>([declaration("retainCloseVertex"), declaration("retainedCreatorApplicationEffectForSizing")].join("\n"),
			"({retainCloseVertex,retainedCreatorApplicationEffectForSizing})", {...common,
				retainedCloseSignedCurrentAdmission: () => undefined, currentRegistration: (value: unknown) => current && value === registration});
		const vertex = Object.freeze({kind: "drp-vertex", objectId: "room", epoch: 1, hash: "a".repeat(64),
			anchor: "b".repeat(64), dependencies: ["b".repeat(64)], operation: {action: "placeBlock", payload: Uint8Array.of(7)}});
		const accepted = {digest: vertex.hash, vertex, author: "c".repeat(64), authorSequence: 0, byteCharge: 512};
		expect(registration.closeAuthors.size).toBe(0);
		api.retainCloseVertex(registration.closeVertices, registration.closeAuthors, counts, accepted, charges, true);
		const identity = registration.closeAuthors.get(vertex.hash);
		expect(identity.sourceAuthorized).toBe(true); expect(identity.applicationEffect.vertex).toBe(vertex);
		expect(Object.keys(identity.applicationEffect).sort()).toEqual(["exactCanonicalEpochVertexBytes", "vertex"]);
		const row = {digest: vertex.hash, exactCanonicalVertexBytes: encodeCanonical(vertex)};
		const first = api.retainedCreatorApplicationEffectForSizing(registration, row);
		first.fill(0); expect(api.retainedCreatorApplicationEffectForSizing(registration, row)).toEqual(encodeCanonical(vertex));
		registration.closeVertices.set(vertex.hash, {...vertex});
		expect(api.retainedCreatorApplicationEffectForSizing(registration, row)).toBeUndefined();
		registration.closeVertices.set(vertex.hash, vertex); current = false;
		expect(api.retainedCreatorApplicationEffectForSizing(registration, row)).toBeUndefined();
	});
	it("preserves journal/native append-only identity and permits only appended original classified controls", () => {
		const matches = evaluate<any>(declaration("ordinaryApplicationResourceCursorMatches"), "ordinaryApplicationResourceCursorMatches", {});
		const registration = {}, index = {}, sourceIdentity = {}, prior = {registration,index,sourceIdentity,graphVersion:1,
			controlDigests:["control0"], journal:[{digest:"row0",sequence:0,sourceKind:"received"}], issued:new Map([["key0","signature0"]])};
		const next = {...prior, graphVersion:2, controlDigests:["control0","control1"],
			journal:[...prior.journal,{digest:"control1",sequence:1,sourceKind:"received"}],issued:new Map([...prior.issued,["key1","signature1"] as const])};
		expect(matches(prior,next)).toBe(true);
		for (const value of [{...next,sourceIdentity:{}},{...next,index:{}},{...next,registration:{}},
			{...next,controlDigests:["control1"]},{...next,journal:[{...prior.journal[0],digest:"changed"}]},
			{...next,issued:new Map([["key0","different"]])}]) expect(matches(prior,value)).toBe(false);
	});
	it("requires fresh original linked-effect verification and terminal plans rather than excluding V1 by profile", () => {
		const registration = {graphVersion:1,pendingIngress:new Map(),pendingIngressBytes:0,drainingPendingIngress:false,
			index:{},controlVertices:new Set(),issuanceScope:{objectId:"room",author:"local"}};
		const native = {rows:{plans:[{entries:[{disposition:"rebase",replacementSequence:4}]}],lineages:[],issued:[]}};
		const current = {value:{runtime:{graphVersion:1},currentSignedPreimagesHaveSettlementSource:true}};
		let checks = 0;
		const make = (linked: unknown, rows: any = native) => evaluate<any>(`const applicationCursorFacts=${nestedExpression("applicationCursorFacts")};`,
			"applicationCursorFacts", {...common,facts:{check:()=>checks++,currentDimensions:current},registration,
				issuanceBorrowAvailable:true,nativeIssuanceCapture:rows,currentJournalCapture:[],sourceLinkedApplicationCapture:linked,
				creatorOrdinaryIssuanceSourceIdentity:()=>registration,lowerHexDigest:()=>"digest",hashDomain:()=>new Uint8Array(32)});
		expect(make(undefined)()).toBeUndefined();
		expect(make({effects:[],completedNative:[]})()).toBeDefined();
		expect(make({effects:[],completedNative:[]},{rows:{...native.rows,plans:[{entries:[{disposition:"rebase",replacementSequence:null}]}]}})()).toBeUndefined();
		registration.pendingIngress.set("root",{});
		expect(make({effects:[],completedNative:[]})()).toBeUndefined(); expect(checks).toBe(4);
	});
	it("uses only matched accepted effects for a received suffix and retains control PRE outside the APP delta", () => {
		const accepted = {kind:"drp-vertex",operation:{action:"placeBlock",payload:Uint8Array.of(8)}}, bytes=encodeCanonical(accepted);
		const rows=[{digest:"app",exactCanonicalVertexBytes:bytes},{digest:"control",exactCanonicalVertexBytes:encodeCanonical({kind:"drp-vertex",operation:{action:"$drp.author-fence.v1"}})}];
		const registration={controlVertices:new Set(["control"])}, prior={journal:[],issued:new Map()}, cursor={}, lifetime={};
		let checks=0, unavailable=false;
		const read = evaluate<any>(`const read=${nestedExpression("readApplicationResourceDelta")};`,"read",{...common,
			lifetime,registration,ordinaryApplicationResourceCursors:new Map([[cursor,prior]]),applicationCursorFacts:()=>({}),
			ordinaryApplicationResourceCursorMatches:()=>true,currentJournalCapture:rows,nativeIssuanceCapture:{rows:{issued:[]}},
			retainedCreatorApplicationEffectForSizing:(_owner:unknown,row:any)=>unavailable?undefined:row.exactCanonicalVertexBytes.slice(),
			facts:{check:()=>checks++}});
		const delta=read.call(lifetime,cursor);expect(delta).toEqual([bytes]);expect(checks).toBe(1);
		expect((decodeCanonical(delta[0]) as {operation: unknown}).operation).toEqual(accepted.operation);delta[0].fill(0);expect(rows[0]!.exactCanonicalVertexBytes).toEqual(bytes);
		unavailable=true;expect(read.call(lifetime,cursor)).toBeUndefined();
	});
	it("does not omit an issued-only signed fence without positive original control execution correspondence", () => {
		const scope={objectId:"room",author:"local"}, row={...scope,authorSequence:0,canonicalPreimageBytes:Uint8Array.of(1),
			digest:Uint8Array.of(2),signature:new Uint8Array(64)}, cursor={},lifetime={},prior={journal:[],issued:new Map()};
		const native={rows:{issued:[row],outbox:[{...scope,authorSequence:0,digest:row.digest,publishState:"pending"}]}},
			verified={digest:"digest",admitted:{},vertex:{operation:{action:"$drp.author-fence.v1"}}};
		let qualified=false;
		const read=evaluate<any>(`const read=${nestedExpression("readApplicationResourceDelta")};`,"read",{...common,lifetime,
			registration:{payload:{},authorization:{},controlVertices:new Set()},trust:{profileId:"creator-trusted-settlement-v1"},
			ordinaryApplicationResourceCursors:new Map([[cursor,prior]]),applicationCursorFacts:()=>({}),ordinaryApplicationResourceCursorMatches:()=>true,
			currentJournalCapture:[],nativeIssuanceCapture:native,authenticateRecoveryVertex:()=>verified,lowerHexDigest:()=>"digest",
			isControlOperation:()=>true,sameScope:(a:any,b:any)=>a.objectId===b.objectId&&a.author===b.author,
			creatorOrdinaryNativeControlApplicationFactForSizing:()=>qualified?{}:undefined,facts:{check:()=>{}}});
		expect(read.call(lifetime,cursor)).toBeUndefined();qualified=true;expect(read.call(lifetime,cursor)).toEqual([]);
	});
	it("shares every original control qualifier with cold capture, including exact native uniqueness and zero original intents", () => {
		const scope={objectId:"room",author:"local"}, issued={...scope,authorSequence:0,canonicalPreimageBytes:Uint8Array.of(1),
			digest:Uint8Array.of(2),signature:new Uint8Array(64)}, outbox={...scope,authorSequence:0,digest:issued.digest,publishState:"published"};
		const payload={trust:{trust:{profileId:"creator-trusted-settlement-v1"}}},context={payload};
		let valid=true,intents:unknown[]|undefined=[],classified:any={kind:"current",authenticated:{admitted:{},vertex:{operation:{action:"$drp.author-fence.v1"}}}};
		const qualify=evaluate<any>(declaration("creatorOrdinaryNativeControlApplicationFactForSizing"),"creatorOrdinaryNativeControlApplicationFactForSizing",{
			...common,classifyRebaseRow:()=>classified,validRebaseRow:()=>valid,isControlOperation:()=>true,rebaseIntents:(p:unknown)=>{expect(p).toBe(payload);return intents;}});
		const native={issued:[issued]};expect(qualify(context,native,outbox)).toBeDefined();
		valid=false;expect(qualify(context,native,outbox)).toBeUndefined();valid=true;
		intents=[{}];expect(qualify(context,native,outbox)).toBeUndefined();intents=undefined;expect(qualify(context,native,outbox)).toBeUndefined();
		intents=[];classified={...classified,authenticated:{...classified.authenticated,admitted:{settlementSource:{}}}};
		expect(qualify(context,native,outbox)).toBeUndefined();expect(qualify(context,{issued:[issued,issued]},outbox)).toBeUndefined();
	});
});
