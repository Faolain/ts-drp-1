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
 * Each newly linked subtree is initialized once over its newly encountered
 * vertices; later edge changes are constant-time outside bounded collection
 * clear and unknown-method reconciliation.
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

	const unwrap = <V>(value: V): V => {
		if (!isReference(value)) return value;
		return (rawValues.get(value) as V | undefined) ?? value;
	};

	const addDirectOwner = (value: unknown, owner: string): void => {
		if (!isReference(value) || REPLICA_LOCAL_STATE_KEYS.has(owner) || typeof value === "function") return;
		const rawValue = unwrap(value);
		let owners = directOwners.get(rawValue);
		if (!owners) {
			owners = new Set<string>();
			directOwners.set(rawValue, owners);
		}
		owners.add(owner);
	};

	const removeDirectOwner = (value: unknown, owner: string): void => {
		if (!isReference(value)) return;
		const rawValue = unwrap(value);
		const owners = directOwners.get(rawValue);
		owners?.delete(owner);
		if (owners?.size === 0) directOwners.delete(rawValue);
	};

	const addParent = (value: unknown, parent: object): void => {
		if (!isReference(value)) return;
		const rawValue = unwrap(value);
		const rawParent = unwrap(parent);
		let counts = parents.get(rawValue);
		if (!counts) {
			counts = new Map<object, number>();
			parents.set(rawValue, counts);
		}
		counts.set(rawParent, (counts.get(rawParent) ?? 0) + 1);
	};

	const removeParent = (value: unknown, parent: object): void => {
		if (!isReference(value)) return;
		const rawValue = unwrap(value);
		const rawParent = unwrap(parent);
		const counts = parents.get(rawValue);
		const count = counts?.get(rawParent);
		if (count === undefined) return;
		if (count === 1) counts?.delete(rawParent);
		else counts?.set(rawParent, count - 1);
		if (counts?.size === 0) parents.delete(rawValue);
	};

	const initializeGraphs = (roots: readonly unknown[]): void => {
		const discovered = new Set<object>();
		const nodes: object[] = [];
		const edges: Array<readonly [object, object]> = [];
		const normalize: Array<() => void> = [];

		const discover = (candidate: unknown): void => {
			if (!isReference(candidate)) return;
			const value = unwrap(candidate);
			if (initialized.has(value) || discovered.has(value)) return;
			discovered.add(value);
			nodes.push(value);

			if (value instanceof Map) {
				const normalizedEntries = new Map<unknown, unknown>();
				let needsNormalization = false;
				for (const [key, entryValue] of value) {
					const rawKey = unwrap(key);
					const rawEntryValue = unwrap(entryValue);
					normalizedEntries.set(rawKey, rawEntryValue);
					needsNormalization ||= rawKey !== key || rawEntryValue !== entryValue;
				}
				const entries = [...normalizedEntries];
				for (const [rawKey, rawEntryValue] of entries) {
					if (isReference(rawKey)) edges.push([rawKey, value]);
					if (isReference(rawEntryValue)) edges.push([rawEntryValue, value]);
					discover(rawKey);
					discover(rawEntryValue);
				}
				if (needsNormalization) {
					normalize.push(() => {
						Map.prototype.clear.call(value);
						for (const [key, entryValue] of entries) Map.prototype.set.call(value, key, entryValue);
					});
				}
				return;
			}

			if (value instanceof Set) {
				const normalizedEntries = new Set<unknown>();
				let needsNormalization = false;
				for (const entryValue of value) {
					const rawEntryValue = unwrap(entryValue);
					normalizedEntries.add(rawEntryValue);
					needsNormalization ||= rawEntryValue !== entryValue;
				}
				const entries = [...normalizedEntries];
				for (const rawEntryValue of entries) {
					if (isReference(rawEntryValue)) edges.push([rawEntryValue, value]);
					discover(rawEntryValue);
				}
				if (needsNormalization) {
					normalize.push(() => {
						Set.prototype.clear.call(value);
						for (const entryValue of entries) Set.prototype.add.call(value, entryValue);
					});
				}
				return;
			}

			if (value instanceof Date) return;
			for (const key of Object.keys(value)) {
				const child = (value as Record<string, unknown>)[key];
				const rawChild = unwrap(child);
				if (isReference(rawChild)) edges.push([rawChild, value]);
				if (rawChild !== child) {
					const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
					if (descriptor && "value" in descriptor) {
						normalize.push(() => {
							Reflect.defineProperty(value, key, { ...descriptor, value: rawChild });
						});
					}
				}
				discover(rawChild);
			}
		};

		// Discovery may invoke an enumerable accessor or collection iterator.
		// Commit no topology metadata until every root has traversed cleanly.
		for (const root of roots) discover(root);
		for (const apply of normalize) apply();
		for (const [child, parent] of edges) addParent(child, parent);
		for (const node of nodes) initialized.add(node);
	};

	const initializeGraph = (value: unknown): void => initializeGraphs([value]);

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
		const pending = [unwrap(value)];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			for (const key of directOwners.get(current) ?? []) changedKeys.add(key);
			for (const parent of parents.get(current)?.keys() ?? []) pending.push(parent);
		}
	};

	const markChanged = (owner: object, property?: PropertyKey): void => {
		const rawOwner = unwrap(owner);
		if (rawOwner === target && typeof property === "string") {
			if (!REPLICA_LOCAL_STATE_KEYS.has(property)) changedKeys.add(property);
			return;
		}
		captureOwners(rawOwner);
	};

	const updateReachability = (
		owner: object,
		property: PropertyKey | undefined,
		previous: unknown,
		next: unknown
	): void => {
		const rawOwner = unwrap(owner);
		const rawPrevious = unwrap(previous);
		const rawNext = unwrap(next);
		if (Object.is(rawPrevious, rawNext)) {
			initializeGraph(rawNext);
			return;
		}
		if (rawOwner === target && typeof property === "string") {
			removeDirectOwner(rawPrevious, property);
			addDirectOwner(rawNext, property);
			initializeGraph(rawNext);
			return;
		}
		removeParent(rawPrevious, rawOwner);
		addParent(rawNext, rawOwner);
		initializeGraph(rawNext);
	};

	const snapshotMapEntries = (map: Map<unknown, unknown>): Array<[unknown, unknown]> =>
		Array.from(Map.prototype.entries.call(map) as MapIterator<[unknown, unknown]>);

	const snapshotSetValues = (set: Set<unknown>): unknown[] =>
		Array.from(Set.prototype.values.call(set) as SetIterator<unknown>);

	const reconcileMapParents = (map: Map<unknown, unknown>, previous: Iterable<readonly [unknown, unknown]>): void => {
		const next = snapshotMapEntries(map);
		for (const [key, value] of previous) {
			removeParent(key, map);
			removeParent(value, map);
		}
		for (const [key, value] of next) {
			addParent(key, map);
			addParent(value, map);
		}
		initializeGraphs(next.flatMap(([key, value]) => [key, value]));
	};

	const reconcileSetParents = (set: Set<unknown>, previous: Iterable<unknown>): void => {
		const next = snapshotSetValues(set);
		for (const value of previous) removeParent(value, set);
		for (const value of next) addParent(value, set);
		initializeGraphs(next);
	};

	const wrap = <V>(value: V, ignored = false): V => {
		if (!isReference(value)) return value;
		const objectValue = unwrap(value) as object;
		if (objectValue !== (target as object)) initializeGraph(objectValue);
		const proxyCache = ignored ? ignoredProxies : trackedProxies;
		const existing = proxyCache.get(objectValue);
		if (existing) return existing as V;

		let proxy: object;
		if (objectValue instanceof Map) {
			proxy = new Proxy(objectValue, {
				get(map, property): unknown {
					if (property === "set") {
						return (key: unknown, nextValue: unknown): Map<unknown, unknown> => {
							const rawKey = unwrap(key);
							const rawValue = unwrap(nextValue);
							initializeGraphs([rawKey, rawValue]);
							const hadKey = map.has(rawKey);
							const previousValue = map.get(rawKey);
							const didChange = !hadKey || !valuesEqual(previousValue, rawValue);
							map.set(rawKey, rawValue);
							if (!hadKey) {
								addParent(rawKey, map);
								initializeGraph(rawKey);
							}
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
						const previous = snapshotMapEntries(map);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							result = (member as (...values: unknown[]) => unknown).apply(map, args.map(unwrap));
						} catch (error) {
							operationError = error;
							operationFailed = true;
						}
						let reconciliationError: unknown;
						let reconciliationFailed = false;
						try {
							reconcileMapParents(map, previous);
						} catch (error) {
							reconciliationError = error;
							reconciliationFailed = true;
						} finally {
							markChanged(map);
						}
						if (operationFailed) throw operationError;
						if (reconciliationFailed) throw reconciliationError;
						return result === map ? proxy : wrap(result, ignored);
					};
				},
			});
		} else if (objectValue instanceof Set) {
			proxy = new Proxy(objectValue, {
				get(set, property): unknown {
					if (property === "add") {
						return (nextValue: unknown): Set<unknown> => {
							const rawValue = unwrap(nextValue);
							initializeGraph(rawValue);
							const didChange = !set.has(rawValue);
							set.add(rawValue);
							if (didChange) {
								addParent(rawValue, set);
								initializeGraph(rawValue);
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
						const previous = snapshotSetValues(set);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							result = (member as (...values: unknown[]) => unknown).apply(set, args.map(unwrap));
						} catch (error) {
							operationError = error;
							operationFailed = true;
						}
						let reconciliationError: unknown;
						let reconciliationFailed = false;
						try {
							reconcileSetParents(set, previous);
						} catch (error) {
							reconciliationError = error;
							reconciliationFailed = true;
						} finally {
							markChanged(set);
						}
						if (operationFailed) throw operationError;
						if (reconciliationFailed) throw reconciliationError;
						return result === set ? proxy : wrap(result, ignored);
					};
				},
			});
		} else if (objectValue instanceof Date) {
			proxy = new Proxy(objectValue, {
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
						ignored ||
						(object === (target as object) && typeof property === "string" && REPLICA_LOCAL_STATE_KEYS.has(property));
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
						updateReachability(object, property, previousValue, resultingValue);
						const didChange = !valuesEqual(previousValue, resultingValue);
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
