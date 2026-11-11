/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
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
import type { NodeRoomNetworkPort } from "../../../packages/node/src/room-network.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { directories, heads, hex, required, rooms } from "../track-m/room-retention-fixture.js";
import { memoryNetwork } from "../track-x/fence-delivery-room.js";

// Track AA: a creator and one or more Writers of a Grid zone room on the node SQLite host,
// every peer talking through the GENUINE room transport (`NodeRoomNetworkAdapter`) over Track
// X's in-memory network (`memoryNetwork`: asynchronous ordered delivery, gossip copies that
// `gossipTopicFor` reports, direct copies with one-use authenticated-stream evidence, and
// named losses). Nothing below the room transport is replaced: the plane's gossip queue, its
// input pool, authentication, the journal and the issuance store are the production owners.
//
// The only test control is `creatorGate`: the creator's application callback for an accepted
// vertex (`onAcceptedVertex`, awaited inside the plane's FIFO, v3-room.ts `commit`) can be
// held or slowed. That models a creator whose admission is slow (a migrated zone costs 3-6 s
// per received row, decision row 73) without touching any bound or admission check.
//
// Two profiles: "shipped" is the shipped Grid zone (`creator-trusted-v1`, latched ACL
// version 1); "settlement" is Track V's switch (`creator-trusted-settlement-v1`), where the
// creator admits every received row through its maintenance proof.

export type Profile = "shipped" | "settlement";

export const ROOM_PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

export const V3_VERTEX_DOMAIN = "ts-drp/vertex/v3";

/**
 * The digest the plane indexes a delivered envelope under (lower hex).
 * @param message
 */
export function envelopeDigest(message: Message): string | undefined {
	if (message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return undefined;
	try {
		return hex(hashDomain(V3_VERTEX_DOMAIN, V3Envelope.decode(message.data).canonicalPreimage));
	} catch {
		return undefined;
	}
}

/**
 * The signed vertex a delivered envelope carries.
 * @param message
 */
export function envelopeVertex(message: Message): Readonly<Record<string, unknown>> | undefined {
	if (message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return undefined;
	try {
		return decodeCanonical(V3Envelope.decode(message.data).canonicalPreimage) as Readonly<Record<string, unknown>>;
	} catch {
		return undefined;
	}
}

/** The admission gate on the creator's accepted-vertex callback. */
export function admissionGate() {
	let held: Promise<void> | undefined;
	let release: (() => void) | undefined;
	let delayMs = 0;
	let entered = 0;
	const waiters = new Set<() => void>();
	return {
		/** Hold every later accepted vertex until `release`. */
		hold(): void {
			if (held !== undefined) return;
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release(): void {
			const resolve = release;
			held = undefined;
			release = undefined;
			resolve?.();
		},
		/**
		 * Each accepted vertex then takes at least this long (0: no delay).
		 * @param ms
		 */
		slow(ms: number): void {
			delayMs = ms;
		},
		get entered(): number {
			return entered;
		},
		/**
		 * Resolves once at least `count` vertices have entered the gate; rejects after `timeoutMs`.
		 * @param count
		 * @param timeoutMs
		 */
		whenEntered(count: number, timeoutMs = 20_000): Promise<void> {
			if (entered >= count) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new TypeError(`TRACK_AA_GATE_NOT_ENTERED ${entered} of ${count}`));
				}, timeoutMs);
				const check = () => {
					if (entered < count) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve();
				};
				waiters.add(check);
			});
		},
		async pass(): Promise<void> {
			entered++;
			for (const waiter of [...waiters]) waiter();
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			while (held !== undefined) await held;
		},
	};
}

export interface RoomOptions {
	readonly profile?: Profile;
	/** Existing native directory for process-death recovery probes. */
	readonly directory?: string;
	/** Writers besides the creator. */
	readonly writers?: number;
	/** Optional genuine network boundary for native transport composition checks. */
	readonly network?: ReturnType<typeof memoryNetwork>;
	readonly peerIds?: readonly string[];
	onAccepted?(index: number, digest: string, author: string, vertex?: Readonly<{ epoch: number; operation: Readonly<Record<string, unknown>> }>): void;
	/** Extra session options for every opened peer (measurement harnesses, e.g. the scheduled lull). */
	readonly sessionOptions?: Readonly<Partial<CreateV3RoomSessionInput<unknown>>>;
}

/**
 * A Grid zone room with a creator (index 0) and Writers (1..n) on the genuine room transport.
 * @param options - Profile and Writer count.
 * @returns The room fixture.
 */
export async function creatorDeliveryRoom(options: RoomOptions = {}) {
	const profile = options.profile ?? "shipped";
	const writerCount = options.writers ?? 1;
	const directory = options.directory ?? mkdtempSync(join(tmpdir(), "track-aa-creator-delivery-"));
	directories.add(directory);
	const identities = Array.from({ length: writerCount + 1 }, (_, index) => {
		const seed = new Uint8Array(32).fill(0x31 + index);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	if (options.peerIds !== undefined && options.peerIds.length !== identities.length)
		throw new TypeError("TRACK_AA_PEER_COUNT_DIFFERS");
	const roster = identities.map(({ author }, order) => ({
		author,
		order,
		peerId: options.peerIds?.[order] ?? `track-aa-peer-${order}`,
	}));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("track-aa-creator-delivery-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const members = identities.map(({ author }, index) => ({
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
			version: profile === "shipped" ? 1 : 3,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(ROOM_PARAMETERS),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: profile === "shipped" ? "creator-trusted-v1" : "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const storageHost = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	const network = options.network ?? memoryNetwork();
	const creatorGate = admissionGate();
	const accepted = new Map<number, Set<string>>();
	const nodes = new Map<string, DRPNetworkNode>();
	const ports = new Map<number, NodeRoomNetworkPort>();
	// Every distinct envelope a peer sent (gossip or direct), by digest, in first-send order.
	const sent = new Map<string, Map<string, Message>>();
	network.observe(({ from, message }) => {
		const digest = envelopeDigest(message);
		if (digest === undefined) return;
		let byDigest = sent.get(from);
		if (byDigest === undefined) sent.set(from, (byDigest = new Map()));
		if (!byDigest.has(digest)) byDigest.set(digest, message);
	});
	let creatorRoom: Awaited<ReturnType<typeof createV3RoomSession>> | undefined;
	const open = async (index: number, openOptions: Readonly<{ reopen?: true }> = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const peerId = required(roster[index]).peerId;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		const { network: networkNode, adapter } = network.node(peerId);
		nodes.set(peerId, networkNode);
		const seen = new Set<string>();
		accepted.set(index, seen);
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
			onAcceptedVertex: async (vertex) => {
				seen.add(hex(vertex.digest));
				options.onAccepted?.(index, hex(vertex.digest), vertex.author, vertex);
				if (index === 0) await creatorGate.pass();
			},
			// The genuine room transport, as `DRPNode.openRoomNetwork` opens it (the creator
			// routing hint is the creator's transport identity).
			openTransport: (id) => {
				const port = adapter.open(
					id,
					required(roster[0]).peerId,
					() => Promise.resolve(),
					() => undefined
				);
				ports.set(index, port);
				return port;
			},
			...(options.sessionOptions as object | undefined),
		};
		const room = await createV3RoomSession(input);
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		if (index === 0) creatorRoom = room;
		// Decision B (sync before sending): a reopened Writer signs nothing until it is current. The
		// pages' successor delivery hands it the creator's statement on bind; this fixture does it.
		else if (openOptions.reopen === true && creatorRoom !== undefined && rooms.has(creatorRoom)) {
			const statement = creatorRoom.currencyStatement?.();
			if (statement !== undefined) await room.confirmCurrent?.(statement);
		}
		return { index, name, peerId, room, floor, networkNode, adapter, accepted: seen };
	};
	/**
	 * A bare network identity with no room: it can gossip and send direct copies.
	 * @param peerId
	 */
	const bare = (peerId: string) => {
		const { network: networkNode } = network.node(peerId);
		nodes.set(peerId, networkNode);
		return networkNode;
	};
	/**
	 * The envelopes a peer sent, in first-send order, optionally only its own authored rows.
	 * @param peerId - The sending peer.
	 * @param author - Only rows signed by this author.
	 * @returns Digest and message pairs.
	 */
	const sentBy = (peerId: string, author?: string) =>
		[...(sent.get(peerId)?.entries() ?? [])]
			.filter(([, message]) => author === undefined || envelopeVertex(message)?.author === author)
			.map(([digest, message]) => Object.freeze({ digest, message }));
	return {
		directory,
		host: { storageHost },
		profile,
		identities,
		roster,
		application,
		objectId,
		invite,
		network,
		nodes,
		ports,
		accepted,
		creatorGate,
		open,
		bare,
		sentBy,
		clearObservations: () => {
			sent.clear();
			for (const seen of accepted.values()) seen.clear();
		},
	};
}

export type CreatorDeliveryRoom = Awaited<ReturnType<typeof creatorDeliveryRoom>>;

/**
 * A v3 envelope message on the room topic, as a peer would send it.
 * @param topic - The room's live topic (the ingress identity).
 * @param data - Exact envelope bytes.
 * @param sender - The sending peer.
 * @returns The message.
 */
export function envelopeMessage(topic: string, data: Uint8Array, sender: string): Message {
	return Message.create({ data, objectId: topic, sender, type: MessageType.MESSAGE_TYPE_V3_ENVELOPE });
}

/**
 * The room's live topic: the objectId every delivered envelope carries.
 * @param fixture
 * @param peerId
 */
export function liveTopicOf(fixture: CreatorDeliveryRoom, peerId: string): string {
	const message = [...fixture.sentBy(peerId)].at(0)?.message;
	if (message === undefined) throw new TypeError("TRACK_AA_LIVE_TOPIC_UNKNOWN");
	return message.objectId;
}

/**
 * The exact gossip-queue charge routeV3Ingress takes for one message (v3-live.ts).
 * @param message
 */
export function gossipQueueCharge(message: Message): number {
	return (
		message.data.byteLength * 2 +
		encodeCanonical({ sender: message.sender, objectId: message.objectId, type: message.type }).byteLength
	);
}

/**
 * The room transport's existing retained-history request (room-network.ts HISTORY_REQUEST on
 * the room's history control topic), exactly as `#performRequest` builds it.
 * @param objectId - The room's durable identity.
 * @param sender - The requesting peer.
 * @returns The request message.
 */
export function historyRequestMessage(objectId: string, sender: string): Message {
	const domain = new TextEncoder().encode("ts-drp-room-history-request-v1\u0000");
	const controlId = `/ts-drp/room-history/1/${createHash("sha256").update(domain).update(new TextEncoder().encode(objectId)).digest("hex")}`;
	return Message.create({
		data: new TextEncoder().encode("ts-drp-room-history-request-v1"),
		objectId: controlId,
		sender,
		type: MessageType.MESSAGE_TYPE_CUSTOM,
	});
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until a predicate holds or a deadline passes.
 * @param predicate - The condition.
 * @param timeoutMs - The deadline.
 * @param intervalMs - Poll interval.
 * @returns Whether it held in time.
 */
export async function eventually(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() > deadline) return false;
		await sleep(intervalMs);
	}
}
