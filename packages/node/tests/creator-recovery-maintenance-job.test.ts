import {readFileSync} from "node:fs";
import {encodeCanonical} from "@ts-drp/canonical";
import {parseStorageObjectId} from "@ts-drp/storage";
import {snapshotQuarantineContract} from "@ts-drp/storage/snapshot-transfer";
import ts from "typescript";
import {describe, expect, it} from "vitest";
import {canonicalCreatorDataRecord, createCreatorCanonicalSyntaxReader} from "../src/internal/creator-snapshot-data.js";

const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const objectId = `creator:${"c".repeat(32)}`;
const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
	const matches = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (matches.length !== 1) throw Error(`MAINTENANCE_JOB_ORIGINAL_OWNER_MISSING:${name}`);
	return matches[0]!;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {resolve = done;});
	return {promise, resolve};
}

/** Execute the actual job, defensive input capture, syntax wrapper and failure
 * translation. The native workflow is a controlled asynchronous premise here;
 * the original native fixture separately verifies actual per-stage effects,
 * proof charges, currency, interruption and persisted reopen. No native view or
 * paid credit is supplied by this fixture's reusable parsing owner. */
function fixture() {
	const events: string[] = [], calls: any[][] = [];
	let syntaxFactories = 0, evidenceFactories = 0, syntaxRelease = 0;
	let before: ReturnType<typeof deferred> | undefined, cleanup: ReturnType<typeof deferred> | undefined;
	let refusal: unknown, freshFloor = "floor0", freshImage = "image0";
	class Refusal {readonly diagnosticStack = "original native refusal"; constructor(readonly result: unknown) {}}
	class RoleRefusal {constructor(readonly result: unknown) {}}
	const trust = Object.freeze({objectId, currentEpoch: 4, currentAnchorDigest: "a".repeat(64),
		genesisAnchorDigest: "b".repeat(64), profileId: "creator-trusted-v1"});
	const pin = encodeCanonical({kind: "pin", value: 1});
	const value: any = {objectId, pinnedGenesisAnchorDigest: trust.genesisAnchorDigest,
		exactCanonicalPinnedGenesisTrustStateRecordBytes: pin,
		roomHeadAuthority: {read: async () => {events.push("fresh-floor"); return freshFloor;}},
		catalog: {catalogDigest: "catalog", resolve: () => "original-catalog"},
		store: {acquireBoundedActiveRead: async () => {events.push("fresh-native-image"); return freshImage;}},
		snapshotStore: {lookupRecoveryDeclaration: async () => undefined, acquireRecoveryRead: async () => undefined,
			recoveryStatus: async () => "ready"},
		liveJournalStore: {readAnchorPreimage: async () => undefined}};
	const bindings = {snapshotQuarantineContract, parseStorageObjectId,
		abortedGetter: Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get,
		resolveSealRecoveryTrust: (current: unknown) => current === trust ? trust : undefined,
		createCreatorCanonicalSyntaxReader: () => {syntaxFactories++; return createCreatorCanonicalSyntaxReader();},
		createCreatorSnapshotRecoveryEvidenceJob: () => {evidenceFactories++; return {syntax: bindings.createCreatorCanonicalSyntaxReader(), sourceTrust: () => undefined,
			readback: () => undefined, release: () => {syntaxRelease++; events.push("syntax-release");}};},
		canonicalCreatorDataRecord, anchorOf: () => undefined, unique: () => undefined,
		uniqueCreatorTransitionCandidate: () => undefined, validateCreatorSnapshotData: () => undefined,
		requireLaw: (condition: unknown) => {if (!condition) throw Error("original syntax refusal");},
		Refusal, RoleRefusal,
		reconcileSnapshotRecoveryRoles: async (...args: any[]) => {
			calls.push(args); events.push("stage-start");
			const owned = args[5];
			await owned.input.floorRead({}); await owned.input.acquire({});
			expect(owned.input.capturedCatalog.resolve()).toBe("original-catalog");
			expect(owned.parsing.record(encodeCanonical({kind: "immutable", list: [1, 2]}))).toEqual({kind: "immutable", list: [1, 2]});
			try {await before?.promise; if (refusal !== undefined) throw refusal; return calls.length < 3;}
			finally {events.push("native-join-start"); await cleanup?.promise; events.push("native-join-complete");}
		}};
	const functions = ["bindMethod", "snapshotProtectionPort", "captureSnapshot", "capture", "record",
		"createCreatorClosedAcquisitionSyntax", "throwCreatorSnapshotRecoveryFailure", "createCreatorSnapshotRecoveryMaintenanceJob"]
		.map(name => declaration(name).getText(ast).replace(/^export /, "")).join("\n");
	const js = ts.transpile(`${functions}\ncreateCreatorSnapshotRecoveryMaintenanceJob;`, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None});
	const create = new Function(...Object.keys(bindings), `return eval(${JSON.stringify(js)});`)(...Object.values(bindings));
	return {value, trust, pin, events, calls,
		create: (input = value, current: unknown = trust) => create(input, current),
		counts: () => ({syntaxFactories, evidenceFactories, syntaxRelease}),
		block: () => {before = deferred(); cleanup = deferred(); return {before, cleanup};},
		advance: () => {freshFloor = "floor1"; freshImage = "image1";},
		refuse: (error: unknown) => {refusal = error;},
		typedRefusal: () => new Refusal({kind: "floor-stale"})};
}

describe("finite creator recovery maintenance immutable ownership", () => {
	it("captures inputs and method bindings once, reuses bounded syntax, and still observes each actual changed native image", async () => {
		const f = fixture(), job = f.create();
		f.pin.fill(255); f.value.objectId = "foreign"; f.value.store = {};
		f.value.roomHeadAuthority.read = async () => {throw Error("replaced floor method");};
		f.value.catalog.resolve = () => "replaced-catalog";
		const hold1 = {}, hold2 = {}, hold3 = {};
		expect(await job.reconcile(hold1, true, true)).toBe("fresh-summary-required"); f.advance();
		expect(await job.reconcile(hold2, false, false)).toBe("fresh-summary-required");
		expect(await job.reconcile(hold3)).toBe("complete");
		expect(f.counts()).toEqual({syntaxFactories: 1, evidenceFactories: 1, syntaxRelease: 0});
		expect(f.calls.map(args => [args[0].objectId, args[1], args[2], args[3], args[4]])).toEqual([
			[objectId, hold1, true, true, f.trust], [objectId, hold2, false, false, f.trust], [objectId, hold3, false, false, f.trust]]);
		expect(f.calls.every(args => args[5] === f.calls[0]![5])).toBe(true);
		expect(f.calls[0]![0].exactCanonicalPinnedGenesisTrustStateRecordBytes).toEqual(encodeCanonical({kind: "pin", value: 1}));
		expect(f.events.filter(event => event === "fresh-native-image")).toHaveLength(3);
		expect(f.events.filter(event => event === "fresh-floor")).toHaveLength(3);
		await job.release(); expect(f.counts().syntaxRelease).toBe(1);
	});
	it("revokes new admissions immediately and clears evidence only after the admitted native workflow joins", async () => {
		const f = fixture(), job = f.create(), gates = f.block();
		const admitted = job.reconcile(); await Promise.resolve(); await Promise.resolve();
		const release = job.release(); expect(job.release()).toBe(release);
		await expect(job.reconcile()).rejects.toThrow("released or busy");
		expect(f.counts().syntaxRelease).toBe(0); gates.before.resolve();
		await Promise.resolve(); await Promise.resolve(); expect(f.counts().syntaxRelease).toBe(0);
		gates.cleanup.resolve(); await admitted; await release;
		expect(f.events.slice(-2)).toEqual(["native-join-complete", "syntax-release"]);
		await expect(job.reconcile()).rejects.toThrow("released or busy");
	});
	it("rejects concurrent stages, then admits a fresh next stage after original completion", async () => {
		const f = fixture(), job = f.create(), first = job.reconcile();
		await expect(job.reconcile()).rejects.toThrow("released or busy"); await first;
		await expect(job.reconcile()).resolves.toBe("fresh-summary-required"); await job.release();
		expect(f.calls).toHaveLength(2); expect(f.counts().syntaxRelease).toBe(1);
	});
	it("preserves original typed refusal and originating diagnostics, joins cleanup and releases exactly once", async () => {
		const f = fixture(), job = f.create(), original = f.typedRefusal(); f.refuse(original);
		const error = await job.reconcile().catch((value: unknown) => value);
		expect(error).toBeInstanceOf(TypeError); expect(error.cause).toEqual({kind: "floor-stale"});
		expect(error.stack).toContain("original native refusal");
		await job.release(); await job.release(); expect(f.events.slice(-2)).toEqual(["native-join-complete", "syntax-release"]);
		expect(f.counts().syntaxRelease).toBe(1);
		const restarted = fixture(); await restarted.create().release();
		expect(restarted.counts()).toEqual({syntaxFactories: 1, evidenceFactories: 1, syntaxRelease: 1});
	});
	it("does not accept forged trust, malformed/accessor input, missing ports or caller-injected parsing state", () => {
		const f = fixture(); expect(() => f.create(f.value, {...f.trust})).toThrow("foreign or unavailable");
		for (const input of [{...f.value, extra: {}}, {...f.value, store: {}}, {...f.value, exactCanonicalPinnedGenesisTrustStateRecordBytes: new Uint8Array(8193)},
			Object.defineProperty({...f.value}, "objectId", {enumerable: true, get() {throw Error("getter ran");}})])
			expect(() => f.create(input)).toThrow("foreign or unavailable");
	});
	it("threads immutable facts only through the original fresh protected acquisitions and leaves the public one-shot signature unchanged", () => {
		expect(declaration("reconcileCreatorSnapshotRecoveryRoles").parameters).toHaveLength(5);
		const reconcile = declaration("reconcileSnapshotRecoveryRoles").getText(ast);
		expect(reconcile).toContain("const closeObserved = await acquireClosedData(");
  expect(reconcile).toContain("journalHeaderHold, ownedMaintenance, snapshotPreparation, nativePreparation)");
		const acquisition = declaration("acquireClosedData").getText(ast);
		expect(acquisition).toContain("if (ownedMaintenance === undefined) parsing.release()");
		expect(acquisition).toContain("facts = await authenticate(");
		expect(declaration("authenticate").getText(ast)).toContain("createCreatorClosedRollbackProofAccounting(");
	});
});
