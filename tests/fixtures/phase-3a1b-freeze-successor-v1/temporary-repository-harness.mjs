/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-param, jsdoc/require-returns */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const CONTROL_OWNER = "packages/protocol-v3/conformance/freeze-successor-v1";
const CONTROL_BUNDLE = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"].map(
	(file) => `${CONTROL_OWNER}/${file}`
);
const CONTROL_WORKFLOWS = Array.from({ length: 5 }, (_, index) => `.github/workflows/control-${index + 1}.yml`);
const CONTROL_LEGACY = Array.from({ length: 5 }, (_, index) => `legacy/artifact-${index + 1}.txt`);
const SUCCESSOR_CHECKER = `${CONTROL_OWNER}/check-freeze.mjs`;

function command(root, executable, args, options = {}) {
	return spawnSync(executable, args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...options.env },
		timeout: options.timeout ?? 60_000,
	});
}

function git(root, ...args) {
	const result = command(root, "git", args);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}

function put(root, path, bytes) {
	const target = resolve(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}

function commit(root, message, allowEmpty = false) {
	git(root, "add", "-A");
	const args = ["commit", "-q", "-m", message];
	if (allowEmpty) args.push("--allow-empty");
	git(root, ...args);
	return git(root, "rev-parse", "HEAD");
}

function initializeControl(repositoryRoot) {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-control-"));
	git(root, "init", "-q");
	git(root, "config", "user.name", "freeze-successor-control");
	git(root, "config", "user.email", "freeze-successor@example.invalid");
	for (const path of CONTROL_LEGACY) put(root, path, "legacy\n");
	for (const path of CONTROL_WORKFLOWS) put(root, path, "legacy\n");
	const base = commit(root, "base");
	const checker = readFileSync(
		resolve(repositoryRoot, "tests/fixtures/phase-3a1b-freeze-successor-v1/controlled-freeze-successor.mjs")
	);
	return { base, checker, root };
}

function installControlBundle(state, count = CONTROL_BUNDLE.length) {
	for (const [index, path] of CONTROL_BUNDLE.entries()) {
		if (index >= count) break;
		put(state.root, path, index === 0 ? state.checker : "controlled\n");
	}
}

function installControlWorkflows(state, count = CONTROL_WORKFLOWS.length) {
	for (const [index, path] of CONTROL_WORKFLOWS.entries()) if (index < count) put(state.root, path, "successor\n");
}

function executeControl(state, upstream) {
	const result = command(state.root, process.execPath, [resolve(state.root, SUCCESSOR_CHECKER), upstream], {
		env: { FREEZE_SUCCESSOR_CONTROL_ROOT: state.root },
	});
	return { output: `${result.stdout}\n${result.stderr}`, status: result.status, signal: result.signal };
}

function syntheticMerge(state, upstream, prHead) {
	const tree = git(state.root, "rev-parse", `${prHead}^{tree}`);
	const merge = git(state.root, "commit-tree", tree, "-p", upstream, "-p", prHead, "-m", "synthetic merge");
	git(state.root, "reset", "--hard", "-q", merge);
	return merge;
}

/** Executes linear and GitHub-style bootstrap/descendant positives against the fixture-owned control checker. */
export function runControlledPositive(repositoryRoot, topology, mode) {
	const state = initializeControl(repositoryRoot);
	try {
		installControlBundle(state);
		installControlWorkflows(state);
		const bootstrap = commit(state.root, "atomic bootstrap");
		let upstream = state.base;
		if (mode === "descendant") {
			upstream = bootstrap;
			put(state.root, "unrelated.txt", "descendant\n");
			commit(state.root, "unrelated descendant");
		}
		if (topology === "merge") {
			const prHead = git(state.root, "rev-parse", "HEAD");
			git(state.root, "checkout", "-q", "--detach", upstream);
			put(state.root, "upstream-only.txt", "upstream\n");
			const upstreamTip = commit(state.root, "upstream tip");
			syntheticMerge(state, upstreamTip, prHead);
			upstream = upstreamTip;
		}
		return { ...executeControl(state, upstream), cleanupPath: state.root };
	} finally {
		rmSync(state.root, { force: true, recursive: true });
	}
}

/** Executes surgical harness mutants against the fixture-owned checker. */
export function runControlledMutation(repositoryRoot, mutation) {
	const state = initializeControl(repositoryRoot);
	try {
		if (mutation === "partial-base") {
			installControlBundle(state, 2);
			const partial = commit(state.root, "partial owner base");
			installControlBundle(state);
			installControlWorkflows(state);
			commit(state.root, "complete candidate");
			return executeControl(state, partial);
		}
		installControlBundle(state);
		if (mutation === "bundle-with-old-workflows") {
			commit(state.root, "bundle only");
			return executeControl(state, state.base);
		}
		installControlWorkflows(state);
		if (mutation === "future-workflows-with-partial-bundle") {
			rmSync(resolve(state.root, CONTROL_BUNDLE[3]));
			commit(state.root, "routing with partial owner");
			return { ...executeControl(state, state.base), splitCause: "owner" };
		}
		if (mutation === "split-atomic") {
			for (const path of CONTROL_WORKFLOWS) put(state.root, path, "legacy\n");
			commit(state.root, "bundle first");
			installControlWorkflows(state);
			commit(state.root, "routing second");
			return executeControl(state, state.base);
		}
		if (mutation === "transient-revert") {
			commit(state.root, "bootstrap");
			put(state.root, CONTROL_WORKFLOWS[0], "drift\n");
			commit(state.root, "transient drift");
			put(state.root, CONTROL_WORKFLOWS[0], "successor\n");
			commit(state.root, "terminal revert");
			return executeControl(state, state.base);
		}
		if (mutation === "symlink-owner") {
			rmSync(resolve(state.root, CONTROL_BUNDLE[3]));
			symlinkSync("profile.json", resolve(state.root, CONTROL_BUNDLE[3]));
		}
		commit(state.root, "mutated candidate");
		return executeControl(state, state.base);
	} finally {
		rmSync(state.root, { force: true, recursive: true });
	}
}

/** Executes the five genuine historical checker baselines in isolated native Git clones. */
export async function runHistoricalBaselines(repositoryRoot, predecessors) {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-history-"));
	try {
		const cloned = command(root, "git", ["clone", "--shared", "--no-checkout", repositoryRoot, "repository"]);
		if (cloned.status !== 0) throw new Error(`${cloned.stdout}\n${cloned.stderr}`);
		const clone = resolve(root, "repository");
		git(clone, "config", "advice.detachedHead", "false");
		const results = [];
		for (const predecessor of predecessors) {
			git(clone, "checkout", "-q", "--detach", predecessor.baseline);
			const parents = git(clone, "rev-list", "--parents", "-n", "1", predecessor.baseline).split(" ");
			const tree = git(clone, "rev-parse", `${predecessor.baseline}^{tree}`);
			const result = command(clone, process.execPath, [resolve(clone, predecessor.checker), predecessor.checkerBase], {
				env: { [predecessor.environment]: clone },
			});
			results.push({
				id: predecessor.id,
				output: `${result.stdout}\n${result.stderr}`,
				parent: parents.length === 2 ? parents[1] : undefined,
				signal: result.signal,
				status: result.status,
				tree,
			});
			await yieldToEventLoop();
		}
		return results;
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

/** Returns exact current identity evidence used to form the complete 58/5/(52+1) sweep. */
export function governedInventory(repositoryRoot, policyPaths) {
	const ordered = [];
	for (const path of policyPaths) {
		const policy = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
		ordered.push(...policy.protectedArtifacts);
	}
	return [...new Set(ordered)];
}

/** Repository lane selector. It never falls back to the controlled checker. */
export function repositoryCandidateAvailability(repositoryRoot) {
	const checker = resolve(repositoryRoot, SUCCESSOR_CHECKER);
	return { available: readFileIfRegular(checker), checker };
}

const REPOSITORY_CATEGORY_MUTATIONS = Object.freeze([
	"partial-owner-base",
	"split-owner-routing",
	"transient-revert",
	"base-only-validation",
	"current-only-validation",
	"merge-only-governed-change",
	"sibling-upstream",
	"arbitrary-old-upstream",
	"non-unique-merge-base",
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
]);
const REPOSITORY_POSITIVE_CASES = Object.freeze([
	"linear:bootstrap",
	"merge:bootstrap",
	"linear:descendant",
	"merge:descendant",
]);

/** Returns the exact complete genuine-candidate rejection plan. */
export function repositoryMutationPlan(fixedAnchorPaths, gossipPath) {
	return [
		...fixedAnchorPaths.map((path) => `immutable:${path}`),
		`gossip-old:${gossipPath}`,
		`gossip-current:${gossipPath}`,
		`gossip-postbootstrap:${gossipPath}`,
		...Array.from({ length: 4 }, (_, index) => `workflow-count:${index + 1}`),
		...REPOSITORY_CATEGORY_MUTATIONS,
	];
}

/** Returns the exact ordered positive and negative plans for independently bounded repository cases. */
export function repositoryCandidatePlan(repositoryRoot, contract) {
	const inventory = governedInventory(
		repositoryRoot,
		contract.predecessors.map(({ policy }) => policy)
	);
	const workflows = new Set(contract.workflowIdentities.map(({ path }) => path));
	const immutable = inventory.filter((path) => !workflows.has(path));
	const fixedAnchor = immutable.filter((path) => path !== contract.gossipOracleTransition.path);
	return {
		fixedAnchor,
		immutable,
		inventory,
		mutationNames: repositoryMutationPlan(fixedAnchor, contract.gossipOracleTransition.path),
		positiveNames: REPOSITORY_POSITIVE_CASES,
	};
}

function copyCandidate(repositoryRoot, root, contract, workflowCount = contract.workflowIdentities.length) {
	cpSync(resolve(repositoryRoot, contract.ownerDirectory), resolve(root, contract.ownerDirectory), { recursive: true });
	for (const [index, identity] of contract.workflowIdentities.entries()) {
		if (index < workflowCount) put(root, identity.path, readFileSync(resolve(repositoryRoot, identity.path)));
	}
}

function executeRepositoryCandidate(root, contract, upstream) {
	const result = command(root, process.execPath, [
		resolve(root, contract.ownerDirectory, "check-freeze.mjs"),
		upstream,
	]);
	return { output: `${result.stdout}\n${result.stderr}`, signal: result.signal, status: result.status };
}

function cloneCandidateRepository(repositoryRoot, contract) {
	const parent = mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-candidate-"));
	const cloned = command(parent, "git", ["clone", "--shared", "--no-checkout", repositoryRoot, "repository"]);
	if (cloned.status !== 0) {
		rmSync(parent, { force: true, recursive: true });
		throw new Error(`${cloned.stdout}\n${cloned.stderr}`);
	}
	const root = resolve(parent, "repository");
	git(root, "config", "user.name", "freeze-successor-candidate-control");
	git(root, "config", "user.email", "freeze-successor-candidate@example.invalid");
	git(root, "checkout", "-q", "--detach", contract.redBase);
	return { parent, root };
}

function resetCandidate(state, contract) {
	git(state.root, "reset", "--hard", "-q", contract.redBase);
	git(state.root, "clean", "-ffd", "-q");
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function installGossipOracleTransition(repositoryRoot, state, contract, mutate) {
	const transition = contract.gossipOracleTransition;
	if (git(state.root, "rev-parse", "HEAD") !== transition.parent) throw new Error("gossip transition parent differs");
	if (git(state.root, "rev-parse", `HEAD:${transition.path}`) !== transition.oldBlob)
		throw new Error("gossip transition old blob differs");
	const source = readFileSync(resolve(repositoryRoot, transition.path));
	if (sha256Bytes(source) !== transition.currentSha256) throw new Error("gossip transition current SHA-256 differs");
	put(state.root, transition.path, source);
	if (typeof mutate === "function") mutate(state.root, transition.path);
	const blob = git(state.root, "hash-object", transition.path);
	if (mutate === undefined && blob !== transition.currentBlob)
		throw new Error("gossip transition current blob differs");
	return commit(state.root, "correct gossip successor routing oracle");
}

function append(root, path, text = "\nmutation\n") {
	put(root, path, Buffer.concat([readFileSync(resolve(root, path)), Buffer.from(text)]));
}

function replaceRequired(root, path, before, after = "0".repeat(before.length)) {
	const source = readFileSync(resolve(root, path), "utf8");
	if (!source.includes(before)) throw new Error(`candidate fixture lacks required value ${before} in ${path}`);
	put(root, path, source.replace(before, after));
}

function addUnhashedPolicyEntry(root, path) {
	const target = resolve(root, path);
	const policy = JSON.parse(readFileSync(target, "utf8"));
	if (!Array.isArray(policy.protectedArtifacts)) throw new Error("candidate policy lacks protectedArtifacts");
	const extra = "tests/fixtures/freeze-successor-unhashed-extra.txt";
	policy.protectedArtifacts.push(extra);
	put(root, extra, "unhashed\n");
	writeFileSync(target, `${JSON.stringify(policy, null, 2)}\n`);
}

function createCandidateCommit(repositoryRoot, state, contract, options = {}) {
	copyCandidate(repositoryRoot, state.root, contract, options.workflowCount);
	if (typeof options.mutate === "function") options.mutate(state.root);
	return commit(state.root, options.message ?? "candidate bootstrap");
}

function runLinearPositive(repositoryRoot, state, contract, mode) {
	resetCandidate(state, contract);
	const correctedBase = installGossipOracleTransition(repositoryRoot, state, contract);
	const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
	let upstream = correctedBase;
	if (mode === "descendant") {
		upstream = bootstrap;
		put(state.root, "unrelated-descendant.txt", "unrelated\n");
		commit(state.root, "unrelated descendant");
	}
	return executeRepositoryCandidate(state.root, contract, upstream);
}

function runMergePositive(repositoryRoot, state, contract, mode) {
	resetCandidate(state, contract);
	const correctedBase = installGossipOracleTransition(repositoryRoot, state, contract);
	const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
	let branchPoint = correctedBase;
	let prHead = bootstrap;
	if (mode === "descendant") {
		branchPoint = bootstrap;
		put(state.root, "pr-unrelated.txt", "pr\n");
		prHead = commit(state.root, "unrelated pr descendant");
	}
	git(state.root, "checkout", "-q", "--detach", branchPoint);
	put(state.root, "upstream-unrelated.txt", "upstream\n");
	const upstream = commit(state.root, "upstream target");
	syntheticMerge(state, upstream, prHead);
	return executeRepositoryCandidate(state.root, contract, upstream);
}

function runNamedPositive(repositoryRoot, state, contract, name) {
	const [topology, mode] = name.split(":");
	if (!REPOSITORY_POSITIVE_CASES.includes(name)) throw new Error(`unknown repository positive: ${name}`);
	return topology === "linear"
		? runLinearPositive(repositoryRoot, state, contract, mode)
		: runMergePositive(repositoryRoot, state, contract, mode);
}

function runCandidateMutation(repositoryRoot, state, contract, mutation, immutablePaths) {
	resetCandidate(state, contract);
	if (mutation.startsWith("gossip-old:")) {
		createCandidateCommit(repositoryRoot, state, contract);
		const omitted = executeRepositoryCandidate(state.root, contract, contract.redBase);
		if (omitted.status === 0 && omitted.signal === null) return omitted;
		resetCandidate(state, contract);
		append(state.root, contract.gossipOracleTransition.path);
		commit(state.root, "transient pre-transition gossip oracle drift");
		put(
			state.root,
			contract.gossipOracleTransition.path,
			readFileSync(resolve(repositoryRoot, contract.gossipOracleTransition.path))
		);
		commit(state.root, "terminal exact gossip oracle bytes without signed transition");
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, contract.redBase);
	}
	if (mutation.startsWith("gossip-current:")) {
		const wrongBase = installGossipOracleTransition(repositoryRoot, state, contract, (root, path) =>
			append(root, path)
		);
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, wrongBase);
	}
	const correctedBase = installGossipOracleTransition(repositoryRoot, state, contract);
	if (mutation.startsWith("gossip-postbootstrap:")) {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, contract.gossipOracleTransition.path);
		commit(state.root, "post-bootstrap gossip oracle drift");
		return executeRepositoryCandidate(state.root, contract, bootstrap);
	}
	if (mutation.startsWith("immutable:")) {
		const path = mutation.slice("immutable:".length);
		createCandidateCommit(repositoryRoot, state, contract, { mutate: (root) => append(root, path) });
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation.startsWith("workflow-count:")) {
		const count = Number(mutation.slice("workflow-count:".length));
		createCandidateCommit(repositoryRoot, state, contract, { workflowCount: count });
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "partial-owner-base") {
		const ownerFiles = contract.ownerFiles.slice(0, 2);
		for (const file of ownerFiles) put(state.root, `${contract.ownerDirectory}/${file}`, "partial\n");
		const partial = commit(state.root, "partial successor base");
		copyCandidate(repositoryRoot, state.root, contract);
		commit(state.root, "complete successor candidate");
		return executeRepositoryCandidate(state.root, contract, partial);
	}
	if (mutation === "split-owner-routing") {
		cpSync(resolve(repositoryRoot, contract.ownerDirectory), resolve(state.root, contract.ownerDirectory), {
			recursive: true,
		});
		commit(state.root, "owner first");
		for (const identity of contract.workflowIdentities)
			put(state.root, identity.path, readFileSync(resolve(repositoryRoot, identity.path)));
		commit(state.root, "routing second");
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "transient-revert") {
		createCandidateCommit(repositoryRoot, state, contract);
		const path = contract.workflowIdentities[0].path;
		append(state.root, path);
		commit(state.root, "transient governed drift");
		put(state.root, path, readFileSync(resolve(repositoryRoot, path)));
		commit(state.root, "terminal governed revert");
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "staged-protected-drift" || mutation === "unstaged-protected-drift") {
		createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, immutablePaths[0]);
		if (mutation === "staged-protected-drift") git(state.root, "add", immutablePaths[0]);
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "post-bootstrap-owner-drift" || mutation === "post-bootstrap-workflow-drift") {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		const path =
			mutation === "post-bootstrap-owner-drift"
				? `${contract.ownerDirectory}/spec.md`
				: contract.workflowIdentities[0].path;
		append(state.root, path);
		commit(state.root, mutation);
		return executeRepositoryCandidate(state.root, contract, bootstrap);
	}
	if (mutation === "base-only-validation") {
		createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, immutablePaths[0]);
		commit(state.root, "current-only immutable drift");
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "current-only-validation") {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, immutablePaths[0]);
		commit(state.root, "post-bootstrap immutable drift");
		return executeRepositoryCandidate(state.root, contract, bootstrap);
	}
	if (mutation === "merge-only-governed-change") {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		const prHead = bootstrap;
		git(state.root, "checkout", "-q", "--detach", correctedBase);
		put(state.root, "upstream-only.txt", "upstream\n");
		const upstream = commit(state.root, "upstream tip");
		syntheticMerge(state, upstream, prHead);
		append(state.root, contract.workflowIdentities[0].path);
		git(state.root, "add", contract.workflowIdentities[0].path);
		git(state.root, "commit", "--amend", "-q", "--no-edit");
		return executeRepositoryCandidate(state.root, contract, upstream);
	}
	if (mutation === "arbitrary-old-upstream") {
		createCandidateCommit(repositoryRoot, state, contract);
		const older = git(state.root, "rev-parse", `${correctedBase}^`);
		return executeRepositoryCandidate(state.root, contract, older);
	}
	if (mutation === "sibling-upstream") {
		createCandidateCommit(repositoryRoot, state, contract);
		const tree = git(state.root, "rev-parse", `${correctedBase}^{tree}`);
		const parent = git(state.root, "rev-parse", `${correctedBase}^`);
		const sibling = git(state.root, "commit-tree", tree, "-p", parent, "-m", "sibling upstream");
		return executeRepositoryCandidate(state.root, contract, sibling);
	}
	if (mutation === "non-unique-merge-base") {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		const tree = git(state.root, "rev-parse", `${bootstrap}^{tree}`);
		const left = git(state.root, "commit-tree", tree, "-p", bootstrap, "-m", "left");
		const right = git(state.root, "commit-tree", tree, "-p", bootstrap, "-m", "right");
		const head = git(state.root, "commit-tree", tree, "-p", left, "-p", right, "-m", "head criss-cross");
		const upstream = git(state.root, "commit-tree", tree, "-p", right, "-p", left, "-m", "upstream criss-cross");
		git(state.root, "reset", "--hard", "-q", head);
		return executeRepositoryCandidate(state.root, contract, upstream);
	}
	const profile = `${contract.ownerDirectory}/profile.json`;
	const policy = `${contract.ownerDirectory}/freeze-policy.json`;
	const firstWorkflow = contract.workflowIdentities[0].path;
	const mutations = {
		"retained-legacy-checker": (root) =>
			append(root, contract.workflowIdentities[4].path, `\nnode ${contract.predecessors[4].checker} "$UPSTREAM_SHA"\n`),
		"omitted-current-semantic-hash": (root) =>
			replaceRequired(root, profile, contract.historicalTransitions[0].commits.at(-1)[1]),
		"accepted-stale-policy-value": (root) =>
			replaceRequired(
				root,
				profile,
				contract.historicalTransitions[2].commits.at(-1)[1],
				contract.latentGossipBinding.staleAuthorHash
			),
		"omitted-latent-gossip-binding": (root) => replaceRequired(root, profile, contract.latentGossipBinding.sha256),
		"wrong-baseline": (root) => replaceRequired(root, profile, contract.predecessors[0].baseline),
		"wrong-transition": (root) => replaceRequired(root, profile, contract.historicalTransitions[0].commits[1][0]),
		"conflated-gossip-parent-base": (root) =>
			replaceRequired(root, profile, contract.predecessors[3].checkerBase, contract.predecessors[3].directParent),
		"extra-unhashed-exception": (root) => addUnhashedPolicyEntry(root, policy),
		"sixth-thawed-path": (root) => append(root, immutablePaths[0]),
		"changed-trigger": (root) => replaceRequired(root, firstWorkflow, "pull_request", "push       "),
		"changed-permission": (root) => replaceRequired(root, firstWorkflow, "contents: read", "contents: write"),
		"changed-checkout-ref": (root) => replaceRequired(root, firstWorkflow, "github.sha", "github.ref"),
		"changed-timeout": (root) => replaceRequired(root, firstWorkflow, "timeout-minutes: 10", "timeout-minutes: 11"),
		"changed-job-identity": (root) =>
			replaceRequired(root, firstWorkflow, contract.workflowIdentities[0].jobKey, "renamed-freeze-successor-job"),
		"semantic-equivalent-workflow-bytes": (root) =>
			put(
				root,
				firstWorkflow,
				readFileSync(
					resolve(
						repositoryRoot,
						"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/semantically-equivalent.yml"
					)
				)
			),
		"missing-owner-path": (root) => rmSync(resolve(root, contract.ownerDirectory, contract.ownerFiles[3])),
		"extra-owner-entry": (root) => put(root, `${contract.ownerDirectory}/extra.txt`, "extra\n"),
		"executable-owner": (root) => {
			const path = `${contract.ownerDirectory}/${contract.ownerFiles[3]}`;
			chmodSync(resolve(root, path), 0o755);
		},
		"gitlink-owner": (root) => {
			const path = resolve(root, contract.ownerDirectory, contract.ownerFiles[3]);
			rmSync(path);
			mkdirSync(path);
			git(path, "init", "-q");
			git(path, "config", "user.name", "nested-control");
			git(path, "config", "user.email", "nested@example.invalid");
			put(path, "entry.txt", "nested\n");
			commit(path, "nested");
		},
		"tree-owner": (root) => {
			const path = resolve(root, contract.ownerDirectory, contract.ownerFiles[3]);
			rmSync(path);
			put(path, "entry.txt", "tree\n");
		},
		"symlink-owner": (root) => {
			const path = resolve(root, contract.ownerDirectory, contract.ownerFiles[3]);
			rmSync(path);
			symlinkSync("profile.json", path);
		},
	};
	const mutate = mutations[mutation];
	if (mutate === undefined) throw new Error(`unknown repository mutation: ${mutation}`);
	createCandidateCommit(repositoryRoot, state, contract, { mutate });
	return executeRepositoryCandidate(state.root, contract, correctedBase);
}

/** Runs one independently bounded exact repository partition with no controlled fallback. */
export async function runRepositoryCandidatePartition(repositoryRoot, contract, selection) {
	const availability = repositoryCandidateAvailability(repositoryRoot);
	if (!availability.available) return { available: false, checker: availability.checker };
	const { fixedAnchor, immutable, inventory, mutationNames, positiveNames } = repositoryCandidatePlan(
		repositoryRoot,
		contract
	);
	if (new Set(selection.positiveNames).size !== selection.positiveNames.length)
		throw new Error("duplicate repository positive selection");
	if (new Set(selection.mutationNames).size !== selection.mutationNames.length)
		throw new Error("duplicate repository mutation selection");
	for (const name of selection.positiveNames)
		if (!positiveNames.includes(name)) throw new Error(`unknown repository positive selection: ${name}`);
	for (const name of selection.mutationNames)
		if (!mutationNames.includes(name)) throw new Error(`unknown repository mutation selection: ${name}`);
	const state = cloneCandidateRepository(repositoryRoot, contract);
	try {
		const positives = [];
		for (const name of selection.positiveNames) {
			positives.push({ name, result: runNamedPositive(repositoryRoot, state, contract, name) });
			await yieldToEventLoop();
		}
		const negatives = [];
		for (const name of selection.mutationNames) {
			negatives.push({ name, result: runCandidateMutation(repositoryRoot, state, contract, name, fixedAnchor) });
			await yieldToEventLoop();
		}
		return { available: true, immutable, inventory, negatives, positives };
	} finally {
		rmSync(state.parent, { force: true, recursive: true });
	}
}

function readFileIfRegular(path) {
	try {
		return readFileSync(path).byteLength > 0;
	} catch {
		return false;
	}
}

export const controlledPaths = Object.freeze({
	bundle: CONTROL_BUNDLE,
	legacy: CONTROL_LEGACY,
	workflows: CONTROL_WORKFLOWS,
});
