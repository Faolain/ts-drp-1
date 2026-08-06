import { SyncTransportError } from "@ts-drp/network";
import { HashGraph } from "@ts-drp/object";
import { FetchState, type IDRP, type IDRPObject, Message, MessageType, Sync } from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";
import { type SyncSendPurpose } from "./sync-state.js";

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
	if (!peerId) {
		const message = Message.create({
			data: Sync.encode(Sync.create({ vertexHashes: [...object.historyInventory.knownHashes] })).finish(),
			objectId,
			sender: node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC,
		});
		await node.networkNode.sendGroupMessageRandomPeer(objectId, message);
	} else {
		try {
			await node.sendNegotiatedSync(peerId, (selection) =>
				node.buildSyncPayloadForProtocol({
					objectId,
					peerId,
					protocol: selection.protocol,
					purpose,
				})
			);
		} catch (error) {
			if (error instanceof SyncTransportError && error.code === "SYNC_SEND_SUPPRESSED") return;
			throw error;
		}
	}
}
