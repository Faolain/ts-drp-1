/* eslint import/no-unresolved: "off" */
import type { SealAuthority } from "@ts-drp/protocol-v3/seal";

import { type CreatorActorHarness, openCreatorActorHarness } from "./phase-5e-creator-actor-entry.js";
import { openInternalSealEvidenceStore } from "../../src/internal/seal-evidence-store.js";
import { openInternalSealVoteStore } from "../../src/internal/seal-vote-store.js";

export interface ExactSignedSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface ExactCreatorPeerEvidence {
	readonly carrier: ExactSignedSealCarrier;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly kind: "drp-creator-seal-evidence";
	readonly signerPublicKey: Uint8Array;
}

export interface GenuineCreatorPeerEvidenceFixture {
	readonly authority: SealAuthority;
	readonly currentTrust: unknown;
	readonly evidence: ExactCreatorPeerEvidence;
	readonly valueDigest: string;
}

async function readExactEvidence(databaseName: string): Promise<ExactCreatorPeerEvidence> {
	const evidenceStore = await openInternalSealEvidenceStore({ databaseName });
	const voteStore = await openInternalSealVoteStore({ databaseName });
	try {
		const evidenceRows = await evidenceStore.readAll();
		const commit = (await voteStore.readPending()).find(({ phase }) => phase === "commit");
		const evidence = evidenceRows[0];
		if (
			evidenceRows.length !== 1 ||
			evidence === undefined ||
			commit === undefined ||
			evidence.exactCanonicalCommitQcBytes === null ||
			evidence.exactCanonicalTrustStateRecordBytes === null
		) {
			throw new Error("genuine creator evidence is incomplete");
		}
		return Object.freeze({
			carrier: Object.freeze({
				exactCanonicalPreimageBytes: Uint8Array.from(commit.carrier.exactCanonicalPreimageBytes),
				signature: Uint8Array.from(commit.carrier.signature),
			}),
			exactCanonicalCommitQcBytes: Uint8Array.from(evidence.exactCanonicalCommitQcBytes),
			exactCanonicalCutValueBytes: Uint8Array.from(evidence.exactCanonicalCutValueBytes),
			exactCanonicalTrustStateRecordBytes: Uint8Array.from(evidence.exactCanonicalTrustStateRecordBytes),
			kind: "drp-creator-seal-evidence" as const,
			signerPublicKey: Uint8Array.from(evidence.signerPublicKey),
		});
	} finally {
		evidenceStore.close();
		voteStore.close();
	}
}

/**
 * Authors one real finalized q=1 record and reopens its exact durable carriers.
 * @param databaseName - Isolated primary database.
 * @param closeSetRoot - Optional distinct genuine close value for equivocation controls.
 * @returns Genuine authority, trust and peer evidence.
 */
export async function createGenuineCreatorPeerEvidence(
	databaseName: string,
	closeSetRoot?: string
): Promise<GenuineCreatorPeerEvidenceFixture> {
	const harness: CreatorActorHarness = await openCreatorActorHarness(databaseName);
	const closeInput =
		closeSetRoot === undefined ? harness.closeInput : Object.freeze({ ...harness.closeInput, closeSetRoot });
	const currentTrust = harness.closeInput.currentTrust;
	const result = await harness.actor.close({ closeInput });
	const authority = harness.authority;
	await harness.close();
	if (!result.ok) throw new Error(`genuine creator close failed: ${result.reason}`);
	return Object.freeze({
		authority,
		currentTrust,
		evidence: await readExactEvidence(databaseName),
		valueDigest: result.valueDigest,
	});
}

interface CandidateEvidenceStore {
	close(): Promise<void>;
	persistPeerEvidence(input: Readonly<{ evidence: ExactCreatorPeerEvidence }>): Promise<unknown>;
	restorePeerEvidence(input: Readonly<{ evidence: ExactCreatorPeerEvidence }>): Promise<unknown>;
	servePeerEvidence(input: Readonly<{ objectId: string; signerId: string }>): Promise<ExactCreatorPeerEvidence | null>;
}

interface CandidateEvidenceModule {
	openBrowserSealEvidenceStore(input: Readonly<{ databaseName: string }>): Promise<CandidateEvidenceStore>;
}

interface CandidateNetworkModule {
	createSealEvidenceProtocolPort(networkNode: unknown): unknown;
}

interface CandidateNodeModule {
	recoverCreatorSealContinuity(
		input: Readonly<{
			authority: unknown;
			currentTrust: unknown;
			evidenceStore: CandidateEvidenceStore;
			transport: unknown;
		}>
	): Promise<unknown>;
}

const fixtures = new Map<string, GenuineCreatorPeerEvidenceFixture>();

function bytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return Uint8Array.from(value);
	if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
		return Uint8Array.from(value as number[]);
	}
	throw new TypeError("invalid peer-evidence bytes");
}

function evidence(value: unknown): ExactCreatorPeerEvidence {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid peer evidence");
	const row = value as Record<string, unknown>;
	if (row.carrier === null || typeof row.carrier !== "object" || Array.isArray(row.carrier)) {
		throw new TypeError("invalid peer evidence carrier");
	}
	const carrier = row.carrier as Record<string, unknown>;
	return Object.freeze({
		carrier: Object.freeze({
			exactCanonicalPreimageBytes: bytes(carrier.exactCanonicalPreimageBytes),
			signature: bytes(carrier.signature),
		}),
		exactCanonicalCommitQcBytes: bytes(row.exactCanonicalCommitQcBytes),
		exactCanonicalCutValueBytes: bytes(row.exactCanonicalCutValueBytes),
		exactCanonicalTrustStateRecordBytes: bytes(row.exactCanonicalTrustStateRecordBytes),
		kind: "drp-creator-seal-evidence",
		signerPublicKey: bytes(row.signerPublicKey),
	});
}

async function modules(): Promise<readonly [CandidateEvidenceModule, CandidateNetworkModule, CandidateNodeModule]> {
	return (await Promise.all([
		import(/* @vite-ignore */ "@ts-drp/storage-browser/seal-evidence"),
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- literal D.107c future subpath.
		// @ts-ignore -- RED freezes the package contract before GREEN creates it.
		import(/* @vite-ignore */ "@ts-drp/network/seal"),
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- literal D.107c future subpath.
		// @ts-ignore -- RED freezes the package contract before GREEN creates it.
		import(/* @vite-ignore */ "@ts-drp/node/creator-seal"),
	])) as unknown as readonly [CandidateEvidenceModule, CandidateNetworkModule, CandidateNodeModule];
}

async function deleteDatabase(databaseName: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.addEventListener("blocked", () => reject(new Error("database deletion blocked")), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("database deletion failed")), {
			once: true,
		});
		request.addEventListener("success", () => resolvePromise(), { once: true });
	});
}

declare global {
	interface Window {
		phase5eCreatorRelearn: Readonly<{
			createSource(databaseName: string, closeSetRoot?: string): Promise<ExactCreatorPeerEvidence>;
			deleteLocal(databaseName: string): Promise<void>;
			persistPeer(databaseName: string, value: unknown): Promise<unknown>;
			recover(
				authorityDatabase: string,
				recoveryDatabase: string,
				responses: Readonly<Record<string, unknown>>
			): Promise<unknown>;
			servePeer(databaseName: string, objectId: string, signerId: string): Promise<ExactCreatorPeerEvidence | null>;
		}>;
	}
}

if (typeof window !== "undefined") {
	window.phase5eCreatorRelearn = Object.freeze({
		async createSource(databaseName: string, closeSetRoot?: string): Promise<ExactCreatorPeerEvidence> {
			const created = await createGenuineCreatorPeerEvidence(databaseName, closeSetRoot);
			fixtures.set(databaseName, created);
			return structuredClone(created.evidence);
		},
		async deleteLocal(databaseName: string): Promise<void> {
			await deleteDatabase(databaseName);
		},
		async persistPeer(databaseName: string, value: unknown): Promise<unknown> {
			const [browser] = await modules();
			const opened = await browser.openBrowserSealEvidenceStore({ databaseName });
			try {
				return structuredClone(await opened.persistPeerEvidence({ evidence: evidence(value) }));
			} finally {
				await opened.close();
			}
		},
		async recover(
			authorityDatabase: string,
			recoveryDatabase: string,
			responses: Readonly<Record<string, unknown>>
		): Promise<unknown> {
			const fixture = fixtures.get(authorityDatabase);
			if (fixture === undefined) throw new Error("missing genuine recovery authority");
			const [browser, network, node] = await modules();
			const opened = await browser.openBrowserSealEvidenceStore({ databaseName: recoveryDatabase });
			const connected = Object.keys(responses).sort();
			const host = Object.freeze({
				createSealEvidenceProtocolHost: () =>
					Object.freeze({
						close: () => Promise.resolve(),
						connectedPeers: () => Object.freeze([...connected]),
						localPeerId: "creator",
						query: (peerId: string): Promise<unknown> => Promise.resolve(structuredClone(responses[peerId])),
						serve: (): (() => void) => () => undefined,
					}),
			});
			try {
				const result = await node.recoverCreatorSealContinuity({
					authority: fixture.authority,
					currentTrust: fixture.currentTrust,
					evidenceStore: opened,
					transport: network.createSealEvidenceProtocolPort(host),
				});
				return structuredClone(result);
			} finally {
				await opened.close();
			}
		},
		async servePeer(
			databaseName: string,
			objectId: string,
			signerId: string
		): Promise<ExactCreatorPeerEvidence | null> {
			const [browser] = await modules();
			const opened = await browser.openBrowserSealEvidenceStore({ databaseName });
			try {
				const served = await opened.servePeerEvidence({ objectId, signerId });
				return served === null ? null : structuredClone(served);
			} finally {
				await opened.close();
			}
		},
	});
}
