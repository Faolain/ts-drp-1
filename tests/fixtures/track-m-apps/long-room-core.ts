/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement fixture: transparent inference keeps the native capability signatures. */
/* eslint-disable @typescript-eslint/require-await -- Every RoleEndpoint method is async so the browser proxy and the in-process endpoint share one contract. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
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

import { genesisProfileFor } from "./genesis-profile.js";
import {
	type AppKind,
	type ArchiveObservation,
	type ChatFormat,
	fromBase64,
	type HostKind,
	type LongRoomOptions,
	type ObservedEvent,
	type RoleEndpoint,
	type RolloverObservation,
	type StoreCensus,
	toBase64,
	type WireOffer,
	type WireRow,
} from "./long-room-driver.js";
import { CANVAS_ROLLOVER_BUDGET } from "../../../examples/canvas/src/rollover.js";
import { openShippingChatCatalogs } from "../../../examples/chat/src/chat-catalogs.js";
import {
	shippingChatRefusalClearedByRollover,
	shippingChatRolloverBudget,
} from "../../../examples/chat/src/rollover.js";
import {
	createShippingChatGenesisStateBytes,
	createShippingChatSharesGenesisStateBytes,
	createShippingChatWindowGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../../../examples/chat/src/v3-chat-application.js";
import {
	openShippingChatLocalArchive,
	type ShippingChatArchiveStore,
} from "../../../examples/chat/src/v3-chat-archive.js";
import { GRID_ROLLOVER_BUDGET } from "../../../examples/grid/src/rollover.js";
import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createBrowserV3RoomDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomProjectionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import {
	createV3RoomRolloverPolicy,
	type V3RoomRolloverEvent,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
} from "../../../examples/v3-room/src/rollover.js";
import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../../../examples/v3-room/src/successor-delivery.js";
import { toCanvasWireOperation } from "../../../packages/blueprints/src/v3-canvas.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { createV3CanvasApplication } from "../../../packages/node/src/applications/canvas.js";
import { readCreatorSuccessorExport } from "../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";

// Track M measurement (Canvas and Chat), one role of a long room as a `RoleEndpoint`
// (tests/fixtures/track-m-apps/long-room-driver.ts drives two of them). Platform-neutral:
// under vitest both roles live in one process (tests/fixtures/track-m-apps/app-long-room.ts:
// the Node SQLite host, or the browser hosts on fake-indexeddb); in a browser each role is
// one page on its own origin (tests/fixtures/track-m-apps/browser/), because two rooms of
// one object in one origin contend for the same Web Locks writer lock. Observation only:
// the census and the export read open their own handles (or their own IndexedDB
// connection) and never reach into a node or owner object. Nothing here is a bound or a
// grant.

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
	/** This role's observer events (in one shared process, give them to one role only). */
	readonly events?: Readonly<Record<string, unknown>>[];
	/** Recipient: carries one material request to the creator's `dispatch`. */
	relay?(request: string): Promise<string[]>;
	/**
	 * Track W (Chat window format): opens this role's device archive store in its own database
	 * (never a room database) and its census. Without it the role keeps no archive.
	 */
	openArchive?(name: string): Promise<Readonly<{ store: ShippingChatArchiveStore; census(): Promise<StoreCensus> }>>;
	/**
	 * App mode: the room this role's successor delivery binds to (default: the room itself). A test
	 * wraps it to model a slow host, e.g. an install that starts late.
	 */
	deliveryRoom?(room: Awaited<ReturnType<typeof createV3RoomSession>>): Parameters<V3RoomSuccessorDelivery["bind"]>[0];
}

export interface LongRoomHost {
	readonly storageHost: unknown;
	/** Separate handles for the delivery's reads (never the room's own owners). */
	readonly observe: Readonly<{
		openIssuance(name: string): ReturnType<typeof createBrowserDurableIssuanceStore>;
		openAhe(name: string): ReturnType<typeof createBrowserAheDurableStore>;
		openJournal(name: string): ReturnType<typeof createBrowserDurableLiveJournalStore>;
		openSnapshots(name: string): ReturnType<typeof createBrowserSnapshotQuarantineStore>;
	}>;
	census(name: string): Promise<StoreCensus>;
}

/**
 *
 * @param bytes
 */
export const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
/**
 *
 * @param value
 */
export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("TRACK_M_APPS_REQUIRED_FIXTURE_VALUE");
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

/**
 * Rows and value payload bytes of every object store of one database (its own connection).
 * @param database
 */
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

/**
 * Every database of one role on the six-database host, by database suffix.
 * @param prefix
 */
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
 * six-database host (examples/v3-room `browserStorageHost`, the same original owner
 * factories); "room" / "room-retention" = the room-database host without and with
 * `roomRetention: true`.
 * @param kind - The browser host kind.
 * @param unique - Unique per run.
 * @returns The host, its observation handles and its census.
 */
export function browserHostFor(kind: Exclude<HostKind, "node">, unique: string): LongRoomHost {
	const prefix = `tma-${kind === "browser" ? "b" : "r"}-${hex(hashDomain("track-m-apps-host/v1", new TextEncoder().encode(unique))).slice(0, 16)}`;
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
	const retention = kind === "room-retention";
	const base = createBrowserV3RoomDatabaseStorageHost(retention ? { roomRetention: true } : {});
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
		...(retention ? { roomRetention: true as const } : {}),
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
const CANVAS_SIDE = 10;
// Measurement only: TRACK_M_APPS_CHAT_PAD=<n> appends n characters to every Chat message text, so a
// short run fills the format's retained state (default 0: the unchanged short texts).
const CHAT_PAD = Number(process.env.TRACK_M_APPS_CHAT_PAD ?? 0);

// A measurement-only true upper bound (both applications' whole retained state is far below
// it), so the creator's explicit lull is supported as on the Grid; neither shipped
// application supplies a reader, so without it the creator's lull reports `unsupported`.
const resourceBound = Object.assign(() => Object.freeze({ byteLength: 65_536, items: 16_384, maxDepth: 16 }), {});

async function applicationFor(
	app: AppKind,
	exactCanonicalLatchedAclBytes: Uint8Array,
	creatorLull: boolean,
	chatFormat: ChatFormat
) {
	if (app === "grid") {
		const acl = decodeCanonical(exactCanonicalLatchedAclBytes) as {
			members: { author: string; finalityKey: string | null }[];
		};
		const creator = required(acl.members.find((member) => member.finalityKey !== null)).author;
		const members = [...acl.members].sort(
			(left, right) => Number(right.author === creator) - Number(left.author === creator)
		);
		const roster = members.map(({ author }, order) => ({
			author,
			order,
			peerId: order === 0 ? "grid-creator" : "grid-recipient",
		}));
		const application = createV3ZoneApplication(roster, "grid-creator", creator);
		const genesis = required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		);
		return { application, genesis, admission: undefined, catalog: application.catalog };
	}
	if (app === "canvas") {
		const canvas = createV3CanvasApplication(CANVAS_SIDE, CANVAS_SIDE);
		const application = creatorLull
			? Object.freeze({ ...canvas, readOrdinaryApplicationResourceBound: resourceBound })
			: canvas;
		const genesis = required(canvas.migration).canonicalStateBytes(
			canvas.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		);
		return { application, genesis, admission: undefined, catalog: canvas.catalog };
	}
	// Track W: "window" measures the rolling-window format (v4); "lifetime" the version-3 format
	// rooms created before it keep. Track W2: "shares" measures the membership-aware format (v5)
	// the shipped Chat now signs into new rooms.
	const catalogs = openShippingChatCatalogs();
	const { catalog, blueprintDigest } =
		chatFormat === "lifetime" ? catalogs.lifetime : chatFormat === "shares" ? catalogs.shares : catalogs.window;
	const chat = await createShippingV3ChatApplication({
		catalog,
		blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	const application = creatorLull
		? Object.freeze({ ...chat, readOrdinaryApplicationResourceBound: resourceBound })
		: chat;
	return {
		application,
		genesis:
			chatFormat === "lifetime"
				? createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes })
				: chatFormat === "shares"
					? createShippingChatSharesGenesisStateBytes({ exactCanonicalLatchedAclBytes })
					: createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes }),
		admission: chat.createOperationAdmissionPolicy,
		catalog,
	};
}

function operationFor(app: AppKind, role: number, epoch: number, ordinal: number): Readonly<Record<string, unknown>> {
	if (app === "grid") return { action: "placeBlock", id: `block-${role}-${ordinal}`, kind: "stone", x: epoch, y: role };
	if (app === "canvas")
		return toCanvasWireOperation(
			{ action: "paint", offset: [(epoch + ordinal) % CANVAS_SIDE, role], rgb: [1 + role, 2 + (ordinal % 250), 3] },
			`paint-${role}-${epoch}-${ordinal}`
		);
	return Object.freeze({
		action: "message",
		clientOperationId: `m-${role}-${epoch}-${ordinal}`,
		displayTimeMs: 1_791_662_400_000 + epoch * 1000 + ordinal * 10 + role,
		text: `e${epoch} o${ordinal}` + "x".repeat(CHAT_PAD),
	});
}

/**
 * The network node surface the room touches here (tests/fixtures/phase-4b-v3 `fakeNetwork`, without call recording).
 * @param peerId
 */
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
 * App mode: the application's own rollover policy for one role, with the trigger values the
 * shipped page uses (examples/<app>/src/rollover.ts) and the shared scheduling of
 * examples/v3-room. Chat's long room signs the shares format, as the shipped Chat does.
 * @param app - The application.
 * @param role - The creator, or a member (a Writer or receive-only recipient).
 * @param context - The room's object.
 * @param hooks - Where the policy publishes its successor offers.
 * @returns The policy.
 */
function appRolloverPolicy(
	app: AppKind,
	role: "creator" | "member",
	context: Readonly<{ objectId: string; chatFormat: ChatFormat; override?: LongRoomOptions["rolloverBudget"] }>,
	hooks: V3RoomRolloverHooks
): V3RoomRolloverPolicy {
	const chat = app === "chat";
	const shipped =
		app === "canvas"
			? CANVAS_ROLLOVER_BUDGET
			: app === "grid"
				? GRID_ROLLOVER_BUDGET
				: shippingChatRolloverBudget({ objectId: context.objectId, shares: context.chatFormat === "shares" });
	return createV3RoomRolloverPolicy({
		role,
		budget: context.override ?? shipped,
		hooks: chat ? { ...hooks, clearedByRollover: shippingChatRefusalClearedByRollover } : hooks,
	});
}

/**
 * An error's message with its causes (and an aggregate's errors), for observation records.
 * @param error - The error.
 * @returns One line, at most 1000 characters.
 */
function describeError(error: unknown): string {
	const parts: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 6 || value === undefined) return;
		if (value instanceof AggregateError) for (const inner of value.errors) walk(inner, depth + 1);
		if (value instanceof Error) {
			const code = Reflect.get(value, "code");
			parts.push(`${value.name}: ${value.message}${typeof code === "string" ? ` [${code}]` : ""}`);
			walk(value.cause, depth + 1);
		} else parts.push(String(value));
	};
	walk(error, 0);
	return parts.join(" <- ").slice(0, 1000);
}

/**
 * Opens one role of the long room (0 = creator, 1 = recipient) as an endpoint. Both roles
 * derive the same object, ACL, application and creator invite from `options` and
 * `env.unique` (the invite signature is deterministic Ed25519).
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
	const objectId = `creator:${hex(hashDomain("track-m-apps-object/v1", new TextEncoder().encode(env.unique))).slice(0, 32)}`;
	const writerRecipient = options.recipient === "writer";
	const genesisProfile = genesisProfileFor(options);
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: [
			{ author: creator.author, finalityKey: creator.author, groups: ["admin", "finality", "writer"] },
			...(writerRecipient ? [{ author: recipientIdentity.author, finalityKey: null, groups: ["writer"] }] : []),
		].sort((left, right) => left.author.localeCompare(right.author)),
		objectId,
		permissionless: false,
		// The version the signed profile requires (version 3 exactly for the settlement profile).
		version: genesisProfile.latchedAclVersion,
	});
	const chatFormat = options.chatFormat ?? "window";
	const selected = await applicationFor(options.app, exactCanonicalLatchedAclBytes, options.creatorLull, chatFormat);
	const projectionInputs = new WeakMap<object, V3RoomProjectionInput>();
	const appMode = options.rollover === "app";
	// App mode: the last projection of each recent epoch. The application's own policy seals in the
	// background, so the closed cut is read back from here instead of at a harness seal.
	const lastProjections = new Map<number, Readonly<{ input: V3RoomProjectionInput; result: object }>>();
	const originalApplication = selected.application;
	const application = {
		...originalApplication,
		projectAcceptedOperations: (value: V3RoomProjectionInput) => {
			const result = originalApplication.projectAcceptedOperations(value);
			projectionInputs.set(result, value);
			if (appMode) {
				const epoch = value.authenticatedBase?.epoch ?? 0;
				lastProjections.set(epoch, { input: value, result });
				for (const kept of lastProjections.keys()) if (kept < epoch - 3) lastProjections.delete(kept);
			}
			return result;
		},
	};
	// Track W: the shipped Chat (window and shares formats) keeps a device archive fed by the
	// projection callback, as examples/chat does; observation reads its stats after each epoch.
	const archiveHandle =
		options.app === "chat" && chatFormat !== "lifetime" && env.openArchive !== undefined
			? await env.openArchive(name)
			: undefined;
	const archive =
		archiveHandle === undefined ? undefined : await openShippingChatLocalArchive({ store: archiveHandle.store });
	const observed = { calls: 0, ms: 0 };
	const observe = (projection: unknown): void => {
		if (archive === undefined) return;
		const started = performance.now();
		archive.observe(projection as ShippingChatProjection);
		observed.ms += performance.now() - started;
		observed.calls++;
	};
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: selected.genesis,
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: genesisProfile.profileId,
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
	const acceptedTimes = new Map<string, number>();
	let acceptedCount = 0;
	let lastAcceptedAt: number | null = null;
	let remoteAcceptedCount = 0;
	let lastRemoteAcceptedAt: number | null = null;
	const acknowledged = new Map<string, () => void>();
	const networkNode = loopbackNetwork(peers[index]);
	const receiveOnly = index === 1 && !writerRecipient;
	let scripted: ScriptedSnapshotChunkPort | undefined;
	// App mode: the role runs its application's own rollover policy, and successor offers travel by
	// the pages' own delivery (examples/v3-room successor-delivery): the creator's delivery announces
	// each adopted offer and answers requests; the member's delivery asks, authenticates by install
	// and installs. Only the wire is scripted: the delivery's frames wait in this role's outbox until
	// the driver carries them, as it carries signed rows (there is no libp2p in this harness).
	const successorOutbox: string[] = [];
	const successorListeners = new Set<(sender: string, bytes: Uint8Array) => void>();
	// Whether the other peer is connected on the successor channel (a driver may take it away to
	// model an unreachable creator; the delivery then reports the creator unreachable).
	let otherPeerConnected = true;
	// Every accepted vertex's identity and operation, own and remote (observation only).
	const acceptedVertices: { digest: string; author: string; epoch: number; authorSequence: number; operation: string }[] =
		[];
	const successorChannel: V3RoomSuccessorChannel = {
		localPeerId: peers[index],
		peers: () => (otherPeerConnected ? [peers[1 - index]] : []),
		send: (_peer, bytes, signal) => {
			signal.throwIfAborted();
			successorOutbox.push(toBase64(bytes));
			return Promise.resolve();
		},
		listen: (listener) => {
			successorListeners.add(listener);
			return () => successorListeners.delete(listener);
		},
		onPeerConnected: () => () => undefined,
		close: () => successorListeners.clear(),
	};
	const deliveryRefusals: string[] = [];
	const delivery = appMode
		? createV3RoomSuccessorDelivery({
				role: index === 0 ? "creator" : "member",
				objectId,
				// The scripted peers are not the object's creator routing hint.
				creatorPeer: peers[0],
				channel: successorChannel,
				hooks: {
					onRefused: (error) => deliveryRefusals.push(describeError(error)),
				},
			})
		: undefined;
	const rolloverEvents: (V3RoomRolloverEvent & Readonly<{ endedAt: number }>)[] = [];
	const rolloverErrors: string[] = [];
	const policy = appMode
		? appRolloverPolicy(
				options.app,
				index === 0 ? "creator" : "member",
				{ objectId, chatFormat, override: options.rolloverBudget },
				{
					publishSuccessor: (offer, successorEpoch) => required(delivery).publish(offer, successorEpoch),
					requestSuccessor: () => required(delivery).request(),
					// The page's reachability signal: whether the delivery sees the creator connected.
					creatorReachable: () =>
						(Reflect.get(required(delivery), "creatorReachable") as (() => boolean) | undefined)?.call(delivery) ??
						true,
					onRollover: (event) => rolloverEvents.push({ ...event, endedAt: performance.timeOrigin + performance.now() }),
					onError: (error) => rolloverErrors.push(error instanceof Error ? error.message : String(error)),
				}
			)
		: undefined;
	if (appMode && index === 0)
		// The creator's successor material host: a fresh scripted port per serving (the seal and the
		// export each open one); `dispatch` answers the recipient's requests on the newest. Only the
		// serving side of the port is used, so it needs no fixture.
		Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => {
			const port = new ScriptedSnapshotChunkPort(
				{ declaration: undefined, chunks: [] } as unknown as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
				new Map([[peers[1], "honest"]]),
				peers[0]
			);
			track.ports.add(port);
			scripted = port;
			return port;
		});
	// The recipient's material port: each request goes to the creator's material host through the
	// environment relay (the scripted material wire).
	const relayPort = (): SnapshotChunkProtocolPort => {
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
							if (closed) throw new TypeError("TRACK_M_APPS_STREAM_CLOSED");
							const frame = required(frames.shift());
							if (frame.byteLength > maximum) throw new TypeError("TRACK_M_APPS_MATERIAL_FRAME_LIMIT");
							return frame;
						}),
					write: async (bytes, writeOptions) => {
						writeOptions.signal.throwIfAborted();
						if (closed) throw new TypeError("TRACK_M_APPS_STREAM_CLOSED");
						frames.push(...(await relay(toBase64(bytes))).map((frame) => fromBase64(frame)));
					},
				});
			},
		};
		track.ports.add(port);
		return port;
	};
	// App mode: the member's delivery installs on its own, so its material host is always the relay.
	if (appMode && index === 1) Reflect.set(networkNode, "createSnapshotChunkProtocolHost", relayPort);
	const input = {
		application,
		storageHost: host.storageHost,
		author: identity.author,
		...(receiveOnly ? { receiveOnly: true as const } : {}),
		// App mode runs as the shipped pages do: the browser binding schedules one recovery-pool lull
		// per epoch after each adoption or install (examples/v3-room createV3RoomSession), where
		// harness mode calls `lull` itself.
		...(appMode ? { recoveryPoolScheduledLull: true } : {}),
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
		onProjection: observe,
		onAcceptedVertex: (
			vertex: Readonly<{ digest: Uint8Array; author: string; epoch: number; authorSequence?: number; operation?: unknown }>
		) => {
			policy?.observe(vertex);
			const digest = hex(vertex.digest);
			if (!accepted.has(digest)) {
				acceptedVertices.push({
					digest,
					author: vertex.author,
					epoch: vertex.epoch,
					authorSequence: vertex.authorSequence ?? -1,
					operation: JSON.stringify(vertex.operation ?? null),
				});
				acceptedCount++;
				lastAcceptedAt = performance.timeOrigin + performance.now();
				if (vertex.author !== identity.author) {
					remoteAcceptedCount++;
					lastRemoteAcceptedAt = lastAcceptedAt;
				}
			}
			accepted.add(digest);
			if (!acceptedTimes.has(digest)) acceptedTimes.set(digest, performance.timeOrigin + performance.now());
			acknowledged.get(digest)?.();
		},
		openTransport: () => {
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			return {
				networkNode,
				close: () => undefined,
				openEphemeral: () => {
					throw new TypeError("TRACK_M_APPS_EPHEMERAL_UNUSED");
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
	policy?.bind(room);
	await waitForV3RoomStartupForDiagnostics(room);
	delivery?.bind(env.deliveryRoom?.(room) ?? room);
	observe(room.projection());

	// The creator's genuine successor export over scripted native bytes; it grants nothing.
	const exported = async () => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("TRACK_M_APPS_INVALID_OBJECT");
		const store = await host.observe.openAhe("creator--ahe");
		const snapshotStore = await host.observe.openSnapshots("creator");
		const journalStore = await host.observe.openJournal("creator");
		try {
			const value = await readCreatorSuccessorExport({
				store,
				journalStore,
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
			await journalStore.close();
			await snapshotStore.close();
			await store.close();
		}
	};
	let drained = 0;
	const kindOf = (result: unknown) => {
		const value = result as { kind: string; reason?: string };
		return value.reason === undefined ? value.kind : `${value.kind}:${value.reason}`;
	};
	const inject = async (rows: readonly WireRow[]): Promise<void> => {
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
	};

	return Object.freeze({
		inject,
		acceptance: async (digests: readonly string[]) => digests.map((digest) => accepted.has(digest)),
		acceptedAt: async (digests: readonly string[]) => digests.map((digest) => acceptedTimes.get(digest) ?? null),
		acceptedVertices: async () => acceptedVertices.map((vertex) => ({ ...vertex })),
		// The room's own settlement observation (V3RoomSession.settlementStatus), when it has one.
		settlementStatus: async () =>
			(Reflect.get(room, "settlementStatus") as (() => unknown) | undefined)?.call(room) ?? null,
		// The application policy's status line (examples/v3-room rollover status()).
		rolloverStatus: async () => policy?.status() ?? null,
		// Takes the other peer off (or back onto) this role's successor channel.
		setPeerConnected: async (connected: boolean) => {
			otherPeerConnected = connected;
		},
		projectionAudit: async () => {
			const value = required(projectionInputs.get(room.projection()));
			return {
				base:
					value.authenticatedBase === undefined
						? null
						: {
								epoch: value.authenticatedBase.epoch,
								state: hex(value.authenticatedBase.exactCanonicalApplicationStateBytes),
							},
				operations: value.currentEpochOperations.map(({ author, operation }) => ({ author, operation })),
				acceptedCount,
				lastAcceptedAt,
				remoteAcceptedCount,
				lastRemoteAcceptedAt,
			};
		},
		settlementAudit: async () => {
			const store = await host.observe.openIssuance(name);
			try {
				const scope = { objectId, author: identity.author };
				const plan = await store.readSettlementPlan(scope);
				const missing: number[] = [];
				const dispositions: Record<string, number> = {};
				const replacements: {
					sourceDigest: string;
					sourceSequence: number;
					disposition: string;
					replacementDigests: string[];
				}[] = [];
				for (const entry of plan?.entries ?? []) {
					dispositions[entry.disposition] = (dispositions[entry.disposition] ?? 0) + 1;
					const sourceScope = entry.sourceObjectId === undefined ? scope : { ...scope, objectId: entry.sourceObjectId };
					if ((await store.readIssued(sourceScope, entry.sourceSequence)) === null) missing.push(entry.sourceSequence);
					const replacementDigests: string[] = [];
					for (const sequence of new Set([
						entry.replacementSequence,
						...(entry.replacementProgress?.chunks.map((chunk) => chunk.replacementSequence) ?? []),
					])) {
						if (sequence === null) continue;
						const row = await store.readIssued(scope, sequence);
						if (row === null) missing.push(sequence);
						else replacementDigests.push(hex(row.envelope.digest));
					}
					replacements.push({
						sourceDigest: hex(entry.sourceDigest),
						sourceSequence: entry.sourceSequence,
						disposition: entry.disposition,
						replacementDigests,
					});
				}
				return { entries: plan?.entries.length ?? 0, missing, dispositions, replacements };
			} finally {
				await store.close();
			}
		},
		issue: async (epoch: number, ordinal: number) => {
			const started = performance.now();
			const operation = operationFor(options.app, index, epoch, ordinal);
			await (policy === undefined ? room.issue(operation) : policy.issue(operation));
			return performance.now() - started;
		},
		// The same move straight to the room, past the application's rollover policy.
		issueRoom: async (epoch: number, ordinal: number) => {
			const started = performance.now();
			await room.issue(operationFor(options.app, index, epoch, ordinal));
			return performance.now() - started;
		},
		// Every published own row above `after`, in issue order (observation handle).
		published: async (after: number | null) => {
			const store = await host.observe.openIssuance(name);
			try {
				const rows = await store.readOutboxPage({
					scope: { objectId, author: identity.author },
					afterKey: after === null ? null : [objectId, identity.author, after],
					limit: 128,
				});
				return rows.map((row) => ({
					preimage: toBase64(row.commit.envelope.canonicalPreimageBytes),
					signature: toBase64(row.commit.envelope.signature),
					digest: hex(row.commit.envelope.digest),
					authorSequence: row.commit.authorSequence,
				}));
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
				timer = setTimeout(() => reject(new TypeError("TRACK_M_APPS_REMOTE_ADMISSION_TIMEOUT")), 120_000);
			});
			try {
				await inject(rows);
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
				throw new TypeError(`TRACK_M_APPS_SEAL_REFUSED ${JSON.stringify(sealed)}`);
			return ms;
		},
		adopt: async () => {
			const started = performance.now();
			await room.adoptCreatorSuccessor();
			return performance.now() - started;
		},
		// The creator room's own material host serves the export (as the Track M canvas fixture).
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
			// App mode carries offers by the pages' own delivery; harness offer passing is refused.
			if (appMode) throw new TypeError("TRACK_M_APPS_APP_MODE_HARNESS_OFFER_PASSING");
			const port = relayPort();
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
		currencyStatement: async () => room.currencyStatement?.() ?? null,
		confirmCurrent: async (statement: unknown) =>
			statement === null || room.confirmCurrent === undefined
				? "unsupported"
				: room.confirmCurrent(statement as Parameters<NonNullable<typeof room.confirmCurrent>>[0]),
		lull: async () => {
			const started = performance.now();
			const result = await room.maintainRecoveryPool();
			return { ms: performance.now() - started, kind: kindOf(result) };
		},
		census: () => host.census(name),
		archive: async (): Promise<ArchiveObservation | null> => {
			if (archive === undefined || archiveHandle === undefined) return null;
			await archive.flush();
			const stats = archive.stats();
			const estimate =
				typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function"
					? undefined
					: await navigator.storage.estimate();
			return {
				messages: stats.messages,
				bytes: stats.bytes,
				appended: stats.appended,
				evicted: stats.evicted,
				transactions: stats.transactions,
				transactionMs: stats.transactionMs,
				observes: observed.calls,
				observeMs: observed.ms,
				failures: stats.failures,
				database: await archiveHandle.census(),
				...(estimate?.usage === undefined ? {} : { originUsage: estimate.usage }),
			};
		},
		storageUsage: async (): Promise<number | null> => {
			if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") return null;
			return (await navigator.storage.estimate()).usage ?? null;
		},
		drainEvents: async () => {
			const events = env.events ?? [];
			const out: ObservedEvent[] = events.slice(drained).map((event) => ({
				kind: String(event.kind),
				...(event.outcome === undefined ? {} : { outcome: String(event.outcome) }),
				...(event.reason === undefined ? {} : { reason: String(event.reason) }),
			}));
			drained = events.length;
			return out;
		},
		successorFrames: async () => successorOutbox.splice(0),
		deliverSuccessorFrames: async (frames: readonly string[]) => {
			for (const frame of frames)
				for (const listener of [...successorListeners]) listener(peers[1 - index], fromBase64(frame));
		},
		successorDelivery: async () => {
			await delivery?.idle();
			const stats = delivery?.stats();
			return {
				epoch: room.authority()?.epoch ?? 0,
				installed: stats?.installed ?? 0,
				refused: stats?.refused ?? 0,
				announced: stats?.announced ?? 0,
				answered: stats?.answered ?? 0,
				requested: stats?.requested ?? 0,
				largestOfferBytes: stats?.largestOfferBytes ?? 0,
				refusals: [...deliveryRefusals],
				...(stats?.lastError === undefined ? {} : { lastError: stats.lastError }),
			};
		},
		closedProjection: async (epoch: number) => {
			const entry = lastProjections.get(epoch);
			if (entry === undefined) return null;
			const base = entry.input.authenticatedBase;
			return {
				base: base === undefined ? null : { epoch: base.epoch, state: hex(base.exactCanonicalApplicationStateBytes) },
				operations: entry.input.currentEpochOperations.map(({ author, operation }) => ({ author, operation })),
				state: hex(required(application.migration).canonicalStateBytes(entry.result as never)),
			};
		},
		rollover: async (): Promise<RolloverObservation> => {
			await policy?.settled();
			const stats = policy?.stats();
			return {
				epoch: stats?.epoch ?? room.authority()?.epoch ?? 0,
				rollovers: stats?.rollovers ?? 0,
				waiting: policy?.waiting() ?? 0,
				errors: [...rolloverErrors],
				events: [...rolloverEvents],
			};
		},
		close: async () => {
			policy?.close();
			delivery?.close();
			await room.close();
			track.rooms.delete(room);
			await floor.close();
			await archive?.close();
			track.heads.delete(floor);
		},
	} satisfies RoleEndpoint);
}
