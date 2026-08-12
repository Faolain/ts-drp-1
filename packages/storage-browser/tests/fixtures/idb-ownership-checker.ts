import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const IDB_ADAPTER_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/idb-adapter.ts");
const SCHEMA_IDB_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/schema-idb.ts");
const ISSUANCE_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/browser-issuance-store.ts");
const ISSUANCE_TEST_CONTROL_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/issuance-test-control.ts");
const STRICT_MUTATION_OWNERS = new Set([IDB_ADAPTER_OWNER, SCHEMA_IDB_OWNER]);
const DEFAULT_OWNER_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		IDB_ADAPTER_OWNER,
		new Set([
			"open",
			"transaction",
			"objectStore",
			"get",
			"getKey",
			"getAll",
			"bound",
			"add",
			"put",
			"abort",
			"close",
			"addEventListener",
		]),
	],
	[
		SCHEMA_IDB_OWNER,
		new Set([
			"open",
			"createObjectStore",
			"createIndex",
			"transaction",
			"objectStore",
			"index",
			"count",
			"abort",
			"close",
			"addEventListener",
		]),
	],
	[
		ISSUANCE_OWNER,
		new Set([
			"open",
			"createObjectStore",
			"transaction",
			"objectStore",
			"get",
			"getAll",
			"add",
			"put",
			"delete",
			"abort",
			"close",
			"addEventListener",
		]),
	],
	[ISSUANCE_TEST_CONTROL_OWNER, new Set(["open", "transaction", "objectStore", "add", "close", "addEventListener"])],
	[
		path.join(PACKAGE_DIRECTORY, "tests/opfs-idb-spike/assets/strict-idb-harness.ts"),
		new Set([
			"open",
			"createObjectStore",
			"deleteDatabase",
			"transaction",
			"objectStore",
			"add",
			"count",
			"get",
			"abort",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/opfs-idb-spike/assets/substrate-bench-worker.ts"),
		new Set([
			"open",
			"createObjectStore",
			"deleteDatabase",
			"transaction",
			"objectStore",
			"get",
			"put",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/opfs-idb-spike/assets/bucket-clear-harness.ts"),
		new Set([
			"open",
			"createObjectStore",
			"deleteDatabase",
			"databases",
			"transaction",
			"objectStore",
			"put",
			"get",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/assets/schema-lifecycle-entry.ts"),
		new Set([
			"open",
			"deleteDatabase",
			"databases",
			"createObjectStore",
			"createIndex",
			"transaction",
			"objectStore",
			"index",
			"add",
			"count",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/fixtures/idb-adapter-browser-oracle.ts"),
		new Set([
			"open",
			"databases",
			"createObjectStore",
			"deleteDatabase",
			"transaction",
			"objectStore",
			"get",
			"getAll",
			"count",
			"put",
			"delete",
			"call",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2g-b-presence-entry.ts"),
		new Set(["open", "deleteDatabase", "transaction", "objectStore", "put", "addEventListener", "close"]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2l-b-browser-issuance-entry.ts"),
		new Set([
			"open",
			"deleteDatabase",
			"databases",
			"createObjectStore",
			"transaction",
			"objectStore",
			"add",
			"map",
			"addEventListener",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2l-b-browser-death-worker.ts"),
		new Set(["addEventListener", "abort"]),
	],
]);

export interface IdbOwnershipAuditOptions {
	readonly ownerMethods?: ReadonlyMap<string, readonly string[]>;
	readonly rootNames?: readonly string[];
}

function isIdbDomType(typeName: string): boolean {
	return /\bIDB[A-Z][A-Za-z0-9_]*/u.test(typeName);
}

function exported(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
	);
}

/**
 * Audits raw IndexedDB ownership in one bounded TypeScript Program.
 * @param options - Optional bounded synthetic roots and owner allowlists.
 * @returns Closed violation descriptions.
 */
export function auditIdbOwnership(options: IdbOwnershipAuditOptions = {}): readonly string[] {
	const configPath = path.join(PACKAGE_DIRECTORY, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) return [ts.flattenDiagnosticMessageText(config.error.messageText, "\n")];
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_DIRECTORY);
	const governedRootNames = options.rootNames ?? parsed.fileNames;
	const ownerMethods =
		options.ownerMethods === undefined
			? DEFAULT_OWNER_METHODS
			: new Map([...options.ownerMethods].map(([owner, methods]) => [path.resolve(owner), new Set(methods)] as const));
	const program = ts.createProgram({ rootNames: [...governedRootNames], options: { ...parsed.options, noEmit: true } });
	const checker = program.getTypeChecker();
	const violations: string[] = [];
	const stringValue = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined => {
		if (ts.isStringLiteral(expression)) return expression.text;
		if (
			ts.isParenthesizedExpression(expression) ||
			ts.isAsExpression(expression) ||
			ts.isSatisfiesExpression(expression)
		) {
			return stringValue(expression.expression, seen);
		}
		if (!ts.isIdentifier(expression)) return undefined;
		const symbol = checker.getSymbolAtLocation(expression);
		if (symbol === undefined || seen.has(symbol)) return undefined;
		seen.add(symbol);
		const declaration = symbol.valueDeclaration;
		return declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer !== undefined &&
			declaration.parent.flags & ts.NodeFlags.Const
			? stringValue(declaration.initializer, seen)
			: undefined;
	};
	const isStrictDurability = (expression: ts.Expression): boolean => stringValue(expression) === "strict";
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		if (diagnostic.file && governedRootNames.includes(diagnostic.file.fileName)) {
			violations.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		}
	}
	for (const source of program.getSourceFiles()) {
		if (!governedRootNames.includes(source.fileName)) continue;
		const normalized = path.resolve(source.fileName);
		const enforceProductionStrictMutation =
			options.ownerMethods !== undefined || STRICT_MUTATION_OWNERS.has(normalized);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				if (ts.isElementAccessExpression(node.expression)) {
					const receiver = checker.typeToString(checker.getTypeAtLocation(node.expression.expression));
					if (isIdbDomType(receiver)) {
						violations.push(`${normalized}: unsupported computed IDB call`);
					}
				} else if (ts.isPropertyAccessExpression(node.expression)) {
					const receiver = checker.typeToString(checker.getTypeAtLocation(node.expression.expression));
					if (isIdbDomType(receiver)) {
						if (enforceProductionStrictMutation && node.expression.name.text === "transaction") {
							const modeExpression = node.arguments[1];
							const mode = modeExpression === undefined ? "readonly" : stringValue(modeExpression);
							if (mode !== "readonly" && mode !== "readwrite") {
								violations.push(`${normalized}: unsupported IDB transaction mode`);
							} else if (mode === "readwrite") {
								const options = node.arguments[2];
								const strictDurability =
									options !== undefined &&
									ts.isObjectLiteralExpression(options) &&
									options.properties.some(
										(property) =>
											ts.isPropertyAssignment(property) &&
											property.name.getText(source) === "durability" &&
											isStrictDurability(property.initializer)
									);
								if (!strictDurability) {
									violations.push(`${normalized}: readwrite IDB transaction does not request strict durability`);
								}
							}
						}
						const methods = ownerMethods.get(normalized);
						if (methods === undefined) {
							violations.push(`${normalized}: raw IDB call ${node.expression.name.text} outside an owner`);
						} else if (!methods.has(node.expression.name.text)) {
							violations.push(`${normalized}: IDB call ${node.expression.name.text} is not allowed for owner`);
						}
					}
				}
			}
			if (exported(node)) {
				let rawTypeEscapes = isIdbDomType(checker.typeToString(checker.getTypeAtLocation(node)));
				const inspectExportSignature = (child: ts.Node): void => {
					if (ts.isBlock(child)) return;
					if (ts.isTypeNode(child) && isIdbDomType(checker.typeToString(checker.getTypeAtLocation(child)))) {
						rawTypeEscapes = true;
					}
					ts.forEachChild(child, inspectExportSignature);
				};
				inspectExportSignature(node);
				if (rawTypeEscapes) {
					violations.push(`${normalized}: raw IDB type escapes its owner`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return Object.freeze(violations);
}
