import { type DRPState } from "@ts-drp/types";

type ObjectRecord = Record<PropertyKey, unknown>;

interface NodeBufferConstructor {
	from(value: Uint8Array): Uint8Array;
	isBuffer(value: unknown): boolean;
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
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const nodeBufferConstructor = (globalThis as unknown as { Buffer?: NodeBufferConstructor }).Buffer;
const nodeBufferFrom = nodeBufferConstructor?.from;
const nodeBufferIsBuffer = nodeBufferConstructor?.isBuffer;

function enumerableKeys(value: object): PropertyKey[] {
	return [
		...Object.keys(value),
		...Object.getOwnPropertySymbols(value).filter((symbol) => Reflect.apply(propertyIsEnumerable, value, [symbol])),
	];
}

function copyEnumerableProperties(target: ObjectRecord, source: ObjectRecord, stack: Map<object, unknown>): void {
	for (const key of enumerableKeys(source)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (descriptor === undefined || descriptor.writable) {
			target[key] = detachStatePayloadWithStack(source[key], stack);
		}
	}
}

function cloneArrayBuffer(value: ArrayBuffer): ArrayBuffer {
	return Reflect.apply(arrayBufferSlice, value, [0]);
}

function cloneSharedArrayBuffer(value: SharedArrayBuffer): SharedArrayBuffer {
	if (sharedArrayBufferSlice === undefined) throw new TypeError("SharedArrayBuffer is not available");
	return Reflect.apply(sharedArrayBufferSlice, value, [0]);
}

function detachStatePayloadWithStack(value: unknown, stack: Map<object, unknown>): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	if (typeof value === "function") return value;
	if (stack.has(value)) return stack.get(value);

	if (Array.isArray(value)) {
		const source = value as unknown[] & { index?: unknown; input?: unknown };
		const result = new Array(value.length) as unknown[] & { index?: unknown; input?: unknown };
		stack.set(value, result);
		for (let index = 0; index < value.length; index++) {
			result[index] = detachStatePayloadWithStack(value[index], stack);
		}
		if (Object.hasOwn(value, "index")) result.index = detachStatePayloadWithStack(source.index, stack);
		if (Object.hasOwn(value, "input")) result.input = detachStatePayloadWithStack(source.input, stack);
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
				detachStatePayloadWithStack(key, stack),
				detachStatePayloadWithStack(entryValue, stack),
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
			Reflect.apply(setAdd, result, [detachStatePayloadWithStack(step.value, stack)]);
		}
		return result;
	}

	if (
		nodeBufferConstructor !== undefined &&
		nodeBufferFrom !== undefined &&
		nodeBufferIsBuffer !== undefined &&
		Reflect.apply(nodeBufferIsBuffer, nodeBufferConstructor, [value])
	) {
		const result = Reflect.apply(nodeBufferFrom, nodeBufferConstructor, [value]) as Uint8Array;
		stack.set(value, result);
		return result;
	}

	if (ArrayBuffer.isView(value)) {
		if (value instanceof DataView) {
			const buffer = detachStatePayloadWithStack(value.buffer, stack) as ArrayBuffer;
			const result = new DataView(buffer, value.byteOffset, value.byteLength);
			stack.set(value, result);
			copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack);
			return result;
		}
		const source = value as unknown as {
			[index: number]: unknown;
			readonly length: number;
		};
		const prototype = Reflect.getPrototypeOf(value) as {
			constructor: new (length: number) => { [index: number]: unknown; readonly length: number };
		};
		const result = new prototype.constructor(source.length);
		stack.set(value, result);
		for (let index = 0; index < source.length; index++) {
			result[index] = detachStatePayloadWithStack(source[index], stack);
		}
		return result;
	}

	if (value instanceof ArrayBuffer) {
		const result = cloneArrayBuffer(value);
		stack.set(value, result);
		return result;
	}

	if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
		const result = cloneSharedArrayBuffer(value);
		stack.set(value, result);
		return result;
	}

	if (typeof File !== "undefined" && value instanceof File) {
		const result = new File([value], value.name, { type: value.type });
		stack.set(value, result);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack);
		return result;
	}

	if (typeof Blob !== "undefined" && value instanceof Blob) {
		const result = new Blob([value], { type: value.type });
		stack.set(value, result);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack);
		return result;
	}

	if (value instanceof Error) {
		const ErrorConstructor = value.constructor as new () => Error;
		const result = new ErrorConstructor();
		stack.set(value, result);
		result.message = value.message;
		result.name = value.name;
		result.stack = value.stack;
		result.cause = detachStatePayloadWithStack(value.cause, stack);
		copyEnumerableProperties(result as unknown as ObjectRecord, value as unknown as ObjectRecord, stack);
		return result;
	}

	const result = Object.create(Reflect.getPrototypeOf(value)) as ObjectRecord;
	stack.set(value, result);
	copyEnumerableProperties(result, value as ObjectRecord, stack);
	return result;
}

/**
 * Detach one independently owned state payload while preserving its graph.
 * @param value - Top-level payload to detach
 * @returns Independently owned payload
 */
export function detachStatePayload<T>(value: T): T {
	return detachStatePayloadWithStack(value, new Map()) as T;
}

/**
 * Detach a snapshot with a fresh identity stack for every top-level entry.
 * @param state - Snapshot to detach
 * @returns Independently owned snapshot
 */
export function detachStateSnapshot(state: DRPState): DRPState {
	return {
		state: state.state.map(({ key, value }) => ({ key, value: detachStatePayload(value) })),
	};
}
