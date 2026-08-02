import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import { type DrpRuntimeContext, DRPState, DRPStateEntry, type Hash, type IACL, type IDRP } from "@ts-drp/types";
import { cloneDeep } from "es-toolkit";

import { HashGraph } from "./hashgraph/index.js";
import { DRPStateStore, REPLICA_LOCAL_STATE_KEYS } from "./state-store.js";

const metrics = new OpentelemetryMetrics("@ts-drp/object/states");

export { REPLICA_LOCAL_STATE_KEYS } from "./state-store.js";

/** Raised when materialization is requested for an absent snapshot. */
export class StateNotFoundError extends Error {
	/**
	 * Create an absent-snapshot error.
	 * @param message - Error description
	 */
	constructor(message: string = "DRPState not found") {
		super(message);
		this.name = "DRPStateNotFoundError";
	}
}

/**
 * Sink-owning reconstruction half of the state manager. Storage is supplied by
 * the subclass so publication can depend on the sink-free store surface only.
 * @template T - DRP implementation type
 */
export class DRPObjectStateManager<T extends IDRP> extends DRPStateStore {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly drpConstructor?: { prototype: any };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly aclConstructor: { prototype: any };
	private readonly drpContext?: DrpRuntimeContext;
	private readonly aclContext?: DrpRuntimeContext;

	/**
	 * Capture the root snapshots and reconstruction metadata.
	 * @param acl - Root ACL instance
	 * @param drp - Optional root DRP instance
	 */
	constructor(acl: IACL, drp?: T) {
		super();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.drpConstructor = drp?.constructor as { prototype: any };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.aclConstructor = acl.constructor as { prototype: any };
		this.drpContext = cloneDeep(drp?.context);
		this.aclContext = cloneDeep(acl.context);
		this.seedRoot(HashGraph.rootHash, drp ? stateFromDRP(drp) : DRPState.create(), stateFromDRP(acl));
	}

	/**
	 * Reconstruct the ACL and optional DRP at a stored hash.
	 * @param hash - Snapshot hash
	 * @param replayDepth - Trace-only replay depth
	 * @param drpContext - Replica-local DRP context
	 * @param aclContext - Replica-local ACL context
	 * @returns Reconstructed DRP and ACL
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
			(span) => span.setAttribute("drp.replay.depth", replayDepth)
		)(hash);
	}

	private fromHashUntraced(
		hash: Hash,
		drpContext?: DrpRuntimeContext,
		aclContext?: DrpRuntimeContext
	): [T | undefined, IACL] {
		const drpState = this.getDRPState(hash);
		const aclState = this.getACLState(hash);
		if (!drpState || !aclState) throw new StateNotFoundError(`State ${hash} not found`);
		return this.fromStates(drpState, aclState, drpContext, aclContext);
	}

	/**
	 * Reconstruct instances from explicit snapshots.
	 * @param drpState - DRP snapshot
	 * @param aclState - ACL snapshot
	 * @param drpContext - Replica-local DRP context
	 * @param aclContext - Replica-local ACL context
	 * @returns Reconstructed DRP and ACL
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
		if (!this.drpConstructor) return [undefined, acl];
		const drp = Object.create(this.drpConstructor.prototype);
		if (drpContext) drp.context = cloneDeep(drpContext);
		this.applyState(drp, drpState);
		return [drp, acl];
	}

	/**
	 * Reconstruct only the ACL at a stored hash.
	 * @param hash - Snapshot hash
	 * @returns Reconstructed ACL
	 */
	fromHashACL(hash: Hash): IACL {
		const state = this.getACLState(hash);
		if (!state) throw new StateNotFoundError(`State ${hash} not found`);
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
 * Convert a DRP instance into an independently owned snapshot.
 * @param drp - Instance to snapshot
 * @returns Independently owned state
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
