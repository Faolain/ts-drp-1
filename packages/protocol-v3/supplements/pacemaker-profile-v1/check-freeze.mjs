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
	process.env.PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT);
const require = createRequire(resolve(repositoryRoot, "package.json"));
const { parse: parseYaml } = require("yaml");

const supplementRoot = "packages/protocol-v3/supplements/pacemaker-profile-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const schemaPath = `${supplementRoot}/schema.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const vectorsPath = `${supplementRoot}/vectors.json`;
const workflowPath = ".github/workflows/protocol-v3-pacemaker-profile.yml";
const redTestPath = "tests/phase-5d-pacemaker-law-red.test.ts";
const redContractPath = "tests/fixtures/phase-5d-v3/pacemaker-law-contract.json";
const decisionBlockStart = "<!-- PH-P5-D02:BEGIN -->";
const decisionBlockEnd = "<!-- PH-P5-D02:END -->";

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
const actionPins = Object.freeze({
	checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
	java: "actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961",
	node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
	pnpm: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
});

function fail(code, detail) {
	throw new Error(`protocol-v3 pacemaker profile freeze violation [${code}]: ${detail}`);
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

function parseNormativeDecision(specification) {
	if (
		specification.split(decisionBlockStart).length - 1 !== 1 ||
		specification.split(decisionBlockEnd).length - 1 !== 1
	) {
		fail("NORMATIVE_DECISION_BLOCK_COUNT", "PH-P5-D02 block must occur once");
	}
	const start = specification.indexOf(decisionBlockStart) + decisionBlockStart.length;
	const end = specification.indexOf(decisionBlockEnd, start);
	const match = /^```json\n(?<json>[\s\S]+)\n```$/u.exec(specification.slice(start, end).trim());
	if (match?.groups?.json === undefined) {
		fail("NORMATIVE_DECISION_BLOCK_FORMAT", "PH-P5-D02 block must be one JSON fence");
	}
	return parseJson(Buffer.from(match.groups.json), "PH-P5-D02 normative block");
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
		'git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-pacemaker-profile-base.mjs"',
		'PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\',
		'node "$RUNNER_TEMP/check-pacemaker-profile-base.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$POLICY" \\',
		'&& ! git cat-file -e "$BASE_SHA:$PROFILE" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SCHEMA" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SPECIFICATION" \\',
		'&& ! git cat-file -e "$BASE_SHA:$VECTORS" \\',
		'&& ! git cat-file -e "$BASE_SHA:$WORKFLOW" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_TEST" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_CONTRACT"; then',
		'PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"',
		"else",
		'echo "Pacemaker profile bootstrap is fail-closed and atomic." >&2',
		"exit 1",
		"fi",
		'PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"',
	];
}

function expectedProfile(contract) {
	const requirements = contract.decision.requirements;
	return {
		bundleCutValue: requirements.bundleCutValue,
		decisionId: contract.decision.id,
		highestPrepareQCCustody: requirements.highestPrepareQCCustody,
		highestPrepareQCSelection: requirements.highestPrepareQCSelection,
		leaderOrdering: requirements.leaderOrdering,
		maxFutureRoundGap: requirements.maxFutureRoundGap,
		newRoundCertificate: requirements.newRoundCertificate,
		profileId: contract.decision.profileId,
		proposalAuthentication: requirements.proposalAuthentication,
		protocolMajor: contract.decision.protocolMajor,
		registryVersion: contract.decision.registryVersion,
		roundChangeDisposition: requirements.roundChangeDisposition,
		roundTimeoutBaseMs: requirements.roundTimeoutBaseMs,
		roundTimeoutMaxMs: requirements.roundTimeoutMaxMs,
		sealVotePhases: requirements.sealVotePhases,
	};
}

function expectedSchema(profile) {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://drp.tech/schema/protocol-v3/pacemaker-profile-v1.json",
		title: "Protocol v3 pacemaker profile",
		type: "object",
		additionalProperties: false,
		required: Object.keys(profile),
		properties: Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, { const: value }])),
	};
}

function validateWorkflow(source, contract) {
	const document = parseYaml(source);
	if (!isRecord(document) || !isDeepStrictEqual(Object.keys(document.on ?? {}), ["pull_request"])) {
		fail("WORKFLOW_TRIGGER", "workflow must be pull-request-only");
	}
	if (!isDeepStrictEqual(document.permissions, contract.workflowContract.permissions)) {
		fail("WORKFLOW_PERMISSIONS", "workflow permissions differ");
	}
	if (!isRecord(document.jobs) || Object.keys(document.jobs).length !== 1) {
		fail("WORKFLOW_JOB_ROSTER", "workflow must contain exactly one job");
	}
	const job = Object.values(document.jobs)[0];
	if (!isRecord(job) || !Array.isArray(job.steps)) fail("WORKFLOW_JOB_SHAPE", "workflow job is malformed");
	if (!isDeepStrictEqual(job.permissions, contract.workflowContract.permissions)) {
		fail("WORKFLOW_PERMISSIONS", "job permissions differ");
	}
	const findUse = (value) => job.steps.find((step) => isRecord(step) && step.uses === value);
	const checkout = findUse(actionPins.checkout);
	const node = findUse(actionPins.node);
	const pnpm = findUse(actionPins.pnpm);
	const java = findUse(actionPins.java);
	const install = job.steps.find(
		(step) => isRecord(step) && String(step.run ?? "").trim() === contract.workflowContract.installCommand
	);
	const freeze = job.steps.find((step) => isRecord(step) && step.env?.CHECKER === checkerPath);
	const formal = job.steps.find(
		(step) => isRecord(step) && step.env?.FORMAL_MODEL === contract.workflowContract.formalModel
	);
	if (
		!isRecord(checkout) ||
		!isDeepStrictEqual(checkout.with, {
			"fetch-depth": contract.workflowContract.fetchDepth,
			"ref": contract.workflowContract.checkoutRef,
		}) ||
		!isRecord(node) ||
		!isDeepStrictEqual(node.with, { "node-version": contract.workflowContract.nodeVersion }) ||
		!isRecord(pnpm) ||
		!isDeepStrictEqual(pnpm.with, { version: contract.workflowContract.pnpmVersion }) ||
		!isRecord(java) ||
		!isDeepStrictEqual(java.with, {
			"distribution": contract.workflowContract.javaDistribution,
			"java-version": contract.workflowContract.javaVersion,
		}) ||
		!isRecord(install) ||
		!isRecord(freeze) ||
		!isRecord(formal)
	) {
		fail("WORKFLOW_TOOLCHAIN", "pinned workflow toolchain differs");
	}
	const ordered = [checkout, node, pnpm, install, java, freeze, formal].map((step) => job.steps.indexOf(step));
	if (
		ordered.some((index) => index < 0) ||
		!isDeepStrictEqual(
			ordered,
			[...ordered].sort((a, b) => a - b)
		)
	) {
		fail("WORKFLOW_ORDER", "toolchain, freeze, and formal steps are out of order");
	}
	const expectedEnvironment = {
		BASE_SHA: contract.workflowContract.baseSha,
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
	if (!isDeepStrictEqual(freeze.env, expectedEnvironment)) fail("WORKFLOW_ENVIRONMENT", "freeze environment differs");
	if (!isDeepStrictEqual(normalizedShellLines(freeze.run ?? ""), expectedFreezeShellLines())) {
		fail("WORKFLOW_ROUTING", "base-then-current checker routing differs");
	}
	if (
		!isDeepStrictEqual(formal.env, {
			APALACHE_VERSION: contract.workflowContract.apalacheVersion,
			FORMAL_MODEL: contract.workflowContract.formalModel,
		}) ||
		!isDeepStrictEqual(normalizedShellLines(formal.run ?? ""), [
			'if [ -f "$FORMAL_MODEL" ]; then',
			"pnpm run phase5d:formal",
			"else",
			'echo "Phase 5d formal model is not present yet; formal success is not claimed."',
			"fi",
		])
	) {
		fail("WORKFLOW_FORMAL_GATE", "conditional formal gate differs");
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u]) {
		if (forbidden.test(source)) fail("WORKFLOW_FORBIDDEN_AUTHORITY", String(forbidden));
	}
}

function validateBaseTuple(contract) {
	for (const [path, digest] of Object.entries(contract.baseTupleSha256)) {
		if (sha256(readWorking(path)) !== digest) fail("BASE_TUPLE_DRIFT", path);
	}
}

function validateCurrentBundle() {
	const directory = resolve(repositoryRoot, supplementRoot);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) fail("SUPPLEMENT_ABSENT", supplementRoot);
	if (!isDeepStrictEqual(readdirSync(directory).sort(), [...requiredSupplementFiles].sort())) {
		fail("SUPPLEMENT_ROSTER", "supplement directory file set differs");
	}
	const checkerBytes = readWorking(checkerPath);
	const policy = parseJson(readWorking(policyPath), policyPath);
	const profile = parseJson(readWorking(profilePath), profilePath);
	const schema = parseJson(readWorking(schemaPath), schemaPath);
	const vectors = parseJson(readWorking(vectorsPath), vectorsPath);
	const contract = parseJson(readWorking(redContractPath), redContractPath);
	const projection = expectedProfile(contract);
	if (!isDeepStrictEqual(profile, projection) || !isDeepStrictEqual(profile, contract.profile)) {
		fail("PROFILE_IDENTITY", "profile differs from PH-P5-D02 projection");
	}
	if (!isDeepStrictEqual(vectors, contract.vectors)) fail("VECTOR_IDENTITY", "vector corpus differs");
	if (!isDeepStrictEqual(schema, expectedSchema(profile))) fail("SCHEMA_IDENTITY", "closed profile schema differs");
	if (!isDeepStrictEqual(parseNormativeDecision(readWorking(specificationPath).toString("utf8")), contract.decision)) {
		fail("SEMANTIC_DECISION_MISMATCH", "normative PH-P5-D02 block differs");
	}
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
		policy.schemaVersion !== "ts-drp-pacemaker-profile-freeze-v1" ||
		policy.profile !== contract.decision.profileId ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("PROTECTED_ARTIFACT_ROSTER_MISMATCH", "freeze policy identity or roster differs");
	}
	if (policy.checkerSha256 !== sha256(checkerBytes)) fail("BASE_CHECKER_REQUIRED", "checker hash binding differs");
	if (!sameKeys(policy.artifactSha256, hashPinnedArtifacts)) {
		fail("PROTECTED_ARTIFACT_ROSTER_MISMATCH", "artifact hash key set differs");
	}
	for (const path of hashPinnedArtifacts) {
		if (policy.artifactSha256[path] !== sha256(readWorking(path))) fail("PROTECTED_ARTIFACT_DRIFT", path);
	}
	validateWorkflow(readWorking(workflowPath).toString("utf8"), contract);
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
	const tree = execFileSync("git", ["ls-tree", "-r", "--full-tree", baseRef, "--", ...protectedArtifacts], {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const baseBlobs = new Map(
		tree
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const match = /^(?<mode>\d+) blob (?<blob>[0-9a-f]{40})\t(?<path>.+)$/u.exec(line);
				if (match?.groups?.path === undefined || match.groups.blob === undefined) {
					fail("BASE_CHECKER_REQUIRED", "base protected tree is malformed");
				}
				return [match.groups.path, match.groups.blob];
			})
	);
	const presentCount = baseBlobs.size;
	if (presentCount === 0) return;
	if (presentCount !== protectedArtifacts.length) {
		fail("BASE_CHECKER_REQUIRED", "protected owner existed only partially at base");
	}
	const workingBlobs = execFileSync("git", ["hash-object", "--no-filters", "--", ...protectedArtifacts], {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	})
		.trim()
		.split("\n");
	for (let index = 0; index < protectedArtifacts.length; index++) {
		const path = protectedArtifacts[index];
		if (baseBlobs.get(path) !== workingBlobs[index]) {
			if (path === checkerPath) fail("BASE_CHECKER_REQUIRED", "current checker differs from trusted base");
			fail("PROTECTED_ARTIFACT_DRIFT", path);
		}
	}
}

validateCurrentBundle();
const baseRef = process.argv[2];
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 pacemaker profile freeze: PASS");
