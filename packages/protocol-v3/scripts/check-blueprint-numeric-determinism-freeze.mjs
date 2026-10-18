#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_BLUEPRINT_NUMERIC_DETERMINISM_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
		: resolve(process.env.PROTOCOL_V3_BLUEPRINT_NUMERIC_DETERMINISM_REPOSITORY_ROOT);
const documentPath = "docs/protocol/blueprint-numeric-determinism-v1.md";
const profilePath = "packages/protocol-v3/supplements/blueprint-numeric-determinism-v1/profile.json";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-blueprint-numeric-determinism-v1.json";
const checkerPath = "packages/protocol-v3/scripts/check-blueprint-numeric-determinism-freeze.mjs";
const workflowPath = ".github/workflows/protocol-v3-blueprint-numeric-determinism.yml";
const redPath = "tests/eslint-plugin-ts-drp-numeric-determinism-0n-a.test.ts";
const contractPath = "tests/fixtures/phase-0n-a-v3/numeric-determinism-contract.json";
const rulePath = "packages/eslint-plugin-ts-drp/src/index.ts";
const lintContractPath = "packages/blueprint-toolchain/contracts/no-ambient-lint-v2.json";
const toolchainPath = "packages/blueprint-toolchain/src/index.js";
const trackAuthoringPath = "tests/track-p2-a-authoring-emitter-lint-red.test.ts";
const trackCorrectivePath = "tests/track-p2-a-opus-corrective-red.test.ts";
const trackLintFixturePath = "tests/fixtures/track-p2-a/no-ambient-lint-v2.json";
const trackPreservationPath = "tests/fixtures/track-p2-a/preservation.json";
const trackMetadataPath = "tests/fixtures/track-p2-d/fixture-metadata.json";
const packagePath = "packages/protocol-v3/package.json";
const prettierIgnorePath = ".prettierignore";
const baseRef = process.argv[2];

const protectedArtifacts = Object.freeze([
	documentPath,
	profilePath,
	policyPath,
	checkerPath,
	workflowPath,
	redPath,
	contractPath,
	rulePath,
	lintContractPath,
	toolchainPath,
	trackAuthoringPath,
	trackCorrectivePath,
	trackLintFixturePath,
	trackPreservationPath,
	trackMetadataPath,
	packagePath,
	prettierIgnorePath,
]);
const hashPinnedArtifacts = Object.freeze(protectedArtifacts.filter((path) => path !== policyPath));
const bootstrapArtifacts = Object.freeze([
	documentPath,
	profilePath,
	policyPath,
	checkerPath,
	workflowPath,
	lintContractPath,
]);
const sealedRedHashes = Object.freeze({
	[redPath]: "a1cd3f34ee7a2b5858a7ed7b34f28b9bd6c010e528531b4a6575db11fddd12d2",
	[contractPath]: "50ded55cebc5e69d776e67fd9747d9c1a2a14e1008f7335127e089cd18aca4c2",
});

function fail(message) {
	throw new Error(`protocol-v3 blueprint numeric determinism freeze violation: ${message}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function readWorking(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or not a regular file`);
	return readFileSync(absolute);
}

function readJson(path) {
	try {
		const value = JSON.parse(readWorking(path).toString("utf8"));
		if (!isRecord(value)) fail(`${path} must contain an object`);
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

function validateWorkflow(source) {
	for (const fragment of [
		"name: Protocol v3 blueprint numeric determinism freeze",
		"permissions:\n  contents: read",
		"fetch-depth: 0",
		"BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		'git show "$BASE_SHA:$CHECKER"',
		"check-blueprint-numeric-determinism-freeze.mjs",
		"tests/eslint-plugin-ts-drp-numeric-determinism-0n-a.test.ts",
		"--coverage.enabled=false --exclude '.logs/**'",
	]) {
		if (!source.includes(fragment)) fail(`workflow omits required structure: ${fragment}`);
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /^\s+[A-Za-z-]+:\s+write\s*$/mu]) {
		if (forbidden.test(source)) fail(`workflow contains forbidden structure: ${forbidden}`);
	}
}

function validateCurrentBundle(runningCheckerBytes) {
	const policy = readJson(policyPath);
	const profile = readJson(profilePath);
	const contract = readJson(contractPath);
	const lintContract = readJson(lintContractPath);
	if (
		policy.schemaVersion !== "ts-drp-blueprint-numeric-determinism-freeze-v1" ||
		policy.profileId !== "blueprint-numeric-determinism-v1" ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("freeze policy identity or protected surface differs");
	}
	if (
		!isRecord(policy.artifactSha256) ||
		!isDeepStrictEqual(Object.keys(policy.artifactSha256).sort(), [...hashPinnedArtifacts].sort())
	) {
		fail("artifact hash key set differs");
	}
	for (const path of hashPinnedArtifacts) {
		if (!isDigest(policy.artifactSha256[path]) || policy.artifactSha256[path] !== sha256(readWorking(path))) {
			fail(`artifact hash binding differs: ${path}`);
		}
	}
	if (
		policy.checkerSha256 !== policy.artifactSha256[checkerPath] ||
		policy.checkerSha256 !== sha256(runningCheckerBytes)
	) {
		fail("running checker differs from its self-pin");
	}
	for (const [path, digest] of Object.entries(sealedRedHashes)) {
		if (policy.artifactSha256[path] !== digest) fail(`sealed RED hash differs: ${path}`);
	}
	if (
		profile.schemaVersion !== "ts-drp-blueprint-numeric-determinism-v1" ||
		profile.profileId !== "blueprint-numeric-determinism-v1" ||
		profile.protocolMajor !== 3 ||
		profile.baseProfile !== "ts-drp-blueprint-artifact-profile-v1" ||
		profile.ruleId !== contract.ruleId ||
		profile.ruleId !== lintContract.ruleId ||
		profile.lintContract !== lintContractPath ||
		!isDeepStrictEqual(profile.forbiddenMathMembers, contract.forbiddenMathMembers) ||
		!isDeepStrictEqual(profile.retainedMathMembers, contract.retainedMathMembers) ||
		!isDeepStrictEqual(profile.localeSensitiveMembers, contract.localeSensitiveMembers) ||
		!isDeepStrictEqual(profile.dynamicCallForms, contract.dynamicCallForms) ||
		!isDeepStrictEqual(profile.exponentiationOperators, ["**", "**="])
	) {
		fail("profile and RED contract differ");
	}
	for (const [pathKey, digestKey] of [
		["profilePath", "profileSha256"],
		["productionLintContractPath", "productionLintContractSha256"],
		["fixtureLintContractPath", "fixtureLintContractSha256"],
	]) {
		const path = profile.frozenV1?.[pathKey];
		const digest = profile.frozenV1?.[digestKey];
		if (typeof path !== "string" || !isDigest(digest) || sha256(readWorking(path)) !== digest) {
			fail(`frozen v1 binding differs: ${String(pathKey)}`);
		}
	}
	if (
		profile.claims?.publisherEligibilityOnly !== true ||
		profile.claims?.runtimeExport !== false ||
		profile.claims?.runtimeImport !== false ||
		profile.claims?.deterministicMathImplementation !== false ||
		profile.claims?.bundlingContract !== false ||
		profile.claims?.crossEngineCertification !== false ||
		profile.claims?.protocolV2Change !== false
	) {
		fail("profile claims differ");
	}
	if (
		lintContract.schemaVersion !== 2 ||
		!isDeepStrictEqual(lintContract.messages, { ...lintContract.messages, ...contract.messages })
	) {
		fail("additive lint contract differs");
	}
	const metadata = readJson(trackMetadataPath);
	if (
		metadata.ruleSourceSha256 !== sha256(readWorking(rulePath)) ||
		metadata.lintContractSha256 !== sha256(readWorking(lintContractPath))
	) {
		fail("Track P2-d metadata binding differs");
	}
	const packageManifest = readJson(packagePath);
	if (
		!Array.isArray(packageManifest.files) ||
		!packageManifest.files.includes("supplements/blueprint-numeric-determinism-v1")
	) {
		fail("protocol-v3 package omits the numeric determinism supplement");
	}
	const document = readWorking(documentPath).toString("utf8");
	for (const phrase of [
		"publisher applies `drp/no-ambient-in-reducer` to both TypeScript source and the exact copied ESM artifact",
		"does not alter the frozen v1 artifact profile",
		"No deterministic-math implementation is introduced here",
		"bundled into the self-contained artifact",
		"certified across every shipped engine against an independent oracle",
	]) {
		if (!document.includes(phrase)) fail(`rationale omits ${phrase}`);
	}
	validateWorkflow(readWorking(workflowPath).toString("utf8"));
}

function validateTransition(revision) {
	git("rev-parse", "--verify", `${revision}^{commit}`);
	const basePolicy = readBase(revision, policyPath);
	if (basePolicy === undefined) {
		for (const path of bootstrapArtifacts) {
			if (path !== lintContractPath && readBase(revision, path) !== undefined)
				fail(`bootstrap artifact already exists: ${path}`);
		}
		if (readBase(revision, lintContractPath) !== undefined)
			fail("v2 lint contract exists before the atomic supplement");
		for (const [path, digest] of Object.entries(sealedRedHashes)) {
			const bytes = readBase(revision, path);
			if (bytes !== undefined && sha256(bytes) !== digest) fail(`bootstrap RED differs: ${path}`);
		}
		return;
	}
	const policy = JSON.parse(basePolicy.toString("utf8"));
	if (!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)) fail("base protected surface differs");
	for (const path of protectedArtifacts) {
		const base = readBase(revision, path);
		if (base === undefined || sha256(base) !== sha256(readWorking(path)))
			fail(`frozen artifact changed from base: ${path}`);
	}
}

const runningCheckerBytes = readWorking(checkerPath);
validateCurrentBundle(runningCheckerBytes);
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 blueprint numeric determinism freeze: PASS");
