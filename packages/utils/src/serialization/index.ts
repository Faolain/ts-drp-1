import { decode } from "@msgpack/msgpack";
import { DRPState, DRPStateEntry, DRPStateEntryOtherTheWire, DRPStateOtherTheWire } from "@ts-drp/types";

import { createDecodingContext, serializationCodec, type SerializationContext, serializeValue } from "./equality.js";

export { serializedValuesEqual, serializeValue } from "./equality.js";

const extensionPayloadDecoders = {
	set: (data: Uint8Array, context: SerializationContext): unknown =>
		decode<SerializationContext>(data, { extensionCodec: serializationCodec, context }),
	map: (data: Uint8Array, context: SerializationContext): unknown =>
		decode<SerializationContext>(data, { extensionCodec: serializationCodec, context }),
	binary: (data: Uint8Array): unknown => decode(data),
};

const decodeExtensionPayload: SerializationContext["decodePayload"] = (data, extensionType, context): unknown => {
	switch (extensionType) {
		case 0:
			return extensionPayloadDecoders.set(data, context);
		case 1:
			return extensionPayloadDecoders.map(data, context);
		case 2:
			return extensionPayloadDecoders.binary(data);
		default:
			throw new TypeError(`Unknown MessagePack extension ${extensionType}`);
	}
};

/**
 * Main entry point for deserialization.
 * Converts a Uint8Array back into the original value structure.
 * @param value - The value to deserialize
 * @returns The deserialized value
 */
export function deserializeValue(value: Uint8Array): unknown {
	const context = createDecodingContext(decodeExtensionPayload, value.byteLength);
	return decode<SerializationContext>(value, { extensionCodec: serializationCodec, context });
}

/**
 * Serializes a DRP state into a DRPStateOtherTheWire object.
 * @param state - The DRP state to serialize
 * @returns The serialized DRP state
 */
export function serializeDRPState(state?: DRPState): DRPStateOtherTheWire {
	const drpState = DRPStateOtherTheWire.create();
	for (const e of state?.state ?? []) {
		const entry = DRPStateEntryOtherTheWire.create({
			key: e.key,
			data: serializeValue(e.value),
		});
		drpState.state.push(entry);
	}
	return drpState;
}

/**
 * Deserializes a DRPStateOtherTheWire object into a DRPState object.
 * @param state - The DRP state to deserialize
 * @returns The deserialized state
 */
export function deserializeDRPState(state?: DRPStateOtherTheWire): DRPState {
	const drpState = DRPState.create();

	for (const e of state?.state ?? []) {
		const entry = DRPStateEntry.create({
			key: e.key,
			value: deserializeValue(e.data),
		});
		drpState.state.push(entry);
	}
	return drpState;
}
