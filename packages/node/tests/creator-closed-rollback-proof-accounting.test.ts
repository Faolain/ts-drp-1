import "@ts-drp/protocol-v3";
import {createWorkCheckpoint} from "../src/internal/cooperative-work.js";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { canonicalCarrierResourceForSizing } from "@ts-drp/canonical/resource";
import { CompactMerkleAccumulator, deriveCloseSetHistoryCommitment, type EpochVertex } from "@ts-drp/compaction";
import { authorizeLatchedEnvelopeAuthor, openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { copyCanonicalForAdmittedView, verifyReceivedVertex } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import { snapshotQuarantineContract, snapshotRetirementContract, type SnapshotRecoveryRoleRetirementFact } from "@ts-drp/storage/snapshot-transfer";
import { AHE_BOUNDED_READ_LIMITS, type BlobDigest, LOCAL_WORKLOAD_CAPACITY, digestBlob, decodeHeadRecordV1, encodeHeadRecordV1 } from "@ts-drp/storage";
import {
	captureLiveJournalSignedAnchorReadInput,
	encodeJournalRetirementNativeCarriers,
	encodeJournalRetirementControl,
	journalRetirementNativeProgressFields,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	journalFutureAppendPostimageWidths,
	journalRetirementFrameDigest,
	journalRetirementCanonicalRow,
	journalRetirementImage,
	journalOrdinarySchemaFinishingCapacityWidths,
	prepareJournalOrdinaryFinishingCapacityProjection,
	createJournalRetirementImageCapture,
	type LiveJournalAcceptedRow,
	type LiveJournalRetirementImageObservation,
	type LiveJournalRetirementControl,
} from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";
import { ISSUANCE_RETIREMENT_LIMITS, closeIssuanceRetirementProtectedRecords } from "../../issuance-store/src/retirement.js";

import {
	createCreatorClosedRollbackProofAccounting,
	CREATOR_ORDINARY_PROOF_MAX_BYTES,
	CREATOR_MAINTENANCE_PROOF_MAX_BYTES,
	readCreatorClosedRetirementSourceCarrierWidthsForSizing,
} from "../src/internal/creator-closed-rollback-data.js";
import { canonicalCreatorDataRecord, createCreatorCanonicalSyntaxReader } from "../src/internal/creator-snapshot-data.js";
import { creatorAuthenticatedEpochVertexFields } from "../src/internal/runtime-reclamation.js";
import { resolveCreatorNativeCheckpointRecoveryTransfer, uniqueCreatorTransitionCandidate } from "../src/internal/creator-transition-advance.js";
import {openReceivedCertificate} from "../src/creator-adoption.js";
import {capturePromotionRecord, capturePromotionArray, capturePromotionBytes} from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import {LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES} from "@ts-drp/live-journal";
import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { encodeCreatorCloseMembership, openCreatorCloseMembership } from "../src/internal/creator-close-membership.js";

describe("private issuance hole selection", () => {
	it("classifies exact terminal coverage only after publication and outside open settlement work", () => {
		const path = new URL("../src/v3-live.ts", import.meta.url);
		const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const selected: ts.VariableDeclaration[] = [];
		let ownClass: ts.FunctionDeclaration | undefined;
		const names = ["coveredFrontier", "coveredClass", "terminallyCovered"];
		const visit = (n: ts.Node): void => {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && names.includes(n.name.text)) selected.push(n);
			if (ts.isFunctionDeclaration(n) && n.name?.text === "settlementOwnRowClass") ownClass = n;
			ts.forEachChild(n, visit);
		}; visit(ast);
		expect(selected).toHaveLength(3); expect(ownClass).toBeDefined();
		const run = (changes: Record<string, unknown> = {}) => {
			let authenticated = 0;
			const context = {sourceBound: true, openSource: false, retainedNoop: false, registration: {issuanceScope: {author: "author"}},
				row: {publishState: "published", authorSequence: 7}, scope: {author: "author"}, vertex: {epoch: 1},
				currentTrust: {currentEpoch: 4}, classified: {authenticated: {digest: "exact"}},
				settlementFrontierFromHistory: () => ({currentEpoch: 4, admissionEpoch: 0, terminalThrough: 7}),
				authenticatedSettlementSourceRow: () => {authenticated++; return {digest: "exact"};}, vertexFacts: undefined,
				...changes};
			return {covered: execute<boolean>(`${ownClass!.getText(ast)}\n${selected.map(n => `const ${n.getText(ast)};`).join("\n")}\nterminallyCovered;`, context),
				authenticated: () => authenticated};
		};
		expect(run().covered).toBe(true);
		for (const changes of [{sourceBound: false}, {openSource: true}, {row: {publishState: "pending", authorSequence: 7}},
			{scope: {author: "foreign"}}, {vertex: {epoch: 3}},
			{settlementFrontierFromHistory: () => undefined},
			{settlementFrontierFromHistory: () => ({currentEpoch: 4, admissionEpoch: 0, terminalThrough: 6})}]) {
			const result = run(changes); expect(result.covered).toBe(false); expect(result.authenticated()).toBe(0);
		}
		expect(run({authenticatedSettlementSourceRow: () => ({digest: "altered"})}).covered).toBe(false);
	});
	it("requires covered published work, physical absence and complete replay exclusion; preserves SAME-intent and permanent holes", () => {
		const select = execute<(input: any) => readonly unknown[]>(`${declaration("closedIssuanceProtectedRecordsForRetirement")}\nclosedIssuanceProtectedRecordsForRetirement;`, {
			record: decodeCanonical, requireLaw: (value: unknown) => {if (!value) throw Error("chain-invalid");},
			closeIssuanceRetirementProtectedRecords: (input: {protectedRecords: readonly unknown[]}) => input.protectedRecords,
		});
		const digest = new Uint8Array(32).fill(3), scope = {objectId: "room", author: "author"};
		const row = {...scope, authorSequence: 2, digest,
			canonicalPreimageBytes: encodeCanonical({...scope, authorSequence: 2, epoch: 0, anchor: "anchor", operation: {action: "$drp.author-fence.v1"}})};
		const hole = {author: "author", authorSequence: 2, digest: "03".repeat(32)};
		const proof = {scope, authorSequence: 2, digest, classification: "covered-historical", dependencyKind: "signed-settled-issuance"};
		const intent = {decisionDigest: "01".repeat(32), sourceProofDigest: "02".repeat(32)};
		const base = {objectId: "room", throughEpoch: 3, intent, rows: {issued: [row], outbox: [{...row, publishState: "published"}]},
			control: null, censusRows: [proof], protectedReplayScopes: [], physicalJournalRows: [], dependenciesClassified: true};
		expect(select(base)).toEqual([]);
		expect(select({...base, censusRows: [{...proof, classification: "filtered-settlement-source"}]})).toEqual([]);
		expect(select({...base, censusRows: [{...proof, classification: "pinned-genesis", dependencyKind: "pinned-genesis"}]})).toEqual([]);
		for (const changed of [{...base, censusRows: []}, {...base, censusRows: [proof, proof]},
			{...base, dependenciesClassified: false},
			{...base, censusRows: [{...proof, classification: "unsettled"}]},
			{...base, censusRows: [{...proof, scope: {...scope, objectId: "foreign"}}]},
			{...base, censusRows: [{...proof, digest: new Uint8Array(32)}]},
			{...base, rows: {...base.rows, outbox: [{...row, publishState: "pending"}]}},
			{...base, protectedReplayScopes: [{objectId: "room", epoch: 0, anchorDigest: "anchor"}]},
			{...base, physicalJournalRows: [encodeCanonical(["acceptedEntries", ["room", 0, "anchor", 0], {}])]},
			{...base, throughEpoch: 1}]) expect(select(changed)).toEqual([hole]);
		const original = {...intent, throughEpoch: 3, protectedRecords: [hole]};
		expect(select({...base, control: {active: null, completed: original}})).toEqual([hole]);
		expect(select({...base, control: {active: {preparation: original}, completed: null}})).toEqual([hole]);
		for (const fresh of [{...intent, decisionDigest: "04".repeat(32)}, {...intent, sourceProofDigest: "05".repeat(32)}, undefined]) {
			// Completed intent plus a new authenticated source at the SAME cut may
			// release its last-consumer holes; reopening preserves this distinction.
			const reopened = decodeCanonical(encodeCanonical({active: null, completed: original}));
			expect(select({...base, intent: fresh, control: reopened})).toEqual([]);
			expect(select({...base, intent: fresh, control: reopened, physicalJournalRows:
				[encodeCanonical(["acceptedEntries", ["room", 0, "anchor", 0], {}])]})).toEqual([hole]);
			expect(() => select({...base, intent: fresh, control: {active: {preparation: original}, completed: null}}))
				.toThrow("chain-invalid");
		}
		expect(select({...base, control: {active: null, completed: {...original, throughEpoch: 2}}})).toEqual([]);
		expect(select({...base, censusRows: [], control: {active: null, completed: {...original, protectedRecords: []}}})).toEqual([]);
		expect(() => select({...base, rows: {...base.rows, issued: [{...row, objectId: "foreign"}]}})).toThrow("chain-invalid");
		const retained = select({...base, censusRows: []});
		digest.fill(9); expect(retained).toEqual([hole]); expect(Object.isFrozen(retained)).toBe(true);
	});
});

describe("private maintenance refusal diagnostics", () => {
	it("preserves nominal failure kind and bounded cause without inspecting structural lookalikes", () => {
		const refusal = unique((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "Refusal");
		const owner = execute<{describe(value: unknown): string | undefined; create(result: unknown): unknown}>(
			`${refusal.getText(parsed)}\n${declaration("creatorClosedRollbackRefusalDiagnostic").replace(/^export /, "")}\n` +
			`({describe: creatorClosedRollbackRefusalDiagnostic, create: result => new Refusal(result)});`, {});
		expect(owner.describe(owner.create({ok: false, kind: "aborted"}))).toBe("aborted");
		expect(owner.describe(owner.create({ok: false, kind: "floor-stale", cause: {owner: "journal", reason: "drift"}})))
			.toBe("floor-stale:journal:drift");
		expect(owner.describe(owner.create({ok: false, kind: "ahe-rejected", cause: {owner: "ahe", reason: "x".repeat(1024)}})))
			.toBe(`ahe-rejected:ahe:${"x".repeat(512)}`);
		expect(owner.describe({get result() {throw Error("LOOKALIKE_MUST_NOT_BE_READ");}})).toBeUndefined();
		expect(owner.describe(new Error("unrelated"))).toBeUndefined();
	});
});

describe("bounded syntax retention replaces cold parse facts without changing validation", () => {
	function owner(original = false, bounds: {maxObjectGenerations: number; maxClosureReferences: number; maxUnionBytes: number} = AHE_BOUNDED_READ_LIMITS) {
		const path = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const helper = ast.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (helper === undefined) throw Error("PRIVATE_SYNTAX_OWNER_MISSING");
		let code = helper.getText(ast).replace(/^export /, "");
		if (original) {
			// Exact previous admission-only read algorithm. Every decode, copied
			// capture, record roundtrip and output isolation remains production code.
			const reads: ts.VariableDeclaration[] = [];
			const visit = (node: ts.Node): void => {if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "read") reads.push(node); ts.forEachChild(node, visit);};
			visit(helper);
			if (reads.length !== 1) throw Error(`PRIVATE_SYNTAX_READ_NOT_UNIQUE:${reads.length}`);
			code = code.replace(reads[0]!.getText(ast), `read = (bytes: Uint8Array) => {
				const previous = entries.get(bytes);
				if (previous !== undefined && compareBytes(previous.bytes, bytes) === 0) return previous;
				if (previous !== undefined) {entries.delete(bytes); retainedBytes -= previous.bytes.byteLength;}
				const captured = new Bytes(bytes);
				const entry = {bytes: captured, value: decodeCanonical(captured), recordChecked: false,
					record: undefined as Readonly<Record<string, unknown>> | undefined};
				if (entries.size < maximumEntries && captured.byteLength <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes - retainedBytes) {
					entries.set(bytes, entry); retainedBytes += captured.byteLength;
				}
				return entry;
			}`);
		}
		const stats = {parses: 0, roundtrips: 0, entries: 0, bytes: 0, peakEntries: 0, peakBytes: 0};
		class ObservedEntries extends Map<unknown, {bytes: Uint8Array}> {
			refresh() {stats.entries = this.size; stats.bytes = [...this.values()].reduce((sum, value) => sum + value.bytes.length, 0);
				stats.peakEntries = Math.max(stats.peakEntries, stats.entries); stats.peakBytes = Math.max(stats.peakBytes, stats.bytes);}
			override set(key: unknown, value: {bytes: Uint8Array}) {super.set(key, value); this.refresh(); return this;}
			override delete(key: unknown) {const existed = super.delete(key); this.refresh(); return existed;}
		}
		const reader = execute<ReturnType<typeof createCreatorCanonicalSyntaxReader>>(`${code}\ncreateCreatorCanonicalSyntaxReader();`, {
			AHE_BOUNDED_READ_LIMITS: bounds, Map: ObservedEntries,
			decodeCanonical: (bytes: Uint8Array) => {stats.parses++; return decodeCanonical(bytes);},
			encodeCanonical: (value: unknown) => {stats.roundtrips++; return encodeCanonical(value);},
		});
		return {reader, stats};
	}
	it("replaces a saturated cold inventory with legitimate later hot closure records within unchanged entry and byte bounds", () => {
		const capacity = AHE_BOUNDED_READ_LIMITS.maxObjectGenerations * AHE_BOUNDED_READ_LIMITS.maxClosureReferences;
		const cold = Array.from({length: capacity}, (_, index) => encodeCanonical({kind: `native-cold-${index}`, epoch: index}));
		const hot = Array.from({length: AHE_BOUNDED_READ_LIMITS.maxClosureReferences}, (_, index) => encodeCanonical({
			kind: ["drp-hard-epoch-cut", "drp-seal-qc", "drp-anchor-trust-state"][index % 3], epoch: 3, currentEpoch: 4,
			phase: "commit", payload: new Uint8Array(4096), nested: {members: Array(64).fill("a".repeat(64))}}));
		expect(hot.reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThan(AHE_BOUNDED_READ_LIMITS.maxUnionBytes);
		const before = owner(true), after = owner();
		for (const bytes of cold) expect(after.reader.selection(bytes)).toEqual(before.reader.selection(bytes));
		for (let signer = 0; signer < 32; signer++) for (let selector = 0; selector < 3; selector++) for (const bytes of hot)
			expect(after.reader.selection(bytes)).toEqual(before.reader.selection(bytes));
		expect(before.stats.parses).toBe(capacity + 32 * 3 * hot.length);
		expect(after.stats.parses).toBe(capacity + new Set(hot.map(bytes => Buffer.from(bytes).toString("hex"))).size);
		expect(after.stats.peakEntries).toBeLessThanOrEqual(capacity);
		expect(after.stats.peakBytes).toBeLessThanOrEqual(AHE_BOUNDED_READ_LIMITS.maxUnionBytes);
	});
	it("shares exact syntax across native buffer copies without retaining aliases or sharing mutable outputs", () => {
		const bounds = {maxObjectGenerations: 1, maxClosureReferences: 2, maxUnionBytes: 16384};
		const raw = encodeCanonical({kind: "drp-hard-epoch-cut", epoch: 3, payload: new Uint8Array(4096), members: ["writer"]});
		const old = owner(true, bounds), current = owner(false, bounds);
		for (let copy = 0; copy < 143; copy++) {
			const bytes = raw.slice();
			expect(current.reader.canonicalSelection(bytes)).toEqual(old.reader.canonicalSelection(bytes));
			const value = current.reader.record(bytes)!;
			(value.payload as Uint8Array).fill(9); (value.members as string[]).push("foreign");
		}
		expect(old.stats.parses).toBe(143); expect(current.stats.parses).toBe(1);
		expect(current.stats.roundtrips).toBe(1); expect(current.stats.entries).toBe(1);
		expect(current.stats.bytes).toBe(raw.length);
		expect(current.reader.record(raw)).toEqual(decodeCanonical(raw));
		const altered = raw.slice(); altered[altered.length - 1] ^= 1;
		expect(current.reader.record(altered)).toEqual(old.reader.record(altered));
		expect(current.stats.parses).toBe(2);
		// The retained key itself remains mutable; a copied lookup must compare
		// against the isolated original capture, never the key's current content.
		const first = encodeCanonical({kind: "one", epoch: 3}), saved = first.slice(), f = owner(false, bounds);
		f.reader.record(first); first.fill(255);
		expect(f.reader.record(saved)).toEqual(decodeCanonical(saved)); expect(f.stats.parses).toBe(1);
		expect(f.reader.record(first)).toBeUndefined(); expect(f.stats.parses).toBe(2);
	});
	it("enforces both exact entry and retained-byte ceilings, promotes hits, and keeps oversized/invalid newcomers as misses", () => {
		const a = encodeCanonical({kind: "one", epoch: 3}), b = encodeCanonical({kind: "two", epoch: 4}), c = encodeCanonical({kind: "tri", epoch: 5});
		const bounds = {maxObjectGenerations: 1, maxClosureReferences: 2, maxUnionBytes: a.length + b.length};
		const o = owner(false, bounds);
		for (const bytes of [a, b, a, c, a]) o.reader.selection(bytes);
		expect(o.stats.parses).toBe(3); // a hit promotes a; only b is cold at c's admission.
		o.reader.selection(b); expect(o.stats.parses).toBe(4);
		expect(o.stats.peakEntries).toBe(2); expect(o.stats.peakBytes).toBeLessThanOrEqual(bounds.maxUnionBytes);
		const large = encodeCanonical({kind: "oversized", payload: new Uint8Array(bounds.maxUnionBytes + 1)}), invalid = Uint8Array.of(255);
		const after = owner(false, bounds), before = owner(true, bounds);
		for (const bytes of [a, large, invalid, large, invalid, a]) expect(after.reader.selection(bytes)).toEqual(before.reader.selection(bytes));
		expect(after.stats.parses).toBe(5); expect(after.stats.entries).toBe(1);
		expect(after.stats.bytes).toBe(a.length);
		const zero = owner(false, {...bounds, maxClosureReferences: 0});
		for (const bytes of [a, a]) expect(zero.reader.record(bytes)).toEqual(decodeCanonical(a));
		expect(zero.stats.entries).toBe(0); expect(zero.stats.parses).toBe(2);
	});
	it("revalidates same-object scope/phase mutation, isolates decoded outputs, and never shares facts with a new reader", () => {
		const bounds = {maxObjectGenerations: 1, maxClosureReferences: 2, maxUnionBytes: 4096};
		const bytes = encodeCanonical({kind: "one", epoch: 3, phase: "commit", nested: {bytes: Uint8Array.of(7, 9), members: ["a"]}});
		const after = owner(false, bounds), before = owner(true, bounds);
		const projection = after.reader.record(bytes)! as {kind: string; nested: {bytes: Uint8Array; members: string[]}};
		projection.kind = "bad"; projection.nested.bytes.fill(0); projection.nested.members.push("bad");
		expect(after.reader.record(bytes)).toEqual(before.reader.record(bytes));
		const changed = encodeCanonical({kind: "two", epoch: 4, phase: "review", nested: {bytes: Uint8Array.of(7, 9), members: ["a"]}});
		expect(changed.length).toBe(bytes.length); bytes.set(changed);
		expect(after.reader.selection(bytes)).toEqual(before.reader.selection(bytes));
		expect(after.reader.selection(bytes)).toMatchObject({kind: "two", epoch: 4, phase: "review"});
		bytes[0] = 255;
		expect(after.reader.record(bytes)).toBeUndefined(); expect(after.reader.record(bytes)).toEqual(before.reader.record(bytes));
		expect(after.stats.entries).toBe(0); // Mutated previous fact is discarded before genuine failure, as originally.
		bytes.set(changed);
		expect(after.reader.record(bytes)).toEqual(before.reader.record(bytes));
		const fresh = owner(false, bounds);
		expect(fresh.reader.record(bytes)).toEqual(after.reader.record(bytes)); expect(fresh.stats.parses).toBe(1);
		const selection = after.reader.selection(bytes)!;
		expect(Object.isFrozen(selection)).toBe(true); expect(Reflect.set(selection, "kind", "bad")).toBe(false);
	});
	it("preserves genuine candidate ambiguity, malformed UTF8/BOM and complete decoder/roundtrip refusal outcomes", () => {
		const before = owner(true), after = owner();
		const bytes = encodeCanonical({kind: "drp-hard-epoch-cut", epoch: 3});
		const candidates = [{bytes, ref: {digest: "a".repeat(64) as BlobDigest, byteLength: bytes.length}}];
		for (const set of [candidates, [...candidates, candidates[0]!]])
			expect(uniqueCreatorTransitionCandidate(set, "drp-hard-epoch-cut", 3, undefined, after.reader))
				.toEqual(uniqueCreatorTransitionCandidate(set, "drp-hard-epoch-cut", 3, undefined, before.reader));
		const invalidUtf8 = encodeCanonical("x"); invalidUtf8[invalidUtf8.length - 1] = 255;
		let deep: unknown = 1; for (let level = 0; level < 130; level++) deep = {nested: deep};
		const sources = [invalidUtf8, encodeCanonical({kind: "\ufeffdrp-hard-epoch-cut", epoch: 3}),
			encodeCanonical(deep, {maxDepth: 256}), encodeCanonical(Array(65_537).fill(1), {maxItems: 100_000}),
			encodeCanonical(Array(1_000_001).fill(1), {maxItems: 1_000_002})];
		const outcome = (reader: typeof after.reader, bytes: Uint8Array) => {try {return {value: reader.decode(bytes)};} catch (error) {
			return {name: (error as Error).name, message: (error as Error).message};}};
		for (const input of sources) {
			expect(after.reader.record(input)).toEqual(before.reader.record(input));
			expect(after.reader.selection(input)).toEqual(before.reader.selection(input));
			expect(outcome(after.reader, input)).toEqual(outcome(before.reader, input));
		}
	});
});

describe("ordinary journal exact-held current probe consumer controls", () => {
	const expected = Object.freeze({control: null, exactCanonicalControlCarriers: [], canonicalRows: [Uint8Array.of(1)],
		image: {imageDigest: "a".repeat(64), scopeCount: 1, rowCount: 1, byteCharge: 1}});
	function owner() {
		const capture = execute<(read: Function, observation: object) => object | undefined>(
			`${declaration("captureCreatorOrdinaryJournalCurrentProbe")}\ncaptureCreatorOrdinaryJournalCurrentProbe;`, {});
		const check = execute<(read: Function, owner: object, objectId: string, image: object,
			probe?: {checkCurrent(): Promise<unknown>}) => Promise<unknown>>(
			`${declaration("checkCreatorOrdinaryJournalCurrentImage")}\ncheckCreatorOrdinaryJournalCurrentImage;`, {
				requireLaw: (ok: unknown) => {if (!ok) throw new Error("anchor-unavailable");},
				closedRetirementEqual: (left: unknown, right: unknown) => Buffer.compare(Buffer.from(encodeCanonical(left)), Buffer.from(encodeCanonical(right))) === 0,
			});
		return {capture, check};
	}
	it("uses the original producer receiver and refuses bound/copied/accessor ports", () => {
		const f = owner(), probe = Object.freeze({checkCurrent: async () => ({ok: true, value: null})});
		const read = Object.assign(async () => ({ok: true, value: expected}), {captureCurrentProbe: function (this: unknown, value: object) {
			return this === read && value === expected ? probe : undefined;
		}}); Object.freeze(read);
		expect(f.capture(read, expected)).toBe(probe); expect(f.capture(read, {...expected})).toBeUndefined();
		expect(f.capture(Object.freeze(read.bind({})), expected)).toBeUndefined();
		const copied = Object.assign(async () => ({ok: true, value: expected}), {captureCurrentProbe: read.captureCurrentProbe}); Object.freeze(copied);
		expect(f.capture(copied, expected)).toBeUndefined();
		let getters = 0;
		const getter = Object.defineProperty(async () => ({ok: true, value: expected}), "captureCurrentProbe", {get: () => {getters++; return read.captureCurrentProbe;}});
		Object.freeze(getter); expect(f.capture(getter, expected)).toBeUndefined(); expect(getters).toBe(0);
	});
	it("keeps unsupported ports and benign eviction on the exact full-image path", async () => {
		const f = owner(); let reads = 0;
		const read = async () => {reads++; return {ok: true, value: expected};};
		const holder = {readRetirementImage: read};
		expect(await f.check(read, holder, "room", expected)).toBeUndefined();
		const current = {checkCurrent: async () => ({ok: true, value: null})};
		expect(await f.check(read, holder, "room", expected, current)).toBe(current); expect(reads).toBe(1);
		const evicted = {checkCurrent: async () => ({ok: false, kind: "retirement-stale"})};
		expect(await f.check(read, holder, "room", expected, evicted)).toBeUndefined(); expect(reads).toBe(2);
		const changed = async () => ({ok: true, value: {...expected, canonicalRows: [Uint8Array.of(2)]}});
		await expect(f.check(changed, {readRetirementImage: changed}, "room", expected, evicted))
			.rejects.toThrow("anchor-unavailable");
		await expect(f.check(read, {readRetirementImage: changed}, "room", expected, current)).rejects.toThrow("anchor-unavailable");
	});
	it("does not turn genuine native/currency refusals or thrown failures into cache misses", async () => {
		const f = owner(); let reads = 0;
		const read = async () => {reads++; return {ok: true, value: expected};};
		for (const kind of ["store-closed", "store-poisoned", "retirement-released", "substrate-failure", "malformed-input", "retirement-fenced"])
			await expect(f.check(read, {readRetirementImage: read}, "room", expected, {checkCurrent: async () => ({ok: false, kind})})).rejects.toThrow("anchor-unavailable");
		const failure = new Error("original native turn failure");
		await expect(f.check(read, {readRetirementImage: read}, "room", expected, {checkCurrent: async () => {throw failure;}})).rejects.toBe(failure);
		expect(reads).toBe(0);
	});
	// These test-only bindings exercise the actual private consumer statements,
	// not a valid native probe, source authentication or portable capability.
});

describe("ordinary prepared journal postimage DATA consumer controls", () => {
	function fixture(sql: boolean, received: boolean) {
		const current = anchorMaterial(3), previous = anchorMaterial(2), author = "writer";
		const header = (material: ReturnType<typeof anchorMaterial>, ordinal: number) => {
			const parametersDigest = (decodeCanonical(material.bytes) as {parametersDigest: string}).parametersDigest;
			return sql ? {object_id: material.scope.objectId, epoch: material.scope.epoch, anchor_digest: material.scope.anchorDigest,
				next_journal_sequence: ordinal, exact_anchor_preimage: material.bytes, detached_anchor_signature: material.install.detachedAnchorSignature,
				parameters_digest: parametersDigest, exact_parameters_carrier: material.install.exactCanonicalParametersCarrierBytes} :
				{...material.scope, nextJournalSequence: ordinal, exactCanonicalAnchorPreimageBytes: material.bytes,
					detachedAnchorSignature: material.install.detachedAnchorSignature, parametersDigest,
					exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes};
		};
		const table = sql ? "accepted_entries" : "acceptedEntries";
		const local = (scope: typeof current.scope, ordinal: number, vertexDigest: string) => sql ? {
			object_id: scope.objectId, epoch: scope.epoch, anchor_digest: scope.anchorDigest, journal_sequence: ordinal,
			source_kind: "local-issued", vertex_digest: vertexDigest, local_author: author, local_author_sequence: ordinal,
			received_preimage: null, received_signature: null} : {...scope, journalSequence: ordinal, sourceKind: "local-issued",
				vertexDigest, localAuthor: author, localAuthorSequence: ordinal};
		const frame = (scope: typeof current.scope, value: unknown, ordinal?: number) => journalRetirementCanonicalRow(
			ordinal === undefined ? "scopes" : table,
			[scope.objectId, scope.epoch, scope.anchorDigest, ...(ordinal === undefined ? [] : [ordinal])], value);
		const old = [frame(previous.scope, header(previous, 1)), frame(current.scope, header(current, 1)),
			frame(previous.scope, local(previous.scope, 0, "a".repeat(64)), 0), frame(current.scope, local(current.scope, 0, "b".repeat(64)), 0)];
		const preimage = encodeCanonical({fixture: "opaque already-admitted PRE", sequence: 1}), signature = new Uint8Array(64).fill(7);
		const row: LiveJournalAcceptedRow = received ? {scope: current.scope, journalSequence: 1, vertexDigest: "c".repeat(64),
			sourceKind: "received", exactCanonicalPreimageBytes: preimage, detachedSignature: signature} :
			{scope: current.scope, journalSequence: 1, vertexDigest: "c".repeat(64), sourceKind: "local-issued", author, authorSequence: 1};
		const entry = !received ? local(current.scope, 1, row.vertexDigest) : sql ? {
			object_id: current.scope.objectId, epoch: current.scope.epoch, anchor_digest: current.scope.anchorDigest, journal_sequence: 1,
			source_kind: "received", vertex_digest: row.vertexDigest, local_author: null, local_author_sequence: null,
			received_preimage: preimage, received_signature: signature} : {...current.scope, journalSequence: 1,
				sourceKind: "received", vertexDigest: row.vertexDigest, exactCanonicalPreimageBytes: preimage, detachedSignature: signature};
		const rows = [old[0]!, frame(current.scope, header(current, 2)), old[2]!, old[3]!, frame(current.scope, entry, 1)];
		const control: LiveJournalRetirementControl = {kind: "v3-live-journal-retirement-control-1", objectId: current.scope.objectId,
			incarnation: "d".repeat(64), revision: 1, sequence: 0, active: null, completed: null};
		const observation = (canonicalRows: readonly Uint8Array[], selectedControl: LiveJournalRetirementControl | null = control): LiveJournalRetirementImageObservation => {
			const frames = canonicalRows.map(raw => decodeCanonical(raw) as [string, unknown[], unknown]);
			const native = selectedControl === null ? undefined : encodeJournalRetirementNativeCarriers(selectedControl);
			return {control: selectedControl, exactCanonicalControlCarriers: native === undefined ? [] :
				[native.controlBytes, ...(native.planBytes === undefined ? [] : [native.planBytes])], canonicalRows,
				image: journalRetirementImage(frames.filter(frame => frame[0] === "scopes").map(frame => frame[2]),
					frames.filter(frame => frame[0] !== "scopes").map(frame => frame[2]))};
		};
		const actualProjection = prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: old, currentScope: current.scope});
		const calls = {advance: 0};
		const projection = Object.freeze({...actualProjection, advance: (input: Parameters<typeof actualProjection.advance>[0]) => {
			calls.advance++; return actualProjection.advance(input);
		}});
		const seed = {projection, canonicalRows: old, currentRows: [{scope: current.scope, journalSequence: 0, sourceKind: "local-issued" as const,
			vertexDigest: "b".repeat(64), author, authorSequence: 0}], currentHeaderIndex: 1, imageDigest: observation(old, null).image.imageDigest};
		const present = observation(rows), pending = {...seed, pending: {row, imageDigest: present.image.imageDigest,
			controlBytes: encodeJournalRetirementControl(control)}};
		const run = execute<(originalSeed: typeof seed & {pending?: typeof pending.pending}, observed: LiveJournalRetirementImageObservation,
			selectedScope: typeof current.scope) => typeof seed | undefined>(
			`${declaration("creatorOrdinarySizingRecord")}\n${declaration("creatorOrdinaryPreparedJournalCurrent")}\ncreatorOrdinaryPreparedJournalCurrent;`,
			{encodeJournalRetirementControl});
		return {current, old, rows, seed, pending, present, run, calls, observation};
	}
	it("advances only exact accepted local/received postimages and preserves every nonempty historical frame", () => {
		for (const sql of [false, true]) for (const received of [false, true]) {
			const f = fixture(sql, received), next = f.run(f.pending, f.present, f.current.scope)!;
			expect(next).toBeDefined(); expect(next.currentRows).toHaveLength(2); expect(f.calls.advance).toBe(1);
			expect(next.projection.snapshot).toEqual(prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.rows, currentScope: f.current.scope}).snapshot);
			expect(next.canonicalRows[0]).toEqual(f.old[0]); expect(next.canonicalRows[2]).toEqual(f.old[2]);
			expect(f.run(next, f.present, f.current.scope)).toBe(next); expect(f.calls.advance).toBe(1); // Exact retry never advances twice.
			expect(f.run(f.seed, f.observation(f.old, null), f.current.scope)).toBe(f.seed);
			expect(f.run(f.seed, f.present, f.current.scope)).toBeUndefined(); // No accepted effect, no inferred append.
		}
	});
	it("declines changed old PRE, altered new evidence, missing rows, wrong kind and stale postimage/control", () => {
		for (const sql of [false, true]) for (const received of [false, true]) {
			const f = fixture(sql, received);
			const altered = (index: number, change: (row: Record<string, unknown>) => Record<string, unknown>) => {
				const rows = f.rows.slice(), [table, key, row] = decodeCanonical(rows[index]!) as [string, unknown[], Record<string, unknown>];
				rows[index] = journalRetirementCanonicalRow(table, key, change(row)); return rows;
			};
			const variants = [
				altered(2, row => ({...row, [sql ? "vertex_digest" : "vertexDigest"]: "e".repeat(64)})),
				altered(1, row => ({...row, [sql ? "exact_parameters_carrier" : "exactCanonicalParametersCarrierBytes"]: Uint8Array.of(0)})),
				altered(4, row => ({...row, [sql ? "source_kind" : "sourceKind"]: "unsupported"})),
				altered(4, row => ({...row, [sql ? "vertex_digest" : "vertexDigest"]: "f".repeat(64)})),
				f.rows.filter((_, index) => index !== 2),
				[...f.rows, f.rows[4]!],
			];
			if (received) variants.push(altered(4, row => ({...row,
				[sql ? "received_preimage" : "exactCanonicalPreimageBytes"]: encodeCanonical({altered: true})})),
				altered(4, row => ({...row, [sql ? "received_signature" : "detachedSignature"]: new Uint8Array(64).fill(8)})));
			else variants.push(altered(4, row => ({...row, [sql ? "local_author" : "localAuthor"]: "foreign"})),
				altered(4, row => ({...row, [sql ? "local_author_sequence" : "localAuthorSequence"]: 2})));
			for (const rows of variants) {
				const present = f.observation(rows);
				const pending = {...f.pending, pending: {...f.pending.pending, imageDigest: present.image.imageDigest}};
				expect(f.run(pending, present, f.current.scope)).toBeUndefined();
			}
			expect(f.run(f.pending, {...f.present, image: {...f.present.image, imageDigest: "0".repeat(64)}}, f.current.scope)).toBeUndefined();
			expect(f.run(f.pending, {...f.present, control: {...f.present.control!, revision: 2}}, f.current.scope)).toBeUndefined();
			expect(f.run(f.pending, f.present, {...f.current.scope, anchorDigest: "0".repeat(64)})).toBeUndefined();
			expect(f.seed.projection.snapshot.rowCount).toBe(2); expect(f.seed.currentRows).toHaveLength(1);
			expect(f.run(f.pending, f.present, f.current.scope)).toBeDefined(); // Refusal never poisons valid continuation.
		}
	});
	it("compares the materialized native CAS control rather than its compact progress carrier", () => {
		const contextBytes = unique((node): node is ts.VariableStatement => ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === "journalContextControlBytes"));
		const contextCharge = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed) === "journalContextControlBytes !== null");
		const charge = execute<(control: LiveJournalRetirementControl, initial: readonly Uint8Array[]) => {
			before: number; after: number; repeated: number; protected: number}>(`
			const proofMaterialOwners = new WeakMap();
			${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}
			${declaration("chargeProofObservation")}
			((control, initial) => {
				const accounting = createCreatorClosedRollbackProofAccounting([], false), journal = {value: {control}};
				for (const raw of initial) chargeProofObservation(accounting, raw);
				const before = accounting.chargedBytes;
				const read = () => {${contextBytes.getText(parsed)}\n${contextCharge.getText(parsed)};};
				read(); const after = accounting.chargedBytes; read();
				return {before, after, repeated: accounting.chargedBytes,
					protected: proofMaterialOwners.get(accounting).captureKnownResourceTotals().protectedBytes};
			});`, {AHE_BOUNDED_READ_LIMITS, encodeJournalRetirementControl,
				requireLaw: (ok: unknown) => {if (!ok) throw Error("proof-budget-exceeded");}});
		for (const sql of [false, true]) for (const received of [false, true]) {
			const f = fixture(sql, received), digest = "d".repeat(64);
			const base: LiveJournalRetirementControl = {kind: "v3-live-journal-retirement-control-2", objectId: f.current.scope.objectId,
				incarnation: digest, revision: 2, sequence: 1, active: null, drain: null,
				completed: {decisionDigest: digest, sourceProofDigest: digest, throughEpoch: 0, protectedScopes: []}};
			const control: LiveJournalRetirementControl = {...base, revision: 4, drain: {cursor: 1, batches: 1,
				residualImageDigest: f.present.image.imageDigest, plan: {baseControl: base, sourceImage: f.present.image,
					prefixes: [{scope: anchorMaterial(0).scope, highWatermark: 1, rows: [{journalSequence: 0,
						vertexDigest: digest, author: "writer", authorSequence: 0, nativeFrameDigest: digest}]}]}}};
			const present = f.observation(f.rows, control), native = encodeJournalRetirementNativeCarriers(control),
				full = encodeJournalRetirementControl(control);
			expect(native.planBytes).toBeDefined(); expect(native.controlBytes).not.toEqual(full);
			expect(f.run({...f.pending, pending: {...f.pending.pending, controlBytes: native.controlBytes}}, present, f.current.scope)).toBeUndefined();
			expect(f.run({...f.pending, pending: {...f.pending.pending, controlBytes: full}}, present, f.current.scope)).toBeDefined();
			for (const selected of [f.present.control!, control]) {
				const native = encodeJournalRetirementNativeCarriers(selected), full = encodeJournalRetirementControl(selected);
				const result = charge(selected, [native.controlBytes, ...(native.planBytes ? [native.planBytes] : []), encodeCanonical({control: selected})]);
				expect(result.after - result.before).toBe(native.planBytes ? full.byteLength : 0);
				expect(result.repeated).toBe(result.after); expect(result.protected).toBe(0); // OBS, never a permanently carried obligation/refund.
			}
		}
	});
	// Actual private DATA-consumer statements with real schema geometry. These
	// fixtures are not signatures, original native current probes or authority.
});

describe("incremental application resource projection owner controls", () => {
	function fixture() {
		const readout = {}, capacity: {application?: unknown} = {}, pending = new Set<Promise<unknown>>(), cursor = {};
		const candidate = {action: "placeBlock", id: "candidate", kind: "stone", x: 1, y: 2}, unsigned = encodeCanonical(candidate);
		const footprint = {byteLength: 100, items: 100, maxDepth: 8};
		let checks = 0, seeds = 0, fullInputs = 0, callbacks = 0, delta: readonly Uint8Array[] | undefined = [];
		const advanced: unknown[][] = [];
		let advanceFails = false, seedFails = false;
		const projection = Object.freeze({advance: (operations: readonly unknown[]) => {
			if (advanceFails) throw new Error("optional advance failure"); advanced.push([...operations]); return true;
		}, quote: () => footprint});
		const reader = Object.assign(() => {callbacks++; return footprint;}, {createIncrementalProjection: (input: {material: object}) => {
			seeds++; expect(Object.hasOwn(input.material, "candidateOperation")).toBe(false);
			if (seedFails) throw new Error("optional seed failure"); return projection;
		}});
		const proof = {check: async () => {checks++;}};
		const facts = {sourceFacts: {capacity}, frame: {pending}, proofFacts: {runtime: {
			captureApplicationResourceCursor: () => cursor, readApplicationResourceDelta: () => delta,
		}}, current: {blueprint: {maxApplicationStateBytes: 1000, maxItems: 1000, maxDepth: 16},
			candidate: {exactCanonicalOperationBytes: unsigned}}};
		const registry = new WeakMap<object, object>([[readout, {kind: "ordinary-dimensions"}]]);
		const run = execute<(originalReadout: object, originalProof: typeof proof, bytes: Uint8Array, originalReader: typeof reader) => Promise<unknown>>(
			`${["deriveCreatorOrdinaryApplicationResourceForSizing", "readCreatorOrdinaryApplicationResourceBound"]
				.map(name => declaration(name).replace(/^export /, "")).join("\n")}\nreadCreatorOrdinaryApplicationResourceBound;`, {
				creatorOrdinaryIssuanceDimensionFacts: () => facts, maintenanceTerminalCustody: registry,
				creatorOrdinaryApplicationResourceInput: () => {fullInputs++; return {catalog: {}, material: {
					exactCanonicalBaseStateBytes: [encodeCanonical({})], currentOperations: [], protectedOperations: [], recoveryOperations: [], candidateOperation: candidate,
				}};}, canonicalCarrierResourceForSizing, record: decodeCanonical,
			});
		// Test-only owner bindings exercise the production consumer body, not
		// native authentication, completeness, or a fabricated source capability.
		return {run: () => run(readout, proof, unsigned, reader), footprint, pending, advanced, capacity,
			setDelta: (value: typeof delta) => {delta = value;}, failAdvance: () => {advanceFails = true;}, failSeed: () => {seedFails = true;},
			stats: () => ({checks, seeds, fullInputs, callbacks})};
	}
	it("seeds complete material once, advances only accepted deltas, and still brackets every numerical invocation", async () => {
		const f = fixture(); expect(await f.run()).toEqual(f.footprint);
		const accepted = {action: "placeBlock", id: "accepted", kind: "wide", x: 2, y: 3};
		f.setDelta([encodeCanonical({operation: accepted})]); expect(await f.run()).toEqual(f.footprint);
		expect(f.advanced).toEqual([[accepted]]); expect(f.stats()).toEqual({checks: 4, seeds: 1, fullInputs: 1, callbacks: 1});
		expect(f.pending.size).toBe(0);
	});
	it("stale cursors and throwing optional hooks retain the original full callback", async () => {
		const stale = fixture(); await stale.run(); stale.setDelta(undefined); expect(await stale.run()).toEqual(stale.footprint);
		expect(stale.stats().fullInputs).toBe(2);
		const advance = fixture(); await advance.run(); advance.failAdvance(); expect(await advance.run()).toEqual(advance.footprint);
		expect(advance.stats().callbacks).toBe(2);
		const seed = fixture(); seed.failSeed(); expect(await seed.run()).toEqual(seed.footprint); expect(seed.capacity.application).toBeUndefined();
	});
	it("requires identical source, index, graph prefix, controls and retained native-issued identities", () => {
		const path = new URL("../src/v3-live.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const helper = file.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "ordinaryApplicationResourceCursorMatches");
		if (helper === undefined) throw new Error("APPLICATION_CURSOR_HELPER_MISSING");
		const matches = execute<(prior: unknown, current: unknown) => boolean>(`${helper.getText(file)}\nordinaryApplicationResourceCursorMatches;`, {});
		const prior = {registration: {}, index: {}, sourceIdentity: {}, graphVersion: 1, controlDigests: ["control"],
			journal: [{digest: "retained", sequence: 1, sourceKind: "received"}], issued: new Map([["issued", "signature"]])};
		const current = {...prior, graphVersion: 2, journal: [...prior.journal, {digest: "new", sequence: 2, sourceKind: "local-issued"}],
			issued: new Map<string, string>([...prior.issued, ["new-issued", "new-signature"]])};
		expect(matches(prior, current)).toBe(true);
		for (const changed of [{...current, registration: {}}, {...current, index: {}}, {...current, sourceIdentity: {}},
			{...current, graphVersion: 0}, {...current, journal: []}, {...current, journal: [{...prior.journal[0], digest: "changed"}]},
			{...current, journal: [{...prior.journal[0], sourceKind: "local-issued"}]}, {...current, controlDigests: []},
			{...current, issued: new Map()}, {...current, issued: new Map([["issued", "changed-signature"]])}])
			expect(matches(prior, changed)).toBe(false);
	});
});

describe("synchronous maintenance syntax ownership", () => {
	const countedReader = (bounds = AHE_BOUNDED_READ_LIMITS) => {
		const path = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxSource = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const helper = syntaxSource.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (helper === undefined) throw new Error("SYNTAX_OWNER_MISSING");
		let parses = 0, roundtrips = 0;
		const reader = execute<ReturnType<typeof createCreatorCanonicalSyntaxReader>>(
			`${helper.getText(syntaxSource).replace(/^export /, "")}\ncreateCreatorCanonicalSyntaxReader();`, {
				AHE_BOUNDED_READ_LIMITS: bounds,
				decodeCanonical: (bytes: Uint8Array) => { parses++; return decodeCanonical(bytes); },
				encodeCanonical: (value: unknown) => { roundtrips++; return encodeCanonical(value); },
			});
		return { reader, counts: () => ({ parses, roundtrips }) };
	};
	it("parses and roundtrip-validates unchanged exact bytes once in its private invocation", () => {
		const bytes = encodeCanonical({ kind: "one", epoch: 3, nested: { members: ["a", "b"] } });
		const { reader, counts } = countedReader();
		const first = reader.record(bytes);
		for (let branch = 0; branch < 8; branch++) {
			expect(reader.record(bytes)).toEqual(first);
			expect(reader.record(bytes)).not.toBe(first);
			expect(reader.decode(bytes)).toEqual(first);
		}
		expect(counts()).toEqual({ parses: 1, roundtrips: 1 });
		const fresh = createCreatorCanonicalSyntaxReader().record(bytes);
		expect(fresh).toEqual(first);
		expect(fresh).not.toBe(first);
	});
	it("never exposes cached records, nested arrays, bytes or typed collections to caller mutation", () => {
		const bytes = encodeCanonical({ kind: "one", nested: { list: ["stable"], bytes: Uint8Array.of(7, 9),
			floats: Float32Array.of(1, 2), map: new Map([["a", Uint8Array.of(3)]]), set: new Set(["a"]) } });
		const { reader, counts } = countedReader();
		const original = decodeCanonical(bytes) as { kind: string; nested: { list: string[]; bytes: Uint8Array;
			floats: Float32Array; map: Map<string, Uint8Array>; set: Set<string> } };
		const first = reader.record(bytes) as typeof original;
		first.kind = "changed";
		first.nested.list.push("changed");
		first.nested.bytes.fill(0);
		first.nested.floats.fill(0);
		first.nested.map.get("a")!.fill(0);
		first.nested.map.set("changed", Uint8Array.of(0));
		first.nested.set.add("changed");
		const second = reader.decode(bytes) as typeof original;
		expect(second).toEqual(original);
		expect(Object.getPrototypeOf(second)).toBe(Object.getPrototypeOf(original));
		second.nested.bytes.fill(0);
		expect(reader.record(bytes)).toEqual(original);
		const selected = reader.selection(bytes)!;
		expect(Object.isFrozen(selected)).toBe(true);
		expect(Object.keys(selected)).not.toContain("nested");
		expect(Reflect.set(selected, "kind", "changed")).toBe(false);
		expect(reader.selection(bytes)!.kind).toBe("one");
		expect(counts()).toEqual({ parses: 1, roundtrips: 1 });
	});
	it("preserves null prototypes, own __proto__ data and every decoded typed-array constructor", () => {
		const value = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(value, "__proto__", { value: { own: true }, enumerable: true });
		value.kind = "one";
		value.arrays = [Float32Array.of(1), Float64Array.of(2), Int32Array.of(-3), Uint32Array.of(4), Uint8Array.of(5)];
		const bytes = encodeCanonical(value);
		const syntax = createCreatorCanonicalSyntaxReader();
		const first = syntax.record(bytes)!;
		const decoded = decodeCanonical(bytes) as Record<string, unknown>;
		expect(first).toEqual(decoded);
		expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(decoded));
		expect(Object.hasOwn(first, "__proto__")).toBe(true);
		const arrays = first.arrays as Array<Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array>;
		const originalArrays = decoded.arrays as typeof arrays;
		for (let index = 0; index < arrays.length; index++) {
			expect(arrays[index]!.constructor).toBe(originalArrays[index]!.constructor);
			arrays[index]!.fill(0);
		}
		expect(syntax.record(bytes)).toEqual(decoded);
	});
	it("invalidates same-object byte mutation and does not use digest or wrapper identity as authority", () => {
		const bytes = encodeCanonical({ kind: "one", epoch: 3 });
		const changed = encodeCanonical({ kind: "two", epoch: 4 });
		expect(changed.byteLength).toBe(bytes.byteLength);
		const { reader, counts } = countedReader();
		const first = reader.record(bytes);
		bytes.set(changed);
		expect(reader.record(bytes)).toEqual({ kind: "two", epoch: 4 });
		expect(first).toEqual({ kind: "one", epoch: 3 });
		expect(reader.record(new Uint8Array(bytes))).not.toBe(reader.record(bytes));
		// ea4eb158: a distinct array holding identical bytes shares this owner's
		// exact-byte capture (fresh native readers detach their buffers), so it is
		// not a third parse. Authority stays exact bytes: the in-place mutation
		// above reparsed, and a same-length copy with different bytes reparses.
		expect(counts()).toEqual({ parses: 2, roundtrips: 2 });
		const other = Uint8Array.from(bytes); other.set(encodeCanonical({ kind: "one", epoch: 3 }));
		expect(reader.record(other)).toEqual({ kind: "one", epoch: 3 });
		expect(counts()).toEqual({ parses: 3, roundtrips: 3 });
		bytes[0] = 255;
		expect(reader.record(bytes)).toBeUndefined();
		expect(() => reader.decode(bytes)).toThrow();
	});
	it("retains codec UTF-8 and BOM normalization refusals, depth limits and fresh recovery", () => {
		const { reader } = countedReader();
		const malformed = Uint8Array.of(0x05, 2, 0xc0, 0x80);
		expect(() => reader.decode(malformed)).toThrow();
		expect(reader.record(malformed)).toBeUndefined();
		// Frozen codec semantics strip one BOM from a string; a whole record
		// requiring exact re-encoding must still refuse those non-exact bytes.
		const bom = encodeCanonical({ kind: "\ufeffone" });
		expect(reader.decode(bom)).toEqual(decodeCanonical(bom));
		expect(reader.record(bom)).toBeUndefined();
		expect(() => reader.decode(Uint8Array.of(0x04, 0x80, 0, 0, 0, 0, 0, 0, 0))).toThrow();
		let nested: unknown = null;
		for (let depth = 0; depth < 130; depth++) nested = [nested];
		const deep = encodeCanonical(nested, { maxDepth: 256 });
		expect(() => reader.decode(deep)).toThrow();
		expect(reader.record(encodeCanonical({ kind: "valid" }))).toEqual({ kind: "valid" });
	});
	it("falls back to full parsing at the finite cache boundary without changing acceptance", () => {
		const { reader, counts } = countedReader({ ...AHE_BOUNDED_READ_LIMITS,
			maxObjectGenerations: 1, maxClosureReferences: 1, maxUnionBytes: 32 } as unknown as typeof AHE_BOUNDED_READ_LIMITS);
		const first = encodeCanonical({ kind: "one" });
		const second = encodeCanonical({ kind: "two" });
		expect(reader.record(first)).toEqual({ kind: "one" });
		expect(reader.record(second)).toEqual({ kind: "two" });
		expect(reader.record(second)).toEqual({ kind: "two" });
		expect(reader.record(first)).toEqual({ kind: "one" });
		expect(counts()).toEqual({ parses: 3, roundtrips: 3 });
		const tooLargeForReuse = encodeCanonical({ kind: "three", data: new Uint8Array(40) });
		expect(reader.record(tooLargeForReuse)).toEqual(decodeCanonical(tooLargeForReuse));
		expect(reader.record(tooLargeForReuse)).toEqual(decodeCanonical(tooLargeForReuse));
		expect(counts()).toEqual({ parses: 5, roundtrips: 5 });
	});
	it("keeps full proof and unknown-byte charges independent of syntax reuse", () => {
		const bytes = encodeCanonical({ kind: "one" });
		const owner = createCreatorClosedRollbackProofAccounting([]);
		const syntax = createCreatorCanonicalSyntaxReader();
		for (let branch = 0; branch < 3; branch++) {
			expect(syntax.record(bytes)).toBeDefined();
			expect(owner.charge(bytes)).toBe(true);
			expect(owner.chargeUnknownEncodedLength(17)).toBe(true);
		}
		expect(owner.chargedBytes).toBe(bytes.byteLength + 51);
	});
	// Execute the real private preclose-to-future branch and its recursive call,
	// not a handwritten replacement call. The downstream width fixture remains
	// test-only: this proves propagation/isolation, not a complete native quote.
	function recursePreclose(options: { freshControl?: boolean; fault?: string;
		mutate?: "detached" | "input" | "malformed"; adoptionDrain?: boolean; preclose?: boolean } = {}) {
		const precloseFuture = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed) === "preclose && !adoptionDrain");
		const bytes = encodeCanonical({ kind: "one", epoch: 3, nested: { bytes: Uint8Array.of(7, 9), members: ["a", "b"] } });
		const original = new Uint8Array(bytes);
		const outer = countedReader(), owners = [outer];
		const before = outer.reader.record(bytes)!;
		const currentAccounting = createCreatorClosedRollbackProofAccounting([]);
		expect(currentAccounting.charge(bytes)).toBe(true);
		for (const width of [17, 17]) expect(currentAccounting.chargeUnknownEncodedLength(width)).toBe(true);
		const currentWidth = currentAccounting.chargedBytes;
		const membership = Object.freeze([{ scope: { objectId: "room", epoch: 3 } }]);
		const participants = [{ revision: 4 }, { revision: 5 }, { revision: 6 }, { revision: 7 }];
		const floor = { revision: 9 }, ahe = { revision: 10 }, generations = [{ id: "survivor" }];
		const retained = Object.freeze([bytes]);
		const refusal = Object.freeze({ ok: false as const, reason: options.fault ?? "MAINTENANCE_SOURCE_UNAVAILABLE" });
		let calls = 0, futureWidth = 0;
		let seen: { reader: typeof outer.reader; tuple: Record<string, unknown> } | undefined;
		const result = execute<any>(`(() => { ${precloseFuture.getText(parsed)} })();`, {
			preclose: options.preclose ?? true, adoptionDrain: options.adoptionDrain ?? false,
			conservativeCurrentFuture: false,
			input: {}, maintenanceParticipants: participants, maintenanceFloor: floor, aheOriginal: ahe,
			futureRows: generations, retainedSigningData: retained, sourceEpoch: 3, guaranteedSigningFloors: [3],
			authenticatedMembershipPrefixes: membership, syntax: outer.reader,
			fullFutureProofEnvelopeByteLengths: [currentWidth],
			composeProspectiveCreatorMaintenancePrefixesForSizing: (_input: unknown, schedule: unknown,
				preclose: boolean, tuple: Record<string, unknown>, generationOnly: boolean, adoptionDrain: boolean,
				authenticated: unknown, shared?: typeof outer.reader) => {
				calls++;
				expect(schedule).toBeUndefined();
				expect([preclose, generationOnly, adoptionDrain]).toEqual([false, false, false]);
				expect(authenticated).toBe(membership);
				expect(shared).toBe(outer.reader);
				const owner = options.freshControl ? countedReader() : outer;
				if (options.freshControl) owners.push(owner);
				const reader = options.freshControl ? owner.reader : shared!;
				seen = { reader, tuple };
				if (options.fault !== undefined) return refusal;
				if (options.mutate === "detached") {
					(before.nested as { bytes: Uint8Array; members: string[] }).bytes.fill(0);
					(before.nested as { members: string[] }).members.push("changed");
				} else if (options.mutate === "input") {
					const changed = encodeCanonical({ kind: "two", epoch: 4, nested: { bytes: Uint8Array.of(7, 9), members: ["a", "b"] } });
					expect(changed.byteLength).toBe(bytes.byteLength);
					bytes.set(changed);
				} else if (options.mutate === "malformed") bytes[0] = 255;
				const value = reader.record(bytes);
				if (value === undefined) return refusal;
				expect(value).toEqual(decodeCanonical(bytes));
				const accounting = createCreatorClosedRollbackProofAccounting([]);
				// Full retained PRE and both equal unknown occurrences are charged
				// independently in the future lifetime, not refunded by syntax reuse.
				for (const carrier of tuple.signingPhysicalRows as readonly Uint8Array[])
					expect(accounting.charge(carrier)).toBe(true);
				for (const width of [17, 17]) expect(accounting.chargeUnknownEncodedLength(width)).toBe(true);
				futureWidth = accounting.chargedBytes;
				return Object.freeze({ ok: true, knownCarriers: Object.freeze([bytes]),
					unknownEncodedLengths: Object.freeze([17, 17]),
					fullFutureProofEnvelopeByteLengths: Object.freeze([futureWidth]) });
			},
		});
		const counts = owners.reduce((total, owner) => ({ parses: total.parses + owner.counts().parses,
			roundtrips: total.roundtrips + owner.counts().roundtrips }), { parses: 0, roundtrips: 0 });
		return { result, calls, seen, counts, bytes, original, before, refusal, currentWidth, futureWidth,
			participants, floor, ahe, generations, retained };
	}
	it("propagates one bounded syntax owner through the actual preclose-to-future recursion without changing widths or full PRE", () => {
		const shared = recursePreclose(), fresh = recursePreclose({ freshControl: true });
		expect(shared.result).toEqual(fresh.result);
		expect(shared.calls).toBe(1);
		expect(shared.counts).toEqual({ parses: 1, roundtrips: 1 });
		expect(fresh.counts).toEqual({ parses: 2, roundtrips: 2 });
		expect(shared.result.unknownEncodedLengths).toEqual([17, 17]);
		expect(shared.result.fullFutureProofEnvelopeByteLengths).toEqual([shared.bytes.byteLength + 34, shared.bytes.byteLength + 34]);
		expect(shared.currentWidth).toBe(shared.futureWidth);
		expect(shared.seen!.tuple.signingPhysicalRows).toBe(shared.retained);
		expect(shared.seen!.tuple.participants).toEqual(shared.participants);
		expect(shared.seen!.tuple.participants).not.toBe(shared.participants);
		expect(Object.isFrozen(shared.seen!.tuple.participants)).toBe(true);
		expect(shared.seen!.tuple.floor).toBe(shared.floor);
		expect(shared.seen!.tuple.ahe).toBe(shared.ahe);
		expect(shared.seen!.tuple.generations).toEqual(shared.generations);
		expect(shared.seen!.tuple.generations).not.toBe(shared.generations);
		expect(shared.bytes).toEqual(shared.original);
	});
	it("preserves the recursive refusal unchanged and does not run a future branch for preclose/drain-ineligible calls", () => {
		const limit = maintenanceProofMaxBytes();
		for (const fault of ["MAINTENANCE_SOURCE_UNAVAILABLE", `MAINTENANCE_FUTURE_PROOF_ENVELOPE_EXHAUSTED:${limit + 1}/${limit}`]) {
			const shared = recursePreclose({ fault }), fresh = recursePreclose({ fault, freshControl: true });
			expect(shared.result).toBe(shared.refusal);
			expect(shared.result).toEqual(fresh.result);
			expect(shared.counts).toEqual({ parses: 1, roundtrips: 1 });
		}
		for (const options of [{ preclose: false }, { adoptionDrain: true }]) {
			const gated = recursePreclose(options);
			expect(gated.calls).toBe(0);
			expect(gated.result).toBeUndefined();
		}
	});
	it("keeps captured values isolated and reparses same-object mutation across the recursive boundary", () => {
		const detached = recursePreclose({ mutate: "detached" });
		expect(detached.result.ok).toBe(true);
		expect(detached.bytes).toEqual(detached.original);
		expect(detached.counts).toEqual({ parses: 1, roundtrips: 1 });
		const changed = recursePreclose({ mutate: "input" });
		expect(changed.result.ok).toBe(true);
		expect(changed.counts).toEqual({ parses: 2, roundtrips: 2 });
		expect(changed.before.kind).toBe("one");
		expect(changed.seen!.reader.record(changed.bytes)!.kind).toBe("two");
		const malformed = recursePreclose({ mutate: "malformed" });
		expect(malformed.result).toBe(malformed.refusal);
		expect(malformed.before.kind).toBe("one");
		expect(malformed.counts).toEqual({ parses: 2, roundtrips: 1 });
	});
	it("preserves raw-decoder ambiguity and cross-epoch recognized-kind refusal", () => {
		const compose = unique((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "composeProspectiveCreatorMaintenancePrefixesForSizing");
		const bindings = new Map<string, ts.VariableDeclaration>();
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
				["select", "unique"].includes(node.name.text)) bindings.set(node.name.text, node);
			ts.forEachChild(node, visit);
		};
		visit(compose);
		expect(bindings.size).toBe(2);
		const select = (values: readonly { kind: string; epoch: number }[]) => {
			const candidates = values.map((value, index) => {
				const bytes = encodeCanonical(value);
				return { bytes, ref: { digest: String(index), byteLength: bytes.byteLength } };
			});
			const closure = { candidates, closure: candidates.map(candidate => candidate.ref) };
			const syntax = createCreatorCanonicalSyntaxReader();
			return execute(`const ${bindings.get("select")!.getText(parsed)};
				const ${bindings.get("unique")!.getText(parsed)}; unique(closure, "drp-hard-epoch-cut", 3);`, {
				closure, syntax, uniqueCreatorTransitionCandidate, canonicalCreatorDataRecord: syntax.record,
				exactCreatorTransitionOccurrence: (refs: typeof closure.closure, candidate: typeof candidates[number]) =>
					refs.filter(ref => ref.digest === candidate.ref.digest && ref.byteLength === candidate.ref.byteLength).length === 1,
				requireLaw: (ok: unknown) => { if (!ok) throw new Error("chain-invalid"); },
			});
		};
		expect(select([{ kind: "drp-hard-epoch-cut", epoch: 3 }])).toBeDefined();
		expect(() => select([{ kind: "drp-hard-epoch-cut", epoch: 3 },
			{ kind: "\ufeffdrp-hard-epoch-cut", epoch: 3 }])).toThrow("chain-invalid");
		expect(() => select([{ kind: "drp-hard-epoch-cut", epoch: 3 },
			{ kind: "drp-hard-epoch-cut", epoch: 2 }])).toThrow("chain-invalid");
	});
});

describe("single immutable journal plan native proof charges", () => {
	const digest = "a".repeat(64);
	const base: LiveJournalRetirementControl = {kind: "v3-live-journal-retirement-control-2",
		objectId: "room", incarnation: digest, revision: 2, sequence: 1, active: null, drain: null,
		completed: {decisionDigest: digest, sourceProofDigest: digest, throughEpoch: 0, protectedScopes: []}};
	const plan = {baseControl: base, sourceImage: {imageDigest: digest, scopeCount: 1, rowCount: 17, byteCharge: 1},
		prefixes: [{scope: {objectId: "room", epoch: 0, anchorDigest: digest}, highWatermark: 17,
			rows: Array.from({length: 17}, (_, journalSequence) => ({journalSequence,
				vertexDigest: journalSequence.toString(16).padStart(64, "0"), author: "writer",
				authorSequence: journalSequence + 1, nativeFrameDigest: digest}))}]};
	const controls = [0, 16, 17].map((cursor, batches): LiveJournalRetirementControl => ({...base,
		revision: base.revision + 1 + batches, drain: {plan, cursor, batches, residualImageDigest: digest}}));
	const native = controls.map(encodeJournalRetirementNativeCarriers);
	const raw = (control: LiveJournalRetirementControl, carriers: readonly Uint8Array[]) => execute<readonly Uint8Array[]>(
		`${declaration("closedJournalNativeControlCarriers")} closedJournalNativeControlCarriers(value);`,
		{value: {control, exactCanonicalControlCarriers: carriers},
			requireLaw: (ok: unknown) => {if (!ok) throw new Error("chain-invalid");},
			closedRetirementBytes: encodeCanonical});

	it("charges the complete immutable plan once and every distinct actual progress carrier", () => {
		const ledger = createCreatorClosedRollbackProofAccounting([]);
		let progressBytes = 0;
		for (const [index, carriers] of native.entries()) {
			expect(carriers.planBytes).toBeDefined();
			expect(carriers.planBytes).toEqual(native[0]!.planBytes);
			progressBytes += carriers.controlBytes.byteLength;
			for (const bytes of raw(controls[index]!, [carriers.controlBytes, carriers.planBytes!]))
				expect(ledger.charge(bytes)).toBe(true);
		}
		expect(ledger.chargedBytes).toBe(progressBytes + native[0]!.planBytes!.byteLength);
		expect(ledger.chargedBytes).toBeLessThan(controls.reduce((sum, control) => sum + encodeCanonical(control).byteLength, 0));
	});

	it("matches the shared complete native field widths without subtracting plan bytes", () => {
		const fields = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "journalNativeCarrierFields");
		for (const [index, carriers] of native.entries()) {
			const commitment = (decodeCanonical(carriers.controlBytes) as {drain: {planDigest: string}}).drain.planDigest;
			const widths = execute<number[]>(`const ${fields.getText(parsed)}; journalNativeCarrierFields(control).map(maintenanceCanonicalWidth);`,
				{control: controls[index], digest: commitment, journalRetirementNativeProgressFields,
					maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength});
			expect(widths).toEqual([carriers.controlBytes.byteLength, carriers.planBytes!.byteLength]);
		}
	});

	it("reserves exact unchanged plan bytes once per episode and retains them again in a fresh episode", () => {
		const fields = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "journalNativeCarrierFields");
		const admission = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "addJournalNativeControl");
		const commitment = (decodeCanonical(native[0]!.controlBytes) as {drain: {planDigest: string}}).drain.planDigest;
		const widths: number[] = [];
		execute(`const ${fields.getText(parsed)}; let reservedJournalPlan; const ${admission.getText(parsed)};
			for (const control of controls) addJournalNativeControl(control);
			reservedJournalPlan = undefined; addJournalNativeControl(controls[0]);`, {
			controls, digest: commitment, journalRetirementNativeProgressFields,
			maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
			add: (value: unknown) => {widths.push(encodeCanonical(value).byteLength);},
		});
		expect(widths).toEqual([native[0]!.controlBytes.byteLength, native[0]!.planBytes!.byteLength,
			native[1]!.controlBytes.byteLength, native[2]!.controlBytes.byteLength,
			native[0]!.controlBytes.byteLength, native[0]!.planBytes!.byteLength]);
	});

	it("preserves the complete original semantic PRE wrapper without embedding the newly exposed carrier array", () => {
		const original = {control: controls[0], image: plan.sourceImage, canonicalRows: [Uint8Array.of(1, 2)]};
		const value = {...original, exactCanonicalControlCarriers: [native[0]!.controlBytes, native[0]!.planBytes!]};
		const wrappers = execute<readonly unknown[]>(`${declaration("creatorIssuanceMaintenanceObservationCarriers")}
			creatorIssuanceMaintenanceObservationCarriers({journal: value, snapshot: null, ahe: null,
				floor: null, floorImage: null, snapshotInventory: null});`, {value});
		expect(encodeCanonical(wrappers[0])).toEqual(encodeCanonical(original));
	});
});

describe("native census consumes the certificate's complete authenticated anchor chain", () => {
	const verify = (dependencies: readonly { epoch: number; anchorDigest: string }[], omitChain = false, pending = false): boolean => {
		const known = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "known" &&
			node.initializer?.getText(parsed).includes("proof.dependencyAnchors") === true);
		const guard = unique((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) &&
			node.getText(parsed).startsWith("requireLaw(\n\t\t\t\tchild.dependencyAnchors.every"));
		const original = known.getText(parsed);
		const declaration = omitChain ? original.replace(
			/\.\.\.\[\.\.\.forward\.certificates, \.(?:.|\n)*?\.flatMap\(proof => proof\.dependencyAnchors\),/, "") : original;
		if (omitChain) expect(declaration).not.toBe(original);
		const certificate = { authenticatedSourceGenerations: [3,4,5].map(epoch => ({scope:{epoch,anchor:`anchor-${epoch}`}})),
			dependencyAnchors: [6,5,4,3,2,1].map(epoch => ({epoch,anchorDigest:`anchor-${epoch}`})) };
		return execute<boolean>(`const ${declaration}; ${guard.getText(parsed)} true;`, {
			forward: { currentTrust: { currentEpoch: 6, currentAnchorDigest: "anchor-6" },
				predecessorTrust: { currentEpoch: 5, currentAnchorDigest: "anchor-5" }, installed: [],
				certificates: pending ? [] : [certificate], ...(pending ? {pending:{trust:{currentEpoch:7,currentAnchorDigest:"anchor-7"},installed:[],certificates:[certificate]}} : {}) },
			facts: { summary: { cuts: [{ epoch: 4, closedAnchorDigest: "anchor-4", successorAnchorDigest: "anchor-5" }] } },
			child: { dependencyAnchors: dependencies },
			// The known chain also names the pinned genesis anchor at epoch 0.
			pin: { trust: { currentAnchorDigest: "anchor-0" } },
			requireLaw: (value: unknown, reason: string) => { if (!value) throw new Error(reason); },
		});
	};
	it("accepts the observed retained epoch2 debt, while the original selected-generation-only predicate rejects it", () => {
		const dependencies = [2,3,4,5,6].map(epoch => ({epoch,anchorDigest:`anchor-${epoch}`}));
		expect(verify(dependencies)).toBe(true);
		expect(() => verify(dependencies, true)).toThrow("chain-invalid");
	});
	it("does not accept a same-epoch fork or an anchor outside the authenticated chain", () => {
		for (const dependency of [{epoch:2,anchorDigest:"fork"},{epoch:0,anchorDigest:"unproved"},{epoch:8,anchorDigest:"unproved"}])
			expect(() => verify([dependency])).toThrow("chain-invalid");
	});
	it("uses the same authenticated chain supplied by a genuinely held pending certificate", () => {
		expect(verify([{epoch:2,anchorDigest:"anchor-2"}], false, true)).toBe(true);
	});
});

describe("scoped maintenance and measured ordinary entitlements", () => {
	it("locks the exact E3 immediate-I tuple, historical refusal and mathematical capacity boundary without changing policy", () => {
		// Numeric regression from the original fixed-world64 E3 failure. These
		// thirteen widths are actual retained PRE lengths, but the placeholder
		// bytes below are NOT signed PREs or native/authentication evidence.
		// The original cached/scalar sum observations agree on this exact tuple.
		// This is an arithmetic regression, NOT a production profile selection,
		// future-M/native-image theorem or positive64-writer continuation proof.
		const known = 1_300_706, projectedKnown = 1_303_444, historicalMaximum = 1_310_720,
			unknownEncodedLengths = [25_595, 81_436], exactCapacity = 1_410_475,
			preimageLengths = [432, 1384, 1384, 1384, 1384, 630, 432, 1384, 1384, 1384, 1384, 630, 432],
			minimumNativeUnknown = preimageLengths.reduce((sum, width) => sum + width, 0);
		expect(minimumNativeUnknown).toBe(13_628); expect(historicalMaximum - known).toBe(10_014);
		expect(projectedKnown - known).toBe(2738);
		expect(projectedKnown + unknownEncodedLengths.reduce((sum, width) => sum + width, 0)).toBe(exactCapacity);
		const candidateCarriers = [new Uint8Array(projectedKnown - known).fill(99)];
		const immediateGuard = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed).includes("ownerBook === undefined || sum(ownerBook.projectByteLengths(knownCarriers).whole"));
		const makeOwner = (maximum: number) => execute<{accounting: ReturnType<typeof createCreatorClosedRollbackProofAccounting>;
			project(unknown: readonly number[], effect: () => void): true | undefined;
			totals(): {knownBytes: number; protectedBytes: number; unknownEncodedBytes: number}}>(`
			const proofMaterialOwners = new WeakMap();
			${declaration("closedRetirementEqual")}
			${declaration("projectCreatorProofMaterialByteLengths")}
			${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}
			${declaration("maintenanceWidthSum")}
			const accounting = createCreatorClosedRollbackProofAccounting([]);
			const ownerBook = proofMaterialOwners.get(accounting), proof = {accounting}, knownCarriers = candidateCarriers;
			const sum = (...parts) => maintenanceWidthSum(parts);
			({accounting, totals: () => ownerBook.captureKnownResourceTotals(),
			 project: (unknownEncodedLengths, effect) => {${immediateGuard.getText(parsed)} effect(); return true;}});`, {
			CREATOR_ORDINARY_PROOF_MAX_BYTES: maximum,
			candidateCarriers,
		});
		const preimages = preimageLengths.map((length, index) => new Uint8Array(length).fill(index + 1));
		const seed = (owner: ReturnType<typeof makeOwner>) => {
			for (const bytes of [new Uint8Array(known - minimumNativeUnknown), ...preimages]) expect(owner.accounting.charge(bytes)).toBe(true);
			expect(owner.accounting.chargedBytes).toBe(known);
			for (const bytes of preimages) expect(owner.accounting.charge(bytes)).toBe(true); // Exact RAW retry cannot double-spend.
		};
		const owner = makeOwner(historicalMaximum); seed(owner);
		const before = owner.totals(); let effects = 0;
		expect(owner.project(unknownEncodedLengths, () => {effects++;})).toBeUndefined();
		expect(effects).toBe(0); expect(owner.totals()).toEqual(before);
		expect(owner.accounting.chargedBytes).toBe(known); // Projection spends/refunds nothing.
		expect(before).toEqual({knownBytes: known, protectedBytes: known, unknownEncodedBytes: 0});
		// UNKNOWN is an independent occurrence even when its width equals raw
		// bytes already present. Original refusal leaves the admitted book intact.
		expect(owner.accounting.chargeUnknownEncodedLength(unknownEncodedLengths[0]!)).toBe(false);
		expect(owner.accounting.chargedBytes).toBe(known); expect(owner.totals()).toEqual(before);
		const below = makeOwner(exactCapacity - 1); seed(below);
		expect(below.project(unknownEncodedLengths, () => {effects++;})).toBeUndefined();
		expect(below.accounting.chargedBytes).toBe(known); expect(effects).toBe(0);
		const boundary = makeOwner(exactCapacity); seed(boundary);
		expect(boundary.project(unknownEncodedLengths, () => {effects++;})).toBe(true);
		expect(effects).toBe(1); expect(boundary.accounting.chargedBytes).toBe(known);
		// Same original spend after a successful pure projection; no UNKNOWN
		// occurrence acquires equality credit from the already charged RAW union.
		for (const bytes of candidateCarriers) expect(boundary.accounting.charge(bytes)).toBe(true);
		expect(boundary.accounting.chargedBytes).toBe(projectedKnown);
		for (const width of unknownEncodedLengths) expect(boundary.accounting.chargeUnknownEncodedLength(width)).toBe(true);
		expect(boundary.totals()).toEqual({knownBytes: projectedKnown, protectedBytes: projectedKnown, unknownEncodedBytes: 107_031});
		expect(boundary.accounting.chargedBytes).toBe(exactCapacity);
		for (const bytes of [...preimages, ...candidateCarriers]) expect(boundary.accounting.charge(bytes)).toBe(true);
		expect(boundary.accounting.chargedBytes).toBe(exactCapacity);
		expect(boundary.accounting.chargeUnknownEncodedLength(1)).toBe(false);
		expect(boundary.accounting.chargeUnknownEncodedLength(unknownEncodedLengths[0]!)).toBe(false);
		expect(boundary.accounting.chargedBytes).toBe(exactCapacity);
	});
	it("reserves native35's full measured vectors under a finite workload class, without changing AHE or row limits", () => {
		expect(LOCAL_WORKLOAD_CAPACITY).toMatchObject({ordinaryProofBytes: 1310720,
			profile: "supported-64-writer-protected-window-1",
			maintenanceProofBytes: 4194304, journalImageBytes: 2097152, journalRows: 24576});
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		expect(LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows).toBe(24576);
		const old = sourceProofAccounting(false, 933888), current = createCreatorClosedRollbackProofAccounting([]);
		for (const ledger of [old, current]) expect(ledger.chargeUnknownEncodedLength(894829)).toBe(true);
		expect(old.chargeUnknownEncodedLength(76186)).toBe(false);
		expect(current.chargeUnknownEncodedLength(76186)).toBe(true);
		expect(current.chargedBytes).toBe(971015);
		expect(current.chargeUnknownEncodedLength(current.maxBytes - current.chargedBytes)).toBe(true);
		expect(current.chargeUnknownEncodedLength(1)).toBe(false);
		const oldMaintenance = sourceProofAccounting(true, 933888, 876544), maintenance = sourceProofAccounting(true);
		for (const ledger of [oldMaintenance, maintenance]) expect(ledger.chargeUnknownEncodedLength(810219)).toBe(true);
		expect(oldMaintenance.chargeUnknownEncodedLength(421260)).toBe(false);
		expect(maintenance.chargeUnknownEncodedLength(421260)).toBe(true);
		expect(maintenance.chargedBytes).toBe(1231479);
		const future = sourceProofAccounting(true);
		expect(future.chargeUnknownEncodedLength(2320471)).toBe(true);
		// Numeric policy regression only: these reservations are neither native
		// lifetime consumption nor proof that cleanup/stabilization completed.
	});
	it("admits the measured complete 64-Writer quote with finite headroom while preserving the original1MiB refusal", () => {
		const original = sourceProofAccounting(false, 1048576);
		expect(original.chargeUnknownEncodedLength(902089 + 39462)).toBe(true);
		expect(original.chargeUnknownEncodedLength(109010)).toBe(false);
		expect(original.chargedBytes).toBe(941551);
		const current = createCreatorClosedRollbackProofAccounting([]);
		expect(Number.isSafeInteger(current.maxBytes)).toBe(true);
		expect(current.maxBytes).toBe(1310720);
		// Numeric policy replay of the terminal quote:1014185 is measured
		// charged known evidence,147231 is an unknown runtime reservation.
		// These arithmetic assertions are not native lifetime/cleanup evidence.
		expect(current.chargeUnknownEncodedLength(1014185)).toBe(true);
		expect(current.chargeUnknownEncodedLength(147231)).toBe(true);
		expect(current.chargedBytes).toBe(1161416);
		expect(current.maxBytes - current.chargedBytes).toBe(149304);
		expect(current.chargeUnknownEncodedLength(149304)).toBe(true);
		expect(current.chargeUnknownEncodedLength(1)).toBe(false);
		expect(current.maxBytes).toBe(1310720);
		expect(current.chargedBytes).toBe(1310720);
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		expect(LOCAL_WORKLOAD_CAPACITY).toMatchObject({maintenanceProofBytes:4194304,
			journalImageBytes:2097152,journalRows:24576});
		const future = sourceProofAccounting(true);
		expect(future.chargeUnknownEncodedLength(2387867)).toBe(true);
	});
	it("admits native25's complete immediate upper bound separately from its future and native image bounds", () => {
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		expect(CREATOR_ORDINARY_PROOF_MAX_BYTES).toBe(LOCAL_WORKLOAD_CAPACITY.ordinaryProofBytes);
		expect(maintenanceProofMaxBytes()).toBe(LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes);
		// Preserve this accepted historical envelope at its original policy pin.
		const actual = sourceProofAccounting(false, 933888);
		expect(actual.maxBytes).toBe(933888);
		// Original failed frame: no omitted protected material or assumed identity.
		expect(actual.chargeUnknownEncodedLength(769319)).toBe(true);
		for (const width of [2539,606,17253,17253,7122,963,1868,326,7122,1384,1101])
			expect(actual.chargeUnknownEncodedLength(width)).toBe(true);
		for (const width of [22880,76186,0]) expect(actual.chargeUnknownEncodedLength(width)).toBe(true);
		expect(actual.chargedBytes).toBe(925922);
		expect(actual.chargeUnknownEncodedLength(7966)).toBe(true);
		expect(actual.chargeUnknownEncodedLength(1)).toBe(false);
		const future = sourceProofAccounting(true, 786432, 876544);
		expect(future.chargeUnknownEncodedLength(874158)).toBe(true);
		expect(future.chargeUnknownEncodedLength(2386)).toBe(true);
		expect(future.chargeUnknownEncodedLength(1)).toBe(false);
		const historical = sourceProofAccounting(false, 786432);
		expect(historical.chargeUnknownEncodedLength(888783)).toBe(false);
	});
	it("preserves the historical640KiB refusal while admitting the measured maintenance lifetimes", () => {
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		expect(maintenanceProofMaxBytes()).toBe(LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes);
		// Historical policy evidence, not the current production entitlement.
		const ordinary = sourceProofAccounting(false, 655360);
		expect(ordinary.maxBytes).toBe(655360);
		expect(ordinary.charge(new Uint8Array(109866))).toBe(true);
		expect(ordinary.charge(new Uint8Array(560509))).toBe(false);
		expect(ordinary.chargedBytes).toBe(109866);
		// Last value is the observed E6 prefix plus its refused distinct native
		// coordinator readback, not a claim that the complete lifetime ends there.
		for (const nativeLifetime of [728191, 720577, 770270 + 22353]) {
			const maintenance = sourceProofAccounting(true);
			expect(maintenance.maxBytes).toBe(LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes);
			expect(maintenance.charge(new Uint8Array(nativeLifetime))).toBe(true);
			expect(maintenance.chargedBytes).toBe(nativeLifetime);
		}
	});
	it("preserves the earlier measured64-Writer quote at its historical768KiB policy", () => {
		const initialAndDistinctKnown = 591197 + 42859;
		const unknown = [23077, 75421, 0];
		const historical = sourceProofAccounting(false, 655360);
		expect(historical.charge(new Uint8Array(initialAndDistinctKnown))).toBe(true);
		expect(historical.chargeUnknownEncodedLength(unknown[0]!)).toBe(false);
		expect(historical.chargedBytes).toBe(634056);
		const current = sourceProofAccounting();
		expect(current.maxBytes).toBe(786432);
		expect(current.charge(new Uint8Array(initialAndDistinctKnown))).toBe(true);
		for (const width of unknown) expect(current.chargeUnknownEncodedLength(width)).toBe(true);
		expect(current.chargedBytes).toBe(732554);
		expect(current.maxBytes - current.chargedBytes).toBe(53878);
		expect(current.chargeUnknownEncodedLength(53878)).toBe(true);
		expect(current.chargeUnknownEncodedLength(1)).toBe(false);
		expect(current.chargedBytes).toBe(786432);
	});
	it("enforces the maintenance ceiling cumulatively including every unknown occurrence", () => {
		const ledger = sourceProofAccounting(true);
		const known = new Uint8Array(728191);
		expect(ledger.charge(known)).toBe(true);
		expect(ledger.chargeUnknownEncodedLength(maintenanceProofMaxBytes() - 728191)).toBe(true);
		expect(ledger.charge(known.slice())).toBe(true);
		expect(ledger.chargedBytes).toBe(maintenanceProofMaxBytes());
		expect(ledger.chargeUnknownEncodedLength(1)).toBe(false);
		expect(ledger.charge(new Uint8Array([1]))).toBe(false);
		expect(ledger.chargedBytes).toBe(maintenanceProofMaxBytes());
	});
	it("admits the corrected869508-byte forecast while preserving the848KiB refusal and native ceiling", () => {
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		const current = sourceProofAccounting(true);
		const historical = execute<ReturnType<typeof createCreatorClosedRollbackProofAccounting>>(
			`${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}
			createCreatorClosedRollbackProofAccounting([], true);`, {
				AHE_BOUNDED_READ_LIMITS, proofMaterialOwners: new WeakMap(), CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 868352,
			}
		);
		expect(historical.chargeUnknownEncodedLength(869508)).toBe(false);
		expect(historical.chargedBytes).toBe(0);
		expect(current.chargeUnknownEncodedLength(869508)).toBe(true);
		expect(current.maxBytes - current.chargedBytes).toBe(maintenanceProofMaxBytes() - 869508);
		expect(current.chargeUnknownEncodedLength(maintenanceProofMaxBytes() - 869508)).toBe(true);
		expect(current.chargeUnknownEncodedLength(1)).toBe(false);
	});
});

describe("whole-prefix native nonlocal refusal", () => {
	const scope = { objectId: "room", epoch: 0, anchorDigest: "old" };
	const equal = (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0;
	const frame = (kind: string, row: unknown, selected = scope) => encodeCanonical([
		kind, [selected.objectId, selected.epoch, selected.anchorDigest, 0], row,
	]);
	const hasNonlocal = (frames: Uint8Array[]) => execute<boolean>(
		`${declaration("closedJournalScopeHasNonLocalRows")} closedJournalScopeHasNonLocalRows(frames, scope);`,
		{ frames, scope, decodeCanonical, closedRetirementEqual: equal }
	);
	it("uses both native encodings for refusal only, without attributing foreign scopes or metadata", () => {
		for (const [kind, field] of [["acceptedEntries", "sourceKind"], ["accepted_entries", "source_kind"]]) {
			expect(hasNonlocal([frame(kind!, { [field!]: "received" })])).toBe(true);
			expect(hasNonlocal([frame(kind!, { [field!]: "local-issued" })])).toBe(false);
			expect(hasNonlocal([frame(kind!, { [field!]: "received" }, { ...scope, anchorDigest: "fork" })])).toBe(false);
		}
		expect(hasNonlocal([frame("scopes", { sourceKind: "received" })])).toBe(false);
		expect(hasNonlocal([frame("acceptedEntries", {})])).toBe(true);
	});
	it("uses that same refusal in the forecast without changing physical source rows", () => {
		const start = source.indexOf("const journalClassifierWidths: number[] = [];");
		const end = source.indexOf("// The original classifier puts each native scope", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		for (const nonlocal of [false, true]) {
			const frames = [frame("accepted_entries", { source_kind: nonlocal ? "received" : "local-issued",
				journal_sequence: 0, vertex_digest: "vertex", local_author: "writer", local_author_sequence: 1,
				received_preimage: Uint8Array.of(1), received_signature: Uint8Array.of(2) })];
			const before = frames.map(bytes => bytes.slice());
			const widths = execute<number[]>(`${declaration("closedJournalScopeHasNonLocalRows")}
				${source.slice(start, end)} journalClassifierWidths;`, {
				capture: { journal: { canonicalRows: frames } }, potentialJournalScopes: [scope], objectId: scope.objectId,
				authenticatedMembershipPrefixes: [],
				epoch: 9, trust: { currentAnchorDigest: "different" }, digest: "digest",
				maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
				closedRetirementEqual: equal,
			});
			expect(widths.length).toBe(nonlocal ? 0 : 2);
			expect(frames).toEqual(before);
		}
	});
	const classify = async (nonlocal: boolean, stale = false) => {
		const frames = [encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest], {}]),
			frame("accepted_entries", { source_kind: nonlocal ? "received" : "local-issued" })];
		const before = frames.map(bytes => bytes.slice());
		const image = { canonicalRows: frames, image: { rowCount: 1, imageDigest: "native-image" } };
		let readiness = 0, pages = 0, recensus = 0, checks = 0;
		const charged: Uint8Array[] = [];
		const input = {
			objectId: scope.objectId, image, physical: image, summary: { cuts: [] }, floor: { pending: null },
			censusBytes: encodeCanonical({ currentJournal: { scope: { ...scope, epoch: 2, anchorDigest: "current" } },
				nativeIssuance: { rows: { issued: [], outbox: [] } }, rows: [] }),
			sourceTrust: undefined, unclassifiedReplay: false, protectedRoleScopes: [], authenticatedScopes: [scope],
			accounting: { charge: (bytes: Uint8Array) => { charged.push(bytes); return true; } },
			check: async () => { checks++; },
			journal: {
				readiness: async () => { readiness++; return { ok: false }; },
				readPage: async () => { pages++; throw new Error("unexpected page"); },
				readRetirementImage: async () => { recensus++; return { ok: true, value: stale ? { ...image, changed: true } : image }; },
			},
		};
		const code = ["closedNativeJournalScopes", "closedJournalScopeHasNonLocalRows", "closedJournalProtectedReplayScopes", "closedJournalMembershipPrefix",
			"prepareClosedJournalMembershipPrefix", "prepareClosedJournalDetails", "classifyClosedJournalDetails"].map(declaration).join("\n");
		const result = await execute<Promise<{ collectiblePrefixes: unknown[]; retainedScopes: unknown[] }>>(
			`${code} classifyClosedJournalDetails(input);`, {
				input, decodeCanonical, record: (bytes: Uint8Array) => decodeCanonical(bytes),
				closedRetirementEqual: equal, closedRetirementBytes: encodeCanonical,
				closedJournalNativeObservationEqual: equal, // Controlled native currency port; real component codec has its own regression below.
				requireLaw: (ok: boolean, reason: string) => { if (!ok) throw new Error(reason); },
				bindMethod: (owner: Record<string, (...args: unknown[]) => unknown>, name: string) => owner[name]!.bind(owner),
			}
		);
		expect(frames).toEqual(before);
		return { result, readiness, pages, recensus, checks, charged };
	};
	it("retains the complete nonlocal prefix without pages and still joins the final native currency check", async () => {
		const observed = await classify(true);
		expect(observed.result.collectiblePrefixes).toEqual([]);
		expect(observed.result.retainedScopes).toEqual([{ scope, reason: "unclassified-prefix" }]);
		expect(observed.readiness).toBe(0);
		expect(observed.pages).toBe(0);
		expect(observed.recensus).toBe(1);
		expect(observed.checks).toBe(3);
		expect(observed.charged).toEqual([encodeCanonical(observed.result)]);
	});
	it("keeps local prefixes on their native-read path and rejects changed physical images", async () => {
		const observed = await classify(false);
		expect(observed.readiness).toBe(1);
		expect(observed.result.retainedScopes).toEqual([{ scope, reason: "read-refused" }]);
		await expect(classify(true, true)).rejects.toThrow("floor-stale");
	});
});

describe("closed membership synchronous validation and fresh delivery currency", () => {
	const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
	// This is the existing membership/Merkle machinery plus genuine vertex
	// signatures. The Cut/ACL authority is supplied by the authenticated caller;
	// this focused seam does not claim to verify Cut/QC signatures or native CAS.
	async function membershipFixture(count = 8, sql = false, duplicateIdentity = false, epoch = 4) {
		const seed = new Uint8Array(32).fill(23), author = hex(ed25519.getPublicKey(seed));
		const scope = { objectId: "a1".repeat(32), epoch, anchorDigest: "" };
		const aclBytes = encodeCanonical({ kind: "drp-v3-latched-acl", version: 3,
			objectId: scope.objectId, epoch: scope.epoch, permissionless: false,
			members: [{ author, finalityKey: null, groups: ["admin", "writer"] }] });
		const previous = new CompactMerkleAccumulator(), maxEpochVertices = count + 1;
		const anchorBytes = encodeCanonical({ kind: "drp-epoch-anchor", protocolMajor: 3,
			objectId: scope.objectId, epoch: scope.epoch, aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", aclBytes)),
			archiveIndexRoot: "02".repeat(32), blueprintDigest: "03".repeat(32), cryptoSuiteId: "ed25519-sha256-v3",
			cutDigest: "04".repeat(32), historyRoot: hex(previous.root()), historySize: 0,
			parametersDigest: "05".repeat(32), previousAnchor: "06".repeat(32), profileDigest: "07".repeat(32),
			signerSetDigest: "08".repeat(32), stateDigest: "09".repeat(32) });
		scope.anchorDigest = hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
		const vertices = new Map<string, EpochVertex>([[scope.anchorDigest, { dependencies: [],
			epoch: scope.epoch, hash: scope.anchorDigest, kind: "drp-epoch-anchor", objectId: scope.objectId }]]);
		const charges = new Map<string, number>();
		const witnesses: Array<{ vertexDigest: string; exactCanonicalPreimageBytes: Uint8Array; detachedSignature: Uint8Array }> = [];
		const rows: Uint8Array[] = [], expected: Array<Record<string, unknown>> = [];
		let parent = scope.anchorDigest;
		for (let ordinal = 0; ordinal < count; ordinal++) {
			const sequence = duplicateIdentity ? 0 : ordinal;
			const preimage = encodeCanonical({ kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId,
				epoch: scope.epoch, anchor: scope.anchorDigest, author, authorSequence: sequence, logicalTime: ordinal + 1,
				dependencies: [parent], operation: { action: "placeBlock", id: `block-${ordinal}`, x: ordinal, y: 1 } });
			const digestBytes = hashDomain("ts-drp/vertex/v3", preimage), digest = hex(digestBytes);
			const signature = ed25519.sign(digestBytes, seed), local = !duplicateIdentity && ordinal % 2 === 0;
			vertices.set(digest, { anchor: scope.anchorDigest, dependencies: [parent], epoch: scope.epoch,
				hash: digest, kind: "drp-vertex", objectId: scope.objectId });
			charges.set(digest, preimage.byteLength);
			if (local) witnesses.push({ vertexDigest: digest, exactCanonicalPreimageBytes: preimage, detachedSignature: signature });
			const row = sql
				? { vertex_digest: digest, source_kind: local ? "local-issued" : "received",
					...(local ? { local_author: author, local_author_sequence: sequence }
						: { received_preimage: preimage, received_signature: signature }) }
				: { vertexDigest: digest, sourceKind: local ? "local-issued" : "received",
					...(local ? { localAuthor: author, localAuthorSequence: sequence }
						: { exactCanonicalPreimageBytes: preimage, detachedSignature: signature }) };
			const bytes = encodeCanonical([sql ? "accepted_entries" : "acceptedEntries",
				[scope.objectId, scope.epoch, scope.anchorDigest, ordinal], row]);
			rows.push(bytes);
			expected.push({ journalSequence: ordinal, vertexDigest: digest, author, authorSequence: sequence,
				nativeFrameDigest: journalRetirementFrameDigest(bytes),
				...(local ? {} : { exactCanonicalNativeFrameBytes: bytes.slice() }) });
			parent = digest;
		}
		const commitment = await deriveCloseSetHistoryCommitment({ authenticatedCanonicalPreimageByteLengths: charges,
			exactCanonicalEpochAnchorPreimageBytes: anchorBytes, frontier: [parent], maxEpochBytes: 65536,
			maxEpochVertices, previousHistorySnapshot: previous.snapshot(), vertices });
		const cutBytes = encodeCanonical({ kind: "drp-hard-epoch-cut", protocolMajor: 3, objectId: scope.objectId,
			epoch: scope.epoch, previousAnchor: scope.anchorDigest, previousHistorySize: 0,
			historySize: commitment.historySize, historyRoot: commitment.historyRoot,
			closeSetRoot: commitment.closeSetRoot, closeSetCount: commitment.closeSetCount, parameters: { maxEpochVertices } });
		const membership = await encodeCreatorCloseMembership({ commitment, exactCanonicalCutValueBytes: cutBytes,
			exactCanonicalLatchedAclBytes: aclBytes, maxEpochVertices, localVertexWitnesses: witnesses });
		const header = encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest],
			sql ? { next_journal_sequence: count, closed_membership_bytes: membership }
				: { nextJournalSequence: count, closedMembershipBytes: membership }]);
		return { scope, canonicalRows: [header, ...rows], expected, authorities: [{ scope,
			exactCanonicalCutValueBytes: cutBytes, closedAclDigest: hex(hashDomain("ts-drp/latched-acl/v3", aclBytes)),
			profileId: "creator-trusted-settlement-v1", suiteId: "ed25519-sha256-v3" }] };
	}
	type MembershipFixture = Awaited<ReturnType<typeof membershipFixture>>;
	type Prefix = { scope: MembershipFixture["scope"]; snapshot: null; highWatermark: number; rows: Array<Record<string, unknown>> };
	// Private callback data from the SAME original membership validation. This
	// fixture supplies Cut/native authority; neither this type nor captured bytes
	// grants neutral-effect classification, a native read or pruning permission.
	type ApplicationRow = Readonly<{scope: MembershipFixture["scope"]; journalSequence: number; vertexDigest: string;
		author: string; authorSequence: number; exactCanonicalNativeFrameBytes: Uint8Array;
		exactCanonicalPreimageBytes: Uint8Array; detachedSignature: Uint8Array; profileId: string;
		sourceKind: "local-issued" | "received"; vertexData: Readonly<Record<string, unknown>>}>;
	function runPrefix(f: MembershipFixture, check: () => Promise<void>,
		verify = verifyReceivedVertex, open = openCreatorCloseMembership,
		captureApplicationRows?: (rows: readonly ApplicationRow[]) => void,
		decode = decodeCanonical, installedThroughEpoch?: () => number): Promise<Prefix | undefined> {
		return execute(`${declaration("prepareClosedJournalMembershipPrefix")}\n${declaration("closedJournalMembershipPrefix")}\nclosedJournalMembershipPrefix(input);`, {
			input: { scope: f.scope, image: { canonicalRows: f.canonicalRows }, authorities: f.authorities, check, installedThroughEpoch,
				...(captureApplicationRows === undefined ? {} : {captureApplicationRows}) },
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
			decodeCanonical: decode, record: decodeCanonical, openCreatorCloseMembership: open, openCanonicalLatchedAclSnapshot,
			authorizeLatchedEnvelopeAuthor, verifyReceivedVertex: verify, registry, journalRetirementFrameDigest,
			closedRetirementHex: (value: string) => Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16)),
			requireLaw: (ok: boolean, reason = "chain-invalid") => { if (!ok) throw new Error(reason); },
		});
	}
	function editRow(f: MembershipFixture, ordinal: number, change: (row: Record<string, unknown>, frame: unknown[]) => void) {
		const frame = decodeCanonical(f.canonicalRows[ordinal + 1]!) as unknown[];
		change(frame[2] as Record<string, unknown>, frame);
		f.canonicalRows[ordinal + 1] = encodeCanonical(frame);
	}
	it("reconstructs private native images through one existing bounded row capture with exact original image semantics", async () => {
		const path = new URL("../../live-journal/src/retirement.ts", import.meta.url);
		const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const fn = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "imageOfFrames");
		if (fn === undefined) throw Error("PRIVATE_NATIVE_IMAGE_OWNER_MISSING");
		for (const sql of [false, true]) {
			const fixture = await membershipFixture(16, sql);
			const frames = fixture.canonicalRows.map(bytes => {
				const [table, key, row] = decodeCanonical(bytes) as [string, unknown[], unknown]; return {bytes, table, key, row};
			});
			const calls = {append: 0, finish: 0, release: 0};
			const run = execute<(input: typeof frames) => unknown>(`${fn.getText(ast)}\nimageOfFrames;`, {
				journalRetirementImageCountsFit: (scopes: number, rows: number) => scopes <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows && rows <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows,
				createJournalRetirementImageCapture: () => {const capture = createJournalRetirementImageCapture(); return {
					append: (...args: Parameters<typeof capture.append>) => {calls.append++; return capture.append(...args);},
					finish: () => {calls.finish++; return capture.finish();}, release: () => {calls.release++; capture.release();},
				};},
			});
			const expected = journalRetirementImage(frames.filter(f => f.table === "scopes").map(f => f.row),
				frames.filter(f => f.table !== "scopes").map(f => f.row));
			expect(run(frames)).toEqual(expected);
			expect(calls).toEqual({append: frames.length, finish: 1, release: 1});
			// Input and public oracle retain their own defensive codec boundaries.
			const malformed = [...frames, {bytes: Uint8Array.of(255), table: "acceptedEntries", key: [], row: {bad: Infinity}}];
			expect(() => run(malformed)).toThrow("NaN and Infinity are outside the canonical domain");
			expect(calls.release).toBe(2);
		}
	});
	it("parses each native frame once per prefix and refuses changed carriers across membership acquisition", async () => {
		for (const sql of [false, true]) {
			const f = await membershipFixture(16, sql); let decodes = 0, checks = 0, signatures = 0;
			const result = await runPrefix(f, async () => {checks++;}, input => {signatures++; return verifyReceivedVertex(input);},
				openCreatorCloseMembership, undefined, bytes => {decodes++; return decodeCanonical(bytes);});
			expect(result).toEqual({scope: f.scope, snapshot: null, highWatermark: 16, rows: f.expected});
			expect({decodes, checks, signatures}).toEqual({decodes: f.canonicalRows.length, checks: 2, signatures: 16});
			for (const change of [
				(value: MembershipFixture) => {value.canonicalRows[2]![0]! ^= 1;},
				(value: MembershipFixture) => {value.canonicalRows[2] = value.canonicalRows[1]!.slice();},
				(value: MembershipFixture) => {value.canonicalRows.pop();},
			]) {
				const changed = await membershipFixture(4, sql); let captures = 0, verified = 0;
				await expect(runPrefix(changed, async () => {change(changed);}, input => {verified++; return verifyReceivedVertex(input);},
					openCreatorCloseMembership, () => {captures++;})).rejects.toThrow("chain-invalid");
				expect({verified, captures}).toEqual({verified: 0, captures: 0});
			}
		}
	});
	it("captures complete signed application row data once without changing the original prefix or PRE/UNKNOWN charge basis", async () => {
		for (const sql of [false, true]) {
			const f = await membershipFixture(8, sql), before = f.canonicalRows.map(bytes => bytes.slice());
			let checks = 0; const captures: Array<readonly ApplicationRow[]> = [];
			const result = await runPrefix(f, async () => {checks++;}, verifyReceivedVertex, openCreatorCloseMembership, rows => {captures.push(rows);});
			expect(checks).toBe(2); expect(captures).toHaveLength(1);
			expect(result).toEqual({scope: f.scope, snapshot: null, highWatermark: 8, rows: f.expected});
			expect(captures[0]).toHaveLength(8);
			for (const [index, row] of captures[0]!.entries()) {
				expect({scope: row.scope, journalSequence: row.journalSequence, vertexDigest: row.vertexDigest, author: row.author,
					authorSequence: row.authorSequence, profileId: row.profileId}).toEqual({scope: f.scope, journalSequence: index,
					vertexDigest: f.expected[index]!.vertexDigest, author: f.expected[index]!.author,
					authorSequence: f.expected[index]!.authorSequence, profileId: "creator-trusted-settlement-v1"});
				expect(row.exactCanonicalNativeFrameBytes).toEqual(before[index + 1]);
				expect(row.exactCanonicalNativeFrameBytes).not.toBe(f.canonicalRows[index + 1]);
				const preimage = decodeCanonical(row.exactCanonicalPreimageBytes) as {author: string; authorSequence: number; epoch: number; anchor: string};
				expect(row.vertexData).toEqual(preimage);
				expect(row.sourceKind).toBe(index % 2 === 0 ? "local-issued" : "received");
				expect(preimage).toMatchObject({author: row.author, authorSequence: row.authorSequence, epoch: f.scope.epoch, anchor: f.scope.anchorDigest});
				const digest = hashDomain("ts-drp/vertex/v3", row.exactCanonicalPreimageBytes);
				expect(hex(digest)).toBe(row.vertexDigest);
				expect(ed25519.verify(row.detachedSignature, digest, Uint8Array.from(row.author.match(/../gu)!, pair => Number.parseInt(pair, 16)))).toBe(true);
			}
			// Callback data does not itself spend or refund a book. The original
			// producer separately charges every captured carrier into its SAME book.
			const oldBook = createCreatorClosedRollbackProofAccounting([]), newBook = createCreatorClosedRollbackProofAccounting([]);
			for (const book of [oldBook, newBook]) {
				for (const bytes of before) expect(book.charge(bytes)).toBe(true);
				expect(book.charge(encodeCanonical(result))).toBe(true);
				for (const unknown of [17, 17]) expect(book.chargeUnknownEncodedLength(unknown)).toBe(true);
			}
			expect(newBook.chargedBytes).toBe(oldBook.chargedBytes);
			const exactPrefix = encodeCanonical(result);
			for (const row of captures[0]!) {row.exactCanonicalNativeFrameBytes.fill(0); row.exactCanonicalPreimageBytes.fill(0); row.detachedSignature.fill(0);}
			expect(f.canonicalRows).toEqual(before); expect(encodeCanonical(result)).toEqual(exactPrefix);
		}
	});
	it("uses complete owned signed-row DATA for geometry without rebuilding discarded derivatives", async () => {
		for (const sql of [false, true]) {
			const f = await membershipFixture(8, sql); let rows: readonly ApplicationRow[] = [];
			await runPrefix(f, async () => {}, verifyReceivedVertex, openCreatorCloseMembership, value => {rows = value;});
			let parses = 0, derivatives = 0;
			const geometry = execute<(journal: unknown, native: unknown, closed: readonly ApplicationRow[]) => boolean>(
				`${declaration("creatorOrdinaryCapturedEpochGeometryFits")}\n${declaration("creatorOrdinaryReadinessJournalGeometryIsCompleteForSizing")}\n` +
				`creatorOrdinaryReadinessJournalGeometryIsCompleteForSizing;`, {
					record: (raw: Uint8Array) => {parses++; const value = canonicalCreatorDataRecord(raw); if (!value) throw Error("invalid PRE"); return value;},
					encodeCanonical: (value: unknown) => {derivatives++; return encodeCanonical(value);}, creatorAuthenticatedEpochVertexFields,
					closedRetirementHex: (value: string) => Uint8Array.from(Buffer.from(value, "hex")),
				});
			expect(geometry({canonicalRows: f.canonicalRows}, {rows: {issued: []}}, rows)).toBe(true);
			expect({parses, derivatives}).toEqual({parses: 0, derivatives: 0});
			// Received detail still has its native PRE; an uncovered row uses the
			// original construction. A pruned local PRE requires exact membership.
			expect(geometry({canonicalRows: f.canonicalRows}, {rows: {issued: []}}, rows.filter(row => row.journalSequence !== 1))).toBe(true);
			expect({parses, derivatives}).toEqual({parses: 1, derivatives: 1});
			expect(geometry({canonicalRows: f.canonicalRows}, {rows: {issued: []}}, rows.filter(row => row.journalSequence !== 0))).toBe(false);
			expect(geometry({canonicalRows: f.canonicalRows}, {rows: {issued: []}}, [...rows, rows[0]!])).toBe(false);
			const original = rows[0]!, wrong = {...original, sourceKind: "received" as const};
			expect(geometry({canonicalRows: f.canonicalRows}, {rows: {issued: []}}, [wrong, ...rows.slice(1)])).toBe(false);
		}
	});
	it("keeps captured derivative geometry within the original canonical byte, item and depth bounds", async () => {
		const f = await membershipFixture(2); let rows: readonly ApplicationRow[] = [];
		await runPrefix(f, async () => {}, verifyReceivedVertex, openCreatorCloseMembership, value => {rows = value;});
		const fits = execute<(row: ApplicationRow, bytes: Uint8Array, digest: string) => boolean>(
			`${declaration("creatorOrdinaryCapturedEpochGeometryFits")}\ncreatorOrdinaryCapturedEpochGeometryFits;`, {});
		const original = rows[0]!;
		// Preserve the original whole-record boundary's leading-BOM refusal;
		// the reuse path must not invent a parsed record for those bytes.
		expect(canonicalCreatorDataRecord(encodeCanonical({...original.vertexData, operation: {action: "\ufeffmove"}}))).toBeUndefined();
		for (const operation of [original.vertexData.operation, {action: "move\ufeff", text: "雪🙂", data: new Uint8Array(1024)},
			{action: "nested", values: Array.from({length: 130}, (_, index) => ({index, body: [null, true, "x".repeat(index)]}))}]) {
			for (const settlement of [false, true]) {
				const preimage = encodeCanonical({...original.vertexData, operation,
					...(settlement ? {settlementSource: {source: "historical", dependencies: ["a".repeat(64)]}} : {})});
				const vertexData = canonicalCreatorDataRecord(preimage)!;
				const row = {...original, vertexData, exactCanonicalPreimageBytes: preimage};
				expect(fits(row, preimage.slice(), row.vertexDigest)).toBe(true);
				const derivative = encodeCanonical(creatorAuthenticatedEpochVertexFields({anchor: vertexData.anchor as string,
					objectId: vertexData.objectId as string, epoch: vertexData.epoch as number,
					dependencies: vertexData.dependencies as string[], hash: row.vertexDigest,
					kind: "drp-vertex", operation: vertexData.operation as Record<string, unknown>}));
				const before = canonicalCarrierResourceForSizing(preimage, 128, {}, "exact"),
					after = canonicalCarrierResourceForSizing(derivative, 128, {}, "exact");
				expect(after.byteLength).toBeLessThanOrEqual(before.byteLength);
				expect(after.items).toBeLessThanOrEqual(before.items);
				expect(after.maxDepth).toBeLessThanOrEqual(before.maxDepth);
				expect(() => encodeCanonical(decodeCanonical(derivative), {
					maxBytes: before.byteLength, maxItems: before.items, maxDepth: before.maxDepth})).not.toThrow();
				const changed = preimage.slice(); changed[changed.length - 1]! ^= 1;
				expect(fits(row, changed, row.vertexDigest)).toBe(false);
				expect(fits(row, preimage, "foreign")).toBe(false);
				expect(fits({...row, scope: {...row.scope, epoch: row.scope.epoch + 1}}, preimage, row.vertexDigest)).toBe(false);
				expect(fits({...row, vertexData: {...vertexData, unexpected: true}}, preimage, row.vertexDigest)).toBe(false);
			}
		}
	});
	it("retains every operation obligation while reusing exact private PRE projections and isolating callback input", async () => {
		for (const sql of [false, true]) {
			const f = await membershipFixture(8, sql); let rows: readonly ApplicationRow[] = [];
			await runPrefix(f, async () => {}, verifyReceivedVertex, openCreatorCloseMembership, value => {rows = value;});
			const catalog = {artifactId: "artifact", artifactDigest: "digest", catalogDigest: "catalog", runtimeProfile: "runtime",
				exactArtifactBytes: Uint8Array.of(1), canonicalBlueprintPackageBytes: Uint8Array.of(2)};
			const frame = {input: {capturedCatalog: {}}, accounting: {}}, issued: Record<string, unknown>[] = [];
			const source = {catalogDigest: "catalog", applicationJournalRows: rows, blobs: []};
			const input = {current: {runtime: {objectId: f.scope.objectId}, blueprint: {blueprintDigest: "blueprint", catalog,
				maxApplicationStateBytes: 65536, maxItems: 16384, maxDepth: 16, exactCanonicalBaseStateBytes: encodeCanonical({})},
				applicationControls: [], currentApplicationPreimageBytes: [], pendingIngress: {roots: []}}, sourceFacts: source, frame,
				capture: {nativeIssuance: {rows: {issued, outbox: [], lineages: []}}, journal: {canonicalRows: f.canonicalRows}}};
			let oldPreimageParses = 0;
			const known = (raw: Uint8Array) => rows.some(row => Buffer.compare(Buffer.from(raw), Buffer.from(row.exactCanonicalPreimageBytes)) === 0);
			const material = execute<(input: unknown) => any>(`${declaration("creatorOrdinaryClosedJournalApplicationRowForSizing")}\n` +
				`${declaration("creatorOrdinaryApplicationResourceMaterialForSizing")}\ncreatorOrdinaryApplicationResourceMaterialForSizing;`, {
					verifiedCreatorSnapshotCatalog: () => catalog, creatorOrdinaryIssuanceApplicationSources: () => [],
					proofMaterialOwners: new WeakMap([[frame.accounting, {captureKnownProtectedMaterial: () => rows.flatMap(row =>
						[row.exactCanonicalPreimageBytes.slice(), row.detachedSignature.slice()])}]]),
					record: (raw: Uint8Array) => {if (known(raw)) oldPreimageParses++; const value = canonicalCreatorDataRecord(raw);
						if (!value) throw Error("invalid canonical record"); return value;},
					decodeCanonical: (raw: Uint8Array) => {if (known(raw)) oldPreimageParses++; return decodeCanonical(raw);},
					closedRetirementHex: (value: string) => Uint8Array.from(Buffer.from(value, "hex")),
					closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
				});
			const result = material(input), operations = rows.map(row => row.vertexData.operation);
			expect(result.material.currentOperations).toEqual([]);
			expect(result.material.protectedOperations).toEqual(operations);
			expect(result.material.recoveryOperations).toEqual(operations);
			expect(oldPreimageParses).toBe(0);
			// This is the unchanged complete-material codec boundary used by both
			// resource consumers. Mutating that callback input cannot change source DATA.
			const callback = decodeCanonical(encodeCanonical(result)) as typeof result;
			callback.material.protectedOperations[0].action = "caller-mutated";
			expect(material(input)).toEqual(result); expect(rows[0]!.vertexData.operation).toEqual(operations[0]);
			const local = rows[0]!;
			issued.push({objectId: local.scope.objectId, author: local.author, authorSequence: local.authorSequence,
				digest: Uint8Array.from(Buffer.from(local.vertexDigest, "hex")), canonicalPreimageBytes: local.exactCanonicalPreimageBytes.slice(),
				signature: local.detachedSignature.slice()});
			expect(material(input)).toBeDefined();
			(issued[0]!.signature as Uint8Array)[0]! ^= 1; expect(material(input)).toBeUndefined();
			issued.splice(0); source.applicationJournalRows = [...rows, rows[0]!]; expect(material(input)).toBeUndefined();
			source.applicationJournalRows = rows;
			editRow(f, 0, row => {row[sql ? "local_author_sequence" : "localAuthorSequence"] = 999;});
			expect(material(input)).toBeUndefined(); // Changed native bytes cannot select a pruned witness.
		}
	});
	it("withholds all application row capture until final currency succeeds and preserves joined revocation or capture failures", async () => {
		for (const revoke of [false, true]) {
			const f = await membershipFixture(); let checks = 0, captures = 0, released = false;
			let entered!: () => void, proceed!: () => void;
			const reached = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {proceed = resolve;});
			const read = {release: async () => {released = true;}};
			const action = () => runPrefix(f, async () => {if (++checks === 2) {entered(); await gate; if (revoke) throw Error("source-revoked");}},
				verifyReceivedVertex, openCreatorCloseMembership, () => {captures++;});
			const pending = execute<Promise<Prefix | undefined>>(`${declaration("joinedClosedRetirementRead")}\njoinedClosedRetirementRead(read, action);`, {read, action});
			const observed = pending.then(value => ({ok: true, value}), error => ({ok: false, error}));
			await reached; expect(captures).toBe(0); expect(released).toBe(false); proceed();
			const outcome = await observed; expect(outcome.ok).toBe(!revoke); expect(captures).toBe(revoke ? 0 : 1); expect(released).toBe(true);
		}
		const f = await membershipFixture(), failure = new Error("same-book capture quota failure");
		await expect(runPrefix(f, async () => undefined, verifyReceivedVertex, openCreatorCloseMembership, () => {throw failure;})).rejects.toBe(failure);
	});
	it("never delivers application row data for missing, corrupt, foreign-context or duplicate membership coverage", async () => {
		const changes: Array<(f: MembershipFixture) => void> = [
			f => {f.canonicalRows.pop();},
			f => {const header = decodeCanonical(f.canonicalRows[0]!) as unknown[]; const row = header[2] as Record<string, unknown>;
				const membership = decodeCanonical(row.closedMembershipBytes as Uint8Array) as Record<string, unknown>;
				membership.localVertexWitnesses = []; row.closedMembershipBytes = encodeCanonical(membership); f.canonicalRows[0] = encodeCanonical(header);},
			f => editRow(f, 1, row => {(row.detachedSignature as Uint8Array)[0]! ^= 1;}),
			f => editRow(f, 1, row => {row.vertexDigest = "ff".repeat(32);}),
			f => editRow(f, 1, row => {const preimage = decodeCanonical(row.exactCanonicalPreimageBytes as Uint8Array) as Record<string, unknown>;
				preimage.dependencies = ["ff".repeat(32)]; row.exactCanonicalPreimageBytes = encodeCanonical(preimage);}),
			f => editRow(f, 1, row => {const preimage = decodeCanonical(row.exactCanonicalPreimageBytes as Uint8Array) as Record<string, unknown>;
				preimage.epoch = 9; row.exactCanonicalPreimageBytes = encodeCanonical(preimage);}),
			f => editRow(f, 1, row => {delete row.exactCanonicalPreimageBytes;}),
			f => editRow(f, 2, row => {row.localAuthorSequence = 7;}),
			f => {f.authorities[0]!.closedAclDigest = "ff".repeat(32);},
			f => {f.authorities.push({...f.authorities[0]!, suiteId: "foreign-suite"});},
		];
		for (const change of changes) {
			const f = await membershipFixture(); change(f); let captures = 0;
			try {expect(await runPrefix(f, async () => undefined, verifyReceivedVertex, openCreatorCloseMembership, () => {captures++;})).toBeUndefined();}
			catch (error) {expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("chain-invalid");}
			expect(captures).toBe(0);
		}
		let captures = 0;
		await expect(runPrefix(await membershipFixture(8, false, true), async () => undefined, verifyReceivedVertex, openCreatorCloseMembership, () => {captures++;})).rejects.toThrow("chain-invalid");
		expect(captures).toBe(0);
	});
	describe("source-owned multi-scope membership collection", () => {
		it("shares the close verifier with retirement classification without reusing native currency", async () => {
			const f = await membershipFixture(4), expected = await runPrefix(f, async () => {});
			const image = { canonicalRows: f.canonicalRows, image: {rowCount: 4, imageDigest: "native-image"} };
			let verified = 0, resolved = 0, reads = 0, checks = 0, fallback = 0;
			let stale = false;
			const input = {
				objectId: f.scope.objectId, image, physical: image, summary: {cuts: []}, floor: {pending: null},
				censusBytes: encodeCanonical({currentJournal: {scope: {...f.scope, epoch: 8, anchorDigest: "current"}},
					nativeIssuance: {rows: {issued: [], outbox: []}}, rows: []}),
				sourceTrust: undefined, unclassifiedReplay: false, protectedRoleScopes: [], authenticatedScopes: [f.scope],
				journalMembershipAuthorities: f.authorities,
				verifyVertex: (value: Parameters<typeof verifyReceivedVertex>[0]) => {
					verified++;
					return verifyReceivedVertex({...value, resolveAuthorPublicKey: author => {
						resolved++; return value.resolveAuthorPublicKey(author);
					}});
				},
				accounting: {charge: () => true}, check: async () => {checks++;},
				journal: {readRetirementImage: async () => {
					reads++; return {ok: true, value: stale ? {...image, changed: true} : image};
				}},
			};
			const run = () => execute<Promise<{collectiblePrefixes: Prefix[]}>>(`${[
				"closedNativeJournalScopes", "closedJournalProtectedReplayScopes", "closedJournalMembershipPrefix", "prepareClosedJournalMembershipPrefix",
				"prepareClosedJournalDetails", "classifyClosedJournalDetails"].map(declaration).join("\n")} classifyClosedJournalDetails(input);`, {
				input, record: decodeCanonical, closedRetirementBytes: encodeCanonical,
				closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
				closedJournalNativeObservationEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
				openCreatorCloseMembership, openCanonicalLatchedAclSnapshot, authorizeLatchedEnvelopeAuthor, registry, journalRetirementFrameDigest,
				verifyReceivedVertex: (value: Parameters<typeof verifyReceivedVertex>[0]) => {fallback++; return verifyReceivedVertex(value);},
				closedRetirementHex: (value: string) => Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16)),
				bindMethod: (owner: Record<string, (...args: unknown[]) => unknown>, name: string) => owner[name]!.bind(owner),
				requireLaw: (ok: boolean, reason: string) => {if (!ok) throw Error(reason);},
			});
			expect((await run()).collectiblePrefixes).toEqual([expected]);
			expect({verified, resolved, reads, checks, fallback}).toEqual({verified: 4, resolved: 4, reads: 1, checks: 5, fallback: 0});
			stale = true; await expect(run()).rejects.toThrow("floor-stale");
			expect(reads).toBe(2);
			stale = false; editRow(f, 1, row => {(row.detachedSignature as Uint8Array)[0]! ^= 1;});
			await expect(run()).rejects.toThrow("chain-invalid");
		});
		// Exact private production read-owner statements, genuine signed vertex,
		// membership/Merkle and ACL fixtures. Native stores/floors are controlled
		// seams here; the genuine-native healthy scenario remains indispensable.
		function owner(fixtures: MembershipFixture[], hooks: {
			open?: typeof openCreatorCloseMembership;
			verify?: typeof verifyReceivedVertex;
			onCurrent?: (count: number) => void | Promise<void>;
			onImage?: () => void | Promise<void>;
		} = {}) {
			const resolver = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "resolveCreatorForwardPromotionSource");
			const variables = (name: string): string => {
				const found: ts.VariableDeclaration[] = [];
				const visit = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node); ts.forEachChild(node, visit); };
				visit(resolver); if (found.length !== 1) throw Error(`PRIVATE_SOURCE_VARIABLE:${name}:${found.length}`);
				return `const ${found[0]!.getText(parsed)};`;
			};
			const properties = (name: string): string => {
				const found: ts.PropertyAssignment[] = [];
				const visit = (node: ts.Node): void => {
					if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === name && ts.isObjectLiteralExpression(node.parent) &&
						node.parent.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(parsed) === "readClosedJournalMembershipPrefixes")) found.push(node);
					ts.forEachChild(node, visit);
				};
				visit(resolver); if (found.length !== 1) throw Error(`PRIVATE_SOURCE_PROPERTY:${name}:${found.length}`);
				return found[0]!.initializer.getText(parsed);
			};
			const image = { canonicalRows: fixtures.flatMap(f => f.canonicalRows.map(bytes => bytes.slice())) };
			const counts = { current: 0, snapshots: 0, floors: 0, images: 0, census: 0, signing: 0, signatures: 0, releases: 0, anchors: 0 };
			const floor = { stable: { epoch: 8, anchor: "current" }, pending: null };
			const state = { actualImage: image, actualFloor: floor, current: true, anchor: true };
			const code = `
				${declaration("closedNativeJournalScopes")}
				${declaration("closedJournalMembershipPrefix")}
				${declaration("prepareClosedJournalMembershipPrefix")}
				${declaration("collectSourceOwnedClosedJournalMembershipPrefixes")}
				${declaration("joinSourceReleases")}
				let aliasRevoked = false, aliasRelease, nominationSource, nominationTask;
				const reader = {release: async () => {counts.releases++;}}, capability = {};
				const captured = {journal: image}, hold = {release: async () => {}};
				const originalFrame = {alive:true, maintenanceCapture:captured, headerHold:hold,
					pending:new Set(), accounting:{}, requirements:new Set(),
					closeDependencies:{checkWhile:async (read, signing) => {
						counts.census++; counts.signing++;
						await read(); counts.census++; counts.signing++;
					}, release:async()=>{}}};
				const sourceFrame = originalFrame, lifetime = {released:false, classifiedReleasing:false}, pendingChecks = new Set();
				const frames = new WeakMap([[reader, originalFrame]]), journalHeaderHolds = new WeakMap([[hold, {}]]);
				const observations = new WeakMap([[capability, {}]]), ledgers = new WeakMap(), requirements = new WeakMap();
				const held = [{check:async()=>{counts.snapshots++;}, release:async()=>{}}], installedProofs=[];
				const certificateProofs = [{journalMembershipAuthorities:authorities, check:async()=>{}, release:async()=>{}}];
				const originalAnchor = Uint8Array.of(1,2,3), dependency = {};
				const facts = {dependencies:[dependency]}, dependencies = new WeakMap();
				const input = {objectId:fixtures[0].scope.objectId, pinnedGenesisAnchorDigest:"genesis",
					liveJournalStore:{readRetirementImage:async()=>{counts.images++; await hooks.onImage?.(); return {ok:true,value:state.actualImage};}},
					floorRead:async()=>{counts.floors++;return {ok:true,state:state.actualFloor};}};
				dependencies.set(dependency,{source:input.liveJournalStore,scope:fixtures[0].scope,actualByteLength:3,exactCanonicalAnchorPreimageBytes:originalAnchor});
				const forward={wholeCensus:true,wholeFloor:floor,currentTrust:floor.stable,
					checkCurrent:async()=>{counts.current++;await hooks.onCurrent?.(counts.current);return {ok:state.current};}};
				${["releaseOriginal", "throughCurrentSource", "withSourceRead", "checkSnapshots", "withCloseDependencies", "checkCurrentSource", "checkRecoverySourceCurrent"].map(variables).join("\n")}
				const read = ${properties("readClosedJournalMembershipPrefixes")};
				const release = ${properties("release")};
				const fullCurrent = ${properties("checkCurrent")};
				({read,release,current:checkRecoverySourceCurrent,fullCurrent,counts,state,pendingChecks,frame:originalFrame,
					nominate:()=>{nominationSource={};}, startNomination:()=>{nominationTask=Promise.resolve();},
					removeCapture:()=>{originalFrame.maintenanceCapture=undefined;}, revokeHeader:()=>{sourceFrame.headerConsumersRevoked=true;},
					staleAnchor:()=>{state.anchor=false;}});`;
			return execute<{
				read(): Promise<Prefix[] | undefined>; release(): Promise<void>; current(): Promise<void>; fullCurrent(): Promise<void>;
				counts: typeof counts; state: typeof state;
				pendingChecks: Set<Promise<void>>; frame: {alive:boolean}; nominate():void; startNomination():void;
				removeCapture():void; revokeHeader():void; staleAnchor():void;
			}>(code, { fixtures, image, counts, floor, state, hooks, authorities: fixtures.flatMap(f => f.authorities),
				// This owner model controls genuine target custody as a premise;
				// its check/release moved behind private native lifetime selectors.
				checkHeldTarget: (target: {check(): Promise<void>}) => target.check(),
				releaseHeldTarget: (target: {release(): Promise<void>}) => target.release(),
				record: decodeCanonical, openCreatorCloseMembership: hooks.open ?? openCreatorCloseMembership,
				openCanonicalLatchedAclSnapshot, authorizeLatchedEnvelopeAuthor, registry, journalRetirementFrameDigest,
				verifyReceivedVertex: (input: Parameters<typeof verifyReceivedVertex>[0]) => {counts.signatures++; return verifyReceivedVertex(input);},
				resolveCreatorSnapshotRecoveryCloseHold: () => hooks.verify === undefined ? undefined : {verifyVertex: hooks.verify},
				closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
				closedRetirementHex: (value: string) => Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16)),
				captureCreatorRoomHeadState: (value: unknown) => value,
				sameCreatorRoomHead: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
				readHeldSourcePreimage: async (_input: unknown, request: {scope:MembershipFixture["scope"]}) => {
					counts.anchors++;return {ok:true,kind:"present",scope:request.scope,exactCanonicalAnchorPreimageBytes:Uint8Array.of(1,2,state.anchor ? 3 : 4)};
				}, checkAbort:()=>{},
				Refusal: class extends Error {constructor(reason: string) {super(reason);}}, failure: (kind: string) => kind,
				requireLaw: (ok: boolean, reason = "chain-invalid") => {if (!ok) throw Error(reason);},
			});
		}
		async function four() { return Promise.all([4,5,6,7].map((epoch,index) => membershipFixture(4,index % 2 === 1,false,epoch))); }
		it("separates original recovery-source currency from the public complete close-census boundary", async () => {
			const actual=owner(await four());
			await actual.current();
			expect(actual.counts).toEqual({current:1,snapshots:1,floors:1,images:0,census:0,signing:0,signatures:0,releases:0,anchors:1});
			// Sharing one fully authenticated source must not suppress the original
			// public full-close brackets. No completed point serves the second call.
			await actual.fullCurrent();
			expect(actual.counts).toEqual({current:2,snapshots:2,floors:2,images:0,census:2,signing:2,signatures:0,releases:0,anchors:2});
			await actual.release(); await expect(actual.current()).rejects.toThrow("snapshot-unavailable");
		});
		it("does not turn a successful source-only check into reusable native or floor authority", async () => {
			for(const changed of ["head","floor","anchor"]) {
				const actual=owner(await four()); await actual.current();
				if(changed==="head")actual.state.current=false;
				if(changed==="floor")actual.state.actualFloor={...actual.state.actualFloor,pending:"changed" as never};
				if(changed==="anchor")actual.staleAnchor();
				await expect(actual.current()).rejects.toThrow(changed==="head"?"ahe-rejected":changed==="floor"?"floor-stale":"anchor-unavailable");
				expect(actual.counts.snapshots).toBe(2); expect(actual.counts.anchors).toBe(2); expect(actual.counts.census).toBe(0);
				await actual.release();
			}
		});
		it("joins an admitted source-only read and revokes new checks and successful delivery immediately", async () => {
			let entered!:()=>void,resume!:()=>void;
			const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
			const actual=owner(await four(),{onCurrent:async()=>{entered();await gate;}});
			const pending=actual.current(),observed=pending.catch(error=>error); await waiting;
			expect(actual.pendingChecks.size).toBe(1); const releasing=actual.release();
			await expect(actual.current()).rejects.toThrow("snapshot-unavailable"); expect(actual.counts.releases).toBe(0);
			resume(); expect(await observed).toBeInstanceOf(Error); await releasing;
			expect(actual.pendingChecks.size).toBe(0); expect(actual.counts.releases).toBe(1);
			const revoked=owner(await four(),{onCurrent:()=>{revoked.revokeHeader();}});
			await expect(revoked.current()).rejects.toThrow("snapshot-unavailable"); await revoked.release();
		});
		it("passes the original close lifetime verifier through collection while retaining every fresh ACL and source check", async () => {
			const fixtures = await four(), expected = await Promise.all(fixtures.map(f => runPrefix(f, async () => {})));
			let verified = 0, resolved = 0;
			const actual = owner(fixtures, {verify: input => {
				verified++;
				return verifyReceivedVertex({...input, resolveAuthorPublicKey: author => {
					resolved++; return input.resolveAuthorPublicKey(author);
				}});
			}});
			expect(await actual.read()).toEqual(expected);
			expect(verified).toBe(16); expect(resolved).toBeGreaterThanOrEqual(16);
			expect(actual.counts).toEqual({current:2,snapshots:2,floors:2,images:1,census:2,signing:2,signatures:0,releases:0,anchors:2});
			// The original verifier's refusal cannot be turned into cached membership.
			await expect(owner(fixtures, {verify: () => ({accepted: false, reason: "signature"} as ReturnType<typeof verifyReceivedVertex>)}).read())
				.rejects.toThrow("chain-invalid");
		});
		it("collects four genuine prefixes in one source turn with two complete fresh checks and unchanged charges", async () => {
			const fixtures = await four(), expected = await Promise.all(fixtures.map(f => runPrefix(f,async()=>{})));
			const actual = owner(fixtures); expect(await actual.read()).toEqual(expected);
			expect(actual.counts).toEqual({current:2,snapshots:2,floors:2,images:1,census:2,signing:2,signatures:16,releases:0,anchors:2});
			const oldBook=createCreatorClosedRollbackProofAccounting([]),newBook=createCreatorClosedRollbackProofAccounting([]);
			for (const book of [oldBook,newBook]) { for (const f of fixtures) for (const bytes of f.canonicalRows) expect(book.charge(bytes)).toBe(true); }
			for (const [book,prefixes] of [[oldBook,expected],[newBook,await actual.read()]] as const) {
				for (const prefix of prefixes!) expect(book.charge(encodeCanonical(prefix))).toBe(true);
				for (const unknown of [17,17]) expect(book.chargeUnknownEncodedLength(unknown)).toBe(true);
			}
			expect(newBook.chargedBytes).toBe(oldBook.chargedBytes);
		});
		it("revokes new admissions immediately and joins asynchronous membership acquisition before physical release", async () => {
			let opened!:()=>void, resume!:()=>void; const started=new Promise<void>(resolve=>{opened=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
			const actual=owner(await four(),{open:async input=>{opened();await gate;return openCreatorCloseMembership(input);}});
			const pending=actual.read(); const observed=pending.catch(error=>error); await started;
			expect(actual.pendingChecks.size).toBe(1); const releasing=actual.release();
			await expect(actual.read()).rejects.toThrow("snapshot-unavailable"); expect(actual.counts.releases).toBe(0);
			resume(); expect(await observed).toBeInstanceOf(Error); await releasing;
			expect(actual.counts.releases).toBe(1); expect(actual.pendingChecks.size).toBe(0); expect(actual.frame.alive).toBe(false);
		});
		it("refuses stale floors, source anchors, journal images and reentrant source revocation before delivery", async () => {
			for (const when of [1,2]) {
				const actual=owner(await four(),{onCurrent:count=>{if(count===when) actual.state.actualFloor={...actual.state.actualFloor,pending:"changed" as never};}});
				await expect(actual.read()).rejects.toThrow("floor-stale");
			}
			const anchor=owner(await four());anchor.staleAnchor(); await expect(anchor.read()).rejects.toThrow("anchor-unavailable");
			const changed=owner(await four(),{onImage:()=>{changed.state.actualImage={canonicalRows:[]};}}); await expect(changed.read()).rejects.toThrow("floor-stale");
			const revoked=owner(await four(),{onCurrent:count=>{if(count===2)revoked.revokeHeader();}}); await expect(revoked.read()).rejects.toThrow("snapshot-unavailable");
			const refused=owner(await four());refused.state.current=false; await expect(refused.read()).rejects.toThrow("ahe-rejected");
		});
		it("retains original signature, context, duplicate, order and authority refusals and missing-detail behavior", async () => {
			const changes: Array<(f:MembershipFixture)=>void>=[
				f=>editRow(f,1,row=>{(row.detachedSignature as Uint8Array)[0]!^=1;}),
				f=>editRow(f,1,row=>{delete row.exactCanonicalPreimageBytes;}),
				f=>editRow(f,1,row=>{const vertex=decodeCanonical(row.exactCanonicalPreimageBytes as Uint8Array) as Record<string,unknown>;vertex.epoch=9;row.exactCanonicalPreimageBytes=encodeCanonical(vertex);}),
				f=>{[f.canonicalRows[1],f.canonicalRows[2]]=[f.canonicalRows[2]!,f.canonicalRows[1]!];},
				f=>{f.authorities.push({...f.authorities[0]!,suiteId:"foreign-suite"});},
				f=>{f.authorities[0]!.closedAclDigest="ff".repeat(32);},
				f=>{const header=decodeCanonical(f.canonicalRows[0]!) as unknown[];(header[2] as Record<string,unknown>).closedMembershipBytes=Uint8Array.of(0x05,2,0xc0,0x80);f.canonicalRows[0]=encodeCanonical(header);},
			];
			for(const change of changes){const fixtures=await four();change(fixtures[0]!);await expect(owner(fixtures).read()).rejects.toThrow("chain-invalid");}
			await expect(owner([await membershipFixture(4,false,true)]).read()).rejects.toThrow("chain-invalid");
			const incomplete=await four();incomplete[0]!.canonicalRows.pop();expect((await owner(incomplete).read())!.length).toBe(3);
			const noAuthority=await four();noAuthority[0]!.authorities=[];expect((await owner(noAuthority).read())!.length).toBe(3);
		});
		it("owns captured input and detached output through the final awaited source check", async () => {
			const fixtures=await four(),expected=await Promise.all(fixtures.map(f=>runPrefix(f,async()=>{})));
			const actual=owner(fixtures,{onCurrent:count=>{if(count===2)fixtures[0]!.canonicalRows[2]!.fill(0);}});
			const result=await actual.read();expect(result).toEqual(expected);expect(Object.isFrozen(result)).toBe(true);
			for(const prefix of result!){expect(Object.isFrozen(prefix)).toBe(true);expect(Object.isFrozen(prefix.rows)).toBe(true);}
			const encoded=encodeCanonical(actual.state.actualImage); (result![0]!.rows[1]!.exactCanonicalNativeFrameBytes as Uint8Array).fill(0);
			expect(encodeCanonical(actual.state.actualImage)).toEqual(encoded);
		});
		it("treats unsupported/rebound collection as fallback, never fabricated empty authority", async () => {
			for(const condition of ["missing","rebound"]){const actual=owner(await four());if(condition==="missing")actual.removeCapture();else actual.nominate();
				expect(await actual.read()).toBeUndefined();expect(actual.counts.current).toBe(0);}
			const pending=owner(await four());pending.startNomination();await expect(pending.read()).rejects.toThrow("snapshot-unavailable");
			const fixtures=await four(),image={canonicalRows:fixtures.flatMap(f=>f.canonicalRows)},reader={},observation={},accounting={},postAdoptionCensusSizing={};
			let checks=0,images=0,collections=0;
			const frame={alive:true,accounting,maintenanceCapture:{journal:image,closeHold:{}},input:{objectId:fixtures[0]!.scope.objectId,store:{},snapshotStore:{},
				liveJournalStore:{readRetirementImage:async()=>{images++;return {ok:true,value:image};}}}};
			const facts={forward:{reader,installed:[],certificates:[{journalMembershipAuthorities:fixtures.flatMap(f=>f.authorities),roles:{operationalSources:[]}}]}};
			const result=await execute<Promise<Prefix[]>>(`${declaration("closedNativeJournalScopes")}\n${declaration("closedJournalMembershipPrefix")}\n${declaration("prepareClosedJournalMembershipPrefix")}\n${declaration("readProspectiveCreatorMaintenancePrefixesForSizing").replace(/^export /, "")}\nreadProspectiveCreatorMaintenancePrefixesForSizing(input);`,{
				input:{proof:{observation,accounting},postAdoptionCensusSizing},observations:new WeakMap([[observation,facts]]),frames:new WeakMap([[reader,frame]]),ledgers:new WeakMap([[accounting,frame]]),
				resolveCreatorPostAdoptionCensusSizing:()=>postAdoptionCensusSizing,readProspectiveCreatorSnapshotTurnoverForSizing:()=>({ok:true,required:false}),
				resolveCreatorForwardPromotionSource:()=>({readClosedJournalMembershipPrefixes:async()=>{collections++;return undefined;},checkCurrent:async()=>{checks++;}}),
				isAuthenticatedInitialAdoptionDrain:()=>false,composeProspectiveCreatorMaintenancePrefixesForSizing:(...args:unknown[])=>args[6],
				createCreatorMaintenanceSizingSyntax:()=>createCreatorCanonicalSyntaxReader(),
				record:decodeCanonical,openCreatorCloseMembership,openCanonicalLatchedAclSnapshot,authorizeLatchedEnvelopeAuthor,verifyReceivedVertex,registry,journalRetirementFrameDigest,
				closedRetirementHex:(value:string)=>Uint8Array.from(value.match(/../gu)!,pair=>Number.parseInt(pair,16)),
				closedRetirementEqual:(a:unknown,b:unknown)=>Buffer.compare(Buffer.from(encodeCanonical(a)),Buffer.from(encodeCanonical(b)))===0,
				closedJournalNativeObservationEqual:(a:unknown,b:unknown)=>Buffer.compare(Buffer.from(encodeCanonical(a)),Buffer.from(encodeCanonical(b)))===0,
				requireLaw:(ok:boolean,reason="chain-invalid")=>{if(!ok)throw Error(reason);},
			});
			expect(result).toEqual(await Promise.all(fixtures.map(f=>runPrefix(f,async()=>{}))));
			expect(collections).toBe(1);expect(checks).toBe(8);expect(images).toBe(1);
		});
	});
	it("authenticates complete mixed prefixes with two fresh checks and unchanged bytes and proof charges", async () => {
		for (const sql of [false, true]) for (const count of [1, 8, 16]) {
			const f = await membershipFixture(count, sql), before = f.canonicalRows.map(bytes => bytes.slice());
			let checks = 0, signatures = 0;
			const result = await runPrefix(f, async () => { checks++; }, input => { signatures++; return verifyReceivedVertex(input); });
			expect(result).toEqual({ scope: f.scope, snapshot: null, highWatermark: count, rows: f.expected });
			expect(checks).toBe(2); expect(signatures).toBe(count); expect(f.canonicalRows).toEqual(before);
			const oldBook = createCreatorClosedRollbackProofAccounting([]), newBook = createCreatorClosedRollbackProofAccounting([]);
			for (const bytes of before) { expect(oldBook.charge(bytes)).toBe(true); expect(newBook.charge(bytes)).toBe(true); }
			expect(oldBook.charge(encodeCanonical({ scope: f.scope, snapshot: null, highWatermark: count, rows: f.expected }))).toBe(true);
			expect(newBook.charge(encodeCanonical(result))).toBe(true);
			const knownCharge = newBook.chargedBytes;
			for (const book of [oldBook, newBook]) for (const unknown of [17, 17])
				expect(book.chargeUnknownEncodedLength(unknown)).toBe(true);
			expect(newBook.chargedBytes).toBe(oldBook.chargedBytes);
			expect(newBook.chargedBytes).toBe(knownCharge + 34);
			const received = result!.rows.find(row => row.exactCanonicalNativeFrameBytes instanceof Uint8Array);
			(received?.exactCanonicalNativeFrameBytes as Uint8Array | undefined)?.fill(0);
			expect(f.canonicalRows).toEqual(before);
		}
	});
	it("does not yield between signed rows, but freshly refuses revocation before successful delivery", async () => {
		const f = await membershipFixture(); let checks = 0, signatures = 0, revoked = false;
		const pending = runPrefix(f, async () => { checks++; if (revoked) throw new Error("source-revoked"); }, input => {
			signatures++; if (signatures === 1) queueMicrotask(() => { revoked = true; }); return verifyReceivedVertex(input);
		});
		await expect(pending).rejects.toThrow("source-revoked");
		expect(signatures).toBe(f.expected.length); expect(checks).toBe(2);
	});
	it("detaches delivered native frames before the final asynchronous currency check", async () => {
		const f = await membershipFixture(); let checks = 0;
		const expected = encodeCanonical({ scope: f.scope, snapshot: null, highWatermark: f.expected.length, rows: f.expected });
		const result = await runPrefix(f, async () => {
			if (++checks === 2) {
				// Simulate mutation of a caller-visible carrier while final currency
				// awaits. Real native mutation separately refuses in the next case.
				f.canonicalRows[2]!.fill(0);
				await Promise.resolve();
			}
		});
		expect(encodeCanonical(result)).toEqual(expected);
		expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result!.rows)).toBe(true);
		for (const row of result!.rows) expect(Object.isFrozen(row)).toBe(true);
		expect(checks).toBe(2);
	});
	it("refuses stale floors or missing native bytes at the final delivery boundary without returning a prefix", async () => {
		for (const reason of ["floor-stale", "anchor-unavailable", "snapshot-unavailable"]) {
			const f = await membershipFixture(); let checks = 0, signatures = 0;
			await expect(runPrefix(f, async () => { if (++checks === 2) throw new Error(reason); },
				input => { signatures++; return verifyReceivedVertex(input); })).rejects.toThrow(reason);
			expect(signatures).toBe(f.expected.length); expect(checks).toBe(2);
		}
	});
	it("refuses altered signatures, identities, target context, row order and missing received bytes", async () => {
		const changes: Array<(f: MembershipFixture) => void> = [
			f => editRow(f, 1, row => { (row.detachedSignature as Uint8Array)[0]! ^= 1; }),
			f => editRow(f, 1, row => {
				const vertex = decodeCanonical(row.exactCanonicalPreimageBytes as Uint8Array) as Record<string, unknown>;
				vertex.epoch = 9; row.exactCanonicalPreimageBytes = encodeCanonical(vertex);
			}),
			f => editRow(f, 1, row => { delete row.exactCanonicalPreimageBytes; }),
			f => editRow(f, 2, row => { row.localAuthorSequence = 7; }),
			f => { [f.canonicalRows[1], f.canonicalRows[2]] = [f.canonicalRows[2]!, f.canonicalRows[1]!]; },
			f => { f.authorities[0]!.closedAclDigest = "ff".repeat(32); },
			f => { f.authorities.push({ ...f.authorities[0]!, suiteId: "foreign-suite" }); },
		];
		for (const change of changes) {
			const f = await membershipFixture(); change(f);
			await expect(runPrefix(f, async () => undefined)).rejects.toThrow("chain-invalid");
		}
		const changedDigest = await membershipFixture();
		editRow(changedDigest, 1, row => { row.vertexDigest = "ff".repeat(32); });
		// An apparent subset is retained before successor installation. Once
		// collection is eligible, full row authentication still rejects the forgery.
		expect(await runPrefix(changedDigest, async () => {})).toBeUndefined();
		await expect(runPrefix(changedDigest, async () => {}, verifyReceivedVertex, openCreatorCloseMembership,
			undefined, decodeCanonical, () => changedDigest.scope.epoch + 1)).rejects.toThrow("chain-invalid");
		await expect(runPrefix(await membershipFixture(8, false, true), async () => undefined)).rejects.toThrow("chain-invalid");
	});
	it.each([false, true])("collects a complete native subset only after successor installation, never for replay (%s)", async sql => {
		const f = await membershipFixture(8, sql);
		f.canonicalRows.pop(); // Last member was never received; all native rows remain present.
		const header = decodeCanonical(f.canonicalRows[0]!) as unknown[];
		(header[2] as Record<string, unknown>)[sql ? "next_journal_sequence" : "nextJournalSequence"] = 7;
		f.canonicalRows[0] = encodeCanonical(header);
		const run = (installed?: number, capture?: (rows: readonly ApplicationRow[]) => void) =>
			runPrefix(f, async () => {}, verifyReceivedVertex, openCreatorCloseMembership, capture, decodeCanonical,
				installed === undefined ? undefined : () => installed);
		expect(await run()).toBeUndefined();
		expect(await run(f.scope.epoch)).toBeUndefined();
		expect(await run(f.scope.epoch + 1)).toEqual({scope: f.scope, snapshot: null, highWatermark: 7, rows: f.expected.slice(0, 7)});
		let replayed = false;
		expect(await run(f.scope.epoch + 1, () => {replayed = true;})).toBeUndefined();
		expect(replayed).toBe(false);
		f.canonicalRows.pop(); // Now the native watermark promises a row absent from the image.
		expect(await run(f.scope.epoch + 1)).toBeUndefined();
	});
	it("retains refusal for missing detail and local witnesses rather than inventing membership authority", async () => {
		const missingDetail = await membershipFixture(); missingDetail.canonicalRows.pop();
		expect(await runPrefix(missingDetail, async () => undefined)).toBeUndefined();
		const missingWitness = await membershipFixture();
		const header = decodeCanonical(missingWitness.canonicalRows[0]!) as unknown[];
		const row = header[2] as Record<string, unknown>, member = decodeCanonical(row.closedMembershipBytes as Uint8Array) as Record<string, unknown>;
		member.localVertexWitnesses = []; row.closedMembershipBytes = encodeCanonical(member);
		missingWitness.canonicalRows[0] = encodeCanonical(header);
		expect(await runPrefix(missingWitness, async () => undefined)).toBeUndefined();
	});
	it("retains canonical malformed membership and missing native scope refusals", async () => {
		const corrupt = await membershipFixture(), header = decodeCanonical(corrupt.canonicalRows[0]!) as unknown[];
		(header[2] as Record<string, unknown>).closedMembershipBytes = Uint8Array.of(0x05, 2, 0xc0, 0x80);
		corrupt.canonicalRows[0] = encodeCanonical(header);
		await expect(runPrefix(corrupt, async () => undefined)).rejects.toThrow("chain-invalid");
		const missing = await membershipFixture(); missing.canonicalRows.shift();
		await expect(runPrefix(missing, async () => undefined)).rejects.toThrow("chain-invalid");
	});
	it("checks currency after asynchronous membership acquisition and joins interrupted checks before release", async () => {
		const f = await membershipFixture(); let released = false, checking = false, signatures = 0;
		let started!: () => void, continueCheck!: () => void;
		const checkStarted = new Promise<void>(resolve => { started = resolve; });
		const checkGate = new Promise<void>(resolve => { continueCheck = resolve; });
		const read = { release: async () => { expect(checking).toBe(false); released = true; } };
		const action = () => runPrefix(f, async () => {
			checking = true; started(); await checkGate; checking = false; throw new Error("source-revoked");
		}, input => { signatures++; return verifyReceivedVertex(input); });
		const joined = execute<Promise<Prefix | undefined>>(`${declaration("joinedClosedRetirementRead")}\njoinedClosedRetirementRead(read, action);`, { read, action });
		await checkStarted; expect(released).toBe(false); continueCheck();
		await expect(joined).rejects.toThrow("source-revoked");
		expect(released).toBe(true); expect(signatures).toBe(0);
	});
});

describe("optional native borrowing describes captured replacement custody", () => {
	type Reservation = {check():Promise<void>;release():Promise<void>};
	type Lifetime = {borrowCurrentNativeReservation?: (owner:"ahe"|"journal"|"floor")=>Promise<Reservation|undefined>;
		borrowDependencies():Promise<{dependencyAnchors:unknown[];readExactCanonicalCensus():Uint8Array;checkWhile(read:()=>Promise<void>,signing?:unknown):Promise<void>;release():Promise<void>}>;
		borrowSigningDependencies(trusts:readonly unknown[]):Promise<{readExactCanonicalRows():readonly Uint8Array[];checkWhile(read:()=>Promise<void>):Promise<void>;release():Promise<void>}>;
		acquireNativeIssuanceReservation():Promise<Reservation>;release():Promise<void>};
	function fixture(replacement=false) {
		const path=new URL("../src/v3-live.ts",import.meta.url),text=readFileSync(path,"utf8"),file=ts.createSourceFile(path.pathname,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
		const owner=file.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="resolveRecoveryCloseHold");
		if(owner===undefined)throw Error("RECOVERY_CLOSE_OWNER_MISSING");
		const events:string[]=[],counts={census:0,source:0,borrow:0,native:0,releases:0},hold={},registry=new WeakMap();
		const state={stale:false,floorStale:false,nativeStale:false,sourceStale:false,beforeAcquire:undefined as (()=>void|Promise<void>)|undefined,beforeCheck:undefined as (()=>void|Promise<void>)|undefined};
		const reservation=(name:string):Reservation=>({check:async()=>{counts.native++;events.push("native-check:"+name);if(state.nativeStale)throw Error("native-stale");},release:async()=>{counts.releases++;events.push("release:"+name);}});
		const store={acquireNativeReadReservation:async()=>{events.push("acquire:ahe");await state.beforeAcquire?.();return reservation("ahe");}},
			journal={acquireNativeReadReservation:async()=>{events.push("acquire:journal");return reservation("journal");}},
			floor={acquireNativeReadReservation:async()=>{events.push("acquire:floor");return reservation("floor");}},
			issuance={acquireNativeReadReservation:async()=>{events.push("acquire:issuance");return reservation("issuance");}};
		const trust={objectId:"a1".repeat(32),currentEpoch:4,currentAnchorDigest:"a2".repeat(32)},censusBytes=encodeCanonical({wholeFloor:{epoch:4,pending:null},protected:["current","pending","shared"]});
		const accounting=createCreatorClosedRollbackProofAccounting([]); for(const length of [17,17])expect(accounting.chargeUnknownEncodedLength(length)).toBe(true);
		const facts={kind:"full-census",releasing:false,pending:new Set<Promise<unknown>>(),context:{payload:{input:{store,settlementFloor:floor},trust:{trust}},liveJournalStore:journal,issuanceStore:issuance},
			dependencyAnchors:[],sourceTrust:undefined,exactCanonicalCensusBytes:censusBytes,
			...(replacement?{replacementCustody:{borrow:async(nativeOwner:unknown)=>{counts.borrow++;events.push("borrow");if(facts.releasing)throw Error("replacement-revoked");expect([store,journal,floor]).toContain(nativeOwner);return reservation("borrowed");}}}:{}),
			check:async()=>{counts.census++;events.push("fresh-census");await state.beforeCheck?.();if(state.stale||state.floorStale)throw Error("complete-census-stale");expect(accounting.charge(censusBytes)).toBe(true);},
			borrowSigning:async()=>({dependencyAnchors:[],readExactCanonicalRows:()=>Object.freeze([Uint8Array.of(1,2)]),checkWhile:async(read:()=>Promise<void>)=>{events.push("signing-before");await read();events.push("signing-after");},release:async()=>{events.push("signing-release");}})};
		registry.set(hold,facts);
		const fullFacts=file.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="fullRecoveryCloseHoldFacts");
		if(fullFacts===undefined)throw Error("FULL_RECOVERY_CLOSE_FACTS_MISSING");
		const resolved=execute<{lifetime:Lifetime;resolve(value:unknown,owners:unknown):Lifetime|undefined}>(`${fullFacts.getText(file)}\n${owner.getText(file)}\n({lifetime:resolveRecoveryCloseHold(hold,owners),resolve:resolveRecoveryCloseHold});`,{ObjectFreeze:Object.freeze,recoveryCloseHolds:registry,hold,owners:{store,liveJournalStore:journal,currentTrust:trust}});
		return {lifetime:resolved.lifetime,resolve:resolved.resolve,facts,counts,state,events,store,journal,floor,issuance,trust,hold,accounting,censusBytes};
	}
	async function proof(f:ReturnType<typeof fixture>) {
		const observations=new WeakMap(),frames=new WeakMap(),ledgers=new WeakMap(),requirements=new WeakMap(),observation={},reader={generations:[],blobs:[],release:async()=>{f.events.push("reader-release");}};
		// 4c4f192c: a lifetime without replacement/source custody may detach native
		// preparation, but only for a "ready" snapshot owner. This test owns the
		// independent fallback, so the owner still requires classification (a real
		// production decline). ea4eb158: the qualified inventory must be complete
		// against the native image (scopeCount === scopes.length).
		const snapshot={image:{scopes:[],scopeCount:0},control:null},inventory={scopes:[],owner:{migration:"classification-required"}},head={stable:{objectId:f.trust.objectId,epoch:4,currentAnchorDigest:f.trust.currentAnchorDigest},pending:null};
		const input={objectId:f.trust.objectId,pinnedGenesisAnchorDigest:"genesis",store:Object.assign(f.store,{readRetirementAdmissionImage:async()=>({ok:true,value:{control:null}})}),
			liveJournalStore:Object.assign(f.journal,{readRetirementImage:async()=>({ok:true,value:{exactCanonicalControlCarriers:[],canonicalRows:[],control:null}})}),
			roomHeadAuthority:Object.assign(f.floor,{readRetirementImage:async()=>({state:head})}),
			snapshotStore:{readRetirementAdmissionImage:async()=>snapshot,captureRecoveryRoleInventory:async()=>inventory}};
		// Whole production maintenance consumer. Only native stores, acquisition
		// authentication and owner floor reads are deterministic controlled seams;
		// this does not claim native SQLite/IndexedDB or cryptographic acceptance.
		return execute<Promise<{beginWrite():Promise<void>;release():Promise<void>;accounting:typeof f.accounting}>>(
			`${declaration("joinSourceReleases")}\n${declaration("closedRetirementEqual")}\n${declaration("completeSnapshotRecoveryInventoryIsPresent")}\n${declaration("acquireCreatorIssuanceMaintenanceProof").replace(/^export /,"")}\nacquireCreatorIssuanceMaintenanceProof(value,closeHold,currentTrust);`,{
			value:input,closeHold:f.hold,currentTrust:f.trust,capture:(value:unknown)=>value,
			resolveCreatorSnapshotRecoveryCloseHold:f.resolve,observations,frames,ledgers,requirements,maintenanceTerminalCustody:new WeakMap(),
			bindMethod:(object:Record<string,unknown>,name:string)=>(object[name] as (...args:unknown[])=>unknown).bind(object),ownJournalHeaderHold:(_owner:unknown,reservation:Reservation)=>reservation,
			parseStorageObjectId:(value:string)=>({ok:true,value}),sameCreatorRoomHead:()=>true,
			currentCreatorMaintenanceRequiresSnapshotReceiptCapture:()=>false,
			creatorIssuanceMaintenanceObservationCarriers:()=>[f.censusBytes],chargeProofObservation:(accounting:typeof f.accounting,bytes:Uint8Array)=>accounting.charge(bytes),
			collectClosedJournalHeaderScopes:()=>Object.freeze([]),snapshotCall:(action:()=>Promise<unknown>)=>action(),
			Refusal:class extends Error {constructor(reason:string){super(reason);}},failure:(reason:string)=>reason,
			requireLaw:(ok:boolean,reason="chain-invalid")=>{if(!ok)throw Error(reason);},
			acquireClosedData:async()=>{
				if(f.facts.releasing)throw Error("source-revoked");
				const closeDependencies=await f.lifetime.borrowDependencies(),signingDependencies=await f.lifetime.borrowSigningDependencies([]);
				const frame={alive:true,accounting:f.accounting,reader,pending:new Set(),requirements:new Set(),closeDependencies,signingDependencies};
				const forward={reader,currentTrust:f.trust,wholeFloor:head,held:[],installed:[],certificates:[],
					checkCurrent:async()=>{f.counts.source++;f.events.push("fresh-source");if(f.facts.releasing||f.state.stale||f.state.floorStale||f.state.sourceStale)throw Error("source-or-floor-stale");return {ok:true};}};
				observations.set(observation,{forward,summary:{head, floor:head}});frames.set(reader,frame);ledgers.set(f.accounting,frame);
				return {ok:true,observation};
			},
		});
	}
	it("omits unavailable optional borrowing rather than performing a whole census for three undefined results",async()=>{
		const f=fixture();expect(f.lifetime.borrowCurrentNativeReservation).toBeUndefined();
		for(const role of ["ahe","journal","floor"] as const)expect(await f.lifetime.borrowCurrentNativeReservation?.(role)).toBeUndefined();
		expect(f.counts.census).toBe(0);expect(f.counts.borrow).toBe(0);expect(f.facts.pending.size).toBe(0);await f.lifetime.release();
	});
	it("preserves every original present-custody check, native owner and invalid-role refusal",async()=>{
		const f=fixture(true);expect(typeof f.lifetime.borrowCurrentNativeReservation).toBe("function");
		for(const role of ["ahe","journal","floor"] as const){const borrowed=await f.lifetime.borrowCurrentNativeReservation!(role);await borrowed!.check();await borrowed!.release();}
		expect(f.counts.census).toBe(3);expect(f.counts.borrow).toBe(3);expect(f.counts.native).toBe(3);
		await expect(f.lifetime.borrowCurrentNativeReservation!("foreign" as never)).rejects.toThrow("role is invalid");expect(f.counts.census).toBe(4);expect(f.counts.borrow).toBe(3);
		f.state.stale=true;await expect(f.lifetime.borrowCurrentNativeReservation!("ahe")).rejects.toThrow("complete-census-stale");expect(f.counts.borrow).toBe(3);
		await expect(Reflect.apply(f.lifetime.borrowCurrentNativeReservation!,{},["ahe"])).rejects.toThrow("foreign");await f.lifetime.release();
	});
	it("revokes new present-custody admissions and joins an admitted failed borrow before parent release",async()=>{
		const f=fixture(true);let entered!:()=>void,resume!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
		f.state.beforeCheck=async()=>{entered();await gate;};const action=f.lifetime.borrowCurrentNativeReservation!("ahe"),observed=action.catch(error=>error);
		await enteredPromise;expect(f.facts.pending.size).toBe(1);const releasing=f.lifetime.release();let joined=false;void releasing.then(()=>{joined=true;});
		await expect(f.lifetime.borrowCurrentNativeReservation!("journal")).rejects.toThrow("unavailable");expect(joined).toBe(false);
		resume();expect(await observed).toBeInstanceOf(Error);await releasing;expect(joined).toBe(true);expect(f.facts.pending.size).toBe(0);
	});
	it("uses the actual independent fallback and preserves native/source/floor checks before write effects",async()=>{
		const f=fixture(),p=await proof(f);expect(f.events.filter(event=>event.startsWith("acquire:"))).toEqual(["acquire:ahe","acquire:journal","acquire:issuance","acquire:floor"]);
		expect(f.events.filter(event=>event.startsWith("native-check:"))).toEqual(["native-check:ahe","native-check:journal","native-check:issuance","native-check:floor","native-check:ahe","native-check:journal","native-check:issuance","native-check:floor"]);
		expect(f.counts.census).toBe(4);expect(f.counts.source).toBe(1);const before=f.accounting.chargedBytes;
		await p.beginWrite();f.events.push("write-effect");expect(f.counts.census).toBe(6);expect(f.counts.source).toBe(2);expect(f.accounting.chargedBytes).toBe(before);await p.release();
		for(const reason of ["floor","native","source","release"] as const){const stale=fixture(),pending=await proof(stale);
			if(reason==="floor")stale.state.floorStale=true;else if(reason==="native")stale.state.nativeStale=true;else if(reason==="source")stale.state.sourceStale=true;else await stale.lifetime.release();
			await expect(pending.beginWrite()).rejects.toThrow();expect(stale.events).not.toContain("write-effect");await pending.release();}
		const reentrant=fixture();reentrant.state.beforeAcquire=()=>reentrant.lifetime.release();
		await expect(proof(reentrant)).rejects.toThrow("unavailable");expect(reentrant.events).not.toContain("write-effect");expect(reentrant.counts.source).toBe(0);
	});
});

describe("same-hold joined dependency currency boundaries", () => {
	type SigningRead = { checkWhile(read: () => Promise<void>): Promise<void>; release(): Promise<void> };
	type CloseRead = { readExactCanonicalCensus(): Uint8Array;
		checkWhile(read: () => Promise<void>, signing?: SigningRead): Promise<void>; release(): Promise<void> };
	type Lifetime = { borrowDependencies(): Promise<CloseRead>;
		borrowSigningDependencies(trusts: readonly object[]): Promise<SigningRead>; release(): Promise<void> };
	function fixture() {
		const path = new URL("../src/v3-live.ts", import.meta.url);
		const text = readFileSync(path, "utf8"), file = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "resolveRecoveryCloseHold");
		if (declaration === undefined) throw new Error("RECOVERY_CLOSE_OWNER_MISSING");
		const events: string[] = [], store = {}, journal = {}, hold = {}, registry = new WeakMap();
		const trust = { objectId: "room", currentEpoch: 4, currentAnchorDigest: "anchor" };
		const censusBytes = encodeCanonical({ graphVersion: 7, completeNativeRows: ["protected", "current", "pending"],
			wholeFloor: { epoch: 4, anchor: "anchor", pending: null } });
		const accounting = createCreatorClosedRollbackProofAccounting([]);
		for (const length of [17, 17]) expect(accounting.chargeUnknownEncodedLength(length)).toBe(true);
		const state = { revoked: false, censusChecks: 0, nativeChecks: 0, nativeReleases: 0,
			beforeNative: undefined as (() => void) | undefined, afterNative: undefined as (() => void) | undefined };
		const facts = { kind: "full-census", releasing: false, pending: new Set<Promise<unknown>>(),
			context: { payload: { input: { store }, trust: { trust } }, liveJournalStore: journal },
			dependencyAnchors: [{ epoch: 4, anchorDigest: "anchor" }], sourceTrust: undefined,
			exactCanonicalCensusBytes: censusBytes,
			check: async () => {
				events.push("complete-context"); state.censusChecks++;
				if (state.revoked) throw new Error("complete-census-stale");
				expect(accounting.charge(censusBytes)).toBe(true);
			},
			borrowSigning: async () => ({ dependencyAnchors: [{ epoch: 4, anchorDigest: "anchor" }],
				readExactCanonicalRows: () => Object.freeze([Uint8Array.of(1, 2)]),
				checkWhile: async (read: () => Promise<void>) => {
					events.push("native-before"); state.nativeChecks++; state.beforeNative?.();
					await read();
					events.push("native-after"); state.nativeChecks++; state.afterNative?.();
				},
				release: async () => { events.push("native-release"); state.nativeReleases++; },
			}),
		};
		registry.set(hold, facts);
		const fullFacts = file.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "fullRecoveryCloseHoldFacts");
		if (fullFacts === undefined) throw new Error("FULL_RECOVERY_CLOSE_FACTS_MISSING");
		const lifetime = execute<Lifetime>(`${fullFacts.getText(file)}\n${declaration.getText(file)}\nresolveRecoveryCloseHold(hold, owners);`, {
			ObjectFreeze: Object.freeze, recoveryCloseHolds: registry, hold, owners: { store, liveJournalStore: journal, currentTrust: trust },
		});
		return { lifetime, state, facts, events, accounting, censusBytes,
			reset: () => { state.censusChecks = 0; state.nativeChecks = 0; events.length = 0; } };
	}
	async function children(f: ReturnType<typeof fixture>) {
		const close = await f.lifetime.borrowDependencies(), signing = await f.lifetime.borrowSigningDependencies([]);
		f.reset(); return { close, signing };
	}
	it("removes only duplicate complete-context passes, preserving native check order and exact charges", async () => {
		for (const combined of [false, true]) {
			const f = fixture(), { close, signing } = await children(f);
			const before = close.readExactCanonicalCensus();
			const read = async () => { f.events.push("read"); expect(close.readExactCanonicalCensus()).toEqual(before); };
			if (combined) await close.checkWhile(read, signing);
			else await signing.checkWhile(() => close.checkWhile(read));
			expect(f.state.censusChecks).toBe(combined ? 2 : 4);
			expect(f.state.nativeChecks).toBe(2);
			expect(f.events).toEqual(combined
				? ["native-before", "complete-context", "read", "complete-context", "native-after"]
				: ["native-before", "complete-context", "complete-context", "read", "complete-context", "complete-context", "native-after"]);
			expect(f.accounting.chargedBytes).toBe(f.censusBytes.byteLength + 34);
			await close.release(); await signing.release(); await f.lifetime.release();
			expect(f.state.nativeReleases).toBe(1);
		}
	});
	it("refuses foreign, copied and released signing children without entering a read or native check", async () => {
		const f = fixture(), other = fixture(), a = await children(f), b = await children(other); let reads = 0;
		for (const selected of [b.signing, { ...a.signing }])
			await expect(a.close.checkWhile(async () => { reads++; }, selected)).rejects.toThrow("foreign or unavailable");
		await a.signing.release();
		await expect(a.close.checkWhile(async () => { reads++; }, a.signing)).rejects.toThrow("foreign or unavailable");
		expect(reads).toBe(0); expect(f.state.nativeChecks).toBe(0); expect(f.state.censusChecks).toBe(0);
		await a.close.release(); await b.close.release(); await b.signing.release();
		await f.lifetime.release(); await other.lifetime.release();
	});
	it("freshly refuses changed context before the read and after it, without reusing authorization", async () => {
		for (const when of ["before", "during"] as const) {
			const f = fixture(), { close, signing } = await children(f); let reads = 0;
			if (when === "before") f.state.beforeNative = () => { f.state.revoked = true; };
			await expect(close.checkWhile(async () => { reads++; f.state.revoked = true; }, signing))
				.rejects.toThrow("complete-census-stale");
			expect(reads).toBe(when === "before" ? 0 : 1);
			expect(f.state.censusChecks).toBe(when === "before" ? 1 : 2);
			// The primary refusal has been delivered and its admitted task joined.
			// Release does not retain a new history of already-observed failures.
			await close.release(); await signing.release();
			await f.lifetime.release(); expect(f.state.nativeReleases).toBe(1);
		}
	});
	it("tracks each concurrent admitted read in both children and joins them before releasing native custody", async () => {
		const f = fixture(), { close, signing } = await children(f);
		let enterA!: () => void, enterB!: () => void, finishA!: () => void, finishB!: () => void;
		const enteredA = new Promise<void>(resolve => { enterA = resolve; }), enteredB = new Promise<void>(resolve => { enterB = resolve; });
		const gateA = new Promise<void>(resolve => { finishA = resolve; }), gateB = new Promise<void>(resolve => { finishB = resolve; });
		const a = close.checkWhile(async () => { enterA(); await gateA; }, signing);
		const b = close.checkWhile(async () => { enterB(); await gateB; }, signing);
		await Promise.all([enteredA, enteredB]);
		let closeReleased = false, signingReleased = false;
		const closeRelease = close.release().then(() => { closeReleased = true; });
		const signingRelease = signing.release().then(() => { signingReleased = true; });
		await expect(close.checkWhile(async () => undefined, signing)).rejects.toThrow("unavailable");
		await expect(signing.checkWhile(async () => undefined)).rejects.toThrow("unavailable");
		expect(closeReleased).toBe(false); expect(signingReleased).toBe(false); expect(f.state.nativeReleases).toBe(0);
		finishA(); await a;
		expect(closeReleased).toBe(false); expect(signingReleased).toBe(false); expect(f.state.nativeReleases).toBe(0);
		finishB(); await b; await Promise.all([closeRelease, signingRelease]);
		expect(f.state.censusChecks).toBe(4); expect(f.state.nativeChecks).toBe(4);
		expect(f.state.nativeReleases).toBe(1); expect(f.facts.pending.size).toBe(0);
		await f.lifetime.release();
	});
	it("immediately revokes new parent admissions while joining the already admitted read", async () => {
		const f = fixture(), { close, signing } = await children(f);
		let entered!: () => void, finish!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
		const read = close.checkWhile(async () => { entered(); await gate; }, signing);
		await started; let parentReleased = false;
		const released = f.lifetime.release().then(() => { parentReleased = true; });
		await expect(close.checkWhile(async () => undefined, signing)).rejects.toThrow("unavailable");
		await expect(f.lifetime.borrowDependencies()).rejects.toThrow("unavailable");
		expect(parentReleased).toBe(false); expect(f.state.nativeReleases).toBe(0);
		finish(); await read; await released;
		expect(parentReleased).toBe(true); expect(f.state.nativeReleases).toBe(1);
		await close.release();
	});
	it("preserves the original native after-check refusal and joins the failure before release", async () => {
		const f = fixture(), { close, signing } = await children(f);
		f.state.afterNative = () => { throw new Error("native-currency-stale"); };
		let entered!: () => void, finish!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
		const read = close.checkWhile(async () => { entered(); await gate; }, signing);
		await started;
		const closeRelease = close.release();
		const signingOutcome = signing.release().then(() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }));
		const refused = expect(read).rejects.toThrow("native-currency-stale");
		expect(f.state.nativeReleases).toBe(0); finish();
		await refused; await closeRelease;
		const outcome = await signingOutcome;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toBeInstanceOf(AggregateError);
		expect(f.state.censusChecks).toBe(2); expect(f.state.nativeChecks).toBe(2);
		await f.lifetime.release(); expect(f.state.nativeReleases).toBe(1);
	});
});

describe("inherited classification mechanical marker and accounting", () => {
	const pair = (
		epoch: number
	): ReturnType<typeof snapshotQuarantineContract.captureClassificationIntent>["promoted"][number] => ({
		scope: { objectId: "r".repeat(64), epoch, anchor: "a".repeat(64), manifestDigest: "b".repeat(64) },
		incarnation: "c".repeat(36),
		contentBytes: 100 + epoch,
	});
	const marker = (): Omit<ReturnType<typeof snapshotQuarantineContract.captureClassificationIntent>, "promoted"> & {
		promoted: ReturnType<typeof pair>[];
	} => ({
		objectId: "r".repeat(64),
		decisionDigest: "d".repeat(64),
		sourceProofDigest: "e".repeat(64),
		promoted: [pair(0), pair(1), pair(2), pair(3)],
	});

	it("roundtrips four exact references beyond the former pointer-only bound without retaining caller objects", () => {
		const input = marker();
		const encoded = JSON.stringify(input);
		expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(1024);
		const captured = snapshotQuarantineContract.captureClassificationIntent(JSON.parse(encoded));
		expect(captured).toEqual(input);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.isFrozen(captured.promoted)).toBe(true);
		const detached = snapshotQuarantineContract.captureClassificationIntent(input);
		const first = input.promoted[0];
		if (first === undefined) throw new Error("four-reference fixture is incomplete");
		Reflect.set(first.scope, "anchor", "f".repeat(64));
		input.promoted.pop();
		expect(detached).toEqual(captured);
	});

	it("bounds the complete escaped marker at the original dependency-object domain", () => {
		const objectId = "\u0000".repeat(1024);
		const input = { ...marker(), objectId };
		input.promoted = input.promoted.map((row) => ({
			...row,
			scope: { ...row.scope, objectId },
			incarnation: "\u0000".repeat(36),
			contentBytes: Number.MAX_SAFE_INTEGER,
		}));
		const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
		expect(bytes).toBeLessThanOrEqual(snapshotQuarantineContract.maxClassificationIntentBytes);
		expect(snapshotQuarantineContract.captureClassificationIntent(JSON.parse(JSON.stringify(input)))).toEqual(input);
		const oversizedId = objectId + "x";
		expect(() =>
			snapshotQuarantineContract.captureClassificationIntent({
				...input,
				objectId: oversizedId,
				promoted: input.promoted.map((row) => ({ ...row, scope: { ...row.scope, objectId: oversizedId } })),
			})
		).toThrow();
	});

	it("refuses malformed, foreign, duplicate or over-cardinality source subsets", () => {
		const input = marker();
		for (const promoted of [
			[],
			[...input.promoted, pair(4)],
			[pair(0), pair(0)],
			[{ ...pair(0), contentBytes: -1 }],
			[{ ...pair(0), incarnation: "c".repeat(37) }],
			[{ ...pair(0), scope: { ...pair(0).scope, objectId: "foreign" } }],
		]) {
			expect(() => snapshotQuarantineContract.captureClassificationIntent({ ...input, promoted })).toThrow();
		}
		expect(() => snapshotQuarantineContract.captureClassificationIntent({ ...input, done: true })).toThrow();
	});

	it("reconstructs exact former accounting without refunding unknown debt or clearing the pending barrier", () => {
		const classificationIntent = snapshotQuarantineContract.captureClassificationIntent(marker());
		const owner = {
			limits: snapshotQuarantineContract.defaultRecoveryLimits,
			recoveryScopes: 4,
			recoveryContentBytes: 406,
			legacyUnclassifiedScopes: 1,
			legacyUnclassifiedContentBytes: 71,
			migration: "classification-required" as const,
			classificationIntent,
		};
		const before = encodeCanonical(owner);
		const restored = snapshotQuarantineContract.classificationSourceOwner(owner);
		expect(restored).toEqual({
			limits: owner.limits,
			recoveryScopes: 0,
			recoveryContentBytes: 0,
			legacyUnclassifiedScopes: 5,
			legacyUnclassifiedContentBytes: 477,
			migration: "classification-required",
		});
		expect(encodeCanonical(owner)).toEqual(before);
		expect(() =>
			snapshotQuarantineContract.classificationSourceOwner({ ...owner, recoveryContentBytes: 405 })
		).toThrow();
		expect(() => snapshotQuarantineContract.classificationSourceOwner({ ...owner, recoveryScopes: 3 })).toThrow();
		// This reverses bookkeeping only. It neither authenticates a snapshot nor
		// verifies native postimages, committed controls or SAME-intent currency.
	});
});

describe("snapshot retirement fact fields shared with prospective sizing", () => {
	it("compares complete native residual/OLD components without inventing an AHE-sized wrapper", () => {
		const same = execute<(left: any, right: any) => boolean>(`${declaration("closedJournalReconstructedControlCarriers")}\n` +
			`${declaration("closedJournalNativeObservationEqual")}\nclosedJournalNativeObservationEqual;`, {
			capturePromotionRecord, capturePromotionArray, capturePromotionBytes, LIVE_JOURNAL_RETIREMENT_LIMITS,
			LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, encodeJournalRetirementNativeCarriers,
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))),
		});
		// Comparator-only canonical byte vectors; these do not mint a native
		// image, signed-row authentication, or retirement permission.
		const rows = Array.from({length: 400}, (_, i) => encodeCanonical([i, new Uint8Array(1400).fill(i % 255)]));
		const control = {kind: "v3-live-journal-retirement-control-1", objectId: "room", incarnation: "f".repeat(64),
			revision: 0, sequence: 0, active: null, completed: null};
		const carriers = encodeJournalRetirementNativeCarriers(control as any);
		const image = {imageDigest: "a".repeat(64), scopeCount: 0, rowCount: rows.length, byteCharge: rows.reduce((n, r) => n + r.length, 0)};
		const value = {control, exactCanonicalControlCarriers: [carriers.controlBytes], image, canonicalRows: rows,
			drainSource: {control, image, canonicalRows: rows}};
		expect(() => encodeCanonical(value, {maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes, maxDepth: 128, maxItems: 65_536})).toThrow();
		expect(same(value, decodeCanonical(encodeCanonical(value, {maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes})))).toBe(true);
		const altered = rows.map(r => r.slice()); altered[17]![5] ^= 1;
		expect(same(value, {...value, canonicalRows: altered})).toBe(false);
		expect(same(value, {...value, drainSource: {...value.drainSource, canonicalRows: altered}})).toBe(false);
		expect(same(value, {...value, control: {...control, revision: 1}})).toBe(false);
		expect(same(value, {...value, exactCanonicalControlCarriers: [Uint8Array.of(0)]})).toBe(false);
		expect(same(value, {...value, extra: true})).toBe(false);
		expect(same(value, {...value, drainSource: undefined})).toBe(false);
		const reordered = [...rows]; [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
		expect(same(value, {...value, canonicalRows: reordered})).toBe(false);
		let invoked = false;
		expect(same(value, {...value, get image() {invoked = true; return image;}})).toBe(false);
		expect(invoked).toBe(false);
	});
	it("selects signing contexts from a joined complete native read without discarding actual row authorities", async () => {
		const branch = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(parsed) === "signingTrusts.length > 7");
		const trusts = Array.from({length: 9}, (_, currentEpoch) => ({currentEpoch}));
		const run = async (rows: unknown[], failure?: string) => {
			let released = false, checked = false;
			const bytes = rows.map((row) => encodeCanonical(row)), charged: Uint8Array[] = [];
			const select = execute<(signingTrusts: any[]) => Promise<any[]>>(`${declaration("joinedClosedRetirementRead")}\n` +
				`(async function(signingTrusts) {${branch.getText(parsed)}\nreturn signingTrusts;});`, {
				lifetime: {captureClassificationMetadataOwners: () => ({signing: {acquireEvidence: async () => ({
					readExactCanonicalRows: () => bytes, check: async () => {checked = true; if (failure) throw Error(failure);},
					release: async () => {released = true;},
				})}})}, frame: {accounting: {}}, work: {accounting: {}}, forward: {currentTrust: trusts[8]}, input: {objectId: "room"},
				chargeProofObservation: (_: unknown, value: Uint8Array) => {charged.push(value); return true;},
				requireLaw: (value: unknown, reason: string) => {if (!value) throw Error(reason);},
			});
			try {return {selected: await select(trusts), checked, charged};}
			finally {expect(released).toBe(true);}
		};
		const rows = [["storageMeta", "incarnation", {}], ["signerState", ["room", 2, "signer"], {}]];
		const result = await run(rows); expect(result.selected).toEqual([trusts[2], trusts[8]]);
		expect(result.checked).toBe(true); expect(result.charged).toEqual(rows.map((row) => encodeCanonical(row)));
		expect((await run([["storageMeta", "incarnation", {}]])).selected).toEqual([trusts[8]]);
		await expect(run([["signerState", ["foreign", 2, "signer"], {}]])).rejects.toThrow("chain-invalid");
		await expect(run(rows, "changed")).rejects.toThrow("changed");
		// A real nine-context workload is NOT made to fit by dropping rows. The
		// unchanged original signing owner must still refuse its >7 input.
		expect((await run(trusts.map(trust => ["signerState", ["room", trust.currentEpoch, "signer"], {}]))).selected).toEqual(trusts);
	});
	it("selects headers from the same residual journal used by summary retirement, retaining OLD only for detail resume", () => {
		const owner = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "reconcileSnapshotRecoveryRoles");
		const selected = ["retirementJournal", "journalHeaders"].map(name => unique((node): node is ts.VariableDeclaration =>
			ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.pos >= owner.pos && node.end <= owner.end));
		const old = {canonicalRows: ["obsolete-header", "old-detail"]}, residual = {canonicalRows: []};
		// 4c4f192c: a detachable lifetime prepares headers from captured scopes
		// (prepareClosedJournalHeaders) instead of the live classifier. Both header
		// selectors must consume the SAME residual journal.
		for (const detachedClassification of [false, true]) for (const summaries of [undefined, {}]) {
			let headerInput: unknown;
			const value = execute<unknown>(`${selected.map(n => `const ${n.getText(parsed)};`).join("\n")}\nretirementJournal;`, {
				signingSummaries: summaries, journalProof: old, journal: {value: residual},
				sourceFrame: {closeDependencies: {dependencyAnchors: []}}, forward: {}, roles: {floor: {}},
				closeUnion: {snapshotScopes: []}, roleProofs: [], unclassifiedSigning: false,
				detachedClassification, journalReconstructed: false, capturedHeaderScopes: [], input: {pinnedGenesisAnchorDigest: "genesis"},
				classificationAccounting: {},
				classifyClosedJournalHeaders: (input: {journal: unknown}) => {headerInput = input.journal; return undefined;},
				prepareClosedJournalHeaders: (input: {journal: unknown}) => {headerInput = input.journal; return undefined;},
			});
			expect(value).toBe(summaries === undefined ? old : residual); expect(headerInput).toBe(value);
		}
		const fields: ts.PropertyAssignment[] = [];
		const visit = (node: ts.Node): void => {if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "journal" &&
			node.initializer.getText(parsed) === "retirementJournal") fields.push(node); ts.forEachChild(node, visit);};
		visit(owner); expect(fields).toHaveLength(3); // Both header selectors and the returned source, one owner.
	});
	it("keeps exact received generation consumers protected without treating receipt syntax as authority", () => {
		const equal = (a: unknown, b: unknown) => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
		const objectId = `creator:${"0".repeat(32)}`;
		const scope = {objectId, epoch: 3, anchor: "a".repeat(64), manifestDigest: "b".repeat(64)};
		const candidate = (value: unknown) => {const bytes = encodeCanonical(value), digest = digestBlob(bytes);
			if (!digest.ok) throw Error("digest"); return {bytes, ref: {digest: digest.value, byteLength: bytes.length}};};
		const oldTrust = candidate({kind: "drp-anchor-trust-state", currentEpoch: 3});
		const cut = candidate({...scope, kind: "drp-hard-epoch-cut", previousAnchor: scope.anchor, snapshotManifestDigest: scope.manifestDigest});
		const qc = candidate({kind: "drp-seal-qc", epoch: 3}), trust = candidate({kind: "drp-anchor-trust-state", currentEpoch: 4});
		const projection = candidate({kind: "v3-live-generation-2", epoch: 4});
		const settlement = candidate({kind: "settlement"}), history = candidate({kind: "history"});
		const old = {objectId, generationId: "1".repeat(64), closureDigest: "c".repeat(64)};
		const oldHead = {...old, kind: "present" as const, revision: 3};
		const current = {objectId, generationId: "2".repeat(64), closureDigest: "d".repeat(64), baseExpectedHead: oldHead};
		const previous = {candidates: [oldTrust]}, next = {candidates: [cut, qc, trust, projection, settlement]};
		const certificate = {kind: "creator-received-recovery-certificate-1", pinnedGenesisAnchorDigest: "e".repeat(64),
			exactCanonicalOldHeadBytes: encodeHeadRecordV1(oldHead as any), currentTrustRef: oldTrust.ref,
			exactCanonicalCutValueBytes: cut.bytes, exactCanonicalCommitQcBytes: qc.bytes,
			exactCanonicalTrustStateRecordBytes: trust.bytes, exactCanonicalSettlementBytes: settlement.bytes,
			exactCanonicalHistoryBytes: history.bytes, sealedReplayDigest: "f".repeat(64), sealedReplayRowCount: 1,
			sealedReplayByteCharge: 1, candidateGenerationId: current.generationId, candidateClosureDigest: current.closureDigest};
		let coverage = true;
		const check = execute<(input: any) => boolean>(`${declaration("closedReceivedGenerationConsumersCovered")}\nclosedReceivedGenerationConsumersCovered;`, {
			openReceivedCertificate, decodeHeadRecordV1, record: decodeCanonical, closedRetirementEqual: equal,
			closedGenerationCertificateCoverage: () => coverage,
			view: (_: unknown, index: number) => [previous, next][index], uniqueCreatorTransitionCandidate,
			deriveCreatorCloseHistory: () => history,
			// 1515daab: a native-checkpoint transfer may make the generation the
			// historical point; this proof carries no such transfer (genuine resolver).
			resolveCreatorNativeCheckpointRecoveryTransfer,
		});
		const frame = {input: {objectId, pinnedGenesisAnchorDigest: certificate.pinnedGenesisAnchorDigest},
			reader: {generations: [old, current]}, authenticatedExcludedGenerations: []};
		const proof = {protectedScopes: [scope], authenticatedSourceGenerations: [{scope, generation: current}]};
		const base = {frame, scope, proofs: [proof], bytes: encodeCanonical(certificate)};
		expect(check(base)).toBe(true);
		coverage = false; expect(check(base)).toBe(false); coverage = true;
		for (const changed of [{...certificate, pinnedGenesisAnchorDigest: "0".repeat(64)},
			{...certificate, exactCanonicalOldHeadBytes: encodeHeadRecordV1({...oldHead, revision: 4} as any)},
			{...certificate, candidateClosureDigest: "0".repeat(64)}, {...certificate, candidateGenerationId: old.generationId},
			{...certificate, exactCanonicalCommitQcBytes: encodeCanonical({kind: "altered"})},
			{...certificate, exactCanonicalHistoryBytes: encodeCanonical({kind: "altered"})},
			{...certificate, currentTrustRef: {...oldTrust.ref, byteLength: oldTrust.ref.byteLength + 1}},
			{...certificate, extra: true}]) expect(check({...base, bytes: encodeCanonical(changed)})).toBe(false);
		expect(check({...base, frame: {...frame, authenticatedExcludedGenerations: [old]}})).toBe(false);
		expect(check({...base, frame: {...frame, authenticatedExcludedGenerations: [current]}})).toBe(false);
		expect(check({...base, frame: {...frame, reader: {generations: [current]}}})).toBe(false);
	});
	it("uses only the exact authenticated predecessor receipt for historical absence, never current protected absence", () => {
		class Refusal extends Error {constructor(readonly result: unknown) {super(JSON.stringify(result));}}
		const capture = execute<(...args: any[]) => any>(`${declaration("captureSnapshotRetirementInventoryState")}\ncaptureSnapshotRetirementInventoryState;`, {
			Refusal, failure: (...args: unknown[]) => args,
			requireLaw: (value: unknown) => {if (!value) throw Error("refused");},
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))),
		});
		const scope = (epoch: number) => ({objectId: "room", epoch, anchor: `a${epoch}`, manifestDigest: `m${epoch}`});
		const row = (epoch: number) => ({scope: scope(epoch), incarnation: `i${epoch}`, contentBytes: 1});
		const trust = {objectId: "room", currentEpoch: 4, currentAnchorDigest: "head4", genesisAnchorDigest: "genesis"};
		const roles = {currentClose: scope(3), previousClose: scope(2), operationalSources: [], classifiedScopes: [scope(0)]};
		const prior = {roles: {currentClose: scope(2), classifiedScopes: [scope(0)]},
			trust: {...trust, currentEpoch: 3, currentAnchorDigest: "head3"}, digest: "certificate3"};
		const receipt = {certificateDigest: prior.digest,
			currentHead: {objectId: "room", epoch: 3, currentAnchorDigest: "head3"},
			survivor: {scope: scope(2), incarnation: "i2"}, retired: [{scope: scope(0), incarnation: "i0"}]};
		const inventory = {scopes: [row(1), {...row(2), retirement: receipt}, row(3)], owner: {}};
		const ledger = {charge: () => true};
		const invoke = (i = inventory, r = roles, p: any = prior) => capture(i, r, trust, "certificate4", ledger, undefined, p);
		expect([...invoke().retired]).toEqual([JSON.stringify(["room", 0, "a0", "m0"])]);
		expect(() => capture(inventory, roles, trust, "certificate4", ledger)).toThrow("UNPROVEN_ABSENCE");
		expect(() => invoke(inventory, {...roles, previousClose: scope(0)})).toThrow("PROTECTED_ROLE_MISSING");
		for (const p of [{...prior, digest: "foreign"}, {...prior, trust: {...prior.trust, currentAnchorDigest: "foreign"}},
			{...prior, trust: {...prior.trust, currentEpoch: 1}}, {...prior, roles: {...prior.roles, classifiedScopes: []}}])
			expect(() => invoke(inventory, roles, p)).toThrow("RECOVERY_CERTIFICATE");
		expect(() => invoke({...inventory, scopes: [row(1), {...row(2), incarnation: "changed", retirement: receipt}, row(3)]})).toThrow("PRIOR_RETIREMENT_BINDING");
		const present = invoke({...inventory, scopes: [...inventory.scopes, row(0)]});
		expect(present.retired.size).toBe(0);
	});
	it("preserves complete native fields and replaces rather than merges prior retired pairs", () => {
		const pair = (epoch: number): SnapshotRecoveryRoleRetirementFact["survivor"] => ({
			scope: { objectId: "room", epoch, anchor: "a".repeat(64), manifestDigest: "b".repeat(64) },
			incarnation: "c".repeat(36),
		});
		const priorSurvivor = pair(3),
			survivor = pair(4),
			retired = [pair(2)];
		const priorDecision = {
			certificateDigest: "d".repeat(64),
			currentHead: { objectId: "room", epoch: 4, currentAnchorDigest: "e".repeat(64) },
			survivorScope: priorSurvivor.scope,
		};
		const prior = snapshotQuarantineContract.recoveryRetirementCarrier(
			priorDecision,
			priorSurvivor,
			[pair(0), pair(1)],
			[]
		);
		const decision = {
			...priorDecision,
			currentHead: { ...priorDecision.currentHead, epoch: 5 },
			survivorScope: survivor.scope,
		};
		const fields = snapshotQuarantineContract.recoveryRetirementFactFields(decision, survivor, retired);
		const native = snapshotQuarantineContract.recoveryRetirementCarrier(decision, survivor, retired, []);
		expect(encodeCanonical(fields)).toEqual(encodeCanonical(native.carrier.retirement));
		expect(fields.retired).toEqual(retired);
		expect(fields.retired).not.toEqual((prior.carrier.retirement as { retired: unknown }).retired);
		// Mechanical field construction alone grants no native authority and
		// does not bypass the original fact binding/parser laws.
		expect(() =>
			snapshotQuarantineContract.captureRecoveryRoleRetirementFact(
				snapshotQuarantineContract.recoveryRetirementFactFields(decision, survivor, [pair(3)])
			)
		).toThrow();
	});
});

describe("original whole-proof accounting for unknown future encodings", () => {
	it("charges equal unknown lengths separately without deduplication or refund", () => {
		const owner = createCreatorClosedRollbackProofAccounting([
			{ ref: { digest: "a" as never, byteLength: 2 }, bytes: Uint8Array.of(1, 2) },
		]);
		expect(owner.chargeUnknownEncodedLength(2)).toBe(true);
		expect(owner.chargeUnknownEncodedLength(2)).toBe(true);
		expect(owner.chargedBytes).toBe(6);
		// Known exact bytes still deduplicate; lengths never establish byte identity.
		expect(owner.charge(Uint8Array.of(1, 2))).toBe(true);
		expect(owner.chargedBytes).toBe(6);
		expect(owner.charge(Uint8Array.of(2, 1))).toBe(true);
		expect(owner.chargedBytes).toBe(8);
		expect(owner.charge(Uint8Array.of(2, 1))).toBe(true);
		expect(owner.chargedBytes).toBe(8);
	});

	it("shares the configured byte boundary with actual encoded bytes", () => {
		const limit = CREATOR_ORDINARY_PROOF_MAX_BYTES;
		const owner = createCreatorClosedRollbackProofAccounting([]);
		expect(owner.chargeUnknownEncodedLength(limit - 2)).toBe(true);
		expect(owner.charge(Uint8Array.of(1, 2))).toBe(true);
		expect(owner.chargedBytes).toBe(limit);
		expect(owner.chargeUnknownEncodedLength(1)).toBe(false);
		expect(owner.charge(Uint8Array.of(2, 1))).toBe(false);
		expect(owner.chargedBytes).toBe(limit);
		expect(owner.charge(Uint8Array.of(1, 2))).toBe(true);
		expect(owner.chargeUnknownEncodedLength(0)).toBe(true);
		expect(owner.chargedBytes).toBe(limit);
	});

	it("refuses invalid or over-budget lengths without changing the ledger", () => {
		const owner = createCreatorClosedRollbackProofAccounting([]);
		for (const length of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, CREATOR_ORDINARY_PROOF_MAX_BYTES + 1]) {
			expect(owner.chargeUnknownEncodedLength(length)).toBe(false);
			expect(owner.chargedBytes).toBe(0);
		}
		expect(owner.chargeUnknownEncodedLength(CREATOR_ORDINARY_PROOF_MAX_BYTES)).toBe(true);
		expect(owner.chargedBytes).toBe(CREATOR_ORDINARY_PROOF_MAX_BYTES);
	});
});

describe("original retirement source and decision carrier widths", () => {
	it("bounds the full future header PRE without assuming current emptiness or a seven-scope consumer union", () => {
		const objectId = "room", genesis = "a".repeat(64);
		const headers = Array.from({length: 18}, (_, index) => {
			const scope = {objectId, epoch: index, anchorDigest: index === 0 ? genesis : "b".repeat(64)};
			const bytes = encodeCanonical(["scopes", [objectId, scope.epoch, scope.anchorDigest],
				{signedEnvelope: new Uint8Array(80 + index * 11), nextSequence: 9}]);
			return {scope, bytes};
		});
		const protectedHeaderScopes = [...headers.map(header => header.scope),
			{objectId: "foreign-source", epoch: 2, anchorDigest: "c".repeat(64)}];
		const canonicalRows = [...headers.map(header => header.bytes),
			encodeCanonical(["entries", [objectId, 1, "b".repeat(64), 0], {sourceKind: "received"}])];
		const inspect = (rows: Uint8Array[]) => execute<{count: number; bytes: number; protectedHeaderScopes: unknown}>(`
			const maintenanceWidthAtom = Symbol("private-header-width");
			${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceCanonicalWidth",
				"closedJournalHeaderDrainWidthsForSizing"].map(declaration).join("\n")}
			const result = closedJournalHeaderDrainWidthsForSizing({objectId, pinnedGenesisAnchorDigest: genesis,
				canonicalRows: rows, protectedHeaderScopes});
			({count: result.count, bytes: maintenanceCanonicalWidth(result.retiredEmptyHeaders),
				protectedHeaderScopes: result.protectedHeaderScopes});`,
			{objectId, genesis, rows, protectedHeaderScopes, AHE_BOUNDED_READ_LIMITS,
				LIVE_JOURNAL_RETIREMENT_BATCH_ROWS: 16});
		const measured = inspect(canonicalRows);
		const descriptors = headers.slice(1).map(({scope, bytes}) => ({scope, exactCanonicalNativeFrameBytes: bytes}))
			.sort((left, right) => encodeCanonical(right).byteLength - encodeCanonical(left).byteLength).slice(0, 16);
		expect(measured.count).toBe(16);
		expect(measured.bytes).toBe(encodeCanonical(descriptors).byteLength);
		expect(measured.protectedHeaderScopes).toEqual(protectedHeaderScopes);
		// A present received detail row cannot erase its eventual header's PRE.
		expect(inspect(headers.map(header => header.bytes))).toEqual(measured);
		for (let omitted = 0; omitted < 17; omitted++) {
			const subset = headers.slice(1).filter((_, index) => index !== omitted)
				.map(({scope, bytes}) => ({scope, exactCanonicalNativeFrameBytes: bytes}));
			expect(encodeCanonical(subset).byteLength).toBeLessThanOrEqual(measured.bytes);
		}
	});
	it("retains complete header PRE and protection in header-only and mixed source widths", () => {
		const base = {summary: null, floor: null, rows: [], snapshots: [], snapshotImage: null, journalImage: null};
		const cut = {epoch: 8};
		const scope = {objectId: "room", epoch: 1, anchorDigest: "b".repeat(64)};
		const journalHeaders = {retiredEmptyHeaders: [{scope,
			exactCanonicalNativeFrameBytes: new Uint8Array(257)}],
			protectedHeaderScopes: [{...scope, epoch: 0}, {...scope, epoch: 8}]};
		const journalPrefixes = [{scope: {...scope, epoch: 2}, highWatermark: 1, rows: [{journalSequence: 0}]}];
		const signingDetails = [{key: ["room", 1, "creator"]}];
		const width = (value: unknown): number => encodeCanonical(value).byteLength;
		const baseWidths = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, width(value)])) as
			{summary: number; floor: number; rows: number; snapshots: number; snapshotImage: number; journalImage: number};
		for (const prefixes of [undefined, journalPrefixes]) {
			const measured = readCreatorClosedRetirementSourceCarrierWidthsForSizing({...baseWidths,
				cut: width(cut), journalHeaders: width(journalHeaders), signingDetails: width(signingDetails),
				...(prefixes === undefined ? {} : {journalPrefixes: width(prefixes)})});
			const expected = [[false, false], [true, false], [false, true], [true, true]].map(([journal, signing]) =>
				width({...base,
					...(journal ? {journalHeaders, ...(prefixes === undefined ? {} : {journalPrefixes: prefixes})} : {}),
					...(signing ? {signingDetails} : {})}) + width({cut, sourceProofDigest: "a".repeat(64),
					policy: signing ? "authenticated-covered-local-finalized-evidence" : journal
						? "authenticated-covered-local-journal-prefixes" : "authenticated-closed-metadata-frontiers-no-drain"}));
			expect(measured).toEqual(expected);
			const altered = {...journalHeaders, retiredEmptyHeaders: [{scope,
				exactCanonicalNativeFrameBytes: new Uint8Array(258)}]};
			const larger = readCreatorClosedRetirementSourceCarrierWidthsForSizing({...baseWidths, cut: width(cut),
				journalHeaders: width(altered), signingDetails: width(signingDetails),
				...(prefixes === undefined ? {} : {journalPrefixes: width(prefixes)})});
			expect(larger[1]).toBe(measured[1]! + 1);
			expect(larger[3]).toBe(measured[3]! + 1);
		}
	});
	it("covers complete enclosing fields and the simultaneous journal/evidence branch without synthetic bytes", () => {
		const children = {
			summary: { floor: { epoch: 64 }, head: { revision: 128 }, profileId: "profile-α", cuts: [null] },
			floor: { stable: { objectId: "room", epoch: 65 }, pending: null },
			rows: Array.from({ length: 128 }, (_, i) => ({ index: i, value: Uint8Array.of(i) })),
			snapshots: [{ scope: { objectId: "room", epoch: 64 }, incarnation: "actual-known-incarnation" }],
			snapshotImage: { scopeCount: 1, chunkCount: 0, metadataBytes: 128 },
			journalImage: { scopeCount: 2, rowCount: 127, byteCharge: 16_384 },
			cut: { objectId: "room", epoch: 64, payloadByteLength: 128 },
			journalPrefixes: [{ scope: { epoch: 63 }, highWatermark: 128, rows: [{ journalSequence: 127 }] }],
			signingDetails: [{ key: ["room", 63, "actual-known-signer"], retained: false }],
			summarySource: { entries: [], eligibilityFence: { epoch: 63 } },
			generationSource: { generations: { protectedIndices: [0], retireIndices: [1] } },
		};
		const widths = Object.fromEntries(
			Object.entries(children).map(([key, value]) => [key, encodeCanonical(value).length])
		);
		const measured = readCreatorClosedRetirementSourceCarrierWidthsForSizing(
			widths as {
				summary: number;
				floor: number;
				rows: number;
				snapshots: number;
				snapshotImage: number;
				journalImage: number;
				cut: number;
				journalPrefixes: number;
				signingDetails: number;
				summarySource: number;
				generationSource: number;
			}
		);
		const scenarios = [
			[false, false, "authenticated-closed-metadata-frontiers-no-drain"],
			[true, false, "authenticated-covered-local-journal-prefixes"],
			[false, true, "authenticated-covered-local-finalized-evidence"],
			[true, true, "authenticated-covered-local-finalized-evidence"],
			[false, false, "authenticated-fenced-local-finalized-signing-summaries-v2"],
			[false, false, "authenticated-excluded-native-generation-v3"],
		] as const;
		const expected = scenarios.map(([journal, signing, policy]) => {
			const source = {
				summary: children.summary,
				floor: children.floor,
				rows: children.rows,
				snapshots: children.snapshots,
				snapshotImage: children.snapshotImage,
				journalImage: children.journalImage,
				...(journal ? { journalPrefixes: children.journalPrefixes } : {}),
				...(signing ? { signingDetails: children.signingDetails } : {}),
			};
			// Known test-only digest material tests the registered STRING64 width;
			// the product helper never constructs this value or hashes its result.
			const decision = { cut: children.cut, sourceProofDigest: "a".repeat(64), policy };
			return encodeCanonical(source).length + encodeCanonical(decision).length;
		});
		expect(measured).toEqual(expected);
		expect(measured[3]).toBeGreaterThan(Math.max(...measured.slice(1, 3)));
		for (const invalid of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
			expect(() =>
				readCreatorClosedRetirementSourceCarrierWidthsForSizing({
					summary: invalid,
					floor: 1,
					rows: 1,
					snapshots: 1,
					snapshotImage: 1,
					journalImage: 1,
					cut: 1,
				})
			).toThrow();
		// This is the complete-child width refusal at the already accepted
		// current profile, not the obsolete 262144-byte profile. Product limits
		// stay unchanged; an over-limit child must still throw before effects.
		expect(() =>
			readCreatorClosedRetirementSourceCarrierWidthsForSizing({
				summary: AHE_BOUNDED_READ_LIMITS.maxUnionBytes + 1,
				floor: 1,
				rows: 1,
				snapshots: 1,
				snapshotImage: 1,
				journalImage: 1,
				cut: 1,
			})
		).toThrow();
		expect(() =>
			readCreatorClosedRetirementSourceCarrierWidthsForSizing({
				summary: 1,
				floor: 1,
				rows: 1,
				snapshots: 1,
				snapshotImage: 1,
				journalImage: 1,
				cut: 1,
				summarySource: 0,
			})
		).toThrow();
	});
});

// Test-only extraction of private production statements. No product
// export, valid native control, authentication or complete-quote claim is added.
const ownerPath = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const source = readFileSync(ownerPath, "utf8");
const parsed = ts.createSourceFile(ownerPath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function unique<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
	const found: T[] = [];
	function visit(node: ts.Node): void {
		if (predicate(node)) found.push(node);
		ts.forEachChild(node, visit);
	}
	visit(parsed);
	if (found.length !== 1) throw Error(`PRIVATE_STATEMENT_NOT_UNIQUE:${found.length}:${predicate.toString()}`);
	return found[0]!;
}
// The source is read and parsed once, so an extracted declaration's text is fixed for the run. Each
// lookup walks the whole owner file (26k lines, ~18 ms per walk on the sandbox), and harnesses that
// rebuild their program per case (sizing widths, CURRENT phase maps) looked the same names up
// hundreds of times: that, not the code under test, took them past the 10 s test timeout.
const declarations = new Map<string, string>();
function declaration(name: string): string {
	let text = declarations.get(name);
	if (text === undefined) {
		text = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(parsed);
		declarations.set(name, text);
	}
	return text;
}
function maintenanceProofMaxBytes(): number {
	return CREATOR_MAINTENANCE_PROOF_MAX_BYTES;
}
function sourceProofAccounting(maintenance = false, ordinaryLimit: number = AHE_BOUNDED_READ_LIMITS.maxUnionBytes,
	maintenanceLimit = maintenanceProofMaxBytes()): ReturnType<typeof createCreatorClosedRollbackProofAccounting> {
	return execute(`${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}\ncreateCreatorClosedRollbackProofAccounting([], maintenance);`, {
		AHE_BOUNDED_READ_LIMITS, CREATOR_ORDINARY_PROOF_MAX_BYTES: ordinaryLimit, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: maintenanceLimit,
		maintenance, proofMaterialOwners: new WeakMap(),
	});
}
const loop = unique((node): node is ts.ForOfStatement => ts.isForOfStatement(node) &&
	ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) &&
	ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === "summaryEpochSchedule");
const recursion = unique((node): node is ts.CallExpression => ts.isCallExpression(node) &&
	ts.isIdentifier(node.expression) && node.expression.text === "composeProspectiveCreatorMaintenancePrefixesForSizing" &&
	node.arguments.length === 9 && ts.isIdentifier(node.arguments[3]!) && node.arguments[3]!.getText(parsed) === "continuation");
const continuationDeclaration = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
	ts.isIdentifier(node.name) && node.name.text === "continuation" && ts.isCallExpression(node.initializer!) &&
	ts.isPropertyAccessExpression(node.initializer!.expression) && node.initializer!.expression.getText(parsed) === "Object.freeze");
const branch = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
	node.expression.getText(parsed) === "!generationOnly" && loop.pos >= node.thenStatement.pos && loop.end <= node.thenStatement.end);
const consume = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
	ts.isIdentifier(node.name) && node.name.text === "signingData" &&
	node.initializer?.getText(parsed).includes("precloseControls?.signingPhysicalRows") === true);
const declarationCode = ["closedRetirementEqual", "selectClosedSigningSummaryEpoch", "closedSigningSummaryResidualRows"].map(declaration).join("\n");
// Transpiling is a pure function of the program text; each call still evaluates a fresh program.
const transpiled = new Map<string, string>();
function execute<T>(code: string, context: Record<string, unknown>): T {
	let js = transpiled.get(code);
	if (js === undefined) {
		js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
		transpiled.set(code, js);
	}
	const imports = { createWorkCheckpoint, encodeCanonical, decodeCanonical, closedRetirementBytes: encodeCanonical,
		CREATOR_ORDINARY_PROOF_MAX_BYTES, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: maintenanceProofMaxBytes(),
		compareBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)), ...context };
	// Execute in the codec's realm. A separate VM realm would produce foreign
	// Object prototypes rejected by the genuine canonical plain-object guard.
	return Function(...Object.keys(imports), `"use strict"; return eval(${JSON.stringify(js)});`)(...Object.values(imports)) as T;
}

describe("cold source factory compound read and deferred enrollment", () => {
	it("uses the original terminal owner's synchronous guard without mistaking it for native currency", () => {
		const owner = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "acquireCreatorIssuanceMaintenanceProof");
		const found: ts.PropertyAssignment[] = [];
		const visit = (node: ts.Node): void => {if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "checkAvailable") found.push(node); ts.forEachChild(node, visit);};
		visit(owner); expect(found).toHaveLength(1);
		for (const mutation of ["none", "released", "write", "begin", "frame", "frame-registry", "ledger", "observation", "close-child", "signing-child", "header", "header-registry", "header-revoked", "header-mutation", "close-hold"]) {
			const capturedFrame = {alive: true, accounting: {}, closeDependencies: {}, signingDependencies: {}, headerHold: {} as object | undefined,
				headerConsumersRevoked: false, headerMutation: undefined as object | undefined};
			const forward = {reader: {}}, facts = {}, proof = {observation: {}}, closeHold = {}, lifetime = {}, currentTrust = {}, input = {store: {}, liveJournalStore: {}};
			const frames = new WeakMap([[forward.reader, capturedFrame]]), ledgers = new WeakMap([[capturedFrame.accounting, capturedFrame]]),
				observations = new WeakMap([[proof.observation, facts]]), journalHeaderHolds = new WeakMap([[capturedFrame.headerHold!, {}]]);
			let holdAvailable = true;
			const actual = execute<{guard(): void; revoke(kind: string): void}>(`let released = false, writeStarted = false, beginTask;
				const guard = ${found[0]!.initializer.getText(parsed)};
				({guard, revoke: kind => {if(kind === "released") released = true; if(kind === "write") writeStarted = true; if(kind === "begin") beginTask = Promise.resolve();}});`, {
				capturedFrame, forward, facts, proof, closeHold, lifetime, currentTrust, input, frames, ledgers, observations, journalHeaderHolds,
				resolveCreatorSnapshotRecoveryCloseHold: (hold: object, owners: {store: object; liveJournalStore: object; currentTrust: object}) => {
					expect(hold).toBe(closeHold); expect(owners).toEqual({...input, currentTrust}); return holdAvailable ? lifetime : undefined;
				},
				requireLaw: (ok: boolean, reason: string) => {if (!ok) throw Error(reason);},
			});
			actual.guard(); actual.revoke(mutation);
			if (mutation === "frame") capturedFrame.alive = false;
			if (mutation === "frame-registry") frames.delete(forward.reader);
			if (mutation === "ledger") ledgers.delete(capturedFrame.accounting);
			if (mutation === "observation") observations.delete(proof.observation);
			if (mutation === "close-child") capturedFrame.closeDependencies = undefined!;
			if (mutation === "signing-child") capturedFrame.signingDependencies = undefined!;
			if (mutation === "header") capturedFrame.headerHold = undefined;
			if (mutation === "header-registry") journalHeaderHolds.delete(capturedFrame.headerHold!);
			if (mutation === "header-revoked") capturedFrame.headerConsumersRevoked = true;
			if (mutation === "header-mutation") capturedFrame.headerMutation = {};
			if (mutation === "close-hold") holdAvailable = false;
			if (mutation === "none") expect(() => actual.guard()).not.toThrow(); else expect(() => actual.guard()).toThrow("snapshot-unavailable");
			// Nominal ownership/refusal only; the factory tests require its separate
			// original full currentness check before any readiness is enrolled.
		}
	});
	// Execute the complete private factory with controlled native/certificate
	// ports. Original native healthy/composition fixtures separately cover those
	// ports; this seam checks publication, read ownership and failure ordering.
	function factory(hooks: {witness?: () => Promise<void>; staged?: () => void; final?: () => Promise<void>;
		material?: readonly Uint8Array[]; uses?: readonly {protected: boolean; snapshotScopes: readonly object[]; nativeReaderRefs: readonly object[]}[]} = {}) {
		const proof = {observation: {}, accounting: {maxBytes: CREATOR_ORDINARY_PROOF_MAX_BYTES,
			chargedBytes: (hooks.material ?? []).reduce((sum, raw) => sum + raw.byteLength, 0), charge: () => true}, currentTrust: {}};
		const snapshotInventory = {scopes: [{scope: {objectId: "room", epoch: 0, anchor: "anchor", manifestDigest: "manifest"}, incarnation: "incarnation"}], owner: {}};
		const capture = {currentTrust: proof.currentTrust, closeHold: {}, snapshotInventory, receivedRecoveryScopes: undefined as readonly unknown[] | undefined,
			protectedJournalHeaderScopes: [], journal: {}, snapshot: {image: {scopes: []}},
			ahe: {}, floorImage: {state: {}}, censusBytes: encodeCanonical({nativeIssuance: {rows: {lineages: [], issued: [], outbox: [], plans: []}},
				activeUnsettled: {sources: [], cursor: null, cacheSourceSequences: []}})};
		const headerHold = {};
		const frame = {alive: true, accounting: proof.accounting, maintenanceCapture: capture, headerHold, reader: {generations: [{generationId: "head"}],
			blobs: [], head: {generationId: "head"}}, pending: new Set<Promise<unknown>>(), requirements: new Set(), recoveryTrusts: new Set(),
			signingRoleTrusts: [], input: {objectId: "room", exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array.of(0),
				capturedCatalog: {catalogDigest: "catalog"}, snapshotStore: {lookupReceivedRecoveryCertificate: async () => {
					events.push("witness"); state.lookups++; await hooks.witness?.(); return null;
				}}}};
		const forward = {reader: frame.reader, currentTrust: {currentEpoch: 1}, wholeFloor: {pending: null}, held: [], installed: [], certificates: []};
		const observation = {forward, dependencies: [], summary: {cuts: []}};
		const identity = {}, events: string[] = [], state = {available: true, checks: 0, lookups: 0, enrollments: 0, censusDecodes: 0,
			runtimeChecks: 0, runtimeEnrollments: 0,
			preparation: true, sources: [] as any[]};
		const custody = {kind: "terminal", snapshotInventory,
			checkAvailable: () => {if (!state.available || !frame.alive) throw Error("source-revoked");},
			check: async () => {events.push(`full-${++state.checks}`); if (state.checks === 2) await hooks.final?.(); if (!state.available) throw Error("source-revoked");}};
		const registry = new WeakMap<object, any>([[proof, custody]]);
		const originalSet = registry.set.bind(registry);
		registry.set = (key, value) => {if (value.kind === "ordinary-source") state.sources.push(value); return originalSet(key, value);};
		const runtimeTree = ts.createSourceFile("runtime.ts", readFileSync(new URL("../src/v3-live.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const runtimeProducer = (name: string) => {
			const node = runtimeTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (!node) throw Error(`missing composed runtime producer:${name}`); return node.getText(runtimeTree);
		};
		const runtimeFacts = {registration: {}, context: {}, retirementAllowed: false, releasing: false,
			pending: new Set(), exactCanonicalCensusBytes: capture.censusBytes,
			check: async () => {state.runtimeChecks++; custody.checkAvailable();}};
		const run = execute<(proof: object, options: object) => Promise<object | undefined>>(
			`${["resolveCreatorOrdinarySourceCapture", "captureCreatorMaintenanceReceivedRecoveryScopes", "captureCreatorOrdinaryReadOnlySourceWitnesses", "captureCreatorOrdinaryIssuanceProofSource"]
				.map(name => declaration(name).replace(/^export /, "")).join("\n")}
			${runtimeProducer("captureOrdinaryIssuanceRuntimeSourceIdentity")}
			${runtimeProducer("captureOrdinaryIssuanceRuntimeApplicationControls")}
			const captureCreatorOrdinaryIssuanceRuntimeSourceIdentity = captureOrdinaryIssuanceRuntimeSourceIdentity;
			const captureCreatorOrdinaryIssuanceRuntimeApplicationControls = captureOrdinaryIssuanceRuntimeApplicationControls;
			captureCreatorOrdinaryIssuanceProofSource;`, {
			maintenanceTerminalCustody: registry, observations: new WeakMap([[proof.observation, observation]]), frames: new WeakMap([[frame.reader, frame]]),
			ledgers: new WeakMap([[proof.accounting, frame]]), record: (raw: Uint8Array) => {
				if (raw === capture.censusBytes) state.censusDecodes++;
				return decodeCanonical(raw);
			},
			ObjectFreeze: Object.freeze,
			fullRecoveryCloseHoldFacts: (value: unknown) => value === capture.closeHold ? runtimeFacts : undefined,
			creatorOrdinaryIssuanceSourceIdentity: () => identity,
			creatorOrdinaryNativeControlApplicationFactForSizing: () => {throw Error("fixture has no native outbox");},
			captureOrdinaryReadinessPreparationForSizing: async () => ({preparation: {}, commit: () => {
				custody.checkAvailable(); events.push("runtime-enroll"); state.runtimeEnrollments++; return true;
			}}),
			journalHeaderHolds: new WeakMap([[headerHold, {}]]),
			captureCreatorOrdinaryClosedJournalApplicationRows: async () => [],
			bindMethod: (owner: Record<string, (...args: unknown[]) => unknown>, name: string) => owner[name]!.bind(owner),
			snapshotCall: (read: () => Promise<unknown>) => read(),
			creatorOrdinaryReadinessJournalGeometryIsCompleteForSizing: () => true,
			proofMaterialOwners: new WeakMap([[proof.accounting, {captureKnownMaterial: () => (hooks.material ?? []).map(raw => raw.slice()),
				captureKnownProtectedMaterial: () => {throw Error("PROTECTED_CORPUS_MUST_NOT_BE_COPIED_AGAIN");},
				captureKnownMaterialUses: () => hooks.uses ?? [], captureObservationOnlyMaterial: () => undefined}]]),
			creatorIssuanceMaintenanceObservationCarriers: () => [null],
			resolveCreatorForwardPromotionSource: () => ({installedPromotion: null, recoveryRoleTransfer: null, sources: [], protectedScopes: [], currentTrust: forward.currentTrust}),
			captureCreatorOrdinaryRuntimeCensusObservation: () => undefined,
			readProspectiveCreatorSnapshotTurnoverForSizing: () => ({ok: true, required: false, survivingScopes: [], retiringScopes: []}),
			creatorOrdinaryNativeAdvanceResourceFacts: () => undefined, creatorCloseRecoveryRoleSourceRelation: () => undefined,
			detachedGeneration: (value: object) => ({...value}),
			captureCreatorSnapshotRecoveryRoles: () => undefined, unique: () => ({bytes: encodeCanonical({})}), view: () => ({}),
			resolveCreatorSnapshotRecoveryCloseHold: () => undefined,
			closedGenerationReplayIsUnclassified: () => false, creatorSigningRoleTrustVector: () => [],
			createCreatorOrdinaryFinishingMaterialIndex: () => ({}),
			creatorOrdinaryIssuanceSourceFacts: (key: object) => registry.get(key),
			prepareCreatorOrdinarySourceReadinessForSizing: async (source: any, _preparation: unknown, _frame: unknown, _capture: unknown, _options: unknown, check: () => Promise<void>) => {
				await check(); events.push("staged"); hooks.staged?.(); await check();
				return state.preparation ? () => {events.push("enroll"); state.enrollments++; source.capacity.readiness = {prepared: true};} : undefined;
			},
			requireLaw: (ok: boolean, reason: string) => {if (!ok) throw Error(reason);},
		});
		return {frame, state, events, run: () => run(proof, {reader: {}, identity})};
	}
	it("brackets private witness work with complete checks and enrolls only after final currency", async () => {
		const f = factory(); const source = await f.run();
		expect(source).toBeDefined(); expect(f.state.checks).toBe(2);
		expect(f.events).toEqual(["full-1", "witness", "staged", "full-2", "runtime-enroll", "enroll"]);
		expect(f.state.runtimeChecks).toBe(0); expect(f.state.runtimeEnrollments).toBe(1);
		expect(f.state.enrollments).toBe(1);
		expect(f.frame.pending.size).toBe(0);
	});
	it("captures one isolated census tree per source without retaining the mutable encoded input", async () => {
		const f = factory(); expect(await f.run()).toBeDefined();
		expect(f.state.censusDecodes).toBe(1);
		const native = decodeCanonical(f.frame.maintenanceCapture.censusBytes) as {nativeIssuance: unknown};
		expect(f.state.sources[0].nativeIssuance).toEqual(native.nativeIssuance);
		f.frame.maintenanceCapture.censusBytes.fill(0);
		expect(f.state.sources[0].nativeIssuance).toEqual(native.nativeIssuance);
		expect(f.state.checks).toBe(2); expect(f.state.enrollments).toBe(1);
	});
	it("shares only private captured protected bytes and preserves every original use annotation", async () => {
		const material = [Uint8Array.of(1), Uint8Array.of(2, 3), Uint8Array.of(4, 5, 6)], uses = [
			{protected: true, snapshotScopes: [], nativeReaderRefs: []},
			{protected: false, snapshotScopes: [{epoch: 0}], nativeReaderRefs: []},
			{protected: false, snapshotScopes: [], nativeReaderRefs: [{digest: "native", byteLength: 3}]},
		];
		const f = factory({material, uses}); expect(await f.run()).toBeDefined();
		const captured = f.state.sources[0];
		expect(captured.knownMaterial).toEqual(material); expect(captured.knownMaterialUses).toEqual(uses);
		expect(captured.knownProtectedMaterial).toHaveLength(1);
		expect(captured.knownProtectedMaterial[0]).toBe(captured.knownMaterial[0]);
		expect(captured.knownMaterial[0]).not.toBe(material[0]);
		material[0]!.fill(9); expect(captured.knownProtectedMaterial[0]).toEqual(Uint8Array.of(1));
	});
	it("refuses misaligned material annotations before source or readiness enrollment", async () => {
		const f = factory({material: [Uint8Array.of(1)], uses: []});
		expect(await f.run()).toBeUndefined(); expect(f.state.sources).toHaveLength(0); expect(f.state.enrollments).toBe(0);
	});
	it("joins an admitted witness and refuses revocation before any source delivery", async () => {
		let resume!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => {resume = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
		const f = factory({witness: async () => {entered(); await gate;}});
		const task = f.run(); const outcome = task.catch(error => error); await started;
		expect(f.frame.pending.size).toBe(1); f.state.available = false; resume();
		expect(await outcome).toBeInstanceOf(Error); expect(f.state.enrollments).toBe(0); expect(f.frame.pending.size).toBe(0);
	});
	it("propagates failed final native currency instead of delivering a captured source", async () => {
		const f = factory({final: async () => {throw Error("native-currentness-failed");}});
		await expect(f.run()).rejects.toThrow("native-currentness-failed");
		expect(f.state.enrollments).toBe(0); expect(f.frame.pending.size).toBe(0);
		expect(f.state.runtimeEnrollments).toBe(0);
		expect(f.frame.maintenanceCapture.receivedRecoveryScopes).toBeUndefined(); expect(f.state.lookups).toBe(1);
		// A failed compound read cannot turn its earlier absence observation into
		// positive enrollment. Exact retry must perform the original lookup again.
		expect(await f.run()).toBeDefined(); expect(f.state.lookups).toBe(2);
		expect(f.frame.maintenanceCapture.receivedRecoveryScopes).toEqual([]);
	});
	it("refuses callback revocation and a final-check release race without enrolling readiness", async () => {
		const during = factory({staged: () => {during.state.available = false;}});
		await expect(during.run()).rejects.toThrow("source-revoked"); expect(during.state.enrollments).toBe(0);
		const after = factory({final: async () => {queueMicrotask(() => {after.frame.alive = false;});}});
		await expect(after.run()).rejects.toThrow("source-revoked"); expect(after.state.enrollments).toBe(0);
	});
	it("still delivers an unprepared source only after fresh final currency on numerical decline", async () => {
		const f = factory(); f.state.preparation = false;
		expect(await f.run()).toBeDefined(); expect(f.state.checks).toBe(2); expect(f.state.enrollments).toBe(0);
		expect(f.events).toEqual(["full-1", "witness", "staged", "full-2", "runtime-enroll"]);
	});
	it("keeps the real numerical preparation tail uncommitted and runs diagnostics before enrollment", () => {
		const body = declaration("prepareCreatorOrdinarySourceReadinessForSizing");
		const start = body.indexOf("const preparedApplication =");
		expect(start).toBeGreaterThan(0);
		const events: string[] = [], sourceFacts = {identity: {}, capacity: {} as Record<string, unknown>};
		const enroll = execute<() => void>(`(() => {${body.slice(start, body.lastIndexOf("}"))}})();`, {
			source: sourceFacts, application: {reader: {}}, derived: {commit: () => {events.push("program");}}, geometry: {},
			options: {reader: {}}, windowLimits: undefined, windowApplication: undefined, windowObservation: undefined,
			selectedWindow: {limits: {}}, preparation: {current: {runtime: {epoch: 2}}},
			globalThis: {__warmProofEvent: () => {events.push("observer");}},
		});
		expect(events).toEqual(["observer"]); expect(sourceFacts.capacity).toEqual({});
		enroll(); expect(events).toEqual(["observer", "program"]);
		expect(sourceFacts.capacity.application).toEqual({reader: {}}); expect(sourceFacts.capacity.readiness).toBeDefined();
	});
});

describe("readiness-local journal geometry ownership", () => {
	function fixture(sql: boolean) {
		const current = anchorMaterial(2), selected = current.scope, digest = "b".repeat(64);
		const preimage = encodeCanonical({fixture: "already authenticated PRE"});
		const header = sql ? {object_id: selected.objectId, epoch: selected.epoch, anchor_digest: selected.anchorDigest,
			next_journal_sequence: 1, exact_anchor_preimage: current.bytes, detached_anchor_signature: current.install.detachedAnchorSignature,
			parameters_digest: Buffer.from(hashDomain("ts-drp/parameters/v3", current.install.exactCanonicalParametersCarrierBytes)).toString("hex"),
			exact_parameters_carrier: current.install.exactCanonicalParametersCarrierBytes} : {...selected, nextJournalSequence: 1,
			exactCanonicalAnchorPreimageBytes: current.bytes, detachedAnchorSignature: current.install.detachedAnchorSignature,
			parametersDigest: Buffer.from(hashDomain("ts-drp/parameters/v3", current.install.exactCanonicalParametersCarrierBytes)).toString("hex"),
			exactCanonicalParametersCarrierBytes: current.install.exactCanonicalParametersCarrierBytes};
		const row = sql ? {object_id: selected.objectId, epoch: selected.epoch, anchor_digest: selected.anchorDigest, journal_sequence: 0,
			source_kind: "received", vertex_digest: digest, local_author: null, local_author_sequence: null,
			received_preimage: preimage, received_signature: new Uint8Array(64)} : {...selected, journalSequence: 0, sourceKind: "received",
			vertexDigest: digest, exactCanonicalPreimageBytes: preimage, detachedSignature: new Uint8Array(64)};
		const canonicalRows = [journalRetirementCanonicalRow("scopes", [selected.objectId, selected.epoch, selected.anchorDigest], header),
			journalRetirementCanonicalRow(sql ? "accepted_entries" : "acceptedEntries", [selected.objectId, selected.epoch, selected.anchorDigest, 0], row)];
		const journal = {control: null, canonicalRows, image: journalRetirementImage([header], [row])};
		const sourceFacts: any = {identity: {}, nativeIssuance: {rows: {}}, journal, capacity: {}};
		const preparation: any = {current: {runtime: {objectId: selected.objectId, epoch: selected.epoch, anchorDigest: selected.anchorDigest, graphVersion: 0},
			blueprint: {maxApplicationStateBytes: 16384, maxItems: 4096, maxDepth: 8}, currentEpochVertexCount: 2,
			currentSignedPreimageByteLengths: [preimage.byteLength], successorFenceCount: 0}, nativeCapacity: {runtimeWidths: {}}, cursor: {}};
		const frame = {alive: true, accounting: {}, headerConsumersRevoked: false};
		const state = {projections: 0, checks: 0, refuseFinal: false, programCommitted: false, compiled: undefined as any};
		const footprint = {byteLength: 16384, items: 4096, maxDepth: 8};
		const reader = Object.assign(() => undefined, {createIncrementalProjection: () => ({advance: () => true,
			quote: () => footprint, quoteWithoutApplicationCandidate: () => footprint})});
		const prepare = execute<(...args: any[]) => Promise<(() => void) | undefined>>(
			`${declaration("creatorOrdinaryJournalObservationCorresponds")}\n${declaration("prepareCreatorOrdinarySourceReadinessForSizing")}\nprepareCreatorOrdinarySourceReadinessForSizing;`, {
			creatorOrdinaryApplicationResourceMaterialForSizing: () => ({catalog: {}, material: {exactCanonicalBaseStateBytes: [encodeCanonical({value: 0})],
				currentOperations: [], protectedOperations: [], recoveryOperations: []}}),
			canonicalCarrierResourceForSizing,
			LIVE_JOURNAL_RETIREMENT_LIMITS,
			canonicalBytesResourceForSizing: (length: number) => canonicalCarrierResourceForSizing(encodeCanonical(new Uint8Array(length)), 128),
			canonicalValueResourceForSizing: (value: unknown) => canonicalCarrierResourceForSizing(encodeCanonical(value), 128),
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
			prepareJournalOrdinaryFinishingCapacityProjection: (input: Parameters<typeof prepareJournalOrdinaryFinishingCapacityProjection>[0]) => {
				state.projections++; return prepareJournalOrdinaryFinishingCapacityProjection(input);
			},
			proofMaterialOwners: new WeakMap([[frame.accounting, {captureKnownResourceTotals: () => ({knownBytes: 0, protectedBytes: 0, unknownEncodedBytes: 0})}]]),
			creatorOrdinaryFinishingLifetimeMaterialForSizing: () => ({}), createCreatorNoneResourceProgramCompiler: () => ({}),
			buildCreatorOrdinaryFinishingResourceProgramForSizing: (input: any) => {
				state.compiled = input.capture; expect(sourceFacts.capacity).toEqual({});
				return {program: {}, commit: () => {state.programCommitted = true;}};
			},
			creatorIssuanceMaintenanceObservationCarriers: (input: any) => [input.journal],
			maintenanceWidthSum: (values: number[]) => values.reduce((sum, value) => sum + value, 0),
		});
		return {state, sourceFacts, selected, preparation, journal, run: () => prepare(sourceFacts, preparation, frame,
			{journal, snapshot: {}, ahe: {}, floorImage: {}, signingRows: []}, {reader}, async () => {
				state.checks++; if (state.refuseFinal && state.checks === 3) throw Error("final original currency refused");
			})};
	}
	it("compiles and enrolls the same once-validated projector and frame capture for both native encodings", async () => {
		for (const sql of [false, true]) {
			const f = fixture(sql), enroll = await f.run(); expect(enroll).toBeTypeOf("function");
			expect(f.state.projections).toBe(1); expect(f.state.checks).toBe(3);
			expect(f.state.compiled.journalFrames).toHaveLength(2);
			expect(f.state.programCommitted).toBe(false); expect(f.sourceFacts.capacity).toEqual({});
			enroll!(); expect(f.state.programCommitted).toBe(true);
			expect(f.sourceFacts.capacity.readiness.geometry.journal).toBe(f.state.compiled.preparedJournal);
			const input = {canonicalPreimageByteLength: 512, canonicalAuthorByteLength: 67, successorAnchorByteLength: 512,
				parametersByteLength: f.state.compiled.preparedJournal.parametersBytes.byteLength, closedMembershipByteLength: 1024};
			expect(f.state.compiled.preparedJournal.projection.quote(input)).toEqual(journalOrdinarySchemaFinishingCapacityWidths({
				...input, actualCanonicalRows: f.journal.canonicalRows, currentScope: f.selected}));
		}
	});
	it("does not publish the shared geometry or program after final currency refuses", async () => {
		const f = fixture(true); f.state.refuseFinal = true;
		await expect(f.run()).rejects.toThrow("final original currency refused");
		expect(f.state.projections).toBe(1); expect(f.state.programCommitted).toBe(false);
		expect(f.sourceFacts.capacity).toEqual({});
	});
	it("uses prepared geometry in the real compiler while the unprepared path retains full public validation", () => {
		const body = declaration("buildCreatorOrdinaryFinishingResourceProgramForSizing"), tree = ts.createSourceFile("builder.ts", body, ts.ScriptTarget.Latest, true);
		const declarations: ts.VariableStatement[] = [];
		const visit = (node: ts.Node): void => {if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
			ts.isIdentifier(d.name) && (d.name.text === "journalInput" || d.name.text === "journal"))) declarations.push(node); ts.forEachChild(node, visit);}; visit(tree);
		expect(declarations).toHaveLength(2);
		const code = `(() => {${declarations.map(node => node.getText(tree)).join("\n")}return journal;})();`;
		const f = fixture(true), projection = prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.journal.canonicalRows, currentScope: f.selected});
		let publicCalls = 0, preparedCalls = 0;
		const bindings = {capture: {journal: f.journal, preparedJournal: {projection: {quote: (input: any) => {preparedCalls++; return projection.quote(input);}}}},
			runtime: {...f.selected, issuanceScope: {author: "writer"}}, primitive: () => ({byteLength: 8}), preimage: 512, fencePreimage: 0,
			parametersBytes: new Uint8Array(64), artifacts: {anchor: {byteLength: 512}}, membership: {byteLength: 1024}, current: {successorFenceCount: 0},
			journalOrdinarySchemaFinishingCapacityWidths: (input: any) => {publicCalls++; return journalOrdinarySchemaFinishingCapacityWidths(input);}};
		const prepared = execute(code, bindings); expect(preparedCalls).toBe(1); expect(publicCalls).toBe(0);
		const plain = execute(code, {...bindings, capture: {journal: f.journal}}); expect(publicCalls).toBe(1); expect(plain).toEqual(prepared);
		const altered = {...f.journal, canonicalRows: [Uint8Array.of(0), ...f.journal.canonicalRows.slice(1)]};
		expect(() => execute(code, {...bindings, capture: {journal: altered}})).toThrow();
	});
});

describe("acquisition-job exact parsing reuse is never current authority", () => {
	function acquisitionOwner() {
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxFile = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const transitionPath = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const transitionFile = ts.createSourceFile(transitionPath.pathname, readFileSync(transitionPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (file: ts.SourceFile, name: string) => {
			const nodes = file.statements.filter((node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (nodes.length !== 1) throw Error(`PRIVATE_ACQUISITION_HELPER:${name}:${nodes.length}`);
			return nodes[0]!.getText(file).replace(/^export /, "");
		};
		const selector = extract(transitionFile, "uniqueCreatorTransitionCandidate").replace("record(candidate)", "transitionRecord(candidate)");
		let decodes = 0, objectCopies = 0;
		const observedObject = new Proxy(Object, {get(target, key) {
			if (key === "create") return (prototype: object | null) => {objectCopies++; return Object.create(prototype);};
			return Reflect.get(target, key);
		}});
		const owner = execute<{record(bytes: Uint8Array): Readonly<Record<string, unknown>>;
			canonicalSelection(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined;
			unique(closure: {closure: {digest: string; byteLength: number}[]; candidates: {ref: {digest: string; byteLength: number}; bytes: Uint8Array}[]}, kind: string, epoch?: number): {bytes: Uint8Array};
			candidate(candidates: {ref: {digest: string; byteLength: number}; bytes: Uint8Array}[], kind: string, epoch?: number, phase?: string): {bytes: Uint8Array} | undefined;
			release(): void}>(`
			${extract(syntaxFile, "canonicalCreatorDataRecord")}
			${extract(syntaxFile, "createCreatorCanonicalSyntaxReader")}
			${extract(transitionFile, "createCreatorRecoveryEvidenceOwner")}
			${extract(transitionFile, "createCreatorSnapshotRecoveryEvidenceJob")}
			${extract(transitionFile, "record").replace("function record(", "function transitionRecord(")}
			${extract(transitionFile, "candidateSelection").replace("record(candidate)", "transitionRecord(candidate)")}
			${selector}
			${extract(transitionFile, "exactCreatorTransitionOccurrence")}
			${["unique", "record", "anchorOf", "createCreatorClosedAcquisitionSyntax"].map(declaration).join("\n")}
			createCreatorClosedAcquisitionSyntax();`, {
			AHE_BOUNDED_READ_LIMITS, Object: observedObject, compareBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
			decodeCanonical: (bytes: Uint8Array) => {decodes++; return decodeCanonical(bytes);},
			sameRef: (a: {digest: string; byteLength: number}, b: {digest: string; byteLength: number}) => a.digest === b.digest && a.byteLength === b.byteLength,
			requireLaw: (ok: unknown) => { if (!ok) throw Error("chain-invalid"); },
		});
		return {owner, decodes: () => decodes, objectCopies: () => objectCopies};
	}
	function closure() {
		const candidates = [
			{kind: "drp-anchor-trust-state", currentEpoch: 3, objectId: "room", floor: {current: "anchor", pending: null}},
			{kind: "drp-hard-epoch-cut", epoch: 2, dependencies: Array(64).fill("a".repeat(64)), PRE: new Uint8Array(8192)},
			{kind: "drp-seal-qc", epoch: 2, phase: "commit", signers: Array(64).fill("b".repeat(64)), signature: new Uint8Array(64)},
		].map(value => {const bytes = encodeCanonical(value), ref = digestBlob(bytes); if (!ref.ok) throw Error("FIXTURE_DIGEST");
			return {bytes, ref: {digest: ref.value, byteLength: bytes.byteLength}};});
		return {candidates, closure: candidates.map(value => value.ref)};
	}
	it("parses an unchanged bounded closure once across many lookups and an assembly await", async () => {
		const f = acquisitionOwner(), c = closure();
		for (let stage = 0; stage < 3; stage++) {
			for (let i = 0; i < 12; i++) {
				expect(f.owner.unique(c, "drp-anchor-trust-state", 3)).toBe(c.candidates[0]);
				expect(f.owner.unique(c, "drp-hard-epoch-cut", 2)).toBe(c.candidates[1]);
				expect(f.owner.unique(c, "drp-seal-qc", 2)).toBe(c.candidates[2]);
				f.owner.record(c.candidates[1]!.bytes);
			}
			await Promise.resolve();
		}
		expect(f.decodes()).toBe(3);
		const accounting = createCreatorClosedRollbackProofAccounting([]);
		for (const candidate of c.candidates) expect(accounting.charge(candidate.bytes)).toBe(true);
		for (const unknown of [17, 17]) expect(accounting.chargeUnknownEncodedLength(unknown)).toBe(true);
		expect(accounting.chargedBytes).toBe(c.candidates.reduce((sum, candidate) => sum + candidate.bytes.length, 34));
		f.owner.release();
		const before = f.decodes(); f.owner.record(c.candidates[1]!.bytes); f.owner.record(c.candidates[1]!.bytes);
		expect(f.decodes() - before).toBe(2); // Deferred currency consumers fall back, not retain a job cache.
	});
	it("detaches parsed outputs and reparses exact mutable-byte changes across an await", async () => {
		const f = acquisitionOwner(), c = closure(), candidate = c.candidates[0]!;
		const value = f.owner.record(candidate.bytes); (value.floor as Record<string, unknown>).current = "tampered-output";
		expect(f.owner.record(candidate.bytes).floor).toEqual({current: "anchor", pending: null});
		await Promise.resolve();
		const changed = encodeCanonical({...decodeCanonical(candidate.bytes) as object, currentEpoch: 4});
		expect(changed.length).toBe(candidate.bytes.length); candidate.bytes.set(changed);
		expect(f.owner.candidate(c.candidates, "drp-anchor-trust-state", 3)).toBeUndefined();
		expect(f.owner.candidate(c.candidates, "drp-anchor-trust-state", 4)).toBe(candidate);
		expect(f.decodes()).toBe(4);
		f.owner.release();
	});
	it("canonical scalar scans avoid whole-value copies while full consumers remain detached", () => {
		const f = acquisitionOwner(), c = closure();
		for (let i = 0; i < 32; i++) {
			const selected = f.owner.canonicalSelection(c.candidates[1]!.bytes)!;
			expect(Object.isFrozen(selected)).toBe(true); expect(selected.kind).toBe("drp-hard-epoch-cut");
			expect(selected.PRE).toBeUndefined(); expect(selected.dependencies).toBeUndefined();
			f.owner.unique(c, "drp-hard-epoch-cut", 2);
		}
		expect(f.decodes()).toBe(3); expect(f.objectCopies()).toBe(0);
		const full = f.owner.record(c.candidates[1]!.bytes);
		expect(f.objectCopies()).toBeGreaterThan(0); (full.PRE as Uint8Array).fill(99);
		expect((f.owner.record(c.candidates[1]!.bytes).PRE as Uint8Array)[0]).toBe(0);
		f.owner.release();
	});
	it("canonical scalar selection preserves whole-record validity rather than decode-only labels", () => {
		const f = acquisitionOwner();
		for (const value of [{kind: "drp-hard-epoch-cut", epoch: 2, phase: "commit", currentEpoch: 3,
			currentAclDigest: "acl", payload: "normal"}, {kind: "drp-hard-epoch-cut", epoch: 2, payload: "\ufeff"},
			{kind: "\ufeffdrp-hard-epoch-cut", epoch: 2}, ["not-a-record"], null]) {
			const bytes = encodeCanonical(value), full = (() => {try {return f.owner.record(bytes);} catch {return undefined;}})();
			const scalar = f.owner.canonicalSelection(bytes);
			if (full === undefined) expect(scalar).toBeUndefined();
			else expect(scalar).toEqual(Object.fromEntries(["kind", "epoch", "currentEpoch", "phase", "currentAclDigest"].map(key =>
				[key, typeof full[key] === (key === "epoch" || key === "currentEpoch" ? "number" : "string") ? full[key] : undefined])));
		}
		expect(f.owner.canonicalSelection(Uint8Array.of(255))).toBeUndefined();
		f.owner.release();
	});
	it("rechecks expected context, exact occurrence, ambiguity and original selector-versus-roundtrip refusal", () => {
		const f = acquisitionOwner(), c = closure();
		expect(f.owner.unique(c, "drp-anchor-trust-state", 3)).toBe(c.candidates[0]);
		expect(() => f.owner.unique(c, "drp-anchor-trust-state", 4)).toThrow("chain-invalid");
		const duplicate = {...c, closure: [...c.closure, c.closure[0]!]};
		expect(() => f.owner.unique(duplicate, "drp-anchor-trust-state", 3)).toThrow("chain-invalid");
		const other = closure().candidates[0]!;
		expect(() => f.owner.unique({closure: [...c.closure, other.ref], candidates: [...c.candidates, other]}, "drp-anchor-trust-state", 3)).toThrow("chain-invalid");
		for (const bytes of [Uint8Array.of(255), encodeCanonical({kind: "drp-hard-epoch-cut", epoch: 2, value: "\ufeff"})]) {
			const ref = digestBlob(bytes); if (!ref.ok) throw Error("FIXTURE_DIGEST");
			const candidate = {bytes, ref: {digest: ref.value, byteLength: bytes.byteLength}};
			const malformed = {candidates: [candidate], closure: [candidate.ref]};
			// Compare the exact original uncached selector/roundtrip path rather
			// than invent a BOM requirement from the field's visual appearance.
			const baseline = acquisitionOwner(); baseline.owner.release();
			const outcome = (owner: typeof f.owner) => {
				try {return {selected: owner.unique(malformed, "drp-hard-epoch-cut", 2)};}
				catch (error) {return {refusal: (error as Error).message};}
			};
			expect(outcome(f.owner)).toEqual(outcome(baseline.owner));
		}
		f.owner.release();
	});
	it("owns one parser only in acquisition and clears it after all original failed cleanup joins", () => {
		const fn = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "acquireClosedData");
		const creates: ts.CallExpression[] = [], releases: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {if (ts.isCallExpression(node)) {
			if (node.expression.getText(parsed) === "createCreatorClosedAcquisitionSyntax") creates.push(node);
			if (node.expression.getText(parsed) === "parsing.release") releases.push(node);
		} ts.forEachChild(node, visit);}; visit(fn);
		expect(creates).toHaveLength(1); expect(releases).toHaveLength(1);
		const cleanup = fn.body!.statements.find((node): node is ts.TryStatement => ts.isTryStatement(node))!.finallyBlock!;
		const inner = cleanup.statements.find((node): node is ts.TryStatement => ts.isTryStatement(node))!;
		expect(inner.tryBlock.getText(parsed)).toContain("await Promise.allSettled([...frame.pending])");
		expect(inner.finallyBlock!.getText(parsed)).toContain("parsing.release()");
		// This is pure parsing/lifetime coverage. Existing genuine native fixtures
		// must independently prove fresh authentication, floors, acquisition and join.
	});
});

describe("same sizing owner eliminates repeated canonical primitive and evidence-selection passes", () => {
	function widths(values: unknown[], original = false,
		bounds: {maxObjectGenerations: number; maxClosureReferences: number; maxUnionBytes: number} = AHE_BOUNDED_READ_LIMITS) {
		const encodes: unknown[] = [];
		return execute<{widths: number[]; encodes: unknown[]}>(`
			const maintenanceWidthAtom = Symbol("private-test-primitive-width");
			${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceCanonicalWidth",
				"createCreatorMaintenanceSizingSyntax"].map(declaration).join("\n")}
			const owner = createCreatorMaintenanceSizingSyntax();
			({widths: values.map(value => ${original ? "maintenanceCanonicalWidth(value)" : "owner.canonicalWidth(value)"}), encodes});`,
			{values, encodes, AHE_BOUNDED_READ_LIMITS: bounds, createCreatorCanonicalSyntaxReader,
				closedRetirementBytes: (value: unknown) => {encodes.push(value); return encodeCanonical(value);}});
	}
	it("eliminates repeated scalar serialization while preserving complete carriers, mutable bytes and dynamic revisions", () => {
		const shared = {author: "a".repeat(64), sourceProofDigest: "d".repeat(64), phase: "complete",
			protected: ["current", "rollback", "pending", "shared"], PRE: Uint8Array.of(7, 9)};
		const values = Array.from({length: 8}, (_, revision) => ({revision, source: shared,
			complete: Array.from({length: 64}, () => ({...shared, generationSource: shared}))}));
		const before = widths(values, true), after = widths(values);
		expect(after.widths).toEqual(before.widths);
		expect(after.widths.every(width => width > 64 * shared.PRE.length)).toBe(true);
		expect(after.encodes.filter(value => value instanceof Uint8Array)).toHaveLength(before.encodes.filter(value => value instanceof Uint8Array).length);
		expect(after.encodes.length).toBeLessThan(before.encodes.length / 10);
		expect(after.encodes.filter(value => value === "sourceProofDigest")).toHaveLength(1);
		const first = widths([shared]), changed = widths([{...shared, PRE: Uint8Array.of(7, 9, 11)}]);
		expect(changed.widths[0]).toBe(first.widths[0]! + 1); // No object/byte-carrier cache or cross-call fact.
		expect(changed.encodes).toContain("sourceProofDigest");
	});
	it("preserves codec/refusal/node-depth-item rules and uses bounded overflow fallback without byte credit", () => {
		for (const value of [null, true, false, 0, -0, 127, 128, 1.5, "\ufeff", "a\ufeffb", "😀", new Uint8Array()])
			expect(widths([value, value]).widths).toEqual(widths([value, value], true).widths);
		const malformed: unknown[] = [undefined, Symbol("invalid"), NaN, Infinity, BigInt(1), "\ud800", "\udfff"];
		let deep: unknown = 1; for (let i = 0; i < 130; i++) deep = {nested: deep};
		// The original byte ceiling belongs to a COMPLETE carrier sum, not
		// an isolated encoded leaf width. Keep its enclosing ARRAY charge.
		malformed.push(deep, Array(65_537).fill(1), [new Uint8Array(maintenanceProofMaxBytes())]);
		for (const [caseIndex, value] of malformed.entries()) {
			let before: unknown, after: unknown;
			try {widths([value], true);} catch (error) {before = (error as Error).message;}
			try {widths([value]);} catch (error) {after = (error as Error).message;}
			expect(after, `original refusal case ${caseIndex}`).toBe(before);
			expect(after, `original refusal case ${caseIndex}`).toBeDefined();
		}
		const tiny = {...AHE_BOUNDED_READ_LIMITS, maxObjectGenerations: 1, maxClosureReferences: 1, maxUnionBytes: 4};
		const values = ["aa", "b", "b", "aa"];
		const after = widths(values, false, tiny);
		expect(after.widths).toEqual(widths(values, true, tiny).widths);
		expect(after.encodes).toEqual(["aa", "b", "b"]); // Overflow re-encodes; no new admission refusal.
	});
	function supportOwner(original = false) {
		const transitionPath = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const transitionSource = ts.createSourceFile(transitionPath.pathname, readFileSync(transitionPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const matches = transitionSource.statements.filter((node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (matches.length !== 1) throw Error(`PRIVATE_TRANSITION_DECLARATION:${name}:${matches.length}`);
			return matches[0]!.getText(transitionSource).replace(/^export /, "");
		};
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxSource = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const syntax = syntaxSource.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (syntax === undefined) throw Error("PRIVATE_SYNTAX_OWNER_MISSING");
		let decodes = 0;
		const read = execute<(closure: {candidates: {bytes: Uint8Array; ref: {digest: string; byteLength: number}}[]; closure: unknown[]}, epoch: number) => unknown>(`
			${syntax.getText(syntaxSource).replace(/^export /, "")}
			${extract("record")} ${extract("candidateSelection")} ${extract("uniqueCreatorTransitionCandidate")}
			${declaration("closedSigningEvidenceClosureSupport")}
			const syntax = createCreatorCanonicalSyntaxReader();
			(closure, epoch) => closedSigningEvidenceClosureSupport(closure, epoch, ${original ? "undefined" : "syntax"});`,
			{AHE_BOUNDED_READ_LIMITS, decodeCanonical: (bytes: Uint8Array) => {decodes++; return decodeCanonical(bytes);}});
		return {read, decodes: () => decodes};
	}
	const evidenceClosure = () => {
		const records = [{kind: "drp-hard-epoch-cut", epoch: 2}, {kind: "drp-seal-qc", epoch: 2, phase: "commit"},
			{kind: "drp-anchor-trust-state", currentEpoch: 3}, {kind: "game-state", blocks: Array(64).fill({x: 1, y: 2})}];
		const candidates = records.map((record, index) => {const bytes = encodeCanonical(record);
			return {bytes, ref: {digest: index.toString().padStart(64, "0"), byteLength: bytes.length}};});
		return {candidates, closure: candidates.map(candidate => candidate.ref)};
	};
	it("reuses complete candidate parsing for repeated evidence rows without changing uniqueness, scope, phase or mutation refusals", () => {
		const closure = evidenceClosure(), before = supportOwner(true), after = supportOwner();
		for (let signer = 0; signer < 64; signer++) expect(after.read(closure, 2)).toEqual(before.read(closure, 2));
		expect(before.decodes()).toBe(64 * 3 * closure.candidates.length);
		expect(after.decodes()).toBe(closure.candidates.length);
		const duplicate = {...closure, candidates: [...closure.candidates, closure.candidates[0]!]};
		expect(after.read(duplicate, 2)).toBeUndefined(); expect(after.read(duplicate, 2)).toEqual(before.read(duplicate, 2));
		expect(after.read(closure, 1)).toEqual(before.read(closure, 1));
		closure.candidates[1]!.bytes[0] = 255;
		expect(after.read(closure, 2)).toBeUndefined(); expect(after.read(closure, 2)).toEqual(before.read(closure, 2));
		closure.candidates[1]!.bytes = encodeCanonical({kind: "drp-seal-qc", epoch: 2, phase: "prepare"});
		expect(after.read(closure, 2)).toBeUndefined(); expect(after.read(closure, 2)).toEqual(before.read(closure, 2));
		closure.candidates[0]!.bytes = encodeCanonical({kind: "\ufeffdrp-hard-epoch-cut", epoch: 2});
		expect(after.read(closure, 2)).toEqual(before.read(closure, 2)); // BOM remains part of the kind, not stripped.
	});
	it("threads the same bounded owner only through sizing support and retains original authenticated consumers and branch charges", () => {
		const calls: ts.CallExpression[] = [];
		const walk = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "closedSigningEvidenceClosureSupport") calls.push(node);
			ts.forEachChild(node, walk);
		}; walk(parsed);
		expect(calls.filter(call => call.arguments.length === 3).map(call => call.arguments[2]!.getText(parsed))).toEqual(["syntax"]);
		expect(calls.filter(call => call.arguments.length === 2)).toHaveLength(2); // Real content/signature consumers unchanged.
		const declarationNode = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "composeProspectiveCreatorMaintenancePrefixesForSizing");
		expect(declarationNode.parameters[7]!.initializer!.getText(parsed)).toBe("createCreatorMaintenanceSizingSyntax()");
		expect(recursion.arguments[7]!.getText(parsed)).toBe("syntax");
		const bytes = encodeCanonical({fullPRE: "preserved"}), accounting = createCreatorClosedRollbackProofAccounting([]);
		expect(accounting.charge(bytes)).toBe(true);
		for (let occurrence = 0; occurrence < 8; occurrence++) expect(accounting.chargeUnknownEncodedLength(widths(["same"]).widths[0]!)).toBe(true);
		expect(accounting.chargedBytes - bytes.length).toBe(8 * encodeCanonical("same").length);
	});
});

describe("actual CURRENT/FUTURE journal recipe freshly validates complete native facts", () => {
	function fixture(sql = false, count = 0) {
		const current = anchorMaterial(0), successor = anchorMaterial(1);
		const anchor = decodeCanonical(current.bytes) as Record<string, unknown>, author = "d".repeat(64);
		const header = sql ? {object_id: current.scope.objectId, epoch: 0, anchor_digest: current.scope.anchorDigest,
			next_journal_sequence: count, exact_anchor_preimage: current.bytes, detached_anchor_signature: current.install.detachedAnchorSignature,
			parameters_digest: anchor.parametersDigest, exact_parameters_carrier: current.install.exactCanonicalParametersCarrierBytes}
			: {objectId: current.scope.objectId, epoch: 0, anchorDigest: current.scope.anchorDigest, nextJournalSequence: count,
				exactCanonicalAnchorPreimageBytes: current.bytes, detachedAnchorSignature: current.install.detachedAnchorSignature,
				parametersDigest: anchor.parametersDigest, exactCanonicalParametersCarrierBytes: current.install.exactCanonicalParametersCarrierBytes};
		const rows = [encodeCanonical(["scopes", [current.scope.objectId, 0, current.scope.anchorDigest], header])];
		for (let ordinal = 0; ordinal < count; ordinal++) {
			const row = sql ? {object_id: current.scope.objectId, epoch: 0, anchor_digest: current.scope.anchorDigest,
				journal_sequence: ordinal, source_kind: "local-issued", vertex_digest: ordinal.toString(16).padStart(64, "0"),
				received_preimage: null, received_signature: null, local_author: author, local_author_sequence: ordinal}
				: {objectId: current.scope.objectId, epoch: 0, anchorDigest: current.scope.anchorDigest, journalSequence: ordinal,
					sourceKind: "local-issued", vertexDigest: ordinal.toString(16).padStart(64, "0"), localAuthor: author, localAuthorSequence: ordinal};
			rows.push(encodeCanonical([sql ? "accepted_entries" : "acceptedEntries", [current.scope.objectId, 0, current.scope.anchorDigest, ordinal], row]));
		}
		const local = (sequence: number) => ({scope: current.scope, sourceKind: "local-issued" as const, author,
			authorSequence: sequence, vertexDigest: Array.from(hashDomain("test-width", encodeCanonical(sequence)),
				byte => byte.toString(16).padStart(2, "0")).join("")});
		const args: Parameters<typeof journalFutureAppendPostimageWidths> = [rows, local(count),
			{objectId: successor.scope.objectId, exactCanonicalAnchorPreimageBytes: successor.bytes,
				exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes},
			{author, authorSequence: count + 3}, [local(count + 1), local(count + 2)], {control: null, closedMembershipByteLength: 128}];
		return {args, sourceBytes: [current.bytes.slice(), successor.bytes.slice()], capture: {}, input: {},
			census: {nativeRowsByteLength: 127, nested: {order: [1, 2]}}};
	}
	function owner() {
		let calls = 0;
		const recipe = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "journal" && node.initializer !== undefined && ts.isCallExpression(node.initializer) &&
			node.initializer!.expression.getText(parsed) === "journalFutureAppendPostimageWidths" &&
			node.initializer!.getText(parsed).includes("successorJournalAppend")).getText(parsed);
		const reader = createCreatorCanonicalSyntaxReader();
		return {reader, calls: () => calls, run: (f: ReturnType<typeof fixture>, preclose = false) =>
			execute<ReturnType<typeof journalFutureAppendPostimageWidths>>(`const ${recipe}; journal;`, {
				capture: {journal: {canonicalRows: f.args[0], control: f.args[5]?.control}},
				immediateJournalAppend: f.args[1], unsignedJournalSuccessor: f.args[2], successorJournalAppend: f.args[3],
				currentContinuationAppends: f.args[4], preclose, closedMembershipByteLength: f.args[5]?.closedMembershipByteLength,
				received: f.args[5]?.localIssuerBasis === undefined ? undefined : {localIssuerBasis: f.args[5].localIssuerBasis},
				journalFutureAppendPostimageWidths: (...args: Parameters<typeof journalFutureAppendPostimageWidths>) => {
					calls++; return journalFutureAppendPostimageWidths(...args);
				},
			})};
	}
	const outcome = (run: () => unknown) => {try {return {value: run()};} catch (error) {
		return {error: (error as Error).message, cause: (error as Error & {cause?: Error}).cause?.message};}};
	it("validates complete CURRENT separately and freshly computes every FUTURE recipe across cardinality/backend shapes", () => {
		for (const sql of [false, true]) for (const count of [0, 127]) {
			const f = fixture(sql, count), o = owner();
			const currentArgs = [...f.args] as Parameters<typeof journalFutureAppendPostimageWidths>;
			currentArgs[5] = {control: null};
			expect(o.run({...f, args: currentArgs}, true)).toEqual(journalFutureAppendPostimageWidths(...currentArgs));
			const expected = journalFutureAppendPostimageWidths(...f.args), first = o.run(f);
			expect(first).toEqual(expected);
			for (let schedule = 0; schedule < 8; schedule++) {const fresh = o.run(f); expect(fresh).toEqual(first); expect(fresh).not.toBe(first);}
			expect(o.calls()).toBe(10); // Full PRE freshly validated by each original producer invocation.
			expect(Object.isFrozen(first)).toBe(true);
			expect(Object.isFrozen(first.afterLocal.canonicalRowBytes)).toBe(true);
		}
	});
	it("invalidates exact byte, option, source, census, order and incarnation changes without changing original outcomes", () => {
		const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
			f => {f.args[0][0]![0] = 255;},
			f => {f.sourceBytes[0]![0] = f.sourceBytes[0]![0]! ^ 1;},
			f => {f.args[5] = {control: null, closedMembershipByteLength: 127};},
			f => {f.args[5] = {control: undefined};},
			f => {f.census.nested.order.reverse();},
			f => {f.census = {...f.census};}, f => {f.capture = {};}, f => {f.input = {};},
			f => {f.args[4] = [...f.args[4]!].reverse();},
			f => {f.args[3] = {author: "foreign", authorSequence: 3};},
		];
		for (const change of mutations) {
			const f = fixture(), o = owner(); o.run(f); change(f);
			expect(outcome(() => o.run(f))).toEqual(outcome(() => journalFutureAppendPostimageWidths(...f.args)));
			expect(o.calls()).toBe(2);
		}
		const f = fixture(), a = owner(), b = owner();
		a.run(f); b.run(f);
		expect([a.calls(), b.calls()]).toEqual([1, 1]); // No cross-read/cross-acquisition result.
	});
	it("retains original new-byte/refusal semantics including malformed UTF8, BOM, full-PRE byte/item/depth/count limits", () => {
		const malformedString = encodeCanonical("x"); malformedString[malformedString.length - 1] = 255;
		const deep: unknown[] = []; let cursor = deep; for (let i = 0; i < 18; i++) {const child: unknown[] = []; cursor.push(child); cursor = child;}
		const failures = [malformedString, encodeCanonical("\ufeff"), encodeCanonical(["scopes", [], {extra: deep}]),
			encodeCanonical(["scopes", [], {extra: Array(145).fill(1)}]), new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1)];
		for (const bytes of failures) {
			const f = fixture(), o = owner(); o.run(f);
			f.args[0] = [bytes];
			const expected = outcome(() => journalFutureAppendPostimageWidths(...f.args));
			expect(expected).toHaveProperty("error");
			expect(outcome(() => o.run(f))).toEqual(expected);
			expect(outcome(() => o.run(f))).toEqual(expected);
			expect(o.calls()).toBe(3); // A refusal never becomes a reusable numerical fact.
		}
		const f = fixture(), o = owner();
		f.args[0] = Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2 + 1).fill(f.args[0][0]);
		expect(outcome(() => o.run(f))).toEqual(outcome(() => journalFutureAppendPostimageWidths(...f.args)));
	});
	it("keeps original live-frame guards ahead of journal work and carries only syntax through real preclose recursion", () => {
		const f = fixture(), o = owner(), accounting = {}, reader = {}, trust = {};
		const frame = {alive: true, accounting}, ledgers = new Map([[accounting, frame]]);
		const forward = {reader, wholeFloor: {pending: null}, currentTrust: trust}, capture = {currentTrust: trust};
		const guard = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed).includes("capture.currentTrust !== forward.currentTrust") &&
			node.expression.getText(parsed).includes("facts === undefined") &&
			node.expression.getText(parsed).includes("forward.wholeFloor === undefined") && !node.expression.getText(parsed).includes("currentFacts"));
		const inspect = () => execute<any>(`(() => {${guard.getText(parsed)} return effect();})();`,
			{frame, capture, forward, facts: {}, input: {proof: {accounting}}, ledgers, effect: () => o.run(f)});
		expect(inspect()).toEqual(journalFutureAppendPostimageWidths(...f.args));
		frame.alive = false;
		expect(inspect()).toEqual({ok: false, reason: "MAINTENANCE_SOURCE_UNAVAILABLE"});
		frame.alive = true; capture.currentTrust = {};
		expect(inspect()).toEqual({ok: false, reason: "MAINTENANCE_SOURCE_UNAVAILABLE"});
		expect(o.calls()).toBe(1);
		const branch = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(parsed) === "preclose && !adoptionDrain");
		let recurseCalls = 0;
		const known = Uint8Array.of(7, 9), phaseCharges: number[][] = [], observations: unknown[] = [];
		const recurse = () => execute<any>(`(() => {${branch.getText(parsed)}})();`, {
			preclose: true, adoptionDrain: false, conservativeCurrentFuture: false, input: f.input, maintenanceParticipants: [null, null, null, null],
			maintenanceFloor: {}, aheOriginal: {}, futureRows: [], retainedSigningData: [known], sourceEpoch: 0,
			guaranteedSigningFloors: [0], authenticatedMembershipPrefixes: [], syntax: o.reader,
			fullFutureProofEnvelopeByteLengths: [321], composeProspectiveCreatorMaintenancePrefixesForSizing:
				(_input: unknown, _schedule: unknown, _preclose: boolean, controls: {signingPhysicalRows: Uint8Array[]},
					_generation: unknown, _drain: unknown, _memberships: unknown, shared: typeof o.reader) => {
					recurseCalls++; expect(shared).toBe(o.reader);
					const widths = o.run(f);
					const charges = [controls.signingPhysicalRows[0]!.byteLength, 64, 64, widths.afterSuccessor.nativeImageBytes];
					phaseCharges.push(charges); observations.push(widths);
					return {ok: true, knownCarriers: [known], unknownEncodedLengths: [64, 64],
						fullFutureProofEnvelopeByteLengths: [charges.reduce((sum, value) => sum + value, 0)]};
				},
		});
		const first = recurse(), second = recurse();
		expect(second).toEqual(first);
		expect(phaseCharges[1]).toEqual(phaseCharges[0]); expect(observations[1]).toEqual(observations[0]);
		expect(first.unknownEncodedLengths).toEqual([64, 64]);
		expect([recurseCalls, o.calls()]).toEqual([2, 3]); // Every branch keeps full charges and freshly invokes the original journal producer.
	});
});

describe("CURRENT job phases reuse only identical same-schedule journal widths", () => {
	const variables = new Map<string, ts.VariableDeclaration>();
	const variable = (name: string) => {
		let found = variables.get(name);
		if (found === undefined) {
			found = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) && node.name.text === name);
			variables.set(name, found);
		}
		return found;
	};
	const journalReuse = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
		node.expression.getText(parsed) === "currentJobJournal?.jobIndex !== jobIndex");
	const assignment = (journalReuse.thenStatement as ts.ExpressionStatement).expression as ts.BinaryExpression;
	const originalJournal = ((assignment.right as ts.ObjectLiteralExpression).properties.find((node) =>
		ts.isPropertyAssignment(node) && node.name.getText(parsed) === "widths") as ts.PropertyAssignment).initializer.getText(parsed);
	type Phase = { authorSequence: number; phase: string; nativeControlRevisionDelta: number;
		canonicalUnsignedVertexByteLength: number; runtimeCensusOverheadByteLength: number;
		nativeRowsByteLength: number; nativeImageByteLength: number };
	const phases = (jobs = 2): Phase[] => Array.from({length: jobs}, (_, job) =>
		["reserved", "entered", "final"].map((phase, index) => ({authorSequence: job + 10, phase,
			nativeControlRevisionDelta: job * 3 + index + 1, canonicalUnsignedVertexByteLength: 127 + job,
			runtimeCensusOverheadByteLength: 64 + index, nativeRowsByteLength: 255 + index,
			nativeImageByteLength: 511 + index}))).flat();
	function exercise(inputPhases: Phase[] | undefined, original = false, journalFailureAt?: number, seed = 0) {
		const journalCalls: number[] = [], nativeObservations: {width: number; maxBytes: number}[] = [];
		const events: string[] = [], projections: number[] = [];
		const currentContinuationAppends = Array.from({length: Math.ceil((inputPhases?.length ?? 0) / 3)},
			(_, index) => Object.freeze({authorSequence: index + 10}));
		let map = variable("currentJobProofEnvelopeByteLengths").getText(parsed);
		if (original) map = map.replace(journalReuse.getText(parsed), "")
			.replace("currentJobJournal.widths", originalJournal);
		let widths: number[] | undefined, error: string | undefined;
		try {
			widths = execute<number[]>(`
				const maintenanceWidthAtom = Symbol("private-test-current-journal-width");
				${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceCanonicalWidth"].map(declaration).join("\n")}
				const plainWidth = maintenanceCanonicalWidth;
				// The actual compositor's lexical alias (creator-closed-rollback-data.ts)
				// selects unary compiler.measure / syntax.canonicalWidth / capacityWidth.
				// This VM extracts the global two-argument helper instead; restore that
				// original unary call boundary so Array.map's index is not a width callback.
				maintenanceCanonicalWidth = value => plainWidth(value);
				let ${variable("currentJobJournal").getText(parsed)};
				const ${map}; currentJobProofEnvelopeByteLengths;`, {
				currentContinuation: inputPhases === undefined ? undefined : {nativeJobPhases: inputPhases},
				currentContinuationAppends, nativeObservations, AHE_BOUNDED_READ_LIMITS, LIVE_JOURNAL_RETIREMENT_LIMITS,
				capture: {journal: {canonicalRows: Uint8Array.of(seed), control: {revision: seed}}, snapshot: {}, ahe: {},
					floorImage: {}, snapshotInventory: {scopes: [], owner: "owner"}, signingRows: [new Uint8Array(17), new Uint8Array(29)]},
				immediateJournalAppend: {immediate: seed}, unsignedJournalSuccessor: {successor: seed},
				received: {localIssuerBasis: "exact-basis"}, native: {control: {revision: 127}}, remainingIssuanceTransitions: 3,
				forward: {wholeFloor: {floor: seed}}, digest: "a".repeat(64), input: {exactCanonicalUnsignedVertexBytes: Uint8Array.of(7)},
				materialOwner: {projectByteLengths: (bytes: Uint8Array[]) => {projections.push(bytes[0]!.byteLength); return {protected: 101};}},
				birth: (_kind: string, value: unknown) => value,
				advanceJournalRetirementMutationControl: (control: {revision: number}) => ({revision: control.revision + 1}),
				creatorIssuanceMaintenanceObservationCarriers: (value: unknown) => {events.push("observation"); return [value];},
				// Test the actual private phase map and numerical accounting; this fixture
				// supplies journal widths, not native authentication or a complete quote.
				journalFutureAppendPostimageWidths: (rows: Uint8Array, immediate: unknown, successor: unknown, local: unknown,
					appends: unknown[], options: unknown) => {
					journalCalls.push(appends.length); events.push(`journal:${appends.length}`);
					expect([rows, immediate, successor, local, options]).toEqual([Uint8Array.of(seed),
						{immediate: seed}, {successor: seed}, undefined, {control: {revision: seed}, localIssuerBasis: "exact-basis"}]);
					if (appends.length === journalFailureAt) throw new TypeError("original-journal-refusal");
					return {afterLocal: Object.freeze({scopeCount: 1, rowCount: appends.length + 1,
						nativeImageBytes: 128 + appends.length + seed, canonicalRowsBytes: 127 + appends.length + seed})};
				},
			});
		} catch (cause) { error = (cause as Error).message; }
		return {widths, error, journalCalls, nativeObservations, events, projections};
	}
	it("replaces three complete journal computations per job with one while retaining all phase charges", () => {
		const before = exercise(phases(), true), after = exercise(phases());
		expect(after.error).toBeUndefined();
		expect(after.widths).toEqual(before.widths);
		expect(after.nativeObservations).toEqual(before.nativeObservations);
		expect(after.projections).toEqual(before.projections);
		expect(before.journalCalls).toEqual([0, 0, 0, 1, 1, 1]);
		expect(after.journalCalls).toEqual([0, 1]);
		expect(after.widths).toHaveLength(6);
		expect(after.nativeObservations).toHaveLength(12);
		expect(after.projections).toHaveLength(6); // Full PRE is charged independently at every phase.
	});
	it("preserves malformed later-phase validation before journal or subsequent phase effects", () => {
		for (const index of [0, 1, 2, 3, 4, 5]) {
			for (const field of ["phase", "nativeControlRevisionDelta", "canonicalUnsignedVertexByteLength", "nativeImageByteLength"] as const) {
				const input = phases();
				if (field === "phase") input[index]![field] = "foreign";
				else input[index]![field] = 0;
				const before = exercise(input, true), after = exercise(input);
				expect(after.error).toBe(before.error);
				expect(after.error).toBeDefined();
				expect(after.nativeObservations).toEqual(before.nativeObservations);
				expect(after.projections).toEqual(before.projections);
				expect(after.journalCalls).toHaveLength(Math.ceil(index / 3));
			}
		}
	});
	it("keeps original journal refusal and discards numeric results between schedules and captures", () => {
		const before = exercise(phases(), true, 1), after = exercise(phases(), false, 1);
		expect(after.error).toBe("original-journal-refusal");
		expect(after.error).toBe(before.error);
		expect(after.nativeObservations).toEqual(before.nativeObservations);
		expect(after.events.filter(value => value === "observation")).toHaveLength(3);
		const first = exercise(phases()), next = exercise(phases(), false, undefined, 128);
		expect(first.journalCalls).toEqual([0, 1]);
		expect(next.journalCalls).toEqual([0, 1]);
		expect(next.widths).toEqual(exercise(phases(), true, undefined, 128).widths);
		expect(next.widths).not.toEqual(first.widths);
		expect(exercise(undefined).journalCalls).toEqual([]);
		expect(exercise(undefined).widths).toEqual([]);
	});
});

describe("AHE metadata width reuses the same synchronous complete control measurement", () => {
	function exercise(control: unknown, original = false) {
		const calls: unknown[] = [], widths: number[] = [], nativeImages: { width: number; maxBytes: number }[] = [];
		const variable = (name: string) => unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === name).getText(parsed);
		let meta = variable("aheStorageMetaWidth"), owner = variable("aheControlsFor");
		if (original) {
			// The exact original duplicated pass, kept here as a deterministic
			// reference—not a different resource/charge/authorization policy.
			meta = meta.replace("encodedControlWidth: number", "control: Readonly<Record<string, unknown>>")
				.replace("maintenanceEncodedBytes(encodedControlWidth)", "maintenanceEncodedBytes(maintenanceCanonicalWidth(control))");
			owner = owner.replace("aheStorageMetaWidth(encoded)", "aheStorageMetaWidth(control)");
		}
		return execute<{ calls: unknown[]; widths: number[]; nativeImages: { width: number; maxBytes: number }[] }>(`
			const maintenanceWidthAtom = Symbol("private-test-ahe-width");
			${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceEncodedBytes",
				"maintenanceCanonicalWidth"].map(declaration).join("\n")}
			const originalWidth = maintenanceCanonicalWidth;
			maintenanceCanonicalWidth = value => { calls.push(value); return originalWidth(value); };
			const ${variable("widthAppender")}; const ${variable("nativeObserver")};
			const ${meta}; const ${owner};
			aheControlsFor(widths, nativeImages)(control); ({calls, widths, nativeImages});`,
			{ control, calls, widths, nativeImages, objectId: "room", lHead: { epoch: 4, revision: 127 },
				digest: "a".repeat(64), AHE_BOUNDED_READ_LIMITS });
	}
	it("eliminates one full control walk but preserves logical charge and both complete native observations", () => {
		for (const revision of [0, 127, 128, 16_384]) {
			const control = { kind: "ahe-retirement-control-3", revision, active: null,
				completed: { generationDrain: { source: { rows: [{ completePRE: new Uint8Array(4097),
					protected: ["current", "rollback", "pending", "shared"] }] }, phase: "complete" } } };
			const before = exercise(control, true), after = exercise(control);
			expect(after.widths).toEqual(before.widths);
			expect(after.nativeImages).toEqual(before.nativeImages);
			expect(after.widths).toEqual([encodeCanonical(control).byteLength]);
			expect(before.calls.filter(value => value === control)).toHaveLength(2);
			expect(after.calls.filter(value => value === control)).toHaveLength(1);
			expect(after.nativeImages).toHaveLength(2); // Native BYTES row and original whole logical-control wrapper remain distinct.
		}
	});
	it("keeps the original first-pass malformed, item, depth and complete-wrapper refusals", () => {
		let nested: unknown = null;
		for (let i = 0; i < 128; i++) nested = [nested];
		const tooDeep = [[nested]];
		for (const control of [undefined, {bad: undefined}, nested, tooDeep,
			Array.from({length: 65_536},()=>null), Array.from({length: 65_527},()=>null)]) {
			const reason = (original: boolean) => { try { exercise(control, original); return null; }
				catch (error) { return (error as Error).message; } };
			expect(reason(false)).toBe(reason(true));
			expect(reason(false)).not.toBeNull();
		}
	});
	it("does not reuse an old control after its native revision or protected content changes", () => {
		const original = { revision: 127, completed: { protected: ["one"], fullPRE: Uint8Array.of(7) } };
		const changed = { revision: 128, completed: { protected: ["one", "two"], fullPRE: Uint8Array.of(7, 9) } };
		const first = exercise(original), second = exercise(changed);
		expect(second.widths[0]).toBeGreaterThan(first.widths[0]!);
		expect(second.widths).toEqual(exercise(changed, true).widths);
		expect(second.calls.filter(value => value === changed)).toHaveLength(1);
	});
});

describe("invariant maintenance source widths stay invocation-local", () => {
	const fields = ["summary", "floor", "rows", "snapshots", "snapshotImage", "journalImage"] as const;
	const sourceFields = () => ({ summary: { cuts: [{ epoch: 3, bytes: Uint8Array.of(7, 9) }] },
		floor: { stable: { epoch: 4 }, pending: null }, rows: [{ closure: ["a", "b"] }],
		snapshots: [{ scope: { epoch: 3 }, incarnation: "native" }],
		snapshotImage: { scopeCount: 1, scopes: [{ epoch: 3 }] },
		journalImage: { rowCount: 4, byteCharge: 127 }, cut: 128 });
	function prepare(input: ReturnType<typeof sourceFields>) {
		const calls: unknown[] = [];
		return execute<{ read: () => Record<string, number>; dynamic: (value: unknown) => number; calls: unknown[] }>(`
			const maintenanceWidthAtom = Symbol("private-test-source-width");
			${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceCanonicalWidth",
				"createMaintenanceSourceWidthReader"].map(declaration).join("\n")}
			const originalWidth = maintenanceCanonicalWidth;
			maintenanceCanonicalWidth = value => { calls.push(value); return originalWidth(value); };
			({ read: createMaintenanceSourceWidthReader(input), dynamic: maintenanceCanonicalWidth, calls });`,
			{ input, calls, AHE_BOUNDED_READ_LIMITS });
	}
	it("measures unchanged complete containers once while retaining every source and unknown occurrence charge", () => {
		const input = sourceFields(), prepared = prepare(input);
		expect(prepared.calls).toEqual([]); // No eager bounds/refusal before the original use.
		const expected = { ...Object.fromEntries(fields.map(field => [field, encodeCanonical(input[field]).byteLength])), cut: input.cut };
		const unknown = [257, 257, 64];
		const quoted: number[][] = [];
		for (const schedule of [[], [1], [2], [1, 2], [3], [1, 2, 3]]) {
			const actual = prepared.read();
			expect(actual).toEqual(expected);
			expect(Object.isFrozen(actual)).toBe(true);
			const dynamic = { revision: 127 + schedule.length, entries: schedule,
				fullPRE: new Uint8Array(129 + schedule.length) };
			const measuredDynamic = prepared.dynamic(dynamic);
			const widths = readCreatorClosedRetirementSourceCarrierWidthsForSizing({ ...actual as any,
				journalHeaders: measuredDynamic, signingDetails: measuredDynamic, summarySource: measuredDynamic });
			const original = readCreatorClosedRetirementSourceCarrierWidthsForSizing({ ...expected as any,
				journalHeaders: encodeCanonical(dynamic).byteLength, signingDetails: encodeCanonical(dynamic).byteLength,
				summarySource: encodeCanonical(dynamic).byteLength });
			expect(widths).toEqual(original);
			quoted.push([...widths, ...unknown]); // Equal unknown reservations remain separate, unchanged charges.
		}
		for (const field of fields) expect(prepared.calls.filter(value => value === input[field])).toHaveLength(1);
		expect(prepared.calls).toHaveLength(6 + 6); // Six invariant passes, six still-fresh dynamic passes.
		expect(quoted.every(values => values.slice(-3).join(",") === "257,257,64")).toBe(true);
	});
	it("preserves the first-use field order, canonical refusal and original item/depth limits", () => {
		for (const [index, field] of fields.entries()) {
			const input = { ...sourceFields(), [field]: undefined } as ReturnType<typeof sourceFields>;
			const prepared = prepare(input);
			expect(prepared.calls).toEqual([]);
			expect(() => prepared.read()).toThrow("undefined is outside the canonical domain");
			expect(prepared.calls).toEqual(fields.slice(0, index + 1).map(name => input[name]));
		}
		let nested: unknown = null;
		for (let depth = 0; depth < 130; depth++) nested = [nested];
		for (const invalid of [nested, Array.from({ length: 65_536 }, () => null)]) {
			const prepared = prepare({ ...sourceFields(), summary: invalid } as ReturnType<typeof sourceFields>);
			expect(() => prepared.read()).toThrow("creator maintenance carrier nesting is invalid");
			expect(prepared.calls).toHaveLength(1);
		}
	});
	it("creates fresh scalar facts for a different CURRENT/FUTURE source and keeps currency gates in every schedule", () => {
		const current = prepare(sourceFields()), futureInput = sourceFields();
		futureInput.summary.cuts.push({ epoch: 4, bytes: Uint8Array.of(11, 13, 17) });
		const future = prepare(futureInput);
		expect(current.read().summary).not.toBe(future.read().summary);
		expect(current.calls).toHaveLength(6);
		expect(future.calls).toHaveLength(6);
		const evaluator = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "evaluateSchedule").getText(parsed);
		const selected = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "branchSourceWidths");
		expect(selected.initializer?.getText(parsed)).toBe("readBranchSourceWidths()");
		for (const gate of ["!frame.alive", "frames.get(forward.reader) !== frame", "ledgers.get(frame.accounting) !== frame", "frame.maintenanceCapture !== capture"])
			expect(evaluator.indexOf(gate)).toBeLessThan(evaluator.indexOf("const branchSourceWidths"));
	});
});

describe("healthy row-only journal drain header currency", () => {
	const equal = (plan: unknown, expected: unknown): boolean => execute(
		`${declaration("closedRetirementEqual")}\n${declaration("closedJournalDrainHeadersEqual")}\nclosedJournalDrainHeadersEqual(plan, expected);`,
		{ plan, expected }
	);
	it("compares the native row-only absent pair without changing canonical undefined semantics", () => {
		expect(() => encodeCanonical(undefined)).toThrow("undefined is outside the canonical domain");
		expect(equal({ baseControl: {}, sourceImage: {}, prefixes: [] }, undefined)).toBe(true);
		expect(equal({ retiredEmptyHeaders: [], protectedHeaderScopes: [] }, undefined)).toBe(false);
		expect(equal({}, { retiredEmptyHeaders: [], protectedHeaderScopes: [] })).toBe(false);
	});
	it("requires both exact present arrays and refuses partial, undefined, null and accessor substitutes", () => {
		const scope = { objectId: "room", epoch: 2, anchorDigest: "a".repeat(64) };
		const selection = { retiredEmptyHeaders: [{ scope, exactCanonicalNativeFrameBytes: Uint8Array.of(1, 2) }],
			protectedHeaderScopes: [{ ...scope, epoch: 3 }] };
		expect(equal(structuredClone(selection), selection)).toBe(true);
		for (const plan of [{ retiredEmptyHeaders: selection.retiredEmptyHeaders },
			{ protectedHeaderScopes: selection.protectedHeaderScopes },
			{ retiredEmptyHeaders: undefined, protectedHeaderScopes: undefined },
			{ retiredEmptyHeaders: null, protectedHeaderScopes: null }]) {
			expect(equal(plan, selection)).toBe(false);
			expect(equal(plan, undefined)).toBe(false);
		}
		let getterCalls = 0;
		const accessor = Object.defineProperties({}, {
			retiredEmptyHeaders: { enumerable: true, get: () => { getterCalls++; return selection.retiredEmptyHeaders; } },
			protectedHeaderScopes: { enumerable: true, get: () => { getterCalls++; return selection.protectedHeaderScopes; } },
		});
		expect(equal(accessor, selection)).toBe(false);
		expect(getterCalls).toBe(0);
		const changed = structuredClone(selection);
		changed.retiredEmptyHeaders[0]!.exactCanonicalNativeFrameBytes[0] = 9;
		expect(equal(changed, selection)).toBe(false);
		changed.retiredEmptyHeaders[0]!.exactCanonicalNativeFrameBytes[0] = 1;
		changed.protectedHeaderScopes[0]!.anchorDigest = "b".repeat(64);
		expect(equal(changed, selection)).toBe(false);
	});
	it("uses the same presence-aware comparison at all three original drain currency guards", () => {
		const calls: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
				node.expression.text === "closedJournalDrainHeadersEqual") calls.push(node);
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		expect(calls).toHaveLength(3);
		expect(source).not.toContain("closedRetirementEqual(state.plan.retiredEmptyHeaders, source.journalHeaders?.retiredEmptyHeaders)");
	});
});

describe("prospective summary schedules perform each distinct branch once", () => {
	it("retains exact bounded width diagnostics without increasing the proof entitlement", () => {
		const limit = maintenanceProofMaxBytes();
		const sum = (values: number[]) => execute<number>(
			`${declaration("maintenanceWidthSum")}\nmaintenanceWidthSum(values, "test-envelope");`, {values});
		expect(sum([limit - 2, 2])).toBe(limit);
		expect(() => sum([limit - 2, 3, 5])).toThrow(
			`creator maintenance carrier exceeds its original proof bound:test-envelope:${limit + 6}/${limit};carriers=3;largest=${limit - 2},5,3`);
		expect(() => sum([-1])).toThrow("creator maintenance carrier exceeds its original proof bound");
		expect(() => sum([Number.MAX_SAFE_INTEGER + 1])).toThrow("creator maintenance carrier exceeds its original proof bound");
	});
	const schedules = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
		node.expression.getText(parsed) === "summaryEpochSchedule === undefined");
	function run(epochs: readonly number[], generation: boolean, fault?: "refusal" | "known-identity") {
		const calls: string[] = [];
		const result = execute<any>(`(() => { ${schedules.getText(parsed)} })();`, {
			summaryEpochSchedule: undefined, summaryEntries: epochs.map(epoch => ({ key: ["room", epoch] })),
			bodyRows: generation ? Array.from({length: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations}) : [],
			AHE_BOUNDED_READ_LIMITS, input: {}, preclose: false, precloseControls: undefined, adoptionDrain: false,
			authenticatedMembershipPrefixes: [], syntax: createCreatorCanonicalSyntaxReader(),
			prospectiveEvidencePrefixOnly: () => false,
			maintenanceWidthSum: (values: number[]) => values.reduce((sum, value) => sum + value, 0),
			evaluateSchedule: (schedule: number[], direct: boolean) => {
				const key = `${direct ? "GEN" : "SUMMARY"}:${schedule.join(",")}`;
				calls.push(key);
				if (fault === "refusal" && direct) return {ok: false, reason: "required-generation-refusal"};
				// Equal unknown occurrences remain separate charges. Generation is
				// a distinct legitimate alternative, never merged with empty SUMMARY.
				const width = direct ? 999 : 100 + schedule.reduce((sum, epoch) => sum + epoch, 0);
				return {ok: true, knownCarriers: [new Uint8Array([fault === "known-identity" && direct ? 2 : 1])],
					unknownEncodedLengths: [width, width], fullFutureProofEnvelopeByteLengths: [width * 3]};
			},
		});
		return {result, calls};
	}
	it("eliminates repeated singleton/prefix schedules without losing any distinct complete bound", () => {
		for (const epochs of [[], [1], [1, 2], [1, 2, 3, 4]]) for (const generation of [false, true]) {
			const {result, calls} = run(epochs, generation);
			const expected = new Set(["SUMMARY:", ...(generation ? ["GEN:"] : [])]);
			for (let last = 0; last < epochs.length; last++) {
				expected.add(`SUMMARY:${epochs[last]}`);expected.add(`SUMMARY:${epochs.slice(0, last + 1).join(",")}`);
				for (let next = last + 1; next < epochs.length; next++)
					expected.add(`SUMMARY:${[...epochs.slice(0, last + 1), epochs[next]].join(",")}`);
			}
			expect(calls).toHaveLength(expected.size);
			expect(new Set(calls)).toEqual(expected);
			const maximum = generation ? 999 : 100 + epochs.reduce((sum, epoch) => sum + epoch, 0);
			expect(result).toMatchObject({ok: true, unknownEncodedLengths: [maximum * 2], fullFutureProofEnvelopeByteLengths: [maximum * 3]});
		}
	});
	it("keeps generation refusal and known-carrier identity checks on every distinct schedule", () => {
		for (const fault of ["refusal", "known-identity"] as const)
			expect(run([1, 2], true, fault).result).toEqual({ok: false, reason: "MAINTENANCE_SUMMARY_CONTINUATION_UNAVAILABLE" +
				(fault === "refusal" ? ":generation[]:required-generation-refusal" : ":generation[]:MAINTENANCE_KNOWN_BRANCH_IDENTITY")});
	});
});

describe("prepared maintenance common facts keep branch ownership", () => {
	const copySeed = <T>(value: T, atom: symbol): T => execute(
		`${declaration("copyProspectiveMaintenanceBranchSeeds")}\ncopyProspectiveMaintenanceBranchSeeds(value);`,
		{ value, maintenanceWidthAtom: atom, maintenanceEncodedWidth: execute(`${declaration("maintenanceEncodedWidth")}\nmaintenanceEncodedWidth;`, {maintenanceWidthAtom: atom, AHE_BOUNDED_READ_LIMITS}) });
	it("detaches every mutable seed while preserving only intra-branch plan aliases and frozen widths", () => {
		const atom = Symbol("private-test-width");
		const unknownWidth = Object.freeze({ [atom]: 17 });
		const plan = { rows: [{ key: ["room", 2], pre: Uint8Array.of(7, 9) }], unknownWidth };
		const seed = {
			unknown: [17, 17, 23], immediate: [4], closeAdoptTransitions: [8],
			nativeObservations: [{ width: 64, maxBytes: 128 }], known: [Uint8Array.of(11, 13)],
			preparations: [{ protectedEpochs: [0, 2] }],
			maintenanceParticipants: [{ revision: 3, drain: { plan } }],
			aheOriginal: { completed: { generationDrain: { source: plan } } },
			maintenanceFloor: { revision: 5, completed: { protectedEpochs: [0, 2] } },
			retainedSigningData: [Uint8Array.of(19, 21)], futureSnapshotTurnoverPending: true,
		};
		const common = copySeed(seed, atom), first = copySeed(common, atom);
		expect(first.maintenanceParticipants[0]!.drain.plan).toBe(first.aheOriginal.completed.generationDrain.source);
		expect(first.maintenanceParticipants[0]!.drain.plan).not.toBe(plan);
		expect(first.maintenanceParticipants[0]!.drain.plan.unknownWidth).toBe(unknownWidth);
		first.unknown.splice(0, 1); first.immediate.push(99); first.closeAdoptTransitions.push(99);
		first.nativeObservations[0]!.width = 1; first.known[0]!.fill(0);
		first.preparations[0]!.protectedEpochs.pop(); first.maintenanceParticipants[0]!.revision = 99;
		first.maintenanceParticipants[0]!.drain.plan.rows[0]!.pre.fill(0);
		first.maintenanceFloor.revision = 99; first.maintenanceFloor.completed.protectedEpochs.pop();
		first.retainedSigningData[0]!.fill(0); first.futureSnapshotTurnoverPending = false;
		const second = copySeed(common, atom);
		expect(second).toEqual(seed);
		expect(common).toEqual(seed);
		expect(second.unknown).toEqual([17, 17, 23]); // Unknown occurrences are not deduplicated.
		expect(second.maintenanceParticipants[0]!.drain.plan).toBe(second.aheOriginal.completed.generationDrain.source);
		expect(second.maintenanceParticipants[0]!.drain.plan).not.toBe(first.maintenanceParticipants[0]!.drain.plan);
	});
	it("does not copy callbacks, accessors, or prototype-bearing owners into private sizing state", () => {
		const atom = Symbol("private-test-width");
		class Owner { readonly authority = true; }
		for (const value of [{ callback: () => 1 }, { owner: new Owner() },
			Object.defineProperty({}, "held", { get: () => { throw new Error("getter invoked"); }, enumerable: true })])
			expect(() => copySeed(value, atom)).toThrow(/maintenance branch seed/);
	});
	it("prepares only derived seeds and evaluates schedules locally without composer re-entry", () => {
		const seed = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "commonBranchSeeds");
		const captured = (seed.initializer as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression;
		expect(captured.properties.map(property => property.name!.getText(parsed))).toEqual([
			"unknown", "immediate", "closeAdoptTransitions", "nativeObservations", "known", "preparations",
			"maintenanceParticipants", "aheOriginal", "maintenanceFloor", "retainedSigningData", "futureSnapshotTurnoverPending",
		]);
		const include = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "includeSchedule");
		expect(include.getText(parsed)).toContain("evaluateSchedule(schedule, directGeneration)");
		expect(include.getText(parsed)).not.toContain("composeProspectiveCreatorMaintenancePrefixesForSizing(");
		const evaluator = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "evaluateSchedule");
		expect(evaluator.getText(parsed)).toContain("copyProspectiveMaintenanceBranchSeeds(commonBranchSeeds, compiler)");
		for (const gate of ["!frame.alive", "frames.get(forward.reader) !== frame", "ledgers.get(frame.accounting) !== frame",
			"frame.maintenanceCapture !== capture", "forward.wholeFloor.pending !== null", "capture.currentTrust !== forward.currentTrust"])
			expect(evaluator.getText(parsed)).toContain(gate);
		// CURRENT completion still enters a separate FUTURE common context with
		// its exact carried controls/rows. It is not another schedule of this tuple.
		expect(recursion.expression.getText(parsed)).toBe("composeProspectiveCreatorMaintenancePrefixesForSizing");
		expect(continuationDeclaration.getText(parsed)).toContain("signingPhysicalRows: retainedSigningData");
	});
});

describe("received turnover keeps complete native future quarantine", () => {
	const pair = (epoch: number) => ({scope: {objectId: "room", epoch, anchor: "a".repeat(64), manifestDigest: "b".repeat(64)}, incarnation: `native-${epoch}`});
	const present = (inventory: unknown, snapshot: unknown): boolean => execute(
		`${declaration("closedRetirementEqual")}\n${declaration("completeSnapshotRecoveryInventoryIsPresent")}\ncompleteSnapshotRecoveryInventoryIsPresent(inventory, snapshot, head);`,
		{inventory, snapshot, head: {objectId: "room", epoch: 4, currentAnchorDigest: "a".repeat(64)}});
	it("accepts all four exact recovery pairs plus a still-protected incoming physical scope", () => {
		const old = [0, 1, 2, 3].map(pair), incoming = pair(4);
		expect(present({scopes: old}, {image: {scopeCount: 5, scopes: [...old, incoming]}})).toBe(true);
		const preparation = {throughEpoch: 3, decisionDigest: "d".repeat(64), sourceProofDigest: "e".repeat(64), protectedScopes: old};
		const control = {kind: "snapshot-retirement-control-1" as const, objectId: "room", incarnation: "native-control", revision: 1, sequence: 1, active: null, completed: preparation};
		// The original native floor admits this exact future scope without a
		// future hole. Neither its bytes nor its identity are retired by the fence.
		expect(snapshotRetirementContract.allows(control, incoming.scope, incoming.incarnation)).toBe(true);
	});
	it("refuses missing or changed recovery identities and an incomplete physical count", () => {
		const old = [0, 1, 2, 3].map(pair);
		expect(present({scopes: old}, {image: {scopeCount: 4, scopes: [...old.slice(1), pair(4)]}})).toBe(false);
		expect(present({scopes: old}, {image: {scopeCount: 4, scopes: old.map(row => row.scope.epoch === 0 ? {...row, incarnation: "changed"} : row)}})).toBe(false);
		expect(present({scopes: old}, {image: {scopeCount: 4, scopes: [...old, pair(4)]}})).toBe(false);
	});
	it("refuses unknown older scopes and foreign-object staging instead of silently omitting them", () => {
		const old = [0, 1, 2, 3].map(pair);
		const unknownOld = {...pair(2), scope: {...pair(2).scope, manifestDigest: "f".repeat(64)}};
		const foreign = {...pair(4), scope: {...pair(4).scope, objectId: "foreign"}};
		for (const extra of [unknownOld, foreign])
			expect(present({scopes: old}, {image: {scopeCount: 5, scopes: [...old, extra]}})).toBe(false);
	});
});

function row(store: string, epoch: number, signer = "alice", payload = epoch): Uint8Array {
	return encodeCanonical([store, ["room", epoch, signer], { payload }]);
}

describe("issuance journal postimages stay native-point bounds, not current proof acquisitions", () => {
	const postimages = unique((node): node is ts.ForOfStatement => ts.isForOfStatement(node) &&
		node.statement.getText(parsed).includes("const wrapperWidth = maintenanceCanonicalWidth({"));
	const nativeGuard = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
		node.expression.getText(parsed) === "exhaustedNative !== undefined");
	it("keeps every complete journal postimage width without inventing an issuance-frame read", () => {
		const immediate = [101]; // An unrelated genuine immediate unknown remains charged.
		const nativeObservations: {width: number; maxBytes: number}[] = [];
		const phase = (rowCount: number) => ({ scopeCount: 3, rowCount, nativeImageBytes: 900 + rowCount,
			canonicalRowsBytes: 300 + rowCount });
		const capacity = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "journalCapacityFor").getText(parsed);
		execute(`const capacityDimensions = undefined; const ${capacity}; ${postimages.getText(parsed)}`, {
			journal: { afterLocal: phase(4), afterSuccessor: phase(5), afterSuccessorLocal: phase(6) },
			journalAfterLocalControl: { revision: 10 }, journalAfterSuccessorControl: { revision: 11 },
			finalJournalControl: { revision: 12 }, digest: "d".repeat(64), immediate, nativeObservations,
			maintenanceEncodedWidth: (width: number) => new Uint8Array(width),
			maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
			LIVE_JOURNAL_RETIREMENT_LIMITS,
		});
		expect(immediate).toEqual([101]);
		expect(nativeObservations).toEqual([4,5,6].map((rowCount, index) => ({width: encodeCanonical({
			control: { revision: 10 + index },
			image: { imageDigest: "d".repeat(64), scopeCount: 3, rowCount, byteCharge: 900 + rowCount },
			canonicalRows: new Uint8Array(300 + rowCount),
		}).byteLength, maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes})));
		// This executes the original routing/constructor, not native lifetime or
		// complete forecast conformance. The affected persistent-worker test owns that evidence.
	});
	it("refuses each native postimage against its own finite owner entitlement", () => {
		const inspect = (nativeObservations: {width: number; maxBytes: number}[]) => execute<{ok: boolean; reason?: string}>(
			`function inspect() { const exhaustedNative = nativeObservations.find(({width,maxBytes}) => width > maxBytes);
				${nativeGuard.getText(parsed)} return {ok:true}; } inspect();`,
			{ nativeObservations, AHE_BOUNDED_READ_LIMITS }
		);
		for (const maxBytes of [AHE_BOUNDED_READ_LIMITS.maxUnionBytes, LOCAL_WORKLOAD_CAPACITY.journalImageBytes]) {
			expect(inspect([{width: maxBytes, maxBytes}])).toEqual({ok:true});
			expect(inspect([{width: maxBytes + 1, maxBytes}])).toEqual({ok:false,
				reason:`MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:${maxBytes + 1}/${maxBytes}`});
		}
	});
	it("reports the complete refused future envelope without changing its entitlement", () => {
		const futureGuard = unique((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(parsed) === "fullFutureProofEnvelopeByteLengths.some((width) => width > CREATOR_MAINTENANCE_PROOF_MAX_BYTES)");
		const limit = maintenanceProofMaxBytes();
		const inspect = (fullFutureProofEnvelopeByteLengths: number[]) => execute<{ok: boolean; reason?: string}>(
			`function inspect() { ${futureGuard.getText(parsed)} return {ok:true}; } inspect();`,
			{ fullFutureProofEnvelopeByteLengths }
		);
		expect(inspect([limit - 1, limit])).toEqual({ok:true});
		expect(inspect([limit, limit + 1, limit - 1])).toEqual({ok:false,
			reason:`MAINTENANCE_FUTURE_PROOF_ENVELOPE_EXHAUSTED:${limit + 1}/${limit}`});
	});
});

describe("CURRENT summary alternatives respect the original signing fence", () => {
	const prior = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) && node.name.text === "priorSigningFloorForSizing");
	const floors = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) && node.name.text === "guaranteedSigningFloors");
	const entries = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) && node.name.text === "summaryEntries" &&
		node.initializer?.getText(parsed).startsWith("signingData.flatMap(") === true);
	const newFrames = unique((node): node is ts.ForOfStatement => ts.isForOfStatement(node) &&
		node.expression.getText(parsed) === "preclose ? [] : signingFrames" &&
		node.statement.getText(parsed).includes("summaryEntries.push"));
	const inspect = (preclose: boolean, evidenceEpochs: number[], completed: unknown = null,
		precloseControls?: {signingProtection: {throughEpoch: number; protectedEpochs: number[]}},
		signingFrames: {store:string;phase:string;key:[string,number,string];canonicalFrameByteLength:number}[] = []) => execute<{
		floors: number[]; epochs: number[]; retainedBytes: number;
	}>(`const ${prior.getText(parsed)}; const ${floors.getText(parsed)}; const ${entries.getText(parsed)}; ${newFrames.getText(parsed)}
		({floors: guaranteedSigningFloors, epochs: summaryEntries.map(entry=>entry.key[1]),
		retainedBytes: signingData.reduce((sum, bytes)=>sum+bytes.byteLength,0)});`, {
		preclose, precloseControls, signingEpochs: [0,1,2,3], evidenceEntries: evidenceEpochs.map(epoch=>({key:["room",epoch,"alice"]})),
		signingOld: {completed}, signingData: [0,1,2,3].map(epoch=>row("signerState",epoch)),
		input: {signingFrames}, signingFrames, digest:"opaque",
		mayReconstructFutureEvidence: () => true, signingRetirementFrameDigest: () => "opaque",
	});
	it("omits impossible protected SUMMARY branches while retaining every physical row", () => {
		const result = inspect(true, [], {throughEpoch:3, protectedEpochs:[0,1,2,3]});
		expect(result.floors).toEqual([0,1,2,3]);
		expect(result.epochs).toEqual([]);
		expect(result.retainedBytes).toBe([0,1,2,3].map(epoch=>row("signerState",epoch)).reduce((sum,bytes)=>sum+bytes.byteLength,0));
	});
	it("keeps potentially drained evidence epochs and previously unprotected epochs", () => {
		expect(inspect(true, [1], {throughEpoch:2, protectedEpochs:[0,1]}).epochs).toEqual([1,2]);
		expect(inspect(true, [1]).epochs).toEqual([1]);
	});
	it("leaves uncorrelated FUTURE alternatives unchanged", () => {
		expect(inspect(false, []).epochs).toEqual([0,1,2,3]);
	});
	it("carries only guaranteed CURRENT protections into the correlated successor", () => {
		const controls = {signingProtection: {throughEpoch:2, protectedEpochs:[0,1]}};
		expect(inspect(false, [], null, controls).epochs).toEqual([2]);
		// A potential new evidence drain keeps its SUMMARY continuation, even if
		// the preceding CURRENT episode protected that epoch.
		expect(inspect(false, [1], null, controls).epochs).toEqual([1,2]);
	});
	it("applies the same fence to newly finalized successor rows without dropping their physical widths", () => {
		const controls = {signingProtection: {throughEpoch:2, protectedEpochs:[0,1]}};
		const frames: {store:string;phase:string;key:[string,number,string];canonicalFrameByteLength:number}[] =
			["signerState","voteSlots","voteOutbox"].map(store=>({store,phase:"commit-qc-committed",
				key:["room",3,"alice"],canonicalFrameByteLength:900}));
		expect(inspect(false, [], null, controls, frames).epochs).toEqual([2]);
		expect(frames.map(frame=>frame.canonicalFrameByteLength)).toEqual([900,900,900]);
		// Potential evidence eligibility still keeps all three new descriptors.
		expect(inspect(false, [3], null, controls, frames).epochs).toEqual([2,3,3,3,3]);
	});
	it("guaranteed protections are a subset of the original native preparation for every potential drain subset", () => {
		const completed = {throughEpoch:2, protectedEpochs:[0,1]};
		const guaranteed = inspect(true, [1,2], completed).floors;
		for (const actual of [[], [1], [2], [1,2]]) {
			const native = execute<number[]>(`const ${nativeSigningProtection.getText(parsed)}; protectedEpochs;`, {
				signingData: [0,1,2,3].map(epoch=>encodeCanonical(["signerState",["room",epoch,"alice"],{epoch}])),
				source: {signingDetails:actual.map(epoch=>({key:["room",epoch,"alice"]}))},
				cut: {epoch:3}, priorSigning: completed,
				requireLaw: (condition:boolean) => {if(!condition)throw Error("native-signing-input");},
			});
			expect(guaranteed.every(epoch=>native.includes(epoch))).toBe(true);
		}
	});
});

describe("inherited early-current maintenance trigger", () => {
	const required = (epoch: number, generationCount: number, recoveryScopes: number, throughEpoch?: number): boolean =>
		execute<boolean>(`${declaration("currentCreatorMaintenanceRequiresSnapshotReceiptCapture")}\ncurrentCreatorMaintenanceRequiresSnapshotReceiptCapture(generationCount, owner, completed, epoch);`, {
			AHE_BOUNDED_READ_LIMITS, epoch, generationCount,
			owner: { recoveryScopes, limits: { maxRecoveryScopes: 4 } },
			completed: throughEpoch === undefined ? null : { throughEpoch, domains: [] },
		});
	it("does not invent mature turnover from first-successor metadata completion", () => {
		expect(required(1, 1, 1, 0)).toBe(false);
		expect(required(2, 1, 1, 1)).toBe(true);
		expect(required(2, 1, 1, 0)).toBe(false);
		expect(required(2, 1, 1)).toBe(false);
	});
	it("preserves both native pressure triggers even before mature transfer exists", () => {
		for (const epoch of [0, 1, 2]) {
			expect(required(epoch, 1, 4)).toBe(true);
			expect(required(epoch, AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 1, 1)).toBe(true);
			expect(required(epoch, AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 2, 3)).toBe(false);
		}
	});
});

describe("inherited early-current activation checkpoint", () => {
	const livePath = new URL("../src/v3-live.ts", import.meta.url);
	const liveParsed = ts.createSourceFile(livePath.pathname, readFileSync(livePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const checkpoints: ts.VariableDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "resumeCheckpoint") checkpoints.push(node);
		ts.forEachChild(node, visit);
	};
	visit(liveParsed);
	const checkpoint = checkpoints[0];
	if (checkpoints.length !== 1 || checkpoint === undefined) throw new Error("ORIGINAL_ACTIVATION_CHECKPOINT_NOT_UNIQUE");
	const halted = (epoch: number, retirementControl: unknown): boolean => execute<boolean>(
		`const ${checkpoint.getText(liveParsed)}; resumeCheckpoint;`,
		{ retirementControl, material: { successor: { trust: { currentEpoch: epoch } } } }
	);
	it("does not mistake completed early classification for mature retirement resumption", () => {
		expect(halted(1, { active: null, completed: { throughEpoch: 0, domains: [] } })).toBe(false);
		expect(halted(2, { active: null, completed: { throughEpoch: 1, domains: [] } })).toBe(true);
		expect(halted(2, { active: null, completed: { throughEpoch: 0, domains: [] } })).toBe(false);
		expect(halted(2, { active: null, completed: { throughEpoch: 1 } })).toBe(false);
	});
	it("keeps active retirement checkpoints halted at every supported early boundary", () => {
		for (const epoch of [0, 1, 2]) {
			expect(halted(epoch, { active: {}, completed: null })).toBe(true);
			expect(halted(epoch, { active: null, completed: null })).toBe(false);
			expect(halted(epoch, null)).toBe(false);
		}
	});
});

describe("R8 recorded strict86 forecast boundary", () => {
	const recorded = JSON.parse(readFileSync(new URL("./fixtures/r8-recorded-forecast-boundary.json", import.meta.url), "utf8")) as {
		limit: number;
		branches: readonly {
			protectedBytes: number;
			unknownWidths: readonly number[];
			sourceAndCoordinatorWidths: readonly number[];
			generationCostWidths: readonly number[];
			refusedValues: readonly number[];
			prefixBeforeRefusal: number;
			incoming: number;
			complete: number;
		}[];
	};
	const checkedSum = (values: readonly number[], limit: number = AHE_BOUNDED_READ_LIMITS.maxUnionBytes): number => execute<number>(
		`${declaration("maintenanceWidthSum")}\nmaintenanceWidthSum(values);`,
		{ AHE_BOUNDED_READ_LIMITS: { ...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: limit }, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: limit, values }
	);
	it("preserves the recorded old refusal and admits both complete vectors under the revised entitlement", () => {
		expect(recorded.limit).toBe(262144);
		expect(AHE_BOUNDED_READ_LIMITS.maxUnionBytes).toBe(786432);
		expect(recorded.branches).toHaveLength(2);
		for (const branch of recorded.branches) {
			const candidate = checkedSum(branch.generationCostWidths);
			const rebuilt = [branch.protectedBytes, ...branch.unknownWidths,
				...branch.sourceAndCoordinatorWidths, candidate];
			expect(rebuilt).toEqual(branch.refusedValues);
			expect(checkedSum(rebuilt.slice(0, -1))).toBe(branch.prefixBeforeRefusal);
			expect(candidate).toBe(branch.incoming);
			expect(rebuilt.reduce((total, width) => total + width, 0)).toBe(branch.complete);
			expect(branch.complete).toBeGreaterThan(recorded.limit);
			expect(() => checkedSum(rebuilt, recorded.limit)).toThrow("creator maintenance carrier exceeds its original proof bound");
			expect(checkedSum(rebuilt)).toBe(branch.complete);
		}
		// Warm native metadata-only lifetime: complete observed category charges,
		// not an EVID measurement or a heap bound. Keep the former refusal causal.
		const warmNative = [56290, 48541, 5035, 41941, 57776, 1877, 553, 34984, 2, 7726, 1053, 19615];
		expect(warmNative.reduce((total, width) => total + width, 0)).toBe(275393);
		expect(() => checkedSum(warmNative, 270336)).toThrow();
		expect(checkedSum(warmNative)).toBe(275393);
		// Complete CURRENT reservation and conservative future allowance are
		// distinct from that completed native lifetime; neither refunds charges.
		expect(checkedSum([296484, 60349])).toBe(356833);
		expect(checkedSum([435208])).toBe(435208);
		// The larger workload refused an immediate CURRENT reservation before
		// crypto: the final complete after-local carrier is distinct from OLD.
		// This is attempted reserve, not consumed native bytes or peak memory.
		const contestedCurrent = [335152, 11645, 4969, 93559];
		expect(() => checkedSum(contestedCurrent, 442368)).toThrow();
		expect(checkedSum(contestedCurrent)).toBe(445325);
		// Original two-rollover continuation's complete conservative forecast.
		expect(checkedSum([459241])).toBe(459241);
		expect(655360 - 459241).toBe(196119); // Historical640KiB headroom.
		// Original32 first E3 ordinary source: complete SUMMARY[3] continuation,
		// not merely the first direct-GEN refusal (466327). The later native
		// diagnostic stopped at the next adoption CURRENT reservation before GEN;
		// preserve that distinction and all unknown debt, not a heap/GEN pass.
		expect(() => checkedSum([508975], 459776)).toThrow();
		expect(checkedSum([508975])).toBe(508975);
		expect(655360 - 508975).toBe(146385); // Historical640KiB headroom.
		const nextAdoptionCurrent = [344995, 16617, 104290];
		expect(() => checkedSum(nextAdoptionCurrent, 459776)).toThrow();
		expect(checkedSum(nextAdoptionCurrent)).toBe(465902);
		// Diagnostic35 reached the original E5 CURRENT reservation, not a
		// completed seal. Preserve its old refusal and its complete forecast.
		// This policy covers those vectors, not every newly admitted workload.
		const e5Current = [395125, 13149, 5060, 133650];
		expect(checkedSum(e5Current)).toBe(546984);
		expect(() => checkedSum(e5Current, 524288)).toThrow();
		expect(() => checkedSum([571093], 524288)).toThrow();
		expect(checkedSum([571093])).toBe(571093);
		expect(655360 - 571093).toBe(84267); // Historical640KiB headroom.
		expect(checkedSum([AHE_BOUNDED_READ_LIMITS.maxUnionBytes])).toBe(AHE_BOUNDED_READ_LIMITS.maxUnionBytes);
		expect(() => checkedSum([AHE_BOUNDED_READ_LIMITS.maxUnionBytes, 1])).toThrow();
	});
	it("attributes the complete sum without dropping PRE or giving equal unknown lengths identity credit", () => {
		for (const [index, branch] of recorded.branches.entries()) {
			expect(branch.generationCostWidths).toEqual([10030, 2462, 12943, 10031, 22988, 12272, 12043, 348, 348]);
			// Source, decision, preparation, OLD/PREP/COMP/reclaimed, BOTH readbacks.
			expect(checkedSum(branch.generationCostWidths)).toBe(83465);
			expect(checkedSum(branch.unknownWidths)).toBe(5450);
			expect(checkedSum(branch.sourceAndCoordinatorWidths)).toBe(index === 0 ? 122368 : 122011);
			expect(branch.protectedBytes).toBe(53983);
			// Deliberately omitting PRE would make this recorded vector fit. The
			// expected-refusal oracle must detect that tempting but invalid mutation.
			const withoutPre = [...branch.refusedValues.slice(0, -1), branch.incoming - 22988];
			expect(() => checkedSum(withoutPre, recorded.limit)).not.toThrow();
			expect(() => expect(() => checkedSum(withoutPre, recorded.limit)).toThrow()).toThrow();
			const twoEqualUnknowns = [348, 348];
			expect(checkedSum(twoEqualUnknowns)).toBe(696);
			expect(checkedSum([...new Set(twoEqualUnknowns)])).not.toBe(696);
		}
	});
});
describe("independent native signed-anchor request budget", () => {
	it("admits the complete native envelope while retaining the caller's remaining proof allowance", () => {
		const allowance = (remainingBytes: number): number => execute<number>(
			`${declaration("closedSignedAnchorEnvelopeAllowance")}\nclosedSignedAnchorEnvelopeAllowance(remainingBytes);`,
			{ AHE_BOUNDED_READ_LIMITS, remainingBytes }
		);
		const scope = { objectId: `creator:${"a".repeat(32)}`, epoch: 2, anchorDigest: "b".repeat(64) };
		// The original refusal is causal: a whole-proof entitlement is not a valid
		// request to the independently bounded signed-envelope native reader.
		expect(captureLiveJournalSignedAnchorReadInput({ scope, maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes }).ok).toBe(false);
		for (const remainingBytes of [262144, AHE_BOUNDED_READ_LIMITS.maxUnionBytes]) {
			const maxBytes = allowance(remainingBytes);
			expect(maxBytes).toBe(8192 + 64 + 65536);
			expect(captureLiveJournalSignedAnchorReadInput({ scope, maxBytes }).ok).toBe(true);
		}
		expect(allowance(100)).toBe(100);
		expect(allowance(0)).toBe(0);
	});
});
const rows = Object.freeze([row("sealEvidence", 1), row("signerState", 1), row("voteSlots", 1),
	row("voteOutbox", 1), row("signerState", 2), row("voteSlots", 2), row("signerState", 1, "bob")]);
const entries = rows.flatMap(bytes => {
	const frame = decodeCanonical(bytes) as unknown[];
	return frame[0] === "sealEvidence" ? [] : [{ store: frame[0], key: frame[1], frameDigest: "test-only" }];
});
function residual(input: readonly Uint8Array[], manifest: readonly unknown[]): readonly Uint8Array[] {
	return execute(`${declarationCode}\nclosedSigningSummaryResidualRows(input, manifest);`, { input, manifest });
}
function lifecycle(schedule: readonly number[], generationOnly = false, brokenCarry = false) {
	const before: readonly Uint8Array[][] = [];
	const mutableBefore = before as Uint8Array[][];
	const unknown: number[] = [], events: string[] = [], participants = [{ revision: 4 }, { revision: 5 }, { revision: 6 }, { revision: 7 }];
	const controls = { participants, floor: { revision: 9 }, ahe: { revision: 10 }, generations: [{ id: "survivor" }] };
	const context = {
		signingData: rows, summaryEntries: entries, summaryEpochSchedule: schedule, generationOnly,
		sourceEpoch: 3, guaranteedSigningFloors: [3],
		finalSigningFrames: [], signingEvidencePreparation: { protectedEpochs: [3] },
		evidencePlan: { baseControl: { revision: 3, fullPriorManifest: ["retained-PRE"] } },
		evidenceEntries: [{ key: ["room", 1, "alice"] }], reconstructedJournalControlWidth: 77,
		objectId: "room", digest: "length-only-test-marker", serialStart: 0, unknown,
		maintenanceParticipants: participants, preparation: {}, partition: {}, preparations: [{}, {}, {}, {}],
		maintenanceFloor: controls.floor, aheOriginal: controls.ahe, futureRows: controls.generations, input: {},
		authenticatedMembershipPrefixes: [], syntax: createCreatorCanonicalSyntaxReader(),
		SIGNING_DETAIL_RETIREMENT_BATCH_ROWS: 16,
		maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
		sourcePhysicalWidths: (physical: readonly Uint8Array[]) => { mutableBefore.push([...physical]); events.push("BEFORE"); return physical.map(bytes => bytes.byteLength); },
		signingRetirementStorageMetaRow: (_: string, control: unknown) => ({ key: "control", control }),
		currentMaintenanceDomains: () => ({ capturedBefore: true }),
		advanceMaintenanceParticipants: () => { events.push("OLD/PREP/COMP"); participants[3] = { revision: participants[3]!.revision + 2 }; unknown.push(101); },
		add: (value: unknown) => { events.push("full-carrier"); unknown.push(encodeCanonical(value).byteLength); },
		completeAhe: (control: { revision: number }) => ({ ...control, revision: control.revision + 2 }),
		aheStorageMetaWidth: () => 109,
		signingAheStorageMetaWidth: () => 109,
		signingRetirementDrainFields: (control: Record<string, unknown>, plan: unknown, cursor: number, batches: number) => ({ ...control, drain: { plan, cursor, batches } }),
		signingControls: (control: unknown) => { events.push("terminal/readback"); unknown.push(encodeCanonical(control).byteLength); },
		composeProspectiveCreatorMaintenancePrefixesForSizing: (_input: unknown, _schedule: unknown, _preclose: boolean, tuple: Record<string, unknown>) => tuple,
	};
	const tupleNode = (continuationDeclaration.initializer as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression;
	const carry = tupleNode.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(parsed) === "signingPhysicalRows");
	if (carry === undefined) throw Error("PRIVATE_CARRY_NOT_FOUND");
	const carryWithSeparator = `${carry.getText(parsed)},`;
	if (!continuationDeclaration.getText(parsed).includes(carryWithSeparator)) throw Error("PRIVATE_CARRY_SEPARATOR_NOT_FOUND");
	const declaration = brokenCarry ? continuationDeclaration.getText(parsed).replace(carryWithSeparator, "") : continuationDeclaration.getText(parsed);
	const recurse = `(() => { const ${declaration}; return ${recursion.getText(parsed)}; })()`;
	const code = `${declarationCode}\nlet retainedSigningData = signingData; const summaryFrames = [];\n` +
		`if (${branch.expression.getText(parsed)}) { ${loop.getText(parsed)} }\n` +
		`const tuple = ${recurse}; ({summaryFrames, retainedSigningData, tuple});`;
	const result = execute<{ summaryFrames: number[][]; retainedSigningData: Uint8Array[]; tuple: Record<string, unknown> }>(code, context);
	const nextRows = execute<Uint8Array[]>(`const ${consume.getText(parsed)}; signingData;`, {
		precloseControls: result.tuple, capture: { signingRows: rows }, objectId: "room",
		closedSigningDataRows: (physical: Uint8Array[]) => physical,
	});
	return { ...result, nextRows, before, events, controls, rows };
}

describe("R8 selected SUMMARY postimage affected private runtime controls", () => {
	it("executes exact private declarations and store/key complement without input mutation", () => {
		const original = rows.map(bytes => Uint8Array.from(bytes));
		const selected = entries.filter(entry => (entry.key as unknown[])[1] === 1);
		const result = residual(rows, selected);
		expect(result).toEqual([rows[0], rows[4], rows[5]]);
		expect(rows).toEqual(original);
		expect(Object.isFrozen(result)).toBe(true);
		// Same key but different store cannot remove evidence. Different signer
		// remains unless its exact store/key is selected in the whole group.
		expect(residual(rows, [{ store: "signerState", key: ["room", 1, "alice"] }])).toEqual(rows.filter(bytes => bytes !== rows[1]));
	});
	it("keeps complete BEFORE and prior PRE then passes only the terminal complement to the next SUMMARY source", () => {
		const result = lifecycle([1, 2]);
		expect(result.before[0]).toEqual(rows);
		expect(result.before[1]).toEqual([rows[0], rows[4], rows[5]]);
		expect(result.retainedSigningData).toEqual([rows[0]]);
		expect(result.summaryFrames).toHaveLength(2);
		expect(result.summaryFrames[0]!.slice(0, rows.length)).toEqual(rows.map(bytes => bytes.byteLength));
		expect(result.summaryFrames[0]).toContain(encodeCanonical(["storageMeta", "control", { key: "control", control: { revision: 3, fullPriorManifest: ["retained-PRE"] } }]).byteLength);
		expect(result.events[0]).toBe("BEFORE");
		expect(result.events.indexOf("terminal/readback")).toBeGreaterThan(result.events.indexOf("OLD/PREP/COMP"));
	});
	it("retains EVID and all unselected rows and makes no deletion projection on the direct-GEN branch", () => {
		const summary = lifecycle([1]);
		expect(summary.retainedSigningData).toEqual([rows[0], rows[4], rows[5]]);
		const direct = lifecycle([], true);
		expect(direct.before).toEqual([]);
		expect(direct.retainedSigningData).toEqual(rows);
		expect(direct.tuple.signingPhysicalRows).toEqual(rows);
	});
	it("executes the original recursion call with a paired residual/control/generation tuple and detects missing carry", () => {
		const result = lifecycle([1]);
		expect(result.tuple.signingPhysicalRows).toEqual(result.retainedSigningData);
		expect(result.nextRows).toEqual(result.retainedSigningData);
		expect(result.tuple.generations).toEqual(result.controls.generations);
		expect(result.tuple.participants).toEqual(result.controls.participants);
		expect(result.tuple.floor).toBe(result.controls.floor);
		expect(result.tuple.signingProtection).toEqual({throughEpoch:3, protectedEpochs:[3]});
		expect((result.tuple.ahe as { revision: number }).revision).toBe(12);
		const broken = lifecycle([1], false, true);
		expect(broken.nextRows).toEqual(rows);
		expect(() => expect(broken.nextRows).toEqual(broken.retainedSigningData)).toThrow();
	});
});

const journalReuseCode = declaration("closedJournalRawSourceIsReusable");
const nativeJournalReuse = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "reuseJournalSourceOld"
);
const firstJournalGuard = unique(
	(node): node is ts.IfStatement =>
		ts.isIfStatement(node) && node.expression.getText(parsed) === "reuseJournalSourceOld && !journalSourceOldChecked"
);
const journalPresence = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sourceJournalIsPresent"
);
const journalAdvance = unique(
	(node): node is ts.CallExpression =>
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "advanceMaintenanceParticipants" &&
		node.arguments.length === 2
);
const journalOldChoice = unique(
	(node): node is ts.ForOfStatement =>
		ts.isForOfStatement(node) &&
		node.expression.getText(parsed) ===
			"index === 1 && reuseJournalSourceOld ? [prepared, completed] : [old, prepared, completed]"
);
const initialJournalCompare = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "compareOriginalControl"
);
const rawJournalControl = (
	changes: Record<string, unknown> = {}
): Record<string, unknown> & { completed: { fullPriorDescriptor: string[] } } => ({
	kind: "v3-live-journal-retirement-control-2",
	incarnation: "test-only",
	revision: 7,
	sequence: 3,
	active: null,
	completed: { fullPriorDescriptor: ["unchanged-PRE", "all-entries"] },
	drain: null,
	...changes,
});
function journalQuoteReuse(captured: unknown, correlated: unknown, pass = 0, tuple?: unknown): boolean {
	const reuseArgument = journalAdvance.arguments[1];
	if (reuseArgument === undefined) throw Error("JOURNAL_REUSE_ARGUMENT_MISSING");
	return execute(`${journalReuseCode}\nconst ${journalPresence.getText(parsed)}; ${reuseArgument.getText(parsed)};`, {
		capture: { journal: { control: captured } },
		maintenanceParticipants: [{}, correlated],
		pass,
		precloseControls: tuple,
	});
}
function journalConsumerReuse(control: unknown, changes: Record<string, unknown> = {}): boolean {
	return execute(
		`${declaration("closedRetirementEqual")}\n${journalReuseCode}\nconst ${nativeJournalReuse.getText(parsed)}; reuseJournalSourceOld;`,
		{
			generationPlan: {},
			source: { journalReconstructed: false, journal: { control }, journalPhysical: { control }, ...changes },
		}
	);
}
function journalFirstRead(control: unknown, fresh: unknown, reuse = true): boolean {
	return execute(
		`${declaration("closedRetirementEqual")}\nlet journalSourceOldChecked = false; ${firstJournalGuard.getText(parsed)}; journalSourceOldChecked;`,
		{
			reuseJournalSourceOld: reuse,
			source: { journalPhysical: { control } },
			read: { control: fresh },
			requireLaw: (condition: boolean, reason: string) => {
				if (!condition) throw Error(reason);
			},
		}
	);
}

describe("R8 first GEN exact RAW journal reuse affected controls", () => {
	it("executes first-pass presence and complete inactive/no-drain source equality", () => {
		const control = rawJournalControl();
		expect(journalQuoteReuse(control, control)).toBe(true);
		expect(journalConsumerReuse(control)).toBe(true);
		expect(journalFirstRead(control, decodeCanonical(encodeCanonical(control)))).toBe(true);
	});
	it("retains independent OLD for null birth, active and draining projected sources", () => {
		const born = rawJournalControl({ revision: 0, sequence: 0, completed: null });
		expect(journalQuoteReuse(null, born)).toBe(false);
		expect(journalConsumerReuse(null)).toBe(false);
		for (const control of [
			rawJournalControl({ active: { full: "PRE" } }),
			rawJournalControl({ drain: { plan: { fullPriorDescriptor: ["all"] }, cursor: 1 } }),
		]) {
			expect(journalQuoteReuse(control, control)).toBe(false);
			expect(journalConsumerReuse(control)).toBe(false);
		}
	});
	it("uses only preceding complete tuple or earlier metadata birth as positive presence", () => {
		const born = rawJournalControl({ revision: 2, sequence: 1 });
		expect(journalQuoteReuse(null, born, 0, { participants: [{}, born] })).toBe(true);
		expect(journalQuoteReuse(null, born, 1)).toBe(true);
		expect(journalQuoteReuse(null, null, 1)).toBe(false);
	});
	it("rejects reconstructed or source/physical-different reuse and preserves initial comparison", () => {
		const control = rawJournalControl(),
			different = rawJournalControl({ revision: 8 });
		expect(journalConsumerReuse(control, { journalReconstructed: true })).toBe(false);
		expect(journalConsumerReuse(control, { journal: { control: different } })).toBe(false);
		expect(() =>
			execute(
				`${declaration("closedRetirementEqual")}\nconst ${initialJournalCompare.getText(parsed)}; compareOriginalControl(actual, original);`,
				{ actual: control, original: different, Refusal: Error, failure: () => "source-control-mismatch" }
			)
		).toThrow();
	});
	it("refuses changed first native whole control before reuse or later preparation", () => {
		const control = rawJournalControl(),
			altered = rawJournalControl({ completed: { fullPriorDescriptor: ["different"] } });
		expect(() => journalFirstRead(control, altered)).toThrow("floor-stale");
		expect(journalFirstRead(control, altered, false)).toBe(false);
	});
	it("removes only exactly repeated OLD and retains whole PRE/COMP and every other domain OLD", () => {
		const old = rawJournalControl(),
			prepared = { ...old, revision: 8, active: { prior: old.completed } },
			completed = { ...old, revision: 9, completed: { fullNewDescriptor: ["all", "new"] } };
		const collect = (reuseJournalSourceOld: boolean, index: number): unknown[] => {
			const output: unknown[] = [];
			const fields = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) && node.name.text === "journalNativeCarrierFields");
			const append = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) && node.name.text === "addJournalNativeControl");
			execute(`const ${fields.getText(parsed)}; let reservedJournalPlan;
				const ${append.getText(parsed)}; ${journalOldChoice.getText(parsed)}`, {
				old,
				prepared,
				completed,
				reuseJournalSourceOld,
				index,
				add: (value: unknown) => output.push(value),
				journalRetirementNativeProgressFields, digest: "a".repeat(64),
				maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
			});
			return output;
		};
		expect(collect(true, 1)).toEqual([prepared, completed]);
		expect(collect(false, 1)).toEqual([old, prepared, completed]);
		expect(collect(true, 0)).toEqual([old, prepared, completed]);
		expect(old.completed.fullPriorDescriptor).toEqual(["unchanged-PRE", "all-entries"]);
		// Wrappers and pre/post AHE points are outside this RAW-only choice.
		expect(source.includes("for (const control of [completed, reclaimed])")).toBe(true);
		expect(
			source.includes("maintenanceCanonicalWidth({ control: maintenanceParticipants[0], image: sourceSnapshotImage })")
		).toBe(true);
	});
});

const nativeReaderProjectionGate = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "projectJoinedNativeReader"
);
const nativeReaderProjectionRefs = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "freshNativeRefs"
);
const nativeFreshKnown = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "freshKnownLeaves"
);
function nativeReaderProjection(
	preclose: boolean,
	ordinaryFutureAdvance: boolean,
	bodyRows: readonly unknown[]
): {
	joined: boolean;
	refs: undefined | { digest: string; byteLength: number }[];
} {
	return execute<{ joined: boolean; refs: undefined | { digest: string; byteLength: number }[] }>(
		`const ${nativeReaderProjectionGate.getText(parsed)}; const ${nativeReaderProjectionRefs.getText(parsed)};
		({ joined: projectJoinedNativeReader, refs: freshNativeRefs });`,
		{ preclose, ordinaryFutureAdvance, bodyRows, precloseControls: undefined }
	);
}
type NativeMaterialProjectionTest = {
	accounting: {
		chargedBytes: number;
		charge(bytes: Uint8Array): boolean;
		chargeUnknownEncodedLength(length: number): boolean;
	};
	material: {
		chargeNativeReader(blob: { ref: { digest: string; byteLength: number }; bytes: Uint8Array }): boolean;
		chargeObservation(bytes: Uint8Array): boolean;
		projectByteLengths(
			bytes: Uint8Array[],
			scopes?: unknown[],
			refs?: { digest: string; byteLength: number }[]
		): { whole: number; protected: number };
	};
};
function nativeMaterialOwner(): NativeMaterialProjectionTest {
	return execute<NativeMaterialProjectionTest>(
		`const proofMaterialOwners = new WeakMap(); ${declaration("closedRetirementEqual")}
		${declaration("projectCreatorProofMaterialByteLengths")}
		${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}
		const accounting = createCreatorClosedRollbackProofAccounting([]);
		({ accounting, material: proofMaterialOwners.get(accounting) });`,
		{ AHE_BOUNDED_READ_LIMITS: { maxUnionBytes: 262_144 } }
	);
}
describe("R8 no-CURRENT fresh ordinary reader projection affected controls", () => {
	it("preserves every original reader ref without preceding CURRENT maintenance", () => {
		const owner = nativeMaterialOwner();
		const blobs = [
			{ ref: { digest: "old-a", byteLength: 2 }, bytes: Uint8Array.of(1, 2) },
			{ ref: { digest: "old-b", byteLength: 3 }, bytes: Uint8Array.of(3, 4, 5) },
		] as const;
		for (const blob of blobs) expect(owner.material.chargeNativeReader(blob)).toBe(true);
		expect(owner.accounting.chargeUnknownEncodedLength(7)).toBe(true);
		const bodyRows = [
			{ closure: blobs.map((blob) => blob.ref) },
			{ closure: [blobs[0].ref, { digest: { opaqueFutureWidth: 66 }, byteLength: 9 }] },
		];
		const projection = nativeReaderProjection(false, true, bodyRows);
		expect(projection.joined).toBe(true);
		expect(projection.refs).toEqual([blobs[0].ref, blobs[1].ref, blobs[0].ref]);
		expect(owner.material.projectByteLengths([], [], projection.refs)).toEqual({ whole: 12, protected: 12 });
		expect(owner.accounting.chargedBytes).toBe(12);
	});
	it("changes only the three standalone promotions in the fresh ordinary lifetime", () => {
		const owner = nativeMaterialOwner();
		const unsigned = Uint8Array.of(11),
			superseded = Uint8Array.of(12, 12),
			successorPreimage = Uint8Array.of(13, 13, 13);
		const authenticated = Uint8Array.of(14, 14, 14, 14),
			acl = Uint8Array.of(15, 15, 15, 15, 15);
		for (const bytes of [unsigned, superseded, successorPreimage])
			expect(owner.material.chargeObservation(bytes)).toBe(true);
		const futureKnownLeaves = [authenticated, successorPreimage, acl, unsigned, superseded];
		const leaves = execute<Uint8Array[]>(`const ${nativeFreshKnown.getText(parsed)}; freshKnownLeaves;`, {
			projectFreshOrdinaryMaterial: true,
			projectJoinedNativeReader: true,
			futureAuthenticatedLeaves: [authenticated],
			input: { exactCanonicalCurrentLatchedAclBytes: acl },
			futureKnownLeaves,
		});
		expect(leaves).toEqual([authenticated, acl]);
		const full = owner.material.projectByteLengths(futureKnownLeaves),
			fresh = owner.material.projectByteLengths(leaves);
		expect(full).toEqual({ whole: 15, protected: 15 });
		expect(fresh).toEqual({ whole: 15, protected: 9 });
		expect(owner.accounting.chargedBytes).toBe(6);
		// Current/close/cold material still uses the full positive union.
		expect(owner.material.projectByteLengths(futureKnownLeaves)).toEqual(full);
	});
	it("retains all promotions and reader uses for unsupported or CURRENT tuples", () => {
		const rows = [{ closure: [{ digest: "old", byteLength: 2 }] }] as const;
		expect(nativeReaderProjection(false, false, rows)).toEqual({ joined: false, refs: undefined });
		expect(nativeReaderProjection(true, true, rows)).toEqual({ joined: false, refs: undefined });
		const owner = nativeMaterialOwner(),
			bytes = Uint8Array.of(1, 2);
		expect(owner.material.chargeNativeReader({ ref: rows[0].closure[0], bytes })).toBe(true);
		expect(owner.material.projectByteLengths([])).toEqual({ whole: 2, protected: 2 });
		const fallback = [Uint8Array.of(7), Uint8Array.of(8)];
		for (const [supported, joined] of [
			[false, true],
			[true, false],
		]) {
			expect(
				execute(`const ${nativeFreshKnown.getText(parsed)}; freshKnownLeaves;`, {
					projectFreshOrdinaryMaterial: supported,
					projectJoinedNativeReader: joined,
					futureAuthenticatedLeaves: [],
					input: {},
					futureKnownLeaves: fallback,
				})
			).toBe(fallback);
		}
	});
	it("keeps generic/default and shared-ref dominance without any live refund", () => {
		const owner = nativeMaterialOwner(),
			bytes = Uint8Array.of(4, 5, 6);
		expect(owner.material.chargeNativeReader({ ref: { digest: "first", byteLength: 3 }, bytes })).toBe(true);
		expect(
			owner.material.chargeNativeReader({ ref: { digest: "shared", byteLength: 3 }, bytes: Uint8Array.from(bytes) })
		).toBe(true);
		expect(owner.accounting.chargeUnknownEncodedLength(5)).toBe(true);
		expect(owner.material.projectByteLengths([], [], [{ digest: "shared", byteLength: 3 }])).toEqual({
			whole: 8,
			protected: 8,
		});
		expect(owner.accounting.charge(Uint8Array.from(bytes))).toBe(true);
		expect(owner.material.projectByteLengths([], [], [])).toEqual({ whole: 8, protected: 8 });
		expect(owner.accounting.chargedBytes).toBe(8);
	});
});


const sizingProtectedRecords = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === "protectedRecords" &&
		node.getText(parsed).includes("vertexDigest")
);
const nativeProtectedRecords = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === "protectedRecords" &&
		node.getText(parsed).includes("closedIssuanceProtectedRecordsForRetirement")
);
function issuanceProtectedRecordsForSource(sourceEpoch: number): {
	forecast: unknown;
	native: unknown;
	before: Uint8Array;
	after: Uint8Array;
} {
	// 8f21d1fd: protected records now close over durable rows, whose preimage
	// header must classify (drp-vertex, protocol 3) before any hole is selected.
	const header = { kind: "drp-vertex", protocolMajor: 3 };
	const unsigned = { ...header, objectId: "room", author: "alice", authorSequence: 4, epoch: 5 };
	const issued = [4, 5, 6].map((epoch, index) => ({
		objectId: "room",
		author: "alice",
		authorSequence: index + 1,
		digest: new Uint8Array(32).fill(index + 1),
		canonicalPreimageBytes: encodeCanonical({ ...header, objectId: "room", author: "alice", authorSequence: index + 1, epoch }),
	}));
	const before = encodeCanonical(issued);
	const vertexDigest = "04".repeat(32);
	const forecast = execute(`const ${sizingProtectedRecords.getText(parsed)}; protectedRecords;`, {
		native: { rows: { issued } },
		epoch: 5,
		sourceEpoch,
		unsigned,
		vertexDigest,
		received: undefined,
		currentContinuationAppends: [],
		record: decodeCanonical,
		// 974f78d0/3a28ab80: FUTURE (non-preclose) local work also protects the
		// retained-fence reserve, but only for a successor journal append. This
		// chronology fixture has none, so the reserve contributes no record.
		preclose: sourceEpoch === 4,
		successorJournalAppend: undefined,
		input: {},
		digest: vertexDigest,
		CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE: 2,
	});
	const native = execute(`${declaration("closedIssuanceProtectedRecordsForRetirement")}\nconst ${nativeProtectedRecords.getText(parsed)}; protectedRecords;`, {
		// 8f21d1fd/07252cc7: retirement reads the (possibly restored) issuanceRows
		// and the exact retirement intent labels, not nativeIssuance.rows.
		issuanceRows: {
			issued: [
				...issued,
				{ ...unsigned, digest: new Uint8Array(32).fill(4), canonicalPreimageBytes: encodeCanonical(unsigned) },
			],
			outbox: [],
			plans: [],
		},
		labels: undefined, closeIssuanceRetirementProtectedRecords,
		input: {objectId: "room"}, issuanceControl: null, census: {rows: []},
		source: {journalDetails: {protectedReplayScopes: []}, journalPhysical: {canonicalRows: []}},
		record: decodeCanonical,
		cut: { epoch: sourceEpoch },
		requireLaw: (condition: boolean) => {
			if (!condition) throw Error("native-control-input");
		},
	});
	return { forecast, native, before, after: encodeCanonical(issued) };
}
describe("R8 source-floor issuance metadata chronology affected controls", () => {
	it("CURRENT uses original Cut4 protection while retaining every physical issued input", () => {
		const result = issuanceProtectedRecordsForSource(4);
		expect(result.forecast).toEqual(result.native);
		expect((result.forecast as unknown[]).length).toBe(1);
		expect(result.after).toEqual(result.before);
	});
	it("FUTURE Cut5 includes the original new epoch5 candidate exactly once", () => {
		const result = issuanceProtectedRecordsForSource(5);
		expect(result.forecast).toEqual(result.native);
		expect((result.forecast as unknown[]).length).toBe(3);
		expect(result.after).toEqual(result.before);
	});
	it("the selected protection feeds complete PRE and completed controls without changing the prior descriptor", () => {
		const { forecast, native } = issuanceProtectedRecordsForSource(4);
		const old = { revision: 7, sequence: 3, active: null, completed: { fullPriorDescriptor: ["all", "PRE"] } };
		const controls = (protectedRecords: unknown): unknown[] => {
			const preparation = {
				throughEpoch: 4,
				decisionDigest: "test-only",
				sourceProofDigest: "test-only",
				protectedRecords,
			};
			return [
				old,
				{ ...old, revision: 8, sequence: 4, active: { sequence: 4, preparation } },
				{ ...old, revision: 9, sequence: 4, completed: preparation },
			];
		};
		expect(controls(forecast).map((value) => encodeCanonical(value))).toEqual(
			controls(native).map((value) => encodeCanonical(value))
		);
		expect(old.completed.fullPriorDescriptor).toEqual(["all", "PRE"]);
	});
});

const sizingSigningEpochs = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "signingEpochs"
);
const nativeSigningProtection = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === "protectedEpochs" &&
		node.getText(parsed).includes("priorSigning")
);
function signingEpochsForSource(sourceEpoch: number): { forecast: unknown; native: unknown; unchanged: boolean } {
	const signingData = [0, 4, 5, 6].map((epoch) =>
		encodeCanonical(["signerState", ["room", epoch, "alice"], { epoch }])
	);
	const before = encodeCanonical(signingData);
	const forecast = execute(`const ${sizingSigningEpochs.getText(parsed)}; signingEpochs;`, {
		signingData,
		sourceEpoch,
		epoch: 5,
	});
	const native = execute(`const ${nativeSigningProtection.getText(parsed)}; protectedEpochs;`, {
		signingData,
		source: { signingDetails: [] },
		cut: { epoch: sourceEpoch },
		priorSigning: { throughEpoch: 3, protectedEpochs: [0] },
		requireLaw: (condition: boolean) => {
			if (!condition) throw Error("native-signing-input");
		},
	});
	return {
		forecast,
		native,
		unchanged: Buffer.compare(Buffer.from(before), Buffer.from(encodeCanonical(signingData))) === 0,
	};
}
describe("R8 source-floor signing metadata chronology affected controls", () => {
	it("CURRENT Cut4 does not protect newly admitted epoch5 signing work while retaining its physical bytes", () => {
		const result = signingEpochsForSource(4);
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual([0, 4]);
		expect(result.unchanged).toBe(true);
	});
	it("FUTURE Cut5 keeps the original epoch5 protection and native prior-floor law", () => {
		const result = signingEpochsForSource(5);
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual([0, 4, 5]);
		expect(result.unchanged).toBe(true);
	});
});


const signingAheAbsenceCode = declaration("closedSigningAheAddressAbsentForSizing");
const signingAheWidth = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "signingAheStorageMetaWidth"
);
function signingAheProjection(rows: readonly Uint8Array[], control: unknown): { absent: boolean; width: number } {
	const absent = execute<boolean>(
		`${signingAheAbsenceCode}\nclosedSigningAheAddressAbsentForSizing(rows, "room", control);`,
		{ rows, control }
	);
	const width = execute<number>(`const ${signingAheWidth.getText(parsed)}; signingAheStorageMetaWidth(control);`, {
		signingAheAddressAbsent: absent,
		objectId: "room",
		control,
		maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
		aheStorageMetaWidth: (encodedControlWidth: number) =>
			encodeCanonical([
				"storageMeta",
				"ahe-retirement:room",
				{ key: "ahe-retirement:room", record: new Uint8Array(encodedControlWidth) },
			]).byteLength,
	});
	return { absent, width };
}
const topologyControl = {
	kind: "ahe-retirement-control-3",
	objectId: "room",
	incarnation: "b".repeat(64),
	revision: 7,
	sequence: 3,
	active: null,
	completed: { fullPriorDescriptor: ["all", "PRE"] },
};
const absentAheRow = encodeCanonical(["storageMeta", "ahe-retirement:room", null]);
const presentAheRow = encodeCanonical([
	"storageMeta",
	"ahe-retirement:room",
	{ key: "ahe-retirement:room", record: encodeCanonical(topologyControl) },
]);
describe("R8 checked signing AHE backing-address projection affected controls", () => {
	it("requires simultaneous nonnull original AHE and BOTH exact addressed absence frames", () => {
		const result = signingAheProjection([absentAheRow, absentAheRow.slice()], topologyControl);
		expect(result.absent).toBe(true);
		expect(result.width).toBe(absentAheRow.byteLength);
		expect(result.width).toBeLessThan(presentAheRow.byteLength);
	});
	it("keeps the full present bound for unproved null-AHE birth and shared-present source", () => {
		for (const [rows, control] of [
			[[absentAheRow, absentAheRow], null],
			[[presentAheRow, presentAheRow], topologyControl],
		] as const) {
			const result = signingAheProjection(rows, control);
			expect(result.absent).toBe(false);
			expect(result.width).toBe(
				encodeCanonical([
					"storageMeta",
					"ahe-retirement:room",
					{ key: "ahe-retirement:room", record: encodeCanonical(control) },
				]).byteLength
			);
		}
	});
	it("gives no absence credit for missing, mixed, malformed or differently addressed port captures", () => {
		for (const rows of [
			[absentAheRow],
			[absentAheRow, presentAheRow],
			[absentAheRow, Uint8Array.of(255)],
			[absentAheRow, encodeCanonical(["storageMeta", "ahe-retirement:other", null])],
		])
			expect(signingAheProjection(rows, topologyControl).absent).toBe(false);
	});
	it("rejects foreign-object, invalid control-kind and wrong incarnation-domain inference", () => {
		for (const control of [
			{ ...topologyControl, objectId: "other" },
			{ ...topologyControl, kind: "not-a-native-control" },
			{ ...topologyControl, incarnation: "b".repeat(32) },
		])
			expect(signingAheProjection([absentAheRow, absentAheRow], control).absent).toBe(false);
	});
	it("retains exact source RAW and full PRE while only changing the addressed signing wrapper", () => {
		const original = encodeCanonical(topologyControl);
		signingAheProjection([absentAheRow, absentAheRow], topologyControl);
		expect(encodeCanonical(topologyControl)).toEqual(original);
		expect(topologyControl.completed.fullPriorDescriptor).toEqual(["all", "PRE"]);
	});
});

const carriedJournalProtection = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "priorJournalProtection"
);
const sizingJournalProtection = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "protectedJournalScopes"
);
const nativeJournalDetailScopes = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "journalDetailScopes"
);
const nativeJournalPreparation = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "journalPreparation"
);
const journalScope = (epoch: number, anchorDigest = "a".repeat(64)) => ({ objectId: "room", epoch, anchorDigest });
const journalPhysicalScopes = [
	journalScope(0),
	journalScope(2),
	journalScope(3),
	journalScope(4),
	journalScope(5),
	journalScope(6),
];
function journalProtectionForSource(carried: Record<string, unknown> | undefined, emptyEpochs: readonly number[] = [],
	protectedReplayScopes: readonly ReturnType<typeof journalScope>[] = []) {
	const original = { throughEpoch: 3, protectedScopes: journalPhysicalScopes.slice(0, 3) };
	const canonicalRows = journalPhysicalScopes.flatMap(scope => [
		encodeCanonical(["scopes", [scope.objectId, scope.epoch, scope.anchorDigest], {}]),
		...(emptyEpochs.includes(scope.epoch) ? [] : [encodeCanonical(["accepted_entries",
			[scope.objectId, scope.epoch, scope.anchorDigest, 0], {source_kind: "local-issued", journal_sequence: 0,
				vertex_digest: "a".repeat(64), local_author: "writer", local_author_sequence: scope.epoch,
				received_preimage: null, received_signature: null}])]),
	]);
	const capture = { journal: { control: { completed: original }, canonicalRows } };
	const precloseControls = carried === undefined ? undefined : { participants: [{}, carried, {}, {}] };
	const before = encodeCanonical({ capture, physical: journalPhysicalScopes, carried: carried ?? null });
	const forecast = execute<unknown[]>(
		`const ${carriedJournalProtection.getText(parsed)}; const ${sizingJournalProtection.getText(parsed)}; protectedJournalScopes;`,
		{
			capture,
			precloseControls,
			scopes: journalPhysicalScopes,
			sourceEpoch: 5,
			closedRetirementEqual: (a: unknown, b: unknown) =>
				Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
		}
	);
	const native = execute<{ protectedScopes: unknown[] }>(
		`const ${nativeJournalDetailScopes.getText(parsed)}; const ${nativeJournalPreparation.getText(parsed)}; journalPreparation;`,
		{
			decodeCanonical,
			source: { journal: { control: carried ?? capture.journal.control, canonicalRows }, journalDetails: {protectedReplayScopes} },
			journalScopes: journalPhysicalScopes.filter((scope) => scope.epoch <= 5),
			journalPrefixes: [],
			labels: { throughEpoch: 5, decisionDigest: "test-only", sourceProofDigest: "test-only" },
			closedRetirementEqual: (a: unknown, b: unknown) =>
				Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
		}
	);
	return {
		forecast,
		native: native.protectedScopes,
		before,
		after: encodeCanonical({ capture, physical: journalPhysicalScopes, carried: carried ?? null }),
	};
}
describe("R8 carried journal frontier affected controls", () => {
	it("retains live empty replay scopes while unused empty headers do not keep detail holes", () => {
		const result = journalProtectionForSource({completed: null}, [2, 3, 5], [journalScope(2), journalScope(5)]);
		expect(result.native).toEqual([journalScope(0), journalScope(2), journalScope(4), journalScope(5)]);
		// The numerical forecast remains a conservative whole-image bound.
		expect(result.forecast).toEqual(journalPhysicalScopes.filter(scope => scope.epoch <= 5));
		expect(result.after).toEqual(result.before);
	});
	it("uses the joined CURRENT frontier without resurrecting its fenced epoch2 hole", () => {
		const result = journalProtectionForSource({
			completed: { throughEpoch: 4, protectedScopes: [journalScope(0), journalScope(3), journalScope(4)] },
		});
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual([journalScope(0), journalScope(3), journalScope(4), journalScope(5)]);
		expect(result.after).toEqual(result.before);
	});
	it("preserves the original conservative capture when no preceding CURRENT tuple exists", () => {
		const result = journalProtectionForSource(undefined);
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual(journalPhysicalScopes.filter((scope) => scope.epoch <= 5));
	});
	it("protects all in-domain scopes for a carried null frontier instead of borrowing old holes", () => {
		const result = journalProtectionForSource({ completed: null });
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual(journalPhysicalScopes.filter((scope) => scope.epoch <= 5));
	});
	it("keeps exact anchor identity, complete prior descriptors and every physical scope unchanged", () => {
		const carried = {
			completed: { throughEpoch: 4, protectedScopes: [journalScope(2, "b".repeat(64)), journalScope(3)] },
			fullPriorDescriptor: ["all", "PRE"],
			active: null,
			drain: null,
		};
		const result = journalProtectionForSource(carried);
		expect(result.forecast).toEqual(result.native);
		expect(result.forecast).toEqual([journalScope(3), journalScope(5)]);
		expect(result.after).toEqual(result.before);
		expect(carried.fullPriorDescriptor).toEqual(["all", "PRE"]);
	});
});

const snapshotScopeCode = declaration("selectSnapshotTurnoverScopeInventory");
const futureSnapshotGate = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === "canProjectFutureSnapshotTurnover"
);
const snapshotSourceFunction = unique(
	(node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sourcePhysicalWidths"
);
const serialSnapshotEnvelope = unique(
	(node): node is ts.CallExpression =>
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText(parsed) === "serialFrames" &&
		node.expression.name.text === "map"
);
const snapshotScope75 = (epoch: number, anchor = "a".repeat(64)) => ({
	objectId: "room",
	epoch,
	anchor,
	manifestDigest: "b".repeat(64),
});
const snapshotRoles75 = {
	kind: "creator-snapshot-recovery-roles",
	version: 1,
	genesisAnchorDigest: "c".repeat(64),
	currentClose: snapshotScope75(5),
	previousClose: snapshotScope75(4),
	operationalSources: [],
	classifiedScopes: [snapshotScope75(3)],
};
const snapshotPairs75 = [3, 4, 5].map((epoch) => ({ scope: snapshotScope75(epoch), incarnation: "d".repeat(36) }));
function snapshotSelection75(
	inventory = snapshotPairs75.map((pair) => pair.scope),
	roles: unknown = snapshotRoles75,
	sourceTrust: unknown = { objectId: "room", currentEpoch: 5, currentAnchorDigest: "a".repeat(64) }
) {
	return execute<{ survivingScopes: unknown[]; retiringScopes: unknown[] } | undefined>(
		`${snapshotScopeCode}\nselectSnapshotTurnoverScopeInventory(roles, protectedScopes, inventory, sourceTrust);`,
		{ roles, protectedScopes: [snapshotRoles75.currentClose, snapshotRoles75.previousClose], inventory, sourceTrust }
	);
}
function snapshotGate75(overrides: Record<string, unknown> = {}) {
	return execute<boolean>(`const ${futureSnapshotGate.getText(parsed)}; canProjectFutureSnapshotTurnover;`, {
		preclose: false,
		precloseControls: {},
		ordinaryFutureAdvance: true,
		futureRoles: snapshotRoles75,
		turnoverRoles: { currentClose: snapshotScope75(4) },
		newScope: snapshotScope75(5),
		capture: { receivedRecoveryScopes: [] },
		forward: { certificates: [{ roles: { operationalSources: [] }, supportGenerations: [] }] },
		closedRetirementEqual: (a: unknown, b: unknown) =>
			Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
		...overrides,
	});
}
describe("R8 FUTURE snapshot turnover affected controls", () => {
	it("projects the actual opaque completed CURRENT control without native parsing or atom identity credit", () => {
		const start = source.indexOf("const beforeSnapshotControl =");
		const end = source.indexOf("const sourceSnapshots =", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const widths = [
			"maintenanceEncodedWidth",
			"maintenanceVarUintWidth",
			"maintenanceWidthSum",
			"maintenanceCanonicalWidth",
		]
			.map(declaration)
			.join("\n");
		const setup = `
				const maintenanceWidthAtom = Symbol("private-test-width");
				${widths}
				${declaration("snapshotTurnoverControlFieldsForSizing")}
				const digest = maintenanceEncodedWidth(66);
				const opaqueIncarnation = maintenanceEncodedWidth(38);
				const completed = { throughEpoch: 4, decisionDigest: digest, sourceProofDigest: digest,
					protectedScopes: snapshotPairs75.slice(0, 2) };
				const current = { kind: "snapshot-retirement-control-1", objectId: "room",
					incarnation: "d".repeat(64), revision: 7, sequence: 3, active: null, completed };
				const precloseControls = { participants: [current] };
				let futureSnapshotTurnover = { survivingScopes: snapshotPairs75.slice(1).map(pair => pair.scope),
					retiringScopes: [snapshotPairs75[0].scope] };
				const snapshots = snapshotPairs75;
				${source.slice(start, end)}
				const uncertain = snapshotTurnoverControlFieldsForSizing(
					{ ...current, completed: { ...completed,
						protectedScopes: [{ ...snapshotPairs75[0], incarnation: opaqueIncarnation }, snapshotPairs75[1]] } },
					{ objectId: "room", epoch: 6 }, snapshotPairs75.slice(0, 1));
				({ current, projected: futureSnapshotControl, selection: futureSnapshotTurnover,
					digestPreserved: futureSnapshotControl.completed.decisionDigest === digest,
					uncertainHoleCount: uncertain.completed.protectedScopes.length,
					uncertainRevision: uncertain.revision,
					width: maintenanceCanonicalWidth(futureSnapshotControl),
					unsupported: [
						snapshotTurnoverControlFieldsForSizing({ ...current, active: {} }, { objectId: "room", epoch: 6 }, snapshots),
						snapshotTurnoverControlFieldsForSizing(current, { objectId: "room", epoch: 5 }, snapshots)
					] });
			`;
		const result = execute<{
			current: { revision: number; completed: { protectedScopes: unknown[] } };
			projected: { revision: number; sequence: number; completed: { protectedScopes: unknown[] } };
			selection: unknown;
			digestPreserved: boolean;
			uncertainHoleCount: number;
			uncertainRevision: number;
			width: number;
			unsupported: unknown[];
		}>(setup, {
			objectId: "room",
			epoch: 5,
			snapshotPairs75,
			turnoverControl: null,
			closedRetirementEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
			AHE_BOUNDED_READ_LIMITS: { maxUnionBytes: 262144 },
		});
		expect(result.selection).toBeDefined();
		expect(result.projected.revision).toBe(8);
		expect(result.projected.sequence).toBe(3);
		expect(result.projected.completed.protectedScopes).toEqual(snapshotPairs75.slice(1, 2));
		expect(result.current.revision).toBe(7);
		expect(result.current.completed.protectedScopes).toEqual(snapshotPairs75.slice(0, 2));
		expect(result.digestPreserved).toBe(true);
		expect(result.width).toBeGreaterThan(0);
		expect(result.uncertainHoleCount).toBe(2);
		expect(result.uncertainRevision).toBe(8);
		expect(result.unsupported).toEqual([undefined, undefined]);
		expect(() => encodeCanonical(result.projected)).toThrow();
	});

	it("executes the shared whole-scope complement without changing original pairs or roles", () => {
		const before = encodeCanonical({ pairs: snapshotPairs75, roles: snapshotRoles75 });
		const result = snapshotSelection75();
		expect(result).toEqual({
			survivingScopes: [snapshotScope75(5), snapshotScope75(4)],
			retiringScopes: [snapshotScope75(3)],
		});
		expect(encodeCanonical({ pairs: snapshotPairs75, roles: snapshotRoles75 })).toEqual(before);
		expect(snapshotGate75()).toBe(true);
	});
	it("retains conservative fallback for unclassified, missing or foreign-source scope correlation", () => {
		expect(snapshotSelection75([snapshotScope75(2), snapshotScope75(4), snapshotScope75(5)])).toBeUndefined();
		expect(snapshotSelection75([snapshotScope75(3), snapshotScope75(5)])).toBeUndefined();
		expect(
			snapshotSelection75(undefined, snapshotRoles75, {
				objectId: "room",
				currentEpoch: 3,
				currentAnchorDigest: "a".repeat(64),
			})
		).toBeUndefined();
		expect(
			snapshotSelection75(undefined, { ...snapshotRoles75, classifiedScopes: [snapshotScope75(3, "e".repeat(64))] })
		).toBeUndefined();
	});
	it("keeps unsupported CURRENT, received, installed/shared and operational branches on the original full union", () => {
		for (const overrides of [
			{ preclose: true },
			{ precloseControls: undefined },
			{ ordinaryFutureAdvance: false },
			{ capture: { receivedRecoveryScopes: undefined } },
			{ capture: { receivedRecoveryScopes: [snapshotScope75(3)] } },
			{ futureRoles: { ...snapshotRoles75, operationalSources: [{}] } },
			{ forward: { certificates: [{ roles: { operationalSources: [] }, supportGenerations: [{}] }] } },
			{ forward: { certificates: [{ roles: { operationalSources: [{}] }, supportGenerations: [] }] } },
		])
			expect(snapshotGate75(overrides)).toBe(false);
	});
	it("uses the original codec's exact hole refinement and revision while retaining OLD and full prior fields", () => {
		const control = {
			kind: "snapshot-retirement-control-1",
			objectId: "room",
			incarnation: "d".repeat(64),
			revision: 7,
			sequence: 3,
			active: null,
			completed: {
				throughEpoch: 4,
				decisionDigest: "e".repeat(64),
				sourceProofDigest: "f".repeat(64),
				protectedScopes: snapshotPairs75.slice(0, 2),
			},
		} as const;
		const before = encodeCanonical(control);
		const after = snapshotRetirementContract.turnoverFrontier(
			control,
			{
				certificateDigest: "1".repeat(64),
				currentHead: { objectId: "room", epoch: 6, currentAnchorDigest: "2".repeat(64) },
				survivorScope: snapshotScope75(5),
				priorRetirementControl: control,
			},
			snapshotPairs75.slice(0, 1)
		);
		const projectedFields = execute<unknown>(
			`${declaration("snapshotTurnoverControlFieldsForSizing")}\nsnapshotTurnoverControlFieldsForSizing(control, head, retired);`,
			{ control, head: { objectId: "room", epoch: 6 }, retired: snapshotPairs75.slice(0, 1) }
		);
		expect(encodeCanonical(projectedFields)).toEqual(encodeCanonical(after));
		expect(after?.revision).toBe(8);
		expect(after?.sequence).toBe(3);
		expect(after?.completed?.protectedScopes).toEqual(snapshotPairs75.slice(1, 2));
		expect(encodeCanonical(control)).toEqual(before);
		expect(after?.completed?.decisionDigest).toBe(control.completed.decisionDigest);
	});
	it("owns full BEFORE plus AFTER snapshot wrappers in first source and keeps AFTER in later fresh sources", () => {
		const snapshotImage = {
			scopes: snapshotPairs75,
			scopeCount: 3,
			chunkCount: 3,
			metadataBytes: 100,
			imageDigest: "test-only",
		};
		const sourceSnapshotImage = { ...snapshotImage, scopes: snapshotPairs75.slice(1), scopeCount: 2 };
		const participants = [{ active: null, completed: null }, {}, {}, { completed: null }];
		const beforeWidth = encodeCanonical({ control: participants[0], image: snapshotImage }).byteLength;
		const joined: boolean[] = [],
			nativeObservations: number[] = [];
		const fields = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "journalNativeCarrierFields");
		const result = execute<{ first: number[]; second: number[] }>(
			`let futureSnapshotTurnoverPending = true; let reservedJournalPlan;
			const ${fields.getText(parsed)}; const ${snapshotSourceFunction.getText(parsed)};
			const first = sourcePhysicalWidths([], []); const second = sourcePhysicalWidths([], []); ({first, second});`,
			{
				maintenanceParticipants: participants,
				finalJournalCapacity: undefined,
				AHE_BOUNDED_READ_LIMITS,
				LIVE_JOURNAL_RETIREMENT_LIMITS,
				objectId: "room",
				futureSnapshotTurnover: { retiringScopes: [snapshotScope75(3)] },
				futureSnapshotPriorWrapperWidth: beforeWidth,
				serialSnapshotTurnoverJoined: joined,
				sourceSnapshotImage,
				journalClassifierWidths: [],
				journalRetirementNativeProgressFields, protectedHeaderScopes: [], prospectiveJournalHeaders: undefined,
				postAdoptionCensusWidth: () => 11,
				signingAheStorageMetaWidth: () => 13,
				signingRetirementStorageMetaRow: (_: string, control: unknown) => ({
					key: "signing-retirement:room",
					value: control,
				}),
				maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value).byteLength,
				finalJournal: { canonicalRowBytes: [], canonicalRowsBytes: 1 },
				capture: { floorImage: { scope: {} } },
				floor: {},
				maintenanceFloor: {},
				digest: "test-only",
				maintenanceEncodedWidth: (value: unknown) => value,
				nativeObservations,
				journalImage: {},
				aheOriginal: {},
				observe: () => undefined,
				maintenanceWidthSum: (values: number[]) => values.reduce((sum, value) => sum + value, 0),
				// ea4eb158: source widths take the sizing compiler's maximum; with no
				// compiler it is exactly Math.max (the production fallback).
				maximumWidth: (widths: readonly number[]) => Math.max(...widths),
				// ea4eb158: each fresh source also charges the ready snapshot
				// inventory (retained or cold-projected), the larger of the two.
				retainedInventory: snapshotPairs75.map((pair) => pair.scope),
				retainedOwner: { migration: "ready", recoveryScopes: 3, recoveryContentBytes: 100 },
				coldSnapshotInventoryWidths: [],
			}
		);
		expect(result.first[0]).toBe(beforeWidth);
		expect(result.first.slice(1)).toEqual(result.second);
		expect(result.second).toContain(
			encodeCanonical({ control: participants[0], image: sourceSnapshotImage }).byteLength
		);
		expect(joined).toEqual([false, true]);
		expect(snapshotImage.scopeCount).toBe(3);
	});
	it("projects target-only bytes only after first source joins, preserving unknown and live ledger totals", () => {
		const owner = nativeMaterialOwner() as NativeMaterialProjectionTest & {
			material: {
				chargeSnapshotTarget(bytes: Uint8Array, scope: unknown): boolean;
			};
		};
		const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
		expect(owner.material.chargeSnapshotTarget(bytes, snapshotScope75(3))).toBe(true);
		expect(owner.accounting.charge(Uint8Array.of(9, 9))).toBe(true);
		expect(owner.accounting.chargeUnknownEncodedLength(5)).toBe(true);
		const context = {
			preclose: false,
			serialFrames: [[1], [1]],
			serialSnapshotTurnoverJoined: [false, true],
			futureSnapshotTurnover: { retiringScopes: [snapshotScope75(3)] },
			freshRetiredSnapshotScopes: [],
			materialOwner: owner.material,
			// Link the changed production conditional in its original default mode.
			wholeMaterialProjection: execute(`const input = {}; const ${unique(
				(node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) && node.name.text === "wholeMaterialProjection"
			).getText(parsed)}; wholeMaterialProjection;`, {}),
			freshKnownLeaves: [],
			freshNativeRefs: undefined,
			futureUnknownMaterialWidths: [7, 7],
			unknown: [],
			maintenanceWidthSum: (values: number[]) => values.reduce((sum, value) => sum + value, 0),
		};
		const before = owner.accounting.chargedBytes;
		expect(execute(serialSnapshotEnvelope.getText(parsed), context)).toEqual([29, 22]);
		expect(owner.accounting.chargedBytes).toBe(before);
		// Independently authenticated equality dominates both scoped projections.
		expect(owner.accounting.charge(Uint8Array.from(bytes))).toBe(true);
		expect(execute(serialSnapshotEnvelope.getText(parsed), context)).toEqual([29, 29]);
	});
});

const receiptCaptureCondition79 = unique(
	(node): node is ts.IfStatement =>
		ts.isIfStatement(node) &&
		ts.isBlock(node.thenStatement) &&
		node.expression.getText(parsed).includes("currentCreatorMaintenanceRequiresSnapshotReceiptCapture(")
);
const receiptRequirement79 = declaration("currentCreatorMaintenanceRequiresSnapshotReceiptCapture");
function receiptRequired79(generations: number, pool: number, completed: unknown = null, epoch = 5): boolean {
	return execute<boolean>(
		`${receiptRequirement79}\ncurrentCreatorMaintenanceRequiresSnapshotReceiptCapture(generations, owner, completed, epoch);`,
		{
			generations,
			owner: { recoveryScopes: pool, limits: { maxRecoveryScopes: 4 } },
			completed,
			epoch,
			AHE_BOUNDED_READ_LIMITS: { maxObjectGenerations: 7 },
		}
	);
}
async function captureReceipts79(input: {
	generations?: number;
	pool?: number;
	completed?: unknown;
	received?: unknown;
	stale?: boolean;
}) {
	const checks: number[] = [],
		charges: number[] = [],
		queries: unknown[] = [];
	const frame = {alive: true, reader: {}, accounting: {charge: (bytes: Uint8Array) => {charges.push(bytes.byteLength); return true;}}};
	const snapshotInventory = {
		scopes: [{ scope: snapshotScope75(3), incarnation: "d".repeat(36) }],
		owner: { recoveryScopes: input.pool ?? 3, limits: { maxRecoveryScopes: 4 } },
	};
	const captured = execute<Promise<unknown>>(
		`${receiptRequirement79}\n${declaration("captureCreatorMaintenanceReceivedRecoveryScopes")}\n
		(async () => { let receivedRecoveryScopes;
			${receiptCaptureCondition79.getText(parsed)}
			return receivedRecoveryScopes;
		})();`,
		{
			forward: { installed: [], reader: { generations: Array.from({ length: input.generations ?? 5 }, () => ({})) } },
			snapshotInventory,
			ahe: { value: { control: { completed: input.completed ?? null } } },
			currentTrust: { currentEpoch: 5 },
			input: { snapshotStore: {} },
			bindMethod: (_store: unknown, method: string) => {
				expect(method).toBe("lookupReceivedRecoveryCertificate");
				return async (query: unknown) => {
					queries.push(query);
					return input.received ?? null;
				};
			},
			snapshotCall: (fn: () => Promise<unknown>) => fn(),
			reservations: [
				{
					check: async () => {
						checks.push(1);
						if (input.stale) throw Error("STALE_ORIGINAL_RESERVATION");
					},
				},
			],
			frame, frames: new WeakMap([[frame.reader, frame]]), ledgers: new WeakMap([[frame.accounting, frame]]),
			requireLaw: (ok: boolean, reason: string) => {
				if (!ok) throw Error(reason);
			},
			closedRetirementEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
			AHE_BOUNDED_READ_LIMITS: { maxObjectGenerations: 7 },
		}
	);
	return { result: await captured, checks, charges, queries };
}
describe("R8 CURRENT maintenance receipt capture affected controls", () => {
	it("matches all three original preclose triggers without assuming missing capture empty", () => {
		expect(receiptRequired79(5, 3)).toBe(false);
		expect(receiptRequired79(6, 3)).toBe(true);
		expect(receiptRequired79(7, 3)).toBe(true);
		expect(receiptRequired79(5, 4)).toBe(true);
		expect(receiptRequired79(5, 5)).toBe(true);
		expect(receiptRequired79(5, 3, { throughEpoch: 4, domains: [] })).toBe(true);
		expect(receiptRequired79(5, 3, { throughEpoch: 4 })).toBe(false);
		expect(receiptRequired79(5, 3, { throughEpoch: 3, domains: [] })).toBe(false);
	});
	it("leaves no-trigger capture unknown and performs no receipt read", async () => {
		const state = await captureReceipts79({});
		expect(state.result).toBeUndefined();
		expect(state.queries).toEqual([]);
		expect(state.checks).toEqual([]);
		expect(state.charges).toEqual([]);
	});
	it("populates verified empty census for full pool or completed resume with five raw rows", async () => {
		for (const input of [{ pool: 4 }, { completed: { throughEpoch: 4, domains: [] } }]) {
			const state = await captureReceipts79(input);
			expect(state.result).toEqual([]);
			expect(Object.isFrozen(state.result)).toBe(true);
			expect(state.queries).toEqual([{ objectId: "room", epoch: 3, anchor: "a".repeat(64) }]);
			expect(state.checks).toEqual([1, 1, 1, 1]); // Original owner brackets the complete census and each lookup.
			expect(state.charges).toEqual([]);
		}
	});
	it("retains and charges nonempty received result instead of enabling ordinary empty projection", async () => {
		const received = { scope: snapshotScope75(3), incarnation: "d".repeat(36), receipt: "actual-test-carrier" };
		const state = await captureReceipts79({ pool: 4, received });
		expect(state.result).toEqual([snapshotScope75(3)]);
		expect(state.charges).toEqual([encodeCanonical(received).byteLength]);
		expect(snapshotGate75({ capture: { receivedRecoveryScopes: state.result } })).toBe(false);
	});
	it("refuses stale reservation and mismatched received incarnation without publishing an empty result", async () => {
		await expect(captureReceipts79({ pool: 4, stale: true })).rejects.toThrow("STALE_ORIGINAL_RESERVATION");
		await expect(
			captureReceipts79({ pool: 4, received: { scope: snapshotScope75(3), incarnation: "other-incarnation" } })
		).rejects.toThrow("floor-stale");
	});
});

describe("R8 AFTER snapshot partition affected control", () => {
	it("uses the SAME complete AFTER inventory for scopes and protected indices, without changing BEFORE or PRE", () => {
		const preparation = unique(
			(node): node is ts.VariableDeclaration =>
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.name.text === "preparation" &&
				node.initializer !== undefined &&
				ts.isObjectLiteralExpression(node.initializer) &&
				node.initializer.properties.some(
					(property) => ts.isShorthandPropertyAssignment(property) && property.name.text === "snapshotScopes"
				)
		);
		const snapshots = snapshotPairs75;
		const sourceSnapshots = snapshots.slice(1);
		const snapshotScopes = sourceSnapshots.map((pair) => ({
			epoch: pair.scope.epoch,
			anchor: pair.scope.anchor,
			manifestDigest: pair.scope.manifestDigest,
			incarnationDigest: "d".repeat(64),
		}));
		const fullPrior = { completeDescriptor: ["OLD", "PRE", "COMPLETED"], revision: 7 };
		const context = {
			snapshots,
			sourceSnapshots,
			snapshotScopes,
			lHead: { objectId: "room", revision: 14 },
			sourceEpoch: 5,
			sourceAnchorDigest: "a".repeat(64),
			digest: "b".repeat(64),
			recordDigests: ["c".repeat(64)],
			domains: [fullPrior],
		};
		const before = encodeCanonical({ snapshots, sourceSnapshots, fullPrior });
		const statement = preparation.getText(parsed);
		const actual = execute<{
			snapshotScopes: unknown[];
			protectedIndices: number[];
			retireIndices: unknown[];
			domains: unknown[];
		}>(`const ${statement}; preparation;`, context);
		// This is exactly the original native install field relationship9213.
		expect(actual.snapshotScopes).toEqual(snapshotScopes);
		expect(actual.protectedIndices).toEqual(sourceSnapshots.map((_, index) => index));
		expect(actual.protectedIndices.length).toBe(actual.snapshotScopes.length);
		expect(actual.retireIndices).toEqual([]);
		expect(actual.domains[0]).toBe(fullPrior);
		expect(encodeCanonical({ snapshots, sourceSnapshots, fullPrior })).toEqual(before);
		expect(snapshots).toHaveLength(3);
		const wrongBeforeInventory = statement.replace(
			"protectedIndices: sourceSnapshots.map",
			"protectedIndices: snapshots.map"
		);
		expect(wrongBeforeInventory).not.toBe(statement);
		const mutant = execute<{ protectedIndices: number[] }>(`const ${wrongBeforeInventory}; preparation;`, context);
		expect(mutant.protectedIndices).not.toEqual(actual.protectedIndices);
	});
});

describe("joined plane deactivation preserves the original successor alias lease", () => {
	// Controlled nominal registry/jobs only. The actual helper is extracted;
	// these controls are not browser WebLock or native-storage acceptance.
	function owner(aliasCleanupFailure?: unknown) {
		const path = new URL("../src/v3-live.ts", import.meta.url),
			source = readFileSync(path, "utf8"),
			file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const declarations = file.statements.filter(
			(node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) &&
				["deactivateV3LivePlaneJoined", "joinEgressAdmissionOwner"].includes(node.name?.text ?? "")
		);
		if (declarations.length !== 2) throw new Error("JOINED_PLANE_DEACTIVATION_HELPER_NOT_UNIQUE");
		const events: string[] = [],
			registry = new WeakMap<object, object>();
		let revokeCalls = 0,
			rawDeactivations = 0,
			aliasDeactivations = 0;
		const raw = {
				// eslint-disable-next-line @typescript-eslint/require-await -- Controlled promise-returning cleanup.
				deactivate: async (): Promise<void> => {
					rawDeactivations++;
					events.push("raw-extra-deactivate");
				},
			},
			registration = {
				active: true,
				handle: raw,
				joinedWork: new Set<Promise<void>>(),
				networkNode: {},
				topic: "room",
			};
		const alias = {
			// eslint-disable-next-line @typescript-eslint/require-await -- Controlled promise-returning cleanup.
			deactivate: async (): Promise<void> => {
				aliasDeactivations++;
				events.push("alias-own-lease-release");
				expect(registration.active).toBe(false);
				if (aliasCleanupFailure !== undefined) throw aliasCleanupFailure;
			},
		};
		registry.set(raw, registration);
		registry.set(alias, registration);
		const join = execute<(handle: object) => Promise<void>>(
			`${declarations.map((declaration) => declaration.getText(file).replace(/^export /, "")).join("\n")}\ndeactivateV3LivePlaneJoined;`,
			{
				v3HandleRegistrations: registry,
				v3PlaneRegistrations: new WeakMap(),
				v3EgressAdmissionOwners: new WeakMap(),
				ReflectApply: Reflect.apply,
				SetPrototypeValues: Set.prototype.values,
				SetIteratorNext: Object.getOwnPropertyDescriptor(
					Object.getPrototypeOf(Reflect.apply(Set.prototype.values, new Set(), [])),
					"next"
				)?.value,
				deactivateRegistration: (actual: typeof registration) => {
					expect(actual).toBe(registration);
					revokeCalls++;
					events.push("revoke-admission");
					actual.active = false;
					return true;
				},
			}
		);
		const deferred = (name: string) => {
			let resolve!: () => void, reject!: (reason: unknown) => void;
			const pending = new Promise<void>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const task = pending.then(
				() => {
					events.push("joined:" + name);
				},
				(error) => {
					events.push("failed:" + name);
					throw error;
				}
			);
			registration.joinedWork.add(task);
			return { resolve, reject, task };
		};
		return {
			join,
			alias,
			raw,
			registration,
			events,
			deferred,
			admits: (): boolean => registration.active,
			counts: (): Readonly<Record<string, number>> => ({ revokeCalls, rawDeactivations, aliasDeactivations }),
		};
	}

	for (const failed of [false, true]) it(`revokes synchronously and releases the alias only after both jobs join (${failed ? "one job fails" : "both succeed"})`, async () => {
		const actual = owner(), first = actual.deferred("first"), second = actual.deferred("second"), primary = new Error("original-first-job-failure");
		const joined = actual.join(actual.alias), observed = joined.catch(error => error);
		expect(actual.admits()).toBe(false); expect(actual.events).toEqual(["revoke-admission"]);
		if (failed) first.reject(primary); else first.resolve();
		await first.task.catch(() => undefined); await Promise.resolve();
		expect(actual.counts().aliasDeactivations).toBe(0);
		let settled = false; void observed.then(() => {settled = true;}); await Promise.resolve(); expect(settled).toBe(false);
		second.resolve(); const outcome = await observed;
		expect(outcome).toBe(failed ? primary : undefined);
		expect(actual.events).toEqual(["revoke-admission", (failed ? "failed:" : "joined:") + "first", "joined:second", "alias-own-lease-release"]);
		expect(actual.counts()).toEqual({revokeCalls: 1, rawDeactivations: 0, aliasDeactivations: 1});
	});

	it("rejects foreign and copied handles before revocation, joining or alias effects", async () => {
		const actual = owner();
		for (const handle of [{deactivate: actual.alias.deactivate}, Object.freeze({}), {...actual.raw}])
			await expect(actual.join(handle)).rejects.toThrow("v3 plane deactivation owner is unavailable");
		expect(actual.admits()).toBe(true); expect(actual.events).toEqual([]);
		expect(actual.counts()).toEqual({revokeCalls: 0, rawDeactivations: 0, aliasDeactivations: 0});
	});

	it("joins a raw original without calling another deactivation or alias lease release", async () => {
		const actual = owner(), job = actual.deferred("raw");
		const joined = actual.join(actual.raw); expect(actual.admits()).toBe(false);
		expect(actual.counts()).toEqual({revokeCalls: 1, rawDeactivations: 0, aliasDeactivations: 0});
		job.resolve(); await joined;
		expect(actual.events).toEqual(["revoke-admission", "joined:raw"]);
		expect(actual.counts()).toEqual({revokeCalls: 1, rawDeactivations: 0, aliasDeactivations: 0});
	});

	it("preserves the exact cleanup cause alone and both original causes after admitted failure", async () => {
		const cleanup = new Error("original-alias-release-failure"), alone = owner(cleanup);
		await expect(alone.join(alone.alias)).rejects.toBe(cleanup);
		const actual = owner(cleanup), primary = new Error("original-admitted-job-failure"), job = actual.deferred("job");
		const joined = actual.join(actual.alias), observed = joined.catch(error => error); job.reject(primary);
		const failure = await observed;
		expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
		expect(actual.events).toEqual(["revoke-admission", "failed:job", "alias-own-lease-release"]);
	});
});

describe("conservative CURRENT to FUTURE capacity envelope", () => {
	// Executed production arithmetic and orchestration with real shared field
	// constructors. These controlled width tuples do not authenticate a source,
	// prove SQLite exclusion or substitute for the genuine healthy native run.
	type Tuple = {participants: Readonly<Record<string, unknown>>[]; floor: Readonly<Record<string, unknown>>;
		ahe: Readonly<Record<string, unknown>>; generations: unknown[]; signingPhysicalRows: readonly Uint8Array[];
		signingProtection: {throughEpoch: number; protectedEpochs: number[]}};
	function fields(path: string, names: readonly string[]) {
		const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		return names.map(name => {
			const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`CAPACITY_FIELD_NOT_UNIQUE:${name}:${found.length}`);
			return found[0]!.getText(file).replace(/^export /, "");
		}).join("\n");
	}
	function arithmetic(mutant: "none" | "minimum-child" | "drop-PRE" | "flatten-child" = "none") {
		let widen = declaration("widenProspectiveMaintenanceCapacityControls");
		const replace = (from: string, to: string) => {
			if (widen.split(from).length !== 2) throw Error(`CAPACITY_MUTANT_NOT_UNIQUE:${mutant}`);
			widen = widen.replace(from, to);
		};
		if (mutant === "minimum-child") replace(
			"maximum([measure(x), measure(y)])",
			"Math.min(...[measure(x), measure(y)])");
		if (mutant === "drop-PRE") replace("signingPhysicalRows: completeSigningPre", "signingPhysicalRows: completeSigningPre.slice(1)");
		if (mutant === "flatten-child") {
			const file = ts.createSourceFile("capacity.ts", widen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), children: ts.VariableDeclaration[] = [];
			const visit = (node: ts.Node): void => {if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "child") children.push(node);ts.forEachChild(node,visit);};
			visit(file);if (children.length !== 1) throw Error(`CAPACITY_CHILD_MUTANT_NOT_UNIQUE:${children.length}`);
			replace(children[0]!.getText(file), "child = (a: unknown, b: unknown) => maintenanceEncodedWidth(Math.max(maintenanceCanonicalWidth(a), maintenanceCanonicalWidth(b)))");
		}
		const constructors = fields(new URL("../../storage/src/retirement-control.ts", import.meta.url).pathname,
			["boundPreparedFields", "boundCompletedFields", "boundCompletionPayload"]) + "\n" +
			fields(new URL("../../seal/src/internal/seal-vote-intent.ts", import.meta.url).pathname,
				["signingRetirementMetadataFields", "signingRetirementDrainFields", "signingRetirementStorageMetaRow"]);
		const evidencePreparation=unique((node):node is ts.VariableDeclaration=>ts.isVariableDeclaration(node)&&
			ts.isIdentifier(node.name)&&node.name.text==="signingEvidencePreparation");
		return execute<{widen: (previous: Tuple | undefined, next: Tuple, pre: readonly Uint8Array[]) => Tuple | undefined;
			width: (value: unknown) => number; wrapped: (tuple: Tuple) => number; vector: (tuple: Tuple) => number[];
			signingCompletion(old:Readonly<Record<string,unknown>>,epochs:number[],summarySource?:unknown):Readonly<Record<string,unknown>>}>(`
			const maintenanceWidthAtom = Symbol("controlled-capacity-only");
			${["maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceEncodedWidth", "maintenanceEncodedBytes",
				"maintenanceCanonicalWidth", "sameMaintenanceCapacityData"].map(declaration).join("\n")}
			${widen}\n${constructors}
			const vector = tuple => {
				const hash = "d".repeat(64), labels = {throughEpoch: 3, decisionDigest: hash, sourceProofDigest: hash};
				const p = {...labels, domains: [[3, new Uint8Array(32), new Uint8Array(32), tuple.ahe.revision]],
					generationSource: {FULL_PRE: tuple.generations, intents: ["pending", "settlement", "cleanup"]}};
				const partition = {recordDigests: [hash], identities: [{generationId: hash, identityDigest: hash}], protectedIndices: [0], retireIndices: []};
				const prepared = boundPreparedFields(tuple.ahe, tuple.ahe.sequence + 1, p, partition);
				const completed = boundCompletedFields(prepared, boundCompletionPayload({floorEpoch: 3,
					decisionDigest: hash, sourceProofDigest: hash, snapshotHoles: [], generationHoles: [hash],
					generationIdentities: partition.identities, domains: p.domains, generationSource: p.generationSource}));
				const states = [tuple.ahe, prepared, completed], result = [];
				for (const control of states) {
					result.push(maintenanceCanonicalWidth(control));
					result.push(maintenanceCanonicalWidth(["storageMeta", "ahe-retirement:room", {key: "ahe-retirement:room",
						record: maintenanceEncodedBytes(maintenanceCanonicalWidth(control))}]));
					result.push(maintenanceCanonicalWidth({control, head: {kind: "present", objectId: "room", revision: 128},
						imageDigest: hash, metadataBytes: maintenanceCanonicalWidth(control)}));
				}
				for (const [index, control] of tuple.participants.entries()) {
					result.push(maintenanceCanonicalWidth(control)); // Full OLD, never refund.
					const preparation = {...labels, protected: ["current", "rollback", "pending", "shared"]};
					let prepared, completed;
					if (index === 3) {
						prepared = signingRetirementMetadataFields(control, "prepare", preparation, hash);
						completed = signingRetirementMetadataFields(prepared, "commit", undefined, undefined);
					} else {
						prepared = {...control, revision: control.revision + 1, sequence: control.sequence + 1,
							active: {sequence: control.sequence + 1, preparation}};
						completed = {...control, revision: control.revision + 2, sequence: control.sequence + 1, active: null,
							completed: preparation, ...(index === 1 ? {drain: null} : {})};
					}
					result.push(maintenanceCanonicalWidth(prepared), maintenanceCanonicalWidth(completed));
					if (index === 3) {
						const plan = {kind: "signing-summary-retirement-plan-2", baseControl: completed,
							entries: [["room", 1], ["room", 2]], sourceDataDigest: hash, resumeBasisDigest: hash,
							eligibilityFence: preparation};
						for (let batch = 0; batch <= 2; batch++) {
							const progress = signingRetirementDrainFields(completed, plan, batch, batch, hash);
							const row = signingRetirementStorageMetaRow("room", progress);
							result.push(maintenanceCanonicalWidth(progress), maintenanceCanonicalWidth(["storageMeta", row.key, row]));
						}
					}
				}
				result.push(maintenanceCanonicalWidth({scope: ["room", "account"], state: {stable: {epoch: 4}, pending: null}, control: tuple.floor}));
				result.push(tuple.signingPhysicalRows.reduce((sum, bytes) => sum + bytes.byteLength, 0));
				// Equal unknown occurrences are cumulative. No Set/digest credit.
				result.push(64, 64, 348, 348);
				return result;
			};
			const wrapped = tuple => maintenanceCanonicalWidth(signingRetirementDrainFields(tuple.participants[3],
				{kind: "signing-summary-retirement-plan-2", baseControl: tuple.participants[3]}, 0, 0, "d".repeat(64)));
			const signingCompletion = (old, signingEpochs, summarySource) => {
				const hash="a".repeat(64),labels={throughEpoch:3,decisionDigest:hash,sourceProofDigest:hash};
				const ${evidencePreparation.getText(parsed)};
				const preparation=summarySource===undefined?signingEvidencePreparation:{...signingEvidencePreparation,summarySource};
				const prepared=signingRetirementMetadataFields(old,"prepare",preparation,hash);
				return signingRetirementMetadataFields(prepared,"commit",undefined,undefined);
			};
			({widen: widenProspectiveMaintenanceCapacityControls, width: maintenanceCanonicalWidth, wrapped, vector, signingCompletion});`, {AHE_BOUNDED_READ_LIMITS});
	}
	function tuples(): {pre: readonly Uint8Array[]; contexts: Tuple[]} {
		const hash = "a".repeat(64), labels = {throughEpoch: 3, decisionDigest: hash, sourceProofDigest: hash};
		const pre = Object.freeze([encodeCanonical({store: "sealEvidence", FULL_PRE: new Uint8Array(4097)}),
			encodeCanonical({store: "signerState", FULL_PRE: new Uint8Array(127)}),
			encodeCanonical({store: "voteSlots", FULL_PRE: new Uint8Array(128)})]);
		const generations = [{objectId: "room", generationId: hash, state: "Adopted", baseExpectedHead: {kind: "none", objectId: "room"},
			closureDigest: hash, closure: [{digest: hash, byteLength: 123}]}];
		const scope = (epoch: number) => ({objectId: "room", epoch, anchorDigest: hash});
		const contexts = [[], [1], [2], [1, 2], [3], [1, 2, 3]].map((schedule, index): Tuple => {
			const revision = 126 + index, sequence = 127 + index;
			const shell = (kind: string, completed: unknown) => ({kind, objectId: "room", incarnation: hash, revision, sequence, active: null, completed});
			const summarySource = {entries: schedule.map(epoch => ({key: ["room", epoch], FULL_PRE: new Uint8Array(257 * epoch)})),
				sourceDataDigest: hash, resumeBasisDigest: hash, eligibilityFence: {...labels, protectedEpochs: [3]}};
			const signingBase = shell("signing-retirement-control-1", {...labels, protectedEpochs: [3],
				...(schedule.length === 0 ? {} : {summarySource})});
			const signing = {...signingBase, drain: {plan: schedule.length === 0 ? {baseControl: signingBase,
				entries: [{key: ["room", 1], FULL_PRE: new Uint8Array(4097)}], sourceDataDigest: hash} :
				{kind: "signing-summary-retirement-plan-2", baseControl: signingBase, ...summarySource},
				cursor: schedule.length, batches: index, remainingDataDigest: hash}};
			const journal = {...shell("v3-live-journal-retirement-control-2", {...labels, protectedScopes: [scope(index % 2)]}), drain: index % 2 === 0 ? null :
				{plan: {baseControl: shell("v3-live-journal-retirement-control-2", {...labels, protectedScopes: [scope(0)]}),
					sourceImage: {FULL_PRE: new Uint8Array(129 * index)}, prefixes: [{scope: scope(0), rows: schedule}]},
					cursor: 16 + index, batches: index, residualImageDigest: hash}};
			return {participants: [shell("snapshot-retirement-control-1", {...labels, protectedScopes: [{scope: scope(2), incarnation: hash}]}),
				journal, shell("v3-issuance-retirement-control-1", {...labels, protectedRecords: schedule}), signing],
				floor: {revision, incarnation: hash, active: null, completed: labels},
				ahe: {...shell("ahe-retirement-control-3", {...labels, generationDrain: {phase: "complete", source: {
					generations, domains: [revision, sequence], nestedSummary: summarySource}}}), binding: null, nominee: null},
				generations, signingPhysicalRows: pre.filter((_bytes, ordinal) => !schedule.includes(ordinal)),
				signingProtection: {throughEpoch: 3, protectedEpochs: [3]}};
		});
		return {pre, contexts};
	}
	function widened(owner: ReturnType<typeof arithmetic>, input = tuples()) {
		let result: Tuple | undefined;
		for (const context of input.contexts) {
			result = owner.widen(result, context, input.pre);
			expect(result).toBeDefined();
		}
		return result!;
	}
	function shapeLimitedTuple(kind:"depth"|"items"):Tuple {
		let child:unknown=Array(32_760).fill(0);
		if(kind==="depth"){child=0;for(let depth=0;depth<125;depth++)child=[child];}
		const base=tuples().contexts[0]!,signing=base.participants[3]!,completed=signing.completed as Record<string,unknown>;
		return {...base,participants:base.participants.map((row,index)=>index===3?{...row,drain:null,
			completed:{...completed,summarySource:child}}:row)};
	}
	it("dominates every complete OLD/PRE/COMP/native readback vector with nested summary controls and full signing PRE", () => {
		const owner = arithmetic(), input = tuples(), before = encodeCanonical(input), bound = widened(owner, input), vector = owner.vector(bound);
		for (const context of input.contexts) {
			const exact = owner.vector(context);
			expect(vector).toHaveLength(exact.length);
			for (let component = 0; component < exact.length; component++) expect(vector[component]).toBeGreaterThanOrEqual(exact[component]!);
			expect(vector.reduce((sum, width) => sum + width, 0)).toBeGreaterThanOrEqual(exact.reduce((sum, width) => sum + width, 0));
		}
		expect(bound.signingPhysicalRows).toBe(input.pre); expect(vector.slice(-4)).toEqual([64, 64, 348, 348]);
		expect(encodeCanonical(input)).toEqual(before); expect(Object.isFrozen(bound)).toBe(true);
		const limit = vector.reduce((sum, width) => sum + width, 0);
		for (const capacity of [limit - 1, limit, limit + 1]) {
			const fits = vector.every(width => width >= 0) && vector.reduce((sum, width) => sum + width, 0) <= capacity;
			expect(fits).toBe(capacity >= limit); // A one-byte miss calls exact, not a policy increase.
		}
	});
	it("widens the original signing evidence and summary completion constructors without fabricating semantic protection",()=>{
		const owner=arithmetic(),input=tuples(),contexts=input.contexts.map((tuple,index)=>{
			const old=tuple.participants[3]!,completion=old.completed as Record<string,unknown>;
			const signing=owner.signingCompletion(old,Array.from({length:index+1},(_,epoch)=>epoch),completion.summarySource);
			expect(Array.isArray((signing.completed as Record<string,unknown>).protectedEpochs)).toBe(false);
			return {...tuple,participants:tuple.participants.map((row,ordinal)=>ordinal===3?signing:row)};
		});
		const before=input.contexts.map(tuple=>encodeCanonical(tuple.signingProtection));
		const bound=widened(owner,{pre:input.pre,contexts}),vector=owner.vector(bound);
		expect(bound.signingProtection).toBe(contexts[0]!.signingProtection);
		expect(bound.signingProtection).toEqual({throughEpoch:3,protectedEpochs:[3]});
		for(const [index,context]of contexts.entries()){
			const exact=owner.vector(context);expect(vector.every((width,ordinal)=>width>=exact[ordinal]!)).toBe(true);
			expect(encodeCanonical(context.signingProtection)).toEqual(before[index]);
		}
		expect(owner.widen(bound,{...contexts[0]!,signingProtection:{throughEpoch:3,protectedEpochs:[2,3]}},input.pre)).toBeUndefined();
	});
	it("rejects intentional full-child/PRE underbounds rather than accepting a merely smaller number", () => {
		const input = tuples(), reference = arithmetic();
		for (const mutant of ["minimum-child", "drop-PRE"] as const) {
			const broken = arithmetic(mutant), vector = broken.vector(widened(broken, input));
			const exact = input.contexts.map(context => reference.vector({...context, signingPhysicalRows: input.pre}));
			expect(exact.some(row => row.some((width, index) => vector[index]! < width))).toBe(true);
		}
	});
	it("retains known child depth and item shape when a valid CURRENT control cannot fit a FUTURE wrapper", () => {
		const original = arithmetic(), flattened = arithmetic("flatten-child"), input = tuples();
		for(const kind of ["depth","items"] as const) {
			const tuple=shapeLimitedTuple(kind);
			expect(()=>original.width(tuple.participants[3])).not.toThrow();
			const bound=original.widen(undefined,tuple,input.pre);expect(bound).toBeDefined();
			expect(()=>original.wrapped(bound!)).toThrow("nesting");
			// The original FUTURE composer catches this shape failure and uses
			// its exact path. Flattening would incorrectly erase that limit.
			const broken=flattened.widen(undefined,tuple,input.pre);expect(broken).toBeDefined();
			expect(()=>flattened.wrapped(broken!)).not.toThrow();
		}
	});
	it("falls back for different generation/source/floor/protection bases, foreign PRE and malformed or oversized controls", () => {
		const owner = arithmetic(), input = tuples(), first = owner.widen(undefined, input.contexts[0]!, input.pre)!;
		const next = input.contexts[1]!;
		for (const changed of [
			{...next, generations: [{...next.generations[0] as object, generationId: "foreign"}]},
			{...next, signingProtection: {throughEpoch: 2, protectedEpochs: [2]}},
			{...next, floor: {...next.floor, incarnation: "foreign"}},
			{...next, ahe: {...next.ahe, objectId: "foreign"}},
			{...next, ahe: {...next.ahe, completed: null}},
			{...next, signingPhysicalRows: [Uint8Array.of(1)]},
			{...next, participants: next.participants.map((row, index) => index === 0 ? {...row, revision: -1} : row)},
			{...next, ahe: {...next.ahe, completed: {FULL_PRE: new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxUnionBytes)}}},
		] as Tuple[]) expect(owner.widen(first, changed, input.pre)).toBeUndefined();
	});
	it("runs every exact CURRENT schedule gate but only one bounded FUTURE query, with original fallback on inconclusive resources", () => {
		const schedules = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(parsed) === "summaryEpochSchedule === undefined");
		const input = tuples(), owner = arithmetic(), maximum = Math.max(...input.contexts.map(context => owner.vector(context).reduce((a, b) => a + b, 0)));
		const run = (mode: "fit" | "capacity" | "basis" | "current-refusal" | "depth" | "items") => {
			const current: string[] = [], future: Tuple[] = []; let exactFallback = 0;
			const result = execute<any>(`(() => { ${schedules.getText(parsed)} })();`, {
				summaryEpochSchedule: undefined, summaryEntries: [1, 2, 3].map(epoch => ({key: ["room", epoch]})), bodyRows: [],
				AHE_BOUNDED_READ_LIMITS, input: {}, preclose: true, precloseControls: undefined, generationOnly: false,
				adoptionDrain: false, conservativeCurrentFuture: true, authenticatedMembershipPrefixes: [],
				syntax: createCreatorCanonicalSyntaxReader(), signingData: input.pre,
				maintenanceCanonicalWidth: owner.width,
				maximumWidth: (widths: readonly number[]) => Math.max(...widths),
				prospectiveEvidencePrefixOnly: () => false, widenProspectiveMaintenanceCapacityControls: owner.widen,
				maintenanceWidthSum: (values: number[]) => values.reduce((a, b) => a + b, 0),
				evaluateSchedule: (schedule: number[]) => {
					current.push(schedule.join(","));
					if (mode === "current-refusal" && schedule.join(",") === "2") return {ok: false, reason: "original-current-source-refusal"};
					const original = mode === "depth" || mode === "items" ? shapeLimitedTuple(mode) :
						input.contexts.find((_context, ordinal) => ["", "1", "2", "1,2", "3", "1,2,3"][ordinal] === schedule.join(",")) ?? input.contexts[5]!;
					const tuple = mode === "basis" && schedule.join(",") === "2" ? {...original, floor: {...original.floor, incarnation: "rebound"}} : original;
					return {ok: true, knownCarriers: [Uint8Array.of(7)], unknownEncodedLengths: [64, 64],
						fullFutureProofEnvelopeByteLengths: [100 + schedule.length], precloseContinuation: tuple};
				},
				composeProspectiveCreatorMaintenancePrefixesForSizing: (_: unknown, _schedule: unknown, preclose: boolean, tuple: Tuple) => {
					if (preclose) {exactFallback++; return {ok: mode !== "current-refusal", reason: "original-current-source-refusal",
						knownCarriers: [Uint8Array.of(7)], unknownEncodedLengths: [64, 64], fullFutureProofEnvelopeByteLengths: [maximum]};}
					future.push(tuple);
					if (mode === "capacity") return {ok: false, reason: "MAINTENANCE_NATIVE_IMAGE_EXHAUSTED"};
					if(mode==="depth"||mode==="items"){
						try{owner.wrapped(tuple);}catch{return {ok:false,reason:"MAINTENANCE_CARRIER_SHAPE_EXHAUSTED"};}
						throw Error("KNOWN_CHILD_SHAPE_WAS_FLATTENED");
					}
					return {ok: true, knownCarriers: [Uint8Array.of(7)], unknownEncodedLengths: [64, 64],
						fullFutureProofEnvelopeByteLengths: [owner.vector(tuple).reduce((a, b) => a + b, 0)]};
				},
			});
			return {result, current, future, exactFallback};
		};
		const fit = run("fit"); expect(fit.result.ok).toBe(true); expect(fit.future).toHaveLength(1); expect(fit.exactFallback).toBe(0);
		expect(new Set(fit.current)).toEqual(new Set(["", "1", "2", "3", "1,2", "1,3", "1,2,3"]));
		expect(Math.max(...fit.result.fullFutureProofEnvelopeByteLengths)).toBeGreaterThanOrEqual(maximum);
		expect(fit.result.unknownEncodedLengths).toEqual([64, 64]);
		for (const mode of ["capacity", "basis", "current-refusal", "depth", "items"] as const) {
			const fallback = run(mode); expect(fallback.exactFallback).toBe(1);
			expect(fallback.result.ok).toBe(mode !== "current-refusal");
			if (mode === "current-refusal") expect(fallback.result.reason).toBe("original-current-source-refusal");
		}
	});
	it("uses the actual ordinary charge caller to choose exact fallback before spending when a conservative I bound is inconclusive", async () => {
		const closePath=new URL("../src/creator-close.ts",import.meta.url),closeFile=ts.createSourceFile(closePath.pathname,
			readFileSync(closePath,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
		const charge=closeFile.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&
			node.name?.text==="chargeCreatorIssuanceMaintenanceQuote");
		if(charge.length!==1)throw Error(`CAPACITY_CHARGE_CALLER_NOT_UNIQUE:${charge.length}`);
		const sizing=closeFile.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&
			node.name?.text==="creatorIssuanceMaintenanceQuoteSizing");
		if(sizing.length!==1)throw Error(`CAPACITY_QUOTE_SIZING_NOT_UNIQUE:${sizing.length}`);
		// The caller's own next-epoch forecast; this composer stub fills no
		// forecast sink, so it leaves the original charge outcome unchanged.
		const forecast=closeFile.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&
			node.name?.text==="creatorNextEpochAdmissionForecast");
		if(forecast.length!==1)throw Error(`CAPACITY_NEXT_EPOCH_FORECAST_NOT_UNIQUE:${forecast.length}`);
		const bytes=(length:number)=>new Uint8Array(length).fill(length),known=[1,2,3,4,5,6,7,8,9].map(bytes),carrier=bytes(10);
		// Existing known cut is deduplicated; existing unknown three bytes are
		// not. The two seven-byte future unknowns remain separate occurrences.
		const exactTotal=known.reduce((sum,row)=>sum+row.length,0)+carrier.length+3+9+5+7+7;
		for(const capacity of [exactTotal-1,exactTotal,exactTotal+1,exactTotal+8]) {
			const materials=new WeakMap(),book=execute<ReturnType<typeof createCreatorClosedRollbackProofAccounting>>(
				`${declaration("projectCreatorProofMaterialByteLengths")}\n${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /,"")}\ncreateCreatorClosedRollbackProofAccounting([]);`,
				{AHE_BOUNDED_READ_LIMITS,CREATOR_ORDINARY_PROOF_MAX_BYTES:capacity,proofMaterialOwners:materials});
			expect(book.charge(known[0]!)).toBe(true);expect(book.chargeUnknownEncodedLength(3)).toBe(true);
			const reader={},observation={},postAdoptionCensusSizing={},image={},frame={alive:true,accounting:book,
				maintenanceCapture:{closeHold:{},journal:image},input:{objectId:"room",store:{},snapshotStore:{},
					liveJournalStore:{readRetirementImage:async()=>({ok:true,value:image})}}};
			const facts={forward:{reader,installed:[],certificates:[]}},modes:boolean[]=[],chargedAtCompose:number[]=[];
			const quote={proof:{accounting:book,observation},material:{prepared:{close:{},exactCanonicalCutValueBytes:known[0]},
				snapshot:{exactCanonicalManifestBytes:known[1],chunks:[known[3]]},preview:{exactCanonicalPayloadBytes:known[2],exactCanonicalSuccessorAclBytes:known[4]},
				widths:{exactCanonicalAnchorPreimageBytes:known[5],successorAnchorDigest:"a".repeat(64),prepareQcBytes:64,commitQcBytes:64,trustBytes:64}},
				adoption:{projection:known[6],history:known[7]},receivedSignature:known[8],metadata:{},signingFrames:[],
				issuancePhases:{reserved:{nativeCensusBytes:7},entered:{nativeCensusBytes:9},final:{nativeCensusBytes:8}},
				runtimeCensusOverheadByteLength:5,postAdoptionCensusSizing,exactCanonicalCurrentLatchedAclBytes:bytes(11)};
			const running=execute<Promise<void>>(`${declaration("readProspectiveCreatorMaintenancePrefixesForSizing").replace(/^export /,"")}
				${sizing[0]!.getText(closeFile)}
				${forecast[0]!.getText(closeFile)}
				${charge[0]!.getText(closeFile)}\nchargeCreatorIssuanceMaintenanceQuote(quote,unsigned);`,{
				CREATOR_NEXT_EPOCH_FIXED_CUSTODY_BYTES:4096,
				quote,unsigned:bytes(12),observations:new WeakMap([[observation,facts]]),frames:new WeakMap([[reader,frame]]),ledgers:new WeakMap([[book,frame]]),
				proofMaterialOwners:materials,resolveCreatorPostAdoptionCensusSizing:()=>postAdoptionCensusSizing,
				readProspectiveCreatorSnapshotTurnoverForSizing:()=>({ok:true,required:false}),resolveCreatorForwardPromotionSource:()=>undefined,
				closedRetirementEqual:(a:unknown,b:unknown)=>a===b,closedJournalNativeObservationEqual:(a:unknown,b:unknown)=>a===b,isAuthenticatedInitialAdoptionDrain:()=>false,
				createCreatorMaintenanceSizingSyntax:()=>createCreatorCanonicalSyntaxReader(),
				requireLaw:(ok:boolean,reason:string)=>{if(!ok)throw Error(reason);},
				composeProspectiveCreatorMaintenancePrefixesForSizing:(input:any,...args:unknown[])=>{
					expect(input.ordinaryChargeBasis.known).toEqual(known);expect(input.ordinaryChargeBasis.unknown).toEqual([9,5]);
					const fast=args[7]===true;modes.push(fast);chargedAtCompose.push(book.chargedBytes);
					return {ok:true,knownCarriers:[carrier],unknownEncodedLengths:fast?[11,11]:[7,7],
						fullFutureProofEnvelopeByteLengths:[100],...(fast?{capacityEnvelope:true}:{})};
				},
			});
			if(capacity<exactTotal)await expect(running).rejects.toThrow("proof reserve is exhausted");else await running;
			expect(modes).toEqual(capacity<exactTotal+8?[true,false]:[true]);
			expect(chargedAtCompose).toEqual(modes.map(()=>4)); // Projection/fallback spend nothing.
			if(capacity>=exactTotal)expect(book.chargedBytes).toBe(capacity<exactTotal+8?exactTotal:exactTotal+8);
		}
	});
	it("selects only original plain source facts and keeps unrelated outstanding ordinary work eligible", () => {
		const flag = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "conservativeCurrentFuture");
		const select = (input: object, forward: object) => execute<boolean>(`const ${flag.getText(parsed)}; conservativeCurrentFuture;`,
			{input, facts: {forward}});
		const original = {installed: [], certificates: [{roles: {operationalSources: []}}]};
		const basis={ordinaryChargeBasis:{known:[],unknown:[]}};
		expect(select(basis, original)).toBe(true);expect(select({},original)).toBe(false);
		expect(select({...basis,receivedSignature: new Uint8Array(64), planEffect: {kind: "replacement"},
			postAdoptionCensusSizing: [{currentContinuation: {journalAppends: ["already-admitted"]}}]}, original)).toBe(true);
		for (const input of [{archiveConstruction: {cutValueByteLength: 4096}}, {archiveConstruction: {unknownByteLengths: [64,64]}}])
			expect(select({...basis,...input}, original)).toBe(false);
		for (const forward of [{...original, pending: {source: "nested-promotion"}},
			{...original, installed: [{source: "installed-promotion"}]},
			{...original, certificates: [{roles: {operationalSources: [{closedEpoch: 0}]}}]}])
			expect(select(basis, forward)).toBe(false);
		const originalRead = declaration("readProspectiveCreatorMaintenancePrefixesForSizing");
		expect(originalRead).toContain("memberships, syntax, conservativeCurrentFuture");
		expect(originalRead.indexOf("source!.readClosedJournalMembershipPrefixes()")).toBeLessThan(originalRead.indexOf("const conservativeCurrentFuture"));
	});
});

type RollbackScalarCandidate = {bytes: Uint8Array; ref: {digest: string; byteLength: number}};
type RollbackScalarClosure = {candidates: RollbackScalarCandidate[]; closure: RollbackScalarCandidate["ref"][]};
type RollbackScalarGeneration = {generationId: string; closure: RollbackScalarCandidate["ref"][]};
type RollbackScalarFrame = {reader: {generations: RollbackScalarGeneration[]; blobs: RollbackScalarCandidate[]}};

// Actual private helpers/callers, with the established same-realm extraction
// machinery. These are syntax/order controls, not native/authentication proof.
function rollbackScalarSizingFixture(oldKindCensus = false) {
	const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
	const syntaxFile = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const transitionPath = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
	const transitionFile = ts.createSourceFile(transitionPath.pathname, readFileSync(transitionPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const extract = (file: ts.SourceFile, name: string) => {
		const nodes = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
		if (nodes.length !== 1) throw Error(`ROLLBACK_SCALAR_HELPER_NOT_UNIQUE:${name}:${nodes.length}`);
		return nodes[0]!.getText(file).replace(/^export /, "");
	};
	const composer = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "composeProspectiveCreatorMaintenancePrefixesForSizing");
	if (composer.body === undefined) throw Error("ROLLBACK_SCALAR_COMPOSER_BODY_MISSING");
	const locals: ts.VariableDeclaration[] = [];
	for (const statement of composer.body.statements.filter(ts.isTryStatement))
		for (const row of statement.tryBlock.statements.filter(ts.isVariableStatement))
			locals.push(...row.declarationList.declarations);
	const local = (name: string) => {
		const selected = locals.filter(node => node.name.getText(parsed) === name);
		if (selected.length !== 1 || selected[0]?.initializer === undefined || !ts.isArrowFunction(selected[0].initializer))
			throw Error("ROLLBACK_SCALAR_LOCAL_NOT_UNIQUE:" + name);
		return selected[0].getText(parsed);
	};
	let localUnique = local("unique");
	const censusMarker = "syntax.canonicalSelection(candidate.bytes)";
	if (localUnique.indexOf(censusMarker) < 0 || localUnique.indexOf(censusMarker) !== localUnique.lastIndexOf(censusMarker))
		throw Error("ROLLBACK_SCALAR_KIND_CENSUS_NOT_UNIQUE");
	if (oldKindCensus) localUnique = localUnique.replace(censusMarker, "syntax.record(candidate.bytes)");
	const sort = unique((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(parsed) === "generationWidthCandidates.sort" &&
		node.arguments[0]?.getText(parsed) === "(a, b) => compareClosedGenerationSources(frame, a, b, syntax)");
	const nativeReturn = unique((node): node is ts.ReturnStatement => ts.isReturnStatement(node) && node.expression?.getText(parsed) === "compareClosedGenerationSources(frame, a, b)");
	const stats = {decodes: 0, fullObjectCopies: 0, recordReads: 0, scalarReads: 0};
	const observedObject = new Proxy(Object, {get(target, key) {
		if (key === "create") return (prototype: object | null) => {stats.fullObjectCopies++; return Object.create(prototype);};
		return Reflect.get(target, key);
	}});
	const owner = execute<{
		unique(closure: RollbackScalarClosure, kind: string, epoch?: number): RollbackScalarCandidate;
		record(bytes: Uint8Array): Readonly<Record<string, unknown>>;
		priority(frame: RollbackScalarFrame, row: RollbackScalarGeneration, privateSyntax?: boolean): {closing: number; epoch: number};
		sort(frame: RollbackScalarFrame, rows: readonly RollbackScalarGeneration[], privateSyntax?: boolean): RollbackScalarGeneration[];
		nativeCompare(frame: RollbackScalarFrame, a: RollbackScalarGeneration, b: RollbackScalarGeneration): number;
	}>(`
		${extract(syntaxFile, "canonicalCreatorDataRecord")}
		${extract(syntaxFile, "createCreatorCanonicalSyntaxReader")}
		${extract(transitionFile, "record").replace("function record(", "function transitionRecord(")}
		${extract(transitionFile, "candidateSelection").replace("record(candidate)", "transitionRecord(candidate)")}
		${extract(transitionFile, "uniqueCreatorTransitionCandidate").replace("record(candidate)", "transitionRecord(candidate)")}
		${extract(transitionFile, "sameRef")}
		${extract(transitionFile, "exactCreatorTransitionOccurrence")}
		${["view", "unique", "record", "closedGenerationSourcePriority", "compareClosedGenerationSources", "createCreatorMaintenanceSizingSyntax"].map(declaration).join("\n")}
		const actualSyntax=createCreatorMaintenanceSizingSyntax();
		const sharedSyntax={...actualSyntax,
		 record:(bytes:Uint8Array)=>{stats.recordReads++;return actualSyntax.record(bytes);},
		 canonicalSelection:(bytes:Uint8Array)=>{stats.scalarReads++;return actualSyntax.canonicalSelection(bytes);}};
		const composerUnique=(()=>{const syntax=sharedSyntax;const ${local("select")};const ${localUnique};return unique;})();
		({unique:composerUnique,record:sharedSyntax.record,
		 priority:(frame:unknown,row:unknown,privateSyntax=true)=>closedGenerationSourcePriority(frame,row,privateSyntax?sharedSyntax:undefined),
		 sort:(frame:unknown,rows:readonly unknown[],privateSyntax=true)=>{const generationWidthCandidates=rows.slice(),syntax=privateSyntax?sharedSyntax:undefined;${sort.getText(parsed)};return generationWidthCandidates;},
		 nativeCompare:(frame:unknown,a:unknown,b:unknown)=>{${nativeReturn.getText(parsed)}}});
	`, {AHE_BOUNDED_READ_LIMITS, Object: observedObject, stats,
		decodeCanonical: (bytes: Uint8Array) => {stats.decodes++; return decodeCanonical(bytes);},
		requireLaw: (value: unknown) => {if (!value) throw Error("chain-invalid");},
	});
	return {owner, stats};
}
function rollbackScalarCandidate(value: unknown): RollbackScalarCandidate {
	const bytes = encodeCanonical(value), digest = digestBlob(bytes);
	if (!digest.ok) throw Error("ROLLBACK_SCALAR_FIXTURE_DIGEST");
	return {bytes, ref: {digest: digest.value, byteLength: bytes.byteLength}};
}
function rollbackScalarClosure(candidates: RollbackScalarCandidate[]): RollbackScalarClosure {
	return {candidates, closure: candidates.map(candidate => candidate.ref)};
}

describe("R8 composer scalar kind census affected controls", () => {
	it("executes the actual kind-only caller with old-path identity/refusal equivalence and no full-tree copies", () => {
		const candidates = [
			rollbackScalarCandidate({kind: "drp-anchor-trust-state", currentEpoch: 3, PRE: new Uint8Array(4096)}),
			rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 2, nested: {members: ["writer"]}, PRE: new Uint8Array(4096)}),
			rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 2, phase: "commit", signers: ["creator"], signature: new Uint8Array(64)}),
		];
		const fast = rollbackScalarSizingFixture(), old = rollbackScalarSizingFixture(true), closure = rollbackScalarClosure(candidates);
		for (let turn = 0; turn < 3; turn++) for (const [index, kind, epoch] of [[0, "drp-anchor-trust-state", 3], [1, "drp-hard-epoch-cut", 2], [2, "drp-seal-qc", 2]] as const) {
			expect(fast.owner.unique(closure, kind, epoch)).toBe(candidates[index]);
			expect(old.owner.unique(closure, kind, epoch)).toBe(candidates[index]);
		}
		expect(fast.stats.recordReads).toBe(0); expect(fast.stats.fullObjectCopies).toBe(0);
		expect(fast.stats.scalarReads).toBeGreaterThan(0); expect(old.stats.recordReads).toBeGreaterThan(0);
		expect(old.stats.fullObjectCopies).toBeGreaterThan(0); expect(fast.stats.decodes).toBe(3);
		const cut = candidates[1]!;
		const extraRef: RollbackScalarClosure = {candidates, closure: [...closure.closure, cut.ref]};
		const missingRef: RollbackScalarClosure = {candidates, closure: closure.closure.filter(ref => ref !== cut.ref)};
		for (const [refused, kind] of [
			[rollbackScalarClosure([...candidates, cut]), "drp-hard-epoch-cut"],
			[rollbackScalarClosure([...candidates, rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 3})]), "drp-hard-epoch-cut"],
			[rollbackScalarClosure([...candidates, rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 2, phase: "prepare"})]), "drp-seal-qc"],
			[extraRef, "drp-hard-epoch-cut"],
			[missingRef, "drp-hard-epoch-cut"],
		] as const) {
			expect(() => fast.owner.unique(refused, kind, 2)).toThrow("chain-invalid");
			expect(() => old.owner.unique(refused, kind, 2)).toThrow("chain-invalid");
		}
	});
	it("rechecks same-buffer mutation and preserves full-value output isolation beside scalar selection", async () => {
		const fast = rollbackScalarSizingFixture(), old = rollbackScalarSizingFixture(true);
		const candidate = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 2, PRE: Uint8Array.of(7, 9), nested: {members: ["writer"]}});
		let closure = rollbackScalarClosure([candidate]);
		expect(fast.owner.unique(closure, "drp-hard-epoch-cut", 2)).toBe(candidate);
		expect(old.owner.unique(closure, "drp-hard-epoch-cut", 2)).toBe(candidate);
		const full = fast.owner.record(candidate.bytes) as {PRE: Uint8Array; nested: {members: string[]}};
		full.PRE.fill(99); full.nested.members.push("tampered");
		expect(fast.owner.record(candidate.bytes)).toEqual(old.owner.record(candidate.bytes));
		expect((fast.owner.record(candidate.bytes).PRE as Uint8Array)[0]).toBe(7);
		await Promise.resolve();
		const changed = encodeCanonical({...decodeCanonical(candidate.bytes) as object, epoch: 3});
		expect(changed.byteLength).toBe(candidate.bytes.byteLength); candidate.bytes.set(changed);
		const digest = digestBlob(candidate.bytes); if (!digest.ok) throw Error("ROLLBACK_SCALAR_MUTATION_DIGEST");
		candidate.ref = {digest: digest.value, byteLength: candidate.bytes.byteLength}; closure = rollbackScalarClosure([candidate]);
		for (const fixture of [fast, old]) {
			expect(() => fixture.owner.unique(closure, "drp-hard-epoch-cut", 2)).toThrow("chain-invalid");
			expect(fixture.owner.unique(closure, "drp-hard-epoch-cut", 3)).toBe(candidate);
		}
	});
});

describe("R8 composer source-priority scalar syntax affected controls", () => {
	function frame(values: readonly {id: string; epoch?: unknown; live: boolean}[]): RollbackScalarFrame {
		const blobs: RollbackScalarCandidate[] = [], generations = values.map(value => {
			const candidates = [rollbackScalarCandidate({kind: "drp-anchor-trust-state", generationId: value.id, ...(value.epoch === undefined ? {} : {currentEpoch: value.epoch}), PRE: new Uint8Array(2048)})];
			const epoch = Number(value.epoch);
			if (value.live) candidates.push(rollbackScalarCandidate({kind: epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2", epoch: Number.isNaN(epoch) ? 0 : epoch}));
			blobs.push(...candidates); return {generationId: value.id, closure: candidates.map(candidate => candidate.ref)};
		});
		return {reader: {generations, blobs}};
	}
	it("executes the actual composer sort in original closing/epoch/id order without copying numeric trust trees", () => {
		const f = frame([{id: "live-0", epoch: 0, live: true}, {id: "closing-z", epoch: 2, live: false},
			{id: "closing-a", epoch: 2, live: false}, {id: "closing-old", epoch: 1, live: false}, {id: "live-3", epoch: 3, live: true}]);
		const fast = rollbackScalarSizingFixture(), old = rollbackScalarSizingFixture();
		const order = fast.owner.sort(f, f.reader.generations).map(row => row.generationId);
		expect(order).toEqual(["closing-old", "closing-a", "closing-z", "live-0", "live-3"]);
		expect(order).toEqual(f.reader.generations.slice().sort((a, b) => old.owner.nativeCompare(f, a, b)).map(row => row.generationId));
		expect(fast.stats.recordReads).toBe(0); expect(fast.stats.fullObjectCopies).toBe(0); expect(fast.stats.scalarReads).toBeGreaterThan(0);
		expect(old.stats.scalarReads).toBe(0); expect(old.stats.decodes).toBeGreaterThan(0);
	});
	it("preserves original full-record Number fallback and refuses BigInt outside the original codec domain", () => {
		for (const value of ["2", "nonnumeric", null, new Uint32Array([2]), [2], undefined]) {
			const f = frame([{id: "fallback", epoch: value, live: true}, {id: "peer", epoch: 1, live: false}]), row = f.reader.generations[0]!;
			const fast = rollbackScalarSizingFixture(), old = rollbackScalarSizingFixture();
			const actual = fast.owner.priority(f, row), original = old.owner.priority(f, row, false);
			expect(actual).toEqual(original);
			expect(actual.epoch).toBe(Number(value)); // Includes the original NaN outcome, not strengthened scalar admission.
			expect(fast.stats.recordReads).toBe(1); expect(fast.stats.fullObjectCopies).toBeGreaterThan(0);
			expect(old.stats.scalarReads).toBe(0);
			expect(fast.owner.sort(f, f.reader.generations).map(row => row.generationId)).toEqual(
				f.reader.generations.slice().sort((a, b) => old.owner.nativeCompare(f, a, b)).map(row => row.generationId));
		}
		// BigInt never reaches the original reader's canonical record/Number
		// branch. Preserve the genuine codec refusal, not a fabricated carrier.
		expect(() => frame([{id: "bigint", epoch: BigInt(2), live: true}])).toThrow("bigint is outside the canonical domain");
	});
	it("keeps default/native callers uncached and threads the reader only through the original composer sort", () => {
		const f = frame([{id: "a", epoch: 1, live: false}, {id: "b", epoch: 2, live: false}]), native = rollbackScalarSizingFixture();
		for (let turn = 0; turn < 2; turn++) expect(native.owner.nativeCompare(f, f.reader.generations[0]!, f.reader.generations[1]!)).toBe(-1);
		expect(native.stats.scalarReads).toBe(0); expect(native.stats.recordReads).toBe(0);
		const before = native.stats.decodes; native.owner.nativeCompare(f, f.reader.generations[0]!, f.reader.generations[1]!);
		expect(native.stats.decodes).toBeGreaterThan(before);
		const calls: ts.CallExpression[] = [];
		const collect = (node: ts.Node): void => {if (ts.isCallExpression(node) && node.expression.getText(parsed) === "compareClosedGenerationSources") calls.push(node); ts.forEachChild(node, collect);}; collect(parsed);
		expect(calls).toHaveLength(2);
		expect(calls.filter(call => call.arguments.length === 4).map(call => call.getText(parsed))).toEqual(["compareClosedGenerationSources(frame, a, b, syntax)"]);
		expect(calls.filter(call => call.arguments.length === 3).map(call => call.getText(parsed))).toEqual(["compareClosedGenerationSources(frame, a, b)"]);
		const nativeSource = declaration("classifyClosedGenerationSource");
		expect(nativeSource).toContain('requireLaw(!input.unclassified, "snapshot-unavailable")');
		expect(nativeSource).toContain("frame.authenticatedExcludedGenerations?.slice().sort");
		expect(nativeSource).toContain("closedGenerationSourceFromSelected(frame, summary, rows, selected)");
	});
});

describe("same-hold issuance census data and joined lifetime affected controls", () => {
	type Reservation = {check(): Promise<void>; release(): Promise<void>};
	type Held = {store: object; objectId: string; available(): boolean; read(consume: () => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined>};
	type Lifetime = {acquireNativeIssuanceReservation(): Promise<Reservation>; check(): Promise<void>; release(): Promise<void>};
	function seam() {
		const path = new URL("../src/v3-live.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const one = <T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T => {
			const found: T[] = []; const visit = (node: ts.Node): void => {if (predicate(node)) found.push(node); ts.forEachChild(node, visit);}; visit(root);
			if (found.length !== 1) throw Error(`HELD_ISSUANCE_SEAM_NOT_UNIQUE:${found.length}`); return found[0]!;
		};
		const fn = (name: string) => one(file, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
		const seal = fn("sealCreatorRecoveryDependencies"), census = fn("readCreatorRecoveryDependencyCensus");
		const variable = (root: ts.Node, name: string) => one(root, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name).getText(file);
		const factory = one(seal, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(file) === "ownIssuanceReservation");
		const check = one(factory.parent, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(file) === "check" && ts.isArrowFunction(node.initializer));
		return {file, census, fn, variable, factory: factory.getText(file), check: check.getText(file)};
	}
	function deferred() {
		let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};
	}
	function fixture() {
		const s = seam(), capability = {}, registry = new WeakMap(), store = {}, journal = {}, events: string[] = [];
		const trust = {objectId: "room", currentEpoch: 4, currentAnchorDigest: "anchor"};
		const bytes = encodeCanonical({completeCensus: "sealed"});
		const state = {live: true, checks: 0, captures: 0, releases: 0, acquisitions: 0, prepared: 0,
			failCheck: 0, changed: false, capture: undefined as (() => Promise<void>) | undefined,
			acquire: undefined as (() => Promise<void>) | undefined, release: undefined as (() => Promise<void>) | undefined};
		const original: Reservation = {check: async () => {state.checks++; events.push("native-check"); if (state.checks === state.failCheck) throw Error("native-currentness-failed");},
			release: async () => {state.releases++; events.push("native-release"); await state.release?.();}};
		const issuanceStore = {acquireNativeReadReservation: async function (scope: {objectId: string}) {
			expect(this).toBe(issuanceStore); expect(scope).toEqual({objectId: trust.objectId}); state.acquisitions++; await state.acquire?.(); return original;
		}};
		const registration = {issuanceStore, payload: {input: {store}, trust: {trust}}, liveJournalStore: journal};
		// Actual getter, private ownership factory, currency check and lifetime
		// resolver; only the census result and native reservation are controlled.
		// This tests ownership/data mechanics, not the full live/auth predicate or
		// native storage acceptance. Production live() is not replaced in source.
		const owner = execute<{facts: {pending: Set<Promise<unknown>>; releasing: boolean}; lifetime: Lifetime; held(): Held | undefined}>(`
			let issuanceRead: CreatorHeldIssuanceCensusRead | undefined;
			// ea4eb158: check/ownIssuanceReservation also own the unchanged-held fast
			// cell and the optional current-journal enrollment (closure state).
			let unchangedHeldCensus, mayPrepareUnchanged = false, journalCurrent;
			const census = ${s.variable(s.fn("sealCreatorRecoveryDependencies"), "census").split(" = ").slice(1).join(" = ")};
			const facts = {kind: "full-census", context: registration, pending: new Set(), releasing: false, dependencyAnchors: [], exactCanonicalCensusBytes: sealed, ${s.check}, ${s.factory}};
			recoveryCloseHolds.set(capability, facts);
			${s.fn("fullRecoveryCloseHoldFacts").getText(s.file)}
			${s.fn("resolveRecoveryCloseHold").getText(s.file)}
			({facts, lifetime: resolveRecoveryCloseHold(capability, owners), held: () => issuanceRead});`, {
			ObjectFreeze: Object.freeze, registration, currentTrust: trust, capability, recoveryCloseHolds: registry,
			owners: {store, liveJournalStore: journal, currentTrust: trust}, sealed: bytes, live: () => state.live,
			sameBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0,
			// No source/branch/migration dependency: enrollment may prepare the fast
			// cell after its first full held check. The controlled preparer declines
			// (undefined), so every check stays the original full held walk.
			sourceDependencies: undefined, activeSource: undefined, runtime: {nativeBranchSource: undefined, migrationSource: undefined},
			replay: undefined, readJournalCurrent: undefined,
			prepareCreatorUnchangedHeldCensusRead: (..._args: unknown[]) => {state.prepared++; return undefined;},
			captureCensus: async (held?: Held) => {state.captures++; events.push(held === undefined ? "unheld-census" : "held-census");
				if (held !== undefined) expect(held.store).toBe(issuanceStore); await state.capture?.(); return state.changed ? encodeCanonical({completeCensus: "changed"}) : bytes;},
		});
		return {...owner, state, events, original};
	}
	it("enrolls the original acquired reservation and preserves before/after currentness and detached plan fallback", async () => {
		const f = fixture(), acquired = deferred(), resume = deferred(); f.state.acquire = async () => {acquired.resolve(); await resume.promise;};
		const acquiring = f.lifetime.acquireNativeIssuanceReservation(); await acquired.promise; expect(f.facts.pending.size).toBe(1); expect(f.held()).toBeUndefined();
		resume.resolve(); const child = await acquiring; expect(child).not.toBe(f.original); expect(f.held()?.available()).toBe(true); expect(f.facts.pending.size).toBe(0);
		await f.lifetime.check(); expect(f.events).toEqual(["native-check", "held-census", "native-check"]);
		expect(f.state.prepared).toBe(1); // Only after the first complete held check.
		f.state.changed = true; await expect(f.lifetime.check()).rejects.toThrow("stale or unclassified"); expect(f.state.checks).toBe(4);
		f.state.changed = false; f.state.failCheck = 5; const before = f.state.captures;
		await expect(f.lifetime.check()).rejects.toThrow("native-currentness-failed"); expect(f.state.captures).toBe(before);
		f.state.failCheck = 7; await expect(f.lifetime.check()).rejects.toThrow("native-currentness-failed"); expect(f.state.captures).toBe(before + 1);
		await child.release(); await f.lifetime.release(); expect(f.state.releases).toBe(1);
	});
	it("keeps the revoked child as a zero-native-admission sentinel until physical release joins", async () => {
		const f = fixture(), child = await f.lifetime.acquireNativeIssuanceReservation(), entered = deferred(), resume = deferred();
		f.state.release = async () => {entered.resolve(); await resume.promise;}; const releasing = child.release(); await entered.promise;
		const held = f.held(); expect(held).toBeDefined(); expect(held?.available()).toBe(false);
		const before = {checks: f.state.checks, captures: f.state.captures};
		await expect(f.lifetime.check()).rejects.toThrow("unavailable"); await expect(child.check()).rejects.toThrow("unavailable");
		expect(f.state.checks).toBe(before.checks); expect(f.state.captures).toBe(before.captures); expect(f.held()).toBe(held);
		resume.resolve(); await releasing; expect(f.held()).toBeUndefined(); await f.lifetime.check();
		expect(f.events).toEqual(["native-release", "unheld-census"]); expect(f.state.releases).toBe(1); await f.lifetime.release();
	});
	it("tracks an entered census in parent and child and joins it before exactly one physical cleanup", async () => {
		const f = fixture(), child = await f.lifetime.acquireNativeIssuanceReservation(), entered = deferred(), resume = deferred();
		f.state.capture = async () => {entered.resolve(); await resume.promise;};
		const task = f.lifetime.check(), observed = task.catch(error => error); await entered.promise; expect(f.facts.pending.size).toBe(2);
		const releasing = f.lifetime.release(); let joined = false; void releasing.then(() => {joined = true;});
		await expect(f.lifetime.check()).rejects.toThrow("unavailable"); await expect(child.check()).rejects.toThrow("unavailable");
		expect(f.state.releases).toBe(0); expect(joined).toBe(false); resume.resolve(); expect(await observed).toBeInstanceOf(TypeError);
		await releasing; expect(joined).toBe(true); expect(f.state.releases).toBe(1); expect(f.facts.pending.size).toBe(0);
		await child.release(); await f.lifetime.release(); expect(f.state.releases).toBe(1);
	});
	it("reuses only detached eligible plans per census and keeps final plan/PRE and native currency reads direct", async () => {
		const {copySettlementPlan, cloneSettlementPlan} = await import("@ts-drp/issuance-store");
		const s = seam(), scope = {objectId: "room", author: "writer"};
		const raw = {scope, revision: 0, fenceSequence: null, entries: [{disposition: "expire" as const, sourceSequence: 0, replacementSequence: null, sourceDigest: Uint8Array.of(1, 2)}]};
		expect(copySettlementPlan(raw, scope)).toBeDefined();
		const planOwner = (mode: "held" | "unheld" | "foreign" | "malformed" | "oversize" | "capacity" | "mismatch") => {
			let reads = 0, available = true;
			const value = mode === "malformed" ? {...raw, revision: -1} : cloneSettlementPlan(raw);
			const store = {readSettlementPlan: async () => {reads++; return value;}};
			const held: Held | undefined = mode === "unheld" ? undefined : {store: mode === "foreign" ? {} : store, objectId: scope.objectId, available: () => available, read: async consume => consume()};
			const native = mode === "mismatch" ? {...raw, revision: 1} : raw;
			const read = execute<(scope: typeof raw.scope) => Promise<typeof raw | null>>(`
				const plans = new Map(), reusablePlanAuthors = new Set(); let retainedPlanBytes = 0;
				const ${s.variable(s.census, "heldPlans")}; const ${s.variable(s.census, "readPlan")}; readPlan;`, {
				registration: {issuanceStore: store, payload: {provenance: {objectId: scope.objectId}, parameters: {maxEpochVertices: mode === "oversize" ? 0 : 8}}},
				heldIssuance: held, nativeRows: {plans: [native]}, activeObservation: true, copySettlementPlan, cloneSettlementPlan,
				sameScope: (a: typeof scope, b: typeof scope) => a.objectId === b.objectId && a.author === b.author,
				sameBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0,
				ISSUANCE_RETIREMENT_LIMITS: {maxRows: 8}, AHE_BOUNDED_READ_LIMITS: {maxUnionBytes: mode === "capacity" ? 0 : AHE_BOUNDED_READ_LIMITS.maxUnionBytes},
			}); return {read, value, reads: () => reads, revoke: () => {available = false;}};
		};
		const held = planOwner("held"), first = await held.read(scope); first!.entries[0]!.sourceDigest.fill(9); first!.scope.author = "tampered";
		const next = await held.read(scope); expect(next).toEqual(raw); expect(held.value).toEqual(raw); expect(held.reads()).toBe(1);
		held.revoke(); await expect(held.read(scope)).rejects.toThrow("unavailable"); expect(held.reads()).toBe(1);
		for (const mode of ["unheld", "foreign", "malformed", "oversize", "capacity", "mismatch"] as const) {
			const f = planOwner(mode); await f.read(scope); await f.read(scope); expect(f.reads()).toBe(2);
		}
		const wrongScope = planOwner("held"); await wrongScope.read({...scope, objectId: "other-room"}); await wrongScope.read({...scope, objectId: "other-room"}); expect(wrongScope.reads()).toBe(2);
		const text = s.census.getText(s.file);
		expect(text).toContain("const rawPlan = await registration.issuanceStore.readSettlementPlan(scope)");
		expect(text).toContain("plan === undefined || !sameBytes(encodeCanonical(plans.get(scope.author)), encodeCanonical(plan))");
		expect(text).toContain("const issued = await registration.issuanceStore.readIssued(scope, chunk.replacementSequence)");
		expect(text).toContain("await replay.verify()");
	});
	function censusPairing(mode: "held" | "unheld" | "foreign-store" | "foreign-object" = "held") {
		const s = seam(), scope = {objectId: "room", author: "writer"};
		const row = {scope, authorSequence: 2, publishState: "published" as const,
			canonicalPreimageBytes: Uint8Array.of(1, 2), digest: new Uint8Array(32).fill(3), signature: new Uint8Array(64).fill(4)};
		const nativeRows = {issued: [{...scope, authorSequence: row.authorSequence,
			canonicalPreimageBytes: row.canonicalPreimageBytes.slice(), digest: row.digest.slice(), signature: row.signature.slice()}],
			outbox: [{...scope, authorSequence: row.authorSequence, digest: row.digest.slice(), publishState: row.publishState as "pending" | "published"}]};
		let reads = 0, available = true;
		const store = {readIssued: async () => {
			reads++;
			const envelope = {canonicalPreimageBytes: row.canonicalPreimageBytes.slice(), digest: row.digest.slice(), signature: row.signature.slice()};
			return {authorSequence: row.authorSequence, envelope,
				issuedRecord: {scope: {...scope}, authorSequence: row.authorSequence, envelope},
				outboxEntry: {scope: {...scope}, authorSequence: row.authorSequence, envelope}};
		}};
		const held = mode === "unheld" ? undefined : {store: mode === "foreign-store" ? {} : store,
			objectId: mode === "foreign-object" ? "another-room" : scope.objectId, available: () => available};
		const text = s.census.getText(s.file), begin = text.indexOf("const nativeIssued = nativeRows.issued.find("),
			end = text.indexOf("let visible = visibleNative.get", begin);
		if (begin < 0 || end < begin || text.indexOf("const nativeIssued = nativeRows.issued.find(", begin + 1) !== -1)
			throw Error("CENSUS_PAIRING_BLOCK_NOT_UNIQUE");
		const constants = ["SIGNED_ENVELOPE_KEYS", "OUTBOX_RECORD_KEYS", "ISSUE_COMMIT_KEYS", "ISSUE_COMMIT_WITH_PLAN_EFFECT_KEYS",
			"ISSUED_RECORD_KEYS", "OUTBOX_ENTRY_KEYS", "ISSUANCE_SCOPE_KEYS"];
		const functions = ["isObject", "snapshotClosedRecord", "isInstanceOf", "typedArrayBuffer", "typedArrayByteLength",
			"copyDetachedBytes", "envelopeSnapshot", "copiedScope", "outboxRowSnapshot"];
		const typed = Object.getPrototypeOf(Uint8Array.prototype);
		// Execute the original pairing/capture code. Controlled native records
		// test data ownership and dispatch, not signature or native acceptance.
		const read = execute<() => Promise<typeof row | undefined>>(`
			${constants.map(name => `const ${s.variable(s.file, name)};`).join("\n")}
			${functions.map(name => s.fn(name).getText(s.file)).join("\n")}
			(async () => {const ${s.variable(s.census, "heldPlans")}; ${text.slice(begin, end)} return paired;});`, {
			nativeRows, row, scope, heldIssuance: held, registration: {issuanceStore: store, payload: {provenance: {objectId: scope.objectId}}},
			ObjectFreeze: Object.freeze, ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectPrototype: Object.prototype,
			ObjectCreate: Object.create, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			ObjectDefineProperty: Object.defineProperty, ReflectOwnKeys: Reflect.ownKeys, ReflectApply: Reflect.apply,
			FunctionHasInstance: Function.prototype[Symbol.hasInstance], Uint8ArrayConstructor: Uint8Array,
			SharedArrayBufferConstructor: SharedArrayBuffer, NumberIsSafeInteger: Number.isSafeInteger,
			TypedArrayBufferGetter: Object.getOwnPropertyDescriptor(typed, "buffer")!.get,
			TypedArrayByteLengthGetter: Object.getOwnPropertyDescriptor(typed, "byteLength")!.get,
			sameScope: (a: typeof scope, b: typeof scope) => a.objectId === b.objectId && a.author === b.author,
			sameBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0,
			matchingOutboxRows: (a: typeof row, b: typeof row) => a.scope.objectId === b.scope.objectId && a.scope.author === b.scope.author &&
				a.authorSequence === b.authorSequence && a.publishState === b.publishState &&
				Buffer.compare(a.canonicalPreimageBytes, b.canonicalPreimageBytes) === 0 && Buffer.compare(a.digest, b.digest) === 0 &&
				Buffer.compare(a.signature, b.signature) === 0,
		});
		return {read, row, nativeRows, reads: () => reads, revoke: () => {available = false;}};
	}
	it("pairs from this turn's complete native census only under the same held owner and detaches every returned byte", async () => {
		const f = censusPairing(), first = await f.read(); expect(first).toEqual(f.row); expect(f.reads()).toBe(0);
		first!.canonicalPreimageBytes.fill(9); first!.digest.fill(9); first!.signature.fill(9);
		expect(await f.read()).toEqual(f.row); expect(f.nativeRows.issued[0]!.canonicalPreimageBytes).toEqual(Uint8Array.of(1, 2));
		f.row.canonicalPreimageBytes[0] = 8; f.nativeRows.issued[0]!.canonicalPreimageBytes[0] = 8;
		expect((await f.read())!.canonicalPreimageBytes).toEqual(Uint8Array.of(8, 2)); // Fresh capture, not retained pairing.
		expect(f.reads()).toBe(0);
	});
	it("keeps the original direct issued read for unheld or differently owned census captures", async () => {
		for (const mode of ["unheld", "foreign-store", "foreign-object"] as const) {
			const f = censusPairing(mode); expect(await f.read()).toEqual(f.row); expect(f.reads()).toBe(1);
		}
	});
	it("refuses revoked loans and missing or changed native issued/outbox evidence before pairing can escape", async () => {
		const revoked = censusPairing(); revoked.revoke(); await expect(revoked.read()).rejects.toThrow("unavailable"); expect(revoked.reads()).toBe(0);
		for (const mutation of ["missing", "foreign", "preimage", "signature", "outbox-digest", "outbox-state"] as const) {
			const f = censusPairing();
			if (mutation === "missing") f.nativeRows.issued.length = 0;
			if (mutation === "foreign") f.nativeRows.issued[0]!.objectId = "foreign";
			if (mutation === "preimage") f.nativeRows.issued[0]!.canonicalPreimageBytes[0] ^= 1;
			if (mutation === "signature") f.nativeRows.issued[0]!.signature[0] ^= 1;
			if (mutation === "outbox-digest") f.nativeRows.outbox[0]!.digest[0] ^= 1;
			if (mutation === "outbox-state") f.nativeRows.outbox[0]!.publishState = "pending";
			expect(await f.read(), mutation).toBeUndefined(); expect(f.reads()).toBe(0);
		}
	});
	it("joins direct child release during an entered census and preserves its refusal cause before clearing the sentinel", async () => {
		const f = fixture(), child = await f.lifetime.acquireNativeIssuanceReservation();
		const entered = deferred(), resumeRead = deferred(), cleanupEntered = deferred(), resumeCleanup = deferred();
		f.state.capture = async () => {entered.resolve(); await resumeRead.promise;};
		f.state.release = async () => {cleanupEntered.resolve(); await resumeCleanup.promise;};
		const reading = f.lifetime.check(), readOutcome = reading.catch(error => error); await entered.promise;
		const held = f.held(), releasing = child.release(), releaseOutcome = releasing.catch(error => error);
		expect(held?.available()).toBe(false); expect(f.held()).toBe(held); expect(f.state.releases).toBe(0);
		const before = {checks: f.state.checks, captures: f.state.captures};
		await expect(child.check()).rejects.toThrow("unavailable"); await expect(f.lifetime.check()).rejects.toThrow("unavailable");
		expect(f.state.checks).toBe(before.checks); expect(f.state.captures).toBe(before.captures); expect(f.state.releases).toBe(0);
		resumeRead.resolve(); const refused = await readOutcome; expect(refused).toBeInstanceOf(TypeError); expect(refused.message).toContain("unavailable");
		await cleanupEntered.promise; expect(f.state.checks).toBe(before.checks + 1); expect(f.state.releases).toBe(1);
		expect(f.held()).toBe(held); let joined = false; void releaseOutcome.then(() => {joined = true;});
		await expect(f.lifetime.check()).rejects.toThrow("unavailable"); expect(joined).toBe(false);
		expect(f.state.checks).toBe(before.checks + 1); expect(f.state.captures).toBe(before.captures);
		resumeCleanup.resolve(); const failedRelease = await releaseOutcome;
		expect(failedRelease).toBeInstanceOf(AggregateError); expect(failedRelease.cause).toBe(refused); expect(failedRelease.errors).toEqual([refused]);
		expect(f.held()).toBeUndefined(); expect(f.facts.pending.size).toBe(0); f.state.capture = undefined;
		await f.lifetime.check(); expect(f.events.at(-1)).toBe("unheld-census"); expect(f.state.captures).toBe(before.captures + 1);
		await f.lifetime.release(); expect(f.state.releases).toBe(1);
	});
});

describe("transition inspect-tree synchronous syntax reuse affected controls", () => {
	type Candidate = RollbackScalarCandidate;
	type Closure = {candidates: Candidate[]; closure: Candidate["ref"][]};
	type Trust = {objectId: string; currentEpoch: number; currentAnchorDigest: string; genesisAnchorDigest: string; profileId: string};
	type Input = {current: Closure; proposed: Closure; currentTrust: Trust; successorTrust: Trust; proofRefs: Candidate["ref"][];
		mode: "stage" | "verify"; settlementAcl?: {current: Uint8Array; successor: Uint8Array}};
	type Result = {ok: boolean; reason?: string; proposed?: Closure};
	const digest = (domain: string, bytes: Uint8Array) => Buffer.from(hashDomain(domain, bytes)).toString("hex");
	async function fixture(cold = false) {
		const controls = await import("@ts-drp/protocol-v3/creator-author-issuance-frontiers");
		const {CREATOR_ISSUANCE_RETIREMENT_KIND} = await import("@ts-drp/protocol-v3/creator-issuance-retirement");
		const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`TRANSITION_INSPECT_HELPER_NOT_UNIQUE:${name}:${found.length}`); return found[0]!.getText(file).replace(/^export /, "");
		};
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxFile = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const reader = syntaxFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (reader === undefined) throw Error("TRANSITION_INSPECT_READER_MISSING");
		let inspect = extract("inspectCreatorTransitionAdvanceOwned");
		if (inspect.split("const syntax = sharedSyntax ?? createCreatorCanonicalSyntaxReader();").length !== 2) throw Error("TRANSITION_INSPECT_OWNER_NOT_UNIQUE");
		if (cold) inspect = inspect.replace("const syntax = sharedSyntax ?? createCreatorCanonicalSyntaxReader();", "const syntax = undefined;");
		// Preserve the original catch/refusal while exposing fixture linkage
		// errors rather than confusing them with a product validation refusal.
		const caught: string[] = [];
		const originalCatch = '} catch {\n\t\treturn failure("TRUST_CLOSURE_INVALID");';
		if (inspect.split(originalCatch).length !== 2) throw Error("TRANSITION_INSPECT_CATCH_NOT_UNIQUE");
		inspect = inspect.replace(originalCatch, '} catch (error) { reportCaught(error);\n\t\treturn failure("TRUST_CLOSURE_INVALID");');
		const stats = {decodes: 0, owners: 0}, calls: {kind: string; input: unknown}[] = [], identities = new WeakMap<object, Record<string, unknown>>();
		const state = {afterOpen: undefined as (() => void) | undefined};
		const owner = execute<{inspect(input: Input): Result; inspectWith(input: Input, syntax: ReturnType<typeof createCreatorCanonicalSyntaxReader>): Result;
			job(): {readonly syntax: ReturnType<typeof createCreatorCanonicalSyntaxReader> | undefined; release(): void};
			record(candidate: Candidate, syntax?: ReturnType<typeof createCreatorCanonicalSyntaxReader>): Readonly<Record<string, unknown>> | undefined;
			select(candidates: Candidate[], kind: string, epoch?: number, phase?: string, syntax?: ReturnType<typeof createCreatorCanonicalSyntaxReader>): Candidate | undefined;
			reader(): ReturnType<typeof createCreatorCanonicalSyntaxReader>}>(`
			${reader.getText(syntaxFile).replace(/^export /, "").replace("function createCreatorCanonicalSyntaxReader(", "function originalSyntaxReader(")}
			const createCreatorCanonicalSyntaxReader = () => { countOwner(); return originalSyntaxReader(); };
			${["record", "candidateSelection", "candidateMetadata", "sameRef", "compareRef", "exactCandidate", "hex", "failure", "uniqueCreatorTransitionCandidate",
				"exactCreatorTransitionOccurrence", "retirementCandidates", "aggregateCandidates", "settlementCandidates", "currentAnchorAclDigest",
				"openCreatorTransitionSettlement", "openCreatorTransitionSettlementOwned", "authenticatedSettlementPair"].map(extract).join("\n")}
			${inspect}
			${extract("inspectCreatorTransitionAdvance")}
			${extract("createCreatorRecoveryEvidenceOwner")}
			${extract("createCreatorSnapshotRecoveryEvidenceJob")}
			({inspect: inspectCreatorTransitionAdvance, inspectWith: (input, syntax) => inspectCreatorTransitionAdvanceOwned(input, openCreatorTransitionSettlement, syntax),
			 job: createCreatorSnapshotRecoveryEvidenceJob, record, select: uniqueCreatorTransitionCandidate, reader: createCreatorCanonicalSyntaxReader});`, {
			...controls, CREATOR_ISSUANCE_RETIREMENT_KIND, AHE_BOUNDED_READ_LIMITS, digestBlob, hashDomain, countOwner: () => {stats.owners++;},
			reportCaught: (error: unknown) => {caught.push(String(error));},
			decodeCanonical: (bytes: Uint8Array) => {stats.decodes++; return decodeCanonical(bytes);},
			settlementProfileFor: (profile: string) => profile === "creator-trusted-settlement-v1" ? "v1" : "none",
			// Explicit controlled crypto/control-plane seams. The actual parsing,
			// selection, pair, exact-ref, context and control-opener guards above
			// execute unchanged. These results are NOT signature/native acceptance.
			openCreatorAuthorSettlement: (input: {exactCanonicalRecordBytes: Uint8Array; floorTrust: Trust}) => {
				calls.push({kind: "settlement-open", input}); const value = decodeCanonical(input.exactCanonicalRecordBytes) as {identity: Record<string, unknown>};
				const capability = {}; identities.set(capability, value.identity); state.afterOpen?.(); return {ok: true, capability};
			}, resolveCreatorAuthorSettlement: (capability: object) => identities.get(capability),
			openCanonicalLatchedAclSnapshot: (input: {exactCanonicalLatchedAclBytes: Uint8Array}) => {calls.push({kind: "acl-open", input}); return {ok: true, snapshot: decodeCanonical(input.exactCanonicalLatchedAclBytes)};},
			inspectCreatorAuthorSettlementAdvance: (input: unknown) => {calls.push({kind: "settlement-advance", input}); return {ok: true};},
			inspectBoundedCreatorTrustAdvance: (input: unknown) => {calls.push({kind: "bounded-advance", input}); return {ok: true, kind: "successor"};},
			inspectCreatorTrustAdvance: () => {throw Error("UNEXPECTED_GENESIS_ADVANCE");},
		});
		const acl = (epoch: number) => encodeCanonical({kind: "drp-v3-latched-acl", epoch, objectId: "room", members: ["writer"]});
		const a0 = acl(0), a1 = acl(1), a2 = acl(2), anchor = encodeCanonical({kind: "drp-epoch-anchor", objectId: "room", epoch: 1, aclDigest: digest("ts-drp/latched-acl/v3", a1)});
		const currentTrust: Trust = {objectId: "room", currentEpoch: 1, currentAnchorDigest: digest("ts-drp/epoch-anchor/v3", anchor), genesisAnchorDigest: "a".repeat(64), profileId: "creator-trusted-settlement-v1"};
		const successorTrust = {...currentTrust, currentEpoch: 2, currentAnchorDigest: "b".repeat(64)};
		const c0 = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", objectId: "room", epoch: 0, previousAnchor: currentTrust.genesisAnchorDigest, snapshotManifestDigest: "c".repeat(64), historyRoot: "d".repeat(64), historySize: 1});
		const c1 = rollbackScalarCandidate({...decodeCanonical(c0.bytes) as object, epoch: 1, previousAnchor: currentTrust.currentAnchorDigest, historySize: 2});
		const q0 = rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 0, phase: "commit"}), q1 = rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 1, phase: "commit"});
		const identity = (epoch: number) => ({objectId: "room", closedEpoch: epoch, closedAnchorDigest: epoch === 0 ? currentTrust.genesisAnchorDigest : currentTrust.currentAnchorDigest,
			successorEpoch: epoch + 1, successorAnchorDigest: epoch === 0 ? currentTrust.currentAnchorDigest : successorTrust.currentAnchorDigest,
			historyRoot: "d".repeat(64), historySize: epoch + 1, successorAclDigest: digest("ts-drp/latched-acl/v3", epoch === 0 ? a1 : a2), frontiers: [["writer", 0, null]],
			priorCheckpointKind: epoch === 0 ? "genesis" : "settled-v1", priorCheckpointDigest: controls.CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL});
		const s0 = rollbackScalarCandidate({kind: controls.CREATOR_AUTHOR_SETTLEMENT_KIND, successorAclDigest: identity(0).successorAclDigest, identity: identity(0)});
		const s1 = rollbackScalarCandidate({kind: controls.CREATOR_AUTHOR_SETTLEMENT_KIND, successorAclDigest: identity(1).successorAclDigest, identity: {...identity(1), priorCheckpointDigest: s0.ref.digest}});
		const trust = rollbackScalarCandidate({kind: "drp-anchor-trust-state", ...currentTrust, exactCanonicalCurrentAnchorPreimageBytes: anchor, nested: {bytes: Uint8Array.of(7, 9), members: ["writer"]}});
		const oldAcl = rollbackScalarCandidate(decodeCanonical(a0));
		const current = rollbackScalarClosure([s0, q0, trust, oldAcl, c0]), proposed = rollbackScalarClosure([c1, oldAcl, s1, q0, q1, c0]);
		const input: Input = {current, proposed, currentTrust, successorTrust, proofRefs: [c1.ref, q1.ref], mode: "verify", settlementAcl: {current: a1, successor: a2}};
		return {owner, input, stats, calls, caught, state, trust, c1, q1, s1, file, extract};
	}
	it("shares the actual finite job representation across complete transition passes and revokes retained reader aliases", async () => {
		const fast = await fixture(), cold = await fixture(true), job = fast.owner.job(), syntax = job.syntax!;
		// The original acquisition already selected these exact candidates before
		// certificate readback. Pay that whole syntax capture once, not once per
		// semantic consumer. This supplies no crypto result or native authority.
		for (const candidate of [...fast.input.current.candidates, ...fast.input.proposed.candidates]) syntax.canonicalSelection(candidate.bytes);
		const captured = fast.stats.decodes;
		const first = fast.owner.inspectWith(fast.input, syntax), original = cold.owner.inspect(cold.input);
		expect(first.ok, JSON.stringify(fast.caught)).toBe(true); expect(first).toEqual(original);
		const firstPass = fast.stats.decodes - captured;
		const before = fast.stats.decodes;
		expect(fast.owner.inspectWith(fast.input, syntax)).toEqual(cold.owner.inspect(cold.input));
		expect(fast.stats.decodes - before).toBe(0);
		expect(firstPass).toBe(1); // Only the nested actual anchor was not selected above.
		expect(fast.stats.owners).toBe(1); expect(fast.calls).toEqual(cold.calls);
		expect(fast.calls.filter(call => call.kind === "settlement-open")).toHaveLength(4);
		expect(fast.calls.filter(call => call.kind === "acl-open")).toHaveLength(4);
		job.release(); expect(job.syntax).toBeUndefined();
		const released = fast.stats.decodes;
		expect(fast.owner.inspectWith(fast.input, syntax)).toEqual(cold.owner.inspect(cold.input));
		expect(fast.stats.decodes).toBeGreaterThan(released);
		expect(fast.calls).toEqual(cold.calls);
	});
	it("matches the actual cold stage/verify tree, order and original opener calls while reusing repeated private parsing", async () => {
		for (const mode of ["stage", "verify"] as const) {
			const fast = await fixture(), cold = await fixture(true); fast.input.mode = mode; cold.input.mode = mode;
			const actual = fast.owner.inspect(fast.input), original = cold.owner.inspect(cold.input);
			expect(actual.ok, JSON.stringify({actual, original, fastCaught: fast.caught, coldCaught: cold.caught})).toBe(true); expect(actual).toEqual(original);
			expect(fast.caught).toEqual([]); expect(cold.caught).toEqual([]);
			expect(fast.calls).toEqual(cold.calls); expect(fast.calls.filter(call => call.kind === "settlement-open")).toHaveLength(2);
			expect(fast.stats.owners).toBe(1); expect(cold.stats.owners).toBe(0); expect(fast.stats.decodes).toBeLessThan(cold.stats.decodes);
			if (mode === "stage") expect(actual.proposed!.closure.map(ref => ref.digest)).toEqual(actual.proposed!.closure.map(ref => ref.digest).slice().sort());
			else expect(actual.proposed).toBe(fast.input.proposed);
			const previous = fast.stats.decodes; expect(fast.owner.inspect(fast.input)).toEqual(actual); expect(fast.stats.owners).toBe(2); expect(fast.stats.decodes).toBe(previous * 2);
		}
	});
	it("retains ambiguity, exact occurrences, changed refs and trust/context/floor refusals rather than caching authority", async () => {
		const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
			f => {f.input.proposed.candidates.push(f.s1);}, f => {f.input.proposed.closure.push(f.s1.ref);},
			f => {f.input.proposed.closure = f.input.proposed.closure.filter(ref => ref.digest !== f.s1.ref.digest);},
			f => {f.c1.ref = {...f.c1.ref, byteLength: f.c1.ref.byteLength + 1}; f.input.proofRefs[0] = f.c1.ref;},
			f => {f.input.currentTrust.objectId = "foreign";}, f => {f.input.currentTrust.currentAnchorDigest = "f".repeat(64);},
			f => {f.input.successorTrust.currentEpoch = 3;}, f => {f.input.successorTrust.currentAnchorDigest = "f".repeat(64);},
		];
		for (const change of changes) {
			const fast = await fixture(), cold = await fixture(true); change(fast); change(cold);
			const actual = fast.owner.inspect(fast.input); expect(actual.ok).toBe(false); expect(actual).toEqual(cold.owner.inspect(cold.input)); expect(fast.calls).toEqual(cold.calls);
		}
	});
	it("invalidates same-buffer syntax during the tree and keeps full outputs detached from private decode facts", async () => {
		const fast = await fixture(), cold = await fixture(true);
		for (const f of [fast, cold]) {
			f.state.afterOpen = () => {f.state.afterOpen = undefined;
				const changed = encodeCanonical({...decodeCanonical(f.trust.bytes) as object, currentEpoch: 2}); expect(changed.length).toBe(f.trust.bytes.length); f.trust.bytes.set(changed);};
		}
		const actual = fast.owner.inspect(fast.input); expect(actual).toEqual(cold.owner.inspect(cold.input)); expect(actual).toEqual({ok: false, reason: "RETIRING_PROOF_REFS_INVALID"});
		const f = await fixture(), syntax = f.owner.reader(), before = f.owner.record(f.trust, syntax)!;
		(before.nested as {bytes: Uint8Array; members: string[]}).bytes.fill(99); (before.nested as {members: string[]}).members.push("tampered");
		expect(f.owner.record(f.trust, syntax)).toEqual(f.owner.record(f.trust));
		const changed = encodeCanonical({...decodeCanonical(f.trust.bytes) as object, currentEpoch: 2}); f.trust.bytes.set(changed);
		expect(f.owner.select([f.trust], "drp-anchor-trust-state", 1, undefined, syntax)).toBeUndefined(); expect(f.owner.select([f.trust], "drp-anchor-trust-state", 2, undefined, syntax)).toBe(f.trust);
	});
	it("preserves decode-only UTF8/BOM and original codec limits without adding a canonical roundtrip requirement", async () => {
		const f = await fixture(), syntax = f.owner.reader(), invalidUtf8 = encodeCanonical("x"); invalidUtf8[invalidUtf8.length - 1] = 255;
		let deep: unknown = 1; for (let level = 0; level < 130; level++) deep = {nested: deep};
		const inputs = [invalidUtf8, Uint8Array.of(255), encodeCanonical({kind: "drp-hard-epoch-cut", epoch: 1, payload: "\ufeff"}),
			encodeCanonical({kind: "\ufeffdrp-hard-epoch-cut", epoch: 1}), encodeCanonical(deep, {maxDepth: 256}),
			encodeCanonical(Array(1_000_001).fill(1), {maxItems: 1_000_002})];
		for (const bytes of inputs) {
			const candidate = rollbackScalarCandidate(null); candidate.bytes = bytes; const ref = digestBlob(bytes); if (!ref.ok) throw Error("TRANSITION_CODEC_DIGEST"); candidate.ref = {digest: ref.value, byteLength: bytes.length};
			expect(f.owner.record(candidate, syntax)).toEqual(f.owner.record(candidate));
			expect(f.owner.select([candidate], "drp-hard-epoch-cut", 1, undefined, syntax)).toEqual(f.owner.select([candidate], "drp-hard-epoch-cut", 1));
		}
		const bom = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 1, payload: "\ufeff"}); expect(f.owner.record(bom, syntax)).toBeDefined();
		expect(f.owner.select([bom], "drp-hard-epoch-cut", 1, undefined, syntax)).toBe(bom);
		// Original exported cryptographic openers remain cold; the new optional
		// owner is confined to private inspection helpers and existing selector.
		for (const [name, count] of [["openCreatorTransitionRetirement", 4], ["openCreatorTransitionAggregate", 5], ["openCreatorTransitionSettlement", 5]] as const) {
			const declaration = f.file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
			expect(declaration.parameters).toHaveLength(count); expect(f.extract(name)).not.toContain("syntax");
		}
	});
});

describe("recovery-role readback metadata syntax affected controls", () => {
	type Candidate = RollbackScalarCandidate;
	type Closure = RollbackScalarClosure;
	type Metadata = {ok: boolean; reason?: string; carrier?: Candidate; cut?: Candidate; qc?: Candidate; priorCarrier?: Candidate; priorCut?: Candidate;
		cutRecord?: Readonly<Record<string, unknown>>; priorRecord?: Readonly<Record<string, unknown>>; pinRecord?: Readonly<Record<string, unknown>>;
		projectionRecord?: Readonly<Record<string, unknown>>; liveProjections?: number; currentProjections?: number};
	async function owner(cold = false, retainBytes: number = AHE_BOUNDED_READ_LIMITS.maxUnionBytes) {
		const promotion = await import("@ts-drp/protocol-v3/internal/creator-forward-promotion");
		const {openSealAuthority} = await import("@ts-drp/protocol-v3/seal");
		const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const fn = (name: string) => {const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`READBACK_METADATA_HELPER:${name}:${found.length}`); return found[0]!;};
		const readback = fn("openCreatorSnapshotRecoveryRoleReadbackOwned"), body = readback.body!.statements.find(ts.isTryStatement)!.tryBlock;
		const statement = (name: string) => {const found = body.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
			if (found.length !== 1) throw Error(`READBACK_METADATA_STATEMENT:${name}:${found.length}`); return found[0]!.getText(file);};
		const lineage = body.statements.find((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file).startsWith("carrier === undefined"));
		const materialLoop = body.statements.find((node): node is ts.ForOfStatement => ts.isForOfStatement(node) && node.expression.getText(file) === "materialValues");
		if (lineage === undefined || materialLoop === undefined || !ts.isBlock(materialLoop.statement)) throw Error("READBACK_METADATA_GUARDS_MISSING");
		const context = materialLoop.statement.statements.find((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file).includes("cRecord?.currentAnchorDigest"));
		const epoch = body.statements.find((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file).includes("n < 3"));
		const filters: ts.CallExpression[] = []; const visit = (node: ts.Node): void => {if (ts.isCallExpression(node) && node.expression.getText(file).endsWith("candidates.filter") && node.getText(file).includes('candidateSelection(value, syntax)?.kind === "v3-live-generation-2"')) filters.push(node); ts.forEachChild(node, visit);}; visit(readback);
		if (context === undefined || epoch === undefined || filters.length !== 2) throw Error("READBACK_METADATA_CONTEXT_NOT_UNIQUE");
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxFile = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const syntaxFunctions = ["canonicalCreatorDataRecord", "createCreatorCanonicalSyntaxReader"].map(name => {
			const declaration = syntaxFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (declaration === undefined) throw Error(`READBACK_SYNTAX_HELPER:${name}`); return declaration.getText(syntaxFile).replace(/^export /, "");
		});
		let decodes = 0;
		const result = execute<{read(current: Closure, predecessor: Closure, live: Closure, n: number, pinBytes: Uint8Array): Metadata;
			capture(value: unknown): Closure | undefined; record(candidate: Candidate): Readonly<Record<string, unknown>> | undefined;
			context(c: Candidate, cRecord: unknown, original: unknown, closedIdentity: unknown, currentTrust: unknown): boolean;
			epoch(n: number): boolean; genuine(trust: unknown, pinBytes: Uint8Array): boolean}>(`
			${syntaxFunctions.join("\n")}
			${["record", "candidateSelection", "sameRef", "exactCandidate", "exactCreatorTransitionOccurrence", "uniqueCreatorTransitionCandidate", "failure", "capturePromotionClosure", "genuineRecoveryTrust"].map(name => fn(name).getText(file).replace(/^export /, "")).join("\n")}
			const syntax = ${cold ? "undefined" : "createCreatorCanonicalSyntaxReader()"};
			${statement("select")}
			({read: (current, predecessor, live, n, pinBytes) => {
				${statement("carrier")} ${lineage.getText(file)} ${statement("cutRecord")} ${statement("projection")} ${statement("projectionRecord")}
				return {ok: true, carrier, cut, qc, priorCarrier, priorCut, cutRecord, priorRecord, pinRecord, projectionRecord,
					liveProjections: ${filters[0]!.getText(file)}.length, currentProjections: ${filters[1]!.getText(file)}.length};
			}, capture: value => capturePromotionClosure(value, () => true), record: candidate => record(candidate, syntax),
			context: (c, cRecord, original, closedIdentity, currentTrust) => !(${context.expression.getText(file)}),
			epoch: n => !(${epoch.expression.getText(file)}), genuine: genuineRecoveryTrust});`, {
			...promotion, openSealAuthority, digestBlob, AHE_BOUNDED_READ_LIMITS: {...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: retainBytes},
			decodeCanonical: (bytes: Uint8Array) => {decodes++; return decodeCanonical(bytes);},
		});
		return {...result, decodes: () => decodes, source: readback.getText(file)};
	}
	function material() {
		const trust = rollbackScalarCandidate({kind: "drp-anchor-trust-state", currentEpoch: 4, objectId: "room", currentAnchorDigest: "a".repeat(64), genesisAnchorDigest: "b".repeat(64), profileId: "profile"});
		const cut = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 3, recoveryRoles: {previousClose: {epoch: 2}}, nested: {bytes: Uint8Array.of(7, 9), members: ["writer"]}});
		const qc = rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 3, phase: "commit"}), projection = rollbackScalarCandidate({kind: "v3-live-generation-2", epoch: 3});
		const current = rollbackScalarClosure([trust, cut, qc, projection]), predecessor = rollbackScalarClosure([
			rollbackScalarCandidate({kind: "drp-anchor-trust-state", currentEpoch: 3}), rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 2})]);
		const live = rollbackScalarClosure([rollbackScalarCandidate({kind: "v3-live-generation-2", epoch: 4, nested: {bytes: Uint8Array.of(3, 5)}})]);
		const pin = encodeCanonical({kind: "drp-anchor-trust-state", currentEpoch: 0}); return {current, predecessor, live, pin, trust, cut};
	}
	it("executes actual metadata selections/counts with cold equivalence, isolated full values and bounded miss fallback", async () => {
		const m = material(), fast = await owner(), cold = await owner(true), overflow = await owner(false, 0);
		const read = (o: Awaited<ReturnType<typeof owner>>) => o.read(m.current, m.predecessor, m.live, 4, m.pin);
		const actual = read(fast); expect(actual.ok).toBe(true); expect(actual).toEqual(read(cold)); expect(actual).toEqual(read(overflow));
		expect(actual.carrier).toBe(m.trust); expect(actual.cut).toBe(m.cut); expect(actual.liveProjections).toBe(1); expect(actual.currentProjections).toBe(1);
		const before = fast.decodes(); expect(read(fast)).toEqual(read(cold)); expect(fast.decodes() - before).toBe(0); // Exact pin syntax shares its strict whole-record roundtrip, not trust authentication.
		expect(fast.decodes()).toBeLessThan(cold.decodes()); const misses = overflow.decodes(); read(overflow); expect(overflow.decodes() - misses).toBe(misses);
		(actual.cutRecord!.nested as {bytes: Uint8Array; members: string[]}).bytes.fill(99); (actual.cutRecord!.nested as {members: string[]}).members.push("tampered");
		expect(read(fast).cutRecord).toEqual(read(cold).cutRecord); expect(read(fast).cutRecord).toEqual(decodeCanonical(m.cut.bytes));
	});
	it("rechecks same-buffer epoch mutation, duplicate selectors and original exact-ref capture refusal", async () => {
		const m = material(), fast = await owner(), cold = await owner(true);
		expect(fast.read(m.current, m.predecessor, m.live, 4, m.pin).ok).toBe(true);
		const changed = encodeCanonical({...decodeCanonical(m.trust.bytes) as object, currentEpoch: 5}); expect(changed.length).toBe(m.trust.bytes.length); m.trust.bytes.set(changed);
		expect(fast.read(m.current, m.predecessor, m.live, 4, m.pin)).toEqual(cold.read(m.current, m.predecessor, m.live, 4, m.pin));
		expect(fast.read(m.current, m.predecessor, m.live, 4, m.pin)).toEqual({ok: false, reason: "RECOVERY_ROLE_LINEAGE_INVALID"});
		const duplicate = material(); duplicate.current.candidates.push(duplicate.trust);
		expect(fast.read(duplicate.current, duplicate.predecessor, duplicate.live, 4, duplicate.pin)).toEqual(cold.read(duplicate.current, duplicate.predecessor, duplicate.live, 4, duplicate.pin));
		expect(fast.read(duplicate.current, duplicate.predecessor, duplicate.live, 4, duplicate.pin).ok).toBe(false);
		const projections = material(); projections.live.candidates.push(projections.live.candidates[0]!);
		const counted = fast.read(projections.current, projections.predecessor, projections.live, 4, projections.pin);
		expect(counted).toEqual(cold.read(projections.current, projections.predecessor, projections.live, 4, projections.pin)); expect(counted.liveProjections).toBe(2); expect(counted.projectionRecord).toBeUndefined();
		for (const edit of ["duplicate", "missing", "changed"] as const) {
			const f = material(); if (edit === "duplicate") f.current.closure.push(f.trust.ref);
			else if (edit === "missing") f.current.closure.pop(); else f.cut.ref = {...f.cut.ref, byteLength: f.cut.ref.byteLength + 1};
			expect(fast.capture(f.current)).toBeUndefined(); expect(cold.capture(f.current)).toBeUndefined();
		}
		const clean = material(), captured = fast.capture(clean.current)!; clean.cut.bytes.fill(255);
		expect(fast.record(captured.candidates[1]!)).toEqual(decodeCanonical(material().cut.bytes));
	});
	it("preserves strict pin versus decode-only metadata, actual context/floor predicates and genuine nominal trust admission", async () => {
		const f = await owner(), cold = await owner(true), m = material();
		const invalid = rollbackScalarCandidate(null); invalid.bytes = Uint8Array.of(255); expect(f.record(invalid)).toBeUndefined(); expect(f.record(invalid)).toEqual(cold.record(invalid));
		const bom = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", epoch: 3, payload: "\ufeff"}); expect(f.record(bom)).toEqual(cold.record(bom)); expect(f.record(bom)).toBeDefined();
		const pin = encodeCanonical({kind: "drp-anchor-trust-state", currentEpoch: 0, payload: "\ufeff"});
		expect(f.read(m.current, m.predecessor, m.live, 4, pin).pinRecord).toBeUndefined(); expect(f.read(m.current, m.predecessor, m.live, 4, pin)).toEqual(cold.read(m.current, m.predecessor, m.live, 4, pin));
		const record = decodeCanonical(m.trust.bytes) as Record<string, unknown>, trust = {objectId: record.objectId, genesisAnchorDigest: record.genesisAnchorDigest, profileId: record.profileId}, original = {anchorDigest: record.currentAnchorDigest};
		expect(f.context(m.trust, record, original, {}, trust)).toBe(true);
		for (const key of ["objectId", "genesisAnchorDigest", "profileId"] as const) expect(f.context(m.trust, record, original, {}, {...trust, [key]: "foreign"})).toBe(false);
		expect(f.context(m.trust, record, {anchorDigest: "foreign"}, {}, trust)).toBe(false); expect(f.epoch(2)).toBe(false); expect(f.epoch(3)).toBe(true); expect(f.epoch(NaN)).toBe(false);
		const {makeCreatorMaterial, makeTrustStateRecord} = await import("../../../tests/fixtures/phase-3a0-v3/controlled-anchor-trust.js");
		const {openCurrentAnchorTrust} = await import("@ts-drp/protocol-v3"); const genesisMaterial = makeCreatorMaterial(), bytes = makeTrustStateRecord(genesisMaterial);
		const opened = openCurrentAnchorTrust({exactCanonicalTrustStateRecordBytes: bytes, expectedObjectId: String(genesisMaterial.anchor.objectId), pinnedGenesisAnchorDigest: genesisMaterial.anchorDigest});
		expect(opened.ok).toBe(true); if (!opened.ok) throw Error("READBACK_GENUINE_PIN_FIXTURE");
		expect(f.genuine(opened.trust, bytes)).toBe(true); expect(f.genuine({...opened.trust}, bytes)).toBe(false);
		const originalGenuineCheck = f.source.indexOf("genuineRecoveryTrust(captured.currentTrust, pinBytes)");
		expect(originalGenuineCheck).toBeGreaterThanOrEqual(0);
		expect(originalGenuineCheck).toBeLessThan(f.source.indexOf("const syntax = evidenceOwner?.syntax ?? createCreatorCanonicalSyntaxReader()"));
		// A retained private syntax owner may already exist; its first semantic
		// use still follows the original fresh nominal-trust admission check.
		expect(originalGenuineCheck).toBeLessThan(f.source.indexOf("const carrier = select("));
		for (const originalCheck of ["openCreatorCheckpointTrust({", "inspectCreatorClosedCutSuccessorBinding({", "inspectCreatorTransitionAdvanceOwned({", "openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch({", "consumeCreatorRecoveryRoleRetiredReadback("]) expect(f.source).toContain(originalCheck);
		// Only metadata and original admission predicates are executed here. Real
		// complete role readback, snapshots, signatures and native currency remain
		// covered by the existing genuine healthy/mature native fixtures.
	});
});

describe("nominal historical frontier batch affected controls", () => {
	type Context = {epoch: number; anchor: string; objectId: string};
	type Target = Context & {profileId: string};
	type Frontier = readonly [author: string, admissionEpoch: number, terminalThrough: number | null];
	async function fixture() {
		const {makeCreatorMaterial, makeTrustStateRecord} = await import("../../../tests/fixtures/phase-3a0-v3/controlled-anchor-trust.js");
		const {openCurrentAnchorTrust} = await import("@ts-drp/protocol-v3"), {openSealAuthority} = await import("@ts-drp/protocol-v3/seal");
		const {openCanonicalLatchedAclSnapshot} = await import("@ts-drp/protocol-v3/latched-acl");
		const capture = await import("@ts-drp/protocol-v3/internal/creator-forward-promotion");
		const genesis = makeCreatorMaterial({profileId: "creator-trusted-settlement-v1"});
		const bytes = encodeCanonical({...decodeCanonical(makeTrustStateRecord(genesis)) as object, profileId: genesis.profile.profileId});
		const opened = openCurrentAnchorTrust({exactCanonicalTrustStateRecordBytes: bytes, expectedObjectId: String(genesis.anchor.objectId), pinnedGenesisAnchorDigest: genesis.anchorDigest});
		expect(opened.ok).toBe(true); if (!opened.ok) throw Error("FRONTIER_BATCH_GENUINE_GENESIS");
		expect(openSealAuthority({trust: opened.trust, signerPublicKey: Uint8Array.from(Buffer.from(String(genesis.signerSet[0]!.publicKey), "hex"))}).ok).toBe(true);
		const source: Context = {epoch: opened.trust.currentEpoch, anchor: opened.trust.currentAnchorDigest, objectId: opened.trust.objectId};
		const target: Target = {epoch: 1, anchor: "a".repeat(64), objectId: source.objectId, profileId: opened.trust.profileId};
		const authors = Array.from({length: 64}, (_, index) => index.toString(16).padStart(64, "0"));
		const aclBytes = encodeCanonical({kind: "drp-v3-latched-acl", version: 3, objectId: source.objectId, epoch: source.epoch, permissionless: false,
			members: authors.map((author, index) => ({author, finalityKey: null, groups: index === 0 ? ["admin", "writer"] : ["writer"]}))});
		const acl = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: aclBytes, expectedAclDigest: Buffer.from(hashDomain("ts-drp/latched-acl/v3", aclBytes)).toString("hex"),
			expectedEpoch: source.epoch, expectedObjectId: source.objectId, expectedProfileId: target.profileId});
		expect(acl.ok, JSON.stringify(acl)).toBe(true);
		const capability = {}, settlement = {}, registry = new WeakMap(), settlements = new WeakMap<object, Frontier[]>();
		const rows: Frontier[] = authors.map((author, index) => [author, index % 2, index % 3 === 0 ? null : index]); settlements.set(settlement, rows);
		const material = {identity: {objectId: source.objectId, closedEpoch: source.epoch, closedAnchorDigest: source.anchor, successorEpoch: target.epoch, successorAnchorDigest: target.anchor},
			profileId: target.profileId, exactCanonicalLatchedAclBytes: aclBytes, settlement: settlement as object | undefined}; registry.set(capability, material);
		const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`FRONTIER_BATCH_HELPER:${name}:${found.length}`); return found[0]!.getText(file).replace(/^export /, "");};
		const calls = {acl: 0, frontiers: [] as string[]};
		// Actual registry resolvers and real canonical ACL opener. Only historical
		// registry enrollment and settlement capability outputs are controlled;
		// genuine genesis trust above is not a signed historical settlement proof.
		const owner = execute<{batch(capability: object, source: Context, target: Target, authors: readonly string[]): readonly Frontier[] | undefined;
			single(capability: object, source: Context & {author: string}): {admissionEpoch: number; terminalThrough: number | null} | undefined}>(`
			${["hex", "resolveVerifiedHistoricalSourceAcl", "resolveVerifiedHistoricalSourceFrontier", "resolveVerifiedHistoricalSettlementFrontiers"].map(extract).join("\n")}
			({batch: resolveVerifiedHistoricalSettlementFrontiers, single: resolveVerifiedHistoricalSourceFrontier});`, {
			...capture, hashDomain, verifiedHistoricalIssuance: registry,
			openCanonicalLatchedAclSnapshot: (input: Parameters<typeof openCanonicalLatchedAclSnapshot>[0]) => {calls.acl++; return openCanonicalLatchedAclSnapshot(input);},
			frontierFor: (selected: object, author: string) => {calls.frontiers.push(author); const row = settlements.get(selected)?.find(row => row[0] === author); return row === undefined ? undefined : Object.freeze([...row]);},
		});
		const oldLoop = (requested: readonly string[]) => requested.flatMap(author => {const frontier = owner.single(capability, {...source, author}); return frontier === undefined ? [] : [[author, frontier.admissionEpoch, frontier.terminalThrough] as const];});
		return {owner, source, target, authors, capability, material, rows, calls, oldLoop, reset: () => {calls.acl = 0; calls.frontiers.length = 0;}};
	}
	it("matches the original per-author resolver values and requested order without coalescing authors or opening ACL per member", async () => {
		const f = await fixture(), requested = [f.authors[3]!, "f".repeat(64), ...f.authors.slice().reverse(), f.authors[3]!];
		const original = f.oldLoop(requested); expect(original).toHaveLength(66); expect(f.calls.acl).toBe(requested.length); f.reset();
		const actual = f.owner.batch(f.capability, f.source, f.target, requested); expect(actual).toEqual(original); expect(actual).toHaveLength(requested.length - 1);
		expect(f.calls.acl).toBe(1); expect(f.calls.frontiers).toEqual(requested); expect(actual![0]).toEqual(actual!.at(-1)); expect(actual![0]).not.toBe(actual!.at(-1));
		expect(Object.isFrozen(actual)).toBe(true); expect(actual!.every(Object.isFrozen)).toBe(true); expect(Reflect.set(actual![0]!, "1", 99)).toBe(false);
		f.reset(); expect(f.owner.batch(f.capability, f.source, f.target, [])).toEqual([]); expect(f.calls.acl).toBe(1); expect(f.calls.frontiers).toEqual([]);
	});
	it("rejects fabricated custody, source/target/profile mismatch, unavailable ACL/settlement and descriptor-invalid inputs", async () => {
		const f = await fixture(); let propertiesRead = 0; const foreign = new Proxy({}, {get: () => {propertiesRead++; throw Error("FOREIGN_PROPERTY_READ");}});
		expect(f.owner.batch(foreign, f.source, f.target, f.authors)).toBeUndefined(); expect(f.owner.batch({...f.capability}, f.source, f.target, f.authors)).toBeUndefined(); expect(propertiesRead).toBe(0); expect(f.calls.acl).toBe(0);
		for (const changed of [{...f.source, epoch: 2}, {...f.source, anchor: "foreign"}, {...f.source, objectId: "foreign"}]) expect(f.owner.batch(f.capability, changed, f.target, f.authors)).toBeUndefined();
		for (const changed of [{...f.target, epoch: 2}, {...f.target, anchor: "foreign"}, {...f.target, objectId: "foreign"}, {...f.target, profileId: "foreign"}]) expect(f.owner.batch(f.capability, f.source, changed, f.authors)).toBeUndefined();
		expect(f.calls.acl).toBe(0); const sparse = new Array<string>(2), accessor = [f.authors[0]!]; Object.defineProperty(accessor, "0", {get: () => {propertiesRead++; return f.authors[0];}, enumerable: true});
		for (const invalid of [sparse, accessor, Array(257).fill(f.authors[0]), [7] as unknown as string[]]) expect(f.owner.batch(f.capability, f.source, f.target, invalid)).toBeUndefined(); expect(propertiesRead).toBe(0); expect(f.calls.acl).toBe(0);
		f.material.settlement = undefined; expect(f.owner.batch(f.capability, f.source, f.target, f.authors)).toBeUndefined(); expect(f.calls.acl).toBe(0);
		const missing = await fixture(); missing.material.exactCanonicalLatchedAclBytes = Uint8Array.of(255); expect(missing.owner.batch(missing.capability, missing.source, missing.target, missing.authors)).toBeUndefined(); expect(missing.calls.acl).toBe(1); expect(missing.calls.frontiers).toEqual([]);
	});
	it("reopens each original context freshly, preserves scope separation and retains the caller's two contexts and cold fallback", async () => {
		const first = await fixture(), second = await fixture(); const request = [first.authors[9]!, first.authors[2]!];
		const before = first.owner.batch(first.capability, first.source, first.target, request)!; first.rows[9] = [first.authors[9]!, 0, 999];
		const refreshed = first.owner.batch(first.capability, first.source, first.target, request); expect(first.calls.acl).toBe(2); expect(refreshed).toEqual(first.oldLoop(request)); expect(refreshed).not.toEqual(before);
		const independent = second.owner.batch(second.capability, second.source, second.target, request); expect(second.calls.acl).toBe(1); expect(independent).toEqual(second.oldLoop(request));
		expect(first.owner.batch(second.capability, first.source, first.target, request)).toBeUndefined();
		const path = new URL("../src/v3-live.ts", import.meta.url), text = readFileSync(path, "utf8"), file = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const calls: ts.CallExpression[] = []; const visit = (node: ts.Node): void => {if (ts.isCallExpression(node) && node.expression.getText(file) === "openHistoricalIssuance") calls.push(node); ts.forEachChild(node, visit);}; visit(file); expect(calls).toHaveLength(2);
		expect(text).toContain("const predecessorHistoricalIssuance = receiveOnly ? undefined : openHistoricalIssuance()"); expect(text).toContain("const successorHistoricalIssuance = receiveOnly ? undefined : openHistoricalIssuance()");
		expect(text).toContain("resolveVerifiedHistoricalSettlementFrontiers(successorHistoricalIssuance.capability");
		expect(text).toContain('(successorAuthorization.kind === "latched-acl" ? successorAuthorization.value.members : []).flatMap(');
		expect(text).toContain("await material.promotionDependencies?.release()"); expect(text).toContain("await maintenanceAdmission.beginWrite()");
		// This is resolver/caller-shape coverage, not acceptance of the controlled
		// settlement outputs as signatures or evidence of native currency/cleanup.
	});

	function policyFrontierConsumer(profileId: string, representation: "settlement" | "aggregate" | "retirement",
		options: {fast?: readonly Frontier[]; refused?: boolean; missingQc?: boolean; noHistoricalOwner?: boolean} = {}) {
		const livePath = new URL("../src/v3-live.ts", import.meta.url), live = ts.createSourceFile(livePath.pathname,
			readFileSync(livePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const properties: ts.PropertyAssignment[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAssignment(node) && node.name.getText(live) === "authenticatedSettlementFrontiers" &&
				node.initializer.getText(live).includes("resolveVerifiedHistoricalSettlementFrontiers(")) properties.push(node);
			ts.forEachChild(node, visit);
		};
		visit(live); if (properties.length !== 1) throw Error("PROFILE_FRONTIER_CONSUMER_NOT_UNIQUE");
		const initializer = properties[0]!.initializer;
		if (!ts.isCallExpression(initializer) || initializer.arguments.length !== 1 ||
			!ts.isConditionalExpression(initializer.arguments[0]!)) throw Error("PROFILE_FRONTIER_GUARD_MISSING");
		const conditional = initializer.arguments[0] as ts.ConditionalExpression;
		const original = "ObjectFreeze(" + conditional.whenFalse.getText(live) + ")";
		const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {const nodes = file.statements.filter((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === name); if (nodes.length !== 1) throw Error("PROFILE_FRONTIER_OWNER:" + name);
			return nodes[0]!.getText(file).replace(/^export /, "");};
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url), syntax = ts.createSourceFile(syntaxPath.pathname,
			readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const syntaxOwner = syntax.statements.filter((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (syntaxOwner.length !== 1) throw Error("PROFILE_FRONTIER_SYNTAX_OWNER");
		const authors = Array.from({length: 64}, (_, index) => index.toString(16).padStart(64, "0"));
		const source = {objectId: "room", currentEpoch: 1, currentAnchorDigest: "a".repeat(64)},
			target = {...source, currentEpoch: 2, currentAnchorDigest: "b".repeat(64), profileId};
		const identity = {objectId: source.objectId, closedEpoch: source.currentEpoch, closedAnchorDigest: source.currentAnchorDigest,
			successorEpoch: target.currentEpoch, successorAnchorDigest: target.currentAnchorDigest};
		const rows: Frontier[] = authors.map((author, index) => [author, index % 2, index]);
		const retirementKind = "drp-creator-issuance-retirement-state", aggregateKind = "drp-creator-author-issuance-frontiers-state",
			settlementKind = "drp-creator-author-settlement-state";
		const records: Record<string, unknown>[] = [{kind: "drp-hard-epoch-cut", epoch: 1},
			{kind: "drp-v3-latched-acl", epoch: 1}, {kind: "drp-anchor-trust-state", currentEpoch: 1}];
		if (!options.missingQc) records.push({kind: "drp-seal-qc", epoch: 1, phase: "commit"});
		const aclBytes = encodeCanonical(records[1]), aclDigest = Buffer.from(hashDomain("ts-drp/latched-acl/v3", aclBytes)).toString("hex");
		if (representation === "settlement") records.push({kind: settlementKind, epoch: 1, currentAclDigest: aclDigest});
		else {records.push({kind: retirementKind, epoch: 1}); if (representation === "aggregate") records.push({kind: aggregateKind, epoch: 1});}
		const candidates = records.map(record => {const bytes = encodeCanonical(record), digest = digestBlob(bytes);
			if (!digest.ok) throw Error("PROFILE_FRONTIER_CANDIDATE"); return {bytes, ref: {digest: digest.value, byteLength: bytes.byteLength}};});
		const closure = {candidates, closure: candidates.map(candidate => candidate.ref)};
		const material = {predecessor: {trust: source}, successor: {trust: target, candidates, references: closure.closure}};
		const calls = {fast: 0, cold: 0, retirement: 0, aggregate: 0, settlement: 0};
		const registry = new WeakMap(), settlement = Object.freeze({});
		// Execute the real profile selector, syntax/occurrence checks, historical
		// identity construction and consumer. Only signed crypto openers are
		// controlled; these units neither mint real authority nor claim native auth.
		const owner = execute<{open(author: string): object | undefined; resolve(capability: object): any}>([
			syntaxOwner[0]!.getText(syntax).replace(/^export /, ""),
			["record", "candidateSelection", "sameRef", "exactCreatorTransitionOccurrence", "uniqueCreatorTransitionCandidate",
				"hex", "openCreatorTransitionClosedCutEvidence", "openCreatorTransitionClosedCutEvidenceOwned", "openVerifiedCreatorHistoricalIssuance",
				"resolveVerifiedCreatorHistoricalIssuance"].map(extract).join("\n"),
			"({open: author => openVerifiedCreatorHistoricalIssuance({author, closure, floorTrust: target}), resolve: resolveVerifiedCreatorHistoricalIssuance});",
		].join("\n"), {
			closure, target, verifiedHistoricalIssuance: registry, AHE_BOUNDED_READ_LIMITS, digestBlob, hashDomain, settlementProfileFor,
			CREATOR_ISSUANCE_RETIREMENT_KIND: retirementKind, CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND: aggregateKind,
			CREATOR_AUTHOR_SETTLEMENT_KIND: settlementKind,
			openCreatorTransitionRetirementOwned: () => {calls.retirement++; return {identity: {...identity, author: authors[0], admittedAuthorSequence: 7}};},
			openCreatorTransitionAggregateOwned: () => {calls.aggregate++; return {identity: {...identity, frontiers: authors.map((author, i) => [author, i])}};},
			openCreatorTransitionSettlementOwned: () => {calls.settlement++; return options.refused ? undefined :
				{identity: {...identity, currentAclDigest: aclDigest}, capability: settlement};},
			frontierFor: (_capability: object, author: string) => rows.find(row => row[0] === author),
			readCreatorSettlementSourceAnchor: () => {throw Error("UNEXPECTED_SOURCE_ANCHOR_READ");},
		});
		const evaluate = (old = false) => execute<readonly Frontier[]>(old ? original : initializer.getText(live), {
			ObjectFreeze: Object.freeze, material, settlementProfileFor,
			successorAuthorization: {kind: "latched-acl", value: {members: authors.map(author => ({author}))}},
			successorHistoricalIssuance: options.noHistoricalOwner ? undefined : {capability: settlement},
			resolveVerifiedHistoricalSettlementFrontiers: () => {calls.fast++; return options.fast;},
			openVerifiedCreatorHistoricalIssuance: (input: {author: string}) => {calls.cold++; return owner.open(input.author);},
			resolveVerifiedCreatorHistoricalIssuance: owner.resolve,
		});
		return {evaluate, owner, authors, rows, calls, reset: () => {for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;},
			sourceText: live.text, initializer: initializer.getText(live)};
	}
	it("NONE policy input equals original empty output with zero per-member closure opens", () => {
		for (const representation of ["aggregate", "retirement"] as const) {
			const f = policyFrontierConsumer("creator-trusted-v1", representation);
			const original = f.evaluate(true); expect(original).toEqual([]); expect(f.calls.cold).toBe(64);
			for (const author of f.authors) {const capability = f.owner.open(author);
				if (capability !== undefined) expect(Object.hasOwn(f.owner.resolve(capability), "admissionEpoch")).toBe(false);}
			f.reset(); const result = f.evaluate();
			expect(result).toEqual(original); expect(Object.isFrozen(result)).toBe(true);
			expect(f.calls).toEqual({fast: 0, cold: 0, retirement: 0, aggregate: 0, settlement: 0});
		}
	});
	it("NONE skips only irrelevant frontier input even when the ignored original member opens refuse", () => {
		const f = policyFrontierConsumer("creator-trusted-v1", "aggregate", {missingQc: true, noHistoricalOwner: true});
		expect(f.evaluate(true)).toEqual([]); expect(f.calls.cold).toBe(64); f.reset();
		expect(f.evaluate()).toEqual([]); expect(f.calls).toEqual({fast: 0, cold: 0, retirement: 0, aggregate: 0, settlement: 0});
	});
	it("V1 retains genuine owner selection first and the original positive cold fallback", () => {
		const fast: Frontier[] = [["0".repeat(64), 1, 9]], f = policyFrontierConsumer("creator-trusted-settlement-v1", "settlement", {fast});
		const original = f.evaluate(true); f.reset(); const actual = f.evaluate();
		expect(actual).toBe(fast); expect(actual).toEqual(original); expect(f.calls.fast).toBe(1); expect(f.calls.cold).toBe(0);
		const cold = policyFrontierConsumer("creator-trusted-settlement-v1", "settlement", {noHistoricalOwner: true});
		const oldCold = cold.evaluate(true); expect(oldCold).toEqual(cold.rows); cold.reset();
		expect(cold.evaluate()).toEqual(oldCold); expect(cold.calls.fast).toBe(0); expect(cold.calls.cold).toBe(64);
		expect(cold.calls.settlement).toBe(64);
	});
	it("V1 preserves original cold refusal paths instead of assuming empty authenticated settlement", () => {
		for (const options of [{refused: true}, {missingQc: true}]) {
			const f = policyFrontierConsumer("creator-trusted-settlement-v1", "settlement", options);
			expect(f.evaluate(true)).toEqual([]); const calls = {...f.calls}; f.reset();
			expect(f.evaluate()).toEqual([]); expect(f.calls).toEqual(calls); expect(f.calls.fast).toBe(1); expect(f.calls.cold).toBe(64);
		}
	});
	it("frontier input selection remains after fresh source, ACL, snapshot and joined-custody gates", () => {
		const f = policyFrontierConsumer("creator-trusted-v1", "aggregate"), start = f.sourceText.indexOf("async function activateCreatorSuccessorLive("),
			end = f.sourceText.indexOf("authenticatedSettlementFrontiers:", start), before = f.sourceText.slice(start, end);
		for (const required of ["prepareExistingCreatorGeneration(material.predecessor", "prepareExistingCreatorGeneration(material.successor",
			"openRecoveryAuthorization(successorPayload", "const predecessorHistoricalIssuance", "const successorHistoricalIssuance",
			'return rejected("preparation-rejected", "creator historical issuance authority preparation failed")',
			'return rejected("snapshot-invalid", "creator successor policy state is invalid")',
			"await releaseCreatorCloseHeaderCustody(headerSource)", "await material.promotionDependencies?.release()"]) expect(before).toContain(required);
		expect(f.initializer).toContain('settlementProfileFor(material.successor.trust.profileId) !== "v1" ? [] :');
	});
});

describe("same-frame settlement early-late recheck affected controls", () => {
	type Candidate = RollbackScalarCandidate;
	type Trust = {objectId: string; currentEpoch: number; currentAnchorDigest: string; genesisAnchorDigest: string; profileId: string};
	type Input = {current: RollbackScalarClosure; proposed: RollbackScalarClosure; currentTrust: Trust; successorTrust: Trust;
		proofRefs: Candidate["ref"][]; mode: "verify"; settlementAcl?: {current: Uint8Array; successor: Uint8Array}};
	type Result = {ok: boolean; reason?: string; proposed?: RollbackScalarClosure};
	type Material = Trust & {quorum: number; publicKey: Uint8Array; exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
		detachedCurrentAnchorSignature: Uint8Array; exactCanonicalProfileBytes: Uint8Array; exactCanonicalSignerSetBytes: Uint8Array};
	async function fixture(retainBytes: number = AHE_BOUNDED_READ_LIMITS.maxUnionBytes) {
		const controls = await import("@ts-drp/protocol-v3/creator-author-issuance-frontiers");
		const capture = await import("@ts-drp/protocol-v3/internal/creator-forward-promotion");
		const {openCanonicalLatchedAclSnapshot} = await import("@ts-drp/protocol-v3/latched-acl");
		const {CREATOR_ISSUANCE_RETIREMENT_KIND} = await import("@ts-drp/protocol-v3/creator-issuance-retirement");
		const path = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (found.length !== 1) throw Error(`SETTLEMENT_FRAME_HELPER:${name}:${found.length}`); return found[0]!.getText(file).replace(/^export /, "");};
		const constants = file.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
			ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("SETTLEMENT_"))).map(node => node.getText(file)).join("\n");
		const syntaxPath = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
		const syntaxFile = ts.createSourceFile(syntaxPath.pathname, readFileSync(syntaxPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const reader = syntaxFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorCanonicalSyntaxReader");
		if (reader === undefined) throw Error("SETTLEMENT_FRAME_READER_MISSING");
		const calls = {settlement: 0, acl: 0, advance: 0, seal: 0}, identities = new WeakMap<object, Record<string, unknown>>(), materials = new WeakMap<object, Material>();
		const state = {available: true};
		const owner = execute<{inspect(input: Input): Result; prepare(input: Input): {initial: Result; recheck(acl: Input["settlementAcl"]): Result; release(): void}}>(`
			${reader.getText(syntaxFile).replace(/^export /, "")}
			${constants}
			${["exactSettlementRecord", "exactSettlementArray", "exactSettlementAcl", "exactSettlementFrontierArray", "settlementMembers", "settlementFrontiers",
				"inspectCreatorAuthorSettlementAdvance", "record", "candidateSelection", "candidateMetadata", "sameRef", "compareRef", "exactCandidate", "hex", "failure",
				"uniqueCreatorTransitionCandidate", "exactCreatorTransitionOccurrence", "retirementCandidates", "aggregateCandidates", "settlementCandidates",
				"currentAnchorAclDigest", "openCreatorTransitionSettlement", "openCreatorTransitionSettlementOwned", "authenticatedSettlementPair", "inspectCreatorTransitionAdvanceOwned",
				"inspectCreatorTransitionAdvance", "capturePromotionClosure", "prepareCreatorTransitionAdvanceRecheck"].map(extract).join("\n")}
			const originalAdvance = inspectCreatorAuthorSettlementAdvance;
			inspectCreatorAuthorSettlementAdvance = input => { countAdvance(); return originalAdvance(input); };
			({inspect: inspectCreatorTransitionAdvance, prepare: prepareCreatorTransitionAdvanceRecheck});`, {
			...controls, ...capture, CREATOR_ISSUANCE_RETIREMENT_KIND, digestBlob, hashDomain,
			AHE_BOUNDED_READ_LIMITS: {...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: retainBytes}, countAdvance: () => {calls.advance++;},
			settlementProfileFor: (profile: string) => profile === "creator-trusted-settlement-v1" ? "v1" : "none",
			openCanonicalLatchedAclSnapshot: (input: Parameters<typeof openCanonicalLatchedAclSnapshot>[0]) => {calls.acl++; return openCanonicalLatchedAclSnapshot(input);},
			// Only these two original cryptographic owner responses are controlled.
			// Selection, full binding/capture predicates, canonical ACL opening and
			// author-settlement advance execute actual production code. This is NOT
			// genuine signature/floor/native acceptance or portable custody.
			openCreatorAuthorSettlement: (input: {exactCanonicalRecordBytes: Uint8Array; floorTrust: Trust}) => {
				calls.settlement++; if (!state.available || !materials.has(input.floorTrust)) return {ok: false};
				const value = decodeCanonical(input.exactCanonicalRecordBytes) as {identity: Record<string, unknown>};
				const capability = {}; identities.set(capability, value.identity); return {ok: true, capability};
			}, resolveCreatorAuthorSettlement: (capability: object) => identities.get(capability),
			resolveSealRecoveryTrust: (trust: object) => state.available && materials.has(trust) ? structuredClone(materials.get(trust)) : undefined,
			openSealAuthority: ({trust}: {trust: object}) => {calls.seal++; return {ok: state.available && materials.has(trust)};},
			inspectBoundedCreatorTrustAdvance: () => ({ok: true, kind: "successor"}),
			inspectCreatorTrustAdvance: () => {throw Error("UNEXPECTED_FRAME_GENESIS_ADVANCE");},
		});
		const author = "1".repeat(64), digest = (domain: string, bytes: Uint8Array) => Buffer.from(hashDomain(domain, bytes)).toString("hex");
		const acl = (epoch: number) => encodeCanonical({kind: "drp-v3-latched-acl", version: 3, objectId: "room", epoch, permissionless: false,
			members: [{author, finalityKey: null, groups: ["admin", "writer"]}]});
		const a0 = acl(0), a1 = acl(1), a2 = acl(2), anchor = encodeCanonical({kind: "drp-epoch-anchor", objectId: "room", epoch: 1, aclDigest: digest("ts-drp/latched-acl/v3", a1)});
		const currentTrust: Trust = {objectId: "room", currentEpoch: 1, currentAnchorDigest: digest("ts-drp/epoch-anchor/v3", anchor), genesisAnchorDigest: "a".repeat(64), profileId: "creator-trusted-settlement-v1"};
		const successorTrust = {...currentTrust, currentEpoch: 2, currentAnchorDigest: "b".repeat(64)};
		for (const trust of [currentTrust, successorTrust]) materials.set(trust, {...trust, quorum: 1, publicKey: Uint8Array.of(1, 2), exactCanonicalCurrentAnchorPreimageBytes: anchor.slice(),
			detachedCurrentAnchorSignature: Uint8Array.of(3, 4), exactCanonicalProfileBytes: Uint8Array.of(5, 6), exactCanonicalSignerSetBytes: Uint8Array.of(7, 8)});
		const c0 = rollbackScalarCandidate({kind: "drp-hard-epoch-cut", objectId: "room", epoch: 0, previousAnchor: currentTrust.genesisAnchorDigest, snapshotManifestDigest: "c".repeat(64), historyRoot: "d".repeat(64), historySize: 1});
		const c1 = rollbackScalarCandidate({...decodeCanonical(c0.bytes) as object, epoch: 1, previousAnchor: currentTrust.currentAnchorDigest, historySize: 2});
		const q0 = rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 0, phase: "commit"}), q1 = rollbackScalarCandidate({kind: "drp-seal-qc", epoch: 1, phase: "commit"});
		const identity = (epoch: number) => ({objectId: "room", closedEpoch: epoch, closedAnchorDigest: epoch === 0 ? currentTrust.genesisAnchorDigest : currentTrust.currentAnchorDigest,
			successorEpoch: epoch + 1, successorAnchorDigest: epoch === 0 ? currentTrust.currentAnchorDigest : successorTrust.currentAnchorDigest,
			historyRoot: "d".repeat(64), historySize: epoch + 1, successorAclDigest: digest("ts-drp/latched-acl/v3", epoch === 0 ? a1 : a2), frontiers: [[author, 0, null]],
			priorCheckpointKind: epoch === 0 ? "genesis" : "settled-v1", priorCheckpointDigest: controls.CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL});
		const s0 = rollbackScalarCandidate({kind: controls.CREATOR_AUTHOR_SETTLEMENT_KIND, successorAclDigest: identity(0).successorAclDigest, identity: identity(0)});
		const s1 = rollbackScalarCandidate({kind: controls.CREATOR_AUTHOR_SETTLEMENT_KIND, successorAclDigest: identity(1).successorAclDigest, identity: {...identity(1), priorCheckpointDigest: s0.ref.digest}});
		const trust = rollbackScalarCandidate({kind: "drp-anchor-trust-state", ...currentTrust, exactCanonicalCurrentAnchorPreimageBytes: anchor});
		const oldAcl = rollbackScalarCandidate(decodeCanonical(a0));
		const input: Input = {current: rollbackScalarClosure([s0, q0, trust, oldAcl, c0]), proposed: rollbackScalarClosure([c1, oldAcl, s1, q0, q1, c0]),
			currentTrust, successorTrust, proofRefs: [c1.ref, q1.ref], mode: "verify"};
		const lateAcl = {current: a1, successor: a2};
		return {owner, input, lateAcl, calls, materials, state, c1, q1, s1, trust, extract, file};
	}
	it("matches cold full-tree results while retaining fresh real late ACL and advance refusals", async () => {
		const f = await fixture(), cold = await fixture(), frame = f.owner.prepare(f.input);
		expect(frame.initial.ok).toBe(true); expect(frame.initial).toEqual(cold.owner.inspect(cold.input));
		expect(f.calls).toEqual({settlement: 2, acl: 0, advance: 0, seal: 2});
		await Promise.resolve();
		const result = frame.recheck(f.lateAcl), original = cold.owner.inspect({...cold.input, settlementAcl: cold.lateAcl});
		expect(result.ok).toBe(true); expect(result).toEqual(original); expect(f.calls.settlement).toBe(2);
		expect(f.calls.acl).toBe(2); expect(f.calls.advance).toBe(1); expect(f.calls.seal).toBe(4);
		const invalid = {current: f.lateAcl.current, successor: Uint8Array.of(255)};
		expect(frame.recheck(invalid)).toEqual(f.owner.inspect({...f.input, settlementAcl: invalid})); expect(frame.recheck(invalid).ok).toBe(false);
		// A valid ACL still cannot bypass the real predecessor-relative law.
		const changed = await fixture(), identity = decodeCanonical(changed.s1.bytes) as {identity: {frontiers: unknown[]}};
		identity.identity.frontiers = [["1".repeat(64), 2, null]]; replace(changed, changed.s1, identity);
		const badAdvance = changed.owner.prepare(changed.input); expect(badAdvance.initial.ok).toBe(true);
		expect(badAdvance.recheck(changed.lateAcl)).toEqual(changed.owner.inspect({...changed.input, settlementAcl: changed.lateAcl}));
		expect(badAdvance.recheck(changed.lateAcl).ok).toBe(false); expect(changed.calls.advance).toBeGreaterThan(0);
	});
	function replace(f: Awaited<ReturnType<typeof fixture>>, candidate: Candidate, value: unknown) {
		const old = candidate.ref, next = rollbackScalarCandidate(value); candidate.bytes = next.bytes; candidate.ref = next.ref;
		for (const closure of [f.input.current, f.input.proposed]) closure.closure = closure.closure.map(ref => ref === old ? next.ref : ref);
		f.input.proofRefs = f.input.proofRefs.map(ref => ref === old ? next.ref : ref);
	}
	it("rechecks full closures, occurrences, proof refs and current/successor bindings after an await", async () => {
		const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
			f => {const bytes = encodeCanonical({...decodeCanonical(f.q1.bytes) as object, phase: "reject"}); expect(bytes.length).toBe(f.q1.bytes.length); f.q1.bytes.set(bytes);},
			f => replace(f, f.c1, {...decodeCanonical(f.c1.bytes) as object, snapshotManifestDigest: "e".repeat(64)}),
			f => replace(f, f.s1, {...decodeCanonical(f.s1.bytes) as object, extra: true}),
			f => {f.input.proofRefs[1] = {...f.q1.ref, byteLength: f.q1.ref.byteLength + 1};},
			f => {f.input.proposed.candidates.push(f.s1);}, f => {f.input.proposed.closure.push(f.s1.ref);},
			f => {f.input.currentTrust.objectId = "foreign";}, f => {f.input.currentTrust.currentAnchorDigest = "f".repeat(64);},
			f => {f.input.successorTrust.currentEpoch = 3;}, f => {f.input.successorTrust.currentAnchorDigest = "f".repeat(64);},
			f => {f.input.successorTrust.profileId = "creator-trusted-v1";},
		];
		for (const [index, change] of changes.entries()) {
			const f = await fixture(), frame = f.owner.prepare(f.input); expect(frame.initial.ok).toBe(true); await Promise.resolve(); change(f);
			const before = f.calls.settlement, actual = frame.recheck(f.lateAcl), after = f.calls.settlement;
			const original = f.owner.inspect({...f.input, settlementAcl: f.lateAcl}); expect(actual).toEqual(original);
			// Whole-closure/ref mutations invalidate the complete retained basis.
			// A trust-only change may leave the opposite floor's exact fact reusable;
			// its original contextual predicates still determine the same result.
			if (index < 6) {
				expect(after - before).toBe(f.calls.settlement - after);
				if (actual.ok) expect(after - before).toBe(2);
			}
		}
	});
	it("requires fresh nominal material, keys and seal checks rather than accepting copied or changed custody", async () => {
		const keys = ["publicKey", "exactCanonicalCurrentAnchorPreimageBytes", "detachedCurrentAnchorSignature", "exactCanonicalProfileBytes", "exactCanonicalSignerSetBytes"] as const;
		for (const key of keys) {
			const f = await fixture(), frame = f.owner.prepare(f.input); expect(frame.initial.ok).toBe(true); await Promise.resolve();
			const bytes = f.materials.get(f.input.successorTrust)![key]; bytes[0] = bytes[0]! ^ 1;
			const before = f.calls.settlement, actual = frame.recheck(f.lateAcl); expect(f.calls.settlement - before).toBe(1);
			expect(actual.ok).toBe(true); expect(actual).toEqual(f.owner.inspect({...f.input, settlementAcl: f.lateAcl})); expect(f.calls.seal).toBeGreaterThan(2);
		}
		const f = await fixture(), frame = f.owner.prepare(f.input); expect(frame.initial.ok).toBe(true);
		f.materials.get(f.input.successorTrust)!.quorum = 2; const before = f.calls.settlement;
		expect(frame.recheck(f.lateAcl).ok).toBe(true); expect(f.calls.settlement - before).toBe(1);
		f.input.successorTrust = {...f.input.successorTrust}; expect(frame.recheck(f.lateAcl).ok).toBe(false);
		const revoked = await fixture(), active = revoked.owner.prepare(revoked.input); expect(active.initial.ok).toBe(true); revoked.state.available = false;
		expect(active.recheck(revoked.lateAcl)).toEqual(revoked.owner.inspect({...revoked.input, settlementAcl: revoked.lateAcl})); expect(active.recheck(revoked.lateAcl).ok).toBe(false);
	});
	it("detaches captured bindings, falls back on bounded retention refusal and releases lexical facts without changing caller checks", async () => {
		const f = await fixture(), frame = f.owner.prepare(f.input); expect(frame.initial.ok).toBe(true);
		const originalBytes = f.q1.bytes.slice(); f.q1.bytes[0] = f.q1.bytes[0]! ^ 1; expect(frame.recheck(f.lateAcl).ok).toBe(false);
		f.q1.bytes.set(originalBytes); const before = f.calls.settlement; expect(frame.recheck(f.lateAcl).ok).toBe(true); expect(f.calls.settlement).toBe(before);
		const noRetention = await fixture(0), fallback = noRetention.owner.prepare(noRetention.input); expect(fallback.initial.ok).toBe(true);
		expect(fallback.recheck(noRetention.lateAcl).ok).toBe(true); expect(noRetention.calls.settlement).toBe(4);
		frame.release(); frame.release(); const stopped = {...f.calls};
		expect(frame.recheck(f.lateAcl)).toEqual({ok: false, reason: "TRUST_CLOSURE_INVALID"}); expect(f.calls).toEqual(stopped);
		const text = f.extract("prepareCreatorTransitionAdvanceRecheck"); expect(text).toContain("capturePromotionClosure(input.current, charge)");
		expect(text).toContain("capturePromotionClosure(input.proposed, charge)"); expect(text).toContain("openSealAuthority({ trust, signerPublicKey: material.publicKey })");
		expect(text).toContain("return inspectCreatorTransitionAdvance(late)");
		const rollbackPath = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), rollback = readFileSync(rollbackPath, "utf8");
		const start = rollback.indexOf("async function authenticate("), end = rollback.indexOf("async function", start + 1), body = rollback.slice(start, end);
		expect(start).toBeGreaterThan(0); expect(body).toContain("transitionRecheck = prepareCreatorTransitionAdvanceRecheck(transitionInput)");
		expect(body).toContain("transitionRecheck.recheck({ current: newestAcl, successor: newestSuccessorAcl })");
		expect(body).toContain("finally"); expect(body).toContain("transitionRecheck?.release()");
		expect(body).toContain("const currency = await checkCurrent()"); expect(body).toContain("frame.recoveryTrusts.add(currentTrust)");
		expect(body).toContain("snapshotOwnerReadable(input, await snapshotCall");
		expect(rollback.slice(rollback.indexOf("interface ImportFrame"), rollback.indexOf("interface ImportFrame") + 4000)).not.toContain("transitionRecheck");
		// Source linkage guards do not claim native currency/accounting acceptance.
	});
});

describe("ordinary finishing scalar codec capacity affected controls", () => {
	type Codec = typeof import("../../issuance-store/src/retirement.js");
	type Rows = Parameters<Codec["issuanceUnsignedPostimageWidths"]>[0];
	type Scope = Parameters<Codec["issuanceUnsignedPostimageWidths"]>[1];
	type Control = Parameters<Codec["issuanceUnsignedPostimageWidths"]>[3];
	type Width = ReturnType<Codec["issuanceUnsignedPostimageWidths"]>["final"];
	type Input = {rows: Rows; scope: Scope; control: Control; maxAdditionalCurrentIssued: number; maxCanonicalPreimageByteLength: number;
		maxAdditionalCurrentPreimageBytes?: number};
	type Capacity = {ordinaryPending: Width; ordinaryFinal: Width; successorPending: Width; successorFinal: Width; nativeImageByteLength: number;
		canonicalRowsShape: Readonly<Record<"ordinaryPending" | "ordinaryFinal" | "successorPending" | "successorFinal", {items: number; maxDepth: number}>>};
	async function fixture(next = 2, retained = 2, foreign = true, presentControl = true) {
		const codec = await import("../../issuance-store/src/retirement.js"), contract = await import("../../issuance-store/src/contract.js");
		const path = new URL("../../issuance-store/src/retirement.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (matches.length !== 1) throw Error(`ORDINARY_CAPACITY_CODEC_HELPER:${name}:${matches.length}`);
			return matches[0]!.getText(file).replace(/^export /, "");
		};
		const constant = (name: string) => {
			const values = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
				.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
			if (values.length !== 1) throw Error(`ORDINARY_CAPACITY_CODEC_CONSTANT:${name}:${values.length}`);
			return `const ${values[0]!.getText(file)};`;
		};
		const owner = execute<(input: Input) => Capacity>(`${constant("invalid")}\n${constant("unsignedEncodingLimits")}\n${[
			"unsignedCanonicalShape", "unsignedArrayShape", "unsignedRecordShape", "unsignedVaruintWidth", "unsignedRecordWidth", "unsignedArrayWidth", "unsignedNativeImageWidth", "unsignedNativePhaseWidths",
			// 1515daab: source-custody plan sizing and its native read bound joined the owner.
			"sourceCustodyPlanWidths", "checkSourceCustodyNativeWidths",
			"issuanceOrdinaryFinishingCapacityWidths",
		].map(extract).join("\n")}\nissuanceOrdinaryFinishingCapacityWidths;`, {...codec, ...contract});
		const scope = {objectId: "room", author: "1".repeat(64)}, foreignScope = {...scope, author: "2".repeat(64)};
		const bytes = (selected: Scope, sequence: number, payload = "short") => encodeCanonical({kind: "drp-vertex", protocolMajor: 3,
			...selected, authorSequence: sequence, epoch: 3, anchor: "a".repeat(64), dependencies: ["a".repeat(64)],
			logicalTime: Number.MAX_SAFE_INTEGER, operation: {action: "capacityFixture", payload}});
		// Genuine production structural serializers, not signed protocol/native
		// admission: opaque signatures are mechanical width fixtures only. Future
		// leaves in the production bound remain lengths, never fabricated bytes.
		const signed = (selected: Scope, sequence: number, payload?: string) => {
			const canonicalPreimageBytes = bytes(selected, sequence, payload);
			return {...selected, authorSequence: sequence, canonicalPreimageBytes,
				digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes), signature: new Uint8Array(64).fill(sequence % 251)};
		};
		const issued = Array.from({length: retained}, (_, index) => signed(scope, next - retained + index));
		if (foreign) issued.push(signed(foreignScope, 0, "complete-foreign-PRE-".repeat(256)));
		const rows: Rows = {lineages: [{...scope, next, exhausted: false, prunedThroughAuthorSequence: next > retained ? next - retained - 1 : null},
			...(foreign ? [{...foreignScope, next: 1, exhausted: false, prunedThroughAuthorSequence: null}] : [])], issued,
			outbox: issued.map(row => ({objectId: row.objectId, author: row.author, authorSequence: row.authorSequence,
				digest: row.digest, publishState: "pending" as const})),
			plans: [{scope, revision: 0, fenceSequence: null, entries: []},
				...(foreign ? [{scope: foreignScope, revision: 0, fenceSequence: null, entries: []}] : [])]};
		const control: Control = presentControl ? {kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
			incarnation: "b".repeat(64), revision: 0, sequence: 0, active: null, completed: null} : null;
		const input: Input = {rows, scope, control, maxAdditionalCurrentIssued: 4, maxCanonicalPreimageByteLength: 512};
		const intent = (sequence: number) => {const canonicalPreimageBytes = bytes(scope, sequence); return {
			kind: "v3-issuance-pending-unsigned-1" as const, authorSequence: sequence, canonicalPreimageBytes,
			digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes)};};
		const shapes = execute<{shape(value: unknown): {items: number; maxDepth: number};
			array(children: readonly {items: number; maxDepth: number}[]): {items: number; maxDepth: number};
			record(known: object, unknown: object): {items: number; maxDepth: number}}>(`${constant("invalid")}\n${constant("unsignedEncodingLimits")}\n${[
			"unsignedCanonicalShape", "unsignedArrayShape", "unsignedRecordShape"].map(extract).join("\n")}\n
			({shape: unsignedCanonicalShape, array: unsignedArrayShape, record: unsignedRecordShape});`, {...codec, ...contract});
		return {codec, contract, owner, rows, scope, foreignScope, input, intent, signed, constant, extract, shapes};
	}
	function dominates(bound: Width, exact: Width) {
		for (const key of ["rowCount", "canonicalRowsBytes", "encodedControlBytes", "nativeCensusBytes"] as const)
			expect(bound[key], key).toBeGreaterThanOrEqual(exact[key]);
	}
	it("aggregate local window PRE bytes dominate every variable-size prefix and full pending/fence overlap without multiplying the largest payload", async () => {
		const f = await fixture(126, 2, true), sizes = [0, 127, 128, 2048];
		for (const order of [sizes, [...sizes].reverse(), [128, 2048, 0, 127]]) {
			const future = order.map((size, index) => f.signed(f.scope, 126 + index, "x".repeat(size)));
			const input = {...f.input, maxAdditionalCurrentIssued: future.length, maxCanonicalPreimageByteLength: 4096,
				maxAdditionalCurrentPreimageBytes: future.reduce((sum, row) => sum + row.canonicalPreimageBytes.byteLength, 0)};
			const original = encodeCanonical(input), bound = f.owner(input), rectangle = f.owner({...input,
				maxAdditionalCurrentPreimageBytes: future.length * input.maxCanonicalPreimageByteLength});
			expect(bound.ordinaryFinal.canonicalRowsBytes).toBeLessThan(rectangle.ordinaryFinal.canonicalRowsBytes);
			expect(rectangle.ordinaryFinal.canonicalRowsBytes - bound.ordinaryFinal.canonicalRowsBytes).toBe(
				future.length * input.maxCanonicalPreimageByteLength - input.maxAdditionalCurrentPreimageBytes);
			let rows = f.rows;
			for (const signed of future) {
				const intent = {kind: "v3-issuance-pending-unsigned-1" as const, authorSequence: signed.authorSequence,
					canonicalPreimageBytes: signed.canonicalPreimageBytes, digest: signed.digest};
				const exact = f.codec.issuanceUnsignedPostimageWidths(rows, f.scope, intent, input.control);
				dominates(bound.ordinaryPending, exact.reserved); dominates(bound.ordinaryPending, exact.entered);
				dominates(bound.ordinaryFinal, exact.final);
				const plan = rows.plans.find(row => row.scope.author === f.scope.author)!;
				const fence = f.codec.issuanceUnsignedSuccessorFenceWidths(rows, f.scope, intent, input.control,
					{plan, canonicalPreimageByteLength: input.maxCanonicalPreimageByteLength});
				dominates(bound.successorPending, fence.reserved); dominates(bound.successorPending, fence.entered);
				dominates(bound.successorFinal, fence.final);
				rows = {...rows, lineages: rows.lineages.map(row => row.author === f.scope.author ? {...row, next: signed.authorSequence + 1} : row),
					issued: [...rows.issued, signed], outbox: [...rows.outbox, {objectId: signed.objectId, author: signed.author,
						authorSequence: signed.authorSequence, digest: signed.digest, publishState: "published"}]};
			}
			expect(encodeCanonical(input)).toEqual(original);
		}
		const legacy = f.owner(f.input);
		expect(f.owner({...f.input, maxAdditionalCurrentPreimageBytes: f.input.maxAdditionalCurrentIssued *
			f.input.maxCanonicalPreimageByteLength})).toEqual(legacy);
		expect(f.owner({...f.input, maxAdditionalCurrentIssued: 0, maxAdditionalCurrentPreimageBytes: 0})).toEqual(
			f.owner({...f.input, maxAdditionalCurrentIssued: 0}));
	});
	it("aggregate local window refuses invalid byte declarations and accessors without treating them as paid credit", async () => {
		const f = await fixture();
		for (const budget of [-1, 0, 1.5, NaN, Infinity, undefined, null, Number.MAX_SAFE_INTEGER,
			f.input.maxAdditionalCurrentIssued - 1, f.input.maxAdditionalCurrentIssued * f.input.maxCanonicalPreimageByteLength + 1])
			expect(() => f.owner({...f.input, maxAdditionalCurrentPreimageBytes: budget} as Input)).toThrow();
		expect(() => f.owner({...f.input, maxAdditionalCurrentIssued: 0, maxAdditionalCurrentPreimageBytes: 1})).toThrow();
		let invoked = false;
		const accessor = {...f.input}; Object.defineProperty(accessor, "maxAdditionalCurrentPreimageBytes", {
			enumerable: true, get() {invoked = true; throw Error("untrusted declaration accessor");}});
		expect(() => f.owner(accessor)).toThrow(); expect(invoked).toBe(false);
		const input = {...f.input, maxAdditionalCurrentPreimageBytes: 1024}, before = encodeCanonical(input.rows), bound = f.owner(input);
		input.maxAdditionalCurrentPreimageBytes = 2048;
		expect(bound.ordinaryFinal.canonicalRowsBytes).toBeLessThan(f.owner(input).ordinaryFinal.canonicalRowsBytes);
		expect(encodeCanonical(input.rows)).toEqual(before);
	});
	it("dominates all ordinary and one-fence phases with complete foreign PRE across ordinal/count encoding boundaries", async () => {
		for (const [next, retained, count, present] of [[0, 0, 1, false], [2, 2, 4, true], [126, 2, 4, true],
			[16382, 2, 4, false], [2, 2, 32, true]] as const) {
			const f = await fixture(next, retained, true, present), input = {...f.input, maxAdditionalCurrentIssued: count};
			const before = encodeCanonical(input), bound = f.owner(input); expect(Object.isFrozen(bound)).toBe(true);
			let rows = f.rows;
			for (let offset = 0; offset < count; offset++) {
				const intent = f.intent(next + offset); expect(intent.canonicalPreimageBytes.byteLength).toBeLessThanOrEqual(input.maxCanonicalPreimageByteLength);
				const exact = f.codec.issuanceUnsignedPostimageWidths(rows, f.scope, intent, input.control);
				dominates(bound.ordinaryPending, exact.reserved); dominates(bound.ordinaryPending, exact.entered); dominates(bound.ordinaryFinal, exact.final);
				const plan = rows.plans.find(row => row.scope.author === f.scope.author)!;
				const fence = f.codec.issuanceUnsignedSuccessorFenceWidths(rows, f.scope, intent, input.control,
					{plan, canonicalPreimageByteLength: input.maxCanonicalPreimageByteLength});
				dominates(bound.successorPending, fence.reserved); dominates(bound.successorPending, fence.entered); dominates(bound.successorFinal, fence.final);
				for (const phase of [fence.reserved, fence.entered, fence.final])
					expect(bound.nativeImageByteLength).toBeGreaterThanOrEqual(phase.nativeImageBytes);
				const signed = f.signed(f.scope, intent.authorSequence);
				rows = {...rows, lineages: rows.lineages.map(row => row.author === f.scope.author ? {...row, next: intent.authorSequence + 1} : row),
					issued: [...rows.issued, signed], outbox: [...rows.outbox, {objectId: signed.objectId, author: signed.author,
						authorSequence: signed.authorSequence, digest: signed.digest, publishState: "published"}]};
			}
			expect(encodeCanonical(input)).toEqual(before); // The bound cannot commit or rewrite source PRE.
		}
	});
	it("covers a pending-image descriptor crossing the logical-byte varuint boundary before the final descriptor", async () => {
		const f = await fixture(), replace = (payload: string): Input => {
			const row = f.signed(f.foreignScope, 0, payload);
			return {...f.input, maxAdditionalCurrentIssued: 1, rows: {...f.rows,
				issued: f.rows.issued.map(original => original.author === f.foreignScope.author ? row : original),
				outbox: f.rows.outbox.map(original => original.author === f.foreignScope.author ? {...original, digest: row.digest} : original)}};
		};
		const base = f.owner(replace(""));
		const input = replace("x".repeat(16_384 - 256 - base.successorFinal.canonicalRowsBytes)), bound = f.owner(input);
		expect(bound.successorFinal.canonicalRowsBytes).toBeLessThan(16_384);
		expect(bound.successorPending.canonicalRowsBytes).toBeGreaterThanOrEqual(16_384);
		const image = encodeCanonical({logicalBytes: bound.successorPending.canonicalRowsBytes,
			lineageCount: input.rows.lineages.length, issuedCount: input.rows.issued.length + 2,
			outboxCount: input.rows.outbox.length + 2, planCount: input.rows.plans.length, imageDigest: "0".repeat(64)});
		expect(bound.nativeImageByteLength).toBeGreaterThanOrEqual(image.byteLength);
	});
	it("retains complete existing PRE and refuses malformed scalar, owner, row/byte and counter domains", async () => {
		const f = await fixture(), original = f.owner(f.input);
		const large = f.signed(f.foreignScope, 0, "larger-complete-foreign-PRE-".repeat(512));
		const changed = {...f.input, rows: {...f.rows, issued: f.rows.issued.map(row => row.author === f.foreignScope.author ? large : row),
			outbox: f.rows.outbox.map(row => row.author === f.foreignScope.author ? {...row, digest: large.digest} : row)}};
		const widened = f.owner(changed);
		for (const phase of ["ordinaryPending", "ordinaryFinal", "successorPending", "successorFinal"] as const)
			expect(widened[phase].canonicalRowsBytes - original[phase].canonicalRowsBytes).toBeGreaterThanOrEqual(
				large.canonicalPreimageBytes.byteLength - f.rows.issued.find(row => row.author === f.foreignScope.author)!.canonicalPreimageBytes.byteLength);
		const invalid: object[] = [
			...[-1, 1.5, NaN, Infinity, f.codec.ISSUANCE_RETIREMENT_LIMITS.maxRows + 1].map(maxAdditionalCurrentIssued => ({...f.input, maxAdditionalCurrentIssued})),
			...[0, -1, 1.5, NaN, Infinity, f.codec.ISSUANCE_RETIREMENT_LIMITS.maxBytes + 1].map(maxCanonicalPreimageByteLength => ({...f.input, maxCanonicalPreimageByteLength})),
			{...f.input, extra: true}, {...f.input, scope: {...f.scope, objectId: "foreign"}},
			{...f.input, maxAdditionalCurrentIssued: f.codec.ISSUANCE_RETIREMENT_LIMITS.maxRows},
			{...f.input, maxCanonicalPreimageByteLength: f.codec.ISSUANCE_RETIREMENT_LIMITS.maxBytes},
			{...f.input, control: {...f.input.control!, objectId: "foreign"}},
			{...f.input, control: {...f.input.control!, revision: Number.MAX_SAFE_INTEGER}},
			{...f.input, control: {...f.input.control!, sequence: 1, active: {sequence: 1,
				preparation: {decisionDigest: "a".repeat(64), sourceProofDigest: "c".repeat(64), throughEpoch: 2, protectedRecords: []}}}},
		];
		for (const [index, input] of invalid.entries()) expect(() => f.owner(input as Input), `invalid capacity input ${index}`).toThrow();
		// These are numerical widths, not author/plan authority. The existing
		// reserve and successor owners can legitimately create an absent lineage
		// or plan; sizing must include that birth rather than refuse it or grant it.
		for (const input of [{...f.input, scope: {...f.scope, author: "3".repeat(64)}},
			{...f.input, rows: {...f.rows, plans: f.rows.plans.filter(row => row.scope.author !== f.scope.author)}}]) {
			const width = f.owner(input);
			expect(width.successorFinal.canonicalRowsBytes).toBeGreaterThan(encodeCanonical(input.rows).byteLength);
		}
		const exhausted = await fixture(Number.MAX_SAFE_INTEGER, 0, false);
		expect(() => exhausted.owner(exhausted.input)).toThrow();
	});
	it("does not reclassify inherited reserved or entered exact-retry debt as ordinary rectangle capacity", async () => {
		for (const phase of ["reserved", "entered"] as const) {
			const f = await fixture(0, 0, false), intent = f.intent(0);
			const pending = {...intent, phase, incarnation: f.input.control!.incarnation};
			const rows = {...f.rows, lineages: f.rows.lineages.map(row => ({...row, pendingUnsigned: pending}))};
			const before = encodeCanonical(rows);
			expect(() => f.owner({...f.input, rows})).toThrow();
			const retry = f.codec.issuanceUnsignedPostimageWidths(rows, f.scope, intent, f.input.control);
			expect(retry.final.rowCount).toBeGreaterThan(rows.lineages.length + rows.plans.length);
			expect(retry.entered.nativeCensusBytes).toBeGreaterThan(0); expect(encodeCanonical(rows)).toEqual(before);
			// Refusing the cheap route leaves the original exact retry available.
			// It provides no assertion of crypto entry, persistence or cancellation.
		}
	});
	it("treats scalar finishing widths as data, preserving original terminal-plan and revision refusal gates", async () => {
		const f = await fixture(), intent = f.intent(2), plan = f.rows.plans.find(row => row.scope.author === f.scope.author)!;
		const exhausted = {...plan, revision: Number.MAX_SAFE_INTEGER};
		expect(() => f.codec.issuanceUnsignedSuccessorFenceWidths(f.rows, f.scope, intent, f.input.control,
			{plan: exhausted, canonicalPreimageByteLength: 512})).toThrow();
		const rows = {...f.rows, plans: f.rows.plans.map(row => row === plan ? exhausted : row)};
		expect(() => f.owner({...f.input, rows})).toThrow();
		const unresolved = {...plan, entries: [{sourceSequence: 0, sourceDigest: f.rows.issued[0]!.digest,
			disposition: "manual-review" as const, replacementSequence: null}]};
		expect(() => f.codec.issuanceUnsignedSuccessorFenceWidths(f.rows, f.scope, intent, f.input.control,
			{plan: unresolved, canonicalPreimageByteLength: 512})).toThrow();
		// The helper's positive numbers are not a nominal prepared close/hold,
		// frontier or source-bound room preview and cannot replace those gates.
	});
	it("retains the complete decoded PRE and pending plan expansion while encoded preimage/plan BYTES remain one scalar", async () => {
		const f = await fixture(), plan = f.rows.plans.find(row => row.scope.author === f.scope.author)!;
		const expandedPlan = {...plan, entries: [{sourceSequence: 0, sourceDigest: f.rows.issued[0]!.digest,
			disposition: "expire" as const, replacementSequence: null}]};
		const input = {...f.input, maxAdditionalCurrentIssued: 1, rows: {...f.rows, plans: f.rows.plans.map(row => row === plan ? expandedPlan : row)}};
		const before = encodeCanonical(input.rows), bound = f.owner(input), intent = f.intent(2), signed = f.signed(f.scope, 2);
		const pending = {...intent, incarnation: f.input.control!.incarnation, phase: "reserved"};
		const ordinaryPending = {...input.rows, lineages: input.rows.lineages.map(row => row.author === f.scope.author ? {...row, pendingUnsigned: pending} : row)};
		const ordinaryFinal = {...input.rows, lineages: input.rows.lineages.map(row => row.author === f.scope.author ? {...row, next: 3} : row),
			issued: [...input.rows.issued, signed], outbox: [...input.rows.outbox, {...f.scope, authorSequence: 2, digest: signed.digest, publishState: "published"}]};
		const fencePlan = f.contract.applySettlementPlanEffect(expandedPlan, {kind: "fence"}, 3), fenceIntent = {...f.intent(3),
			phase: "entered", incarnation: f.input.control!.incarnation, planEffect: {kind: "fence"}, exactCanonicalPlanBytes: encodeCanonical(expandedPlan)};
		const successorPending = {...ordinaryFinal, lineages: ordinaryFinal.lineages.map(row => row.author === f.scope.author ? {...row, pendingUnsigned: fenceIntent} : row)};
		const fence = f.signed(f.scope, 3), successorFinal = {...ordinaryFinal, lineages: ordinaryFinal.lineages.map(row => row.author === f.scope.author ? {...row, next: 4} : row),
			issued: [...ordinaryFinal.issued, fence], outbox: [...ordinaryFinal.outbox, {...f.scope, authorSequence: 3, digest: fence.digest, publishState: "pending"}],
			plans: ordinaryFinal.plans.map(row => row.scope.author === f.scope.author ? fencePlan : row)};
		for (const [phase, actual] of Object.entries({ordinaryPending, ordinaryFinal, successorPending, successorFinal})) {
			const expected = f.shapes.shape(decodeCanonical(encodeCanonical(actual))), capacity = bound.canonicalRowsShape[phase as keyof Capacity["canonicalRowsShape"]];
			expect(capacity.items).toBeGreaterThanOrEqual(expected.items); expect(capacity.maxDepth).toBeGreaterThanOrEqual(expected.maxDepth);
			decodeCanonical(encodeCanonical(actual), {maxDepth: capacity.maxDepth, maxItems: capacity.items});
			decodeCanonical(encodeCanonical(actual), {maxItems: expected.items});
			expect(() => decodeCanonical(encodeCanonical(actual), {maxItems: expected.items - 1})).toThrow();
		}
		expect(f.shapes.shape(new Uint8Array(65_536))).toEqual({items: 1, maxDepth: 0});
		const zero = f.owner({...input, maxAdditionalCurrentIssued: 0});
		for (const phase of ["ordinaryPending", "ordinaryFinal", "successorPending", "successorFinal"] as const)
			expect(bound.canonicalRowsShape[phase].items - zero.canonicalRowsShape[phase].items).toBe(48);
		expect(encodeCanonical(input.rows)).toEqual(before);
	});
	it("enforces the native aggregate-node and nesting ceilings independently of encoded byte length", async () => {
		const f = await fixture(), leaf = {items: 1, maxDepth: 0}, maximum = f.codec.ISSUANCE_RETIREMENT_LIMITS.maxRows * 128;
		for (const [value, items] of [[false, 1], [[false], 3], [{leaf: false}, 5], [{rows: [false]}, 7]] as const) {
			expect(f.shapes.shape(value).items).toBe(items); const bytes = encodeCanonical(value);
			decodeCanonical(bytes, {maxItems: items}); expect(() => decodeCanonical(bytes, {maxItems: items - 1})).toThrow();
		}
		const count = (maximum - 2) / 2, actual = Array(count).fill(false);
		expect(f.shapes.array(Array(count).fill(leaf))).toEqual({items: maximum - 1, maxDepth: 1});
		decodeCanonical(encodeCanonical(actual), {maxItems: maximum - 1});
		expect(() => decodeCanonical(encodeCanonical(actual), {maxItems: maximum - 2})).toThrow();
		expect(() => f.shapes.array(Array(count + 1).fill(leaf))).toThrow();
		let nested: unknown = 0; for (let depth = 0; depth < 15; depth++) nested = [nested];
		expect(f.shapes.shape({nested}).maxDepth).toBe(16); expect(() => f.shapes.shape([{nested}])).toThrow();
		const bytes = encodeCanonical([{nested}]); expect(bytes.byteLength).toBeLessThan(128);
		expect(() => decodeCanonical(bytes, {maxBytes: 128, maxDepth: 16})).toThrow();
		expect(() => f.shapes.record({same: 0}, {same: leaf})).toThrow();
	});
});

describe("ordinary finishing journal scalar capacity affected controls", () => {
	type Codec = typeof import("../../live-journal/src/retirement.js");
	type Width = ReturnType<Codec["journalFutureAppendPostimageWidths"]>["afterLocal"];
	type Input = {actualCanonicalRows: readonly Uint8Array[]; currentScope: ReturnType<typeof anchorMaterial>["scope"];
		originalWidths: Width; maxAdditionalCurrentRows: number; maxCanonicalPreimageByteLength: number;
		maxCanonicalAuthorByteLength: number; maxClosedMembershipByteLength: number};
	type Capacity = {scopeCount: number; rowCount: number; canonicalRowByteLengthsTotal: number; canonicalRowsBytes: number; nativeImageBytes: number};
	async function fixture(sql: boolean, count: number, oldMembership = 0) {
		const codec = await import("../../live-journal/src/retirement.js"), canonical = await import("@ts-drp/canonical");
		const path = new URL("../../live-journal/src/retirement.ts", import.meta.url);
		const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (matches.length !== 1) throw Error(`ORDINARY_JOURNAL_CAPACITY_HELPER:${name}:${matches.length}`);
			return matches[0]!.getText(file).replace(/^export /, "");
		};
		const hex = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
			.filter(node => ts.isIdentifier(node.name) && node.name.text === "hex");
		if (hex.length !== 1) throw Error(`ORDINARY_JOURNAL_CAPACITY_HEX:${hex.length}`);
		const owner = execute<(input: Input) => Capacity>(`const ${hex[0]!.getText(file)};\n${["record", "integer", "digest", "scope", "equalNative", "dense",
			"encodeNativeImagePart", "nativeScopeEncoding", "varUintWidth", "futureWidths", "decodeNativeFrames",
			"journalOrdinaryFinishingCapacityProjection", "journalOrdinaryFinishingCapacityFromGeometry", "journalOrdinaryFinishingCapacityWidths"].map(extract).join("\n")}\njournalOrdinaryFinishingCapacityWidths;`,
			{...codec, CanonicalEncodingError: canonical.CanonicalEncodingError});
		const current = anchorMaterial(0), successor = anchorMaterial(1), author = "1".repeat(64), context = current.scope;
		const header = sql ? {object_id: context.objectId, epoch: context.epoch, anchor_digest: context.anchorDigest,
			next_journal_sequence: count, exact_anchor_preimage: current.install.exactCanonicalAnchorPreimageBytes,
			detached_anchor_signature: current.install.detachedAnchorSignature,
			parameters_digest: Buffer.from(hashDomain("ts-drp/parameters/v3", current.install.exactCanonicalParametersCarrierBytes)).toString("hex"),
			exact_parameters_carrier: current.install.exactCanonicalParametersCarrierBytes,
			closed_membership_bytes: oldMembership === 0 ? null : new Uint8Array(oldMembership)} :
			{...context, nextJournalSequence: count, exactCanonicalAnchorPreimageBytes: current.install.exactCanonicalAnchorPreimageBytes,
				detachedAnchorSignature: current.install.detachedAnchorSignature,
				parametersDigest: Buffer.from(hashDomain("ts-drp/parameters/v3", current.install.exactCanonicalParametersCarrierBytes)).toString("hex"),
				exactCanonicalParametersCarrierBytes: current.install.exactCanonicalParametersCarrierBytes,
				...(oldMembership === 0 ? {} : {closedMembershipBytes: new Uint8Array(oldMembership)})};
		const local = (sequence: number) => ({scope: context, sourceKind: "local-issued" as const, author,
			authorSequence: sequence, vertexDigest: Buffer.from(hashDomain("ts-drp/journal-capacity-fixture/v1", encodeCanonical({scope: context, sequence}))).toString("hex")});
		const frames = [codec.journalRetirementCanonicalRow("scopes", [context.objectId, context.epoch, context.anchorDigest], header),
			...Array.from({length: count}, (_, sequence) => codec.journalRetirementCanonicalRow(sql ? "accepted_entries" : "acceptedEntries",
				[context.objectId, context.epoch, context.anchorDigest, sequence], sql ? {object_id: context.objectId,
					epoch: context.epoch, anchor_digest: context.anchorDigest, journal_sequence: sequence, source_kind: "local-issued",
					vertex_digest: local(sequence).vertexDigest, local_author: author, local_author_sequence: sequence,
					received_preimage: null, received_signature: null} : {...context, journalSequence: sequence,
					sourceKind: "local-issued", vertexDigest: local(sequence).vertexDigest, localAuthor: author, localAuthorSequence: sequence}))];
		const install = {objectId: successor.install.objectId, exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes};
		// The original forecast refuses any new declaration over existing membership.
		// Keep that real semantic refusal: populated PRE retains its old carrier;
		// only originally absent membership can reserve a new declaration.
		const membershipByteLength = oldMembership === 0 ? 128 : 0;
		const original = codec.journalFutureAppendPostimageWidths(frames, local(count), install,
			{author, authorSequence: count + 1}, [], {closedMembershipByteLength: membershipByteLength});
		const input: Input = {actualCanonicalRows: frames, currentScope: context, originalWidths: original.afterSuccessorLocal!,
			maxAdditionalCurrentRows: 64, maxCanonicalPreimageByteLength: 512,
			maxCanonicalAuthorByteLength: encodeCanonical(author).byteLength, maxClosedMembershipByteLength: 128};
		return {codec, owner, input, original, local, install, author, count, membershipByteLength};
	}
	function dominates(bound: Capacity, exact: Width) {
		for (const key of ["scopeCount", "rowCount", "canonicalRowsBytes", "nativeImageBytes"] as const)
			expect(bound[key], key).toBeGreaterThanOrEqual(exact[key]);
		expect(bound.canonicalRowByteLengthsTotal).toBeGreaterThanOrEqual(exact.canonicalRowBytes.reduce((sum, width) => sum + width, 0));
	}
	it("dominates complete SQL/browser local and received alternatives across 127/128 array counts without refunding old membership PRE", async () => {
		for (const sql of [false, true]) for (const count of [61, 125]) for (const oldMembership of [0, 16_384]) {
			const f = await fixture(sql, count, oldMembership), before = encodeCanonical(f.input), bound = f.owner(f.input);
			const appends = Array.from({length: 64}, (_, index) => f.local(count + index + 1));
			const local = f.codec.journalFutureAppendPostimageWidths(f.input.actualCanonicalRows, f.local(count), f.install,
				{author: f.author, authorSequence: count + 65}, appends, {closedMembershipByteLength: f.membershipByteLength});
			for (const point of [local.afterLocal, local.afterSuccessor, local.afterSuccessorLocal!]) dominates(bound, point);
			const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: f.input.currentScope.objectId,
				epoch: f.input.currentScope.epoch, anchor: f.input.currentScope.anchorDigest, author: f.author, authorSequence: 0,
				logicalTime: 1, dependencies: [f.input.currentScope.anchorDigest], operation: {action: "capacityFixture"}});
			expect(preimage.byteLength).toBeLessThanOrEqual(f.input.maxCanonicalPreimageByteLength);
			const received = {scope: f.input.currentScope, sourceKind: "received" as const, exactCanonicalPreimageBytes: preimage,
				detachedSignature: new Uint8Array(64), vertexDigest: Buffer.from(hashDomain("ts-drp/vertex/v3", preimage)).toString("hex")};
			const remote = f.codec.journalFutureAppendPostimageWidths(f.input.actualCanonicalRows, received, f.install,
				{author: f.author, authorSequence: count + 64}, appends.map((row, index) => ({...row, authorSequence: count + index})),
				{closedMembershipByteLength: f.membershipByteLength, localIssuerBasis: {objectId: f.input.currentScope.objectId, author: f.author, nextAuthorSequence: count}});
			for (const point of [remote.afterLocal, remote.afterSuccessor, remote.afterSuccessorLocal!]) dominates(bound, point);
			expect(encodeCanonical(f.input)).toEqual(before); expect(Object.isFrozen(bound)).toBe(true);
			// Width-fixture signatures and rows do not claim native or protocol authority.
		}
	});
	it("requires full PRE, actual backend/header context and finite independent row/image scalar domains", async () => {
		for (const sql of [false, true]) {
			const f = await fixture(sql, 2);
			expect(f.owner(f.input).rowCount).toBe(f.input.originalWidths.rowCount + f.input.maxAdditionalCurrentRows);
			const invalid: object[] = [
				...[-1, 1.5, NaN, Infinity, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1].map(maxAdditionalCurrentRows => ({...f.input, maxAdditionalCurrentRows})),
				{...f.input, maxCanonicalPreimageByteLength: 0}, {...f.input, maxCanonicalAuthorByteLength: 2},
				{...f.input, maxCanonicalPreimageByteLength: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes},
				{...f.input, maxClosedMembershipByteLength: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes},
				{...f.input, actualCanonicalRows: [Uint8Array.of(255)]}, {...f.input, actualCanonicalRows: []},
				{...f.input, currentScope: {...f.input.currentScope, anchorDigest: "f".repeat(64)}},
				{...f.input, originalWidths: {...f.input.originalWidths, canonicalRowBytes: []}},
				{...f.input, originalWidths: {...f.input.originalWidths, nativeImageBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1}},
			];
			for (const input of invalid) expect(() => f.owner(input as Input)).toThrow();
			const [table, key, header] = decodeCanonical(f.input.actualCanonicalRows[0]!) as [string, unknown[], Record<string, unknown>];
			const exhausted = encodeCanonical([table, key, {...header, [sql ? "next_journal_sequence" : "nextJournalSequence"]: Number.MAX_SAFE_INTEGER}]);
			expect(() => f.owner({...f.input, actualCanonicalRows: [exhausted, ...f.input.actualCanonicalRows.slice(1)]})).toThrow();
		}
	});
});

describe("ordinary runtime-only nominal custody affected controls", () => {
	type Native = {check(): Promise<void>; release(): Promise<void>};
	type Signing = {dependencyAnchors: readonly unknown[]; readExactCanonicalRows(): readonly Uint8Array[];
		checkWhile(read: () => Promise<void>): Promise<void>; release(): Promise<void>};
	type Runtime = {exactCanonicalLatchedAclBytes: Uint8Array; authorVertexCounts: readonly {author: string; count: number}[];
		kind: string; epoch: number; pendingIngressCount: number};
	type Lifetime = {plane: object; readRuntime(): Runtime; readReceivedAppend(): {exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array} | undefined;
		readSourceIdentity(): object; readNativeIssuance(): Promise<object>; endReadPhase(): Promise<void>;
		checkWhile(read: () => Promise<void>, signing?: Signing): Promise<void>; borrowSigningDependencies(trusts: readonly object[]): Promise<Signing>;
		borrowCurrentNativeReservation?(owner: "ahe" | "journal" | "floor"): Promise<Native | undefined>;
		acquireNativeIssuanceReservation(): Promise<Native>; release(): Promise<void>};
	function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
	function fixture(received = false, epoch = 3) {
		const path = new URL("../src/v3-live.ts", import.meta.url), file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const kernelPath = new URL("../src/internal/runtime-reclamation.ts", import.meta.url), kernelFile = ts.createSourceFile(kernelPath.pathname,
			readFileSync(kernelPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const rollbackPath = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), rollbackFile = ts.createSourceFile(rollbackPath.pathname,
			readFileSync(rollbackPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (input: ts.SourceFile, name: string) => {
			const matches = input.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (matches.length !== 1) throw Error(`ORDINARY_RUNTIME_HELPER:${name}:${matches.length}`);
			return matches[0]!.getText(input).replace(/^export /, "");
		};
		const state: {member: boolean; signingAcquire?: () => Promise<void>; signingRelease?: () => Promise<void>;
			nativeAcquire?: () => Promise<void>; nativeRelease?: () => Promise<void>; currentBorrow?: () => Promise<void>} = {member: true};
		const calls = {signingAcquires: 0, signingChecks: 0, signingReleases: 0, nativeAcquires: 0, nativeChecks: 0, nativeReleases: 0, currentBorrows: 0,
			aclEncodes: 0};
		const events: string[] = [], signingBytes = [Uint8Array.of(3, 4)], nativeImage = {rows: {lineages: [], plans: [], issued: [], outbox: []}, control: null};
		const originalSigning: Signing = {dependencyAnchors: [], readExactCanonicalRows: () => signingBytes.map(bytes => bytes.slice()),
			checkWhile: async read => {calls.signingChecks++; events.push("original-signing-check"); await read();},
			release: async () => {calls.signingReleases++; events.push("original-signing-release"); await state.signingRelease?.();}};
		const originalNative: Native = {check: async () => {calls.nativeChecks++;},
			release: async () => {calls.nativeReleases++; events.push("original-native-release"); await state.nativeRelease?.();}};
		const store = {}, journal = {}, floor = {}, networkNode = {}, closePlane = {}, author = "1".repeat(64);
		const issuance = {acquireNativeReadReservation: async () => {calls.nativeAcquires++; await state.nativeAcquire?.(); return originalNative;},
			readLineage: async () => {events.push("original-issuer-facade-probe"); return null;}};
		const trust = {objectId: "room", currentEpoch: epoch, currentAnchorDigest: "a".repeat(64), genesisAnchorDigest: "b".repeat(64), profileId: "creator-trusted-settlement-v1"};
		const registrations = new WeakMap<object, Map<string, unknown>>(), receipts = new WeakMap<object, any>(), holds = new WeakMap<object, any>();
		const floors = new WeakMap<object, unknown>(), index = {has: () => false};
		const proofRegistry = new WeakMap<object, any>(), proofFrames = new WeakMap<object, any>(), proofLedgers = new WeakMap<object, any>();
		const registration: any = {active: true, networkNode, topic: "room", payload: {input: {store, settlementFloor: floor}, trust: {trust}},
			liveJournalStore: journal, issuanceStore: issuance, issuanceScope: {objectId: "room", author}, mode: "genesis-active", receiveOnly: false,
			authorization: {kind: "latched-acl", value: {kind: "fixture-acl", epoch, members: [author]}},
			graphVersion: 1, index, epochBytes: 37, closeVertices: new Map([["anchor", {}]]), closeAuthors: new Map(), closeCharges: new Map([["anchor", 37]]),
			controlVertices: new Set(), latchedOperations: new Map(), authorVertexCounts: new Map([[author, 1]]),
			pendingIngress: new Map(), pendingIngressBytes: 0, drainingPendingIngress: false,
			blueprintMachine: {}, blueprintMachineIdentity: {}, snapshotReadiness: {}, blueprintFolded: false, blueprintClosing: false,
			terminalState: "active", operationAdmissionHalted: false, terminalTransitionQueued: false, terminalPublicationEntered: false};
		registrations.set(networkNode, new Map([[registration.topic, registration]]));
		const receipt = {}, evidence: any = {exactCanonicalPreimageBytes: Uint8Array.of(1, 2), signature: new Uint8Array(64).fill(7),
			authenticated: {digest: "c".repeat(64), author: "2".repeat(64), admitted: {}}};
		const receivedFacts = {registration, evidence, sourceAuthorized: false, graphVersion: registration.graphVersion, index,
			custody: {borrow: async () => {calls.currentBorrows++; await state.currentBorrow?.(); return originalNative;}}};
		if (received) {receipts.set(receipt, receivedFacts); registration.pendingIngress.set(evidence.authenticated.digest, {evidence});
			registration.pendingIngressBytes = 83; registration.drainingPendingIngress = true;}
		const api = execute<{seal(registration: any, plane: object, receipt?: object): object | undefined; sourceIdentity(registration: any): object;
			resolve(value: unknown, owners: object): Lifetime | undefined; full(value: unknown, owners: object): unknown;
			fullFacts(value: object): unknown; proofFacts(value: object): unknown;
			prospective(registration: any, bytes: Uint8Array, hold: object): unknown}>(`
			let runtimeKernel, creatorCloseReleaseOwner;
			${["currentRegistration", "sameScope", "creatorOriginalIssuanceStore", "nativeBranchDisplacedSource", "receivedAppendFacts",
				"fullRecoveryCloseHoldFacts", "captureCreatorRecoveryRuntime", "creatorOrdinaryIssuanceRetainedSourceBindings", "creatorOrdinaryIssuanceSourceIdentity", "sealCreatorOrdinaryIssuanceRuntime", "resolveOrdinaryIssuanceRuntimeHold",
				"resolveRecoveryCloseHold", "prospectiveAppendCandidate"].map(name => extract(file, name)).join("\n")}
			${extract(rollbackFile, "creatorOrdinaryIssuanceProofFacts")}
			${["installV3RuntimeReclamationKernel", "resolveCreatorOrdinaryIssuanceRuntimeHold", "resolveCreatorSnapshotRecoveryCloseHold",
				"installCreatorCloseRuntimeRelease", "borrowCreatorCloseSigningDependencies"].map(name => extract(kernelFile, name)).join("\n")}
			const owner = Object.assign(async () => {throw Error("UNEXPECTED_RECLAMATION");}, {resolveRecoveryCloseHold, resolveOrdinaryIssuanceRuntimeHold});
			if (!installV3RuntimeReclamationKernel(owner) || installV3RuntimeReclamationKernel(owner)) throw Error("ORDINARY_RUNTIME_KERNEL_NOT_SINGLE");
			if (!installCreatorCloseRuntimeRelease(Object.assign(() => undefined, {borrowSigningDependencies: controlledSigningBorrow}))) throw Error("ORDINARY_SIGNING_KERNEL_MISSING");
			({seal: sealCreatorOrdinaryIssuanceRuntime, sourceIdentity: creatorOrdinaryIssuanceSourceIdentity, resolve: resolveCreatorOrdinaryIssuanceRuntimeHold,
			full: resolveCreatorSnapshotRecoveryCloseHold, fullFacts: fullRecoveryCloseHoldFacts,
			proofFacts: creatorOrdinaryIssuanceProofFacts, prospective: prospectiveAppendCandidate});`, {
			ObjectFreeze: Object.freeze, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectPrototype: Object.prototype, ArrayPrototype: Array.prototype,
			ObjectIsFrozen: Object.isFrozen,
			ArrayIsArray: Array.isArray, ReflectOwnKeys: Reflect.ownKeys,
			encodeCanonical: (value: unknown) => {if (value === registration.authorization.value) calls.aclEncodes++; return encodeCanonical(value);},
			Uint8ArrayConstructor: Uint8Array, ReflectApply: Reflect.apply, recoveryCloseHolds: holds,
			receivedAppendReceipts: receipts, preparedMigrationTargetFloors: floors, creatorRetainedNativeBranches: new WeakSet(),
			v3PlaneRegistrations: registrations, topicMembership: () => state.member,
			ISSUANCE_RETIREMENT_LIMITS,
			copyCanonicalForAdmittedView,
			durableIssuancePruningMaintenanceForStore: (owner: object) => owner !== issuance ? undefined : {
				readBoundedRecoveryCensus: async () => {events.push("original-issuer-census-read"); return nativeImage;}},
			maintenanceTerminalCustody: proofRegistry, frames: proofFrames, ledgers: proofLedgers,
			controlledSigningBorrow: async () => {calls.signingAcquires++; await state.signingAcquire?.(); return originalSigning;},
		});
		const owners = {store, liveJournalStore: journal, currentTrust: trust};
		const seal = () => api.seal(registration, closePlane, received ? receipt : undefined);
		const opened = () => {const hold = seal(); expect(hold).toBeDefined(); const lifetime = api.resolve(hold, owners); expect(lifetime).toBeDefined(); return {hold: hold!, lifetime: lifetime!};};
		const controlledProof = (runtime: Lifetime) => {
			const proof = {}, frame = {alive: true, reader: {}, accounting: {}};
			proofFrames.set(frame.reader, frame); proofLedgers.set(frame.accounting, frame);
			proofRegistry.set(proof, {kind: "ordinary-proof", frame, runtime});
			return {proof, frame};
		};
		// Controlled owner responses establish lexical fixture custody, not valid
		// signatures/native images. Constructors, nominal registry/kernel dispatch,
		// runtime predicates, asynchronous admission and joining are production code.
		return {api, state, calls, events, registration, owners, receipt, receipts, receivedFacts, evidence, holds, floors,
			registrations, originalSigning, originalNative, closePlane, seal, opened, controlledProof, nativeImage};
	}
	function openedAcl(epoch = 3, author = "1".repeat(64), finalityKey = "2".repeat(64)) {
		const bytes = encodeCanonical({kind: "drp-v3-latched-acl", version: 3, epoch, objectId: "room", permissionless: false,
			members: [{author, finalityKey, groups: ["admin", "finality", "writer"]}]});
		const opened = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: bytes, expectedEpoch: epoch,
			expectedObjectId: "room", expectedProfileId: "creator-trusted-settlement-v1",
			expectedAclDigest: Buffer.from(hashDomain("ts-drp/latched-acl/v3", bytes)).toString("hex")});
		if (!opened.ok) throw Error("ORDINARY_IDENTITY_REAL_ACL_REFUSED");
		return opened.snapshot;
	}
	it("encodes a real opened immutable ACL once while original runtime and native checks remain fresh", async () => {
		const f = fixture(); f.registration.authorization.value = openedAcl();
		const first = f.api.sourceIdentity(f.registration); expect(f.calls.aclEncodes).toBe(1);
		for (let index = 0; index < 32; index++) expect(f.api.sourceIdentity(f.registration)).toBe(first);
		expect(f.calls.aclEncodes).toBe(1);
		expect(f.registration.ordinaryIssuanceSourceIdentity.immutableAcl).toBe(f.registration.authorization.value);
		const {lifetime} = f.opened(), issuer = await lifetime.acquireNativeIssuanceReservation();
		await lifetime.readNativeIssuance(); const before = f.calls.nativeChecks;
		await issuer.check(); await issuer.check(); expect(f.calls.nativeChecks).toBe(before + 2);
		const identityEncodes = f.calls.aclEncodes;
		expect(lifetime.readSourceIdentity()).toBe(first); expect(lifetime.readSourceIdentity()).toBe(first);
		expect(f.calls.aclEncodes).toBe(identityEncodes);
		f.state.member = false; expect(() => lifetime.readSourceIdentity()).toThrow("stale or revoked");
		await lifetime.release();
	});
	it("uses the captured frozen predicate after enrollment when the global predicate is replaced", () => {
		const f = fixture(); f.registration.authorization.value = openedAcl(); f.api.sourceIdentity(f.registration);
		const leaf = {value: 1}, original = Object.isFrozen;
		try {
			Object.isFrozen = () => true;
			f.registration.authorization.value = Object.freeze({leaf});
			const token = f.api.sourceIdentity(f.registration); expect(f.api.sourceIdentity(f.registration)).toBe(token);
			expect(f.registration.ordinaryIssuanceSourceIdentity.immutableAcl).toBeUndefined();
			leaf.value = 2; expect(f.api.sourceIdentity(f.registration)).not.toBe(token); expect(f.calls.aclEncodes).toBe(4);
		} finally { Object.isFrozen = original; }
	});
	it("preserves equal-byte replacement semantics but invalidates changed ACL leaves and every original context binding", () => {
		const f = fixture(); f.registration.authorization.value = openedAcl(); const first = f.api.sourceIdentity(f.registration);
		const oldAcl = f.registration.authorization.value; f.registration.authorization.value = openedAcl();
		expect(f.registration.authorization.value).not.toBe(oldAcl); expect(f.api.sourceIdentity(f.registration)).toBe(first);
		expect(f.calls.aclEncodes).toBe(2); expect(f.api.sourceIdentity(f.registration)).toBe(first); expect(f.calls.aclEncodes).toBe(2);
		for (const next of [openedAcl(3, "3".repeat(64)), openedAcl(3, "3".repeat(64), "4".repeat(64)), openedAcl(4)]) {
			const prior = f.api.sourceIdentity(f.registration); f.registration.authorization.value = next;
			expect(f.api.sourceIdentity(f.registration)).not.toBe(prior);
		}
		const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
			f => {f.registration.payload = {...f.registration.payload};}, f => {f.registration.authorization = {...f.registration.authorization};},
			f => {f.registration.historicalIssuance = {capability: {}};}, f => {f.registration.payload.input.store = {};},
			f => {f.registration.liveJournalStore = {};}, f => {f.registration.issuanceStore = {};},
			f => {f.registration.blueprintMachine = {};}, f => {f.registration.blueprintMachineIdentity = {};},
			f => {f.registration.snapshotReadiness = {...f.registration.snapshotReadiness, read: () => {throw Error("UNEXPECTED_CALLBACK");}};},
			f => {f.registration.payload.input.settlementFloor = {};},
			...["objectId", "currentEpoch", "currentAnchorDigest", "genesisAnchorDigest", "profileId"].map(key =>
				(f: ReturnType<typeof fixture>) => {f.registration.payload.trust.trust[key] = key === "currentEpoch" ? 4 : "changed";})];
		for (const change of mutations) {
			const f = fixture(); f.registration.authorization.value = openedAcl(); const prior = f.api.sourceIdentity(f.registration);
			change(f); expect(f.api.sourceIdentity(f.registration)).not.toBe(prior); expect(f.calls.aclEncodes).toBe(2);
		}
		const replaced = fixture(); replaced.registration.authorization.value = openedAcl(); replaced.api.sourceIdentity(replaced.registration);
		replaced.registrations.set(replaced.registration.networkNode, new Map());
		expect(() => replaced.api.sourceIdentity(replaced.registration)).toThrow("source context is unavailable");
	});
	it("keeps complete per-call encoding for frozen shells containing mutable records, bytes, Map or Set", () => {
		const examples = [
			{leaf: {value: 1}, change: (leaf: any) => {leaf.value = 2;}},
			{leaf: Uint8Array.of(1), change: (leaf: any) => {leaf[0] = 2;}},
			{leaf: Object.freeze(new Map([["value", 1]])), change: (leaf: any) => {leaf.set("value", 2);}},
			{leaf: Object.freeze(new Set([1])), change: (leaf: any) => {leaf.add(2);}},
		];
		for (const example of examples) {
			const f = fixture(); f.registration.authorization.value = Object.freeze({leaf: example.leaf});
			const prior = f.api.sourceIdentity(f.registration); expect(f.registration.ordinaryIssuanceSourceIdentity.immutableAcl).toBeUndefined();
			expect(f.api.sourceIdentity(f.registration)).toBe(prior); expect(f.calls.aclEncodes).toBe(2);
			example.change(example.leaf); expect(f.api.sourceIdentity(f.registration)).not.toBe(prior); expect(f.calls.aclEncodes).toBe(3);
		}
		const f = fixture(); f.registration.authorization.value = openedAcl(); const prior = f.api.sourceIdentity(f.registration);
		f.registration.authorization.value = decodeCanonical(encodeCanonical(f.registration.authorization.value));
		expect(f.api.sourceIdentity(f.registration)).toBe(prior); expect(f.registration.ordinaryIssuanceSourceIdentity.immutableAcl).toBeUndefined();
		expect(f.api.sourceIdentity(f.registration)).toBe(prior); expect(f.calls.aclEncodes).toBe(3);
		// The original array codec reads indexed getters. A frozen accessor array
		// therefore remains on its original per-call path, never an immutable fact.
		let selected = 1, reads = 0; const array: number[] = [];
		Object.defineProperty(array, "0", {enumerable: true, get: () => {reads++; return selected;}}); Object.freeze(array);
		const accessor = fixture(); accessor.registration.authorization.value = Object.freeze({array});
		const token = accessor.api.sourceIdentity(accessor.registration); expect(accessor.api.sourceIdentity(accessor.registration)).toBe(token);
		selected = 2; expect(accessor.api.sourceIdentity(accessor.registration)).not.toBe(token);
		expect(accessor.calls.aclEncodes).toBe(3); expect(reads).toBe(3);
		expect(accessor.registration.ordinaryIssuanceSourceIdentity.immutableAcl).toBeUndefined();
	});
	it("retains original codec failures and never reads accessors to establish immutability", () => {
		let reads = 0; const accessor = Object.freeze(Object.defineProperty({}, "leaf", {enumerable: true, get: () => {reads++; return 1;}}));
		const cycle: any = {}; cycle.self = cycle; Object.freeze(cycle);
		for (const acl of [undefined, Object.freeze({leaf: NaN}), Object.freeze({leaf: new Date(0)}), Object.freeze({leaf: () => 1}), accessor, cycle]) {
			const f = fixture(); f.registration.authorization.value = acl;
			expect(() => f.api.sourceIdentity(f.registration)).toThrow(); expect(f.calls.aclEncodes).toBe(1);
			expect(f.registration.ordinaryIssuanceSourceIdentity).toBeUndefined();
		}
		expect(reads).toBe(0);
		const f = fixture(); let selected = openedAcl(); Object.defineProperty(f.registration.authorization, "value", {get: () => selected});
		const prior = f.api.sourceIdentity(f.registration); selected = openedAcl(4);
		expect(f.api.sourceIdentity(f.registration)).not.toBe(prior); expect(f.calls.aclEncodes).toBe(2);
	});
	it("resolves only the same nominal local or entered-foreign runtime and returns detached observations without full-census authority", async () => {
		for (const received of [false, true]) for (const epoch of [0, 5]) {
			const f = fixture(received, epoch), {hold, lifetime} = f.opened(); expect(lifetime.plane).toBe(f.closePlane);
			expect(f.api.resolve(hold, f.owners)).toBe(lifetime); expect(f.api.resolve({...hold}, f.owners)).toBeUndefined();
			expect(f.api.resolve({}, f.owners)).toBeUndefined(); expect(f.api.resolve(hold, {...f.owners, store: {}})).toBeUndefined();
			expect(f.api.resolve(hold, {...f.owners, currentTrust: {...f.owners.currentTrust, currentEpoch: epoch + 1}})).toBeUndefined();
			expect(f.api.full(hold, f.owners)).toBeUndefined(); expect(f.api.fullFacts(hold)).toBeUndefined();
			expect(() => f.api.prospective(f.registration, Uint8Array.of(1), hold)).toThrow("no complete prospective census");
			expect("completeRetirement" in lifetime).toBe(false);
			const first = lifetime.readRuntime(), acl = first.exactCanonicalLatchedAclBytes.slice();
			const identity = lifetime.readSourceIdentity(); expect(Object.isFrozen(identity)).toBe(true);
			expect(lifetime.readSourceIdentity()).toBe(identity);
			await expect(lifetime.readNativeIssuance()).rejects.toThrow("lacks native exclusion");
			const issuer = await lifetime.acquireNativeIssuanceReservation();
			expect(await lifetime.readNativeIssuance()).toBe(f.nativeImage);
			expect(f.events.indexOf("original-issuer-facade-probe")).toBeLessThan(f.events.indexOf("original-issuer-census-read"));
			expect(f.calls.nativeChecks).toBeGreaterThan(0); await issuer.release();
			expect(first.kind).toBe(received ? "received-append" : "local-issuance"); expect(first.epoch).toBe(epoch);
			expect(first.pendingIngressCount).toBe(Number(received)); first.exactCanonicalLatchedAclBytes.fill(255);
			expect(lifetime.readRuntime().exactCanonicalLatchedAclBytes).toEqual(acl);
			expect(Object.isFrozen(first.authorVertexCounts)).toBe(true); expect(Object.isFrozen(first.authorVertexCounts[0])).toBe(true);
			if (received) {const source = lifetime.readReceivedAppend()!; source.exactCanonicalPreimageBytes.fill(255); source.signature.fill(255);
				expect(lifetime.readReceivedAppend()!.exactCanonicalPreimageBytes).toEqual(f.evidence.exactCanonicalPreimageBytes);
				expect(lifetime.readReceivedAppend()!.signature).toEqual(f.evidence.signature);}
			else expect(lifetime.readReceivedAppend()).toBeUndefined();
			await lifetime.release(); expect(f.api.resolve(hold, f.owners)).toBeUndefined(); expect(() => lifetime.readRuntime()).toThrow("revoked");
		}
	});
	it("falls back for unsupported initial custody and invalidates graph, ACL/history, native owner, pending and rebase changes", async () => {
		const initial: ((f: ReturnType<typeof fixture>) => void)[] = [f => {f.registration.receiveOnly = true;}, f => {f.registration.mode = "snapshot-closed";},
			f => {f.registration.blueprintMachine = undefined;}, f => {f.registration.operationAdmissionHalted = true;}, f => {f.registration.terminalBarrier = {};},
			f => {f.registration.rebaseSnapshot = [{}];}, f => {f.registration.rebaseCursor = 0;}, f => {f.floors.set(f.registration, {});},
			f => {f.registration.currentReplacementCustody = {};}, f => {f.registration.pendingIngress.set("foreign", {});},
			f => {f.registration.displacedSource = {prepared: {trust: {trust: {...f.owners.currentTrust}}, provenance: {}, input: {}}};}];
		for (const change of initial) {const f = fixture(); change(f); expect(f.seal()).toBeUndefined();}
		const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [f => {f.registration.graphVersion++;}, f => {f.registration.index = {has: () => false};},
			f => {f.registration.authorization = {...f.registration.authorization};}, f => {f.registration.historicalIssuance = {capability: {}};},
			f => {f.registration.payload.input.store = {};}, f => {f.registration.liveJournalStore = {};}, f => {f.registration.issuanceStore = {};},
			f => {f.registration.blueprintMachine = {};}, f => {f.registration.snapshotReadiness = {};}, f => {f.registration.epochBytes++;},
			f => {f.registration.closeVertices.set("new", {});}, f => {f.registration.authorVertexCounts.set("1".repeat(64), 2);},
			f => {f.registration.pendingIngress.set("foreign", {});}, f => {f.registration.pendingIngressBytes++;},
			f => {f.registration.rebaseSnapshot = [];}, f => {f.registration.rebaseCursor = 0;}, f => {f.registration.active = false;},
			f => {f.registrations.set(f.registration.networkNode, new Map());}, f => {f.state.member = false;}];
		for (const change of mutations) {const f = fixture(), {hold, lifetime} = f.opened(); change(f);
			expect(f.api.resolve(hold, f.owners)).toBeUndefined(); expect(() => lifetime.readRuntime()).toThrow("stale or revoked"); await lifetime.release();}
		const foreign = fixture(true); foreign.receipts.delete(foreign.receipt); expect(foreign.seal()).toBeUndefined();
		const source = fixture(true); source.receivedFacts.sourceAuthorized = true; expect(source.seal()).toBeUndefined();
		const stale = fixture(true), opened = stale.opened(); stale.receipts.delete(stale.receipt);
		expect(stale.api.resolve(opened.hold, stale.owners)).toBeUndefined(); await opened.lifetime.release();
	});
	it("revokes a queued combined signing read before either original bracket or callback entry and bounds one borrow per owner", async () => {
		const f = fixture(), {lifetime} = f.opened(), child = await lifetime.borrowSigningDependencies([f.owners.currentTrust]);
		let reads = 0; const task = lifetime.checkWhile(async () => {reads++;}, child), outcome = task.catch(error => error);
		const releasing = child.release(); expect(child.release()).toBe(releasing); await expect(child.checkWhile(async () => {})).rejects.toThrow("revoked");
		expect(await outcome).toBeInstanceOf(TypeError); await releasing; expect(reads).toBe(0); expect(f.calls.signingChecks).toBe(0);
		await expect(lifetime.borrowSigningDependencies([f.owners.currentTrust])).rejects.toThrow("already enrolled");
		const native = await lifetime.acquireNativeIssuanceReservation(); await native.release();
		await expect(lifetime.acquireNativeIssuanceReservation()).rejects.toThrow("already enrolled");
		await lifetime.release(); expect(f.calls.signingAcquires).toBe(1); expect(f.calls.signingReleases).toBe(1); expect(f.calls.nativeReleases).toBe(1);
		const received = fixture(true), active = received.opened();
		for (const owner of ["ahe", "journal", "floor"] as const) {const borrowed = await active.lifetime.borrowCurrentNativeReservation!(owner);
			await borrowed!.release(); await expect(active.lifetime.borrowCurrentNativeReservation!(owner)).rejects.toThrow("already enrolled");}
		await active.lifetime.release(); expect(received.calls.currentBorrows).toBe(3); expect(received.calls.nativeReleases).toBe(3);
	});
	it("joins an already-entered combined read before physical cleanup and preserves explicit child cleanup failure in the parent", async () => {
		const f = fixture(), {hold, lifetime} = f.opened(), child = await lifetime.borrowSigningDependencies([f.owners.currentTrust]);
		const entered = gate(), resume = gate(), cleanupEntered = gate(), cleanupResume = gate(), cleanup = Error("original-signing-cleanup-failed");
		f.state.signingRelease = async () => {cleanupEntered.resolve(); await cleanupResume.promise; throw cleanup;};
		const reading = lifetime.checkWhile(async () => {entered.resolve(); await resume.promise;}, child), readOutcome = reading.catch(error => error); await entered.promise;
		const releasing = child.release(), childOutcome = releasing.catch(error => error), parent = lifetime.release(), parentOutcome = parent.catch(error => error);
		expect(f.api.resolve(hold, f.owners)).toBeUndefined(); expect(f.calls.signingReleases).toBe(0);
		await expect(lifetime.checkWhile(async () => {}, child)).rejects.toThrow("revoked"); resume.resolve(); expect(await readOutcome).toBeInstanceOf(TypeError);
		await cleanupEntered.promise; expect(f.calls.signingReleases).toBe(1); let joined = false; void parentOutcome.then(() => {joined = true;});
		await Promise.resolve(); expect(joined).toBe(false); cleanupResume.resolve(); expect(await childOutcome).toBe(cleanup);
		const failure = await parentOutcome; expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toContain(cleanup); expect(failure.cause).toBe(cleanup);
		expect(lifetime.release()).toBe(parent); expect(f.calls.signingReleases).toBe(1);
	});
	it("joins native issuance acquired after parent revocation and never opens a second reservation", async () => {
		const f = fixture(), {lifetime} = f.opened(), entered = gate(), resume = gate();
		f.state.nativeAcquire = async () => {entered.resolve(); await resume.promise;};
		const acquisition = lifetime.acquireNativeIssuanceReservation(), outcome = acquisition.catch(error => error); await entered.promise;
		const releasing = lifetime.release(); let joined = false; void releasing.then(() => {joined = true;});
		await expect(lifetime.acquireNativeIssuanceReservation()).rejects.toThrow("already enrolled"); expect(f.calls.nativeReleases).toBe(0);
		resume.resolve(); expect(await outcome).toBeInstanceOf(TypeError); await releasing; expect(joined).toBe(true);
		expect(f.calls.nativeAcquires).toBe(1); expect(f.calls.nativeReleases).toBe(1);
	});
	it("retains a failed late signing acquisition cleanup in the parent terminal outcome", async () => {
		const f = fixture(), {lifetime} = f.opened(), entered = gate(), resume = gate(), cleanup = Error("late-signing-cleanup-failed");
		f.state.signingAcquire = async () => {entered.resolve(); await resume.promise;}; f.state.signingRelease = async () => {throw cleanup;};
		const acquisition = lifetime.borrowSigningDependencies([f.owners.currentTrust]), outcome = acquisition.catch(error => error); await entered.promise;
		const releasing = lifetime.release(), parent = releasing.catch(error => error); resume.resolve();
		const failed = await outcome; expect(failed).toBeInstanceOf(AggregateError); expect(failed.errors).toContain(cleanup);
		const terminal = await parent; expect(terminal).toBeInstanceOf(AggregateError); expect(terminal.errors).toContain(cleanup);
		expect(f.calls.signingAcquires).toBe(1); expect(f.calls.signingReleases).toBe(1); expect(lifetime.release()).toBe(releasing);
	});
	it("ends the read phase with immediate read and borrow revocation, joining admitted checks without releasing any physical child", async () => {
		for (const received of [false, true]) {
			const f = fixture(received), {hold, lifetime} = f.opened(), child = await lifetime.borrowSigningDependencies([f.owners.currentTrust]);
			const issuer = await lifetime.acquireNativeIssuanceReservation(), current: Native[] = [];
			if (received) for (const owner of ["ahe", "journal", "floor"] as const)
				current.push((await lifetime.borrowCurrentNativeReservation!(owner))!);
			const {proof, frame} = f.controlledProof(lifetime); expect(f.api.proofFacts(proof)).toBeDefined();
			const entered = gate(), resume = gate();
			const reading = lifetime.checkWhile(async () => {entered.resolve(); await resume.promise;}, child), outcome = reading.catch(error => error);
			await entered.promise; const ending = lifetime.endReadPhase(); expect(lifetime.endReadPhase()).toBe(ending);
			let joined = false; void ending.then(() => {joined = true;});
			expect(f.api.resolve(hold, f.owners)).toBeUndefined(); expect(f.api.proofFacts(proof)).toBeUndefined(); expect(frame.alive).toBe(true);
			for (const read of [() => lifetime.readRuntime(), () => lifetime.readSourceIdentity(),
				() => lifetime.readReceivedAppend(), () => child.readExactCanonicalRows()]) expect(read).toThrow("revoked");
			await expect(lifetime.readNativeIssuance()).rejects.toThrow("revoked");
			await expect(lifetime.checkWhile(async () => {})).rejects.toThrow("revoked");
			await expect(child.checkWhile(async () => {})).rejects.toThrow("revoked");
			for (const native of [issuer, ...current]) await expect(native.check()).rejects.toThrow("revoked");
			await expect(lifetime.borrowSigningDependencies([f.owners.currentTrust])).rejects.toThrow();
			await expect(lifetime.acquireNativeIssuanceReservation()).rejects.toThrow();
			expect(f.calls.signingAcquires).toBe(1); expect(f.calls.nativeAcquires).toBe(1);
			expect(f.calls.signingReleases).toBe(0); expect(f.calls.nativeReleases).toBe(0); expect(joined).toBe(false);
			resume.resolve(); expect(await outcome).toBeInstanceOf(TypeError); await ending; expect(joined).toBe(true);
			expect(f.calls.signingReleases).toBe(0); expect(f.calls.nativeReleases).toBe(0);
			const releasing = lifetime.release(); expect(lifetime.release()).toBe(releasing); await releasing;
			expect(f.calls.signingReleases).toBe(1); expect(f.calls.nativeReleases).toBe(received ? 4 : 1);
			expect(f.api.resolve(hold, f.owners)).toBeUndefined(); expect(f.api.proofFacts(proof)).toBeUndefined();
			// Controlled physical children and proof registry establish lifecycle
			// ordering only; they do not authenticate native images or grant effects.
		}
		const untouched = fixture(true), {lifetime} = untouched.opened(); await lifetime.endReadPhase();
		await expect(lifetime.borrowSigningDependencies([untouched.owners.currentTrust])).rejects.toThrow("revoked");
		await expect(lifetime.acquireNativeIssuanceReservation()).rejects.toThrow("revoked");
		await expect(lifetime.borrowCurrentNativeReservation!("floor")).rejects.toThrow("revoked");
		expect(untouched.calls.signingAcquires).toBe(0); expect(untouched.calls.nativeAcquires).toBe(0); expect(untouched.calls.currentBorrows).toBe(0);
		await lifetime.release();
	});
	it("retains child cleanup failure after read-phase revocation in the once-only terminal physical join", async () => {
		const f = fixture(), {lifetime} = f.opened(), child = await lifetime.borrowSigningDependencies([f.owners.currentTrust]);
		await lifetime.acquireNativeIssuanceReservation(); const ending = lifetime.endReadPhase(); await ending;
		expect(f.calls.signingReleases).toBe(0); expect(f.calls.nativeReleases).toBe(0);
		const cleanupEntered = gate(), cleanupResume = gate(), cleanup = Error("post-read-phase-signing-cleanup-failed");
		f.state.signingRelease = async () => {cleanupEntered.resolve(); await cleanupResume.promise; throw cleanup;};
		const childRelease = child.release(), childOutcome = childRelease.catch(error => error); await cleanupEntered.promise;
		const releasing = lifetime.release(), terminal = releasing.catch(error => error); let joined = false;
		void terminal.then(() => {joined = true;}); await Promise.resolve(); expect(joined).toBe(false);
		cleanupResume.resolve(); expect(await childOutcome).toBe(cleanup);
		const failure = await terminal; expect(failure).toBeInstanceOf(AggregateError);
		expect(failure.errors).toContain(cleanup); expect(failure.cause).toBe(cleanup);
		expect(lifetime.release()).toBe(releasing); expect(child.release()).toBe(childRelease); expect(lifetime.endReadPhase()).toBe(ending);
		expect(f.calls.signingReleases).toBe(1); expect(f.calls.nativeReleases).toBe(1);
	});
});

describe("ordinary current-dimensions nominal ownership affected controls", () => {
	it("preserves the original source producer's epoch-two seed and transfer selection without granting retirement", () => {
		const relation = execute<(context: any, source: any, hasContext: boolean) => any>(
			`${declaration("creatorCloseRecoveryRoleSourceRelation").replace(/^export /, "")}\ncreatorCloseRecoveryRoleSourceRelation;`, {});
		const context = {objectId: "room", currentTrust: {currentEpoch: 2}};
		const previous = {closedEpoch: 1, closedAnchorDigest: "1".repeat(64), manifestRef: {digest: "a".repeat(64)}};
		const older = {closedEpoch: 0, closedAnchorDigest: "0".repeat(64), manifestRef: {digest: "b".repeat(64)}};
		const source = {currentTrust: context.currentTrust, sources: [previous, older], installedPromotionSource: null,
			hasRecoveryRoleTransfer: false};
		const selected = relation(context, source, true);
		expect(selected).toEqual({selection: "ordinary-seed", installedPromotionSource: null,
			previousClose: {objectId: "room", epoch: 1, anchor: previous.closedAnchorDigest, manifestDigest: previous.manifestRef.digest}});
		expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.previousClose)).toBe(true);
		// Pure producer spelling is not a nominal source proof or native grant.
		expect(Object.keys(selected).sort()).toEqual(["installedPromotionSource", "previousClose", "selection"]);
		for (const changed of [{...source, currentTrust: {currentEpoch: 1}}, {...source, sources: [previous]},
			{...source, sources: [previous, older, older]}, {...source, sources: [{...previous, closedEpoch: 2}, older]},
			{...source, sources: [previous, {...older, closedEpoch: 1}]}])
			expect(relation(context, changed, true)).toBeUndefined();
		expect(relation(context, source, false)).toBeUndefined();
		const later = {objectId: "room", currentTrust: {currentEpoch: 3}}, laterSource = {...source, currentTrust: later.currentTrust};
		expect(relation(later, laterSource, true)).toBeUndefined();
		expect(relation(later, {...laterSource, hasRecoveryRoleTransfer: true}, false)).toEqual({...selected, selection: "prior-transfer"});
		const installed = {...older, closedEpoch: 0};
		expect(relation(later, {...laterSource, sources: [previous], installedPromotionSource: installed}, false))
			.toEqual({...selected, installedPromotionSource: installed, selection: "installed-promotion"});
		expect(relation(later, {...laterSource, sources: [], installedPromotionSource: installed}, false)).toBeUndefined();
	});
	it("binds the current native tuple to the original candidate selector outside the future composer", () => {
		const head = (row: any) => ({kind: "present", objectId: row.objectId, generationId: row.generationId, closureDigest: row.closureDigest});
		const predecessor = {objectId: "room", generationId: "P", closureDigest: "p", state: "Superseded", baseExpectedHead: {kind: "none"}};
		const companion = {objectId: "room", generationId: "Q", closureDigest: "q", state: "Superseded", baseExpectedHead: head(predecessor)};
		const current = {objectId: "room", generationId: "L", closureDigest: "l", state: "Adopted", baseExpectedHead: head(companion)};
		const rows = [current, companion, predecessor], reader = {generations: rows, head: head(current)};
		const frame = {alive: true, reader}, frames = new WeakMap([[reader, frame]]);
		const cut = {kind: "drp-hard-epoch-cut", epoch: 0, ref: {digest: "cut", byteLength: 1}};
		const qc = {kind: "drp-seal-qc", epoch: 0, ref: {digest: "qc", byteLength: 1}};
		const selected: string[] = [], inspections: any[] = []; let verified = true;
		const read = execute<(forward: any, frame: any) => any>(
			`${declaration("creatorOrdinaryNativeAdvanceResourceFacts")}\ncreatorOrdinaryNativeAdvanceResourceFacts;`, {
			frames, roleHead: head, sameRoleHead: (a: any, b: any) => a.objectId === b.objectId && a.generationId === b.generationId && a.closureDigest === b.closureDigest,
			view: (_reader: any, index: number) => ({candidates: index === 1 ? [cut, qc] : [], closure: []}),
			uniqueCreatorTransitionCandidate: (candidates: any[], kind: string, epoch: number) => {
				selected.push(kind); return candidates.find(row => row.kind === kind && row.epoch === epoch);
			},
			inspectCreatorTransitionAdvance: (input: any) => {inspections.push(input); return {ok: verified};},
		});
		// Controlled dependencies establish lexical/current-data ownership only;
		// this does not assert genuine cryptographic or native acceptance.
		const forward = {reader, rows, predecessorIndex: 2, installed: [], certificates: [],
			currentTrust: {currentEpoch: 1}, predecessorTrust: {currentEpoch: 0}};
		expect(read(forward, frame)).toEqual({currentGenerationId: "L", companionGenerationId: "Q", predecessorGenerationId: "P"});
		expect(selected).toEqual(["drp-hard-epoch-cut", "drp-seal-qc", "v3-live-generation-2"]);
		expect(inspections).toHaveLength(1); expect(inspections[0].proofRefs).toEqual([cut.ref, qc.ref]);
		verified = false; expect(read(forward, frame)).toBeUndefined();
		expect(read({...forward, predecessorIndex: 1}, frame)).toBeUndefined();
		frame.alive = false; expect(read(forward, frame)).toBeUndefined();
	});
	function fixture() {
		const runtimePath = new URL("../src/v3-live.ts", import.meta.url);
		const runtimeFile = ts.createSourceFile(runtimePath.pathname, readFileSync(runtimePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const runtimeDeclaration = (name: string) => {
			const found: ts.FunctionDeclaration[] = [];
			const visit = (node: ts.Node): void => {if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit);};
			visit(runtimeFile); if (found.length !== 1) throw Error(`DIMENSION_RUNTIME_DECLARATION:${name}:${found.length}`);
			return found[0]!.getText(runtimeFile);
		};
		const runtimeProperty = (name: string) => {
			const found: ts.PropertyAssignment[] = [];
			const visit = (node: ts.Node): void => {if (ts.isPropertyAssignment(node) && node.name.getText(runtimeFile) === name) found.push(node); ts.forEachChild(node, visit);};
			visit(runtimeFile); if (found.length !== 1) throw Error(`DIMENSION_RUNTIME_PROPERTY:${name}:${found.length}`);
			return found[0]!.initializer.getText(runtimeFile);
		};
		const runtimeLocal = (name: string) => {
			const found: ts.VariableDeclaration[] = [];
			const visit = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer)
					found.push(node);
				ts.forEachChild(node, visit);
			};
			visit(runtimeFile); if (found.length !== 1) throw Error(`DIMENSION_RUNTIME_LOCAL:${name}:${found.length}`);
			return found[0]!.initializer!.getText(runtimeFile);
		};
		const proofProperty = unique((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) &&
			node.name.getText(parsed) === "readCurrentDimensions").initializer.getText(parsed);
		const unsignedBytes = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, objectId: "room", epoch: 3,
			anchor: "a".repeat(64), author: "1".repeat(64), authorSequence: 1, logicalTime: 1,
			dependencies: ["a".repeat(64)], operation: {action: "place", args: {x: 1}}});
		const state = {current: true, revoked: false, baseBytes: encodeCanonical({x: 0}), checks: 0,
			onCheck: undefined as ((count: number) => Promise<void>) | undefined};
		const sourceIdentity = Object.freeze({});
		const futureCalls: string[] = [], noFuture = (name: string) => () => {futureCalls.push(name); throw Error(`UNEXPECTED_FUTURE:${name}`);};
		const result = execute<{
			proof: {readCurrentDimensions(bytes: Uint8Array): Promise<object | undefined>}; otherProof: object;
			resolve(readout: unknown, proof: object, bytes: Uint8Array): any;
			runtime: {readCurrentDimensions(bytes: Uint8Array): any; resolveCurrentDimensions(value: unknown, bytes: Uint8Array): any};
			frame: {alive: boolean; headerConsumersRevoked?: boolean; pending: Set<Promise<unknown>>};
			book: ReturnType<typeof createCreatorClosedRollbackProofAccounting>; registration: any; native: any;
			seed: any; accountingInputs: Uint8Array[]; runtimeReadout(): any; applicationSources(): any;
			readClosedRecord(value: unknown, keys: readonly string[]): unknown;
			journal: any[];
			resourceTotals(): Readonly<{knownBytes: number; protectedBytes: number; unknownEncodedBytes: number}>;
			knownMaterial(): readonly Uint8Array[];
			knownProtectedMaterial(): readonly Uint8Array[];
		}>(`
			${runtimeDeclaration("isObject")}
			${runtimeDeclaration("snapshotClosedRecord")}
			${runtimeDeclaration("captureCreatorOrdinaryDimensionIntegrity")}
			${["createCreatorClosedRollbackProofAccounting", "creatorOrdinaryIssuanceSourceFacts", "creatorOrdinaryIssuanceProofFacts",
				"creatorOrdinaryIssuanceApplicationSources", "creatorOrdinaryIssuanceDimensionFacts",
				"resolveCreatorOrdinaryNumericalDimensions", "captureCreatorOrdinaryCurrentDimensionsForSizing", "creatorOrdinaryCurrentDimensionStampMatchesForSizing",
				"runCreatorOrdinaryNumericalReadForSizing"].map(name => declaration(name).replace(/^export /, "")).join("\n")}
			const accounting = createCreatorClosedRollbackProofAccounting([]), protectedBytes = Uint8Array.of(1, 2, 3), observedBytes = Uint8Array.of(4, 5);
			accounting.charge(protectedBytes); proofMaterialOwners.get(accounting).chargeObservation(observedBytes);
			accounting.chargeUnknownEncodedLength(7); accounting.chargeUnknownEncodedLength(7);
			const source = Object.freeze({}), sourceIdentity = Object.freeze({}), value = {}, nativeIssuanceCapture = {rows: {
				lineages: [{objectId: "room", epoch: 3, anchorDigest: "a".repeat(64), author: "1".repeat(64), next: 1, exhausted: false}],
				issued: [], outbox: [], plans: []}}, currentJournalCapture = [];
			let issuanceBorrowAvailable = true, preparedCapacityCapture;
			let sourceLinkedApplicationCapture = {currentSignedPreimagesHaveSettlementSource: false,
				currentJournalMaximumAuthorByteLength: 66, effects: [], completedNative: []};
			const machine = {snapshot: () => ({blueprintDigest: "b".repeat(64), stateDigest: "d".repeat(64), exactCanonicalStateBytes: state.baseBytes})};
			const machineIdentity = {machine, expectedStateDigest: "d".repeat(64)};
			const registration = {blueprintMachine: machine, blueprintMachineIdentity: machineIdentity,
				payload: {provenance: {blueprintDigest: "b".repeat(64)}, parameters: {maxDependencies: 4, maxSnapshotBytes: 268435456, snapshotChunkBytes: 65536},
					catalog: {blueprintDigest: "b".repeat(64), artifactId: "grid", artifactDigest: "e".repeat(64), catalogDigest: "f".repeat(64),
						runtimeProfile: "ecmascript-2024-sync-v1", exactArtifactBytes: Uint8Array.of(9), canonicalBlueprintPackageBytes: Uint8Array.of(8)}},
				closeVertices: new Map([["a".repeat(64), {hash: "a".repeat(64), kind: "drp-epoch-anchor", objectId: "room", epoch: 3, dependencies: []}]]),
				index: {has: digest => digest === "a".repeat(64)}, authorization: {}, latchedOperations: new Map()};
			const trust = {objectId: "room", currentEpoch: 3, currentAnchorDigest: "a".repeat(64), profileId: "creator-trusted-v1"};
			const facts = {readRuntime: () => {facts.check(); return {kind: "local-issuance", epoch: 3};},
				check: () => {if (state.revoked || !state.current) throw new TypeError("current read phase revoked");}};
			const readDimensions = ${runtimeLocal("readDimensions")}, resolveDimensions = ${runtimeLocal("resolveDimensions")};
			const originalReadCurrentDimensions = ${runtimeProperty("readCurrentDimensions")};
			let publicRuntimeReadout;
			const lifetime = Object.freeze({readRuntime: facts.readRuntime, readCurrentDimensions: function(bytes) {
				// This extraction fixture supplies the controlled output of the
				// original complete journal verifier, not caller-declared authority.
				sourceLinkedApplicationCapture = {...sourceLinkedApplicationCapture,
					currentSignedPreimagesHaveSettlementSource: currentJournalCapture.some(row =>
						Reflect.get(decodeCanonical(row.exactCanonicalPreimageBytes), "settlementSource") !== undefined)};
				publicRuntimeReadout = originalReadCurrentDimensions.call(this, bytes); return publicRuntimeReadout;
			},
				resolveCurrentDimensions: ${runtimeProperty("resolveCurrentDimensions")}}), runtime = lifetime;
			const capturedFrame = {alive: true, reader: {}, accounting, pending: new Set()};
			frames.set(capturedFrame.reader, capturedFrame); ledgers.set(accounting, capturedFrame);
			const check = async () => {facts.check(); state.checks++; await state.onCheck?.(state.checks); facts.check();};
			// This controlled fixture observes both original freshness brackets;
			// the native producer independently owns their point/full distinction.
			const checkReadEligibility = check;
			const numerical = {};
			const proof = Object.freeze({accounting, readCurrentDimensions: ${proofProperty}}), otherProof = Object.freeze({});
			for (const p of [proof, otherProof]) maintenanceTerminalCustody.set(p, {kind: "ordinary-proof", source, frame: capturedFrame, runtime, numerical});
			const seed = {kind: "ordinary-source", objectId: "room", snapshotScopes: [], snapshotMaterials: [], material: {
				protectedScopes: [], sources: [], installedPromotionSource: null, snapshotTurnover: {survivingScopes: []}}};
			maintenanceTerminalCustody.set(source, seed);
			({proof, otherProof, resolve: creatorOrdinaryIssuanceDimensionFacts, runtime, frame: capturedFrame, book: accounting,
				registration, native: nativeIssuanceCapture, seed, accountingInputs: [protectedBytes, observedBytes],
				journal: currentJournalCapture,
				applicationSources: () => creatorOrdinaryIssuanceApplicationSources(seed),
				resourceTotals: () => proofMaterialOwners.get(accounting).captureKnownResourceTotals(),
				knownMaterial: () => proofMaterialOwners.get(accounting).captureKnownMaterial(),
				knownProtectedMaterial: () => proofMaterialOwners.get(accounting).captureKnownProtectedMaterial(),
				runtimeReadout: () => publicRuntimeReadout, readClosedRecord: snapshotClosedRecord});`, {
			state, proofMaterialOwners: new WeakMap(), maintenanceTerminalCustody: new WeakMap(), frames: new WeakMap(), ledgers: new WeakMap(),
			ObjectFreeze: Object.freeze, Uint8ArrayConstructor: Uint8Array, NumberIsSafeInteger: Number.isSafeInteger, ArrayIsArray: Array.isArray,
			ObjectIsFrozen: Object.isFrozen, ReflectApply: Reflect.apply,
			ObjectDefineProperty: Object.defineProperty,
			TypedArrayPrototype: Object.getPrototypeOf(Uint8Array.prototype),
			TypedArrayByteLengthGetter: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get,
			TypedArrayBufferGetter: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get,
			ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectPrototype: Object.prototype, ReflectOwnKeys: Reflect.ownKeys,
			ObjectCreate: Object.create, ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			settlementProfileFor, APPLICATION_BATCH_ACTION: "applicationBatch", APPLICATION_BATCH_LIMITS: {maxBytes: 65536, maxDepth: 8, maxItems: 1024},
			ordinaryPreviewAppendCandidate: (_registration: unknown, bytes: Uint8Array) => ({bytes: bytes.slice(), digest: new Uint8Array(32),
				scope: {objectId: "room", epoch: 3, anchorDigest: "a".repeat(64), author: "1".repeat(64)}, sequence: 1}),
			isDigestHex: (value: string) => /^[a-f0-9]{64}$/u.test(value), detachedCanonicalOperation: (value: unknown) => value,
			acceptedApplicationOperation: () => true, lowerHexDigest: () => "c".repeat(64), hasGraphCapacity: () => true,
			isControlOperation: () => false, aclOperation: () => ({}), validateLatchedOperation: () => true,
			deriveApplicationProjectionOrder: () => ({order: {digests: [], controlDigests: []}}),
			sameScope: (a: {objectId: string; author: string}, b: {objectId: string; author: string}) => a.objectId === b.objectId && a.author === b.author,
			ownDataValue: (value: object, key: string) => Reflect.get(value, key), ordinaryRuntimePendingIngress: () => [],
			copyCanonicalForAdmittedView, creatorOrdinaryIssuanceSourceIdentity: () => sourceIdentity,
			sameBytes: (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0,
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
			Refusal: class extends Error {constructor(reason: string) {super(reason);}}, failure: (kind: string) => kind,
			prepareCreatorClose: noFuture("prepared-close"), prepareProspectiveCreatorCloseMaterial: noFuture("snapshot"),
			prospectiveCreatorPostAdoptionCensusSizing: noFuture("post-adoption"), composeProspectiveCreatorMaintenancePrefixesForSizing: noFuture("schedule"),
		});
		// Controlled semantic/currency dependencies establish lexical ownership only,
		// not genuine application authentication or a native acceptance claim.
		return {...result, state, unsignedBytes, futureCalls};
	}
	it("uses the real decoder and original closed-record boundary for the exact ten-field candidate", async () => {
		const f = fixture(), decoded = decodeCanonical(f.unsignedBytes) as Record<string, unknown>;
		const keys = ["kind", "protocolMajor", "objectId", "epoch", "anchor", "author", "authorSequence", "logicalTime", "dependencies", "operation"];
		expect(Object.getPrototypeOf(decoded)).toBeNull();
		// The general input boundary must still reject null/foreign prototypes.
		expect(f.readClosedRecord(decoded, keys)).toBeUndefined();
		expect(f.readClosedRecord({...decoded}, keys)).toBeDefined();
		expect(f.readClosedRecord(Object.assign(Object.create({foreign: true}), decoded), keys)).toBeUndefined();
		const accessor = {...decoded}; Object.defineProperty(accessor, "operation", {enumerable: true, get: () => decoded.operation});
		expect(f.readClosedRecord(accessor, keys)).toBeUndefined();
		// Only the current-dimension owner adapts its own genuine decoded bytes.
		const before = f.book.chargedBytes;
		expect(await f.proof.readCurrentDimensions(f.unsignedBytes)).toBeDefined();
		for (const malformed of [{...decoded, extra: 0}, Object.fromEntries(Object.entries(decoded).filter(([key]) => key !== "operation"))]) {
			const bytes = encodeCanonical(malformed);
			expect(await f.proof.readCurrentDimensions(bytes)).toBeUndefined();
		}
		expect(f.book.chargedBytes).toBe(before); expect(f.futureCalls).toEqual([]);
	});
	it("shares the original conditional source-generation filter without dropping any protected binding", () => {
		const select = execute<(input: any) => readonly any[]>(
			`${declaration("creatorConditionalSourceGenerationCandidatesForSizing")}\ncreatorConditionalSourceGenerationCandidatesForSizing;`, {
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
		});
		const scope = (epoch: number) => ({objectId: "room", epoch, anchor: String(epoch).repeat(64), manifestDigest: String(epoch + 1).repeat(64)});
		const retired = scope(0), second = scope(1), required = scope(2);
		const generation = {objectId: "room", generationId: "old-source", state: "Superseded", closureDigest: "a".repeat(64),
			baseExpectedHead: {kind: "none"}, closure: [{digest: "b".repeat(64), byteLength: 1}]};
		const certificate = {roles: {}, supportGenerations: [], authenticatedSourceGenerations: [
			{scope: retired, generation}, {scope: second, generation}]};
		const input = {currentRows: [generation], currentRecoveryRoots: [], certificates: [certificate],
			snapshotRetiringScopes: [retired, second], futureRequiredScopes: [required], existingCandidates: []};
		// Controlled CURRENT certificate data exercises the exact shared filter;
		// it is not a nominal proof or permission to retire a native generation.
		expect(select(input)).toEqual([generation]); expect(Object.isFrozen(select(input))).toBe(true);
		const alreadyRetired = {...input, snapshotRetiringScopes: [], certificates: [{...certificate,
			retiredClassifiedSnapshotScopes: [retired, second]}]};
		expect(select(alreadyRetired)).toEqual([generation]);
		// Each binding needs its OWN certificate's joined retirement fact. A
		// different proof's matching list cannot be used as a global absence set.
		for (const changed of [
			{...alreadyRetired, certificates: [{...certificate, retiredClassifiedSnapshotScopes: [retired]}]},
			{...alreadyRetired, certificates: [{...certificate, retiredClassifiedSnapshotScopes: [retired, {...second, manifestDigest: "f".repeat(64)}]}]},
			{...alreadyRetired, certificates: [certificate, {...certificate, authenticatedSourceGenerations: [], retiredClassifiedSnapshotScopes: [retired, second]}]},
			{...alreadyRetired, futureRequiredScopes: [second]},
			{...alreadyRetired, currentRecoveryRoots: [generation]},
			{...alreadyRetired, certificates: [{...alreadyRetired.certificates[0], supportGenerations: [generation]}]},
			{...alreadyRetired, currentRows: [{...generation, closureDigest: "c".repeat(64)}]},
		]) expect(select(changed)).toEqual([]);
		for (const changed of [{...input, currentRows: []}, {...input, currentRows: [{...generation, closureDigest: "c".repeat(64)}]},
			{...input, currentRecoveryRoots: [generation]}, {...input, existingCandidates: [generation]},
			{...input, snapshotRetiringScopes: [retired]}, {...input, futureRequiredScopes: [required, second]},
			{...input, certificates: [{...certificate, supportGenerations: [generation]}]},
			{...input, certificates: [{...certificate, authenticatedSourceGenerations: [{scope: retired, generation: {...generation, objectId: "other"}}]}]},
			{...input, certificates: [{...certificate, authenticatedSourceGenerations: [{scope: retired, generation: {...generation, state: "Adopted"}}]}]}])
			expect(select(changed)).toEqual([]);
	});
	it("keeps every current recovery-pair prerequisite independent of future source-width candidates", () => {
		const variable = (name: string) => unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === name).getText(parsed);
		const current = {objectId: "room", epoch: 2, anchor: "a".repeat(64), manifestDigest: "b".repeat(64)};
		const previous = {...current, epoch: 1, anchor: "c".repeat(64)};
		const run = (change?: (input: any) => void) => {
			const input = {sourceRelation: {selection: "prior-transfer", previousClose: current},
				capture: {receivedRecoveryScopes: []}, forward: {certificates: []}, material: {sources: [{}, {}]},
				currentSourceScope: current, previousSourceScope: previous, snapshotMaterials: [{scope: current}, {scope: previous}],
				currentRoles: {currentClose: current, previousClose: previous, operationalSources: []},
				originalMaterial: {recoveryRoleTransfer: {}}};
			change?.(input);
			return execute<{pair?: object; predicates: Record<string, boolean>}>(
				`const ${variable("recoveryPairPredicates")}; const ${variable("ordinaryRecoverySourcePair")};\n({pair: ordinaryRecoverySourcePair, predicates: recoveryPairPredicates});`, {
				...input, closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
			});
		};
		// These controlled data predicates do not open source/transfer authority.
		expect(run().pair).toBeDefined();
		for (const change of [(input: any) => {input.material.sources.push({});},
			(input: any) => {input.capture.receivedRecoveryScopes.push(previous);},
			(input: any) => {input.forward.certificates.push({roles: {operationalSources: [previous]}, supportGenerations: []});},
			(input: any) => {input.forward.certificates.push({roles: {operationalSources: []}, supportGenerations: [{}]});},
			(input: any) => {input.snapshotMaterials.pop();},
			(input: any) => {input.currentRoles.previousClose = current;},
			(input: any) => {input.sourceRelation.previousClose = previous;}]) {
			const result = run(change); expect(result.pair).toBeUndefined(); expect(Object.values(result.predicates).includes(false)).toBe(true);
		}
	});
	it("shares the original classified and exact-inventory scope projections without creating roles", () => {
		const api = execute<{classified: (protectedScopes: any[], source: any, previous: any) => readonly any[];
			inventory: (classified: readonly any[], inventory: any[]) => readonly any[]}>(
			`${["creatorCloseRecoveryRoleScopeEqual", "creatorCloseRecoveryRoleClassifiedScopesForSizing",
				"creatorCloseRecoveryRoleInventoryScopesForSizing"].map(name => declaration(name).replace(/^export /, "")).join("\n")}\n` +
			`({classified: creatorCloseRecoveryRoleClassifiedScopesForSizing, inventory: creatorCloseRecoveryRoleInventoryScopesForSizing});`, {});
		const scope = (epoch: number) => ({objectId: "room", epoch, anchor: String(epoch).repeat(64), manifestDigest: "a".repeat(64)});
		const source = scope(0), previous = scope(1), retained = scope(2), retired = scope(3);
		const classified = api.classified([source, previous, retained, {...retained}, retired], source, previous);
		expect(classified).toEqual([retained, retired]); expect(Object.isFrozen(classified)).toBe(true);
		expect(api.inventory(classified, [{...retained}, {...retired, manifestDigest: "b".repeat(64)}])).toEqual([retained]);
		expect(api.classified([source, previous], undefined, previous)).toEqual([source]);
		expect(api.inventory(classified, [])).toEqual([]);
		// These are exact data projections; the native producer still uses the
		// original bounded role parser and original authentication afterwards.
	});
	function receiptFixture() {
		const state = {checks: 0, lookups: 0, live: true, nativeError: undefined as Error | undefined,
			received: null as any, afterLookup: undefined as (() => void) | undefined};
		const scope = Object.freeze({objectId: "room", epoch: 2, anchor: "a".repeat(64), manifestDigest: "b".repeat(64)});
		const accounting = createCreatorClosedRollbackProofAccounting([]), frame = {alive: true, reader: {}, accounting, pending: new Set<Promise<unknown>>()};
		const frames = new WeakMap([[frame.reader, frame]]), ledgers = new WeakMap([[accounting, frame]]);
		const inventory = {scopes: [{scope, incarnation: "current-incarnation"}]};
		const input = {snapshotStore: {lookupReceivedRecoveryCertificate: async () => {
			state.lookups++; if (state.nativeError !== undefined) throw state.nativeError;
			state.afterLookup?.(); return state.received;
		}}};
		const read = execute<(input: any, frame: any, inventory: any, check: () => Promise<void>) => Promise<readonly any[]>>(
			`${declaration("captureCreatorMaintenanceReceivedRecoveryScopes")}\ncaptureCreatorMaintenanceReceivedRecoveryScopes;`, {
			frames, ledgers, requireLaw: (ok: boolean, kind: string) => {if (!ok) throw Error(kind);},
			bindMethod: (owner: any, name: string) => owner[name].bind(owner), snapshotCall: (call: () => Promise<unknown>) => call(),
			closedRetirementEqual: (a: unknown, b: unknown) => Buffer.compare(Buffer.from(encodeCanonical(a)), Buffer.from(encodeCanonical(b))) === 0,
			closedRetirementBytes: encodeCanonical,
		});
		return {state, scope, accounting, frame, inventory, input, read: () => read(input, frame, inventory, async () => {
			state.checks++; if (!state.live) throw Error("controlled original currency changed");
		})};
	}
	it("obtains explicit received-scope absence only from the original lookup and retains complete receipt charges", async () => {
		const empty = receiptFixture(), scopes = await empty.read();
		expect(scopes).toEqual([]); expect(empty.state.lookups).toBe(1); expect(empty.state.checks).toBe(4);
		const received = receiptFixture(); received.accounting.chargeUnknownEncodedLength(11);
		const payload = Uint8Array.of(1, 2, 3);
		received.state.received = {scope: {...received.scope}, incarnation: "current-incarnation", exactReceivedCertificateBytes: payload};
		const expectedBytes = encodeCanonical(received.state.received), before = received.accounting.chargedBytes;
		const retained = await received.read(); payload.fill(255);
		expect(retained).toEqual([received.scope]); expect(Object.isFrozen(retained)).toBe(true); expect(Object.isFrozen(retained[0])).toBe(true);
		expect(received.accounting.chargedBytes).toBe(before + expectedBytes.byteLength);
		expect(received.accounting.charge(expectedBytes)).toBe(true); expect(received.accounting.chargedBytes).toBe(before + expectedBytes.byteLength);
		// Native receipt bytes are serialized into this SAME ledger; mutation of
		// the returned facade buffer cannot mutate the already-owned carrier.
	});
	it("keeps receipt corruption, missing lookup, capacity and revoked admitted reads as refusals", async () => {
		for (const wrong of ["scope", "incarnation"] as const) {
			const f = receiptFixture(); f.state.received = {scope: {...f.scope}, incarnation: "current-incarnation", exactReceivedCertificateBytes: Uint8Array.of(1)};
			if (wrong === "scope") f.state.received.scope.manifestDigest = "c".repeat(64); else f.state.received.incarnation = "other";
			await expect(f.read()).rejects.toThrow("floor-stale"); expect(f.accounting.chargedBytes).toBe(0);
		}
		const unavailable = receiptFixture(), failure = new Error("controlled native receipt lookup failed");
		unavailable.state.nativeError = failure; await expect(unavailable.read()).rejects.toBe(failure);
		const missing = receiptFixture(); (missing.input.snapshotStore as Record<string, unknown>).lookupReceivedRecoveryCertificate = undefined;
		await expect(missing.read()).rejects.toBeInstanceOf(TypeError); expect(missing.accounting.chargedBytes).toBe(0);
		const exhausted = receiptFixture(); exhausted.accounting.chargeUnknownEncodedLength(exhausted.accounting.maxBytes);
		exhausted.state.received = {scope: {...exhausted.scope}, incarnation: "current-incarnation", exactReceivedCertificateBytes: Uint8Array.of(1)};
		await expect(exhausted.read()).rejects.toThrow("proof-budget-exceeded"); expect(exhausted.accounting.chargedBytes).toBe(exhausted.accounting.maxBytes);
		for (const revoke of ["currency", "frame"] as const) {
			const f = receiptFixture(); f.state.afterLookup = () => {if (revoke === "currency") f.state.live = false; else f.frame.alive = false;};
			const admitted = f.read(); f.frame.pending.add(admitted);
			await expect(admitted).rejects.toThrow(revoke === "currency" ? "currency changed" : "snapshot-unavailable");
			await Promise.allSettled([...f.frame.pending]); expect(f.accounting.chargedBytes).toBe(0);
		}
		const sourceBody = declaration("captureCreatorOrdinaryIssuanceProofSource");
		expect(sourceBody).toContain("frame.pending.add(task)");
		const capture = sourceBody.indexOf("await captureCreatorOrdinaryReadOnlySourceWitnesses(");
		expect(capture).toBeGreaterThan(0);
		expect(capture).toBeLessThan(sourceBody.indexOf("captureKnownMaterial()"));
		expect(declaration("captureCreatorOrdinaryReadOnlySourceWitnesses")).toContain("await captureCreatorMaintenanceReceivedRecoveryScopes(");
	});
	it("enrolls only exact current dimensions without invoking future constructors or dropping PRE/UNKNOWN charges", async () => {
		const f = fixture(), before = f.book.chargedBytes, readout = await f.proof.readCurrentDimensions(f.unsignedBytes);
		expect(readout).toBeDefined(); expect(Object.keys(readout!)).toEqual([]); expect(Object.isFrozen(readout)).toBe(true);
		const facts = f.resolve(readout, f.proof, f.unsignedBytes)!;
		expect(facts.current.candidate.exactCanonicalUnsignedVertexBytes).toEqual(f.unsignedBytes);
		expect(facts.current.blueprint.maxApplicationStateBytes).toBe(268435456); // No fixture-size theorem.
		expect(facts.current.parameters.snapshotChunkBytes).toBe(65536); // Exact supplied original parameter, never a fixed inferred chunk size.
		expect(facts.current.successorFenceCount).toBe(0); expect(facts.current.nativeCounts.lineages).toBe(1);
		expect(facts.current.blueprint.catalog.exactArtifactBytes).toEqual(Uint8Array.of(9));
		expect(facts.current.currentEpochVertexCount).toBe(1); expect(facts.current.currentSignedPreimageByteLengths).toEqual([]);
		expect(facts.current.currentSignedPreimagesHaveSettlementSource).toBe(false);
		expect(Object.isFrozen(facts.current.currentSignedPreimageByteLengths)).toBe(true);
		expect(Object.hasOwn(facts.current, "currentEpochVertexBytes")).toBe(false);
		expect(Object.hasOwn(facts.current, "currentSignedPreimageBytes")).toBe(false);
		expect(Object.hasOwn(facts, "applicationSources")).toBe(false); expect(f.applicationSources()).toEqual([]);
		expect(facts.knownResourceTotals).toEqual({knownBytes: 5, protectedBytes: 3, unknownEncodedBytes: 14});
		expect(Object.hasOwn(facts, "knownProtectedMaterial")).toBe(false); expect(f.knownProtectedMaterial()).toEqual([Uint8Array.of(1, 2, 3)]);
		expect(before).toBe(19); expect(f.book.chargedBytes).toBe(before);
		expect(f.state.checks).toBe(2); expect(f.frame.pending.size).toBe(0); expect(f.futureCalls).toEqual([]);
	});
	it("refuses copied handles, another genuine proof, wrong bytes and a changed cumulative book", async () => {
		const f = fixture(), readout = await f.proof.readCurrentDimensions(f.unsignedBytes);
		expect(f.resolve({...readout}, f.proof, f.unsignedBytes)).toBeUndefined(); expect(f.resolve({}, f.proof, f.unsignedBytes)).toBeUndefined();
		expect(f.resolve(readout, f.otherProof, f.unsignedBytes)).toBeUndefined();
		const changed = f.unsignedBytes.slice(); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
		expect(f.resolve(readout, f.proof, changed)).toBeUndefined(); expect(f.resolve(readout, f.proof, f.unsignedBytes.slice())).toBeDefined();
		expect(f.book.chargeUnknownEncodedLength(1)).toBe(true); expect(f.resolve(readout, f.proof, f.unsignedBytes)).toBeUndefined();
		await expect(f.proof.readCurrentDimensions.call({...f.proof}, f.unsignedBytes)).rejects.toThrow("snapshot-unavailable");
	});
	const dimensionMutationControls: ((f: ReturnType<typeof fixture>) => void)[] = [
			f => f.runtimeReadout().candidate.exactCanonicalUnsignedVertexBytes.fill(255),
			f => f.runtimeReadout().blueprint.exactCanonicalBaseStateBytes.fill(255),
			f => f.runtimeReadout().blueprint.catalog.exactArtifactBytes.fill(255),
			f => f.runtimeReadout().candidate.exactCanonicalEpochVertexBytes.fill(255),
			f => {f.registration.blueprintMachine = {};}, f => {f.state.baseBytes = encodeCanonical({x: 1});},
			f => {f.state.current = false;}, f => {f.state.revoked = true;},
			f => {f.frame.headerConsumersRevoked = true;}, f => {f.frame.alive = false;},
		];
	it.each(dimensionMutationControls)("refuses mutation of publicly returned runtime bytes, source machine replacement, base mutation and revoked currency case %#", async change => {
		const f = fixture(), readout = await f.proof.readCurrentDimensions(f.unsignedBytes);
		expect(f.resolve(readout, f.proof, f.unsignedBytes)).toBeDefined(); change(f);
		expect(f.resolve(readout, f.proof, f.unsignedBytes)).toBeUndefined(); expect(f.futureCalls).toEqual([]);
	});
	it("owns detached book-carrier captures without exposing them through the opaque readout", async () => {
		const f = fixture(), readout = await f.proof.readCurrentDimensions(f.unsignedBytes), before = f.book.chargedBytes;
		// The private accounting owner borrows reader-owned buffers, not caller
		// input custody. Its full-material capture boundary detaches each output;
		// the scalar dimensions readout deliberately owns no carrier snapshots.
		const protectedMaterial = f.knownProtectedMaterial(), knownMaterial = f.knownMaterial();
		expect(protectedMaterial).toEqual([Uint8Array.of(1, 2, 3)]);
		expect(knownMaterial).toEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)]);
		for (const [index, bytes] of knownMaterial.entries()) expect(bytes).not.toBe(f.accountingInputs[index]);
		expect(protectedMaterial[0]).not.toBe(f.accountingInputs[0]);
		for (const bytes of [...protectedMaterial, ...knownMaterial]) bytes.fill(255);
		expect(f.accountingInputs).toEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)]);
		const freshProtected = f.knownProtectedMaterial(), freshKnown = f.knownMaterial();
		expect(freshProtected).toEqual([Uint8Array.of(1, 2, 3)]);
		expect(freshKnown).toEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)]);
		expect(freshProtected).not.toBe(protectedMaterial); expect(freshProtected[0]).not.toBe(protectedMaterial[0]);
		expect(freshKnown).not.toBe(knownMaterial);
		for (const [index, bytes] of freshKnown.entries()) {
			expect(bytes).not.toBe(knownMaterial[index]); expect(bytes).not.toBe(f.accountingInputs[index]);
		}
		const facts = f.resolve(readout, f.proof, f.unsignedBytes)!;
		expect(Object.keys(readout!)).toEqual([]);
		expect(facts.knownResourceTotals).toEqual({knownBytes: 5, protectedBytes: 3, unknownEncodedBytes: 14});
		expect(Object.hasOwn(facts, "knownProtectedMaterial")).toBe(false);
		expect(f.book.chargedBytes).toBe(before);
		expect(f.futureCalls).toEqual([]);
	});
	it("captures numerical totals from the same exact union, protection annotations and UNKNOWN occurrences", () => {
		const f = fixture(), sum = (rows: readonly Uint8Array[]) => rows.reduce((total, bytes) => total + bytes.byteLength, 0);
		const initial = f.resourceTotals();
		expect(initial).toEqual({knownBytes: sum(f.knownMaterial()), protectedBytes: sum(f.knownProtectedMaterial()), unknownEncodedBytes: 14});
		expect(Object.isFrozen(initial)).toBe(true);
		// Equal material is deduplicated only as in the original ledger; a new
		// protected use promotes the same original observation, not a new charge.
		expect(f.book.charge(Uint8Array.of(4, 5))).toBe(true);
		expect(f.book.chargedBytes).toBe(19);
		expect(f.book.charge(Uint8Array.of(6))).toBe(true);
		expect(f.book.chargeUnknownEncodedLength(2)).toBe(true);
		expect(f.book.chargeUnknownEncodedLength(2)).toBe(true);
		const current = f.resourceTotals();
		expect(current).toEqual({knownBytes: 6, protectedBytes: 6, unknownEncodedBytes: 18});
		expect(current.knownBytes).toBe(sum(f.knownMaterial())); expect(current.protectedBytes).toBe(sum(f.knownProtectedMaterial()));
		expect(current.knownBytes + current.unknownEncodedBytes).toBe(f.book.chargedBytes);
		expect(initial).toEqual({knownBytes: 5, protectedBytes: 3, unknownEncodedBytes: 14});
	});
	it("keeps original graph/journal correspondence validation when only cardinality is retained", async () => {
		const f = fixture();
		f.registration.closeVertices.set("e".repeat(64), {hash: "e".repeat(64), kind: "drp-vertex", objectId: "room", epoch: 3,
			anchor: "a".repeat(64), dependencies: ["a".repeat(64)], operation: {action: "place", args: {x: 1}}});
		expect(await f.proof.readCurrentDimensions(f.unsignedBytes)).toBeUndefined();
		expect(f.book.chargedBytes).toBe(19); expect(f.frame.pending.size).toBe(0); expect(f.futureCalls).toEqual([]);
	});
	it("derives witness lengths and unsupported source presence from exact captured PRE, never a caller flag", async () => {
		for (const hasSource of [false, true]) {
			const f = fixture(), digest = "e".repeat(64);
			const vertex = {hash: digest, kind: "drp-vertex", objectId: "room", epoch: 3, anchor: "a".repeat(64),
				dependencies: ["a".repeat(64)], operation: {action: "place", args: {x: 1}}};
			const original = {...decodeCanonical(f.unsignedBytes) as Record<string, unknown>,
				...(hasSource ? {settlementSource: {exactControlledSource: true}} : {})};
			const preimage = encodeCanonical(original);
			// The fixture controls original authenticated-journal dependencies; this
			// checks data extraction, not source authentication or protocol validity.
			f.journal.push({digest, exactCanonicalPreimageBytes: preimage.slice(), exactCanonicalVertexBytes: encodeCanonical(vertex), sourceKind: "received"});
			f.registration.closeVertices.set(digest, vertex);
			const readout = await f.proof.readCurrentDimensions(f.unsignedBytes), facts = f.resolve(readout, f.proof, f.unsignedBytes)!;
			expect(facts.current.currentEpochVertexCount).toBe(2);
			expect(facts.current.currentSignedPreimageByteLengths).toEqual([preimage.byteLength]);
			expect(facts.current.currentSignedPreimagesHaveSettlementSource).toBe(hasSource);
			preimage.fill(255); // Original capture isolates external native bytes; numerical facts retain only lengths.
			expect(facts.current.currentSignedPreimageByteLengths).toEqual([preimage.byteLength]);
			expect(Object.isFrozen(facts.current.currentSignedPreimageByteLengths)).toBe(true);
			expect(f.futureCalls).toEqual([]);
		}
	});
	it("captures input bytes before await and refuses currency or book changes during either freshness bracket", async () => {
		const copied = fixture(), original = copied.unsignedBytes.slice(), pending = copied.proof.readCurrentDimensions(copied.unsignedBytes);
		copied.unsignedBytes.fill(255); const readout = await pending;
		expect(copied.resolve(readout, copied.proof, original)).toBeDefined(); expect(copied.resolve(readout, copied.proof, copied.unsignedBytes)).toBeUndefined();
		for (const when of [1, 2]) {const f = fixture(); f.state.onCheck = async count => {if (count === when) f.state.current = false;};
			await expect(f.proof.readCurrentDimensions(f.unsignedBytes)).rejects.toThrow("revoked"); expect(f.frame.pending.size).toBe(0);}
		const charged = fixture(); charged.state.onCheck = async count => {if (count === 2) charged.book.chargeUnknownEncodedLength(1);};
		await expect(charged.proof.readCurrentDimensions(charged.unsignedBytes)).rejects.toThrow("snapshot-unavailable");
		expect(charged.book.chargedBytes).toBe(20); expect(charged.frame.pending.size).toBe(0); expect(charged.futureCalls).toEqual([]);
	});
	it("uses only exact positive retired-classified facts for absent historical APP alternatives without refunding proof charges", () => {
		const f = fixture(), scope = {objectId: "room", epoch: 0, anchor: "2".repeat(64), manifestDigest: "3".repeat(64)};
		f.seed.material.protectedScopes.push(scope);
		const before = encodeCanonical(f.seed.material), charged = f.book.chargedBytes;
		expect(f.applicationSources()).toBeUndefined(); // Absence or age alone is never evidence.
		f.seed.retiredClassifiedSnapshotScopes = [{...scope}]; // Controlled output of ORIGINAL certificate owner.
		expect(f.applicationSources()).toEqual([]);
		expect(encodeCanonical(f.seed.material)).toEqual(before); expect(f.book.chargedBytes).toBe(charged);
		for (const changed of [{...scope, objectId: "foreign"}, {...scope, epoch: 1},
			{...scope, anchor: "4".repeat(64)}, {...scope, manifestDigest: "5".repeat(64)}]) {
			f.seed.retiredClassifiedSnapshotScopes = [changed];
			expect(f.applicationSources()).toBeUndefined(); expect(f.book.chargedBytes).toBe(charged);
		}
	});
	it("never lets retired-classified facts discharge current inventory, surviving, operational or installed APP bases", () => {
		const scope = {objectId: "room", epoch: 0, anchor: "2".repeat(64), manifestDigest: "3".repeat(64)};
		for (const role of ["inventory", "surviving", "operational", "installed"] as const) {
			const f = fixture(); f.seed.material.protectedScopes.push(scope); f.seed.retiredClassifiedSnapshotScopes = [{...scope}];
			if (role === "inventory") f.seed.snapshotScopes.push(scope);
			if (role === "surviving") f.seed.material.snapshotTurnover.survivingScopes.push(scope);
			const source = {closedEpoch: scope.epoch, closedAnchorDigest: scope.anchor, manifestRef: {digest: scope.manifestDigest}};
			if (role === "operational") f.seed.material.sources.push(source);
			if (role === "installed") f.seed.material.installedPromotionSource = source;
			const before = f.book.chargedBytes;
			expect(f.applicationSources(), role).toBeUndefined(); expect(f.book.chargedBytes).toBe(before);
		}
	});
	it("retains and isolates any verified APP payload even if the historical scope has a positive retired fact", () => {
		const f = fixture(), scope = {objectId: "room", epoch: 0, anchor: "2".repeat(64), manifestDigest: "3".repeat(64)};
		f.seed.material.protectedScopes.push(scope); f.seed.retiredClassifiedSnapshotScopes = [{...scope}];
		const manifest = Uint8Array.of(1), payload = Uint8Array.of(2), chunks = [1];
		f.seed.snapshotMaterials.push({scope, exactCanonicalManifestBytes: manifest, exactCanonicalPayloadBytes: payload, chunkByteLengths: chunks});
		const before = f.book.chargedBytes, captured = f.applicationSources();
		expect(captured).toHaveLength(1); manifest.fill(255); payload.fill(255); chunks.push(99);
		expect(captured[0].exactCanonicalManifestBytes).toEqual(Uint8Array.of(1));
		expect(captured[0].exactCanonicalPayloadBytes).toEqual(Uint8Array.of(2)); expect(captured[0].chunkByteLengths).toEqual([1]);
		expect(f.book.chargedBytes).toBe(before);
	});
	it("refuses missing original protected/material/recovery sources and never treats raw parser matches as scope coverage", async () => {
		const scope = {objectId: "room", epoch: 2, anchor: "2".repeat(64), manifestDigest: "3".repeat(64)};
		for (const field of ["inventory", "protected", "surviving", "source", "installed"] as const) {
			const f = fixture();
			if (field === "inventory") f.seed.snapshotScopes.push(scope);
			if (field === "protected") f.seed.material.protectedScopes.push(scope);
			if (field === "surviving") f.seed.material.snapshotTurnover.survivingScopes.push(scope);
			const material = {closedEpoch: scope.epoch, closedAnchorDigest: scope.anchor, manifestRef: {digest: scope.manifestDigest}};
			if (field === "source") f.seed.material.sources.push(material);
			if (field === "installed") f.seed.material.installedPromotionSource = material;
			expect(f.book.charge(encodeCanonical({kind: "drp-snapshot-payload", objectId: "room", epoch: 2}))).toBe(true);
			const before = f.book.chargedBytes;
			expect(f.applicationSources(), field).toBeUndefined(); expect(f.book.chargedBytes).toBe(before);
			// Only the existing private verified snapshot owner slot can cover scope.
			const manifestInput = Uint8Array.of(1), payloadInput = Uint8Array.of(2);
			f.seed.snapshotMaterials.push({scope, exactCanonicalManifestBytes: manifestInput, exactCanonicalPayloadBytes: payloadInput, chunkByteLengths: [1]});
			const readout = await f.proof.readCurrentDimensions(f.unsignedBytes), facts = f.resolve(readout, f.proof, f.unsignedBytes)!;
			const applicationSources = f.applicationSources();
			manifestInput.fill(255); payloadInput.fill(255);
			expect(applicationSources).toHaveLength(1);
			expect(applicationSources[0].exactCanonicalManifestBytes).toEqual(Uint8Array.of(1));
			expect(applicationSources[0].exactCanonicalPayloadBytes).toEqual(Uint8Array.of(2));
			expect(f.resolve(readout, f.proof, f.unsignedBytes)).toBeDefined();
			expect(f.futureCalls).toEqual([]);
		}
	});
});

describe("ordinary capacity whole-material projection affected controls", () => {
	function project(owner: NativeMaterialProjectionTest, retain: boolean, fresh: Uint8Array, future: Uint8Array) {
		const variable = (name: string) => unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === name).getText(parsed);
		return execute<{projected: {whole: number; protected: number}; fresh: {whole: number; protected: number}; serial: number[]}>(`
			const ${variable("wholeMaterialProjection")}; const ${variable("projectedMaterial")}; const ${variable("freshProjectedMaterial")};
			({projected: projectedMaterial, fresh: freshProjectedMaterial, serial: ${serialSnapshotEnvelope.getText(parsed)}});`, {
			compiler: undefined, input: {retainWholeMaterialForCapacity: retain}, materialOwner: owner.material, futureKnownLeaves: [future], freshKnownLeaves: [fresh],
			freshRetiredSnapshotScopes: [], freshNativeRefs: [], preclose: false, serialFrames: [[3], [5]],
			serialSnapshotTurnoverJoined: [false, true], futureSnapshotTurnover: {retiringScopes: [snapshotScope75(3)]},
			futureUnknownMaterialWidths: [37, 37], unknown: [31, 31],
			maintenanceWidthSum: (values: number[]) => values.reduce((sum, value) => sum + value, 0),
		});
	}
	it("reprojects all three actual call sites from the SAME charged book, retaining full PRE and every unknown occurrence without refund", () => {
		const owner = nativeMaterialOwner() as NativeMaterialProjectionTest & {material: NativeMaterialProjectionTest["material"] & {
			chargeSnapshotTarget(bytes: Uint8Array, scope: unknown): boolean}};
		const raw = new Uint8Array(7).fill(7), native = new Uint8Array(11).fill(11), snapshot = new Uint8Array(13).fill(13), observation = new Uint8Array(17).fill(17);
		expect(owner.accounting.charge(raw)).toBe(true);
		const nativeRef = digestBlob(native); if (!nativeRef.ok) throw Error("FIXTURE_DIGEST");
		expect(owner.material.chargeNativeReader({bytes: native, ref: {digest: nativeRef.value, byteLength: native.byteLength}})).toBe(true);
		expect(owner.material.chargeSnapshotTarget(snapshot, snapshotScope75(3))).toBe(true); expect(owner.material.chargeObservation(observation)).toBe(true);
		for (const width of [19, 19]) expect(owner.accounting.chargeUnknownEncodedLength(width)).toBe(true);
		const initial = owner.accounting.chargedBytes; expect(initial).toBe(86);
		const fresh = new Uint8Array(29).fill(29), future = new Uint8Array(23).fill(23);
		const exact = project(owner, false, fresh, future), full = project(owner, true, fresh, future);
		expect(exact.projected).toEqual({whole: 109, protected: 92}); expect(exact.fresh).toEqual({whole: 115, protected: 87});
		expect(exact.serial).toEqual([226, 215]);
		expect(full.projected).toEqual({whole: 109, protected: 109}); expect(full.fresh).toEqual({whole: 115, protected: 115});
		expect(full.serial).toEqual([254, 256]); expect(owner.accounting.chargedBytes).toBe(initial);
		// The third equal unknown is an additional occurrence, not a digest/byte
		// alias, and each subsequent projection reads the changed original book.
		expect(owner.accounting.chargeUnknownEncodedLength(19)).toBe(true);
		const again = project(owner, true, fresh, future); expect(again.serial).toEqual([273, 275]);
		expect(again.projected.whole).toBe(128); expect(again.fresh.whole).toBe(134); expect(owner.accounting.chargedBytes).toBe(105);
		expect(full.serial).toEqual([254, 256]); // Earlier readout remains data, not reused current totals.
		expect(owner.accounting.charge(raw.slice())).toBe(true); expect(owner.accounting.chargedBytes).toBe(105);
	});
});

describe("ordinary preimage and expanded-container capacity affected controls", () => {
	async function fixture() {
		const {canonicalCreatorDataRecord} = await import("../src/internal/creator-snapshot-data.js");
		const symbol = unique((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) && node.name.text === "maintenanceWidthAtom");
		return execute<{preimage(bytes: Uint8Array): {canonicalPreimageByteLength: number; canonicalEpochVertexByteLength: number; canonicalAuthorByteLength: number} | undefined;
			width(bytes: number, shape?: {items: number; maxDepth: number}): object; array(count: number, child: object): object;
			bytes(length: number): object; measure(value: unknown): number}>(`const ${symbol.getText(parsed)};\n${[
			"maintenanceEncodedWidth", "maintenanceEncodedArrayCapacity", "maintenanceVarUintWidth", "maintenanceWidthSum", "maintenanceCanonicalWidth",
			// ea4eb158: the reader delegates its field geometry to
			// creatorOrdinaryPreimageResourceGeometryForSizing (its catch would
			// otherwise turn the missing binding into a silent undefined).
			"maintenanceEncodedBytes", "creatorOrdinaryPreimageResourceGeometryForSizing", "readCreatorOrdinaryPreimageCapacityForSizing"].map(name => declaration(name).replace(/^export /, "")).join("\n")}\n
			({preimage: readCreatorOrdinaryPreimageCapacityForSizing, width: maintenanceEncodedWidth,
			array: maintenanceEncodedArrayCapacity, bytes: maintenanceEncodedBytes, measure: maintenanceCanonicalWidth});`, {canonicalCreatorDataRecord, AHE_BOUNDED_READ_LIMITS});
	}
	function vertex(operation: unknown) {return {kind: "drp-vertex", protocolMajor: 3, objectId: "r".repeat(256), epoch: Number.MAX_SAFE_INTEGER,
		author: "1".repeat(64), authorSequence: Number.MAX_SAFE_INTEGER, logicalTime: Number.MAX_SAFE_INTEGER,
		anchor: "a".repeat(64), dependencies: Array.from({length: 16}, (_, index) => index.toString(16).padStart(64, "0")), operation};}
	it("bounds the complete 10-key registered preimage and distinct 7-key EpochVertex at actual operation512 and context/dependency/counter maxima", async () => {
		const f = await fixture(), base = {action: "short", payload: ""}, baseWidth = encodeCanonical(base).byteLength;
		const operation = {...base, payload: "x".repeat(512 - baseWidth - 1)}; expect(encodeCanonical(operation).byteLength).toBe(512);
		const input = vertex(operation), bytes = encodeCanonical(input), bound = f.preimage(bytes); expect(bound).toBeDefined();
		const epochVertex = {anchor: input.anchor, dependencies: input.dependencies, epoch: input.epoch, hash: input.anchor,
			kind: input.kind, objectId: input.objectId, operation};
		expect(Object.keys(input)).toHaveLength(10); expect(Object.keys(epochVertex)).toHaveLength(7);
		expect(bound!.canonicalPreimageByteLength).toBe(bytes.byteLength); expect(bound!.canonicalEpochVertexByteLength).toBe(encodeCanonical(epochVertex).byteLength);
		expect(bound!.canonicalAuthorByteLength).toBe(encodeCanonical(input.author).byteLength);
		expect(bound!.canonicalEpochVertexByteLength).toBeLessThan(bound!.canonicalPreimageByteLength); expect(Object.isFrozen(bound)).toBe(true);
		const small = encodeCanonical(vertex({action: "short"})); expect(f.preimage(small)).toEqual(bound);
		const widerInput = vertex({...operation, payload: operation.payload + "x"}), wider = f.preimage(encodeCanonical(widerInput));
		expect(wider).toBeDefined(); expect(wider!.canonicalPreimageByteLength).toBe(bound!.canonicalPreimageByteLength + 1);
		expect(wider!.canonicalEpochVertexByteLength).toBe(bound!.canonicalEpochVertexByteLength + 1);
		// These are serializer ceilings, not authorization or a roll-over grant at
		// MAX_SAFE_INTEGER. Original caller identity/epoch/protocol guards remain.
	});
	it("uses actual wide operation bytes with complete PRE/EpochVertex oracles at512/513, count prefixes and the unchanged65536 operation bound", async () => {
		const f = await fixture();
		const operationOfWidth = (width: number): Record<string, unknown> => {
			let length = Math.max(0, width - encodeCanonical({action: "short", payload: ""}).byteLength);
			for (let attempt = 0; attempt < 4; attempt++) {
				const value = {action: "short", payload: "x".repeat(length)}, actual = encodeCanonical(value).byteLength;
				if (actual === width) return value;
				length += width - actual;
			}
			throw new Error(`exact operation width oracle unavailable:${width}`);
		};
		for (const width of [127, 128, 512, 513, 16_383, 16_384, 65_536]) {
			const operation = operationOfWidth(width), input = vertex(operation), bytes = encodeCanonical(input), bound = f.preimage(bytes);
			expect(encodeCanonical(operation).byteLength).toBe(width); expect(bound, String(width)).toBeDefined();
			const derivative = {anchor: input.anchor, dependencies: input.dependencies, epoch: input.epoch, hash: input.anchor,
				kind: input.kind, objectId: input.objectId, operation};
			const padding = Math.max(512, width) - width;
			expect(bound!.canonicalPreimageByteLength).toBe(bytes.byteLength + padding);
			expect(bound!.canonicalEpochVertexByteLength).toBe(encodeCanonical(derivative).byteLength + padding);
		}
		expect(f.preimage(encodeCanonical(vertex(operationOfWidth(65_537))))).toBeUndefined();
		// Complete supported 64-member roster spelling; this codec oracle does
		// not confer creator/Writer permission or bypass the genuine reducer.
		const operation = {action: "installRoster", roster: {entries: Array.from({length: 64}, (_, order) => ({
			author: order.toString(16).padStart(64, "0"), peerId: `peer:${order}:${"x".repeat(64)}`, order}))}};
		const operationBytes = encodeCanonical(operation), input = vertex(operation), bytes = encodeCanonical(input);
		expect(operationBytes.byteLength).toBeGreaterThan(8_000);
		decodeCanonical(operationBytes, {maxBytes: 65_536, maxDepth: 8, maxItems: 1_024});
		const bound = f.preimage(bytes); expect(bound).toBeDefined(); expect(bound!.canonicalPreimageByteLength).toBe(bytes.byteLength);
		expect(bound!.canonicalEpochVertexByteLength).toBe(encodeCanonical({anchor: input.anchor, dependencies: input.dependencies,
			epoch: input.epoch, hash: input.anchor, kind: input.kind, objectId: input.objectId, operation}).byteLength);
	});
	it("keeps outside operation nesting and hostile/malformed/extra-source carriers on the original fallback path", async () => {
		const f = await fixture(), input = vertex({action: "short"}); expect(f.preimage(encodeCanonical(input))).toBeDefined();
		let child: unknown = 0; for (let depth = 0; depth < 7; depth++) child = [child];
		expect(f.preimage(encodeCanonical(vertex({action: "short", payload: child})))).toBeDefined();
		expect(f.preimage(encodeCanonical(vertex({action: "short", payload: [child]})))).toBeUndefined();
		const invalid = [{...input, extra: 1}, {...input, settlementSource: {}}, {...input, kind: "wrong"}, {...input, protocolMajor: 2},
			{...input, objectId: "invalid object"}, {...input, author: "A".repeat(64)}, {...input, anchor: "a".repeat(65)},
			{...input, logicalTime: 0}, {...input, authorSequence: -1}, {...input, epoch: 1.5}, {...input, dependencies: Array(17).fill(input.anchor)},
			{...input, dependencies: ["not-a-digest"]}, {...input, operation: []}];
		for (const value of invalid) expect(f.preimage(encodeCanonical(value))).toBeUndefined();
		const bytes = encodeCanonical(input); expect(f.preimage(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]))).toBeUndefined();
		expect(f.preimage(Uint8Array.of(255))).toBeUndefined(); expect(f.preimage(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
		bytes[0] = 255; expect(f.preimage(bytes)).toBeUndefined(); // No old exact-byte/digest sizing cache.
		const withinItems = {action: "short", values: Array(507).fill(false)}, beyondItems = {action: "short", values: Array(508).fill(false)};
		decodeCanonical(encodeCanonical(withinItems), {maxBytes: 65_536, maxDepth: 8, maxItems: 1_024});
		expect(f.preimage(encodeCanonical(vertex(withinItems)))).toBeDefined();
		expect(() => decodeCanonical(encodeCanonical(beyondItems), {maxBytes: 65_536, maxDepth: 8, maxItems: 1_024})).toThrow();
		expect(f.preimage(encodeCanonical(vertex(beyondItems)))).toBeUndefined();
	});
	it("expands direct ARRAY atoms through item/depth limits while encoded BYTES stay opaque, with exact127/128 count prefixes", async () => {
		const f = await fixture(), leaf = f.width(encodeCanonical(false).byteLength, {items: 1, maxDepth: 0});
		for (const count of [0, 1, 127, 128]) {
			const bytes = encodeCanonical(Array(count).fill(false)); expect(f.measure(f.array(count, leaf))).toBe(bytes.byteLength);
			decodeCanonical(bytes, {maxItems: 1 + 2 * count});
			expect(() => decodeCanonical(bytes, {maxItems: 2 * count})).toThrow();
		}
		expect(f.measure(f.array(128, leaf)) - f.measure(f.array(127, leaf))).toBe(2);
		const full = f.array(32_767, leaf), fullBytes = encodeCanonical(Array(32_767).fill(false));
		expect(f.measure(full)).toBe(fullBytes.byteLength); decodeCanonical(fullBytes, {maxItems: 65_535});
		expect(() => decodeCanonical(fullBytes, {maxItems: 65_534})).toThrow();
		expect(() => f.array(32_768, leaf)).toThrow();
		expect(() => f.measure({rows: full})).toThrow("nesting");
		expect(() => f.array(2, f.width(1, {items: 40_000, maxDepth: 0}))).toThrow("shape");
		const deep = f.array(1, f.width(1, {items: 1, maxDepth: 127})); expect(f.measure(deep)).toBeGreaterThan(0);
		expect(() => f.measure({rows: deep})).toThrow("nesting");
		const opaque = f.bytes(65_536); expect(f.measure({bytes: opaque})).toBe(encodeCanonical({bytes: new Uint8Array(65_536)}).byteLength);
		for (const count of [-1, 0.5, NaN, Infinity, 65_536]) expect(() => f.array(count, leaf)).toThrow();
		for (const shape of [{items: 65_537, maxDepth: 0}, {items: 1, maxDepth: 129}, {items: 0, maxDepth: 0}])
			expect(() => f.width(1, shape)).toThrow();
	});
});

describe("ordinary complete runtime wrapper capacity affected controls", () => {
	type Shape = {items: number; maxDepth: number};
	type Phase = "currentClose" | "successorReserved" | "successorEntered" | "successorFinal";
	type FutureRows = {localCount: number; receivedCount: number; receivedPreimageBytes: number;
		receivedEpochVertexBytes: number; issuerDescriptorGrowth: number};
	type Input = {scope: {objectId: string; author: string}; currentScope: {objectId: string; epoch: number; anchorDigest: string};
		maxIssuerDescriptors: number; maxDebtDescriptors: number; maxCurrentJournalRows: number; maxDependencyAnchors: number;
		maxAdditionalCurrentJournalRows?: number; futureRows?: FutureRows;
		canonicalPreimageByteLength: number; canonicalEpochVertexByteLength: number; successorFencePreimageByteLength: number;
		successorFenceCount?: 0 | 1; receivedPendingIngressByteLength?: number};
	type Capacity = Record<Phase, number> & {runtimeCensusOverheadShape: Record<Phase, Shape>;
		advance?: (row: unknown) => Capacity;
		project?: (input: Pick<Input, "maxIssuerDescriptors" | "maxAdditionalCurrentJournalRows" | "canonicalPreimageByteLength" |
			"canonicalEpochVertexByteLength" | "successorFencePreimageByteLength" | "futureRows"> & {maxDebtDescriptors?: number}) => Capacity};
	async function fixture() {
		const {ISSUANCE_RETIREMENT_LIMITS} = await import("../../issuance-store/src/retirement.js");
		const path = new URL("../src/v3-live.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const nodes = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (nodes.length !== 1) throw Error(`ORDINARY_RUNTIME_WIDTH_HELPER:${name}:${nodes.length}`);
			return nodes[0]!.getText(file).replace(/^export /, "");
		};
		const variable = (name: string) => {
			const nodes = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
				.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
			if (nodes.length !== 1) throw Error(`ORDINARY_RUNTIME_WIDTH_BINDING:${name}:${nodes.length}`);
			return `const ${nodes[0]!.getText(file)};`;
		};
		const api = execute<{capacity(input: Input, currentJournalRows?: readonly unknown[], currentGeometry?: unknown, prepareProjection?: boolean): Capacity; shape(value: unknown): Shape;
			issuer(kind: string, scope: object, sequence: number, digest: Uint8Array | undefined, classification: string): object;
			local(journalSequence: number, scope: object, sequence: number, byteCharge: number, digest?: string): object;
			received(input: object): object; runtime(journal: object, rows: object[], debt: object[], graphVersion: number, anchors: object[]): object;
			active(input: object): Record<string, unknown>; kinds: string[]; classifications: string[]}>(`${[
			"ObjectFreeze", "ArrayIsArray", "NumberIsSafeInteger", "ObjectCreate", "ReflectOwnKeys", "RegExpTest", "ObjectPrototype",
			"ObjectGetOwnPropertyDescriptor", "ObjectGetPrototypeOf", "ReflectApply", "Uint8ArrayConstructor", "DIGEST_HEX",
			"CREATOR_ISSUANCE_CENSUS_DEPENDENCY_KINDS", "CREATOR_ISSUANCE_CENSUS_CLASSIFICATIONS"].map(variable).join("\n")}
			${["isObject", "snapshotClosedRecord", "isDigestHex", "prospectiveCensusCountWidth", "prospectiveCensusRecordWidth",
				"prospectiveCensusArrayShape", "prospectiveCensusCanonicalShape", "prospectiveCensusRecordShape", "creatorIssuanceCensusFields",
				"creatorLocalJournalCensusFields", "creatorReceivedJournalCensusCarrierFields", "creatorRuntimeCensusFields",
				"creatorRuntimeActiveCensusFields", "creatorOrdinaryRuntimeJournalGeometryForSizing", "creatorOrdinaryRuntimeCapacityWidths"].map(extract).join("\n")}
			({capacity: creatorOrdinaryRuntimeCapacityWidths, shape: prospectiveCensusCanonicalShape,
			issuer: creatorIssuanceCensusFields, local: creatorLocalJournalCensusFields, received: creatorReceivedJournalCensusCarrierFields,
			runtime: creatorRuntimeCensusFields, active: creatorRuntimeActiveCensusFields,
			kinds: CREATOR_ISSUANCE_CENSUS_DEPENDENCY_KINDS, classifications: CREATOR_ISSUANCE_CENSUS_CLASSIFICATIONS});`,
			{ISSUANCE_RETIREMENT_LIMITS, LIVE_JOURNAL_RETIREMENT_LIMITS, AHE_BOUNDED_READ_LIMITS});
		const scope = {objectId: "runtime-capacity", author: "1".repeat(64)}, currentScope = {objectId: scope.objectId, epoch: 3, anchorDigest: "a".repeat(64)};
		const preimageValue = {kind: "drp-vertex", protocolMajor: 3, objectId: scope.objectId, epoch: currentScope.epoch,
			anchor: currentScope.anchorDigest, author: scope.author, authorSequence: 0, logicalTime: 1,
			dependencies: [currentScope.anchorDigest], operation: {action: "capacity"}}, preimage = encodeCanonical(preimageValue);
		const vertex = encodeCanonical({kind: preimageValue.kind, objectId: scope.objectId, epoch: currentScope.epoch,
			anchor: currentScope.anchorDigest, hash: "b".repeat(64), dependencies: preimageValue.dependencies, operation: preimageValue.operation});
		const input: Input = {scope, currentScope, maxIssuerDescriptors: 1, maxDebtDescriptors: 1, maxCurrentJournalRows: 1,
			maxDependencyAnchors: 7, canonicalPreimageByteLength: preimage.byteLength, canonicalEpochVertexByteLength: vertex.byteLength,
			successorFencePreimageByteLength: preimage.byteLength};
		const longest = (values: string[]) => values.reduce((a, b) => encodeCanonical(a).byteLength >= encodeCanonical(b).byteLength ? a : b);
		function actual(input: Input, received: boolean, pendingRoots: object[] = [], sourceBytes = preimage, vertexBytes = vertex) {
			const maximum = Number.MAX_SAFE_INTEGER, digest = input.currentScope.anchorDigest;
			const descriptor = api.issuer(longest(api.kinds), input.scope, maximum, new Uint8Array(32), longest(api.classifications));
			const fence = api.issuer("current-issuance", input.scope, maximum, new Uint8Array(32), "current");
			const local = api.local(maximum, input.scope, maximum, maximum, digest), remote = api.received({journalSequence: maximum,
				byteCharge: maximum, digest, exactCanonicalPreimageBytes: sourceBytes, detachedSignature: new Uint8Array(64), exactCanonicalVertexBytes: vertexBytes});
			const currentJournal = (rows: object[]) => ({dependencyKind: "current-journal",
				scope: {...input.currentScope, epoch: maximum}, rows});
			const rows = Array(input.maxIssuerDescriptors + (input.futureRows?.issuerDescriptorGrowth ?? 1)).fill(descriptor), debt = Array(input.maxDebtDescriptors + 1).fill({scope: input.scope,
				lineageIndex: maximum, planIndex: maximum}), anchors = Array(input.maxDependencyAnchors).fill({epoch: maximum, anchorDigest: digest});
			// 1515daab: a fence-issuing successor reserves one future manual-review
			// unsettled source per issuer descriptor in activeUnsettled.sources; the
			// actual carrier holds exactly those maximal entries (none without a fence).
			const active = api.active({pendingRoots, wireByteCharge: pendingRoots.length === 0 ? 0 : maximum,
				unsettledSources: futureUnsettledSources(input), cursor: null, cacheSourceSequences: [], epoch: input.currentScope.epoch + 1});
			const optionalPending = input.receivedPendingIngressByteLength === undefined ? {} : {pendingIngress: active.pendingIngress};
			const current = api.runtime(currentJournal(Array(input.maxCurrentJournalRows + (input.maxAdditionalCurrentJournalRows ?? 1)).fill(received ? remote : local)), rows, debt, maximum, anchors);
			const precursor = api.runtime(currentJournal([]), rows, debt, maximum, anchors);
			const noFence = input.successorFenceCount === 0;
			const final = api.runtime(currentJournal(noFence ? [] : [local]), noFence ? rows : [...rows, fence], debt, maximum, anchors);
			// Real producer fields and full encoded carriers, not fake source authority.
			// One scalar placeholder lets the oracle exclude exactly the separately
			// charged native VALUE, while preserving its key and container framing.
			return {currentClose: {...current, ...active, nativeIssuance: false},
				nonActiveCurrent: {...current, ...optionalPending, nativeIssuance: false},
				successorReserved: noFence ? {...final, ...optionalPending, nativeIssuance: false} : {...precursor, ...active, nativeIssuance: false},
				successorEntered: noFence ? {...final, ...optionalPending, nativeIssuance: false} : {...precursor, ...active, nativeIssuance: false},
				successorFinal: {...final, ...optionalPending, nativeIssuance: false}, pending: active.pendingIngress, local, remote};
		}
		function futureUnsettledSources(input: Input) {
			if (input.successorFenceCount === 0) return [];
			return Array(input.maxIssuerDescriptors + (input.futureRows?.issuerDescriptorGrowth ?? 1)).fill({
				scope: {objectId: input.scope.objectId, author: input.scope.author}, disposition: "manual-review",
				replacementProgress: null, sourceSequence: Number.MAX_SAFE_INTEGER, sourceDigest: new Uint8Array(32)});
		}
		function dominates(bound: Capacity, values: ReturnType<typeof actual>) {
			for (const phase of ["currentClose", "successorReserved", "successorEntered", "successorFinal"] as const) {
				const bytes = encodeCanonical(values[phase]), shape = api.shape(values[phase]), capShape = bound.runtimeCensusOverheadShape[phase];
				expect(bound[phase], phase).toBeGreaterThanOrEqual(bytes.byteLength - 1);
				expect(capShape.items, phase).toBeGreaterThanOrEqual(shape.items - 1); expect(capShape.maxDepth, phase).toBeGreaterThanOrEqual(shape.maxDepth);
				decodeCanonical(bytes, {maxItems: capShape.items + 1, maxDepth: capShape.maxDepth});
				decodeCanonical(bytes, {maxItems: shape.items}); expect(() => decodeCanonical(bytes, {maxItems: shape.items - 1})).toThrow();
			}
			expect(bound.currentClose).toBeGreaterThanOrEqual(encodeCanonical(values.nonActiveCurrent).byteLength - 1);
		}
		return {api, input, actual, dominates, preimage, vertex};
	}
	it("mixed window runtime geometry bounds complete mixed/local-only/received-only and empty carriers with heterogeneous old rows", async () => {
		const f = await fixture();
		const saved = f.actual(f.input, true, [], new Uint8Array(8334), new Uint8Array(8192));
		const oldLocal = {...saved.local, journalSequence: 0}, oldReceived = {...saved.remote, journalSequence: 1, byteCharge: 8334};
		const oldRows = [oldLocal, oldReceived];
		for (const [localCount, receivedCount] of [[0, 0], [2, 0], [0, 3], [2, 3]]) for (const fence of [0, 1] as const) {
			const preimages = [1, 127, 128].slice(0, receivedCount), vertices = [128, 1, 127].slice(0, receivedCount);
			const futureRows = {localCount: localCount!, receivedCount: receivedCount!,
				receivedPreimageBytes: preimages.reduce((sum, value) => sum + value, 0),
				receivedEpochVertexBytes: vertices.reduce((sum, value) => sum + value, 0), issuerDescriptorGrowth: localCount!};
			const input = {...f.input, maxIssuerDescriptors: 0, maxCurrentJournalRows: 2,
				maxAdditionalCurrentJournalRows: localCount! + receivedCount!, futureRows,
				canonicalPreimageByteLength: 512, canonicalEpochVertexByteLength: 512, successorFenceCount: fence,
				successorFencePreimageByteLength: fence === 0 ? 0 : 512};
			const values = f.actual(input, false);
			const futureReceived = preimages.map((length, index) => f.actual(input, true, [],
				new Uint8Array(length), new Uint8Array(vertices[index]!)).remote);
			const actualRows = [saved.local, saved.remote, ...Array(localCount).fill(values.local), ...futureReceived];
			(values.currentClose as any).currentJournal.rows = actualRows;
			(values.nonActiveCurrent as any).currentJournal.rows = actualRows;
			const bound = f.api.capacity(input, oldRows);
			f.dominates(bound, values);
			// Omitting the redundant total selects exactly the same mixed window.
			const {maxAdditionalCurrentJournalRows: _count, ...implicitCount} = input;
			expect(f.api.capacity(implicitCount, oldRows)).toEqual(bound);
			if (localCount === 2 && receivedCount === 3) {
				const {futureRows: _mixed, ...rectangle} = input;
				const legacy = f.api.capacity({...rectangle, maxIssuerDescriptors: localCount - 1}, oldRows);
				expect(bound.currentClose).toBeLessThan(legacy.currentClose);
				expect(bound.successorFinal).toBe(legacy.successorFinal);
			}
		}
		// The unchanged legacy domain still exactly reaches its original
		// all-received rectangle, with its implicit one issuer descriptor.
		const legacy = f.api.capacity(f.input), actualLegacy = f.actual(f.input, true);
		f.dominates(legacy, actualLegacy);
		expect(legacy.currentClose).toBe(encodeCanonical(actualLegacy.currentClose).byteLength - 1);
	});
	it("mixed window boundary projector preserves detached geometry and exact payload-prefix growth", async () => {
		const f = await fixture(), seed = {...f.input, maxCurrentJournalRows: 0};
		const prepared = f.api.capacity(seed, [], undefined, true);
		const futureRows = {localCount: 1, receivedCount: 2, receivedPreimageBytes: 255,
			receivedEpochVertexBytes: 129, issuerDescriptorGrowth: 1};
		const params = {maxIssuerDescriptors: 0, maxAdditionalCurrentJournalRows: 3, canonicalPreimageByteLength: 128,
			canonicalEpochVertexByteLength: 128, successorFencePreimageByteLength: 128, futureRows};
		const data = (value: Capacity) => {const {project: _project, advance: _advance, ...plain} = value; return plain;};
		const expected = f.api.capacity({...seed, ...structuredClone(params)}, []);
		const first = prepared.project!(params);
		expect(data(first)).toEqual(expected);
		futureRows.localCount = 100; futureRows.receivedPreimageBytes = 1; params.maxIssuerDescriptors = 100;
		expect(data(first)).toEqual(expected);
		const saved = {maxIssuerDescriptors: 0, maxAdditionalCurrentJournalRows: 3, canonicalPreimageByteLength: 128,
			canonicalEpochVertexByteLength: 128, successorFencePreimageByteLength: 128,
			futureRows: {localCount: 1, receivedCount: 2, receivedPreimageBytes: 255, receivedEpochVertexBytes: 129, issuerDescriptorGrowth: 1}};
		expect(data(prepared.project!(saved))).toEqual(expected);
		const larger = prepared.project!({...saved, futureRows: {...saved.futureRows, receivedPreimageBytes: 256}});
		expect(larger.currentClose - first.currentClose).toBe(1); // RAW bytes, not N copies of a maximum.
		const oldRectangle = {...saved}; delete (oldRectangle as {futureRows?: FutureRows}).futureRows;
		expect(data(first.project!(oldRectangle))).toEqual(f.api.capacity({...seed, ...oldRectangle}, []));
	});
	it("mixed window runtime geometry rejects malformed/accessor/overflow inputs without mutating prepared data", async () => {
		const f = await fixture(), seed = {...f.input, maxCurrentJournalRows: 0}, prepared = f.api.capacity(seed, [], undefined, true);
		const futureRows = {localCount: 1, receivedCount: 2, receivedPreimageBytes: 3, receivedEpochVertexBytes: 3, issuerDescriptorGrowth: 1};
		const params = {maxIssuerDescriptors: 0, maxAdditionalCurrentJournalRows: 3, canonicalPreimageByteLength: 128,
			canonicalEpochVertexByteLength: 128, successorFencePreimageByteLength: 128, futureRows};
		const before = prepared.project!(params), plain = (value: Capacity) => {const {project: _p, advance: _a, ...data} = value; return data;};
		let accessed = 0;
		const accessor = Object.defineProperty({...futureRows}, "receivedPreimageBytes", {enumerable: true, get() {accessed++; return 3;}});
		for (const bad of [{}, {...futureRows, extra: 1}, {...futureRows, localCount: -1}, {...futureRows, receivedCount: 0.5},
			{...futureRows, receivedCount: Number.MAX_SAFE_INTEGER}, {...futureRows, receivedPreimageBytes: 1},
			{...futureRows, receivedPreimageBytes: 257}, {...futureRows, receivedEpochVertexBytes: Infinity},
			{...futureRows, receivedCount: 0, receivedPreimageBytes: 0}, {...futureRows, issuerDescriptorGrowth: 0}, accessor,
			Object.assign(Object.create({inherited: true}), futureRows)])
			expect(() => prepared.project!({...params, futureRows: bad as FutureRows})).toThrow();
		expect(() => prepared.project!({...params, maxAdditionalCurrentJournalRows: 2})).toThrow();
		const rootAccessor = Object.defineProperty({...params}, "futureRows", {enumerable: true, get() {accessed++; return futureRows;}});
		expect(() => prepared.project!(rootAccessor)).toThrow();
		const directAccessor = Object.defineProperty({...seed, ...params}, "futureRows", {enumerable: true, get() {accessed++; return futureRows;}});
		expect(() => f.api.capacity(directAccessor, [])).toThrow(); expect(accessed).toBe(0);
		expect(plain(prepared.project!(params))).toEqual(plain(before));
	});
	it("preflight N geometry bounds complete original local/received producer fields without changing default data-only results", async () => {
		const f = await fixture();
		for (const additions of [1, 2, 4]) for (const fenceCount of [0, 1] as const) {
			const input = {...f.input, maxAdditionalCurrentJournalRows: additions, successorFenceCount: fenceCount,
				successorFencePreimageByteLength: fenceCount === 0 ? 0 : f.preimage.byteLength}, bound = f.api.capacity(input);
			for (const received of [false, true]) f.dominates(bound, f.actual(input, received));
			expect(Object.keys(bound).sort()).toEqual(["currentClose", "runtimeCensusOverheadShape", "successorEntered", "successorFinal", "successorReserved"]);
			expect(() => encodeCanonical(bound)).not.toThrow();
			if (additions === 1) {const {maxAdditionalCurrentJournalRows: _count, ...implicit} = input; expect(f.api.capacity(implicit)).toEqual(bound);}
		}
	});
	it("preflight N boundary projector matches fresh heterogeneous geometry and retains only detached scalars across caller mutations", async () => {
		const f = await fixture(), input = {...f.input, scope: {...f.input.scope}, currentScope: {...f.input.currentScope}, maxCurrentJournalRows: 2};
		const values = f.actual(input, true), local = f.actual(input, false).local;
		const rows: Record<string, unknown>[] = [{...local, journalSequence: 0}, {...values.remote, journalSequence: 1, byteCharge: f.preimage.byteLength}];
		// Preserve the original strict plain-record input contract. Canonical
		// decoding intentionally returns null-prototype records instead.
		const savedInput = structuredClone(input), savedRows = structuredClone(rows);
		const ordinary = f.api.capacity(input, rows), prepared = f.api.capacity(input, rows, undefined, true);
		expect(ordinary).not.toHaveProperty("project"); expect(() => encodeCanonical(ordinary)).not.toThrow();
		expect(prepared.project).toBeTypeOf("function");
		const numerical = (capacity: Capacity) => {const {project: _project, advance: _advance, ...data} = capacity; return data;};
		expect(numerical(prepared)).toEqual(ordinary);
		const params = {maxIssuerDescriptors: 3, maxAdditionalCurrentJournalRows: 4,
			canonicalPreimageByteLength: 512, canonicalEpochVertexByteLength: 512, successorFencePreimageByteLength: 512};
		const expected = f.api.capacity({...savedInput, ...params}, savedRows), first = prepared.project!(params);
		expect(numerical(first)).toEqual(expected);
		input.scope.objectId = "changed"; input.currentScope.epoch = 9; input.maxDebtDescriptors = 200;
		rows[0]!.nativeIssued = undefined; rows[1]!.exactCanonicalPreimageBytes = new Uint8Array(200_000);
		expect(numerical(prepared.project!({...params}))).toEqual(expected);
		params.canonicalPreimageByteLength = 1024;
		expect(numerical(first)).toEqual(expected); // A later caller mutation cannot rewrite a returned bound.
	});
	it("preflight N projector refuses malformed/oversized rectangles and accessors without bypassing the original count and shape limits", async () => {
		const f = await fixture(), values = f.actual(f.input, true), row = {...values.remote, journalSequence: 0, byteCharge: f.preimage.byteLength};
		const prepared = f.api.capacity(f.input, [row], undefined, true), params = {maxIssuerDescriptors: 1, maxAdditionalCurrentJournalRows: 1,
			canonicalPreimageByteLength: f.preimage.byteLength, canonicalEpochVertexByteLength: f.vertex.byteLength, successorFencePreimageByteLength: f.preimage.byteLength};
		for (const count of [-1, 0, 0.5, NaN, Infinity, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1])
			expect(() => prepared.project!({...params, maxAdditionalCurrentJournalRows: count})).toThrow();
		expect(() => prepared.project!({...params, maxAdditionalCurrentJournalRows: LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows})).toThrow();
		let accessed = false;
		const accessor = Object.defineProperty({...params}, "maxIssuerDescriptors", {enumerable: true, get: () => {accessed = true; return 1;}});
		expect(() => prepared.project!(accessor)).toThrow(); expect(accessed).toBe(false);
		expect(() => prepared.project!({...params, extra: true} as typeof params)).toThrow();
	});
	it("incremental original runtime geometry advances exact heterogeneous accepted rows without retaining borrowed payloads", async () => {
		// Controlled numeric producer DATA only; native/source/ACL/graph acceptance
		// is independently required by the actual lifetime before this projection.
		const f = await fixture(), rows: Record<string, unknown>[] = [];
		const input = {...f.input, maxCurrentJournalRows: 0, maxAdditionalCurrentJournalRows: 1};
		let prepared = f.api.capacity(input, rows, undefined, true);
		const data = (value: Capacity) => {const {project: _project, advance: _advance, ...plain} = value; return plain;};
		const params = {maxIssuerDescriptors: 4, maxAdditionalCurrentJournalRows: 4,
			canonicalPreimageByteLength: 512, canonicalEpochVertexByteLength: 512, successorFencePreimageByteLength: 512};
		for (let sequence = 0; sequence < 129; sequence++) {
			const preimage = new Uint8Array(sequence === 0 ? 8334 : 257), vertex = new Uint8Array(sequence === 0 ? 8192 : 193);
			const original = f.actual(input, sequence % 3 !== 1, [], preimage, vertex);
			const row = {...(sequence % 3 === 1 ? original.local : original.remote), journalSequence: sequence,
				byteCharge: preimage.byteLength};
			const saved = structuredClone(row), previous = prepared, before = data(prepared.project!(params));
			prepared = prepared.advance!(row); rows.push(saved);
			const cold = f.api.capacity({...input, ...params, maxCurrentJournalRows: rows.length}, rows);
			expect(data(prepared.project!(params)), String(sequence)).toEqual(cold);
			for (const debt of [2, 64]) {
				const fresh = f.api.capacity({...input, ...params, maxDebtDescriptors: debt, maxCurrentJournalRows: rows.length}, rows);
				expect(data(prepared.project!({...params, maxDebtDescriptors: debt}))).toEqual(fresh);
			}
			expect(data(previous.project!(params))).toEqual(before);
			preimage.fill(255); vertex.fill(255); row.byteCharge = 1;
			expect(data(prepared.project!(params))).toEqual(cold);
		}
		const stable = data(prepared.project!(params));
		for (const row of [{}, {...rows[0], sourceKind: "unknown"}, {...rows[0], detachedSignature: new Uint8Array(63)},
			{...rows[0], byteCharge: 1}]) expect(() => prepared.advance!(row)).toThrow();
		expect(data(prepared.project!(params))).toEqual(stable);
	});
	it("preflight N fresh accepted geometry dominates original mixed-row fields without re-rectangularizing the accepted prefix", async () => {
		const f = await fixture(), largePreimage = new Uint8Array(8334), largeVertex = new Uint8Array(8192),
			smallPreimage = new Uint8Array(257), smallVertex = new Uint8Array(193);
		for (const count of [1, 2, 4, 5]) for (const fence of [0, 1] as const) {
			const input = {...f.input, maxCurrentJournalRows: 3, maxAdditionalCurrentJournalRows: count,
				maxIssuerDescriptors: count, canonicalPreimageByteLength: smallPreimage.byteLength,
				canonicalEpochVertexByteLength: smallVertex.byteLength, successorFenceCount: fence,
				successorFencePreimageByteLength: fence === 0 ? 0 : smallPreimage.byteLength};
			const values = f.actual(input, true, [], smallPreimage, smallVertex), large = f.actual(input, true, [], largePreimage, largeVertex).remote,
				small = f.actual(input, true, [], smallPreimage, smallVertex).remote, local = f.actual(input, false).local;
			const actualRows = [{...large, journalSequence: 0, byteCharge: largePreimage.byteLength},
				{...small, journalSequence: 1, byteCharge: smallPreimage.byteLength}, {...local, journalSequence: 2}];
			const originalRows = [large, small, local, ...Array(count).fill(values.remote)];
			// Original independent field producers at MAX_SAFE counters, complete
			// large/small OLD PRE+signature+vertex BYTES, and N SMALL future rows.
			(values.currentClose as any).currentJournal.rows = originalRows;
			(values.nonActiveCurrent as any).currentJournal.rows = originalRows;
			const fresh = f.api.capacity(input, actualRows); f.dominates(fresh, values);
			const obsolete = f.api.capacity({...input, maxCurrentJournalRows: 1,
				maxAdditionalCurrentJournalRows: count + 2}, actualRows.slice(0, 1));
			expect(fresh.currentClose).toBeLessThan(obsolete.currentClose);
			expect(fresh.successorFinal).toBe(obsolete.successorFinal);
		}
		// Execute the original held-runtime count gate too. Fresh native/journal
		// provenance is an explicit controlled premise, not native auth evidence.
		const path = new URL("../src/v3-live.ts", import.meta.url), parsed = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const methods: ts.Expression[] = [];
		function find(node: ts.Node): void {
			if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "readCapacityWidths") methods.push(node.initializer);
			ts.forEachChild(node, find);
		}
		find(parsed); expect(methods).toHaveLength(1);
		const lifetime = {}, rows = {lineages: [f.input.scope], issued: [], outbox: [f.input.scope], plans: []},
			journal = [{exactCanonicalPreimageBytes: largePreimage, exactCanonicalVertexBytes: largeVertex}],
			currentRows = [{...f.actual(f.input, true, [], largePreimage, largeVertex).remote, journalSequence: 0, byteCharge: largePreimage.byteLength}],
			identity = {}, machine = {}, machineIdentity = {}, registration = {issuanceScope: f.input.scope, payload: {},
				graphVersion: 3, blueprintMachine: machine, blueprintMachineIdentity: machineIdentity},
			enrolled = {unsignedBytes: f.preimage, value: {runtime: {graphVersion: 3}, candidate: {exactCanonicalEpochVertexBytes: f.vertex}},
				sourceIdentity: identity, machine, machineIdentity};
		let checks = 0;
		let fullGeometryReads = 0;
		const runtimeGeometry = new WeakMap<object, unknown>(), journalImageDigest = "b".repeat(64);
		const facts = {check: () => {checks++;}, currentDimensions: enrolled as typeof enrolled | undefined};
		const read = execute<(this: object, input: Input) => Capacity>(`(${methods[0]!.getText(parsed)})`, {
			ObjectFreeze: Object.freeze,
			ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			lifetime, facts, issuanceBorrowAvailable: true, nativeIssuanceCapture: {rows}, currentJournalCapture: journal,
			ordinaryRuntimeCapacityGeometry: runtimeGeometry, currentJournalImageDigest: journalImageDigest,
			registration, trust: {profileId: "creator-trusted-settlement-v1", objectId: f.input.scope.objectId},
			creatorOrdinaryIssuanceSourceIdentity: () => identity,
			sameScope: (a: unknown, b: unknown) => encodeCanonical(a).toString() === encodeCanonical(b).toString(),
			sameLiveJournalScope: (a: unknown, b: unknown) => encodeCanonical(a).toString() === encodeCanonical(b).toString(),
			liveJournalScope: () => f.input.currentScope, settlementProfileFor: () => "v1", ordinaryRuntimePendingIngress: () => ({}),
			creatorJournalCensusRows: () => {fullGeometryReads++; return currentRows;}, creatorOrdinaryRuntimeCapacityWidths: f.api.capacity,
		});
		for (const count of [1, 2, 4, 5]) {
			const input = {...f.input, maxAdditionalCurrentJournalRows: count, maxIssuerDescriptors: count};
			expect(read.call(lifetime, input)).toEqual(f.api.capacity(input, currentRows));
			expect(() => read.call(lifetime, {...input, maxIssuerDescriptors: count + 1})).toThrow("counts differ");
		}
		for (const count of [0, -1, 1.5, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1])
			expect(() => read.call(lifetime, {...f.input, maxAdditionalCurrentJournalRows: count, maxIssuerDescriptors: count})).toThrow();
		const beforeWindow = fullGeometryReads, beforeChecks = checks;
		expect(() => read.call(lifetime, {...f.input, futureRows: {localCount: 0, receivedCount: 1,
			receivedPreimageBytes: f.preimage.byteLength, receivedEpochVertexBytes: f.vertex.byteLength,
			issuerDescriptorGrowth: 0}})).toThrow("window geometry requires boundary preparation");
		expect(fullGeometryReads).toBe(beforeWindow); expect(checks).toBe(beforeChecks + 1);
		let invoked = false;
		const accessorWindow = {...f.input}; Object.defineProperty(accessorWindow, "futureRows", {enumerable: true,
			get() {invoked = true; throw Error("untrusted window accessor");}});
		expect(() => read.call(lifetime, accessorWindow)).toThrow("window geometry requires boundary preparation");
		expect(invoked).toBe(false);
		// Default one-job semantics remain conservative; explicit N keeps OLD
		// large bytes exact without assigning their width to every future leaf.
		expect(read.call(lifetime, f.input)).toEqual(f.api.capacity({...f.input,
			canonicalPreimageByteLength: largePreimage.byteLength, canonicalEpochVertexByteLength: largeVertex.byteLength}, currentRows));
		for (const input of [{...f.input, maxAdditionalCurrentJournalRows: 1, canonicalPreimageByteLength: f.preimage.byteLength - 1},
			{...f.input, maxAdditionalCurrentJournalRows: 1, canonicalEpochVertexByteLength: f.vertex.byteLength - 1}])
			expect(() => read.call(lifetime, input)).toThrow("future geometry differs");
		// Positive nominal producer/native-image correspondence is a controlled
		// premise here, not a caller-shaped runtime authorization. SAME original
		// method keeps every count/candidate check and its pure output shape.
		const prepared = f.api.capacity(f.input, currentRows, undefined, true), cell = {
			sourceIdentity: identity, graphVersion: 3, rowCount: 1, widths: prepared, journalImageDigest};
		runtimeGeometry.set(registration, cell);
		const before = fullGeometryReads, input = {...f.input, maxAdditionalCurrentJournalRows: 4, maxIssuerDescriptors: 4};
		expect(read.call(lifetime, input)).toEqual(f.api.capacity(input, currentRows));
		expect(fullGeometryReads).toBe(before); // No old-vector reconstruction.
		for (const changed of [{...cell, sourceIdentity: {}}, {...cell, graphVersion: 2}, {...cell, rowCount: 0},
			{...cell, journalImageDigest: undefined}, {...cell, journalImageDigest: "c".repeat(64)}]) {
			runtimeGeometry.set(registration, changed);
			expect(read.call(lifetime, input)).toEqual(f.api.capacity(input, currentRows));
		}
		expect(fullGeometryReads).toBe(before + 5);
		facts.currentDimensions = undefined;
		expect(() => read.call(lifetime, {...f.input, maxAdditionalCurrentJournalRows: 1})).toThrow("future geometry differs");
		facts.currentDimensions = enrolled; registration.graphVersion++;
		expect(() => read.call(lifetime, {...f.input, maxAdditionalCurrentJournalRows: 1})).toThrow("future geometry differs");
		expect(checks).toBeGreaterThan(0);
	});
	it("bounds actual complete local and full received current/precursor/final field producers, retaining distinct preimage and EpochVertex BYTES", async () => {
		const f = await fixture(), before = encodeCanonical(f.input), bound = f.api.capacity(f.input);
		for (const received of [false, true]) f.dominates(bound, f.actual(f.input, received));
		const foreign = f.actual(f.input, true); expect(Object.keys(foreign.remote)).toHaveLength(7);
		expect(f.preimage.byteLength).not.toBe(f.vertex.byteLength);
		expect(bound.currentClose).toBe(encodeCanonical(foreign.currentClose).byteLength - 1);
		expect(bound.successorReserved).toBe(encodeCanonical(foreign.successorReserved).byteLength - 1);
		expect(bound.successorFinal).toBe(encodeCanonical(foreign.successorFinal).byteLength - 1);
		const root = {dependencyKind: "authenticated-unadmitted-pending-ingress", digest: f.input.currentScope.anchorDigest,
			exactCanonicalPreimageBytes: f.preimage, signature: new Uint8Array(64), wireByteCharge: Number.MAX_SAFE_INTEGER,
			missingParents: Array(16).fill(f.input.currentScope.anchorDigest), scope: f.input.currentScope};
		const pending = f.actual(f.input, true, [root]).pending, input = {...f.input, receivedPendingIngressByteLength: encodeCanonical(pending).byteLength};
		const receivedBound = f.api.capacity(input), receivedValues = f.actual(input, true, [root]);
		f.dominates(receivedBound, receivedValues); expect(f.api.shape(pending)).toEqual({items: 91, maxDepth: 4});
		expect(receivedBound.successorReserved).toBe(encodeCanonical(receivedValues.successorReserved).byteLength - 1);
		expect(encodeCanonical(f.input)).toEqual(before); expect(Object.isFrozen(receivedBound.runtimeCensusOverheadShape)).toBe(true);
		// Arithmetic data neither authenticates this root nor grants entered custody.
	});
	it("uses complete heterogeneous held rows rather than repeating the largest bootstrap at every old address", async () => {
		const f = await fixture(), maximum = Number.MAX_SAFE_INTEGER, digest = f.input.currentScope.anchorDigest;
		const bootstrap = encodeCanonical({...decodeCanonical(f.preimage) as object, operation: {action: "installRoster", text: "é".repeat(4_167)}});
		const bootstrapVertex = encodeCanonical({...decodeCanonical(f.vertex) as object, operation: {action: "installRoster", text: "é".repeat(4_167)}});
		for (const count of [0, 1, 19, 126, 127, 128]) for (const fenceCount of [0, 1] as const) {
			const input = {...f.input, maxCurrentJournalRows: count, canonicalPreimageByteLength: bootstrap.byteLength,
				canonicalEpochVertexByteLength: bootstrapVertex.byteLength, successorFenceCount: fenceCount,
				successorFencePreimageByteLength: fenceCount === 0 ? 0 : f.preimage.byteLength};
			const old = Array.from({length: count}, (_, index) => index % 3 === 0 ?
				f.api.local(index, {...input.scope, author: "2".repeat(64)}, index, f.preimage.byteLength, digest) :
				f.api.received({journalSequence: index, byteCharge: index === 1 ? bootstrap.byteLength : f.preimage.byteLength,
					digest, exactCanonicalPreimageBytes: index === 1 ? bootstrap : f.preimage, detachedSignature: new Uint8Array(64),
					exactCanonicalVertexBytes: index === 1 ? bootstrapVertex : f.vertex}));
			const bound = f.api.capacity(input, old), uniform = f.api.capacity(input), before = encodeCanonical(old);
			const widened = old.map(value => {
				const row = value as Record<string, unknown>;
				return {...row, journalSequence: maximum, byteCharge: maximum,
					...(row.sourceKind === "local-issued" ? {nativeIssued: {...row.nativeIssued as object, authorSequence: maximum}} : {})};
			});
			for (const candidateReceived of [false, true]) {
				const values = f.actual(input, candidateReceived, [], bootstrap, bootstrapVertex);
				for (const value of [values.currentClose, values.nonActiveCurrent])
					((value as Record<string, unknown>).currentJournal as {rows: object[]}).rows = [...widened, candidateReceived ? values.remote : values.local];
				f.dominates(bound, values);
				if (candidateReceived) expect(bound.currentClose).toBe(encodeCanonical(values.currentClose).byteLength - 1);
			}
			for (const phase of ["successorReserved", "successorEntered", "successorFinal"] as const)
				expect(bound[phase]).toBe(uniform[phase]);
			expect(bound.currentClose).toBeLessThanOrEqual(uniform.currentClose);
			if (count >= 19) expect(uniform.currentClose - bound.currentClose).toBeGreaterThan(200_000);
			expect(encodeCanonical(old)).toEqual(before);
		}
		// Controlled scalar geometry, not nominal source/native authentication.
	});
	it("keeps actual historical PRE and vertex widths even when they exceed the new candidate rectangle", async () => {
		const f = await fixture(), preimage = new Uint8Array(8_334), vertex = new Uint8Array(8_271);
		const row = f.api.received({journalSequence: Number.MAX_SAFE_INTEGER, byteCharge: preimage.byteLength,
			digest: f.input.currentScope.anchorDigest, exactCanonicalPreimageBytes: preimage,
			detachedSignature: new Uint8Array(64), exactCanonicalVertexBytes: vertex});
		const bound = f.api.capacity(f.input, [row]), values = f.actual(f.input, true);
		for (const value of [values.currentClose, values.nonActiveCurrent])
			((value as Record<string, unknown>).currentJournal as {rows: object[]}).rows = [{...row, byteCharge: Number.MAX_SAFE_INTEGER}, values.remote];
		f.dominates(bound, values);
		expect(bound.currentClose).toBe(encodeCanonical(values.currentClose).byteLength - 1);
		expect(bound.currentClose).toBeGreaterThan(f.api.capacity(f.input).currentClose);
	});
	it("refuses incomplete, accessor, malformed or mismatched resource row geometry without changing standalone sizing", async () => {
		const f = await fixture(), values = f.actual(f.input, true), local = f.actual(f.input, false).local;
		const sparse = new Array(1), accessor = Object.defineProperty([], "0", {get: () => {throw Error("GETTER_EXECUTED");}});
		for (const rows of [[], [values.remote, values.remote], sparse, accessor,
			[{...values.remote, detachedSignature: new Uint8Array(63)}], [{...values.remote, byteCharge: 1}],
			[{...values.remote, sourceKind: "invented"}], [{...values.remote, extra: false}],
			[{...local, nativeIssued: {scope: {...f.input.scope, objectId: "wrong"}, authorSequence: 0}}],
			[{...local, journalSequence: -1}]]) expect(() => f.api.capacity(f.input, rows)).toThrow(/ordinary runtime journal geometry/);
		expect(f.api.capacity(f.input)).toEqual(f.api.capacity(f.input, undefined));
	});
	it("bounds the original zero-fence successor without inventing a descriptor or journal row", async () => {
		const f = await fixture(), input = {...f.input, successorFenceCount: 0 as const, successorFencePreimageByteLength: 0};
		const zero = f.api.capacity(input), one = f.api.capacity(f.input);
		for (const received of [false, true]) f.dominates(zero, f.actual(input, received));
		// 1515daab: without a successor fence no future manual-review source is
		// reserved, so the zero-fence close is exactly its own carrier and differs
		// from the one-fence close by exactly those source entries, never by an
		// invented descriptor or journal row.
		expect(zero.currentClose).toBe(encodeCanonical(f.actual(input, true).currentClose).byteLength - 1);
		const zeroActive = f.actual(input, true).currentClose as Record<string, unknown>, oneActive = f.actual(f.input, true).currentClose as Record<string, unknown>;
		expect(encodeCanonical({...oneActive, activeUnsettled: zeroActive.activeUnsettled})).toEqual(encodeCanonical(zeroActive));
		expect(one.currentClose - zero.currentClose).toBe(encodeCanonical(oneActive).byteLength - encodeCanonical(zeroActive).byteLength);
		expect(zero.successorFinal).toBe(encodeCanonical(f.actual(input, true).successorFinal).byteLength - 1);
		expect(zero.successorFinal).toBeLessThan(one.successorFinal);
		expect(zero.successorReserved).toBe(zero.successorFinal);
		expect(zero.successorEntered).toBe(zero.successorFinal);
		expect(() => f.api.capacity({...input, successorFencePreimageByteLength: 1})).toThrow();
		expect(() => f.api.capacity({...input, successorFenceCount: 1})).toThrow();
	});
	it("counts127/128 array and BYTES headers and every decoded collection edge through the real wrapper schemas", async () => {
		const f = await fixture();
		for (const count of [126, 127]) {
			const input = {...f.input, maxIssuerDescriptors: count, maxCurrentJournalRows: count}, bound = f.api.capacity(input);
			f.dominates(bound, f.actual(input, true));
			expect(bound.currentClose).toBe(encodeCanonical(f.actual(input, true).currentClose).byteLength - 1);
		}
		const base = {...f.input, canonicalPreimageByteLength: 127, canonicalEpochVertexByteLength: 127};
		const a = f.api.capacity(base), b = f.api.capacity({...base, canonicalPreimageByteLength: 128}), c = f.api.capacity({...base, canonicalEpochVertexByteLength: 128});
		expect(b.currentClose - a.currentClose).toBe(2 * (base.maxCurrentJournalRows + 1));
		expect(c.currentClose - a.currentClose).toBe(2 * (base.maxCurrentJournalRows + 1));
		expect(b.successorReserved).toBe(a.successorReserved); expect(b.successorFinal).toBe(a.successorFinal);
		for (const [value, items] of [[false, 1], [[false], 3], [{leaf: false}, 5], [{rows: [false]}, 7]] as const) {
			expect(f.api.shape(value).items).toBe(items); const bytes = encodeCanonical(value);
			decodeCanonical(bytes, {maxItems: items}); expect(() => decodeCanonical(bytes, {maxItems: items - 1})).toThrow();
		}
	});
	it("refuses malformed scopes, exhausted counter/count domains, underdeclared pending and aggregate proof shapes without claiming protocol invalidity", async () => {
		const f = await fixture(); expect(f.api.capacity(f.input).currentClose).toBeGreaterThan(0);
		const emptyPendingWidth = encodeCanonical(f.actual(f.input, false).pending).byteLength;
		const invalid = [{...f.input, scope: {...f.input.scope, extra: true}}, {...f.input, currentScope: {...f.input.currentScope, extra: true}},
			{...f.input, currentScope: {...f.input.currentScope, objectId: "other"}}, {...f.input, scope: {...f.input.scope, author: "A".repeat(64)}},
			{...f.input, currentScope: {...f.input.currentScope, epoch: Number.MAX_SAFE_INTEGER}},
			...[-1, 1.5, NaN, Infinity, 1023].map(maxIssuerDescriptors => ({...f.input, maxIssuerDescriptors})),
			{...f.input, maxDebtDescriptors: 1024}, {...f.input, maxCurrentJournalRows: LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows},
			{...f.input, maxCurrentJournalRows: 3000}, {...f.input, maxDependencyAnchors: 0}, {...f.input, maxDependencyAnchors: 8},
			...[0, -1, 1.5, Infinity, 65_537].map(canonicalPreimageByteLength => ({...f.input, canonicalPreimageByteLength})),
			{...f.input, canonicalEpochVertexByteLength: 0}, {...f.input, successorFencePreimageByteLength: 65_537},
			{...f.input, receivedPendingIngressByteLength: emptyPendingWidth - 1},
			{...f.input, receivedPendingIngressByteLength: AHE_BOUNDED_READ_LIMITS.maxUnionBytes + 1}];
		for (const input of invalid) expect(() => f.api.capacity(input as Input)).toThrow();
		// Caller falls back to original exact admission; these local unsupported
		// numerical inputs cannot redefine signed-input validity or cancel debt.
	});
	async function consumerFixture() {
		const f = await fixture(), {readCreatorOrdinaryPreimageCapacityForSizing} = await import("../src/internal/creator-closed-rollback-data.js");
		const path = new URL("../src/creator-close.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const extract = (name: string) => {
			const nodes = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (nodes.length !== 1) throw Error(`ORDINARY_CAPACITY_CONSUMER:${name}:${nodes.length}`);
			return nodes[0]!.getText(file).replace(/^export /, "");
		};
		const consume = execute<(registration: object, census: Record<string, unknown>, bytes: Uint8Array, postAdoption: object[]) =>
			{runtime: Capacity; canonicalPreimageByteLength: number; canonicalEpochVertexByteLength: number;
				canonicalSuccessorFencePreimageByteLength: number} | undefined>(`${extract("plainRecord")}\n${extract("creatorOrdinaryFinishingCapacityDimensions")}\ncreatorOrdinaryFinishingCapacityDimensions;`,
			{readCreatorOrdinaryPreimageCapacityForSizing, encodeCanonical, settlementProfileFor});
		const calls: Input[] = [], registration = {objectId: f.input.scope.objectId, issuanceScope: f.input.scope,
			currentTrust: {profileId: "creator-trusted-settlement-v1", currentEpoch: f.input.currentScope.epoch, currentAnchorDigest: f.input.currentScope.anchorDigest},
			readOrdinaryRuntimeCapacityWidths: (input: Input) => {calls.push(input); return f.api.capacity(input);}};
		const census: Record<string, unknown> = {...f.actual(f.input, false).currentClose};
		census.currentJournal = {...census.currentJournal as object, scope: f.input.currentScope};
		// The consumer reads the PRESENT census, which holds no unsettled source;
		// the maximal future manual-review entries are only the sizing carrier.
		census.activeUnsettled = {...census.activeUnsettled as object, sources: []};
		const phase = (phase: "reserved" | "entered", bytes: number) => ({phase, canonicalUnsignedVertexByteLength: bytes,
			runtimeCensusOverheadByteLength: 1, nativeRowsByteLength: 1, nativeImageByteLength: 1, nativeControlRevisionDelta: 1});
		const variant = (bytes: number) => ({runtimeCensusOverheadByteLength: 1, nativeRowsByteLength: 1, nativeImageByteLength: 1,
			nativeControlRevisionDelta: 1, successorJournalAppendForSizing: {author: f.input.scope.author, authorSequence: 2},
			nativeJobPhases: [phase("reserved", bytes), phase("entered", bytes)]});
		const postAdoption = [variant(511), variant(512)];
		const root = {dependencyKind: "authenticated-unadmitted-pending-ingress", digest: f.input.currentScope.anchorDigest,
			exactCanonicalPreimageBytes: f.preimage, signature: new Uint8Array(64), wireByteCharge: f.preimage.byteLength + 64,
			missingParents: Array(16).fill(f.input.currentScope.anchorDigest), scope: f.input.currentScope};
		const pending = f.api.active({pendingRoots: [root], wireByteCharge: root.wireByteCharge,
			unsettledSources: [], cursor: null, cacheSourceSequences: [], epoch: f.input.currentScope.epoch}).pendingIngress as Record<string, unknown>;
		return {...f, consume, calls, registration, census, postAdoption, root, pending};
	}
	it("consumer selects zero fence only for the original NONE profile and refuses mixed successor topology", async () => {
		const f = await consumerFixture(), registration = {...f.registration,
			currentTrust: {...f.registration.currentTrust, profileId: "creator-trusted-v1"}};
		const capacity = f.consume(registration, f.census, f.preimage, [{}, {}]);
		expect(capacity).toBeDefined(); expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.successorFenceCount).toBe(0);
		expect(f.calls[0]!.successorFencePreimageByteLength).toBe(0);
		expect(capacity!.canonicalSuccessorFencePreimageByteLength).toBe(0);
		expect(f.consume(registration, f.census, f.preimage, f.postAdoption)).toBeUndefined();
		expect(f.consume(f.registration, f.census, f.preimage, [{}])).toBeUndefined();
		expect(f.consume(registration, f.census, f.preimage, [{nativeJobPhases: []}])).toBeUndefined();
	});
	it("consumer reads actual source-before-candidate counts and correlated fence phases through the original numerical owners", async () => {
		const f = await consumerFixture(), before = encodeCanonical(f.census), capacity = f.consume(f.registration, f.census, f.preimage, f.postAdoption);
		expect(capacity).toBeDefined(); expect(f.calls).toHaveLength(1); const input = f.calls[0]!;
		expect(input.maxIssuerDescriptors).toBe((f.census.rows as unknown[]).length);
		expect(input.maxDebtDescriptors).toBe((f.census.debt as unknown[]).length);
		expect(input.maxCurrentJournalRows).toBe(((f.census.currentJournal as Record<string, unknown>).rows as unknown[]).length);
		expect(input.maxDependencyAnchors).toBe(7);
		expect(input.successorFencePreimageByteLength).toBe(512); expect(capacity!.canonicalSuccessorFencePreimageByteLength).toBe(512);
		expect(input.canonicalPreimageByteLength).toBeGreaterThanOrEqual(f.preimage.byteLength);
		expect(input.canonicalEpochVertexByteLength).toBeGreaterThanOrEqual(f.vertex.byteLength);
		expect(capacity!.runtime).toEqual(f.api.capacity(input)); expect(Object.isFrozen(capacity)).toBe(true);
		const foreign = {...f.census, pendingIngress: f.pending};
		expect(f.consume(f.registration, foreign, f.preimage, f.postAdoption)).toBeDefined();
		expect(f.calls[1]!.receivedPendingIngressByteLength).toBe(encodeCanonical(f.pending).byteLength);
		const noPending = {...f.census}; delete noPending.pendingIngress;
		expect(f.consume(f.registration, noPending, f.preimage, f.postAdoption)).toBeDefined();
		expect(Object.hasOwn(f.calls[2]!, "receivedPendingIngressByteLength")).toBe(false);
		const atLimit = {...f.census, rows: Array(256).fill((f.census.rows as unknown[])[0]),
			currentJournal: {...f.census.currentJournal as object, rows: Array(256).fill(f.actual(f.input, false).local)}};
		expect(f.consume(f.registration, atLimit, f.preimage, f.postAdoption)).toBeDefined();
		expect(f.calls.at(-1)!.maxIssuerDescriptors).toBe(256); expect(f.calls.at(-1)!.maxCurrentJournalRows).toBe(256);
		const noSourceAnchors = {...f.census, dependencyAnchors: []};
		expect(f.consume(f.registration, noSourceAnchors, f.preimage, f.postAdoption)).toBeDefined();
		expect(f.calls.at(-1)!.maxDependencyAnchors).toBe(7); // Original successor ceiling includes the newly introduced close anchor.
		const source = decodeCanonical(f.preimage) as Record<string, unknown>;
		for (const operation of [{action: "roster", members: Array(128).fill(f.input.scope.author)},
			{action: "batch", transactions: Array(128).fill({action: "set", value: f.input.currentScope.anchorDigest})}]) {
			const oldPreimage = encodeCanonical({...source, operation}), oldVertex = encodeCanonical({
				kind: source.kind, objectId: source.objectId, epoch: source.epoch, anchor: source.anchor,
				hash: f.input.currentScope.anchorDigest, dependencies: source.dependencies, operation});
			expect(encodeCanonical(operation).byteLength).toBeGreaterThan(512);
			expect(oldPreimage.byteLength).toBeGreaterThanOrEqual(8_334);
			const received = f.actual(f.input, true, [], oldPreimage, oldVertex), retained = {
				...f.census, currentJournal: {...f.census.currentJournal as object, rows: [received.remote, received.local]}};
			const historical = f.consume(f.registration, retained, f.preimage, f.postAdoption);
			expect(historical).toBeDefined(); const dimensions = f.calls.at(-1)!;
			expect(dimensions.canonicalPreimageByteLength).toBe(oldPreimage.byteLength);
			expect(dimensions.canonicalEpochVertexByteLength).toBe(oldVertex.byteLength);
			expect(dimensions.maxCurrentJournalRows).toBe(2);
			expect(historical!.runtime).toEqual(f.api.capacity(dimensions));
			// Complete already-admitted BYTES remain opaque and separately sized;
			// this fixture does not authenticate old work or readmit it as NEW work.
			// NEW complete candidates now use actual widths, but the unchanged
			// operation depth/item guard still rejects oversized container shapes.
			if (operation.action === "roster") expect(f.consume(f.registration, f.census, oldPreimage, f.postAdoption)).toBeDefined();
			else expect(f.consume(f.registration, f.census, oldPreimage, f.postAdoption)).toBeUndefined();
		}
		const baseOperation = {action: "short", payload: ""}, baseWidth = encodeCanonical(baseOperation).byteLength;
		const operation512 = {...baseOperation, payload: "x".repeat(512 - baseWidth - 1)};
		expect(encodeCanonical(operation512).byteLength).toBe(512);
		expect(f.consume(f.registration, f.census, encodeCanonical({...source, operation: operation512}), f.postAdoption)).toBeDefined();
		const operation513 = {...operation512, payload: operation512.payload + "x"};
		expect(encodeCanonical(operation513).byteLength).toBe(513);
		expect(f.consume(f.registration, f.census, encodeCanonical({...source, operation: operation513}), f.postAdoption)).toBeDefined();
		expect(encodeCanonical(f.census)).toEqual(before);
		// Supplied source fixtures are arithmetic data, not authentication, native
		// custody, a paid reserve or evidence of creator/follower progress.
	});
	it("consumer keeps unsupported source growth, unresolved work, incomplete fence phases and original numerical refusal on exact fallback", async () => {
		const f = await consumerFixture(); expect(f.consume(f.registration, f.census, f.preimage, f.postAdoption)).toBeDefined();
		const active = f.census.activeUnsettled as Record<string, unknown>, journal = f.census.currentJournal as Record<string, unknown>;
		const outside: Record<string, unknown>[] = [{...f.census, rows: Array(257).fill({})}, {...f.census, rows: {}}, {...f.census, debt: {}},
			{...f.census, dependencyAnchors: {}}, {...f.census, currentJournal: {...journal, rows: Array(257).fill({})}},
			{...f.census, currentJournal: {...journal, rows: {}}}, {...f.census, activeUnsettled: {...active, sources: [{}]}},
			{...f.census, activeUnsettled: {...active, cursor: 0}}, {...f.census, activeUnsettled: {...active, cacheSourceSequences: [0]}},
			{...f.census, pendingIngress: {...f.pending, roots: [f.root, f.root]}},
			{...f.census, pendingIngress: {...f.pending, roots: [{...f.root, missingParents: Array(17).fill(f.input.currentScope.anchorDigest)}]}}];
		outside.push({...f.census, currentJournal: {...journal, rows: [{sourceKind: "unknown-future"}]}},
			...[
				{...f.actual(f.input, true).remote, exactCanonicalPreimageBytes: [f.preimage]},
				{...f.actual(f.input, true).remote, exactCanonicalVertexBytes: undefined},
			].map(row => ({...f.census, currentJournal: {...journal, rows: [row]}})));
		for (const census of outside) expect(f.consume(f.registration, census, f.preimage, f.postAdoption)).toBeUndefined();
		for (const variants of [[], [{...f.postAdoption[0], nativeJobPhases: []}], [{...f.postAdoption[0], currentContinuation: {}}],
			[{...f.postAdoption[0], successorJournalAppendForSizing: undefined}],
			[{...f.postAdoption[0], nativeJobPhases: [{phase: "reserved", canonicalUnsignedVertexByteLength: 65_537}]}]])
			expect(f.consume(f.registration, f.census, f.preimage, variants)).toBeUndefined();
		expect(f.consume(f.registration, f.census, Uint8Array.of(255), f.postAdoption)).toBeUndefined();
		const refuse = {...f.registration, readOrdinaryRuntimeCapacityWidths: () => {throw new TypeError("ACTUAL_NUMERICAL_OWNER_REFUSAL");}};
		expect(f.consume(refuse, f.census, f.preimage, f.postAdoption)).toBeUndefined();
	});
	it("consumer refuses extra or malformed pending and active carrier fields rather than undercounting the fixed original schemas", async () => {
		const f = await consumerFixture(), active = f.census.activeUnsettled as Record<string, unknown>;
		expect(f.consume(f.registration, {...f.census, pendingIngress: f.pending}, f.preimage, f.postAdoption)).toBeDefined();
		const malformedRoots = [{...f.root, extra: Array(128).fill(false)}, {...f.root, digest: [f.root.digest]},
			{...f.root, dependencyKind: "received"}, {...f.root, digest: "A".repeat(64)},
			{...f.root, exactCanonicalPreimageBytes: [f.preimage]}, {...f.root, signature: [new Uint8Array(64)]},
			{...f.root, signature: new Uint8Array(63)}, {...f.root, wireByteCharge: []}, {...f.root, wireByteCharge: -1},
			{...f.root, missingParents: [Array(128).fill(false)]}, {...f.root, missingParents: ["not-a-digest"]},
			{...f.root, scope: {...f.input.currentScope, extra: Array(128).fill(false)}},
			...[{objectId: "other"}, {epoch: f.input.currentScope.epoch + 1}, {anchorDigest: "b".repeat(64)}]
				.map(scope => ({...f.root, scope: {...f.input.currentScope, ...scope}}))];
		for (const root of malformedRoots) expect(f.consume(f.registration, {...f.census, pendingIngress: {...f.pending, roots: [root]}},
			f.preimage, f.postAdoption)).toBeUndefined();
		for (const pending of [{...f.pending, extra: Array(128).fill(false)}, {...f.pending, wireByteCharge: []},
			{...f.pending, wireByteCharge: -1}, {...f.pending, admission: []}, {...f.pending, admission: "admitted"},
			{...f.pending, graphClosure: []}, {...f.pending, graphClosure: "no-pending-roots"}])
			expect(f.consume(f.registration, {...f.census, pendingIngress: pending}, f.preimage, f.postAdoption)).toBeUndefined();
		for (const changed of [{...active, extra: Array(128).fill(false)}, {...active, sourceSequence: 0, sourceDigest: new Uint8Array(32)},
			{...active, availableHistoricalDepth: []}, {...active, availableHistoricalDepth: 1}, {...active, coverage: []},
			{...active, coverage: "other"}])
			expect(f.consume(f.registration, {...f.census, activeUnsettled: changed}, f.preimage, f.postAdoption)).toBeUndefined();
		for (const extra of [{migrationSource: {}}, {targetFloors: []}, {extra: Array(128).fill(false)}])
			expect(f.consume(f.registration, {...f.census, ...extra}, f.preimage, f.postAdoption)).toBeUndefined();
		const journal = f.census.currentJournal as Record<string, unknown>;
		for (const currentJournal of [{...journal, extra: false}, {...journal, dependencyKind: "other"},
			{...journal, scope: {...f.input.currentScope, extra: false}},
			...[{objectId: "other"}, {epoch: f.input.currentScope.epoch + 1}, {anchorDigest: "b".repeat(64)}]
				.map(scope => ({...journal, scope: {...f.input.currentScope, ...scope}}))])
			expect(f.consume(f.registration, {...f.census, currentJournal}, f.preimage, f.postAdoption)).toBeUndefined();
		for (const graphVersion of [-1, 0.5, [], NaN])
			expect(f.consume(f.registration, {...f.census, graphVersion}, f.preimage, f.postAdoption)).toBeUndefined();
	});
});

describe("ordinary cold journal observation replacement affected controls", () => {
	type Image = {control: null; image: object; canonicalRows: readonly Uint8Array[]; drainSource?: object};
	type Scope = {objectId: string; epoch: number; anchorDigest: string};
	type Owner = {accounting: ReturnType<typeof createCreatorClosedRollbackProofAccounting>; material: {
		chargeObservation(bytes: Uint8Array): boolean;
		chargeNativeReader(blob: {ref: {digest: string; byteLength: number}; bytes: Uint8Array}): boolean;
		chargeSnapshotTarget(bytes: Uint8Array, scope: object): boolean;
		captureKnownMaterial(): readonly Uint8Array[]; captureKnownProtectedMaterial(): readonly Uint8Array[];
		captureKnownMaterialUses(): readonly object[];
		captureObservationOnlyMaterial(bytes: Uint8Array): Uint8Array | undefined}};
	const owner = (): Owner => execute(`const proofMaterialOwners = new WeakMap();
		${declaration("closedRetirementEqual")}
		${declaration("createCreatorClosedRollbackProofAccounting").replace(/^export /, "")}
		const accounting = createCreatorClosedRollbackProofAccounting([]);
		({accounting, material: proofMaterialOwners.get(accounting)});`, {});
	const fields = (journal: Image): Uint8Array => execute(`${declaration("creatorIssuanceMaintenanceObservationCarriers")}
		closedRetirementBytes(creatorIssuanceMaintenanceObservationCarriers({journal,
			snapshot:null,ahe:null,floor:null,floorImage:null,snapshotInventory:null})[0]);`, {journal});
	function basis(book: Owner, identity: object, scope: Scope, journal: Image) {
		const source = unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "captureCreatorOrdinaryIssuanceProofSource");
		const names = ["journalObservation", "replaceableJournalBytes", "replaceableJournalObservation"];
		const statements: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text))
				statements.push(`const ${node.getText(parsed)};`);
			ts.forEachChild(node, visit);
		}; visit(source); expect(statements).toHaveLength(3);
		const owners = new WeakMap([[book.accounting, book.material]]);
		return execute<{identity: object; scope: Scope; bytes: Uint8Array} | undefined>(`${declaration("creatorIssuanceMaintenanceObservationCarriers")}
			${statements.join("\n")} replaceableJournalObservation;`, {proofMaterialOwners: owners,
			frame:{accounting:book.accounting}, capture:{journal,snapshot:null,ahe:null,floorImage:{state:null}},
			custody:{snapshotInventory:{scopes:[],owner:null}}, forward:{currentTrust:{objectId:scope.objectId,
				currentEpoch:scope.epoch,currentAnchorDigest:scope.anchorDigest}}, identity});
	}
	function recharged(seed: object, currentScope: Scope, book: Owner) {
		const statement = unique((node): node is ts.ForOfStatement => ts.isForOfStatement(node) &&
			node.expression.getText(parsed) === "seed.knownMaterial.entries()");
		execute(`${declaration("closedRetirementEqual")} const replaceable=seed.replaceableJournalObservation;
			let deferredRuntimeCensusObservation;
			${statement.getText(parsed)}`, {seed,currentScope,accounting:book.accounting,materialOwner:book.material,
			chargeProofObservation: (_accounting: unknown, bytes: Uint8Array) => book.material.chargeObservation(bytes),
			requireLaw: (ok: boolean, reason: string) => {if (!ok) throw Error(reason);}});
	}
	function fixture(sql: boolean) {
		const material = anchorMaterial(0), scope = material.scope;
		const parametersDigest = (decodeCanonical(material.bytes) as {parametersDigest: string}).parametersDigest;
		const other = {...scope, epoch: 1, anchorDigest: "b".repeat(64)};
		const header = (selected: Scope, next: number) => sql ? {object_id:selected.objectId,epoch:selected.epoch,anchor_digest:selected.anchorDigest,
			next_journal_sequence:next,exact_anchor_preimage:material.install.exactCanonicalAnchorPreimageBytes,
			detached_anchor_signature:material.install.detachedAnchorSignature,parameters_digest:parametersDigest,
			exact_parameters_carrier:material.install.exactCanonicalParametersCarrierBytes} : {objectId:selected.objectId,epoch:selected.epoch,
			anchorDigest:selected.anchorDigest,nextJournalSequence:next,exactCanonicalAnchorPreimageBytes:material.install.exactCanonicalAnchorPreimageBytes,
			detachedAnchorSignature:material.install.detachedAnchorSignature,parametersDigest,
			exactCanonicalParametersCarrierBytes:material.install.exactCanonicalParametersCarrierBytes};
		const table = sql ? "accepted_entries" : "acceptedEntries";
		const row = (selected: Scope, sequence: number) => sql ? {object_id:selected.objectId,epoch:selected.epoch,anchor_digest:selected.anchorDigest,
			journal_sequence:sequence,source_kind:"received",vertex_digest:"c".repeat(64),received_preimage:Uint8Array.of(sequence+1),
			received_signature:new Uint8Array(64),local_author:null,local_author_sequence:null} : {objectId:selected.objectId,epoch:selected.epoch,
			anchorDigest:selected.anchorDigest,journalSequence:sequence,sourceKind:"received",
			vertexDigest:"c".repeat(64),exactCanonicalPreimageBytes:Uint8Array.of(sequence+1),detachedSignature:new Uint8Array(64)};
		const key = (selected: Scope) => [selected.objectId,selected.epoch,selected.anchorDigest];
		const h = (selected: Scope, next: number) => journalRetirementCanonicalRow("scopes",key(selected),header(selected,next));
		const r = (selected: Scope, sequence: number) => journalRetirementCanonicalRow(table,[...key(selected),sequence],row(selected,sequence));
		const image = (canonicalRows: readonly Uint8Array[]): Image => ({control:null,image:{scopeCount:2},canonicalRows});
		return {scope,other,header,row,key,table,h,r,image,prior:image([h(scope,1),r(scope,0),h(other,1),r(other,0)]),
			present:image([h(scope,2),r(scope,0),r(scope,1),h(other,1),r(other,0)])};
	}
	const corresponds = (prior: Image, present: Image, current: Scope) => execute<Readonly<{
		currentRows: readonly import("@ts-drp/live-journal").LiveJournalAcceptedRow[];
		nativeFrames: readonly {raw: Uint8Array; frame: unknown[]; key: unknown[]; row: object}[]}> | undefined>(`${declaration("closedRetirementEqual")}
		${declaration("creatorOrdinaryJournalObservationCorresponds")}
		creatorOrdinaryJournalObservationCorresponds(prior,present,current);`, {prior,present,current,LIVE_JOURNAL_RETIREMENT_LIMITS});
	it("retains every immutable accepted/closed frame and permits only monotone current header counters under both native row spellings", () => {
		for (const sql of [false,true]) {
			const f=fixture(sql), captured=corresponds(f.prior,f.present,f.scope);
			expect(captured!.nativeFrames.map(entry => entry.raw)).toEqual(f.present.canonicalRows);
			for (const [index, entry] of captured!.nativeFrames.entries()) {
				expect(entry.raw).toBe(f.present.canonicalRows[index]);
				expect(entry.frame).toEqual(decodeCanonical(entry.raw));
				expect(entry.key).toBe(entry.frame[1]); expect(entry.row).toBe(entry.frame[2]);
			}
			expect(captured).toBeDefined(); expect(captured!.currentRows).toEqual([0,1].map(journalSequence => ({scope:f.scope,
				journalSequence,sourceKind:"received",vertexDigest:"c".repeat(64),exactCanonicalPreimageBytes:Uint8Array.of(journalSequence+1),
				detachedSignature:new Uint8Array(64)})));
			const before=encodeCanonical(f.prior), after=encodeCanonical(f.present);
			const badHeader={...f.header(f.scope,2), [sql?"parameters_digest":"parametersDigest"]:"d".repeat(64)};
			const badRow={...f.row(f.scope,0), [sql?"received_preimage":"exactCanonicalPreimageBytes"]:Uint8Array.of(9)};
			for (const rows of [f.present.canonicalRows.filter((_,index)=>index!==1),
				[...f.present.canonicalRows,f.present.canonicalRows[1]!],
				[f.h(f.scope,0),...f.present.canonicalRows.slice(1)],
				[journalRetirementCanonicalRow("scopes",f.key(f.scope),badHeader),...f.present.canonicalRows.slice(1)],
				[f.present.canonicalRows[0]!,journalRetirementCanonicalRow(f.table,[...f.key(f.scope),0],badRow),...f.present.canonicalRows.slice(2)],
				[...f.present.canonicalRows,f.r(f.other,1)],
				[f.h(f.scope,-1),...f.present.canonicalRows.slice(1)]])
				expect(corresponds(f.prior,f.image(rows),f.scope)).toBeUndefined();
			expect(corresponds(f.prior,f.present,f.other)).toBeUndefined();
			expect(encodeCanonical(f.prior)).toEqual(before); expect(encodeCanonical(f.present)).toEqual(after);
		}
	});
	it("enrolls only exact owner-produced observational-only bytes after raw/native/target annotations and detaches the private basis", () => {
		const f=fixture(true), bytes=fields(f.prior), identity={};
		const book=owner(); expect(book.material.chargeObservation(bytes)).toBe(true);
		const captured=basis(book,identity,f.scope,f.prior)!; expect(captured.identity).toBe(identity);
		expect(captured.bytes).toEqual(bytes); expect(Object.isFrozen(captured)).toBe(true);
		captured.bytes.fill(0); expect(book.material.captureObservationOnlyMaterial(bytes)).toEqual(bytes);
		for (const promote of [(b: Owner)=>b.accounting.charge(bytes),
			(b: Owner)=>b.material.chargeNativeReader({bytes,ref:{digest:"a".repeat(64),byteLength:bytes.byteLength}}),
			(b: Owner)=>b.material.chargeSnapshotTarget(bytes,{objectId:f.scope.objectId,epoch:0,anchor:f.scope.anchorDigest,manifestDigest:"b".repeat(64)})]) {
			const protectedBook=owner(); protectedBook.material.chargeObservation(bytes); promote(protectedBook);
			expect(basis(protectedBook,identity,f.scope,f.prior)).toBeUndefined();
		}
		expect(basis(owner(),identity,f.scope,f.prior)).toBeUndefined();
		const altered=f.image([...f.prior.canonicalRows,f.r(f.scope,1)]);
		expect(basis(book,identity,f.scope,altered)).toBeUndefined();
	});
	it("omits exactly the enrolled obsolete encoding in a NEW book, preserves other observations/protected siblings/UNKNOWN, and still pays the whole fresh wrapper", () => {
		const f=fixture(true), oldBytes=fields(f.prior), freshBytes=fields(f.present), raw=Uint8Array.of(1,2,3), other=encodeCanonical({other:"OBS"}), identity={};
		const cold=owner(); cold.material.chargeObservation(oldBytes); cold.accounting.charge(raw); cold.material.chargeObservation(other);
		const seed={identity,knownMaterial:cold.material.captureKnownMaterial(),knownProtectedMaterial:cold.material.captureKnownProtectedMaterial(),
			knownMaterialUses:cold.material.captureKnownMaterialUses(),
			replaceableJournalObservation:basis(cold,identity,f.scope,f.prior)};
		const before=encodeCanonical(seed.knownMaterial), paid=cold.accounting.chargedBytes;
		const fresh=owner(); fresh.accounting.chargeUnknownEncodedLength(17); recharged(seed,f.scope,fresh);
		expect(fresh.accounting.chargedBytes).toBe(17+raw.byteLength+other.byteLength);
		expect(fresh.material.chargeObservation(freshBytes)).toBe(true);
		expect(fresh.accounting.chargedBytes).toBe(17+raw.byteLength+other.byteLength+freshBytes.byteLength);
		expect(cold.accounting.chargedBytes).toBe(paid); expect(encodeCanonical(seed.knownMaterial)).toEqual(before);
		for (const changed of [{...seed,identity:{}},{...seed,knownProtectedMaterial:[raw,oldBytes]},
			{...seed,replaceableJournalObservation:undefined}]) {
			const original=owner(); recharged(changed,f.scope,original); expect(original.accounting.chargedBytes).toBe(paid);
		}
		// Actual private annotation/correspondence bodies with real codecs. These
		// controlled owner fixtures confer neither native exclusion nor crypto auth.
	});
});

describe("incremental ordinary consumer real-body custody and accounting controls", () => {
	function gate() {
		let resolve!: () => void;
		const promise = new Promise<void>(done => {resolve = done;});
		return {promise, resolve};
	}
	function fixture() {
		const path = new URL("../src/creator-close.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const nodes = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
			node.name?.text === "prepareCreatorIncrementalIssuanceMaintenanceQuote");
		if (nodes.length !== 1) throw Error(`INCREMENTAL_ORDINARY_CONSUMER_BODY:${nodes.length}`);
		const state = {proofAvailable: true, dimensionsAvailable: true, boundAvailable: true, capacityAvailable: true,
			readinessPrepared: true, sealed: 0, acquired: 0,
			dimensionError: undefined as Error | undefined, release: async () => {}};
		const calls = {checks: 0, dimensions: 0, bound: 0, capacity: 0, proofRelease: 0, runtimeRelease: 0, future: 0, effects: 0};
		const unsignedBytes = encodeCanonical({kind: "controlled-current-candidate"}), source = Object.freeze({}),
			dimensions = Object.freeze({kind: "controlled-enrolled-current-dimensions"}), hold = Object.freeze({}),
			trust = Object.freeze({profileId: "creator-trusted-v1"}), receipt = Object.freeze({});
		const knownCarriers = [encodeCanonical({known: "current-reader-a"}), encodeCanonical({known: "current-reader-b"})],
			unknownEncodedLengths = [13, 5], accounting = createCreatorClosedRollbackProofAccounting([]), image = "a".repeat(64);
		let received = false;
		const proof = {
			accounting, readIssuanceContext: () => Object.freeze({expectedIssuanceImageDigest: image, expectedIssuanceControlBytes: null}),
			check: async () => {calls.checks++;},
			readReceivedAppendSizing: (bytes: Uint8Array) => {expect(bytes).toBe(unsignedBytes); return received ? receipt : undefined;},
			readCurrentDimensions: async (bytes: Uint8Array) => {
				calls.dimensions++; expect(bytes).toBe(unsignedBytes);
				if (state.dimensionError !== undefined) throw state.dimensionError;
				return state.dimensionsAvailable ? dimensions : undefined;
			},
			release: async () => {calls.proofRelease++; await state.release();},
			beginWrite: async () => {calls.effects++;},
			beginReceivedAppend: async (bytes: Uint8Array) => {expect(bytes).toBe(unsignedBytes); calls.effects++;},
		};
		const future = () => {calls.future++; throw Error("INCREMENTAL_ORDINARY_ENTERED_FUTURE_PREPARATION");};
		const reader = () => undefined, input = {promotionContext: {controlledContext: true}, snapshotStore: {},
			storageIncarnation: "controlled-incarnation", readOrdinaryApplicationResourceBound: reader,
			prospectiveSettlementPreview: future};
		const registration = {objectId: "controlled-object", store: {}, liveJournalStore: {}, currentTrust: trust,
			sealOrdinaryIssuanceMaintenanceRuntime: async (actualReceipt?: object) => {
				state.sealed++;
				expect(actualReceipt).toBe(received ? receipt : undefined); return hold;
			}, previewOrdinaryIssuanceClose: future, prepareIssuanceContinuation: future,
			readProspectiveRuntimeCensusOverhead: future, readProspectivePostAdoptionCensusSizing: future};
		const runtime = {release: async () => {calls.runtimeRelease++; await state.release();}};
		type Quote = {kind: "incremental"; proof: typeof proof; context: {
			expectedIssuanceImageDigest: string; expectedIssuanceControlBytes: Uint8Array | null}};
		const run = execute<(registration: object, input: object, bytes: Uint8Array, source: object, receipt?: object,
			onSourceUnavailable?: () => void) => Promise<Quote | undefined>>(
			`${nodes[0]!.getText(file)}\nprepareCreatorIncrementalIssuanceMaintenanceQuote;`, {
				creatorOrdinaryIssuanceSourceReadinessPrepared: (actualSource: object, actualReader: unknown) => {
					expect(actualSource).toBe(source); expect(actualReader).toBe(reader); return state.readinessPrepared;
				},
				readCreatorOrdinaryPreimageCapacityForSizing: (bytes: Uint8Array) => {expect(bytes).toBe(unsignedBytes); return {};},
				resolveCreatorOrdinaryIssuanceRuntimeHold: (actualHold: object, owners: object) => {
					expect(actualHold).toBe(hold); expect(owners).toEqual({store: registration.store,
						liveJournalStore: registration.liveJournalStore, currentTrust: trust}); return runtime;
				},
				releaseCreatorOrdinaryIssuanceRuntimeHold: future,
				acquireCreatorOrdinaryIssuanceMaintenanceProof: async (actualInput: object, actualHold: object, actualTrust: object, actualSource: object) => {
					state.acquired++;
					expect(actualInput).toEqual({...input.promotionContext, objectId: registration.objectId, store: registration.store,
						snapshotStore: input.snapshotStore, liveJournalStore: registration.liveJournalStore});
					expect(actualHold).toBe(hold); expect(actualTrust).toBe(trust); expect(actualSource).toBe(source);
					return state.proofAvailable ? proof : undefined;
				},
				reserveCreatorOrdinaryFinishingCapacity: async (actualProof: typeof proof, bytes: Uint8Array, options: object) => {
					expect(actualProof).toBe(proof); expect(bytes).toBe(unsignedBytes);
					expect(options).toEqual({reader, storageIncarnation: input.storageIncarnation, actualProducerChunkBytes: 131_072});
					// The consumer calls one checked+charged owner. Keep all three
					// controlled provisional stages and their original miss/error
					// outcomes; this stub does not claim native delivery currency.
					await actualProof.check();
					try {
					const actualDimensions = await actualProof.readCurrentDimensions(bytes);
					if (actualDimensions === undefined) return undefined;
					expect(actualDimensions).toBe(dimensions); calls.bound++;
					if (!state.boundAvailable) return undefined;
					calls.capacity++;
					if (!state.capacityAvailable) return undefined;
					for (const bytes of knownCarriers)
						if (!actualProof.accounting.charge(bytes)) throw new TypeError("creator incremental proof reserve is exhausted");
					for (const length of unknownEncodedLengths)
						if (!actualProof.accounting.chargeUnknownEncodedLength(length)) throw new TypeError("creator incremental proof reserve is exhausted");
					return {knownCarriers, unknownEncodedLengths};
					} finally { await actualProof.check(); }
				},
				encodeIssuanceRetirementControl: future, prepareProspectiveCreatorCloseMaterial: future,
				prepareProspectiveCreatorCloseMaterialFromPreview: future, prospectiveCreatorMetadataWidths: future,
				prospectiveCreatorAdoptionBytes: future, readProspectiveCreatorMaintenancePrefixesForSizing: future,
			});
		// Genuine consumer body + original accounting owner. Controlled dependency
		// bindings are not evidence of native authentication or numeric soundness.
		return {run: (isReceived = false, onSourceUnavailable?: () => void) => {received = isReceived;
			return run(registration, input, unsignedBytes, source, received ? receipt : undefined, onSourceUnavailable);},
			state, calls, proof, accounting, knownCarriers, unknownEncodedLengths, unsignedBytes, image};
	}
	it("local and received positives retain their exact proof, charge the same book and leave effects to the returned owner", async () => {
		for (const received of [false, true]) {
			const f = fixture(), quote = await f.run(received);
			expect(quote).toBeDefined(); expect(quote!.kind).toBe("incremental"); expect(quote!.proof).toBe(f.proof);
			expect(quote!.context).toEqual({expectedIssuanceImageDigest: f.image, expectedIssuanceControlBytes: null});
			expect(Object.isFrozen(quote)).toBe(true); expect(Object.isFrozen(quote!.context)).toBe(true);
			expect(f.accounting.chargedBytes).toBe(f.knownCarriers.reduce((sum, bytes) => sum + bytes.byteLength, 0) + 18);
			expect(f.calls).toEqual({checks: 2, dimensions: 1, bound: 1, capacity: 1, proofRelease: 0, runtimeRelease: 0, future: 0, effects: 0});
			if (received) await quote!.proof.beginReceivedAppend(f.unsignedBytes); else await quote!.proof.beginWrite();
			expect(f.calls.effects).toBe(1); await quote!.proof.release(); expect(f.calls.proofRelease).toBe(1);
		}
	});
	it("keeps an unprepared numerical source without native acquisition, false source invalidation or lazy future construction", async () => {
		for (const received of [false, true]) {
			const f = fixture(); f.state.readinessPrepared = false;
			let invalidations = 0;
			for (let attempt = 0; attempt < 2; attempt++)
				expect(await f.run(received, () => {invalidations++;})).toBeUndefined();
			expect(f.state.sealed).toBe(0); expect(f.state.acquired).toBe(0); expect(invalidations).toBe(0);
			expect(f.accounting.chargedBytes).toBe(0); expect(f.calls.future).toBe(0); expect(f.calls.effects).toBe(0);
			// Controlled explicit boundary preparation, not a getter-created grant.
			f.state.readinessPrepared = true;
			expect((await f.run(received))?.kind).toBe("incremental");
			expect(f.state.sealed).toBe(1); expect(f.state.acquired).toBe(1);
		}
	});
	it("unavailable proof, dimensions, application bound or numerical bound joins before an uncharged fallback", async () => {
		for (const unavailable of ["proofAvailable", "dimensionsAvailable", "boundAvailable", "capacityAvailable"] as const) {
			const f = fixture(), entered = gate(), joined = gate(); f.state[unavailable] = false;
			f.state.release = async () => {entered.resolve(); await joined.promise;};
			let settled = false; const pending = f.run().then(value => {settled = true; return value;});
			await entered.promise; expect(settled).toBe(false); expect(f.accounting.chargedBytes).toBe(0);
			expect(f.calls.effects).toBe(0); expect(f.calls.future).toBe(0);
			joined.resolve(); expect(await pending).toBeUndefined();
			expect(f.calls.proofRelease).toBe(unavailable === "proofAvailable" ? 0 : 1);
			expect(f.calls.runtimeRelease).toBe(unavailable === "proofAvailable" ? 1 : 0);
		}
	});
	it("known and UNKNOWN exhaustion refuse without external effects and join before exposing the failure", async () => {
		for (const exhausted of ["known", "UNKNOWN"] as const) {
			const f = fixture(), knownBytes = f.knownCarriers.reduce((sum, bytes) => sum + bytes.byteLength, 0),
				entered = gate(), joined = gate();
			expect(f.accounting.chargeUnknownEncodedLength(f.accounting.maxBytes - (exhausted === "known" ? 0 : knownBytes))).toBe(true);
			f.state.release = async () => {entered.resolve(); await joined.promise;};
			let settled = false; const pending = f.run().then(() => {settled = true; return undefined;}, error => {settled = true; return error as Error;});
			await entered.promise; expect(settled).toBe(false); expect(f.accounting.chargedBytes).toBe(f.accounting.maxBytes);
			expect(f.calls.effects).toBe(0); expect(f.calls.future).toBe(0); expect(f.calls.checks).toBe(2);
			joined.resolve(); expect((await pending)?.message).toBe("creator incremental proof reserve is exhausted");
			expect(f.calls.proofRelease).toBe(1); expect(f.calls.runtimeRelease).toBe(0);
		}
	});
	it("invalidates only an unavailable fresh source after joined cleanup, never an inconclusive bound or failed join", async () => {
		for (const unavailable of ["proofAvailable", "dimensionsAvailable", "boundAvailable", "capacityAvailable"] as const) {
			const f = fixture(), entered = gate(), joined = gate(); f.state[unavailable] = false;
			f.state.release = async () => {entered.resolve(); await joined.promise;};
			let invalidations = 0;
			const pending = f.run(false, () => {invalidations++;});
			await entered.promise; expect(invalidations).toBe(0); expect(f.accounting.chargedBytes).toBe(0);
			joined.resolve(); expect(await pending).toBeUndefined();
			expect(invalidations).toBe(unavailable === "proofAvailable" ? 1 : 0);
			expect(f.calls.future).toBe(0); expect(f.calls.effects).toBe(0);
		}
		const exhausted = fixture(); expect(exhausted.accounting.chargeUnknownEncodedLength(exhausted.accounting.maxBytes)).toBe(true);
		let exhaustedInvalidations = 0;
		await expect(exhausted.run(false, () => {exhaustedInvalidations++;})).rejects.toThrow("creator incremental proof reserve is exhausted");
		expect(exhaustedInvalidations).toBe(0); expect(exhausted.calls.proofRelease).toBe(1);
		expect(exhausted.calls.future).toBe(0); expect(exhausted.calls.effects).toBe(0);
		const failed = fixture(), cleanup = new Error("controlled source cleanup failure");
		failed.state.proofAvailable = false; failed.state.release = async () => {throw cleanup;};
		let invalidations = 0;
		await expect(failed.run(false, () => {invalidations++;})).rejects.toBe(cleanup);
		expect(invalidations).toBe(0); expect(failed.calls.runtimeRelease).toBe(1);
		expect(failed.accounting.chargedBytes).toBe(0); expect(failed.calls.future).toBe(0); expect(failed.calls.effects).toBe(0);
	});
	it("preserves primary and cleanup causes, and never retries an already failing decline join", async () => {
		const primary = new Error("controlled dimension read failure"), cleanup = new Error("controlled proof join failure");
		for (const decline of [false, true]) {
			const f = fixture(); f.state.release = async () => {throw cleanup;};
			if (decline) f.state.dimensionsAvailable = false; else f.state.dimensionError = primary;
			const result = await f.run().then(() => undefined, error => error as unknown);
			if (decline) expect(result).toBe(cleanup);
			else {expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors).toEqual([primary, cleanup]);
				expect((result as AggregateError).cause).toBe(primary);}
			expect(f.calls.proofRelease).toBe(1); expect(f.calls.runtimeRelease).toBe(0);
			expect(f.accounting.chargedBytes).toBe(0); expect(f.calls.effects).toBe(0); expect(f.calls.future).toBe(0);
		}
	});
});

describe("ordinary source prime joined lifecycle without future preparation", () => {
	function originalRefusalOwner() {
		const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const original = (name: string) => {
			const nodes = file.statements.filter(node =>
				(ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name);
			if (nodes.length !== 1) throw Error(`ORDINARY_SOURCE_REFUSAL_OWNER:${name}:${nodes.length}`);
			return nodes[0]!.getText(file).replace(/^export /, "");
		};
		return execute<{isCapacityRefusal(value: unknown): boolean; refusal(kind: string): object}>(
			`${original("failure")}\n${original("Refusal")}\n${original("isCreatorOrdinarySourceCapacityRefusal")}
			({isCapacityRefusal:isCreatorOrdinarySourceCapacityRefusal,refusal:(kind)=>new Refusal(failure(kind))});`, {});
	}
	function deferred<T>() {
		let resolve!: (value: T | PromiseLike<T>) => void;
		const promise = new Promise<T>(done => {resolve = done;});
		return {promise, resolve};
	}
	function fixture(capture: (proof: object) => Promise<object | undefined>, release: () => Promise<void>,
		acquisition?: (proof: object) => Promise<object>) {
		const path = new URL("../src/creator-close.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
			readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const nodes = file.statements.filter((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "captureCreatorOrdinarySourceWithoutForecast");
		if (nodes.length !== 1) throw Error(`ORDINARY_SOURCE_PRIME_BODY:${nodes.length}`);
		const nominal = originalRefusalOwner();
		const calls = {seal: 0, acquire: 0, capture: 0, release: 0, future: 0, publicCheck: 0};
		const future = () => {calls.future++; throw Error("ORDINARY_SOURCE_PRIME_ENTERED_FUTURE_PREPARATION");};
		const proof = {
			release: async () => {calls.release++; await release();},
			check: () => {calls.publicCheck++; throw Error("COLD_PROOF_HAS_NO_PUBLIC_WARM_CHECK");},
		};
		const hold = Object.freeze({kind: "controlled-original-cold-hold"}), receipt = Object.freeze({}),
			trust = Object.freeze({currentEpoch: 0}), store = {}, journal = {}, snapshot = {};
		const input = {promotionContext: {controlledContext: true}, snapshotStore: snapshot,
			readOrdinaryApplicationResourceBound: () => undefined, prospectiveSettlementPreview: future};
		const registration = {objectId: "prime-object", store, liveJournalStore: journal, currentTrust: trust,
			sealIssuanceMaintenanceDependencies: async (actualReceipt?: object) => {
				calls.seal++; expect(actualReceipt).toBe(receipt); return hold;
			},
			prepareIssuanceContinuation: future, readProspectiveRuntimeCensusOverhead: future,
			readProspectivePostAdoptionCensusSizing: future};
		const run = execute<(registration: object, input: object, receipt?: object) => Promise<object | undefined>>(
			`${nodes[0]!.getText(file)}\ncaptureCreatorOrdinarySourceWithoutForecast;`, {
				acquireCreatorIssuanceMaintenanceProof: async (actualInput: object, actualHold: object, actualTrust: object) => {
					calls.acquire++; expect(actualInput).toEqual({...input.promotionContext, objectId: registration.objectId,
						store, snapshotStore: snapshot, liveJournalStore: journal});
					expect(actualHold).toBe(hold); expect(actualTrust).toBe(trust);
					return acquisition === undefined ? proof : await acquisition(proof);
				},
				isCreatorOrdinarySourceCapacityRefusal: nominal.isCapacityRefusal,
				captureCreatorOrdinaryIssuanceProofSource: async (actualProof: object) => {
					calls.capture++; expect(actualProof).toBe(proof); return capture(actualProof);
				},
				prepareProspectiveCreatorCloseMaterial: future, prospectiveCreatorMetadataWidths: future,
				readProspectiveCreatorMaintenancePrefixesForSizing: future,
			});
		// These bindings test the real consumer function's lifecycle, not native
		// authenticity or transitive behavior inside the separately tested owners.
		return {run: () => run(registration, input, receipt), calls, nominal};
	}
	it("classifies only the original nominal proof-budget refusal, never plain results or cleanup aggregates", () => {
		const owner = originalRefusalOwner(), capacity = owner.refusal("proof-budget-exceeded");
		expect(owner.isCapacityRefusal(capacity)).toBe(true);
		for (const value of [{ok: false, kind: "proof-budget-exceeded"}, {result: {ok: false, kind: "proof-budget-exceeded"}},
			new Error("proof-budget-exceeded"), owner.refusal("chain-invalid"), owner.refusal("floor-stale"),
			new AggregateError([capacity, new Error("controlled native cleanup failure")], "joined acquisition failed", {cause: capacity})])
			expect(owner.isCapacityRefusal(value)).toBe(false);
	});
	it("optional capacity priming resolves unavailable only after the acquisition owner joins its cold readers", async () => {
		const entered = deferred<void>(), joined = deferred<void>(); let acquisitionJoins = 0;
		const f = fixture(async () => {throw Error("CAPACITY_REFUSAL_MUST_NOT_CAPTURE_SOURCE");}, async () => {}, async () => {
			acquisitionJoins++; entered.resolve(); await joined.promise; throw refusal;
		}), refusal = f.nominal.refusal("proof-budget-exceeded");
		let settled = false; const pending = f.run().then(value => {settled = true; return value;});
		await entered.promise; expect(settled).toBe(false); expect(acquisitionJoins).toBe(1);
		joined.resolve(); expect(await pending).toBeUndefined();
		expect(f.calls).toEqual({seal: 1, acquire: 1, capture: 0, release: 0, future: 0, publicCheck: 0});
	});
	it("propagates acquisition authentication, stale currency and cleanup failure instead of treating them as capacity misses", async () => {
		for (const kind of ["chain-invalid", "floor-stale", "cleanup-aggregate"] as const) {
			const entered = deferred<void>(), joined = deferred<void>(); let acquisitionJoins = 0;
			const f = fixture(async () => {throw Error("FAILED_ACQUISITION_MUST_NOT_CAPTURE_SOURCE");}, async () => {}, async () => {
				acquisitionJoins++; entered.resolve(); await joined.promise; throw failure;
			});
			const capacity = f.nominal.refusal("proof-budget-exceeded"), cleanup = Error("controlled native cleanup failure"),
				failure = kind === "cleanup-aggregate"
					? new AggregateError([capacity, cleanup], "original acquisition and joined cleanup failed", {cause: capacity})
					: f.nominal.refusal(kind);
			let settled = false; const pending = f.run().then(() => {settled = true; return undefined;}, error => {settled = true; return error as unknown;});
			await entered.promise; expect(settled).toBe(false); joined.resolve(); expect(await pending).toBe(failure);
			expect(acquisitionJoins).toBe(1);
			expect(f.calls).toEqual({seal: 1, acquire: 1, capture: 0, release: 0, future: 0, publicCheck: 0});
		}
	});
	it("returns the original captured source only after cold release joins, without preview or future constructors", async () => {
		const entered = deferred<void>(), joined = deferred<void>(), source = Object.freeze({}),
			f = fixture(async () => source, async () => {entered.resolve(); await joined.promise;});
		let settled = false;
		const pending = f.run().then(value => {settled = true; return value;});
		await entered.promise;
		expect(settled).toBe(false);
		expect(f.calls).toEqual({seal: 1, acquire: 1, capture: 1, release: 1, future: 0, publicCheck: 0});
		joined.resolve(); expect(await pending).toBe(source);
		expect(settled).toBe(true); expect(f.calls.release).toBe(1);
	});
	it("joins cold release for unavailable and throwing source capture before resolving or rejecting", async () => {
		for (const primary of [undefined, new Error("controlled source capture failure")]) {
			const entered = deferred<void>(), joined = deferred<void>(), f = fixture(async () => {
				if (primary !== undefined) throw primary; return undefined;
			}, async () => {entered.resolve(); await joined.promise;});
			let settled = false;
			const pending = f.run().then(value => {settled = true; return {value};}, error => {settled = true; return {error};});
			await entered.promise; expect(settled).toBe(false); joined.resolve();
			const result = await pending;
			if (primary === undefined) expect(result).toEqual({value: undefined});
			else expect("error" in result && result.error).toBe(primary);
			expect(f.calls).toEqual({seal: 1, acquire: 1, capture: 1, release: 1, future: 0, publicCheck: 0});
		}
	});
	it("propagates cleanup failure and preserves both primary and joined-cleanup causes", async () => {
		const cleanup = new Error("controlled cold release failure"), primary = new Error("controlled source capture failure");
		for (const captureError of [undefined, primary]) {
			const f = fixture(async () => {if (captureError !== undefined) throw captureError; return undefined;},
				async () => {throw cleanup;});
			const result = await f.run().then(() => undefined, error => error as unknown);
			if (captureError === undefined) expect(result).toBe(cleanup);
			else {
				expect(result).toBeInstanceOf(AggregateError);
				expect((result as AggregateError).errors).toEqual([primary, cleanup]);
				expect((result as AggregateError).cause).toBe(primary);
			}
			expect(f.calls).toEqual({seal: 1, acquire: 1, capture: 1, release: 1, future: 0, publicCheck: 0});
		}
	});

	describe("joined ordinary source refresh consumer", () => {
		type Attempt = "hit" | "numerical" | "source" | Error;
		function consumerFixture(attempts: readonly Attempt[], options: {
			firstJoin?: Promise<void>; entered?: () => void; refreshUnavailable?: boolean;
			primeError?: Error; chargeError?: Error; initiallyMissing?: boolean; initiallyReady?: boolean;
			windowAdmission?: boolean;
		} = {}) {
			const path = new URL("../src/creator-close.ts", import.meta.url), file = ts.createSourceFile(path.pathname,
				readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			const gates: ts.IfStatement[] = [];
			const visit = (node: ts.Node): void => {
				if (ts.isIfStatement(node) && node.expression.getText(file).startsWith("ordinaryDomain &&") &&
					node.expression.getText(file).includes("input.readOrdinaryApplicationResourceBound !== undefined") &&
					node.expression.getText(file).includes('registration.currentTrust.profileId === "creator-trusted-v1"')) gates.push(node);
				ts.forEachChild(node, visit);
			};
			visit(file);
			if (gates.length !== 1 || !ts.isBlock(gates[0]!.parent)) throw Error("ORDINARY_REFRESH_CONSUMER_NOT_UNIQUE");
			const siblings = (gates[0]!.parent as ts.Block).statements, start = siblings.indexOf(gates[0]!);
			const selected = siblings.slice(start, start + 5);
			if (selected.length !== 5 || !selected.every(ts.isIfStatement) ||
				selected[1]!.expression.getText(file) !== "quote === undefined && suffix !== undefined" ||
				selected[2]!.expression.getText(file) !== "quote === undefined && ordinaryDomain && newWindowAdmission" ||
				selected[3]!.expression.getText(file) !== "quote === undefined && ordinaryDomain && ordinaryTemplateReady && ordinaryProofSource !== undefined" ||
				selected[4]!.expression.getText(file) !== "quote === undefined") throw Error("ORDINARY_REFRESH_FALLBACK_SIBLINGS_CHANGED");
			// Execute the exact incremental/backpressure/warm/cold siblings.
			// Controlled owner seams test flow/argument identity, not authentication
			// or fresh native accounting, which remain the original owners' duties.
			const consumer = selected.map(node => node.getText(file)).join("\n");
			const oldSource = Object.freeze({bytes: Uint8Array.of(91)}), freshSource = Object.freeze({bytes: Uint8Array.of(92)});
			const registration = Object.freeze({currentTrust: Object.freeze({profileId: "creator-trusted-v1"})}),
				input = Object.freeze({readOrdinaryApplicationResourceBound: () => undefined}),
				unsignedBytes = Uint8Array.of(93), receipt = Object.freeze({});
			const calls = {prime: 0, incremental: 0, warm: 0, cold: 0, charge: 0};
			const events: string[] = [], sources: unknown[] = [], quotes: any[] = [];
			const makeQuote = () => Object.freeze({proof: Object.freeze({accounting: Object.freeze({}), authority: Object.freeze({})}),
				context: Object.freeze({bytes: Uint8Array.of(94)})});
			const cold = makeQuote(), initialSource = options.initiallyMissing ? undefined : oldSource;
			const run = () => execute<Promise<{quote: any; source: unknown; templateReady: boolean}>>([
				"(async () => { let ordinaryProofSource = initialSource, ordinaryTemplateReady = initiallyReady, quote;",
				consumer, "return {quote, source: ordinaryProofSource, templateReady: ordinaryTemplateReady}; })();",
			].join("\n"), {
				initialSource, initiallyReady: options.initiallyReady ?? false, ordinaryDomain: true,
				suffix: undefined, newWindowAdmission: options.windowAdmission ?? false,
				registration, input, unsignedBytes, receivedReceipt: receipt, planEffect: undefined,
				report: () => undefined,
				// The job's host checkpoint between cold quote spans; its budget never expires here.
				cooperate: async () => undefined,
				captureCreatorOrdinarySourceWithoutForecast: async (...args: unknown[]) => {
					expect(args).toEqual([registration, input, receipt]); calls.prime++; events.push("prime");
					if (options.primeError !== undefined) throw options.primeError;
					return options.refreshUnavailable ? undefined : freshSource;
				},
				prepareCreatorIncrementalIssuanceMaintenanceQuote: async (...args: unknown[]) => {
					expect(args.slice(0, 3)).toEqual([registration, input, unsignedBytes]); expect(args[4]).toBe(receipt);
					expect(args).toHaveLength(7); expect(typeof args[5]).toBe("function"); expect(args[6]).toBeUndefined();
					const index = calls.incremental++; sources.push(args[3]); events.push("incremental:" + index);
					const quote = makeQuote(); quotes.push(quote);
					const result = attempts[index];
					if (result === undefined) throw Error("UNEXPECTED_INCREMENTAL_RETRY_LOOP");
					if (result instanceof Error) throw result; // Thrown failures are not the owner callback.
					if (result === "source") {
						if (index === 0) {options.entered?.(); await options.firstJoin;}
						events.push("joined:" + index); (args[5] as () => void)();
					}
					return result === "hit" ? quote : undefined;
				},
				prepareCreatorOrdinaryIssuanceMaintenanceQuote: async () => {calls.warm++; throw Error("UNEXPECTED_OLD_TEMPLATE_READMISSION");},
				prepareCreatorIssuanceMaintenanceQuote: async (...args: unknown[]) => {
					expect(args).toEqual([registration, input, unsignedBytes, undefined, receipt]);
					calls.cold++; events.push("cold"); return cold;
				},
				captureCreatorOrdinaryIssuanceProofSource: () => {throw Error("UNEXPECTED_COLD_SOURCE_RECAPTURE");},
				chargeCreatorIssuanceMaintenanceQuote: async (...args: unknown[]) => {
					expect(args.slice(0, 3)).toEqual([cold, unsignedBytes, undefined]); calls.charge++; events.push("charge");
					if (options.chargeError !== undefined) throw options.chargeError;
					return false;
				},
			});
			return {run, calls, events, sources, quotes, oldSource, freshSource, cold, unsignedBytes, receipt};
		}
		it("does not refresh on a numerical miss and retains the original exact fallback", async () => {
			const f = consumerFixture(["numerical"]), result = await f.run();
			expect(result.quote).toBe(f.cold); expect(result.source).toBe(f.oldSource);
			expect(f.calls).toEqual({prime: 0, incremental: 1, warm: 0, cold: 1, charge: 1});
			expect(f.events).toEqual(["incremental:0", "cold", "charge"]);
		});
		it("refuses a prepared-window numerical miss before the unprepared exact fallback", async () => {
			const f = consumerFixture(["numerical"], {windowAdmission: true});
			await expect(f.run()).rejects.toThrow("requires explicit boundary maintenance before admission");
			expect(f.calls).toEqual({prime: 0, incremental: 1, warm: 0, cold: 0, charge: 0});
		});
		it("waits for joined source invalidation then refreshes and retries once with no old proof or book argument", async () => {
			const entered = deferred<void>(), joined = deferred<void>(),
				f = consumerFixture(["source", "hit"], {entered: () => entered.resolve(), firstJoin: joined.promise, initiallyReady: true});
			let settled = false; const pending = f.run().then(value => {settled = true; return value;});
			await entered.promise;
			expect(settled).toBe(false); expect(f.calls.prime).toBe(0); expect(f.calls.incremental).toBe(1);
			joined.resolve(); const result = await pending;
			expect(result.quote).toBe(f.quotes[1]); expect(result.source).toBe(f.freshSource); expect(result.templateReady).toBe(false);
			expect(f.events).toEqual(["incremental:0", "joined:0", "prime", "incremental:1"]);
			expect(f.sources).toEqual([f.oldSource, f.freshSource]);
			expect(f.quotes[1].proof).not.toBe(f.quotes[0].proof);
			expect(f.quotes[1].proof.accounting).not.toBe(f.quotes[0].proof.accounting);
			expect(f.quotes[1].proof.authority).not.toBe(f.quotes[0].proof.authority);
			expect(f.calls).toEqual({prime: 1, incremental: 2, warm: 0, cold: 0, charge: 0});
			expect(f.oldSource.bytes).toEqual(Uint8Array.of(91)); expect(f.freshSource.bytes).toEqual(Uint8Array.of(92));
			for (const quote of f.quotes) {expect(Object.isFrozen(quote)).toBe(true); expect(quote.context.bytes).toEqual(Uint8Array.of(94));}
		});
		it("a second source or numerical miss uses the old exact fallback without looping", async () => {
			for (const second of ["source", "numerical"] as const) {
				const f = consumerFixture(["source", second], {initiallyReady: true}), result = await f.run();
				expect(result.quote).toBe(f.cold); expect(result.templateReady).toBe(false);
				expect(result.source).toBe(second === "source" ? undefined : f.freshSource);
				expect(f.calls).toEqual({prime: 1, incremental: 2, warm: 0, cold: 1, charge: 1});
				expect(f.sources).toEqual([f.oldSource, f.freshSource]);
				expect(f.cold.proof.accounting).not.toBe(f.quotes[0].proof.accounting);
				expect(f.cold.proof.accounting).not.toBe(f.quotes[1].proof.accounting);
			}
		});
		it("an unavailable refreshed source falls back without a second incremental admission", async () => {
			const f = consumerFixture(["source"], {refreshUnavailable: true, initiallyReady: true}), result = await f.run();
			expect(result.quote).toBe(f.cold); expect(result.source).toBeUndefined();
			expect(f.calls).toEqual({prime: 1, incremental: 1, warm: 0, cold: 1, charge: 1});
		});
		it("propagates thrown authentication, store, charge and joined failures without recapture", async () => {
			for (const primary of [new Error("authentication failure"), new Error("store closed"), new Error("proof reserve exhausted"),
				new AggregateError([new Error("primary"), new Error("join")], "uncertain joined release")]) {
				const f = consumerFixture([primary]);
				await expect(f.run()).rejects.toBe(primary);
				expect(f.calls).toEqual({prime: 0, incremental: 1, warm: 0, cold: 0, charge: 0});
			}
		});
		it("propagates initial or refreshed source acquisition failures instead of retrying or falling back", async () => {
			for (const initiallyMissing of [false, true]) {
				const primary = new AggregateError([new Error("auth"), new Error("join")], "source capture failure"),
					f = consumerFixture(["source"], {primeError: primary, initiallyMissing});
				await expect(f.run()).rejects.toBe(primary);
				expect(f.calls).toEqual({prime: 1, incremental: initiallyMissing ? 0 : 1, warm: 0, cold: 0, charge: 0});
			}
		});
		it("propagates exact fallback charge failure without refreshing or reusing a previous book", async () => {
			const primary = new Error("exact charge refusal"), f = consumerFixture(["numerical"], {chargeError: primary});
			await expect(f.run()).rejects.toBe(primary);
			expect(f.calls).toEqual({prime: 0, incremental: 1, warm: 0, cold: 1, charge: 1});
			expect(f.cold.proof.accounting).not.toBe(f.quotes[0].proof.accounting);
		});
	});
});
