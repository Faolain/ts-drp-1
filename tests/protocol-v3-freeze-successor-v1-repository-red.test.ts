import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { CompletedRepositoryCandidateEvidence } from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.js";
import {
	normalizedChildOutput,
	REPOSITORY_ROOT,
	successorContract,
} from "./fixtures/phase-3a1b-freeze-successor-v1/successor-test-context.js";
import {
	repositoryCandidateAvailability,
	runRepositoryCandidateMatrix,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

describe("D.93.35.5 genuine repository successor causal RED", () => {
	it("requires the exact owner, atomic workflow routing, native positives and complete rejection matrix with no fallback", async () => {
		const availability = repositoryCandidateAvailability(REPOSITORY_ROOT);
		expect(availability.checker).toBe(
			resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs")
		);
		const evidence = await runRepositoryCandidateMatrix(REPOSITORY_ROOT, successorContract);
		expect(evidence.available, `successor owner absent at ${availability.checker}`).toBe(true);
		if (!evidence.available || !("positives" in evidence)) return;
		const completed = evidence as CompletedRepositoryCandidateEvidence;
		expect(completed.inventory).toHaveLength(58);
		expect(completed.immutable).toHaveLength(53);
		for (const [index, result] of completed.positives.entries()) {
			expect(result.signal, `positive:${index}`).toBeNull();
			expect(result.status, `positive:${index}\n${normalizedChildOutput(result)}`).toBe(0);
			expect(result.output).toContain("protocol-v3 freeze successor: PASS");
		}
		expect(completed.negatives.filter(({ name }) => name.startsWith("immutable:"))).toHaveLength(53);
		for (const { name, result } of completed.negatives) {
			expect(result.signal, name).toBeNull();
			expect(typeof result.status, name).toBe("number");
			expect(result.status, `${name}\n${normalizedChildOutput(result)}`).not.toBe(0);
		}
	}, 240_000);
});
