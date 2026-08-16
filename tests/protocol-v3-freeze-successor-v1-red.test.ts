import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";
import type { CompletedRepositoryCandidateEvidence } from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.js";
import {
	FREEZE_SUCCESSOR_FIXTURE_ROOT,
	normalizedChildOutput,
	REPOSITORY_ROOT,
	successorContract,
} from "./fixtures/phase-3a1b-freeze-successor-v1/successor-test-context.js";
import {
	governedInventory,
	repositoryCandidateAvailability,
	repositoryCandidatePlan,
	repositoryMutationPlan,
	runControlledMutation,
	runControlledPositive,
	runHistoricalBaselines,
	runRepositoryCandidatePartition,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

const ANALYZER_ROOT = resolve(FREEZE_SUCCESSOR_FIXTURE_ROOT, "analyzers/workflow");
const policyPaths = successorContract.predecessors.map(({ policy }) => policy);
const legacyCheckers = successorContract.predecessors.map(({ checker }) => checker);
const repositoryPlan = repositoryCandidatePlan(REPOSITORY_ROOT, successorContract);

function boundedPartitions(
	names: readonly string[],
	size: number,
	label: string
): readonly {
	readonly mutationNames: readonly string[];
	readonly name: string;
	readonly positiveNames: readonly string[];
	readonly timeout: number;
}[] {
	const partitions = [];
	for (let start = 0; start < names.length; start += size) {
		const mutationNames = names.slice(start, start + size);
		partitions.push({
			mutationNames,
			name: `${label} ${start + 1}-${start + mutationNames.length}`,
			positiveNames: [],
			timeout: mutationNames.length * 60_000 + 15_000,
		});
	}
	return partitions;
}

const immutableNames = repositoryPlan.mutationNames.slice(0, 53);
const workflowCountNames = repositoryPlan.mutationNames.slice(53, 57);
const categoryNames = repositoryPlan.mutationNames.slice(57);
const repositoryPartitions = [
	...repositoryPlan.positiveNames.map((name) => ({
		mutationNames: [],
		name,
		positiveNames: [name],
		timeout: 75_000,
	})),
	...boundedPartitions(immutableNames, 3, "immutable paths"),
	...boundedPartitions(workflowCountNames, 2, "workflow cardinalities"),
	...boundedPartitions(categoryNames, 3, "repository categories"),
];

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(REPOSITORY_ROOT, path)))
		.digest("hex");
}

function git(...args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
	expect(result.error, args.join(" ")).toBeUndefined();
	expect(result.signal, args.join(" ")).toBeNull();
	expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
	return result.stdout.trim();
}

describe("D.93.35.5 freeze-successor independent controls", () => {
	it("derives the exact ordered 58/5/53 inventory from all five genuine policies", () => {
		const inventory = governedInventory(REPOSITORY_ROOT, policyPaths);
		const workflows = new Set(successorContract.workflowIdentities.map(({ path }) => path));
		expect(policyPaths).toHaveLength(5);
		expect(inventory).toHaveLength(58);
		expect(new Set(inventory).size).toBe(58);
		expect(inventory.filter((path) => workflows.has(path))).toEqual(
			successorContract.workflowIdentities.map(({ path }) => path)
		);
		const immutable = inventory.filter((path) => !workflows.has(path));
		expect(immutable).toHaveLength(53);
		const plan = repositoryMutationPlan(immutable);
		expect(plan.filter((name) => name.startsWith("immutable:"))).toHaveLength(53);
		expect(new Set(plan).size).toBe(plan.length);
		expect(plan).toEqual(
			expect.arrayContaining([
				"workflow-count:1",
				"workflow-count:4",
				"sibling-upstream",
				"arbitrary-old-upstream",
				"non-unique-merge-base",
				"gitlink-owner",
				"tree-owner",
				"staged-protected-drift",
				"unstaged-protected-drift",
				"semantic-equivalent-workflow-bytes",
			])
		);
	});

	it("executes all five genuine baseline checkers against checkerBase and proves directParent independently", async () => {
		const results = await runHistoricalBaselines(REPOSITORY_ROOT, successorContract.predecessors);
		expect(results).toHaveLength(5);
		for (const result of results) {
			const expected = successorContract.predecessors.find(({ id }) => id === result.id);
			expect(expected).toBeDefined();
			expect(result.signal, result.id).toBeNull();
			expect(result.status, normalizedChildOutput(result)).toBe(0);
			expect(result.output, result.id).toContain("freeze: PASS");
			expect(result.parent, result.id).toBe(expected?.directParent);
			expect(result.tree, result.id).toBe(expected?.baselineTree);
		}
		const gossip = successorContract.predecessors.find(({ id }) => id === "gossip-budget");
		expect(gossip?.directParent).not.toBe(gossip?.checkerBase);
	}, 30_000);

	it("self-tests the analyzer with byte-different semantic positives and behavioral negatives", () => {
		const identity = successorContract.workflowIdentities[0];
		for (const name of ["valid.yml", "semantically-equivalent.yml"]) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, identity, legacyCheckers), name).toEqual([]);
		}
		for (const name of [
			"retained-legacy-checker.yml",
			"missing-base-check.yml",
			"changed-job-identity.yml",
			"comment-only-successor.yml",
		]) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, identity, legacyCheckers), name).not.toEqual([]);
		}
	});

	it("proves the controlled harness accepts linear and GitHub merge-ref bootstrap and descendants", async () => {
		for (const topology of ["linear", "merge"] as const) {
			for (const mode of ["bootstrap", "descendant"] as const) {
				const result = runControlledPositive(REPOSITORY_ROOT, topology, mode);
				expect(result.signal, `${topology}:${mode}`).toBeNull();
				expect(result.status, normalizedChildOutput(result)).toBe(0);
				expect(result.output).toContain("controlled freeze successor: PASS");
				expect(existsSync(result.cleanupPath)).toBe(false);
				await yieldToEventLoop();
			}
		}
	}, 90_000);

	it("keeps bundle absence and workflow routing as separate causal controls", async () => {
		for (const mutation of [
			"bundle-with-old-workflows",
			"future-workflows-with-partial-bundle",
			"partial-base",
			"split-atomic",
			"transient-revert",
			"symlink-owner",
		]) {
			const result = runControlledMutation(REPOSITORY_ROOT, mutation);
			expect(result.signal, mutation).toBeNull();
			expect(typeof result.status, mutation).toBe("number");
			expect(result.status, `${mutation}\n${normalizedChildOutput(result)}`).not.toBe(0);
			await yieldToEventLoop();
		}
	}, 90_000);

	it("pins the exact historical blobs, gossip chain and latent archival mismatch independently", () => {
		expect(git("rev-parse", `${successorContract.fixedAnchor.commit}^{tree}`)).toBe(successorContract.fixedAnchor.tree);
		for (const descendant of [successorContract.redBase, "HEAD"]) {
			const ancestry = spawnSync(
				"git",
				["merge-base", "--is-ancestor", successorContract.fixedAnchor.commit, descendant],
				{
					cwd: REPOSITORY_ROOT,
				}
			);
			expect(ancestry.error, descendant).toBeUndefined();
			expect(ancestry.signal, descendant).toBeNull();
			expect(ancestry.status, descendant).toBe(0);
		}
		for (const predecessor of successorContract.predecessors) {
			expect(git("rev-parse", `${predecessor.directParent}^{tree}`), predecessor.id).toBe(predecessor.directParentTree);
		}
		for (const entry of successorContract.gossipChain) {
			expect(git("rev-parse", `${entry.commit}^{tree}`), entry.commit).toBe(entry.tree);
		}
		expect(
			git(
				"merge-base",
				"--is-ancestor",
				successorContract.gossipChain[0].commit,
				successorContract.gossipChain[1].commit
			)
		).toBe("");
		expect(git("rev-parse", `${successorContract.gossipChain[2].commit}^`)).toBe(
			successorContract.gossipChain[1].commit
		);
		for (const [path, expected] of Object.entries(successorContract.gossipFdbSha256)) {
			const shown = spawnSync("git", ["show", `${successorContract.gossipChain[1].commit}:${path}`], {
				cwd: REPOSITORY_ROOT,
			});
			expect(shown.error, path).toBeUndefined();
			expect(shown.signal, path).toBeNull();
			expect(shown.status, path).toBe(0);
			expect(createHash("sha256").update(shown.stdout).digest("hex"), path).toBe(expected);
		}
		const gossipProfile = JSON.parse(
			git(
				"show",
				`${successorContract.gossipChain[2].commit}:packages/protocol-v3/supplements/equivocation-gossip-budget-v1/profile.json`
			)
		) as { readonly governance: Readonly<Record<string, unknown>> };
		expect(gossipProfile.governance.supersedesProvisionalRed).toBe(successorContract.gossipChain[1].commit);
		expect(gossipProfile.governance.provisionalAuthorizesGreen).toBe(false);
		for (const transition of successorContract.historicalTransitions) {
			for (const [commit, expected] of transition.commits) {
				const shown = spawnSync("git", ["show", `${commit}:${transition.path}`], {
					cwd: REPOSITORY_ROOT,
				});
				expect(shown.status, `${transition.path}@${commit}`).toBe(0);
				expect(createHash("sha256").update(shown.stdout).digest("hex")).toBe(expected);
			}
		}
		expect(sha256(successorContract.latentGossipBinding.path)).toBe(successorContract.latentGossipBinding.sha256);
		const gossip = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, successorContract.latentGossipBinding.path), "utf8")
		) as {
			readonly baseArtifactSha256: Readonly<Record<string, string>>;
		};
		expect(gossip.baseArtifactSha256[successorContract.historicalTransitions[2].path]).toBe(
			successorContract.latentGossipBinding.staleAuthorHash
		);
		expect(sha256(successorContract.historicalTransitions[2].path)).toBe(
			successorContract.latentGossipBinding.currentAuthorHash
		);
	});
});

describe("D.93.35.5 genuine repository successor causal RED", () => {
	it("partitions the exact four-positive and 91-negative plan once in deterministic category order", () => {
		expect(repositoryPlan.inventory).toHaveLength(58);
		expect(repositoryPlan.immutable).toHaveLength(53);
		expect(repositoryPlan.positiveNames).toHaveLength(4);
		expect(repositoryPlan.mutationNames).toHaveLength(91);
		expect(repositoryPartitions.flatMap(({ positiveNames }) => positiveNames)).toEqual(repositoryPlan.positiveNames);
		expect(repositoryPartitions.flatMap(({ mutationNames }) => mutationNames)).toEqual(repositoryPlan.mutationNames);
	});

	for (const partition of repositoryPartitions) {
		it(
			`requires the exact owner and rejects fallback for ${partition.name}`,
			async () => {
				const availability = repositoryCandidateAvailability(REPOSITORY_ROOT);
				expect(availability.checker).toBe(
					resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs")
				);
				const evidence = await runRepositoryCandidatePartition(REPOSITORY_ROOT, successorContract, partition);
				expect(evidence.available, `successor owner absent at ${availability.checker}`).toBe(true);
				if (!evidence.available || !("positives" in evidence)) return;
				const completed = evidence as CompletedRepositoryCandidateEvidence;
				expect(completed.inventory).toEqual(repositoryPlan.inventory);
				expect(completed.immutable).toEqual(repositoryPlan.immutable);
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
			partition.timeout
		);
	}
});
