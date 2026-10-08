import { type DRPState, type Hash } from "@ts-drp/types";

/** Replica-local blueprint fields excluded from consensus-visible snapshots. */
export const REPLICA_LOCAL_STATE_KEYS: ReadonlySet<string> = new Set(["context"]);

export interface PrunedStateSnapshots {
	drp: [Hash, DRPState][];
	acl: [Hash, DRPState][];
}

/** Sink-free snapshot storage surface used by publication. */
export class DRPStateStore {
	private readonly drpStates = new Map<Hash, DRPState>();
	private readonly aclStates = new Map<Hash, DRPState>();

	/**
	 * Seed an empty store after the materializer captures reconstruction metadata.
	 * @param rootHash - Root vertex hash
	 * @param drpState - Root DRP snapshot
	 * @param aclState - Root ACL snapshot
	 */
	protected seedRoot(rootHash: Hash, drpState: DRPState, aclState: DRPState): void {
		this.drpStates.set(rootHash, drpState);
		this.aclStates.set(rootHash, aclState);
	}

	/**
	 * Read a DRP snapshot.
	 * @param hash - Snapshot hash
	 * @returns Stored snapshot, when present
	 */
	getDRPState(hash: Hash): DRPState | undefined {
		return this.drpStates.get(hash);
	}

	/**
	 * Install a DRP snapshot.
	 * @param hash - Snapshot hash
	 * @param state - Snapshot to store
	 */
	setDRPState(hash: Hash, state: DRPState): void {
		this.drpStates.set(hash, state);
	}

	/**
	 * Delete a DRP snapshot only when its identity still matches.
	 * @param hash - Snapshot hash
	 * @param expected - Expected snapshot identity
	 * @returns Whether the matching snapshot was deleted
	 */
	deleteDRPState(hash: Hash, expected: DRPState): boolean {
		if (this.drpStates.get(hash) !== expected) return false;
		return this.drpStates.delete(hash);
	}

	/**
	 * Read an ACL snapshot.
	 * @param hash - Snapshot hash
	 * @returns Stored snapshot, when present
	 */
	getACLState(hash: Hash): DRPState | undefined {
		return this.aclStates.get(hash);
	}

	/**
	 * Install an ACL snapshot.
	 * @param hash - Snapshot hash
	 * @param state - Snapshot to store
	 */
	setACLState(hash: Hash, state: DRPState): void {
		this.aclStates.set(hash, state);
	}

	/**
	 * Delete an ACL snapshot only when its identity still matches.
	 * @param hash - Snapshot hash
	 * @param expected - Expected snapshot identity
	 * @returns Whether the matching snapshot was deleted
	 */
	deleteACLState(hash: Hash, expected: DRPState): boolean {
		if (this.aclStates.get(hash) !== expected) return false;
		return this.aclStates.delete(hash);
	}

	/**
	 * Retain only the requested hashes and return rollback material.
	 * @param hashes - Hashes that remain stored
	 * @returns Removed snapshots for rollback
	 */
	prune(hashes: ReadonlySet<Hash>): PrunedStateSnapshots {
		const pruned: PrunedStateSnapshots = { drp: [], acl: [] };
		for (const [hash, state] of this.drpStates) {
			if (hashes.has(hash)) continue;
			pruned.drp.push([hash, state]);
			this.drpStates.delete(hash);
		}
		for (const [hash, state] of this.aclStates) {
			if (hashes.has(hash)) continue;
			pruned.acl.push([hash, state]);
			this.aclStates.delete(hash);
		}
		return pruned;
	}

	/**
	 * Restore snapshots removed by a journaled prune.
	 * @param snapshots - Removed snapshots to restore
	 */
	restorePruned(snapshots: PrunedStateSnapshots): void {
		for (const [hash, state] of snapshots.drp) {
			if (!this.drpStates.has(hash)) this.drpStates.set(hash, state);
		}
		for (const [hash, state] of snapshots.acl) {
			if (!this.aclStates.has(hash)) this.aclStates.set(hash, state);
		}
	}
}
