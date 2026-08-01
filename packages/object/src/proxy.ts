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
 * compared at the written key/value. Raw objects that actually change are
 * charged against governed owners reachable at the mutation event. A reverse
 * object graph is maintained incrementally, so observations do not rescan the
 * owner graph and later topology changes cannot rewrite earlier attribution.
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
	const directOwners = new WeakMap<object, Set<string>>();
	const parents = new WeakMap<object, Map<object, number>>();
	const initialized = new WeakSet<object>();

	const isReference = (value: unknown): value is object =>
		(typeof value === "object" || typeof value === "function") && value !== null;

	const addDirectOwner = (value: unknown, owner: string): void => {
		if (!isReference(value) || REPLICA_LOCAL_STATE_KEYS.has(owner) || typeof value === "function") return;
		let owners = directOwners.get(value);
		if (!owners) {
			owners = new Set<string>();
			directOwners.set(value, owners);
		}
		owners.add(owner);
	};

	const removeDirectOwner = (value: unknown, owner: string): void => {
		if (!isReference(value)) return;
		const owners = directOwners.get(value);
		owners?.delete(owner);
		if (owners?.size === 0) directOwners.delete(value);
	};

	const addParent = (value: unknown, parent: object): void => {
		if (!isReference(value)) return;
		let counts = parents.get(value);
		if (!counts) {
			counts = new Map<object, number>();
			parents.set(value, counts);
		}
		counts.set(parent, (counts.get(parent) ?? 0) + 1);
	};

	const removeParent = (value: unknown, parent: object): void => {
		if (!isReference(value)) return;
		const counts = parents.get(value);
		const count = counts?.get(parent);
		if (count === undefined) return;
		if (count === 1) counts?.delete(parent);
		else counts?.set(parent, count - 1);
		if (counts?.size === 0) parents.delete(value);
	};

	const initializeGraph = (value: unknown): void => {
		if (!isReference(value) || initialized.has(value)) return;
		initialized.add(value);
		if (value instanceof Map) {
			for (const [key, entryValue] of value) {
				addParent(key, value);
				addParent(entryValue, value);
				initializeGraph(key);
				initializeGraph(entryValue);
			}
			return;
		}
		if (value instanceof Set) {
			for (const entryValue of value) {
				addParent(entryValue, value);
				initializeGraph(entryValue);
			}
			return;
		}
		if (value instanceof Date) return;
		for (const key of Object.keys(value)) {
			const child = (value as Record<string, unknown>)[key];
			addParent(child, value);
			initializeGraph(child);
		}
	};

	for (const key of Object.keys(target)) {
		const value = (target as Record<string, unknown>)[key];
		addDirectOwner(value, key);
		initializeGraph(value);
	}

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

	const captureOwners = (value: object): void => {
		const visited = new Set<object>();
		const pending = [value];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			for (const key of directOwners.get(current) ?? []) changedKeys.add(key);
			for (const parent of parents.get(current)?.keys() ?? []) pending.push(parent);
		}
	};

	const markChanged = (owner: object, property?: PropertyKey): void => {
		if (owner === target && typeof property === "string") {
			if (!REPLICA_LOCAL_STATE_KEYS.has(property)) changedKeys.add(property);
			return;
		}
		captureOwners(owner);
	};

	const updateReachability = (
		owner: object,
		property: PropertyKey | undefined,
		previous: unknown,
		next: unknown
	): void => {
		if (Object.is(previous, next)) return;
		if (owner === target && typeof property === "string") {
			removeDirectOwner(previous, property);
			addDirectOwner(next, property);
			return;
		}
		removeParent(previous, owner);
		addParent(next, owner);
	};

	const reconcileMapParents = (map: Map<unknown, unknown>, previous: Iterable<readonly [unknown, unknown]>): void => {
		for (const [key, value] of previous) {
			removeParent(key, map);
			removeParent(value, map);
		}
		for (const [key, value] of map) {
			addParent(key, map);
			addParent(value, map);
		}
	};

	const reconcileSetParents = (set: Set<unknown>, previous: Iterable<unknown>): void => {
		for (const value of previous) removeParent(value, set);
		for (const value of set) addParent(value, set);
	};

	const unwrap = <V>(value: V): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		return (rawValues.get(value as object) as V | undefined) ?? value;
	};

	const wrap = <V>(value: V, ignored = false): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		const objectValue = value as object;
		if (objectValue !== target) initializeGraph(objectValue);
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
							const hadKey = map.has(rawKey);
							const previousValue = map.get(rawKey);
							const didChange = !hadKey || !valuesEqual(previousValue, rawValue);
							map.set(rawKey, rawValue);
							if (!hadKey) addParent(rawKey, map);
							updateReachability(map, undefined, previousValue, rawValue);
							if (didChange) markChanged(map);
							return proxy as Map<unknown, unknown>;
						};
					}
					if (property === "get") {
						return (key: unknown): unknown => wrap(map.get(unwrap(key)), ignored);
					}
					if (property === "has") return (key: unknown): boolean => map.has(unwrap(key));
					if (property === "delete") {
						return (key: unknown): boolean => {
							const rawKey = unwrap(key);
							const previousValue = map.get(rawKey);
							const deleted = map.delete(rawKey);
							if (deleted) {
								removeParent(rawKey, map);
								removeParent(previousValue, map);
								markChanged(map);
							}
							return deleted;
						};
					}
					if (property === "clear") {
						return (): void => {
							const hadEntries = map.size > 0;
							if (hadEntries) {
								for (const [key, entryValue] of map) {
									removeParent(key, map);
									removeParent(entryValue, map);
								}
							}
							map.clear();
							if (hadEntries) markChanged(map);
						};
					}
					if (property === Symbol.iterator || property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const [key, entryValue] of map.entries()) {
								yield [wrap(key, ignored), wrap(entryValue, ignored)];
							}
						};
					}
					if (property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const key of map.keys()) yield wrap(key, ignored);
						};
					}
					if (property === "values") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of map.values()) {
								yield wrap(entryValue, ignored);
							}
						};
					}
					if (property === "forEach") {
						return (
							callback: (entryValue: unknown, key: unknown, collection: Map<unknown, unknown>) => void,
							thisArg?: unknown
						): void => {
							map.forEach((entryValue, key) => {
								callback.call(thisArg, wrap(entryValue, ignored), wrap(key, ignored), proxy as Map<unknown, unknown>);
							});
						};
					}
					const member = Reflect.get(map, property, map) as unknown;
					if (typeof member !== "function") return member;
					return (...args: unknown[]): unknown => {
						const previous = [...map.entries()];
						let result: unknown;
						try {
							result = (member as (...values: unknown[]) => unknown).apply(map, args.map(unwrap));
						} finally {
							reconcileMapParents(map, previous);
							markChanged(map);
						}
						return result === map ? proxy : wrap(result, ignored);
					};
				},
			});
		} else if (value instanceof Set) {
			proxy = new Proxy(value, {
				get(set, property): unknown {
					if (property === "add") {
						return (nextValue: unknown): Set<unknown> => {
							const rawValue = unwrap(nextValue);
							const didChange = !set.has(rawValue);
							set.add(rawValue);
							if (didChange) {
								addParent(rawValue, set);
								markChanged(set);
							}
							return proxy as Set<unknown>;
						};
					}
					if (property === "has") return (nextValue: unknown): boolean => set.has(unwrap(nextValue));
					if (property === "delete") {
						return (nextValue: unknown): boolean => {
							const rawValue = unwrap(nextValue);
							const deleted = set.delete(rawValue);
							if (deleted) {
								removeParent(rawValue, set);
								markChanged(set);
							}
							return deleted;
						};
					}
					if (property === "clear") {
						return (): void => {
							const hadEntries = set.size > 0;
							if (hadEntries) {
								for (const entryValue of set) removeParent(entryValue, set);
							}
							set.clear();
							if (hadEntries) markChanged(set);
						};
					}
					if (property === Symbol.iterator || property === "values" || property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of set.values()) yield wrap(entryValue, ignored);
						};
					}
					if (property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const entryValue of set.values()) {
								const wrapped = wrap(entryValue, ignored);
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
								const wrapped = wrap(entryValue, ignored);
								callback.call(thisArg, wrapped, wrapped, proxy as Set<unknown>);
							});
						};
					}
					const member = Reflect.get(set, property, set) as unknown;
					if (typeof member !== "function") return member;
					return (...args: unknown[]): unknown => {
						const previous = [...set.values()];
						let result: unknown;
						try {
							result = (member as (...values: unknown[]) => unknown).apply(set, args.map(unwrap));
						} finally {
							reconcileSetParents(set, previous);
							markChanged(set);
						}
						return result === set ? proxy : wrap(result, ignored);
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
						if (property.toString().startsWith("set") && !Object.is(date.getTime(), before)) {
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
					return wrap(Reflect.get(object, property, receiver), nestedIgnored);
				},
				set(object, property, nextValue): boolean {
					const rawValue = unwrap(nextValue);
					const previousValue = Reflect.get(object, property, object);
					const assigned = Reflect.set(object, property, rawValue, object);
					if (assigned) {
						const resultingValue = Reflect.get(object, property, object);
						const didChange = !valuesEqual(previousValue, resultingValue);
						updateReachability(object, property, previousValue, resultingValue);
						if (didChange) markChanged(object, property);
					}
					return assigned;
				},
				deleteProperty(object, property): boolean {
					const existed = Reflect.has(object, property);
					const previousValue = Reflect.get(object, property, object);
					const deleted = Reflect.deleteProperty(object, property);
					if (deleted && existed) {
						updateReachability(object, property, previousValue, undefined);
						markChanged(object, property);
					}
					return deleted;
				},
				defineProperty(object, property, descriptor): boolean {
					const rawDescriptor = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor;
					const previousValue = Reflect.get(object, property, object);
					const defined = Reflect.defineProperty(object, property, rawDescriptor);
					if (defined) {
						const resultingValue = Reflect.get(object, property, object);
						updateReachability(object, property, previousValue, resultingValue);
						markChanged(object, property);
					}
					return defined;
				},
			});
		}

		proxyCache.set(objectValue, proxy);
		rawValues.set(proxy, objectValue);
		return proxy as V;
	};

	return {
		proxy: wrap(target),
		hasChanges: (): boolean => changedKeys.size > 0,
		changedKeys: (): ReadonlySet<string> => changedKeys,
	};
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
