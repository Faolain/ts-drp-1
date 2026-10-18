import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {capturePromotionArray, capturePromotionBytes, capturePromotionRecord, capturePromotionRef} from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import {AHE_BOUNDED_READ_LIMITS, digestBlob} from "@ts-drp/storage";
import ts from "typescript";
import {describe, expect, it} from "vitest";
import {createCreatorCanonicalSyntaxReader} from "../src/internal/creator-snapshot-data.js";

const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
function declaration(name: string): ts.FunctionDeclaration {
	const found = ast.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found.length !== 1) throw Error(`VERIFIED_BRANCH_PRODUCTION_DECLARATION:${name}`);
	return found[0]!;
}
function execute<T>(source: string, context: Record<string, unknown>): T {
	const js = ts.transpile(source, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None});
	return new Function(...Object.keys(context), `return eval(${JSON.stringify(js)});`)(...Object.values(context)) as T;
}
const candidate = (value: unknown) => {
	const bytes = encodeCanonical(value), digest = digestBlob(bytes);
	if (!digest.ok) throw Error("VERIFIED_BRANCH_FIXTURE_DIGEST");
	return {bytes, ref: {digest: digest.value, byteLength: bytes.byteLength}};
};
const copy = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
const equal = (left: unknown, right: unknown) => compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;

/** The real capture and semantic dispatch bodies execute here. Protocol
 * signature/checkpoint results and native retired custody are explicit controlled
 * premises; the genuine native healthy fixture verifies those separate owners. */
function fixture(cold = false, bounds = AHE_BOUNDED_READ_LIMITS) {
	const trust = {objectId: "room", currentEpoch: 4, currentAnchorDigest: "h4", genesisAnchorDigest: "h0", profileId: "profile"};
	const genuineTrusts = new WeakSet<object>([trust]);
	const pinBytes = encodeCanonical({...trust, currentEpoch: 0, currentAnchorDigest: "h0"});
	const envelopes = [3, 2, 1, 0].map(epoch => ({objectId: "room", exactCanonicalAnchorPreimageBytes: encodeCanonical({epoch}),
		detachedAnchorSignature: new Uint8Array(64), exactCanonicalParametersCarrierBytes: encodeCanonical({limit: 64})}));
	const closure = (epoch: number) => {
		const candidates = [candidate({...trust, kind: "drp-anchor-trust-state", currentEpoch: epoch, currentAnchorDigest: `h${epoch}`}),
			candidate({kind: "drp-hard-epoch-cut", epoch: epoch - 1, previousAnchor: `h${epoch - 1}`, objectId: "room",
				snapshotManifestDigest: `m${epoch - 1}`, stateDigest: "state", aclDigest: "acl"}),
			candidate({kind: "drp-seal-qc", epoch: epoch - 1, phase: "commit", valid: true}),
			candidate({kind: "drp-v3-latched-acl", epoch: epoch - 1})];
		return {candidates, closure: candidates.map(value => value.ref)};
	};
	const materials = [1, 2, 3].map(epoch => ({closure: closure(epoch), snapshot: null}));
	let chains = 0, pins = 0, sources = 0, retired = 0;
	const charged: Uint8Array[] = [];
	const proofCharges: Uint8Array[][] = [];
	const charge = (bytes: Uint8Array) => {charged.push(bytes.slice()); return true;};
	const select = (values: any[], kind: string, epoch?: number, phase?: string) => {
		const matches = values.filter(value => {const row = decodeCanonical(value.bytes) as any;
			return row.kind === kind && (epoch === undefined || (row.epoch ?? row.currentEpoch) === epoch) &&
				(phase === undefined || row.phase === phase);});
		return matches.length === 1 ? matches[0] : undefined;
	};
	const currentTrustFor = (epoch: number) => ({...trust, currentEpoch: epoch, currentAnchorDigest: `h${epoch}`});
	const checkpoint = (input: any) => {
		sources++;
		const row = decodeCanonical(input.exactCanonicalCurrentTrustStateRecordBytes ?? input.exactCanonicalTrustStateRecordBytes) as any;
		const qc = decodeCanonical(input.exactCanonicalCommitQcBytes) as any;
		return qc.valid !== true ? {ok: false} : {ok: true, currentTrust: currentTrustFor(row.currentEpoch),
			trust: currentTrustFor(row.currentEpoch), predecessorTrust: currentTrustFor(row.currentEpoch - 1)};
	};
	const input = {}, custody = {};
	const scope = (cut: any) => ({objectId: cut.objectId, epoch: cut.epoch, anchor: cut.previousAnchor, manifestDigest: cut.snapshotManifestDigest});
	const classified = materials.map(m => scope(decodeCanonical(m.closure.candidates[1]!.bytes)));
	const captured: any = {anchorChain: envelopes, nativeRetirementCustody: custody};
	const bindings: Record<string, unknown> = {
		compareBytes, decodeCanonical, encodeCanonical, capturePromotionArray, capturePromotionBytes, capturePromotionRecord, capturePromotionRef, AHE_BOUNDED_READ_LIMITS: bounds, digestBlob,
		canonicalCreatorDataRecord: decodeCanonical,
		record: (value: any) => decodeCanonical(value.bytes),
		uniqueCreatorTransitionCandidate: select, select, syntax: undefined,
		genuineRecoveryTrust: (value: unknown, bytes: Uint8Array) => value !== null && typeof value === "object" &&
			genuineTrusts.has(value) && compareBytes(bytes, pinBytes) === 0,
		createCreatorCanonicalSyntaxReader,
		createCreatorClosedRollbackProofAccounting: () => {
			const charges: Uint8Array[] = []; proofCharges.push(charges);
			return {charge: (bytes: Uint8Array) => {charges.push(bytes.slice()); return bytes.byteLength <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes;}};
		},
		inspectCreatorHistoricalAnchorChain: ({currentTrust, envelopes: actual}: any) => {
			chains++;
			if (!genuineTrusts.has(currentTrust) || currentTrust.objectId !== "room" || currentTrust.currentEpoch !== 4 ||
				currentTrust.currentAnchorDigest !== "h4" || currentTrust.genesisAnchorDigest !== "h0" || currentTrust.profileId !== "profile" ||
				actual.length !== 4 || actual.some((e: any, index: number) =>
				e.objectId !== "room" || (decodeCanonical(e.exactCanonicalAnchorPreimageBytes) as any).epoch !== 3 - index ||
				e.detachedAnchorSignature[0] !== 0)) return {ok: false};
			return {ok: true, identities: [3, 2, 1, 0].map(epoch => ({epoch, anchorDigest: `h${epoch}`, aclDigest: "acl"}))};
		},
		openCurrentAnchorTrust: ({exactCanonicalTrustStateRecordBytes, expectedObjectId, pinnedGenesisAnchorDigest}: any) => {
			pins++; return expectedObjectId === "room" && pinnedGenesisAnchorDigest === "h0" &&
				compareBytes(exactCanonicalTrustStateRecordBytes, pinBytes) === 0
				? {ok: true, trust: currentTrustFor(0)} : {ok: false};
		},
		openCreatorSuccessorTrust: checkpoint, openCreatorCheckpointTrust: checkpoint, openCreatorForwardPromotionCheckpointTrust: checkpoint,
		capturePromotionSnapshot: () => undefined,
		openCreatorTransitionClosedCutEvidence: ({closure: c}: any) => ({cut: select(c.candidates, "drp-hard-epoch-cut"),
			qc: select(c.candidates, "drp-seal-qc"), representation: "fixture"}),
		inspectCreatorClosedCutSuccessorBinding: () => ({ok: true}),
		inspectCreatorForwardPromotionClosedCutSuccessorBinding: () => ({ok: true}),
		recoveryScopeForCut: scope, recoveryScopeKey: (s: unknown) => JSON.stringify(s),
		openCanonicalLatchedAclSnapshot: ({exactCanonicalLatchedAclBytes, expectedEpoch}: any) =>
			({ok: (decodeCanonical(exactCanonicalLatchedAclBytes) as any).epoch === expectedEpoch}),
		creatorDataDigest: () => "cut-digest",
		consumeCreatorRecoveryRoleRetiredReadback: (value: unknown, original: unknown, current: unknown, digest: string) => {
			retired++; return value === custody && original === input && current === trust && digest === "cut-digest" ? classified : undefined;
		},
		samePromotionValue: equal,
	};
	const functions = ["record", "candidateSelection", "uniqueCreatorTransitionCandidate", "failure", "sameRef", "exactCandidate", "exactCreatorTransitionOccurrence", "capturePromotionClosure",
		"verifyCreatorRecoveryBranch", "createCreatorRecoveryEvidenceOwner", "createCreatorSnapshotRecoveryEvidenceJob",
		"openCreatorSnapshotRecoverySourceTrust", "openCreatorSnapshotRecoverySourceTrustOwned", "openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch"]
		.map(name => declaration(name).getText(ast).replace(/^export /, "")).join("\n");
	const readback = declaration("openCreatorSnapshotRecoveryRoleReadbackOwned");
	const body = readback.body!.statements.find(ts.isTryStatement)!.tryBlock.statements;
	const start = body.findIndex(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === "envelopes"));
	const stop = body.findIndex(s => ts.isForOfStatement(s) && s.expression.getText(ast) === "materialValues");
	const retiredBlock = body.find(s => ts.isIfStatement(s) && s.expression.getText(ast) === 'Object.hasOwn(captured, "nativeRetirementCustody")');
	if (start < 0 || stop <= start || retiredBlock === undefined) throw Error("VERIFIED_BRANCH_ORIGINAL_BLOCK_MISSING");
	let source = body.slice(start, stop + 1).map(s => s.getText(ast)).join("\n");
	if (cold) {
		const call = "evidenceOwner === undefined ? openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch({\n\t\t\t\t...verifiedBranch, closure,\n\t\t\t}, charge) : evidenceOwner.source(verifiedBranch, closure, charge)";
		if (!source.includes(call)) throw Error("VERIFIED_BRANCH_COLD_COMPARISON_SEAM_CHANGED");
		source = source.replace(call, "openCreatorSnapshotRecoverySourceTrust({currentTrust, closure, anchorChain: envelopes, exactCanonicalPinnedGenesisTrustStateRecordBytes: pinBytes})");
		source = source.replace("if (!trust.ok)", "if (!trust.ok || !charge(trust.derivedPredecessorTrustStateRecordBytes))");
	}
	const owner = execute<{open(input: unknown): any; job(): any; read(args: any): any}>(`${functions}
		function openCreatorSnapshotRecoveryRoleReadbackOwned({captured, materialValues, currentTrust, pinBytes, pinRecord, charge, input, roles}, evidenceOwner) {
			const chainValues = captured.anchorChain;
			${source}
			const protectedKeys = new Set(), allowed = new Set(), cut = {bytes: new Uint8Array()};
			${retiredBlock.getText(ast)}
			return {ok: true, materials: [...materials.values()]};
		}
		({open: openCreatorSnapshotRecoverySourceTrust, job: createCreatorSnapshotRecoveryEvidenceJob,
		read: input => openCreatorSnapshotRecoveryRoleReadbackOwned(input)});`, bindings);
	const job = owner.job();
	return {trust, envelopes, pinBytes, materials, captured, charged, proofCharges, job,
		newGenuineTrust: (patch: Record<string, unknown> = {}) => {const next = Object.freeze({...trust, ...patch}); genuineTrusts.add(next); return next;},
		counts: () => ({chains, pins, sources, retired}),
		open: (patch: any = {}) => owner.open({currentTrust: trust, closure: materials[1]!.closure,
			anchorChain: envelopes, exactCanonicalPinnedGenesisTrustStateRecordBytes: pinBytes, ...patch}),
		warmOpen: (patch: any = {}) => job.sourceTrust({currentTrust: trust, closure: materials[1]!.closure,
			anchorChain: envelopes, exactCanonicalPinnedGenesisTrustStateRecordBytes: pinBytes, ...patch}),
		read: () => {charge(pinBytes); return owner.read({captured, materialValues: materials, currentTrust: trust, pinBytes,
			pinRecord: decodeCanonical(pinBytes), charge, input, roles: {classifiedScopes: classified}});},
		warmRead: () => {charge(pinBytes); return job.readback({captured, materialValues: materials, currentTrust: trust, pinBytes,
			pinRecord: decodeCanonical(pinBytes), charge, input, roles: {classifiedScopes: classified}});},
	};
}

describe("recovery source invocation-local verified branch", () => {
	it("authenticates one chain/pin for three materials, preserving each original source verifier and charged bytes", () => {
		const fast = fixture(), cold = fixture(true);
		const actual = fast.read(); expect(actual).toEqual(cold.read()); expect(actual.ok).toBe(true);
		expect(fast.counts()).toEqual({chains: 1, pins: 1, sources: 3, retired: 1});
		expect(cold.counts()).toEqual({chains: 4, pins: 4, sources: 3, retired: 1});
		// Exact charge occurrence vector, not merely a byte-set comparison. The
		// private core owns the ONE derived charge in this same readback book;
		// the cold comparison retains the original inner + outer ledger split.
		expect(fast.charged).toEqual(cold.charged);
		const charged = new Set(fast.charged.map(bytes => Buffer.from(bytes).toString("hex")));
		for (const bytes of [fast.pinBytes, ...fast.envelopes.flatMap(e => [e.exactCanonicalAnchorPreimageBytes, e.detachedAnchorSignature,
			e.exactCanonicalParametersCarrierBytes]), ...fast.materials.flatMap(m => m.closure.candidates.map(c => c.bytes))])
			expect(charged.has(Buffer.from(bytes).toString("hex"))).toBe(true);
	});
	it("keeps the defensive source boundary cold on every call and rejects foreign trust or changed/reordered chain bytes", () => {
		const f = fixture(); expect(f.open().ok).toBe(true); expect(f.open().ok).toBe(true);
		expect(f.counts().chains).toBe(2); expect(f.counts().pins).toBe(2);
		expect(f.open({currentTrust: {...f.trust}}).ok).toBe(false);
		const changed = copy(f.envelopes); changed[0]!.detachedAnchorSignature[0] = 1;
		expect(f.open({anchorChain: changed}).ok).toBe(false);
		expect(f.open({anchorChain: [...f.envelopes].reverse()}).ok).toBe(false);
		expect(f.open({anchorChain: [...f.envelopes, f.envelopes[0]]}).ok).toBe(false);
		expect(f.open().ok).toBe(true);
	});
	it("does not reuse branch facts across readback calls after mutation, context changes or retirement-custody revocation", () => {
		for (const change of ["signature", "reorder", "foreign", "retired"] as const) {
			const f = fixture(); expect(f.read().ok).toBe(true);
			if (change === "signature") f.envelopes[0]!.detachedAnchorSignature[0] = 1;
			if (change === "reorder") f.envelopes.reverse();
			if (change === "foreign") f.trust.objectId = "foreign";
			if (change === "retired") f.captured.nativeRetirementCustody = {};
			expect(f.read().ok).toBe(false); expect(f.counts().chains).toBe(2);
		}
	});
	it("keeps per-source Cut/QC verification and exact same-epoch identity/closure membership", () => {
		for (const change of ["qc", "fork", "duplicate", "missing"] as const) {
			const f = fixture(), c = f.materials[1]!.closure;
			if (change === "qc") c.candidates[2] = candidate({kind: "drp-seal-qc", epoch: 1, phase: "commit", valid: false});
			if (change === "fork") c.candidates[0] = candidate({...f.trust, kind: "drp-anchor-trust-state", currentEpoch: 2, currentAnchorDigest: "fork"});
			if (change === "duplicate") c.candidates.push(c.candidates[0]!);
			if (change === "missing") c.candidates.pop();
			if (change === "qc" || change === "fork") c.closure = c.candidates.map(v => v.ref);
			expect(f.read().ok).toBe(false);
		}
	});
	it("does not expose the verified branch as a public capability or add retention past the synchronous owner", () => {
		expect(declaration("openCreatorSnapshotRecoverySourceTrust").parameters).toHaveLength(1);
		expect(declaration("openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch").modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).not.toBe(true);
		const source = declaration("openCreatorSnapshotRecoveryRoleReadbackOwned").getText(ast);
		expect(declaration("verifyCreatorRecoveryBranch").getText(ast).match(/inspectCreatorHistoricalAnchorChain\(/g)).toHaveLength(1);
		expect(source).not.toContain("openCreatorSnapshotRecoverySourceTrust({");
		expect(source).toContain("consumeCreatorRecoveryRoleRetiredReadback(");
	});
});

describe("one acquisition owns exact immutable recovery evidence", () => {
	it("reuses exact signed facts across fresh genuine equal trusts but never accepts a forged copy or changed context", () => {
		const f = fixture(); expect(f.warmOpen().ok).toBe(true);
		expect(f.warmOpen({currentTrust: f.newGenuineTrust()}).ok).toBe(true);
		expect(f.counts()).toEqual({chains: 1, pins: 1, sources: 1, retired: 0});
		expect(f.warmOpen({currentTrust: {...f.trust}}).ok).toBe(false);
		expect(f.counts().chains).toBe(1);
		for (const patch of [{objectId: "foreign"}, {currentEpoch: 5}, {currentAnchorDigest: "other"},
			{genesisAnchorDigest: "other"}, {profileId: "other"}]) {
			const changed = fixture(); expect(changed.warmOpen().ok).toBe(true);
			expect(changed.warmOpen({currentTrust: changed.newGenuineTrust(patch)}).ok).toBe(false);
			expect(changed.counts().chains).toBe(2);
		}
	});
	it("verifies one branch and each exact source once across source acquisition and final readback, with unchanged complete charges", async () => {
		const warm = fixture(), cold = fixture();
		for (let index = 0; index < warm.materials.length; index++) {
			expect(warm.warmOpen({closure: warm.materials[index]!.closure})).toEqual(cold.open({closure: cold.materials[index]!.closure}));
		}
		await Promise.resolve();
		expect(warm.warmRead()).toEqual(cold.read());
		expect(warm.counts()).toEqual({chains: 1, pins: 1, sources: 3, retired: 1});
		expect(cold.counts()).toEqual({chains: 4, pins: 4, sources: 6, retired: 1});
		expect(warm.proofCharges).toEqual(cold.proofCharges);
		expect(warm.charged).toEqual(cold.charged);
	});
	it("captures bytes and detaches returned derived records, rather than retaining mutable caller aliases", async () => {
		const f = fixture(), first = f.warmOpen(); expect(first.ok).toBe(true);
		const original = first.derivedPredecessorTrustStateRecordBytes.slice();
		first.derivedPredecessorTrustStateRecordBytes.fill(255);
		expect(f.warmOpen().derivedPredecessorTrustStateRecordBytes).toEqual(original);
		expect(f.counts().sources).toBe(1);
		await Promise.resolve();
		f.envelopes[0]!.detachedAnchorSignature[0] = 1;
		expect(f.warmOpen().ok).toBe(false);
		f.envelopes[0]!.detachedAnchorSignature[0] = 0;
		expect(f.warmOpen().ok).toBe(true); expect(f.counts().sources).toBe(2);
	});
	it("refuses changed same-epoch source, malformed membership, foreign nominal context and changed pin or branch after warm capture", async () => {
		for (const change of ["qc", "fork", "duplicate", "missing", "key", "pin", "reorder", "foreign", "context"] as const) {
			const f = fixture(); expect(f.warmOpen().ok).toBe(true); await Promise.resolve();
			const c = f.materials[1]!.closure;
			if (change === "qc") c.candidates[2] = candidate({kind: "drp-seal-qc", epoch: 1, phase: "commit", valid: false});
			if (change === "fork") c.candidates[0] = candidate({...f.trust, kind: "drp-anchor-trust-state", currentEpoch: 2, currentAnchorDigest: "fork"});
			if (change === "qc" || change === "fork") c.closure = c.candidates.map(v => v.ref);
			if (change === "duplicate") c.candidates.push(c.candidates[0]!);
			if (change === "missing") c.candidates.pop();
			if (change === "key") f.envelopes[0]!.detachedAnchorSignature[0] = 1;
			if (change === "pin") f.pinBytes[0] = 255;
			if (change === "reorder") f.envelopes.reverse();
			if (change === "context") f.trust.objectId = "foreign";
			expect(f.warmOpen(change === "foreign" ? {currentTrust: {...f.trust}} : {}).ok, change).toBe(false);
		}
	});
	it("always reconsumes native retirement custody and never substitutes historical verification for current authority", () => {
		const f = fixture(); expect(f.warmRead().ok).toBe(true); expect(f.warmRead().ok).toBe(true);
		expect(f.counts()).toEqual({chains: 1, pins: 1, sources: 3, retired: 2});
		f.captured.nativeRetirementCustody = {};
		expect(f.warmRead().ok).toBe(false); expect(f.counts().retired).toBe(3);
	});
	it("ends reuse on release/reopen and falls back within existing finite byte and entry retention caps", () => {
		const f = fixture(); expect(f.warmOpen().ok).toBe(true); expect(f.warmOpen().ok).toBe(true);
		expect(f.counts().sources).toBe(1); f.job.release();
		expect(f.warmOpen().ok).toBe(true); expect(f.warmOpen().ok).toBe(true);
		expect(f.counts().sources).toBe(3); expect(f.counts().chains).toBe(3);
		const reopened = fixture(); expect(reopened.warmOpen().ok).toBe(true); expect(reopened.counts().sources).toBe(1);
		const overflow = fixture(false, {...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: 1});
		expect(overflow.warmOpen().ok).toBe(true); expect(overflow.warmOpen().ok).toBe(true);
		expect(overflow.counts().sources).toBe(2); expect(overflow.counts().chains).toBe(2);
	});
});
