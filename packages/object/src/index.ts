import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { Logger } from "@ts-drp/logger";
import {
	type ApplyResult,
	type CreateObjectOptions,
	type DRPObjectCallback,
	type DRPObjectOptions,
	type DRPState,
	DRPStateOtherTheWire,
	type Hash,
	type IACL,
	type IDRP,
	type IDRPObject,
	type IFinalityStore,
	type MergeResult,
	type Vertex,
} from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";

import { createPermissionlessACL } from "./acl/index.js";
import { createDRPVertexApplier, type DRPVertexApplier } from "./drp-applier.js";
import { AdoptionCommitExhaustedError, ApplyInvariantError, RootACLMutationError } from "./errors.js";
import { FinalityStore } from "./finality/index.js";
import { HashGraph } from "./hashgraph/index.js";
import { type DRPObjectStateManager } from "./state-materialize.js";
import { detachStateSnapshot } from "./state-payload.js";
import { classifyNovelVertices } from "./vertex-authentication.js";

export * from "./acl/index.js";
export * from "./hashgraph/index.js";
export { AdoptionCommitExhaustedError, ApplyInvariantError, RootACLMutationError };
export { authenticateVertices } from "./vertex-authentication.js";

/**
 * Object ids are creator-bound: `<creatorPeerId>:<randomHexSalt>`.
 *
 * The prefix commits the id to the peer that created the object, so every
 * replica can derive the identical genesis ACL (the creator as sole admin and
 * finality signer) locally from the id alone, with zero network trust. The
 * salt keeps independently created objects distinct. libp2p peer ids are
 * base58btc/base32 strings and never contain the separator, so the creator is
 * recovered unambiguously as the prefix before the last separator.
 */
const OBJECT_ID_SEPARATOR = ":";
const OBJECT_ID_SALT_BYTES = 16;

function defaultIDFromPeerID(peerId: string): string {
	return `${peerId}${OBJECT_ID_SEPARATOR}${bytesToHex(randomBytes(OBJECT_ID_SALT_BYTES))}`;
}

/**
 * Recover the creator peer id committed into a creator-bound object id.
 * @param id - The object id.
 * @returns The creator peer id, or undefined when the id carries no creator commitment.
 */
export function creatorFromObjectID(id: string): string | undefined {
	const separatorIndex = id.lastIndexOf(OBJECT_ID_SEPARATOR);
	if (separatorIndex <= 0) return undefined;
	return id.slice(0, separatorIndex);
}

/**
 * Derive the genesis ACL every replica computes locally.
 *
 * Creators (no id supplied) start as their own sole admin and finality signer.
 * Joiners (known id) recover the creator from the id and derive the identical
 * genesis. A malformed id without a creator commitment fails safe: the genesis
 * grants authority to nobody, and no network message can ever install one.
 * @param peerId - The local peer id.
 * @param id - The known object id, if joining.
 * @returns The locally derived genesis ACL.
 */
function genesisACL(peerId: string, id: string | undefined): IACL {
	if (id === undefined) return createPermissionlessACL(peerId);
	const creator = creatorFromObjectID(id);
	return creator === undefined ? createPermissionlessACL() : createPermissionlessACL(creator);
}

/**
 * Creates a DRPObject.
 * @param options - The options for the DRPObject.
 * @returns The DRPObject.
 */
export function createObject<T extends IDRP>(options: CreateObjectOptions<T>): IDRPObject<T> {
	const acl = createPermissionlessACL(options.peerId);

	const object = new DRPObject<T>({ ...options, config: { log_config: options.log_config }, acl });
	return object;
}

/**
 * A DRPObject.
 * @template T - The type of the DRPObject.
 */
export class DRPObject<T extends IDRP> implements IDRPObject<T> {
	readonly id: string;
	private readonly log: Logger;
	private readonly hashGraph: HashGraph;

	private _applier: DRPVertexApplier<T>;
	private _states: DRPObjectStateManager<T>;
	private readonly mergeIngestMetadata = new WeakMap<
		MergeResult,
		{ committed: readonly Vertex[]; hasTrustedOrAuthenticatedOffers: boolean }
	>();

	private subscriptions: DRPObjectCallback<T>[] = [];
	private _finalityStore: FinalityStore;

	/**
	 * Creates a DRPObject.
	 * @param options - The options for the DRPObject.
	 * @param options.peerId - The peer ID of the DRPObject.
	 * @param options.id - The ID of the DRPObject.
	 * @param options.acl - The ACL of the DRPObject.
	 * @param options.drp - The DRP of the DRPObject.
	 * @param options.config - The config of the DRPObject.
	 */
	constructor(options: DRPObjectOptions<T>) {
		const {
			peerId,
			id = defaultIDFromPeerID(peerId),
			acl = genesisACL(peerId, options.id),
			drp,
			config,
			//metrics,
		} = options;
		this.id = id;
		this.log = new Logger(`drp::object::${this.id}`, config?.log_config);

		this.hashGraph = new HashGraph(
			peerId,
			acl.resolveConflicts?.bind(acl),
			drp?.resolveConflicts?.bind(drp),
			// DRP-less replicas must still linearize ACL history: without a
			// semantics type the hashgraph refuses to linearize and remotely
			// merged ACL vertices would never replay into the live ACL.
			drp?.semanticsType ?? acl.semanticsType
		);

		this._finalityStore = new FinalityStore(config?.finality_config, config?.log_config);
		[this._applier, this._states] = createDRPVertexApplier({
			drp,
			acl,
			hashGraph: this.hashGraph,
			finalityStore: this._finalityStore,
			notify: this._notify.bind(this),
			finalityConfig: config?.finality_config,
			logConfig: config?.log_config,
		});
	}

	/**
	 * Gets the DRP of the DRPObject.
	 * @returns The DRP of the DRPObject.
	 */
	get drp(): T | undefined {
		return this._applier.drp;
	}

	/**
	 * Gets the ACL of the DRPObject.
	 * @returns The ACL of the DRPObject.
	 */
	get acl(): IACL {
		return this._applier.acl;
	}

	/**
	 * Gets all the vertices of the DRPObject.
	 * @returns The vertices of the DRPObject.
	 */
	get vertices(): Vertex[] {
		return this.hashGraph.getAllVertices();
	}

	/**
	 * Gets a stored vertex by hash.
	 * @param hash - The vertex hash.
	 * @returns The stored vertex reference, or undefined when the hash is absent.
	 */
	getVertex(hash: Hash): Vertex | undefined {
		return this.hashGraph.getVertex(hash);
	}

	/**
	 * Gets the finality store of the DRPObject.
	 * @returns The finality store of the DRPObject.
	 */
	get finalityStore(): IFinalityStore {
		return this._finalityStore;
	}

	/**
	 * Gets the ACL and DRP states of a vertex.
	 * @param vertexHash - The hash of the vertex.
	 * @returns The ACL and DRP states of the vertex.
	 */
	getStates(vertexHash: string): [DRPState | undefined, DRPState | undefined] {
		const aclState = this._states.getACLState(vertexHash);
		const drpState = this._states.getDRPState(vertexHash);
		return [
			aclState === undefined ? undefined : detachStateSnapshot(aclState),
			drpState === undefined ? undefined : detachStateSnapshot(drpState),
		];
	}

	/**
	 * Gets an ACL-first pair of stored snapshot bytes without exposing internal values.
	 * @param vertexHash - The hash of the vertex.
	 * @returns Detached encoded snapshots, preserving explicit absence.
	 */
	getSerializedStates(
		vertexHash: string
	): readonly [aclState: Uint8Array | undefined, drpState: Uint8Array | undefined] {
		const aclState = this._states.getACLState(vertexHash);
		const drpState = this._states.getDRPState(vertexHash);
		return [
			aclState === undefined ? undefined : DRPStateOtherTheWire.encode(serializeDRPState(aclState)).finish(),
			drpState === undefined ? undefined : DRPStateOtherTheWire.encode(serializeDRPState(drpState)).finish(),
		];
	}

	/**
	 * Sets the ACL state of a vertex.
	 * @param vertexHash - The hash of the vertex.
	 * @param aclState - The ACL state of the vertex.
	 */
	setACLState(vertexHash: string, aclState: DRPState): void {
		if (vertexHash === HashGraph.rootHash) {
			// Genesis authority is derived locally from the creator-bound object id
			// and is never adopted from the network or overwritten after creation.
			throw new RootACLMutationError("Refusing to overwrite the root ACL state: genesis is derived from the object id");
		}
		this._states.setACLState(vertexHash, detachStateSnapshot(aclState));
	}

	/**
	 * Sets the DRP state of a vertex.
	 * @param vertexHash - The hash of the vertex.
	 * @param drpState - The DRP state of the vertex.
	 */
	setDRPState(vertexHash: string, drpState: DRPState): void {
		this._states.setDRPState(vertexHash, detachStateSnapshot(drpState));
	}

	/**
	 * Applies a list of vertices to the DRPObject.
	 * @param vertices - The vertices to apply.
	 * @returns The result of the application.
	 */
	async applyVertices(vertices: Vertex[]): Promise<ApplyResult> {
		return (await this.authenticateAndApplyVertices(vertices)).result;
	}

	private async authenticateAndApplyVertices(vertices: Vertex[]): Promise<{
		authenticated: readonly Vertex[];
		hasTrustedOrAuthenticatedOffers: boolean;
		result: ApplyResult;
	}> {
		const {
			authenticated,
			invalid: authenticationInvalid,
			offeredHashes,
		} = classifyNovelVertices(vertices, (hash) => hash === HashGraph.rootHash || this.hashGraph.vertices.has(hash));
		const applied =
			authenticated.length === 0
				? { applied: true, invalid: [], missing: [] }
				: await this._applier.applyVertices(authenticated);
		const hasTrustedOrAuthenticatedOffers = offeredHashes.length > authenticationInvalid.length;
		if (authenticationInvalid.length === 0) {
			return { authenticated, hasTrustedOrAuthenticatedOffers, result: applied };
		}

		const invalidCounts = new Map<string, number>();
		for (const hash of [...authenticationInvalid, ...applied.invalid]) {
			invalidCounts.set(hash, (invalidCounts.get(hash) ?? 0) + 1);
		}
		const invalid: string[] = [];
		for (const hash of offeredHashes) {
			const count = invalidCounts.get(hash) ?? 0;
			if (count === 0) continue;
			invalid.push(hash);
			invalidCounts.set(hash, count - 1);
		}
		return {
			authenticated,
			hasTrustedOrAuthenticatedOffers,
			result: { ...applied, applied: false, invalid },
		};
	}

	/**
	 * @deprecated Use applyVertices instead
	 * Merges a list of vertices into the DRPObject and resolves with the
	 * partial legacy tuple even when individual vertices are rejected.
	 * Transiently quarantined hashes are not representable in MergeResult;
	 * use applyVertices when callers need that retry signal.
	 * @param vertices - The vertices to merge.
	 * @param rootACLState - Rejected. Root ACL adoption was removed: genesis is derived from the object id.
	 * @returns The result of the merge.
	 */
	async merge(vertices: Vertex[], rootACLState?: DRPState): Promise<MergeResult> {
		if (rootACLState !== undefined) {
			// Genesis authority is derived locally from the creator-bound object id;
			// a root ACL supplied through sync is an attempted authority takeover.
			throw new RootACLMutationError(
				"Refusing to adopt a root ACL from the network: genesis is derived from the object id"
			);
		}
		const { authenticated, hasTrustedOrAuthenticatedOffers, result } =
			await this.authenticateAndApplyVertices(vertices);
		const mergeResult: MergeResult = [result.applied, result.missing, result.invalid];
		const committed: Vertex[] = [];
		const committedHashes = new Set<string>();
		for (const vertex of authenticated) {
			if (committedHashes.has(vertex.hash)) continue;
			const stored = this.hashGraph.vertices.get(vertex.hash);
			if (stored === undefined) continue;
			committedHashes.add(vertex.hash);
			committed.push(stored);
		}
		this.mergeIngestMetadata.set(mergeResult, { committed, hasTrustedOrAuthenticatedOffers });
		return mergeResult;
	}

	/**
	 * Resolve the object-owned snapshots newly committed by one merge result.
	 * @param result - Exact tuple returned by this object's merge call.
	 * @returns Newly committed snapshots, or undefined for an unrelated result.
	 */
	appliedVerticesForMergeResult(result: MergeResult): readonly Vertex[] | undefined {
		return this.mergeIngestMetadata.get(result)?.committed;
	}

	/**
	 * Report whether a merge contained any root/known or cryptographically
	 * authenticated offer, independent of later graph classification.
	 * @param result - Exact tuple returned by this object's merge call.
	 * @returns The offer-authentication verdict, or undefined for an unrelated result.
	 */
	mergeHadTrustedOrAuthenticatedOffers(result: MergeResult): boolean | undefined {
		return this.mergeIngestMetadata.get(result)?.hasTrustedOrAuthenticatedOffers;
	}

	/**
	 * Subscribes to the DRPObject.
	 * @param callback - The callback to subscribe to the DRPObject.
	 */
	subscribe(callback: DRPObjectCallback<T>): void {
		this.subscriptions.push(callback);
	}

	private _notify(origin: string, vertices: Vertex[]): void {
		for (const callback of this.subscriptions) {
			try {
				const callbackResult = (
					callback as unknown as (object: IDRPObject<T>, origin: string, vertices: Vertex[]) => unknown
				)(this, origin, vertices);
				if (callbackResult !== null && (typeof callbackResult === "object" || typeof callbackResult === "function")) {
					const then = (callbackResult as { then?: unknown }).then;
					if (typeof then === "function") {
						let rejectionReported = false;
						then.call(callbackResult, undefined, (reason: unknown) => {
							if (rejectionReported) return;
							rejectionReported = true;
							this.log.error("DRPObject subscriber callback rejected", reason);
						});
					}
				}
			} catch (error) {
				this.log.error("DRPObject subscriber callback failed", error);
			}
		}
	}
}
