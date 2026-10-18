import { ed25519 } from "@noble/curves/ed25519.js";
import { build } from "esbuild";
import {
	aheRetirementGenerationIdentity,
	type AheRetirementPreparation,
	type BlobDigest,
	type NativeReadReservation,
	decodeAheRetirementControl,
	decodeGenerationRecordV1,
	digestBlob,
	encodeAheRetirementControl,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import archived from "../../../tests/fixtures/phase-3a1b-p4/material.json" with { type: "json" };
import {
	d109cBoundedCheckpoint,
	d109cGenerationId,
} from "../../../tests/fixtures/phase-6b/ahe-reclamation-contract.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../../canonical/dist/src/index.js";
import {
	journalFutureAppendPostimageWidths,
	encodeJournalRetirementControl,
	encodeJournalRetirementNativeCarriers,
	decodeJournalRetirementNativeCarriers,
	journalRetirementNativeProgressFields,
	captureJournalRetirementDrainPlan,
	createJournalRetirementControlRead,
	createJournalRetirementControlCodec,
	journalRetirementRowCharge,
	journalRetirementCanonicalRow,
	createJournalRetirementImageCapture,
	type JournalFutureNativeWidths,
	journalRetirementFrameDigest,
	journalRetirementImage,
	reconstructJournalRetirementDrainSource,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES,
} from "../../live-journal/src/index.js";
import { createSqliteAheDurableStore } from "../src/index.js";
import { createNodeDurableLiveJournalStore } from "../src/live-journal.js";
import type { LiveJournalRetirementImageReader } from "@ts-drp/live-journal";

test("journal invocation capture preserves original SQL image, frames, NULLs and detached lifetimes", () => {
	const capture = createJournalRetirementImageCapture(), source = Uint8Array.of(7, 9),
		scope = {object_id: "room", epoch: 2, anchor_digest: "a", next_journal_sequence: 1,
			exact_anchor_preimage: source, closed_membership_bytes: null},
		row = {object_id: "room", epoch: 2, anchor_digest: "a", journal_sequence: 0,
			source_kind: "received", received_preimage: source, vertex_digest: null, local_author: null},
		key = ["room", 2, "a"], expectedImage = journalRetirementImage([scope], [row]);
	const scopeFrame = capture.append("scopes", scope, key), rowFrame = capture.append("accepted_entries", row, [...key, 0]);
	expect(scopeFrame).toEqual(journalRetirementCanonicalRow("scopes", key, scope));
	expect(rowFrame).toEqual(journalRetirementCanonicalRow("accepted_entries", [...key, 0], row));
	source.fill(99); scopeFrame!.fill(0); rowFrame!.fill(0);
	expect(capture.finish()).toEqual(expectedImage);
	expect(() => capture.finish()).toThrow("retirement-released");
	expect(() => capture.append("scopes", scope)).toThrow("retirement-released");
	capture.release();
});

test("journal invocation capture defers RAW depth until after standalone rows and preserves malformed refusals", () => {
	let nested: unknown = null;
	for (let i = 0; i < 14; i++) nested = [nested];
	const deep = {payload: nested}, capture = createJournalRetirementImageCapture();
	expect(() => journalRetirementRowCharge(deep)).not.toThrow();
	capture.append("accepted_entries", deep);
	expect(() => capture.finish()).toThrow("canonical value exceeds maximum nesting depth");
	expect(() => journalRetirementImage([], [deep])).toThrow("canonical value exceeds maximum nesting depth");
	const later = createJournalRetirementImageCapture();
	later.append("accepted_entries", deep);
	expect(() => later.append("accepted_entries", {bad: Infinity})).toThrow("NaN and Infinity are outside the canonical domain");
	expect(() => later.finish()).toThrow("retirement-released");
	const outcome = (run: () => unknown) => {try {run(); return null;} catch (error) {
		return error instanceof Error ? [error.constructor.name, error.message] : error;
	}};
	class Outside { value = 1; }
	for (const row of [{bad: "\ud800"}, new Outside(), {payload: new Array(129).fill(null)},
		Object.defineProperty({}, "bad", {enumerable: true, get() {throw Error("not called");}})]) {
		const owner = createJournalRetirementImageCapture();
		expect(outcome(() => owner.append("accepted_entries", row))).toEqual(outcome(() => journalRetirementRowCharge(row)));
		owner.release();
	}
});

test("journal invocation capture enforces original whole-image byte ceiling after standalone charge", () => {
	const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
	let row = {object_id: "room", payload: new Uint8Array(limit - 200)};
	const overhead = encodeCanonical({scopes: [], rows: [row]}).byteLength - row.payload.byteLength;
	row = {...row, payload: new Uint8Array(limit - overhead + 1)};
	expect(journalRetirementRowCharge(row)).toBeLessThanOrEqual(limit);
	expect(() => journalRetirementImage([], [row])).toThrow("retirement-fenced");
	const capture = createJournalRetirementImageCapture(); capture.append("accepted_entries", row);
	expect(() => capture.finish()).toThrow("retirement-fenced");
	expect(() => capture.finish()).toThrow("retirement-released");
});

test("journal held current probe uses exact producer custody and fresh native checks without image recapture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-held-probe-"));
	const filename = join(directory, "journal.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	const current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	let lease: NativeReadReservation | undefined;
	const originalPrepare = DatabaseSync.prototype.prepare;
	let imageReads = 0, nativeChecks = 0;
	const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (/FROM (?:scopes|accepted_entries) WHERE object_id=\? ORDER BY epoch/u.test(sql)) imageReads++;
		if (sql === "SELECT name FROM sqlite_schema LIMIT 1") nativeChecks++;
		return originalPrepare.call(this, sql);
	});
	try {
		expect(await store.installGenesis(current.install)).toMatchObject({ok: true});
		const read = store.readRetirementImage;
		expect(Object.isFrozen(read)).toBe(true);
		expect(typeof read.captureCurrentProbe).toBe("function");
		const unheld = must(await read(selector));
		expect(read.captureCurrentProbe?.call(read, unheld)).toBeUndefined();
		lease = await store.acquireNativeReadReservation(selector);
		const before = imageReads;
		const captured = must(await read(selector));
		expect(captured).toEqual(unheld);
		expect(imageReads - before).toBe(2);
		const probe = read.captureCurrentProbe?.call(read, captured);
		expect(probe).toBeDefined();
		expect(read.captureCurrentProbe?.call(read, captured)).toBeUndefined();
		const reads = imageReads, checks = nativeChecks;
		expect(await probe!.checkCurrent()).toEqual({ok: true, value: null});
		expect(await probe!.checkCurrent()).toEqual({ok: true, value: null});
		expect(imageReads).toBe(reads);
		expect(nativeChecks - checks).toBe(2);
		expect(must(await read(selector))).toEqual(unheld);
		expect(imageReads).toBe(reads);
		raw.exec("PRAGMA busy_timeout=1");
		expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow();
		const other = {objectId: current.scope.objectId === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64)};
		expect(await read(other)).toEqual({ok: false, kind: "not-installed"});
		const afterEvictionChecks = nativeChecks;
		expect(await probe!.checkCurrent()).toEqual({ok: false, kind: "retirement-stale"});
		expect(nativeChecks).toBe(afterEvictionChecks + 1);
		const beforeReplacement = imageReads;
		const release = lease.release();
		expect(await probe!.checkCurrent()).toEqual({ok: false, kind: "retirement-released"});
		await release; lease = undefined;
		lease = await store.acquireNativeReadReservation(selector);
		expect(await probe!.checkCurrent()).toEqual({ok: false, kind: "retirement-released"});
		must(await read(selector));
		expect(imageReads).toBe(beforeReplacement + 2);
	} finally {
		spy.mockRestore();
		await lease?.release(); raw.close(); await store.close();
		await rm(directory, {recursive: true, force: true});
	}
});

test("journal held probe refuses copied, rebound and mutated observations while detached recaptures remain exact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-held-probe-mutation-"));
	const store = createNodeDurableLiveJournalStore({primaryFilename: join(directory, "journal.sqlite")});
	const current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	let lease: NativeReadReservation | undefined;
	try {
		must(await store.installGenesis(current.install));
		const control = must(await store.acquireRetirementControl(selector)); await control.release();
		const read = store.readRetirementImage;
		lease = await store.acquireNativeReadReservation(selector);
		const original = must(await read(selector));
		expect(read.captureCurrentProbe?.call(read, {...original})).toBeUndefined();
		expect(read.captureCurrentProbe?.call(read.bind(store), original)).toBeUndefined();
		const wrapper: LiveJournalRetirementImageReader = input => read(input);
		expect(wrapper.captureCurrentProbe).toBeUndefined();
		expect(read.captureCurrentProbe?.call(wrapper, original)).toBeUndefined();
		const probe = read.captureCurrentProbe?.call(read, original);
		expect(probe).toBeDefined();
		expect(await probe!.checkCurrent.call({checkCurrent: probe!.checkCurrent})).toEqual({ok: false, kind: "malformed-input"});
		const rowMutated = must(await read(selector));
		rowMutated.canonicalRows[0]!.fill(0);
		expect(read.captureCurrentProbe?.call(read, rowMutated)).toBeUndefined();
		const carrierMutated = must(await read(selector));
		carrierMutated.exactCanonicalControlCarriers[0]!.fill(0);
		expect(read.captureCurrentProbe?.call(read, carrierMutated)).toBeUndefined();
		expect(must(await read(selector))).toEqual(original);
		expect(await probe!.checkCurrent()).toEqual({ok: true, value: null});
	} finally {
		await lease?.release(); await store.close();
		await rm(directory, {recursive: true, force: true});
	}
});

test("journal held probe release and reopen retain raw-corruption refusal and transparent-wrapper semantics", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-held-probe-reopen-"));
	const filename = join(directory, "journal.sqlite"), current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	const store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	let lease: NativeReadReservation | undefined;
	try {
		must(await store.installGenesis(current.install));
		const read = store.readRetirementImage;
		const wrapper: LiveJournalRetirementImageReader = input => read(input);
		Object.defineProperty(wrapper, "captureCurrentProbe", {value: function (this: LiveJournalRetirementImageReader, observation: Parameters<NonNullable<LiveJournalRetirementImageReader["captureCurrentProbe"]>>[0]) {
			return this === wrapper ? read.captureCurrentProbe?.call(read, observation) : undefined;
		}});
		Object.freeze(wrapper);
		lease = await store.acquireNativeReadReservation(selector);
		const captured = must(await wrapper(selector));
		const probe = wrapper.captureCurrentProbe?.call(wrapper, captured);
		expect(probe).toBeDefined();
		expect(await probe!.checkCurrent()).toEqual({ok: true, value: null});
		await lease.release(); lease = undefined;
		raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		raw.prepare("UPDATE scopes SET closed_membership_bytes=X'' WHERE object_id=?").run(selector.objectId);
		expect(await read(selector)).toEqual({ok: false, kind: "retirement-fenced"});
		lease = await store.acquireNativeReadReservation(selector);
		expect(await read(selector)).toEqual({ok: false, kind: "retirement-fenced"});
		expect(await probe!.checkCurrent()).toEqual({ok: false, kind: "retirement-released"});
		await lease.release(); lease = undefined;
		raw.prepare("UPDATE scopes SET closed_membership_bytes=NULL WHERE object_id=?").run(selector.objectId);
		expect(must(await read(selector))).toEqual(captured);
		await store.close();
		expect(await probe!.checkCurrent()).toEqual({ok: false, kind: "store-closed"});
		const reopened = createNodeDurableLiveJournalStore({primaryFilename: filename, initialization: "reopen"});
		try {
			expect(must(await reopened.readRetirementImage(selector))).toEqual(captured);
			expect(reopened.readRetirementImage.captureCurrentProbe?.call(reopened.readRetirementImage, captured)).toBeUndefined();
		} finally { await reopened.close(); }
	} finally {
		await lease?.release(); raw.close(); await store.close();
		await rm(directory, {recursive: true, force: true});
	}
});

test("journal held probe joins admitted native checks but refuses delivery after close", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-held-probe-close-"));
	const store = createNodeDurableLiveJournalStore({primaryFilename: join(directory, "journal.sqlite")});
	const current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	let lease: NativeReadReservation | undefined;
	try {
		must(await store.installGenesis(current.install));
		lease = await store.acquireNativeReadReservation(selector);
		const read = store.readRetirementImage, captured = must(await read(selector));
		const probe = read.captureCurrentProbe?.call(read, captured);
		expect(probe).toBeDefined();
		const pending = probe!.checkCurrent();
		const closing = store.close();
		expect(await pending).toEqual({ok: false, kind: "store-closed"});
		await closing;
		expect(await read(selector)).toEqual({ok: false, kind: "store-closed"});
	} finally {
		await lease?.release(); await store.close();
		await rm(directory, {recursive: true, force: true});
	}
});

test("journal held probes retain no released image union in one synchronous-native microtask job", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-held-probe-retention-"));
	const filename = join(directory, "journal.sqlite"), current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	const store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	try {
		must(await store.installGenesis(current.install));
		const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
		try {
			raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
			// Mechanical native carrier fixture only, not authenticated parameters.
			// Large enough to expose retained *released* frame unions deterministically.
			raw.prepare("UPDATE scopes SET exact_parameters_carrier=? WHERE object_id=?").run(new Uint8Array(131_072), selector.objectId);
		} finally { raw.close(); }
		await store.close();
		const output = join(directory, "retention-child.mjs");
		await build({bundle: true, platform: "node", format: "esm", target: "node22", outfile: output,
			stdin: {resolveDir: import.meta.dirname, sourcefile: "journal-probe-retention-child.ts", contents: `
				import { createNodeDurableLiveJournalStore } from "../src/live-journal.ts";
				const store = createNodeDurableLiveJournalStore({primaryFilename: process.argv[2], initialization: "reopen"});
				const selector = {objectId: process.argv[3]}, probes = [];
				if (typeof global.gc !== "function") throw new Error("native retention control needs explicit GC");
				global.gc(); const before = process.memoryUsage().arrayBuffers;
				let imageBytes = 0;
				for (let i = 0; i < 24; i++) {
					const lease = await store.acquireNativeReadReservation(selector);
					try {
						const result = await store.readRetirementImage(selector);
						if (!result.ok) throw new Error("native retention image refused");
						imageBytes = result.value.image.byteCharge;
						const probe = store.readRetirementImage.captureCurrentProbe?.call(store.readRetirementImage, result.value);
						if (!probe) throw new Error("original producer probe missing");
						probes.push(probe);
					} finally { await lease.release(); }
				}
				// No timer, immediate, native async I/O, or GC/event-loop yield has
				// intervened. All SQLite work and its Promise continuations are one job.
				global.gc(); const after = process.memoryUsage().arrayBuffers;
				for (const probe of probes) {
					const result = await probe.checkCurrent();
					if (result.ok || result.kind !== "retirement-released") throw new Error("released probe became current");
				}
				console.log(JSON.stringify({before, after, retained: after - before, imageBytes, probes: probes.length}));
				await store.close();
			`}});
		// Count reachable backing stores, not dead buffers awaiting V8's concurrent
		// sweeper. This diagnostic-only flag changes neither production GC nor the
		// same-job/no-yield lifetime bound; the original leaking producer still fails.
		const child = spawnSync(process.execPath, ["--expose-gc", "--no-concurrent-array-buffer-sweeping", output, filename, selector.objectId], {encoding: "utf8", timeout: 15_000});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout.trim()) as {retained: number; imageBytes: number; probes: number};
		console.info("native held probe released-image retention", result);
		expect(result.probes).toBe(24);
		// Fixture-scaled lifetime bound, not a new product memory/performance limit:
		// retaining 24 ended images is forbidden; a last stack-local image is harmless.
		expect(result.retained, child.stdout).toBeLessThan(result.imageBytes * 4);
	} finally {
		await store.close(); await rm(directory, {recursive: true, force: true});
	}
});

test("journal syntax owner releases its private encoded plan even when an ended view is retained", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-syntax-release-"));
	try {
		const output = join(directory, "syntax-release-child.mjs");
		await build({bundle: true, platform: "node", format: "esm", target: "node22", outfile: output,
			stdin: {resolveDir: import.meta.dirname, sourcefile: "journal-syntax-release-child.ts", contents: `
				import {createJournalRetirementControlCodec as makeSyntaxOwner, encodeJournalRetirementNativeCarriers as makeNativeBytes}
					from "../../live-journal/src/retirement.ts";
				const OriginalWeakRef = globalThis.WeakRef, references = [];
				globalThis.WeakRef = class extends OriginalWeakRef {
					constructor(value) {super(value);
						if (value?.plan && value.bytes instanceof Uint8Array && typeof value.digest === "string")
							references.push(new OriginalWeakRef(value));
					}
				};
				// Mechanical codec/lifetime fixture only; no deletion or signature authority.
				const scope = {objectId:"room",epoch:0,anchorDigest:"a".repeat(64)};
				const completed = {throughEpoch:0,protectedScopes:[],decisionDigest:"b".repeat(64),sourceProofDigest:"c".repeat(64)};
				const base = {kind:"v3-live-journal-retirement-control-1",objectId:"room",incarnation:"d".repeat(64),
					revision:2,sequence:1,active:null,completed};
				const image = {imageDigest:"e".repeat(64),scopeCount:1,rowCount:1,byteCharge:2};
				const plan = {baseControl:base,sourceImage:image,prefixes:[{scope,highWatermark:1,rows:[{
					journalSequence:0,vertexDigest:"f".repeat(64),author:"writer",authorSequence:0,nativeFrameDigest:"0".repeat(64)}]}]};
				const carriers = makeNativeBytes({...base,kind:"v3-live-journal-retirement-control-2",
					revision:3,drain:{plan,cursor:0,batches:0,residualImageDigest:image.imageDigest}});
				const codec = makeSyntaxOwner();
				const decoded = codec.decode(carriers.controlBytes,carriers.planBytes);
				const view = codec.createRead(decoded,image,async()=>({ok:false,kind:"substrate-failure"}),
					[Uint8Array.of(0),Uint8Array.of(1)]);
				if(references.length!==1)throw Error("original scoped syntax reference missing");
				codec.release(); await view.release();
				// WeakRef targets remain alive until the end of their creating job.
				await new Promise(setImmediate); global.gc(); await new Promise(setImmediate); global.gc();
				if(references[0].deref()!==undefined)throw Error("ended view retained the private encoded plan");
				if(view.control.drain.plan.prefixes[0].rows.length!==1)throw Error("public detached control lost");
				console.log("released private syntax; public ended view remains readable");
			`}});
		const child = spawnSync(process.execPath, ["--expose-gc", output], {encoding: "utf8", timeout: 15_000});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toContain("released private syntax");
	} finally {await rm(directory, {recursive: true, force: true});}
});

test("journal source-bound append retains independent complete CAS postwrite and readback captures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-postwrite-capture-"));
	const store = createNodeDurableLiveJournalStore({primaryFilename: join(directory, "journal.sqlite")});
	const current = anchorMaterial(0), selector = {objectId: current.scope.objectId};
	try {
		must(await store.installGenesis(current.install));
		const before = must(await store.readRetirementImage(selector));
		const prepare = DatabaseSync.prototype.prepare;
		let nativeReads = 0;
		const nativeSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
			if (/FROM (?:scopes|accepted_entries) WHERE object_id=\? ORDER BY epoch/u.test(sql)) nativeReads++;
			return prepare.call(this, sql);
		});
		let result;
		try {
			result = await store.appendAccepted({scope: current.scope, sourceKind: "local-issued", author: "creator", authorSequence: 0,
				vertexDigest: "a".repeat(64), expectedNativeImage: {imageDigest: before.image.imageDigest, controlBytes: null}});
		} finally { nativeSpy.mockRestore(); }
		expect(nativeReads).toBe(6); // BOTH tables, on original CAS/postwrite/readback captures.
		const after = must(await store.readRetirementImage(selector));
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("source-bound append refused");
		expect(result.nativeImage).toEqual({imageDigest: after.image.imageDigest, controlBytes: null});
		expect(after.image.rowCount).toBe(1);
	} finally { await store.close(); await rm(directory, {recursive: true, force: true}); }
});

test("journal source-bound append refuses an oversized actual postwrite image before commit and can continue", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-postwrite-budget-"));
	const filename = join(directory, "journal.sqlite"), old = anchorMaterial(0), current = anchorMaterial(1), selector = {objectId: current.scope.objectId};
	const store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		must(await store.installGenesis(old.install)); must(await store.installEpochAnchor(current.install));
		raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		const original = raw.prepare("SELECT * FROM scopes WHERE epoch=0").get()!;
		const {closed_membership_bytes: _absent, ...normalized} = original;
		const empty = {...normalized, exact_parameters_carrier: new Uint8Array()};
		const {closed_membership_bytes: _currentAbsent, ...currentNative} = raw.prepare("SELECT * FROM scopes WHERE epoch=1").get()!;
		const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
		const emptyBytes = encodeCanonical({scopes: [empty, currentNative], rows: []}, {maxBytes: limit}).byteLength;
		const candidate = {scope: current.scope, sourceKind: "local-issued" as const, author: "creator", authorSequence: 0, vertexDigest: "a".repeat(64)};
		const nativeCandidate = {object_id: current.scope.objectId, epoch: current.scope.epoch, anchor_digest: current.scope.anchorDigest,
			journal_sequence: 0, source_kind: "local-issued", vertex_digest: candidate.vertexDigest, received_preimage: null,
			received_signature: null, local_author: candidate.author, local_author_sequence: candidate.authorSequence};
		const candidateBytes = journalRetirementRowCharge(nativeCandidate);
		// The new length needs a three-byte varuint rather than the empty one.
		raw.prepare("UPDATE scopes SET exact_parameters_carrier=? WHERE epoch=0").run(new Uint8Array(limit - emptyBytes - 2 - candidateBytes + 1));
		const before = must(await store.readRetirementImage(selector));
		expect(before.image.byteCharge).toBe(limit - candidateBytes + 1);
		const nativeHeader = (decodeCanonical(before.canonicalRows[0]!, {maxBytes: limit}) as [unknown, unknown, Record<string, unknown>])[2];
		const postHeaders = [nativeHeader, {...currentNative, next_journal_sequence: 1}];
		expect(postHeaders.reduce((sum, row) => sum + journalRetirementRowCharge(row), candidateBytes)).toBeLessThanOrEqual(limit);
		expect(encodeCanonical({scopes: postHeaders, rows: [nativeCandidate]}, {maxBytes: limit + 1024}).byteLength).toBe(limit + 1);
		expect(await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: before.image.imageDigest, controlBytes: null}}))
			.toEqual({ok: false, kind: "retirement-fenced"});
		expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(0);
		expect(raw.prepare("SELECT next_journal_sequence FROM scopes").get()?.next_journal_sequence).toBe(0);
		expect(must(await store.readRetirementImage(selector))).toEqual(before);
		raw.prepare("UPDATE scopes SET exact_parameters_carrier=? WHERE epoch=0").run(original.exact_parameters_carrier as Uint8Array);
		const restored = must(await store.readRetirementImage(selector));
		expect(await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: restored.image.imageDigest, controlBytes: null}}))
			.toMatchObject({ok: true, idempotent: false});
	} finally { raw.close(); await store.close(); await rm(directory, {recursive: true, force: true}); }
});

test("journal source-bound append compares complete postcommit historical rows and recovers exact continuation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-postwrite-interference-"));
	const filename = join(directory, "journal.sqlite"), old = anchorMaterial(0), current = anchorMaterial(1), selector = {objectId: current.scope.objectId};
	let store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	const originalExec = DatabaseSync.prototype.exec;
	try {
		must(await store.installGenesis(old.install)); must(await store.installEpochAnchor(current.install));
		raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		const before = must(await store.readRetirementImage(selector));
		const digest = raw.prepare("SELECT parameters_digest FROM scopes WHERE epoch=0").get()!.parameters_digest;
		let writer: DatabaseSync | undefined, committed = false, readonlyBegins = 0, changed = 0;
		DatabaseSync.prototype.exec = function (sql: string): void {
			Reflect.apply(originalExec, this, [sql]);
			if (sql === "BEGIN IMMEDIATE") writer = this;
			if (this === writer && sql === "COMMIT") committed = true;
			if (this === writer && committed && sql === "BEGIN" && ++readonlyBegins === 2) {
				changed++;
				raw.prepare("UPDATE scopes SET parameters_digest=? WHERE epoch=0").run("f".repeat(64));
			}
		};
		const candidate = {scope: current.scope, sourceKind: "local-issued" as const, author: "creator", authorSequence: 0, vertexDigest: "a".repeat(64)};
		let refused;
		try { refused = await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: before.image.imageDigest, controlBytes: null}}); }
		finally { DatabaseSync.prototype.exec = originalExec; }
		expect(changed).toBe(1);
		expect(refused).toEqual({ok: false, kind: "outcome-unknown"});
		expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(1);
		raw.prepare("UPDATE scopes SET parameters_digest=? WHERE epoch=0").run(digest as string);
		await store.close(); store = createNodeDurableLiveJournalStore({primaryFilename: filename, initialization: "reopen"});
		const recovered = must(await store.readRetirementImage(selector));
		expect(await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: recovered.image.imageDigest, controlBytes: null}}))
			.toMatchObject({ok: true, idempotent: true});
		const retry = must(await store.readRetirementImage(selector));
		expect(await store.appendAccepted({...candidate, authorSequence: 1, vertexDigest: "b".repeat(64),
			expectedNativeImage: {imageDigest: retry.image.imageDigest, controlBytes: null}})).toMatchObject({ok: true, idempotent: false});
	} finally { DatabaseSync.prototype.exec = originalExec; raw.close(); await store.close(); await rm(directory, {recursive: true, force: true}); }
});

test("journal source-bound postwrite admission validates malformed historical native values before effects commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-postwrite-malformed-"));
	const filename = join(directory, "journal.sqlite"), old = anchorMaterial(0), current = anchorMaterial(1), selector = {objectId: current.scope.objectId};
	const store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		must(await store.installGenesis(old.install)); must(await store.installEpochAnchor(current.install));
		raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
		const before = must(await store.readRetirementImage(selector));
		raw.exec("CREATE TRIGGER postwrite_malformed_test AFTER INSERT ON accepted_entries BEGIN UPDATE scopes SET next_journal_sequence=1e999 WHERE epoch=0; END");
		const candidate = {scope: current.scope, sourceKind: "local-issued" as const, author: "creator", authorSequence: 0, vertexDigest: "a".repeat(64)};
		expect(await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: before.image.imageDigest, controlBytes: null}}))
			.toEqual({ok: false, kind: "substrate-failure"});
		expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(0);
		expect(must(await store.readRetirementImage(selector))).toEqual(before);
		raw.exec("DROP TRIGGER postwrite_malformed_test");
		expect(await store.appendAccepted({...candidate, expectedNativeImage: {imageDigest: before.image.imageDigest, controlBytes: null}}))
			.toMatchObject({ok: true, idempotent: false});
	} finally { raw.close(); await store.close(); await rm(directory, {recursive: true, force: true}); }
});

function must<T>(result: StoreResult<T> | Readonly<{ ok: false }> | Readonly<{ ok: true; value: T }>): T {
	if (!result.ok) throw new TypeError("retirement image fixture failed");
	return result.value;
}

// Native encoding conformance for the new received-candidate branch. Real
// per-author signatures do not make these fixture anchors/ACL portable authority.
// This is not the integrated128-Writer admission/drainability acceptance test.
test.each([[64, 0], [128, 0], [128, 2]])("R10 received append capacity widths preserve full native bytes for %i authors with %i local continuations", async (writers, continuationCount) => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-received-capacity-widths-"));
	const store = createNodeDurableLiveJournalStore({ primaryFilename: join(directory, "journal.sqlite") });
	const current = anchorMaterial(0), successor = anchorMaterial(1);
	const fields = decodeCanonical(Uint8Array.from(Buffer.from(archived.vertexHex, "hex"))) as Record<string, unknown>;
	const issuer = "f".repeat(64);
	const local = (authorSequence: number, scope = current.scope) => ({
		scope, sourceKind: "local-issued" as const, author: issuer, authorSequence,
		vertexDigest: Buffer.from(hashDomain("ts-drp/vertex/v3", encodeCanonical({ issuer, authorSequence, epoch: scope.epoch }))).toString("hex"),
	});
	const received = (ordinal: number) => {
		const seed = new Uint8Array(32).fill(ordinal + 1);
		const publicKey = ed25519.getPublicKey(seed);
		const bytes = encodeCanonical({ ...fields, objectId: current.scope.objectId, epoch: current.scope.epoch,
			anchor: current.scope.anchorDigest, author: Buffer.from(publicKey).toString("hex"), authorSequence: 0,
			logicalTime: ordinal + 1, operation: { action: "receivedCapacityFixture", payload: "x".repeat(4096) } });
		const digest = hashDomain("ts-drp/vertex/v3", bytes);
		const signature = ed25519.sign(digest, seed);
		expect(ed25519.verify(signature, digest, publicKey)).toBe(true);
		return { scope: current.scope, sourceKind: "received" as const, vertexDigest: Buffer.from(digest).toString("hex"),
			exactCanonicalPreimageBytes: bytes, detachedSignature: signature };
	};
	const browserFrames = (frames: readonly Uint8Array[]) => frames.map((bytes) => {
		const [table, key, row] = decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>];
		const value = table === "scopes" ? {
			objectId: row.object_id, epoch: row.epoch, anchorDigest: row.anchor_digest,
			nextJournalSequence: row.next_journal_sequence, exactCanonicalAnchorPreimageBytes: row.exact_anchor_preimage,
			detachedAnchorSignature: row.detached_anchor_signature, parametersDigest: row.parameters_digest,
			exactCanonicalParametersCarrierBytes: row.exact_parameters_carrier,
		} : row.source_kind === "received" ? {
			objectId: row.object_id, epoch: row.epoch, anchorDigest: row.anchor_digest, journalSequence: row.journal_sequence,
			sourceKind: "received", vertexDigest: row.vertex_digest,
			exactCanonicalPreimageBytes: row.received_preimage, detachedSignature: row.received_signature,
		} : {
			objectId: row.object_id, epoch: row.epoch, anchorDigest: row.anchor_digest, journalSequence: row.journal_sequence,
			sourceKind: "local-issued", vertexDigest: row.vertex_digest, localAuthor: row.local_author,
			localAuthorSequence: row.local_author_sequence,
		};
		return encodeCanonical([table === "scopes" ? table : "acceptedEntries", key, value]);
	});
	const check = (width: JournalFutureNativeWidths | undefined, frames: readonly Uint8Array[]) => {
		const decoded = frames.map(bytes => decodeCanonical(bytes) as [string, unknown, unknown]);
		expect(width).toEqual({
			scopeCount: decoded.filter(frame => frame[0] === "scopes").length,
			rowCount: decoded.filter(frame => frame[0] !== "scopes").length,
			canonicalRowBytes: frames.map(bytes => bytes.byteLength),
			canonicalRowsBytes: encodeCanonical(frames).byteLength,
			nativeImageBytes: encodeCanonical({ scopes: decoded.filter(frame => frame[0] === "scopes").map(frame => frame[2]),
				rows: decoded.filter(frame => frame[0] !== "scopes").map(frame => frame[2]) }).byteLength,
		});
	};
	try {
		expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
		expect(await store.appendAccepted(local(0))).toMatchObject({ ok: true, idempotent: false });
		for (let ordinal = 0; ordinal < writers - 1; ordinal++)
			expect(await store.appendAccepted(received(ordinal))).toMatchObject({ ok: true, idempotent: false });
		const before = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		const candidate = received(writers - 1);
		const unsigned = { objectId: successor.install.objectId,
			exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes };
		const continuations = Array.from({ length: continuationCount }, (_, index) => local(index + 1));
		const fence = { author: issuer, authorSequence: continuationCount + 1 };
		const options = { localIssuerBasis: { objectId: current.scope.objectId, author: issuer, nextAuthorSequence: 1 } };
		const predicted = journalFutureAppendPostimageWidths(before.canonicalRows, candidate, unsigned, fence, continuations, options);
		const browser = journalFutureAppendPostimageWidths(browserFrames(before.canonicalRows), candidate, unsigned, fence, continuations, options);
		expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(before);
		expect(() => journalFutureAppendPostimageWidths(before.canonicalRows,
			{ ...candidate, vertexDigest: "0".repeat(64) }, unsigned, fence, continuations, options)).toThrow();
		expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(before);
		expect(await store.appendAccepted(candidate)).toMatchObject({ ok: true, idempotent: false });
		for (const continuation of continuations)
			expect(await store.appendAccepted(continuation)).toMatchObject({ ok: true, idempotent: false });
		const appended = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		check(predicted.afterLocal, appended.canonicalRows);
		check(browser.afterLocal, browserFrames(appended.canonicalRows));
		expect(() => journalFutureAppendPostimageWidths(appended.canonicalRows, candidate, unsigned, fence, continuations, options)).toThrow();
		expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true, idempotent: false });
		const installed = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		check(predicted.afterSuccessor, installed.canonicalRows);
		check(browser.afterSuccessor, browserFrames(installed.canonicalRows));
		expect(await store.appendAccepted(local(fence.authorSequence, successor.scope))).toMatchObject({ ok: true, idempotent: false });
		const final = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		check(predicted.afterSuccessorLocal, final.canonicalRows);
		check(browser.afterSuccessorLocal, browserFrames(final.canonicalRows));
		const nativeRows = final.canonicalRows.map(bytes => decodeCanonical(bytes) as [string, unknown, Record<string, unknown>]);
		expect(nativeRows.filter(([table, , row]) => table !== "scopes" && row.source_kind === "received")).toHaveLength(writers);
		expect(nativeRows.filter(([table, , row]) => table !== "scopes" && row.source_kind === "local-issued")).toHaveLength(2 + continuationCount);
		writeSync(1, `R10_RECEIVED_CAPACITY_WIDTHS ${JSON.stringify({ writers, continuationCount, payloadBytes: 4096,
			beforeNativeBytes: before.image.byteCharge, afterNativeBytes: appended.image.byteCharge,
			candidatePreimageBytes: candidate.exactCanonicalPreimageBytes.byteLength,
			candidateSignatureBytes: candidate.detachedSignature.byteLength, finalNativeBytes: final.image.byteCharge,
			componentConformanceOnly: true, browserShapeOnly: true })}\n`);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R9 complete current journal continuation widths match native append then successor fence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-continuation-widths-"));
	const current = anchorMaterial(0),
		successor = anchorMaterial(1);
	const fields = decodeCanonical(Uint8Array.from(Buffer.from(archived.vertexHex, "hex"))) as Record<string, unknown>;
	const author = fields.author as string;
	const local = (authorSequence: number, scope = current.scope) => ({
		author,
		authorSequence,
		scope,
		sourceKind: "local-issued" as const,
		vertexDigest: Buffer.from(
			hashDomain(
				"ts-drp/vertex/v3",
				encodeCanonical({
					...fields,
					authorSequence,
					logicalTime: authorSequence + 1,
					epoch: scope.epoch,
					anchor: scope.anchorDigest,
				})
			)
		).toString("hex"),
	});
	const browserFrames = (frames: readonly Uint8Array[]) =>
		frames.map((bytes) => {
			const [table, key, row] = decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>];
			return encodeCanonical([
				table === "scopes" ? table : "acceptedEntries",
				key,
				table === "scopes"
					? {
							objectId: row.object_id,
							epoch: row.epoch,
							anchorDigest: row.anchor_digest,
							nextJournalSequence: row.next_journal_sequence,
							exactCanonicalAnchorPreimageBytes: row.exact_anchor_preimage,
							detachedAnchorSignature: row.detached_anchor_signature,
							parametersDigest: row.parameters_digest,
							exactCanonicalParametersCarrierBytes: row.exact_parameters_carrier,
						}
					: {
							objectId: row.object_id,
							epoch: row.epoch,
							anchorDigest: row.anchor_digest,
							journalSequence: row.journal_sequence,
							sourceKind: row.source_kind,
							vertexDigest: row.vertex_digest,
							localAuthor: row.local_author,
							localAuthorSequence: row.local_author_sequence,
						},
			]);
		});
	const check = (width: JournalFutureNativeWidths | undefined, frames: readonly Uint8Array[]) => {
		const decoded = frames.map((bytes) => decodeCanonical(bytes) as [string, unknown, unknown]);
		expect(width).toEqual({
			scopeCount: decoded.filter((frame) => frame[0] === "scopes").length,
			rowCount: decoded.filter((frame) => frame[0] !== "scopes").length,
			canonicalRowBytes: frames.map((bytes) => bytes.length),
			canonicalRowsBytes: encodeCanonical(frames).length,
			nativeImageBytes: encodeCanonical({
				scopes: decoded.filter((frame) => frame[0] === "scopes").map((frame) => frame[2]),
				rows: decoded.filter((frame) => frame[0] !== "scopes").map((frame) => frame[2]),
			}).length,
		});
	};
	try {
		for (const count of [61, 125]) {
			const store = createNodeDurableLiveJournalStore({ primaryFilename: join(directory, `${count}.sqlite`) });
			try {
				expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
				await must(await store.acquireRetirementControl({ objectId: current.scope.objectId })).release();
				for (let ordinal = 0; ordinal < count; ordinal++)
					expect(await store.appendAccepted(local(ordinal))).toMatchObject({ ok: true });
				const before = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				const continuations = [local(count + 1), local(count + 2), local(count + 3)];
				const fence = { author, authorSequence: count + 4 };
				const unsigned = {
					objectId: successor.install.objectId,
					exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
					exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes,
				};
				const projected = journalFutureAppendPostimageWidths(
					before.canonicalRows,
					local(count),
					unsigned,
					fence,
					continuations
				);
				const browser = journalFutureAppendPostimageWidths(
					browserFrames(before.canonicalRows),
					local(count),
					unsigned,
					fence,
					continuations
				);
				expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(before);
				for (const append of [local(count), ...continuations])
					expect(await store.appendAccepted(append)).toMatchObject({ ok: true, idempotent: false });
				const appended = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(projected.afterLocal, appended.canonicalRows);
				check(browser.afterLocal, browserFrames(appended.canonicalRows));
				expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true, idempotent: false });
				const installed = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(projected.afterSuccessor, installed.canonicalRows);
				check(browser.afterSuccessor, browserFrames(installed.canonicalRows));
				expect(await store.appendAccepted(local(fence.authorSequence, successor.scope))).toMatchObject({
					ok: true,
					idempotent: false,
				});
				const final = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(projected.afterSuccessorLocal, final.canonicalRows);
				check(browser.afterSuccessorLocal, browserFrames(final.canonicalRows));
				expect(final.control?.revision).toBe(before.control!.revision + 6);
				for (const invalid of [
					[local(count + 2)],
					[{ ...local(count + 1), author: author + "-foreign" }],
					[{ ...local(count + 1), scope: successor.scope }],
					[{ ...local(count + 1), vertexDigest: local(count).vertexDigest }],
				]) {
					expect(() =>
						journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsigned, fence, invalid)
					).toThrow("malformed-input");
				}
				expect(() =>
					journalFutureAppendPostimageWidths(
						before.canonicalRows,
						local(count),
						unsigned,
						{ ...fence, authorSequence: count + 1 },
						continuations
					)
				).toThrow("malformed-input");
				expect(() =>
					journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsigned, fence, new Array(1))
				).toThrow();
				expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(final);
				console.log(
					"R9_JOURNAL_CONTINUATION_WIDTHS",
					JSON.stringify({
						count,
						continuationCount: 3,
						final: projected.afterSuccessorLocal,
						nativeControlDelta: final.control!.revision - before.control!.revision,
						browserShapeConformanceOnly: true,
					})
				);
			} finally {
				await store.close();
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// Same original opaque future owner and actual SQLite checkpoint. The trusted
// authenticated-context input below is a component premise, NOT signed receive
// authentication or seven-domain inherited migration. Raw mutations are only
// integrity faults, never authority or a successful continuation.
test("R8 SQLite exact existing Complete nomination preserves payload and refuses foreign or stale source", async () => {
	const { createCreatorAuthenticatedNativeFuture } = await import("../../node/src/internal/creator-adoption-intent.js");
	for (const variant of ["wrong-record", "stale-source", "valid"] as const) {
		const directory = await mkdtemp(join(tmpdir(), "ts-drp-existing-nominee-"));
		const filename = join(directory, "store.sqlite"),
			store = createSqliteAheDurableStore({ filename });
		const raw = new DatabaseSync(filename),
			originalPrepare = DatabaseSync.prototype.prepare;
		try {
			const objectId = must(parseStorageObjectId(`existing-nominee:${"a".repeat(32)}`));
			const oldId = must(parseGenerationId("a".repeat(64))),
				candidateId = must(parseGenerationId("b".repeat(64)));
			const bytes = Uint8Array.of(17),
				ref = { digest: must(digestBlob(bytes)), byteLength: bytes.length };
			const absent = { kind: "none" as const, objectId };
			must(await store.beginGeneration({ objectId, generationId: oldId, baseExpectedHead: absent, closure: [ref] }));
			must(await store.putCachedBlob({ objectId, generationId: oldId, digest: ref.digest, bytes }));
			must(await store.promoteReference({ objectId, generationId: oldId, digest: ref.digest }));
			must(await store.completeGeneration({ objectId, generationId: oldId }));
			const head = must(await store.swapHead({ objectId, generationId: oldId, expectedHead: absent })).head;
			must(
				await store.beginGeneration({ objectId, generationId: candidateId, baseExpectedHead: head, closure: [ref] })
			);
			must(await store.promoteReference({ objectId, generationId: candidateId, digest: ref.digest }));
			must(await store.completeGeneration({ objectId, generationId: candidateId }));
			const records = raw
				.prepare("SELECT record FROM generations ORDER BY generation_id")
				.all()
				.map((row) => {
					if (!(row.record instanceof Uint8Array)) throw new Error("native generation bytes absent");
					return must(decodeGenerationRecordV1(row.record));
				});
			const candidate = records.find((row) => row.generationId === candidateId);
			if (candidate === undefined || candidate.state !== "Complete") throw new Error("exact Complete candidate absent");
			const recordDigests = records.map((row) => must(digestBlob(encodeGenerationRecordV1(row))));
			const acquire = store.acquireRetirementControl?.bind(store);
			if (acquire === undefined) throw new Error("original native control owner absent");
			const prepare = must(await acquire(objectId));
			try {
				must(
					await prepare.prepareBound({
						preparation: {
							head,
							floorEpoch: 0,
							floorAnchor: "c".repeat(64),
							decisionDigest: "d".repeat(64),
							sourceProofDigest: "e".repeat(64),
							generationRecordDigests: recordDigests,
							snapshotScopes: [],
							protectedIndices: [],
							retireIndices: [],
							domains: [[255, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0]],
						},
						generations: {
							recordDigests,
							identities: records.map((row) => ({
								generationId: row.generationId,
								identityDigest: aheRetirementGenerationIdentity(row),
							})),
							protectedIndices: [0, 1],
							retireIndices: [],
						},
					})
				);
			} finally {
				await prepare.release();
			}
			const commit = must(await acquire(objectId));
			try {
				must(await commit.commitPrepared({ decisionDigest: "d".repeat(64), sourceProofDigest: "e".repeat(64) }));
			} finally {
				await commit.release();
			}
			const futureInput: Parameters<typeof createCreatorAuthenticatedNativeFuture>[0] = {
				owner: Object.freeze({}),
				store,
				successorTrust: {
					objectId,
					profileId: "creator-trusted-settlement-v1",
					currentEpoch: 1,
					currentAnchorDigest: "f".repeat(64),
					genesisAnchorDigest: "c".repeat(64),
				},
				currentHead: head,
				generationId: candidateId,
				acceptedClosure: candidate.closure,
				newBlobs: [],
				existingCompleteGeneration:
					variant === "wrong-record"
						? { ...candidate, baseExpectedHead: { ...head, closureDigest: "f".repeat(64) } }
						: candidate,
			};
			const capability = createCreatorAuthenticatedNativeFuture(futureInput);
			const capture = must(await acquire(objectId));
			// A second ORIGINAL native nomination changes the captured control
			// currency. The old observation must refuse, without raw source edits.
			if (variant === "stale-source") {
				const foreign = must(await acquire(objectId));
				try {
					must(await foreign.stageNominatedFutureGeneration(createCreatorAuthenticatedNativeFuture(futureInput)));
				} finally {
					await foreign.release();
				}
			}
			const before = boundedAheSqliteImage(raw),
				savedControl = capture.control;
			let closureChecks = 0;
			DatabaseSync.prototype.prepare = function (sql: string): ReturnType<DatabaseSync["prepare"]> {
				if (sql === "SELECT 1 FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
					closureChecks++;
				return originalPrepare.call(this, sql);
			};
			let staged;
			try {
				staged = await capture.stageNominatedFutureGeneration(capability);
			} finally {
				DatabaseSync.prototype.prepare = originalPrepare;
				await capture.release();
			}
			if (variant !== "valid") {
				expect(staged.ok).toBe(false);
				if (variant === "wrong-record") expect(staged).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
				if (variant === "stale-source") expect(staged).toEqual({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
				expect(boundedAheSqliteImage(raw)).toEqual(before);
				continue;
			}
			const nominated = must(staged),
				after = boundedAheSqliteImage(raw);
			expect(closureChecks).toBeGreaterThan(0);
			for (const key of ["objects", "generations", "blobs", "promotions"] as const)
				expect(after[key]).toEqual(before[key]);
			expect(nominated.completed).toEqual(savedControl.completed);
			expect(nominated.incarnation).toBe(savedControl.incarnation);
			expect(nominated.sequence).toBe(savedControl.sequence);
			expect(nominated.revision).toBe(savedControl.revision + 1);
			expect(nominated.nominee).toMatchObject({
				generationId: candidateId,
				recordDigest: must(digestBlob(encodeGenerationRecordV1(candidate))),
				closureDigest: candidate.closureDigest,
			});
			const publish = must(await acquire(objectId));
			let published;
			try {
				published = must(await publish.publishNominatedFutureGeneration(capability));
			} finally {
				await publish.release();
			}
			expect(published.completed).toEqual(savedControl.completed);
			expect(published.incarnation).toBe(savedControl.incarnation);
			expect(published.sequence).toBe(savedControl.sequence);
			expect(published.nominee).toBeNull();
			expect(must(await store.readHead(objectId))).toMatchObject({
				generationId: candidateId,
				closureDigest: candidate.closureDigest,
				revision: head.revision + 1,
			});
			const finished = boundedAheSqliteImage(raw);
			expect(finished.blobs).toEqual(before.blobs);
			expect(finished.promotions).toEqual(before.promotions);
			expect(
				finished.generations.map((row) => {
					if (!(row.record instanceof Uint8Array)) throw new Error("published generation bytes absent");
					return aheRetirementGenerationIdentity(must(decodeGenerationRecordV1(row.record)));
				})
			).toEqual(records.map(aheRetirementGenerationIdentity));
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

// Exact native custody only: fixture signatures are not external protocol authentication.
test("journal native source image distinguishes byte ceilings from malformed rows", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-retirement-ceiling-"));
	const filename = join(directory, "journal.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		const material = anchorMaterial(0);
		expect(await store.installGenesis(material.install)).toMatchObject({ ok: true });
		const original = raw.prepare("SELECT * FROM scopes").get();
		if (original === undefined) throw new Error("missing original native scope");
		const empty = { ...original, exact_parameters_carrier: new Uint8Array() };
		const ceiling = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
		expect(ceiling).toBe(786_432);
		const bytes = new Uint8Array(ceiling - encodeCanonical(empty).length - 8);
		const candidate = { ...original, exact_parameters_carrier: bytes };
		const key = [original.object_id, original.epoch, original.anchor_digest];
		expect(encodeCanonical(candidate).length).toBeLessThanOrEqual(ceiling);
		expect(encodeCanonical(["scopes", key, candidate]).length).toBeGreaterThan(ceiling);
		// The separate raw negative-test connection must supply the existing
		// trigger function. Permit only this exact unfenced fixture scope; never
		// waive an actual active or completed native control.
		raw.function("journal_retirement_allows", (objectId, epoch, anchorDigest) =>
			objectId === material.scope.objectId &&
			epoch === material.scope.epoch &&
			anchorDigest === material.scope.anchorDigest &&
			raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n === 0
				? 1
				: 0
		);
		raw.prepare("UPDATE scopes SET exact_parameters_carrier=?").run(bytes);
		expect(await store.readRetirementImage({ objectId: material.scope.objectId })).toEqual({
			ok: false,
			kind: "retirement-fenced",
		});
		raw
			.prepare("UPDATE scopes SET exact_parameters_carrier=?, next_journal_sequence=?")
			.run(original.exact_parameters_carrier as Uint8Array, Infinity);
		expect(await store.readRetirementImage({ objectId: material.scope.objectId })).toEqual({
			ok: false,
			kind: "substrate-failure",
		});
		raw.prepare("UPDATE scopes SET next_journal_sequence=?").run(original.next_journal_sequence);
		const restored = must(await store.readRetirementImage({ objectId: material.scope.objectId }));
		expect(restored.control).toBeNull();
		expect(restored.canonicalRows).toEqual([encodeCanonical(["scopes", key, { ...original }])]);
		expect(raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n).toBe(0);
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Original native substrate conformance only: captured fixture anchor signatures
// are storage carriers, not a claim of prospective protocol authorization.
test("R8 journal future local and successor widths match native codecs across varuint boundaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-future-widths-"));
	const filename = join(directory, "journal.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	if (store.readRetirementImage === undefined) throw new Error("native journal image API is unavailable");
	const readRetirementImage = store.readRetirementImage.bind(store);
	try {
		const current = anchorMaterial(0),
			successor = anchorMaterial(1);
		expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
		const unsignedSuccessor = {
			objectId: successor.install.objectId,
			exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes,
		};
		const vertexFields = decodeCanonical(Uint8Array.from(Buffer.from(archived.vertexHex, "hex"))) as Record<
			string,
			unknown
		>;
		const local = (
			authorSequence: number
		): Readonly<{
			author: string;
			authorSequence: number;
			scope: typeof current.scope;
			sourceKind: "local-issued";
			vertexDigest: string;
		}> => {
			const bytes = encodeCanonical({ ...vertexFields, authorSequence, logicalTime: authorSequence + 1 });
			const vertexDigest = Array.from(hashDomain("ts-drp/vertex/v3", bytes), (b) =>
				b.toString(16).padStart(2, "0")
			).join("");
			return {
				author: vertexFields.author as string,
				authorSequence,
				scope: current.scope,
				sourceKind: "local-issued" as const,
				vertexDigest,
			};
		};
		const browserFrames = (frames: readonly Uint8Array[]): readonly Uint8Array[] =>
			frames.map((bytes) => {
				const [table, key, raw] = decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>];
				const row =
					table === "scopes"
						? {
								objectId: raw.object_id,
								epoch: raw.epoch,
								anchorDigest: raw.anchor_digest,
								nextJournalSequence: raw.next_journal_sequence,
								exactCanonicalAnchorPreimageBytes: raw.exact_anchor_preimage,
								detachedAnchorSignature: raw.detached_anchor_signature,
								parametersDigest: raw.parameters_digest,
								exactCanonicalParametersCarrierBytes: raw.exact_parameters_carrier,
							}
						: {
								objectId: raw.object_id,
								epoch: raw.epoch,
								anchorDigest: raw.anchor_digest,
								journalSequence: raw.journal_sequence,
								sourceKind: raw.source_kind,
								vertexDigest: raw.vertex_digest,
								localAuthor: raw.local_author,
								localAuthorSequence: raw.local_author_sequence,
							};
				return encodeCanonical([table === "scopes" ? table : "acceptedEntries", key, row]);
			});
		const check = (width: JournalFutureNativeWidths, frames: readonly Uint8Array[]): void => {
			const decoded = frames.map((bytes) => decodeCanonical(bytes) as [string, unknown, unknown]);
			const scopes = decoded.filter((frame) => frame[0] === "scopes").map((frame) => frame[2]);
			const rows = decoded.filter((frame) => frame[0] !== "scopes").map((frame) => frame[2]);
			expect(width).toEqual({
				scopeCount: scopes.length,
				rowCount: rows.length,
				canonicalRowBytes: frames.map((bytes) => bytes.length),
				canonicalRowsBytes: encodeCanonical(frames).length,
				nativeImageBytes: encodeCanonical({ scopes, rows }).length,
			});
		};
		for (let ordinal = 0; ordinal < 127; ordinal++) {
			if (ordinal !== 63 && ordinal !== 126) {
				expect(await store.appendAccepted(local(ordinal))).toMatchObject({ ok: true, idempotent: false });
				continue;
			}
			const before = must(await readRetirementImage({ objectId: current.scope.objectId }));
			const predicted = journalFutureAppendPostimageWidths(before.canonicalRows, local(ordinal), unsignedSuccessor);
			const browser = journalFutureAppendPostimageWidths(
				browserFrames(before.canonicalRows),
				local(ordinal),
				unsignedSuccessor
			);
			expect(await store.appendAccepted(local(ordinal))).toMatchObject({ ok: true, idempotent: false });
			const after = must(await readRetirementImage({ objectId: current.scope.objectId }));
			check(predicted.afterLocal, after.canonicalRows);
			check(browser.afterLocal, browserFrames(after.canonicalRows));
			expect(after.image.byteCharge).toBe(predicted.afterLocal.nativeImageBytes);
			if (ordinal === 126) {
				expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true, idempotent: false });
				const installed = must(await readRetirementImage({ objectId: current.scope.objectId }));
				check(predicted.afterSuccessor, installed.canonicalRows);
				check(browser.afterSuccessor, browserFrames(installed.canonicalRows));
				expect(installed.image.byteCharge).toBe(predicted.afterSuccessor.nativeImageBytes);
				expect(predicted.afterLocal.canonicalRowBytes).toHaveLength(128);
				expect(predicted.afterSuccessor.canonicalRowBytes).toHaveLength(129);
				expect(() => journalFutureAppendPostimageWidths(after.canonicalRows, local(ordinal), unsignedSuccessor)).toThrow(
					"malformed-input"
				);
				expect(() =>
					journalFutureAppendPostimageWidths(before.canonicalRows, local(ordinal), {
						...unsignedSuccessor,
						detachedAnchorSignature: successor.install.detachedAnchorSignature,
					})
				).toThrow("malformed-input");
			}
		}
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Exact native custody only: fixture signatures are not external protocol authentication.
test("journal noncreating retirement image preserves exact source through control birth", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-retirement-source-"));
	const filename = join(directory, "journal.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		const current = anchorMaterial(0);
		expect(await store.readRetirementImage({ objectId: current.scope.objectId })).toEqual({
			ok: false,
			kind: "not-installed",
		});
		expect(raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n).toBe(0);
		expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
		const before = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		const scopes = raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all();
		const expected = scopes.map((row) => {
			// The native v3 schema represents absent membership as SQL NULL; the
			// established canonical frame omits that absent optional field.
			const {closed_membership_bytes, ...frame} = row;
			expect(closed_membership_bytes).toBeNull();
			return encodeCanonical(["scopes", [row.object_id, row.epoch, row.anchor_digest], frame]);
		});
		expect(before.control).toBeNull();
		expect(before.canonicalRows).toEqual(expected);
		expect(before.image).toEqual(
			journalRetirementImage(
				scopes.map((row) => ({ ...row })),
				[]
			)
		);
		expect(Object.isFrozen(before)).toBe(true);
		expect(Object.isFrozen(before.canonicalRows)).toBe(true);
		before.canonicalRows[0]?.fill(0);
		const repeat = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		expect(repeat.canonicalRows).toEqual(expected);
		expect(repeat.image).toEqual(before.image);
		expect(raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n).toBe(0);
		const born = must(await store.acquireRetirementControl({ objectId: current.scope.objectId }));
		expect(born.image).toEqual(before.image);
		const after = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
		expect(after.control).toEqual(born.control);
		expect(after.canonicalRows).toEqual(expected);
		expect(after.image).toEqual(before.image);
		await born.release();
		await store.close();
		expect(await store.readRetirementImage({ objectId: current.scope.objectId })).toEqual({
			ok: false,
			kind: "store-closed",
		});
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Exact native custody only: fixture signatures are not external protocol authentication.
test("journal retirement exposes exact bounded native rows with joined one-use custody", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-retirement-rows-"));
	const filename = join(directory, "journal.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		const current = anchorMaterial(0),
			next = anchorMaterial(1);
		expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
		expect(await store.installEpochAnchor(next.install)).toMatchObject({ ok: true });
		expect(
			await store.appendAccepted({
				scope: current.scope,
				sourceKind: "received",
				vertexDigest: archived.vertexDigest,
				exactCanonicalPreimageBytes: Uint8Array.from(Buffer.from(archived.vertexHex, "hex")),
				detachedSignature: current.install.detachedAnchorSignature,
			})
		).toMatchObject({ ok: true });
		const capture = must(await store.acquireRetirementControl({ objectId: current.scope.objectId }));
		const scopes = raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all();
		const rows = raw.prepare("SELECT * FROM accepted_entries ORDER BY epoch,anchor_digest,journal_sequence").all();
		const expected = [
			...scopes.map((row) => encodeCanonical(["scopes", [row.object_id, row.epoch, row.anchor_digest], { ...row }])),
			...rows.map((row) =>
				encodeCanonical([
					"accepted_entries",
					[row.object_id, row.epoch, row.anchor_digest, row.journal_sequence],
					{ ...row },
				])
			),
		];
		expect(capture.image).toEqual(
			journalRetirementImage(
				scopes.map((row) => ({ ...row })),
				rows.map((row) => ({ ...row }))
			)
		);
		expect(capture.readExactCanonicalRows()).toEqual(expected);
		const returned = capture.readExactCanonicalRows();
		expect(Object.isFrozen(returned)).toBe(true);
		returned[0]?.fill(0);
		expect(capture.readExactCanonicalRows()).toEqual(expected);
		expect(() => capture.readExactCanonicalRows.call({})).toThrow("malformed-input");
		await capture.release();
		expect(() => capture.readExactCanonicalRows()).toThrow("retirement-released");
		const stale = must(await store.acquireRetirementControl({ objectId: current.scope.objectId }));
		expect(
			await store.appendAccepted({
				scope: next.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 0,
				vertexDigest: "a".repeat(64),
			})
		).toMatchObject({ ok: true });
		const before = raw.prepare("SELECT * FROM retirement_controls").all();
		expect(
			await stale.prepareFence({
				decisionDigest: "b".repeat(64),
				sourceProofDigest: "c".repeat(64),
				throughEpoch: 1,
				protectedScopes: [current.scope, next.scope],
			})
		).toEqual({ ok: false, kind: "retirement-stale" });
		expect(() => stale.readExactCanonicalRows()).toThrow("retirement-released");
		await stale.release();
		expect(raw.prepare("SELECT * FROM retirement_controls").all()).toEqual(before);
		expect(raw.prepare("SELECT count(*) AS n FROM scopes").get()?.n).toBe(2);
		expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(2);
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Mechanical native checkpoint persistence, not authenticated deletion authority.
test.each(["local", "received", "mixed"] as const)(
	"journal bounded %s detail drain atomically preserves headers and resumes exact source after SQLite reopen",
	async (variant) => {
		const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-detail-drain-"));
		const filename = join(directory, "journal.sqlite");
		let store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
		const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
		try {
			const old = anchorMaterial(0),
				current = anchorMaterial(1);
			const selector = { objectId: old.scope.objectId };
			expect(await store.installGenesis(old.install)).toMatchObject({ ok: true });
			expect(await store.installEpochAnchor(current.install)).toMatchObject({ ok: true });
			const sourceFields = decodeCanonical(Uint8Array.from(Buffer.from(archived.vertexHex, "hex"))) as Record<
				string,
				unknown
			>;
			for (let i = 0; i < 17; i++) {
				const received = variant === "received" || (variant === "mixed" && i % 2 === 0);
				const preimage = encodeCanonical({ ...sourceFields, authorSequence: i, logicalTime: i + 1 });
				expect(
					await store.appendAccepted(
						received
							? {
									scope: old.scope,
									sourceKind: "received",
									vertexDigest: Buffer.from(hashDomain("ts-drp/vertex/v3", preimage)).toString("hex"),
									exactCanonicalPreimageBytes: preimage,
									detachedSignature: old.install.detachedAnchorSignature,
								}
							: {
									scope: old.scope,
									sourceKind: "local-issued",
									author: "creator",
									authorSequence: i,
									vertexDigest: (i + 1).toString(16).padStart(64, "0"),
								}
					)
				).toMatchObject({ ok: true });
			}
			const live = {
				scope: current.scope,
				sourceKind: "local-issued" as const,
				author: "creator",
				authorSequence: 17,
				vertexDigest: "e".repeat(64),
			};
			expect(await store.appendAccepted(live)).toMatchObject({ ok: true });
			if (!store.recordClosedMembership || !store.readRetirementImage)
				throw new Error("native membership/image port unavailable");
			const envelopeBefore = await store.readSignedAnchorEnvelope({ scope: old.scope, maxBytes: 131072 });
			const birth = must(await store.readRetirementImage(selector));
			expect(
				birth.canonicalRows
					.filter((bytes) => (decodeCanonical(bytes) as unknown[])[0] === "scopes")
					.every(
						(bytes) => !Object.hasOwn((decodeCanonical(bytes) as unknown[])[2] as object, "closed_membership_bytes")
					)
			).toBe(true);
			// Opaque mechanical carrier: these fixture bytes are NOT authenticated close permission.
			const membership = encodeCanonical({ kind: "mechanical-closed-membership-test", scope: old.scope, count: 17 });
			const exactMembership = membership.slice();
			const currency = (image: typeof birth) => ({
				imageDigest: image.image.imageDigest,
				controlBytes: image.control === null ? null : encodeJournalRetirementControl(image.control),
			});
			const record = store.recordClosedMembership;
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: membership,
					expectedNativeImage: currency(birth),
				})
			).toMatchObject({ ok: true, value: { idempotent: false } });
			membership[0] ^= 1;
			expect(
				raw.prepare("SELECT closed_membership_bytes FROM scopes WHERE epoch=0").get()?.closed_membership_bytes
			).toEqual(exactMembership);
			const witnessed = must(await store.readRetirementImage(selector));
			expect(witnessed.image.byteCharge).toBeGreaterThan(birth.image.byteCharge);
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: exactMembership,
					expectedNativeImage: currency(birth),
				})
			).toEqual({ ok: false, kind: "retirement-stale" });
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: exactMembership,
					expectedNativeImage: currency(witnessed),
				})
			).toMatchObject({ ok: true, value: { idempotent: true } });
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: encodeCanonical({ changed: true }),
					expectedNativeImage: currency(witnessed),
				})
			).toEqual({ ok: false, kind: "evidence-conflict" });
			let access = 0;
			expect(
				await record({
					scope: old.scope,
					get exactCanonicalMembershipBytes() {
						access++;
						return exactMembership;
					},
					expectedNativeImage: currency(witnessed),
				})
			).toEqual({ ok: false, kind: "malformed-input" });
			expect(access).toBe(0);
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1),
					expectedNativeImage: currency(witnessed),
				})
			).toEqual({ ok: false, kind: "malformed-input" });
			const oversizedImage = encodeCanonical(new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes - 32), {
				maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
			});
			expect(
				await record({
					scope: current.scope,
					exactCanonicalMembershipBytes: oversizedImage,
					expectedNativeImage: currency(witnessed),
				})
			).toEqual({ ok: false, kind: "retirement-fenced" });
			expect(must(await store.readRetirementImage(selector))).toEqual(witnessed);
			const protectedMembership = encodeCanonical({
				kind: "mechanical-protected-membership-test",
				scope: current.scope,
			});
			expect(
				await record({
					scope: current.scope,
					exactCanonicalMembershipBytes: protectedMembership,
					expectedNativeImage: currency(witnessed),
				})
			).toMatchObject({ ok: true, value: { idempotent: false } });
			expect(await store.readSignedAnchorEnvelope({ scope: old.scope, maxBytes: 131072 })).toEqual(envelopeBefore);
			const token = await store.readiness({ scope: old.scope });
			if (!token.ok || !token.ready) throw new Error("original old replay token missing");
			const preparation = {
				throughEpoch: 0,
				protectedScopes: [],
				decisionDigest: "b".repeat(64),
				sourceProofDigest: "c".repeat(64),
			};
			const prepare = must(await store.acquireRetirementControl(selector));
			must(await prepare.prepareFence(preparation));
			await prepare.release();
			const commit = must(await store.acquireRetirementControl(selector));
			must(await commit.commitPrepared());
			await commit.release();
			const before = must(await store.readRetirementImage(selector));
			if (before.control === null) throw new Error("completed native control missing");
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: exactMembership,
					expectedNativeImage: {
						imageDigest: before.image.imageDigest,
						controlBytes: encodeJournalRetirementControl({ ...before.control, revision: before.control.revision + 1 }),
					},
				})
			).toEqual({ ok: false, kind: "retirement-stale" });
			const headers = raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all();
			const nativeRows = raw.prepare("SELECT * FROM accepted_entries WHERE epoch=0 ORDER BY journal_sequence").all();
			const rows = nativeRows.map((row) => {
				const frame = encodeCanonical([
					"accepted_entries",
					[row.object_id, row.epoch, row.anchor_digest, row.journal_sequence],
					{ ...row },
				]);
				const received = row.source_kind === "received";
				const original = received
					? (decodeCanonical(row.received_preimage as Uint8Array) as Record<string, unknown>)
					: undefined;
				return {
					journalSequence: row.journal_sequence as number,
					vertexDigest: row.vertex_digest as string,
					author: (received ? original?.author : row.local_author) as string,
					authorSequence: (received ? original?.authorSequence : row.local_author_sequence) as number,
					nativeFrameDigest: journalRetirementFrameDigest(frame),
					...(received ? { exactCanonicalNativeFrameBytes: frame } : {}),
				};
			});
			const plan = {
				baseControl: before.control,
				sourceImage: before.image,
				prefixes: [{ scope: old.scope, highWatermark: 17, rows }],
			};
			if (variant !== "local") {
				const captured = captureJournalRetirementDrainPlan(plan);
				const received = rows.find((row) => row.exactCanonicalNativeFrameBytes !== undefined)!;
				const owned = captured.prefixes[0]!.rows[received.journalSequence]!;
				expect(owned.exactCanonicalNativeFrameBytes).not.toBe(received.exactCanonicalNativeFrameBytes);
				expect(owned.exactCanonicalNativeFrameBytes).toEqual(received.exactCanonicalNativeFrameBytes);
				const { exactCanonicalNativeFrameBytes: bytes, ...metadata } = received;
				expect(journalRetirementRowCharge(owned)).toBeGreaterThan(
					journalRetirementRowCharge(metadata) + bytes!.byteLength
				);
				const detached = bytes!.slice();
				bytes!.fill(0);
				expect(owned.exactCanonicalNativeFrameBytes).toEqual(detached);
				bytes!.set(detached);
				const [table, key, native] = decodeCanonical(bytes!) as [string, unknown[], Record<string, unknown>];
				let accessed = 0;
				const accessor = Object.defineProperty({ ...received }, "exactCanonicalNativeFrameBytes", {
					enumerable: true,
					get() {
						accessed++;
						return bytes;
					},
				});
				for (const bad of [
					accessor,
					{
						...received,
						exactCanonicalNativeFrameBytes: new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1),
					},
				]) {
					expect(() =>
						captureJournalRetirementDrainPlan({
							...plan,
							prefixes: [
								{
									...plan.prefixes[0]!,
									rows: rows.map((row) => (row.journalSequence === received.journalSequence ? bad : row)),
								},
							],
						})
					).toThrow();
				}
				expect(accessed).toBe(0);
				for (const altered of [
					encodeCanonical([table, [...key.slice(0, 3), 99], native]),
					encodeCanonical([table, key, { ...native, vertex_digest: "0".repeat(64) }]),
					encodeCanonical([table, key, { ...native, received_signature: null }]),
					encodeCanonical([table, key, { ...native, local_author: "fabricated" }]),
				]) {
					const bad = {
						...received,
						exactCanonicalNativeFrameBytes: altered,
						nativeFrameDigest: journalRetirementFrameDigest(altered),
					};
					expect(() =>
						captureJournalRetirementDrainPlan({
							...plan,
							prefixes: [
								{
									...plan.prefixes[0]!,
									rows: rows.map((row) => (row.journalSequence === bad.journalSequence ? bad : row)),
								},
							],
						})
					).toThrow();
				}
				expect(must(await store.readRetirementImage(selector))).toEqual(before);
			}
			// Native frame identity is not an age-based deletion grant. A wrong
			// descriptor must refuse before any cursor or detail mutation.
			const wrongFrame = must(await store.acquireRetirementControl(selector));
			expect(
				await wrongFrame.beginDrain({
					...plan,
					prefixes: [
						{
							...plan.prefixes[0]!,
							rows: rows.map((row, index) => (index === 0 ? { ...row, nativeFrameDigest: "0".repeat(64) } : row)),
						},
					],
				})
			).toEqual({ ok: false, kind: variant === "local" ? "retirement-transition" : "malformed-input" });
			await wrongFrame.release();
			expect(must(await store.readRetirementImage(selector))).toEqual(before);
			const staleBegin = must(await store.acquireRetirementControl(selector));
			const begin = must(await store.acquireRetirementControl(selector));
			must(await begin.beginDrain(plan));
			await begin.release();
			const initial = must(await store.readRetirementImage(selector));
			expect(initial.image).toEqual(before.image);
			expect(initial.control?.drain).toMatchObject({ cursor: 0, batches: 0 });
			const native = raw.prepare("SELECT record,plan_record FROM retirement_controls").get()!;
			const initialCarriers = encodeJournalRetirementNativeCarriers(initial.control!);
			expect(initial.exactCanonicalControlCarriers).toEqual([native.record, native.plan_record]);
			expect(initialCarriers).toEqual({ controlBytes: native.record, planBytes: native.plan_record });
			expect(initialCarriers.planBytes).toEqual(encodeCanonical(plan));
			expect(initialCarriers.controlBytes.byteLength).toBeLessThan(
				encodeJournalRetirementControl(initial.control!).byteLength
			);
			expect(decodeJournalRetirementNativeCarriers(native.record, native.plan_record)).toEqual(initial.control);
			// Replay consumes the SAME store-local immutable-plan owner as cleanup,
			// but still reads both actual native carriers on every call. Warm syntax
			// must neither mask a changed/corrupt plan nor grant access to old rows.
			for (let i = 0; i < 3; i++) {
				const replay = await store.readiness({scope: current.scope});
				if (!replay.ok || !replay.ready) throw Error("protected replay unavailable during drain");
				expect(await store.readPage({scope: current.scope, snapshot: replay.snapshot, afterSequence: null, limit: 16}))
					.toMatchObject({ok: true, rows: [expect.objectContaining({journalSequence: 0})], nextSequence: null});
				expect(await store.readiness({scope: old.scope})).toEqual({ok: false, kind: "stale-snapshot"});
			}
			for (const badPlan of [null, Uint8Array.of(0), encodeCanonical({...plan, sourceImage: {...plan.sourceImage, byteCharge: 0}})]) {
				raw.prepare("UPDATE retirement_controls SET plan_record=?").run(badPlan);
				expect((await store.readiness({scope: current.scope})).ok).toBe(false);
				raw.prepare("UPDATE retirement_controls SET plan_record=?").run(native.plan_record as Uint8Array);
				expect(await store.readiness({scope: current.scope})).toMatchObject({ok: true, ready: true, rowCount: 1});
			}
			// The one-use syntax owner prepares exact postimage carriers once. They
			// must still describe its isolated private plan after every public byte
			// leaf is changed; this mechanical check does not authorize SQL deletion.
			let postimages = 0;
			const syntax = createJournalRetirementControlRead(initial.control!, initial.image,
				async (next, deletions, carriers) => {
					postimages++;
					const expected = encodeJournalRetirementNativeCarriers(next);
					expect(carriers).toEqual(expected);
					expect(carriers.planBytes).toEqual(native.plan_record);
					expect(decodeJournalRetirementNativeCarriers(carriers.controlBytes, carriers.planBytes)).toEqual(next);
					expect(deletions).toHaveLength(16);
					expect(next.drain).toMatchObject({cursor: 16, batches: 1});
					return {ok: true, value: next};
				}, initial.canonicalRows, initial.drainSource);
			syntax.exactCanonicalControlCarriers.forEach(bytes => bytes.fill(0));
			for (const prefix of syntax.control.drain!.plan.prefixes)
				for (const row of prefix.rows) row.exactCanonicalNativeFrameBytes?.fill(0);
			must(await syntax.drainBatch());
			expect(await syntax.drainBatch()).toEqual({ok: false, kind: "retirement-released"});
			await syntax.release();
			expect(postimages).toBe(1);
			expect(must(await store.readRetirementImage(selector))).toEqual(initial);
			// One store-local syntax owner may reuse only exact immutable plan bytes.
			// Exposed observations, carriers and adapter callback leaves cannot poison it.
			const codec = createJournalRetirementControlCodec();
			const parsed = codec.decode(native.record, native.plan_record);
			expect(codec.readFence(native.record, native.plan_record, current.scope)).toEqual({objectId: selector.objectId, allowed: true});
			expect(codec.readFence(native.record, native.plan_record, old.scope)).toEqual({objectId: selector.objectId, allowed: false});
			expect(codec.readFence(native.record, native.plan_record, {...current.scope, objectId: "foreign"}))
				.toEqual({objectId: selector.objectId, allowed: false});
			expect(codec.encode(parsed)).toEqual(initialCarriers);
			for (const prefix of parsed.drain!.plan.prefixes)
				for (const row of prefix.rows) row.exactCanonicalNativeFrameBytes?.fill(0);
			if (variant !== "local") expect(() => codec.encode(parsed)).toThrow();
			const fresh = codec.decode(native.record, native.plan_record);
			expect(fresh).toEqual(initial.control);
			const carrier = codec.encode(fresh); carrier.planBytes!.fill(0);
			expect(codec.decode(native.record, native.plan_record)).toEqual(initial.control);
			const input = codec.decode(native.record, native.plan_record);
			const isolated = codec.createRead(input, initial.image, async (next, deletions, carriers) => {
				for (const prefix of next.drain!.plan.prefixes)
					for (const row of prefix.rows) row.exactCanonicalNativeFrameBytes?.fill(0);
				for (const selected of deletions ?? [])
					if ("row" in selected) selected.row.exactCanonicalNativeFrameBytes?.fill(0);
				carriers.planBytes!.fill(0);
				return {ok: false, kind: "substrate-failure"};
			}, initial.canonicalRows, initial.drainSource);
			expect(await isolated.drainBatch()).toEqual({ok: false, kind: "substrate-failure"});
			await isolated.release();
			expect(codec.decode(native.record, native.plan_record)).toEqual(initial.control);
			const compact = decodeCanonical(native.record as Uint8Array) as Record<string, unknown>;
			const compactProgress = compact.drain as Record<string, unknown>;
			for (const altered of [
				{...compact, objectId: `${old.scope.objectId}-foreign`},
				{...compact, incarnation: "0".repeat(64)},
				{...compact, revision: 0},
				{...compact, drain: {...compactProgress, cursor: 1}},
			]) {
				expect(() => codec.decode(encodeCanonical(altered), native.plan_record)).toThrow();
				expect(codec.decode(native.record, native.plan_record)).toEqual(initial.control);
			}
			codec.release();
			expect(() => codec.readFence(native.record, native.plan_record, current.scope)).toThrow("retirement-released");
			expect(() => codec.decode(native.record, native.plan_record)).toThrow("retirement-released");
			expect(() => codec.encode(fresh)).toThrow("retirement-released");
			expect(() => codec.createRead(fresh, initial.image, async () => ({ok: false, kind: "substrate-failure"}),
				initial.canonicalRows)).toThrow("retirement-released");
			const progress = decodeCanonical(native.record as Uint8Array) as Record<string, unknown>;
			const descriptor = progress.drain as Record<string, unknown>;
			expect(progress).toEqual(
				journalRetirementNativeProgressFields(
					initial.control!,
					descriptor.planDigest,
					(native.plan_record as Uint8Array).byteLength,
					0,
					0,
					initial.image.imageDigest
				)
			);
			for (const [controlBytes, planBytes] of [
				[native.record, undefined],
				[encodeCanonical({ ...progress, drain: { ...descriptor, planDigest: "0".repeat(64) } }), native.plan_record],
				[encodeCanonical({ ...progress, drain: { ...descriptor, planByteLength: 0 } }), native.plan_record],
				[encodeJournalRetirementControl(before.control!), native.plan_record],
				[native.record, encodeCanonical({ ...plan, sourceImage: { ...plan.sourceImage, byteCharge: 0 } })],
				[native.record, new Uint8Array(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES)],
			])
				expect(() => decodeJournalRetirementNativeCarriers(controlBytes, planBytes)).toThrow();
			// Each fresh native read and entered CAS rechecks BOTH immutable and changing
			// carriers; poisoning either cannot remove a row or acknowledge progress.
			for (const [controlBytes, planBytes] of [
				[native.record, null],
				[encodeCanonical({...progress, incarnation: "0".repeat(64)}), native.plan_record],
				// Syntactically valid advanced progress cannot invent already-deleted
				// rows: the original fresh native reconstruction must still refuse.
				[encodeCanonical({...progress, revision: initial.control!.revision + 1,
					drain: {...descriptor, cursor: 16, batches: 1}}), native.plan_record],
				[...(() => {
					const altered = encodeJournalRetirementNativeCarriers({...initial.control!, drain: {
						...initial.control!.drain!, plan: {...initial.control!.drain!.plan,
							sourceImage: {...initial.image, imageDigest: "0".repeat(64)}},
					}});
					return [altered.controlBytes, altered.planBytes!] as const;
				})()],
				[encodeCanonical({ ...progress, drain: { ...descriptor, planDigest: "0".repeat(64) } }), native.plan_record],
				[native.record, encodeCanonical({ ...plan, sourceImage: { ...plan.sourceImage, byteCharge: 0 } })],
				[native.record, new Uint8Array(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES)],
			]) {
				const entered = must(await store.acquireRetirementControl(selector));
				raw
					.prepare("UPDATE retirement_controls SET record=?,plan_record=?")
					.run(controlBytes as Uint8Array, planBytes as Uint8Array | null);
				expect((await store.readRetirementImage(selector)).ok).toBe(false);
				expect((await entered.drainBatch()).ok).toBe(false);
				await entered.release();
				expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(18);
				raw
					.prepare("UPDATE retirement_controls SET record=?,plan_record=?")
					.run(native.record as Uint8Array, native.plan_record as Uint8Array);
				expect(must(await store.readRetirementImage(selector))).toEqual(initial);
			}
			expect(await staleBegin.beginDrain(plan)).toEqual({ ok: false, kind: "retirement-stale" });
			await staleBegin.release();
			expect(must(await store.readRetirementImage(selector))).toEqual(initial);
			// Exact protected native no-ops remain possible; a genuinely new write
			// must not invalidate an unfinished checkpoint's source.
			expect(await store.installEpochAnchor(current.install)).toMatchObject({ ok: true, idempotent: true });
			expect(await store.appendAccepted(live)).toMatchObject({ ok: true, idempotent: true });
			expect(await store.appendAccepted({ ...live, authorSequence: 18, vertexDigest: "f".repeat(64) })).toEqual({
				ok: false,
				kind: "retirement-fenced",
			});
			expect(must(await store.readRetirementImage(selector))).toEqual(initial);
			// Test-only native fault: abort the second exact point DELETE. This is
			// transaction-abort evidence, not a process death or authentication proof.
			raw.exec(
				"CREATE TRIGGER detail_drain_test_abort BEFORE DELETE ON accepted_entries WHEN OLD.journal_sequence=1 BEGIN SELECT RAISE(ABORT,'detail-drain-test-abort'); END"
			);
			const aborted = must(await store.acquireRetirementControl(selector));
			expect(await aborted.drainBatch()).toEqual({ ok: false, kind: "substrate-failure" });
			await aborted.release();
			expect(must(await store.readRetirementImage(selector))).toEqual(initial);
			raw.exec("DROP TRIGGER detail_drain_test_abort");
			const staleBatch = must(await store.acquireRetirementControl(selector));
			const batch = must(await store.acquireRetirementControl(selector));
			expect(batch.exactCanonicalControlCarriers).toEqual(initial.exactCanonicalControlCarriers);
			// Public carriers are detached from the private native CAS source.
			batch.exactCanonicalControlCarriers[1]!.fill(0);
			if (variant !== "local") {
				// A validated public control is still untrusted at the next public
				// codec call: its exposed typed-array leaves can be changed. Neither
				// that change nor carrier mutation may change the private CAS plan.
				const exposed = batch.control.drain!.plan.prefixes[0]!.rows
					.find(row => row.exactCanonicalNativeFrameBytes !== undefined)!;
				exposed.exactCanonicalNativeFrameBytes!.fill(0);
				expect(() => encodeJournalRetirementControl(batch.control)).toThrow();
				expect(() => encodeJournalRetirementNativeCarriers(batch.control)).toThrow();
				expect(decodeJournalRetirementNativeCarriers(native.record, native.plan_record)).toEqual(initial.control);
			}
			const originalExec = DatabaseSync.prototype.exec;
			const writers = new WeakSet<DatabaseSync>();
			let lostAcknowledgement = 0;
			DatabaseSync.prototype.exec = function (sql: string): void {
				Reflect.apply(originalExec, this, [sql]);
				if (sql === "BEGIN IMMEDIATE") writers.add(this);
				if (sql === "BEGIN" || sql === "ROLLBACK") writers.delete(this);
				if (sql === "COMMIT" && writers.has(this)) {
					writers.delete(this);
					if (lostAcknowledgement++ === 0) throw new Error("journal test-owned COMMIT acknowledgement loss");
				}
			};
			try {
				must(await batch.drainBatch());
			} finally {
				DatabaseSync.prototype.exec = originalExec;
				await batch.release();
			}
			expect(lostAcknowledgement).toBe(1);
			const partial = must(await store.readRetirementImage(selector));
			expect(partial.exactCanonicalControlCarriers[1]).toEqual(initial.exactCanonicalControlCarriers[1]);
			expect(partial.exactCanonicalControlCarriers[0]).not.toEqual(initial.exactCanonicalControlCarriers[0]);
			expect(raw.prepare("SELECT plan_record FROM retirement_controls").get()?.plan_record).toEqual(native.plan_record);
			expect(
				await record({
					scope: old.scope,
					exactCanonicalMembershipBytes: exactMembership,
					expectedNativeImage: currency(partial),
				})
			).toMatchObject({ ok: true, value: { idempotent: true } });
			expect(must(await store.readRetirementImage(selector))).toEqual(partial);
			expect(partial.control?.drain).toMatchObject({ cursor: 16, batches: 1 });
			expect(partial.image.rowCount).toBe(2);
			expect(
				raw.prepare("SELECT closed_membership_bytes FROM scopes WHERE epoch=0").get()?.closed_membership_bytes
			).toEqual(exactMembership);
			expect(await staleBatch.drainBatch()).toEqual({ ok: false, kind: "retirement-stale" });
			await staleBatch.release();
			expect(must(await store.readRetirementImage(selector))).toEqual(partial);
			expect(partial.drainSource).toEqual({
				control: before.control,
				image: before.image,
				canonicalRows: before.canonicalRows,
			});
			expect(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all()).toEqual(headers);
			await store.close();
			// Exact previously supported v3 persisted checkpoint: migration must move
			// its complete original inline plan, not synthesize any received metadata.
			raw.prepare("UPDATE retirement_controls SET record=?").run(encodeJournalRetirementControl(partial.control!));
			raw.exec("ALTER TABLE retirement_controls DROP COLUMN plan_record; PRAGMA user_version=3");
			store = createNodeDurableLiveJournalStore({ primaryFilename: filename, initialization: "reopen" });
			expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
			expect(must(await store.readRetirementImage(selector))).toEqual(partial);
			const finish = must(await store.acquireRetirementControl(selector));
			must(await finish.drainBatch());
			await finish.release();
			const complete = must(await store.readRetirementImage(selector));
			expect(complete.exactCanonicalControlCarriers[1]).toEqual(initial.exactCanonicalControlCarriers[1]);
			expect(complete.control?.drain).toMatchObject({ cursor: 17, batches: 2 });
			expect(complete.image.rowCount).toBe(1);
			expect(complete.drainSource).toEqual(partial.drainSource);
			expect(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all()).toEqual(headers);
			expect(await store.readPage({ scope: old.scope, snapshot: token.snapshot, limit: 1 })).toEqual({
				ok: false,
				kind: "stale-snapshot",
			});
			expect(await store.installGenesis(old.install)).toEqual({ ok: false, kind: "retirement-fenced" });
			expect(
				await store.appendAccepted({
					scope: old.scope,
					sourceKind: "local-issued",
					author: "creator",
					authorSequence: 0,
					vertexDigest: "1".padStart(64, "0"),
				})
			).toEqual({ ok: false, kind: "retirement-fenced" });
			expect(await store.appendAccepted({ ...live, authorSequence: 18, vertexDigest: "f".repeat(64) })).toMatchObject({
				ok: true,
				idempotent: false,
			});
			const advanced = must(await store.readRetirementImage(selector));
			expect(advanced.exactCanonicalControlCarriers).toHaveLength(1);
			expect(raw.prepare("SELECT plan_record FROM retirement_controls").get()?.plan_record).toBeNull();
			const clean = raw.prepare("SELECT record FROM retirement_controls").get()!.record;
			raw.prepare("UPDATE retirement_controls SET plan_record=?").run(native.plan_record as Uint8Array);
			expect((await store.readRetirementImage(selector)).ok).toBe(false);
			raw.prepare("UPDATE retirement_controls SET record=?,plan_record=NULL").run(clean as Uint8Array);
			expect(must(await store.readRetirementImage(selector))).toEqual(advanced);
			expect(advanced.image.rowCount).toBe(2);
			expect(advanced.drainSource).toBeUndefined();
			expect(advanced.control?.drain).toBeNull();
			expect(
				raw.prepare("SELECT closed_membership_bytes FROM scopes WHERE epoch=0").get()?.closed_membership_bytes
			).toBeNull();
			expect(
				raw.prepare("SELECT closed_membership_bytes FROM scopes WHERE epoch=1").get()?.closed_membership_bytes
			).toEqual(protectedMembership);
			expect(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all()).toEqual([
				{ ...headers[0], closed_membership_bytes: null },
				{ ...headers[1], next_journal_sequence: 2 },
			]);
		} finally {
			raw.exec("DROP TRIGGER IF EXISTS detail_drain_test_abort");
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
);

// Mechanical native checkpoint persistence, not authenticated deletion authority.
test("journal exact current-v2 membership migration preserves rows controls floors and absent frame encoding", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-current-v2-membership-"));
	const filename = join(directory, "journal.sqlite"),
		old = anchorMaterial(0),
		current = anchorMaterial(1);
	let store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		expect(await store.installGenesis(old.install)).toMatchObject({ ok: true });
		expect(await store.installEpochAnchor(current.install)).toMatchObject({ ok: true });
		expect(
			await store.appendAccepted({
				scope: current.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 0,
				vertexDigest: "a".repeat(64),
			})
		).toMatchObject({ ok: true });
		if (!store.acquireRetirementControl || !store.readRetirementImage)
			throw new Error("original native retirement port unavailable");
		const prepare = must(await store.acquireRetirementControl({ objectId: old.scope.objectId }));
		must(
			await prepare.prepareFence({
				throughEpoch: 0,
				protectedScopes: [],
				decisionDigest: "b".repeat(64),
				sourceProofDigest: "c".repeat(64),
			})
		);
		await prepare.release();
		const commit = must(await store.acquireRetirementControl({ objectId: old.scope.objectId }));
		must(await commit.commitPrepared());
		await commit.release();
		const before = must(await store.readRetirementImage({ objectId: old.scope.objectId }));
		const rowsBefore = raw.prepare("SELECT * FROM accepted_entries ORDER BY epoch,journal_sequence").all();
		const controlsBefore = raw.prepare("SELECT * FROM retirement_controls ORDER BY object_id").all();
		await store.close();
		// Reproduce the exact supported current-v2 catalog, not an arbitrary older schema.
		raw.exec(
			"ALTER TABLE scopes DROP COLUMN closed_membership_bytes; ALTER TABLE retirement_controls DROP COLUMN plan_record; PRAGMA user_version=2"
		);
		const scopesBefore = raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all();
		const v2Schema = raw.prepare("SELECT sql FROM sqlite_schema WHERE name='scopes'").get()?.sql as string;
		expect(v2Schema).not.toContain("closed_membership_bytes");
		store = createNodeDurableLiveJournalStore({ primaryFilename: filename, initialization: "reopen" });
		expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
		expect(raw.prepare("SELECT sql FROM sqlite_schema WHERE name='scopes'").get()?.sql).toBe(
			v2Schema.replace(
				"exact_parameters_carrier BLOB NOT NULL,",
				"exact_parameters_carrier BLOB NOT NULL, closed_membership_bytes BLOB,"
			)
		);
		expect(raw.prepare("SELECT * FROM accepted_entries ORDER BY epoch,journal_sequence").all()).toEqual(rowsBefore);
		expect(raw.prepare("SELECT * FROM retirement_controls ORDER BY object_id").all()).toEqual(controlsBefore);
		expect(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all()).toEqual(
			scopesBefore.map((row) => ({ ...row, closed_membership_bytes: null }))
		);
		expect(
			journalRetirementImage(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all(), rowsBefore)
		).toEqual(before.image);
		if (!store.readRetirementImage) throw new Error("reopened image port unavailable");
		expect(must(await store.readRetirementImage({ objectId: old.scope.objectId }))).toEqual(before);
		expect(
			await store.appendAccepted({
				scope: old.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 0,
				vertexDigest: "d".repeat(64),
			})
		).toEqual({ ok: false, kind: "retirement-fenced" });
		expect(
			await store.appendAccepted({
				scope: current.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 1,
				vertexDigest: "e".repeat(64),
			})
		).toMatchObject({ ok: true, idempotent: false });
		await store.close();
		// Unsupported catalog drift still refuses and is never "repaired" by migration.
		raw.exec("ALTER TABLE scopes ADD COLUMN unrelated BLOB");
		expect(() => createNodeDurableLiveJournalStore({ primaryFilename: filename, initialization: "reopen" })).toThrow(
			"unsupported-schema"
		);
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("retirement completion retains bounded participant commitments through SQLite reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-retirement-completion-"));
	const filename = join(directory, "store.sqlite");
	let store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	try {
		const objectId = must(parseStorageObjectId(`retirement-completion:${"a".repeat(32)}`));
		const generationId = must(parseGenerationId("a".repeat(64)));
		const bytes = Uint8Array.of(1);
		const digest = must(digestBlob(bytes));
		const absent = { kind: "none" as const, objectId };
		must(
			await store.beginGeneration({
				objectId,
				generationId,
				baseExpectedHead: absent,
				closure: [{ digest, byteLength: bytes.byteLength }],
			})
		);
		must(await store.putCachedBlob({ objectId, generationId, digest, bytes }));
		must(await store.promoteReference({ objectId, generationId, digest }));
		must(await store.completeGeneration({ objectId, generationId }));
		const head = must(await store.swapHead({ objectId, generationId, expectedHead: absent })).head;
		const record = raw
			.prepare("SELECT record FROM generations WHERE object_id=? AND generation_id=?")
			.get(objectId, generationId)?.record as Uint8Array;
		const generation = must(decodeGenerationRecordV1(record));
		const recordDigest = must(digestBlob(record));
		const domains = Array.from(
			{ length: 8 },
			(_, index) =>
				[
					2 ** index,
					new Uint8Array(32).fill(index + 1),
					new Uint8Array(32).fill(index + 2),
					index,
					new Uint8Array(32).fill(index + 3),
					new Uint8Array(32).fill(index + 4),
					index + 1,
				] as const
		);
		const preparation: AheRetirementPreparation = {
			head,
			floorEpoch: 2,
			floorAnchor: "c".repeat(64),
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
			generationRecordDigests: [recordDigest],
			snapshotScopes: [],
			protectedIndices: [],
			retireIndices: [],
			domains,
		};
		const payloadImage = (): unknown => [
			raw.prepare("SELECT * FROM generations ORDER BY object_id,generation_id").all(),
			raw.prepare("SELECT * FROM blobs ORDER BY digest").all(),
			raw.prepare("SELECT * FROM promotions ORDER BY object_id,generation_id,digest").all(),
		];
		const before = payloadImage();
		if (store.acquireRetirementControl === undefined) throw new TypeError("retirement control is unavailable");
		const capture = must(await store.acquireRetirementControl(objectId));
		const prepared = must(
			await capture.prepareBound({
				preparation,
				generations: {
					recordDigests: [recordDigest],
					identities: [{ generationId, identityDigest: aheRetirementGenerationIdentity(generation) }],
					protectedIndices: [0],
					retireIndices: [],
				},
			})
		);
		await capture.release();
		expect(prepared.active?.preparation.domains).toEqual(domains);
		const commit = must(await store.acquireRetirementControl(objectId));
		const completed = must(
			await commit.commitPrepared({
				decisionDigest: preparation.decisionDigest,
				sourceProofDigest: preparation.sourceProofDigest,
			})
		);
		await commit.release();
		// Reach the actual native completion before the new persistence oracle.
		expect(completed.active).toBeNull();
		expect(completed.completed).toMatchObject({
			decisionDigest: preparation.decisionDigest,
			sourceProofDigest: preparation.sourceProofDigest,
			domains,
		});
		const nativeBytes = raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)
			?.record as Uint8Array;
		expect(nativeBytes).toEqual(encodeAheRetirementControl(completed));
		expect(encodeAheRetirementControl(must(decodeAheRetirementControl(nativeBytes)))).toEqual(nativeBytes);
		expect(payloadImage()).toEqual(before);
		expect(await store.readHead(objectId)).toEqual({ ok: true, value: head });
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		if (store.acquireRetirementControl === undefined) throw new TypeError("reopened retirement control is unavailable");
		const reopened = must(await store.acquireRetirementControl(objectId));
		expect(reopened.control).toEqual(completed);
		expect(encodeAheRetirementControl(reopened.control)).toEqual(nativeBytes);
		await reopened.release();
		expect(payloadImage()).toEqual(before);
		expect(await store.readHead(objectId)).toEqual({ ok: true, value: head });
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("AHE admission image observes absent control without native birth", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-ahe-admission-image-"));
	const filename = join(directory, "store.sqlite");
	let store = createSqliteAheDurableStore({ filename });
	let held: NativeReadReservation | undefined;
	const raw = new DatabaseSync(filename);
	const native = (): readonly unknown[] =>
		[
			["objects", "object_id"],
			["generations", "object_id,generation_id"],
			["promotions", "object_id,generation_id,digest"],
			["blobs", "digest"],
			["retirement_controls", "object_id"],
		].map(([table, order]) => raw.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all());
	try {
		const objectId = must(parseStorageObjectId(`admission-image:${"c".repeat(32)}`));
		const currentId = must(parseGenerationId("c".repeat(64))),
			stagedId = must(parseGenerationId("d".repeat(64)));
		const bytes = Uint8Array.of(1),
			digest = must(digestBlob(bytes));
		const stagedBytes = Uint8Array.of(2),
			stagedDigest = must(digestBlob(stagedBytes));
		const absent = { kind: "none" as const, objectId };
		must(
			await store.beginGeneration({
				objectId,
				generationId: currentId,
				baseExpectedHead: absent,
				closure: [{ digest, byteLength: bytes.byteLength }],
			})
		);
		must(await store.putCachedBlob({ objectId, generationId: currentId, digest, bytes }));
		must(await store.promoteReference({ objectId, generationId: currentId, digest }));
		must(await store.completeGeneration({ objectId, generationId: currentId }));
		const head = must(await store.swapHead({ objectId, generationId: currentId, expectedHead: absent })).head;
		must(
			await store.beginGeneration({
				objectId,
				generationId: stagedId,
				baseExpectedHead: head,
				closure: [{ digest: stagedDigest, byteLength: stagedBytes.byteLength }],
			})
		);
		const reader = store.readRetirementAdmissionImage;
		if (reader === undefined || store.readRetirementImage === undefined || store.acquireRetirementControl === undefined)
			throw new Error("AHE_ABSENT_ADMISSION_IMAGE_READER_UNAVAILABLE");
		const before = native();
		const point = must(await reader.call(store, objectId));
		expect(point).toMatchObject({ control: null, head, metadataBytes: 0 });
		expect(point.imageDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(Object.isFrozen(point)).toBe(true);
		expect(must(await reader.call(store, objectId))).toEqual(point);
		expect(await store.readRetirementImage(objectId)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect(native()).toEqual(before);
		raw.prepare("INSERT INTO blobs(digest,bytes) VALUES (?,?)").run(stagedDigest, stagedBytes);
		const changed = must(await reader.call(store, objectId));
		expect(changed.imageDigest).not.toBe(point.imageDigest);
		expect(changed).toMatchObject({ control: null, head, metadataBytes: 0 });
		expect(raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n).toBe(0);
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		const reopened = store.readRetirementAdmissionImage;
		if (
			reopened === undefined ||
			store.acquireRetirementControl === undefined ||
			store.readRetirementImage === undefined
		)
			throw new Error("AHE_ABSENT_ADMISSION_IMAGE_REOPEN_UNAVAILABLE");
		expect(must(await reopened.call(store, objectId))).toEqual(changed);
		const view = must(await store.acquireRetirementControl(objectId));
		try {
			const present = must(await reopened.call(store, objectId));
			expect(present).toEqual(must(await store.readRetirementImage(objectId)));
			expect(present.imageDigest).toBe(changed.imageDigest);
			expect(present.control).toEqual(view.control);
			expect(present.metadataBytes).toBe(view.metadataBytes);
		} finally {
			await view.release();
		}
		const acquire = Reflect.get(store, "acquireNativeReadReservation") as
			(input: {objectId: string}) => Promise<NativeReadReservation>;
		const originalPrepare = DatabaseSync.prototype.prepare;
		let measuring = false, rawReads = 0;
		const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
			if (measuring && /\bFROM\s+"?(?:blobs|generations|promotions)\b/iu.test(sql)) rawReads++;
			return Reflect.apply(originalPrepare, this, [sql]);
		});
		const measured = async () => {
			rawReads = 0; measuring = true;
			try {return {value: await reopened.call(store, objectId), rawReads};}
			finally {measuring = false;}
		};
		try {
			held = await acquire.call(store, {objectId});
			const first = await measured(), repeated = await measured();
			expect(first.rawReads).toBeGreaterThan(0); expect(repeated.rawReads).toBe(0);
			const firstValue = must(first.value), repeatedValue = must(repeated.value);
			expect(repeatedValue).toEqual(firstValue); expect(repeatedValue.head).not.toBe(firstValue.head);
			expect(repeatedValue.control).not.toBe(firstValue.control);
			if (firstValue.control === null) throw new Error("AHE_HELD_CONTROL_NOT_BORN");
			// A public DTO cannot alter the private admitted image (the original
			// codec may itself freeze this field, so either outcome is lawful).
			Reflect.set(firstValue.control, "incarnation", "caller-mutated-incarnation");
			expect(must((await measured()).value)).toEqual(repeatedValue);
			raw.exec("PRAGMA busy_timeout=0");
			expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
			await held.check(); await held.release();
			await expect(held.check()).rejects.toThrow("RELEASED"); held = undefined;
			// Release-for-write ends the admitted lease. The next lease must scan
			// the complete newly changed image, not reuse an old scalar digest.
			raw.prepare("DELETE FROM blobs WHERE digest=?").run(stagedDigest);
			held = await acquire.call(store, {objectId});
			const afterWrite = await measured(); expect(afterWrite.rawReads).toBeGreaterThan(0);
			expect(must(afterWrite.value).imageDigest).not.toBe(repeatedValue.imageDigest);
			expect((await measured()).rawReads).toBe(0);
			await held.release(); held = undefined;
			// Actual same-count corruption BEFORE acquisition must still take the
			// original raw bounded admission path and preserve its exact refusal.
			raw.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(Uint8Array.of(255), digest);
			const originalRefusal = await reopened.call(store, objectId); expect(originalRefusal.ok).toBe(false);
			held = await acquire.call(store, {objectId});
			const corrupt = await measured(); expect(corrupt.rawReads).toBeGreaterThan(0);
			expect(corrupt.value).toEqual(originalRefusal);
			await held.release(); held = undefined;
			raw.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(bytes, digest);
			held = await acquire.call(store, {objectId});
			expect((await measured()).rawReads).toBeGreaterThan(0);
			// Joined native close uncertainty stays a rejection, and the adapter
			// revokes reuse before that failing join. Cleanup the deliberately held
			// native handle only after observing the original failure.
			const closeFailure = new Error("controlled native reservation close failure");
			const failed = {native: undefined as DatabaseSync | undefined};
			const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function (this: DatabaseSync) {
				failed.native = this; throw closeFailure;
			});
			try {
				await expect(held.release()).rejects.toBe(closeFailure);
				await expect(held.release()).rejects.toBe(closeFailure);
				await expect(held.check()).rejects.toThrow("RELEASED");
			} finally {close.mockRestore(); failed.native?.close(); held = undefined;}
			expect((await measured()).rawReads).toBeGreaterThan(0); // No lease means no reuse.
			held = await acquire.call(store, {objectId});
			expect((await measured()).rawReads).toBeGreaterThan(0);
			await store.close(); await expect(held.check()).rejects.toThrow("RELEASED");
			await held.release(); held = undefined;
		} finally {prepare.mockRestore();}
		await store.close();
		expect(await reopened.call(store, objectId)).toEqual({ ok: false, reason: "STORE_CLOSED" });
	} finally {
		await held?.release();
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Noncreating same-transaction native point evidence, not held exclusion or authentication.
test("AHE noncreating retirement point binds complete native image through reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-ahe-retirement-point-"));
	const filename = join(directory, "store.sqlite");
	let store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	try {
		const objectId = must(parseStorageObjectId(`retirement-point:${"a".repeat(32)}`));
		const currentId = must(parseGenerationId("a".repeat(64))),
			stagedId = must(parseGenerationId("b".repeat(64)));
		const bytes = Uint8Array.of(1),
			digest = must(digestBlob(bytes));
		const stagedBytes = Uint8Array.of(2),
			stagedDigest = must(digestBlob(stagedBytes));
		const absent = { kind: "none" as const, objectId };
		must(
			await store.beginGeneration({
				objectId,
				generationId: currentId,
				baseExpectedHead: absent,
				closure: [{ digest, byteLength: bytes.length }],
			})
		);
		must(await store.putCachedBlob({ objectId, generationId: currentId, digest, bytes }));
		must(await store.promoteReference({ objectId, generationId: currentId, digest }));
		must(await store.completeGeneration({ objectId, generationId: currentId }));
		const head = must(await store.swapHead({ objectId, generationId: currentId, expectedHead: absent })).head;
		must(
			await store.beginGeneration({
				objectId,
				generationId: stagedId,
				baseExpectedHead: head,
				closure: [{ digest: stagedDigest, byteLength: stagedBytes.length }],
			})
		);
		if (!store.readRetirementImage || !store.acquireRetirementControl)
			throw new Error("AHE point fixture port unavailable");
		expect(await store.readRetirementImage(objectId)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect(raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n).toBe(0);
		const view = must(await store.acquireRetirementControl(objectId));
		const point = must(await store.readRetirementImage(objectId));
		expect(point).toEqual({
			control: view.control,
			head,
			imageDigest: view.imageDigest,
			metadataBytes: view.metadataBytes,
		});
		expect(Object.isFrozen(point)).toBe(true);
		await view.release();
		const oldControl = raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)?.record;
		// Actual optional cached payload appears while head/control remain unchanged.
		raw.prepare("INSERT INTO blobs(digest,bytes) VALUES (?,?)").run(stagedDigest, stagedBytes);
		const changed = must(await store.readRetirementImage(objectId));
		expect(changed.imageDigest).not.toBe(point.imageDigest);
		expect(changed.control).toEqual(point.control);
		expect(changed.head).toEqual(head);
		expect(raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)?.record).toEqual(
			oldControl
		);
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		if (!store.readRetirementImage) throw new Error("reopened AHE point port unavailable");
		expect(must(await store.readRetirementImage(objectId))).toEqual(changed);
		await store.close();
		expect(await store.readRetirementImage(objectId)).toEqual({ ok: false, reason: "STORE_CLOSED" });
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// This is a native mechanical CAS test, not an authenticated protocol plan.
for (const mutation of ["unchanged", "generation", "promotion", "cached-blob"] as const) {
	test(`retirement image CAS ${mutation}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-drp-retirement-image-"));
		const filename = join(directory, "store.sqlite");
		const store = createSqliteAheDurableStore({ filename });
		const raw = new DatabaseSync(filename);
		try {
			const objectId = must(parseStorageObjectId(`retirement-image:${"a".repeat(32)}`));
			const currentId = must(parseGenerationId("a".repeat(64)));
			const stagedId = must(parseGenerationId("b".repeat(64)));
			const currentBytes = Uint8Array.of(1);
			const currentDigest = must(digestBlob(currentBytes));
			const stagedBytes = Uint8Array.of(2);
			const stagedDigest = must(digestBlob(stagedBytes));
			const noHead = { kind: "none" as const, objectId };
			must(
				await store.beginGeneration({
					objectId,
					generationId: currentId,
					baseExpectedHead: noHead,
					closure: [{ digest: currentDigest, byteLength: 1 }],
				})
			);
			must(
				await store.putCachedBlob({ objectId, generationId: currentId, digest: currentDigest, bytes: currentBytes })
			);
			must(await store.promoteReference({ objectId, generationId: currentId, digest: currentDigest }));
			must(await store.completeGeneration({ objectId, generationId: currentId }));
			const head = must(await store.swapHead({ objectId, generationId: currentId, expectedHead: noHead })).head;
			must(
				await store.beginGeneration({
					objectId,
					generationId: stagedId,
					baseExpectedHead: head,
					closure: [{ digest: stagedDigest, byteLength: 1 }],
				})
			);
			if (mutation === "promotion")
				must(await store.putCachedBlob({ objectId, generationId: stagedId, digest: stagedDigest, bytes: stagedBytes }));
			if (store.acquireRetirementControl === undefined) throw new TypeError("retirement control is unavailable");
			const control = must(await store.acquireRetirementControl(objectId));
			const preparation: AheRetirementPreparation = {
				head,
				floorEpoch: 2,
				floorAnchor: "c".repeat(64),
				decisionDigest: "d".repeat(64),
				sourceProofDigest: "e".repeat(64),
				generationRecordDigests: [],
				snapshotScopes: [],
				protectedIndices: [],
				retireIndices: [],
				domains: Array.from(
					{ length: 8 },
					(_, i) =>
						[2 ** i, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
				),
			};
			const before = raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)?.record;
			if (mutation === "generation") {
				const row = raw
					.prepare("SELECT record FROM generations WHERE object_id=? AND generation_id=?")
					.get(objectId, stagedId);
				const generation = must(decodeGenerationRecordV1(row?.record as Uint8Array));
				const bytes = encodeGenerationRecordV1({ ...generation, state: "Discarded" });
				raw
					.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?")
					.run(bytes, objectId, stagedId);
			} else if (mutation === "promotion") {
				raw
					.prepare("INSERT INTO promotions(object_id,generation_id,digest) VALUES (?,?,?)")
					.run(objectId, stagedId, stagedDigest);
			} else if (mutation === "cached-blob") {
				raw.prepare("INSERT INTO blobs(digest,bytes) VALUES (?,?)").run(stagedDigest, stagedBytes);
			}
			const result = await control.prepare(preparation);
			if (mutation === "unchanged")
				expect(result).toMatchObject({ ok: true, value: { active: { phase: "prepared" } } });
			else {
				expect(result).toEqual({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
				expect(raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)?.record).toEqual(
					before
				);
				expect(await store.readHead(objectId)).toEqual({ ok: true, value: head });
			}
			await control.release();
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

/**
 * Complete physical AHE image, including native control; no protocol authority.
 * @param raw - Same-file native observation connection.
 * @returns Complete physical tables in canonical key order.
 */
function boundedAheSqliteImage(
	raw: DatabaseSync
): Record<"objects" | "generations" | "promotions" | "blobs" | "controls", Record<string, unknown>[]> {
	return {
		objects: raw
			.prepare("SELECT * FROM objects ORDER BY object_id")
			.all()
			.map((row) => ({ ...row })),
		generations: raw
			.prepare("SELECT * FROM generations ORDER BY object_id,generation_id")
			.all()
			.map((row) => ({ ...row })),
		promotions: raw
			.prepare("SELECT * FROM promotions ORDER BY object_id,generation_id,digest")
			.all()
			.map((row) => ({ ...row })),
		blobs: raw
			.prepare("SELECT * FROM blobs ORDER BY digest")
			.all()
			.map((row) => ({ ...row })),
		controls: raw
			.prepare("SELECT * FROM retirement_controls ORDER BY object_id")
			.all()
			.map((row) => ({ ...row })),
	};
}

// Synthetic domains/classification are mechanical premises, never authenticated eligibility.
test("bounded AHE checkpoint reclaims one generation and preserves foreign shared bytes through SQLite reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-ahe-bounded-shared-"));
	const filename = join(directory, "store.sqlite");
	let store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	try {
		const fixture = await d109cBoundedCheckpoint(store, true);
		if (!store.acquireRetirementControl || !store.readRetirementImage) throw new Error("bounded AHE port missing");
		const before = boundedAheSqliteImage(raw);
		const read = must(await store.acquireRetirementControl(fixture.objectId));
		const pending = read.control;
		expect(pending.completed?.generationDrain).toEqual({ source: fixture.source, phase: "pending" });
		const completed = must(await read.reclaimBoundedGeneration());
		await read.release();
		expect(completed).toEqual({
			...pending,
			revision: pending.revision + 1,
			completed: {
				...pending.completed,
				generationHoles: fixture.source.postGenerations.recordDigests,
				generationIdentities: fixture.source.postGenerations.identities,
				generationDrain: { source: fixture.source, phase: "complete" },
			},
		});
		const after = boundedAheSqliteImage(raw);
		expect(after.objects).toEqual(before.objects);
		expect(after.generations).toEqual(
			before.generations
				.filter((row) => row.object_id !== fixture.objectId || row.generation_id !== d109cGenerationId(1))
				.map((row) =>
					row.object_id === fixture.objectId && row.generation_id === d109cGenerationId(2)
						? { ...row, record: encodeGenerationRecordV1(fixture.decision.floor.rewrittenGeneration) }
						: row
				)
		);
		expect(after.promotions).toEqual(
			before.promotions.filter(
				(row) => row.object_id !== fixture.objectId || row.generation_id !== d109cGenerationId(1)
			)
		);
		expect(after.blobs).toEqual(
			before.blobs.filter((row) => !fixture.decision.deleteBlobDigests.includes(row.digest as BlobDigest))
		);
		expect(after.controls).toEqual([{ object_id: fixture.objectId, record: encodeAheRetirementControl(completed) }]);
		const deletes =
			before.generations.length -
			after.generations.length +
			before.promotions.length -
			after.promotions.length +
			before.blobs.length -
			after.blobs.length;
		expect(deletes).toBe(14); // 1 + 7 + 6; the seventh blob is genuinely foreign-owned.
		expect(deletes).toBeLessThanOrEqual(15);
		expect(must(await store.getBlob(fixture.shared.digest))).toEqual(Uint8Array.of(1, 0, 101));
		expect(raw.prepare("SELECT bytes FROM blobs WHERE digest=?").get(fixture.shared.digest)?.bytes).toEqual(
			Uint8Array.of(1, 0, 101)
		);
		const point = must(await store.readRetirementImage(fixture.objectId));
		expect(point.imageDigest).toBe(fixture.source.postImageDigest);
		expect(point.head).toEqual(fixture.head);
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		if (!store.readRetirementImage) throw new Error("reopened bounded AHE port missing");
		expect(must(await store.readRetirementImage(fixture.objectId))).toEqual(point);
		expect(boundedAheSqliteImage(raw)).toEqual(after);
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Actual DELETE abort + actual COMMIT acknowledgement throw; no copied native state.
test("bounded AHE checkpoint keeps whole OLD on DELETE abort and reads complete NEW after SQLite commit acknowledgement loss", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-ahe-bounded-atomic-"));
	const filename = join(directory, "store.sqlite");
	let store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	const originalExec = DatabaseSync.prototype.exec;
	const originalPrepare = DatabaseSync.prototype.prepare;
	try {
		const fixture = await d109cBoundedCheckpoint(store);
		if (!store.acquireRetirementControl) throw new Error("bounded AHE port missing");
		const before = boundedAheSqliteImage(raw);
		const abortRead = must(await store.acquireRetirementControl(fixture.objectId));
		const deletePromotionSql = "DELETE FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?";
		let abortDeletes = 0;
		// An added trigger would invalidate the original exact schema admission.
		// Delegate the actual native DELETE and throw only after its second success.
		DatabaseSync.prototype.prepare = function (sql: string): ReturnType<typeof originalPrepare> {
			const statement = Reflect.apply(originalPrepare, this, [sql]);
			if (sql === deletePromotionSql) {
				const originalRun = statement.run;
				statement.run = function (...parameters: unknown[]): ReturnType<typeof originalRun> {
					const result = Reflect.apply(originalRun, this, parameters);
					if (parameters[0] === fixture.objectId && parameters[1] === d109cGenerationId(1)) {
						expect(result.changes).toBe(1);
						if (++abortDeletes === 2) throw new Error("bounded actual DELETE abort");
					}
					return result;
				};
			}
			return statement;
		};
		try {
			expect(await abortRead.reclaimBoundedGeneration()).toMatchObject({
				ok: false,
				reason: "SUBSTRATE_FAILURE",
				cause: expect.objectContaining({ message: expect.stringContaining("bounded actual DELETE abort") }),
			});
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
			await abortRead.release();
		}
		expect(abortDeletes).toBe(2);
		expect(boundedAheSqliteImage(raw)).toEqual(before);
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		if (!store.acquireRetirementControl) throw new Error("reopened bounded AHE port missing");
		const retry = must(await store.acquireRetirementControl(fixture.objectId));
		expect(retry.control.completed?.generationDrain?.phase).toBe("pending");
		let lost = 0;
		const writeConnections = new WeakSet<DatabaseSync>();
		const deleteConnections = new WeakSet<DatabaseSync>();
		let committedPromotionDeletes = 0;
		DatabaseSync.prototype.prepare = function (sql: string): ReturnType<typeof originalPrepare> {
			const statement = Reflect.apply(originalPrepare, this, [sql]);
			if (sql === deletePromotionSql) {
				deleteConnections.add(this);
				const originalRun = statement.run;
				statement.run = function (...parameters: unknown[]): ReturnType<typeof originalRun> {
					const result = Reflect.apply(originalRun, this, parameters);
					if (parameters[0] === fixture.objectId && parameters[1] === d109cGenerationId(1)) {
						expect(result.changes).toBe(1);
						committedPromotionDeletes++;
					}
					return result;
				};
			}
			return statement;
		};
		DatabaseSync.prototype.exec = function (sql: string): void {
			Reflect.apply(originalExec, this, [sql]);
			if (sql === "BEGIN IMMEDIATE") writeConnections.add(this);
			if (sql === "BEGIN" || sql === "ROLLBACK") writeConnections.delete(this);
			const committedWrite = sql === "COMMIT" && writeConnections.has(this);
			if (sql === "COMMIT") writeConnections.delete(this);
			if (committedWrite && deleteConnections.has(this) && committedPromotionDeletes === 7 && lost === 0) {
				lost++;
				throw new Error("test-owned native COMMIT delivery loss");
			}
		};
		let completed;
		try {
			completed = must(await retry.reclaimBoundedGeneration());
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
			DatabaseSync.prototype.exec = originalExec;
			await retry.release();
		}
		expect(lost).toBe(1);
		expect(committedPromotionDeletes).toBe(7);
		expect(completed.completed?.generationDrain).toEqual({ source: fixture.source, phase: "complete" });
		const after = boundedAheSqliteImage(raw);
		const deletes =
			before.generations.length -
			after.generations.length +
			before.promotions.length -
			after.promotions.length +
			before.blobs.length -
			after.blobs.length;
		expect(deletes).toBe(15); // The exact admitted ceiling, not merely the literal native cap16.
		expect(after.objects).toEqual(before.objects);
		expect(after.generations).toEqual(
			before.generations
				.filter((row) => row.generation_id !== d109cGenerationId(1))
				.map((row) =>
					row.generation_id === d109cGenerationId(2)
						? { ...row, record: encodeGenerationRecordV1(fixture.decision.floor.rewrittenGeneration) }
						: row
				)
		);
		expect(after.promotions).toEqual(before.promotions.filter((row) => row.generation_id !== d109cGenerationId(1)));
		expect(after.blobs).toEqual(
			before.blobs.filter((row) => !fixture.decision.deleteBlobDigests.includes(row.digest as BlobDigest))
		);
		expect(after.controls).toEqual([{ object_id: fixture.objectId, record: encodeAheRetirementControl(completed) }]);
		await store.close();
		store = createSqliteAheDurableStore({ filename });
		if (!store.readRetirementImage) throw new Error("reopened bounded AHE point missing");
		const current = must(await store.readRetirementImage(fixture.objectId));
		expect(current.control).toEqual(completed);
		expect(current.imageDigest).toBe(fixture.source.postImageDigest);
		expect(current.head).toEqual(fixture.head);
		expect(boundedAheSqliteImage(raw)).toEqual(after);
	} finally {
		DatabaseSync.prototype.prepare = originalPrepare;
		DatabaseSync.prototype.exec = originalExec;
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Raw exact currency negatives are not protocol grants or a public future-capability fixture.
test("bounded AHE checkpoint refuses stale currency and pending future work then permits fresh native preparation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-ahe-bounded-currency-"));
	const filename = join(directory, "store.sqlite");
	const store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	try {
		const fixture = await d109cBoundedCheckpoint(store);
		if (!store.acquireRetirementControl) throw new Error("bounded AHE port missing");
		const before = boundedAheSqliteImage(raw);
		for (const method of ["stageNominatedFutureGeneration", "publishNominatedFutureGeneration"] as const) {
			const read = must(await store.acquireRetirementControl(fixture.objectId));
			try {
				expect(await read[method]({})).toEqual({ ok: false, reason: "RETIREMENT_FENCED" });
			} finally {
				await read.release();
			}
			expect(boundedAheSqliteImage(raw)).toEqual(before);
		}
		const prepare = must(await store.acquireRetirementControl(fixture.objectId));
		try {
			expect(
				await prepare.prepareBound({ preparation: fixture.preparation, generations: fixture.source.generations })
			).toEqual({ ok: false, reason: "RETIREMENT_FENCED" });
		} finally {
			await prepare.release();
		}
		expect(boundedAheSqliteImage(raw)).toEqual(before);
		for (const mutation of ["head", "image", "incarnation", "revision", "source", "decision"] as const) {
			const stale = must(await store.acquireRetirementControl(fixture.objectId));
			const oldControlBytes = before.controls[0]?.record;
			const oldHead = before.objects.find((row) => row.object_id === fixture.objectId);
			const oldGeneration = before.generations.find((row) => row.generation_id === d109cGenerationId(3));
			if (
				!(oldControlBytes instanceof Uint8Array) ||
				!oldHead ||
				!oldGeneration ||
				!(oldHead.head_record instanceof Uint8Array) ||
				!(oldGeneration.record instanceof Uint8Array) ||
				typeof oldGeneration.generation_id !== "string"
			)
				throw new Error("bounded stale native source missing");
			try {
				if (mutation === "head")
					raw
						.prepare("UPDATE objects SET head_record=? WHERE object_id=?")
						.run(
							encodeHeadRecordV1({ ...fixture.head, revision: must(parseHeadRevision(fixture.head.revision + 1)) }),
							fixture.objectId
						);
				else if (mutation === "image") {
					const generation = must(decodeGenerationRecordV1(oldGeneration.record as Uint8Array));
					raw.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?").run(
						encodeGenerationRecordV1({
							...generation,
							baseExpectedHead: { kind: "none", objectId: fixture.objectId },
						}),
						fixture.objectId,
						generation.generationId
					);
				} else {
					const control = stale.control;
					const completed = control.completed;
					if (!completed?.generationDrain) throw new Error("bounded stale control missing");
					const next =
						mutation === "incarnation"
							? { ...control, incarnation: "f".repeat(64) }
							: mutation === "revision"
								? { ...control, revision: control.revision + 1 }
								: mutation === "decision"
									? { ...control, completed: { ...completed, decisionDigest: "f".repeat(64) } }
									: {
											...control,
											completed: {
												...completed,
												generationDrain: {
													...completed.generationDrain,
													source: { ...completed.generationDrain.source, resumeBasisDigest: "f".repeat(64) },
												},
											},
										};
					raw
						.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?")
						.run(encodeAheRetirementControl(next), fixture.objectId);
				}
				const changed = boundedAheSqliteImage(raw);
				expect(await stale.reclaimBoundedGeneration()).toEqual({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
				expect(boundedAheSqliteImage(raw)).toEqual(changed);
			} finally {
				await stale.release();
				raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(oldControlBytes, fixture.objectId);
				raw.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(oldHead.head_record, fixture.objectId);
				raw
					.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?")
					.run(oldGeneration.record, fixture.objectId, oldGeneration.generation_id);
			}
			expect(boundedAheSqliteImage(raw)).toEqual(before);
		}
		const reclaim = must(await store.acquireRetirementControl(fixture.objectId));
		try {
			must(await reclaim.reclaimBoundedGeneration());
		} finally {
			await reclaim.release();
		}
		const fresh = must(await store.acquireRetirementControl(fixture.objectId));
		const nextPreparation = {
			...fixture.preparation,
			floorEpoch: 4,
			decisionDigest: "1".repeat(64),
			sourceProofDigest: "2".repeat(64),
			generationRecordDigests: fixture.source.postGenerations.recordDigests,
		};
		delete nextPreparation.generationSource;
		try {
			must(await fresh.prepareBound({ preparation: nextPreparation, generations: fixture.source.postGenerations }));
		} finally {
			await fresh.release();
		}
		const commit = must(await store.acquireRetirementControl(fixture.objectId));
		try {
			const complete = must(
				await commit.commitPrepared({
					decisionDigest: nextPreparation.decisionDigest,
					sourceProofDigest: nextPreparation.sourceProofDigest,
				})
			);
			expect(complete.completed?.throughEpoch).toBe(4);
			expect(complete.completed?.generationDrain).toBeUndefined();
		} finally {
			await commit.release();
		}
		const future = must(await store.acquireRetirementControl(fixture.objectId));
		try {
			// With no pending drain, an untrusted object reaches (and fails) the original resolver.
			expect(await future.stageNominatedFutureGeneration({})).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		} finally {
			await future.release();
		}
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
// Mechanical substrate/capture law only: fixture signatures do not confer protocol eligibility.
test("journal physical eight-header image is complete while role and resource bounds remain distinct", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-eight-headers-"));
	const filename = join(directory, "journal.sqlite");
	let store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const raw = new DatabaseSync(filename + ".drp-live-journal-v1.sqlite");
	const materials = Array.from({ length: 8 }, (_, epoch) => anchorMaterial(epoch));
	const first = anchorMaterial(0);
	const selector = { objectId: first.scope.objectId };
	const read = async (): ReturnType<NonNullable<typeof store.readRetirementImage>> => {
		if (store.readRetirementImage === undefined) throw new Error("original journal image port missing");
		return store.readRetirementImage(selector);
	};
	const acquire = async (): ReturnType<NonNullable<typeof store.acquireRetirementControl>> => {
		if (store.acquireRetirementControl === undefined) throw new Error("original journal control port missing");
		return store.acquireRetirementControl(selector);
	};
	type NativeRows = ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;
	const native = (): { scopes: NativeRows; rows: NativeRows; controls: NativeRows } => ({
		scopes: raw
			.prepare("SELECT * FROM scopes ORDER BY object_id,epoch,anchor_digest")
			.all()
			.map((row) => ({ ...row })),
		rows: raw
			.prepare("SELECT * FROM accepted_entries ORDER BY object_id,epoch,anchor_digest,journal_sequence")
			.all()
			.map((row) => ({ ...row })),
		controls: raw
			.prepare("SELECT * FROM retirement_controls ORDER BY object_id")
			.all()
			.map((row) => ({ ...row })),
	});
	try {
		expect(LIVE_JOURNAL_RETIREMENT_LIMITS).toMatchObject({ maxScopes: 7, maxRows: 8192, maxImageBytes: 262_144 });
		for (const [epoch, material] of materials.entries()) {
			expect(
				await (epoch === 0 ? store.installGenesis(material.install) : store.installEpochAnchor(material.install))
			).toMatchObject({ ok: true });
			expect(
				await store.appendAccepted({
					scope: material.scope,
					sourceKind: "local-issued",
					author: "creator",
					authorSequence: epoch,
					vertexDigest: (epoch + 1).toString(16).padStart(64, "0"),
				})
			).toMatchObject({ ok: true });
		}
		const before = native();
		const expected = [
			...before.scopes.map((row) => encodeCanonical(["scopes", [row.object_id, row.epoch, row.anchor_digest], row])),
			...before.rows.map((row) =>
				encodeCanonical(["accepted_entries", [row.object_id, row.epoch, row.anchor_digest, row.journal_sequence], row])
			),
		];
		const frame = (index: number): Uint8Array => {
			const selected = expected[index];
			if (selected === undefined) throw new Error("missing actual native frame");
			return selected;
		};
		const image = must(await read());
		expect(image.control).toBeNull();
		expect(image.canonicalRows).toEqual(expected);
		expect(image.image).toEqual(journalRetirementImage(before.scopes, before.rows));
		expect(image.image).toMatchObject({ scopeCount: 8, rowCount: 8 });
		expect(image.image.byteCharge).toBeLessThan(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes);
		expect(native()).toEqual(before);
		// Raw negatives exercise physical counters/bytes only, before materialization.
		// This connection permits writes only while the actual native control is absent.
		raw.function("journal_retirement_allows", (objectId, epoch, anchorDigest) =>
			objectId === first.scope.objectId &&
			typeof epoch === "number" &&
			Number.isSafeInteger(epoch) &&
			anchorDigest === first.scope.anchorDigest &&
			raw.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n === 0
				? 1
				: 0
		);
		const header = before.scopes[0];
		if (header === undefined) throw new Error("missing actual native header");
		const insertHeader = raw.prepare(
			"INSERT INTO scopes(object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier) VALUES (?,?,?,0,?,?,?,?)"
		);
		raw.exec("BEGIN IMMEDIATE");
		try {
			for (let i = 8; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows; i++)
				insertHeader.run(
					header.object_id,
					10_000 + i,
					header.anchor_digest,
					header.exact_anchor_preimage,
					header.detached_anchor_signature,
					header.parameters_digest,
					header.exact_parameters_carrier
				);
			raw.exec("COMMIT");
		} catch (error) {
			raw.exec("ROLLBACK");
			throw error;
		}
		expect(raw.prepare("SELECT count(*) AS n FROM scopes").get()?.n).toBe(LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1);
		expect(await read()).toEqual({ ok: false, kind: "retirement-fenced" });
		raw.prepare("DELETE FROM scopes WHERE epoch>=10000").run();
		expect(native()).toEqual(before);
		const row = before.rows[0];
		if (row === undefined) throw new Error("missing actual native row");
		const insertRow = raw.prepare("INSERT INTO accepted_entries VALUES (?,?,?,?,?,?,?,?,?,?)");
		raw.exec("BEGIN IMMEDIATE");
		try {
			for (let i = 1; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows - 7; i++)
				insertRow.run(
					row.object_id,
					row.epoch,
					row.anchor_digest,
					i,
					row.source_kind,
					(10_000 + i).toString(16).padStart(64, "0"),
					null,
					null,
					row.local_author,
					10_000 + i
				);
			raw.exec("COMMIT");
		} catch (error) {
			raw.exec("ROLLBACK");
			throw error;
		}
		expect(raw.prepare("SELECT count(*) AS n FROM accepted_entries").get()?.n).toBe(
			LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1
		);
		expect(await read()).toEqual({ ok: false, kind: "retirement-fenced" });
		raw.prepare("DELETE FROM accepted_entries WHERE journal_sequence>0").run();
		expect(native()).toEqual(before);
		raw
			.prepare("UPDATE scopes SET exact_parameters_carrier=? WHERE epoch=0")
			.run(new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes));
		expect(await read()).toEqual({ ok: false, kind: "retirement-fenced" });
		raw.prepare("UPDATE scopes SET exact_parameters_carrier=? WHERE epoch=0").run(header.exact_parameters_carrier);
		expect(native()).toEqual(before);
		expect(must(await read())).toEqual(image);
		const labels = { decisionDigest: "b".repeat(64), sourceProofDigest: "c".repeat(64), throughEpoch: 7 };
		const tooMany = must(await acquire());
		const idle = must(await read());
		expect(tooMany.readExactCanonicalRows()).toEqual(expected);
		expect(tooMany.image).toEqual(image.image);
		try {
			expect(await tooMany.prepareFence({ ...labels, protectedScopes: materials.map((m) => m.scope) })).toEqual({
				ok: false,
				kind: "malformed-input",
			});
		} finally {
			await tooMany.release();
		}
		expect(must(await read())).toEqual(idle);
		// Mechanical completed control is only a parser premise, not a deletion grant.
		const prepare = must(await acquire());
		try {
			must(await prepare.prepareFence({ ...labels, protectedScopes: [] }));
		} finally {
			await prepare.release();
		}
		const commit = must(await acquire());
		try {
			must(await commit.commitPrepared());
		} finally {
			await commit.release();
		}
		const completed = must(await read());
		if (completed.control === null) throw new Error("completed native control missing");
		const prefixes = materials.map((material, index) => ({
			scope: material.scope,
			highWatermark: 1,
			rows: [
				{
					journalSequence: 0,
					vertexDigest: (index + 1).toString(16).padStart(64, "0"),
					author: "creator",
					authorSequence: index,
					nativeFrameDigest: journalRetirementFrameDigest(frame(8 + index)),
				},
			],
		}));
		const excessive = must(await acquire());
		try {
			expect(
				await excessive.beginDrain({ baseControl: completed.control, sourceImage: completed.image, prefixes })
			).toEqual({ ok: false, kind: "malformed-input" });
		} finally {
			await excessive.release();
		}
		expect(must(await read())).toEqual(completed);
		expect(native().scopes).toEqual(before.scopes);
		expect(native().rows).toEqual(before.rows);
		for (const material of materials)
			expect(await store.readSignedAnchorEnvelope({ scope: material.scope, maxBytes: 8192 })).toMatchObject({
				ok: true,
				kind: "present",
			});
		await store.close();
		store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
		expect(must(await read())).toEqual(completed);
	} finally {
		raw.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// Native codec conformance only; the existing fixture signature is not future protocol authority.
test("R10 exact empty header drain joins bounded batches and reconstructs original source after reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-header-drain-"));
	const filename = join(directory, "journal.sqlite");
	let store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	const materials = Array.from({ length: 20 }, (_, epoch) => anchorMaterial(epoch));
	const selector = { objectId: materials[0]!.scope.objectId };
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		expect(await store.installGenesis(materials[0]!.install)).toMatchObject({ ok: true });
		for (const material of materials.slice(1)) expect(await store.installEpochAnchor(material.install)).toMatchObject({ ok: true });
		expect(await store.appendAccepted({ scope: materials[1]!.scope, sourceKind: "local-issued", author: "creator", authorSequence: 0, vertexDigest: "a".repeat(64) })).toMatchObject({ ok: true });
		const prepare = must(await store.acquireRetirementControl(selector));
		must(await prepare.prepareFence({ throughEpoch: 18, protectedScopes: [materials[18]!.scope], decisionDigest: "e".repeat(64), sourceProofDigest: "f".repeat(64) }));
		await prepare.release();
		const commit = must(await store.acquireRetirementControl(selector));
		must(await commit.commitPrepared()); await commit.release();
		const source = must(await store.readRetirementImage(selector));
		if (source.control === null) throw new Error("original floor missing");
		const rows = source.canonicalRows.flatMap(bytes => {
			const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return table === "accepted_entries" ? [{ journalSequence: row.journal_sequence as number, vertexDigest: row.vertex_digest as string,
				author: row.local_author as string, authorSequence: row.local_author_sequence as number, nativeFrameDigest: journalRetirementFrameDigest(bytes) }] : [];
		});
		const headers = source.canonicalRows.flatMap(bytes => {
			const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
			return table === "scopes" && typeof key[1] === "number" && key[1] >= 2 && key[1] <= 17
				? [{ scope: materials[key[1]]!.scope, exactCanonicalNativeFrameBytes: bytes }] : [];
		});
		const plan = { baseControl: source.control, sourceImage: source.image, prefixes: [{ scope: materials[1]!.scope, highWatermark: 1, rows }],
			retiredEmptyHeaders: headers, protectedHeaderScopes: [materials[0]!.scope, materials[18]!.scope, materials[19]!.scope] };
		const foreignProtected = Array.from({ length: 8 }, (_, index) => ({ ...materials[18]!.scope, objectId: `foreign-source-${index}` }));
		expect(captureJournalRetirementDrainPlan({ ...plan, protectedHeaderScopes: [...plan.protectedHeaderScopes, ...foreignProtected] }).protectedHeaderScopes)
			.toEqual([...plan.protectedHeaderScopes, ...foreignProtected]);
		for (const altered of [
			{ ...plan, protectedHeaderScopes: [...plan.protectedHeaderScopes, headers[0]!.scope] },
			{ ...plan, retiredEmptyHeaders: [...headers, headers[0]!] },
			{ ...plan, retiredEmptyHeaders: [{ scope: materials[0]!.scope, exactCanonicalNativeFrameBytes: source.canonicalRows[0]! }] },
			{ ...plan, retiredEmptyHeaders: [{ ...headers[0]!, exactCanonicalNativeFrameBytes: headers[1]!.exactCanonicalNativeFrameBytes }] },
		]) expect(() => captureJournalRetirementDrainPlan(altered)).toThrow("malformed-input");
		const begin = must(await store.acquireRetirementControl(selector)); must(await begin.beginDrain(plan)); await begin.release();
		const entered = must(await store.readRetirementImage(selector));
		raw.exec("CREATE TRIGGER header_drain_test_abort BEFORE DELETE ON scopes WHEN OLD.epoch=3 BEGIN SELECT RAISE(ABORT,'header-drain-test-abort'); END");
		const aborted = must(await store.acquireRetirementControl(selector));
		expect(await aborted.drainBatch()).toEqual({ ok: false, kind: "substrate-failure" }); await aborted.release();
		expect(must(await store.readRetirementImage(selector))).toEqual(entered);
		raw.exec("DROP TRIGGER header_drain_test_abort");
		const first = must(await store.acquireRetirementControl(selector));
		// The public header leaf is detached just like received-row restoration
		// bytes; a fresh public encode refuses it, but private CAS remains exact.
		first.control.drain!.plan.retiredEmptyHeaders![0]!.exactCanonicalNativeFrameBytes.fill(0);
		expect(() => encodeJournalRetirementNativeCarriers(first.control)).toThrow();
		must(await first.drainBatch()); await first.release();
		const partial = must(await store.readRetirementImage(selector));
		expect(partial.control?.drain).toMatchObject({ cursor: 16, batches: 1 });
		expect(partial.image).toMatchObject({ scopeCount: 5, rowCount: 0 });
		expect(partial.drainSource).toEqual({ control: source.control, image: source.image, canonicalRows: source.canonicalRows });
		expect(await store.appendAccepted({ scope: materials[19]!.scope, sourceKind: "local-issued", author: "creator", authorSequence: 1, vertexDigest: "b".repeat(64) })).toMatchObject({ ok: false, kind: "retirement-fenced" });
		expect(must(await store.readRetirementImage(selector))).toEqual(partial);
		await store.close(); store = createNodeDurableLiveJournalStore({ primaryFilename: filename, initialization: "reopen" });
		expect(must(await store.readRetirementImage(selector))).toEqual(partial);
		const last = must(await store.acquireRetirementControl(selector)); must(await last.drainBatch()); await last.release();
		const complete = must(await store.readRetirementImage(selector));
		expect(complete.control?.drain).toMatchObject({ cursor: 17, batches: 2 });
		expect(complete.image).toMatchObject({ scopeCount: 4, rowCount: 0 });
		expect(complete.drainSource).toEqual(partial.drainSource);
		expect(await store.readSignedAnchorEnvelope({ scope: materials[2]!.scope, maxBytes: 262144 })).toMatchObject({ ok: true, kind: "missing" });
		for (const epoch of [0, 1, 18, 19]) expect(await store.readSignedAnchorEnvelope({ scope: materials[epoch]!.scope, maxBytes: 262144 })).toMatchObject({ ok: true, kind: "present" });
		expect(await store.installEpochAnchor(materials[2]!.install)).toMatchObject({ ok: false, kind: "retirement-fenced" });
		expect(await store.appendAccepted({ scope: materials[19]!.scope, sourceKind: "local-issued", author: "creator", authorSequence: 1, vertexDigest: "b".repeat(64) })).toMatchObject({ ok: true });
		const advanced = must(await store.readRetirementImage(selector));
		expect(advanced.control?.drain).toBeNull(); expect(advanced.drainSource).toBeUndefined();
		expect(advanced.control?.completed).toEqual(source.control.completed);
	} finally { raw.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("journal fresh native indexes preserve reconstruction and public transition duplicate, key and child refusals", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-reconstruction-index-"));
	const store = createNodeDurableLiveJournalStore({primaryFilename: join(directory, "journal.sqlite")});
	const old = anchorMaterial(0), empty = anchorMaterial(1), current = anchorMaterial(2), selector = {objectId: old.scope.objectId};
	try {
		must(await store.installGenesis(old.install));
		for (const material of [empty, current]) must(await store.installEpochAnchor(material.install));
		for (const scope of [old.scope, current.scope]) must(await store.appendAccepted({scope, sourceKind: "local-issued",
			author: "creator", authorSequence: 0, vertexDigest: "a".repeat(64)}));
		const prepare = must(await store.acquireRetirementControl(selector));
		must(await prepare.prepareFence({throughEpoch: 1, protectedScopes: [], decisionDigest: "b".repeat(64),
			sourceProofDigest: "c".repeat(64)})); await prepare.release();
		const commit = must(await store.acquireRetirementControl(selector)); must(await commit.commitPrepared()); await commit.release();
		const source = must(await store.readRetirementImage(selector));
		if (source.control === null) throw Error("original completed control missing");
		const oldFrame = source.canonicalRows.find(bytes => {
			const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
			return table === "accepted_entries" && key[1] === old.scope.epoch;
		})!;
		const [table, key, row] = decodeCanonical(oldFrame) as [string, unknown[], Record<string, unknown>];
		const plan = {baseControl: source.control, sourceImage: source.image, prefixes: [{scope: old.scope,
			highWatermark: 1, rows: [{journalSequence: 0, vertexDigest: row.vertex_digest as string, author: "creator",
				authorSequence: 0, nativeFrameDigest: journalRetirementFrameDigest(oldFrame)}]}]};
		const begin = must(await store.acquireRetirementControl(selector));
		must(await begin.beginDrain(plan)); await begin.release();
		const pending = must(await store.readRetirementImage(selector));
		if (pending.control?.drain == null) throw Error("original pending drain missing");
		const reconstruct = (frames: readonly Uint8Array[]) => reconstructJournalRetirementDrainSource(
			pending.control, pending.image, frames, () => {throw Error("no removed row should need reconstruction");});
		const complete = reconstruct(pending.canonicalRows);
		expect(complete).toEqual({control: source.control, image: source.image, canonicalRows: source.canonicalRows});
		for (const duplicate of [oldFrame.slice(), encodeCanonical(["acceptedEntries", key, row])])
			expect(() => reconstruct([...pending.canonicalRows, duplicate])).toThrow("retirement-stale");
		const wrongKey = encodeCanonical([table, [...key.slice(0, 3), 1], row]);
		expect(() => reconstruct(pending.canonicalRows.map(bytes =>
			bytes.length === oldFrame.length && bytes.every((value, index) => value === oldFrame[index])
				? wrongKey : bytes))).toThrow("retirement-stale");
		const imageOf = (frames: readonly Uint8Array[]) => {
			const decoded = frames.map(bytes => decodeCanonical(bytes) as [string, unknown[], unknown]);
			return journalRetirementImage(decoded.filter(frame => frame[0] === "scopes").map(frame => frame[2]),
				decoded.filter(frame => frame[0] !== "scopes").map(frame => frame[2]));
		};
		let comparisons = 0;
		const compare: Parameters<typeof createJournalRetirementControlRead>[2] = async next => {
			comparisons++; return {ok: true, value: next};
		};
		// These are deliberately corrupted public images, not native SQL states.
		// Both same-spelling and alias duplicates must remain ambiguous, and a
		// changed address must not be rescued by an otherwise matching row body.
		for (const frames of [
			[...source.canonicalRows, oldFrame.slice()],
			[...source.canonicalRows, encodeCanonical(["acceptedEntries", key, row])],
			source.canonicalRows.map(bytes => bytes.length === oldFrame.length && bytes.every((value, index) => value === oldFrame[index]) ? wrongKey : bytes),
		]) {
			const image = imageOf(frames), entering = createJournalRetirementControlRead(source.control, image, compare, frames);
			expect(await entering.beginDrain({...plan, sourceImage: image})).toEqual({ok: false, kind: "retirement-transition"});
			await entering.release();
			const draining = createJournalRetirementControlRead({...pending.control, drain: {...pending.control.drain,
				residualImageDigest: image.imageDigest}}, image, compare, frames);
			expect(await draining.drainBatch()).toEqual({ok: false, kind: "retirement-transition"});
			await draining.release();
		}
		const emptyFrame = source.canonicalRows.find(bytes => {
			const [kind, address] = decodeCanonical(bytes) as [string, unknown[]];
			return kind === "scopes" && address[1] === empty.scope.epoch;
		})!;
		const child = journalRetirementCanonicalRow(table, [empty.scope.objectId, empty.scope.epoch, empty.scope.anchorDigest, 0],
			{...row, epoch: empty.scope.epoch, anchor_digest: empty.scope.anchorDigest});
		const withChild = [...source.canonicalRows, child], childImage = imageOf(withChild), headerPlan = {
			baseControl: source.control, sourceImage: childImage, prefixes: [],
			retiredEmptyHeaders: [{scope: empty.scope, exactCanonicalNativeFrameBytes: emptyFrame}],
			protectedHeaderScopes: [old.scope, current.scope],
		};
		const enteringHeader = createJournalRetirementControlRead(source.control, childImage, compare, withChild);
		expect(await enteringHeader.beginDrain(headerPlan)).toEqual({ok: false, kind: "retirement-transition"});
		await enteringHeader.release();
		const drainingHeader = createJournalRetirementControlRead({...source.control,
			kind: "v3-live-journal-retirement-control-2", revision: source.control.revision + 1,
			drain: {plan: headerPlan, cursor: 0, batches: 0, residualImageDigest: childImage.imageDigest}},
		childImage, compare, withChild);
		expect(await drainingHeader.drainBatch()).toEqual({ok: false, kind: "retirement-transition"});
		await drainingHeader.release();
		expect(comparisons).toBe(0);
		expect(must(await store.readRetirementImage(selector))).toEqual(pending);
		const before = complete!.canonicalRows.map(bytes => bytes.slice());
		for (const bytes of pending.canonicalRows) bytes.fill(0);
		expect(complete!.canonicalRows).toEqual(before);
		expect(must(await store.readRetirementImage(selector)).canonicalRows).toEqual(source.canonicalRows);
	} finally {await store.close(); await rm(directory, {recursive: true, force: true});}
});

// Native local checkpoint conformance, not protocol membership/deletion authority.
test("R10 completed journal drain acknowledgement compacts only terminal metadata before the next append", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-drain-ack-")), filename = join(directory, "journal.sqlite");
	let store = createNodeDurableLiveJournalStore({primaryFilename: filename});
	const old = anchorMaterial(0), current = anchorMaterial(1), selector = {objectId: old.scope.objectId};
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	try {
		must(await store.installGenesis(old.install)); must(await store.installEpochAnchor(current.install));
		must(await store.appendAccepted({scope: old.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: 0, vertexDigest: "a".repeat(64)}));
		const prepare = must(await store.acquireRetirementControl(selector));
		must(await prepare.prepareFence({throughEpoch: 1, protectedScopes: [current.scope],
			decisionDigest: "e".repeat(64), sourceProofDigest: "f".repeat(64)})); await prepare.release();
		const commit = must(await store.acquireRetirementControl(selector)); must(await commit.commitPrepared()); await commit.release();
		const source = must(await store.readRetirementImage(selector));
		if (source.control === null) throw Error("original preparation missing");
		const rows = source.canonicalRows.flatMap(bytes => {
			const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return table !== "accepted_entries" ? [] : [{journalSequence: row.journal_sequence as number,
				vertexDigest: row.vertex_digest as string, author: row.local_author as string,
				authorSequence: row.local_author_sequence as number, nativeFrameDigest: journalRetirementFrameDigest(bytes)}];
		});
		const beforeDrain = must(await store.acquireRetirementControl(selector));
		expect(await beforeDrain.acknowledgeCompletedDrain()).toEqual({ok: false, kind: "retirement-transition"});
		must(await beforeDrain.beginDrain({baseControl: source.control, sourceImage: source.image,
			prefixes: [{scope: old.scope, highWatermark: 1, rows}]})); await beforeDrain.release();
		const partial = must(await store.acquireRetirementControl(selector));
		expect(await partial.acknowledgeCompletedDrain()).toEqual({ok: false, kind: "retirement-transition"});
		must(await partial.drainBatch()); await partial.release();
		const completed = must(await store.readRetirementImage(selector));
		expect(completed.control?.drain?.cursor).toBe(1); expect(completed.drainSource).toBeDefined();
		const headers = raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all();
		await store.close(); store = createNodeDurableLiveJournalStore({primaryFilename: filename, initialization: "reopen"});
		expect(must(await store.readRetirementImage(selector))).toEqual(completed);
		raw.exec("CREATE TRIGGER ack_test_abort BEFORE UPDATE ON retirement_controls WHEN OLD.plan_record IS NOT NULL AND NEW.plan_record IS NULL BEGIN SELECT RAISE(ABORT,'ack-test-abort'); END");
		const aborted = must(await store.acquireRetirementControl(selector));
		expect(await aborted.acknowledgeCompletedDrain()).toEqual({ok: false, kind: "substrate-failure"}); await aborted.release();
		expect(must(await store.readRetirementImage(selector))).toEqual(completed);
		raw.exec("DROP TRIGGER ack_test_abort");
		const stale = must(await store.acquireRetirementControl(selector)), ack = must(await store.acquireRetirementControl(selector));
		expect(await ack.acknowledgeCompletedDrain.call({...ack})).toEqual({ok: false, kind: "malformed-input"});
		const result = must(await ack.acknowledgeCompletedDrain());
		expect(result).toEqual({...completed.control, revision: completed.control!.revision + 1, drain: null});
		expect(await ack.acknowledgeCompletedDrain()).toEqual({ok: false, kind: "retirement-released"}); await ack.release();
		expect(await stale.acknowledgeCompletedDrain()).toEqual({ok: false, kind: "retirement-stale"}); await stale.release();
		const compact = must(await store.readRetirementImage(selector));
		expect(compact.image).toEqual(completed.image); expect(compact.canonicalRows).toEqual(completed.canonicalRows);
		expect(compact.drainSource).toBeUndefined(); expect(compact.exactCanonicalControlCarriers).toHaveLength(1);
		expect(raw.prepare("SELECT plan_record FROM retirement_controls").get()?.plan_record).toBeNull();
		expect(raw.prepare("SELECT * FROM scopes ORDER BY epoch,anchor_digest").all()).toEqual(headers);
		await store.close(); store = createNodeDurableLiveJournalStore({primaryFilename: filename, initialization: "reopen"});
		expect(must(await store.readRetirementImage(selector))).toEqual(compact);
		expect(await store.appendAccepted({scope: old.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: 1, vertexDigest: "b".repeat(64)})).toEqual({ok: false, kind: "retirement-fenced"});
		must(await store.appendAccepted({scope: current.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: 1, vertexDigest: "c".repeat(64)}));
		expect(must(await store.readRetirementImage(selector)).control?.completed).toEqual(source.control.completed);
	} finally {raw.close(); await store.close(); await rm(directory, {recursive: true, force: true});}
});

test("R10 completed journal drain widths match actual mutation and retain protected membership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-completed-widths-"));
	const store = createNodeDurableLiveJournalStore({ primaryFilename: join(directory, "journal.sqlite") });
	const old = anchorMaterial(0),
		protectedHeader = anchorMaterial(1),
		current = anchorMaterial(2),
		successor = anchorMaterial(3);
	const selector = { objectId: current.scope.objectId };
	const local = (scope: typeof current.scope, authorSequence: number, vertexDigest: string) => ({
		scope,
		author: "creator",
		authorSequence,
		vertexDigest,
		sourceKind: "local-issued" as const,
	});
	const candidate = local(current.scope, 19, "c".repeat(64));
	const fence = { author: "creator", authorSequence: 20 };
	const unsigned = {
		objectId: successor.install.objectId,
		exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes,
	};
	const check = (width: JournalFutureNativeWidths | undefined, frames: readonly Uint8Array[]): void => {
		const decoded = frames.map((bytes) => decodeCanonical(bytes) as [string, unknown, unknown]);
		expect(width).toEqual({
			scopeCount: decoded.filter((frame) => frame[0] === "scopes").length,
			rowCount: decoded.filter((frame) => frame[0] !== "scopes").length,
			canonicalRowBytes: frames.map((bytes) => bytes.length),
			canonicalRowsBytes: encodeCanonical(frames).length,
			nativeImageBytes: encodeCanonical({
				scopes: decoded.filter((frame) => frame[0] === "scopes").map((frame) => frame[2]),
				rows: decoded.filter((frame) => frame[0] !== "scopes").map((frame) => frame[2]),
			}).length,
		});
	};
	try {
		if (!store.readRetirementImage || !store.acquireRetirementControl || !store.recordClosedMembership)
			throw new Error("original journal lifecycle ports unavailable");
		expect(await store.installGenesis(old.install)).toMatchObject({ ok: true });
		for (const material of [protectedHeader, current])
			expect(await store.installEpochAnchor(material.install)).toMatchObject({ ok: true });
		for (let i = 0; i < 17; i++)
			expect(await store.appendAccepted(local(old.scope, i, (i + 1).toString(16).padStart(64, "0")))).toMatchObject({
				ok: true,
			});
		expect(await store.appendAccepted(local(protectedHeader.scope, 17, "a".repeat(64)))).toMatchObject({ ok: true });
		expect(await store.appendAccepted(local(current.scope, 18, "b".repeat(64)))).toMatchObject({ ok: true });
		// Native codec/currency fixtures only: opaque bytes confer no close authority.
		for (const material of [old, protectedHeader, current]) {
			const before = must(await store.readRetirementImage(selector));
			expect(
				await store.recordClosedMembership({
					scope: material.scope,
					exactCanonicalMembershipBytes: encodeCanonical({
						kind: "mechanical-width-membership",
						epoch: material.scope.epoch,
					}),
					expectedNativeImage: {
						imageDigest: before.image.imageDigest,
						controlBytes: before.control === null ? null : encodeJournalRetirementControl(before.control),
					},
				})
			).toMatchObject({ ok: true });
		}
		const prepare = must(await store.acquireRetirementControl(selector));
		must(
			await prepare.prepareFence({
				throughEpoch: 1,
				protectedScopes: [protectedHeader.scope],
				decisionDigest: "e".repeat(64),
				sourceProofDigest: "f".repeat(64),
			})
		);
		await prepare.release();
		const commit = must(await store.acquireRetirementControl(selector));
		must(await commit.commitPrepared());
		await commit.release();
		const source = must(await store.readRetirementImage(selector));
		if (source.control === null) throw new Error("original completed floor missing");
		const rows = source.canonicalRows.flatMap((bytes) => {
			const [table, key, row] = decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>];
			return table === "accepted_entries" && key[1] === old.scope.epoch
				? [
						{
							journalSequence: row.journal_sequence as number,
							vertexDigest: row.vertex_digest as string,
							author: row.local_author as string,
							authorSequence: row.local_author_sequence as number,
							nativeFrameDigest: journalRetirementFrameDigest(bytes),
						},
					]
				: [];
		});
		const begin = must(await store.acquireRetirementControl(selector));
		must(
			await begin.beginDrain({
				baseControl: source.control,
				sourceImage: source.image,
				prefixes: [{ scope: old.scope, highWatermark: 17, rows }],
			})
		);
		await begin.release();
		const first = must(await store.acquireRetirementControl(selector));
		must(await first.drainBatch());
		await first.release();
		const partial = must(await store.readRetirementImage(selector));
		expect(() =>
			journalFutureAppendPostimageWidths(partial.canonicalRows, candidate, unsigned, fence, [], {
				control: partial.control,
			})
		).toThrow("retirement-fenced");
		const last = must(await store.acquireRetirementControl(selector));
		must(await last.drainBatch());
		await last.release();
		const complete = must(await store.readRetirementImage(selector));
		if (complete.control?.drain == null) throw new Error("original completed drain missing");
		expect(complete.control.drain.cursor).toBe(17);
		const projected = journalFutureAppendPostimageWidths(complete.canonicalRows, candidate, unsigned, fence, [], {
			control: complete.control,
		});
		const conservative = journalFutureAppendPostimageWidths(complete.canonicalRows, candidate, unsigned, fence);
		expect(conservative.afterLocal.nativeImageBytes).toBeGreaterThan(projected.afterLocal.nativeImageBytes);
		expect(() =>
			journalFutureAppendPostimageWidths(complete.canonicalRows, candidate, unsigned, fence, [], {
				control: {
					...complete.control,
					sequence: complete.control.sequence + 1,
					active: { sequence: complete.control.sequence + 1, preparation: complete.control.completed! },
				},
			})
		).toThrow("retirement-stale");
		expect(() =>
			journalFutureAppendPostimageWidths(complete.canonicalRows, candidate, unsigned, fence, [], {
				control: { ...complete.control, drain: { ...complete.control!.drain!, residualImageDigest: "0".repeat(64) } },
			})
		).toThrow("retirement-stale");
		const residualRow = source.canonicalRows.find((bytes) => {
			const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
			return table === "accepted_entries" && key[1] === 0;
		});
		if (residualRow === undefined) throw new Error("original source row missing");
		const fabricated = [...complete.canonicalRows, residualRow].sort((left, right) => {
			const a = decodeCanonical(left) as [string, unknown[]],
				b = decodeCanonical(right) as [string, unknown[]];
			if (a[0] !== b[0]) return a[0] === "scopes" ? -1 : 1;
			return (a[1][1] as number) - (b[1][1] as number);
		});
		const decoded = fabricated.map((bytes) => decodeCanonical(bytes) as [string, unknown, unknown]);
		const fabricatedImage = journalRetirementImage(
			decoded.filter((frame) => frame[0] === "scopes").map((frame) => frame[2]),
			decoded.filter((frame) => frame[0] !== "scopes").map((frame) => frame[2])
		);
		expect(() =>
			journalFutureAppendPostimageWidths(fabricated, candidate, unsigned, fence, [], {
				control: {
					...complete.control,
					drain: { ...complete.control!.drain!, residualImageDigest: fabricatedImage.imageDigest },
				},
			})
		).toThrow("retirement-stale");
		expect(must(await store.readRetirementImage(selector))).toEqual(complete);
		expect(await store.appendAccepted(candidate)).toMatchObject({ ok: true, idempotent: false });
		const appended = must(await store.readRetirementImage(selector));
		check(projected.afterLocal, appended.canonicalRows);
		expect(appended.control?.drain).toBeNull();
		expect(appended.control?.completed).toEqual(complete.control.completed);
		const protectedFrame = (frames: readonly Uint8Array[]) =>
			frames.find((bytes) => {
				const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
				return table === "scopes" && key[1] === 1;
			});
		expect(protectedFrame(appended.canonicalRows)).toEqual(protectedFrame(complete.canonicalRows));
		const heldOld = complete.canonicalRows.find((bytes) => {
			const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
			return table === "scopes" && key[1] === 0;
		});
		if (heldOld === undefined) throw new Error("original held source header missing");
		expect((decodeCanonical(heldOld) as unknown[])[2]).toHaveProperty("closed_membership_bytes");
		const headers = appended.canonicalRows
			.filter((bytes) => (decodeCanonical(bytes) as unknown[])[0] === "scopes")
			.map((bytes) => (decodeCanonical(bytes) as unknown[])[2] as Record<string, unknown>);
		expect(headers.find((row) => row.epoch === 0)).not.toHaveProperty("closed_membership_bytes");
		for (const epoch of [1, 2])
			expect(headers.find((row) => row.epoch === epoch)).toHaveProperty("closed_membership_bytes");
		expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true });
		check(projected.afterSuccessor, must(await store.readRetirementImage(selector)).canonicalRows);
		expect(await store.appendAccepted(local(successor.scope, 20, "d".repeat(64)))).toMatchObject({ ok: true });
		check(projected.afterSuccessorLocal, must(await store.readRetirementImage(selector)).canonicalRows);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R8 journal final successor fence widths match native append and control revision", async () => {
	const { advanceJournalRetirementControl } = await import("../../live-journal/dist/src/index.js");
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-final-fence-widths-"));
	const current = anchorMaterial(0),
		successor = anchorMaterial(1);
	const vertexFields = decodeCanonical(Uint8Array.from(Buffer.from(archived.vertexHex, "hex"))) as Record<
		string,
		unknown
	>;
	const author = vertexFields.author as string;
	const local = (
		authorSequence: number,
		scope = current.scope
	): Readonly<{
		author: string;
		authorSequence: number;
		scope: typeof current.scope;
		sourceKind: "local-issued";
		vertexDigest: string;
	}> => {
		const bytes = encodeCanonical({
			...vertexFields,
			authorSequence,
			logicalTime: authorSequence + 1,
			epoch: scope.epoch,
			anchor: scope.anchorDigest,
		});
		const vertexDigest = Array.from(hashDomain("ts-drp/vertex/v3", bytes), (b) => b.toString(16).padStart(2, "0")).join(
			""
		);
		return { author, authorSequence, scope, sourceKind: "local-issued" as const, vertexDigest };
	};
	const browserFrames = (frames: readonly Uint8Array[]): readonly Uint8Array[] =>
		frames.map((bytes) => {
			const [table, key, raw] = decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>];
			const row =
				table === "scopes"
					? {
							objectId: raw.object_id,
							epoch: raw.epoch,
							anchorDigest: raw.anchor_digest,
							nextJournalSequence: raw.next_journal_sequence,
							exactCanonicalAnchorPreimageBytes: raw.exact_anchor_preimage,
							detachedAnchorSignature: raw.detached_anchor_signature,
							parametersDigest: raw.parameters_digest,
							exactCanonicalParametersCarrierBytes: raw.exact_parameters_carrier,
							...(raw.closed_membership_bytes === undefined
								? {}
								: { closedMembershipBytes: raw.closed_membership_bytes }),
						}
					: {
							objectId: raw.object_id,
							epoch: raw.epoch,
							anchorDigest: raw.anchor_digest,
							journalSequence: raw.journal_sequence,
							sourceKind: raw.source_kind,
							vertexDigest: raw.vertex_digest,
							localAuthor: raw.local_author,
							localAuthorSequence: raw.local_author_sequence,
						};
			return encodeCanonical([table === "scopes" ? table : "acceptedEntries", key, row]);
		});
	const check = (width: JournalFutureNativeWidths | undefined, frames: readonly Uint8Array[]): void => {
		const decoded = frames.map((bytes) => decodeCanonical(bytes) as [string, unknown, unknown]);
		expect(width).toEqual({
			scopeCount: decoded.filter((frame) => frame[0] === "scopes").length,
			rowCount: decoded.filter((frame) => frame[0] !== "scopes").length,
			canonicalRowBytes: frames.map((bytes) => bytes.length),
			canonicalRowsBytes: encodeCanonical(frames).length,
			nativeImageBytes: encodeCanonical({
				scopes: decoded.filter((frame) => frame[0] === "scopes").map((frame) => frame[2]),
				rows: decoded.filter((frame) => frame[0] !== "scopes").map((frame) => frame[2]),
			}).length,
		});
	};
	try {
		for (const [presentControl, count] of [
			[true, 61],
			[false, 126],
		] as const) {
			const store = createNodeDurableLiveJournalStore({
				primaryFilename: join(directory, presentControl ? "present.sqlite" : "absent.sqlite"),
			});
			try {
				expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
				if (presentControl)
					await must(await store.acquireRetirementControl({ objectId: current.scope.objectId })).release();
				for (let ordinal = 0; ordinal < count; ordinal++)
					expect(await store.appendAccepted(local(ordinal))).toMatchObject({ ok: true, idempotent: false });
				if (!store.recordClosedMembership) throw new Error("native close carrier port unavailable");
				const membership = encodeCanonical({ kind: "mechanical-width-test", scope: current.scope, count });
				if (!presentControl) {
					const birth = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
					expect(
						await store.recordClosedMembership({
							scope: current.scope,
							exactCanonicalMembershipBytes: membership,
							expectedNativeImage: { imageDigest: birth.image.imageDigest, controlBytes: null },
						})
					).toMatchObject({ ok: true });
				}
				const before = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				expect(before.control?.revision ?? null).toBe(presentControl ? 61 : null);
				const unsignedSuccessor = {
					objectId: successor.install.objectId,
					exactCanonicalAnchorPreimageBytes: successor.install.exactCanonicalAnchorPreimageBytes,
					exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes,
				};
				const fence = { author, authorSequence: count + 1 };
				const predicted = journalFutureAppendPostimageWidths(
					before.canonicalRows,
					local(count),
					unsignedSuccessor,
					fence,
					[],
					{ control: before.control, ...(presentControl ? { closedMembershipByteLength: membership.length } : {}) }
				);
				const browser = journalFutureAppendPostimageWidths(
					browserFrames(before.canonicalRows),
					local(count),
					unsignedSuccessor,
					fence,
					[],
					{ control: before.control, ...(presentControl ? { closedMembershipByteLength: membership.length } : {}) }
				);
				for (const byteLength of [-1, 1.5, Number.NaN, LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1])
					expect(() =>
						journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, fence, [], {
							closedMembershipByteLength: byteLength,
						})
					).toThrow();
				let getterCalls = 0;
				expect(() =>
					journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, fence, [], {
						get closedMembershipByteLength() {
							getterCalls++;
							return membership.length;
						},
					})
				).toThrow("malformed-input");
				expect(getterCalls).toBe(0);
				if (presentControl) {
					expect(() =>
						journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, fence, [], {
							closedMembershipByteLength: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
						})
					).toThrow("retirement-fenced");
				} else {
					expect(
						journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, fence)
					).toEqual(predicted);
					expect(() =>
						journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, fence, [], {
							closedMembershipByteLength: membership.length,
						})
					).toThrow("evidence-conflict");
				}
				expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(before);
				expect(await store.appendAccepted(local(count))).toMatchObject({ ok: true, idempotent: false });
				const appended = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(predicted.afterLocal, appended.canonicalRows);
				check(browser.afterLocal, browserFrames(appended.canonicalRows));
				if (presentControl) {
					expect(
						await store.recordClosedMembership({
							scope: current.scope,
							exactCanonicalMembershipBytes: membership,
							expectedNativeImage: {
								imageDigest: appended.image.imageDigest,
								controlBytes: appended.control === null ? null : encodeJournalRetirementControl(appended.control),
							},
						})
					).toMatchObject({ ok: true, value: { idempotent: false } });
				}
				expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true, idempotent: false });
				const installed = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(predicted.afterSuccessor, installed.canonicalRows);
				check(browser.afterSuccessor, browserFrames(installed.canonicalRows));
				expect(await store.appendAccepted(local(count + 1, successor.scope))).toMatchObject({
					ok: true,
					idempotent: false,
				});
				const finished = must(await store.readRetirementImage({ objectId: current.scope.objectId }));
				check(predicted.afterSuccessorLocal, finished.canonicalRows);
				check(browser.afterSuccessorLocal, browserFrames(finished.canonicalRows));
				expect(finished.image.byteCharge).toBe(predicted.afterSuccessorLocal?.nativeImageBytes);
				const projectedControl =
					before.control === null
						? null
						: advanceJournalRetirementControl(
								advanceJournalRetirementControl(
									advanceJournalRetirementControl(advanceJournalRetirementControl(before.control))
								)
							);
				expect(finished.control).toEqual(projectedControl);
				expect(finished.control?.revision ?? null).toBe(presentControl ? 65 : null);
				if (presentControl) expect(encodeCanonical(64).length).toBeGreaterThan(encodeCanonical(61).length);
				else {
					expect(predicted.afterLocal.canonicalRowBytes).toHaveLength(128);
					expect(predicted.afterSuccessorLocal?.canonicalRowBytes).toHaveLength(130);
				}
				expect(() =>
					journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, {
						...fence,
						author: author + "-foreign",
					})
				).toThrow("malformed-input");
				expect(() =>
					journalFutureAppendPostimageWidths(before.canonicalRows, local(count), unsignedSuccessor, {
						...fence,
						authorSequence: count + 2,
					})
				).toThrow("malformed-input");
				expect(must(await store.readRetirementImage({ objectId: current.scope.objectId }))).toEqual(finished);
			} finally {
				await store.close();
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
