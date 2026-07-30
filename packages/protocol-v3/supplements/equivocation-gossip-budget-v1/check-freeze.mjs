#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_EQUIVOCATION_GOSSIP_BUDGET_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_EQUIVOCATION_GOSSIP_BUDGET_REPOSITORY_ROOT);
const supplementRoot = "packages/protocol-v3/supplements/equivocation-gossip-budget-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-equivocation-gossip-budget.yml";
const redPath = "tests/protocol-v3-equivocation-gossip-budget-0o-b2.test.ts";
const fixtureRoot = "tests/fixtures/phase-0o-b2-v3";
const contractPath = `${fixtureRoot}/gossip-budget-contract.json`;
const controlledPath = `${fixtureRoot}/controlled-gossip-budget.ts`;
const publicMutantPath = `${fixtureRoot}/public-reexport-mutant.ts`;
const sourceAuditPath = `${fixtureRoot}/public-entry-type-audit.ts`;
const builtAuditPath = `${fixtureRoot}/built-package-type-audit.ts`;
const sourceAuditConfigPath = `${fixtureRoot}/tsconfig.public-entry-audit.json`;
const builtAuditConfigPath = `${fixtureRoot}/tsconfig.built-package-audit.json`;
const publicContractPath = `${fixtureRoot}/public-export-contract.mjs`;
const baseRef = process.argv[2];

const requiredSupplementFiles = Object.freeze(["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"]);
const protectedArtifacts = Object.freeze([
	checkerPath,
	policyPath,
	profilePath,
	specificationPath,
	workflowPath,
	redPath,
	contractPath,
	controlledPath,
	publicMutantPath,
	sourceAuditPath,
	builtAuditPath,
	sourceAuditConfigPath,
	builtAuditConfigPath,
	publicContractPath,
]);
const hashPinnedArtifacts = Object.freeze(
	protectedArtifacts.filter((path) => path !== checkerPath && path !== policyPath)
);

function fail(message) {
	throw new Error(`protocol-v3 equivocation gossip budget freeze violation: ${message}`);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function readWorking(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or not a regular file`);
	return readFileSync(absolute);
}

function readJson(path) {
	try {
		const value = JSON.parse(readWorking(path).toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must contain an object`);
		return value;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${path} is invalid JSON`);
		throw error;
	}
}

function git(...args) {
	return execFileSync("git", args, {
		cwd: repositoryRoot,
		encoding: null,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function readBase(revision, path) {
	try {
		return git("show", `${revision}:${path}`);
	} catch {
		return undefined;
	}
}

function validateCurrentBundle() {
	const directory = resolve(repositoryRoot, supplementRoot);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) fail("supplement directory is absent");
	if (!isDeepStrictEqual(readdirSync(directory).sort(), [...requiredSupplementFiles].sort())) {
		fail("supplement directory file set differs");
	}
	const policy = readJson(policyPath);
	const profile = readJson(profilePath);
	const contract = readJson(contractPath);
	if (
		policy.schemaVersion !== "ts-drp-equivocation-gossip-budget-freeze-v1" ||
		policy.profile !== "equivocation-gossip-budget-v1" ||
		policy.baseProfile !== "equivocation-author-projection-v1" ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("freeze policy identity or protected surface differs");
	}
	if (policy.checkerSha256 !== sha256(readWorking(checkerPath))) fail("checker hash binding differs");
	if (
		policy.artifactSha256 === null ||
		typeof policy.artifactSha256 !== "object" ||
		!isDeepStrictEqual(Object.keys(policy.artifactSha256).sort(), [...hashPinnedArtifacts].sort())
	) {
		fail("artifact hash key set differs");
	}
	for (const path of hashPinnedArtifacts) {
		if (policy.artifactSha256[path] !== sha256(readWorking(path))) fail(`artifact hash binding differs: ${path}`);
	}
	if (
		profile.profileId !== "equivocation-gossip-budget-v1" ||
		profile.baseProfileId !== "equivocation-author-projection-v1" ||
		profile.input?.detachedDigestSetsOnly !== true ||
		profile.input?.authoritativeCounts !== false ||
		profile.budget?.selection !== "canonical-first-N-author-wide-pair-tuples" ||
		profile.budget?.saturationEffect !== "composition-output-only" ||
		profile.output?.pairIdentity !== "scope-plus-canonical-unordered-distinct-digest-pair" ||
		profile.claims?.globalComputationBound !== false ||
		profile.claims?.transportRateLimit !== false
	) {
		fail("profile contract differs");
	}
	if (
		contract.baseArtifactSha256 === null ||
		typeof contract.baseArtifactSha256 !== "object" ||
		Object.keys(contract.baseArtifactSha256).length === 0
	) {
		fail("contract lacks frozen base hashes");
	}
	for (const [path, expected] of Object.entries(contract.baseArtifactSha256)) {
		if (sha256(readWorking(path)) !== expected) fail(`frozen author-projection base drift: ${path}`);
	}
	const specification = readWorking(specificationPath).toString("utf8");
	for (const phrase of [
		"detached digest sets",
		"canonical first N",
		"code-unit order",
		"nonnegative safe integer",
		"pending rows",
		"future reputation",
		"composition output only",
		"no global computation bound",
	]) {
		if (!specification.includes(phrase)) fail(`specification omits ${phrase}`);
	}
	const workflow = readWorking(workflowPath).toString("utf8");
	for (const phrase of [
		"name: Protocol v3 equivocation gossip budget freeze",
		"permissions:\n  contents: read",
		"ref: ${{ github.sha }}",
		"timeout-minutes: 10",
		"PHASE_0O_B2_IMPLEMENTATION_MODULE",
		"--no-coverage --maxWorkers=1 --minWorkers=1",
		"protocol-v3-equivocation-author-projection-0o-b1b.test.ts",
		"equivocation-author-projection-v1/check-freeze.mjs",
	]) {
		if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u]) {
		if (forbidden.test(workflow)) fail(`workflow has forbidden structure: ${forbidden}`);
	}
}

function validateTransition(revision) {
	git("rev-parse", "--verify", `${revision}^{commit}`);
	const atBase = protectedArtifacts.map((path) => readBase(revision, path));
	const presentCount = atBase.filter((value) => value !== undefined).length;
	if (presentCount !== 0 && presentCount !== protectedArtifacts.length) fail("bootstrap is non-atomic at merge base");
	if (presentCount === protectedArtifacts.length) {
		for (let index = 0; index < protectedArtifacts.length; index++) {
			const path = protectedArtifacts[index];
			if (sha256(atBase[index]) !== sha256(readWorking(path))) fail(`frozen artifact changed from merge base: ${path}`);
		}
	}
}

validateCurrentBundle();
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 equivocation gossip budget freeze: PASS");
