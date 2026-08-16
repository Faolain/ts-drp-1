import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import { Keychain } from "@ts-drp/keychain";
import { MessageQueueManager } from "@ts-drp/message-queue";
import {
	activateV3LivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	routeV3Ingress,
	type V3AdmittedVertexSink,
	type V3PlaneHandle,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { parseStorageObjectId } from "@ts-drp/storage";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import { type DRPNetworkNode, type Message, MessageType } from "@ts-drp/types";

const OBJECT_ID = `creator:${"d".repeat(32)}`;
const CHAT_ARTIFACT_SOURCE = `function joinReducer(input){return {output:input.operation.clientId,state:input.state}}function messageReducer(input){const state=[...input.state,input.operation.text];return {output:input.operation.text,state}}export const blueprint={exportSchemaVersion:1,artifactId:"v3-chat.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{join:joinReducer,message:messageReducer}};`;
const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const CLIENTS = Object.freeze({
	alice: Object.freeze({ logicalTime: 2, seed: "d9336-v3-chat-alice" }),
	bob: Object.freeze({ logicalTime: 3, seed: "d9336-v3-chat-bob" }),
});

type ClientId = keyof typeof CLIENTS;

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
	readonly ready: boolean;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." | "";
}

interface ActiveChat {
	readonly accepted: Map<string, AcceptedMessage>;
	readonly aheStore: Awaited<ReturnType<typeof createBrowserAheDurableStore>>;
	readonly channel: BroadcastChannel;
	readonly handle: V3PlaneHandle;
	readonly issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
	readonly journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
	readonly keychain: Keychain;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	nextLogicalTime(): number;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
}

interface CreatorInviteMaterial {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

interface ApplicationMaterial {
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Readonly<{
		readonly blueprintDigests: readonly string[];
		readonly catalogDigest: string;
		resolve(digest: string): Readonly<Record<string, unknown>>;
	}>;
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
	return Object.freeze({
		accepted,
		acceptedOperationDigest: digest("ts-drp/d9336-chat-accepted-operations/v1", encodeCanonical(operationIdentities)),
		durableTranscriptDigest: digest("ts-drp/d9336-chat-durable-transcript/v1", encodeCanonical(transcript)),
		ready: active !== undefined,
		roomId: active?.roomId ?? "",
		trustStatus: active?.trustStatus ?? "",
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
			resolve(requested: string): Readonly<Record<string, unknown>> {
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

async function createCreatorInviteMaterial(): Promise<CreatorInviteMaterial> {
	const [alice, bob] = await Promise.all([createLocalKeychain("alice"), createLocalKeychain("bob")]);
	const orderedAuthors = Object.freeze([alice.localAuthorId, bob.localAuthorId].sort());
	const exactCanonicalAuthorAuthorizationBytes = encodeCanonical({
		authors: orderedAuthors,
		epoch: 0,
		kind: "drp-author-authorization",
		objectId: OBJECT_ID,
		profileId: "creator-author-authorization-v1",
		protocolMajor: 3,
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
		aclDigest: digest("ts-drp/author-authorization/v3", exactCanonicalAuthorAuthorizationBytes),
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
		exactCanonicalAuthorAuthorizationBytes,
		exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: hex(anchorDigestBytes),
	});
}

const CREATOR_INVITE_KEYS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalAuthorAuthorizationBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"kind",
	"pinnedGenesisAnchorDigest",
	"version",
]);

function encodeCreatorInvite(material: CreatorInviteMaterial): string {
	return hex(
		encodeCanonical({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalAuthorAuthorizationBytes: material.exactCanonicalAuthorAuthorizationBytes,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			kind: "d9337-v3-chat-creator-invite",
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			version: 1,
		})
	);
}

function inviteBytes(values: Record<string, unknown>, field: string): Uint8Array {
	const value = values[field];
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw new TypeError(`v3 chat creator invite ${field} is invalid`);
	}
	return new Uint8Array(value);
}

function decodeCreatorInvite(invite: string): CreatorInviteMaterial {
	const encoded = bytes(invite);
	const decoded = decodeCanonical(encoded, { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Object.getPrototypeOf(decoded) !== null ||
		!sameBytes(encodeCanonical(decoded), encoded)
	) {
		throw new TypeError("v3 chat creator invite is invalid");
	}
	const keys = Reflect.ownKeys(decoded);
	if (
		keys.length !== CREATOR_INVITE_KEYS.length ||
		keys.some((key) => typeof key !== "string" || !CREATOR_INVITE_KEYS.includes(key))
	) {
		throw new TypeError("v3 chat creator invite fields are invalid");
	}
	const record = decoded as Record<string, unknown>;
	const values = Object.fromEntries(
		CREATOR_INVITE_KEYS.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
				throw new TypeError("v3 chat creator invite field ownership is invalid");
			}
			return [key, descriptor.value] as const;
		})
	) as Record<(typeof CREATOR_INVITE_KEYS)[number], unknown>;
	if (values.kind !== "d9337-v3-chat-creator-invite" || values.version !== 1) {
		throw new TypeError("v3 chat creator invite version is invalid");
	}
	if (
		typeof values.pinnedGenesisAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(values.pinnedGenesisAnchorDigest)
	) {
		throw new TypeError("v3 chat creator invite anchor is invalid");
	}
	const detachedGenesisSignature = inviteBytes(values, "detachedGenesisSignature");
	if (detachedGenesisSignature.byteLength !== 64) {
		throw new TypeError("v3 chat creator invite signature is invalid");
	}
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalAuthorAuthorizationBytes: inviteBytes(values, "exactCanonicalAuthorAuthorizationBytes"),
		exactCanonicalGenesisAnchorPreimageBytes: inviteBytes(values, "exactCanonicalGenesisAnchorPreimageBytes"),
		exactCanonicalParametersCarrierBytes: inviteBytes(values, "exactCanonicalParametersCarrierBytes"),
		exactCanonicalProfileBytes: inviteBytes(values, "exactCanonicalProfileBytes"),
		exactCanonicalSignerSetBytes: inviteBytes(values, "exactCanonicalSignerSetBytes"),
		pinnedGenesisAnchorDigest: values.pinnedGenesisAnchorDigest,
	});
}

function createRoomNetwork(
	peerId: string,
	channelName: string
): Readonly<{
	readonly channel: BroadcastChannel;
	readonly networkNode: DRPNetworkNode;
	requestRetainedHistory(): void;
	setRetainedPublisher(publisher: () => Promise<void>): void;
}> {
	const channel = new BroadcastChannel(channelName);
	const topics = new Set<string>();
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
		routeV3Ingress(node, message as Message);
	});
	return Object.freeze({
		channel,
		networkNode: node,
		requestRetainedHistory(): void {
			channel.postMessage({ kind: "d9338-retained-history-request", requester: peerId });
		},
		setRetainedPublisher(publisher: () => Promise<void>): void {
			retainedPublisher = publisher;
		},
	});
}

function acceptVertex(accepted: Map<string, AcceptedMessage>, vertex: AdmittedReceivedVertexView): void {
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

function acceptedSink(accepted: Map<string, AcceptedMessage>): V3AdmittedVertexSink {
	return ({ vertex }) => acceptVertex(accepted, vertex);
}

async function joinRoom(input: JoinInput): Promise<ActiveChat> {
	const application = applicationMaterial();
	const invite = decodeCreatorInvite(input.invite);
	const selected = CLIENTS[input.clientId];
	const keychain = await createLocalKeychain(input.clientId);
	const author = keychain.localAuthorId;
	const objectIdResult = parseStorageObjectId(OBJECT_ID);
	if (!objectIdResult.ok) throw new TypeError("v3 chat object id is invalid");
	const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
	const trustStore = createCurrentAnchorTrustStore({
		objectId: objectIdResult.value,
		pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
		store: aheStore,
	});
	const installed = await trustStore.install({
		detachedGenesisSignature: invite.detachedGenesisSignature,
		exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalProfileBytes: invite.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes: invite.exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
	});
	if (!installed.ok && installed.reason !== "already-installed") {
		throw new TypeError(`v3 chat trust installation failed: ${installed.reason}`);
	}
	const openedTrust = installed.ok ? installed : await trustStore.open();
	if (!openedTrust.ok || openedTrust.trust.profileId !== "creator-trusted-v1") {
		throw new TypeError("v3 chat verified trust profile is invalid");
	}
	const prepared = await prepareV3LiveGeneration({
		authenticationProfile: "creator-only",
		store: aheStore,
		objectId: objectIdResult.value,
		pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
		exactCanonicalAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
		detachedSignature: invite.detachedGenesisSignature,
		exactCanonicalParametersCarrierBytes: invite.exactCanonicalParametersCarrierBytes,
		catalog: application.catalog as never,
	});
	if (!prepared.ok) throw new TypeError(`v3 chat preparation failed: ${prepared.kind}`);
	const issuanceStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: input.databaseName });
	const journalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
	const scope = Object.freeze({ author, objectId: OBJECT_ID });
	const lineage = await issuanceStore.readLineage(scope);
	if (lineage.next === 0) {
		const admission = prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
			expectedBlueprintDigest: prepared.descriptor.blueprintDigest,
		});
		const signer: SignRegisteredVertexDigest = (registeredDigest) => keychain.signWithLocalAuthor(registeredDigest);
		const issuer = createAdmissionBoundTransactionalVertexIssuer({
			author,
			preparedBlueprintAdmission: admission,
			publicKey: Object.freeze({ bytes: bytes(author), format: "raw" as const }),
			signRegisteredVertexDigest: signer,
			transactIssue: (selectedScope, buildAndSign) => issuanceStore.transactIssue(selectedScope, buildAndSign),
		});
		const bootstrap = await issuer.issue({
			anchor: invite.pinnedGenesisAnchorDigest,
			dependencies: [invite.pinnedGenesisAnchorDigest],
			epoch: 0,
			logicalTime: 1,
			objectId: OBJECT_ID,
			operation: Object.freeze({ action: "join", clientId: input.clientId }),
		});
		await issuanceStore.compareAndMarkOutboxPublished({
			authorSequence: bootstrap.authorSequence,
			digest: bootstrap.envelope.digest,
			scope,
		});
	}
	const recovered = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalAuthorAuthorizationBytes: invite.exactCanonicalAuthorAuthorizationBytes,
		issuanceScope: scope,
		issuanceStore,
		liveJournalStore: journalStore,
	});
	if (!recovered.ok) throw new TypeError(`v3 chat recovery failed: ${recovered.kind}`);
	const accepted = new Map<string, AcceptedMessage>();
	for (const vertex of recovered.descriptor.recoveredVertices) acceptVertex(accepted, vertex);
	const transport = createRoomNetwork(author, input.channelName);
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	const activated = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager,
		networkNode: transport.networkNode,
		onAdmittedVertex: acceptedSink(accepted),
	});
	if (!activated.ok) throw new TypeError(`v3 chat activation failed: ${activated.kind}`);
	transport.setRetainedPublisher(async () => {
		const result = await activated.handle.republishRetained();
		if (!result.ok) throw new TypeError(`v3 chat retained publication failed: ${result.kind}`);
	});
	transport.requestRetainedHistory();
	let logicalTime = [...accepted.values()].reduce<number>(
		(maximum, message) => Math.max(maximum, message.logicalTime + 2),
		selected.logicalTime
	);
	return Object.freeze({
		accepted,
		aheStore,
		channel: transport.channel,
		handle: activated.handle,
		issuanceStore,
		journalStore,
		keychain,
		messageQueueManager,
		networkNode: transport.networkNode,
		nextLogicalTime: () => {
			const current = logicalTime;
			logicalTime += 2;
			return current;
		},
		roomId: prepared.descriptor.anchorDigest,
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
	});
}

let active: ActiveChat | undefined;

const api = Object.freeze({
	async create(input: CreateInput): Promise<string> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		const material = await createCreatorInviteMaterial();
		const invite = encodeCreatorInvite(material);
		active = await joinRoom({ ...input, invite });
		return invite;
	},
	async join(input: JoinInput): Promise<void> {
		if (active !== undefined) throw new TypeError("v3 chat client is already joined");
		active = await joinRoom(input);
	},
	async send(text: string): Promise<void> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (typeof text !== "string" || text.length === 0) throw new TypeError("v3 chat message is empty");
		const issued = await selected.handle.issueLocal({
			dependencies: [selected.roomId],
			logicalTime: selected.nextLogicalTime(),
			operation: Object.freeze({ action: "message", text }),
			signRegisteredVertexDigest: (registeredDigest) => selected.keychain.signWithLocalAuthor(registeredDigest),
		});
		if (!issued.ok) throw new TypeError(`v3 chat issue failed: ${issued.kind}`);
		const published = await selected.handle.publishPending();
		if (!published.ok || published.kind !== "published") {
			throw new TypeError(`v3 chat publication failed: ${published.kind}`);
		}
	},
	snapshot(): ChatSnapshot {
		return snapshot(active);
	},
	async close(): Promise<void> {
		const selected = active;
		active = undefined;
		if (selected === undefined) return;
		selected.handle.deactivate();
		selected.messageQueueManager.closeAll();
		selected.channel.close();
		await Promise.all([selected.issuanceStore.close(), selected.journalStore.close(), selected.aheStore.close()]);
	},
});

Object.defineProperty(globalThis, "d9336V3Chat", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
