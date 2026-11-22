import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { independentQc } from "./fixtures/phase-5e-v3/creator-close-contract.js";
import { bytesForRef, openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import { openCreatorSuccessorTrust } from "../packages/protocol-v3/src/creator-close.js";
import { consumeSealSigningRequest } from "../packages/protocol-v3/src/internal/seal-signing-request.js";
import { openSealAuthority, prepareSealVote, verifySealQC } from "../packages/protocol-v3/src/seal.js";
import { encodeSnapshotTransfer } from "../packages/protocol-v3/src/snapshot-transfer.js";
import { createCreatorSealActor } from "../packages/seal/src/creator.js";
import { PHASE_5E_SEAL_EVIDENCE_STORE } from "../packages/storage-browser/src/internal/schema-idb.js";
import {
	openInternalSealEvidenceStore,
	type PeerSealEvidence,
} from "../packages/storage-browser/src/internal/seal-evidence-store.js";
import { openInternalSealVoteStore } from "../packages/storage-browser/src/internal/seal-vote-store.js";
import { openBrowserSealEvidenceStore } from "../packages/storage-browser/src/seal-evidence.js";
import { openBrowserSealVoteStore } from "../packages/storage-browser/src/seal-vote.js";

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
		const actorDatabase = `d110c-actor-${crypto.randomUUID()}`;
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

		const successor = openCreatorSuccessorTrust({
			currentTrust,
			exactCanonicalCommitQcBytes: bytesForRef(proposed, closeResult.commitQcRef),
			exactCanonicalCutValueBytes,
			exactCanonicalTrustStateRecordBytes,
		});
		expect(successor, "D110C_0A_BROWSER_GENUINE_SUCCESSOR_TRUST").toMatchObject({ ok: true });
		if (!successor.ok) return;
		const exactCanonicalSuccessorAnchorBytes = trustRecord.exactCanonicalCurrentAnchorPreimageBytes;
		const exactCanonicalSignerSetBytes = trustRecord.exactCanonicalSignerSetBytes;
		if (
			!(exactCanonicalSuccessorAnchorBytes instanceof Uint8Array) ||
			!(exactCanonicalSignerSetBytes instanceof Uint8Array)
		) {
			throw new TypeError("D110C_0A_SUCCESSOR_TRUST_BYTES_MISSING");
		}
		const successorAnchorRecord = decodeCanonical(exactCanonicalSuccessorAnchorBytes) as Readonly<
			Record<string, unknown>
		>;
		const exactCanonicalParametersBytes = encodeCanonical(cut.parameters);
		const snapshot = encodeSnapshotTransfer({
			aclDigest: String(successorAnchorRecord.aclDigest),
			anchor: successorAnchor,
			epoch: 1,
			exactCanonicalPayloadBytes: fixture.evidence.exactCanonicalPayloadBytes,
			objectId,
			profile: {
				maxManifestBytes: 212_387,
				maxSnapshotBytes: 268_435_456,
				snapshotChunkBytes: 131_072,
			},
			schemaVersion: 1,
			stateDigest: String(successorAnchorRecord.stateDigest),
		});
		const closeInput = Object.freeze({
			aclDigest: String(successorAnchorRecord.aclDigest),
			archiveIndexRoot: String(successorAnchorRecord.archiveIndexRoot),
			blueprintDigest: String(successorAnchorRecord.blueprintDigest),
			closeReason: "creator-requested",
			closeSetCount: 1,
			closeSetRoot: "d".repeat(64),
			currentTrust: successor.trust,
			exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
				minLocalCopies: 1,
				minMirrorReceipts: 0,
				minRollbackGenerations: 2,
				mode: "local-only",
			}),
			exactCanonicalNextSignerSetBytes: Uint8Array.from(exactCanonicalSignerSetBytes),
			exactCanonicalParametersBytes,
			exactCanonicalSnapshotManifestBytes: snapshot.exactCanonicalManifestBytes,
			historyRoot: "e".repeat(64),
			historySize: Number(successorAnchorRecord.historySize) + 1,
			snapshotManifestDigest: snapshot.manifestDigest,
			stateDigest: String(successorAnchorRecord.stateDigest),
		});

		let epochOneCarrier: ExactCarrier;
		let epochOneEvidence: PeerSealEvidence;
		let valueDigest: string;
		const actorVote = await openBrowserSealVoteStore({ databaseName: actorDatabase });
		const actorEvidence = await openBrowserSealEvidenceStore({ databaseName: actorDatabase });
		const staleEvidenceWriter = await openInternalSealEvidenceStore({ databaseName: actorDatabase });
		expect(
			await staleEvidenceWriter.put(
				{
					anchor: String(cut.previousAnchor),
					epoch: 0,
					exactCanonicalCommitQcBytes: bytesForRef(proposed, closeResult.commitQcRef),
					exactCanonicalCutValueBytes,
					exactCanonicalPrepareQcBytes: null,
					exactCanonicalTrustStateRecordBytes,
					objectId,
					phase: "finalized",
					revision: 4,
					signerId: authority.signerId,
					signerPublicKey,
					storageIncarnation: actorVote.observation.incarnation,
					valueDigest: committed.valueDigest,
				},
				null
			),
			"D110C_0A_STALE_EPOCH_ZERO_ACTOR_ROW"
		).toMatchObject({ ok: true });
		staleEvidenceWriter.close();
		const finality = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
		const openedActor = await createCreatorSealActor({
			currentTrust: successor.trust,
			evidenceStore: actorEvidence.store,
			onObservation: () => undefined,
			signer: finality.signer,
			storageIncarnation: actorVote.observation.incarnation,
			voteStore: actorVote.store,
		});
		expect(openedActor, "D110C_0A_GENUINE_EPOCH_ONE_ACTOR_OPEN").toMatchObject({ ok: true });
		if (!openedActor.ok) return;
		try {
			const closed = await openedActor.actor.close({ closeInput });
			expect(closed, "D110C_0A_GENUINE_EPOCH_ONE_ACTOR_CLOSE").toMatchObject({ ok: true });
			if (!closed.ok) return;
			valueDigest = closed.valueDigest;
		} finally {
			await openedActor.actor.stop();
			await Promise.all([actorVote.close(), actorEvidence.close()]);
		}
		const resumedVote = await openBrowserSealVoteStore({ databaseName: actorDatabase });
		const resumedEvidence = await openBrowserSealEvidenceStore({ databaseName: actorDatabase });
		const resumedActor = await createCreatorSealActor({
			currentTrust: successor.trust,
			evidenceStore: resumedEvidence.store,
			onObservation: () => undefined,
			signer: finality.signer,
			storageIncarnation: resumedVote.observation.incarnation,
			voteStore: resumedVote.store,
		});
		expect(resumedActor, "D110C_0A_EXACT_EPOCH_ONE_ACTOR_RESUME").toMatchObject({ ok: true });
		if (resumedActor.ok) {
			expect(resumedActor.actor.status().phase, "D110C_0A_EXACT_EPOCH_ONE_ACTOR_PHASE").toBe("finalized");
			await resumedActor.actor.stop();
		}
		await Promise.all([resumedVote.close(), resumedEvidence.close()]);
		const actorEvidenceReader = await openInternalSealEvidenceStore({ databaseName: actorDatabase });
		const actorVoteReader = await openInternalSealVoteStore({ databaseName: actorDatabase });
		try {
			const actorRows = await actorEvidenceReader.readAll();
			const actorPending = await actorVoteReader.readPending();
			const actorRow = actorRows.find(({ epoch }) => epoch === 1);
			const prepareRow = actorPending.find(({ epoch, phase }) => epoch === 1 && phase === "prepare");
			const commitRow = actorPending.find(({ epoch, phase }) => epoch === 1 && phase === "commit");
			expect(
				actorRows.map(({ epoch }) => epoch).sort((left, right) => left - right),
				"D110C_0A_STALE_AND_CURRENT_ACTOR_ROWS"
			).toEqual([0, 1]);
			expect(actorRow?.epoch, "D110C_0A_GENUINE_EPOCH_ONE_EVIDENCE_EPOCH").toBe(1);
			expect(prepareRow, "D110C_0A_GENUINE_EPOCH_ONE_PREPARE_ROW").toBeDefined();
			expect(commitRow, "D110C_0A_GENUINE_EPOCH_ONE_COMMIT_ROW").toBeDefined();
			if (
				actorRow === undefined ||
				prepareRow === undefined ||
				commitRow === undefined ||
				actorRow.exactCanonicalCommitQcBytes === null ||
				actorRow.exactCanonicalTrustStateRecordBytes === null
			) {
				return;
			}
			epochOneCarrier = prepareRow.carrier;
			epochOneEvidence = Object.freeze({
				carrier: commitRow.carrier,
				exactCanonicalCommitQcBytes: actorRow.exactCanonicalCommitQcBytes,
				exactCanonicalCutValueBytes: actorRow.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: actorRow.exactCanonicalTrustStateRecordBytes,
				kind: "drp-creator-seal-evidence" as const,
				signerPublicKey: actorRow.signerPublicKey,
			});
		} finally {
			actorEvidenceReader.close();
			actorVoteReader.close();
		}

		const evidence = await openBrowserSealEvidenceStore({ databaseName: evidenceDatabase });
		const vote = await openInternalSealVoteStore({ databaseName: voteDatabase });
		try {
			expect(await evidence.persistPeerEvidence({ evidence: epochZeroEvidence })).toEqual({
				duplicate: false,
				ok: true,
			});
			const epochOnePersist = await evidence.persistPeerEvidence({ evidence: epochOneEvidence });
			expect(
				await readRaw(evidenceDatabase, PHASE_5E_SEAL_EVIDENCE_STORE, [objectId, 1, authority.signerId]),
				"D110C_0A_SCHEMA_EPOCH_ONE_EVIDENCE_CONTROL"
			).toBeDefined();

			const selector = evidence.servePeerEvidence as unknown as (
				input: Readonly<Record<string, unknown>>
			) => Promise<PeerSealEvidence | null>;
			const explicit = await selector({ epoch: 1, objectId, signerId: authority.signerId });
			const legacy = await selector({ objectId, signerId: authority.signerId });
			const wrongEpoch = await selector({ epoch: 2, objectId, signerId: authority.signerId });
			const wrongObject = await selector({ epoch: 1, objectId: `${objectId}:foreign`, signerId: authority.signerId });
			const wrongSigner = await selector({ epoch: 1, objectId, signerId: `${authority.signerId}:foreign` });
			const explicitEpoch =
				explicit === null
					? null
					: (decodeCanonical(explicit.carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>).epoch;
			const legacyEpoch =
				legacy === null
					? null
					: (decodeCanonical(legacy.carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>).epoch;

			const epochOneVote = await vote.commitVote({
				anchor: successorAnchor,
				carrier: epochOneCarrier,
				epoch: 1,
				expectedIncarnation: vote.incarnation,
				expectedRevision: 0,
				objectId,
				phase: "prepare",
				prepareQC: null,
				round: 0,
				signerId: authority.signerId,
				valueDigest,
			});
			const crossEpochVote = await vote.commitVote({
				anchor: successorAnchor,
				carrier: epochOneCarrier,
				epoch: 0,
				expectedIncarnation: vote.incarnation,
				expectedRevision: 0,
				objectId,
				phase: "prepare",
				prepareQC: null,
				round: 0,
				signerId: authority.signerId,
				valueDigest,
			});
			const pending = await vote.readPending();
			const invalidEpoch = await captured(selector({ epoch: -1, objectId, signerId: authority.signerId }));
			const fractionalEpoch = await captured(selector({ epoch: 1.5, objectId, signerId: authority.signerId }));
			const unsafeEpoch = await captured(
				selector({ epoch: Number.MAX_SAFE_INTEGER + 1, objectId, signerId: authority.signerId })
			);
			const missingSigner = await captured(selector({ epoch: 1, objectId }));
			const extraKey = await captured(selector({ extra: true, objectId, signerId: authority.signerId }));
			const accessorSelector = Object.defineProperty({ objectId, signerId: authority.signerId }, "epoch", {
				enumerable: true,
				get: () => 1,
			});
			const accessorEpoch = await captured(selector(accessorSelector));
			const epochOneDuplicate = await evidence.persistPeerEvidence({ evidence: epochOneEvidence });
			const conflictingSignature = Uint8Array.from(epochOneEvidence.carrier.signature);
			conflictingSignature[0] = (conflictingSignature[0] ?? 0) ^ 0xff;
			const epochOneConflict = await evidence.persistPeerEvidence({
				evidence: Object.freeze({
					...epochOneEvidence,
					carrier: Object.freeze({
						...epochOneEvidence.carrier,
						signature: conflictingSignature,
					}),
				}),
			});
			const dispatchSource = readFileSync(
				resolve(import.meta.dirname, "../packages/storage-browser/src/internal/seal-vote-dispatch.ts"),
				"utf8"
			);
			const dispatchedCall = dispatchSource.match(/markDispatched\(\[[^\]]+\]\)/u)?.[0];

			expect.soft(epochOnePersist, "D110C_0A_EPOCH_ONE_EVIDENCE_WRITE").toMatchObject({ ok: true });
			expect.soft(epochOneDuplicate, "D110C_0A_EPOCH_ONE_EVIDENCE_DUPLICATE").toEqual({
				duplicate: true,
				ok: true,
			});
			expect.soft(epochOneConflict, "D110C_0A_EPOCH_ONE_EVIDENCE_CONFLICT").toEqual({
				ok: false,
				reason: "EVIDENCE_CONFLICT",
			});
			expect.soft(epochOneVote, "D110C_0A_EPOCH_ONE_VOTE_WRITE").toMatchObject({ ok: true, writes: 3 });
			expect.soft(crossEpochVote, "D110C_0A_CROSS_EPOCH_VOTE_REPLAY").toEqual({
				ok: false,
				reason: "MALFORMED_INPUT",
			});
			expect.soft(pending, "D110C_0A_EPOCH_ONE_PENDING_READ").toHaveLength(1);
			expect.soft(explicitEpoch, "D110C_0A_EXPLICIT_SELECTOR_EPOCH").toBe(1);
			expect.soft(legacyEpoch, "D110C_0A_LEGACY_SELECTOR_EPOCH_ZERO").toBe(0);
			expect.soft(wrongEpoch, "D110C_0A_WRONG_EPOCH_SELECTOR").toBeNull();
			expect.soft(wrongObject, "D110C_0A_CROSS_OBJECT_SELECTOR").toBeNull();
			expect.soft(wrongSigner, "D110C_0A_CROSS_SIGNER_SELECTOR").toBeNull();
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
			for (const [token, result] of [
				["D110C_0A_FRACTIONAL_SELECTOR_BEFORE_IO", fractionalEpoch],
				["D110C_0A_UNSAFE_SELECTOR_BEFORE_IO", unsafeEpoch],
				["D110C_0A_MISSING_SELECTOR_BEFORE_IO", missingSigner],
				["D110C_0A_ACCESSOR_SELECTOR_BEFORE_IO", accessorEpoch],
			] as const) {
				expect.soft(result, token).toEqual({
					message: "peer evidence identity is invalid",
					name: "TypeError",
					status: "rejected",
				});
			}
			expect.soft(dispatchedCall, "D110C_0A_DISPATCH_USES_ROW_EPOCH").toContain("row.epoch");
		} finally {
			vote.close();
			await evidence.close();
			await Promise.all([
				deleteDatabase(actorDatabase),
				deleteDatabase(evidenceDatabase),
				deleteDatabase(voteDatabase),
			]);
		}
	});
});
