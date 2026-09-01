import { describe, expect, it } from "vitest";

import {
	D110A_BATCH_VERTICES_PER_OBJECT,
	D110A_MUTANT_ERROR,
	D110A_MUTANTS,
	D110A_OBJECT_EPOCHS,
	D110A_OPERATIONS_PER_OBJECT,
	D110A_RED_TOKENS,
	D110A_SLOPE_LIMIT_BYTES,
	D110A_TOTAL_BATCH_VERTICES,
	D110A_TOTAL_OPERATIONS,
	d110aCurrentInfrastructureAudit,
	d110aMutantProof,
	d110aSyntheticProof,
	requireD110aHardEntrypoint,
	requireD110aPairedWorkloadGate,
	requireD110aPostGcSlopeGate,
	validateD110aProof,
} from "./fixtures/phase-6c/retained-heap-contract.js";

describe("D.110a retained-heap hard-gate RED", () => {
	it("freezes exact workload, window and epsilon arithmetic", () => {
		expect(D110A_OPERATIONS_PER_OBJECT).toBe(976 * 16 + 9);
		expect(D110A_TOTAL_OPERATIONS).toBe(D110A_OPERATIONS_PER_OBJECT * D110A_OBJECT_EPOCHS);
		expect(D110A_TOTAL_BATCH_VERTICES).toBe(D110A_BATCH_VERTICES_PER_OBJECT * D110A_OBJECT_EPOCHS);
		expect(D110A_SLOPE_LIMIT_BYTES * 31).toBe(5_119_991);
		expect(64 - 19).toBe(45);
	});

	it("accepts the independent synthetic validator control", () => {
		expect(validateD110aProof(d110aSyntheticProof())).toEqual({
			arrayBufferSlope: 0,
			heapSlope: 0,
			maximumHeapUsed: 20_000_000,
			maximumOwnedBytes: 21_000_000,
			ownedBytesSlope: 0,
		});
	});

	it.each(D110A_MUTANTS)("rejects the %s false gate with its exact code", (mutant) => {
		expect(() => validateD110aProof(d110aMutantProof(mutant))).toThrow(D110A_MUTANT_ERROR[mutant]);
	});

	it("audits the complete hard-gate infrastructure without readiness skips", () => {
		expect(d110aCurrentInfrastructureAudit()).toEqual({
			hardEntrypoint: true,
			pairedWorkloadGate: true,
			postGcSlopeGate: true,
		});
	});

	it(`closes ${D110A_RED_TOKENS[0]}`, () => {
		requireD110aPostGcSlopeGate();
	});

	it(`closes ${D110A_RED_TOKENS[1]}`, () => {
		requireD110aPairedWorkloadGate();
	});

	it(`closes ${D110A_RED_TOKENS[2]}`, () => {
		requireD110aHardEntrypoint();
	});
});
