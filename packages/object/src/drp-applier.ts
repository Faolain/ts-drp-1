import { Logger } from "@ts-drp/logger";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	type ApplyResult,
	type DRPState,
	DrpType,
	type FinalityConfig,
	type Hash,
	type IACL,
	type IDRP,
	type IHashGraph,
	type LoggerOptions,
	type ReplicaMode,
	type Vertex,
} from "@ts-drp/types";
import { handlePromiseOrValue, processSequentially } from "@ts-drp/utils";
import {
	InvalidDependenciesError,
	InvalidHashError,
	InvalidTimestampError,
	isReceiverClockPendingValidationResult,
	validateVertex,
} from "@ts-drp/validation";

import { isObjectACLDeterministicError } from "./acl/errors.js";
import { readClockPendingProvenance, recordClockPendingProvenance } from "./clock-pending-provenance.js";
import { AdoptionCommitExhaustedError, ApplyInvariantError } from "./errors.js";
import { FinalityStore } from "./finality/index.js";
import { type FrontierRestorePoint, HashGraph } from "./hashgraph/index.js";
import {
	type BaseOperation,
	MAX_ADOPTION_COMMIT_ATTEMPTS,
	type Operation,
	type OperationJournal,
	type PostLCAOperation,
	type PostOperation,
	type PostSplitOperation,
	type ReplayState,
} from "./operation.js";
import { createPipeline, type Pipeline } from "./pipeline/pipeline.js";
import { type HandlerReturn } from "./pipeline/types.js";
import { DRPProxy, type DRPProxyChainArgs, LocalMutationLane, trackMutations } from "./proxy.js";
import {
	type ComparisonEvent,
	createPublicationCapability,
	type PublicationCapability,
} from "./publication/copy-capability.js";
import {
	type LinearizationCheckpoint,
	type PublicationObserverEvent,
	PublicationPublisher,
	type PublicationRecord,
	type SnapshotSide,
} from "./publication/publisher.js";
import {
	cloneEnumerableExecutionInstance,
	DRPObjectStateManager,
	REPLICA_LOCAL_STATE_KEYS,
} from "./state-materialize.js";
import {
	borrowedStateEntry,
	createStatePayloadDetacher,
	defineEnumerableOwnData,
	detachReplicaLocalContext,
	detachStatePayload,
	readEnumerableStateValue,
} from "./state-payload.js";
import {
	type AuthenticatedVertex,
	hasAuthenticatedVertexProvenance,
	orderAuthenticatedVertexFailures,
	resolveAuthenticatedVertex,
	type VertexAuthenticationOccurrence,
} from "./vertex-authentication.js";

export type { AuthenticatedVertex } from "./vertex-authentication.js";

// Bound rejected-hash memory per object; oldest entries are evicted first.
const MAX_KNOWN_INVALID_VERTEX_HASHES = 10_000;
const MAX_CLOCK_PENDING_VERTEX_HASHES = 10_000;
const DEFAULT_CHECKPOINT_SUFFIX_SIZE = 256;
const MAX_APPLICATION_ATTEMPTS_PER_OFFER = 3;
const metrics = new OpentelemetryMetrics("@ts-drp/object/drp-applier");

class DeterministicRejectionError extends Error {}

class ReceiverClockPendingValidationError extends Error {
	constructor(readonly vertex: Vertex) {
		super(`Vertex ${vertex.hash} is pending receiver-clock validation`);
	}
}

class AttributedDeterministicRejectionError extends DeterministicRejectionError {
	readonly vertexHash: Hash;

	constructor(vertexHash: Hash, cause: unknown) {
		super(`Deterministic ACL replay rejected vertex ${vertexHash}`, { cause });
		this.vertexHash = vertexHash;
	}
}

class UndoJournal implements OperationJournal {
	private undoSteps: (() => void)[] = [];

	record(undo: () => void): void {
		this.undoSteps.push(undo);
	}

	commit(): void {
		this.undoSteps.length = 0;
	}

	rollback(): void {
		let rollbackError: unknown;
		for (let index = this.undoSteps.length - 1; index >= 0; index--) {
			try {
				this.undoSteps[index]();
			} catch (error) {
				rollbackError ??= error;
			}
		}
		this.undoSteps.length = 0;
		if (rollbackError !== undefined) throw rollbackError;
	}
}

/** Bounded insertion-ordered hash memory; insertion of a new hash evicts the oldest. */
class BoundedHashMemory implements Iterable<Hash> {
	private readonly hashes = new Set<Hash>();

	constructor(private readonly maximumSize: number) {}

	get size(): number {
		return this.hashes.size;
	}

	has(hash: Hash): boolean {
		return this.hashes.has(hash);
	}

	delete(hash: Hash): boolean {
		return this.hashes.delete(hash);
	}

	remember(hash: Hash): void {
		if (this.hashes.has(hash)) return;
		this.hashes.add(hash);
		if (this.hashes.size <= this.maximumSize) return;
		const oldest = this.hashes.values().next().value;
		if (oldest !== undefined) this.hashes.delete(oldest);
	}

	*[Symbol.iterator](): IterableIterator<Hash> {
		yield* this.hashes;
	}
}

function isDeterministicVertexFailure(error: unknown): boolean {
	return (
		error instanceof DeterministicRejectionError ||
		isObjectACLDeterministicError(error) ||
		error instanceof InvalidDependenciesError ||
		error instanceof InvalidHashError ||
		error instanceof InvalidTimestampError
	);
}

function isApplicationRetryBarrier(error: unknown): boolean {
	return (
		error instanceof AdoptionCommitExhaustedError ||
		error instanceof ApplyInvariantError ||
		error instanceof ReceiverClockPendingValidationError ||
		isDeterministicVertexFailure(error)
	);
}

interface PreparedAdoption<T extends IDRP> {
	expectedFrontier: Hash[];
	drp?: T;
	acl?: IACL;
	nextHint?: AdoptionHint<T>;
	forceCheckpoint?: boolean;
	canonicalBaseline?: ReplayState;
	canonicalState?: ReplayState;
}

interface AdoptionHint<T extends IDRP> {
	expectedFrontier: Hash[];
	causalHead: Hash;
	drpType?: string;
	replayRequiresConflictResolution: boolean;
	tail?: Vertex[];
	canonicalDRP?: T;
	canonicalACL?: IACL;
}

interface ApplyCallContext {
	hint?: AdoptionHint<IDRP>;
}

type JournaledOperation<T extends IDRP, Op extends Operation<T> = Operation<T>> = Op & {
	journal: OperationJournal;
};

type CommitOperation<T extends IDRP> = JournaledOperation<T, PostOperation<T>>;

interface CommitResult<T extends IDRP> extends PostOperation<T> {
	commitOutcome: "committed" | "duplicate" | "retry";
}

interface BatchVertexPreflight {
	submittedVertex: Vertex;
	operationSnapshot: { succeeded: true; operation: Vertex["operation"] } | { succeeded: false; error: unknown };
}

function captureBatchVertexOperation(submittedVertex: Vertex): BatchVertexPreflight {
	try {
		return {
			submittedVertex,
			operationSnapshot: { succeeded: true, operation: detachStatePayload(submittedVertex.operation) },
		};
	} catch (error) {
		return { submittedVertex, operationSnapshot: { succeeded: false, error } };
	}
}

function snapshotSubmittedVertex(vertex: Vertex, operation: Vertex["operation"]): Vertex {
	const hash = vertex.hash;
	const peerId = vertex.peerId;
	const dependencies = [...vertex.dependencies];
	const timestamp = vertex.timestamp;
	const signature = new Uint8Array(vertex.signature);
	return { hash, peerId, operation, dependencies, timestamp, signature };
}

function descriptorsEqual(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (
		left.configurable !== right.configurable ||
		left.enumerable !== right.enumerable ||
		("writable" in left && left.writable !== right.writable)
	) {
		return false;
	}
	if ("value" in left || "value" in right) {
		return "value" in left && "value" in right && Object.is(left.value, right.value);
	}
	return left.get === right.get && left.set === right.set;
}

function recordPropertyMutation<T extends object>(
	target: T,
	key: string,
	previous: PropertyDescriptor | undefined,
	journal: OperationJournal
): void {
	const applied = Reflect.getOwnPropertyDescriptor(target, key);
	journal.record(() => {
		if (!descriptorsEqual(Reflect.getOwnPropertyDescriptor(target, key), applied)) return;
		if (previous) Reflect.defineProperty(target, key, previous);
		else Reflect.deleteProperty(target, key);
	});
}

function applicationSetter(prototype: object | undefined, key: string): ((value: unknown) => void) | undefined {
	if (prototype === undefined || key === "__proto__") return undefined;
	let current: object | null = prototype;
	while (current !== null && current !== Object.prototype) {
		const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) return "set" in descriptor ? descriptor.set : undefined;
		current = Reflect.getPrototypeOf(current) as object | null;
	}
	return undefined;
}

function cloneEnumerableInstance(target: object): Map<PropertyKey, PropertyDescriptor> {
	const snapshot = new Map<PropertyKey, PropertyDescriptor>();
	for (const key of Reflect.ownKeys(target)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (descriptor === undefined) continue;
		if ("value" in descriptor && typeof descriptor.value !== "function") {
			descriptor.value = REPLICA_LOCAL_STATE_KEYS.has(key as string)
				? detachReplicaLocalContext(descriptor.value)
				: detachStatePayload(descriptor.value);
		}
		snapshot.set(key, descriptor);
	}
	return snapshot;
}

function recordSetterRollback(target: object, journal: OperationJournal): void {
	const before = cloneEnumerableInstance(target);
	const beforeKeys = [...before.keys()];
	const beforePrototype = Reflect.getPrototypeOf(target);
	journal.record(() => {
		for (const key of Reflect.ownKeys(target)) {
			if (!before.has(key) && !Reflect.deleteProperty(target, key)) {
				throw new TypeError(`Cannot roll back added state property ${String(key)}`);
			}
		}
		const remainingKeys = Reflect.ownKeys(target);
		if (remainingKeys.length !== beforeKeys.length || remainingKeys.some((key, index) => key !== beforeKeys[index])) {
			for (const key of remainingKeys) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
				if (descriptor?.configurable && !Reflect.deleteProperty(target, key)) {
					throw new TypeError(`Cannot restore state property order for ${String(key)}`);
				}
			}
		}
		for (const [key, descriptor] of before) {
			if (!Reflect.defineProperty(target, key, descriptor)) {
				throw new TypeError(`Cannot roll back state property ${String(key)}`);
			}
		}
		const restoredKeys = Reflect.ownKeys(target);
		if (restoredKeys.length !== beforeKeys.length || restoredKeys.some((key, index) => key !== beforeKeys[index])) {
			throw new TypeError("Cannot restore state property order");
		}
		if (Reflect.getPrototypeOf(target) !== beforePrototype && !Reflect.setPrototypeOf(target, beforePrototype)) {
			throw new TypeError("Cannot restore state prototype");
		}
	});
}

function replaceEnumerableState<T extends object>(
	target: T,
	source: T,
	keys: ReadonlySet<string>,
	prototype: object | undefined,
	journal: OperationJournal
): void {
	const orderedSourceKeys = Object.keys(source);
	const sourceKeys = new Set(orderedSourceKeys);
	const detachBorrowed = createStatePayloadDetacher();
	const setters = new Map<string, (value: unknown) => void>();
	for (const key of keys) {
		if (!sourceKeys.has(key)) continue;
		const setter = applicationSetter(prototype, key);
		if (setter !== undefined) setters.set(key, setter);
	}
	// A setter may mutate any part of the live instance. Capture one detached
	// pre-image before replacement starts so its rollback authority cannot be
	// based on backing properties that earlier replacement keys already changed.
	// Ordinary replacements avoid this whole-instance copy.
	if (setters.size !== 0) recordSetterRollback(target, journal);
	for (const key of keys) {
		if (sourceKeys.has(key)) continue;
		const previous = Reflect.getOwnPropertyDescriptor(target, key);
		if (previous !== undefined) {
			if (!Reflect.deleteProperty(target, key)) throw new TypeError(`Cannot delete state property ${key}`);
			recordPropertyMutation(target, key, previous, journal);
		}
	}

	for (const key of orderedSourceKeys) {
		if (!keys.has(key)) continue;
		let value = readEnumerableStateValue(source, key);
		if (typeof value === "function") continue;
		if (borrowedStateEntry(source, key) !== undefined) value = detachBorrowed(value);
		const setter = setters.get(key);
		if (setter !== undefined) {
			Reflect.apply(setter, target, [value]);
			continue;
		}
		const previous = Reflect.getOwnPropertyDescriptor(target, key);
		defineEnumerableOwnData(target, key, value);
		recordPropertyMutation(target, key, previous, journal);
	}
}

function reconcileEnumerableStateOrder<T extends object>(target: T, source: T, journal: OperationJournal): void {
	const desired = Object.keys(source).filter(
		(key) => !REPLICA_LOCAL_STATE_KEYS.has(key) && Reflect.getOwnPropertyDescriptor(target, key)?.enumerable === true
	);
	const desiredKeys = new Set(desired);
	const current = Object.keys(target).filter((key) => !REPLICA_LOCAL_STATE_KEYS.has(key) && desiredKeys.has(key));
	if (current.length === desired.length && current.every((key, index) => key === desired[index])) return;

	const descriptors = desired.map((key) => {
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (descriptor === undefined || !descriptor.configurable)
			throw new TypeError(`Cannot reorder state property ${key}`);
		return { descriptor, key };
	});
	for (const { key } of descriptors) {
		const previous = Reflect.getOwnPropertyDescriptor(target, key);
		if (previous === undefined || !Reflect.deleteProperty(target, key)) {
			throw new TypeError(`Cannot reorder state property ${key}`);
		}
		recordPropertyMutation(target, key, previous, journal);
	}
	for (const { descriptor, key } of descriptors) {
		const previous = Reflect.getOwnPropertyDescriptor(target, key);
		if (!Reflect.defineProperty(target, key, descriptor)) throw new TypeError(`Cannot reorder state property ${key}`);
		recordPropertyMutation(target, key, previous, journal);
	}
}

function canonicalReplacementKeys(previous: DRPState, next: DRPState): Set<string> {
	const previousEntries = new Map(previous.state.map((entry) => [entry.key, entry]));
	const nextEntries = new Map(next.state.map((entry) => [entry.key, entry]));
	const keys = new Set<string>();
	for (const key of new Set([...previousEntries.keys(), ...nextEntries.keys()])) {
		if (previousEntries.get(key) !== nextEntries.get(key)) keys.add(key);
	}
	return keys;
}

function checkpointSuffixSizeFromEnvironment(): number {
	const configured = typeof process === "undefined" ? undefined : process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
	if (configured === undefined) return DEFAULT_CHECKPOINT_SUFFIX_SIZE;

	const parsed = Number(configured);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECKPOINT_SUFFIX_SIZE;
}

interface DRPVertexApplierBase<T extends IDRP> {
	drp?: T;
	acl: IACL;
	hashGraph: IHashGraph;
	finalityStore?: FinalityStore;
	replicaMode?: ReplicaMode;
	allowLocalAuthorship?: boolean;
	states: DRPObjectStateManager<T>;
	logConfig?: LoggerOptions;
	finalityConfig?: FinalityConfig;
	notify(origin: string, vertices: Vertex[]): void;
	publicationObserver?(event: PublicationObserverEvent): unknown;
	comparisonObserver?(event: ComparisonEvent): unknown;
}

interface DRPVertexApplierOptions<T extends IDRP>
	extends Omit<DRPVertexApplierBase<T>, "states" | "finalityStore" | "notify"> {
	states?: DRPObjectStateManager<T>;
	finalityStore?: FinalityStore;
	notify?(origin: string, vertices: Vertex[]): void;
}

/**
 * Applies vertices to the hash graph
 * @template T - The type of the DRP object
 */
export class DRPVertexApplier<T extends IDRP> {
	protected readonly hashGraph: IHashGraph;
	protected readonly states: DRPObjectStateManager<T>;

	private _proxyDRP?: DRPProxy<T>;
	private _proxyACL: DRPProxy<IACL>;
	private readonly drpApplicationPrototype?: object;
	private readonly aclApplicationPrototype: object;

	private applyVertexPipeline: Pipeline<BaseOperation, PostOperation<T>>;
	private readonly optionalFinalityStore?: FinalityStore;
	private readonly replicaMode: ReplicaMode;
	private _notify: (origin: string, vertices: Vertex[]) => void;
	private log: Logger;
	private readonly knownInvalidVertexHashes = new BoundedHashMemory(MAX_KNOWN_INVALID_VERTEX_HASHES);
	// This remembers only hashes classified by the receiver-clock error or their
	// dependency closure. Eviction may degrade a later descendant to ordinary
	// bounded missing recovery, but never to terminal-invalid accounting.
	private readonly clockPendingVertexHashes = new BoundedHashMemory(MAX_CLOCK_PENDING_VERTEX_HASHES);
	private checkpoints: LinearizationCheckpoint[];
	private readonly checkpointSuffixSize = checkpointSuffixSizeFromEnvironment();
	private readonly notificationQueue: { origin: string; vertices: Vertex[] }[] = [];
	private isDrainingNotifications = false;
	private readonly publicationPublisher: PublicationPublisher<T>;
	private readonly publicationCapability: PublicationCapability;
	private liveCanonicalState: { aclState: DRPState; drpState: DRPState };

	/**
	 * Creates a new DRPVertexApplier
	 * @param options - The options for the DRPVertexApplier
	 * @param options.drp - The DRP object
	 * @param options.acl - The ACL object
	 * @param options.hashGraph - The hash graph
	 * @param options.states - The state manager for the DRP object. If not provided, a new one will be created.
	 * @param options.finalityStore - The finality store
	 * @param options.replicaMode - Whether this replica retains writer-only state
	 * @param options.allowLocalAuthorship - Whether local operations may enter the authoring lane
	 * @param options.notify - The notify function
	 * @param options.logConfig - The log config
	 * @param options.publicationObserver - Optional deterministic publication-work observer
	 * @param options.comparisonObserver - Optional pure comparison-work observer
	 */
	constructor({
		drp,
		acl,
		hashGraph,
		states,
		finalityStore,
		replicaMode = "writer",
		notify,
		logConfig,
		publicationObserver,
		comparisonObserver,
		allowLocalAuthorship = true,
	}: DRPVertexApplierBase<T>) {
		this.hashGraph = hashGraph;
		this.states = states;
		this.drpApplicationPrototype = drp ? (Reflect.getPrototypeOf(drp) as object) : undefined;
		this.aclApplicationPrototype = Reflect.getPrototypeOf(acl) as object;
		this.optionalFinalityStore = finalityStore;
		this.replicaMode = replicaMode;
		this._notify = notify;
		this.log = new Logger("drp::object::operation", logConfig);
		const [drpState, aclState] = [states.getDRPState(HashGraph.rootHash), states.getACLState(HashGraph.rootHash)];
		if (!drpState || !aclState) throw new Error("Root state snapshots are missing");
		this.liveCanonicalState = { aclState, drpState };
		this.checkpoints = [
			{
				frontier: [HashGraph.rootHash],
				origin: HashGraph.rootHash,
				vertexCount: 1,
				state: { drpState, aclState },
			},
		];

		const callFnPipeline = createPipeline(this.createVertex.bind(this)) // this is there but not in applies
			.setNext(this.validateVertex.bind(this))
			.setNext(this.getLCA.bind(this))
			.setNext(this.splitLCAOperation.bind(this))
			.setNext(this.computeOperation.bind(this))
			.setNext(this.validateWriterPermission.bind(this))
			.setNext(this.applyFn.bind(this))
			.setNext(this.equal.bind(this)) // in callFn but not in applyVertex
			.setNext(this.commitPreparedState.bind(this));

		this.applyVertexPipeline = createPipeline(this.validateVertex.bind(this))
			.setNext(this.getLCA.bind(this))
			.setNext(this.splitLCAOperation.bind(this))
			.setNext(this.computeOperation.bind(this))
			.setNext(this.validateWriterPermission.bind(this))
			.setNext(this.applyFn.bind(this));

		const localMutationLane = new LocalMutationLane();
		const localMutationDeniedReason = allowLocalAuthorship
			? undefined
			: "Compact history observers cannot author local operations";
		this._proxyACL = new DRPProxy(acl, callFnPipeline, DrpType.ACL, localMutationLane, localMutationDeniedReason);
		if (drp) {
			this._proxyDRP = new DRPProxy(drp, callFnPipeline, DrpType.DRP, localMutationLane, localMutationDeniedReason);
		}
		this.publicationCapability = createPublicationCapability(publicationObserver, comparisonObserver ?? null);
		this.publicationPublisher = new PublicationPublisher(
			{
				acl: this.acl,
				drp: this.drp,
				hashGraph: this.hashGraph as IHashGraph & Pick<HashGraph, "hasCustomConflictResolver">,
				states: this.states,
				checkpoints: this.checkpoints,
				checkpointSuffixSize: this.checkpointSuffixSize,
				rootHash: HashGraph.rootHash,
			},
			this.publicationCapability
		);
	}

	private get finalityStore(): FinalityStore {
		if (this.optionalFinalityStore === undefined) {
			throw new Error("Observer replicas do not support finalityStore access");
		}
		return this.optionalFinalityStore;
	}

	/**
	 * Get the DRP object
	 * @returns The DRP object
	 */
	get drp(): T | undefined {
		return this._proxyDRP?.proxy;
	}

	/**
	 * Get the ACL object
	 * @returns The ACL object
	 */
	get acl(): IACL {
		return this._proxyACL.proxy;
	}

	/**
	 * Rebinds delivery after an independently verified runtime is atomically adopted.
	 * @param notify - Owning object's notification callback
	 */
	setNotify(notify: (origin: string, vertices: Vertex[]) => void): void {
		this._notify = notify;
	}

	/**
	 * Releases graph payload/index history behind the authenticated frontier.
	 * Live canonical state remains the execution base; only complete root/frontier
	 * Vertex payloads remain locally available.
	 * @returns Complete payload hashes retained by the graph
	 */
	compactPayloadHistory(): Hash[] {
		const retainedPayloadHashes = (this.hashGraph as HashGraph).compactPayloadHistory();
		this.states.prune(new Set([HashGraph.rootHash]));
		const frontier = this.hashGraph.getFrontier();
		this.checkpoints.splice(0, this.checkpoints.length, {
			frontier,
			origin: frontier[0] ?? HashGraph.rootHash,
			state: this.liveCanonicalState,
			vertexCount: retainedPayloadHashes.length,
		});
		return retainedPayloadHashes;
	}

	/**
	 * Apply the vertices to the hash graph
	 * @param vertices - The vertices to apply
	 * @returns The result of the apply
	 */
	async applyVertices(vertices: AuthenticatedVertex[]): Promise<ApplyResult> {
		const authenticated: AuthenticatedVertex[] = [];
		const occurrences: VertexAuthenticationOccurrence[] = [];
		for (const vertex of vertices) {
			if (!hasAuthenticatedVertexProvenance(vertex)) {
				let hash: string;
				try {
					hash = vertex.hash;
				} catch {
					hash = "<unreadable-vertex>";
				}
				occurrences.push({ hash, status: "invalid" });
				continue;
			}
			const canonical = resolveAuthenticatedVertex(vertex);
			if (canonical === undefined) {
				occurrences.push({ hash: "<lost-provenance>", status: "invalid" });
				continue;
			}
			authenticated.push(canonical);
			occurrences.push({ authenticatedIndex: authenticated.length - 1, status: "authenticated" });
		}
		const applied = await this.applyAuthenticatedVertices(authenticated);
		if (!occurrences.some(({ status }) => status === "invalid")) return applied;
		const result: ApplyResult = {
			...applied,
			applied: false,
			invalid: orderAuthenticatedVertexFailures(occurrences, authenticated, applied.invalid),
		};
		recordClockPendingProvenance(result, readClockPendingProvenance(applied));
		return result;
	}

	private async applyAuthenticatedVertices(vertices: AuthenticatedVertex[]): Promise<ApplyResult> {
		if (!isTracingEnabled()) return this.applyVerticesUntraced(vertices);

		return metrics.traceFunc(
			"drp.applyVertices",
			(batch: AuthenticatedVertex[]) => this.applyVerticesUntraced(batch),
			(span, batch) => {
				span.setAttribute("drp.vertex.count", batch.length);
			},
			(span, result) => {
				span.setAttribute("drp.vertex.missing_count", result.missing.length);
				span.setAttribute("drp.vertex.invalid_count", result.invalid.length);
			}
		)(vertices);
	}

	private async applyVerticesUntraced(vertices: AuthenticatedVertex[]): Promise<ApplyResult> {
		const submittedVertices = [...vertices];
		const worklist = submittedVertices.filter(
			(submittedVertex): submittedVertex is AuthenticatedVertex => submittedVertex !== undefined
		);
		const preflightByIdentity = new WeakMap<Vertex, BatchVertexPreflight>();
		const preflight = worklist.map((submittedVertex) => {
			const captured = preflightByIdentity.get(submittedVertex);
			if (captured) return captured;

			const record = captureBatchVertexOperation(submittedVertex);
			preflightByIdentity.set(submittedVertex, record);
			return record;
		});
		return this.applyVerticesCall(preflight, {});
	}

	private async applyVerticesCall(
		vertices: BatchVertexPreflight[],
		callContext: ApplyCallContext
	): Promise<ApplyResult> {
		const missing: Hash[] = [];
		const invalid: Hash[] = [];
		const quarantined: Hash[] = [];
		const clockPending = new Set<Hash>();
		const missingVertices = new Map<Hash, Vertex>();
		const batchInvalidVertexHashes = new Set<Hash>();
		for (const { submittedVertex, operationSnapshot } of vertices) {
			const submittedHash = submittedVertex.hash;
			if (this.hashGraph.vertices.has(submittedHash)) continue;

			let stableVertex: Vertex | undefined;
			try {
				if (!operationSnapshot.succeeded) throw operationSnapshot.error;
				stableVertex = snapshotSubmittedVertex(submittedVertex, operationSnapshot.operation);
				if (!stableVertex.operation) {
					this.log.warn("Vertex has no operation", stableVertex);
					continue;
				}
				if (stableVertex.operation.opType === "-1") {
					if (stableVertex.hash === HashGraph.rootHash) continue;
					invalid.push(stableVertex.hash);
					batchInvalidVertexHashes.add(stableVertex.hash);
					this.rememberInvalidVertexHash(stableVertex.hash);
					continue;
				}
				for (let attempt = 1; attempt <= MAX_APPLICATION_ATTEMPTS_PER_OFFER; attempt++) {
					try {
						// Re-entering the complete pipeline reconstructs the candidate
						// state for every attempt. A rejected application promise can
						// therefore never carry partial candidate mutations forward.
						const operation = await this.applyVertexPipeline.execute({
							vertex: stableVertex,
							isACL: stableVertex.operation.drpType === DrpType.ACL,
						});
						await this.commitPreparedVertex(operation, callContext);
						break;
					} catch (error) {
						if (isApplicationRetryBarrier(error) || attempt === MAX_APPLICATION_ATTEMPTS_PER_OFFER) {
							throw error;
						}
					}
				}
			} catch (error) {
				const rejectedHash = stableVertex?.hash ?? submittedHash;
				if (error instanceof AdoptionCommitExhaustedError) {
					error.partialResult = this.createApplyResult(missing, invalid, [...quarantined, rejectedHash]);
					this.publishClockPendingProvenance(error.partialResult, missingVertices, clockPending);
					recordClockPendingProvenance(error, readClockPendingProvenance(error.partialResult));
					throw error;
				}
				if (error instanceof ApplyInvariantError) {
					error.partialResult = this.createApplyResult(missing, invalid, [...quarantined, rejectedHash]);
					this.publishClockPendingProvenance(error.partialResult, missingVertices, clockPending);
					recordClockPendingProvenance(error, readClockPendingProvenance(error.partialResult));
					throw error;
				}
				if (error instanceof ReceiverClockPendingValidationError) {
					missing.push(error.vertex.hash);
					missingVertices.set(error.vertex.hash, error.vertex);
					clockPending.add(error.vertex.hash);
					this.clockPendingVertexHashes.remember(error.vertex.hash);
					continue;
				}
				const dependsOnClockPending = stableVertex?.dependencies.some(
					(dependency) => clockPending.has(dependency) || this.clockPendingVertexHashes.has(dependency)
				);
				if (error instanceof InvalidDependenciesError && dependsOnClockPending && stableVertex !== undefined) {
					missing.push(stableVertex.hash);
					missingVertices.set(stableVertex.hash, stableVertex);
					clockPending.add(stableVertex.hash);
					this.clockPendingVertexHashes.remember(stableVertex.hash);
					continue;
				}

				const rejectedVertex = stableVertex;
				const unresolvedDependencies =
					rejectedVertex?.dependencies.filter((dependency) => !this.hashGraph.vertices.has(dependency)) ?? [];
				const isDeterministicFailure = isDeterministicVertexFailure(error);
				if (!isDeterministicFailure) {
					quarantined.push(rejectedHash);
					continue;
				}

				const attributedHash = error instanceof AttributedDeterministicRejectionError ? error.vertexHash : rejectedHash;
				if (error instanceof AttributedDeterministicRejectionError && attributedHash !== rejectedHash) {
					// Attribution and the caller's verdict answer different
					// questions. Remember the committed vertex that actually
					// threw, but reject the submitted vertex: result.invalid
					// must never name a graph member, and descendants need a
					// terminal parent tombstone instead of endless recovery.
					batchInvalidVertexHashes.add(attributedHash);
					this.rememberInvalidVertexHash(attributedHash);
					invalid.push(rejectedHash);
					batchInvalidVertexHashes.add(rejectedHash);
					this.rememberInvalidVertexHash(rejectedHash);
					continue;
				}

				const allUnresolvedDependenciesAreInvalid =
					unresolvedDependencies.length !== 0 &&
					unresolvedDependencies.every((dependency) => this.knownInvalidVertexHashes.has(dependency));
				// Validation is fail-fast (hash before dependencies), so a bad-hash + missing-dependency vertex is invalid.
				const hasGenuinelyMissingDependency =
					error instanceof InvalidDependenciesError &&
					unresolvedDependencies.length !== 0 &&
					!allUnresolvedDependenciesAreInvalid;
				if (hasGenuinelyMissingDependency) {
					missing.push(rejectedHash);
					if (rejectedVertex) missingVertices.set(rejectedHash, rejectedVertex);
				} else {
					invalid.push(attributedHash);
					batchInvalidVertexHashes.add(attributedHash);
					this.rememberInvalidVertexHash(attributedHash);
				}
			}
		}

		for (let iteration = 0; iteration < vertices.length; iteration++) {
			const newlyInvalid = missing.filter((hash) => {
				const vertex = missingVertices.get(hash);
				if (!vertex) return false;

				const unresolvedDependencies = vertex.dependencies.filter(
					(dependency) => !this.hashGraph.vertices.has(dependency)
				);
				return (
					unresolvedDependencies.length !== 0 &&
					unresolvedDependencies.every(
						(dependency) => this.knownInvalidVertexHashes.has(dependency) || batchInvalidVertexHashes.has(dependency)
					)
				);
			});
			if (newlyInvalid.length === 0) break;

			const newlyInvalidHashes = new Set(newlyInvalid);
			for (const hash of newlyInvalid) {
				invalid.push(hash);
				batchInvalidVertexHashes.add(hash);
				missingVertices.delete(hash);
				this.rememberInvalidVertexHash(hash);
			}
			for (let index = missing.length - 1; index >= 0; index--) {
				if (newlyInvalidHashes.has(missing[index])) missing.splice(index, 1);
			}
		}

		const result = this.createApplyResult(missing, invalid, quarantined);
		this.publishClockPendingProvenance(result, missingVertices, clockPending);
		return result;
	}

	private publishClockPendingProvenance(
		target: object,
		missingVertices: ReadonlyMap<Hash, Vertex>,
		seeds: ReadonlySet<Hash>
	): void {
		const result = target as ApplyResult;
		const missingHashes = new Set(result.missing);
		const pending = new Set([...seeds].filter((hash) => missingHashes.has(hash)));
		for (let iteration = 0; iteration < result.missing.length; iteration++) {
			let changed = false;
			for (const hash of result.missing) {
				if (pending.has(hash)) continue;
				const vertex = missingVertices.get(hash);
				if (vertex === undefined || !vertex.dependencies.some((dependency) => pending.has(dependency))) continue;
				pending.add(hash);
				changed = true;
			}
			if (!changed) break;
		}
		const authenticatedPending = result.missing.filter((hash) => pending.has(hash));
		for (const hash of authenticatedPending) this.clockPendingVertexHashes.remember(hash);
		recordClockPendingProvenance(target, authenticatedPending);
	}

	private createApplyResult(missing: Hash[], invalid: Hash[], quarantined: Hash[]): ApplyResult {
		const normalize = (hashes: Hash[], excluded: ReadonlySet<Hash>): Hash[] => {
			const normalized: Hash[] = [];
			const seen = new Set<Hash>();
			for (const hash of hashes) {
				if (this.hashGraph.vertices.has(hash)) {
					this.knownInvalidVertexHashes.delete(hash);
					continue;
				}
				if (excluded.has(hash) || seen.has(hash)) continue;
				seen.add(hash);
				normalized.push(hash);
			}
			return normalized;
		};
		const normalizedInvalid = normalize(invalid, new Set());
		const invalidHashes = new Set(normalizedInvalid);
		const normalizedQuarantined = normalize(quarantined, invalidHashes);
		const rejectedHashes = new Set([...invalidHashes, ...normalizedQuarantined]);
		const normalizedMissing = normalize(missing, rejectedHashes);
		const result: ApplyResult = {
			applied: normalizedMissing.length === 0 && normalizedInvalid.length === 0 && normalizedQuarantined.length === 0,
			missing: normalizedMissing,
			invalid: normalizedInvalid,
		};
		if (normalizedQuarantined.length !== 0) result.quarantined = normalizedQuarantined;
		return result;
	}

	private rememberInvalidVertexHash(hash: Hash): void {
		this.clockPendingVertexHashes.delete(hash);
		this.knownInvalidVertexHashes.remember(hash);
	}

	private async commitPreparedVertex(operation: PostOperation<T>, callContext: ApplyCallContext): Promise<boolean> {
		for (let attempt = 1; attempt <= MAX_ADOPTION_COMMIT_ATTEMPTS; attempt++) {
			if (this.hashGraph.vertices.has(operation.vertex.hash)) return false;
			const expectedFrontier = this.hashGraph.getFrontier();
			let adoption: PreparedAdoption<T>;
			if (this.descendsFromWholeFrontier(operation.vertex, expectedFrontier)) {
				callContext.hint = undefined;
				adoption = this.prepareLinearAdoption(operation, expectedFrontier);
			} else if (this.canUseAdoptionHint(operation, expectedFrontier, callContext.hint)) {
				adoption = await this.prepareHintedAdoption(operation, expectedFrontier, callContext.hint);
			} else {
				callContext.hint = undefined;
				adoption = await this.prepareConcurrentAdoption(operation, expectedFrontier);
			}
			const outcome = this.tryCommitPreparedVertex(operation, adoption);
			if (outcome === "committed") {
				callContext.hint = adoption.nextHint as AdoptionHint<IDRP> | undefined;
				return true;
			}
			if (outcome === "duplicate") {
				callContext.hint = undefined;
				return false;
			}
			callContext.hint = undefined;
		}
		if (this.hashGraph.vertices.has(operation.vertex.hash)) return false;
		throw new AdoptionCommitExhaustedError(operation.vertex.hash, MAX_ADOPTION_COMMIT_ATTEMPTS);
	}

	private canUseAdoptionHint(
		operation: PostOperation<T>,
		expectedFrontier: Hash[],
		hint: AdoptionHint<IDRP> | undefined
	): hint is AdoptionHint<T> {
		if (!hint || !sameHashes(expectedFrontier, hint.expectedFrontier)) return false;
		if (operation.vertex.operation?.drpType !== hint.drpType) return false;
		if (operation.vertex.dependencies.length !== 1 || operation.vertex.dependencies[0] !== hint.causalHead) {
			return false;
		}
		// The hinted replay is extended by one child of the same type as its
		// resolver-free causal head, so the extension cannot introduce a
		// resolver-bearing vertex that was absent from the recorded subgraph.
		return !hint.replayRequiresConflictResolution;
	}

	private async prepareHintedAdoption(
		operation: PostOperation<T>,
		expectedFrontier: Hash[],
		hint: AdoptionHint<T>
	): Promise<PreparedAdoption<T>> {
		if (hint.canonicalACL) {
			const acl = cloneEnumerableExecutionInstance(hint.canonicalACL);
			const drp = hint.canonicalDRP ? cloneEnumerableExecutionInstance(hint.canonicalDRP) : undefined;
			const target = operation.isACL ? acl : drp;
			if (target) {
				await (operation.isACL
					? applyDeterministicReplayVertices(target, [operation.vertex])
					: applyVertices(target, [operation.vertex]));
			}
			return {
				expectedFrontier,
				drp,
				acl,
				nextHint: this.createCanonicalAdoptionHint(
					operation.vertex,
					expectedFrontier,
					drp,
					acl,
					hint.replayRequiresConflictResolution
				),
			};
		}
		if (!operation.currentDRP || !hint.tail) {
			throw new ApplyInvariantError([new Error("Prepared operation state is missing")], "Adoption hint is invalid");
		}
		const adopted = cloneEnumerableExecutionInstance(operation.currentDRP);
		await (operation.isACL ? applyDeterministicReplayVertices(adopted, hint.tail) : applyVertices(adopted, hint.tail));
		const nextHint = this.createTailAdoptionHint(
			operation.vertex,
			expectedFrontier,
			hint.tail,
			hint.replayRequiresConflictResolution
		);
		return operation.isACL
			? { expectedFrontier, acl: adopted as IACL, nextHint }
			: { expectedFrontier, drp: adopted as T, nextHint };
	}

	private descendsFromWholeFrontier(vertex: Vertex, expectedFrontier: Hash[]): boolean {
		const dependencies = new Set(vertex.dependencies);
		return expectedFrontier.every((hash) => dependencies.has(hash));
	}

	private prepareLinearAdoption(operation: PostOperation<T>, expectedFrontier: Hash[]): PreparedAdoption<T> {
		if (operation.isACL) {
			return {
				expectedFrontier,
				acl: operation.currentDRP as IACL,
			};
		}
		return {
			expectedFrontier,
			drp: operation.currentDRP as T | undefined,
		};
	}

	private async prepareConcurrentAdoption(
		operation: PostOperation<T>,
		expectedFrontier: Hash[]
	): Promise<PreparedAdoption<T>> {
		const { vertex } = operation;
		const dependencies = new Set(vertex.dependencies);
		const candidateFrontier = expectedFrontier.filter((hash) => !dependencies.has(hash));
		candidateFrontier.push(vertex.hash);
		const replay = this.getReplay(candidateFrontier, vertex);
		const incremental = await this.prepareConcurrentTailAdoption(operation, expectedFrontier, replay);
		if (incremental) return incremental;

		const [drpVertices, aclVertices] = splitOperation(replay.linearizedVertices);
		const [drp, acl] = this.states.fromStatesForExecution(
			replay.state.drpState,
			replay.state.aclState,
			this.drp?.context,
			this.acl.context
		);
		await applyDeterministicReplayVertices(acl, aclVertices);
		if (drp && this.drp) await applyVertices(drp, drpVertices);
		const drpType = vertex.operation?.drpType;
		const sameTypeVertices = replay.linearizedVertices.filter((candidate) => candidate.operation?.drpType === drpType);
		const pendingIndex = sameTypeVertices.findIndex((candidate) => candidate.hash === vertex.hash);
		const nextHint =
			pendingIndex === sameTypeVertices.length - 1 && !replay.requiresConflictResolution
				? this.createCanonicalAdoptionHint(vertex, expectedFrontier, drp, acl, replay.requiresConflictResolution)
				: undefined;
		return {
			expectedFrontier,
			drp,
			acl,
			nextHint,
			// A root replay has already paid the batch ceiling. Pin its canonical
			// result immediately so later arrivals can extend that causal cut.
			forceCheckpoint: replay.origin === HashGraph.rootHash,
		};
	}

	private async prepareConcurrentTailAdoption(
		operation: PostOperation<T>,
		expectedFrontier: Hash[],
		replay: { linearizedVertices: Vertex[]; requiresConflictResolution: boolean }
	): Promise<PreparedAdoption<T> | undefined> {
		const { vertex } = operation;
		const drpType = vertex.operation?.drpType;
		if (replay.requiresConflictResolution) return undefined;

		const sameTypeVertices = replay.linearizedVertices.filter((candidate) => candidate.operation?.drpType === drpType);
		const pendingIndex = sameTypeVertices.findIndex((candidate) => candidate.hash === vertex.hash);
		if (pendingIndex <= 0 || !operation.currentDRP) return undefined;

		const causalHashes = this.collectCausalHashes(vertex.dependencies);
		if (sameTypeVertices.slice(0, pendingIndex).some((candidate) => !causalHashes.has(candidate.hash))) {
			return undefined;
		}

		const adopted = cloneEnumerableExecutionInstance(operation.currentDRP);
		const tail = sameTypeVertices.slice(pendingIndex + 1);
		await (operation.isACL ? applyDeterministicReplayVertices(adopted, tail) : applyVertices(adopted, tail));
		const nextHint = this.createTailAdoptionHint(vertex, expectedFrontier, tail, replay.requiresConflictResolution);
		return operation.isACL
			? { expectedFrontier, acl: adopted as IACL, nextHint }
			: { expectedFrontier, drp: adopted as T, nextHint };
	}

	private createTailAdoptionHint(
		vertex: Vertex,
		expectedFrontier: Hash[],
		tail: Vertex[],
		replayRequiresConflictResolution: boolean
	): AdoptionHint<T> {
		return {
			expectedFrontier: this.frontierAfter(vertex, expectedFrontier),
			causalHead: vertex.hash,
			drpType: vertex.operation?.drpType,
			replayRequiresConflictResolution,
			tail,
		};
	}

	private createCanonicalAdoptionHint(
		vertex: Vertex,
		expectedFrontier: Hash[],
		drp: T | undefined,
		acl: IACL,
		replayRequiresConflictResolution: boolean
	): AdoptionHint<T> {
		return {
			expectedFrontier: this.frontierAfter(vertex, expectedFrontier),
			causalHead: vertex.hash,
			drpType: vertex.operation?.drpType,
			replayRequiresConflictResolution,
			canonicalDRP: drp,
			canonicalACL: acl,
		};
	}

	private frontierAfter(vertex: Vertex, expectedFrontier: Hash[]): Hash[] {
		const dependencies = new Set(vertex.dependencies);
		const nextFrontier = expectedFrontier.filter((hash) => !dependencies.has(hash));
		nextFrontier.push(vertex.hash);
		return nextFrontier;
	}

	private collectCausalHashes(dependencies: Hash[]): Set<Hash> {
		const causalHashes = new Set<Hash>();
		const stack = [...dependencies];
		while (stack.length > 0) {
			const hash = stack.pop();
			if (hash === undefined || causalHashes.has(hash)) continue;
			causalHashes.add(hash);
			for (const dependency of this.hashGraph.vertices.get(hash)?.dependencies ?? []) stack.push(dependency);
		}
		return causalHashes;
	}

	private tryCommitPreparedVertex(
		operation: PostOperation<T>,
		preparedAdoption: PreparedAdoption<T>
	): "committed" | "duplicate" | "retry" {
		return this.commitPreparedState(operation, preparedAdoption).result.commitOutcome;
	}

	private commitPreparedState(
		operation: PostOperation<T>,
		preparedAdoption?: PreparedAdoption<T>
	): HandlerReturn<CommitResult<T>> {
		const adoption =
			preparedAdoption ??
			(operation.isACL
				? {
						expectedFrontier: operation.vertex.dependencies,
						acl: operation.currentDRP as IACL | undefined,
					}
				: {
						expectedFrontier: operation.vertex.dependencies,
						drp: operation.currentDRP as T | undefined,
					});
		const complete = (commitOutcome: "committed" | "duplicate" | "retry"): HandlerReturn<CommitResult<T>> => ({
			stop: commitOutcome !== "committed",
			result: {
				...operation,
				commitOutcome,
			},
		});
		if (this.hashGraph.vertices.has(operation.vertex.hash)) return complete("duplicate");
		const expectedFrontier = adoption.expectedFrontier;
		const publicationFrontier = this.hashGraph.getFrontier();
		if (!sameHashes(publicationFrontier, expectedFrontier)) return complete("retry");

		// This journal is born, used, and closed in one synchronous section after
		// the vertex's final await. No rollback authority crosses a suspension.
		const journal = new UndoJournal();
		const commitOperation: CommitOperation<T> = { ...operation, journal };
		const publicationAttempts: PublicationRecord[] = [];
		try {
			adoption.canonicalBaseline = this.liveCanonicalState;
			this.assignState(commitOperation, adoption, publicationAttempts, publicationFrontier);
			const publishedACLState = this.states.getACLState(operation.vertex.hash);
			const publishedDRPState = this.states.getDRPState(operation.vertex.hash);
			if (!publishedACLState || !publishedDRPState) {
				throw new Error("Published vertex state is missing");
			}
			const nextCanonicalState = adoption.canonicalState;
			if (nextCanonicalState === undefined) throw new Error("Canonical live state is missing");
			const aclReplacementKeys = canonicalReplacementKeys(
				this.liveCanonicalState.aclState,
				nextCanonicalState.aclState
			);
			const drpReplacementKeys = canonicalReplacementKeys(
				this.liveCanonicalState.drpState,
				nextCanonicalState.drpState
			);
			this.initializeFinalityStore(commitOperation);
			this.addVertexToHashGraph(commitOperation);
			if (adoption.acl) {
				replaceEnumerableState(this.acl, adoption.acl, aclReplacementKeys, this.aclApplicationPrototype, journal);
				reconcileEnumerableStateOrder(this.acl, adoption.acl, journal);
			}
			if (adoption.drp && this.drp) {
				replaceEnumerableState(this.drp, adoption.drp, drpReplacementKeys, this.drpApplicationPrototype, journal);
				reconcileEnumerableStateOrder(this.drp, adoption.drp, journal);
			}
			this.publicationPublisher.withCanonicalCheckpointState(nextCanonicalState, () => {
				this.advanceCheckpointIfNeeded(journal, adoption.forceCheckpoint, publicationAttempts);
			});
			this.discardOrdinaryObserverSnapshots(commitOperation, {
				aclState: publishedACLState,
				drpState: publishedDRPState,
			});
			journal.commit();
			this.liveCanonicalState = nextCanonicalState;
			this.publicationPublisher.reportPublications(publicationAttempts, "published");
			this.knownInvalidVertexHashes.delete(operation.vertex.hash);
			this.clockPendingVertexHashes.delete(operation.vertex.hash);
			this.enqueueNotification(operation.isLocal ? "callFn" : "merge", [operation.vertex]);
			return complete("committed");
		} catch (error) {
			try {
				journal.rollback();
			} catch (rollbackError) {
				this.publicationPublisher.reportPublications(publicationAttempts, "rolled-back");
				throw new ApplyInvariantError(
					[error, rollbackError],
					"Vertex commit failed and its synchronous rollback was incomplete"
				);
			}
			this.publicationPublisher.reportPublications(publicationAttempts, "rolled-back");
			throw error;
		}
	}

	private createVertex({ prop: opType, args: value, type: drpType }: DRPProxyChainArgs): HandlerReturn<BaseOperation> {
		return {
			stop: false,
			result: {
				// Vertex payloads are immutable history. Detach them from caller-owned
				// objects before hashing and storing the operation.
				vertex: this.hashGraph.createVertex({ drpType, opType, value: detachStatePayload(value) }),
				isACL: drpType === DrpType.ACL,
				isLocal: true,
			},
		};
	}

	private validateVertex(operation: BaseOperation): HandlerReturn<BaseOperation> {
		const { vertex } = operation;
		const result = validateVertex(vertex, this.hashGraph, Date.now(), {
			skipHashValidation: operation.isLocal === true,
		});
		if (result.error) {
			if (isReceiverClockPendingValidationResult(result)) {
				throw new ReceiverClockPendingValidationError(vertex);
			}
			throw result.error;
		}
		return { stop: false, result: operation };
	}

	private getLCA(operation: BaseOperation): HandlerReturn<PostLCAOperation> {
		const { vertex } = operation;
		if (
			vertex.dependencies.length === 1 &&
			this.states.getDRPState(vertex.dependencies[0]) !== undefined &&
			this.states.getACLState(vertex.dependencies[0]) !== undefined
		) {
			return {
				stop: false,
				result: { ...operation, lcaResult: { lca: vertex.dependencies[0], linearizedVertices: [] } },
			};
		}
		const dependency = vertex.dependencies.length === 1 ? vertex.dependencies[0] : undefined;
		if (
			this.replicaMode === "observer" &&
			vertex.dependencies.length !== 0 &&
			sameHashes(this.hashGraph.getFrontier(), vertex.dependencies)
		) {
			return {
				stop: false,
				result: {
					...operation,
					lcaResult: { lca: dependency ?? vertex.dependencies[0] ?? HashGraph.rootHash, linearizedVertices: [] },
					replayState: this.liveCanonicalState,
				},
			};
		}
		const replay = this.getReplay(vertex.dependencies);
		return {
			stop: false,
			result: {
				...operation,
				lcaResult: { lca: replay.origin, linearizedVertices: replay.linearizedVertices },
				replayState: replay.state,
			},
		};
	}

	private splitLCAOperation(operation: PostLCAOperation): HandlerReturn<PostSplitOperation> {
		const {
			lcaResult: { linearizedVertices },
		} = operation;
		const [drp, acl] = splitOperation(linearizedVertices);
		return { stop: false, result: { ...operation, aclVertices: acl, drpVertices: drp } };
	}

	private computeOperation(
		operation: PostSplitOperation
	): HandlerReturn<Operation<T>> | Promise<HandlerReturn<Operation<T>>> {
		if (!isTracingEnabled()) return this.computeOperationUntraced(operation);

		return metrics.traceFunc(
			"drp.computeOperation",
			(candidate: PostSplitOperation) => this.computeOperationUntraced(candidate),
			(span, candidate) => {
				span.setAttribute("drp.replay.suffix_size", candidate.drpVertices.length + candidate.aclVertices.length);
				// At this layer, a hit means replay starts from stored checkpoint state.
				span.setAttribute("drp.checkpoint.hit", candidate.replayState !== undefined);
			}
		)(operation);
	}

	private computeOperationUntraced(
		operation: PostSplitOperation
	): HandlerReturn<Operation<T>> | Promise<HandlerReturn<Operation<T>>> {
		const {
			lcaResult: { lca },
			drpVertices,
			aclVertices,
			isACL,
			replayState,
		} = operation;
		let pair: [T | undefined, IACL];
		if (replayState) {
			pair = this.states.fromStatesForExecution(
				replayState.drpState,
				replayState.aclState,
				this.drp?.context,
				this.acl.context
			);
		} else {
			pair = this.states.fromHashForExecution(
				lca,
				drpVertices.length + aclVertices.length,
				this.drp?.context,
				this.acl.context
			);
		}
		const [drp, acl] = pair;
		applyDeterministicReplayVertices(acl, aclVertices);

		if (!drp) {
			return {
				stop: false,
				result: { ...operation, acl, currentDRP: isACL ? acl : undefined },
			};
		}

		const p = applyVertices(drp, drpVertices);
		return handlePromiseOrValue(p, () => {
			return {
				stop: false,
				result: {
					...operation,
					drp,
					acl,
					// Reconstructed replay instances are already detached from live
					// state and snapshots, so they are safe mutation staging areas.
					currentDRP: isACL ? acl : drp,
				},
			};
		});
	}

	private getReplay(
		dependencies: Hash[],
		pendingVertex?: Vertex
	): {
		origin: Hash;
		state: ReplayState;
		linearizedVertices: Vertex[];
		requiresConflictResolution: boolean;
	} {
		for (let index = this.checkpoints.length - 1; index >= 0; index--) {
			const checkpoint = this.checkpoints[index];
			if (!this.dependenciesCoverEveryHead(dependencies, checkpoint.frontier, pendingVertex)) {
				continue;
			}
			const subgraph = this.collectSuffixSubgraph(dependencies, checkpoint.frontier, checkpoint.origin, pendingVertex);
			if (subgraph === undefined) continue;
			return {
				origin: checkpoint.origin,
				state: checkpoint.state,
				requiresConflictResolution: this.replayRequiresConflictResolution(checkpoint.origin, subgraph, pendingVertex),
				linearizedVertices: pendingVertex
					? (this.hashGraph as HashGraph).linearizeVerticesWith(pendingVertex, checkpoint.origin, subgraph)
					: this.hashGraph.linearizeVertices(checkpoint.origin, subgraph),
			};
		}
		throw new Error("No valid linearization checkpoint");
	}

	private replayRequiresConflictResolution(origin: Hash, subgraph: Set<Hash>, pendingVertex?: Vertex): boolean {
		for (const hash of subgraph) {
			if (hash === origin) continue;
			const drpType = this.getVertexForReplay(hash, pendingVertex)?.operation?.drpType;
			if ((this.hashGraph as HashGraph).hasCustomConflictResolver(drpType)) return true;
		}
		return false;
	}

	private dependenciesCoverEveryHead(dependencies: Hash[], boundary: Hash[], pendingVertex?: Vertex): boolean {
		const dependencySet = new Set(dependencies);
		if (dependencySet.size === boundary.length && boundary.every((hash) => dependencySet.has(hash))) return true;

		for (const descendant of dependencies) {
			const remaining = new Set(boundary);
			const visited = new Set<Hash>();
			const stack = [descendant];
			while (stack.length > 0 && remaining.size > 0) {
				const hash = stack.pop();
				if (hash === undefined || visited.has(hash)) continue;
				visited.add(hash);
				remaining.delete(hash);
				for (const dependency of this.getVertexForReplay(hash, pendingVertex)?.dependencies ?? []) {
					stack.push(dependency);
				}
			}
			if (remaining.size !== 0) return false;
		}
		return true;
	}

	/**
	 * Collects a replay suffix only when every member descends from every cut head.
	 * @param dependencies - Target frontier hashes
	 * @param boundary - Checkpoint frontier hashes
	 * @param origin - Checkpoint linearization origin
	 * @param pendingVertex - Optional uncommitted overlay vertex
	 * @returns The strict replay suffix, or undefined when the cut is not a barrier
	 */
	private collectSuffixSubgraph(
		dependencies: Hash[],
		boundary: Hash[],
		origin: Hash,
		pendingVertex?: Vertex
	): Set<Hash> | undefined {
		const boundarySet = new Set(boundary);
		const subgraph = new Set<Hash>([origin]);
		const visited = new Set<Hash>();
		const stack = [...dependencies];
		while (stack.length > 0) {
			const hash = stack.pop();
			if (hash === undefined || visited.has(hash)) continue;
			visited.add(hash);
			if (boundarySet.has(hash)) continue;
			subgraph.add(hash);
			for (const dependency of this.getVertexForReplay(hash, pendingVertex)?.dependencies ?? []) {
				stack.push(dependency);
			}
		}

		const suffixMembers = [...subgraph].filter((hash) => hash !== origin);
		for (const head of boundary) {
			const reachable = new Set<Hash>();
			const forwardStack = [head];
			while (forwardStack.length > 0) {
				const hash = forwardStack.pop();
				if (hash === undefined || reachable.has(hash)) continue;
				reachable.add(hash);
				for (const child of this.getChildrenForReplay(hash, pendingVertex)) {
					if (boundarySet.has(child) || subgraph.has(child)) forwardStack.push(child);
				}
			}
			if (suffixMembers.some((hash) => !reachable.has(hash))) return undefined;
		}
		return subgraph;
	}

	private getVertexForReplay(hash: Hash, pendingVertex?: Vertex): Vertex | undefined {
		return pendingVertex?.hash === hash ? pendingVertex : this.hashGraph.vertices.get(hash);
	}

	private getChildrenForReplay(hash: Hash, pendingVertex?: Vertex): Hash[] {
		const children = this.hashGraph.forwardEdges.get(hash) ?? [];
		if (!pendingVertex?.dependencies.includes(hash) || children.includes(pendingVertex.hash)) return children;
		return [...children, pendingVertex.hash];
	}

	private advanceCheckpointIfNeeded(
		journal: OperationJournal,
		force = false,
		publicationAttempts: PublicationRecord[] = []
	): void {
		this.publicationPublisher.advanceCheckpointIfNeeded(journal, force, publicationAttempts);
	}

	private capturePublishedState(
		side: SnapshotSide,
		instance: IDRP | undefined,
		baseline: DRPState | undefined,
		publication: PublicationRecord,
		incremental: boolean,
		candidateKeys?: ReadonlySet<string>
	): DRPState {
		return this.publicationPublisher.capturePublishedState(
			side,
			instance,
			baseline,
			publication,
			incremental,
			candidateKeys
		);
	}

	private validateWriterPermission(operation: Operation<T>): HandlerReturn<Operation<T>> {
		const {
			acl,
			vertex: { peerId },
			isACL,
		} = operation;
		if (isACL) return { stop: false, result: operation };

		const isWriter = acl.query_isWriter(peerId);
		if (!isWriter) throw new DeterministicRejectionError("Not a writer " + peerId);
		return { stop: false, result: operation };
	}

	private applyFn(
		drpOperation: Operation<T>
	): HandlerReturn<PostOperation<T>> | Promise<HandlerReturn<PostOperation<T>>> {
		const {
			currentDRP,
			vertex: { peerId, operation },
		} = drpOperation;

		if (!operation) throw new Error("Operation is undefined");

		const { opType, value } = operation;

		if (!currentDRP) {
			return { stop: false, result: { ...drpOperation, result: undefined, stateChanged: false } };
		}

		const tracked = trackMutations(currentDRP, (left, right, key) =>
			this.publicationCapability.equal(left, right, {
				publicationId: drpOperation.vertex.hash,
				phase: "proxy-tracking",
				side: drpOperation.isACL ? "acl" : "drp",
				key,
			})
		);

		return handlePromiseOrValue(
			callDRP(tracked.proxy, peerId, opType, value),
			(result): HandlerReturn<PostOperation<T>> => {
				tracked.observeRawEgressBoundary();
				return {
					stop: false,
					result: {
						...drpOperation,
						result,
						stateChanged: tracked.hasChanges(),
						mutatedKeys: [...tracked.changedKeys()],
						rawEgress: tracked.hasRawEgress()
							? {
									side: drpOperation.isACL ? "acl" : "drp",
									candidateKeys: [...tracked.rawEgressCandidateKeys()],
								}
							: undefined,
					},
				};
			}
		);
	}

	private equal(operation: PostOperation<T>): HandlerReturn<PostOperation<T>> {
		if (operation.currentDRP === undefined) return { stop: false, result: operation };
		return { stop: operation.stateChanged !== true, result: operation };
	}

	private assignState(
		operation: JournaledOperation<T>,
		adoption: PreparedAdoption<T> = operation.isACL
			? {
					expectedFrontier: operation.vertex.dependencies,
					acl: operation.currentDRP as IACL | undefined,
				}
			: {
					expectedFrontier: operation.vertex.dependencies,
					drp: operation.currentDRP as T | undefined,
				},
		publicationAttempts: PublicationRecord[] = [],
		publicationFrontier: Hash[] = this.hashGraph.getFrontier()
	): void {
		this.publicationPublisher.assignState(operation, adoption, publicationAttempts, publicationFrontier);
	}

	private addVertexToHashGraph(operation: JournaledOperation<T>): void {
		const { vertex, journal } = operation;
		const dependencySet = new Set(vertex.dependencies);
		const frontierBefore = this.hashGraph.frontier;
		const frontierRestorePoints: FrontierRestorePoint[] = [];
		for (let index = 0; index < frontierBefore.length; index++) {
			const hash = frontierBefore[index];
			if (!dependencySet.has(hash)) continue;
			frontierRestorePoints.push({
				hash,
				previous: frontierBefore[index - 1],
				next: frontierBefore[index + 1],
				wasFirst: index === 0,
			});
		}
		this.hashGraph.addVertex(vertex);
		journal.record(() => {
			(this.hashGraph as IHashGraph & Pick<HashGraph, "removeVertex">).removeVertex(vertex, frontierRestorePoints);
		});
	}

	private initializeFinalityStore(operation: JournaledOperation<T>): void {
		const finalityStore = this.optionalFinalityStore;
		if (!finalityStore?.enabled) return;
		const { vertex, acl, currentDRP, isACL, journal } = operation;
		const finalitySigners = isACL ? currentDRP?.query_getFinalitySigners() : acl.query_getFinalitySigners();
		const previous = finalityStore.states.get(vertex.hash);
		finalityStore.initializeState(vertex.hash, finalitySigners);
		const initialized = finalityStore.states.get(vertex.hash);
		if (!previous && initialized) {
			journal.record(() => {
				if (finalityStore.states.get(vertex.hash) === initialized) {
					finalityStore.states.delete(vertex.hash);
				}
			});
		}
	}

	private discardOrdinaryObserverSnapshots(
		operation: JournaledOperation<T>,
		state: { aclState: DRPState; drpState: DRPState }
	): void {
		if (this.replicaMode !== "observer") return;
		const { vertex, journal } = operation;
		if (this.checkpoints.some(({ frontier }) => frontier.includes(vertex.hash))) return;

		if (!this.states.deleteACLState(vertex.hash, state.aclState)) {
			throw new Error("Observer ACL snapshot was replaced before release");
		}
		journal.record(() => {
			if (this.states.getACLState(vertex.hash) === undefined) {
				this.states.setACLState(vertex.hash, state.aclState);
			}
		});
		if (!this.states.deleteDRPState(vertex.hash, state.drpState)) {
			throw new Error("Observer DRP snapshot was replaced before release");
		}
		journal.record(() => {
			if (this.states.getDRPState(vertex.hash) === undefined) {
				this.states.setDRPState(vertex.hash, state.drpState);
			}
		});
	}

	private enqueueNotification(origin: string, vertices: Vertex[]): void {
		this.notificationQueue.push({ origin, vertices });
		this.drainNotifications();
	}

	private drainNotifications(): void {
		if (this.isDrainingNotifications) return;

		this.isDrainingNotifications = true;
		try {
			while (this.notificationQueue.length > 0) {
				const notification = this.notificationQueue.shift();
				if (!notification) continue;
				try {
					this._notify(notification.origin, notification.vertices);
				} catch (error) {
					this.log.error("Subscriber notification failed", error);
				}
			}
		} finally {
			this.isDrainingNotifications = false;
		}
	}
}

/**
 * Creates a DRPVertexApplier
 * @param options - The options for the DRPVertexApplier
 * @returns The DRPVertexApplier
 */
export function createDRPVertexApplier<T extends IDRP>(
	options: DRPVertexApplierOptions<T>
): [DRPVertexApplier<T>, DRPObjectStateManager<T>] {
	if (!options.acl) {
		throw new Error("ACL is undefined");
	}
	if (!options.hashGraph) {
		throw new Error("hashGraph is undefined");
	}
	const states = options.states ?? new DRPObjectStateManager(options.acl, options.drp);
	const finalityStore =
		options.finalityStore ??
		(options.replicaMode === "observer" ? undefined : new FinalityStore(options.finalityConfig, options.logConfig));

	const obj = new DRPVertexApplier({
		...options,
		acl: options.acl,
		hashGraph: options.hashGraph,
		states,
		finalityStore,
		notify: options.notify ?? ((): void => {}),
	});

	return [obj, states];
}

function callDRP<T extends IDRP>(drp: T, caller: string, method: string, args: unknown[]): unknown | Promise<unknown> {
	let owner: object | null = drp;
	while (owner && !Object.hasOwn(owner, method)) owner = Reflect.getPrototypeOf(owner);
	if (!owner) throw new DeterministicRejectionError(`Unknown DRP operation ${method}`);

	const isPlatformSurface = owner === Object.prototype || owner === Function.prototype;
	const isClassConstructor = method === "constructor" && owner !== drp;
	const deterministicOnThrow = isPlatformSurface || isClassConstructor;
	let operation: unknown;
	try {
		operation = Reflect.get(drp, method);
	} catch (error) {
		if (deterministicOnThrow) {
			throw new DeterministicRejectionError(`Rejected non-application DRP operation ${method}`, { cause: error });
		}
		throw error;
	}
	if (typeof operation !== "function") {
		throw new DeterministicRejectionError(`Unknown DRP operation ${method}`);
	}
	if (drp.context) drp.context.caller = caller;

	// A DRP may retain or mutate an argument. Never let application state alias
	// the immutable operation payload that will be replayed by other replicas.
	try {
		return Reflect.apply(operation, drp, detachStatePayload(args));
	} catch (error) {
		if (deterministicOnThrow) {
			throw new DeterministicRejectionError(`Rejected non-application DRP operation ${method}`, { cause: error });
		}
		throw error;
	}
}

function applyVertex<T extends IDRP>(drp: T, vertex: Vertex): unknown | Promise<unknown> {
	const { operation, peerId } = vertex;
	if (!operation) throw new Error("Operation is undefined");

	return callDRP(drp, peerId, operation.opType, operation.value);
}

function applyVertices<T extends IDRP>(drp: T, vertices: Vertex[]): unknown | Promise<unknown> {
	return processSequentially(vertices, (drp, v) => applyVertex(drp, v), drp);
}

/**
 * Replays ACL vertices one at a time so a typed built-in rejection retains the
 * hash that actually threw. Untyped custom ACL failures remain retriable.
 * @param acl - Reconstructed ACL replay target
 * @param vertices - Canonically ordered ACL vertices
 * @returns The replay result
 */
function applyDeterministicReplayVertices(acl: IDRP, vertices: Vertex[]): unknown | Promise<unknown> {
	const applyAttributed = (target: IDRP, vertex: Vertex): unknown | Promise<unknown> => {
		const classify = (error: unknown): never => {
			if (error instanceof AttributedDeterministicRejectionError) throw error;
			if (error instanceof DeterministicRejectionError || isObjectACLDeterministicError(error)) {
				throw new AttributedDeterministicRejectionError(vertex.hash, error);
			}
			throw error;
		};

		try {
			const result = applyVertex(target, vertex);
			if (result instanceof Promise) return result.catch(classify);
			return result;
		} catch (error) {
			return classify(error);
		}
	};
	return processSequentially(vertices, (target, vertex) => applyAttributed(target, vertex), acl);
}

function splitOperation(vertices: Vertex[]): [Vertex[], Vertex[]] {
	const drpVertices: Vertex[] = [];
	const aclVertices: Vertex[] = [];

	for (const v of vertices) {
		if (!v.operation) {
			continue;
		}

		if (v.operation?.drpType === DrpType.DRP) {
			drpVertices.push(v);
			continue;
		}
		aclVertices.push(v);
	}

	return [drpVertices, aclVertices];
}

function sameHashes(left: Hash[], right: Hash[]): boolean {
	return left.length === right.length && left.every((hash, index) => hash === right[index]);
}
