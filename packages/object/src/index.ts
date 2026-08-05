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
	type HistoryInventory,
	type HistoryReadResult,
	type HistoryRehydrationResult,
	type HistoryStorage,
	type IACL,
	type IDRP,
	type IDRPObject,
	type IFinalityStore,
	type MergeResult,
	type ReplicaMode,
	type Vertex,
	type VertexPayloadResult,
} from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";

import { createPermissionlessACL } from "./acl/index.js";
import { createDRPVertexApplier, type DRPVertexApplier } from "./drp-applier.js";
import { AdoptionCommitExhaustedError, ApplyInvariantError, RootACLMutationError } from "./errors.js";
import { FinalityStore } from "./finality/index.js";
import { HashGraph } from "./hashgraph/index.js";
import { type DRPObjectStateManager, stateFromDRP } from "./state-materialize.js";
import { detachStateSnapshot } from "./state-payload.js";
import {
	type AuthenticatedVertex,
	classifyNovelVertices,
	orderAuthenticatedVertexFailures,
	resolveAuthenticatedVertex,
} from "./vertex-authentication.js";

export * from "./acl/index.js";
export * from "./hashgraph/index.js";
export { AdoptionCommitExhaustedError, ApplyInvariantError, RootACLMutationError };
export { authenticateVertices } from "./vertex-authentication.js";

export interface AuthenticatedMergeOutcome {
	readonly committed: readonly Vertex[];
	readonly hasTrustedOrAuthenticatedOffers: boolean;
	readonly result: MergeResult;
}

function canonicalAuthenticatedHash(authenticated: readonly AuthenticatedVertex[], index: number): string {
	const handle = authenticated[index];
	if (handle === undefined) throw new Error("Authenticated occurrence points outside its verified batch");
	const canonical = resolveAuthenticatedVertex(handle);
	if (canonical === undefined) throw new Error("Authenticated occurrence lost verifier provenance");
	return canonical.hash;
}

/**
 * Apply remotely supplied vertices through the single authenticated object boundary.
 * Every implementation receives only detached verifier-issued novel vertices.
 * @param object - Installed object receiving the remote batch.
 * @param vertices - Raw decoded wire vertices.
 * @returns Node-consumable outcome derived without reflective object metadata.
 */
export async function mergeAuthenticatedVertices<T extends IDRP>(
	object: IDRPObject<T>,
	vertices: Vertex[]
): Promise<AuthenticatedMergeOutcome> {
	const { authenticated, occurrences } = classifyNovelVertices(
		vertices,
		(hash) =>
			hash === HashGraph.rootHash ||
			(object.historyStorage === "compact"
				? object.getVertexPayload(hash).status !== "unknown"
				: object.getVertex(hash) !== undefined)
	);
	const hasTrustedOrAuthenticatedOffers = occurrences.some(({ status }) => status !== "invalid");
	const dispatchedResult: MergeResult = authenticated.length === 0 ? [true, [], []] : await object.merge(authenticated);
	const result: MergeResult = occurrences.some(({ status }) => status === "invalid")
		? [false, dispatchedResult[1], orderAuthenticatedVertexFailures(occurrences, authenticated, dispatchedResult[2])]
		: dispatchedResult;
	const committed: Vertex[] = [];
	const committedHashes = new Set<string>();
	for (let index = 0; index < authenticated.length; index++) {
		const hash = canonicalAuthenticatedHash(authenticated, index);
		if (committedHashes.has(hash)) continue;
		const stored = object.getVertex(hash);
		if (stored === undefined) continue;
		committedHashes.add(hash);
		committed.push(stored);
	}
	return { committed, hasTrustedOrAuthenticatedOffers, result };
}

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

function resolveReplicaMode(mode: ReplicaMode | undefined): ReplicaMode {
	if (mode === undefined || mode === "writer") return "writer";
	if (mode === "observer") return "observer";
	throw new TypeError(`Unsupported replica mode: ${String(mode)}`);
}

function resolveHistoryStorage(storage: unknown, replicaMode: ReplicaMode): HistoryStorage {
	if (storage === undefined || storage === "full") return "full";
	if (storage === "compact" && replicaMode === "observer") return "compact";
	if (storage === "compact") throw new TypeError("Compact history storage requires observer replica mode");
	throw new TypeError(`Unsupported history storage: ${String(storage)}`);
}

function stateBytes(value: IDRP | undefined): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

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
	readonly replicaMode: ReplicaMode;
	historyStorage: HistoryStorage;
	private readonly log: Logger;
	private hashGraph: HashGraph;
	private readonly peerId: string;
	private authenticatedHistoryHashes?: Set<Hash>;
	private historyRevision = 0;

	private _applier: DRPVertexApplier<T>;
	private _states: DRPObjectStateManager<T>;
	private subscriptions: DRPObjectCallback<T>[] = [];
	private _optionalFinalityStore?: FinalityStore;

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
		this.peerId = peerId;
		this.replicaMode = resolveReplicaMode(config?.replica_mode);
		this.historyStorage = resolveHistoryStorage(config?.history_storage, this.replicaMode);
		if (this.historyStorage === "compact") {
			this.authenticatedHistoryHashes = new Set([HashGraph.rootHash]);
		}
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

		this._optionalFinalityStore =
			this.replicaMode === "writer" ? new FinalityStore(config?.finality_config, config?.log_config) : undefined;
		[this._applier, this._states] = createDRPVertexApplier({
			drp,
			acl,
			hashGraph: this.hashGraph,
			finalityStore: this._optionalFinalityStore,
			replicaMode: this.replicaMode,
			allowLocalAuthorship: this.historyStorage === "full",
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
	 * Authenticated hash knowledge and truthful complete-payload availability.
	 * @returns Known hashes and the subset with complete retained payloads
	 */
	get historyInventory(): HistoryInventory {
		const availablePayloadHashes = this.hashGraph.getAllVertices().map(({ hash }) => hash);
		return {
			knownHashes:
				this.authenticatedHistoryHashes === undefined ? availablePayloadHashes : [...this.authenticatedHistoryHashes],
			availablePayloadHashes,
		};
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
	 * Reads one complete locally retained payload without synthesizing a Vertex.
	 * @param hash - Authenticated hash to inspect
	 * @returns A complete payload, an unavailable capability result, or unknown
	 */
	getVertexPayload(hash: Hash): VertexPayloadResult {
		const vertex = this.hashGraph.getVertex(hash);
		if (vertex !== undefined) return { status: "available", vertex };
		if (this.authenticatedHistoryHashes?.has(hash)) {
			return { missingHashes: [hash], status: "history-unavailable" };
		}
		return { hash, status: "unknown" };
	}

	/**
	 * Reads only complete payloads, otherwise returning one truthful capability result.
	 * @param hashes - Authenticated hashes to read
	 * @returns Complete vertices or a typed unavailable/unknown result
	 */
	readHistory(hashes: readonly Hash[]): HistoryReadResult {
		const vertices: Vertex[] = [];
		const missingHashes: Hash[] = [];
		const unknownHashes: Hash[] = [];
		for (const hash of hashes) {
			const result = this.getVertexPayload(hash);
			if (result.status === "available") vertices.push(result.vertex);
			else if (result.status === "history-unavailable") missingHashes.push(...result.missingHashes);
			else unknownHashes.push(result.hash);
		}
		if (unknownHashes.length !== 0) return { status: "unknown", unknownHashes };
		if (missingHashes.length !== 0) return { missingHashes, status: "history-unavailable" };
		return { status: "available", vertices };
	}

	/**
	 * Rehydrates an exact compact inventory in an isolated full observer. The
	 * installed runtime changes only after authentication, ancestry replay and
	 * converged live-state checks all succeed.
	 * @param vertices - Complete signed non-root history, in any order
	 * @param options - Optional cancellation signal
	 * @param options.signal - Cancels isolated verification before adoption
	 * @returns Atomic completion or a typed rejection reason
	 */
	async rehydrateHistory(
		vertices: readonly Vertex[],
		options: { readonly signal?: AbortSignal } = {}
	): Promise<HistoryRehydrationResult> {
		if (this.historyStorage === "full") return { historyStorage: "full", status: "complete" };
		if (options.signal?.aborted) return { reason: "interrupted", status: "rejected" };

		const expectedHashes = [...(this.authenticatedHistoryHashes ?? [])].filter((hash) => hash !== HashGraph.rootHash);
		const expectedSet = new Set(expectedHashes);
		const offeredHashes: Hash[] = [];
		try {
			for (const vertex of vertices) offeredHashes.push(vertex.hash);
		} catch {
			return { reason: "invalid", status: "rejected" };
		}
		if (offeredHashes.some((hash) => !expectedSet.has(hash))) {
			return { reason: "wrong-history", status: "rejected" };
		}
		if (
			new Set(offeredHashes).size !== expectedSet.size ||
			expectedHashes.some((hash) => !offeredHashes.includes(hash))
		) {
			return { reason: "incomplete", status: "rejected" };
		}
		const offeredByHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));
		const canonicalOffer: Vertex[] = [];
		for (const hash of expectedHashes) {
			const vertex = offeredByHash.get(hash);
			if (vertex === undefined) return { reason: "incomplete", status: "rejected" };
			canonicalOffer.push(vertex);
		}

		const revision = this.historyRevision;
		const [rootDRP, rootACL] = this._states.fromHash(HashGraph.rootHash);
		const candidate = new DRPObject<T>({
			peerId: this.peerId,
			id: this.id,
			acl: rootACL,
			drp: rootDRP,
			config: { history_storage: "full", replica_mode: "observer" },
		});
		const result = await candidate.applyVertices(canonicalOffer);
		if (options.signal?.aborted) return { reason: "interrupted", status: "rejected" };
		if (result.invalid.length !== 0 || result.quarantined !== undefined) {
			return { reason: "invalid", status: "rejected" };
		}
		if (!result.applied || result.missing.length !== 0) {
			return { reason: "incomplete", status: "rejected" };
		}
		const candidateInventory = candidate.historyInventory;
		const completeExpectedHashes = [HashGraph.rootHash, ...expectedHashes];
		if (
			candidateInventory.knownHashes.length !== completeExpectedHashes.length ||
			!candidateInventory.knownHashes.every((hash, index) => hash === completeExpectedHashes[index])
		) {
			return { reason: "wrong-history", status: "rejected" };
		}
		if (
			!bytesEqual(stateBytes(candidate.acl), stateBytes(this.acl)) ||
			!bytesEqual(stateBytes(candidate.drp), stateBytes(this.drp))
		) {
			return { reason: "wrong-history", status: "rejected" };
		}
		if (this.historyStorage !== "compact" || this.historyRevision !== revision || options.signal?.aborted) {
			return { reason: "interrupted", status: "rejected" };
		}

		candidate._applier.setNotify(this._notify.bind(this));
		this.hashGraph = candidate.hashGraph;
		this._states = candidate._states;
		this._applier = candidate._applier;
		this._optionalFinalityStore = undefined;
		this.authenticatedHistoryHashes = undefined;
		this.historyStorage = "full";
		this.historyRevision++;
		return { historyStorage: "full", status: "complete" };
	}

	/**
	 * Gets the finality store of the DRPObject.
	 * @returns The finality store of the DRPObject.
	 */
	get finalityStore(): IFinalityStore {
		return this._finalityStore;
	}

	private get _finalityStore(): FinalityStore {
		if (this._optionalFinalityStore === undefined) {
			throw new Error("Observer replicas do not support finalityStore access");
		}
		return this._optionalFinalityStore;
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
		return this.authenticateAndApplyVertices(vertices);
	}

	private async authenticateAndApplyVertices(vertices: Vertex[]): Promise<ApplyResult> {
		const { authenticated, occurrences } = classifyNovelVertices(
			vertices,
			(hash) =>
				hash === HashGraph.rootHash ||
				this.hashGraph.vertices.has(hash) ||
				this.authenticatedHistoryHashes?.has(hash) === true
		);
		const compactAdmission =
			this.authenticatedHistoryHashes === undefined
				? { executable: authenticated, unavailable: [] }
				: this.classifyCompactAdmission(authenticated);
		const applied =
			compactAdmission.executable.length === 0
				? { applied: true, invalid: [], missing: [] }
				: await this._applier.applyVertices(compactAdmission.executable);
		if (compactAdmission.unavailable.length !== 0) {
			applied.applied = false;
			applied.missing.push(...compactAdmission.unavailable);
		}
		const result = !occurrences.some(({ status }) => status === "invalid")
			? applied
			: {
					...applied,
					applied: false,
					invalid: orderAuthenticatedVertexFailures(occurrences, authenticated, applied.invalid),
				};
		if (this.authenticatedHistoryHashes !== undefined) {
			let admitted = false;
			for (const { hash } of this.hashGraph.getAllVertices()) {
				if (this.authenticatedHistoryHashes.has(hash)) continue;
				this.authenticatedHistoryHashes.add(hash);
				admitted = true;
			}
			this._applier.compactPayloadHistory();
			if (admitted) this.historyRevision++;
		}
		return result;
	}

	private classifyCompactAdmission(authenticated: readonly AuthenticatedVertex[]): {
		executable: AuthenticatedVertex[];
		unavailable: Hash[];
	} {
		const frontier = new Set(this.hashGraph.getFrontier());
		const offered = new Map<Hash, AuthenticatedVertex>();
		for (const handle of authenticated) {
			const vertex = resolveAuthenticatedVertex(handle);
			if (vertex !== undefined) offered.set(vertex.hash, handle);
		}
		const memo = new Map<Hash, Set<Hash> | undefined>();
		const visiting = new Set<Hash>();
		const coverage = (hash: Hash): Set<Hash> | undefined => {
			if (frontier.has(hash)) return new Set([hash]);
			if (memo.has(hash)) return memo.get(hash);
			if (visiting.has(hash)) return undefined;
			const handle = offered.get(hash);
			const vertex = handle === undefined ? undefined : resolveAuthenticatedVertex(handle);
			if (vertex === undefined) return undefined;
			visiting.add(hash);
			const covered = new Set<Hash>();
			for (const dependency of vertex.dependencies) {
				const dependencyCoverage = coverage(dependency);
				if (dependencyCoverage === undefined) {
					visiting.delete(hash);
					memo.set(hash, undefined);
					return undefined;
				}
				for (const head of dependencyCoverage) covered.add(head);
			}
			visiting.delete(hash);
			memo.set(hash, covered);
			return covered;
		};

		const executable: AuthenticatedVertex[] = [];
		const unavailable: Hash[] = [];
		for (const handle of authenticated) {
			const vertex = resolveAuthenticatedVertex(handle);
			if (vertex === undefined) continue;
			const covered = coverage(vertex.hash);
			if (covered !== undefined && frontier.size === covered.size && [...frontier].every((hash) => covered.has(hash))) {
				executable.push(handle);
			} else {
				unavailable.push(vertex.hash);
			}
		}
		return { executable, unavailable };
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
		const result = await this.authenticateAndApplyVertices(vertices);
		return [result.applied, result.missing, result.invalid];
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
