import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface HashBinding {
	path: string;
	sha256: string;
}

interface FreezePolicy {
	checker: HashBinding;
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
	preV3?: boolean;
	protocolMajor?: number;
	registryPath?: string;
	registryVersion?: number;
	testLifecycle: LifecycleSources;
	v2StatusPassed: boolean;
	workflow?: string;
}

interface Contract {
	historicalCodeownersSource: string;
	unchangedV2ProtectedInputs: Record<string, string>;
}

type FreezeEvaluator = (input: { base: FreezeSnapshot; current: FreezeSnapshot }) => void;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const checkerPath = "packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs";
const originalLockPath = "packages/protocol-v3/conformance/reference.lock.json";
const regeneratedLockPath = "packages/protocol-v3/conformance/reference-regen.lock.json";
const policyPath = "packages/protocol-v3/conformance/freeze-policy-v3.json";
const workflowPath = ".github/workflows/protocol-v3-registry.yml";
const codeownersPath = "CODEOWNERS";
const registryPath = "packages/protocol-v3/registry/registry-v1.json";
const requiredGovernanceProtections = [workflowPath, codeownersPath] as const;
const evidencePaths = [
	"tests/protocol-v3-freeze-governance-n1prime-e.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e2.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e3.test.ts",
	"tests/protocol-v3-freeze-governance-n1prime-e4.test.ts",
	"tests/fixtures/phase-n1prime-e/freeze-governance-contract.json",
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json",
] as const;
const lifecycleContract = readJson<LifecycleContract>(
	"tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json"
);

function read(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

function readJson<T>(path: string): T {
	return JSON.parse(read(path)) as T;
}

function sha256(value: string): string {
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

function coherentBootstrapBase(contract: Contract): FreezeSnapshot {
	return {
		alternateCodeowners: [],
		bootstrapConsumed: false,
		codeowners: contract.historicalCodeownersSource,
		files: {
			...contract.unchangedV2ProtectedInputs,
			[codeownersPath]: sha256(contract.historicalCodeownersSource),
		},
		preV3: true,
		testLifecycle: lifecycleSources(true),
		v2StatusPassed: true,
	};
}

function coherentClosure(policy: FreezePolicy): FreezeSnapshot {
	const workflow = read(workflowPath);
	const codeowners = read(codeownersPath);
	const evidenceFiles = Object.fromEntries(evidencePaths.map((path) => [path, sha256(read(path))]));
	return {
		alternateCodeowners: [],
		bootstrapConsumed: true,
		codeowners,
		files: {
			...policy.immutableInputs,
			[originalLockPath]: sha256(read(originalLockPath)),
			[regeneratedLockPath]: sha256(read(regeneratedLockPath)),
			[policyPath]: sha256(read(policyPath)),
			[checkerPath]: sha256(read(checkerPath)),
			[workflowPath]: sha256(workflow),
			[codeownersPath]: sha256(codeowners),
			...evidenceFiles,
		},
		locks: {
			original: readJson<unknown>(originalLockPath),
			regenerated: readJson<unknown>(regeneratedLockPath),
		},
		policy,
		preV3: false,
		protocolMajor: 3,
		registryPath,
		registryVersion: 1,
		testLifecycle: lifecycleSources(false),
		v2StatusPassed: true,
		workflow,
	};
}

function withoutProtection(snapshot: FreezeSnapshot, path: string): FreezeSnapshot {
	const weakened = clone(snapshot);
	if (weakened.policy === undefined) throw new Error("coherent closure policy is absent");
	weakened.policy.protectedPaths = weakened.policy.protectedPaths.filter((candidate) => candidate !== path);
	weakened.files[policyPath] = sha256(JSON.stringify(weakened.policy));
	return weakened;
}

function withNeutralByteDrift(snapshot: FreezeSnapshot, path: string): FreezeSnapshot {
	const changed = clone(snapshot);
	if (path === workflowPath) {
		changed.workflow = `# semantic-neutral post-freeze workflow byte drift\n${changed.workflow ?? ""}`;
		changed.files[workflowPath] = sha256(changed.workflow);
		return changed;
	}
	changed.codeowners = changed.codeowners.replace(
		"# Protocol-v3 consensus bytes",
		"# semantic-neutral post-freeze CODEOWNERS byte drift\n# Protocol-v3 consensus bytes"
	);
	changed.files[codeownersPath] = sha256(changed.codeowners);
	return changed;
}

function requireCompletePolicy(evaluate: FreezeEvaluator): FreezeEvaluator {
	return (input): void => {
		for (const [label, snapshot] of [
			["base", input.base],
			["current", input.current],
		] as const) {
			if (snapshot.policy === undefined) continue;
			for (const path of requiredGovernanceProtections) {
				if (!snapshot.policy.protectedPaths.includes(path)) {
					throw new Error(`${label} policy omitted protected path ${path}`);
				}
			}
		}
		evaluate(input);
	};
}

function acceptedProtectionEscapes(evaluate: FreezeEvaluator, base: FreezeSnapshot, closure: FreezeSnapshot): string[] {
	const accepted: string[] = [];
	for (const path of requiredGovernanceProtections) {
		const weakened = withoutProtection(closure, path);
		try {
			evaluate({ base, current: weakened });
			accepted.push(`${path}: bootstrap omission accepted`);
		} catch {
			// Expected: an incomplete bootstrap policy is not a valid freeze.
		}
		const changed = withNeutralByteDrift(weakened, path);
		try {
			evaluate({ base: weakened, current: changed });
			accepted.push(`${path}: subsequent byte drift accepted`);
		} catch {
			// Expected: even a semantic-neutral byte change is frozen after closure.
		}
	}
	return accepted;
}

async function liveEvaluator(): Promise<FreezeEvaluator> {
	const moduleUrl = pathToFileURL(join(repositoryRoot, checkerPath)).href;
	const checker = (await import(`${moduleUrl}?phase-n1prime-e2-red`)) as {
		evaluateProtocolV3Freeze?: unknown;
	};
	expect(checker.evaluateProtocolV3Freeze).toBeTypeOf("function");
	return checker.evaluateProtocolV3Freeze as FreezeEvaluator;
}

describe("Phase -1'e2 complete workflow and CODEOWNERS policy membership", () => {
	it("keeps the coherent controls satisfiable while closing both bootstrap omissions and persistence paths", () => {
		const evaluate = requireCompletePolicy(() => undefined);
		const policy = readJson<FreezePolicy>(policyPath);
		const contract = readJson<Contract>("tests/fixtures/phase-n1prime-e/freeze-governance-contract.json");
		const base = coherentBootstrapBase(contract);
		const closure = coherentClosure(policy);
		expect(() => evaluate({ base, current: closure })).not.toThrow();
		expect(() => evaluate({ base: closure, current: clone(closure) })).not.toThrow();
		expect(acceptedProtectionEscapes(evaluate, base, closure)).toEqual([]);
	});

	it("requires the live checker itself to reject both weakened bootstrap policies and their later byte drift", async () => {
		const evaluate = await liveEvaluator();
		const policy = readJson<FreezePolicy>(policyPath);
		const contract = readJson<Contract>("tests/fixtures/phase-n1prime-e/freeze-governance-contract.json");
		const base = coherentBootstrapBase(contract);
		const closure = coherentClosure(policy);
		expect(() => evaluate({ base, current: closure })).not.toThrow();
		expect(
			acceptedProtectionEscapes(evaluate, base, closure),
			"the base-pinned policy must make workflow and CODEOWNERS immutable after the only bootstrap"
		).toEqual([]);
	});
});
