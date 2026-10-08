/* eslint import/no-unresolved: "off" */
import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, hashDomain } from "@ts-drp/canonical";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import { type SealAuthority, verifySealQC } from "@ts-drp/protocol-v3/seal";

import { CREATOR_RELEARN_LIMITS } from "./creator-relearn-contract.js";
import {
	createGenuineCreatorPeerEvidence,
	type ExactCreatorPeerEvidence,
	type GenuineCreatorPeerEvidenceFixture,
} from "../../../packages/storage-browser/tests/assets/phase-5e-creator-relearn-entry.js";

export { createGenuineCreatorPeerEvidence, type ExactCreatorPeerEvidence, type GenuineCreatorPeerEvidenceFixture };

export interface ScriptedEvidencePeer {
	readonly authenticated: boolean;
	readonly peerId: string;
	query(options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
}

export type IndependentRelearnResult = Readonly<
	| { ok: false; queriedPeers: readonly string[]; reason: "EQUIVOCATION"; status: "equivocation" }
	| {
			ignoredPeers: readonly string[];
			ok: false;
			queriedPeers: readonly string[];
			reason: "NO_AUTHENTICATED_EVIDENCE";
			status: "stalled";
	  }
	| {
			evidence: ExactCreatorPeerEvidence;
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

function cloneEvidence(evidence: ExactCreatorPeerEvidence): ExactCreatorPeerEvidence {
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

function sameEvidence(left: ExactCreatorPeerEvidence, right: ExactCreatorPeerEvidence): boolean {
	return (
		compareBytes(left.carrier.exactCanonicalPreimageBytes, right.carrier.exactCanonicalPreimageBytes) === 0 &&
		compareBytes(left.carrier.signature, right.carrier.signature) === 0 &&
		compareBytes(left.exactCanonicalCommitQcBytes, right.exactCanonicalCommitQcBytes) === 0 &&
		compareBytes(left.exactCanonicalCutValueBytes, right.exactCanonicalCutValueBytes) === 0 &&
		compareBytes(left.exactCanonicalTrustStateRecordBytes, right.exactCanonicalTrustStateRecordBytes) === 0 &&
		compareBytes(left.signerPublicKey, right.signerPublicKey) === 0
	);
}

function validateEvidence(
	authority: SealAuthority,
	currentTrust: unknown,
	value: unknown
): Readonly<{ evidence: ExactCreatorPeerEvidence; valueDigest: string }> | undefined {
	if (!plainRecord(value) || Reflect.ownKeys(value).length !== 6 || value.kind !== "drp-creator-seal-evidence") {
		return undefined;
	}
	if (!plainRecord(value.carrier) || Reflect.ownKeys(value.carrier).length !== 2) return undefined;
	const preimage = exactBytes(value.carrier.exactCanonicalPreimageBytes);
	const signature = exactBytes(value.carrier.signature, 64);
	const qc = exactBytes(value.exactCanonicalCommitQcBytes);
	const cut = exactBytes(value.exactCanonicalCutValueBytes);
	const trust = exactBytes(value.exactCanonicalTrustStateRecordBytes);
	const publicKey = exactBytes(value.signerPublicKey, 32);
	if (
		preimage === undefined ||
		signature === undefined ||
		qc === undefined ||
		cut === undefined ||
		trust === undefined ||
		publicKey === undefined
	) {
		return undefined;
	}
	const verified = verifySealQC({ authority, exactCanonicalQcBytes: qc });
	if (!verified.ok || verified.phase !== "commit") return undefined;
	let vote: unknown;
	let decodedQc: unknown;
	try {
		vote = decodeCanonical(preimage);
		decodedQc = decodeCanonical(qc);
	} catch {
		return undefined;
	}
	if (!plainRecord(vote) || !plainRecord(decodedQc) || !Array.isArray(decodedQc.votes)) return undefined;
	const qcVote = decodedQc.votes[0];
	if (
		decodedQc.votes.length !== 1 ||
		!plainRecord(qcVote) ||
		vote.kind !== "drp-seal-vote" ||
		vote.phase !== "commit" ||
		vote.objectId !== decodedQc.objectId ||
		vote.epoch !== decodedQc.epoch ||
		vote.round !== decodedQc.round ||
		vote.proposalDigest !== decodedQc.proposalDigest ||
		vote.proposalHash !== decodedQc.proposalHash ||
		vote.signerId !== qcVote.signerId ||
		qcVote.signature !== hex(signature) ||
		qcVote.voteDigest !== hex(hashDomain("ts-drp/seal-vote/v3", preimage)) ||
		!ed25519.verify(signature, hashDomain("ts-drp/seal-vote/v3", preimage), publicKey, { zip215: false }) ||
		hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut)) !== verified.valueDigest ||
		!openCreatorSuccessorTrust({
			currentTrust,
			exactCanonicalCommitQcBytes: qc,
			exactCanonicalCutValueBytes: cut,
			exactCanonicalTrustStateRecordBytes: trust,
		}).ok
	) {
		return undefined;
	}
	return Object.freeze({
		evidence: cloneEvidence(value as unknown as ExactCreatorPeerEvidence),
		valueDigest: verified.valueDigest,
	});
}

/**
 * Independently executes the all-connected-peer barrier and closed evidence selection law.
 * @param input - Genuine trust plus a snapshot of scripted connected peers.
 * @returns Ready, stalled, or terminal equivocation result.
 */
export async function runIndependentCreatorRelearn(
	input: Readonly<{
		authority: SealAuthority;
		currentTrust: unknown;
		peers: readonly ScriptedEvidencePeer[];
	}>
): Promise<IndependentRelearnResult> {
	const peers = Object.freeze(input.peers.filter(({ authenticated }) => authenticated));
	const queriedPeers = peers.map(({ peerId }) => peerId);
	const settled = await Promise.allSettled(
		peers.map(async (peer) => {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(new Error("QUERY_TIMEOUT")),
				CREATOR_RELEARN_LIMITS.queryTimeoutMs
			);
			try {
				return await Promise.race([
					peer.query({ signal: controller.signal }),
					new Promise<never>((_resolve, reject) => {
						controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
		})
	);
	const valid: Readonly<{ evidence: ExactCreatorPeerEvidence; valueDigest: string }>[] = [];
	const ignoredPeers: string[] = [];
	for (const [index, result] of settled.entries()) {
		const peerId = queriedPeers[index] as string;
		const candidate =
			result.status === "fulfilled" ? validateEvidence(input.authority, input.currentTrust, result.value) : undefined;
		if (candidate === undefined) ignoredPeers.push(peerId);
		else valid.push(candidate);
	}
	if (valid.length === 0) {
		return Object.freeze({
			ignoredPeers: Object.freeze(ignoredPeers),
			ok: false as const,
			queriedPeers: Object.freeze(queriedPeers),
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
			queriedPeers: Object.freeze(queriedPeers),
			reason: "EQUIVOCATION" as const,
			status: "equivocation" as const,
		});
	}
	return Object.freeze({
		evidence: cloneEvidence(selected.evidence),
		ignoredPeers: Object.freeze(ignoredPeers),
		ok: true as const,
		queriedPeers: Object.freeze(queriedPeers),
		status: "ready" as const,
		valueDigest: selected.valueDigest,
	});
}

/**
 * Proves a peer acknowledgment and relay cannot outrun strict persistence.
 * @param input - Exact evidence and causal callbacks.
 * @returns Ordered causal ledger.
 */
export async function persistBeforeAcknowledge(
	input: Readonly<{
		acknowledge(): void;
		evidence: ExactCreatorPeerEvidence;
		persist(evidence: ExactCreatorPeerEvidence): Promise<void>;
		relay(): void;
	}>
): Promise<readonly string[]> {
	const ledger: string[] = ["received"];
	await input.persist(cloneEvidence(input.evidence));
	ledger.push("persisted");
	input.acknowledge();
	ledger.push("acknowledged");
	input.relay();
	ledger.push("relayed");
	return Object.freeze(ledger);
}

/** Independent storage-loss gate: it can only release recovered exact evidence, never sign. */
export class IndependentCreatorSigningGate {
	#evidence: ExactCreatorPeerEvidence | undefined;
	#status: "equivocation" | "ready" | "relearn-required" | "stalled" = "relearn-required";

	/** @returns Current closed recovery status. */
	status(): string {
		return this.#status;
	}

	/** @param result - Settled all-peer barrier result. */
	apply(result: IndependentRelearnResult): void {
		this.#status = result.status;
		this.#evidence = result.ok ? cloneEvidence(result.evidence) : undefined;
	}

	/** @returns Exact recovered evidence, or the fixed pre-recovery signing block. */
	release(): Readonly<{ evidence: ExactCreatorPeerEvidence; ok: true } | { ok: false; reason: "SIGNING_BLOCKED" }> {
		return this.#evidence === undefined
			? Object.freeze({ ok: false as const, reason: "SIGNING_BLOCKED" as const })
			: Object.freeze({ evidence: cloneEvidence(this.#evidence), ok: true as const });
	}
}
