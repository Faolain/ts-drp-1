#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
	process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT ?? dirname(fileURLToPath(import.meta.url)),
	process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT === undefined ? "../../../.." : "."
);
const owner = "packages/protocol-v3/conformance/freeze-successor-v1";
const ownerFiles = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"];
const ownerPaths = ownerFiles.map((name) => `${owner}/${name}`);
const gossipCorrectionPaths = [
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-data-only-successor.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-dead-successor.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-indirect-legacy-checker.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-legacy-removed-successor-absent.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-missing-author-projection-suite.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-missing-digest-identity.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-missing-evidence-projection.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/gossip-successor-executable-legacy-retained.yml",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.ts",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.ts",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs",
	"tests/protocol-v3-equivocation-gossip-budget-0o-b2.test.ts",
	"tests/protocol-v3-freeze-successor-v1-red.test.ts",
];

function fail(message) {
	throw new Error(`protocol-v3 freeze successor violation: ${message}`);
}

function gitText(...args) {
	try {
		return execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		fail(`git command failed: ${args[0] ?? "unknown"}`);
	}
}

function gitBytes(...args) {
	try {
		return execFileSync("git", args, {
			cwd: root,
			encoding: null,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		fail(`git command failed: ${args[0] ?? "unknown"}`);
	}
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function read(path) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
		fail(`absent or irregular path: ${path}`);
	}
	return readFileSync(absolute);
}

function parseJson(path) {
	try {
		return JSON.parse(read(path).toString("utf8"));
	} catch {
		fail(`invalid JSON: ${path}`);
	}
}

function treeEntry(revision, path) {
	const output = gitText("ls-tree", revision, "--", path);
	if (output === "") return undefined;
	const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t/u.exec(output);
	return match === null ? undefined : { mode: match[1], object: match[3], type: match[2] };
}

function sameEntry(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function requireRegularBlob(revision, path) {
	const entry = treeEntry(revision, path);
	if (entry === undefined || entry.mode !== "100644" || entry.type !== "blob") {
		fail(`non-regular Git identity at ${revision}: ${path}`);
	}
	return entry;
}

function revisionSha256(revision, path) {
	return sha256(gitBytes("show", `${revision}:${path}`));
}

function requireAncestor(ancestor, descendant, label) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
			cwd: root,
			stdio: "ignore",
		});
	} catch {
		fail(`${label} ancestry differs`);
	}
}

function exactKeys(value, keys, label) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)
	) {
		fail(`${label} shape differs`);
	}
}

const upstream = process.argv[2];
if (upstream === undefined || !/^[0-9a-f]{40}$/u.test(upstream)) fail("upstream target is not exact");
gitText("rev-parse", "--verify", `${upstream}^{commit}`);
const mergeBases = gitText("merge-base", "--all", upstream, "HEAD").split("\n").filter(Boolean);
if (mergeBases.length !== 1 || !/^[0-9a-f]{40}$/u.test(mergeBases[0])) fail("merge base is not unique");
const base = mergeBases[0];
requireAncestor(base, "HEAD", "merge-base");

const policyPath = `${owner}/freeze-policy.json`;
const profilePath = `${owner}/profile.json`;
const policy = parseJson(policyPath);
const profile = parseJson(profilePath);
exactKeys(
	profile,
	[
		"schemaVersion",
		"fixedAnchor",
		"redBase",
		"gossipOracleTransition",
		"predecessors",
		"workflowIdentities",
		"historicalTransitions",
		"latentGossipBinding",
		"gossipChain",
		"gossipFdbSha256",
	],
	"profile"
);
if (profile.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-profile-v1") fail("profile identity differs");
if (profile.redBase !== profile.gossipOracleTransition.parent) fail("gossip transition parent differs");
if (!Array.isArray(profile.predecessors) || profile.predecessors.length !== 5) fail("predecessor roster differs");
if (!Array.isArray(profile.workflowIdentities) || profile.workflowIdentities.length !== 5)
	fail("workflow roster differs");

const workflowPaths = profile.workflowIdentities.map(({ path }) => path);
const predecessorPolicyPaths = profile.predecessors.map(({ policy: path }) => path);
const anchorPolicies = predecessorPolicyPaths.map((path) => {
	try {
		return JSON.parse(gitBytes("show", `${profile.fixedAnchor.commit}:${path}`).toString("utf8"));
	} catch {
		fail(`anchor policy unreadable: ${path}`);
	}
});
const inventory = [];
for (const anchorPolicy of anchorPolicies) {
	if (!Array.isArray(anchorPolicy.protectedArtifacts)) fail("anchor policy protectedArtifacts differs");
	for (const path of anchorPolicy.protectedArtifacts) if (!inventory.includes(path)) inventory.push(path);
}
if (inventory.length !== 58 || new Set(inventory).size !== 58) fail("fixed-anchor inventory differs");
if (JSON.stringify(inventory.filter((path) => workflowPaths.includes(path))) !== JSON.stringify(workflowPaths))
	fail("workflow identity order differs");
const immutable = inventory.filter((path) => !workflowPaths.includes(path));
const gossipPath = profile.gossipOracleTransition.path;
const fixedAnchorPaths = immutable.filter((path) => path !== gossipPath);
if (immutable.length !== 53 || fixedAnchorPaths.length !== 52 || !immutable.includes(gossipPath))
	fail("52+1 inventory differs");

const protectedArtifacts = [...ownerPaths, ...inventory];
exactKeys(
	policy,
	["schemaVersion", "profile", "checker", "workflows", "protectedArtifacts", "checkerSha256", "artifactSha256"],
	"policy"
);
if (
	policy.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-v1" ||
	policy.profile !== "freeze-successor-v1" ||
	policy.checker !== "check-freeze.mjs" ||
	JSON.stringify(policy.workflows) !== JSON.stringify(workflowPaths) ||
	JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(protectedArtifacts)
) {
	fail("policy identity differs");
}
if (policy.checkerSha256 !== sha256(read(ownerPaths[0]))) fail("checker hash differs");
const hashedArtifacts = protectedArtifacts.filter((path) => path !== ownerPaths[0] && path !== policyPath);
if (JSON.stringify(Object.keys(policy.artifactSha256)) !== JSON.stringify(hashedArtifacts))
	fail("artifact hash inventory differs");
for (const path of hashedArtifacts)
	if (policy.artifactSha256[path] !== sha256(read(path))) fail(`artifact hash differs: ${path}`);

if (JSON.stringify(readdirSync(resolve(root, owner)).sort()) !== JSON.stringify([...ownerFiles].sort()))
	fail("owner inventory differs");
for (const path of protectedArtifacts) {
	if (gitText("status", "--porcelain=v1", "--", path) !== "") fail(`dirty governed path: ${path}`);
	requireRegularBlob("HEAD", path);
}

if (gitText("rev-parse", `${profile.fixedAnchor.commit}^{tree}`) !== profile.fixedAnchor.tree)
	fail("fixed-anchor tree differs");
requireAncestor(profile.fixedAnchor.commit, base, "fixed-anchor/base");
requireAncestor(profile.fixedAnchor.commit, "HEAD", "fixed-anchor/HEAD");
for (const path of fixedAnchorPaths) {
	const anchor = requireRegularBlob(profile.fixedAnchor.commit, path);
	if (!sameEntry(anchor, requireRegularBlob(base, path)) || !sameEntry(anchor, requireRegularBlob("HEAD", path)))
		fail(`fixed-anchor identity differs: ${path}`);
}

const transition = profile.gossipOracleTransition;
exactKeys(
	transition,
	["commit", "parent", "tree", "path", "oldBlob", "oldSha256", "currentBlob", "currentSha256"],
	"gossip transition"
);
if (gitText("rev-parse", `${transition.commit}^{tree}`) !== transition.tree) fail("gossip transition tree differs");
if (gitText("rev-parse", `${transition.commit}^`) !== transition.parent)
	fail("gossip transition direct parent differs");
if (gitText("rev-parse", `${transition.parent}:${gossipPath}`) !== transition.oldBlob) fail("gossip old blob differs");
if (gitText("rev-parse", `${transition.commit}:${gossipPath}`) !== transition.currentBlob)
	fail("gossip current blob differs");
if (revisionSha256(transition.parent, gossipPath) !== transition.oldSha256) fail("gossip old hash differs");
if (revisionSha256(transition.commit, gossipPath) !== transition.currentSha256) fail("gossip current hash differs");
if (
	JSON.stringify(gitText("diff", "--name-only", transition.parent, transition.commit).split("\n")) !==
	JSON.stringify(gossipCorrectionPaths)
)
	fail("recorded gossip transition scope differs");

requireAncestor(profile.redBase, base, "RED/base");
requireAncestor(profile.redBase, "HEAD", "RED/HEAD");
let prHead = "HEAD";
const headParents = gitText("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
if (headParents.length === 3) {
	if (headParents[1] !== upstream) fail("merge first parent is not upstream");
	prHead = headParents[2];
	for (const path of protectedArtifacts)
		if (!sameEntry(treeEntry("HEAD", path), treeEntry(prHead, path))) fail(`merge changed governed path: ${path}`);
} else if (headParents.length !== 2) {
	fail("unsupported HEAD topology");
}
const transitionCommits = gitText("log", "--format=%H", `${profile.redBase}..${prHead}`, "--", gossipPath)
	.split("\n")
	.filter(Boolean);
if (transitionCommits.length !== 1) fail("gossip transition count differs");
const branchTransition = transitionCommits[0];
if (gitText("rev-parse", `${branchTransition}^`) !== profile.redBase) fail("gossip transition is not direct");
const branchTransitionPaths = gitText("diff", "--name-only", profile.redBase, branchTransition).split("\n");
if (
	branchTransition === transition.commit
		? JSON.stringify(branchTransitionPaths) !== JSON.stringify(gossipCorrectionPaths)
		: JSON.stringify(branchTransitionPaths) !== JSON.stringify([gossipPath])
)
	fail("branch gossip transition scope differs");
if (gitText("rev-parse", `${profile.redBase}:${gossipPath}`) !== transition.oldBlob)
	fail("branch gossip old blob differs");
if (gitText("rev-parse", `${branchTransition}:${gossipPath}`) !== transition.currentBlob)
	fail("branch gossip current blob differs");
if (
	requireRegularBlob(base, gossipPath).object !== transition.currentBlob ||
	requireRegularBlob("HEAD", gossipPath).object !== transition.currentBlob
) {
	fail("current gossip oracle differs");
}

for (const predecessor of profile.predecessors) {
	if (gitText("rev-parse", `${predecessor.baseline}^{tree}`) !== predecessor.baselineTree)
		fail(`predecessor tree differs: ${predecessor.id}`);
	if (gitText("rev-parse", `${predecessor.baseline}^`) !== predecessor.directParent)
		fail(`predecessor parent differs: ${predecessor.id}`);
}
for (const entry of profile.gossipChain)
	if (gitText("rev-parse", `${entry.commit}^{tree}`) !== entry.tree) fail("gossip chain tree differs");
if (gitText("rev-parse", `${profile.gossipChain[2].commit}^`) !== profile.gossipChain[1].commit)
	fail("gossip chain parent differs");
for (const [path, expected] of Object.entries(profile.gossipFdbSha256))
	if (revisionSha256(profile.gossipChain[1].commit, path) !== expected)
		fail(`gossip provisional hash differs: ${path}`);
for (const historical of profile.historicalTransitions)
	for (const [commit, expected] of historical.commits)
		if (revisionSha256(commit, historical.path) !== expected) fail(`historical transition differs: ${historical.path}`);
if (sha256(read(profile.latentGossipBinding.path)) !== profile.latentGossipBinding.sha256)
	fail("latent gossip binding differs");
const latent = parseJson(profile.latentGossipBinding.path);
if (
	latent.baseArtifactSha256?.[profile.historicalTransitions[2].path] !== profile.latentGossipBinding.staleAuthorHash ||
	sha256(read(profile.historicalTransitions[2].path)) !== profile.latentGossipBinding.currentAuthorHash
) {
	fail("latent/current author binding differs");
}

const baseOwner = ownerPaths.filter((path) => treeEntry(base, path) !== undefined);
if (baseOwner.length !== 0 && baseOwner.length !== ownerPaths.length) fail("partial base owner");
const governedBootstrap = [...ownerPaths, ...workflowPaths];
if (baseOwner.length === 0) {
	for (const path of workflowPaths)
		if (!sameEntry(requireRegularBlob(profile.fixedAnchor.commit, path), requireRegularBlob(base, path)))
			fail(`base workflow differs: ${path}`);
	const changed = gitText("diff", "--name-only", base, prHead, "--", ...protectedArtifacts)
		.split("\n")
		.filter(Boolean)
		.sort();
	if (JSON.stringify(changed) !== JSON.stringify([...governedBootstrap].sort())) fail("bootstrap path set differs");
	const commits = gitText("log", "--format=%H", `${base}..${prHead}`, "--", ...protectedArtifacts)
		.split("\n")
		.filter(Boolean);
	if (new Set(commits).size !== 1) fail("bootstrap is not atomic");
	if (gitText("rev-list", "--parents", "-n", "1", commits[0]).split(" ").length !== 2)
		fail("bootstrap commit is a merge");
} else {
	for (const path of governedBootstrap)
		if (!sameEntry(requireRegularBlob(base, path), requireRegularBlob("HEAD", path))) fail(`descendant drift: ${path}`);
	if (gitText("diff", "--name-only", base, prHead, "--", ...protectedArtifacts) !== "")
		fail("descendant governed history differs");
}

console.log("protocol-v3 freeze successor: PASS");
