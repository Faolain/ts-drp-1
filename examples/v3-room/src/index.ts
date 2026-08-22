import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { MessageQueueManager } from "@ts-drp/message-queue";
import {
	activateV3LivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	republishV3RetainedTo,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3AdmittedVertexSink,
	type V3PlaneHandle,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

const CREATOR_INVITE_KEYS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalLatchedAclBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"kind",
	"pinnedGenesisAnchorDigest",
	"version",
]);
const MIGRATION_RECORD_KEYS = Object.freeze([
	"applicationStateDigest",
	"archivePolicy",
	"authorityKind",
	"exactCanonicalApplicationStateBytes",
	"kind",
	"rehearsalNonce",
	"sourceAcceptedOperationCount",
	"sourceAcceptedOperationsDigest",
	"sourceAnchorDigest",
	"sourceBlueprintDigest",
	"sourceCreatorAuthor",
	"sourceObjectId",
	"targetAnchorDigest",
	"targetBlueprintDigest",
	"targetCreatorAuthor",
	"targetImportOperationCount",
	"targetImportOperationsDigest",
	"targetObjectId",
	"version",
]);

function requiredIntrinsicGetter(prototype: object, property: string): (this: unknown) => unknown {
	const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
	if (getter === undefined) throw new TypeError(`required intrinsic getter is unavailable: ${property}`);
	return getter;
}

const INTRINSIC_ARRAY_BUFFER = ArrayBuffer;
const INTRINSIC_ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER = requiredIntrinsicGetter(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"byteLength"
);
const INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER = Object.getOwnPropertyDescriptor(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"resizable"
)?.get;
const INTRINSIC_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_TYPED_ARRAY_PROTOTYPE = INTRINSIC_GET_PROTOTYPE_OF(INTRINSIC_UINT8_ARRAY_PROTOTYPE) as object;
const INTRINSIC_TYPED_ARRAY_BUFFER_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "buffer");
const INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteLength");
const INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteOffset");

export interface V3RoomCreatorInviteMaterial {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

export type V3RoomAcceptedVertex = AdmittedReceivedVertexView;

export interface V3RoomAcceptedOperation {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

export interface V3RoomProjectionAuthority {
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

export interface V3RoomMigrationProjection {
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly importOperations: readonly Readonly<Record<string, unknown>>[];
}

export interface V3RoomMigrationCapability<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	canonicalStateBytes(projection: Projection): Uint8Array;
	prepare(accepted: readonly V3RoomAcceptedOperation[]): V3RoomMigrationProjection;
}

export interface V3RoomMigrationRehearsalInput {
	readonly rehearsalNonce: Uint8Array;
	readonly targetCreatorInvite: string | V3RoomCreatorInviteMaterial;
}

export interface V3RoomMigrationRehearsalReceipt {
	readonly activated: false;
	readonly applicationStateDigest: string;
	readonly exactCanonicalRecordBytes: Uint8Array;
	readonly importedOperationCount: number;
	readonly recordDigest: string;
	readonly recordVertexDigest: string;
	readonly targetAnchorDigest: string;
}

export interface V3RoomEphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority():
		| Readonly<{
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: 0;
				readonly objectId: string;
		  }>
		| undefined;
	isCurrentWriter(author: string): boolean;
}

export interface V3RoomTransport {
	readonly networkNode: DRPNetworkNode;
	close(): void;
	openEphemeral(provider: V3RoomEphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
}

export interface V3RoomApplication<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof prepareV3LiveGeneration>[0]["catalog"];
	displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string;
	readonly displacementPolicies: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">>;
	readonly migration?: V3RoomMigrationCapability<Projection>;
	/** Throw a direct TypeError only when authenticated product fields are invalid. */
	projectAcceptedOperations(operations: readonly V3RoomAcceptedOperation[]): Projection;
	transformDisplacedOperation?(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export interface CreateV3RoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly application: V3RoomApplication<Projection>;
	readonly author: string;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly issuanceDatabaseName: string;
	readonly objectId: string;
	openTransport(): V3RoomTransport;
	onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;
	onProjection(projection: Projection): void;
	readonly publicKeyBytes: Uint8Array;
	readonly rebaseSourceInvite?: string | V3RoomCreatorInviteMaterial;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export interface V3RoomSession<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly invite: string;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
	close(): Promise<void>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	openEphemeral(options: EphemeralChannelOptions): EphemeralChannel;
	previewLatchedAcl(): Readonly<Record<string, unknown>>;
	projection(): Projection;
	rehearseMigration(input: V3RoomMigrationRehearsalInput): Promise<V3RoomMigrationRehearsalReceipt>;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("v3 room hex value is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function encodeCreatorInvite(material: V3RoomCreatorInviteMaterial): string {
	return hex(
		encodeCanonical({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			kind: "ts-drp-example-v3-room-creator-invite",
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			version: 1,
		})
	);
}

function inviteBytes(values: Record<string, unknown>, field: string): Uint8Array {
	const value = values[field];
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw new TypeError(`v3 room creator invite ${field} is invalid`);
	}
	return new Uint8Array(value);
}

function decodeCreatorInvite(invite: string): V3RoomCreatorInviteMaterial {
	const encoded = bytes(invite);
	const decoded = decodeCanonical(encoded, { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Object.getPrototypeOf(decoded) !== null ||
		!sameBytes(encodeCanonical(decoded), encoded)
	) {
		throw new TypeError("v3 room creator invite is invalid");
	}
	const keys = Reflect.ownKeys(decoded);
	if (
		keys.length !== CREATOR_INVITE_KEYS.length ||
		keys.some((key) => typeof key !== "string" || !CREATOR_INVITE_KEYS.includes(key))
	) {
		throw new TypeError("v3 room creator invite fields are invalid");
	}
	const record = decoded as Record<string, unknown>;
	const values = Object.fromEntries(
		CREATOR_INVITE_KEYS.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
				throw new TypeError("v3 room creator invite field ownership is invalid");
			}
			return [key, descriptor.value] as const;
		})
	) as Record<(typeof CREATOR_INVITE_KEYS)[number], unknown>;
	if (values.kind !== "ts-drp-example-v3-room-creator-invite" || values.version !== 1) {
		throw new TypeError("v3 room creator invite version is invalid");
	}
	if (
		typeof values.pinnedGenesisAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(values.pinnedGenesisAnchorDigest)
	) {
		throw new TypeError("v3 room creator invite anchor is invalid");
	}
	const detachedGenesisSignature = inviteBytes(values, "detachedGenesisSignature");
	if (detachedGenesisSignature.byteLength !== 64) {
		throw new TypeError("v3 room creator invite signature is invalid");
	}
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalLatchedAclBytes: inviteBytes(values, "exactCanonicalLatchedAclBytes"),
		exactCanonicalGenesisAnchorPreimageBytes: inviteBytes(values, "exactCanonicalGenesisAnchorPreimageBytes"),
		exactCanonicalParametersCarrierBytes: inviteBytes(values, "exactCanonicalParametersCarrierBytes"),
		exactCanonicalProfileBytes: inviteBytes(values, "exactCanonicalProfileBytes"),
		exactCanonicalSignerSetBytes: inviteBytes(values, "exactCanonicalSignerSetBytes"),
		pinnedGenesisAnchorDigest: values.pinnedGenesisAnchorDigest,
	});
}

const APPLICATION_BATCH_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 8, maxItems: 1_024 });
const APPLICATION_BATCH_ENTRY_KEYS = Object.freeze(["logicalTime", "operation"]);
const APPLICATION_BATCH_KEYS = Object.freeze(["action", "batch"]);
const APPLICATION_BATCH_PAYLOAD_KEYS = Object.freeze(["entries", "version"]);

function detachedRoomOperation(value: unknown): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(encodeCanonical(value));
		if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
		return Object.freeze({ ...(decoded as Record<string, unknown>) });
	} catch {
		return undefined;
	}
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== expectedKeys.length ||
		keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
	) {
		return undefined;
	}
	const output: Record<string, unknown> = {};
	for (const key of expectedKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		output[key] = descriptor.value;
	}
	return Object.freeze(output);
}

function exactDenseArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys[value.length] !== "length") return undefined;
	for (let index = 0; index < value.length; index += 1) {
		if (keys[index] !== String(index)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
	}
	return value;
}

interface MigrationRecordAuthority {
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly creatorAuthor: string;
	readonly objectId: string;
}

function validMigrationRecordOperation(
	operation: Readonly<Record<string, unknown>>,
	author: string,
	authority: MigrationRecordAuthority
): boolean {
	if (Reflect.get(operation, "action") !== "migrationRecord") return true;
	const outer = exactRecord(operation, ["action", "record"]);
	const record = exactRecord(outer?.record, MIGRATION_RECORD_KEYS);
	if (outer === undefined || record === undefined) return false;
	const nonce = record.rehearsalNonce;
	const stateBytes = record.exactCanonicalApplicationStateBytes;
	const sourceCount = record.sourceAcceptedOperationCount;
	const targetCount = record.targetImportOperationCount;
	const sourceObjectId = record.sourceObjectId;
	const targetObjectId = record.targetObjectId;
	const digestFields = [
		"applicationStateDigest",
		"sourceAcceptedOperationsDigest",
		"sourceAnchorDigest",
		"sourceBlueprintDigest",
		"sourceCreatorAuthor",
		"targetAnchorDigest",
		"targetBlueprintDigest",
		"targetCreatorAuthor",
		"targetImportOperationsDigest",
	] as const;
	if (
		record.kind !== "ts-drp-v3-room-migration-record" ||
		record.version !== 1 ||
		record.archivePolicy !== "retain-source" ||
		record.authorityKind !== "creator-ed25519-registered-vertex-v1" ||
		!(nonce instanceof Uint8Array) ||
		Object.getPrototypeOf(nonce) !== Uint8Array.prototype ||
		!(nonce.buffer instanceof ArrayBuffer) ||
		nonce.byteOffset !== 0 ||
		nonce.byteLength !== 32 ||
		nonce.buffer.byteLength !== 32 ||
		!(stateBytes instanceof Uint8Array) ||
		Object.getPrototypeOf(stateBytes) !== Uint8Array.prototype ||
		!(stateBytes.buffer instanceof ArrayBuffer) ||
		stateBytes.byteOffset !== 0 ||
		stateBytes.buffer.byteLength !== stateBytes.byteLength ||
		stateBytes.byteLength > 32_768 ||
		!Number.isSafeInteger(sourceCount) ||
		(sourceCount as number) < 0 ||
		(sourceCount as number) > 8192 ||
		!Number.isSafeInteger(targetCount) ||
		(targetCount as number) < 0 ||
		(targetCount as number) > 8192 ||
		typeof sourceObjectId !== "string" ||
		!parseStorageObjectId(sourceObjectId).ok ||
		typeof targetObjectId !== "string" ||
		sourceObjectId === targetObjectId ||
		targetObjectId !== authority.objectId ||
		record.targetAnchorDigest !== authority.anchorDigest ||
		record.targetBlueprintDigest !== authority.blueprintDigest ||
		record.sourceBlueprintDigest !== authority.blueprintDigest ||
		record.sourceCreatorAuthor !== authority.creatorAuthor ||
		record.targetCreatorAuthor !== authority.creatorAuthor ||
		author !== authority.creatorAuthor ||
		digestFields.some((field) => typeof record[field] !== "string" || !/^[0-9a-f]{64}$/u.test(record[field] as string))
	) {
		return false;
	}
	try {
		const decodedState = decodeCanonical(stateBytes, { maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
		return (
			sameBytes(encodeCanonical(decodedState), stateBytes) &&
			migrationTargetObjectId(sourceObjectId, nonce) === targetObjectId &&
			record.sourceAnchorDigest !== record.targetAnchorDigest &&
			record.applicationStateDigest === digest("ts-drp/v3-room-migration-state/v1", stateBytes) &&
			encodeCanonical(record).byteLength <= 49_152
		);
	} catch {
		return false;
	}
}

function acceptedOperationsForVertex(
	application: V3RoomApplication,
	vertex: V3RoomAcceptedVertex,
	migrationAuthority?: MigrationRecordAuthority
): readonly V3RoomAcceptedOperation[] | undefined {
	const vertexDigest = hex(vertex.digest);
	const operation = detachedRoomOperation(vertex.operation);
	if (operation === undefined) return undefined;
	if (
		migrationAuthority !== undefined &&
		Reflect.get(operation, "action") === "migrationRecord" &&
		!validMigrationRecordOperation(operation, vertex.author, migrationAuthority)
	) {
		return undefined;
	}
	if (Reflect.get(operation, "action") !== "applicationBatch") {
		return Object.freeze([
			Object.freeze({
				author: vertex.author,
				authorSequence: vertex.authorSequence,
				logicalTime: vertex.logicalTime,
				operation,
				operationCount: 1,
				operationIndex: 0,
				vertexDigest,
			}),
		]);
	}
	try {
		decodeCanonical(encodeCanonical(operation, APPLICATION_BATCH_LIMITS), APPLICATION_BATCH_LIMITS);
	} catch {
		return undefined;
	}
	const outer = exactRecord(operation, APPLICATION_BATCH_KEYS);
	const batch = exactRecord(outer?.batch, APPLICATION_BATCH_PAYLOAD_KEYS);
	const entries = exactDenseArray(batch?.entries);
	if (outer === undefined || batch === undefined || batch.version !== 1 || entries === undefined) return undefined;
	if (entries.length < 2 || entries.length > 16) return undefined;
	let priorLogicalTime = -1;
	const accepted: V3RoomAcceptedOperation[] = [];
	for (let operationIndex = 0; operationIndex < entries.length; operationIndex += 1) {
		const entry = exactRecord(entries[operationIndex], APPLICATION_BATCH_ENTRY_KEYS);
		const child = detachedRoomOperation(entry?.operation);
		const action = child === undefined ? undefined : Reflect.get(child, "action");
		if (
			entry === undefined ||
			!Number.isSafeInteger(entry.logicalTime) ||
			(entry.logicalTime as number) < 0 ||
			(entry.logicalTime as number) <= priorLogicalTime ||
			child === undefined ||
			typeof action !== "string" ||
			!application.batchableOperationActions.includes(action)
		) {
			return undefined;
		}
		priorLogicalTime = entry.logicalTime as number;
		accepted.push(
			Object.freeze({
				author: vertex.author,
				authorSequence: vertex.authorSequence,
				logicalTime: priorLogicalTime,
				operation: child,
				operationCount: entries.length,
				operationIndex,
				vertexDigest,
			})
		);
	}
	return Object.freeze(accepted);
}

function validateDisplacementPolicy(application: V3RoomApplication): void {
	const policies = application.displacementPolicies;
	if (
		policies === null ||
		typeof policies !== "object" ||
		Array.isArray(policies) ||
		!Object.isFrozen(policies) ||
		(Object.getPrototypeOf(policies) !== Object.prototype && Object.getPrototypeOf(policies) !== null)
	) {
		throw new TypeError("v3 room displacement policy is invalid");
	}
	const keys = Reflect.ownKeys(policies);
	if (
		keys.length !== application.batchableOperationActions.length ||
		keys.some((key, index) => key !== application.batchableOperationActions[index])
	) {
		throw new TypeError("v3 room displacement policy is invalid");
	}
	for (const key of keys) {
		if (typeof key !== "string") throw new TypeError("v3 room displacement policy is invalid");
		const descriptor = Object.getOwnPropertyDescriptor(policies, key);
		const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
		if (
			descriptor?.enumerable !== true ||
			(value !== "expire" && value !== "manual-review" && value !== "rebase" && value !== "transform")
		) {
			throw new TypeError("v3 room displacement policy is invalid");
		}
	}
	if (typeof application.displacedOperationIdentity !== "function") {
		throw new TypeError("v3 room displacement authority is invalid");
	}
}

function migrationCreatorAuthor(material: V3RoomCreatorInviteMaterial): string {
	const decoded = decodeCanonical(material.exactCanonicalSignerSetBytes, {
		maxBytes: 4_096,
		maxDepth: 3,
		maxItems: 32,
	});
	if (!Array.isArray(decoded) || decoded.length !== 1) throw new TypeError("v3 room migration creator is invalid");
	const signer = decoded[0];
	const publicKey = signer !== null && typeof signer === "object" ? Reflect.get(signer, "publicKey") : undefined;
	if (
		signer === null ||
		typeof signer !== "object" ||
		Reflect.ownKeys(signer).length !== 2 ||
		Reflect.get(signer, "signerId") !== "creator" ||
		typeof publicKey !== "string" ||
		!/^[0-9a-f]{64}$/u.test(publicKey)
	) {
		throw new TypeError("v3 room migration creator is invalid");
	}
	return publicKey;
}

function migrationInviteAuthority(material: V3RoomCreatorInviteMaterial): Readonly<{
	readonly blueprintDigest: string;
	readonly creatorAuthor: string;
	readonly objectId: string;
	readonly signerSetDigest: string;
}> {
	const preimage = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes, {
		maxBytes: 65_536,
		maxDepth: 4,
		maxItems: 128,
	});
	const blueprintDigest =
		preimage !== null && typeof preimage === "object" ? Reflect.get(preimage, "blueprintDigest") : undefined;
	const objectId = preimage !== null && typeof preimage === "object" ? Reflect.get(preimage, "objectId") : undefined;
	const acl = decodeCanonical(material.exactCanonicalLatchedAclBytes, { maxBytes: 65_536, maxDepth: 6, maxItems: 512 });
	const aclObjectId = acl !== null && typeof acl === "object" ? Reflect.get(acl, "objectId") : undefined;
	if (
		preimage === null ||
		typeof preimage !== "object" ||
		typeof blueprintDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(blueprintDigest) ||
		typeof objectId !== "string" ||
		aclObjectId !== objectId
	) {
		throw new TypeError("v3 room migration invite authority is invalid");
	}
	return Object.freeze({
		blueprintDigest,
		creatorAuthor: migrationCreatorAuthor(material),
		objectId,
		signerSetDigest: digest("ts-drp/signer-set/v3", material.exactCanonicalSignerSetBytes),
	});
}

function migrationTargetObjectId(sourceObjectId: string, rehearsalNonce: Uint8Array): string {
	const separator = sourceObjectId.indexOf(":");
	if (separator <= 0 || separator === sourceObjectId.length - 1) {
		throw new TypeError("v3 room migration source object id is invalid");
	}
	const identity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce: new Uint8Array(rehearsalNonce), sourceObjectId })
	);
	const targetObjectId = `${sourceObjectId.slice(0, separator)}:${hex(identity.subarray(0, 16))}`;
	if (targetObjectId === sourceObjectId) throw new TypeError("v3 room migration target object id is invalid");
	return targetObjectId;
}

function migrationTransport(): V3RoomTransport {
	const topics = new Set<string>();
	const networkNode = {
		peerId: "peer:v3-room-migration-local",
		broadcastMessage: (): Promise<never> =>
			Promise.reject(new TypeError("v3 room migration transport cannot broadcast messages")),
		changeTopicScoreParams: (): void => undefined,
		connect: (): Promise<void> => Promise.reject(new TypeError("v3 room migration transport cannot connect")),
		connectToBootstraps: (): Promise<void> =>
			Promise.reject(new TypeError("v3 room migration transport cannot dial bootstraps")),
		disconnect: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): [] => [],
		getBootstrapNodes: (): [] => [],
		getGroupPeers: (): [] => [],
		getMultiaddrs: (): [] => [],
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getSubscribedTopics: (): string[] => [...topics],
		gossipTopicFor: (): undefined => undefined,
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		publishMessage: (): Promise<true> => Promise.resolve(true),
		removeTopicScoreParams: (): void => undefined,
		restart: (): Promise<void> => Promise.resolve(),
		sendGroupMessageRandomPeer: (): Promise<void> =>
			Promise.reject(new TypeError("v3 room migration transport cannot send group messages")),
		sendMessage: (): Promise<void> => Promise.reject(new TypeError("v3 room migration transport cannot send messages")),
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
	} as unknown as DRPNetworkNode;
	return Object.freeze({
		close(): void {
			topics.clear();
		},
		networkNode,
		openEphemeral(): never {
			throw new TypeError("v3 room migration transport has no ephemeral plane");
		},
		requestRetainedHistory(): void {
			// The migration target is intentionally local-only.
		},
		setIngressHandler(): void {
			// The migration target accepts no remote ingress.
		},
		setRetainedPublisher(): void {
			// The genuine live plane still installs its local publisher.
		},
	});
}

/**
 * Opens one browser v3 room from application material and a real transport adapter.
 * @param input - Closed application, identity, durable-store and transport bindings.
 * @returns The active room session after durable recovery and live activation.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	return createV3RoomSessionOwned(input, false);
}

async function createV3RoomSessionOwned<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	requireFreshTrust: boolean
): Promise<V3RoomSession<Projection>> {
	if (
		!Array.isArray(input.application.batchableOperationActions) ||
		!Object.isFrozen(input.application.batchableOperationActions) ||
		input.application.batchableOperationActions.length === 0 ||
		input.application.batchableOperationActions.some(
			(action, index, actions) =>
				typeof action !== "string" || action.length === 0 || (index > 0 && (actions[index - 1] as string) >= action)
		)
	) {
		throw new TypeError("v3 room batchable operation actions are invalid");
	}
	if (input.rebaseSourceInvite !== undefined) validateDisplacementPolicy(input.application);
	const issuanceDatabaseName =
		input.issuanceDatabaseName ?? (input.rebaseSourceInvite === undefined ? input.databaseName : undefined);
	if (typeof issuanceDatabaseName !== "string" || issuanceDatabaseName.length === 0) {
		throw new TypeError("v3 room issuance database name is invalid");
	}
	const invite =
		typeof input.creatorInvite === "string" ? input.creatorInvite : encodeCreatorInvite(input.creatorInvite);
	const material = decodeCreatorInvite(invite);
	const sourceInvite = input.rebaseSourceInvite;
	const sourceMaterial =
		sourceInvite === undefined
			? undefined
			: decodeCreatorInvite(typeof sourceInvite === "string" ? sourceInvite : encodeCreatorInvite(sourceInvite));
	const objectIdResult = parseStorageObjectId(input.objectId);
	if (!objectIdResult.ok) throw new TypeError("v3 room object id is invalid");
	const { aheStores, issuanceStore, journalStore, prepared, recovered } = await prepareDurableRoomState(
		Object.freeze({ ...input, issuanceDatabaseName }),
		material,
		sourceMaterial,
		objectIdResult.value,
		requireFreshTrust
	);
	const acceptedVertices = new Map<string, V3RoomAcceptedVertex>();
	const acceptedOperationRows = new Map<string, readonly V3RoomAcceptedOperation[] | null>();
	let projection: Projection;
	let logicalTime = input.initialLogicalTime;
	const roomCreatorAuthor = input.application.migration === undefined ? input.author : migrationCreatorAuthor(material);
	const migrationRecordAuthority =
		input.application.migration === undefined
			? undefined
			: Object.freeze({
					anchorDigest: prepared.descriptor.anchorDigest,
					blueprintDigest: prepared.descriptor.blueprintDigest,
					creatorAuthor: roomCreatorAuthor,
					objectId: input.objectId,
				});
	const expand = (vertex: V3RoomAcceptedVertex): readonly V3RoomAcceptedOperation[] | undefined => {
		const identity = hex(vertex.digest);
		const cached = acceptedOperationRows.get(identity);
		if (cached !== undefined) return cached === null ? undefined : cached;
		const expanded = acceptedOperationsForVertex(input.application, vertex, migrationRecordAuthority);
		acceptedOperationRows.set(identity, expanded ?? null);
		return expanded;
	};
	const stage = (
		vertices: readonly V3RoomAcceptedVertex[]
	): Readonly<{
		readonly additions: readonly Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[];
		readonly projection: Projection;
	}> => {
		const candidate = new Map(acceptedVertices);
		const additions: Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[] = [];
		for (const vertex of [...vertices].sort(compareAcceptedVertices)) {
			const identity = hex(vertex.digest);
			if (candidate.has(identity)) continue;
			const expanded = expand(vertex);
			if (expanded === undefined) continue;
			candidate.set(identity, vertex);
			additions.push(Object.freeze({ identity, vertex }));
		}
		const project = (selected: ReadonlyMap<string, V3RoomAcceptedVertex>): Projection =>
			input.application.projectAcceptedOperations(
				Object.freeze([...selected.values()].sort(compareAcceptedVertices).flatMap((vertex) => expand(vertex) ?? []))
			);
		try {
			return Object.freeze({ additions: Object.freeze(additions), projection: project(candidate) });
		} catch {
			const contained = new Map(acceptedVertices);
			const acceptedAdditions: Readonly<{
				readonly identity: string;
				readonly vertex: V3RoomAcceptedVertex;
			}>[] = [];
			let containedProjection: Projection | undefined;
			for (const addition of additions) {
				contained.set(addition.identity, addition.vertex);
				try {
					containedProjection = project(contained);
					acceptedAdditions.push(addition);
				} catch (error) {
					const action = Reflect.get(addition.vertex.operation, "action");
					if (
						Object.getPrototypeOf(error) !== TypeError.prototype ||
						(action !== "applicationBatch" &&
							action !== "migrationRecord" &&
							(typeof action !== "string" || !input.application.batchableOperationActions.includes(action)))
					) {
						throw error;
					}
					contained.delete(addition.identity);
					acceptedOperationRows.set(addition.identity, null);
				}
			}
			return Object.freeze({
				additions: Object.freeze(acceptedAdditions),
				projection: containedProjection ?? project(contained),
			});
		}
	};
	const commit = async (vertices: readonly V3RoomAcceptedVertex[]): Promise<boolean> => {
		for (const vertex of vertices) {
			const expanded = expand(vertex);
			const latestChild = expanded?.at(-1)?.logicalTime ?? vertex.logicalTime;
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2, latestChild + 2);
		}
		const candidate = stage(vertices);
		if (candidate.additions.length === 0) return false;
		for (const { vertex } of candidate.additions) await input.onAcceptedVertex(vertex);
		input.onProjection(candidate.projection);
		for (const { identity, vertex } of candidate.additions) {
			acceptedVertices.set(identity, vertex);
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2);
		}
		projection = candidate.projection;
		return true;
	};
	try {
		if (!(await commit(recovered.descriptor.recoveredVertices))) {
			projection = input.application.projectAcceptedOperations(Object.freeze([]));
			input.onProjection(projection);
		}
	} catch (error) {
		await Promise.all([issuanceStore.close(), journalStore.close(), ...aheStores.map((store) => store.close())]);
		throw error;
	}
	const recoveredProjectionRejected = recovered.descriptor.recoveredVertices.some(
		(vertex) => vertex.author === input.author && acceptedOperationRows.get(hex(vertex.digest)) === null
	);
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	let activeHandle: V3PlaneHandle | undefined;
	let transport: V3RoomTransport | undefined;
	let terminalFailure: unknown = recoveredProjectionRejected
		? new TypeError("v3 room recovered operation was not accepted by projection")
		: undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		closePromise = (async (): Promise<void> => {
			const failures: unknown[] = [];
			try {
				activeHandle?.deactivate();
			} catch (error) {
				failures.push(error);
			}
			try {
				messageQueueManager.closeAll();
			} catch (error) {
				failures.push(error);
			}
			try {
				transport?.close();
			} catch (error) {
				failures.push(error);
			}
			for (const result of await Promise.allSettled([
				issuanceStore.close(),
				journalStore.close(),
				...aheStores.map((store) => store.close()),
			])) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (failures.length > 0) throw failures[0];
		})();
		return closePromise;
	};
	const admittedSink: V3AdmittedVertexSink = async ({ vertex }) => {
		try {
			await commit([vertex]);
		} catch (error) {
			terminalFailure = error;
			await shutdown().catch(() => undefined);
			throw error;
		}
	};
	try {
		const openedTransport = input.openTransport();
		transport = openedTransport;
		const activated = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager,
			networkNode: openedTransport.networkNode,
			onAdmittedVertex: admittedSink,
		});
		if (!activated.ok) throw new TypeError(`v3 room activation failed: ${activated.kind}`);
		activeHandle = activated.handle;
		openedTransport.setIngressHandler(
			activeHandle.topic,
			(message) => {
				routeV3Ingress(openedTransport.networkNode, message);
			},
			(message) => {
				if (activeHandle !== undefined) routeV3RetainedIngress(activeHandle, message);
			}
		);
		openedTransport.setRetainedPublisher(async (targetPeerId) => {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const result =
				targetPeerId === undefined
					? await activeHandle.republishRetained()
					: await republishV3RetainedTo(activeHandle, targetPeerId);
			if (!result.ok) throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
		});
		openedTransport.requestRetainedHistory();
	} catch (error) {
		await shutdown().catch(() => undefined);
		throw error;
	}
	type PendingIssue = Readonly<{
		group?: string;
		logicalTime: number;
		operation: Readonly<Record<string, unknown>>;
		reject(reason: unknown): void;
		resolve(): void;
	}>;
	let pendingIssues: PendingIssue[] = [];
	let drainScheduled = false;
	let draining = false;
	let drainPromise: Promise<void> = Promise.resolve();
	let migrationBarrier: Promise<void> | undefined;
	let migrationCompletionBarrier: Promise<void> | undefined;
	let migrationAcceptingFollowers = false;
	type MigrationFollowerResult =
		| Readonly<{ readonly ok: true }>
		| Readonly<{ readonly ok: false; readonly reason: unknown }>;
	const migrationFollowers = new Set<Promise<MigrationFollowerResult>>();
	const publishAccepted = async (): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		for (;;) {
			const published = await activeHandle.publishPending();
			if (!published.ok) throw new TypeError(`v3 room publication failed: ${published.kind}`);
			if (published.kind === "empty") return;
		}
	};
	const rejectOwned = (owned: readonly PendingIssue[], reason: unknown): void => {
		for (const request of owned) request.reject(reason);
	};
	const issueOwned = async (owned: readonly PendingIssue[]): Promise<void> => {
		if (owned.length === 0) return;
		if (activeHandle === undefined) {
			rejectOwned(owned, new TypeError("v3 room live plane is unavailable"));
			return;
		}
		const issued = await activeHandle
			.issueLocal({
				operations: Object.freeze(
					owned.map(({ logicalTime: selectedLogicalTime, operation }) =>
						Object.freeze({ logicalTime: selectedLogicalTime, operation })
					)
				),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			})
			.catch((error: unknown) => {
				rejectOwned(owned, error);
				return undefined;
			});
		if (issued === undefined) return;
		if (!issued.ok && issued.kind === "split-required") {
			const prefixLength = issued.prefixLength;
			if (
				typeof prefixLength !== "number" ||
				!Number.isSafeInteger(prefixLength) ||
				prefixLength < 1 ||
				prefixLength >= owned.length
			) {
				rejectOwned(owned, new TypeError("v3 room issue split was invalid"));
				return;
			}
			await issueOwned(owned.slice(0, prefixLength));
			await issueOwned(owned.slice(prefixLength));
			return;
		}
		if (!issued.ok && issued.kind === "malformed-input" && owned.length > 1) {
			owned[0]?.reject(new TypeError(`v3 room issue failed: ${issued.kind}`));
			await issueOwned(owned.slice(1));
			return;
		}
		if (!issued.ok) {
			rejectOwned(owned, new TypeError(`v3 room issue failed: ${issued.kind}`));
			return;
		}
		if (terminalFailure !== undefined) {
			rejectOwned(owned, terminalFailure);
			return;
		}
		if (acceptedOperationRows.get(issued.digest) === null) {
			rejectOwned(owned, new TypeError("v3 room issued operation was not accepted by projection"));
			return;
		}
		try {
			await publishAccepted();
			for (const request of owned) request.resolve();
		} catch (error) {
			rejectOwned(owned, error);
		}
	};
	const drainSnapshot = async (snapshot: readonly PendingIssue[]): Promise<void> => {
		let offset = 0;
		while (offset < snapshot.length) {
			const head = snapshot[offset];
			if (head === undefined) return;
			const action = Reflect.get(head.operation, "action");
			if (typeof action !== "string" || !input.application.batchableOperationActions.includes(action)) {
				await issueOwned(Object.freeze([head]));
				offset += 1;
				continue;
			}
			let end = offset + 1;
			while (end < snapshot.length && end - offset < 16) {
				const candidate = snapshot[end];
				const candidateAction = Reflect.get(candidate?.operation ?? {}, "action");
				if (
					typeof candidateAction !== "string" ||
					!input.application.batchableOperationActions.includes(candidateAction) ||
					candidate?.group !== head.group
				) {
					break;
				}
				end += 1;
			}
			await issueOwned(Object.freeze(snapshot.slice(offset, end)));
			offset = end;
		}
	};
	const scheduleDrain = (): void => {
		if (drainScheduled || draining || pendingIssues.length === 0) return;
		drainScheduled = true;
		drainPromise = Promise.resolve().then(async (): Promise<void> => {
			drainScheduled = false;
			draining = true;
			const snapshot = Object.freeze(pendingIssues);
			pendingIssues = [];
			try {
				await drainSnapshot(snapshot);
			} finally {
				draining = false;
				if (pendingIssues.length > 0) scheduleDrain();
			}
		});
	};
	const drainPendingIssues = async (): Promise<void> => {
		for (;;) {
			if (pendingIssues.length > 0) scheduleDrain();
			await drainPromise;
			if (!drainScheduled && !draining && pendingIssues.length === 0) return;
		}
	};
	const waitForMigrationFollowers = async (): Promise<void> => {
		for (;;) {
			const selected = [...migrationFollowers];
			if (selected.length === 0) return;
			const results = await Promise.all(selected);
			for (const follower of selected) migrationFollowers.delete(follower);
			const failed = results.find((result) => !result.ok);
			if (failed !== undefined && !failed.ok) throw failed.reason;
		}
	};
	const acceptedIdentityRows = (): Map<string, Uint8Array> => {
		const rows = new Map<string, Uint8Array>();
		for (const vertex of acceptedVertices.values()) {
			for (const accepted of expand(vertex) ?? []) {
				const action = Reflect.get(accepted.operation, "action");
				if (typeof action !== "string" || !input.application.batchableOperationActions.includes(action)) continue;
				const identity = input.application.displacedOperationIdentity(accepted.operation);
				if (typeof identity !== "string" || identity.length === 0) {
					throw new TypeError("v3 room displaced operation identity is invalid");
				}
				const key = `${accepted.author}\u0000${action}\u0000${identity}`;
				const encoded = encodeCanonical(accepted.operation);
				const prior = rows.get(key);
				if (prior !== undefined && !sameBytes(prior, encoded)) {
					throw new TypeError("v3 room accepted operation identity conflicts");
				}
				rows.set(key, encoded);
			}
		}
		return rows;
	};
	type DisplacedSource = Readonly<{
		author: string;
		authorSequence: number;
		intents: readonly Readonly<{
			logicalTime: number;
			operation: Readonly<Record<string, unknown>>;
			operationCount: number;
			operationIndex: number;
		}>[];
		vertexDigest: string;
	}>;
	const drainRebaseOutbox = async (): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		const sources: DisplacedSource[] = [];
		for (;;) {
			const page = await activeHandle.readRebaseOutbox();
			if (!page.ok) throw new TypeError(`v3 room rebase outbox failed: ${page.kind}`);
			if (page.kind === "empty") break;
			if (page.source.author !== input.author) {
				throw new TypeError("v3 room displaced source author is invalid");
			}
			sources.push(page.source);
			if (sources.length > 8192) throw new TypeError("v3 room rebase outbox is unbounded");
			if (
				sources.some((source, index) => index + 1 < sources.length && source.vertexDigest === page.source.vertexDigest)
			) {
				throw new TypeError("v3 room rebase outbox did not advance");
			}
			if (page.source.intents.length === 0) {
				const completed = await activeHandle.completeRebaseSource({
					authorSequence: page.source.authorSequence,
					digest: page.source.vertexDigest,
				});
				if (!completed.ok) throw new TypeError(`v3 room rebase completion failed: ${completed.kind}`);
			}
		}
		const acceptedRows = acceptedIdentityRows();
		const sourceRows = new Map<string, Uint8Array>();
		const capturedMaximum = sources.reduce(
			(maximum, source) =>
				source.intents.reduce((sourceMaximum, intent) => Math.max(sourceMaximum, intent.logicalTime), maximum),
			-1
		);
		logicalTime = Math.max(logicalTime, capturedMaximum + 2);
		const states = sources
			.filter(({ intents }) => intents.length > 0)
			.map((source) => ({ held: false, issued: [] as Promise<void>[], source }));
		const orderedIntents = states
			.flatMap((state) => state.source.intents.map((intent) => ({ intent, state })))
			.sort(
				(left, right) =>
					left.intent.logicalTime - right.intent.logicalTime ||
					compareText(left.state.source.author, right.state.source.author) ||
					left.state.source.authorSequence - right.state.source.authorSequence ||
					compareText(left.state.source.vertexDigest, right.state.source.vertexDigest) ||
					left.intent.operationIndex - right.intent.operationIndex
			);
		for (const { intent, state } of orderedIntents) {
			const source = state.source;
			const operation = detachedRoomOperation(intent.operation);
			const action = operation === undefined ? undefined : Reflect.get(operation, "action");
			if (operation === undefined || typeof action !== "string") {
				throw new TypeError("v3 room displaced operation is invalid");
			}
			const policy = input.application.displacementPolicies[action];
			if (policy === undefined) throw new TypeError("v3 room displacement policy is unavailable");
			const identity = input.application.displacedOperationIdentity(operation);
			if (
				typeof identity !== "string" ||
				identity.length === 0 ||
				input.application.displacedOperationIdentity(operation) !== identity
			) {
				throw new TypeError("v3 room displaced operation identity is invalid");
			}
			const key = `${source.author}\u0000${action}\u0000${identity}`;
			const sourceBytes = encodeCanonical(operation);
			const priorSourceBytes = sourceRows.get(key);
			if (priorSourceBytes !== undefined && !sameBytes(priorSourceBytes, sourceBytes)) {
				throw new TypeError("v3 room displaced operation identity conflicts");
			}
			sourceRows.set(key, sourceBytes);
			if (policy === "expire") continue;
			if (policy === "manual-review") {
				state.held = true;
				continue;
			}
			let selected = operation;
			if (policy === "transform") {
				const transform = input.application.transformDisplacedOperation;
				if (transform === undefined) throw new TypeError("v3 room displaced transform is unavailable");
				const first = detachedRoomOperation(transform(operation));
				const second = detachedRoomOperation(transform(operation));
				if (
					first === undefined ||
					second === undefined ||
					!sameBytes(encodeCanonical(first), encodeCanonical(second)) ||
					Reflect.get(first, "action") !== action ||
					input.application.displacedOperationIdentity(first) !== identity
				) {
					throw new TypeError("v3 room displaced transform is unstable");
				}
				selected = first;
			}
			const selectedBytes = encodeCanonical(selected);
			const acceptedBytes = acceptedRows.get(key);
			if (acceptedBytes !== undefined) {
				if (!sameBytes(acceptedBytes, selectedBytes)) {
					throw new TypeError("v3 room displaced operation identity conflicts");
				}
				continue;
			}
			acceptedRows.set(key, selectedBytes);
			const selectedLogicalTime = logicalTime;
			logicalTime += 2;
			state.issued.push(
				new Promise<void>((resolve, reject) => {
					pendingIssues.push(
						Object.freeze({
							group: `${action}\u0000${policy}`,
							logicalTime: selectedLogicalTime,
							operation: selected,
							reject,
							resolve,
						})
					);
				})
			);
		}
		const issued = states.flatMap((state) => state.issued);
		if (issued.length > 0) {
			scheduleDrain();
			await Promise.all(issued);
		}
		for (const { held, source } of states) {
			if (!held) {
				const completed = await activeHandle.completeRebaseSource({
					authorSequence: source.authorSequence,
					digest: source.vertexDigest,
				});
				if (!completed.ok) throw new TypeError(`v3 room rebase completion failed: ${completed.kind}`);
			}
		}
	};
	const rebasePromise =
		sourceMaterial === undefined
			? Promise.resolve()
			: Promise.resolve().then(async () => {
					if (terminalFailure !== undefined) throw terminalFailure;
					await publishAccepted();
					await drainRebaseOutbox();
				});
	void rebasePromise.catch((error: unknown) => {
		terminalFailure = error;
	});
	const rehearseMigration = async (
		rehearsalInput: V3RoomMigrationRehearsalInput
	): Promise<V3RoomMigrationRehearsalReceipt> => {
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
		const fields = exactRecord(rehearsalInput, ["rehearsalNonce", "targetCreatorInvite"]);
		const nonce = fields?.rehearsalNonce;
		let nonceBacking: unknown;
		let nonceBackingByteLength: unknown;
		let nonceByteLength: unknown;
		let nonceByteOffset: unknown;
		let nonceResizable = false;
		try {
			nonceBacking = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, nonce, []);
			nonceBackingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, nonceBacking, []);
			nonceByteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, nonce, []);
			nonceByteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, nonce, []);
			if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
				nonceResizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, nonceBacking, []) === true;
			}
		} catch {
			throw new TypeError("v3 room migration rehearsal input is invalid");
		}
		if (
			fields === undefined ||
			INTRINSIC_GET_PROTOTYPE_OF(nonce) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
			!(nonceBacking instanceof INTRINSIC_ARRAY_BUFFER) ||
			INTRINSIC_GET_PROTOTYPE_OF(nonceBacking) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
			nonceResizable ||
			nonceByteLength !== 32 ||
			nonceByteOffset !== 0 ||
			nonceBackingByteLength !== 32
		) {
			throw new TypeError("v3 room migration rehearsal input is invalid");
		}
		const migration = input.application.migration;
		const canonicalStateBytes = migration?.canonicalStateBytes;
		const prepareMigration = migration?.prepare;
		if (
			migration === undefined ||
			typeof canonicalStateBytes !== "function" ||
			typeof prepareMigration !== "function"
		) {
			throw new TypeError("v3 room migration capability is unavailable");
		}
		const copiedNonce = new INTRINSIC_UINT8_ARRAY(32);
		Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, copiedNonce, [
			new INTRINSIC_UINT8_ARRAY(nonceBacking, nonceByteOffset as number, nonceByteLength as number),
		]);
		const targetObjectId = migrationTargetObjectId(input.objectId, copiedNonce);
		const targetInviteValue = fields.targetCreatorInvite;
		if (
			typeof targetInviteValue !== "string" &&
			(targetInviteValue === null || typeof targetInviteValue !== "object")
		) {
			throw new TypeError("v3 room migration target invite is invalid");
		}
		const targetMaterial = decodeCreatorInvite(
			typeof targetInviteValue === "string"
				? targetInviteValue
				: encodeCreatorInvite(targetInviteValue as V3RoomCreatorInviteMaterial)
		);
		const sourceAuthority = migrationInviteAuthority(material);
		const targetAuthority = migrationInviteAuthority(targetMaterial);
		if (
			sourceAuthority.creatorAuthor !== input.author ||
			sourceAuthority.objectId !== input.objectId ||
			sourceAuthority.signerSetDigest !== prepared.descriptor.signerSetDigest ||
			targetAuthority.creatorAuthor !== input.author ||
			targetAuthority.objectId !== targetObjectId ||
			targetAuthority.blueprintDigest !== prepared.descriptor.blueprintDigest ||
			targetAuthority.signerSetDigest !== prepared.descriptor.signerSetDigest
		) {
			throw new TypeError("v3 room migration target authority is invalid");
		}
		if (migrationBarrier !== undefined) throw new TypeError("v3 room migration rehearsal is already active");
		let releaseMigrationBarrier: (() => void) | undefined;
		let releaseMigrationCompletion: (() => void) | undefined;
		const ownedMigrationBarrier = new Promise<void>((resolve) => {
			releaseMigrationBarrier = resolve;
		});
		const ownedMigrationCompletion = new Promise<void>((resolve) => {
			releaseMigrationCompletion = resolve;
		});
		migrationBarrier = ownedMigrationBarrier;
		migrationCompletionBarrier = ownedMigrationCompletion;
		migrationAcceptingFollowers = true;
		try {
			await rebasePromise;
			await drainPendingIssues();
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");

			const snapshot = (): readonly V3RoomAcceptedOperation[] =>
				Object.freeze(
					[...acceptedVertices.values()]
						.sort(compareAcceptedVertices)
						.flatMap((vertex) => expand(vertex) ?? [])
						.map((row) => {
							const operation = detachedRoomOperation(row.operation);
							if (operation === undefined) throw new TypeError("v3 room migration source operation is invalid");
							return Object.freeze({ ...row, operation });
						})
				);
			const firstSnapshot = snapshot();
			const sourceRows = firstSnapshot.map((row) =>
				Object.freeze({
					author: row.author,
					authorSequence: row.authorSequence,
					exactCanonicalOperationBytes: encodeCanonical(row.operation),
					logicalTime: row.logicalTime,
					operationCount: row.operationCount,
					operationIndex: row.operationIndex,
					vertexDigest: row.vertexDigest,
				})
			);
			const exactCanonicalSourceRows = encodeCanonical(sourceRows);
			if (sourceRows.length > 8192 || exactCanonicalSourceRows.byteLength > 8_388_608) {
				throw new TypeError("v3 room migration source snapshot is unbounded");
			}
			const normalizeStateBytes = (value: unknown): Uint8Array => {
				const stateBytes = value;
				let backing: unknown;
				let backingByteLength: unknown;
				let byteLength: unknown;
				let byteOffset: unknown;
				let resizable = false;
				try {
					backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, stateBytes, []);
					backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
					byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, stateBytes, []);
					byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, stateBytes, []);
					if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
						resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
					}
				} catch {
					throw new TypeError("v3 room migration state is invalid");
				}
				if (
					INTRINSIC_GET_PROTOTYPE_OF(stateBytes) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
					!(backing instanceof INTRINSIC_ARRAY_BUFFER) ||
					INTRINSIC_GET_PROTOTYPE_OF(backing) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
					resizable ||
					byteOffset !== 0 ||
					typeof byteLength !== "number" ||
					byteLength !== backingByteLength
				) {
					throw new TypeError("v3 room migration state is invalid");
				}
				const exactState = new INTRINSIC_UINT8_ARRAY(byteLength);
				Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, exactState, [
					new INTRINSIC_UINT8_ARRAY(backing, byteOffset, byteLength),
				]);
				if (exactState.byteLength > 32_768) throw new TypeError("v3 room migration state is unbounded");
				let decodedState: unknown;
				try {
					decodedState = decodeCanonical(exactState, { maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
				} catch {
					throw new TypeError("v3 room migration state is invalid");
				}
				if (!sameBytes(encodeCanonical(decodedState), exactState)) {
					throw new TypeError("v3 room migration state is not canonical");
				}
				return exactState;
			};
			const normalizeProjection = (value: V3RoomMigrationProjection): V3RoomMigrationProjection => {
				const record = exactRecord(value, ["exactCanonicalApplicationStateBytes", "importOperations"]);
				const imports = exactDenseArray(record?.importOperations);
				if (record === undefined || imports === undefined || imports.length > 8192) {
					throw new TypeError("v3 room migration projection is invalid");
				}
				const exactState = normalizeStateBytes(record.exactCanonicalApplicationStateBytes);
				let detachedImportBytes = 0;
				const detachedImports = imports.map((operation) => {
					const detached = detachedRoomOperation(operation);
					const encoded = detached === undefined ? undefined : encodeCanonical(detached);
					if (detached === undefined || encoded === undefined || encoded.byteLength > 65_536) {
						throw new TypeError("v3 room migration import is invalid");
					}
					detachedImportBytes += encoded.byteLength;
					if (detachedImportBytes > 4_194_304) {
						throw new TypeError("v3 room migration imports are unbounded");
					}
					return detached;
				});
				if (encodeCanonical(detachedImports).byteLength > 4_194_304) {
					throw new TypeError("v3 room migration imports are unbounded");
				}
				return Object.freeze({
					exactCanonicalApplicationStateBytes: exactState,
					importOperations: Object.freeze(detachedImports),
				});
			};
			const firstProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [firstSnapshot]) as V3RoomMigrationProjection
			);
			const secondProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [snapshot()]) as V3RoomMigrationProjection
			);
			if (!sameBytes(encodeCanonical(firstProjection), encodeCanonical(secondProjection))) {
				throw new TypeError("v3 room migration projection is unstable");
			}
			const exactSourceState = normalizeStateBytes(
				Reflect.apply(canonicalStateBytes, migration, [projection]) as Uint8Array
			);
			if (!sameBytes(exactSourceState, firstProjection.exactCanonicalApplicationStateBytes)) {
				throw new TypeError("v3 room migration source state differs");
			}
			releaseMigrationBarrier?.();

			const scratchDigest = digest(
				"ts-drp/v3-room-migration-scratch/v1",
				encodeCanonical({ rehearsalNonce: copiedNonce, sourceObjectId: input.objectId, targetObjectId })
			);
			const scratchDatabaseName = `ts-drp-v3-room-migration--${scratchDigest}`;
			const targetAccepted: V3RoomAcceptedOperation[] = [];
			let recordVertexDigest: string | undefined;
			const targetRecordAuthority = Object.freeze({
				anchorDigest: targetMaterial.pinnedGenesisAnchorDigest,
				blueprintDigest: targetAuthority.blueprintDigest,
				creatorAuthor: targetAuthority.creatorAuthor,
				objectId: targetObjectId,
			});
			const acceptTarget = (vertex: V3RoomAcceptedVertex): void => {
				for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) {
					targetAccepted.push(row);
					if (Reflect.get(row.operation, "action") === "migrationRecord") recordVertexDigest = row.vertexDigest;
				}
			};
			const acceptedRowsEvidence = (rows: readonly V3RoomAcceptedOperation[]): Uint8Array =>
				encodeCanonical(
					rows.map((row) =>
						Object.freeze({
							author: row.author,
							authorSequence: row.authorSequence,
							exactCanonicalOperationBytes: encodeCanonical(row.operation),
							logicalTime: row.logicalTime,
							operationCount: row.operationCount,
							operationIndex: row.operationIndex,
							vertexDigest: row.vertexDigest,
						})
					)
				);
			const targetInput = Object.freeze({
				application: input.application,
				author: input.author,
				creatorInvite: targetMaterial,
				databaseName: scratchDatabaseName,
				initialLogicalTime: 3,
				issuanceDatabaseName: `${scratchDatabaseName}--issuance`,
				objectId: targetObjectId,
				onAcceptedVertex: acceptTarget,
				onProjection: (): void => undefined,
				openTransport: migrationTransport,
				publicKeyBytes: new Uint8Array(input.publicKeyBytes),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			});
			let target: V3RoomSession<Projection> | undefined;
			let reopenedTarget: V3RoomSession<Projection> | undefined;
			try {
				const openedTarget = await createV3RoomSessionOwned(targetInput, true);
				target = openedTarget;
				const bootstrapAcceptedCount = targetAccepted.length;
				if (bootstrapAcceptedCount < 1) throw new TypeError("v3 room migration target bootstrap was not accepted");
				const importPromises = firstProjection.importOperations.map((operation) => openedTarget.issue(operation));
				await Promise.all(importPromises);
				const targetProjection = openedTarget.projection();
				const acceptedImportOperations = targetAccepted.slice(bootstrapAcceptedCount).map(({ operation }) => operation);
				if (!sameBytes(encodeCanonical(acceptedImportOperations), encodeCanonical(firstProjection.importOperations))) {
					throw new TypeError("v3 room migration target projection differs");
				}
				const exactTargetState = normalizeStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [targetProjection]) as Uint8Array
				);
				if (!sameBytes(exactTargetState, firstProjection.exactCanonicalApplicationStateBytes)) {
					throw new TypeError("v3 room migration target state differs");
				}
				const exactCanonicalImportOperations = encodeCanonical(firstProjection.importOperations);
				const exactCanonicalRecordBytes = encodeCanonical({
					applicationStateDigest: digest(
						"ts-drp/v3-room-migration-state/v1",
						firstProjection.exactCanonicalApplicationStateBytes
					),
					archivePolicy: "retain-source",
					authorityKind: "creator-ed25519-registered-vertex-v1",
					exactCanonicalApplicationStateBytes: firstProjection.exactCanonicalApplicationStateBytes,
					kind: "ts-drp-v3-room-migration-record",
					rehearsalNonce: copiedNonce,
					sourceAcceptedOperationCount: sourceRows.length,
					sourceAcceptedOperationsDigest: digest("ts-drp/v3-room-migration-source/v1", exactCanonicalSourceRows),
					sourceAnchorDigest: prepared.descriptor.anchorDigest,
					sourceBlueprintDigest: prepared.descriptor.blueprintDigest,
					sourceCreatorAuthor: input.author,
					sourceObjectId: input.objectId,
					targetAnchorDigest: openedTarget.roomId,
					targetBlueprintDigest: targetAuthority.blueprintDigest,
					targetCreatorAuthor: targetAuthority.creatorAuthor,
					targetImportOperationCount: firstProjection.importOperations.length,
					targetImportOperationsDigest: digest("ts-drp/v3-room-migration-import/v1", exactCanonicalImportOperations),
					targetObjectId,
					version: 1,
				});
				if (exactCanonicalRecordBytes.byteLength > 49_152) {
					throw new TypeError("v3 room migration record is unbounded");
				}
				const record = decodeCanonical(exactCanonicalRecordBytes) as Readonly<Record<string, unknown>>;
				const recordOperation = Object.freeze({ action: "migrationRecord", record });
				if (!validMigrationRecordOperation(recordOperation, input.author, targetRecordAuthority)) {
					throw new TypeError("v3 room migration record is invalid");
				}
				await openedTarget.issue(recordOperation);
				if (recordVertexDigest === undefined) throw new TypeError("v3 room migration record was not accepted");
				openedTarget.projection();
				const completedTargetEvidence = acceptedRowsEvidence(targetAccepted);
				const targetAnchorDigest = openedTarget.roomId;
				migrationAcceptingFollowers = false;
				await waitForMigrationFollowers();
				await openedTarget.close();
				target = undefined;

				const reopenedAccepted: V3RoomAcceptedOperation[] = [];
				const reopened = await createV3RoomSessionOwned(
					Object.freeze({
						...targetInput,
						onAcceptedVertex: (vertex: V3RoomAcceptedVertex): void => {
							for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) {
								reopenedAccepted.push(row);
							}
						},
					}),
					false
				);
				reopenedTarget = reopened;
				const reopenedProjection = reopened.projection();
				if (!sameBytes(acceptedRowsEvidence(reopenedAccepted), completedTargetEvidence)) {
					throw new TypeError("v3 room migration reopened target differs");
				}
				const exactReopenedState = normalizeStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [reopenedProjection]) as Uint8Array
				);
				if (!sameBytes(exactReopenedState, firstProjection.exactCanonicalApplicationStateBytes)) {
					throw new TypeError("v3 room migration reopened state differs");
				}
				const recoveredRecords = reopenedAccepted.filter(
					({ operation }) => Reflect.get(operation, "action") === "migrationRecord"
				);
				const recoveredRecord = recoveredRecords[0];
				if (
					recoveredRecords.length !== 1 ||
					recoveredRecord === undefined ||
					recoveredRecord.vertexDigest !== recordVertexDigest ||
					!sameBytes(encodeCanonical(Reflect.get(recoveredRecord.operation, "record")), exactCanonicalRecordBytes)
				) {
					throw new TypeError("v3 room migration record recovery differs");
				}
				await reopened.close();
				reopenedTarget = undefined;
				return Object.freeze({
					activated: false as const,
					applicationStateDigest: digest(
						"ts-drp/v3-room-migration-state/v1",
						firstProjection.exactCanonicalApplicationStateBytes
					),
					exactCanonicalRecordBytes,
					importedOperationCount: firstProjection.importOperations.length,
					recordDigest: digest("ts-drp/v3-room-migration-record/v1", exactCanonicalRecordBytes),
					recordVertexDigest,
					targetAnchorDigest,
				});
			} catch (error) {
				migrationAcceptingFollowers = false;
				await waitForMigrationFollowers().catch(() => undefined);
				if (reopenedTarget !== undefined) await reopenedTarget.close().catch(() => undefined);
				if (target !== undefined) await target.close().catch(() => undefined);
				throw error;
			}
		} finally {
			migrationAcceptingFollowers = false;
			if (migrationBarrier === ownedMigrationBarrier) migrationBarrier = undefined;
			if (migrationCompletionBarrier === ownedMigrationCompletion) migrationCompletionBarrier = undefined;
			releaseMigrationBarrier?.();
			releaseMigrationCompletion?.();
			await waitForMigrationFollowers().catch(() => undefined);
			if (pendingIssues.length > 0) scheduleDrain();
		}
	};
	return Object.freeze({
		invite,
		roomId: prepared.descriptor.anchorDigest,
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." as const,
		async close(): Promise<void> {
			closed = true;
			await rebasePromise.catch(() => undefined);
			await migrationCompletionBarrier;
			await drainPendingIssues();
			await shutdown();
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			const captured = detachedRoomOperation(operation);
			if (captured === undefined) throw new TypeError("v3 room operation is invalid");
			if (
				migrationRecordAuthority !== undefined &&
				Reflect.get(captured, "action") === "migrationRecord" &&
				!validMigrationRecordOperation(captured, input.author, migrationRecordAuthority)
			) {
				throw new TypeError("v3 room migration record is invalid");
			}
			const priorMigrationBarrier = migrationBarrier;
			const priorMigrationCompletion = migrationCompletionBarrier;
			const joinsMigration = priorMigrationBarrier !== undefined && migrationAcceptingFollowers;
			let settleFollower: ((result: MigrationFollowerResult) => void) | undefined;
			const follower = joinsMigration
				? new Promise<MigrationFollowerResult>((resolve) => {
						settleFollower = resolve;
					})
				: undefined;
			if (follower !== undefined) migrationFollowers.add(follower);
			try {
				await rebasePromise;
				await (joinsMigration ? priorMigrationBarrier : priorMigrationCompletion);
				if (terminalFailure !== undefined) throw terminalFailure;
				if (closed) throw new TypeError("v3 room session is closed");
				const current = logicalTime;
				logicalTime += 2;
				const promise = new Promise<void>((resolve, reject) => {
					pendingIssues.push(Object.freeze({ logicalTime: current, operation: captured, reject, resolve }));
				});
				scheduleDrain();
				await promise;
				settleFollower?.(Object.freeze({ ok: true }));
			} catch (error) {
				settleFollower?.(Object.freeze({ ok: false, reason: error }));
				throw error;
			}
		},
		openEphemeral(options: EphemeralChannelOptions): EphemeralChannel {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			if (transport === undefined) throw new TypeError("v3 room transport is unavailable");
			return transport.openEphemeral(
				{
					authorForPeer(peerId: string): string | undefined {
						const matches = projection.transportPeerAuthors.filter((entry) => entry.peerId === peerId);
						return matches.length === 1 ? matches[0]?.author : undefined;
					},
					currentAuthority() {
						return activeHandle?.currentEphemeralAuthority();
					},
					isCurrentWriter(author: string): boolean {
						return activeHandle?.currentEphemeralAuthority()?.isCurrentWriter(author) === true;
					},
				},
				options
			);
		},
		previewLatchedAcl(): Readonly<Record<string, unknown>> {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const preview = Reflect.get(activeHandle, "previewLatchedAcl");
			if (typeof preview !== "function") throw new TypeError("v3 room latched ACL preview is unavailable");
			const result = Reflect.apply(preview, activeHandle, []) as unknown;
			if (typeof result !== "object" || result === null) {
				throw new TypeError("v3 room latched ACL preview is invalid");
			}
			return result as Readonly<Record<string, unknown>>;
		},
		projection(): Projection {
			if (terminalFailure !== undefined) throw terminalFailure;
			return projection;
		},
		rehearseMigration,
	});
}

async function prepareDurableRoomState<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	material: V3RoomCreatorInviteMaterial,
	sourceMaterial: V3RoomCreatorInviteMaterial | undefined,
	objectId: StorageObjectId,
	requireFreshTrust = false
): Promise<
	Readonly<{
		readonly aheStores: readonly Awaited<ReturnType<typeof createBrowserAheDurableStore>>[];
		readonly issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
		readonly journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
		readonly prepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>;
		readonly recovered: Extract<Awaited<ReturnType<typeof recoverV3LiveReplica>>, { readonly ok: true }>;
	}>
> {
	const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
	const aheStores = [aheStore];
	let issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined;
	let journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>> | undefined;
	try {
		const prepareMaterial = async (
			selected: V3RoomCreatorInviteMaterial,
			store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>,
			fresh = false
		): Promise<Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>> => {
			const trustStore = createCurrentAnchorTrustStore({
				objectId,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
				store,
			});
			const installed = await trustStore.install({
				detachedGenesisSignature: selected.detachedGenesisSignature,
				exactCanonicalGenesisAnchorPreimageBytes: selected.exactCanonicalGenesisAnchorPreimageBytes,
				exactCanonicalProfileBytes: selected.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: selected.exactCanonicalSignerSetBytes,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
			});
			if (fresh && !installed.ok) {
				throw new TypeError("v3 room migration target is already reserved");
			}
			if (!installed.ok && installed.reason !== "already-installed") {
				throw new TypeError(`v3 room trust installation failed: ${installed.reason}`);
			}
			const openedTrust = installed.ok ? installed : await trustStore.open();
			if (!openedTrust.ok || openedTrust.trust.profileId !== "creator-trusted-v1") {
				throw new TypeError("v3 room verified trust profile is invalid");
			}
			const prepared = await prepareV3LiveGeneration({
				authenticationProfile: "creator-only",
				store,
				objectId,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
				exactCanonicalAnchorPreimageBytes: selected.exactCanonicalGenesisAnchorPreimageBytes,
				detachedSignature: selected.detachedGenesisSignature,
				exactCanonicalParametersCarrierBytes: selected.exactCanonicalParametersCarrierBytes,
				catalog: input.application.catalog,
			});
			if (!prepared.ok) throw new TypeError(`v3 room preparation failed: ${prepared.kind}`);
			return prepared;
		};
		let prepared = await prepareMaterial(material, aheStore, requireFreshTrust);
		let sourceAheStore: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined;
		let sourcePrepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }> | undefined;
		if (sourceMaterial !== undefined) {
			sourceAheStore = await createBrowserAheDurableStore({
				databaseName: `${input.databaseName}--rebase-${sourceMaterial.pinnedGenesisAnchorDigest}--ahe`,
			});
			aheStores.push(sourceAheStore);
			sourcePrepared = await prepareMaterial(sourceMaterial, sourceAheStore);
		}
		const openedIssuanceStore = await createBrowserDurableIssuanceStore({
			primaryDatabaseName: input.issuanceDatabaseName,
		});
		issuanceStore = openedIssuanceStore;
		const openedJournalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
		journalStore = openedJournalStore;
		const scope = Object.freeze({ author: input.author, objectId: input.objectId });
		if (requireFreshTrust) {
			const lineage = await openedIssuanceStore.readLineage(scope);
			if (lineage.next !== 0 || lineage.exhausted) {
				throw new TypeError("v3 room migration target issuance is not fresh");
			}
		}
		if (typeof openedJournalStore.readiness === "function") {
			const expectedScope = Object.freeze({
				anchorDigest: material.pinnedGenesisAnchorDigest,
				epoch: 0 as const,
				objectId: input.objectId,
			});
			const sameExpectedScope = (value: unknown): boolean =>
				typeof value === "object" &&
				value !== null &&
				Reflect.get(value, "anchorDigest") === expectedScope.anchorDigest &&
				Reflect.get(value, "epoch") === expectedScope.epoch &&
				Reflect.get(value, "objectId") === expectedScope.objectId;
			let readiness;
			try {
				readiness = await openedJournalStore.readiness({ scope: expectedScope });
			} catch {
				throw new TypeError("v3 room journal readiness failed");
			}
			if (!readiness.ok) throw new TypeError("v3 room journal readiness failed");
			if (requireFreshTrust && readiness.ready) {
				throw new TypeError("v3 room migration target journal is not fresh");
			}
			if (!readiness.ready) {
				if (readiness.kind !== "not-installed") {
					throw new TypeError("v3 room journal readiness is invalid");
				}
			} else {
				if (
					!Number.isSafeInteger(readiness.rowCount) ||
					readiness.rowCount < 0 ||
					!sameExpectedScope(readiness.scope) ||
					typeof readiness.snapshot !== "object" ||
					readiness.snapshot === null ||
					!sameExpectedScope(Reflect.get(readiness.snapshot, "scope"))
				) {
					throw new TypeError("v3 room journal readiness is invalid");
				}
			}
		} else {
			if (sourceMaterial !== undefined) {
				throw new TypeError("v3 room journal readiness is unavailable");
			}
		}
		const recoverPrepared = (): ReturnType<typeof recoverV3LiveReplica> =>
			recoverV3LiveReplica({
				capability: prepared.capability,
				...(sourcePrepared === undefined || sourceMaterial === undefined
					? {}
					: {
							displacedSource: Object.freeze({
								capability: sourcePrepared.capability,
								exactCanonicalLatchedAclBytes: sourceMaterial.exactCanonicalLatchedAclBytes,
							}),
						}),
				exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
				issuanceScope: scope,
				issuanceStore: openedIssuanceStore,
				liveJournalStore: openedJournalStore,
			});
		let recovered = await recoverPrepared();
		if (
			!recovered.ok &&
			recovered.kind === "issuance-rejected" &&
			recovered.detail === "v3 recovery issued record chain is empty"
		) {
			prepared = await prepareMaterial(material, aheStore);
			if (sourceMaterial !== undefined && sourceAheStore !== undefined) {
				sourcePrepared = await prepareMaterial(sourceMaterial, sourceAheStore);
			}
			const admission = prepareBlueprintAdmission({
				canonicalBlueprintPackageBytes: input.application.canonicalBlueprintPackageBytes,
				expectedBlueprintDigest: prepared.descriptor.blueprintDigest,
			});
			const issuer = createAdmissionBoundTransactionalVertexIssuer({
				author: input.author,
				preparedBlueprintAdmission: admission,
				publicKey: Object.freeze({ bytes: new Uint8Array(input.publicKeyBytes), format: "raw" as const }),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				transactIssue: (selectedScope, buildAndSign) => openedIssuanceStore.transactIssue(selectedScope, buildAndSign),
			});
			await issuer.issue({
				anchor: material.pinnedGenesisAnchorDigest,
				dependencies: [material.pinnedGenesisAnchorDigest],
				epoch: 0,
				logicalTime: 1,
				objectId: input.objectId,
				operation: input.application.bootstrapOperation,
			});
			recovered = await recoverPrepared();
		}
		if (!recovered.ok) throw new TypeError(`v3 room recovery failed: ${recovered.kind}`);
		return Object.freeze({
			aheStores: Object.freeze([...aheStores]),
			issuanceStore: openedIssuanceStore,
			journalStore: openedJournalStore,
			prepared,
			recovered,
		});
	} catch (error) {
		const closers: Promise<void>[] = aheStores.map((store) => store.close());
		if (issuanceStore !== undefined) closers.push(issuanceStore.close());
		if (journalStore !== undefined) closers.push(journalStore.close());
		await Promise.allSettled(closers);
		throw error;
	}
}

function compareAcceptedVertices(left: V3RoomAcceptedVertex, right: V3RoomAcceptedVertex): number {
	return (
		left.epoch - right.epoch ||
		left.logicalTime - right.logicalTime ||
		compareText(left.author, right.author) ||
		left.authorSequence - right.authorSequence ||
		compareText(hex(left.digest), hex(right.digest))
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
