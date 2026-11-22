import {
	decodeGenerationRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
} from "../../../packages/storage/dist/src/index.js";
/**
 * Fault-only setup mutation after valid public construction; never imported by product recovery.
 * @param records - Exact durable native generation records.
 * @returns The validly constructed candidate with deliberately unmatched base bytes.
 */
export function unmatchedRecord(records: readonly { generationId: string; record: Uint8Array }[]): {
	generationId: string;
	record: Uint8Array;
	expectedBase: ExpectedHead;
} {
	const id = "0".repeat(63) + "1";
	const row = records.find((value) => value.generationId === id);
	if (row === undefined) throw new Error("UNMATCHED_NATIVE_ROW_MISSING");
	const decoded = decodeGenerationRecordV1(row.record);
	if (
		!decoded.ok ||
		decoded.value.generationId !== id ||
		decoded.value.state !== "Complete" ||
		decoded.value.baseExpectedHead.kind !== "present"
	)
		throw new Error("UNMATCHED_NATIVE_PRECONDITION");
	const selected = decoded.value;
	const base = decoded.value.baseExpectedHead;
	const proposed = records.find((value) => value.generationId === base.generationId);
	if (proposed === undefined) throw new Error("UNMATCHED_NATIVE_PROPOSED_MISSING");
	const old = decodeGenerationRecordV1(proposed.record);
	if (
		!old.ok ||
		old.value.generationId !== proposed.generationId ||
		old.value.objectId !== selected.objectId ||
		old.value.baseExpectedHead.kind !== "present" ||
		old.value.baseExpectedHead.generationId === proposed.generationId
	)
		throw new Error("UNMATCHED_NATIVE_PROPOSED_INVALID");
	const record = encodeGenerationRecordV1({ ...selected, baseExpectedHead: old.value.baseExpectedHead });
	return { generationId: id, record, expectedBase: old.value.baseExpectedHead };
}
/**
 * Verify real persisted native envelope and its exact deliberately unmatched base.
 * @param persisted - Bytes reread from the exact native database.
 * @param expectedBase - Decoded predecessor base captured by the plan.
 */
export function verifyUnmatchedPersistence(persisted: Uint8Array, expectedBase: ExpectedHead): void {
	const decoded = decodeGenerationRecordV1(persisted);
	if (!decoded.ok || decoded.value.state !== "Complete" || decoded.value.generationId !== "0".repeat(63) + "1")
		throw new Error("UNMATCHED_NATIVE_PERSISTED_DECODE");
	const actual = encodeHeadRecordV1(decoded.value.baseExpectedHead),
		expected = encodeHeadRecordV1(expectedBase);
	if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index]))
		throw new Error("UNMATCHED_NATIVE_PERSISTED_BASE");
}
