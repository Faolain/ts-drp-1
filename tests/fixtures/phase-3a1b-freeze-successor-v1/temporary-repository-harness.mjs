/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-param, jsdoc/require-returns */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
		maxBuffer: 4 * 1024 * 1024,
		timeout: options.timeout ?? 60_000,
	});
}

function commandAsync(root, executable, args, options = {}) {
	return new Promise((resolvePromise) => {
		execFile(
			executable,
			args,
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, ...options.env },
				maxBuffer: 4 * 1024 * 1024,
				timeout: options.timeout ?? 60_000,
			},
			(error, stdout, stderr) => {
				resolvePromise({
					error,
					signal: error?.signal ?? null,
					status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
					stderr,
					stdout,
				});
			}
		);
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

/** Returns exact current identity evidence used to form the complete 58/5/(50+3) sweep. */
export function governedInventory(repositoryRoot, policyPaths) {
	const ordered = [];
	for (const path of policyPaths) {
		const policy = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
		ordered.push(...policy.protectedArtifacts);
	}
	return [...new Set(ordered)];
}

function exactParents(root, revision) {
	return git(root, "rev-list", "--parents", "-n", "1", revision).split(" ").slice(1);
}

function exactChangedPaths(root, parent, child) {
	return git(root, "diff", "--name-only", parent, child).split("\n").filter(Boolean).sort();
}

function treeEntry(root, revision, path) {
	const result = command(root, "git", ["ls-tree", revision, "--", path]);
	if (result.status !== 0 || result.stdout.trim() === "") return undefined;
	const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t/u.exec(result.stdout.trim());
	return match === null ? undefined : { mode: match[1], object: match[3], type: match[2] };
}

function treeEntries(root, revision, paths) {
	const result = command(root, "git", ["ls-tree", revision, "--", ...paths]);
	if (result.status !== 0 || result.signal !== null) throw new Error(`cannot inspect ${revision}`);
	const byPath = new Map();
	for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
		const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/u.exec(line);
		if (match !== null) byPath.set(match[4], { mode: match[1], object: match[3], type: match[2] });
	}
	return paths.map((path) => [path, byPath.get(path)]);
}

function isAncestor(root, ancestor, descendant) {
	const result = command(root, "git", ["merge-base", "--is-ancestor", ancestor, descendant]);
	return result.status === 0 && result.signal === null;
}

function predecessorOracleTransitionCommits(repositoryRoot, contract) {
	return git(
		repositoryRoot,
		"log",
		"--format=%H",
		"--reverse",
		`${contract.predecessorOracleTransition.parent}..HEAD`,
		"--",
		...contract.predecessorOracleTransition.changedPaths
	)
		.split("\n")
		.filter(Boolean);
}

function revisionBytes(repositoryRoot, revision, path) {
	const result = spawnSync("git", ["show", `${revision}:${path}`], { cwd: repositoryRoot, encoding: null });
	return result.status === 0 && result.signal === null ? result.stdout : undefined;
}

/** Authenticates the exact subordinate-owner RED and its two governed identities. */
export function predecessorOracleTransitionEvidence(repositoryRoot, contract) {
	const commits = predecessorOracleTransitionCommits(repositoryRoot, contract);
	const commit = commits.length === 1 ? commits[0] : undefined;
	const parents = commit === undefined ? [] : exactParents(repositoryRoot, commit);
	const changedPaths = commit === undefined ? [] : exactChangedPaths(repositoryRoot, parents[0], commit);
	const identities = contract.predecessorOracleTransition.governed.map((identity) => {
		const oldBytes = revisionBytes(repositoryRoot, contract.predecessorOracleTransition.parent, identity.path);
		const currentBytes = commit === undefined ? undefined : revisionBytes(repositoryRoot, commit, identity.path);
		return {
			currentBlob: commit === undefined ? undefined : git(repositoryRoot, "rev-parse", `${commit}:${identity.path}`),
			currentSha256: currentBytes === undefined ? undefined : sha256Bytes(currentBytes),
			id: identity.id,
			oldBlob: git(repositoryRoot, "rev-parse", `${contract.predecessorOracleTransition.parent}:${identity.path}`),
			oldSha256: oldBytes === undefined ? undefined : sha256Bytes(oldBytes),
			path: identity.path,
		};
	});
	const valid =
		commit !== undefined &&
		parents.length === 1 &&
		parents[0] === contract.predecessorOracleTransition.parent &&
		JSON.stringify(changedPaths) === JSON.stringify([...contract.predecessorOracleTransition.changedPaths].sort()) &&
		identities.every((actual, index) => {
			const expected = contract.predecessorOracleTransition.governed[index];
			return (
				actual.path === expected.path &&
				actual.oldBlob === expected.oldBlob &&
				actual.oldSha256 === expected.oldSha256 &&
				actual.currentBlob === expected.currentBlob &&
				actual.currentSha256 === expected.currentSha256
			);
		});
	return { changedPaths, commit, commits, identities, parents, valid };
}

function correctionCommits(repositoryRoot, contract, transitionCommit) {
	return git(
		repositoryRoot,
		"log",
		"--format=%H",
		"--reverse",
		`${transitionCommit ?? contract.predecessorOracleTransition.parent}..HEAD`,
		"--",
		...contract.correctionPaths
	)
		.split("\n")
		.filter(Boolean);
}

/**
 * Authenticates the signed external/PR lineage and returns the one causal RED gate.
 * Candidate mutants must not run unless this result is ready.
 */
export function repositoryCandidateReadiness(repositoryRoot, contract) {
	const inventory = governedInventory(
		repositoryRoot,
		contract.predecessors.map(({ policy }) => policy)
	);
	const governed = [...contract.ownerFiles.map((file) => `${contract.ownerDirectory}/${file}`), ...inventory];
	const externalParents = exactParents(repositoryRoot, contract.externalBase.commit);
	const externalAbsent = governed.filter(
		(path) => treeEntry(repositoryRoot, contract.externalBase.commit, path) === undefined
	);
	const provisionalEntries = governed.map((path) => [
		path,
		treeEntry(repositoryRoot, contract.provisionalInstall.commit, path),
	]);
	const originalInstall = exactChangedPaths(
		repositoryRoot,
		contract.provisionalInstall.parent,
		contract.provisionalInstall.commit
	);
	const transition = predecessorOracleTransitionEvidence(repositoryRoot, contract);
	const corrections = correctionCommits(repositoryRoot, contract, transition.commit);
	const topologyValid =
		git(repositoryRoot, "rev-parse", `${contract.externalBase.commit}^{tree}`) === contract.externalBase.tree &&
		JSON.stringify(externalParents) === JSON.stringify(contract.externalBase.parents) &&
		git(repositoryRoot, "rev-parse", `${contract.fixedAnchor.commit}^{tree}`) === contract.fixedAnchor.tree &&
		git(repositoryRoot, "rev-parse", `${contract.redBase}^{tree}`) === contract.redBaseTree &&
		git(repositoryRoot, "rev-parse", `${contract.redBase}^`) === contract.redBaseParent &&
		isAncestor(repositoryRoot, contract.externalBase.commit, contract.fixedAnchor.commit) &&
		isAncestor(repositoryRoot, contract.fixedAnchor.commit, contract.redBase) &&
		git(repositoryRoot, "rev-parse", `${contract.gossipOracleTransition.commit}^`) ===
			contract.gossipOracleTransition.parent &&
		git(repositoryRoot, "rev-parse", `${contract.gossipOracleTransition.commit}^{tree}`) ===
			contract.gossipOracleTransition.tree &&
		contract.provisionalInstall.parent === contract.gossipOracleTransition.commit &&
		git(repositoryRoot, "rev-parse", `${contract.provisionalInstall.commit}^`) === contract.provisionalInstall.parent &&
		git(repositoryRoot, "rev-parse", `${contract.provisionalInstall.commit}^{tree}`) ===
			contract.provisionalInstall.tree &&
		git(repositoryRoot, "rev-parse", `${contract.predecessorOracleTransition.parent}^{tree}`) ===
			contract.predecessorOracleTransition.parentTree &&
		isAncestor(repositoryRoot, contract.provisionalInstall.commit, contract.predecessorOracleTransition.parent);
	const originalInstallValid =
		JSON.stringify(originalInstall) === JSON.stringify([...contract.originalInstallPaths].sort());
	let schemaValid = false;
	try {
		const policy = JSON.parse(readFileSync(resolve(repositoryRoot, contract.ownerDirectory, "freeze-policy.json")));
		const profile = JSON.parse(readFileSync(resolve(repositoryRoot, contract.ownerDirectory, "profile.json")));
		schemaValid =
			policy.schemaVersion === contract.expectedPolicySchemaVersion &&
			profile.schemaVersion === contract.expectedProfileSchemaVersion;
	} catch {
		schemaValid = false;
	}
	let correctionValid = false;
	let correction;
	if (corrections.length === 1) {
		correction = corrections[0];
		const parents = exactParents(repositoryRoot, correction);
		correctionValid =
			parents.length === 1 &&
			parents[0] === transition.commit &&
			JSON.stringify(exactChangedPaths(repositoryRoot, parents[0], correction)) ===
				JSON.stringify([...contract.correctionPaths].sort());
	}
	const ready =
		topologyValid &&
		externalAbsent.length === governed.length &&
		governed.length === 62 &&
		originalInstallValid &&
		provisionalEntries.every(([, entry]) => entry?.mode === "100644" && entry.type === "blob") &&
		schemaValid &&
		transition.valid &&
		correctionValid;
	return {
		code: ready ? "READY" : transition.valid ? "EXACT_SIX_CORRECTION_ABSENT" : "PREDECESSOR_ORACLE_TRANSITION_ABSENT",
		correction,
		correctionValid,
		externalAbsent,
		governed,
		originalInstall,
		originalInstallValid,
		provisionalEntries,
		ready,
		schemaValid,
		topologyValid,
		transition,
	};
}

function rawCommand(root, executable, args, options = {}) {
	return spawnSync(executable, args, {
		cwd: root,
		env: { ...process.env, ...options.env },
		encoding: null,
		timeout: options.timeout ?? 60_000,
	});
}

function isolatedClone(repositoryRoot, revision, label) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), `ts-drp-freeze-${label}-`)));
	const cloned = command(parent, "git", ["clone", "--shared", "--no-checkout", repositoryRoot, "repository"]);
	if (cloned.status !== 0) {
		rmSync(parent, { force: true, recursive: true });
		throw new Error(`${cloned.stdout}\n${cloned.stderr}`);
	}
	const root = resolve(parent, "repository");
	git(root, "checkout", "-q", "--detach", revision);
	return { parent, root };
}

function exactRootRun(repositoryRoot, evidence, revision, base, expectedStdout, label) {
	const state = isolatedClone(repositoryRoot, revision, label);
	try {
		const statusBefore = git(state.root, "status", "--porcelain=v1", "--untracked-files=all");
		const checkerBlob = git(state.root, "rev-parse", `HEAD:${evidence.checker}`);
		const checkerBytes = readFileSync(resolve(state.root, evidence.checker));
		const result = rawCommand(state.root, process.execPath, [resolve(state.root, evidence.checker), base], {
			env: { [evidence.environment]: state.root },
			timeout: 60_000,
		});
		return {
			checkerBlob,
			checkerSha256: sha256Bytes(checkerBytes),
			stderr: result.stderr,
			stdout: result.stdout,
			expectedStdout: Buffer.from(expectedStdout),
			signal: result.signal,
			status: result.status,
			statusBefore,
		};
	} finally {
		rmSync(state.parent, { force: true, recursive: true });
	}
}

/** Executes exact v2/v3 historical and clean-current evidence in four distinct clones. */
export async function runRootFreezeEvidence(repositoryRoot, contract) {
	const current = git(repositoryRoot, "rev-parse", "HEAD");
	const results = [];
	for (const evidence of contract.rootFreezeEvidence) {
		const authenticated = {
			baselineTree: git(repositoryRoot, "rev-parse", `${evidence.baseline}^{tree}`),
			checkerBaseTree: git(repositoryRoot, "rev-parse", `${evidence.checkerBase}^{tree}`),
			directParents: exactParents(repositoryRoot, evidence.baseline),
		};
		results.push({
			authenticated,
			id: `${evidence.id}:historical`,
			result: exactRootRun(
				repositoryRoot,
				evidence,
				evidence.baseline,
				evidence.checkerBase,
				evidence.historicalStdout,
				`${evidence.id}-historical`
			),
		});
		await yieldToEventLoop();
		results.push({
			authenticated,
			id: `${evidence.id}:current`,
			result: exactRootRun(
				repositoryRoot,
				evidence,
				current,
				evidence.baseline,
				evidence.currentStdout,
				`${evidence.id}-current`
			),
		});
		await yieldToEventLoop();
	}
	return results;
}

function protectedDriftPath(evidence) {
	return evidence.id === "protocol-v2-root"
		? "packages/protocol-v2/registry/field-registry.json"
		: "packages/protocol-v3/registry/registry-v1.json";
}

/** Proves each clean-current root run is load-bearing through the genuine successor boundary. */
export async function runCurrentRootDriftMutants(repositoryRoot, contract, readiness) {
	if (!readiness.ready) throw new Error("successor root drift evidence requires READY");
	const transitionCommit = readiness.transition.commit;
	if (typeof transitionCommit !== "string") {
		throw new Error("successor root drift evidence requires the authenticated predecessor transition");
	}
	const results = [];
	for (const evidence of contract.rootFreezeEvidence) {
		const state = cloneCandidateRepository(repositoryRoot, contract);
		try {
			const correction = createCandidateCommit(repositoryRoot, state, contract);
			const driftPath = protectedDriftPath(evidence);
			append(state.root, driftPath, "\nprotected drift\n");
			const drift = commit(state.root, `${evidence.id} protected post-correction drift`);
			const result = await executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
			results.push({
				correctionPaths: exactChangedPaths(state.root, transitionCommit, correction),
				driftPaths: exactChangedPaths(state.root, correction, drift),
				id: evidence.id,
				...result,
			});
		} finally {
			rmSync(state.parent, { force: true, recursive: true });
		}
		await yieldToEventLoop();
	}
	return results;
}

/** Proves NODE_OPTIONS preload presence alone is not a candidate rejection reason. */
export async function runRootChildPreloadPassthrough(repositoryRoot, contract, readiness) {
	if (!readiness.ready) throw new Error("successor preload passthrough requires READY");
	const state = cloneCandidateRepository(repositoryRoot, contract);
	try {
		const parent = git(state.root, "rev-parse", "HEAD");
		const correction = createCandidateCommit(repositoryRoot, state, contract);
		return {
			correctionPaths: exactChangedPaths(state.root, parent, correction),
			...(await executeWithRootChildPreload(
				repositoryRoot,
				state.root,
				contract,
				contract.externalBase.commit,
				"passthrough"
			)),
		};
	} finally {
		rmSync(state.parent, { force: true, recursive: true });
	}
}

function installControlledCensusEntry(root, path, index) {
	const target = resolve(root, path);
	mkdirSync(dirname(target), { recursive: true });
	if (index === 0) {
		symlinkSync("controlled-symlink-target", target);
		return;
	}
	if (index === 30) {
		put(root, `${path}/entry.txt`, "controlled tree\n");
		return;
	}
	if (index === 60) {
		mkdirSync(target);
		git(target, "init", "-q");
		git(target, "config", "user.name", "controlled-gitlink");
		git(target, "config", "user.email", "controlled-gitlink@example.invalid");
		put(target, "entry.txt", "controlled gitlink\n");
		commit(target, "controlled gitlink");
		return;
	}
	put(root, path, `controlled regular blob ${index + 1}\n`);
}

/**
 * Controlled diagnostic only: constructs genuine Git objects and asks the independent fixture checker to inspect them.
 * These rows are never candidate evidence or production mutation kills.
 */
export async function runControlledMixedCensusDiagnostics(repositoryRoot, paths) {
	if (paths.length !== 62 || new Set(paths).size !== 62) throw new Error("controlled census requires exact 62 paths");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-census-")));
	const checker = resolve(
		repositoryRoot,
		"tests/fixtures/phase-3a1b-freeze-successor-v1/controlled-freeze-successor.mjs"
	);
	try {
		git(root, "init", "-q");
		git(root, "config", "user.name", "controlled-census");
		git(root, "config", "user.email", "controlled-census@example.invalid");
		const rows = [];
		for (const [index, path] of paths.slice(0, 61).entries()) {
			installControlledCensusEntry(root, path, index);
			const revision = commit(root, `controlled census ${index + 1}`);
			const result = command(root, process.execPath, [checker, "--census", revision], {
				env: {
					FREEZE_SUCCESSOR_CONTROL_CENSUS_PATHS: JSON.stringify(paths),
					FREEZE_SUCCESSOR_CONTROL_ROOT: root,
				},
			});
			if (result.status !== 0 || result.signal !== null) {
				throw new Error(`controlled census ${index + 1}\n${result.stdout}\n${result.stderr}`);
			}
			const checkerEvidence = JSON.parse(result.stdout);
			const inspected = treeEntries(root, revision, paths);
			rows.push(
				Object.freeze({
					absent: Object.freeze(inspected.filter(([, entry]) => entry === undefined).map(([candidate]) => candidate)),
					checkerEvidence,
					checkerStdout: result.stdout,
					classification: "CONTROLLED_DIAGNOSTIC",
					count: index + 1,
					entries: Object.freeze(inspected.filter(([, entry]) => entry !== undefined)),
					present: Object.freeze(inspected.filter(([, entry]) => entry !== undefined).map(([candidate]) => candidate)),
					revision,
				})
			);
			await yieldToEventLoop();
		}
		return rows;
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

async function executeCurrentCandidate(repositoryRoot, contract, upstream, merge) {
	const current = git(repositoryRoot, "rev-parse", "HEAD");
	const state = isolatedClone(repositoryRoot, current, merge ? "candidate-merge" : "candidate-linear");
	try {
		if (merge) {
			const tree = git(state.root, "rev-parse", `${current}^{tree}`);
			const mergeCommit = git(
				state.root,
				"commit-tree",
				tree,
				"-p",
				upstream,
				"-p",
				current,
				"-m",
				"genuine GitHub merge-ref control"
			);
			git(state.root, "reset", "--hard", "-q", mergeCommit);
		}
		return await executeRepositoryCandidate(state.root, contract, upstream);
	} finally {
		rmSync(state.parent, { force: true, recursive: true });
	}
}

/** Runs the four genuine external/descendant topologies only after readiness succeeds. */
export async function runReadyCandidateTopologies(repositoryRoot, contract, readiness) {
	if (!readiness.ready || readiness.correction === undefined) {
		throw new Error("candidate topology execution requires READY evidence");
	}
	const cases = [
		["linear:external-empty", contract.externalBase.commit, false],
		["merge:external-empty", contract.externalBase.commit, true],
		["linear:descendant", readiness.correction, false],
		["merge:descendant", readiness.correction, true],
	];
	const results = [];
	for (const [name, upstream, merge] of cases) {
		results.push({ name, result: await executeCurrentCandidate(repositoryRoot, contract, upstream, merge) });
		await yieldToEventLoop();
	}
	return results;
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
const REPOSITORY_POSITIVE_CASES = Object.freeze([
	"linear:bootstrap",
	"merge:bootstrap",
	"linear:descendant",
	"merge:descendant",
]);

/** Returns the exact complete genuine-candidate rejection plan. */
export function repositoryMutationPlan(fixedAnchorPaths, gossipPath, predecessorPaths) {
	return [
		...fixedAnchorPaths.map((path) => `immutable:${path}`),
		`gossip-old:${gossipPath}`,
		`gossip-current:${gossipPath}`,
		`gossip-postbootstrap:${gossipPath}`,
		...predecessorPaths.flatMap((path) => [
			`predecessor-old:${path}`,
			`predecessor-omitted:${path}`,
			`predecessor-drift:${path}`,
		]),
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
	const transitioned = new Set([
		contract.gossipOracleTransition.path,
		...contract.predecessorOracleTransition.governed.map(({ path }) => path),
	]);
	const fixedAnchor = immutable.filter((path) => !transitioned.has(path));
	return {
		fixedAnchor,
		immutable,
		inventory,
		mutationNames: repositoryMutationPlan(
			fixedAnchor,
			contract.gossipOracleTransition.path,
			contract.predecessorOracleTransition.governed.map(({ path }) => path)
		),
		positiveNames: REPOSITORY_POSITIVE_CASES,
	};
}

/** Stable signed-law class expected from each post-readiness candidate failure. */
export function expectedCandidateFailure(mutation) {
	if (
		[
			"partial-owner-base",
			"split-owner-routing",
			"transient-revert",
			"post-bootstrap-owner-drift",
			"post-bootstrap-workflow-drift",
		].includes(mutation)
	) {
		return { class: "CORRECTION_HISTORY", marker: /correction|bootstrap|atomic|transition/iu };
	}
	if (mutation.startsWith("predecessor-omitted:")) {
		return { class: "CORRECTION_HISTORY", marker: /correction|bootstrap|atomic|transition/iu };
	}
	if (mutation.startsWith("predecessor-old:") || mutation.startsWith("predecessor-drift:")) {
		return { class: "GOVERNED_IDENTITY", marker: /identity|artifact|hash|transition/iu };
	}
	if (
		[
			"sibling-upstream",
			"arbitrary-old-upstream",
			"arbitrary-later-empty-upstream",
			"caller-selected-old-base",
			"upstream-after-anchor",
			"non-unique-merge-base",
		].includes(mutation)
	) {
		return { class: "EXTERNAL_TOPOLOGY", marker: /external|merge base|ancestry|upstream/iu };
	}
	if (["swapped-merge-parents", "merge-tree-drift", "merge-only-governed-change"].includes(mutation)) {
		return { class: "MERGE_TOPOLOGY", marker: /merge/iu };
	}
	if (
		[
			"provisional-v1-descendant",
			"other-wrong-identity-descendant",
			"wrong-type-descendant",
			"wrong-mode-descendant",
		].includes(mutation)
	) {
		return { class: "DESCENDANT_IDENTITY", marker: /descendant|base.*identity|governed.*identity/iu };
	}
	if (["v1-schema", "missing-schema", "dual-schema"].includes(mutation)) {
		return { class: "SCHEMA_IDENTITY", marker: /schema|profile identity|policy identity/iu };
	}
	if (
		mutation.includes("root") ||
		["copied-root-checker", "spoofed-root-stdout", "extra-root-stdout", "suppressed-root-exit"].includes(mutation)
	) {
		return { class: "ROOT_CHECKER_EVIDENCE", marker: /root|checker|stdout|child/iu };
	}
	if (
		[
			"retained-legacy-checker",
			"changed-trigger",
			"changed-permission",
			"changed-checkout-ref",
			"changed-timeout",
			"changed-job-identity",
			"semantic-equivalent-workflow-bytes",
		].includes(mutation)
	) {
		return { class: "WORKFLOW_ROUTING", marker: /workflow|routing|artifact hash/iu };
	}
	return { class: "GOVERNED_IDENTITY", marker: /identity|artifact|hash|dirty|owner|policy|gossip/iu };
}

function copyCandidateCorrection(repositoryRoot, root, contract) {
	for (const path of contract.correctionPaths) {
		const target = resolve(root, path);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(resolve(repositoryRoot, path), target);
	}
}

async function executeRepositoryCandidate(root, contract, upstream, options = {}) {
	const result = await commandAsync(
		root,
		process.execPath,
		[resolve(root, contract.ownerDirectory, "check-freeze.mjs"), upstream],
		options
	);
	return { output: `${result.stdout}\n${result.stderr}`, signal: result.signal, status: result.status };
}

async function executeWithRootChildPreload(repositoryRoot, root, contract, upstream, mutation) {
	const preloadRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-preload-")));
	const preload = resolve(preloadRoot, "register-root-checker-fault.mjs");
	const registrationOwner = pathToFileURL(
		resolve(repositoryRoot, "tests/fixtures/phase-3a1b-freeze-successor-v1/controlled-freeze-successor.mjs")
	).href;
	writeFileSync(
		preload,
		`import { registerRootCheckerFault } from ${JSON.stringify(registrationOwner)};\nregisterRootCheckerFault(${JSON.stringify(mutation)});\n`
	);
	try {
		return {
			cleanupPath: preloadRoot,
			...(await executeRepositoryCandidate(root, contract, upstream, {
				env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
			})),
		};
	} finally {
		rmSync(preloadRoot, { force: true, recursive: true });
	}
}

function cloneCandidateRepository(repositoryRoot, contract) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "ts-drp-freeze-successor-candidate-")));
	const cloned = command(parent, "git", ["clone", "--shared", "--no-checkout", repositoryRoot, "repository"]);
	if (cloned.status !== 0) {
		rmSync(parent, { force: true, recursive: true });
		throw new Error(`${cloned.stdout}\n${cloned.stderr}`);
	}
	const root = resolve(parent, "repository");
	git(root, "config", "user.name", "freeze-successor-candidate-control");
	git(root, "config", "user.email", "freeze-successor-candidate@example.invalid");
	const sourceHead = git(repositoryRoot, "rev-parse", "HEAD");
	const transition = predecessorOracleTransitionEvidence(repositoryRoot, contract);
	if (!transition.valid || transition.commit === undefined) {
		rmSync(parent, { force: true, recursive: true });
		throw new Error("candidate repository requires the authenticated predecessor-oracle transition");
	}
	git(root, "checkout", "-q", "--detach", transition.commit);
	return { parent, root, sourceHead, transitionCommit: transition.commit };
}

function resetCandidate(state) {
	git(state.root, "reset", "--hard", "-q", state.transitionCommit);
	git(state.root, "clean", "-ffd", "-q");
}

function createMutatedPredecessorTransition(repositoryRoot, state, contract, omittedPath) {
	git(state.root, "checkout", "-q", "--detach", contract.predecessorOracleTransition.parent);
	for (const path of contract.predecessorOracleTransition.changedPaths) {
		if (path === omittedPath) continue;
		const target = resolve(state.root, path);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(resolve(repositoryRoot, path), target);
	}
	const transition = commit(state.root, `omit predecessor transition ${omittedPath}`, true);
	const changedPaths = exactChangedPaths(state.root, contract.predecessorOracleTransition.parent, transition);
	const expected = contract.predecessorOracleTransition.changedPaths.filter((path) => path !== omittedPath).sort();
	if (JSON.stringify(changedPaths) !== JSON.stringify(expected)) {
		throw new Error(`omitted predecessor transition scope mismatch: ${omittedPath}`);
	}
	return transition;
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
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

function repinPolicyArtifacts(root, policyPath) {
	const target = resolve(root, policyPath);
	const policy = JSON.parse(readFileSync(target, "utf8"));
	if (policy.artifactSha256 === null || typeof policy.artifactSha256 !== "object") return;
	for (const path of Object.keys(policy.artifactSha256)) {
		try {
			policy.artifactSha256[path] = sha256Bytes(readFileSync(resolve(root, path)));
		} catch {
			// A missing-path mutant must remain missing; it cannot be re-pinned as a file.
		}
	}
	writeFileSync(target, `${JSON.stringify(policy, null, 2)}\n`);
}

function createCandidateCommit(repositoryRoot, state, contract, options = {}) {
	const parent = git(state.root, "rev-parse", "HEAD");
	copyCandidateCorrection(repositoryRoot, state.root, contract);
	if (typeof options.mutate === "function") options.mutate(state.root);
	repinPolicyArtifacts(state.root, `${contract.ownerDirectory}/freeze-policy.json`);
	const correction = commit(state.root, options.message ?? "exact six-path successor correction", true);
	if (
		options.allowDifferentScope !== true &&
		JSON.stringify(exactChangedPaths(state.root, parent, correction)) !==
			JSON.stringify([...contract.correctionPaths].sort())
	) {
		throw new Error("test candidate correction scope differs from exact six");
	}
	return correction;
}

function mergeCandidate(state, upstream, prHead, options = {}) {
	const tree = options.tree ?? git(state.root, "rev-parse", `${prHead}^{tree}`);
	const parents = options.swapParents === true ? [prHead, upstream] : [upstream, prHead];
	const merge = git(
		state.root,
		"commit-tree",
		tree,
		"-p",
		parents[0],
		"-p",
		parents[1],
		"-m",
		options.message ?? "candidate merge"
	);
	git(state.root, "reset", "--hard", "-q", merge);
	return merge;
}

function createWrongDescendant(repositoryRoot, state, contract, mutation) {
	git(state.root, "checkout", "-q", "--detach", contract.provisionalInstall.commit);
	const path = repositoryCandidatePlan(repositoryRoot, contract).fixedAnchor[0];
	if (mutation === "other-wrong-identity-descendant") append(state.root, path, "\nwrong descendant bytes\n");
	if (mutation === "wrong-mode-descendant") chmodSync(resolve(state.root, path), 0o755);
	if (mutation === "wrong-type-descendant") {
		rmSync(resolve(state.root, path));
		put(state.root, `${path}/entry.txt`, "wrong descendant tree\n");
	}
	const upstream = commit(state.root, mutation);
	git(state.root, "checkout", "-q", "--detach", contract.provisionalInstall.commit);
	const prHead = createCandidateCommit(repositoryRoot, state, contract);
	mergeCandidate(state, upstream, prHead, { message: mutation });
	return executeRepositoryCandidate(state.root, contract, upstream);
}

function mutateJson(root, path, mutate) {
	const document = JSON.parse(readFileSync(resolve(root, path), "utf8"));
	mutate(document);
	put(root, path, `${JSON.stringify(document, null, 2)}\n`);
}

async function runCandidateMutation(repositoryRoot, state, contract, mutation, immutablePaths) {
	resetCandidate(state);
	if (mutation.startsWith("predecessor-old:") || mutation.startsWith("predecessor-drift:")) {
		const path = mutation.slice(mutation.indexOf(":") + 1);
		const transition = contract.predecessorOracleTransition.governed.find((row) => row.path === path);
		if (transition === undefined) throw new Error(`unknown predecessor transition path: ${path}`);
		createCandidateCommit(repositoryRoot, state, contract);
		if (mutation.startsWith("predecessor-old:")) {
			const oldBytes = revisionBytes(repositoryRoot, contract.predecessorOracleTransition.parent, path);
			if (oldBytes === undefined) throw new Error(`missing predecessor transition parent bytes: ${path}`);
			put(state.root, path, oldBytes);
			commit(state.root, `restore old predecessor identity ${path}`);
		} else {
			append(state.root, path, "\npost-transition identity drift\n");
			commit(state.root, `drift predecessor identity ${path}`);
		}
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	if (mutation.startsWith("predecessor-omitted:")) {
		const path = mutation.slice("predecessor-omitted:".length);
		if (!contract.predecessorOracleTransition.governed.some((row) => row.path === path)) {
			throw new Error(`unknown omitted predecessor transition path: ${path}`);
		}
		createMutatedPredecessorTransition(repositoryRoot, state, contract, path);
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	if (mutation.startsWith("gossip-old:")) {
		createCandidateCommit(repositoryRoot, state, contract);
		const old = command(repositoryRoot, "git", [
			"show",
			`${contract.gossipOracleTransition.parent}:${contract.gossipOracleTransition.path}`,
		]);
		if (old.status !== 0) throw new Error(old.stderr);
		put(state.root, contract.gossipOracleTransition.path, old.stdout);
		commit(state.root, "restore old gossip identity");
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	if (mutation.startsWith("gossip-current:")) {
		createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, contract.gossipOracleTransition.path);
		commit(state.root, "mutate current gossip identity");
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	const correctedBase = contract.externalBase.commit;
	if (mutation.startsWith("gossip-postbootstrap:")) {
		const bootstrap = createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, contract.gossipOracleTransition.path);
		commit(state.root, "post-bootstrap gossip oracle drift");
		return executeRepositoryCandidate(state.root, contract, bootstrap);
	}
	if (mutation.startsWith("immutable:")) {
		const path = mutation.slice("immutable:".length);
		createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, path);
		commit(state.root, `mutate immutable ${path}`);
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "partial-owner-base") {
		const ownerFiles = contract.ownerFiles.slice(0, 2);
		for (const file of ownerFiles)
			cpSync(
				resolve(repositoryRoot, contract.ownerDirectory, file),
				resolve(state.root, contract.ownerDirectory, file)
			);
		commit(state.root, "partial correction owner");
		copyCandidateCorrection(repositoryRoot, state.root, contract);
		repinPolicyArtifacts(state.root, `${contract.ownerDirectory}/freeze-policy.json`);
		commit(state.root, "complete split correction");
		return executeRepositoryCandidate(state.root, contract, correctedBase);
	}
	if (mutation === "split-owner-routing") {
		for (const file of contract.ownerFiles)
			cpSync(
				resolve(repositoryRoot, contract.ownerDirectory, file),
				resolve(state.root, contract.ownerDirectory, file)
			);
		repinPolicyArtifacts(state.root, `${contract.ownerDirectory}/freeze-policy.json`);
		commit(state.root, "owner correction first", true);
		for (const path of contract.correctionPaths.filter((path) => path.startsWith(".github/workflows/")))
			cpSync(resolve(repositoryRoot, path), resolve(state.root, path));
		repinPolicyArtifacts(state.root, `${contract.ownerDirectory}/freeze-policy.json`);
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
	if (mutation === "arbitrary-later-empty-upstream") {
		git(state.root, "checkout", "-q", "--detach", contract.externalBase.commit);
		const upstream = commit(state.root, "later empty external candidate", true);
		git(state.root, "checkout", "-q", "--detach", contract.provisionalInstall.commit);
		const prHead = createCandidateCommit(repositoryRoot, state, contract);
		mergeCandidate(state, upstream, prHead, { message: mutation });
		return executeRepositoryCandidate(state.root, contract, upstream);
	}
	if (mutation === "caller-selected-old-base") {
		const upstream = git(state.root, "rev-parse", `${contract.externalBase.parents[0]}^`);
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, upstream);
	}
	if (mutation === "upstream-after-anchor") {
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, contract.fixedAnchor.commit);
	}
	if (mutation === "swapped-merge-parents") {
		const prHead = createCandidateCommit(repositoryRoot, state, contract);
		mergeCandidate(state, contract.externalBase.commit, prHead, { message: mutation, swapParents: true });
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	if (mutation === "merge-tree-drift") {
		const prHead = createCandidateCommit(repositoryRoot, state, contract);
		append(state.root, contract.workflowIdentities[0].path, "\nmerge tree drift\n");
		git(state.root, "add", contract.workflowIdentities[0].path);
		const tree = git(state.root, "write-tree");
		mergeCandidate(state, contract.externalBase.commit, prHead, { message: mutation, tree });
		return executeRepositoryCandidate(state.root, contract, contract.externalBase.commit);
	}
	if (mutation === "provisional-v1-descendant") {
		createCandidateCommit(repositoryRoot, state, contract);
		return executeRepositoryCandidate(state.root, contract, contract.provisionalInstall.commit);
	}
	if (
		mutation === "other-wrong-identity-descendant" ||
		mutation === "wrong-type-descendant" ||
		mutation === "wrong-mode-descendant"
	) {
		return createWrongDescendant(repositoryRoot, state, contract, mutation);
	}
	if (
		[
			"spoofed-root-stdout",
			"extra-root-stdout",
			"root-child-stderr",
			"root-child-signal",
			"root-child-timeout",
			"suppressed-root-exit",
		].includes(mutation)
	) {
		createCandidateCommit(repositoryRoot, state, contract);
		return executeWithRootChildPreload(repositoryRoot, state.root, contract, correctedBase, mutation);
	}
	const profile = `${contract.ownerDirectory}/profile.json`;
	const policy = `${contract.ownerDirectory}/freeze-policy.json`;
	const firstWorkflow = contract.workflowIdentities[0].path;
	const mutations = {
		"v1-schema": (root) => {
			mutateJson(root, profile, (document) => {
				document.schemaVersion = "ts-drp-protocol-v3-freeze-successor-profile-v1";
			});
			mutateJson(root, policy, (document) => {
				document.schemaVersion = "ts-drp-protocol-v3-freeze-successor-v1";
			});
		},
		"missing-schema": (root) => {
			mutateJson(root, profile, (document) => {
				delete document.schemaVersion;
			});
			mutateJson(root, policy, (document) => {
				delete document.schemaVersion;
			});
		},
		"dual-schema": (root) => {
			mutateJson(root, profile, (document) => {
				document.legacySchemaVersion = "ts-drp-protocol-v3-freeze-successor-profile-v1";
			});
			mutateJson(root, policy, (document) => {
				document.legacySchemaVersion = "ts-drp-protocol-v3-freeze-successor-v1";
			});
		},
		"copied-root-checker": (root) =>
			mutateJson(root, profile, (document) => {
				document.rootFreezeEvidence[0].checkerBlob = document.rootFreezeEvidence[1].checkerBlob;
			}),
		"current-only-root-evidence": (root) =>
			mutateJson(root, profile, (document) => {
				delete document.rootFreezeEvidence[0].historicalStdout;
			}),
		"blob-only-root-evidence": (root) =>
			mutateJson(root, profile, (document) => {
				delete document.rootFreezeEvidence[0].currentStdout;
				delete document.rootFreezeEvidence[0].historicalStdout;
			}),
		"retained-legacy-checker": (root) =>
			append(root, firstWorkflow, `\nnode ${contract.predecessors[0].checker} "$UPSTREAM_SHA"\n`),
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
	createCandidateCommit(repositoryRoot, state, contract, {
		allowDifferentScope: ["extra-owner-entry", "extra-unhashed-exception", "sixth-thawed-path", "tree-owner"].includes(
			mutation
		),
		mutate,
	});
	return executeRepositoryCandidate(state.root, contract, correctedBase);
}

/** Runs one independently bounded exact repository partition with no controlled fallback. */
export async function runRepositoryCandidatePartition(repositoryRoot, contract, readiness, selection) {
	const availability = repositoryCandidateAvailability(repositoryRoot);
	if (!availability.available) return { available: false, checker: availability.checker };
	if (!readiness.ready) {
		throw new Error("candidate partitions require the shared READY evidence");
	}
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
		const negatives = [];
		for (const name of selection.mutationNames) {
			negatives.push({
				expectedFailure: expectedCandidateFailure(name),
				name,
				result: await runCandidateMutation(repositoryRoot, state, contract, name, fixedAnchor),
			});
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
