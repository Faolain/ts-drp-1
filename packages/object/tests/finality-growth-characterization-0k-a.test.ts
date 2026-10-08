import { describe, expect, it } from "vitest";

import { FinalityState, FinalityStore } from "../src/finality/index.js";

const RECORD_COUNT = 10_001;

describe("Phase 0k-a isolated enabled-finality growth characterization", () => {
	it("retains every full record monotonically across at least ten thousand distinct hashes", () => {
		const store = new FinalityStore();
		const signers = new Map([["signer", "credential"]]);
		const observedCensus: number[] = [];

		for (let index = 0; index < RECORD_COUNT; index++) {
			store.initializeState(`phase-0k-a-growth-${index}`, signers);
			if ((index + 1) % 1_000 === 0 || index + 1 === RECORD_COUNT) {
				observedCensus.push(store.states.size);
			}
		}

		expect(observedCensus).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 10_001]);
		expect(store.states.size).toBe(RECORD_COUNT);
		expect(store.states.get("phase-0k-a-growth-0")).toBeInstanceOf(FinalityState);
		expect(store.states.get(`phase-0k-a-growth-${RECORD_COUNT - 1}`)).toBeInstanceOf(FinalityState);
	}, 15_000);
});
