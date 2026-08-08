import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const DEFAULT_OWNER_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		path.join(PACKAGE_DIRECTORY, "src/internal/instrumented-idb.ts"),
		new Set([
			"open",
			"createObjectStore",
			"transaction",
			"objectStore",
			"add",
			"openCursor",
			"continue",
			"put",
			"commit",
			"close",
		]),
	],
	[
		path.join(PACKAGE_DIRECTORY, "tests/fixtures/oracle-idb.ts"),
		new Set(["open", "transaction", "objectStore", "openCursor", "continue", "close"]),
	],
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
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		if (diagnostic.file && governedRootNames.includes(diagnostic.file.fileName)) {
			violations.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		}
	}
	for (const source of program.getSourceFiles()) {
		if (!governedRootNames.includes(source.fileName)) continue;
		const normalized = path.resolve(source.fileName);
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
