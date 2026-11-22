import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeGenerationRecordV1, decodeHeadRecordV1 } from "../src/codecs.js";

describe("Phase 2e2 persisted taxonomy and poison contract RED", () => {
	it("adds only the four ratified public lifecycle/recovery reasons", () => {
		const source = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
		for (const reason of [
			"STORE_POISONED",
			"ADOPTED_BLOB_UNPROMOTED",
			"ADOPTED_BLOB_MISSING",
			"ADOPTED_BLOB_CORRUPT",
		]) {
			expect.soft(source).toContain(`| "${reason}"`);
		}
		// Phase 2e3 deliberately supersedes 2e2's temporary no-recovery guard. The
		// atomic authority flip is now indivisible with the public recovery surface.
		expect.soft(source).toContain("recoverActiveGeneration(");
	});

	it("keeps malformed persisted bytes noncanonical in the shared codecs", () => {
		expect.soft(decodeHeadRecordV1(Uint8Array.of(255))).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect.soft(decodeGenerationRecordV1(Uint8Array.of(255))).toEqual({
			ok: false,
			reason: "NON_CANONICAL_RECORD",
		});
	});
});
