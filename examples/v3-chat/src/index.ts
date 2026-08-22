import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createV3RoomSession,
	type V3RoomAcceptedOperation,
	type V3RoomApplication,
	type V3RoomCreatorInviteMaterial,
	type V3RoomMigrationActivationReceipt,
	type V3RoomMigrationProjection,
	type V3RoomMigrationRehearsalReceipt,
	type V3RoomSession,
	type V3RoomTransport,
} from "@ts-drp/example-v3-room";
import { Keychain } from "@ts-drp/keychain";
import { type DRPNetworkNode, type Message, MessageType } from "@ts-drp/types";

const OBJECT_ID = `creator:${"d".repeat(32)}`;
const CHAT_ARTIFACT_SOURCE = `function exactKeys(value,keys){return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key))}const migrationKeys=["applicationStateDigest","archivePolicy","authorityKind","exactCanonicalApplicationStateBytes","kind","rehearsalNonce","sourceAcceptedOperationCount","sourceAcceptedOperationsDigest","sourceAnchorDigest","sourceBlueprintDigest","sourceCreatorAuthor","sourceObjectId","targetAnchorDigest","targetBlueprintDigest","targetCreatorAuthor","targetImportOperationCount","targetImportOperationsDigest","targetObjectId","version"];function aclReducer(input){return {output:input.operation,state:input.state}}function applicationBatchReducer(input){const operation=input.operation;if(!exactKeys(operation,["action","batch"])||operation.action!=="applicationBatch"||!exactKeys(operation.batch,["entries","version"])||operation.batch.version!==1||!Array.isArray(operation.batch.entries)||operation.batch.entries.length<2||operation.batch.entries.length>16)throw new TypeError("invalid application batch");let prior=-1;const output=[];const state=[...input.state];for(const entry of operation.batch.entries){if(!exactKeys(entry,["logicalTime","operation"])||!Number.isSafeInteger(entry.logicalTime)||entry.logicalTime<0||entry.logicalTime<=prior||!exactKeys(entry.operation,["action","clientOperationId","text"])||entry.operation.action!=="message"||typeof entry.operation.clientOperationId!=="string"||entry.operation.clientOperationId.length===0||typeof entry.operation.text!=="string")throw new TypeError("invalid application batch entry");prior=entry.logicalTime;const message={clientOperationId:entry.operation.clientOperationId,text:entry.operation.text};state.push(message);output.push(message)}return {output,state}}function causalJoinReducer(input){return {output:null,state:input.state}}function joinReducer(input){return {output:input.operation.clientId,state:input.state}}function messageReducer(input){if(!exactKeys(input.operation,["action","clientOperationId","text"])||typeof input.operation.clientOperationId!=="string"||input.operation.clientOperationId.length===0||typeof input.operation.text!=="string")throw new TypeError("invalid message");const message={clientOperationId:input.operation.clientOperationId,text:input.operation.text};const state=[...input.state,message];return {output:message,state}}function migrationActivationReducer(input){const operation=input.operation;if(!exactKeys(operation,["action","decision"])||operation.action!=="migrationActivation"||operation.decision===null||typeof operation.decision!=="object"||Array.isArray(operation.decision))throw new TypeError("invalid migration activation");return {output:null,state:input.state}}function migrationRecordReducer(input){const operation=input.operation;const record=operation&&operation.record;if(!exactKeys(operation,["action","record"])||operation.action!=="migrationRecord"||!exactKeys(record,migrationKeys)||record.kind!=="ts-drp-v3-room-migration-record"||record.version!==1||record.archivePolicy!=="retain-source"||record.authorityKind!=="creator-ed25519-registered-vertex-v1")throw new TypeError("invalid migration record");return {output:null,state:input.state}}export const blueprint={exportSchemaVersion:1,artifactId:"v3-chat.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{acl:aclReducer,applicationBatch:applicationBatchReducer,causalJoin:causalJoinReducer,join:joinReducer,message:messageReducer,migrationActivation:migrationActivationReducer,migrationRecord:migrationRecordReducer}};`;
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
interface JoinInput {
	readonly channelName: string;
	readonly clientId: ClientId;
	readonly databaseName: string;
	readonly invite: string;
}

interface RoomJoinInput extends Omit<JoinInput, "invite"> {
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
}

interface CreateInput {
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

interface ChatProjection {
	readonly accepted: readonly AcceptedMessage[];
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
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
	readonly clientId: ClientId;
	readonly clientAuthors: Readonly<Record<ClientId, string>>;
	readonly objectId: string;
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

function prepareChatMigration(operations: readonly V3RoomAcceptedOperation[]): V3RoomMigrationProjection {
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
		messages.map(({ clientOperationId, text }) => Object.freeze({ clientOperationId, text }))
	);
	return Object.freeze({
		exactCanonicalApplicationStateBytes: encodeCanonical(state),
		importOperations: Object.freeze(
			state.map(({ clientOperationId, text }) => Object.freeze({ action: "message", clientOperationId, text }))
		),
	});
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
			schemaVersion: 2,
			operationDiscriminator: "action",
			workBudgetProfile: "blueprint-work-budget-v1",
			operations: Object.freeze([
				Object.freeze({
					name: "acl",
					maxCanonicalOperationBytes: 65_536,
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
					name: "applicationBatch",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "batch", required: true, type: "canonical-object" })]),
					}),
				}),
				Object.freeze({
					name: "causalJoin",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([]),
					}),
				}),
				Object.freeze({
					name: "join",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "clientId", required: true, type: "string" })]),
					}),
				}),
				Object.freeze({
					name: "message",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([
							Object.freeze({ name: "clientOperationId", required: true, type: "string" }),
							Object.freeze({ name: "text", required: true, type: "string" }),
						]),
					}),
				}),
				Object.freeze({
					name: "migrationActivation",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "decision", required: true, type: "canonical-object" })]),
					}),
				}),
				Object.freeze({
					name: "migrationRecord",
					maxCanonicalOperationBytes: 65_536,
					argumentSchema: Object.freeze({
						kind: "closed-record",
						fields: Object.freeze([Object.freeze({ name: "record", required: true, type: "canonical-object" })]),
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
			canonicalStateBytes: (projection: ChatProjection) =>
				encodeCanonical(
					[...projection.accepted]
						.sort(
							(left, right) =>
								left.logicalTime - right.logicalTime ||
								compareText(left.author, right.author) ||
								left.authorSequence - right.authorSequence ||
								compareText(left.digest, right.digest) ||
								left.operationIndex - right.operationIndex
						)
						.map(({ clientOperationId, text }) => Object.freeze({ clientOperationId, text }))
				),
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

async function createCreatorInviteMaterial(objectId = OBJECT_ID): Promise<V3RoomCreatorInviteMaterial> {
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
		objectId,
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
		objectId,
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

function createRoomNetwork(peerId: string, channelName: string, knownPeerIds: readonly string[]): V3RoomTransport {
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

function projectChat(operations: readonly V3RoomAcceptedOperation[]): ChatProjection {
	const identities = new Map<string, Uint8Array>();
	const accepted = operations.flatMap((acceptedOperation) => {
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
	return Object.freeze({
		accepted: Object.freeze(accepted),
		transportPeerAuthors: Object.freeze([]),
		writerAuthors: Object.freeze([]),
	});
}

async function joinRoom(input: RoomJoinInput): Promise<ActiveChat> {
	const application = createV3ChatApplication(input.clientId);
	const selected = CLIENTS[input.clientId];
	const clientAuthors = await createClientAuthors();
	const keychain = await createLocalKeychain(input.clientId);
	const author = keychain.localAuthorId;
	const accepted = new Map<string, AcceptedMessage>();
	let redirectedRoom: V3RoomSession<ChatProjection> | undefined;
	let currentObjectId = OBJECT_ID;
	const source = { room: undefined as V3RoomSession<ChatProjection> | undefined };
	const room: V3RoomSession<ChatProjection> = await createV3RoomSession({
		application,
		author,
		creatorInvite: input.creatorInvite,
		databaseName: input.databaseName,
		initialLogicalTime: selected.logicalTime,
		issuanceDatabaseName: input.databaseName,
		migrationDatabaseNamespace: input.databaseName,
		objectId: OBJECT_ID,
		openTransport: (openedObjectId) =>
			createRoomNetwork(
				author,
				`${input.channelName}--${digest(
					"ts-drp/v3-chat-room-channel/v1",
					encodeCanonical({ objectId: openedObjectId })
				)}`,
				Object.values(clientAuthors)
			),
		onAcceptedVertex: () => undefined,
		onMigrationTarget: (target, targetObjectId): void => {
			redirectedRoom = target;
			currentObjectId = targetObjectId;
			if (source.room !== undefined) retainedSourceBridges.add(source.room);
		},
		onProjection: (projection): void => {
			accepted.clear();
			for (const message of projection.accepted) {
				accepted.set(`${message.digest}:${message.operationIndex}`, message);
			}
		},
		publicKeyBytes: bytes(author),
		signRegisteredVertexDigest: (registeredDigest) => keychain.signWithLocalAuthor(registeredDigest),
	});
	source.room = room;
	if (redirectedRoom !== undefined) retainedSourceBridges.add(room);
	return Object.freeze({
		accepted,
		clientId: input.clientId,
		clientAuthors,
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
		await selected.room.issue(Object.freeze({ action: "message", clientOperationId: crypto.randomUUID(), text }));
	},
	async rehearseMigration(): Promise<V3RoomMigrationRehearsalReceipt> {
		const selected = active;
		if (selected === undefined) throw new TypeError("v3 chat client is not joined");
		if (selected.clientId !== "alice") throw new TypeError("v3 chat migration requires the creator");
		const rehearsalNonce = new Uint8Array(32);
		crypto.getRandomValues(rehearsalNonce);
		const targetObjectId = migrationTargetObjectId(selected.objectId, rehearsalNonce);
		return selected.room.rehearseMigration({
			rehearsalNonce,
			targetCreatorInvite: await createCreatorInviteMaterial(targetObjectId),
		});
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
		const targetCreatorInvite = await createCreatorInviteMaterial(targetObjectId);
		const activated = await selected.room.activateMigration({
			exactCanonicalRecordBytes: new Uint8Array(receipt.exactCanonicalRecordBytes),
			recordVertexDigest: receipt.recordVertexDigest,
			targetCreatorInvite,
		});
		return activated;
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
		const sources = [...retainedSourceBridges];
		retainedSourceBridges.clear();
		await Promise.all([selected?.room.close(), ...sources.map((source) => source.close())]);
	},
});

Object.defineProperty(globalThis, "d9336V3Chat", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
