/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { AheRetirementControl } from "@ts-drp/storage";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { directories, heads, hex, required, rooms } from "../track-m/room-retention-fixture.js";
import {
	settlementDelivery,
	settlementRoom,
	type SettlementRoom,
	settlementTransition,
} from "../track-m/settlement-room.js";

// Track S: Track N's Grid composition (Grid zone application, creator-trusted-settlement-v1,
// the creator and one Writer recipient issuing every epoch, scripted native-byte successor
// transport) with Grid's LULL=1 order (gameplay, seal, adoption, install, then the creator's
// and the recipient's pool-maintenance lull), persisted close and reopen of both peers right
// after the creator's FIRST maintained lull, then continued gameplay and seals.
//
// Three hosts:
// - "sqlite": the node SQLite host (`createNodeV3RoomStorageHost`), as Track N's test;
// - "room": the browser room-database host on fake-indexeddb (Track M's settlement room,
//   which needs the FIFO process lock manager of R3's tests: `installEnvironment`);
// - "room-retention": the same host with `roomRetention: true` (Tracks M and O).

const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

export type GridHost = "sqlite" | "room" | "room-retention";

/**
 * Track N's settlement room on the node SQLite host, in the shape of Track M's
 * settlement room so that its genuine successor delivery and transition drive it. A
 * persisted reopen recreates every owner over the SAME databases and external floor.
 * @returns The room fixture.
 */
async function sqliteSettlementRoom() {
	const directory = mkdtempSync(join(tmpdir(), "track-s-first-lull-"));
	directories.add(directory);
	const identities = [0x71, 0x72].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `track-s-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("track-s-first-lull-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const storageHost = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	let creatorRoom: Awaited<ReturnType<typeof createV3RoomSession>> | undefined;
	const open = async (index: number, openOptions: { reopen?: boolean } = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(roster[index]).peerId, false);
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			application,
			storageHost: openOptions.reopen
				? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" })
				: storageHost,
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: {}),
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				accepted.add(digest);
				acknowledged.get(digest)?.();
			},
			openTransport: () => {
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: () => {
						throw new TypeError("TRACK_S_EPHEMERAL_UNUSED");
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
		if (index === 0) creatorRoom = room;
		// Decision B (sync before sending): a reopened Writer signs nothing until it is current. The
		// pages' successor delivery hands it the creator's statement on bind; this fixture does it.
		else if (openOptions.reopen && creatorRoom !== undefined && rooms.has(creatorRoom)) {
			const statement = creatorRoom.currencyStatement?.();
			if (statement !== undefined) await room.confirmCurrent?.(statement);
		}
		// Authenticated signed rows of another peer, in issue order; the final ordinary
		// move's application acceptance joins the delivery.
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("TRACK_S_REMOTE_ADMISSION_TIMEOUT")), 60_000);
			});
			try {
				for (const row of rows)
					required(ingress)(
						Message.create({
							objectId: required(topic),
							sender: required(roster[sender]).peerId,
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							data: V3Envelope.encode({
								canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
								signature: row.commit.envelope.signature,
							}).finish(),
						})
					);
				await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		return { index, name, room, floor, networkNode, receive };
	};
	const stop = async (opened: Awaited<ReturnType<typeof open>>) => {
		await opened.room.close();
		rooms.delete(opened.room);
		await opened.floor.close();
		heads.delete(opened.floor);
	};
	const publishedAfter = async (index: number, after: number | null) => {
		const store = await storageHost.openIssuance(`peer-${index}`);
		try {
			const author = required(identities[index]).author;
			const rows = await store.readOutboxPage({
				scope: { objectId, author },
				afterKey: after === null ? null : [objectId, author, after],
				limit: 128,
			});
			if (!rows.every((row) => row.publishState === "published")) throw new TypeError("TRACK_S_UNPUBLISHED_ROW");
			return rows;
		} finally {
			await store.close();
		}
	};
	return { identities, roster, application, objectId, invite, host: { storageHost }, open, stop, publishedAfter };
}

/**
 * The Grid composition on one host.
 * @param host - The storage host under test.
 * @param name - Fixed per test, so a room-database host keeps its own databases.
 * @returns A settlement room: open, stop, publishedAfter and the genuine owners.
 */
export async function gridRoom(host: GridHost, name: string): Promise<SettlementRoom> {
	if (host !== "sqlite") return settlementRoom({ retention: host === "room-retention", name });
	// Structurally the settlement room that `settlementDelivery` and `settlementTransition`
	// read: identities, roster, application, objectId, invite, host.storageHost (openAhe,
	// openSnapshots, openIssuance), open, stop and publishedAfter. The room-database-only
	// observation members (database, host.opened and so on) are never read for this host.
	return (await sqliteSettlementRoom()) as unknown as SettlementRoom;
}

type Opened = Awaited<ReturnType<SettlementRoom["open"]>>;
type Lull = Awaited<ReturnType<Opened["room"]["maintainRecoveryPool"]>>;
export interface LullRecord {
	readonly epoch: number;
	readonly creator: Lull;
	readonly recipient: Lull;
}

/**
 * One Grid LULL=1 rollover: Track N's transition (two ordinary moves per Writer, each
 * delivered before the next; seal; adoption; install), then the creator's and the
 * recipient's lull at the new epoch.
 * @returns Both lull outcomes at the new epoch.
 */
export async function lullRollover(
	fixture: SettlementRoom,
	peers: readonly [Opened, Opened],
	delivered: (number | null)[],
	epoch: number
): Promise<LullRecord> {
	await settlementTransition(fixture, peers, delivered, epoch);
	const [creator, recipient] = peers;
	expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
	expect(recipient.room.projection()).toEqual(creator.room.projection());
	return {
		epoch: epoch + 1,
		creator: await creator.room.maintainRecoveryPool(),
		recipient: await recipient.room.maintainRecoveryPool(),
	};
}

/**
 * One more ordinary move by each Writer, each delivered to the other before the next.
 */
export async function playOneMoveEach(
	fixture: SettlementRoom,
	peers: readonly [Opened, Opened],
	delivered: (number | null)[],
	tag: string
): Promise<void> {
	for (const index of [0, 1]) {
		await required(peers[index]).room.issue({
			action: "placeBlock",
			id: `${tag}-${index}`,
			kind: "stone",
			x: 99,
			y: index,
		});
		const rows = await fixture.publishedAfter(index, delivered[index] ?? null);
		await required(peers[1 - index]).receive(rows, index);
		delivered[index] = required(rows.at(-1)).commit.authorSequence;
	}
	expect(required(peers[1]).room.projection()).toEqual(required(peers[0]).room.projection());
}

/** The creator's AHE retirement control (native observation only, never a grant). */
export async function creatorRetirementControl(fixture: SettlementRoom): Promise<AheRetirementControl | null> {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("TRACK_S_INVALID_OBJECT");
	const store = await fixture.host.storageHost.openAhe("peer-0--ahe");
	try {
		if (store.readRetirementControl === undefined) throw new TypeError("TRACK_S_RETIREMENT_CONTROL_UNAVAILABLE");
		const result = await store.readRetirementControl(object.value);
		if (!result.ok) throw new TypeError(`TRACK_S_RETIREMENT_CONTROL_${result.kind}`);
		return result.value;
	} finally {
		await store.close();
	}
}

export { settlementDelivery };
