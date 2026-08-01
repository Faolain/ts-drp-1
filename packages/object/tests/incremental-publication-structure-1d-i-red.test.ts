import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../src");
const WORKSPACE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../../..");
const ROOT_METHODS = new Set(["assignState", "advanceCheckpointIfNeeded"]);
const GLOBALLY_GOVERNED_FILES = new Set(["state.ts", "drp-applier.ts", "proxy.ts"]);
const SERIALIZATION_PRIMITIVES = new Set(["serializeValue", "serializeDRPState", "deserializeDRPState"]);
const RESIDUAL_CLONE_SITES = new Set([
	"state.ts:DRPObjectStateManager.constructor:cloneDeep(drp?.context)",
	"state.ts:DRPObjectStateManager.constructor:cloneDeep(acl.context)",
	"state.ts:DRPObjectStateManager.fromStates:cloneDeep(aclContext)",
	"state.ts:DRPObjectStateManager.fromStates:cloneDeep(drpContext)",
	"state.ts:DRPObjectStateManager.fromHashACL:cloneDeep(this.aclContext)",
	"state.ts:DRPObjectStateManager.applyState:cloneDeep(entry.value)",
	"state.ts:<module>.stateFromDRP:cloneDeep(drp[key])",
	"drp-applier.ts:<module>.captureBatchVertexOperation:cloneDeep(submittedVertex.operation)",
	"drp-applier.ts:<module>.cloneEnumerableInstance:cloneDeep(sourceRecord[key])",
	"drp-applier.ts:DRPVertexApplier.createVertex:cloneDeep(value)",
	"drp-applier.ts:<module>.callDRP:cloneDeep(args)",
]);
const RESIDUAL_STATE_CAPTURE_SITES = new Set([
	"state.ts:DRPObjectStateManager.constructor:stateFromDRP(drp)",
	"state.ts:DRPObjectStateManager.constructor:stateFromDRP(acl)",
	"drp-applier.ts:DRPVertexApplier.computeOperationUntraced:stateFromDRP(this.drp)",
	"drp-applier.ts:DRPVertexApplier.computeOperationUntraced:stateFromDRP(this.acl)",
]);
const REQUIRED_WORKSPACE_SOURCE_PATHS = [
	"packages/object/src/drp-applier.ts",
	"packages/object/src/index.ts",
	"packages/utils/src/serialization/index.ts",
] as const;
const REVIEWED_WORKSPACE_OPERATIONS = [
	"packages/object/src/drp-applier.ts:DRPVertexApplier.copyPublicationPayload:clone",
	"packages/object/src/index.ts:DRPObject.getStates:clone",
	"packages/object/src/index.ts:DRPObject.setACLState:clone",
	"packages/object/src/index.ts:DRPObject.setDRPState:clone",
	"packages/utils/src/serialization/index.ts:<module>.serializeValue:serialization",
] as const;

interface FunctionNode {
	readonly body: ts.Block;
	readonly className?: string;
	readonly declaration: ts.FunctionLikeDeclaration;
	readonly file: ts.SourceFile;
	readonly id: string;
	readonly name: string;
}

interface CallSite {
	readonly directSelfCall: boolean;
	readonly localName?: string;
	readonly targetClass?: string;
	readonly targetFile?: string;
}

interface ClosureAnalysis {
	readonly injectedCopyLeaves: string[];
	readonly reachable: string[];
	readonly residualCloneSites: string[];
	readonly violations: string[];
}

interface WorkspaceIntegrationCensus {
	readonly analyzedSourcePaths?: readonly string[];
	readonly reviewedOperations?: readonly string[];
}

type ForbiddenPrimitive =
	| "cloneDeep"
	| "structuredClone"
	| "json"
	| "stateFromDRP"
	| "serializeValue"
	| "serialization";

function sourceFiles(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(result, sourceFiles(absolute));
		else if (entry.isFile() && entry.name.endsWith(".ts"))
			result[path.relative(SOURCE_DIRECTORY, absolute)] = fs.readFileSync(absolute, "utf8");
	}
	return result;
}

function normalizedWorkspaceSourceFiles(directories: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	const collect = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) collect(absolute);
			else if (entry.isFile() && entry.name.endsWith(".ts")) {
				result[path.relative(WORKSPACE_DIRECTORY, absolute).split(path.sep).join(path.posix.sep)] = fs.readFileSync(
					absolute,
					"utf8"
				);
			}
		}
	};
	for (const directory of directories) collect(directory);
	return result;
}

function realGovernedWorkspaceSources(): Record<string, string> {
	const packagesDirectory = path.join(WORKSPACE_DIRECTORY, "packages");
	const sourceDirectories = fs
		.readdirSync(packagesDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(packagesDirectory, entry.name, "src"))
		.filter((directory) => fs.existsSync(directory));
	return normalizedWorkspaceSourceFiles(sourceDirectories);
}

function expectWorkspaceIntegration(
	loadedSources: Readonly<Record<string, string>>,
	analysis: ClosureAnalysis & WorkspaceIntegrationCensus
): void {
	const loadedSourcePaths = Object.keys(loadedSources).sort();
	expect(loadedSourcePaths).toEqual(expect.arrayContaining([...REQUIRED_WORKSPACE_SOURCE_PATHS]));
	expect([...(analysis.analyzedSourcePaths ?? [])].sort()).toEqual(loadedSourcePaths);
	expect([...(analysis.reviewedOperations ?? [])].sort()).toEqual([...REVIEWED_WORKSPACE_OPERATIONS].sort());
	for (const reviewed of REVIEWED_WORKSPACE_OPERATIONS) {
		const [file, owner] = reviewed.split(":");
		expect(analysis.violations.some((violation) => violation.includes(file) && violation.includes(owner))).toBe(false);
	}
}

function functions(files: readonly ts.SourceFile[]): FunctionNode[] {
	const result: FunctionNode[] = [];
	for (const file of files) {
		const visit = (node: ts.Node, className?: string): void => {
			if (ts.isClassDeclaration(node)) {
				const nextClass = node.name?.text ?? `<anonymous@${node.pos}>`;
				for (const child of node.members) visit(child, nextClass);
				return;
			}
			if (ts.isConstructorDeclaration(node) && node.body) {
				result.push({
					body: node.body,
					className,
					declaration: node,
					file,
					id: `${file.fileName}:${className ?? "<module>"}.constructor@${node.pos}`,
					name: "constructor",
				});
			} else if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body) {
				const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file);
				result.push({
					body: node.body,
					className,
					declaration: node,
					file,
					id: `${file.fileName}:${className ?? "<module>"}.${name}@${node.pos}`,
					name,
				});
			}
			ts.forEachChild(node, (child) => visit(child, className));
		};
		visit(file);
	}
	return result;
}

function classPropertyTargets(files: readonly ts.SourceFile[]): Map<string, string> {
	const targets = new Map<string, string>();
	for (const file of files) {
		const visit = (node: ts.Node, className?: string): void => {
			if (ts.isClassDeclaration(node)) {
				const nextClass = node.name?.text ?? `<anonymous@${node.pos}>`;
				for (const child of node.members) visit(child, nextClass);
				return;
			}
			if (className && ts.isPropertyDeclaration(node) && node.name && node.type) {
				const property = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
				const type = node.type.getText(file).match(/[A-Za-z_$][\w$]*/)?.[0];
				if (property && type) targets.set(`${className}:${property}`, type);
			}
			ts.forEachChild(node, (child) => visit(child, className));
		};
		visit(file);
	}
	return targets;
}

function importedTargets(files: readonly ts.SourceFile[]): Map<string, string> {
	const targets = new Map<string, string>();
	for (const file of files) {
		for (const statement of file.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const specifier = statement.moduleSpecifier.text;
			if (!specifier.startsWith(".")) continue;
			const target = path.posix
				.normalize(path.posix.join(path.posix.dirname(file.fileName), specifier))
				.replace(/\.js$/, ".ts");
			for (const element of statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings)
				? statement.importClause.namedBindings.elements
				: []) {
				targets.set(`${file.fileName}:${element.name.text}`, target);
			}
		}
	}
	return targets;
}

function calls(
	candidate: FunctionNode,
	properties: ReadonlyMap<string, string>,
	imports: ReadonlyMap<string, string>
): CallSite[] {
	const result: CallSite[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			let localName: string | undefined;
			let targetClass: string | undefined;
			let targetFile: string | undefined;
			let directSelfCall = false;
			if (ts.isIdentifier(expression)) {
				localName = expression.text;
				targetFile = imports.get(`${candidate.file.fileName}:${localName}`) ?? candidate.file.fileName;
				directSelfCall = localName === candidate.name;
			} else if (ts.isPropertyAccessExpression(expression)) {
				localName = expression.name.text;
				if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
					targetClass = candidate.className;
					directSelfCall = localName === candidate.name;
				} else if (
					ts.isPropertyAccessExpression(expression.expression) &&
					expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
					candidate.className
				) {
					targetClass = properties.get(`${candidate.className}:${expression.expression.name.text}`);
				}
			}
			result.push({
				directSelfCall,
				localName,
				targetClass,
				targetFile,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(candidate.body);
	return result;
}

function ownerLabel(node: FunctionNode | undefined): string {
	return node ? `${node.file.fileName}:${node.className ?? "<module>"}.${node.name}` : "<top-level>";
}

function ownerFor(node: ts.Node, candidates: readonly FunctionNode[]): FunctionNode | undefined {
	return candidates
		.filter(
			(candidate) =>
				candidate.file === node.getSourceFile() && candidate.body.pos <= node.pos && candidate.body.end >= node.end
		)
		.sort((left, right) => left.body.end - left.body.pos - (right.body.end - right.body.pos))[0];
}

function normalizedCall(node: ts.CallExpression): string {
	return node.getText(node.getSourceFile()).replace(/\s+/g, "");
}

function importedForbiddenBindings(file: ts.SourceFile): {
	bindings: ReadonlyMap<string, ForbiddenPrimitive>;
	namespaces: ReadonlySet<string>;
} {
	const bindings = new Map<string, ForbiddenPrimitive>();
	const namespaces = new Set<string>();
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const moduleName = statement.moduleSpecifier.text;
		const namedBindings = statement.importClause?.namedBindings;
		if (namedBindings && ts.isNamespaceImport(namedBindings) && /serialization/.test(moduleName)) {
			namespaces.add(namedBindings.name.text);
		}
		if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
		for (const element of namedBindings.elements) {
			const imported = element.propertyName?.text ?? element.name.text;
			const primitive: ForbiddenPrimitive | undefined =
				imported === "cloneDeep"
					? "cloneDeep"
					: imported === "stateFromDRP"
						? "stateFromDRP"
						: imported === "serializeValue"
							? "serializeValue"
							: SERIALIZATION_PRIMITIVES.has(imported)
								? "serialization"
								: undefined;
			if (primitive) bindings.set(element.name.text, primitive);
		}
	}
	return { bindings, namespaces };
}

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return node.argumentExpression &&
		(ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
		? node.argumentExpression.text
		: undefined;
}

function forbiddenReference(
	node: ts.Expression,
	bindings: ReadonlyMap<string, ForbiddenPrimitive>,
	namespaces: ReadonlySet<string>
): ForbiddenPrimitive | undefined {
	if (ts.isIdentifier(node)) {
		if (node.text === "structuredClone") return "structuredClone";
		if (node.text === "JSON") return "json";
		if (node.text === "stateFromDRP" && !bindings.has(node.text)) return "stateFromDRP";
		return bindings.get(node.text);
	}
	if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
	const name = propertyName(node);
	const receiver = node.expression.getText(node.getSourceFile()).replace(/\s+/g, "");
	if (name === "structuredClone" && receiver === "globalThis") return "structuredClone";
	if ((name === "parse" || name === "stringify") && (receiver === "JSON" || receiver === "globalThis.JSON")) {
		return "json";
	}
	if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && name) {
		if (name === "serializeValue") return "serializeValue";
		if (SERIALIZATION_PRIMITIVES.has(name)) return "serialization";
	}
	return undefined;
}

function isDeclarationOrImportName(node: ts.Identifier): boolean {
	let current: ts.Node | undefined = node;
	while (current) {
		if (ts.isImportDeclaration(current)) return true;
		current = current.parent;
	}
	const parent = node.parent;
	return Boolean(
		parent &&
			(ts.isFunctionDeclaration(parent) ||
				ts.isMethodDeclaration(parent) ||
				ts.isClassDeclaration(parent) ||
				ts.isVariableDeclaration(parent) ||
				ts.isParameter(parent) ||
				ts.isPropertyDeclaration(parent)) &&
			parent.name === node
	);
}

function reachableFrom(
	starts: readonly FunctionNode[],
	nodes: readonly FunctionNode[],
	properties: ReadonlyMap<string, string>,
	imports: ReadonlyMap<string, string>
): Map<string, FunctionNode> {
	const byName = new Map<string, FunctionNode[]>();
	for (const node of nodes) byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
	const reachable = new Map<string, FunctionNode>();
	const pending = [...starts];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node || reachable.has(node.id)) continue;
		reachable.set(node.id, node);
		for (const call of calls(node, properties, imports)) {
			if (!call.localName) continue;
			const candidates = (byName.get(call.localName) ?? []).filter((candidate) => {
				if (call.targetClass) return candidate.className === call.targetClass;
				if (call.targetFile) return candidate.className === undefined && candidate.file.fileName === call.targetFile;
				return false;
			});
			pending.push(...candidates);
		}
	}
	return reachable;
}

function globalViolations(
	files: readonly ts.SourceFile[],
	nodes: readonly FunctionNode[],
	reachable: ReadonlyMap<string, FunctionNode>,
	leafIds: ReadonlySet<string>
): { residualCloneSites: string[]; violations: string[] } {
	const violations: string[] = [];
	const residualCloneSites: string[] = [];
	const rootIds = new Set([...reachable.values()].filter(({ name }) => ROOT_METHODS.has(name)).map(({ id }) => id));
	const scan = (scanRoot: ts.Node): void => {
		const file = scanRoot.getSourceFile();
		const { bindings, namespaces } = importedForbiddenBindings(file);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const primitive = forbiddenReference(node.expression, bindings, namespaces);
				if (primitive) {
					const owner = ownerFor(node, nodes);
					const site = `${ownerLabel(owner)}:${normalizedCall(node)}`;
					if (primitive === "cloneDeep") {
						if (leafIds.has(owner?.id ?? "")) {
							// The single observed copy leaf owns any production detachment primitive.
						} else if (RESIDUAL_CLONE_SITES.has(site)) {
							residualCloneSites.push(site);
						} else {
							violations.push(`${site} relocates cloneDeep outside the exact residual allowlist or copy leaf`);
						}
					} else if (primitive === "stateFromDRP") {
						if (
							!rootIds.has(owner?.id ?? "") &&
							!leafIds.has(owner?.id ?? "") &&
							!RESIDUAL_STATE_CAPTURE_SITES.has(site)
						) {
							violations.push(`${site} relocates stateFromDRP outside its accepted residual or governed owner`);
						}
					} else if (
						primitive !== "serializeValue" ||
						!leafIds.has(owner?.id ?? "") ||
						!ts.isPropertyAccessExpression(node.parent) ||
						node.parent.expression !== node ||
						node.parent.name.text !== "byteLength"
					) {
						violations.push(`${site} uses ${primitive} outside pinned copy-leaf byte accounting`);
					}
					for (const argument of node.arguments) visit(argument);
					return;
				}
			}
			if (
				(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				(!ts.isIdentifier(node) || !isDeclarationOrImportName(node))
			) {
				const primitive = forbiddenReference(node as ts.Expression, bindings, namespaces);
				if (primitive) {
					const owner = ownerFor(node, nodes);
					violations.push(`${ownerLabel(owner)}:${node.getText(file)} aliases or escapes forbidden ${primitive}`);
					return;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(scanRoot);
	};

	const globallyScanned = new Set<ts.SourceFile>();
	for (const file of files) {
		if (!GLOBALLY_GOVERNED_FILES.has(file.fileName)) continue;
		globallyScanned.add(file);
		scan(file);
	}
	for (const node of reachable.values()) {
		if (!globallyScanned.has(node.file)) scan(node.body);
	}
	return {
		residualCloneSites: residualCloneSites.sort(),
		violations: [...new Set(violations)].sort(),
	};
}

function analyzeLegacy(sources: Readonly<Record<string, string>>): ClosureAnalysis {
	const files = Object.entries(sources).map(([name, source]) =>
		ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	);
	const nodes = functions(files);
	const properties = classPropertyTargets(files);
	const imports = importedTargets(files);
	const roots = nodes.filter(({ name }) => ROOT_METHODS.has(name));
	const reachableByRoot = new Map(
		[...ROOT_METHODS].map((root) => [
			root,
			reachableFrom(
				roots.filter(({ name }) => name === root),
				nodes,
				properties,
				imports
			),
		])
	);
	const reachable = new Map<string, FunctionNode>();
	for (const closure of reachableByRoot.values()) {
		for (const [id, node] of closure) reachable.set(id, node);
	}

	const violations: string[] = [];
	for (const root of ROOT_METHODS) {
		if (!roots.some(({ name }) => name === root)) violations.push(`missing publication root ${root}`);
	}
	const injectedLeaves = [...reachable.values()].filter((node) =>
		/(?:type|kind)\s*:\s*["']copy["']/.test(node.body.getText(node.file))
	);
	if (injectedLeaves.length !== 1) {
		violations.push(`expected one observable injected copy leaf, found ${injectedLeaves.length}`);
	}
	const leafIds = new Set(injectedLeaves.map(({ id }) => id));
	if (injectedLeaves.length === 1) {
		for (const [root, closure] of reachableByRoot) {
			if (!closure.has(injectedLeaves[0].id)) violations.push(`${root} does not reach the unique injected copy leaf`);
		}
	}
	for (const node of reachable.values()) {
		const nodeCalls = calls(node, properties, imports);
		for (const call of nodeCalls) {
			if (call.localName === "stateFromDRP") violations.push(`${node.id} bypasses accounting through stateFromDRP`);
			if (["cloneDeep", "structuredClone"].includes(call.localName ?? "") && !leafIds.has(node.id)) {
				violations.push(`${node.id} detaches payload outside the injected copy leaf`);
			}
			if (["serializeDRPState", "deserializeDRPState"].includes(call.localName ?? "")) {
				violations.push(`${node.id} uses serialization as a clone`);
			}
			if (call.localName === "serializeValue" && !/\.byteLength\b/.test(node.body.getText(node.file))) {
				violations.push(`${node.id} uses serialization as a clone`);
			}
			if (call.directSelfCall && !leafIds.has(node.id)) {
				violations.push(`${node.id} is an unapproved recursive helper`);
			}
		}
		if (/JSON\.(?:parse|stringify)\s*\(/.test(node.body.getText(node.file))) {
			violations.push(`${node.id} uses a JSON round trip`);
		}
	}
	const global = globalViolations(files, nodes, reachable, leafIds);
	violations.push(...global.violations);
	return {
		injectedCopyLeaves: injectedLeaves.map(({ id }) => id).sort(),
		reachable: [...reachable.keys()].sort(),
		residualCloneSites: global.residualCloneSites,
		violations: [...new Set(violations)].sort(),
	};
}

type SemanticPrimitive = "cloneDeep" | "structuredClone" | "serialization" | "json" | "stateFromDRP";
type SemanticTarget = `function:${string}` | `primitive:${SemanticPrimitive}`;

interface ImportBinding {
	readonly exportName: string;
	readonly moduleName?: string;
	readonly primitive?: SemanticPrimitive;
}

interface SemanticModule {
	readonly exports: ReadonlyMap<string, ImportBinding | SemanticTarget>;
	readonly imports: ReadonlyMap<string, ImportBinding>;
	readonly namespaces: ReadonlyMap<string, string>;
}

interface SemanticOperation {
	readonly call: ts.CallExpression;
	readonly owner: FunctionNode;
	readonly primitive: SemanticPrimitive;
}

function resolveModuleName(fromFile: string, specifier: string, sourceNames: ReadonlySet<string>): string | undefined {
	let stem: string;
	if (specifier.startsWith(".")) {
		stem = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)).replace(/\.js$/, "");
	} else {
		const workspace = specifier.match(/^@ts-drp\/([^/]+)(?:\/(.*))?$/);
		if (!workspace) return undefined;
		stem = `packages/${workspace[1]}/src/${workspace[2] ?? "index"}`;
	}
	for (const candidate of [stem, `${stem}.ts`, `${stem}/index.ts`]) {
		if (sourceNames.has(candidate)) return candidate;
	}
	return undefined;
}

function importedPrimitive(moduleName: string, importedName: string): SemanticPrimitive | undefined {
	if (moduleName === "es-toolkit" && importedName === "cloneDeep") return "cloneDeep";
	if (moduleName === "@msgpack/msgpack" && (importedName === "encode" || importedName === "decode")) {
		return "serialization";
	}
	if (importedName === "stateFromDRP") return "stateFromDRP";
	if (SERIALIZATION_PRIMITIVES.has(importedName)) return "serialization";
	return undefined;
}

function semanticModules(
	files: readonly ts.SourceFile[],
	nodes: readonly FunctionNode[]
): ReadonlyMap<string, SemanticModule> {
	const sourceNames = new Set(files.map(({ fileName }) => fileName));
	const functionsByFileAndName = new Map<string, FunctionNode>();
	for (const node of nodes) {
		if (!node.className) functionsByFileAndName.set(`${node.file.fileName}:${node.name}`, node);
	}
	const result = new Map<string, SemanticModule>();
	for (const file of files) {
		const imports = new Map<string, ImportBinding>();
		const namespaces = new Map<string, string>();
		const exports = new Map<string, ImportBinding | SemanticTarget>();
		for (const statement of file.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
				const specifier = statement.moduleSpecifier.text;
				const moduleName = resolveModuleName(file.fileName, specifier, sourceNames);
				const clause = statement.importClause;
				if (clause?.name) {
					imports.set(clause.name.text, {
						exportName: "default",
						moduleName,
						primitive: moduleName ? undefined : importedPrimitive(specifier, "default"),
					});
				}
				const bindings = clause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings) && moduleName) {
					namespaces.set(bindings.name.text, moduleName);
				} else if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						const importedName = element.propertyName?.text ?? element.name.text;
						imports.set(element.name.text, {
							exportName: importedName,
							moduleName,
							primitive: moduleName ? undefined : importedPrimitive(specifier, importedName),
						});
					}
				}
				continue;
			}
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				const node = functionsByFileAndName.get(`${file.fileName}:${statement.name.text}`);
				if (node && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
					exports.set(
						statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)
							? "default"
							: statement.name.text,
						`function:${node.id}`
					);
				}
				continue;
			}
			if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				const specifier =
					statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
						? statement.moduleSpecifier.text
						: undefined;
				const moduleName = specifier ? resolveModuleName(file.fileName, specifier, sourceNames) : file.fileName;
				for (const element of statement.exportClause.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;
					exports.set(element.name.text, {
						exportName: importedName,
						moduleName,
						primitive: specifier && !moduleName ? importedPrimitive(specifier, importedName) : undefined,
					});
				}
			}
		}
		result.set(file.fileName, { exports, imports, namespaces });
	}
	return result;
}

function semanticAnalysis(
	files: readonly ts.SourceFile[],
	nodes: readonly FunctionNode[]
): { reviewedOperations: string[]; violations: string[] } {
	const modules = semanticModules(files, nodes);
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const moduleFunctions = new Map<string, FunctionNode>();
	const classMethods = new Map<string, FunctionNode>();
	const variables = new Map<string, ts.Expression>();
	const classProperties = new Map<string, ts.Expression>();
	const parameterTargets = new Map<string, Map<string, Set<SemanticTarget>>>();
	for (const node of nodes) {
		if (node.className) classMethods.set(`${node.file.fileName}:${node.className}:${node.name}`, node);
		else moduleFunctions.set(`${node.file.fileName}:${node.name}`, node);
		const parameters = new Map<string, Set<SemanticTarget>>();
		for (const parameter of node.declaration.parameters) {
			if (ts.isIdentifier(parameter.name)) parameters.set(parameter.name.text, new Set());
		}
		parameterTargets.set(node.id, parameters);
		const visit = (child: ts.Node): void => {
			if (child !== node.body && ts.isFunctionLike(child)) return;
			if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) {
				variables.set(`${node.id}:${child.name.text}`, child.initializer);
			}
			ts.forEachChild(child, visit);
		};
		visit(node.body);
	}
	for (const file of files) {
		const visit = (child: ts.Node, className?: string): void => {
			if (ts.isClassDeclaration(child)) {
				const nextClass = child.name?.text;
				for (const member of child.members) visit(member, nextClass);
				return;
			}
			if (className && ts.isPropertyDeclaration(child) && child.initializer && child.name) {
				const name = ts.isIdentifier(child.name) || ts.isStringLiteral(child.name) ? child.name.text : undefined;
				if (name) classProperties.set(`${file.fileName}:${className}:${name}`, child.initializer);
			}
		};
		for (const statement of file.statements) visit(statement);
	}

	const exportTargets = (
		moduleName: string,
		exportName: string,
		seen: Set<string> = new Set()
	): Set<SemanticTarget> => {
		const key = `${moduleName}:${exportName}`;
		if (seen.has(key)) return new Set();
		seen.add(key);
		const binding = modules.get(moduleName)?.exports.get(exportName);
		if (typeof binding === "string") return new Set([binding]);
		if (binding?.primitive) return new Set<SemanticTarget>([`primitive:${binding.primitive}`]);
		if (binding?.moduleName) return exportTargets(binding.moduleName, binding.exportName, seen);
		const local = moduleFunctions.get(key);
		return local ? new Set<SemanticTarget>([`function:${local.id}`]) : new Set();
	};
	const expressionTargets = (
		expression: ts.Expression,
		owner: FunctionNode,
		seen: Set<string> = new Set()
	): Set<SemanticTarget> => {
		const expressionKey = `${owner.id}:${expression.pos}:${expression.end}`;
		if (seen.has(expressionKey)) return new Set();
		seen.add(expressionKey);
		if (ts.isParenthesizedExpression(expression)) return expressionTargets(expression.expression, owner, seen);
		if (ts.isIdentifier(expression)) {
			if (expression.text === "structuredClone") return new Set(["primitive:structuredClone"]);
			if (expression.text === "JSON") return new Set(["primitive:json"]);
			const parameter = parameterTargets.get(owner.id)?.get(expression.text);
			if (parameter?.size) return new Set(parameter);
			const variable = variables.get(`${owner.id}:${expression.text}`);
			if (variable) return expressionTargets(variable, owner, seen);
			const imported = modules.get(owner.file.fileName)?.imports.get(expression.text);
			if (imported?.primitive) return new Set<SemanticTarget>([`primitive:${imported.primitive}`]);
			if (imported?.moduleName) return exportTargets(imported.moduleName, imported.exportName);
			const local = moduleFunctions.get(`${owner.file.fileName}:${expression.text}`);
			return local ? new Set<SemanticTarget>([`function:${local.id}`]) : new Set();
		}
		if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
			const name = propertyName(expression);
			if (!name) return new Set();
			if (expression.expression.kind === ts.SyntaxKind.ThisKeyword && owner.className) {
				const method = classMethods.get(`${owner.file.fileName}:${owner.className}:${name}`);
				if (method) return new Set<SemanticTarget>([`function:${method.id}`]);
				const property = classProperties.get(`${owner.file.fileName}:${owner.className}:${name}`);
				return property ? expressionTargets(property, owner, seen) : new Set();
			}
			if (ts.isIdentifier(expression.expression)) {
				const receiver = expression.expression.text;
				if (receiver === "globalThis" && name === "structuredClone") {
					return new Set(["primitive:structuredClone"]);
				}
				if (receiver === "JSON" && (name === "parse" || name === "stringify")) {
					return new Set(["primitive:json"]);
				}
				const namespace = modules.get(owner.file.fileName)?.namespaces.get(receiver);
				if (namespace) return exportTargets(namespace, name);
				const variable = variables.get(`${owner.id}:${receiver}`);
				if (variable && ts.isObjectLiteralExpression(variable)) {
					const property = variable.properties.find(
						(candidate): candidate is ts.PropertyAssignment =>
							ts.isPropertyAssignment(candidate) &&
							(ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
							candidate.name.text === name
					);
					if (property) return expressionTargets(property.initializer, owner, seen);
				}
			}
		}
		return new Set();
	};

	const edges = new Map<string, Set<string>>();
	const operations = new Map<string, SemanticOperation>();
	let changed = true;
	for (let pass = 0; changed && pass < nodes.length + 4; pass++) {
		changed = false;
		for (const owner of nodes) {
			const visit = (node: ts.Node): void => {
				if (node !== owner.body && ts.isFunctionLike(node)) return;
				if (ts.isCallExpression(node)) {
					for (const target of expressionTargets(node.expression, owner)) {
						if (target.startsWith("primitive:")) {
							const primitive = target.slice("primitive:".length) as SemanticPrimitive;
							operations.set(`${owner.id}:${node.pos}:${primitive}`, { call: node, owner, primitive });
							continue;
						}
						const targetId = target.slice("function:".length);
						const ownerEdges = edges.get(owner.id) ?? new Set<string>();
						if (!ownerEdges.has(targetId)) {
							ownerEdges.add(targetId);
							edges.set(owner.id, ownerEdges);
							changed = true;
						}
						const targetNode = nodesById.get(targetId);
						if (!targetNode) continue;
						for (let index = 0; index < targetNode.declaration.parameters.length; index++) {
							const parameter = targetNode.declaration.parameters[index];
							const argument = node.arguments[index];
							if (!argument || !ts.isIdentifier(parameter.name)) continue;
							const targets = parameterTargets.get(targetId)?.get(parameter.name.text);
							if (!targets) continue;
							for (const argumentTarget of expressionTargets(argument, owner)) {
								if (!targets.has(argumentTarget)) {
									targets.add(argumentTarget);
									changed = true;
								}
							}
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(owner.body);
		}
	}

	const rootIds = new Set<string>();
	for (const node of nodes) {
		const base = path.posix.basename(node.file.fileName);
		const globallyGoverned =
			GLOBALLY_GOVERNED_FILES.has(base) &&
			(!node.file.fileName.startsWith("packages/") || node.file.fileName.startsWith("packages/object/src/"));
		const publicationRoot = ROOT_METHODS.has(node.name);
		const ownershipRoot =
			node.className === "DRPObject" &&
			["getStates", "setACLState", "setDRPState"].includes(node.name) &&
			/(?:^|\/)object\/src\/index\.ts$/.test(node.file.fileName);
		if (globallyGoverned || publicationRoot || ownershipRoot) rootIds.add(node.id);
	}
	const reachable = new Set<string>();
	const pending = [...rootIds];
	while (pending.length) {
		const id = pending.pop();
		if (!id || reachable.has(id)) continue;
		reachable.add(id);
		pending.push(...(edges.get(id) ?? []));
	}

	const injectedLeaves = nodes.filter((node) => /(?:type|kind)\s*:\s*["']copy["']/.test(node.body.getText(node.file)));
	const reachedByBothPublicationRoots = (owner: FunctionNode): boolean =>
		[...ROOT_METHODS].every((rootName) => {
			const root = nodes.find(({ name }) => name === rootName);
			if (!root) return false;
			const seen = new Set<string>();
			const queue = [root.id];
			while (queue.length) {
				const id = queue.pop();
				if (!id || seen.has(id)) continue;
				if (id === owner.id) return true;
				seen.add(id);
				queue.push(...(edges.get(id) ?? []));
			}
			return false;
		});
	const operationId = (operation: SemanticOperation): string => {
		const kind =
			operation.primitive === "cloneDeep" || operation.primitive === "structuredClone" ? "clone" : "serialization";
		return `${ownerLabel(operation.owner)}:${kind}`;
	};
	const residualSite = (operation: SemanticOperation): string => {
		const owner = ownerLabel(operation.owner).replace(/^packages\/object\/src\//, "");
		return `${owner}:${normalizedCall(operation.call)}`;
	};
	const qualifiesReviewed = (operation: SemanticOperation): boolean => {
		const id = operationId(operation);
		if (!REVIEWED_WORKSPACE_OPERATIONS.includes(id as (typeof REVIEWED_WORKSPACE_OPERATIONS)[number])) return false;
		if (id.endsWith("DRPVertexApplier.copyPublicationPayload:clone")) {
			return (
				operation.primitive === "cloneDeep" &&
				injectedLeaves.some(({ id: leafId }) => leafId === operation.owner.id) &&
				reachedByBothPublicationRoots(operation.owner)
			);
		}
		if (id.endsWith("DRPObject.getStates:clone")) {
			const body = operation.owner.body.getText(operation.owner.file);
			return operation.primitive === "cloneDeep" && /getACLState/.test(body) && /getDRPState/.test(body);
		}
		if (id.endsWith("DRPObject.setACLState:clone")) {
			return (
				operation.primitive === "cloneDeep" &&
				/\.setACLState\s*\(/.test(operation.owner.body.getText(operation.owner.file))
			);
		}
		if (id.endsWith("DRPObject.setDRPState:clone")) {
			return (
				operation.primitive === "cloneDeep" &&
				/\.setDRPState\s*\(/.test(operation.owner.body.getText(operation.owner.file))
			);
		}
		return (
			operation.primitive === "serialization" &&
			operation.owner.name === "serializeValue" &&
			/returnencode\([^)]*,\{extensionCodec\}\)/.test(
				operation.owner.body.getText(operation.owner.file).replace(/\s+/g, "")
			)
		);
	};
	const reviewedOperations = new Set<string>();
	const violations: string[] = [];
	for (const operation of operations.values()) {
		if (!reachable.has(operation.owner.id)) continue;
		if (operation.primitive === "cloneDeep" && RESIDUAL_CLONE_SITES.has(residualSite(operation))) continue;
		if (operation.primitive === "stateFromDRP" && RESIDUAL_STATE_CAPTURE_SITES.has(residualSite(operation))) continue;
		if (
			operation.primitive === "cloneDeep" &&
			injectedLeaves.some(({ id }) => id === operation.owner.id) &&
			reachedByBothPublicationRoots(operation.owner)
		) {
			if (qualifiesReviewed(operation)) reviewedOperations.add(operationId(operation));
			continue;
		}
		if (qualifiesReviewed(operation)) {
			reviewedOperations.add(operationId(operation));
			continue;
		}
		violations.push(
			`${ownerLabel(operation.owner)} reaches forbidden ${operation.primitive === "json" ? "serialization round-trip" : operation.primitive} operation through the workspace module graph`
		);
	}
	const qualifiedSerializationOwners = new Set(
		[...operations.values()]
			.filter(
				(operation) =>
					operation.primitive === "serialization" &&
					operation.owner.name === "serializeValue" &&
					qualifiesReviewed(operation)
			)
			.map(({ owner }) => owner.id)
	);
	for (const [callerId, callees] of edges) {
		if (!reachable.has(callerId)) continue;
		const caller = nodesById.get(callerId);
		if (!caller || caller.name === "serializedValuesEqual") continue;
		for (const calleeId of callees) {
			if (!qualifiedSerializationOwners.has(calleeId)) continue;
			violations.push(
				`${ownerLabel(caller)} reaches forbidden serialization operation through the workspace module graph`
			);
		}
	}
	return {
		reviewedOperations: [...reviewedOperations].sort(),
		violations: [...new Set(violations)].sort(),
	};
}

function analyze(sources: Readonly<Record<string, string>>): ClosureAnalysis & WorkspaceIntegrationCensus {
	const legacy = analyzeLegacy(sources);
	const files = Object.entries(sources).map(([name, source]) =>
		ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	);
	const semantic = semanticAnalysis(files, functions(files));
	return {
		...legacy,
		analyzedSourcePaths: Object.keys(sources).sort(),
		reviewedOperations: semantic.reviewedOperations,
		violations: [...new Set([...legacy.violations, ...semantic.violations])].sort(),
	};
}

function compliantSource(extra = ""): Record<string, string> {
	return {
		"arbitrary-location.ts": `
			class ArbitrarilyNamedPublisher {
				private readonly sink: (event: unknown) => unknown;
				constructor({ publicationObserver }: { publicationObserver: (event: unknown) => unknown }) {
					this.sink = publicationObserver;
				}
				assignState(): void { this.route(); }
				advanceCheckpointIfNeeded(): void { this.route(); }
				private route(): void { this.detachPayload({ value: 1 }); ${extra} }
				private detachPayload(value: unknown): unknown {
					return this.sink({ type: "copy", value });
				}
			}
		`,
	};
}

function relocatedSource(relocation: string): Record<string, string> {
	return {
		...compliantSource(),
		"drp-applier.ts": relocation,
	};
}

const WORKSPACE_PUBLISHER_PATH = "packages/object/src/drp-applier.ts";
const UTILS_SERIALIZATION_PATH = "packages/utils/src/serialization/index.ts";
const ENCODE_VIOLATION = /encode|serialization|serializeValue/;
const CLONE_VIOLATION = /clone|cloneDeep|structuredClone|detaches payload/;
const ROUND_TRIP_VIOLATION = /round.?trip|serialization|serializeDRPState|deserializeDRPState|encode|decode/;

interface WorkspaceMutationFixture {
	readonly expectedViolation: RegExp;
	readonly name: string;
	readonly sources: Readonly<Record<string, string>>;
}

function workspacePublisher(imports: string, mutation: string): string {
	return `
		${imports}
		class WorkspacePublisher {
			private readonly sink: (event: unknown) => unknown;
			constructor({ publicationObserver }: { publicationObserver: (event: unknown) => unknown }) {
				this.sink = publicationObserver;
			}
			assignState(): void { this.publish(); }
			advanceCheckpointIfNeeded(): void { this.publish(); }
			private publish(): void {
				const state = { changed: { value: 1 }, unchanged: { ballast: true } };
				${mutation}
				this.copyPayload(state.changed);
			}
			private copyPayload(value: unknown): unknown {
				return this.sink({ type: "copy", value });
			}
		}
	`;
}

function workspaceFixture(
	name: string,
	expectedViolation: RegExp,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>>
): WorkspaceMutationFixture {
	return {
		expectedViolation,
		name,
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		},
	};
}

const WORKSPACE_REACHABILITY_MUTANTS: readonly WorkspaceMutationFixture[] = [
	workspaceFixture(
		"exact rejected snapshotValueBytes helper relocated into @ts-drp/utils",
		ENCODE_VIOLATION,
		'import { snapshotValueBytes } from "@ts-drp/utils/serialization";',
		"snapshotValueBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function serializeValue(value: unknown): Uint8Array { return encode(value); }
				export function snapshotValueBytes(obj: unknown): Uint8Array {
					return Uint8Array.from(serializeValue(obj));
				}
			`,
		}
	),
	workspaceFixture(
		"renamed re-export through the @ts-drp/utils package root",
		ENCODE_VIOLATION,
		'import { encodeSnapshot } from "@ts-drp/utils";',
		"encodeSnapshot(state);",
		{
			"packages/utils/src/index.ts": 'export { serializeValue as encodeSnapshot } from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function serializeValue(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	workspaceFixture(
		"two-hop wrapper with implementation-neutral names",
		ENCODE_VIOLATION,
		'import { captureCurrent } from "@ts-drp/utils/serialization";',
		"captureCurrent(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				function innermost(value: unknown): Uint8Array { return encode(value); }
				function intermediate(value: unknown): Uint8Array { return innermost(value); }
				export function captureCurrent(value: unknown): Uint8Array { return intermediate(value); }
			`,
		}
	),
	workspaceFixture(
		"third-workspace-package wrapper",
		ENCODE_VIOLATION,
		'import { captureTracePayload } from "@ts-drp/tracer";',
		"captureTracePayload(state);",
		{
			"packages/tracer/src/index.ts": `
				import { snapshotValueBytes } from "@ts-drp/utils/serialization";
				export function captureTracePayload(value: unknown): Uint8Array { return snapshotValueBytes(value); }
			`,
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function snapshotValueBytes(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	workspaceFixture(
		"namespace import hidden behind a property alias",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		"const holder = { capture: snapshots.snapshotValueBytes }; holder.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function snapshotValueBytes(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	workspaceFixture(
		"callback alias passage",
		ENCODE_VIOLATION,
		`import { snapshotValueBytes } from "@ts-drp/utils/serialization";
		 function invoke(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); }`,
		"invoke(snapshotValueBytes, state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function snapshotValueBytes(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	workspaceFixture(
		"default-export wrapper",
		ENCODE_VIOLATION,
		'import snapshotValueBytes from "@ts-drp/utils/serialization";',
		"snapshotValueBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export default function snapshotValueBytes(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	workspaceFixture(
		"discarded cross-package copy",
		CLONE_VIOLATION,
		'import { prepareSnapshot } from "@ts-drp/utils/serialization";',
		"prepareSnapshot(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { cloneDeep } from "es-toolkit";
				export function prepareSnapshot(value: unknown): unknown { cloneDeep(value); return value; }
			`,
		}
	),
	workspaceFixture(
		"discarded cross-package encode",
		ENCODE_VIOLATION,
		'import { observeSnapshot } from "@ts-drp/utils/serialization";',
		"observeSnapshot(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function observeSnapshot(value: unknown): void { encode(value); }
			`,
		}
	),
	workspaceFixture(
		"serialization-as-clone round trip",
		ROUND_TRIP_VIOLATION,
		'import { cloneThroughBytes } from "@ts-drp/utils/serialization";',
		"cloneThroughBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { decode, encode } from "@msgpack/msgpack";
				export function cloneThroughBytes(value: unknown): unknown { return decode(encode(value)); }
			`,
		}
	),
	workspaceFixture(
		"clone-everything-then-share cross-package wrapper",
		CLONE_VIOLATION,
		'import { precloneState } from "@ts-drp/utils/serialization";',
		'precloneState(state, "changed");',
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { cloneDeep } from "es-toolkit";
				export function precloneState(state: Record<string, unknown>, key: string): unknown {
					const cloned = cloneDeep(state);
					return cloned[key];
				}
			`,
		}
	),
	{
		name: "ownership helper just outside the former globally scanned boundary",
		expectedViolation: CLONE_VIOLATION,
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/object/src/index.ts": `
				import { detachPublicState } from "./ownership-boundary.js";
				export class DRPObject {
					getStates(value: unknown): unknown { return detachPublicState(value); }
				}
			`,
			"packages/object/src/ownership-boundary.ts": `
				export function detachPublicState(value: unknown): unknown { return structuredClone(value); }
			`,
		},
	},
];

describe("Phase 1d(i) publication transitive no-bypass closure", () => {
	it("discovers one injected copy leaf from both publication roots without fixing its name or location", () => {
		const analysis = analyze(sourceFiles(SOURCE_DIRECTORY));
		expect(analysis.violations).toEqual([]);
		expect(analysis.injectedCopyLeaves).toHaveLength(1);
	});

	it("runs the semantic gate over normalized real workspace sources with the reviewed operation census", () => {
		const sources = realGovernedWorkspaceSources();
		const analysis = analyze(sources) as ClosureAnalysis & WorkspaceIntegrationCensus;
		expectWorkspaceIntegration(sources, analysis);
	});

	it("rejects an object-only real-source loader even when its analyzer report claims the reviewed census", () => {
		const sources = Object.fromEntries(
			Object.entries(realGovernedWorkspaceSources()).filter(([sourcePath]) =>
				sourcePath.startsWith("packages/object/src/")
			)
		);
		expect(() =>
			expectWorkspaceIntegration(sources, {
				analyzedSourcePaths: Object.keys(sources),
				injectedCopyLeaves: [],
				reachable: [],
				residualCloneSites: [],
				reviewedOperations: REVIEWED_WORKSPACE_OPERATIONS,
				violations: [],
			})
		).toThrow();
	});

	it("rejects a workspace loader when the semantic analyzer silently skips sources outside object/src", () => {
		const sources = realGovernedWorkspaceSources();
		const objectOnlyPaths = Object.keys(sources).filter((sourcePath) => sourcePath.startsWith("packages/object/src/"));
		expect(() =>
			expectWorkspaceIntegration(sources, {
				analyzedSourcePaths: objectOnlyPaths,
				injectedCopyLeaves: [],
				reachable: [],
				residualCloneSites: [],
				reviewedOperations: REVIEWED_WORKSPACE_OPERATIONS,
				violations: [],
			})
		).toThrow();
	});

	it("kills a neutral wrapper relocated beyond object/src in the real in-memory workspace graph", () => {
		const sources = realGovernedWorkspaceSources();
		const publisher = sources[WORKSPACE_PUBLISHER_PATH];
		const serialization = sources[UTILS_SERIALIZATION_PATH];
		expect(publisher).toBeDefined();
		expect(serialization).toBeDefined();
		sources[WORKSPACE_PUBLISHER_PATH] = publisher
			.replace(
				'import { serializedValuesEqual } from "@ts-drp/utils/serialization";',
				'import { publicationSnapshotCopy, serializedValuesEqual } from "@ts-drp/utils/serialization";'
			)
			.replace("return cloneDeep(value);", "return publicationSnapshotCopy(value);");
		sources[UTILS_SERIALIZATION_PATH] =
			`${serialization}\nexport function publicationSnapshotCopy(value: unknown): Uint8Array {\n\treturn serializeValue(value);\n}\n`;
		expect(sources[WORKSPACE_PUBLISHER_PATH]).toContain("return publicationSnapshotCopy(value);");
		expect(analyze(sources).violations).toEqual(
			expect.arrayContaining([expect.stringMatching(/publicationSnapshotCopy|serializeValue|serialization/)])
		);
	});

	it("accepts an equivalent safe publisher in an arbitrary file with arbitrary internal names", () => {
		expect(analyze(compliantSource()).violations).toEqual([]);
	});

	it("accepts a compliant cross-package wrapper after resolving its workspace package root", () => {
		const sources = {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { selectChangedPayload } from "@ts-drp/utils";',
				"selectChangedPayload(state.changed);"
			),
			"packages/utils/src/index.ts": `
				export function selectChangedPayload(value: unknown): unknown { return value; }
			`,
		};
		expect(analyze(sources).violations).toEqual([]);
	});

	it("requires both publication roots to reach the same implementation-neutral copy leaf", () => {
		const oneRootBypasses = compliantSource()["arbitrary-location.ts"].replace(
			"advanceCheckpointIfNeeded(): void { this.route(); }",
			"advanceCheckpointIfNeeded(): void {}"
		);
		expect(analyze({ "arbitrary-location.ts": oneRootBypasses }).violations).toContain(
			"advanceCheckpointIfNeeded does not reach the unique injected copy leaf"
		);
	});

	it.each([
		["clone-everything-then-share", "stateFromDRP(live);"],
		["discarded pre-copy", "cloneDeep(value);"],
		["serialization-as-clone", "serializeDRPState(value);"],
		["ordinary full fallback", "stateFromDRP(live);"],
		["just-outside-counter relocation", "structuredClone(value);"],
	] as const)("kills the named %s mutant", (_name, mutant) => {
		expect(analyze(compliantSource(mutant)).violations.length).toBeGreaterThan(0);
	});

	it.each([
		[
			"cloneDeep callback alias",
			"cloneDeep",
			`import { cloneDeep as detach } from "es-toolkit";
			 function hidden(value: unknown): unknown { const callback = detach; return callback(value); }`,
		],
		[
			"structuredClone property alias",
			"structuredClone",
			`function hidden(value: unknown): unknown {
				const holder = { copy: globalThis["structuredClone"] };
				return holder.copy(value);
			}`,
		],
		[
			"JSON element-access round trip",
			"json",
			`function hidden(value: unknown): unknown { return JSON["parse"](JSON.stringify(value)); }`,
		],
		[
			"serialization callback alias",
			"serialization",
			`import { serializeDRPState as encode } from "@ts-drp/utils/serialization";
			 function hidden(value: unknown): unknown { const callback = encode; return callback(value); }`,
		],
		[
			"stateFromDRP property alias",
			"stateFromDRP",
			`import { stateFromDRP as capture } from "./state.js";
			 class Hidden {
				private readonly capture = capture;
				run(value: unknown): unknown { return this.capture(value); }
			}`,
		],
	] as const)("kills globally relocated %s behind a reachable dummy leaf", (_name, expected, relocation) => {
		const analysis = analyze(relocatedSource(relocation));
		expect(analysis.injectedCopyLeaves).toHaveLength(1);
		expect(analysis.violations.some((violation) => violation.includes(expected))).toBe(true);
	});

	for (const { expectedViolation, name, sources } of WORKSPACE_REACHABILITY_MUTANTS) {
		it(`kills ${name} by following workspace exports to the forbidden primitive`, () => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		});
	}

	it("pins the exact excluded-copy-site census outside governed publication", () => {
		const sources = sourceFiles(SOURCE_DIRECTORY);
		expect(analyze(sources).residualCloneSites).toEqual([...RESIDUAL_CLONE_SITES].sort());
		const state = sources["state.ts"];
		const applier = sources["drp-applier.ts"];
		const proxy = sources["proxy.ts"];
		expect({
			stateManagerContextInitialization: (state.match(/this\.(?:drp|acl)Context = cloneDeep/g) ?? []).length,
			mutableReconstructionContext: (state.match(/if \((?:acl|drp)Context\) (?:acl|drp)\.context = cloneDeep/g) ?? [])
				.length,
			mutableReconstructionPayload: (state.match(/\[entry\.key\] = cloneDeep\(entry\.value\)/g) ?? []).length,
			aclReconstructionContext: (state.match(/if \(this\.aclContext\) acl\.context = cloneDeep/g) ?? []).length,
			incomingOperationDetachment: (applier.match(/operation: cloneDeep\(submittedVertex\.operation\)/g) ?? []).length,
			hintedAdoptionReconstruction: (applier.match(/cloneRecord\[key\] = cloneDeep\(sourceRecord\[key\]\)/g) ?? [])
				.length,
			callerOperationDetachment: (applier.match(/value: cloneDeep\(value\)/g) ?? []).length,
			operationArgumentDetachment: (applier.match(/Reflect\.apply\(operation, drp, cloneDeep\(args\)\)/g) ?? []).length,
			proxyBypassCopies: (proxy.match(/\bcloneDeep\s*\(/g) ?? []).length,
		}).toEqual({
			stateManagerContextInitialization: 2,
			mutableReconstructionContext: 2,
			mutableReconstructionPayload: 1,
			aclReconstructionContext: 1,
			incomingOperationDetachment: 1,
			hintedAdoptionReconstruction: 1,
			callerOperationDetachment: 1,
			operationArgumentDetachment: 1,
			proxyBypassCopies: 0,
		});
	});
});
