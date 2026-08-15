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
	repositoryCandidatePlan,
	runRepositoryCandidatePartition,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

const plan = repositoryCandidatePlan(REPOSITORY_ROOT, successorContract);
const immutableNames = plan.mutationNames.slice(0, 53);
const workflowCountNames = plan.mutationNames.slice(53, 57);
const categoryNames = plan.mutationNames.slice(57);
const partitions = [
	...plan.positiveNames.map((name) => ({ mutationNames: [], name, positiveNames: [name] })),
	{ mutationNames: immutableNames.slice(0, 7), name: "immutable paths 1-7", positiveNames: [] },
	{ mutationNames: immutableNames.slice(7, 14), name: "immutable paths 8-14", positiveNames: [] },
	{ mutationNames: immutableNames.slice(14, 21), name: "immutable paths 15-21", positiveNames: [] },
	{ mutationNames: immutableNames.slice(21, 28), name: "immutable paths 22-28", positiveNames: [] },
	{ mutationNames: immutableNames.slice(28, 35), name: "immutable paths 29-35", positiveNames: [] },
	{ mutationNames: immutableNames.slice(35, 42), name: "immutable paths 36-42", positiveNames: [] },
	{ mutationNames: immutableNames.slice(42, 49), name: "immutable paths 43-49", positiveNames: [] },
	{ mutationNames: immutableNames.slice(49), name: "immutable paths 50-53", positiveNames: [] },
	{ mutationNames: workflowCountNames, name: "workflow cardinalities 1-4", positiveNames: [] },
	{ mutationNames: categoryNames.slice(0, 12), name: "repository categories 1-12", positiveNames: [] },
	{ mutationNames: categoryNames.slice(12, 23), name: "repository categories 13-23", positiveNames: [] },
	{ mutationNames: categoryNames.slice(23), name: "repository categories 24-34", positiveNames: [] },
] as const;

describe("D.93.35.5 genuine repository successor causal RED", () => {
	it("partitions the exact four-positive and 91-negative plan once in deterministic category order", () => {
		expect(plan.inventory).toHaveLength(58);
		expect(plan.immutable).toHaveLength(53);
		expect(plan.positiveNames).toHaveLength(4);
		expect(plan.mutationNames).toHaveLength(91);
		expect(partitions.flatMap(({ positiveNames }) => positiveNames)).toEqual(plan.positiveNames);
		expect(partitions.flatMap(({ mutationNames }) => mutationNames)).toEqual(plan.mutationNames);
	});

	it.each(partitions)(
		"requires the exact owner and rejects fallback for $name",
		async (partition) => {
			const availability = repositoryCandidateAvailability(REPOSITORY_ROOT);
			expect(availability.checker).toBe(
				resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs")
			);
			const evidence = await runRepositoryCandidatePartition(REPOSITORY_ROOT, successorContract, partition);
			expect(evidence.available, `successor owner absent at ${availability.checker}`).toBe(true);
			if (!evidence.available || !("positives" in evidence)) return;
			const completed = evidence as CompletedRepositoryCandidateEvidence;
			expect(completed.inventory).toEqual(plan.inventory);
			expect(completed.immutable).toEqual(plan.immutable);
			expect(completed.positives.map(({ name }) => name)).toEqual(partition.positiveNames);
			for (const { name, result } of completed.positives) {
				expect(result.signal, name).toBeNull();
				expect(result.status, `${name}\n${normalizedChildOutput(result)}`).toBe(0);
				expect(result.output).toContain("protocol-v3 freeze successor: PASS");
			}
			expect(completed.negatives.map(({ name }) => name)).toEqual(partition.mutationNames);
			for (const { name, result } of completed.negatives) {
				expect(result.signal, name).toBeNull();
				expect(typeof result.status, name).toBe("number");
				expect(result.status, `${name}\n${normalizedChildOutput(result)}`).not.toBe(0);
			}
		},
		60_000
	);
});
