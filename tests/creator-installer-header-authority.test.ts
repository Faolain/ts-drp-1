import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { LiveJournalRetirementImageObservation } from "@ts-drp/live-journal";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { deliver, install, openOutsideRowsRoom, play, seal } from "./fixtures/track-x/outside-rows-room.js";
import { closedJournalHeaderAuthenticates } from "../packages/node/src/internal/creator-closed-rollback-data.js";

// fix/skip-scope-chain-invalid: the installer accepts a collectible journal prefix outside the
// recovery trusts only when the scope's own signed header, in the image the installer binds,
// re-verifies against the pinned genesis with its kept closed authority. This takes a Writer's
// real journal image (Grid zone application, creator-trusted-settlement-v1, the node SQLite
// host): each closed scope with kept authority authenticates; a flipped anchor signature, a
// header moved to another scope, a carrier from another scope, a carrier stripped of its
// authority envelope and a genesis other than the pinned one never do.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

type Mutable = Record<string, unknown>;
type Frame = [string, unknown[], Mutable];
const decode = (bytes: Uint8Array): Mutable => ({ ...(decodeCanonical(bytes) as Mutable) });
const flipped = (bytes: Uint8Array): Uint8Array => {
	const copy = bytes.slice();
	copy[copy.length - 1] = (copy.at(-1) ?? 0) ^ 1;
	return copy;
};

it("the installer's header check authenticates exactly the scopes whose kept authority re-verifies", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	for (let epoch = 0; epoch < 4; epoch++) {
		await play(room, `epoch-${epoch}`);
		await seal(room, epoch);
		await creator.room.adoptCreatorSuccessor();
		expect(await install(room, 1)).toBe("ok");
		await deliver(room, 1);
	}
	const { objectId, invite } = room.fixture;
	const journal = await room.fixture.host.storageHost.openJournal("peer-1");
	let image: LiveJournalRetirementImageObservation;
	try {
		const read = await required(journal.readRetirementImage)({ objectId });
		if (!read.ok) throw new TypeError(`journal read: ${read.kind}`);
		image = read.value;
	} finally {
		await journal.close();
	}
	const frames = image.canonicalRows.map((bytes) => decodeCanonical(bytes) as Frame);
	const headers = frames.filter((frame) => frame[0] === "scopes");
	const carrierOf = (frame: Frame): Uint8Array | undefined =>
		(frame[2].closed_membership_bytes ?? frame[2].closedMembershipBytes) as Uint8Array | undefined;
	// The scopes whose header keeps a received-close authority envelope.
	const kept = headers.filter((frame) => {
		const carrier = carrierOf(frame);
		return carrier !== undefined && decode(carrier).kind === "creator-received-close-membership-1";
	});
	expect(kept.length, "closed scopes with kept authority").toBeGreaterThanOrEqual(2);
	// The pinned genesis trust state, as the room builds it from its invite.
	const successor = decode(
		required(decode(required(carrierOf(required(kept[0])))).exactCanonicalSuccessorTrustStateRecordBytes as Uint8Array)
	);
	const genesis = (signature: Uint8Array = invite.detachedGenesisSignature): Uint8Array =>
		encodeCanonical({
			currentAnchorDigest: invite.pinnedGenesisAnchorDigest,
			currentEpoch: 0,
			detachedCurrentAnchorSignature: signature,
			exactCanonicalCurrentAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalProfileBytes: successor.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: successor.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId,
			profileId: successor.profileId,
			quorum: 1,
			version: 1,
		});
	const scopeOf = (frame: Frame): Readonly<{ objectId: string; epoch: number; anchorDigest: string }> => ({
		objectId,
		epoch: Number(frame[1][1]),
		anchorDigest: String(frame[1][2]),
	});
	const check = (
		frame: Frame,
		rows: readonly Uint8Array[] = image.canonicalRows,
		pinned = genesis(),
		pinnedGenesisAnchorDigest = invite.pinnedGenesisAnchorDigest
	): boolean =>
		closedJournalHeaderAuthenticates({
			image: { ...image, canonicalRows: rows },
			scope: scopeOf(frame),
			exactCanonicalPinnedGenesisTrustStateRecordBytes: pinned,
			pinnedGenesisAnchorDigest,
		});
	/**
	 * The image with one scope's header fields replaced.
	 * @param frame - The scope's header frame.
	 * @param fields - The replaced fields.
	 * @returns The image's rows.
	 */
	const withHeader = (frame: Frame, fields: Mutable): Uint8Array[] =>
		image.canonicalRows.map((bytes) => {
			const value = decodeCanonical(bytes) as Frame;
			return value[0] === "scopes" && value[1][1] === frame[1][1]
				? encodeCanonical([value[0], value[1], { ...value[2], ...fields }])
				: bytes;
		});
	const signatureKey = (frame: Frame): string =>
		"detached_anchor_signature" in frame[2] ? "detached_anchor_signature" : "detachedAnchorSignature";
	const carrierKey = (frame: Frame): string =>
		"closed_membership_bytes" in frame[2] ? "closed_membership_bytes" : "closedMembershipBytes";

	for (const frame of kept) expect(check(frame), `scope ${String(frame[1][1])}`).toBe(true);
	// Forgeries of non-genesis scopes (the genesis scope closes the pinned genesis itself: its
	// header's signature is not part of its authority).
	const later = kept.filter((frame) => Number(frame[1][1]) >= 1);
	expect(later.length, "non-genesis closed scopes with kept authority").toBeGreaterThanOrEqual(2);
	const [first, second] = [required(later[0]), required(later[1])];
	// A flipped anchor signature.
	expect(
		check(first, withHeader(first, { [signatureKey(first)]: flipped(first[2][signatureKey(first)] as Uint8Array) }))
	).toBe(false);
	// Another scope's carrier in this scope's header.
	expect(check(first, withHeader(first, { [carrierKey(first)]: required(carrierOf(second)) }))).toBe(false);
	// The bare membership without its authority envelope.
	expect(
		check(
			first,
			withHeader(first, {
				[carrierKey(first)]: decode(required(carrierOf(first))).exactCanonicalMembershipBytes as Uint8Array,
			})
		)
	).toBe(false);
	// This scope's header copied under another scope (its anchor no longer hashes to that scope).
	expect(
		check(
			second,
			image.canonicalRows.map((bytes) => {
				const value = decodeCanonical(bytes) as Frame;
				return value[0] === "scopes" && value[1][1] === second[1][1]
					? encodeCanonical([value[0], value[1], first[2]])
					: bytes;
			})
		)
	).toBe(false);
	// A genesis whose signature is not the pinned genesis's, and a pin naming another genesis.
	expect(check(first, image.canonicalRows, genesis(flipped(invite.detachedGenesisSignature)))).toBe(false);
	expect(check(first, image.canonicalRows, genesis(), "00".repeat(32))).toBe(false);
	// No header at all.
	expect(
		check(
			first,
			image.canonicalRows.filter((bytes) => (decodeCanonical(bytes) as Frame)[0] !== "scopes")
		)
	).toBe(false);
}, 600_000);
