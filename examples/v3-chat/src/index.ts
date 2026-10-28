import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	createV3RoomSession,
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomAcceptedOperation,
	type V3RoomApplication,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHead,
	type V3RoomHeadAuthority,
	type V3RoomMigrationActivationReceipt,
	type V3RoomMigrationProjection,
	type V3RoomMigrationRehearsalReceipt,
	type V3RoomProjectionInput,
	type V3RoomRolloverPolicy,
	type V3RoomSession,
	type V3RoomSuccessorAuthority,
	type V3RoomSuccessorDelivery,
	type V3RoomTransport,
} from "@ts-drp/example-v3-room";
import { Keychain } from "@ts-drp/keychain";
import { createRecoverableFinalitySigner, type FinalitySigner } from "@ts-drp/keychain/finality";
import { type DRPNetworkNode, type Message, MessageType } from "@ts-drp/types";

import catalogMaterial from "./catalog-material.json" with { type: "json" };
import { V3_CHAT_GENESIS_PROFILE } from "./profile.js";
import { V3_CHAT_ROLLOVER_BUDGET } from "./rollover.js";
import {
	createV3ChatSnapshotPort,
	createV3ChatSuccessorNode,
	type SnapshotChunkProtocolPort,
} from "./successor-network.js";

const OBJECT_ID = `creator:${"d".repeat(32)}`;
const CREATOR_FINALITY_KEYCHAIN_SEED = "d107d-v3-chat-creator-finality";
const PARAMETERS = Object.freeze({
	authorShareMultiplier: 4,
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const CLIENT_IDS = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

// Floors begin above the bootstrap vertex's resumed value (logical time 1 + stride 2).
const CLIENTS: Readonly<Record<ClientId, Readonly<{ logicalTime: number; seed: string }>>> = Object.freeze({
	alice: Object.freeze({ logicalTime: 3, seed: "d9336-v3-chat-alice" }),
	bob: Object.freeze({ logicalTime: 4, seed: "d9336-v3-chat-bob" }),
	carol: Object.freeze({ logicalTime: 5, seed: "d9339-v3-chat-carol" }),
	dave: Object.freeze({ logicalTime: 6, seed: "d9339-v3-chat-dave" }),
	erin: Object.freeze({ logicalTime: 7, seed: "d9339-v3-chat-erin" }),
	frank: Object.freeze({ logicalTime: 8, seed: "d9339-v3-chat-frank" }),
	grace: Object.freeze({ logicalTime: 9, seed: "d9339-v3-chat-grace" }),
	heidi: Object.freeze({ logicalTime: 10, seed: "d9339-v3-chat-heidi" }),
});
const ACL_VIEW_CLIENT_IDS = ["alice", "bob", "dave"] as const;
/**
 * Test override only. By default the creator rolls the room over by the demo's policy
 * (rollover.ts) and announces each successor, and members install it through the successor
 * delivery. A harness that seals, adopts and installs by hand sets this global to "manual" before
 * it creates or joins a room: the room then opens with the demo's composition before it rolled
 * over by itself (no policy, no delivery, no successor serving).
 */
const ROLLOVER_OVERRIDE = "__TS_DRP_V3_CHAT_ROLLOVER__";

interface JoinInput {
	readonly roomHeadAuthority: V3RoomHeadAuthority;
	readonly channelName: string;
	readonly clientId: ClientId;
	readonly databaseName: string;
	readonly invite: string;
	readonly roomHead?: V3RoomHead;
}

interface RoomJoinInput extends Omit<JoinInput, "invite"> {
	readonly creatorFinalitySigner?: FinalitySigner;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
}

interface CreateInput {
	readonly roomHeadAuthority: V3RoomHeadAuthority;
	readonly channelName: string;
	readonly clientId: "alice";
	readonly databaseName: string;
}

interface AcceptedMessage {
	readonly author: string;
	readonly authorSequence: number;
	readonly clientOperationId: string;
	readonly digest: string;
	readonly logicalTime: number;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly text: string;
}

interface SnapshotAcceptedMessage {
	readonly clientOperationId: string;
	readonly provenance: "authenticated-snapshot";
	readonly text: string;
}

type ProjectedMessage = AcceptedMessage | SnapshotAcceptedMessage;

interface ChatProjection {
	readonly accepted: readonly ProjectedMessage[];
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

const authenticatedBaseProjections = new WeakSet<ChatProjection>();

interface ChatSnapshot {
	readonly accepted: readonly ProjectedMessage[];
	readonly acceptedOperationDigest: string;
	readonly authority: V3RoomSuccessorAuthority | null;
	readonly durableTranscriptDigest: string;
	readonly latchedAcl: Readonly<{
		readonly currentEpoch: number;
		readonly currentGroups: Readonly<Partial<Record<ClientId, readonly string[]>>>;
		readonly nextDigest: string;
		readonly nextEpoch: number;
		readonly nextGroups: Readonly<Partial<Record<ClientId, readonly string[]>>>;
		readonly nextSignerClientIds: readonly ClientId[];
		readonly stagedOperationDigest: string;
		readonly stagedOperationCount: number;
		readonly stagedOperations: readonly Readonly<{
			readonly actorClientId: ClientId;
			readonly digest: string;
			readonly group: "admin" | "finality" | "referee" | "writer";
			readonly kind: "grant" | "revoke";
			readonly targetClientId: ClientId;
		}>[];
	}>;
	readonly ready: boolean;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." | "";
}

interface ActiveChat {
	readonly accepted: Map<string, ProjectedMessage>;
	/** The room's rollover policy and successor delivery (absent in "manual" mode). */
	readonly policy: V3RoomRolloverPolicy | undefined;
	readonly delivery: V3RoomSuccessorDelivery | undefined;
	closeSuccessorNode(): void;
	readonly clientId: ClientId;
	readonly clientAuthors: Readonly<Record<ClientId, string>>;
	readonly databaseName: string;
	readonly migrationInvites: Map<string, V3RoomCreatorInviteMaterial>;
	readonly objectId: string;
	readonly room: V3RoomSession;
}

interface CreatorAuthorityMaterial {
	readonly material: V3RoomCreatorInviteMaterial;
	readonly signer: FinalitySigner;
}

interface LatchedPreview {
	readonly current: Readonly<{ readonly epoch: number; readonly members: readonly LatchedMember[] }>;
	readonly next: Readonly<{ readonly epoch: number; readonly members: readonly LatchedMember[] }>;
	readonly nextDigest: string;
	readonly nextSigners: readonly Readonly<{ readonly publicKey: string }>[];
	readonly stagedOperations: readonly Readonly<{
		readonly actor: string;
		readonly digest: string;
		readonly operation: Readonly<{
			readonly group: "admin" | "finality" | "referee" | "writer";
			readonly kind: "grant" | "revoke";
			readonly target: string;
		}>;
	}>[];
}

interface LatchedMember {
	readonly author: string;
	readonly groups: readonly ("admin" | "finality" | "referee" | "writer")[];
}

interface ApplicationMaterial {
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: V3RoomApplication["catalog"];
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("v3 chat hex value is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function migrationTargetObjectId(sourceObjectId: string, rehearsalNonce: Uint8Array): string {
	const separator = sourceObjectId.indexOf(":");
	if (separator <= 0 || separator === sourceObjectId.length - 1) {
		throw new TypeError("v3 chat migration source object id is invalid");
	}
	const identity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce: new Uint8Array(rehearsalNonce), sourceObjectId })
	);
	const targetObjectId = `${sourceObjectId.slice(0, separator)}:${hex(identity.subarray(0, 16))}`;
	if (targetObjectId === sourceObjectId) throw new TypeError("v3 chat migration target object id is invalid");
	return targetObjectId;
}

function prepareChatMigration(
	operations: readonly V3RoomAcceptedOperation[],
	exactCanonicalSourceStateBytes?: Uint8Array
): V3RoomMigrationProjection {
	const identities = new Set<string>();
	const messages = operations
		.flatMap((row) => {
			if (Reflect.get(row.operation, "action") !== "message") return [];
			const clientOperationId = Reflect.get(row.operation, "clientOperationId");
			const text = Reflect.get(row.operation, "text");
			if (typeof clientOperationId !== "string" || clientOperationId.length === 0 || typeof text !== "string") {
				throw new TypeError("v3 chat migration message is invalid");
			}
			if (identities.has(clientOperationId)) throw new TypeError("v3 chat migration identity conflicts");
			identities.add(clientOperationId);
			return [Object.freeze({ clientOperationId, row, text })];
		})
		.sort(
			(left, right) =>
				left.row.logicalTime - right.row.logicalTime ||
				compareText(left.row.author, right.row.author) ||
				left.row.authorSequence - right.row.authorSequence ||
				compareText(left.row.vertexDigest, right.row.vertexDigest) ||
				left.row.operationIndex - right.row.operationIndex
		);
	const state = Object.freeze(
		(exactCanonicalSourceStateBytes === undefined ? messages : snapshotMessages(exactCanonicalSourceStateBytes)).map(
			({ clientOperationId, text }) => Object.freeze({ clientOperationId, text })
		)
	);
	const sourceIdentities = new Set<string>();
	for (const { clientOperationId } of state) {
		if (sourceIdentities.has(clientOperationId)) throw new TypeError("v3 chat migration identity conflicts");
		sourceIdentities.add(clientOperationId);
	}
	return Object.freeze({
		exactCanonicalApplicationStateBytes: encodeCanonical(state),
		importOperations: Object.freeze(
			state.map(({ clientOperationId, text }) => Object.freeze({ action: "message", clientOperationId, text }))
		),
	});
}

function isSnapshotAcceptedMessage(message: ProjectedMessage): message is SnapshotAcceptedMessage {
	return "provenance" in message && message.provenance === "authenticated-snapshot";
}

function sortedMessages(accepted: Map<string, ProjectedMessage>): readonly ProjectedMessage[] {
	const messages = [...accepted.values()];
	return Object.freeze(
		[
			...messages.filter(isSnapshotAcceptedMessage),
			...messages
				.filter((message): message is AcceptedMessage => !isSnapshotAcceptedMessage(message))
				.sort(
					(left, right) =>
						left.logicalTime - right.logicalTime ||
						compareText(left.author, right.author) ||
						left.authorSequence - right.authorSequence ||
						compareText(left.digest, right.digest)
				),
		].map((entry) => Object.freeze({ ...entry }))
	);
}

function previewLatchedAcl(active: ActiveChat): LatchedPreview {
	return active.room.previewLatchedAcl() as unknown as LatchedPreview;
}

function clientIdForAuthor(active: ActiveChat, author: string): ClientId {
	const found = CLIENT_IDS.find((clientId) => active.clientAuthors[clientId] === author);
	if (found === undefined) throw new TypeError("v3 chat ACL author is unknown");
	return found;
}

function visibleGroups(
	active: ActiveChat,
	members: readonly LatchedMember[]
): Readonly<Partial<Record<ClientId, readonly string[]>>> {
	return Object.freeze(
		Object.fromEntries(
			ACL_VIEW_CLIENT_IDS.map((clientId) => {
				const member = members.find(({ author }) => author === active.clientAuthors[clientId]);
				return [clientId, Object.freeze([...(member?.groups ?? [])])] as const;
			})
		)
	);
}

function snapshot(active: ActiveChat | undefined): ChatSnapshot {
	const accepted = active === undefined ? Object.freeze([]) : sortedMessages(active.accepted);
	const liveAccepted = accepted.filter((message): message is AcceptedMessage => !isSnapshotAcceptedMessage(message));
	const operationIdentities = liveAccepted.map(({ digest: identity }) => identity);
	const transcript = liveAccepted.map(({ author, authorSequence, digest: identity, logicalTime, text }) => ({
		author,
		authorSequence,
		digest: identity,
		logicalTime,
		text,
	}));
	const preview = active === undefined ? undefined : previewLatchedAcl(active);
	const stagedOperations =
		active === undefined || preview === undefined
			? Object.freeze([])
			: Object.freeze(
					preview.stagedOperations.map(({ actor, digest: identity, operation }) =>
						Object.freeze({
							actorClientId: clientIdForAuthor(active, actor),
							digest: identity,
							group: operation.group,
							kind: operation.kind,
							targetClientId: clientIdForAuthor(active, operation.target),
						})
					)
				);
	return Object.freeze({
		accepted,
		acceptedOperationDigest: digest("ts-drp/d9336-chat-accepted-operations/v1", encodeCanonical(operationIdentities)),
		authority: active?.room.authority() ?? null,
		durableTranscriptDigest: digest("ts-drp/d9336-chat-durable-transcript/v1", encodeCanonical(transcript)),
		latchedAcl: Object.freeze({
			currentEpoch: preview?.current.epoch ?? 0,
			currentGroups:
				active === undefined || preview === undefined
					? Object.freeze({})
					: visibleGroups(active, preview.current.members),
			nextDigest: preview?.nextDigest ?? "",
			nextEpoch: preview?.next.epoch ?? 0,
			nextGroups:
				active === undefined || preview === undefined ? Object.freeze({}) : visibleGroups(active, preview.next.members),
			nextSignerClientIds:
				active === undefined || preview === undefined
					? Object.freeze([])
					: Object.freeze(preview.nextSigners.map(({ publicKey }) => clientIdForAuthor(active, publicKey))),
			stagedOperationCount: stagedOperations.length,
			stagedOperationDigest: digest(
				"ts-drp/d9341-chat-staged-acl-operations/v1",
				encodeCanonical(stagedOperations.map(({ digest: identity }) => identity))
			),
			stagedOperations,
		}),
		ready: active !== undefined,
		roomId: active?.room.roomId ?? "",
		trustStatus: active?.room.trustStatus ?? "",
	});
}

const CHAT_CATALOG = openTrustedBlueprintCatalogBytes({
	catalogBytes: bytes(catalogMaterial.catalogBytes),
	assets: Object.fromEntries(
		Object.entries(catalogMaterial.assets).map(([filename, value]) => [filename, bytes(value)])
	),
});

function applicationMaterial(): ApplicationMaterial {
	const blueprintDigest = CHAT_CATALOG.blueprintDigests[0];
	if (blueprintDigest === undefined || CHAT_CATALOG.blueprintDigests.length !== 1) {
		throw new TypeError("v3 chat requires its exact single-entry catalog");
	}
	return Object.freeze({
		blueprintDigest,
		canonicalBlueprintPackageBytes: CHAT_CATALOG.resolve(blueprintDigest).canonicalBlueprintPackageBytes,
		catalog: CHAT_CATALOG,
	});
}

/**
 * Encodes the durable chat projection shared by genesis and migration.
 * @param projection - Product-owned durable chat state.
 * @returns Exact canonical durable chat state bytes.
 */
function canonicalChatStateBytes(projection: ChatProjection): Uint8Array {
	const snapshotDerived = authenticatedBaseProjections.has(projection);
	return encodeCanonical(
		(snapshotDerived
			? [...projection.accepted]
			: [...projection.accepted].sort((left, right) => {
					if (isSnapshotAcceptedMessage(left) || isSnapshotAcceptedMessage(right)) return 0;
					return (
						left.logicalTime - right.logicalTime ||
						compareText(left.author, right.author) ||
						left.authorSequence - right.authorSequence ||
						compareText(left.digest, right.digest) ||
						left.operationIndex - right.operationIndex
					);
				})
		).map(({ clientOperationId, text }) => Object.freeze({ clientOperationId, text }))
	);
}

/**
 * Creates the one production chat composition installed by the room entry path.
 * @param clientId - Client identity encoded by the bootstrap join operation.
 * @returns Exact blueprint, catalog, bootstrap and projection authority.
 */
export function createV3ChatApplication(clientId: ClientId): V3RoomApplication<ChatProjection> {
	const material = applicationMaterial();
	return Object.freeze({
		batchableOperationActions: Object.freeze(["message"]),
		bootstrapOperation: Object.freeze({ action: "join", clientId }),
		canonicalBlueprintPackageBytes: material.canonicalBlueprintPackageBytes,
		catalog: material.catalog,
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) => {
			const identity = Reflect.get(operation, "clientOperationId");
			if (typeof identity !== "string" || identity.length === 0) {
				throw new TypeError("v3 chat client operation identity is invalid");
			}
			return identity;
		},
		displacementPolicies: Object.freeze({ message: "rebase" as const }),
		migration: Object.freeze({
			canonicalStateBytes: canonicalChatStateBytes,
			prepare: prepareChatMigration,
		}),
		projectAcceptedOperations: projectChat,
	});
}

async function createLocalKeychain(clientId: ClientId): Promise<Keychain> {
	const keychain = new Keychain({ private_key_seed: CLIENTS[clientId].seed });
	await keychain.start();
	return keychain;
}

async function createClientAuthors(): Promise<Readonly<Record<ClientId, string>>> {
	const entries = await Promise.all(
		CLIENT_IDS.map(async (clientId) => {
			const keychain = await createLocalKeychain(clientId);
			return [clientId, keychain.localAuthorId] as const;
		})
	);
	return Object.freeze(Object.fromEntries(entries) as Record<ClientId, string>);
}

async function keychainLocalAuthorSeed(configuredSeed: string): Promise<Uint8Array> {
	const encodedSeed = new TextEncoder().encode(configuredSeed);
	const seed = new Uint8Array(await crypto.subtle.digest("SHA-512", encodedSeed));
	const domain = new TextEncoder().encode("ts-drp-keychain/local-author-ed25519/v1");
	const preimage = new Uint8Array(domain.byteLength + 1 + seed.byteLength);
	preimage.set(domain, 0);
	preimage[domain.byteLength] = 0;
	preimage.set(seed, domain.byteLength + 1);
	return new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
}

async function createCreatorAuthorityMaterial(objectId = OBJECT_ID): Promise<CreatorAuthorityMaterial> {
	const keychains = await Promise.all(CLIENT_IDS.map((clientId) => createLocalKeychain(clientId)));
	const alice = keychains[0];
	if (alice === undefined) throw new TypeError("v3 chat creator keychain is unavailable");
	const finalityKeychain = new Keychain({ private_key_seed: CREATOR_FINALITY_KEYCHAIN_SEED });
	await finalityKeychain.start();
	const finality = await createRecoverableFinalitySigner({
		seed: await keychainLocalAuthorSeed(CREATOR_FINALITY_KEYCHAIN_SEED),
	});
	if (
		hex(finality.publicKey) !== finalityKeychain.localAuthorId ||
		finalityKeychain.localAuthorId === alice.localAuthorId
	) {
		throw new TypeError("v3 chat creator finality identity is invalid");
	}
	const authors = Object.fromEntries(
		CLIENT_IDS.map((clientId, index) => [clientId, keychains[index]?.localAuthorId] as const)
	) as Record<ClientId, string>;
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: CLIENT_IDS.map((clientId) => {
			const groups =
				clientId === "alice"
					? ["admin", "finality", "writer"]
					: clientId === "bob"
						? ["admin", "writer"]
						: clientId === "dave"
							? ["finality"]
							: ["writer"];
			return Object.freeze({
				author: authors[clientId],
				finalityKey: clientId === "alice" || clientId === "dave" ? authors[clientId] : null,
				groups: Object.freeze(groups),
			});
		}).sort((left, right) => compareText(left.author, right.author)),
		objectId,
		permissionless: false,
		version: V3_CHAT_GENESIS_PROFILE.latchedAclVersion,
	});
	const application = applicationMaterial();
	const signerSet = Object.freeze([Object.freeze({ publicKey: finalityKeychain.localAuthorId, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: V3_CHAT_GENESIS_PROFILE.profileId,
		quorum: 1,
		signers: signerSet,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	const material = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: application.blueprintDigest,
		exactCanonicalApplicationStateBytes: canonicalChatStateBytes(
			projectChat(Object.freeze({ authenticatedBase: undefined, currentEpochOperations: Object.freeze([]) }))
		),
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		objectId,
		signGenesisAnchorDigest: (anchorDigest) => finalityKeychain.signWithLocalAuthor(anchorDigest),
	});
	return Object.freeze({ material, signer: finality.signer });
}

async function createCreatorInviteMaterial(objectId = OBJECT_ID): Promise<V3RoomCreatorInviteMaterial> {
	return (await createCreatorAuthorityMaterial(objectId)).material;
}

function createRoomNetwork(
	peerId: string,
	channelName: string,
	knownPeerIds: readonly string[],
	successors: boolean
): V3RoomTransport {
	const channel = new BroadcastChannel(channelName);
	const topics = new Set<string>();
	const retainedDeliveries = new WeakSet<Message>();
	let liveIngressHandler = (_message: Message): void => undefined;
	let retainedIngressHandler = (_message: Message): void => undefined;
	let retainedPublisher: (targetPeerId?: string) => Promise<void> = () => Promise.resolve();
	const node = {
		peerId,
		membershipVerifier: undefined,
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		restart: (): Promise<void> => Promise.resolve(),
		isDialable: (): Promise<boolean> => Promise.resolve(true),
		changeTopicScoreParams: (): void => undefined,
		removeTopicScoreParams: (): void => undefined,
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
		connectToBootstraps: (): Promise<void> => Promise.resolve(),
		connect: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getBootstrapNodes: (): [] => [],
		getSubscribedTopics: (): string[] => [...topics],
		getMultiaddrs: (): [] => [],
		getAllPeers: (): string[] => knownPeerIds.filter((knownPeerId) => knownPeerId !== peerId),
		getGroupPeers: (): [] => [],
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		publishMessage: (topic: string, message: Message): Promise<true> => {
			channel.postMessage({ message, topic });
			return Promise.resolve(true);
		},
		gossipTopicFor: (message: Message): string | undefined =>
			message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE &&
			!retainedDeliveries.has(message) &&
			topics.has(message.objectId)
				? message.objectId
				: undefined,
		sendMessage: (targetPeerId: string, message: Message): Promise<void> => {
			channel.postMessage({ message, retained: true, targetPeerId, topic: message.objectId });
			return Promise.resolve();
		},
		sendGroupMessageRandomPeer: (): Promise<void> => Promise.resolve(),
		subscribeToMessageQueue: (): void => undefined,
		// The room serves and fetches successor material on this protocol (the creator after each
		// adoption, a member at each install).
		...(successors
			? {
					createSnapshotChunkProtocolHost: (protocol?: string): SnapshotChunkProtocolPort =>
						createV3ChatSnapshotPort(peerId, channelName, knownPeerIds, protocol ?? "snapshot"),
				}
			: {}),
	} as unknown as DRPNetworkNode;
	channel.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (typeof event.data !== "object" || event.data === null) return;
		if (
			Reflect.get(event.data, "kind") === "d9338-retained-history-request" &&
			Reflect.get(event.data, "requester") !== peerId
		) {
			const requester = Reflect.get(event.data, "requester");
			if (typeof requester === "string") {
				void Promise.all([retainedPublisher(requester), retainedPublisher()]).catch(() => undefined);
			}
			return;
		}
		const topic = Reflect.get(event.data, "topic");
		const message = Reflect.get(event.data, "message");
		const targetPeerId = Reflect.get(event.data, "targetPeerId");
		if (
			typeof topic !== "string" ||
			!topics.has(topic) ||
			typeof message !== "object" ||
			message === null ||
			(typeof targetPeerId === "string" && targetPeerId !== peerId)
		) {
			return;
		}
		const delivered = message as Message;
		if (Reflect.get(event.data, "retained") === true) {
			retainedDeliveries.add(delivered);
			retainedIngressHandler(delivered);
		} else {
			liveIngressHandler(delivered);
		}
	});
	return Object.freeze({
		networkNode: node,
		close(): void {
			channel.close();
		},
		openEphemeral(): never {
			throw new TypeError("v3 chat ephemeral transport is not configured");
		},
		requestRetainedHistory(): void {
			channel.postMessage({ kind: "d9338-retained-history-request", requester: peerId });
		},
		setIngressHandler(
			_ingressId: string,
			liveHandler: (message: Message) => void,
			retainedHandler: (message: Message) => void
		): void {
			liveIngressHandler = liveHandler;
			retainedIngressHandler = retainedHandler;
		},
		setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void {
			retainedPublisher = publisher;
		},
	});
}

function authenticatedSnapshotMessages(
	input: V3RoomProjectionInput["authenticatedBase"]
): readonly SnapshotAcceptedMessage[] {
	if (input === undefined) return Object.freeze([]);
	return snapshotMessages(input.exactCanonicalApplicationStateBytes);
}

function snapshotMessages(exactCanonicalApplicationStateBytes: Uint8Array): readonly SnapshotAcceptedMessage[] {
	let decoded: unknown;
	try {
		decoded = decodeCanonical(exactCanonicalApplicationStateBytes);
	} catch {
		throw new TypeError("v3 chat authenticated projection base is invalid");
	}
	if (!Array.isArray(decoded) || !sameBytes(encodeCanonical(decoded), exactCanonicalApplicationStateBytes)) {
		throw new TypeError("v3 chat authenticated projection base is invalid");
	}
	return Object.freeze(
		decoded.map((value) => {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				throw new TypeError("v3 chat authenticated projection base is invalid");
			}
			const keys = Reflect.ownKeys(value);
			const clientOperationId = Reflect.get(value, "clientOperationId");
			const text = Reflect.get(value, "text");
			if (
				keys.length !== 2 ||
				!keys.every((key) => key === "clientOperationId" || key === "text") ||
				typeof clientOperationId !== "string" ||
				clientOperationId.length === 0 ||
				typeof text !== "string"
			) {
				throw new TypeError("v3 chat authenticated projection base is invalid");
			}
			return Object.freeze({ clientOperationId, provenance: "authenticated-snapshot" as const, text });
		})
	);
}

function projectChat(input: V3RoomProjectionInput): ChatProjection {
	const base = authenticatedSnapshotMessages(input.authenticatedBase);
	const identities = new Map<string, Uint8Array>();
	const accepted = input.currentEpochOperations.flatMap((acceptedOperation) => {
		const operation = acceptedOperation.operation;
		const action = Reflect.get(operation, "action");
		if (action === "migrationActivation" || action === "migrationRecord") return [];
		const clientOperationId = Reflect.get(operation, "clientOperationId");
		const text = Reflect.get(operation, "text");
		if (action !== "message") return [];
		const keys = Reflect.ownKeys(operation);
		if (
			keys.length !== 3 ||
			!keys.every((key) => key === "action" || key === "clientOperationId" || key === "text") ||
			typeof clientOperationId !== "string" ||
			clientOperationId.length === 0 ||
			typeof text !== "string"
		) {
			throw new TypeError("v3 chat message operation is invalid");
		}
		const identity = `${acceptedOperation.author}\u0000${clientOperationId}`;
		const operationBytes = encodeCanonical(operation);
		const prior = identities.get(identity);
		if (prior !== undefined) {
			if (!sameBytes(prior, operationBytes)) throw new TypeError("v3 chat message identity conflicts");
			return [];
		}
		identities.set(identity, operationBytes);
		return [
			Object.freeze({
				author: acceptedOperation.author,
				authorSequence: acceptedOperation.authorSequence,
				clientOperationId,
				digest: acceptedOperation.vertexDigest,
				logicalTime: acceptedOperation.logicalTime,
				operationCount: acceptedOperation.operationCount,
				operationIndex: acceptedOperation.operationIndex,
				text,
			}),
		];
	});
	const projection = Object.freeze({
		accepted: Object.freeze([...base, ...accepted]),
		transportPeerAuthors: Object.freeze([]),
		writerAuthors: Object.freeze([]),
	});
	if (input.authenticatedBase !== undefined) authenticatedBaseProjections.add(projection);
	return projection;
}

async function joinRoom(input: RoomJoinInput): Promise<ActiveChat> {
	const application = createV3ChatApplication(input.clientId);
	const selected = CLIENTS[input.clientId];
	const clientAuthors = await createClientAuthors();
	const keychain = await createLocalKeychain(input.clientId);
	const author = keychain.localAuthorId;
	const accepted = new Map<string, ProjectedMessage>();
	let redirectedRoom: V3RoomSession<ChatProjection> | undefined;
	let currentObjectId = OBJECT_ID;
	const source = { room: undefined as V3RoomSession<ChatProjection> | undefined };
	const roomChannelName = (openedObjectId: string): string =>
		`${input.channelName}--${digest("ts-drp/v3-chat-room-channel/v1", encodeCanonical({ objectId: openedObjectId }))}`;
	const knownPeerIds = Object.values(clientAuthors);
	// The demo's own rollover (rollover.ts) and successor delivery on the room's channel. Only the
	// creator's open holds the finality signer, so only it seals; members install each successor
	// the delivery brings. A migration target is not rolled over (its source's policy and delivery
	// end at the redirect).
	const automatic = Reflect.get(globalThis, ROLLOVER_OVERRIDE) !== "manual";
	const role = input.creatorFinalitySigner === undefined ? "member" : "creator";
	const successorNode = automatic
		? createV3ChatSuccessorNode(author, roomChannelName(OBJECT_ID), knownPeerIds)
		: undefined;
	const delivery =
		successorNode === undefined
			? undefined
			: createV3RoomSuccessorDelivery({
					role,
					objectId: OBJECT_ID,
					channel: createV3RoomSuccessorChannel(successorNode, OBJECT_ID),
					// The demo's peers are its authors; the object id carries no creator routing hint.
					creatorPeer: clientAuthors.alice,
					hooks: {
						onError: (error) => console.warn("v3 chat successor delivery failed; it is retried", error),
						onRefused: (error) => console.warn("v3 chat successor offer was refused", error),
					},
				});
	const policy =
		delivery === undefined
			? undefined
			: createV3RoomRolloverPolicy({
					role,
					budget: V3_CHAT_ROLLOVER_BUDGET,
					hooks: {
						publishSuccessor: (offer, epoch): Promise<void> => delivery.publish(offer, epoch),
						requestSuccessor: () => delivery.request(),
						creatorReachable: () => delivery.creatorReachable(),
						onError: (error) => console.warn("v3 chat rollover failed; it is retried", error),
					},
				});
	const endSuccessors = (): void => {
		policy?.close();
		delivery?.close();
		successorNode?.close();
	};
	let room: V3RoomSession<ChatProjection>;
	try {
		room = await createV3RoomSession({
			application,
			author,
			...(input.creatorFinalitySigner === undefined ? {} : { creatorFinalitySigner: input.creatorFinalitySigner }),
			creatorInvite: input.creatorInvite,
			databaseName: input.databaseName,
			initialLogicalTime: selected.logicalTime,
			issuanceDatabaseName: input.databaseName,
			migrationDatabaseNamespace: input.databaseName,
			objectId: OBJECT_ID,
			openTransport: (openedObjectId) =>
				createRoomNetwork(author, roomChannelName(openedObjectId), knownPeerIds, automatic),
			// The policy ends at a migration redirect, so it counts the source room only.
			onAcceptedVertex: (vertex) => policy?.observe(vertex),
			onMigrationTarget: (target, targetObjectId): void => {
				redirectedRoom = target;
				currentObjectId = targetObjectId;
				endSuccessors();
				if (source.room !== undefined) retainedSourceBridges.add(source.room);
			},
			onProjection: (projection): void => {
				accepted.clear();
				for (const [index, message] of projection.accepted.entries()) {
					accepted.set(
						isSnapshotAcceptedMessage(message)
							? `authenticated-snapshot:${index}:${message.clientOperationId}`
							: `${message.digest}:${message.operationIndex}`,
						message
					);
				}
			},
			publicKeyBytes: bytes(author),
			roomHeadAuthority: input.roomHeadAuthority,
			signRegisteredVertexDigest: (registeredDigest) => keychain.signWithLocalAuthor(registeredDigest),
		});
	} catch (error) {
		endSuccessors();
		throw error;
	}
	source.room = room;
	if (redirectedRoom !== undefined) retainedSourceBridges.add(room);
	else {
		policy?.bind(room);
		delivery?.bind(room);
	}
	return Object.freeze({
		accepted,
		get policy(): V3RoomRolloverPolicy | undefined {
			return redirectedRoom === undefined ? policy : undefined;
		},
		get delivery(): V3RoomSuccessorDelivery | undefined {
			return redirectedRoom === undefined ? delivery : undefined;
		},
		closeSuccessorNode: endSuccessors,
		clientId: input.clientId,
		clientAuthors,
		databaseName: input.databaseName,
		migrationInvites: new Map<string, V3RoomCreatorInviteMaterial>(),
		get objectId(): string {
			return currentObjectId;
		},
		get room(): V3RoomSession<ChatProjection> {
			return redirectedRoom ?? room;
		},
	});
}

let active: ActiveChat | undefined;
const retainedSourceBridges = new Set<V3RoomSession<ChatProjection>>();

const api = Object.freeze({
	async create(input: CreateInput): Promise<string> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		const authority = await createCreatorAuthorityMaterial();
		active = await joinRoom({
			...input,
			creatorFinalitySigner: authority.signer,
			creatorInvite: authority.material,
		});
		return active.room.invite;
	},
	async join(input: JoinInput): Promise<void> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		active = await joinRoom({
			roomHeadAuthority: input.roomHeadAuthority,
			channelName: input.channelName,
			clientId: input.clientId,
			creatorInvite: input.invite,
			databaseName: input.databaseName,
			...(input.roomHead === undefined ? {} : { roomHead: input.roomHead }),
		});
	},
	async adoptSuccessor(): Promise<void> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		await selected.room.adoptCreatorSuccessor();
	},
	async inspectDurableHead(databaseName: string) {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (databaseName !== selected.databaseName) throw new TypeError("v3 chat database identity differs");
		const inspected = await selected.room.inspectDurableHead();
		return Object.freeze({
			generationId: inspected.head.generationId,
			references: inspected.references,
			revision: inspected.head.revision,
			trustRef: inspected.trustRef,
		});
	},
	async sealEpoch() {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		return selected.room.sealEpoch();
	},
	async send(text: string): Promise<void> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (typeof text !== "string" || text.length === 0) throw new TypeError("v3 chat message is empty");
		// Through the rollover policy, so a message refused at a capacity a rollover clears is offered
		// again after it.
		await (selected.policy ?? selected.room).issue(
			Object.freeze({ action: "message", clientOperationId: crypto.randomUUID(), text })
		);
	},
	/**
	 * The room's rollover and successor delivery, for the page's status line and tests.
	 * @returns The policy's state and counts and the delivery's counts (null in "manual" mode).
	 */
	rollover() {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		const { policy, delivery } = selected;
		return Object.freeze({
			policy: policy === undefined ? null : Object.freeze({ ...policy.stats(), status: policy.status() }),
			delivery: delivery?.stats() ?? null,
		});
	},
	async rehearseMigration(): Promise<V3RoomMigrationRehearsalReceipt> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (selected.clientId !== "alice") throw new TypeError("v3 chat migration requires the creator");
		const rehearsalNonce = new Uint8Array(32);
		crypto.getRandomValues(rehearsalNonce);
		const targetObjectId = migrationTargetObjectId(selected.objectId, rehearsalNonce);
		const targetCreatorInvite = await createCreatorInviteMaterial(targetObjectId);
		const receipt = await selected.room.rehearseMigration({
			rehearsalNonce,
			targetCreatorInvite,
		});
		selected.migrationInvites.set(targetObjectId, targetCreatorInvite);
		return receipt;
	},
	async activateMigration(receipt: V3RoomMigrationRehearsalReceipt): Promise<V3RoomMigrationActivationReceipt> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (selected.clientId !== "alice") throw new TypeError("v3 chat migration requires the creator");
		const record = decodeCanonical(receipt.exactCanonicalRecordBytes);
		const nonce = record !== null && typeof record === "object" ? Reflect.get(record, "rehearsalNonce") : undefined;
		const targetObjectId =
			record !== null && typeof record === "object" ? Reflect.get(record, "targetObjectId") : undefined;
		if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32 || typeof targetObjectId !== "string") {
			throw new TypeError("v3 chat migration receipt is invalid");
		}
		const targetCreatorInvite = selected.migrationInvites.get(targetObjectId);
		if (targetCreatorInvite === undefined) throw new TypeError("v3 chat migration invite is unavailable");
		const activated = await selected.room.activateMigration({
			exactCanonicalRecordBytes: new Uint8Array(receipt.exactCanonicalRecordBytes),
			recordVertexDigest: receipt.recordVertexDigest,
			targetCreatorInvite,
		});
		selected.migrationInvites.delete(targetObjectId);
		return activated;
	},
	async submitAcl(
		operation: Readonly<{
			readonly group: "admin" | "finality" | "referee" | "writer";
			readonly kind: "grant" | "revoke";
			readonly targetClientId: ClientId;
		}>
	): Promise<void> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (!(operation.targetClientId in CLIENTS)) throw new TypeError("v3 chat ACL target is invalid");
		await selected.room.issue(
			Object.freeze({
				action: "acl",
				group: operation.group,
				kind: operation.kind,
				target: selected.clientAuthors[operation.targetClientId],
			})
		);
	},
	snapshot(): ChatSnapshot {
		return snapshot(active);
	},
	status() {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		return selected.room.status();
	},
	async close(): Promise<void> {
		const selected = active;
		active = undefined;
		const sources = [...retainedSourceBridges];
		retainedSourceBridges.clear();
		selected?.closeSuccessorNode();
		await Promise.all([selected?.room.close(), ...sources.map((source) => source.close())]);
	},
});

Object.defineProperty(globalThis, "d9336V3Chat", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
