import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
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

function acceptedOperationsForVertex(
	application: V3RoomApplication,
	vertex: V3RoomAcceptedVertex
): readonly V3RoomAcceptedOperation[] | undefined {
	const vertexDigest = hex(vertex.digest);
	const operation = detachedRoomOperation(vertex.operation);
	if (operation === undefined) return undefined;
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

/**
 * Opens one browser v3 room from application material and a real transport adapter.
 * @param input - Closed application, identity, durable-store and transport bindings.
 * @returns The active room session after durable recovery and live activation.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
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
		objectIdResult.value
	);
	const acceptedVertices = new Map<string, V3RoomAcceptedVertex>();
	const acceptedOperationRows = new Map<string, readonly V3RoomAcceptedOperation[] | null>();
	let projection: Projection;
	let logicalTime = input.initialLogicalTime;
	const expand = (vertex: V3RoomAcceptedVertex): readonly V3RoomAcceptedOperation[] | undefined => {
		const identity = hex(vertex.digest);
		const cached = acceptedOperationRows.get(identity);
		if (cached !== undefined) return cached === null ? undefined : cached;
		const expanded = acceptedOperationsForVertex(input.application, vertex);
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
	return Object.freeze({
		invite,
		roomId: prepared.descriptor.anchorDigest,
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." as const,
		async close(): Promise<void> {
			closed = true;
			await rebasePromise.catch(() => undefined);
			for (;;) {
				if (pendingIssues.length > 0) scheduleDrain();
				await drainPromise;
				if (!drainScheduled && !draining && pendingIssues.length === 0) break;
			}
			await shutdown();
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			const captured = detachedRoomOperation(operation);
			if (captured === undefined) throw new TypeError("v3 room operation is invalid");
			await rebasePromise;
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			const current = logicalTime;
			logicalTime += 2;
			const promise = new Promise<void>((resolve, reject) => {
				pendingIssues.push(Object.freeze({ logicalTime: current, operation: captured, reject, resolve }));
			});
			scheduleDrain();
			return promise;
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
	});
}

async function prepareDurableRoomState<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	material: V3RoomCreatorInviteMaterial,
	sourceMaterial: V3RoomCreatorInviteMaterial | undefined,
	objectId: StorageObjectId
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
			store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>
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
		let prepared = await prepareMaterial(material, aheStore);
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
