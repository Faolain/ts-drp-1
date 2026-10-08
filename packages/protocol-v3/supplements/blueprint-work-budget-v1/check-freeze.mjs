#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_BLUEPRINT_WORK_BUDGET_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_BLUEPRINT_WORK_BUDGET_REPOSITORY_ROOT);
const supplementRoot = "packages/protocol-v3/supplements/blueprint-work-budget-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-blueprint-work-budget.yml";
const redPath = "tests/protocol-v3-blueprint-work-budget-0p0.test.ts";
const contractPath = "tests/fixtures/phase-0p0-v3/blueprint-work-budget-contract.json";
const controlledPath = "tests/fixtures/phase-0p0-v3/controlled-blueprint-work-budget.ts";
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
]);
const hashPinnedArtifacts = Object.freeze(
	protectedArtifacts.filter((path) => path !== checkerPath && path !== policyPath)
);

function fail(message) {
	throw new Error(`protocol-v3 blueprint work budget freeze violation: ${message}`);
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
		policy.schemaVersion !== "ts-drp-blueprint-work-budget-freeze-v1" ||
		policy.profile !== "blueprint-work-budget-v1" ||
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
		profile.profileId !== "blueprint-work-budget-v1" ||
		profile.protocolMajor !== 3 ||
		profile.packageSchemaVersion !== 1 ||
		profile.legacyManifestSchemaVersion !== 1 ||
		profile.budgetedManifestSchemaVersion !== 2 ||
		profile.blueprintDigestDomain !== "ts-drp/blueprint-admission/v3" ||
		profile.manifest?.workBudgetProfile !== "blueprint-work-budget-v1" ||
		profile.manifest?.limitDomain !== "positive-safe-integer" ||
		profile.binding?.preimage !== "exact-canonical-whole-blueprint-package-bytes" ||
		profile.binding?.includesOperationDiscriminator !== true ||
		profile.binding?.includesOperationIdentity !== true ||
		profile.binding?.includesMaxCanonicalOperationBytes !== true ||
		profile.binding?.separateBudgetDigest !== false ||
		profile.claims?.operationByteEnforcement !== false ||
		profile.claims?.parametersRegistryChange !== false ||
		profile.claims?.protocolV2Change !== false ||
		profile.claims?.wallClockOrInstructionMeter !== false
	) {
		fail("profile contract differs");
	}
	if (
		contract.profileId !== profile.profileId ||
		contract.blueprintDigestDomain !== profile.blueprintDigestDomain ||
		contract.budgetedPackage?.protocolMajor !== 3 ||
		contract.budgetedPackage?.schemaVersion !== 1 ||
		contract.budgetedPackage?.manifest?.schemaVersion !== 2 ||
		contract.budgetedPackage?.manifest?.workBudgetProfile !== profile.profileId
	) {
		fail("contract fixture identity differs");
	}
	if (
		contract.protectedArtifactSha256 === null ||
		typeof contract.protectedArtifactSha256 !== "object" ||
		Object.keys(contract.protectedArtifactSha256).length !== 7
	) {
		fail("protected predecessor hash set differs");
	}
	for (const [path, expected] of Object.entries(contract.protectedArtifactSha256)) {
		if (sha256(readWorking(path)) !== expected) fail(`protected predecessor drift: ${path}`);
	}
	const registry = readJson("packages/protocol-v3/registry/registry-v1.json");
	const parameterNames = registry.kinds?.parameters?.fields?.map(({ name }) => name);
	if (
		!isDeepStrictEqual(parameterNames, [
			"maxEpochVertices",
			"maxEpochBytes",
			"maxDependencies",
			"snapshotChunkBytes",
			"maxSnapshotBytes",
			"maxPendingEntries",
			"maxPendingBytes",
		])
	) {
		fail("frozen seven-field parameters kind differs");
	}
	const specification = readWorking(specificationPath).toString("utf8");
	for (const phrase of [
		"Existing manifest schema 1 remains valid and byte-for-byte unchanged",
		"positive safe integer",
		"exact canonical whole blueprint package bytes",
		"operation discriminator",
		"no second budget digest",
		"does not measure an operation",
		"Phase 0p-2",
		"frozen seven-field `parameters` kind is unchanged",
	]) {
		if (!specification.includes(phrase)) fail(`specification omits ${phrase}`);
	}
	const workflow = readWorking(workflowPath).toString("utf8");
	for (const phrase of [
		"name: Protocol v3 blueprint work budget freeze",
		"permissions:\n  contents: read",
		"ref: ${{ github.sha }}",
		"timeout-minutes: 10",
		"PHASE_0P0_IMPLEMENTATION_MODULE",
		"--no-coverage --maxWorkers=1 --minWorkers=1",
		"protocol-v3-blueprint-admission-0i.test.ts",
		"protocol-v3-independent-reference-vectors-n1prime-c2.test.ts",
		"protocol-v3/scripts/check-protocol-v3-freeze.mjs",
		"protocol-v2/scripts/check-protocol-freeze.mjs",
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
console.log("protocol-v3 blueprint work budget freeze: PASS");
