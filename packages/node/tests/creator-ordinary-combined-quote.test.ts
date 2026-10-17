import {readFileSync} from "node:fs";
import {decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Controlled lexical owners test the actual private task and derivations. These
// fixtures confer no nominal proof, signature, native currency or paid credit.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
	const found = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found === undefined) throw new Error(`missing original composite seam: ${name}`);
	return found;
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}} = bindings;\n${js}`)(bindings) as T;
}
function gate() {
	let finish!: () => void;
	const promise = new Promise<void>(resolve => {finish = resolve;}); return {promise, finish};
}
function fixture() {
	const events: string[] = [], sourceHandle = {}, current = {}, sourceIdentity = {};
	// Actual exact-byte union/UNKNOWN accounting algorithm, with a small controlled
	// local ceiling. This is not a native proof or a production capacity policy.
	const createAccounting = execute<(blobs: readonly {bytes: Uint8Array}[]) => {
		readonly maxBytes: number; readonly chargedBytes: number; charge(bytes: Uint8Array): boolean;
		chargeUnknownEncodedLength(length: number): boolean}>(`
		${declaration("createCreatorClosedRollbackProofAccounting").getText(tree).replace(/^export /, "")}
		return createCreatorClosedRollbackProofAccounting;`, {
		CREATOR_ORDINARY_PROOF_MAX_BYTES: 4096, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 8192,
		proofMaterialOwners: new WeakMap(), compareBytes: (left: Uint8Array, right: Uint8Array) =>
			left.length === right.length && left.every((value, index) => value === right[index]) ? 0 : 1,
	});
	const accounting = createAccounting([{bytes: new Uint8Array(10)}]);
	const proof = {accounting: {get chargedBytes() {return accounting.chargedBytes;}, maxBytes: accounting.maxBytes,
		charge(bytes: Uint8Array) {events.push(`charge:known:${[...bytes]}`); return accounting.charge(bytes);},
		chargeUnknownEncodedLength(length: number) {events.push(`charge:UNKNOWN:${length}`); return accounting.chargeUnknownEncodedLength(length);}}};
	const frame = {alive: true, pending: new Set<Promise<unknown>>()}, callbackFailure = new Error("application-layout"), nativeFailure = new Error("original-native-failure");
	const state = {ownerAvailable: true, sourceAvailable: true, current: true, failCheck: 0, checks: 0, dimensions: 0, mathFailure: false,
		dimensionMiss: false, appMiss: false, settlementMiss: false, settlementCalls: 0, noneMiss: false, noneThrows: false, callbackThrows: false, advances: 0, commits: 0,
		onCallback: undefined as (() => void) | undefined, onCommit: undefined as (() => void) | undefined,
		onCheck: undefined as ((count: number) => Promise<void>) | undefined};
	const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index]) ? 0 : 1;
	const originalOperationBytes = encodeCanonical({action: "placeBlock"});
	const runtime = {
		resolveCurrentDimensions: (value: object) => state.current ? value : undefined,
		captureApplicationResourceCursor: () => ({}), readApplicationResourceDelta: () => [encodeCanonical({operation: {action: "placeBlock"}})],
	};
	const owner = {source: sourceHandle, frame, runtime,
		numerical: {} as {current?: Readonly<{unsignedBytes: Uint8Array; value: typeof current}>}, check: async () => {
		state.checks++; events.push(`complete:${state.checks}`);
		if (!state.ownerAvailable || !state.sourceAvailable || !frame.alive || state.failCheck === state.checks) throw nativeFailure;
		await state.onCheck?.(state.checks);
	}};
	const callback = () => {events.push("callback"); state.onCallback?.(); if (state.callbackThrows) throw callbackFailure;
		return state.appMiss ? undefined : {byteLength: 16, items: 4, maxDepth: 1};};
	const reader = Object.assign(callback, {createIncrementalProjection: () => undefined});
	const projection = {advance: () => {events.push("advance"); state.advances++; return true;}, quote: callback};
	const prior = {reader, create: reader.createIncrementalProjection, projection, cursor: {}, baseResources: []};
	const capacity: {application: unknown; template: unknown} = {application: prior, template: {kind: "old-program"}};
	const sourceFacts = {identity: sourceIdentity, capacity};
	const api = execute<(proof: object, unsignedBytes: Uint8Array, options: {reader: typeof reader; storageIncarnation: string; actualProducerChunkBytes: 131072}) =>
		Promise<{knownCarriers: readonly Uint8Array[]; unknownEncodedLengths: readonly number[]; fullFutureProofEnvelopeByteLengths: readonly number[]} | undefined>>(`
		${["creatorOrdinaryCurrentDimensionStampMatchesForSizing", "deriveCreatorOrdinaryApplicationResourceForSizing",
			"reserveCreatorOrdinaryFinishingCapacity"].map(name => declaration(name).getText(tree).replace(/^export /, "")).join("\n")}
		return reserveCreatorOrdinaryFinishingCapacity;`, {
		creatorOrdinaryIssuanceProofFacts: (value: object) => value === proof && state.ownerAvailable && frame.alive ? owner : undefined,
		creatorOrdinaryIssuanceSourceFacts: (value: object) => value === sourceHandle && state.sourceAvailable ? sourceFacts : undefined,
		captureCreatorOrdinaryCurrentDimensionsForSizing: (value: object, bytes: Uint8Array) => {
			expect(value).toBe(proof); events.push("dimensions"); state.dimensions++;
			if (state.mathFailure) throw new TypeError("dimension-layout");
			if (state.dimensionMiss) return undefined;
			return {proof, source: sourceHandle, frame, unsignedBytes: bytes, chargedBytes: proof.accounting.chargedBytes,
				proofFacts: owner, sourceFacts, current: Object.assign(current, {
					blueprint: {maxApplicationStateBytes: 128, maxItems: 128, maxDepth: 8},
					candidate: {exactCanonicalOperationBytes: originalOperationBytes}})};
		},
		creatorOrdinarySettlementCapacityFactsForSizing: (facts: unknown) => {state.settlementCalls++; return state.settlementMiss ? undefined : facts;},
		deriveCreatorOrdinaryFinishingCapacityForSizing: (facts: {applicationResource: {value: object}}, value: object, bytes: Uint8Array) => {
			events.push("none"); expect(value).toBe(proof); expect(facts.applicationResource.value).toEqual({byteLength: 16, items: 4, maxDepth: 1});
			if (state.noneThrows) throw new TypeError("unexpected-finishing-layout");
			if (state.noneMiss) return undefined;
			return {capacity: {knownCarriers: [bytes.slice()], unknownEncodedLengths: [64, 128], fullFutureProofEnvelopeByteLengths: [128, 8334, 256, 64]},
				commit: () => {events.push("template:commit"); state.onCommit?.(); state.commits++; capacity.template = {kind: "new-program"};}};
		},
		creatorOrdinaryApplicationResourceInput: () => ({catalog: {}, material: {exactCanonicalBaseStateBytes: [], candidateOperation: {action: "placeBlock"}}}),
		record: decodeCanonical, decodeCanonical, closedRetirementBytes: encodeCanonical, compareBytes: equal,
		Refusal: Error, failure: (code: string) => code,
	});
	const run = (bytes = Uint8Array.of(1, 2)) => api(proof, bytes, {reader, storageIncarnation: "current", actualProducerChunkBytes: 131072});
	return {events, proof, accounting, frame, state, capacity, prior, run, nativeFailure, sourceFacts, owner, current};
}

describe("one private ordinary quote delivery (controlled owners, no proof authority)", () => {
	it("runs the actual derivations between one fresh pre-callback and one complete final check", async () => {
		const f = fixture(), result = await f.run();
		expect(result?.fullFutureProofEnvelopeByteLengths).toEqual([128, 8334, 256, 64]);
		expect(f.events).toEqual(["complete:1", "dimensions", "advance", "callback", "none",
			"charge:known:1,2", "charge:UNKNOWN:64", "charge:UNKNOWN:128", "complete:2", "template:commit"]);
		expect(f.state.checks).toBe(2); expect(f.state.commits).toBe(1); expect(f.capacity.application).not.toBe(f.prior);
		expect(f.state.settlementCalls).toBe(1);
		expect(f.proof.accounting.chargedBytes).toBe(204); expect(f.frame.pending.size).toBe(0);
		expect(f.state.dimensions).toBe(1);
		expect(f.owner.numerical.current?.value).toBe(f.current);
		expect(f.owner.numerical.current?.unsignedBytes).toEqual(Uint8Array.of(1, 2));
	});

	it("publishes numerical data only after complete delivery and template commit, with detached candidate bytes", async () => {
		const f = fixture(), bytes = Uint8Array.of(1, 2), finalEntered = gate(), finalJoined = gate();
		f.owner.numerical.current = {unsignedBytes: Uint8Array.of(9), value: {}};
		f.state.onCheck = async count => {
			expect(f.owner.numerical.current).toBeUndefined();
			if (count === 2) {finalEntered.finish(); await finalJoined.promise;}
		};
		f.state.onCallback = () => {expect(f.owner.numerical.current).toBeUndefined();};
		f.state.onCommit = () => {expect(f.owner.numerical.current).toBeUndefined();};
		const task = f.run(bytes); bytes.fill(7);
		await finalEntered.promise;
		expect(f.state.dimensions).toBe(1); expect(f.state.commits).toBe(0);
		expect(f.owner.numerical.current).toBeUndefined();
		finalJoined.finish(); expect(await task).toBeDefined();
		expect(f.owner.numerical.current?.unsignedBytes).toEqual(Uint8Array.of(1, 2));
		expect(f.owner.numerical.current?.unsignedBytes).not.toBe(bytes);
		expect(f.owner.numerical.current?.value).toBe(f.current);
		expect(f.state.dimensions).toBe(1); expect(f.state.commits).toBe(1);
		expect(f.accounting.chargedBytes).toBe(204);
	});

	it("clears a previous numerical enrollment on a new miss, exception, stale context or native failure", async () => {
		for (const kind of ["dimensionMiss", "appMiss", "settlementMiss", "noneMiss", "mathFailure", "noneThrows", "runtime", "native"] as const) {
			const f = fixture(); expect(await f.run()).toBeDefined(); expect(f.owner.numerical.current).toBeDefined();
			if (kind === "runtime") f.state.onCallback = () => {f.state.current = false;};
			else if (kind === "native") f.state.failCheck = 4;
			else f.state[kind] = true;
			const result = await f.run().then(value => ({value}), error => ({error}));
			if (["dimensionMiss", "appMiss", "settlementMiss", "noneMiss"].includes(kind)) expect(result).toEqual({value: undefined});
			else expect(result).toHaveProperty("error");
			expect(f.owner.numerical.current, kind).toBeUndefined();
			expect(f.state.dimensions, kind).toBe(2); expect(f.state.commits, kind).toBe(1);
			expect(f.frame.pending.size, kind).toBe(0);
		}
	});

	it("charges the original exact KNOWN union and every UNKNOWN occurrence on repeated calls", async () => {
		const f = fixture(); expect(await f.run()).toBeDefined(); expect(await f.run()).toBeDefined();
		expect(f.accounting.chargedBytes).toBe(10 + 2 + 2 * (64 + 128));
		expect(f.events.filter(event => event.startsWith("charge:"))).toEqual([
			"charge:known:1,2", "charge:UNKNOWN:64", "charge:UNKNOWN:128",
			"charge:known:1,2", "charge:UNKNOWN:64", "charge:UNKNOWN:128"]);
		expect(f.state.checks).toBe(4); expect(f.state.commits).toBe(2);
	});

	it("permits exact saturation and refuses KNOWN or UNKNOWN exhaustion without refund or early commit", async () => {
		const exact = fixture(); expect(exact.accounting.chargeUnknownEncodedLength(exact.accounting.maxBytes - 204)).toBe(true);
		expect(await exact.run()).toBeDefined(); expect(exact.accounting.chargedBytes).toBe(exact.accounting.maxBytes);
		for (const kind of ["known", "UNKNOWN"] as const) {
			const f = fixture();
			expect(f.accounting.chargeUnknownEncodedLength(f.accounting.maxBytes - 10 - (kind === "known" ? 0 : 2))).toBe(true);
			await expect(f.run()).rejects.toThrow("creator incremental proof reserve is exhausted");
			expect(f.accounting.chargedBytes).toBe(f.accounting.maxBytes);
			expect(f.state.checks).toBe(2); expect(f.state.commits).toBe(0); expect(f.frame.pending.size).toBe(0);
			expect(f.capacity.application).toBeUndefined(); expect(f.capacity.template).toEqual({kind: "old-program"});
		}
	});

	it("joins final native currency after a charge refusal and lets native failure retain precedence", async () => {
		const f = fixture(), entered = gate(), joined = gate();
		expect(f.accounting.chargeUnknownEncodedLength(f.accounting.maxBytes - 10)).toBe(true);
		f.state.onCheck = async count => {if (count === 2) {entered.finish(); await joined.promise; throw f.nativeFailure;}};
		let delivered = false; const task = f.run().then(value => {delivered = true; return value;}, error => {delivered = true; return error;});
		await entered.promise; expect(delivered).toBe(false); expect(f.frame.pending.size).toBe(1); expect(f.state.commits).toBe(0);
		joined.finish(); expect(await task).toBe(f.nativeFailure); expect(f.frame.pending.size).toBe(0);
		expect(f.accounting.chargedBytes).toBe(f.accounting.maxBytes); expect(f.capacity.application).toBeUndefined();
	});

	it("refuses an unexpected post-charge book change during final currency without installing cells", async () => {
		const f = fixture(); f.state.onCheck = async count => {if (count === 2) f.accounting.chargeUnknownEncodedLength(1);};
		await expect(f.run()).rejects.toThrow("snapshot-unavailable");
		expect(f.accounting.chargedBytes).toBe(205); expect(f.state.commits).toBe(0); expect(f.capacity.application).toBeUndefined();
		expect(f.capacity.template).toEqual({kind: "old-program"}); expect(f.frame.pending.size).toBe(0);
	});

	it("does not expose a result or install app/template cells while complete delivery is pending", async () => {
		const f = fixture(), checking = gate(), complete = gate(); let delivered = false;
		f.state.onCheck = async count => {if (count === 2) {checking.finish(); await complete.promise;}};
		const task = f.run().then(value => {delivered = true; return value;});
		await checking.promise;
		expect(delivered).toBe(false); expect(f.capacity.application).toBeUndefined(); expect(f.capacity.template).toEqual({kind: "old-program"});
		expect(f.accounting.chargedBytes).toBe(204);
		expect(f.state.commits).toBe(0); expect(f.frame.pending.size).toBe(1);
		const joined = Promise.all([...f.frame.pending]); complete.finish(); await joined; expect(await task).toBeDefined();
		expect(delivered).toBe(true); expect(f.frame.pending.size).toBe(0);
	});

	it("owes complete final currency on dimension, application and finishing soft misses", async () => {
		for (const kind of ["dimensionMiss", "appMiss", "settlementMiss", "noneMiss"] as const) {
			const f = fixture(); f.state[kind] = true;
			expect(await f.run(), kind).toBeUndefined(); expect(f.state.checks, kind).toBe(2);
			expect(f.state.commits).toBe(0); expect(f.capacity.application).toBeUndefined();
			expect(f.capacity.template).toEqual({kind: "old-program"}); expect(f.frame.pending.size).toBe(0);
		}
	});

	it("runs no callback or arithmetic when the original complete pre-check rejects", async () => {
		const f = fixture(); f.state.failCheck = 1;
		await expect(f.run()).rejects.toBe(f.nativeFailure);
		expect(f.events).toEqual(["complete:1"]); expect(f.state.advances).toBe(0); expect(f.state.commits).toBe(0);
		expect(f.frame.pending.size).toBe(0);
	});

	it("rejects unavailable or already-revoked private owners without scheduling callbacks", async () => {
		for (const kind of ["ownerAvailable", "sourceAvailable"] as const) {
			const f = fixture(); f.state[kind] = false;
			expect(await f.run()).toBeUndefined(); expect(f.events).toEqual([]); expect(f.frame.pending.size).toBe(0);
		}
		const f = fixture(); f.frame.alive = false; expect(await f.run()).toBeUndefined(); expect(f.events).toEqual([]);
	});

	it("invalidates a mutable advanced projection on final native failure and preserves that fatal error", async () => {
		const f = fixture(); f.state.failCheck = 2;
		await expect(f.run()).rejects.toBe(f.nativeFailure); expect(f.state.advances).toBe(1);
		expect(f.capacity.application).toBeUndefined(); expect(f.capacity.template).toEqual({kind: "old-program"});
		expect(f.state.commits).toBe(0); expect(f.frame.pending.size).toBe(0);
	});

	it("complete native failure wins over a numerical exception without becoming a soft miss", async () => {
		const healthy = fixture(); healthy.state.mathFailure = true;
		await expect(healthy.run()).rejects.toThrow("dimension-layout"); expect(healthy.state.checks).toBe(2);
		const changed = fixture(); changed.state.mathFailure = true; changed.state.failCheck = 2;
		await expect(changed.run()).rejects.toBe(changed.nativeFailure); expect(changed.state.checks).toBe(2);
		expect(changed.capacity.application).toBeUndefined(); expect(changed.state.commits).toBe(0);
	});

	it("detaches the prior mutable cell before callbacks and clears it on an unexpected post-advance error", async () => {
		const f = fixture(); f.state.onCallback = () => {expect(f.capacity.application).toBeUndefined();};
		f.state.noneThrows = true;
		await expect(f.run()).rejects.toThrow("unexpected-finishing-layout");
		expect(f.state.advances).toBe(1); expect(f.state.checks).toBe(2);
		expect(f.capacity.application).toBeUndefined(); expect(f.state.commits).toBe(0);
		const failed = fixture(); failed.state.noneThrows = true; failed.state.failCheck = 2;
		await expect(failed.run()).rejects.toBe(failed.nativeFailure);
		expect(failed.capacity.application).toBeUndefined(); expect(failed.state.commits).toBe(0);
	});

	it("keeps callback layout failures numerical but still checks complete final native currency", async () => {
		const healthy = fixture(); healthy.state.callbackThrows = true;
		expect(await healthy.run()).toBeUndefined(); expect(healthy.state.checks).toBe(2); expect(healthy.state.commits).toBe(0);
		const changed = fixture(); changed.state.callbackThrows = true; changed.state.failCheck = 2;
		await expect(changed.run()).rejects.toBe(changed.nativeFailure); expect(changed.capacity.application).toBeUndefined();
	});

	it("does not calculate finishing or commit after callback book/runtime displacement", async () => {
		for (const kind of ["book", "runtime"] as const) {
			const f = fixture(); f.state.onCallback = () => {if (kind === "book") f.accounting.chargeUnknownEncodedLength(1); else f.state.current = false;};
			await expect(f.run()).rejects.toThrow("snapshot-unavailable"); expect(f.state.checks).toBe(2);
			expect(f.events).not.toContain("none"); expect(f.state.commits).toBe(0); expect(f.capacity.application).toBeUndefined();
		}
	});

	it("captures candidate bytes before its first await and owes fresh checks on each invocation", async () => {
		const f = fixture(), bytes = Uint8Array.of(1, 2), first = f.run(bytes); bytes.fill(9);
		expect((await first)?.knownCarriers[0]).toEqual(Uint8Array.of(1, 2));
		expect(await f.run()).toBeDefined(); expect(f.state.checks).toBe(4); expect(f.state.commits).toBe(2);
	});

	it("does not construct or enroll an intermediate nominal dimension handle", () => {
		const body = declaration("reserveCreatorOrdinaryFinishingCapacity").getText(tree);
		expect(body).not.toContain("maintenanceTerminalCustody.set"); expect(body).not.toContain("readCurrentDimensions(");
		expect(body).not.toContain("readCreatorOrdinaryApplicationResourceBound(");
		expect(body).toContain("owner.frame.pending.add(task)");
	});

	it("retains one synchronous shared owner for every pure derivation", () => {
		for (const name of ["captureCreatorOrdinaryCurrentDimensionsForSizing", "deriveCreatorOrdinaryApplicationResourceForSizing",
			"deriveCreatorOrdinarySourceResourceProgramForSizing", "deriveCreatorOrdinaryFinishingCapacityScalarForSizing",
			"deriveCreatorOrdinaryFinishingCapacityForSizing"]) {
			let awaits = 0; const visit = (node: ts.Node): void => {if (ts.isAwaitExpression(node)) awaits++; ts.forEachChild(node, visit);};
			visit(declaration(name)); expect(awaits, name).toBe(0);
		}
	});
});
