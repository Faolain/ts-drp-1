import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { journalRetirementFrameDigest } from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";

// Execute the private production classifier and SAME-source owner statements.
// Authenticated source custody and native ports are controlled premises here;
// this is not a signature, SQLite/IndexedDB, or complete finishing-bound test.
const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
const compareBytes = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const equal = (a: unknown, b: unknown): boolean => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0;
function select<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T {
	const found: T[] = [];
	const visit = (node: ts.Node): void => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
	visit(root);
	if (found.length !== 1) throw Error(`PRIVATE_STATEMENT_NOT_UNIQUE:${found.length}`);
	return found[0]!;
}
function declaration(name: string): string {
	return select(parsed, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(parsed);
}
const resolver = select(parsed, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "resolveCreatorForwardPromotionSource");
function variable(name: string): string {
	return `const ${select(resolver, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name).getText(parsed)};`;
}
function property(name: string, sibling: string): string {
	return select(resolver, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(parsed) === name &&
		ts.isObjectLiteralExpression(node.parent) && node.parent.properties.some(item => ts.isPropertyAssignment(item) && item.name.getText(parsed) === sibling)).initializer.getText(parsed);
}
const classifierCode = ["closedNativeJournalScopes", "closedJournalFrameAt", "closedJournalScopeHasNonLocalRows",
	"closedJournalMembershipPrefix", "prepareClosedJournalMembershipPrefix", "closedJournalProtectedReplayScopes", "classifyClosedJournalDetails",
	"prepareClosedJournalDetails", "canPrepareClosedJournalDetails",
	"classifySourceOwnedClosedJournalDetails"].map(declaration).join("\n");
const privateStart = source.indexOf("const journalClassificationInput:");
const privateEnd = source.indexOf("const censusFacts = record(census);", privateStart);
if (privateStart < 0 || privateEnd < privateStart) throw Error("PRIVATE_CLASSIFICATION_OWNER_NOT_FOUND");
const privateCallsite = source.slice(privateStart, privateEnd);
function execute<T>(code: string, context: Record<string, unknown>): T {
	const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
	const imports = { decodeCanonical, encodeCanonical, compareBytes, record: decodeCanonical,
		closedRetirementBytes: encodeCanonical, closedRetirementEqual: equal,
		closedJournalNativeObservationEqual: equal, journalRetirementFrameDigest,
		// Genuine target custody is a controlled premise of this source-owner
		// model; exercise its original checks/releases after their private move.
		checkHeldTarget: (target: {check(): Promise<void>}) => target.check(),
		releaseHeldTarget: (target: {release(): Promise<void>}) => target.release(),
		closedRetirementHex: (value: string) => Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16)),
		bindMethod: (owner: Record<string, (...args: any[]) => unknown>, name: string) => owner[name]!.bind(owner),
		requireLaw: (ok: unknown, reason = "chain-invalid") => { if (!ok) throw Error(reason); },
		Refusal: class extends Error { constructor(reason: string) { super(reason); } }, failure: (kind: string) => kind,
		...context };
	return Function(...Object.keys(imports), `"use strict";return eval(${JSON.stringify(js)});`)(...Object.values(imports)) as T;
}
function gate() {
	let open!: () => void;
	const promise = new Promise<void>(resolve => { open = resolve; });
	return { promise, open };
}
type Hooks = {
	onCurrent?: (count: number) => void | Promise<void>;
	onImage?: () => void | Promise<void>;
	onReadiness?: () => void | Promise<void>;
	onPage?: () => void | Promise<void>;
	onCloseCheck?: (count: number) => void | Promise<void>;
};
function fixture(protectedCount = 0, hooks: Hooks = {}) {
	const scope = { objectId: "room", epoch: 0, anchorDigest: "old" };
	const currentScope = { objectId: "room", epoch: 20, anchorDigest: "current" };
	const protectedScopes = Array.from({ length: protectedCount }, (_, index) => ({ objectId: "room", epoch: index + 2,
		anchor: `protected-${index}`, manifestDigest: `manifest-${index}` }));
	const protectedJournalScopes = protectedScopes.map(item => ({ objectId: item.objectId, epoch: item.epoch, anchorDigest: item.anchor }));
	const canonicalRows = [scope, ...protectedJournalScopes].map(item => encodeCanonical(["scopes", [item.objectId, item.epoch, item.anchorDigest], {}]));
	canonicalRows.push(encodeCanonical(["accepted_entries", [scope.objectId, scope.epoch, scope.anchorDigest, 0], { source_kind: "local-issued" }]));
	const image = { canonicalRows, image: { rowCount: 1, imageDigest: "native-image" } };
	const digest = new Uint8Array(32).fill(3), author = "writer", authorSequence = 1;
	const issued = { objectId: scope.objectId, author, authorSequence, digest,
		canonicalPreimageBytes: encodeCanonical({ objectId: scope.objectId, epoch: scope.epoch, anchor: scope.anchorDigest, author, authorSequence }) };
	const censusBytes = encodeCanonical({ currentJournal: { scope: currentScope },
		nativeIssuance: { rows: { issued: [issued], outbox: [{ ...issued, publishState: "published" }] } },
		rows: [{ scope: { objectId: scope.objectId, author }, authorSequence, digest,
			classification: "covered-historical", dependencyKind: "signed-settled-issuance" }] });
	const summary = { cuts: protectedScopes.map(item => ({ objectId: item.objectId, epoch: item.epoch,
		closedAnchorDigest: item.anchor, successorAnchorDigest: `successor-${item.epoch}` })) };
	const floor = { stable: { epoch: 20, anchor: "current" }, pending: null };
	const counts = { full: 0, current: 0, snapshots: 0, floors: 0, anchors: 0, images: 0, readiness: 0, pages: 0,
		census: 0, signing: 0, releases: 0 };
	const state = { actualImage: image, actualFloor: floor, current: true, anchor: true, acceptCharge: true };
	const charges: Uint8Array[] = [];
	const accounting = { charge: (bytes: Uint8Array) => { charges.push(bytes.slice()); return state.acceptCharge; } };
	const snapshot = { scope, highWatermark: 1 };
	const journal = {
		readiness: async () => { counts.readiness++; await hooks.onReadiness?.(); return { ok: true, ready: true, scope, snapshot, rowCount: 1 }; },
		readPage: async () => { counts.pages++; await hooks.onPage?.(); return { ok: true, scope, snapshot,
			rows: [{ scope, journalSequence: 0, vertexDigest: "03".repeat(32), sourceKind: "local-issued", author, authorSequence }], nextSequence: null }; },
		readRetirementImage: async () => { counts.images++; await hooks.onImage?.(); return { ok: true, value: state.actualImage }; },
	};
	const readInput = { objectId: scope.objectId, journal, image, physical: image, summary, floor, censusBytes,
		sourceTrust: undefined, unclassifiedReplay: false, protectedRoleScopes: protectedScopes,
		authenticatedScopes: [scope, ...protectedJournalScopes], accounting, check: async () => { counts.full++; } };
	const code = `${classifierCode}
		${declaration("joinSourceReleases")}
		let aliasRevoked=false, aliasRelease, nominationSource, nominationTask;
		const reader={release:async()=>{counts.releases++;}}, capability={}, hold={release:async()=>{}};
		const originalFrame={alive:true, accounting, requirements:new Set(), pending:new Set(), headerHold:hold,
			recoveryTrusts:new Set(readInput.authenticatedScopes.map(scope=>({objectId:scope.objectId,currentEpoch:scope.epoch,currentAnchorDigest:scope.anchorDigest}))),
			closeDependencies:{readExactCanonicalCensus:()=>readInput.censusBytes, release:async()=>{},
				checkWhile:async read=>{counts.census++;counts.signing++;await hooks.onCloseCheck?.(counts.census);
					await read();counts.census++;counts.signing++;await hooks.onCloseCheck?.(counts.census);}}};
		const sourceFrame=originalFrame,lifetime={released:false,classifiedReleasing:false},pendingChecks=new Set();
		lifetime.pendingChecks=pendingChecks;sourceFrame.sourceLifetime=lifetime;
		const savedDependencies=sourceFrame.closeDependencies;
		const frames=new WeakMap([[reader,originalFrame]]),journalHeaderHolds=new WeakMap([[hold,{}]]);
		const observations=new WeakMap([[capability,{}]]),ledgers=new WeakMap(),requirements=new WeakMap();
		const held=[{check:async()=>{counts.snapshots++;},release:async()=>{}}],installedProofs=[],certificateProofs=[];
		const originalAnchor=Uint8Array.of(1,2,3),dependency={},facts={dependencies:[dependency],summary:readInput.summary},dependencies=new WeakMap();
		const input={objectId:readInput.objectId,pinnedGenesisAnchorDigest:"genesis",store:{},liveJournalStore:readInput.journal,
			floorRead:async()=>{counts.floors++;return {ok:true,state:state.actualFloor};}};
		dependencies.set(dependency,{source:input.liveJournalStore,scope:readInput.authenticatedScopes[0],actualByteLength:3,exactCanonicalAnchorPreimageBytes:originalAnchor});
		const forward={reader,certificates:[],wholeCensus:true,wholeFloor:floor,currentTrust:floor.stable,
			checkCurrent:async()=>{counts.current++;await hooks.onCurrent?.(counts.current);return {ok:state.current};}};
		${["releaseOriginal", "throughCurrentSource", "withSourceRead", "checkSnapshots", "withCloseDependencies", "checkCurrentSource", "checkRecoverySourceCurrent"].map(variable).join("\n")}
		const material={release:${property("release", "readClosedJournalMembershipPrefixes")},
			checkCurrent:${property("checkCurrent", "readClosedJournalMembershipPrefixes")},
			releaseClassifiedDependencies:${property("releaseClassifiedDependencies", "readClosedJournalMembershipPrefixes")}};
		const closeObserved={observation:capability},closeFacts=facts;
		observations.set(capability,closeFacts);
		const closeUnion={snapshotScopes:readInput.protectedRoleScopes,check:()=>material.checkCurrent(),
			readSealedCloseDependencies:()=>originalFrame.closeDependencies.readExactCanonicalCensus()};
		const sourceUnion=closeUnion,journalProof=readInput.image,journal={value:readInput.physical},
			journalReconstructed=false,journalPlan=undefined,roles={floor:readInput.floor},census=readInput.censusBytes,
			unclassifiedReplay=readInput.unclassifiedReplay,journalScopes=readInput.authenticatedScopes,roleProofs=[];
		const closeLifetime={sourceTrust:readInput.sourceTrust,check:async()=>{}},
			checkNativeReservations=async()=>{counts.full++;};
		const read=async()=>{const lifetime=closeLifetime,sourceLifetime=closeLifetime;
			${privateCallsite}
			return journalDetails;};
		({read,release:()=>material.release(),releaseClassified:()=>material.releaseClassifiedDependencies(),
			readInput,counts,state,charges,pendingChecks,frame:originalFrame,lifetime,
			revoke:()=>{sourceFrame.headerConsumersRevoked=true;},mutateHeader:()=>{sourceFrame.headerMutation={};},
			replaceObservation:()=>{observations.set(capability,{});},removeHold:()=>{journalHeaderHolds.delete(hold);},
			replaceDependencies:()=>{sourceFrame.closeDependencies={};},replaceLifetime:()=>{sourceFrame.sourceLifetime={};},
			restoreOwner:()=>{sourceFrame.closeDependencies=savedDependencies;sourceFrame.sourceLifetime=lifetime;},
			staleAnchor:()=>{state.anchor=false;}});`;
	const closeHold = {};
	const owner = execute<any>(code, { readInput, floor, counts, state, accounting, charges, hooks, closeHold,
		resolveCreatorSnapshotRecoveryCloseHold: (value: unknown) => value === closeHold ? { sourceTrust: readInput.sourceTrust } : undefined,
		closedJournalReconstructedControlCarriers: (value: unknown) => [encodeCanonical(value)],
		captureCreatorRoomHeadState: (value: unknown) => value, sameCreatorRoomHead: equal, checkAbort: () => {},
		readHeldSourcePreimage: async (_: unknown, request: any) => { counts.anchors++; return { ok: true, kind: "present", scope: request.scope,
			exactCanonicalAnchorPreimageBytes: Uint8Array.of(1, 2, state.anchor ? 3 : 4) }; },
	});
	return { ...owner, scope, protectedScopes, canonicalRows, baseline: () => execute<Promise<any>>(
		`${classifierCode} classifyClosedJournalDetails(readInput);`, { readInput }) };
}

describe("SAME-owner compound closed-journal classification", () => {
	it("runs the unchanged membership/ACL/signature algorithm on DATA without native ports", async () => {
		const f = fixture(), original = f.readInput, scope = f.scope;
		const author = "aa".repeat(32), digest = "03".repeat(32);
		const preimage = encodeCanonical({objectId: scope.objectId, epoch: scope.epoch, anchor: scope.anchorDigest,
			author, authorSequence: 1, dependencies: [scope.anchorDigest]});
		const membership = {scope, exactCanonicalLatchedAclBytes: Uint8Array.of(1),
			orderedVertexDigests: [new Uint8Array(32).fill(3)],
			localVertexWitnesses: [{vertexDigest: digest, exactCanonicalPreimageBytes: preimage, detachedSignature: new Uint8Array(64)}]};
		const carrier = encodeCanonical({...membership, orderedVertexDigests: new Uint8Array(32).fill(3)});
		const image = {...original.image, canonicalRows: [
			encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest],
				{next_journal_sequence: 1, closed_membership_bytes: carrier}]),
			encodeCanonical(["accepted_entries", [scope.objectId, scope.epoch, scope.anchorDigest, 0],
				{vertex_digest: digest, source_kind: "local-issued", local_author: author, local_author_sequence: 1}]),
		]};
		const calls: string[] = [], charges: Uint8Array[] = [];
		const data = {objectId: original.objectId, image, summary: original.summary, floor: original.floor,
			censusBytes: original.censusBytes, sourceTrust: undefined, unclassifiedReplay: false,
			protectedRoleScopes: [], authenticatedScopes: [scope], accounting: {charge: (raw: Uint8Array) => {charges.push(raw); return true;}},
			journalMembershipAuthorities: [{scope, exactCanonicalCutValueBytes: encodeCanonical({parameters: {maxEpochVertices: 4}}),
				closedAclDigest: "acl", profileId: "profile", suiteId: "suite"}]};
		const context = {data, calls, membership,
			registry: {cryptoSuites: {active: [{role: "identityAndVertex", suiteId: "suite"}]}, kinds: {vertex: {domain: "vertex"}}, domains: {vertex: "vertex"}},
			openCreatorCloseMembership: async () => {calls.push("membership"); return membership;},
			openCanonicalLatchedAclSnapshot: () => {calls.push("acl"); return {ok: true, snapshot: {}};},
			authorizeLatchedEnvelopeAuthor: ({author: supplied}: {author: string}) => {calls.push(`authorize:${supplied}`); return {ok: true, authorized: true};},
			verifyReceivedVertex: (input: any) => {calls.push("signature"); expect(input.resolveAuthorPublicKey(author).bytes).toHaveLength(32);
				return {accepted: true, digest: new Uint8Array(32).fill(3)};}};
		expect(execute<boolean>(`${classifierCode} canPrepareClosedJournalDetails(data);`, context)).toBe(true);
		const result = await execute<Promise<any>>(`${classifierCode} prepareClosedJournalDetails(data);`, context);
		expect(result.collectiblePrefixes).toHaveLength(1); expect(result.collectiblePrefixes[0].snapshot).toBeNull();
		expect(calls).toEqual(["membership", "acl", "signature", `authorize:${author}`]);
		expect(charges).toEqual([encodeCanonical(result)]);
		for (const port of ["journal", "physical", "check", "checkAvailable", "readWhile"]) expect(data).not.toHaveProperty(port);
		const missing = {...data, journalMembershipAuthorities: []};
		expect(execute<boolean>(`${classifierCode} canPrepareClosedJournalDetails(data);`, {...context, data: missing})).toBe(false);
		const withoutWitness = {...data, image: {...image, canonicalRows: [encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest],
			{next_journal_sequence: 1, closed_membership_bytes: encodeCanonical({...membership, orderedVertexDigests: new Uint8Array(32).fill(3), localVertexWitnesses: []})}]), image.canonicalRows[1]]}};
		expect(execute<boolean>(`${classifierCode} canPrepareClosedJournalDetails(data);`, {...context, data: withoutWitness})).toBe(false);
		const receivedCarrier = encodeCanonical({kind: "creator-received-close-membership-1", exactCanonicalMembershipBytes: carrier});
		const received = {...data, image: {...image, canonicalRows: [encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest],
			{next_journal_sequence: 1, closed_membership_bytes: receivedCarrier}]), image.canonicalRows[1]]}};
		expect(execute<boolean>(`${classifierCode} canPrepareClosedJournalDetails(data);`, {...context, data: received})).toBe(true);
		for (const absent of [{...received, authenticatedScopes: []}, {...received, journalMembershipAuthorities: []}])
			expect(execute<boolean>(`${classifierCode} canPrepareClosedJournalDetails(data);`, {...context, data: absent})).toBe(false);
	});
	it("freshly qualifies the complete original runtime census after detached DATA and new native enrollment", async () => {
		const runtimeText = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		const runtime = ts.createSourceFile("v3-live.ts", runtimeText, ts.ScriptTarget.Latest, true);
		const check = select(runtime, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(runtime) === "check" &&
			node.initializer.getText(runtime).includes('throw new TypeError("creator recovery dependency census is stale or unclassified")')).initializer.getText(runtime);
		const finalQualification = select(parsed, (node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed) === "detachedClassification" && node.thenStatement.getText(parsed).includes("await acquireReservations();")).getText(parsed);
		for (const change of ["unchanged", "activeUnsettled", "pendingIngress", "nativeControl", "context"]) {
			const original = {currentJournal: {scope: {objectId: "room", epoch: 3, anchorDigest: "head"}},
				nativeIssuance: {control: {revision: 1}, rows: {issued: [], outbox: []}}};
			const sealed = encodeCanonical(original), actual = structuredClone(original) as any;
			if (change === "activeUnsettled") actual.activeUnsettled = [{digest: "new"}];
			if (change === "pendingIngress") actual.pendingIngress = [{digest: "foreign"}];
			if (change === "nativeControl") actual.nativeIssuance.control.revision++;
			const calls: string[] = [];
			const result = execute<Promise<void>>(`(async()=>{let issuanceRead, journalCurrent, unchangedHeldCensus, mayPrepareUnchanged=false;
				const sourceLifetime={check:${check}}, detachedClassification=true, input={};
				const acquireReservations=async()=>{calls.push("NEW-native");};
				${finalQualification} calls.push("source-delivery");})();`, {
				sealed, calls, sameBytes: (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0,
				census: async () => {calls.push("full-actual-census"); return change === "context" ? undefined : encodeCanonical(actual);},
				checkAbort: () => {},
			});
			if (change === "unchanged") {await result; expect(calls).toEqual(["NEW-native", "full-actual-census", "source-delivery"]);}
			else {await expect(result).rejects.toThrow("creator recovery dependency census is stale or unclassified");
				expect(calls).toEqual(["NEW-native", "full-actual-census"]);}
		}
	});
	it("reacquires an actual NEW header owner after the detached join, never borrowing the revoked seed", async () => {
		const reconcile = select(parsed, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileSnapshotRecoveryRoles");
		const acquire = select(reconcile, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "acquireReservations").getText(parsed);
		const detached = select(reconcile, (node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed) === "detachedClassification" && node.thenStatement.getText(parsed).includes("closed-classification-preparation-detached"));
		const reset = select(detached, (node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) &&
			node.expression.getText(parsed).startsWith("nativeReservations.length = 0")).getText(parsed);
		// Execute all three actual reset statements following length=0, selected
		// from the joined production branch, not a reconstructed test reset.
		const statements = (detached.thenStatement as ts.Block).statements;
		const at = statements.findIndex(statement => statement.getText(parsed) === reset);
		const clear = statements.slice(at, at + 4).map(statement => statement.getText(parsed)).join("\n");
		const calls: string[] = [];
		const result = await execute<Promise<any>>(`(async()=>{
			${["borrowJournalHeaderHold", "ownJournalHeaderHold", "acquireJournalHeaderHold", "joinSourceReleases"].map(declaration).join("\n")}
			const journalHeaderHolds=new WeakMap(),nativeReservations=[],input={objectId:"room",liveJournalStore:journal,store:ahe,roomHeadAuthority:floor,pinnedGenesisAnchorDigest:"genesis"};
			let originalHeaderHold=await acquireJournalHeaderHold(journal,"room"),ownedHeaderHold=originalHeaderHold;
			const old=originalHeaderHold;let journalHeaderHold=borrowJournalHeaderHold(old,journal);
			nativeReservations.push(journalHeaderHold);
			await joinSourceReleases([()=>journalHeaderHold.release(),()=>ownedHeaderHold.release()]);
			${clear}
			const acquireNative=owner=>owner.acquireNativeReadReservation.bind(owner),lifetime={acquireNativeIssuanceReservation:()=>issuer.acquireNativeReadReservation()};
			const ${acquire};await acquireReservations();await journalHeaderHold.check();
			let oldRefused=false;try{await old.check();}catch{oldRefused=true;}
			await joinSourceReleases([...nativeReservations.map(read=>()=>read.release()),()=>ownedHeaderHold.release()]);
			return {oldRefused,newOwner:originalHeaderHold!==old};})();`, {
			calls, journal: {acquireNativeReadReservation: async () => {calls.push("acquire-journal"); let released=false; return {
				check: async () => {if(released) throw Error("native-released");}, release: async () => {released=true;calls.push("release-journal");}};}},
			ahe: {acquireNativeReadReservation: async () => ({check: async () => {}, release: async () => {}})},
			issuer: {acquireNativeReadReservation: async () => ({check: async () => {}, release: async () => {}})},
			floor: {acquireNativeReadReservation: async () => ({check: async () => {}, release: async () => {}})},
		});
		expect(result).toEqual({oldRefused: true, newOwner: true});
		expect(calls).toEqual(["acquire-journal", "release-journal", "acquire-journal", "release-journal"]);
	});
	it("preserves actual local-prefix classification and every charge, with two full checks independent of protected scopes", async () => {
		for (const count of [0, 8]) {
			const old = fixture(count), current = fixture(count);
			const expected = await old.baseline(), result = await current.read();
			expect(result).toEqual(expected);
			expect(result.collectiblePrefixes).toHaveLength(1);
			expect(result.retainedScopes).toHaveLength(count);
			expect(result.retainedScopes.every((item: any) => item.reason === "replay-required")).toBe(true);
			expect(current.charges).toEqual(old.charges);
			expect(current.counts).toEqual({ full: 2, current: 2, snapshots: 2, floors: 2, anchors: 2,
				images: 1, readiness: 1, pages: 1, census: 6, signing: 6, releases: 0 });
			expect(old.counts.full).toBeGreaterThan(2);
			await current.release();
		}
	});
	it("does not deliver a result before the original final currency and outer dependency checks finish", async () => {
		for (const boundary of ["current", "outer"]) {
			const entered = gate(), resume = gate();
			const actual = fixture(8, boundary === "current" ? { onCurrent: async count => { if (count === 2) { entered.open(); await resume.promise; } } } :
				{ onCloseCheck: async count => { if (count === 6) { entered.open(); await resume.promise; } } });
			let delivered = false;
			const pending = actual.read().then((value: unknown) => { delivered = true; return value; });
			await entered.promise; expect(delivered).toBe(false); expect(actual.pendingChecks.size).toBeGreaterThan(0);
			resume.open(); expect((await pending).collectiblePrefixes).toHaveLength(1);
			expect(delivered).toBe(true); await actual.release();
		}
	});
	it("joins the same admitted task through terminal and classified release, revoking new reads immediately", async () => {
		for (const mode of ["terminal", "classified"]) {
			const entered = gate(), resume = gate();
			const actual = fixture(8, { onPage: async () => { entered.open(); await resume.promise; } });
			const observed = actual.read().catch((error: unknown) => error); await entered.promise;
			let released = false;
			const releasing = (mode === "terminal" ? actual.release() : actual.releaseClassified()).then(() => { released = true; });
			await expect(actual.read()).rejects.toThrow("snapshot-unavailable");
			expect(released).toBe(false); expect(actual.counts.releases).toBe(0);
			expect(actual.pendingChecks.size).toBeGreaterThan(0); expect(actual.frame.pending.size).toBe(1);
			resume.open(); expect(await observed).toBeInstanceOf(Error); await releasing;
			expect(actual.pendingChecks.size).toBe(0); expect(actual.frame.pending.size).toBe(0);
			expect(actual.counts.releases).toBe(mode === "terminal" ? 1 : 0);
			if (mode === "classified") await actual.release();
		}
	});
	it("refuses local revocation immediately after each awaited native-read boundary", async () => {
		for (const boundary of ["readiness", "page", "image"]) {
			let actual: any;
			const revoke = () => { actual.revoke(); };
			actual = fixture(8, boundary === "readiness" ? { onReadiness: revoke } : boundary === "page" ? { onPage: revoke } : { onImage: revoke });
			await expect(actual.read()).rejects.toThrow("snapshot-unavailable");
			if (boundary === "readiness") expect(actual.counts.pages).toBe(0);
			if (boundary !== "image") expect(actual.counts.images).toBe(0);
			await actual.release();
		}
	});
	it("preserves late physical-corruption, floor, head, anchor and exact thrown-error refusals", async () => {
		for (const changed of ["image", "floor", "head", "anchor", "throw"]) {
			const failure = Error("fresh current verifier threw");
			let actual: any;
			actual = fixture(8, changed === "image" ? { onImage: () => { actual.state.actualImage = { ...actual.state.actualImage, changed: true }; } } :
				changed === "anchor" ? { onImage: () => { actual.staleAnchor(); } } :
				{ onCurrent: count => { if (count !== 2) return;
					if (changed === "floor") actual.state.actualFloor = { ...actual.state.actualFloor, pending: "changed" };
					if (changed === "head") actual.state.current = false;
					if (changed === "throw") throw failure;
				} });
			if (changed === "throw") await expect(actual.read()).rejects.toBe(failure);
			else await expect(actual.read()).rejects.toThrow(changed === "head" ? "ahe-rejected" : changed === "anchor" ? "anchor-unavailable" : "floor-stale");
			await actual.release();
		}
	});
	it("keeps inputs private and enrolls the identical task in both existing owners before its first execution", async () => {
		expect(source).not.toContain("readClosedJournalDetails");
		const actual = fixture(8), pending = actual.read();
		expect(actual.counts.full).toBe(0);
		expect(actual.frame.pending.size).toBe(1); expect(actual.pendingChecks.size).toBe(1);
		expect([...actual.frame.pending][0]).toBe([...actual.pendingChecks][0]);
		await pending;
		expect(actual.frame.pending.size).toBe(0); expect(actual.pendingChecks.size).toBe(0); await actual.release();
		for (const revoke of ["replaceObservation", "removeHold", "mutateHeader"]) {
			const refused = fixture(8); refused[revoke]();
			await expect(refused.read()).rejects.toThrow("snapshot-unavailable");
			expect(refused.counts.full).toBe(0); expect(refused.charges).toEqual([]); await refused.release();
		}
		for (const revoke of ["replaceDependencies", "replaceLifetime"]) {
			let refused: any; refused = fixture(8, { onPage: () => { refused[revoke](); } });
			await expect(refused.read()).rejects.toThrow("snapshot-unavailable");
			refused.restoreOwner(); await refused.release();
		}
	});
	it("retains full accounting refusal rather than returning an uncharged classification", async () => {
		const actual = fixture(8); actual.state.acceptCharge = false;
		await expect(actual.read()).rejects.toThrow("proof-budget-exceeded");
		expect(actual.counts.full).toBe(1); expect(actual.counts.readiness).toBe(1);
		expect(actual.counts.pages).toBe(0); await actual.release();
	});
});
