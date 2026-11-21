import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import parameterRegistry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import { ROOM_APPLICATION_STATE_LIMIT_PARAMETER, roomApplicationStateLimit } from "@ts-drp/protocol-v3/room-parameters";

/**
 * The room parameters record as the native plane opens it: the registry fields within their ranges, the
 * record's one registered extension (protocol-v3 room-parameters: the room's application state limit) and
 * exact canonical bytes. The plane (v3-live, at open) and the room's invite authentication (v3-room, before
 * any host acquisition) both judge the record here, so they agree on every record without a public bridge
 * on @ts-drp/node/v3-live (whose export roster is pinned). The supported-profile digest gate stays the plane's.
 * Model: packages/node/formal/room-parameters-owner.qnt.
 */

const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectPrototype = Object.prototype;
const ReflectOwnKeys = Reflect.ownKeys;
const StringConstructor = String;

type PlainRecord = Readonly<Record<string, unknown>>;

export interface ParameterFieldSchema {
	readonly maximum: number;
	readonly minimum: number;
	readonly name: string;
	readonly required: boolean;
}

export interface ParameterSchema {
	readonly domain: string;
	readonly fields: readonly ParameterFieldSchema[];
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function ownDataValue(value: unknown, key: string): unknown {
	if (!isObject(value)) return undefined;
	const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
		? descriptor.value
		: undefined;
}

function snapshotClosedRecord(value: unknown, keys: readonly string[]): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== ObjectPrototype) return undefined;
		const actual = ReflectOwnKeys(value);
		if (actual.length !== keys.length) return undefined;
		for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
			const actualKey = actual[actualIndex];
			if (typeof actualKey !== "string") return undefined;
			let found = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === actualKey) found = true;
			}
			if (!found) return undefined;
		}
		const snapshot = ObjectCreate(null) as Record<string, unknown>;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index] as string;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			snapshot[key] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function defineDenseElement(target: unknown[], index: number, value: unknown): boolean {
	try {
		ObjectDefineProperty(target, StringConstructor(index), {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		});
		return true;
	} catch {
		return false;
	}
}

function finishDenseArray<T>(value: T[], expectedLength: number): readonly T[] | undefined {
	try {
		ObjectDefineProperty(value, "length", {
			configurable: false,
			enumerable: false,
			value: expectedLength,
			writable: true,
		});
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
				return undefined;
			}
		}
		return ObjectFreeze(value);
	} catch {
		return undefined;
	}
}

function snapshotDenseArray(value: unknown, expectedLength: number): readonly unknown[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype || value.length !== expectedLength) {
			return undefined;
		}
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		const output: unknown[] = [];
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				!defineDenseElement(output, index, descriptor.value)
			) {
				return undefined;
			}
		}
		return finishDenseArray(output, expectedLength);
	} catch {
		return undefined;
	}
}

function snapshotPublishedParameterSchema(value: unknown): ParameterSchema | undefined {
	try {
		const kinds = ownDataValue(value, "kinds");
		const parameters = snapshotClosedRecord(ownDataValue(kinds, "parameters"), [
			"domain",
			"encoding",
			"fields",
			"signedEnvelope",
		]);
		if (
			parameters === undefined ||
			typeof parameters.domain !== "string" ||
			parameters.encoding !== "canonical-object"
		) {
			return undefined;
		}
		const fields = snapshotDenseArray(parameters.fields, 8);
		if (fields === undefined) return undefined;
		const captured: ParameterFieldSchema[] = [];
		for (let index = 0; index < fields.length; index += 1) {
			const field = snapshotClosedRecord(fields[index], [
				"name",
				"type",
				"const",
				"constraints",
				"required",
				"sortRule",
			]);
			if (
				field === undefined ||
				typeof field.name !== "string" ||
				field.name.length === 0 ||
				field.type !== "safe-integer" ||
				field.const !== null ||
				typeof field.required !== "boolean" ||
				field.sortRule !== null
			) {
				return undefined;
			}
			const constraints = snapshotClosedRecord(field.constraints, ["minimum", "maximum"]);
			if (
				constraints === undefined ||
				typeof constraints.minimum !== "number" ||
				!NumberIsSafeInteger(constraints.minimum) ||
				typeof constraints.maximum !== "number" ||
				!NumberIsSafeInteger(constraints.maximum) ||
				constraints.minimum > constraints.maximum
			) {
				return undefined;
			}
			for (let previous = 0; previous < captured.length; previous += 1) {
				if (captured[previous]?.name === field.name) return undefined;
			}
			if (
				!defineDenseElement(
					captured,
					index,
					ObjectFreeze({
						maximum: constraints.maximum,
						minimum: constraints.minimum,
						name: field.name,
						required: field.required,
					})
				)
			) {
				return undefined;
			}
		}
		const frozenFields = finishDenseArray(captured, fields.length);
		return frozenFields === undefined ? undefined : ObjectFreeze({ domain: parameters.domain, fields: frozenFields });
	} catch {
		return undefined;
	}
}

/** The registry's parameters schema, captured once from the published registry. */
export const V3_ROOM_PARAMETER_SCHEMA = snapshotPublishedParameterSchema(parameterRegistry);

/**
 * Snapshots a decoded parameters record as the plane opens it (registry fields and the registered extension).
 * @param value - The decoded record.
 * @param schema - The registry's parameters schema.
 * @returns A null-prototype copy, or undefined when the record is not valid.
 */
export function snapshotParameterRecord(value: unknown, schema: ParameterSchema): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== null) return undefined;
		const keys = ReflectOwnKeys(value);
		if (
			keys.some(
				(key) =>
					typeof key !== "string" ||
					(!schema.fields.some(({ name }) => name === key) && key !== ROOM_APPLICATION_STATE_LIMIT_PARAMETER)
			)
		) {
			return undefined;
		}
		const output = ObjectCreate(null) as Record<string, unknown>;
		// The record's one registered extension (protocol-v3 room-parameters), checked by its owner.
		const extension = ObjectGetOwnPropertyDescriptor(value, ROOM_APPLICATION_STATE_LIMIT_PARAMETER);
		if (extension !== undefined) {
			if (extension.enumerable !== true || !("value" in extension)) return undefined;
			output[ROOM_APPLICATION_STATE_LIMIT_PARAMETER] = extension.value;
			if (roomApplicationStateLimit(output) === undefined) return undefined;
		}
		for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
			const field = schema.fields[fieldIndex] as ParameterFieldSchema;
			let keyFound = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === field.name) keyFound = true;
			}
			if (!keyFound) {
				if (field.required) return undefined;
				continue;
			}
			const descriptor = ObjectGetOwnPropertyDescriptor(value, field.name);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "number" ||
				!NumberIsSafeInteger(descriptor.value) ||
				descriptor.value < field.minimum ||
				descriptor.value > field.maximum
			) {
				return undefined;
			}
			output[field.name] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

/**
 * A room's application state limit from its exact parameters carrier, judged as the plane judges the
 * carrier at open.
 * @param bytes - The exact parameters carrier.
 * @returns The limit in canonical bytes, or undefined when the carrier is not valid.
 */
export function v3RoomParametersApplicationStateLimit(bytes: Uint8Array): number | undefined {
	try {
		if (V3_ROOM_PARAMETER_SCHEMA === undefined) return undefined;
		const snapshot = snapshotParameterRecord(decodeCanonical(bytes), V3_ROOM_PARAMETER_SCHEMA);
		if (snapshot === undefined || compareBytes(encodeCanonical(snapshot), bytes) !== 0) return undefined;
		return roomApplicationStateLimit(snapshot);
	} catch {
		return undefined;
	}
}
