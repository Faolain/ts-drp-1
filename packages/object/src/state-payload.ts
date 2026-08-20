import { type DRPState } from "@ts-drp/types";

type ObjectRecord = Record<PropertyKey, unknown>;
type DetachmentDomain = "governed" | "replica-local";

interface DeferredStateCell {
	get(): unknown;
	value: unknown;
	detach: StatePayloadDetacher;
	readonly ownedEntry?: unknown;
	materialized: boolean;
}

const deferredState = new WeakMap<object, Map<string, DeferredStateCell>>();
const governedProxyTargets = new WeakMap<object, object>();

/**
 * Register one execution-only governed proxy with the ownership layer.
 * @param proxy - Governed proxy exposed to application code
 * @param target - Canonical target wrapped by the proxy
 */
export function registerGovernedStateProxy(proxy: object, target: object): void {
	governedProxyTargets.set(proxy, target);
}

/**
 * Return the canonical target behind an execution-only governed proxy.
 * @param value - Potential governed proxy
 * @returns Canonical target, or the original value when it is not governed
 */
export function unwrapGovernedStateValue<T>(value: T): T {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	return (governedProxyTargets.get(value) as T | undefined) ?? value;
}

/**
 * Define a writable enumerable own data property without ordinary [[Set]].
 * @param target - Object receiving the property
 * @param key - Property key to define
 * @param value - Property value
 */
export function defineEnumerableOwnData(target: object, key: PropertyKey, value: unknown): void {
	if (
		!Reflect.defineProperty(target, key, {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		})
	) {
		throw new TypeError(`Cannot define state property ${String(key)}`);
	}
}

/**
 * Install an execution-only value that detaches on first application read.
 * @param target - Execution-only object receiving the deferred property
 * @param key - Governed state key
 * @param value - Borrowed snapshot value
 * @param detach - Shared detachment session
 * @param ownedEntry - Exact owned snapshot entry eligible for retention
 */
export function defineDeferredEnumerableState(
	target: object,
	key: string,
	value: unknown,
	detach: StatePayloadDetacher,
	ownedEntry?: unknown
): void {
	let cells = deferredState.get(target);
	if (cells === undefined) {
		cells = new Map();
		deferredState.set(target, cells);
	}
	const cell: DeferredStateCell = {
		detach,
		get(): unknown {
			if (!cell.materialized) {
				cell.value = cell.detach(cell.value);
				cell.materialized = true;
			}
			return cell.value;
		},
		materialized: false,
		ownedEntry,
		value,
	};
	cells.set(key, cell);
	if (
		!Reflect.defineProperty(target, key, {
			configurable: true,
			enumerable: true,
			get: cell.get,
			set(next: unknown): void {
				cells?.delete(key);
				defineEnumerableOwnData(target, key, next);
			},
		})
	) {
		cells.delete(key);
		throw new TypeError(`Cannot define deferred state property ${key}`);
	}
}

function activeCell(target: object, key: string): DeferredStateCell | undefined {
	const cell = deferredState.get(target)?.get(key);
	if (cell === undefined) return undefined;
	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
	if (descriptor?.get === cell.get) return cell;
	deferredState.get(target)?.delete(key);
	return undefined;
}

function synchronizeDeferredAlias(cell: DeferredStateCell): void {
	if (cell.materialized) return;
	const cached = cell.detach.peek(cell.value);
	if (!cached.found) return;
	cell.value = cached.value;
	cell.materialized = true;
}

/**
 * Read top-level state without forcing execution-overlay detachment.
 * @param target - State-bearing object
 * @param key - Enumerable state key
 * @returns Current canonical value without forcing a deferred copy
 */
export function readEnumerableStateValue(target: object, key: string): unknown {
	const cell = activeCell(target, key);
	if (cell !== undefined) synchronizeDeferredAlias(cell);
	return unwrapGovernedStateValue(cell === undefined ? Reflect.get(target, key, target) : cell.value);
}

/**
 * Materialize one borrowed execution value for a conservative egress check.
 * @param target - State-bearing object
 * @param key - Enumerable state key
 * @returns Detached value visible through the execution overlay
 */
export function materializeEnumerableStateValue(target: object, key: string): unknown {
	const cell = activeCell(target, key);
	return unwrapGovernedStateValue(cell === undefined ? Reflect.get(target, key, target) : cell.get());
}

/**
 * Whether a top-level execution value is still deferred.
 * @param target - State-bearing object
 * @param key - Enumerable state key
 * @returns Whether the value still borrows an owned snapshot entry
 */
export function isDeferredEnumerableState(target: object, key: string): boolean {
	return activeCell(target, key) !== undefined;
}

/**
 * Return the exact owned entry while its deferred value remains unexposed.
 * @param target - State-bearing object
 * @param key - Enumerable state key
 * @returns Exact owned entry, or undefined after materialization
 */
export function borrowedStateEntry(target: object, key: string): unknown | undefined {
	const cell = activeCell(target, key);
	if (cell !== undefined) synchronizeDeferredAlias(cell);
	return cell?.materialized === false ? cell.ownedEntry : undefined;
}

/** Raised when a governed binary carries unsupported own metadata. */
export class BinaryStateExpandoError extends TypeError {}

interface DetachmentWorkCounters {
	typedArrayViewsDetached: number;
	typedArrayCanonicalIndexEnumerations: number;
	typedArrayElementsRecursivelyDetached: number;
	backingStoresCopied: number;
	backingBytesCopied: number;
}

interface DetachmentWorkEvent {
	type: "state-payload-detachment";
	counters: Readonly<DetachmentWorkCounters>;
}

type DetachmentWorkObserver = (event: DetachmentWorkEvent) => unknown;

interface NodeBufferConstructor {
	from(value: Uint8Array): Uint8Array;
	isBuffer(value: unknown): boolean;
}

interface ArrayBufferViewConstructor {
	new (buffer: ArrayBufferLike, byteOffset: number, length: number): ArrayBufferView;
}

const mapEntries = Map.prototype.entries;
const mapSet = Map.prototype.set;
const setValues = Set.prototype.values;
const setAdd = Set.prototype.add;
const mapIteratorNext = Object.getPrototypeOf(Reflect.apply(mapEntries, new Map(), [])).next as (
	this: MapIterator<unknown>
) => IteratorResult<[unknown, unknown]>;
const setIteratorNext = Object.getPrototypeOf(Reflect.apply(setValues, new Set(), [])).next as (
	this: SetIterator<unknown>
) => IteratorResult<unknown>;
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const sharedArrayBufferSlice = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype.slice;
const dataViewBuffer = Reflect.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get;
const dataViewByteLength = Reflect.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const dataViewByteOffset = Reflect.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")?.get;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteOffset = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const typedArrayLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const objectPreventExtensions = Object.preventExtensions;
const reflectOwnKeys = Reflect.ownKeys;
const arrayBufferIsView = ArrayBuffer.isView;
const nodeBufferConstructor = (globalThis as unknown as { Buffer?: NodeBufferConstructor }).Buffer;
const nodeBufferFrom = nodeBufferConstructor?.from;
const nodeBufferIsBuffer = nodeBufferConstructor?.isBuffer;
const arrayIsArray = Array.isArray;

function enumerableKeys(value: object): PropertyKey[] {
	return [
		...Object.keys(value),
		...Object.getOwnPropertySymbols(value).filter((symbol) => Reflect.apply(propertyIsEnumerable, value, [symbol])),
	];
}

function copyEnumerableProperties(
	target: ObjectRecord,
	source: ObjectRecord,
	stack: Map<object, unknown>,
	work: DetachmentWorkCounters | undefined,
	domain: DetachmentDomain,
	indexedLength?: number
): void {
	if (indexedLength !== undefined && work !== undefined) work.typedArrayCanonicalIndexEnumerations++;
	for (const key of enumerableKeys(source)) {
		const index = typeof key === "string" ? Number(key) : Number.NaN;
		if (
			indexedLength !== undefined &&
			Number.isInteger(index) &&
			index >= 0 &&
			index < indexedLength &&
			`${index}` === key
		) {
			continue;
		}
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (descriptor === undefined || descriptor.writable) {
			defineEnumerableOwnData(target, key, detachStatePayloadWithStack(source[key], stack, work, domain));
		}
	}
}

function binaryIndexedLength(value: object): number | null | undefined {
	if (
		nodeBufferConstructor !== undefined &&
		nodeBufferIsBuffer !== undefined &&
		Reflect.apply(nodeBufferIsBuffer, nodeBufferConstructor, [value])
	) {
		if (typedArrayLength === undefined) throw new TypeError("TypedArray intrinsics are not available");
		return Reflect.apply(typedArrayLength, value, []) as number;
	}
	if (arrayBufferIsView(value)) {
		if (value instanceof DataView) return null;
		if (typedArrayLength === undefined) throw new TypeError("TypedArray intrinsics are not available");
		return Reflect.apply(typedArrayLength, value, []) as number;
	}
	if (value instanceof ArrayBuffer) return null;
	if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return null;
	return undefined;
}

function isCanonicalTypedArrayIndex(key: PropertyKey, length: number): boolean {
	if (typeof key !== "string") return false;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && `${index}` === key;
}

function validateGovernedBinaryOwnKeys(
	value: object,
	indexedLength: number | null,
	work?: DetachmentWorkCounters
): void {
	const keys = Reflect.apply(reflectOwnKeys, Reflect, [value]) as PropertyKey[];
	if (indexedLength !== null && work !== undefined) work.typedArrayCanonicalIndexEnumerations++;
	for (const key of keys) {
		if (indexedLength !== null && isCanonicalTypedArrayIndex(key, indexedLength)) continue;
		throw new BinaryStateExpandoError("Binary values in governed state cannot have own expandos");
	}
}

/**
 * Validate one governed binary identity without traversing canonical indices.
 * @param value - Candidate graph vertex
 * @returns Whether the vertex is a governed binary
 */
export function validateGovernedBinaryState(value: object): boolean {
	const indexedLength = binaryIndexedLength(value);
	if (indexedLength === undefined) return false;
	validateGovernedBinaryOwnKeys(value, indexedLength);
	return true;
}

function cloneArrayBuffer(value: ArrayBuffer, work: DetachmentWorkCounters | undefined): ArrayBuffer {
	const result = Reflect.apply(arrayBufferSlice, value, [0]);
	if (work !== undefined) {
		work.backingStoresCopied++;
		work.backingBytesCopied += result.byteLength;
	}
	return result;
}

function cloneSharedArrayBuffer(value: SharedArrayBuffer, work: DetachmentWorkCounters | undefined): SharedArrayBuffer {
	if (sharedArrayBufferSlice === undefined) throw new TypeError("SharedArrayBuffer is not available");
	const result = Reflect.apply(sharedArrayBufferSlice, value, [0]);
	if (work !== undefined) {
		work.backingStoresCopied++;
		work.backingBytesCopied += result.byteLength;
	}
	return result;
}

function detachStatePayloadWithStack(
	value: unknown,
	stack: Map<object, unknown>,
	work: DetachmentWorkCounters | undefined,
	domain: DetachmentDomain
): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	value = unwrapGovernedStateValue(value);
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	if (typeof value === "function") return value;
	if (stack.has(value)) return stack.get(value);

	if (Array.isArray(value)) {
		const source = value as unknown[] & { index?: unknown; input?: unknown };
		const result = new Array(value.length) as unknown[] & { index?: unknown; input?: unknown };
		stack.set(value, result);
		for (let index = 0; index < value.length; index++) {
			if (index in value) {
				defineEnumerableOwnData(result, String(index), detachStatePayloadWithStack(value[index], stack, work, domain));
			}
		}
		if (Object.hasOwn(value, "index")) {
			defineEnumerableOwnData(result, "index", detachStatePayloadWithStack(source.index, stack, work, domain));
		}
		if (Object.hasOwn(value, "input")) {
			defineEnumerableOwnData(result, "input", detachStatePayloadWithStack(source.input, stack, work, domain));
		}
		return result;
	}

	if (value instanceof Date) {
		const result = new Date(value.getTime());
		stack.set(value, result);
		return result;
	}

	if (value instanceof RegExp) {
		const result = new RegExp(value.source, value.flags);
		result.lastIndex = value.lastIndex;
		stack.set(value, result);
		return result;
	}

	if (value instanceof Map) {
		const result = new Map<unknown, unknown>();
		stack.set(value, result);
		const iterator = Reflect.apply(mapEntries, value, []);
		for (;;) {
			const step = Reflect.apply(mapIteratorNext, iterator, []);
			if (step.done) break;
			const [key, entryValue] = step.value;
			Reflect.apply(mapSet, result, [
				detachStatePayloadWithStack(key, stack, work, domain),
				detachStatePayloadWithStack(entryValue, stack, work, domain),
			]);
		}
		return result;
	}

	if (value instanceof Set) {
		const result = new Set<unknown>();
		stack.set(value, result);
		const iterator = Reflect.apply(setValues, value, []);
		for (;;) {
			const step = Reflect.apply(setIteratorNext, iterator, []);
			if (step.done) break;
			Reflect.apply(setAdd, result, [detachStatePayloadWithStack(step.value, stack, work, domain)]);
		}
		return result;
	}

	if (
		nodeBufferConstructor !== undefined &&
		nodeBufferFrom !== undefined &&
		nodeBufferIsBuffer !== undefined &&
		Reflect.apply(nodeBufferIsBuffer, nodeBufferConstructor, [value])
	) {
		if (domain === "governed") {
			const indexedLength = binaryIndexedLength(value);
			if (indexedLength === undefined) throw new TypeError("Buffer intrinsics are not available");
			validateGovernedBinaryOwnKeys(value, indexedLength, work);
		}
		const result = Reflect.apply(nodeBufferFrom, nodeBufferConstructor, [value]) as Uint8Array;
		if (work !== undefined) {
			work.backingStoresCopied++;
			work.backingBytesCopied += result.byteLength;
		}
		stack.set(value, result);
		if (domain === "governed") Reflect.apply(objectPreventExtensions, Object, [result]);
		return result;
	}

	if (arrayBufferIsView(value)) {
		if (value instanceof DataView) {
			if (dataViewBuffer === undefined || dataViewByteLength === undefined || dataViewByteOffset === undefined) {
				throw new TypeError("DataView intrinsics are not available");
			}
			if (domain === "governed") validateGovernedBinaryOwnKeys(value, null);
			const prototype = Reflect.getPrototypeOf(value) as object;
			const sourceBuffer = Reflect.apply(dataViewBuffer, value, []) as ArrayBufferLike;
			const byteOffset = Reflect.apply(dataViewByteOffset, value, []) as number;
			const byteLength = Reflect.apply(dataViewByteLength, value, []) as number;
			const buffer = detachStatePayloadWithStack(sourceBuffer, stack, work, domain) as ArrayBufferLike;
			const constructor = Reflect.get(prototype, "constructor") as ArrayBufferViewConstructor;
			const result = Reflect.construct(constructor, [buffer, byteOffset, byteLength]) as DataView;
			if (
				!(result instanceof DataView) ||
				Reflect.getPrototypeOf(result) !== prototype ||
				Reflect.apply(dataViewBuffer, result, []) !== buffer ||
				Reflect.apply(dataViewByteOffset, result, []) !== byteOffset ||
				Reflect.apply(dataViewByteLength, result, []) !== byteLength
			) {
				throw new TypeError("Unsupported DataView constructor");
			}
			stack.set(value, result);
			if (domain === "replica-local") {
				copyEnumerableProperties(
					result as unknown as ObjectRecord,
					value as unknown as ObjectRecord,
					stack,
					work,
					domain
				);
			} else {
				Reflect.apply(objectPreventExtensions, Object, [result]);
			}
			return result;
		}
		if (typedArrayBuffer === undefined || typedArrayByteOffset === undefined || typedArrayLength === undefined) {
			throw new TypeError("TypedArray intrinsics are not available");
		}
		const indexedLength = binaryIndexedLength(value);
		if (indexedLength === undefined || indexedLength === null) throw new TypeError("Unsupported TypedArray");
		if (domain === "governed") validateGovernedBinaryOwnKeys(value, indexedLength, work);
		const prototype = Reflect.getPrototypeOf(value) as object;
		const sourceBuffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
		const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
		const length = Reflect.apply(typedArrayLength, value, []) as number;
		const buffer = detachStatePayloadWithStack(sourceBuffer, stack, work, domain) as ArrayBufferLike;
		const constructor = Reflect.get(prototype, "constructor") as ArrayBufferViewConstructor;
		const result = Reflect.construct(constructor, [buffer, byteOffset, length]);
		if (
			!arrayBufferIsView(result) ||
			result instanceof DataView ||
			Reflect.getPrototypeOf(result) !== prototype ||
			Reflect.apply(typedArrayBuffer, result, []) !== buffer ||
			Reflect.apply(typedArrayByteOffset, result, []) !== byteOffset ||
			Reflect.apply(typedArrayLength, result, []) !== length
		) {
			throw new TypeError("Unsupported TypedArray constructor");
		}
		stack.set(value, result);
		if (work !== undefined) work.typedArrayViewsDetached++;
		if (domain === "replica-local") {
			copyEnumerableProperties(
				result as unknown as ObjectRecord,
				value as unknown as ObjectRecord,
				stack,
				work,
				domain,
				length
			);
		} else {
			Reflect.apply(objectPreventExtensions, Object, [result]);
		}
		return result;
	}

	if (value instanceof ArrayBuffer) {
		if (domain === "governed") validateGovernedBinaryOwnKeys(value, null);
		const result = cloneArrayBuffer(value, work);
		stack.set(value, result);
		if (domain === "governed") Reflect.apply(objectPreventExtensions, Object, [result]);
		return result;
	}

	if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
		if (domain === "governed") validateGovernedBinaryOwnKeys(value, null);
		const result = cloneSharedArrayBuffer(value, work);
		stack.set(value, result);
		if (domain === "governed") Reflect.apply(objectPreventExtensions, Object, [result]);
		return result;
	}

	if (typeof File !== "undefined" && value instanceof File) {
		const result = new File([value], value.name, { type: value.type });
		stack.set(value, result);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack, work, domain);
		return result;
	}

	if (typeof Blob !== "undefined" && value instanceof Blob) {
		const result = new Blob([value], { type: value.type });
		stack.set(value, result);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack, work, domain);
		return result;
	}

	if (value instanceof Error) {
		const ErrorConstructor = value.constructor as new () => Error;
		const result = new ErrorConstructor();
		stack.set(value, result);
		result.message = value.message;
		result.name = value.name;
		result.stack = value.stack;
		result.cause = detachStatePayloadWithStack(value.cause, stack, work, domain);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack, work, domain);
		return result;
	}

	const result = Object.create(Reflect.getPrototypeOf(value)) as ObjectRecord;
	stack.set(value, result);
	copyEnumerableProperties(result, value as ObjectRecord, stack, work, domain);
	return result;
}

function detachGraph<T>(value: T, domain: DetachmentDomain, observer?: DetachmentWorkObserver): T {
	const work = observer
		? {
				typedArrayViewsDetached: 0,
				typedArrayCanonicalIndexEnumerations: 0,
				typedArrayElementsRecursivelyDetached: 0,
				backingStoresCopied: 0,
				backingBytesCopied: 0,
			}
		: undefined;
	const result = detachStatePayloadWithStack(value, new Map(), work, domain) as T;
	if (observer !== undefined && work !== undefined) {
		try {
			observer({ type: "state-payload-detachment", counters: { ...work } });
		} catch {
			// Diagnostic observation cannot alter the completed detachment.
		}
	}
	return result;
}

/**
 * Detach one independently owned state payload while preserving its graph.
 * @param value - Top-level payload to detach
 * @param observer - Optional diagnostic work observer
 * @returns Independently owned payload
 */
export function detachStatePayload<T>(value: T, observer?: DetachmentWorkObserver): T {
	return detachGraph(value, "governed", observer);
}

/** Create one governed detachment graph shared by a top-level batch. */
export interface StatePayloadDetacher {
	<T>(value: T): T;
	peek<T>(value: T): { found: boolean; value?: T };
}

/**
 * Create one governed detachment graph shared by a top-level batch.
 * @returns Stateful detacher preserving aliases across calls
 */
export function createStatePayloadDetacher(): StatePayloadDetacher {
	const stack = new Map<object, unknown>();
	const detach = (<T>(value: T): T =>
		detachStatePayloadWithStack(value, stack, undefined, "governed") as T) as StatePayloadDetacher;
	detach.peek = <T>(value: T): { found: boolean; value?: T } => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return { found: false };
		const canonical = unwrapGovernedStateValue(value);
		return stack.has(canonical as object)
			? { found: true, value: stack.get(canonical as object) as T }
			: { found: false };
	};
	return detach;
}

/**
 * Create one replica-local detachment graph shared by a top-level batch.
 * @returns Stateful detacher preserving aliases across calls
 */
export function createReplicaLocalContextDetacher(): StatePayloadDetacher {
	const stack = new Map<object, unknown>();
	const detach = (<T>(value: T): T =>
		detachStatePayloadWithStack(value, stack, undefined, "replica-local") as T) as StatePayloadDetacher;
	detach.peek = <T>(value: T): { found: boolean; value?: T } => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) return { found: false };
		const canonical = unwrapGovernedStateValue(value);
		return stack.has(canonical as object)
			? { found: true, value: stack.get(canonical as object) as T }
			: { found: false };
	};
	return detach;
}

/**
 * Detach replica-local runtime context through the shared graph copier.
 * @param value - Context payload to copy
 * @returns Independently owned replica-local context
 */
export function detachReplicaLocalContext<T>(value: T): T {
	return detachGraph(value, "replica-local");
}

/**
 * Detach a snapshot with a fresh identity stack for every top-level entry.
 * @param state - Snapshot to detach
 * @returns Independently owned snapshot
 */
export function detachStateSnapshot(state: DRPState): DRPState {
	const entries = state.state;
	if (!arrayIsArray(entries)) throw new TypeError("DRP state entries must be an array");

	const length = entries.length;
	const result = new Array<DRPState["state"][number]>(length);
	for (let index = 0; index < length; index++) {
		if (!(index in entries)) continue;
		const entry = entries[index];
		if (entry === undefined) throw new TypeError("DRP state entry must be present");
		const { key, value } = entry;
		result[index] = { key, value: detachStatePayload(value) };
	}
	return {
		state: result,
	};
}

/**
 * Fully validate a snapshot before it is applied to a reconstructed instance.
 * @param state - Snapshot to prepare
 * @returns Plain entry container with fully readable source entries
 */
export interface ValidatedStateSnapshotKeys {
	readonly entries: DRPState["state"];
	readonly keys: readonly string[];
}

/**
 * Validate every key before observing any state value.
 * @param state - Snapshot whose entry keys must be primitive strings
 * @returns Validated entries paired with their pre-read key vector
 */
export function validateStateSnapshotKeysForApplication(state: DRPState): ValidatedStateSnapshotKeys {
	const entries = state.state;
	if (!arrayIsArray(entries)) throw new TypeError("DRP state entries must be an array");

	const length = entries.length;
	const keys = new Array<string>(length);
	for (let index = 0; index < length; index++) {
		const entry = entries[index];
		if (entry === undefined) throw new TypeError("DRP state entry must be present");
		const key = entry.key;
		if (typeof key !== "string") throw new TypeError("DRP state key must be a primitive string");
		keys[index] = key;
	}
	return { entries, keys };
}

/**
 * Read snapshot values only after the full key vector has validated.
 * @param root0 - Prevalidated snapshot key view
 * @param root0.entries - Source snapshot entries
 * @param root0.keys - Prevalidated primitive-string keys
 * @returns Snapshot with values read only after key validation
 */
export function readValidatedStateSnapshot({ entries, keys }: ValidatedStateSnapshotKeys): DRPState {
	const prepared = new Array<DRPState["state"][number]>(entries.length);
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry === undefined) throw new TypeError("DRP state entry must be present");
		prepared[index] = { key: keys[index], value: entry.value };
	}
	return { state: prepared };
}

/**
 * Fully validate and read one public reconstruction snapshot.
 * @param state - Public reconstruction snapshot
 * @returns Snapshot safe for reconstruction reads
 */
export function validateStateSnapshotForApplication(state: DRPState): DRPState {
	return readValidatedStateSnapshot(validateStateSnapshotKeysForApplication(state));
}
