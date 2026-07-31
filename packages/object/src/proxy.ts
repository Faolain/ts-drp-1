import { type DrpType, type IDRP } from "@ts-drp/types";
import { handlePromiseOrValue, isPromise } from "@ts-drp/utils";
import { deepEqual } from "fast-equals";

import { AdoptionCommitExhaustedError } from "./errors.js";
import { MAX_ADOPTION_COMMIT_ATTEMPTS, type PostOperation } from "./operation.js";
import { type Pipeline } from "./pipeline/pipeline.js";

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
	let changed = false;
	const trackedProxies = new WeakMap<object, object>();
	const ignoredProxies = new WeakMap<object, object>();
	const rawValues = new WeakMap<object, object>();

	const unwrap = <V>(value: V): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		return (rawValues.get(value as object) as V | undefined) ?? value;
	};

	const wrap = <V>(value: V, ignored = false): V => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
		const objectValue = value as object;
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
							if (!ignored && (!map.has(rawKey) || !deepEqual(map.get(rawKey), rawValue))) changed = true;
							map.set(rawKey, rawValue);
							return proxy as Map<unknown, unknown>;
						};
					}
					if (property === "get") return (key: unknown): unknown => wrap(map.get(unwrap(key)), ignored);
					if (property === "has") return (key: unknown): boolean => map.has(unwrap(key));
					if (property === "delete") {
						return (key: unknown): boolean => {
							const rawKey = unwrap(key);
							if (!ignored && map.has(rawKey)) changed = true;
							return map.delete(rawKey);
						};
					}
					if (property === "clear") {
						return (): void => {
							if (!ignored && map.size > 0) changed = true;
							map.clear();
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
							for (const entryValue of map.values()) yield wrap(entryValue, ignored);
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
						if (!ignored) changed = true;
						const result = (member as (...values: unknown[]) => unknown).apply(map, args.map(unwrap));
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
							if (!ignored && !set.has(rawValue)) changed = true;
							set.add(rawValue);
							return proxy as Set<unknown>;
						};
					}
					if (property === "has") return (nextValue: unknown): boolean => set.has(unwrap(nextValue));
					if (property === "delete") {
						return (nextValue: unknown): boolean => {
							const rawValue = unwrap(nextValue);
							if (!ignored && set.has(rawValue)) changed = true;
							return set.delete(rawValue);
						};
					}
					if (property === "clear") {
						return (): void => {
							if (!ignored && set.size > 0) changed = true;
							set.clear();
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
						if (!ignored) changed = true;
						const result = (member as (...values: unknown[]) => unknown).apply(set, args.map(unwrap));
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
						if (!ignored && property.toString().startsWith("set") && !Object.is(date.getTime(), before)) changed = true;
						return result;
					};
				},
			});
		} else {
			proxy = new Proxy(objectValue, {
				get(object, property, receiver): unknown {
					const nestedIgnored = ignored || (object === target && property === "context");
					const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) return descriptor.value;
						if ("get" in descriptor && descriptor.get === undefined) return undefined;
					}
					return wrap(Reflect.get(object, property, receiver), nestedIgnored);
				},
				set(object, property, nextValue): boolean {
					const rawValue = unwrap(nextValue);
					if (!ignored && !deepEqual(Reflect.get(object, property, object), rawValue)) changed = true;
					return Reflect.set(object, property, rawValue, object);
				},
				deleteProperty(object, property): boolean {
					if (!ignored && Reflect.has(object, property)) changed = true;
					return Reflect.deleteProperty(object, property);
				},
				defineProperty(object, property, descriptor): boolean {
					if (!ignored) changed = true;
					const rawDescriptor = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor;
					return Reflect.defineProperty(object, property, rawDescriptor);
				},
			});
		}

		proxyCache.set(objectValue, proxy);
		rawValues.set(proxy, objectValue);
		return proxy as V;
	};

	return { proxy: wrap(target), hasChanges: () => changed };
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
						const retrying = (postOperation: PostOperation<IDRP>): boolean =>
							postOperation.commitOutcome === "retry" || postOperation.commitOutcome === "duplicate";
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
