import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {canonicalBytesResourceForSizing, canonicalPrimitiveResourceForSizing,
	canonicalRecordResourceForSizing, canonicalValueResourceForSizing} from "@ts-drp/canonical/resource";
import * as ts from "typescript";
import {prepareJournalOrdinaryFinishingCapacityProjection} from "../../live-journal/src/retirement.js";
import {CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE} from "../src/internal/creator-source-custody.js";
import {describe, expect, it} from "vitest";

// Execute the actual suffix/accepted-update bodies. Nominal proof, current
// currency and primitive width/evaluator laws are explicit controlled premises
// here, NOT crypto/native or full-envelope dominance evidence. The independent
// original constructor controls test the actual producer laws separately.
const text = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", text, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
	const found = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found.length !== 1) throw Error(`missing actual owner:${name}:${found.length}`);
	return found[0]!.getText(tree).replace(/^export /u, "");
}
function actual<T>(names: readonly string[], name: string, bindings: Record<string, unknown>): T {
	const code = ts.transpileModule(`${names.map(declaration).join("\n")}\nreturn ${name};`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${code}`)(bindings) as T;
}
const equal = (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0;
const resource = (value: unknown) => canonicalValueResourceForSizing(value, 128, {maxBytes: 4194304, maxItems: 65536}, "exact");
const anchor = "a".repeat(64), author = "b".repeat(64), digest = "c".repeat(64), scope = {objectId: "room", author};
const nativeScope = {objectId: "room", epoch: 2, anchorDigest: anchor};
const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: "room", epoch: 2, anchor,
	author, authorSequence: 1, logicalTime: 17, dependencies: [anchor], operation: {action: "causalJoin"}});
const derivative = encodeCanonical({kind: "drp-vertex", objectId: "room", epoch: 2, anchor, hash: digest,
	dependencies: [anchor], operation: {action: "causalJoin"}});
const limits = {maxBytes: 4194304, maxItems: 65536, maxDepth: 128};
function fixture() {
	const owner = {projectByteLengths: (known: readonly Uint8Array[]) => ({whole: 10000 + known.reduce((n, raw) => n + raw.byteLength, 0)}),
		captureKnownProtectedMaterial: () => [preimage.slice()]};
	const proof = {accounting: {maxBytes: 1310720, chargedBytes: 10000}};
	const proofMaterialOwners = new WeakMap([[proof.accounting, owner]]);
	const index = {project: () => ({whole: 30000, protected: 20000}), projectAdmission: () => ({whole: 20000, protected: 20000}),
		projectCurrentProtected: () => ({whole: 20000, protected: 20000}),
		appendAccepted: (_raw: readonly Uint8Array[]) => index};
	const calls: any[] = [], evaluated: ReadonlyMap<string, number>[] = [];
	const runtimeResult = (n: number) => ({currentClose: 2000 + n * 100, successorReserved: 1000, successorEntered: 1000, successorFinal: 1500,
		runtimeCensusOverheadShape: Object.fromEntries(["currentClose", "successorReserved", "successorEntered", "successorFinal"].map(phase =>
			[phase, {items: 50 + n * 3, maxDepth: 5}]))});
	const runtimeWidths = {...runtimeResult(1), project: (input: any) => {calls.push(["runtime", input]); return runtimeResult(input.maxAdditionalCurrentJournalRows);}};
	const rows = {lineages: [{...scope, next: 1, exhausted: false}], issued: [] as any[], outbox: [] as any[], plans: []};
	// ea4eb158: the header drain is read from the genuine journal projection,
	// which validates each row's own scope and journal sequence.
	const header = encodeCanonical(["scopes", ["room", 2, anchor], {objectId: "room", epoch: 2, anchorDigest: anchor,
		nextJournalSequence: 1, exactCanonicalParametersCarrierBytes: encodeCanonical({version: 1})}]);
	const oldReceived = encodeCanonical(["acceptedEntries", ["room", 2, anchor, 0], {objectId: "room", epoch: 2, anchorDigest: anchor,
		journalSequence: 0, sourceKind: "received", vertexDigest: digest,
		exactCanonicalPreimageBytes: new Uint8Array(4096), detachedSignature: new Uint8Array(64)}]);
	const journal = {canonicalRows: [header, oldReceived], image: {rowCount: 1, scopeCount: 1, byteCharge: 4200, imageDigest: digest}, control: null};
	const reader = () => undefined, identity = {}, profile = {kind: "ordinary-resource-program", preparedMaterial: true,
		sourceIdentity: identity, sourceBasis: {recoveryScopes: 0, recoveryContentBytes: 0,
			retiredSnapshotCount: 0, retiredSnapshotContentBytes: 0, maxRecoveryScopes: 8, maxRecoveryContentBytes: 1000000},
		preparedParameters: [], program: {}, firstStageThroughNode: 1, journalScopeKeys: [JSON.stringify(["room", 2, anchor])]};
	const source: any = {identity, nativeIssuance: {rows, control: null}, journal,
		inventoryBytes: encodeCanonical({scopes: [], owner: {recoveryScopes: 0, recoveryContentBytes: 0,
			limits: {maxRecoveryScopes: 8, maxRecoveryContentBytes: 1000000}}}),
		maintenanceResourceFacts: {snapshotScopesRetiring: []},
		capacity: {template: {kind: "creator-finishing-source-programs-1", ordinary: profile}, material: index,
			readiness: {reader, sourceIdentity: identity, geometry: {graphVersion: 3, baseGraphCount: 2, basePreimageCount: 1,
				baseWitnessPayloadBytes: 4100, acceptedWitnessPayloadBytes: 0, acceptedCount: 0, localIssuedCount: 0,
				runtimeWidths,
				journalObservationFields: {control: resource(null), image: resource(journal.image), canonicalRows: resource(journal.canonicalRows)}}}}};
	const current = {runtime: {kind: "pending-local-issuance", objectId: "room", epoch: 2, anchorDigest: anchor,
		profileId: "creator-trusted-settlement-v1", issuanceScope: scope, graphVersion: 3, epochBytes: 10000},
		parameters: {maxEpochVertices: 8192, maxEpochBytes: 8388608}, currentEpochVertexCount: 2,
		nativeCounts: {currentJournalRows: 1},
		currentSignedPreimageByteLengths: [4000], successorFenceCount: 1,
		candidate: {control: true, exactCanonicalEpochVertexBytes: derivative, exactCanonicalOperationBytes: encodeCanonical({action: "causalJoin"})}};
	const facts: any = {sourceFacts: source, current, applicationResource: {value: resource({blocks: []})},
		settlementCapacity: {successorFenceCount: 1, canonicalSuccessorFencePreimageByteLength: 1900, nativeControlRevisionDelta: 7},
		knownResourceTotals: {knownBytes: 10000, protectedBytes: 5000, unknownEncodedBytes: 0},
		proofFacts: {capture: {nativeIssuance: {rows: structuredClone(rows), control: null}, journal: structuredClone(journal), journalFrames: [],
			snapshot: {image: {chunkCount: 0}}}, runtime: {
			readCapacityLeafWidths: () => ({canonicalPreimageByteLength: 8334, canonicalEpochVertexByteLength: 8192}),
			readCapacityWidths: (input: any) => {calls.push(["runtime", input]); return runtimeResult(input.maxAdditionalCurrentJournalRows ?? 1);}}}};
	const suffix = {additionalLocalVertices: 4, graphVersion: 3, applicationOperationCount: 1,
		exactCanonicalApplicationOperationBytes: encodeCanonical({action: "placeBlock", id: "block", x: 4, y: 2})};
	const options = {reader}, result = {capacity: {knownCarriers: [preimage.slice()], unknownEncodedLengths: [123, 456],
		fullFutureProofEnvelopeByteLengths: [100000, 200000, 300000, 400000]}, commit: () => {throw Error("not committed by pure preflight");}};
	let excessM = false;
	const evaluate = (_program: unknown, parameters: ReadonlyMap<string, number>, through?: number) => {
		evaluated.push(new Map(parameters));
		return new Map([["artifacts.chunkCount", 1], ["artifacts.payload.bytes", 4096], ["artifacts.manifest.bytes", 256],
			["artifacts.anchor.bytes", 1024], ["membership.bytes", 2048], ...[0, 1, 2, 3].map(n =>
				[`envelope.${n}`, excessM && through === undefined ? 4194305 : 500000 + n * 1000] as [string, number])]);
	};
	const preflight = actual<(...args: any[]) => any>(["creatorOrdinaryJournalDescriptorGroupsForSizing", "creatorOrdinaryJournalScopeCollectibleForSizing", "creatorOrdinaryResourceNativeCapacityForSizing", "creatorOrdinaryJournalRawSupplementForSizing", "creatorOrdinarySuffixCapacityForSizing",
		// 974f78d0/3a28ab80: the original retained-fence reserve helpers.
		"settlementAdoptionReserveFences", "settlementAdoptionReserveProtections"], "creatorOrdinarySuffixCapacityForSizing", {
		CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE,
		// 1515daab: source custody geometry is a controlled premise here (no custody
		// alternative), as in creator-ordinary-readiness-producer.test.ts.
		creatorSourceCustodyGeometryForSizing: () => undefined,
		// ea4eb158: header drain comes from the genuine journal projection.
		prepareJournalOrdinaryFinishingCapacityProjection,
		decodeCanonical, compareBytes, canonicalBytesResourceForSizing, canonicalPrimitiveResourceForSizing, canonicalRecordResourceForSizing,
		creatorOrdinarySizingRecord: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
		creatorOrdinarySizingRecordValue: decodeCanonical, closedRetirementEqual: equal, record: decodeCanonical,
		settlementProfileFor: () => "v1", CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4194304, CREATOR_ORDINARY_PROOF_MAX_BYTES: 1310720,
		LIVE_JOURNAL_RETIREMENT_LIMITS: {maxRows: 8192},
		maintenanceWidthSum: (parts: readonly number[]) => {const n = parts.reduce((a, b) => a + b, 0); if (n > 4194304) throw Error("finite arithmetic"); return n;},
		creatorOrdinaryPreimageResourceGeometryForSizing: ({canonicalOperationByteLength: n}: any) =>
			({canonicalPreimageByteLength: Math.max(512, n) + 1536, canonicalEpochVertexByteLength: Math.max(512, n) + 1400}),
		evaluateCreatorNoneResourceProgramForSizing: evaluate, proofMaterialOwners,
		creatorOrdinaryNativeJournalFrames: () => {throw Error("validated held frames must be reused");},
		creatorOrdinaryAssertCounterHorizon: (control: any, delta: number) => {if (control !== null && control.revision > Number.MAX_SAFE_INTEGER - delta) throw Error("counter");},
		snapshotQuarantineContract: {recoveryContentBytes: (a: number, b: number) => a + b}, snapshotRetirementContract: {maxChunks: 256},
		journalOrdinarySchemaFinishingCapacityWidths: (input: any) => {calls.push(["journal", input]); return {additionalFrameByteLength: 9000,
			newHeaderFrame: {byteLength: 2000}, rowCount: 1 + input.maxAdditionalCurrentRows + 1, scopeCount: 2,
			canonicalRowByteLengthsTotal: 5000 + input.maxAdditionalCurrentRows * 9000,
			canonicalRows: {byteLength: 5000 + input.maxAdditionalCurrentRows * 9000, items: 10 + input.maxAdditionalCurrentRows * 2, maxDepth: 1}, successorFenceFrameByteLength: 9000};},
		issuanceOrdinaryFinishingCapacityWidths: (input: any) => {calls.push(["issuer", input]); const phase = {nativeCensusBytes: 1000 + input.maxAdditionalCurrentIssued * 9000};
			return {ordinaryPending: phase, ordinaryFinal: phase, nativeImageByteLength: 1000, nativeImageShape: {items: 30, maxDepth: 5}};},
		creatorOrdinaryFutureNativeResourceForSizing: () => ({rows: {byteLength: 5000, items: 50, maxDepth: 5}, futureLeaf: 9000}),
		creatorOrdinaryFinishingLifetimeMaterialForSizing: () => ({currentTurnover: 20000, closeAdopt: 30000, successorJob: 20000, serial: 20000, cold: 20000}),
	});
	return {run: () => {
		// Controlled acquisition premise: each call has its own freshly captured
		// native correspondence; the numerical owner must not decode it again.
		facts.proofFacts.capture.journalFrames = facts.proofFacts.capture.journal.canonicalRows.map((raw: Uint8Array) => {
			const frame: any = decodeCanonical(raw); return {raw, frame, key: frame[1], row: frame[2]};});
		return preflight(facts, proof, preimage, result, suffix, options);
	}, facts, source, suffix, result, calls, evaluated, proof,
		excess: () => {excessM = true;}};
}

describe("same-proof first-genuine-join resource preflight", () => {
	it("reuses source-bound pool geometry only under exact source identity and retains dynamic exhaustion", () => {
		const f = fixture();
		Object.defineProperty(f.source, "inventoryBytes", {get() {throw Error("boundary-owned inventory must not be reparsed");}});
		expect(f.run()).toBeDefined();
		f.source.identity = {}; expect(f.run()).toBeUndefined();
		const exhausted = fixture();
		exhausted.source.capacity.template.ordinary.sourceBasis.maxRecoveryContentBytes = 1;
		expect(exhausted.run()).toBeUndefined(); expect(exhausted.proof.accounting.chargedBytes).toBe(10000);
	});
	it("covers the whole requested suffix without spending I or changing the real first candidate", () => {
		const f = fixture(), before = encodeCanonical(f.result.capacity), result = f.run();
		expect(result).toBeDefined(); expect(f.proof.accounting.chargedBytes).toBe(10000);
		expect(result.capacity.unknownEncodedLengths).toBe(f.result.capacity.unknownEncodedLengths);
		expect(result.capacity.knownCarriers.at(-1)).toEqual(f.suffix.exactCanonicalApplicationOperationBytes);
		expect(result.capacity.knownCarriers.at(-1)).not.toBe(f.suffix.exactCanonicalApplicationOperationBytes);
		expect(encodeCanonical(f.result.capacity)).toEqual(before);
		expect(f.calls.find(call => call[0] === "journal")[1].maxAdditionalCurrentRows).toBe(4);
		expect(f.calls.find(call => call[0] === "issuer")[1].maxAdditionalCurrentIssued).toBe(4);
		expect(f.calls.find(call => call[0] === "runtime")[1].maxAdditionalCurrentJournalRows).toBe(4);
		expect(f.evaluated.at(-1)!.get("witness.count")).toBe(5);
		expect(f.evaluated.at(-1)!.get("graph.count")).toBe(5);
		expect(result.capacity.fullFutureProofEnvelopeByteLengths).toEqual([500000, 501000, 502000, 503000]);
	});
	it("uses the fresh heterogeneous accepted prefix and rectangularizes only the genuinely future suffix", () => {
		const f = fixture(), capture = f.facts.proofFacts.capture, state = f.source.capacity.readiness.geometry;
		const acceptedPreimage = encodeCanonical({operation: {action: "small"}}), signature = new Uint8Array(64),
			issued = {...scope, authorSequence: 1, digest: new Uint8Array(32), canonicalPreimageBytes: acceptedPreimage, signature};
		capture.nativeIssuance.rows.issued.push(issued);
		capture.nativeIssuance.rows.outbox.push({...scope, authorSequence: 1, digest: issued.digest, publishState: "pending"});
		for (let index = 1; index <= 3; index++) capture.journal.canonicalRows.push(encodeCanonical([
			"acceptedEntries", ["room", 2, anchor, index], {objectId: "room", epoch: 2, anchorDigest: anchor, journalSequence: index, ...(index === 1
				? {sourceKind: "local-issued", vertexDigest: digest, localAuthor: author, localAuthorSequence: 1}
				: {sourceKind: "received", vertexDigest: String(index).repeat(64), exactCanonicalPreimageBytes: acceptedPreimage,
					detachedSignature: signature})}]));
		capture.journal.image.rowCount = 4;
		state.acceptedCount = 3; state.localIssuedCount = 1; state.graphVersion = 6;
		state.acceptedWitnessPayloadBytes = 3 * canonicalBytesResourceForSizing(acceptedPreimage.byteLength).byteLength;
		f.facts.current.runtime.graphVersion = 6; f.suffix.graphVersion = 6;
		f.facts.current.currentEpochVertexCount = 5; f.facts.current.nativeCounts.currentJournalRows = 4;
		f.facts.current.currentSignedPreimageByteLengths.push(...Array(3).fill(acceptedPreimage.byteLength));
		state.runtimeWidths.project = () => {throw Error("obsolete boundary geometry must not be used");};
		const exactBefore = capture.journal.canonicalRows.map((raw: Uint8Array) => raw.slice()), result = f.run();
		expect(result).toBeDefined(); expect(f.proof.accounting.chargedBytes).toBe(10000);
		const runtime = f.calls.find(call => call[0] === "runtime")[1], issuer = f.calls.find(call => call[0] === "issuer")[1],
			journal = f.calls.find(call => call[0] === "journal")[1];
		expect(runtime.maxCurrentJournalRows).toBe(4); expect(runtime.maxAdditionalCurrentJournalRows).toBe(4);
		expect(runtime.maxIssuerDescriptors).toBe(4); // One actual outbox plus N-1; wrapper contributes its final descriptor.
		expect(runtime.canonicalPreimageByteLength).toBe(2048); // NEW join/APP rectangle, not the retained 8334-byte historical PRE.
		expect(runtime.canonicalEpochVertexByteLength).toBe(1912);
		expect(runtime.successorFencePreimageByteLength).toBe(1900); // Separate genuine producer fact, not a historical floor.
		expect(issuer.maxCanonicalPreimageByteLength).toBe(2048); expect(journal.canonicalPreimageByteLength).toBe(2048);
		expect(issuer.rows).toBe(capture.nativeIssuance.rows); expect(issuer.rows.issued).toEqual([issued]);
		expect(issuer.maxAdditionalCurrentIssued).toBe(4);
		expect(journal.actualCanonicalRows).toBe(capture.journal.canonicalRows); expect(journal.maxAdditionalCurrentRows).toBe(4);
		expect(journal.actualCanonicalRows).toEqual(exactBefore); expect(f.source.journal.canonicalRows).toHaveLength(2);
		// One actual local + four future + successor fence, plus (974f78d0/3a28ab80)
		// the one retained-fence reserve protection beyond that fence.
		expect(f.evaluated.at(-1)!.get("issued.count")).toBe(7);
		expect(f.evaluated.at(-1)!.get("witness.payloadSum")).toBe(state.baseWitnessPayloadBytes + state.acceptedWitnessPayloadBytes +
			4 * canonicalBytesResourceForSizing(2048).byteLength);
		expect(f.evaluated.at(-1)!.get("journal.group.0.receivedPayloadSum")).toBe(
			exactBefore.slice(1).filter((raw: Uint8Array) => (decodeCanonical(raw) as any)[2].sourceKind === "received")
				.reduce((sum: number, raw: Uint8Array) => sum + canonicalBytesResourceForSizing(raw.byteLength).byteLength, 0));
		expect(f.evaluated.at(-1)!.get("journal.group.0.receivedCount")).toBe(3); // Existing received frames remain; this suffix is wholly owner-local.
		expect(f.evaluated.at(-1)!.get("journal.group.0.count")).toBe(8); // Four actual rows plus every future local row.
		expect(f.evaluated.at(-1)!.get("journal.group.0.pageCount")).toBe(0); // Actual mixed prefix, not the future maximum, excludes paging.
		expect(result.capacity.unknownEncodedLengths).toBe(f.result.capacity.unknownEncodedLengths);
	});
	it("retains the all-local paging branch and full suffix obligations without inventing received frames", () => {
		const f = fixture();
		const frame: any = decodeCanonical(f.facts.proofFacts.capture.journal.canonicalRows[1]);
		frame[2] = {objectId: "room", epoch: 2, anchorDigest: anchor, journalSequence: 0,
			sourceKind: "local-issued", vertexDigest: digest, localAuthor: author, localAuthorSequence: 1};
		const raw = encodeCanonical(frame);
		f.facts.proofFacts.capture.journal.canonicalRows[1] = raw;
		f.source.journal.canonicalRows[1] = raw.slice();
		const result = f.run();
		expect(result).toBeDefined();
		expect(f.evaluated.at(-1)!.get("journal.group.0.count")).toBe(5);
		expect(f.evaluated.at(-1)!.get("journal.group.0.receivedCount")).toBe(0);
		expect(f.evaluated.at(-1)!.get("journal.group.0.receivedPayloadSum")).toBe(0);
		expect(f.evaluated.at(-1)!.get("journal.group.0.pageCount")).toBe(5);
		expect(f.evaluated.at(-1)!.get("witness.count")).toBe(5);
		// Four local rows plus the separate successor fence, plus the one
		// retained-fence reserve protection (974f78d0/3a28ab80).
		expect(f.evaluated.at(-1)!.get("issued.count")).toBe(6);
		expect(result.capacity.unknownEncodedLengths).toBe(f.result.capacity.unknownEncodedLengths);
		expect(f.proof.accounting.chargedBytes).toBe(10000);
	});
	it("retains a larger genuine fence bound and refuses missing settlement DATA without spending I", () => {
		const f = fixture(); f.facts.settlementCapacity.canonicalSuccessorFencePreimageByteLength = 8192;
		expect(f.run()).toBeDefined();
		const runtime = f.calls.find(call => call[0] === "runtime")[1], issuer = f.calls.find(call => call[0] === "issuer")[1];
		expect(runtime.successorFencePreimageByteLength).toBe(8192); expect(runtime.canonicalPreimageByteLength).toBe(8192);
		expect(issuer.maxCanonicalPreimageByteLength).toBe(8192); expect(f.proof.accounting.chargedBytes).toBe(10000);
		const absent = fixture(); absent.facts.settlementCapacity = undefined;
		expect(absent.run()).toBeUndefined(); expect(absent.calls).toEqual([]); expect(absent.proof.accounting.chargedBytes).toBe(10000);
	});
	it("refuses stale/unqualified/unseen native work before a suffix can receive a resource result", () => {
		for (const change of [(f: any) => {f.source.capacity.readiness = undefined;},
			(f: any) => {f.facts.current.runtime.kind = "received-append";},
			(f: any) => {f.suffix.graphVersion++;}, (f: any) => {f.facts.current.candidate.control = false;},
			(f: any) => {f.facts.current.currentEpochVertexCount++;},
			(f: any) => {f.facts.proofFacts.capture.nativeIssuance.rows.issued.push({unseen: true});},
			(f: any) => {f.facts.proofFacts.capture.journal.image.rowCount++;},
			(f: any) => {f.facts.proofFacts.runtime.readCapacityWidths = () => {throw Error("fresh geometry unavailable");};},
			(f: any) => {f.suffix.additionalLocalVertices = 0;}]) {
			const f = fixture(); change(f); expect(f.run()).toBeUndefined(); expect(f.proof.accounting.chargedBytes).toBe(10000);
		}
	});
	it("preserves future-M, current/prior UNKNOWN, original clock/header counters and operation codec refusals", () => {
		const m = fixture(); m.excess(); expect(m.run()).toBeUndefined();
		const unknown = fixture(); unknown.facts.knownResourceTotals.unknownEncodedBytes = 1310720; expect(unknown.run()).toBeUndefined();
		const counter = fixture(); counter.facts.proofFacts.capture.journal.control = {revision: Number.MAX_SAFE_INTEGER - 1}; expect(counter.run()).toBeUndefined();
		for (const operation of [new Uint8Array([255]), encodeCanonical({payload: "x".repeat(65537)}),
			encodeCanonical(Array.from({length: 1025}, () => 0))]) {
			const f = fixture(); f.suffix.exactCanonicalApplicationOperationBytes = operation; expect(f.run()).toBeUndefined();
		}
	});
});
