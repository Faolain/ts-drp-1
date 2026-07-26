import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import { type DrpRuntimeContext, DRPState, DRPStateEntry, type Hash, type IACL, type IDRP } from "@ts-drp/types";
import { cloneDeep } from "es-toolkit";

import { HashGraph } from "./hashgraph/index.js";

const metrics = new OpentelemetryMetrics("@ts-drp/object/states");

/**
 * Replica-local blueprint fields excluded from consensus-visible snapshot
 * bytes. Adding another replica-local field to a blueprint requires adding it
 * here, or that field becomes part of the replicated state contract.
 */
export const REPLICA_LOCAL_STATE_KEYS: ReadonlySet<string> = new Set(["context"]);

export interface PrunedStateSnapshots {
	drp: [Hash, DRPState][];
	acl: [Hash, DRPState][];
}

/**
 * A custom error class for when a state is not found
 */
export class StateNotFoundError extends Error {
	/**
	 * @param message - The message of the error
	 */
	constructor(message: string = "DRPState not found") {
		super(message);
		this.name = "DRPStateNotFoundError";
	}
}

/**
 * This class is used to manage the state of a DRPObject.
 *
 * It contains all the states attached to the corresponding LCA
 * With the state this allow use to construct back the object in the same state it was with the given LCA
 */
export class DRPObjectStateManager<T extends IDRP> {
	private drpStates: Map<Hash, DRPState>;
	private aclStates: Map<Hash, DRPState>;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private drpConstructor?: { prototype: any };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private aclConstructor: { prototype: any };
	private drpContext?: DrpRuntimeContext;
	private aclContext?: DrpRuntimeContext;

	/**
	 * @param acl - The ACL of the DRPObject
	 * @param drp - The DRP of the DRPObject
	 */
	constructor(acl: IACL, drp?: T) {
		this.drpStates = new Map();
		this.aclStates = new Map();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.drpConstructor = drp?.constructor as { prototype: any };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.aclConstructor = acl.constructor as { prototype: any };
		this.drpContext = cloneDeep(drp?.context);
		this.aclContext = cloneDeep(acl.context);

		this.drpStates.set(HashGraph.rootHash, drp ? stateFromDRP(drp) : DRPState.create());
		this.aclStates.set(HashGraph.rootHash, stateFromDRP(acl));
	}

	/**
	 * Get the DRP state for a given hash
	 * @param hash - The hash of the state to get
	 * @returns The DRP state for the given hash
	 */
	getDRPState(hash: Hash): DRPState | undefined {
		return this.drpStates.get(hash);
	}

	/**
	 * Set the DRP state for a given hash
	 * @param hash - The hash of the state to set
	 * @param state - The DRP state to set
	 */
	setDRPState(hash: Hash, state: DRPState): void {
		this.drpStates.set(hash, state);
	}

	/**
	 * Delete a DRP snapshot only when it is still the supplied instance.
	 * @param hash - The snapshot hash
	 * @param expected - The snapshot instance installed by the caller
	 * @returns Whether the expected snapshot was deleted
	 */
	deleteDRPState(hash: Hash, expected: DRPState): boolean {
		if (this.drpStates.get(hash) !== expected) return false;
		return this.drpStates.delete(hash);
	}

	/**
	 * Get the ACL state for a given hash
	 * @param hash - The hash of the state to get
	 * @returns The ACL state for the given hash
	 */
	getACLState(hash: Hash): DRPState | undefined {
		return this.aclStates.get(hash);
	}

	/**
	 * Set the ACL state for a given hash
	 * @param hash - The hash of the state to set
	 * @param state - The ACL state to set
	 */
	setACLState(hash: Hash, state: DRPState): void {
		this.aclStates.set(hash, state);
	}

	/**
	 * Delete an ACL snapshot only when it is still the supplied instance.
	 * @param hash - The snapshot hash
	 * @param expected - The snapshot instance installed by the caller
	 * @returns Whether the expected snapshot was deleted
	 */
	deleteACLState(hash: Hash, expected: DRPState): boolean {
		if (this.aclStates.get(hash) !== expected) return false;
		return this.aclStates.delete(hash);
	}

	/**
	 * Get the DRP and ACL for a given hash
	 * @param hash - The hash of the state to get
	 * @param replayDepth - Number of operations replayed for tracing
	 * @param drpContext - Replica-local DRP runtime context
	 * @param aclContext - Replica-local ACL runtime context
	 * @returns The DRP and ACL for the given hash
	 */
	fromHash(
		hash: Hash,
		replayDepth = 0,
		drpContext = this.drpContext,
		aclContext = this.aclContext
	): [T | undefined, IACL] {
		if (!isTracingEnabled()) return this.fromHashUntraced(hash, drpContext, aclContext);

		return metrics.traceFunc(
			"states.fromHash",
			(candidateHash: Hash) => this.fromHashUntraced(candidateHash, drpContext, aclContext),
			(span) => {
				span.setAttribute("drp.replay.depth", replayDepth);
			}
		)(hash);
	}

	private fromHashUntraced(
		hash: Hash,
		drpContext?: DrpRuntimeContext,
		aclContext?: DrpRuntimeContext
	): [T | undefined, IACL] {
		if (!this.aclConstructor) {
			throw new Error("ACL constructor not set");
		}

		const drpState = this.drpStates.get(hash);
		const aclState = this.aclStates.get(hash);
		if (!drpState || !aclState) {
			throw new StateNotFoundError(`State ${hash} not found`);
		}

		return this.fromStates(drpState, aclState, drpContext, aclContext);
	}

	/**
	 * Reconstruct an object pair from explicit snapshots. Checkpoints use this
	 * because a merged frontier state does not necessarily belong to one hash.
	 * @param drpState - DRP snapshot at the causal cut
	 * @param aclState - ACL snapshot at the causal cut
	 * @param drpContext - Replica-local DRP runtime context
	 * @param aclContext - Replica-local ACL runtime context
	 * @returns Reconstructed DRP and ACL instances
	 */
	fromStates(
		drpState: DRPState,
		aclState: DRPState,
		drpContext = this.drpContext,
		aclContext = this.aclContext
	): [T | undefined, IACL] {
		const acl = Object.create(this.aclConstructor.prototype);
		if (aclContext) acl.context = cloneDeep(aclContext);
		this.applyState(acl, aclState);

		if (this.drpConstructor) {
			const drp = Object.create(this.drpConstructor.prototype);
			if (drpContext) drp.context = cloneDeep(drpContext);
			this.applyState(drp, drpState);
			return [drp, acl];
		}

		return [undefined, acl];
	}

	/**
	 * Retain only snapshots that can still seed incremental replay or are in the
	 * current replay suffix.
	 * @param hashes - Snapshot hashes to retain
	 * @returns Exact snapshot instances removed by this pruning pass
	 */
	prune(hashes: ReadonlySet<Hash>): PrunedStateSnapshots {
		const pruned: PrunedStateSnapshots = { drp: [], acl: [] };
		for (const [hash, state] of this.drpStates) {
			if (!hashes.has(hash)) {
				pruned.drp.push([hash, state]);
				this.drpStates.delete(hash);
			}
		}
		for (const [hash, state] of this.aclStates) {
			if (!hashes.has(hash)) {
				pruned.acl.push([hash, state]);
				this.aclStates.delete(hash);
			}
		}
		return pruned;
	}

	/**
	 * Restore snapshots removed by a pruning pass without overwriting a later
	 * writer at the same hash.
	 * @param snapshots - Exact snapshot instances removed by prune
	 */
	restorePruned(snapshots: PrunedStateSnapshots): void {
		for (const [hash, state] of snapshots.drp) {
			if (!this.drpStates.has(hash)) this.drpStates.set(hash, state);
		}
		for (const [hash, state] of snapshots.acl) {
			if (!this.aclStates.has(hash)) this.aclStates.set(hash, state);
		}
	}

	/**
	 * Get the ACL for a given hash
	 * @param hash - The hash of the state to get
	 * @returns The ACL for the given hash
	 */
	fromHashACL(hash: Hash): IACL {
		const state = this.aclStates.get(hash);
		if (!state) {
			throw new StateNotFoundError(`State ${hash} not found`);
		}
		const acl = Object.create(this.aclConstructor.prototype);
		if (this.aclContext) acl.context = cloneDeep(this.aclContext);
		this.applyState(acl, state);
		return acl;
	}

	private applyState(instance: T | IACL, state: DRPState): void {
		for (const entry of state.state) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rightfully so this is not a problem
			(instance as any)[entry.key] = cloneDeep(entry.value);
		}
	}
}

/**
 * Convert a DRP object to a DRP state
 * @param drp - The DRP object to convert
 * @returns The DRP state
 */
export function stateFromDRP(drp: IDRP | undefined): DRPState {
	const state = DRPState.create();
	if (!drp) return state;
	for (const key of Object.keys(drp)) {
		if (REPLICA_LOCAL_STATE_KEYS.has(key)) continue;
		if (typeof drp[key] === "function") continue;

		state.state.push(DRPStateEntry.create({ key, value: cloneDeep(drp[key]) }));
	}
	return state;
}
