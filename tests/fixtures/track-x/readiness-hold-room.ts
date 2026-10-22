/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomApplication,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { directories, heads, hex, required, rooms } from "../track-m/room-retention-fixture.js";

// Track X (decision row 51): Track S's settlement room on the node SQLite host (Grid zone
// application, creator-trusted-settlement-v1, the creator and one Writer, manual delivery of
// signed rows, persisted close and reopen over the same databases and external floor), with
// two observation points: each peer's external floor (the room head authority, which is also
// the creator's settlement whole-floor) can be observed when it is read or reserved, and each
// projection the room reports can be observed (row 60). The hooks observe and may delay or
// deliver rows; they never change an argument or a result. Rows can be
// delivered as gossip (through the plane's message queue) or as retained history (straight
// to the plane's input pool), as the genuine room transport delivers them.

const defaultParameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

type Room = Awaited<ReturnType<typeof createV3RoomSession>>;

export interface HookPeer {
	/** Hands signed rows of another peer to the opening peer's gossip ingress at once. */
	inject(rows: readonly DurableIssuanceOutboxRecord[], sender: number): void;
	/** Hands signed rows of another peer to the opening peer's retained ingress at once. */
	injectRetained(rows: readonly DurableIssuanceOutboxRecord[], sender: number): void;
	/** The opening peer's session, once `createV3RoomSession` has returned it. */
	readonly session: Promise<Room>;
}

export interface FloorHooks {
	/** Before the floor's native read reservation is acquired; the acquisition waits for it. */
	beforeReserve?(stack: string, peer: HookPeer): Promise<void> | void;
	/** When the floor's retirement image is read (the read itself is not delayed). */
	onReadImage?(stack: string): void;
}

/**
 * The calling stack, 60 frames deep (async frames included).
 * @returns The stack text.
 */
export const stackHere = (): string => {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	const stack = new Error("floor").stack ?? "";
	Error.stackTraceLimit = limit;
	return stack;
};

/**
 * The settlement room on the node SQLite host.
 * @param options - An optional host-local finishing window for every peer's application, and
 * parameter overrides carried by the invite.
 * @returns The room fixture.
 */
export async function readinessHoldRoom(
	options: Readonly<{
		window?: V3RoomApplication["ordinaryFinishingWindow"];
		parameters?: Partial<typeof defaultParameters>;
		/** Non-creator Writers (default 1; row 60 R5 refusal case c uses 2). */
		writers?: number;
	}> = {}
) {
	const directory = mkdtempSync(join(tmpdir(), "track-x-readiness-hold-"));
	directories.add(directory);
	const identities = Array.from({ length: 1 + (options.writers ?? 1) }, (_, index) => 0x91 + index).map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `track-x-hold-peer-${order}` }));
	const zone = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const application: typeof zone =
		options.window === undefined ? zone : { ...zone, ordinaryFinishingWindow: options.window };
	const parameters = Object.freeze({ ...defaultParameters, ...options.parameters });
	const objectId = `creator:${hex(hashDomain("track-x-readiness-hold-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const open = async (
		index: number,
		openOptions: Readonly<{
			reopen?: boolean;
			floor?: FloorHooks;
			/** Observes each projection the room reports (it may deliver rows; it changes nothing). */
			onProjection?: (peer: HookPeer) => void;
		}> = {}
	) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const original = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		heads.add(original);
		let resolveSession!: (room: Room) => void;
		const session = new Promise<Room>((resolve) => {
			resolveSession = resolve;
		});
		const hookPeer: HookPeer = {
			inject: (rows, sender) => inject(rows, sender),
			injectRetained: (rows, sender) => injectRetained(rows, sender),
			session,
		};
		const hooks = openOptions.floor;
		const floor: typeof original =
			hooks === undefined
				? original
				: Object.freeze({
						...original,
						acquireNativeReadReservation: async (...args: Parameters<typeof original.acquireNativeReadReservation>) => {
							await hooks.beforeReserve?.(stackHere(), hookPeer);
							return original.acquireNativeReadReservation(...args);
						},
						readRetirementImage: (...args: Parameters<typeof original.readRetirementImage>) => {
							hooks.onReadImage?.(stackHere());
							return original.readRetirementImage(...args);
						},
					});
		let ingress: ((message: Message) => void) | undefined;
		let retainedIngress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const retainedMessages = new WeakSet<Message>();
		const accepted = new Map<string, number>();
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
			onProjection: () => openOptions.onProjection?.(hookPeer),
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				if (!accepted.has(digest)) accepted.set(digest, performance.now());
				acknowledged.get(digest)?.();
			},
			openTransport: () => {
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) =>
					retainedMessages.has(message) ? undefined : message.objectId
				);
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: () => {
						throw new TypeError("TRACK_X_HOLD_EPHEMERAL_UNUSED");
					},
					requestRetainedHistory: () => undefined,
					setRetainedPublisher: () => undefined,
					setIngressHandler: (selectedTopic, live, retained) => {
						topic = selectedTopic;
						ingress = live;
						retainedIngress = retained;
					},
				};
			},
		};
		const envelope = (row: DurableIssuanceOutboxRecord, sender: number) =>
			Message.create({
				objectId: required(topic),
				sender: required(roster[sender]).peerId,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				data: V3Envelope.encode({
					canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
					signature: row.commit.envelope.signature,
				}).finish(),
			});
		/**
		 * Hands signed rows of another peer to this peer's gossip ingress, in order, and returns
		 * at once (nothing waits for admission).
		 * @param rows - Signed rows of the sender.
		 * @param sender - The sender's index.
		 */
		const inject = (rows: readonly DurableIssuanceOutboxRecord[], sender: number): void => {
			for (const row of rows) required(ingress)(envelope(row, sender));
		};
		/**
		 * Hands signed rows of another peer to this peer's retained ingress (a history reply), in
		 * order, and returns at once.
		 * @param rows - Signed rows of the sender.
		 * @param sender - The sender's index.
		 */
		const injectRetained = (rows: readonly DurableIssuanceOutboxRecord[], sender: number): void => {
			for (const row of rows) {
				const message = envelope(row, sender);
				retainedMessages.add(message);
				required(retainedIngress)(message);
			}
		};
		const room = await createV3RoomSession(input);
		rooms.add(room);
		resolveSession(room);
		await waitForV3RoomStartupForDiagnostics(room);
		/**
		 * Delivers signed rows of another peer and waits until the last one is accepted.
		 * @param rows - Signed rows of the sender, in issue order.
		 * @param sender - The sender's index.
		 */
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("TRACK_X_HOLD_ADMISSION_TIMEOUT")), 60_000);
			});
			try {
				inject(rows, sender);
				await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		return { index, name, room, floor: original, networkNode, accepted, inject, injectRetained, receive };
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
			return await store.readOutboxPage({
				scope: { objectId, author },
				afterKey: after === null ? null : [objectId, author, after],
				limit: 128,
			});
		} finally {
			await store.close();
		}
	};
	return { identities, roster, application, objectId, invite, host: { storageHost }, open, stop, publishedAfter };
}

export type ReadinessHoldRoom = Awaited<ReturnType<typeof readinessHoldRoom>>;
export type ReadinessHoldPeer = Awaited<ReturnType<ReadinessHoldRoom["open"]>>;
