const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectCreate = Object.create;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIs = Object.is;
const ObjectPrototype = Object.prototype;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const StringCharCodeAt = String.prototype.charCodeAt;

const ENVELOPE_KEYS = ObjectFreeze(["anchor", "epoch", "objectId", "protocolMajor"] as const);
const CONTEXT_KEYS = ObjectFreeze(["anchorDigest", "epoch", "objectId", "protocolMajor"] as const);

type PlainRecord = Record<string, unknown>;

export interface V3EnvelopeScope extends Readonly<Record<string, unknown>> {
	readonly anchor: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly protocolMajor: number;
}

export interface V3CurrentAnchorContext extends Readonly<Record<string, unknown>> {
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly protocolMajor: 3;
}

export type V3EnvelopeScopeClassification =
	| Readonly<{ readonly current: true; readonly code: "CURRENT" }>
	| Readonly<{
			readonly current: false;
			readonly code: "MALFORMED_SCOPE" | "OBJECT_MISMATCH" | "PROTOCOL_MISMATCH" | "EPOCH_MISMATCH" | "ANCHOR_MISMATCH";
	  }>;

const CURRENT = ObjectFreeze({ code: "CURRENT" as const, current: true as const });
const MALFORMED_SCOPE = ObjectFreeze({ code: "MALFORMED_SCOPE" as const, current: false as const });
const OBJECT_MISMATCH = ObjectFreeze({ code: "OBJECT_MISMATCH" as const, current: false as const });
const PROTOCOL_MISMATCH = ObjectFreeze({ code: "PROTOCOL_MISMATCH" as const, current: false as const });
const EPOCH_MISMATCH = ObjectFreeze({ code: "EPOCH_MISMATCH" as const, current: false as const });
const ANCHOR_MISMATCH = ObjectFreeze({ code: "ANCHOR_MISMATCH" as const, current: false as const });

function sameKeyCapture(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function snapshotClosedRecord(value: unknown, expectedKeys: readonly string[]): PlainRecord | undefined {
	try {
		if (typeof value !== "object" || value === null || ObjectGetPrototypeOf(value) !== ObjectPrototype)
			return undefined;
		const firstKeys = ReflectOwnKeys(value);
		const secondKeys = ReflectOwnKeys(value);
		if (
			firstKeys.length !== expectedKeys.length ||
			!sameKeyCapture(firstKeys, secondKeys) ||
			firstKeys.some((key) => typeof key !== "string" || !expectedKeys.some((expectedKey) => expectedKey === key))
		) {
			return undefined;
		}
		const snapshot = ObjectCreate(null) as PlainRecord;
		for (const key of expectedKeys) {
			const first = ObjectGetOwnPropertyDescriptor(value, key);
			const second = ObjectGetOwnPropertyDescriptor(value, key);
			if (
				first === undefined ||
				second === undefined ||
				first.enumerable !== true ||
				second.enumerable !== true ||
				!("value" in first) ||
				!("value" in second) ||
				!ObjectIs(first.value, second.value)
			) {
				return undefined;
			}
			snapshot[key] = first.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function validString(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = ReflectApply(StringCharCodeAt, value, [index]) as number;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = ReflectApply(StringCharCodeAt, value, [index + 1]) as number;
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function digestHex(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 64) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = ReflectApply(StringCharCodeAt, value, [index]) as number;
		if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
	}
	return true;
}

function nonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && NumberIsSafeInteger(value) && value >= 0;
}

/**
 * Classifies an authenticated vertex projection against its installed v3 anchor context.
 * @param envelopeValue - Exact four-field projection from authenticated vertex evidence.
 * @param contextValue - Exact four-field projection from installed anchor provenance.
 * @returns A frozen, history-free semantic classification.
 */
export function classifyV3EnvelopeScope(
	envelopeValue: V3EnvelopeScope,
	contextValue: V3CurrentAnchorContext
): V3EnvelopeScopeClassification {
	const envelope = snapshotClosedRecord(envelopeValue, ENVELOPE_KEYS);
	const context = snapshotClosedRecord(contextValue, CONTEXT_KEYS);
	if (
		envelope === undefined ||
		context === undefined ||
		!digestHex(envelope.anchor) ||
		!validString(envelope.objectId) ||
		!nonnegativeSafeInteger(envelope.epoch) ||
		!nonnegativeSafeInteger(envelope.protocolMajor) ||
		!digestHex(context.anchorDigest) ||
		!validString(context.objectId) ||
		!nonnegativeSafeInteger(context.epoch) ||
		context.protocolMajor !== 3
	) {
		return MALFORMED_SCOPE;
	}
	if (envelope.objectId !== context.objectId) return OBJECT_MISMATCH;
	if (envelope.protocolMajor !== context.protocolMajor) return PROTOCOL_MISMATCH;
	if (envelope.epoch !== context.epoch) return EPOCH_MISMATCH;
	if (envelope.anchor !== context.anchorDigest) return ANCHOR_MISMATCH;
	return CURRENT;
}
