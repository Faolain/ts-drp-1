import { describe, expect, it } from "vitest";

import {
	classifyParentRecords,
	EXPECTED_NEW_DIGEST,
	EXPECTED_OLD_DIGEST,
	FIXTURE_DIGEST_DOMAIN,
	FIXTURE_OBJECT_ID,
	fixtureRecordsDigest,
	seedFixtureRecords,
	transitionFixtureRecords,
	validateOracleRecords,
} from "./fixtures/fixture-records.js";

describe("Phase 2b independent fixture oracle controls", () => {
	it("recomputes the checked-in old and new diagnostics and classifier", () => {
		const old = classifyParentRecords(validateOracleRecords(seedFixtureRecords()));
		const fresh = classifyParentRecords(validateOracleRecords(transitionFixtureRecords()));
		expect(old).toMatchObject({ state: "old", mixed: false, digest: EXPECTED_OLD_DIGEST });
		expect(fresh).toMatchObject({ state: "new", mixed: false, digest: EXPECTED_NEW_DIGEST });
		expect(fixtureRecordsDigest(old.records)).toBe(EXPECTED_OLD_DIGEST);
		expect(fixtureRecordsDigest(fresh.records)).toBe(EXPECTED_NEW_DIGEST);
		expect(FIXTURE_DIGEST_DOMAIN).toBe("ts-drp-storage/phase-2b-fixture-records/v1");
	});

	it("owns fresh bytes and classifies every other complete image as mixed", () => {
		const first = seedFixtureRecords();
		const second = seedFixtureRecords();
		expect(first[0].bytes).not.toBe(first[1].bytes);
		expect(first[0].bytes).not.toBe(second[0].bytes);
		const mixed = classifyParentRecords(validateOracleRecords([first[0], transitionFixtureRecords()[1]]));
		expect(mixed).toMatchObject({ state: "mixed", mixed: true });
		const transported = validateOracleRecords(first);
		const rebuilt = classifyParentRecords(transported);
		expect(rebuilt.records[0].bytes).not.toBe(transported[0].bytes);
	});

	it("rejects malformed, extra, duplicate, accessor, wrong-ID and wrong-byte records", () => {
		const [left, right] = seedFixtureRecords();
		const symbolField = Symbol("extra-record-field");
		const symbolRecord = { ...left, [symbolField]: true };
		const accessor = Object.defineProperties(
			{},
			{
				key: { enumerable: true, get: (): string => "left" },
				objectId: { enumerable: true, value: FIXTURE_OBJECT_ID },
				generation: { enumerable: true, value: 0 },
				bytes: { enumerable: true, value: Uint8Array.of(1) },
			}
		);
		const cases: readonly (readonly unknown[])[] = [
			[left],
			[left, right, right],
			[left, left],
			[accessor, right],
			[{ ...left, objectId: "plain-object" }, right],
			[{ ...left, generation: 2 }, right],
			[{ ...left, bytes: [1, 2, 3] }, right],
			[{ ...left, extra: true }, right],
			[symbolRecord, right],
		];
		for (const candidate of cases) expect(() => validateOracleRecords(candidate)).toThrow(TypeError);
		const closed = validateOracleRecords([left, right]);
		for (const bytes of [[-1], [256], [1.5], [Number.NaN]]) {
			expect(() => classifyParentRecords([{ ...closed[0], bytes }, closed[1]])).toThrow(TypeError);
		}
	});

	it("requires dense closed parent bytes while keeping wrong dense values mixed", () => {
		const [left, right] = validateOracleRecords(seedFixtureRecords());
		const sparse = new Array<number>(left.bytes.length);
		sparse[0] = left.bytes[0] ?? 0;
		const accessor = [...left.bytes];
		Object.defineProperty(accessor, "0", { enumerable: true, get: (): number => left.bytes[0] ?? 0 });
		const extra = [...left.bytes];
		Object.defineProperty(extra, "metadata", { enumerable: true, value: true });
		const symbol = [...left.bytes];
		Object.defineProperty(symbol, Symbol("bytes-expando"), { enumerable: true, value: true });
		for (const bytes of [sparse, accessor, extra, symbol]) {
			expect(() => classifyParentRecords([{ ...left, bytes }, right])).toThrow(TypeError);
		}
		expect(classifyParentRecords([{ ...left, bytes: [1, 2, 3] }, right])).toMatchObject({
			state: "mixed",
			mixed: true,
		});
	});

	it.runIf(typeof SharedArrayBuffer !== "undefined")("rejects shared-backed bytes", () => {
		const [left, right] = seedFixtureRecords();
		const shared = new Uint8Array(new SharedArrayBuffer(left.bytes.byteLength));
		shared.set(left.bytes);
		expect(() => validateOracleRecords([{ ...left, bytes: shared }, right])).toThrow(TypeError);
	});
});
