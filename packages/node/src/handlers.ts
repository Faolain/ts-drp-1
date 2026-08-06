import { DRPIntervalDiscovery } from "@ts-drp/interval-discovery";
import {
	AdoptionCommitExhaustedError,
	ApplyInvariantError,
	authenticateVertices,
	HashGraph,
	mergeAuthenticatedVertices,
	readAuthenticatedClockPending,
} from "@ts-drp/object";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	type AggregatedAttestation,
	type ApplyResult,
	Attestation,
	AttestationUpdate,
	DRPStateOtherTheWire,
	FetchState,
	FetchStateResponse,
	type IDRP,
	type IDRPObject,
	type IFinalityStore,
	Message,
	MessageType,
	NodeEventName,
	Sync,
	SyncAccept,
	SyncReject,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { isPromise } from "@ts-drp/utils";
import { MessageSchema } from "@ts-drp/validation/message";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";
import { sendSyncObject } from "./operations.js";
import {
	advertisedTheseHeads,
	completePresentExactRequests,
	markHeadsProtocol,
	queueExactRequests,
	recordBranchCuts,
	recordSharedHeads,
	usesHeadsProtocol,
} from "./sync-state.js";

export { SYNC_RECOVERY_COOLDOWN_MS } from "./sync-state.js";

const metrics = new OpentelemetryMetrics("@ts-drp/node/handlers");

interface HandleParams {
	node: DRPNode;
	message: Message;
}

interface IHandlerStrategy {
	(handleParams: HandleParams): Promise<void> | void;
}

interface HandlerRegistryEntry {
	handler: IHandlerStrategy;
	vertexIngress: false | typeof authenticateVertices;
}

type AuthenticatedClockPendingMergeOutcome = Awaited<ReturnType<typeof mergeAuthenticatedVertices>>;

const MAX_UPDATE_VERTICES = 32;
const MAX_INVALID_VERTICES_PER_PEER = 10_000;
const MAX_INVALID_PEER_BUDGETS = 256;

function legacyFinalityStore<T extends IDRP>(object: IDRPObject<T>): IFinalityStore | undefined {
	if (object.replicaMode === "observer") return undefined;
	const finalityStore = object.finalityStore;
	return finalityStore.enabled === false ? undefined : finalityStore;
}

interface InvalidPeerBudget {
	exhausted: boolean;
	invalidOccurrences: number;
}

const invalidPeerBudgets = new WeakMap<DRPNode, Map<string, InvalidPeerBudget>>();

function disconnectInvalidPeer(node: DRPNode, sender: string): void {
	void node.networkNode.disconnect(sender).catch((error: unknown) => {
		log.error("::messageHandler: Failed to disconnect invalid peer", error);
	});
}

function isInvalidPeerExhausted(node: DRPNode, sender: string): boolean {
	return invalidPeerBudgets.get(node)?.get(sender)?.exhausted === true;
}

function accountInvalidVertices(node: DRPNode, sender: string, invalidOccurrences: number): boolean {
	const budgets = invalidPeerBudgets.get(node) ?? new Map<string, InvalidPeerBudget>();
	const existing = budgets.get(sender);
	if (existing?.exhausted === true) return true;
	if (invalidOccurrences === 0) return false;

	if (existing === undefined && budgets.size >= MAX_INVALID_PEER_BUDGETS) {
		// Remembering overflow identities would move the unbounded sender-key surface.
		// Drop this invalid offer, disconnect, and leave valid traffic ledger-free.
		disconnectInvalidPeer(node, sender);
		return true;
	}

	const total = Math.min(MAX_INVALID_VERTICES_PER_PEER, (existing?.invalidOccurrences ?? 0) + invalidOccurrences);
	const exhausted = total >= MAX_INVALID_VERTICES_PER_PEER;
	budgets.set(sender, { exhausted, invalidOccurrences: total });
	invalidPeerBudgets.set(node, budgets);
	if (exhausted) disconnectInvalidPeer(node, sender);
	return exhausted;
}

/**
 * Clear node-lifetime invalid-peer accounting after the node has stopped.
 * @param node - Node whose invalid-peer accounting has ended
 */
export function clearInvalidPeerBudgets(node: DRPNode): void {
	invalidPeerBudgets.delete(node);
}

function rejectedBoundaryResult(error: unknown): ApplyResult | undefined {
	if (error instanceof AdoptionCommitExhaustedError || error instanceof ApplyInvariantError) {
		return error.partialResult;
	}
	return undefined;
}

function trueMissingHashes(missing: readonly string[], clockPending: readonly string[]): string[] {
	if (clockPending.length === 0) return [...missing];
	const pending = new Set(clockPending);
	return missing.filter((hash) => !pending.has(hash));
}

function exactMissingDependencies<T extends IDRP>(
	object: IDRPObject<T>,
	offered: readonly Vertex[],
	missingOffers: readonly string[]
): string[] {
	const offeredByHash = new Map(offered.map((vertex) => [vertex.hash, vertex]));
	const requested = new Set<string>();
	const visited = new Set<string>();
	const visit = (hash: string): void => {
		if (object.getVertex(hash) !== undefined || visited.has(hash)) return;
		visited.add(hash);
		const vertex = offeredByHash.get(hash);
		if (vertex === undefined) {
			requested.add(hash);
			return;
		}
		for (const dependency of vertex.dependencies) visit(dependency);
	};
	for (const hash of missingOffers) visit(hash);
	return [...requested];
}

async function mergeWithRejectedBoundaryRecovery<T extends IDRP>(
	node: DRPNode,
	object: IDRPObject<T>,
	sender: string,
	vertices: Vertex[]
): Promise<{ exhausted: boolean; outcome: AuthenticatedClockPendingMergeOutcome }> {
	try {
		const outcome = await mergeAuthenticatedVertices(object, vertices);
		return {
			exhausted: accountInvalidVertices(node, sender, outcome.result[2].length),
			outcome,
		};
	} catch (error) {
		const partialResult = rejectedBoundaryResult(error);
		if (partialResult === undefined) throw error;
		const exhausted = accountInvalidVertices(node, sender, partialResult.invalid.length);
		const rawMissing = trueMissingHashes(partialResult.missing, readAuthenticatedClockPending(error));
		const authenticatedHashes = new Set(authenticateVertices(vertices).map(({ hash }) => hash));
		completePresentExactRequests(
			node,
			object.id,
			sender,
			(hash) => object.getVertex(hash) !== undefined || authenticatedHashes.has(hash)
		);
		const missing = exactMissingDependencies(object, vertices, rawMissing);

		if (!exhausted && missing.length !== 0 && queueExactRequests(node, object.id, sender, missing)) {
			try {
				await node.syncObject(object.id, sender);
			} catch (recoveryError) {
				log.error("::messageHandler: Rejected-boundary recovery failed", recoveryError);
			}
		}
		try {
			node.put(object.id, object);
		} catch (persistenceError) {
			log.error("::messageHandler: Rejected-boundary persistence failed", persistenceError);
		}
		throw error;
	}
}

export const messageHandlers: Record<MessageType, HandlerRegistryEntry | undefined> = {
	[MessageType.MESSAGE_TYPE_UNSPECIFIED]: undefined,
	[MessageType.MESSAGE_TYPE_FETCH_STATE]: { handler: fetchStateHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE]: { handler: fetchStateResponseHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_UPDATE]: { handler: updateHandler, vertexIngress: authenticateVertices },
	[MessageType.MESSAGE_TYPE_SYNC]: { handler: syncHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_SYNC_ACCEPT]: { handler: syncAcceptHandler, vertexIngress: authenticateVertices },
	[MessageType.MESSAGE_TYPE_SYNC_REJECT]: { handler: syncRejectHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE]: { handler: attestationUpdateHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_DRP_DISCOVERY]: { handler: drpDiscoveryHandler, vertexIngress: false },
	[MessageType.MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE]: {
		handler: ({ node, message }) => node.handleDiscoveryResponse(message.sender, message),
		vertexIngress: false,
	},
	[MessageType.MESSAGE_TYPE_CUSTOM]: undefined,
	[MessageType.UNRECOGNIZED]: undefined,
};

/**
 * Handle message and run the handler
 * @param node - The DRP node instance handling the request
 * @param message - The incoming message
 */
export async function handleMessage(node: DRPNode, message: Message): Promise<void> {
	if (isInvalidPeerExhausted(node, message.sender)) return;
	const validation = MessageSchema.safeParse(message);
	if (!validation.success) {
		log.error(`::messageHandler: Invalid message format ${validation.error.message}`);
		return;
	}
	const validatedMessage = validation.data;
	const entry = messageHandlers[validatedMessage.type];
	if (!entry) {
		log.error("::messageHandler: Invalid operation");
		return;
	}
	const result = entry.handler({ node, message: validatedMessage });
	if (isPromise(result)) {
		await result;
	}
}

function fetchStateHandler({ node, message }: HandleParams): ReturnType<IHandlerStrategy> {
	const { data, sender } = message;
	const fetchState = FetchState.decode(data);
	const drpObject = node.get(message.objectId);
	if (!drpObject) {
		log.error("::fetchStateHandler: Object not found");
		return;
	}

	const [aclState, drpState] =
		fetchState.vertexHash === HashGraph.rootHash
			? drpObject.getSerializedStates(fetchState.vertexHash)
			: [undefined, undefined];
	const response = FetchStateResponse.create({
		vertexHash: fetchState.vertexHash,
		// Preserve explicit absence for cost-gated non-root requests and unavailable snapshots.
		// Serializing undefined would manufacture a present-but-empty state.
		aclState: aclState === undefined ? undefined : DRPStateOtherTheWire.decode(aclState),
		drpState: drpState === undefined ? undefined : DRPStateOtherTheWire.decode(drpState),
	});

	const messageFetchStateResponse = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
		data: FetchStateResponse.encode(response).finish(),
		objectId: drpObject.id,
	});
	node.networkNode.sendMessage(sender, messageFetchStateResponse).catch((e) => {
		log.error("::fetchStateHandler: Error sending message", e);
	});

	node.safeDispatchEvent(NodeEventName.DRP_FETCH_STATE, {
		detail: {
			id: drpObject.id,
			fetchState,
		},
	});
}

function fetchStateResponseHandler({ node, message }: HandleParams): ReturnType<IHandlerStrategy> {
	const { data } = message;
	const fetchStateResponse = FetchStateResponse.decode(data);
	if (!fetchStateResponse.drpState && !fetchStateResponse.aclState) {
		log.error("::fetchStateResponseHandler: No state found");
	}
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::fetchStateResponseHandler: Object not found");
		return;
	}
	if (!object.acl) {
		log.error("::fetchStateResponseHandler: ACL not found");
		return;
	}

	// Network-provided ACL/DRP state snapshots are never adopted. Under id-binding,
	// authority and DRP state are derived locally by applying signed vertices, never
	// copied from an unauthenticated, unsolicited response. Honest `fetchState`
	// (operations.ts) only ever requests the root hash, so a non-root snapshot
	// is never legitimate, and a root snapshot would overwrite genesis authority that
	// is derived from the creator-bound object id. Either way the state is dropped;
	// convergence still occurs because joiners derive genesis locally and then sync
	// the signed vertices. The event below only signals that a responder exists.
	node.safeDispatchEvent(NodeEventName.DRP_FETCH_STATE_RESPONSE, {
		detail: {
			id: object.id,
			fetchStateResponse,
		},
	});
}

function attestationUpdateHandler({ node, message }: HandleParams): ReturnType<IHandlerStrategy> {
	const { data, sender } = message;
	const attestationUpdate = AttestationUpdate.decode(data);
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::attestationUpdateHandler: Object not found");
		return;
	}
	const finalityStore = legacyFinalityStore(object);
	if (finalityStore === undefined) return;

	if (object.acl.query_isFinalitySigner(sender)) {
		finalityStore.addSignatures(sender, attestationUpdate.attestations);
		node.safeDispatchEvent(NodeEventName.DRP_ATTESTATION_UPDATE, {
			detail: {
				id: object.id,
			},
		});
	}
}

/*
  data: { id: string, operations: {nonce: string, fn: string, args: string[] }[] }
  operations array doesn't contain the full remote operations array
*/
async function updateHandler({ node, message }: HandleParams): Promise<void> {
	if (!isTracingEnabled()) return updateHandlerUntraced({ node, message });

	return metrics.traceFunc(
		"node.updateHandler",
		(params: HandleParams) => updateHandlerUntraced(params),
		(span, { message: candidate }) => {
			span.setAttribute("drp.object.id", candidate.objectId);
			span.setAttribute("drp.message.sender", candidate.sender);
		}
	)({ node, message });
}

async function updateHandlerUntraced({ node, message }: HandleParams): Promise<void> {
	const { sender, data } = message;

	const updateMessage = Update.decode(data);
	if (updateMessage.vertices.length > MAX_UPDATE_VERTICES) {
		log.error("::updateHandler: Too many vertices");
		return;
	}
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::updateHandler: Object not found");
		return;
	}

	const governedOutcome = await mergeWithRejectedBoundaryRecovery(node, object, sender, updateMessage.vertices);
	const mergeOutcome = governedOutcome.outcome;
	const authenticatedHashes = new Set(mergeOutcome.authenticatedHashes);
	completePresentExactRequests(
		node,
		object.id,
		sender,
		(hash) => object.getVertex(hash) !== undefined || authenticatedHashes.has(hash)
	);
	const missing = exactMissingDependencies(
		object,
		updateMessage.vertices,
		trueMissingHashes(mergeOutcome.result[1], mergeOutcome.clockPending)
	);
	const appliedVertices = [...mergeOutcome.committed];

	const finalityStore = appliedVertices.length === 0 ? undefined : legacyFinalityStore(object);
	if (finalityStore !== undefined) {
		// add their signatures — only if the sender is a finality signer on the LIVE
		// ACL. Mirrors attestationUpdateHandler; without this gate a non-signer could
		// piggyback forged attestations on an UPDATE and have them counted toward
		// finality (finality-integrity bypass).
		if (object.acl.query_isFinalitySigner(sender)) {
			finalityStore.addSignatures(sender, updateMessage.attestations);
		}

		// add my signatures
		const attestations = signFinalityVerticesWithStore(node, finalityStore, appliedVertices);

		if (attestations.length !== 0) {
			// broadcast the attestations
			const message = Message.create({
				sender: node.networkNode.peerId,
				type: MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE,
				data: AttestationUpdate.encode(
					AttestationUpdate.create({
						attestations: attestations,
					})
				).finish(),
				objectId: object.id,
			});

			node.networkNode.broadcastMessage(object.id, message).catch((e) => {
				log.error("::updateHandler: Error broadcasting message", e);
			});
		}
	}

	// The merge may have committed valid siblings before this batch exhausted the
	// peer. Publish those commits normally; only attacker-driven recovery stops.
	if (
		!governedOutcome.exhausted &&
		missing.length !== 0 &&
		queueExactRequests(node, message.objectId, sender, missing)
	) {
		await node.syncObject(message.objectId, sender);
	}

	node.put(object.id, object);

	node.safeDispatchEvent(NodeEventName.DRP_UPDATE, {
		detail: {
			id: object.id,
			update: updateMessage,
		},
	});
}

/**
 * Handles incoming sync requests from other nodes in the DRP network.
 * This handler is responsible for:
 * 1. Verifying the sync request and checking if the object exists
 * 2. Comparing vertex hashes between local and remote states
 * 3. Preparing and sending a sync accept response with:
 * - Vertices that the remote node is missing
 * - Vertices that the local node is requesting
 * - Relevant attestations for the vertices being sent
 * @param params - The handler parameters containing:
 * @param params.node - The DRP node instance handling the request
 * @param params.message - The incoming sync message containing vertex hashes
 * @returns A promise that resolves when the sync response is sent
 * @throws {Error} If the stream is undefined or if the object is not found
 */
async function syncHandler(params: HandleParams): Promise<void> {
	const syncMessage = Sync.decode(params.message.data);
	if (
		syncMessage.heads.length === 0 &&
		syncMessage.sharedHeads.length === 0 &&
		syncMessage.requestedHashes.length === 0
	) {
		await fullInventorySyncHandler(params, syncMessage);
		return;
	}
	await headsSyncHandler(params, syncMessage);
}

async function sendHistoryUnavailable(
	node: DRPNode,
	objectId: string,
	sender: string,
	missingHashes: readonly string[]
): Promise<void> {
	const rejection = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_REJECT,
		data: SyncReject.encode(
			SyncReject.create({ missingHashes: [...missingHashes], reason: "history-unavailable" })
		).finish(),
		objectId,
	});
	await node.networkNode.sendMessage(sender, rejection);
}

async function headsSyncHandler({ node, message }: HandleParams, syncMessage: Sync): Promise<void> {
	const { sender } = message;
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::syncHandler: Object not found");
		return;
	}

	const localHeads = object.getHistoryHeads();
	markHeadsProtocol(node, object.id, sender);
	const knownRemoteHeads = syncMessage.heads.filter((hash) => object.getVertex(hash) !== undefined);
	const unknownRemoteHeads = syncMessage.heads.filter((hash) => object.getVertex(hash) === undefined);
	const verifiedSharedHeads = syncMessage.sharedHeads.filter((hash) => object.getVertex(hash) !== undefined);
	if (knownRemoteHeads.length !== 0) {
		recordSharedHeads(node, object.id, sender, knownRemoteHeads);
	}
	recordBranchCuts(
		node,
		object.id,
		sender,
		verifiedSharedHeads.filter((hash) => !knownRemoteHeads.includes(hash))
	);

	const boundaries = new Set([...knownRemoteHeads, ...verifiedSharedHeads, HashGraph.rootHash]);
	const mayWalkDelta = knownRemoteHeads.length !== 0 || verifiedSharedHeads.length !== 0;
	const delta = mayWalkDelta
		? object.readHistorySuffix(localHeads, boundaries)
		: ({ status: "available", vertices: [] } as const);
	if (delta.status === "history-unavailable") {
		await sendHistoryUnavailable(node, object.id, sender, delta.missingHashes);
		return;
	}

	const exactRead = object.readHistory(syncMessage.requestedHashes);
	if (exactRead.status === "history-unavailable") {
		await sendHistoryUnavailable(node, object.id, sender, exactRead.missingHashes);
		return;
	}
	const exact = exactRead.status === "available" ? exactRead.vertices : [];
	const selectedByHash = new Map<string, Vertex>();
	for (const vertex of delta.status === "available" ? delta.vertices : []) selectedByHash.set(vertex.hash, vertex);
	for (const vertex of exact) selectedByHash.set(vertex.hash, vertex);
	const selected = [...selectedByHash.values()];

	if (selected.length !== 0) {
		await signGeneratedVertices(node, selected);
		const response = Message.create({
			sender: node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
			data: SyncAccept.encode(
				SyncAccept.create({
					requested: selected,
					attestations: getAttestations(object, selected),
					requesting: [],
				})
			).finish(),
			objectId: object.id,
		});
		await node.networkNode.sendMessage(sender, response);
	}

	const queuedUnknown = queueExactRequests(node, object.id, sender, unknownRemoteHeads);
	const isReciprocalProof = advertisedTheseHeads(node, object.id, sender, syncMessage.heads);
	const shouldReciprocate =
		syncMessage.heads.length !== 0 && unknownRemoteHeads.length === 0 && selected.length === 0 && !isReciprocalProof;
	if (queuedUnknown) {
		await node.syncObject(object.id, sender);
	} else if (shouldReciprocate) {
		await sendSyncObject(node, object.id, sender, "inbound-reciprocity");
	}
}

async function fullInventorySyncHandler({ node, message }: HandleParams, syncMessage: Sync): Promise<void> {
	const { sender } = message;
	// (might send reject) <- TODO: when should we reject?
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::syncHandler: Object not found");
		return;
	}
	if (object.historyStorage === "compact") {
		const remoteHashes = new Set(syncMessage.vertexHashes);
		const availableHashes = new Set(object.historyInventory.availablePayloadHashes);
		const unavailableHashes = object.historyInventory.knownHashes.filter(
			(hash) => !remoteHashes.has(hash) && !availableHashes.has(hash)
		);
		if (unavailableHashes.length !== 0) {
			const rejection = Message.create({
				sender: node.networkNode.peerId,
				type: MessageType.MESSAGE_TYPE_SYNC_REJECT,
				data: SyncReject.encode(
					SyncReject.create({ missingHashes: unavailableHashes, reason: "history-unavailable" })
				).finish(),
				objectId: object.id,
			});
			node.networkNode.sendMessage(sender, rejection).catch((error) => {
				log.error("::syncHandler: Error sending history-unavailable rejection", error);
			});
			return;
		}
	}

	await signGeneratedVertices(node, object.vertices);

	const localVertices = object.vertices;

	const requested: Set<Vertex> = new Set(localVertices);
	const localVerticesByHash = new Map<string, Vertex>();
	// Reverse fill preserves Array.find's first match when duplicate hashes are present.
	for (let index = localVertices.length - 1; index >= 0; index--) {
		const vertex = localVertices[index];
		localVerticesByHash.set(vertex.hash, vertex);
	}
	const requesting: string[] = [];
	for (const h of syncMessage.vertexHashes) {
		const vertex = localVerticesByHash.get(h);
		if (vertex) {
			requested.delete(vertex);
		} else {
			requesting.push(h);
		}
	}

	if (requested.size === 0 && requesting.length === 0) return;

	const attestations = getAttestations(object, [...requested]);

	const messageSyncAccept = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		// add data here
		data: SyncAccept.encode(
			SyncAccept.create({
				requested: [...requested],
				attestations,
				requesting,
			})
		).finish(),
		objectId: object.id,
	});

	node.networkNode.sendMessage(sender, messageSyncAccept).catch((e) => {
		log.error("::syncHandler: Error sending message", e);
	});

	node.safeDispatchEvent(NodeEventName.DRP_SYNC, {
		detail: {
			id: object.id,
			requested,
			requesting,
		},
	});
}

/*
  data: { id: string, operations: {nonce: string, fn: string, args: string[] }[] }
  operations array contain the full remote operations array
*/
async function syncAcceptHandler({ node, message }: HandleParams): Promise<void> {
	if (!isTracingEnabled()) return syncAcceptHandlerUntraced({ node, message });

	return metrics.traceFunc(
		"node.syncAcceptHandler",
		(params: HandleParams) => syncAcceptHandlerUntraced(params),
		(span, { message: candidate }) => {
			span.setAttribute("drp.object.id", candidate.objectId);
			span.setAttribute("drp.message.sender", candidate.sender);
		}
	)({ node, message });
}

async function syncAcceptHandlerUntraced({ node, message }: HandleParams): Promise<void> {
	const { data, sender } = message;
	const syncAcceptMessage = SyncAccept.decode(data);
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::syncAcceptHandler: Object not found");
		return;
	}

	let mergeRan = false;
	let appliedProgress = false;
	let committedVertices: readonly Vertex[] = [];
	let rawMissing: string[] = [];
	let missing: string[] = [];
	let suppressMissingRecovery = false;
	const finalityStore = legacyFinalityStore(object);
	const headsMode = usesHeadsProtocol(node, object.id, sender);
	const preMergeHeads = headsMode ? new Set(object.getHistoryHeads()) : new Set<string>();
	const preExistingDependencies = headsMode
		? new Set(
				syncAcceptMessage.requested.flatMap(({ dependencies }) =>
					dependencies.filter((hash) => object.getVertex(hash) !== undefined)
				)
			)
		: new Set<string>();
	if (syncAcceptMessage.requested.length !== 0) {
		const governedOutcome = await mergeWithRejectedBoundaryRecovery(node, object, sender, syncAcceptMessage.requested);
		const mergeOutcome = governedOutcome.outcome;
		suppressMissingRecovery = governedOutcome.exhausted;
		mergeRan = mergeOutcome.hasTrustedOrAuthenticatedOffers;
		appliedProgress = mergeOutcome.committed.length !== 0;
		committedVertices = mergeOutcome.committed;
		rawMissing = mergeOutcome.result[1];
		const authenticatedHashes = new Set(mergeOutcome.authenticatedHashes);
		completePresentExactRequests(
			node,
			object.id,
			sender,
			(hash) => object.getVertex(hash) !== undefined || authenticatedHashes.has(hash)
		);
		missing = exactMissingDependencies(
			object,
			syncAcceptMessage.requested,
			trueMissingHashes(rawMissing, mergeOutcome.clockPending)
		);
		if (mergeRan && finalityStore !== undefined) {
			finalityStore.mergeSignatures(syncAcceptMessage.attestations);
		}
		if (mergeRan) {
			node.put(object.id, object);
			if (!suppressMissingRecovery && missing.length !== 0 && queueExactRequests(node, object.id, sender, missing)) {
				await node.syncObject(object.id, sender);
			}
		}
		recordBranchCuts(
			node,
			object.id,
			sender,
			[...preExistingDependencies].filter((hash) => !preMergeHeads.has(hash))
		);
	}

	if (!headsMode) await signGeneratedVertices(node, object.vertices);
	if (finalityStore !== undefined) {
		const finalityVertices = headsMode ? [...committedVertices] : object.vertices;
		const addedAttestations = signFinalityVerticesWithStore(node, finalityStore, finalityVertices);
		if (addedAttestations.length !== 0) {
			// Vertices learned through sync must still propagate our finality
			// signatures; otherwise a sync that front-runs the gossip UPDATE would
			// strand these attestations on this replica.
			const attestationUpdate = Message.create({
				sender: node.networkNode.peerId,
				type: MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE,
				data: AttestationUpdate.encode(AttestationUpdate.create({ attestations: addedAttestations })).finish(),
				objectId: object.id,
			});
			node.networkNode.broadcastMessage(object.id, attestationUpdate).catch((e) => {
				log.error("::syncAcceptHandler: Error broadcasting attestations", e);
			});
		}
	}

	if (!suppressMissingRecovery && appliedProgress && rawMissing.length === 0) {
		node.safeDispatchEvent(NodeEventName.DRP_SYNC_ACCEPTED, {
			detail: { id: object.id },
		});
	}

	// send missing vertices
	const historyRead =
		object.historyStorage === "compact"
			? object.readHistory(syncAcceptMessage.requesting)
			: {
					status: "available" as const,
					vertices: syncAcceptMessage.requesting.flatMap((hash) => {
						const vertex = object.getVertex(hash);
						return vertex === undefined ? [] : [vertex];
					}),
				};
	if (historyRead.status === "history-unavailable") {
		const rejection = Message.create({
			sender: node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC_REJECT,
			data: SyncReject.encode(
				SyncReject.create({ missingHashes: [...historyRead.missingHashes], reason: "history-unavailable" })
			).finish(),
			objectId: object.id,
		});
		node.networkNode.sendMessage(sender, rejection).catch((error) => {
			log.error("::syncAcceptHandler: Error sending history-unavailable rejection", error);
		});
		return;
	}
	const requested: Vertex[] = historyRead.status === "available" ? [...historyRead.vertices] : [];

	if (requested.length === 0) return;
	if (headsMode) await signGeneratedVertices(node, requested);

	const attestations = getAttestations(object, requested);

	const messageSyncAccept = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		data: SyncAccept.encode(
			SyncAccept.create({
				requested,
				attestations,
				requesting: [],
			})
		).finish(),
		objectId: object.id,
	});
	node.networkNode.sendMessage(sender, messageSyncAccept).catch((e) => {
		log.error("::syncAcceptHandler: Error sending message", e);
	});
	node.safeDispatchEvent(NodeEventName.DRP_SYNC_MISSING, {
		detail: {
			id: object.id,
			requested,
			requesting: [],
		},
	});
}

async function drpDiscoveryHandler({ node, message }: HandleParams): Promise<void> {
	await DRPIntervalDiscovery.handleDiscoveryRequest(message.sender, message, node.networkNode);
}

/* data: { id: string } */
function syncRejectHandler(_handleParams: HandleParams): ReturnType<IHandlerStrategy> {
	// TODO: handle reject. Possible actions:
	// - Retry sync
	// - Ask sync from another peer
	// - Do nothing
}

/**
 * Handle changes to an object.
 * @param node - The DRP node instance handling the request
 * @param obj - The object that changed
 * @param originFn - The function that caused the change
 * @param vertices - The vertices that caused the change
 */
export function drpObjectChangesHandler<T extends IDRP>(
	node: DRPNode,
	obj: IDRPObject<T>,
	originFn: string,
	vertices: Vertex[]
): void {
	switch (originFn) {
		case "merge":
			node.put(obj.id, obj);
			break;
		case "callFn": {
			const attestations = signFinalityVertices(node, obj, vertices);
			node.put(obj.id, obj);

			signGeneratedVertices(node, vertices)
				.then(() => {
					// send vertices to the pubsub group
					const message = Message.create({
						sender: node.networkNode.peerId,
						type: MessageType.MESSAGE_TYPE_UPDATE,
						data: Update.encode(
							Update.create({
								vertices: vertices,
								attestations: attestations,
							})
						).finish(),
						objectId: obj.id,
					});
					node.networkNode.broadcastMessage(obj.id, message).catch((e) => {
						log.error("::drpObjectChangesHandler: Error broadcasting message", e);
					});
				})
				.catch((e) => {
					log.error("::drpObjectChangesHandler: Error signing vertices", e);
				});
			break;
		}
		default:
			log.error("::createObject: Invalid origin function");
	}
}

/**
 * Sign generated vertices.
 * @param node - The DRP node instance handling the request
 * @param vertices - The vertices to sign
 */
export async function signGeneratedVertices(node: DRPNode, vertices: Vertex[]): Promise<void> {
	const signPromises = vertices.map(async (vertex) => {
		if (vertex.peerId !== node.networkNode.peerId || vertex.signature.length !== 0) {
			return;
		}
		try {
			vertex.signature = await node.keychain.signWithSecp256k1(vertex.hash);
		} catch (error) {
			log.error("::signGeneratedVertices: Error signing vertex:", vertex.hash, error);
		}
	});

	await Promise.all(signPromises);
}

/**
 * Sign vertices for finality.
 * @param node - The DRP node instance handling the request
 * @param obj - The object that changed
 * @param vertices - The vertices to sign
 * @returns The added attestations
 */
export function signFinalityVertices<T extends IDRP>(
	node: DRPNode,
	obj: IDRPObject<T>,
	vertices: Vertex[]
): Attestation[] {
	const finalityStore = legacyFinalityStore(obj);
	return finalityStore === undefined ? [] : signFinalityVerticesWithStore(node, finalityStore, vertices);
}

function signFinalityVerticesWithStore(
	node: DRPNode,
	finalityStore: IFinalityStore,
	vertices: Vertex[]
): Attestation[] {
	const attestations = generateAttestations(node, finalityStore, vertices);
	return finalityStore.addSignatures(node.networkNode.peerId, attestations, false);
}

function generateAttestations(node: DRPNode, finalityStore: IFinalityStore, vertices: Vertex[]): Attestation[] {
	// Two condition:
	// - The node can sign the vertex
	// - The node hasn't signed for the vertex
	const goodVertices = vertices.filter(
		(v) =>
			finalityStore.canSign(node.networkNode.peerId, v.hash) && !finalityStore.signed(node.networkNode.peerId, v.hash)
	);
	return goodVertices.map((v) =>
		Attestation.create({
			data: v.hash,
			signature: node.keychain.signWithBls(v.hash),
		})
	);
}

function getAttestations<T extends IDRP>(object: IDRPObject<T>, vertices: Vertex[]): AggregatedAttestation[] {
	const finalityStore = legacyFinalityStore(object);
	if (finalityStore === undefined) return [];
	return (
		vertices
			.map((v) => finalityStore.getAttestation(v.hash))
			.filter((a): a is AggregatedAttestation => a !== undefined) ?? []
	);
}

/**
 * Authenticate incoming vertices before they are merged.
 *
 * Author authentication (the signature must recover to the claimed peerId) is
 * ALWAYS enforced for EVERY vertex, regardless of `permissionless` and
 * regardless of DRP-vs-ACL type. Both ACL ops (grant/revoke/setKey, which run
 * with `context.caller = vertex.peerId` and decide authority) and DRP ops (which
 * apply with `context.caller = vertex.peerId`, e.g. "move peer X's piece") derive
 * their effect from the claimed author, so a forgeable author would let any peer
 * impersonate another. The `permissionless` flag relaxes ONLY the writer-permission
 * gate — enforced in the ACL layer via `query_isWriter` — never author identity;
 * a permissionless writer still authors as themselves with a valid signature.
 * @param _object - The object the vertices are being merged into (unused: identity
 * authentication is object-independent; kept for a stable call-site signature)
 * @param incomingVertices - The incoming vertices to authenticate
 * @returns The vertices that are safe to merge, in their original order
 */
export function authenticateIncomingVertices<T extends IDRP>(
	_object: IDRPObject<T>,
	incomingVertices: Vertex[]
): Vertex[] {
	return authenticateVertices(incomingVertices);
}

/**
 * Verify incoming vertices.
 * @param incomingVertices - The incoming vertices to verify
 * @returns The verified vertices
 */
export function verifyACLIncomingVertices(incomingVertices: Vertex[]): Vertex[] {
	return authenticateVertices(incomingVertices);
}
