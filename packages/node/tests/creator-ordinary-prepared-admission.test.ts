import {readFileSync} from "node:fs";
import {encodeCanonical} from "@ts-drp/canonical";
import {copyCanonicalForAdmittedView} from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Controlled extraction of ORIGINAL private numerical owners. No signature,
// source proof, native exclusion or portable admission capability is minted.
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
	const node = tree.statements.find((item): item is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(item) && item.name?.text === name);
	if (node === undefined) throw Error("missing original prepared owner: " + name);
	return node;
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const code = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", "const {" + Object.keys(bindings).join(",") + "} = bindings;\n" + code)(bindings) as T;
}
type Owner = (...args: unknown[]) => unknown;
function fixture(operation: unknown = Object.freeze({action: "app", bytes: Uint8Array.of(7)}), sourcePositive = false) {
	const state = {encodes: 0, key: Uint8Array.of(1), identity: {}, live: true, replay: 0,
		beforeEncode: undefined as ((value: unknown) => void) | undefined,
		afterEncode: undefined as ((value: unknown) => void) | undefined};
	const scope = Object.freeze({objectId: "room", epoch: 3, anchorDigest: "anchor"});
	const anchor = Object.freeze({kind: "drp-epoch-anchor", hash: "anchor", objectId: "room", epoch: 3});
	const vertex = Object.freeze({kind: "drp-vertex", hash: "one", objectId: "room", epoch: 3,
		anchor: "anchor", dependencies: Object.freeze(["anchor"]), operation});
	const identity = Object.freeze({author: "alice", authorSequence: 0, ...(sourcePositive ? {sourceAuthorized: true} : {})});
	const registration = {index: {}, payload: {}, authorization: {},
		closeVertices: new Map<string, unknown>([["anchor", anchor], ["one", vertex]]),
		closeAuthors: new Map<string, unknown>([["one", identity]]),
		closeCharges: new Map([["anchor", 9], ["one", 4]]), controlVertices: new Set<string>(), graphVersion: 1};
	const replay = Object.freeze({journalSequence: 0, sourceKind: "local-issued", digest: "one", byteCharge: 4,
		exactCanonicalPreimageBytes: Uint8Array.of(3, 3, 3, 3), detachedSignature: Uint8Array.of(4),
		exactCanonicalVertexBytes: encodeCanonical(vertex)});
	const issued = {objectId: "room", author: "alice", authorSequence: 0,
		canonicalPreimageBytes: replay.exactCanonicalPreimageBytes.slice(), digest: Uint8Array.of(1),
		signature: replay.detachedSignature.slice()};
	const native = {lineages: [{objectId: "room", author: "alice", next: 1, exhausted: false,
		prunedThroughAuthorSequence: null}], issued: [issued], outbox: [], plans: []};
	const rows = [{scope, journalSequence: 0, sourceKind: "local-issued", vertexDigest: "one",
		author: "alice", authorSequence: 0}];
	const application = Object.freeze({currentSignedPreimagesHaveSettlementSource: sourcePositive,
		currentJournalMaximumAuthorByteLength: 6, effects: Object.freeze([]), completedNative: Object.freeze([])});
	const geometry = new WeakMap<object, unknown>();
	const typed = Object.getPrototypeOf(Uint8Array.prototype);
	const names = ["captureCreatorOrdinaryDimensionIntegrity", "captureCreatorOrdinaryPreparedVertex",
		"creatorOrdinaryPreparedVertexCurrent", "captureCreatorOrdinaryPreparedAdmission",
		"creatorOrdinaryPreparedGraphCurrent", "creatorOrdinaryPreparedIssuedEqual",
		"creatorOrdinaryPreparedNativeCurrent", "advanceCreatorOrdinaryPreparedAdmission",
		"advanceCreatorOrdinaryRuntimeCapacityGeometry"];
	const functions = execute<Record<string, Owner>>(names.map(name => declaration(name).getText(tree)).join("\n") +
		"\nreturn {" + names.join(",") + "};", {
		encodeCanonical: (value: unknown) => {state.encodes++; state.beforeEncode?.(value);
			const bytes = encodeCanonical(value); state.afterEncode?.(value); return bytes;},
		Uint8ArrayConstructor: Uint8Array, TypedArrayPrototype: typed,
		TypedArrayByteLengthGetter: Object.getOwnPropertyDescriptor(typed, "byteLength")!.get,
		TypedArrayBufferGetter: Object.getOwnPropertyDescriptor(typed, "buffer")!.get,
		ObjectFreeze: Object.freeze, ObjectIsFrozen: Object.isFrozen, ObjectPrototype: Object.prototype,
		ObjectDefineProperty: Object.defineProperty,
		ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
		ReflectOwnKeys: Reflect.ownKeys, ReflectApply: Reflect.apply, ArrayIsArray: Array.isArray,
		sameBytes: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]),
		copyCanonicalForAdmittedView,
		resolveV3AuthorizedAuthor: () => ({format: "raw", bytes: state.key}),
		liveJournalScope: () => scope, sameLiveJournalScope: (a: unknown, b: unknown) =>
			JSON.stringify(a) === JSON.stringify(b),
		lowerHexDigest: (bytes: Uint8Array) => bytes[0] === 1 ? "one" : bytes[0] === 2 ? "two" : undefined,
		ordinaryRuntimeCapacityGeometry: geometry,
		creatorOrdinaryIssuanceSourceIdentity: () => state.identity,
		vertexRegistry: {domain: "vertex"}, V3_VERTEX_DOMAIN: "vertex",
		isDigestHex: (value: unknown) => typeof value === "string" && value.length === 64,
	});
	const prepared = functions.captureCreatorOrdinaryPreparedAdmission(registration, [replay], native, application);
	expect(prepared).toBeDefined();
	geometry.set(registration, Object.freeze({sourceIdentity: state.identity, graphVersion: 1,
		rowCount: 1, widths: {advance: () => ({})}, prepared}));
	return {state, scope, registration, vertex, identity, replay, issued, native, rows, application, functions, geometry, prepared};
}
describe("existing ordinary prepared-capacity DATA owner", () => {
	it("drops the revoked plane's numerical selection without releasing admitted native custody", () => {
		let releasedParsingFacts = 0;
		const registration = {active: true, settlementSelectionControllers: [], releaseTerminalBarrier: undefined,
			vertexFacts: {release() {releasedParsingFacts++;}},
			terminalBarrier: undefined, pendingIngress: new Map(), pendingIngressBytes: 0,
			topic: "room", queueId: "queue", networkNode: {unsubscribe() {}}, messageQueueManager: {close() {}}};
		const heldCapture = {bytes: Uint8Array.of(1), nativeReleased: false};
		const geometry = new WeakMap<object, unknown>([[registration, heldCapture]]);
		const registrations = new Map([[registration.topic, registration]]);
		const deactivate = execute<(value: typeof registration) => boolean>(
			declaration("deactivateRegistration").getText(tree) + "\nreturn deactivateRegistration;", {
				ordinaryRuntimeCapacityGeometry: geometry,
				v3PlaneRegistrations: new WeakMap([[registration.networkNode, registrations]]),
				topicMembership: () => false, hasQueueGuarded: () => false,
			});
		expect(deactivate(registration)).toBe(true); expect(registration.active).toBe(false);
		expect(releasedParsingFacts).toBe(1);
		expect(geometry.has(registration)).toBe(false); expect(registrations.size).toBe(0);
		// An already-entered closure still owns its DATA/native joins separately.
		expect(heldCapture.bytes).toEqual(Uint8Array.of(1)); expect(heldCapture.nativeReleased).toBe(false);
	});
	it("uses exact fresh physical rows and retains complete source-positive boundary history", () => {
		for (const sourcePositive of [false, true]) {
			const f = fixture(undefined, sourcePositive);
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(true);
		}
	});
	it("does not re-encode a frozen primitive/byte graph on repeated correspondence checks", () => {
		const f = fixture(), before = f.state.encodes;
		for (let i = 0; i < 8; i++)
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(true);
		expect(f.state.encodes).toBe(before);
	});
	it("detects retained operation byte mutation without graphVersion or object changes", () => {
		const bytes = Uint8Array.of(7), f = fixture(Object.freeze({action: "app", bytes}));
		bytes[0] = 8;
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(false);
		bytes[0] = 7;
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(true);
	});
	it("retains exact canonical fallback for mutable Map and Set leaves", () => {
		for (const nested of [new Map([["key", 1]]), new Set([1])]) {
			const f = fixture(Object.freeze({action: "app", nested})), before = f.state.encodes;
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(true);
			expect(f.state.encodes).toBeGreaterThan(before);
			if (nested instanceof Map) nested.set("key", 2); else nested.add(2);
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native)).toBe(false);
		}
	});
	it("rejects changed author key, graph/index owner, control membership or retained charge", () => {
		for (const change of ["key", "index", "control", "charge", "identity", "vertex"] as const) {
			const f = fixture();
			if (change === "key") f.state.key = Uint8Array.of(2);
			if (change === "index") f.registration.index = {};
			if (change === "control") f.registration.controlVertices.add("one");
			if (change === "charge") f.registration.closeCharges.set("one", 5);
			if (change === "identity") f.registration.closeAuthors.set("one", {...f.identity});
			if (change === "vertex") f.registration.closeVertices.set("one", {...f.vertex});
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native), change).toBe(false);
		}
	});
	it("rejects same-count native corruption and local/received provenance changes", () => {
		for (const change of ["preimage", "signature", "digest", "provenance", "ordinal", "scope"] as const) {
			const f = fixture();
			if (change === "preimage") f.issued.canonicalPreimageBytes[0] = 8;
			if (change === "signature") f.issued.signature[0] = 8;
			if (change === "digest") f.issued.digest[0] = 8;
			if (change === "provenance") Reflect.set(f.rows[0]!, "sourceKind", "received");
			if (change === "ordinal") f.rows[0]!.journalSequence = 1;
			if (change === "scope") Reflect.set(f.rows[0]!, "scope", {...f.scope, epoch: 4});
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native), change).toBe(false);
		}
	});
	it("rejects foreign/headless debt, pending native intent and native-only progress", () => {
		for (const change of ["foreign", "pending", "issued", "lineage"] as const) {
			const f = fixture();
			if (change === "foreign") f.native.lineages.push({...f.native.lineages[0]!, author: "foreign"});
			if (change === "pending") Reflect.set(f.native.lineages[0]!, "pendingUnsigned", {});
			if (change === "issued") f.native.issued.push({...f.issued, authorSequence: 1});
			if (change === "lineage") f.native.lineages[0]!.next++;
			expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, f.prepared, f.rows, f.native), change).toBe(false);
		}
	});
	it("rejects same-count duplicate replacement of a non-current native identity", () => {
		const f = fixture();
		f.native.issued.push({...f.issued, author: "foreign", authorSequence: 0},
			{...f.issued, author: "foreign", authorSequence: 1});
		f.native.lineages.push({...f.native.lineages[0]!, author: "foreign", next: 2});
		const prepared = f.functions.captureCreatorOrdinaryPreparedAdmission(f.registration, [f.replay], f.native, f.application);
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, prepared, f.rows, f.native)).toBe(true);
		f.native.issued[2] = {...f.native.issued[1]!};
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, prepared, f.rows, f.native)).toBe(false);
		const g = fixture();
		g.native.lineages.push({...g.native.lineages[0]!, author: "foreign"});
		const baseline = g.functions.captureCreatorOrdinaryPreparedAdmission(g.registration, [g.replay], g.native, g.application);
		g.native.lineages[1] = {...g.native.lineages[0]!};
		expect(g.functions.creatorOrdinaryPreparedNativeCurrent(g.registration, baseline, g.rows, g.native)).toBe(false);
	});
	it("does not advance the existing geometry without native postimage and graph acceptance", () => {
		for (const change of ["native", "graph", "source"] as const) {
			const f = fixture();
			if (change !== "graph") f.registration.graphVersion++;
			if (change === "source") f.state.identity = {};
			f.functions.advanceCreatorOrdinaryRuntimeCapacityGeometry(f.registration, {}, change === "native" ? undefined :
				{imageDigest: "a".repeat(64), controlBytes: null});
			expect(f.geometry.has(f.registration), change).toBe(false);
		}
	});
	it("advances only the exact new accepted tuple, preserving prior bytes and lineage", () => {
		const f = fixture();
		const vertex = Object.freeze({...f.vertex, hash: "two", dependencies: Object.freeze(["one"]),
			operation: Object.freeze({action: "app", bytes: Uint8Array.of(9)})});
		f.registration.closeVertices.set("two", vertex);
		f.registration.closeAuthors.set("two", Object.freeze({author: "alice", authorSequence: 1}));
		f.registration.closeCharges.set("two", 5);
		const replay = {journalSequence: 1, sourceKind: "local-issued", digest: "two", byteCharge: 5,
			exactCanonicalPreimageBytes: Uint8Array.of(5, 5, 5, 5, 5), detachedSignature: Uint8Array.of(6),
			exactCanonicalVertexBytes: encodeCanonical(vertex)};
		const issued = {...f.issued, authorSequence: 1, digest: Uint8Array.of(2),
			canonicalPreimageBytes: replay.exactCanonicalPreimageBytes.slice(), signature: replay.detachedSignature.slice()};
		const next = f.functions.advanceCreatorOrdinaryPreparedAdmission(f.registration, f.prepared, replay, issued);
		const native = {...f.native, issued: [...f.native.issued, issued], lineages: [{...f.native.lineages[0]!, next: 2}]};
		const rows = [...f.rows, {...f.rows[0]!, journalSequence: 1, vertexDigest: "two", authorSequence: 1}];
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, next, rows, native)).toBe(true);
		issued.signature[0] = 9;
		expect(f.functions.creatorOrdinaryPreparedNativeCurrent(f.registration, next, rows, native)).toBe(false);
	});
	it("runs the actual prepared branch with same-book PRE charges and no full replay, retaining full API", async () => {
		const f = fixture(undefined, true), lifetime = {};
		const resolver = declaration("resolveOrdinaryIssuanceRuntimeHold");
		let property: ts.PropertyAssignment | undefined;
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "checkCurrentJournal") property = node;
			ts.forEachChild(node, visit);
		};
		visit(resolver);
		if (property === undefined) throw Error("missing actual prepared acquisition branch");
		const rollback = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
		const rollbackTree = ts.createSourceFile("rollback.ts", rollback, ts.ScriptTarget.Latest, true);
		const factory = rollbackTree.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorClosedRollbackProofAccounting");
		if (factory === undefined) throw Error("missing original accounting owner");
		const createAccounting = execute<() => {readonly chargedBytes: number; chargeUnknownEncodedLength(length: number): boolean}>(
			factory.getText(rollbackTree).replace(/^export /, "") + "\nreturn () => createCreatorClosedRollbackProofAccounting([]);", {
				CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4_194_304,
				proofMaterialOwners: new WeakMap(),
				compareBytes: (a: Uint8Array, c: Uint8Array) => a.length === c.length && a.every((byte, i) => byte === c[i]) ? 0 : 1,
			});
		const accounting = createAccounting(), failure = Error("full reader deliberately observed");
		const run = execute<(prepared?: true) => Promise<boolean>>(
			"let preparedCapacityCapture, currentJournalCapture, currentJournalImageDigest, sourceLinkedApplicationCapture;\n" +
			"const handler = ({" + property.getText(tree) + "}).checkCurrentJournal;\n" +
			"return prepared => Reflect.apply(handler, lifetime, [accounting, nativeRows, prepared]);", {
				lifetime, accounting, nativeRows: f.rows, registration: f.registration,
				nativeIssuanceCapture: {rows: f.native, image: {imageDigest: "b".repeat(64)}},
				admit: (task: () => Promise<boolean>) => task(),
				readCreatorOrdinaryCapturedJournalReplay: () => ({rows: f.rows, nativeImageDigest: "b".repeat(64),
					journalImageDigest: "a".repeat(64), preparedGeometryMatches: true}),
				ordinaryRuntimeCapacityGeometry: f.geometry,
				creatorOrdinaryIssuanceSourceIdentity: () => f.state.identity,
				creatorOrdinaryPreparedNativeCurrent: f.functions.creatorOrdinaryPreparedNativeCurrent,
				lowerHexDigest: (bytes: Uint8Array) => bytes[0] === 1 ? "one" : undefined,
				readCreatorReplayRows: async () => {f.state.replay++; throw failure;},
			});
		expect(await run(true)).toBe(true); expect(f.state.replay).toBe(0);
		const paid = accounting.chargedBytes; expect(paid).toBeGreaterThan(4);
		expect(accounting.chargeUnknownEncodedLength(11)).toBe(true);
		expect(await run(true)).toBe(true); expect(accounting.chargedBytes).toBe(paid + 11);
		expect(accounting.chargeUnknownEncodedLength(11)).toBe(true);
		expect(accounting.chargedBytes).toBe(paid + 22); expect(f.state.replay).toBe(0);
		await expect(run()).rejects.toBe(failure); expect(f.state.replay).toBe(1);
	});
	it("keeps native image, source-purpose, accounting and full-view seams explicit", () => {
		const rollback = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
		expect(rollback).toContain("!closedRetirementEqual(nativeRows.plans, oldNativeRows.plans)");
		expect(rollback).toContain("use.nativeReaderRefs");
		expect(rollback).toContain("use.snapshotScopes");
		expect(rollback).toContain("if (preparedCapacityOnly && preparedJournal === undefined) throw unavailable");
		expect(rollback).toContain("if (\"preparedCapacityOnly\" in facts.current) return undefined");
		expect(rollback).toContain("derived.capacity.unknownEncodedLengths");
		expect(source).toContain("if (preparedCapacityOnly) {");
		expect(source).toContain("prepared.issuedCarriers[index]");
	});
});

describe("same ordinary integrity owner with mutable plain DATA", () => {
	function guard(value: unknown, initialEncodes = 2) {
		const f = fixture(), before = f.state.encodes;
		const intact = f.functions.captureCreatorOrdinaryDimensionIntegrity(value) as () => boolean;
		expect(f.state.encodes).toBe(before + initialEncodes);
		return {intact, state: f.state, capturedEncodes: f.state.encodes};
	}
	it("captures mutable records and arrays once and never re-encodes unchanged data", () => {
		const nested = {count: 1}, value = {action: "batch", entries: [{operation: nested}, {bytes: Uint8Array.of(1, 2)}]};
		const f = guard(value);
		for (let index = 0; index < 8; index++) expect(f.intact()).toBe(true);
		expect(f.state.encodes).toBe(f.capturedEncodes);
		nested.count = 2; expect(f.intact()).toBe(false);
		const changed = f.state.encodes;
		nested.count = 1; expect(f.intact()).toBe(true);
		expect(f.state.encodes).toBe(changed); // Restoration uses ORIGINAL facts; no advance.
	});
	it("detects added/deleted own keys and descriptor changes without retaining a new baseline", () => {
		const value: Record<string, unknown> = {first: 1, second: 2}, f = guard(value);
		value.extra = 3; expect(f.intact()).toBe(false);
		delete value.extra; expect(f.intact()).toBe(true);
		delete value.first; expect(f.intact()).toBe(false);
		value.first = 1; expect(f.intact()).toBe(true); // Original codec sorts record keys.
		Object.defineProperty(value, "second", {enumerable: false}); expect(f.intact()).toBe(false);
		Object.defineProperty(value, "second", {enumerable: true}); expect(f.intact()).toBe(true);
		let reads = 0;
		Object.defineProperty(value, "first", {configurable: true, enumerable: true, get() {reads++; return 1;}});
		expect(f.intact()).toBe(false); expect(reads).toBe(0);
		Object.defineProperty(value, "first", {configurable: true, enumerable: true, writable: true, value: 1});
		expect(f.intact()).toBe(true);
	});
	it("detects array reorder, length changes and holes, then permits exact restoration", () => {
		const first = {value: 1}, second = {value: 2}, entries = [first, second], f = guard({entries});
		entries.reverse(); expect(f.intact()).toBe(false);
		entries.reverse(); expect(f.intact()).toBe(true);
		entries.push({value: 3}); expect(f.intact()).toBe(false);
		entries.pop(); expect(f.intact()).toBe(true);
		Reflect.deleteProperty(entries, "0"); expect(f.intact()).toBe(false);
		entries[0] = first; expect(f.intact()).toBe(true);
	});
	it("detects prototype displacement while retaining ORIGINAL canonical equality for allowed plain prototypes", () => {
		const value = {nested: {count: 1}}, f = guard(value), before = f.state.encodes;
		Object.setPrototypeOf(value.nested, null);
		expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(before + 1);
		Object.setPrototypeOf(value.nested, Object.create(Object.prototype));
		expect(f.intact()).toBe(false);
		Object.setPrototypeOf(value.nested, Object.prototype);
		const restored = f.state.encodes; expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(restored);
	});
	it("falls back after inherited array classification changes and permits restoration", () => {
		const value = {entries: [1, 2]}, f = guard(value);
		const parent = Object.getPrototypeOf(Array.prototype);
		let observed: boolean | undefined;
		try {
			Object.setPrototypeOf(Array.prototype, Uint8Array.prototype);
			observed = f.intact();
		} finally { Object.setPrototypeOf(Array.prototype, parent); }
		expect(observed).toBe(false); expect(f.state.encodes).toBe(f.capturedEncodes + 1);
		expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(f.capturedEncodes + 1);
	});
	it("checks byte leaves under mutable parents without repeated encoding, including detached empty bytes", () => {
		const bytes = Uint8Array.of(1, 2), f = guard({nested: [{bytes}]});
		bytes[0] = 9; expect(f.intact()).toBe(false); expect(f.state.encodes).toBe(f.capturedEncodes);
		bytes[0] = 1; expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(f.capturedEncodes);
		for (const length of [0, 2]) {
			const detached = new Uint8Array(length), g = guard({nested: [detached]});
			structuredClone(detached.buffer, {transfer: [detached.buffer]});
			expect(g.intact()).toBe(false);
		}
	});
	it("retains original byte metadata fallback and canonical normalization", () => {
		const bytes = Uint8Array.of(1, 2), nested = {zero: -0}, f = guard({nested, bytes});
		nested.zero = 0; expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(f.capturedEncodes);
		Object.defineProperty(bytes, "byteLength", {value: 1, configurable: true});
		expect(f.intact()).toBe(false); expect(f.state.encodes).toBe(f.capturedEncodes + 1);
		Reflect.deleteProperty(bytes, "byteLength"); expect(f.intact()).toBe(true);
	});
	it("keeps exact canonical fallback for Map/Set/non-byte typed arrays and array accessors", () => {
		for (const nested of [new Map([["key", 1]]), new Set([1]), new Float32Array([1])]) {
			const f = guard({nested}, 1);
			expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(f.capturedEncodes + 1);
			if (nested instanceof Map) nested.set("key", 2);
			else if (nested instanceof Set) nested.add(2);
			else nested[0] = 2;
			expect(f.intact()).toBe(false); expect(f.state.encodes).toBe(f.capturedEncodes + 2);
		}
		const array = [1]; let reads = 0;
		Object.defineProperty(array, "0", {configurable: true, get() {reads++; return 1;}});
		const f = guard({array}, 1), before = reads;
		expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(f.capturedEncodes + 1); expect(reads).toBe(before + 1);
	});
	it("binds descriptor snapshots to the actual encoded baseline, not a later trap-mutated state", () => {
		const f = fixture(), target = {count: 1}; let mutate = true;
		const value = new Proxy(target, {getOwnPropertyDescriptor(object, key) {
			const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
			if (key === "count" && mutate) {mutate = false; object.count = 2;}
			return descriptor;
		}});
		// Original encoder sees count=1; its descriptor trap then leaves count=2.
		// A post-encoding snapshot alone would incorrectly enroll that later state.
		const intact = f.functions.captureCreatorOrdinaryDimensionIntegrity(value) as () => boolean;
		const before = f.state.encodes;
		expect(intact()).toBe(false); expect(f.state.encodes).toBe(before + 1);
		target.count = 1;
		expect(intact()).toBe(true); expect(f.state.encodes).toBe(before + 2);
	});
	it("checks prototype-trap capture mutations against the detached encoded baseline", () => {
		const f = fixture(), target = {count: 1}; let armed = false;
		const value = new Proxy(target, {getPrototypeOf(object) {
			if (armed) {armed = false; object.count = 2;}
			return Reflect.getPrototypeOf(object);
		}});
		f.state.afterEncode = input => {if (input === value) armed = true;};
		const intact = f.functions.captureCreatorOrdinaryDimensionIntegrity(value) as () => boolean;
		f.state.afterEncode = undefined;
		const before = f.state.encodes;
		expect(intact()).toBe(false); expect(f.state.encodes).toBe(before + 1);
		target.count = 1; expect(intact()).toBe(true);
	});
	it("keeps the one-encode frozen guard and never advances captured mutable facts", () => {
		const bytes = Uint8Array.of(1), frozen = guard(Object.freeze({nested: Object.freeze([bytes])}), 1);
		expect(frozen.intact()).toBe(true); expect(frozen.state.encodes).toBe(frozen.capturedEncodes);
		bytes[0] = 2; expect(frozen.intact()).toBe(false); expect(frozen.state.encodes).toBe(frozen.capturedEncodes);
		const value = {count: 1}, f = guard(value);
		value.count = 2; expect(f.intact()).toBe(false);
		expect(f.intact()).toBe(false);
		value.count = 1; const before = f.state.encodes;
		expect(f.intact()).toBe(true); expect(f.state.encodes).toBe(before);
	});
	it("still invokes original canonical validation for malformed new DATA", () => {
		const f = fixture(), cycle: {self?: unknown} = {}; cycle.self = cycle;
		for (const value of [{bad: undefined}, {bad: "\ud800"}, cycle, Object.freeze({get bad() {return 1;}})])
			expect(() => f.functions.captureCreatorOrdinaryDimensionIntegrity(value)).toThrow();
	});
});
