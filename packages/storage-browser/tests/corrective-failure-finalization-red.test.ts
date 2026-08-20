import { describe, expect, it } from "vitest";

import { parseFailureArtifact } from "./fixtures/artifacts.js";
import { processFailureBase } from "./fixtures/corrective-artifact-fixtures.js";
import { finalizeFailedRun } from "./fixtures/run-finalizer.js";

describe("shared process failure finalization", () => {
	it("writes one parser-accepted artifact and reports unresolved owned groups", () => {
		const written: unknown[] = [];
		const killed: number[] = [];
		const observation = finalizeFailedRun(
			{
				base: processFailureBase(),
				stage: "freeze",
				code: "FOREST_CONTRADICTION",
				detail: "FOREST_CONTRADICTION: injected partial validation",
				partialEvidence: {},
				ownedGroups: [401, 402],
				validatedGroups: [401, 999],
			},
			{
				writeArtifact: (artifact): void => void written.push(artifact),
				killValidatedGroup: (pgid): void => void killed.push(pgid),
			}
		);
		expect(written).toHaveLength(1);
		expect(parseFailureArtifact(written[0])).toEqual(observation.artifact);
		expect(killed).toEqual([401]);
		expect(observation.cleanupKilledGroups).toEqual([401]);
		expect(observation.unresolvedOwnedGroups).toEqual([402]);
	});

	it("keeps a validated group unresolved when its cleanup effect fails", () => {
		const observation = finalizeFailedRun(
			{
				base: processFailureBase(),
				stage: "kill",
				code: "SURVIVOR",
				detail: "SURVIVOR: injected signal failure",
				partialEvidence: {},
				ownedGroups: [401],
				validatedGroups: [401],
			},
			{
				writeArtifact: (): void => undefined,
				killValidatedGroup: (): never => {
					throw new TypeError("injected");
				},
			}
		);
		expect(observation.cleanupKilledGroups).toEqual([]);
		expect(observation.unresolvedOwnedGroups).toEqual([401]);
	});
});
