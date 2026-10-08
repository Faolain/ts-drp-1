#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_BLUEPRINT_ARTIFACT_PROFILE_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
		: resolve(process.env.PROTOCOL_V3_BLUEPRINT_ARTIFACT_PROFILE_REPOSITORY_ROOT);

const addendumPath = "docs/protocol/blueprint-artifact-profile-v3.md";
const amendmentPath = "docs/protocol/blueprint-artifact-profile-v3.json";
const profilePath = "packages/protocol-v3/supplements/blueprint-artifact-profile-v1/profile.json";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-blueprint-artifact-profile-v1.json";
const checkerPath = "packages/protocol-v3/scripts/check-blueprint-artifact-profile-freeze.mjs";
const workflowPath = ".github/workflows/protocol-v3-blueprint-artifact-profile.yml";
const redPath = "tests/protocol-v3-blueprint-runtime-0j-b.test.ts";
const contractPath = "tests/fixtures/phase-0j-b-v3/blueprint-runtime-contract.json";
const artifactPath = "tests/fixtures/phase-0j-b-v3/chat-blueprint.mjs";
const typeAuditPath = "tests/fixtures/phase-0j-b-v3/public-entry-type-audit.ts";
const typeAuditConfigPath = "tests/fixtures/phase-0j-b-v3/tsconfig.public-entry-audit.json";

const protectedArtifacts = Object.freeze([
	addendumPath,
	amendmentPath,
	profilePath,
	policyPath,
	checkerPath,
	workflowPath,
	redPath,
	contractPath,
	artifactPath,
	typeAuditPath,
	typeAuditConfigPath,
]);
const hashPinnedArtifacts = Object.freeze(protectedArtifacts.filter((path) => path !== policyPath));
const frozenTuple = Object.freeze({
	checkpoint: "907fae437e558145f63614cd6b5de925ea4bd8c2",
	freezePolicyPath: "packages/protocol-v3/conformance/freeze-policy-v3.json",
	freezePolicySha256: "fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3",
	protectedPathCount: 47,
	protectedPathStatesSha256: "023e7b50c11eff2d5fd4d0d8c5ea6da8d54ad095d73d24b7d3badea2e3769637",
});
const profileIdentity = Object.freeze({
	profileId: "ts-drp-blueprint-artifact-profile-v1",
	protocolMajor: 3,
	artifactDigestDomain: "ts-drp/blueprint-artifact/v3",
	runtimeProfiles: Object.freeze(["ecmascript-2024-sync-v1"]),
});
const sealedRedHashes = Object.freeze({
	[redPath]: "40c7d5c5bbea476a4f7ccec919db6c89b677d31e46173afcd52f4ec8dd82a5d1",
	[contractPath]: "61e6267c7ea773a52d5cfa6c735eddcdaaf8dcccce90e460938d0617fdf8029f",
	[artifactPath]: "69f15bd856d2aeb2970db15252ab2718fe00b1469f14dab90c91b5347cef758c",
	[typeAuditPath]: "16bb7100eef78791d6cf440dc122c8a7688cf166cd1afb5079f424c45d72c180",
	[typeAuditConfigPath]: "43e3bd46979761347514c75f80e28e6b15692aede6dfd71bdf8bbcb202f9e88a",
});

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sameKeys(actual, expected) {
	return isRecord(actual) && isDeepStrictEqual(Object.keys(actual).sort(), [...expected].sort());
}

/**
 * Pure exact-map evaluator for the complete additive supplement closure.
 * @param root0 - The content-addressed comparison.
 * @param root0.base - Exact protected-base digests.
 * @param root0.head - Exact proposed-head digests.
 * @param root0.protectedArtifacts - The complete governed path list.
 * @returns A stable acceptance result and every detected error.
 */
export function evaluateBlueprintArtifactProfileFreeze({ base, head, protectedArtifacts: requestedArtifacts }) {
	const errors = [];
	if (!isRecord(base) || !isRecord(head)) {
		return { accepted: false, errors: ["base and head must be content-addressed records"] };
	}
	if (!isDeepStrictEqual(requestedArtifacts, protectedArtifacts)) {
		errors.push("protected supplement surface differs from the complete eleven-artifact policy");
		return { accepted: false, errors };
	}
	if (!sameKeys(base, protectedArtifacts)) errors.push("protected supplement base key set differs");
	if (!sameKeys(head, protectedArtifacts)) errors.push("protected supplement head key set differs");
	for (const path of protectedArtifacts) {
		if (!isDigest(base[path])) {
			errors.push(`protected supplement base is absent or malformed: ${path}`);
		} else if (!isDigest(head[path])) {
			errors.push(`protected supplement head is absent or malformed: ${path}`);
		} else if (base[path] !== head[path]) {
			errors.push(`protected supplement drift: ${path}`);
		}
	}
	return { accepted: errors.length === 0, errors };
}

function fail(message) {
	throw new Error(`protocol-v3 blueprint artifact profile freeze violation: ${message}`);
}

function parseJson(bytes, label) {
	if (bytes === undefined) fail(`${label} is absent`);
	try {
		const value = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(value)) fail(`${label} must contain a JSON object`);
		return value;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${label} is not valid JSON`);
		throw error;
	}
}

function requireExactRecord(actual, expected, label) {
	if (!isRecord(actual) || !sameKeys(actual, Object.keys(expected))) {
		fail(`${label} key set differs`);
	}
	for (const [key, value] of Object.entries(expected)) {
		if (!isDeepStrictEqual(actual[key], value)) fail(`${label} differs at ${key}`);
	}
}

function validateFrozenTuple(read, label) {
	const frozenPolicyBytes = read(frozenTuple.freezePolicyPath);
	if (frozenPolicyBytes === undefined || sha256(frozenPolicyBytes) !== frozenTuple.freezePolicySha256) {
		fail(`${label} frozen protocol-v3 policy bytes drifted`);
	}
	const frozenPolicy = parseJson(frozenPolicyBytes, `${label} ${frozenTuple.freezePolicyPath}`);
	if (
		!Array.isArray(frozenPolicy.protectedPaths) ||
		frozenPolicy.protectedPaths.length !== frozenTuple.protectedPathCount
	) {
		fail(`${label} frozen protocol-v3 protected path count drifted`);
	}
	const rows = frozenPolicy.protectedPaths.map((path) => {
		if (typeof path !== "string") fail(`${label} frozen protocol-v3 protected path is malformed`);
		const bytes = read(path);
		return `${path}\0${bytes === undefined ? "ABSENT" : sha256(bytes)}\n`;
	});
	if (sha256(rows.join("")) !== frozenTuple.protectedPathStatesSha256) {
		fail(`${label} frozen protocol-v3 protected path state drifted`);
	}
}

function validateWorkflow(source) {
	const requiredFragments = [
		"name: Protocol v3 blueprint artifact profile freeze",
		"pull_request:",
		"fetch-depth: 0",
		"BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		`CHECKER: ${checkerPath}`,
		`POLICY: ${policyPath}`,
		'git show "$BASE_SHA:$CHECKER"',
		'node "$RUNNER_TEMP/check-blueprint-artifact-profile-freeze.mjs" "$BASE_SHA"',
		`node ${checkerPath} "$BASE_SHA"`,
	];
	for (const fragment of requiredFragments) {
		if (!source.includes(fragment)) fail(`workflow omits required structure: ${fragment}`);
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /^\s+[A-Za-z-]+:\s+write\s*$/mu]) {
		if (forbidden.test(source)) fail(`workflow contains forbidden structure: ${forbidden}`);
	}
}

function validateProfile(profile, label, expectedSchemaVersion) {
	if (profile.schemaVersion !== expectedSchemaVersion) fail(`${label} schemaVersion differs`);
	for (const [key, expected] of Object.entries(profileIdentity)) {
		if (!isDeepStrictEqual(profile[key], expected)) fail(`${label} differs at ${key}`);
	}
	requireExactRecord(profile.frozenTuple, frozenTuple, `${label} frozenTuple`);
	if (
		!isRecord(profile.pureAllowlist) ||
		!sameKeys(profile.pureAllowlist, ["identifiers", "mathMembers"]) ||
		!Array.isArray(profile.pureAllowlist.identifiers) ||
		!Array.isArray(profile.pureAllowlist.mathMembers)
	) {
		fail(`${label} pureAllowlist is malformed`);
	}
	for (const list of [profile.pureAllowlist.identifiers, profile.pureAllowlist.mathMembers]) {
		if (
			list.length === 0 ||
			list.some((entry) => typeof entry !== "string" || entry.length === 0) ||
			new Set(list).size !== list.length
		) {
			fail(`${label} pureAllowlist contains an invalid entry`);
		}
	}
}

function validateBundle(read, label, runningCheckerBytes) {
	validateFrozenTuple(read, label);
	const addendumBytes = read(addendumPath);
	const amendmentBytes = read(amendmentPath);
	const profileBytes = read(profilePath);
	const policyBytes = read(policyPath);
	const checkerBytes = read(checkerPath);
	const workflowBytes = read(workflowPath);
	if (
		addendumBytes === undefined ||
		amendmentBytes === undefined ||
		profileBytes === undefined ||
		policyBytes === undefined ||
		checkerBytes === undefined ||
		workflowBytes === undefined ||
		read(redPath) === undefined ||
		read(contractPath) === undefined ||
		read(artifactPath) === undefined ||
		read(typeAuditPath) === undefined ||
		read(typeAuditConfigPath) === undefined
	) {
		fail(`${label} supplement closure is incomplete`);
	}

	const addendum = addendumBytes.toString("utf8");
	const amendment = parseJson(amendmentBytes, `${label} ${amendmentPath}`);
	const profile = parseJson(profileBytes, `${label} ${profilePath}`);
	const policy = parseJson(policyBytes, `${label} ${policyPath}`);
	validateProfile(profile, `${label} profile`, "ts-drp-blueprint-artifact-profile-v1");
	validateProfile(amendment, `${label} amendment`, "ts-drp-blueprint-artifact-profile-amendment-v1");
	if (!isDeepStrictEqual(amendment.pureAllowlist, profile.pureAllowlist)) {
		fail(`${label} amendment pureAllowlist differs from the runtime profile`);
	}
	for (const required of [
		profile.profileId,
		profile.artifactDigestDomain,
		...profile.runtimeProfiles,
		...profile.pureAllowlist.identifiers,
		...profile.pureAllowlist.mathMembers,
	]) {
		if (!addendum.includes(required)) fail(`${label} addendum omits ${required}`);
	}
	if (
		amendment.schemaVersion !== "ts-drp-blueprint-artifact-profile-amendment-v1" ||
		amendment.addendumPath !== addendumPath ||
		amendment.addendumSha256 !== sha256(addendumBytes) ||
		amendment.profilePath !== profilePath ||
		amendment.profileSha256 !== sha256(profileBytes) ||
		amendment.implementationExport !== "prepareBlueprintRuntime"
	) {
		fail(`${label} amendment binding is stale`);
	}

	if (
		policy.schemaVersion !== "ts-drp-blueprint-artifact-profile-freeze-v1" ||
		policy.profileId !== profileIdentity.profileId
	) {
		fail(`${label} policy identity is malformed`);
	}
	requireExactRecord(policy.frozenTuple, frozenTuple, `${label} policy frozenTuple`);
	if (!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)) {
		fail(`${label} protectedArtifacts differs`);
	}
	if (!sameKeys(policy.artifactSha256, hashPinnedArtifacts)) {
		fail(`${label} artifactSha256 must pin exactly the ten non-policy artifacts`);
	}
	for (const path of hashPinnedArtifacts) {
		const expected = policy.artifactSha256[path];
		const bytes = read(path);
		if (!isDigest(expected) || bytes === undefined || sha256(bytes) !== expected) {
			fail(`${label} artifact pin is stale: ${path}`);
		}
	}
	if (
		policy.checkerSha256 !== policy.artifactSha256[checkerPath] ||
		sha256(runningCheckerBytes) !== policy.checkerSha256
	) {
		fail(`${label} running checker differs from its self-pin`);
	}
	for (const [path, digest] of Object.entries(sealedRedHashes)) {
		if (policy.artifactSha256[path] !== digest) fail(`${label} sealed RED tuple pin drifted: ${path}`);
	}
	validateWorkflow(workflowBytes.toString("utf8"));
	return { policyBytes };
}

function git(args) {
	return execFileSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function readRevisionFile(revision, path) {
	try {
		return execFileSync("git", ["show", `${revision}:${path}`], {
			cwd: repositoryRoot,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function readWorkingFile(path) {
	const absolutePath = join(repositoryRoot, path);
	return existsSync(absolutePath) && statSync(absolutePath).isFile() ? readFileSync(absolutePath) : undefined;
}

function isTracked(path) {
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
			cwd: repositoryRoot,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function presence(read) {
	return protectedArtifacts.filter((path) => read(path) !== undefined);
}

function digestMap(read) {
	return Object.fromEntries(
		protectedArtifacts.map((path) => {
			const bytes = read(path);
			return [path, bytes === undefined ? undefined : sha256(bytes)];
		})
	);
}

function runCli() {
	const baseReference =
		process.argv[2] ??
		process.env.GITHUB_BASE_SHA ??
		(process.env.GITHUB_BASE_REF === undefined ? "HEAD^" : `origin/${process.env.GITHUB_BASE_REF}`);
	const mergeBase = git(["merge-base", baseReference, "HEAD"]);
	const readBase = (path) => readRevisionFile(mergeBase, path);
	const basePresence = presence(readBase);
	const currentPresence = presence(readWorkingFile);
	const runningCheckerBytes = readFileSync(fileURLToPath(import.meta.url));

	if (basePresence.length === 0) {
		if (currentPresence.length !== protectedArtifacts.length) {
			fail("bootstrap must add the complete eleven-artifact supplement atomically");
		}
		validateBundle(readWorkingFile, "bootstrap current", runningCheckerBytes);
		process.stdout.write(
			`protocol-v3 blueprint artifact profile bootstrap passed (${mergeBase.slice(0, 12)}..working-tree)\n`
		);
		return;
	}
	if (basePresence.length !== protectedArtifacts.length) {
		fail("merge-base contains a partial supplement closure");
	}
	for (const path of protectedArtifacts) {
		if (!isTracked(path)) fail(`protected supplement artifact is untracked or index-deleted: ${path}`);
	}
	const baseBundle = validateBundle(readBase, "merge-base", readBase(checkerPath));
	const currentBundle = validateBundle(readWorkingFile, "working tree", runningCheckerBytes);
	if (!isDeepStrictEqual(currentBundle.policyBytes, baseBundle.policyBytes)) {
		fail("supplement freeze policy changed");
	}
	const evaluation = evaluateBlueprintArtifactProfileFreeze({
		base: digestMap(readBase),
		head: digestMap(readWorkingFile),
		protectedArtifacts,
	});
	if (!evaluation.accepted) fail(evaluation.errors.join("; "));
	process.stdout.write(
		`protocol-v3 blueprint artifact profile freeze passed (${mergeBase.slice(0, 12)}..working-tree)\n`
	);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		runCli();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
