import { decodeCanonical, hashDomain } from "@ts-drp/canonical";

import {
	openCreatorAuthorIssuanceFrontiers,
	resolveCreatorAuthorIssuanceFrontiers,
} from "../../../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { openCreatorSuccessorTrust } from "../../../packages/protocol-v3/src/creator-close.js";
import { openGenuineCreatorAdoptionFixture } from "../phase-6a-v3/creator-adoption-contract.js";
import { d108d1bChatAuthorities } from "../phase-6a-v3/creator-successor-local-author-contract.js";

export const D110C_0C1F1_MULTI_AUTHOR_FRONTIER_CARRIER_REQUIRED =
	"D110C_0C1F1_MULTI_AUTHOR_FRONTIER_CARRIER_REQUIRED" as const;
export const D110C_0C1F1_FRONTIER_KIND = "drp-creator-author-issuance-frontiers-state" as const;
export const D110C_0C1F1_LEGACY_KIND = "drp-creator-issuance-retirement-state" as const;

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_0C1F2_CANONICAL_RECORD_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

/**
 * Proves that a genuine two-writer close admits both authors but current
 * production emits only the creator's legacy issuance carrier.
 * @returns Completion after the aggregate frontier is authenticated.
 */
export async function proveD110c0c1f2MissingMultiAuthorFrontier(): Promise<void> {
	const authorities = d108d1bChatAuthorities();
	const creator = authorities.find(({ id }) => id === "alice");
	const secondWriter = authorities.find(({ id }) => id === "bob");
	if (creator === undefined || secondWriter === undefined) {
		throw new TypeError("D110C_0C1F2_TWO_WRITER_AUTHORITY_UNAVAILABLE");
	}
	const fixture = await openGenuineCreatorAdoptionFixture({
		authorizedPrivateKeySeedHexes: [creator.privateKeySeedHex, secondWriter.privateKeySeedHex],
		establishedPeerPrivateKeySeedHex: secondWriter.privateKeySeedHex,
	});
	try {
		const {
			closeResult,
			currentTrust,
			establishedPeer,
			journalRows,
			localIssued,
			predecessorExactCanonicalLatchedAclBytes,
			proposed,
		} = fixture.evidence;
		if (
			closeResult.ok !== true ||
			closeResult.epoch !== 0 ||
			closeResult.successorEpoch !== 1 ||
			establishedPeer?.author !== secondWriter.author ||
			establishedPeer.authorSequence !== 0
		) {
			throw new TypeError("D110C_0C1F2_GENUINE_TWO_WRITER_CLOSE_INVALID");
		}
		const acl = canonicalRecord(predecessorExactCanonicalLatchedAclBytes);
		const members = Array.isArray(acl.members)
			? acl.members.map((member) => member as Readonly<Record<string, unknown>>)
			: [];
		if (
			acl.permissionless !== false ||
			members.length !== 2 ||
			!members.every(
				(member) =>
					Array.isArray(member.groups) &&
					member.groups.includes("writer") &&
					(member.author === creator.author || member.author === secondWriter.author)
			)
		) {
			throw new TypeError("D110C_0C1F2_TWO_WRITER_ACL_INVALID");
		}
		const admittedSecondWriterRows = journalRows.filter((row) => {
			if (row.sourceKind !== "received" || row.vertexDigest !== Buffer.from(establishedPeer.digest).toString("hex")) {
				return false;
			}
			const vertex = canonicalRecord(row.exactCanonicalPreimageBytes);
			return vertex.author === secondWriter.author && vertex.authorSequence === 0;
		});
		if (admittedSecondWriterRows.length !== 1) {
			throw new TypeError("D110C_0C1F2_SECOND_WRITER_ADMISSION_INVALID");
		}
		const records = proposed.candidates.map(({ bytes }) => canonicalRecord(bytes));
		const legacy = records.filter(({ kind }) => kind === D110C_0C1F1_LEGACY_KIND);
		const aggregate = records.filter(({ kind }) => kind === D110C_0C1F1_FRONTIER_KIND);
		if (
			legacy.length !== 1 ||
			legacy[0]?.author !== creator.author ||
			proposed.references.length !== proposed.candidates.length
		) {
			throw new TypeError("D110C_0C1F2_CURRENT_CLOSURE_CLASS_INVALID");
		}
		if (aggregate.length === 0) throw new TypeError(D110C_0C1F1_MULTI_AUTHOR_FRONTIER_CARRIER_REQUIRED);
		if (aggregate.length !== 1) throw new TypeError("D110C_0C1F2_AGGREGATE_CANDIDATE_AMBIGUOUS");
		const candidate = proposed.candidates.find(
			({ bytes }) => canonicalRecord(bytes).kind === D110C_0C1F1_FRONTIER_KIND
		);
		const cut = proposed.candidates.find(({ ref }) => ref.digest === closeResult.cutValueRef.digest);
		const qc = proposed.candidates.find(({ ref }) => ref.digest === closeResult.commitQcRef.digest);
		const trust = proposed.candidates.find(({ ref }) => ref.digest === closeResult.successorTrustRef.digest);
		if (candidate === undefined || cut === undefined || qc === undefined || trust === undefined) {
			throw new TypeError("D110C_0C1F2_AGGREGATE_PROOF_UNAVAILABLE");
		}
		const successor = openCreatorSuccessorTrust({
			currentTrust,
			exactCanonicalCommitQcBytes: qc.bytes,
			exactCanonicalCutValueBytes: cut.bytes,
			exactCanonicalTrustStateRecordBytes: trust.bytes,
		});
		if (!successor.ok) throw new TypeError("D110C_0C1F2_SUCCESSOR_TRUST_UNAVAILABLE");
		const aggregateRecord = canonicalRecord(candidate.bytes);
		const cutRecord = canonicalRecord(cut.bytes);
		const opened = openCreatorAuthorIssuanceFrontiers({
			currentTrust,
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: Buffer.from(
				hashDomain("ts-drp/latched-acl/v3", predecessorExactCanonicalLatchedAclBytes)
			).toString("hex"),
			expectedCutValueDigest: Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)).toString("hex"),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			expectedSuccessorAclDigest: aggregateRecord.successorAclDigest,
			floorTrust: successor.trust,
		});
		const identity = opened.ok ? resolveCreatorAuthorIssuanceFrontiers(opened.capability) : undefined;
		if (identity === undefined) throw new TypeError("D110C_0C1F2_AGGREGATE_OPEN_FAILED");
		const expectedFrontiers = [
			[creator.author, localIssued.authorSequence] as const,
			[secondWriter.author, establishedPeer.authorSequence] as const,
		].sort(([left], [right]) => left.localeCompare(right));
		if (JSON.stringify(identity.frontiers) !== JSON.stringify(expectedFrontiers)) {
			throw new TypeError(
				`D110C_0C1F2_AGGREGATE_FRONTIERS_INVALID:${JSON.stringify(identity.frontiers)}:${JSON.stringify(expectedFrontiers)}`
			);
		}
		if (process.env.D110C_0C1F2_RECORD_EVIDENCE === "1") {
			process.stdout.write(
				`D110C_0C1F2_PROTOCOL_RED_EVIDENCE=${JSON.stringify({
					aggregateCarrierCount: aggregate.length,
					closeSetCount: fixture.evidence.history.closeSetCount,
					creator: creator.author,
					legacyCarrierCount: legacy.length,
					secondWriter: secondWriter.author,
					secondWriterAdmittedRows: admittedSecondWriterRows.length,
					successorEpoch: closeResult.successorEpoch,
					writerCount: members.length,
				})}\n`
			);
		}
	} finally {
		await fixture.close();
	}
}
