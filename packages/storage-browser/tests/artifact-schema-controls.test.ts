import { describe, expect, it } from "vitest";

import { parseFailureArtifact } from "./fixtures/artifacts.js";

const VALID_FAILURE = Object.freeze({
	schemaVersion: 1,
	verdict: "fail",
	browser: { executablePath: "/opt/chromium", name: "chromium", version: "149.0" },
	databaseName: "process-cleanup-control",
	gitSha: "a".repeat(40),
	platform: "darwin",
	profilePath: "/tmp/process-cleanup-control",
	runId: "process-cleanup-control",
	stage: "freeze",
	code: "FOREST_CONTRADICTION",
	detail: "FOREST_CONTRADICTION: injected control",
	partialEvidence: { cleanup: { validatedGroups: [], unresolvedOwnedGroups: [] } },
});

describe("closed process-cleanup artifact controls", () => {
	it("accepts one closed reached failure", () => {
		expect(parseFailureArtifact(VALID_FAILURE)).toEqual(VALID_FAILURE);
	});

	it("rejects pass-shaped, extra, unknown-code, overlapping, and unbounded records", () => {
		const accessor = { ...VALID_FAILURE };
		Object.defineProperty(accessor, "detail", { enumerable: true, get: (): string => "hidden" });
		for (const candidate of [
			{ ...VALID_FAILURE, verdict: "pass" },
			{ ...VALID_FAILURE, extra: true },
			{ ...VALID_FAILURE, code: "SOMETHING_ELSE" },
			{ ...VALID_FAILURE, detail: "x".repeat(257) },
			{
				...VALID_FAILURE,
				partialEvidence: { cleanup: { validatedGroups: [42], unresolvedOwnedGroups: [42] } },
			},
			{
				...VALID_FAILURE,
				partialEvidence: {
					cleanup: { validatedGroups: [], unresolvedOwnedGroups: [] },
					recordedForest: [{ pid: 42 }],
				},
			},
			accessor,
		])
			expect(() => parseFailureArtifact(candidate)).toThrow(TypeError);
	});
});
