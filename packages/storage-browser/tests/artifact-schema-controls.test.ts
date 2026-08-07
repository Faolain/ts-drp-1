import { describe, expect, it } from "vitest";

import { parseFailureArtifact } from "./fixtures/artifacts.js";
import { EXPECTED_NEW_DIGEST, EXPECTED_OLD_DIGEST, FIXTURE_OBJECT_ID } from "./fixtures/fixture-records.js";

const VALID_FAILURE = Object.freeze({
	schemaVersion: 1,
	verdict: "fail",
	browser: { executablePath: "/tmp/chromium", name: "chromium", version: "149.0.7827.55" },
	databaseName: "phase-2b-tuple-database-open-before",
	expectedDigests: { old: EXPECTED_OLD_DIGEST, new: EXPECTED_NEW_DIGEST },
	gitSha: "9bddfcbda8883554d0100c3b37bf9950e810d93e",
	objectId: FIXTURE_OBJECT_ID,
	platform: "darwin",
	profilePath: "/tmp/phase-2b-profile",
	runId: "tuple-database-open-before",
	runKind: "tuple",
	stage: "hit",
	code: "DRIVER_NOT_IMPLEMENTED",
	detail: "inert RED driver",
});

describe("Phase 2b closed artifact controls", () => {
	it("accepts the closed causal RED failure", () => {
		expect(parseFailureArtifact(VALID_FAILURE)).toEqual(VALID_FAILURE);
	});

	it("rejects pass-shaped, extra, unknown-code and unbounded failure records", () => {
		const nonenumerableExtra = { ...VALID_FAILURE };
		Object.defineProperty(nonenumerableExtra, "hidden", { enumerable: false, value: true });
		const symbolExtra = { ...VALID_FAILURE, [Symbol("artifact-extra")]: true };
		const accessor = { ...VALID_FAILURE };
		Object.defineProperty(accessor, "detail", { enumerable: true, get: (): string => "inert RED driver" });
		const malformed = [
			{ ...VALID_FAILURE, verdict: "pass" },
			{ ...VALID_FAILURE, extra: true },
			{ ...VALID_FAILURE, code: "SOMETHING_ELSE" },
			{ ...VALID_FAILURE, detail: "x".repeat(257) },
			{ ...VALID_FAILURE, browser: { ...VALID_FAILURE.browser, extra: true } },
			{ ...VALID_FAILURE, expectedDigests: { ...VALID_FAILURE.expectedDigests, old: "0".repeat(64) } },
			nonenumerableExtra,
			symbolExtra,
			accessor,
		];
		for (const candidate of malformed) expect(() => parseFailureArtifact(candidate)).toThrow(TypeError);
	});
});
