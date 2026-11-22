import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aheRetirementGenerationIdentity, decodeAheRetirementControl, digestBlob, encodeGenerationRecordV1,
	type AheRetirementPreparation, type StoreResult } from "@ts-drp/storage";
import {BoundedReadBudgetError} from "@ts-drp/storage/adapter";
import { createBrowserAheDurableStore } from "../src/internal/idb-adapter.js";
import { PHASE_2D_BLOBS_STORE, PHASE_5C_STORAGE_META_STORE } from "../src/internal/schema-idb.js";
import * as retirement from "../src/internal/retirement-control.js";

function must<T>(result: StoreResult<T>): T {
	if (!result.ok) throw Error(result.reason);
	return result.value;
}

async function seedAdopted(store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>, objectId: never): Promise<void> {
	const generationId = "b".repeat(64) as never, bytes = Uint8Array.of(1), digest = must(digestBlob(bytes));
	must(await store.beginGeneration({objectId, generationId, baseExpectedHead: {kind: "none", objectId},
		closure: [{digest, byteLength: bytes.length}]}));
	must(await store.putCachedBlob({objectId, generationId, digest, bytes}));
	must(await store.promoteReference({objectId, generationId, digest}));
	must(await store.completeGeneration({objectId, generationId}));
	must(await store.swapHead({objectId, generationId, expectedHead: {kind: "none", objectId}}));
}

afterEach(() => vi.restoreAllMocks());

describe("same-transaction metadata retirement census", () => {
	it("prepares and commits with one original RW census and an independent RO postimage", async () => {
		const databaseName = `metadata-census-${crypto.randomUUID()}`;
		const store = await createBrowserAheDurableStore({databaseName});
		try {
			const objectId = `metadata-census:${"a".repeat(32)}` as never;
			const generationId = "b".repeat(64) as never, bytes = Uint8Array.of(1), digest = must(digestBlob(bytes));
			must(await store.beginGeneration({objectId, generationId, baseExpectedHead: {kind: "none", objectId},
				closure: [{digest, byteLength: bytes.length}]}));
			must(await store.putCachedBlob({objectId, generationId, digest, bytes}));
			must(await store.promoteReference({objectId, generationId, digest}));
			must(await store.completeGeneration({objectId, generationId}));
			const head = must(await store.swapHead({objectId, generationId, expectedHead: {kind: "none", objectId}})).head;
			const generation = {objectId, generationId, state: "Adopted" as const, baseExpectedHead: {kind: "none" as const, objectId},
				closureDigest: head.closureDigest, closure: [{digest, byteLength: bytes.length}]};
			const recordDigest = must(digestBlob(encodeGenerationRecordV1(generation)));
			const spy = vi.spyOn(retirement, "admitBrowserRetirementControl");
			const read = must(await store.acquireRetirementControl!(objectId));
			// The noncreating observation joins before genuine strict-RW birth.
			expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readonly", "readwrite"]);
			const preparation: AheRetirementPreparation = {head, floorEpoch: 2, floorAnchor: "c".repeat(64),
				decisionDigest: "d".repeat(64), sourceProofDigest: "e".repeat(64), generationRecordDigests: [recordDigest],
				snapshotScopes: [], protectedIndices: [], retireIndices: [], domains: Array.from({length: 8}, (_, index) =>
					[2 ** index, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const)};
			spy.mockClear();
			must(await read.prepareBound({preparation, generations: {recordDigests: [recordDigest],
				identities: [{generationId, identityDigest: aheRetirementGenerationIdentity(generation)}], protectedIndices: [0], retireIndices: []}}));
			await read.release();
			expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readwrite", "readonly"]);
			spy.mockClear();
			const commit = must(await store.acquireRetirementControl!(objectId));
			expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readonly"]);
			spy.mockClear();
			const completed = must(await commit.commitPrepared({decisionDigest: preparation.decisionDigest,
				sourceProofDigest: preparation.sourceProofDigest}));
			await commit.release();
			expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readwrite", "readonly"]);
			expect(completed.active).toBeNull(); expect(completed.completed?.sourceProofDigest).toBe(preparation.sourceProofDigest);
			expect(await store.getBlob(digest)).toEqual({ok: true, value: bytes});
			// An acquired old view cannot hide a subsequent physical corruption.
			// The original first RW census must still refuse before metadata effects.
			const stale = must(await store.acquireRetirementControl!(objectId));
			const raw = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName);
				request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = raw.transaction(PHASE_2D_BLOBS_STORE, "readwrite");
					transaction.objectStore(PHASE_2D_BLOBS_STORE).delete(digest);
					transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
				});
				spy.mockClear();
				expect(await stale.prepareBound({preparation, generations: {recordDigests: [recordDigest],
					identities: [{generationId, identityDigest: aheRetirementGenerationIdentity(generation)}], protectedIndices: [0], retireIndices: []}}))
					.toEqual({ok: false, reason: "ADOPTED_BLOB_MISSING"});
				await stale.release();
				expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readwrite"]);
				const actual = await new Promise<{record: Uint8Array}>((resolve, reject) => {
					const request = raw.transaction(PHASE_5C_STORAGE_META_STORE, "readonly")
						.objectStore(PHASE_5C_STORAGE_META_STORE).get(`ahe-retirement:${objectId}`);
					request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
				});
				expect(decodeAheRetirementControl(actual.record)).toEqual({ok: true, value: completed});
			} finally { raw.close(); }
		} finally { await store.close(); }
	});

	it("observes an existing coordinator through the same genuine held RO, with fresh native qualification after release", async () => {
		const databaseName = `metadata-held-control-${crypto.randomUUID()}`;
		const store = await createBrowserAheDurableStore({databaseName});
		const objectId = `metadata-held-control:${"a".repeat(32)}` as never;
		try {
			await seedAdopted(store, objectId);
			const born = must(await store.acquireRetirementControl!(objectId));
			const expected = {control: born.control, head: born.head, imageDigest: born.imageDigest, metadataBytes: born.metadataBytes};
			await born.release();
			const held = await store.acquireNativeReadReservation({objectId});
			const spy = vi.spyOn(retirement, "admitBrowserRetirementControl");
			const first = must(await store.acquireRetirementControl!(objectId));
			expect({control: first.control, head: first.head, imageDigest: first.imageDigest, metadataBytes: first.metadataBytes}).toEqual(expected);
			expect(spy.mock.calls.map(([transaction]) => transaction.mode)).toEqual(["readonly"]);
			const transaction = spy.mock.calls[0]![0];
			const second = must(await store.acquireRetirementControl!(objectId));
			expect(second.control).toEqual(expected.control);
			// Reuse is supplied by the original point owner under this exact real
			// physical transaction, not by a cached epoch/image or caller object.
			expect(spy).toHaveBeenCalledTimes(1);
			await first.release(); await second.release(); await held.check(); await held.release();
			const after = must(await store.acquireRetirementControl!(objectId));
			expect(after.control).toEqual(expected.control); await after.release();
			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy.mock.calls[1]![0]).not.toBe(transaction);
		} finally {await store.close();}
	});

	it("serializes concurrent missing-control births and preserves acquisition poisoning without changing public point reads", async () => {
		const databaseName = `metadata-control-birth-${crypto.randomUUID()}`;
		const first = await createBrowserAheDurableStore({databaseName});
		const second = await createBrowserAheDurableStore({databaseName});
		const objectId = `metadata-control-birth:${"a".repeat(32)}` as never;
		const open = indexedDB.open(databaseName);
		const raw = await new Promise<IDBDatabase>((resolve, reject) => {
			open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
		});
		try {
			await seedAdopted(first, objectId);
			const expectedHead = must(await first.readHead(objectId));
			const born = (await Promise.all([first.acquireRetirementControl!(objectId), second.acquireRetirementControl!(objectId)])).map(must);
			expect(born[0]!.control).toEqual(born[1]!.control);
			expect(born[0]!.imageDigest).toBe(born[1]!.imageDigest);
			await Promise.all(born.map(read => read.release()));
			await new Promise<void>((resolve, reject) => {
				const transaction = raw.transaction(PHASE_5C_STORAGE_META_STORE, "readwrite");
				transaction.objectStore(PHASE_5C_STORAGE_META_STORE).put({key: `ahe-retirement:${objectId}`, record: Uint8Array.of(255)});
				transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
			});
			// Point reads retain their existing no-new-poison error contract.
			expect((await first.readRetirementAdmissionImage!(objectId)).ok).toBe(false);
			expect(await first.readHead(objectId)).toEqual({ok: true, value: expectedHead});
			expect(await first.acquireRetirementControl!(objectId)).toEqual({ok: false, reason: "NON_CANONICAL_RECORD"});
			expect(await first.readHead(objectId)).toEqual({ok: false, reason: "STORE_POISONED"});
		} finally {raw.close(); await first.close(); await second.close();}
	});

	it("preserves acquisition-only budget exception translation without poisoning or changing public point reads", async () => {
		const store = await createBrowserAheDurableStore({databaseName: `metadata-budget-${crypto.randomUUID()}`});
		const objectId = `metadata-budget:${"a".repeat(32)}` as never;
		try {
			await seedAdopted(store, objectId);
			const born = must(await store.acquireRetirementControl!(objectId)); await born.release();
			const expectedHead = must(await store.readHead(objectId));
			const budget = new BoundedReadBudgetError();
			vi.spyOn(retirement, "admitBrowserRetirementControl").mockImplementation(async () => {throw budget;});
			expect(await store.acquireRetirementControl!(objectId)).toEqual({ok: false, reason: "READ_BUDGET_EXCEEDED"});
			expect(await store.readHead(objectId)).toEqual({ok: true, value: expectedHead});
			const point = await store.readRetirementAdmissionImage!(objectId);
			expect(point).toEqual({ok: false, reason: "SUBSTRATE_FAILURE", cause: budget});
			if (!point.ok && "cause" in point) expect(point.cause).toBe(budget);
			expect(await store.readHead(objectId)).toEqual({ok: true, value: expectedHead});
		} finally {await store.close();}
	});

	it("retains the actual second admission call for every physical mutation and propagates its refusal", async () => {
		// Execute the production branch expression. This is a focused control-flow
		// check, not native mutation/crash evidence; the real native suite owns that.
		const source = readFileSync(new URL("../src/internal/idb-adapter.ts", import.meta.url), "utf8");
		const ast = ts.createSourceFile("idb-adapter.ts", source, ts.ScriptTarget.Latest, true);
		const selected: ts.VariableDeclaration[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "after" &&
				node.initializer?.getText(ast).includes("admitBrowserRetirementControl")) selected.push(node);
			ts.forEachChild(node, visit);
		}; visit(ast);
		expect(selected).toHaveLength(1);
		const expression = ts.transpile(`async function run(mutation, admitted, admitBrowserRetirementControl, transaction, objectId, bytes) {
			return ${selected[0]!.initializer!.getText(ast)};
		}`, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None});
		const run = new Function(`${expression}; return run;`)();
		const before = {ok: true, value: {imageDigest: "before"}}, after = {ok: false, reason: "READ_STALE_ROLE_VIEW"};
		for (const kind of ["stage", "publish", "reclaim"]) {
			const admit = vi.fn(async () => after), transaction = {}, objectId = "room", bytes = Uint8Array.of(1);
			expect(await run({kind}, before, admit, transaction, objectId, bytes)).toBe(after);
			expect(admit).toHaveBeenCalledExactlyOnceWith(transaction, objectId, bytes);
		}
		const admit = vi.fn(); expect(await run(undefined, before, admit, {}, "room", Uint8Array.of(1))).toBe(before);
		expect(admit).not.toHaveBeenCalled();
	});
});
