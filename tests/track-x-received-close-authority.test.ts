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

type WriterKeptMaterial = Readonly<{
	material: ReceivedClosedJournalAuthorityMaterial;
	closed: Readonly<{ anchorDigest: string; header: ReceivedClosedJournalHeader; membership?: Uint8Array }>;
}>;

/**
 * The Writer's signed journal headers and the received recovery certificates it holds, joined
 * by the Cut's closed scope: Cut(e), QC(e) and trust state (e+1) with anchor(e) and its signature.
 * @param room - The outside-rows room after its successors were installed.
 * @returns Kept material per closed epoch, the scope headers by epoch, and the pinned genesis.
 */
type WriterHeader = Readonly<{ anchorDigest: string; header: ReceivedClosedJournalHeader; membership?: Uint8Array }>;
async function writerKeptMaterial(room: Awaited<ReturnType<typeof openOutsideRowsRoom>>): Promise<
	Readonly<{
		headers: ReadonlyMap<number, WriterHeader>;
		kept: ReadonlyMap<number, WriterKeptMaterial>;
		genesis(trustBytes: Uint8Array, signature?: Uint8Array): Uint8Array;
	}>
> {
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
	const kept = new Map<number, WriterKeptMaterial>();
	const snapshots = await storageHost.openSnapshots("peer-1");
	try {
		for (const [epoch, { anchorDigest }] of [...headers].sort(([left], [right]) => left - right)) {
			const certificate = await snapshots.lookupReceivedRecoveryCertificate({ objectId, epoch, anchor: anchorDigest });
			if (certificate === null) continue;
			const opened = decode(certificate.exactReceivedCertificateBytes);
			const cut = decode(opened.exactCanonicalCutValueBytes as Uint8Array);
			const closed = headers.get(Number(cut.epoch));
			if (closed === undefined || closed.anchorDigest !== cut.previousAnchor) continue;
			kept.set(Number(cut.epoch), {
				closed,
				material: {
					scope: { objectId, epoch: Number(cut.epoch), anchorDigest: closed.anchorDigest },
					exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes as Uint8Array,
					exactCanonicalCommitQcBytes: opened.exactCanonicalCommitQcBytes as Uint8Array,
					exactCanonicalSuccessorTrustStateRecordBytes: opened.exactCanonicalTrustStateRecordBytes as Uint8Array,
				},
			});
		}
	} finally {
		await snapshots.close();
	}
	const genesis = (trustBytes: Uint8Array, signature = invite.detachedGenesisSignature): Uint8Array => {
		const trust = decode(trustBytes);
		return encodeCanonical({
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
	};
	return { headers, kept, genesis };
}

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
	const { headers, kept, genesis: pinnedGenesis } = await writerKeptMaterial(room);
	// The latest kept non-genesis Cut (the genesis Cut has its own test below).
	const epoch = Math.max(...[...kept.keys()].filter((value) => value >= 1));
	const { closed, material } = required(kept.get(epoch));
	const successor = material.exactCanonicalSuccessorTrustStateRecordBytes;
	const trust = decode(successor);
	const genesis = (signature = invite.detachedGenesisSignature): Uint8Array => pinnedGenesis(successor, signature);
	const verify = (
		changes: Partial<ReceivedClosedJournalAuthorityMaterial> = {},
		header: ReceivedClosedJournalHeader = closed.header,
		pinned: Uint8Array = genesis()
	): ReturnType<typeof verifyReceivedClosedJournalAuthority> =>
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
	expect(
		await openCreatorCloseMembership({
			bytes: carrier,
			exactCanonicalCutValueBytes: material.exactCanonicalCutValueBytes,
			maxEpochVertices: (decode(material.exactCanonicalCutValueBytes).parameters as { maxEpochVertices: number })
				.maxEpochVertices,
		})
	).toBeDefined();
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

// The genesis scope (epoch 0) closes the pinned genesis trust itself; its successor trust is
// opened by the original genesis-successor state equation. A Writer that never saw that scope
// collected early must still be able to re-verify the kept genesis Cut, or its epoch-0 journal
// detail and every settled issuance row behind it stay protected for the life of the room.
it("re-verifies genuine kept genesis-scope material and refuses every forgery", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	for (let epoch = 0; epoch < 3; epoch++) {
		await play(room, `epoch-${epoch}`);
		await seal(room, epoch);
		await creator.room.adoptCreatorSuccessor();
		expect(await install(room, 1)).toBe("ok");
		await deliver(room, 1);
	}
	const { invite } = room.fixture;
	const { headers, kept, genesis: pinnedGenesis } = await writerKeptMaterial(room);
	expect([...kept.keys()].sort(), `kept closed scopes; headers ${JSON.stringify([...headers.keys()])}`).toContain(0);
	const { closed, material } = required(kept.get(0));
	const successor = material.exactCanonicalSuccessorTrustStateRecordBytes;
	const trust = decode(successor);
	expect(closed.anchorDigest).toBe(invite.pinnedGenesisAnchorDigest);
	const verify = (
		changes: Partial<ReceivedClosedJournalAuthorityMaterial> = {},
		header: ReceivedClosedJournalHeader = closed.header,
		pinned: Uint8Array = pinnedGenesis(successor)
	): ReturnType<typeof verifyReceivedClosedJournalAuthority> =>
		verifyReceivedClosedJournalAuthority({
			material: { ...material, ...changes },
			header,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: pinned,
		});
	expect(verify(), "the genuine kept genesis Cut re-verifies against the pinned genesis").toBeDefined();
	const genuine = required(verify());
	const anchor = decode(closed.header.exactCanonicalAnchorPreimageBytes);
	expect(genuine.scope).toEqual(material.scope);
	expect([...genuine.exactCanonicalCutValueBytes]).toEqual([...material.exactCanonicalCutValueBytes]);
	expect(genuine.closedAclDigest).toBe(anchor.aclDigest);
	expect(genuine.suiteId).toBe(anchor.cryptoSuiteId);
	expect(genuine.profileId).toBe("creator-trusted-settlement-v1");

	const cut = decode(material.exactCanonicalCutValueBytes);
	expect(verify({ exactCanonicalCutValueBytes: encodeCanonical({ ...cut, closeReason: "forged" }) })).toBeUndefined();
	const qc = decode(material.exactCanonicalCommitQcBytes);
	expect(verify({ exactCanonicalCommitQcBytes: encodeCanonical({ ...qc, forged: true }) })).toBeUndefined();
	expect(
		verify({
			exactCanonicalSuccessorTrustStateRecordBytes: encodeCanonical({
				...trust,
				detachedCurrentAnchorSignature: flipped(trust.detachedCurrentAnchorSignature as Uint8Array),
			}),
		})
	).toBeUndefined();
	// The genesis Cut named as the next scope, or checked against the next scope's header.
	const other = required(headers.get(1));
	expect(verify({}, other.header)).toBeUndefined();
	expect(verify({ scope: { ...material.scope, epoch: 1, anchorDigest: other.anchorDigest } })).toBeUndefined();
	// Another epoch's kept Cut, QC and successor trust named as the genesis scope.
	const later = required(kept.get(1)).material;
	expect(verify({ ...later, scope: material.scope })).toBeUndefined();
	// A pinned genesis that is not the creator's.
	expect(verify({}, closed.header, pinnedGenesis(successor, flipped(invite.detachedGenesisSignature)))).toBeUndefined();
	expect(verify()).toEqual(genuine);
}, 900_000);
