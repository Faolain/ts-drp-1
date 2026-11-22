import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {settlementProfileFor} from "@ts-drp/protocol-v3/settlement-profile";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

import { createWorkCheckpoint } from "../src/internal/cooperative-work.js";

// Actual private numerical/cold-capture bodies with controlled original owners.
// These do not mint native, membership, signature or admission capabilities.
// The existing real-crypto closed-prefix tests establish the capture boundary;
// original V1 native factory/book controls remain the end-to-end oracle.
const rollbackSource = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/internal/runtime-reclamation.ts", import.meta.url), "utf8");
const liveSource = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
function declaration(source: string, name: string): string {
	const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
	const node = tree.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === name);
	if (node === undefined) throw new Error(`missing original material owner: ${name}`);
	return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	bindings = {createWorkCheckpoint, ...bindings};
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const shared = execute<{
	control(value: unknown, profile: string): boolean;
	fields(value: Record<string, unknown>): any;
}>(`${declaration(runtimeSource, "creatorApplicationControlOperationForSizing")}
${declaration(runtimeSource, "creatorAuthenticatedEpochVertexFields")}
return {control: creatorApplicationControlOperationForSizing, fields: creatorAuthenticatedEpochVertexFields};`, {settlementProfileFor});
const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const equal = (left: unknown, right: unknown): boolean => compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;
function requireLaw(value: boolean, code: string): void {if (!value) throw new Error(code);}
function record(bytes: Uint8Array): Record<string, any> {return decodeCanonical(bytes) as Record<string, any>;}
function fixture(sql = false) {
	const scope = {objectId: "room", epoch: 1, anchorDigest: "a".repeat(64)}, author = "b".repeat(64), digest = "c".repeat(64);
	const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId, epoch: scope.epoch,
		anchor: scope.anchorDigest, author, authorSequence: 2, logicalTime: 3, dependencies: [scope.anchorDigest],
		operation: {action: "placeBlock", bytes: Uint8Array.of(9)}});
	const signature = new Uint8Array(64).fill(7), nativeRow = sql
		? {source_kind: "local-issued", vertex_digest: digest, local_author: author, local_author_sequence: 2}
		: {sourceKind: "local-issued", vertexDigest: digest, localAuthor: author, localAuthorSequence: 2};
	const nativeFrame = encodeCanonical([sql ? "accepted_entries" : "acceptedEntries",
		[scope.objectId, scope.epoch, scope.anchorDigest, 0], nativeRow]);
	const captured = {scope, sourceKind: "local-issued", vertexData: record(preimage), journalSequence: 0, vertexDigest: digest, author, authorSequence: 2,
		profileId: "creator-trusted-settlement-v1", exactCanonicalNativeFrameBytes: nativeFrame.slice(),
		exactCanonicalPreimageBytes: preimage.slice(), detachedSignature: signature.slice()};
	const catalog = {artifactId: "artifact", artifactDigest: "artifact-digest", catalogDigest: "catalog",
		runtimeProfile: "profile", exactArtifactBytes: Uint8Array.of(1), canonicalBlueprintPackageBytes: Uint8Array.of(2)};
	const accounting = {}, protectedMaterial: Uint8Array[] = [];
	const facts: any = {frame: {accounting, input: {capturedCatalog: {}}}, sourceFacts: {catalogDigest: "catalog", blobs: [],
		applicationControls: [], applicationJournalRows: [captured]}, current: {runtime: {objectId: "room"},
		blueprint: {blueprintDigest: "blueprint", catalog, exactCanonicalBaseStateBytes: encodeCanonical({base: true}),
			maxApplicationStateBytes: 65536, maxDepth: 32, maxItems: 2048}, applicationControls: [],
		currentSignedPreimagesHaveSettlementSource: false, currentApplicationPreimageBytes: [], pendingIngress: {roots: []},
		candidate: {exactCanonicalOperationBytes: encodeCanonical({action: "placeBlock", bytes: Uint8Array.of(10)})}},
		proofFacts: {capture: {nativeIssuance: {rows: {issued: [], outbox: [], lineages: []}}, journal: {canonicalRows: [nativeFrame]}}}};
	const api = execute<{input(facts: any): any; resolve(source: any, bytes: Uint8Array): any}>(`
		${declaration(rollbackSource, "creatorOrdinaryClosedJournalApplicationRowForSizing")}
		${declaration(rollbackSource, "creatorOrdinaryApplicationResourceMaterialForSizing")}
		${declaration(rollbackSource, "creatorOrdinaryApplicationResourceInput")}
		return {input: creatorOrdinaryApplicationResourceInput, resolve: creatorOrdinaryClosedJournalApplicationRowForSizing};`, {
		decodeCanonical, encodeCanonical, compareBytes, record, closedRetirementBytes: encodeCanonical,
		closedRetirementEqual: equal, closedRetirementHex: hex,
		verifiedCreatorSnapshotCatalog: () => catalog,
		creatorOrdinaryIssuanceApplicationSources: () => [],
		proofMaterialOwners: new Map([[accounting, {captureKnownProtectedMaterial: () => protectedMaterial}]]),
	});
	const issued = {objectId: "room", author, authorSequence: 2, digest: hex(digest), canonicalPreimageBytes: preimage.slice(), signature: signature.slice()};
	return {api, facts, captured, preimage, signature, nativeFrame, scope, protectedMaterial, issued};
}

describe("original closed application material continuation", () => {
	it("keeps full operations when original local-issued PRE has been lawfully pruned, for both native layouts", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql), retained = f.api.input(f.facts);
			expect(retained.material.recoveryOperations).toEqual([{action: "placeBlock", bytes: Uint8Array.of(9)}]);
			f.facts.proofFacts.capture.nativeIssuance.rows.issued.push(f.issued);
			const nativePresent = f.api.input(f.facts);
			expect(encodeCanonical(nativePresent.material.recoveryOperations)).toEqual(encodeCanonical(retained.material.recoveryOperations));
			expect(nativePresent.material.protectedOperations).toHaveLength(1); // The separate actual native use remains covered.
			retained.material.recoveryOperations[0].bytes[0] = 255;
			expect(f.api.input(f.facts).material.recoveryOperations[0].bytes).toEqual(Uint8Array.of(9));
			expect(f.captured.exactCanonicalPreimageBytes).toEqual(f.preimage);
			expect(f.captured.detachedSignature).toEqual(f.signature);
		}
	});

	it("never substitutes digest, scope, duplicate or altered native correspondence for an exact witnessed frame", () => {
		for (const change of ["missing", "duplicate", "changed-frame", "wrong-scope", "wrong-author", "wrong-sequence"] as const) {
			const f = fixture();
			if (change === "missing") f.facts.sourceFacts.applicationJournalRows = [];
			if (change === "duplicate") f.facts.sourceFacts.applicationJournalRows.push({...f.captured});
			if (change === "changed-frame") f.captured.exactCanonicalNativeFrameBytes = encodeCanonical(["acceptedEntries", ["room", 1, f.scope.anchorDigest, 0], {sourceKind: "local-issued", vertexDigest: "d".repeat(64), localAuthor: f.captured.author, localAuthorSequence: 2}]);
			if (change === "wrong-scope") f.captured.scope = {...f.scope, epoch: 2};
			if (change === "wrong-author") f.captured.author = "d".repeat(64);
			if (change === "wrong-sequence") f.captured.journalSequence = 1;
			expect(f.api.input(f.facts), change).toBeUndefined();
		}
	});

	it("native ambiguity and native-versus-witness PRE/signature mismatches retain the original fallback", () => {
		for (const change of ["duplicate-native", "signature", "preimage", "scope", "author"] as const) {
			const f = fixture(); f.facts.proofFacts.capture.nativeIssuance.rows.issued.push(f.issued);
			if (change === "duplicate-native") f.facts.proofFacts.capture.nativeIssuance.rows.issued.push({...f.issued});
			if (change === "signature") f.issued.signature[0] ^= 1;
			if (change === "preimage") f.issued.canonicalPreimageBytes = encodeCanonical({...record(f.preimage), logicalTime: 4});
			if (change === "scope") f.captured.exactCanonicalPreimageBytes = encodeCanonical({...record(f.preimage), epoch: 2});
			if (change === "author") f.captured.exactCanonicalPreimageBytes = encodeCanonical({...record(f.preimage), author: "d".repeat(64)});
			f.captured.vertexData = record(f.captured.exactCanonicalPreimageBytes);
			expect(f.api.input(f.facts), change).toBeUndefined();
		}
	});

	it("only exact source-owned neutral facts omit APP effects, never unqualified fence names or settlementSource", () => {
		const f = fixture(), pre = record(f.preimage); pre.operation = {action: "$drp.author-fence.v1", version: 1, fenceSequence: 2};
		f.captured.exactCanonicalPreimageBytes = encodeCanonical(pre);
		f.captured.vertexData = record(f.captured.exactCanonicalPreimageBytes);
		const derivative = encodeCanonical(shared.fields({anchor: pre.anchor, dependencies: pre.dependencies, epoch: pre.epoch,
			hash: f.captured.vertexDigest, kind: pre.kind, objectId: pre.objectId, operation: pre.operation}));
		f.protectedMaterial.push(f.captured.exactCanonicalPreimageBytes, derivative);
		expect(f.api.input(f.facts).material.recoveryOperations).toHaveLength(1);
		f.facts.sourceFacts.applicationControls.push({exactCanonicalPreimageBytes: f.captured.exactCanonicalPreimageBytes.slice(), exactCanonicalEpochVertexBytes: derivative.slice()});
		expect(f.api.input(f.facts).material.recoveryOperations).toHaveLength(0);
		expect(f.api.input(f.facts).material.protectedOperations).toHaveLength(0);
		f.captured.exactCanonicalPreimageBytes = encodeCanonical({...pre, settlementSource: {unqualified: true}});
		f.captured.vertexData = record(f.captured.exactCanonicalPreimageBytes);
		expect(f.api.input(f.facts)).toBeUndefined();
	});

	it("shares the original profile-gated execution law and byte-identical derivative fields without granting authority", () => {
		const wrapper = execute<(value: unknown, profile: string) => boolean>(`${declaration(liveSource, "isControlOperation")}\nreturn isControlOperation;`, {
			creatorApplicationControlOperationForSizing: shared.control});
		for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1"]) {
			for (const action of ["$drp.author-fence.v1", "causalJoin", "join", "placeBlock"]) {
				expect(wrapper({action}, profile)).toBe(profile === "creator-trusted-settlement-v1" && action !== "placeBlock");
			}
		}
		expect(wrapper(Object.assign(() => {}, {action: "join"}), "creator-trusted-settlement-v1")).toBe(true);
		expect(wrapper(null, "creator-trusted-settlement-v1")).toBe(false);
		const f = fixture(), pre = record(f.preimage), dependencies = pre.dependencies.slice();
		const admitted: Record<string, any> = {...pre, digest: hex(f.captured.vertexDigest)};
		const auth = execute<(value: any, charge: number) => any>(`${declaration(liveSource, "authenticatedRecoveryVertex")}\nreturn authenticatedRecoveryVertex;`, {
			lowerHexDigest: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"), ObjectFreeze: Object.freeze,
			creatorAuthenticatedEpochVertexFields: shared.fields, settlementSourceByVertex: new WeakMap()});
		const actual = auth(admitted, f.preimage.byteLength);
		expect(encodeCanonical(actual.vertex)).toEqual(encodeCanonical({anchor: pre.anchor, dependencies, epoch: pre.epoch,
			hash: f.captured.vertexDigest, kind: pre.kind, objectId: pre.objectId, operation: pre.operation}));
		admitted.dependencies.push("later"); expect(actual.vertex.dependencies).toEqual(dependencies);
		expect(actual.admitted).toBe(admitted); // SAME original view ownership, no new capability.
	});
});

function collectorFixture() {
	const f = fixture(), frame: any = {alive: true, reader: {}, input: {objectId: "room"}, recoveryTrusts: new Set(),
		headerHold: {}, pending: new Set(), accounting: {charge: (bytes: Uint8Array) => {charges.push(bytes.slice()); return !state.quota;}}};
	const capture = {journal: {}, closeHold: {}}, charges: Uint8Array[] = [], state = {quota: false, checks: 0, delivered: false,
		requireAuthority: false, authorities: [] as any[], digestOverride: undefined as string | undefined,
		verificationOwner: undefined as {verifyVertex(input: unknown): unknown} | undefined,
		verificationDispatch: undefined as ((input: unknown) => unknown) | undefined};
	const anchors = new WeakMap<object, {anchorPreimage: Uint8Array; anchorSignature: Uint8Array}>(), forward: any = {certificates: [], held: []};
	frame.maintenanceCapture = capture;
	const api = execute<(frame: any, forward: any, capture: any, check: () => Promise<void>) => Promise<any[]>>(
		`${declaration(rollbackSource, "captureCreatorOrdinaryClosedJournalApplicationRows")}\nreturn captureCreatorOrdinaryClosedJournalApplicationRows;`, {
			frames: new Map([[frame.reader, frame]]), journalHeaderHolds: new WeakSet([frame.headerHold]), requireLaw,
			resolveCreatorSnapshotRecoveryCloseHold: (value: unknown, owners: any) => {
				expect(value).toBe(capture.closeHold);
				expect(owners).toEqual({store: frame.input.store, liveJournalStore: frame.input.liveJournalStore, currentTrust: forward.currentTrust});
				return state.verificationOwner;
			},
			closedNativeJournalScopes: () => [f.scope], LIVE_JOURNAL_RETIREMENT_LIMITS: {maxRows: 8192},
			closedJournalMembershipPrefix: async (input: any) => {state.authorities = input.authorities; await input.check();
				state.verificationDispatch = input.verifyVertex;
				if (state.requireAuthority && input.authorities.length === 0) return undefined;
				state.delivered = true; input.captureApplicationRows([f.captured]);},
			readCreatorSettlementSourceAnchor: (trust: object) => anchors.get(trust), record, compareBytes,
			creatorDataDigest: (domain: string, bytes: Uint8Array) => state.digestOverride ?? Buffer.from(hashDomain(domain, bytes)).toString("hex"),
		});
	return {...f, frame, capture, charges, state, anchors, forward, run: () => api(frame, forward, capture, async () => {state.checks++;})};
}

describe("cold original-owner capture lifetime and book", () => {
	it("uses only the resolved original lifetime's optional pure verification dispatch without changing checks or charges", async () => {
		const original = collectorFixture();
		await original.run();
		expect(original.state.verificationDispatch).toBeUndefined();
		const shared = collectorFixture(), input = {}, answer = {};
		let calls = 0;
		shared.state.verificationOwner = {verifyVertex(actual) {
			expect(this).toBe(shared.state.verificationOwner);
			expect(actual).toBe(input); calls++; return answer;
		}};
		await shared.run();
		expect(shared.state.verificationDispatch!(input)).toBe(answer);
		expect(calls).toBe(1);
		expect(shared.state.checks).toBe(original.state.checks);
		expect(shared.charges).toEqual(original.charges);
	});
	it("derives held-target authority only from exact original registered anchor context, never the successor suite", async () => {
		for (const change of ["valid", "missing", "scope", "ACL", "hash", "profile", "conflicting-signature", "conflicting-bytes"] as const) {
			const f = collectorFixture(); f.state.requireAuthority = true;
			const anchor = encodeCanonical({objectId: "room", epoch: 1, aclDigest: change === "ACL" ? "wrong-ACL" : "closed-ACL",
				cryptoSuiteId: "original-suite"});
			const digest = Buffer.from(hashDomain("ts-drp/epoch-anchor/v3", anchor)).toString("hex");
			f.scope.anchorDigest = digest;
			const trust = {objectId: "room", currentEpoch: change === "scope" ? 2 : 1, currentAnchorDigest: digest,
				profileId: change === "profile" ? "creator-trusted-v1" : "creator-trusted-settlement-v1"};
			const material = {anchorPreimage: anchor.slice(), anchorSignature: new Uint8Array(64).fill(4)};
			if (change === "hash") material.anchorPreimage = encodeCanonical({...record(anchor), extra: true});
			if (change !== "missing") f.anchors.set(trust, material);
			f.frame.recoveryTrusts.add(trust);
			const cut = encodeCanonical({previousAnchor: digest, epoch: 1});
			f.forward.held.push({target: {cut: {previousAnchor: digest, epoch: 1}, evidence: {cut: {bytes: cut}},
				closedAclDigest: "closed-ACL", successorTrust: {profileId: "creator-trusted-settlement-v1", cryptoSuiteId: "successor-suite"}}});
			if (change.startsWith("conflicting")) {
				const other = {...trust}, otherMaterial = {anchorPreimage: material.anchorPreimage.slice(), anchorSignature: material.anchorSignature.slice()};
				if (change === "conflicting-signature") otherMaterial.anchorSignature[0] ^= 1;
				else {
					// Controlled collision exercises the exact-byte ambiguity guard,
					// not a claim of an actual hash/signature/native capability.
					f.state.digestOverride = digest;
					otherMaterial.anchorPreimage = encodeCanonical({...record(anchor), extra: true});
				}
				f.anchors.set(other, otherMaterial); f.frame.recoveryTrusts.add(other);
				await expect(f.run()).rejects.toThrow("chain-invalid"); expect(f.state.delivered).toBe(false); continue;
			}
			const rows = await f.run();
			if (change !== "valid") {
				expect(rows, change).toHaveLength(0); expect(f.state.authorities, change).toHaveLength(0); expect(f.charges, change).toHaveLength(0);
			} else {
				expect(f.state.authorities).toEqual([{scope: f.scope, exactCanonicalCutValueBytes: cut,
					closedAclDigest: "closed-ACL", profileId: trust.profileId, suiteId: "original-suite"}]);
				expect(f.charges).toEqual([anchor, material.anchorSignature, f.preimage, f.signature]);
				expect(f.state.checks).toBe(3); expect(rows).toHaveLength(1);
			}
		}
	});

	it("charges extracted PRE/signature, not equality metadata, and keeps detached bounded rows", async () => {
		const f = collectorFixture(), rows = await f.run();
		expect(f.state.checks).toBe(3); expect(f.state.delivered).toBe(true);
		expect(f.charges).toEqual([f.preimage, f.signature]);
		expect(f.charges.some(bytes => compareBytes(bytes, f.nativeFrame) === 0)).toBe(false);
		f.captured.exactCanonicalPreimageBytes.fill(0); f.captured.detachedSignature.fill(0); f.captured.exactCanonicalNativeFrameBytes.fill(0);
		expect(rows[0].exactCanonicalPreimageBytes).toEqual(f.preimage);
		expect(rows[0].detachedSignature).toEqual(f.signature); expect(rows[0].exactCanonicalNativeFrameBytes).toEqual(f.nativeFrame);
	});

	it("revocation and original book quota failure cannot publish a captured source", async () => {
		const revoked = collectorFixture(); revoked.frame.headerConsumersRevoked = true;
		await expect(revoked.run()).rejects.toThrow("snapshot-unavailable"); expect(revoked.state.delivered).toBe(false);
		const quota = collectorFixture(); quota.state.quota = true;
		await expect(quota.run()).rejects.toThrow("proof-budget-exceeded");
	});

	it("capture and all actual PRE/control charges precede the immutable known-material snapshot and source enrollment", () => {
		const body = declaration(rollbackSource, "captureCreatorOrdinaryIssuanceProofSource");
		// The first capture is a provisional projection. Enrollment uses the final
		// immutable SAME-book union after all application/source observations.
		const capture = body.indexOf("await captureCreatorOrdinaryReadOnlySourceWitnesses("), known = body.lastIndexOf("captureKnownMaterial()"),
			controls = body.indexOf("for (const control of applicationControls)"), enrollment = body.lastIndexOf("maintenanceTerminalCustody.set(");
		expect(capture).toBeGreaterThan(0); expect(controls).toBeGreaterThan(capture); expect(known).toBeGreaterThan(controls);
		expect(enrollment).toBeGreaterThan(known);
		const witnesses = declaration(rollbackSource, "captureCreatorOrdinaryReadOnlySourceWitnesses");
		expect(witnesses.indexOf("await captureCreatorOrdinaryClosedJournalApplicationRows(")).toBeGreaterThan(witnesses.indexOf("await check()"));
		expect(witnesses.lastIndexOf("await check()")).toBeGreaterThan(witnesses.indexOf("await captureCreatorOrdinaryClosedJournalApplicationRows("));
		const acquisition = declaration(rollbackSource, "acquireCreatorOrdinaryIssuanceMaintenanceProof");
		expect(acquisition).not.toContain("captureCreatorOrdinaryClosedJournalApplicationRows(");
	});
});

describe("one admitted cold source witness read", () => {
	function fixture() {
		const reader = {}, accounting = {unknownEncodedBytes: 11}, headerHold = {}, capture: any = {snapshotInventory: {}, closeHold: {}};
		const frame: any = {reader, accounting, headerHold, alive: true, maintenanceCapture: capture, input: {}, pending: new Set()};
		const forward = {reader}, frames = new Map([[reader, frame]]), ledgers = new Map([[accounting, frame]]), journalHeaderHolds = new Set([headerHold]);
		const state = {fullChecks: 0, cheapChecks: 0, receiptCalls: 0, prefixCalls: 0, current: true,
			failure: undefined as Error | undefined, duringReceipt: undefined as (() => void) | undefined,
			gate: undefined as Promise<void> | undefined, started: undefined as (() => void) | undefined};
		const preimage = Uint8Array.of(1, 2, 3), signature = Uint8Array.of(4, 5), charges: Uint8Array[] = [];
		const rows = Object.freeze([{exactCanonicalPreimageBytes: preimage, detachedSignature: signature}]);
		const read = execute<(frame: any, forward: any, capture: any, check: () => Promise<void>) => Promise<any>>(`
			${declaration(rollbackSource, "captureCreatorOrdinaryReadOnlySourceWitnesses")}
			return captureCreatorOrdinaryReadOnlySourceWitnesses;`, {
			frames, ledgers, journalHeaderHolds, requireLaw,
			captureCreatorMaintenanceReceivedRecoveryScopes: async (_input: unknown, actual: unknown, _inventory: unknown, check: () => Promise<void>) => {
				expect(actual).toBe(frame); state.receiptCalls++;
				for (let index = 0; index < 6; index++) {await check(); state.cheapChecks++;}
				state.duringReceipt?.(); await check();
				if (state.failure !== undefined) throw state.failure;
				return Object.freeze([]);
			},
			captureCreatorOrdinaryClosedJournalApplicationRows: async (actual: unknown, _forward: unknown, _capture: unknown, check: () => Promise<void>) => {
				expect(actual).toBe(frame); state.prefixCalls++; state.started?.(); await state.gate;
				for (let index = 0; index < 6; index++) {await check(); state.cheapChecks++;}
				charges.push(preimage, signature); return rows;
			},
		});
		const run = () => read(frame, forward, frame.maintenanceCapture, async () => {
			state.fullChecks++; if (!state.current) throw Error("controlled complete source context changed");
		});
		return {frame, capture, accounting, state, frames, ledgers, journalHeaderHolds, rows, charges, preimage, signature, run};
	}
	it("replaces repeated complete captures with two brackets while retaining inner availability and producer charges", async () => {
		const f = fixture(), result = await f.run();
		expect(f.state.fullChecks).toBe(2); expect(f.state.cheapChecks).toBe(12);
		expect(f.state.receiptCalls).toBe(1); expect(f.state.prefixCalls).toBe(1);
		expect(result.applicationJournalRows).toBe(f.rows); expect(result.capture).toEqual({...f.frame.maintenanceCapture, receivedRecoveryScopes: []});
		expect(f.frame.maintenanceCapture).toBe(f.capture); // New receipt classification stays staged until the factory's final check.
		expect(result.capture.receivedRecoveryScopes).toEqual([]); expect(Object.isFrozen(result)).toBe(true);
		expect(f.charges).toEqual([f.preimage, f.signature]); expect(f.accounting.unknownEncodedBytes).toBe(11);
	});
	it("refuses each revoked original owner at the old inner callback before entering the next producer", async () => {
		for (const change of [
			(f: ReturnType<typeof fixture>) => {f.frame.alive = false;},
			(f: ReturnType<typeof fixture>) => {f.frame.headerConsumersRevoked = true;},
			(f: ReturnType<typeof fixture>) => {f.frame.headerMutation = {};},
			(f: ReturnType<typeof fixture>) => {f.frames.delete(f.frame.reader);},
			(f: ReturnType<typeof fixture>) => {f.ledgers.delete(f.accounting);},
			(f: ReturnType<typeof fixture>) => {f.journalHeaderHolds.delete(f.frame.headerHold);},
			(f: ReturnType<typeof fixture>) => {f.frame.maintenanceCapture = {...f.capture};},
		]) {
			const f = fixture(); f.state.duringReceipt = () => change(f);
			await expect(f.run()).rejects.toThrow("snapshot-unavailable"); expect(f.state.prefixCalls).toBe(0);
			expect(f.state.fullChecks).toBe(1); expect(f.charges).toEqual([]);
		}
	});
	it("withholds the private result on final native/context drift and preserves original corruption/quota errors", async () => {
		const changed = fixture(); changed.state.duringReceipt = () => {changed.state.current = false;};
		await expect(changed.run()).rejects.toThrow("complete source context changed"); expect(changed.state.fullChecks).toBe(2);
		expect(changed.frame.maintenanceCapture).toBe(changed.capture);
		expect(changed.capture.receivedRecoveryScopes).toBeUndefined();
		for (const reason of ["floor-stale", "proof-budget-exceeded"]) {
			const f = fixture(), error = new Error(reason); f.state.failure = error;
			await expect(f.run()).rejects.toBe(error); expect(f.state.prefixCalls).toBe(0); expect(f.accounting.unknownEncodedBytes).toBe(11);
		}
	});
	it("keeps revocation immediate and joins already admitted prefix work before release finishes", async () => {
		const f = fixture(); let entered!: () => void, resume!: () => void;
		const started = new Promise<void>(resolve => {entered = resolve;});
		f.state.started = entered; f.state.gate = new Promise<void>(resolve => {resume = resolve;});
		const task = f.run(); f.frame.pending.add(task); void task.catch(() => undefined);
		await started; f.frame.headerConsumersRevoked = true;
		let joined = false; const released = Promise.allSettled([...f.frame.pending]).then(() => {joined = true;});
		await Promise.resolve(); expect(joined).toBe(false); resume();
		await expect(task).rejects.toThrow("snapshot-unavailable"); await released; expect(joined).toBe(true); expect(f.charges).toEqual([]);
		const factory = declaration(rollbackSource, "captureCreatorOrdinaryIssuanceProofSource");
		expect(factory).toContain("frame.pending.add(task)"); expect(factory).toContain("await captureCreatorOrdinaryReadOnlySourceWitnesses(");
	});
});
