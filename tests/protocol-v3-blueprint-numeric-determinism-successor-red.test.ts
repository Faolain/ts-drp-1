/* eslint-disable @typescript-eslint/no-explicit-any, import/no-unresolved */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	auditBootstrapScope,
	auditExactProductTransition,
	auditPredecessorIdentity,
	auditSemanticProjection,
	auditSuccessorTopology,
	auditV1Inventory,
	auditWorkflowIdentity,
	auditWorkflowPolicy,
	createControlledRepository,
	createProductionRepository,
	currentSuccessorRed,
	executeProductionChecker,
	expectedWorkflowSource,
	mutateWorkflowIdentitySource,
	mutateWorkflowSource,
	observeRepositoryTopology,
	workflowIdentityMutantCase,
	workflowMutantCases,
} from "./fixtures/phase-4a-numeric-freeze-successor/controlled-successor.mjs";
import contract from "./fixtures/phase-4a-numeric-freeze-successor/successor-contract.json" with { type: "json" };

const ROOT = resolve(import.meta.dirname, "..");
const successorReady = contract.successorOwners.every((path) => existsSync(resolve(ROOT, path)));

function read(path: string): string {
	return readFileSync(resolve(ROOT, path), "utf8");
}

function json(path: string): Record<string, any> {
	return JSON.parse(read(path)) as Record<string, any>;
}

function jsonAt(revision: string, path: string): Record<string, any> {
	return JSON.parse(execFileSync("git", ["show", `${revision}:${path}`], { cwd: ROOT, encoding: "utf8" })) as Record<
		string,
		any
	>;
}

function expectedD95ProductManifest(predecessor: Record<string, any>): Record<string, any> {
	const product = structuredClone(predecessor);
	product.exports[contract.manifestTransition.exportKey] = structuredClone(contract.manifestTransition.exportValue);
	product.dependencies[contract.manifestTransition.dependencyKey] = contract.manifestTransition.dependencyValue;
	return product;
}

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(ROOT, path)))
		.digest("hex");
}

function sha256At(revision: string, path: string): string {
	return createHash("sha256")
		.update(execFileSync("git", ["show", `${revision}:${path}`], { cwd: ROOT }))
		.digest("hex");
}

function expectFailure(action: () => unknown, pattern: RegExp): void {
	expect(action).toThrowError(pattern);
}

describe("Phase 4a numeric-determinism freeze successor tests-only RED", () => {
	it("has one readiness boundary for the four missing successor owners", () => {
		expect(
			contract.successorOwners.filter((path) => !existsSync(resolve(ROOT, path))),
			"successor GREEN must add the complete four-file owner"
		).toEqual([]);
	});

	it("pins the signed predecessor, exact scopes and causal axes", () => {
		expect(contract.schemaVersion).toBe("phase-4a-blueprint-numeric-freeze-successor-red-v1");
		expect(contract.lineage).toEqual({
			phase0nGreenCommit: "6fd009266d58c4c55843f4faf54b68d38466beba",
			phase4aPlanCommit: "3c21a0157b258cd9ae214a9b401b9cc6d5933170",
			phase4aCoreRedCommit: "19b0452b0aebc0ba8c359065be3015c8dedd6307",
			phase4aCorrectionCommit: "62be3b5bdd069a68cb3661c959ac6de844d5ac15",
		});
		expect(contract.successorOwners).toHaveLength(4);
		expect(contract.releasedV1CurrentPaths).toEqual([
			".github/workflows/protocol-v3-blueprint-numeric-determinism.yml",
			"packages/protocol-v3/package.json",
		]);
	});

	it("authenticates the complete v1 inventory and exact predecessor bytes", () => {
		expect(sha256(contract.predecessor.policyPath)).toBe(contract.predecessor.policySha256);
		expect(sha256(contract.predecessor.checkerPath)).toBe(contract.predecessor.checkerSha256);
		expect(sha256At(contract.lineage.phase0nGreenCommit, contract.predecessor.workflowPath)).toBe(
			contract.predecessor.workflowSha256
		);
		expect(sha256At(contract.lineage.phase0nGreenCommit, contract.predecessor.packagePath)).toBe(
			contract.predecessor.packageSha256
		);
		const policy = json(contract.predecessor.policyPath);
		expect(policy.protectedArtifacts).toEqual(contract.predecessor.protectedArtifacts);
		expect(policy.artifactSha256).toEqual(contract.predecessor.artifactSha256);
		const hashes = Object.fromEntries(Object.keys(policy.artifactSha256).map((path) => [path, sha256(path)]));
		expect(() => auditV1Inventory(policy, hashes, contract)).not.toThrow();
		const omitted = { ...hashes };
		delete omitted["packages/eslint-plugin-ts-drp/src/index.ts"];
		expectFailure(() => auditV1Inventory(policy, omitted, contract), /preserved v1 artifact differs/u);
	});

	it("independently pins the exact D.95 manifest transition and later semantic projection", () => {
		const predecessor = jsonAt(contract.lineage.phase0nGreenCommit, contract.predecessor.packagePath);
		const product = expectedD95ProductManifest(predecessor);
		expect(() => auditExactProductTransition(predecessor, product, contract)).not.toThrow();
		expect(() => auditSemanticProjection(product, contract)).not.toThrow();

		const extraBootstrapDelta = structuredClone(product);
		extraBootstrapDelta.scripts.typecheck = "changed";
		expectFailure(
			() => auditExactProductTransition(predecessor, extraBootstrapDelta, contract),
			/exact D\.95 transition/u
		);
		const futureUnrelated = structuredClone(product);
		futureUnrelated.exports["./future-unrelated"] = { import: "./dist/src/future.js" };
		expect(() => auditSemanticProjection(futureUnrelated, contract)).not.toThrow();

		for (const [pattern, mutate] of [
			[
				/supplement is not packed/u,
				(value: any): void =>
					void value.files.splice(value.files.indexOf(contract.semanticProjection.requiredPackedFile), 1),
			],
			[
				/runtime dependency is forbidden/u,
				(value: any): void => void (value.dependencies["@ts-drp/deterministic-math"] = "0.1.0"),
			],
			[
				/runtime dependency is forbidden/u,
				(value: any): void => void (value.optionalDependencies = { "@ts-drp/deterministic-math": "0.1.0" }),
			],
			[
				/runtime dependency is forbidden/u,
				(value: any): void => void (value.peerDependencies = { "@ts-drp/deterministic-math": "0.1.0" }),
			],
			[
				/runtime dependency is forbidden/u,
				(value: any): void => void (value.dependencies.safe = "npm:@ts-drp/deterministic-math@0.1.0"),
			],
			[
				/runtime export is forbidden/u,
				(value: any): void => void (value.exports["./deterministic-math"] = { import: "./dist/math.js" }),
			],
			[
				/runtime export is forbidden/u,
				(value: any): void => void (value.exports["./future"] = { import: "./deterministic-math.js" }),
			],
			[
				/bundled dependency is forbidden/u,
				(value: any): void => void (value.bundledDependencies = ["@ts-drp/deterministic-math"]),
			],
			[
				/bundled dependency is forbidden/u,
				(value: any): void => {
					value.bundledDependencies = ["safe"];
					value.bundleDependencies = ["@ts-drp/deterministic-math"];
				},
			],
			[
				/blueprint application export differs/u,
				(value: any): void => void (value.exports[contract.manifestTransition.exportKey].import = "./wrong.js"),
			],
			[
				/errors dependency differs/u,
				(value: any): void => void (value.dependencies[contract.manifestTransition.dependencyKey] = "0.10.0"),
			],
		] as const) {
			const candidate = structuredClone(product);
			mutate(candidate);
			expectFailure(() => auditSemanticProjection(candidate, contract), pattern);
		}
	});

	it("pins the exact executable workflow and every security-sensitive field", () => {
		const workflow = expectedWorkflowSource(contract);
		expect(createHash("sha256").update(workflow).digest("hex")).toBe(contract.workflow.canonicalSha256);
		expect(() => auditWorkflowIdentity(workflow, contract)).not.toThrow();
		expect(() => auditWorkflowPolicy(workflow, contract)).not.toThrow();
		const identityMutant = mutateWorkflowIdentitySource(workflow, contract);
		expect(identityMutant, workflowIdentityMutantCase.id).not.toBe(workflow);
		expect(() => auditWorkflowPolicy(identityMutant, contract)).not.toThrow();
		expect(() => auditWorkflowIdentity(identityMutant, contract)).toThrowError(workflowIdentityMutantCase.rejection);
		for (const mutantCase of workflowMutantCases) {
			const mutant = mutateWorkflowSource(workflow, mutantCase.id, contract);
			expect(mutant, mutantCase.id).not.toBe(workflow);
			expect(() => auditWorkflowPolicy(mutant, contract), mutantCase.id).toThrowError(mutantCase.rejection);
		}
	});

	it("makes every declared successor mutant causal in the independent oracle", () => {
		const exercised = new Set<string>();
		const policy = json(contract.predecessor.policyPath);
		const hashes = Object.fromEntries(Object.keys(policy.artifactSha256).map((path) => [path, sha256(path)]));
		const predecessor = jsonAt(contract.lineage.phase0nGreenCommit, contract.predecessor.packagePath);
		const product = expectedD95ProductManifest(predecessor);

		const predecessorIdentity = {
			checkerSha256: contract.predecessor.checkerSha256,
			packageSha256: contract.predecessor.packageSha256,
			policySha256: contract.predecessor.policySha256,
			workflowSha256: contract.predecessor.workflowSha256,
		};
		expect(() => auditPredecessorIdentity(predecessorIdentity, contract)).not.toThrow();
		expect(() =>
			auditPredecessorIdentity({ ...predecessorIdentity, policySha256: "0".repeat(64) }, contract)
		).toThrow();
		exercised.add("restamp-v1-policy");
		for (const path of contract.predecessor.protectedArtifacts) {
			const malformedPolicy = structuredClone(policy);
			malformedPolicy.protectedArtifacts = malformedPolicy.protectedArtifacts.filter(
				(candidate: string) => candidate !== path
			);
			expect(() => auditV1Inventory(malformedPolicy, hashes, contract)).toThrow();
		}
		for (const path of Object.keys(contract.predecessor.artifactSha256)) {
			const missingBinding = structuredClone(policy);
			delete missingBinding.artifactSha256[path];
			expect(() => auditV1Inventory(missingBinding, hashes, contract)).toThrow();
			const changedBinding = structuredClone(policy);
			changedBinding.artifactSha256[path] = "0".repeat(64);
			expect(() => auditV1Inventory(changedBinding, hashes, contract)).toThrow();
			if (!contract.releasedV1CurrentPaths.includes(path)) {
				expect(() => auditV1Inventory(policy, { ...hashes, [path]: "0".repeat(64) }, contract)).toThrow();
			}
		}
		exercised.add("omit-v1-artifact-binding");
		expect(() =>
			auditV1Inventory(policy, hashes, contract, [
				...contract.releasedV1CurrentPaths,
				"packages/eslint-plugin-ts-drp/src/index.ts",
			])
		).toThrow();
		exercised.add("release-third-v1-path");
		const identityMutant = mutateWorkflowIdentitySource(expectedWorkflowSource(contract), contract);
		expect(() => auditWorkflowPolicy(identityMutant, contract)).not.toThrow();
		expect(() => auditWorkflowIdentity(identityMutant, contract)).toThrowError(workflowIdentityMutantCase.rejection);
		exercised.add(workflowIdentityMutantCase.id);

		for (const [id, mutate] of [
			[
				"remove-packed-supplement",
				(value: any): void =>
					void value.files.splice(value.files.indexOf(contract.semanticProjection.requiredPackedFile), 1),
			],
			[
				"add-deterministic-math-dependency",
				(value: any): void => void (value.dependencies["@ts-drp/deterministic-math"] = "0.1.0"),
			],
			[
				"add-deterministic-math-export",
				(value: any): void => void (value.exports["./deterministic-math"] = { import: "./dist/math.js" }),
			],
			[
				"wrong-blueprint-application-export",
				(value: any): void => void (value.exports[contract.manifestTransition.exportKey].import = "./wrong.js"),
			],
			[
				"wrong-errors-dependency",
				(value: any): void => void (value.dependencies[contract.manifestTransition.dependencyKey] = "0.10.0"),
			],
		] as const) {
			const candidate = structuredClone(product);
			mutate(candidate);
			expect(() => auditSemanticProjection(candidate, contract)).toThrow();
			exercised.add(id);
		}

		for (const [id, mutation] of [
			["partial-successor-owner", "partial-owner"],
			["extra-bootstrap-path", "extra-bootstrap-path"],
			["wrong-bootstrap-parent", "wrong-parent"],
			["second-bootstrap", "second-bootstrap"],
			["execute-v1-on-bootstrap-delta", "execute-v1"],
			["omit-base-successor-after-bootstrap", "post-omit-base"],
			["omit-current-successor-after-bootstrap", "post-omit-current"],
			["dead-workflow-successor-call", "dead-workflow"],
			["merge-bootstrap-parent", "merge-parent"],
			["successor-owner-symlink", "symlink-owner"],
		] as const) {
			const mutant = createControlledRepository(contract, mutation);
			try {
				const postBootstrap = mutation.startsWith("post-");
				expect(() => {
					const observed = observeRepositoryTopology(
						mutant.root,
						postBootstrap ? mutant.successorGreen : mutant.successorRed,
						postBootstrap ? mutant.descendant : mutant.bootstrapCandidate,
						mutant.successorRed,
						contract
					);
					auditSuccessorTopology(observed, contract);
				}, id).toThrow();
				exercised.add(id);
			} finally {
				mutant.cleanup();
			}
		}
		expect([...exercised].sort()).toEqual([...contract.causalMutants].sort());
	}, 120_000);

	it("derives bootstrap and descendant routing from a controlled Git repository", () => {
		const repository = createControlledRepository(contract);
		try {
			const bootstrap = observeRepositoryTopology(
				repository.root,
				repository.successorRed,
				repository.successorGreen,
				repository.successorRed,
				contract
			);
			expect(() => auditSuccessorTopology(bootstrap, contract)).not.toThrow();

			const postBootstrap = observeRepositoryTopology(
				repository.root,
				repository.successorGreen,
				repository.descendant,
				repository.successorRed,
				contract
			);
			expect(() => auditSuccessorTopology(postBootstrap, contract)).not.toThrow();
		} finally {
			repository.cleanup();
		}

		const drift = createControlledRepository(contract, "successor-drift");
		try {
			const observed = observeRepositoryTopology(
				drift.root,
				drift.successorGreen,
				drift.descendant,
				drift.successorRed,
				contract
			);
			expect(() => auditSuccessorTopology(observed, contract)).toThrow();
		} finally {
			drift.cleanup();
		}

		for (const mutation of ["split-introduction", "readd-owner"] as const) {
			const mutant = createControlledRepository(contract, mutation);
			try {
				expect(() => currentSuccessorRed(mutant.root, contract), mutation).toThrow();
			} finally {
				mutant.cleanup();
			}
		}
		const partialBase = createControlledRepository(contract, "partial-base");
		try {
			expect(() =>
				observeRepositoryTopology(
					partialBase.root,
					partialBase.partialBase,
					partialBase.successorGreen,
					partialBase.successorRed,
					contract
				)
			).toThrow();
		} finally {
			partialBase.cleanup();
		}
	}, 120_000);
});

describe.skipIf(!successorReady)("Phase 4a numeric successor GREEN", () => {
	it("binds the exact bootstrap scope, v1 release mapping and same-job routing", async () => {
		const checker = await import(
			"../packages/protocol-v3/conformance/blueprint-numeric-determinism-successor-v2/check-freeze.mjs"
		);
		const policy = json(
			"packages/protocol-v3/conformance/blueprint-numeric-determinism-successor-v2/freeze-policy.json"
		);
		const profile = json("packages/protocol-v3/conformance/blueprint-numeric-determinism-successor-v2/profile.json");
		expect(policy.schemaVersion).toBe("ts-drp-blueprint-numeric-determinism-successor-freeze-v2");
		expect(policy.successorRedCommit).toBe(currentSuccessorRed(ROOT, contract));
		expect(profile.profileId).toBe(contract.profileId);
		expect(profile.releasedV1CurrentPaths).toEqual(contract.releasedV1CurrentPaths);
		expect(() => auditBootstrapScope([...contract.successorOwners, contract.workflowPath], contract)).not.toThrow();
		expectFailure(() => auditBootstrapScope(contract.successorOwners.slice(1), contract), /bootstrap scope differs/u);
		expect(typeof checker.auditManifestProjection).toBe("function");
		expect(typeof checker.auditPredecessorIdentity).toBe("function");
		expect(typeof checker.auditSuccessorTopology).toBe("function");
		expect(typeof checker.auditV1Inventory).toBe("function");
		expect(typeof checker.auditWorkflowIdentity).toBe("function");
		expect(typeof checker.auditWorkflowRouting).toBe("function");
		expect(() => checker.auditWorkflowIdentity(read(contract.workflowPath))).not.toThrow();
		expect(() => auditWorkflowIdentity(read(contract.workflowPath), contract)).not.toThrow();
		expect(() => auditWorkflowPolicy(read(contract.workflowPath), contract)).not.toThrow();
	});

	it("keeps every declared mutant causal against the production successor", async () => {
		const checker = await import(
			"../packages/protocol-v3/conformance/blueprint-numeric-determinism-successor-v2/check-freeze.mjs"
		);
		const predecessor = jsonAt(contract.lineage.phase0nGreenCommit, contract.predecessor.packagePath);
		const product = expectedD95ProductManifest(predecessor);
		const policy = json(contract.predecessor.policyPath);
		const hashes = Object.fromEntries(Object.keys(policy.artifactSha256).map((path) => [path, sha256(path)]));
		const predecessorIdentity = {
			checkerSha256: contract.predecessor.checkerSha256,
			packageSha256: contract.predecessor.packageSha256,
			policySha256: contract.predecessor.policySha256,
			workflowSha256: contract.predecessor.workflowSha256,
		};
		expect(() => checker.auditPredecessorIdentity(predecessorIdentity)).not.toThrow();
		expectFailure(
			() => checker.auditPredecessorIdentity({ ...predecessorIdentity, policySha256: "0".repeat(64) }),
			/predecessor/u
		);
		expect(() => checker.auditV1Inventory(policy, hashes, contract.releasedV1CurrentPaths)).not.toThrow();
		for (const path of contract.predecessor.protectedArtifacts) {
			const malformedPolicy = structuredClone(policy);
			malformedPolicy.protectedArtifacts = malformedPolicy.protectedArtifacts.filter(
				(candidate: string) => candidate !== path
			);
			expect(() => checker.auditV1Inventory(malformedPolicy, hashes, contract.releasedV1CurrentPaths)).toThrow();
		}
		for (const path of Object.keys(contract.predecessor.artifactSha256)) {
			const missingBinding = structuredClone(policy);
			delete missingBinding.artifactSha256[path];
			expect(() => checker.auditV1Inventory(missingBinding, hashes, contract.releasedV1CurrentPaths)).toThrow();
			const changedBinding = structuredClone(policy);
			changedBinding.artifactSha256[path] = "0".repeat(64);
			expect(() => checker.auditV1Inventory(changedBinding, hashes, contract.releasedV1CurrentPaths)).toThrow();
			if (!contract.releasedV1CurrentPaths.includes(path)) {
				expect(() =>
					checker.auditV1Inventory(policy, { ...hashes, [path]: "0".repeat(64) }, contract.releasedV1CurrentPaths)
				).toThrow();
			}
		}
		expectFailure(
			() =>
				checker.auditV1Inventory(policy, hashes, [
					...contract.releasedV1CurrentPaths,
					"packages/eslint-plugin-ts-drp/src/index.ts",
				]),
			/release mapping/u
		);
		expect(() => checker.auditManifestProjection(predecessor)).not.toThrow();
		expect(() => checker.auditManifestProjection(product)).not.toThrow();
		for (const mutate of [
			(value: any): void =>
				void value.files.splice(value.files.indexOf(contract.semanticProjection.requiredPackedFile), 1),
			(value: any): void => void (value.dependencies["@ts-drp/deterministic-math"] = "0.1.0"),
			(value: any): void => void (value.optionalDependencies = { "@ts-drp/deterministic-math": "0.1.0" }),
			(value: any): void => void (value.peerDependencies = { "@ts-drp/deterministic-math": "0.1.0" }),
			(value: any): void => void (value.dependencies.safe = "npm:@ts-drp/deterministic-math@0.1.0"),
			(value: any): void => void (value.exports["./deterministic-math"] = { import: "./dist/math.js" }),
			(value: any): void => void (value.exports["./future"] = { import: "./deterministic-math.js" }),
			(value: any): void => void (value.bundledDependencies = ["@ts-drp/deterministic-math"]),
			(value: any): void => {
				value.bundledDependencies = ["safe"];
				value.bundleDependencies = ["@ts-drp/deterministic-math"];
			},
			(value: any): void => void (value.exports[contract.manifestTransition.exportKey].import = "./wrong.js"),
			(value: any): void => void (value.dependencies[contract.manifestTransition.dependencyKey] = "0.10.0"),
		] as const) {
			const candidate = structuredClone(product);
			mutate(candidate);
			expect(() => checker.auditManifestProjection(candidate)).toThrow();
		}
		const workflow = read(contract.workflowPath);
		const identityMutant = mutateWorkflowIdentitySource(workflow, contract);
		expect(() => checker.auditWorkflowRouting(identityMutant)).not.toThrow();
		expect(() => checker.auditWorkflowIdentity(identityMutant)).toThrowError(workflowIdentityMutantCase.rejection);
		expect(() => checker.auditWorkflowRouting(workflow)).not.toThrow();
		for (const mutantCase of workflowMutantCases) {
			const mutant = mutateWorkflowSource(workflow, mutantCase.id, contract);
			expect(mutant, mutantCase.id).not.toBe(workflow);
			expect(() => checker.auditWorkflowRouting(mutant), mutantCase.id).toThrowError(mutantCase.rejection);
		}

		const repository = createControlledRepository(contract);
		try {
			for (const [base, candidate] of [
				[repository.successorRed, repository.successorGreen],
				[repository.successorGreen, repository.descendant],
			] as const) {
				const observed = observeRepositoryTopology(repository.root, base, candidate, repository.successorRed, contract);
				expect(() => checker.auditSuccessorTopology(observed)).not.toThrow();
			}
		} finally {
			repository.cleanup();
		}

		for (const mutation of [
			"partial-owner",
			"extra-bootstrap-path",
			"wrong-parent",
			"second-bootstrap",
			"execute-v1",
			"omit-base",
			"omit-current",
			"dead-workflow",
			"merge-parent",
			"symlink-owner",
		] as const) {
			const mutant = createControlledRepository(contract, mutation);
			try {
				expect(() => {
					const observed = observeRepositoryTopology(
						mutant.root,
						mutant.successorRed,
						mutant.bootstrapCandidate,
						mutant.successorRed,
						contract
					);
					checker.auditSuccessorTopology(observed);
				}, mutation).toThrow();
			} finally {
				mutant.cleanup();
			}
		}

		const goodProduction = createProductionRepository(ROOT, contract);
		try {
			expect(() => executeProductionChecker(goodProduction.root, contract, goodProduction.successorRed)).not.toThrow();
		} finally {
			goodProduction.cleanup();
		}
		for (const mutation of [
			"partial-owner",
			"extra-bootstrap-path",
			"wrong-parent",
			"second-bootstrap",
			"dead-workflow",
			"restamp-v1",
			"workflow-byte-drift",
			"merge-parent",
			"symlink-owner",
		] as const) {
			const mutant = createProductionRepository(ROOT, contract, mutation);
			try {
				expect(() => executeProductionChecker(mutant.root, contract, mutant.successorRed), mutation).toThrow();
			} finally {
				mutant.cleanup();
			}
		}

		const cleanDescendant = createProductionRepository(ROOT, contract, "post-clean");
		try {
			expect(() =>
				executeProductionChecker(cleanDescendant.root, contract, cleanDescendant.successorGreen)
			).not.toThrow();
		} finally {
			cleanDescendant.cleanup();
		}
		for (const mutation of [
			"post-successor-drift",
			"post-workflow-drift",
			"post-v1-drift",
			"post-manifest-leak",
		] as const) {
			const mutant = createProductionRepository(ROOT, contract, mutation);
			try {
				expect(() => executeProductionChecker(mutant.root, contract, mutant.successorGreen), mutation).toThrow();
			} finally {
				mutant.cleanup();
			}
		}
	}, 120_000);
});
