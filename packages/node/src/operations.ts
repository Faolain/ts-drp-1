import { HashGraph } from "@ts-drp/object";
import { FetchState, type IDRP, type IDRPObject, Message, MessageType, Sync } from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";
import { prepareSyncSend, recordAdvertisedHeads, sharedHashes, type SyncSendPurpose } from "./sync-state.js";

/**
 * Fetches the state of an object.
 * @param node - The node.
 * @param objectId - The object ID.
 * @param peerId - The peer ID.
 */
export async function fetchState(node: DRPNode, objectId: string, peerId?: string): Promise<void> {
	const data = FetchState.create({
		vertexHash: HashGraph.rootHash,
	});
	const message = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_FETCH_STATE,
		data: FetchState.encode(data).finish(),
		objectId: objectId,
	});

	if (!peerId) {
		await node.networkNode.sendGroupMessageRandomPeer(objectId, message);
	} else {
		await node.networkNode.sendMessage(peerId, message);
	}
}

/**
 * Syncs an object.
 * @param node - The node.
 * @param objectId - The object ID.
 * @param peerId - The peer ID.
 */
export async function syncObject(node: DRPNode, objectId: string, peerId?: string): Promise<void> {
	await sendSyncObject(node, objectId, peerId, "scheduled-probe");
}

/**
 * Sends an object sync for an explicit internal lifecycle purpose.
 * @param node - The node.
 * @param objectId - The object ID.
 * @param peerId - The peer ID.
 * @param purpose - Lifecycle role of the outbound send.
 * @returns A promise that resolves after the send is handled.
 */
export function sendSyncObject(
	node: DRPNode,
	objectId: string,
	peerId: string | undefined,
	purpose: "scheduled-probe"
): Promise<void>;
export function sendSyncObject(
	node: DRPNode,
	objectId: string,
	peerId: string,
	purpose: "inbound-reciprocity"
): Promise<void>;
export async function sendSyncObject<T extends IDRP>(
	node: DRPNode,
	objectId: string,
	peerId: string | undefined,
	purpose: SyncSendPurpose
): Promise<void> {
	const object: IDRPObject<T> | undefined = node.get(objectId);
	if (!object) {
		log.error("::syncObject: Object not found");
		return;
	}
	const probe = peerId === undefined ? undefined : prepareSyncSend(node, objectId, peerId, purpose);
	if (probe?.send === false) return;
	const heads = peerId === undefined ? [] : object.getHistoryHeads();
	const data =
		peerId === undefined
			? Sync.create({ vertexHashes: [...object.historyInventory.knownHashes] })
			: Sync.create({
					heads,
					requestedHashes: probe?.requestedHashes ?? [],
					sharedHeads: sharedHashes(node, objectId, peerId),
					vertexHashes: [],
				});
	const message = Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC,
		data: Sync.encode(data).finish(),
		objectId: objectId,
	});

	if (!peerId) {
		await node.networkNode.sendGroupMessageRandomPeer(objectId, message);
	} else {
		recordAdvertisedHeads(node, objectId, peerId, heads);
		await node.networkNode.sendMessage(peerId, message);
	}
}
