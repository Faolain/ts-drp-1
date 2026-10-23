import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";

import {
	type ReceivedClosedJournalAuthorityMaterial,
	type ReceivedClosedJournalHeader,
	verifyReceivedClosedJournalAuthority,
	encodeReceivedCloseMembership,
	openReceivedCloseMembership,
	RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES,
} from "../packages/node/src/internal/creator-received-close-membership.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { openCreatorCloseMembership } from "../packages/node/src/internal/creator-close-membership.js";
import { deliver, install, openOutsideRowsRoom, play, seal } from "./fixtures/track-x/outside-rows-room.js";

// Track X, decision row 60, the owner's W1: a kept Cut authority is re-verified against the
// creator's immutable trust on every use. This takes real signed material from a Writer on the
// node SQLite host (Grid zone application, creator-trusted-settlement-v1): Cut(e), its commit QC
// and the successor trust state (e+1) from the Writer's received recovery certificate, anchor(e)
// and its signature from the Writer's journal header, and the pinned genesis from the invite. The
// genuine material re-verifies to the scope's authority; each forgery is refused, so it is never used.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

type Mutable = Record<string, unknown>;
const decode = (bytes: Uint8Array): Mutable => ({ ...(decodeCanonical(bytes) as Mutable) });
const flipped = (bytes: Uint8Array): Uint8Array => {
	const copy = bytes.slice();
	copy[copy.length - 1] = (copy.at(-1) ?? 0) ^ 1;
	return copy;
};

it("re-verifies genuine kept material against the pinned genesis and refuses every forgery", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	for (let epoch = 0; epoch < 3; epoch++) {
		await play(room, `epoch-${epoch}`);
		await seal(room, epoch);
		await creator.room.adoptCreatorSuccessor();
		expect(await install(room, 1)).toBe("ok");
		await deliver(room, 1);
	}
	const { objectId, invite } = room.fixture;
	const storageHost = room.fixture.host.storageHost;
	// The Writer's closed journal scopes and their signed headers.
	const headers = new Map<
		number,
		Readonly<{ anchorDigest: string; header: ReceivedClosedJournalHeader; membership?: Uint8Array }>
	>();
	const journal = await storageHost.openJournal("peer-1");
	try {
		const read = await required(journal.readRetirementImage)({ objectId });
		if (!read.ok) throw new TypeError(`journal read: ${read.kind}`);
		for (const bytes of read.value.canonicalRows) {
			const frame = decodeCanonical(bytes) as [string, unknown[], Mutable];
			if (frame[0] !== "scopes") continue;
			const fields = frame[2];
			headers.set(Number(frame[1][1]), {
				anchorDigest: String(frame[1][2]),
				membership: (fields.closed_membership_bytes ?? fields.closedMembershipBytes) as Uint8Array | undefined,
				header: {
					exactCanonicalAnchorPreimageBytes: (fields.exact_anchor_preimage ??
						fields.exactCanonicalAnchorPreimageBytes) as Uint8Array,
					detachedAnchorSignature: (fields.detached_anchor_signature ?? fields.detachedAnchorSignature) as Uint8Array,
				},
			});
		}
	} finally {
		await journal.close();
	}
	// Cut(e), QC(e) and trust state (e+1) from a received recovery certificate the Writer holds.
	let found: { epoch: number; certificate: Mutable } | undefined;
	const snapshots = await storageHost.openSnapshots("peer-1");
	try {
		for (const [epoch, { anchorDigest }] of [...headers].sort(([left], [right]) => left - right)) {
			const certificate = await snapshots.lookupReceivedRecoveryCertificate({ objectId, epoch, anchor: anchorDigest });
			if (certificate === null) continue;
			const opened = decode(certificate.exactReceivedCertificateBytes);
			const cut = decode(opened.exactCanonicalCutValueBytes as Uint8Array);
			const closed = headers.get(Number(cut.epoch));
			if (closed === undefined || closed.anchorDigest !== cut.previousAnchor || Number(cut.epoch) < 1) continue;
			found = { epoch: Number(cut.epoch), certificate: opened };
		}
	} finally {
		await snapshots.close();
	}
	const { epoch, certificate } = required(found);
	const closed = required(headers.get(epoch));
	const successor = certificate.exactCanonicalTrustStateRecordBytes as Uint8Array;
	const material: ReceivedClosedJournalAuthorityMaterial = {
		scope: { objectId, epoch, anchorDigest: closed.anchorDigest },
		exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes as Uint8Array,
		exactCanonicalCommitQcBytes: certificate.exactCanonicalCommitQcBytes as Uint8Array,
		exactCanonicalSuccessorTrustStateRecordBytes: successor,
	};
	const trust = decode(successor);
	const genesis = (signature = invite.detachedGenesisSignature) =>
		encodeCanonical({
			currentAnchorDigest: invite.pinnedGenesisAnchorDigest,
			currentEpoch: 0,
			detachedCurrentAnchorSignature: signature,
			exactCanonicalCurrentAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalProfileBytes: trust.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: trust.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId,
			profileId: trust.profileId,
			quorum: 1,
			version: 1,
		});
	const verify = (
		changes: Partial<ReceivedClosedJournalAuthorityMaterial> = {},
		header: ReceivedClosedJournalHeader = closed.header,
		pinned: Uint8Array = genesis()
	) =>
		verifyReceivedClosedJournalAuthority({
			material: { ...material, ...changes },
			header,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: pinned,
		});

	const stored = required(openReceivedCloseMembership(required(closed.membership)));
	const carrier = encodeReceivedCloseMembership({
		exactCanonicalMembershipBytes: stored.exactCanonicalMembershipBytes,
		exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes,
		exactCanonicalCommitQcBytes: material.exactCanonicalCommitQcBytes,
		exactCanonicalSuccessorTrustStateRecordBytes: material.exactCanonicalSuccessorTrustStateRecordBytes,
	});
	const openedCarrier = required(openReceivedCloseMembership(carrier));
	expect(carrier).toEqual(closed.membership);
	expect(openedCarrier.exactCanonicalMembershipBytes).toEqual(stored.exactCanonicalMembershipBytes);
	expect(openedCarrier.exactCanonicalCutValueBytes).toEqual(material.exactCanonicalCutValueBytes);
	expect(await openCreatorCloseMembership({ bytes: carrier,
		exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes,
		maxEpochVertices: (decode(material.exactCanonicalCutValueBytes).parameters as { maxEpochVertices: number }).maxEpochVertices,
	})).toBeDefined();
	expect(openReceivedCloseMembership(carrier.subarray(0, carrier.length - 1))).toBeUndefined();
	expect(() =>
		encodeReceivedCloseMembership({
			...openedCarrier,
			exactCanonicalCommitQcBytes: new Uint8Array(RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES + 1),
		})
	).toThrow();
	expect(openReceivedCloseMembership(encodeCanonical({ ...decode(carrier), extra: true }))).toBeUndefined();
	expect(
		openReceivedCloseMembership(
			encodeCanonical({
				...decode(carrier),
				exactCanonicalCutValueBytes: encodeCanonical({
					...decode(material.exactCanonicalCutValueBytes),
					closeReason: "forged",
				}),
			})
		)
	).toBeUndefined();
	const genuine = required(verify());
	const anchor = decode(closed.header.exactCanonicalAnchorPreimageBytes);
	expect(genuine.scope).toEqual(material.scope);
	expect([...genuine.exactCanonicalCutValueBytes]).toEqual([...material.exactCanonicalCutValueBytes]);
	expect(genuine.closedAclDigest).toBe(anchor.aclDigest);
	expect(genuine.suiteId).toBe(anchor.cryptoSuiteId);
	expect(genuine.profileId).toBe("creator-trusted-settlement-v1");

	// A different Cut under the same signed successor.
	const cut = decode(material.exactCanonicalCutValueBytes);
	expect(verify({ exactCanonicalCutValueBytes: encodeCanonical({ ...cut, closeReason: "forged" }) })).toBeUndefined();
	// A forged commit QC.
	const qc = decode(material.exactCanonicalCommitQcBytes);
	expect(verify({ exactCanonicalCommitQcBytes: encodeCanonical({ ...qc, forged: true }) })).toBeUndefined();
	// A successor trust state whose anchor signature is not the creator's.
	expect(
		verify({
			exactCanonicalSuccessorTrustStateRecordBytes: encodeCanonical({
				...trust,
				detachedCurrentAnchorSignature: flipped(trust.detachedCurrentAnchorSignature as Uint8Array),
			}),
		})
	).toBeUndefined();
	// The scope's own anchor with a signature that is not the creator's.
	expect(
		verify({}, { ...closed.header, detachedAnchorSignature: flipped(closed.header.detachedAnchorSignature) })
	).toBeUndefined();
	// Material for this scope against another scope's signed header, or named as another scope.
	const other = required(headers.get(epoch + 1));
	expect(verify({}, other.header)).toBeUndefined();
	expect(verify({ scope: { objectId, epoch: epoch + 1, anchorDigest: other.anchorDigest } })).toBeUndefined();
	// A pinned genesis that is not the creator's.
	expect(verify({}, closed.header, genesis(flipped(invite.detachedGenesisSignature)))).toBeUndefined();
	// The genuine material still re-verifies after every refusal (nothing was mutated).
	expect(verify()).toEqual(genuine);
}, 900_000);
