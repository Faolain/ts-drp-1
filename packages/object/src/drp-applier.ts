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

import { FinalityStore } from "./finality/index.js";
import { HashGraph } from "./hashgraph/index.js";
import {
	type BaseOperation,
	type Operation,
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
const metrics = new OpentelemetryMetrics("@ts-drp/object/drp-applier");

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
	private finalityStore: FinalityStore;
	private _notify: (origin: string, vertices: Vertex[]) => void;
	private log: Logger;
	private knownInvalidVertexHashes = new Set<Hash>();
	private checkpoints: LinearizationCheckpoint[];
	private readonly checkpointSuffixSize = checkpointSuffixSizeFromEnvironment();

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
			.setNext(this.applyFn.bind(this))
			.setNext(this.assignState.bind(this))
			.setNext(this.initializeFinalityStore.bind(this))
			.setNext(this.addVertexToHashGraph.bind(this));

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
		const missing: Hash[] = [];
		const invalid: Hash[] = [];
		const missingVertices = new Map<Hash, Vertex>();
		const batchInvalidVertexHashes = new Set<Hash>();
		const newVertices: Vertex[] = [];

		for (const vertex of vertices) {
			if (!vertex.operation) {
				this.log.warn("Vertex has no operation", vertex);
				continue;
			}
			if (vertex.operation.opType === "-1") continue;
			if (this.hashGraph.vertices.has(vertex.hash)) {
				continue;
			}

			try {
				await this.applyVertexPipeline.execute({ vertex: vertex, isACL: vertex.operation.drpType === DrpType.ACL });
				newVertices.push(vertex);
			} catch (error) {
				const unresolvedDependencies = vertex.dependencies.filter(
					(dependency) => !this.hashGraph.vertices.has(dependency)
				);
				const isValidationFailure =
					error instanceof InvalidDependenciesError ||
					error instanceof InvalidHashError ||
					error instanceof InvalidTimestampError;
				// DRP methods and resolvers are application code. Their failures may be transient,
				// so abort this merge and let re-delivery retry the vertex without poisoning its hash.
				if (!isValidationFailure) throw error;

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
					invalid.push(vertex.hash);
					batchInvalidVertexHashes.add(vertex.hash);
					this.rememberInvalidVertexHash(vertex.hash);
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

		const frontier = this.hashGraph.getFrontier();
		const replay = this.getReplay(frontier);
		const [drpVertices, aclVertices] = splitOperation(replay.linearizedVertices);

		const [drp, acl] = this.states.fromStates(replay.state.drpState, replay.state.aclState);
		await applyVertices(acl, aclVertices);
		Object.assign(this.acl, acl);
		if (drp && this.drp) {
			await applyVertices(drp, drpVertices);
			Object.assign(this.drp, drp);
		}
		this.advanceCheckpointIfNeeded();

		this._notify("merge", newVertices);
		return { applied: missing.length === 0 && invalid.length === 0, missing, invalid };
	}

	private rememberInvalidVertexHash(hash: Hash): void {
		if (this.knownInvalidVertexHashes.has(hash)) return;
		this.knownInvalidVertexHashes.add(hash);
		if (this.knownInvalidVertexHashes.size <= MAX_KNOWN_INVALID_VERTEX_HASHES) return;

		const oldestHash = this.knownInvalidVertexHashes.values().next().value;
		if (oldestHash !== undefined) this.knownInvalidVertexHashes.delete(oldestHash);
	}

	private createVertex({ prop: opType, args: value, type: drpType }: DRPProxyChainArgs): HandlerReturn<BaseOperation> {
		return {
			stop: false,
			result: {
				vertex: this.hashGraph.createVertex({ drpType, opType, value }),
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
			this.advanceCheckpointIfNeeded();
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
			? this.states.fromStates(stateFromDRP(this.drp), stateFromDRP(this.acl))
			: replayState
				? this.states.fromStates(replayState.drpState, replayState.aclState)
				: this.states.fromHash(lca, drpVertices.length + aclVertices.length);
		applyVertices(acl, aclVertices);

		if (!drp) {
			// we need to clone deep is the current op is ACL cause the state of this object could change
			return {
				stop: false,
				result: { ...operation, acl, currentDRP: isACL ? cloneDeep(acl) : undefined },
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
					currentDRP: isACL ? cloneDeep(acl) : cloneDeep(drp),
				},
			};
		});
	}

	private getReplay(dependencies: Hash[]): {
		origin: Hash;
		state: ReplayState;
		linearizedVertices: Vertex[];
	} {
		for (let index = this.checkpoints.length - 1; index >= 0; index--) {
			const checkpoint = this.checkpoints[index];
			if (!this.dependenciesCover(dependencies, checkpoint.frontier)) continue;
			const subgraph = this.collectSuffixSubgraph(dependencies, checkpoint.frontier, checkpoint.origin);
			if (subgraph === undefined) continue;
			return {
				origin: checkpoint.origin,
				state: checkpoint.state,
				linearizedVertices: this.hashGraph.linearizeVertices(checkpoint.origin, subgraph),
			};
		}
		throw new Error("No valid linearization checkpoint");
	}

	private dependenciesCover(dependencies: Hash[], boundary: Hash[]): boolean {
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
				for (const dependency of this.hashGraph.vertices.get(hash)?.dependencies ?? []) stack.push(dependency);
			}
			if (remaining.size !== 0) return false;
		}
		return true;
	}

	/**
	 * Collect a replay suffix only when it is separated from baked checkpoint state by a causal barrier.
	 * Every suffix member must descend from every checkpoint-frontier head. Otherwise it may be concurrent
	 * with a prefix operation, whose conflict outcome cannot be changed after that prefix is baked into state.
	 * @param dependencies
	 * @param boundary
	 * @param origin
	 */
	private collectSuffixSubgraph(dependencies: Hash[], boundary: Hash[], origin: Hash): Set<Hash> | undefined {
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
			for (const dependency of this.hashGraph.vertices.get(hash)?.dependencies ?? []) stack.push(dependency);
		}

		const suffixMembers = [...subgraph].filter((hash) => hash !== origin);
		for (const head of boundary) {
			const reachable = new Set<Hash>();
			const forwardStack = [head];
			while (forwardStack.length > 0) {
				const hash = forwardStack.pop();
				if (hash === undefined || reachable.has(hash)) continue;
				reachable.add(hash);
				for (const child of this.hashGraph.forwardEdges.get(hash) ?? []) {
					if (boundarySet.has(child) || subgraph.has(child)) forwardStack.push(child);
				}
			}
			if (suffixMembers.some((hash) => !reachable.has(hash))) return undefined;
		}
		return subgraph;
	}

	private advanceCheckpointIfNeeded(): void {
		const latest = this.checkpoints[this.checkpoints.length - 1];
		if (this.hashGraph.vertices.size - latest.vertexCount < this.checkpointSuffixSize) return;

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
		if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.splice(1, 1);
		this.pruneSnapshots();
	}

	private pruneSnapshots(): void {
		const retained = new Set<Hash>([HashGraph.rootHash]);
		for (const checkpoint of this.checkpoints) {
			for (const hash of checkpoint.frontier) retained.add(hash);
		}
		const latest = this.checkpoints[this.checkpoints.length - 1];
		const hashes = Array.from(this.hashGraph.vertices.keys());
		for (let index = latest.vertexCount; index < hashes.length; index++) retained.add(hashes[index]);
		this.states.prune(retained);
	}

	private validateWriterPermission(operation: Operation<T>): HandlerReturn<Operation<T>> {
		const {
			acl,
			vertex: { peerId },
			isACL,
		} = operation;
		if (isACL) return { stop: false, result: operation };

		const isWriter = acl.query_isWriter(peerId);
		if (!isWriter) throw new Error("Not a writer " + peerId);
		return { stop: false, result: operation };
	}

	private applyFn(
		drpOperation: Operation<T>
	): HandlerReturn<PostOperation<T>> | Promise<HandlerReturn<PostOperation<T>>> {
		const {
			currentDRP,
			vertex: { peerId, operation },
			isACL,
		} = drpOperation;

		if (!operation) throw new Error("Operation is undefined");

		const { opType, value } = operation;

		if (!currentDRP) {
			return { stop: false, result: { ...drpOperation, result: undefined, stateChanged: false } };
		}

		const tracked = trackMutations(currentDRP);

		if (isACL) {
			// ACL does not have async functions
			return {
				stop: false,
				result: {
					...drpOperation,
					result: callDRP(tracked.proxy, peerId, opType, value),
					stateChanged: tracked.hasChanges(),
				},
			};
		}

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
			Object.assign(this._proxyDRP.proxy, currentDRP);
			return { stop: false, result: operation };
		}
		Object.assign(this._proxyACL.proxy, currentDRP);
		return { stop: false, result: operation };
	}

	private assignState<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const {
			isACL,
			currentDRP,
			acl,
			drp,
			vertex: { hash },
		} = operation;

		const [aclState, drpState] = isACL
			? [stateFromDRP(currentDRP), stateFromDRP(drp)]
			: [stateFromDRP(acl), stateFromDRP(currentDRP)];

		this.states.setACLState(hash, aclState);
		this.states.setDRPState(hash, drpState);
		return { stop: false, result: operation };
	}

	private addVertexToHashGraph<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const { vertex } = operation;
		this.hashGraph.addVertex(vertex);
		return { stop: false, result: operation };
	}

	private initializeFinalityStore<Op extends Operation<T>>(operation: Op): HandlerReturn<Op> {
		const { vertex, acl, currentDRP, isACL } = operation;
		const finalitySigners = isACL ? currentDRP?.query_getFinalitySigners() : acl.query_getFinalitySigners();
		this.finalityStore.initializeState(vertex.hash, finalitySigners);
		return { stop: false, result: operation };
	}

	private notify(operation: PostOperation<T>): HandlerReturn<PostOperation<T>> {
		this._notify("callFn", [operation.vertex]);
		return { stop: false, result: operation };
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
	if (drp.context) drp.context.caller = caller;

	return drp[method](...args);
}

function applyVertex<T extends IDRP>(drp: T, vertex: Vertex): unknown | Promise<unknown> {
	const { operation, peerId } = vertex;
	if (!operation) throw new Error("Operation is undefined");

	return callDRP(drp, peerId, operation.opType, operation.value);
}

function applyVertices<T extends IDRP>(drp: T, vertices: Vertex[]): unknown | Promise<unknown> {
	return processSequentially(vertices, (drp, v) => applyVertex(drp, v), drp);
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
