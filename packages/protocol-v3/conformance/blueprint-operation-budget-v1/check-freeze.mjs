#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_BLUEPRINT_OPERATION_BUDGET_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_BLUEPRINT_OPERATION_BUDGET_REPOSITORY_ROOT);
const conformanceRoot = "packages/protocol-v3/conformance/blueprint-operation-budget-v1";
const checkerPath = `${conformanceRoot}/check-freeze.mjs`;
const policyPath = `${conformanceRoot}/freeze-policy.json`;
const profilePath = `${conformanceRoot}/profile.json`;
const specificationPath = `${conformanceRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-blueprint-operation-budget.yml";
const redPath = "tests/protocol-v3-blueprint-operation-budget-0p2.test.ts";
const contractPath = "tests/fixtures/phase-0p2-v3/blueprint-operation-budget-contract.json";
const controlledPath = "tests/fixtures/phase-0p2-v3/controlled-blueprint-operation-budget.ts";
const baseRef = process.argv[2];
const requiredFiles = Object.freeze(["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"]);
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
	throw new Error(`protocol-v3 blueprint operation budget freeze violation: ${message}`);
}

function read(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or irregular`);
	return readFileSync(absolute);
}

function json(path) {
	try {
		const value = JSON.parse(read(path).toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} is not an object`);
		return value;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${path} is invalid JSON`);
		throw error;
	}
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
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

function validateCurrent() {
	if (!isDeepStrictEqual(readdirSync(resolve(repositoryRoot, conformanceRoot)).sort(), [...requiredFiles].sort())) {
		fail("conformance file set differs");
	}
	const policy = json(policyPath);
	const profile = json(profilePath);
	const contract = json(contractPath);
	if (
		policy.schemaVersion !== "ts-drp-blueprint-operation-budget-freeze-v1" ||
		policy.profile !== "blueprint-operation-budget-v1" ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("freeze policy identity differs");
	}
	if (policy.checkerSha256 !== sha256(read(checkerPath))) fail("checker hash differs");
	if (
		policy.artifactSha256 === null ||
		typeof policy.artifactSha256 !== "object" ||
		!isDeepStrictEqual(Object.keys(policy.artifactSha256).sort(), [...hashPinnedArtifacts].sort())
	) {
		fail("artifact hash key set differs");
	}
	for (const path of hashPinnedArtifacts) {
		if (policy.artifactSha256[path] !== sha256(read(path))) fail(`artifact hash differs: ${path}`);
	}
	if (
		profile.schemaVersion !== "ts-drp-blueprint-operation-budget-v1" ||
		profile.profileId !== "blueprint-operation-budget-v1" ||
		profile.protocolMajor !== 3 ||
		profile.governedManifestSchemaVersion !== 2 ||
		profile.workBudgetProfile !== "blueprint-work-budget-v1" ||
		profile.meter?.preimage !== "encodeCanonical(canonicalDetachedOperation)" ||
		profile.meter?.byteCount !== "Uint8Array.byteLength" ||
		profile.meter?.wholeExactClosedOperation !== true ||
		profile.meter?.includesDiscriminator !== true ||
		!isDeepStrictEqual(profile.remoteOrder, [
			"exact-received-byte-authentication",
			"abi-match",
			"operation-byte-budget",
			"consumer",
		]) ||
		!isDeepStrictEqual(profile.localOrder, [
			"canonical-detach",
			"operation-byte-budget",
			"transaction-sign-record-outbox",
		]) ||
		profile.legacyManifestSchema1 !== "unbudgeted" ||
		Object.values(profile.claims ?? {}).some((value) => value !== false)
	) {
		fail("profile contract differs");
	}
	if (
		contract.profileId !== "blueprint-work-budget-v1" ||
		contract.blueprintDigestDomain !== "ts-drp/blueprint-admission/v3" ||
		contract.operationLimit !== 100 ||
		contract.budgetedPackage?.manifest?.schemaVersion !== 2 ||
		contract.budgetedPackage?.manifest?.workBudgetProfile !== "blueprint-work-budget-v1"
	) {
		fail("fixture identity differs");
	}
	for (const [path, expected] of Object.entries(contract.protectedArtifactSha256 ?? {})) {
		if (sha256(read(path)) !== expected) fail(`protected predecessor drift: ${path}`);
	}
	const parameters = json("packages/protocol-v3/registry/registry-v1.json").kinds?.parameters?.fields?.map(
		({ name }) => name
	);
	if (
		!isDeepStrictEqual(parameters, [
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
	const specification = read(specificationPath).toString("utf8").replace(/\s+/gu, " ");
	for (const phrase of [
		"canonical-detached whole exact closed",
		"application discriminator",
		"UTF-16 code units",
		"exact received vertex bytes",
		"before entering transaction, signing, issued-record, or outbox work",
		"Manifest schema 1 remains unbudgeted",
	]) {
		if (!specification.includes(phrase)) fail(`specification omits ${phrase}`);
	}
	const workflow = read(workflowPath).toString("utf8");
	for (const phrase of [
		"name: Protocol v3 blueprint operation budget freeze",
		"permissions:\n  contents: read",
		"ref: ${{ github.sha }}",
		"timeout-minutes: 10",
		"PHASE_0P2_IMPLEMENTATION_MODULE",
		"PHASE_0P2_MUTANT",
		"Tests  1 failed | 27 passed (28)",
		"mutant failure title mismatch",
		"protocol-v3-blueprint-runtime-0j-b.test.ts",
		"protocol-v3/scripts/check-protocol-v3-freeze.mjs",
		"protocol-v2/scripts/check-protocol-freeze.mjs",
		"--no-coverage --maxWorkers=1 --minWorkers=1",
	]) {
		if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u]) {
		if (forbidden.test(workflow)) fail(`workflow has forbidden structure: ${forbidden}`);
	}
	if (/\s-t\s/u.test(workflow)) fail("workflow targets mutant rows instead of running the full suite");
}

function validateTransition(revision) {
	git("rev-parse", "--verify", `${revision}^{commit}`);
	const atBase = protectedArtifacts.map((path) => readBase(revision, path));
	const presentCount = atBase.filter((value) => value !== undefined).length;
	if (presentCount !== 0 && presentCount !== protectedArtifacts.length) fail("bootstrap is non-atomic");
	if (presentCount === protectedArtifacts.length) {
		for (let index = 0; index < protectedArtifacts.length; index++) {
			const path = protectedArtifacts[index];
			if (sha256(atBase[index]) !== sha256(read(path))) fail(`frozen artifact changed: ${path}`);
		}
	}
}

validateCurrent();
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 blueprint operation budget freeze: PASS");
