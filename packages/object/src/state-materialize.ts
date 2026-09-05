import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import { type DrpRuntimeContext, DRPState, DRPStateEntry, type Hash, type IACL, type IDRP } from "@ts-drp/types";

import { HashGraph } from "./hashgraph/index.js";
import {
	borrowedStateEntry,
	createReplicaLocalContextDetacher,
	createStatePayloadDetacher,
	defineDeferredEnumerableState,
	defineEnumerableOwnData,
	detachReplicaLocalContext,
	detachStatePayload,
	readEnumerableStateValue,
	readValidatedStateSnapshot,
	type ValidatedStateSnapshotKeys,
	validateStateSnapshotKeysForApplication,
} from "./state-payload.js";
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
		this.drpContext = detachReplicaLocalContext(drp?.context);
		this.aclContext = detachReplicaLocalContext(acl.context);
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
	 * Reconstruct an execution-only overlay from one owned snapshot pair.
	 * @param hash - Snapshot hash
	 * @param replayDepth - Replay depth recorded for tracing
	 * @param drpContext - Replica-local DRP context
	 * @param aclContext - Replica-local ACL context
	 * @returns Execution-only DRP and ACL overlays
	 */
	fromHashForExecution(
		hash: Hash,
		replayDepth = 0,
		drpContext = this.drpContext,
		aclContext = this.aclContext
	): [T | undefined, IACL] {
		const drpState = this.getDRPState(hash);
		const aclState = this.getACLState(hash);
		if (!drpState || !aclState) throw new StateNotFoundError(`State ${hash} not found`);
		if (isTracingEnabled()) {
			return metrics.traceFunc(
				"states.fromHashForExecution",
				() => this.fromStatesForExecution(drpState, aclState, drpContext, aclContext),
				(span) => span.setAttribute("drp.replay.depth", replayDepth)
			)();
		}
		return this.fromStatesForExecution(drpState, aclState, drpContext, aclContext);
	}

	/**
	 * Reconstruct instances from explicit snapshots.
	 * @param drpState - DRP snapshot
	 * @param aclState - ACL snapshot
	 * @param drpContext - Replica-local DRP context
	 * @param aclContext - Replica-local ACL context
	 * @param executionOnly - Whether reconstruction should defer governed value detachment
	 * @returns Reconstructed DRP and ACL
	 */
	fromStates(
		drpState: DRPState,
		aclState: DRPState,
		drpContext = this.drpContext,
		aclContext = this.aclContext,
		executionOnly = false
	): [T | undefined, IACL] {
		const validatedACLState = validateStateSnapshotKeysForApplication(aclState);
		const validatedDRPState =
			this.drpConstructor === undefined ? undefined : validateStateSnapshotKeysForApplication(drpState);
		const acl = Object.create(this.aclConstructor.prototype);
		if (aclContext) defineEnumerableOwnData(acl, "context", detachReplicaLocalContext(aclContext));
		if (executionOnly) this.applyDeferredState(acl, validatedACLState);
		else this.applyState(acl, readValidatedStateSnapshot(validatedACLState));
		if (this.drpConstructor === undefined) return [undefined, acl];
		if (validatedDRPState === undefined) return [undefined, acl];
		const drp = Object.create(this.drpConstructor.prototype);
		if (drpContext) defineEnumerableOwnData(drp, "context", detachReplicaLocalContext(drpContext));
		if (executionOnly) this.applyDeferredState(drp, validatedDRPState);
		else this.applyState(drp, readValidatedStateSnapshot(validatedDRPState));
		return [drp, acl];
	}

	/**
	 * Reconstruct execution-only COW overlays from explicit snapshots.
	 * @param drpState - DRP snapshot
	 * @param aclState - ACL snapshot
	 * @param drpContext - Replica-local DRP context
	 * @param aclContext - Replica-local ACL context
	 * @returns Execution-only DRP and ACL overlays
	 */
	fromStatesForExecution(
		drpState: DRPState,
		aclState: DRPState,
		drpContext = this.drpContext,
		aclContext = this.aclContext
	): [T | undefined, IACL] {
		return this.fromStates(drpState, aclState, drpContext, aclContext, true);
	}

	/**
	 * Reconstruct only the ACL at a stored hash.
	 * @param hash - Snapshot hash
	 * @returns Reconstructed ACL
	 */
	fromHashACL(hash: Hash): IACL {
		const state = this.getACLState(hash);
		if (!state) throw new StateNotFoundError(`State ${hash} not found`);
		const preparedState = readValidatedStateSnapshot(validateStateSnapshotKeysForApplication(state));
		const acl = Object.create(this.aclConstructor.prototype);
		if (this.aclContext) defineEnumerableOwnData(acl, "context", detachReplicaLocalContext(this.aclContext));
		this.applyState(acl, preparedState);
		return acl;
	}

	private applyState(instance: T | IACL, state: DRPState): void {
		const detachedValues = detachStatePayload(state.state.map((entry) => entry.value));
		for (let index = 0; index < state.state.length; index++) {
			const entry = state.state[index];
			if (entry === undefined) throw new TypeError("DRP state entry must be present");
			defineEnumerableOwnData(instance, entry.key, detachedValues[index]);
		}
	}

	private applyDeferredState(instance: T | IACL, validated: ValidatedStateSnapshotKeys): void {
		const detach = createStatePayloadDetacher();
		for (let index = 0; index < validated.entries.length; index++) {
			const entry = validated.entries[index];
			const key = validated.keys[index];
			if (entry === undefined || key === undefined) throw new TypeError("DRP state entry must be present");
			defineDeferredEnumerableState(instance, key, entry.value, detach, entry);
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
	const staged: { key: string; value: unknown }[] = [];
	for (const key of Object.keys(drp)) {
		if (REPLICA_LOCAL_STATE_KEYS.has(key)) continue;
		const value = drp[key];
		if (typeof value === "function") continue;
		staged.push({ key, value });
	}
	const detachedValues = detachStatePayload(staged.map(({ value }) => value));
	for (let index = 0; index < staged.length; index++) {
		const entry = staged[index];
		if (entry === undefined) throw new TypeError("DRP state entry must be present");
		state.state.push(DRPStateEntry.create({ key: entry.key, value: detachedValues[index] }));
	}
	return state;
}

/**
 * Clone one instance as an execution-only deferred overlay.
 * @param source - Instance whose enumerable state should be borrowed lazily
 * @returns Execution-only clone with deferred governed values
 */
export function cloneEnumerableExecutionInstance<T extends object>(source: T): T {
	const clone = Object.create(Reflect.getPrototypeOf(source)) as T;
	const detach = createStatePayloadDetacher();
	const detachContext = createReplicaLocalContextDetacher();
	for (const key of Object.keys(source)) {
		const value = readEnumerableStateValue(source, key);
		if (typeof value === "function") continue;
		if (REPLICA_LOCAL_STATE_KEYS.has(key)) {
			defineEnumerableOwnData(clone, key, detachContext(value));
			continue;
		}
		defineDeferredEnumerableState(clone, key, value, detach, borrowedStateEntry(source, key));
	}
	return clone;
}
