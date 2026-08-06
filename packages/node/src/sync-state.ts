import { SYNC_HEADS_FIELD_HASH_CAP, SYNC_OUTSTANDING_EXACT_CAP } from "@ts-drp/network";
import { NodeEventName } from "@ts-drp/types";

import { type DRPNode } from "./index.js";

const MAX_EXACT_REQUEST_ATTEMPTS = 3;
export const SYNC_RECOVERY_COOLDOWN_MS = 30_000;

interface PeerSyncState {
	advertisedHeads: Set<string>;
	branchCuts: Set<string>;
	exactRequestAttempts: number;
	exactRequestCooldownUntil?: number;
	sharedHeads: Set<string>;
	outstandingRequests: Set<string>;
}

const states = new WeakMap<DRPNode, Map<string, PeerSyncState>>();

function stateKey(objectId: string, peerId: string): string {
	return JSON.stringify([objectId, peerId]);
}

function getState(node: DRPNode, objectId: string, peerId: string): PeerSyncState {
	let nodeStates = states.get(node);
	if (nodeStates === undefined) {
		nodeStates = new Map();
		states.set(node, nodeStates);
	}
	const key = stateKey(objectId, peerId);
	let state = nodeStates.get(key);
	if (state === undefined) {
		state = {
			advertisedHeads: new Set(),
			branchCuts: new Set(),
			exactRequestAttempts: 0,
			sharedHeads: new Set(),
			outstandingRequests: new Set(),
		};
		nodeStates.set(key, state);
	}
	return state;
}

/**
 * Test whether an inbound frontier exactly matches the last advertised heads.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param heads - Inbound frontier
 * @returns Whether the frontiers match exactly
 */
export function advertisedTheseHeads(
	node: DRPNode,
	objectId: string,
	peerId: string,
	heads: readonly string[]
): boolean {
	const advertised = getState(node, objectId, peerId).advertisedHeads;
	return advertised.size === heads.length && heads.every((hash) => advertised.has(hash));
}

/**
 * Remember the last heads sent to one peer.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param heads - Advertised local frontier
 */
export function recordAdvertisedHeads(node: DRPNode, objectId: string, peerId: string, heads: readonly string[]): void {
	const state = getState(node, objectId, peerId);
	state.advertisedHeads = new Set(heads);
}

/**
 * Replace the peer's verified shared frontier.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param hashes - Verified shared hashes
 */
export function recordSharedHeads(node: DRPNode, objectId: string, peerId: string, hashes: readonly string[]): void {
	getState(node, objectId, peerId).sharedHeads = new Set(hashes);
}

/**
 * Retain shared branch cuts that remain useful after the frontier advances.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param hashes - Verified branch cuts
 */
export function recordBranchCuts(node: DRPNode, objectId: string, peerId: string, hashes: readonly string[]): void {
	const cuts = getState(node, objectId, peerId).branchCuts;
	for (const hash of hashes) cuts.add(hash);
}

/**
 * Read every verified shared cut for one peer.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @returns Deduplicated shared hashes
 */
export function sharedHashes(node: DRPNode, objectId: string, peerId: string): string[] {
	const state = getState(node, objectId, peerId);
	return [...new Set([...state.branchCuts, ...state.sharedHeads])];
}

/**
 * Add newly authenticated missing hashes to the exact request lifecycle.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param hashes - Exact truly missing hashes
 * @returns Whether the exact outstanding set changed
 */
export function queueExactRequests(
	node: DRPNode,
	objectId: string,
	peerId: string,
	hashes: readonly string[]
): boolean {
	const state = getState(node, objectId, peerId);
	let queued = false;
	for (const hash of hashes) {
		if (state.outstandingRequests.size >= SYNC_OUTSTANDING_EXACT_CAP) break;
		if (state.outstandingRequests.has(hash)) continue;
		state.outstandingRequests.add(hash);
		queued = true;
	}
	if (queued) {
		// A changed exact set is a new lifecycle. Identical reoffers never reach
		// this branch and therefore cannot reset attempts or cooldown.
		state.exactRequestAttempts = 0;
		state.exactRequestCooldownUntil = undefined;
	}
	return queued;
}

export type SyncSendPurpose = "inbound-reciprocity" | "scheduled-probe";

export interface PreparedSyncSend {
	requestedHashes: string[];
	send: boolean;
}

/**
 * Read the next deterministic exact-request chunk without charging the
 * existing retry lifecycle. Selected-mode builders use this to validate the
 * actual protobuf before committing one attempt.
 */
export function previewSyncSend(
	node: DRPNode,
	objectId: string,
	peerId: string,
	purpose: SyncSendPurpose
): PreparedSyncSend {
	const state = getState(node, objectId, peerId);
	if (purpose === "inbound-reciprocity") {
		const cooldownActive =
			state.exactRequestCooldownUntil !== undefined && Date.now() < state.exactRequestCooldownUntil;
		return { requestedHashes: [], send: !cooldownActive };
	}
	if (state.outstandingRequests.size === 0) return { requestedHashes: [], send: true };
	const cooldownExpired =
		state.exactRequestCooldownUntil !== undefined && Date.now() >= state.exactRequestCooldownUntil;
	if (state.exactRequestCooldownUntil !== undefined && !cooldownExpired) {
		return { requestedHashes: [], send: false };
	}
	const attempts = cooldownExpired ? 0 : state.exactRequestAttempts;
	if (attempts >= MAX_EXACT_REQUEST_ATTEMPTS) {
		return { requestedHashes: [], send: false };
	}
	const hashes = [...state.outstandingRequests];
	const chunkCount = Math.ceil(hashes.length / SYNC_HEADS_FIELD_HASH_CAP);
	const chunk = attempts % chunkCount;
	return {
		requestedHashes: hashes.slice(chunk * SYNC_HEADS_FIELD_HASH_CAP, (chunk + 1) * SYNC_HEADS_FIELD_HASH_CAP),
		send: true,
	};
}

/**
 * Prepare one outbound sync send. Scheduled probes carry outstanding exact
 * hashes on attempts one through three; the fourth rejects once and starts the
 * cooldown without putting an empty probe on the wire. Inbound reciprocity is
 * read-only with respect to that lifecycle and is suppressed during cooldown.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer selected for this probe
 * @param purpose - Lifecycle role of the outbound send
 * @returns Whether to send and which exact hashes to carry
 */
export function prepareSyncSend(
	node: DRPNode,
	objectId: string,
	peerId: string,
	purpose: SyncSendPurpose
): PreparedSyncSend {
	const state = getState(node, objectId, peerId);
	if (purpose === "inbound-reciprocity") {
		const cooldownActive =
			state.exactRequestCooldownUntil !== undefined && Date.now() < state.exactRequestCooldownUntil;
		return { requestedHashes: [], send: !cooldownActive };
	}
	if (state.outstandingRequests.size === 0) return { requestedHashes: [], send: true };

	if (state.exactRequestCooldownUntil !== undefined) {
		if (Date.now() < state.exactRequestCooldownUntil) return { requestedHashes: [], send: false };
		state.exactRequestCooldownUntil = undefined;
		state.exactRequestAttempts = 0;
	}

	if (state.exactRequestAttempts >= MAX_EXACT_REQUEST_ATTEMPTS) {
		state.exactRequestCooldownUntil = Date.now() + SYNC_RECOVERY_COOLDOWN_MS;
		node.safeDispatchEvent(NodeEventName.DRP_SYNC_REJECTED, {
			detail: { id: objectId, peerId, retries: MAX_EXACT_REQUEST_ATTEMPTS },
		});
		return { requestedHashes: [], send: false };
	}

	const prepared = previewSyncSend(node, objectId, peerId, purpose);
	state.exactRequestAttempts += 1;
	return prepared;
}

/**
 * Remove exact requests satisfied by authenticated arrival or local presence.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param hasHash - Truthful exact-presence predicate
 */
export function completePresentExactRequests(
	node: DRPNode,
	objectId: string,
	peerId: string,
	hasHash: (hash: string) => boolean
): void {
	const state = getState(node, objectId, peerId);
	let completed = false;
	for (const hash of state.outstandingRequests) {
		if (!hasHash(hash)) continue;
		state.outstandingRequests.delete(hash);
		completed = true;
	}
	if (completed) {
		state.exactRequestAttempts = 0;
		state.exactRequestCooldownUntil = undefined;
	}
}

/**
 * Clear every peer lifecycle for one unsubscribed object.
 * @param node - Node owning the sync state
 * @param objectId - Unsubscribed object
 */
export function clearObjectSyncState(node: DRPNode, objectId: string): void {
	const nodeStates = states.get(node);
	if (nodeStates === undefined) return;
	for (const key of nodeStates.keys()) {
		const [candidateObjectId] = JSON.parse(key) as [string, string];
		if (candidateObjectId === objectId) nodeStates.delete(key);
	}
	if (nodeStates.size === 0) states.delete(node);
}

/**
 * Clear all sync state owned by a stopped node.
 * @param node - Stopped node
 */
export function clearNodeSyncState(node: DRPNode): void {
	states.delete(node);
}
