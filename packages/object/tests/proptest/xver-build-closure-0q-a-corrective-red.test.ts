import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function runnerBuildDirectories(source: string): string[] {
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
		const property = element.properties.find(
			(candidate): candidate is ts.PropertyAssignment =>
				ts.isPropertyAssignment(candidate) &&
				(ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
				candidate.name.text === "directory"
		);
		return property && ts.isStringLiteral(property.initializer) ? [property.initializer.text] : [];
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

describe("Phase 0q-a corrective XVER build-closure RED", () => {
	it("builds every in-repo runtime dependency before each selected consumer", () => {
		const byName = workspacePackages();
		const buildDirectories = runnerBuildDirectories(readFileSync(runnerPath, "utf8"));
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
});
