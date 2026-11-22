import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

import {
	CODEC_BOUNDARIES,
	type ProvenanceResult,
	THROWN_VALUES,
} from "./fixtures/snapshot-declaration-provenance/codec-provenance-cases.js";

const results = new Map<string, ProvenanceResult>();
beforeAll(() => {
	for (const boundary of CODEC_BOUNDARIES) {
		for (const thrownValue of THROWN_VALUES) {
			const stdout = execFileSync(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(
						new URL("./fixtures/snapshot-declaration-provenance/codec-provenance-child.ts", import.meta.url)
					),
					boundary,
					thrownValue,
				],
				{ encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }
			);
			const result = JSON.parse(stdout) as ProvenanceResult;
			assert.equal(result.boundary, boundary);
			assert.equal(result.thrownValue, thrownValue);
			results.set(`${boundary}:${thrownValue}`, result);
			console.log(`CODEC_PROVENANCE_RESULT ${JSON.stringify(result)}`);
		}
	}
}, 60000);

test("all isolated cases import successfully and prove unarmed validity, runtime reach, same-owner deterministic errors and unchanged bytes", () => {
	expect(results.size).toBe(CODEC_BOUNDARIES.length * THROWN_VALUES.length);
	for (const result of results.values()) {
		expect(Object.values(result.controls)).toEqual([true, true, true, true, true, true]);
		expect(result.injections).toBe(1);
		expect(result.events.some((event) => event.phase === "control" && !event.injected)).toBe(true);
		expect(result.events.some((event) => event.phase === "fault" && event.injected)).toBe(true);
		expect(result.events.some((event) => event.phase === "recovery" && !event.injected)).toBe(true);
	}
});
for (const boundary of CODEC_BOUNDARIES) {
	for (const thrownValue of THROWN_VALUES) {
		test(`local codec processing provenance: ${boundary}:${thrownValue}`, () => {
			const result = results.get(`${boundary}:${thrownValue}`);
			expect(result).toBeDefined();
			assert.ok(result);
			expect(result.observed.threw, "selected runtime processing exception must propagate").toBe(true);
			if (boundary.startsWith("canonical-")) {
				expect(result.observed.isExactSentinel, `LOCAL_CODEC_PROVENANCE_GAP: ${JSON.stringify(result.observed)}`).toBe(
					true
				);
			} else {
				expect(
					{ code: result.observed.code, causeIncludesSentinel: result.observed.causeIncludesSentinel },
					`LOCAL_CODEC_PROVENANCE_GAP: ${JSON.stringify(result.observed)}`
				).toEqual({ code: "manifest-processing-failed", causeIncludesSentinel: true });
			}
		});
	}
}
