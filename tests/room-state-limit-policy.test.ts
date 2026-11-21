import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import { createV3RoomCreatorInviteMaterial, type V3RoomCreatorInviteMaterial } from "../examples/v3-room/src/index.js";
import { authenticateV3RoomCreatorInvite } from "../packages/node/src/v3-room.js";

// Owner decision 2026-11-21: the room's application state limit is a per-room setting chosen when the
// room is created. It is the optional `maxApplicationStateBytes` field of the room's signed parameters
// record (the parameters carrier, whose digest the creator signs into the genesis anchor), so every
// member reads the same authenticated value (G5). Absent, the limit is exactly 32,768 bytes, as before.
// A value outside [32,768, the library ceiling] is refused by the creator when it builds the invite and
// by every member that authenticates one.

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const DEFAULT_LIMIT = 32_768;
const CEILING = 131_072;

const PARAMETERS = Object.freeze({
	authorShareMultiplier: 4,
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

const seed = new Uint8Array(32).fill(0x5a);
const creatorAuthor = hex(ed25519.getPublicKey(seed));
const roster = [{ author: creatorAuthor, order: 0, peerId: "room-state-limit-peer-0" }];
const application = createV3ZoneApplication(roster, "room-state-limit-peer-0", creatorAuthor);
const objectId = `creator:${"a1".repeat(16)}`;

function inviteInput(parameters: Readonly<Record<string, number>>) {
	return {
		blueprintDigest: application.catalog.blueprintDigests[0]!,
		exactCanonicalApplicationStateBytes: application.migration!.canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author: creatorAuthor, finalityKey: creatorAuthor, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: 3,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
			quorum: 1,
			signers: [{ publicKey: creatorAuthor, signerId: "creator" }],
		}),
		exactCanonicalSignerSetBytes: encodeCanonical([{ publicKey: creatorAuthor, signerId: "creator" }]),
		objectId,
		signGenesisAnchorDigest: async (digest: Uint8Array) => ed25519.sign(digest, seed),
	};
}

/** The wire invite (ts-drp-example-v3-room-creator-invite v1) of this material. */
function wireInvite(material: V3RoomCreatorInviteMaterial): string {
	return hex(
		encodeCanonical({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			kind: "ts-drp-example-v3-room-creator-invite",
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			version: 1,
		})
	);
}

/**
 * A genuinely creator-signed invite carrying these parameters, built without the creator's own check
 * (what a faulty or hostile creator could publish): the valid material's anchor with the parameters
 * digest replaced, signed again with the creator's key.
 */
async function signedInviteWith(parameters: Readonly<Record<string, number>>): Promise<string> {
	const valid = await createV3RoomCreatorInviteMaterial(inviteInput(PARAMETERS));
	const exactCanonicalParametersCarrierBytes = encodeCanonical(parameters);
	const anchor = decodeCanonical(valid.exactCanonicalGenesisAnchorPreimageBytes) as Record<string, unknown>;
	const exactCanonicalGenesisAnchorPreimageBytes = encodeCanonical({
		...anchor,
		parametersDigest: hex(hashDomain("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes)),
	});
	const anchorDigest = hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalGenesisAnchorPreimageBytes);
	return wireInvite({
		...valid,
		detachedGenesisSignature: ed25519.sign(anchorDigest, seed),
		exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes,
		pinnedGenesisAnchorDigest: hex(anchorDigest),
	});
}

const authenticate = (creatorInvite: string) => authenticateV3RoomCreatorInvite({ creatorInvite, application });

describe("the room's application state limit is a per-room authenticated creation parameter", () => {
	it("a room created without the setting keeps exactly the 32,768-byte limit", async () => {
		const material = await createV3RoomCreatorInviteMaterial(inviteInput(PARAMETERS));
		expect(authenticate(wireInvite(material)).maxApplicationStateBytes).toBe(DEFAULT_LIMIT);
	});

	it("a room created with a 128 KiB limit is read as 128 KiB by every member that authenticates its invite", async () => {
		const material = await createV3RoomCreatorInviteMaterial(
			inviteInput({ ...PARAMETERS, maxApplicationStateBytes: CEILING })
		);
		expect(authenticate(wireInvite(material)).maxApplicationStateBytes).toBe(CEILING);
		// The same signed invite, authenticated again (another member): the same value.
		expect(authenticate(wireInvite(material)).maxApplicationStateBytes).toBe(CEILING);
	});

	it("the creator refuses to build an invite whose limit is above the library ceiling or below the default", async () => {
		for (const maxApplicationStateBytes of [CEILING + 1, 8_388_608, DEFAULT_LIMIT - 1, 0]) {
			await expect(
				createV3RoomCreatorInviteMaterial(inviteInput({ ...PARAMETERS, maxApplicationStateBytes })),
				String(maxApplicationStateBytes)
			).rejects.toThrow(/application state limit/u);
		}
	});

	it("a member refuses a creator-signed invite whose limit is above the library ceiling", async () => {
		for (const maxApplicationStateBytes of [CEILING + 1, 8_388_608, DEFAULT_LIMIT - 1]) {
			const invite = await signedInviteWith({ ...PARAMETERS, maxApplicationStateBytes });
			expect(() => authenticate(invite), String(maxApplicationStateBytes)).toThrow(/application state limit/u);
		}
	});

	it("a member refuses an invite whose parameters carry any other unknown field", async () => {
		const invite = await signedInviteWith({ ...PARAMETERS, maxApplicationStateItems: 32_768 });
		expect(() => authenticate(invite)).toThrow(TypeError);
	});
});
