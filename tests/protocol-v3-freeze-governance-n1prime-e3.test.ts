import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface HashBinding {
	path: string;
	sha256: string;
}

interface FreezePolicy {
	checker: HashBinding;
	checkpoint: {
		requiredSlices: string[];
	};
	immutableInputs: Record<string, string>;
	protectedPaths: string[];
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

interface FreezeSnapshot {
	alternateCodeowners: string[];
	bootstrapConsumed: boolean;
	codeowners: string;
	files: Record<string, string>;
	locks?: {
		original: unknown;
		regenerated: unknown;
	};
	policy?: FreezePolicy;
	protocolMajor: number;
	registryPath: string;
	registryVersion: number;
	testLifecycle: LifecycleSources;
	v2StatusPassed: boolean;
	workflow?: string;
	preV3?: true;
}

interface ClosureContract {
	closure: {
		protocolMajor: number;
		registryPath: string;
		registryVersion: number;
	};
	historicalCodeownersSource: string;
}

type FreezeEvaluator = (input: { base: FreezeSnapshot; current: FreezeSnapshot }) => void;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const checkerPath = "packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-v3.json";
const originalLockPath = "packages/protocol-v3/conformance/reference.lock.json";
const regeneratedLockPath = "packages/protocol-v3/conformance/reference-regen.lock.json";
const workflowPath = ".github/workflows/protocol-v3-registry.yml";
const codeownersPath = "CODEOWNERS";
const alternateCodeownersPaths = [".github/CODEOWNERS", "docs/CODEOWNERS"] as const;
const evidencePaths = [
	"tests/protocol-v3-freeze-governance-n1prime-e.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e2.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e3.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e4.test.ts",
	"tests/fixtures/phase-n1prime-e/freeze-governance-contract.json",
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json",
] as const;
const governancePaths = [
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	workflowPath,
	codeownersPath,
] as const;
const requiredRemediationSlices = ["phase-n1prime-e2", "phase-n1prime-e3"] as const;
const forbiddenOverFreeze = "packages/protocol-v2/**";
const contract = readJson<ClosureContract>("tests/fixtures/phase-n1prime-e/freeze-governance-contract.json");
const lifecycleContract = readJson<LifecycleContract>(
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json"
);
const lifecyclePaths = [
	lifecycleContract.rootConfig.path,
	lifecycleContract.workspace.path,
	lifecycleContract.ordinaryCi.path,
] as const;
const policy = readJson<FreezePolicy>(policyPath);
const immutablePaths = Object.keys(policy.immutableInputs);
const completeClosurePaths = [...new Set([...immutablePaths, ...governancePaths, ...evidencePaths])];
const allowedProtectedPaths = [
	...immutablePaths,
	originalLockPath,
	regeneratedLockPath,
	policyPath,
	checkerPath,
	...alternateCodeownersPaths,
	workflowPath,
	codeownersPath,
	...evidencePaths,
];
const partialBaseCases = [
	["registry only", "packages/protocol-v3/registry/registry-v1.json"],
	["original reference only", "packages/protocol-v3/conformance/original-reference/reference.mjs"],
	["regenerated reference only", "packages/protocol-v3/conformance/regenerated-reference/reference.mjs"],
	["vectors only", "packages/protocol-v3/conformance/vectors/registry-v1.json"],
	["one formal artifact", "packages/protocol-v3/formal/author-lineage-actions.qnt"],
	["one specification artifact", "docs/protocol/amendments-v3.json"],
	["one a-d test", "tests/protocol-v3-registry-spec-n1prime-b.test.ts"],
	["one a-d fixture", "tests/fixtures/phase-n1prime-b/registry-spec-contract.json"],
	["original lock only", originalLockPath],
	["regenerated lock only", regeneratedLockPath],
	["policy only", policyPath],
	["checker only", checkerPath],
	["workflow only", workflowPath],
	["v3 CODEOWNERS block only", codeownersPath],
] as const;

let scratchRoot = "";
let exactPreV3Base = "";
let branchSequence = 0;

function read(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

function readJson<T>(path: string): T {
	return JSON.parse(read(path)) as T;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
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
	const source = read(lifecycleContract.rootConfig.path);
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
		workspace: read(lifecycleContract.workspace.path),
		ordinaryCi: read(lifecycleContract.ordinaryCi.path),
	};
}

function git(args: string[], cwd = scratchRoot): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function copyCurrentPath(path: string): void {
	const source = join(repositoryRoot, path);
	const target = join(scratchRoot, path);
	rmSync(target, { force: true, recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: statSync(source).isDirectory() });
}

function copyCurrentPaths(paths: readonly string[]): void {
	for (const path of paths) copyCurrentPath(path);
}

function commit(paths: readonly string[], message: string): string {
	git(["add", "--", ...paths]);
	git(["commit", "-m", message]);
	return git(["rev-parse", "HEAD"]);
}

function restoreExactBase(): void {
	for (const path of completeClosurePaths) {
		rmSync(join(scratchRoot, path), { force: true, recursive: true });
	}
	git(["switch", "--discard-changes", "--detach", exactPreV3Base]);
}

function createCurrentFromBase(label: string, basePaths: readonly string[]): { base: string } {
	branchSequence += 1;
	restoreExactBase();
	git(["switch", "-c", `phase-e3-${branchSequence}`]);
	if (basePaths.length > 0) {
		copyCurrentPaths(basePaths);
		commit(basePaths, `${label} partial base`);
	}
	const base = git(["rev-parse", "HEAD"]);
	copyCurrentPaths(completeClosurePaths);
	copyCurrentPaths(lifecyclePaths);
	return { base };
}

function runChecker(base: string): { output: string; status: number } {
	const result = spawnSync("node", [checkerPath, base], {
		cwd: scratchRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PROTOCOL_V3_FREEZE_REPOSITORY_ROOT: scratchRoot,
		},
	});
	return {
		output: `${result.stdout}${result.stderr}`,
		status: result.status ?? 1,
	};
}

function workflowRunner(workflow: string): string {
	const lines = workflow.split(/\r?\n/u);
	const runIndex = lines.indexOf("        run: |");
	if (runIndex < 0) throw new Error("protocol-v3 workflow has no literal run block");
	const runner: string[] = [];
	for (const line of lines.slice(runIndex + 1)) {
		if (line.length > 0 && !line.startsWith("          ")) break;
		runner.push(line.replace(/^ {10}/u, ""));
	}
	return runner.join("\n");
}

function runWorkflow(base: string): { output: string; status: number } {
	const runnerTemp = join(scratchRoot, ".runner-temp");
	mkdirSync(runnerTemp, { recursive: true });
	const result = spawnSync("bash", ["-euo", "pipefail", "-c", workflowRunner(read(workflowPath))], {
		cwd: scratchRoot,
		encoding: "utf8",
		env: {
			...process.env,
			BASE_SHA: base,
			GITHUB_WORKSPACE: scratchRoot,
			RUNNER_TEMP: runnerTemp,
			V2_CHECKER: "packages/protocol-v2/scripts/check-protocol-freeze.mjs",
			V3_CHECKER: checkerPath,
			V3_ORIGINAL_LOCK: originalLockPath,
			V3_ORIGINAL_REFERENCE: "packages/protocol-v3/conformance/original-reference/reference.mjs",
			V3_POLICY: policyPath,
			V3_REGENERATED_LOCK: regeneratedLockPath,
			V3_REGENERATED_REFERENCE: "packages/protocol-v3/conformance/regenerated-reference/reference.mjs",
			V3_REGISTRY: contract.closure.registryPath,
			V3_VECTORS: "packages/protocol-v3/conformance/vectors/registry-v1.json",
		},
	});
	return {
		output: `${result.stdout}${result.stderr}`,
		status: result.status ?? 1,
	};
}

function snapshotFromWorkingTree(candidatePolicy = policy): FreezeSnapshot {
	const workflow = read(workflowPath);
	const codeowners = read(codeownersPath);
	const files = Object.fromEntries(
		[...new Set([...candidatePolicy.protectedPaths, ...governancePaths, ...evidencePaths])]
			.filter((path) => existsSync(join(repositoryRoot, path)))
			.map((path) => [path, sha256(readFileSync(join(repositoryRoot, path)))])
	);
	files[policyPath] = sha256(JSON.stringify(candidatePolicy));
	return {
		alternateCodeowners: [],
		bootstrapConsumed: true,
		codeowners,
		files,
		locks: {
			original: readJson<unknown>(originalLockPath),
			regenerated: readJson<unknown>(regeneratedLockPath),
		},
		policy: candidatePolicy,
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		testLifecycle: lifecycleSources(false),
		v2StatusPassed: true,
		workflow,
	};
}

function contentPrelandedBase(): FreezeSnapshot {
	return {
		alternateCodeowners: [],
		bootstrapConsumed: false,
		codeowners: contract.historicalCodeownersSource,
		files: {
			...policy.immutableInputs,
			[codeownersPath]: sha256(contract.historicalCodeownersSource),
		},
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		testLifecycle: lifecycleSources(false),
		v2StatusPassed: true,
	};
}

function exactPreV3Snapshot(): FreezeSnapshot {
	return {
		alternateCodeowners: [],
		bootstrapConsumed: false,
		codeowners: contract.historicalCodeownersSource,
		files: {
			[codeownersPath]: sha256(contract.historicalCodeownersSource),
		},
		preV3: true,
		protocolMajor: contract.closure.protocolMajor,
		registryPath: contract.closure.registryPath,
		registryVersion: contract.closure.registryVersion,
		testLifecycle: lifecycleSources(true),
		v2StatusPassed: true,
	};
}

function evaluateIntendedPreV3Bootstrap(
	evaluate: FreezeEvaluator,
	input: { base: FreezeSnapshot; current: FreezeSnapshot }
): void {
	if (input.base.preV3 !== true) throw new Error("bootstrap base is not explicitly preV3");
	if (
		input.base.bootstrapConsumed ||
		input.base.policy !== undefined ||
		input.base.locks !== undefined ||
		input.base.workflow !== undefined
	) {
		throw new Error("preV3 bootstrap base contains governance");
	}
	if (
		Object.keys(input.base.files).length !== 1 ||
		input.base.files[codeownersPath] !== sha256(contract.historicalCodeownersSource) ||
		input.base.codeowners !== contract.historicalCodeownersSource
	) {
		throw new Error("preV3 bootstrap base is not the exact frozen-v2 state");
	}
	if (input.current.policy === undefined) throw new Error("bootstrap closure policy is absent");
	for (const path of evidencePaths) {
		if (!input.current.policy.protectedPaths.includes(path)) {
			throw new Error(`bootstrap policy omitted governance evidence ${path}`);
		}
		if (input.current.files[path] === undefined) {
			throw new Error(`bootstrap closure omitted governance evidence ${path}`);
		}
	}
	evaluate({ base: input.base, current: input.current });
}

async function liveEvaluator(): Promise<FreezeEvaluator> {
	const moduleUrl = pathToFileURL(join(repositoryRoot, checkerPath)).href;
	const checker = (await import(`${moduleUrl}?phase-n1prime-e3-red`)) as {
		evaluateProtocolV3Freeze?: unknown;
	};
	expect(checker.evaluateProtocolV3Freeze).toBeTypeOf("function");
	return checker.evaluateProtocolV3Freeze as FreezeEvaluator;
}

beforeAll(() => {
	scratchRoot = mkdtempSync(join(tmpdir(), "phase-n1prime-e3-"));
	const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
		cwd: repositoryRoot,
		maxBuffer: 64 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", scratchRoot], { input: archive });
	git(["init", "-b", "exact-pre-v3"]);
	git(["config", "user.email", "phase-n1prime-e3@example.invalid"]);
	git(["config", "user.name", "Phase n1prime e3 RED"]);
	git(["add", "--", "."]);
	git(["commit", "-m", "exact frozen-v2 no-v3 base"]);
	exactPreV3Base = git(["rev-parse", "HEAD"]);
});

afterAll(() => {
	if (scratchRoot !== "") rmSync(scratchRoot, { force: true, recursive: true });
});

describe("Phase -1'e3 atomic first landing and bounded governance surface", () => {
	it.each(partialBaseCases)("rejects the partial-v3 base: %s", (label, path) => {
		const { base } = createCurrentFromBase(label, [path]);
		const result = runChecker(base);
		expect(result.status, `${label} was accepted\n${result.output}`).not.toBe(0);
	});

	it("retains unchanged post-freeze and evidence-drift controls", async () => {
		const evaluate = await liveEvaluator();
		const closure = snapshotFromWorkingTree();
		expect(() => evaluate({ base: closure, current: clone(closure) })).not.toThrow();

		const evidencePolicy = clone(policy);
		evidencePolicy.protectedPaths.push(
			...evidencePaths.filter((path) => !evidencePolicy.protectedPaths.includes(path))
		);
		const evidenceClosure = snapshotFromWorkingTree(evidencePolicy);
		const preV3 = exactPreV3Snapshot();
		expect(() =>
			evaluateIntendedPreV3Bootstrap(evaluate, {
				base: preV3,
				current: evidenceClosure,
			})
		).not.toThrow();
		for (const evidencePath of evidencePaths) {
			const bootstrapOmission = clone(evidenceClosure);
			delete bootstrapOmission.files[evidencePath];
			expect(
				() =>
					evaluateIntendedPreV3Bootstrap(evaluate, {
						base: preV3,
						current: bootstrapOmission,
					}),
				`intended preV3 bootstrap accepted missing evidence: ${evidencePath}`
			).toThrow();

			const changed = clone(evidenceClosure);
			delete changed.files[evidencePath];
			expect(
				() => evaluate({ base: evidenceClosure, current: changed }),
				`post-freeze evidence omission survived: ${evidencePath}`
			).toThrow();

			const drifted = clone(evidenceClosure);
			drifted.files[evidencePath] = "0".repeat(64);
			expect(
				() => evaluate({ base: evidenceClosure, current: drifted }),
				`post-freeze evidence drift survived: ${evidencePath}`
			).toThrow();
		}
		for (const evidencePath of evidencePaths) {
			expect(policy.immutableInputs).not.toHaveProperty(evidencePath);
		}
	});

	it("exposes only the live one-shot, content-prelanding, over-freeze, and evidence-closure gaps", async () => {
		const violations: string[] = [];

		const oneShot = createCurrentFromBase("one-shot a-e landing", []);
		const oneShotCli = runChecker(oneShot.base);
		if (oneShotCli.status !== 0) {
			violations.push(`one-shot CLI rejected: ${oneShotCli.output.trim()}`);
		}
		const oneShotWorkflow = runWorkflow(oneShot.base);
		if (oneShotWorkflow.status !== 0) {
			violations.push(`workflow did not reach a successful guarded head bootstrap: ${oneShotWorkflow.output.trim()}`);
		}

		const prelanded = createCurrentFromBase("content-prelanded", immutablePaths);
		const prelandedResult = runChecker(prelanded.base);
		if (prelandedResult.status === 0) {
			violations.push("content-prelanded base was accepted");
		}

		const missingEvidence = evidencePaths.filter((path) => !policy.protectedPaths.includes(path));
		if (missingEvidence.length > 0) {
			violations.push(`governance evidence is not protected: ${missingEvidence.join(", ")}`);
		}
		const missingSlices = requiredRemediationSlices.filter(
			(slice) => !policy.checkpoint.requiredSlices.includes(slice)
		);
		if (missingSlices.length > 0) {
			violations.push(`remediation slices are absent from the checkpoint: ${missingSlices.join(", ")}`);
		}

		const unexpectedProtected = policy.protectedPaths.filter((path) => !allowedProtectedPaths.includes(path));
		const omittedProtected = allowedProtectedPaths.filter((path) => !policy.protectedPaths.includes(path));
		if (unexpectedProtected.length > 0 || omittedProtected.length > 0) {
			violations.push(
				`protectedPaths differs from the declared surface; unexpected=${unexpectedProtected.join(",")} omitted=${omittedProtected.join(",")}`
			);
		}

		const evaluate = await liveEvaluator();
		const evidencePolicy = clone(policy);
		evidencePolicy.protectedPaths.push(
			...evidencePaths.filter((path) => !evidencePolicy.protectedPaths.includes(path))
		);
		const evidenceClosure = snapshotFromWorkingTree(evidencePolicy);
		const preV3 = exactPreV3Snapshot();
		try {
			evaluate({ base: preV3, current: evidenceClosure });
		} catch (error) {
			violations.push(`direct preV3 bootstrap rejected: ${error instanceof Error ? error.message : String(error)}`);
		}
		const acceptedPreV3EvidenceOmissions: string[] = [];
		for (const evidencePath of evidencePaths) {
			const missingEvidenceClosure = clone(evidenceClosure);
			delete missingEvidenceClosure.files[evidencePath];
			try {
				evaluate({ base: preV3, current: missingEvidenceClosure });
				acceptedPreV3EvidenceOmissions.push(evidencePath);
			} catch {
				// Expected: direct preV3 bootstrap must reject each evidence omission.
			}
		}
		if (acceptedPreV3EvidenceOmissions.length > 0) {
			violations.push(`direct preV3 bootstrap accepted missing evidence: ${acceptedPreV3EvidenceOmissions.join(", ")}`);
		}

		const acceptedEvidenceOmissions: string[] = [];
		for (const evidencePath of evidencePaths) {
			const missingEvidenceClosure = clone(evidenceClosure);
			delete missingEvidenceClosure.files[evidencePath];
			try {
				evaluate({
					base: contentPrelandedBase(),
					current: missingEvidenceClosure,
				});
				acceptedEvidenceOmissions.push(evidencePath);
			} catch {
				// Expected after GREEN: listed bootstrap evidence must be present before closure.
			}
		}
		if (acceptedEvidenceOmissions.length > 0) {
			violations.push(`bootstrap accepted missing protected evidence: ${acceptedEvidenceOmissions.join(", ")}`);
		}

		const overFreezePolicy = clone(policy);
		overFreezePolicy.protectedPaths.push(forbiddenOverFreeze);
		const overFrozen = snapshotFromWorkingTree(overFreezePolicy);
		try {
			evaluate({ base: overFrozen, current: clone(overFrozen) });
			violations.push(`${forbiddenOverFreeze} was accepted as an irreversible protected path`);
		} catch {
			// Expected: the protected surface must be exact, not merely a required subset.
		}

		expect(violations).toEqual([]);
	}, 30_000);
});
