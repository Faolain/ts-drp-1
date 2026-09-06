/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ownerDirectory = "packages/protocol-v3/conformance/blueprint-numeric-determinism-successor-v2";
const repositoryRoot = realpathSync(
	resolve(
		process.env.PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT ?? dirname(fileURLToPath(import.meta.url)),
		process.env.PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT === undefined ? "../../../.." : "."
	)
);
const policyPath = `${ownerDirectory}/freeze-policy.json`;
const policy = JSON.parse(readFileSync(resolve(repositoryRoot, policyPath), "utf8"));

function canonicalWorkflowDocument(source) {
	if (sha256(source) !== policy.workflow.canonicalSha256) fail("WORKFLOW_YAML_PARSER");
	return {
		on: { pull_request: { types: policy.workflow.pullRequestTypes } },
		permissions: { contents: "read" },
		jobs: {
			[policy.workflow.jobId]: {
				name: policy.workflow.jobName,
				steps: [
					{ uses: "actions/checkout@v4", with: { "fetch-depth": 0, "ref": "${{ github.sha }}" } },
					{
						name: policy.workflow.stepName,
						env: {
							BASE_SHA: "${{ github.event.pull_request.base.sha }}",
							CHECKER_V2: policy.workflow.successorCheckerPath,
							POLICY_V2: policy.workflow.successorPolicyPath,
						},
						run: `${policy.workflow.runCommands.join("\n")}\n`,
					},
				],
			},
		},
	};
}

let parse = canonicalWorkflowDocument;
if (existsSync(resolve(repositoryRoot, "node_modules/yaml/package.json"))) {
	({ parse } = createRequire(resolve(repositoryRoot, "package.json"))("yaml"));
}

function fail(message) {
	throw new Error(message);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function command(executable, args) {
	return spawnSync(executable, args, {
		cwd: repositoryRoot,
		encoding: null,
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
		timeout: 60_000,
	});
}

function gitBytes(...args) {
	const result = command("git", args);
	if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr.length !== 0) {
		fail(`GIT_EVIDENCE:${args[0] ?? "unknown"}`);
	}
	return result.stdout;
}

function gitText(...args) {
	return gitBytes(...args)
		.toString("utf8")
		.trim();
}

function gitBlob(revision, path) {
	return gitBytes("show", `${revision}:${path}`);
}

function successorIntroduction() {
	const introductions = Object.fromEntries(policy.successorOwners.map((path) => [path, []]));
	const parentsByCommit = new Map();
	const touchedCommits = new Set();
	let commit;
	for (const line of gitText(
		"log",
		"--format=commit:%H parents:%P",
		"--name-status",
		"--no-renames",
		`${policy.successorRedCommit}..HEAD`,
		"--",
		...policy.successorOwners,
		policy.workflow.path
	).split("\n")) {
		if (line.startsWith("commit:")) {
			const [identity, parents = ""] = line.slice("commit:".length).split(" parents:");
			commit = identity;
			parentsByCommit.set(identity, parents.split(" ").filter(Boolean));
		} else if (/^[A-Z]\t/u.test(line) && commit !== undefined) {
			touchedCommits.add(commit);
			if (line.startsWith("A\t")) introductions[line.slice(2)]?.push(commit);
		}
	}
	const introductionCommits = policy.successorOwners.map((path) => introductions[path]);
	if (
		introductionCommits.some((commits) => commits.length !== 1) ||
		new Set(introductionCommits.map(([introduction]) => introduction)).size !== 1
	) {
		fail("SUCCESSOR_INTRODUCTION");
	}
	const parents = parentsByCommit.get(introductionCommits[0][0]) ?? [];
	if (parents.length !== 1) fail("SUCCESSOR_PARENT_COUNT");
	return { parent: parents[0], secondBootstrap: touchedCommits.size > 1 };
}

function successorObjects(revision) {
	const paths = [...policy.successorOwners, policy.workflow.path];
	const entries = Object.fromEntries(paths.map((path) => [path, undefined]));
	for (const record of gitText("ls-tree", revision, "--", ...paths)
		.split("\n")
		.filter(Boolean)) {
		const match = /^(?<mode>[0-7]{6}) (?<type>blob|tree) (?<object>[0-9a-f]+)\t(?<path>.+)$/u.exec(record);
		if (match?.groups === undefined || !(match.groups.path in entries)) fail("SUCCESSOR_OBJECT");
		entries[match.groups.path] = {
			mode: match.groups.mode,
			object: match.groups.object,
			type: match.groups.type,
		};
	}
	return entries;
}

function bootstrapProductCommit(base, candidate) {
	const [, ...parents] = gitText("rev-list", "--parents", "-n", "1", candidate).split(" ");
	if (parents.length !== 2) return candidate;
	if (parents[0] !== base) fail("SUCCESSOR_BOOTSTRAP_MERGE_PARENT");
	const product = parents[1];
	const [, ...productParents] = gitText("rev-list", "--parents", "-n", "1", product).split(" ");
	if (productParents.length !== 1 || productParents[0] !== base) fail("SUCCESSOR_BOOTSTRAP_PARENT");
	if (gitText("rev-parse", `${candidate}^{tree}`) !== gitText("rev-parse", `${product}^{tree}`)) {
		fail("SUCCESSOR_BOOTSTRAP_MERGE_TREE");
	}
	return product;
}

function parsedWorkflowOwner(document) {
	return document.jobs?.[policy.workflow.jobId];
}

function parsedSuccessorStep(job) {
	return job?.steps?.find((step) => step?.name === policy.workflow.stepName);
}

function runCommands(step) {
	return step.run
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function auditPredecessorIdentity(identity) {
	for (const key of ["policySha256", "checkerSha256", "workflowSha256", "packageSha256"]) {
		if (identity[key] !== policy.predecessor[key]) fail(`predecessor identity differs: ${key}`);
	}
}

export function auditV1Inventory(v1Policy, currentHashes, releasedPaths = policy.releasedV1CurrentPaths) {
	if (!isDeepStrictEqual(v1Policy.protectedArtifacts, policy.predecessor.protectedArtifacts)) {
		fail("V1_PROTECTED_INVENTORY");
	}
	if (!isDeepStrictEqual(v1Policy.artifactSha256, policy.predecessor.artifactSha256)) {
		fail("V1_HASH_INVENTORY");
	}
	if (!isDeepStrictEqual([...releasedPaths].sort(), [...policy.releasedV1CurrentPaths].sort())) {
		fail("v1 release mapping differs");
	}
	const released = new Set(releasedPaths);
	for (const [path, digest] of Object.entries(v1Policy.artifactSha256)) {
		if (!released.has(path) && currentHashes[path] !== digest) fail(`V1_ARTIFACT:${path}`);
	}
}

export function auditManifestProjection(candidate) {
	if (!Array.isArray(candidate.files) || !candidate.files.includes(policy.semanticProjection.requiredPackedFile)) {
		fail("MANIFEST_PACKED_SUPPLEMENT");
	}
	const forbidden = policy.semanticProjection.forbiddenRuntimeNameFragments;
	for (const [key, value] of Object.entries(candidate.exports ?? {})) {
		if (forbidden.some((fragment) => JSON.stringify([key, value]).includes(fragment))) {
			fail("MANIFEST_RUNTIME_EXPORT");
		}
	}
	for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [key, value] of Object.entries(candidate[section] ?? {})) {
			if (forbidden.some((fragment) => JSON.stringify([key, value]).includes(fragment))) {
				fail("MANIFEST_RUNTIME_DEPENDENCY");
			}
		}
	}
	for (const section of ["bundledDependencies", "bundleDependencies"]) {
		for (const name of candidate[section] ?? []) {
			if (forbidden.some((fragment) => name.includes(fragment))) fail("MANIFEST_BUNDLED_DEPENDENCY");
		}
	}
	const actualExport = candidate.exports?.[policy.manifestTransition.exportKey];
	const actualDependency = candidate.dependencies?.[policy.manifestTransition.dependencyKey];
	const predecessorState = actualExport === undefined && actualDependency === undefined;
	const productState =
		isDeepStrictEqual(actualExport, policy.manifestTransition.exportValue) &&
		actualDependency === policy.manifestTransition.dependencyValue;
	if (!predecessorState && !productState) fail("MANIFEST_PHASE4A_PROJECTION");
}

export function auditWorkflowIdentity(source) {
	if (sha256(source) !== policy.workflow.canonicalSha256) fail("WORKFLOW_BYTE_IDENTITY");
}

export function auditWorkflowRouting(source) {
	let workflow;
	try {
		workflow = parse(source);
	} catch {
		fail("WORKFLOW_YAML");
	}
	if (
		!isDeepStrictEqual(Object.keys(workflow.on ?? {}), ["pull_request"]) ||
		!isDeepStrictEqual(workflow.on.pull_request?.types, policy.workflow.pullRequestTypes)
	) {
		fail("WORKFLOW_TRIGGER");
	}
	if (!isDeepStrictEqual(workflow.permissions, { contents: "read" })) fail("WORKFLOW_PERMISSIONS");
	if (!isDeepStrictEqual(Object.keys(workflow.jobs ?? {}), [policy.workflow.jobId])) fail("WORKFLOW_JOB_IDENTITY");
	const job = parsedWorkflowOwner(workflow);
	if (job?.name !== policy.workflow.jobName || !Array.isArray(job.steps)) fail("WORKFLOW_JOB_IDENTITY");
	if (job["continue-on-error"] !== undefined || job.steps.some((step) => step?.["continue-on-error"] !== undefined)) {
		fail("WORKFLOW_CONTINUE_ON_ERROR");
	}
	if (job.permissions !== undefined || job.steps.some((step) => step?.permissions !== undefined)) {
		fail("WORKFLOW_PERMISSIONS");
	}
	const checkout = job.steps.filter((step) => step?.uses === "actions/checkout@v4");
	if (
		checkout.length !== 1 ||
		checkout[0].with?.["fetch-depth"] !== 0 ||
		checkout[0].with?.ref !== "${{ github.sha }}"
	) {
		fail("WORKFLOW_CHECKOUT");
	}
	const step = parsedSuccessorStep(job);
	if (
		step?.env?.BASE_SHA !== "${{ github.event.pull_request.base.sha }}" ||
		step?.env?.CHECKER_V2 !== policy.workflow.successorCheckerPath ||
		step?.env?.POLICY_V2 !== policy.workflow.successorPolicyPath ||
		typeof step?.run !== "string"
	) {
		fail("WORKFLOW_BASE_SHA");
	}
	const commands = runCommands(step);
	if (commands.some((command) => command.includes('$CHECKER"') || command.includes(policy.predecessor.checkerPath))) {
		fail("WORKFLOW_V1_FORBIDDEN");
	}
	if (commands[0] !== policy.workflow.runCommands[0] || commands[4] !== policy.workflow.runCommands[4]) {
		fail("WORKFLOW_BRANCH");
	}
	if (
		commands[6] !== policy.workflow.runCommands[6] ||
		commands[7] !== policy.workflow.runCommands[7] ||
		commands[8] !== policy.workflow.runCommands[8] ||
		commands[9] !== policy.workflow.runCommands[9]
	) {
		fail("WORKFLOW_PARTIAL_BASE");
	}
	const rootPrefix = 'PROTOCOL_V3_BLUEPRINT_NUMERIC_SUCCESSOR_REPOSITORY_ROOT="$GITHUB_WORKSPACE" ';
	if (commands[1] !== policy.workflow.runCommands[1]) fail("WORKFLOW_ROUTE_ORDER");
	for (const index of [2, 3, 5]) {
		if (commands[index] === policy.workflow.runCommands[index]) continue;
		if (`${rootPrefix}${commands[index]}` === policy.workflow.runCommands[index]) fail("WORKFLOW_REPOSITORY_ROOT");
		fail("WORKFLOW_ROUTE_ORDER");
	}
	if (!isDeepStrictEqual(commands, policy.workflow.runCommands)) fail("WORKFLOW_RUN_BLOCK");
}

export function auditSuccessorTopology(input) {
	if (input.introductionParent !== input.expectedSuccessorRed) fail("SUCCESSOR_INTRODUCTION_PARENT");
	if (input.mode === "bootstrap") {
		if (input.mergeBaseHasV2 || input.secondBootstrap) fail("SUCCESSOR_SECOND_BOOTSTRAP");
		if (input.bootstrapParents.length !== 1 || input.bootstrapParents[0] !== input.expectedSuccessorRed) {
			fail("SUCCESSOR_BOOTSTRAP_PARENT");
		}
		const expectedPaths = [...policy.successorOwners, policy.workflow.path].sort();
		if (!isDeepStrictEqual([...input.changedPaths].sort(), expectedPaths)) fail("SUCCESSOR_BOOTSTRAP_SCOPE");
	} else if (input.mode === "post-bootstrap") {
		if (!input.mergeBaseHasV2 || input.secondBootstrap) fail("SUCCESSOR_POST_BASE");
		if (!isDeepStrictEqual(input.baseSuccessorObjects, input.currentSuccessorObjects)) {
			fail("SUCCESSOR_DESCENDANT_DRIFT");
		}
	} else {
		fail("SUCCESSOR_MODE");
	}
	for (const entry of Object.values(input.currentSuccessorObjects)) {
		if (entry?.mode !== "100644" || entry.type !== "blob") fail("SUCCESSOR_OBJECT_CLASS");
	}
	if (!input.workflowCallLive) fail("SUCCESSOR_WORKFLOW_DEAD");
}

function observeRepositoryTopology(base, candidate) {
	if (base === policy.successorRedCommit) {
		candidate = bootstrapProductCommit(base, candidate);
		const paths = [...policy.successorOwners, policy.workflow.path];
		const baseObjects = Object.fromEntries(paths.map((path) => [path, undefined]));
		const currentObjects = Object.fromEntries(paths.map((path) => [path, undefined]));
		let bootstrapParents = [];
		const changed = [];
		for (const line of gitText("show", "--format=parents:%P", "--raw", "--no-renames", "--no-abbrev", candidate).split(
			"\n"
		)) {
			if (line.startsWith("parents:")) bootstrapParents = line.slice("parents:".length).split(" ").filter(Boolean);
			const match =
				/^:[0-7]{6} (?<mode>[0-7]{6}) [0-9a-f]{40} (?<object>[0-9a-f]{40}) (?<status>[A-Z])\t(?<path>.+)$/u.exec(line);
			if (match?.groups === undefined) continue;
			changed.push(match.groups.path);
			if (match.groups.path in currentObjects) {
				currentObjects[match.groups.path] = {
					mode: match.groups.mode,
					object: match.groups.object,
					type: match.groups.mode === "040000" ? "tree" : "blob",
				};
			}
		}
		return {
			baseSuccessorObjects: baseObjects,
			bootstrapParents,
			changedPaths: changed,
			currentSuccessorObjects: currentObjects,
			expectedSuccessorRed: policy.successorRedCommit,
			introductionParent: policy.successorRedCommit,
			mergeBaseHasV2: false,
			mode: "bootstrap",
			secondBootstrap: false,
			workflowCallLive: true,
		};
	}
	const baseObjects = successorObjects(base);
	if (policy.successorOwners.some((path) => baseObjects[path] === undefined)) fail("SUCCESSOR_PARTIAL_BASE");
	const descendantDiff = gitText(
		"diff",
		"--raw",
		"--no-renames",
		base,
		candidate,
		"--",
		...policy.successorOwners,
		policy.workflow.path
	);
	if (descendantDiff !== "") fail("SUCCESSOR_DESCENDANT_DRIFT");
	const mergeBases = gitText("merge-base", "--all", base, candidate).split("\n").filter(Boolean);
	if (mergeBases.length !== 1 || mergeBases[0] !== base) fail("SUCCESSOR_MERGE_BASE");
	const introduction = successorIntroduction();
	return {
		baseSuccessorObjects: baseObjects,
		bootstrapParents: [],
		changedPaths: [],
		currentSuccessorObjects: baseObjects,
		expectedSuccessorRed: policy.successorRedCommit,
		introductionParent: introduction.parent,
		mergeBaseHasV2: true,
		mode: "post-bootstrap",
		secondBootstrap: introduction.secondBootstrap,
		workflowCallLive: true,
	};
}

function main() {
	const base = process.argv[2];
	if (typeof base !== "string" || !/^[0-9a-f]{40}$/u.test(base)) fail("BASE_IDENTITY");
	const head = "HEAD";
	const predecessor = policy.predecessor;
	const workflow = readFileSync(resolve(repositoryRoot, policy.workflow.path), "utf8");
	auditWorkflowIdentity(workflow);
	auditWorkflowRouting(workflow);
	for (const path of policy.successorOwners) {
		let stat;
		try {
			stat = lstatSync(resolve(repositoryRoot, path));
		} catch {
			fail("SUCCESSOR_OBJECT_CLASS");
		}
		if (!stat.isFile() || stat.isSymbolicLink()) fail("SUCCESSOR_OBJECT_CLASS");
	}
	const installedOwnerDirectory = resolve(repositoryRoot, ownerDirectory);
	if (resolve(dirname(fileURLToPath(import.meta.url))) !== installedOwnerDirectory) {
		if (!gitBlob(base, policyPath).equals(readFileSync(resolve(repositoryRoot, policyPath)))) {
			fail("SUCCESSOR_POLICY_DRIFT");
		}
		const checkerPath = policy.workflow.successorCheckerPath;
		if (!gitBlob(head, checkerPath).equals(readFileSync(resolve(repositoryRoot, checkerPath)))) {
			fail("SUCCESSOR_CHECKER_DRIFT");
		}
		const baseObjects = successorObjects(base);
		const currentObjects = successorObjects(head);
		if (!isDeepStrictEqual(baseObjects, currentObjects)) fail("SUCCESSOR_DESCENDANT_DRIFT");
		for (const entry of Object.values(currentObjects)) {
			if (entry?.mode !== "100644" || entry.type !== "blob") fail("SUCCESSOR_OBJECT_CLASS");
		}
		process.stdout.write("protocol-v3 numeric determinism base successor freeze: PASS\n");
		return;
	}
	const checkerSha256 = sha256(readFileSync(resolve(repositoryRoot, predecessor.checkerPath)));
	const policySha256 = sha256(readFileSync(resolve(repositoryRoot, predecessor.policyPath)));
	if (checkerSha256 !== predecessor.checkerSha256 || policySha256 !== predecessor.policySha256) {
		fail("predecessor current owner differs");
	}
	const v1Policy = JSON.parse(readFileSync(resolve(repositoryRoot, predecessor.policyPath), "utf8"));
	const currentHashes = Object.fromEntries(
		Object.keys(predecessor.artifactSha256).map((path) => [path, sha256(readFileSync(resolve(repositoryRoot, path)))])
	);
	auditV1Inventory(v1Policy, currentHashes);
	auditManifestProjection(JSON.parse(readFileSync(resolve(repositoryRoot, predecessor.packagePath), "utf8")));
	auditSuccessorTopology(observeRepositoryTopology(base, head));
	if (gitText("status", "--porcelain=v1", "--untracked-files=no") !== "") fail("TRACKED_WORKTREE_DIRTY");
	auditPredecessorIdentity({
		checkerSha256,
		packageSha256: sha256(gitBlob(policy.phase0nGreenCommit, predecessor.packagePath)),
		policySha256,
		workflowSha256: sha256(gitBlob(policy.phase0nGreenCommit, predecessor.workflowPath)),
	});
	process.stdout.write("protocol-v3 numeric determinism successor freeze: PASS\n");
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
	main();
}
