import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {settlementProfileFor} from "@ts-drp/protocol-v3/settlement-profile";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Execute the changed original bodies, with explicitly controlled authenticated
// membership/native verifier boundaries. These tests do not mint capabilities or
// claim cryptographic/native evidence; the original prefix/factory tests do so.
const rollback = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const live = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../src/internal/runtime-reclamation.ts", import.meta.url), "utf8");
function declaration(source: string, name: string): string {
	const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
	const node = tree.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
	if (!node) throw new Error(`missing original body: ${name}`);
	return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const record = (bytes: Uint8Array): Record<string, any> => decodeCanonical(bytes) as Record<string, any>;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const equal = (a: unknown, b: unknown) => sameBytes(encodeCanonical(a), encodeCanonical(b));
const fields = execute<(input: any) => any>(`${declaration(runtime, "creatorAuthenticatedEpochVertexFields")}\nreturn creatorAuthenticatedEpochVertexFields;`, {});
const effect = execute<(row: any) => any>(`${declaration(rollback, "creatorOrdinaryClosedApplicationEffectForSizing")}\nreturn creatorOrdinaryClosedApplicationEffectForSizing;`, {
	record, settlementProfileFor, encodeCanonical, creatorAuthenticatedEpochVertexFields: fields});
function row(sequence = 3, source = true) {
	const scope = {objectId: "room", epoch: 2, anchorDigest: "a".repeat(64)}, author = "b".repeat(64), digest = String(sequence).repeat(64);
	const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId, epoch: scope.epoch,
		anchor: scope.anchorDigest, author, authorSequence: sequence, logicalTime: sequence + 1, dependencies: [scope.anchorDigest],
		operation: {action: "placeBlock", bytes: Uint8Array.of(sequence)}, ...(source ? {settlementSource: {sourceObjectId: "room",
			sourceAuthor: author, sourceSequence: 2, sourcePreimage: Uint8Array.of(1), sourceSignature: new Uint8Array(64)}} : {})});
	const signature = new Uint8Array(64).fill(sequence);
	const nativeFrame = encodeCanonical(["acceptedEntries", [scope.objectId, scope.epoch, scope.anchorDigest, 0],
		{sourceKind: "local-issued", vertexDigest: digest, localAuthor: author, localAuthorSequence: sequence}]);
	return {scope, sourceKind: "local-issued", vertexData: record(preimage), journalSequence: 0, vertexDigest: digest, author, authorSequence: sequence,
		profileId: "creator-trusted-settlement-v1", exactCanonicalNativeFrameBytes: nativeFrame,
		exactCanonicalPreimageBytes: preimage, detachedSignature: signature};
}
function materialFixture() {
	const captured = row(), accounting = {}, protectedMaterial: Uint8Array[] = [], catalog = {artifactId: "artifact", artifactDigest: "digest",
		catalogDigest: "catalog", runtimeProfile: "runtime", exactArtifactBytes: Uint8Array.of(1), canonicalBlueprintPackageBytes: Uint8Array.of(2)};
	const facts: any = {frame: {accounting, input: {capturedCatalog: {}}}, sourceFacts: {catalogDigest: "catalog", blobs: [],
		applicationControls: [], applicationJournalRows: [captured], sourceLinkedApplicationEffects: []}, current: {runtime: {objectId: "room"},
		blueprint: {blueprintDigest: "blueprint", catalog, exactCanonicalBaseStateBytes: encodeCanonical({base: true}), maxApplicationStateBytes: 65536,
			maxDepth: 32, maxItems: 2048}, applicationControls: [], sourceLinkedApplicationEffects: [], currentApplicationPreimageBytes: [],
		currentSignedPreimagesHaveSettlementSource: true, pendingIngress: {roots: []}, candidate: {exactCanonicalOperationBytes: encodeCanonical({action: "placeBlock"})}},
		proofFacts: {capture: {nativeIssuance: {rows: {issued: [], outbox: [], lineages: []}}, journal: {canonicalRows: [captured.exactCanonicalNativeFrameBytes]}}}};
	const input = execute<(facts: any) => any>(`${declaration(rollback, "creatorOrdinaryClosedJournalApplicationRowForSizing")}
		${declaration(rollback, "creatorOrdinaryApplicationResourceMaterialForSizing")}
		${declaration(rollback, "creatorOrdinaryApplicationResourceInput")}\nreturn creatorOrdinaryApplicationResourceInput;`, {
		decodeCanonical, encodeCanonical, compareBytes, record, closedRetirementBytes: encodeCanonical, closedRetirementEqual: equal,
		closedRetirementHex: hex, verifiedCreatorSnapshotCatalog: () => catalog, creatorOrdinaryIssuanceApplicationSources: () => [],
		proofMaterialOwners: new Map([[accounting, {captureKnownProtectedMaterial: () => protectedMaterial}]])});
	return {captured, facts, protectedMaterial, input};
}
describe("original-owner source-linked APP-effect data", () => {
	it("preserves current, protected and pruned historical operations without granting source authority", () => {
		const f = materialFixture(), owned = effect(f.captured), preimage = f.captured.exactCanonicalPreimageBytes.slice();
		f.facts.sourceFacts.sourceLinkedApplicationEffects = [owned];
		f.facts.current.sourceLinkedApplicationEffects = [effect(f.captured)];
		f.facts.current.currentApplicationPreimageBytes = [preimage];
		f.protectedMaterial.push(preimage, owned.exactCanonicalEpochVertexBytes);
		const result = f.input(f.facts);
		expect(result.material.currentOperations).toEqual([{action: "placeBlock", bytes: Uint8Array.of(3)}]);
		expect(result.material.protectedOperations).toHaveLength(2);
		expect(result.material.recoveryOperations).toEqual([{action: "placeBlock", bytes: Uint8Array.of(3)}]);
		result.material.recoveryOperations[0].bytes[0] = 255;
		expect(f.input(f.facts).material.recoveryOperations[0].bytes).toEqual(Uint8Array.of(3));
		expect(f.captured.exactCanonicalPreimageBytes).toEqual(preimage);
		expect(record(preimage).settlementSource).toBeDefined(); // Full source proof is not stripped.
	});
	it("requires exact owned correspondence; neither eleven keys nor a source/control action confers authority", () => {
		for (const change of ["missing", "altered", "conflicting", "frame", "scope", "profile"] as const) {
			const f = materialFixture(), owned = effect(f.captured);
			f.facts.sourceFacts.sourceLinkedApplicationEffects = [owned];
			if (change === "missing") f.facts.sourceFacts.sourceLinkedApplicationEffects = [];
			if (change === "altered") owned.exactCanonicalPreimageBytes[0] ^= 1;
			if (change === "conflicting") f.facts.sourceFacts.sourceLinkedApplicationEffects.push({...owned,
				exactCanonicalEpochVertexBytes: encodeCanonical({...record(owned.exactCanonicalEpochVertexBytes), operation: {action: "other"}})});
			if (change === "frame") f.captured.exactCanonicalNativeFrameBytes = encodeCanonical(["acceptedEntries", ["other", 2, f.captured.scope.anchorDigest, 0], {}]);
			if (change === "scope") f.captured.scope = {...f.captured.scope, epoch: 3};
			if (change === "profile") {f.captured.profileId = "creator-trusted-v1"; f.facts.sourceFacts.sourceLinkedApplicationEffects = [effect(f.captured)].filter(Boolean);}
			expect(f.input(f.facts), change).toBeUndefined();
		}
		const unqualified = row(); unqualified.profileId = "creator-trusted-v1";
		expect(effect(unqualified)).toBeUndefined();
		const changed = row(); changed.exactCanonicalPreimageBytes = encodeCanonical({...record(changed.exactCanonicalPreimageBytes), epoch: 3});
		changed.vertexData = record(changed.exactCanonicalPreimageBytes);
		expect(effect(changed)).toBeUndefined();
	});
});

function captureFixture() {
	const source = row(2, false), target = row(3), second = row(4), own = {objectId: "room", author: source.author};
	for (const targetRow of [target, second]) targetRow.exactCanonicalPreimageBytes = encodeCanonical({...record(targetRow.exactCanonicalPreimageBytes),
		settlementSource: {...record(targetRow.exactCanonicalPreimageBytes).settlementSource,
			sourcePreimage: source.exactCanonicalPreimageBytes.slice(), sourceSignature: source.detachedSignature.slice()}});
	const issued = (value: ReturnType<typeof row>) => ({objectId: "room", author: value.author, authorSequence: value.authorSequence,
		digest: hex(value.vertexDigest), canonicalPreimageBytes: value.exactCanonicalPreimageBytes.slice(), signature: value.detachedSignature.slice()});
	const native: any = {issued: [issued(source), issued(target), issued(second)], plans: [{scope: own, entries: [{sourceSequence: 2,
		replacementSequence: 4, replacementProgress: {chunks: [{replacementSequence: 3}, {replacementSequence: 4}]}}]}]};
	const state = {portable: true, local: true, complete: true, classify: true, budget: true, nativeMismatch: false,
		nativeError: false, completions: 0, localChecks: 0, reads: [] as number[], charges: [] as Uint8Array[]};
	const auth = (preimage: Uint8Array) => {
		const pre = record(preimage), owned = [source, target, second].find(value => value.authorSequence === pre.authorSequence)!;
		return {digest: owned.vertexDigest, author: pre.author, authorSequence: pre.authorSequence, admitted: pre,
			vertex: fields({anchor: pre.anchor, dependencies: pre.dependencies, epoch: pre.epoch, hash: owned.vertexDigest,
				kind: pre.kind, objectId: pre.objectId, operation: pre.operation})};
	};
	const store = {readIssued: async (_scope: any, sequence: number) => {
		state.reads.push(sequence); if (state.nativeError) throw new Error("original-native-failure");
		const found = native.issued.find((value: any) => value.authorSequence === sequence);
		return {envelope: {...found, canonicalPreimageBytes: state.nativeMismatch ? Uint8Array.of(0) : found.canonicalPreimageBytes},
			issuedRecord: {sequence}, outboxEntry: {sequence}};
	}};
	const registration: any = {payload: {}, authorization: {}, issuanceScope: own, closeVertices: new Map(), closeAuthors: new Map([
		[target.vertexDigest, {author: target.author, authorSequence: 3, sourceAuthorized: true}]])};
	const accounting = {charge: (bytes: Uint8Array) => {state.charges.push(bytes.slice()); return state.budget;}};
	const capture = execute<(registration: any, journal: any[], native: any, accounting: any, parsed: any) => Promise<any>>(
		`${declaration(live, "captureCreatorOrdinarySourceLinkedApplicationEffects")}\nreturn captureCreatorOrdinarySourceLinkedApplicationEffects;`, {
		ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor, decodeCanonical, encodeCanonical, sameBytes,
		ObjectFreeze: Object.freeze, Uint8ArrayConstructor: Uint8Array, authenticateRecoveryVertex: (_payload: any, _auth: any, pre: Uint8Array) => auth(pre),
		verifyPortableSettlementSource: () => state.portable,
		verifyLocalNativeSettlementSource: async () => {state.localChecks++; return state.local;},
		creatorOriginalIssuanceStore: () => store, sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
		outboxRowSnapshot: ({commit}: any, scope: any) => commit === null ? undefined : ({...commit.envelope, scope}),
		classifyRebaseRow: (_registration: any, snapshot: any) => state.classify ? {row: snapshot, authenticated: auth(snapshot.canonicalPreimageBytes)} : undefined,
		validRebaseRow: () => state.classify, createCreatorCensusVertexFacts: () => ({}),
		createOwnEpochFenceReader: () => async () => new Map(),
		ownSourceSettlementIsComplete: async () => {state.completions++; return state.complete;}});
	const journal: any[] = [{journalSequence: 0, sourceKind: "received", digest: target.vertexDigest, byteCharge: target.exactCanonicalPreimageBytes.byteLength,
		exactCanonicalPreimageBytes: target.exactCanonicalPreimageBytes.slice(), detachedSignature: target.detachedSignature.slice(),
		exactCanonicalVertexBytes: encodeCanonical(auth(target.exactCanonicalPreimageBytes).vertex)}];
	// Controlled original replay metadata; this fixture does not authenticate it.
	// The retained-close fixture below the actual replay owner proves delivery.
	const replayCapture = {value: {rows: journal, vertices: [{author: target.author, hasSettlementSource: true}]}};
	return {state, native, source, target, registration, journal, replayCapture,
		run: () => capture(registration, journal, native, accounting, replayCapture)};
}
describe("same held invocation source/completion capture", () => {
	it("requires exact complete replay identity before using primitive presence/author metadata", async () => {
		const f = captureFixture();
		f.replayCapture.value.rows = [...f.journal]; expect(await f.run()).toBeUndefined();
		expect(f.state.charges).toHaveLength(0); expect(f.state.completions).toBe(0);
		f.replayCapture.value.rows = f.journal; f.replayCapture.value.vertices = [];
		expect(await f.run()).toBeUndefined(); expect(f.state.charges).toHaveLength(0);
	});
	it("uses original source and complete-chunk verifiers, charges full leaves and isolates returned bytes", async () => {
		const f = captureFixture(), result = await f.run();
		expect(result.currentSignedPreimagesHaveSettlementSource).toBe(true);
		expect(result.currentJournalMaximumAuthorByteLength).toBe(encodeCanonical(f.target.author).byteLength);
		expect(result.effects).toHaveLength(2); expect(result.completedNative).toHaveLength(2);
		expect(f.state.completions).toBe(1); // Both chunks share one whole-source proof.
		expect(f.state.reads).toEqual([3, 2, 4]);
		expect(f.state.charges.some(bytes => sameBytes(bytes, f.source.exactCanonicalPreimageBytes))).toBe(true);
		expect(f.state.charges.some(bytes => sameBytes(bytes, f.target.detachedSignature))).toBe(true);
		expect(f.state.charges.some(bytes => {try {return record(bytes)?.issuedRecord !== undefined;} catch {return false;}})).toBe(true);
		result.completedNative[0].preimage[0] ^= 1; result.effects[0].exactCanonicalPreimageBytes[0] ^= 1;
		expect((await f.run()).completedNative[0].preimage).toEqual(f.target.exactCanonicalPreimageBytes);
	});
	it("refuses missing authority, incomplete chunks, mismatches and unpaid material; native failures remain fatal", async () => {
		for (const change of ["authority", "portable", "complete", "classify", "budget", "nativeMismatch", "source", "duplicate-source", "plan"] as const) {
			const f = captureFixture();
			if (change === "authority") f.registration.closeAuthors.clear();
			if (change === "portable") f.state.portable = false; // Received rows cannot borrow local selection authority.
			if (change === "complete") f.state.complete = false;
			if (change === "classify") f.state.classify = false;
			if (change === "budget") f.state.budget = false;
			if (change === "nativeMismatch") f.state.nativeMismatch = true;
			if (change === "source") f.native.issued.shift();
			if (change === "duplicate-source") f.native.issued.push({...f.native.issued[0]});
			if (change === "plan") f.native.plans[0].entries = [];
			expect(await f.run(), change).toBeUndefined();
		}
		const fatal = captureFixture(); fatal.state.nativeError = true;
		await expect(fatal.run()).rejects.toThrow("original-native-failure");
	});
});

function completedFixture() {
	const source = row(2, false), scope = {objectId: "room", author: source.author}, intentDigest = "f".repeat(64);
	const sourceRow = {scope, authorSequence: 2, digest: hex(source.vertexDigest), canonicalPreimageBytes: source.exactCanonicalPreimageBytes,
		signature: source.detachedSignature};
	const chunks = [3, 4].map((sequence, index) => ({replacementSequence: sequence, throughIntent: index + 1}));
	const plan: any = {entries: [{sourceSequence: 2, sourceDigest: sourceRow.digest, replacementSequence: 4, disposition: "rebase",
		replacementProgress: {chunks, intentDigest: hex(intentDigest), intentCount: 2}}]};
	const targets = chunks.map((chunk, index) => {
		const value = row(chunk.replacementSequence), original = record(value.exactCanonicalPreimageBytes);
		const proof = {version: 1, sourceObjectId: "room", sourceAuthor: source.author, sourceEpoch: 1, sourceAnchor: "e".repeat(64),
			sourceSequence: 2, sourceDigest: source.vertexDigest, sourcePreimage: source.exactCanonicalPreimageBytes,
			sourceSignature: source.detachedSignature, sourceAnchorPreimage: Uint8Array.of(1), sourceAnchorSignature: new Uint8Array(64),
			sourceAclBytes: Uint8Array.of(2), dependencyVertices: [], transformRefusal: null,
			targetObjectId: "room", targetEpoch: 2, targetAnchor: value.scope.anchorDigest,
			targetBlueprintDigest: "blueprint", targetAclDigest: "acl", fromIntent: index, throughIntent: index + 1,
			intentDigest, creatorSelectionSignature: null};
		return {scope, authorSequence: chunk.replacementSequence, digest: hex(value.vertexDigest), signature: value.detachedSignature,
			canonicalPreimageBytes: encodeCanonical({...original, settlementSource: proof})};
	});
	const state = {budget: true, fail: false, charges: [] as Uint8Array[], reads: [] as number[]};
	const commits = new Map([sourceRow, ...targets].map(value => [value.authorSequence, {envelope: value, issuedRecord: {sequence: value.authorSequence}}]));
	const store = {readSettlementPlan: async () => plan, readIssued: async (_scope: any, sequence: number) => {
		state.reads.push(sequence); if (state.fail) throw new Error("original-native-failure"); return commits.get(sequence) ?? null;}};
	const registration = {payload: {parameters: {maxEpochVertices: 16, maxEpochBytes: 65536},
		provenance: {blueprintDigest: "blueprint"}, input: {settlementPolicy: {blueprintDigest: "blueprint",
			derive: () => ({disposition: "rebase", operations: targets.map(target => record(target.canonicalPreimageBytes).operation)})}}},
		issuanceScope: scope, issuanceStore: store};
	const sourceKeysNode = ts.createSourceFile("original.ts", live, ts.ScriptTarget.Latest, true).statements
		.filter(ts.isVariableStatement).flatMap(value => [...value.declarationList.declarations])
		.find(value => ts.isIdentifier(value.name) && value.name.text === "PORTABLE_SETTLEMENT_SOURCE_KEYS")!;
	const sourceKeys = execute<readonly string[]>(`return ${sourceKeysNode.initializer!.getText()};`, {});
	const api = execute<(registration: any, selected: any, plan: any, vertexFacts?: any, book?: any) => Promise<boolean>>(`
		${declaration(live, "verifyNestedNativeSource")}
		${declaration(live, "ownSourceSettlementIsComplete")}\nreturn ownSourceSettlementIsComplete;`, {
		encodeCanonical, decodeCanonical, sameBytes, NumberIsSafeInteger: Number.isSafeInteger,
		sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
		AUTHOR_FENCE_ACTION: "$drp.author-fence.v1",
		settlementSourceOperations: (_payload: any, operation: any) => [operation],
		derivePolicySettlement: (policy: any, operations: any) => policy.derive(operations),
		creatorOriginalIssuanceStore: () => store, isObject: (value: unknown) => value !== null && typeof value === "object",
		PORTABLE_SETTLEMENT_SOURCE_KEYS: sourceKeys,
		snapshotClosedRecord: (value: any, keys: readonly string[]) => Reflect.ownKeys(value).length === keys.length &&
			keys.every(key => Object.hasOwn(value, key)) ? {...value} : undefined,
		outboxRowSnapshot: ({commit}: any) => commit === null ? undefined : commit.envelope,
		classifyRebaseRow: (_registration: any, value: any) => ({row: value, authenticated: {
			author: scope.author, authorSequence: value.authorSequence, admitted: record(value.canonicalPreimageBytes),
			vertex: {operation: record(value.canonicalPreimageBytes).operation}}}),
		validRebaseRow: () => true, lowerHexDigest: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
		verifyCreatorSettlementSourceSelection: () => false, creatorSettlementSelectionBytes: encodeCanonical});
	const selected = {row: sourceRow, authenticated: {digest: source.vertexDigest, author: scope.author,
		authorSequence: sourceRow.authorSequence, admitted: {epoch: 1}, vertex: {operation: record(sourceRow.canonicalPreimageBytes).operation}}};
	const book = {charge: (bytes: Uint8Array) => {state.charges.push(bytes.slice()); return state.budget;}};
	return {api, registration, selected, plan, state, book, sourceRow, targets, commits};
}
describe("original completed-link verifier accounting", () => {
	it("retains the original whole-chunk law while charging every actual commit, plan, PRE and signature", async () => {
		const f = completedFixture();
		expect(await f.api(f.registration, f.selected, f.plan)).toBe(true);
		expect(f.state.charges).toHaveLength(0); // Unchanged original callers.
		f.state.reads.length = 0;
		expect(await f.api(f.registration, f.selected, f.plan, undefined, f.book)).toBe(true);
		expect(f.state.reads).toEqual([3, 2, 4, 2]);
		for (const value of [f.plan, ...f.commits.values()])
			expect(f.state.charges.some(bytes => sameBytes(bytes, encodeCanonical(value)))).toBe(true);
		for (const value of [f.sourceRow, ...f.targets]) {
			expect(f.state.charges.some(bytes => sameBytes(bytes, value.canonicalPreimageBytes))).toBe(true);
			expect(f.state.charges.some(bytes => sameBytes(bytes, value.signature))).toBe(true);
		}
	});
	it("does not treat incomplete or conflicting chunks, exhausted accounting or native failures as completion", async () => {
		for (const change of ["incomplete", "signature", "fromIntent", "budget"] as const) {
			const f = completedFixture();
			if (change === "incomplete") f.plan.entries[0].replacementProgress.intentCount = 3;
			if (change === "signature" || change === "fromIntent") {
				const target = f.targets[0], value = record(target.canonicalPreimageBytes);
				if (change === "signature") value.settlementSource.sourceSignature[0] ^= 1;
				else value.settlementSource.fromIntent = 1;
				target.canonicalPreimageBytes = encodeCanonical(value);
			}
			if (change === "budget") f.state.budget = false;
			expect(await f.api(f.registration, f.selected, f.plan, undefined, f.book), change).toBe(false);
		}
		const fatal = completedFixture(); fatal.state.fail = true;
		await expect(fatal.api(fatal.registration, fatal.selected, fatal.plan, undefined, fatal.book)).rejects.toThrow("original-native-failure");
	});
});

describe("original V1 producer completed-native gates", () => {
	it("keeps exact digest, full signed bytes and terminal classification gates after source verification", () => {
		const tree = ts.createSourceFile("original.ts", live, ts.ScriptTarget.Latest, true), loops: ts.ForOfStatement[] = [];
		let method: ts.FunctionExpression | undefined;
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "readOrdinarySettlementCapacity" && ts.isFunctionExpression(node.initializer)) method = node.initializer;
			ts.forEachChild(node, visit);
		}; visit(tree);
		if (!method) throw new Error("missing original V1 producer");
		const collect = (node: ts.Node): void => {if (ts.isForOfStatement(node)) loops.push(node); ts.forEachChild(node, collect);};
		collect(method);
		const slots = loops.find(node => node.expression.getText(tree) === "registration.closeAuthors")!.getText(tree);
		const issued = loops.find(node => node.expression.getText(tree) === "rows.issued")!.getText(tree);
		const state = {terminal: true};
		const api = execute<{slots(registration: any, vertices: any, sourceLinkedApplicationCapture: any, scope: any): any;
			issued(rows: any, sourceLinkedApplicationCapture: any, scope: any, epoch: number): any}>(`
			return {
			 slots(registration,vertices,sourceLinkedApplicationCapture,scope) {const slots=new Map();let duplicate=false;${slots};return true;},
			 issued(rows,sourceLinkedApplicationCapture,scope,epoch) {const issued=new Map();const frontier=[scope.author,0,10];${issued};return true;}
			};`, {decodeCanonical, sameBytes, NumberIsSafeInteger: Number.isSafeInteger, ObjectFreeze: Object.freeze,
			prospectiveCensusRecord: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
			isDigestHex: (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
			sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
			settlementOwnRowClass: () => state.terminal ? "terminal" : "unresolved", AUTHOR_FENCE_ACTION: "$drp.author-fence.v1"});
		const value = row(), scope = {objectId: "room", author: value.author}, identity = {author: value.author, authorSequence: 3, sourceAuthorized: true};
		const native = {objectId: "room", author: value.author, authorSequence: 3,
			canonicalPreimageBytes: value.exactCanonicalPreimageBytes.slice(), signature: value.detachedSignature.slice()};
		const correspondence = {completedNative: [{authorSequence: 3, digest: value.vertexDigest,
			preimage: value.exactCanonicalPreimageBytes.slice(), signature: value.detachedSignature.slice()}]};
		const registration = {closeAuthors: new Map([[value.vertexDigest, identity]])}, vertices = new Map([[value.vertexDigest, {}]]);
		expect(api.slots(registration, vertices, correspondence, scope)).toBe(true);
		expect(api.issued({issued: [native]}, correspondence, scope, 2)).toBe(true);
		for (const change of ["missing", "digest", "sequence"] as const) {
			const changed = decodeCanonical(encodeCanonical(correspondence)) as any;
			if (change === "missing") changed.completedNative = [];
			if (change === "digest") changed.completedNative[0].digest = "d".repeat(64);
			if (change === "sequence") changed.completedNative[0].authorSequence = 4;
			expect(api.slots(registration, vertices, changed, scope), change).toBeUndefined();
		}
		for (const change of ["missing", "signature", "preimage", "duplicate", "nonterminal"] as const) {
			const changed = {...native, canonicalPreimageBytes: native.canonicalPreimageBytes.slice(), signature: native.signature.slice()};
			if (change === "signature") changed.signature[0] ^= 1;
			if (change === "preimage") changed.canonicalPreimageBytes = encodeCanonical({...record(changed.canonicalPreimageBytes), logicalTime: 5});
			if (change === "nonterminal") state.terminal = false;
			expect(api.issued({issued: change === "duplicate" ? [changed, changed] : [changed]},
				change === "missing" ? {completedNative: []} : correspondence, scope, 2), change).toBeUndefined();
		}
	});
});
