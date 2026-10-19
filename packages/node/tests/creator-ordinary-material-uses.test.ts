import {readFileSync} from "node:fs";
import {compareBytes, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Actual existing accounting/projection bodies and warm replay loop. These
// controls assume the enclosing source/native correspondence has succeeded;
// they do not mint that authority or prove native authentication/currentness.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const nodes = tree.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (nodes.length !== 1) throw new Error(`missing original owner:${name}:${nodes.length}`);
	return nodes[0]!.getText(tree).replace(/^export /, "");
}
function evaluate<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
function warmReplayBody(): string {
	const nodes: ts.ForOfStatement[] = [];
	function visit(node: ts.Node): void {
		if (ts.isForOfStatement(node) && node.expression.getText(tree) === "seed.knownMaterial.entries()") nodes.push(node);
		ts.forEachChild(node, visit);
	}
	visit(tree);
	if (nodes.length !== 1) throw new Error(`missing original source-use replay:${nodes.length}`);
	return nodes[0]!.getText(tree);
}
function templateKnownBody(): string {
	const nodes: ts.ForOfStatement[] = [];
	function visit(node: ts.Node): void {
		if (ts.isForOfStatement(node) && node.expression.getText(tree) === "template.known") nodes.push(node);
		ts.forEachChild(node, visit);
	}
	visit(tree);
	if (nodes.length !== 1) throw new Error(`missing original template material selection:${nodes.length}`);
	return nodes[0]!.getText(tree);
}
const equal = (left: unknown, right: unknown) => compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;
describe("original generation source selection after joined OLD journal completion", () => {
	function fixture() {
		// Actual selection body; cryptographic eligibility and exact native row
		// partition capture are controlled premises, verified by the native case.
		const partition = (rows: any[]) => ({recordDigests: rows.map(row => row.generationId),
			identities: rows.map(row => ({generationId: row.generationId, identityDigest: row.generationId})),
			protectedIndices: rows.map((_, index) => index), retireIndices: []});
		const selected = {generationId: "eligible"}, fresh = {fresh: true}, calls: any[] = [];
		const select = evaluate<(input: any) => any>(`${declaration("classifyClosedGenerationSource")}\nreturn classifyClosedGenerationSource;`, {
			requireLaw: (ok: boolean, kind: string) => {if (!ok) throw Error(kind);}, closedRetirementEqual: equal,
			closedGenerationPartition: partition, AHE_BOUNDED_READ_LIMITS: {maxObjectGenerations: 7},
			compareClosedGenerationSources: () => 0,
			closedGenerationSourceFromSelected: (...args: any[]) => {calls.push(args); return fresh;},
		});
		const before = [{generationId: "old"}, {generationId: "retained"}], after = before.slice(1), head = {id: "head"};
		const prior = {reclamation: {closedEpoch: 3, expectedHead: head}, generations: partition(before),
			postGenerations: partition(after), resumeBasisDigest: "exact-old-basis"};
		const input = {frame: {reader: {generations: after}, authenticatedExcludedGenerations: [selected]},
			summary: {head, floor: {epoch: 4, currentAnchorDigest: "anchor"}, cuts: [{epoch: 3, successorAnchorDigest: "anchor"}]},
			control: {active: null as any, completed: {generationDrain: {phase: "complete", source: prior}}},
			unclassified: false, resumeCompleted: false};
		return {select, input, before, after, prior, fresh, selected, calls};
	}
	it("does not replay a finished whole-source commitment after OLD reconstruction has joined", () => {
		const f = fixture();
		expect(f.select(f.input)).toBeUndefined(); expect(f.calls).toEqual([]);
		expect(f.input.control.completed.generationDrain.source).toBe(f.prior);
		expect(f.prior.resumeBasisDigest).toBe("exact-old-basis");
	});
	it("preserves exact OLD replay while its journal reconstruction is still owned", () => {
		const f = fixture(); f.input.resumeCompleted = true;
		expect(f.select(f.input)).toBe(f.prior); expect(f.calls).toEqual([]);
		f.input.frame.reader.generations = [{generationId: "changed"}];
		expect(() => f.select(f.input)).toThrow("floor-stale");
	});
	it("keeps active and physically pending generation work on the exact OLD path", () => {
		for (const active of [true, false]) {
			const f = fixture(); f.input.frame.reader.generations = f.before;
			if (active) f.input.control.active = {preparation: {generationSource: f.prior}};
			else f.input.control.completed.generationDrain.phase = "pending";
			expect(f.select(f.input)).toBe(f.prior); expect(f.calls).toEqual([]);
			f.input.frame.reader.generations = f.after;
			expect(() => f.select(f.input)).toThrow("floor-stale");
		}
	});
	it("new capacity retirement still requires the original positively authenticated selection", () => {
		const f = fixture(); f.input.frame.reader.generations = Array.from({length: 6}, (_, index) => ({generationId: String(index)}));
		expect(f.select(f.input)).toBe(f.fresh);
		expect(f.calls[0]?.[3]).toBe(f.selected);
		f.input.unclassified = true;
		expect(() => f.select(f.input)).toThrow("snapshot-unavailable");
		f.input.unclassified = false; f.input.frame.authenticatedExcludedGenerations = [];
		expect(() => f.select(f.input)).toThrow("snapshot-unavailable");
	});
});
describe("same original signing role index in full and incremental source capture", () => {
	it("keeps re-derived nominal aliases from exhausting the native context bound without losing conflicts", () => {
		// Nominal authentication is an explicit controlled premise here. The
		// real actor still resolves every selected private trust on each read.
		const vector = evaluate<(trusts: Iterable<any>) => readonly any[]>(
			`${declaration("creatorSigningRoleTrustVector")}\nreturn creatorSigningRoleTrustVector;`, {});
		const contexts = Array.from({length: 5}, (_, currentEpoch) =>
			Object.freeze({currentEpoch, currentAnchorDigest: String(currentEpoch).repeat(64)}));
		const aliases = contexts.flatMap(trust => [trust, Object.freeze({...trust})]);
		const roles = new Set(aliases), indexed = vector(roles);
		expect(roles.size).toBe(10); expect(indexed).toHaveLength(5); expect(Object.isFrozen(indexed)).toBe(true);
		for (let index = 0; index < 5; index++) expect(indexed[index]).toBe(aliases[index * 2 + 1]);
		const conflict = Object.freeze({...contexts[4], currentAnchorDigest: "f".repeat(64)});
		expect(vector([...aliases, conflict])).toEqual([...indexed, conflict]);
		// The index neither increases nor replaces the native owner's bound.
		expect(vector(Array.from({length: 8}, (_, currentEpoch) =>
			({currentEpoch, currentAnchorDigest: "a".repeat(64)})))).toHaveLength(8);
		expect(declaration("captureCreatorOrdinaryIssuanceProofSource")).toContain(
			"signingTrusts: creatorSigningRoleTrustVector(frame.signingRoleTrusts)");
		expect(declaration("acquireClosedData")).toContain(
			"let signingTrusts = creatorSigningRoleTrustVector(capturedTrusts)");
	});
});
const maxBytes = 1_310_720;
const materialOwners = new WeakMap<object, any>();
function fixture(compare = compareBytes) {
	const proofMaterialOwners = materialOwners;
	const create = evaluate<(initial: any[]) => any>(`${declaration("projectCreatorProofMaterialByteLengths")}
		${declaration("createCreatorClosedRollbackProofAccounting")}\nreturn createCreatorClosedRollbackProofAccounting;`, {
		proofMaterialOwners, compareBytes: compare, closedRetirementEqual: equal,
		CREATOR_ORDINARY_PROOF_MAX_BYTES: maxBytes, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4_194_304});
	const accounting = create([]), owner = proofMaterialOwners.get(accounting)!;
	return {accounting, owner, proofMaterialOwners};
}
const replay = evaluate<(seed: any, target: ReturnType<typeof fixture>, replaceable?: any) => Uint8Array | undefined>(`
	return (seed, target, replaceable) => {
	 const accounting=target.accounting, materialOwner=target.owner, currentScope=seed.currentScope;
	 let deferredRuntimeCensusObservation;
	 ${warmReplayBody()}
	 return deferredRuntimeCensusObservation;
	};`, {
	compareBytes, closedRetirementEqual: equal,
	requireLaw: (ok: boolean, reason: string) => {if (!ok) throw new Error(reason);},
});

describe("same-owner proof union rejects unequal lengths before byte comparison", () => {
	it("does not walk common prefixes of differently sized carriers while preserving exact aliases and UNKNOWN charges", () => {
		const comparisons: [number, number][] = [];
		const {accounting} = fixture((left, right) => {
			comparisons.push([left.byteLength, right.byteLength]);
			return compareBytes(left, right);
		});
		const carriers = Array.from({length: 64}, (_, index) => new Uint8Array(512 + index).fill(7));
		for (const bytes of carriers) expect(accounting.charge(bytes)).toBe(true);
		const actualBytes = carriers.reduce((sum, bytes) => sum + bytes.byteLength, 0);
		expect(accounting.chargedBytes).toBe(actualBytes);
		expect(comparisons).toEqual([]);
		for (const bytes of carriers) expect(accounting.charge(bytes.slice())).toBe(true);
		expect(accounting.chargedBytes).toBe(actualBytes);
		expect(comparisons).toHaveLength(carriers.length);
		expect(comparisons.every(([left, right]) => left === right)).toBe(true);
		const different = carriers[0]!.slice(); different[different.length - 1] = 8;
		expect(accounting.charge(different)).toBe(true);
		expect(accounting.chargedBytes).toBe(actualBytes + different.byteLength);
		for (let occurrence = 0; occurrence < 2; occurrence++)
			expect(accounting.chargeUnknownEncodedLength(different.byteLength)).toBe(true);
		expect(accounting.chargedBytes).toBe(actualBytes + 3 * different.byteLength);
	});

	it("checks actual current bytes and lengths rather than retaining a mutable-input index", () => {
		const {accounting} = fixture(), borrowed = Uint8Array.of(1, 2);
		expect(accounting.charge(borrowed)).toBe(true);
		borrowed[1] = 3;
		expect(accounting.charge(Uint8Array.of(1, 3))).toBe(true);
		expect(accounting.chargedBytes).toBe(2);
		structuredClone(borrowed, {transfer: [borrowed.buffer]});
		expect(borrowed.byteLength).toBe(0);
		expect(accounting.charge(new Uint8Array())).toBe(true);
		expect(accounting.chargedBytes).toBe(2);
		// An operation-local accounting fact is not authentication or credit in
		// another lifetime, and a failed new charge never refunds the old one.
		expect(accounting.chargeUnknownEncodedLength(maxBytes - 2)).toBe(true);
		expect(accounting.charge(Uint8Array.of(1, 2))).toBe(false);
		expect(accounting.chargedBytes).toBe(maxBytes);
	});
});

describe("same-owner original runtime census observation replacement", () => {
	// Controlled nominal source/runtime premises, NOT native or cryptographic
	// authentication. Original native tests cover the actual producer boundary.
	function censusFixture(kind: "observation" | "raw" | "native" | "snapshot" = "observation") {
		const book = fixture(), identity = {}, currentScope = {objectId: "room", epoch: 3, anchorDigest: "a".repeat(64)},
			issuanceScope = {objectId: "room", author: "local"};
		const liveSource = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8"),
			liveTree = ts.createSourceFile("live.ts", liveSource, ts.ScriptTarget.Latest, true);
		const fields = ["creatorRuntimeCensusFields", "creatorRuntimeActiveCensusFields"].map(name => {
			const node = liveTree.statements.find((node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (!node) throw Error(`missing original census fields:${name}`);
			return node.getText(liveTree);
		}).join("\n");
		const native = {rows: {lineages: [{...issuanceScope, next: 1}], issued: [{...issuanceScope, authorSequence: 0}],
			plans: [{scope: issuanceScope, entries: []}], outbox: []}, image: {}, control: null};
		const census = evaluate<any>(`${fields}\nreturn {...creatorRuntimeCensusFields(
			{dependencyKind:"current-journal",scope,rows:[{}]},
			[{dependencyKind:"issued",scope:issuanceScope,authorSequence:0,digest:new Uint8Array(32),classification:"terminal"}],
			[{scope:issuanceScope,lineageIndex:0,planIndex:0}],1,[{epoch:3,anchorDigest:scope.anchorDigest}]),
			...creatorRuntimeActiveCensusFields({pendingRoots:[],wireByteCharge:0,unsettledSources:[],cursor:null,cacheSourceSequences:[],epoch:3}),
			nativeIssuance:native};`, {scope: currentScope, issuanceScope, native});
		const exact = encodeCanonical(census), raw = bytes("complete original protected PRE/signature/derivative");
		expect(book.owner.chargeObservation(exact)).toBe(true); expect(book.accounting.charge(raw)).toBe(true);
		if (kind === "raw") expect(book.accounting.charge(exact.slice())).toBe(true);
		if (kind === "native") expect(book.owner.chargeNativeReader({bytes: exact, ref: {digest: "c".repeat(64), byteLength: exact.byteLength}})).toBe(true);
		if (kind === "snapshot") expect(book.owner.chargeSnapshotTarget(exact, scope(2))).toBe(true);
		const current = {kind: "local-issuance", ...currentScope, issuanceScope, graphVersion: 1, vertexCount: 2,
			pendingIngressCount: 0, pendingIngressBytes: 0, drainingPendingIngress: false};
		const runtime = {readSourceIdentity: () => identity, readRuntime: () => current, readReceivedAppend: () => undefined};
		const api = evaluate<any>(`${declaration("captureCreatorOrdinaryRuntimeCensusObservation")}
			${declaration("creatorOrdinaryRuntimeCensusHasFreshReplacement")}
			return {capture:captureCreatorOrdinaryRuntimeCensusObservation,replaces:creatorOrdinaryRuntimeCensusHasFreshReplacement};`,
			{proofMaterialOwners: book.proofMaterialOwners, closedRetirementEqual: equal});
		const input = {accounting: book.accounting, bytes: exact, census, identity,
			trust: {objectId: "room", currentEpoch: 3, currentAnchorDigest: currentScope.anchorDigest,
				genesisAnchorDigest: "f".repeat(64), profileId: "settlement-v1"},
			closeDependencies: {dependencyAnchors: structuredClone(census.dependencyAnchors)},
			preparation: {current: {runtime: current, nativeCounts: {currentJournalRows: 1}}}};
		const captured = {...seed(book), identity, currentScope, runtimeCensusObservation: api.capture(input)};
		return {book, identity, currentScope, native, census, exact, raw, current, runtime, api, input, captured};
	}
	function complete(f: ReturnType<typeof censusFixture>, fresh: ReturnType<typeof fixture>, deferred: Uint8Array | undefined,
		check: () => Promise<void> = async () => {}) {
		const acquire = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "acquireCreatorOrdinaryIssuanceMaintenanceProof")!;
		let statement: ts.VariableStatement | undefined, following: ts.Statement | undefined;
		const visit = (node: ts.Node) => {
			if (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl =>
				ts.isIdentifier(decl.name) && decl.name.text === "replacedRuntimeCensusObservation")) {
				statement = node;
				const siblings = (node.parent as ts.Block).statements; following = siblings[siblings.indexOf(node) + 1];
			}
			ts.forEachChild(node, visit);
		}; visit(acquire);
		if (!statement || !following) throw Error("missing original census completion");
		return evaluate<any>(`${declaration("creatorOrdinaryRuntimeCensusHasFreshReplacement")}
			return async () => {${statement.getText(tree)}\n${following.getText(tree)}
			await check(); return replacedRuntimeCensusObservation;};`, {seed: f.captured, runtime: f.runtime,
			nativeIssuance: f.native, journalCorrespondence: {currentRows: [{}]}, deferredRuntimeCensusObservation: deferred,
			accounting: fresh.accounting, check,
			chargeProofObservation: (_book: unknown, bytes: Uint8Array) => fresh.owner.chargeObservation(bytes),
			requireLaw: (ok: boolean, reason: string) => {if (!ok) throw Error(reason);}})();
	}
	it("qualifies only original OBS bytes and keeps raw/native/snapshot aliases fully charged", async () => {
		for (const kind of ["observation", "raw", "native", "snapshot"] as const) {
			const f = censusFixture(kind), fresh = fixture(), before = f.book.accounting.chargedBytes;
			expect(f.captured.runtimeCensusObservation !== undefined).toBe(kind === "observation");
			const deferred = replay(f.captured, fresh), replacement = await complete(f, fresh, deferred);
			expect(replacement !== undefined).toBe(kind === "observation");
			expect(fresh.accounting.chargedBytes).toBe(f.raw.byteLength + (kind === "observation" ? 0 : f.exact.byteLength));
			expect(f.book.accounting.chargedBytes).toBe(before);
			expect(f.captured.knownMaterial).toContainEqual(f.exact); // No destructive source/template filtering.
		}
	});
	it("preserves all fresh wrappers and repeated UNKNOWN while the completed fact only adjusts admission projection", async () => {
		const f = censusFixture(), fresh = fixture(), deferred = replay(f.captured, fresh), oldPaid = f.book.accounting.chargedBytes;
		for (const name of ["journal", "snapshot", "ahe", "floor", "floorImage", "inventory", "nativeIssuance"])
			expect(fresh.owner.chargeObservation(bytes(`fresh complete ${name}`))).toBe(true);
		expect(fresh.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		expect(fresh.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		const before = fresh.accounting.chargedBytes, replacement = await complete(f, fresh, deferred);
		expect(replacement).toEqual(f.exact); expect(fresh.accounting.chargedBytes).toBe(before);
		expect(fresh.owner.captureKnownResourceTotals().unknownEncodedBytes).toBe(256);
		const index = materialIndex(f.captured.knownMaterial, f.captured.knownMaterialUses);
		expect(index.projectAdmission(undefined, replacement)).toEqual({whole: f.raw.byteLength, protected: f.raw.byteLength});
		expect(index.projectAdmission()).toEqual({whole: oldPaid, protected: f.raw.byteLength});
		expect(index.appendAccepted([f.exact]).projectAdmission(undefined, replacement)).toEqual({whole: oldPaid, protected: oldPaid});
		expect(f.book.accounting.chargedBytes).toBe(oldPaid);
	});
	it("unsupported or stale replacement pays the old observation and final currency failure publishes no completed fact", async () => {
		for (const alter of [
			(f: ReturnType<typeof censusFixture>) => {f.current.vertexCount++;},
			(f: ReturnType<typeof censusFixture>) => {f.current.pendingIngressCount = 1;},
			(f: ReturnType<typeof censusFixture>) => {f.native.rows.lineages[0].author = "foreign";},
			(f: ReturnType<typeof censusFixture>) => {f.runtime.readSourceIdentity = () => ({});},
		]) {
			const f = censusFixture(), fresh = fixture(), deferred = replay(f.captured, fresh); alter(f);
			expect(await complete(f, fresh, deferred)).toBeUndefined();
			expect(fresh.accounting.chargedBytes).toBe(f.book.accounting.chargedBytes);
		}
		const f = censusFixture(), fresh = fixture(), deferred = replay(f.captured, fresh);
		await expect(complete(f, fresh, deferred, async () => {throw Error("ORIGINAL_FINAL_CURRENCY_FAILURE");}))
			.rejects.toThrow("ORIGINAL_FINAL_CURRENCY_FAILURE");
		const acquire = declaration("acquireCreatorOrdinaryIssuanceMaintenanceProof");
		expect(acquire.lastIndexOf("await check();", acquire.indexOf("const begin ="))).toBeLessThan(acquire.indexOf("maintenanceTerminalCustody.set(proof"));
		expect(acquire).toContain("...(replacedRuntimeCensusObservation === undefined ? {} : {replacedRuntimeCensusObservation})");
		const suffix = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "creatorOrdinarySuffixCapacityForSizing")!;
		let projection: ts.CallExpression | undefined;
		const findProjection = (node: ts.Node) => {
			if (ts.isCallExpression(node) && node.expression.getText(tree) === "source.capacity.material.projectCurrentProtected") projection = node;
			ts.forEachChild(node, findProjection);
		}; findProjection(suffix);
		if (!projection) throw Error("missing original whole-suffix admission projection");
		const index = materialIndex(f.captured.knownMaterial, f.captured.knownMaterialUses);
		expect(evaluate(`return ${projection.getText(tree)};`, {source: {capacity: {material: index}}, proof: {accounting: fresh.accounting},
			facts: {proofFacts: {capture: {replacedRuntimeCensusObservation: deferred}}}}))
			.toEqual({whole: f.raw.byteLength, protected: f.raw.byteLength});
	});
	it("unfamiliar census fields, pending/source/debt domains and altered scope cannot enroll a replacement", () => {
		const f = censusFixture();
		for (const census of [{...f.census, unsupported: true}, {...f.census, graphVersion: 2},
			{...f.census, pendingIngress: {...f.census.pendingIngress, roots: [{}]}},
			{...f.census, activeUnsettled: {...f.census.activeUnsettled, sources: [{}]}},
			{...f.census, currentJournal: {...f.census.currentJournal, scope: {...f.currentScope, anchorDigest: "b".repeat(64)}}},
			{...f.census, rows: [{...f.census.rows[0], unsupported: true}]},
			{...f.census, debt: [{...f.census.debt[0], unsupported: true}]}])
			expect(f.api.capture({...f.input, census})).toBeUndefined();
	});
	it("requires the original close child's complete exact anchor bindings, including historical Cut/certificate anchors", () => {
		const f = censusFixture(), anchors = [{epoch: 0, anchorDigest: f.input.trust.genesisAnchorDigest},
			{epoch: 1, anchorDigest: "c".repeat(64)}, {epoch: 2, anchorDigest: "b".repeat(64)},
			{epoch: 3, anchorDigest: f.currentScope.anchorDigest}];
		// This fixture explicitly assumes original nominal acquireClosedData
		// validation; these copied identities cannot mint that native capability.
		const input = {...f.input, census: {...f.census, dependencyAnchors: anchors},
			closeDependencies: {dependencyAnchors: structuredClone(anchors)}};
		const captured = f.api.capture(input);
		expect(captured).toBeDefined();
		expect(Object.keys(captured).sort()).toEqual(["author", "bytes", "graphVersion", "identity", "scope"]);
		expect(f.api.capture({...input, closeDependencies: undefined})).toBeUndefined();
		for (const dependencyAnchors of [anchors.slice(1), [...anchors].reverse(),
			anchors.map(anchor => anchor.epoch === 1 ? {...anchor, anchorDigest: "e".repeat(64)} : anchor),
			[...anchors, {epoch: 4, anchorDigest: "d".repeat(64)}]])
			expect(f.api.capture({...input, closeDependencies: {dependencyAnchors}})).toBeUndefined();
		expect(f.api.capture({...input, census: {...input.census, dependencyAnchors: anchors.slice(1)}})).toBeUndefined();
		const source = declaration("captureCreatorOrdinaryIssuanceProofSource");
		expect(source).toContain("closeDependencies: frame.closeDependencies");
		expect(declaration("captureCreatorOrdinaryRuntimeCensusObservation")).not.toContain("predecessorTrust");
	});
	it("matches the original nominal direct-received empty/non-draining and queued-received states only", () => {
		const f = censusFixture(); f.current.kind = "received-append";
		Object.assign(f.runtime, {readReceivedAppend: () => ({sourceAuthorized: false})});
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(true);
		f.current.pendingIngressCount = 1; f.current.pendingIngressBytes = 128; f.current.drainingPendingIngress = true;
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(true);
		f.current.drainingPendingIngress = false;
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(false);
		f.current.pendingIngressCount = 0;
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(false);
		f.current.pendingIngressBytes = 0;
		Object.assign(f.runtime, {readReceivedAppend: () => ({sourceAuthorized: true})});
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(false);
		Object.assign(f.runtime, {readReceivedAppend: () => undefined});
		expect(f.api.replaces(f.captured, f.runtime, f.native, [{}])).toBe(false);
	});
});
const scope = (epoch: number) => ({objectId: "room", epoch, anchor: "a".repeat(64), manifestDigest: String(epoch).repeat(64)});
const bytes = (name: string) => encodeCanonical({material: name});
function seed(f: ReturnType<typeof fixture>) {
	return {knownMaterial: f.owner.captureKnownMaterial(), knownProtectedMaterial: f.owner.captureKnownProtectedMaterial(),
		knownMaterialUses: f.owner.captureKnownMaterialUses(), identity: {},
		currentScope: {objectId: "room", epoch: 2, anchorDigest: "a".repeat(64)}};
}
const materialIndex = evaluate<(material: readonly Uint8Array[], uses: readonly any[]) => any>(`
	${declaration("projectCreatorProofMaterialByteLengths")}
	${declaration("createCreatorOrdinaryFinishingMaterialIndex")}
	return createCreatorOrdinaryFinishingMaterialIndex;`, {compareBytes, closedRetirementEqual: equal, proofMaterialOwners: materialOwners});

describe("ordinary finishing template isolates retained source bytes", () => {
	it("captures owned bytes without invoking caller slice or species hooks", () => {
		const f = fixture(), original = Uint8Array.of(1, 2);
		f.accounting.charge(original);
		Object.defineProperty(original, "slice", {value: () => original});
		Object.defineProperty(original, "constructor", {get: () => {throw Error("caller species hook");}});
		const captured = f.owner.captureKnownMaterial(), protectedBytes = f.owner.captureKnownProtectedMaterial();
		// Do not let the matcher's diagnostic deep-equality probe invoke the
		// deliberately hostile constructor on the ORIGINAL input.
		expect(captured[0] === original).toBe(false); expect(protectedBytes[0] === original).toBe(false);
		original.fill(3);
		expect(captured).toEqual([Uint8Array.of(1, 2)]); expect(protectedBytes).toEqual([Uint8Array.of(1, 2)]);
	});

	it("does not expose the private source/index byte leaf through caller-visible known carriers", () => {
		const f = fixture(), original = bytes("protected source PRE, not a transferable allowance");
		f.accounting.charge(original);
		const captured = seed(f), index = materialIndex(captured.knownMaterial, captured.knownMaterialUses);
		const select = evaluate<(seed: any) => readonly Uint8Array[]>(`return seed => {
			const leaves=new Map(), known=[], template={known:[{kind:"source",index:0},{kind:"source",index:0}]};
			${templateKnownBody()}
			return Object.freeze(known);
		};`, {});
		const before = index.project(), first = select(captured);
		expect(first[0]).toEqual(original); expect(first[0]).not.toBe(captured.knownMaterial[0]);
		expect(first[0]).not.toBe(first[1]);
		first[0]!.fill(0);
		structuredClone(first[1]!, {transfer: [first[1]!.buffer]});
		expect(captured.knownMaterial).toEqual([original]);
		expect(index.project()).toEqual(before);
		const second = select(captured);
		expect(second).toEqual([original, original]);
		expect(second[0]).not.toBe(first[0]);
	});
});

describe("same-owner exact material-use capture and fresh-book enrollment", () => {
	it("projects the provisional protected union without cloning or persistently enrolling current observations", () => {
		const baseline = fixture(), raw = bytes("full source PRE"), observed = bytes("source OBS"), scoped = bytes("native and snapshot alias"),
			pair = scope(1), ref = {digest: "f".repeat(64), byteLength: scoped.byteLength};
		baseline.accounting.charge(raw); baseline.owner.chargeObservation(observed);
		baseline.owner.chargeNativeReader({bytes: scoped, ref}); baseline.owner.chargeSnapshotTarget(scoped.slice(), pair);
		const captured = seed(baseline), index = materialIndex(captured.knownMaterial, captured.knownMaterialUses);
		const current = fixture(), wrapper = bytes("this quote only"), sameLengthDifferentBytes = wrapper.slice();
		sameLengthDifferentBytes[0] ^= 1;
		current.accounting.charge(raw.slice()); current.accounting.charge(observed.slice());
		current.accounting.charge(wrapper); current.accounting.charge(sameLengthDifferentBytes);
		current.owner.chargeObservation(bytes("current OBS only"));
		current.accounting.chargeUnknownEncodedLength(74);
		const beforeIndex = index.project(), beforeBook = current.owner.captureKnownResourceTotals();
		const oldPath = index.appendAccepted(current.owner.captureKnownProtectedMaterial());
		const expected = oldPath.project();
		// Source OBS promoted by CURRENT raw bytes survives even the exact OBS
		// exclusion; original native/snapshot aliases always retain their uses.
		const expectedAdmission = oldPath.projectAdmission(observed, scoped);
		const protectedBuffers = [raw, observed, wrapper, sameLengthDifferentBytes];
		for (const buffer of protectedBuffers) Object.defineProperty(buffer, "slice", {value: () => {throw Error("unexpected provisional clone");}});
		expect(index.projectCurrentProtected(current.accounting)).toEqual(expected);
		expect(index.projectCurrentProtected(current.accounting, observed, scoped)).toEqual(expectedAdmission);
		expect(index.projectCurrentProtected(current.accounting)).toEqual(expected); // exact retry
		expect(index.project()).toEqual(beforeIndex);
		expect(current.owner.captureKnownResourceTotals()).toEqual(beforeBook);
		expect(beforeBook.unknownEncodedBytes).toBe(74); // separate occurrence term, not transferred here
		expect(index.project([pair], [])).toEqual({whole: beforeIndex.whole, protected: raw.byteLength});
		expect(() => index.projectCurrentProtected({})).toThrow("owner unavailable");
		for (const name of ["deriveCreatorOrdinarySourceResourceProgramForSizing", "creatorOrdinarySuffixCapacityForSizing",
			"deriveCreatorOrdinaryFinishingCapacityForSizing"]) {
			expect(declaration(name)).not.toContain("captureKnownProtectedMaterial");
			expect(declaration(name)).not.toContain(".appendAccepted(");
		}
	});

	it("preserves all overlapping native/snapshot uses and raw dominance, aligned with one exact-byte union", () => {
		const f = fixture(), raw = bytes("raw"), observed = bytes("observed"), mixed = bytes("mixed"),
			ref = {digest: "b".repeat(64), byteLength: mixed.byteLength}, first = scope(0), second = scope(1);
		expect(f.accounting.charge(raw)).toBe(true);
		expect(f.owner.chargeObservation(observed)).toBe(true);
		expect(f.owner.chargeNativeReader({bytes: mixed, ref})).toBe(true);
		expect(f.owner.chargeSnapshotTarget(mixed.slice(), first)).toBe(true);
		expect(f.owner.chargeSnapshotTarget(mixed.slice(), second)).toBe(true);
		expect(f.owner.chargeNativeReader({bytes: mixed.slice(), ref: {...ref}})).toBe(true);
		const captured = seed(f);
		expect(captured.knownMaterial).toHaveLength(3); expect(captured.knownMaterialUses).toHaveLength(3);
		expect(captured.knownMaterialUses[0]).toEqual({protected: true, snapshotScopes: [], nativeReaderRefs: []});
		expect(captured.knownMaterialUses[1]).toEqual({protected: false, snapshotScopes: [], nativeReaderRefs: []});
		expect(captured.knownMaterialUses[2]).toEqual({protected: false, snapshotScopes: [first, second], nativeReaderRefs: [ref]});
		const fresh = fixture(); replay(captured, fresh);
		expect(fresh.accounting.chargedBytes).toBe(f.accounting.chargedBytes);
		expect(fresh.owner.captureKnownMaterialUses()).toEqual(captured.knownMaterialUses);
		for (const retired of [[], [first], [first, second]]) for (const refs of [undefined, [], [ref]])
			for (const additional of [[], [observed.slice()]])
				expect(fresh.owner.projectByteLengths(additional, retired, refs)).toEqual(f.owner.projectByteLengths(additional, retired, refs));
		const charged = f.accounting.chargedBytes;
		expect(f.owner.projectByteLengths([], [first], [])).toEqual({whole: charged, protected: raw.byteLength + mixed.byteLength});
		expect(f.owner.projectByteLengths([], [first, second], [])).toEqual({whole: charged, protected: raw.byteLength});
		expect(f.accounting.chargedBytes).toBe(charged); // Projection is never a live refund.
	});

	it("detaches and freezes use metadata without duplicating raw bytes into the use vector", () => {
		const f = fixture(), leaf = bytes("snapshot"), originalScope = scope(1), ref = {digest: "c".repeat(64), byteLength: leaf.byteLength};
		expect(f.owner.chargeSnapshotTarget(leaf, originalScope)).toBe(true);
		expect(f.owner.chargeNativeReader({bytes: leaf, ref})).toBe(true);
		const captured = seed(f), use = captured.knownMaterialUses[0];
		expect(Object.keys(use).sort()).toEqual(["nativeReaderRefs", "protected", "snapshotScopes"]);
		for (const value of [captured.knownMaterialUses, use, use.snapshotScopes, use.snapshotScopes[0], use.nativeReaderRefs, use.nativeReaderRefs[0]])
			expect(Object.isFrozen(value)).toBe(true);
		expect(use.snapshotScopes[0]).not.toBe(originalScope); expect(use.nativeReaderRefs[0]).not.toBe(ref);
		expect(() => {use.snapshotScopes[0].epoch = 9;}).toThrow();
		expect(() => {use.nativeReaderRefs.push({...ref});}).toThrow();
		captured.knownMaterial[0].fill(0);
		expect(f.owner.captureKnownMaterial()).toEqual([leaf]);
		expect(f.owner.captureKnownMaterialUses()[0].snapshotScopes).toEqual([originalScope]);
	});

	it("captures no paid credit or UNKNOWN identity, and preserves repeated full UNKNOWN charges", () => {
		const f = fixture(), raw = bytes("protected");
		expect(f.accounting.charge(raw)).toBe(true);
		expect(f.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		expect(f.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		const captured = seed(f), fresh = fixture();
		expect(captured.knownMaterial).toEqual([raw]); expect(captured.knownMaterialUses).toHaveLength(1);
		expect(f.owner.captureKnownResourceTotals().unknownEncodedBytes).toBe(256);
		replay(captured, fresh);
		expect(fresh.accounting.chargedBytes).toBe(raw.byteLength); // No paid-credit transfer, no UNKNOWN-to-known conversion.
		expect(fresh.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		expect(fresh.accounting.chargeUnknownEncodedLength(128)).toBe(true);
		expect(fresh.accounting.chargedBytes).toBe(f.accounting.chargedBytes);
		expect(f.owner.projectByteLengths([], [], [])).toEqual({whole: raw.byteLength + 256, protected: raw.byteLength + 256});
		expect(fresh.owner.projectByteLengths([], [], [])).toEqual(f.owner.projectByteLengths([], [], []));
	});

	it("omits only the exact qualified OBS-only journal carrier, never any raw/native/snapshot use", () => {
		for (const kind of ["observation", "raw", "native", "snapshot"] as const) {
			const f = fixture(), leaf = bytes("old journal observation");
			expect(f.owner.chargeObservation(leaf)).toBe(true);
			if (kind === "raw") expect(f.accounting.charge(leaf.slice())).toBe(true);
			if (kind === "native") expect(f.owner.chargeNativeReader({bytes: leaf, ref: {digest: "d".repeat(64), byteLength: leaf.byteLength}})).toBe(true);
			if (kind === "snapshot") expect(f.owner.chargeSnapshotTarget(leaf, scope(0))).toBe(true);
			const captured = seed(f), fresh = fixture(), oldCharge = f.accounting.chargedBytes;
			replay(captured, fresh, {identity: captured.identity, scope: captured.currentScope, bytes: leaf.slice()});
			expect(fresh.accounting.chargedBytes).toBe(kind === "observation" ? 0 : leaf.byteLength);
			expect(f.accounting.chargedBytes).toBe(oldCharge);
			const newWrapper = bytes("complete fresh journal observation");
			expect(fresh.owner.chargeObservation(newWrapper)).toBe(true);
			expect(fresh.accounting.chargedBytes).toBe((kind === "observation" ? 0 : leaf.byteLength) + newWrapper.byteLength);
		}
	});

	it("refuses reenrollment under an exhausted fresh book without refunding either lifetime", () => {
		const f = fixture(), leaf = bytes("full original protected material");
		expect(f.accounting.charge(leaf)).toBe(true);
		const captured = seed(f), fresh = fixture(), reserved = maxBytes - leaf.byteLength + 1;
		expect(fresh.accounting.chargeUnknownEncodedLength(reserved)).toBe(true);
		expect(() => replay(captured, fresh)).toThrow("proof-budget-exceeded");
		expect(fresh.accounting.chargedBytes).toBe(reserved);
		expect(fresh.owner.captureKnownResourceTotals()).toEqual({knownBytes: 0, protectedBytes: 0, unknownEncodedBytes: reserved});
		expect(f.accounting.chargedBytes).toBe(leaf.byteLength);
		expect(fresh.accounting.chargeUnknownEncodedLength(leaf.byteLength)).toBe(false);
	});

	it("immutable finishing index promotes an exact accepted alias without changing its prior version or losing scoped uses", () => {
		const observed = fixture(), observation = bytes("replaceable journal OBS");
		expect(observed.owner.chargeObservation(observation)).toBe(true);
		const observedSeed = seed(observed), observationIndex = materialIndex(observedSeed.knownMaterial, observedSeed.knownMaterialUses);
		expect(observationIndex.projectAdmission(observation.slice())).toEqual({whole: 0, protected: 0});
		expect(observationIndex.projectAdmission(bytes("another OBS"))).toEqual({whole: observation.byteLength, protected: 0});
		const rawAlias = observationIndex.appendAccepted([observation.slice()]);
		expect(rawAlias.projectAdmission(observation)).toEqual({whole: observation.byteLength, protected: observation.byteLength});
		expect(observationIndex.projectAdmission(observation)).toEqual({whole: 0, protected: 0});
		const f = fixture(), leaf = bytes("retained source and snapshot"), pair = scope(1),
			ref = {digest: "e".repeat(64), byteLength: leaf.byteLength};
		expect(f.owner.chargeNativeReader({bytes: leaf, ref})).toBe(true);
		expect(f.owner.chargeSnapshotTarget(leaf.slice(), pair)).toBe(true);
		const captured = seed(f), initial = materialIndex(captured.knownMaterial, captured.knownMaterialUses);
		expect(initial.projectAdmission(leaf)).toEqual({whole: leaf.byteLength, protected: leaf.byteLength});
		expect(initial.project([pair], [])).toEqual({whole: leaf.byteLength, protected: 0});
		const advanced = initial.appendAccepted([leaf.slice()]);
		expect(advanced).not.toBe(initial); expect(Object.isFrozen(advanced)).toBe(true);
		expect(advanced.projectAdmission(leaf)).toEqual({whole: leaf.byteLength, protected: leaf.byteLength});
		expect(advanced.project([pair], [])).toEqual({whole: leaf.byteLength, protected: leaf.byteLength});
		expect(initial.project([pair], [])).toEqual({whole: leaf.byteLength, protected: 0});
		// Same original law, not an independent allowance or manufactured credit.
		expect(f.accounting.charge(leaf.slice())).toBe(true);
		for (const retired of [[], [pair]]) for (const refs of [undefined, [], [ref]])
			expect(advanced.project(retired, refs)).toEqual(f.owner.projectByteLengths([], retired, refs));
		expect(f.accounting.chargedBytes).toBe(leaf.byteLength);
	});

	it("immutable finishing index detaches accepted raw additions and exact retry never adds a second obligation", () => {
		const initial = materialIndex([], []), preimage = bytes("new complete signed preimage"), signature = new Uint8Array(64).fill(7),
			exactPreimage = preimage.slice(), exactSignature = signature.slice();
		const next = initial.appendAccepted([preimage, signature]);
		preimage.fill(0); signature.fill(0);
		const expected = {whole: exactPreimage.byteLength + exactSignature.byteLength,
			protected: exactPreimage.byteLength + exactSignature.byteLength};
		expect(next.project([], [])).toEqual(expected);
		expect(next.appendAccepted([exactPreimage, exactSignature]).project([], [])).toEqual(expected);
		expect(initial.project()).toEqual({whole: 0, protected: 0});
		expect(() => materialIndex([exactPreimage], [])).toThrow("annotation mismatch");
	});
});
