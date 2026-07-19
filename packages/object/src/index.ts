import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { Logger } from "@ts-drp/logger";
import {
	type ApplyResult,
	type CreateObjectOptions,
	type DRPObjectCallback,
	type DRPObjectOptions,
	type DRPState,
	type IACL,
	type IDRP,
	type IDRPObject,
	type IFinalityStore,
	type MergeResult,
	type Vertex,
} from "@ts-drp/types";

import { createPermissionlessACL } from "./acl/index.js";
import { createDRPVertexApplier, type DRPVertexApplier } from "./drp-applier.js";
import { FinalityStore } from "./finality/index.js";
import { HashGraph } from "./hashgraph/index.js";
import { type DRPObjectStateManager } from "./state.js";

export * from "./acl/index.js";
export * from "./hashgraph/index.js";

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
		return [this._states.getACLState(vertexHash), this._states.getDRPState(vertexHash)];
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
			throw new Error("Refusing to overwrite the root ACL state: genesis is derived from the object id");
		}
		this._states.setACLState(vertexHash, aclState);
	}

	/**
	 * Sets the DRP state of a vertex.
	 * @param vertexHash - The hash of the vertex.
	 * @param drpState - The DRP state of the vertex.
	 */
	setDRPState(vertexHash: string, drpState: DRPState): void {
		this._states.setDRPState(vertexHash, drpState);
	}

	/**
	 * Applies a list of vertices to the DRPObject.
	 * @param vertices - The vertices to apply.
	 * @returns The result of the application.
	 */
	async applyVertices(vertices: Vertex[]): Promise<ApplyResult> {
		return this._applier.applyVertices(vertices);
	}

	/**
	 * @deprecated Use applyVertices instead
	 * Merges a list of vertices to the DRPObject.
	 * @param vertices - The vertices to merge.
	 * @param rootACLState - Rejected. Root ACL adoption was removed: genesis is derived from the object id.
	 * @returns The result of the merge.
	 */
	async merge(vertices: Vertex[], rootACLState?: DRPState): Promise<MergeResult> {
		if (rootACLState !== undefined) {
			// Genesis authority is derived locally from the creator-bound object id;
			// a root ACL supplied through sync is an attempted authority takeover.
			throw new Error("Refusing to adopt a root ACL from the network: genesis is derived from the object id");
		}
		const { applied, missing, invalid } = await this._applier.applyVertices(vertices);
		return [applied, missing, invalid];
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
			callback(this, origin, vertices);
		}
	}
}
