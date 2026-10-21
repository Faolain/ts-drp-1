/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openShippingChatCatalogs } from "../../../examples/chat/src/chat-catalogs.js";
import {
	type ShippingChatArchiveBound,
	type ShippingChatLocalArchive,
	openShippingChatLocalArchive,
} from "../../../examples/chat/src/v3-chat-archive.js";
import { openNodeShippingChatArchiveStore } from "../../../examples/chat/src/v3-chat-archive-sqlite.js";
import {
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../../../examples/chat/src/v3-chat-application.js";
import { createShippingChatWindowGenesisStateBytes } from "../../../examples/chat/src/v3-chat-window.js";
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
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";

// Track W: the shipped Chat composition for new rooms (the window catalog, the shipped
// genesis, ACL version 3, creator-trusted-settlement-v1, the shipped admission policy) as a
// long room of one creator and N-1 Writers on genuine SQLite, Ed25519 and room owners, with
// scripted native-byte transport (Track P's canvas-long-room pattern, generalised to N peers).
// Each peer keeps the shipped device archive in its own SQLite file beside (never inside) the
// room's databases. Observation helpers (census, export read) open their own handles and grant
// nothing.

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("CHAT_WINDOW_REQUIRED_FIXTURE_VALUE");
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

/** "auto": the shipped scheduling (a later task); "manual": only an explicit flush writes. */
export type ArchiveScheduling = "auto" | "manual";

export interface ChatWindowRoomOptions {
	/** Writers including the creator (peer 0). */
	readonly writers: number;
	readonly archiveBound?: (index: number) => ShippingChatArchiveBound | undefined;
	readonly archiveScheduling?: (index: number) => ArchiveScheduling;
}

const track = Object.freeze({
	directories: new Set<string>(),
	rooms: new Set<V3RoomSession<ShippingChatProjection>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
	archives: new Set<ShippingChatLocalArchive>(),
});

/** Joins every owner the fixture opened; returns the rejections. */
export async function closeChatWindowRooms(): Promise<unknown[]> {
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

// ---------------------------------------------------------------------------------------
// Node SQLite census of one peer's room owners (Track M's families; observation only).

const SQLITE_FAMILIES = ["ahe", "issuance", "journal", "snapshots", "signing"] as const;
const SQLITE_SUFFIX: Readonly<Record<(typeof SQLITE_FAMILIES)[number], string>> = {
	ahe: "",
	issuance: ".drp-issuance-v1.sqlite",
	journal: ".drp-live-journal-v1.sqlite",
	snapshots: ".drp-snapshot-quarantine-v1.sqlite",
	signing: "",
};
const sqliteFile = (directory: string, family: (typeof SQLITE_FAMILIES)[number], name: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify([family, name]))
			.digest("hex")}.sqlite${SQLITE_SUFFIX[family]}`
	);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
export type StoreCensus = Readonly<Record<string, readonly [rows: number, bytes: number]>>;

/** Rows and BLOB/TEXT payload bytes of every table of one peer's room owners, plus file sizes (`#file`). */
export function roomStoreCensus(directory: string, name: string): StoreCensus {
	const out: Record<string, readonly [number, number]> = {};
	for (const family of SQLITE_FAMILIES) {
		const filename = sqliteFile(directory, family, family === "ahe" ? `${name}--ahe` : name);
		if (!existsSync(filename)) {
			out[`${family}:#missing`] = [1, 0];
			continue;
		}
		const database = new DatabaseSync(filename, { readOnly: true });
		try {
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all()
				.map((row) => String(row.name));
			for (const table of tables) {
				const columns = database
					.prepare(`PRAGMA table_info(${quote(table)})`)
					.all()
					.map((column) => quote(String(column.name)));
				const payload = columns
					.map((column) => `CASE WHEN typeof(${column}) IN ('blob','text') THEN length(${column}) ELSE 0 END`)
					.join(" + ");
				const row = database
					.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${payload || "0"}), 0) AS bytes FROM ${quote(table)}`)
					.get() as { rows: number; bytes: number };
				out[`${family}:${table}`] = [Number(row.rows), Number(row.bytes)];
			}
		} finally {
			database.close();
		}
		const wal = `${filename}-wal`;
		out[`${family}:#file`] = [1, statSync(filename).size + (existsSync(wal) ? statSync(wal).size : 0)];
	}
	return Object.freeze(out);
}

export function fileBytes(filename: string): number {
	const wal = `${filename}-wal`;
	return (existsSync(filename) ? statSync(filename).size : 0) + (existsSync(wal) ? statSync(wal).size : 0);
}

// ---------------------------------------------------------------------------------------
// The room.

export async function chatWindowRoomFixture(options: ChatWindowRoomOptions) {
	const directory = mkdtempSync(join(tmpdir(), "chat-rolling-window-"));
	track.directories.add(directory);
	const identities = Array.from({ length: options.writers }, (_, index) => {
		const seed = new Uint8Array(32).fill(0x91 + index);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const peers = identities.map((_, index) => (index === 0 ? "chat-creator" : `chat-writer-${index}`));
	const objectId = `creator:${hex(hashDomain("chat-rolling-window-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const exactCanonicalLatchedAclBytes = encodeCanonical({
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
	});
	// The shipped Chat's catalog for new rooms.
	const { window } = openShippingChatCatalogs();
	const application = await createShippingV3ChatApplication({
		catalog: window.catalog,
		blueprintDigest: window.blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	const genesis = createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes });
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: window.blueprintDigest,
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
	const archiveFile = (index: number) => join(directory, `peer-${index}-chat-archive.sqlite`);

	const openArchive = async (index: number) => {
		const bound = options.archiveBound?.(index);
		const manual = options.archiveScheduling?.(index) === "manual";
		const archive = await openShippingChatLocalArchive({
			store: openNodeShippingChatArchiveStore(archiveFile(index)),
			...(bound === undefined ? {} : { bound }),
			...(manual ? { schedule: () => undefined } : {}),
		});
		track.archives.add(archive);
		return archive;
	};

	// A persisted reopen recreates the owners over the SAME databases, floor and archive file.
	const open = async (index: number, openOptions: { reopen?: boolean } = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const archive = await openArchive(index);
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
			// The shipped wiring: the archive only takes a reference here.
			onProjection: (projection) => archive.observe(projection),
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
						throw new TypeError("CHAT_WINDOW_EPHEMERAL_UNUSED");
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
		// The shipped app shows the opened projection at once, so the archive sees it too.
		archive.observe(room.projection());
		// Delivers authenticated signed rows of another peer in issue order; the final row's
		// application acceptance joins the delivery.
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("CHAT_WINDOW_REMOTE_ADMISSION_TIMEOUT")), 120_000);
			});
			try {
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
				await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		/** The canonical state bytes this peer shows (its current projection). */
		const stateBytes = () => required(application.migration).canonicalStateBytes(room.projection());
		return { index, name, room, floor, networkNode, receive, archive, stateBytes };
	};
	type Peer = Awaited<ReturnType<typeof open>>;

	/** Ordinary close; `discardArchive` drops the archive's unwritten work as a crash would. */
	const stop = async (peer: Peer, stopOptions: { discardArchive?: boolean } = {}) => {
		await peer.room.close();
		track.rooms.delete(peer.room);
		if (stopOptions.discardArchive === true) await peer.archive.discard();
		else await peer.archive.close();
		track.archives.delete(peer.archive);
		await peer.floor.close();
		track.heads.delete(peer.floor);
	};

	// Every published row of `index` above `after`, in issue order (observation handle).
	const publishedAfter = async (index: number, after: number | null) => {
		const store = await host.openIssuance(`peer-${index}`);
		try {
			const author = required(identities[index]).author;
			const rows = await store.readOutboxPage({
				scope: { objectId, author },
				afterKey: after === null ? null : [objectId, author, after],
				limit: 128,
			});
			if (!rows.every((row) => row.publishState === "published")) throw new TypeError("CHAT_WINDOW_UNPUBLISHED_ROW");
			return rows;
		} finally {
			await store.close();
		}
	};

	// The creator's genuine successor export (what any joiner installs), read on observation handles.
	const readExport = async () => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("CHAT_WINDOW_INVALID_OBJECT");
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
		// The snapshot payload is the declared chunks in order (as tests/phase-6b-grid-successor-state-red).
		const payload = new Uint8Array(exported.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of exported.chunks) {
			payload.set(chunk, offset);
			offset += chunk.byteLength;
		}
		if (payload.byteLength === 0) throw new TypeError("CHAT_WINDOW_EXPORT_PAYLOAD_MISSING");
		const snapshot = decodeCanonical(payload) as Record<string, unknown>;
		return encodeCanonical(snapshot.application);
	};

	// Serves the creator's successor to one Writer through the original signed material server.
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
							throw new TypeError("CHAT_WINDOW_MATERIAL_FRAME_INVALID");
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
							read: () => Promise.reject(new TypeError("CHAT_WINDOW_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("CHAT_WINDOW_MATERIAL_REFUSED");
					},
				};
			},
		};
		track.ports.add(port);
		return { offer: exported.offer, port, peers: [sender] };
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
		publishedAfter,
		successorDelivery,
		exportedApplicationStateBytes,
		census: (index: number) => roomStoreCensus(directory, `peer-${index}`),
		archiveFileBytes: (index: number) => fileBytes(archiveFile(index)),
	};
}

export type ChatWindowRoom = Awaited<ReturnType<typeof chatWindowRoomFixture>>;
export type ChatWindowPeer = Awaited<ReturnType<ChatWindowRoom["open"]>>;
