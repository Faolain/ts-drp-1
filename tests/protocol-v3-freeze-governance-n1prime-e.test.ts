import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ClosureContract {
	schemaVersion: string;
	closure: {
		protocolMajor: number;
		registryVersion: number;
		registryPath: string;
		requiredSlices: string[];
		externalPrerequisite: string;
	};
	immutableSuccessorInputs: Record<string, string>;
	unchangedV2ProtectedInputs: Record<string, string>;
	referenceBindings: Record<string, HashBinding>;
	mutableGreenTargets: Record<
		string,
		{ historicalSha256?: string; path: string; preGreenState: "absent" | "terminal-v2-only" }
	>;
	historicalCodeownersSource: string;
	ownerCohort: string[];
	v3CodeownersPatterns: string[];
	terminalV2CodeownersBlock: string[];
}

interface HashBinding {
	path: string;
	sha256: string;
}

interface ReferenceLock {
	algorithm: "sha256";
	files: Record<string, string>;
	provenanceBindings: Record<string, HashBinding>;
	referenceRole: "original" | "regenerated";
	schemaVersion: string;
	treeRoot: string;
}

interface LifecycleContract {
	rootConfig: {
		historicalRedExclusion: string;
		infrastructureExclusions: string[];
		path: string;
	};
	workspace: {
		path: string;
	};
	ordinaryCi: {
		path: string;
	};
}

interface LifecycleSources {
	rootConfig: string;
	workspace: string;
	ordinaryCi: string;
}

interface FreezePolicy {
	checker: HashBinding;
	checkpoint: {
		authoritative: boolean;
		externalPrerequisite: string;
		partialClaimsAllowed: boolean;
		requiredSlices: string[];
	};
	immutableInputs: Record<string, string>;
	locks: {
		original: string;
		regenerated: string;
	};
	protectedPaths: string[];
	protocolMajor: number;
	registryPath: string;
	registryVersion: number;
	schemaVersion: string;
	version: number;
}

interface FreezeSnapshot {
	alternateCodeowners: string[];
	bootstrapConsumed: boolean;
	codeowners: string;
	files: Record<string, string>;
	locks?: {
		original?: ReferenceLock;
		regenerated?: ReferenceLock;
	};
	policy?: FreezePolicy;
	preV3?: boolean;
	protocolMajor?: number;
	registryPath?: string;
	registryVersion?: number;
	testLifecycle: LifecycleSources;
	v2StatusPassed: boolean;
	workflow?: string;
}

type FreezeEvaluator = (input: { base: FreezeSnapshot; current: FreezeSnapshot }) => void;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(
	new URL("./fixtures/phase-n1prime-e/freeze-governance-contract.json", import.meta.url)
);
const contract = readJson<ClosureContract>(fixturePath);
const lifecycleContract = readJson<LifecycleContract>(
	fileURLToPath(new URL("./fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json", import.meta.url))
);
const originalLockPath = contract.mutableGreenTargets.originalLock?.path as string;
const regeneratedLockPath = contract.mutableGreenTargets.regeneratedLock?.path as string;
const policyPath = contract.mutableGreenTargets.policy?.path as string;
const checkerPath = contract.mutableGreenTargets.checker?.path as string;
const workflowPath = contract.mutableGreenTargets.workflow?.path as string;
const codeownersPath = contract.mutableGreenTargets.codeowners?.path as string;
const originalRoot = "packages/protocol-v3/conformance/original-reference";
const regeneratedRoot = "packages/protocol-v3/conformance/regenerated-reference";
const alternateCodeownersPaths = [".github/CODEOWNERS", "docs/CODEOWNERS"] as const;
const evidencePaths = [
	"tests/protocol-v3-freeze-governance-n1prime-e.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e2.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e3.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e4.test.ts",
	"tests/fixtures/phase-n1prime-e/freeze-governance-contract.json",
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json",
] as const;
const requiredPolicyPaths = [
	...Object.keys(contract.immutableSuccessorInputs),
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	...alternateCodeownersPaths,
	workflowPath,
	codeownersPath,
	...evidencePaths,
];
const bootstrapV3Paths = [
	...Object.keys(contract.immutableSuccessorInputs),
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	workflowPath,
];
const syntheticCheckerHash = "c".repeat(64);
const syntheticPolicyHash = "d".repeat(64);
const syntheticOriginalLockHash = "e".repeat(64);
const syntheticRegeneratedLockHash = "f".repeat(64);

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(path: string): string {
	return sha256(readFileSync(join(repositoryRoot, path)));
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
	const matches = object.properties.filter(
		(candidate): candidate is ts.PropertyAssignment =>
			ts.isPropertyAssignment(candidate) &&
			((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
				(ts.isStringLiteral(candidate.name) && candidate.name.text === name))
	);
	if (matches.length !== 1) throw new Error(`expected exactly one static ${name} property`);
	return matches[0];
}

function defaultCallArgument(source: string, path: string, callee: string): ts.Expression {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const exports = file.statements.filter(
		(statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals
	);
	if (exports.length !== 1) throw new Error(`${path} must have one default export`);
	const expression = exports[0].expression;
	if (
		!ts.isCallExpression(expression) ||
		!ts.isIdentifier(expression.expression) ||
		expression.expression.text !== callee ||
		expression.arguments.length !== 1
	) {
		throw new Error(`${path} must directly export ${callee}(...)`);
	}
	return expression.arguments[0];
}

function literalStrings(expression: ts.Expression, label: string): string[] {
	if (!ts.isArrayLiteralExpression(expression)) throw new Error(`${label} must be a literal array`);
	return expression.elements.map((element) => {
		if (!ts.isStringLiteral(element)) {
			throw new Error(`${label} must contain only static string literals`);
		}
		return element.text;
	});
}

function rootExcludeInitializer(source: string): {
	file: ts.SourceFile;
	initializer: ts.Expression;
} {
	const config = defaultCallArgument(source, lifecycleContract.rootConfig.path, "defineConfig");
	if (!ts.isObjectLiteralExpression(config)) throw new Error("root Vitest config must be a literal object");
	const test = property(config, "test").initializer;
	if (!ts.isObjectLiteralExpression(test)) throw new Error("root test config must be a literal object");
	return {
		file: config.getSourceFile(),
		initializer: property(test, "exclude").initializer,
	};
}

function lifecycleRootConfig(expectHistorical: boolean): string {
	const source = readFileSync(join(repositoryRoot, lifecycleContract.rootConfig.path), "utf8");
	const historical = lifecycleContract.rootConfig.infrastructureExclusions;
	const complete = [...historical, lifecycleContract.rootConfig.historicalRedExclusion];
	const desired = expectHistorical ? historical : complete;
	const { file, initializer } = rootExcludeInitializer(source);
	const actual = literalStrings(initializer, "root test.exclude");
	const current = [historical, complete].find((candidate) => JSON.stringify(candidate) === JSON.stringify(actual));
	if (current === undefined)
		throw new Error("root test.exclude is not the exact six- or seven-entry lifecycle literal");
	if (JSON.stringify(actual) === JSON.stringify(desired)) return source;
	const desiredLiteral = `[${desired.map((value) => JSON.stringify(value)).join(", ")}]`;
	const replaced = source.slice(0, initializer.getStart(file)) + desiredLiteral + source.slice(initializer.getEnd());
	if (
		JSON.stringify(literalStrings(rootExcludeInitializer(replaced).initializer, "root test.exclude")) !==
		JSON.stringify(desired)
	) {
		throw new Error("root test.exclude did not re-parse to the requested lifecycle literal");
	}
	return replaced;
}

function lifecycleSources(expectHistorical: boolean): LifecycleSources {
	return {
		rootConfig: lifecycleRootConfig(expectHistorical),
		workspace: readFileSync(join(repositoryRoot, lifecycleContract.workspace.path), "utf8"),
		ordinaryCi: readFileSync(join(repositoryRoot, lifecycleContract.ordinaryCi.path), "utf8"),
	};
}

function fail(message: string): never {
	throw new Error(`protocol-v3 freeze violation: ${message}`);
}

function exactRecord<T>(actual: Record<string, T>, expected: Record<string, T>, label: string): void {
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = Object.keys(expected).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) fail(`${label} key set differs`);
	for (const key of expectedKeys) {
		if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) fail(`${label} differs at ${key}`);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function codeownersEntries(source: string): string[] {
	return source
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function expectedV3CodeownersBlock(): string[] {
	const owners = contract.ownerCohort.join(" ");
	return contract.v3CodeownersPatterns.map((pattern) => `${pattern} ${owners}`);
}

function validateCodeowners(snapshot: FreezeSnapshot): void {
	if (snapshot.alternateCodeowners.length !== 0) fail("higher-precedence CODEOWNERS file appeared");
	const entries = codeownersEntries(snapshot.codeowners);
	const expectedSuffix = [...expectedV3CodeownersBlock(), ...contract.terminalV2CodeownersBlock];
	const suffix = entries.slice(-expectedSuffix.length);
	if (JSON.stringify(suffix) !== JSON.stringify(expectedSuffix)) {
		fail("v3 ownership must immediately precede the exact terminal v2 block");
	}
	for (const line of expectedV3CodeownersBlock()) {
		if (entries.filter((entry) => entry === line).length !== 1)
			fail(`v3 CODEOWNERS rule is missing or duplicated: ${line}`);
	}
	if (snapshot.files[codeownersPath] !== sha256(snapshot.codeowners)) fail("CODEOWNERS snapshot hash is stale");
}

function validateWorkflow(snapshot: FreezeSnapshot): void {
	const workflow = snapshot.workflow;
	if (workflow === undefined) fail("protocol-v3 workflow is absent");
	if (snapshot.files[workflowPath] !== sha256(workflow)) fail("workflow snapshot hash is stale");
	if (/\bpull_request_target\b/u.test(workflow)) fail("workflow uses pull_request_target");
	if (
		!/^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, edited, ready_for_review\]$/mu.test(workflow)
	) {
		fail("workflow must be unconditional, PR-blocking and retarget-sensitive");
	}
	if (/^\s+(?:paths|paths-ignore|branches|branches-ignore|if|continue-on-error):/mu.test(workflow)) {
		fail("workflow contains a conditional or nonblocking selector");
	}
	if (!/^permissions:\n {2}contents: read$/mu.test(workflow) || /^\s+[A-Za-z-]+:\s+write\s*$/mu.test(workflow)) {
		fail("workflow permissions are not read-only");
	}
	for (const line of [
		"          fetch-depth: 0",
		"          ref: ${{ github.sha }}",
		"          BASE_SHA: ${{ github.event.pull_request.base.sha }}",
		"          V2_CHECKER: packages/protocol-v2/scripts/check-protocol-freeze.mjs",
		`          V3_CHECKER: ${checkerPath}`,
		`          V3_POLICY: ${policyPath}`,
	]) {
		if (workflow.split(/\r?\n/u).filter((candidate) => candidate === line).length !== 1) {
			fail(`workflow structural line is missing or duplicated: ${line}`);
		}
	}
	const v2Run = 'node "$RUNNER_TEMP/check-protocol-v2-freeze.mjs" "$BASE_SHA"';
	const baseBranch = 'if git cat-file -e "$BASE_SHA:$V3_CHECKER"; then';
	const baseShow = 'git show "$BASE_SHA:$V3_CHECKER" > "$RUNNER_TEMP/check-protocol-v3-freeze.mjs"';
	const baseRun = 'node "$RUNNER_TEMP/check-protocol-v3-freeze.mjs" "$BASE_SHA"';
	const bootstrapRun = `node ${checkerPath} "$BASE_SHA"`;
	const orderedMarkers = [v2Run, baseBranch, baseShow, baseRun, bootstrapRun];
	let previousIndex = -1;
	for (const marker of orderedMarkers) {
		const index = workflow.indexOf(marker);
		if (index <= previousIndex || workflow.indexOf(marker, index + 1) !== -1) {
			fail("workflow must execute unchanged v2, then the merge-base v3 checker, before a one-time head bootstrap");
		}
		previousIndex = index;
	}
	for (const bootstrapGuard of [
		'! git cat-file -e "$BASE_SHA:$V3_POLICY"',
		'! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_LOCK"',
		'! git cat-file -e "$BASE_SHA:$V3_REGENERATED_LOCK"',
		'! git cat-file -e "$BASE_SHA:$V3_REGISTRY"',
		'! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_REFERENCE"',
		'! git cat-file -e "$BASE_SHA:$V3_REGENERATED_REFERENCE"',
		'! git cat-file -e "$BASE_SHA:$V3_VECTORS"',
	]) {
		if (!workflow.includes(bootstrapGuard)) fail(`workflow bootstrap is not fail-closed: ${bootstrapGuard}`);
	}
}

function expectedTreeFiles(role: "original" | "regenerated"): Record<string, string> {
	const prefix = role === "original" ? `${originalRoot}/` : `${regeneratedRoot}/`;
	return Object.fromEntries(
		Object.entries(contract.immutableSuccessorInputs)
			.filter(([path]) => path.startsWith(prefix))
			.map(([path, digest]) => [path.slice(prefix.length), digest])
	);
}

function validateReferenceLock(lock: ReferenceLock | undefined, role: "original" | "regenerated"): void {
	if (lock === undefined) fail(`${role} reference lock is absent`);
	if (lock.schemaVersion !== "protocol-v3-reference-lock-v1" || lock.algorithm !== "sha256") {
		fail(`${role} reference lock format is invalid`);
	}
	if (lock.referenceRole !== role || lock.treeRoot !== (role === "original" ? originalRoot : regeneratedRoot)) {
		fail(`${role} reference lock targets the wrong tree`);
	}
	exactRecord(lock.files, expectedTreeFiles(role), `${role} reference lock files`);
	exactRecord(lock.provenanceBindings, contract.referenceBindings, `${role} reference provenance bindings`);
}

function validatePolicy(policy: FreezePolicy | undefined, snapshot: FreezeSnapshot): void {
	if (policy === undefined) fail("freeze policy is absent");
	if (policy.schemaVersion !== "protocol-v3-freeze-policy-v1" || policy.version !== 1) {
		fail("freeze policy format is invalid");
	}
	if (
		policy.protocolMajor !== contract.closure.protocolMajor ||
		policy.registryVersion !== contract.closure.registryVersion ||
		policy.registryPath !== contract.closure.registryPath
	) {
		fail("freeze policy targets the wrong protocol registry");
	}
	if (policy.checker.path !== checkerPath || policy.checker.sha256 !== snapshot.files[checkerPath]) {
		fail("freeze policy does not pin the checked checker bytes");
	}
	if (policy.locks.original !== originalLockPath || policy.locks.regenerated !== regeneratedLockPath) {
		fail("freeze policy does not bind both reference locks");
	}
	exactRecord(policy.immutableInputs, contract.immutableSuccessorInputs, "policy immutable inputs");
	if (JSON.stringify(policy.protectedPaths) !== JSON.stringify(requiredPolicyPaths)) {
		fail("freeze policy protected paths differ from the exact declared order");
	}
	const checkpoint = policy.checkpoint;
	if (
		checkpoint.authoritative !== true ||
		checkpoint.partialClaimsAllowed !== false ||
		JSON.stringify(checkpoint.requiredSlices) !== JSON.stringify(contract.closure.requiredSlices) ||
		checkpoint.externalPrerequisite !== contract.closure.externalPrerequisite
	) {
		fail("policy makes a partial or dishonest atomic checkpoint claim");
	}
}

function validateTuple(snapshot: FreezeSnapshot): void {
	if (
		snapshot.protocolMajor !== contract.closure.protocolMajor ||
		snapshot.registryVersion !== contract.closure.registryVersion ||
		snapshot.registryPath !== contract.closure.registryPath
	) {
		fail("snapshot is not protocolMajor 3 / registryVersion 1 / registry-v1.json");
	}
	for (const [path, digest] of Object.entries(contract.immutableSuccessorInputs)) {
		if (snapshot.files[path] !== digest) fail(`accepted successor input drifted: ${path}`);
	}
}

function validateCompleteClosure(snapshot: FreezeSnapshot): void {
	validateTuple(snapshot);
	if (!snapshot.v2StatusPassed) fail("protocol-v3 status cannot pass while unchanged protocol-v2 status fails");
	for (const target of [originalLockPath, regeneratedLockPath, policyPath, checkerPath, workflowPath, codeownersPath]) {
		if (snapshot.files[target] === undefined) fail(`complete closure target is absent: ${target}`);
	}
	validatePolicy(snapshot.policy, snapshot);
	validateReferenceLock(snapshot.locks?.original, "original");
	validateReferenceLock(snapshot.locks?.regenerated, "regenerated");
	validateCodeowners(snapshot);
	validateWorkflow(snapshot);
	const originalTree = Object.keys(snapshot.files)
		.filter((path) => path.startsWith(`${originalRoot}/`))
		.map((path) => relative(originalRoot, path))
		.sort();
	const regeneratedTree = Object.keys(snapshot.files)
		.filter((path) => path.startsWith(`${regeneratedRoot}/`))
		.map((path) => relative(regeneratedRoot, path))
		.sort();
	if (JSON.stringify(originalTree) !== JSON.stringify(Object.keys(expectedTreeFiles("original")).sort())) {
		fail("original reference tree is incomplete or contains an extra file");
	}
	if (JSON.stringify(regeneratedTree) !== JSON.stringify(Object.keys(expectedTreeFiles("regenerated")).sort())) {
		fail("regenerated reference tree is incomplete or contains an extra file");
	}
	for (const lock of [snapshot.locks?.original, snapshot.locks?.regenerated]) {
		for (const binding of Object.values(lock?.provenanceBindings ?? {})) {
			if (snapshot.files[binding.path] !== binding.sha256) fail(`provenance binding is stale: ${binding.path}`);
		}
	}
}

function validateBootstrapBase(snapshot: FreezeSnapshot): void {
	if (
		snapshot.preV3 !== true ||
		snapshot.protocolMajor !== undefined ||
		snapshot.registryVersion !== undefined ||
		snapshot.registryPath !== undefined
	) {
		fail("bootstrap base must be the exact pre-v3 state");
	}
	if (snapshot.bootstrapConsumed) fail("protocol-v3 freeze bootstrap is single-use");
	if (snapshot.policy !== undefined || snapshot.locks !== undefined || snapshot.workflow !== undefined) {
		fail("bootstrap base already contains v3 governance");
	}
	for (const path of bootstrapV3Paths) {
		if (snapshot.files[path] !== undefined) fail(`bootstrap base already contains v3 path ${path}`);
	}
	for (const [path, digest] of Object.entries(contract.unchangedV2ProtectedInputs)) {
		if (snapshot.files[path] !== digest) fail(`bootstrap base changed frozen v2 input ${path}`);
	}
	if (!snapshot.v2StatusPassed) fail("bootstrap requires unchanged protocol-v2 governance");
	if (snapshot.alternateCodeowners.length !== 0) fail("bootstrap base has higher-precedence CODEOWNERS");
	const historicalDigest = contract.mutableGreenTargets.codeowners?.historicalSha256;
	if (
		historicalDigest === undefined ||
		sha256(snapshot.codeowners) !== historicalDigest ||
		snapshot.files[codeownersPath] !== historicalDigest
	) {
		fail("bootstrap base is not the exact historical CODEOWNERS state");
	}
	const entries = codeownersEntries(snapshot.codeowners);
	if (
		JSON.stringify(entries.slice(-contract.terminalV2CodeownersBlock.length)) !==
		JSON.stringify(contract.terminalV2CodeownersBlock)
	) {
		fail("bootstrap base does not retain the exact terminal v2 CODEOWNERS block");
	}
	if (contract.v3CodeownersPatterns.some((pattern) => entries.some((entry) => entry.startsWith(`${pattern} `)))) {
		fail("bootstrap base already contains the v3 CODEOWNERS block");
	}
}

function evaluateClosureOracle({ base, current }: { base: FreezeSnapshot; current: FreezeSnapshot }): void {
	if (base.policy === undefined) {
		validateBootstrapBase(base);
		validateCompleteClosure(current);
		if (!current.bootstrapConsumed) fail("completed bootstrap must close itself permanently");
		return;
	}
	validateCompleteClosure(base);
	validateCompleteClosure(current);
	if (!base.bootstrapConsumed || !current.bootstrapConsumed) fail("post-freeze state cannot reopen bootstrap");
	if (JSON.stringify(current.policy) !== JSON.stringify(base.policy)) fail("base freeze policy changed");
	for (const path of base.policy.protectedPaths) {
		if (base.files[path] !== current.files[path]) fail(`base-protected artifact changed: ${path}`);
	}
	if (
		current.policy.checker.path !== base.policy.checker.path ||
		current.policy.checker.sha256 !== base.policy.checker.sha256
	) {
		fail("checker and pin cannot be replaced in the same proposal");
	}
}

function originalReferenceLock(): ReferenceLock {
	return {
		algorithm: "sha256",
		files: expectedTreeFiles("original"),
		provenanceBindings: clone(contract.referenceBindings),
		referenceRole: "original",
		schemaVersion: "protocol-v3-reference-lock-v1",
		treeRoot: originalRoot,
	};
}

function regeneratedReferenceLock(): ReferenceLock {
	return {
		algorithm: "sha256",
		files: expectedTreeFiles("regenerated"),
		provenanceBindings: clone(contract.referenceBindings),
		referenceRole: "regenerated",
		schemaVersion: "protocol-v3-reference-lock-v1",
		treeRoot: regeneratedRoot,
	};
}

function coherentPolicy(): FreezePolicy {
	return {
		checker: { path: checkerPath, sha256: syntheticCheckerHash },
		checkpoint: {
			authoritative: true,
			externalPrerequisite: contract.closure.externalPrerequisite,
			partialClaimsAllowed: false,
			requiredSlices: [...contract.closure.requiredSlices],
		},
		immutableInputs: clone(contract.immutableSuccessorInputs),
		locks: { original: originalLockPath, regenerated: regeneratedLockPath },
		protectedPaths: [...requiredPolicyPaths],
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		schemaVersion: "protocol-v3-freeze-policy-v1",
		version: 1,
	};
}

function insertV3CodeownersBlock(baseSource: string): string {
	const terminal = contract.terminalV2CodeownersBlock.join("\n");
	const index = baseSource.indexOf(terminal);
	if (index < 0 || baseSource.indexOf(terminal, index + 1) !== -1)
		fail("historical CODEOWNERS terminal block is ambiguous");
	const block = [
		"# Protocol-v3 consensus bytes and their additive freeze controls share the frozen v2 owner cohort.",
		...expectedV3CodeownersBlock(),
		"",
	].join("\n");
	return `${baseSource.slice(0, index)}${block}${baseSource.slice(index)}`;
}

function coherentWorkflow(): string {
	return `name: Protocol v3 atomic freeze change control

on:
  pull_request:
    types: [opened, synchronize, reopened, edited, ready_for_review]

permissions:
  contents: read

jobs:
  protocol-v3-freeze:
    name: Require protocol-v3 atomic freeze
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run unchanged v2 and merge-base-pinned v3 freeze checkers
        env:
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
          V2_CHECKER: packages/protocol-v2/scripts/check-protocol-freeze.mjs
          V3_CHECKER: ${checkerPath}
          V3_POLICY: ${policyPath}
          V3_ORIGINAL_LOCK: ${originalLockPath}
          V3_REGENERATED_LOCK: ${regeneratedLockPath}
          V3_REGISTRY: ${contract.closure.registryPath}
          V3_ORIGINAL_REFERENCE: ${originalRoot}/reference.mjs
          V3_REGENERATED_REFERENCE: ${regeneratedRoot}/reference.mjs
          V3_VECTORS: packages/protocol-v3/conformance/vectors/registry-v1.json
        run: |
          git show "$BASE_SHA:$V2_CHECKER" > "$RUNNER_TEMP/check-protocol-v2-freeze.mjs"
          PROTOCOL_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\
            node "$RUNNER_TEMP/check-protocol-v2-freeze.mjs" "$BASE_SHA"
          if git cat-file -e "$BASE_SHA:$V3_CHECKER"; then
            git show "$BASE_SHA:$V3_CHECKER" > "$RUNNER_TEMP/check-protocol-v3-freeze.mjs"
            PROTOCOL_V3_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \\
              node "$RUNNER_TEMP/check-protocol-v3-freeze.mjs" "$BASE_SHA"
          elif ! git cat-file -e "$BASE_SHA:$V3_POLICY" \\
            && ! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_LOCK" \\
            && ! git cat-file -e "$BASE_SHA:$V3_REGENERATED_LOCK" \\
            && ! git cat-file -e "$BASE_SHA:$V3_REGISTRY" \\
            && ! git cat-file -e "$BASE_SHA:$V3_ORIGINAL_REFERENCE" \\
            && ! git cat-file -e "$BASE_SHA:$V3_REGENERATED_REFERENCE" \\
            && ! git cat-file -e "$BASE_SHA:$V3_VECTORS"; then
            node ${checkerPath} "$BASE_SHA"
          else
            echo "Protocol-v3 freeze bootstrap is fail-closed and single-use." >&2
            exit 1
          fi
`;
}

function coherentBase(): FreezeSnapshot {
	const codeowners = contract.historicalCodeownersSource;
	const historicalDigest = contract.mutableGreenTargets.codeowners?.historicalSha256;
	if (historicalDigest === undefined || sha256(codeowners) !== historicalDigest) {
		fail("historical pre-GREEN CODEOWNERS provenance is stale");
	}
	return {
		alternateCodeowners: [],
		bootstrapConsumed: false,
		codeowners,
		files: { ...contract.unchangedV2ProtectedInputs, [codeownersPath]: sha256(codeowners) },
		preV3: true,
		testLifecycle: lifecycleSources(true),
		v2StatusPassed: true,
	};
}

function coherentClosure(): FreezeSnapshot {
	const base = coherentBase();
	const codeowners = insertV3CodeownersBlock(base.codeowners);
	const workflow = coherentWorkflow();
	const evidenceFiles = Object.fromEntries(evidencePaths.map((path) => [path, hashFile(path)]));
	return {
		alternateCodeowners: [],
		bootstrapConsumed: true,
		codeowners,
		files: {
			...contract.immutableSuccessorInputs,
			[originalLockPath]: syntheticOriginalLockHash,
			[regeneratedLockPath]: syntheticRegeneratedLockHash,
			[policyPath]: syntheticPolicyHash,
			[checkerPath]: syntheticCheckerHash,
			[workflowPath]: sha256(workflow),
			[codeownersPath]: sha256(codeowners),
			...evidenceFiles,
		},
		locks: { original: originalReferenceLock(), regenerated: regeneratedReferenceLock() },
		policy: coherentPolicy(),
		preV3: false,
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		testLifecycle: lifecycleSources(false),
		v2StatusPassed: true,
		workflow,
	};
}

function expectMutationRejected(
	evaluate: FreezeEvaluator,
	base: FreezeSnapshot,
	current: FreezeSnapshot,
	label: string
): void {
	expect(() => evaluate({ base, current }), label).toThrow();
}

function exerciseMutationMatrix(evaluate: FreezeEvaluator): number {
	const bootstrapBase = coherentBase();
	const closure = coherentClosure();
	expect(() => evaluate({ base: bootstrapBase, current: closure }), "coherent first bootstrap").not.toThrow();
	expect(() => evaluate({ base: closure, current: clone(closure) }), "coherent closed successor").not.toThrow();
	const mutations: [string, (value: FreezeSnapshot) => void][] = [];
	for (const path of [
		contract.closure.registryPath,
		"packages/protocol-v3/registry/registry-v1.schema.json",
		"docs/protocol/attested-hard-epochs-v5.md",
		"docs/protocol/amendments-v3.json",
		"packages/protocol-v3/formal/author-lineage-actions.qnt",
		"packages/protocol-v3/formal/signed-field-derivation.json",
		"packages/protocol-v3/formal/registry-signed-envelope-variables.qnt",
		"packages/protocol-v3/formal/registry-model-signoff.json",
		"docs/protocol/canonical-tag-codec-v1.md",
		"docs/protocol/canonical-tag-codec-v1.json",
		"packages/protocol-v3/conformance/vectors/registry-v1.json",
		`${originalRoot}/reference.mjs`,
		`${originalRoot}/provenance.json`,
		`${regeneratedRoot}/reference.mjs`,
		`${regeneratedRoot}/provenance.json`,
	]) {
		mutations.push([`immutable byte drift: ${path}`, (value): void => void (value.files[path] = "0".repeat(64))]);
	}
	mutations.push(
		["incomplete original tree", (value): void => void delete value.files[`${originalRoot}/provenance.json`]],
		["incomplete regenerated tree", (value): void => void delete value.files[`${regeneratedRoot}/reference.mjs`]],
		["missing original lock", (value): void => void delete value.locks?.original],
		["missing regenerated lock", (value): void => void delete value.locks?.regenerated],
		["incomplete lock file set", (value): void => void delete (value.locks?.original?.files ?? {})["provenance.json"]],
		[
			"reference tree file-set mismatch",
			(value): void => void (value.files[`${regeneratedRoot}/unreviewed.mjs`] = "1".repeat(64)),
		],
		["extra lock file", (value): void => void ((value.locks?.regenerated?.files ?? {})["README.md"] = "1".repeat(64))],
		[
			"lock source hash mismatch",
			(value): void => void ((value.locks?.original?.files ?? {})["reference.mjs"] = "2".repeat(64)),
		],
		[
			"missing provenance binding",
			(value): void => void delete (value.locks?.original?.provenanceBindings ?? {}).vectors,
		],
		[
			"stale provenance binding",
			(value): void =>
				void (((value.locks?.regenerated?.provenanceBindings ?? {}).registry as HashBinding).sha256 = "3".repeat(64)),
		],
		[
			"extra provenance binding",
			(value): void =>
				void ((value.locks?.original?.provenanceBindings ?? {}).unreviewed = {
					path: "unreviewed",
					sha256: "4".repeat(64),
				}),
		],
		["wrong protocol major", (value): void => void (value.protocolMajor = 4)],
		["post-freeze registry bump", (value): void => void (value.registryVersion = 2)],
		[
			"wrong registry path",
			(value): void => void (value.registryPath = "packages/protocol-v3/registry/registry-v2.json"),
		],
		["policy removal", (value): void => void delete value.policy],
		[
			"policy weakening",
			(value): void =>
				void value.policy?.protectedPaths.splice(value.policy.protectedPaths.indexOf(contract.closure.registryPath), 1),
		],
		[
			"protected path order permutation",
			(value): void => {
				if (value.policy !== undefined) {
					[value.policy.protectedPaths[0], value.policy.protectedPaths[1]] = [
						value.policy.protectedPaths[1] as string,
						value.policy.protectedPaths[0] as string,
					];
				}
			},
		],
		[
			"self-grading checker and pin replacement",
			(value): void => {
				value.files[checkerPath] = "5".repeat(64);
				if (value.policy !== undefined) value.policy.checker.sha256 = "5".repeat(64);
			},
		],
		[
			"conditional workflow",
			(value): void => {
				value.workflow = value.workflow?.replace(
					"    runs-on: ubuntu-latest",
					"    if: github.actor != 'bot'\\n    runs-on: ubuntu-latest"
				);
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		[
			"nonblocking workflow",
			(value): void => {
				value.workflow = value.workflow?.replace(
					"    runs-on: ubuntu-latest",
					"    continue-on-error: true\\n    runs-on: ubuntu-latest"
				);
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		[
			"write-capable workflow",
			(value): void => {
				value.workflow = value.workflow?.replace("  contents: read", "  contents: write");
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		[
			"retarget-insensitive workflow",
			(value): void => {
				value.workflow = value.workflow?.replace(", edited", "");
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		[
			"workflow path filter",
			(value): void => {
				value.workflow = value.workflow?.replace(
					"    types: [opened, synchronize, reopened, edited, ready_for_review]",
					"    types: [opened, synchronize, reopened, edited, ready_for_review]\\n    paths: ['packages/protocol-v3/**']"
				);
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		[
			"head checker executes before base checker",
			(value): void => {
				value.workflow = value.workflow?.replace(
					'git show "$BASE_SHA:$V3_CHECKER" > "$RUNNER_TEMP/check-protocol-v3-freeze.mjs"',
					`cp ${checkerPath} "$RUNNER_TEMP/check-protocol-v3-freeze.mjs"`
				);
				if (value.workflow !== undefined) value.files[workflowPath] = sha256(value.workflow);
			},
		],
		["v3 status masks failed v2 status", (value): void => void (value.v2StatusPassed = false)],
		[
			"higher-precedence .github CODEOWNERS",
			(value): void => void value.alternateCodeowners.push(".github/CODEOWNERS"),
		],
		["higher-precedence docs CODEOWNERS", (value): void => void value.alternateCodeowners.push("docs/CODEOWNERS")],
		[
			"wrong owner cohort",
			(value): void => {
				value.codeowners = value.codeowners.replace(
					`${contract.v3CodeownersPatterns[0]} ${contract.ownerCohort.join(" ")}`,
					`${contract.v3CodeownersPatterns[0]} @different-owner`
				);
				value.files[codeownersPath] = sha256(value.codeowners);
			},
		],
		[
			"v3 rules appended after terminal v2 block",
			(value): void => {
				const block = expectedV3CodeownersBlock().join("\n");
				value.codeowners = value.codeowners.replace(`${block}\n`, "").trimEnd() + `\n${block}\n`;
				value.files[codeownersPath] = sha256(value.codeowners);
			},
		],
		[
			"terminal v2 block mutation",
			(value): void => {
				value.codeowners = value.codeowners.replace(
					contract.terminalV2CodeownersBlock[1] as string,
					"/packages/protocol-v2/registry/** @different-owner"
				);
				value.files[codeownersPath] = sha256(value.codeowners);
			},
		],
		["partial checkpoint claim", (value): void => void value.policy?.checkpoint.requiredSlices.pop()],
		[
			"partial claims permitted",
			(value): void => {
				if (value.policy !== undefined) value.policy.checkpoint.partialClaimsAllowed = true;
			},
		]
	);
	for (const [label, mutate] of mutations) {
		const changed = clone(closure);
		mutate(changed);
		expectMutationRejected(evaluate, closure, changed, label);
	}
	const permutedBootstrapClosure = clone(closure);
	const permutedBootstrapPolicy = permutedBootstrapClosure.policy;
	if (permutedBootstrapPolicy === undefined) fail("coherent closure policy is absent");
	[permutedBootstrapPolicy.protectedPaths[0], permutedBootstrapPolicy.protectedPaths[1]] = [
		permutedBootstrapPolicy.protectedPaths[1] as string,
		permutedBootstrapPolicy.protectedPaths[0] as string,
	];
	expectMutationRejected(
		evaluate,
		coherentBase(),
		permutedBootstrapClosure,
		"first bootstrap with protected path order permutation"
	);
	const consumedBase = coherentBase();
	consumedBase.bootstrapConsumed = true;
	expectMutationRejected(evaluate, consumedBase, closure, "second bootstrap attempt");
	const partiallyGovernedBase = coherentBase();
	partiallyGovernedBase.files[originalLockPath] = syntheticOriginalLockHash;
	expectMutationRejected(
		evaluate,
		partiallyGovernedBase,
		closure,
		"bootstrap after a partial prior governance landing"
	);
	const contentPrelandedBase = coherentBase();
	Object.assign(contentPrelandedBase.files, contract.immutableSuccessorInputs);
	expectMutationRejected(evaluate, contentPrelandedBase, closure, "bootstrap after content was prelanded");
	return mutations.length + 2;
}

function assertPinnedInputs(): number {
	for (const [path, digest] of Object.entries(contract.immutableSuccessorInputs)) {
		expect(existsSync(join(repositoryRoot, path)), `accepted successor input absent: ${path}`).toBe(true);
		expect(hashFile(path), `accepted successor input drift: ${path}`).toBe(digest);
	}
	for (const [path, digest] of Object.entries(contract.unchangedV2ProtectedInputs)) {
		expect(existsSync(join(repositoryRoot, path)), `frozen v2 input absent: ${path}`).toBe(true);
		expect(hashFile(path), `frozen v2 input drift: ${path}`).toBe(digest);
	}
	for (const [name, target] of Object.entries(contract.mutableGreenTargets)) {
		expect(Object.hasOwn(target, "sha256"), `${name} must not pin a mutable GREEN target`).toBe(false);
	}
	return (
		Object.keys(contract.immutableSuccessorInputs).length + Object.keys(contract.unchangedV2ProtectedInputs).length
	);
}

function copyIntoScratch(sourcePath: string, scratchRoot: string): void {
	const source = join(repositoryRoot, sourcePath);
	const target = join(scratchRoot, sourcePath);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: statSync(source).isDirectory() });
}

function executeUnchangedV2Checker(): void {
	const scratchRoot = mkdtempSync(join(tmpdir(), "phase-n1prime-e-v2-"));
	try {
		for (const path of [
			"packages/protocol-v2",
			"docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt",
			".github/workflows/protocol-v2-registry.yml",
			"CODEOWNERS",
		]) {
			copyIntoScratch(path, scratchRoot);
		}
		execFileSync("git", ["init", "--quiet"], { cwd: scratchRoot });
		execFileSync("git", ["config", "user.email", "phase-n1prime-e@example.invalid"], { cwd: scratchRoot });
		execFileSync("git", ["config", "user.name", "Phase n1prime e RED"], { cwd: scratchRoot });
		execFileSync("git", ["add", "."], { cwd: scratchRoot });
		execFileSync("git", ["commit", "--quiet", "-m", "scratch v2 freeze base"], { cwd: scratchRoot });
		execFileSync(process.execPath, ["packages/protocol-v2/scripts/check-protocol-freeze.mjs", "HEAD"], {
			cwd: scratchRoot,
			env: { ...process.env, PROTOCOL_FREEZE_REPOSITORY_ROOT: scratchRoot },
			stdio: "pipe",
		});
	} finally {
		rmSync(scratchRoot, { force: true, recursive: true });
	}
}

function absentLiveClosureTargets(): string[] {
	const absent = Object.values(contract.mutableGreenTargets)
		.filter((target) => target.path !== codeownersPath)
		.map((target) => target.path)
		.filter((path) => !existsSync(join(repositoryRoot, path)));
	const codeowners = readFileSync(join(repositoryRoot, codeownersPath), "utf8");
	if (!expectedV3CodeownersBlock().every((line) => codeownersEntries(codeowners).includes(line))) {
		absent.push("CODEOWNERS:v3-block");
	}
	return absent;
}

function liveSnapshot(): FreezeSnapshot {
	const policy = readJson<FreezePolicy>(join(repositoryRoot, policyPath));
	const original = readJson<ReferenceLock>(join(repositoryRoot, originalLockPath));
	const regenerated = readJson<ReferenceLock>(join(repositoryRoot, regeneratedLockPath));
	const codeowners = readFileSync(join(repositoryRoot, codeownersPath), "utf8");
	const workflow = readFileSync(join(repositoryRoot, workflowPath), "utf8");
	const targetFiles = Object.fromEntries(
		Object.values(contract.mutableGreenTargets).map((target) => [target.path, hashFile(target.path)])
	);
	const evidenceFiles = Object.fromEntries(evidencePaths.map((path) => [path, hashFile(path)]));
	return {
		alternateCodeowners: alternateCodeownersPaths.filter((path) => existsSync(join(repositoryRoot, path))),
		bootstrapConsumed: true,
		codeowners,
		files: { ...contract.immutableSuccessorInputs, ...targetFiles, ...evidenceFiles },
		locks: { original, regenerated },
		policy,
		preV3: false,
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		testLifecycle: lifecycleSources(false),
		v2StatusPassed: true,
		workflow,
	};
}

describe("Phase -1'e protocol-v3 additive freeze governance", () => {
	it("accepts a coherent closure, rejects every causal mutation, and executes unchanged v2 governance", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-e-freeze-governance-red-v1");
		const preservationCount = assertPinnedInputs();
		expect(preservationCount).toBe(60);
		expect(exerciseMutationMatrix(evaluateClosureOracle)).toBe(49);
		executeUnchangedV2Checker();
	}, 30_000);

	it("closes the live v3 tuple with base-pinned, single-use governance rather than passing on absence", async () => {
		const absent = absentLiveClosureTargets();
		expect(absent, `missing mutable GREEN closure targets: ${absent.join(", ")}`).toEqual([]);
		const moduleUrl = pathToFileURL(join(repositoryRoot, checkerPath)).href;
		const checker = (await import(`${moduleUrl}?phase-n1prime-e-red`)) as {
			evaluateProtocolV3Freeze?: unknown;
		};
		expect(checker.evaluateProtocolV3Freeze, "v3 checker must export evaluateProtocolV3Freeze").toBeTypeOf("function");
		const evaluate = checker.evaluateProtocolV3Freeze as FreezeEvaluator;
		const current = liveSnapshot();
		const base = coherentBase();
		expect(() => evaluate({ base, current }), "live one-time bootstrap").not.toThrow();
		expect(() => evaluate({ base: current, current: clone(current) }), "live closed successor").not.toThrow();
		expect(exerciseMutationMatrix(evaluate)).toBe(49);
	});
});
