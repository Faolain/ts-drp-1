import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { parseStorageObjectId } from "@ts-drp/storage";

export const FIXTURE_OBJECT_ID = "phase-2b-driver:0123456789abcdef0123456789abcdef";
export const FIXTURE_DIGEST_DOMAIN = "ts-drp-storage/phase-2b-fixture-records/v1";
export const EXPECTED_OLD_DIGEST = "cdf77e1d98b0de25ca8fdf724b5c89c4775d29a7db93e3c407a07cf8a84cb597";
export const EXPECTED_NEW_DIGEST = "cee718cf8641dd4f24d73cb0e4e06ddcae83ae2645936aac34aeccde1f346691";

export interface ClosedFixtureRecord {
	readonly bytes: readonly number[];
	readonly generation: 0 | 1;
	readonly key: "left" | "right";
	readonly objectId: typeof FIXTURE_OBJECT_ID;
}

export interface RawFixtureRecord {
	readonly bytes: Uint8Array;
	readonly generation: 0 | 1;
	readonly key: "left" | "right";
	readonly objectId: typeof FIXTURE_OBJECT_ID;
}

export type FixtureState = "old" | "new" | "mixed";

export interface FixtureClassification {
	readonly digest: string;
	readonly mixed: boolean;
	readonly records: readonly [ClosedFixtureRecord, ClosedFixtureRecord];
	readonly state: FixtureState;
}

const OLD_BYTES = Object.freeze({ left: [0x6f, 0x6c, 0x64, 0x2d, 0x6c], right: [0x6f, 0x6c, 0x64, 0x2d, 0x72] });
const NEW_BYTES = Object.freeze({ left: [0x6e, 0x65, 0x77, 0x2d, 0x6c], right: [0x6e, 0x65, 0x77, 0x2d, 0x72] });

function parsedFixtureObjectId(): void {
	const parsed = parseStorageObjectId(FIXTURE_OBJECT_ID);
	if (!parsed.ok || parsed.value !== FIXTURE_OBJECT_ID) throw new TypeError("frozen Phase 2b object ID is invalid");
}

function bytesEqual(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isShared(bytes: Uint8Array): boolean {
	return typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer;
}

function isOwnDataRecord(value: object, keys: readonly string[]): boolean {
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	const names = Object.getOwnPropertyNames(value).sort();
	if (names.length !== keys.length || names.some((name, index) => name !== [...keys].sort()[index])) return false;
	return names.every((name) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
	});
}

function isDenseClosedByteArray(value: unknown): value is number[] {
	if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
	if (Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			!Number.isInteger(descriptor.value) ||
			descriptor.value < 0 ||
			descriptor.value > 0xff
		) {
			return false;
		}
	}
	return true;
}

function closeOracleRecord(value: unknown): ClosedFixtureRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (!isOwnDataRecord(value, ["bytes", "generation", "key", "objectId"])) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.key !== "left" && candidate.key !== "right") return undefined;
	if (candidate.objectId !== FIXTURE_OBJECT_ID || (candidate.generation !== 0 && candidate.generation !== 1)) {
		return undefined;
	}
	if (!(candidate.bytes instanceof Uint8Array) || isShared(candidate.bytes)) return undefined;
	return Object.freeze({
		key: candidate.key,
		objectId: FIXTURE_OBJECT_ID,
		generation: candidate.generation,
		bytes: Object.freeze(Array.from(candidate.bytes)),
	});
}

function closeParentRecord(value: unknown): ClosedFixtureRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (!isOwnDataRecord(value, ["bytes", "generation", "key", "objectId"])) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.key !== "left" && candidate.key !== "right") return undefined;
	if (candidate.objectId !== FIXTURE_OBJECT_ID || (candidate.generation !== 0 && candidate.generation !== 1)) {
		return undefined;
	}
	if (!isDenseClosedByteArray(candidate.bytes)) return undefined;
	return Object.freeze({
		key: candidate.key,
		objectId: FIXTURE_OBJECT_ID,
		generation: candidate.generation,
		bytes: Object.freeze([...candidate.bytes] as number[]),
	});
}

function exactPair(
	values: readonly unknown[],
	close: (value: unknown) => ClosedFixtureRecord | undefined
): [ClosedFixtureRecord, ClosedFixtureRecord] {
	if (values.length !== 2) throw new TypeError("recovery requires exactly two records");
	const closed = values.map(close);
	if (closed.some((record) => record === undefined)) {
		throw new TypeError("recovery record is outside the closed schema");
	}
	const records = closed as [ClosedFixtureRecord, ClosedFixtureRecord];
	if (records[0].key !== "left" || records[1].key !== "right") {
		throw new TypeError("recovery requires the exact ordered left/right pair");
	}
	return records;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the test-only record-image diagnostic.
 * @param records - Closed left/right record pair.
 * @returns Lowercase hexadecimal diagnostic.
 */
export function fixtureRecordsDigest(records: readonly [ClosedFixtureRecord, ClosedFixtureRecord]): string {
	return hex(hashDomain(FIXTURE_DIGEST_DOMAIN, encodeCanonical(records)));
}

/**
 * Constructs the exact old fixture image.
 * @returns Two records with fresh non-shared byte arrays.
 */
export function seedFixtureRecords(): readonly [RawFixtureRecord, RawFixtureRecord] {
	parsedFixtureObjectId();
	return [
		{ key: "left", objectId: FIXTURE_OBJECT_ID, generation: 0, bytes: Uint8Array.from(OLD_BYTES.left) },
		{ key: "right", objectId: FIXTURE_OBJECT_ID, generation: 0, bytes: Uint8Array.from(OLD_BYTES.right) },
	];
}

/**
 * Constructs the exact new fixture image.
 * @returns Two records with fresh non-shared byte arrays.
 */
export function transitionFixtureRecords(): readonly [RawFixtureRecord, RawFixtureRecord] {
	parsedFixtureObjectId();
	return [
		{ key: "left", objectId: FIXTURE_OBJECT_ID, generation: 1, bytes: Uint8Array.from(NEW_BYTES.left) },
		{ key: "right", objectId: FIXTURE_OBJECT_ID, generation: 1, bytes: Uint8Array.from(NEW_BYTES.right) },
	];
}

/**
 * Independently closes a complete IndexedDB cursor image for parent transport.
 * @param values - Untrusted raw cursor values in key order.
 * @returns The exact closed left/right pair.
 */
export function validateOracleRecords(values: readonly unknown[]): readonly [ClosedFixtureRecord, ClosedFixtureRecord] {
	parsedFixtureObjectId();
	return Object.freeze(exactPair(values, closeOracleRecord));
}

/**
 * Revalidates transported byte numbers, rebuilds arrays, and classifies the image.
 * @param values - Untrusted closed parent-side values.
 * @returns Closed records, diagnostic, and old/new/mixed state.
 */
export function classifyParentRecords(values: readonly unknown[]): FixtureClassification {
	parsedFixtureObjectId();
	const records = exactPair(values, closeParentRecord);
	const old =
		records.every((record) => record.generation === 0) &&
		bytesEqual(records[0].bytes, OLD_BYTES.left) &&
		bytesEqual(records[1].bytes, OLD_BYTES.right);
	const fresh =
		records.every((record) => record.generation === 1) &&
		bytesEqual(records[0].bytes, NEW_BYTES.left) &&
		bytesEqual(records[1].bytes, NEW_BYTES.right);
	const state: FixtureState = old ? "old" : fresh ? "new" : "mixed";
	return Object.freeze({
		records: Object.freeze(records),
		state,
		mixed: state === "mixed",
		digest: fixtureRecordsDigest(records),
	});
}
