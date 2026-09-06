import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface HashBinding {
	path: string;
	sha256: string;
}

interface LifecycleContract {
	schemaVersion: string;
	rootConfig: {
		path: string;
		infrastructureExclusions: string[];
		historicalRedExclusion: string;
		forbiddenBroadeningMutants: string[];
	};
	workspace: {
		path: string;
		projects: string[];
	};
	ordinaryCi: {
		path: string;
		command: string;
	};
	historicalArtifacts: HashBinding[];
	acceptedSuccessorTests: string[];
	governance: {
		checkerPath: string;
		policyPath: string;
		requiredSlice: string;
		evidencePaths: string[];
	};
}

interface FreezePolicy {
	checker: HashBinding;
	checkpoint: {
		requiredSlices: string[];
	};
	immutableInputs: Record<string, string>;
	protectedPaths: string[];
}

interface LifecycleSources {
	rootConfig: string;
	workspace: string;
	ordinaryCi: string;
}

type FreezeSnapshot = Record<string, unknown> & {
	files: Record<string, string>;
	policy: FreezePolicy;
	testLifecycle: LifecycleSources;
};

type FreezeEvaluator = (input: { base: FreezeSnapshot; current: FreezeSnapshot }) => void;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = "tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json";
const contract = readJson<LifecycleContract>(fixturePath);
const currentExclusions = contract.rootConfig.infrastructureExclusions;
const futureExclusions = [...currentExclusions, contract.rootConfig.historicalRedExclusion];

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
	const config = defaultCallArgument(source, contract.rootConfig.path, "defineConfig");
	if (!ts.isObjectLiteralExpression(config)) throw new Error("root Vitest config must be a literal object");
	const test = property(config, "test").initializer;
	if (!ts.isObjectLiteralExpression(test)) throw new Error("root test config must be a literal object");
	return {
		file: config.getSourceFile(),
		initializer: property(test, "exclude").initializer,
	};
}

function rootExclusions(source: string): string[] {
	return literalStrings(rootExcludeInitializer(source).initializer, "root test.exclude");
}

function replaceRootExcludeInitializer(source: string, replacement: string): string {
	const { file, initializer } = rootExcludeInitializer(source);
	const replaced = source.slice(0, initializer.getStart(file)) + replacement + source.slice(initializer.getEnd());
	rootExcludeInitializer(replaced);
	return replaced;
}

function historicalSixRootConfig(source: string): string {
	const actual = rootExclusions(source);
	if (JSON.stringify(actual) === JSON.stringify(currentExclusions)) return source;
	if (JSON.stringify(actual) !== JSON.stringify(futureExclusions)) {
		throw new Error(`cannot construct historical root config from exclusions ${JSON.stringify(actual)}`);
	}

	const { file, initializer } = rootExcludeInitializer(source);
	if (!ts.isArrayLiteralExpression(initializer)) {
		throw new Error("root test.exclude must be a literal array");
	}
	const historical = initializer.elements.filter(
		(element): element is ts.StringLiteral =>
			ts.isStringLiteral(element) && element.text === contract.rootConfig.historicalRedExclusion
	);
	if (historical.length !== 1) {
		throw new Error("future root test.exclude must contain exactly one historical exclusion");
	}
	const target = historical[0];
	const targetIndex = initializer.elements.indexOf(target);
	if (targetIndex === 0) {
		throw new Error("historical exclusion must follow the infrastructure exclusions");
	}
	const previousEnd = initializer.elements[targetIndex - 1].getEnd();
	const separator = source.slice(previousEnd, target.getStart(file));
	const commaOffset = separator.lastIndexOf(",");
	if (commaOffset === -1) throw new Error("historical exclusion must have an adjacent comma");

	const removalStart = previousEnd + commaOffset;
	const historicalSource = source.slice(0, removalStart) + source.slice(target.getEnd());
	if (JSON.stringify(rootExclusions(historicalSource)) !== JSON.stringify(currentExclusions)) {
		throw new Error("historical root config did not re-parse to the exact six exclusions");
	}
	return historicalSource;
}

function workspaceProjects(source: string): string[] {
	return literalStrings(
		defaultCallArgument(source, contract.workspace.path, "defineWorkspace"),
		"root Vitest workspace projects"
	);
}

function literalRunCommands(workflow: string): string[] {
	const lines = workflow.split(/\r?\n/u);
	const commands: string[] = [];
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

function assertLifecycleSources(sources: LifecycleSources, expectedExclusions = futureExclusions): void {
	expect(rootExclusions(sources.rootConfig)).toEqual(expectedExclusions);
	expect(workspaceProjects(sources.workspace)).toEqual(contract.workspace.projects);
	expect(literalRunCommands(sources.ordinaryCi).filter((command) => command === contract.ordinaryCi.command)).toEqual([
		contract.ordinaryCi.command,
	]);
}

function futureRootConfig(source: string): string {
	const actual = rootExclusions(source);
	if (JSON.stringify(actual) === JSON.stringify(futureExclusions)) return source;
	if (JSON.stringify(actual) !== JSON.stringify(currentExclusions)) {
		throw new Error(`cannot construct future root config from exclusions ${JSON.stringify(actual)}`);
	}
	const oldLiteral = `exclude: [${currentExclusions.map((value) => JSON.stringify(value)).join(", ")}]`;
	const newLiteral = `exclude: [${futureExclusions.map((value) => JSON.stringify(value)).join(", ")}]`;
	if (!source.includes(oldLiteral)) throw new Error("root exclusion list is not the expected static literal");
	return source.replace(oldLiteral, newLiteral);
}

function lifecycleMutants(valid: LifecycleSources): Array<[string, LifecycleSources]> {
	const replaceExclusion = (replacement: string): string =>
		valid.rootConfig.replace(JSON.stringify(contract.rootConfig.historicalRedExclusion), JSON.stringify(replacement));
	const additional = valid.rootConfig.replace(
		JSON.stringify(contract.rootConfig.historicalRedExclusion),
		`${JSON.stringify(contract.rootConfig.historicalRedExclusion)}, ${JSON.stringify(
			"tests/protocol-v3-registry-spec-n1prime-b.test.ts"
		)}`
	);
	const dynamic = replaceRootExcludeInitializer(valid.rootConfig, `[...${JSON.stringify(futureExclusions)}]`);
	return [
		["future exclusion omitted", { ...valid, rootConfig: historicalSixRootConfig(valid.rootConfig) }],
		[
			"neighboring c2 test excluded",
			{
				...valid,
				rootConfig: replaceExclusion("tests/protocol-v3-independent-reference-vectors-n1prime-c2.test.ts"),
			},
		],
		...contract.rootConfig.forbiddenBroadeningMutants.map((replacement): [string, LifecycleSources] => [
			`broadened exclusion ${replacement}`,
			{ ...valid, rootConfig: replaceExclusion(replacement) },
		]),
		["additional test excluded", { ...valid, rootConfig: additional }],
		["dynamic exclusion construction", { ...valid, rootConfig: dynamic }],
		[
			"alternate root workspace routing",
			{
				...valid,
				workspace: valid.workspace.replace('"./vite.config.mts"', '"./vite.alternate.config.mts"'),
			},
		],
		[
			"ordinary CI no longer runs pnpm test",
			{ ...valid, ordinaryCi: valid.ordinaryCi.replace("pnpm test", "pnpm exec vitest run tests/unit") },
		],
	];
}

function assertGovernanceSurface(policy: FreezePolicy, checkerSource: string): void {
	for (const artifact of contract.historicalArtifacts) {
		expect(policy.immutableInputs[artifact.path]).toBe(artifact.sha256);
		expect(policy.protectedPaths.filter((path) => path === artifact.path)).toHaveLength(1);
		expect(checkerSource).toContain(artifact.path);
		expect(checkerSource).toContain(artifact.sha256);
	}
	expect(policy.checkpoint.requiredSlices.filter((slice) => slice === contract.governance.requiredSlice)).toHaveLength(
		1
	);
	expect(checkerSource).toContain(contract.governance.requiredSlice);
	for (const evidencePath of contract.governance.evidencePaths) {
		expect(policy.protectedPaths.filter((path) => path === evidencePath)).toHaveLength(1);
		expect(checkerSource).toContain(evidencePath);
	}
}

function syntheticFutureGovernance(): { checker: string; policy: FreezePolicy } {
	const immutableInputs = Object.fromEntries(
		contract.historicalArtifacts.map((artifact) => [artifact.path, artifact.sha256])
	);
	const protectedPaths = [
		...contract.historicalArtifacts.map((artifact) => artifact.path),
		...contract.governance.evidencePaths,
	];
	return {
		checker: JSON.stringify({
			immutableInputs,
			protectedPaths,
			requiredSlices: [contract.governance.requiredSlice],
		}),
		policy: {
			checker: { path: contract.governance.checkerPath, sha256: "0".repeat(64) },
			checkpoint: { requiredSlices: [contract.governance.requiredSlice] },
			immutableInputs,
			protectedPaths,
		},
	};
}

function coherentClosure(sources: LifecycleSources): FreezeSnapshot {
	const policy = readJson<FreezePolicy>(contract.governance.policyPath);
	const paths = new Set([
		...Object.keys(policy.immutableInputs),
		...policy.protectedPaths,
		contract.governance.policyPath,
		contract.governance.checkerPath,
	]);
	const files = Object.fromEntries(
		[...paths]
			.filter((path) => existsSync(join(repositoryRoot, path)))
			.map((path) => [path, sha256(readFileSync(join(repositoryRoot, path)))])
	);
	return {
		alternateCodeowners: [],
		bootstrapConsumed: true,
		codeowners: read("CODEOWNERS"),
		files,
		locks: {
			original: readJson<unknown>("packages/protocol-v3/conformance/reference.lock.json"),
			regenerated: readJson<unknown>("packages/protocol-v3/conformance/reference-regen.lock.json"),
		},
		policy,
		protocolMajor: 3,
		registryPath: "packages/protocol-v3/registry/registry-v1.json",
		registryVersion: 1,
		testLifecycle: sources,
		v2StatusPassed: true,
		workflow: read(".github/workflows/protocol-v3-registry.yml"),
	};
}

async function liveEvaluator(): Promise<FreezeEvaluator> {
	const moduleUrl = pathToFileURL(join(repositoryRoot, contract.governance.checkerPath)).href;
	const checker = (await import(`${moduleUrl}?phase-n1prime-e4-red`)) as {
		evaluateProtocolV3Freeze?: unknown;
	};
	expect(checker.evaluateProtocolV3Freeze).toBeTypeOf("function");
	return checker.evaluateProtocolV3Freeze as FreezeEvaluator;
}

function discoveredTestFiles(): string[] {
	const output = execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--no-color"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	return output
		.split(/\r?\n/u)
		.map((line) => line.trim().replace(`${repositoryRoot}/`, ""))
		.filter((line) => line.length > 0);
}

describe("Phase -1'e4 pure root-collection controls", () => {
	it("proves the existing six exclusions, root workspace project, and ordinary CI command are satisfiable", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-e4-root-test-lifecycle-v1");
		assertLifecycleSources(
			{
				rootConfig: historicalSixRootConfig(read(contract.rootConfig.path)),
				workspace: read(contract.workspace.path),
				ordinaryCi: read(contract.ordinaryCi.path),
			},
			currentExclusions
		);
	});

	it("freezes the exact future lifecycle and governance boundary against every required mutant", () => {
		const validSources = {
			rootConfig: futureRootConfig(read(contract.rootConfig.path)),
			workspace: read(contract.workspace.path),
			ordinaryCi: read(contract.ordinaryCi.path),
		};
		assertLifecycleSources(validSources);
		const semanticallyUnrelatedEdit = {
			...validSources,
			rootConfig: validSources.rootConfig.replace(
				"plugins: [tsconfigPaths()]",
				"define: { __PHASE_N1PRIME_E4_CONTROL__: JSON.stringify(true) },\n\tplugins: [tsconfigPaths()]"
			),
		};
		assertLifecycleSources(semanticallyUnrelatedEdit);
		for (const [label, mutant] of lifecycleMutants(validSources)) {
			expect(() => assertLifecycleSources(mutant), label).toThrow();
		}

		const future = syntheticFutureGovernance();
		assertGovernanceSurface(future.policy, future.checker);
		for (const artifact of contract.historicalArtifacts) {
			const missing = clone(future);
			delete missing.policy.immutableInputs[artifact.path];
			expect(() => assertGovernanceSurface(missing.policy, missing.checker), `${artifact.path} omission`).toThrow();

			const drifted = clone(future);
			drifted.policy.immutableInputs[artifact.path] = "f".repeat(64);
			expect(() => assertGovernanceSurface(drifted.policy, drifted.checker), `${artifact.path} drift`).toThrow();
		}
		for (const path of [
			...contract.historicalArtifacts.map((artifact) => artifact.path),
			...contract.governance.evidencePaths,
		]) {
			const unprotected = clone(future);
			unprotected.policy.protectedPaths = unprotected.policy.protectedPaths.filter((candidate) => candidate !== path);
			expect(() => assertGovernanceSurface(unprotected.policy, unprotected.checker), `${path} unprotected`).toThrow();
		}
		const missingSlice = clone(future);
		missingSlice.policy.checkpoint.requiredSlices = [];
		expect(() => assertGovernanceSurface(missingSlice.policy, missingSlice.checker), "e4 slice omission").toThrow();
	});
});

describe("Phase -1'e4 live root-collection and governance RED", () => {
	it("exposes only historical-c collection and the bounded lifecycle-governance omissions", async () => {
		const violations: string[] = [];
		const liveSources = {
			rootConfig: read(contract.rootConfig.path),
			workspace: read(contract.workspace.path),
			ordinaryCi: read(contract.ordinaryCi.path),
		};
		try {
			assertLifecycleSources(liveSources);
		} catch {
			violations.push(`root test.exclude lacks exactly ${contract.rootConfig.historicalRedExclusion}`);
		}

		const discovered = discoveredTestFiles();
		const historicalCollected = discovered.filter((path) => path === contract.rootConfig.historicalRedExclusion);
		if (historicalCollected.length !== 0) {
			violations.push(
				`ordinary Vitest collection includes historical RED exactly ${historicalCollected.length} time(s)`
			);
		}
		const undiscoveredSuccessors = contract.acceptedSuccessorTests.filter((path) => !discovered.includes(path));
		if (undiscoveredSuccessors.length > 0) {
			violations.push(`accepted successor tests are not discoverable: ${undiscoveredSuccessors.join(", ")}`);
		}

		for (const artifact of contract.historicalArtifacts) {
			const actualHash = sha256(readFileSync(join(repositoryRoot, artifact.path)));
			if (actualHash !== artifact.sha256) {
				violations.push(`historical artifact drifted: ${artifact.path}`);
			}
		}
		const policy = readJson<FreezePolicy>(contract.governance.policyPath);
		const checkerSource = read(contract.governance.checkerPath);
		try {
			assertGovernanceSurface(policy, checkerSource);
		} catch {
			violations.push("policy/checker omit historical hashes, e4 slice, or protected e4 evidence");
		}

		const validFutureSources = {
			...liveSources,
			rootConfig: futureRootConfig(liveSources.rootConfig),
		};
		const evaluate = await liveEvaluator();
		const closure = coherentClosure(validFutureSources);
		expect(() => evaluate({ base: closure, current: clone(closure) })).not.toThrow();
		const acceptedMutants: string[] = [];
		for (const [label, mutantSources] of lifecycleMutants(validFutureSources)) {
			const mutant = clone(closure);
			mutant.testLifecycle = mutantSources;
			try {
				evaluate({ base: closure, current: mutant });
				acceptedMutants.push(label);
			} catch {
				// Expected after GREEN: the base-pinned checker rejects every lifecycle escape.
			}
		}
		if (acceptedMutants.length > 0) {
			violations.push(`live checker accepted lifecycle mutants: ${acceptedMutants.join(", ")}`);
		}
		const unrelated = clone(closure);
		unrelated.testLifecycle.rootConfig = unrelated.testLifecycle.rootConfig.replace(
			"plugins: [tsconfigPaths()]",
			"define: { __PHASE_N1PRIME_E4_CONTROL__: JSON.stringify(true) },\n\tplugins: [tsconfigPaths()]"
		);
		expect(() => evaluate({ base: closure, current: unrelated })).not.toThrow();

		expect(violations).toEqual([]);
	}, 15_000);
});
