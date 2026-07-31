import { type DrpType, type IDRP } from "@ts-drp/types";
import { handlePromiseOrValue, isPromise } from "@ts-drp/utils";
import { serializedValuesEqual } from "@ts-drp/utils/serialization";
import { circularDeepEqual } from "fast-equals";

import { AdoptionCommitExhaustedError } from "./errors.js";
import { MAX_ADOPTION_COMMIT_ATTEMPTS, type PostOperation } from "./operation.js";
import { type Pipeline } from "./pipeline/pipeline.js";
import { REPLICA_LOCAL_STATE_KEYS } from "./state.js";

export interface DRPProxyBeforeChainArgs {
	prop: string;
	args: unknown[];
}

export interface DRPProxyChainArgs {
	prop: string;
	args: unknown[];
	type: DrpType;
}

export interface MutationTrackingResult<T extends object> {
	proxy: T;
	hasChanges(): boolean;
	changedKeys(): ReadonlySet<string>;
}

interface PendingLocalMutation {
	execute(): unknown | Promise<unknown>;
	resolve(value: unknown): void;
	reject(reason?: unknown): void;
}

/**
 * Serializes locally authored mutations for one DRP object while preserving
 * synchronous execution when the lane is idle.
 */
export class LocalMutationLane {
	private running = false;
	private readonly pending: PendingLocalMutation[] = [];

	/**
	 * Runs a mutation immediately or queues it behind the active mutation.
	 * @param execute - The complete local authoring pipeline
	 * @returns The direct result when uncontended, otherwise a Promise
	 */
	run<T>(execute: () => T | Promise<T>): T | Promise<T> {
		if (this.running) {
			return new Promise<T>((resolve, reject) => {
				this.pending.push({ execute, resolve, reject });
			});
		}

		this.running = true;
		let result: T | Promise<T>;
		try {
			result = execute();
		} catch (error) {
			this.release();
			throw error;
		}

		if (!isPromise(result)) {
			this.release();
			return result;
		}
		void result.then(
			() => this.release(),
			() => this.release()
		);
		return result;
	}

	private release(): void {
		while (this.pending.length > 0) {
			const next = this.pending.shift();
			if (!next) continue;

			let result: unknown | Promise<unknown>;
			try {
				result = next.execute();
			} catch (error) {
				next.reject(error);
				continue;
			}

			if (isPromise(result)) {
				result.then(
					(value) => {
						next.resolve(value);
						this.release();
					},
					(error: unknown) => {
						next.reject(error);
						this.release();
					}
				);
				return;
			}
			next.resolve(result);
		}
		this.running = false;
	}
}

/**
 * Tracks effective writes to a cloned DRP state. Collection mutations are
 * compared at the written key/value instead of rescanning the complete state.
 * Blueprint operations may use ordinary nested objects, Arrays, Maps, Sets,
 * and Dates; writes through those values are tracked, while read-only work
 * does not create a vertex. Unknown collection methods conservatively count
 * as writes so new mutating platform methods cannot bypass tracking.
 * @param target - The cloned state that an operation will mutate.
 * @returns A proxy and a cheap dirty-state reader.
 */
export function trackMutations<T extends object>(target: T): MutationTrackingResult<T> {
	const changedKeys = new Set<string>();
	const trackedProxies = new WeakMap<object, object>();
	const ignoredProxies = new WeakMap<object, object>();
	const rawValues = new WeakMap<object, object>();
	const topLevelOwners = new WeakMap<object, Set<string>>();
	const ownerGraphs = new Map<string, Set<object>>();

	const ownersFor = (value: object): ReadonlySet<string> => topLevelOwners.get(value) ?? new Set<string>();

	const addOwner = (value: object, owner: string): void => {
		let owners = topLevelOwners.get(value);
		if (!owners) {
			owners = new Set<string>();
			topLevelOwners.set(value, owners);
		}
		owners.add(owner);
		let graph = ownerGraphs.get(owner);
		if (!graph) {
			graph = new Set<object>();
			ownerGraphs.set(owner, graph);
		}
		graph.add(value);
	};

	const addOwners = (value: object, owners: string | Iterable<string> | undefined): void => {
		if (owners === undefined) return;
		for (const owner of typeof owners === "string" ? [owners] : owners) addOwner(value, owner);
	};

	const collectOwnerGraph = (value: unknown, graph: Set<object>): void => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
		if (graph.has(value)) return;
		graph.add(value);
		if (value instanceof Map) {
			for (const [key, entryValue] of value) {
				collectOwnerGraph(key, graph);
				collectOwnerGraph(entryValue, graph);
			}
			return;
		}
		if (value instanceof Set) {
			for (const entryValue of value) collectOwnerGraph(entryValue, graph);
			return;
		}
		if (value instanceof Date) return;
		for (const key of Object.keys(value)) collectOwnerGraph((value as Record<string, unknown>)[key], graph);
	};

	const refreshOwnerGraph = (owner: string): void => {
		for (const value of ownerGraphs.get(owner) ?? []) {
			const owners = topLevelOwners.get(value);
			owners?.delete(owner);
			if (owners?.size === 0) topLevelOwners.delete(value);
		}

		const value = (target as Record<string, unknown>)[owner];
		if (REPLICA_LOCAL_STATE_KEYS.has(owner) || typeof value === "function") {
			ownerGraphs.delete(owner);
			return;
		}
		const graph = new Set<object>();
		collectOwnerGraph(value, graph);
		for (const graphValue of graph) addOwner(graphValue, owner);
		ownerGraphs.set(owner, graph);
	};

	const refreshOwnerGraphs = (owners: Iterable<string>): void => {
		for (const owner of owners) refreshOwnerGraph(owner);
	};

	for (const key of Object.keys(target)) refreshOwnerGraph(key);

	const valuesEqual = (left: unknown, right: unknown): boolean => {
		if (!circularDeepEqual(left, right)) return false;
		try {
			return serializedValuesEqual(left, right);
		} catch {
			// The wire codec rejects cyclic graphs. They still need deterministic,
			// cycle-safe topology tracking before validation handles publication.
			return true;
		}
	};

	const isReference = (value: unknown): value is object =>
		(typeof value === "object" || typeof value === "function") && value !== null;

	const changesReachability = (previous: unknown, next: unknown): boolean =>
		!Object.is(previous, next) && (isReference(previous) || isReference(next));

	const markChanged = (owner: object, property?: PropertyKey): void => {
		if (owner === target && typeof property === "string") {
			if (!REPLICA_LOCAL_STATE_KEYS.has(property)) changedKeys.add(property);
			return;
		}
		for (const key of ownersFor(owner)) changedKeys.add(key);
	};

	const unwrap = <V>(value: V): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		return (rawValues.get(value as object) as V | undefined) ?? value;
	};

	const wrap = <V>(value: V, ignored = false, owners?: string | Iterable<string>): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		const objectValue = value as object;
		addOwners(objectValue, owners);
		const proxyCache = ignored ? ignoredProxies : trackedProxies;
		const existing = proxyCache.get(objectValue);
		if (existing) return existing as V;

		let proxy: object;
		if (value instanceof Map) {
			proxy = new Proxy(value, {
				get(map, property): unknown {
					if (property === "set") {
						return (key: unknown, nextValue: unknown): Map<unknown, unknown> => {
							const rawKey = unwrap(key);
							const rawValue = unwrap(nextValue);
							const owners = [...ownersFor(map)];
							const hadKey = map.has(rawKey);
							const previousValue = map.get(rawKey);
							const didChange = !hadKey || !valuesEqual(previousValue, rawValue);
							const topologyChanged = (!hadKey && isReference(rawKey)) || changesReachability(previousValue, rawValue);
							map.set(rawKey, rawValue);
							if (!ignored && didChange) markChanged(map);
							if (!ignored && topologyChanged) refreshOwnerGraphs(owners);
							return proxy as Map<unknown, unknown>;
						};
					}
					if (property === "get") {
						return (key: unknown): unknown => wrap(map.get(unwrap(key)), ignored, ownersFor(map));
					}
					if (property === "has") return (key: unknown): boolean => map.has(unwrap(key));
					if (property === "delete") {
						return (key: unknown): boolean => {
							const rawKey = unwrap(key);
							const owners = [...ownersFor(map)];
							const previousValue = map.get(rawKey);
							const deleted = map.delete(rawKey);
							if (!ignored && deleted) {
								markChanged(map);
								if (isReference(rawKey) || isReference(previousValue)) refreshOwnerGraphs(owners);
							}
							return deleted;
						};
					}
					if (property === "clear") {
						return (): void => {
							const owners = [...ownersFor(map)];
							const hadEntries = map.size > 0;
							map.clear();
							if (!ignored && hadEntries) {
								markChanged(map);
								refreshOwnerGraphs(owners);
							}
						};
					}
					if (property === Symbol.iterator || property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const [key, entryValue] of map.entries()) {
								yield [wrap(key, ignored, ownersFor(map)), wrap(entryValue, ignored, ownersFor(map))];
							}
						};
					}
					if (property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const key of map.keys()) yield wrap(key, ignored, ownersFor(map));
						};
					}
					if (property === "values") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of map.values()) {
								yield wrap(entryValue, ignored, ownersFor(map));
							}
						};
					}
					if (property === "forEach") {
						return (
							callback: (entryValue: unknown, key: unknown, collection: Map<unknown, unknown>) => void,
							thisArg?: unknown
						): void => {
							map.forEach((entryValue, key) => {
								callback.call(
									thisArg,
									wrap(entryValue, ignored, ownersFor(map)),
									wrap(key, ignored, ownersFor(map)),
									proxy as Map<unknown, unknown>
								);
							});
						};
					}
					const member = Reflect.get(map, property, map) as unknown;
					if (typeof member !== "function") return member;
					return (...args: unknown[]): unknown => {
						const owners = [...ownersFor(map)];
						const result = (member as (...values: unknown[]) => unknown).apply(map, args.map(unwrap));
						if (!ignored) {
							markChanged(map);
							refreshOwnerGraphs(owners);
						}
						return result === map ? proxy : wrap(result, ignored, ownersFor(map));
					};
				},
			});
		} else if (value instanceof Set) {
			proxy = new Proxy(value, {
				get(set, property): unknown {
					if (property === "add") {
						return (nextValue: unknown): Set<unknown> => {
							const rawValue = unwrap(nextValue);
							const owners = [...ownersFor(set)];
							const didChange = !set.has(rawValue);
							set.add(rawValue);
							if (!ignored && didChange) {
								markChanged(set);
								if (isReference(rawValue)) refreshOwnerGraphs(owners);
							}
							return proxy as Set<unknown>;
						};
					}
					if (property === "has") return (nextValue: unknown): boolean => set.has(unwrap(nextValue));
					if (property === "delete") {
						return (nextValue: unknown): boolean => {
							const rawValue = unwrap(nextValue);
							const owners = [...ownersFor(set)];
							const deleted = set.delete(rawValue);
							if (!ignored && deleted) {
								markChanged(set);
								if (isReference(rawValue)) refreshOwnerGraphs(owners);
							}
							return deleted;
						};
					}
					if (property === "clear") {
						return (): void => {
							const owners = [...ownersFor(set)];
							const hadEntries = set.size > 0;
							set.clear();
							if (!ignored && hadEntries) {
								markChanged(set);
								refreshOwnerGraphs(owners);
							}
						};
					}
					if (property === Symbol.iterator || property === "values" || property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of set.values()) {
								yield wrap(entryValue, ignored, ownersFor(set));
							}
						};
					}
					if (property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const entryValue of set.values()) {
								const wrapped = wrap(entryValue, ignored, ownersFor(set));
								yield [wrapped, wrapped];
							}
						};
					}
					if (property === "forEach") {
						return (
							callback: (entryValue: unknown, key: unknown, collection: Set<unknown>) => void,
							thisArg?: unknown
						): void => {
							set.forEach((entryValue) => {
								const wrapped = wrap(entryValue, ignored, ownersFor(set));
								callback.call(thisArg, wrapped, wrapped, proxy as Set<unknown>);
							});
						};
					}
					const member = Reflect.get(set, property, set) as unknown;
					if (typeof member !== "function") return member;
					return (...args: unknown[]): unknown => {
						const owners = [...ownersFor(set)];
						const result = (member as (...values: unknown[]) => unknown).apply(set, args.map(unwrap));
						if (!ignored) {
							markChanged(set);
							refreshOwnerGraphs(owners);
						}
						return result === set ? proxy : wrap(result, ignored, ownersFor(set));
					};
				},
			});
		} else if (value instanceof Date) {
			proxy = new Proxy(value, {
				get(date, property): unknown {
					const member = Reflect.get(date, property, date) as unknown;
					if (typeof member !== "function") return member;
					return (...args: unknown[]): unknown => {
						const before = date.getTime();
						const result = (member as (...values: unknown[]) => unknown).apply(date, args);
						if (!ignored && property.toString().startsWith("set") && !Object.is(date.getTime(), before)) {
							markChanged(date);
						}
						return result;
					};
				},
			});
		} else {
			proxy = new Proxy(objectValue, {
				get(object, property, receiver): unknown {
					const nestedIgnored =
						ignored || (object === target && typeof property === "string" && REPLICA_LOCAL_STATE_KEYS.has(property));
					const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) return descriptor.value;
						if ("get" in descriptor && descriptor.get === undefined) return undefined;
					}
					const nestedOwners = object === target && typeof property === "string" ? property : ownersFor(object);
					return wrap(Reflect.get(object, property, receiver), nestedIgnored, nestedOwners);
				},
				set(object, property, nextValue): boolean {
					const rawValue = unwrap(nextValue);
					const owners = [...ownersFor(object)];
					const previousValue = Reflect.get(object, property, object);
					const assigned = Reflect.set(object, property, rawValue, object);
					if (!ignored && assigned) {
						const resultingValue = Reflect.get(object, property, object);
						const didChange = !valuesEqual(previousValue, resultingValue);
						if (didChange) markChanged(object, property);
						if (object === target && typeof property === "string") refreshOwnerGraph(property);
						else if (changesReachability(previousValue, resultingValue)) refreshOwnerGraphs(owners);
					}
					return assigned;
				},
				deleteProperty(object, property): boolean {
					const owners = [...ownersFor(object)];
					const existed = Reflect.has(object, property);
					const previousValue = Reflect.get(object, property, object);
					const deleted = Reflect.deleteProperty(object, property);
					if (!ignored && deleted && existed) {
						markChanged(object, property);
						if (object === target && typeof property === "string") refreshOwnerGraph(property);
						else if (isReference(previousValue)) refreshOwnerGraphs(owners);
					}
					return deleted;
				},
				defineProperty(object, property, descriptor): boolean {
					const owners = [...ownersFor(object)];
					const rawDescriptor = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor;
					const defined = Reflect.defineProperty(object, property, rawDescriptor);
					if (!ignored && defined) {
						markChanged(object, property);
						refreshOwnerGraphs(object === target && typeof property === "string" ? [property] : owners);
					}
					return defined;
				},
			});
		}

		proxyCache.set(objectValue, proxy);
		rawValues.set(proxy, objectValue);
		return proxy as V;
	};

	return { proxy: wrap(target), hasChanges: () => changedKeys.size > 0, changedKeys: () => changedKeys };
}

/**
 * A proxy for a DRP object
 * @template T - The type of the DRP object
 */
export class DRPProxy<T extends IDRP> {
	private pipeline: Pipeline<DRPProxyChainArgs, PostOperation<IDRP>>;

	private target: T;
	private readonly _proxy: T;
	private type: DrpType;
	private readonly localMutationLane: LocalMutationLane;

	/**
	 * Creates a new DRPProxy instance
	 * @param target - The target object this proxy is associated with
	 * @param pipeline - The pipeline of steps to be executed
	 * @param type - The type of the proxy
	 * @param localMutationLane - The per-object local authoring lane
	 */
	constructor(
		target: T,
		pipeline: Pipeline<DRPProxyChainArgs, PostOperation<IDRP>>,
		type: DrpType,
		localMutationLane = new LocalMutationLane()
	) {
		this.type = type;
		this.target = target;
		this.pipeline = pipeline;
		this.localMutationLane = localMutationLane;
		this._proxy = this.createProxy();
	}

	/**
	 * Create the proxy that intercepts method calls
	 * @returns The proxy
	 */
	createProxy(): T {
		const handler: ProxyHandler<T> = {
			get: (target, prop) => {
				const propKey = prop as keyof T;
				const originalValue = target[propKey];

				// Only intercept function calls
				if (typeof originalValue !== "function" || typeof prop !== "string") {
					return originalValue;
				}

				// Skip proxy behavior for specific methods
				if (prop.startsWith("query_") || prop === "resolveConflicts") {
					return originalValue;
				}

				// Return wrapped function
				return (...args: unknown[]) => {
					return this.localMutationLane.run(() => {
						let attempts = 1;
						const retrying = (postOperation: PostOperation<IDRP>): boolean => postOperation.commitOutcome === "retry";
						const assertRetryAvailable = (postOperation: PostOperation<IDRP>): void => {
							if (attempts < MAX_ADOPTION_COMMIT_ATTEMPTS) return;
							throw new AdoptionCommitExhaustedError(postOperation.vertex.hash, attempts);
						};
						const continueAsync = async (pending: Promise<PostOperation<IDRP>>): Promise<PostOperation<IDRP>> => {
							let postOperation = await pending;
							while (retrying(postOperation)) {
								assertRetryAvailable(postOperation);
								attempts++;
								postOperation = await this.pipeline.execute({ prop, args, type: this.type });
							}
							return postOperation;
						};

						let operation = this.pipeline.execute({ prop, args, type: this.type });
						while (!isPromise(operation) && retrying(operation)) {
							assertRetryAvailable(operation);
							attempts++;
							operation = this.pipeline.execute({ prop, args, type: this.type });
						}
						if (isPromise(operation)) operation = continueAsync(operation);
						return handlePromiseOrValue(operation, (postOperation) => postOperation.result);
					});
				};
			},
		};

		return new Proxy(this.target, handler);
	}

	/**
	 * Get the proxy
	 * @returns The proxy
	 */
	get proxy(): T {
		return this._proxy;
	}
}
