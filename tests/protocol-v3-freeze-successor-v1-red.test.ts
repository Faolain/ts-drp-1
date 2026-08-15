import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";
import type {
	CompletedRepositoryCandidateEvidence,
	SuccessorContract,
} from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.js";
import contractJson from "./fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json" with { type: "json" };
import {
	governedInventory,
	repositoryCandidateAvailability,
	repositoryMutationPlan,
	runControlledMutation,
	runControlledPositive,
	runHistoricalBaselines,
	runRepositoryCandidateMatrix,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "..");
const FIXTURE_ROOT = resolve(DIRECTORY, "fixtures/phase-3a1b-freeze-successor-v1");
const ANALYZER_ROOT = resolve(FIXTURE_ROOT, "analyzers/workflow");
const contract = contractJson as unknown as SuccessorContract;
const policyPaths = contract.predecessors.map(({ policy }) => policy);
const legacyCheckers = contract.predecessors.map(({ checker }) => checker);

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(ROOT, path)))
		.digest("hex");
}

function output(result: Readonly<{ readonly output: string }>): string {
	return result.output.replaceAll(ROOT, "<repository>");
}

function git(...args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	expect(result.error, args.join(" ")).toBeUndefined();
	expect(result.signal, args.join(" ")).toBeNull();
	expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
	return result.stdout.trim();
}

describe("D.93.35.5 freeze-successor independent controls", () => {
	it("derives the exact ordered 58/5/53 inventory from all five genuine policies", () => {
		const inventory = governedInventory(ROOT, policyPaths);
		const workflows = new Set(contract.workflowIdentities.map(({ path }) => path));
		expect(policyPaths).toHaveLength(5);
		expect(inventory).toHaveLength(58);
		expect(new Set(inventory).size).toBe(58);
		expect(inventory.filter((path) => workflows.has(path))).toEqual(
			contract.workflowIdentities.map(({ path }) => path)
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

	it("executes all five genuine baseline checkers against checkerBase and proves directParent independently", () => {
		const results = runHistoricalBaselines(ROOT, contract.predecessors);
		expect(results).toHaveLength(5);
		for (const result of results) {
			const expected = contract.predecessors.find(({ id }) => id === result.id);
			expect(expected).toBeDefined();
			expect(result.signal, result.id).toBeNull();
			expect(result.status, output(result)).toBe(0);
			expect(result.output, result.id).toContain("freeze: PASS");
			expect(result.parent, result.id).toBe(expected?.directParent);
			expect(result.tree, result.id).toBe(expected?.baselineTree);
		}
		const gossip = contract.predecessors.find(({ id }) => id === "gossip-budget");
		expect(gossip?.directParent).not.toBe(gossip?.checkerBase);
	});

	it("self-tests the analyzer with byte-different semantic positives and behavioral negatives", () => {
		const identity = contract.workflowIdentities[0];
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

	it("proves the controlled harness accepts linear and GitHub merge-ref bootstrap and descendants", () => {
		for (const topology of ["linear", "merge"] as const) {
			for (const mode of ["bootstrap", "descendant"] as const) {
				const result = runControlledPositive(ROOT, topology, mode);
				expect(result.signal, `${topology}:${mode}`).toBeNull();
				expect(result.status, output(result)).toBe(0);
				expect(result.output).toContain("controlled freeze successor: PASS");
				expect(existsSync(result.cleanupPath)).toBe(false);
			}
		}
	}, 60_000);

	it("keeps bundle absence and workflow routing as separate causal controls", () => {
		for (const mutation of [
			"bundle-with-old-workflows",
			"future-workflows-with-partial-bundle",
			"partial-base",
			"split-atomic",
			"transient-revert",
			"symlink-owner",
		]) {
			const result = runControlledMutation(ROOT, mutation);
			expect(result.signal, mutation).toBeNull();
			expect(typeof result.status, mutation).toBe("number");
			expect(result.status, `${mutation}\n${output(result)}`).not.toBe(0);
		}
	}, 60_000);

	it("pins the exact historical blobs, gossip chain and latent archival mismatch independently", () => {
		expect(git("rev-parse", `${contract.fixedAnchor.commit}^{tree}`)).toBe(contract.fixedAnchor.tree);
		for (const descendant of [contract.redBase, "HEAD"]) {
			const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", contract.fixedAnchor.commit, descendant], {
				cwd: ROOT,
			});
			expect(ancestry.error, descendant).toBeUndefined();
			expect(ancestry.signal, descendant).toBeNull();
			expect(ancestry.status, descendant).toBe(0);
		}
		for (const predecessor of contract.predecessors) {
			expect(git("rev-parse", `${predecessor.directParent}^{tree}`), predecessor.id).toBe(predecessor.directParentTree);
		}
		for (const entry of contract.gossipChain) {
			expect(git("rev-parse", `${entry.commit}^{tree}`), entry.commit).toBe(entry.tree);
		}
		expect(git("merge-base", "--is-ancestor", contract.gossipChain[0].commit, contract.gossipChain[1].commit)).toBe("");
		expect(git("rev-parse", `${contract.gossipChain[2].commit}^`)).toBe(contract.gossipChain[1].commit);
		for (const [path, expected] of Object.entries(contract.gossipFdbSha256)) {
			const shown = spawnSync("git", ["show", `${contract.gossipChain[1].commit}:${path}`], { cwd: ROOT });
			expect(shown.error, path).toBeUndefined();
			expect(shown.signal, path).toBeNull();
			expect(shown.status, path).toBe(0);
			expect(createHash("sha256").update(shown.stdout).digest("hex"), path).toBe(expected);
		}
		const gossipProfile = JSON.parse(
			git(
				"show",
				`${contract.gossipChain[2].commit}:packages/protocol-v3/supplements/equivocation-gossip-budget-v1/profile.json`
			)
		) as { readonly governance: Readonly<Record<string, unknown>> };
		expect(gossipProfile.governance.supersedesProvisionalRed).toBe(contract.gossipChain[1].commit);
		expect(gossipProfile.governance.provisionalAuthorizesGreen).toBe(false);
		for (const transition of contract.historicalTransitions) {
			for (const [commit, expected] of transition.commits) {
				const shown = spawnSync("git", ["show", `${commit}:${transition.path}`], { cwd: ROOT });
				expect(shown.status, `${transition.path}@${commit}`).toBe(0);
				expect(createHash("sha256").update(shown.stdout).digest("hex")).toBe(expected);
			}
		}
		expect(sha256(contract.latentGossipBinding.path)).toBe(contract.latentGossipBinding.sha256);
		const gossip = JSON.parse(readFileSync(resolve(ROOT, contract.latentGossipBinding.path), "utf8")) as {
			readonly baseArtifactSha256: Readonly<Record<string, string>>;
		};
		expect(gossip.baseArtifactSha256[contract.historicalTransitions[2].path]).toBe(
			contract.latentGossipBinding.staleAuthorHash
		);
		expect(sha256(contract.historicalTransitions[2].path)).toBe(contract.latentGossipBinding.currentAuthorHash);
	});
});

describe("D.93.35.5 genuine repository successor causal RED", () => {
	it("requires the exact owner, atomic workflow routing, native positives and complete rejection matrix with no fallback", () => {
		const availability = repositoryCandidateAvailability(ROOT);
		expect(availability.checker).toBe(
			resolve(ROOT, "packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs")
		);
		const evidence = runRepositoryCandidateMatrix(ROOT, contract);
		expect(evidence.available, `successor owner absent at ${availability.checker}`).toBe(true);
		if (!evidence.available || !("positives" in evidence)) return;
		const completed = evidence as CompletedRepositoryCandidateEvidence;
		expect(completed.inventory).toHaveLength(58);
		expect(completed.immutable).toHaveLength(53);
		for (const [index, result] of completed.positives.entries()) {
			expect(result.signal, `positive:${index}`).toBeNull();
			expect(result.status, `positive:${index}\n${output(result)}`).toBe(0);
			expect(result.output).toContain("protocol-v3 freeze successor: PASS");
		}
		expect(completed.negatives.filter(({ name }) => name.startsWith("immutable:"))).toHaveLength(53);
		for (const { name, result } of completed.negatives) {
			expect(result.signal, name).toBeNull();
			expect(typeof result.status, name).toBe("number");
			expect(result.status, `${name}\n${output(result)}`).not.toBe(0);
		}
	}, 240_000);
});
