#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot =
	process.env.PROTOCOL_FREEZE_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
		: resolve(process.env.PROTOCOL_FREEZE_REPOSITORY_ROOT);
const policyPath = "packages/protocol-v2/conformance/freeze-policy.json";
const registryPath = "packages/protocol-v2/registry/field-registry.json";
const registryPrefix = "packages/protocol-v2/registry/";
const originalReferencePrefix = "packages/protocol-v2/conformance/ahe-reference/src/";
const originalLockPath = "packages/protocol-v2/conformance/reference.lock.json";
const vectorPrefix = "packages/protocol-v2/tests/fixtures/golden-vectors/";
const codeownersPath = "CODEOWNERS";
const workflowPath = ".github/workflows/protocol-v2-registry.yml";
const alternateCodeownersPaths = Object.freeze([".github/CODEOWNERS", "docs/CODEOWNERS"]);
const protocolOwners = Object.freeze(["@d-roak", "@anhnd350309", "@sfroment"]);
const requiredCodeownersPatterns = Object.freeze([
	"/CODEOWNERS",
	"/packages/protocol-v2/registry/**",
	"/packages/protocol-v2/tests/fixtures/golden-vectors/**",
	"/packages/protocol-v2/conformance/reference.lock.json",
	"/packages/protocol-v2/conformance/freeze-policy.json",
	"/packages/protocol-v2/conformance/ahe-reference/src/**",
	"/packages/protocol-v2/conformance/ahe-reference-regen/**",
	"/packages/protocol-v2/conformance/reference-regen.lock.json",
	"/packages/protocol-v2/scripts/check-protocol-freeze.mjs",
	"/.github/workflows/protocol-v2-registry.yml",
]);
const requiredProtectedPaths = Object.freeze([
	"packages/protocol-v2/conformance/ahe-reference/src/**",
	"packages/protocol-v2/conformance/reference.lock.json",
	"packages/protocol-v2/conformance/ahe-reference-regen/**",
	"packages/protocol-v2/conformance/reference-regen.lock.json",
	"packages/protocol-v2/tests/fixtures/golden-vectors/**",
	"packages/protocol-v2/registry/**",
	"packages/protocol-v2/scripts/check-protocol-freeze.mjs",
	"packages/protocol-v2/conformance/freeze-policy.json",
	"docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt",
	...alternateCodeownersPaths,
]);

function fail(message) {
	throw new Error(`protocol freeze violation: ${message}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPolicyShape(policy, label) {
	if (!isRecord(policy)) fail(`${label} policy is absent or malformed`);
	if (policy.version !== 1) fail(`${label} policy version must be 1`);
	if (!Array.isArray(policy.protectedPaths) || policy.protectedPaths.some((path) => typeof path !== "string")) {
		fail(`${label} protectedPaths must be an array of paths`);
	}
	if (
		!isRecord(policy.checker) ||
		typeof policy.checker.path !== "string" ||
		typeof policy.checker.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/u.test(policy.checker.sha256)
	) {
		fail(`${label} checker pin is malformed`);
	}
	for (const key of ["regenReferencePath", "regenLockPath", "sourceChecksumsPath"]) {
		if (typeof policy[key] !== "string") fail(`${label} ${key} must be a path`);
	}
}

function mapsEqual(left, right, label) {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
		fail(`${label} file set changed`);
	}
	for (const key of leftKeys) {
		if (left[key] !== right[key]) fail(`${label} bytes changed at ${key}`);
	}
}

function selectedFiles(files, predicate) {
	return Object.fromEntries(Object.entries(files).filter(([path]) => predicate(path)));
}

function validateCodeowners() {
	for (const path of alternateCodeownersPaths) {
		if (readWorkingFile(path) !== undefined) fail(`${path} must remain absent so root CODEOWNERS stays authoritative`);
	}
	const bytes = readWorkingFile(codeownersPath);
	if (bytes === undefined) fail("root CODEOWNERS is absent");
	const entries = bytes
		.toString("utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => line.split(/\s+/u));
	const requiredBlock = entries.slice(-requiredCodeownersPatterns.length);
	if (requiredBlock.length !== requiredCodeownersPatterns.length) fail("protocol CODEOWNERS block is incomplete");
	for (const [index, pattern] of requiredCodeownersPatterns.entries()) {
		const entry = requiredBlock[index];
		if (entry === undefined || entry[0] !== pattern) {
			fail(`protocol CODEOWNERS block must end with ${requiredCodeownersPatterns.join(", ")}`);
		}
		if (
			entry.length !== protocolOwners.length + 1 ||
			protocolOwners.some((owner, ownerIndex) => entry[ownerIndex + 1] !== owner)
		) {
			fail(`CODEOWNERS ${pattern} must use the frozen protocol-owner cohort`);
		}
	}
}

function validateWorkflow() {
	const bytes = readWorkingFile(workflowPath);
	if (bytes === undefined) fail("protocol freeze workflow is absent");
	const workflow = bytes.toString("utf8");
	const lines = workflow.split(/\r?\n/u);
	const requiredLines = [
		"name: Protocol v2 registry change control",
		"on:",
		"  pull_request:",
		"    types: [opened, synchronize, reopened, edited, ready_for_review]",
		"permissions:",
		"  contents: read",
		"jobs:",
		"  registry-version:",
		"    name: Require protocol-v2 registryVersion bump",
		"    runs-on: ubuntu-latest",
		"    timeout-minutes: 10",
		"          fetch-depth: 0",
		"          ref: ${{ github.sha }}",
		"          BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		"          CHECKER: packages/protocol-v2/scripts/check-protocol-freeze.mjs",
		"          REGISTRY: packages/protocol-v2/registry/field-registry.json",
		"          ORIGINAL_REFERENCE: packages/protocol-v2/conformance/ahe-reference/src/canonical.js",
		"          POLICY: packages/protocol-v2/conformance/freeze-policy.json",
	];
	for (const line of requiredLines) {
		if (lines.filter((candidate) => candidate === line).length !== 1) {
			fail(`protocol freeze workflow must contain exactly one structural line: ${line}`);
		}
	}
	const checkoutSteps = lines.filter((line) => /^ {6}- uses: actions\/checkout@v[1-9][0-9]*$/u.test(line));
	const setupNodeSteps = lines.filter((line) => /^ {6}- uses: actions\/setup-node@v[1-9][0-9]*$/u.test(line));
	const nodeVersions = lines
		.map((line) => /^ {10}node-version: ([1-9][0-9]*)$/u.exec(line))
		.filter((match) => match !== null)
		.map((match) => Number(match[1]));
	if (checkoutSteps.length !== 1 || setupNodeSteps.length !== 1 || nodeVersions.length !== 1 || nodeVersions[0] < 22) {
		fail("protocol freeze workflow must have one checkout, one setup-node, and Node >=22");
	}
	const runIndex = lines.indexOf("        run: |");
	const runner = runIndex < 0 ? [] : lines.slice(runIndex + 1).map((line) => line.replace(/^ {10}/u, ""));
	const expectedRunner = [
		'if git cat-file -e "$BASE_SHA:$CHECKER"; then',
		'  git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-protocol-freeze.mjs"',
		'  PROTOCOL_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\',
		'    node "$RUNNER_TEMP/check-protocol-freeze.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$POLICY" \\',
		'  && git cat-file -e "$BASE_SHA:$REGISTRY" \\',
		'  && git cat-file -e "$BASE_SHA:$ORIGINAL_REFERENCE"; then',
		'  node packages/protocol-v2/scripts/check-protocol-freeze.mjs "$BASE_SHA"',
		"else",
		'  echo "Protocol freeze bootstrap requires a stacked base with registry v5 and the original reference." >&2',
		"  exit 1",
		"fi",
		"",
	];
	if (runner.length !== expectedRunner.length || runner.some((line, index) => line !== expectedRunner[index])) {
		fail("protocol freeze workflow runner differs from the base-checker-first, fail-closed runner");
	}
	for (const forbidden of [
		/\bpull_request_target\b/u,
		/^\s*(?:paths|branches|branches-ignore):/mu,
		/^\s*(?:if|continue-on-error):/mu,
		/^\s+[A-Za-z-]+:\s+write\s*$/mu,
		/\bpnpm (?:install|--filter)\b/u,
	]) {
		if (forbidden.test(workflow)) fail(`protocol freeze workflow contains forbidden structure: ${forbidden}`);
	}
}

function vectorVersion(name) {
	const match = /^registry-v([1-9][0-9]*)\.json$/u.exec(name);
	return match === null ? undefined : Number(match[1]);
}

function validateVectorDocuments(snapshotValue) {
	if (!isRecord(snapshotValue.vectorDocuments)) fail("snapshot vectorDocuments must be a content map");
	const vectorNames = Object.keys(snapshotValue.vectorBytes).sort();
	const documentNames = Object.keys(snapshotValue.vectorDocuments).sort();
	if (vectorNames.length !== documentNames.length || vectorNames.some((name, index) => name !== documentNames[index])) {
		fail("snapshot vector bytes and parsed documents must have the same file set");
	}
	const versions = [];
	for (const [name, document] of Object.entries(snapshotValue.vectorDocuments)) {
		const version = vectorVersion(name);
		if (
			version === undefined ||
			!isRecord(document) ||
			document.registryVersion !== version ||
			!isRecord(document.records)
		) {
			fail(`golden vector document ${name} is malformed`);
		}
		versions.push(version);
	}
	versions.sort((left, right) => left - right);
	if (versions.length === 0) {
		if (Object.keys(snapshotValue.vectorBytes).length === 0) return;
		fail("snapshot vector bytes are missing parsed documents");
	}
	if (versions.at(-1) !== snapshotValue.registryVersion) {
		fail(`registry-v${snapshotValue.registryVersion}.json must be the latest vector document`);
	}
	for (let index = 1; index < versions.length; index++) {
		const previousVersion = versions[index - 1];
		const version = versions[index];
		if (previousVersion === undefined || version === undefined || version !== previousVersion + 1) {
			fail("golden vector document versions must be contiguous");
		}
		const previous = snapshotValue.vectorDocuments[`registry-v${previousVersion}.json`];
		const current = snapshotValue.vectorDocuments[`registry-v${version}.json`];
		for (const [id, recordBytes] of Object.entries(previous.records)) {
			if (current.records[id] !== recordBytes) {
				fail(`registry-v${version}.json did not carry vector record ${id} byte-identically`);
			}
		}
	}
}

function validateRegistryFiles(snapshotValue, label) {
	const registryFiles = Object.keys(snapshotValue.files)
		.filter((path) => path.startsWith(registryPrefix))
		.sort();
	if (registryFiles.length !== 1 || registryFiles[0] !== registryPath) {
		fail(`${label} registry must contain only ${registryPath}`);
	}
}

function validateVectorTransition(base, current, registryMayAdvance) {
	for (const [name, bytes] of Object.entries(base.vectorBytes)) {
		if (!(name in current.vectorBytes)) fail(`golden vector ${name} was deleted`);
		if (current.vectorBytes[name] !== bytes) fail(`golden vector ${name} changed`);
	}
	const additions = Object.keys(current.vectorBytes).filter((name) => !(name in base.vectorBytes));
	const delta = current.registryVersion - base.registryVersion;
	if (!registryMayAdvance) {
		if (delta !== 0 || additions.length !== 0) fail("registry is closed after reference regeneration");
		return;
	}
	if (delta === 0 && additions.length === 0) return;
	if (delta !== 1 || additions.length !== 1) {
		fail("an open registry transition must be exactly +1 version with exactly one new vector set");
	}
	const expected = `registry-v${current.registryVersion}.json`;
	if (additions[0] !== expected || vectorVersion(additions[0]) !== current.registryVersion) {
		fail(`registry version ${current.registryVersion} requires exactly ${expected}`);
	}
}

function regenState(snapshot, policy) {
	const prefix = policy.regenReferencePath.replace(/\*\*$/u, "");
	const files = selectedFiles(snapshot.files, (path) => path.startsWith(prefix));
	const hasTree = Object.keys(files).length > 0;
	const hasLock = Object.hasOwn(snapshot.files, policy.regenLockPath);
	if (hasTree !== hasLock) fail("regenerated reference tree and lock must appear together");
	return { files, hasLock, present: hasTree && hasLock };
}

/**
 * Evaluates a caller-supplied pair of content-addressed repository snapshots.
 * The merge-base policy governs; a current policy can never weaken its base.
 * @param root0 - The paired content-addressed snapshots.
 * @param root0.base - The merge-base state and governing policy.
 * @param root0.current - The proposed repository state.
 */
export function evaluateFreezePolicy({ base, current }) {
	if (!isRecord(base) || !isRecord(current)) fail("base and current snapshots are required");
	if (!isRecord(base.files) || !isRecord(current.files)) fail("snapshot files must be content maps");
	if (!isRecord(base.vectorBytes) || !isRecord(current.vectorBytes)) fail("snapshot vectors must be content maps");
	if (!Number.isSafeInteger(base.registryVersion) || !Number.isSafeInteger(current.registryVersion)) {
		fail("registryVersion must be a safe integer");
	}
	validateRegistryFiles(base, "base");
	validateRegistryFiles(current, "current");
	validateVectorDocuments(base);
	validateVectorDocuments(current);

	if (base.policy === undefined) {
		assertPolicyShape(current.policy, "bootstrap");
		if (base.registryVersion !== 5 || current.registryVersion !== 5) {
			fail("freeze bootstrap is limited to registry v5");
		}
		if (Object.keys(base.vectorBytes).length !== 0) fail("freeze bootstrap requires no base vector sets");
		const currentVectors = Object.keys(current.vectorBytes);
		if (currentVectors.length !== 1 || currentVectors[0] !== "registry-v5.json") {
			fail("freeze bootstrap must add only registry-v5.json");
		}
		const baseOriginal = selectedFiles(base.files, (path) => path.startsWith(originalReferencePrefix));
		if (Object.keys(baseOriginal).length === 0) fail("original reference must predate freeze bootstrap");
		mapsEqual(
			baseOriginal,
			selectedFiles(current.files, (path) => path.startsWith(originalReferencePrefix)),
			"original reference"
		);
		mapsEqual(
			selectedFiles(base.files, (path) => path.startsWith(registryPrefix)),
			selectedFiles(current.files, (path) => path.startsWith(registryPrefix)),
			"bootstrap registry"
		);
		if (Object.hasOwn(base.files, originalLockPath) || !Object.hasOwn(current.files, originalLockPath)) {
			fail("freeze bootstrap must add the original reference lock");
		}
		const bootstrapRegen = regenState(current, current.policy);
		if (bootstrapRegen.present) fail("reference regeneration is not part of freeze bootstrap");
		return;
	}

	assertPolicyShape(base.policy, "base");
	assertPolicyShape(current.policy, "current");
	for (const path of base.policy.protectedPaths) {
		if (!current.policy.protectedPaths.includes(path)) fail(`current policy removed protection for ${path}`);
	}
	for (const key of ["version", "regenReferencePath", "regenLockPath", "sourceChecksumsPath"]) {
		if (current.policy[key] !== base.policy[key]) fail(`current policy changed base-governed ${key}`);
	}
	if (
		current.policy.checker.path !== base.policy.checker.path ||
		current.policy.checker.sha256 !== base.policy.checker.sha256
	) {
		fail("current policy changed the base-pinned checker");
	}

	mapsEqual(
		selectedFiles(base.files, (path) => path.startsWith(originalReferencePrefix)),
		selectedFiles(current.files, (path) => path.startsWith(originalReferencePrefix)),
		"original reference"
	);
	if (
		!Object.hasOwn(base.files, originalLockPath) ||
		current.files[originalLockPath] !== base.files[originalLockPath]
	) {
		fail("original reference lock changed");
	}

	const baseRegen = regenState(base, base.policy);
	const currentRegen = regenState(current, base.policy);
	if (baseRegen.present) {
		if (!currentRegen.present) fail("regenerated reference pair was deleted");
		mapsEqual(baseRegen.files, currentRegen.files, "regenerated reference");
		if (current.files[base.policy.regenLockPath] !== base.files[base.policy.regenLockPath]) {
			fail("regenerated reference lock changed");
		}
		validateVectorTransition(base, current, false);
	} else if (currentRegen.present) {
		if (current.registryVersion !== base.registryVersion) {
			fail("reference regeneration requires an unchanged registry");
		}
		validateVectorTransition(base, current, false);
	} else {
		validateVectorTransition(base, current, true);
	}

	const registryAdvanced = current.registryVersion === base.registryVersion + 1;
	for (const path of new Set([...Object.keys(base.files), ...Object.keys(current.files)])) {
		if (!base.policy.protectedPaths.some((pattern) => matchesPattern(path, pattern))) continue;
		if (base.files[path] === current.files[path]) continue;
		if (path.startsWith(originalReferencePrefix) || path === originalLockPath) {
			fail(`immutable original reference artifact changed: ${path}`);
		}
		if (path.startsWith(vectorPrefix)) continue;
		if (path.startsWith(base.policy.regenReferencePath.replace(/\*\*$/u, "")) || path === base.policy.regenLockPath) {
			continue;
		}
		if (path.startsWith("packages/protocol-v2/registry/") && registryAdvanced && !baseRegen.present) continue;
		if (path === policyPath) continue;
		fail(`protected artifact changed: ${path}`);
	}

	const checkerPath = base.policy.checker.path;
	if (Object.hasOwn(current.files, checkerPath) && current.files[checkerPath] !== base.policy.checker.sha256) {
		fail("checker bytes do not match the base policy pin");
	}
}

function matchesPattern(path, pattern) {
	if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
	return path === pattern;
}

function git(args) {
	return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
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
	const absolute = join(repositoryRoot, path);
	return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute) : undefined;
}

function listRevisionFiles(revision) {
	const output = git(["ls-tree", "-r", "--name-only", revision]);
	return output.length === 0 ? [] : output.split("\n");
}

function listWorkingFiles() {
	const output = git(["ls-files", "--cached", "--others", "--exclude-standard"]);
	return output.length === 0 ? [] : output.split("\n");
}

function parseJson(bytes, label) {
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		fail(`${label} is not valid JSON`);
	}
}

function snapshot(read, paths, governingPaths) {
	const policy = parseJson(read(policyPath), policyPath);
	const registry = parseJson(read(registryPath), registryPath);
	if (!isRecord(registry) || !Number.isSafeInteger(registry.registryVersion)) fail(`${registryPath} is malformed`);
	const relevant = new Set([
		...paths.filter((path) => governingPaths.some((pattern) => matchesPattern(path, pattern))),
		...paths.filter((path) => path.startsWith(originalReferencePrefix) || path === originalLockPath),
	]);
	const files = {};
	for (const path of relevant) {
		if (path.startsWith(vectorPrefix)) continue;
		const bytes = read(path);
		if (bytes !== undefined) files[path] = sha256(bytes);
	}
	const vectorBytes = {};
	const vectorDocuments = {};
	for (const path of paths) {
		if (!path.startsWith(vectorPrefix)) continue;
		const name = path.slice(vectorPrefix.length);
		if (vectorVersion(name) === undefined) {
			fail(`golden vector path must be exactly ${vectorPrefix}registry-vN.json: ${path}`);
		}
		const bytes = read(path);
		if (bytes === undefined) continue;
		vectorBytes[name] = sha256(bytes);
		const document = parseJson(bytes, path);
		if (!isRecord(document) || !Array.isArray(document.vectors)) fail(`${path} is malformed`);
		const records = {};
		for (const vector of document.vectors) {
			if (!isRecord(vector) || typeof vector.id !== "string" || vector.id.length === 0) {
				fail(`${path} contains a vector without an id`);
			}
			if (Object.hasOwn(records, vector.id)) fail(`${path} contains duplicate vector id ${vector.id}`);
			records[vector.id] = sha256(Buffer.from(JSON.stringify(vector)));
		}
		vectorDocuments[name] = { records, registryVersion: document.registryVersion };
	}
	return { files, policy, registryVersion: registry.registryVersion, vectorBytes, vectorDocuments };
}

function regularFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return regularFiles(path);
		return entry.isFile() ? [path] : [];
	});
}

function validateCurrentArtifacts(snapshotValue) {
	assertPolicyShape(snapshotValue.policy, "current");
	for (const path of requiredProtectedPaths) {
		if (!snapshotValue.policy.protectedPaths.includes(path)) fail(`current policy does not protect ${path}`);
	}
	for (const path of [codeownersPath, workflowPath]) {
		if (snapshotValue.policy.protectedPaths.includes(path)) {
			fail(`${path} must be governed semantically rather than frozen byte-for-byte`);
		}
	}
	validateCodeowners();
	validateWorkflow();
	const checkerBytes = readWorkingFile(snapshotValue.policy.checker.path);
	if (checkerBytes === undefined || sha256(checkerBytes) !== snapshotValue.policy.checker.sha256) {
		fail("working checker bytes do not match freeze-policy.json");
	}
	if (snapshotValue.policy.regenReferencePath !== "packages/protocol-v2/conformance/ahe-reference-regen/**") {
		fail("unexpected regenerated-reference path");
	}
	if (snapshotValue.policy.regenLockPath !== "packages/protocol-v2/conformance/reference-regen.lock.json") {
		fail("unexpected regenerated-reference lock path");
	}
	if (
		snapshotValue.policy.sourceChecksumsPath !== "docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt"
	) {
		fail("unexpected vendored checksum source");
	}

	const lock = parseJson(readWorkingFile(originalLockPath), originalLockPath);
	if (!isRecord(lock) || lock.algorithm !== "sha256" || !isRecord(lock.files))
		fail("original reference lock is malformed");
	const sourceDirectory = join(repositoryRoot, originalReferencePrefix);
	const sourceFiles = regularFiles(sourceDirectory)
		.map((path) => relative(sourceDirectory, path).replaceAll("\\", "/"))
		.sort();
	if (Object.keys(lock.files).sort().join("\n") !== sourceFiles.join("\n"))
		fail("original reference lock is incomplete");
	for (const path of sourceFiles) {
		if (lock.files[path] !== sha256(readFileSync(join(sourceDirectory, path)))) {
			fail(`original reference lock mismatch for ${path}`);
		}
	}
	const checksumBytes = readWorkingFile(snapshotValue.policy.sourceChecksumsPath);
	if (checksumBytes === undefined) fail("vendored SHA256SUMS source is absent");
	const vendoredSums = Object.fromEntries(
		checksumBytes
			.toString("utf8")
			.split(/\r?\n/u)
			.map((line) => /^([0-9a-f]{64}) {2}\.\/reference-implementation\/src\/([^\s]+)$/u.exec(line))
			.filter((match) => match !== null)
			.map((match) => [match[2], match[1]])
	);
	if (Object.keys(vendoredSums).sort().join("\n") !== sourceFiles.join("\n")) {
		fail("vendored SHA256SUMS source does not bijectively cover the original reference");
	}
	for (const path of sourceFiles) {
		if (vendoredSums[path] !== lock.files[path]) fail(`original reference lock disagrees with SHA256SUMS for ${path}`);
	}
	validateRegeneratedReference(snapshotValue);
}

function provenanceEntry(lock, name, path) {
	const entry = lock.provenance[name];
	if (!isRecord(entry) || entry.path !== path || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
		fail(`regenerated reference lock has malformed ${name} provenance`);
	}
	const bytes = readWorkingFile(path);
	if (bytes === undefined || entry.sha256 !== sha256(bytes)) {
		fail(`regenerated reference lock ${name} provenance does not match ${path}`);
	}
}

function validateRegeneratedReference(snapshotValue) {
	const policy = snapshotValue.policy;
	const relativeDirectory = policy.regenReferencePath.replace(/\/\*\*$/u, "");
	const absoluteDirectory = join(repositoryRoot, relativeDirectory);
	const hasTree = existsSync(absoluteDirectory);
	const hasLock = existsSync(join(repositoryRoot, policy.regenLockPath));
	if (hasTree !== hasLock) fail("regenerated reference tree and lock must appear together");
	if (!hasTree) return;
	if (snapshotValue.registryVersion !== 5) fail("reference regeneration is bound to the frozen registry v5 mint");

	const lock = parseJson(readWorkingFile(policy.regenLockPath), policy.regenLockPath);
	if (!isRecord(lock) || lock.algorithm !== "sha256" || !isRecord(lock.files) || !isRecord(lock.provenance)) {
		fail("regenerated reference lock is malformed");
	}
	provenanceEntry(lock, "registry", registryPath);
	provenanceEntry(lock, "vectors", `${vectorPrefix}registry-v5.json`);
	provenanceEntry(lock, "originalReferenceLock", originalLockPath);

	const regeneratedFiles = regularFiles(absoluteDirectory)
		.map((path) => relative(absoluteDirectory, path).replaceAll("\\", "/"))
		.sort();
	if (regeneratedFiles.length === 0) fail("regenerated reference tree is empty");
	if (Object.keys(lock.files).sort().join("\n") !== regeneratedFiles.join("\n")) {
		fail("regenerated reference lock is incomplete");
	}
	for (const path of regeneratedFiles) {
		if (lock.files[path] !== sha256(readFileSync(join(absoluteDirectory, path)))) {
			fail(`regenerated reference lock mismatch for ${path}`);
		}
	}
}

function runCli() {
	const baseReference =
		process.argv[2] ??
		process.env.GITHUB_BASE_SHA ??
		(process.env.GITHUB_BASE_REF === undefined ? "HEAD^" : `origin/${process.env.GITHUB_BASE_REF}`);
	const mergeBase = git(["merge-base", baseReference, "HEAD"]);
	const basePaths = listRevisionFiles(mergeBase);
	const currentPaths = listWorkingFiles();
	const basePolicy = parseJson(readRevisionFile(mergeBase, policyPath), `${mergeBase}:${policyPath}`);
	const currentPolicy = parseJson(readWorkingFile(policyPath), policyPath);
	const governingPaths = [
		...requiredProtectedPaths,
		...(Array.isArray(basePolicy?.protectedPaths) ? basePolicy.protectedPaths : []),
		...(Array.isArray(currentPolicy?.protectedPaths) ? currentPolicy.protectedPaths : []),
	];
	const base = snapshot((path) => readRevisionFile(mergeBase, path), basePaths, governingPaths);
	const current = snapshot(readWorkingFile, currentPaths, governingPaths);
	evaluateFreezePolicy({ base, current });
	validateCurrentArtifacts(current);
	process.stdout.write(`protocol freeze policy passed (${mergeBase.slice(0, 12)}..working-tree)\n`);
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
