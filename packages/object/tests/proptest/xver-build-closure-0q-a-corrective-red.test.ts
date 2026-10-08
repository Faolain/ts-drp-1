import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const runnerPath = resolve(repositoryRoot, "scripts/phase-0m-xver-gate.mjs");
const workflowPath = resolve(repositoryRoot, ".github/workflows/phase-0m-xver.yml");
// The acceptance child loads object dynamically and imports blueprints/test-utils
// directly. Package manifests close these roots over their production dependencies.
const XVER_RUNTIME_ROOTS = ["packages/object", "packages/blueprints", "packages/test-utils"] as const;

interface WorkspacePackage {
	readonly dependencies: readonly string[];
	readonly directory: string;
	readonly name: string;
}

interface BuildEntry {
	readonly directory: string;
	readonly referenceOptional?: boolean;
}

function runnerStringConstant(sourceFile: ts.SourceFile, name: string): string | undefined {
	let value: string | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name &&
			node.initializer &&
			ts.isStringLiteral(node.initializer)
		) {
			value = node.initializer.text;
			return;
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return value;
}

function runnerBuildEntries(source: string): BuildEntry[] {
	const sourceFile = ts.createSourceFile(runnerPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	let declaration: ts.VariableDeclaration | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "BUILD_PACKAGES") {
			declaration = node;
			return;
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);

	const initializer = declaration?.initializer;
	expect(initializer && ts.isArrayLiteralExpression(initializer), "BUILD_PACKAGES must be an array literal").toBe(true);
	if (!initializer || !ts.isArrayLiteralExpression(initializer)) return [];

	return initializer.elements.flatMap((element) => {
		if (!ts.isObjectLiteralExpression(element)) return [];
		const directoryProperty = element.properties.find(
			(candidate): candidate is ts.PropertyAssignment =>
				ts.isPropertyAssignment(candidate) &&
				(ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
				candidate.name.text === "directory"
		);
		if (!directoryProperty || !ts.isStringLiteral(directoryProperty.initializer)) return [];
		const optionalProperty = element.properties.find(
			(candidate): candidate is ts.PropertyAssignment =>
				ts.isPropertyAssignment(candidate) &&
				(ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
				candidate.name.text === "referenceOptional"
		);
		return [
			{
				directory: directoryProperty.initializer.text,
				referenceOptional:
					optionalProperty?.initializer.kind === ts.SyntaxKind.TrueKeyword
						? true
						: optionalProperty?.initializer.kind === ts.SyntaxKind.FalseKeyword
							? false
							: undefined,
			},
		];
	});
}

function workspacePackages(): Map<string, WorkspacePackage> {
	const packagesRoot = resolve(repositoryRoot, "packages");
	const packages = new Map<string, WorkspacePackage>();
	for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = `packages/${entry.name}`;
		const manifestPath = join(packagesRoot, entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			dependencies?: Record<string, string>;
			name?: string;
		};
		if (!manifest.name) continue;
		packages.set(manifest.name, {
			dependencies: Object.keys(manifest.dependencies ?? {}),
			directory,
			name: manifest.name,
		});
	}
	return packages;
}

function runtimeClosure(
	roots: readonly string[],
	byName: ReadonlyMap<string, WorkspacePackage>
): Map<string, WorkspacePackage> {
	const byDirectory = new Map(
		[...byName.values()].map((workspacePackage) => [workspacePackage.directory, workspacePackage])
	);
	const closure = new Map<string, WorkspacePackage>();
	const pending = [...roots];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory || closure.has(directory)) continue;
		const workspacePackage = byDirectory.get(directory);
		expect(workspacePackage, `BUILD_PACKAGES references unknown workspace package ${directory}`).toBeDefined();
		if (!workspacePackage) continue;
		closure.set(directory, workspacePackage);
		for (const dependency of workspacePackage.dependencies) {
			const localDependency = byName.get(dependency);
			if (localDependency) pending.push(localDependency.directory);
		}
	}
	return closure;
}

function buildOrderViolations(
	buildDirectories: readonly string[],
	closure: ReadonlyMap<string, WorkspacePackage>,
	byName: ReadonlyMap<string, WorkspacePackage>
): string[] {
	const index = new Map(buildDirectories.map((directory, position) => [directory, position]));
	const violations: string[] = [];
	for (const workspacePackage of closure.values()) {
		const packageIndex = index.get(workspacePackage.directory);
		if (packageIndex === undefined) {
			violations.push(`missing ${workspacePackage.directory}`);
			continue;
		}
		for (const dependency of workspacePackage.dependencies) {
			const localDependency = byName.get(dependency);
			if (!localDependency) continue;
			const dependencyIndex = index.get(localDependency.directory);
			if (dependencyIndex !== undefined && dependencyIndex >= packageIndex) {
				violations.push(`${localDependency.directory} must precede ${workspacePackage.directory}`);
			}
		}
	}
	return violations.sort();
}

function revisionClosureViolations(
	entries: readonly BuildEntry[],
	currentPresent: ReadonlySet<string>,
	referencePresent: ReadonlySet<string>
): string[] {
	const violations: string[] = [];
	for (const entry of entries) {
		if (!currentPresent.has(entry.directory)) {
			violations.push(`primary missing ${entry.directory}`);
			continue;
		}
		if (!referencePresent.has(entry.directory) && entry.referenceOptional !== true) {
			violations.push(`reference missing ${entry.directory} is not declared reference-optional`);
		}
		if (referencePresent.has(entry.directory) && entry.referenceOptional === true) {
			violations.push(`reference-optional ${entry.directory} still exists at the pinned revision`);
		}
	}
	return violations.sort();
}

function resolveExtendedConfig(configPath: string, extended: string): string {
	if (!extended.startsWith(".") && !extended.startsWith("/")) {
		throw new Error(`Unsupported non-relative tsconfig extends ${extended} from ${configPath}`);
	}
	const base = resolve(dirname(configPath), extended);
	const candidates = extname(base) === "" ? [`${base}.json`, join(base, "tsconfig.json")] : [base];
	const resolved = candidates.find((candidate) => existsSync(candidate));
	if (!resolved) throw new Error(`Cannot resolve tsconfig extends ${extended} from ${configPath}`);
	return resolved;
}

function trackedConfigExtendsChain(initialConfigs: readonly string[]): string[] {
	const tracked = new Set<string>();
	const visited = new Set<string>();
	const pending = [...initialConfigs];
	while (pending.length > 0) {
		const configPath = pending.pop();
		if (!configPath || visited.has(configPath)) continue;
		visited.add(configPath);
		const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
		if (parsed.error) {
			throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
		}
		const repositoryPath = relative(repositoryRoot, configPath);
		if (
			spawnSync("git", ["ls-files", "--error-unmatch", "--", repositoryPath], {
				cwd: repositoryRoot,
			}).status === 0
		) {
			tracked.add(repositoryPath);
		}
		const extended = (parsed.config as { extends?: string | string[] }).extends;
		for (const parent of typeof extended === "string" ? [extended] : (extended ?? [])) {
			pending.push(resolveExtendedConfig(configPath, parent));
		}
	}
	return [...tracked].sort();
}

function missingExternalConfigTriggers(
	configPaths: readonly string[],
	coveredPackageDirectories: ReadonlySet<string>,
	triggerPaths: ReadonlySet<string>
): string[] {
	return configPaths
		.filter(
			(configPath) =>
				![...coveredPackageDirectories].some((directory) => configPath.startsWith(`${directory}/`)) &&
				!triggerPaths.has(configPath)
		)
		.sort();
}

describe("Phase 0q-a corrective XVER build-closure RED", () => {
	it("builds every in-repo runtime dependency before each selected consumer", () => {
		const byName = workspacePackages();
		const buildDirectories = runnerBuildEntries(readFileSync(runnerPath, "utf8")).map(({ directory }) => directory);
		const closure = runtimeClosure(XVER_RUNTIME_ROOTS, byName);

		expect(
			buildOrderViolations(buildDirectories, closure, byName),
			"the clean worktree must not inherit a missing or stale workspace dist"
		).toEqual([]);
	});

	it("runs XVER when any package in the selected runtime/build closure changes", () => {
		const byName = workspacePackages();
		const closure = runtimeClosure(XVER_RUNTIME_ROOTS, byName);
		const workflow = parseDocument(readFileSync(workflowPath, "utf8"), { schema: "core" }).toJS() as {
			on?: { pull_request?: { paths?: string[] } };
		};
		const triggerPaths = new Set(workflow.on?.pull_request?.paths ?? []);
		const missingTriggers = [...closure.keys()]
			.map((directory) => `${directory}/**`)
			.filter((path) => !triggerPaths.has(path))
			.sort();

		expect(missingTriggers, "every clean-build input must trigger the gate").toEqual([]);
	});

	it("runs XVER when a tracked config in the selected packages' extends chain changes", () => {
		const closure = runtimeClosure(XVER_RUNTIME_ROOTS, workspacePackages());
		const configPaths = trackedConfigExtendsChain(
			[...closure.keys()].map((directory) => resolve(repositoryRoot, directory, "tsconfig.build.json"))
		);
		const workflow = parseDocument(readFileSync(workflowPath, "utf8"), { schema: "core" }).toJS() as {
			on?: { pull_request?: { paths?: string[] } };
		};

		expect(
			missingExternalConfigTriggers(
				configPaths,
				new Set(closure.keys()),
				new Set(workflow.on?.pull_request?.paths ?? [])
			),
			"tracked compiler configs outside package globs are build inputs and must trigger XVER"
		).toEqual([]);
	});

	it("declares every package absent from the pinned reference as narrowly reference-optional", () => {
		const source = readFileSync(runnerPath, "utf8");
		const sourceFile = ts.createSourceFile(runnerPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const referenceSha = runnerStringConstant(sourceFile, "REFERENCE_SHA");
		expect(referenceSha, "the runner must pin REFERENCE_SHA as a string literal").toMatch(/^[0-9a-f]{40}$/);
		if (!referenceSha) return;
		expect(
			spawnSync("git", ["cat-file", "-e", `${referenceSha}^{commit}`], { cwd: repositoryRoot }).status,
			"the pinned reference commit must be available locally"
		).toBe(0);

		const entries = runnerBuildEntries(source);
		const currentPresent = new Set(
			entries
				.filter(({ directory }) => existsSync(resolve(repositoryRoot, directory, "package.json")))
				.map(({ directory }) => directory)
		);
		const referencePresent = new Set(
			entries
				.filter(
					({ directory }) =>
						spawnSync("git", ["cat-file", "-e", `${referenceSha}:${directory}/package.json`], {
							cwd: repositoryRoot,
						}).status === 0
				)
				.map(({ directory }) => directory)
		);

		expect(
			revisionClosureViolations(entries, currentPresent, referencePresent),
			"historical absence must be explicit; primary absence and stale exceptions remain forbidden"
		).toEqual([]);
	});

	it("detects both a missing workspace dependency and a reversed build edge", () => {
		const byName = new Map<string, WorkspacePackage>([
			["@test/base", { dependencies: [], directory: "packages/base", name: "@test/base" }],
			["@test/consumer", { dependencies: ["@test/base"], directory: "packages/consumer", name: "@test/consumer" }],
		]);
		const closure = runtimeClosure(["packages/consumer"], byName);

		expect(buildOrderViolations(["packages/consumer"], closure, byName)).toEqual(["missing packages/base"]);
		expect(buildOrderViolations(["packages/consumer", "packages/base"], closure, byName)).toEqual([
			"packages/base must precede packages/consumer",
		]);
	});

	it("rejects unmarked reference absence and all primary absence", () => {
		const entries: BuildEntry[] = [
			{ directory: "packages/base" },
			{ directory: "packages/new", referenceOptional: true },
		];

		expect(revisionClosureViolations(entries, new Set(["packages/base", "packages/new"]), new Set())).toEqual([
			"reference missing packages/base is not declared reference-optional",
		]);
		expect(revisionClosureViolations(entries, new Set(["packages/base"]), new Set())).toEqual([
			"primary missing packages/new",
			"reference missing packages/base is not declared reference-optional",
		]);
		expect(
			revisionClosureViolations(entries, new Set(["packages/base", "packages/new"]), new Set(["packages/base"]))
		).toEqual([]);
	});

	it("detects an uncovered external config without overclaiming package-covered configs", () => {
		const configs = ["packages/object/tsconfig.build.json", "packages/object/tsconfig.json", "tsconfig.json"];
		const packageDirectories = new Set(["packages/object"]);

		expect(missingExternalConfigTriggers(configs, packageDirectories, new Set())).toEqual(["tsconfig.json"]);
		expect(missingExternalConfigTriggers(configs, packageDirectories, new Set(["tsconfig.json"]))).toEqual([]);
	});
});
