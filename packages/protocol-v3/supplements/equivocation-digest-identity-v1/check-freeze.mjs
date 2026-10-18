#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_EQUIVOCATION_DIGEST_IDENTITY_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_EQUIVOCATION_DIGEST_IDENTITY_REPOSITORY_ROOT);

const supplementRoot = "packages/protocol-v3/supplements/equivocation-digest-identity-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const modelPath = `${supplementRoot}/equivocation-digest-identity.qnt`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-equivocation-digest-identity.yml";
const redPath = "tests/protocol-v3-equivocation-0o.test.ts";
const contractPath = "tests/fixtures/phase-0o-v3/equivocation-contract.json";

const requiredSupplementFiles = Object.freeze([
	"check-freeze.mjs",
	"equivocation-digest-identity.qnt",
	"freeze-policy.json",
	"profile.json",
	"spec.md",
]);
const protectedArtifacts = Object.freeze([
	checkerPath,
	modelPath,
	policyPath,
	profilePath,
	specificationPath,
	workflowPath,
	redPath,
	contractPath,
]);
const hashPinnedArtifacts = Object.freeze([
	modelPath,
	profilePath,
	specificationPath,
	workflowPath,
	redPath,
	contractPath,
]);
const frozenD37 = Object.freeze({
	modelSha256: "7971a025959164f609f4509bf4242f94fc4cc0b6974dde903bf462852983f038",
	testSha256: "affc5e439220e8ac6353c0795f591da3946a6aeb37d69a71a05763f229f34f6d",
	fixtureSha256: "474c83e7a3f130504e8dedc8ceb0843ee3413ca56c27003a354f6088b0f41dcf",
	derivationSha256: "e693b3fec5ef0d73299642d49e5ab7fdc969df80214f1d9891a05e188d1b7346",
});
const frozenD37Paths = Object.freeze({
	modelSha256: "packages/protocol-v3/formal/author-lineage-actions.qnt",
	testSha256: "tests/protocol-v3-formal-action-model-n1prime-a.test.ts",
	fixtureSha256: "tests/fixtures/phase-n1prime-a/formal-action-contract.json",
	derivationSha256: "packages/protocol-v3/formal/signed-field-derivation.json",
});
const profileIdentity = Object.freeze({
	frozenD37,
	profileId: "equivocation-digest-identity-v1",
	proofDomain: "ts-drp/equivocation-proof/v1",
	slotAdvisory: Object.freeze({
		crossSlotAndRetentionOwner: "phase-0o-b",
		scope: "per-slot-advisory-signal-only",
		slotDurabilityOwner: "injected-transaction-store",
	}),
	vertexIdentity: "exact-authenticated-canonical-preimage-digest",
});
const expectedQuintTests = Object.freeze([
	"testSameDigestRecarrierIsDuplicate",
	"testDependencyForkIsEquivocation",
	"testLogicalTimeForkIsEquivocation",
	"testExactlyThreeUnorderedProofPairs",
]);

function fail(message) {
	throw new Error(`protocol-v3 equivocation digest identity freeze violation: ${message}`);
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
		if (!isRecord(parsed)) fail(`${label} must contain an object`);
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${label} is not valid JSON`);
		throw error;
	}
}

function readWorking(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or not a regular file`);
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

function validateFrozenD37() {
	for (const [field, path] of Object.entries(frozenD37Paths)) {
		if (sha256(readWorking(path)) !== frozenD37[field]) fail(`frozen D.37 drift at ${path}`);
	}
}

function validateWorkflow(source) {
	for (const fragment of [
		"name: Protocol v3 equivocation digest identity freeze",
		"pull_request:",
		"fetch-depth: 0",
		"pnpm/action-setup@v4",
		"pnpm install --frozen-lockfile",
		"BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		`CHECKER: ${checkerPath}`,
		`POLICY: ${policyPath}`,
		'git show "$BASE_SHA:$CHECKER"',
		'node "$RUNNER_TEMP/check-equivocation-digest-identity-freeze.mjs" "$BASE_SHA"',
		`node ${checkerPath} "$BASE_SHA"`,
	]) {
		if (!source.includes(fragment)) fail(`workflow omits required structure: ${fragment}`);
	}
	for (const forbidden of [
		/\bpull_request_target\b/u,
		/\bcontinue-on-error\b/u,
		/^\s*permissions:\s*write-all\s*$/mu,
		/^\s+[A-Za-z-]+:\s+write\s*$/mu,
	]) {
		if (forbidden.test(source)) fail(`workflow contains forbidden structure: ${forbidden}`);
	}
}

function validateQuintTestOutput(output) {
	const normalizedOutput = output.replaceAll("\\n", "\n");
	const namedResults = normalizedOutput
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.map((line) => /^ok ([A-Za-z][A-Za-z0-9]*) passed ([0-9]+) test\(s\)$/u.exec(line))
		.filter((match) => match !== null);
	if (
		namedResults.length !== expectedQuintTests.length ||
		!isDeepStrictEqual(
			namedResults.map((match) => match[1]),
			expectedQuintTests
		) ||
		namedResults.some((match) => match[2] !== "1")
	) {
		fail("bounded Quint tests did not report the exact expected one-sample test set");
	}
	const totals = normalizedOutput.match(/^\s*4 passing \([^)]+\)\s*$/gmu) ?? [];
	if (totals.length !== 1) fail("bounded Quint tests did not report exactly one total of 4 passing");
}

function validateModelExecution() {
	try {
		execFileSync("pnpm", ["exec", "quint", "typecheck", modelPath], {
			cwd: repositoryRoot,
			stdio: "pipe",
			timeout: 30_000,
		});
		const testOutput = execFileSync(
			"pnpm",
			[
				"exec",
				"quint",
				"test",
				modelPath,
				"--main",
				"equivocationDigestIdentity",
				"--seed",
				"0x0e0110ca",
				"--max-samples",
				"1",
				"--match",
				"^test",
				"--backend",
				"typescript",
			],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				timeout: 30_000,
			}
		);
		validateQuintTestOutput(testOutput);
	} catch {
		fail("bounded Quint model typecheck or tests failed");
	}
}

function validateCurrentBundle() {
	const supplementDirectory = resolve(repositoryRoot, supplementRoot);
	if (!existsSync(supplementDirectory) || !statSync(supplementDirectory).isDirectory()) {
		fail("supplement directory is absent");
	}
	if (!isDeepStrictEqual(readdirSync(supplementDirectory).sort(), [...requiredSupplementFiles].sort())) {
		fail("supplement directory file set differs");
	}

	const checkerBytes = readWorking(checkerPath);
	const policy = parseJson(readWorking(policyPath), policyPath);
	const profile = parseJson(readWorking(profilePath), profilePath);
	if (!sameKeys(profile, Object.keys(profileIdentity)) || !isDeepStrictEqual(profile, profileIdentity)) {
		fail("profile identity or ownership differs");
	}
	if (
		!sameKeys(policy, [
			"schemaVersion",
			"profile",
			"checker",
			"workflow",
			"frozenD37",
			"protectedArtifacts",
			"checkerSha256",
			"artifactSha256",
		]) ||
		policy.schemaVersion !== "ts-drp-equivocation-digest-identity-freeze-v1" ||
		policy.profile !== profileIdentity.profileId ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.frozenD37, frozenD37) ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("freeze policy identity or protected surface differs");
	}
	if (policy.checkerSha256 !== sha256(checkerBytes)) fail("checker hash binding differs");
	if (!sameKeys(policy.artifactSha256, hashPinnedArtifacts)) fail("artifact hash key set differs");
	for (const path of hashPinnedArtifacts) {
		if (policy.artifactSha256[path] !== sha256(readWorking(path))) fail(`artifact hash binding differs: ${path}`);
	}

	validateFrozenD37();
	const specification = readWorking(specificationPath).toString("utf8");
	for (const fragment of ["same digest", "signature carrier", "unordered digest pair", "O(forks²)", "Phase 0o-b"]) {
		if (!specification.includes(fragment)) fail(`specification omits ${fragment}`);
	}
	if (specification.includes("Phase 0p")) fail("specification assigns equivocation ownership to Phase 0p");

	const model = readWorking(modelPath).toString("utf8");
	for (const fragment of [
		"module equivocationDigestIdentity",
		"sameOperationDifferentDependencies",
		"sameOperationDifferentLogicalTime",
		"sameDigestDifferentSignatureCarrier",
	]) {
		if (!model.includes(fragment)) fail(`model omits ${fragment}`);
	}
	if (model.includes("module authorLineageActions")) fail("supplement model reuses the frozen D.37 module name");
	validateModelExecution();
	validateWorkflow(readWorking(workflowPath).toString("utf8"));
}

function validateTransition(baseRef) {
	const base = protectedArtifacts.map((path) => readBase(baseRef, path));
	const presentCount = base.filter((bytes) => bytes !== undefined).length;
	if (presentCount === 0) return;
	if (presentCount !== protectedArtifacts.length) fail("protected supplement existed only partially at base");
	for (let index = 0; index < protectedArtifacts.length; index++) {
		const path = protectedArtifacts[index];
		if (sha256(base[index]) !== sha256(readWorking(path))) fail(`protected supplement drift: ${path}`);
	}
}

validateCurrentBundle();
const baseRef = process.argv[2];
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 equivocation digest identity freeze: PASS");
