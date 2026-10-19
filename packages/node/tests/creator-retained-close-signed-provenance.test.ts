import {readFileSync} from "node:fs";
import {generateKeyPairSync, sign} from "node:crypto";
import {compareBytes, decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {copyCanonicalForAdmittedView} from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import {verifyEd25519RegisteredDigest} from "../../protocol-v3/src/index.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// These execute the original private retained/replay bodies with controlled
// registration/native/ABI responses and real canonical/signature primitives.
// They do NOT mint genuine runtime/native/blueprint capabilities. Original
// corruption-and-continuation native scenarios remain the acceptance oracle.
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true);
const runtimeTree = ts.createSourceFile("runtime-reclamation.ts",
	readFileSync(new URL("../src/internal/runtime-reclamation.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const projectionMatch = runtimeTree.statements.find((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "creatorAuthenticatedEpochVertexFields");
if (projectionMatch === undefined) throw new Error("missing original authenticated vertex projection");
const projection: ts.FunctionDeclaration = projectionMatch;
function declaration(name: string): string {
	const node = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (node === undefined) throw new Error(`missing original retained owner: ${name}`);
	return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const code = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${code}`)(bindings) as T;
}
type RetainedIdentity = {author: string; authorSequence: number; sourceAuthorized?: true; signedCurrent?: Function;
	applicationEffect?: {vertex: any; exactCanonicalEpochVertexBytes: Uint8Array}};
type SignedRow = {canonicalPreimageBytes: Uint8Array; signature: Uint8Array; digest: Uint8Array; author: string; authorSequence: number; objectId: string};
function fixture(profile = "creator-trusted-v1") {
	const domain = "ts-drp/vertex/v3", suite = "ed25519-registered-digest-v1", pair = generateKeyPairSync("ed25519"),
		key = Uint8Array.from(pair.publicKey.export({type: "spki", format: "der"}).subarray(-32));
	const author = Buffer.from(key).toString("hex"), anchor = "a".repeat(64);
	const raw = {kind: "drp-vertex", protocolMajor: 3, objectId: "room", epoch: 1, anchor, author,
		authorSequence: 0, logicalTime: 1, dependencies: [anchor], operation: {action: "placeBlock", bytes: Uint8Array.of(3),
			map: new Map([["nested", new Set([3])]])}};
	const bytes = encodeCanonical(raw), digest = hashDomain(domain, bytes), signature = Uint8Array.from(sign(null, digest, pair.privateKey));
	const state = {active: true, allowed: true, abi: true, format: "raw", key, revoked: false, calls: 0, keyReads: 0,
		trackEncoding: false, reconstructedEncodes: 0, retainedGraphEncodes: 0, reconstructedBytes: 0, retainedGraphBytes: 0};
	const authorization = {}, payload = {admission: {}, provenance: {objectId: "room", epoch: 1, anchorDigest: anchor},
		trust: {trust: {profileId: profile}}, parameters: {maxEpochBytes: 65536, maxEpochVertices: 128},
		input: {exactCanonicalAnchorPreimageBytes: Uint8Array.of(1)}};
	const closeVertices = new Map<string, any>([[anchor, {kind: "drp-epoch-anchor", objectId: "room", epoch: 1, hash: anchor, dependencies: []}]]),
		closeAuthors = new Map<string, RetainedIdentity>(), closeCharges = new Map<string, number>([[anchor, 1]]);
	const authorVertexCounts = new Map<string, number>();
	const nativeReads = {readiness: 0, pages: 0, issued: 0}, charges: Uint8Array[] = [], rows: any[] = [];
	const issued = new Map<number, SignedRow>();
	const observedEncode = (value: unknown, limits?: Parameters<typeof encodeCanonical>[1]) => {
		const encoded = encodeCanonical(value, limits);
		if (state.trackEncoding && value !== null && typeof value === "object" &&
			(value as any).kind === "drp-vertex" && (value as any).hash === Buffer.from(digest).toString("hex")) {
			if (value === closeVertices.get((value as any).hash)) {state.retainedGraphEncodes++; state.retainedGraphBytes += encoded.byteLength;}
			else {state.reconstructedEncodes++; state.reconstructedBytes += encoded.byteLength;}
		}
		return encoded;
	};
	const registration = {payload, authorization, closeVertices, closeAuthors, closeCharges,
		index: {has: (value: string) => value === anchor || closeVertices.has(value)},
		liveJournalStore: {
			readiness: async () => {nativeReads.readiness++; return {ok: true, ready: true, scope: {objectId: "room", epoch: 1, anchorDigest: anchor}, rowCount: rows.length, snapshot: {version: 1}};},
			readPage: async () => {nativeReads.pages++; return {ok: true, rows, nextSequence: null};},
		},
		issuanceStore: {readIssued: async (_scope: unknown, sequence: number) => {nativeReads.issued++; return issued.get(sequence) ?? null;}},
	};
	const originalExtract = (input: {receivedCanonicalPreimageBytes: Uint8Array; signature: Uint8Array; resolveAuthorPublicKey(author: string): {bytes: Uint8Array; format: string} | undefined}) => {
		state.calls++; const value = decodeCanonical(input.receivedCanonicalPreimageBytes) as typeof raw;
		const resolved = input.resolveAuthorPublicKey(value.author);
		if (!state.abi || resolved?.format !== "raw" || !verifyEd25519RegisteredDigest(input.signature, hashDomain(domain, input.receivedCanonicalPreimageBytes), resolved.bytes))
			return {ok: false, reason: "not-authenticated"};
		return {ok: true, vertex: Object.freeze({...copyCanonicalForAdmittedView(value, true) as typeof raw, digest: hashDomain(domain, input.receivedCanonicalPreimageBytes)})};
	};
	const runtime = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "resolveOrdinaryIssuanceRuntimeHold");
	if (runtime === undefined) throw new Error("missing original runtime owner");
	const properties: ts.PropertyAssignment[] = [];
	const visit = (node: ts.Node): void => {if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "checkCurrentOrdinaryWork") properties.push(node); ts.forEachChild(node, visit);};
	visit(runtime); if (properties.length !== 1) throw new Error("missing original current-work method");
	const api = execute<{
		authenticate(payload: any, authorization: object, bytes: Uint8Array, signature: Uint8Array, facts?: unknown, retained?: {value?: any}): any;
		retain(vertices: Map<string, any>, authors: Map<string, RetainedIdentity>, counts: Map<string, number>, authenticated: any,
			charges: Map<string, number>, sourceAuthorized?: boolean, signed?: any,
			facts?: {retainVerification(fact: unknown): void}): void;
		read(registration: any, bytes: Uint8Array, signature: Uint8Array, digest: string, derivative?: {value?: any}): any;
		copy(authors: Map<string, RetainedIdentity>): Map<string, RetainedIdentity> | undefined;
		replay(registration: any, sealed?: unknown, accounting?: {charge(bytes: Uint8Array): boolean}, retainedOwner?: any,
			nativeRows?: readonly unknown[], capture?: {value?: {rows: readonly unknown[]; vertices: readonly {author: string; hasSettlementSource: boolean}[]}},
			nativeReplay?: {rows: readonly unknown[]; issued: readonly SignedRow[]}): Promise<any[] | undefined>;
		work(row: SignedRow): boolean;
	}>(`
		${projection.getText(runtimeTree).replace(/^export /, "")}
		${["extractAuthorizedV3Vertex", "authenticateRecoveryVertex", "authenticatedRecoveryVertex", "retainedCloseSignedCurrentAdmission",
			"readRetainedCloseSignedCurrentAdmission", "retainCloseVertex", "copyCloseAuthors", "readCreatorReplayRows"].map(declaration).join("\n")}
		const lifetime = {checkCurrentOrdinaryWork: ${properties[0]!.initializer.getText(tree)}};
		return {authenticate: authenticateRecoveryVertex, retain: retainCloseVertex, read: readRetainedCloseSignedCurrentAdmission,
			copy: copyCloseAuthors, replay: readCreatorReplayRows, work: row => lifetime.checkCurrentOrdinaryWork(row)};`, {
		registration, facts: {check: () => {if (state.revoked) throw new Error("original-runtime-revoked");}},
		V3_VERTEX_DOMAIN: domain, V3_VERTEX_SUITE_ID: suite, vertexRegistry: {domain},
		currentRegistration: (owner: unknown) => owner === registration && state.active,
		resolveV3AuthorizedAuthor: (_authorization: unknown, selected: string) => {
			state.keyReads++; return state.allowed && selected === author ? {bytes: state.key, format: state.format} : undefined;
		},
		extractAdmittedReceivedVertex: originalExtract,
		classifyV3EnvelopeScope: (a: any, b: any) => ({current: a.objectId === b.objectId && a.epoch === b.epoch && a.anchor === b.anchorDigest}),
		copyCanonicalForAdmittedView, copyDetachedBytes: (bytes: Uint8Array) => Uint8Array.from(bytes),
		Uint8ArrayConstructor: Uint8Array, ObjectFreeze: Object.freeze, ObjectDefineProperty: Object.defineProperty,
		hashDomain, encodeCanonical: observedEncode, decodeCanonical,
		lowerHexDigest: (value: unknown) => value instanceof Uint8Array && value.byteLength === 32 ? Buffer.from(value).toString("hex") : undefined,
		sameBytes: (left: Uint8Array, right: Uint8Array) => compareBytes(left, right) === 0,
		IntrinsicMap: Map, MapPrototypeGet: Map.prototype.get, MapPrototypeSet: Map.prototype.set, MapPrototypeEntries: Map.prototype.entries,
		ReflectApply: Reflect.apply, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
		isObject: (value: unknown) => value !== null && typeof value === "object",
		ArrayIsArray: Array.isArray,
		nextCapturedMapIterator: (iterator: Iterator<unknown>) => iterator.next(),
		settlementSourceByVertex: new WeakMap(),
		liveJournalScope: () => ({objectId: "room", epoch: 1, anchorDigest: anchor}), NumberIsSafeInteger: Number.isSafeInteger,
		sameLiveJournalScope: (a: any, b: any) => a.objectId === b.objectId && a.epoch === b.epoch && a.anchorDigest === b.anchorDigest,
		journalRowSnapshot: (value: any, _scope: unknown, expected: number) => value.journalSequence === expected ? value : undefined,
		outboxRowSnapshot: (value: {commit: SignedRow | null}) => value.commit ?? undefined,
		envelopeSnapshot: (value: Pick<SignedRow,"canonicalPreimageBytes"|"signature"|"digest">) => ({canonicalPreimageBytes: value.canonicalPreimageBytes.slice(),
			signature: value.signature.slice(), digest: value.digest.slice()}),
		sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
		hasBoundedDependencies: () => true,
	});
	const row: SignedRow = {canonicalPreimageBytes: bytes, signature, digest, author, authorSequence: 0, objectId: "room"};
	const install = (sourceAuthorized = false) => {
		const retained: {value?: any} = {}, authenticated = api.authenticate(payload, authorization, bytes, signature, undefined, retained);
		if (authenticated === undefined) throw new Error("controlled original authentication failed");
		api.retain(closeVertices, closeAuthors, authorVertexCounts, authenticated, closeCharges, sourceAuthorized, retained.value);
		return {retained, authenticated};
	};
	const keyOf = () => Buffer.from(digest).toString("hex");
	const received = () => rows.push({sourceKind: "received", journalSequence: rows.length, vertexDigest: keyOf(), exactCanonicalPreimageBytes: bytes, detachedSignature: signature});
	const local = () => {issued.set(0, row); rows.push({sourceKind: "local-issued", journalSequence: rows.length, vertexDigest: keyOf(), author, authorSequence: 0});};
	return {api, state, payload, authorization, registration, bytes, signature, digest, raw, author, row, keyOf, install,
		closeVertices, closeAuthors, closeCharges, authorVertexCounts, rows, nativeReads, charges, received, local,
		accounting: {charge: (bytes: Uint8Array) => {charges.push(bytes.slice()); return true;}}};
}

describe("original ordinary captured journal book DATA", () => {
	it("enrolls only through the private producer, binds the exact runtime and never carries paid credit", () => {
		const source=readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url),"utf8"),
			tree=ts.createSourceFile("rollback.ts",source,ts.ScriptTarget.Latest,true), owners=new WeakMap<object,any>();
		const declarations=["createCreatorClosedRollbackProofAccounting","readCreatorOrdinaryCapturedJournalReplay"].map(name=>{
			const node=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
			if(!node)throw Error("original captured journal producer absent"); return node.getText(tree).replace(/^export /,"");
		}).join("\n");
		const api=execute<any>(declarations+"\nreturn {create:createCreatorClosedRollbackProofAccounting,read:readCreatorOrdinaryCapturedJournalReplay};",{
			proofMaterialOwners:owners,CREATOR_ORDINARY_PROOF_MAX_BYTES:1310720,CREATOR_MAINTENANCE_PROOF_MAX_BYTES:4194304,compareBytes,
			closedRetirementEqual:(a:unknown,b:unknown)=>compareBytes(encodeCanonical(a),encodeCanonical(b))===0,
		});
		const runtime={}, book=api.create([]); expect(api.read(book,runtime)).toBeUndefined();
		expect(api.read({...book},runtime)).toBeUndefined(); expect(book.bindOrdinaryJournalCapture).toBeUndefined();
		let available=true; const rows=[{scope:{objectId:"room",epoch:1,anchorDigest:"a".repeat(64)},journalSequence:0,
			sourceKind:"received",vertexDigest:"b".repeat(64),exactCanonicalPreimageBytes:Uint8Array.of(1,2),detachedSignature:new Uint8Array(64)}];
		const revoke=owners.get(book).bindOrdinaryJournalCapture({runtime,rows,nativeImageDigest:"image",available:()=>available});
		expect(api.read(book,{})).toBeNull(); const captured=api.read(book,runtime);
		expect(captured.rows).toEqual(rows); expect(captured.rows).not.toBe(rows); expect(captured.rows[0].scope).not.toBe(rows[0].scope);
		captured.rows[0].exactCanonicalPreimageBytes.fill(9); captured.rows[0].detachedSignature.fill(9);
		expect(api.read(book,runtime).rows).toEqual(rows); expect(book.chargedBytes).toBe(0);
		available=false; expect(api.read(book,runtime)).toBeNull(); available=true;
		revoke(); expect(api.read(book,runtime)).toBeNull();
		expect(()=>owners.get(book).bindOrdinaryJournalCapture({runtime,rows,nativeImageDigest:"image",available:()=>true})).toThrow("already captured");
		const interrupted=api.create([]);let stop=()=>{};
		stop=owners.get(interrupted).bindOrdinaryJournalCapture({runtime,rows,nativeImageDigest:"image",available:()=>{stop();return true;}});
		expect(api.read(interrupted,runtime)).toBeNull();
	});
});

describe("original retained-close signed provenance (no native authority)", () => {
	it("enrolls a pure verification fact only from the original successful signed-admission matcher", () => {
		const f = fixture(), retained: {value?: any} = {}, captured: unknown[] = [];
		const authenticated = f.api.authenticate(f.payload, f.authorization, f.bytes, f.signature, undefined, retained);
		expect(authenticated).toBeDefined(); expect(f.state.calls).toBe(1);
		const facts = {retainVerification: (fact: unknown) => {captured.push(fact);}};
		const retain = (signed: unknown, source = false) => f.api.retain(f.closeVertices, f.closeAuthors,
			f.authorVertexCounts, authenticated, f.closeCharges, source, signed, facts);
		retain({...retained.value, originalAdmitted: {...authenticated.admitted}});
		retain(undefined); retain(retained.value, true);
		expect(captured).toHaveLength(0);
		retain(retained.value);
		expect(captured).toEqual([retained.value]); expect(f.state.calls).toBe(1);
	});
	it("reuses the exact signed derivative while keeping one fresh graph encoding and all original charges", async () => {
		for (const kind of ["received", "local"] as const) {
			const f = fixture(); f.install(); f[kind](); f.state.trackEncoding = true;
			const result = await f.api.replay(f.registration, undefined, f.accounting, f.registration);
			expect(result).toHaveLength(1);
			expect(f.state.reconstructedEncodes, kind).toBe(0);
			expect(f.state.retainedGraphEncodes, kind).toBe(1);
			expect(f.state.retainedGraphBytes).toBe(result![0].exactCanonicalVertexBytes.byteLength);
			expect(f.nativeReads).toEqual({readiness: 1, pages: 1, issued: kind === "local" ? 1 : 0});
			for (const bytes of [f.bytes, f.signature, result![0].exactCanonicalVertexBytes])
				expect(f.charges.some(value => compareBytes(value, bytes) === 0)).toBe(true);
			expect(f.state.calls).toBe(1); // Original extraction at install, fresh matcher/key checks at replay.
		}
	});

	it("delivers derivative DATA only for the exact fresh matched return and detaches every byte delivery", () => {
		const f = fixture(); f.install(); const capture: {value?: any} = {}, effect = f.closeAuthors.get(f.keyOf())!.applicationEffect!,
			expected = effect.exactCanonicalEpochVertexBytes.slice();
		const verified = f.api.read(f.registration, f.bytes, f.signature, f.keyOf(), capture);
		expect(capture.value.authenticated).toBe(verified);
		expect(capture.value.exactCanonicalVertexBytes).toEqual(expected);
		expect(capture.value.exactCanonicalVertexBytes).not.toBe(effect.exactCanonicalEpochVertexBytes);
		capture.value.exactCanonicalVertexBytes.fill(0); verified.vertex.operation.bytes.fill(99);
		const next = f.api.read(f.registration, f.bytes, f.signature, f.keyOf(), capture);
		expect(capture.value.authenticated).toBe(next);
		expect(capture.value.exactCanonicalVertexBytes).toEqual(expected);
		expect(effect.exactCanonicalEpochVertexBytes).toEqual(expected);
		f.state.allowed = false;
		expect(f.api.read(f.registration, f.bytes, f.signature, f.keyOf(), capture)).toBeUndefined();
		expect(capture.value).toBeUndefined(); // Never expose an earlier successful invocation after refusal.
	});

	it("falls back to original encoding for replaced identities/effects, missing facts and reopen copies", async () => {
		for (const change of ["identity", "effect", "graph", "missing-effect", "reopen", "source-authorized"] as const) {
			const f = fixture(); f.install(change === "source-authorized"); f.received();
			const original = f.closeAuthors.get(f.keyOf())!, effect = original.applicationEffect!;
			if (change === "identity") f.closeAuthors.set(f.keyOf(), {...original});
			if (change === "effect") f.closeAuthors.set(f.keyOf(), {...original, applicationEffect: {...effect}});
			if (change === "graph") f.closeVertices.set(f.keyOf(), {...effect.vertex});
			if (change === "missing-effect") {const {applicationEffect: _effect, ...rest} = original; f.closeAuthors.set(f.keyOf(), rest);}
			if (change === "reopen") f.closeAuthors.set(f.keyOf(), f.api.copy(f.closeAuthors)!.get(f.keyOf())!);
			f.state.trackEncoding = true;
			expect(await f.api.replay(f.registration, undefined, f.accounting, f.registration), change).toHaveLength(1);
			expect(f.state.reconstructedEncodes, change).toBe(1);
			expect(f.state.retainedGraphEncodes, change).toBe(1);
		}
	});

	it("still detects mutable retained graph leaves before successful replay delivery", async () => {
		for (const change of ["bytes", "map", "set"] as const) {
			const f = fixture(); f.install(); f.received();
			const vertex = f.closeVertices.get(f.keyOf());
			if (change === "bytes") vertex.operation.bytes[0] ^= 1;
			if (change === "map") vertex.operation.map.set("injected", new Set([99]));
			if (change === "set") vertex.operation.map.get("nested").add(99);
			f.state.trackEncoding = true;
			expect(await f.api.replay(f.registration, undefined, f.accounting, f.registration), change).toBeUndefined();
			expect(f.state.reconstructedEncodes, change).toBe(0);
			expect(f.state.retainedGraphEncodes, change).toBe(1);
		}
	});

	it("copies derivative bytes at both original accepted-callback delivery sites", () => {
		const deliveries: ts.ExpressionStatement[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
				node.expression.expression.getText(tree) === "maintenanceAdmission?.accepted") deliveries.push(node);
			ts.forEachChild(node, visit);
		};
		visit(tree); expect(deliveries).toHaveLength(2);
		for (const statement of deliveries) {
			const bytes = encodeCanonical({operation: {bytes: Uint8Array.of(3)}}), expected = bytes.slice(),
				acceptedEffect = {exactCanonicalEpochVertexBytes: bytes};
			let delivered: any;
			execute(statement.getText(tree), {acceptedEffect, appended: {}, Uint8ArrayConstructor: Uint8Array,
				evidence: {exactCanonicalPreimageBytes: Uint8Array.of(1), signature: Uint8Array.of(2)},
				row: {canonicalPreimageBytes: Uint8Array.of(1), signature: Uint8Array.of(2)},
				maintenanceAdmission: {accepted: (value: any) => {delivered = value; value.exactCanonicalEpochVertexBytes.fill(99);}}});
			expect(delivered.exactCanonicalEpochVertexBytes).not.toBe(bytes);
			expect(bytes).toEqual(expected);
		}
	});

	it("verifies the original signed/graph/physical tuples from one captured native source without semantic rereads", async () => {
		for (const kind of ["received", "local"] as const) {
			const f = fixture(); f.install(); f[kind]();
			const physical = f.rows.map(row => ({...row, scope: {objectId:"room",epoch:1,anchorDigest:f.raw.anchor}}));
			const capture: any = {}, source = {rows: physical, issued: [f.row]};
			const result = await f.api.replay(f.registration, undefined, f.accounting, f.registration, physical, capture, source);
			expect(result).toHaveLength(1); expect(capture.value.rows).toBe(result);
			expect(f.nativeReads).toEqual({readiness:0,pages:0,issued:0});
			for (const bytes of [f.bytes,f.signature,encodeCanonical(f.closeVertices.get(f.keyOf()))])
				expect(f.charges.some(value=>compareBytes(value,bytes)===0)).toBe(true);
			const before=f.state.keyReads; f.state.allowed=false;
			expect(await f.api.replay(f.registration,undefined,f.accounting,f.registration,physical,capture,source)).toBeUndefined();
			expect(f.state.keyReads).toBeGreaterThan(before); expect(capture.value).toBeUndefined();
		}
	});
	it("refuses captured native tuple conflicts, missing or duplicate issued leaves, and altered signatures", async () => {
		for (const corruption of ["physical-kind","signature","missing-issued","duplicate-issued"] as const) {
			const f=fixture(); f.install(); f.local();
			const physical=f.rows.map(row=>({...row,scope:{objectId:"room",epoch:1,anchorDigest:f.raw.anchor}}));
			const capture:any={}, source:any={rows:physical.map(row=>({...row})),issued:[f.row]};
			if(corruption==="physical-kind")source.rows=[{scope:physical[0].scope,journalSequence:0,sourceKind:"received",vertexDigest:f.keyOf(),exactCanonicalPreimageBytes:f.bytes,detachedSignature:f.signature}];
			if(corruption==="signature")source.issued=[{...f.row,signature:new Uint8Array(64)}];
			if(corruption==="missing-issued")source.issued=[];
			if(corruption==="duplicate-issued")source.issued=[f.row,f.row];
			expect(await f.api.replay(f.registration,undefined,f.accounting,f.registration,physical,capture,source)).toBeUndefined();
			expect(capture.value).toBeUndefined(); expect(f.nativeReads).toEqual({readiness:0,pages:0,issued:0});
		}
	});
	it("publishes detached primitive replay metadata only after complete physical/authenticated correspondence", async () => {
		for (const received of [false, true]) {
			const f = fixture(), capture: any = {}; f.install(); if (received) f.received(); else f.local();
			const result = await f.api.replay(f.registration, undefined, f.accounting, f.registration, undefined, capture);
			expect(capture.value.rows).toBe(result);
			expect(capture.value.vertices).toEqual([{author: f.author, hasSettlementSource: false}]);
			expect(Object.isFrozen(capture.value.vertices)).toBe(true); expect(Object.isFrozen(capture.value.vertices[0])).toBe(true);
			expect(f.state.calls).toBe(1); // Exact retained crypto fact, original fresh role/key checks still run.
			f.rows[0].vertexDigest = "f".repeat(64);
			expect(await f.api.replay(f.registration, undefined, f.accounting, f.registration, undefined, capture)).toBeUndefined();
			expect(capture.value).toBeUndefined(); // No partial or prior-call metadata escapes a refusal.
		}
	});
	it("reuses exactly admitted signed current data under NONE and V1 while fresh key resolution still runs", () => {
		for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1"]) {
			const f = fixture(profile); f.install(); const before = f.state.keyReads;
			expect(f.api.work(f.row)).toBe(true); expect(f.state.calls).toBe(1); expect(f.state.keyReads).toBeGreaterThan(before);
			expect(f.api.read(f.registration, f.bytes.slice(), f.signature.slice(), f.keyOf())?.digest).toBe(f.keyOf());
		}
	});

	it("keeps complete fresh received/local-issued reads and all PRE/signature/derivative charges", async () => {
		for (const kind of ["received", "local"] as const) {
			const f = fixture(); f.install(); f[kind]();
			expect(await f.api.replay(f.registration, undefined, f.accounting, f.registration)).toHaveLength(1);
			expect(f.state.calls).toBe(1); expect(f.nativeReads).toEqual({readiness: 1, pages: 1, issued: kind === "local" ? 1 : 0});
			expect(f.charges.some(value => compareBytes(value, f.bytes) === 0)).toBe(true);
			expect(f.charges.some(value => compareBytes(value, f.signature) === 0)).toBe(true);
			expect(f.charges.some(value => compareBytes(value, encodeCanonical(f.closeVertices.get(f.keyOf()))) === 0)).toBe(true);
		}
	});

	it("refuses a received page substituted for an independently captured local native tuple despite genuine signed bytes", async () => {
		const f = fixture(); f.install(); f.local();
		// Controlled independent physical capture, not a native reservation or
		// authentication grant. The actual replay body still reads fresh pages.
		const nativeRows = [{...f.rows[0], scope:{objectId:"room",epoch:1,anchorDigest:f.raw.anchor}}];
		const original = f.rows[0];
		expect(await f.api.replay(f.registration,undefined,f.accounting,f.registration,nativeRows)).toHaveLength(1);
		f.rows[0] = {journalSequence:0,sourceKind:"received",vertexDigest:f.keyOf(),
			exactCanonicalPreimageBytes:f.bytes.slice(),detachedSignature:f.signature.slice()};
		expect(await f.api.replay(f.registration,undefined,f.accounting,f.registration,nativeRows)).toBeUndefined();
		expect(f.state.calls).toBe(1); // Exact signed provenance is not physical source-kind correspondence.
		f.rows[0] = original;
		expect(await f.api.replay(f.registration,undefined,f.accounting,f.registration,nativeRows)).toHaveLength(1);
		expect(f.nativeReads).toEqual({readiness:3,pages:3,issued:2});
		expect(f.charges.some(bytes => compareBytes(bytes,f.bytes) === 0)).toBe(true);
		expect(f.charges.some(bytes => compareBytes(bytes,f.signature) === 0)).toBe(true);
	});

	it("authenticates an unretained issued leaf even when it is absent from the journal", () => {
		const f = fixture(); expect(f.api.work(f.row)).toBe(true); expect(f.state.calls).toBe(1);
		expect(f.closeAuthors.size).toBe(0); expect(f.rows).toHaveLength(0);
	});

	it("does not infer signature provenance from the accepted graph or stripped identity copies", () => {
		const f = fixture(); f.install(); const copied = f.api.copy(f.closeAuthors)!;
		expect(Object.keys(copied.get(f.keyOf())!).sort()).toEqual(["author", "authorSequence"]);
		f.closeAuthors.set(f.keyOf(), copied.get(f.keyOf())!);
		expect(f.api.work(f.row)).toBe(true); expect(f.state.calls).toBe(2);
	});

	it("keeps source-authorized work on its original verifier and does not retain portable-selection permission", () => {
		const f = fixture(); f.install(true);
		expect(f.closeAuthors.get(f.keyOf())?.signedCurrent).toBeUndefined();
		expect(f.api.read(f.registration, f.bytes, f.signature, f.keyOf())).toBeUndefined();
		expect(f.api.work(f.row)).toBe(false); expect(f.state.calls).toBe(2);
	});

	it("changed exact signature/PRE, author membership, key, format or current context refuses reuse", () => {
		for (const change of ["signature", "preimage", "membership", "key", "format", "payload", "authorization", "admission", "profile", "epoch", "anchor", "inactive"] as const) {
			const f = fixture(); f.install(); let bytes = f.bytes, signature = f.signature;
			switch (change) {
				case "signature": signature = signature.slice(); signature[0] ^= 1; break;
				case "preimage": bytes = encodeCanonical({...f.raw, logicalTime: 2}); break;
				case "membership": f.state.allowed = false; break;
				case "key": f.state.key = Uint8Array.from(generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "der"}).subarray(-32)); break;
				case "format": f.state.format = "spki"; break;
				case "payload": f.registration.payload = {...f.payload}; break;
				case "authorization": f.registration.authorization = {}; break;
				case "admission": f.payload.admission = {}; break;
				case "profile": f.payload.trust.trust.profileId = "different"; break;
				case "epoch": f.payload.provenance.epoch++; break;
				case "anchor": f.payload.provenance.anchorDigest = "b".repeat(64); break;
				case "inactive": f.state.active = false; break;
			}
			expect(f.api.read(f.registration, bytes, signature, f.keyOf()), change).toBeUndefined();
		}
	});

	it("native post-admission signature corruption reaches original verification and refuses replay", async () => {
		const f = fixture(); f.install(); f.received(); const signature = f.signature.slice(); signature[0] ^= 1;
		f.rows[0].detachedSignature = signature;
		expect(await f.api.replay(f.registration, undefined, f.accounting, f.registration)).toBeUndefined(); expect(f.state.calls).toBe(2);
	});

	it("input mutation after original extraction cannot alter the captured signed fact", () => {
		const f = fixture(), bytes = f.bytes.slice(), signature = f.signature.slice(), retained: {value?: any} = {};
		const authenticated = f.api.authenticate(f.payload, f.authorization, bytes, signature, undefined, retained);
		bytes.fill(0); signature.fill(0);
		f.api.retain(f.closeVertices, f.closeAuthors, f.authorVertexCounts, authenticated, f.closeCharges, false, retained.value);
		expect(f.api.read(f.registration, f.bytes, f.signature, f.keyOf())).toBeDefined(); expect(f.state.calls).toBe(1);
	});

	it("detaches every matched parsed view including typed-array, Map and Set leaves before fresh replay", async () => {
		const f = fixture(); f.install(); const originalBytes = f.bytes.slice(), originalSignature = f.signature.slice();
		const first = f.api.read(f.registration, f.bytes, f.signature, f.keyOf());
		first.admitted.operation.bytes[0] = 99;
		first.vertex.operation.map.get("nested").add(99);
		first.admitted.operation.map.set("injected", new Set([99]));
		first.admitted.digest[0] ^= 1;
		const second = f.api.read(f.registration, f.bytes, f.signature, f.keyOf());
		expect(second.admitted.operation.bytes[0]).toBe(3);
		expect([...second.vertex.operation.map.get("nested")]).toEqual([3]);
		expect(second.admitted.operation.map.has("injected")).toBe(false);
		expect(second.digest).toBe(f.keyOf());
		expect(f.bytes).toEqual(originalBytes); expect(f.signature).toEqual(originalSignature);
		f.received(); const replay = await f.api.replay(f.registration, undefined, f.accounting, f.registration);
		expect(replay).toHaveLength(1); expect(replay![0].exactCanonicalPreimageBytes).toEqual(originalBytes);
		expect(replay![0].detachedSignature).toEqual(originalSignature);
		expect((decodeCanonical(replay![0].exactCanonicalVertexBytes) as any).operation.bytes[0]).toBe(3);
		expect(f.state.calls).toBe(1); expect(f.nativeReads).toEqual({readiness: 1, pages: 1, issued: 0});
	});

	it("does not install an admitted view mutated by a later callback as original signed provenance", () => {
		const f = fixture(), retained: {value?: any} = {};
		const authenticated = f.api.authenticate(f.payload, f.authorization, f.bytes, f.signature, undefined, retained);
		authenticated.vertex.operation.bytes[0] = 99;
		f.api.retain(f.closeVertices, f.closeAuthors, f.authorVertexCounts, authenticated, f.closeCharges, false, retained.value);
		expect(f.closeAuthors.get(f.keyOf())?.signedCurrent).toBeUndefined();
	});

	it("runtime revocation and fresh graph/charge mismatches still block delivery", () => {
		const revoked = fixture(); revoked.install(); revoked.state.revoked = true;
		expect(() => revoked.api.work(revoked.row)).toThrow("original-runtime-revoked");
		expect(revoked.state.calls).toBe(1);
		const changed = fixture(); changed.install(); changed.closeCharges.set(changed.keyOf(), changed.bytes.byteLength + 1);
		expect(changed.api.work(changed.row)).toBe(false); expect(changed.state.calls).toBe(2);
	});

	it("old-registration facts cannot populate a reopened owner without original new-context verification", () => {
		const f = fixture(); f.install();
		const old = f.closeAuthors.get(f.keyOf())!;
		expect(old.signedCurrent?.({...f.payload}, f.authorization, f.bytes, f.signature)).toBeUndefined();
		expect(f.api.copy(f.closeAuthors)?.get(f.keyOf())?.signedCurrent).toBeUndefined();
	});
});
