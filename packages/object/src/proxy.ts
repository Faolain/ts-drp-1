import { type DrpType, type IDRP } from "@ts-drp/types";
import { handlePromiseOrValue, isPromise } from "@ts-drp/utils";

import { AdoptionCommitExhaustedError } from "./errors.js";
import { MAX_ADOPTION_COMMIT_ATTEMPTS, type PostOperation } from "./operation.js";
import { type Pipeline } from "./pipeline/pipeline.js";
import { proxyValuesEqual } from "./publication/copy-capability.js";
import { BinaryStateExpandoError, validateGovernedBinaryState } from "./state-payload.js";
import { REPLICA_LOCAL_STATE_KEYS } from "./state-store.js";

const DATE_GET_TIME = Date.prototype.getTime;
const OBJECT_PREVENT_EXTENSIONS = Object.preventExtensions;
const DATE_NATIVE_MEMBERS = new Map<PropertyKey, unknown>();
for (const property of Reflect.ownKeys(Date.prototype)) {
	if (property === "constructor") continue;
	const descriptor = Reflect.getOwnPropertyDescriptor(Date.prototype, property);
	if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
		DATE_NATIVE_MEMBERS.set(property, descriptor.value);
	}
}

const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: Reflect.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const NODE_BUFFER = Reflect.get(globalThis, "Buffer") as
	| { isBuffer?(value: unknown): boolean; prototype?: object }
	| undefined;
const BINARY_NATIVE_PROTOTYPES = new Set<object>();
const BINARY_NATIVE_DESCRIPTORS = new WeakMap<object, Map<PropertyKey, PropertyDescriptor>>();
const binaryConstructors: unknown[] = [
	ArrayBuffer,
	typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer,
	DataView,
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	typeof BigInt64Array === "undefined" ? undefined : BigInt64Array,
	typeof BigUint64Array === "undefined" ? undefined : BigUint64Array,
	NODE_BUFFER,
];
for (const candidate of binaryConstructors) {
	if (typeof candidate !== "function") continue;
	let prototype = Reflect.get(candidate, "prototype") as object | null;
	while (prototype !== null && prototype !== Object.prototype) {
		BINARY_NATIVE_PROTOTYPES.add(prototype);
		if (!BINARY_NATIVE_DESCRIPTORS.has(prototype)) {
			const descriptors = new Map<PropertyKey, PropertyDescriptor>();
			for (const property of Reflect.ownKeys(prototype)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property);
				if (descriptor !== undefined) descriptors.set(property, descriptor);
			}
			BINARY_NATIVE_DESCRIPTORS.set(prototype, descriptors);
		}
		prototype = Reflect.getPrototypeOf(prototype) as object | null;
	}
}

const TYPED_ARRAY_MUTATING_METHODS = new Set<PropertyKey>(["copyWithin", "fill", "reverse", "set", "sort"]);
const BUFFER_MUTATING_METHODS = new Set<PropertyKey>(["copy", "swap16", "swap32", "swap64"]);
const BUFFER_BRANDED_FIRST_ARGUMENT_METHODS = new Set<PropertyKey>([
	"compare",
	"copy",
	"equals",
	"fill",
	"includes",
	"indexOf",
	"lastIndexOf",
]);
const ARRAY_BUFFER_MUTATING_METHODS = new Set<PropertyKey>(["grow", "resize", "transfer", "transferToFixedLength"]);
const ARRAY_BUFFER_STRUCTURAL_MUTATORS = new Set<unknown>();
for (const prototype of [
	ArrayBuffer.prototype,
	typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype,
]) {
	if (prototype === undefined) continue;
	const descriptors = BINARY_NATIVE_DESCRIPTORS.get(prototype);
	for (const property of ARRAY_BUFFER_MUTATING_METHODS) {
		const member = descriptors?.get(property)?.value;
		if (typeof member === "function") ARRAY_BUFFER_STRUCTURAL_MUTATORS.add(member);
	}
}
const GOVERNED_BUFFER_BACKING_MUTATION_ERROR = "Cannot structurally mutate an ArrayBuffer backing a governed Buffer";
const BINARY_READ_ONLY_METHODS = new Set<PropertyKey>([
	Symbol.iterator,
	"at",
	"compare",
	"entries",
	"equals",
	"every",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"forEach",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"map",
	"reduce",
	"reduceRight",
	"slice",
	"some",
	"subarray",
	"toJSON",
	"toLocaleString",
	"toReversed",
	"toSorted",
	"toString",
	"values",
	"with",
]);

function backingByteLength(value: object): number | undefined {
	for (const getter of [ARRAY_BUFFER_BYTE_LENGTH_GETTER, SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER]) {
		if (getter === undefined) continue;
		try {
			return Reflect.apply(getter, value, []) as number;
		} catch {
			// Try the other native backing-store brand.
		}
	}
	return undefined;
}

function isBackingStore(value: object): value is ArrayBufferLike {
	return backingByteLength(value) !== undefined;
}

function isNodeBuffer(value: object): boolean {
	return NODE_BUFFER?.isBuffer?.(value) === true;
}

function binaryBacking(value: object): object {
	return ARRAY_BUFFER_IS_VIEW(value) ? (Reflect.get(value, "buffer", value) as object) : value;
}

interface BinarySnapshot {
	readonly bytes: Uint8Array;
	readonly byteLength: number;
}

function snapshotBinary(value: object): BinarySnapshot | undefined {
	try {
		if (ARRAY_BUFFER_IS_VIEW(value)) {
			const buffer = Reflect.get(value, "buffer", value) as ArrayBufferLike;
			const byteOffset = Reflect.get(value, "byteOffset", value) as number;
			const byteLength = Reflect.get(value, "byteLength", value) as number;
			return { bytes: Uint8Array.from(new Uint8Array(buffer, byteOffset, byteLength)), byteLength };
		}
		const byteLength = backingByteLength(value);
		if (byteLength === undefined) return undefined;
		return { bytes: Uint8Array.from(new Uint8Array(value as ArrayBufferLike)), byteLength };
	} catch {
		return undefined;
	}
}

function snapshotBinaryElement(value: object, property: PropertyKey): BinarySnapshot | undefined {
	if (!ARRAY_BUFFER_IS_VIEW(value) || value instanceof DataView || typeof property !== "string") return undefined;
	const index = Number(property);
	if (!Number.isInteger(index) || index < 0 || `${index}` !== property) return undefined;
	try {
		const length = Reflect.get(value, "length", value) as number;
		if (index >= length || length <= 0) return undefined;
		const buffer = Reflect.get(value, "buffer", value) as ArrayBufferLike;
		const byteOffset = Reflect.get(value, "byteOffset", value) as number;
		const byteLength = Reflect.get(value, "byteLength", value) as number;
		const elementByteLength = byteLength / length;
		if (!Number.isInteger(elementByteLength) || elementByteLength <= 0) return undefined;
		const bytes = Uint8Array.from(new Uint8Array(buffer, byteOffset + index * elementByteLength, elementByteLength));
		return { bytes, byteLength: elementByteLength };
	} catch {
		return undefined;
	}
}

function binarySnapshotsEqual(left: BinarySnapshot | undefined, right: BinarySnapshot | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.byteLength !== right.byteLength || left.bytes.byteLength !== right.bytes.byteLength) return false;
	return left.bytes.every((byte, index) => byte === right.bytes[index]);
}

function binaryMemberDescriptor(
	value: object,
	property: PropertyKey
): { descriptor: PropertyDescriptor; owner: object } | undefined {
	let current: object | null = value;
	while (current !== null) {
		const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
		if (descriptor !== undefined) return { descriptor, owner: current };
		current = Reflect.getPrototypeOf(current) as object | null;
	}
	return undefined;
}

function isNativeBinaryMember(value: object, property: PropertyKey, member: unknown): boolean {
	const resolved = binaryMemberDescriptor(value, property);
	return (
		resolved !== undefined &&
		BINARY_NATIVE_PROTOTYPES.has(resolved.owner) &&
		BINARY_NATIVE_DESCRIPTORS.get(resolved.owner)?.get(property)?.value === member
	);
}

function isNativeBinaryAccessor(
	property: PropertyKey,
	resolved: { descriptor: PropertyDescriptor; owner: object }
): boolean {
	const captured = BINARY_NATIVE_DESCRIPTORS.get(resolved.owner)?.get(property);
	return (
		captured !== undefined &&
		"get" in captured &&
		"get" in resolved.descriptor &&
		captured.get === resolved.descriptor.get &&
		captured.set === resolved.descriptor.set
	);
}

function isPotentialBinaryMutation(value: object, property: PropertyKey): boolean {
	if (ARRAY_BUFFER_IS_VIEW(value)) {
		if (TYPED_ARRAY_MUTATING_METHODS.has(property) || BUFFER_MUTATING_METHODS.has(property)) return true;
		if (typeof property === "string" && (property.startsWith("set") || property.startsWith("write"))) return true;
		if (BINARY_READ_ONLY_METHODS.has(property)) return false;
		if (typeof property === "string" && (property.startsWith("get") || property.startsWith("read"))) return false;
		return true;
	}
	if (ARRAY_BUFFER_MUTATING_METHODS.has(property)) return true;
	return !BINARY_READ_ONLY_METHODS.has(property);
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
	const buffersByBacking = new WeakMap<object, Set<object>>();

	const isReference = (value: unknown): value is object =>
		(typeof value === "object" || typeof value === "function") && value !== null;

	const descriptorExposesReference = (descriptor: PropertyDescriptor): boolean =>
		("value" in descriptor && isReference(descriptor.value)) ||
		("get" in descriptor && (isReference(descriptor.get) || isReference(descriptor.set)));
	const ignoresProperty = (owner: object, property: PropertyKey, ignored: boolean): boolean =>
		owner === (target as object) ? typeof property === "string" && REPLICA_LOCAL_STATE_KEYS.has(property) : ignored;

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

	const addParentOnce = (value: unknown, parent: object): void => {
		if (!isReference(value)) return;
		const rawValue = unwrap(value);
		const rawParent = unwrap(parent);
		if (!parents.get(rawValue)?.has(rawParent)) addParent(rawValue, rawParent);
	};

	const registerBufferBacking = (buffer: object): void => {
		const backing = binaryBacking(buffer);
		let buffers = buffersByBacking.get(backing);
		if (!buffers) {
			buffers = new Set<object>();
			buffersByBacking.set(backing, buffers);
		}
		buffers.add(buffer);
	};

	type PreparedGraphs = { commit(): void };
	type GovernedWritePreparation =
		| { readonly graphs: PreparedGraphs; readonly failure?: never }
		| { readonly graphs?: never; readonly failure: unknown };

	const prepareGraphs = (roots: readonly unknown[], invokeAccessors = true): PreparedGraphs => {
		const discovered = new Set<object>();
		const nodes: object[] = [];
		const binaries: object[] = [];
		const edges: Array<readonly [object, object]> = [];
		const normalize: Array<() => void> = [];
		let complete = true;

		const discover = (candidate: unknown): void => {
			if (!isReference(candidate)) return;
			const value = unwrap(candidate);
			if (initialized.has(value) || discovered.has(value)) return;
			discovered.add(value);
			nodes.push(value);
			if (validateGovernedBinaryState(value)) {
				binaries.push(value);
				if (ARRAY_BUFFER_IS_VIEW(value) && !isNodeBuffer(value)) {
					const backing = binaryBacking(value);
					edges.push([backing, value]);
					discover(backing);
				}
				return;
			}

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
				const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
				if (!invokeAccessors && (descriptor === undefined || !("value" in descriptor))) {
					complete = false;
					continue;
				}
				const child =
					descriptor !== undefined && "value" in descriptor
						? descriptor.value
						: (value as Record<string, unknown>)[key];
				const rawChild = unwrap(child);
				if (isReference(rawChild)) edges.push([rawChild, value]);
				if (rawChild !== child) {
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
		return {
			commit(): void {
				for (const binary of binaries) {
					Reflect.apply(OBJECT_PREVENT_EXTENSIONS, Object, [binary]);
					initialized.add(binary);
					if (isNodeBuffer(binary)) registerBufferBacking(binary);
				}
				if (!complete) return;
				for (const apply of normalize) apply();
				for (const [child, parent] of edges) addParent(child, parent);
				for (const node of nodes) initialized.add(node);
			},
		};
	};

	const initializeGraphs = (roots: readonly unknown[]): void => prepareGraphs(roots).commit();
	const initializeGraph = (value: unknown): void => initializeGraphs([value]);
	const prepareGovernedWrite = (value: unknown): GovernedWritePreparation | undefined => {
		if (!isReference(value) || initialized.has(value)) return { graphs: { commit(): void {} } };
		try {
			// Data-described subtrees can be validated and staged without moving
			// fallible accessor evaluation ahead of an ordinary physical write.
			return { graphs: prepareGraphs([value], false) };
		} catch (error) {
			if (error instanceof BinaryStateExpandoError) return undefined;
			return { failure: error };
		}
	};

	const governedRoots: Array<readonly [string, unknown]> = [];
	for (const key of Object.keys(target)) {
		if (REPLICA_LOCAL_STATE_KEYS.has(key)) continue;
		governedRoots.push([key, (target as Record<string, unknown>)[key]]);
	}
	initializeGraphs(governedRoots.map(([, value]) => value));
	for (const [key, value] of governedRoots) {
		initialGovernedKeys.add(key);
		addDirectOwner(value, key);
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

	const hasGovernedOwner = (value: object): boolean => {
		const visited = new Set<object>();
		const pending = [unwrap(value)];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			if ((directOwners.get(current)?.size ?? 0) > 0) return true;
			for (const parent of parents.get(current)?.keys() ?? []) pending.push(parent);
		}
		return false;
	};
	const hasGovernedBuffer = (backing: object): boolean => {
		for (const buffer of buffersByBacking.get(backing) ?? []) {
			if (hasGovernedOwner(buffer)) return true;
		}
		return false;
	};
	const isReplicaLocalOnly = (value: object, ignored: boolean): boolean => ignored && !hasGovernedOwner(value);

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

	const finalizePreparedWrite = (
		prepared: GovernedWritePreparation,
		owner: object,
		property: PropertyKey,
		previousDescriptor: PropertyDescriptor | undefined,
		compareDataValues: boolean
	): void => {
		if ("failure" in prepared) {
			// The ordinary reflection already committed. Preserve the same
			// post-write failure contract as discovery in finalizeCommittedWrite.
			markChanged(owner, property);
			throw prepared.failure;
		}
		prepared.graphs.commit();
		finalizeCommittedWrite(owner, property, previousDescriptor, compareDataValues);
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
		if (!ignored && objectValue !== (target as object)) initializeGraph(objectValue);
		const proxyCache = ignored ? ignoredProxies : trackedProxies;
		const existing = proxyCache.get(objectValue);
		if (existing) return existing as V;

		let proxy: object;
		if (ARRAY_BUFFER_IS_VIEW(objectValue) || isBackingStore(objectValue)) {
			proxy = new Proxy(objectValue, {
				getOwnPropertyDescriptor(binary, property): PropertyDescriptor | undefined {
					return observeOwnDescriptor(binary, property, isReplicaLocalOnly(binary, ignored));
				},
				get(binary, property): unknown {
					const replicaLocalOnly = isReplicaLocalOnly(binary, ignored);
					const ownDescriptor = Reflect.getOwnPropertyDescriptor(binary, property);
					if (ownDescriptor && !ownDescriptor.configurable) {
						if ("value" in ownDescriptor && !ownDescriptor.writable) {
							if (!replicaLocalOnly && isReference(ownDescriptor.value)) signalRawEgress();
							return ownDescriptor.value;
						}
						if ("get" in ownDescriptor && ownDescriptor.get === undefined) return undefined;
					}

					const resolved = binaryMemberDescriptor(binary, property);
					const nativeAccessor = resolved !== undefined && isNativeBinaryAccessor(property, resolved);
					if (!replicaLocalOnly && resolved !== undefined && "get" in resolved.descriptor && !nativeAccessor) {
						signalRawEgress();
					}

					const member = Reflect.get(binary, property, binary) as unknown;
					if (typeof member !== "function") {
						if (isReference(member) && (ARRAY_BUFFER_IS_VIEW(member) || isBackingStore(member))) {
							return wrap(member, replicaLocalOnly || !hasGovernedOwner(member) ? true : ignored);
						}
						return wrap(member, ignored);
					}

					const structuralMutator = ARRAY_BUFFER_STRUCTURAL_MUTATORS.has(member);
					const nativeMember = isNativeBinaryMember(binary, property, member);
					return (...args: unknown[]): unknown => {
						const operationReplicaLocalOnly = isReplicaLocalOnly(binary, ignored);
						const protectedBacking = isBackingStore(binary) && hasGovernedBuffer(binary);
						if (structuralMutator && protectedBacking) {
							throw new TypeError(GOVERNED_BUFFER_BACKING_MUTATION_ERROR);
						}
						if (!nativeMember && !operationReplicaLocalOnly) {
							// Custom code receives the raw internal-slot-bearing receiver. Widen
							// publication instead of pretending its effect surface is known.
							signalRawEgress();
							markChanged(binary);
						}

						const potentiallyMutating = nativeMember && isPotentialBinaryMutation(binary, property);
						const candidates: Array<{ charge: boolean; raw: object; snapshot: BinarySnapshot | undefined }> = [];
						const addCandidate = (candidate: unknown, charge: boolean): void => {
							if (!isReference(candidate)) return;
							const raw = unwrap(candidate);
							if (!ARRAY_BUFFER_IS_VIEW(raw) && !isBackingStore(raw)) return;
							const existingCandidate = candidates.find((entry) => entry.raw === raw);
							if (existingCandidate) {
								existingCandidate.charge ||= charge;
								return;
							}
							candidates.push({ charge, raw, snapshot: snapshotBinary(raw) });
						};
						if (potentiallyMutating) {
							addCandidate(binary, !operationReplicaLocalOnly);
							for (const argument of args) {
								const rawArgument = unwrap(argument);
								addCandidate(
									argument,
									isGovernedProxy(argument) || (isReference(rawArgument) && hasGovernedOwner(rawArgument))
								);
							}
						}

						const invocationArgs = args.map((argument, index) => {
							const rawArgument = unwrap(argument);
							if (typeof rawArgument !== "function") {
								return index === 0 &&
									isNodeBuffer(binary) &&
									BUFFER_BRANDED_FIRST_ARGUMENT_METHODS.has(property) &&
									isReference(rawArgument) &&
									(ARRAY_BUFFER_IS_VIEW(rawArgument) || isBackingStore(rawArgument))
									? rawArgument
									: argument;
							}
							return function (this: unknown, ...callbackArgs: unknown[]): unknown {
								const rawCallbackThis = unwrap(this);
								const callbackThis = rawCallbackThis === binary ? proxy : this;
								const wrappedArgs = callbackArgs.map((callbackArgument) =>
									callbackArgument === binary ? proxy : callbackArgument
								);
								return Reflect.apply(rawArgument, callbackThis, wrappedArgs);
							};
						});

						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							const receiver = !nativeMember && protectedBacking ? proxy : binary;
							result = Reflect.apply(member, receiver, invocationArgs);
						} catch (error) {
							operationError = error;
							operationFailed = true;
						} finally {
							for (const candidate of candidates) {
								if (!candidate.charge || binarySnapshotsEqual(candidate.snapshot, snapshotBinary(candidate.raw))) {
									continue;
								}
								markChanged(candidate.raw);
								markChanged(binaryBacking(candidate.raw));
							}
						}

						if (!nativeMember) observeRawEgressBoundary();
						if (operationFailed) throw operationError;
						if (result === binary) return proxy;
						if (isReference(result) && (ARRAY_BUFFER_IS_VIEW(result) || isBackingStore(result))) {
							const sharesBacking = binaryBacking(result) === binaryBacking(binary);
							// A shared-backing result is another path into governed bytes. A
							// fresh backing is only a local return value until later assignment.
							if (!operationReplicaLocalOnly && sharesBacking) {
								initializeGraph(result);
								addParentOnce(result, binary);
							}
							return wrap(result, operationReplicaLocalOnly || !sharesBacking ? true : ignored);
						}
						// Native iterators and data-only result objects need their own
						// internal slots and do not retain a mutable receiver alias.
						return result;
					};
				},
				set(binary, property, nextValue, receiver): boolean {
					const replicaLocalOnly = isReplicaLocalOnly(binary, ignored);
					const rawValue = unwrap(nextValue);
					if (replicaLocalOnly) return Reflect.set(binary, property, rawValue, binary);
					const prepared = prepareGovernedWrite(rawValue);
					if (prepared === undefined) return false;
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(binary, property);
					const previousElement = snapshotBinaryElement(binary, property);
					const resolvedDescriptor = previousDescriptor ?? inheritedPropertyDescriptor(binary, property);
					const accessorReceiver = resolvedDescriptor !== undefined && !("value" in resolvedDescriptor);
					const assigned = Reflect.set(binary, property, rawValue, accessorReceiver ? receiver : binary);
					if (assigned) {
						const byteChanged = !binarySnapshotsEqual(previousElement, snapshotBinaryElement(binary, property));
						try {
							finalizePreparedWrite(prepared, binary, property, previousDescriptor, true);
						} finally {
							if (byteChanged) markChanged(binaryBacking(binary));
						}
					}
					return assigned;
				},
				deleteProperty(binary, property): boolean {
					if (isReplicaLocalOnly(binary, ignored)) return Reflect.deleteProperty(binary, property);
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(binary, property);
					const deleted = Reflect.deleteProperty(binary, property);
					if (deleted && previousDescriptor !== undefined) {
						try {
							updateReachability(binary, property, dataDescriptorValue(previousDescriptor), undefined);
							markChanged(binary, property);
						} catch (error) {
							markChanged(binary, property);
							throw error;
						}
					}
					return deleted;
				},
				defineProperty(binary, property, descriptor): boolean {
					const rawDescriptor = "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor;
					if (isReplicaLocalOnly(binary, ignored)) return Reflect.defineProperty(binary, property, rawDescriptor);
					const prepared = prepareGovernedWrite("value" in rawDescriptor ? rawDescriptor.value : undefined);
					if (prepared === undefined) return false;
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(binary, property);
					const previousElement = snapshotBinaryElement(binary, property);
					const defined = Reflect.defineProperty(binary, property, rawDescriptor);
					if (defined) {
						const byteChanged = !binarySnapshotsEqual(previousElement, snapshotBinaryElement(binary, property));
						try {
							finalizePreparedWrite(prepared, binary, property, previousDescriptor, true);
						} finally {
							if (byteChanged) markChanged(binaryBacking(binary));
						}
					}
					return defined;
				},
			});
		} else if (objectValue instanceof Map) {
			proxy = new Proxy(objectValue, {
				getOwnPropertyDescriptor(map, property): PropertyDescriptor | undefined {
					return observeOwnDescriptor(map, property, isReplicaLocalOnly(map, ignored));
				},
				get(map, property): unknown {
					const replicaLocalOnly = isReplicaLocalOnly(map, ignored);
					const descriptor = Reflect.getOwnPropertyDescriptor(map, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!replicaLocalOnly) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!replicaLocalOnly) signalRawEgress();
							return undefined;
						}
					}
					if (property === "set") {
						return (key: unknown, nextValue: unknown): Map<unknown, unknown> => {
							const rawKey = unwrap(key);
							const rawValue = unwrap(nextValue);
							if (isReplicaLocalOnly(map, ignored)) {
								Map.prototype.set.call(map, rawKey, rawValue);
								return proxy as Map<unknown, unknown>;
							}
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
							if (isReplicaLocalOnly(map, ignored)) return Map.prototype.delete.call(map, rawKey);
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
							if (isReplicaLocalOnly(map, ignored)) {
								Map.prototype.clear.call(map);
								return;
							}
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
						const operationReplicaLocalOnly = isReplicaLocalOnly(map, ignored);
						if (operationReplicaLocalOnly) {
							const result = (member as (...values: unknown[]) => unknown).apply(map, args.map(unwrap));
							return result === map ? proxy : wrap(result, true);
						}
						const previous = snapshotMapEntries(map);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!operationReplicaLocalOnly) signalRawEgress();
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
					return observeOwnDescriptor(set, property, isReplicaLocalOnly(set, ignored));
				},
				get(set, property): unknown {
					const replicaLocalOnly = isReplicaLocalOnly(set, ignored);
					const descriptor = Reflect.getOwnPropertyDescriptor(set, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!replicaLocalOnly) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!replicaLocalOnly) signalRawEgress();
							return undefined;
						}
					}
					if (property === "add") {
						return (nextValue: unknown): Set<unknown> => {
							const rawValue = unwrap(nextValue);
							if (isReplicaLocalOnly(set, ignored)) {
								Set.prototype.add.call(set, rawValue);
								return proxy as Set<unknown>;
							}
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
							if (isReplicaLocalOnly(set, ignored)) return Set.prototype.delete.call(set, rawValue);
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
							if (isReplicaLocalOnly(set, ignored)) {
								Set.prototype.clear.call(set);
								return;
							}
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
						const operationReplicaLocalOnly = isReplicaLocalOnly(set, ignored);
						if (operationReplicaLocalOnly) {
							const result = (member as (...values: unknown[]) => unknown).apply(set, args.map(unwrap));
							return result === set ? proxy : wrap(result, true);
						}
						const previous = snapshotSetValues(set);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!operationReplicaLocalOnly) signalRawEgress();
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
					return observeOwnDescriptor(date, property, isReplicaLocalOnly(date, ignored));
				},
				get(date, property): unknown {
					const replicaLocalOnly = isReplicaLocalOnly(date, ignored);
					const descriptor = Reflect.getOwnPropertyDescriptor(date, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!replicaLocalOnly) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!replicaLocalOnly) signalRawEgress();
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
						const operationReplicaLocalOnly = isReplicaLocalOnly(date, ignored);
						if (operationReplicaLocalOnly) {
							const result = (member as (...values: unknown[]) => unknown).apply(date, args.map(unwrap));
							return result === date ? proxy : wrap(result, true);
						}
						const before = Reflect.apply(DATE_GET_TIME, date, []);
						let result: unknown;
						let operationError: unknown;
						let operationFailed = false;
						try {
							if (!operationReplicaLocalOnly && !isNativeDateMember) signalRawEgress();
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
					const replicaLocalOnly = isReplicaLocalOnly(date, ignored);
					if (replicaLocalOnly) return Reflect.set(date, property, unwrap(nextValue), date);
					const storesGovernedProxy = isGovernedProxy(nextValue);
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
					if (isReplicaLocalOnly(date, ignored)) return Reflect.deleteProperty(date, property);
					const before = Reflect.apply(DATE_GET_TIME, date, []);
					try {
						return Reflect.deleteProperty(date, property);
					} finally {
						if (!Object.is(Reflect.apply(DATE_GET_TIME, date, []), before)) markChanged(date);
					}
				},
				defineProperty(date, property, descriptor): boolean {
					if (isReplicaLocalOnly(date, ignored)) {
						const rawDescriptor = { ...descriptor };
						if ("value" in descriptor) rawDescriptor.value = unwrap(descriptor.value);
						if ("get" in descriptor) rawDescriptor.get = unwrap(descriptor.get);
						if ("set" in descriptor) rawDescriptor.set = unwrap(descriptor.set);
						return Reflect.defineProperty(date, property, rawDescriptor);
					}
					const storesGovernedProxy = "value" in descriptor && isGovernedProxy(descriptor.value);
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
					const nestedIgnored = ignoresProperty(object, property, ignored);
					return observeOwnDescriptor(object, property, isReplicaLocalOnly(object, nestedIgnored));
				},
				get(object, property, receiver): unknown {
					const nestedIgnored = ignoresProperty(object, property, ignored);
					const replicaLocalOnly = isReplicaLocalOnly(object, nestedIgnored);
					const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
					if (descriptor && !descriptor.configurable) {
						if ("value" in descriptor && !descriptor.writable) {
							if (!replicaLocalOnly) signalRawEgress();
							return descriptor.value;
						}
						if ("get" in descriptor && descriptor.get === undefined) {
							if (!replicaLocalOnly) signalRawEgress();
							return undefined;
						}
					}
					return wrap(Reflect.get(object, property, receiver), nestedIgnored);
				},
				set(object, property, nextValue, receiver): boolean {
					const nestedIgnored = ignoresProperty(object, property, ignored);
					const rawValue = unwrap(nextValue);
					if (isReplicaLocalOnly(object, nestedIgnored)) return Reflect.set(object, property, rawValue, receiver);
					const prepared = prepareGovernedWrite(rawValue);
					if (prepared === undefined) return false;
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(object, property);
					const resolvedDescriptor = previousDescriptor ?? inheritedPropertyDescriptor(object, property);
					const accessorReceiver = resolvedDescriptor !== undefined && !("value" in resolvedDescriptor);
					const assigned = Reflect.set(object, property, rawValue, accessorReceiver ? receiver : object);
					if (assigned) {
						finalizePreparedWrite(prepared, object, property, previousDescriptor, true);
					}
					return assigned;
				},
				deleteProperty(object, property): boolean {
					const nestedIgnored = ignoresProperty(object, property, ignored);
					if (isReplicaLocalOnly(object, nestedIgnored)) return Reflect.deleteProperty(object, property);
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
					const nestedIgnored = ignoresProperty(object, property, ignored);
					if (isReplicaLocalOnly(object, nestedIgnored)) {
						return Reflect.defineProperty(object, property, rawDescriptor);
					}
					const prepared = prepareGovernedWrite("value" in rawDescriptor ? rawDescriptor.value : undefined);
					if (prepared === undefined) return false;
					const previousDescriptor = Reflect.getOwnPropertyDescriptor(object, property);
					const defined = Reflect.defineProperty(object, property, rawDescriptor);
					if (defined) {
						finalizePreparedWrite(prepared, object, property, previousDescriptor, false);
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
