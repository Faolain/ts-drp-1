/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openShippingChatCatalogs, type ShippingChatCatalogs } from "../../../examples/chat/src/chat-catalogs.js";
import {
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../../../examples/chat/src/v3-chat-application.js";
import { openNodeShippingChatArchiveStore } from "../../../examples/chat/src/v3-chat-archive-sqlite.js";
import {
	openShippingChatLocalArchive,
	type ShippingChatLocalArchive,
} from "../../../examples/chat/src/v3-chat-archive.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { roomStoreCensus } from "../chat-rolling-window/chat-long-room.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";

// Track W2: the shipped Chat composition (creator-trusted-settlement-v1, ACL version 3, the
// shipped admission policy, a shipped catalog) on genuine SQLite, Ed25519 and room owners, with
// scripted native-byte transport, for rooms whose membership changes: peer 0 is the creator
// (admin, finality, writer); every other peer is either a genesis Writer or a late joiner
// outside the genesis ACL, which opens receive-only until it is granted Writer. Late
// joiners and departed members are the point, so nothing here assumes the genesis roster is
// the current one. Observation helpers (census, export read) open their own handles and grant
// nothing.

/** Lower-case hex of bytes. */
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
/**
 * The value, or a fixture failure when it is missing.
 * @param value - A value the fixture needs.
 * @returns The value.
 */
export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("CHAT_SHARES_REQUIRED_FIXTURE_VALUE");
	return value;
}

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

/**
 * "genesis": a genesis Writer; "genesis-admin": a genesis Writer that is also an admin (it stays a
 * member when only `writer` is revoked); "late": outside the genesis ACL (opens receive-only).
 * Peer 0 is the creator.
 */
export type ChatSharesMember = "genesis" | "genesis-admin" | "late";

export interface ChatSharesRoomOptions {
	/** Members after the creator (peer 0). */
	readonly members: readonly ChatSharesMember[];
	/** Which shipped catalog the room's genesis signs. */
	readonly format: keyof ShippingChatCatalogs;
	/** The genesis application state for that format. */
	genesisStateBytes(input: Readonly<{ exactCanonicalLatchedAclBytes: Uint8Array }>): Uint8Array;
	/** Keep each peer's shipped device archive beside the room's databases. */
	readonly archives?: boolean;
}

const track = Object.freeze({
	directories: new Set<string>(),
	rooms: new Set<V3RoomSession<ShippingChatProjection>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
	archives: new Set<ShippingChatLocalArchive>(),
});

/** Joins every owner the fixture opened; returns the rejections. */
export async function closeChatSharesRooms(): Promise<unknown[]> {
	const joined = await Promise.allSettled([...track.rooms].map((room) => room.close()));
	track.rooms.clear();
	const archives = await Promise.allSettled([...track.archives].map((archive) => archive.close()));
	track.archives.clear();
	const floors = await Promise.allSettled([...track.heads].map((head) => head.close()));
	track.heads.clear();
	const ports = await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.ports.clear();
	for (const directory of track.directories) rmSync(directory, { recursive: true, force: true });
	track.directories.clear();
	return [...joined, ...archives, ...floors, ...ports].flatMap((result) =>
		result.status === "rejected" ? [result.reason] : []
	);
}

/**
 * One shipped Chat room with the given members (peer 0 is the creator).
 * @param options - Members, format and genesis state.
 * @returns The room's peers, helpers and observation handles.
 */
export async function chatSharesRoomFixture(options: ChatSharesRoomOptions) {
	const directory = mkdtempSync(join(tmpdir(), "chat-membership-shares-"));
	track.directories.add(directory);
	const kinds: readonly ("creator" | ChatSharesMember)[] = ["creator", ...options.members];
	const identities = kinds.map((_, index) => {
		const seed = new Uint8Array(32).fill(0x41 + index);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const peers = identities.map((_, index) => (index === 0 ? "chat-creator" : `chat-member-${index}`));
	const objectId = `creator:${hex(hashDomain("chat-membership-shares-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: identities
			.flatMap(({ author }, index) =>
				kinds[index] === "late"
					? []
					: [
							{
								author,
								finalityKey: index === 0 ? author : null,
								groups:
									index === 0
										? ["admin", "finality", "writer"]
										: kinds[index] === "genesis-admin"
											? ["admin", "writer"]
											: ["writer"],
							},
						]
			)
			.sort((left, right) => left.author.localeCompare(right.author)),
		objectId,
		permissionless: false,
		version: 3,
	});
	const format = openShippingChatCatalogs()[options.format];
	const application = await createShippingV3ChatApplication({
		catalog: format.catalog,
		blueprintDigest: format.blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	const genesis = options.genesisStateBytes({ exactCanonicalLatchedAclBytes });
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: format.blueprintDigest,
		exactCanonicalApplicationStateBytes: genesis,
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
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
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });

	/**
	 * Opens one peer. `receiveOnly` opens it as an observer (the shipped page's joiner);
	 * `reopen` recreates the owners over the SAME databases, floor and archive file.
	 * `name` lets one identity open a second, independent replica.
	 * @param index
	 * @param openOptions
	 * @param openOptions.reopen
	 * @param openOptions.receiveOnly
	 * @param openOptions.name
	 */
	const open = async (index: number, openOptions: { reopen?: boolean; receiveOnly?: boolean; name?: string } = {}) => {
		const identity = required(identities[index]);
		const name = openOptions.name ?? `peer-${index}`;
		let archive: ShippingChatLocalArchive | undefined;
		if (options.archives === true) {
			archive = await openShippingChatLocalArchive({
				store: openNodeShippingChatArchiveStore(join(directory, `${name}-chat-archive.sqlite`)),
			});
			track.archives.add(archive);
		}
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		track.heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(peers[index]), false);
		const input: CreateV3RoomSessionInput<ShippingChatProjection> = {
			application,
			storageHost: openOptions.reopen
				? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" })
				: host,
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: {}),
			...(openOptions.receiveOnly === true ? { receiveOnly: true as const } : {}),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
			onProjection: (projection) => archive?.observe(projection),
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
						throw new TypeError("CHAT_SHARES_EPHEMERAL_UNUSED");
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
		track.rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		archive?.observe(room.projection());
		const deliver = (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			for (const row of rows)
				required(ingress)(
					Message.create({
						objectId: required(topic),
						sender: required(peers[sender]),
						type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						data: V3Envelope.encode({
							canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
							signature: row.commit.envelope.signature,
						}).finish(),
					})
				);
		};
		/**
		 * Delivers authenticated signed rows of another peer in issue order and waits until the
		 * final row is accepted (or `timeoutMs` passes). Resolves whether it was accepted.
		 * @param rows
		 * @param sender
		 * @param timeoutMs
		 */
		const receive = async (
			rows: readonly DurableIssuanceOutboxRecord[],
			sender: number,
			timeoutMs = 120_000
		): Promise<boolean> => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<boolean>((resolve) => {
				acknowledged.set(finalDigest, () => resolve(true));
				timer = setTimeout(() => resolve(false), timeoutMs);
			});
			try {
				deliver(rows, sender);
				return await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		const wasAccepted = (row: DurableIssuanceOutboxRecord) => accepted.has(hex(row.commit.envelope.digest));
		/** The canonical state bytes this peer shows (its current projection). */
		const stateBytes = () => required(application.migration).canonicalStateBytes(room.projection());
		return { index, name, room, floor, networkNode, receive, wasAccepted, archive, stateBytes };
	};
	type Peer = Awaited<ReturnType<typeof open>>;

	/**
	 * Ordinary close of one peer's owners.
	 * @param peer
	 */
	const stop = async (peer: Peer) => {
		await peer.room.close();
		track.rooms.delete(peer.room);
		if (peer.archive !== undefined) {
			await peer.archive.close();
			track.archives.delete(peer.archive);
		}
		await peer.floor.close();
		track.heads.delete(peer.floor);
	};

	/**
	 * Every row of `index` (database `name`) above `after`, in issue order (observation handle).
	 * @param index
	 * @param after
	 * @param name
	 */
	const issuedAfter = async (index: number, after: number | null, name = `peer-${index}`) => {
		const store = await host.openIssuance(name);
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

	// The creator's genuine successor export (what any joiner installs), read on observation handles.
	const readExport = async () => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("CHAT_SHARES_INVALID_OBJECT");
		const store = await host.openAhe("peer-0--ahe");
		const snapshotStore = await host.openSnapshots("peer-0");
		try {
			const exported = await readCreatorSuccessorExport({
				store,
				snapshotStore,
				catalog: application.catalog,
				objectId: object.value,
				pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: invite.detachedGenesisSignature,
			});
			const scope = await snapshotStore.openScope(exported.declaration);
			const read = scope.verificationQuarantine.open(new AbortController().signal);
			const chunks: Uint8Array[] = [];
			try {
				for (const descriptor of exported.declaration.chunks) chunks.push(required(await read.read(descriptor)));
			} finally {
				await read.discard();
				await scope.release();
			}
			return { ...exported, chunks };
		} finally {
			await snapshotStore.close();
			await store.close();
		}
	};

	/** The application state a joiner installs from the creator's current successor export. */
	const exportedApplicationStateBytes = async () => {
		const exported = await readExport();
		const payload = new Uint8Array(exported.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of exported.chunks) {
			payload.set(chunk, offset);
			offset += chunk.byteLength;
		}
		if (payload.byteLength === 0) throw new TypeError("CHAT_SHARES_EXPORT_PAYLOAD_MISSING");
		const snapshot = decodeCanonical(payload) as Record<string, unknown>;
		return encodeCanonical(snapshot.application);
	};

	// Serves the creator's successor to one peer through the original signed material server.
	const successorDelivery = async (receiverIndex: number) => {
		const exported = await readExport();
		const sender = required(peers[0]);
		const receiver = required(peers[receiverIndex]);
		const scripted = new ScriptedSnapshotChunkPort(
			{ declaration: exported.declaration, chunks: exported.chunks } as ConstructorParameters<
				typeof ScriptedSnapshotChunkPort
			>[0],
			new Map([[sender, "honest"]]),
			receiver
		);
		track.ports.add(scripted);
		const server = createCreatorSuccessorMaterialServer({
			identity: {
				author: creator.author,
				sign: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
				isAuthorizedAuthor: (author) => identities.some((identity) => identity.author === author),
			},
			localPeerId: sender,
			manifestDigest: exported.declaration.scope.manifestDigest,
			material: exported.material,
			connectedPeers: () => [receiver],
		});
		const port: SnapshotChunkProtocolPort = {
			localPeerId: receiver,
			connectedPeers: () => [sender],
			close: () => scripted.close(),
			serve: (handler) => scripted.serve(handler),
			open: async (peer) => {
				const stream = await scripted.open(peer);
				const frames: Uint8Array[] = [];
				let materialRequest = false;
				return {
					peerId: peer,
					abort: (reason) => stream.abort(reason),
					close: () => stream.close(),
					read: async (maximum, readOptions) => {
						if (!materialRequest) return stream.read(maximum, readOptions);
						readOptions.signal.throwIfAborted();
						const frame = frames.shift();
						if (frame === undefined || frame.byteLength > maximum)
							throw new TypeError("CHAT_SHARES_MATERIAL_FRAME_INVALID");
						return frame;
					},
					write: async (bytes, writeOptions) => {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind !== "creator-successor-material-request") return stream.write(bytes, writeOptions);
						materialRequest = true;
						const inbound: SnapshotChunkProtocolStream = {
							peerId: receiver,
							abort: () => undefined,
							close: () => Promise.resolve(),
							read: () => Promise.reject(new TypeError("CHAT_SHARES_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("CHAT_SHARES_MATERIAL_REFUSED");
					},
				};
			},
		};
		track.ports.add(port);
		return { offer: exported.offer, port, peers: [sender] };
	};

	/**
	 * Installs the creator's current successor on one recipient peer.
	 * @param peer
	 */
	const install = async (peer: Peer) => {
		const transfer = await successorDelivery(peer.index);
		Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	};

	return {
		directory,
		identities,
		peers,
		application,
		genesis,
		objectId,
		invite,
		open,
		stop,
		install,
		issuedAfter,
		successorDelivery,
		exportedApplicationStateBytes,
		census: (index: number) => roomStoreCensus(directory, `peer-${index}`),
	};
}

export type ChatSharesRoom = Awaited<ReturnType<typeof chatSharesRoomFixture>>;
export type ChatSharesPeer = Awaited<ReturnType<ChatSharesRoom["open"]>>;
