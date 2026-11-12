import { createWorkCheckpoint } from "../src/internal/cooperative-work.js";
import "fake-indexeddb/auto";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { copyCanonicalForAdmittedView } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { describe, expect, it, vi } from "vitest";
import { createBrowserDurableIssuanceStore } from "../../storage-browser/src/issuance.js";
import { prepareGenuineCreatorAdoptionFixture } from "../../../tests/fixtures/phase-6a-v3/creator-adoption-contract.js";

// The existing extraction machinery checks private syntax/crypto reuse only.
// Stubbed kernels below are not signature/native acceptance evidence; original
// native corruption-and-continuation scenarios remain mandatory.
function heldFactsFixture(bounds: { maxUnionBytes: number } = AHE_BOUNDED_READ_LIMITS, maximumFacts = 24576) {
	const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
	const parsed = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owner = parsed.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCensusVertexFacts");
	if (owner === undefined) throw Error("HELD_CENSUS_FACTS_OWNER_MISSING");
	const extract = vi.fn((input: { receivedCanonicalPreimageBytes: Uint8Array }): unknown => ({
		ok: true, vertex: { ...copyCanonicalForAdmittedView(decodeCanonical(input.receivedCanonicalPreimageBytes)) as object,
			digest: new Uint8Array(32).fill(7) },
	}));
	const verify = vi.fn((): {accepted: boolean; digest?: Uint8Array} => ({ accepted: true, digest: new Uint8Array(32).fill(8) }));
	const bindings = { IntrinsicMap: Map, MapPrototypeGet: Map.prototype.get, MapPrototypeSet: Map.prototype.set,
		MapPrototypeClear: Map.prototype.clear, MapPrototypeEntries: Map.prototype.entries, Uint8ArrayConstructor: Uint8Array,
		ReflectApply: Reflect.apply, ObjectFreeze: Object.freeze, V3_VERTEX_DOMAIN: "ts-drp/vertex/v3",
		ISSUANCE_RETIREMENT_LIMITS: { maxRows: maximumFacts }, AHE_BOUNDED_READ_LIMITS: bounds,
		hashDomain, decodeCanonical, encodeCanonical, copyCanonicalForAdmittedView,
		bytesToLowerHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
		sameBytes: (left: Uint8Array, right: Uint8Array) => compareBytes(left, right) === 0,
		copyDetachedBytes: (bytes: Uint8Array) => Uint8Array.from(bytes),
		isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
		extractAdmittedReceivedVertex: extract, verifyReceivedVertex: verify };
	const code = ts.transpileModule(owner.getText(parsed), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	const facts = new Function(...Object.keys(bindings), code + "\nreturn createCreatorCensusVertexFacts();")(...Object.values(bindings));
	let key = new Uint8Array(32).fill(1);
	const input = { domain: "ts-drp/vertex/v3", expectedAnchor: "anchor", suiteId: "suite", preparedBlueprintAdmission: {},
		receivedCanonicalPreimageBytes: encodeCanonical({ author: "alice", operation: { bytes: Uint8Array.of(2), text: "\ufeff\ufeffkept",
			map: new Map([["nested", new Set([3])]]), typed: new Float32Array([-0, 1]) } }),
		signature: new Uint8Array(64).fill(4), resolveAuthorPublicKey: () => ({ bytes: key, format: "raw" }) };
	return { facts, input, extract, verify, setKey: (bytes: Uint8Array) => { key = bytes; } };
}

describe("held census exact syntax and crypto facts", () => {
	it("shares only the live owner's bounded byte facts with replay seals while still reading every native tuple freshly", async () => {
		const f = heldFactsFixture(), fallback = heldFactsFixture(); f.facts.extract(f.input);
		const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		const tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const declaration = (name: string) => {
			const found = tree.statements.find((node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found === undefined) throw Error(`REPLAY_OWNER_MISSING:${name}`);
			return found.getText(tree);
		};
		const rows = [{sourceKind: "received", journalSequence: 0, byteCharge: f.input.receivedCanonicalPreimageBytes.byteLength + 64,
			digest: "original", exactCanonicalPreimageBytes: f.input.receivedCanonicalPreimageBytes.slice(),
			detachedSignature: f.input.signature.slice(), exactCanonicalVertexBytes: encodeCanonical({kind: "drp-vertex"})}];
		const copyRows = () => rows.map(row => ({...row, exactCanonicalPreimageBytes: row.exactCanonicalPreimageBytes.slice(),
			detachedSignature: row.detachedSignature.slice(), exactCanonicalVertexBytes: row.exactCanonicalVertexBytes.slice()}));
		const read = vi.fn(async () => copyRows()), create = vi.fn(() => fallback.facts), registry = new WeakMap();
		const bindings = {ObjectFreeze: Object.freeze, creatorReplayReads: registry,
			readCreatorReplayRows: read, createCreatorCensusVertexFacts: create,
			creatorReplayCommitment: () => ({digest: "commitment", rowCount: 1, byteCharge: rows[0]!.byteCharge}),
			sameBytes: (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0};
		const js = ts.transpileModule(`${declaration("sealCreatorReplay")}\n${declaration("sealCreatorDurableReplay")}\nreturn sealCreatorDurableReplay;`,
			{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
		const seal = new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;${js}`)(bindings);
		const registration = {payload: {}, authorization: {}, vertexFacts: f.facts};
		const first = await seal(registration), second = await seal(registration);
		expect(registry.get(first).vertexFacts).toBe(f.facts);
		expect(registry.get(second).vertexFacts).toBe(f.facts);
		expect(create).not.toHaveBeenCalled();
		expect(registry.get(first).vertexFacts.verify(f.input).digest[0]).toBe(7);
		expect(f.verify).not.toHaveBeenCalled();
		const before = read.mock.calls.length;
		expect(await first.verify()).toBe(true); expect(await second.verify()).toBe(true);
		expect(read.mock.calls.length - before).toBe(2);
		rows[0]!.detachedSignature[0] ^= 1;
		expect(await first.verify()).toBe(false);
		rows[0]!.detachedSignature[0] ^= 1;
		f.facts.release();
		expect(registry.get(first).vertexFacts.verify(f.input).digest[0]).toBe(8);
		expect(f.verify).toHaveBeenCalledTimes(1);
		const fresh = await seal({payload: {}, authorization: {}});
		expect(registry.get(fresh).vertexFacts).toBe(fallback.facts);
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("reuses unchanged owned bytes but returns detached nested admission values", () => {
		const { facts, input, extract } = heldFactsFixture();
		const first = facts.extract(input);
		const second = facts.extract({ ...input, receivedCanonicalPreimageBytes: Uint8Array.from(input.receivedCanonicalPreimageBytes) });
		expect(extract).toHaveBeenCalledTimes(1);
		first.vertex.digest[0] = 99;
		first.vertex.operation.bytes[0] = 99;
		second.vertex.operation.map.get("nested").add(99);
		const third = facts.extract(input);
		expect(third.vertex.digest[0]).toBe(7);
		expect(third.vertex.operation.bytes[0]).toBe(2);
		expect([...third.vertex.operation.map.get("nested")]).toEqual([3]);
		expect(third.vertex.operation.text).toBe("\ufeffkept");
		const original = decodeCanonical(input.receivedCanonicalPreimageBytes) as { operation: { typed: Float32Array } };
		expect(Object.is(third.vertex.operation.typed[0], -0)).toBe(Object.is(original.operation.typed[0], -0));
		const negativeZero = copyCanonicalForAdmittedView(new Float32Array([-0])) as Float32Array;
		expect(Object.is(negativeZero[0], -0)).toBe(true);
	});
	it("does not cross signature, key, suite, anchor, domain or ABI boundaries", () => {
		const { facts, input, extract, setKey } = heldFactsFixture();
		facts.extract(input);
		for (const altered of [{ ...input, signature: new Uint8Array(64).fill(5) },
			{ ...input, expectedAnchor: "other" }, { ...input, domain: "other" },
			{ ...input, suiteId: "other" }, { ...input, preparedBlueprintAdmission: {} }]) facts.extract(altered);
		setKey(new Uint8Array(32).fill(6)); facts.extract(input);
		expect(extract).toHaveBeenCalledTimes(7);
	});
	it("derives only pure verification from successful extraction and detaches digest bytes", () => {
		const { facts, input, extract, verify } = heldFactsFixture();
		facts.extract(input);
		const first = facts.verify(input); first.digest[0] = 99;
		// The ORIGINAL extraction's digest is 7; the independent kernel's is 8.
		// Reuse means implication, not a weakened comparison between the two.
		expect(facts.verify({...input, preparedBlueprintAdmission: {differentAbi: true}}).digest[0]).toBe(7);
		expect(extract).toHaveBeenCalledTimes(1); expect(verify).not.toHaveBeenCalled();
	});
	it("forks only detached signature facts, never admission or the old owner's lifetime", () => {
		const f = heldFactsFixture();
		const originalBytes = f.input.receivedCanonicalPreimageBytes.slice();
		f.facts.extract(f.input);
		// Even the ORIGINAL private caller cannot mutate the owner or a handoff.
		f.input.receivedCanonicalPreimageBytes.fill(0);
		const next = f.facts.forkVerification();
		f.facts.release();
		const input = {...f.input, receivedCanonicalPreimageBytes: originalBytes};
		expect(next.verify(input).digest[0]).toBe(7); expect(f.verify).not.toHaveBeenCalled();
		// Same ABI is not enough: the handoff contains no admitted view at all.
		next.extract(input); expect(f.extract).toHaveBeenCalledTimes(2);
		const successor = next.forkVerification(); next.release();
		expect(successor.verify(input).digest[0]).toBe(7);
		successor.release();
		expect(successor.verify(input).digest[0]).toBe(8); expect(f.verify).toHaveBeenCalledTimes(1);
	});
	it("resolves keys freshly after fork and misses altered bytes, context, signature and revoked admission", () => {
		const f = heldFactsFixture(); f.facts.extract(f.input);
		const next = f.facts.forkVerification();
		const resolve = vi.fn(f.input.resolveAuthorPublicKey);
		expect(next.verify({...f.input, resolveAuthorPublicKey: resolve}).digest[0]).toBe(7);
		expect(resolve).toHaveBeenCalledTimes(1);
		for (const altered of [{signature: new Uint8Array(64).fill(9)}, {expectedAnchor: "foreign"},
			{domain: "foreign"}, {suiteId: "foreign"},
			{receivedCanonicalPreimageBytes: encodeCanonical({author: "alice", objectId: "foreign"})}])
			expect(next.verify({...f.input, ...altered}).digest[0]).toBe(8);
		f.setKey(new Uint8Array(32).fill(6)); expect(next.verify(f.input).digest[0]).toBe(8);
		f.verify.mockReturnValueOnce({accepted: false});
		expect(next.verify({...f.input, resolveAuthorPublicKey: () => undefined})).toEqual({accepted: false});
		expect(f.verify).toHaveBeenCalledTimes(7);
	});
	it("does not carry failed results, unverified syntax, saturated or released facts", () => {
		const failed = heldFactsFixture();
		failed.extract.mockReturnValueOnce({ok: false}); failed.facts.extract(failed.input);
		failed.verify.mockReturnValueOnce({accepted: false}); failed.facts.verify(failed.input);
		expect(failed.facts.forkVerification().verify(failed.input).digest[0]).toBe(8);
		expect(failed.verify).toHaveBeenCalledTimes(2);
		for (const f of [heldFactsFixture(), heldFactsFixture({maxUnionBytes: 1})]) {
			f.facts.decode(f.input.receivedCanonicalPreimageBytes);
			expect(f.facts.forkVerification().verify(f.input).digest[0]).toBe(8);
			f.facts.extract(f.input); f.facts.release();
			expect(f.facts.forkVerification().verify(f.input).digest[0]).toBe(8);
		}
	});
	it("does not reuse a fact if key resolution mutates the requested bytes", () => {
		const f = heldFactsFixture(); f.facts.extract(f.input);
		const next = f.facts.forkVerification();
		const changed = encodeCanonical({author: "alice", operation: "altered"});
		expect(next.verify({...f.input, resolveAuthorPublicKey: () => {
			f.input.receivedCanonicalPreimageBytes.set(changed.subarray(0, f.input.receivedCanonicalPreimageBytes.length));
			return f.input.resolveAuthorPublicKey();
		}}).digest[0]).toBe(8);
		expect(f.verify).toHaveBeenCalledTimes(1);
	});
	it("does not multiply identical signature facts from different ABIs across nested handoffs", () => {
		const f = heldFactsFixture(AHE_BOUNDED_READ_LIMITS, 3);
		f.facts.extract(f.input); f.facts.extract({...f.input, preparedBlueprintAdmission: {other: true}});
		const next = f.facts.forkVerification().forkVerification();
		next.extract(f.input); next.extract(f.input);
		// Three slots: one exact source, one pure signature fact, one fresh ABI
		// extraction. Duplicate carried signature facts must not exhaust them.
		expect(f.extract).toHaveBeenCalledTimes(3);
	});
	it("records the original admission's pure tuple without retaining or re-encoding its admitted graph", () => {
		const f = heldFactsFixture();
		const original = f.extract(f.input) as {vertex: {digest: Uint8Array}};
		f.facts.retainVerification({preimage: f.input.receivedCanonicalPreimageBytes, signature: f.input.signature,
			key: new Uint8Array(32).fill(1), format: "raw", domain: f.input.domain, suite: f.input.suiteId,
			payload: {provenance: {anchorDigest: f.input.expectedAnchor}}, originalAdmitted: original.vertex});
		expect(f.facts.verify(f.input).digest[0]).toBe(7); expect(f.verify).not.toHaveBeenCalled();
		expect(f.facts.forkVerification().verify(f.input).digest[0]).toBe(7);
		f.facts.extract(f.input); expect(f.extract).toHaveBeenCalledTimes(2);
	});
	it("never derives extraction from verification or admits through another prepared ABI", () => {
		const f = heldFactsFixture(); f.facts.verify(f.input); f.facts.extract(f.input);
		f.facts.extract({...f.input, preparedBlueprintAdmission: {differentAbi: true}});
		expect(f.verify).toHaveBeenCalledTimes(1); expect(f.extract).toHaveBeenCalledTimes(2);
	});
	it("does not treat failed extraction as a signature fact", () => {
		const f = heldFactsFixture(); f.extract.mockReturnValueOnce({ok: false, reason: "admission-rejected"});
		expect(f.facts.extract(f.input).ok).toBe(false);
		expect(f.facts.verify(f.input).digest[0]).toBe(8); expect(f.verify).toHaveBeenCalledTimes(1);
	});
	it("runs the fresh resolver and refuses fact reuse for missing authorization, changed key or exact bytes", () => {
		const f = heldFactsFixture(); f.facts.extract(f.input);
		const resolver = vi.fn(f.input.resolveAuthorPublicKey);
		expect(f.facts.verify({...f.input, resolveAuthorPublicKey: resolver}).digest[0]).toBe(7);
		expect(resolver).toHaveBeenCalledTimes(1);
		f.verify.mockReturnValueOnce({accepted: false});
		expect(f.facts.verify({...f.input, resolveAuthorPublicKey: () => undefined})).toEqual({accepted: false});
		f.setKey(new Uint8Array(32).fill(6));
		expect(f.facts.verify(f.input).digest[0]).toBe(8); expect(f.verify).toHaveBeenCalledTimes(2);
		f.setKey(new Uint8Array(32).fill(1));
		f.input.receivedCanonicalPreimageBytes[f.input.receivedCanonicalPreimageBytes.length - 1] ^= 1;
		f.facts.verify(f.input); expect(f.verify).toHaveBeenCalledTimes(3);
		f.input.signature[0] ^= 1; f.facts.verify(f.input); expect(f.verify).toHaveBeenCalledTimes(4);
	});
	it("permanently disables retention without disabling original verification or extraction", () => {
		const f = heldFactsFixture(); f.facts.extract(f.input); f.facts.release(); f.facts.release();
		expect(f.facts.verify(f.input).digest[0]).toBe(8); f.facts.extract(f.input); f.facts.extract(f.input);
		expect(f.verify).toHaveBeenCalledTimes(1); expect(f.extract).toHaveBeenCalledTimes(3);
	});
	it("detaches returned syntax and validates normally after private retention saturates", () => {
		const { facts, input, extract } = heldFactsFixture({ ...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: 1 });
		facts.extract(input); facts.extract(input);
		expect(extract).toHaveBeenCalledTimes(2);
		const regular = heldFactsFixture();
		const parsed = regular.facts.decode(regular.input.receivedCanonicalPreimageBytes);
		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(Object.getPrototypeOf(parsed.operation)).toBeNull();
		parsed.operation.bytes[0] = 99;
		expect(regular.facts.decode(regular.input.receivedCanonicalPreimageBytes).operation.bytes[0]).toBe(2);
	});
	it("preserves null prototypes and own __proto__ keys without inheriting ambient record properties", () => {
		const regular = heldFactsFixture();
		const prototypeKey = Object.create(null) as Record<string, unknown>;
		prototypeKey["__proto__"] = Uint8Array.of(9);
		const prototypeBytes = encodeCanonical({ nested: prototypeKey });
		const copied = regular.facts.decode(prototypeBytes);
		expect(Object.getPrototypeOf(copied.nested)).toBeNull();
		expect(Object.hasOwn(copied.nested, "__proto__")).toBe(true);
		copied.nested["__proto__"][0] = 99;
		expect(regular.facts.decode(prototypeBytes).nested["__proto__"][0]).toBe(9);
		Object.defineProperty(Object.prototype, "__r10HeldCensusInherited", { value: 7, configurable: true });
		try {
			expect(regular.facts.decode(prototypeBytes).__r10HeldCensusInherited).toBeUndefined();
			expect(regular.facts.decode(prototypeBytes).nested.__r10HeldCensusInherited).toBeUndefined();
		} finally { Reflect.deleteProperty(Object.prototype, "__r10HeldCensusInherited"); }
	});
	it("keeps per-epoch kernel work constant across successive handoffs: history never saturates the owner", () => {
		// Each epoch forks the live owner into its successor, retires the old
		// owner, and runs a census over a bounded retention window (the newest
		// WINDOW epochs of vertices). Work per epoch must depend on the window,
		// not on how many epochs ever handed facts forward.
		const CAP = 256, NEW_PER_EPOCH = 4, WINDOW = 3, EPOCHS = 120;
		const f = heldFactsFixture(AHE_BOUNDED_READ_LIMITS, CAP);
		const vertex = (epoch: number, ordinal: number) => ({ ...f.input, preparedBlueprintAdmission: undefined as unknown,
			receivedCanonicalPreimageBytes: encodeCanonical({ author: "alice", operation: { epoch, ordinal } }) });
		let owner = f.facts;
		const work: number[] = [];
		for (let epoch = 1; epoch <= EPOCHS; epoch++) {
			const successor = owner.forkVerification();
			owner.release();
			owner = successor;
			const abi = { epoch }; // Every generation prepares its own blueprint admission.
			const before = f.extract.mock.calls.length + f.verify.mock.calls.length;
			for (let census = 0; census < 2; census++)
				for (let back = WINDOW - 1; back >= 0; back--)
					for (let ordinal = 0; ordinal < NEW_PER_EPOCH && epoch - back >= 1; ordinal++) {
						const input = { ...vertex(epoch - back, ordinal), preparedBlueprintAdmission: abi };
						expect(owner.extract(input).ok).toBe(true);
						expect(owner.verify(input).accepted).toBe(true);
					}
			work.push(f.extract.mock.calls.length + f.verify.mock.calls.length - before);
		}
		// Steady state: one extraction per window vertex per generation, all
		// repeats and verifications reused. Identical early and late.
		const steady = WINDOW * NEW_PER_EPOCH;
		expect({ epoch10: work[9], epoch60: work[59], epoch120: work[EPOCHS - 1], max: Math.max(...work.slice(WINDOW)) })
			.toEqual({ epoch10: steady, epoch60: steady, epoch120: steady, max: steady });
	});
});

// Exercise the ORIGINAL private owner declarations at deterministic seams.
// This proves dispatch/lifetime behavior, not native or cryptographic acceptance.
function executeLiveOwner<T>(names: readonly string[], expression: string, bindings: Record<string, unknown>): T {
	const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
	const parsed = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declarations = names.map(name => {
		const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === name);
		if (declaration === undefined) throw Error(`LIVE_OWNER_MISSING:${name}`);
		return declaration.getText(parsed);
	}).join("\n");
	const code = ts.transpileModule(declarations + "\nreturn " + expression + ";", {
		compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
	}).outputText;
	return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as T;
}

describe("same-owner explicit readiness refresh custody", () => {
	function fixture() {
		const source = readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8");
		const parsed = ts.createSourceFile("close.ts", source, ts.ScriptTarget.Latest, true);
		const fn = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "refreshCreatorOrdinarySourceReadiness");
		if (fn === undefined) throw Error("READINESS_REFRESH_OWNER_MISSING");
		const hold = {}, prior = {}, replacement = {}, calls: string[] = [];
		const runtime = {release: vi.fn(async () => {calls.push("release-runtime");})};
		const proof = {release: vi.fn(async () => {calls.push("release-proof");})};
		const registration = {store: {}, liveJournalStore: {}, currentTrust: {}, objectId: "room",
			sealOrdinaryIssuanceMaintenanceRuntime: vi.fn(async () => {calls.push("seal-runtime"); return hold as object | undefined;})};
		const input = {promotionContext: {catalog: {}}, readOrdinaryApplicationResourceBound: () => {}, storageIncarnation: "incarnation",
			snapshotStore: {}, ordinaryFinishingWindow: {maxAdditionalLocalRows: 5}, prospectiveSettlementPreview: () => {}};
		const acquire = vi.fn(async () => {calls.push("fresh-proof"); return proof as typeof proof | undefined;});
		const prepare = vi.fn(async () => {calls.push("prepare"); return replacement as object | undefined;});
		const resolver = vi.fn(() => runtime as typeof runtime | undefined), releaseHold = vi.fn(async () => {calls.push("release-hold");});
		const capacityRefusal = {};
		const bindings = {resolveCreatorOrdinaryIssuanceRuntimeHold: resolver, releaseCreatorOrdinaryIssuanceRuntimeHold: releaseHold,
			isCreatorOrdinarySourceCapacityRefusal: (value: unknown) => value === capacityRefusal,
			acquireCreatorOrdinaryIssuanceMaintenanceProof: acquire, prepareCreatorOrdinaryIssuanceProofSourceReadiness: prepare};
		const js = ts.transpileModule(fn.getText(parsed) + "\nreturn refreshCreatorOrdinarySourceReadiness;",
			{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
		const refresh = new Function(...Object.keys(bindings), js)(...Object.values(bindings));
		return {calls, hold, prior, replacement, registration, input, runtime, proof, acquire, prepare, resolver, releaseHold, capacityRefusal,
			run: () => refresh(registration, input, prior)};
	}
	it("reopens a new complete proof for the exact hint and joins it before delivering a replacement", async () => {
		const f = fixture(); let finish!: () => void;
		f.proof.release.mockImplementationOnce(() => new Promise<void>(resolve => {f.calls.push("release-proof"); finish = resolve;}));
		let delivered = false; const task = f.run().then((value: unknown) => {delivered = true; return value;});
		while (finish === undefined) await Promise.resolve();
		expect(delivered).toBe(false); expect(f.calls).toEqual(["seal-runtime", "fresh-proof", "prepare", "release-proof"]);
		finish(); expect(await task).toBe(f.replacement);
		expect(f.acquire.mock.calls[0]).toEqual([{...f.input.promotionContext, objectId: "room", store: f.registration.store,
			snapshotStore: f.input.snapshotStore, liveJournalStore: f.registration.liveJournalStore}, f.hold, f.registration.currentTrust, f.prior]);
		expect(f.prepare.mock.calls[0]).toEqual([f.proof, {reader: f.input.readOrdinaryApplicationResourceBound,
			storageIncarnation: "incarnation", actualProducerChunkBytes: 131072, window: f.input.ordinaryFinishingWindow,
			settlementPreview: f.input.prospectiveSettlementPreview}]);
	});
	it("treats only unsupported correspondence as a miss and still joins the actual admitted owner", async () => {
		const noProof = fixture(); noProof.acquire.mockResolvedValueOnce(undefined);
		expect(await noProof.run()).toBeUndefined(); expect(noProof.runtime.release).toHaveBeenCalledTimes(1);
		expect(noProof.prepare).not.toHaveBeenCalled();
		const unprepared = fixture(); unprepared.prepare.mockResolvedValueOnce(undefined);
		expect(await unprepared.run()).toBeUndefined(); expect(unprepared.proof.release).toHaveBeenCalledTimes(1);
		const noRuntime = fixture(); noRuntime.resolver.mockReturnValueOnce(undefined);
		expect(await noRuntime.run()).toBeUndefined(); expect(noRuntime.releaseHold).toHaveBeenCalledExactlyOnceWith(noRuntime.hold);
		expect(noRuntime.acquire).not.toHaveBeenCalled();
	});
	it("preserves authentication, stale-storage, accounting and cleanup failures instead of silently falling back", async () => {
		for (const owner of ["acquire", "prepare"] as const) {
			const f = fixture(), failure = Error(`${owner} actual safety refusal`); f[owner].mockRejectedValueOnce(failure);
			await expect(f.run()).rejects.toBe(failure);
			expect(owner === "acquire" ? f.runtime.release : f.proof.release).toHaveBeenCalledTimes(1);
		}
		const capacity = fixture(); capacity.prepare.mockRejectedValueOnce(capacity.capacityRefusal);
		expect(await capacity.run()).toBeUndefined(); expect(capacity.proof.release).toHaveBeenCalledTimes(1);
		const f = fixture(), failure = Error("original authentication failure"), cleanup = Error("join failed");
		f.prepare.mockRejectedValueOnce(failure); f.proof.release.mockRejectedValueOnce(cleanup);
		try { await f.run(); throw Error("must refuse"); } catch (error) {
			expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([failure, cleanup]);
		}
		const badJoin = fixture(); badJoin.prepare.mockRejectedValueOnce(badJoin.capacityRefusal);
		badJoin.proof.release.mockRejectedValueOnce(cleanup);
		await expect(badJoin.run()).rejects.toBeInstanceOf(AggregateError);
	});
});

describe("ordinary runtime candidate-free readiness producer", () => {
	it("uses only its own admitted native capture and refuses commit after context change, interruption or release", async () => {
		const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		const tree = ts.createSourceFile("live.ts", source, ts.ScriptTarget.Latest, true), matches: ts.FunctionExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "captureReadinessPreparation" && ts.isFunctionExpression(node.initializer))
				matches.push(node.initializer);
			ts.forEachChild(node, visit);
		}; visit(tree); expect(matches).toHaveLength(1);
		const make = () => {
			const state = {alive: true, identity: {}, native: {rows: {}, control: null}, available: true};
			const child = {}, lifetime: any = {}, nativeChildren = new Set([child]), registration = {};
			const facts = {check: () => {if (!state.alive) throw Error("runtime revoked");}};
			const commit = vi.fn(() => true), preparation = {}, capture = vi.fn(async () => ({preparation, commit}));
			const bindings = {state, lifetime, nativeChildren, issuanceChild: child, registration, facts,
				ObjectFreeze: Object.freeze, creatorOrdinaryIssuanceSourceIdentity: () => state.identity,
				captureOrdinaryReadinessPreparationForSizing: capture, admit: (job: () => Promise<unknown>) => job()};
			const js = ts.transpileModule(`let nativeIssuanceCapture=state.native,issuanceBorrowAvailable=state.available;
			 const method=${matches[0]!.getText(tree)};return {method,replaceNative:()=>{nativeIssuanceCapture={rows:{},control:null};}};`,
				{compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			return {...new Function(...Object.keys(bindings), js)(...Object.values(bindings)), state, child, lifetime, nativeChildren, registration, facts, commit, capture, preparation};
		};
		const f = make(), accounting = {}, staged = await f.method.call(f.lifetime, accounting);
		expect(staged.preparation).toBe(f.preparation);
		// ea4eb158: the capture's control parameter is DurableIssuanceRetirementControl | undefined;
		// the producer normalizes an absent native control (null) to undefined.
		expect(f.capture).toHaveBeenCalledExactlyOnceWith(f.facts, f.registration, f.state.identity, f.state.native.rows, undefined, accounting);
		expect(staged.commit()).toBe(true);
		f.state.identity = {}; expect(staged.commit()).toBe(false);
		const changed = make(), pending = await changed.method.call(changed.lifetime, accounting);
		changed.replaceNative(); expect(pending.commit()).toBe(false);
		const released = make(), captured = await released.method.call(released.lifetime, accounting);
		released.state.alive = false; expect(captured.commit()).toBe(false);
		const missing = make(); missing.nativeChildren.delete(missing.child);
		expect(await missing.method.call(missing.lifetime, accounting)).toBeUndefined(); expect(missing.capture).not.toHaveBeenCalled();
		await expect(missing.method.call({}, accounting)).rejects.toThrow("foreign");
		const interrupted = make(); interrupted.capture.mockImplementationOnce(async () => {interrupted.state.alive = false; return {preparation: {}, commit: interrupted.commit};});
		await expect(interrupted.method.call(interrupted.lifetime, accounting)).rejects.toThrow("runtime revoked");
		expect(interrupted.commit).not.toHaveBeenCalled();
	});
});

describe("mandatory fence immutable source handoff", () => {
	it("captures exact local-fence DATA before UNKNOWN charging without feeding it to the ordinary compiler", async () => {
		const source = readFileSync(new URL("../src/creator-close.ts", import.meta.url), "utf8");
		const tree = ts.createSourceFile("close.ts", source, ts.ScriptTarget.Latest, true), matches: ts.Block[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isIfStatement(node) && node.expression.getText(tree) === "quote === undefined" && ts.isBlock(node.thenStatement) &&
				node.thenStatement.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(value => value.name.getText(tree) === "cold")))
				matches.push(node.thenStatement);
			ts.forEachChild(node, visit);
		}; visit(tree); expect(matches).toHaveLength(1);
		const make = () => {
			const events: string[] = [], hint = {}, proof = {}, unsignedBytes = Uint8Array.of(1, 2), registration = {};
			const state: any = {planEffect: {kind: "fence"}, receivedReceipt: undefined,
				input: {readOrdinaryApplicationResourceBound: () => {}}};
			const capture = vi.fn(async () => {events.push("capture-hint"); return hint as object | undefined;});
			const charge = vi.fn(async () => {events.push("charge-UNKNOWN"); return false;});
			const bindings = {state, registration, unsignedBytes,
				prepareCreatorIssuanceMaintenanceQuote: async () => {events.push("cold-proof"); return {proof};},
				captureCreatorOrdinaryIssuanceProofSourceForFence: capture,
				captureCreatorOrdinaryIssuanceProofSource: () => {throw Error("not ordinary operation authority");},
				chargeCreatorIssuanceMaintenanceQuote: charge, report: () => {events.push("observe");},
				// The job's host checkpoint between cold quote spans; its budget never expires here.
				cooperate: async () => undefined};
			const js = ts.transpileModule(`return (async()=>{let quote,ordinaryProofSource,ordinaryTemplateReady=false;
			 const ordinaryDomain=false,{input,planEffect,receivedReceipt}=state;
			 ${matches[0]!.getText(tree)}
			 return {quote,ordinaryProofSource,ordinaryTemplateReady};})();`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
			return {events, hint, proof, unsignedBytes, state, capture, charge,
				run: () => new Function(...Object.keys(bindings), js)(...Object.values(bindings))};
		};
		const f = make(), result = await f.run();
		expect(f.events.slice(0, 3)).toEqual(["cold-proof", "capture-hint", "charge-UNKNOWN"]);
		expect(f.capture).toHaveBeenCalledExactlyOnceWith(f.proof, f.unsignedBytes);
		expect(f.charge.mock.calls[0]!.at(-1)).toBeUndefined();
		expect(result.ordinaryProofSource).toBe(f.hint); expect(result.ordinaryTemplateReady).toBe(false);
		for (const unsupported of ["replacement", "received", "archive", "no-bound"] as const) {
			const g = make();
			if (unsupported === "replacement") g.state.planEffect = {kind: "replacement"};
			if (unsupported === "received") g.state.receivedReceipt = {};
			if (unsupported === "archive") g.state.input.archive = {};
			if (unsupported === "no-bound") delete g.state.input.readOrdinaryApplicationResourceBound;
			expect((await g.run()).ordinaryProofSource).toBeUndefined(); expect(g.capture).not.toHaveBeenCalled();
			expect(g.charge).toHaveBeenCalledTimes(1);
		}
		const noHint = make(); noHint.capture.mockResolvedValueOnce(undefined);
		expect((await noHint.run()).ordinaryProofSource).toBeUndefined(); expect(noHint.charge).toHaveBeenCalledTimes(1);
		const corrupt = make(), error = Error("original source authentication failed"); corrupt.capture.mockRejectedValueOnce(error);
		await expect(corrupt.run()).rejects.toBe(error); expect(corrupt.charge).not.toHaveBeenCalled();
	});
});

// Isolate the ORIGINAL hidden-native loop and its original replay-owned facts
// capture. Callback stubs observe dispatch only, not native/crypto acceptance.
describe("same-held census immutable input reuse", () => {
	it("keeps the real browser issuance facade immutable like the SQLite facade", async () => {
		// Fake IndexedDB checks the facade contract only; the matched healthy
		// browser fixture separately checks genuine native lifetime behavior.
		const primaryDatabaseName = "held-census-frozen-browser-facade";
		const store = await createBrowserDurableIssuanceStore({primaryDatabaseName});
		try {
			expect(Object.isFrozen(store)).toBe(true);
			const read = store.readIssued;
			expect(Reflect.set(store, "readIssued", async () => null)).toBe(false);
			expect(store.readIssued).toBe(read);
			expect(await store.readLineage({objectId: "room", author: "writer"})).toEqual({next: 0, exhausted: false});
		} finally {
			await store.close();
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
				request.onblocked = () => reject(Error("frozen browser facade cleanup blocked"));
			});
		}
	});
	function fixture() {
		const state = {alive: true, live: true, identity: {}, key: {format: "raw", bytes: new Uint8Array(32).fill(4)}, native: {rows: {issued: [{preimage: Uint8Array.of(7), signature: new Uint8Array(64)}],
			lineages: [], plans: [], outbox: []}, image: {digest: "actual"}, control: null}, pages: [] as unknown[], replay: true};
		const copy = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
		const read = vi.fn(async () => copy(state.native)), page = vi.fn(async () => copy(state.pages)), replay = vi.fn(async () => state.replay);
		const store = Object.freeze({readOutboxPage: page}), maintenance = Object.freeze({readBoundedRecoveryCensus: read});
		const floors = new WeakMap(), trust = {objectId: "room", currentEpoch: 3}, counted = new Set([1]);
		const historicalIdentity = Object.freeze({closedEpoch: 2, author: "writer"});
		const registration: any = {issuanceStore: store, liveJournalStore: Object.freeze({readiness: () => {}, readPage: () => {}}),
			closeVertices: new Map([["vertex", {kind: "drp-vertex", hash: "vertex", operation: {bytes: Uint8Array.of(3)}}]]),
			closeCharges: new Map([["vertex", 80]]), closeAuthors: new Map([["vertex", {author: "writer", authorSequence: 1}]]),
			pendingIngress: new Map(), pendingIngressBytes: 0,
			payload: {trust: {trust}, provenance: {epoch: 3}, parameters: {maxEpochVertices: 64},
				exactProjectionBytes: Uint8Array.of(1), catalog: {canonicalBlueprintPackageBytes: Uint8Array.of(2), exactArtifactBytes: Uint8Array.of(3)}},
			authorization: {kind: "latched-acl", value: {writers: ["writer"]}}, issuanceScope: {objectId: "room", author: "writer"},
			historicalIssuance: {capability: {}, originalIssuanceStore: store, count: 1, countedSequences: counted,
				maxEpochVertices: 64, scopeAuthorMatches: true}};
		const runtime = {currentTrust: trust, sourceBound: true}, held = Object.freeze({store, objectId: "room", available: () => state.alive});
		const captured = {pages: [{afterKey: null, bytes: encodeCanonical(state.pages)}], applicationPolicyRead: false, retainedBytes: 1, overCapacity: false};
		const prepare = executeLiveOwner<any>(["captureCreatorOrdinaryPreparedVertex", "creatorOrdinaryPreparedVertexCurrent",
			"creatorOrdinaryPreparedVerticesCurrent", "prepareCreatorUnchangedHeldCensusRead"], "prepareCreatorUnchangedHeldCensusRead", {
			ObjectIsFrozen: Object.isFrozen, ObjectFreeze: Object.freeze, Uint8ArrayConstructor: Uint8Array,
			ReflectApply: Reflect.apply, SetPrototypeValues: Set.prototype.values,
			SetIteratorNext: Object.getPrototypeOf(new Set().values()).next,
			ISSUANCE_RETIREMENT_LIMITS: {maxRows: 4096}, AHE_BOUNDED_READ_LIMITS,
			preparedMigrationTargetFloors: floors, creatorOriginalIssuanceStore: () => store,
			durableIssuancePruningMaintenanceForStore: (value: unknown) => value === store ? maintenance : undefined,
			creatorOrdinaryIssuanceSourceIdentity: () => state.identity,
			resolveVerifiedCreatorHistoricalIssuance: () => Object.freeze({...historicalIdentity}),
			resolveV3AuthorizedAuthor: () => state.key,
			captureCreatorOrdinaryDimensionIntegrity: (value: unknown) => {
				const bytes = encodeCanonical(value);
				return () => {try {return compareBytes(encodeCanonical(value), bytes) === 0;} catch {return false;} };
			},
			encodeCanonical, decodeCanonical, sameBytes: (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0,
		});
		const make = (journalCurrent?: (held: unknown) => Promise<boolean | undefined>) =>
			prepare(registration, runtime, {verify: replay}, encodeCanonical({nativeIssuance: state.native}),
				() => state.live, captured, held, journalCurrent);
		return {state, read, page, replay, registration, runtime, held, captured, floors, counted, make};
	}
	it("reads complete native inputs and replay freshly on every call, owning isolated page bytes", async () => {
		const f = fixture(), check = f.make(); expect(check).toBeTypeOf("function");
		f.captured.pages[0]!.bytes.fill(255); f.captured.pages.length = 0;
		expect(await check(f.held)).toBe(true); expect(await check(f.held)).toBe(true);
		expect(f.read).toHaveBeenCalledTimes(2); expect(f.page).toHaveBeenCalledTimes(2); expect(f.replay).toHaveBeenCalledTimes(2);
		expect(await check({...f.held})).toBeUndefined(); // No new lease/reopen borrowing.
	});
	it("uses an original held-native probe without recopying rows, but checks replay, context and revocation freshly", async () => {
		const f = fixture(), current = vi.fn(async () => true);
		(f.captured as any).nativeCurrent = Object.freeze({checkCurrent: current});
		const check = f.make();
		expect(await check(f.held)).toBe(true); expect(await check(f.held)).toBe(true);
		expect(current).toHaveBeenCalledTimes(2); expect(f.replay).toHaveBeenCalledTimes(2);
		expect(f.read).not.toHaveBeenCalled(); expect(f.page).not.toHaveBeenCalled();
		current.mockResolvedValueOnce(false); expect(await check(f.held)).toBeUndefined();
		f.state.replay = false; expect(await check(f.held)).toBe(false);
		f.state.replay = true;
		current.mockImplementationOnce(async () => {f.registration.authorization.value.writers.push("foreign"); return true;});
		expect(await check(f.held)).toBeUndefined();
		f.registration.authorization.value.writers.pop(); f.state.alive = false;
		const calls = current.mock.calls.length; expect(await check(f.held)).toBeUndefined(); expect(current).toHaveBeenCalledTimes(calls);
	});
	it("reuses only a verified same-held journal image, preserving fresh graph, charge, key and mutable-leaf checks", async () => {
		const f = fixture(), currency = vi.fn(async () => true as boolean | undefined);
		(f.captured as any).nativeCurrent = {checkCurrent: async () => true};
		const check = f.make(currency);
		expect(await check(f.held)).toBe(true); expect(await check(f.held)).toBe(true);
		expect(currency).toHaveBeenCalledTimes(2); expect(f.replay).not.toHaveBeenCalled();
		currency.mockResolvedValueOnce(undefined);
		expect(await check(f.held)).toBe(true); expect(f.replay).toHaveBeenCalledTimes(1);
		for (const change of ["operation", "charge", "key", "identity", "map-row", "size"] as const) {
			const g = fixture(), current = g.make(async () => true);
			if (change === "operation") g.registration.closeVertices.get("vertex").operation.bytes[0] ^= 1;
			if (change === "charge") g.registration.closeCharges.set("vertex", 81);
			if (change === "key") g.state.key.bytes[0] ^= 1;
			if (change === "identity") g.registration.closeAuthors.set("vertex", {author: "writer", authorSequence: 2});
			if (change === "map-row") g.registration.closeVertices.set("vertex", {kind: "drp-vertex", hash: "vertex", operation: {bytes: Uint8Array.of(3)}});
			if (change === "size") g.registration.closeVertices.set("other", {});
			expect(await current(g.held), change).toBe(false);
		}
	});
	it("keeps journal currency unarmed until full verification, and refuses to reuse released or changed native owners", async () => {
		const check = executeLiveOwner<any>(["checkCreatorHeldRecoveryJournal"], "checkCreatorHeldRecoveryJournal", {});
		const state = {alive: true}, held = {available: () => state.alive}, producer = () => {}, owner = {readRetirementImage: producer};
		const native = vi.fn(async () => ({ok: true, value: null}));
		const current = {held, owner, producer, probe: {checkCurrent: native}, verified: false}, registration = {liveJournalStore: owner};
		expect(await check(current, held, registration)).toBeUndefined(); expect(native).not.toHaveBeenCalled();
		current.verified = true;
		expect(await check(current, held, registration)).toBe(true); expect(native).toHaveBeenCalledTimes(1);
		expect(await check(current, {...held}, registration)).toBeUndefined();
		native.mockResolvedValueOnce({ok: false} as any); expect(await check(current, held, registration)).toBeUndefined();
		owner.readRetirementImage = () => {}; expect(await check(current, held, registration)).toBeUndefined();
		owner.readRetirementImage = producer;
		let finish!: (value: {ok: true; value: null}) => void;
		native.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
		const pending = check(current, held, registration); state.alive = false; finish({ok: true, value: null});
		expect(await pending).toBeUndefined();
		expect(await check(current, held, registration)).toBeUndefined();
	});
	it("refuses changed complete PRE, signatures, controls or replay even with unchanged image metadata", async () => {
		for (const change of ["preimage", "signature", "control", "replay"] as const) {
			const f = fixture(), check = f.make();
			if (change === "replay") f.state.replay = false;
			else if (change === "control") (f.state.native as any).control = {revision: 1};
			else f.state.native.rows.issued[0]![change][0] ^= 1;
			expect(await check(f.held), change).toBe(false);
		}
	});
	it("requests original validation for changed context, history counters, foreign view or prepared floor", async () => {
		for (const change of ["identity", "authorization", "history", "history-append", "metadata", "scope", "foreign", "floor", "carrier"] as const) {
			const f = fixture(), check = f.make();
			if (change === "identity") f.state.identity = {};
			if (change === "authorization") f.registration.authorization.value.writers.push("foreign");
			if (change === "history") {f.counted.clear(); f.registration.historicalIssuance.count = 0;}
			if (change === "history-append") f.counted.add(2);
			if (change === "metadata") f.registration.payload.parameters = {maxEpochVertices: 63};
			if (change === "scope") f.registration.issuanceScope = {objectId: "foreign", author: "writer"};
			if (change === "foreign") f.state.pages.push({objectId: "other-room"});
			if (change === "floor") f.floors.set(f.registration, {});
			if (change === "carrier") f.registration.payload.catalog.exactArtifactBytes[0] ^= 1;
			expect(await check(f.held), change).toBeUndefined();
		}
	});
	it("joins a delayed native read without delivering reusable facts after revocation", async () => {
		const f = fixture(), check = f.make(); let finish!: (value: typeof f.state.native) => void;
		f.read.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
		const pending = check(f.held); f.state.alive = false; finish(f.state.native);
		expect(await pending).toBeUndefined(); expect(f.replay).not.toHaveBeenCalled();
	});
	it("treats optional context/view encoding failures as misses but preserves native and replay errors", async () => {
		const malformed = fixture(), check = malformed.make();
		malformed.registration.authorization.value.nonCanonical = () => 1;
		expect(await check(malformed.held)).toBeUndefined();
		const view = fixture(), viewCheck = view.make(); view.page.mockResolvedValueOnce([{nonCanonical: () => 1}]);
		expect(await viewCheck(view.held)).toBeUndefined();
		for (const port of ["read", "page", "replay"] as const) {
			const f = fixture(), current = f.make(), error = Error(`original ${port} failure`);
			f[port].mockRejectedValueOnce(error); await expect(current(f.held)).rejects.toBe(error);
		}
	});
	it("keeps callback-bearing and over-capacity work on the complete original path", () => {
		for (const flag of ["applicationPolicyRead", "overCapacity"] as const) {
			const f = fixture(); f.captured[flag] = true; expect(f.make()).toBeUndefined();
		}
		const f = fixture(); f.runtime.sourceBound = false; expect(f.make()).toBeUndefined();
	});
});

function hiddenNativeOutboxFixture(kind: "pinned" | "covered" | "settled" = "pinned") {
	const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
	const tree = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owner = tree.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "readCreatorRecoveryDependencyCensus");
	if (owner?.body === undefined) throw Error("RECOVERY_CENSUS_OWNER_MISSING");
	const capture = owner.body.statements.find(node => ts.isVariableStatement(node) &&
		node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === "vertexFacts"));
	const loop = owner.body.statements.filter((node): node is ts.ForOfStatement =>
		ts.isForOfStatement(node) && node.expression.getText(tree) === "nativeRows.outbox");
	if (capture === undefined || loop.length !== 1) throw Error("HIDDEN_NATIVE_OUTBOX_LOOP_MISSING");
	const vertexFacts = {}, replay = {}, issuanceStore = {}, capability = {};
	const historical = {capability, filteredIssuanceStore: issuanceStore};
	const registration = {issuanceStore, historicalIssuance: historical, payload: {}, authorization: {},
		exactCanonicalPinnedGenesisBootstrapOperationBytes: Uint8Array.of(1)};
	const native = {author: "alice", authorSequence: 4, objectId: "object", digest: new Uint8Array(32).fill(7),
		publishState: "published"};
	const nativeRows = {outbox: [native], issued: [{author: native.author, authorSequence: native.authorSequence,
		canonicalPreimageBytes: Uint8Array.of(2), signature: new Uint8Array(64).fill(3), digest: native.digest}]};
	const current = {identity: {author: native.author, objectId: native.objectId} as
		{author: string; objectId: string} | undefined};
	const authenticated = {author: native.author, authorSequence: native.authorSequence,
		digest: Buffer.from(native.digest).toString("hex")};
	const pinned = vi.fn((..._args: unknown[]) => kind === "pinned" ? authenticated : undefined);
	const covered = vi.fn((..._args: unknown[]) => kind === "covered" ? authenticated : undefined);
	const settled = vi.fn((..._args: unknown[]) => kind === "settled" ? authenticated : undefined);
	const resolve = vi.fn(() => current.identity), count = vi.fn(() => true);
	const frontier = {}, settlement = vi.fn(() => frontier);
	const fields = vi.fn((...args: unknown[]) => args);
	const rows: unknown[] = [], scopes = new Map();
	const bindings = {checkpoint: createWorkCheckpoint(), live: () => true, registration, nativeRows, currentTrust: {genesisAnchorDigest: "genesis"},
		observation: {replay}, creatorReplayReads: new WeakMap([[replay, {vertexFacts}]]),
		visibleNative: new Map(), rows, scopes,
		resolveVerifiedCreatorHistoricalIssuance: resolve, countHistoricalIssuanceRow: count,
		authenticatedPinnedGenesisOutboxRow: pinned, authenticatedCoveredHistoricalOutboxRow: covered,
		authenticatedSettlementSourceRow: settled, settlementFrontierFromHistory: settlement,
		creatorIssuanceCensusFields: fields,
		lowerHexDigest: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")};
	const code = ts.transpileModule(`${capture.getText(tree)}\n${loop[0]!.getText(tree)}\nreturn {rows, scopes};`, {
		compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
	}).outputText;
	const run = () => new Function(...Object.keys(bindings), `return (async () => {${code}})();`)(...Object.values(bindings));
	return {run, vertexFacts, registration, historical, native, nativeRows, current, pinned, covered, settled,
		resolve, count, settlement, frontier, fields, rows};
}

describe("hidden native outbox census verification facts", () => {
	it("passes the replay's exact owner to all three original authentication seams", async () => {
		for (const kind of ["pinned", "covered", "settled"] as const) {
			const f = hiddenNativeOutboxFixture(kind);
			expect((await f.run()).rows).toHaveLength(1);
			expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.historical.capability);
			expect(f.count).toHaveBeenCalledExactlyOnceWith(f.historical, f.native.authorSequence);
			for (const authenticate of [f.pinned, f.covered, f.settled]) {
				expect(authenticate).toHaveBeenCalledTimes(1);
				expect(authenticate.mock.calls[0]!.at(-1)).toBe(f.vertexFacts);
			}
			expect(f.covered.mock.calls[0]![4]).toBe("historical");
			expect(f.settled.mock.calls[0]![7]).toBe(f.frontier);
			expect(f.fields.mock.calls[0]![4]).toBe(kind === "pinned" ? "pinned-genesis"
				: kind === "covered" ? "covered-historical" : "filtered-settlement-source");
		}
	});
	it("refuses unavailable or foreign current historical identity before authentication", async () => {
		for (const identity of [undefined, {author: "foreign", objectId: "object"}, {author: "alice", objectId: "foreign"}]) {
			const f = hiddenNativeOutboxFixture(); f.current.identity = identity;
			expect(await f.run()).toBeUndefined();
			expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.historical.capability);
			for (const authenticate of [f.pinned, f.covered, f.settled]) expect(authenticate).not.toHaveBeenCalled();
			expect(f.count).not.toHaveBeenCalled(); expect(f.rows).toHaveLength(0);
		}
		const foreignFacade = hiddenNativeOutboxFixture(); foreignFacade.registration.issuanceStore = {};
		expect(await foreignFacade.run()).toBeUndefined(); expect(foreignFacade.resolve).not.toHaveBeenCalled();
		for (const authenticate of [foreignFacade.pinned, foreignFacade.covered, foreignFacade.settled])
			expect(authenticate).not.toHaveBeenCalled();
	});
	it("still freshly enforces native completeness, publication, and the historical count guard", async () => {
		for (const missing of ["issued", "publication"] as const) {
			const f = hiddenNativeOutboxFixture();
			if (missing === "issued") f.nativeRows.issued.length = 0;
			else f.native.publishState = "pending";
			expect(await f.run()).toBeUndefined(); expect(f.resolve).toHaveBeenCalledTimes(1);
			for (const authenticate of [f.pinned, f.covered, f.settled]) expect(authenticate).not.toHaveBeenCalled();
			expect(f.count).not.toHaveBeenCalled();
		}
		const f = hiddenNativeOutboxFixture(); f.count.mockReturnValueOnce(false);
		expect(await f.run()).toBeUndefined(); expect(f.rows).toHaveLength(0);
		expect(f.count).toHaveBeenCalledExactlyOnceWith(f.historical, f.native.authorSequence);
		expect((await f.run()).rows).toHaveLength(1); expect(f.resolve).toHaveBeenCalledTimes(2); expect(f.count).toHaveBeenCalledTimes(2);
	});
});

describe("same adoption verification facts through original close custody", () => {
	it("rejects foreign/revoked lifetime calls immediately and joins admitted reads without clearing another child", async () => {
		const f = heldFactsFixture(); f.facts.extract(f.input);
		const store = {}, journal = {}, trust = {objectId: "object", currentEpoch: 2, currentAnchorDigest: "anchor"};
		const registry = new WeakMap<object, any>();
		const make = () => {
			const hold = {}, facts = {kind: "full-census", releasing: false, pending: new Set<Promise<unknown>>(),
				context: {payload: {input: {store}, trust: {trust}}, liveJournalStore: journal,
					historicalIssuance: {vertexFacts: f.facts}}, dependencyAnchors: [], sourceTrust: undefined};
			registry.set(hold, facts);
			const lifetime = executeLiveOwner<any>(["fullRecoveryCloseHoldFacts", "resolveRecoveryCloseHold"],
				"resolveRecoveryCloseHold(hold, owners)", {ObjectFreeze: Object.freeze, recoveryCloseHolds: registry,
					hold, owners: {store, liveJournalStore: journal, currentTrust: trust}, verifyReceivedVertex: f.verify});
			return {facts, lifetime};
		};
		const first = make(), second = make();
		expect(first.lifetime.verifyVertex(f.input).digest[0]).toBe(7);
		expect(() => first.lifetime.verifyVertex.call({...first.lifetime}, f.input)).toThrow("hold is unavailable");
		let resume!: () => void;
		first.facts.pending.add(new Promise<void>(resolve => {resume = resolve;}));
		let joined = false; const released = first.lifetime.release().then(() => {joined = true;});
		expect(() => first.lifetime.verifyVertex(f.input)).toThrow("hold is unavailable");
		await Promise.resolve(); expect(joined).toBe(false);
		expect(second.lifetime.verifyVertex(f.input).digest[0]).toBe(7); expect(f.verify).not.toHaveBeenCalled();
		resume(); await released; expect(joined).toBe(true); await second.lifetime.release();
	});
	it("old predecessor deactivation cannot clear the new successor's shared historical facts", () => {
		const old = heldFactsFixture(), next = heldFactsFixture(); old.facts.extract(old.input); next.facts.extract(next.input);
		const predecessorValidation = {vertexFacts: next.facts}, successorRuntime = {vertexFacts: next.facts};
		const registration = (historicalIssuance: {vertexFacts: unknown}) => ({active: true, historicalIssuance, vertexFacts: historicalIssuance.vertexFacts, pendingIngress: new Map(),
			pendingIngressBytes: 0, networkNode: {unsubscribe() {}}, messageQueueManager: {close() {}}, queueId: "q", topic: "topic"});
		const deactivate = (value: unknown): boolean =>
			executeLiveOwner<boolean>(
				[
					"deactivateRegistration",
					"releaseIdleEgressAdmissionOwner",
					"retireRetainedReplay",
					"releaseRetainedReplayPrefix",
				],
				"deactivateRegistration(registration)",
				{
			registration: value, ordinaryRuntimeCapacityGeometry: new WeakMap(), v3PlaneRegistrations: new WeakMap(),
					v3EgressAdmissionOwners: new WeakMap(),
			topicMembership: () => false, hasQueueGuarded: () => false});
		deactivate(registration({vertexFacts: old.facts}));
		expect(predecessorValidation.vertexFacts).toBe(successorRuntime.vertexFacts);
		expect(next.facts.verify(next.input).digest[0]).toBe(7); expect(next.verify).not.toHaveBeenCalled();
		deactivate(registration(successorRuntime));
		expect(next.facts.verify(next.input).digest[0]).toBe(8); expect(next.verify).toHaveBeenCalledTimes(1);
		const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		expect(source).toContain("const successorHistoricalIssuance = receiveOnly ? undefined : openHistoricalIssuance()");
		expect(source).toContain("creatorHistoricalIssuanceHandoffs.set(successor, successorHistoricalIssuance)");
		expect(source).toContain("historicalIssuance: recovered.historicalIssuance");
		expect(source).toContain("context: registration");
	});
	it("clears failed activation's facts rather than retaining abandoned one-use handoffs", async () => {
		const release = vi.fn();
		const result = await executeLiveOwner<Promise<{ok: boolean; kind: string}>>(["activateCreatorSuccessorLive"],
			"activateCreatorSuccessorLive(material, {})", {material: {predecessor: {}, successor: {}}, ObjectFreeze: Object.freeze,
				createCreatorCensusVertexFacts: () => ({release}), creatorSuccessorTransportHandoff: () => undefined,
				prepareExistingCreatorGeneration: async () => undefined});
		expect(result).toMatchObject({ok: false, kind: "preparation-rejected"}); expect(release).toHaveBeenCalledTimes(1);
	});
	it("healthy transport replacement releases predecessor facts even when its inactive handle remains retained", () => {
		const old = heldFactsFixture(), next = heldFactsFixture();
		old.facts.extract(old.input); next.facts.extract(next.input);
		const existing = {active: true, vertexFacts: old.facts, historicalIssuance: {vertexFacts: old.facts},
			pendingIngress: new Map([["pending", {}]]), pendingIngressBytes: 7};
		const registration = {historicalIssuance: {vertexFacts: next.facts}, hotPredecessor: undefined as WeakRef<object> | undefined};
		const source = readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8");
		const parsed = ts.createSourceFile("v3-live.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const owner = parsed.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "activateV3LivePlane");
		if (owner === undefined) throw Error("LIVE_ACTIVATION_OWNER_MISSING");
		const replacements: ts.IfStatement[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isIfStatement(node) && node.expression.getText(parsed) === "reusesTransport") replacements.push(node);
			ts.forEachChild(node, visit);
		};
		visit(owner);
		expect(replacements).toHaveLength(1);
		const code = ts.transpileModule(replacements[0]!.getText(parsed), {
			compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
		}).outputText;
		const retire = executeLiveOwner<(registration: unknown) => void>(
			["retireRetainedReplay", "releaseRetainedReplayPrefix"],
			"retireRetainedReplay",
			{}
		);
		new Function("existing", "registration", "reusesTransport", "WeakRefConstructor", "retireRetainedReplay", code)(
			existing,
			registration,
			true,
			WeakRef,
			retire
		);
		expect(existing.active).toBe(false);
		expect(existing.pendingIngress.size).toBe(0); expect(existing.pendingIngressBytes).toBe(0);
		expect(registration.hotPredecessor!.deref()).toBe(existing);
		// Deliberately keep existing and its facts reachable: release must be
		// explicit, not dependent on GC or a deactivate() that now early-returns.
		expect(old.facts.verify(old.input).digest[0]).toBe(8);
		expect(old.verify).toHaveBeenCalledTimes(1);
		expect(next.facts.verify(next.input).digest[0]).toBe(7);
		expect(next.verify).not.toHaveBeenCalled();
	});
});

describe("creator replay seal exact native readback", () => {
	for (const mutation of ["signature", "provenance"] as const) {
		it(`refuses post-seal ${mutation} changes and permits exact continuation`, async () => {
			let enabled = false,
				sealedPageRead = false,
				mutatedReads = 0;
			let issuance!: DurableIssuanceStore;
			let originalJournal!: DurableLiveJournalStore;
			const fixture = await prepareGenuineCreatorAdoptionFixture({
				nativeAheOwner: true,
				nativeStorageOwners: true,
				decorateIssuanceStore(store) {
					issuance = store;
					return store;
				},
				decorateLiveJournalStore(store) {
					originalJournal = store;
					return {
						...store,
						readPage: async (input) => {
							const stack = new Error().stack ?? "";
							const page = await store.readPage(input);
							if (!enabled || !page.ok || page.rows.length === 0) return page;
							if (!sealedPageRead) {
								if (stack.includes("sealCreatorDurableReplay") && page.nextSequence === null) sealedPageRead = true;
								return page; // Initial complete authentic page is unchanged.
							}
							const selected = page.rows.findIndex((row) => row.sourceKind === "local-issued");
							if (selected < 0) return page;
							const row = page.rows[selected];
							if (row.sourceKind !== "local-issued") throw new Error("native local provenance required");
							const issued = await issuance.readIssued(
								{ author: row.author, objectId: row.scope.objectId },
								row.authorSequence
							);
							if (issued === null) throw new Error("genuine native issued leaf required");
							const signature = Uint8Array.from(issued.envelope.signature);
							if (mutation === "signature") signature[0] ^= 1;
							const altered = {
								scope: row.scope,
								journalSequence: row.journalSequence,
								vertexDigest: row.vertexDigest,
								sourceKind: "received" as const,
								exactCanonicalPreimageBytes: Uint8Array.from(issued.envelope.canonicalPreimageBytes),
								detachedSignature: signature,
							};
							mutatedReads += 1;
							return { ...page, rows: page.rows.map((value, index) => (index === selected ? altered : value)) };
						},
					};
				},
			});
			try {
				const before = await fixture.handle.inspectDurableHead();
				const journalBefore = encodeCanonical(
					await originalJournal.readRetirementImage!({ objectId: fixture.objectId })
				);
				enabled = true;
				await expect(fixture.handle.close()).rejects.toThrow();
				expect(sealedPageRead, "initial complete replay page was read before the fault").toBe(true);
				expect(mutatedReads, "a later genuine native page was altered only after sealing").toBeGreaterThan(0);
				expect(await fixture.handle.inspectDurableHead()).toEqual(before);
				expect(encodeCanonical(await originalJournal.readRetirementImage!({ objectId: fixture.objectId }))).toEqual(
					journalBefore
				);
				enabled = false;
				const result = await fixture.handle.close();
				expect(result.successorEpoch).toBe(1);
				expect(result.epoch).toBe(0);
			} finally {
				await fixture.close();
			}
		}, 120_000);
	}
});

