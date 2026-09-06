#!/usr/bin/env node
/**
 * Fail-closed discovery and release evidence for shipped Electron targets.
 *
 * Shipping state comes only from the one repository-root manifest named below.
 * Dependency presence and similarly named files are intentionally irrelevant.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const AUTHORITATIVE_MANIFEST_PATH = "shipping-targets.json";
const CONFORMANCE_RUNNER_PATH = "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs";
const CONFORMANCE_CONTRACT_PATH = "tests/fixtures/phase-0j-c-v3/blueprint-conformance-contract.json";
const REQUIRED_ENGINES = Object.freeze(["node", "chromium", "firefox", "webkit"]);
const SUPPORTED_TIERS = Object.freeze(["pr", "nightly"]);
const RECEIPT_SCHEMA_VERSION = 1;
const PATH_META_CHARACTERS = /[*?[\\\]{}\0]/u;
const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function fail(message) {
	throw new Error(`shipped Electron conformance failed closed: ${message}`);
}

function parseStrictJson(bytes, label) {
	let source;
	try {
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		fail(`${label} contains malformed UTF-8`);
	}

	let value;
	try {
		value = JSON.parse(source);
	} catch {
		fail(`${label} has invalid JSON parse syntax`);
	}

	let duplicateKey;
	const document = parseDocument(source, {
		uniqueKeys: (left, right) => {
			const duplicate = left.value === right.value;
			if (duplicate && duplicateKey === undefined) duplicateKey = String(right.value);
			return duplicate;
		},
	});
	const duplicateError = document.errors.find((error) => error.code === "DUPLICATE_KEY");
	if (duplicateError !== undefined)
		fail(`${label} contains duplicate JSON key ${JSON.stringify(duplicateKey ?? "<unknown>")}`);
	if (document.errors.length !== 0) fail(`${label} could not be inspected for duplicate JSON keys`);

	return value;
}

function exactKeys(value, expected, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain record`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain record`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has an invalid key set`);
	return value;
}

function exactStringArray(value, expected, label) {
	if (
		!Array.isArray(value) ||
		value.length !== expected.length ||
		value.some((item, index) => item !== expected[index])
	)
		fail(`${label} mismatch`);
}

function parseArguments(argv) {
	const parsed = { repositoryRoot: DEFAULT_REPOSITORY_ROOT, tier: undefined };
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== "--repository-root" && argument !== "--tier")
			fail(`unknown command-line argument ${String(argument)}`);
		if (seen.has(argument)) fail(`duplicate command-line argument ${argument}`);
		seen.add(argument);
		const value = argv[++index];
		if (typeof value !== "string" || value.length === 0 || value.startsWith("--"))
			fail(`${argument} requires one value`);
		if (argument === "--repository-root") parsed.repositoryRoot = value;
		else parsed.tier = value;
	}
	if (parsed.tier !== "pr" && parsed.tier !== "nightly") fail("--tier must be pr or nightly");
	return parsed;
}

function containedPath(repositoryRoot, repositoryRelativePath, label) {
	if (
		typeof repositoryRelativePath !== "string" ||
		repositoryRelativePath.length === 0 ||
		isAbsolute(repositoryRelativePath) ||
		PATH_META_CHARACTERS.test(repositoryRelativePath) ||
		repositoryRelativePath.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")
	)
		fail(`${label} must be an exact repository-relative path without glob or escape syntax`);
	const absolute = resolve(repositoryRoot, repositoryRelativePath);
	const fromRoot = relative(repositoryRoot, absolute);
	if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		fail(`${label} escapes the repository`);
	return absolute;
}

function regularFileWithoutSymlinks(repositoryRoot, repositoryRelativePath, label) {
	const absolute = containedPath(repositoryRoot, repositoryRelativePath, label);
	let current = repositoryRoot;
	for (const part of repositoryRelativePath.split("/")) {
		current = resolve(current, part);
		let stat;
		try {
			stat = lstatSync(current);
		} catch {
			fail(`${label} ${repositoryRelativePath} is missing or cannot be read`);
		}
		if (stat.isSymbolicLink()) fail(`${label} ${repositoryRelativePath} must not use a symlink`);
	}
	if (!lstatSync(absolute).isFile()) fail(`${label} ${repositoryRelativePath} must be a regular file`);
	const real = realpathSync(absolute);
	const fromRoot = relative(repositoryRoot, real);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		fail(`${label} resolves outside the repository`);
	return absolute;
}

function readExactFile(repositoryRoot, repositoryRelativePath, label) {
	const absolute = regularFileWithoutSymlinks(repositoryRoot, repositoryRelativePath, label);
	try {
		return { absolute, bytes: readFileSync(absolute) };
	} catch {
		fail(`${label} ${repositoryRelativePath} could not be read`);
	}
}

function loadManifest(repositoryRoot) {
	const loaded = readExactFile(repositoryRoot, AUTHORITATIVE_MANIFEST_PATH, "shipping manifest");
	const manifest = parseStrictJson(loaded.bytes, `shipping manifest ${AUTHORITATIVE_MANIFEST_PATH}`);
	exactKeys(manifest, ["schemaVersion", "shippingTargets"], "shipping manifest");
	if (manifest.schemaVersion !== 1) fail("shipping manifest schemaVersion must be 1");
	if (!Array.isArray(manifest.shippingTargets) || manifest.shippingTargets.length !== 1)
		fail("shipping manifest must declare exactly one Electron target");
	const target = exactKeys(manifest.shippingTargets[0], ["id", "runtime", "state", "versions"], "shipping target");
	if (target.id !== "electron-desktop") fail("shipping target id must be electron-desktop");
	if (target.runtime !== "electron") fail("shipping target runtime must be electron");
	if (target.state !== "inactive" && target.state !== "shipped")
		fail("shipping target state must be inactive or shipped");
	if (!Array.isArray(target.versions)) fail("shipping target versions must be an array");
	if (target.state === "inactive" && target.versions.length !== 0)
		fail("inactive shipping target versions must be empty");
	if (target.state === "shipped" && target.versions.length === 0)
		fail("shipped target requires at least one exact version");
	const versions = target.versions.map((rawVersion, index) => {
		const entry = exactKeys(rawVersion, ["runner", "version"], `shipping target version ${index}`);
		if (typeof entry.version !== "string" || !VERSION_PATTERN.test(entry.version))
			fail(`shipping target version ${index} has an invalid exact version`);
		containedPath(repositoryRoot, entry.runner, `shipping target version ${index} runner path`);
		return entry;
	});
	if (new Set(versions.map((entry) => entry.version)).size !== versions.length)
		fail("shipping target versions must be unique");
	return {
		bytes: loaded.bytes,
		manifest,
		target,
	};
}

function conformanceBinding(tier) {
	return {
		runnerRelativePath: CONFORMANCE_RUNNER_PATH,
		contractRelativePath: CONFORMANCE_CONTRACT_PATH,
		receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
		supportedTiers: [...SUPPORTED_TIERS],
		requiredEngines: [...REQUIRED_ENGINES],
		tier,
	};
}

function validateExecutionReceipt(receipt, target, entry, tier) {
	if (
		receipt === null ||
		typeof receipt !== "object" ||
		Array.isArray(receipt) ||
		!Object.prototype.hasOwnProperty.call(receipt, "result")
	)
		fail("Electron conformance receipt result is missing or invalid");
	exactKeys(
		receipt,
		["conformanceBinding", "receiptSchemaVersion", "result", "runtime", "targetId", "version"],
		"Electron conformance receipt"
	);
	if (receipt.receiptSchemaVersion !== RECEIPT_SCHEMA_VERSION)
		fail("Electron conformance receipt schema version mismatch");
	if (receipt.runtime !== target.runtime) fail("Electron conformance receipt runtime mismatch");
	if (receipt.targetId !== target.id) fail("Electron conformance receipt target mismatch");
	if (receipt.version !== entry.version) fail(`Electron conformance receipt version mismatch for ${entry.version}`);
	if (receipt.result !== "passed") fail("Electron conformance receipt result must be passed");
	const binding = exactKeys(
		receipt.conformanceBinding,
		["contractRelativePath", "receiptSchemaVersion", "requiredEngines", "runnerRelativePath", "supportedTiers", "tier"],
		"Electron conformance binding"
	);
	const expected = conformanceBinding(tier);
	if (
		binding.runnerRelativePath !== expected.runnerRelativePath ||
		binding.contractRelativePath !== expected.contractRelativePath ||
		binding.receiptSchemaVersion !== expected.receiptSchemaVersion ||
		binding.tier !== expected.tier
	)
		fail("Electron conformance receipt binding mismatch");
	exactStringArray(binding.supportedTiers, expected.supportedTiers, "supported tier binding");
	exactStringArray(binding.requiredEngines, expected.requiredEngines, "required engine binding");
}

function executeShippedVersion(repositoryRoot, target, entry, tier, contractPath) {
	const runnerPath = regularFileWithoutSymlinks(repositoryRoot, entry.runner, "Electron conformance runner");
	const invocation = spawnSync(
		process.execPath,
		[runnerPath, "--contract", contractPath, "--tier", tier, "--expected-version", entry.version],
		{
			cwd: repositoryRoot,
			env: { ...process.env, CI: "1" },
			timeout: 120_000,
		}
	);
	if (invocation.error !== undefined) fail(`Electron conformance runner failed for ${entry.version}`);
	if (invocation.status !== 0) fail(`Electron conformance runner exited unsuccessfully for ${entry.version}`);
	if (invocation.signal !== null) fail(`Electron conformance runner was terminated for ${entry.version}`);
	if (invocation.stderr.length !== 0)
		fail(`Electron conformance runner wrote non-receipt diagnostics for ${entry.version}`);
	const receipt = parseStrictJson(invocation.stdout, `Electron conformance runner receipt for ${entry.version}`);
	validateExecutionReceipt(receipt, target, entry, tier);
	return {
		conformanceBinding: conformanceBinding(tier),
		result: "passed",
		runner: entry.runner,
		runtime: target.runtime,
		targetId: target.id,
		version: entry.version,
	};
}

function main() {
	const { repositoryRoot: repositoryRootArgument, tier } = parseArguments(process.argv.slice(2));
	let repositoryRoot;
	try {
		repositoryRoot = realpathSync(repositoryRootArgument);
	} catch {
		fail("repository root is missing or cannot be read");
	}
	const manifest = loadManifest(repositoryRoot);
	const binding = conformanceBinding(tier);
	const discovery = {
		source: "shipping-target-manifest-only",
		dependencyInspection: false,
		authoritativeManifestPaths: [AUTHORITATIVE_MANIFEST_PATH],
		manifests: [
			{
				path: AUTHORITATIVE_MANIFEST_PATH,
				exactBytesSha256: createHash("sha256").update(manifest.bytes).digest("hex"),
			},
		],
	};
	const baseReceipt = {
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		discovery,
		conformanceBinding: binding,
		targets: manifest.manifest.shippingTargets,
	};
	if (manifest.target.state === "inactive") {
		process.stdout.write(`${JSON.stringify({ ...baseReceipt, result: "not-shipped" })}\n`);
		return;
	}
	const contractPath = regularFileWithoutSymlinks(
		repositoryRoot,
		CONFORMANCE_CONTRACT_PATH,
		"exact 0j-c conformance contract"
	);
	regularFileWithoutSymlinks(repositoryRoot, CONFORMANCE_RUNNER_PATH, "exact 0j-c conformance runner");
	const executions = manifest.target.versions.map((entry) =>
		executeShippedVersion(repositoryRoot, manifest.target, entry, tier, contractPath)
	);
	process.stdout.write(`${JSON.stringify({ ...baseReceipt, executions, result: "passed" })}\n`);
}

try {
	main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
