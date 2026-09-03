import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CloseSetHistoryCommitment } from "@ts-drp/compaction";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssueCommit,
	DurableIssueScope,
	DurableLineage,
} from "@ts-drp/issuance-store";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";

import type { CreatorLiveCloseResult } from "../../../packages/node/src/creator-close.js";
import { resolveCreatorAdoptionFacts } from "../../../packages/node/src/internal/creator-adoption-intent.js";
import { openCreatorSuccessorTrust } from "../../../packages/protocol-v3/src/creator-close.js";
import type { CurrentAnchorTrust } from "../../../packages/protocol-v3/src/index.js";
import {
	bytesForRef,
	type DetachedHeadEvidence,
	openGenuineCreatorAdoptionFixture,
} from "../phase-6a-v3/creator-adoption-contract.js";

export const D110C_0C1A_RETIREMENT_KIND = "drp-creator-issuance-retirement-state" as const;
export const D110C_0C1A_RED_TOKEN = "D110C_0C1A_RETIREMENT_CHECKPOINT_UNAVAILABLE" as const;

interface SealedReplayFacts {
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
}

export interface D110c0c1aIssuedRowEvidence {
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: string;
	readonly issued: DurableIssueCommit;
	readonly journalSequence: number;
	readonly journalSourceKind: "local-issued" | "received";
	readonly outbox: DurableIssuanceOutboxRecord;
	readonly signature: Uint8Array;
}

export interface D110c0c1aRetirementCheckpointEvidence {
	readonly closeIdentity: Readonly<{
		readonly commitQc: Readonly<Record<string, unknown>>;
		readonly commitQcRefExact: boolean;
		readonly cut: Readonly<Record<string, unknown>>;
		readonly cutRefExact: boolean;
		readonly snapshotManifest: Readonly<Record<string, unknown>>;
		readonly snapshotManifestDigest: string;
		readonly successorOpened: boolean;
		readonly successorTrust: Readonly<Record<string, unknown>>;
		readonly successorTrustRefExact: boolean;
	}>;
	readonly closeResult: CreatorLiveCloseResult;
	readonly current: DetachedHeadEvidence;
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplayVerified: boolean;
	readonly history: CloseSetHistoryCommitment;
	readonly issuanceScope: DurableIssueScope;
	readonly lineage: DurableLineage;
	readonly rows: readonly D110c0c1aIssuedRowEvidence[];
	readonly retirementCandidates: readonly Readonly<{
		readonly bytes: Uint8Array;
		readonly ref: GenerationRef;
		readonly value: Readonly<Record<string, unknown>>;
	}>[];
	readonly proposed: DetachedHeadEvidence;
	readonly successorTrust: CurrentAnchorTrust;
}

export interface D110c0c1aRetirementCheckpointFixture {
	readonly evidence: D110c0c1aRetirementCheckpointEvidence;
	close(): Promise<void>;
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const value = decodeCanonical(bytes);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		compareBytes(encodeCanonical(value), bytes) !== 0
	) {
		throw new TypeError("D.110c-0c1a canonical record is unavailable");
	}
	return value as Readonly<Record<string, unknown>>;
}

function exactRef(bytes: Uint8Array, ref: GenerationRef): boolean {
	const digest = digestBlob(bytes);
	return digest.ok && digest.value === ref.digest && bytes.byteLength === ref.byteLength;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

/**
 * Builds the genuine creator-close evidence consumed by the D.110c-0c1a RED.
 * @returns One live fixture with exact issuance, replay and successor evidence.
 */
export async function openD110c0c1aRetirementCheckpointFixture(): Promise<D110c0c1aRetirementCheckpointFixture> {
	const fixture = await openGenuineCreatorAdoptionFixture({
		beforeCreatorClose: async ({ firstLogicalTime, plane, signRegisteredVertexDigest }) => {
			const issued = await plane.issueLocal({
				operations: Object.freeze([
					Object.freeze({
						logicalTime: firstLogicalTime,
						operation: Object.freeze({ action: "add", value: 4 }),
					}),
				]),
				signRegisteredVertexDigest,
			});
			if (!issued.ok) throw new TypeError(`D.110c-0c1a second issue failed: ${issued.kind}`);
			return Object.freeze({ authorSequence: issued.authorSequence, digest: issued.digest });
		},
	});

	try {
		const {
			closeResult,
			current,
			currentTrust,
			declaration,
			history,
			issuanceScope,
			issuanceStore,
			journalRows,
			proposed,
		} = fixture.evidence;
		const lineage = await issuanceStore.readLineage(issuanceScope);
		const outbox = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
		const rows = await Promise.all(
			outbox.map(async (entry): Promise<D110c0c1aIssuedRowEvidence> => {
				const authorSequence = entry.commit.authorSequence;
				const issued = await issuanceStore.readIssued(issuanceScope, authorSequence);
				if (issued === null) throw new TypeError(`D.110c-0c1a issued row ${authorSequence} is unavailable`);
				const digest = hex(entry.commit.envelope.digest);
				const journal = journalRows.find((row) => row.vertexDigest === digest);
				if (journal === undefined) throw new TypeError(`D.110c-0c1a journal row ${authorSequence} is unavailable`);
				return Object.freeze({
					authorSequence,
					canonicalPreimageBytes: Uint8Array.from(entry.commit.envelope.canonicalPreimageBytes),
					digest,
					issued,
					journalSequence: journal.journalSequence,
					journalSourceKind: journal.sourceKind,
					outbox: entry,
					signature: Uint8Array.from(entry.commit.envelope.signature),
				});
			})
		);
		const facts = resolveCreatorAdoptionFacts<SealedReplayFacts>(fixture.handle);
		if (facts === undefined) throw new TypeError("D.110c-0c1a sealed replay facts are unavailable");
		const durableReplayVerified = await facts.durableReplay.verify();
		const cutBytes = bytesForRef(proposed, closeResult.cutValueRef);
		const commitQcBytes = bytesForRef(proposed, closeResult.commitQcRef);
		const successorTrustBytes = bytesForRef(proposed, closeResult.successorTrustRef);
		const cut = canonicalRecord(cutBytes);
		const commitQc = canonicalRecord(commitQcBytes);
		const successorTrust = canonicalRecord(successorTrustBytes);
		const successor = openCreatorSuccessorTrust({
			currentTrust,
			exactCanonicalCommitQcBytes: commitQcBytes,
			exactCanonicalCutValueBytes: cutBytes,
			exactCanonicalTrustStateRecordBytes: successorTrustBytes,
		});
		const snapshotManifest = canonicalRecord(declaration.exactCanonicalManifestBytes);
		if (!successor.ok) throw new TypeError(`D.110c-0c1a successor open failed: ${successor.reason}`);
		const retirementCandidates = proposed.candidates.flatMap((candidate) => {
			const value = canonicalRecord(candidate.bytes);
			return value.kind === D110C_0C1A_RETIREMENT_KIND
				? [Object.freeze({ bytes: Uint8Array.from(candidate.bytes), ref: candidate.ref, value })]
				: [];
		});
		if (
			commitQc.proposalDigest !== hex(hashDomain("ts-drp/hard-epoch-cut/v3", cutBytes)) ||
			commitQc.phase !== "commit"
		) {
			throw new TypeError("D.110c-0c1a commit QC does not identify the exact Cut");
		}
		return Object.freeze({
			close: () => fixture.close(),
			evidence: Object.freeze({
				closeIdentity: Object.freeze({
					commitQc,
					commitQcRefExact: exactRef(commitQcBytes, closeResult.commitQcRef),
					cut,
					cutRefExact: exactRef(cutBytes, closeResult.cutValueRef),
					snapshotManifest,
					snapshotManifestDigest: declaration.scope.manifestDigest,
					successorOpened:
						successor.ok &&
						successor.trust.currentAnchorDigest === closeResult.successorAnchorDigest &&
						successor.trust.currentEpoch === closeResult.successorEpoch,
					successorTrust,
					successorTrustRefExact: exactRef(successorTrustBytes, closeResult.successorTrustRef),
				}),
				closeResult,
				current,
				currentTrust,
				durableReplayVerified,
				history,
				issuanceScope,
				lineage,
				proposed,
				retirementCandidates: Object.freeze(retirementCandidates),
				rows: Object.freeze(rows),
				successorTrust: successor.trust,
			}),
		});
	} catch (error) {
		await fixture.close();
		throw error;
	}
}
