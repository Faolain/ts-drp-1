import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const SOURCE_DIRECTORY = path.join(PACKAGE_DIRECTORY, "src");
const INTERNAL_DIRECTORY = path.join(SOURCE_DIRECTORY, "internal");
const IDB_ADAPTER_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/idb-adapter.ts");
const SCHEMA_IDB_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/schema-idb.ts");
const ISSUANCE_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/browser-issuance-store.ts");
const ISSUANCE_TEST_CONTROL_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/issuance-test-control.ts");
const LIVE_JOURNAL_OWNER = path.join(PACKAGE_DIRECTORY, "src/live-journal.ts");
const SEAL_VOTE_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/seal-vote-store.ts");
const SEAL_VOTE_TEST_CONTROL_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/seal-vote-test-control.ts");
const SNAPSHOT_TRANSFER_OWNER = path.join(PACKAGE_DIRECTORY, "src/snapshot-transfer.ts");
const AHE_RECLAMATION_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/ahe-reclamation.ts");
const NATIVE_READ_RESERVATION_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/native-read-reservation.ts");
const RETIREMENT_CONTROL_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/retirement-control.ts");
const SEAL_EVIDENCE_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/seal-evidence-store.ts");
const SIGNING_BACKEND_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/signing-backend.ts");
const SIGNING_RETIREMENT_OWNER = path.join(PACKAGE_DIRECTORY, "src/internal/signing-retirement.ts");
const ROOM_HEAD_OWNER = path.join(PACKAGE_DIRECTORY, "src/room-head.ts");
const STRICT_MUTATION_OWNERS = new Set([
	IDB_ADAPTER_OWNER,
	SCHEMA_IDB_OWNER,
	SEAL_VOTE_OWNER,
	AHE_RECLAMATION_OWNER,
	NATIVE_READ_RESERVATION_OWNER,
	RETIREMENT_CONTROL_OWNER,
	SEAL_EVIDENCE_OWNER,
	SIGNING_BACKEND_OWNER,
	SIGNING_RETIREMENT_OWNER,
	ROOM_HEAD_OWNER,
]);
// Raw-IDB ownership governs production modules only (test harnesses drive
// IndexedDB directly and are type-checked, not owner-governed). Each owner may
// call exactly these methods on receivers whose type names a raw IDB type.
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
			"deref",
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
			"add",
			"abort",
			"close",
			"addEventListener",
			"getAll",
			"openCursor",
			"openKeyCursor",
			"continue",
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
			"getKey",
			"getAll",
			"count",
			"openCursor",
			"continue",
			"add",
			"put",
			"delete",
			"abort",
			"close",
			"addEventListener",
			"bound",
			"lowerBound",
			"deref",
			"every",
			"has",
		]),
	],
	[ISSUANCE_TEST_CONTROL_OWNER, new Set(["open", "transaction", "objectStore", "add", "close", "addEventListener"])],
	[
		LIVE_JOURNAL_OWNER,
		new Set([
			"abort",
			"add",
			"addEventListener",
			"bound",
			"close",
			"cmp",
			"continue",
			"count",
			"createIndex",
			"createObjectStore",
			"delete",
			"deref",
			"get",
			"getAll",
			"getKey",
			"has",
			"index",
			"lowerBound",
			"objectStore",
			"open",
			"openCursor",
			"put",
			"set",
			"transaction",
			"update",
		]),
	],
	[
		SNAPSHOT_TRANSFER_OWNER,
		new Set([
			"abort",
			"add",
			"addEventListener",
			"bound",
			"close",
			"continue",
			"count",
			"createIndex",
			"createObjectStore",
			"delete",
			"every",
			"get",
			"getAll",
			"getAllKeys",
			"getKey",
			"index",
			"map",
			"objectStore",
			"open",
			"openCursor",
			"put",
			"transaction",
			"update",
			"upperBound",
		]),
	],
	[
		SEAL_VOTE_OWNER,
		new Set([
			"abort",
			"add",
			"addEventListener",
			"bound",
			"close",
			"continue",
			"delete",
			"get",
			"getAll",
			"map",
			"objectStore",
			"openCursor",
			"openKeyCursor",
			"push",
			"put",
			"slice",
			"transaction",
		]),
	],
	[
		SEAL_VOTE_TEST_CONTROL_OWNER,
		new Set([
			"abort",
			"add",
			"addEventListener",
			"apply",
			"close",
			"count",
			"createObjectStore",
			"objectStore",
			"open",
			"transaction",
		]),
	],
	[
		AHE_RECLAMATION_OWNER,
		new Set([
			"abort",
			"acquireRecoveryTurn",
			"addEventListener",
			"commit",
			"delete",
			"finishOperation",
			"get",
			"getAll",
			"getKey",
			"isClosed",
			"isPoisoned",
			"latchPoison",
			"objectStore",
			"put",
			"startOperation",
			"transaction",
		]),
	],
	[
		NATIVE_READ_RESERVATION_OWNER,
		new Set([
			"abort",
			"addEventListener",
			"bound",
			"get",
			"getAll",
			"getAllKeys",
			"getKey",
			"has",
			"lowerBound",
			"objectStore",
			"set",
			"transaction",
		]),
	],
	[
		RETIREMENT_CONTROL_OWNER,
		new Set([
			"add",
			"addEventListener",
			"bound",
			"every",
			"flatMap",
			"get",
			"getAll",
			"getAllKeys",
			"getKey",
			"objectStore",
			"put",
		]),
	],
	[SEAL_EVIDENCE_OWNER, new Set(["abort", "addEventListener", "get", "getAll", "objectStore", "put", "transaction"])],
	[SIGNING_BACKEND_OWNER, new Set(["addEventListener", "close", "get", "objectStore", "transaction"])],
	[
		SIGNING_RETIREMENT_OWNER,
		new Set([
			"abort",
			"addEventListener",
			"bound",
			"close",
			"delete",
			"get",
			"getAllKeys",
			"objectStore",
			"put",
			"transaction",
		]),
	],
	[
		ROOM_HEAD_OWNER,
		new Set([
			"abort",
			"addEventListener",
			"close",
			"count",
			"createObjectStore",
			"delete",
			"get",
			"getAllKeys",
			"includes",
			"objectStore",
			"open",
			"put",
			"transaction",
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
	// The package typecheck program: tsconfig.json plus repo-root fixtures and sibling sources.
	const configPath = path.join(PACKAGE_DIRECTORY, "tsconfig.typecheck.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) return [ts.flattenDiagnosticMessageText(config.error.messageText, "\n")];
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_DIRECTORY);
	const governedRootNames = options.rootNames ?? parsed.fileNames;
	const ownershipRootNames =
		options.rootNames ??
		governedRootNames.filter((fileName) => path.resolve(fileName).startsWith(`${SOURCE_DIRECTORY}${path.sep}`));
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
		// The package typecheck owns composite-project file-list diagnostics; this bounded program owns raw-IDB use.
		if (diagnostic.file && diagnostic.code !== 6307 && governedRootNames.includes(diagnostic.file.fileName)) {
			violations.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		}
	}
	for (const source of program.getSourceFiles()) {
		if (!ownershipRootNames.includes(source.fileName)) continue;
		const normalized = path.resolve(source.fileName);
		// Internal owners hand raw IDB handles to sibling owners; only modules
		// outside src/internal must keep raw IDB types out of exported signatures.
		const internalOwner =
			options.ownerMethods === undefined &&
			ownerMethods.has(normalized) &&
			normalized.startsWith(`${INTERNAL_DIRECTORY}${path.sep}`);
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
				if (rawTypeEscapes && !internalOwner) {
					violations.push(`${normalized}: raw IDB type escapes its owner`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return Object.freeze(violations);
}
