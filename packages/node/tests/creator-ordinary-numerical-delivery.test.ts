import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Control-flow tests only: these extract private production arithmetic/delivery
// seams. They do not construct nominal proofs, native grants or budget credit.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
	const found = tree.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found === undefined) throw new Error(`missing original owner seam: ${name}`);
	return found;
}
interface DeliveryOwner {
	checkReadEligibility(): Promise<void>;
	check(adjacent?: AdjacentTarget): Promise<void>;
}
type AdjacentTarget = "pre-callback" | "begin";
type AdjacentClaim = {consume(target?: AdjacentTarget): boolean};
type NumericalRead = <T>(owner: DeliveryOwner, read: () => T) => Promise<T>;
function numericalRead(): NumericalRead {
	const js = ts.transpileModule(declaration("runCreatorOrdinaryNumericalReadForSizing").getText(tree),
		{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function(`${js}\nreturn runCreatorOrdinaryNumericalReadForSizing;`)() as NumericalRead;
}
function deferred(): {promise: Promise<void>; finish(): void} {
	let finish!: () => void;
	const promise = new Promise<void>(resolve => {finish = resolve;});
	return {promise, finish};
}
function nodesWithin(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
	const found: ts.Node[] = [];
	const visit = (node: ts.Node): void => {if (predicate(node)) found.push(node); ts.forEachChild(node, visit);};
	visit(node); return found;
}

function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings;\n${js}`)(bindings) as T;
}

describe("ordinary dimension owner integrity without repeated serialization", () => {
	function fixture() {
		const path = new URL("../src/v3-live.ts", import.meta.url),
			ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const helper = ast.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "captureCreatorOrdinaryDimensionIntegrity");
		if (helper === undefined) throw Error("missing original dimension integrity owner");
		const state = {encodes: 0}, typed = Object.getPrototypeOf(Uint8Array.prototype);
		const capture = execute<(value: unknown) => () => boolean>(helper.getText(ast) + "\nreturn captureCreatorOrdinaryDimensionIntegrity;", {
			encodeCanonical: (value: unknown) => {state.encodes++; return encodeCanonical(value);},
			Uint8ArrayConstructor: Uint8Array, TypedArrayPrototype: typed,
			TypedArrayByteLengthGetter: Object.getOwnPropertyDescriptor(typed, "byteLength")!.get,
			TypedArrayBufferGetter: Object.getOwnPropertyDescriptor(typed, "buffer")!.get, ReflectApply: Reflect.apply,
			ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			ObjectDefineProperty: Object.defineProperty,
			ObjectIsFrozen: Object.isFrozen, ObjectPrototype: Object.prototype, ReflectOwnKeys: Reflect.ownKeys,
			ArrayIsArray: Array.isArray, sameBytes: (left: Uint8Array, right: Uint8Array) => compareBytes(left, right) === 0,
		});
		return {capture, state};
	}
	it("validates new complete data once and compares only captured byte leaves under frozen containers", () => {
		const f = fixture(), bytes = Uint8Array.of(1, 2), second = Uint8Array.of(3),
			value = Object.freeze({context: "room", count: 3, ordered: Object.freeze([
				Object.freeze({preimage: bytes}), Object.freeze({state: second}), bytes,
			])});
		const intact = f.capture(value); expect(f.state.encodes).toBe(1);
		for (let index = 0; index < 8; index++) expect(intact()).toBe(true);
		expect(f.state.encodes).toBe(1); // No whole-context serialization in repeated delivery.
		bytes[0] = 9; expect(intact()).toBe(false); bytes[0] = 1; expect(intact()).toBe(true);
		second[0] = 9; expect(intact()).toBe(false); second[0] = 3; expect(intact()).toBe(true);
		expect(f.state.encodes).toBe(1); // Refusal/restoration neither advances nor poisons the capture.
	});
	it("preserves original canonical equality for mutable records and fallback for Maps, Sets and non-byte typed arrays", () => {
		for (const value of [{nested: {count: 1}}, {nested: new Map([["key", 1]])},
			{nested: new Set([1])}, {nested: new Float32Array([1])}]) {
			const f = fixture(), intact = f.capture(Object.freeze(value));
			expect(intact()).toBe(true); expect(f.state.encodes).toBe(2);
			const nested = value.nested;
			if (nested instanceof Map) nested.set("key", 2);
			else if (nested instanceof Set) nested.add(2);
			else if (nested instanceof Float32Array) nested[0] = 2;
			else nested.count = 2;
			expect(intact()).toBe(false); expect(f.state.encodes).toBe(3);
		}
		const f = fixture(), nested = {number: -0}, intact = f.capture(Object.freeze({nested}));
		nested.number = 0; expect(intact()).toBe(true); // Same original canonical normalization.
	});
	it("falls back on changed byte metadata/prototypes and preserves exact original refusal and equality", () => {
		const f = fixture(), bytes = Uint8Array.of(1, 2), intact = f.capture(Object.freeze({bytes}));
		Object.defineProperty(bytes, "byteLength", {value: 1, configurable: true});
		expect(intact()).toBe(false); expect(f.state.encodes).toBe(2);
		Object.defineProperty(bytes, "byteLength", {value: 2, configurable: true});
		expect(intact()).toBe(true); expect(f.state.encodes).toBe(3);
		Reflect.deleteProperty(bytes, "byteLength");
		Object.setPrototypeOf(bytes, Object.create(Uint8Array.prototype));
		expect(intact()).toBe(true); expect(f.state.encodes).toBe(4);
		Object.setPrototypeOf(bytes, Uint8Array.prototype); bytes[1] = 9;
		expect(intact()).toBe(false); expect(f.state.encodes).toBe(4);
	});
	it("does not make canonical validation of new malformed or oversized structures optional", () => {
		const f = fixture(), cycle: any = {}; cycle.self = cycle;
		for (const value of [{bad: "\ud800"}, {bad: undefined}, cycle,
			Object.freeze({get accessor() {return 1;}})]) expect(() => f.capture(value)).toThrow();
		let deep: unknown = 1; for (let index = 0; index < 130; index++) deep = Object.freeze({deep});
		expect(() => f.capture(deep)).toThrow();
		const validBom = f.capture(Object.freeze({text: "\ufeffunchanged"}));
		expect(validBom()).toBe(true); // Encoder's original string rules, not a different codec.
	});
	it("refuses detached byte buffers including the zero-length case without poisoning other captures", () => {
		for (const length of [0, 2]) {
			const f = fixture(), bytes = new Uint8Array(length), intact = f.capture(Object.freeze({bytes}));
			expect(intact()).toBe(true);
			structuredClone(bytes.buffer, {transfer: [bytes.buffer]});
			expect(() => encodeCanonical({bytes})).toThrow(); expect(intact()).toBe(false);
			expect(f.capture(Object.freeze({bytes: new Uint8Array(length)}))()).toBe(true);
		}
	});
});
function acquisitionVariable(name: string): string {
	const declarations = nodesWithin(declaration("acquireCreatorOrdinaryIssuanceMaintenanceProof"), node =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) as ts.VariableDeclaration[];
	if (declarations.length !== 1) throw new Error(`missing original acquisition guard: ${name}`);
	const list = declarations[0]!.parent, statement = list.parent;
	if (!ts.isVariableStatement(statement)) throw new Error(`invalid original acquisition guard: ${name}`);
	return statement.getText(tree);
}
function guardFixture() {
	const events: string[] = [], identity = {}, signing = {}, head = {generation: "current"}, snapshot = {version: 1};
	const inventory = {scopes: [{scope: "current"}], owner: {incarnation: "original"}}, floorImage = {stable: "current"};
	const state = {aborted: false, runtimeClosed: false, readPhaseRevoked: false, sourceCurrent: true, facadeClosed: false,
		ready: true, snapshot: {...snapshot}, inventory: structuredClone(inventory), floor: {...floorImage},
		issuerCurrent: true, childFailure: undefined as string | undefined, onImage: undefined as (() => void) | undefined,
		onHeldCheck: undefined as ((name: string) => Promise<void>) | undefined,
		onCurrency: undefined as (() => Promise<void>) | undefined,
		onHead: undefined as (() => Promise<void>) | undefined,
		onReadiness: undefined as (() => Promise<void>) | undefined};
	const capturedFrame: {alive: boolean; pending: Set<Promise<unknown>>; adjacentCheck?: AdjacentClaim} = {alive: true, pending: new Set()};
	const bytesEqual =(left: Uint8Array, right: Uint8Array): number =>
		left.length === right.length && left.every((value, index) => value === right[index]) ? 0 : 1;
	const requireLaw = (accepted: boolean, code: string): void => {if (!accepted) throw new Error(code);};
	const owned = ["issuer", "ahe", "floor", "journal", "snapshot"].map(name => ({check: async () => {
		events.push(`held:${name}`); await state.onHeldCheck?.(name);
		if (state.childFailure === name) throw new Error(`closed:${name}`);
	}}));
	const runtime = {
		readSourceIdentity: () => {events.push("source"); return state.sourceCurrent ? identity : {};},
		checkWhile: async (read: () => Promise<void>, actualSigning: object) => {
			expect(actualSigning).toBe(signing); events.push("runtime:before", "signing:before");
			if (state.runtimeClosed) throw new Error("runtime-closed");
			if (state.readPhaseRevoked) throw new Error("read-phase-revoked");
			await read(); events.push("signing:after", "runtime:after");
			if (state.runtimeClosed || state.readPhaseRevoked) throw new Error("runtime-revoked");
		},
		readNativeIssuance: async () => {events.push("issuer:full"); return {rows: state.issuerCurrent ? "current" : "changed"};},
	};
	const input = {signal: state, objectId: "room", liveJournalStore: {},
		store: {readHead: async () => {events.push("head:facade"); await state.onHead?.(); if (state.facadeClosed) throw new Error("ahe-facade-closed"); return {ok: true, value: head};}},
		readiness: async () => {events.push("snapshot:readiness"); await state.onReadiness?.(); return {ready: state.ready};},
		snapshotStore: {
			readRetirementAdmissionImage: async () => {events.push("snapshot:image"); state.onImage?.(); return state.snapshot;},
			captureRecoveryRoleInventory: async () => {events.push("snapshot:inventory"); return state.inventory;},
		}};
	const bindings = {state, runtime, input, requireLaw, capturedFrame, seed: {identity, head, inventoryBytes: encodeCanonical(inventory)},
		owned, capturedReader: {checkCurrent: async () => {events.push("ahe:currency"); await state.onCurrency?.(); return {ok: true};}}, objectId: {value: "room"},
		snapshotOwnerReadable: (_input: unknown, value: {ready: boolean}) => value.ready,
		snapshotCall: (read: () => Promise<unknown>) => read(),
		bindMethod: (owner: Record<string, (...args: unknown[]) => unknown>, name: string) => owner[name]!.bind(owner),
		readFloor: async () => {events.push("floor:current"); return state.floor;}, floorScope: {}, floorImage,
		readJournal: {}, journal: {value: {rows: "current"}}, snapshot, signing,
		nativeIssuance: {rows: "current"},
		checkCreatorOrdinaryJournalCurrentImage: async () => {events.push("journal:current"); return {};},
		checkAbort: (signal: typeof state) => {events.push("abort"); if (signal.aborted) throw new Error("aborted");},
		closedRetirementEqual: (left: unknown, right: unknown) => bytesEqual(encodeCanonical(left), encodeCanonical(right)) === 0,
		closedRetirementBytes: encodeCanonical, compareBytes: bytesEqual,
		pointProbe: {checkCurrent: async () => {events.push("issuer:current"); return state.issuerCurrent;}},
	};
	const guards = execute<DeliveryOwner & {release(): void}>(`
		let released = false, journalProbe, issuanceProbe = pointProbe;
		${nodesWithin(declaration("acquireCreatorOrdinaryIssuanceMaintenanceProof"), node =>
			ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "joinIndependentNativeChecks").length === 0
			? "" : acquisitionVariable("joinIndependentNativeChecks")}
		${["checkPointsBefore", "checkPointsAfter", "checkReadEligibility", "check"].map(acquisitionVariable).join("\n")}
		return {checkReadEligibility, check, release: () => {released = true;}};`, bindings);
	return {state, events, guards, bindings, capturedFrame};
}

function dimensionFixture() {
	const fixture = guardFixture(), accounting = {chargedBytes: 10}, current = {}, custody = new WeakMap<object, unknown>();
	const stamp = {current: true, mints: 0};
	const runtime = Object.assign(fixture.bindings.runtime, {
		readCurrentDimensions: () => {fixture.events.push("math:dimensions"); return current;},
		resolveCurrentDimensions: (value: object) => stamp.current ? value : undefined,
	});
	const assignments = nodesWithin(declaration("acquireCreatorOrdinaryIssuanceMaintenanceProof"), node =>
		ts.isPropertyAssignment(node) && node.name.getText(tree) === "readCurrentDimensions") as ts.PropertyAssignment[];
	if (assignments.length !== 1) throw new Error("missing original dimension property");
	const proof = execute<{readCurrentDimensions(bytes: Uint8Array): Promise<object | undefined>}>(`
		const source = sourceHandle, seed = {}, numerical = {}, owner = {frame: capturedFrame, source, runtime};
		function creatorOrdinaryIssuanceProofFacts(value: object) {return value === proof ? owner : undefined;}
		function creatorOrdinaryIssuanceSourceFacts(value: object) {return value === source ? seed : undefined;}
		${["resolveCreatorOrdinaryNumericalDimensions", "captureCreatorOrdinaryCurrentDimensionsForSizing", "creatorOrdinaryCurrentDimensionStampMatchesForSizing"]
			.map(name => declaration(name).getText(tree)).join("\n")}
		const proof = {accounting, readCurrentDimensions: ${assignments[0]!.initializer.getText(tree)}}; return proof;`, {
		capturedFrame: fixture.capturedFrame, runtime, accounting, sourceHandle: {},
		checkReadEligibility: fixture.guards.checkReadEligibility, check: fixture.guards.check,
		runCreatorOrdinaryNumericalReadForSizing: numericalRead(),
		proofMaterialOwners: new WeakMap([[accounting, {captureKnownResourceTotals: () => ({knownBytes: 7, protectedBytes: 3, unknownEncodedBytes: 3})}]]),
		maintenanceTerminalCustody: {set: (key: object, value: unknown) => {stamp.mints++; custody.set(key, value);}},
		compareBytes: fixture.bindings.compareBytes,
		Refusal: Error, failure: (code: string) => code,
	});
	return {...fixture, accounting, stamp, proof};
}

// Actual proof methods/nominal resolver and begin/release control flow. Native
// holds and accounting are controlled premises, not minted by this fixture.
function proofDataFixture() {
	const accounting = {chargedBytes: 1234}, reader = {generations: [{closure: []}],
		blobs: [{ref: {digest: "blob", byteLength: 2}, bytes: Uint8Array.of(7, 8)}], release: async () => {}};
	const frame = {alive: true, reader, accounting, pending: new Set(), headerConsumersRevoked: false};
	const state = {runtime: true, detachments: 0, ended: 0}, gate = deferred();
	const nativeIssuance = {image: {imageDigest: "a".repeat(64)}, control: {revision: 1}, rows: {issued: []}};
	const journal = {value: {canonicalRows: [Uint8Array.of(1, 2)], image: {imageDigest: "b".repeat(64)}, control: {revision: 1}}}, sourceHandle = {}, currentTrust = Object.freeze({epoch: 2});
	const initializer = nodesWithin(declaration("acquireCreatorOrdinaryIssuanceMaintenanceProof"), node =>
		ts.isVariableDeclaration(node) && node.name.getText(tree) === "proof")[0] as ts.VariableDeclaration;
	const result = execute<any>(`
		let released = false, writeStarted = false, beginTask, endTask, releaseTask, journalProbe, issuanceProbe, revokeJournalCapture, preparedCapacityOnly;
		const numerical = {}, capturedFrame = frame, capturedReader = reader, source = sourceHandle, seed = {material: {bytes: Uint8Array.of(3)},
			summary: {head: {revision: 1}}, headerScopes: [{objectId: 'room', epoch: 2, anchorDigest: 'anchor'}]};
		const owned = [], signing = {release: async () => {}}, issuer = {release: async () => {}}, journalHold = issuer;
		const runtime = {readRuntime: () => {if (!state.runtime) throw Error('runtime-revoked'); return {};},
			readReceivedAppend: () => ({exactCanonicalPreimageBytes: Uint8Array.of(9)}),
			endReadPhase: async () => {state.ended++;}, release: async () => {}};
		const check = () => gate.promise, requireLaw = (ok, code) => {if (!ok) throw Error(code);};
		const frames = new Map([[reader, frame]]), ledgers = new Map([[accounting, frame]]), maintenanceTerminalCustody = new WeakMap();
		${declaration("creatorOrdinaryIssuanceProofFacts").getText(tree)}
		${acquisitionVariable("release")}
		${acquisitionVariable("begin")}
		const detachResult = value => {state.detachments++; return decodeCanonical(encodeCanonical(value));};
		const signingRows = [Uint8Array.of(4)], snapshot = {bytes: Uint8Array.of(5)}, ahe = {value: {bytes: Uint8Array.of(6)}},
			floorImage = {state: {bytes: Uint8Array.of(7)}};
		const journalContextControlBytes = encodeJournalRetirementControl(journal.value.control);
		const proof = ${initializer.initializer!.getText(tree)};
		maintenanceTerminalCustody.set(proof, {kind: 'ordinary-proof', frame, runtime});
		return {proof, seed, frames, ledgers, begin};`, {
		accounting, reader, frame, journal, sourceHandle, currentTrust, nativeIssuance, state, gate,
		Uint8Array, decodeCanonical, encodeCanonical, closedRetirementBytes: encodeCanonical,
		encodeIssuanceRetirementControl: encodeCanonical, detachedGeneration: (value: unknown) => structuredClone(value),
		encodeJournalRetirementControl: encodeCanonical,
		Refusal: Error, failure: (code: string) => code,
		compareBytes: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]) ? 0 : 1,
		joinSourceReleases: async (tasks: (() => Promise<void>)[]) => {for (const task of tasks) await task();},
	});
	return {...result, state, gate, frame, reader, accounting, journal, nativeIssuance};
}

describe("ordinary proof explicit detached DATA", () => {
	it("does no eager sizing detachment and returns isolated original full DATA only on explicit warm reads", () => {
		const f = proofDataFixture(); expect(f.state.detachments).toBe(0);
		expect(Object.hasOwn(f.proof, "journal")).toBe(false);
		const context = f.proof.readIssuanceContext(); expect(f.state.detachments).toBe(0);
		context.expectedIssuanceControlBytes.fill(0);
		expect(f.proof.readIssuanceContext().expectedIssuanceControlBytes).toEqual(encodeCanonical(f.nativeIssuance.control));
		const journalContext = f.proof.readJournalContext();
		expect(journalContext.imageDigest).toBe(f.journal.value.image.imageDigest);
		journalContext.controlBytes.fill(0);
		expect(f.proof.readJournalContext().controlBytes).toEqual(encodeCanonical(f.journal.value.control));
		expect(f.state.detachments).toBe(0); // Tiny context never clones the full journal.
		const first = f.proof.readSizingData(), second = f.proof.readSizingData();
		expect(first.currentTrust).toBe(second.currentTrust); expect(Object.isFrozen(first)).toBe(true);
		first.journal.canonicalRows[0].fill(0); first.blobs[0].bytes.fill(0); first.signingRows[0].fill(0);
		first.sourceMaterial.bytes.fill(0); first.nativeIssuance.control.revision = 99;
		expect(second.journal.canonicalRows[0]).toEqual(Uint8Array.of(1, 2));
		expect(second.blobs[0].bytes).toEqual(Uint8Array.of(7, 8)); expect(second.signingRows[0]).toEqual(Uint8Array.of(4));
		expect(second.sourceMaterial.bytes).toEqual(Uint8Array.of(3)); expect(second.nativeIssuance.control.revision).toBe(1);
		expect(f.journal.value.canonicalRows[0]).toEqual(Uint8Array.of(1, 2));
		expect(f.accounting.chargedBytes).toBe(1234); // DATA reads cannot refund/spend the existing book.
	});
	it("rejects foreign receivers and immediately revokes both readers on either original begin invocation", async () => {
		for (const received of [false, true]) {
			const f = proofDataFixture();
			for (const name of ["readIssuanceContext", "readJournalContext", "readSizingData"])
				expect(() => f.proof[name].call({})).toThrow("snapshot-unavailable");
			const task = received ? f.proof.beginReceivedAppend(Uint8Array.of(9)) : f.proof.beginWrite();
			expect(f.frame.headerConsumersRevoked).toBe(true); expect(f.state.ended).toBe(0);
			expect(() => f.proof.readIssuanceContext()).toThrow("snapshot-unavailable");
			expect(() => f.proof.readJournalContext()).toThrow("snapshot-unavailable");
			expect(() => f.proof.readSizingData()).toThrow("snapshot-unavailable");
			f.gate.finish(); await task; await f.proof.release();
		}
	});
	it("revokes on release, reader/book displacement, or original runtime failure without exposing partial DATA", async () => {
		for (const reason of ["release", "reader", "book", "runtime"] as const) {
			const f = proofDataFixture(); let task: Promise<void> | undefined;
			if (reason === "release") task = f.proof.release();
			if (reason === "reader") f.frames.delete(f.reader);
			if (reason === "book") f.ledgers.delete(f.accounting);
			if (reason === "runtime") f.state.runtime = false;
			expect(() => f.proof.readSizingData(), reason).toThrow("snapshot-unavailable");
			expect(() => f.proof.readIssuanceContext(), reason).toThrow("snapshot-unavailable");
			expect(() => f.proof.readJournalContext(), reason).toThrow("snapshot-unavailable");
			expect(f.state.detachments).toBe(0); f.gate.finish(); await task;
		}
	});
});

describe("ordinary source immutable numerical facts", () => {
	it("keeps the original boundary author maximum and combines fresh authenticated current/native authors without reparsing PRE", () => {
		const variable = (owner: string, name: string) => {
			const found = nodesWithin(declaration(owner), node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration[];
			if (found.length !== 1) throw Error(`missing actual numerical fact:${owner}:${name}`);
			return found[0]!.initializer!.getText(tree);
		};
		const primitive = (value: string) => ({byteLength: encodeCanonical(value).byteLength, items: 1, maxDepth: 0});
		const maximum = (...values: {byteLength: number; items: number; maxDepth: number}[]) => ({
			byteLength: Math.max(...values.map(value => value.byteLength)), items: Math.max(...values.map(value => value.items)),
			maxDepth: Math.max(...values.map(value => value.maxDepth))});
		const receivedPreimages = [encodeCanonical({author: "historical-author".repeat(16)})];
		const sourceAuthor = execute<{byteLength: number; items: number; maxDepth: number}>(`return ${variable("buildCreatorOrdinaryFinishingResourceProgramForSizing", "authorMaximum")};`, {
			maximum, primitive, runtime: {issuanceScope: {author: "local"}}, rows: {issued: []}, journalAuthors: [], receivedPreimages,
			recordValue: decodeCanonical});
		for (const author of ["small-current", "wide-current".repeat(128)]) {
			const runtime = {issuanceScope: {author: "local"}}, rows = {issued: [{author: "issued".repeat(32)}]},
				frames = [{frame: ["acceptedEntries"], row: {local_author: "native".repeat(64)}}];
			const current = {currentJournalMaximumAuthorByteLength: primitive(author).byteLength};
			const resources = execute<ReturnType<typeof primitive>[]>(`return ${variable("deriveCreatorOrdinarySourceResourceProgramForSizing", "authorResources")};`, {
				primitive, runtime, rows, frames, current, basis: {authorMaximum: sourceAuthor},
				recordValue: () => {throw Error("full PRE must not be decoded again");}});
			expect(maximum(...resources)).toEqual(maximum(primitive("local"), primitive("issued".repeat(32)),
				primitive("native".repeat(64)), primitive("historical-author".repeat(16)), primitive(author)));
		}
	});
});

describe("original ordinary numerical delivery boundaries (no proof authority)", () => {
	it("starts independent held checks together, but admits no point reads until every held check joins", async () => {
		const f = guardFixture(), entered = deferred(), resume = deferred();
		f.state.onHeldCheck = async name => {if (name === "issuer") {entered.finish(); await resume.promise;}};
		const task = f.guards.checkReadEligibility(); await entered.promise;
		const beforeJoin = [...f.events]; resume.finish(); await task;
		expect(beforeJoin.filter(event => event.startsWith("held:"))).toEqual(
			["held:issuer", "held:ahe", "held:floor", "held:journal", "held:snapshot"]);
		expect(beforeJoin).not.toContain("ahe:currency");
	});

	it("joins all admitted held checks after synchronous failure and preserves original owner-order error precedence", async () => {
		const f = guardFixture(), resume = deferred(), first = new Error("first-owner"), second = new Error("later-owner");
		f.bindings.owned[0]!.check = () => {f.events.push("first:throw"); throw first;};
		f.state.onHeldCheck = async name => {if (name === "ahe") await resume.promise; if (name === "floor") throw second;};
		let settled = false;
		const task = f.guards.checkReadEligibility().then(() => {settled = true; return undefined;}, error => {settled = true; return error;});
		for (let turn = 0; turn < 16; turn++) await Promise.resolve();
		const beforeJoin = [...f.events], settledBeforeJoin = settled;
		resume.finish(); expect(await task).toBe(first);
		expect(beforeJoin).toContain("held:ahe"); expect(beforeJoin).toContain("held:snapshot");
		expect(settledBeforeJoin).toBe(false); expect(f.events).not.toContain("ahe:currency");
	});

	it("batches independent currency, facade and readiness reads only inside the held eligibility boundary", async () => {
		const f = guardFixture(), entered = deferred(), resume = deferred();
		f.state.onCurrency = async () => {entered.finish(); await resume.promise;};
		const task = f.guards.checkReadEligibility(); await entered.promise;
		const beforeJoin = [...f.events]; resume.finish(); await task;
		expect(beforeJoin).toContain("head:facade"); expect(beforeJoin).toContain("snapshot:readiness");
		expect(beforeJoin).not.toContain("floor:current");
	});

	it("does not start fresh point reads after revocation while admitted held checks are joining", async () => {
		const f = guardFixture(), entered = deferred(), resume = deferred();
		f.state.onHeldCheck = async name => {if (name === "issuer") {entered.finish(); await resume.promise;}};
		const task = f.guards.checkReadEligibility().catch(error => error); await entered.promise;
		f.guards.release(); resume.finish(); expect(await task).toBeInstanceOf(Error);
		expect(f.events).toContain("held:snapshot"); expect(f.events).not.toContain("ahe:currency");
		expect(f.events).not.toContain("head:facade"); expect(f.events).not.toContain("snapshot:readiness");
	});

	it("joins concurrent point failures and preserves original currency-before-facade-before-readiness precedence", async () => {
		const f = guardFixture(), resume = deferred(), first = new Error("currency-failure"), later = new Error("head-failure");
		f.state.onCurrency = async () => {throw first;}; f.state.onHead = async () => {throw later;};
		f.state.onReadiness = async () => {await resume.promise;};
		let settled = false;
		const task = f.guards.checkReadEligibility().then(() => {settled = true; return undefined;}, error => {settled = true; return error;});
		for (let turn = 0; turn < 32; turn++) await Promise.resolve();
		const beforeJoin = [...f.events], settledBeforeJoin = settled;
		resume.finish(); expect(await task).toBe(first);
		expect(beforeJoin).toContain("head:facade"); expect(beforeJoin).toContain("snapshot:readiness");
		expect(settledBeforeJoin).toBe(false); expect(f.events).not.toContain("floor:current");
	});

	it("rechecks abort, release, frame and source revocation after concurrent point reads join, before arithmetic", async () => {
		for (const kind of ["abort", "release", "frame", "source"] as const) {
			const f = guardFixture(), entered = deferred(), resume = deferred(); let arithmetic = 0;
			f.state.onHead = async () => {entered.finish(); await resume.promise;};
			const task = numericalRead()(f.guards, () => {arithmetic++; return 1;}).catch(error => error);
			await entered.promise;
			if (kind === "abort") f.state.aborted = true;
			else if (kind === "release") f.guards.release();
			else if (kind === "frame") f.capturedFrame.alive = false;
			else f.state.sourceCurrent = false;
			resume.finish(); expect(await task, kind).toBeInstanceOf(Error); expect(arithmetic, kind).toBe(0);
		}
	});

	it("executes every original point guard and adds snapshot image/inventory only at complete delivery", async () => {
		const fixture = guardFixture();
		const point = ["runtime:before", "signing:before", "abort", "source", "held:issuer", "held:ahe", "held:floor",
			"held:journal", "held:snapshot", "abort", "source", "ahe:currency", "head:facade", "snapshot:readiness", "abort", "source", "floor:current",
			"journal:current", "issuer:current", "abort", "signing:after", "runtime:after"];
		await fixture.guards.checkReadEligibility(); expect(fixture.events).toEqual(point);
		fixture.events.length = 0; await fixture.guards.check();
		const afterPoints = point.indexOf("floor:current");
		expect(fixture.events).toEqual([...point.slice(0, afterPoints), "snapshot:image", "snapshot:inventory", ...point.slice(afterPoints)]);
	});

	it("refuses changed complete snapshot images or whole inventory before delivering arithmetic", async () => {
		for (const kind of ["image", "inventory"] as const) {
			const fixture = guardFixture(); let arithmetic = 0, delivered = false;
			const task = numericalRead()(fixture.guards, () => {
				arithmetic++; if (kind === "image") fixture.state.snapshot = {version: 2};
				else fixture.state.inventory = {scopes: [{scope: "changed"}], owner: {incarnation: "original"}};
				return 128;
			}).then(value => {delivered = true; return value;});
			await expect(task).rejects.toThrow("snapshot-not-ready");
			expect(arithmetic).toBe(1); expect(delivered).toBe(false);
			expect(fixture.events).toContain("snapshot:image");
			if (kind === "inventory") expect(fixture.events).toContain("snapshot:inventory");
		}
	});

	it("runs no arithmetic after abort, revocation, source displacement, facade closure or held-child failure", async () => {
		for (const failure of ["abort", "release", "frame", "read-phase", "runtime", "source", "facade", "readiness",
			"issuer", "ahe", "floor", "journal", "snapshot"] as const) {
			const fixture = guardFixture(); let arithmetic = 0;
			switch (failure) {
				case "abort": fixture.state.aborted = true; break;
				case "release": fixture.guards.release(); break;
				case "frame": fixture.capturedFrame.alive = false; break;
				case "read-phase": fixture.state.readPhaseRevoked = true; break;
				case "runtime": fixture.state.runtimeClosed = true; break;
				case "source": fixture.state.sourceCurrent = false; break;
				case "facade": fixture.state.facadeClosed = true; break;
				case "readiness": fixture.state.ready = false; break;
				default: fixture.state.childFailure = failure;
			}
			await expect(numericalRead()(fixture.guards, () => {arithmetic++; return undefined;})).rejects.toThrow();
			expect(arithmetic, failure).toBe(0);
		}
	});

	it("keeps issuer full-image fallback and its exact mismatch fatal", async () => {
		const fixture = guardFixture(); fixture.state.issuerCurrent = false;
		await expect(numericalRead()(fixture.guards, () => undefined)).rejects.toThrow("chain-invalid");
		expect(fixture.events).toContain("issuer:current"); expect(fixture.events).toContain("issuer:full");
	});

	it("does not mint a dimension stamp after changed runtime correspondence or same-book advance", async () => {
		const healthy = dimensionFixture();
		expect(await healthy.proof.readCurrentDimensions(Uint8Array.of(1, 2))).toEqual({});
		expect(healthy.stamp.mints).toBe(1); expect(healthy.capturedFrame.pending.size).toBe(0);
		for (const changed of ["dimensions", "ledger"] as const) {
			const fixture = dimensionFixture();
			fixture.state.onImage = () => {if (changed === "dimensions") fixture.stamp.current = false; else fixture.accounting.chargedBytes++;};
			await expect(fixture.proof.readCurrentDimensions(Uint8Array.of(1, 2))).rejects.toThrow("snapshot-unavailable");
			expect(fixture.stamp.mints, changed).toBe(0); expect(fixture.events).toContain("math:dimensions");
			expect(fixture.capturedFrame.pending.size).toBe(0);
		}
	});

	it("cannot install the numerical template after failed complete currency or a stale delivery stamp", async () => {
		const scalar = declaration("evaluateCreatorOrdinaryFinishingCapacityScalar");
		const statements = scalar.body!.statements;
		const start = statements.findIndex(node => node.getText(tree).startsWith("if (derived === undefined || creatorOrdinaryIssuanceDimensionFacts"));
		const finish = statements.findIndex((node, index) => index > start && ts.isReturnStatement(node));
		if (start < 0 || finish < 0) throw new Error("missing original scalar template delivery tail");
		const tail = statements.slice(start, finish + 1).map(node => node.getText(tree)).join("\n");
		for (const changed of ["healthy", "currency", "stamp"] as const) {
			const fixture = guardFixture(); let installed = 0;
			if (changed === "currency") fixture.state.onImage = () => {fixture.state.snapshot = {version: 2};};
			const task = execute<Promise<unknown>>(`return (async () => {
				const derived = await run(owner, () => ({capacity: {bounded: true}, commit: install}));
				${tail}
			})();`, {owner: fixture.guards, run: numericalRead(), install: () => {installed++;},
				creatorOrdinaryIssuanceDimensionFacts: () => changed === "stamp" ? undefined : {}, readout: {}, proof: {}, unsignedBytes: Uint8Array.of(1)});
			if (changed === "currency") await expect(task).rejects.toThrow("snapshot-not-ready");
			else if (changed === "stamp") expect(await task).toBeUndefined();
			else expect(await task).toEqual({bounded: true});
			expect(installed, changed).toBe(changed === "healthy" ? 1 : 0);
		}
	});

	it("clears a genuinely advanced application cell when the original final delivery or stamp fails", async () => {
		for (const failed of ["healthy", "currency", "stamp"] as const) {
			const current = {blueprint: {maxApplicationStateBytes: 128, maxItems: 128, maxDepth: 8},
				candidate: {exactCanonicalOperationBytes: encodeCanonical({action: "place"})}};
			const capacity: {application: unknown} = {application: undefined};
			const facts = {current, sourceFacts: {capacity}, frame: {pending: new Set<Promise<unknown>>()}, proofFacts: {runtime: {
				captureApplicationResourceCursor: () => ({}), readApplicationResourceDelta: () => [encodeCanonical({operation: {action: "place"}})],
			}}};
			let advances = 0, checks = 0, resolves = 0, enrollments = 0;
			const error = new Error("original-native-currency-failure");
			const reader = Object.assign(() => {throw new Error("unexpected full callback");}, {createIncrementalProjection: () => undefined});
			const projection = {advance: () => {advances++; return true;}, quote: () => ({byteLength: 16, items: 4, maxDepth: 1})};
			capacity.application = {reader, create: reader.createIncrementalProjection, projection, cursor: {}, baseResources: []};
			const proof = {check: async () => {checks++; if (checks === 2 && failed === "currency") throw error;}};
			const run = execute<(readout: object, owner: {check(): Promise<void>}, bytes: Uint8Array, boundReader: () => unknown) => Promise<unknown>>(`
				${declaration("deriveCreatorOrdinaryApplicationResourceForSizing").getText(tree)}
				${declaration("readCreatorOrdinaryApplicationResourceBound").getText(tree).replace(/^export /, "")}
				return readCreatorOrdinaryApplicationResourceBound;`, {
				creatorOrdinaryIssuanceDimensionFacts: () => {resolves++; return resolves === 3 && failed === "stamp" ? undefined : facts;},
				record: decodeCanonical, decodeCanonical, closedRetirementBytes: encodeCanonical,
				creatorOrdinaryApplicationResourceInput: () => {throw new Error("unexpected full material input");},
				maintenanceTerminalCustody: {get: () => ({kind: "ordinary-dimensions"}), set: () => {enrollments++;}},
			});
			const task = run({}, proof, Uint8Array.of(1), reader);
			if (failed === "currency") await expect(task).rejects.toBe(error);
			else if (failed === "stamp") expect(await task).toBeUndefined();
			else expect(await task).toEqual({byteLength: 16, items: 4, maxDepth: 1});
			expect(advances).toBe(1); expect(checks).toBe(2);
			if (failed === "healthy") expect(capacity.application).toBeDefined(); else expect(capacity.application).toBeUndefined();
			expect(enrollments).toBe(failed === "healthy" ? 1 : 0); expect(facts.frame.pending.size).toBe(0);
		}
	});

	it("owes a new point eligibility and complete delivery for each arithmetic invocation", async () => {
		const order: string[] = [], run = numericalRead();
		const owner = {checkReadEligibility: async () => {order.push("point");}, check: async () => {order.push("complete");}};
		expect(await run(owner, () => {order.push("math"); return 128;})).toBe(128);
		expect(await run(owner, () => {order.push("math"); return 8334;})).toBe(8334);
		expect(order).toEqual(["point", "math", "complete", "point", "math", "complete"]);
	});

	it("cannot deliver a soft numerical miss before complete currency joins", async () => {
		const checking = deferred(), join = deferred(); let delivered = false;
		const task = numericalRead()({checkReadEligibility: async () => {}, check: async () => {checking.finish(); await join.promise;}},
			() => undefined).then(value => {delivered = true; return value;});
		await checking.promise;
		expect(delivered).toBe(false);
		join.finish(); expect(await task).toBeUndefined(); expect(delivered).toBe(true);
	});

	it("checks complete currency even when arithmetic throws, preserving a healthy-current numerical error", async () => {
		const error = new TypeError("numerical-layout"); let complete = 0;
		await expect(numericalRead()({checkReadEligibility: async () => {}, check: async () => {complete++;}},
			() => {throw error;})).rejects.toBe(error);
		expect(complete).toBe(1);
	});

	it("native eligibility and delivery failures are fatal, never successful undefined", async () => {
		const failure = new Error("original-native-failure"); let arithmetic = 0;
		await expect(numericalRead()({checkReadEligibility: async () => {throw failure;}, check: async () => {}},
			() => {arithmetic++; return undefined;})).rejects.toBe(failure);
		expect(arithmetic).toBe(0);
		await expect(numericalRead()({checkReadEligibility: async () => {}, check: async () => {throw failure;}},
			() => undefined)).rejects.toBe(failure);
		await expect(numericalRead()({checkReadEligibility: async () => {}, check: async () => {throw failure;}},
			() => {throw new TypeError("numerical-layout");})).rejects.toBe(failure);
	});

	it("does not catch asynchronous native failures as compiler or cached-program misses", () => {
		for (const name of ["evaluateCreatorOrdinaryFinishingCapacity", "evaluateCreatorOrdinarySourceResourceProgram",
			"evaluateCreatorOrdinaryFinishingCapacityScalar", "deriveCreatorOrdinarySourceResourceProgramForSizing",
			"deriveCreatorOrdinaryFinishingCapacityScalarForSizing", "deriveCreatorOrdinaryFinishingCapacityForSizing"]) {
			const tries = nodesWithin(declaration(name), ts.isTryStatement) as ts.TryStatement[];
			for (const statement of tries) expect(nodesWithin(statement.tryBlock, ts.isAwaitExpression), name).toHaveLength(0);
		}
	});

	it("invalidates an advanced numerical projection when original callback delivery currency fails", async () => {
		const app = declaration("readCreatorOrdinaryApplicationResourceBound");
		const statement = nodesWithin(app, node => ts.isTryStatement(node) &&
			node.tryBlock.getText(tree).includes("await proof.check()") &&
			node.catchClause?.getText(tree).includes("initial.sourceFacts.capacity.application = undefined") === true)[0];
		if (statement === undefined) throw new Error("missing original callback-delivery invalidation");
		const js = ts.transpileModule(`async function delivery(proof: any, facts: any) {const initial = facts; ${statement.getText(tree)}}`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
		const delivery = new Function(`${js}\nreturn delivery;`)() as
			(proof: {check(): Promise<void>}, facts: {sourceFacts: {capacity: {application: object | undefined}}}) => Promise<void>;
		const failure = new Error("original-currency-failure"), facts = {sourceFacts: {capacity: {application: {advanced: true} as object | undefined}}};
		await expect(delivery({check: async () => {throw failure;}}, facts)).rejects.toBe(failure);
		expect(facts.sourceFacts.capacity.application).toBeUndefined();
	});
});

describe("adjacent ordinary check coalescing (no task, await or own effect in between)", () => {
	const issue = (target: AdjacentTarget): AdjacentClaim => execute<(target: AdjacentTarget) => AdjacentClaim>(
		`${declaration("issueCreatorOrdinaryAdjacentCheck").getText(tree)}\nreturn issueCreatorOrdinaryAdjacentCheck;`, {})(target);
	const wrapped = ["runtime:before", "signing:before", "abort", "source", "signing:after", "runtime:after"];

	it("repeats only the wrapped synchronous eligibility prefix at its one claimed boundary", async () => {
		for (const target of ["pre-callback", "begin"] as const) {
			const f = guardFixture(); f.capturedFrame.adjacentCheck = issue(target);
			for (let turn = 0; turn < 24; turn++) await Promise.resolve(); // Microtask-only path, as in production.
			await f.guards.check(target);
			expect(f.events, target).toEqual(wrapped); expect(f.capturedFrame.adjacentCheck, target).toBeUndefined();
			f.events.length = 0; await f.guards.check(target); // Single use: the next check is complete.
			expect(f.events, target).toContain("held:issuer"); expect(f.events, target).toContain("snapshot:inventory");
		}
	});

	it("stays complete for another boundary, an untargeted check, or once any task has run", async () => {
		for (const kind of ["other", "untargeted", "task"] as const) {
			const f = guardFixture(); f.capturedFrame.adjacentCheck = issue("begin");
			if (kind === "task") await new Promise(resolve => setTimeout(resolve, 0));
			await f.guards.check(kind === "other" ? "pre-callback" : kind === "untargeted" ? undefined : "begin");
			for (const event of ["held:snapshot", "ahe:currency", "head:facade", "snapshot:readiness", "snapshot:image",
				"snapshot:inventory", "floor:current", "journal:current", "issuer:current"]) expect(f.events, kind).toContain(event);
			expect(f.capturedFrame.adjacentCheck, kind).toBeUndefined();
		}
	});

	it("keeps the original wrapper and synchronous refusals, reasons and order when coalesced", async () => {
		const expected = {runtime: "runtime-closed", "read-phase": "read-phase-revoked", abort: "aborted",
			release: "chain-invalid", frame: "chain-invalid", source: "chain-invalid"} as const;
		for (const failure of Object.keys(expected) as (keyof typeof expected)[]) {
			const f = guardFixture(); f.capturedFrame.adjacentCheck = issue("pre-callback");
			if (failure === "runtime") f.state.runtimeClosed = true;
			else if (failure === "read-phase") f.state.readPhaseRevoked = true;
			else if (failure === "abort") f.state.aborted = true;
			else if (failure === "release") f.guards.release();
			else if (failure === "frame") f.capturedFrame.alive = false;
			else f.state.sourceCurrent = false;
			await expect(f.guards.check("pre-callback"), failure).rejects.toThrow(expected[failure]);
			expect(f.events, failure).not.toContain("held:issuer");
		}
	});
});

