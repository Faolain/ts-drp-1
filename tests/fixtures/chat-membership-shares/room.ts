/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
	createBrowserV3RoomDatabaseStorageHost,
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
import { inspectHead } from "../../../packages/node/src/creator-close.js";
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
	/** Existing externally owned directory for real process-death recovery. */
	readonly directory?: string;
	/** Members after the creator (peer 0). */
	readonly members: readonly ChatSharesMember[];
	/** Which shipped catalog the room's genesis signs. */
	readonly format: keyof ShippingChatCatalogs;
	/** The genesis application state for that format. */
	genesisStateBytes(input: Readonly<{ exactCanonicalLatchedAclBytes: Uint8Array }>): Uint8Array;
	/** Keep each peer's shipped device archive beside the room's databases. */
	readonly archives?: boolean;
	/** Fault injection after an actual durable floor write. */
	readonly afterFloorWrite?: (peer: number, phase: "begin" | "commit") => void | Promise<void>;
	readonly beforeFloorWrite?: (peer: number, phase: "begin" | "commit") => void | Promise<void>;
	/**
	 * Peers (by index, never the creator) opened through a genuine owned local
	 * session: the host generates and keeps the key, and the room signs only
	 * through the native owned-key path. Observation helpers use reopen aliases.
	 */
	readonly localMembers?: readonly number[];
	/** Process-death recovery: reopen these existing owned local sessions instead of creating them. */
	readonly localSelectors?: Readonly<Record<number, Readonly<{ slot: number; incarnation: number }>>>;
	/**
	 * "browser-room": every room database on the browser room-database host (the shipped pages'
	 * default) over a fresh fake-indexeddb factory with a process Web Locks manager, instead of the
	 * Node SQLite host. Floors and archives stay SQLite files.
	 */
	readonly storage?: "node" | "browser-room";
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
	const directory = options.directory ?? mkdtempSync(join(tmpdir(), "chat-membership-shares-"));
	if (options.directory === undefined) track.directories.add(directory);
	const kinds: readonly ("creator" | ChatSharesMember)[] = ["creator", ...options.members];
	const localMembers = new Set(options.localMembers ?? []);
	if (localMembers.has(0)) throw new TypeError("CHAT_SHARES_LOCAL_CREATOR_UNSUPPORTED");
	let localHost: ReturnType<typeof createNodeV3RoomStorageHost> | undefined;
	if (localMembers.size > 0) {
		const localDirectory = join(directory, "local-sessions");
		mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
		localHost = createNodeV3RoomStorageHost({ directory: localDirectory, initialization: () => "create",
			localSessionSlots: 4, localSessionStoreScopes: 32, localSessionHandles: 160 });
	}
	type LocalLease = Awaited<ReturnType<NonNullable<typeof localHost>["acquireLocalSession"]>>;
	const localSelectors = new Map<number, LocalLease["selector"]>();
	const freshLeases = new Map<number, LocalLease>();
	const identities: { seed: Uint8Array; author: string }[] = [];
	for (let index = 0; index < kinds.length; index++) {
		if (localMembers.has(index)) {
			const existing = options.localSelectors?.[index];
			const lease = await required(localHost).acquireLocalSession(existing === undefined ? { kind: "create" } :
				{ kind: "reopen", selector: { slot: existing.slot, incarnation: existing.incarnation } });
			track.heads.add(lease);
			localSelectors.set(index, lease.selector);
			freshLeases.set(index, lease);
			// The owned seed never leaves native custody: no seed is available here.
			identities.push({ seed: new Uint8Array(0), author: lease.signing.author });
			continue;
		}
		const seed = new Uint8Array(32).fill(0x41 + index);
		identities.push({ seed, author: hex(ed25519.getPublicKey(seed)) });
	}
	/** Runs one observation through a reopen alias of a local member's session. */
	const withLocalAlias = async <T>(index: number, action: (host: LocalLease["storageHost"]) => Promise<T>): Promise<T> => {
		const alias = await required(localHost).acquireLocalSession({ kind: "reopen", selector: required(localSelectors.get(index)) });
		try { return await action(alias.storageHost); } finally { await alias.close(); }
	};
	const observationHost = (index: number) => localMembers.has(index)
		? undefined : host;
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
	const browserRoom = options.storage === "browser-room";
	if (browserRoom) {
		await import("fake-indexeddb/auto");
		const { IDBFactory } = await import("fake-indexeddb");
		Reflect.set(globalThis, "indexedDB", new IDBFactory());
		if (Reflect.get(navigator, "locks") === undefined) {
			const { createProcessLockManager } = await import("../track-m/room-retention-fixture.js");
			Object.defineProperty(navigator, "locks", { configurable: true, value: createProcessLockManager() });
		}
	}
	const host = (browserRoom
		? createBrowserV3RoomDatabaseStorageHost()
		: createNodeV3RoomStorageHost({ directory, initialization: () => "create" })) as ReturnType<
		typeof createNodeV3RoomStorageHost
	>;
	// Sync before sending (owner decision B): a member that reopened its lineage confirms the
	// creator's statement of the current epoch, as the page's successor delivery does on bind.
	let creatorRoom: V3RoomSession<ShippingChatProjection> | undefined;

	// Whether the native host already holds a store (packages/storage-node/src/v3-room-host.ts names
	// each store's files after sha256(JSON.stringify([family, name]))).
	const storeExists = (name: string, family: string): boolean => {
		const key = createHash("sha256")
			.update(JSON.stringify([family, name]))
			.digest("hex");
		return readdirSync(directory).some((file) => file.startsWith(key));
	};

	/**
	 * Opens one peer. `receiveOnly` opens it as an observer (the shipped page's joiner);
	 * `reopen` recreates the owners over the SAME databases, floor and archive file.
	 * `promote` reopens a replica that was receive-only until now as a Writer: its stores reopen,
	 * and a store only a Writer uses (seal votes and evidence) is created the first time, as the
	 * browser's IndexedDB host creates a missing store when it opens it.
	 * `name` lets one identity open a second, independent replica.
	 * `currency: false` skips confirming the open creator's currency statement (sync before sending).
	 * `localIssueCurrencyHoldMs` shortens how long a not-yet-current move is held.
	 * @param index
	 * @param openOptions
	 * @param openOptions.reopen
	 * @param openOptions.promote
	 * @param openOptions.receiveOnly
	 * @param openOptions.name
	 * @param openOptions.currency
	 * @param openOptions.localIssueCurrencyHoldMs
	 */
	const open = async (
		index: number,
		openOptions: {
			reopen?: boolean;
			promote?: boolean;
			receiveOnly?: boolean;
			name?: string;
			currency?: boolean;
			localIssueCurrencyHoldMs?: number;
			/** Creator restore currency: how this (creator) open asks members for their view. */
			creatorMemberView?: unknown;
			creatorRestoreCurrencyBoundMs?: number;
			creatorRestoreCurrencyAnswerBoundMs?: number;
		} = {}
	) => {
		const reopening = openOptions.reopen === true || openOptions.promote === true;
		const identity = required(identities[index]);
		const name = openOptions.name ?? `peer-${index}`;
		let archive: ShippingChatLocalArchive | undefined;
		if (options.archives === true) {
			archive = await openShippingChatLocalArchive({
				store: openNodeShippingChatArchiveStore(join(directory, `${name}-chat-archive.sqlite`)),
			});
			track.archives.add(archive);
		}
		const nativeFloor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: reopening ? "reopen" : "create" },
		});
		const floor = options.afterFloorWrite === undefined && options.beforeFloorWrite === undefined ? nativeFloor : Object.freeze({...nativeFloor,
			async begin(input: Parameters<typeof nativeFloor.begin>[0]) {
				await options.beforeFloorWrite?.(index, "begin");
				const result = await nativeFloor.begin(input); await options.afterFloorWrite?.(index, "begin"); return result;
			},
			async commit(input: Parameters<typeof nativeFloor.commit>[0]) {
				await options.beforeFloorWrite?.(index, "commit");
				const result = await nativeFloor.commit(input); await options.afterFloorWrite?.(index, "commit"); return result;
			}});
		track.heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let retainedPublisher: ((targetPeerId?: string) => Promise<void>) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(peers[index]), false);
		const input: CreateV3RoomSessionInput<ShippingChatProjection> = {
			application,
			storageHost: browserRoom
				? host
				: openOptions.promote
				? createNodeV3RoomStorageHost({
						directory,
						initialization: (store) => (storeExists(store.name, store.family) ? "reopen" : "create"),
					})
				: openOptions.reopen
					? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" })
					: host,
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: {}),
			...(openOptions.receiveOnly === true ? { receiveOnly: true as const } : {}),
			...(openOptions.localIssueCurrencyHoldMs === undefined
				? {}
				: { localIssueCurrencyHoldMs: openOptions.localIssueCurrencyHoldMs }),
			...(openOptions.creatorMemberView === undefined ? {} : { creatorMemberView: openOptions.creatorMemberView }),
			...(openOptions.creatorRestoreCurrencyBoundMs === undefined
				? {}
				: { creatorRestoreCurrencyBoundMs: openOptions.creatorRestoreCurrencyBoundMs }),
			...(openOptions.creatorRestoreCurrencyAnswerBoundMs === undefined
				? {}
				: { creatorRestoreCurrencyAnswerBoundMs: openOptions.creatorRestoreCurrencyAnswerBoundMs }),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: localMembers.has(index) ? new Uint8Array(32) : ed25519.getPublicKey(identity.seed),
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
					setRetainedPublisher: publisher => { retainedPublisher = publisher; },
					setIngressHandler: (selectedTopic, handler) => {
						topic = selectedTopic;
						ingress = handler;
					},
				};
			},
		};
		let lease: LocalLease | undefined;
		if (localMembers.has(index)) {
			lease = freshLeases.get(index) ?? await required(localHost).acquireLocalSession({ kind: "reopen", selector: required(localSelectors.get(index)) });
			freshLeases.delete(index);
			track.heads.add(lease);
		}
		const room = lease === undefined ? await createV3RoomSession(input) : await createV3RoomSession((() => {
			const { storageHost: _host, author: _author, publicKeyBytes: _key, signRegisteredVertexDigest: _sign, ...rest } = input;
			return { ...rest, localSession: { lease } };
		})());
		track.rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		archive?.observe(room.projection());
		if (index === 0) creatorRoom = room;
		else if (openOptions.currency !== false && openOptions.receiveOnly !== true && creatorRoom !== undefined) {
			const statement = creatorRoom.currencyStatement?.();
			if (statement !== undefined) await room.confirmCurrent?.(statement);
		}
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
		return { index, name, room, floor, lease, networkNode, receive, wasAccepted, archive, stateBytes,
			republish: (targetPeerId?: string) => required(retainedPublisher)(targetPeerId) };
	};
	type Peer = Awaited<ReturnType<typeof open>>;

	/**
	 * Ordinary close of one peer's owners.
	 * @param peer
	 */
	const stop = async (peer: Peer) => {
		if (peer.room === creatorRoom) creatorRoom = undefined;
		await peer.room.close();
		track.rooms.delete(peer.room);
		if (peer.archive !== undefined) {
			await peer.archive.close();
			track.archives.delete(peer.archive);
		}
		await peer.floor.close();
		track.heads.delete(peer.floor);
		if (peer.lease !== undefined) { await peer.lease.close(); track.heads.delete(peer.lease); }
	};

	/**
	 * Every row of `index` (database `name`) above `after`, in issue order (observation handle).
	 * @param index
	 * @param after
	 * @param name
	 */
	const issuedAfter = async (index: number, after: number | null, name = `peer-${index}`) => {
		if (localMembers.has(index)) return withLocalAlias(index, async (alias) => {
			const store = await alias.openIssuance(name);
			try {
				const author = required(identities[index]).author;
				return await store.readOutboxPage({ scope: { objectId, author },
					afterKey: after === null ? null : [objectId, author, after], limit: 128 });
			} finally { await store.close(); }
		});
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
		const journalStore = await host.openJournal("peer-0");
		try {
			const exported = await readCreatorSuccessorExport({
				store,
				snapshotStore,
				journalStore,
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
			await journalStore.close();
			await snapshotStore.close();
			await store.close();
		}
	};

	/** Reads exact native head carriers for verification; supplies no trust capability. */
	const readHead = async (index: number) => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("CHAT_SHARES_INVALID_OBJECT");
		if (localMembers.has(index)) return withLocalAlias(index, async (alias) => {
			const store = await alias.openAhe(`peer-${index}--ahe`);
			try { return await inspectHead(store, object.value); } finally { await store.close(); }
		});
		const store = await host.openAhe(`peer-${index}--ahe`);
		try { return await inspectHead(store, object.value); }
		finally { await store.close(); }
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
		// Sync before sending (live install rule): the creator's statement for the offered epoch travels
		// with the offer, as the pages' successor delivery sends it; a current peer ignores it.
		const currency = creatorRoom?.currencyStatement?.();
		await peer.room.installCreatorSuccessor({
			offer: transfer.offer,
			peers: transfer.peers,
			...(currency === undefined ? {} : { currency }),
		});
	};

	/** Observation-only native issuance owner for one peer (a reopen alias for local members). */
	const withIssuance = async <T>(index: number, action: (store: Awaited<ReturnType<typeof host.openIssuance>>) => Promise<T>): Promise<T> => {
		const name = `peer-${index}`;
		if (localMembers.has(index)) return withLocalAlias(index, async (alias) => {
			const store = await alias.openIssuance(name);
			try { return await action(store as Awaited<ReturnType<typeof host.openIssuance>>); } finally { await store.close(); }
		});
		const store = await required(observationHost(index)).openIssuance(name);
		try { return await action(store); } finally { await store.close(); }
	};

	return {
		directory,
		identities,
		withIssuance,
		/** Owned local session selectors (host-local custody only), for process-death recovery. */
		localSelectors: Object.freeze(Object.fromEntries([...localSelectors].map(([index, selector]) =>
			[index, Object.freeze({ slot: selector.slot, incarnation: selector.incarnation })]))),
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
		readExport,
		readHead,
		exportedApplicationStateBytes,
		census: (index: number) => roomStoreCensus(directory, `peer-${index}`),
	};
}

export type ChatSharesRoom = Awaited<ReturnType<typeof chatSharesRoomFixture>>;
export type ChatSharesPeer = Awaited<ReturnType<ChatSharesRoom["open"]>>;
