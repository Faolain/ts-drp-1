import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
	intermediaryChainEvidence,
	repositoryCandidatePlan,
	repositoryCandidateReadiness,
	repositoryMutationPlan,
	runControlledMixedCensusDiagnostics,
	runControlledMutation,
	runControlledPositive,
	runCurrentRootDriftMutants,
	runHistoricalBaselines,
	runOrdinaryClassBMutations,
	runReadyCandidateTopologies,
	runRepositoryCandidatePartition,
	runRootChildPreloadPassthrough,
	runRootFreezeEvidence,
	validateCorrectiveRed,
	validateIntermediaryChain,
} from "./fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs";

const ANALYZER_ROOT = resolve(FREEZE_SUCCESSOR_FIXTURE_ROOT, "analyzers/workflow");
const policyPaths = successorContract.predecessors.map(({ policy }) => policy);
const legacyCheckers = successorContract.predecessors.map(({ checker }) => checker);
const repositoryPlan = repositoryCandidatePlan(REPOSITORY_ROOT, successorContract);
const candidateReadiness = repositoryCandidateReadiness(REPOSITORY_ROOT, successorContract);
const certificationMode = process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_CERTIFICATION === "1";
const mutationPartitions = Array.from({ length: Math.ceil(repositoryPlan.mutationNames.length / 3) }, (_, index) =>
	repositoryPlan.mutationNames.slice(index * 3, index * 3 + 3)
);
const ordinaryClassBMutations = [
	"missing-owner-path",
	"post-bootstrap-owner-drift",
	"wrong-type-descendant",
	"wrong-mode-descendant",
	"swapped-merge-parents",
	"merge-tree-drift",
	"suppressed-root-exit",
	"coordinated-policy-artifact-rewrite",
] as const;

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

describe("D.93.35.15 freeze-successor controls", () => {
	it("loads the exact closed v4 contract shape without relying on the unchecked JSON cast", () => {
		expect(Object.keys(successorContract).sort()).toEqual(
			[
				"correctionPaths",
				"correctiveRed",
				"expectedPolicySchemaVersion",
				"expectedProfileSchemaVersion",
				"externalBase",
				"fixedAnchor",
				"gossipChain",
				"gossipFdbSha256",
				"gossipOracleTransition",
				"historicalTransitions",
				"intermediaryChain",
				"latentGossipBinding",
				"originalInstallPaths",
				"ownerDirectory",
				"ownerFiles",
				"predecessorOracleTransition",
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
		expect(successorContract.schemaVersion).toBe("phase-3a1b-freeze-successor-red-v4");
		expect(successorContract.expectedPolicySchemaVersion).toBe("ts-drp-protocol-v3-freeze-successor-v3");
		expect(successorContract.expectedProfileSchemaVersion).toBe("ts-drp-protocol-v3-freeze-successor-profile-v3");
		expect(Object.keys(successorContract.correctiveRed)).toEqual(["changedPaths"]);
		expect(successorContract.correctiveRed.changedPaths).toEqual([
			"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json",
			"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.ts",
			"tests/fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs",
			"tests/protocol-v3-freeze-successor-v1-red.test.ts",
		]);
		expect(Object.keys(successorContract.externalBase).sort()).toEqual(["commit", "parents", "tree"]);
		expect(Object.keys(successorContract.gossipOracleTransition).sort()).toEqual(
			["commit", "currentBlob", "currentSha256", "oldBlob", "oldSha256", "parent", "path", "tree"].sort()
		);
		expect(Object.keys(successorContract.predecessorOracleTransition).sort()).toEqual(
			["changedPaths", "commit", "governed", "parent", "parentTree"].sort()
		);
		expect(successorContract.predecessorOracleTransition.changedPaths).toHaveLength(6);
		expect(successorContract.predecessorOracleTransition.governed).toHaveLength(2);
		for (const transition of successorContract.predecessorOracleTransition.governed) {
			expect(Object.keys(transition).sort(), transition.id).toEqual(
				["currentBlob", "currentSha256", "id", "oldBlob", "oldSha256", "path"].sort()
			);
		}
		expect(successorContract.intermediaryChain.map(({ id }) => id)).toEqual([
			"root-drift-harness-correction",
			"d93.35.11-plan",
			"d93.35.12-plan",
			"d93.35.13-plan",
		]);
		for (const identity of successorContract.intermediaryChain) {
			expect(Object.keys(identity).sort(), identity.id).toEqual(
				["blob", "commit", "id", "parent", "path", "sha256", "tree"].sort()
			);
		}
		if (certificationMode) {
			const intermediary = intermediaryChainEvidence(REPOSITORY_ROOT, successorContract);
			expect(intermediary.chain).toEqual({ code: "AUTHENTICATED", valid: true });
			expect(intermediary.rows.map((row: { readonly commit: string }) => row.commit)).toEqual(
				successorContract.intermediaryChain.map(({ commit }) => commit)
			);
			const [first, second, ...rest] = intermediary.rows;
			expect(validateIntermediaryChain(successorContract.intermediaryChain, intermediary.rows.slice(1))).toEqual({
				code: "INTERMEDIARY_COUNT",
				valid: false,
			});
			expect(validateIntermediaryChain(successorContract.intermediaryChain, [second, first, ...rest])).toEqual({
				code: "INTERMEDIARY_IDENTITY",
				valid: false,
			});
			expect(
				validateIntermediaryChain(successorContract.intermediaryChain, [
					{ ...first, changedPaths: [first.path, successorContract.correctiveRed.changedPaths[0]] },
					second,
					...rest,
				])
			).toEqual({ code: "INTERMEDIARY_SCOPE", valid: false });
			expect(
				validateIntermediaryChain(successorContract.intermediaryChain, [
					first,
					{ ...second, parents: [successorContract.predecessorOracleTransition.commit] },
					...rest,
				])
			).toEqual({ code: "INTERMEDIARY_PARENT", valid: false });
			expect(
				validateIntermediaryChain(successorContract.intermediaryChain, [
					first,
					{
						...second,
						parents: [second.parents[0], successorContract.predecessorOracleTransition.commit],
					},
					...rest,
				])
			).toEqual({ code: "INTERMEDIARY_PARENT", valid: false });
			for (const field of ["tree", "blob", "sha256"] as const) {
				expect(
					validateIntermediaryChain(successorContract.intermediaryChain, [
						{ ...first, [field]: `${first[field]}-mutated` },
						second,
						...rest,
					])
				).toEqual({ code: "INTERMEDIARY_BYTES", valid: false });
			}
			expect(validateIntermediaryChain(successorContract.intermediaryChain, [...intermediary.rows, first])).toEqual({
				code: "INTERMEDIARY_COUNT",
				valid: false,
			});
			const planCommit = successorContract.intermediaryChain.at(-1)?.commit;
			expect(planCommit).toBeDefined();
			if (planCommit === undefined) return;
			const correctiveRed = intermediary.correctiveRed;
			expect(validateCorrectiveRed(planCommit, successorContract.correctiveRed.changedPaths, correctiveRed)).toEqual({
				code: "AUTHENTICATED",
				valid: true,
			});
			expect(
				validateCorrectiveRed(planCommit, successorContract.correctiveRed.changedPaths, {
					...correctiveRed,
					commit: undefined,
					commits: [],
				})
			).toEqual({ code: "CORRECTIVE_RED_COUNT", valid: false });
			expect(
				validateCorrectiveRed(planCommit, successorContract.correctiveRed.changedPaths, {
					...correctiveRed,
					commits: [...correctiveRed.commits, first.commit],
				})
			).toEqual({ code: "CORRECTIVE_RED_COUNT", valid: false });
			for (const parents of [
				[successorContract.predecessorOracleTransition.commit],
				[planCommit, successorContract.predecessorOracleTransition.commit],
			]) {
				expect(
					validateCorrectiveRed(planCommit, successorContract.correctiveRed.changedPaths, {
						...correctiveRed,
						parents,
					})
				).toEqual({ code: "CORRECTIVE_RED_PARENT", valid: false });
			}
			expect(
				validateCorrectiveRed(planCommit, successorContract.correctiveRed.changedPaths, {
					...correctiveRed,
					changedPaths: [...correctiveRed.changedPaths.slice(0, -1), successorContract.correctionPaths[0]].sort(),
				})
			).toEqual({ code: "CORRECTIVE_RED_SCOPE", valid: false });
		}
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

	it("proves rendered diff bytes vary while canonical Git object facts do not", () => {
		const transition = successorContract.intermediaryChain[0];
		const run = (args: readonly string[], hostile: boolean): SpawnSyncReturns<Buffer> =>
			spawnSync("git", args, {
				cwd: REPOSITORY_ROOT,
				env: hostile
					? {
							...process.env,
							GIT_CONFIG_COUNT: "1",
							GIT_CONFIG_KEY_0: "core.abbrev",
							GIT_CONFIG_VALUE_0: "40",
						}
					: process.env,
			});
		const facts = (
			hostile: boolean
		): Readonly<{ blob: Buffer; entry: Buffer; parent: Buffer; path: Buffer; tree: Buffer }> => {
			const parent = run(["rev-parse", `${transition.commit}^`], hostile);
			const tree = run(["rev-parse", `${transition.commit}^{tree}`], hostile);
			const path = run(
				["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", transition.parent, transition.commit],
				hostile
			);
			const entry = run(["ls-tree", transition.commit, "--", transition.path], hostile);
			for (const result of [parent, tree, path, entry]) expect(result.status).toBe(0);
			const match = /^([0-7]{6}) (\S+) ([0-9a-f]{40})\t(.+)\n$/u.exec(entry.stdout.toString("utf8"));
			expect(match).not.toBeNull();
			if (match === null) throw new Error("ls-tree entry framing differs");
			const [, mode, type, object, returnedPath] = match;
			expect({ mode, returnedPath, type }).toEqual({
				mode: "100644",
				returnedPath: transition.path,
				type: "blob",
			});
			const blob = run(["cat-file", "blob", object], hostile);
			expect(blob.status).toBe(0);
			return { blob: blob.stdout, entry: entry.stdout, parent: parent.stdout, path: path.stdout, tree: tree.stdout };
		};
		const defaultFacts = facts(false);
		const hostileFacts = facts(true);
		expect(defaultFacts).toEqual(hostileFacts);
		expect(createHash("sha256").update(defaultFacts.blob).digest("hex")).toBe(transition.sha256);
		const defaultRendered = run(["diff", "--binary", transition.parent, transition.commit], false);
		const hostileRendered = run(["diff", "--binary", transition.parent, transition.commit], true);
		expect(defaultRendered.status).toBe(0);
		expect(hostileRendered.status).toBe(0);
		expect(createHash("sha256").update(defaultRendered.stdout).digest("hex")).not.toBe(
			createHash("sha256").update(hostileRendered.stdout).digest("hex")
		);
	});

	it.skipIf(!certificationMode)(
		"derives exact 58/5/(50+3), and proves ordered mixed census with controlled Git objects",
		async () => {
			const inventory = governedInventory(REPOSITORY_ROOT, policyPaths);
			const workflows = new Set(successorContract.workflowIdentities.map(({ path }) => path));
			expect(inventory).toHaveLength(58);
			expect(new Set(inventory).size).toBe(58);
			expect(inventory.filter((path) => workflows.has(path))).toEqual(
				successorContract.workflowIdentities.map(({ path }) => path)
			);
			const immutable = inventory.filter((path) => !workflows.has(path));
			expect(immutable).toHaveLength(53);
			const predecessorTransitions = successorContract.predecessorOracleTransition.governed.map(({ path }) => path);
			const transitioned = new Set([successorContract.gossipOracleTransition.path, ...predecessorTransitions]);
			const fixedAnchor = immutable.filter((path) => !transitioned.has(path));
			expect(fixedAnchor).toHaveLength(50);
			const candidatePlan = repositoryMutationPlan(
				fixedAnchor,
				successorContract.gossipOracleTransition.path,
				predecessorTransitions
			);
			expect(candidatePlan).toHaveLength(114);
			expect(candidatePlan.filter((name) => name.startsWith("immutable:"))).toHaveLength(50);
			expect(candidatePlan.filter((name) => name.startsWith("gossip-"))).toEqual([
				`gossip-old:${successorContract.gossipOracleTransition.path}`,
				`gossip-current:${successorContract.gossipOracleTransition.path}`,
				`gossip-postbootstrap:${successorContract.gossipOracleTransition.path}`,
			]);
			expect(candidatePlan.filter((name) => name.startsWith("predecessor-"))).toEqual(
				predecessorTransitions.flatMap((path) => [
					`predecessor-old:${path}`,
					`predecessor-omitted:${path}`,
					`predecessor-drift:${path}`,
				])
			);
			expect(candidatePlan.some((name) => name.startsWith("workflow-count:"))).toBe(false);
			expect(new Set(candidatePlan).size).toBe(candidatePlan.length);
			expect(candidatePlan.slice(59)).toEqual([
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
		},
		120_000
	);

	it.skipIf(!certificationMode)(
		"executes all five predecessor baselines against their authenticated checker bases",
		async () => {
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
		},
		30_000
	);

	it.skipIf(!certificationMode)(
		"executes four isolated native protocol-root closures with exact byte outputs",
		async () => {
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
		},
		120_000
	);

	it("self-tests routing semantics, repository-root binding, and isolated upstream violations", () => {
		const operation = successorContract.workflowIdentities.find(
			({ jobKey }) => jobKey === "protocol-v3-blueprint-operation-budget"
		);
		expect(operation).toBeDefined();
		if (operation === undefined) return;
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
		const work = successorContract.workflowIdentities.find(
			({ jobKey }) => jobKey === "protocol-v3-blueprint-work-budget"
		);
		expect(work).toBeDefined();
		if (work === undefined) return;
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
			expect(auditSuccessorWorkflowRouting(actual, identity, legacyCheckers), identity.path).toEqual([]);
		}
	});

	it("retains the eight exact gossip routing analyzer controls", () => {
		const identity = successorContract.workflowIdentities[3];
		const expected = new Map<string, readonly string[]>([
			["gossip-legacy-removed-successor-absent.yml", ["successor-path"]],
			["gossip-successor-executable-legacy-retained.yml", ["legacy-checker-execution"]],
			["gossip-missing-digest-identity.yml", ["gossip-digest-checker"]],
			["gossip-missing-evidence-projection.yml", ["gossip-evidence-checker"]],
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

	it.skipIf(!certificationMode)(
		"authenticates historical blobs, all transition identities, and PR-side lineage",
		() => {
			expect(git("rev-parse", `${successorContract.fixedAnchor.commit}^{tree}`)).toBe(
				successorContract.fixedAnchor.tree
			);
			expect(git("rev-parse", `${successorContract.externalBase.commit}^{tree}`)).toBe(
				successorContract.externalBase.tree
			);
			expect(
				git("rev-list", "--parents", "-n", "1", successorContract.externalBase.commit).split(" ").slice(1)
			).toEqual(successorContract.externalBase.parents);
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
			const predecessorTransition = successorContract.predecessorOracleTransition;
			expect(git("rev-parse", `${predecessorTransition.parent}^{tree}`)).toBe(predecessorTransition.parentTree);
			for (const identity of predecessorTransition.governed) {
				expect(git("rev-parse", `${predecessorTransition.parent}:${identity.path}`), identity.id).toBe(
					identity.oldBlob
				);
				const shown = spawnSync("git", ["show", `${predecessorTransition.parent}:${identity.path}`], {
					cwd: REPOSITORY_ROOT,
				});
				expect(shown.status, identity.id).toBe(0);
				expect(createHash("sha256").update(shown.stdout).digest("hex"), identity.id).toBe(identity.oldSha256);
				expect(git("hash-object", identity.path), identity.id).toBe(identity.currentBlob);
				expect(sha256(identity.path), identity.id).toBe(identity.currentSha256);
			}
		}
	);
});

describe("D.93.35.15 genuine repository candidate", () => {
	it("fails RED only at the current provenance-owner readiness gate", async () => {
		expect(repositoryPlan.inventory).toHaveLength(58);
		expect(repositoryPlan.immutable).toHaveLength(53);
		expect(repositoryPlan.fixedAnchor).toHaveLength(50);
		expect(repositoryPlan.positiveNames).toHaveLength(4);
		expect(new Set(repositoryPlan.mutationNames).size).toBe(repositoryPlan.mutationNames.length);
		expect(candidateReadiness.topologyValid).toBe(true);
		expect(candidateReadiness.externalAbsent).toEqual(candidateReadiness.governed);
		expect(candidateReadiness.governed).toHaveLength(62);
		expect(candidateReadiness.originalInstall).toEqual([...successorContract.originalInstallPaths].sort());
		expect(candidateReadiness.originalInstallValid).toBe(true);
		expect(candidateReadiness.currentEntries).toHaveLength(62);
		for (const [path, entry] of candidateReadiness.currentEntries) {
			expect(entry, path).toMatchObject({ mode: "100644", type: "blob" });
		}
		expect(candidateReadiness.code).toBe("READY");
		expect(candidateReadiness.schemaValid).toBe(true);
		expect(candidateReadiness.ready).toBe(true);
		if (!candidateReadiness.ready) return;
		const results = await runReadyCandidateTopologies(REPOSITORY_ROOT, successorContract, candidateReadiness);
		expect(results.map(({ name }) => name)).toEqual([
			"linear:external-current-tip",
			"merge:external-current-tip",
			"linear:descendant",
			"merge:descendant",
		]);
		const repositoryHead = git("rev-parse", "HEAD");
		const repositoryParents = git("rev-list", "--parents", "-n", "1", repositoryHead).split(" ").slice(1);
		const current =
			repositoryParents.length === 2 && repositoryParents[0] === successorContract.externalBase.commit
				? repositoryParents[1]
				: repositoryHead;
		for (const { checkoutHead, checkoutParents, checkoutTree, name, releaseTip, releaseTree, result } of results) {
			if (name === "linear:external-current-tip") {
				expect({ checkoutHead, checkoutParents, releaseTip }).toEqual({
					checkoutHead: current,
					checkoutParents: git("rev-list", "--parents", "-n", "1", current).split(" ").slice(1),
					releaseTip: current,
				});
			}
			if (name === "merge:external-current-tip") {
				expect(checkoutParents).toEqual([successorContract.externalBase.commit, current]);
				expect(releaseTip).toBe(current);
				expect(checkoutTree).toBe(releaseTree);
			}
			expect(result.signal, name).toBeNull();
			expect(result.status, `${name}\n${normalizedChildOutput(result)}`).toBe(0);
			expect(result.output, name).toContain("protocol-v3 freeze successor: PASS");
		}
	}, 600_000);

	describe.skipIf(!candidateReadiness.ready)("GREEN-only genuine candidate execution", () => {
		it("accepts a candidate-opaque passthrough root-child preload", async () => {
			const result = await runRootChildPreloadPassthrough(REPOSITORY_ROOT, successorContract, candidateReadiness);
			expect(existsSync(result.cleanupPath)).toBe(false);
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
				expect(result.signal, result.id).toBeNull();
				expect(typeof result.status, result.id).toBe("number");
				expect(result.status, `${result.id}\n${result.output}`).not.toBe(0);
				expect(result.output, result.id).toContain("protocol-v3 freeze successor violation:");
				expect(result.output, result.id).toMatch(/(?:current|root).*(?:checker|preservation)|checker.*current/iu);
			}
		}, 600_000);

		it("rejects the fixed ordinary Class B provenance subset with the genuine checker", async () => {
			const evidence = await runOrdinaryClassBMutations(
				REPOSITORY_ROOT,
				successorContract,
				candidateReadiness,
				ordinaryClassBMutations
			);
			expect(evidence.map(({ name }) => name)).toEqual(ordinaryClassBMutations);
			for (const { name, result } of evidence) {
				expect(result.signal, name).toBeNull();
				expect(typeof result.status, name).toBe("number");
				expect(result.status, `${name}\n${normalizedChildOutput(result)}`).not.toBe(0);
				expect(result.output, name).toContain("protocol-v3 freeze successor violation:");
			}
		}, 600_000);

		for (const [index, mutationNames] of mutationPartitions.entries()) {
			const certificationIt = certificationMode ? it : it.skip;
			certificationIt(
				`certifies real-repository mutants ${index * 3 + 1}-${index * 3 + mutationNames.length}`,
				async () => {
					const evidence = await runRepositoryCandidatePartition(
						REPOSITORY_ROOT,
						successorContract,
						candidateReadiness,
						{
							mutationNames,
							positiveNames: [],
						}
					);
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
				},
				600_000
			);
		}
	});
});
