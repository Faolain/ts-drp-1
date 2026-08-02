import { type DrpType, type IDRP } from "@ts-drp/types";
import { handlePromiseOrValue, isPromise } from "@ts-drp/utils";

import { AdoptionCommitExhaustedError } from "./errors.js";
import { MAX_ADOPTION_COMMIT_ATTEMPTS, type PostOperation } from "./operation.js";
import { type Pipeline } from "./pipeline/pipeline.js";
import { proxyValuesEqual } from "./publication/copy-capability.js";
import { REPLICA_LOCAL_STATE_KEYS } from "./state-store.js";

const DATE_GET_TIME = Date.prototype.getTime;
const DATE_NATIVE_MEMBERS = new Map<PropertyKey, unknown>();
for (const property of Reflect.ownKeys(Date.prototype)) {
	if (property === "constructor") continue;
	const descriptor = Reflect.getOwnPropertyDescriptor(Date.prototype, property);
	if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
		DATE_NATIVE_MEMBERS.set(property, descriptor.value);
	}
}

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
	/** True after tracked handling observes a governed raw-reference-capable boundary. */
	hasRawEgress(): boolean;
	/** Record a later, explicit operation boundary without making dirty readers scan. */
	observeRawEgressBoundary(): void;
	/** Candidate names observed before the publisher applies its governed-key filter. */
	rawEgressCandidateKeys(): ReadonlySet<string>;
}

type MutationValueComparator = (left: unknown, right: unknown, key: string) => boolean;

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
 * @param compareValues - Sole value-comparison authority
 * @returns A proxy and a cheap dirty-state reader.
 */
export function trackMutations<T extends object>(
	target: T,
	compareValues: MutationValueComparator = proxyValuesEqual
): MutationTrackingResult<T> {
	const changedKeys = new Set<string>();
	const rawEgressKeys = new Set<string>();
	const initialGovernedKeys = new Set<string>();
	let rawEgress = false;
	const trackedProxies = new WeakMap<object, object>();
	const ignoredProxies = new WeakMap<object, object>();
	const rawValues = new WeakMap<object, object>();
	const directOwners = new WeakMap<object, Set<string>>();
	const parents = new WeakMap<object, Map<object, number>>();
	const initialized = new WeakSet<object>();

	const isReference = (value: unknown): value is object =>
		(typeof value === "object" || typeof value === "function") && value !== null;

	const descriptorExposesReference = (descriptor: PropertyDescriptor): boolean =>
		("value" in descriptor && isReference(descriptor.value)) ||
		("get" in descriptor && (isReference(descriptor.get) || isReference(descriptor.set)));

	const observeOwnDescriptor = (
		owner: object,
		property: PropertyKey,
		ignored: boolean
	): PropertyDescriptor | undefined => {
		const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
		if (!ignored && descriptor !== undefined && descriptorExposesReference(descriptor)) signalRawEgress();
		return descriptor;
	};

	const observeRawEgressBoundary = (): void => {
		if (!rawEgress) return;
		for (const key of Object.keys(target)) {
			if (!REPLICA_LOCAL_STATE_KEYS.has(key)) rawEgressKeys.add(key);
		}
	};

	const signalRawEgress = (): void => {
		if (rawEgress) return;
		// Keep invariant handling shape-independent: primitive frozen values and
		// undefined getters conservatively widen just like raw references.
		rawEgress = true;
		for (const key of initialGovernedKeys) rawEgressKeys.add(key);
		for (const key of changedKeys) rawEgressKeys.add(key);
	};

	const unwrap = <V>(value: V): V => {
		if (!isReference(value)) return value;
		return (rawValues.get(value) as V | undefined) ?? value;
	};

	const isGovernedProxy = (value: unknown): value is object => {
		if (!isReference(value)) return false;
		const rawValue = rawValues.get(value);
		return rawValue !== undefined && trackedProxies.get(rawValue) === value;
	};

	const snapshotMapEntries = (map: Map<unknown, unknown>): Array<[unknown, unknown]> =>
		Array.from(Map.prototype.entries.call(map) as MapIterator<[unknown, unknown]>);

	const snapshotSetValues = (set: Set<unknown>): unknown[] =>
		Array.from(Set.prototype.values.call(set) as SetIterator<unknown>);

	const canonicalMapSnapshot = (
		map: Map<unknown, unknown>
	): { entries: Array<[unknown, unknown]>; needsNormalization: boolean } => {
		const canonical = new Map<unknown, unknown>();
		let needsNormalization = false;
		for (const [key, value] of snapshotMapEntries(map)) {
			const rawKey = unwrap(key);
			const rawValue = unwrap(value);
			needsNormalization ||= rawKey !== key || rawValue !== value || canonical.has(rawKey);
			Map.prototype.set.call(canonical, rawKey, rawValue);
		}
		return { entries: snapshotMapEntries(canonical), needsNormalization };
	};

	const canonicalSetSnapshot = (set: Set<unknown>): { values: unknown[]; needsNormalization: boolean } => {
		const canonical = new Set<unknown>();
		let needsNormalization = false;
		for (const value of snapshotSetValues(set)) {
			const rawValue = unwrap(value);
			needsNormalization ||= rawValue !== value || canonical.has(rawValue);
			Set.prototype.add.call(canonical, rawValue);
		}
		return { values: snapshotSetValues(canonical), needsNormalization };
	};

	const replaceMapEntries = (map: Map<unknown, unknown>, entries: ReadonlyArray<readonly [unknown, unknown]>): void => {
		Map.prototype.clear.call(map);
		for (const [key, value] of entries) Map.prototype.set.call(map, key, value);
	};

	const replaceSetValues = (set: Set<unknown>, values: readonly unknown[]): void => {
		Set.prototype.clear.call(set);
		for (const value of values) Set.prototype.add.call(set, value);
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
				const { entries, needsNormalization } = canonicalMapSnapshot(value);
				for (const [rawKey, rawEntryValue] of entries) {
					if (isReference(rawKey)) edges.push([rawKey, value]);
					if (isReference(rawEntryValue)) edges.push([rawEntryValue, value]);
					discover(rawKey);
					discover(rawEntryValue);
				}
				if (needsNormalization) {
					normalize.push(() => replaceMapEntries(value, entries));
				}
				return;
			}

			if (value instanceof Set) {
				const { values, needsNormalization } = canonicalSetSnapshot(value);
				for (const rawEntryValue of values) {
					if (isReference(rawEntryValue)) edges.push([rawEntryValue, value]);
					discover(rawEntryValue);
				}
				if (needsNormalization) {
					normalize.push(() => replaceSetValues(value, values));
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
		if (!REPLICA_LOCAL_STATE_KEYS.has(key)) initialGovernedKeys.add(key);
		const value = (target as Record<string, unknown>)[key];
		addDirectOwner(value, key);
		initializeGraph(value);
	}

	const comparisonKey = (owner: object, property?: PropertyKey): string => {
		const rawOwner = unwrap(owner);
		if (rawOwner === target && typeof property === "string" && !REPLICA_LOCAL_STATE_KEYS.has(property)) {
			return property;
		}
		const keys = new Set<string>();
		const visited = new Set<object>();
		const pending = [rawOwner];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			for (const key of directOwners.get(current) ?? []) keys.add(key);
			for (const parent of parents.get(current)?.keys() ?? []) pending.push(parent);
		}
		return [...keys].sort()[0] ?? (typeof property === "string" ? property : "<collection>");
	};

	const valuesEqual = (left: unknown, right: unknown, owner: object, property?: PropertyKey): boolean =>
		compareValues(left, right, comparisonKey(owner, property));

	const inheritedPropertyDescriptor = (owner: object, property: PropertyKey): PropertyDescriptor | undefined => {
		let current = Reflect.getPrototypeOf(owner) as object | null;
		while (current !== null) {
			const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
			if (descriptor !== undefined) return descriptor;
			current = Reflect.getPrototypeOf(current) as object | null;
		}
		return undefined;
	};

	const dataDescriptorValue = (descriptor: PropertyDescriptor | undefined): unknown =>
		descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;

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

	const captureRetainedMapEntryOwners = (
		previous: ReadonlyArray<readonly [unknown, unknown]>,
		next: ReadonlyArray<readonly [unknown, unknown]>
	): void => {
		const retained = new Set<object>();
		for (const [key, value] of next) {
			if (isReference(key)) retained.add(unwrap(key));
			if (isReference(value)) retained.add(unwrap(value));
		}
		for (const [key, value] of previous) {
			if (isReference(key) && retained.has(unwrap(key))) captureOwners(unwrap(key));
			if (isReference(value) && retained.has(unwrap(value))) captureOwners(unwrap(value));
		}
	};

	const captureRetainedSetEntryOwners = (previous: readonly unknown[], next: readonly unknown[]): void => {
		const retained = new Set<object>();
		for (const value of next) {
			if (isReference(value)) retained.add(unwrap(value));
		}
		for (const value of previous) {
			if (isReference(value) && retained.has(unwrap(value))) captureOwners(unwrap(value));
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

	const finalizeCommittedWrite = (
		owner: object,
		property: PropertyKey,
		previousDescriptor: PropertyDescriptor | undefined,
		compareDataValues: boolean
	): void => {
		try {
			const resultingDescriptor = Reflect.getOwnPropertyDescriptor(owner, property);
			const previous = dataDescriptorValue(previousDescriptor);
			const resulting = dataDescriptorValue(resultingDescriptor);
			updateReachability(owner, property, previous, resulting);
			const bothDataDescriptors =
				previousDescriptor !== undefined &&
				"value" in previousDescriptor &&
				resultingDescriptor !== undefined &&
				"value" in resultingDescriptor;
			if (!compareDataValues || !bothDataDescriptors || !valuesEqual(previous, resulting, owner, property)) {
				markChanged(owner, property);
			}
		} catch (error) {
			// Reflection has already committed. Charge the owner even when later
			// equality or graph discovery fails, then preserve the exact throwable.
			markChanged(owner, property);
			throw error;
		}
	};

	const canonicalizeMapEntries = (map: Map<unknown, unknown>): Array<[unknown, unknown]> => {
		const { entries, needsNormalization } = canonicalMapSnapshot(map);
		if (needsNormalization) replaceMapEntries(map, entries);
		return entries;
	};

	const canonicalizeSetValues = (set: Set<unknown>): unknown[] => {
		const { values, needsNormalization } = canonicalSetSnapshot(set);
		if (needsNormalization) replaceSetValues(set, values);
		return values;
	};

	const reconcileMapParents = (map: Map<unknown, unknown>, previous: Iterable<readonly [unknown, unknown]>): void => {
		const previousEntries = Array.from(previous);
		const next = canonicalizeMapEntries(map);
		captureRetainedMapEntryOwners(previousEntries, next);
		for (const [key, value] of previousEntries) {
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
		const previousValues = Array.from(previous);
		const next = canonicalizeSetValues(set);
		captureRetainedSetEntryOwners(previousValues, next);
		for (const value of previousValues) removeParent(value, set);
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
				getOwnPropertyDescriptor(map, property): PropertyDescriptor | undefined {
					return observeOwnDescriptor(map, property, ignored);
				},
				get(map, property): unknown {
					const descriptor = Reflect.getOwnPropertyDescriptor(map, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!ignored) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!ignored) signalRawEgress();
							return undefined;
						}
					}
					if (property === "set") {
						return (key: unknown, nextValue: unknown): Map<unknown, unknown> => {
							const rawKey = unwrap(key);
							const rawValue = unwrap(nextValue);
							initializeGraphs([rawKey, rawValue]);
							const hadKey = Map.prototype.has.call(map, rawKey);
							const previousValue = Map.prototype.get.call(map, rawKey);
							const didChange = !hadKey || !valuesEqual(previousValue, rawValue, map);
							Map.prototype.set.call(map, rawKey, rawValue);
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
						return (key: unknown): unknown => wrap(Map.prototype.get.call(map, unwrap(key)), ignored);
					}
					if (property === "has") {
						return (key: unknown): boolean => Map.prototype.has.call(map, unwrap(key));
					}
					if (property === "delete") {
						return (key: unknown): boolean => {
							const rawKey = unwrap(key);
							const previousValue = Map.prototype.get.call(map, rawKey);
							const deleted = Map.prototype.delete.call(map, rawKey);
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
							const previous = snapshotMapEntries(map);
							Map.prototype.clear.call(map);
							for (const [key, entryValue] of previous) {
								removeParent(key, map);
								removeParent(entryValue, map);
							}
							if (previous.length > 0) markChanged(map);
						};
					}
					if (property === Symbol.iterator || property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const [key, entryValue] of Map.prototype.entries.call(map)) {
								yield [wrap(key, ignored), wrap(entryValue, ignored)];
							}
						};
					}
					if (property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const key of Map.prototype.keys.call(map)) yield wrap(key, ignored);
						};
					}
					if (property === "values") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of Map.prototype.values.call(map)) {
								yield wrap(entryValue, ignored);
							}
						};
					}
					if (property === "forEach") {
						return (
							callback: (entryValue: unknown, key: unknown, collection: Map<unknown, unknown>) => void,
							thisArg?: unknown
						): void => {
							Map.prototype.forEach.call(map, (entryValue, key) => {
								callback.call(thisArg, wrap(entryValue, ignored), wrap(key, ignored), proxy as Map<unknown, unknown>);
							});
						};
					}
					const member = Reflect.get(map, property, map) as unknown;
					if (typeof member !== "function") return wrap(member, ignored);
					return (...args: unknown[]): unknown => {
						const previous = snapshotMapEntries(map);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!ignored) signalRawEgress();
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
						let observationError: unknown;
						let observationFailed = false;
						try {
							observeRawEgressBoundary();
						} catch (error) {
							observationError = error;
							observationFailed = true;
						}
						if (operationFailed) throw operationError;
						if (reconciliationFailed) throw reconciliationError;
						if (observationFailed) throw observationError;
						return result === map ? proxy : wrap(result, ignored);
					};
				},
			});
		} else if (objectValue instanceof Set) {
			proxy = new Proxy(objectValue, {
				getOwnPropertyDescriptor(set, property): PropertyDescriptor | undefined {
					return observeOwnDescriptor(set, property, ignored);
				},
				get(set, property): unknown {
					const descriptor = Reflect.getOwnPropertyDescriptor(set, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!ignored) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!ignored) signalRawEgress();
							return undefined;
						}
					}
					if (property === "add") {
						return (nextValue: unknown): Set<unknown> => {
							const rawValue = unwrap(nextValue);
							initializeGraph(rawValue);
							const didChange = !Set.prototype.has.call(set, rawValue);
							Set.prototype.add.call(set, rawValue);
							if (didChange) {
								addParent(rawValue, set);
								initializeGraph(rawValue);
								markChanged(set);
							}
							return proxy as Set<unknown>;
						};
					}
					if (property === "has") {
						return (nextValue: unknown): boolean => Set.prototype.has.call(set, unwrap(nextValue));
					}
					if (property === "delete") {
						return (nextValue: unknown): boolean => {
							const rawValue = unwrap(nextValue);
							const deleted = Set.prototype.delete.call(set, rawValue);
							if (deleted) {
								removeParent(rawValue, set);
								markChanged(set);
							}
							return deleted;
						};
					}
					if (property === "clear") {
						return (): void => {
							const previous = snapshotSetValues(set);
							Set.prototype.clear.call(set);
							for (const entryValue of previous) removeParent(entryValue, set);
							if (previous.length > 0) markChanged(set);
						};
					}
					if (property === Symbol.iterator || property === "values" || property === "keys") {
						return function* (): IterableIterator<unknown> {
							for (const entryValue of Set.prototype.values.call(set)) yield wrap(entryValue, ignored);
						};
					}
					if (property === "entries") {
						return function* (): IterableIterator<[unknown, unknown]> {
							for (const entryValue of Set.prototype.values.call(set)) {
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
							Set.prototype.forEach.call(set, (entryValue) => {
								const wrapped = wrap(entryValue, ignored);
								callback.call(thisArg, wrapped, wrapped, proxy as Set<unknown>);
							});
						};
					}
					const member = Reflect.get(set, property, set) as unknown;
					if (typeof member !== "function") return wrap(member, ignored);
					return (...args: unknown[]): unknown => {
						const previous = snapshotSetValues(set);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!ignored) signalRawEgress();
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
						let observationError: unknown;
						let observationFailed = false;
						try {
							observeRawEgressBoundary();
						} catch (error) {
							observationError = error;
							observationFailed = true;
						}
						if (operationFailed) throw operationError;
						if (reconciliationFailed) throw reconciliationError;
						if (observationFailed) throw observationError;
						return result === set ? proxy : wrap(result, ignored);
					};
				},
			});
		} else if (objectValue instanceof Date) {
			proxy = new Proxy(objectValue, {
				getOwnPropertyDescriptor(date, property): PropertyDescriptor | undefined {
					return observeOwnDescriptor(date, property, ignored);
				},
				get(date, property): unknown {
					const descriptor = Reflect.getOwnPropertyDescriptor(date, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!ignored) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!ignored) signalRawEgress();
							return undefined;
						}
					}
					const beforeResolution = Reflect.apply(DATE_GET_TIME, date, []);
					let member: unknown;
					let resolutionError: unknown;
					let resolutionFailed = false;
					try {
						member = Reflect.get(date, property, date) as unknown;
					} catch (error) {
						resolutionError = error;
						resolutionFailed = true;
					}
					if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), beforeResolution)) markChanged(date);
					if (resolutionFailed) throw resolutionError;
					if (typeof member !== "function") return wrap(member, ignored);
					const isNativeDateMember = DATE_NATIVE_MEMBERS.get(property) === member;
					return (...args: unknown[]): unknown => {
						const before = Reflect.apply(DATE_GET_TIME, date, []);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!ignored && !isNativeDateMember) signalRawEgress();
							result = (member as (...values: unknown[]) => unknown).apply(date, args.map(unwrap));
						} catch (error) {
							operationError = error;
							operationFailed = true;
						}
						if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), before)) markChanged(date);
						let observationError: unknown;
						let observationFailed = false;
						if (!isNativeDateMember) {
							try {
								observeRawEgressBoundary();
							} catch (error) {
								observationError = error;
								observationFailed = true;
							}
						}
						if (operationFailed) throw operationError;
						if (observationFailed) throw observationError;
						return result === date ? proxy : wrap(result, ignored);
					};
				},
				set(date, property, nextValue): boolean {
					const storesGovernedProxy = !ignored && isGovernedProxy(nextValue);
					const before = Reflect.apply(DATE_GET_TIME, date, []);
					try {
						const stored = Reflect.set(date, property, unwrap(nextValue), date);
						if (stored && storesGovernedProxy) signalRawEgress();
						return stored;
					} catch (error) {
						// An accessor may retain or mutate the raw value before throwing.
						if (storesGovernedProxy) signalRawEgress();
						throw error;
					} finally {
						if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), before)) markChanged(date);
					}
				},
				deleteProperty(date, property): boolean {
					const before = Reflect.apply(DATE_GET_TIME, date, []);
					try {
						return Reflect.deleteProperty(date, property);
					} finally {
						if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), before)) markChanged(date);
					}
				},
				defineProperty(date, property, descriptor): boolean {
					const storesGovernedProxy = !ignored && "value" in descriptor && isGovernedProxy(descriptor.value);
					const rawDescriptor = { ...descriptor };
					if ("value" in descriptor) rawDescriptor.value = unwrap(descriptor.value);
					if ("get" in descriptor) rawDescriptor.get = unwrap(descriptor.get);
					if ("set" in descriptor) rawDescriptor.set = unwrap(descriptor.set);
					const before = Reflect.apply(DATE_GET_TIME, date, []);
					try {
						const stored = Reflect.defineProperty(date, property, rawDescriptor);
						if (stored && storesGovernedProxy) signalRawEgress();
						return stored;
					} finally {
						if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), before)) markChanged(date);
					}
				},
			});
		} else {
			proxy = new Proxy(objectValue, {
				getOwnPropertyDescriptor(object, property): PropertyDescriptor | undefined {
					const nestedIgnored =
						ignored ||
						(object === (target as object) && typeof property === "string" && REPLICA_LOCAL_STATE_KEYS.has(property));
					return observeOwnDescriptor(object, property, nestedIgnored);
				},
				get(object, property, receiver): unknown {
					const nestedIgnored =
						ignored ||
						(object === (target as object) && typeof property === "string" && REPLICA_LOCAL_STATE_KEYS.has(property));
					const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!nestedIgnored) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!nestedIgnored) signalRawEgress();
							return undefined;
						}
					}
					return wrap(Reflect.get(object, property, receiver), nestedIgnored);
				},
				set(object, property, nextValue, receiver): boolean {
					const rawValue = unwrap(nextValue);
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(object, property);
					const resolvedDescriptor = previousDescriptor ?? inheritedPropertyDescriptor(object, property);
					const accessorReceiver = resolvedDescriptor !== undefined && !("value" in resolvedDescriptor);
					const assigned = Reflect.set(object, property, rawValue, accessorReceiver ? receiver : object);
					if (assigned) finalizeCommittedWrite(object, property, previousDescriptor, true);
					return assigned;
				},
				deleteProperty(object, property): boolean {
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(object, property);
					const deleted = Reflect.deleteProperty(object, property);
					if (deleted && previousDescriptor !== undefined) {
						try {
							updateReachability(object, property, dataDescriptorValue(previousDescriptor), undefined);
							markChanged(object, property);
						} catch (error) {
							markChanged(object, property);
							throw error;
						}
					}
					return deleted;
				},
				defineProperty(object, property, descriptor): boolean {
					const rawDescriptor = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor;
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(object, property);
					const defined = Reflect.defineProperty(object, property, rawDescriptor);
					if (defined) finalizeCommittedWrite(object, property, previousDescriptor, false);
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
		hasChanges: (): boolean => changedKeys.size > 0 || rawEgress,
		changedKeys: (): ReadonlySet<string> => changedKeys,
		hasRawEgress: (): boolean => rawEgress,
		observeRawEgressBoundary,
		rawEgressCandidateKeys: (): ReadonlySet<string> => rawEgressKeys,
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
