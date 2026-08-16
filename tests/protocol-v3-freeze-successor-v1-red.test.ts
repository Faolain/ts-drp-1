import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";
import {
	FREEZE_SUCCESSOR_FIXTURE_ROOT,
	normalizedChildOutput,
	REPOSITORY_ROOT,
	successorContract,
} from "./fixtures/phase-3a1b-freeze-successor-v1/successor-test-context.js";
import {
	expectedCandidateFailure,
	governedInventory,
	repositoryCandidatePlan,
	repositoryCandidateReadiness,
	repositoryMutationPlan,
	runControlledMixedCensusDiagnostics,
	runControlledMutation,
	runControlledPositive,
	runCurrentRootDriftMutants,
	runHistoricalBaselines,
	runReadyCandidateTopologies,
	runRepositoryCandidatePartition,
	runRootChildPreloadPassthrough,
	runRootFreezeEvidence,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

const ANALYZER_ROOT = resolve(FREEZE_SUCCESSOR_FIXTURE_ROOT, "analyzers/workflow");
const policyPaths = successorContract.predecessors.map(({ policy }) => policy);
const legacyCheckers = successorContract.predecessors.map(({ checker }) => checker);
const repositoryPlan = repositoryCandidatePlan(REPOSITORY_ROOT, successorContract);
const candidateReadiness = repositoryCandidateReadiness(REPOSITORY_ROOT, successorContract);
const mutationPartitions = Array.from({ length: Math.ceil(repositoryPlan.mutationNames.length / 3) }, (_, index) =>
	repositoryPlan.mutationNames.slice(index * 3, index * 3 + 3)
);

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

describe("D.93.35.7/.8 freeze-successor controls", () => {
	it("loads the exact closed v2 contract shape without relying on the unchecked JSON cast", () => {
		expect(Object.keys(successorContract).sort()).toEqual(
			[
				"correctionPaths",
				"expectedPolicySchemaVersion",
				"expectedProfileSchemaVersion",
				"externalBase",
				"fixedAnchor",
				"gossipChain",
				"gossipFdbSha256",
				"gossipOracleTransition",
				"historicalTransitions",
				"latentGossipBinding",
				"originalInstallPaths",
				"ownerDirectory",
				"ownerFiles",
				"predecessors",
				"provisionalInstall",
				"redBase",
				"redBaseParent",
				"redBaseTree",
				"rootFreezeEvidence",
				"schemaVersion",
				"workflowIdentities",
			].sort()
		);
		expect(successorContract.schemaVersion).toBe("phase-3a1b-freeze-successor-red-v2");
		expect(Object.keys(successorContract.externalBase).sort()).toEqual(["commit", "parents", "tree"]);
		expect(Object.keys(successorContract.gossipOracleTransition).sort()).toEqual(
			["commit", "currentBlob", "currentSha256", "oldBlob", "oldSha256", "parent", "path", "tree"].sort()
		);
		expect(Object.keys(successorContract.provisionalInstall).sort()).toEqual(["commit", "parent", "tree"]);
		expect(successorContract.externalBase.parents).toHaveLength(2);
		expect(successorContract.originalInstallPaths).toHaveLength(9);
		expect(successorContract.correctionPaths).toHaveLength(6);
		expect(successorContract.rootFreezeEvidence.map(({ id }) => id)).toEqual(["protocol-v2-root", "protocol-v3-root"]);
		for (const evidence of successorContract.rootFreezeEvidence) {
			expect(Object.keys(evidence).sort(), evidence.id).toEqual(
				[
					"baseline",
					"baselineTree",
					"checker",
					"checkerBase",
					"checkerBaseTree",
					"checkerBlob",
					"checkerSha256",
					"currentStdout",
					"directParent",
					"environment",
					"historicalStdout",
					"id",
				].sort()
			);
		}
	});

	it("derives exact 58/5/(52+1), and proves ordered mixed census with controlled Git objects", async () => {
		const inventory = governedInventory(REPOSITORY_ROOT, policyPaths);
		const workflows = new Set(successorContract.workflowIdentities.map(({ path }) => path));
		expect(inventory).toHaveLength(58);
		expect(new Set(inventory).size).toBe(58);
		expect(inventory.filter((path) => workflows.has(path))).toEqual(
			successorContract.workflowIdentities.map(({ path }) => path)
		);
		const immutable = inventory.filter((path) => !workflows.has(path));
		expect(immutable).toHaveLength(53);
		const fixedAnchor = immutable.filter((path) => path !== successorContract.gossipOracleTransition.path);
		expect(fixedAnchor).toHaveLength(52);
		const candidatePlan = repositoryMutationPlan(fixedAnchor, successorContract.gossipOracleTransition.path);
		expect(candidatePlan).toHaveLength(110);
		expect(candidatePlan.filter((name) => name.startsWith("immutable:"))).toHaveLength(52);
		expect(candidatePlan.filter((name) => name.startsWith("gossip-"))).toEqual([
			`gossip-old:${successorContract.gossipOracleTransition.path}`,
			`gossip-current:${successorContract.gossipOracleTransition.path}`,
			`gossip-postbootstrap:${successorContract.gossipOracleTransition.path}`,
		]);
		expect(candidatePlan.some((name) => name.startsWith("workflow-count:"))).toBe(false);
		expect(new Set(candidatePlan).size).toBe(candidatePlan.length);
		expect(candidatePlan.slice(55)).toEqual([
			"partial-owner-base",
			"split-owner-routing",
			"transient-revert",
			"base-only-validation",
			"current-only-validation",
			"merge-only-governed-change",
			"sibling-upstream",
			"arbitrary-old-upstream",
			"arbitrary-later-empty-upstream",
			"caller-selected-old-base",
			"upstream-after-anchor",
			"swapped-merge-parents",
			"merge-tree-drift",
			"non-unique-merge-base",
			"provisional-v1-descendant",
			"other-wrong-identity-descendant",
			"wrong-type-descendant",
			"wrong-mode-descendant",
			"v1-schema",
			"missing-schema",
			"dual-schema",
			"retained-legacy-checker",
			"omitted-current-semantic-hash",
			"accepted-stale-policy-value",
			"omitted-latent-gossip-binding",
			"wrong-baseline",
			"wrong-transition",
			"conflated-gossip-parent-base",
			"extra-unhashed-exception",
			"sixth-thawed-path",
			"changed-trigger",
			"changed-permission",
			"changed-checkout-ref",
			"changed-timeout",
			"changed-job-identity",
			"semantic-equivalent-workflow-bytes",
			"missing-owner-path",
			"extra-owner-entry",
			"executable-owner",
			"symlink-owner",
			"gitlink-owner",
			"tree-owner",
			"staged-protected-drift",
			"unstaged-protected-drift",
			"post-bootstrap-owner-drift",
			"post-bootstrap-workflow-drift",
			"copied-root-checker",
			"spoofed-root-stdout",
			"extra-root-stdout",
			"root-child-stderr",
			"root-child-signal",
			"root-child-timeout",
			"current-only-root-evidence",
			"blob-only-root-evidence",
			"suppressed-root-exit",
		]);
		for (const mutation of candidatePlan) {
			expect(expectedCandidateFailure(mutation).class, mutation).toMatch(/^[A-Z_]+$/u);
		}
		const governed62 = [
			...successorContract.ownerFiles.map((file) => `${successorContract.ownerDirectory}/${file}`),
			...inventory,
		];
		const diagnostic = await runControlledMixedCensusDiagnostics(REPOSITORY_ROOT, governed62);
		expect(diagnostic).toHaveLength(61);
		expect(diagnostic.map(({ count }) => count)).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
		for (const row of diagnostic) {
			expect(row.classification).toBe("CONTROLLED_DIAGNOSTIC");
			expect(row.present).toEqual(governed62.slice(0, row.count));
			expect(row.absent).toEqual(governed62.slice(row.count));
			expect(row.checkerEvidence).toEqual({
				absent: row.absent,
				classification: "CONTROLLED_DIAGNOSTIC",
				entries: row.entries,
				present: row.present,
			});
			expect(row.checkerStdout).toBe(`${JSON.stringify(row.checkerEvidence)}\n`);
		}
		expect(diagnostic[0]?.entries[0]?.[1]).toMatchObject({ mode: "120000", type: "blob" });
		expect(diagnostic[1]?.entries[1]?.[1]).toMatchObject({ mode: "100644", type: "blob" });
		expect(diagnostic[30]?.entries[30]?.[1]).toMatchObject({ mode: "040000", type: "tree" });
		expect(diagnostic[60]?.entries[60]?.[1]).toMatchObject({ mode: "160000", type: "commit" });
	}, 120_000);

	it("executes all five predecessor baselines against their authenticated checker bases", async () => {
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
	}, 30_000);

	it("executes four isolated native protocol-root closures with exact byte outputs", async () => {
		const results = await runRootFreezeEvidence(REPOSITORY_ROOT, successorContract);
		expect(results.map(({ id }) => id)).toEqual([
			"protocol-v2-root:historical",
			"protocol-v2-root:current",
			"protocol-v3-root:historical",
			"protocol-v3-root:current",
		]);
		for (const { authenticated, id, result } of results) {
			const expected = successorContract.rootFreezeEvidence.find(({ id: owner }) => id.startsWith(owner));
			expect(authenticated.baselineTree, id).toBe(expected?.baselineTree);
			expect(authenticated.checkerBaseTree, id).toBe(expected?.checkerBaseTree);
			expect(authenticated.directParents, id).toEqual([expected?.directParent]);
			expect(result.statusBefore, id).toBe("");
			expect(result.signal, id).toBeNull();
			expect(result.status, id).toBe(0);
			expect(result.stderr, id).toEqual(Buffer.alloc(0));
			expect(result.stdout, id).toEqual(result.expectedStdout);
			expect(result.checkerBlob, id).toBe(expected?.checkerBlob);
			expect(result.checkerSha256, id).toBe(expected?.checkerSha256);
		}
	}, 120_000);

	it("self-tests routing semantics, repository-root binding, and isolated upstream violations", () => {
		const operation = successorContract.workflowIdentities[0];
		for (const name of ["valid.yml", "semantically-equivalent.yml"]) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, operation, legacyCheckers), name).toEqual([]);
		}
		for (const name of ["operation-retained-protocol-v2-upstream.yml", "operation-retained-protocol-v3-upstream.yml"]) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, operation, legacyCheckers), name).toEqual([
				"upstream-root-checker-execution",
			]);
		}
		const work = successorContract.workflowIdentities[1];
		for (const name of ["work-retained-protocol-v2-upstream.yml", "work-retained-protocol-v3-upstream.yml"]) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, work, legacyCheckers), name).toEqual([
				"upstream-root-checker-execution",
			]);
		}
		const authority = readFileSync(resolve(ANALYZER_ROOT, "external-empty-upstream-authority.yml"), "utf8");
		expect(auditSuccessorWorkflowRouting(authority, operation, legacyCheckers)).toEqual(["upstream-byte-authority"]);
		const establishedNegatives = new Map<string, readonly string[]>([
			["retained-legacy-checker.yml", ["successor-root-binding", "legacy-checker-execution"]],
			[
				"missing-base-check.yml",
				[
					"merge-base-all",
					"merge-base-singleton",
					"base-checker-selection",
					"successor-root-binding",
					"dual-checker-execution",
				],
			],
			["changed-job-identity.yml", ["job-key"]],
			["comment-only-successor.yml", ["successor-path", "successor-root-binding", "upstream-byte-authority"]],
		]);
		for (const [name, violations] of establishedNegatives) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, operation, legacyCheckers), name).toEqual(violations);
		}
		for (const identity of [operation, work]) {
			const actual = readFileSync(resolve(REPOSITORY_ROOT, identity.path), "utf8");
			expect(auditSuccessorWorkflowRouting(actual, identity, legacyCheckers), identity.path).toEqual(
				candidateReadiness.ready ? [] : ["upstream-root-checker-execution"]
			);
		}
	});

	it("retains the eight exact gossip routing analyzer controls", () => {
		const identity = successorContract.workflowIdentities[3];
		const expected = new Map<string, readonly string[]>([
			["gossip-legacy-removed-successor-absent.yml", ["successor-path"]],
			["gossip-successor-executable-legacy-retained.yml", ["legacy-checker-execution"]],
			["gossip-missing-digest-identity.yml", ["gossip-digest-checker"]],
			["gossip-missing-evidence-projection.yml", ["gossip-evidence-checker"]],
			["gossip-missing-author-projection-suite.yml", ["gossip-author-suite"]],
			["gossip-indirect-legacy-checker.yml", ["legacy-checker-execution"]],
			["gossip-dead-successor.yml", ["successor-path", "bypass"]],
			["gossip-data-only-successor.yml", ["successor-path"]],
		]);
		for (const [name, violations] of expected) {
			const source = readFileSync(resolve(ANALYZER_ROOT, name), "utf8");
			expect(auditSuccessorWorkflowRouting(source, identity, legacyCheckers), name).toEqual(violations);
		}
	});

	it("keeps controlled linear/merge positives and bundle/routing negatives independent", async () => {
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
	}, 120_000);

	it("authenticates historical blobs, exact gossip transition, and PR-side lineage", () => {
		expect(git("rev-parse", `${successorContract.fixedAnchor.commit}^{tree}`)).toBe(successorContract.fixedAnchor.tree);
		expect(git("rev-parse", `${successorContract.externalBase.commit}^{tree}`)).toBe(
			successorContract.externalBase.tree
		);
		expect(git("rev-list", "--parents", "-n", "1", successorContract.externalBase.commit).split(" ").slice(1)).toEqual(
			successorContract.externalBase.parents
		);
		for (const [ancestor, descendant] of [
			[successorContract.externalBase.commit, successorContract.fixedAnchor.commit],
			[successorContract.fixedAnchor.commit, successorContract.redBase],
			[successorContract.redBase, successorContract.provisionalInstall.parent],
		] as const) {
			expect(git("merge-base", "--is-ancestor", ancestor, descendant)).toBe("");
		}
		expect(git("rev-parse", `${successorContract.provisionalInstall.commit}^`)).toBe(
			successorContract.provisionalInstall.parent
		);
		for (const transition of successorContract.historicalTransitions) {
			for (const [commit, expected] of transition.commits) {
				const shown = spawnSync("git", ["show", `${commit}:${transition.path}`], { cwd: REPOSITORY_ROOT });
				expect(shown.status, `${transition.path}@${commit}`).toBe(0);
				expect(createHash("sha256").update(shown.stdout).digest("hex")).toBe(expected);
			}
		}
		const transition = successorContract.gossipOracleTransition;
		expect(git("rev-parse", `${transition.parent}:${transition.path}`)).toBe(transition.oldBlob);
		expect(git("hash-object", transition.path)).toBe(transition.currentBlob);
		expect(sha256(transition.path)).toBe(transition.currentSha256);
	});
});

describe("D.93.35.7/.8 genuine repository candidate", () => {
	it("fails RED only at the shared exact-six readiness gate, before candidate mutations", async () => {
		expect(repositoryPlan.inventory).toHaveLength(58);
		expect(repositoryPlan.immutable).toHaveLength(53);
		expect(repositoryPlan.fixedAnchor).toHaveLength(52);
		expect(repositoryPlan.positiveNames).toHaveLength(4);
		expect(new Set(repositoryPlan.mutationNames).size).toBe(repositoryPlan.mutationNames.length);
		expect(candidateReadiness.topologyValid).toBe(true);
		expect(candidateReadiness.externalAbsent).toEqual(candidateReadiness.governed);
		expect(candidateReadiness.governed).toHaveLength(62);
		expect(candidateReadiness.originalInstall).toEqual([...successorContract.originalInstallPaths].sort());
		expect(candidateReadiness.originalInstallValid).toBe(true);
		expect(candidateReadiness.provisionalEntries).toHaveLength(62);
		for (const [path, entry] of candidateReadiness.provisionalEntries) {
			expect(entry, path).toMatchObject({ mode: "100644", type: "blob" });
		}
		expect(candidateReadiness.code).toBe("READY");
		expect(candidateReadiness.schemaValid).toBe(true);
		expect(candidateReadiness.correctionValid).toBe(true);
		expect(candidateReadiness.ready).toBe(true);
		if (!candidateReadiness.ready) return;
		const results = await runReadyCandidateTopologies(REPOSITORY_ROOT, successorContract, candidateReadiness);
		expect(results.map(({ name }) => name)).toEqual([
			"linear:external-empty",
			"merge:external-empty",
			"linear:descendant",
			"merge:descendant",
		]);
		for (const { name, result } of results) {
			expect(result.signal, name).toBeNull();
			expect(result.status, `${name}\n${normalizedChildOutput(result)}`).toBe(0);
			expect(result.output, name).toContain("protocol-v3 freeze successor: PASS");
		}
	}, 600_000);

	describe.skipIf(!candidateReadiness.ready)("GREEN-only genuine candidate execution", () => {
		it("accepts a candidate-opaque passthrough root-child preload", () => {
			const result = runRootChildPreloadPassthrough(REPOSITORY_ROOT, successorContract, candidateReadiness);
			expect(existsSync(result.cleanupPath)).toBe(false);
			expect(result.correctionPaths).toEqual([...successorContract.correctionPaths].sort());
			expect(result.signal).toBeNull();
			expect(result.status, result.output).toBe(0);
			expect(result.output).toContain("protocol-v3 freeze successor: PASS");
		}, 600_000);

		it("proves both current root closures through the successor boundary", async () => {
			const results = await runCurrentRootDriftMutants(REPOSITORY_ROOT, successorContract, candidateReadiness);
			expect(results.map(({ id }) => id)).toEqual(["protocol-v2-root", "protocol-v3-root"]);
			for (const result of results) {
				expect(result.driftPaths, result.id).toEqual([
					result.id === "protocol-v2-root"
						? "packages/protocol-v2/registry/field-registry.json"
						: "packages/protocol-v3/registry/registry-v1.json",
				]);
				expect(result.correctionPaths, result.id).toEqual([...successorContract.correctionPaths].sort());
				expect(result.signal, result.id).toBeNull();
				expect(typeof result.status, result.id).toBe("number");
				expect(result.status, `${result.id}\n${result.output}`).not.toBe(0);
				expect(result.output, result.id).toContain("protocol-v3 freeze successor violation:");
				expect(result.output, result.id).toMatch(/(?:current|root).*(?:checker|preservation)|checker.*current/iu);
			}
		}, 600_000);

		for (const [index, mutationNames] of mutationPartitions.entries()) {
			it(`constructs and executes post-readiness mutants ${index * 3 + 1}-${index * 3 + mutationNames.length}`, async () => {
				const evidence = await runRepositoryCandidatePartition(REPOSITORY_ROOT, successorContract, candidateReadiness, {
					mutationNames,
					positiveNames: [],
				});
				expect(evidence.available).toBe(true);
				if (!("negatives" in evidence) || !Array.isArray(evidence.negatives)) {
					throw new Error("ready partition omitted candidate negatives");
				}
				const negatives = evidence.negatives;
				expect(negatives.map(({ name }) => name)).toEqual(mutationNames);
				for (const { expectedFailure, name, result } of negatives) {
					expect(expectedFailure).toEqual(expectedCandidateFailure(name));
					expect(result.signal, name).toBeNull();
					expect(typeof result.status, name).toBe("number");
					expect(result.status, `${name}\n${normalizedChildOutput(result)}`).not.toBe(0);
					expect(result.output, name).toContain("protocol-v3 freeze successor violation:");
					expect(result.output, `${name}:${expectedFailure.class}`).toMatch(expectedFailure.marker);
				}
			}, 600_000);
		}
	});
});
