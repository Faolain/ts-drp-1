#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root =
	process.env.PROTOCOL_V3_AUTHOR_AUTHORIZATION_REPOSITORY_ROOT ??
	resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const supplement = "packages/protocol-v3/supplements/author-authorization-v1";
const checker = `${supplement}/check-freeze.mjs`;
const policyPath = `${supplement}/freeze-policy.json`;
const profilePath = `${supplement}/profile.json`;
const schemaPath = `${supplement}/schema.json`;
const specPath = `${supplement}/spec.md`;
const vectorsPath = `${supplement}/vectors.json`;
const workflowPath = ".github/workflows/protocol-v3-author-authorization.yml";
const required = Object.freeze([
	"check-freeze.mjs",
	"freeze-policy.json",
	"profile.json",
	"schema.json",
	"spec.md",
	"vectors.json",
]);
const protectedArtifacts = Object.freeze([
	checker,
	policyPath,
	profilePath,
	schemaPath,
	specPath,
	vectorsPath,
	workflowPath,
]);
const pinned = Object.freeze(protectedArtifacts.filter((path) => path !== checker && path !== policyPath));

function fail(message) {
	throw new Error(`protocol-v3 author authorization freeze violation: ${message}`);
}
function bytes(path) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or not a regular file`);
	return readFileSync(absolute);
}
function json(path) {
	try {
		const value = JSON.parse(bytes(path).toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} is not an object`);
		return value;
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${path} is invalid JSON`);
		throw error;
	}
}
function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}
function git(...args) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: null,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	});
}
function baseFile(revision, path) {
	try {
		return git("show", `${revision}:${path}`);
	} catch {
		return undefined;
	}
}

function validateBundle() {
	const directory = resolve(root, supplement);
	if (!isDeepStrictEqual(readdirSync(directory).sort(), [...required].sort())) fail("supplement inventory differs");
	const policy = json(policyPath);
	const profile = json(profilePath);
	const schema = json(schemaPath);
	const vectors = json(vectorsPath);
	if (
		policy.schemaVersion !== "ts-drp-author-authorization-freeze-v1" ||
		policy.profile !== "creator-author-authorization-v1" ||
		policy.checker !== "check-freeze.mjs" ||
		policy.workflow !== workflowPath ||
		!isDeepStrictEqual(policy.protectedArtifacts, protectedArtifacts)
	)
		fail("policy identity differs");
	if (policy.checkerSha256 !== hash(bytes(checker))) fail("checker hash differs");
	if (!isDeepStrictEqual(Object.keys(policy.artifactSha256 ?? {}).sort(), [...pinned].sort()))
		fail("pinned artifact set differs");
	for (const path of pinned)
		if (policy.artifactSha256[path] !== hash(bytes(path))) fail(`artifact hash differs: ${path}`);
	if (
		profile.profileId !== "creator-author-authorization-v1" ||
		profile.carrierKind !== "drp-author-authorization" ||
		profile.protocolMajor !== 3 ||
		profile.version !== 1 ||
		profile.digestDomain !== "ts-drp/author-authorization/v3" ||
		profile.maximumCanonicalBytes !== 8192 ||
		profile.authors?.minimum !== 1 ||
		profile.authors?.maximum !== 64 ||
		profile.authors?.ordering !== "strict-ascending-unsigned-ascii" ||
		profile.authors?.completeSnapshot !== true
	)
		fail("profile law differs");
	if (
		!isDeepStrictEqual(schema.required, [
			"authors",
			"epoch",
			"kind",
			"objectId",
			"profileId",
			"protocolMajor",
			"version",
		]) ||
		schema.additionalProperties !== false ||
		schema.properties?.authors?.minItems !== 1 ||
		schema.properties?.authors?.maxItems !== 64 ||
		schema.properties?.authors?.items?.pattern !== "^[0-9a-f]{64}$" ||
		schema.properties?.authors?.["x-ts-drp-order"] !== "strict-ascending-unsigned-ascii"
	)
		fail("schema law differs");
	if (
		vectors.digestDomain !== profile.digestDomain ||
		vectors.maximumCanonicalBytes !== 8192 ||
		vectors.positive?.carrier?.profileId !== profile.profileId ||
		vectors.positive?.carrier?.kind !== profile.carrierKind ||
		vectors.positive?.byteLength !== 244 ||
		!/^[0-9a-f]{64}$/u.test(vectors.positive?.aclDigest ?? "") ||
		!Array.isArray(vectors.negative) ||
		vectors.negative.length !== 8
	)
		fail("vector law differs");
	const specification = bytes(specPath).toString("utf8");
	for (const phrase of [
		"complete carrier",
		"ts-drp/author-authorization/v3",
		"8192",
		"one through 64",
		"strict ascending unsigned ASCII",
		"Signer sets",
		"package root remains exact runtime ten",
	])
		if (!specification.includes(phrase)) fail(`specification omits ${phrase}`);
	const workflow = bytes(workflowPath).toString("utf8");
	for (const phrase of [
		"name: Protocol v3 author authorization freeze",
		"permissions:\n  contents: read",
		"ref: ${{ github.sha }}",
		"timeout-minutes: 15",
		"check-freeze.mjs",
		"protocol-v3-current-epoch-author-authorization-p6-red.test.ts",
		"check-protocol-v3-freeze.mjs",
		"check-protocol-freeze.mjs",
	])
		if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
	for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u])
		if (forbidden.test(workflow)) fail(`workflow has forbidden structure: ${forbidden}`);
	const source = bytes("packages/protocol-v3/src/index.ts").toString("utf8");
	for (const phrase of [
		"ts-drp/author-authorization/v3",
		"creator-author-authorization-v1",
		"drp-author-authorization",
		"8192",
	])
		if (!source.includes(phrase)) fail(`runtime source omits ${phrase}`);
}

function validateTransition(revision) {
	git("rev-parse", "--verify", `${revision}^{commit}`);
	const atBase = protectedArtifacts.map((path) => baseFile(revision, path));
	const count = atBase.filter((value) => value !== undefined).length;
	if (count !== 0 && count !== protectedArtifacts.length) fail("bootstrap is partial at merge base");
	if (count === protectedArtifacts.length)
		for (let index = 0; index < protectedArtifacts.length; index++)
			if (hash(atBase[index]) !== hash(bytes(protectedArtifacts[index])))
				fail(`frozen artifact changed: ${protectedArtifacts[index]}`);
}

validateBundle();
if (process.argv[2] !== undefined) validateTransition(process.argv[2]);
console.log("protocol-v3 author authorization freeze: PASS");
