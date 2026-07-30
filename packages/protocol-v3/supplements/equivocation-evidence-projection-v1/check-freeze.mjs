#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_EQUIVOCATION_EVIDENCE_PROJECTION_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_EQUIVOCATION_EVIDENCE_PROJECTION_REPOSITORY_ROOT);

const supplementRoot = "packages/protocol-v3/supplements/equivocation-evidence-projection-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-equivocation-evidence-projection.yml";
const redPath = "tests/protocol-v3-equivocation-projection-0o-b1a.test.ts";
const fixtureRoot = "tests/fixtures/phase-0o-b1a-v3";
const contractPath = `${fixtureRoot}/projection-contract.json`;
const controlledPath = `${fixtureRoot}/controlled-equivocation-projection.ts`;
const publicMutantPath = `${fixtureRoot}/public-reexport-mutant.ts`;
const sourceAuditPath = `${fixtureRoot}/public-entry-type-audit.ts`;
const builtAuditPath = `${fixtureRoot}/built-package-type-audit.ts`;
const sourceAuditConfigPath = `${fixtureRoot}/tsconfig.public-entry-audit.json`;
const builtAuditConfigPath = `${fixtureRoot}/tsconfig.built-package-audit.json`;

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
]);
const hashPinnedArtifacts = Object.freeze(
	protectedArtifacts.filter((path) => path !== checkerPath && path !== policyPath)
);
const frozenBaseArtifacts = Object.freeze({
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/check-freeze.mjs":
		"99077789ba33c3ab074d860332a71d67cacefc1ffd2c3e86f852176c15e81a57",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/equivocation-digest-identity.qnt":
		"653d5f4c459a3380744ee155b21985dfa005144a09e43fafec425ca0a99cee2d",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/freeze-policy.json":
		"14310e7a599cc0cf7bdcb7568de0935a691f927d8c543b1a965ded7f9e33a181",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/profile.json":
		"542a28c5d858d346a61d08da0b89ecc1ce3526ecf923f237b3e2e53ac9877fb6",
	"packages/protocol-v3/supplements/equivocation-digest-identity-v1/spec.md":
		"44ea9cb169db2e9c0628fda1bd7b25c6519c0e7fdcca9c6436fe14d482026abb",
	".github/workflows/protocol-v3-equivocation-digest-identity.yml":
		"e4ea99b91077baa0d4578fbea15107cd0103d989a283fb01c4dc95acefdf2c0a",
	"tests/protocol-v3-equivocation-0o.test.ts": "5a3066fe2dce562c547a66834435dab162a91c42414b4c1c4a099cb8f6c73198",
	"tests/fixtures/phase-0o-v3/equivocation-contract.json":
		"d4063a6c008dba96c1b8428779b91c1fb838d8e8d40ba3cce2b23db89615d642",
});
const profileIdentity = Object.freeze({
	profileId: "equivocation-evidence-projection-v1",
	baseProfileId: "equivocation-digest-identity-v1",
	proofDomain: "ts-drp/equivocation-proof/v1",
	projection: Object.freeze({
		identity: "structured-slot-and-canonical-unordered-distinct-digest-pair",
		proofBodyCopies: 0,
		payloadOutboxCopies: 0,
	}),
	reconstruction: Object.freeze({
		carrier: "current-authenticated-persisted-witnesses",
		resolver: "authoritative-author-key-resolver",
		result: "canonical-equivocation-digest-identity-v1-proof",
	}),
	retention: Object.freeze({
		amendsBasePersistence: false,
		globalEvidenceBoundClaimed: false,
		proofBodiesPersist: true,
		witnessesPersist: true,
		newlyPersistedProofIdsMeaning: "unchanged-exactly-once-for-conforming-0o-a-state",
	}),
});

function fail(message) {
	throw new Error(`protocol-v3 equivocation evidence projection freeze violation: ${message}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function readWorking(path) {
	const absolute = resolve(repositoryRoot, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or not a regular file`);
	return readFileSync(absolute);
}

function readJson(path) {
	try {
		const parsed = JSON.parse(readWorking(path).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${path} must contain an object`);
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${path} is not valid JSON`);
		throw error;
	}
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

function validateWorkflow(source) {
	for (const fragment of [
		"name: Protocol v3 equivocation evidence projection freeze",
		"types: [opened, synchronize, reopened, edited, ready_for_review]",
		"permissions:",
		"contents: read",
		"timeout-minutes: 10",
		"fetch-depth: 0",
		"ref: ${{ github.sha }}",
		"pnpm install --frozen-lockfile",
		'git show "$BASE_SHA:$CHECKER"',
		"PROTOCOL_V3_EQUIVOCATION_EVIDENCE_PROJECTION_REPOSITORY_ROOT",
		"Equivocation evidence projection freeze bootstrap is fail-closed and atomic.",
		"PHASE_0O_B1A_IMPLEMENTATION_MODULE=tests/fixtures/phase-0o-b1a-v3/controlled-equivocation-projection.ts",
		"pnpm exec vitest run tests/protocol-v3-equivocation-projection-0o-b1a.test.ts",
		"--no-coverage --maxWorkers=1 --minWorkers=1",
		"pnpm --filter @ts-drp/protocol-v3 build",
		"tsconfig.public-entry-audit.json",
		"tsconfig.built-package-audit.json",
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

function validateCurrentBundle() {
	const supplementDirectory = resolve(repositoryRoot, supplementRoot);
	if (!existsSync(supplementDirectory) || !statSync(supplementDirectory).isDirectory()) {
		fail("supplement directory is absent");
	}
	if (!isDeepStrictEqual(readdirSync(supplementDirectory).sort(), [...requiredSupplementFiles].sort())) {
		fail("supplement directory file set differs");
	}

	const checkerBytes = readWorking(checkerPath);
	const policy = readJson(policyPath);
	const profile = readJson(profilePath);
	const contract = readJson(contractPath);
	if (!isDeepStrictEqual(profile, profileIdentity)) fail("profile identity or non-retention boundary differs");
	if (
		policy.schemaVersion !== "ts-drp-equivocation-evidence-projection-freeze-v1" ||
		policy.profile !== profileIdentity.profileId ||
		policy.baseProfile !== profileIdentity.baseProfileId ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	) {
		fail("freeze policy identity or protected surface differs");
	}
	if (policy.checkerSha256 !== sha256(checkerBytes)) fail("checker hash binding differs");
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
	if (!isDeepStrictEqual(contract.baseArtifactSha256, frozenBaseArtifacts)) {
		fail("contract does not bind the exact frozen base tuple");
	}
	for (const [path, expectedHash] of Object.entries(frozenBaseArtifacts)) {
		if (sha256(readWorking(path)) !== expectedHash) fail(`frozen base drift: ${path}`);
	}

	const specification = readWorking(specificationPath).toString("utf8");
	for (const fragment of [
		"does not amend",
		"state.proofs",
		"newlyPersistedProofIds",
		"zero proof bodies",
		"global storage bound",
		"current persisted witnesses",
		"No stale carrier payload",
	]) {
		if (!specification.includes(fragment)) fail(`specification omits ${fragment}`);
	}
	validateWorkflow(readWorking(workflowPath).toString("utf8"));
}

function validateTransition(baseRef) {
	const base = protectedArtifacts.map((path) => readBase(baseRef, path));
	const presentCount = base.filter((bytes) => bytes !== undefined).length;
	if (presentCount === 0) return;
	if (presentCount !== protectedArtifacts.length) fail("protected projection tuple existed only partially at base");
	for (let index = 0; index < protectedArtifacts.length; index++) {
		const path = protectedArtifacts[index];
		if (sha256(base[index]) !== sha256(readWorking(path))) fail(`protected projection drift: ${path}`);
	}
}

validateCurrentBundle();
const baseRef = process.argv[2];
if (baseRef !== undefined) validateTransition(baseRef);
console.log("protocol-v3 equivocation evidence projection freeze: PASS");
