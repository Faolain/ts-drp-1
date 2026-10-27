/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
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
		/** Parent-owned directory for native process-death/reopen tests. */
		directory?: string;
		window?: V3RoomApplication["ordinaryFinishingWindow"];
		parameters?: Partial<typeof defaultParameters>;
		/** Non-creator Writers (default 1; row 60 R5 refusal case c uses 2). */
		writers?: number;
	}> = {}
) {
	const directory = options.directory ?? mkdtempSync(join(tmpdir(), "track-x-readiness-hold-"));
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
	/**
	 * The creator's invite material for an object of this room (its own, or a migration target's).
	 * @param inviteObjectId - The object id.
	 * @returns The signed invite material.
	 */
	const material = (inviteObjectId: string) =>
		createV3RoomCreatorInviteMaterial({
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
				objectId: inviteObjectId,
				permissionless: false,
				version: 3,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
			// Deliberately creator-trusted-settlement-v1: this fixture tests that profile's settlement,
			// whatever profile a shipped app signs; it does not mirror a shipped app.
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: "creator-trusted-settlement-v1",
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			objectId: inviteObjectId,
			signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
		});
	const invite = await material(objectId);
	const storageHost = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	const open = async (
		index: number,
		openOptions: Readonly<{
			reopen?: boolean;
			floor?: FloorHooks;
			/** Observes each projection the room reports (it may deliver rows; it changes nothing). */
			onProjection?: (peer: HookPeer) => void;
			/**
			 * This peer's own displacement policies (the trusted local room policy, not signed),
			 * replacing the application's for the given actions.
			 */
			policies?: Partial<V3RoomApplication["displacementPolicies"]>;
			/**
			 * Sees this peer's network node before its room session opens (for example, to bind a
			 * reopened creator to an existing successor link before its startup serving begins).
			 */
			onNetwork?: (networkNode: DRPNetworkNode) => void;
			/** Opens this peer on another object of the room (for example, a migration target). */
			room?: Readonly<{ invite: typeof invite; objectId: string }>;
			/**
			 * The test's own wrapper of this peer's storage host (for example, to inject a storage
			 * fault); unlike the hooks above, it may change results.
			 */
			host?: (host: V3RoomStorageHost) => V3RoomStorageHost;
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
		let retainedPublisher: ((targetPeerId?: string) => Promise<void>) | undefined;
		let topic: string | undefined;
		const retainedMessages = new WeakSet<Message>();
		const accepted = new Map<string, number>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(roster[index]).peerId, false);
		openOptions.onNetwork?.(networkNode);
		// A reopened peer reopens its existing stores; a store a later install creates (a new
		// plane's database) is created, as on the first open (the host's own filename scheme).
		const peerHost = openOptions.reopen
			? createNodeV3RoomStorageHost({
					directory,
					initialization: ({ name, family }) =>
						existsSync(
							join(
								directory,
								`${createHash("sha256")
									.update(JSON.stringify([family, name]))
									.digest("hex")}.sqlite`
							)
						)
							? "reopen"
							: "create",
				})
			: storageHost;
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			application:
				openOptions.policies === undefined
					? application
					: {
							...application,
							displacementPolicies: Object.freeze({
								...application.displacementPolicies,
								...openOptions.policies,
							}) as typeof application.displacementPolicies,
						},
			storageHost: openOptions.host === undefined ? peerHost : openOptions.host(peerHost),
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: {}),
			creatorInvite: openOptions.room?.invite ?? invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId: openOptions.room?.objectId ?? objectId,
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
					setRetainedPublisher: (publisher) => {
						retainedPublisher = publisher;
					},
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
		/**
		 * Hands a message another peer's room sent (for example, a retained republication caught at
		 * that peer's network node) to this peer's ingress, as the genuine transport would.
		 * @param message - The message.
		 * @param retained - Whether it arrives as retained history rather than gossip.
		 */
		const deliver = (message: Message, retained = false): void => {
			if (!retained) {
				required(ingress)(message);
				return;
			}
			retainedMessages.add(message);
			required(retainedIngress)(message);
		};
		/**
		 * Runs this peer's room's retained-history republication (what a history request triggers).
		 * @param targetPeerId - The requesting peer, or none for a gossip republication.
		 * @returns When the republication has been sent.
		 */
		const republish = (targetPeerId?: string): Promise<void> => required(retainedPublisher)(targetPeerId);
		return {
			index,
			name,
			room,
			floor: original,
			networkNode,
			accepted,
			inject,
			injectRetained,
			receive,
			deliver,
			republish,
		};
	};
	const stop = async (opened: Awaited<ReturnType<typeof open>>) => {
		await opened.room.close();
		rooms.delete(opened.room);
		await opened.floor.close();
		heads.delete(opened.floor);
	};
	const publishedAfter = async (index: number, after: number | null, scopeObjectId = objectId) => {
		const store = await storageHost.openIssuance(`peer-${index}`);
		try {
			const author = required(identities[index]).author;
			return await store.readOutboxPage({
				scope: { objectId: scopeObjectId, author },
				afterKey: after === null ? null : [scopeObjectId, author, after],
				limit: 128,
			});
		} finally {
			await store.close();
		}
	};
	return {
		identities,
		roster,
		application,
		objectId,
		invite,
		material,
		host: { storageHost },
		open,
		stop,
		publishedAfter,
	};
}

export type ReadinessHoldRoom = Awaited<ReturnType<typeof readinessHoldRoom>>;
export type ReadinessHoldPeer = Awaited<ReturnType<ReadinessHoldRoom["open"]>>;
