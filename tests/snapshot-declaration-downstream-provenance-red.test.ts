import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { beforeAll, expect, test } from "vitest";

const boundaries = [
	"encoder-payload",
	"encoder-self-check",
	"stream",
	"stream-discard-fails",
	"pull-initial",
	"pull-receipt",
] as const;
const variants = ["range", "type", "non-error"] as const;
interface Result {
	boundary: string;
	variant: string;
	expected: string;
	observed: string;
	controls: Record<string, boolean>;
	events: Array<{ phase: string; injected: boolean; stack: string }>;
	cleanup?: Record<string, boolean>;
}
const results = new Map<string, Result>();
beforeAll(() => {
	for (const boundary of boundaries)
		for (const variant of variants) {
			const pull = boundary.startsWith("pull");
			const args = pull
				? [
						"exec",
						"vitest",
						"run",
						"--config",
						"tests/fixtures/snapshot-declaration-downstream-provenance/vitest.config.mts",
						"--workspace",
						"tests/fixtures/snapshot-declaration-downstream-provenance/vitest.workspace.ts",
						"--coverage.enabled=false",
					]
				: ["--import", "tsx", "tests/fixtures/snapshot-declaration-downstream-provenance/child.ts", boundary, variant];
			const stdout = execFileSync(pull ? "pnpm" : process.execPath, args, {
				encoding: "utf8",
				timeout: 60000,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, DOWNSTREAM_BOUNDARY: boundary, DOWNSTREAM_VARIANT: variant },
			});
			const line = pull
				? stdout
						.split("\n")
						.find((line) => line.startsWith("DOWNSTREAM_RESULT="))
						?.slice("DOWNSTREAM_RESULT=".length)
				: stdout.trim();
			assert.ok(line);
			const result = JSON.parse(line) as Result;
			assert.equal(result.boundary, boundary);
			assert.equal(result.variant, variant);
			results.set(`${boundary}:${variant}`, result);
			console.log("DOWNSTREAM_RESULT=" + JSON.stringify(result));
		}
}, 120000);
for (const boundary of boundaries)
	for (const variant of variants) {
		test(`reached-path and preserved controls: ${boundary}:${variant}`, () => {
			const result = results.get(`${boundary}:${variant}`);
			assert.ok(result);
			expect(Object.values(result.controls).every(Boolean)).toBe(true);
			expect(result.events.filter((event) => event.injected)).toHaveLength(1);
			expect(result.events.some((event) => event.phase === "control" && !event.injected)).toBe(true);
			expect(result.events.some((event) => event.phase === "retry" && !event.injected)).toBe(true);
			if (boundary.startsWith("pull")) expect(Object.values(result.cleanup ?? {})).toEqual([true, true, true]);
		});
		test(`normative downstream provenance: ${boundary}:${variant}`, () => {
			const result = results.get(`${boundary}:${variant}`);
			assert.ok(result);
			expect(result.observed, `DOWNSTREAM_PROVENANCE_GAP ${boundary}:${variant}`).toBe(result.expected);
		});
	}
