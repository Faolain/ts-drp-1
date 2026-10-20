/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixture: transparent inference keeps the native capability signatures. */
/* eslint-disable @typescript-eslint/require-await -- Every RoleEndpoint method is async so the browser proxy and the in-process endpoint share one contract. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealSigningStore } from "@ts-drp/storage-browser/seal-signing";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";

import {
	type AppKind,
	type BoundMode,
	fromBase64,
	type HostKind,
	type LongRoomOptions,
	type ObservedEvent,
	type RoleEndpoint,
	type StoreCensus,
	toBase64,
	type WireOffer,
	type WireRow,
} from "./long-room-driver.js";
import catalogMaterial from "../../../examples/chat/src/chat-catalog-material.json";
import {
	createShippingChatGenesisStateBytes,
	createShippingV3ChatApplication,
} from "../../../examples/chat/src/v3-chat-application.js";
import {
	createBrowserV3RoomDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../../../packages/blueprints/src/v3-canvas.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { createV3CanvasApplication } from "../../../packages/node/src/applications/canvas.js";
import { readCreatorSuccessorExport } from "../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";

// Track Q (Canvas and Chat creator lull): one role of a long room as a `RoleEndpoint`
// (long-room-driver.ts drives two of them). Adapted from Track M's measurement harness
// (tests/fixtures/track-m-apps/long-room-core.ts on Track M's branch, da3704ac) without its
// retention host. Platform-neutral: under vitest both roles live in one process
// (node-long-room.ts: the Node SQLite host, or the browser hosts on fake-indexeddb); in a
// browser each role is one page on its own origin (browser/). Observation only: the census
// and the export read open their own handles (or their own IndexedDB connection) and never
// reach into a node or owner object. Nothing here is a bound or a grant.

interface Closable {
	close(): Promise<void>;
}
type Floor = Parameters<typeof createV3RoomSession>[0]["roomHeadAuthority"] & Closable;

/** Where one role's host, floor and owners come from; the platform wrapper supplies it. */
export interface RoleEnvironment {
	readonly host: LongRoomHost;
	/** Unique per run and identical for both roles: the object id derives from it. */
	readonly unique: string;
	openFloor(name: string): Floor | Promise<Floor>;
	readonly track: Readonly<{ rooms: Set<Closable>; heads: Set<Closable>; ports: Set<SnapshotChunkProtocolPort> }>;
	/** This role's observer events. */
	readonly events?: Readonly<Record<string, unknown>>[];
	/** Recipient: carries one material request to the creator's `dispatch`. */
	relay?(request: string): Promise<string[]>;
}

export interface LongRoomHost {
	readonly storageHost: unknown;
	/** Separate handles for the delivery's reads (never the room's own owners). */
	readonly observe: Readonly<{
		openIssuance(name: string): ReturnType<typeof createBrowserDurableIssuanceStore>;
		openAhe(name: string): ReturnType<typeof createBrowserAheDurableStore>;
		openSnapshots(name: string): ReturnType<typeof createBrowserSnapshotQuarantineStore>;
	}>;
	census(name: string): Promise<StoreCensus>;
}

export const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("CANVAS_CHAT_LULL_REQUIRED_FIXTURE_VALUE");
	return value;
}

// ---------------------------------------------------------------------------------------
// IndexedDB census and browser hosts (fake-indexeddb under vitest, the engine in a browser).

function payloadBytes(value: unknown): number {
	if (value instanceof Uint8Array) return value.byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean") return 1;
	if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + payloadBytes(item), 0);
	if (value !== null && typeof value === "object")
		return Object.values(value).reduce((sum: number, item) => sum + payloadBytes(item), 0);
	return 0;
}

/** Rows and value payload bytes of every object store of one database (its own connection). */
export async function databaseCensus(database: string): Promise<StoreCensus> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(database);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const names = [...db.objectStoreNames];
		const out: Record<string, readonly [number, number]> = {};
		if (names.length === 0) return out;
		const tx = db.transaction(names, "readonly");
		await Promise.all(
			names.map(
				(store) =>
					new Promise<void>((resolve, reject) => {
						const values = tx.objectStore(store).getAll();
						values.onsuccess = () => {
							const rows = values.result as unknown[];
							out[store] = [rows.length, rows.reduce((sum: number, row) => sum + payloadBytes(row), 0)];
							resolve();
						};
						values.onerror = () => reject(values.error);
					})
			)
		);
		return Object.freeze(out);
	} finally {
		db.close();
	}
}

/** Every database of one role on the six-database host, by database suffix. */
async function prefixCensus(prefix: string): Promise<StoreCensus> {
	const out: Record<string, readonly [number, number]> = {};
	const databases = (await indexedDB.databases()).flatMap(({ name }) =>
		name !== undefined && (name === prefix || name.startsWith(`${prefix}-`)) ? [name] : []
	);
	for (const database of databases.sort())
		for (const [store, value] of Object.entries(await databaseCensus(database)))
			out[`${database.slice(prefix.length) || "main"}:${store}`] = value;
	return Object.freeze(out);
}

/**
 * A browser host whose database names carry this run's prefix: "browser" = the default
 * six-database host (examples/v3-room's owner factories); "room" = the room-database host
 * (`createBrowserV3RoomDatabaseStorageHost`).
 * @param kind - The browser host kind.
 * @param unique - Unique per run.
 * @returns The host, its observation handles and its census.
 */
export function browserHostFor(kind: Exclude<HostKind, "node">, unique: string): LongRoomHost {
	const prefix = `ccl-${kind === "browser" ? "b" : "r"}-${hex(hashDomain("canvas-chat-lull-host/v1", new TextEncoder().encode(unique))).slice(0, 16)}`;
	const name = (value: string) => `${prefix}-${value}`;
	if (kind === "browser") {
		const storageHost = Object.freeze({
			openAhe: (value: string) => createBrowserAheDurableStore({ databaseName: name(value) }),
			openIssuance: (value: string) => createBrowserDurableIssuanceStore({ primaryDatabaseName: name(value) }),
			openJournal: (value: string) => createBrowserDurableLiveJournalStore({ primaryDatabaseName: name(value) }),
			openSnapshots: (value: string) => createBrowserSnapshotQuarantineStore({ primaryDatabaseName: name(value) }),
			openSealVote: (value: string) => openBrowserSealVoteStore({ databaseName: name(value) }),
			openSealEvidence: (value: string) => openBrowserSealEvidenceStore({ databaseName: name(value) }),
			openCreatorSigningStores: (value: string) => openBrowserSealSigningStore({ databaseName: name(value) }),
			openRoomHead: (
				value: string,
				initialization: Parameters<typeof createBrowserRoomHeadAuthority>[0]["initialization"]
			) => createBrowserRoomHeadAuthority({ databaseName: name(value), initialization }),
		});
		return Object.freeze({ storageHost, observe: storageHost, census: (value: string) => prefixCensus(name(value)) });
	}
	const base = createBrowserV3RoomDatabaseStorageHost();
	const openCreatorSigningStores = base.openCreatorSigningStores;
	const openRoomRetirement = base.openRoomRetirement;
	const storageHost = Object.freeze({
		openAhe: (value: string) => base.openAhe(name(value)),
		openIssuance: (value: string) => base.openIssuance(name(value)),
		openJournal: (value: string) => base.openJournal(name(value)),
		openSnapshots: (value: string) => base.openSnapshots(name(value)),
		openSealVote: (value: string) => base.openSealVote(name(value)),
		openSealEvidence: (value: string) => base.openSealEvidence(name(value)),
		...(openCreatorSigningStores === undefined
			? {}
			: { openCreatorSigningStores: (value: string) => openCreatorSigningStores(name(value)) }),
		openRoomHead: (value: string, initialization: Parameters<typeof base.openRoomHead>[1]) =>
			base.openRoomHead(name(value), initialization),
		...(openRoomRetirement === undefined
			? {}
			: { openRoomRetirement: (value: string) => openRoomRetirement(name(value)) }),
	});
	return Object.freeze({
		storageHost,
		observe: storageHost as unknown as LongRoomHost["observe"],
		census: (value: string) => databaseCensus(name(value)),
	});
}

// ---------------------------------------------------------------------------------------
// Applications.

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
/** The examples/canvas composition's size. */
export const CANVAS_SIDE = 10;

export function chatCatalog() {
	const bytes = (value: string) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
	return openTrustedBlueprintCatalogBytes({
		catalogBytes: bytes(catalogMaterial.catalogBytes),
		assets: Object.fromEntries(
			Object.entries(catalogMaterial.assets as Record<string, string>).map(([file, value]) => [file, bytes(value)])
		),
	});
}

/** "absent" removes only the resource bound reader; every other field is the product's. */
function withBound<Application extends object>(application: Application, bound: BoundMode): Application {
	if (bound === "shipped") return application;
	const { readOrdinaryApplicationResourceBound: _removed, ...rest } = application as Application & {
		readOrdinaryApplicationResourceBound?: unknown;
	};
	return Object.freeze(rest) as Application;
}

async function applicationFor(app: AppKind, exactCanonicalLatchedAclBytes: Uint8Array, bound: BoundMode) {
	if (app === "canvas") {
		const canvas = createV3CanvasApplication(CANVAS_SIDE, CANVAS_SIDE);
		const genesis = required(canvas.migration).canonicalStateBytes(
			canvas.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		);
		return { application: withBound(canvas, bound), genesis, admission: undefined, catalog: canvas.catalog };
	}
	const catalog = chatCatalog();
	const blueprintDigest = required(catalog.blueprintDigests[0]);
	const chat = await createShippingV3ChatApplication({
		catalog,
		blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	return {
		application: withBound(chat, bound),
		genesis: createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes }),
		admission: chat.createOperationAdmissionPolicy,
		catalog,
	};
}

function operationFor(app: AppKind, role: number, epoch: number, ordinal: number): Readonly<Record<string, unknown>> {
	if (app === "canvas")
		return toCanvasWireOperation(
			{ action: "paint", offset: [(epoch + ordinal) % CANVAS_SIDE, role], rgb: [1 + role, 2 + (ordinal % 200), 3] },
			`paint-${role}-${epoch}-${ordinal}`
		);
	return Object.freeze({
		action: "message",
		clientOperationId: `m-${role}-${epoch}-${ordinal}`,
		displayTimeMs: 1_791_662_400_000 + epoch * 1000 + ordinal * 10 + role,
		text: `e${epoch} o${ordinal}`,
	});
}

/** The network node surface the room touches here (tests/fixtures/phase-4b-v3 `fakeNetwork`, without call recording). */
function loopbackNetwork(peerId: string): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId,
		membershipVerifier: undefined,
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		isDialable: () => Promise.resolve(true),
		changeTopicScoreParams: () => undefined,
		removeTopicScoreParams: () => undefined,
		subscribe: (topic: string) => topics.add(topic),
		unsubscribe: (topic: string) => topics.delete(topic),
		connectToBootstraps: () => Promise.resolve(),
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		getPeerMultiaddrs: () => Promise.resolve([]),
		getBootstrapNodes: () => [],
		getSubscribedTopics: () => [...topics],
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: () => [],
		getGroupPeers: () => [],
		broadcastMessage: () => Promise.resolve(),
		publishMessage: () => Promise.resolve(true),
		sendMessage: () => Promise.resolve(),
		sendMessageToRandomPeer: () => Promise.resolve(),
		sendGroupMessage: () => Promise.resolve(),
		subscribeToMessageQueue: () => undefined,
		onGroupPeerChange: () => () => undefined,
		gossipTopicFor: () => undefined,
	} as unknown as DRPNetworkNode;
}

// ---------------------------------------------------------------------------------------
// One role.

const OFFER_FIELDS = [
	"exactCanonicalCutValueBytes",
	"exactCanonicalCommitQcBytes",
	"exactCanonicalTrustStateRecordBytes",
	"exactCanonicalSnapshotManifestBytes",
] as const;

/**
 * Opens one role of the long room (0 = creator, 1 = recipient) as an endpoint. Both roles
 * derive the same object, ACL, application and creator invite from `options` and
 * `env.unique` (the invite signature is deterministic Ed25519), so a reopen with the same
 * `unique` opens the same room from its persisted stores.
 * @param options - The room.
 * @param index - 0 for the creator, 1 for the recipient.
 * @param env - The role's host, floor, owner tracking, events and (recipient) material relay.
 * @returns The endpoint.
 */
export async function openRole(options: LongRoomOptions, index: 0 | 1, env: RoleEnvironment): Promise<RoleEndpoint> {
	const { host, track } = env;
	const seedBase = options.app === "canvas" ? 0x61 : 0x71;
	const identities = [0, 1].map((offset) => {
		const seed = new Uint8Array(32).fill(seedBase + offset);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const recipientIdentity = required(identities[1]);
	const identity = required(identities[index]);
	const peers = [`${options.app}-creator`, `${options.app}-recipient`] as const;
	const name = (["creator", "recipient"] as const)[index];
	const objectId = `creator:${hex(hashDomain("canvas-chat-lull-object/v1", new TextEncoder().encode(env.unique))).slice(0, 32)}`;
	const writerRecipient = options.recipient === "writer";
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: [
			{ author: creator.author, finalityKey: creator.author, groups: ["admin", "finality", "writer"] },
			...(writerRecipient ? [{ author: recipientIdentity.author, finalityKey: null, groups: ["writer"] }] : []),
		].sort((left, right) => left.author.localeCompare(right.author)),
		objectId,
		permissionless: false,
		// The shipped Canvas signs version 1; the shipped Chat signs version 3.
		version: options.app === "chat" ? 3 : 1,
	});
	const selected = await applicationFor(options.app, exactCanonicalLatchedAclBytes, options.bound);
	const application = selected.application;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: selected.genesis,
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			// The shipped profiles: Canvas creator-trusted-v1, Chat creator-trusted-settlement-v1.
			profileId: options.app === "chat" ? "creator-trusted-settlement-v1" : "creator-trusted-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});

	const floor = await env.openFloor(name);
	track.heads.add(floor);
	let ingress: ((message: Message) => void) | undefined;
	let topic: string | undefined;
	const accepted = new Set<string>();
	const acceptedOrder: string[] = [];
	const acknowledged = new Map<string, () => void>();
	const networkNode = loopbackNetwork(peers[index]);
	const receiveOnly = index === 1 && !writerRecipient;
	const input = {
		application,
		storageHost: host.storageHost,
		author: identity.author,
		...(receiveOnly ? { receiveOnly: true as const } : {}),
		...(index === 0
			? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
			: {}),
		...(selected.admission === undefined ? {} : { createOperationAdmissionPolicy: selected.admission }),
		creatorInvite: invite,
		databaseName: name,
		issuanceDatabaseName: name,
		migrationDatabaseNamespace: name,
		initialLogicalTime: 3,
		objectId,
		publicKeyBytes: ed25519.getPublicKey(identity.seed),
		roomHeadAuthority: floor,
		signRegisteredVertexDigest: (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, identity.seed)),
		onProjection: () => undefined,
		onAcceptedVertex: (vertex: Readonly<{ digest: Uint8Array }>) => {
			const digest = hex(vertex.digest);
			if (!accepted.has(digest)) acceptedOrder.push(digest);
			accepted.add(digest);
			acknowledged.get(digest)?.();
		},
		openTransport: () => {
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			return {
				networkNode,
				close: () => undefined,
				openEphemeral: () => {
					throw new TypeError("CANVAS_CHAT_LULL_EPHEMERAL_UNUSED");
				},
				requestRetainedHistory: () => undefined,
				setRetainedPublisher: () => undefined,
				setIngressHandler: (selectedTopic: string, handler: (message: Message) => void) => {
					topic = selectedTopic;
					ingress = handler;
				},
			};
		},
	};
	const room = await createV3RoomSession(input as unknown as Parameters<typeof createV3RoomSession>[0]);
	track.rooms.add(room);
	await waitForV3RoomStartupForDiagnostics(room);

	// The creator's genuine successor export over scripted native bytes; it grants nothing.
	const exported = async () => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("CANVAS_CHAT_LULL_INVALID_OBJECT");
		const store = await host.observe.openAhe("creator--ahe");
		const snapshotStore = await host.observe.openSnapshots("creator");
		try {
			const value = await readCreatorSuccessorExport({
				store,
				snapshotStore,
				catalog: application.catalog,
				objectId: object.value,
				pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: invite.detachedGenesisSignature,
			});
			const scope = await snapshotStore.openScope(value.declaration);
			const read = scope.verificationQuarantine.open(new AbortController().signal);
			const chunks: Uint8Array[] = [];
			try {
				for (const descriptor of value.declaration.chunks) chunks.push(required(await read.read(descriptor)));
			} finally {
				await read.discard();
				await scope.release();
			}
			return { ...value, chunks };
		} finally {
			await snapshotStore.close();
			await store.close();
		}
	};
	let scripted: ScriptedSnapshotChunkPort | undefined;
	let drained = 0;
	const kindOf = (result: unknown) => {
		const value = result as { kind: string; reason?: string };
		return value.reason === undefined ? value.kind : `${value.kind}:${value.reason}`;
	};

	return Object.freeze({
		issue: async (epoch: number, ordinal: number) => {
			const started = performance.now();
			await room.issue(operationFor(options.app, index, epoch, ordinal));
			return performance.now() - started;
		},
		// Every published own row above `after`, in issue order (observation handle).
		published: async (after: number | null) => {
			const store = await host.observe.openIssuance(name);
			try {
				const out: WireRow[] = [];
				let cursor = after;
				for (;;) {
					const rows = await store.readOutboxPage({
						scope: { objectId, author: identity.author },
						afterKey: cursor === null ? null : [objectId, identity.author, cursor],
						limit: 128,
					});
					for (const row of rows)
						out.push({
							preimage: toBase64(row.commit.envelope.canonicalPreimageBytes),
							signature: toBase64(row.commit.envelope.signature),
							digest: hex(row.commit.envelope.digest),
							authorSequence: row.commit.authorSequence,
						});
					const last = rows.at(-1);
					if (rows.length < 128 || last === undefined) return out;
					cursor = last.commit.authorSequence;
				}
			} finally {
				await store.close();
			}
		},
		// Delivers authenticated signed rows of the other peer in issue order; the final row is
		// an ordinary move whose application acceptance joins the delivery.
		receive: async (rows: readonly WireRow[]) => {
			const finalDigest = required(rows.at(-1)).digest;
			const started = performance.now();
			if (accepted.has(finalDigest)) return performance.now() - started;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("CANVAS_CHAT_LULL_REMOTE_ADMISSION_TIMEOUT")), 300_000);
			});
			try {
				for (const row of rows)
					required(ingress)(
						Message.create({
							objectId: required(topic),
							sender: peers[1 - index],
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							data: V3Envelope.encode({
								canonicalPreimage: fromBase64(row.preimage),
								signature: fromBase64(row.signature),
							}).finish(),
						})
					);
				await joined;
				return performance.now() - started;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		},
		state: async () => hex(required(application.migration).canonicalStateBytes(room.projection() as never)),
		seal: async (epoch: number) => {
			const started = performance.now();
			const sealed = await room.sealEpoch();
			const ms = performance.now() - started;
			if (!sealed.ok || sealed.epoch !== epoch)
				throw new TypeError(`CANVAS_CHAT_LULL_SEAL_REFUSED ${JSON.stringify(sealed)}`);
			return ms;
		},
		adopt: async () => {
			const started = performance.now();
			await room.adoptCreatorSuccessor();
			return performance.now() - started;
		},
		// The creator room's own material host serves the export.
		exportOffer: async () => {
			const started = performance.now();
			const value = await exported();
			const port = new ScriptedSnapshotChunkPort(
				{ declaration: value.declaration, chunks: value.chunks } as ConstructorParameters<
					typeof ScriptedSnapshotChunkPort
				>[0],
				new Map([[peers[1], "honest"]]),
				peers[0]
			);
			Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => port);
			const offer = await room.exportCreatorSuccessor();
			const ms = performance.now() - started;
			track.ports.add(port);
			scripted = port;
			return { offer: Object.fromEntries(OFFER_FIELDS.map((field) => [field, toBase64(offer[field])])), ms };
		},
		dispatch: async (request: string) =>
			(await required(scripted).dispatch(peers[1], [fromBase64(request)])).map((frame) => toBase64(frame)),
		install: async (offer: WireOffer) => {
			const relay = required(env.relay);
			const port: SnapshotChunkProtocolPort = {
				localPeerId: peers[1],
				connectedPeers: () => [peers[0]],
				close: () => Promise.resolve(),
				serve: () => () => undefined,
				open: (peer) => {
					const frames: Uint8Array[] = [];
					let closed = false;
					return Promise.resolve({
						peerId: peer,
						abort: () => {
							closed = true;
						},
						close: () => {
							closed = true;
							return Promise.resolve();
						},
						read: (maximum, readOptions) =>
							Promise.resolve().then(() => {
								readOptions.signal.throwIfAborted();
								if (closed) throw new TypeError("CANVAS_CHAT_LULL_STREAM_CLOSED");
								const frame = required(frames.shift());
								if (frame.byteLength > maximum) throw new TypeError("CANVAS_CHAT_LULL_MATERIAL_FRAME_LIMIT");
								return frame;
							}),
						write: async (bytes, writeOptions) => {
							writeOptions.signal.throwIfAborted();
							if (closed) throw new TypeError("CANVAS_CHAT_LULL_STREAM_CLOSED");
							frames.push(...(await relay(toBase64(bytes))).map((frame) => fromBase64(frame)));
						},
					});
				},
			};
			track.ports.add(port);
			Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => port);
			const decoded = Object.fromEntries(OFFER_FIELDS.map((field) => [field, fromBase64(required(offer[field]))]));
			const started = performance.now();
			await room.installCreatorSuccessor({
				offer: decoded as unknown as Parameters<typeof room.installCreatorSuccessor>[0]["offer"],
				peers: [peers[0]],
			});
			return performance.now() - started;
		},
		authorityEpoch: async () => room.authority()?.epoch ?? null,
		lull: async () => {
			const started = performance.now();
			const result = await room.maintainRecoveryPool();
			return { ms: performance.now() - started, kind: kindOf(result) };
		},
		accepted: async (from: number) => acceptedOrder.slice(from),
		census: () => host.census(name),
		drainEvents: async () => {
			const events = env.events ?? [];
			const out: ObservedEvent[] = events.slice(drained).map((event) => ({ kind: String(event.kind) }));
			drained = events.length;
			return out;
		},
		close: async () => {
			await room.close();
			track.rooms.delete(room);
			await floor.close();
			track.heads.delete(floor);
		},
	} satisfies RoleEndpoint);
}
