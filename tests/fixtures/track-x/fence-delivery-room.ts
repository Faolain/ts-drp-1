/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { DRP_MESSAGE_PROTOCOL, DRPNetworkNode as GenuineNetworkNode } from "@ts-drp/network";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { NodeEphemeralAdapter } from "../../../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter } from "../../../packages/node/src/room-network.js";
import { routeV3Ingress } from "../../../packages/node/src/v3-live.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { directories, heads, hex, required, rooms } from "../track-m/room-retention-fixture.js";
import type { SettlementRoom } from "../track-m/settlement-room.js";

// Track X: the creator-trusted-settlement-v1 room of Track S (Grid zone application, the
// creator and one recipient, node SQLite host, Track N's scripted native-byte successor
// transfer), but every peer talks through the GENUINE room transport
// (`NodeRoomNetworkAdapter`, packages/node/src/room-network.ts) over a two-peer in-memory
// network, routed exactly as `DRPNode.dispatchMessage` routes (room network first, then
// `routeV3Ingress`):
// - `publishMessage` is gossip: every other peer receives its own copy, which
//   `gossipTopicFor` reports on the message's topic;
// - `sendMessage` is a direct authenticated stream: the copy carries one-use
//   `authenticated-stream` evidence (`claimIngressEvidence`) and no gossip topic.
// Delivery is asynchronous and in order. Nothing is dropped, reordered or replayed by the
// network itself unless a test names a delivery to lose (`lose`), and no peer-connection
// events are emitted after setup (the shipped browser pages see none after their first
// connections either).
//
// The recipient is either a Writer (in the latched ACL, as Grid's players under Track V's
// switch) or a receive-only observer (outside the ACL, as every joiner of the shipped Canvas
// and Chat pages).

const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

export type RecipientRole = "writer" | "observer";

export interface MemoryNetworkOptions {
	/**
	 * Gossip through the GENUINE `DRPNetworkNode.publishMessage` (packages/network/src/node.ts)
	 * over this network: it waits for a subscriber on the topic (`waitForSubscriber`, at most
	 * 1000 ms per publication by default) and then publishes to the peers subscribed to the
	 * topic only; with none, the publication succeeds and reaches no one
	 * (`allowPublishToZeroTopicPeers`). `subscriberWaitMs` replaces the 1000 ms bound, to
	 * model a first subscriber that arrives later than one bound.
	 * Without this option a publication reaches every peer at once (the original fixture).
	 */
	readonly genuinePublication?: Readonly<{ subscriberWaitMs?: number }>;
}

/** One completed genuine gossip publication (`genuinePublication` only). */
export interface Publication {
	readonly from: string;
	readonly started: number;
	readonly completed: number;
	/** The peers subscribed to the topic when the publication completed. */
	readonly recipients: readonly string[];
	readonly sequence: unknown;
	readonly action: unknown;
}

export interface Delivery {
	readonly kind: "gossip" | "direct";
	readonly from: string;
	readonly to: string;
	readonly message: Message;
}

type Evidence = Readonly<{
	message: Readonly<{ data: Uint8Array; objectId: string; sender: string; type: MessageType }>;
	transport: Readonly<{ kind: "authenticated-stream"; protocol: string; sender: string }>;
}>;

/**
 * A two-peer in-memory network under the genuine room transport.
 * @param options - How a publication reaches the other peers.
 * @returns The network: `node` registers one peer, `idle` joins every delivery in flight.
 */
export function memoryNetwork(options: MemoryNetworkOptions = {}) {
	const nodes = new Map<string, Readonly<{ network: DRPNetworkNode; adapter: NodeRoomNetworkAdapter }>>();
	const gossip = new WeakSet<Message>();
	const evidence = new WeakMap<Message, Evidence>();
	const inFlight = new Set<Promise<void>>();
	const observers = new Set<(delivery: Delivery) => void>();
	const losses = new Set<(delivery: Delivery) => boolean>();
	const publications: Publication[] = [];
	let tail = Promise.resolve();
	const deliver = (kind: Delivery["kind"], from: string, to: string, message: Message) => {
		const target = nodes.get(to);
		if (target === undefined) return;
		const received = Message.decode(Message.encode(message).finish());
		if (kind === "gossip") gossip.add(received);
		else
			evidence.set(received, {
				message: { data: received.data.slice(), objectId: received.objectId, sender: from, type: received.type },
				transport: { kind: "authenticated-stream", protocol: DRP_MESSAGE_PROTOCOL, sender: from },
			});
		const job = (tail = tail.then(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						try {
							const delivery = { kind, from, to, message: received };
							for (const observe of observers) observe(delivery);
							if ([...losses].some((lost) => lost(delivery))) return;
							if (!target.adapter.route(received)) routeV3Ingress(target.network, received);
						} finally {
							resolve();
						}
					}, 1)
				)
		));
		inFlight.add(job);
		void job.finally(() => inFlight.delete(job));
	};
	const genuinePublisher = (peerId: string, publication: NonNullable<MemoryNetworkOptions["genuinePublication"]>) => {
		const genuine = new GenuineNetworkNode({
			bootstrap_peers: [],
			listen_addresses: [],
			log_config: { level: "silent" },
		});
		const subscribers = (topic: string) =>
			[...nodes.entries()]
				.filter(([id, peer]) => id !== peerId && peer.network.getSubscribedTopics().includes(topic))
				.map(([id]) => id);
		Reflect.set(genuine, "_pubsub", {
			getSubscribers: (topic: string) => subscribers(topic).map((id) => ({ toString: () => id })),
			streamsOutbound: { has: (id: string) => nodes.has(id) },
			publish: (topic: string, bytes: Uint8Array) => {
				const message = Message.decode(bytes);
				for (const id of subscribers(topic)) deliver("gossip", peerId, id, message);
				return Promise.resolve({ recipients: [] });
			},
		});
		const bound = publication.subscriberWaitMs;
		if (bound !== undefined) {
			const waitForSubscriber = Reflect.get(GenuineNetworkNode.prototype, "waitForSubscriber") as (
				topic: string,
				timeout: number
			) => Promise<void>;
			Reflect.set(genuine, "waitForSubscriber", (topic: string) =>
				Reflect.apply(waitForSubscriber, genuine, [topic, bound])
			);
		}
		return async (topic: string, message: Message) => {
			const started = performance.now();
			const result = await genuine.publishMessage(topic, message);
			const vertex = deliveredVertex(message);
			publications.push(
				Object.freeze({
					from: peerId,
					started,
					completed: performance.now(),
					recipients: Object.freeze(subscribers(topic)),
					sequence: vertex?.authorSequence,
					action: (vertex?.operation as Readonly<Record<string, unknown>> | undefined)?.action,
				})
			);
			return result;
		};
	};
	const node = (peerId: string) => {
		const network = fakeNetwork(peerId, false);
		Object.assign(network, {
			getAllPeers: () => [...nodes.keys()].filter((id) => id !== peerId),
			publishMessage:
				options.genuinePublication === undefined
					? (_topic: string, message: Message) => {
							for (const id of nodes.keys()) if (id !== peerId) deliver("gossip", peerId, id, message);
							return Promise.resolve(true);
						}
					: genuinePublisher(peerId, options.genuinePublication),
			sendMessage: (target: string, message: Message) => {
				if (!nodes.has(target) || target === peerId) return Promise.reject(new Error("TRACK_X_PEER_UNREACHABLE"));
				deliver("direct", peerId, target, message);
				return Promise.resolve();
			},
			gossipTopicFor: (message: Message) => (gossip.has(message) ? message.objectId : undefined),
			claimIngressEvidence: (message: Message) => {
				const value = evidence.get(message);
				evidence.delete(message);
				return value;
			},
		});
		const adapter = new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, null));
		nodes.set(peerId, Object.freeze({ network, adapter }));
		return Object.freeze({ network, adapter });
	};
	return {
		node,
		observe: (observer: (delivery: Delivery) => void) => {
			observers.add(observer);
			return () => observers.delete(observer);
		},
		/**
		 * Lose every delivery the predicate selects (observers still see it) until removed.
		 * @param predicate - Selects the deliveries to lose.
		 * @returns Remove the loss.
		 */
		lose: (predicate: (delivery: Delivery) => boolean) => {
			losses.add(predicate);
			return () => losses.delete(predicate);
		},
		/** Every completed genuine gossip publication, in completion order. */
		publications: publications as readonly Publication[],
		idle: async () => {
			while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		},
	};
}

/**
 * The signed vertex a delivered v3 envelope carries.
 * @param message - A delivered message.
 * @returns The decoded vertex preimage, or undefined for any other message.
 */
export function deliveredVertex(message: Message): Readonly<Record<string, unknown>> | undefined {
	if (message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return undefined;
	try {
		const envelope = V3Envelope.decode(message.data);
		return decodeCanonical(envelope.canonicalPreimage) as Readonly<Record<string, unknown>>;
	} catch {
		return undefined;
	}
}

/**
 * Track S's settlement room on the node SQLite host, with the genuine room transport.
 * Structurally the settlement room that Track M's `settlementDelivery` reads.
 * @param role - The recipient's role.
 * @param networkOptions - How a publication reaches the other peers (memoryNetwork).
 * @returns The room fixture.
 */
export async function fenceDeliveryRoom(role: RecipientRole, networkOptions: MemoryNetworkOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "track-x-fence-delivery-"));
	directories.add(directory);
	const identities = [0x71, 0x72].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `track-x-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("track-x-fence-delivery-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const members = (role === "writer" ? identities : [creator]).map(({ author }, index) => ({
		author,
		finalityKey: index === 0 ? author : null,
		groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
	}));
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: members.sort((left, right) => left.author.localeCompare(right.author)),
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
	const network = memoryNetwork(networkOptions);
	const open = async (index: number, { awaitStartup = true }: Readonly<{ awaitStartup?: boolean }> = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const peerId = required(roster[index]).peerId;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: "create" },
		});
		heads.add(floor);
		const { network: networkNode, adapter } = network.node(peerId);
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			application,
			storageHost,
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: role === "observer"
					? { receiveOnly: true as const }
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
			onAcceptedVertex: () => undefined,
			// The genuine room transport, as `DRPNode.openRoomNetwork` opens it (the creator
			// routing hint is the creator's transport identity here).
			openTransport: (id) =>
				adapter.open(
					id,
					required(roster[0]).peerId,
					() => Promise.resolve(),
					() => undefined
				),
		};
		const room = await createV3RoomSession(input);
		rooms.add(room);
		if (awaitStartup) await waitForV3RoomStartupForDiagnostics(room);
		return { index, name, room, floor, networkNode };
	};
	return {
		identities,
		roster,
		application,
		objectId,
		invite,
		host: { storageHost },
		network,
		open,
	};
}

export type FenceDeliveryRoom = Awaited<ReturnType<typeof fenceDeliveryRoom>>;

/**
 * Track M's `settlementDelivery` reads only the settlement room members this room has.
 * @param fixture - The fence delivery room.
 * @returns The same room, typed as Track M's settlement room.
 */
export const asSettlementRoom = (fixture: FenceDeliveryRoom) => fixture as unknown as SettlementRoom;
