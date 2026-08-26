import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	CRASH_CHECKPOINTS,
	creatorActorReadiness,
	EXACT_VOTE_TRANSACTION_STORES,
	exactKeys,
	EXPECTED_EXPORTS,
	EXPECTED_SCHEMA_V3,
	MUTANT_REJECTIONS,
	NEW_SEMANTIC_OWNERS,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
} from "./fixtures/phase-5e-v3/creator-actor-contract.js";
import type { CreatorActorHarness } from "./fixtures/phase-5e-v3/creator-actor-driver.js";
import { PHASE_5C_SCHEMA_AUTHORITY } from "../packages/storage-browser/src/internal/schema-idb.js";
import { openInternalSealVoteStore } from "../packages/storage-browser/src/internal/seal-vote-store.js";

const readiness = creatorActorReadiness();
const openedDatabases: string[] = [];
type QcVerification = Readonly<
	| { ok: false; reason: string }
	| {
			ok: true;
			phase: "commit" | "prepare";
			proposalHash: string;
			qcDigest: string;
			round: number;
			valueDigest: string;
	  }
>;

async function openCreatorActorHarness(databaseName: string): Promise<CreatorActorHarness> {
	const driver = await import("./fixtures/phase-5e-v3/creator-actor-driver.js");
	return driver.openCreatorActorHarness(databaseName);
}

async function verifyCreatorActorQc(
	harness: Awaited<ReturnType<typeof openCreatorActorHarness>>,
	exactCanonicalQcBytes: Uint8Array
): Promise<QcVerification> {
	const driver = await import("./fixtures/phase-5e-v3/creator-actor-driver.js");
	return driver.verifyCreatorActorQc(harness, exactCanonicalQcBytes);
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolvePromise) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolvePromise());
		request.addEventListener("error", () => resolvePromise());
		request.addEventListener("blocked", () => resolvePromise());
	});
}

async function rawDatabase(databaseName: string): Promise<
	Readonly<{
		counts: Readonly<Record<string, number>>;
		rows: Readonly<Record<string, readonly unknown[]>>;
		schema: readonly Readonly<{
			autoIncrement: boolean;
			indexes: readonly string[];
			keyPath: string | readonly string[] | null;
			name: string;
		}>[];
		sealEvidence: readonly unknown[];
		stores: readonly string[];
		version: number;
	}>
> {
	const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName);
		request.addEventListener("error", () => reject(request.error ?? new Error("raw database open failed")));
		request.addEventListener("success", () => resolvePromise(request.result));
	});
	try {
		const stores = Array.from(database.objectStoreNames);
		const schema = stores.map((storeName) => {
			const store = database.transaction(storeName, "readonly").objectStore(storeName);
			return Object.freeze({
				autoIncrement: store.autoIncrement,
				indexes: Object.freeze(Array.from(store.indexNames)),
				keyPath: Array.isArray(store.keyPath) ? Object.freeze([...store.keyPath]) : store.keyPath,
				name: storeName,
			});
		});
		const counts = Object.fromEntries(
			await Promise.all(
				stores.map(
					(storeName) =>
						new Promise<readonly [string, number]>((resolvePromise, reject) => {
							const request = database.transaction(storeName, "readonly").objectStore(storeName).count();
							request.addEventListener("error", () => reject(request.error));
							request.addEventListener("success", () => resolvePromise([storeName, request.result]));
						})
				)
			)
		);
		const rows = Object.fromEntries(
			await Promise.all(
				stores.map(
					(storeName) =>
						new Promise<readonly [string, readonly unknown[]]>((resolvePromise, reject) => {
							const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
							request.addEventListener("error", () => reject(request.error));
							request.addEventListener("success", () => resolvePromise([storeName, request.result]));
						})
				)
			)
		);
		const sealEvidence = rows.sealEvidence ?? [];
		return Object.freeze({ counts, rows, schema, sealEvidence, stores, version: database.version });
	} finally {
		database.close();
	}
}

async function corruptFinalizedQc(databaseName: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName);
		request.addEventListener("error", () => reject(request.error));
		request.addEventListener("success", () => resolvePromise(request.result));
	});
	try {
		const transaction = database.transaction("signerState", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("signerState");
		const row = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
			const request = store.openCursor();
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => {
				if (request.result === null) reject(new Error("missing signer-state row"));
				else resolvePromise(request.result.value as Record<string, unknown>);
			});
		});
		const finalized = row.finalizedCommitQC;
		if (finalized === null || typeof finalized !== "object") throw new Error("missing finalized commit QC");
		store.put({
			...row,
			finalizedCommitQC: { ...(finalized as Record<string, unknown>), exactCanonicalQcBytes: Uint8Array.of(0xff) },
		});
		await new Promise<void>((resolvePromise, reject) => {
			transaction.addEventListener("abort", () => reject(transaction.error));
			transaction.addEventListener("complete", () => resolvePromise());
			transaction.addEventListener("error", () => reject(transaction.error));
		});
	} finally {
		database.close();
	}
}

async function mutateSealEvidence(
	databaseName: string,
	mutate: (row: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName);
		request.addEventListener("error", () => reject(request.error ?? new Error("raw database open failed")));
		request.addEventListener("success", () => resolvePromise(request.result));
	});
	try {
		const transaction = database.transaction("sealEvidence", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("sealEvidence");
		const rows = await new Promise<readonly Record<string, unknown>[]>((resolvePromise, reject) => {
			const request = store.getAll();
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => resolvePromise(request.result as Record<string, unknown>[]));
		});
		const row = rows[0];
		if (row === undefined) throw new Error("missing seal-evidence row");
		store.clear();
		store.add(mutate(row));
		await new Promise<void>((resolvePromise, reject) => {
			transaction.addEventListener("abort", () => reject(transaction.error));
			transaction.addEventListener("complete", () => resolvePromise());
			transaction.addEventListener("error", () => reject(transaction.error));
		});
	} finally {
		database.close();
	}
}

afterEach(async () => {
	await Promise.all(openedDatabases.splice(0).map(async (databaseName) => deleteDatabase(databaseName)));
});

describe("Phase 5e durable creator actor RED", () => {
	it("freezes the exact six RED and exact thirteen GREEN owner rosters", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(6);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(13);
		expect(NEW_SEMANTIC_OWNERS).toEqual([
			"packages/seal/src/creator.ts",
			"packages/seal/src/internal/creator-close-intent.ts",
			"packages/storage-browser/src/seal-evidence.ts",
			"packages/storage-browser/src/internal/seal-evidence-store.ts",
		]);
		expect(REQUIRED_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
	});

	it("keeps the inherited schema-v2 voter as an executable pre-readiness control", async () => {
		const databaseName = `phase5e-actor-v2-${crypto.randomUUID()}`;
		openedDatabases.push(databaseName);
		const store = await openInternalSealVoteStore({ databaseName });
		try {
			expect(store.schema).toEqual({
				stores: PHASE_5C_SCHEMA_AUTHORITY.stores.map(({ name }) => name).sort(),
				version: 2,
			});
			expect(store.incarnation).toMatch(/^[0-9a-f]{32,}$/u);
		} finally {
			store.close();
		}
	});

	it("defines one additive v3 store while preserving the frozen four-store vote transaction", () => {
		expect(EXPECTED_SCHEMA_V3.version).toBe(3);
		expect(EXPECTED_SCHEMA_V3.stores).toHaveLength(9);
		expect(EXPECTED_SCHEMA_V3.stores.map(({ name }) => name).sort()).toEqual([
			"blobs",
			"generations",
			"objects",
			"promotions",
			"sealEvidence",
			"signerState",
			"storageMeta",
			"voteOutbox",
			"voteSlots",
		]);
		expect(EXACT_VOTE_TRANSACTION_STORES).toEqual(["signerState", "storageMeta", "voteOutbox", "voteSlots"]);
		expect(EXPECTED_SCHEMA_V3.stores.find(({ name }) => name === "sealEvidence")).toEqual({
			autoIncrement: false,
			indexes: [],
			keyPath: ["objectId", "epoch", "signerId"],
			name: "sealEvidence",
		});
	});

	it("closes the causal crash and mutation catalog without adding authority", () => {
		expect(CRASH_CHECKPOINTS).toHaveLength(7);
		expect(new Set(CRASH_CHECKPOINTS).size).toBe(CRASH_CHECKPOINTS.length);
		expect(exactKeys(MUTANT_REJECTIONS)).toEqual([
			"AMBIGUOUS_COMMIT_RETRY",
			"CONFLICTING_CLOSE",
			"COPIED_ACTOR",
			"DUPLICATE_EXACT_BYTES",
			"EVIDENCE_AFTER_SIGN",
			"FOREIGN_SIGNER",
			"PROVISIONAL_CARRIER",
			"RAW_DIGEST_SIGN",
			"REOPEN_CORRUPT_QC",
			"STOP_LATE_EFFECT",
		]);
		expect(EXPECTED_EXPORTS).toEqual({
			creator: ["createCreatorSealActor"],
			evidence: ["openBrowserSealEvidenceStore"],
			finality: ["createRecoverableFinalitySigner", "signCreatorAnchorRequest", "signSealRegisteredDigest"],
		});
	});

	it("[RED readiness] requires the complete creator actor and evidence graph", () => {
		expect(readiness, `missing D.107b owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("keeps the actor, evidence, and finality subpaths closed", async () => {
		const specifiers = [
			"@ts-drp/seal/creator",
			"@ts-drp/storage-browser/seal-evidence",
			"@ts-drp/keychain/finality",
		] as const;
		const [creator, evidence, finality] = await Promise.all(specifiers.map(async (specifier) => import(specifier)));
		expect(exactKeys(creator)).toEqual(EXPECTED_EXPORTS.creator);
		expect(exactKeys(evidence)).toEqual(EXPECTED_EXPORTS.evidence);
		expect(exactKeys(finality)).toEqual(EXPECTED_EXPORTS.finality);
	});

	it.skipIf(!readiness.ready)(
		"persists the close candidate before either durable vote and releases only finalized evidence",
		async () => {
			const databaseName = `phase5e-actor-flow-${crypto.randomUUID()}`;
			openedDatabases.push(databaseName);
			const harness = await openCreatorActorHarness(databaseName);
			try {
				const pending = harness.actor.close({ closeInput: harness.closeInput });
				expect(harness.events).toEqual([]);
				const result = await pending;
				expect(result).toMatchObject({ ok: true, valueDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
				if (!result.ok) return;
				for (const bytes of [
					result.exactCanonicalPrepareQcBytes,
					result.exactCanonicalCommitQcBytes,
					result.exactCanonicalTrustStateRecordBytes,
				]) {
					expect(bytes).toBeInstanceOf(Uint8Array);
					expect(bytes.byteLength).toBeGreaterThan(0);
				}
				expect(await verifyCreatorActorQc(harness, result.exactCanonicalPrepareQcBytes)).toMatchObject({
					ok: true,
					phase: "prepare",
					valueDigest: result.valueDigest,
				});
				expect(await verifyCreatorActorQc(harness, result.exactCanonicalCommitQcBytes)).toMatchObject({
					ok: true,
					phase: "commit",
					valueDigest: result.valueDigest,
				});
				expect(harness.events.map(({ kind }) => kind)).toEqual([
					"close_evidence_committed",
					"prepare_vote_committed",
					"prepare_qc_committed",
					"commit_vote_committed",
					"commit_qc_committed",
					"successor_completed",
				]);
				expect(harness.actor.status()).toMatchObject({ evidenceRevision: 4, phase: "finalized", terminal: false });
				const raw = await rawDatabase(databaseName);
				expect(raw.version).toBe(3);
				expect(raw.schema).toEqual(EXPECTED_SCHEMA_V3.stores);
				expect(raw.counts).toMatchObject({ sealEvidence: 1, signerState: 1, voteOutbox: 2, voteSlots: 2 });
				expect(raw.sealEvidence).toHaveLength(1);
			} finally {
				await harness.close();
			}
		}
	);

	it.skipIf(!readiness.ready)("re-verifies complete durable QC bytes before reopening signing authority", async () => {
		const databaseName = `phase5e-actor-corrupt-${crypto.randomUUID()}`;
		openedDatabases.push(databaseName);
		const first = await openCreatorActorHarness(databaseName);
		expect(await first.actor.close({ closeInput: first.closeInput })).toMatchObject({ ok: true });
		await first.close();
		await corruptFinalizedQc(databaseName);
		await expect(openCreatorActorHarness(databaseName)).rejects.toThrow(/DURABLE_QC_INVALID/u);
	});

	it.skipIf(!readiness.ready)(
		"rejects foreign durable evidence and terminalizes an ambiguous commit retry",
		async () => {
			const foreignDatabase = `phase5e-actor-foreign-${crypto.randomUUID()}`;
			openedDatabases.push(foreignDatabase);
			const foreignFirst = await openCreatorActorHarness(foreignDatabase);
			expect(await foreignFirst.actor.close({ closeInput: foreignFirst.closeInput })).toMatchObject({ ok: true });
			await foreignFirst.close();
			await mutateSealEvidence(foreignDatabase, (row) => ({ ...row, signerId: "foreign-finality" }));
			await expect(openCreatorActorHarness(foreignDatabase)).rejects.toThrow(/SIGNER_NOT_AUTHORIZED/u);

			const ambiguousDatabase = `phase5e-actor-ambiguous-${crypto.randomUUID()}`;
			openedDatabases.push(ambiguousDatabase);
			const ambiguousFirst = await openCreatorActorHarness(ambiguousDatabase);
			expect(await ambiguousFirst.actor.close({ closeInput: ambiguousFirst.closeInput })).toMatchObject({ ok: true });
			await ambiguousFirst.close();
			await mutateSealEvidence(ambiguousDatabase, (row) => ({ ...row, phase: "commit-vote-pending" }));
			const ambiguous = await openCreatorActorHarness(ambiguousDatabase);
			try {
				expect(ambiguous.actor.status()).toMatchObject({ terminal: true });
				expect(await ambiguous.actor.close({ closeInput: ambiguous.closeInput })).toEqual({
					ok: false,
					reason: "AMBIGUOUS_OUTCOME",
				});
			} finally {
				await ambiguous.close();
			}
		}
	);

	it.skipIf(!readiness.ready)(
		"reopens exact finalized custody and rejects a conflicting close without rewriting bytes",
		async () => {
			const databaseName = `phase5e-actor-reopen-${crypto.randomUUID()}`;
			openedDatabases.push(databaseName);
			const first = await openCreatorActorHarness(databaseName);
			const completed = await first.actor.close({ closeInput: first.closeInput });
			expect(completed).toMatchObject({ ok: true });
			await first.close();
			const rawBefore = await rawDatabase(databaseName);
			const reopened = await openCreatorActorHarness(databaseName);
			try {
				expect(reopened.actor.status()).toMatchObject({ phase: "finalized", terminal: false });
				const duplicate = await reopened.actor.close({ closeInput: reopened.closeInput });
				expect(duplicate).toMatchObject({ duplicate: true, ok: true });
				if (duplicate.ok) {
					expect(await verifyCreatorActorQc(reopened, duplicate.exactCanonicalPrepareQcBytes)).toMatchObject({
						ok: true,
						phase: "prepare",
						valueDigest: duplicate.valueDigest,
					});
					expect(await verifyCreatorActorQc(reopened, duplicate.exactCanonicalCommitQcBytes)).toMatchObject({
						ok: true,
						phase: "commit",
						valueDigest: duplicate.valueDigest,
					});
				}
				const conflicting = {
					...reopened.closeInput,
					closeSetRoot: "f".repeat(64),
				};
				expect(await reopened.actor.close({ closeInput: conflicting })).toEqual({
					ok: false,
					reason: "CLOSE_CONFLICT",
				});
				expect(await rawDatabase(databaseName)).toEqual(rawBefore);
			} finally {
				await reopened.close();
			}
		}
	);

	it.skipIf(!readiness.ready)("rejects raw-digest signing and a copied actor capability causally", async () => {
		const driver = await import("./fixtures/phase-5e-v3/creator-actor-driver.js");
		await expect(driver.attemptRawDigestSign()).rejects.toThrow(/untrusted|registered|request/iu);

		const databaseName = `phase5e-actor-copy-${crypto.randomUUID()}`;
		openedDatabases.push(databaseName);
		const harness = await openCreatorActorHarness(databaseName);
		try {
			const copied = { ...harness.actor };
			expect(await copied.close({ closeInput: harness.closeInput })).toEqual({
				ok: false,
				reason: "UNTRUSTED_CREATOR_ACTOR",
			});
		} finally {
			await harness.close();
		}
	});

	it.skipIf(!readiness.ready)(
		"copies all close carriers before awaiting storage and fences effects after stop",
		async () => {
			const databaseName = `phase5e-actor-custody-${crypto.randomUUID()}`;
			openedDatabases.push(databaseName);
			const harness = await openCreatorActorHarness(databaseName);
			const manifest = harness.closeInput.exactCanonicalSnapshotManifestBytes as Uint8Array;
			const original = Uint8Array.from(manifest);
			const pending = harness.actor.close({ closeInput: harness.closeInput });
			manifest.fill(0xff);
			const result = await pending;
			expect(result).toMatchObject({ ok: true });
			expect(original).not.toEqual(manifest);
			await harness.actor.stop();
			const before = { events: structuredClone(harness.events), status: harness.actor.status() };
			expect(await harness.actor.close({ closeInput: harness.closeInput })).toEqual({ ok: false, reason: "STOPPED" });
			await Promise.resolve();
			expect(harness.events).toEqual(before.events);
			expect(harness.actor.status()).toEqual(before.status);
			await harness.close();
		}
	);
});
