import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CUSTODY_SCHEMA, REQUIRED_SCENARIOS, validateCustody } from "./browser/fixtures/custody.js";

describe("Phase 2f-b authoritative browser gate configuration RED", () => {
	it("freezes the two authoritative engines and bounded execution policy", () => {
		const source = readFileSync(new URL("../playwright.phase-2f-b-handshake.config.ts", import.meta.url), "utf8");
		expect(source).toMatch(/forbidOnly:\s*true/u);
		expect(source).toMatch(/fullyParallel:\s*false/u);
		expect(source).toMatch(/workers:\s*1/u);
		expect(source).toMatch(/retries:\s*0/u);
		expect(source).toMatch(/timeout:\s*60_000/u);
		expect(source).toMatch(/globalTimeout:\s*180_000/u);
		expect([...source.matchAll(/name:\s*"(firefox|webkit)"/gu)].map((match) => match[1])).toEqual([
			"firefox",
			"webkit",
		]);
	});

	it("requires real synchronous delay and endpoint timestamps rather than elapsed self-attestation", () => {
		const delay = readFileSync(new URL("./browser/fixtures/delay-evaluation.ts", import.meta.url), "utf8");
		const worker = readFileSync(new URL("./browser/fixtures/positive-worker.ts", import.meta.url), "utf8");
		expect(delay).toMatch(/performance\.now\(\)\s*\+\s*1_500/u);
		expect(worker).toMatch(/^import\s+"\.\/delay-evaluation\.js";/u);
		expect(worker).toMatch(/readySentAtMs\s*=\s*performance\.now\(\)/u);
		expect(worker).toMatch(/requestReceivedAtMs\s*=\s*performance\.now\(\)/u);
	});

	it("fails closed for missing, extra, malformed, skipped, blocked, or timed-out custody shapes", () => {
		const valid = {
			schema: CUSTODY_SCHEMA,
			engine: "firefox",
			build: "151.0",
			os: "MacIntel",
			scenario: REQUIRED_SCENARIOS[0],
			readySentAtMs: null,
			requestReceivedAtMs: null,
			chunks: 0,
			bytes: 0,
			verdict: "pass",
		};
		expect(() => validateCustody(valid)).not.toThrow();
		for (const mutant of [
			{ ...valid, extra: true },
			{ ...valid, verdict: "skipped" },
			{ ...valid, verdict: "blocked" },
			{ ...valid, verdict: "timed-out" },
			{ ...valid, engine: "chromium" },
			{ ...valid, chunks: -1 },
		]) {
			expect(() => validateCustody(mutant)).toThrow();
		}
	});
});
