#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
	process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT ?? dirname(fileURLToPath(import.meta.url)),
	process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT === undefined ? "../../../.." : "."
);
const owner = "packages/protocol-v3/conformance/freeze-successor-v1";
const ownerFiles = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"];
const ownerPaths = ownerFiles.map((name) => `${owner}/${name}`);
const correctiveRedPaths = [
	"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract-type.ts",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs",
	"tests/protocol-v3-freeze-successor-v1-red.test.ts",
];
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
			maxBuffer: 16 * 1024 * 1024,
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
			maxBuffer: 16 * 1024 * 1024,
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
		fail(`non-regular governed Git identity at ${revision}: ${path}`);
	}
	return entry;
}

function revisionSha256(revision, path) {
	return sha256(gitBytes("show", `${revision}:${path}`));
}

function revisionPatchSha256(parent, revision) {
	return sha256(gitBytes("diff", "--binary", parent, revision));
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

function exactParents(revision) {
	return gitText("rev-list", "--parents", "-n", "1", revision).split(" ").slice(1);
}

function exactChangedPaths(from, to) {
	return gitText("diff", "--name-only", from, to).split("\n").filter(Boolean).sort();
}

function isolatedCheckout(revision, label, use) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), `ts-drp-freeze-successor-${label}-`)));
	const checkout = resolve(parent, "repository");
	try {
		execFileSync("git", ["clone", "--shared", "--no-checkout", root, checkout], { stdio: "ignore" });
		execFileSync("git", ["checkout", "-q", "--detach", revision], { cwd: checkout, stdio: "ignore" });
		if (gitTextAt(checkout, "status", "--porcelain=v1", "--untracked-files=all") !== "") {
			fail(`${label} checkout is dirty`);
		}
		return use(checkout);
	} finally {
		rmSync(parent, { force: true, recursive: true });
	}
}

function gitTextAt(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error !== undefined || result.signal !== null || result.status !== 0)
		fail(`git command failed: ${args[0]}`);
	return result.stdout.trim();
}

function runRootClosure(evidence, revision, baseRevision, expectedStdout, label) {
	return isolatedCheckout(revision, label, (checkout) => {
		const checker = resolve(checkout, evidence.checker);
		if (gitTextAt(checkout, "rev-parse", `HEAD:${evidence.checker}`) !== evidence.checkerBlob) {
			fail(`${label} root checker blob differs`);
		}
		if (sha256(readFileSync(checker)) !== evidence.checkerSha256) fail(`${label} root checker hash differs`);
		let result;
		try {
			result = spawnSync(process.execPath, [checker, baseRevision], {
				cwd: checkout,
				encoding: null,
				env: { ...process.env, [evidence.environment]: checkout },
				timeout: 60_000,
			});
		} catch {
			fail(`${label} root checker child failed`);
		}
		if (
			result.error !== undefined ||
			result.signal !== null ||
			result.status !== 0 ||
			!Buffer.isBuffer(result.stdout) ||
			!result.stdout.equals(Buffer.from(expectedStdout)) ||
			!Buffer.isBuffer(result.stderr) ||
			result.stderr.byteLength !== 0
		) {
			fail(`${label} root checker governed identity or child evidence differs`);
		}
	});
}

function runPredecessorClosure(predecessor) {
	return isolatedCheckout(predecessor.baseline, `${predecessor.id}-historical`, (checkout) => {
		const checker = resolve(checkout, predecessor.checker);
		const result = spawnSync(process.execPath, [checker, predecessor.checkerBase], {
			cwd: checkout,
			encoding: null,
			env: { ...process.env, [predecessor.environment]: checkout },
			timeout: 60_000,
		});
		if (
			result.error !== undefined ||
			result.signal !== null ||
			result.status !== 0 ||
			!Buffer.isBuffer(result.stdout) ||
			!result.stdout.includes(Buffer.from("freeze: PASS")) ||
			!Buffer.isBuffer(result.stderr) ||
			result.stderr.byteLength !== 0
		) {
			fail(`governed identity predecessor checker failed: ${predecessor.id}`);
		}
	});
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
		"externalBase",
		"provisionalInstall",
		"originalInstallPaths",
		"correctionPaths",
		"rootFreezeEvidence",
		"fixedAnchor",
		"redBase",
		"redBaseParent",
		"redBaseTree",
		"gossipOracleTransition",
		"predecessorOracleTransition",
		"intermediaryChain",
		"correctiveRed",
		"predecessors",
		"workflowIdentities",
		"workflowSha256",
		"historicalTransitions",
		"latentGossipBinding",
		"gossipChain",
		"gossipFdbSha256",
	],
	"profile schema identity"
);
if (profile.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-profile-v2") fail("profile schema identity differs");
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
const predecessorTransitionPaths = profile.predecessorOracleTransition.governed.map(({ path }) => path);
const transitionedPaths = new Set([gossipPath, ...predecessorTransitionPaths]);
const fixedAnchorPaths = immutable.filter((path) => !transitionedPaths.has(path));
if (
	immutable.length !== 53 ||
	fixedAnchorPaths.length !== 50 ||
	transitionedPaths.size !== 3 ||
	![gossipPath, ...predecessorTransitionPaths].every((path) => immutable.includes(path))
)
	fail("50+3 inventory differs");

const protectedArtifacts = [...ownerPaths, ...inventory];
exactKeys(
	policy,
	["schemaVersion", "profile", "checker", "workflows", "protectedArtifacts", "checkerSha256", "artifactSha256"],
	"policy schema identity"
);
if (
	policy.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-v2" ||
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

if (JSON.stringify(readdirSync(resolve(root, owner)).sort()) !== JSON.stringify([...ownerFiles].sort()))
	fail("owner inventory differs");
for (const path of protectedArtifacts) {
	if (gitText("status", "--porcelain=v1", "--", path) !== "") fail(`dirty governed path: ${path}`);
	requireRegularBlob("HEAD", path);
}

if (gitText("rev-parse", `${profile.fixedAnchor.commit}^{tree}`) !== profile.fixedAnchor.tree)
	fail("fixed-anchor tree differs");
exactKeys(profile.externalBase, ["commit", "tree", "parents"], "external base");
if (
	gitText("rev-parse", `${profile.externalBase.commit}^{tree}`) !== profile.externalBase.tree ||
	JSON.stringify(exactParents(profile.externalBase.commit)) !== JSON.stringify(profile.externalBase.parents)
) {
	fail("external upstream identity differs");
}

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

const baseEntries = protectedArtifacts.map((path) => treeEntry(base, path));
const basePresent = baseEntries.filter((entry) => entry !== undefined).length;
const externalMode = base === profile.externalBase.commit;
if (externalMode) {
	if (upstream !== profile.externalBase.commit || basePresent !== 0) fail("external upstream census differs");
	requireAncestor(profile.externalBase.commit, profile.fixedAnchor.commit, "external/fixed-anchor");
} else {
	if (basePresent !== protectedArtifacts.length) fail("external/descendant upstream base identity census differs");
	requireAncestor(profile.fixedAnchor.commit, base, "fixed-anchor/base");
}
requireAncestor(profile.fixedAnchor.commit, "HEAD", "fixed-anchor/HEAD");

let correctionBase = false;
if (!externalMode) {
	try {
		correctionBase =
			JSON.stringify(exactParents(base)) === JSON.stringify([profile.correctiveRed.commit]) &&
			JSON.stringify(exactChangedPaths(profile.correctiveRed.commit, base)) ===
				JSON.stringify([...profile.correctionPaths].sort());
	} catch {
		// An unauthenticated descendant remains subject to the early base-identity boundary below.
	}
}

if (!externalMode && !correctionBase) {
	for (const path of protectedArtifacts)
		if (!sameEntry(requireRegularBlob(base, path), requireRegularBlob(prHead, path)))
			fail(`descendant governed identity differs: ${path}`);
	if (gitText("diff", "--name-only", base, prHead, "--", ...protectedArtifacts) !== "")
		fail("descendant governed history differs");
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

if (!externalMode) requireAncestor(profile.redBase, base, "RED/base");
requireAncestor(profile.redBase, "HEAD", "RED/HEAD");
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
	(!externalMode && requireRegularBlob(base, gossipPath).object !== transition.currentBlob) ||
	requireRegularBlob(profile.provisionalInstall.commit, gossipPath).object !== transition.currentBlob ||
	requireRegularBlob(prHead, gossipPath).object !== transition.currentBlob
) {
	fail("current gossip oracle differs");
}

const predecessorTransition = profile.predecessorOracleTransition;
exactKeys(
	predecessorTransition,
	["commit", "parent", "parentTree", "tree", "changedPaths", "governed"],
	"predecessor oracle transition"
);
if (
	gitText("rev-parse", `${predecessorTransition.parent}^{tree}`) !== predecessorTransition.parentTree ||
	gitText("rev-parse", `${predecessorTransition.commit}^{tree}`) !== predecessorTransition.tree ||
	JSON.stringify(exactParents(predecessorTransition.commit)) !== JSON.stringify([predecessorTransition.parent]) ||
	JSON.stringify(exactChangedPaths(predecessorTransition.parent, predecessorTransition.commit)) !==
		JSON.stringify([...predecessorTransition.changedPaths].sort())
)
	fail("predecessor oracle transition history differs");
requireAncestor(profile.provisionalInstall.commit, predecessorTransition.parent, "provisional/predecessor transition");
if (
	!Array.isArray(predecessorTransition.governed) ||
	predecessorTransition.governed.length !== 2 ||
	JSON.stringify(predecessorTransitionPaths) !==
		JSON.stringify([
			"tests/protocol-v3-blueprint-operation-budget-0p2.test.ts",
			"tests/protocol-v3-blueprint-work-budget-0p0.test.ts",
		])
)
	fail("predecessor oracle transition roster differs");
for (const governed of predecessorTransition.governed) {
	exactKeys(
		governed,
		["id", "path", "oldBlob", "oldSha256", "currentBlob", "currentSha256"],
		"predecessor oracle identity"
	);
	const anchor = requireRegularBlob(profile.fixedAnchor.commit, governed.path);
	if (
		anchor.object !== governed.oldBlob ||
		requireRegularBlob(profile.redBase, governed.path).object !== governed.oldBlob ||
		requireRegularBlob(profile.gossipOracleTransition.commit, governed.path).object !== governed.oldBlob ||
		requireRegularBlob(profile.provisionalInstall.commit, governed.path).object !== governed.oldBlob ||
		requireRegularBlob(predecessorTransition.parent, governed.path).object !== governed.oldBlob ||
		revisionSha256(predecessorTransition.parent, governed.path) !== governed.oldSha256 ||
		requireRegularBlob(predecessorTransition.commit, governed.path).object !== governed.currentBlob ||
		revisionSha256(predecessorTransition.commit, governed.path) !== governed.currentSha256
	)
		fail(`predecessor oracle identity differs: ${governed.path}`);
}

if (!Array.isArray(profile.intermediaryChain) || profile.intermediaryChain.length !== 4)
	fail("intermediary chain roster differs");
let intermediaryParent = predecessorTransition.commit;
for (const intermediary of profile.intermediaryChain) {
	exactKeys(
		intermediary,
		["id", "commit", "tree", "parent", "path", "blob", "sha256", "patchSha256"],
		"intermediary commit"
	);
	if (
		intermediary.parent !== intermediaryParent ||
		JSON.stringify(exactParents(intermediary.commit)) !== JSON.stringify([intermediary.parent]) ||
		gitText("rev-parse", `${intermediary.commit}^{tree}`) !== intermediary.tree ||
		JSON.stringify(exactChangedPaths(intermediary.parent, intermediary.commit)) !==
			JSON.stringify([intermediary.path]) ||
		requireRegularBlob(intermediary.commit, intermediary.path).object !== intermediary.blob ||
		revisionSha256(intermediary.commit, intermediary.path) !== intermediary.sha256 ||
		revisionPatchSha256(intermediary.parent, intermediary.commit) !== intermediary.patchSha256
	)
		fail(`intermediary commit identity differs: ${intermediary.id}`);
	intermediaryParent = intermediary.commit;
}

const correctiveRed = profile.correctiveRed;
exactKeys(correctiveRed, ["commit", "tree", "parent", "changedPaths", "artifacts", "patchSha256"], "corrective RED");
if (
	correctiveRed.parent !== intermediaryParent ||
	JSON.stringify(correctiveRed.changedPaths) !== JSON.stringify(correctiveRedPaths) ||
	!Array.isArray(correctiveRed.artifacts) ||
	correctiveRed.artifacts.length !== correctiveRedPaths.length ||
	JSON.stringify(correctiveRed.artifacts.map(({ path }) => path)) !== JSON.stringify(correctiveRedPaths) ||
	JSON.stringify(exactParents(correctiveRed.commit)) !== JSON.stringify([correctiveRed.parent]) ||
	gitText("rev-parse", `${correctiveRed.commit}^{tree}`) !== correctiveRed.tree ||
	JSON.stringify(exactChangedPaths(correctiveRed.parent, correctiveRed.commit)) !==
		JSON.stringify(correctiveRedPaths) ||
	revisionPatchSha256(correctiveRed.parent, correctiveRed.commit) !== correctiveRed.patchSha256
)
	fail("corrective RED identity differs");
for (const artifact of correctiveRed.artifacts) {
	exactKeys(artifact, ["path", "blob", "sha256"], "corrective RED artifact");
	if (
		requireRegularBlob(correctiveRed.commit, artifact.path).object !== artifact.blob ||
		revisionSha256(correctiveRed.commit, artifact.path) !== artifact.sha256
	)
		fail(`corrective RED artifact differs: ${artifact.path}`);
}
for (const governed of predecessorTransition.governed) {
	for (const revision of [...profile.intermediaryChain.map(({ commit }) => commit), correctiveRed.commit])
		if (requireRegularBlob(revision, governed.path).object !== governed.currentBlob)
			fail(`intermediary governed identity differs: ${governed.path}`);
}
const predecessorTransitionCommits = gitText(
	"log",
	"--format=%H",
	"--reverse",
	`${predecessorTransition.parent}..${prHead}`,
	"--",
	...predecessorTransition.changedPaths
)
	.split("\n")
	.filter(Boolean);
if (
	JSON.stringify(predecessorTransitionCommits) !==
	JSON.stringify([predecessorTransition.commit, profile.intermediaryChain[0].commit, correctiveRed.commit])
)
	fail("predecessor oracle transition count differs");
for (const governed of predecessorTransition.governed) {
	if (
		(!externalMode && requireRegularBlob(base, governed.path).object !== governed.currentBlob) ||
		requireRegularBlob(prHead, governed.path).object !== governed.currentBlob
	)
		fail(`current predecessor oracle identity differs: ${governed.path}`);
}

if (!Array.isArray(profile.rootFreezeEvidence) || profile.rootFreezeEvidence.length !== 2)
	fail("root checker evidence roster differs");
for (const evidence of profile.rootFreezeEvidence) {
	exactKeys(
		evidence,
		[
			"id",
			"checker",
			"baseline",
			"baselineTree",
			"directParent",
			"checkerBase",
			"checkerBaseTree",
			"checkerBlob",
			"checkerSha256",
			"environment",
			"historicalStdout",
			"currentStdout",
		],
		"root checker evidence"
	);
	if (
		gitText("rev-parse", `${evidence.baseline}^{tree}`) !== evidence.baselineTree ||
		JSON.stringify(exactParents(evidence.baseline)) !== JSON.stringify([evidence.directParent]) ||
		gitText("rev-parse", `${evidence.checkerBase}^{tree}`) !== evidence.checkerBaseTree
	) {
		fail(`${evidence.id} root checker history differs`);
	}
}

for (const path of fixedAnchorPaths) {
	const anchor = requireRegularBlob(profile.fixedAnchor.commit, path);
	if (
		!sameEntry(anchor, requireRegularBlob(profile.redBase, path)) ||
		!sameEntry(anchor, requireRegularBlob(profile.gossipOracleTransition.commit, path)) ||
		!sameEntry(anchor, requireRegularBlob(profile.provisionalInstall.commit, path)) ||
		!sameEntry(anchor, requireRegularBlob(predecessorTransition.parent, path)) ||
		!sameEntry(anchor, requireRegularBlob(predecessorTransition.commit, path)) ||
		(!externalMode && !sameEntry(anchor, requireRegularBlob(base, path))) ||
		!sameEntry(anchor, requireRegularBlob(prHead, path))
	) {
		fail(`current governed identity differs: ${path}`);
	}
}

for (const predecessor of profile.predecessors) {
	exactKeys(
		predecessor,
		[
			"id",
			"policy",
			"checker",
			"baseline",
			"baselineTree",
			"directParent",
			"directParentTree",
			"checkerBase",
			"environment",
		],
		"predecessor"
	);
	let historyMatches = false;
	try {
		historyMatches =
			gitText("rev-parse", `${predecessor.baseline}^{tree}`) === predecessor.baselineTree &&
			JSON.stringify(exactParents(predecessor.baseline)) === JSON.stringify([predecessor.directParent]) &&
			gitText("rev-parse", `${predecessor.directParent}^{tree}`) === predecessor.directParentTree;
	} catch {
		// Closed below as the same governed predecessor-history failure.
	}
	if (!historyMatches) {
		fail(`governed identity predecessor history differs: ${predecessor.id}`);
	}
}
for (const entry of profile.gossipChain)
	if (gitText("rev-parse", `${entry.commit}^{tree}`) !== entry.tree) fail("gossip chain tree differs");
if (gitText("rev-parse", `${profile.gossipChain[2].commit}^`) !== profile.gossipChain[1].commit)
	fail("gossip chain parent differs");
for (const [path, expected] of Object.entries(profile.gossipFdbSha256))
	if (revisionSha256(profile.gossipChain[1].commit, path) !== expected)
		fail(`gossip provisional hash differs: ${path}`);
for (const historical of profile.historicalTransitions) {
	for (const [commit, expected] of historical.commits) {
		let identityMatches = false;
		try {
			identityMatches = revisionSha256(commit, historical.path) === expected;
		} catch {
			// Closed below as the same governed historical-identity failure.
		}
		if (!identityMatches) fail(`historical governed identity differs: ${historical.path}`);
	}
}
if (sha256(read(profile.latentGossipBinding.path)) !== profile.latentGossipBinding.sha256)
	fail("latent gossip binding differs");
const latent = parseJson(profile.latentGossipBinding.path);
if (
	latent.baseArtifactSha256?.[profile.historicalTransitions[2].path] !== profile.latentGossipBinding.staleAuthorHash ||
	sha256(read(profile.historicalTransitions[2].path)) !== profile.latentGossipBinding.currentAuthorHash
) {
	fail("latent/current author binding differs");
}

exactKeys(profile.provisionalInstall, ["commit", "tree", "parent"], "provisional install");
if (
	gitText("rev-parse", `${profile.redBase}^{tree}`) !== profile.redBaseTree ||
	JSON.stringify(exactParents(profile.redBase)) !== JSON.stringify([profile.redBaseParent]) ||
	gitText("rev-parse", `${profile.provisionalInstall.commit}^{tree}`) !== profile.provisionalInstall.tree ||
	JSON.stringify(exactParents(profile.provisionalInstall.commit)) !==
		JSON.stringify([profile.provisionalInstall.parent])
) {
	fail("correction lineage identity differs");
}
if (
	JSON.stringify(exactChangedPaths(profile.gossipOracleTransition.commit, profile.provisionalInstall.commit)) !==
	JSON.stringify([...profile.originalInstallPaths].sort())
) {
	fail("original bootstrap transition differs");
}
const correctionCommits = gitText(
	"log",
	"--format=%H",
	`${correctiveRed.commit}..${prHead}`,
	"--",
	...profile.correctionPaths
)
	.split("\n")
	.filter(Boolean);
if (correctionCommits.length !== 1) fail("exact correction transition count differs");
const correction = correctionCommits[0];
const correctionParents = exactParents(correction);
if (
	correctionParents.length !== 1 ||
	correctionParents[0] !== correctiveRed.commit ||
	JSON.stringify(exactChangedPaths(correctionParents[0], correction)) !==
		JSON.stringify([...profile.correctionPaths].sort())
) {
	fail("exact correction transition scope differs");
}
requireAncestor(correctiveRed.commit, correction, "corrective RED/correction");
requireAncestor(correction, prHead, "correction/PR head");
const governedCommits = new Set(
	gitText("log", "--format=%H", `${profile.provisionalInstall.commit}..${prHead}`, "--", ...protectedArtifacts)
		.split("\n")
		.filter(Boolean)
);
if (
	governedCommits.size !== 2 ||
	!governedCommits.has(predecessorTransition.commit) ||
	!governedCommits.has(correction)
)
	fail("correction governed transition history differs");
for (const path of protectedArtifacts)
	if (!sameEntry(requireRegularBlob(correction, path), requireRegularBlob(prHead, path)))
		fail(`correction terminal governed identity differs: ${path}`);
for (const path of hashedArtifacts)
	if (policy.artifactSha256[path] !== sha256(read(path))) fail(`artifact hash differs: ${path}`);
for (const path of workflowPaths)
	if (profile.workflowSha256[path] !== sha256(read(path))) fail(`workflow routing identity differs: ${path}`);

for (const evidence of profile.rootFreezeEvidence) {
	runRootClosure(
		evidence,
		evidence.baseline,
		evidence.checkerBase,
		evidence.historicalStdout,
		`${evidence.id} historical`
	);
	runRootClosure(evidence, prHead, evidence.baseline, evidence.currentStdout, `${evidence.id} current preservation`);
}
for (const predecessor of profile.predecessors) runPredecessorClosure(predecessor);

console.log("protocol-v3 freeze successor: PASS");
