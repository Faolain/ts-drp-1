import "fake-indexeddb/auto";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import { byteBoundaryEntries } from "./fixtures/phase-3f-c/application-batching-fixture.js";
import {
	openSettlementNode,
	type OpenSettlementNode,
} from "./fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.js";
import {
	code,
	commit,
	failure,
	legacyEffect,
	legacyEntry,
	plan,
	progress,
	PROGRESS_DIGEST,
	PROGRESS_SCOPE,
	progressEffect,
	progressEntry,
	snapshot,
} from "./fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.js";
import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import {
	applySettlementPlanEffect,
	cloneSettlementPlan,
	copyAndValidateDurableIssueCommit,
	copySettlementPlan,
	copySettlementPlanEffect,
} from "../packages/issuance-store/src/contract.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

interface Store {
	close(): Promise<void>;
	readIssued(scope: unknown, sequence: number): Promise<unknown>;
	readLineage(scope: unknown): Promise<Readonly<{ readonly exhausted: boolean; readonly next: number }>>;
	readOutboxPage(input: unknown): Promise<readonly unknown[]>;
	readSettlementPlan(scope: unknown): Promise<unknown>;
	transactIssue(scope: unknown, build: (sequence: number) => Promise<unknown>): Promise<unknown>;
	transactWriteSettlementPlan(input: unknown): Promise<unknown>;
}

const temporaryDirectories: string[] = [];
const activeNodes: OpenSettlementNode[] = [];
let browserId = 0;

async function openStore(kind: "browser" | "memory" | "node"): Promise<Store> {
	if (kind === "memory") return createEphemeralDurableIssuanceStore() as unknown as Store;
	if (kind === "browser") {
		return (await createBrowserDurableIssuanceStore({
			primaryDatabaseName: `d110c-f5b0t-${browserId++}`,
		})) as unknown as Store;
	}
	const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0t-"));
	temporaryDirectories.push(directory);
	return createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") }) as unknown as Store;
}

async function install(store: Store, selectedPlan: unknown = plan()): Promise<unknown> {
	return store.transactWriteSettlementPlan({ expectedRevision: null, plan: selectedPlan, scope: PROGRESS_SCOPE });
}

function withScope(selectedPlan: Readonly<Record<string, unknown>>, scope: unknown): Readonly<Record<string, unknown>> {
	return Object.freeze({ ...selectedPlan, scope });
}

afterEach(async () => {
	await Promise.all(activeNodes.splice(0).map((node) => node.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("D.110c-0c1f5b0t settlement progress codec RED", () => {
	it("keeps the four-key entry, two-key effect and one-chunk legacy path byte-for-byte", () => {
		const legacyPlan = Object.freeze({
			entries: Object.freeze([legacyEntry()]),
			fenceSequence: 4,
			revision: 0,
			scope: PROGRESS_SCOPE,
		});
		const copied = copySettlementPlan(legacyPlan, PROGRESS_SCOPE);
		expect(snapshot(copied)).toEqual(snapshot(legacyPlan));
		expect(snapshot(copySettlementPlanEffect(legacyEffect()))).toEqual(snapshot(legacyEffect()));
		const linked = applySettlementPlanEffect(copied as NonNullable<typeof copied>, legacyEffect() as never, 9);
		expect(snapshot(linked)).toEqual(
			snapshot({
				...legacyPlan,
				entries: [{ ...legacyEntry(), replacementSequence: 9 }],
				revision: 1,
			})
		);
	});

	it("accepts exact empty, partial and complete progress and deep-clones nested bytes and chunks", () => {
		const vectors = [
			plan(progressEntry(progress(3))),
			plan(progressEntry(progress(3, [{ lastLogicalTime: 11, replacementSequence: 5, throughIntent: 2 }]))),
			plan(
				progressEntry(
					progress(3, [
						{ lastLogicalTime: 11, replacementSequence: 5, throughIntent: 2 },
						{ lastLogicalTime: 13, replacementSequence: 6, throughIntent: 3 },
					]),
					6
				)
			),
		] as const;
		for (const [index, vector] of vectors.entries()) {
			const copied = copySettlementPlan(vector, PROGRESS_SCOPE);
			expect.soft(copied, `D110C_0C1F5B0T_PROGRESS_VECTOR_${index}_REJECTED`).toBeDefined();
			if (copied === undefined) continue;
			const cloned = cloneSettlementPlan(copied);
			expect.soft(snapshot(cloned)).toEqual(snapshot(vector));
			const digest = Reflect.get(
				Reflect.get(cloned.entries[0] as object, "replacementProgress") as object,
				"intentDigest"
			);
			expect.soft(digest).not.toBe(PROGRESS_DIGEST);
		}
	});

	it("pins 16 as accepted and 17 as rejected without treating 17 as a settlement source", () => {
		expect(copySettlementPlan(plan(progressEntry(progress(16))), PROGRESS_SCOPE)).toBeDefined();
		expect(copySettlementPlan(plan(progressEntry(progress(17))), PROGRESS_SCOPE)).toBeUndefined();
	});

	it("rejects malformed progress, nonmonotonic chunks, wrong projection and forbidden dispositions", () => {
		const malformed = [
			progressEntry({ ...progress(), extra: true }),
			progressEntry({ ...progress(), version: 2 }),
			progressEntry({ ...progress(), intentCount: 0 }),
			progressEntry({ ...progress(), intentDigest: new Uint8Array(31) }),
			progressEntry(progress(3, [{ lastLogicalTime: 1, replacementSequence: 1, throughIntent: 0 }])),
			progressEntry(
				progress(3, [
					{ lastLogicalTime: 2, replacementSequence: 2, throughIntent: 2 },
					{ lastLogicalTime: 1, replacementSequence: 3, throughIntent: 3 },
				])
			),
			progressEntry(
				progress(3, [
					{ lastLogicalTime: 1, replacementSequence: 2, throughIntent: 2 },
					{ lastLogicalTime: 3, replacementSequence: 1, throughIntent: 3 },
				])
			),
			progressEntry(progress(3, [{ lastLogicalTime: 1, replacementSequence: 2, throughIntent: 3 }]), null),
			progressEntry(progress(3, [{ lastLogicalTime: 1, replacementSequence: 2, throughIntent: 2 }]), 2),
			progressEntry(progress(), null, 7, "expire"),
			progressEntry(progress(), null, 7, "manual-review"),
		];
		for (const [index, entry] of malformed.entries()) {
			expect
				.soft(copySettlementPlan(plan(entry), PROGRESS_SCOPE), `D110C_0C1F5B0T_BAD_PROGRESS_${index}_ACCEPTED`)
				.toBeUndefined();
		}
	});

	it("accepts only the exact five-key progress effect and copies its digest", () => {
		const valid = progressEffect(0, 2);
		const copied = copySettlementPlanEffect(valid);
		expect(snapshot(copied), "D110C_0C1F5B0T_PROGRESS_EFFECT_REJECTED").toEqual(snapshot(valid));
		if (copied !== undefined) expect(Reflect.get(copied, "intentDigest")).not.toBe(PROGRESS_DIGEST);
		for (const invalid of [
			{ ...valid, extra: true },
			{ ...valid, intentDigest: new Uint8Array(31) },
			{ ...valid, fromIntent: -1 },
			{ ...valid, fromIntent: 2, throughIntent: 2 },
			{ ...valid, throughIntent: 17 },
		]) {
			expect.soft(copySettlementPlanEffect(invalid)).toBeUndefined();
		}
	});

	it("validates a progress effect as a closed commit instead of failing on a future export", () => {
		const candidate = commit(0, progressEffect(0, 2), 11, 2);
		expect(() => copyAndValidateDurableIssueCommit(candidate, PROGRESS_SCOPE, 0)).not.toThrow();
	});
});

describe("D.110c-0c1f5b0t settlement progress store RED", () => {
	it.each(["memory", "browser", "node"] as const)(
		"%s atomically records a partial chunk, then only the final chunk projects replacementSequence",
		async (kind) => {
			const store = await openStore(kind);
			try {
				await install(store);
				const first = await store.transactIssue(PROGRESS_SCOPE, (sequence) =>
					Promise.resolve(commit(sequence, progressEffect(0, 2), 11, 2))
				);
				expect(Reflect.get(first as object, "authorSequence")).toBe(0);
				expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
					entries: [
						{
							replacementProgress: {
								chunks: [{ lastLogicalTime: 11, replacementSequence: 0, throughIntent: 2 }],
							},
							replacementSequence: null,
						},
					],
					revision: 1,
				});
				await store.transactIssue(PROGRESS_SCOPE, (sequence) =>
					Promise.resolve(commit(sequence, progressEffect(2, 3), 13, 1))
				);
				expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
					entries: [
						{
							replacementProgress: {
								chunks: [
									{ lastLogicalTime: 11, replacementSequence: 0, throughIntent: 2 },
									{ lastLogicalTime: 13, replacementSequence: 1, throughIntent: 3 },
								],
							},
							replacementSequence: 1,
						},
					],
					revision: 2,
				});
				expect(await store.readIssued(PROGRESS_SCOPE, 0)).not.toBeNull();
				expect(await store.readIssued(PROGRESS_SCOPE, 1)).not.toBeNull();
				expect(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 2 });
			} finally {
				await store.close();
			}
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s rolls back issued/outbox/lineage/plan state and preserves monotonic CAS progress",
		async (kind) => {
			const store = await openStore(kind);
			try {
				const partial = plan(
					progressEntry(progress(3, [{ lastLogicalTime: 11, replacementSequence: 0, throughIntent: 2 }]))
				);
				await install(store, partial);
				const controlled = await failure(
					store.transactIssue(PROGRESS_SCOPE, () => Promise.reject(new Error("D110C_0C1F5B0T_INJECTED_ROLLBACK")))
				);
				expect(controlled).toBeInstanceOf(Error);
				expect(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 0 });
				expect(await store.readIssued(PROGRESS_SCOPE, 0)).toBeNull();
				expect(await store.readOutboxPage({ scope: PROGRESS_SCOPE })).toEqual([]);
				expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toEqual(snapshot(partial));

				const dropping = plan(progressEntry(progress(3)), 1);
				const rejected = await failure(
					store.transactWriteSettlementPlan({ expectedRevision: 0, plan: dropping, scope: PROGRESS_SCOPE })
				);
				expect(code(rejected)).toBe("ISSUANCE_RETRY_REQUIRED");
			} finally {
				await store.close();
			}
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s resolves an ambiguous partial receipt only from the exact durable row, chunk and revision",
		async (kind) => {
			const store = await openStore(kind);
			try {
				await install(store);
				const lost = await failure(
					store
						.transactIssue(PROGRESS_SCOPE, (sequence) => Promise.resolve(commit(sequence, progressEffect(0, 2), 11, 2)))
						.then(() => Promise.reject(new Error("D110C_0C1F5B0T_LOST_RECEIPT")))
				);
				expect(lost).toBeInstanceOf(Error);
				const durable = await store.readSettlementPlan(PROGRESS_SCOPE);
				expect(snapshot(durable)).toMatchObject({
					entries: [
						{
							replacementProgress: {
								chunks: [{ lastLogicalTime: 11, replacementSequence: 0, throughIntent: 2 }],
								intentDigest: [...PROGRESS_DIGEST],
							},
							replacementSequence: null,
						},
					],
					revision: 1,
				});
				expect(await store.readIssued(PROGRESS_SCOPE, 0)).not.toBeNull();
			} finally {
				await store.close();
			}
		}
	);

	it("uses exact error ownership for malformed commits, stale progress and corrupt stored values", async () => {
		const store = await openStore("memory");
		try {
			await install(store);
			const malformed = await failure(
				store.transactIssue(PROGRESS_SCOPE, (sequence) =>
					Promise.resolve(commit(sequence, { ...progressEffect(0, 2), throughIntent: 17 }, 11, 2))
				)
			);
			expect(code(malformed)).toBe("ISSUANCE_COMMIT_INVALID");
			const stale = await failure(
				store.transactIssue(PROGRESS_SCOPE, (sequence) =>
					Promise.resolve(commit(sequence, progressEffect(1, 2), 11, 1))
				)
			);
			expect(code(stale)).toBe("ISSUANCE_RETRY_REQUIRED");
			expect(await store.readLineage(PROGRESS_SCOPE)).toEqual({ exhausted: false, next: 0 });
		} finally {
			await store.close();
		}
	});

	it("round-trips nested progress through browser structured clone and Node JSON without changing schemas", async () => {
		for (const kind of ["browser", "node"] as const) {
			const store = await openStore(kind);
			try {
				await install(store);
				const read = await store.readSettlementPlan(PROGRESS_SCOPE);
				expect(snapshot(read)).toEqual(snapshot(plan()));
				const progressValue = Reflect.get(
					Reflect.get(
						(Reflect.get(read as object, "entries") as readonly object[])[0] as object,
						"replacementProgress"
					) as object,
					"intentDigest"
				);
				expect(progressValue).toBeInstanceOf(Uint8Array);
			} finally {
				await store.close();
			}
		}
	});

	it.each(["browser", "node"] as const)(
		"%s reopens before/after partial and final chunks without losing exact progress",
		async (kind) => {
			const browserName = `d110c-f5b0t-restart-${browserId++}`;
			const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0t-restart-"));
			temporaryDirectories.push(directory);
			const filename = join(directory, "primary.sqlite");
			const open = async (): Promise<Store> =>
				kind === "browser"
					? ((await createBrowserDurableIssuanceStore({ primaryDatabaseName: browserName })) as unknown as Store)
					: (createNodeDurableIssuanceStore({ primaryFilename: filename }) as unknown as Store);

			let store = await open();
			await install(store);
			await store.close();
			store = await open();
			expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toEqual(snapshot(plan()));
			await store.transactIssue(PROGRESS_SCOPE, (sequence) =>
				Promise.resolve(commit(sequence, progressEffect(0, 2), 11, 2))
			);
			await store.close();
			store = await open();
			expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
				entries: [{ replacementProgress: { chunks: [{ throughIntent: 2 }] }, replacementSequence: null }],
			});
			await store.transactIssue(PROGRESS_SCOPE, (sequence) =>
				Promise.resolve(commit(sequence, progressEffect(2, 3), 13, 1))
			);
			await store.close();
			store = await open();
			expect(snapshot(await store.readSettlementPlan(PROGRESS_SCOPE))).toMatchObject({
				entries: [{ replacementProgress: { chunks: [{}, {}] }, replacementSequence: 1 }],
			});
			await store.close();
		}
	);
});

describe("D.110c-0c1f5b0t Node pre-reservation and split RED", () => {
	it("keeps the real 16-operation Node batch bound independent and reports a nonmutating legal split", async () => {
		const result = await runFrontierScenario(1, {
			batchBoundaryProfile: true,
			operations: byteBoundaryEntries(true),
			seedOperation: Object.freeze({ action: "payload", text: "seed" }),
		});
		expect(result.result).toMatchObject({ kind: "split-required", ok: false, prefixLength: 1 });
		expect(result).toMatchObject({ journalAppends: 0, signerCalls: 0 });
		expect(result.issued).toHaveLength(0);
	});

	it("refuses malformed and stale progress before signing, while a valid exact prefix issues", async () => {
		const opened = await openSettlementNode();
		activeNodes.push(opened);
		await opened.issuanceStore.transactWriteSettlementPlan({
			expectedRevision: null,
			plan: withScope(plan(), opened.scope) as never,
			scope: opened.scope,
		});
		const operation = Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 1 }) });
		const before = await opened.issuanceStore.readLineage(opened.scope);
		for (const [effect, expected, attempts] of [
			[{ ...progressEffect(0, 1), extra: true }, "malformed-input", 1],
			[{ ...progressEffect(0, 1), intentDigest: new Uint8Array(32).fill(1) }, "issuance-rejected", 3],
			[progressEffect(1, 2), "issuance-rejected", 3],
		] as const) {
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				const signer = vi.fn(opened.fixture.signRegisteredVertexDigest);
				const result = await opened.plane.issueLocal({
					operations: [operation],
					planEffect: effect,
					signRegisteredVertexDigest: signer,
				} as never);
				expect.soft(result).toMatchObject({ kind: expected, ok: false });
				expect.soft(signer).not.toHaveBeenCalled();
				expect.soft(await opened.issuanceStore.readLineage(opened.scope)).toEqual(before);
			}
		}
		const signer = vi.fn(opened.fixture.signRegisteredVertexDigest);
		const issued = await opened.plane.issueLocal({
			operations: [operation],
			planEffect: progressEffect(0, 1),
			signRegisteredVertexDigest: signer,
		} as never);
		expect(issued).toMatchObject({ ok: true });
		expect(signer).toHaveBeenCalledTimes(1);
	});

	it("pins the progress owners without confusing a source-shape diagnostic with runtime proof", async () => {
		const [types, contract, node, room, browser, storageNode] = await Promise.all([
			readFile("packages/issuance-store/src/types.ts", "utf8"),
			readFile("packages/issuance-store/src/contract.ts", "utf8"),
			readFile("packages/node/src/v3-live.ts", "utf8"),
			readFile("examples/v3-room/src/index.ts", "utf8"),
			readFile("packages/storage-browser/src/internal/browser-issuance-store.ts", "utf8"),
			readFile("packages/storage-node/src/internal/node-issuance-store.ts", "utf8"),
		]);
		for (const token of [
			"SettlementReplacementChunk",
			"SettlementReplacementProgress",
			"SETTLEMENT_REPLACEMENT_MAX_INTENTS",
			"SETTLEMENT_REPLACEMENT_DIGEST_LIMITS",
		]) {
			expect.soft(types.includes(token), `D110C_0C1F5B0T_TYPE_OWNER_${token}_MISSING`).toBe(true);
		}
		expect.soft(contract.includes("replacementProgress")).toBe(true);
		expect.soft(contract.includes("lastLogicalTime")).toBe(true);
		expect.soft(node.includes("throughIntent")).toBe(true);
		expect.soft(node.includes("fromIntent")).toBe(true);
		expect.soft(node.includes("input.operations.length")).toBe(true);
		const readerStart = node.indexOf("async function readSettlementSources");
		expect.soft(readerStart).toBeGreaterThanOrEqual(0);
		const sourceReader = readerStart < 0 ? "" : node.slice(readerStart, readerStart + 2_500);
		expect.soft(sourceReader.includes("readSettlementPlan")).toBe(true);
		expect.soft(sourceReader.includes("replacementProgress")).toBe(true);
		expect.soft(room.includes("ts-drp/settlement-replacement-intents/v1")).toBe(true);
		expect.soft(room.includes("split-required")).toBe(true);
		expect.soft(browser.includes("replacementProgress")).toBe(true);
		expect.soft(storageNode.includes("replacementProgress")).toBe(true);
		expect.soft(browser.includes("const DATABASE_VERSION = 2")).toBe(true);
		expect.soft(storageNode.includes("const SCHEMA_VERSION = 3")).toBe(true);
	});
});
