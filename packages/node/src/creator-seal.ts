import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SealEvidenceProtocolPort } from "@ts-drp/network/seal";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { openSealAuthority, type SealAuthority, verifySealQC } from "@ts-drp/protocol-v3/seal";

const maxEvidenceBytes = 262_144;
const queryTimeoutMs = 10_000;

export interface CreatorPeerSealEvidence {
	readonly carrier: Readonly<{
		readonly exactCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
	}>;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly kind: "drp-creator-seal-evidence";
	readonly signerPublicKey: Uint8Array;
}

export interface CreatorPeerSealEvidenceStore {
	restorePeerEvidence(
		input: Readonly<{ evidence: CreatorPeerSealEvidence }>
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
}

export type CreatorSealRecoveryResult = Readonly<
	| { ok: false; queriedPeers: readonly string[]; reason: "EQUIVOCATION"; status: "equivocation" }
	| {
			ignoredPeers: readonly string[];
			ok: false;
			queriedPeers: readonly string[];
			reason: "MALFORMED_EVIDENCE" | "NO_AUTHENTICATED_EVIDENCE";
			status: "stalled";
	  }
	| {
			evidence: CreatorPeerSealEvidence;
			ignoredPeers: readonly string[];
			ok: true;
			queriedPeers: readonly string[];
			status: "ready";
			valueDigest: string;
	  }
>;

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function exactBytes(value: unknown, expectedLength?: number): Uint8Array | undefined {
	if (
		!(value instanceof Uint8Array) ||
		value.byteOffset !== 0 ||
		value.byteLength !== value.buffer.byteLength ||
		(expectedLength !== undefined && value.byteLength !== expectedLength)
	) {
		return undefined;
	}
	return Uint8Array.from(value);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneEvidence(evidence: CreatorPeerSealEvidence): CreatorPeerSealEvidence {
	return Object.freeze({
		carrier: Object.freeze({
			exactCanonicalPreimageBytes: Uint8Array.from(evidence.carrier.exactCanonicalPreimageBytes),
			signature: Uint8Array.from(evidence.carrier.signature),
		}),
		exactCanonicalCommitQcBytes: Uint8Array.from(evidence.exactCanonicalCommitQcBytes),
		exactCanonicalCutValueBytes: Uint8Array.from(evidence.exactCanonicalCutValueBytes),
		exactCanonicalTrustStateRecordBytes: Uint8Array.from(evidence.exactCanonicalTrustStateRecordBytes),
		kind: "drp-creator-seal-evidence",
		signerPublicKey: Uint8Array.from(evidence.signerPublicKey),
	});
}

function sameEvidence(left: CreatorPeerSealEvidence, right: CreatorPeerSealEvidence): boolean {
	return (
		compareBytes(left.carrier.exactCanonicalPreimageBytes, right.carrier.exactCanonicalPreimageBytes) === 0 &&
		compareBytes(left.carrier.signature, right.carrier.signature) === 0 &&
		compareBytes(left.exactCanonicalCommitQcBytes, right.exactCanonicalCommitQcBytes) === 0 &&
		compareBytes(left.exactCanonicalCutValueBytes, right.exactCanonicalCutValueBytes) === 0 &&
		compareBytes(left.exactCanonicalTrustStateRecordBytes, right.exactCanonicalTrustStateRecordBytes) === 0 &&
		compareBytes(left.signerPublicKey, right.signerPublicKey) === 0
	);
}

function verifiedEvidence(
	authority: SealAuthority,
	currentTrust: unknown,
	value: unknown
): Readonly<{ evidence: CreatorPeerSealEvidence; valueDigest: string }> | undefined {
	try {
		if (!plainRecord(value) || Reflect.ownKeys(value).length !== 6 || value.kind !== "drp-creator-seal-evidence") {
			return undefined;
		}
		if (encodeCanonical(value).byteLength > maxEvidenceBytes) {
			return undefined;
		}
		if (!plainRecord(value.carrier) || Reflect.ownKeys(value.carrier).length !== 2) {
			return undefined;
		}
		const preimage = exactBytes(value.carrier.exactCanonicalPreimageBytes);
		const signature = exactBytes(value.carrier.signature, 64);
		const qc = exactBytes(value.exactCanonicalCommitQcBytes);
		const cutBytes = exactBytes(value.exactCanonicalCutValueBytes);
		const trustBytes = exactBytes(value.exactCanonicalTrustStateRecordBytes);
		const publicKey = exactBytes(value.signerPublicKey, 32);
		if (
			preimage === undefined ||
			signature === undefined ||
			qc === undefined ||
			cutBytes === undefined ||
			trustBytes === undefined ||
			publicKey === undefined
		) {
			return undefined;
		}
		const identity = resolveSealAuthorityIdentity(authority);
		const presentedAuthority = openSealAuthority({ signerPublicKey: publicKey, trust: currentTrust });
		if (identity === undefined || !presentedAuthority.ok) {
			return undefined;
		}
		const verified = verifySealQC({ authority, exactCanonicalQcBytes: qc });
		const presentedVerified = verifySealQC({
			authority: presentedAuthority.authority,
			exactCanonicalQcBytes: qc,
		});
		if (!verified.ok || verified.phase !== "commit" || !presentedVerified.ok) {
			return undefined;
		}
		const vote = decodeCanonical(preimage);
		const decodedQc = decodeCanonical(qc);
		const cut = decodeCanonical(cutBytes);
		if (
			!plainRecord(vote) ||
			!plainRecord(decodedQc) ||
			!plainRecord(cut) ||
			!Array.isArray(decodedQc.votes) ||
			decodedQc.votes.length !== 1 ||
			!plainRecord(decodedQc.votes[0]) ||
			compareBytes(encodeCanonical(vote), preimage) !== 0
		) {
			return undefined;
		}
		const qcVote = decodedQc.votes[0];
		if (
			vote.kind !== "drp-seal-vote" ||
			vote.phase !== "commit" ||
			vote.objectId !== identity.objectId ||
			vote.epoch !== identity.epoch ||
			vote.signerId !== identity.signerId ||
			vote.objectId !== decodedQc.objectId ||
			vote.epoch !== decodedQc.epoch ||
			vote.round !== decodedQc.round ||
			vote.proposalDigest !== decodedQc.proposalDigest ||
			vote.proposalHash !== decodedQc.proposalHash ||
			vote.signerId !== qcVote.signerId ||
			qcVote.signature !== hex(signature) ||
			qcVote.voteDigest !== hex(hashDomain("ts-drp/seal-vote/v3", preimage)) ||
			cut.kind !== "drp-hard-epoch-cut" ||
			cut.objectId !== identity.objectId ||
			cut.epoch !== identity.epoch ||
			cut.previousAnchor !== identity.anchor ||
			hex(hashDomain("ts-drp/hard-epoch-cut/v3", cutBytes)) !== verified.valueDigest ||
			!openCreatorSuccessorTrust({
				currentTrust,
				exactCanonicalCommitQcBytes: qc,
				exactCanonicalCutValueBytes: cutBytes,
				exactCanonicalTrustStateRecordBytes: trustBytes,
			}).ok
		) {
			return undefined;
		}
		return Object.freeze({
			evidence: cloneEvidence(value as unknown as CreatorPeerSealEvidence),
			valueDigest: verified.valueDigest,
		});
	} catch {
		return undefined;
	}
}

/**
 * Queries every currently connected authenticated peer and restores one exact creator-seal carrier.
 * @param input - Genuine authority/trust plus mechanical evidence and connected transport owners.
 * @returns Ready only after complete verification and durable restoration, otherwise stalled or terminal equivocation.
 */
export async function recoverCreatorSealContinuity(
	input: Readonly<{
		readonly authority: SealAuthority;
		readonly currentTrust: unknown;
		readonly evidenceStore: CreatorPeerSealEvidenceStore;
		readonly transport: SealEvidenceProtocolPort;
	}>
): Promise<CreatorSealRecoveryResult> {
	if (!plainRecord(input) || Reflect.ownKeys(input).length !== 4) {
		throw new TypeError("creator seal recovery input is invalid");
	}
	const identity = resolveSealAuthorityIdentity(input.authority);
	if (identity === undefined) throw new TypeError("creator seal recovery authority is invalid");
	const peers = Object.freeze(
		[...new Set(input.transport.connectedPeers())]
			.filter((peerId) => typeof peerId === "string" && peerId.length > 0 && peerId !== input.transport.localPeerId)
			.sort()
	);
	const request = Object.freeze({
		anchor: identity.anchor,
		epoch: identity.epoch,
		kind: "drp-creator-seal-evidence-request",
		objectId: identity.objectId,
	});
	try {
		const settled = await Promise.allSettled(
			peers.map(async (peerId) => {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(new Error("QUERY_TIMEOUT")), queryTimeoutMs);
				try {
					return await Promise.race([
						input.transport.query(peerId, request, { signal: controller.signal }),
						new Promise<never>((_resolve, reject) => {
							controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
						}),
					]);
				} finally {
					clearTimeout(timeout);
				}
			})
		);
		const valid: Readonly<{ evidence: CreatorPeerSealEvidence; valueDigest: string }>[] = [];
		const ignoredPeers: string[] = [];
		for (const [index, result] of settled.entries()) {
			const peerId = peers[index] as string;
			const candidate =
				result.status === "fulfilled" ? verifiedEvidence(input.authority, input.currentTrust, result.value) : undefined;
			if (candidate === undefined) ignoredPeers.push(peerId);
			else valid.push(candidate);
		}
		if (valid.length === 0) {
			return Object.freeze({
				ignoredPeers: Object.freeze(ignoredPeers),
				ok: false as const,
				queriedPeers: peers,
				reason: "NO_AUTHENTICATED_EVIDENCE" as const,
				status: "stalled" as const,
			});
		}
		const selected = valid[0] as (typeof valid)[number];
		if (
			valid.some(
				(candidate) =>
					candidate.valueDigest !== selected.valueDigest || !sameEvidence(candidate.evidence, selected.evidence)
			)
		) {
			return Object.freeze({
				ok: false as const,
				queriedPeers: peers,
				reason: "EQUIVOCATION" as const,
				status: "equivocation" as const,
			});
		}
		const restored = await input.evidenceStore.restorePeerEvidence({ evidence: cloneEvidence(selected.evidence) });
		if (!restored.ok) {
			if (restored.reason === "EVIDENCE_CONFLICT") {
				return Object.freeze({
					ok: false as const,
					queriedPeers: peers,
					reason: "EQUIVOCATION" as const,
					status: "equivocation" as const,
				});
			}
			return Object.freeze({
				ignoredPeers: Object.freeze(ignoredPeers),
				ok: false as const,
				queriedPeers: peers,
				reason: "MALFORMED_EVIDENCE" as const,
				status: "stalled" as const,
			});
		}
		return Object.freeze({
			evidence: cloneEvidence(selected.evidence),
			ignoredPeers: Object.freeze(ignoredPeers),
			ok: true as const,
			queriedPeers: peers,
			status: "ready" as const,
			valueDigest: selected.valueDigest,
		});
	} finally {
		await input.transport.close();
	}
}
