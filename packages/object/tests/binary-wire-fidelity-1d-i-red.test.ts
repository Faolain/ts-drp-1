import { DRPState, DRPStateOtherTheWire } from "@ts-drp/types";
import {
	deserializeDRPState,
	deserializeValue,
	serializeDRPState,
	serializedValuesEqual,
	serializeValue,
} from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

interface BinaryCase {
	label: string;
	create(): object;
}

interface BinaryShape {
	constructor: unknown;
	kind: "backing" | "non-binary" | "view";
	byteLength: number | null;
	byteOffset: number | null;
	elementLength: number | null;
	visibleBytes: number[];
}

interface WireRoundTrip {
	direct: unknown;
	directBytes: Uint8Array;
	protobufBytes: Uint8Array;
	wire: unknown;
	wireValueBytes: Uint8Array;
}

const EXPANDO_ERROR = "Binary values in governed state cannot have own expandos";

function filledBacking(byteLength = 64): ArrayBuffer {
	const backing = new ArrayBuffer(byteLength);
	new Uint8Array(backing).set(Array.from({ length: byteLength }, (_, index) => (index * 17 + 3) & 0xff));
	return backing;
}

function filledSharedBacking(byteLength = 19): SharedArrayBuffer {
	const backing = new SharedArrayBuffer(byteLength);
	new Uint8Array(backing).set(Array.from({ length: byteLength }, (_, index) => (index * 19 + 5) & 0xff));
	return backing;
}

function binaryCases(): BinaryCase[] {
	const cases: BinaryCase[] = [
		{ label: "Int8Array", create: (): Int8Array => new Int8Array(filledBacking(), 16, 7) },
		{ label: "Uint8Array", create: (): Uint8Array => new Uint8Array(filledBacking(), 16, 7) },
		{ label: "Uint8ClampedArray", create: (): Uint8ClampedArray => new Uint8ClampedArray(filledBacking(), 16, 7) },
		{ label: "Int16Array", create: (): Int16Array => new Int16Array(filledBacking(), 16, 5) },
		{ label: "Uint16Array", create: (): Uint16Array => new Uint16Array(filledBacking(), 16, 5) },
		{ label: "Int32Array", create: (): Int32Array => new Int32Array(filledBacking(), 16, 4) },
		{ label: "Uint32Array", create: (): Uint32Array => new Uint32Array(filledBacking(), 16, 4) },
		{ label: "Float32Array", create: (): Float32Array => new Float32Array(filledBacking(), 16, 4) },
		{ label: "Float64Array", create: (): Float64Array => new Float64Array(filledBacking(), 16, 3) },
		{ label: "DataView", create: (): DataView => new DataView(filledBacking(), 16, 13) },
		{ label: "ArrayBuffer", create: (): ArrayBuffer => filledBacking(19) },
	];

	if (typeof BigInt64Array !== "undefined") {
		cases.push({ label: "BigInt64Array", create: (): BigInt64Array => new BigInt64Array(filledBacking(), 16, 3) });
	}
	if (typeof BigUint64Array !== "undefined") {
		cases.push({ label: "BigUint64Array", create: (): BigUint64Array => new BigUint64Array(filledBacking(), 16, 3) });
	}
	if (typeof Buffer !== "undefined") {
		cases.push({ label: "Node Buffer", create: (): Buffer => Buffer.from(filledBacking(), 16, 9) });
	}
	if (typeof SharedArrayBuffer !== "undefined") {
		cases.push({ label: "SharedArrayBuffer", create: (): SharedArrayBuffer => filledSharedBacking() });
	}

	return cases;
}

function backingBytes(value: ArrayBufferLike): number[] {
	return [...new Uint8Array(value)];
}

function binaryShape(value: unknown): BinaryShape {
	if (typeof value !== "object" || value === null) {
		return {
			constructor: null,
			kind: "non-binary",
			byteLength: null,
			byteOffset: null,
			elementLength: null,
			visibleBytes: [],
		};
	}

	const constructor = Reflect.get(Object.getPrototypeOf(value) as object, "constructor") as unknown;
	if (ArrayBuffer.isView(value)) {
		return {
			constructor,
			kind: "view",
			byteLength: value.byteLength,
			byteOffset: value.byteOffset,
			elementLength: value instanceof DataView ? null : (value as unknown as { length: number }).length,
			visibleBytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)],
		};
	}
	if (
		value instanceof ArrayBuffer ||
		(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
	) {
		return {
			constructor,
			kind: "backing",
			byteLength: value.byteLength,
			byteOffset: 0,
			elementLength: null,
			visibleBytes: backingBytes(value),
		};
	}
	return {
		constructor,
		kind: "non-binary",
		byteLength: null,
		byteOffset: null,
		elementLength: null,
		visibleBytes: [],
	};
}

function wireRoundTrip(value: unknown): WireRoundTrip {
	const directBytes = serializeValue(value);
	const state = DRPState.create({ state: [{ key: "payload", value }] });
	const encodedState = serializeDRPState(state);
	const wireValueBytes = encodedState.state[0]?.data;
	if (wireValueBytes === undefined) throw new Error("Serialized DRP state omitted the payload entry");

	const protobufBytes = DRPStateOtherTheWire.encode(encodedState).finish();
	const decodedWire = DRPStateOtherTheWire.decode(protobufBytes);
	const decodedState = deserializeDRPState(decodedWire);
	const wire = decodedState.state[0]?.value;

	return {
		direct: deserializeValue(directBytes),
		directBytes,
		protobufBytes,
		wire,
		wireValueBytes,
	};
}

function expectBinaryShape(actual: unknown, expected: object, label: string): void {
	const actualShape = binaryShape(actual);
	const expectedShape = binaryShape(expected);

	expect.soft(actualShape.kind, `${label}: binary category`).toBe(expectedShape.kind);
	expect.soft(actualShape.constructor, `${label}: exact constructor/element kind`).toBe(expectedShape.constructor);
	expect.soft(actualShape.byteOffset, `${label}: byte offset`).toBe(expectedShape.byteOffset);
	expect.soft(actualShape.byteLength, `${label}: visible byte length`).toBe(expectedShape.byteLength);
	expect.soft(actualShape.elementLength, `${label}: element length`).toBe(expectedShape.elementLength);
	expect.soft(actualShape.visibleBytes, `${label}: exact visible bytes`).toEqual(expectedShape.visibleBytes);
	if (expectedShape.kind === "backing") {
		expect.soft(actual, `${label}: bare backing bytes must not collapse to an empty map`).not.toEqual({});
	}
}

function captureExpandoRejection(run: () => unknown): { message: string | null; typeError: boolean } {
	try {
		run();
		return { message: null, typeError: false };
	} catch (error) {
		return {
			message: error instanceof Error ? error.message : null,
			typeError: error instanceof TypeError,
		};
	}
}

function withExpando(value: object): object {
	Reflect.defineProperty(value, Symbol("wire-expando"), {
		configurable: true,
		enumerable: false,
		value: { replicaLocalOnly: true },
		writable: true,
	});
	return value;
}

function captureExtensionRejection(
	bytes: Uint8Array,
	extensionType: number
): {
	boundedMessage: boolean;
	mentionsType: boolean;
	threw: boolean;
} {
	try {
		deserializeValue(bytes);
		return { boundedMessage: false, mentionsType: false, threw: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		return {
			boundedMessage: message.length > 0 && message.length <= 160,
			mentionsType: message.includes(`${extensionType}`),
			threw: true,
		};
	}
}

describe("Phase 1d(i) D.92.7 binary wire fidelity", () => {
	it.each(binaryCases())("preserves $label through direct and DRP protobuf wire round trips", ({ create, label }) => {
		const source = create();
		const roundTrip = wireRoundTrip(source);

		expect
			.soft(roundTrip.wireValueBytes, `${label}: equality and state-wire authorities must emit one answer`)
			.toEqual(roundTrip.directBytes);
		expect
			.soft(roundTrip.protobufBytes.byteLength, `${label}: protobuf transport must contain bytes`)
			.toBeGreaterThan(0);
		expectBinaryShape(roundTrip.direct, source, `${label} direct`);
		expectBinaryShape(roundTrip.wire, source, `${label} protobuf`);
	});

	it("preserves repeated identity, shared overlap, and distinct backing topology", () => {
		const shared = filledBacking(40);
		const repeated = new Uint8Array(shared, 4, 12);
		const source = {
			dataView: new DataView(shared, 7, 12),
			first: repeated,
			independent: new Uint8Array(filledBacking(24), 4, 12),
			overlap: new Uint16Array(shared, 8, 5),
			repeated,
		};
		const decoded = wireRoundTrip(source).wire as Record<string, unknown>;
		const first = decoded.first;
		const duplicate = decoded.repeated;
		const overlap = decoded.overlap;
		const dataView = decoded.dataView;
		const independent = decoded.independent;
		const viewsHaveExpectedKinds =
			first instanceof Uint8Array &&
			duplicate instanceof Uint8Array &&
			overlap instanceof Uint16Array &&
			dataView instanceof DataView &&
			independent instanceof Uint8Array;

		let overlappingWriteObserved = false;
		if (viewsHaveExpectedKinds) {
			dataView.setUint8(1, 211);
			overlappingWriteObserved =
				first[4] === 211 && new Uint8Array(overlap.buffer, overlap.byteOffset, overlap.byteLength)[0] === 211;
		}

		expect({
			dataViewOffset: dataView instanceof DataView ? dataView.byteOffset : null,
			distinctBacking: viewsHaveExpectedKinds && independent.buffer !== first.buffer,
			overlapOffset: overlap instanceof Uint16Array ? overlap.byteOffset : null,
			overlappingWriteObserved,
			repeatedIdentity: first === duplicate,
			sharedBacking: viewsHaveExpectedKinds && first.buffer === overlap.buffer && overlap.buffer === dataView.buffer,
			viewsHaveExpectedKinds,
		}).toEqual({
			dataViewOffset: 7,
			distinctBacking: true,
			overlapOffset: 8,
			overlappingWriteObserved: true,
			repeatedIdentity: true,
			sharedBacking: true,
			viewsHaveExpectedKinds: true,
		});
	});

	it("rejects binary expandos before direct or DRP-state encoding", () => {
		const results = binaryCases().map(({ create, label }) => {
			const direct = captureExpandoRejection(() => serializeValue(withExpando(create())));
			const state = captureExpandoRejection(() =>
				serializeDRPState(DRPState.create({ state: [{ key: "payload", value: withExpando(create()) }] }))
			);
			return { direct, label, state };
		});

		expect(results).toEqual(
			results.map(({ label }) => ({
				direct: { message: EXPANDO_ERROR, typeError: true },
				label,
				state: { message: EXPANDO_ERROR, typeError: true },
			}))
		);
	});

	it.each([
		{
			bytes: Uint8Array.of(0xd4, 99, 0),
			extensionType: 99,
			label: "unknown custom extension",
		},
		{
			bytes: Uint8Array.of(0xd4, 2, 1),
			extensionType: 2,
			label: "known Float32 extension with a scalar payload",
		},
	])("rejects a legitimate MessagePack envelope carrying $label", ({ bytes, extensionType }) => {
		expect(captureExtensionRejection(bytes, extensionType)).toEqual({
			boundedMessage: true,
			mentionsType: true,
			threw: true,
		});
	});

	it.each([
		{ label: "Float32Array", value: new Float32Array([1.25, -2.5, 3.75]) },
		{ label: "ordinary object", value: { active: true, count: 3, label: "wire-control" } },
		{
			label: "Map",
			value: new Map<unknown, unknown>([
				["alpha", 1],
				["nested", new Set([2, 3])],
			]),
		},
		{ label: "Set", value: new Set(["alpha", "beta", "gamma"]) },
		{ label: "Date", value: new Date("2026-08-03T12:34:56.789Z") },
	])("keeps the existing $label wire round trip green", ({ value }) => {
		const roundTrip = wireRoundTrip(value);
		expect.soft(roundTrip.direct).toEqual(value);
		expect.soft(roundTrip.wire).toEqual(value);
		expect(roundTrip.wireValueBytes).toEqual(roundTrip.directBytes);
	});

	it("keeps equality-authority and protobuf field bytes canonical for the same supported graph", () => {
		const value = {
			binaries: Object.fromEntries(binaryCases().map(({ create, label }) => [label, create()])),
			date: new Date("2026-08-03T00:00:00.000Z"),
			map: new Map([["key", new Set([1, 2, 3])]]),
		};
		const first = wireRoundTrip(value);
		const second = wireRoundTrip(value);

		expect.soft(first.wireValueBytes).toEqual(first.directBytes);
		expect.soft(second.wireValueBytes).toEqual(first.directBytes);
		expect.soft(second.protobufBytes).toEqual(first.protobufBytes);
		expect(serializedValuesEqual(value, value)).toBe(true);
	});
});
