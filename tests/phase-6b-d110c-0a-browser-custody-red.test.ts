import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { independentQc } from "./fixtures/phase-5e-v3/creator-close-contract.js";
import { bytesForRef, openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { consumeSealSigningRequest } from "../packages/protocol-v3/src/internal/seal-signing-request.js";
import { openSealAuthority, prepareSealVote, verifySealQC } from "../packages/protocol-v3/src/seal.js";
import {
	PHASE_5C_VOTE_OUTBOX_STORE,
	PHASE_5E_SEAL_EVIDENCE_STORE,
} from "../packages/storage-browser/src/internal/schema-idb.js";
import type { PeerSealEvidence } from "../packages/storage-browser/src/internal/seal-evidence-store.js";
import { openInternalSealVoteStore } from "../packages/storage-browser/src/internal/seal-vote-store.js";
import { openBrowserSealEvidenceStore } from "../packages/storage-browser/src/seal-evidence.js";

interface ExactCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

let fixture: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>;

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		value.addEventListener("success", () => resolvePromise(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error ?? new Error("D110C_IDB_REQUEST_FAILED")), {
			once: true,
		});
	});
}

function completed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		transaction.addEventListener("complete", () => resolvePromise(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("D110C_IDB_ABORTED")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("D110C_IDB_FAILED")), {
			once: true,
		});
	});
}

async function withDatabase<T>(databaseName: string, operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
	const database = await request(indexedDB.open(databaseName));
	try {
		return await operation(database);
	} finally {
		database.close();
	}
}

async function putRaw(databaseName: string, storeName: string, row: unknown): Promise<void> {
	await withDatabase(databaseName, async (database) => {
		const transaction = database.transaction(storeName, "readwrite");
		await request(transaction.objectStore(storeName).put(row));
		await completed(transaction);
	});
}

async function readRaw(databaseName: string, storeName: string, key: IDBValidKey): Promise<unknown> {
	return withDatabase(databaseName, async (database) => {
		const transaction = database.transaction(storeName, "readonly");
		const row = await request(transaction.objectStore(storeName).get(key));
		await completed(transaction);
		return row;
	});
}

function deleteDatabase(databaseName: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const deletion = indexedDB.deleteDatabase(databaseName);
		deletion.addEventListener("success", () => resolvePromise(), { once: true });
		deletion.addEventListener("error", () => reject(deletion.error ?? new Error("D110C_IDB_DELETE_FAILED")), {
			once: true,
		});
	});
}

function signedCarrier(exactCanonicalPreimageBytes: Uint8Array): ExactCarrier {
	return Object.freeze({
		exactCanonicalPreimageBytes: Uint8Array.from(exactCanonicalPreimageBytes),
		signature: ed25519.sign(
			hashDomain("ts-drp/seal-vote/v3", exactCanonicalPreimageBytes),
			hexBytes(contract.privateKeySeedHex)
		),
	});
}

function peerEvidence(
	carrier: ExactCarrier,
	exactCanonicalCutValueBytes: Uint8Array,
	exactCanonicalTrustStateRecordBytes: Uint8Array,
	signerPublicKey: Uint8Array
): PeerSealEvidence {
	return Object.freeze({
		carrier,
		exactCanonicalCommitQcBytes: independentQc(carrier).exactCanonicalQcBytes,
		exactCanonicalCutValueBytes: Uint8Array.from(exactCanonicalCutValueBytes),
		exactCanonicalTrustStateRecordBytes: Uint8Array.from(exactCanonicalTrustStateRecordBytes),
		kind: "drp-creator-seal-evidence" as const,
		signerPublicKey: Uint8Array.from(signerPublicKey),
	});
}

async function captured(promise: Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
	try {
		return Object.freeze({ status: "fulfilled", value: await promise });
	} catch (error) {
		return Object.freeze({
			message: error instanceof Error ? error.message : String(error),
			name: error instanceof Error ? error.name : typeof error,
			status: "rejected",
		});
	}
}

beforeAll(async () => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	fixture = await openGenuineCreatorAdoptionFixture();
});

afterAll(async () => fixture?.close());

describe("D.110c-0a browser epoch-custody causal RED", () => {
	it("uses schema-v3 epoch keys while refusing or misselecting the epoch-one diagnostic carriers", async () => {
		const evidenceDatabase = `d110c-evidence-${crypto.randomUUID()}`;
		const voteDatabase = `d110c-vote-${crypto.randomUUID()}`;
		const { closeResult, currentTrust, proposed } = fixture.evidence;
		const exactCanonicalCutValueBytes = bytesForRef(proposed, closeResult.cutValueRef);
		const exactCanonicalTrustStateRecordBytes = bytesForRef(proposed, closeResult.successorTrustRef);
		const cut = decodeCanonical(exactCanonicalCutValueBytes) as Readonly<Record<string, unknown>>;
		const trustRecord = decodeCanonical(exactCanonicalTrustStateRecordBytes) as Readonly<Record<string, unknown>>;
		const objectId = String(cut.objectId);
		const successorAnchor = String(trustRecord.currentAnchorDigest);
		const signerPublicKey = ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex));
		const authority = openSealAuthority({ signerPublicKey, trust: currentTrust });
		expect(authority, "D110C_0A_BROWSER_EPOCH_ZERO_AUTHORITY").toMatchObject({ ok: true });
		if (!authority.ok) return;

		const prepared = prepareSealVote({
			authority: authority.authority,
			exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 0,
		});
		expect(prepared, "D110C_0A_BROWSER_EPOCH_ZERO_VOTE").toMatchObject({ ok: true });
		if (!prepared.ok) return;
		const prepareDigest = consumeSealSigningRequest(prepared.signingRequest);
		expect(prepareDigest, "D110C_0A_BROWSER_PREPARE_SIGNING_REQUEST").toBeDefined();
		if (prepareDigest === undefined) return;
		const prepareCarrier = Object.freeze({
			exactCanonicalPreimageBytes: prepared.exactCanonicalPreimageBytes,
			signature: ed25519.sign(prepareDigest, hexBytes(contract.privateKeySeedHex)),
		});
		expect(
			verifySealQC({
				authority: authority.authority,
				exactCanonicalQcBytes: independentQc(prepareCarrier).exactCanonicalQcBytes,
			}),
			"D110C_0A_BROWSER_PREPARE_QC"
		).toMatchObject({ ok: true, phase: "prepare" });
		const committed = prepareSealVote({
			authority: authority.authority,
			exactCanonicalCutValueBytes,
			phase: "commit",
			round: 0,
		});
		expect(committed, "D110C_0A_BROWSER_EPOCH_ZERO_COMMIT_VOTE").toMatchObject({ ok: true });
		if (!committed.ok) return;
		const registeredDigest = consumeSealSigningRequest(committed.signingRequest);
		expect(registeredDigest, "D110C_0A_BROWSER_COMMIT_SIGNING_REQUEST").toBeDefined();
		if (registeredDigest === undefined) return;
		const epochZeroCarrier = Object.freeze({
			exactCanonicalPreimageBytes: committed.exactCanonicalPreimageBytes,
			signature: ed25519.sign(registeredDigest, hexBytes(contract.privateKeySeedHex)),
		});
		const epochZeroEvidence = peerEvidence(
			epochZeroCarrier,
			exactCanonicalCutValueBytes,
			exactCanonicalTrustStateRecordBytes,
			signerPublicKey
		);

		const epochOneCutBytes = encodeCanonical({ ...cut, epoch: 1, previousAnchor: successorAnchor });
		const valueDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", epochOneCutBytes)).toString("hex");
		const epochOneVoteBytes = encodeCanonical({
			epoch: 1,
			kind: "drp-seal-vote",
			objectId,
			phase: "prepare",
			proposalDigest: valueDigest,
			proposalHash: "c".repeat(64),
			round: 0,
			signerId: authority.signerId,
		});
		const epochOneCarrier = signedCarrier(epochOneVoteBytes);
		const epochOneEvidence = peerEvidence(
			epochOneCarrier,
			epochOneCutBytes,
			exactCanonicalTrustStateRecordBytes,
			signerPublicKey
		);

		const evidence = await openBrowserSealEvidenceStore({ databaseName: evidenceDatabase });
		const vote = await openInternalSealVoteStore({ databaseName: voteDatabase });
		try {
			expect(await evidence.persistPeerEvidence({ evidence: epochZeroEvidence })).toEqual({
				duplicate: false,
				ok: true,
			});
			await putRaw(evidenceDatabase, PHASE_5E_SEAL_EVIDENCE_STORE, {
				epoch: 1,
				objectId,
				peerEvidence: epochOneEvidence,
				signerId: authority.signerId,
			});
			expect(
				await readRaw(evidenceDatabase, PHASE_5E_SEAL_EVIDENCE_STORE, [objectId, 1, authority.signerId]),
				"D110C_0A_SCHEMA_EPOCH_ONE_EVIDENCE_CONTROL"
			).toBeDefined();

			const selector = evidence.servePeerEvidence as unknown as (
				input: Readonly<Record<string, unknown>>
			) => Promise<PeerSealEvidence | null>;
			const explicit = await selector({ epoch: 1, objectId, signerId: authority.signerId });
			const legacy = await selector({ objectId, signerId: authority.signerId });
			const explicitEpoch =
				explicit === null
					? null
					: (decodeCanonical(explicit.carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>).epoch;
			const legacyEpoch =
				legacy === null
					? null
					: (decodeCanonical(legacy.carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>).epoch;

			const epochOnePersist = await evidence.persistPeerEvidence({ evidence: epochOneEvidence });
			const epochOneVote = await vote.commitVote({
				anchor: successorAnchor,
				carrier: epochOneCarrier,
				expectedIncarnation: vote.incarnation,
				expectedRevision: 0,
				objectId,
				phase: "prepare",
				prepareQC: null,
				round: 0,
				signerId: authority.signerId,
				valueDigest,
			});
			await putRaw(voteDatabase, PHASE_5C_VOTE_OUTBOX_STORE, {
				carrier: epochOneCarrier,
				dispatched: false,
				epoch: 1,
				objectId,
				phase: "prepare",
				round: 0,
				signerId: authority.signerId,
			});
			const pending = await vote.readPending();
			const invalidEpoch = await captured(selector({ epoch: -1, objectId, signerId: authority.signerId }));
			const extraKey = await captured(selector({ extra: true, objectId, signerId: authority.signerId }));
			const dispatchSource = readFileSync(
				resolve(import.meta.dirname, "../packages/storage-browser/src/internal/seal-vote-dispatch.ts"),
				"utf8"
			);
			const dispatchedCall = dispatchSource.match(/markDispatched\(\[[^\]]+\]\)/u)?.[0];

			expect.soft(epochOnePersist, "D110C_0A_EPOCH_ONE_EVIDENCE_WRITE").toMatchObject({ ok: true });
			expect.soft(epochOneVote, "D110C_0A_EPOCH_ONE_VOTE_WRITE").toMatchObject({ ok: true, writes: 3 });
			expect.soft(pending, "D110C_0A_EPOCH_ONE_PENDING_READ").toHaveLength(1);
			expect.soft(explicitEpoch, "D110C_0A_EXPLICIT_SELECTOR_EPOCH").toBe(1);
			expect.soft(legacyEpoch, "D110C_0A_LEGACY_SELECTOR_EPOCH_ZERO").toBe(0);
			expect.soft(invalidEpoch, "D110C_0A_INVALID_SELECTOR_BEFORE_IO").toEqual({
				message: "peer evidence identity is invalid",
				name: "TypeError",
				status: "rejected",
			});
			expect.soft(extraKey, "D110C_0A_EXTRA_SELECTOR_KEY_BEFORE_IO").toEqual({
				message: "peer evidence identity is invalid",
				name: "TypeError",
				status: "rejected",
			});
			expect.soft(dispatchedCall, "D110C_0A_DISPATCH_USES_ROW_EPOCH").toContain("row.epoch");
		} finally {
			vote.close();
			await evidence.close();
			await Promise.all([deleteDatabase(evidenceDatabase), deleteDatabase(voteDatabase)]);
		}
	});
});
