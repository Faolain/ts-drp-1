import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { sha256 } from "@noble/hashes/sha2";
import { Signature } from "@noble/secp256k1";
import { DRPIntervalDiscovery } from "@ts-drp/interval-discovery";
import { HashGraph } from "@ts-drp/object";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	type AggregatedAttestation,
	Attestation,
	AttestationUpdate,
	FetchState,
	FetchStateResponse,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	Sync,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { isPromise } from "@ts-drp/utils";
import { deserializeDRPState, serializeDRPState } from "@ts-drp/utils/serialization";
import { MessageSchema } from "@ts-drp/validation/message";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";

const metrics = new OpentelemetryMetrics("@ts-drp/node/handlers");

interface HandleParams {
	node: DRPNode;
	message: Message;
}

interface IHandlerStrategy {
	(handleParams: HandleParams): Promise<void> | void;
}

const MAX_SYNC_RECOVERY_RETRIES = 3;
export const SYNC_RECOVERY_COOLDOWN_MS = 30_000;

interface SyncRecoveryEpisode {
	retries?: number;
	cooldownUntil?: number;
}

// SYNC/SYNC_ACCEPT have no correlation id, so stale accepts from the same peer
// necessarily share the current (objectId, sender) recovery episode budget.
const syncRecoveryEpisodes = new WeakMap<DRPNode, Map<string, SyncRecoveryEpisode>>();

function recoveryKey(objectId: string, sender: string): string {
	return JSON.stringify([objectId, sender]);
}

/**
 * Clear all recovery episodes associated with one object subscription.
 * @param node - Node whose recovery state should be cleared
 * @param objectId - Object subscription being removed
 */
export function clearSyncRecoveryEpisodes(node: DRPNode, objectId: string): void {
	const episodes = syncRecoveryEpisodes.get(node);
	if (!episodes) return;

	for (const key of episodes.keys()) {
		const [episodeObjectId] = JSON.parse(key) as [string, string];
		if (episodeObjectId === objectId) episodes.delete(key);
	}
	if (episodes.size === 0) syncRecoveryEpisodes.delete(node);
}

async function recoverMissingSync(node: DRPNode, objectId: string, sender: string, missing: string[]): Promise<void> {
	const key = recoveryKey(objectId, sender);
	const episodes = syncRecoveryEpisodes.get(node) ?? new Map<string, SyncRecoveryEpisode>();
	const episode = episodes.get(key);

	if (missing.length === 0) {
		episodes.delete(key);
		if (episodes.size === 0) syncRecoveryEpisodes.delete(node);
		return;
	}

	if (episode?.cooldownUntil !== undefined) {
		if (Date.now() < episode.cooldownUntil) return;
		episodes.delete(key);
	}

	const retryCount = episodes.get(key)?.retries ?? 0;
	if (retryCount >= MAX_SYNC_RECOVERY_RETRIES) {
		episodes.set(key, { cooldownUntil: Date.now() + SYNC_RECOVERY_COOLDOWN_MS });
		syncRecoveryEpisodes.set(node, episodes);
		node.safeDispatchEvent(NodeEventName.DRP_SYNC_REJECTED, {
			detail: { id: objectId, peerId: sender, retries: retryCount },
		});
		return;
	}

	episodes.set(key, { retries: retryCount + 1 });
	syncRecoveryEpisodes.set(node, episodes);
	await node.syncObject(objectId, sender);
}

const messageHandlers: Record<MessageType, IHandlerStrategy | undefined> = {
	[MessageType.MESSAGE_TYPE_UNSPECIFIED]: undefined,
	[MessageType.MESSAGE_TYPE_FETCH_STATE]: fetchStateHandler,
	[MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE]: fetchStateResponseHandler,
	[MessageType.MESSAGE_TYPE_UPDATE]: updateHandler,
	[MessageType.MESSAGE_TYPE_SYNC]: syncHandler,
	[MessageType.MESSAGE_TYPE_SYNC_ACCEPT]: syncAcceptHandler,
	[MessageType.MESSAGE_TYPE_SYNC_REJECT]: syncRejectHandler,
	[MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE]: attestationUpdateHandler,
	[MessageType.MESSAGE_TYPE_DRP_DISCOVERY]: drpDiscoveryHandler,
	[MessageType.MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE]: ({ node, message }) =>
		node.handleDiscoveryResponse(message.sender, message),
	[MessageType.MESSAGE_TYPE_CUSTOM]: undefined,
	[MessageType.UNRECOGNIZED]: undefined,
};

/**
 * Handle message and run the handler
 * @param node - The DRP node instance handling the request
 * @param message - The incoming message
 */
export async function handleMessage(node: DRPNode, message: Message): Promise<void> {
	const validation = MessageSchema.safeParse(message);
	if (!validation.success) {
		log.error(`::messageHandler: Invalid message format ${validation.error.message}`);
		return;
	}
	const validatedMessage = validation.data;

	const handler = messageHandlers[validatedMessage.type];
	if (!handler) {
		log.error("::messageHandler: Invalid operation");
		return;
	}
	const result = handler({ node, message: validatedMessage });
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

	const [aclState, drpState] = drpObject.getStates(fetchState.vertexHash);
	const response = FetchStateResponse.create({
		vertexHash: fetchState.vertexHash,
		// Preserve an explicit protobuf miss for pruned/nonexistent snapshots.
		// Serializing undefined would manufacture a present-but-empty state.
		aclState: aclState === undefined ? undefined : serializeDRPState(aclState),
		drpState: drpState === undefined ? undefined : serializeDRPState(drpState),
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

	try {
		const aclState = deserializeDRPState(fetchStateResponse.aclState);
		const drpState = deserializeDRPState(fetchStateResponse.drpState);
		if (fetchStateResponse.vertexHash === HashGraph.rootHash) {
			const state = aclState;
			object.setACLState(fetchStateResponse.vertexHash, state);
			for (const e of state.state) {
				object.acl[e.key] = e.value;
			}
			node.put(object.id, object);
			return;
		}

		if (fetchStateResponse.aclState) {
			object.setACLState(fetchStateResponse.vertexHash, aclState);
		}
		if (fetchStateResponse.drpState) {
			object.setDRPState(fetchStateResponse.vertexHash, drpState);
		}
	} finally {
		node.safeDispatchEvent(NodeEventName.DRP_FETCH_STATE_RESPONSE, {
			detail: {
				id: object.id,
				fetchStateResponse,
			},
		});
	}
}

function attestationUpdateHandler({ node, message }: HandleParams): ReturnType<IHandlerStrategy> {
	const { data, sender } = message;
	const attestationUpdate = AttestationUpdate.decode(data);
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::attestationUpdateHandler: Object not found");
		return;
	}

	if (object.acl.query_isFinalitySigner(sender)) {
		object.finalityStore.addSignatures(sender, attestationUpdate.attestations);
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
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::updateHandler: Object not found");
		return;
	}

	let verifiedVertices: Vertex[] = [];
	if (object.acl.permissionless) {
		verifiedVertices = updateMessage.vertices;
	} else {
		verifiedVertices = verifyACLIncomingVertices(updateMessage.vertices);
	}

	const [, missing] = await object.merge(verifiedVertices);
	const presentHashes = new Set(object.vertices.map((vertex) => vertex.hash));
	const appliedVertices = verifiedVertices.filter((vertex) => presentHashes.has(vertex.hash));

	if (appliedVertices.length !== 0) {
		// add their signatures
		object.finalityStore.addSignatures(sender, updateMessage.attestations);

		// add my signatures
		const attestations = signFinalityVertices(node, object, appliedVertices);

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

	if (missing.length !== 0) {
		await recoverMissingSync(node, message.objectId, sender, missing);
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
async function syncHandler({ node, message }: HandleParams): Promise<void> {
	const { sender, data } = message;
	// (might send reject) <- TODO: when should we reject?
	const syncMessage = Sync.decode(data);
	const object = node.get(message.objectId);
	if (!object) {
		log.error("::syncHandler: Object not found");
		return;
	}

	await signGeneratedVertices(node, object.vertices);

	const requested: Set<Vertex> = new Set(object.vertices);
	const requesting: string[] = [];
	for (const h of syncMessage.vertexHashes) {
		const vertex = object.vertices.find((v) => v.hash === h);
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

	let verifiedVertices: Vertex[] = [];
	if (object.acl.permissionless) {
		verifiedVertices = syncAcceptMessage.requested;
	} else {
		verifiedVertices = verifyACLIncomingVertices(syncAcceptMessage.requested);
	}

	const mergeRan = verifiedVertices.length !== 0;
	let missing: string[] = [];
	if (mergeRan) {
		[, missing] = await object.merge(verifiedVertices);
		object.finalityStore.mergeSignatures(syncAcceptMessage.attestations);
		node.put(object.id, object);
		await recoverMissingSync(node, object.id, sender, missing);
	}

	await signGeneratedVertices(node, object.vertices);
	signFinalityVertices(node, object, object.vertices);

	if (mergeRan && missing.length === 0) {
		node.safeDispatchEvent(NodeEventName.DRP_SYNC_ACCEPTED, {
			detail: { id: object.id },
		});
	}

	// send missing vertices
	const requested: Vertex[] = [];
	for (const h of syncAcceptMessage.requesting) {
		const vertex = object.vertices.find((v) => v.hash === h);
		if (vertex) {
			requested.push(vertex);
		}
	}

	if (requested.length === 0) return;

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
	const attestations = generateAttestations(node, obj, vertices);
	return obj.finalityStore.addSignatures(node.networkNode.peerId, attestations, false);
}

function generateAttestations<T extends IDRP>(node: DRPNode, object: IDRPObject<T>, vertices: Vertex[]): Attestation[] {
	// Two condition:
	// - The node can sign the vertex
	// - The node hasn't signed for the vertex
	const goodVertices = vertices.filter(
		(v) =>
			object.finalityStore.canSign(node.networkNode.peerId, v.hash) &&
			!object.finalityStore.signed(node.networkNode.peerId, v.hash)
	);
	return goodVertices.map((v) =>
		Attestation.create({
			data: v.hash,
			signature: node.keychain.signWithBls(v.hash),
		})
	);
}

function getAttestations<T extends IDRP>(object: IDRPObject<T>, vertices: Vertex[]): AggregatedAttestation[] {
	return (
		vertices
			.map((v) => object.finalityStore.getAttestation(v.hash))
			.filter((a): a is AggregatedAttestation => a !== undefined) ?? []
	);
}

/**
 * Verify incoming vertices.
 * @param incomingVertices - The incoming vertices to verify
 * @returns The verified vertices
 */
export function verifyACLIncomingVertices(incomingVertices: Vertex[]): Vertex[] {
	const verifiedVertices = incomingVertices
		.map((vertex) => {
			if (vertex.signature.length === 0) {
				return null;
			}

			try {
				const hashData = sha256.create().update(vertex.hash).digest();
				const recovery = vertex.signature[0];
				const compactSignature = vertex.signature.slice(1);
				const signatureWithRecovery = Signature.fromCompact(compactSignature).addRecoveryBit(recovery);
				const rawSecp256k1PublicKey = signatureWithRecovery.recoverPublicKey(hashData).toRawBytes(true);
				const secp256k1PublicKey = publicKeyFromRaw(rawSecp256k1PublicKey);
				const expectedPeerId = peerIdFromPublicKey(secp256k1PublicKey).toString();
				const isValid = expectedPeerId === vertex.peerId;
				return isValid ? vertex : null;
			} catch (error) {
				console.error("Error verifying signature:", error);
				return null;
			}
		})
		.filter((vertex: Vertex | null): vertex is Vertex => vertex !== null);

	return verifiedVertices;
}
