#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot =
	process.env.PROTOCOL_V3_FREEZE_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
		: resolve(process.env.PROTOCOL_V3_FREEZE_REPOSITORY_ROOT);

const protocolMajor = 3;
const registryVersion = 1;
const registryPath = "packages/protocol-v3/registry/registry-v1.json";
const originalRoot = "packages/protocol-v3/conformance/original-reference";
const regeneratedRoot = "packages/protocol-v3/conformance/regenerated-reference";
const vectorsRoot = "packages/protocol-v3/conformance/vectors";
const formalRoot = "packages/protocol-v3/formal";
const registryRoot = "packages/protocol-v3/registry";
const originalLockPath = "packages/protocol-v3/conformance/reference.lock.json";
const regeneratedLockPath = "packages/protocol-v3/conformance/reference-regen.lock.json";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-v3.json";
const checkerPath = "packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs";
const workflowPath = ".github/workflows/protocol-v3-registry.yml";
const codeownersPath = "CODEOWNERS";
const rootTestConfigPath = "vite.config.mts";
const workspaceConfigPath = "vitest.workspace.ts";
const ordinaryTestWorkflowPath = ".github/workflows/test.yml";
const alternateCodeownersPaths = Object.freeze([".github/CODEOWNERS", "docs/CODEOWNERS"]);
const ownerCohort = Object.freeze(["@d-roak", "@anhnd350309", "@sfroment"]);
const historicalCodeownersSha256 = "8a8f6949c7223b03d7671b07f8fef224395a4f987c5ad0262c11a3a5cbc9979d";
const historicalTestExclusions = Object.freeze([
	"**/node_modules",
	"**/e2e",
	"**/dist",
	"**/conformance/**",
	"**/.stryker-tmp/**",
	"docs/**",
]);
const historicalRedExclusion = "tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts";
const completeTestExclusions = Object.freeze([...historicalTestExclusions, historicalRedExclusion]);
const workspaceProjects = Object.freeze([
	"./vite.config.mts",
	"./examples/grid/vite.config.mts",
	"./examples/local-bootstrap/vite.config.mts",
	"./examples/canvas/vite.config.mts",
	"./examples/chat/vite.config.mts",
]);
const ordinaryTestCommand = "pnpm test";

const requiredSlices = Object.freeze([
	"phase-n1prime-a",
	"phase-n1prime-b",
	"phase-n1prime-b2a",
	"phase-n1prime-b2b",
	"phase-n1prime-c",
	"phase-n1prime-c-exhaustion",
	"phase-n1prime-d",
	"phase-n1prime-d2",
	"phase-n1prime-e",
	"phase-n1prime-e2",
	"phase-n1prime-e3",
	"phase-n1prime-e4",
]);

const externalPrerequisite =
	"External branch protection must require both the unchanged protocol-v2 status and the protocol-v3 status, require CODEOWNERS approval, prohibit direct and administrator bypass, and rerun on retarget. Repository artifacts cannot prove host configuration.";

const immutableInputs = Object.freeze({
	"docs/protocol/amendments-v3.json": "e83625828b38ae398cfdb8e8aa4d404ce90e64a43884b248a4d928e14a392508",
	"docs/protocol/attested-hard-epochs-v5.md": "a2d1c818eecf4524aac60d102aded73eafdab8cb613e7a53a91d79fff9ac9db8",
	"docs/protocol/canonical-tag-codec-v1.json": "64426584f7c3217a42e258ec5d2eaae368d209dd520c0653361a1aca82aa705e",
	"docs/protocol/canonical-tag-codec-v1.md": "40f817866619931cd13461393005ea2a796de343591e3ec88be404664e8e5036",
	"packages/protocol-v3/conformance/original-reference/provenance.json":
		"8b5e24c89dd32735ad95ca2a10a98e80dd2bb2623e0188b1355b51076bc90bc3",
	"packages/protocol-v3/conformance/original-reference/reference.mjs":
		"abb01f2f061b20428e1c412793380a0baf468bf9397c7ec2952a902f2aaf7bdc",
	"packages/protocol-v3/conformance/regenerated-reference/provenance.json":
		"1ea3a9e0da6d6df667101e7e8c5e208b6eca45da6954cbfaf9da1cef6e50eae4",
	"packages/protocol-v3/conformance/regenerated-reference/reference.mjs":
		"0a7b199eec2f1a950d4b91d9041e382f02983e2d601a530de60e7311309ce84a",
	"packages/protocol-v3/conformance/vectors/registry-v1.json":
		"8b84504ae98b37beae2d91ef8fa29f9a61299a236d32a12b63f24cb2757da741",
	"packages/protocol-v3/formal/author-lineage-actions.qnt":
		"7971a025959164f609f4509bf4242f94fc4cc0b6974dde903bf462852983f038",
	"packages/protocol-v3/formal/registry-model-signoff.json":
		"9b93fd6d843817a2e59309f11cba049d129ed5e862e26bc3706d3f4d1fdc5749",
	"packages/protocol-v3/formal/registry-signed-envelope-variables.qnt":
		"f6dede1370a40a37d2dca526a27f3dc5c6884c9b8c23390da3372977c2bcef13",
	"packages/protocol-v3/formal/signed-field-derivation.json":
		"e693b3fec5ef0d73299642d49e5ab7fdc969df80214f1d9891a05e188d1b7346",
	"packages/protocol-v3/registry/registry-v1.json": "2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9",
	"packages/protocol-v3/registry/registry-v1.schema.json":
		"6ab6f377457cbe43d79c0aee4b766683c7c202cd308481db66f04e723787fbdc",
	"tests/fixtures/phase-n1prime-a/formal-action-contract.json":
		"474c83e7a3f130504e8dedc8ceb0843ee3413ca56c27003a354f6088b0f41dcf",
	"tests/fixtures/phase-n1prime-b/registry-spec-contract.json":
		"0f8e1d62a7eb75961addc07fcc32a6c228ca2c432a3bbafd11478c828c2fc324",
	"tests/fixtures/phase-n1prime-b2a/canonical-grammar-contract.json":
		"fd921870b36ddab56987b8bc21cc0ad9599884b43364ba45c10a9e1ba365c0cf",
	"tests/fixtures/phase-n1prime-b2b/codec-grammar-decision-contract.json":
		"51848429253440aa103e8b45d942975f8e029df18a3cc5f25c1df2b4c9da5c16",
	"tests/fixtures/phase-n1prime-c/reference-vector-contract.json":
		"1f84788cad31a3fd737cf55d5da053748ea4e997bd4c5dbf4cf50fa568816840",
	"tests/fixtures/phase-n1prime-c-exhaustion/paired-issuance-contract.json":
		"793da47de639ba3d40a205aab301e0b8b2a456347ded7b3d7a3c4bf3159dcd77",
	"tests/fixtures/phase-n1prime-c2/independent-reference-vector-contract.json":
		"17e22228adc677f9287ced3610211b21ec926e7647b1179574f2299359ccca62",
	"tests/fixtures/phase-n1prime-d/regenerated-reference-contract.json":
		"f46c4ee3be04f4b0a53d4180322c1e8f4ad201d280ef4f2c5f0beb0bdfd1ab83",
	"tests/fixtures/phase-n1prime-d2/blocker-remediation-inputs.json":
		"54c4193a03ee2d2b792d340e0128dd5de4721c7d25f69f4cffb640e86b94261f",
	"tests/protocol-v3-canonical-grammar-n1prime-b2a.test.ts":
		"f2f25dd9ae70971ffe920c0ab653e46b15f090d8b4fe5a6ba4e9157abe4aed89",
	"tests/protocol-v3-codec-grammar-decision-n1prime-b2b.test.ts":
		"6f69554debf9caa8f30273324cc223631d70f6d76534be2b0d4e33281ce57b1e",
	"tests/protocol-v3-formal-action-model-n1prime-a.test.ts":
		"affc5e439220e8ac6353c0795f591da3946a6aeb37d69a71a05763f229f34f6d",
	"tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts":
		"10f1f8b502cb599da6350cc13192e8fbe407710698c187e26ffe2e84d47374a2",
	"tests/protocol-v3-independent-reference-vectors-n1prime-c2.test.ts":
		"d1d4751ccdb8db0e8dbd11e7e353727cdd3a6ef3c739a4a6e1680c16bf1a9b12",
	"tests/protocol-v3-issuance-exhaustion-n1prime-c.test.ts":
		"23c5f1eb8d87f9fa9a758670216430d1bc96b8aaa6b4912a4d53690a1f9ae1b1",
	"tests/protocol-v3-regenerated-reference-n1prime-d.test.ts":
		"d2026fc81c98c709da7ca0dc94d20cd05b56a5e871b35f6e715aec63920fd407",
	"tests/protocol-v3-regenerated-reference-remediation-n1prime-d2.test.ts":
		"c07b64dfaa6e5f40095773f5e81c8847c2a736af5a8c365937db80ef3a77926f",
	"tests/protocol-v3-registry-spec-n1prime-b.test.ts":
		"380cce1ad170422be6cab1c3ba316341b63700da2e9ef0588eed6f54897b4022",
});

const provenanceBindings = Object.freeze({
	originalProvenance: Object.freeze({
		path: `${originalRoot}/provenance.json`,
		sha256: immutableInputs[`${originalRoot}/provenance.json`],
	}),
	originalSource: Object.freeze({
		path: `${originalRoot}/reference.mjs`,
		sha256: immutableInputs[`${originalRoot}/reference.mjs`],
	}),
	regeneratedProvenance: Object.freeze({
		path: `${regeneratedRoot}/provenance.json`,
		sha256: immutableInputs[`${regeneratedRoot}/provenance.json`],
	}),
	regeneratedSource: Object.freeze({
		path: `${regeneratedRoot}/reference.mjs`,
		sha256: immutableInputs[`${regeneratedRoot}/reference.mjs`],
	}),
	registry: Object.freeze({
		path: registryPath,
		sha256: immutableInputs[registryPath],
	}),
	vectors: Object.freeze({
		path: `${vectorsRoot}/registry-v1.json`,
		sha256: immutableInputs[`${vectorsRoot}/registry-v1.json`],
	}),
});

const v3CodeownersPatterns = Object.freeze([
	"/packages/protocol-v3/registry/**",
	"/docs/protocol/attested-hard-epochs-v5.md",
	"/docs/protocol/amendments-v3.json",
	"/docs/protocol/canonical-tag-codec-v1.md",
	"/docs/protocol/canonical-tag-codec-v1.json",
	"/packages/protocol-v3/formal/**",
	"/packages/protocol-v3/conformance/original-reference/**",
	"/packages/protocol-v3/conformance/regenerated-reference/**",
	"/packages/protocol-v3/conformance/vectors/**",
	"/packages/protocol-v3/conformance/reference.lock.json",
	"/packages/protocol-v3/conformance/reference-regen.lock.json",
	"/packages/protocol-v3/conformance/freeze-policy-v3.json",
	"/packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs",
	"/.github/workflows/protocol-v3-registry.yml",
]);

const terminalV2CodeownersBlock = Object.freeze([
	"/CODEOWNERS @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/registry/** @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/tests/fixtures/golden-vectors/** @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/conformance/reference.lock.json @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/conformance/freeze-policy.json @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/conformance/ahe-reference/src/** @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/conformance/ahe-reference-regen/** @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/conformance/reference-regen.lock.json @d-roak @anhnd350309 @sfroment",
	"/packages/protocol-v2/scripts/check-protocol-freeze.mjs @d-roak @anhnd350309 @sfroment",
	"/.github/workflows/protocol-v2-registry.yml @d-roak @anhnd350309 @sfroment",
]);

const governancePaths = Object.freeze([
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	workflowPath,
	codeownersPath,
]);

const evidencePaths = Object.freeze([
	"tests/protocol-v3-freeze-governance-n1prime-e.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e2.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e3.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e4.test.ts",
	"tests/fixtures/phase-n1prime-e/freeze-governance-contract.json",
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json",
]);

const completePolicyPaths = Object.freeze([
	...Object.keys(immutableInputs),
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	...alternateCodeownersPaths,
	workflowPath,
	codeownersPath,
	...evidencePaths,
]);

const bootstrapV3Paths = Object.freeze([
	...Object.keys(immutableInputs),
	...governancePaths.slice(0, -1),
	...evidencePaths,
]);

const governedTrees = Object.freeze({
	[formalRoot]: Object.freeze([
		"author-lineage-actions.qnt",
		"registry-model-signoff.json",
		"registry-signed-envelope-variables.qnt",
		"signed-field-derivation.json",
	]),
	[originalRoot]: Object.freeze(["provenance.json", "reference.mjs"]),
	[regeneratedRoot]: Object.freeze(["provenance.json", "reference.mjs"]),
	[registryRoot]: Object.freeze(["registry-v1.json", "registry-v1.schema.json"]),
	[vectorsRoot]: Object.freeze(["registry-v1.json"]),
});

function fail(message) {
	throw new Error(`protocol-v3 freeze violation: ${message}`);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertHash(value, label) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail(`${label} is not a SHA-256 digest`);
}

function exactRecord(actual, expected, label) {
	if (!isRecord(actual)) fail(`${label} is absent or malformed`);
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = Object.keys(expected).sort();
	if (!isDeepStrictEqual(actualKeys, expectedKeys)) fail(`${label} key set differs`);
	for (const key of expectedKeys) {
		if (!isDeepStrictEqual(actual[key], expected[key])) fail(`${label} differs at ${key}`);
	}
}

function tokenizeStaticJavaScript(source, label) {
	if (typeof source !== "string") fail(`${label} is absent`);
	const tokens = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (/\s/u.test(character)) {
			index += 1;
			continue;
		}
		if (source.startsWith("//", index)) {
			const newline = source.indexOf("\n", index + 2);
			index = newline < 0 ? source.length : newline + 1;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) fail(`${label} contains an unterminated block comment`);
			index = end + 2;
			continue;
		}
		if (character === '"' || character === "'") {
			const quote = character;
			let value = "";
			let closed = false;
			index += 1;
			while (index < source.length) {
				const current = source[index];
				if (current === quote) {
					index += 1;
					closed = true;
					break;
				}
				if (current === "\n" || current === "\r") fail(`${label} contains a multiline string literal`);
				if (current !== "\\") {
					value += current;
					index += 1;
					continue;
				}
				index += 1;
				if (index >= source.length) fail(`${label} contains an unterminated string escape`);
				const escaped = source[index];
				const simpleEscapes = {
					b: "\b",
					f: "\f",
					n: "\n",
					r: "\r",
					t: "\t",
					v: "\v",
				};
				if (Object.hasOwn(simpleEscapes, escaped)) {
					value += simpleEscapes[escaped];
					index += 1;
					continue;
				}
				if (escaped === "\n") {
					index += 1;
					continue;
				}
				if (escaped === "\r" && source[index + 1] === "\n") {
					index += 2;
					continue;
				}
				if (escaped === "x" || escaped === "u") {
					const width = escaped === "x" ? 2 : 4;
					const digits = source.slice(index + 1, index + 1 + width);
					if (!new RegExp(`^[0-9a-fA-F]{${width}}$`, "u").test(digits)) {
						fail(`${label} contains an invalid hexadecimal string escape`);
					}
					value += String.fromCodePoint(Number.parseInt(digits, 16));
					index += width + 1;
					continue;
				}
				value += escaped;
				index += 1;
			}
			if (!closed) fail(`${label} contains an unterminated string literal`);
			tokens.push({ kind: "string", value });
			continue;
		}
		const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(index));
		if (identifier !== null) {
			tokens.push({ kind: "identifier", value: identifier[0] });
			index += identifier[0].length;
			continue;
		}
		if (source.startsWith("...", index)) {
			tokens.push({ kind: "punctuation", value: "..." });
			index += 3;
			continue;
		}
		tokens.push({ kind: "punctuation", value: character });
		index += 1;
	}
	return tokens;
}

function directDefaultCallArgument(tokens, callee, label) {
	const matches = [];
	for (let index = 0; index < tokens.length - 3; index += 1) {
		if (
			tokens[index].kind === "identifier" &&
			tokens[index].value === "export" &&
			tokens[index + 1].kind === "identifier" &&
			tokens[index + 1].value === "default" &&
			tokens[index + 2].kind === "identifier" &&
			tokens[index + 2].value === callee &&
			tokens[index + 3].value === "("
		) {
			matches.push(index + 4);
		}
	}
	if (matches.length !== 1) fail(`${label} must directly export exactly one ${callee}(...) call`);
	return matches[0];
}

function matchingDelimiter(tokens, openIndex, label) {
	const pairs = { "(": ")", "[": "]", "{": "}" };
	const expectedClose = pairs[tokens[openIndex]?.value];
	if (expectedClose === undefined) fail(`${label} does not start with a delimiter`);
	const stack = [expectedClose];
	for (let index = openIndex + 1; index < tokens.length; index += 1) {
		const value = tokens[index].value;
		if (Object.hasOwn(pairs, value)) {
			stack.push(pairs[value]);
			continue;
		}
		if (value !== stack.at(-1)) continue;
		stack.pop();
		if (stack.length === 0) return index;
	}
	fail(`${label} has an unmatched delimiter`);
}

function directCallExpression(tokens, argumentStart, expectedOpen, label) {
	if (tokens[argumentStart]?.value !== expectedOpen) fail(`${label} must be a literal ${expectedOpen} expression`);
	const closeIndex = matchingDelimiter(tokens, argumentStart, label);
	if (tokens[closeIndex + 1]?.value !== ")") fail(`${label} call must have exactly one direct argument`);
	return { closeIndex, openIndex: argumentStart };
}

function objectPropertyInitializer(tokens, objectOpen, propertyName, label) {
	if (tokens[objectOpen]?.value !== "{") fail(`${label} must be a literal object`);
	const objectClose = matchingDelimiter(tokens, objectOpen, label);
	const matches = [];
	let index = objectOpen + 1;
	while (index < objectClose) {
		if (tokens[index].value === ",") {
			index += 1;
			continue;
		}
		if (tokens[index].value === "...") fail(`${label} must not contain spread properties`);
		const key = tokens[index];
		if (key.kind !== "identifier" && key.kind !== "string") {
			fail(`${label} must contain only static property assignments`);
		}
		if (tokens[index + 1]?.value !== ":") fail(`${label}.${key.value} must be a static property assignment`);
		const initializer = index + 2;
		if (initializer >= objectClose) fail(`${label}.${key.value} has no initializer`);
		let cursor = initializer;
		const stack = [];
		while (cursor < objectClose) {
			const value = tokens[cursor].value;
			if (stack.length === 0 && value === ",") break;
			if (value === "(" || value === "[" || value === "{") {
				stack.push({ "(": ")", "[": "]", "{": "}" }[value]);
			} else if (value === stack.at(-1)) {
				stack.pop();
			}
			cursor += 1;
		}
		if (stack.length !== 0) fail(`${label}.${key.value} has an unmatched delimiter`);
		if (key.value === propertyName) matches.push(initializer);
		index = cursor + (tokens[cursor]?.value === "," ? 1 : 0);
	}
	if (matches.length !== 1) fail(`${label} must contain exactly one static ${propertyName} property`);
	return matches[0];
}

function literalStringArray(tokens, arrayOpen, label) {
	if (tokens[arrayOpen]?.value !== "[") fail(`${label} must be a literal array`);
	const arrayClose = matchingDelimiter(tokens, arrayOpen, label);
	const values = [];
	let index = arrayOpen + 1;
	while (index < arrayClose) {
		const token = tokens[index];
		if (token.kind !== "string") fail(`${label} must contain only static string literals`);
		values.push(token.value);
		index += 1;
		if (index === arrayClose) break;
		if (tokens[index].value !== ",") fail(`${label} entries must be comma-separated`);
		index += 1;
	}
	return values;
}

function rootTestExclusions(source) {
	const label = "root Vitest config";
	const tokens = tokenizeStaticJavaScript(source, label);
	const root = directCallExpression(tokens, directDefaultCallArgument(tokens, "defineConfig", label), "{", label);
	const test = objectPropertyInitializer(tokens, root.openIndex, "test", label);
	const exclude = objectPropertyInitializer(tokens, test, "exclude", "root test config");
	return literalStringArray(tokens, exclude, "root test.exclude");
}

function rootWorkspaceProjects(source) {
	const label = "root Vitest workspace";
	const tokens = tokenizeStaticJavaScript(source, label);
	const workspace = directCallExpression(
		tokens,
		directDefaultCallArgument(tokens, "defineWorkspace", label),
		"[",
		label
	);
	return literalStringArray(tokens, workspace.openIndex, "root Vitest workspace projects");
}

function literalWorkflowRunCommands(source) {
	if (typeof source !== "string") fail("ordinary test workflow is absent");
	const lines = source.split(/\r?\n/u);
	const commands = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
		if (match === null) continue;
		const indentation = match[1].length;
		for (index += 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.trim().length === 0) continue;
			const commandIndentation = /^\s*/u.exec(line)?.[0].length ?? 0;
			if (commandIndentation <= indentation) {
				index -= 1;
				break;
			}
			commands.push(line.trim());
		}
	}
	return commands;
}

function validateTestLifecycle(snapshot, expectedExclusions) {
	const sources = snapshot.testLifecycle;
	if (!isRecord(sources)) fail("root test lifecycle sources are absent or malformed");
	exactRecord(
		sources,
		{
			ordinaryCi: sources.ordinaryCi,
			rootConfig: sources.rootConfig,
			workspace: sources.workspace,
		},
		"root test lifecycle sources"
	);
	if (!isDeepStrictEqual(rootTestExclusions(sources.rootConfig), expectedExclusions)) {
		fail("root test.exclude differs from the exact lifecycle contract");
	}
	if (!isDeepStrictEqual(rootWorkspaceProjects(sources.workspace), workspaceProjects)) {
		fail("root Vitest workspace projects differ from the exact lifecycle contract");
	}
	const ordinaryCommands = literalWorkflowRunCommands(sources.ordinaryCi).filter(
		(command) => command === ordinaryTestCommand
	);
	if (ordinaryCommands.length !== 1) {
		fail(`ordinary test workflow must contain exactly one literal ${ordinaryTestCommand} run command`);
	}
}

function matchesPattern(path, pattern) {
	return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

function isBootstrapV3Path(path) {
	return (
		path.startsWith("packages/protocol-v3/") ||
		path.startsWith("tests/protocol-v3-") ||
		path.startsWith("tests/fixtures/phase-n1prime-") ||
		bootstrapV3Paths.includes(path)
	);
}

function codeownersEntries(source) {
	if (typeof source !== "string") fail("root CODEOWNERS is absent");
	return source
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function expectedV3CodeownersBlock() {
	const owners = ownerCohort.join(" ");
	return v3CodeownersPatterns.map((pattern) => `${pattern} ${owners}`);
}

function insertedCodeowners(baseSource) {
	const terminal = terminalV2CodeownersBlock.join("\n");
	const index = baseSource.indexOf(terminal);
	if (index < 0 || baseSource.indexOf(terminal, index + 1) !== -1) {
		fail("bootstrap CODEOWNERS terminal v2 block is ambiguous");
	}
	const block = [
		"# Protocol-v3 consensus bytes and their additive freeze controls share the frozen v2 owner cohort.",
		...expectedV3CodeownersBlock(),
		"",
	].join("\n");
	return `${baseSource.slice(0, index)}${block}${baseSource.slice(index)}`;
}

function validateCodeowners(snapshot) {
	if (!Array.isArray(snapshot.alternateCodeowners) || snapshot.alternateCodeowners.length !== 0) {
		fail("higher-precedence CODEOWNERS file appeared");
	}
	const entries = codeownersEntries(snapshot.codeowners);
	const expectedBlock = expectedV3CodeownersBlock();
	const expectedSuffix = [...expectedBlock, ...terminalV2CodeownersBlock];
	if (!isDeepStrictEqual(entries.slice(-expectedSuffix.length), expectedSuffix)) {
		fail("v3 ownership must immediately precede the exact terminal v2 block");
	}
	for (const entry of expectedBlock) {
		if (entries.filter((candidate) => candidate === entry).length !== 1) {
			fail(`v3 CODEOWNERS rule is missing or duplicated: ${entry}`);
		}
	}
	if (snapshot.files[codeownersPath] !== sha256(snapshot.codeowners)) fail("CODEOWNERS snapshot hash is stale");
}

function validateWorkflow(snapshot) {
	const workflow = snapshot.workflow;
	if (typeof workflow !== "string") fail("protocol-v3 workflow is absent");
	if (snapshot.files[workflowPath] !== sha256(workflow)) fail("workflow snapshot hash is stale");
	const lines = workflow.split(/\r?\n/u);
	for (const line of [
		"name: Protocol v3 atomic freeze change control",
		"on:",
		"  pull_request:",
		"    types: [opened, synchronize, reopened, edited, ready_for_review]",
		"permissions:",
		"  contents: read",
		"jobs:",
		"  protocol-v3-freeze:",
		"    name: Require protocol-v3 atomic freeze",
		"    runs-on: ubuntu-latest",
		"    timeout-minutes: 10",
		"          fetch-depth: 0",
		"          ref: ${{ github.sha }}",
		"          BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		"          V2_CHECKER: packages/protocol-v2/scripts/check-protocol-freeze.mjs",
		`          V3_CHECKER: ${checkerPath}`,
		`          V3_POLICY: ${policyPath}`,
		`          V3_ORIGINAL_LOCK: ${originalLockPath}`,
		`          V3_REGENERATED_LOCK: ${regeneratedLockPath}`,
		`          V3_REGISTRY: ${registryPath}`,
		`          V3_ORIGINAL_REFERENCE: ${originalRoot}/reference.mjs`,
		`          V3_REGENERATED_REFERENCE: ${regeneratedRoot}/reference.mjs`,
		`          V3_VECTORS: ${vectorsRoot}/registry-v1.json`,
	]) {
		if (lines.filter((candidate) => candidate === line).length !== 1) {
			fail(`protocol-v3 workflow must contain exactly one structural line: ${line}`);
		}
	}
	const checkoutSteps = lines.filter((line) => /^ {6}- uses: actions\/checkout@v[1-9][0-9]*$/u.test(line));
	const setupNodeSteps = lines.filter((line) => /^ {6}- uses: actions\/setup-node@v[1-9][0-9]*$/u.test(line));
	const nodeVersions = lines
		.map((line) => /^ {10}node-version: ([1-9][0-9]*)$/u.exec(line))
		.filter((match) => match !== null)
		.map((match) => Number(match[1]));
	if (checkoutSteps.length !== 1 || setupNodeSteps.length !== 1 || nodeVersions.length !== 1 || nodeVersions[0] < 22) {
		fail("protocol-v3 workflow must have one checkout, one setup-node, and Node >=22");
	}
	const runIndex = lines.indexOf("        run: |");
	const runner = runIndex < 0 ? [] : lines.slice(runIndex + 1).map((line) => line.replace(/^ {10}/u, ""));
	const expectedRunner = [
		'git show "$BASE_SHA:$V2_CHECKER" > "$RUNNER_TEMP/check-protocol-v2-freeze.mjs"',
		'PROTOCOL_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\',
		'  node "$RUNNER_TEMP/check-protocol-v2-freeze.mjs" "$BASE_SHA"',
		'if git cat-file -e "$BASE_SHA:$V3_CHECKER"; then',
		'  git show "$BASE_SHA:$V3_CHECKER" > "$RUNNER_TEMP/check-protocol-v3-freeze.mjs"',
		'  PROTOCOL_V3_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\',
		'    node "$RUNNER_TEMP/check-protocol-v3-freeze.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$V3_POLICY" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_LOCK" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_REGENERATED_LOCK" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_REGISTRY" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_REFERENCE" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_REGENERATED_REFERENCE" \\',
		'  && ! git cat-file -e "$BASE_SHA:$V3_VECTORS"; then',
		`  node ${checkerPath} "$BASE_SHA"`,
		"else",
		'  echo "Protocol-v3 freeze bootstrap is fail-closed and single-use." >&2',
		"  exit 1",
		"fi",
		"",
	];
	if (!isDeepStrictEqual(runner, expectedRunner)) {
		fail("protocol-v3 workflow runner differs from the v2-first, base-v3-first, single-use bootstrap runner");
	}
	for (const forbidden of [
		/\bpull_request_target\b/u,
		/^\s*(?:paths|paths-ignore|branches|branches-ignore):/mu,
		/^\s*(?:if|continue-on-error):/mu,
		/^\s+[A-Za-z-]+:\s+write\s*$/mu,
		/\bpnpm (?:install|--filter)\b/u,
	]) {
		if (forbidden.test(workflow)) fail(`protocol-v3 workflow contains forbidden structure: ${forbidden}`);
	}
}

function expectedReferenceFiles(role) {
	const root = role === "original" ? originalRoot : regeneratedRoot;
	return {
		"provenance.json": immutableInputs[`${root}/provenance.json`],
		"reference.mjs": immutableInputs[`${root}/reference.mjs`],
	};
}

function validateReferenceLock(lock, role) {
	if (!isRecord(lock)) fail(`${role} reference lock is absent`);
	if (lock.schemaVersion !== "protocol-v3-reference-lock-v1" || lock.algorithm !== "sha256") {
		fail(`${role} reference lock format is invalid`);
	}
	const treeRoot = role === "original" ? originalRoot : regeneratedRoot;
	if (lock.referenceRole !== role || lock.treeRoot !== treeRoot) fail(`${role} reference lock targets the wrong tree`);
	exactRecord(lock.files, expectedReferenceFiles(role), `${role} reference lock files`);
	exactRecord(lock.provenanceBindings, provenanceBindings, `${role} reference provenance bindings`);
}

function validatePolicy(policy, snapshot) {
	if (!isRecord(policy)) fail("freeze policy is absent");
	if (policy.schemaVersion !== "protocol-v3-freeze-policy-v1" || policy.version !== 1) {
		fail("freeze policy format is invalid");
	}
	if (
		policy.protocolMajor !== protocolMajor ||
		policy.registryVersion !== registryVersion ||
		policy.registryPath !== registryPath
	) {
		fail("freeze policy targets the wrong protocol registry");
	}
	if (!isRecord(policy.checker) || policy.checker.path !== checkerPath) {
		fail("freeze policy targets the wrong checker");
	}
	assertHash(policy.checker.sha256, "freeze policy checker pin");
	if (policy.checker.sha256 !== snapshot.files[checkerPath]) {
		fail("freeze policy does not pin the checked checker bytes");
	}
	if (
		!isRecord(policy.locks) ||
		policy.locks.original !== originalLockPath ||
		policy.locks.regenerated !== regeneratedLockPath
	) {
		fail("freeze policy does not bind both reference locks");
	}
	exactRecord(policy.immutableInputs, immutableInputs, "policy immutable inputs");
	if (
		!Array.isArray(policy.protectedPaths) ||
		policy.protectedPaths.some((path) => typeof path !== "string") ||
		!isDeepStrictEqual(policy.protectedPaths, completePolicyPaths)
	) {
		fail("freeze policy protectedPaths differs from the exact declared v3 surface");
	}
	if (
		!isRecord(policy.checkpoint) ||
		policy.checkpoint.authoritative !== true ||
		policy.checkpoint.partialClaimsAllowed !== false ||
		!isDeepStrictEqual(policy.checkpoint.requiredSlices, requiredSlices) ||
		policy.checkpoint.externalPrerequisite !== externalPrerequisite
	) {
		fail("policy makes a partial or dishonest atomic checkpoint claim");
	}
}

function validateGovernedTrees(snapshot) {
	for (const [root, expectedFiles] of Object.entries(governedTrees)) {
		const actualFiles = Object.keys(snapshot.files)
			.filter((path) => path.startsWith(`${root}/`))
			.map((path) => relative(root, path).replaceAll("\\", "/"))
			.sort();
		if (!isDeepStrictEqual(actualFiles, [...expectedFiles].sort())) {
			fail(`${root} is incomplete or contains an extra file`);
		}
	}
}

function validateTuple(snapshot) {
	if (
		snapshot.protocolMajor !== protocolMajor ||
		snapshot.registryVersion !== registryVersion ||
		snapshot.registryPath !== registryPath
	) {
		fail("snapshot is not protocolMajor 3 / registryVersion 1 / registry-v1.json");
	}
	if (!isRecord(snapshot.files)) fail("snapshot files must be a content map");
	for (const [path, digest] of Object.entries(immutableInputs)) {
		if (snapshot.files[path] !== digest) fail(`accepted successor input drifted: ${path}`);
	}
	validateGovernedTrees(snapshot);
}

function validateCompleteClosure(snapshot) {
	validateTuple(snapshot);
	validateTestLifecycle(snapshot, completeTestExclusions);
	if (snapshot.bootstrapConsumed !== true) fail("complete closure has not permanently consumed bootstrap");
	if (snapshot.v2StatusPassed !== true) {
		fail("protocol-v3 status cannot pass while unchanged protocol-v2 status fails");
	}
	for (const target of governancePaths) {
		if (snapshot.files[target] === undefined) fail(`complete closure target is absent: ${target}`);
	}
	for (const path of evidencePaths) {
		if (snapshot.files[path] === undefined) fail(`complete closure governance evidence is absent: ${path}`);
	}
	validatePolicy(snapshot.policy, snapshot);
	validateReferenceLock(snapshot.locks?.original, "original");
	validateReferenceLock(snapshot.locks?.regenerated, "regenerated");
	validateCodeowners(snapshot);
	validateWorkflow(snapshot);
	for (const lock of [snapshot.locks?.original, snapshot.locks?.regenerated]) {
		for (const binding of Object.values(lock.provenanceBindings)) {
			if (snapshot.files[binding.path] !== binding.sha256) fail(`provenance binding is stale: ${binding.path}`);
		}
	}
}

function validateBootstrapBase(snapshot) {
	if (snapshot.preV3 !== true) fail("bootstrap base is not the exact pre-v3 state");
	validateTestLifecycle(snapshot, historicalTestExclusions);
	if (snapshot.bootstrapConsumed !== false) fail("protocol-v3 freeze bootstrap is single-use");
	if (snapshot.policy !== undefined || snapshot.locks !== undefined || snapshot.workflow !== undefined) {
		fail("bootstrap base already contains v3 governance");
	}
	if (!isRecord(snapshot.files)) fail("bootstrap base files must be a content map");
	for (const path of Object.keys(snapshot.files)) {
		if (isBootstrapV3Path(path)) fail(`bootstrap base already contains ${path}`);
	}
	if (snapshot.v2StatusPassed !== true) fail("bootstrap requires unchanged protocol-v2 governance");
	if (!Array.isArray(snapshot.alternateCodeowners) || snapshot.alternateCodeowners.length !== 0) {
		fail("bootstrap base has higher-precedence CODEOWNERS");
	}
	if (sha256(snapshot.codeowners) !== historicalCodeownersSha256) {
		fail("bootstrap base is not the exact accepted pre-v3 CODEOWNERS state");
	}
	if (snapshot.files[codeownersPath] !== historicalCodeownersSha256) {
		fail("bootstrap CODEOWNERS snapshot hash is stale");
	}
	const entries = codeownersEntries(snapshot.codeowners);
	if (!isDeepStrictEqual(entries.slice(-terminalV2CodeownersBlock.length), terminalV2CodeownersBlock)) {
		fail("bootstrap base does not retain the exact terminal v2 CODEOWNERS block");
	}
	if (v3CodeownersPatterns.some((pattern) => entries.some((entry) => entry.startsWith(`${pattern} `)))) {
		fail("bootstrap base already contains the v3 CODEOWNERS block");
	}
}

function compareProtectedState(base, current, pattern) {
	const basePaths = Object.keys(base.files)
		.filter((path) => matchesPattern(path, pattern))
		.sort();
	const currentPaths = Object.keys(current.files)
		.filter((path) => matchesPattern(path, pattern))
		.sort();
	if (!isDeepStrictEqual(basePaths, currentPaths)) fail(`base-protected file set changed: ${pattern}`);
	for (const path of basePaths) {
		if (base.files[path] !== current.files[path]) fail(`base-protected artifact changed: ${path}`);
	}
}

/**
 * Evaluate an arbitrary pair of content-addressed protocol-v3 freeze snapshots.
 * The first complete closure may bootstrap only from the exact frozen-v2,
 * no-v3 state. Every later proposal is governed exclusively by the complete
 * merge-base copy.
 * @param root0 - The base/current snapshot pair.
 * @param root0.base - The merge-base snapshot.
 * @param root0.current - The proposed snapshot.
 */
export function evaluateProtocolV3Freeze({ base, current }) {
	if (!isRecord(base) || !isRecord(current)) fail("base and current snapshots are required");
	if (base.policy === undefined) {
		validateBootstrapBase(base);
		validateCompleteClosure(current);
		if (current.codeowners !== insertedCodeowners(base.codeowners)) {
			fail("bootstrap may only insert the exact v3 block immediately above the untouched terminal v2 block");
		}
		return;
	}
	validateCompleteClosure(base);
	validateCompleteClosure(current);
	if (!isDeepStrictEqual(current.policy, base.policy)) fail("base freeze policy changed");
	for (const pattern of base.policy.protectedPaths) compareProtectedState(base, current, pattern);
	if (
		current.policy.checker.path !== base.policy.checker.path ||
		current.policy.checker.sha256 !== base.policy.checker.sha256
	) {
		fail("checker and pin cannot be replaced in the same proposal");
	}
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

function parseJson(bytes, label) {
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		fail(`${label} is not valid JSON`);
	}
}

function listRevisionFiles(revision) {
	const output = git(["ls-tree", "-r", "--name-only", revision]);
	return output.length === 0 ? [] : output.split("\n");
}

function listWorkingFiles() {
	const output = git(["ls-files", "--cached", "--others", "--exclude-standard"]);
	return output.length === 0 ? [] : output.split("\n");
}

function relevantPath(path, governingPaths) {
	if (
		governingPaths.some((pattern) => matchesPattern(path, pattern)) ||
		governancePaths.includes(path) ||
		alternateCodeownersPaths.includes(path) ||
		Object.hasOwn(immutableInputs, path)
	) {
		return true;
	}
	return Object.keys(governedTrees).some((root) => path.startsWith(`${root}/`));
}

function readTestLifecycle(read) {
	return {
		ordinaryCi: read(ordinaryTestWorkflowPath)?.toString("utf8"),
		rootConfig: read(rootTestConfigPath)?.toString("utf8"),
		workspace: read(workspaceConfigPath)?.toString("utf8"),
	};
}

function makeSnapshot(read, paths, governingPaths) {
	const files = {};
	for (const path of paths) {
		if (!relevantPath(path, governingPaths)) continue;
		const bytes = read(path);
		if (bytes !== undefined) files[path] = sha256(bytes);
	}
	const policy = parseJson(read(policyPath), policyPath);
	const original = parseJson(read(originalLockPath), originalLockPath);
	const regenerated = parseJson(read(regeneratedLockPath), regeneratedLockPath);
	const workflowBytes = read(workflowPath);
	const codeownersBytes = read(codeownersPath);
	const preV3 = !paths.some(isBootstrapV3Path);
	if (preV3) {
		return {
			alternateCodeowners: alternateCodeownersPaths.filter((path) => read(path) !== undefined),
			bootstrapConsumed: false,
			codeowners: codeownersBytes?.toString("utf8"),
			files,
			preV3: true,
			testLifecycle: readTestLifecycle(read),
			v2StatusPassed: true,
		};
	}
	const registryBytes = read(registryPath);
	const registry = parseJson(registryBytes, registryPath);
	if (
		!isRecord(registry) ||
		registry.protocolMajor !== protocolMajor ||
		!Number.isSafeInteger(registry.registryVersion)
	) {
		fail(`${registryPath} is malformed`);
	}
	return {
		alternateCodeowners: alternateCodeownersPaths.filter((path) => read(path) !== undefined),
		bootstrapConsumed: policy !== undefined,
		codeowners: codeownersBytes?.toString("utf8"),
		files,
		locks: original === undefined && regenerated === undefined ? undefined : { original, regenerated },
		policy,
		preV3: false,
		protocolMajor: registry.protocolMajor,
		registryPath,
		registryVersion: registry.registryVersion,
		testLifecycle: readTestLifecycle(read),
		v2StatusPassed: true,
		workflow: workflowBytes?.toString("utf8"),
	};
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
		...completePolicyPaths,
		...(Array.isArray(basePolicy?.protectedPaths) ? basePolicy.protectedPaths : []),
		...(Array.isArray(currentPolicy?.protectedPaths) ? currentPolicy.protectedPaths : []),
	];
	const base = makeSnapshot((path) => readRevisionFile(mergeBase, path), basePaths, governingPaths);
	const current = makeSnapshot(readWorkingFile, currentPaths, governingPaths);
	evaluateProtocolV3Freeze({ base, current });
	process.stdout.write(`protocol-v3 freeze policy passed (${mergeBase.slice(0, 12)}..working-tree)\n`);
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
