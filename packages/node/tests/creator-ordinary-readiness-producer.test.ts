import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";
import {sameCreatorRoomHead} from "../src/internal/creator-room-head.js";

// Execute the actual boundary producer bodies. Authentication/storage and the
// original numerical width laws are controlled premises here, not proved by
// this unit test. Native integrated scenarios remain required.
const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("producer.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
	const nodes = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (nodes.length !== 1) throw new Error(`missing actual producer:${name}:${nodes.length}`);
	return nodes[0]!.getText(tree);
}

describe("finishing readiness versus a certified window", () => {
	it("keeps an absent observational currency token from changing product failure handling", () => {
		const observer = ts.createSourceFile("observer.ts", readFileSync(new URL("../../../tests/fixtures/startup-discovery/critical-observer.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const fn = observer.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "nativeCurrencyEnd");
		if (fn === undefined) throw Error("missing native currency observation end");
		const js = ts.transpileModule(`${fn.getText(observer)}\nreturn nativeCurrencyEnd;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const end = new Function(js)();
		expect(() => end(undefined)).not.toThrow();
		const state: {future?: object} = {}, token = {state}; state.future = token;
		end(token); expect(state.future).toBeUndefined();
		state.future = {}; end(token); expect(state.future).toEqual({});
	});
	it("requires the private source, exact reader/identity and an actual window certificate for maintenance elision", () => {
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const names = ["creatorOrdinaryIssuanceSourceFacts", "creatorOrdinaryIssuanceSourceReadinessPrepared"];
		const bodies = names.map(name => {
			const found = rollback.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`missing original readiness check:${name}`);
			return found[0]!.getText(rollback).replace(/^export /, "");
		}).join("\n");
		const owners = new WeakMap<object, unknown>();
		const js = ts.transpileModule(`${bodies}\nreturn creatorOrdinaryIssuanceSourceReadinessPrepared;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const ready = new Function("maintenanceTerminalCustody", js)(owners) as (source: object, reader: object, certificate?: boolean) => boolean;
		const source = {}, reader = {}, identity = {};
		const facts = {kind: "ordinary-source", identity, capacity: {
			readiness: {reader, sourceIdentity: identity, window: {declaredLimits: {maxAdditionalLocalRows: 5, maxAdditionalReceivedRows: 128},
				limits: {maxAdditionalLocalRows: 5, maxAdditionalReceivedRows: 128}} as {certificate?: object;
				declaredLimits: {maxAdditionalLocalRows: number; maxAdditionalReceivedRows: number};
				limits: {maxAdditionalLocalRows: number; maxAdditionalReceivedRows: number}}}, application: {reader},
			template: {kind: "creator-finishing-source-programs-1", ordinary: {preparedMaterial: true}},
		}};
		owners.set(source, facts);
		expect(ready(source, reader)).toBe(true);
		expect(ready(source, reader, true)).toBe(false); // Compilation is not a finishing reserve.
		facts.capacity.readiness.window.certificate = {};
		expect(ready(source, reader, true)).toBe(true);
		facts.capacity.readiness.window.limits.maxAdditionalReceivedRows = 65;
		expect(ready(source, reader, true)).toBe(false); // A shrunken certificate cannot skip maintenance.
		expect(ready(source, reader)).toBe(true); // Its explicit smaller backpressure policy stays valid.
		facts.capacity.readiness.window.limits.maxAdditionalReceivedRows = 128;
		expect(ready({...source}, reader, true)).toBe(false);
		expect(ready(source, {}, true)).toBe(false);
		facts.capacity.readiness.sourceIdentity = {};
		expect(ready(source, reader, true)).toBe(false);
		facts.capacity.readiness.sourceIdentity = identity;
		facts.capacity.application.reader = {};
		expect(ready(source, reader, true)).toBe(false);
	});
});

function fixture(profileId = "creator-trusted-v1", oldPayloadBytes = 700) {
	const anchor = "a".repeat(64), digest = "b".repeat(64), author = "c".repeat(64), identity = {}, scope = {objectId: "room", author};
	const preimage = encodeCanonical({operation: {action: "move", payload: "x".repeat(oldPayloadBytes)}});
	const vertex = {hash: digest, kind: "drp-vertex", epoch: 2, objectId: "room", operation: {action: "move"}};
	const anchorVertex = {hash: anchor, kind: "drp-epoch-anchor", epoch: 2, objectId: "room"};
	const journal = [{digest, journalSequence: 0, sourceKind: "received", exactCanonicalPreimageBytes: preimage,
		exactCanonicalVertexBytes: encodeCanonical(vertex), detachedSignature: new Uint8Array(64)}];
	const native = {lineages: [], issued: [], outbox: [], plans: [] as any[]};
	const trust = {objectId: "room", currentEpoch: 2, currentAnchorDigest: anchor, genesisAnchorDigest: "d".repeat(64), profileId};
	const base = {blueprintDigest: "blueprint", stateDigest: "state", exactCanonicalStateBytes: encodeCanonical({positions: []})};
	const machine = {snapshot: () => base};
	const catalog = {blueprintDigest: "blueprint", artifactId: "artifact", artifactDigest: "artifact-digest", catalogDigest: "catalog",
		runtimeProfile: "runtime", exactArtifactBytes: new Uint8Array([1]), canonicalBlueprintPackageBytes: encodeCanonical({version: 1})};
	const registration: any = {payload: {parameters: {snapshotChunkBytes: 131072, maxSnapshotBytes: 100000}, catalog,
		provenance: {blueprintDigest: "blueprint"}}, authorization: {kind: "latched-acl", value: {writers: [author]}},
		blueprintMachine: machine, blueprintMachineIdentity: {machine, expectedStateDigest: "state"},
		issuanceScope: scope, mode: "genesis-active", receiveOnly: false, pendingIngress: new Map(), pendingIngressBytes: 0,
		drainingPendingIngress: false, index: {}, graphVersion: 3, epochBytes: 1000,
		closeVertices: new Map([[anchor, anchorVertex], [digest, vertex]]), controlVertices: new Set(),
		latchedOperations: new Set([digest]), authorVertexCounts: new Map([[author, 1]])};
	const state = {live: true, journal: true, source: true, owned: true, identity, checks: 0,
		beforeCheck: undefined as undefined | (() => void), afterRead: undefined as undefined | (() => void)};
	const accounting = {charge: () => true};
	const calls: any[] = [], cursors = new class extends WeakMap<object, unknown> {
		writes = 0;
		override set(key: object, value: unknown) { this.writes++; return super.set(key, value); }
	}(), geometry = new Map();
	const runtime = {currentTrust: trust, sourceBound: true, index: registration.index, graphVersion: 3, live: () => state.live};
	const hold = {}, facts: any = {registration, context: registration, retirementAllowed: false, releasing: false, pending: new Set(),
		exactCanonicalCensusBytes: encodeCanonical({nativeIssuance: {rows: native}}),
		check: async () => {state.checks++; state.beforeCheck?.(); if (!state.live) throw new Error("original native currency stale");}};
	const compound = {}, compoundState = {active: true, commit: undefined as (() => boolean) | undefined};
	const maintenanceTerminalCustody = new WeakMap([[compound, {kind: "ordinary-source-capture", hold, accounting,
		checkAvailable: () => {if (!compoundState.active || !state.live || !state.owned) throw Error("compound capture revoked");},
		stage: (commit: () => boolean) => {if (compoundState.commit) throw Error("duplicate preparation"); compoundState.commit = commit;}}]]);
	const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const resolverNode = rollback.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "resolveCreatorOrdinarySourceCapture");
	if (!resolverNode) throw Error("missing actual compound resolver");
	const resolverJs = ts.transpileModule(`${resolverNode.getText(rollback).replace(/^export /, "")}\nreturn resolveCreatorOrdinarySourceCapture;`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const resolveCreatorOrdinarySourceCapture = new Function("maintenanceTerminalCustody", resolverJs)(maintenanceTerminalCustody);
	const bindings = {ObjectFreeze: Object.freeze, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
		NumberIsSafeInteger: Number.isSafeInteger, Uint8ArrayConstructor: Uint8Array, ArrayIsArray: Array.isArray,
		encodeCanonical, decodeCanonical, hashDomain,
		sameBytes: (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0,
		isObject: (value: unknown) => value !== null && typeof value === "object",
		lowerHexDigest: (value: Uint8Array) => Buffer.from(value).toString("hex"),
		settlementProfileFor: (id: string) => id === "creator-trusted-settlement-v1" ? "v1" : undefined,
		AHE_BOUNDED_READ_LIMITS: {maxBlobBytes: 786432}, preparedMigrationTargetFloors: new WeakMap(),
		captureCreatorRecoveryRuntime: () => runtime, creatorOrdinaryIssuanceSourceIdentity: () => state.identity,
		fullRecoveryCloseHoldFacts: (value: object) => value === hold && state.owned ? facts : undefined,
		resolveCreatorOrdinarySourceCapture,
		readCreatorReplayRows: async (...args: any[]) => {calls.push(["replay", ...args]); state.afterRead?.(); return state.journal ? journal : undefined;},
		captureCreatorOrdinarySourceLinkedApplicationEffects: async (...args: any[]) => {
			calls.push(["source", ...args]); return state.source ? {effects: [], completedNative: [],
				currentSignedPreimagesHaveSettlementSource: false, currentJournalMaximumAuthorByteLength: encodeCanonical(author).byteLength} : undefined;
		},
		deriveApplicationProjectionOrder: () => ({order: {digests: [digest], controlDigests: []}}),
		creatorRuntimeActiveCensusFields: () => ({pendingIngress: {roots: [], wireByteCharge: 0, admission: "unadmitted", graphClosure: "no-pending-roots"}}),
		liveJournalScope: () => ({objectId: "room", epoch: 2, anchorDigest: anchor}),
		creatorOrdinaryRuntimeCapacityWidths: (...args: any[]) => {calls.push(["runtimeWidths", ...args]); return {currentClose: 100};},
		issuanceOrdinaryFinishingCapacityWidths: (...args: any[]) => {calls.push(["issuerWidths", ...args]); return {nativeImageByteLength: 200};},
		ordinaryApplicationResourceCursors: cursors,
		ordinaryRuntimeCapacityGeometry: geometry,
		captureCreatorOrdinaryPreparedAdmission: (...args: any[]) => {calls.push(["prepared", ...args]); return Object.freeze({});},
		creatorOrdinaryNativeControlApplicationFactForSizing: () => {throw new Error("fixture has no outbox controls");},
	};
	const bodies = `${declaration("creatorJournalCensusRows")}\n${declaration("captureOrdinaryReadinessPreparationForSizing")}\n${declaration("captureOrdinaryIssuanceRuntimeApplicationControls")}\nreturn captureOrdinaryIssuanceRuntimeApplicationControls;`;
	const js = ts.transpileModule(bodies, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	const capture = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as (...args: any[]) => Promise<any>;
	return {capture, hold, facts, state, accounting, registration, native, journal, base, calls, cursors, geometry,
		compound, compoundState, resolveCreatorOrdinarySourceCapture};
}

describe("original whole-hold boundary readiness producer", () => {
	it("shares only the exact entered source bracket and leaves runtime geometry staged until final outer currency", async () => {
		const f = fixture(), result = await f.capture(f.hold, f.accounting, f.compound);
		expect(result.preparation).toBeDefined(); expect(f.state.checks).toBe(0);
		expect(f.geometry.has(f.registration)).toBe(false); expect(f.cursors.writes).toBe(0);
		expect(f.facts.pending.size).toBe(0);
		expect(f.compoundState.commit?.()).toBe(true);
		expect(f.geometry.has(f.registration)).toBe(true); expect(f.cursors.writes).toBe(1);
		expect(f.compoundState.commit?.()).toBe(false);
		f.compoundState.active = false;
		expect(() => f.resolveCreatorOrdinarySourceCapture(f.compound, f.hold, f.accounting)).toThrow("compound capture revoked");
	});
	it("refuses copied brackets, foreign holds/books, revocation and changed runtime at deferred commit", async () => {
		for (const mode of ["copy", "book", "hold", "revoked"] as const) {
			const f = fixture();
			if (mode === "revoked") f.compoundState.active = false;
			const task = f.capture(mode === "hold" ? {} : f.hold, mode === "book" ? {} : f.accounting,
				mode === "copy" ? {...f.compound} : f.compound);
			if (mode === "revoked") await expect(task).rejects.toThrow("compound capture revoked");
			else expect(await task).toBeUndefined();
			expect(f.state.checks).toBe(0); expect(f.calls).toEqual([]); expect(f.cursors.writes).toBe(0);
		}
		for (const change of [
			(f: ReturnType<typeof fixture>) => {f.facts.releasing = true;},
			(f: ReturnType<typeof fixture>) => {f.state.owned = false;},
			(f: ReturnType<typeof fixture>) => {f.state.identity = {};},
			(f: ReturnType<typeof fixture>) => {f.registration.blueprintMachine = {};},
			(f: ReturnType<typeof fixture>) => {f.registration.blueprintMachineIdentity = {};},
		]) {
			const f = fixture(); await f.capture(f.hold, f.accounting, f.compound); change(f);
			expect(f.compoundState.commit?.()).toBe(false); expect(f.geometry.has(f.registration)).toBe(false);
			expect(f.cursors.writes).toBe(0);
		}
	});
	it("retains complete all-scope PRE/derivative coverage and refuses missing, duplicate or conflicting local witnesses", () => {
		// Original nominal/native authentication is a controlled premise, not
		// supplied by this data validator. Exercise its complete actual body.
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true),
			runtime = ts.createSourceFile("runtime.ts", readFileSync(new URL("../src/internal/runtime-reclamation.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const body = (tree: ts.SourceFile, name: string) => {
			const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (!node) throw Error(`missing actual geometry:${name}`); return node.getText(tree).replace(/^export /, "");
		};
		const bindings = {encodeCanonical, decodeCanonical, compareBytes, record: decodeCanonical,
			closedRetirementHex: (hex: string) => new Uint8Array(Buffer.from(hex, "hex"))},
			js = ts.transpileModule(`${body(runtime, "creatorAuthenticatedEpochVertexFields")}\n${body(rollback, "creatorOrdinaryCapturedEpochGeometryFits")}\n${body(rollback, "creatorOrdinaryReadinessJournalGeometryIsCompleteForSizing")}\nreturn creatorOrdinaryReadinessJournalGeometryIsCompleteForSizing;`,
				{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
			validate = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		const digest = "a".repeat(64), author = "b".repeat(64), preimage = encodeCanonical({kind: "drp-vertex", anchor: digest,
			objectId: "room", epoch: 0, dependencies: [digest], operation: {payload: "x".repeat(7448)}}), signature = new Uint8Array(64),
			raw = encodeCanonical(["accepted_entries", ["room", 0, digest, 0], {source_kind: "local-issued", vertex_digest: digest,
				local_author: author, local_author_sequence: 0}]),
			issued = {objectId: "room", author, authorSequence: 0, digest: new Uint8Array(Buffer.from(digest, "hex")), canonicalPreimageBytes: preimage, signature},
			retained = {exactCanonicalNativeFrameBytes: raw, exactCanonicalPreimageBytes: preimage, detachedSignature: signature,
				sourceKind: "local-issued", vertexDigest: digest, vertexData: decodeCanonical(preimage)},
			journal = {canonicalRows: [raw]}, native = {rows: {issued: [issued]}};
		expect(validate(journal, native, [retained])).toBe(true);
		expect(validate(journal, {rows: {issued: []}}, [retained])).toBe(true); // Exact original pruned-row witness survives.
		expect(validate(journal, {rows: {issued: []}}, [])).toBe(false);
		expect(validate(journal, {rows: {issued: [issued, issued]}}, [retained])).toBe(false);
		expect(validate(journal, native, [retained, retained])).toBe(false);
		expect(validate(journal, native, [{...retained, detachedSignature: Uint8Array.of(1)}])).toBe(false);
		const received = (bytes: unknown, kind = "received") => ({canonicalRows: [encodeCanonical(["acceptedEntries", ["room", 0, digest, 0],
			{sourceKind: kind, vertexDigest: digest, exactCanonicalPreimageBytes: bytes}])]});
		expect(validate(received(preimage), {rows: {issued: []}}, [])).toBe(true);
		for (const invalid of [received(null), received(encodeCanonical({operation: {}})), received(preimage, "unknown")])
			expect(validate(invalid, native, [retained])).toBe(false);
	});
	it("captures candidate-free DATA after same-book replay and source verification, with no retained hold or paid credit", async () => {
		const f = fixture(), result = await f.capture(f.hold, f.accounting);
		expect(result.preparation.current).not.toHaveProperty("candidate");
		expect(result.preparation.current.runtime).not.toHaveProperty("kind");
		expect(Object.keys(result.preparation).sort()).toEqual(["current", "cursor", "nativeCapacity"]);
		const replay = f.calls.find(call => call[0] === "replay").slice(1), source = f.calls.find(call => call[0] === "source").slice(1);
		expect(replay.slice(0, 5)).toEqual([f.registration, undefined, f.accounting, f.registration, undefined]);
		expect(source.slice(0, 4)).toEqual([f.registration, f.journal, f.native, f.accounting]);
		expect(source[4]).toBe(replay[5]); // Exact SAME invocation-owned parsed output cell.
		expect(result.preparation.nativeCapacity.preimage).toBe(512);
		expect(f.calls.find(call => call[0] === "runtimeWidths")[1]).toMatchObject({canonicalPreimageByteLength: 512,
			canonicalEpochVertexByteLength: 512, successorFenceCount: 0, successorFencePreimageByteLength: 0});
		expect(f.calls.find(call => call[0] === "issuerWidths")[1]).toMatchObject({maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: 512});
		expect(f.cursors.get(result.preparation.cursor)).toMatchObject({registration: f.registration, sourceIdentity: f.state.identity, graphVersion: 3});
		expect(f.facts.pending.size).toBe(0); expect(f.state.checks).toBe(2);
		expect(f.geometry.has(f.registration)).toBe(true);
		const retained = result.preparation.current.blueprint.exactCanonicalBaseStateBytes.slice();
		f.base.exactCanonicalStateBytes.fill(0);
		expect(result.preparation.current.blueprint.exactCanonicalBaseStateBytes).toEqual(retained);
	});

	it("keeps wide OLD replay leaves exact while only NEW symbolic row/fence samples use 512", async () => {
		for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1"]) {
			const f = fixture(profile, 7448), before = encodeCanonical(f.journal), result = await f.capture(f.hold, f.accounting);
			const capacity = result.preparation.nativeCapacity, runtime = f.calls.find(call => call[0] === "runtimeWidths");
			expect(capacity.preimage).toBe(512); expect(capacity.vertex).toBe(512);
			expect(capacity.fencePreimage).toBe(profile === "creator-trusted-v1" ? 0 : 512);
			expect(capacity.receivedPreimages).toEqual([f.journal[0]!.exactCanonicalPreimageBytes]);
			expect(capacity.receivedPreimages[0].byteLength).toBeGreaterThan(7448);
			expect(runtime[2]).toEqual(f.journal); // Actual original census-row producer, not a synthetic empty vector.
			expect(f.calls.find(call => call[0] === "issuerWidths")[1].rows).toEqual(f.native);
			expect(encodeCanonical(f.journal)).toEqual(before);
			const saved = capacity.receivedPreimages[0].slice(); f.journal[0]!.exactCanonicalPreimageBytes.fill(0);
			expect(capacity.receivedPreimages[0]).toEqual(saved);
		}
	});

	it("does not manufacture readiness without same-book accounting or after original replay/source verification refuses", async () => {
		for (const failure of ["no-accounting", "journal", "source"] as const) {
			const f = fixture(); if (failure !== "no-accounting") f.state[failure] = false;
			const result = await f.capture(f.hold, failure === "no-accounting" ? undefined : f.accounting);
			expect(result).not.toHaveProperty("preparation");
			expect(f.calls.some(call => call[0] === "runtimeWidths")).toBe(false);
		}
	});

	it("refuses pending work and nonterminal plans rather than pretending they are empty", async () => {
		for (const failure of ["pending", "plan"] as const) {
			const f = fixture();
			if (failure === "pending") f.registration.pendingIngress.set("pending", {});
			if (failure === "plan") {f.native.plans.push({entries: [{disposition: "replace", replacementSequence: null}]});
				f.facts.exactCanonicalCensusBytes = encodeCanonical({nativeIssuance: {rows: f.native}});}
			const result = await f.capture(f.hold, f.accounting);
			expect(result).not.toHaveProperty("preparation"); expect(f.calls).toEqual([]);
		}
	});

	it("joins the existing pending task and never enrolls a cursor after fresh native currency fails", async () => {
		const f = fixture(); f.state.afterRead = () => {f.state.live = false;};
		const task = f.capture(f.hold, f.accounting); expect(f.facts.pending.has(task)).toBe(true);
		await expect(task).rejects.toThrow("original native currency stale");
		expect(f.facts.pending.size).toBe(0);
	});

	it("does not enroll staged geometry before the caller's final complete custody check succeeds", async () => {
		const f = fixture();
		f.state.beforeCheck = () => {
			if (f.calls.some(call => call[0] === "prepared")) {
				expect(f.geometry.has(f.registration)).toBe(false);
				throw new Error("final complete custody refused");
			}
		};
		await expect(f.capture(f.hold, f.accounting)).rejects.toThrow("final complete custody refused");
		expect(f.geometry.has(f.registration)).toBe(false);
		expect(f.cursors.writes).toBe(0);
		expect(f.facts.pending.size).toBe(0);
	});

	it("retains exact owner, revocation, source and machine guards at staged commit without overwriting prior geometry", async () => {
		for (const change of [
			(f: ReturnType<typeof fixture>) => {f.facts.releasing = true;},
			(f: ReturnType<typeof fixture>) => {f.state.owned = false;},
			(f: ReturnType<typeof fixture>) => {f.state.identity = {};},
			(f: ReturnType<typeof fixture>) => {f.registration.blueprintMachine = {};},
			(f: ReturnType<typeof fixture>) => {f.registration.blueprintMachineIdentity = {};},
		]) {
			const f = fixture(), prior = Object.freeze({original: true});
			f.geometry.set(f.registration, prior);
			f.state.beforeCheck = () => {if (f.state.checks === 2) change(f);};
			const result = await f.capture(f.hold, f.accounting);
			expect(result?.preparation).toBeUndefined();
			expect(f.geometry.get(f.registration)).toBe(prior);
			expect(f.cursors.writes).toBe(0);
			expect(f.facts.pending.size).toBe(0);
		}
	});
});

function nativeMetadataReadinessFixture() {
	const calls: string[] = [], store = {}, authorization = {kind: "latched-acl"};
	const registration: any = {payload: {trust: {trust: {objectId: "room"}}}, authorization,
		issuanceScope: {objectId: "room", author: "writer"}, mode: "genesis-active", terminalState: "active",
		blueprintHandle: {}, store};
	const state = {current: true, supported: true, acquire: undefined as undefined | (() => Promise<void>),
		release: undefined as undefined | (() => Promise<void>)};
	const originalControl = {revision: 7, sequence: 3, active: null, completed: {preserved: true}};
	const bindings = {ObjectFreeze: Object.freeze,
		currentRegistration: (value: object) => value === registration && state.current,
		creatorOriginalIssuanceStore: (value: typeof registration) => value.store,
		sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
		durableIssuancePruningMaintenanceForStore: (owner: object) => owner !== store || !state.supported ? undefined : {
			acquireRetirementControl: async (input: unknown) => {
				calls.push("acquire"); expect(input).toEqual({objectId: "room"}); await state.acquire?.();
				return {control: originalControl, release: async () => {calls.push("release"); await state.release?.();},
					prepareFence: () => {throw Error("must not prepare retirement");},
					abortPrepared: () => {throw Error("must not abort retirement");},
					commitPrepared: () => {throw Error("must not commit retirement");}};
			},
		}};
	const js = ts.transpileModule(`${declaration("prepareCreatorOrdinaryNativeMetadataForReadiness")}\nreturn prepareCreatorOrdinaryNativeMetadataForReadiness;`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const prepare = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
	return {calls, registration, state, originalControl, prepare: () => prepare(registration) as Promise<void>};
}

describe("explicit readiness native metadata preparation", () => {
	it("uses the original owner and joins release without invoking retirement or changing an existing control", async () => {
		const f = nativeMetadataReadinessFixture(), before = encodeCanonical(f.originalControl);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
		f.state.release = async () => {entered(); await gate;};
		let completed = false;
		const task = f.prepare().then(() => {completed = true;});
		await ready; expect(completed).toBe(false); expect(f.calls).toEqual(["acquire", "release"]);
		release(); await task; expect(encodeCanonical(f.originalControl)).toEqual(before);
	});

	it("refuses unavailable or mismatched owners before creating metadata", async () => {
		for (const change of [
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.state.current = false;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.receiveOnly = true;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.blueprintClosing = true;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.operationAdmissionHalted = true;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.terminalTransitionQueued = true;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.issuanceScope.objectId = "foreign";},
		]) {
			const f = nativeMetadataReadinessFixture(); change(f);
			await expect(f.prepare()).rejects.toThrow("owner is unavailable"); expect(f.calls).toEqual([]);
		}
		const unsupported = nativeMetadataReadinessFixture(); unsupported.state.supported = false;
		await expect(unsupported.prepare()).rejects.toThrow("metadata is unsupported"); expect(unsupported.calls).toEqual([]);
	});

	it("joins admitted acquisition and release but withholds readiness after revocation or owner changes", async () => {
		for (const change of [
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.state.current = false;},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.store = {};},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.issuanceScope.author = "other";},
			(f: ReturnType<typeof nativeMetadataReadinessFixture>) => {f.registration.authorization = {kind: "latched-acl"};},
		]) {
			const f = nativeMetadataReadinessFixture(); f.state.acquire = async () => {change(f);};
			await expect(f.prepare()).rejects.toThrow("owner changed"); expect(f.calls).toEqual(["acquire", "release"]);
		}
		const f = nativeMetadataReadinessFixture(); f.state.release = async () => {throw Error("original release failed");};
		await expect(f.prepare()).rejects.toThrow("original release failed"); expect(f.calls).toEqual(["acquire", "release"]);
	});
});

// Execute the actual private boundary gate. Native authenticity/atomicity and
// planner eligibility remain controlled premises, not established by these jobs.
function readinessMaintenanceBoundary() {
	const calls: string[] = [], snapshots = {}, plane = {}, store = {}, floor = {}, journal = {}, issuance = {};
	const trust = {objectId: "room", currentEpoch: 3, currentAnchorDigest: "anchor", profileId: "profile", genesisAnchorDigest: "genesis"};
	const registration: any = {payload: {input: {store, settlementFloor: floor}, trust: {trust, head: {kind: "present", generationId: "head"}}, provenance: {objectId: "room"}},
		authorization: {kind: "latched-acl"}, issuanceScope: {objectId: "room", author: "writer"},
		liveJournalStore: journal, issuanceStore: issuance, snapshotReadiness: {owner: snapshots}, mode: "genesis-active",
		terminalState: "active", blueprintClosing: false, blueprintFolded: false, blueprintHandle: {},
		pendingIngress: new Map(), pendingIngressBytes: 0};
	const state = {current: true, sourceBound: true, predecessor: Promise.resolve(),
		release: undefined as undefined | (() => Promise<void>), completion: undefined as undefined | (() => void),
		sourceBindings: [{}], boundaries: [] as any[], holds: [] as object[], completionModes: [] as boolean[]};
	const lifetimes = new WeakMap<object, object>();
	const bindings = {ObjectFreeze: Object.freeze,
		sameHead: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
		sameCreatorRoomHead: (a: any, b: any) => a.objectId === b.objectId && a.epoch === b.currentEpoch && a.currentAnchorDigest === b.currentAnchorDigest,
		currentRegistration: (value: object) => value === registration && state.current,
		creatorOrdinaryIssuanceRetainedSourceBindings: () => state.sourceBindings,
		preparedMigrationTargetFloors: new WeakMap(),
		sameScope: (a: any, b: any) => a.objectId === b.objectId && a.author === b.author,
		enqueueRegistrationTask: (_: unknown, capture: () => () => Promise<void>) => {
			calls.push("enqueue"); return state.predecessor.then(capture());
		},
		captureCreatorRecoveryRuntime: () => ({live: () => state.current, sourceBound: state.sourceBound}),
		sealCreatorRecoveryDependencies: async (...args: any[]) => {
			expect(args.slice(0, 4)).toEqual([registration, true, undefined, plane]);
			expect(args.slice(4, 8)).toEqual([undefined, undefined, undefined, undefined]);
			expect(registration.blueprintClosing).toBe(true); expect(registration.blueprintFolded).toBe(false);
			expect(registration.receivedTransition).toBeUndefined();
			const boundary = args[8]; expect(boundary.available()).toBe(true); state.boundaries.push(boundary);
			calls.push("seal"); const hold = {}; state.holds.push(hold);
			lifetimes.set(hold, {release: async () => {calls.push("release"); await state.release?.();}}); return hold;
		},
		resolveRecoveryCloseHold: (hold: object, owners: any) => {
			expect(owners).toEqual({store, liveJournalStore: journal, currentTrust: trust}); return lifetimes.get(hold);
		},
		consumeCreatorRecoverySourceRetirement: async (_: object, owners: any) => {
			expect(owners).toEqual({plane, store, snapshotStore: snapshots, liveJournalStore: journal, currentTrust: trust});
			calls.push("complete-original"); state.completion?.(); return [];
		},
	};
	const js = ts.transpileModule(`${declaration("creatorRetirementResumeRequested")}\n${declaration("runCreatorOrdinaryReadinessMaintenance")}\nreturn runCreatorOrdinaryReadinessMaintenance;`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const run = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
	return {calls, registration, trust, state,
		// Controlled terminal result of the trusted ORIGINAL reconciliation owner.
		// runRaw below also exercises incomplete/absent execution handoffs.
		run: (consume: (seal: () => Promise<object>, requireClosedWorkflowCompletion: boolean) => Promise<void>) =>
			run(registration, plane, snapshots, async (seal: () => Promise<object>, strict: boolean) => {
				state.completionModes.push(strict); await consume(seal, strict); return "complete";
			}) as Promise<void>,
		runRaw: (consume: (seal: () => Promise<object>, requireClosedWorkflowCompletion: boolean) => Promise<unknown>) =>
			run(registration, plane, snapshots, consume) as Promise<void>,
		completedResume: (withSnapshotRequest = false) => {
			registration.operationAdmissionHalted = true;
			if (withSnapshotRequest) registration.retirementReconstruction = {head: {...registration.payload.trust.head},
				roomHead: {objectId: "room", epoch: 3, currentAnchorDigest: "anchor"}, certificateDigest: "original",
				exactRetirementFactBytes: Uint8Array.of(1)};
			return registration.retirementResumeControl = {objectId: "room", active: null,
				completed: {throughEpoch: 2, domains: ["original verified domain commitments"]}};
		}};
}

describe("quiescent readiness maintenance through the original queue", () => {
	it("does not confer closed-census permission on an ordinary presign or an unentered boundary", () => {
		const f = readinessMaintenanceBoundary(), r = f.registration;
		r.index = {}; r.graphVersion = 7;
		const bindings = {ObjectFreeze: Object.freeze, currentRegistration: () => f.state.current,
			nativeBranchDisplacedSource: () => undefined};
		const js = ts.transpileModule(`${declaration("captureCreatorRecoveryRuntime")}\nreturn captureCreatorRecoveryRuntime;`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const capture = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		expect(capture(r, true, false, false).live()).toBe(true);
		expect(capture(r, false, false, false).live()).toBe(false);
		let entered = false; r.blueprintClosing = true;
		const boundary = capture(r, false, false, false, () => entered);
		expect(boundary.live()).toBe(false); entered = true; expect(boundary.live()).toBe(true);
		expect(capture(r, true, false, false).live()).toBe(false); // Presign gate is still distinct.
		r.pendingIngress.set("late", {}); expect(boundary.live()).toBe(false); r.pendingIngress.clear();
		r.graphVersion++; expect(boundary.live()).toBe(false); r.graphVersion--;
		entered = false; expect(boundary.live()).toBe(false);
		r.blueprintFolded = true;
		expect(capture(r, false, false, false).live()).toBe(true); // Real close contract unchanged.
	});

	it("waits for prior work, freezes without a fold, consumes exact original completion and joins all holds", async () => {
		const f = readinessMaintenanceBoundary();
		let enter!: () => void, release!: () => void, releasing!: () => void;
		f.state.predecessor = new Promise<void>(resolve => {enter = resolve;});
		const wait = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {releasing = resolve;});
		f.state.release = async () => {releasing(); await wait;};
		let escaped!: () => Promise<object>, complete!: (observation: object) => Promise<void>, done = false;
		const task = f.run(async seal => {
			escaped = seal; await seal(); await seal();
			complete = f.state.boundaries[0].completeRetirement; await complete({});
		}).then(() => {done = true;});
		expect(f.calls).toEqual(["enqueue"]); expect(f.registration.blueprintClosing).toBe(false);
		enter(); await ready;
		expect(f.registration.blueprintClosing).toBe(true); expect(done).toBe(false);
		expect(f.calls).toEqual(["enqueue", "seal", "seal", "complete-original", "release", "release"]);
		release(); await task;
		expect(f.registration.blueprintClosing).toBe(false); expect(f.registration.blueprintFolded).toBe(false);
		expect(f.registration.operationAdmissionHalted).not.toBe(true);
		expect(f.state.completionModes).toEqual([false]);
		const before = [...f.calls];
		await expect(escaped()).rejects.toThrow(); await expect(complete({})).rejects.toThrow();
		expect(f.calls).toEqual(before); // A lexical callback is not portable or post-boundary authority.
	});

	it("refuses unsupported, nonquiescent or foreign owners without enqueuing native work", async () => {
		for (const change of [
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.state.current = false;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.trust.currentEpoch = 2;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.receiveOnly = true;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.blueprintClosing = true;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.blueprintFolded = true;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.pendingIngress.set("pending", {});},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.pendingIngressBytes = 1;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.rebaseSnapshot = [{}];},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.rebaseCursor = 0;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retainedBootstrapHold = true;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.snapshotReadiness = {owner: {}};},
		]) {
			const f = readinessMaintenanceBoundary(); change(f);
			await expect(f.run(async () => {throw Error("must not enter");})).rejects.toThrow("boundary is unavailable");
			expect(f.calls).toEqual([]);
		}
	});

	it("revokes changed source/context/native owners and joins minted work before leaving admission halted", async () => {
		for (const change of [
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.state.current = false;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.state.sourceBindings = [{}];},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.liveJournalStore = {};},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.trust.currentAnchorDigest = "different";},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.trust.currentEpoch = 4;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.pendingIngress.set("late", {});},
		]) {
			const f = readinessMaintenanceBoundary();
			await expect(f.run(async seal => {await seal(); change(f); await seal();})).rejects.toThrow();
			expect(f.calls).toEqual(["enqueue", "seal", "release"]);
			expect(f.registration.operationAdmissionHalted).toBe(true);
			expect(f.registration.blueprintClosing).toBe(true);
		}
	});

	it("does not release admission before failed consumer work joins and never clears a failed-join halt", async () => {
		const f = readinessMaintenanceBoundary(); let release!: () => void, entered!: () => void;
		const wait = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
		f.state.release = async () => {entered(); await wait; throw Error("native join failed");};
		let finished = false;
		const task = f.run(async seal => {await seal(); throw Error("original consumer failed");});
		void task.catch(() => {finished = true;}); await ready;
		expect(finished).toBe(false); expect(f.registration.blueprintClosing).toBe(true);
		await expect(f.run(async () => undefined)).rejects.toThrow("boundary is unavailable");
		release(); await expect(task).rejects.toThrow("joined release failed");
		expect(f.registration.operationAdmissionHalted).toBe(true); expect(f.registration.blueprintClosing).toBe(true);
	});

	it("keeps the captured completed-recovery halt until terminal reconstruction and every admitted hold have joined", async () => {
		for (const withSnapshotRequest of [false, true]) {
		const f = readinessMaintenanceBoundary(), original = f.completedResume(withSnapshotRequest), receipt = f.registration.retirementReconstruction;
		let release!: () => void, entered!: () => void;
		const wait = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
		f.state.release = async () => {entered(); await wait;};
		let done = false;
		const task = f.run(async seal => {
			expect(f.registration.operationAdmissionHalted).toBe(true);
			await seal(); await seal(); // Complete original workflow is a controlled unit premise.
			expect(f.registration.retirementResumeControl).toBe(original);
		}).then(() => {done = true;});
		await ready; expect(done).toBe(false); expect(f.registration.operationAdmissionHalted).toBe(true);
		expect(f.registration.retirementResumeControl).toBe(original); expect(f.registration.blueprintClosing).toBe(true);
		expect(f.registration.retirementReconstruction).toBe(receipt);
		release(); await task;
		expect(f.calls).toEqual(["enqueue", "seal", "seal", "release", "release"]);
		expect(f.registration.operationAdmissionHalted).toBe(false); expect(f.registration.retirementResumeControl).toBeUndefined();
		expect(f.registration.retirementReconstruction).toBeUndefined();
		expect(f.registration.blueprintClosing).toBe(false); expect(f.registration.blueprintFolded).toBe(false);
		expect(f.state.completionModes).toEqual([true]);
		expect(f.state.boundaries.every(boundary => !boundary.available())).toBe(true);
		}
	});

	it("never treats an unrelated halt, active intent, foreign checkpoint or separate reconstruction as completed readiness recovery", async () => {
		for (const change of [
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementResumeControl = undefined;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementResumeControl.objectId = "foreign";},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementResumeControl.completed.throughEpoch = 1;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementResumeControl.completed.domains = undefined;},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementResumeControl.active = {};},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementReconstruction = {
				head: {...f.registration.payload.trust.head, generationId: "foreign"},
				roomHead: {objectId: "room", epoch: 3, currentAnchorDigest: "anchor"}};},
			(f: ReturnType<typeof readinessMaintenanceBoundary>) => {f.registration.retirementReconstruction = {
				head: {...f.registration.payload.trust.head}, roomHead: {objectId: "room", epoch: 2, currentAnchorDigest: "anchor"}};},
		]) {
			const f = readinessMaintenanceBoundary(); f.completedResume(); change(f);
			await expect(f.run(async () => {throw Error("must not enter");})).rejects.toThrow("boundary is unavailable");
			expect(f.registration.operationAdmissionHalted).toBe(true); expect(f.calls).toEqual([]);
		}
	});

	it("retains completed recovery on incomplete handoff, empty reconstruction, stale request, consumer failure or failed join", async () => {
		for (const failure of ["undefined", "fresh", "empty", "request", "receipt", "consumer", "join"] as const) {
			const f = readinessMaintenanceBoundary(), original = f.completedResume(true), receipt = f.registration.retirementReconstruction;
			if (failure === "join") f.state.release = async () => {throw Error("native join failed");};
			await expect(f.runRaw(async seal => {
				if (failure !== "empty") await seal();
				if (failure === "consumer") throw Error("native reconstruction failed");
				if (failure === "request") f.registration.retirementResumeControl = {...original};
				if (failure === "receipt") f.registration.retirementReconstruction = {...receipt};
				return failure === "undefined" ? undefined : failure === "fresh" ? "fresh-summary-required" : "complete";
			})).rejects.toThrow();
			expect(f.registration.operationAdmissionHalted, failure).toBe(true);
			expect(f.registration.retirementResumeControl, failure).toBeDefined();
			expect(f.registration.retirementReconstruction, failure).toBeDefined();
			expect(f.registration.blueprintClosing, failure).toBe(true);
			if (failure !== "empty") expect(f.calls).toEqual(["enqueue", "seal", "release"]);
		}
	});
});

function terminalJournalAcknowledgement() {
	const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const fn = rollback.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "acknowledgeClosedJournalDrain");
	if (!fn) throw Error("missing actual terminal acknowledgement");
	const labels = {throughEpoch: 2, decisionDigest: "decision", sourceProofDigest: "source"},
		image = {imageDigest: "image", rowCount: 2}, rows = [encodeCanonical({retained: true})];
	const state = {control: {active: null, completed: {...labels}, revision: 15,
		drain: {cursor: 1, residualImageDigest: "image", plan: {baseControl: {completed: {...labels}}, sourceImage: {rowCount: 3}}}} as any,
		charges: [] as Uint8Array[], calls: [] as string[], permit: true, loseDelivery: false, wrongPostimage: false};
	const failureKinds = ["retirement-stale", "outcome-unknown", "substrate-failure"];
	const bindings = {LIVE_JOURNAL_FAILURE_KINDS: failureKinds,
		checkAbort: () => undefined,
		requireLaw: (value: unknown, reason: string) => {if (!value) throw Error(reason);},
		closedRetirementBytes: encodeCanonical,
		closedRetirementEqual: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
		journalRetirementDrainItemCount: () => 1,
		advanceJournalRetirementMutationControl: (control: any) => ({...control, revision: control.revision + 1, drain: null}),
		closedJournalNativeControlCarriers: (read: any) => [encodeCanonical(read.control)],
		closedJournalReconstructedControlCarriers: (control: any) => [encodeCanonical(control)],
		joinedClosedRetirementRead: async (read: any, use: () => Promise<void>) => {try {await use();} finally {await read.release();}},
	};
	const js = ts.transpileModule(`${fn.getText(rollback)}\nreturn acknowledgeClosedJournalDrain;`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const ack = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
	const acquire = async () => {
		state.calls.push("acquire"); const control = state.control;
		return {control, image, drainSource: control.drain == null ? undefined :
			{control: control.drain.plan.baseControl, image: control.drain.plan.sourceImage},
			readExactCanonicalRows: () => rows,
			acknowledgeCompletedDrain: async () => {
				state.calls.push("ack");
				for (const kind of failureKinds) expect(state.charges).toContainEqual(encodeCanonical({ok: false, kind}));
				const next = {...control, revision: control.revision + 1, drain: null};
				state.control = state.wrongPostimage ? {...next, revision: next.revision + 1} : next;
				if (state.loseDelivery) throw Error("native delivery lost");
				return {ok: true, value: next};
			}, release: async () => {state.calls.push("release");}};
	};
	return {state, rows, labels, run: () => ack({source: {input: {}, accounting: {charge: (bytes: Uint8Array) => {
		state.charges.push(bytes.slice()); return state.permit;
	}}}, labels, acquire, checkCoordinator: async () => {state.calls.push("coordinator");}}) as Promise<void>};
}

describe("terminal completed-drain acknowledgement", () => {
	it("charges the original book before effects and joins exact unchanged-image readback", async () => {
		const f = terminalJournalAcknowledgement(), originalRows = encodeCanonical(f.rows);
		await f.run(); expect(f.state.control.drain).toBeNull();
		expect(f.state.control.completed).toEqual(f.labels); expect(encodeCanonical(f.rows)).toEqual(originalRows);
		expect(f.state.calls).toEqual(["coordinator", "acquire", "ack", "release", "acquire", "release", "coordinator"]);
		f.state.calls.length = 0; await f.run(); // Exact already-compact terminal source is a no-op, not another refund.
		expect(f.state.calls).toEqual(["coordinator", "acquire", "release"]);
	});

	it("refuses partial, foreign, stale or insufficiently charged acknowledgements before the native attempt", async () => {
		for (const change of [
			(f: ReturnType<typeof terminalJournalAcknowledgement>) => {f.state.control.drain.cursor = 0;},
			(f: ReturnType<typeof terminalJournalAcknowledgement>) => {f.state.control.completed.sourceProofDigest = "foreign";},
			(f: ReturnType<typeof terminalJournalAcknowledgement>) => {f.state.control.drain.residualImageDigest = "stale";},
			(f: ReturnType<typeof terminalJournalAcknowledgement>) => {f.state.permit = false;},
		]) {
			const f = terminalJournalAcknowledgement(); change(f);
			await expect(f.run()).rejects.toThrow(); expect(f.state.calls).not.toContain("ack");
			expect(f.state.calls.at(-1)).toBe("release"); expect(f.state.control.drain).not.toBeNull();
		}
	});

	it("independently reads an uncertain postimage without erasing the original failure", async () => {
		const f = terminalJournalAcknowledgement(); f.state.loseDelivery = true;
		await expect(f.run()).rejects.toThrow("native delivery lost");
		expect(f.state.control.drain).toBeNull(); expect(f.state.calls.filter(c => c === "release")).toHaveLength(2);
		const changed = terminalJournalAcknowledgement(); changed.state.loseDelivery = true; changed.state.wrongPostimage = true;
		await expect(changed.run()).rejects.toThrow("acknowledgement readback failed");
		expect(changed.state.calls.filter(c => c === "release")).toHaveLength(2);
	});
});

function terminalVerificationCustody() {
	const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const matches: ts.ArrowFunction[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && node.name.getText(rollback) === "verifyCompleted" &&
			node.initializer !== undefined && ts.isArrowFunction(node.initializer)) matches.push(node.initializer);
		ts.forEachChild(node, visit);
	}
	visit(rollback); if (matches.length !== 1) throw Error("missing actual terminal verifier");
	const coordinator = {completed: {decision: "original"}}, head = {generationId: "head"}, image = {imageDigest: "journal"},
		rows = [encodeCanonical({retained: true})], snapshotImage = {imageDigest: "snapshot"};
	const state = {aheHeld: false, checks: 0, participants: new Map<number, boolean>(), calls: [] as string[]};
	const journal = {control: null, image, canonicalRows: rows};
	const input = {objectId: "room", liveJournalStore: {readRetirementImage: async () => ({ok: true, value: journal})},
		snapshotStore: {readRetirementImage: async () => ({image: snapshotImage})},
		store: {
			acquireNativeReadReservation: async () => {
				state.aheHeld = true; state.calls.push("ahe-held");
				return {check: async () => {expect(state.aheHeld).toBe(true); state.checks++;},
					release: async () => {state.calls.push("ahe-release"); state.aheHeld = false;}};
			},
			readRetirementImage: async () => ({ok: true, value: {control: coordinator, head, imageDigest: "ahe",
				metadataBytes: encodeCanonical(coordinator).byteLength}}),
		}};
	const participants = [4, 8, 16].map(domain => ({commitment: [domain], acquire: async () => {
		state.participants.set(domain, true); return {phase: "completed", release: async () => {
			state.calls.push(`release-${domain}`); state.participants.set(domain, false);
		}};
	}}));
	const bindings = {input, participants, source: {journal, snapshotImage: {image: snapshotImage}},
		summary: {head}, objectId: "room", expectedAheImage: "ahe", journalPrefixes: [], accounting: {charge: () => true},
		acquireCoordinator: async () => {
			expect(state.aheHeld).toBe(false); // Do not nest a coordinator RW/CAS inside the existing native RO.
			return {control: coordinator, head, imageDigest: "ahe", release: async () => undefined};
		},
		bindMethod: (owner: any, key: string) => owner[key].bind(owner),
		requireLaw: (value: unknown, kind: string) => {if (!value) throw Error(kind);},
		closedRetirementEqual: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
		closedRetirementBytes: encodeCanonical, encodeAheRetirementControl: encodeCanonical,
		closedJournalNativeControlCarriers: () => [encodeCanonical(null)],
		checkSourceImage: (actual: string, expected: string) => {expect(actual).toBe(expected);},
	};
	const js = ts.transpileModule(`return ${matches[0]!.getText(rollback)};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const verify = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
	return {state, run: (classify?: () => Promise<void>, ack?: () => Promise<void>) => verify(coordinator, classify, ack) as Promise<void>};
}

describe("terminal verification custody", () => {
	it("holds the real coordinator exclusion across journal acknowledgement and joins it on success or failure", async () => {
		for (const fail of [false, true]) {
			const f = terminalVerificationCustody();
			const task = f.run(undefined, async () => {
				expect(f.state.aheHeld).toBe(true); // Native exclusion itself is an accepted controlled premise here.
				expect(f.state.participants.get(8)).toBe(false); // Own journal view joins before its RW.
				expect(f.state.participants.get(4)).toBe(true); expect(f.state.participants.get(16)).toBe(true);
				if (fail) throw Error("ACK uncertain");
			});
			if (fail) await expect(task).rejects.toThrow("ACK uncertain"); else await task;
			expect(f.state.aheHeld).toBe(false); expect([...f.state.participants.values()]).toEqual([false, false, false]);
			expect(f.state.checks).toBeGreaterThanOrEqual(2);
		}
	});

	it("keeps snapshot classification distinct and refuses two mutation callbacks before acquiring views", async () => {
		const f = terminalVerificationCustody();
		await f.run(async () => {
			expect(f.state.aheHeld).toBe(true); expect(f.state.participants.get(4)).toBe(false);
			expect(f.state.participants.get(8)).toBe(true);
		});
		const invalid = terminalVerificationCustody();
		await expect(invalid.run(async () => undefined, async () => undefined)).rejects.toThrow("chain-invalid");
		expect(invalid.state.calls).toEqual([]);
	});
});

function closeReadinessJob(options: {supported?: boolean; metadata?: () => Promise<void>; epoch?: number; window?: boolean; completedRecovery?: boolean;
	generationCount?: number; recoveryScopes?: number; activeIntent?: boolean; recoveryRequired?: boolean; prepared?: readonly boolean[]; certified?: readonly boolean[];
	priorSource?: object; refresh?: () => Promise<object | undefined>;
	reconcile?: (seal: () => Promise<object>) => Promise<void>} = {}) {
	const close = ts.createSourceFile("close.ts", readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const matches: ts.ArrowFunction[] = [];
	function visit(node: ts.Node): void {
		if (ts.isPropertyAssignment(node) && node.name.getText(close) === "prepareOrdinaryReadiness" && ts.isArrowFunction(node.initializer))
			matches.push(node.initializer);
		ts.forEachChild(node, visit);
	}
	visit(close); if (matches.length !== 1) throw Error("missing actual readiness job");
	const calls: string[] = [], completionModes: boolean[] = [];
	const body = `
	 let stopping=false,maintenanceClosing=false,lifecycle="active",dependenciesReleased=false,
	   dependencyReleaseTask,acquisitionTask,promotedEpoch,maintenanceReleaseFailure,ordinaryProofSource=options.priorSource,ordinaryTemplateReady=false,
	   promotionSource,recoverySource;
	 const maintenanceJobs=new Set(),actor={status:()=>({terminal:false})};
	 const input=options.supported===false?{}:{promotionContext:{},readOrdinaryApplicationResourceBound:()=>{},snapshotStore:{
	   recoveryStatus:async()=>{calls.push("snapshots");return {migration:"ready",recoveryScopes:options.recoveryScopes??2,limits:{maxRecoveryScopes:4}};}},
	   ...(options.window?{ordinaryFinishingWindow:{}}:{})};
	 const AHE_BOUNDED_READ_LIMITS={maxObjectGenerations:7};
	 const registration={objectId:"room",currentTrust:{currentEpoch:options.epoch??0},
	   store:{readGenerationPage:async()=>{calls.push("generations");return {ok:true,value:{generations:Array(options.generationCount??1).fill({})}};},
	     readRetirementControl:async()=>{calls.push("retirement");return {ok:true,value:options.activeIntent?{active:{}}:null};}},
	   needsOrdinaryReadinessRecovery:()=>options.completedRecovery===true||options.recoveryRequired===true,
	   runOrdinaryReadinessMaintenance:async(_,consume)=>{calls.push("boundary");
	     await consume(async()=>{calls.push("seal");return {};},options.completedRecovery??false);calls.push("boundary-joined");},
	   prepareOrdinaryNativeMetadataForReadiness:async()=>{
	   calls.push("metadata");await options.metadata?.();calls.push("metadata-joined");}};
	 const reconcileCreatorBoundedRecoveryMaintenance=async(_registration,_input,_actor,_count,seal,_ack,strict,currentTrust)=>{
	   assertTrust(currentTrust,registration.currentTrust);
	   completionModes.push(strict);calls.push("reconcile");if(options.reconcile)await options.reconcile(seal);else await seal();return "complete";};
	 let captures=0;
	 const captureCreatorOrdinarySourceWithoutForecast=async()=>{calls.push("capture");const index=captures++;return options.supported===false?undefined:{prepared:options.prepared?.[index]??true,certified:options.certified?.[index]??true};};
	 const refreshCreatorOrdinarySourceReadiness=async(_registration,_input,prior)=>{if(prior!==options.priorSource)throw Error("foreign prior source");calls.push("refresh");return options.refresh?.();};
	 const creatorOrdinaryIssuanceSourceReadinessPrepared=(source,_reader,requireCertificate=false)=>source.prepared&&(!requireCertificate||source.certified);
	 const run=${matches[0]!.getText(close)};
	 return {run,stop:()=>{stopping=true;},jobs:maintenanceJobs,ready:()=>ordinaryTemplateReady,currentSource:()=>ordinaryProofSource};`;
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	return {calls, completionModes, ...new Function("options", "calls", "completionModes", "assertTrust", js)(options, calls, completionModes,
		(actual: unknown, original: unknown) => {expect(actual).toBe(original);})} as
		{calls: string[]; completionModes: boolean[]; run(): Promise<void>; stop(): void; jobs: Set<Promise<void>>; ready(): boolean; currentSource(): object | undefined};
}

describe("same-owner readiness source refresh consumer", () => {
	it("refreshes the retained source only at the explicit boundary and publishes the joined replacement", async () => {
		const replacement = {prepared: true, certified: true}, f = closeReadinessJob({epoch: 4, window: true,
			priorSource: {}, refresh: async () => replacement});
		await f.run();
		expect(f.ready()).toBe(true); expect(f.currentSource()).toBe(replacement);
		expect(f.calls.filter(call => call === "refresh")).toHaveLength(1);
		expect(f.calls).not.toContain("capture"); expect(f.calls).not.toContain("boundary"); expect(f.jobs.size).toBe(0);
	});
	it("keeps an inconclusive postimage or missing reopen hint on the original cold boundary", async () => {
		for (const priorSource of [{}, undefined]) {
			const f = closeReadinessJob({epoch: 4, window: true, priorSource, refresh: async () => undefined});
			await f.run(); expect(f.ready()).toBe(true);
			expect(f.calls.filter(call => call === "refresh")).toHaveLength(priorSource === undefined ? 0 : 1);
			expect(f.calls.filter(call => call === "capture")).toHaveLength(1);
		}
	});
	it("discards the old hint after required maintenance and never lets it bypass the original cold proof", async () => {
		const f = closeReadinessJob({epoch: 4, window: true, priorSource: {}, recoveryRequired: true,
			refresh: async () => {throw Error("old source must not survive maintenance");}});
		await f.run(); expect(f.ready()).toBe(true); expect(f.calls).toContain("boundary-joined");
		expect(f.calls).not.toContain("refresh"); expect(f.calls.filter(call => call === "capture")).toHaveLength(1);
	});
	it("revokes and joins the admitted refresh before exposing any replacement or starting fallback", async () => {
		let finish!: (source: object) => void, started!: () => void;
		const entered = new Promise<void>(resolve => {started = resolve;});
		const f = closeReadinessJob({epoch: 4, window: true, priorSource: {}, refresh: () => {
			started(); return new Promise(resolve => {finish = resolve;});
		}});
		const pending = f.run(); await entered; expect(f.currentSource()).toBeUndefined(); expect(f.jobs.size).toBe(1);
		f.stop(); finish({prepared: true, certified: true});
		await expect(pending).rejects.toThrow("admission was revoked");
		expect(f.ready()).toBe(false); expect(f.currentSource()).toBeUndefined(); expect(f.jobs.size).toBe(0);
		expect(f.calls).not.toContain("capture");
	});
});

// Run the actual source-selection prefix and its original catch/finally. The
// downstream retirement planner is deliberately excluded: nominal sealing,
// authentication and native reservations remain controlled premises here.
function readinessRecoveryAcquisition() {
	const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const fn = rollback.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "reconcileSnapshotRecoveryRoles");
	if (!fn?.body) throw Error("missing original recovery acquisition");
	const mainTry = fn.body.statements.find((node): node is ts.TryStatement => ts.isTryStatement(node) &&
		node.tryBlock.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
			declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "closeObserved")));
	const planner = mainTry?.tryBlock.statements.find(statement => ts.isVariableStatement(statement) &&
		statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "transferRoles"));
	if (!mainTry || !planner) throw Error("missing original recovery acquisition/planner boundary");
	const offset = fn.getStart(rollback), original = fn.getText(rollback);
	const prefix = original.slice(0, planner.getStart(rollback) - offset) +
		"/* Retirement planner outside this fixture. */\n" + original.slice(mainTry.tryBlock.getEnd() - 1 - offset);
	const calls: string[] = [], fullArguments: unknown[][] = [];
	const trust = {objectId: "room", currentEpoch: 3, currentAnchorDigest: "anchor", genesisAnchorDigest: "genesis", profileId: "profile"};
	const closeHold = {}, preliminaryToken = {}, fullToken = {}, rolesToken = {};
	const floorHead = {objectId: "room", epoch: 3, currentAnchorDigest: "anchor"};
	const roles = {head: {kind: "present", objectId: "room", generationId: "generation", closureDigest: "closure", revision: 1},
		floor: {stable: floorHead, pending: null}, pending: null};
	const state = {nominal: true, validHold: true, staleRecensus: false, fullFailure: false, unionFailure: false, failAcquire: "", failRelease: "",
		releaseGate: undefined as Promise<void> | undefined, headerReleaseEntered: undefined as (() => void) | undefined};
	const reservation = (name: string) => ({check: async () => {calls.push(`check:${name}`);}, release: async () => {
		calls.push(`release:${name}`);
		if (name === "header") {state.headerReleaseEntered?.(); await state.releaseGate;}
		if (state.failRelease === name) throw Error(`release failed:${name}`);
	}});
	const acquire = async (name: string) => {
		calls.push(`acquire:${name}`); if (state.failAcquire === name) throw Error(`acquire failed:${name}`);
		return reservation(name);
	};
	const header = reservation("header"), borrowedHeader = reservation("borrowed-header");
	const union = {readSealedCloseDependencies: () => {calls.push("sealed-census"); return Uint8Array.of(1);},
		check: async () => {calls.push("check:union"); if (state.unionFailure) throw Error("full union revoked");}};
	const fullMaterial = {currentTrust: {...trust}, sources: [{closedEpoch: 2, successorEpoch: 3, successorAnchorDigest: "anchor"}],
		acquireProtectedUnion: async () => {calls.push("acquire:union"); return union;},
		release: async () => {calls.push("release:full");}};
	const preliminaryMaterial = {currentTrust: trust, checkCurrent: async () => {calls.push("check:preliminary");},
		release: async () => {calls.push("release:preliminary");}};
	// These are the same private observation -> forward reader -> owning frame
	// relationships consulted by the actual prefix, not a structural resolver.
	const reader = {head: roles.head}, recoveryFrame: any = {reader, wholeCensus: true, wholeFloor: roles.floor,
		currentTrust: fullMaterial.currentTrust};
	const recoveryOwner = {alive: true, reader, forwardMaterial: fullMaterial as object,
		checkRecoverySourceCurrent: (async () => {calls.push("check:recovery-source");}) as (() => Promise<void>) | undefined};
	const observations = new WeakMap<object, any>([[fullToken, {forward: recoveryFrame,
		summary: {head: roles.head, floor: floorHead, profileId: trust.profileId}}]]);
	const frames = new WeakMap<object, typeof recoveryOwner>([[reader, recoveryOwner]]);
	const lifetime = {acquireNativeIssuanceReservation: () => acquire("issuer"),
		check: async () => {calls.push("check:lifetime");}, release: async () => {calls.push("release:lifetime");}};
	const input = {objectId: "room", pinnedGenesisAnchorDigest: "genesis", exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array.of(1),
		store: {acquireNativeReadReservation: () => acquire("ahe")}, liveJournalStore: {},
		roomHeadAuthority: {acquireNativeReadReservation: () => acquire("floor")}, catalog: {},
		snapshotStore: {captureRecoveryRoleInventory: async () => ({owner: {migration: "ready"}}), reconcileRecoveryRoles: async () => undefined},
		floorRead: async () => ({stable: floorHead, pending: null})};
	recoveryFrame.input = input;
	class FixtureRefusal extends Error {constructor(readonly result: {kind: string}) {super(result.kind);}}
	let recensus = 0;
	const bindings = {capture: () => input, checkAbort: () => undefined,
		bindMethod: (owner: any, key: string) => owner[key].bind(owner), snapshotCall: (job: () => Promise<unknown>) => job(),
		captureCreatorRoomHeadState: (value: unknown) => ({ok: true, state: value}),
		observeCreatorProtectedRecoveryRoles: async () => {calls.push("roles"); recensus++; return {ok: true, observation: rolesToken};},
		resolveCreatorProtectedRecoveryRoleObservation: () => state.staleRecensus && recensus > 1 ? {...roles, pending: {}} : roles,
		resolveSealRecoveryTrust: (value: unknown) => {calls.push("nominal"); return state.nominal && value === trust ? {} : undefined;},
		sameCreatorRoomHead,
		resolveCreatorSnapshotRecoveryCloseHold: (value: unknown, owners: any) => {
			calls.push("resolve:hold"); expect(owners).toEqual({store: input.store, liveJournalStore: input.liveJournalStore, currentTrust: trust});
			return state.validHold && value === closeHold ? lifetime : undefined;
		},
		acquireCreatorForwardPromotionSource: async () => {calls.push("preliminary"); return {ok: true, observation: preliminaryToken};},
		resolveCreatorForwardPromotionSource: (value: unknown, store: unknown, snapshots: unknown) => {
			expect(store).toBe(input.store); expect(snapshots).toBe(input.snapshotStore);
			return value === fullToken ? fullMaterial : value === preliminaryToken ? preliminaryMaterial : undefined;
		},
		sourceJournalHeaderHold: () => header,
		acquireJournalHeaderHold: async (journal: unknown, objectId: string) => {
			expect(journal).toBe(input.liveJournalStore); expect(objectId).toBe(input.objectId);
			calls.push("acquire:header"); return header;
		},
		borrowJournalHeaderHold: (original: unknown, journal: unknown) => {
			expect(original).toBe(header); expect(journal).toBe(input.liveJournalStore); calls.push("borrow:header"); return borrowedHeader;
		},
		acquireClosedData: async (...args: unknown[]) => {
			calls.push("full"); fullArguments.push(args);
			if (state.fullFailure) return {ok: false, kind: "chain-invalid"};
			return {ok: true, observation: fullToken};
		},
		resolveCreatorClosedRollbackDataObservation: () => {calls.push("summary"); return {head: roles.head, floor: floorHead};},
		sameRoleHead: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
		requireLaw: (value: unknown, kind: string) => {if (!value) throw Error(kind);},
		failure: (kind: string) => ({kind}), Refusal: FixtureRefusal, RoleRefusal: FixtureRefusal, observations, frames,
		compareBytes, closedRetirementEqual: (left: unknown, right: unknown) => compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0};
	const basis = rollback.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "creatorClosedReconciliationRoleBasis");
	if (basis === undefined) throw Error("missing original held-source role basis");
	const js = ts.transpileModule(`${basis.getText(rollback)}\n${prefix}\nreturn reconcileSnapshotRecoveryRoles;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
	const reconcile = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
	return {calls, fullArguments, state, trust, closeHold, fullMaterial, input, borrowedHeader, observations, frames, fullToken, reader, recoveryOwner, recoveryFrame, roles,
		run: (currentTrust: unknown = trust, hold: unknown = closeHold) => reconcile(input, hold, true, false, currentTrust) as Promise<boolean>,
		runWithoutHold: () => reconcile(input, undefined, true, false, trust) as Promise<boolean>,
		runLegacy: () => reconcile(input, closeHold, true, false) as Promise<boolean>};
}

describe("readiness-owned no-effect snapshot readback", () => {
	const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const fn = (name: string): ts.FunctionDeclaration => {
		const node = rollback.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
		if (!node) throw Error(`missing original no-effect owner:${name}`); return node;
	};
	const reconcile = fn("reconcileSnapshotRecoveryRoles");
	const find = <T extends ts.Node>(predicate: (node: ts.Node) => node is T): T => {
		const nodes: T[] = []; const visit = (node: ts.Node): void => {if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit);};
		visit(reconcile); if (nodes.length !== 1) throw Error(`nonunique original no-effect boundary:${nodes.length}`); return nodes[0]!;
	};
	const execute = <T>(body: string, bindings: Record<string, unknown>): T => {
		const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings) as T;
	};
	const law = (ok: unknown, reason: string): void => {if (!ok) throw Error(reason);};
	const fixture = () => {
		const scope = {objectId: "room", epoch: 3, anchor: "anchor", manifestDigest: "manifest"};
		const snapshot = {control: {incarnation: "native", revision: 2}, image: {imageDigest: "physical", scopes: [{scope, incarnation: "scope-incarnation"}], chunkCount: 1}};
		const inventory = {custody: {}, scopes: [{scope, incarnation: "scope-incarnation", contentBytes: 400}], owner: {migration: "ready", recoveryScopes: 1,
			recoveryContentBytes: 400, limits: {maxRecoveryScopes: 4}, temporaryScopes: 2, reservedBytes: 123}};
		return {snapshot, inventory};
	};
	const helpers = ["creatorClosedSnapshotRoleInventoryBytes", "verifyCreatorClosedUnchangedSnapshotReadback"].map(name => fn(name).getText(rollback)).join("\n");
	const verify = execute<(input: unknown) => void>(`${helpers}\nreturn verifyCreatorClosedUnchangedSnapshotReadback;`, {
		closedRetirementBytes: encodeCanonical, compareBytes, requireLaw: law,
	});
	const basis = (f: ReturnType<typeof fixture>) => ({snapshotBytes: encodeCanonical(f.snapshot),
		inventoryBytes: encodeCanonical({scopes: f.inventory.scopes, owner: f.inventory.owner})});
	it("uses only a genuine live zero-effect basis and keeps every effect or uncertain outcome on full readback", () => {
		const candidate = {}, selection = find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "unchangedSnapshotReadback");
		for (const kind of ["none", "no-basis", "retiring", "exclusion", "decision", "receipt", "failure"]) {
			const actual = execute(`const ${selection.getText(rollback)}; return unchangedSnapshotReadback;`, {
				retiring: kind === "retiring" ? [{}] : [], snapshotExclusion: kind === "exclusion" ? {} : undefined,
				retirementDecision: kind === "decision" ? {} : undefined, nativeReceipt: kind === "receipt" ? {} : undefined,
				transactionFailure: kind === "failure" ? Error("lost acknowledgement") : undefined,
				unchangedSnapshotCandidate: kind === "no-basis" ? undefined : candidate,
			});
			expect(actual).toBe(kind === "none" ? candidate : undefined);
		}
		const capture = find((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(rollback) === "currentTrust !== undefined && closeHold !== undefined && selection.retiringScopes.length === 0");
		for (const kind of ["live", "no-trust", "no-hold", "retiring"]) {
			const f = fixture(), charges: Uint8Array[] = [];
			const actual = execute(`let unchangedSnapshotCandidate;${capture.getText(rollback)}\nreturn unchangedSnapshotCandidate;`, {
				currentTrust: kind === "no-trust" ? undefined : {}, closeHold: kind === "no-hold" ? undefined : {},
				selection: {retiringScopes: kind === "retiring" ? [{}] : []}, inventory: f.inventory,
				snapshotBytes: encodeCanonical(f.snapshot), creatorClosedSnapshotRoleInventoryBytes: (inventory: typeof f.inventory) => encodeCanonical({scopes: inventory.scopes, owner: inventory.owner}),
				schedulingFrame: {accounting: {charge: (bytes: Uint8Array) => {charges.push(bytes); return true;}}}, requireLaw: law,
			});
			expect(actual !== undefined).toBe(kind === "live"); expect(charges).toHaveLength(kind === "live" ? 1 : 0);
		}
	});
	it("compares complete native control, content image, scope incarnation and full owner without treating custody handles as authority", () => {
		const original = fixture(), captured = basis(original), charges: Uint8Array[] = [];
		verify({...fixture(), basis: captured, accounting: {charge: (bytes: Uint8Array) => {charges.push(bytes); return true;}}});
		expect(charges).toEqual([captured.inventoryBytes]); // Snapshot is already paid by the original RAW loop.
		for (const mutate of [
			(f: ReturnType<typeof fixture>) => {f.snapshot.control.revision++;},
			(f: ReturnType<typeof fixture>) => {f.snapshot.control.incarnation = "reopened";},
			(f: ReturnType<typeof fixture>) => {f.snapshot.image.imageDigest = "altered-content";},
			(f: ReturnType<typeof fixture>) => {f.snapshot.image.scopes[0]!.incarnation = "other";},
			(f: ReturnType<typeof fixture>) => {f.inventory.scopes[0]!.incarnation = "other";},
			(f: ReturnType<typeof fixture>) => {f.inventory.scopes[0]!.contentBytes++;},
			(f: ReturnType<typeof fixture>) => {f.inventory.owner.reservedBytes++;},
			(f: ReturnType<typeof fixture>) => {f.inventory.owner.limits.maxRecoveryScopes++;},
			(f: ReturnType<typeof fixture>) => {f.inventory.owner.migration = "classification-required";},
		]) {
			const changed = fixture(); mutate(changed);
			expect(() => verify({...changed, basis: captured, accounting: {charge: () => true}})).toThrow("snapshot-invalid");
		}
		// Mutate-and-restore of the original supplied native observation cannot
		// change the retained byte basis captured before the first asynchronous read.
		original.snapshot.control.revision++; original.inventory.owner.reservedBytes++;
		expect(() => verify({...original, basis: captured, accounting: {charge: () => true}})).toThrow("snapshot-invalid");
		original.snapshot.control.revision--; original.inventory.owner.reservedBytes--;
		expect(() => verify({...original, basis: captured, accounting: {charge: () => true}})).not.toThrow();
	});
	it("keeps actual fresh observations fully charged and refuses budget exhaustion", () => {
		const f = fixture(); let calls = 0;
		expect(() => verify({...f, basis: basis(f), accounting: {charge: () => {calls++; return false;}}})).toThrow("proof-budget-exceeded");
		expect(calls).toBe(1);
	});
	it("reserves the complete new carrier in the original exact owner and both numerical paths", () => {
		// Execute the actual added source-envelope term, not an invented margin.
		// Native construction/authentication and all OTHER envelope terms remain
		// premises covered by their existing exact/native regressions.
		const exact = fn("composeProspectiveCreatorMaintenancePrefixesForSizing");
		const terms: ts.CallExpression[] = [];
		const visitExact = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.expression.getText(rollback) === "maximumWidth" &&
				node.getText(rollback).includes("maintenanceCanonicalWidth({scopes: retainedInventory, owner: retainedOwner})")) terms.push(node);
			ts.forEachChild(node, visitExact);
		}; visitExact(exact); expect(terms).toHaveLength(1);
		const findVariable = (name: string): ts.VariableDeclaration => {
			const nodes: ts.VariableDeclaration[] = []; const visit = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) nodes.push(node);
				ts.forEachChild(node, visit);
			}; visit(rollback); if (nodes.length !== 1) throw Error(`nonunique original bound:${name}`); return nodes[0]!;
		};
		const scalar = findVariable("rawSourcePhysical"), program = findVariable("rawSourcePhysicalTerm");
		for (const nested of [0, 1, 3]) {
			const f = fixture(), retainedInventory = f.inventory.scopes, retainedOwner = f.inventory.owner;
			const future = {scopes: [...retainedInventory, {...retainedInventory[0], retirement: {history: Array.from({length: nested}, (_, i) => ({epoch: i, digest: "a".repeat(64)}))}}], owner: retainedOwner};
			const actual = encodeCanonical(future).byteLength;
			const exactBound = execute<number>(`return ${terms[0]!.getText(rollback)};`, {
				retainedInventory, retainedOwner, coldSnapshotInventoryWidths: [actual],
				maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
				maximumWidth: (values: number[]) => Math.max(...values),
			});
			expect(exactBound).toBeGreaterThanOrEqual(actual);
			const zero = {byteLength: 0}, sum = (...values: number[]) => values.reduce((a, b) => a + b, 0);
			const common = {runtimeEnvelope: 0, runtimeEnvelopeTerm: 0, signingPhysical: 0, signingPhysicalTerm: 0,
				journal: {canonicalRowByteLengthsTotal: 0}, nativeProgress: zero, journalPlan: zero, snapshotWrapper: zero,
				futureInventory: {byteLength: actual}, protectedHeaders: zero, journalHeaders: zero, floorPoint: zero,
				aheControl: zero, classifier: 0, classifierTerm: 0, summarySource: zero, journalRawSupplement: 0,
				inputNumber: (_key: string, value: number) => value, width: (value: typeof zero) => value.byteLength,
				sum, compiler: {sum}};
			const bounded = execute<number[]>(`const ${scalar.getText(rollback)};const ${program.getText(rollback)};return [rawSourcePhysical,rawSourcePhysicalTerm];`, common);
			expect(bounded).toEqual([actual, actual]);
		}
	});
	it("retains the original full native/source/union brackets and the independent observer for actual effects", async () => {
		const boundary = find((node): node is ts.TryStatement => ts.isTryStatement(node) &&
			node.tryBlock.statements.some(statement => ts.isIfStatement(statement) &&
				statement.expression.getText(rollback) === "unchangedSnapshotReadback === undefined"));
		for (const noEffect of [false, true]) {
			const calls: string[] = [], head = {}, floor = {}, roles = {head, floor: {stable: floor}};
			const result = execute<Promise<void>>(`return (async () => {let readbackFailure;${boundary.getText(rollback)}\nif(readbackFailure !== undefined) throw readbackFailure;})();`, {
				unchangedSnapshotReadback: noEffect ? {} : undefined,
				checkNativeReservations: async () => {calls.push("native");}, lifetime: {check: async () => {calls.push("lifetime");}},
				checkHeldCurrent: async () => {calls.push("source");}, closeUnion: {check: async () => {calls.push("union");}},
				observeCreatorProtectedRecoveryRoles: async () => {calls.push("full-observer"); return {ok: true, observation: {}};},
				resolveCreatorProtectedRecoveryRoleObservation: () => ({pending: null, head, floor: {stable: floor}}),
				sameRoleHead: (a: object, b: object) => a === b, sameFloor: (a: object, b: object) => a === b,
				roleInput: {}, roles, requireLaw: law, RoleRefusal: Error,
			});
			await result; expect(calls).toEqual(["native", "lifetime", "source", "union", ...(noEffect ? [] : ["full-observer"])]);
		}
		const verification = find((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(rollback) === "unchangedSnapshotReadback !== undefined");
		const finalSource = reconcile.getText(rollback).indexOf("retirementSource = Object.freeze");
		expect(verification.pos).toBeLessThan(reconcile.pos + finalSource);
		expect(reconcile.getText(rollback).slice(verification.end - reconcile.pos, finalSource)).toContain("await closeUnion.check();");
	});
});

describe("readiness-owned recovery source acquisition", () => {
	it("enrolls only reconciliation's genuine current journal observation after every original RAW charge", () => {
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const fn = rollback.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileSnapshotRecoveryRoles");
		let enrollment: ts.ExpressionStatement | undefined;
		function visit(node: ts.Node): void {
			if (ts.isExpressionStatement(node) && node.getText(rollback) === "lifetime.enrollCurrentJournalObservation?.(journal.value);") enrollment = node;
			ts.forEachChild(node, visit);
		}
		if (fn !== undefined) visit(fn);
		if (enrollment === undefined || !ts.isBlock(enrollment.parent)) throw Error("missing original reconciliation journal enrollment");
		const statements = enrollment.parent.statements, offset = statements.indexOf(enrollment), charge = statements[offset - 1];
		if (charge === undefined || !ts.isForOfStatement(charge) || !charge.getText(rollback).includes("sourceFrame.accounting.charge"))
			throw Error("journal enrollment no longer follows original RAW charge loop");
		const js = ts.transpileModule(`${charge.getText(rollback)}\n${enrollment.getText(rollback)}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		for (const declineAt of [-1, 0, 3, 4]) {
			const calls: unknown[] = [], row = Uint8Array.of(1), current = {canonicalRows: [row], carriers: [Uint8Array.of(2)]},
				old = {canonicalRows: [Uint8Array.of(3)], carriers: [Uint8Array.of(4)]}, snapshotImage = {native: "snapshot"};
			const run = () => new Function("sourceFrame", "journal", "journalProof", "snapshotImage", "lifetime", "closedJournalNativeControlCarriers", "closedRetirementBytes", "requireLaw", js)(
				{accounting: {charge: (bytes: Uint8Array) => {const index = calls.length; calls.push(bytes); return index !== declineAt;}}},
				{value: current}, old, snapshotImage, {enrollCurrentJournalObservation: (observation: object) => {calls.push(observation);}},
				(value: typeof current) => value.carriers, encodeCanonical,
				(ok: boolean, kind: string) => {if (!ok) throw Error(kind);});
			if (declineAt === -1) {
				expect(run).not.toThrow();
				expect(calls).toEqual([row, ...old.canonicalRows, ...current.carriers, ...old.carriers, encodeCanonical(snapshotImage), current]);
				expect(calls.at(-1)).toBe(current); // Never the mechanically reconstructed OLD image.
			} else {
				expect(run).toThrow("proof-budget-exceeded"); expect(calls).not.toContain(current);
			}
		}
	});

	it("keeps the original cross-kind role ambiguity guard inside the complete protected acquisition before authentication", () => {
		// Run the actual protected-image boundary and original strict guard.
		// Native lineage/authentication are controlled premises, not supplied by
		// these syntactically well-formed candidate bytes.
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const acquire = rollback.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "acquireClosedData");
		let boundary: ts.IfStatement | undefined;
		function visit(node: ts.Node): void {
			if (ts.isIfStatement(node) && node.expression.getText(rollback) === "protectedUnion" &&
				node.getText(rollback).includes("selectProtectedRoleImage")) boundary = node;
			ts.forEachChild(node, visit);
		}
		if (acquire !== undefined) visit(acquire);
		const declarations = ["view", "strictRoleControls"].map(name => rollback.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === name));
		const kinds = rollback.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
			ts.isIdentifier(declaration.name) && declaration.name.text === "roleControlKinds"));
		if (boundary === undefined || kinds === undefined || declarations.some(value => value === undefined)) throw Error("missing original protected-role syntax boundary");
		const js = ts.transpileModule(`${kinds.getText(rollback)}\n${declarations.map(node => node!.getText(rollback)).join("\n")}\n` +
			`let protectedImage,rows;const protectedUnion=true,wholeFloor={ok:true,state:{}},input={objectId:"room"},parsing=undefined;\n` +
			`${boundary.getText(rollback)}\nreturn rows;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		class RoleRefusal extends Error {constructor(readonly result: {kind: string}) {super(result.kind);}}
		for (const role of ["current", "pending"] as const) for (const conflict of [false, true]) {
			const records = [{kind: "v3-live-generation-2", epoch: 3}, ...(conflict ? [{kind: "v3-live-generation-1", epoch: 3}] : [])];
			const blobs = records.map((value, index) => {const bytes = encodeCanonical(value); return {bytes, ref: {digest: String(index), byteLength: bytes.byteLength}};});
			const row = {generationId: "generation", closure: blobs.map(blob => blob.ref)},
				support = {generationId: "support", closure: []}, support2 = {generationId: "support-2", closure: []},
				reader = {generations: [row, support, support2], blobs};
			const run = () => new Function("reader", "selectProtectedRoleImage", "canonicalCreatorDataRecord", "requireLaw", "RoleRefusal", "roleFailure", js)(reader,
				() => ({currentRows: role === "current" ? [row, support] : [support, support2], pendingRows: role === "pending" ? [row] : []}), decodeCanonical,
				(value: unknown) => {if (!value) throw Error("invalid native source");}, RoleRefusal, (kind: string) => ({kind}));
			if (conflict) expect(run).toThrow("role-ambiguous"); else expect(run).not.toThrow();
		}
	});

	it("uses the genuine same-head pair only to select custody, then authenticates one complete source under every native exclusion", async () => {
		const f = readinessRecoveryAcquisition();
		await expect(f.run()).resolves.toBe(false); // No terminal retirement is claimed by this prefix fixture.
		expect(f.calls).not.toContain("preliminary"); expect(f.fullArguments).toHaveLength(1);
		const full = f.calls.indexOf("full");
		expect(f.calls).not.toContain("roles"); // Same full source owns authentication; no duplicate point-role acquisitions.
		for (const owner of ["header", "ahe", "issuer", "floor"]) {
			expect(f.calls.indexOf(`acquire:${owner}`)).toBeGreaterThan(f.calls.indexOf("resolve:hold"));
			expect(f.calls.indexOf(`acquire:${owner}`)).toBeLessThan(full);
		}
		expect(f.calls.indexOf("borrow:header")).toBeLessThan(full);
		for (const owner of ["ahe", "borrowed-header", "issuer", "floor"])
			expect(f.calls.indexOf(`check:${owner}`)).toBeLessThan(full);
		expect(f.calls.filter(call => call === "check:lifetime")).toHaveLength(2);
		expect(f.fullArguments[0]).toEqual([f.input, undefined, undefined, true, f.closeHold, undefined, false, undefined, true, f.borrowedHeader]);
		expect(f.calls.indexOf("sealed-census")).toBeGreaterThan(full);
		expect(f.calls.filter(call => call === "check:union")).toHaveLength(1); // Still the original full protected-union check.
		expect(f.calls.filter(call => call === "release:full")).toHaveLength(1);
		for (const owner of ["lifetime", "header", "borrowed-header", "ahe", "issuer", "floor"])
			expect(f.calls.filter(call => call === `release:${owner}`)).toHaveLength(1);
	});

	it("refuses copied or wrong-head trust and missing/foreign close custody before native acquisition", async () => {
		for (const invalid of ["copy", "object", "epoch", "anchor", "genesis", "missing-hold", "foreign-hold", "revoked-hold"]) {
			const f = readinessRecoveryAcquisition();
			if (invalid === "object") f.trust.objectId = "other";
			if (invalid === "epoch") f.trust.currentEpoch++;
			if (invalid === "anchor") f.trust.currentAnchorDigest = "other";
			if (invalid === "genesis") f.trust.genesisAnchorDigest = "other";
			if (invalid === "revoked-hold") f.state.validHold = false;
			const task = invalid === "missing-hold" ? f.runWithoutHold() : f.run(invalid === "copy" ? {...f.trust} : f.trust,
				invalid === "foreign-hold" ? {} : f.closeHold);
			await expect(task).rejects.toThrow();
			expect(f.calls.some(call => call.startsWith("acquire:"))).toBe(false);
			expect(f.calls).not.toContain("preliminary"); expect(f.calls).not.toContain("full");
		}
	});

	it("refuses failed complete authentication without accepting the live trust as source authority, and retains standalone recensus", async () => {
		const f = readinessRecoveryAcquisition(); f.state.fullFailure = true;
		await expect(f.run()).rejects.toThrow("chain-invalid");
		expect(f.calls).not.toContain("roles"); expect(f.calls).not.toContain("acquire:union");
		expect(f.calls).toContain("release:header"); expect(f.calls).toContain("release:issuer"); expect(f.fullArguments).toHaveLength(1);
		const standalone = readinessRecoveryAcquisition(); standalone.state.staleRecensus = true;
		await expect(standalone.runLegacy()).rejects.toThrow("floor-stale");
		expect(standalone.calls.filter(call => call === "roles")).toHaveLength(2);
		expect(standalone.calls).not.toContain("full"); expect(standalone.calls).toContain("release:preliminary");
	});

	it("binds the same complete protected source to every owner, exact genesis bytes, whole floor and actual native head", async () => {
		for (const invalid of ["complete", "store", "snapshots", "journal", "floor-owner", "catalog", "object", "genesis", "pin-bytes", "pending", "floor", "head", "profile"]) {
			const f = readinessRecoveryAcquisition();
			f.recoveryFrame.input = {...f.input};
			if (invalid === "complete") f.recoveryFrame.wholeCensus = undefined;
			const keys: Record<string, string> = {store: "store", snapshots: "snapshotStore", journal: "liveJournalStore", "floor-owner": "roomHeadAuthority", catalog: "catalog"};
			if (keys[invalid]) f.recoveryFrame.input[keys[invalid]!] = {};
			if (invalid === "object") f.recoveryFrame.input.objectId = "foreign";
			if (invalid === "genesis") f.recoveryFrame.input.pinnedGenesisAnchorDigest = "foreign";
			if (invalid === "pin-bytes") f.recoveryFrame.input.exactCanonicalPinnedGenesisTrustStateRecordBytes = Uint8Array.of(2);
			if (invalid === "pending") f.recoveryFrame.wholeFloor = {...f.roles.floor, pending: {}};
			if (invalid === "floor") f.recoveryFrame.wholeFloor = {...f.roles.floor, stable: {...f.roles.floor.stable, currentAnchorDigest: "foreign"}};
			if (invalid === "head") f.reader.head = {...f.roles.head, revision: 2};
			if (invalid === "profile") f.observations.get(f.fullToken).summary.profileId = "foreign";
			await expect(f.run()).rejects.toThrow();
			expect(f.calls).not.toContain("roles"); expect(f.fullArguments).toHaveLength(1);
			expect(f.calls).toContain("check:union"); expect(f.calls).toContain("release:full");
			for (const owner of ["lifetime", "header", "borrowed-header", "ahe", "issuer", "floor"])
				expect(f.calls.filter(call => call === `release:${owner}`)).toHaveLength(1);
		}
	});

	it("requires the fully authenticated result's latest source and complete current-head identity to match", async () => {
		for (const invalid of ["missing", "closed-epoch", "successor-epoch", "successor-anchor", "object", "epoch", "anchor", "genesis", "profile"]) {
			const f = readinessRecoveryAcquisition(), latest = f.fullMaterial.sources[0]!;
			if (invalid === "missing") f.fullMaterial.sources = [];
			if (invalid === "closed-epoch") latest.closedEpoch--;
			if (invalid === "successor-epoch") latest.successorEpoch--;
			if (invalid === "successor-anchor") latest.successorAnchorDigest = "other";
			if (invalid === "object") f.fullMaterial.currentTrust.objectId = "other";
			if (invalid === "epoch") f.fullMaterial.currentTrust.currentEpoch--;
			if (invalid === "anchor") f.fullMaterial.currentTrust.currentAnchorDigest = "other";
			if (invalid === "genesis") f.fullMaterial.currentTrust.genesisAnchorDigest = "other";
			if (invalid === "profile") f.fullMaterial.currentTrust.profileId = "other";
			await expect(f.run()).rejects.toThrow("chain-invalid");
			expect(f.fullArguments).toHaveLength(1); expect(f.calls).not.toContain("acquire:union");
			expect(f.calls.filter(call => call === "release:full")).toHaveLength(1);
			expect(f.calls).toContain("release:header"); expect(f.calls).toContain("release:floor");
		}
	});

	it("refuses missing, foreign or dead private source owners and absent source-only callbacks before opening the union", async () => {
		for (const invalid of ["observation", "forward", "reader", "owner", "dead", "material", "callback"]) {
			const f = readinessRecoveryAcquisition();
			if (invalid === "observation") f.observations.delete(f.fullToken);
			if (invalid === "forward") f.observations.set(f.fullToken, {});
			if (invalid === "reader") f.observations.set(f.fullToken, {forward: {reader: {}}});
			if (invalid === "owner") f.frames.delete(f.reader);
			if (invalid === "dead") f.recoveryOwner.alive = false;
			if (invalid === "material") f.recoveryOwner.forwardMaterial = {...f.fullMaterial};
			if (invalid === "callback") f.recoveryOwner.checkRecoverySourceCurrent = undefined;
			await expect(f.run()).rejects.toThrow("snapshot-unavailable");
			expect(f.fullArguments).toHaveLength(1); expect(f.calls).not.toContain("acquire:union");
			expect(f.calls.filter(call => call === "release:full")).toHaveLength(1);
			for (const owner of ["lifetime", "header", "borrowed-header", "ahe", "issuer", "floor"])
				expect(f.calls.filter(call => call === `release:${owner}`)).toHaveLength(1);
		}
	});

	it("retains the independent full protected-union refusal with a genuine live source-only owner", async () => {
		const f = readinessRecoveryAcquisition(); f.state.unionFailure = true;
		await expect(f.run()).rejects.toThrow("full union revoked");
		expect(f.calls.filter(call => call === "check:union")).toHaveLength(1);
		expect(f.calls).not.toContain("summary"); expect(f.calls).toContain("release:full");
		expect(f.calls).toContain("release:header"); expect(f.calls).toContain("release:lifetime");
	});

	it("joins owned header cleanup after partial acquisition and propagates uncertain release instead of reporting completion", async () => {
		const partial = readinessRecoveryAcquisition(); partial.state.failAcquire = "ahe";
		await expect(partial.run()).rejects.toThrow("snapshot-unavailable");
		expect(partial.calls).toContain("release:header"); expect(partial.calls).toContain("release:lifetime");
		expect(partial.calls).not.toContain("full");
		const f = readinessRecoveryAcquisition(); let release!: () => void, entered!: () => void, settled = false;
		const waiting = new Promise<void>(resolve => {entered = resolve;}); f.state.headerReleaseEntered = entered;
		f.state.releaseGate = new Promise<void>(resolve => {release = resolve;}); f.state.failRelease = "header";
		const task = f.run().finally(() => {settled = true;});
		// Reaching the release gate proves the full acquire/cleanup prefix ran;
		// no sleep or unjoined native work is introduced by this fixture.
		await waiting;
		expect(settled).toBe(false); release();
		await expect(task).rejects.toThrow("release failed:header");
	});

	it("preserves preliminary discovery and independent full acquisition for callers without readiness trust", async () => {
		const f = readinessRecoveryAcquisition(); await expect(f.runLegacy()).resolves.toBe(false);
		expect(f.calls.indexOf("preliminary")).toBeLessThan(f.calls.indexOf("acquire:ahe"));
		expect(f.calls).not.toContain("nominal"); expect(f.calls).not.toContain("acquire:header");
		expect(f.calls).toContain("check:preliminary"); expect(f.fullArguments).toHaveLength(1);
		expect(f.calls.filter(call => call === "release:preliminary")).toHaveLength(1);
		expect(f.calls.filter(call => call === "release:full")).toHaveLength(1);
	});

	it("forwards the exact optional readiness trust through the original public reconciliation wrapper", async () => {
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const fn = rollback.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileCreatorSnapshotRecoveryRoles");
		if (!fn) throw Error("missing original public reconciliation wrapper");
		const calls: unknown[][] = [], input = {}, hold = {}, trust = {currentEpoch: 3};
		const js = ts.transpileModule(`${fn.getText(rollback).replace(/^export\s+/, "")}\nreturn reconcileCreatorSnapshotRecoveryRoles;`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const reconcile = new Function("reconcileSnapshotRecoveryRoles", js)(async (...args: unknown[]) => {calls.push(args); return false;});
		await expect(reconcile(input, hold, true, true, trust)).resolves.toBe("complete");
		expect(calls[0]).toEqual([input, hold, true, true, trust]); expect(calls[0]![4]).toBe(trust);
		await expect(reconcile(input, hold)).resolves.toBe("complete");
		expect(calls[1]).toEqual([input, hold, false, false, undefined]);
	});
});

describe("original joined readiness job metadata ordering", () => {
	it("passes the live sealing owner's exact trust and fresh close hold without enabling readiness-only acknowledgments", async () => {
		const close = ts.createSourceFile("close.ts", readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const calls: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
				node.expression.text === "reconcileCreatorBoundedRecoveryMaintenance" &&
				node.getText(close).includes("priorCutRecord")) calls.push(node);
			ts.forEachChild(node, visit);
		};
		visit(close); expect(calls).toHaveLength(1);
		for (const recoveryRoles of [undefined, {}]) {
			const trust = {}, hold = {}, registration = {currentTrust: trust,
				sealRecoveryDependencies: async (inherited: boolean) => {expect(inherited).toBe(recoveryRoles !== undefined); return hold;}},
				input = {}, actor = {}, capacity = {value: {generations: [{}, {}]}};
			const js = ts.transpileModule(`return ${calls[0]!.getText(close)};`,
				{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			const invoke = new Function("registration", "input", "actor", "capacity", "priorCutRecord", "reconcileCreatorBoundedRecoveryMaintenance", js);
			await invoke(registration, input, actor, capacity, {recoveryRoles}, async (...args: unknown[]) => {
				expect(args.slice(0, 4)).toEqual([registration, input, actor, 2]);
				expect(args.slice(5)).toEqual([false, false, trust]);
				expect(await (args[4] as () => Promise<object>)()).toBe(hold);
			});
		}
	});

	it("cannot substitute inherited-classification progress for terminal cross-store reconstruction", async () => {
		const rollback = ts.createSourceFile("rollback.ts", readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const fn = rollback.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileSnapshotRecoveryRoles");
		if (!fn) throw Error("missing original cross-store reconciliation");
		let inheritedEffects = 0;
		const input = {objectId: "room", snapshotStore: {
			captureRecoveryRoleInventory: async () => ({owner: {migration: "classification-required"}}),
			reconcileRecoveryRoles: async () => undefined,
		}};
		const bindings = {capture: () => input, checkAbort: () => undefined,
			bindMethod: (owner: any, key: string) => owner[key].bind(owner), snapshotCall: (job: () => Promise<unknown>) => job(),
			requireLaw: (value: unknown, kind: string) => {if (!value) throw Error(kind);},
			reconcileInheritedSnapshotRecoveryRoles: async () => {inheritedEffects++;}};
		const js = ts.transpileModule(`${fn.getText(rollback)}\nreturn reconcileSnapshotRecoveryRoles;`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const reconcile = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		await expect(reconcile({}, undefined, true, true)).rejects.toThrow("snapshot-unavailable");
		expect(inheritedEffects).toBe(0); // Refuse before unrelated effects, without clearing the recovery halt.
		await expect(reconcile({}, undefined, true, false)).resolves.toBe(false);
		expect(inheritedEffects).toBe(1); // Original non-reconstruction classification path is unchanged.
	});

	it("delivers terminal completion only after the original bounded verifier finishes every fresh-summary pass", async () => {
		const close = ts.createSourceFile("close.ts", readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const fn = close.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileCreatorBoundedRecoveryMaintenance");
		if (!fn) throw Error("missing original bounded reconciliation");
		for (const outcomes of [["fresh-summary-required", "complete"], ["fresh-summary-required", "fresh-summary-required"], ["native-error"]]) {
			const trust = {objectId: "room", currentEpoch: 3, currentAnchorDigest: "anchor"};
			const calls: unknown[] = [], actor = {captureRetirementOwners: () => ({acquireEvidence: async () => ({
				readExactCanonicalRows: () => [], check: async () => {calls.push("check");}, release: async () => {calls.push("release");},
			})})};
			const bindings = {decodeCanonical, reconcileCreatorSnapshotRecoveryRoles: async (_: unknown, _hold: unknown, ack: boolean, strict: boolean, currentTrust?: object) => {
				calls.push([ack, strict, currentTrust]); const next = outcomes.shift(); if (next === "native-error") throw Error("native verifier refused"); return next;
			}};
			const js = ts.transpileModule(`${fn.getText(close)}\nreturn reconcileCreatorBoundedRecoveryMaintenance;`,
				{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			const reconcile = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
			const success = outcomes.includes("complete"), task = reconcile({objectId: "room"}, {promotionContext: {}}, actor, 0,
				async () => {calls.push("seal"); return {};}, true, true, trust);
			if (success) await expect(task).resolves.toBe("complete"); else await expect(task).rejects.toThrow();
			expect(calls.slice(0, 2)).toEqual(["check", "release"]);
			expect(calls.filter(Array.isArray).every(args => args[0] === true && args[1] === true && args[2] === trust)).toBe(true);
		}
	});

	it("requires terminal closed-workflow verification specifically for completed-retirement reconstruction", async () => {
		for (const completedRecovery of [false, true]) {
			const f = closeReadinessJob({epoch: 3, window: true, completedRecovery}); await f.run();
			expect(f.completionModes).toEqual(completedRecovery ? [true] : []); expect(f.ready()).toBe(true);
		}
	});
	it("certifies the complete later-epoch window instead of unconditionally rewriting retirement frontiers", async () => {
		for (const [epoch, window] of [[0, true], [2, true], [3, false], [3, true], [4, true]] as const) {
			const f = closeReadinessJob({epoch, window}); await f.run();
			expect(f.calls).toEqual([...(epoch >= 3 && window ? ["generations", "retirement", "snapshots"] : []),
				"metadata", "metadata-joined", "capture"]);
			expect(f.ready()).toBe(true); expect(f.jobs.size).toBe(0);
		}
	});
	it("keeps original maintenance mandatory for unfinished recovery", async () => {
		for (const pressure of [{activeIntent: true}, {recoveryRequired: true}]) {
			const f = closeReadinessJob({epoch: 3, window: true, ...pressure}); await f.run();
			expect(f.calls).toEqual(["generations", "retirement", "snapshots", "boundary", "generations", "reconcile", "seal", "boundary-joined",
				"metadata", "metadata-joined", "capture"]);
			expect(f.ready()).toBe(true); expect(f.jobs.size).toBe(0);
		}
	});
	it("allows native pool pressure only through a complete certified CURRENT-and-finishing window", async () => {
		for (const pressure of [{generationCount: 6}, {recoveryScopes: 4}]) {
			const fit = closeReadinessJob({epoch: 3, window: true, ...pressure}); await fit.run();
			expect(fit.calls).not.toContain("boundary"); expect(fit.ready()).toBe(true);
			const refused = closeReadinessJob({epoch: 3, window: true, ...pressure, certified: [false, true]}); await refused.run();
			expect(refused.calls.filter(call => call === "reconcile")).toHaveLength(1);
			expect(refused.calls.filter(call => call === "capture")).toHaveLength(2); expect(refused.ready()).toBe(true);
		}
	});
	it("joins an inconclusive window then uses original maintenance and a new complete capture", async () => {
		const f = closeReadinessJob({epoch: 3, window: true, prepared: [false, true]}); await f.run();
		expect(f.calls).toEqual(["generations", "retirement", "snapshots", "metadata", "metadata-joined", "capture",
			"boundary", "generations", "reconcile", "seal", "boundary-joined", "metadata", "metadata-joined", "capture"]);
		expect(f.ready()).toBe(true); expect(f.completionModes).toEqual([false]); expect(f.jobs.size).toBe(0);
	});
	it("does not confuse a compiled resource program with a certified finishing reserve", async () => {
		const f = closeReadinessJob({epoch: 3, window: true, certified: [false, true]}); await f.run();
		expect(f.calls.filter(call => call === "reconcile")).toHaveLength(1);
		expect(f.calls.filter(call => call === "capture")).toHaveLength(2);
		expect(f.ready()).toBe(true);
	});
	it("does not publish a finishing window if exact preparation remains inconclusive after maintenance", async () => {
		const f = closeReadinessJob({epoch: 3, window: true, prepared: [false, false]}); await f.run();
		expect(f.ready()).toBe(false); expect(f.jobs.size).toBe(0);
		expect(f.calls.filter(call => call === "reconcile")).toHaveLength(1);
		expect(f.calls.filter(call => call === "capture")).toHaveLength(2);
	});

	it("stops admission of fresh maintenance passes after original readiness revocation", async () => {
		let f!: ReturnType<typeof closeReadinessJob>;
		f = closeReadinessJob({epoch: 3, window: true, recoveryRequired: true, reconcile: async seal => {
			await seal(); f.stop(); await seal();
		}});
		await expect(f.run()).rejects.toThrow("admission was revoked");
		expect(f.calls).toEqual(["generations", "retirement", "snapshots", "boundary", "generations", "reconcile", "seal"]);
		expect(f.ready()).toBe(false); expect(f.jobs.size).toBe(0);
	});

	it("joins metadata before cold capture and withholds capture if readiness is revoked meanwhile", async () => {
		for (const revoke of [false, true]) {
			let release!: () => void, entered!: () => void;
			const gate = new Promise<void>(resolve => {release = resolve;}), waiting = new Promise<void>(resolve => {entered = resolve;});
			const f = closeReadinessJob({metadata: async () => {entered(); await gate;}}), task = f.run();
			await waiting; expect(f.calls).toEqual(["metadata"]); expect(f.jobs.size).toBe(1); expect(f.ready()).toBe(false);
			if (revoke) f.stop(); release();
			if (revoke) {await expect(task).rejects.toThrow("admission was revoked"); expect(f.calls).not.toContain("capture");}
			else {await task; expect(f.calls).toEqual(["metadata", "metadata-joined", "capture"]); expect(f.ready()).toBe(true);}
			expect(f.jobs.size).toBe(0);
		}
	});

	it("does not add native metadata requirements when optional readiness capture is unsupported", async () => {
		const f = closeReadinessJob({supported: false}); await f.run();
		expect(f.calls).toEqual(["capture"]); expect(f.ready()).toBe(false);
	});
});

// The original room barrier bodies, with controlled lifecycle/storage owners.
// This proves wiring/order, not actual native retirement or readiness capacity.
const roomSource = readFileSync(new URL("../src/v3-room.ts", import.meta.url), "utf8");
const roomTree = ts.createSourceFile("room.ts", roomSource, ts.ScriptTarget.Latest, true);
function roomVariable(name: string): string {
	const matches: ts.VariableStatement[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
			ts.isIdentifier(declaration.name) && declaration.name.text === name)) matches.push(node);
		ts.forEachChild(node, visit);
	}
	visit(roomTree);
	if (matches.length !== 1) throw new Error(`missing room boundary:${name}:${matches.length}`);
	return matches[0]!.getText(roomTree);
}
function roomBoundary(options: {profile?: string; receiveOnly?: boolean; prepare?: (plane: object) => Promise<void>} = {}) {
	const calls: string[] = [], plane = {};
	const body = `
	 const input={receiveOnly:options.receiveOnly??false};
	 const settlementProfile=options.profile??"v1",sourceMaterial=undefined;
	 const selectRoomStartup=()=>"genesis";
	 let activeHandle=plane,creatorCloseHandle={},terminalFailure,closed=false;
	 const enqueueLifetimeTransition=job=>{calls.push("enqueue");return Promise.resolve().then(job);};
	 const waitForRetainedBootstrap=async()=>{calls.push("bootstrap");};
	 const publishAccepted=async()=>{calls.push("publish");};
	 const drainRebaseOutbox=async()=>{calls.push("drain");};
	 const shutdown=async()=>{calls.push("shutdown");closed=true;};
	 const combineFailures=(primary,cleanup)=>new AggregateError([primary,cleanup]);
	 const prepareCreatorOrdinaryReadiness=async current=>{calls.push("prepare");await options.prepare?.(current);};
	 ${roomVariable("prepareCurrentCreatorOrdinaryReadiness")}
	 ${roomVariable("rebasePromise")}
	 return {done:rebasePromise,swap:()=>{activeHandle={};},failure:()=>terminalFailure};
	`;
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return {plane, calls, ...new Function("options", "plane", "calls", js)(options, plane, calls)} as
		{plane: object; calls: string[]; done: Promise<void>; swap(): void; failure(): unknown};
}

describe("room explicit readiness boundary wiring", () => {
	it("joins preparation after startup publication/rebase and before the existing barrier resolves", async () => {
		let release!: () => void, entered!: () => void;
		const enteredPromise = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
		const observed: object[] = [];
		const room = roomBoundary({prepare: async plane => {observed.push(plane); entered(); await gate;}});
		let ready = false; void room.done.then(() => {ready = true;});
		await enteredPromise;
		expect(room.calls).toEqual(["enqueue", "bootstrap", "publish", "drain", "prepare"]);
		expect(observed).toEqual([room.plane]); expect(ready).toBe(false);
		release(); await room.done; expect(ready).toBe(true);
	});

	it("prepares no-drain NONE startup explicitly without adding work to receive-only startup", async () => {
		const ordinary = roomBoundary({profile: "none"}); await ordinary.done;
		expect(ordinary.calls).toEqual(["enqueue", "prepare"]);
		const readOnly = roomBoundary({receiveOnly: true}); await readOnly.done;
		expect(readOnly.calls).toEqual([]);
	});

	it("withholds ready and follows the existing joined shutdown path if the target changes during preparation", async () => {
		const room = roomBoundary({prepare: async () => {room.swap();}});
		await expect(room.done).rejects.toThrow("ordinary readiness owner changed");
		expect(room.calls.at(-1)).toBe("shutdown");
		expect(room.failure()).toBeInstanceOf(TypeError);
	});
});
