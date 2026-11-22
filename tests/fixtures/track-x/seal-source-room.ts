/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { Message, MessageType } from "@ts-drp/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createBrowserV3RoomDatabaseStorageHost,
	createBrowserV3SixDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { directories, heads, hex, required, rooms } from "../track-m/room-retention-fixture.js";

// Track X: a settlement creator (creator-trusted-settlement-v1, the Grid zone application, as
// the shipped pages) alone on a browser storage host (fake-indexeddb: mechanism evidence
// only), with the genuine room session. `host` selects the six-database host (passed
// explicitly since Track Z made it a non-default) or the room-database host. The fixture
// records every vertex the creator publishes and can deliver a copy of one back to the
// creator, as a recipient's retained-history push does in the shipped pages.

export type SealSourceHost = "six-database" | "room-database";

const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

/**
 * Opens the settlement creator on the selected browser host.
 * @param host - The default six-database host or the room-database host.
 * @returns The creator's room, its floor, the vertices it published and `echo`.
 */
export async function sealSourceRoom(host: SealSourceHost) {
	const directory = mkdtempSync(join(tmpdir(), "track-x-seal-source-"));
	directories.add(directory);
	const tag = hex(hashDomain("track-x-seal-source/v1", new TextEncoder().encode(directory))).slice(0, 16);
	const identities = [0x81, 0x82].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `track-x-seal-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("track-x-seal-source-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: identities
				.map(({ author }, index) => ({
					author,
					finalityKey: index === 0 ? author : null,
					groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
				}))
				.sort((left, right) => left.author.localeCompare(right.author)),
			objectId,
			permissionless: false,
			version: 3,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const floor = createNodeRoomHeadAuthority({
		filename: join(directory, "creator-external-floor.sqlite"),
		initialization: { kind: "create" },
	});
	heads.add(floor);
	let ingress: ((message: Message) => void) | undefined;
	let topic: string | undefined;
	const published: Message[] = [];
	const networkNode = fakeNetwork(required(roster[0]).peerId, false);
	Reflect.set(networkNode, "publishMessage", (_topic: string, message: Message) => {
		if (message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) published.push(message);
		return Promise.resolve(true);
	});
	const name = `tx-seal-${tag}-creator`;
	const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
		application,
		storageHost:
			host === "room-database" ? createBrowserV3RoomDatabaseStorageHost() : createBrowserV3SixDatabaseStorageHost(),
		author: creator.author,
		creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer,
		creatorInvite: invite,
		databaseName: name,
		issuanceDatabaseName: name,
		migrationDatabaseNamespace: name,
		initialLogicalTime: 3,
		objectId,
		publicKeyBytes: ed25519.getPublicKey(creator.seed),
		roomHeadAuthority: floor,
		signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
		onProjection: () => undefined,
		onAcceptedVertex: () => undefined,
		openTransport: () => {
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			return {
				networkNode,
				close: () => undefined,
				openEphemeral: () => {
					throw new TypeError("TRACK_X_SEAL_SOURCE_EPHEMERAL_UNUSED");
				},
				requestRetainedHistory: () => undefined,
				setRetainedPublisher: () => undefined,
				setIngressHandler: (selectedTopic, handler) => {
					topic = selectedTopic;
					ingress = handler;
				},
			};
		},
	};
	const room = await createV3RoomSession(input);
	rooms.add(room);
	await waitForV3RoomStartupForDiagnostics(room);
	/**
	 * Delivers a copy of a vertex the creator published back to the creator, from the other
	 * peer, as a recipient's retained-history push does: an ingress of a vertex the creator
	 * already accepted.
	 * @param message - One published V3 envelope message.
	 * @returns Nothing; the creator handles the copy as any ingress.
	 */
	const echo = (message: Message): void =>
		required(ingress)(
			Message.create({
				objectId: required(topic),
				sender: required(roster[1]).peerId,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				data: message.data,
			})
		);
	return { objectId, room, floor, published, echo, databaseName: name };
}

export type SealSourceRoom = Awaited<ReturnType<typeof sealSourceRoom>>;
