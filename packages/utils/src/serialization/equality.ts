import { encode, ExtensionCodec } from "@msgpack/msgpack";

const SET_EXT_TYPE = 0;
const MAP_EXT_TYPE = 1;
const BINARY_EXT_TYPE = 2;
const TIMESTAMP_EXT_TYPE = -1;
const EXPANDO_ERROR = "Binary values in governed state cannot have own expandos";
const MAX_ID = 0xffff_ffff;
// One ordinary Node pool may legitimately have a tiny visible Buffer window.
// Every additional backing byte must be represented by bytes in the wire input.
const BINARY_ALLOCATION_SLACK = 8192;

const BINARY_REF_RECORD = 0;
const BINARY_BACKING_RECORD = 1;
const BINARY_VIEW_RECORD = 2;
const ARRAY_BUFFER_KIND = 0;
const SHARED_ARRAY_BUFFER_KIND = 1;
const OMITTED_BACKING_KIND = -1;

interface NodeBufferConstructor {
	from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
	isBuffer(value: unknown): boolean;
	prototype: object;
}

interface BinaryViewConstructor {
	new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): ArrayBufferView;
	readonly BYTES_PER_ELEMENT?: number;
	readonly prototype: object;
}

type BackingKind = typeof ARRAY_BUFFER_KIND | typeof SHARED_ARRAY_BUFFER_KIND;

interface BinaryViewKind {
	readonly bytesPerElement: number;
	readonly constructor: BinaryViewConstructor | NodeBufferConstructor;
	readonly kind: number;
	readonly prototype: object;
	readonly type: "buffer" | "data-view" | "typed-array";
}

class SerializationExtensionError extends TypeError {}

/** @internal */
export interface SerializationContext {
	readonly direction: "decode" | "encode";
	readonly backingIds: WeakMap<object, number>;
	readonly backings: Map<number, ArrayBufferLike>;
	decodePayload(data: Uint8Array, extensionType: number, context: SerializationContext): unknown;
	readonly objectIds: WeakMap<object, number>;
	readonly objects: Map<number, object>;
	nextBackingId: number;
	nextObjectId: number;
	remainingBackingAllocation: number;
	remainingBackingSlack: number;
}

const arrayBufferByteLength = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const sharedArrayBufferConstructor = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer;
const sharedArrayBufferByteLength =
	sharedArrayBufferConstructor === undefined
		? undefined
		: Reflect.getOwnPropertyDescriptor(sharedArrayBufferConstructor.prototype, "byteLength")?.get;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffset = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const typedArrayLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const dataViewBuffer = Reflect.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get;
const dataViewByteLength = Reflect.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const dataViewByteOffset = Reflect.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")?.get;
const reflectOwnKeys = Reflect.ownKeys;
const objectGetPrototypeOf = Reflect.getPrototypeOf;
const nodeBufferConstructor = (globalThis as unknown as { Buffer?: NodeBufferConstructor }).Buffer;
const nodeBufferFrom = nodeBufferConstructor?.from;
const nodeBufferIsBuffer = nodeBufferConstructor?.isBuffer;

const binaryViewKinds: readonly BinaryViewKind[] = [
	{ bytesPerElement: 1, constructor: Int8Array, kind: 0, prototype: Int8Array.prototype, type: "typed-array" },
	{ bytesPerElement: 1, constructor: Uint8Array, kind: 1, prototype: Uint8Array.prototype, type: "typed-array" },
	{
		bytesPerElement: 1,
		constructor: Uint8ClampedArray,
		kind: 2,
		prototype: Uint8ClampedArray.prototype,
		type: "typed-array",
	},
	{ bytesPerElement: 2, constructor: Int16Array, kind: 3, prototype: Int16Array.prototype, type: "typed-array" },
	{
		bytesPerElement: 2,
		constructor: Uint16Array,
		kind: 4,
		prototype: Uint16Array.prototype,
		type: "typed-array",
	},
	{ bytesPerElement: 4, constructor: Int32Array, kind: 5, prototype: Int32Array.prototype, type: "typed-array" },
	{
		bytesPerElement: 4,
		constructor: Uint32Array,
		kind: 6,
		prototype: Uint32Array.prototype,
		type: "typed-array",
	},
	{
		bytesPerElement: 4,
		constructor: Float32Array,
		kind: 7,
		prototype: Float32Array.prototype,
		type: "typed-array",
	},
	{
		bytesPerElement: 8,
		constructor: Float64Array,
		kind: 8,
		prototype: Float64Array.prototype,
		type: "typed-array",
	},
	...(typeof BigInt64Array === "undefined"
		? []
		: [
				{
					bytesPerElement: 8,
					constructor: BigInt64Array as BinaryViewConstructor,
					kind: 9,
					prototype: BigInt64Array.prototype,
					type: "typed-array" as const,
				},
			]),
	...(typeof BigUint64Array === "undefined"
		? []
		: [
				{
					bytesPerElement: 8,
					constructor: BigUint64Array as BinaryViewConstructor,
					kind: 10,
					prototype: BigUint64Array.prototype,
					type: "typed-array" as const,
				},
			]),
	{ bytesPerElement: 1, constructor: DataView, kind: 11, prototype: DataView.prototype, type: "data-view" },
	...(nodeBufferConstructor === undefined
		? []
		: [
				{
					bytesPerElement: 1,
					constructor: nodeBufferConstructor,
					kind: 12,
					prototype: nodeBufferConstructor.prototype,
					type: "buffer" as const,
				},
			]),
];

function extensionError(extensionType: number, reason: "malformed" | "unknown"): SerializationExtensionError {
	return new SerializationExtensionError(
		reason === "unknown"
			? `Unknown MessagePack extension ${extensionType}`
			: `Malformed MessagePack extension ${extensionType}`
	);
}

function isSafeId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ID;
}

function nextId(context: SerializationContext, key: "nextBackingId" | "nextObjectId"): number {
	const id = context[key];
	if (!isSafeId(id)) throw extensionError(BINARY_EXT_TYPE, "malformed");
	context[key]++;
	return id;
}

function getBackingKind(value: object): BackingKind | null {
	const prototype = Reflect.apply(objectGetPrototypeOf, Reflect, [value]) as object | null;
	if (prototype === ArrayBuffer.prototype) return ARRAY_BUFFER_KIND;
	if (sharedArrayBufferConstructor !== undefined && prototype === sharedArrayBufferConstructor.prototype) {
		return SHARED_ARRAY_BUFFER_KIND;
	}
	return null;
}

function getBackingByteLength(value: ArrayBufferLike, kind: BackingKind): number {
	const getter = kind === ARRAY_BUFFER_KIND ? arrayBufferByteLength : sharedArrayBufferByteLength;
	if (getter === undefined) throw extensionError(BINARY_EXT_TYPE, "malformed");
	return Reflect.apply(getter, value, []) as number;
}

function getViewKind(value: object): BinaryViewKind | null {
	if (
		nodeBufferConstructor !== undefined &&
		nodeBufferIsBuffer !== undefined &&
		Reflect.apply(nodeBufferIsBuffer, nodeBufferConstructor, [value])
	) {
		return binaryViewKinds.find(({ type }) => type === "buffer") ?? null;
	}
	const prototype = Reflect.apply(objectGetPrototypeOf, Reflect, [value]) as object | null;
	return binaryViewKinds.find((candidate) => candidate.prototype === prototype) ?? null;
}

function getViewShape(
	value: object,
	kind: BinaryViewKind
): {
	backing: ArrayBufferLike;
	byteLength: number;
	byteOffset: number;
	elementLength: number | null;
} {
	if (kind.type === "data-view") {
		if (dataViewBuffer === undefined || dataViewByteLength === undefined || dataViewByteOffset === undefined) {
			throw extensionError(BINARY_EXT_TYPE, "malformed");
		}
		return {
			backing: Reflect.apply(dataViewBuffer, value, []) as ArrayBufferLike,
			byteLength: Reflect.apply(dataViewByteLength, value, []) as number,
			byteOffset: Reflect.apply(dataViewByteOffset, value, []) as number,
			elementLength: null,
		};
	}
	if (
		typedArrayBuffer === undefined ||
		typedArrayByteLength === undefined ||
		typedArrayByteOffset === undefined ||
		typedArrayLength === undefined
	) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	return {
		backing: Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike,
		byteLength: Reflect.apply(typedArrayByteLength, value, []) as number,
		byteOffset: Reflect.apply(typedArrayByteOffset, value, []) as number,
		elementLength: Reflect.apply(typedArrayLength, value, []) as number,
	};
}

function isCanonicalIndex(key: PropertyKey, length: number): boolean {
	if (typeof key !== "string") return false;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && `${index}` === key;
}

function assertNoBinaryExpandos(value: object, elementLength: number | null): void {
	const keys = Reflect.apply(reflectOwnKeys, Reflect, [value]) as PropertyKey[];
	for (const key of keys) {
		if (elementLength !== null && isCanonicalIndex(key, elementLength)) continue;
		throw new TypeError(EXPANDO_ERROR);
	}
}

function copyBackingBytes(backing: ArrayBufferLike, kind: BackingKind): Uint8Array {
	const byteLength = getBackingByteLength(backing, kind);
	const bytes = new Uint8Array(byteLength);
	bytes.set(new Uint8Array(backing));
	return bytes;
}

function encodeBackingIdentity(
	backing: ArrayBufferLike,
	context: SerializationContext
): readonly [number, BackingKind | typeof OMITTED_BACKING_KIND, number | null] {
	const knownId = context.backingIds.get(backing);
	if (knownId !== undefined) return [knownId, OMITTED_BACKING_KIND, null];
	const backingKind = getBackingKind(backing);
	if (backingKind === null) throw extensionError(BINARY_EXT_TYPE, "malformed");
	const backingByteLength = getBackingByteLength(backing, backingKind);
	if (!isSafeId(backingByteLength)) throw extensionError(BINARY_EXT_TYPE, "malformed");
	const backingId = nextId(context, "nextBackingId");
	context.backingIds.set(backing, backingId);
	return [backingId, backingKind, backingByteLength];
}

function backingAllocationProof(
	backingByteLength: number,
	visibleByteLength: number,
	context: SerializationContext
): Uint8Array {
	const uncoveredBytes = backingByteLength - visibleByteLength;
	const slackUsed = Math.min(context.remainingBackingSlack, uncoveredBytes);
	context.remainingBackingSlack -= slackUsed;
	return new Uint8Array(uncoveredBytes - slackUsed);
}

function encodeBinaryRecord(value: object, context: SerializationContext): unknown[] {
	const knownObjectId = context.objectIds.get(value);
	if (knownObjectId !== undefined) return [BINARY_REF_RECORD, knownObjectId];

	const objectId = nextId(context, "nextObjectId");
	context.objectIds.set(value, objectId);
	const backingKind = getBackingKind(value);
	if (backingKind !== null) {
		assertNoBinaryExpandos(value, null);
		const [backingId, encodedKind, byteLength] = encodeBackingIdentity(value as ArrayBufferLike, context);
		return [
			BINARY_BACKING_RECORD,
			objectId,
			backingId,
			encodedKind,
			byteLength,
			copyBackingBytes(value as ArrayBufferLike, backingKind),
		];
	}

	const viewKind = getViewKind(value);
	if (viewKind === null) throw extensionError(BINARY_EXT_TYPE, "malformed");
	const shape = getViewShape(value, viewKind);
	assertNoBinaryExpandos(value, shape.elementLength);
	const [backingId, encodedKind, backingByteLength] = encodeBackingIdentity(shape.backing, context);
	const visibleBytes = new Uint8Array(shape.byteLength);
	visibleBytes.set(new Uint8Array(shape.backing, shape.byteOffset, shape.byteLength));
	const allocationProof =
		backingByteLength === null
			? new Uint8Array()
			: backingAllocationProof(backingByteLength, shape.byteLength, context);
	return [
		BINARY_VIEW_RECORD,
		objectId,
		backingId,
		encodedKind,
		backingByteLength,
		viewKind.kind,
		shape.byteOffset,
		shape.byteLength,
		shape.elementLength,
		visibleBytes,
		allocationProof,
	];
}

function decodePayload(data: Uint8Array, extensionType: number, context: SerializationContext): unknown {
	if (context.direction !== "decode") throw extensionError(extensionType, "malformed");
	try {
		return context.decodePayload(data, extensionType, context);
	} catch (error) {
		if (error instanceof SerializationExtensionError) throw error;
		throw extensionError(extensionType, "malformed");
	}
}

function decodeCollectionPayload(data: Uint8Array, extensionType: number, context: SerializationContext): unknown[] {
	const payload = decodePayload(data, extensionType, context);
	if (!Array.isArray(payload)) throw extensionError(extensionType, "malformed");
	return payload;
}

function resolveBacking(
	backingId: unknown,
	backingKind: unknown,
	backingByteLength: unknown,
	context: SerializationContext
): ArrayBufferLike {
	if (!isSafeId(backingId)) throw extensionError(BINARY_EXT_TYPE, "malformed");
	if (backingKind === OMITTED_BACKING_KIND) {
		if (backingByteLength !== null) throw extensionError(BINARY_EXT_TYPE, "malformed");
		const backing = context.backings.get(backingId);
		if (backing === undefined) throw extensionError(BINARY_EXT_TYPE, "malformed");
		return backing;
	}
	if (
		(backingKind !== ARRAY_BUFFER_KIND && backingKind !== SHARED_ARRAY_BUFFER_KIND) ||
		!isSafeId(backingByteLength) ||
		context.backings.has(backingId) ||
		backingByteLength > context.remainingBackingAllocation
	) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	context.remainingBackingAllocation -= backingByteLength;
	let backing: ArrayBufferLike;
	if (backingKind === ARRAY_BUFFER_KIND) {
		backing = new ArrayBuffer(backingByteLength);
	} else {
		if (sharedArrayBufferConstructor === undefined) throw extensionError(BINARY_EXT_TYPE, "malformed");
		backing = new sharedArrayBufferConstructor(backingByteLength);
	}
	context.backings.set(backingId, backing);
	return backing;
}

function decodeBinary(data: Uint8Array, context: SerializationContext): object {
	const payload = decodePayload(data, BINARY_EXT_TYPE, context);
	if (context.direction !== "decode" || !Array.isArray(payload)) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	const recordType = payload[0];
	if (recordType === BINARY_REF_RECORD) {
		if (payload.length !== 2 || !isSafeId(payload[1])) throw extensionError(BINARY_EXT_TYPE, "malformed");
		const referenced = context.objects.get(payload[1]);
		if (referenced === undefined) throw extensionError(BINARY_EXT_TYPE, "malformed");
		return referenced;
	}
	if (
		(recordType !== BINARY_BACKING_RECORD && recordType !== BINARY_VIEW_RECORD) ||
		!isSafeId(payload[1]) ||
		context.objects.has(payload[1])
	) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	const objectId = payload[1];
	if (recordType === BINARY_BACKING_RECORD) {
		if (payload.length !== 6 || !(payload[5] instanceof Uint8Array)) {
			throw extensionError(BINARY_EXT_TYPE, "malformed");
		}
		const backing = resolveBacking(payload[2], payload[3], payload[4], context);
		const backingKind = getBackingKind(backing);
		if (backingKind === null || payload[5].byteLength !== getBackingByteLength(backing, backingKind)) {
			throw extensionError(BINARY_EXT_TYPE, "malformed");
		}
		new Uint8Array(backing).set(payload[5]);
		context.objects.set(objectId, backing);
		return backing;
	}

	if (
		payload.length !== 11 ||
		!isSafeId(payload[5]) ||
		!Number.isSafeInteger(payload[6]) ||
		!Number.isSafeInteger(payload[7]) ||
		(payload[8] !== null && !Number.isSafeInteger(payload[8])) ||
		!(payload[9] instanceof Uint8Array) ||
		!(payload[10] instanceof Uint8Array) ||
		payload[10].some((byte) => byte !== 0)
	) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	const backing = resolveBacking(payload[2], payload[3], payload[4], context);
	const viewKind = binaryViewKinds.find(({ kind }) => kind === payload[5]);
	const byteOffset = payload[6] as number;
	const byteLength = payload[7] as number;
	const elementLength = payload[8] as number | null;
	const backingKind = getBackingKind(backing);
	if (
		viewKind === undefined ||
		backingKind === null ||
		byteOffset < 0 ||
		byteLength < 0 ||
		payload[9].byteLength !== byteLength ||
		byteOffset > getBackingByteLength(backing, backingKind) - byteLength ||
		byteOffset % viewKind.bytesPerElement !== 0 ||
		(viewKind.type === "data-view"
			? elementLength !== null
			: elementLength === null || elementLength < 0 || elementLength * viewKind.bytesPerElement !== byteLength)
	) {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	new Uint8Array(backing, byteOffset, byteLength).set(payload[9]);

	let view: object;
	try {
		if (viewKind.type === "buffer") {
			if (nodeBufferConstructor === undefined || nodeBufferFrom === undefined || elementLength === null) {
				throw extensionError(BINARY_EXT_TYPE, "malformed");
			}
			view = Reflect.apply(nodeBufferFrom, nodeBufferConstructor, [backing, byteOffset, elementLength]) as object;
		} else if (viewKind.type === "data-view") {
			view = new DataView(backing, byteOffset, byteLength);
		} else {
			if (elementLength === null) throw extensionError(BINARY_EXT_TYPE, "malformed");
			view = new (viewKind.constructor as BinaryViewConstructor)(backing, byteOffset, elementLength) as object;
		}
	} catch {
		throw extensionError(BINARY_EXT_TYPE, "malformed");
	}
	context.objects.set(objectId, view);
	return view;
}

class SerializationCodec extends ExtensionCodec<SerializationContext> {
	decode(data: Uint8Array, extensionType: number, context: SerializationContext): unknown {
		if (![TIMESTAMP_EXT_TYPE, SET_EXT_TYPE, MAP_EXT_TYPE, BINARY_EXT_TYPE].includes(extensionType)) {
			throw extensionError(extensionType, "unknown");
		}
		try {
			return super.decode(data, extensionType, context);
		} catch (error) {
			if (error instanceof SerializationExtensionError) throw error;
			throw extensionError(extensionType, "malformed");
		}
	}
}

/** @internal */
export const serializationCodec = new SerializationCodec();

serializationCodec.register({
	type: SET_EXT_TYPE,
	encode: (object: unknown, context: SerializationContext): Uint8Array | null =>
		object instanceof Set
			? encode<SerializationContext>([...object], { extensionCodec: serializationCodec, context })
			: null,
	decode: (data: Uint8Array, extensionType: number, context: SerializationContext): Set<unknown> =>
		new Set(decodeCollectionPayload(data, extensionType, context)),
});

serializationCodec.register({
	type: MAP_EXT_TYPE,
	encode: (object: unknown, context: SerializationContext): Uint8Array | null =>
		object instanceof Map
			? encode<SerializationContext>([...object], { extensionCodec: serializationCodec, context })
			: null,
	decode: (data: Uint8Array, extensionType: number, context: SerializationContext): Map<unknown, unknown> => {
		const entries = decodeCollectionPayload(data, extensionType, context);
		if (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
			throw extensionError(extensionType, "malformed");
		}
		return new Map(entries as Array<[unknown, unknown]>);
	},
});

serializationCodec.register({
	type: BINARY_EXT_TYPE,
	encode: (object: unknown, context: SerializationContext): Uint8Array | null => {
		if (typeof object !== "object" || object === null || context.direction !== "encode") return null;
		const backingKind = getBackingKind(object);
		if (backingKind === null && !Reflect.apply(arrayBufferIsView, ArrayBuffer, [object])) {
			return null;
		}
		return encode(encodeBinaryRecord(object, context));
	},
	decode: (data: Uint8Array, _extensionType: number, context: SerializationContext): object =>
		decodeBinary(data, context),
});

/**
 * Create isolated decode state for one public wire value.
 * @param decodeExtensionPayload - Stateless nested-payload decoder
 * @param encodedByteLength - Wire bytes available to justify backing allocations
 * @returns Fresh decode identity and allocation state
 * @internal
 */
export function createDecodingContext(
	decodeExtensionPayload: SerializationContext["decodePayload"],
	encodedByteLength: number
): SerializationContext {
	return {
		direction: "decode",
		backingIds: new WeakMap(),
		backings: new Map(),
		decodePayload: decodeExtensionPayload,
		nextBackingId: 0,
		nextObjectId: 0,
		objectIds: new WeakMap(),
		objects: new Map(),
		remainingBackingAllocation: encodedByteLength + BINARY_ALLOCATION_SLACK,
		remainingBackingSlack: 0,
	};
}

function createEncodingContext(): SerializationContext {
	return {
		direction: "encode",
		backingIds: new WeakMap(),
		backings: new Map(),
		decodePayload: (_data, extensionType): never => {
			throw extensionError(extensionType, "malformed");
		},
		objectIds: new WeakMap(),
		objects: new Map(),
		nextBackingId: 0,
		nextObjectId: 0,
		remainingBackingAllocation: 0,
		remainingBackingSlack: BINARY_ALLOCATION_SLACK,
	};
}

/**
 * Encode a value for deterministic byte comparison.
 * @param obj - Value to encode
 * @returns Deterministic wire bytes
 */
export function serializeValue(obj: unknown): Uint8Array {
	return encode<SerializationContext>(obj, {
		extensionCodec: serializationCodec,
		context: createEncodingContext(),
	});
}

/**
 * Compare the exact bytes emitted by the value codec.
 * @param left - First value
 * @param right - Second value
 * @param observeEncodedByteLength - Optional accounting hook invoked with each successful encoding's byte length
 * @returns Whether both encodings are byte-identical
 */
export function serializedValuesEqual(
	left: unknown,
	right: unknown,
	observeEncodedByteLength?: (byteLength: number) => void
): boolean {
	const leftBytes = serializeValue(left);
	observeEncodedByteLength?.(leftBytes.byteLength);
	const rightBytes = serializeValue(right);
	observeEncodedByteLength?.(rightBytes.byteLength);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	return leftBytes.every((byte, index) => byte === rightBytes[index]);
}
