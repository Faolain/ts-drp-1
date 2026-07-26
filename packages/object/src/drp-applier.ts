import { Logger } from "@ts-drp/logger";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	type ApplyResult,
	DrpType,
	type FinalityConfig,
	type Hash,
	type IACL,
	type IDRP,
	type IHashGraph,
	type LoggerOptions,
	type Vertex,
} from "@ts-drp/types";
import { handlePromiseOrValue, processSequentially } from "@ts-drp/utils";
import { InvalidDependenciesError, InvalidHashError, InvalidTimestampError, validateVertex } from "@ts-drp/validation";
import { cloneDeep } from "es-toolkit";

import { isObjectACLDeterministicError } from "./acl/errors.js";
import { FinalityStore } from "./finality/index.js";
import { type FrontierRestorePoint, HashGraph } from "./hashgraph/index.js";
import {
	type BaseOperation,
	type Operation,
	type OperationJournal,
	type PostLCAOperation,
	type PostOperation,
	type PostSplitOperation,
	type ReplayState,
} from "./operation.js";
import { createPipeline, type Pipeline } from "./pipeline/pipeline.js";
import { type HandlerReturn } from "./pipeline/types.js";
import { DRPProxy, type DRPProxyChainArgs, trackMutations } from "./proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "./state.js";

// Bound rejected-hash memory per object; oldest entries are evicted first.
const MAX_KNOWN_INVALID_VERTEX_HASHES = 10_000;
const DEFAULT_CHECKPOINT_SUFFIX_SIZE = 256;
const MAX_CHECKPOINTS = 32;
const MAX_ADOPTION_COMMIT_ATTEMPTS = 3;
const metrics = new OpentelemetryMetrics("@ts-drp/object/drp-applier");

class DeterministicRejectionError extends Error {}

class AttributedDeterministicRejectionError extends DeterministicRejectionError {
	readonly vertexHash: Hash;

	constructor(vertexHash: Hash, cause: unknown) {
		super(`Deterministic ACL replay rejected vertex ${vertexHash}`, { cause });
		this.vertexHash = vertexHash;
	}
}

export class AdoptionCommitExhaustedError extends Error {
	readonly vertexHash: Hash;
	readonly attempts: number;

	constructor(vertexHash: Hash, attempts: number) {
		super(`Failed to commit vertex ${vertexHash} after ${attempts} frontier CAS attempts`);
		this.name = "AdoptionCommitExhaustedError";
		this.vertexHash = vertexHash;
		this.attempts = attempts;
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

/**
 * Bounded insertion-ordered memory for deterministic vertex rejections.
 * Transient application failures never enter this set.
 */
class KnownInvalidHashes implements Iterable<Hash> {
	private readonly hashes = new Set<Hash>();

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
		if (this.hashes.size <= MAX_KNOWN_INVALID_VERTEX_HASHES) return;
		const oldest = this.hashes.values().next().value;
		if (oldest !== undefined) this.hashes.delete(oldest);
	}

	*[Symbol.iterator](): IterableIterator<Hash> {
		yield* this.hashes;
	}
}

class ApplyInvariantError extends AggregateError {
	partialResult?: ApplyResult;
}

interface PreparedAdoption<T extends IDRP> {
	expectedFrontier: Hash[];
	drp?: T;
	acl?: IACL;
	nextHint?: AdoptionHint<T>;
	forceCheckpoint?: boolean;
	skipCheckpoint?: boolean;
	restoresCanonicalState?: boolean;
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
	canDeferReconciliation: boolean;
	deferRemainingVertices: boolean;
	needsFullReconciliation: boolean;
	notificationsDeferred: boolean;
	hint?: AdoptionHint<IDRP>;
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
	journal?: OperationJournal
): void {
	if (!journal) return;
	const applied = Reflect.getOwnPropertyDescriptor(target, key);
	journal.record(() => {
		if (!descriptorsEqual(Reflect.getOwnPropertyDescriptor(target, key), applied)) return;
		if (previous) Reflect.defineProperty(target, key, previous);
		else Reflect.deleteProperty(target, key);
	});
}

function replaceEnumerableState<T extends object>(target: T, source: T, journal?: OperationJournal): void {
	const targetRecord = target as Record<string, unknown>;
	const sourceRecord = source as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		if (typeof targetRecord[key] !== "function" && !Object.hasOwn(source, key)) {
			const previous = Reflect.getOwnPropertyDescriptor(target, key);
			if (!Reflect.deleteProperty(target, key)) throw new TypeError(`Cannot delete state property ${key}`);
			recordPropertyMutation(target, key, previous, journal);
		}
	}
	for (const key of Object.keys(source)) {
		if (typeof sourceRecord[key] !== "function") {
			const previous = Reflect.getOwnPropertyDescriptor(target, key);
			if (!Reflect.set(target, key, sourceRecord[key])) throw new TypeError(`Cannot assign state property ${key}`);
			recordPropertyMutation(target, key, previous, journal);
		}
	}
}

function cloneEnumerableInstance<T extends object>(source: T): T {
	const clone = Object.create(Reflect.getPrototypeOf(source)) as T;
	const sourceRecord = source as Record<string, unknown>;
	const cloneRecord = clone as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (typeof sourceRecord[key] !== "function") cloneRecord[key] = cloneDeep(sourceRecord[key]);
	}
	return clone;
}

function checkpointSuffixSizeFromEnvironment(): number {
	const configured = typeof process === "undefined" ? undefined : process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
	if (configured === undefined) return DEFAULT_CHECKPOINT_SUFFIX_SIZE;

	const parsed = Number(configured);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECKPOINT_SUFFIX_SIZE;
}

interface LinearizationCheckpoint {
	frontier: Hash[];
	origin: Hash;
	vertexCount: number;
	state: ReplayState;
}

interface DRPVertexApplierBase<T extends IDRP> {
	drp?: T;
	acl: IACL;
	hashGraph: IHashGraph;
	finalityStore: FinalityStore;
	states: DRPObjectStateManager<T>;
	logConfig?: LoggerOptions;
	finalityConfig?: FinalityConfig;
	notify(origin: string, vertices: Vertex[]): void;
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

	private applyVertexPipeline: Pipeline<BaseOperation, PostOperation<T>>;
	private readonly finalityStore: FinalityStore;
	private _notify: (origin: string, vertices: Vertex[]) => void;
	private log: Logger;
	private readonly knownInvalidVertexHashes = new KnownInvalidHashes();
	private checkpoints: LinearizationCheckpoint[];
	private readonly checkpointSuffixSize = checkpointSuffixSizeFromEnvironment();
	private readonly notificationQueue: { origin: string; vertices: Vertex[] }[] = [];
	private isDrainingNotifications = false;
	private notificationDeferralDepth = 0;
	private hasUnreconciledLiveState = false;

	/**
	 * Creates a new DRPVertexApplier
	 * @param options - The options for the DRPVertexApplier
	 * @param options.drp - The DRP object
	 * @param options.acl - The ACL object
	 * @param options.hashGraph - The hash graph
	 * @param options.states - The state manager for the DRP object. If not provided, a new one will be created.
	 * @param options.finalityStore - The finality store
	 * @param options.notify - The notify function
	 * @param options.logConfig - The log config
	 */
	constructor({ drp, acl, hashGraph, states, finalityStore, notify, logConfig }: DRPVertexApplierBase<T>) {
		this.hashGraph = hashGraph;
		this.states = states;
		this.finalityStore = finalityStore;
		this._notify = notify;
		this.log = new Logger("drp::object::operation", logConfig);
		const [drpState, aclState] = [states.getDRPState(HashGraph.rootHash), states.getACLState(HashGraph.rootHash)];
		if (!drpState || !aclState) throw new Error("Root state snapshots are missing");
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
			.setNext(this.assign.bind(this))
			.setNext(this.assignState.bind(this))
			.setNext(this.addVertexToHashGraph.bind(this))
			.setNext(this.initializeFinalityStore.bind(this))
			.setNext(this.notify.bind(this)); // in callFn but not in applyVertex

		this.applyVertexPipeline = createPipeline(this.validateVertex.bind(this))
			.setNext(this.getLCA.bind(this))
			.setNext(this.splitLCAOperation.bind(this))
			.setNext(this.computeOperation.bind(this))
			.setNext(this.validateWriterPermission.bind(this))
			.setNext(this.applyFn.bind(this));

		this._proxyACL = new DRPProxy(acl, callFnPipeline, DrpType.ACL);
		if (drp) {
			this._proxyDRP = new DRPProxy(drp, callFnPipeline, DrpType.DRP);
		}
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
	 * Apply the vertices to the hash graph
	 * @param vertices - The vertices to apply
	 * @returns The result of the apply
	 */
	async applyVertices(vertices: Vertex[]): Promise<ApplyResult> {
		if (!isTracingEnabled()) return this.applyVerticesUntraced(vertices);

		return metrics.traceFunc(
			"drp.applyVertices",
			(batch: Vertex[]) => this.applyVerticesUntraced(batch),
			(span, batch) => {
				span.setAttribute("drp.vertex.count", batch.length);
			},
			(span, result) => {
				span.setAttribute("drp.vertex.missing_count", result.missing.length);
				span.setAttribute("drp.vertex.invalid_count", result.invalid.length);
			}
		)(vertices);
	}

	private async applyVerticesUntraced(vertices: Vertex[]): Promise<ApplyResult> {
		const callContext: ApplyCallContext = {
			canDeferReconciliation:
				vertices.length > 1 && vertices.every(({ operation }) => operation?.drpType === DrpType.DRP),
			deferRemainingVertices: false,
			needsFullReconciliation: false,
			notificationsDeferred: false,
		};
		try {
			return await this.applyVerticesCall(vertices, callContext);
		} finally {
			try {
				if (callContext.needsFullReconciliation) {
					await this.reconcileCanonicalState();
				}
			} finally {
				if (callContext.notificationsDeferred) {
					this.notificationDeferralDepth--;
					if (this.notificationDeferralDepth === 0) this.drainNotifications();
				}
			}
		}
	}

	private async applyVerticesCall(vertices: Vertex[], callContext: ApplyCallContext): Promise<ApplyResult> {
		const missing: Hash[] = [];
		const invalid: Hash[] = [];
		const quarantined: Hash[] = [];
		const missingVertices = new Map<Hash, Vertex>();
		const batchInvalidVertexHashes = new Set<Hash>();
		for (const vertex of vertices) {
			if (!vertex.operation) {
				this.log.warn("Vertex has no operation", vertex);
				continue;
			}
			if (vertex.operation.opType === "-1") {
				if (vertex.hash === HashGraph.rootHash) continue;
				invalid.push(vertex.hash);
				batchInvalidVertexHashes.add(vertex.hash);
				this.rememberInvalidVertexHash(vertex.hash);
				continue;
			}
			if (this.hashGraph.vertices.has(vertex.hash)) continue;

			let pipelineWasAsync = false;
			try {
				const execution = this.applyVertexPipeline.execute({
					vertex,
					isACL: vertex.operation.drpType === DrpType.ACL,
				});
				pipelineWasAsync = execution instanceof Promise;
				const operation = await execution;
				await this.commitPreparedVertex(operation, callContext);
			} catch (error) {
				if (error instanceof AdoptionCommitExhaustedError) throw error;
				if (error instanceof ApplyInvariantError) {
					error.partialResult = this.createApplyResult(missing, invalid, quarantined);
					throw error;
				}

				const unresolvedDependencies = vertex.dependencies.filter(
					(dependency) => !this.hashGraph.vertices.has(dependency)
				);
				const isDeterministicFailure =
					error instanceof DeterministicRejectionError ||
					isObjectACLDeterministicError(error) ||
					error instanceof InvalidDependenciesError ||
					error instanceof InvalidHashError ||
					error instanceof InvalidTimestampError;
				if (!isDeterministicFailure) {
					// Preserve the established retry contract for asynchronous
					// blueprint rejections. Synchronous per-vertex failures use
					// the newer quarantine result and let valid batch peers commit.
					if (pipelineWasAsync) throw error;
					quarantined.push(vertex.hash);
					continue;
				}

				const rejectedHash = error instanceof AttributedDeterministicRejectionError ? error.vertexHash : vertex.hash;
				if (error instanceof AttributedDeterministicRejectionError && rejectedHash !== vertex.hash) {
					// Attribution and the caller's verdict answer different
					// questions. Remember the committed vertex that actually
					// threw, but reject the submitted vertex: result.invalid
					// must never name a graph member, and descendants need a
					// terminal parent tombstone instead of endless recovery.
					batchInvalidVertexHashes.add(rejectedHash);
					this.rememberInvalidVertexHash(rejectedHash);
					invalid.push(vertex.hash);
					batchInvalidVertexHashes.add(vertex.hash);
					this.rememberInvalidVertexHash(vertex.hash);
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
					missing.push(vertex.hash);
					missingVertices.set(vertex.hash, vertex);
				} else {
					invalid.push(rejectedHash);
					batchInvalidVertexHashes.add(rejectedHash);
					this.rememberInvalidVertexHash(rejectedHash);
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

		return this.createApplyResult(missing, invalid, quarantined);
	}

	private createApplyResult(missing: Hash[], invalid: Hash[], quarantined: Hash[]): ApplyResult {
		const uniqueInvalid = [...new Set(invalid)];
		const result: ApplyResult = {
			applied: missing.length === 0 && uniqueInvalid.length === 0 && quarantined.length === 0,
			missing,
			invalid: uniqueInvalid,
		};
		if (quarantined.length !== 0) result.quarantined = quarantined;
		return result;
	}

	private rememberInvalidVertexHash(hash: Hash): void {
		this.knownInvalidVertexHashes.remember(hash);
	}

	private async commitPreparedVertex(operation: PostOperation<T>, callContext: ApplyCallContext): Promise<boolean> {
		for (let attempt = 1; attempt <= MAX_ADOPTION_COMMIT_ATTEMPTS; attempt++) {
			if (this.hashGraph.vertices.has(operation.vertex.hash)) return false;
			const expectedFrontier = this.hashGraph.getFrontier();
			let adoption: PreparedAdoption<T>;
			if (
				!callContext.deferRemainingVertices &&
				!this.hasUnreconciledLiveState &&
				this.descendsFromWholeFrontier(operation.vertex, expectedFrontier)
			) {
				callContext.hint = undefined;
				adoption = this.prepareLinearAdoption(operation, expectedFrontier);
			} else if (
				!callContext.deferRemainingVertices &&
				!this.hasUnreconciledLiveState &&
				this.canUseAdoptionHint(operation, expectedFrontier, callContext.hint)
			) {
				adoption = await this.prepareHintedAdoption(operation, expectedFrontier, callContext.hint);
			} else if (callContext.canDeferReconciliation) {
				callContext.hint = undefined;
				this.beginDeferredReconciliation(callContext);
				adoption = {
					expectedFrontier,
					skipCheckpoint: true,
				};
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

	private beginDeferredReconciliation(callContext: ApplyCallContext): void {
		callContext.deferRemainingVertices = true;
		callContext.needsFullReconciliation = true;
		this.hasUnreconciledLiveState = true;
		if (callContext.notificationsDeferred) return;
		callContext.notificationsDeferred = true;
		this.notificationDeferralDepth++;
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
			const acl = cloneEnumerableInstance(hint.canonicalACL);
			const drp = hint.canonicalDRP ? cloneEnumerableInstance(hint.canonicalDRP) : undefined;
			const target = operation.isACL ? acl : drp;
			if (target) await applyVertex(target, operation.vertex);
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
		const adopted = cloneEnumerableInstance(operation.currentDRP);
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
		const [drp, acl] = this.states.fromStates(
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
			restoresCanonicalState: true,
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

		const adopted = cloneEnumerableInstance(operation.currentDRP);
		const tail = sameTypeVertices.slice(pendingIndex + 1);
		await (operation.isACL ? applyDeterministicReplayVertices(adopted, tail) : applyVertices(adopted, tail));
		const nextHint = this.createTailAdoptionHint(vertex, expectedFrontier, tail, replay.requiresConflictResolution);
		return operation.isACL
			? { expectedFrontier, acl: adopted as IACL, nextHint, restoresCanonicalState: true }
			: { expectedFrontier, drp: adopted as T, nextHint, restoresCanonicalState: true };
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
		adoption: PreparedAdoption<T>
	): "committed" | "duplicate" | "retry" {
		if (this.hashGraph.vertices.has(operation.vertex.hash)) return "duplicate";
		if (!sameHashes(this.hashGraph.getFrontier(), adoption.expectedFrontier)) return "retry";

		// This journal is born, used, and closed in one synchronous section after
		// the vertex's final await. No rollback authority crosses a suspension.
		const journal = new UndoJournal();
		const commitOperation = { ...operation, journal };
		try {
			this.assignState(commitOperation);
			this.initializeFinalityStore(commitOperation);
			this.addVertexToHashGraph(commitOperation);
			if (adoption.acl) replaceEnumerableState(this.acl, adoption.acl, journal);
			if (adoption.drp && this.drp) replaceEnumerableState(this.drp, adoption.drp, journal);
			if (!adoption.skipCheckpoint) this.advanceCheckpointIfNeeded(journal, adoption.forceCheckpoint);
			if (adoption.restoresCanonicalState) this.hasUnreconciledLiveState = false;
			journal.commit();
			this.knownInvalidVertexHashes.delete(operation.vertex.hash);
			this.enqueueNotification("merge", [operation.vertex]);
			return "committed";
		} catch (error) {
			try {
				journal.rollback();
			} catch (rollbackError) {
				throw new ApplyInvariantError(
					[error, rollbackError],
					"Vertex commit failed and its synchronous rollback was incomplete"
				);
			}
			throw error;
		}
	}

	private createVertex({ prop: opType, args: value, type: drpType }: DRPProxyChainArgs): HandlerReturn<BaseOperation> {
		return {
			stop: false,
			result: {
				// Vertex payloads are immutable history. Detach them from caller-owned
				// objects before hashing and storing the operation.
				vertex: this.hashGraph.createVertex({ drpType, opType, value: cloneDeep(value) }),
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
			throw result.error;
		}
		return { stop: false, result: operation };
	}

	private getLCA(operation: BaseOperation): HandlerReturn<PostLCAOperation> {
		const { vertex } = operation;
		if (operation.isLocal) {
			if (!this.hasUnreconciledLiveState) this.advanceCheckpointIfNeeded();
			return {
				stop: false,
				result: { ...operation, lcaResult: { lca: HashGraph.rootHash, linearizedVertices: [] } },
			};
		}
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
			isLocal,
			replayState,
		} = operation;
		const [drp, acl] = isLocal
			? this.states.fromStates(stateFromDRP(this.drp), stateFromDRP(this.acl), this.drp?.context, this.acl.context)
			: replayState
				? this.states.fromStates(replayState.drpState, replayState.aclState, this.drp?.context, this.acl.context)
				: this.states.fromHash(lca, drpVertices.length + aclVertices.length, this.drp?.context, this.acl.context);
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

	private advanceCheckpointIfNeeded(journal?: OperationJournal, force = false): void {
		const latest = this.checkpoints[this.checkpoints.length - 1];
		if (!force && this.hashGraph.vertices.size - latest.vertexCount < this.checkpointSuffixSize) return;
		if (latest.vertexCount === this.hashGraph.vertices.size) {
			if (!force || latest === this.checkpoints[0]) return;
			this.checkpoints.pop();
			journal?.record(() => {
				if (!this.checkpoints.includes(latest)) this.checkpoints.push(latest);
			});
		}

		const frontier = this.hashGraph.getFrontier();
		const checkpoint: LinearizationCheckpoint = {
			frontier,
			origin: [...frontier].sort()[0],
			vertexCount: this.hashGraph.vertices.size,
			state: {
				drpState: stateFromDRP(this.drp),
				aclState: stateFromDRP(this.acl),
			},
		};
		this.checkpoints.push(checkpoint);
		journal?.record(() => {
			const checkpointIndex = this.checkpoints.findIndex((candidate) => candidate === checkpoint);
			if (checkpointIndex !== -1) this.checkpoints.splice(checkpointIndex, 1);
		});

		if (this.checkpoints.length > MAX_CHECKPOINTS) {
			const removed = this.checkpoints[1];
			const previous = this.checkpoints[0];
			const next = this.checkpoints[2];
			const removedIndex = this.checkpoints.findIndex((candidate) => candidate === removed);
			if (removedIndex !== -1) this.checkpoints.splice(removedIndex, 1);
			journal?.record(() => {
				if (this.checkpoints.some((candidate) => candidate === removed)) return;
				const nextIndex = this.checkpoints.findIndex((candidate) => candidate === next);
				if (nextIndex !== -1) {
					this.checkpoints.splice(nextIndex, 0, removed);
					return;
				}
				const previousIndex = this.checkpoints.findIndex((candidate) => candidate === previous);
				if (previousIndex !== -1) this.checkpoints.splice(previousIndex + 1, 0, removed);
			});
		}
		this.pruneSnapshots(journal);
	}

	private pruneSnapshots(journal?: OperationJournal): void {
		const retained = new Set<Hash>([HashGraph.rootHash]);
		for (const checkpoint of this.checkpoints) {
			for (const hash of checkpoint.frontier) retained.add(hash);
		}
		const latest = this.checkpoints[this.checkpoints.length - 1];
		const hashes = Array.from(this.hashGraph.vertices.keys());
		for (let index = latest.vertexCount; index < hashes.length; index++) retained.add(hashes[index]);
		const pruned = this.states.prune(retained);
		journal?.record(() => this.states.restorePruned(pruned));
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

		const tracked = trackMutations(currentDRP);

		return handlePromiseOrValue(
			callDRP(tracked.proxy, peerId, opType, value),
			(result): HandlerReturn<PostOperation<T>> => ({
				stop: false,
				result: { ...drpOperation, result, stateChanged: tracked.hasChanges() },
			})
		);
	}

	private equal(operation: PostOperation<T>): HandlerReturn<PostOperation<T>> {
		if (operation.currentDRP === undefined) return { stop: false, result: operation };
		return { stop: operation.stateChanged !== true, result: operation };
	}

	private assign<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const { isACL, currentDRP } = operation;
		if (!isACL && this._proxyDRP) {
			if (currentDRP) replaceEnumerableState(this._proxyDRP.proxy, currentDRP);
			return { stop: false, result: operation };
		}
		if (currentDRP) replaceEnumerableState(this._proxyACL.proxy, currentDRP);
		return { stop: false, result: operation };
	}

	private assignState<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const {
			isACL,
			isLocal,
			currentDRP,
			acl,
			drp,
			journal,
			vertex: { hash },
		} = operation;

		// A synchronous local call may run while a remote call is amortizing its
		// one canonical replay. Its return value is necessarily based on the live
		// proxy, but that proxy is not a valid causal snapshot for the new hash.
		// Omitting the snapshot forces every later child to reconstruct from the
		// graph instead of re-adopting stale state.
		if (isLocal && this.hasUnreconciledLiveState) return { stop: false, result: operation };

		const [aclState, drpState] = isACL
			? [stateFromDRP(currentDRP), stateFromDRP(drp)]
			: [stateFromDRP(acl), stateFromDRP(currentDRP)];

		const previousACLState = this.states.getACLState(hash);
		this.states.setACLState(hash, aclState);
		journal?.record(() => {
			if (this.states.getACLState(hash) !== aclState) return;
			if (previousACLState) this.states.setACLState(hash, previousACLState);
			else this.states.deleteACLState(hash, aclState);
		});

		const previousDRPState = this.states.getDRPState(hash);
		this.states.setDRPState(hash, drpState);
		journal?.record(() => {
			if (this.states.getDRPState(hash) !== drpState) return;
			if (previousDRPState) this.states.setDRPState(hash, previousDRPState);
			else this.states.deleteDRPState(hash, drpState);
		});
		return { stop: false, result: operation };
	}

	private addVertexToHashGraph<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
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
		if (!journal) this.knownInvalidVertexHashes.delete(vertex.hash);
		journal?.record(() => {
			(this.hashGraph as IHashGraph & Pick<HashGraph, "removeVertex">).removeVertex(vertex, frontierRestorePoints);
		});
		return { stop: false, result: operation };
	}

	private initializeFinalityStore<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const { vertex, acl, currentDRP, isACL, journal } = operation;
		const finalitySigners = isACL ? currentDRP?.query_getFinalitySigners() : acl.query_getFinalitySigners();
		const previous = this.finalityStore.states.get(vertex.hash);
		this.finalityStore.initializeState(vertex.hash, finalitySigners);
		const initialized = this.finalityStore.states.get(vertex.hash);
		if (!previous && initialized) {
			journal?.record(() => {
				if (this.finalityStore.states.get(vertex.hash) === initialized) {
					this.finalityStore.states.delete(vertex.hash);
				}
			});
		}
		return { stop: false, result: operation };
	}

	private notify(operation: PostOperation<T>): HandlerReturn<PostOperation<T>> {
		this.enqueueNotification("callFn", [operation.vertex]);
		return { stop: false, result: operation };
	}

	private enqueueNotification(origin: string, vertices: Vertex[]): void {
		this.notificationQueue.push({ origin, vertices });
		if (this.notificationDeferralDepth !== 0) return;
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

	private async reconcileCanonicalState(): Promise<void> {
		for (let attempt = 1; attempt <= MAX_ADOPTION_COMMIT_ATTEMPTS; attempt++) {
			const expectedFrontier = this.hashGraph.getFrontier();
			const replay = this.getReplay(expectedFrontier);
			const [drpVertices, aclVertices] = splitOperation(replay.linearizedVertices);
			const [drp, acl] = this.states.fromStates(
				replay.state.drpState,
				replay.state.aclState,
				this.drp?.context,
				this.acl.context
			);
			await applyDeterministicReplayVertices(acl, aclVertices);
			if (drp && this.drp) await applyVertices(drp, drpVertices);
			if (!sameHashes(this.hashGraph.getFrontier(), expectedFrontier)) continue;

			const journal = new UndoJournal();
			try {
				// Presence has already been established by the replay input, and
				// frontier CAS is repeated inside this synchronous publication
				// section after the replay's final suspension point.
				if (!sameHashes(this.hashGraph.getFrontier(), expectedFrontier)) continue;
				replaceEnumerableState(this.acl, acl, journal);
				if (drp && this.drp) replaceEnumerableState(this.drp, drp, journal);
				this.advanceCheckpointIfNeeded(journal, true);
				this.hasUnreconciledLiveState = false;
				journal.commit();
				return;
			} catch (error) {
				journal.rollback();
				throw error;
			}
		}
		throw new ApplyInvariantError(
			[new Error("Frontier changed during every canonical replay attempt")],
			`Failed to reconcile canonical state after ${MAX_ADOPTION_COMMIT_ATTEMPTS} attempts`
		);
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
	const finalityStore = options.finalityStore ?? new FinalityStore(options.finalityConfig, options.logConfig);

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
		return Reflect.apply(operation, drp, cloneDeep(args));
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
