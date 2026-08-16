/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownerDirectory = "packages/protocol-v3/conformance/freeze-successor-v1";
const repositoryRoot = realpathSync(
	resolve(
		process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT ?? dirname(fileURLToPath(import.meta.url)),
		process.env.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT === undefined ? "../../../.." : "."
	)
);
const policyPath = `${ownerDirectory}/freeze-policy.json`;
const profilePath = `${ownerDirectory}/profile.json`;
const bootstrapParent = "eb84a71ee5e55bc7aecafab8a80a4dde07aa0ec0";
const expectedOwnerPaths = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"]
	.map((file) => `${ownerDirectory}/${file}`)
	.sort();
const bootstrapTestPaths = [
	"tests/fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs",
	"tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.ts",
	"tests/protocol-v3-blueprint-operation-budget-0p2.test.ts",
	"tests/protocol-v3-blueprint-work-budget-0p0.test.ts",
	"tests/protocol-v3-equivocation-author-projection-0o-b1b.test.ts",
	"tests/protocol-v3-equivocation-gossip-budget-0o-b2.test.ts",
	"tests/protocol-v3-equivocation-acl-reputation-0o-b3.test.ts",
	"tests/protocol-v3-freeze-successor-v1-red.test.ts",
];
const expectedBootstrapPaths = [
	`${ownerDirectory}/check-freeze.mjs`,
	`${ownerDirectory}/freeze-policy.json`,
	`${ownerDirectory}/spec.md`,
	...bootstrapTestPaths,
].sort();

function fail(message) {
	throw new Error(`protocol-v3 freeze successor violation: ${message}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function command(executable, args, options = {}) {
	return spawnSync(executable, args, {
		cwd: repositoryRoot,
		encoding: options.encoding ?? null,
		env: { ...process.env, ...options.env },
		maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		timeout: options.timeout ?? 60_000,
	});
}

function gitBytes(...args) {
	const result = command("git", args);
	if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr.length !== 0) {
		fail(`git evidence unavailable: ${args[0] ?? "unknown"}`);
	}
	return result.stdout;
}

function gitText(...args) {
	return gitBytes(...args)
		.toString("utf8")
		.trim();
}

function exactKeys(value, keys, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} shape differs`);
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} keys differ`);
}

function parseJson(path, label) {
	try {
		return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
	} catch {
		fail(`${label} is unavailable or malformed`);
	}
}

function exactParents(revision) {
	const fields = gitText("rev-list", "--parents", "-n", "1", revision).split(" ");
	if (fields[0] !== revision) fail("commit identity differs");
	return fields.slice(1);
}

function treeEntryOrUndefined(revision, path) {
	const bytes = gitBytes("--literal-pathspecs", "ls-tree", "-z", "--full-tree", revision, "--", path);
	if (bytes.length === 0) return undefined;
	if (bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0)) {
		fail(`governed entry differs: ${path}`);
	}
	const record = bytes.subarray(0, -1).toString("utf8");
	const match = /^([0-7]{6}) (\S+) ([0-9a-f]{40})\t(.+)$/u.exec(record);
	if (match === null || match[4] !== path) fail(`governed entry differs: ${path}`);
	return { mode: match[1], object: match[3], path: match[4], type: match[2] };
}

function treeEntry(revision, path) {
	const entry = treeEntryOrUndefined(revision, path);
	if (entry === undefined) fail(`governed entry differs: ${path}`);
	return entry;
}

function blobBytes(object, path) {
	const result = command("git", ["cat-file", "blob", object]);
	if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr.length !== 0) {
		fail(`governed blob unavailable: ${path}`);
	}
	return result.stdout;
}

function parseJsonBytes(bytes, label) {
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		fail(`${label} is unavailable or malformed`);
	}
}

function changedPaths(parent, child) {
	const bytes = gitBytes("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", parent, child);
	if (bytes.length === 0 || bytes.at(-1) !== 0) fail("release transition scope differs");
	const records = bytes.subarray(0, -1).toString("utf8").split("\0");
	if (records.some((path) => path.length === 0 || path.includes("\uFFFD"))) fail("release transition scope differs");
	return records.sort();
}

const upstream = process.argv[2];
if (typeof upstream !== "string" || !/^[0-9a-f]{40}$/u.test(upstream)) fail("upstream identity differs");
if (gitText("cat-file", "-t", upstream) !== "commit") fail("upstream is not a commit");

const head = gitText("rev-parse", "HEAD");
const headParents = exactParents(head);
const mergeBases = gitText("merge-base", "--all", upstream, head).split("\n").filter(Boolean);
if (mergeBases.length !== 1 || mergeBases[0] !== upstream) fail("upstream merge base differs");

let releaseTip = head;
if (headParents.length === 2) {
	if (headParents[0] !== upstream) fail("merge parent order differs");
	releaseTip = headParents[1];
	if (gitText("rev-parse", `${head}^{tree}`) !== gitText("rev-parse", `${releaseTip}^{tree}`)) {
		fail("merge tree differs from release tree");
	}
} else if (headParents.length > 1) {
	fail("release parent count differs");
}
if (gitText("merge-base", "--is-ancestor", upstream, releaseTip) !== "") fail("release ancestry differs");
if (gitText("status", "--porcelain=v1", "--untracked-files=no") !== "") fail("tracked worktree is dirty");

const upstreamPolicyEntry = treeEntryOrUndefined(upstream, policyPath);
let anchoredPolicy;
if (upstreamPolicyEntry === undefined) {
	if (JSON.stringify(exactParents(releaseTip)) !== JSON.stringify([bootstrapParent])) {
		fail("release bootstrap parent differs");
	}
	if (JSON.stringify(changedPaths(bootstrapParent, releaseTip)) !== JSON.stringify(expectedBootstrapPaths)) {
		fail("release transition scope differs");
	}
} else {
	if (upstreamPolicyEntry.mode !== "100644" || upstreamPolicyEntry.type !== "blob") {
		fail("upstream policy object class differs");
	}
	anchoredPolicy = parseJsonBytes(blobBytes(upstreamPolicyEntry.object, policyPath), "upstream freeze policy");
}

const policy = parseJson(policyPath, "freeze policy");
const profile = parseJson(profilePath, "successor profile");
exactKeys(
	policy,
	["schemaVersion", "profile", "checker", "workflows", "protectedArtifacts", "checkerSha256", "artifactSha256"],
	"freeze policy"
);
if (policy.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-v3") fail("freeze policy schema differs");
if (policy.profile !== "freeze-successor-v1" || policy.checker !== "check-freeze.mjs") {
	fail("freeze policy owner differs");
}
if (anchoredPolicy !== undefined) {
	exactKeys(
		anchoredPolicy,
		["schemaVersion", "profile", "checker", "workflows", "protectedArtifacts", "checkerSha256", "artifactSha256"],
		"upstream freeze policy"
	);
	if (anchoredPolicy.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-v3") {
		fail("upstream freeze policy schema differs");
	}
	const releasePolicyEntry = treeEntry(releaseTip, policyPath);
	if (
		releasePolicyEntry.mode !== upstreamPolicyEntry.mode ||
		releasePolicyEntry.type !== upstreamPolicyEntry.type ||
		releasePolicyEntry.object !== upstreamPolicyEntry.object
	) {
		fail("descendant freeze policy differs");
	}
	if (JSON.stringify(policy) !== JSON.stringify(anchoredPolicy)) fail("descendant freeze policy differs");
}
exactKeys(profile, ["schemaVersion", "rootCheckers"], "successor profile");
if (profile.schemaVersion !== "ts-drp-protocol-v3-freeze-successor-profile-v3") {
	fail("successor profile schema differs");
}

const actualOwnerPaths = gitText("ls-tree", "-r", "--name-only", releaseTip, "--", ownerDirectory)
	.split("\n")
	.filter(Boolean)
	.sort();
if (JSON.stringify(actualOwnerPaths) !== JSON.stringify(expectedOwnerPaths)) fail("owner path inventory differs");

if (
	!Array.isArray(policy.protectedArtifacts) ||
	new Set(policy.protectedArtifacts).size !== policy.protectedArtifacts.length
) {
	fail("protected artifact inventory differs");
}
if (!expectedOwnerPaths.every((path) => policy.protectedArtifacts.includes(path))) fail("owner protection differs");
if (!Array.isArray(policy.workflows) || policy.workflows.length !== 5) fail("workflow inventory differs");
if (!policy.workflows.every((path) => policy.protectedArtifacts.includes(path))) fail("workflow protection differs");
if (
	policy.artifactSha256 === null ||
	typeof policy.artifactSha256 !== "object" ||
	Array.isArray(policy.artifactSha256)
) {
	fail("artifact hash inventory differs");
}
const checkerPath = `${ownerDirectory}/${policy.checker}`;
const expectedHashPaths = policy.protectedArtifacts
	.filter((path) => path !== policyPath && path !== checkerPath)
	.sort();
if (JSON.stringify(Object.keys(policy.artifactSha256).sort()) !== JSON.stringify(expectedHashPaths)) {
	fail("artifact hash inventory differs");
}

if (anchoredPolicy !== undefined) {
	if (JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(anchoredPolicy.protectedArtifacts)) {
		fail("descendant protected artifact inventory differs");
	}
	for (const path of anchoredPolicy.protectedArtifacts) {
		const upstreamEntry = treeEntry(upstream, path);
		const releaseEntry = treeEntry(releaseTip, path);
		if (
			releaseEntry.mode !== upstreamEntry.mode ||
			releaseEntry.type !== upstreamEntry.type ||
			releaseEntry.object !== upstreamEntry.object
		) {
			fail(`descendant governed identity differs: ${path}`);
		}
	}
}

for (const path of policy.protectedArtifacts) {
	const entry = treeEntry(releaseTip, path);
	if (entry.mode !== "100644" || entry.type !== "blob") fail(`governed object class differs: ${path}`);
	const bytes = blobBytes(entry.object, path);
	if (!bytes.equals(readFileSync(resolve(repositoryRoot, path)))) fail(`worktree artifact differs: ${path}`);
	if (path === policyPath) continue;
	const expected = path === checkerPath ? policy.checkerSha256 : policy.artifactSha256[path];
	if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected) || sha256(bytes) !== expected) {
		fail(`governed artifact hash differs: ${path}`);
	}
}

if (!Array.isArray(profile.rootCheckers) || profile.rootCheckers.length !== 2) fail("root checker roster differs");
for (const evidence of profile.rootCheckers) {
	exactKeys(
		evidence,
		["id", "checker", "checkerObject", "checkerSha256", "base", "environment", "stdout"],
		"root checker evidence"
	);
	const checkerEntry = treeEntry(releaseTip, evidence.checker);
	if (
		checkerEntry.mode !== "100644" ||
		checkerEntry.type !== "blob" ||
		checkerEntry.object !== evidence.checkerObject ||
		sha256(blobBytes(checkerEntry.object, evidence.checker)) !== evidence.checkerSha256
	) {
		fail(`root checker identity differs: ${evidence.id}`);
	}
	if (!/^[0-9a-f]{40}$/u.test(evidence.base) || gitText("cat-file", "-t", evidence.base) !== "commit") {
		fail(`root checker base differs: ${evidence.id}`);
	}
	const result = command(process.execPath, [resolve(repositoryRoot, evidence.checker), evidence.base], {
		encoding: "utf8",
		env: { [evidence.environment]: repositoryRoot },
		maxBuffer: 4 * 1024 * 1024,
		timeout: 60_000,
	});
	if (
		result.error !== undefined ||
		result.signal !== null ||
		result.status !== 0 ||
		result.stderr !== "" ||
		result.stdout !== evidence.stdout
	) {
		fail(`current root checker evidence differs: ${evidence.id}`);
	}
}

process.stdout.write(`protocol-v3 freeze successor: PASS (${upstream.slice(0, 12)}..${releaseTip.slice(0, 12)})\n`);
