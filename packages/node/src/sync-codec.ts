import {
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	type DRPSyncProtocol,
	SYNC_RESPONSE_BYTE_CAP,
	SYNC_RESPONSE_CHUNK_CAP,
	SYNC_RESPONSE_VERTEX_CAP,
	SyncTransportError,
	validateNegotiatedSync,
} from "@ts-drp/network";
import { HashGraph } from "@ts-drp/object";
import {
	type HistoryReadResult,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	Sync,
	SyncAccept,
	type Vertex,
} from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import {
	prepareSyncSend,
	previewSyncSend,
	recordAdvertisedHeads,
	sharedHashes,
	type SyncSendPurpose,
} from "./sync-state.js";
import { getAttestations, signGeneratedVertices } from "./vertex-egress.js";

export interface SyncPayloadBuildInput {
	readonly objectId: string;
	readonly peerId: string;
	readonly protocol: DRPSyncProtocol;
	readonly purpose: SyncSendPurpose;
}

export interface SyncResponseBuildInput {
	readonly objectId: string;
	readonly peerId: string;
	readonly request: Message;
}

function objectOrThrow<T extends IDRP>(node: DRPNode, objectId: string): IDRPObject<T> {
	const object = node.get<T>(objectId);
	if (object === undefined) throw new SyncTransportError("SYNC_OBJECT_NOT_FOUND", "Sync object not found");
	return object;
}

/** Build and account exactly the payload selected by one negotiated stream. */
export function buildSyncPayloadForProtocol(node: DRPNode, input: SyncPayloadBuildInput): Message {
	const object = objectOrThrow(node, input.objectId);
	const preview = previewSyncSend(node, input.objectId, input.peerId, input.purpose);
	if (!preview.send) {
		prepareSyncSend(node, input.objectId, input.peerId, input.purpose);
		throw new SyncTransportError("SYNC_SEND_SUPPRESSED", "Sync lifecycle suppressed this send");
	}

	const heads = input.protocol === DRP_HEADS_CHUNK_PROTOCOL ? object.getHistoryHeads() : [];
	const sync =
		input.protocol === DRP_MESSAGE_PROTOCOL
			? Sync.create({ vertexHashes: [...object.historyInventory.knownHashes] })
			: Sync.create({
					heads,
					requestedHashes: preview.requestedHashes,
					sharedHeads: sharedHashes(node, input.objectId, input.peerId),
					vertexHashes: [],
				});
	const message = Message.create({
		data: Sync.encode(sync).finish(),
		objectId: input.objectId,
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});

	// Validation precedes the only mutating lifecycle/accounting operations.
	validateNegotiatedSync(message, input.protocol, Message.encode(message).finish().byteLength);
	const committed = prepareSyncSend(node, input.objectId, input.peerId, input.purpose);
	if (!committed.send) throw new SyncTransportError("SYNC_SEND_SUPPRESSED", "Sync lifecycle suppressed this send");
	if (
		committed.requestedHashes.length !== preview.requestedHashes.length ||
		committed.requestedHashes.some((hash, index) => hash !== preview.requestedHashes[index])
	) {
		throw new SyncTransportError("SYNC_STATE_CHANGED", "Sync lifecycle changed during payload construction");
	}
	if (input.protocol === DRP_HEADS_CHUNK_PROTOCOL) {
		recordAdvertisedHeads(node, input.objectId, input.peerId, heads);
	}
	return message;
}

/**
 * Read a speculative frontier delta only when verified wire boundaries enclose
 * the complete suffix. A sibling head is a valid stop if reached, but is not
 * evidence that another local branch shares its ancestry. In that case the
 * caller advertises the frontier and lets exact recovery discover the branch.
 */
export function readUsefulSyncDelta<T extends IDRP>(
	object: IDRPObject<T>,
	localHeads: readonly string[],
	knownRemoteHeads: readonly string[],
	verifiedSharedHeads: readonly string[],
	requestedHashes: readonly string[],
	allRemoteHeadsKnown: boolean
): HistoryReadResult {
	if (requestedHashes.length !== 0 || !allRemoteHeadsKnown) {
		return { status: "available", vertices: [] };
	}
	const verifiedBoundaries = new Set([...knownRemoteHeads, ...verifiedSharedHeads]);
	const walked = object.readHistorySuffix(localHeads, new Set([...verifiedBoundaries, HashGraph.rootHash]));
	if (walked.status !== "available") return walked;
	const selectedHashes = new Set(walked.vertices.map(({ hash }) => hash));
	const fullyBounded = walked.vertices.every(({ dependencies }) =>
		dependencies.every((hash) => selectedHashes.has(hash) || verifiedBoundaries.has(hash))
	);
	return fullyBounded ? walked : { status: "available", vertices: [] };
}

function selectedResponseVertices<T extends IDRP>(object: IDRPObject<T>, request: Sync): Vertex[] {
	if (request.vertexHashes.length !== 0) {
		const remote = new Set(request.vertexHashes);
		return object.vertices.filter(({ hash }) => !remote.has(hash));
	}
	const knownHeads = request.heads.filter((hash) => object.getVertex(hash) !== undefined);
	const verifiedCuts = request.sharedHeads.filter((hash) => object.getVertex(hash) !== undefined);
	const delta = readUsefulSyncDelta(
		object,
		object.getHistoryHeads(),
		knownHeads,
		verifiedCuts,
		request.requestedHashes,
		knownHeads.length === request.heads.length
	);
	if (delta.status === "history-unavailable") {
		throw new SyncTransportError("SYNC_HISTORY_UNAVAILABLE", "Requested sync history is unavailable");
	}
	const exact = object.readHistory(request.requestedHashes);
	if (exact.status === "history-unavailable") {
		throw new SyncTransportError("SYNC_HISTORY_UNAVAILABLE", "Requested exact sync history is unavailable");
	}
	const selected = new Map<string, Vertex>();
	for (const vertex of delta.status === "available" ? delta.vertices : []) selected.set(vertex.hash, vertex);
	for (const vertex of exact.status === "available" ? exact.vertices : []) selected.set(vertex.hash, vertex);
	return [...selected.values()];
}

function responseMessage(
	node: DRPNode,
	object: IDRPObject<IDRP>,
	vertices: Vertex[],
	requesting: readonly string[] = []
): Message {
	return Message.create({
		data: SyncAccept.encode(
			SyncAccept.create({
				attestations: getAttestations(object, vertices),
				requested: vertices,
				requesting: [...requesting],
			})
		).finish(),
		objectId: object.id,
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
	});
}

/** Build independent deterministic response chunks without continuation state. */
export async function buildSyncResponseChunks(
	node: DRPNode,
	input: SyncResponseBuildInput
): Promise<readonly Message[]> {
	const object = objectOrThrow(node, input.objectId);
	const request = Sync.decode(input.request.data);
	const selected = selectedResponseVertices(object, request).slice(
		0,
		SYNC_RESPONSE_VERTEX_CAP * SYNC_RESPONSE_CHUNK_CAP
	);
	return buildSyncResponseChunksForVertices(node, object, selected);
}

/** Encode one already-selected topological prefix through the canonical chunk policy. */
export async function buildSyncResponseChunksForVertices(
	node: DRPNode,
	object: IDRPObject<IDRP>,
	selected: Vertex[],
	requesting: readonly string[] = []
): Promise<readonly Message[]> {
	selected = selected.slice(0, SYNC_RESPONSE_VERTEX_CAP * SYNC_RESPONSE_CHUNK_CAP);
	await signGeneratedVertices(node, selected);

	const chunks: Message[] = [];
	let current: Vertex[] = [];
	for (const vertex of selected) {
		const firstRequesting = chunks.length === 0 ? requesting : [];
		const single = responseMessage(node, object, [vertex], firstRequesting);
		if (Message.encode(single).finish().byteLength > SYNC_RESPONSE_BYTE_CAP) {
			throw new SyncTransportError("SYNC_RESPONSE_VERTEX_LIMIT", "One sync response vertex exceeds the byte ceiling");
		}
		const candidate = [...current, vertex];
		const encoded = responseMessage(node, object, candidate, firstRequesting);
		if (
			candidate.length > SYNC_RESPONSE_VERTEX_CAP ||
			Message.encode(encoded).finish().byteLength > SYNC_RESPONSE_BYTE_CAP
		) {
			chunks.push(responseMessage(node, object, current, firstRequesting));
			current = [vertex];
		} else {
			current = candidate;
		}
	}
	if (current.length !== 0) {
		chunks.push(responseMessage(node, object, current, chunks.length === 0 ? requesting : []));
	}
	if (chunks.length === 0 && requesting.length !== 0) {
		const requestingOnly = responseMessage(node, object, [], requesting);
		if (Message.encode(requestingOnly).finish().byteLength > SYNC_RESPONSE_BYTE_CAP) {
			throw new SyncTransportError("SYNC_RESPONSE_LIMIT", "Sync response exceeds the byte ceiling");
		}
		chunks.push(requestingOnly);
	}
	return chunks.slice(0, SYNC_RESPONSE_CHUNK_CAP);
}
