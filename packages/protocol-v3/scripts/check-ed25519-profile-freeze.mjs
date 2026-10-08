#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_ED25519_PROFILE_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
		: resolve(process.env.PROTOCOL_V3_ED25519_PROFILE_REPOSITORY_ROOT);

const checkerPath = "packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json";
const addendumPath = "docs/protocol/ed25519-acceptance-profile-v3.md";
const amendmentPath = "docs/protocol/ed25519-acceptance-profile-v3.json";
const vectorsPath = "packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json";
const workflowPath = ".github/workflows/protocol-v3-ed25519-profile.yml";
const redPath = "tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts";
const fixturePath = "tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json";

const protectedArtifacts = Object.freeze([
	addendumPath,
	amendmentPath,
	vectorsPath,
	policyPath,
	checkerPath,
	workflowPath,
	redPath,
	fixturePath,
]);
const hashPinnedArtifacts = Object.freeze(protectedArtifacts.filter((path) => path !== policyPath));

const frozenTuple = Object.freeze({
	checkpoint: "907fae437e558145f63614cd6b5de925ea4bd8c2",
	freezePolicyPath: "packages/protocol-v3/conformance/freeze-policy-v3.json",
	freezePolicySha256: "fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3",
	protectedPathCount: 47,
	protectedPathStatesSha256: "023e7b50c11eff2d5fd4d0d8c5ea6da8d54ad095d73d24b7d3badea2e3769637",
});

const profile = Object.freeze({
	id: "ts-drp-ed25519-acceptance-v1",
	protocolMajor: 3,
	suiteId: "ed25519-sha256-v3",
	message: "raw-32-byte-registered-digest",
	publicKeyEncoding: "canonical-compressed-edwards-y-32",
	signaturePointEncoding: "canonical-compressed-edwards-y-32",
	scalarRule: "0 <= S < L",
	publicKeyRule: "reject-small-order",
	equation: "[8][S]B = [8]R + [8][k]A",
	challenge: "k = SHA-512(R_bytes || A_bytes || raw_registered_digest) mod L",
	nobleCall: "ed25519.verify(signature, rawRegisteredDigest, publicKey, { zip215: false })",
	referenceRole: "byte-and-digest-oracle-only",
});

const liveVectorIds = Object.freeze([
	"valid",
	"mixed-order",
	"small-order-identity",
	"s-plus-l",
	"noncanonical-r",
	"hex-text-message",
	"json-wrapper-message",
]);
const speccheckVectorIds = Object.freeze([
	"case-0-small-a-small-r",
	"case-3-mixed-a-mixed-r-both-equations",
	"case-4-mixed-a-mixed-r-cofactored-only",
	"case-6-s-greater-than-l",
	"case-8-noncanonical-r",
	"case-10-noncanonical-a",
]);
const fixtureSha256 = "42baf0e200234eedf31bd0e16f4e23f55a463b3a50578b13e168c929ce9f29a2";
const redSha256 = "26c24d2fc3ac38ee55ca0f092d855a434382230825341cd6380fb1cd332dc938";

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
	if (!isRecord(actual)) return false;
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = [...expected].sort();
	return isDeepStrictEqual(actualKeys, expectedKeys);
}

/**
 * Pure content-addressed evaluator used by tests and policy consumers.
 * Extra, unrelated head paths are intentionally outside this supplement.
 * @param root0 - The content-addressed comparison.
 * @param root0.base - Digests from the protected base.
 * @param root0.head - Digests from the proposed head.
 * @param root0.protectedArtifacts - The complete governed path list.
 * @returns A stable acceptance result and all detected errors.
 */
export function evaluateEd25519ProfileFreeze({ base, head, protectedArtifacts: requestedArtifacts }) {
	const errors = [];
	if (!isRecord(base) || !isRecord(head)) {
		return { accepted: false, errors: ["base and head must be content-addressed records"] };
	}
	if (!isDeepStrictEqual(requestedArtifacts, protectedArtifacts)) {
		errors.push("protected supplement surface differs from the complete eight-artifact policy");
		return { accepted: false, errors };
	}
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
	throw new Error(`protocol-v3 Ed25519 profile freeze violation: ${message}`);
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
	if (!isRecord(actual)) fail(`${label} is absent or malformed`);
	if (!sameKeys(actual, Object.keys(expected))) fail(`${label} key set differs`);
	for (const [key, value] of Object.entries(expected)) {
		if (!isDeepStrictEqual(actual[key], value)) fail(`${label} differs at ${key}`);
	}
}

function requireExactArray(actual, expected, label) {
	if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs`);
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
		"name: Protocol v3 Ed25519 acceptance profile freeze",
		"pull_request:",
		"fetch-depth: 0",
		"BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		`CHECKER: ${checkerPath}`,
		`POLICY: ${policyPath}`,
		'git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-ed25519-profile-freeze.mjs"',
		'PROTOCOL_V3_ED25519_PROFILE_REPOSITORY_ROOT="$GITHUB_WORKSPACE"',
		'node "$RUNNER_TEMP/check-ed25519-profile-freeze.mjs" "$BASE_SHA"',
		`node ${checkerPath} "$BASE_SHA"`,
	];
	for (const fragment of requiredFragments) {
		if (!source.includes(fragment)) fail(`workflow omits required structure: ${fragment}`);
	}
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /^\s+[A-Za-z-]+:\s+write\s*$/mu]) {
		if (forbidden.test(source)) fail(`workflow contains forbidden structure: ${forbidden}`);
	}
}

function validateBundle(read, label, runningCheckerBytes) {
	validateFrozenTuple(read, label);
	const addendumBytes = read(addendumPath);
	const amendmentBytes = read(amendmentPath);
	const vectorsBytes = read(vectorsPath);
	const policyBytes = read(policyPath);
	const checkerBytes = read(checkerPath);
	const workflowBytes = read(workflowPath);
	if (
		addendumBytes === undefined ||
		amendmentBytes === undefined ||
		vectorsBytes === undefined ||
		policyBytes === undefined ||
		checkerBytes === undefined ||
		workflowBytes === undefined ||
		read(redPath) === undefined ||
		read(fixturePath) === undefined
	) {
		fail(`${label} supplement closure is incomplete`);
	}

	const addendum = addendumBytes.toString("utf8");
	const amendment = parseJson(amendmentBytes, `${label} ${amendmentPath}`);
	const vectors = parseJson(vectorsBytes, `${label} ${vectorsPath}`);
	const policy = parseJson(policyBytes, `${label} ${policyPath}`);

	requireExactArray(policy.protectedArtifacts, protectedArtifacts, `${label} protectedArtifacts`);
	requireExactRecord(policy.frozenTuple, frozenTuple, `${label} policy frozenTuple`);
	if (policy.schemaVersion !== "ts-drp-ed25519-profile-freeze-v1" || policy.profileId !== profile.id) {
		fail(`${label} policy identity is malformed`);
	}
	if (!sameKeys(policy.artifactSha256, hashPinnedArtifacts)) {
		fail(`${label} artifactSha256 must pin exactly the seven non-policy artifacts`);
	}
	for (const path of hashPinnedArtifacts) {
		const expected = policy.artifactSha256[path];
		const bytes = read(path);
		if (!isDigest(expected) || bytes === undefined || sha256(bytes) !== expected) {
			fail(`${label} artifact pin is stale: ${path}`);
		}
	}
	if (policy.checkerSha256 !== policy.artifactSha256[checkerPath]) {
		fail(`${label} checkerSha256 differs from the checker artifact pin`);
	}
	if (runningCheckerBytes !== undefined && sha256(runningCheckerBytes) !== policy.checkerSha256) {
		fail(`${label} running checker differs from its policy pin`);
	}
	if (policy.artifactSha256[redPath] !== redSha256 || policy.artifactSha256[fixturePath] !== fixtureSha256) {
		fail(`${label} sealed RED tuple pins drifted`);
	}

	for (const statement of Object.values(profile)) {
		if (!addendum.includes(String(statement))) fail(`${label} addendum omits ${String(statement)}`);
	}
	if (!addendum.includes("canonical mixed-order points remain") || !addendum.includes("MUST NOT add a blanket")) {
		fail(`${label} addendum does not preserve canonical mixed-order acceptance`);
	}

	requireExactRecord(amendment.frozenTuple, frozenTuple, `${label} amendment frozenTuple`);
	for (const [key, value] of Object.entries({
		profileId: profile.id,
		protocolMajor: profile.protocolMajor,
		suiteId: profile.suiteId,
		message: profile.message,
		publicKeyEncoding: profile.publicKeyEncoding,
		signaturePointEncoding: profile.signaturePointEncoding,
		scalarRule: profile.scalarRule,
		publicKeyRule: profile.publicKeyRule,
		equation: profile.equation,
		challenge: profile.challenge,
		nobleCall: profile.nobleCall,
		referenceRole: profile.referenceRole,
	})) {
		if (amendment[key] !== value) fail(`${label} amendment differs at ${key}`);
	}
	if (amendment.addendumPath !== addendumPath || amendment.addendumSha256 !== sha256(addendumBytes)) {
		fail(`${label} amendment addendum binding is stale`);
	}
	if (amendment.vectorsPath !== vectorsPath || amendment.vectorsSha256 !== sha256(vectorsBytes)) {
		fail(`${label} amendment vector binding is stale`);
	}
	if (amendment.implementationExport !== "verifyEd25519RegisteredDigest") {
		fail(`${label} amendment implementation export is malformed`);
	}

	requireExactRecord(vectors.frozenTuple, frozenTuple, `${label} vectors frozenTuple`);
	if (
		vectors.schemaVersion !== profile.id ||
		vectors.profileId !== profile.id ||
		vectors.protocolMajor !== profile.protocolMajor ||
		vectors.suiteId !== profile.suiteId ||
		vectors.contractFixturePath !== fixturePath ||
		vectors.contractFixtureSha256 !== fixtureSha256 ||
		vectors.messageRule !== profile.message ||
		vectors.verificationCall !== profile.nobleCall
	) {
		fail(`${label} vector identity or fixture binding is malformed`);
	}
	requireExactArray(vectors.liveVectorIds, liveVectorIds, `${label} liveVectorIds`);
	requireExactArray(vectors.speccheckVectorIds, speccheckVectorIds, `${label} speccheckVectorIds`);
	if (
		!Array.isArray(vectors.liveVectors) ||
		!Array.isArray(vectors.speccheckVectors) ||
		!isDeepStrictEqual(
			vectors.liveVectors.map(({ id }) => id),
			liveVectorIds
		) ||
		!isDeepStrictEqual(
			vectors.speccheckVectors.map(({ id }) => id),
			speccheckVectorIds
		)
	) {
		fail(`${label} vector bodies do not cover the declared vector ids`);
	}
	for (const vector of [...vectors.liveVectors, ...vectors.speccheckVectors]) {
		if (
			!isRecord(vector) ||
			typeof vector.id !== "string" ||
			typeof vector.messageHex !== "string" ||
			!/^[0-9a-f]{64}$/u.test(vector.messageHex) ||
			typeof vector.publicKeyHex !== "string" ||
			!/^[0-9a-f]{64}$/u.test(vector.publicKeyHex) ||
			typeof vector.signatureHex !== "string" ||
			!/^[0-9a-f]{128}$/u.test(vector.signatureHex) ||
			typeof vector.strictAccept !== "boolean"
		) {
			fail(`${label} vector body is malformed`);
		}
	}

	validateWorkflow(workflowBytes.toString("utf8"));
	return { policy, policyBytes };
}

function git(args, options = {}) {
	return execFileSync("git", args, {
		cwd: repositoryRoot,
		encoding: options.encoding ?? "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
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
			fail("bootstrap must add the complete eight-artifact supplement atomically");
		}
		validateBundle(readWorkingFile, "bootstrap current", runningCheckerBytes);
		process.stdout.write(`protocol-v3 Ed25519 profile bootstrap passed (${mergeBase.slice(0, 12)}..working-tree)\n`);
		return;
	}

	if (basePresence.length !== protectedArtifacts.length) {
		fail("merge-base contains a partial supplement closure");
	}
	for (const path of protectedArtifacts) {
		if (!isTracked(path)) fail(`protected supplement artifact is untracked or index-deleted: ${path}`);
	}
	const baseBundle = validateBundle(readBase, "merge-base", runningCheckerBytes);
	const currentBundle = validateBundle(readWorkingFile, "working tree", runningCheckerBytes);
	if (!isDeepStrictEqual(currentBundle.policyBytes, baseBundle.policyBytes)) {
		fail("supplement freeze policy changed");
	}
	const evaluation = evaluateEd25519ProfileFreeze({
		base: digestMap(readBase),
		head: digestMap(readWorkingFile),
		protectedArtifacts,
	});
	if (!evaluation.accepted) fail(evaluation.errors.join("; "));
	process.stdout.write(`protocol-v3 Ed25519 profile freeze passed (${mergeBase.slice(0, 12)}..working-tree)\n`);
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
