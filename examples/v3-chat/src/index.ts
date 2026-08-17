import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createV3RoomSession,
	type V3RoomAcceptedVertex,
	type V3RoomApplication,
	type V3RoomCreatorInviteMaterial,
	type V3RoomSession,
	type V3RoomTransport,
} from "@ts-drp/example-v3-room";
import { Keychain } from "@ts-drp/keychain";
import { type DRPNetworkNode, type Message, MessageType } from "@ts-drp/types";

const OBJECT_ID = `creator:${"d".repeat(32)}`;
const CHAT_ARTIFACT_SOURCE = `function aclReducer(input){return {output:input.operation,state:input.state}}function joinReducer(input){return {output:input.operation.clientId,state:input.state}}function messageReducer(input){const state=[...input.state,input.operation.text];return {output:input.operation.text,state}}export const blueprint={exportSchemaVersion:1,artifactId:"v3-chat.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{acl:aclReducer,join:joinReducer,message:messageReducer}};`;
const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const CLIENT_IDS = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"] as const;
type ClientId = (typeof CLIENT_IDS)[number];

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

interface JoinInput {
	readonly channelName: string;
	readonly clientId: ClientId;
	readonly databaseName: string;
	readonly invite: string;
}

interface CreateInput {
	readonly channelName: string;
	readonly clientId: "alice";
	readonly databaseName: string;
}

interface AcceptedMessage {
	readonly author: string;
	readonly authorSequence: number;
	readonly digest: string;
	readonly logicalTime: number;
	readonly text: string;
}

interface ChatSnapshot {
	readonly accepted: readonly AcceptedMessage[];
	readonly acceptedOperationDigest: string;
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
			readonly group: "admin" | "finality" | "writer";
			readonly kind: "grant" | "revoke";
			readonly targetClientId: ClientId;
		}>[];
	}>;
	readonly ready: boolean;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." | "";
}

interface ActiveChat {
	readonly accepted: Map<string, AcceptedMessage>;
	readonly clientAuthors: Readonly<Record<ClientId, string>>;
	readonly room: V3RoomSession;
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
			readonly group: "admin" | "finality" | "writer";
			readonly kind: "grant" | "revoke";
			readonly target: string;
		}>;
	}>[];
}

interface LatchedMember {
	readonly author: string;
	readonly groups: readonly ("admin" | "finality" | "writer")[];
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

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortedMessages(accepted: Map<string, AcceptedMessage>): readonly AcceptedMessage[] {
	return Object.freeze(
		[...accepted.values()]
			.sort(
				(left, right) =>
					left.logicalTime - right.logicalTime ||
					compareText(left.author, right.author) ||
					left.authorSequence - right.authorSequence ||
					compareText(left.digest, right.digest)
			)
			.map((entry) => Object.freeze({ ...entry }))
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
	const operationIdentities = accepted.map(({ digest: identity }) => identity);
	const transcript = accepted.map(({ author, authorSequence, digest: identity, logicalTime, text }) => ({
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

function applicationMaterial(): ApplicationMaterial {
	const exactArtifactBytes = new TextEncoder().encode(CHAT_ARTIFACT_SOURCE);
	const artifactDigest = digest("ts-drp/blueprint-artifact/v3", exactArtifactBytes);
	const blueprintPackage = Object.freeze({
		kind: "drp-blueprint-admission-package",
		protocolMajor: 3,
		schemaVersion: 1,
		implementation: Object.freeze({
			artifactId: "v3-chat.v1",
			artifactDigest,
			runtimeProfile: "ecmascript-2024-sync-v1",
		}),
		manifest: Object.freeze({
			schemaVersion: 1,
			operationDiscriminator: "action",
			operations: Object.freeze([
				Object.freeze({
					name: "acl",
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([
							Object.freeze({ name: "group", required: true, type: "string" }),
							Object.freeze({ name: "kind", required: true, type: "string" }),
							Object.freeze({ name: "target", required: true, type: "string" }),
						]),
					}),
				}),
				Object.freeze({
					name: "join",
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "clientId", required: true, type: "string" })]),
					}),
				}),
				Object.freeze({
					name: "message",
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "text", required: true, type: "string" })]),
					}),
				}),
			]),
		}),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
	const blueprintDigest = digest("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes);
	const catalogDigest = digest("ts-drp/d9336-chat-catalog/v1", canonicalBlueprintPackageBytes);
	const resolved = Object.freeze({
		artifactDigest,
		artifactId: "v3-chat.v1",
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		runtimeProfile: "ecmascript-2024-sync-v1" as const,
		evidence: Object.freeze({
			catalogDigest,
			lintEvidenceDigest: "a".repeat(64),
			conformanceReceiptDigest: "b".repeat(64),
			conformanceDigest: "c".repeat(64),
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines: Object.freeze([
				Object.freeze({ name: "node" as const, build: "d9336" }),
				Object.freeze({ name: "chromium" as const, build: "d9336" }),
				Object.freeze({ name: "firefox" as const, build: "d9336" }),
				Object.freeze({ name: "webkit" as const, build: "d9336" }),
			]),
		}),
	});
	return Object.freeze({
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest,
			resolve(requested: string) {
				if (requested !== blueprintDigest) throw new TypeError("unknown v3 chat blueprint");
				return resolved;
			},
		}),
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

async function createCreatorInviteMaterial(): Promise<V3RoomCreatorInviteMaterial> {
	const keychains = await Promise.all(CLIENT_IDS.map((clientId) => createLocalKeychain(clientId)));
	const alice = keychains[0];
	if (alice === undefined) throw new TypeError("v3 chat creator keychain is unavailable");
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
		objectId: OBJECT_ID,
		permissionless: false,
		version: 1,
	});
	const application = applicationMaterial();
	const signerSet = Object.freeze([Object.freeze({ publicKey: alice.localAuthorId, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: "creator-trusted-v1",
		quorum: 1,
		signers: signerSet,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	const exactCanonicalGenesisAnchorPreimageBytes = encodeCanonical({
		aclDigest: digest("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: application.blueprintDigest,
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes),
		previousAnchor: "0".repeat(64),
		profileDigest: digest("ts-drp/profile/v3", exactCanonicalProfileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", exactCanonicalSignerSetBytes),
		stateDigest: "7".repeat(64),
	});
	const anchorDigestBytes = hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalGenesisAnchorPreimageBytes);
	return Object.freeze({
		detachedGenesisSignature: await alice.signWithLocalAuthor(anchorDigestBytes),
		exactCanonicalLatchedAclBytes,
		exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: hex(anchorDigestBytes),
	});
}

function createRoomNetwork(peerId: string, channelName: string): V3RoomTransport {
	const channel = new BroadcastChannel(channelName);
	const topics = new Set<string>();
	let ingressHandler = (_message: Message): void => undefined;
	let retainedPublisher = (): Promise<void> => Promise.resolve();
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
		getAllPeers: (): [] => [],
		getGroupPeers: (): [] => [],
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		publishMessage: (topic: string, message: Message): Promise<true> => {
			channel.postMessage({ message, topic });
			return Promise.resolve(true);
		},
		gossipTopicFor: (message: Message): string | undefined =>
			message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE && topics.has(message.objectId)
				? message.objectId
				: undefined,
		sendMessage: (): Promise<void> => Promise.resolve(),
		sendGroupMessageRandomPeer: (): Promise<void> => Promise.resolve(),
		subscribeToMessageQueue: (): void => undefined,
	} as unknown as DRPNetworkNode;
	channel.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (typeof event.data !== "object" || event.data === null) return;
		if (
			Reflect.get(event.data, "kind") === "d9338-retained-history-request" &&
			Reflect.get(event.data, "requester") !== peerId
		) {
			void retainedPublisher().catch(() => undefined);
			return;
		}
		const topic = Reflect.get(event.data, "topic");
		const message = Reflect.get(event.data, "message");
		if (typeof topic !== "string" || !topics.has(topic) || typeof message !== "object" || message === null) return;
		ingressHandler(message as Message);
	});
	return Object.freeze({
		networkNode: node,
		close(): void {
			channel.close();
		},
		requestRetainedHistory(): void {
			channel.postMessage({ kind: "d9338-retained-history-request", requester: peerId });
		},
		setIngressHandler(handler: (message: Message) => void): void {
			ingressHandler = handler;
		},
		setRetainedPublisher(publisher: () => Promise<void>): void {
			retainedPublisher = publisher;
		},
	});
}

function acceptVertex(accepted: Map<string, AcceptedMessage>, vertex: V3RoomAcceptedVertex): void {
	const text = Reflect.get(vertex.operation, "text");
	if (Reflect.get(vertex.operation, "action") !== "message" || typeof text !== "string") return;
	const identity = hex(vertex.digest);
	accepted.set(
		identity,
		Object.freeze({
			author: vertex.author,
			authorSequence: vertex.authorSequence,
			digest: identity,
			logicalTime: vertex.logicalTime,
			text,
		})
	);
}

async function joinRoom(
	input: Omit<JoinInput, "invite"> & Readonly<{ readonly creatorInvite: string | V3RoomCreatorInviteMaterial }>
): Promise<ActiveChat> {
	const application = applicationMaterial();
	const selected = CLIENTS[input.clientId];
	const clientAuthors = await createClientAuthors();
	const keychain = await createLocalKeychain(input.clientId);
	const author = keychain.localAuthorId;
	const accepted = new Map<string, AcceptedMessage>();
	const room = await createV3RoomSession({
		application: Object.freeze({
			bootstrapOperation: Object.freeze({ action: "join", clientId: input.clientId }),
			canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
			catalog: application.catalog,
		}),
		author,
		creatorInvite: input.creatorInvite,
		databaseName: input.databaseName,
		initialLogicalTime: selected.logicalTime,
		objectId: OBJECT_ID,
		openTransport: () => createRoomNetwork(author, input.channelName),
		onAcceptedVertex: (vertex) => acceptVertex(accepted, vertex),
		publicKeyBytes: bytes(author),
		signRegisteredVertexDigest: (registeredDigest) => keychain.signWithLocalAuthor(registeredDigest),
	});
	return Object.freeze({
		accepted,
		clientAuthors,
		room,
	});
}

let active: ActiveChat | undefined;

const api = Object.freeze({
	async create(input: CreateInput): Promise<string> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		const material = await createCreatorInviteMaterial();
		active = await joinRoom({ ...input, creatorInvite: material });
		return active.room.invite;
	},
	async join(input: JoinInput): Promise<void> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		active = await joinRoom({
			channelName: input.channelName,
			clientId: input.clientId,
			creatorInvite: input.invite,
			databaseName: input.databaseName,
		});
	},
	async send(text: string): Promise<void> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (typeof text !== "string" || text.length === 0) throw new TypeError("v3 chat message is empty");
		await selected.room.issue(Object.freeze({ action: "message", text }));
	},
	async submitAcl(
		operation: Readonly<{
			readonly group: "admin" | "finality" | "writer";
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
	async close(): Promise<void> {
		const selected = active;
		active = undefined;
		if (selected === undefined) return;
		await selected.room.close();
	},
});

Object.defineProperty(globalThis, "d9336V3Chat", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
