import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import { DRPState, DRPStateEntry, type Hash, type IACL, type IDRP } from "@ts-drp/types";
import { cloneDeep } from "es-toolkit";

import { HashGraph } from "./hashgraph/index.js";

const metrics = new OpentelemetryMetrics("@ts-drp/object/states");

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
	 * Get the DRP and ACL for a given hash
	 * @param hash - The hash of the state to get
	 * @param replayDepth
	 * @returns The DRP and ACL for the given hash
	 */
	fromHash(hash: Hash, replayDepth = 0): [T | undefined, IACL] {
		if (!isTracingEnabled()) return this.fromHashUntraced(hash);

		return metrics.traceFunc(
			"states.fromHash",
			(candidateHash: Hash) => this.fromHashUntraced(candidateHash),
			(span) => {
				span.setAttribute("drp.replay.depth", replayDepth);
			}
		)(hash);
	}

	private fromHashUntraced(hash: Hash): [T | undefined, IACL] {
		if (!this.aclConstructor) {
			throw new Error("ACL constructor not set");
		}

		const drpState = this.drpStates.get(hash);
		const aclState = this.aclStates.get(hash);
		if (!drpState || !aclState) {
			throw new StateNotFoundError(`State ${hash} not found`);
		}

		return this.fromStates(drpState, aclState);
	}

	/**
	 * Reconstruct an object pair from explicit snapshots. Checkpoints use this
	 * because a merged frontier state does not necessarily belong to one hash.
	 * @param drpState - DRP snapshot at the causal cut
	 * @param aclState - ACL snapshot at the causal cut
	 * @returns Reconstructed DRP and ACL instances
	 */
	fromStates(drpState: DRPState, aclState: DRPState): [T | undefined, IACL] {
		const acl = Object.create(this.aclConstructor.prototype);
		this.applyState(acl, aclState);

		if (this.drpConstructor) {
			const drp = Object.create(this.drpConstructor.prototype);
			this.applyState(drp, drpState);
			return [drp, acl];
		}

		return [undefined, acl];
	}

	/**
	 * Retain only snapshots that can still seed incremental replay or are in the
	 * current replay suffix.
	 * @param hashes - Snapshot hashes to retain
	 */
	prune(hashes: ReadonlySet<Hash>): void {
		for (const hash of this.drpStates.keys()) {
			if (!hashes.has(hash)) this.drpStates.delete(hash);
		}
		for (const hash of this.aclStates.keys()) {
			if (!hashes.has(hash)) this.aclStates.delete(hash);
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
		if (typeof drp[key] === "function") continue;

		state.state.push(DRPStateEntry.create({ key, value: cloneDeep(drp[key]) }));
	}
	return state;
}
