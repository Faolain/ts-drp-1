import ts from "typescript";

export interface AuthorAuthorizationSourceGraph {
	readonly index: string;
	readonly publicEntry: string;
	readonly singleton: string;
	readonly subpath: string;
}

const ROOT_TRUST_VALUES = [
	"authenticateCurrentEpochAnchor",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCurrentAnchorTrust",
] as const;
const SUBPATH_VALUES = ["openCurrentEpochAuthorAuthorization", "resolveCurrentEpochAuthorizedAuthor"] as const;
const SUBPATH_TYPES = [
	"AuthenticateCurrentEpochAnchorFailureReason",
	"AuthenticateCurrentEpochAnchorSuccessProvenance",
	"CurrentEpochAuthorAuthorization",
	"OpenCurrentEpochAuthorAuthorizationInput",
	"OpenCurrentEpochAuthorAuthorizationResult",
	"ResolveCurrentEpochAuthorizedAuthorInput",
	"ResolveCurrentEpochAuthorizedAuthorResult",
] as const;
const SINGLETON_VALUES = [...ROOT_TRUST_VALUES, ...SUBPATH_VALUES] as const;

function parse(name: string, source: string): ts.SourceFile {
	return ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function countCalls(file: ts.SourceFile, name: string): number {
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count++;
		ts.forEachChild(node, visit);
	};
	visit(file);
	return count;
}

function importsFrom(file: ts.SourceFile, moduleName: string): readonly string[] {
	const names: string[] = [];
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== moduleName ||
			statement.importClause?.namedBindings === undefined ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		)
			continue;
		for (const element of statement.importClause.namedBindings.elements)
			names.push(element.propertyName?.text ?? element.name.text);
	}
	return names.sort();
}

function runtimeExports(file: ts.SourceFile): readonly string[] {
	const names: string[] = [];
	for (const statement of file.statements) {
		if (ts.isExportAssignment(statement)) names.push("default");
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause))
				continue;
			for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.push(element.name.text);
			continue;
		}
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
			if (statement.name !== undefined) names.push(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
				if (ts.isObjectBindingPattern(declaration.name)) {
					for (const element of declaration.name.elements)
						if (ts.isIdentifier(element.name)) names.push(element.name.text);
				}
			}
		}
	}
	return names.sort();
}

function typeExports(file: ts.SourceFile): readonly string[] {
	const names: string[] = [];
	for (const statement of file.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) {
				names.push("*");
				continue;
			}
			for (const element of statement.exportClause.elements) {
				if (statement.isTypeOnly || element.isTypeOnly) names.push(element.name.text);
			}
			continue;
		}
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) names.push(statement.name.text);
	}
	return names.sort();
}

function equalNames(actual: readonly string[], expected: readonly string[]): boolean {
	return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/**
 * Semantic graph audit; formatting, local aliases and declaration order are intentionally irrelevant.
 * @param graph
 */
export function auditAuthorAuthorizationSourceGraph(graph: AuthorAuthorizationSourceGraph): readonly string[] {
	const violations: string[] = [];
	const publicEntry = parse("public.ts", graph.publicEntry);
	const singleton = parse("anchor-trust-singleton.ts", graph.singleton);
	const subpath = parse("author-authorization.ts", graph.subpath);
	if (countCalls(singleton, "createAnchorTrustApi") !== 1) violations.push("singleton-factory-count");
	if (countCalls(publicEntry, "createAnchorTrustApi") !== 0) violations.push("root-factory-call");
	if (countCalls(subpath, "createAnchorTrustApi") !== 0) violations.push("subpath-factory-call");
	if (!equalNames(importsFrom(publicEntry, "./anchor-trust-singleton.js"), ROOT_TRUST_VALUES)) {
		violations.push("root-owner-import");
	}
	if (!equalNames(importsFrom(subpath, "./anchor-trust-singleton.js"), SUBPATH_VALUES)) {
		violations.push("subpath-owner-import");
	}
	if (!equalNames(runtimeExports(singleton), SINGLETON_VALUES)) violations.push("singleton-runtime-surface");
	if (!equalNames(runtimeExports(subpath), SUBPATH_VALUES)) violations.push("subpath-runtime-surface");
	if (runtimeExports(publicEntry).some((name) => SUBPATH_VALUES.includes(name as (typeof SUBPATH_VALUES)[number]))) {
		violations.push("root-authorization-leak");
	}
	if (!graph.index.includes("CurrentEpochAuthorAuthorization")) violations.push("missing-contract-owner");
	if (!graph.index.includes("ts-drp/author-authorization/v3")) violations.push("missing-domain-owner");
	return violations;
}

/**
 * Exact semantic export audit shared by source and emitted declaration controls.
 * @param source
 */
export function auditAuthorAuthorizationSubpathSurface(source: string): readonly string[] {
	const file = parse("author-authorization.ts", source);
	const violations: string[] = [];
	if (!equalNames(runtimeExports(file), SUBPATH_VALUES)) violations.push("runtime-export-inventory");
	if (!equalNames(typeExports(file), SUBPATH_TYPES)) violations.push("type-export-inventory");
	return violations;
}

export const ANALYZER_POSITIVE_CONTROL: AuthorAuthorizationSourceGraph = Object.freeze({
	index: 'interface CurrentEpochAuthorAuthorization {} const domain = "ts-drp/author-authorization/v3";',
	publicEntry:
		'import { openCurrentAnchorTrust, authenticateCurrentEpochAnchor, isAnchorTrustStateRecordBytes, installCreatorAnchorTrustRoot } from "./anchor-trust-singleton.js"; export { openCurrentAnchorTrust, authenticateCurrentEpochAnchor, isAnchorTrustStateRecordBytes, installCreatorAnchorTrustRoot };',
	singleton:
		'import { createAnchorTrustApi } from "./index.js"; const owner = createAnchorTrustApi(); export const { authenticateCurrentEpochAnchor, installCreatorAnchorTrustRoot, isAnchorTrustStateRecordBytes, openCurrentAnchorTrust, openCurrentEpochAuthorAuthorization, resolveCurrentEpochAuthorizedAuthor } = owner;',
	subpath:
		'import { resolveCurrentEpochAuthorizedAuthor, openCurrentEpochAuthorAuthorization } from "./anchor-trust-singleton.js"; export { resolveCurrentEpochAuthorizedAuthor, openCurrentEpochAuthorAuthorization }; export type { CurrentEpochAuthorAuthorization } from "./index.js";',
});
