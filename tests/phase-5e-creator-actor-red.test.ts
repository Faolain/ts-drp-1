import "fake-indexeddb/auto";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { prepareCreatorClose } from "@ts-drp/protocol-v3/creator-close";
import {
	readCreatorCloseSigningFramesForSizing,
	reconstructCreatorFinalizedEvidence,
	verifyCreatorFinalizedEvidence,
} from "@ts-drp/seal/creator";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

it("authenticates retained finalized content without inventing native evidence metadata", async () => {
	const databaseName = `phase5e-retained-finalized-content-${crypto.randomUUID()}`;
	openedDatabases.push(databaseName);
	const harness = await openCreatorActorHarness(databaseName);
	try {
		const result = await harness.actor.close({ closeInput: harness.closeInput });
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("genuine creator close did not finalize");
		const native = await rawDatabase(databaseName);
		expect(native.sealEvidence).toHaveLength(1);
		const row = native.sealEvidence[0] as Parameters<typeof reconstructCreatorFinalizedEvidence>[0] & {
			phase: string;
		};
		expect(row.phase).toBe("finalized");
		const material = {
			trust: harness.closeInput.currentTrust as Parameters<typeof verifyCreatorFinalizedEvidence>[0]["trust"],
			signerId: row.signerId,
			exactCanonicalCutValueBytes: row.exactCanonicalCutValueBytes,
			exactCanonicalPrepareQcBytes: row.exactCanonicalPrepareQcBytes,
			exactCanonicalCommitQcBytes: row.exactCanonicalCommitQcBytes,
			exactCanonicalTrustStateRecordBytes: row.exactCanonicalTrustStateRecordBytes,
		};
		expect(verifyCreatorFinalizedEvidence(material)).toBe(true);
		expect(
			reconstructCreatorFinalizedEvidence({
				...material,
				revision: row.revision,
				storageIncarnation: row.storageIncarnation,
			})
		).toEqual(row);
		expect(
			reconstructCreatorFinalizedEvidence({
				...material,
				revision: 3,
				storageIncarnation: row.storageIncarnation,
			})
		).toBeUndefined();
		expect(verifyCreatorFinalizedEvidence({ ...material, trust: { ...material.trust } })).toBe(false);
		expect(verifyCreatorFinalizedEvidence({ ...material, signerId: `${row.signerId}-foreign` })).toBe(false);
		for (const field of [
			"exactCanonicalCutValueBytes",
			"exactCanonicalPrepareQcBytes",
			"exactCanonicalCommitQcBytes",
			"exactCanonicalTrustStateRecordBytes",
		] as const) {
			expect(verifyCreatorFinalizedEvidence({ ...material, [field]: null } as never)).toBe(false);
			expect(verifyCreatorFinalizedEvidence({ ...material, [field]: new Uint8Array() })).toBe(false);
			const tampered = Uint8Array.from(material[field]);
			const last = tampered.length - 1;
			if (last < 0) throw new Error(`genuine ${field} is empty`);
			tampered[last] = (tampered[last] ?? 0) ^ 1;
			expect(verifyCreatorFinalizedEvidence({ ...material, [field]: tampered })).toBe(false);
		}
		expect(
			verifyCreatorFinalizedEvidence({
				...material,
				exactCanonicalPrepareQcBytes: material.exactCanonicalCommitQcBytes,
			})
		).toBe(false);
		expect(await rawDatabase(databaseName)).toEqual(native);
	} finally {
		await harness.close();
	}
});

it("sizes every original fresh q1 signing and evidence phase without unknown carriers", async () => {
	const frameRows = (raw: Awaited<ReturnType<typeof rawDatabase>>): readonly Uint8Array[] =>
		Object.entries(raw.rows).flatMap(([store, rows]) =>
			rows.map((value) => {
				const row = value as Record<string, unknown>;
				const key =
					store === "storageMeta"
						? row.key
						: store === "signerState" || store === "sealEvidence"
							? [row.objectId, row.epoch, row.signerId]
							: [row.objectId, row.epoch, row.round, row.phase, row.signerId];
				return encodeCanonical([store, key, row]);
			})
		);
	const seedName = `phase5e-sizing-seed-${crypto.randomUUID()}`;
	openedDatabases.push(seedName);
	const seed = await openCreatorActorHarness(seedName);
	let sizes: Readonly<{ prepare: number; commit: number; trust: number }>;
	try {
		const result = await seed.actor.close({ closeInput: seed.closeInput });
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("genuine sizing seed did not finalize");
		expect(await verifyCreatorActorQc(seed, result.exactCanonicalPrepareQcBytes)).toMatchObject({
			ok: true,
			phase: "prepare",
		});
		expect(await verifyCreatorActorQc(seed, result.exactCanonicalCommitQcBytes)).toMatchObject({
			ok: true,
			phase: "commit",
		});
		sizes = {
			prepare: result.exactCanonicalPrepareQcBytes.byteLength,
			commit: result.exactCanonicalCommitQcBytes.byteLength,
			trust: result.exactCanonicalTrustStateRecordBytes.byteLength,
		};
	} finally {
		await seed.close();
	}
	const seen = new Set<string>();
	for (const [event, phase] of [
		["close_evidence_committed", "evidence-committed"],
		["prepare_vote_committed", "prepare-voted"],
		["prepare_qc_committed", "prepared"],
		["commit_vote_committed", "commit-voted"],
		["commit_qc_committed", "commit-qc-committed"],
		["successor_completed", "finalized"],
	] as const) {
		const name = `phase5e-sizing-${phase}-${crypto.randomUUID()}`;
		openedDatabases.push(name);
		const harness = await openCreatorActorHarness(name);
		try {
			const prepared = prepareCreatorClose(harness.closeInput);
			if (!prepared.ok) throw new Error(`original close preparation failed: ${prepared.reason}`);
			const input = {
				currentTrust: harness.closeInput.currentTrust as never,
				genuinePreparedClose: prepared.close,
				exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
				prepareQcByteLength: sizes.prepare,
				commitQcByteLength: sizes.commit,
				successorTrustByteLength: sizes.trust,
				storageIncarnation: harness.evidenceObservation.incarnation,
				actualRows: frameRows(await rawDatabase(name)),
			};
			const quote = readCreatorCloseSigningFramesForSizing(input);
			expect(quote).toMatchObject({ ok: true });
			if (!quote.ok) throw new Error(`signing quote unavailable: ${quote.reason}`);
			expect(quote.frames).toHaveLength(14);
			expect(readCreatorCloseSigningFramesForSizing({ ...input, genuinePreparedClose: {} })).toMatchObject({
				ok: false,
			});
			const differentClose = prepareCreatorClose({ ...harness.closeInput, closeSetRoot: "f".repeat(64) });
			if (!differentClose.ok) throw new Error(`genuine different close failed: ${differentClose.reason}`);
			expect(
				readCreatorCloseSigningFramesForSizing({ ...input, genuinePreparedClose: differentClose.close })
			).toMatchObject({ ok: false });
			const finalizedWidth = quote.frames.find(
				(width) => width.store === "sealEvidence" && width.phase === "finalized"
			);
			if (finalizedWidth === undefined) throw new Error("finalized signing width missing");
			let trustLengthWidth = 1;
			for (let remainder = sizes.trust; remainder >= 128; remainder = Math.floor(remainder / 128)) trustLengthWidth++;
			const fixedRowWidth = finalizedWidth.canonicalRowByteLength - (1 + trustLengthWidth + sizes.trust);
			// The row itself fits exactly, but its native ARRAY3/store/key wrapper does not.
			expect(
				readCreatorCloseSigningFramesForSizing({
					...input,
					successorTrustByteLength: Number.MAX_SAFE_INTEGER - fixedRowWidth - 9,
				})
			).toMatchObject({ ok: false });
			Reflect.set(globalThis, "__phase5eAbortAfterObservation", event);
			const result = await harness.actor.close({ closeInput: harness.closeInput });
			expect(result).toEqual({ ok: false, reason: "AMBIGUOUS_OUTCOME" });
			expect(harness.events.at(-1)?.kind).toBe(event);
			const raw = await rawDatabase(name);
			for (const store of ["signerState", "voteSlots", "voteOutbox", "sealEvidence"] as const) {
				for (const value of raw.rows[store] ?? []) {
					const row = value as Record<string, unknown>;
					const key =
						store === "signerState" || store === "sealEvidence"
							? [row.objectId, row.epoch, row.signerId]
							: [row.objectId, row.epoch, row.round, row.phase, row.signerId];
					const rowPhase =
						store === "sealEvidence"
							? phase
							: store === "signerState"
								? (
										{ 1: "prepare-voted", 2: "prepared", 3: "commit-voted", 4: "commit-qc-committed" } as Record<
											number,
											string
										>
									)[row.revision as number]
								: row.phase;
					const found = quote.frames.find(
						(width) =>
							width.store === store && width.phase === rowPhase && JSON.stringify(width.key) === JSON.stringify(key)
					);
					expect(found).toBeDefined();
					expect(found?.canonicalRowByteLength).toBe(encodeCanonical(row).byteLength);
					expect(found?.canonicalFrameByteLength).toBe(encodeCanonical([store, key, row]).byteLength);
					seen.add(`${store}:${rowPhase}`);
				}
			}
			expect(readCreatorCloseSigningFramesForSizing({ ...input, actualRows: frameRows(raw) })).toMatchObject({
				ok: false,
			});
		} finally {
			Reflect.deleteProperty(globalThis, "__phase5eAbortAfterObservation");
			await harness.close();
		}
	}
	expect(seen.size).toBe(14);
});

afterEach(async () => {
	await Promise.all(openedDatabases.splice(0).map(async (databaseName) => deleteDatabase(databaseName)));
});

type SigningDependencyRead = import("@ts-drp/seal/creator").CreatorSigningDependencyRead;
type NativeSigningObservation = import("@ts-drp/seal/internal/storage-port").SigningDependencyObservation;
type SigningObservationSource = "vote" | "evidence";
type DependencyActor = CreatorActorHarness["actor"] & {
	acquireRecoveryDependencies(trusts: readonly unknown[]): Promise<SigningDependencyRead>;
};

// Original signed actor/native observations, with only the selected observation
// delivery/check boundary perturbed. No cryptographic verifier is substituted.
async function signingObservationFixture() {
	const voteIntent = await import("../packages/seal/src/internal/seal-vote-intent.js");
	const evidenceIntent = await import("@ts-drp/seal/internal/creator-close-intent");
	const resolveVote = voteIntent.resolveSealStorePort;
	const resolveEvidence = evidenceIntent.resolveCreatorCloseEvidenceStore;
	const counters = {vote: {reads: 0, checks: 0, releases: 0}, evidence: {reads: 0, checks: 0, releases: 0}};
	const state: {alter?: "qc" | "signature" | "state" | "incarnation" | "order"; revoked?: SigningObservationSource;
		failRelease?: SigningObservationSource; delivered: Partial<Record<SigningObservationSource, readonly Uint8Array[]>>} = {delivered: {}};
	const wrap = (source: SigningObservationSource, observation: NativeSigningObservation): NativeSigningObservation => Object.freeze({
		...observation,
		control: source === "evidence" && state.alter === "incarnation"
			? Object.freeze({...observation.control, incarnation: "f".repeat(32)}) : observation.control,
		readExactCanonicalRows() {
			counters[source].reads++;
			const deliver = (rows: readonly Uint8Array[]) => {state.delivered[source] = rows; return rows;};
			const rows = observation.readExactCanonicalRows();
			if (source !== "evidence" || state.alter === undefined || state.alter === "incarnation") return deliver(rows);
			if (state.alter === "order") return deliver(Object.freeze([...rows].reverse()));
			let changed = false;
			return deliver(Object.freeze(rows.map(bytes => {
				const frame = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
				if (changed || frame[0] !== (state.alter === "qc" ? "sealEvidence" : state.alter === "state" ? "signerState" : "voteSlots")) return bytes;
				if (state.alter === "qc") frame[2].exactCanonicalCommitQcBytes = Uint8Array.of(0xff);
				else if (state.alter === "state") frame[2].finalizedValueDigest = "f".repeat(64);
				else {
					const carrier = frame[2].carrier as Record<string, unknown>;
					const signature = (carrier.signature as Uint8Array).slice(); signature[0] = signature[0]! ^ 1;
					frame[2].carrier = {...carrier, signature};
				}
				changed = true;
				return encodeCanonical(frame);
			})));
		},
		async check() {
			// Count original check invocations, not successful completions: after
			// either view refuses, joined cleanup may revoke the other pending check.
			counters[source].checks++; await observation.check();
			if (state.revoked === source) throw new Error(`revoked-${source}`);
		},
		async release() {
			counters[source].releases++; await observation.release();
			if (state.failRelease === source) throw new Error(`release-${source}`);
		},
	});
	const vote = vi.spyOn(voteIntent, "resolveSealStorePort").mockImplementation(value => {
		const original = resolveVote(value);
		if (original?.acquireSigningDependencyObservation === undefined) return original;
		return {...original, acquireSigningDependencyObservation: async input =>
			wrap("vote", await original.acquireSigningDependencyObservation!(input))};
	});
	const evidence = vi.spyOn(evidenceIntent, "resolveCreatorCloseEvidenceStore").mockImplementation(value => {
		const original = resolveEvidence(value);
		if (original?.acquireSigningDependencyObservation === undefined) return original;
		return {...original, acquireSigningDependencyObservation: async input =>
			wrap("evidence", await original.acquireSigningDependencyObservation!(input))};
	});
	const databaseName = `phase5e-signing-image-${crypto.randomUUID()}`;
	openedDatabases.push(databaseName);
	let harness: CreatorActorHarness;
	try {harness = await openCreatorActorHarness(databaseName);}
	catch (error) {vote.mockRestore(); evidence.mockRestore(); throw error;}
	try {expect(await harness.actor.close({closeInput: harness.closeInput})).toMatchObject({ok: true});}
	catch (error) {try {await harness.close();} finally {vote.mockRestore(); evidence.mockRestore();} throw error;}
	const owned = harness;
	return {harness: {...harness, close: async () => {
		try {await owned.close();} finally {vote.mockRestore(); evidence.mockRestore();}
	}}, actor: harness.actor as DependencyActor, state, counters,
		acquire: () => (harness.actor as DependencyActor).acquireRecoveryDependencies([harness.closeInput.currentTrust])};
}

describe("Phase 5e durable creator actor RED", () => {
	it("reuses last exact signing content across fresh acquisitions while retaining native reads, charges and role resolution", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
		const voting = vi.spyOn(protocol, "verifySealVoteCarrier"), qcs = vi.spyOn(protocol, "verifySealQC"),
			opening = vi.spyOn(protocol, "openSealAuthority");
		try {
			const first = await f.acquire(); let expected: readonly Uint8Array[];
			try {expected = first.readExactCanonicalRows(); expect(voting.mock.calls.length).toBeGreaterThan(0);
				expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await first.release();}
			voting.mockClear(); qcs.mockClear(); opening.mockClear();
			const next = await f.acquire();
			try {
				expect(next.readExactCanonicalRows()).toEqual(expected!);
				expect(next.readExactCanonicalRows().map(bytes => (decodeCanonical(bytes) as unknown[])[0])
					.filter(name => name !== "storageMeta")).toHaveLength(12);
				expect(voting).toHaveBeenCalledTimes(0); expect(qcs).toHaveBeenCalledTimes(0);
				expect(opening).toHaveBeenCalledTimes(2); // Fresh role and own-evidence keys; successor content is the reused fact.
				for (const [input] of opening.mock.calls) expect(input.trust).toBe(f.harness.closeInput.currentTrust);
				expect(opening.mock.calls[0]![0].signerPublicKey).toEqual(opening.mock.calls[1]![0].signerPublicKey);
				expect(f.counters.vote.reads).toBe(2); expect(f.counters.evidence.reads).toBe(2);
				const outward = next.readExactCanonicalRows(); outward.forEach(bytes => bytes.fill(0xff));
				expect(next.readExactCanonicalRows()).toEqual(expected!);
				const checks = [f.counters.vote.checks, f.counters.evidence.checks];
				await next.checkWhile(async () => undefined);
				expect(f.counters.vote.checks).toBe(checks[0]! + 2); expect(f.counters.evidence.checks).toBe(checks[1]! + 2);
			} finally {await next.release();}
			expect(f.counters.vote.releases).toBe(2); expect(f.counters.evidence.releases).toBe(2);
		} finally {voting.mockRestore(); qcs.mockRestore(); opening.mockRestore(); await f.harness.close();}
	});
	it("keeps original signing content verification when optional combined context encoding cannot complete", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal"),
			canonical = await import("@ts-drp/canonical");
		const original = canonical.encodeCanonical, qcs = vi.spyOn(protocol, "verifySealQC");
		let failedKeys = 0;
		const encoding = vi.spyOn(canonical, "encodeCanonical").mockImplementation((value, limits) => {
			if (value !== null && typeof value === "object" && Object.hasOwn(value, "current") &&
				Object.hasOwn(value, "materials") && Object.hasOwn(value, "storageIncarnation")) {
				failedKeys++; throw Error("optional combined context limit");
			}
			return original(value, limits);
		});
		try {
			const first = await f.acquire(); let expected: readonly Uint8Array[];
			try {expected = first.readExactCanonicalRows(); expect(qcs.mock.calls.length).toBeGreaterThan(0);}
			finally {await first.release();}
			qcs.mockClear(); const next = await f.acquire();
			try {expect(next.readExactCanonicalRows()).toEqual(expected!); expect(qcs.mock.calls.length).toBeGreaterThan(0);}
			finally {await next.release();}
			expect(failedKeys).toBe(2);
		} finally {encoding.mockRestore(); qcs.mockRestore(); await f.harness.close();}
	});
	it("captures owned signing bytes before verifier callouts and never enrolls a mutated post-verification witness", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
		const originalVote = protocol.verifySealVoteCarrier;
		let mutations = 0;
		const voting = vi.spyOn(protocol, "verifySealVoteCarrier").mockImplementation(input => {
			const result = originalVote(input);
			for (const rows of Object.values(f.state.delivered)) for (const raw of rows) raw.fill(0xff);
			mutations++; return result;
		});
		try {
			const first = await f.acquire(); let expected: readonly Uint8Array[];
			try {expected = first.readExactCanonicalRows(); expect(mutations).toBeGreaterThan(0);
				expect(expected.every(bytes => Array.isArray(decodeCanonical(bytes)))).toBe(true);} finally {await first.release();}
			voting.mockClear(); const second = await f.acquire();
			try {expect(second.readExactCanonicalRows()).toEqual(expected!); expect(voting).toHaveBeenCalledTimes(0);}
			finally {await second.release();}
		} finally {voting.mockRestore(); await f.harness.close();}
	});
	it.each(["qc", "signature", "state", "incarnation"] as const)(
		"does not reuse previously successful signing content for changed native %s and fully verifies exact restoration", async alter => {
			const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
			const qcs = vi.spyOn(protocol, "verifySealQC");
			try {
				const first = await f.acquire(); await first.release(); qcs.mockClear();
				const warm = await f.acquire(); await warm.release(); expect(qcs).toHaveBeenCalledTimes(0);
				f.state.alter = alter;
				await expect(f.acquire()).rejects.toThrow(/DURABLE_(QC|CARRIER|EVIDENCE)_INVALID/u);
				Reflect.deleteProperty(f.state, "alter"); qcs.mockClear();
				const restored = await f.acquire();
				try {expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await restored.release();}
				expect(f.counters.vote.reads).toBe(4); expect(f.counters.evidence.reads).toBe(4);
				expect(f.counters.vote.releases).toBe(4); expect(f.counters.evidence.releases).toBe(4);
			} finally {qcs.mockRestore(); await f.harness.close();}
		}
	);
	it("verifies a reordered full signing image rather than matching unordered row identities", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
		const voting = vi.spyOn(protocol, "verifySealVoteCarrier");
		try {
			const first = await f.acquire(); await first.release(); voting.mockClear();
			f.state.alter = "order"; const changed = await f.acquire();
			try {expect(voting).toHaveBeenCalledTimes(4); expect(changed.readExactCanonicalRows()).toHaveLength(f.state.delivered.vote!.length * 2);}
			finally {await changed.release();}
		} finally {voting.mockRestore(); await f.harness.close();}
	});
	it.each(["vote", "evidence"] as const)("revokes cached-content admission on a fresh %s native check and verifies again after recovery", async source => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
		const qcs = vi.spyOn(protocol, "verifySealQC");
		try {
			const first = await f.acquire(); await first.release(); qcs.mockClear(); f.state.revoked = source;
			await expect(f.acquire()).rejects.toThrow(`revoked-${source}`); expect(qcs).toHaveBeenCalledTimes(0);
			Reflect.deleteProperty(f.state, "revoked"); const recovered = await f.acquire();
			try {expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await recovered.release();}
			qcs.mockClear(); const warm = await f.acquire();
			try {expect(qcs).toHaveBeenCalledTimes(0); f.state.revoked = source;
				await expect(warm.checkWhile(async () => undefined)).rejects.toThrow(`revoked-${source}`);
			} finally {await warm.release(); Reflect.deleteProperty(f.state, "revoked");}
			qcs.mockClear(); const restored = await f.acquire();
			try {expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await restored.release();}
		} finally {qcs.mockRestore(); await f.harness.close();}
	});
	it("drops pure signing facts after joined cleanup failure without carrying failed custody into a new acquisition", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal");
		const qcs = vi.spyOn(protocol, "verifySealQC");
		try {
			const first = await f.acquire(); await first.release(); qcs.mockClear();
			const warm = await f.acquire(); expect(qcs).toHaveBeenCalledTimes(0); f.state.failRelease = "evidence";
			await expect(warm.release()).rejects.toThrow("release failed");
			Reflect.deleteProperty(f.state, "failRelease"); qcs.mockClear();
			const restored = await f.acquire();
			try {expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await restored.release();}
		} finally {qcs.mockRestore(); await f.harness.close();}
	});
	it("copied or foreign nominal trust invalidates reusable content instead of becoming portable authority", async () => {
		const f = await signingObservationFixture(), protocol = await import("@ts-drp/protocol-v3/seal"),
			anchors = await import("@ts-drp/protocol-v3"), fixture = await import("./fixtures/phase-3a0-v3/controlled-anchor-trust.js");
		const qcs = vi.spyOn(protocol, "verifySealQC");
		try {
			const first = await f.acquire(); await first.release();
			await expect(f.actor.acquireRecoveryDependencies([{...f.harness.closeInput.currentTrust as object}])).rejects.toThrow("authority");
			qcs.mockClear(); const restored = await f.acquire(); await restored.release(); expect(qcs.mock.calls.length).toBeGreaterThan(0);
			const material = fixture.makeCreatorMaterial({objectId: `creator:${"f".repeat(32)}`}),
				foreign = anchors.openCurrentAnchorTrust({exactCanonicalTrustStateRecordBytes: fixture.makeTrustStateRecord(material),
					expectedObjectId: String(material.anchor.objectId), pinnedGenesisAnchorDigest: material.anchorDigest});
			if (!foreign.ok) throw Error(`foreign genuine trust fixture refused: ${foreign.reason}`);
			await expect(f.actor.acquireRecoveryDependencies([f.harness.closeInput.currentTrust, foreign.trust])).rejects.toThrow("foreign");
			qcs.mockClear(); const recovered = await f.acquire();
			try {expect(qcs.mock.calls.length).toBeGreaterThan(0);} finally {await recovered.release();}
		} finally {qcs.mockRestore(); await f.harness.close();}
	});
	it("reuses exact signer authority only within one native dependency acquisition", async () => {
		const databaseName = `phase5e-signing-authority-reuse-${crypto.randomUUID()}`;
		openedDatabases.push(databaseName);
		const harness = await openCreatorActorHarness(databaseName);
		const protocol = await import("@ts-drp/protocol-v3/seal");
		const actor = harness.actor as typeof harness.actor & {
			acquireRecoveryDependencies(trusts: readonly unknown[]): Promise<{
				readExactCanonicalRows(): readonly Uint8Array[];
				checkWhile(read: () => Promise<void>): Promise<void>;
				release(): Promise<void>;
			}>;
		};
		try {
			expect(await actor.close({closeInput: harness.closeInput})).toMatchObject({ok: true});
			const trust = harness.closeInput.currentTrust;
			const opening = vi.spyOn(protocol, "openSealAuthority");
			const voting = vi.spyOn(protocol, "verifySealVoteCarrier");
			try {
				const read = await actor.acquireRecoveryDependencies([trust]);
				let previousAuthorities: unknown[] = [];
				try {
					const rows = read.readExactCanonicalRows();
					expect(rows.map(bytes => (decodeCanonical(bytes) as unknown[])[0]).filter(name => name !== "storageMeta"))
						.toHaveLength(12);
					// Both original observations and every row remain. Only the second
					// byte-exact whole image reuses completed content verification;
					// signer context, evidence key and successor are verified once.
					expect(opening).toHaveBeenCalledTimes(3);
					expect(voting).toHaveBeenCalledTimes(4);
					previousAuthorities = opening.mock.results.map(result => result.type === "return" && result.value.ok ? result.value.authority : undefined);
					const pristine = rows.map(bytes => bytes.slice());
					for (const bytes of rows) bytes.fill(0xff);
					expect(read.readExactCanonicalRows()).toEqual(pristine);
					await read.checkWhile(async () => undefined);
				} finally {await read.release();}
				await expect(actor.acquireRecoveryDependencies([{...trust as object}])).rejects.toThrow("authority");
				opening.mockClear(); voting.mockClear();
				const next = await actor.acquireRecoveryDependencies([trust]);
				try {
					expect(opening).toHaveBeenCalledTimes(3);
					expect(voting).toHaveBeenCalledTimes(4);
					for (const result of opening.mock.results) {
						expect(result.type === "return" && result.value.ok).toBe(true);
						if (result.type === "return" && result.value.ok)
							expect(previousAuthorities).not.toContain(result.value.authority);
					}
				} finally {await next.release();}
				// A new acquisition still rereads and verifies the actual storage,
				// even after a prior exact context authenticated successfully.
				await corruptFinalizedQc(databaseName);
				await expect(actor.acquireRecoveryDependencies([trust])).rejects.toThrow(/QC/u);
			} finally {opening.mockRestore(); voting.mockRestore();}
		} finally {await harness.close();}
	});
	it.each(["qc", "signature", "state", "incarnation"] as const)(
		"does not reuse a different second signing image: %s", async alter => {
			const fixture = await signingObservationFixture();
			try {
				fixture.state.alter = alter;
				await expect(fixture.acquire()).rejects.toThrow(/DURABLE_(QC|CARRIER|EVIDENCE)_INVALID/u);
				expect(fixture.counters.vote.reads).toBe(1);
				expect(fixture.counters.evidence.reads).toBe(1);
				expect(fixture.counters.vote.releases).toBe(1);
				expect(fixture.counters.evidence.releases).toBe(1);
			} finally {await fixture.harness.close();}
		}
	);
	it("verifies both nonidentical ordered signing images instead of deduplicating rows", async () => {
		const fixture = await signingObservationFixture();
		const protocol = await import("@ts-drp/protocol-v3/seal");
		const voting = vi.spyOn(protocol, "verifySealVoteCarrier");
		try {
			fixture.state.alter = "order";
			const read = await fixture.acquire();
			try {
				expect(voting).toHaveBeenCalledTimes(8);
				expect(read.readExactCanonicalRows().map(bytes => (decodeCanonical(bytes) as unknown[])[0])
					.filter(name => name !== "storageMeta")).toHaveLength(12);
			} finally {await read.release();}
		} finally {voting.mockRestore(); await fixture.harness.close();}
	});
	it.each(["vote", "evidence"] as const)("still checks the original %s view after identical-image verification", async source => {
		const fixture = await signingObservationFixture();
		try {
			const read = await fixture.acquire();
			try {
				fixture.state.revoked = source;
				await expect(read.checkWhile(async () => undefined)).rejects.toThrow(`revoked-${source}`);
			} finally {await read.release();}
			expect(fixture.counters.vote.checks).toBeGreaterThanOrEqual(2);
			expect(fixture.counters.evidence.checks).toBeGreaterThanOrEqual(2);
			expect(fixture.counters.vote.releases).toBe(1);
			expect(fixture.counters.evidence.releases).toBe(1);
		} finally {await fixture.harness.close();}
	});
	it("joins admitted consumption before releasing either identical signing view", async () => {
		const fixture = await signingObservationFixture();
		try {
			const read = await fixture.acquire();
			let enter!: () => void, resume!: () => void;
			const entered = new Promise<void>(resolve => {enter = resolve;});
			const barrier = new Promise<void>(resolve => {resume = resolve;});
			const admitted = read.checkWhile(async () => {enter(); await barrier;});
			await entered;
			const joined = read.release();
			try {
				expect(fixture.counters.vote.releases).toBe(0);
				expect(fixture.counters.evidence.releases).toBe(0);
				expect(() => read.readExactCanonicalRows()).toThrow("unavailable");
				await expect(read.checkWhile(async () => undefined)).rejects.toThrow("unavailable");
			} finally {resume(); await admitted; await joined;}
			expect(fixture.counters.vote.releases).toBe(1);
			expect(fixture.counters.evidence.releases).toBe(1);
		} finally {await fixture.harness.close();}
	});
	it("freezes the exact six RED and exact twenty-four GREEN owner rosters", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(6);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(24);
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
				version: PHASE_5C_SCHEMA_AUTHORITY.version,
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
			finality: [
				"createRecoverableFinalitySigner",
				"signCreatorAnchorRequest",
				"signCreatorIssuanceRetirementRequest",
				"signSealRegisteredDigest",
			],
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
		const commitDatabase = `phase5e-actor-corrupt-commit-${crypto.randomUUID()}`;
		openedDatabases.push(commitDatabase);
		const commitFirst = await openCreatorActorHarness(commitDatabase);
		expect(await commitFirst.actor.close({ closeInput: commitFirst.closeInput })).toMatchObject({ ok: true });
		await commitFirst.close();
		await corruptFinalizedQc(commitDatabase);
		await expect(openCreatorActorHarness(commitDatabase)).rejects.toThrow(/DURABLE_QC_INVALID/u);

		const prepareDatabase = `phase5e-actor-corrupt-prepare-${crypto.randomUUID()}`;
		openedDatabases.push(prepareDatabase);
		const prepareFirst = await openCreatorActorHarness(prepareDatabase);
		expect(await prepareFirst.actor.close({ closeInput: prepareFirst.closeInput })).toMatchObject({ ok: true });
		await prepareFirst.close();
		await mutateSealEvidence(prepareDatabase, (row) => ({
			...row,
			exactCanonicalPrepareQcBytes: Uint8Array.of(0xff),
		}));
		await expect(openCreatorActorHarness(prepareDatabase)).rejects.toThrow(/DURABLE_QC_INVALID/u);
	});

	it.skipIf(!readiness.ready)(
		"ignores foreign-scope durable evidence and terminalizes an ambiguous current-scope retry",
		async () => {
			const foreignDatabase = `phase5e-actor-foreign-${crypto.randomUUID()}`;
			openedDatabases.push(foreignDatabase);
			const foreignFirst = await openCreatorActorHarness(foreignDatabase);
			expect(await foreignFirst.actor.close({ closeInput: foreignFirst.closeInput })).toMatchObject({ ok: true });
			await foreignFirst.close();
			await mutateSealEvidence(foreignDatabase, (row) => ({ ...row, signerId: "foreign-finality" }));
			const foreignIgnored = await openCreatorActorHarness(foreignDatabase);
			try {
				expect(foreignIgnored.actor.status()).toMatchObject({ phase: "empty", terminal: false });
				expect(await foreignIgnored.actor.close({ closeInput: foreignIgnored.closeInput })).toMatchObject({ ok: true });
			} finally {
				await foreignIgnored.close();
			}

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
