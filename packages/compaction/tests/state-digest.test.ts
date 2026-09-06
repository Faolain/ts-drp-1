import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { loadCompaction, sourceExists } from "./contract.js";

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe.skipIf(!sourceExists)("Phase 0b state digest contract", () => {
	it("is exactly the synchronous canonical state-v2 domain hash in lowercase hex", async () => {
		const module = await loadCompaction();
		const states: unknown[] = [
			null,
			{},
			{ count: 3, nested: { bytes: Uint8Array.of(0, 1, 255) } },
			new Map<unknown, unknown>([
				["z", 1],
				["a", new Set([3, 2, 1])],
			]),
		];
		for (const state of states) {
			const expected = hex(hashDomain("ts-drp/state/v2", encodeCanonical(state)));
			const actual = module.stateDigest(state);
			expect(actual).toBe(expected);
			expect(actual).toMatch(/^[0-9a-f]{64}$/u);
			expect(actual).not.toBeInstanceOf(Promise);
		}
	});

	it("is deterministic across insertion order and rejects values outside the canonical domain", async () => {
		const module = await loadCompaction();
		expect(module.stateDigest({ a: 1, z: 2 })).toBe(module.stateDigest({ z: 2, a: 1 }));
		expect(() => module.stateDigest({ invalid: Number.NaN })).toThrow();
		expect(() => module.stateDigest({ invalid: () => undefined })).toThrow();
	});
});
