import { SYNC_HEADS_FIELD_HASH_CAP, SYNC_OUTSTANDING_EXACT_CAP } from "@ts-drp/network";
import { NodeEventName } from "@ts-drp/types";

import { type DRPNode } from "./index.js";

const MAX_EXACT_REQUEST_ATTEMPTS = 3;
const MAX_RETAINED_BRANCH_CUTS = 32;
export const SYNC_RECOVERY_COOLDOWN_MS = 30_000;

interface PeerSyncState {
	advertisedHeads: Set<string>;
	branchCuts: Set<string>;
	exactRequestAttempts: number;
	exactRequestCooldownUntil?: number;
	sharedHeads: Set<string>;
	outstandingRequests: Set<string>;
}

interface SyncStateCapacity {
	readonly perNode: number;
	readonly perObject: number;
}

interface PeerSyncEntry {
	admissionSequence: number;
	readonly key: string;
	readonly objectId: string;
	readonly state: PeerSyncState;
}

interface NodeSyncLedger {
	readonly capacity: SyncStateCapacity;
	nextAdmissionSequence: number;
	readonly objectCounts: Map<string, number>;
	readonly states: Map<string, PeerSyncEntry>;
}

const PROFILE_HEAP_BYTES = 150_000_000;
const SYNC_HEAP_FRACTION = 0.1;
const SYNC_HEAP_RESERVE = 0.2;
const CROSS_ENGINE_MULTIPLIER = 1.5;
const PINNED_PAIR_P95_BYTES = 10_420.16875;
const FIXED_LEDGER_BYTES = 127_739;
const SINGLE_OBJECT_DIVISOR = 20;
const CHURN_ADJUSTED_OBJECT_DEMAND = 28;

const ledgers = new WeakMap<DRPNode, NodeSyncLedger>();

/**
 * Derive the accepted finite compatibility capacity without ambient input.
 * @returns Finite per-object and per-node pair limits
 */
export function deriveDefaultSyncStateCapacity(): SyncStateCapacity {
	const pinnedPairBytes = Math.ceil(PINNED_PAIR_P95_BYTES * CROSS_ENGINE_MULTIPLIER);
	const usableBytes =
		Math.floor(PROFILE_HEAP_BYTES * SYNC_HEAP_FRACTION * (1 - SYNC_HEAP_RESERVE)) - FIXED_LEDGER_BYTES;
	const perNode = Math.floor(usableBytes / pinnedPairBytes);
	return {
		perNode,
		perObject: Math.min(perNode, Math.max(CHURN_ADJUSTED_OBJECT_DEMAND, Math.floor(perNode / SINGLE_OBJECT_DIVISOR))),
	};
}

function assertCapacity(capacity: SyncStateCapacity): void {
	if (
		!Number.isSafeInteger(capacity.perNode) ||
		!Number.isSafeInteger(capacity.perObject) ||
		capacity.perNode < 1 ||
		capacity.perObject < 1 ||
		capacity.perObject > capacity.perNode
	) {
		throw new RangeError("Sync-state capacity must contain positive safe integers with perObject <= perNode");
	}
}

function createLedger(capacity: SyncStateCapacity): NodeSyncLedger {
	assertCapacity(capacity);
	return {
		capacity: Object.freeze({ ...capacity }),
		nextAdmissionSequence: 0,
		objectCounts: new Map(),
		states: new Map(),
	};
}

/**
 * Install a finite test capacity before this node first allocates sync state.
 * @param node - Node whose capacity is resolved
 * @param capacity - Positive finite pair limits
 * @internal
 */
export function installSyncStateCapacity(node: DRPNode, capacity: SyncStateCapacity): void {
	if (ledgers.has(node)) throw new Error("Sync-state capacity is already resolved for this node");
	ledgers.set(node, createLedger(capacity));
}

function stateKey(objectId: string, peerId: string): string {
	return JSON.stringify([objectId, peerId]);
}

function findState(node: DRPNode, objectId: string, peerId: string): PeerSyncState | undefined {
	return ledgers.get(node)?.states.get(stateKey(objectId, peerId))?.state;
}

/**
 * Test whether a pair's independent retry lifecycle is terminal.
 * @param outstandingCount - Number of retained exact requests
 * @param attemptCount - Number of charged attempts
 * @param cooldownUntil - Defined cooldown boundary, including an expired one
 * @returns Whether the pair can be evicted
 */
export function isDormantSyncLifecycle(
	outstandingCount: number,
	attemptCount: number,
	cooldownUntil?: number
): boolean {
	return outstandingCount === 0 && attemptCount === 0 && cooldownUntil === undefined;
}

function isDormant(entry: PeerSyncEntry): boolean {
	const state = entry.state;
	return isDormantSyncLifecycle(
		state.outstandingRequests.size,
		state.exactRequestAttempts,
		state.exactRequestCooldownUntil
	);
}

function oldestDormantEntry(ledger: NodeSyncLedger, objectId?: string): PeerSyncEntry | undefined {
	let oldest: PeerSyncEntry | undefined;
	for (const entry of ledger.states.values()) {
		if (objectId !== undefined && entry.objectId !== objectId) continue;
		if (!isDormant(entry)) continue;
		if (oldest === undefined || entry.admissionSequence < oldest.admissionSequence) oldest = entry;
	}
	return oldest;
}

function removeEntry(ledger: NodeSyncLedger, entry: PeerSyncEntry): void {
	ledger.states.delete(entry.key);
	const remaining = (ledger.objectCounts.get(entry.objectId) ?? 1) - 1;
	if (remaining === 0) ledger.objectCounts.delete(entry.objectId);
	else ledger.objectCounts.set(entry.objectId, remaining);
}

function newPeerSyncState(): PeerSyncState {
	return {
		advertisedHeads: new Set(),
		branchCuts: new Set(),
		exactRequestAttempts: 0,
		sharedHeads: new Set(),
		outstandingRequests: new Set(),
	};
}

function takeAdmissionSequence(ledger: NodeSyncLedger): number {
	if (ledger.nextAdmissionSequence === Number.MAX_SAFE_INTEGER) {
		const entriesByAge = [...ledger.states.values()].sort(
			(left, right) => left.admissionSequence - right.admissionSequence
		);
		let rebasedSequence = 0;
		for (const entry of entriesByAge) {
			entry.admissionSequence = rebasedSequence;
			rebasedSequence += 1;
		}
		ledger.nextAdmissionSequence = rebasedSequence;
	}
	const sequence = ledger.nextAdmissionSequence;
	ledger.nextAdmissionSequence += 1;
	return sequence;
}

function getState(node: DRPNode, objectId: string, peerId: string): PeerSyncState | undefined {
	let ledger = ledgers.get(node);
	if (ledger === undefined) {
		ledger = createLedger(deriveDefaultSyncStateCapacity());
		ledgers.set(node, ledger);
	}
	const key = stateKey(objectId, peerId);
	const existing = ledger.states.get(key);
	if (existing !== undefined) return existing.state;

	const objectIsFull = (ledger.objectCounts.get(objectId) ?? 0) >= ledger.capacity.perObject;
	const nodeIsFull = ledger.states.size >= ledger.capacity.perNode;
	const victim = objectIsFull
		? oldestDormantEntry(ledger, objectId)
		: nodeIsFull
			? oldestDormantEntry(ledger)
			: undefined;
	if ((objectIsFull || nodeIsFull) && victim === undefined) return undefined;

	const state = newPeerSyncState();
	const entry: PeerSyncEntry = {
		admissionSequence: takeAdmissionSequence(ledger),
		key,
		objectId,
		state,
	};
	if (victim !== undefined) removeEntry(ledger, victim);
	ledger.states.set(key, entry);
	ledger.objectCounts.set(objectId, (ledger.objectCounts.get(objectId) ?? 0) + 1);
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
	const advertised = findState(node, objectId, peerId)?.advertisedHeads;
	if (advertised === undefined) return heads.length === 0;
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
	if (state === undefined) return;
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
	const state = getState(node, objectId, peerId);
	if (state === undefined) return;
	state.sharedHeads = new Set(hashes);
}

/**
 * Retain shared branch cuts that remain useful after the frontier advances.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @param hashes - Verified branch cuts
 */
export function recordBranchCuts(node: DRPNode, objectId: string, peerId: string, hashes: readonly string[]): void {
	if (hashes.length === 0) return;
	const state = getState(node, objectId, peerId);
	if (state === undefined) return;
	const cuts = state.branchCuts;
	for (const hash of hashes) {
		if (cuts.has(hash)) continue;
		if (cuts.size === MAX_RETAINED_BRANCH_CUTS) {
			const oldest = cuts.values().next().value;
			if (oldest !== undefined) cuts.delete(oldest);
		}
		cuts.add(hash);
	}
}

/**
 * Select the verified shared cuts advertised to one peer.
 *
 * The replaceable current frontier is more useful than retained historical
 * cuts, so it consumes the bounded wire entitlement first. Retention remains
 * independent from this egress projection.
 * @param node - Node owning the sync state
 * @param objectId - Object being synchronized
 * @param peerId - Remote peer
 * @returns Deduplicated shared hashes within the heads-field cap
 */
export function sharedHashes(node: DRPNode, objectId: string, peerId: string): string[] {
	const state = findState(node, objectId, peerId);
	if (state === undefined) return [];
	const selected = new Set<string>();
	for (const hashes of [state.sharedHeads, state.branchCuts]) {
		for (const hash of hashes) {
			selected.add(hash);
			if (selected.size === SYNC_HEADS_FIELD_HASH_CAP) return [...selected];
		}
	}
	return [...selected];
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
	if (state === undefined) return false;
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
	const state = findState(node, objectId, peerId);
	if (state === undefined) return { requestedHashes: [], send: true };
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
	if (state === undefined) return { requestedHashes: [], send: false };
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
	const state = findState(node, objectId, peerId);
	if (state === undefined) return;
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
	const ledger = ledgers.get(node);
	if (ledger === undefined) return;
	for (const entry of [...ledger.states.values()]) {
		if (entry.objectId === objectId) removeEntry(ledger, entry);
	}
}

/**
 * Clear all sync state owned by a stopped node.
 * @param node - Stopped node
 */
export function clearNodeSyncState(node: DRPNode): void {
	ledgers.delete(node);
}
