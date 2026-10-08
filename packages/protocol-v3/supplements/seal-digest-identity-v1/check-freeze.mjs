#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT);
const require = createRequire(resolve(repositoryRoot, "package.json"));
const { parse: parseYaml } = require("yaml");

const supplementRoot = "packages/protocol-v3/supplements/seal-digest-identity-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const schemaPath = `${supplementRoot}/schema.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const vectorsPath = `${supplementRoot}/vectors.json`;
const workflowPath = ".github/workflows/protocol-v3-seal-digest-identity.yml";
const redTestPath = "tests/phase-5a-seal-digest-law-red.test.ts";
const redContractPath = "tests/fixtures/phase-5-v3/seal-digest-law-contract.json";
const decisionBlockStart = "<!-- PH-P5-D01:BEGIN -->";
const decisionBlockEnd = "<!-- PH-P5-D01:END -->";

const requiredSupplementFiles = Object.freeze([
	"check-freeze.mjs",
	"freeze-policy.json",
	"profile.json",
	"schema.json",
	"spec.md",
	"vectors.json",
]);
const protectedArtifacts = Object.freeze([
	checkerPath,
	policyPath,
	profilePath,
	schemaPath,
	specificationPath,
	vectorsPath,
	workflowPath,
	redTestPath,
	redContractPath,
]);
const hashPinnedArtifacts = Object.freeze(
	protectedArtifacts.filter((path) => path !== checkerPath && path !== policyPath)
);
const baseTupleSha256 = Object.freeze({
	"docs/protocol/amendments-v3.json": "e83625828b38ae398cfdb8e8aa4d404ce90e64a43884b248a4d928e14a392508",
	"docs/protocol/attested-hard-epochs-v5.md": "a2d1c818eecf4524aac60d102aded73eafdab8cb613e7a53a91d79fff9ac9db8",
	"packages/protocol-v3/conformance/vectors/registry-v1.json":
		"8b84504ae98b37beae2d91ef8fa29f9a61299a236d32a12b63f24cb2757da741",
	"packages/protocol-v3/formal/registry-model-signoff.json":
		"9b93fd6d843817a2e59309f11cba049d129ed5e862e26bc3706d3f4d1fdc5749",
	"packages/protocol-v3/registry/registry-v1.json": "2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9",
	"packages/protocol-v3/registry/registry-v1.schema.json":
		"6ab6f377457cbe43d79c0aee4b766683c7c202cd308481db66f04e723787fbdc",
});
const expectedProfile = Object.freeze({
	decisionId: "PH-P5-D01",
	digestIdentities: Object.freeze({
		cutValueDigest: "hash-domain-exact-cut-value-bytes",
		proposalHash: "hash-domain-exact-seal-proposal-bytes",
		qcProposalDigest: "valueDigest",
		sealProposalValueDigest: "valueDigest",
		sealVoteProposalDigest: "valueDigest",
	}),
	lockIdentity: "valueDigest",
	profileId: "seal-digest-identity-v1",
	protocolMajor: 3,
	registryVersion: 1,
	roundChangeDisposition: "separate-kind-deferred-phase-5d",
	sameValueRoundCarryover: true,
});

function fail(code, detail) {
	throw new Error(`protocol-v3 seal digest identity freeze violation [${code}]: ${detail}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, keys) {
	return isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function parseJson(bytes, label) {
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(parsed)) fail("JSON_OBJECT_REQUIRED", `${label} must contain an object`);
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) fail("JSON_INVALID", `${label} is not valid JSON`);
		throw error;
	}
}

function readWorking(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) {
		fail("PROTECTED_ARTIFACT_ABSENT", `${path} is absent or not a regular file`);
	}
	return readFileSync(absolute);
}

function readBase(baseRef, path) {
	try {
		return execFileSync("git", ["show", `${baseRef}:${path}`], {
			cwd: repositoryRoot,
			encoding: null,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function parseNormativeDecision(specification) {
	const starts = specification.split(decisionBlockStart).length - 1;
	const ends = specification.split(decisionBlockEnd).length - 1;
	if (starts !== 1 || ends !== 1) fail("NORMATIVE_DECISION_BLOCK_COUNT", "PH-P5-D01 block must occur once");
	const start = specification.indexOf(decisionBlockStart) + decisionBlockStart.length;
	const end = specification.indexOf(decisionBlockEnd, start);
	const body = specification.slice(start, end).trim();
	const match = /^```json\n(?<json>[\s\S]+)\n```$/u.exec(body);
	if (match?.groups?.json === undefined) {
		fail("NORMATIVE_DECISION_BLOCK_FORMAT", "PH-P5-D01 block must be one JSON fence");
	}
	return parseJson(Buffer.from(match.groups.json), "PH-P5-D01 normative block");
}

function normalizedShellLines(source) {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function expectedFreezeShellLines() {
	return [
		'if git cat-file -e "$BASE_SHA:$CHECKER"; then',
		'git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-seal-digest-identity-base.mjs"',
		'PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\',
		'node "$RUNNER_TEMP/check-seal-digest-identity-base.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$POLICY" \\',
		'&& ! git cat-file -e "$BASE_SHA:$PROFILE" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SCHEMA" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SPECIFICATION" \\',
		'&& ! git cat-file -e "$BASE_SHA:$VECTORS" \\',
		'&& ! git cat-file -e "$BASE_SHA:$WORKFLOW" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_TEST" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_CONTRACT"; then',
		'PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"',
		"else",
		'echo "Seal digest identity bootstrap is fail-closed and atomic." >&2',
		"exit 1",
		"fi",
		'PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"',
	];
}

function validateWorkflow(source) {
	const document = parseYaml(source);
	if (!isRecord(document) || !isDeepStrictEqual(Object.keys(document.on ?? {}), ["pull_request"])) {
		fail("WORKFLOW_TRIGGER", "workflow must be pull-request-only");
	}
	if (!isDeepStrictEqual(document.permissions, { contents: "read" })) {
		fail("WORKFLOW_PERMISSIONS", "workflow permissions must be exactly contents: read");
	}
	if (!isRecord(document.jobs) || Object.keys(document.jobs).length !== 1) {
		fail("WORKFLOW_JOB_ROSTER", "workflow must contain exactly one job");
	}
	const job = Object.values(document.jobs)[0];
	if (!isRecord(job) || !Array.isArray(job.steps)) fail("WORKFLOW_JOB_SHAPE", "workflow job is malformed");
	if (!isDeepStrictEqual(job.permissions, { contents: "read" })) {
		fail("WORKFLOW_PERMISSIONS", "job permissions must be exactly contents: read");
	}
	const checkout = job.steps.find((step) => isRecord(step) && String(step.uses ?? "").startsWith("actions/checkout@"));
	if (!isRecord(checkout) || !isDeepStrictEqual(checkout.with, { "fetch-depth": 0, "ref": "${{ github.sha }}" })) {
		fail("WORKFLOW_CHECKOUT", "checkout must pin the PR head with full history");
	}
	const freeze = job.steps.find((step) => isRecord(step) && step.env?.CHECKER === checkerPath);
	const expectedEnvironment = {
		BASE_SHA: "${{ github.event.pull_request.base.sha }}",
		CHECKER: checkerPath,
		POLICY: policyPath,
		PROFILE: profilePath,
		RED_CONTRACT: redContractPath,
		RED_TEST: redTestPath,
		SCHEMA: schemaPath,
		SPECIFICATION: specificationPath,
		VECTORS: vectorsPath,
		WORKFLOW: workflowPath,
	};
	if (!isRecord(freeze) || !isDeepStrictEqual(freeze.env, expectedEnvironment)) {
		fail("WORKFLOW_ENVIRONMENT", "freeze environment differs");
	}
	if (!isDeepStrictEqual(normalizedShellLines(freeze.run ?? ""), expectedFreezeShellLines())) {
		fail("WORKFLOW_ROUTING", "base-then-current checker routing differs");
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u]) {
		if (forbidden.test(source)) fail("WORKFLOW_FORBIDDEN_AUTHORITY", String(forbidden));
	}
}

function validateSchema(schema) {
	if (
		!sameKeys(schema, ["$schema", "$id", "title", "type", "additionalProperties", "required", "properties"]) ||
		schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
		schema.type !== "object" ||
		schema.additionalProperties !== false ||
		!isRecord(schema.properties)
	) {
		fail("SCHEMA_IDENTITY", "profile schema root differs");
	}
	const required = [
		"decisionId",
		"digestIdentities",
		"lockIdentity",
		"profileId",
		"protocolMajor",
		"registryVersion",
		"roundChangeDisposition",
		"sameValueRoundCarryover",
	];
	if (!isDeepStrictEqual(schema.required, required) || !isDeepStrictEqual(Object.keys(schema.properties), required)) {
		fail("SCHEMA_ROSTER", "profile schema property roster differs");
	}
}

function validateBaseTuple(contract) {
	if (!isDeepStrictEqual(contract.baseTupleSha256, baseTupleSha256)) {
		fail("BASE_TUPLE_DRIFT", "RED contract base tuple differs");
	}
	for (const [path, digest] of Object.entries(baseTupleSha256)) {
		if (sha256(readWorking(path)) !== digest) fail("BASE_TUPLE_DRIFT", path);
	}
}

function validateCurrentBundle() {
	const directory = resolve(repositoryRoot, supplementRoot);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		fail("SUPPLEMENT_ABSENT", "supplement directory is absent");
	}
	if (!isDeepStrictEqual(readdirSync(directory).sort(), [...requiredSupplementFiles].sort())) {
		fail("SUPPLEMENT_ROSTER", "supplement directory file set differs");
	}

	const checkerBytes = readWorking(checkerPath);
	const policy = parseJson(readWorking(policyPath), policyPath);
	const profile = parseJson(readWorking(profilePath), profilePath);
	const schema = parseJson(readWorking(schemaPath), schemaPath);
	const vectors = parseJson(readWorking(vectorsPath), vectorsPath);
	const contract = parseJson(readWorking(redContractPath), redContractPath);
	if (!isDeepStrictEqual(profile, expectedProfile) || !isDeepStrictEqual(profile, contract.profile)) {
		fail("PROFILE_IDENTITY", "profile differs from PH-P5-D01");
	}
	if (!isDeepStrictEqual(vectors, contract.vectors)) fail("VECTOR_IDENTITY", "vector corpus differs");
	if (!isDeepStrictEqual(parseNormativeDecision(readWorking(specificationPath).toString("utf8")), contract.decision)) {
		fail("SEMANTIC_DECISION_MISMATCH", "normative PH-P5-D01 block differs");
	}
	validateSchema(schema);
	validateBaseTuple(contract);

	if (
		!sameKeys(policy, [
			"schemaVersion",
			"profile",
			"checker",
			"workflow",
			"protectedArtifacts",
			"checkerSha256",
			"artifactSha256",
		]) ||
		policy.schemaVersion !== "ts-drp-seal-digest-identity-freeze-v1" ||
		policy.profile !== expectedProfile.profileId ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("PROTECTED_ARTIFACT_ROSTER_MISMATCH", "freeze policy identity or roster differs");
	}
	if (policy.checkerSha256 !== sha256(checkerBytes)) {
		fail("BASE_CHECKER_REQUIRED", "checker hash binding differs");
	}
	if (!sameKeys(policy.artifactSha256, hashPinnedArtifacts)) {
		fail("PROTECTED_ARTIFACT_ROSTER_MISMATCH", "artifact hash key set differs");
	}
	for (const path of hashPinnedArtifacts) {
		if (policy.artifactSha256[path] !== sha256(readWorking(path))) {
			fail("PROTECTED_ARTIFACT_DRIFT", path);
		}
	}
	validateWorkflow(readWorking(workflowPath).toString("utf8"));
}

function validateTransition(baseRef) {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], {
			cwd: repositoryRoot,
			stdio: ["ignore", "ignore", "ignore"],
		});
	} catch {
		fail("BASE_CHECKER_REQUIRED", "base revision does not resolve to a commit");
	}
	const base = protectedArtifacts.map((path) => readBase(baseRef, path));
	const presentCount = base.filter((bytes) => bytes !== undefined).length;
	if (presentCount === 0) return;
	if (presentCount !== protectedArtifacts.length) {
		fail("BASE_CHECKER_REQUIRED", "protected owner existed only partially at base");
	}
	for (let index = 0; index < protectedArtifacts.length; index++) {
		const path = protectedArtifacts[index];
		const baseBytes = base[index];
		if (baseBytes === undefined) fail("BASE_CHECKER_REQUIRED", `base omitted ${path}`);
		if (sha256(baseBytes) !== sha256(readWorking(path))) {
			if (path === checkerPath) fail("BASE_CHECKER_REQUIRED", "current checker differs from trusted base");
			fail("PROTECTED_ARTIFACT_DRIFT", path);
		}
	}
}

validateCurrentBundle();
const baseRef = process.argv[2];
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 seal digest identity freeze: PASS");
