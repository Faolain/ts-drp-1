import { describe, expect, it } from "vitest";

import { parseFailureArtifact } from "./fixtures/artifacts.js";
import { processFailureBase } from "./fixtures/corrective-artifact-fixtures.js";
import { finalizeFailedRun } from "./fixtures/run-finalizer.js";

describe("persisted process-cleanup artifacts", () => {
	it("survives a JSON round trip without losing cleanup custody", () => {
		const artifact = finalizeFailedRun(
			{
				base: processFailureBase(),
				stage: "recovery",
				code: "RECOVERY_INVALID",
				detail: "RECOVERY_INVALID: injected control",
				partialEvidence: {},
				ownedGroups: [410, 420],
				validatedGroups: [410],
			},
			{ killValidatedGroup: (): void => undefined, writeArtifact: (): void => undefined }
		).artifact;
		const persisted = JSON.parse(JSON.stringify(artifact)) as unknown;
		expect(parseFailureArtifact(persisted).partialEvidence.cleanup).toEqual({
			validatedGroups: [410],
			unresolvedOwnedGroups: [420],
		});
	});

	it("rejects custody evidence with duplicate process groups", () => {
		const artifact = finalizeFailedRun(
			{
				base: processFailureBase(),
				stage: "kill",
				code: "SURVIVOR",
				detail: "SURVIVOR: injected control",
				partialEvidence: {},
				ownedGroups: [],
				validatedGroups: [],
			},
			{ killValidatedGroup: (): void => undefined, writeArtifact: (): void => undefined }
		).artifact;
		expect(() =>
			parseFailureArtifact({
				...artifact,
				partialEvidence: { cleanup: { validatedGroups: [410, 410], unresolvedOwnedGroups: [] } },
			})
		).toThrow(TypeError);
	});
});
