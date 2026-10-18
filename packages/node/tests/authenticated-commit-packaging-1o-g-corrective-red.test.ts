/**
 * Phase 1o-g corrective RED: freeze the one-function supported package seam
 * and the source-mode alias needed to keep its WeakMap registry singleton.
 */
import * as objectRoot from "@ts-drp/object";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const objectPackagePath = resolve(workspaceRoot, "packages/object/package.json");
const nodePackagePath = resolve(workspaceRoot, "packages/node/package.json");
const capabilitySourcePath = resolve(workspaceRoot, "packages/object/src/authenticated-commit.ts");
const rawFacadePath = resolve(workspaceRoot, "packages/object/src/committed-provenance.ts");
const handlersPath = resolve(workspaceRoot, "packages/node/src/handlers.ts");
const vitePath = resolve(workspaceRoot, "vite.config.mts");

interface PackageManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly exports?: Readonly<Record<string, unknown>>;
	readonly version?: string;
}

function manifest(path: string): PackageManifest {
	return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function exportedNames(path: string): string[] {
	if (!existsSync(path)) return [];
	const sourceText = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names: string[] = [];
	for (const statement of source.statements) {
		const exported = ts.canHaveModifiers(statement)
			? ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true
			: false;
		if (
			exported &&
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement))
		) {
			if (statement.name !== undefined) names.push(statement.name.text);
		}
		if (exported && ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
			}
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) names.push(element.name.text);
		}
		if (ts.isExportAssignment(statement)) names.push("default");
	}
	return names.sort();
}

describe("Phase 1o-g authenticated-commit package boundary", () => {
	test("exports exactly one boolean capability on the exact internal subpath and nothing raw from root", () => {
		const objectPackage = manifest(objectPackagePath);
		const exportsMap = objectPackage.exports ?? {};
		expect.soft(Object.keys(exportsMap).sort()).toEqual([".", "./internal/authenticated-commit"]);
		expect.soft(exportsMap["./internal/authenticated-commit"]).toEqual({
			import: "./dist/src/authenticated-commit.js",
			types: "./dist/src/authenticated-commit.d.ts",
		});
		expect.soft(exportedNames(capabilitySourcePath)).toEqual(["wasAuthenticatedHashCommitted"]);
		expect
			.soft(exportedNames(rawFacadePath), "the unexported frozen-RED facade exposes only its raw reader")
			.toEqual(["readCommittedProvenance"]);

		for (const forbidden of [
			"readCommittedProvenance",
			"readAuthenticatedCommitted",
			"recordCommittedProvenance",
			"wasAuthenticatedHashCommitted",
			"authenticatedCommitRegistry",
		]) {
			expect.soft(forbidden in objectRoot, `${forbidden} must remain absent from @ts-drp/object`).toBe(false);
		}
		for (const key of Object.keys(exportsMap)) {
			if (key === "." || key === "./internal/authenticated-commit") continue;
			expect(key).not.toMatch(/committed-provenance|authenticated-commit-(?:registry|writer|reader)|\/src|\/dist/);
		}
	});

	test("keeps source-mode and release consumers on the same supported singleton seam", () => {
		const viteSource = readFileSync(vitePath, "utf8");
		const capabilityAlias =
			'"@ts-drp/object/internal/authenticated-commit": path.resolve(__dirname, "packages/object/src/authenticated-commit.ts")';
		const rootAlias = '"@ts-drp/object": path.resolve(__dirname, "packages/object/src/index.ts")';
		const capabilityIndex = viteSource.indexOf(capabilityAlias);
		const rootIndex = viteSource.indexOf(rootAlias);
		expect.soft(capabilityIndex, "the exact capability source alias exists").toBeGreaterThanOrEqual(0);
		expect.soft(rootIndex, "positive control: the root source alias remains present").toBeGreaterThanOrEqual(0);
		expect
			.soft(
				capabilityIndex >= 0 && capabilityIndex < rootIndex,
				"the longer subpath alias must exist before the root alias"
			)
			.toBe(true);

		const handlersSource = readFileSync(handlersPath, "utf8");
		expect.soft(handlersSource).toContain('from "@ts-drp/object/internal/authenticated-commit"');
		expect(handlersSource).not.toMatch(/from\s+["'][^"']*(?:\.\.\/)+object\/src\//);

		const objectPackage = manifest(objectPackagePath);
		const nodePackage = manifest(nodePackagePath);
		expect(nodePackage.dependencies?.["@ts-drp/object"]).toBe(objectPackage.version);
	});
});
