import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
	BROWSER_DEATH_TUPLES,
	BROWSER_SCHEMA,
	NO_WRITE_DEATH_TUPLES,
	NODE_DEATH_TUPLES,
	NODE_SCHEMA,
	NODE_SQLITE_CATALOG,
} from "./fixtures/phase-3a1b-p4/live-journal-contract.js";
import {
	P4_BROWSER_DEATH_TUPLES,
	P4_BROWSER_NO_WRITE_DEATH_TUPLES,
	P4_BROWSER_SCHEMA,
} from "../packages/storage-browser/tests/fixtures/phase-3a1b-p4-browser-contract.js";
import {
	P4_NODE_DEATH_TUPLES,
	P4_NODE_NO_WRITE_DEATH_TUPLES,
	P4_NODE_SCHEMA,
	P4_NODE_SQLITE_CATALOG,
} from "../packages/storage-node/tests/fixtures/phase-3a1b-p4-node-contract.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const EXACT_EXPORT = Object.freeze({
	import: "./dist/src/live-journal.js",
	types: "./dist/src/live-journal.d.ts",
});
const SHARED_RUNTIME_EXPORTS = Object.freeze([
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);
const SHARED_DECLARATION_EXPORTS = Object.freeze([
	"AppendAcceptedVertexInput",
	"AppendAcceptedVertexResult",
	"DurableLiveJournalStore",
	"InstallLiveJournalGenesisInput",
	"InstallLiveJournalGenesisResult",
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"LiveJournalAcceptedRow",
	"LiveJournalFailureKind",
	"LiveJournalPageInput",
	"LiveJournalPageResult",
	"LiveJournalReadinessInput",
	"LiveJournalReadinessResult",
	"LiveJournalScope",
	"LiveJournalSnapshotToken",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);
interface AdapterManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly exports?: Readonly<Record<string, unknown>>;
}

function consumeSharedDecisionResults(
	results: Readonly<Record<"capture" | "duplicate" | "observation" | "snapshot", boolean>>
): string {
	if (!results.capture) return "malformed-input";
	if (!results.duplicate) return "evidence-conflict";
	if (!results.observation) return "outcome-unknown";
	return results.snapshot ? "success" : "store-poisoned";
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function json(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

function sha256(relativePath: string): string {
	return createHash("sha256")
		.update(fs.readFileSync(path.join(ROOT, relativePath)))
		.digest("hex");
}

function adapterViolations(manifest: AdapterManifest, expectedDependencies: readonly string[]): readonly string[] {
	const violations: string[] = [];
	const exportsMap = manifest.exports ?? {};
	const dependencies = manifest.dependencies ?? {};
	const root = exportsMap["."] as Readonly<Record<string, unknown>> | undefined;
	const issuance = exportsMap["./issuance"] as Readonly<Record<string, unknown>> | undefined;
	const journal = exportsMap["./live-journal"] as Readonly<Record<string, unknown>> | undefined;
	if (
		root?.import !== "./dist/src/index.js" ||
		root.types !== "./dist/src/index.d.ts" ||
		Object.keys(root).length !== 2
	) {
		violations.push("root-export");
	}
	if (
		issuance?.import !== "./dist/src/issuance.js" ||
		issuance.types !== "./dist/src/issuance.d.ts" ||
		Object.keys(issuance).length !== 2
	) {
		violations.push("issuance-export");
	}
	if (
		journal?.import !== EXACT_EXPORT.import ||
		journal.types !== EXACT_EXPORT.types ||
		Object.keys(journal ?? {}).length !== 2
	) {
		violations.push("journal-export");
	}
	if (JSON.stringify(Object.keys(exportsMap).sort()) !== JSON.stringify([".", "./issuance", "./live-journal"])) {
		violations.push("export-inventory");
	}
	if (dependencies["@ts-drp/live-journal"] !== "0.11.0") violations.push("journal-version");
	if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify([...expectedDependencies].sort())) {
		violations.push("dependency-inventory");
	}
	return violations;
}

function sourceFiles(directory: string): readonly string[] {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? sourceFiles(path.join(directory, entry.name))
				: entry.isFile() && /\.(?:js|mjs|ts)$/u.test(entry.name)
					? [path.join(directory, entry.name)]
					: []
		);
}

function sharedDecisionViolations(source: string, filename: string): readonly string[] {
	const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const violations: string[] = [];
	const owners = new Map<string, ts.FunctionLikeDeclaration>();
	const classes = new Map<string, ts.ClassLikeDeclaration>();
	const immutableImmediateInvokers = new Map<string, ts.ArrowFunction>();
	const exportedOwners = new Set<string>();
	for (const statement of file.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
			owners.set(statement.name.text, statement);
			if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
				exportedOwners.add(statement.name.text);
			}
		} else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
			classes.set(statement.name.text, statement);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer !== undefined &&
					(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
				) {
					owners.set(declaration.name.text, declaration.initializer);
					if (
						(statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
						ts.isArrowFunction(declaration.initializer)
					) {
						immutableImmediateInvokers.set(declaration.name.text, declaration.initializer);
					}
					if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
						exportedOwners.add(declaration.name.text);
					}
				}
			}
		} else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
			for (const element of ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []) {
				exportedOwners.add(element.propertyName?.text ?? element.name.text);
			}
		}
	}
	const imported = file.statements.flatMap((statement) => {
		if (
			!ts.isImportDeclaration(statement) ||
			statement.moduleSpecifier.getText(file) !== '"@ts-drp/live-journal"' ||
			statement.importClause?.namedBindings === undefined ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		) {
			return [];
		}
		return statement.importClause.namedBindings.elements
			.filter((element) => !statement.importClause?.isTypeOnly && !element.isTypeOnly)
			.map((element) => ({
				local: element.name.text,
				owner: element.propertyName?.text ?? element.name.text,
			}));
	});
	const required = SHARED_RUNTIME_EXPORTS.filter((name) => !name.startsWith("LIVE_JOURNAL_"));
	const capabilityMethods = new Set(["installGenesis", "appendAccepted", "readiness", "readPage", "close"]);
	const reachableOwners = new Set(exportedOwners);
	const reachableCalls: ts.CallExpression[] = [];
	const controlsAdapterOutcome = (call: ts.CallExpression): boolean => {
		let cursor: ts.Node = call;
		while (!ts.isStatement(cursor) && cursor.parent !== undefined) {
			const parent = cursor.parent;
			if (ts.isArrowFunction(parent) && parent.body === cursor) return true;
			if (
				(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
				ts.isCallExpression(parent.parent) &&
				immediatelyInvokesCallback(parent.parent, parent)
			) {
				return controlsAdapterOutcome(parent.parent);
			}
			if (
				(ts.isIfStatement(parent) &&
					parent.expression === cursor &&
					cursor.kind !== ts.SyntaxKind.FalseKeyword &&
					cursor.kind !== ts.SyntaxKind.TrueKeyword) ||
				ts.isReturnStatement(parent)
			) {
				return true;
			}
			cursor = parent;
		}
		if (!ts.isVariableDeclaration(call.parent) || !ts.isIdentifier(call.parent.name)) return false;
		const binding = call.parent.name.text;
		let owner: ts.Node | undefined = call;
		while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
		if (owner === undefined || owner.body === undefined) return false;
		let controls = false;
		const isStaticallyDead = (node: ts.Node): boolean => {
			let child = node;
			for (let parent = node.parent; parent !== undefined && parent !== owner; parent = parent.parent) {
				if (
					ts.isIfStatement(parent) &&
					((parent.expression.kind === ts.SyntaxKind.FalseKeyword && parent.thenStatement === child) ||
						(parent.expression.kind === ts.SyntaxKind.TrueKeyword && parent.elseStatement === child))
				) {
					return true;
				}
				child = parent;
			}
			return false;
		};
		const visitUse = (node: ts.Node): void => {
			if (controls) return;
			if (node !== owner && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)))
				return;
			if (ts.isIdentifier(node) && node.text === binding && node !== call.parent.name) {
				if (isStaticallyDead(node)) return;
				let use: ts.Node = node;
				while (!ts.isStatement(use) && use.parent !== undefined) {
					const parent = use.parent;
					if (
						(ts.isIfStatement(parent) &&
							parent.expression === use &&
							parent.expression.kind !== ts.SyntaxKind.FalseKeyword &&
							parent.expression.kind !== ts.SyntaxKind.TrueKeyword) ||
						ts.isReturnStatement(parent)
					) {
						controls = true;
						return;
					}
					use = parent;
				}
			}
			ts.forEachChild(node, visitUse);
		};
		visitUse(owner.body);
		return controls;
	};
	const immediatelyInvokesCallback = (call: ts.CallExpression, callback: ts.Node): boolean => {
		if (!ts.isIdentifier(call.expression)) return false;
		const argumentIndex = call.arguments.findIndex((argument) => argument === callback);
		if (argumentIndex < 0) return false;
		const invoker = immutableImmediateInvokers.get(call.expression.text);
		const parameter = invoker?.parameters[argumentIndex]?.name;
		if (invoker === undefined || invoker.body === undefined || !ts.isIdentifier(parameter)) return false;
		const returned = ts.isBlock(invoker.body)
			? invoker.body.statements.length === 1 && ts.isReturnStatement(invoker.body.statements[0])
				? invoker.body.statements[0].expression
				: undefined
			: invoker.body;
		return (
			returned !== undefined &&
			ts.isCallExpression(returned) &&
			ts.isIdentifier(returned.expression) &&
			returned.expression.text === parameter.text &&
			returned.arguments.length === 0
		);
	};
	const inspectExpression = (node: ts.Node, localCalls: Set<string>): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
			const invoked =
				ts.isCallExpression(node.parent) &&
				(node.parent.expression === node || immediatelyInvokesCallback(node.parent, node));
			if (!invoked) return;
			if (ts.isBlock(node.body)) inspectStatements(node.body.statements, localCalls);
			else inspectExpression(node.body, localCalls);
			return;
		}
		if (ts.isCallExpression(node)) {
			reachableCalls.push(node);
			if (ts.isIdentifier(node.expression) && owners.has(node.expression.text)) localCalls.add(node.expression.text);
		}
		if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return;
		ts.forEachChild(node, (child) => inspectExpression(child, localCalls));
	};
	const inspectCapabilityFunction = (owner: ts.FunctionLikeDeclaration, localCalls: Set<string>): void => {
		if (owner.body === undefined) return;
		if (ts.isBlock(owner.body)) inspectStatements(owner.body.statements, localCalls);
		else inspectExpression(owner.body, localCalls);
	};
	const memberName = (member: ts.NamedDeclaration): string | undefined => {
		if (member.name === undefined) return undefined;
		return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
	};
	const unwrapFrozenCapability = (expression: ts.Expression): ts.Expression => {
		if (
			ts.isCallExpression(expression) &&
			expression.arguments.length === 1 &&
			ts.isPropertyAccessExpression(expression.expression) &&
			expression.expression.expression.getText(file) === "Object" &&
			expression.expression.name.text === "freeze"
		) {
			return expression.arguments[0];
		}
		return expression;
	};
	const localCapabilityOwner = (
		name: string,
		returnedExpression: ts.Expression
	): ts.FunctionLikeDeclaration | undefined => {
		let factory: ts.Node | undefined = returnedExpression;
		while (factory !== undefined && !ts.isFunctionLike(factory)) factory = factory.parent;
		if (factory === undefined || factory.body === undefined || !ts.isBlock(factory.body)) return undefined;
		for (const statement of factory.body.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined) {
				return statement;
			}
			if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
				continue;
			}
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === name &&
					declaration.initializer !== undefined &&
					(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
				) {
					return declaration.initializer;
				}
			}
		}
		return undefined;
	};
	const inspectReturnedCapability = (expression: ts.Expression, localCalls: Set<string>): void => {
		const capability = unwrapFrozenCapability(expression);
		if (ts.isObjectLiteralExpression(capability)) {
			const named = capability.properties.flatMap((property) => {
				const name = memberName(property);
				return name === undefined ? [] : [name];
			});
			if (
				named.length !== capabilityMethods.size ||
				named.some((name) => !capabilityMethods.has(name)) ||
				new Set(named).size !== capabilityMethods.size
			) {
				return;
			}
			for (const property of capability.properties) {
				if (ts.isMethodDeclaration(property)) {
					inspectCapabilityFunction(property, localCalls);
				} else if (
					ts.isPropertyAssignment(property) &&
					(ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
				) {
					inspectCapabilityFunction(property.initializer, localCalls);
				} else if (ts.isShorthandPropertyAssignment(property)) {
					const owner = owners.get(property.name.text) ?? localCapabilityOwner(property.name.text, expression);
					if (owner !== undefined) inspectCapabilityFunction(owner, localCalls);
				}
			}
			return;
		}
		if (!ts.isNewExpression(capability) || !ts.isIdentifier(capability.expression)) return;
		const declaration = classes.get(capability.expression.text);
		if (declaration === undefined) return;
		const methods = declaration.members.filter(
			(member): member is ts.MethodDeclaration | ts.PropertyDeclaration =>
				(ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
				memberName(member) !== undefined &&
				capabilityMethods.has(memberName(member) ?? "")
		);
		if (new Set(methods.map((method) => memberName(method))).size !== capabilityMethods.size) return;
		for (const method of methods) {
			if (ts.isMethodDeclaration(method)) inspectCapabilityFunction(method, localCalls);
			else if (
				method.initializer !== undefined &&
				(ts.isArrowFunction(method.initializer) || ts.isFunctionExpression(method.initializer))
			) {
				inspectCapabilityFunction(method.initializer, localCalls);
			}
		}
	};
	const inspectStatement = (statement: ts.Statement, localCalls: Set<string>): boolean => {
		if (ts.isBlock(statement)) return inspectStatements(statement.statements, localCalls);
		if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
			if (statement.expression !== undefined) {
				if (ts.isReturnStatement(statement)) inspectReturnedCapability(statement.expression, localCalls);
				inspectExpression(statement.expression, localCalls);
			}
			return false;
		}
		if (ts.isIfStatement(statement)) {
			inspectExpression(statement.expression, localCalls);
			if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
				return statement.elseStatement === undefined || inspectStatement(statement.elseStatement, localCalls);
			}
			if (statement.expression.kind === ts.SyntaxKind.TrueKeyword)
				return inspectStatement(statement.thenStatement, localCalls);
			const thenFalls = inspectStatement(statement.thenStatement, localCalls);
			const elseFalls = statement.elseStatement === undefined || inspectStatement(statement.elseStatement, localCalls);
			return thenFalls || elseFalls;
		}
		if (ts.isTryStatement(statement)) {
			const tryFalls = inspectStatement(statement.tryBlock, localCalls);
			const catchFalls =
				statement.catchClause === undefined || inspectStatement(statement.catchClause.block, localCalls);
			const finallyFalls = statement.finallyBlock === undefined || inspectStatement(statement.finallyBlock, localCalls);
			return finallyFalls && (statement.catchClause === undefined ? tryFalls : tryFalls || catchFalls);
		}
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return true;
		inspectExpression(statement, localCalls);
		return true;
	};
	function inspectStatements(statements: ts.NodeArray<ts.Statement>, localCalls: Set<string>): boolean {
		for (const statement of statements) if (!inspectStatement(statement, localCalls)) return false;
		return true;
	}
	for (const name of reachableOwners) {
		const owner = owners.get(name);
		if (owner === undefined || owner.body === undefined) continue;
		const localCalls = new Set<string>();
		if (ts.isBlock(owner.body)) inspectStatements(owner.body.statements, localCalls);
		else inspectExpression(owner.body, localCalls);
		for (const local of localCalls) reachableOwners.add(local);
	}
	for (const name of required) {
		const owner = imported.find((candidate) => candidate.owner === name);
		if (owner === undefined) {
			violations.push(`missing-import:${name}`);
			continue;
		}
		const calls = reachableCalls.filter(
			(call) => ts.isIdentifier(call.expression) && call.expression.text === owner.local
		);
		for (const call of calls) {
			if (ts.isExpressionStatement(call.parent) || ts.isVoidExpression(call.parent)) {
				violations.push(`discarded-result:${name}`);
			}
			if (!controlsAdapterOutcome(call)) violations.push(`outcome-uncontrolled:${name}`);
		}
		if (calls.length === 0) violations.push(`unreachable:${name}`);
	}
	return Object.freeze(violations.sort());
}

function explicitExportNames(source: string, filename: string): readonly string[] {
	const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names: string[] = [];
	for (const statement of file.statements) {
		if (ts.isExportAssignment(statement)) {
			names.push("default");
		} else if (ts.isExportDeclaration(statement)) {
			if (statement.exportClause === undefined) throw new Error(`${filename}: export-star is forbidden`);
			if (ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) names.push(element.name.text);
			}
		} else if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isModuleDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement)) &&
			statement.name !== undefined &&
			statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
		) {
			names.push(
				statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name.text
			);
		} else if (
			ts.isVariableStatement(statement) &&
			statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
			}
		}
	}
	return Object.freeze(names.sort());
}

describe("D.93.34 p4-d parity and governance RED", () => {
	it("binds both adapter schemas and complete death registries to the shared contract owner", () => {
		expect(P4_NODE_SCHEMA).toEqual(NODE_SCHEMA);
		expect(P4_NODE_SQLITE_CATALOG).toEqual(NODE_SQLITE_CATALOG);
		expect(P4_BROWSER_SCHEMA).toEqual(BROWSER_SCHEMA);
		expect(P4_NODE_DEATH_TUPLES).toEqual(NODE_DEATH_TUPLES);
		expect(P4_BROWSER_DEATH_TUPLES).toEqual(BROWSER_DEATH_TUPLES);
		expect(P4_NODE_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
		expect(P4_BROWSER_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
	});

	it("transitions only the two adapter manifests to exact additive exports and dependencies", () => {
		const node = json("packages/storage-node/package.json") as AdapterManifest;
		const browser = json("packages/storage-browser/package.json") as AdapterManifest;
		expect(adapterViolations(node, ["@ts-drp/issuance-store", "@ts-drp/live-journal", "@ts-drp/storage"])).toEqual([]);
		expect(
			adapterViolations(browser, [
				"@ts-drp/canonical",
				"@ts-drp/issuance-store",
				"@ts-drp/live-journal",
				"@ts-drp/storage",
			])
		).toEqual([]);
	});

	it("kills missing, extra, retargeted, deep and wrong-version additive transition mutants", () => {
		const baseline: AdapterManifest = {
			dependencies: {
				"@ts-drp/issuance-store": "0.11.0",
				"@ts-drp/live-journal": "0.11.0",
				"@ts-drp/storage": "0.11.0",
			},
			exports: {
				".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
				"./issuance": { import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" },
				"./live-journal": EXACT_EXPORT,
			},
		};
		const expected = ["@ts-drp/issuance-store", "@ts-drp/live-journal", "@ts-drp/storage"];
		expect(adapterViolations(baseline, expected)).toEqual([]);
		const mutants: readonly AdapterManifest[] = [
			{ ...baseline, exports: { ...baseline.exports, "./live-journal": undefined } },
			{ ...baseline, exports: { ...baseline.exports, "./private/live-journal": EXACT_EXPORT } },
			{
				...baseline,
				exports: { ...baseline.exports, "./live-journal": { ...EXACT_EXPORT, import: "./src/live-journal.ts" } },
			},
			{ ...baseline, exports: { ...baseline.exports, "./issuance": EXACT_EXPORT } },
			{ ...baseline, dependencies: { ...baseline.dependencies, "@ts-drp/live-journal": "workspace:*" } },
			{ ...baseline, dependencies: { ...baseline.dependencies, "@ts-drp/protocol-v3": "0.11.0" } },
		];
		expect(mutants.map((mutant) => adapterViolations(mutant, expected).length > 0)).toEqual(Array(6).fill(true));
	});

	it("keeps every old root byte and public runtime root unchanged while adding no node-facing journal seam", async () => {
		expect(sha256("packages/storage-node/src/index.ts")).toBe(
			"14688ec0442cf331f329a5cb944bfa893f6a6ef08eeedd8bb6352651283d7211"
		);
		expect(sha256("packages/storage-browser/src/index.ts")).toBe(
			"30d32c3b4e9f9b4a7036602fe2338315167112bec41ca83a753b4feaba3bf56c"
		);
		const nodeRoot = await import("@ts-drp/storage-node");
		const browserRoot = await import("@ts-drp/storage-browser");
		expect(nodeRoot).not.toHaveProperty("createNodeDurableLiveJournalStore");
		expect(browserRoot).not.toHaveProperty("createBrowserDurableLiveJournalStore");
		const nodePackage = await import("@ts-drp/node");
		expect(nodePackage).not.toHaveProperty("DurableLiveJournalStore");
		expect(nodePackage).not.toHaveProperty("LiveJournalSnapshotToken");
		const journalRoot = await import("@ts-drp/live-journal"); // eslint-disable-line import/no-unresolved -- production RED.
		expect(Object.keys(journalRoot).sort()).toEqual([...SHARED_RUNTIME_EXPORTS].sort());
	});

	it("pins the exact explicit source and emitted declaration surfaces without backend or factory authority", () => {
		const source = fs.readFileSync(path.join(ROOT, "packages/live-journal/src/index.ts"), "utf8");
		const declaration = fs.readFileSync(path.join(ROOT, "packages/live-journal/dist/src/index.d.ts"), "utf8");
		expect(explicitExportNames(source, "live-journal/src/index.ts")).toEqual([...SHARED_DECLARATION_EXPORTS].sort());
		expect(explicitExportNames(declaration, "live-journal/dist/src/index.d.ts")).toEqual(
			[...SHARED_DECLARATION_EXPORTS].sort()
		);
		for (const text of [source, declaration]) {
			expect(text).not.toMatch(/\b(?:LiveJournalBackend|createDurableLiveJournalStore)\b/u);
		}
	});

	it("pins both adapter source declarations and built runtime inventories exactly", async () => {
		for (const [packageName, factory, options] of [
			["storage-node", "createNodeDurableLiveJournalStore", "NodeDurableLiveJournalStoreOptions"],
			["storage-browser", "createBrowserDurableLiveJournalStore", "BrowserDurableLiveJournalStoreOptions"],
		] as const) {
			const directory = path.join(ROOT, `packages/${packageName}`);
			const source = fs.readFileSync(path.join(directory, "src/live-journal.ts"), "utf8");
			const declaration = fs.readFileSync(path.join(directory, "dist/src/live-journal.d.ts"), "utf8");
			expect(explicitExportNames(source, `${packageName}/src/live-journal.ts`)).toEqual([factory, options].sort());
			expect(explicitExportNames(declaration, `${packageName}/dist/src/live-journal.d.ts`)).toEqual(
				[factory, options].sort()
			);
			const runtime = (await import(pathToFileURL(path.join(directory, "dist/src/live-journal.js")).href)) as Record<
				string,
				unknown
			>;
			expect(Object.keys(runtime).sort()).toEqual([factory]);
			expect(typeof runtime[factory]).toBe("function");
		}
	});

	it("keeps local journal domains out of both protocol registries and freezes registry bytes", () => {
		const v2 = json("packages/protocol-v2/registry/field-registry.json");
		const v3 = json("packages/protocol-v3/registry/registry-v1.json");
		const serialized = `${JSON.stringify(v2)}${JSON.stringify(v3)}`;
		for (const domain of [
			"ts-drp/live-journal-row/v1",
			"ts-drp/live-journal-order/v1",
			"ts-drp/live-journal-snapshot/v1",
		]) {
			expect(serialized).not.toContain(domain);
		}
		expect(sha256("packages/protocol-v3/registry/registry-v1.json")).toBe(
			"2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9"
		);
	});

	it("ships source, declarations and runtime only through the three exact package subpaths", () => {
		for (const packageName of ["storage-node", "storage-browser"] as const) {
			const directory = path.join(ROOT, `packages/${packageName}`);
			const manifest = json(`packages/${packageName}/package.json`);
			expect(manifest.files).toEqual(
				packageName === "storage-node"
					? ["src", "dist", "!dist/test", "!dist/tests", "!**/*.tsbuildinfo"]
					: ["src", "dist", "!dist/test", "!dist/tests", "!dist/playwright*", "!**/*.tsbuildinfo"]
			);
			expect(fs.existsSync(path.join(directory, "src/live-journal.ts"))).toBe(true);
			expect(fs.existsSync(path.join(directory, "dist/src/live-journal.js"))).toBe(true);
			expect(fs.existsSync(path.join(directory, "dist/src/live-journal.d.ts"))).toBe(true);
			const destination = fs.mkdtempSync(path.join(os.tmpdir(), `phase-3a1b-p4-pack-${packageName}-`));
			temporaryDirectories.push(destination);
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
					cwd: directory,
					encoding: "utf8",
				})
			) as readonly [{ readonly files: readonly { readonly path: string }[] }];
			const files = packed[0].files.map(({ path: file }) => file);
			expect(files).toEqual(expect.arrayContaining(["dist/src/live-journal.d.ts", "dist/src/live-journal.js"]));
			expect(files.filter((file) => /(?:phase-3a1b-p4|live-journal-(?:observation|test-control))/u.test(file))).toEqual(
				[]
			);
			const packedTestControls = files
				.filter((file) => /(?:^|\/)(?:tests?|fixtures?)(?:\/|[-.])|test-control/u.test(file))
				.sort();
			if (packageName === "storage-browser") {
				expect(packedTestControls).toEqual([
					"dist/src/internal/issuance-test-control.d.ts",
					"dist/src/internal/issuance-test-control.js",
					"src/internal/issuance-test-control.ts",
				]);
			} else {
				expect(packedTestControls).toEqual([]);
			}
		}
	});

	it("makes both strict adapters reach and consume the exact shared pure decisions", () => {
		const node = fs.readFileSync(path.join(ROOT, "packages/storage-node/src/live-journal.ts"), "utf8");
		const browser = fs.readFileSync(path.join(ROOT, "packages/storage-browser/src/live-journal.ts"), "utf8");
		expect(sharedDecisionViolations(node, "storage-node/live-journal.ts")).toEqual([]);
		expect(sharedDecisionViolations(browser, "storage-browser/live-journal.ts")).toEqual([]);
	});

	it("causally rejects unreachable or discarded shared-decision calls", () => {
		const control = `import { ${SHARED_RUNTIME_EXPORTS.filter((name) => !name.startsWith("LIVE_JOURNAL_")).join(
			", "
		)} } from "@ts-drp/live-journal";\nexport function owner() { const captured = captureLiveJournalInput({}); if (captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (observed) return observed; const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate; return deriveLiveJournalSnapshot({}); }`;
		expect(sharedDecisionViolations(control, "control.ts")).toEqual([]);
		const frozenFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
			(name) => !name.startsWith("LIVE_JOURNAL_")
		).join(
			", "
		)} } from "@ts-drp/live-journal";\nexport function createStore() { return Object.freeze({ installGenesis: async (input: unknown) => { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; }, appendAccepted: async (input: unknown) => { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; }, readiness: async (input: unknown) => { const snapshot = deriveLiveJournalSnapshot(input); return snapshot; }, readPage: async () => true, close: async () => true }); }`;
		expect(sharedDecisionViolations(frozenFacadeControl, "frozen-facade-control.ts")).toEqual([]);
		const localShorthandFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
			(name) => !name.startsWith("LIVE_JOURNAL_")
		).join(
			", "
		)} } from "@ts-drp/live-journal";\nexport function createStore() { const installGenesis = async (input: unknown) => { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; }; const appendAccepted = async (input: unknown) => { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; }; const readiness = async (input: unknown) => deriveLiveJournalSnapshot(input); const readPage = async () => true; const close = async () => true; return Object.freeze({ installGenesis, appendAccepted, readiness, readPage, close }); }`;
		expect(sharedDecisionViolations(localShorthandFacadeControl, "local-shorthand-facade-control.ts")).toEqual([]);
		const classFacadeControl = `import { ${SHARED_RUNTIME_EXPORTS.filter(
			(name) => !name.startsWith("LIVE_JOURNAL_")
		).join(
			", "
		)} } from "@ts-drp/live-journal";\nclass Store { async installGenesis(input: unknown) { const captured = captureLiveJournalInput(input); if (!captured) return captured; const observed = classifyLiveJournalMutationObservation({}); if (!observed) return observed; return captured; } async appendAccepted(input: unknown) { const duplicate = decideLiveJournalDuplicate(input); if (!duplicate) return duplicate; return duplicate; } async readiness(input: unknown) { return deriveLiveJournalSnapshot(input); } async readPage() { return true; } async close() { return true; } } export function createStore() { return Object.freeze(new Store()); }`;
		expect(sharedDecisionViolations(classFacadeControl, "class-facade-control.ts")).toEqual([]);
		expect(
			sharedDecisionViolations(
				control.replace("const duplicate = decideLiveJournalDuplicate({})", "void decideLiveJournalDuplicate({})"),
				"discarded.ts"
			)
		).toContain("discarded-result:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				control.replace(
					"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
					"function dead() { return null; decideLiveJournalDuplicate({}); }"
				),
				"dead.ts"
			)
		).toContain("unreachable:decideLiveJournalDuplicate");
		const immediateControl = control
			.replace(
				"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
				"const duplicate = runImmediateLiveJournalDecision(() => decideLiveJournalDuplicate({})); if (duplicate) return duplicate;"
			)
			.replace(
				"export function owner()",
				"const runImmediateLiveJournalDecision = (callback: () => unknown) => callback();\nexport function owner()"
			);
		expect(sharedDecisionViolations(immediateControl, "immediate-control.ts")).toEqual([]);
		expect(
			sharedDecisionViolations(immediateControl.replace("=> callback();", "=> true;"), "ignored-callback.ts")
		).toContain("unreachable:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				immediateControl.replace("const runImmediateLiveJournalDecision =", "let runImmediateLiveJournalDecision ="),
				"reassigned-invoker.ts"
			)
		).toContain("unreachable:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				control.replace(
					"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
					"const unused = () => decideLiveJournalDuplicate({});"
				),
				"uninvoked-callback.ts"
			)
		).toContain("unreachable:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				control.replace("if (duplicate) return duplicate;", "if (false) return duplicate;"),
				"uncontrolled.ts"
			)
		).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				control.replace(
					"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
					"const duplicate = decideLiveJournalDuplicate({}); const Never = class { value() { return duplicate; } }; void Never; return true;"
				),
				"nested-class-never-controls.ts"
			)
		).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
		expect(
			sharedDecisionViolations(
				control.replace(
					"const duplicate = decideLiveJournalDuplicate({}); if (duplicate) return duplicate;",
					"const duplicate = decideLiveJournalDuplicate({}); const never = () => duplicate; return true;"
				),
				"nested-never-controls.ts"
			)
		).toContain("outcome-uncontrolled:decideLiveJournalDuplicate");
		expect(consumeSharedDecisionResults({ capture: true, duplicate: true, observation: true, snapshot: true })).toBe(
			"success"
		);
		for (const [name, expected] of [
			["capture", "malformed-input"],
			["duplicate", "evidence-conflict"],
			["observation", "outcome-unknown"],
			["snapshot", "store-poisoned"],
		] as const) {
			const result = { capture: true, duplicate: true, observation: true, snapshot: true };
			result[name] = false;
			expect(consumeSharedDecisionResults(result)).toBe(expected);
		}
	});

	it("keeps production free of private p4 observation seams", () => {
		const node = fs.readFileSync(path.join(ROOT, "packages/storage-node/src/live-journal.ts"), "utf8");
		const browser = fs.readFileSync(path.join(ROOT, "packages/storage-browser/src/live-journal.ts"), "utf8");
		for (const source of [node, browser]) {
			expect(source).not.toMatch(/internal\/live-journal-observation|live-journal-(?:observation|test-control)/u);
		}
		for (const packageName of ["storage-node", "storage-browser"] as const) {
			expect(fs.existsSync(path.join(ROOT, `packages/${packageName}/src/internal/live-journal-observation.ts`))).toBe(
				false
			);
			expect(
				fs.existsSync(path.join(ROOT, `packages/${packageName}/dist/src/internal/live-journal-observation.js`))
			).toBe(false);
		}
	});

	it("forbids retained live indexes, consumer replay, outbox and activation authority in every p4 production owner", () => {
		const roots = [
			path.join(ROOT, "packages/live-journal/src"),
			path.join(ROOT, "packages/storage-node/src/live-journal.ts"),
			path.join(ROOT, "packages/storage-browser/src/live-journal.ts"),
		].filter((candidate) => fs.existsSync(candidate));
		expect(roots).toHaveLength(3);
		const files = roots.flatMap((candidate) =>
			fs.statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
		);
		const production = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		expect(production).not.toMatch(
			/\b(?:CausalityIndex|extractAdmittedReceivedVertex|readIssued|readOutboxPage|compareAndMarkOutboxPublished|activatePreparedV3Live|consumePreparedV3Live|subscribe|reducer|fold|discard|repair)\b/u
		);
		expect(production).not.toMatch(/@ts-drp\/(?:control-plane|issuance-store|node|network)\b/u);
	});

	it("keeps fast and nightly browser ownership explicit with no skip or single-engine downgrade", () => {
		for (const config of [
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal.config.ts",
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal-death.config.ts",
		]) {
			const source = fs.readFileSync(path.join(ROOT, config), "utf8");
			expect(source).toContain('{ name: "chromium"');
			expect(source).toContain('{ name: "firefox"');
			expect(source).toContain('{ name: "webkit"');
			expect(source).not.toMatch(/\.skip|process\.env.*\?/u);
		}
	});
});
