/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";

export function clone(value) {
	return structuredClone(value);
}

export function expectedProductManifest(predecessor, contract) {
	const result = clone(predecessor);
	result.exports[contract.manifestTransition.exportKey] = clone(contract.manifestTransition.exportValue);
	result.dependencies[contract.manifestTransition.dependencyKey] = contract.manifestTransition.dependencyValue;
	return result;
}

export function auditExactProductTransition(predecessor, candidate, contract) {
	if (!isDeepStrictEqual(candidate, expectedProductManifest(predecessor, contract))) {
		throw new Error("product manifest differs from the exact D.95 transition");
	}
}

export function auditSemanticProjection(candidate, contract) {
	if (!Array.isArray(candidate.files) || !candidate.files.includes(contract.semanticProjection.requiredPackedFile)) {
		throw new Error("numeric determinism supplement is not packed");
	}
	const forbidden = contract.semanticProjection.forbiddenRuntimeNameFragments;
	for (const [key, value] of Object.entries(candidate.exports ?? {})) {
		if (forbidden.some((fragment) => JSON.stringify([key, value]).includes(fragment))) {
			throw new Error("numeric determinism runtime export is forbidden");
		}
	}
	for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [key, value] of Object.entries(candidate[section] ?? {})) {
			if (forbidden.some((fragment) => JSON.stringify([key, value]).includes(fragment))) {
				throw new Error("deterministic math runtime dependency is forbidden");
			}
		}
	}
	for (const section of ["bundledDependencies", "bundleDependencies"]) {
		for (const key of candidate[section] ?? []) {
			if (forbidden.some((fragment) => key.includes(fragment))) {
				throw new Error("deterministic math bundled dependency is forbidden");
			}
		}
	}
	if (
		!isDeepStrictEqual(
			candidate.exports?.[contract.manifestTransition.exportKey],
			contract.manifestTransition.exportValue
		)
	) {
		throw new Error("blueprint application export differs");
	}
	if (
		candidate.dependencies?.[contract.manifestTransition.dependencyKey] !== contract.manifestTransition.dependencyValue
	) {
		throw new Error("errors dependency differs");
	}
}

export function auditV1Inventory(v1Policy, currentHashes, contract, releasedPaths = contract.releasedV1CurrentPaths) {
	if (!isDeepStrictEqual(v1Policy.protectedArtifacts, contract.predecessor.protectedArtifacts)) {
		throw new Error("v1 protected inventory count differs");
	}
	if (!isDeepStrictEqual(v1Policy.artifactSha256, contract.predecessor.artifactSha256)) {
		throw new Error("v1 artifact hash count differs");
	}
	if (!isDeepStrictEqual([...releasedPaths].sort(), [...contract.releasedV1CurrentPaths].sort())) {
		throw new Error("v1 release mapping differs");
	}
	const released = new Set(releasedPaths);
	for (const [path, digest] of Object.entries(v1Policy.artifactSha256)) {
		if (!released.has(path) && currentHashes[path] !== digest) {
			throw new Error(`preserved v1 artifact differs: ${path}`);
		}
	}
}

export function auditPredecessorIdentity(identity, contract) {
	for (const key of ["policySha256", "checkerSha256", "workflowSha256", "packageSha256"]) {
		if (identity[key] !== contract.predecessor[key]) throw new Error(`v1 predecessor ${key} differs`);
	}
}

export function auditSuccessorTopology(input, contract) {
	if (input.introductionParent !== input.expectedSuccessorRed) {
		throw new Error("successor owner introduction parent differs");
	}
	if (input.mode === "bootstrap") {
		if (input.mergeBaseHasV2 || input.secondBootstrap) throw new Error("successor bootstrap is not unique");
		if (input.bootstrapParents.length !== 1 || input.bootstrapParents[0] !== input.expectedSuccessorRed) {
			throw new Error("bootstrap parent differs");
		}
		auditBootstrapScope(input.changedPaths, contract);
	} else if (input.mode === "post-bootstrap") {
		if (!input.mergeBaseHasV2 || input.secondBootstrap) throw new Error("post-bootstrap base successor is absent");
		if (!isDeepStrictEqual(input.baseSuccessorObjects, input.currentSuccessorObjects)) {
			throw new Error("post-bootstrap successor bytes differ");
		}
	} else {
		throw new Error("successor topology mode differs");
	}
	for (const entry of Object.values(input.currentSuccessorObjects)) {
		if (entry?.mode !== "100644" || entry.type !== "blob") {
			throw new Error("successor owner is not a regular blob");
		}
	}
	if (!input.workflowCallLive) throw new Error("successor workflow call is dead");
}

function git(root, ...args) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function write(root, path, contents) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function commit(root, message) {
	git(root, "add", ".");
	git(root, "commit", "--quiet", "--allow-empty", "-m", message);
	return git(root, "rev-parse", "HEAD");
}

function treeObject(root, revision, path) {
	try {
		const match = /^(?<mode>[0-7]{6}) (?<type>blob|tree) (?<oid>[0-9a-f]+)\t/u.exec(
			git(root, "ls-tree", revision, "--", path)
		);
		return match?.groups === undefined ? undefined : match.groups;
	} catch {
		return undefined;
	}
}

function successorObjects(root, revision, contract) {
	return Object.fromEntries(
		[...contract.successorOwners, contract.workflowPath].map((path) => [path, treeObject(root, revision, path)])
	);
}

export function expectedWorkflowSource(contract) {
	return [
		"name: Protocol v3 blueprint numeric determinism freeze",
		"",
		"on:",
		"  pull_request:",
		"    types: [opened, synchronize, reopened, edited, ready_for_review]",
		"",
		"permissions:",
		"  contents: read",
		"",
		"jobs:",
		`  ${contract.workflow.jobId}:`,
		`    name: ${contract.workflow.jobName}`,
		"    runs-on: ubuntu-latest",
		"    timeout-minutes: 10",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          fetch-depth: 0",
		"          ref: ${{ github.sha }}",
		"      - uses: pnpm/action-setup@v4",
		"        with:",
		"          version: 10.24.0",
		"      - uses: actions/setup-node@v4",
		"        with:",
		"          node-version: 22",
		"          cache: pnpm",
		"      - run: pnpm install --frozen-lockfile",
		"      - name: Run merge-base-pinned blueprint numeric determinism successor",
		"        env:",
		"          BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		`          CHECKER_V2: ${contract.workflow.successorCheckerPath}`,
		`          POLICY_V2: ${contract.workflow.successorPolicyPath}`,
		"        run: |",
		...contract.workflow.runCommands.map(
			(command, index) => `${[1, 2, 3, 5, 7, 8].includes(index) ? "            " : "          "}${command}`
		),
		"      - run: pnpm exec vitest run tests/eslint-plugin-ts-drp-numeric-determinism-0n-a.test.ts --coverage.enabled=false --exclude '.logs/**'",
		"",
	].join("\n");
}

export const workflowMutantCases = Object.freeze([
	{ id: "trigger-pull-request-target", rejection: "WORKFLOW_TRIGGER" },
	{ id: "permissions-write", rejection: "WORKFLOW_PERMISSIONS" },
	{ id: "job-id-drift", rejection: "WORKFLOW_JOB_IDENTITY" },
	{ id: "checkout-shallow", rejection: "WORKFLOW_CHECKOUT" },
	{ id: "base-sha-unpinned", rejection: "WORKFLOW_BASE_SHA" },
	{ id: "job-continue-on-error", rejection: "WORKFLOW_CONTINUE_ON_ERROR" },
	{ id: "step-continue-on-error", rejection: "WORKFLOW_CONTINUE_ON_ERROR" },
	{ id: "bootstrap-runs-v1", rejection: "WORKFLOW_V1_FORBIDDEN" },
	{ id: "post-omits-base", rejection: "WORKFLOW_ROUTE_ORDER" },
	{ id: "post-omits-current", rejection: "WORKFLOW_ROUTE_ORDER" },
	{ id: "checker-root-implicit", rejection: "WORKFLOW_REPOSITORY_ROOT" },
	{ id: "partial-base-falls-through", rejection: "WORKFLOW_PARTIAL_BASE" },
	{ id: "run-block-extra-command", rejection: "WORKFLOW_RUN_BLOCK" },
]);

export const workflowIdentityMutantCase = Object.freeze({
	id: "workflow-byte-identity",
	rejection: "WORKFLOW_BYTE_IDENTITY",
});

function parsedWorkflowOwner(document, contract) {
	return document.jobs?.[contract.workflow.jobId];
}

function parsedSuccessorStep(job) {
	return job?.steps?.find((step) => step?.name === "Run merge-base-pinned blueprint numeric determinism successor");
}

function runCommands(step) {
	return step.run
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function mutateWorkflowSource(source, mutantId, contract) {
	const document = parse(source);
	const job = parsedWorkflowOwner(document, contract);
	const step = parsedSuccessorStep(job);
	if (mutantId === "trigger-pull-request-target") {
		document.on.pull_request_target = document.on.pull_request;
		delete document.on.pull_request;
	} else if (mutantId === "permissions-write") {
		document.permissions.contents = "write";
	} else if (mutantId === "job-id-drift") {
		document.jobs[`${contract.workflow.jobId}-mutant`] = job;
		delete document.jobs[contract.workflow.jobId];
	} else if (mutantId === "checkout-shallow") {
		job.steps.find((candidate) => candidate?.uses === "actions/checkout@v4").with["fetch-depth"] = 1;
	} else if (mutantId === "base-sha-unpinned") {
		step.env.BASE_SHA = "HEAD^";
	} else if (mutantId === "job-continue-on-error") {
		job["continue-on-error"] = true;
	} else if (mutantId === "step-continue-on-error") {
		step["continue-on-error"] = true;
	} else {
		const commands = runCommands(step);
		if (mutantId === "bootstrap-runs-v1") commands.splice(6, 0, 'node "$CHECKER" "$BASE_SHA"');
		else if (mutantId === "post-omits-base") commands[2] = ":";
		else if (mutantId === "post-omits-current") commands[3] = ":";
		else if (mutantId === "checker-root-implicit") {
			commands[2] = commands[2].replace(
				'PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT="$GITHUB_WORKSPACE" ',
				""
			);
		} else if (mutantId === "partial-base-falls-through") commands.splice(8, 1);
		else if (mutantId === "run-block-extra-command") commands.push("true");
		else throw new Error(`unknown workflow mutant: ${mutantId}`);
		step.run = `${commands.join("\n")}\n`;
	}
	return stringify(document, { lineWidth: 0 });
}

export function mutateWorkflowIdentitySource(source, contract) {
	const document = parse(source);
	const job = parsedWorkflowOwner(document, contract);
	const setupNode = job.steps.find((step) => step?.uses === "actions/setup-node@v4");
	setupNode.with["node-version"] = 23;
	return stringify(document, { lineWidth: 0 });
}

function mutatedWorkflow(contract, mutation) {
	const mutantByRepositoryMutation = {
		"dead-workflow": "post-omits-current",
		"execute-v1": "bootstrap-runs-v1",
		"omit-base": "post-omits-base",
		"omit-current": "post-omits-current",
	};
	const mutantId = mutantByRepositoryMutation[mutation];
	return mutantId === undefined
		? expectedWorkflowSource(contract)
		: mutateWorkflowSource(expectedWorkflowSource(contract), mutantId, contract);
}

export function createControlledRepository(contract, mutation = "none") {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-numeric-successor-"));
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "numeric-successor@example.invalid");
	git(root, "config", "user.name", "Numeric successor RED");
	write(root, "signed-red.txt", "signed successor RED\n");
	const successorRed = commit(root, "signed tests-only successor RED");
	const primaryBranch = git(root, "branch", "--show-current");
	if (mutation === "wrong-parent") {
		write(root, "intermediate.txt", "unauthorized intermediate\n");
		commit(root, "unauthorized intermediate");
	}
	if (mutation === "merge-parent") {
		git(root, "checkout", "--quiet", "-b", "numeric-successor-side", successorRed);
		commit(root, "independent empty side parent");
		git(root, "checkout", "--quiet", primaryBranch);
		git(root, "merge", "--quiet", "--no-ff", "--no-commit", "numeric-successor-side");
	}
	let partialBase;
	if (mutation === "partial-base" || mutation === "split-introduction") {
		for (const path of contract.successorOwners.slice(0, 2)) write(root, path, `controlled ${path}\n`);
		partialBase = commit(root, "partial numeric successor owner");
	}
	const ownerPaths =
		mutation === "partial-owner"
			? contract.successorOwners.slice(0, -1)
			: mutation === "partial-base" || mutation === "split-introduction"
				? contract.successorOwners.slice(2)
				: contract.successorOwners;
	for (const path of ownerPaths) {
		if (mutation === "symlink-owner" && path === contract.successorOwners[0]) {
			const target = join(root, path);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(basename(contract.successorOwners[1]), target);
		} else {
			write(root, path, `controlled ${path}\n`);
		}
	}
	const bootstrapWorkflowMutation = ["execute-v1", "omit-base", "omit-current", "dead-workflow"].includes(mutation)
		? mutation
		: "none";
	write(root, contract.workflowPath, mutatedWorkflow(contract, bootstrapWorkflowMutation));
	if (mutation === "extra-bootstrap-path") write(root, "extra.txt", "extra\n");
	const successorGreen = commit(root, "numeric successor GREEN");
	let bootstrapCandidate = successorGreen;
	if (mutation === "second-bootstrap") {
		write(root, contract.successorOwners[0], "second bootstrap mutation\n");
		bootstrapCandidate = commit(root, "second numeric successor bootstrap");
	}
	if (mutation === "readd-owner") {
		rmSync(join(root, contract.successorOwners[0]));
		commit(root, "delete successor owner");
		write(root, contract.successorOwners[0], "re-added successor owner\n");
	}
	if (mutation === "successor-drift") write(root, contract.successorOwners[0], "descendant drift\n");
	if (mutation === "post-omit-base") write(root, contract.workflowPath, mutatedWorkflow(contract, "omit-base"));
	if (mutation === "post-omit-current") write(root, contract.workflowPath, mutatedWorkflow(contract, "omit-current"));
	const descendant = commit(root, "post-bootstrap descendant");
	return {
		bootstrapCandidate,
		cleanup: () => rmSync(root, { force: true, recursive: true }),
		descendant,
		root,
		partialBase,
		successorGreen,
		successorRed,
	};
}

export function observeRepositoryTopology(root, base, candidate, expectedSuccessorRed, contract) {
	const mergeBases = git(root, "merge-base", "--all", base, candidate).split("\n").filter(Boolean);
	if (mergeBases.length !== 1 || mergeBases[0] !== base) throw new Error("successor merge base differs");
	const baseOwnerObjects = successorObjects(root, base, contract);
	const currentSuccessorObjects = successorObjects(root, candidate, contract);
	const baseOwnerCount = contract.successorOwners.filter((path) => baseOwnerObjects[path] !== undefined).length;
	if (baseOwnerCount !== 0 && baseOwnerCount !== contract.successorOwners.length) {
		throw new Error("partial base successor owner");
	}
	const changedPaths = git(root, "diff", "--name-only", base, candidate).split("\n").filter(Boolean);
	const bootstrapParents = git(root, "rev-list", "--parents", "-n", "1", candidate).split(" ").slice(1);
	const introductionParent = currentSuccessorRed(root, contract);
	const ownerCommits = git(
		root,
		"log",
		"--format=%H",
		`${expectedSuccessorRed}..${candidate}`,
		"--",
		...contract.successorOwners
	)
		.split("\n")
		.filter(Boolean);
	let workflowCallLive = true;
	try {
		const workflowSource = execFileSync("git", ["show", `${candidate}:${contract.workflowPath}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		auditWorkflowPolicy(workflowSource, contract);
	} catch {
		workflowCallLive = false;
	}
	return {
		baseSuccessorObjects: baseOwnerObjects,
		bootstrapParents,
		changedPaths,
		currentSuccessorObjects,
		expectedSuccessorRed,
		introductionParent,
		mergeBaseHasV2: baseOwnerCount === contract.successorOwners.length,
		mode: baseOwnerCount === 0 ? "bootstrap" : "post-bootstrap",
		secondBootstrap: new Set(ownerCommits).size > 1,
		workflowCallLive,
	};
}

export function currentSuccessorRed(sourceRoot, contract) {
	const introductionCommits = contract.successorOwners.map((path) =>
		git(sourceRoot, "log", "--format=%H", "--diff-filter=A", "--", path).split("\n").filter(Boolean)
	);
	if (introductionCommits.every((commits) => commits.length === 0)) return git(sourceRoot, "rev-parse", "HEAD");
	if (
		introductionCommits.some((commits) => commits.length !== 1) ||
		new Set(introductionCommits.map(([commitHash]) => commitHash)).size !== 1
	) {
		throw new Error("successor owner introduction is not unique and atomic");
	}
	const introductionParents = git(sourceRoot, "rev-list", "--parents", "-n", "1", introductionCommits[0][0])
		.split(" ")
		.slice(1);
	if (introductionParents.length !== 1) {
		throw new Error("successor owner introduction must have one parent");
	}
	return introductionParents[0];
}

export function createProductionRepository(sourceRoot, contract, mutation = "none") {
	const parent = mkdtempSync(join(tmpdir(), "ts-drp-numeric-successor-production-"));
	const root = join(parent, "repo");
	execFileSync("git", ["clone", "--quiet", "--shared", sourceRoot, root], { stdio: "ignore" });
	git(root, "config", "user.email", "numeric-successor@example.invalid");
	git(root, "config", "user.name", "Numeric successor GREEN");
	const successorRed = currentSuccessorRed(sourceRoot, contract);
	git(root, "checkout", "--quiet", "-B", "numeric-successor-primary", successorRed);
	const primaryBranch = "numeric-successor-primary";
	if (mutation === "wrong-parent") {
		write(root, "intermediate.txt", "unauthorized intermediate\n");
		commit(root, "unauthorized intermediate");
	}
	if (mutation === "merge-parent") {
		git(root, "checkout", "--quiet", "-b", "numeric-successor-side", successorRed);
		commit(root, "independent empty side parent");
		git(root, "checkout", "--quiet", primaryBranch);
		git(root, "merge", "--quiet", "--no-ff", "--no-commit", "numeric-successor-side");
	}
	for (const path of mutation === "partial-owner" ? contract.successorOwners.slice(0, -1) : contract.successorOwners) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		if (mutation === "symlink-owner" && path === contract.successorOwners[0]) {
			symlinkSync(join(sourceRoot, path), target);
		} else {
			copyFileSync(join(sourceRoot, path), target);
		}
	}
	copyFileSync(join(sourceRoot, contract.workflowPath), join(root, contract.workflowPath));
	if (mutation === "workflow-byte-drift") {
		write(
			root,
			contract.workflowPath,
			mutateWorkflowIdentitySource(readFileSync(join(root, contract.workflowPath), "utf8"), contract)
		);
	}
	if (mutation === "dead-workflow") {
		write(
			root,
			contract.workflowPath,
			mutateWorkflowSource(readFileSync(join(root, contract.workflowPath), "utf8"), "post-omits-current", contract)
		);
	}
	if (mutation === "extra-bootstrap-path") write(root, "extra.txt", "extra\n");
	if (mutation === "restamp-v1") {
		write(
			root,
			contract.predecessor.policyPath,
			`${readFileSync(join(root, contract.predecessor.policyPath), "utf8")} `
		);
	}
	const successorGreen = commit(root, "numeric successor GREEN");
	if (mutation === "second-bootstrap") {
		write(root, contract.successorOwners[0], `${readFileSync(join(root, contract.successorOwners[0]), "utf8")} `);
		commit(root, "second numeric successor bootstrap");
	}
	let descendant;
	if (mutation.startsWith("post-")) {
		if (mutation === "post-successor-drift") {
			write(root, contract.successorOwners[0], `${readFileSync(join(root, contract.successorOwners[0]), "utf8")} `);
		}
		if (mutation === "post-workflow-drift") {
			write(root, contract.workflowPath, mutatedWorkflow(contract, "omit-current"));
		}
		if (mutation === "post-v1-drift") {
			write(root, ".prettierignore", `${readFileSync(join(root, ".prettierignore"), "utf8")} `);
		}
		if (mutation === "post-manifest-leak") {
			const manifest = JSON.parse(readFileSync(join(root, contract.predecessor.packagePath), "utf8"));
			manifest.dependencies["@ts-drp/deterministic-math"] = "0.1.0";
			write(root, contract.predecessor.packagePath, `${JSON.stringify(manifest, undefined, "\t")}\n`);
		}
		descendant = commit(root, "post-bootstrap descendant");
	}
	return {
		cleanup: () => rmSync(parent, { force: true, recursive: true }),
		root,
		descendant,
		successorGreen,
		successorRed,
	};
}

export function executeProductionChecker(root, contract, baseRef) {
	const environment = { ...process.env, PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT: root };
	const execute = (checkerPath) =>
		execFileSync(process.execPath, [checkerPath, baseRef], {
			cwd: root,
			encoding: "utf8",
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
	const baseChecker = treeObject(root, baseRef, contract.workflow.successorCheckerPath);
	const basePolicy = treeObject(root, baseRef, contract.workflow.successorPolicyPath);
	if ((baseChecker === undefined) !== (basePolicy === undefined)) {
		throw new Error("partial base successor owner");
	}
	let output = "";
	if (baseChecker !== undefined) {
		const temporary = mkdtempSync(join(tmpdir(), "ts-drp-numeric-base-checker-"));
		try {
			const checkerPath = join(temporary, "check-freeze.mjs");
			writeFileSync(
				checkerPath,
				execFileSync("git", ["show", `${baseRef}:${contract.workflow.successorCheckerPath}`], {
					cwd: root,
				})
			);
			output += execute(checkerPath);
		} finally {
			rmSync(temporary, { force: true, recursive: true });
		}
	}
	output += execute(contract.workflow.successorCheckerPath);
	return output;
}

export function auditWorkflowIdentity(source, contract) {
	if (createHash("sha256").update(source).digest("hex") !== contract.workflow.canonicalSha256) {
		throw new Error("WORKFLOW_BYTE_IDENTITY");
	}
}

export function auditWorkflowPolicy(source, contract) {
	let workflow;
	try {
		workflow = parse(source);
	} catch {
		throw new Error("WORKFLOW_YAML");
	}
	if (
		!isDeepStrictEqual(Object.keys(workflow.on ?? {}), ["pull_request"]) ||
		!isDeepStrictEqual(workflow.on.pull_request?.types, [
			"opened",
			"synchronize",
			"reopened",
			"edited",
			"ready_for_review",
		])
	) {
		throw new Error("WORKFLOW_TRIGGER");
	}
	if (!isDeepStrictEqual(workflow.permissions, { contents: "read" })) {
		throw new Error("WORKFLOW_PERMISSIONS");
	}
	if (!isDeepStrictEqual(Object.keys(workflow.jobs ?? {}), [contract.workflow.jobId])) {
		throw new Error("WORKFLOW_JOB_IDENTITY");
	}
	const job = parsedWorkflowOwner(workflow, contract);
	if (job?.name !== contract.workflow.jobName || !Array.isArray(job.steps)) {
		throw new Error("WORKFLOW_JOB_IDENTITY");
	}
	if (job["continue-on-error"] !== undefined || job.steps.some((step) => step?.["continue-on-error"] !== undefined)) {
		throw new Error("WORKFLOW_CONTINUE_ON_ERROR");
	}
	if (job.permissions !== undefined || job.steps.some((step) => step?.permissions !== undefined)) {
		throw new Error("WORKFLOW_PERMISSIONS");
	}
	const checkout = job.steps.filter((step) => step?.uses === "actions/checkout@v4");
	if (
		checkout.length !== 1 ||
		checkout[0].with?.["fetch-depth"] !== 0 ||
		checkout[0].with?.ref !== "${{ github.sha }}"
	) {
		throw new Error("WORKFLOW_CHECKOUT");
	}
	const step = parsedSuccessorStep(job);
	if (
		step?.env?.BASE_SHA !== "${{ github.event.pull_request.base.sha }}" ||
		step?.env?.CHECKER_V2 !== contract.workflow.successorCheckerPath ||
		step?.env?.POLICY_V2 !== contract.workflow.successorPolicyPath ||
		typeof step?.run !== "string"
	) {
		throw new Error("WORKFLOW_BASE_SHA");
	}
	const commands = runCommands(step);
	if (commands.some((command) => command.includes('$CHECKER"') || command.includes(contract.predecessor.checkerPath))) {
		throw new Error("WORKFLOW_V1_FORBIDDEN");
	}
	if (commands[0] !== contract.workflow.runCommands[0] || commands[4] !== contract.workflow.runCommands[4]) {
		throw new Error("WORKFLOW_BRANCH");
	}
	if (
		commands[6] !== contract.workflow.runCommands[6] ||
		commands[7] !== contract.workflow.runCommands[7] ||
		commands[8] !== contract.workflow.runCommands[8] ||
		commands[9] !== contract.workflow.runCommands[9]
	) {
		throw new Error("WORKFLOW_PARTIAL_BASE");
	}
	const rootPrefix = 'PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT="$GITHUB_WORKSPACE" ';
	if (commands[1] !== contract.workflow.runCommands[1]) {
		throw new Error("WORKFLOW_ROUTE_ORDER");
	}
	for (const index of [2, 3, 5]) {
		if (commands[index] === contract.workflow.runCommands[index]) continue;
		if (`${rootPrefix}${commands[index]}` === contract.workflow.runCommands[index]) {
			throw new Error("WORKFLOW_REPOSITORY_ROOT");
		}
		throw new Error("WORKFLOW_ROUTE_ORDER");
	}
	if (!isDeepStrictEqual(commands, contract.workflow.runCommands)) {
		throw new Error("WORKFLOW_RUN_BLOCK");
	}
}

export function auditBootstrapScope(changedPaths, contract) {
	const expected = [...contract.successorOwners, contract.workflowPath].sort();
	if (!isDeepStrictEqual([...changedPaths].sort(), expected)) {
		throw new Error("successor bootstrap scope differs");
	}
}
