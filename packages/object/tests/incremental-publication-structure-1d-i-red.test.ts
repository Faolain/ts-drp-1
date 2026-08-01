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
	readonly body: ts.ConciseBody;
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
	expect(analysis.violations).toEqual([]);
	for (const reviewed of REVIEWED_WORKSPACE_OPERATIONS) {
		const [file, owner] = reviewed.split(":");
		expect(analysis.violations.some((violation) => violation.includes(file) && violation.includes(owner))).toBe(false);
	}
}

function functions(files: readonly ts.SourceFile[]): FunctionNode[] {
	const result: FunctionNode[] = [];
	for (const file of files) {
		const add = (
			declaration: ts.FunctionLikeDeclaration,
			body: ts.ConciseBody,
			name: string,
			className?: string
		): void => {
			result.push({
				body,
				className,
				declaration,
				file,
				id: `${file.fileName}:${className ?? "<module>"}.${name}@${declaration.pos}`,
				name,
			});
		};
		const visit = (node: ts.Node, className?: string): void => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				const nextClass =
					node.name?.text ??
					(ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
						? node.parent.name.text
						: `<anonymous@${node.pos}>`);
				for (const child of node.members) visit(child, nextClass);
				return;
			}
			if (ts.isConstructorDeclaration(node) && node.body) {
				add(node, node.body, "constructor", className);
			} else if (ts.isMethodDeclaration(node) && node.name && node.body) {
				add(node, node.body, ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file), className);
			} else if (ts.isGetAccessorDeclaration(node) && node.name && node.body) {
				add(node, node.body, ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file), className);
			} else if (ts.isFunctionDeclaration(node) && node.body) {
				const isDefault = node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword);
				add(node, node.body, node.name?.text ?? (isDefault ? "default" : `<anonymous@${node.pos}>`), className);
			} else if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
			) {
				add(node.initializer, node.initializer.body, node.name.text, className);
			} else if (
				className &&
				ts.isPropertyDeclaration(node) &&
				node.name &&
				node.initializer &&
				(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
			) {
				add(
					node.initializer,
					node.initializer.body,
					ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(file),
					className
				);
			} else if (
				(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
				!ts.isVariableDeclaration(node.parent) &&
				!ts.isPropertyDeclaration(node.parent)
			) {
				add(node, node.body, `<anonymous@${node.pos}>`, className);
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
		if (node.text === "stateFromDRP" && !bindings.has(node.text)) return "stateFromDRP";
		return bindings.get(node.text);
	}
	if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
	const name = propertyName(node);
	const receiver = node.expression.getText(node.getSourceFile()).replace(/\s+/g, "");
	if (name === "structuredClone" && receiver === "globalThis") return "structuredClone";
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
					const site = `${ownerLabel(owner).replace(/^packages\/object\/src\//, "")}:${normalizedCall(node)}`;
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
		if (!GLOBALLY_GOVERNED_FILES.has(path.posix.basename(file.fileName))) continue;
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

type SemanticPrimitive =
	| "cloneDeep"
	| "structuredClone"
	| "serialization"
	| "json"
	| "stateFromDRP"
	| "unresolvedInternal";
type SemanticTarget =
	| `function:${string}`
	| `object:${string}:${string}`
	| `class:${string}`
	| `instance:${string}`
	| `namespace:${string}`
	| `callable:${string}`
	| "builtin:Function"
	| "builtin:FunctionPrototype"
	| "builtin:functionApply"
	| "builtin:functionBind"
	| "builtin:functionCall"
	| "builtin:globalThis"
	| "builtin:json"
	| "builtin:jsonParse"
	| "builtin:jsonStringify"
	| "provenance:jsonString"
	| `primitive:${SemanticPrimitive}`;

interface SemanticArgument {
	readonly definitelyUndefined?: boolean;
	readonly owner?: SemanticOwner;
	readonly source?: ts.Expression;
	readonly targets: Set<SemanticTarget>;
}

interface BoundCallable {
	readonly arguments: readonly SemanticArgument[];
	readonly targets: Set<SemanticTarget>;
	readonly thisArgument?: SemanticArgument;
	readonly unknownArguments?: boolean;
}

interface KeyResolution {
	readonly unknown: boolean;
	readonly values: Set<string>;
}

type SemanticOwner = Pick<FunctionNode, "className" | "file" | "id"> & {
	readonly staticClassTarget?: `class:${string}`;
};

function semanticClassTarget(file: ts.SourceFile, declaration: ts.ClassLikeDeclaration): `class:${string}` {
	return `class:${file.fileName}@${declaration.pos}`;
}

interface ImportBinding {
	readonly exportName: string;
	readonly expression?: ts.Expression;
	readonly moduleName?: string;
	readonly primitive?: SemanticPrimitive;
	readonly unresolvedInternal?: boolean;
}

interface SemanticModule {
	readonly exports: ReadonlyMap<string, ImportBinding | SemanticTarget>;
	readonly imports: ReadonlyMap<string, ImportBinding>;
	readonly namespaces: ReadonlyMap<string, string>;
	readonly starExports: readonly string[];
	readonly unresolvedNamespaces: ReadonlySet<string>;
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
	if (moduleName === "node:v8" && (importedName === "serialize" || importedName === "deserialize")) {
		return "serialization";
	}
	if (moduleName === "@bufbuild/protobuf" && (importedName === "toBinary" || importedName === "fromBinary")) {
		return "serialization";
	}
	return undefined;
}

function isUnresolvedInternalImport(fromFile: string, specifier: string, moduleName: string | undefined): boolean {
	return (
		!moduleName &&
		/^packages\/[^/]+\/src\//.test(fromFile) &&
		(specifier.startsWith("@ts-drp/") || specifier.startsWith("."))
	);
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
		const starExports: string[] = [];
		const unresolvedNamespaces = new Set<string>();
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
						unresolvedInternal: isUnresolvedInternalImport(file.fileName, specifier, moduleName),
					});
				}
				const bindings = clause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					namespaces.set(bindings.name.text, moduleName ?? specifier);
					if (isUnresolvedInternalImport(file.fileName, specifier, moduleName)) {
						unresolvedNamespaces.add(bindings.name.text);
					}
				} else if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						const importedName = element.propertyName?.text ?? element.name.text;
						imports.set(element.name.text, {
							exportName: importedName,
							moduleName,
							primitive: moduleName ? undefined : importedPrimitive(specifier, importedName),
							unresolvedInternal: isUnresolvedInternalImport(file.fileName, specifier, moduleName),
						});
					}
				}
				continue;
			}
			if (ts.isFunctionDeclaration(statement)) {
				const exportedName = statement.name?.text ?? "default";
				const node = functionsByFileAndName.get(`${file.fileName}:${exportedName}`);
				if (node && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
					exports.set(
						statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) ? "default" : exportedName,
						`function:${node.id}`
					);
				}
				continue;
			}
			if (
				ts.isClassDeclaration(statement) &&
				statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
			) {
				const exportedName = statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)
					? "default"
					: statement.name?.text;
				if (!exportedName) continue;
				exports.set(exportedName, semanticClassTarget(file, statement));
				continue;
			}
			if (
				ts.isVariableStatement(statement) &&
				statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
			) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name)) continue;
					exports.set(declaration.name.text, {
						exportName: declaration.name.text,
						expression: declaration.name,
						moduleName: file.fileName,
					});
				}
				continue;
			}
			if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
				exports.set("default", {
					exportName: "default",
					expression: statement.expression,
					moduleName: file.fileName,
				});
				continue;
			}
			if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier) {
				const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
				const moduleName = specifier ? resolveModuleName(file.fileName, specifier, sourceNames) : undefined;
				if (moduleName) starExports.push(moduleName);
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
						expression: specifier ? undefined : (element.propertyName ?? element.name),
						moduleName,
						primitive: specifier && !moduleName ? importedPrimitive(specifier, importedName) : undefined,
					});
				}
			}
		}
		result.set(file.fileName, { exports, imports, namespaces, starExports, unresolvedNamespaces });
	}
	return result;
}

function semanticAnalysis(
	files: readonly ts.SourceFile[],
	nodes: readonly FunctionNode[]
): { reviewedOperations: string[]; violations: string[] } {
	const modules = semanticModules(files, nodes);
	const sourceNames = new Set(files.map(({ fileName }) => fileName));
	const filesByName = new Map(files.map((file) => [file.fileName, file]));
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const nodesByDeclaration = new Map(nodes.map((node) => [node.declaration, node]));
	const moduleFunctions = new Map<string, FunctionNode>();
	const lexicalCallables = new Map<ts.Node, Map<string, FunctionNode[]>>();
	const lexicalInitializers = new Map<ts.Node, Map<string, ts.Expression>>();
	const lexicalValueBindings = new Map<ts.Node, Set<string>>();
	const classMethods = new Map<string, FunctionNode>();
	type DestructuredProjection =
		| {
				readonly kind: "array-index";
				readonly index: number;
				readonly owner: SemanticOwner;
				readonly source: ts.Expression;
		  }
		| {
				readonly kind: "array-rest";
				readonly owner: SemanticOwner;
				readonly source?: ts.Expression;
				readonly start: number;
				readonly target: SemanticTarget;
		  }
		| {
				readonly kind: "object-property";
				readonly owner: SemanticOwner;
				readonly property: string;
				readonly source: ts.Expression;
		  }
		| {
				readonly excluded: ReadonlySet<string>;
				readonly kind: "object-rest";
				readonly owner: SemanticOwner;
				readonly source?: ts.Expression;
				readonly target: SemanticTarget;
		  };
	const lexicalProjections = new Map<ts.Node, Map<string, DestructuredProjection>>();
	const projectionValues = new Map<SemanticTarget, DestructuredProjection>();
	const moduleVariables = new Map<string, ts.Expression>();
	const moduleBindings = new Set<string>();
	const classes = new Map<string, ts.ClassLikeDeclaration>();
	const localClasses = new Map<string, SemanticTarget>();
	const parameterTargets = new Map<string, Map<string, Set<SemanticTarget>>>();
	const returnedTargets = new Map<string, Set<SemanticTarget>>();
	const storedTargets = new Map<string, Set<SemanticTarget>>();
	const unknownProperty = Symbol("unknown property");
	type PropertySlot = string | typeof unknownProperty;
	const propertyFacts = new Map<string, Map<PropertySlot, Set<SemanticTarget>>>();
	const boundCallables = new Map<string, BoundCallable>();
	const containerValues = new Map<
		SemanticTarget,
		{
			readonly expression: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression;
			readonly owner: SemanticOwner;
		}
	>();
	const moduleOwner = (fileName: string): SemanticOwner | undefined => {
		const file = filesByName.get(fileName);
		return file ? { file, id: `${fileName}:<module>` } : undefined;
	};
	const transparentExpression = (expression: ts.Expression): ts.Expression => {
		let current = expression;
		while (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isAwaitExpression(current)
		) {
			current = current.expression;
		}
		return current;
	};
	const logicalValueOperators = new Set<ts.SyntaxKind>([
		ts.SyntaxKind.AmpersandAmpersandToken,
		ts.SyntaxKind.BarBarToken,
		ts.SyntaxKind.QuestionQuestionToken,
	]);
	const logicalAssignmentOperators = new Set<ts.SyntaxKind>([
		ts.SyntaxKind.AmpersandAmpersandEqualsToken,
		ts.SyntaxKind.BarBarEqualsToken,
		ts.SyntaxKind.QuestionQuestionEqualsToken,
	]);
	const projectionTarget = (owner: SemanticOwner, element: ts.BindingElement): SemanticTarget =>
		`object:${owner.file.fileName}:projection@${element.pos}` as SemanticTarget;
	const joinTargets = (targets: Set<SemanticTarget>, additions: Iterable<SemanticTarget>): boolean => {
		let changed = false;
		for (const target of additions) {
			if (targets.has(target)) continue;
			targets.add(target);
			changed = true;
		}
		return changed;
	};
	const storedPropertyTargets = (containerId: string, name: string): Set<SemanticTarget> => {
		const properties = propertyFacts.get(containerId);
		return new Set([...(properties?.get(name) ?? []), ...(properties?.get(unknownProperty) ?? [])]);
	};
	const storedUnknownPropertyTargets = (containerId: string): Set<SemanticTarget> =>
		new Set(propertyFacts.get(containerId)?.get(unknownProperty) ?? []);
	const joinPropertyTargets = (
		containerId: string,
		slot: PropertySlot,
		additions: Iterable<SemanticTarget>
	): boolean => {
		const properties = propertyFacts.get(containerId) ?? new Map<PropertySlot, Set<SemanticTarget>>();
		const targets = properties.get(slot) ?? new Set<SemanticTarget>();
		const changed = joinTargets(targets, additions);
		properties.set(slot, targets);
		propertyFacts.set(containerId, properties);
		return changed;
	};
	const isModuleCallable = (node: FunctionNode): boolean => {
		const declaration = node.declaration;
		if (ts.isFunctionDeclaration(declaration)) return ts.isSourceFile(declaration.parent);
		const variable = declaration.parent;
		return (
			ts.isVariableDeclaration(variable) &&
			ts.isVariableDeclarationList(variable.parent) &&
			ts.isVariableStatement(variable.parent.parent) &&
			ts.isSourceFile(variable.parent.parent.parent)
		);
	};
	const isLexicalScope = (node: ts.Node): boolean =>
		ts.isSourceFile(node) ||
		ts.isBlock(node) ||
		ts.isCaseBlock(node) ||
		ts.isModuleBlock(node) ||
		ts.isCatchClause(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node);
	const lexicalScope = (node: ts.Node): ts.Node | undefined => {
		let declaration: ts.Node | undefined = node;
		while (declaration && !ts.isVariableDeclaration(declaration) && !ts.isFunctionLike(declaration)) {
			declaration = declaration.parent;
		}
		if (
			declaration &&
			ts.isVariableDeclaration(declaration) &&
			ts.isVariableDeclarationList(declaration.parent) &&
			(declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0
		) {
			let functionScope: ts.Node | undefined = declaration.parent;
			while (functionScope) {
				if (ts.isSourceFile(functionScope)) return functionScope;
				if (ts.isFunctionLike(functionScope)) return "body" in functionScope ? functionScope.body : undefined;
				functionScope = functionScope.parent;
			}
		}
		let current: ts.Node | undefined = node.parent;
		while (current) {
			if (isLexicalScope(current)) return current;
			current = current.parent;
		}
		return undefined;
	};
	const registerProjection = (
		element: ts.BindingElement,
		projection: DestructuredProjection,
		scopeOverride?: ts.Node
	): void => {
		if (!ts.isIdentifier(element.name)) return;
		const scope = scopeOverride ?? lexicalScope(element.name);
		if (!scope) return;
		const bindings = lexicalProjections.get(scope) ?? new Map<string, DestructuredProjection>();
		bindings.set(element.name.text, projection);
		lexicalProjections.set(scope, bindings);
		if (projection.kind === "object-rest" || projection.kind === "array-rest") {
			projectionValues.set(projection.target, projection);
		}
	};
	const projectionForIdentifier = (identifier: ts.Identifier): DestructuredProjection | undefined => {
		let current: ts.Node | undefined = identifier.parent;
		while (current) {
			const projection = lexicalProjections.get(current)?.get(identifier.text);
			if (projection) return projection;
			if (lexicalValueBindings.get(current)?.has(identifier.text)) return undefined;
			if (
				ts.isFunctionLike(current) &&
				current.parameters.some(
					(parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
				)
			) {
				return undefined;
			}
			current = current.parent;
		}
		return undefined;
	};
	const registerDestructuring = (declaration: ts.VariableDeclaration, owner: SemanticOwner): void => {
		if (!declaration.initializer) return;
		if (ts.isObjectBindingPattern(declaration.name)) {
			const excluded = new Set<string>();
			for (const element of declaration.name.elements) {
				if (!ts.isIdentifier(element.name)) continue;
				if (element.dotDotDotToken) {
					const target = projectionTarget(owner, element);
					registerProjection(element, {
						excluded: new Set(excluded),
						kind: "object-rest",
						owner,
						source: declaration.initializer,
						target,
					});
					continue;
				}
				const property = element.propertyName
					? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
						? element.propertyName.text
						: undefined
					: element.name.text;
				if (!property) continue;
				excluded.add(property);
				registerProjection(element, {
					kind: "object-property",
					owner,
					property,
					source: declaration.initializer,
				});
			}
			return;
		}
		if (!ts.isArrayBindingPattern(declaration.name)) return;
		for (const [index, element] of declaration.name.elements.entries()) {
			if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
			if (element.dotDotDotToken) {
				const target = projectionTarget(owner, element);
				registerProjection(element, {
					kind: "array-rest",
					owner,
					source: declaration.initializer,
					start: index,
					target,
				});
			} else {
				registerProjection(element, {
					index,
					kind: "array-index",
					owner,
					source: declaration.initializer,
				});
			}
		}
	};
	for (const node of nodes) {
		if (node.className) classMethods.set(`${node.file.fileName}:${node.className}:${node.name}`, node);
		else if (isModuleCallable(node)) moduleFunctions.set(`${node.file.fileName}:${node.name}`, node);
		if (ts.isFunctionDeclaration(node.declaration) && node.declaration.name) {
			const scope = lexicalScope(node.declaration);
			if (scope) {
				const declarations = lexicalCallables.get(scope) ?? new Map<string, FunctionNode[]>();
				declarations.set(node.declaration.name.text, [...(declarations.get(node.declaration.name.text) ?? []), node]);
				lexicalCallables.set(scope, declarations);
			}
		}
		const parameters = new Map<string, Set<SemanticTarget>>();
		const parameterScope = ts.isBlock(node.body) ? node.body : undefined;
		const registerParameterPattern = (name: ts.BindingName): void => {
			if (ts.isIdentifier(name)) {
				parameters.set(name.text, new Set());
				return;
			}
			if (ts.isObjectBindingPattern(name)) {
				const excluded = new Set<string>();
				for (const element of name.elements) {
					if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
						const target = projectionTarget(node, element);
						registerProjection(
							element,
							{ excluded: new Set(excluded), kind: "object-rest", owner: node, target },
							parameterScope
						);
						parameters.set(element.name.text, new Set([target]));
						continue;
					}
					const property = element.propertyName
						? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
							? element.propertyName.text
							: undefined
						: ts.isIdentifier(element.name)
							? element.name.text
							: undefined;
					if (property) excluded.add(property);
					registerParameterPattern(element.name);
				}
				return;
			}
			for (const [index, element] of name.elements.entries()) {
				if (!ts.isBindingElement(element)) continue;
				if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
					const target = projectionTarget(node, element);
					registerProjection(element, { kind: "array-rest", owner: node, start: index, target }, parameterScope);
					parameters.set(element.name.text, new Set([target]));
					continue;
				}
				registerParameterPattern(element.name);
			}
		};
		for (const parameter of node.declaration.parameters) {
			registerParameterPattern(parameter.name);
		}
		parameterTargets.set(node.id, parameters);
		const visit = (child: ts.Node): void => {
			if (child !== node.body && ts.isFunctionLike(child)) return;
			if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) {
				const scope = lexicalScope(child);
				if (scope) {
					const initializers = lexicalInitializers.get(scope) ?? new Map<string, ts.Expression>();
					initializers.set(child.name.text, child.initializer);
					lexicalInitializers.set(scope, initializers);
				}
			} else if (ts.isVariableDeclaration(child)) registerDestructuring(child, node);
			ts.forEachChild(child, visit);
		};
		visit(node.body);
	}
	for (const file of files) {
		const visitBindings = (node: ts.Node): void => {
			const registerName = (name: ts.BindingName | ts.Identifier, declaration: ts.Node): void => {
				if (!ts.isIdentifier(name)) {
					for (const element of name.elements) {
						if (ts.isBindingElement(element)) registerName(element.name, declaration);
					}
					return;
				}
				const scope = lexicalScope(declaration);
				if (scope) {
					const bindings = lexicalValueBindings.get(scope) ?? new Set<string>();
					bindings.add(name.text);
					lexicalValueBindings.set(scope, bindings);
				}
			};
			if (ts.isVariableDeclaration(node)) {
				registerName(node.name, node);
			} else if (ts.isClassDeclaration(node) && node.name) {
				registerName(node.name, node);
			}
			ts.forEachChild(node, visitBindings);
		};
		visitBindings(file);
	}
	const lexicalCallableTargets = (identifier: ts.Identifier, owner: SemanticOwner): Set<SemanticTarget> => {
		const body = nodesById.get(owner.id)?.body;
		let current: ts.Node | undefined = identifier.parent;
		while (current) {
			if (lexicalValueBindings.get(current)?.has(identifier.text)) return new Set();
			if (current === body && parameterTargets.get(owner.id)?.has(identifier.text)) return new Set();
			const declarations = lexicalCallables.get(current)?.get(identifier.text);
			if (declarations?.length) {
				return new Set(declarations.map(({ id }) => `function:${id}` as SemanticTarget));
			}
			current = current.parent;
		}
		return new Set();
	};
	const localInitializer = (identifier: ts.Identifier, owner: SemanticOwner): ts.Expression | undefined => {
		const body = nodesById.get(owner.id)?.body;
		let current: ts.Node | undefined = identifier.parent;
		while (current) {
			const initializer = lexicalInitializers.get(current)?.get(identifier.text);
			if (initializer) return initializer;
			if (current === body) return undefined;
			current = current.parent;
		}
		return undefined;
	};
	const isParameterReference = (identifier: ts.Identifier, owner: SemanticOwner): boolean => {
		if (!parameterTargets.get(owner.id)?.has(identifier.text)) return false;
		const body = nodesById.get(owner.id)?.body;
		if (identifier === body) return true;
		let current: ts.Node | undefined = identifier.parent;
		while (current) {
			if (current === body) return true;
			if (lexicalValueBindings.get(current)?.has(identifier.text)) return false;
			if (lexicalProjections.get(current)?.has(identifier.text)) return false;
			current = current.parent;
		}
		return false;
	};
	for (const file of files) {
		const owner = moduleOwner(file.fileName);
		for (const statement of file.statements) {
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (owner) registerDestructuring(declaration, owner);
					if (ts.isIdentifier(declaration.name)) {
						moduleBindings.add(`${file.fileName}:${declaration.name.text}`);
						if (declaration.initializer) {
							moduleVariables.set(`${file.fileName}:${declaration.name.text}`, declaration.initializer);
						}
					}
				}
			}
		}
		const visitClasses = (child: ts.Node): void => {
			if (ts.isClassDeclaration(child) || ts.isClassExpression(child)) {
				const target = semanticClassTarget(file, child);
				classes.set(target, child);
				const localName =
					child.name?.text ??
					(ts.isVariableDeclaration(child.parent) && ts.isIdentifier(child.parent.name)
						? child.parent.name.text
						: undefined);
				if (localName) localClasses.set(`${file.fileName}:${localName}`, target);
			}
			ts.forEachChild(child, visitClasses);
		};
		visitClasses(file);
	}

	const exportTargets = (
		moduleName: string,
		exportName: string,
		seen: Set<string> = new Set(),
		failClosed = true
	): Set<SemanticTarget> => {
		const key = `${moduleName}:${exportName}`;
		if (seen.has(key)) return new Set();
		seen.add(key);
		const binding = modules.get(moduleName)?.exports.get(exportName);
		if (typeof binding === "string") return new Set([binding]);
		if (binding?.primitive) return new Set<SemanticTarget>([`primitive:${binding.primitive}`]);
		if (binding?.expression) {
			const definingOwner = moduleOwner(binding.moduleName ?? moduleName);
			return definingOwner
				? expressionTargets(binding.expression, definingOwner, new Set(seen))
				: new Set<SemanticTarget>(["primitive:unresolvedInternal"]);
		}
		if (binding?.moduleName) {
			if (binding.moduleName === moduleName) {
				const localBinding = moduleFunctions.get(`${moduleName}:${binding.exportName}`);
				if (localBinding) return new Set<SemanticTarget>([`function:${localBinding.id}`]);
			}
			return exportTargets(binding.moduleName, binding.exportName, seen, failClosed);
		}
		const local = moduleFunctions.get(key);
		if (local) return new Set<SemanticTarget>([`function:${local.id}`]);
		const targets = new Set<SemanticTarget>();
		for (const starModule of modules.get(moduleName)?.starExports ?? []) {
			for (const target of exportTargets(starModule, exportName, new Set(seen), false)) targets.add(target);
		}
		if (targets.size === 0 && failClosed && modules.has(moduleName)) targets.add("primitive:unresolvedInternal");
		return targets;
	};
	const keyResolution = (expression: ts.Expression, owner: SemanticOwner, seen: Set<string>): KeyResolution => {
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return keyResolution(transparent, owner, seen);
		if (
			ts.isStringLiteral(expression) ||
			ts.isNoSubstitutionTemplateLiteral(expression) ||
			ts.isNumericLiteral(expression)
		) {
			return { unknown: false, values: new Set([expression.text]) };
		}
		if (ts.isIdentifier(expression)) {
			const key = `${owner.id}:key:${expression.text}`;
			if (seen.has(key)) return { unknown: true, values: new Set() };
			seen.add(key);
			const initializer =
				localInitializer(expression, owner) ?? moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			return initializer ? keyResolution(initializer, owner, seen) : { unknown: true, values: new Set<string>() };
		}
		if (ts.isConditionalExpression(expression)) {
			const whenTrue = keyResolution(expression.whenTrue, owner, new Set(seen));
			const whenFalse = keyResolution(expression.whenFalse, owner, new Set(seen));
			return {
				unknown: whenTrue.unknown || whenFalse.unknown,
				values: new Set([...whenTrue.values, ...whenFalse.values]),
			};
		}
		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = keyResolution(expression.left, owner, new Set(seen));
			const right = keyResolution(expression.right, owner, new Set(seen));
			const values = new Set<string>();
			for (const leftValue of left.values) {
				for (const rightValue of right.values) values.add(leftValue + rightValue);
			}
			return { unknown: left.unknown || right.unknown || values.size === 0, values };
		}
		return { unknown: true, values: new Set() };
	};
	const accessKeys = (
		expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
		owner: SemanticOwner,
		seen: Set<string>
	): KeyResolution =>
		ts.isPropertyAccessExpression(expression)
			? { unknown: false, values: new Set([expression.name.text]) }
			: expression.argumentExpression
				? keyResolution(expression.argumentExpression, owner, seen)
				: { unknown: true, values: new Set() };
	const memberTargets = (
		classTarget: string,
		name: string,
		wantStatic: boolean,
		owner: SemanticOwner,
		seen: Set<string>
	): Set<SemanticTarget> => {
		const normalizedClassTarget = classTarget.replace(/^instance:/, "class:");
		const memberKey = `${normalizedClassTarget}:${wantStatic ? "static" : "instance"}:${name}`;
		if (seen.has(memberKey)) return new Set();
		seen.add(memberKey);
		const declaration = classes.get(normalizedClassTarget);
		const result = new Set<SemanticTarget>();
		if (!declaration) return new Set(["primitive:unresolvedInternal"]);
		let foundOwnMember = false;
		const containerId = wantStatic ? normalizedClassTarget : `instance:${normalizedClassTarget.slice("class:".length)}`;
		for (const target of storedPropertyTargets(containerId, name)) result.add(target);
		const definingOwner: SemanticOwner = {
			className:
				declaration.name?.text ??
				(ts.isVariableDeclaration(declaration.parent) && ts.isIdentifier(declaration.parent.name)
					? declaration.parent.name.text
					: undefined),
			file: declaration.getSourceFile(),
			id: `${normalizedClassTarget}:members`,
		};
		for (const member of declaration.members) {
			if (!member.name) continue;
			const memberNames = ts.isComputedPropertyName(member.name)
				? keyResolution(member.name.expression, owner, new Set(seen)).values
				: ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
					? new Set([member.name.text])
					: new Set<string>();
			if (!memberNames.has(name)) continue;
			const isStatic = Boolean(
				ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword)
			);
			if (isStatic !== wantStatic) continue;
			foundOwnMember = true;
			if (ts.isMethodDeclaration(member)) {
				const callable = nodesByDeclaration.get(member);
				if (callable) result.add(`function:${callable.id}`);
				else result.add("primitive:unresolvedInternal");
			} else if (ts.isPropertyDeclaration(member) && member.initializer) {
				for (const target of expressionTargets(member.initializer, definingOwner, new Set(seen))) result.add(target);
			} else if (ts.isGetAccessorDeclaration(member)) {
				const getter = nodesByDeclaration.get(member);
				if (getter) {
					for (const target of returnedTargets.get(getter.id) ?? []) result.add(target);
				} else result.add("primitive:unresolvedInternal");
			}
		}
		const heritage = declaration.heritageClauses
			?.filter(({ token }) => token === ts.SyntaxKind.ExtendsKeyword)
			.flatMap(({ types }) => [...types]);
		for (const base of foundOwnMember ? [] : (heritage ?? [])) {
			const baseOwner: SemanticOwner = {
				file: declaration.getSourceFile(),
				id: `${normalizedClassTarget}:heritage`,
			};
			const baseTargets = expressionTargets(base.expression, baseOwner, new Set(seen));
			if (baseTargets.size === 0) {
				result.add("primitive:unresolvedInternal");
				continue;
			}
			for (const baseTarget of baseTargets) {
				if (!baseTarget.startsWith("class:")) {
					result.add("primitive:unresolvedInternal");
					continue;
				}
				for (const inherited of memberTargets(
					wantStatic ? baseTarget : `instance:${baseTarget.slice("class:".length)}`,
					name,
					wantStatic,
					baseOwner,
					new Set(seen)
				)) {
					result.add(inherited);
				}
			}
		}
		return result;
	};
	const bindingKey = (name: string, owner: SemanticOwner): string => {
		const moduleKey = `${owner.file.fileName}:${name}`;
		return moduleBindings.has(moduleKey) ? moduleKey : `${owner.id}:${name}`;
	};
	const isCallableLikeTarget = (target: SemanticTarget): boolean =>
		target.startsWith("function:") ||
		target.startsWith("callable:") ||
		target.startsWith("primitive:") ||
		target === "builtin:Function" ||
		target === "builtin:functionCall" ||
		target === "builtin:functionApply" ||
		target === "builtin:functionBind" ||
		target === "builtin:jsonParse" ||
		target === "builtin:jsonStringify";
	const isCallableLikeReceiver = (targets: ReadonlySet<SemanticTarget>): boolean =>
		targets.size > 0 && [...targets].every(isCallableLikeTarget);
	const callableLikeTargets = (targets: ReadonlySet<SemanticTarget>): Set<SemanticTarget> =>
		new Set([...targets].filter(isCallableLikeTarget));
	const bindingContainer = (name: string, owner: SemanticOwner): string => `binding:${bindingKey(name, owner)}`;
	const containerIds = (
		expression: ts.Expression,
		owner: SemanticOwner,
		seen: Set<string> = new Set()
	): Set<string> => {
		const expressionKey = `${owner.id}:container:${expression.pos}:${expression.end}`;
		if (seen.has(expressionKey)) return new Set();
		seen.add(expressionKey);
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return containerIds(transparent, owner, seen);
		if (ts.isConditionalExpression(expression)) {
			const result = containerIds(expression.whenTrue, owner, new Set(seen));
			for (const id of containerIds(expression.whenFalse, owner, new Set(seen))) result.add(id);
			return result;
		}
		if (ts.isIdentifier(expression)) {
			const result = new Set([bindingContainer(expression.text, owner)]);
			const initializer =
				localInitializer(expression, owner) ?? moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			if (initializer) {
				for (const nested of containerIds(initializer, owner, new Set(seen))) result.add(nested);
			}
			for (const target of storedTargets.get(bindingKey(expression.text, owner)) ?? []) {
				if (target.startsWith("object:") || target.startsWith("class:") || target.startsWith("instance:")) {
					result.add(target);
				}
			}
			if (isParameterReference(expression, owner)) {
				for (const target of parameterTargets.get(owner.id)?.get(expression.text) ?? []) {
					if (target.startsWith("object:") || target.startsWith("class:") || target.startsWith("instance:")) {
						result.add(target);
					}
				}
			}
			const projection = projectionForIdentifier(expression);
			if (projection?.kind === "object-rest" || projection?.kind === "array-rest") result.add(projection.target);
			const localClass = localClasses.get(`${owner.file.fileName}:${expression.text}`);
			if (localClass) result.add(localClass);
			const imported = modules.get(owner.file.fileName)?.imports.get(expression.text);
			if (imported?.moduleName) {
				for (const target of exportTargets(imported.moduleName, imported.exportName)) {
					if (target.startsWith("object:") || target.startsWith("class:") || target.startsWith("instance:")) {
						result.add(target);
					}
				}
			}
			return result;
		}
		if (expression.kind === ts.SyntaxKind.ThisKeyword && owner.className) {
			if (owner.staticClassTarget) return new Set([owner.staticClassTarget]);
			const localClass = localClasses.get(`${owner.file.fileName}:${owner.className}`);
			return localClass ? new Set([`instance:${localClass.slice("class:".length)}`]) : new Set();
		}
		if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
			return new Set([`object:${owner.file.fileName}:container@${expression.pos}`]);
		}
		if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
			const result = new Set<string>();
			for (const target of expressionTargets(expression, owner, new Set(seen))) {
				if (target.startsWith("object:") || target.startsWith("class:") || target.startsWith("instance:")) {
					result.add(target);
				}
			}
			return result;
		}
		return new Set();
	};
	const containerTarget = (
		expression: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
		owner: SemanticOwner
	): SemanticTarget => {
		const target = `object:${owner.file.fileName}:container@${expression.pos}` as SemanticTarget;
		containerValues.set(target, { expression, owner });
		return target;
	};
	const propertyTargets = (
		expression: ts.Expression,
		name: string,
		owner: SemanticOwner,
		seen: Set<string>
	): Set<SemanticTarget> => {
		const propertyKey = `${owner.id}:property:${expression.pos}:${expression.end}:${name}`;
		if (seen.has(propertyKey)) return new Set();
		seen.add(propertyKey);
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return propertyTargets(transparent, name, owner, seen);
		if (ts.isConditionalExpression(expression)) {
			const result = propertyTargets(expression.whenTrue, name, owner, new Set(seen));
			for (const target of propertyTargets(expression.whenFalse, name, owner, new Set(seen))) result.add(target);
			return result;
		}
		if (ts.isIdentifier(expression)) {
			if (expression.text === "JSON") {
				return name === "parse"
					? new Set(["builtin:jsonParse"])
					: name === "stringify"
						? new Set(["builtin:jsonStringify"])
						: new Set();
			}
			if (expression.text === "globalThis") {
				return name === "JSON"
					? new Set(["builtin:json"])
					: name === "structuredClone"
						? new Set(["primitive:structuredClone"])
						: new Set();
			}
			if (expression.text === "Function" && name === "prototype") {
				return new Set(["builtin:FunctionPrototype"]);
			}
			const result = new Set<SemanticTarget>();
			for (const containerId of containerIds(expression, owner)) {
				for (const target of storedPropertyTargets(containerId, name)) result.add(target);
			}
			const projection = projectionForIdentifier(expression);
			if (projection?.kind === "object-rest" && projection.source && !projection.excluded.has(name)) {
				for (const target of propertyTargets(projection.source, name, projection.owner, new Set(seen)))
					result.add(target);
			}
			const namespace = modules.get(owner.file.fileName)?.namespaces.get(expression.text);
			if (namespace) {
				if (modules.get(owner.file.fileName)?.unresolvedNamespaces.has(expression.text)) {
					result.add("primitive:unresolvedInternal");
				} else {
					const primitive = importedPrimitive(namespace, name);
					for (const target of primitive
						? new Set<SemanticTarget>([`primitive:${primitive}`])
						: modules.has(namespace)
							? exportTargets(namespace, name)
							: new Set<SemanticTarget>())
						result.add(target);
				}
			}
			const variable = localInitializer(expression, owner);
			if (variable) for (const target of propertyTargets(variable, name, owner, seen)) result.add(target);
			const moduleVariable = moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			if (moduleVariable) for (const target of propertyTargets(moduleVariable, name, owner, seen)) result.add(target);
			if (result.size) return result;
		}
		if (ts.isArrayLiteralExpression(expression)) {
			const result = new Set<SemanticTarget>();
			for (const containerId of containerIds(expression, owner)) {
				for (const target of storedPropertyTargets(containerId, name)) result.add(target);
			}
			const index = Number(name);
			const shape = arrayArguments(expression, owner, new Set(seen));
			const argument = Number.isInteger(index) && index >= 0 ? shape.arguments[index] : undefined;
			for (const target of argument?.targets ?? []) result.add(target);
			if (Number.isInteger(index) && index >= 0 && shape.unknown) {
				result.add("primitive:unresolvedInternal");
			}
			return result;
		}
		if (ts.isObjectLiteralExpression(expression)) {
			const result = new Set<SemanticTarget>();
			for (const containerId of containerIds(expression, owner)) {
				for (const target of storedPropertyTargets(containerId, name)) result.add(target);
			}
			for (const candidate of expression.properties) {
				if (ts.isSpreadAssignment(candidate)) {
					for (const target of propertyTargets(candidate.expression, name, owner, new Set(seen))) result.add(target);
					continue;
				}
				if (!candidate.name) continue;
				const candidateNames = ts.isComputedPropertyName(candidate.name)
					? keyResolution(candidate.name.expression, owner, new Set(seen)).values
					: ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name) || ts.isNumericLiteral(candidate.name)
						? new Set([candidate.name.text])
						: new Set<string>();
				if (!candidateNames.has(name)) continue;
				if (ts.isPropertyAssignment(candidate)) {
					for (const target of expressionTargets(candidate.initializer, owner, new Set(seen))) result.add(target);
				} else if (ts.isShorthandPropertyAssignment(candidate)) {
					for (const target of expressionTargets(candidate.name, owner, new Set(seen))) result.add(target);
				} else if (ts.isMethodDeclaration(candidate)) {
					const callable = nodesByDeclaration.get(candidate);
					if (callable) result.add(`function:${callable.id}`);
				} else if (ts.isGetAccessorDeclaration(candidate)) {
					const getter = nodesByDeclaration.get(candidate);
					for (const target of returnedTargets.get(getter?.id ?? "") ?? []) result.add(target);
				}
			}
			return result;
		}
		const result = new Set<SemanticTarget>();
		for (const target of expressionTargets(expression, owner, new Set(seen))) {
			if (target === "primitive:unresolvedInternal") {
				result.add(target);
			} else if (target === "builtin:json") {
				if (name === "parse") result.add("builtin:jsonParse");
				if (name === "stringify") result.add("builtin:jsonStringify");
			} else if (target === "builtin:globalThis") {
				if (name === "JSON") result.add("builtin:json");
				if (name === "structuredClone") result.add("primitive:structuredClone");
			} else if (target === "builtin:Function" && name === "prototype") {
				result.add("builtin:FunctionPrototype");
			} else if (target === "builtin:FunctionPrototype") {
				if (name === "call") result.add("builtin:functionCall");
				if (name === "apply") result.add("builtin:functionApply");
				if (name === "bind") result.add("builtin:functionBind");
			} else if (isCallableLikeTarget(target)) {
				if (name === "call") result.add("builtin:functionCall");
				if (name === "apply") result.add("builtin:functionApply");
				if (name === "bind") result.add("builtin:functionBind");
			} else if (target.startsWith("namespace:")) {
				const moduleName = target.slice("namespace:".length);
				const primitive = importedPrimitive(moduleName, name);
				for (const nested of primitive
					? new Set<SemanticTarget>([`primitive:${primitive}`])
					: exportTargets(moduleName, name))
					result.add(nested);
			} else if (target.startsWith("object:")) {
				const projection = projectionValues.get(target);
				for (const nested of storedPropertyTargets(target, name)) result.add(nested);
				if (projection?.kind === "object-rest" && projection.source && !projection.excluded.has(name)) {
					for (const nested of propertyTargets(projection.source, name, projection.owner, new Set(seen))) {
						result.add(nested);
					}
				} else if (projection?.kind === "array-rest" && projection.source) {
					const index = Number(name);
					const shape = arrayArguments(projection.source, projection.owner, new Set(seen));
					const argument =
						Number.isInteger(index) && index >= 0 ? shape.arguments[projection.start + index] : undefined;
					for (const nested of argument?.targets ?? []) result.add(nested);
					if (Number.isInteger(index) && index >= 0 && shape.unknown) result.add("primitive:unresolvedInternal");
				}
				const container = containerValues.get(target);
				if (container) {
					for (const nested of propertyTargets(container.expression, name, container.owner, new Set(seen))) {
						result.add(nested);
					}
				}
			} else if (target.startsWith("class:")) {
				for (const nested of memberTargets(target, name, true, owner, new Set(seen))) result.add(nested);
			} else if (target.startsWith("instance:")) {
				for (const nested of memberTargets(target, name, false, owner, new Set(seen))) result.add(nested);
			}
		}
		return result;
	};
	const moduleMemberNames = (moduleName: string, seen: Set<string> = new Set()): Set<string> => {
		if (seen.has(moduleName)) return new Set();
		seen.add(moduleName);
		const result = new Set(modules.get(moduleName)?.exports.keys() ?? []);
		for (const star of modules.get(moduleName)?.starExports ?? []) {
			for (const name of moduleMemberNames(star, new Set(seen))) result.add(name);
		}
		return result;
	};
	const knownPropertyNames = (
		expression: ts.Expression,
		owner: SemanticOwner,
		seen: Set<string> = new Set()
	): Set<string> => {
		const expressionKey = `${owner.id}:members:${expression.pos}:${expression.end}`;
		if (seen.has(expressionKey)) return new Set();
		seen.add(expressionKey);
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return knownPropertyNames(transparent, owner, seen);
		if (ts.isConditionalExpression(expression)) {
			const result = knownPropertyNames(expression.whenTrue, owner, new Set(seen));
			for (const name of knownPropertyNames(expression.whenFalse, owner, new Set(seen))) result.add(name);
			return result;
		}
		if (ts.isIdentifier(expression)) {
			if (expression.text === "JSON") return new Set(["parse", "stringify"]);
			if (expression.text === "globalThis") return new Set(["JSON", "structuredClone"]);
			const namespace = modules.get(owner.file.fileName)?.namespaces.get(expression.text);
			if (namespace) return moduleMemberNames(namespace);
			const projection = projectionForIdentifier(expression);
			if (projection?.kind === "object-rest") {
				const result = projection.source
					? knownPropertyNames(projection.source, projection.owner, seen)
					: new Set<string>();
				for (const excluded of projection.excluded) result.delete(excluded);
				for (const slot of propertyFacts.get(projection.target)?.keys() ?? []) {
					if (typeof slot === "string") result.add(slot);
				}
				return result;
			}
			if (projection?.kind === "array-rest") {
				const shape = arrayArguments(expression, owner, new Set(seen));
				return new Set(shape.arguments.map((_argument, index) => String(index)));
			}
			const initializer =
				localInitializer(expression, owner) ?? moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			if (initializer) return knownPropertyNames(initializer, owner, seen);
		}
		if (ts.isArrayLiteralExpression(expression)) {
			const shape = arrayArguments(expression, owner, new Set(seen));
			const result = new Set(shape.arguments.map((_argument, index) => String(index)));
			for (const containerId of containerIds(expression, owner, new Set(seen))) {
				for (const slot of propertyFacts.get(containerId)?.keys() ?? []) {
					if (typeof slot === "string") result.add(slot);
				}
			}
			return result;
		}
		if (ts.isObjectLiteralExpression(expression)) {
			const result = new Set<string>();
			for (const containerId of containerIds(expression, owner, new Set(seen))) {
				for (const slot of propertyFacts.get(containerId)?.keys() ?? []) {
					if (typeof slot === "string") result.add(slot);
				}
			}
			for (const property of expression.properties) {
				if (ts.isSpreadAssignment(property)) {
					for (const name of knownPropertyNames(property.expression, owner, new Set(seen))) result.add(name);
					continue;
				}
				if (!property.name) continue;
				const names = ts.isComputedPropertyName(property.name)
					? keyResolution(property.name.expression, owner, new Set()).values
					: ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
						? new Set([property.name.text])
						: new Set<string>();
				for (const name of names) result.add(name);
			}
			return result;
		}
		const result = new Set<string>();
		for (const target of expressionTargets(expression, owner, new Set(seen))) {
			if (target.startsWith("namespace:")) {
				for (const name of moduleMemberNames(target.slice("namespace:".length))) result.add(name);
			} else if (target.startsWith("object:")) {
				const projection = projectionValues.get(target);
				if (projection?.kind === "object-rest") {
					if (projection.source) {
						for (const name of knownPropertyNames(projection.source, projection.owner, new Set(seen))) {
							if (!projection.excluded.has(name)) result.add(name);
						}
					}
					for (const slot of propertyFacts.get(projection.target)?.keys() ?? []) {
						if (typeof slot === "string") result.add(slot);
					}
				} else if (projection?.kind === "array-rest" && projection.source) {
					const shape = arrayArguments(projection.source, projection.owner, new Set(seen));
					for (let index = projection.start; index < shape.arguments.length; index++) {
						result.add(String(index - projection.start));
					}
				}
				const container = containerValues.get(target);
				if (container) {
					for (const name of knownPropertyNames(container.expression, container.owner, new Set(seen))) result.add(name);
				}
			} else if (target === "builtin:json") {
				result.add("parse");
				result.add("stringify");
			} else if (target === "builtin:globalThis") {
				result.add("JSON");
				result.add("structuredClone");
			}
		}
		return result;
	};
	const propertyTargetsForKeys = (
		expression: ts.Expression,
		keys: KeyResolution,
		owner: SemanticOwner,
		seen: Set<string>
	): Set<SemanticTarget> => {
		const result = new Set<SemanticTarget>();
		const names = new Set(keys.values);
		if (keys.unknown) {
			for (const containerId of containerIds(expression, owner, new Set(seen))) {
				for (const target of storedUnknownPropertyTargets(containerId)) result.add(target);
			}
			for (const receiverTarget of expressionTargets(expression, owner, new Set(seen))) {
				if (
					receiverTarget.startsWith("object:") ||
					receiverTarget.startsWith("class:") ||
					receiverTarget.startsWith("instance:")
				) {
					for (const target of storedUnknownPropertyTargets(receiverTarget)) result.add(target);
				}
			}
			for (const name of knownPropertyNames(expression, owner, new Set(seen))) names.add(name);
		}
		for (const name of names) {
			for (const target of propertyTargets(expression, name, owner, new Set(seen))) result.add(target);
		}
		return result;
	};
	const isDefinitelyUndefined = (expression: ts.Expression, owner: SemanticOwner): boolean => {
		const transparent = transparentExpression(expression);
		if (ts.isVoidExpression(transparent)) return true;
		if (!ts.isIdentifier(transparent) || transparent.text !== "undefined") return false;
		if (isParameterReference(transparent, owner)) return false;
		if (modules.get(owner.file.fileName)?.imports.has("undefined")) return false;
		if (moduleBindings.has(`${owner.file.fileName}:undefined`)) return false;
		if (lexicalCallableTargets(transparent, owner).size > 0) return false;
		let current: ts.Node | undefined = transparent.parent;
		while (current) {
			if (lexicalValueBindings.get(current)?.has("undefined")) return false;
			current = current.parent;
		}
		return true;
	};
	const semanticArgument = (expression: ts.Expression, owner: SemanticOwner): SemanticArgument => ({
		definitelyUndefined: isDefinitelyUndefined(expression, owner),
		owner,
		source: expression,
		targets: expressionTargets(expression, owner),
	});
	interface ArrayResolution {
		readonly arguments: readonly SemanticArgument[];
		readonly unknown: boolean;
	}
	const mergeArrayResolutions = (resolutions: readonly ArrayResolution[]): ArrayResolution => {
		if (resolutions.length === 0) return { arguments: [], unknown: true };
		const length = Math.max(...resolutions.map(({ arguments: values }) => values.length));
		const arguments_: SemanticArgument[] = [];
		for (let index = 0; index < length; index++) {
			const candidates = resolutions.map(({ arguments: values }) => values[index]).filter(Boolean);
			const representative = candidates[0];
			const targets = new Set<SemanticTarget>();
			for (const candidate of candidates) joinTargets(targets, candidate.targets);
			arguments_.push({
				definitelyUndefined:
					candidates.length > 0 && candidates.every(({ definitelyUndefined }) => definitelyUndefined),
				owner: representative?.owner,
				source: representative?.source,
				targets,
			});
		}
		return {
			arguments: arguments_,
			unknown:
				resolutions.some(({ unknown }) => unknown) ||
				resolutions.some(({ arguments: values }) => values.length !== length),
		};
	};
	const arrayArguments = (
		expression: ts.Expression,
		owner: SemanticOwner,
		seen: Set<string> = new Set()
	): ArrayResolution => {
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return arrayArguments(transparent, owner, seen);
		const expressionKey = `${owner.id}:array:${expression.pos}:${expression.end}`;
		if (seen.has(expressionKey)) return { arguments: [], unknown: true };
		seen.add(expressionKey);
		if (ts.isIdentifier(expression)) {
			const resolutions: ArrayResolution[] = [];
			const projection = projectionForIdentifier(expression);
			if (projection?.kind === "array-rest") {
				const source = projection.source
					? arrayArguments(projection.source, projection.owner, new Set(seen))
					: { arguments: [], unknown: false };
				const arguments_: SemanticArgument[] = source.arguments
					.slice(projection.start)
					.map(({ owner: argumentOwner, source, targets }) => ({
						owner: argumentOwner,
						source,
						targets: new Set(targets),
					}));
				for (const [slot, targets] of propertyFacts.get(projection.target) ?? []) {
					if (slot === unknownProperty) continue;
					const index = Number(slot);
					if (!Number.isInteger(index) || index < 0) continue;
					while (arguments_.length <= index) arguments_.push({ targets: new Set() });
					joinTargets(arguments_[index].targets, targets);
				}
				resolutions.push({
					arguments: arguments_,
					unknown: source.unknown || propertyFacts.get(projection.target)?.has(unknownProperty) === true,
				});
			}
			const initializer =
				localInitializer(expression, owner) ?? moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			if (initializer) resolutions.push(arrayArguments(initializer, owner, new Set(seen)));
			const containerTargets = new Set<SemanticTarget>();
			for (const target of storedTargets.get(bindingKey(expression.text, owner)) ?? []) {
				if (target.startsWith("object:")) containerTargets.add(target);
			}
			const imported = modules.get(owner.file.fileName)?.imports.get(expression.text);
			if (imported?.moduleName) {
				for (const target of exportTargets(imported.moduleName, imported.exportName)) {
					if (target.startsWith("object:")) containerTargets.add(target);
				}
			}
			for (const target of containerTargets) {
				const container = containerValues.get(target);
				if (!container || !ts.isArrayLiteralExpression(container.expression) || container.expression === initializer)
					continue;
				resolutions.push(arrayArguments(container.expression, container.owner, new Set(seen)));
			}
			return mergeArrayResolutions(resolutions);
		}
		if (!ts.isArrayLiteralExpression(expression)) {
			const resolutions: ArrayResolution[] = [];
			for (const target of expressionTargets(expression, owner, new Set(seen))) {
				if (!target.startsWith("object:")) continue;
				const container = containerValues.get(target);
				if (container && ts.isArrayLiteralExpression(container.expression)) {
					resolutions.push(arrayArguments(container.expression, container.owner, new Set(seen)));
				}
			}
			return mergeArrayResolutions(resolutions);
		}
		const result: SemanticArgument[] = [];
		let unknown = false;
		for (const element of expression.elements) {
			if (ts.isSpreadElement(element)) {
				const spread = arrayArguments(element.expression, owner, new Set(seen));
				result.push(...spread.arguments);
				unknown ||= spread.unknown;
			} else if (ts.isOmittedExpression(element)) {
				result.push({ definitelyUndefined: true, targets: new Set() });
			} else {
				result.push(semanticArgument(element, owner));
			}
		}
		for (const containerId of containerIds(expression, owner)) {
			const properties = propertyFacts.get(containerId);
			for (const slot of properties?.keys() ?? []) {
				if (slot === unknownProperty) {
					unknown = true;
					continue;
				}
				const index = Number(slot);
				if (!Number.isInteger(index) || index < 0) continue;
				while (result.length <= index) result.push({ targets: new Set() });
				joinTargets(result[index].targets, storedPropertyTargets(containerId, slot));
			}
		}
		return { arguments: result, unknown };
	};
	const invocationArguments = (expressions: readonly ts.Expression[], owner: SemanticOwner): ArrayResolution => {
		const arguments_: SemanticArgument[] = [];
		let unknown = false;
		for (const expression of expressions) {
			if (ts.isSpreadElement(expression)) {
				const spread = arrayArguments(expression.expression, owner);
				arguments_.push(...spread.arguments);
				unknown ||= spread.unknown;
			} else {
				arguments_.push(semanticArgument(expression, owner));
			}
		}
		return { arguments: arguments_, unknown };
	};
	function expressionTargets(
		expression: ts.Expression,
		owner: SemanticOwner,
		seen: Set<string> = new Set()
	): Set<SemanticTarget> {
		const expressionKey = `${owner.id}:${expression.pos}:${expression.end}`;
		if (seen.has(expressionKey)) return new Set();
		seen.add(expressionKey);
		const transparent = transparentExpression(expression);
		if (transparent !== expression) return expressionTargets(transparent, owner, seen);
		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
			return expressionTargets(expression.right, owner, seen);
		}
		if (
			ts.isBinaryExpression(expression) &&
			(logicalValueOperators.has(expression.operatorToken.kind) ||
				logicalAssignmentOperators.has(expression.operatorToken.kind))
		) {
			const result = expressionTargets(expression.left, owner, new Set(seen));
			joinTargets(result, expressionTargets(expression.right, owner, new Set(seen)));
			return result;
		}
		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			return expressionTargets(expression.right, owner, seen);
		}
		if (ts.isConditionalExpression(expression)) {
			const result = expressionTargets(expression.whenTrue, owner, new Set(seen));
			for (const target of expressionTargets(expression.whenFalse, owner, new Set(seen))) result.add(target);
			return result;
		}
		if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
			const callable = nodesByDeclaration.get(expression);
			return callable ? new Set<SemanticTarget>([`function:${callable.id}`]) : new Set();
		}
		if (ts.isIdentifier(expression)) {
			if (expression.text === "structuredClone") return new Set(["primitive:structuredClone"]);
			if (expression.text === "JSON") return new Set(["builtin:json"]);
			if (expression.text === "globalThis") return new Set(["builtin:globalThis"]);
			if (expression.text === "Function") return new Set(["builtin:Function"]);
			const result = new Set<SemanticTarget>();
			for (const target of lexicalCallableTargets(expression, owner)) result.add(target);
			const parameter = isParameterReference(expression, owner)
				? parameterTargets.get(owner.id)?.get(expression.text)
				: undefined;
			for (const target of parameter ?? []) result.add(target);
			for (const target of storedTargets.get(`${owner.id}:${expression.text}`) ?? []) result.add(target);
			for (const target of storedTargets.get(`${owner.file.fileName}:${expression.text}`) ?? []) result.add(target);
			const projection = projectionForIdentifier(expression);
			if (projection?.kind === "object-property") {
				for (const target of propertyTargets(projection.source, projection.property, projection.owner, seen)) {
					result.add(target);
				}
			} else if (projection?.kind === "array-index") {
				for (const target of propertyTargets(projection.source, String(projection.index), projection.owner, seen)) {
					result.add(target);
				}
			} else if (projection?.kind === "object-rest" || projection?.kind === "array-rest") {
				result.add(projection.target);
			}
			const variable = localInitializer(expression, owner);
			if (variable) for (const target of expressionTargets(variable, owner, seen)) result.add(target);
			const moduleVariable = moduleVariables.get(`${owner.file.fileName}:${expression.text}`);
			if (moduleVariable) for (const target of expressionTargets(moduleVariable, owner, seen)) result.add(target);
			const imported = modules.get(owner.file.fileName)?.imports.get(expression.text);
			if (imported?.primitive) result.add(`primitive:${imported.primitive}`);
			if (imported?.unresolvedInternal) result.add("primitive:unresolvedInternal");
			if (imported?.moduleName) {
				for (const target of exportTargets(imported.moduleName, imported.exportName)) result.add(target);
			}
			const namespace = modules.get(owner.file.fileName)?.namespaces.get(expression.text);
			if (namespace) {
				result.add(
					modules.get(owner.file.fileName)?.unresolvedNamespaces.has(expression.text)
						? "primitive:unresolvedInternal"
						: `namespace:${namespace}`
				);
			}
			const localClass = localClasses.get(`${owner.file.fileName}:${expression.text}`);
			if (localClass) result.add(localClass);
			const local = moduleFunctions.get(`${owner.file.fileName}:${expression.text}`);
			if (local) result.add(`function:${local.id}`);
			return result;
		}
		if (ts.isCallExpression(expression)) {
			const callee = expression.expression;
			const keys =
				ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
					? accessKeys(callee, owner, new Set(seen))
					: undefined;
			const receiverTargets =
				ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
					? expressionTargets(callee.expression, owner, new Set(seen))
					: new Set<SemanticTarget>();
			const callableReceivers = callableLikeTargets(receiverTargets);
			const result = new Set<SemanticTarget>();
			if (
				keys?.values.has("bind") &&
				!keys.unknown &&
				(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
				callableReceivers.size > 0
			) {
				const token = `${owner.id}:${expression.pos}:${expression.end}`;
				const boundArguments = invocationArguments(expression.arguments.slice(1), owner);
				boundCallables.set(token, {
					arguments: boundArguments.arguments,
					targets: callableReceivers,
					thisArgument: expression.arguments[0] ? semanticArgument(expression.arguments[0], owner) : undefined,
					unknownArguments: boundArguments.unknown,
				});
				result.add(`callable:${token}`);
				if (isCallableLikeReceiver(receiverTargets)) return result;
			}
			const calleeTargets = expressionTargets(callee, owner, new Set(seen));
			if (!keys?.unknown && keys?.values.size === 1 && receiverTargets.has("builtin:functionBind")) {
				const token = `${owner.id}:${expression.pos}:${expression.end}`;
				if (keys.values.has("call")) {
					const boundArguments = invocationArguments(expression.arguments.slice(2), owner);
					boundCallables.set(token, {
						arguments: boundArguments.arguments,
						targets: expression.arguments[0]
							? expressionTargets(expression.arguments[0], owner, new Set(seen))
							: new Set(),
						thisArgument: expression.arguments[1] ? semanticArgument(expression.arguments[1], owner) : undefined,
						unknownArguments: boundArguments.unknown,
					});
					return new Set<SemanticTarget>([`callable:${token}`]);
				}
				if (keys.values.has("apply")) {
					const unpacked = expression.arguments[1]
						? arrayArguments(expression.arguments[1], owner, new Set(seen))
						: { arguments: [], unknown: true };
					boundCallables.set(token, {
						arguments: unpacked.arguments.slice(1),
						targets: expression.arguments[0]
							? expressionTargets(expression.arguments[0], owner, new Set(seen))
							: new Set(),
						thisArgument: unpacked.arguments[0],
						unknownArguments: unpacked.unknown,
					});
					return new Set<SemanticTarget>([`callable:${token}`]);
				}
			}
			if (calleeTargets.has("builtin:jsonStringify")) return new Set(["provenance:jsonString"]);
			for (const target of calleeTargets) {
				if (!target.startsWith("function:")) continue;
				for (const returned of returnedTargets.get(target.slice("function:".length)) ?? []) result.add(returned);
			}
			return result;
		}
		if (ts.isNewExpression(expression)) {
			const result = new Set<SemanticTarget>();
			for (const target of expressionTargets(expression.expression, owner, seen)) {
				if (target.startsWith("class:")) result.add(`instance:${target.slice("class:".length)}`);
			}
			return result;
		}
		if (ts.isClassExpression(expression)) return new Set([semanticClassTarget(owner.file, expression)]);
		if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
			return new Set([containerTarget(expression, owner)]);
		}
		if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
			const keys = accessKeys(expression, owner, seen);
			const result = new Set<SemanticTarget>();
			if (expression.expression.kind === ts.SyntaxKind.ThisKeyword && owner.className) {
				if (owner.staticClassTarget) {
					for (const name of keys.values) {
						for (const target of memberTargets(owner.staticClassTarget, name, true, owner, new Set(seen))) {
							result.add(target);
						}
					}
					return result;
				}
				const localClass = localClasses.get(`${owner.file.fileName}:${owner.className}`);
				for (const name of keys.values) {
					const method = classMethods.get(`${owner.file.fileName}:${owner.className}:${name}`);
					if (method) result.add(`function:${method.id}`);
					if (localClass) {
						for (const target of memberTargets(
							`instance:${localClass.slice("class:".length)}`,
							name,
							false,
							owner,
							new Set(seen)
						)) {
							result.add(target);
						}
					}
				}
				return result;
			}
			if (expression.expression.kind === ts.SyntaxKind.SuperKeyword && owner.className) {
				const localClass = localClasses.get(`${owner.file.fileName}:${owner.className}`);
				const declaration = localClass ? classes.get(localClass) : undefined;
				for (const heritage of declaration?.heritageClauses ?? []) {
					if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
					for (const base of heritage.types) {
						for (const baseTarget of expressionTargets(base.expression, owner, new Set(seen))) {
							if (!baseTarget.startsWith("class:")) {
								result.add("primitive:unresolvedInternal");
								continue;
							}
							for (const name of keys.values) {
								for (const target of memberTargets(
									`instance:${baseTarget.slice("class:".length)}`,
									name,
									false,
									owner,
									new Set(seen)
								)) {
									result.add(target);
								}
							}
						}
					}
				}
				return result;
			}
			return propertyTargetsForKeys(expression.expression, keys, owner, seen);
		}
		return new Set();
	}

	interface Invocation {
		readonly arguments: readonly SemanticArgument[];
		readonly targets: Set<SemanticTarget>;
		readonly thisArgument?: SemanticArgument;
		readonly unknownArguments: boolean;
	}
	const invocations = (call: ts.CallExpression, owner: FunctionNode): Invocation[] => {
		if (
			ts.isPropertyAccessExpression(call.expression) &&
			call.expression.expression.getText(owner.file).replace(/\s+/g, "") === "Reflect" &&
			call.expression.name.text === "apply"
		) {
			const unpacked = call.arguments[2] ? arrayArguments(call.arguments[2], owner) : { arguments: [], unknown: true };
			return [
				{
					arguments: unpacked.arguments,
					targets: call.arguments[0] ? expressionTargets(call.arguments[0], owner) : new Set(),
					thisArgument: call.arguments[1] ? semanticArgument(call.arguments[1], owner) : undefined,
					unknownArguments: unpacked.unknown,
				},
			];
		}
		if (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) {
			const keys = accessKeys(call.expression, owner, new Set());
			const receiverTargets = expressionTargets(call.expression.expression, owner);
			const callableReceivers = callableLikeTargets(receiverTargets);
			const hasOrdinaryReceivers = callableReceivers.size !== receiverTargets.size;
			const supplied = invocationArguments(call.arguments, owner);
			const ordinaryInvocation = (): Invocation => ({
				arguments: supplied.arguments,
				targets: new Set(
					[...expressionTargets(call.expression, owner)].filter(
						(target) =>
							target !== "builtin:functionCall" &&
							target !== "builtin:functionApply" &&
							target !== "builtin:functionBind"
					)
				),
				unknownArguments: supplied.unknown,
			});
			if (callableReceivers.size > 0 && !keys.unknown && keys.values.size === 1 && keys.values.has("bind")) {
				return hasOrdinaryReceivers
					? [ordinaryInvocation()]
					: [{ arguments: [], targets: new Set(), unknownArguments: false }];
			}
			if (callableReceivers.size > 0 && !keys.unknown && keys.values.size === 1 && keys.values.has("call")) {
				const normalized: Invocation = {
					arguments: supplied.arguments.slice(1),
					targets: callableReceivers,
					thisArgument: supplied.arguments[0],
					unknownArguments: supplied.unknown,
				};
				return hasOrdinaryReceivers ? [normalized, ordinaryInvocation()] : [normalized];
			}
			if (callableReceivers.size > 0 && !keys.unknown && keys.values.size === 1 && keys.values.has("apply")) {
				const unpacked = call.arguments[1]
					? arrayArguments(call.arguments[1], owner)
					: { arguments: [], unknown: true };
				const normalized: Invocation = {
					arguments: unpacked.arguments,
					targets: callableReceivers,
					thisArgument: call.arguments[0] ? semanticArgument(call.arguments[0], owner) : undefined,
					unknownArguments: unpacked.unknown,
				};
				return hasOrdinaryReceivers ? [normalized, ordinaryInvocation()] : [normalized];
			}
		}
		const supplied = invocationArguments(call.arguments, owner);
		return [
			{
				arguments: supplied.arguments,
				targets: expressionTargets(call.expression, owner),
				unknownArguments: supplied.unknown,
			},
		];
	};
	const expandInvocation = (initial: Invocation): Invocation[] => {
		const result: Invocation[] = [];
		const pending: Array<{ readonly invocation: Invocation; readonly visitedCallables: ReadonlySet<string> }> = [
			{ invocation: initial, visitedCallables: new Set() },
		];
		const seen = new Set<string>();
		while (pending.length) {
			const entry = pending.pop();
			if (!entry) continue;
			const { invocation: current, visitedCallables } = entry;
			for (const target of current.targets) {
				const argumentSignature = current.arguments.map(({ owner, source, targets }) => [
					owner?.id,
					source?.pos,
					source?.end,
					[...targets].sort(),
				]);
				const thisSignature = current.thisArgument
					? [
							current.thisArgument.owner?.id,
							current.thisArgument.source?.pos,
							current.thisArgument.source?.end,
							[...current.thisArgument.targets].sort(),
						]
					: undefined;
				const key = JSON.stringify([
					target,
					argumentSignature,
					thisSignature,
					current.unknownArguments,
					[...visitedCallables].sort(),
				]);
				if (seen.has(key)) continue;
				seen.add(key);
				if (target.startsWith("callable:")) {
					const callableId = target.slice("callable:".length);
					if (visitedCallables.has(callableId)) continue;
					const bound = boundCallables.get(callableId);
					if (bound) {
						pending.push({
							invocation: {
								arguments: [...bound.arguments, ...current.arguments],
								targets: bound.targets,
								thisArgument: bound.thisArgument ?? current.thisArgument,
								unknownArguments: current.unknownArguments || bound.unknownArguments === true,
							},
							visitedCallables: new Set([...visitedCallables, callableId]),
						});
					}
					continue;
				}
				if (target === "builtin:functionCall") {
					pending.push({
						invocation: {
							arguments: current.arguments.slice(1),
							targets: current.thisArgument?.targets ?? new Set(),
							thisArgument: current.arguments[0],
							unknownArguments: current.unknownArguments,
						},
						visitedCallables,
					});
					continue;
				}
				if (target === "builtin:functionApply") {
					const argumentArray = current.arguments[1];
					const unpacked =
						argumentArray?.source && argumentArray.owner
							? arrayArguments(argumentArray.source, argumentArray.owner)
							: { arguments: [], unknown: true };
					pending.push({
						invocation: {
							arguments: unpacked.arguments,
							targets: current.thisArgument?.targets ?? new Set(),
							thisArgument: current.arguments[0],
							unknownArguments: current.unknownArguments || unpacked.unknown,
						},
						visitedCallables,
					});
					continue;
				}
				result.push({ ...current, targets: new Set([target]) });
			}
		}
		return result;
	};
	const selectedArgument = (
		argument: SemanticArgument | undefined,
		initializer: ts.Expression | undefined,
		owner: FunctionNode
	): SemanticArgument | undefined => {
		if (argument && !argument.definitelyUndefined) return argument;
		if (initializer) return semanticArgument(initializer, owner);
		return argument;
	};
	const argumentKnownPropertyNames = (argument: SemanticArgument): Set<string> => {
		const result =
			argument.source && argument.owner ? knownPropertyNames(argument.source, argument.owner) : new Set<string>();
		for (const target of argument.targets) {
			if (!target.startsWith("object:")) continue;
			for (const slot of propertyFacts.get(target)?.keys() ?? []) {
				if (typeof slot === "string") result.add(slot);
			}
			const container = containerValues.get(target);
			if (container) {
				for (const name of knownPropertyNames(container.expression, container.owner)) result.add(name);
			}
		}
		return result;
	};
	const argumentProperty = (argument: SemanticArgument, name: string, owner: FunctionNode): SemanticArgument => {
		if (argument.source && argument.owner) {
			const source = transparentExpression(argument.source);
			if (ts.isObjectLiteralExpression(source)) {
				let hasUnknownSpread = false;
				for (const candidate of source.properties) {
					if (ts.isSpreadAssignment(candidate)) {
						hasUnknownSpread = true;
						continue;
					}
					if (!candidate.name) continue;
					const names = ts.isComputedPropertyName(candidate.name)
						? keyResolution(candidate.name.expression, argument.owner, new Set()).values
						: ts.isIdentifier(candidate.name) ||
							  ts.isStringLiteral(candidate.name) ||
							  ts.isNumericLiteral(candidate.name)
							? new Set([candidate.name.text])
							: new Set<string>();
					if (!names.has(name)) continue;
					if (ts.isPropertyAssignment(candidate)) return semanticArgument(candidate.initializer, argument.owner);
					if (ts.isShorthandPropertyAssignment(candidate)) return semanticArgument(candidate.name, argument.owner);
				}
				if (!hasUnknownSpread) return { definitelyUndefined: true, targets: new Set() };
			}
			if (ts.isArrayLiteralExpression(source)) {
				const index = Number(name);
				if (Number.isInteger(index) && index >= 0) {
					const shape = arrayArguments(source, argument.owner);
					const element = shape.arguments[index];
					if (element) return element;
					if (!shape.unknown) return { definitelyUndefined: true, targets: new Set() };
				}
			}
			const targets = propertyTargets(argument.source, name, argument.owner, new Set());
			return { targets };
		}
		const targets = new Set<SemanticTarget>();
		for (const target of argument.targets) {
			if (target.startsWith("object:")) {
				joinTargets(targets, storedPropertyTargets(target, name));
				const container = containerValues.get(target);
				if (container) joinTargets(targets, propertyTargets(container.expression, name, container.owner, new Set()));
			} else if (target.startsWith("class:")) {
				joinTargets(targets, memberTargets(target, name, true, owner, new Set()));
			} else if (target.startsWith("instance:")) {
				joinTargets(targets, memberTargets(target, name, false, owner, new Set()));
			} else if (target === "primitive:unresolvedInternal") {
				targets.add(target);
			}
		}
		return { targets };
	};
	const argumentArray = (argument: SemanticArgument): ArrayResolution => {
		if (argument.source && argument.owner) return arrayArguments(argument.source, argument.owner);
		const resolutions: ArrayResolution[] = [];
		for (const target of argument.targets) {
			if (!target.startsWith("object:")) continue;
			const container = containerValues.get(target);
			if (container && ts.isArrayLiteralExpression(container.expression)) {
				resolutions.push(arrayArguments(container.expression, container.owner));
				continue;
			}
			const arguments_: SemanticArgument[] = [];
			let unknown = false;
			for (const [slot, targets] of propertyFacts.get(target) ?? []) {
				if (slot === unknownProperty) {
					unknown = true;
					continue;
				}
				const index = Number(slot);
				if (!Number.isInteger(index) || index < 0) continue;
				while (arguments_.length <= index) arguments_.push({ targets: new Set() });
				joinTargets(arguments_[index].targets, targets);
			}
			resolutions.push({ arguments: arguments_, unknown });
		}
		return mergeArrayResolutions(resolutions);
	};
	const joinParameterBinding = (
		name: ts.BindingName,
		argument: SemanticArgument | undefined,
		initializer: ts.Expression | undefined,
		owner: FunctionNode,
		unknownArgument: boolean
	): boolean => {
		const selected = selectedArgument(argument, initializer, owner);
		if (ts.isIdentifier(name)) {
			const targets = parameterTargets.get(owner.id)?.get(name.text);
			if (!targets) return false;
			const additions = new Set(selected?.targets ?? []);
			if (unknownArgument) additions.add("primitive:unresolvedInternal");
			return joinTargets(targets, additions);
		}
		let joined = false;
		if (ts.isObjectBindingPattern(name)) {
			const knownNames = selected ? argumentKnownPropertyNames(selected) : new Set<string>();
			const excluded = new Set<string>();
			for (const element of name.elements) {
				if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
					const target = projectionTarget(owner, element);
					for (const property of knownNames) {
						if (excluded.has(property) || !selected) continue;
						joined =
							joinPropertyTargets(target, property, argumentProperty(selected, property, owner).targets) || joined;
					}
					if (unknownArgument || !selected || selected.targets.has("primitive:unresolvedInternal")) {
						joined = joinPropertyTargets(target, unknownProperty, ["primitive:unresolvedInternal"]) || joined;
					}
					continue;
				}
				const property = element.propertyName
					? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
						? element.propertyName.text
						: undefined
					: ts.isIdentifier(element.name)
						? element.name.text
						: undefined;
				if (!property) {
					joined = joinParameterBinding(element.name, undefined, element.initializer, owner, true) || joined;
					continue;
				}
				excluded.add(property);
				const nested = selected ? argumentProperty(selected, property, owner) : undefined;
				joined =
					joinParameterBinding(element.name, nested, element.initializer, owner, unknownArgument || !selected) ||
					joined;
			}
			return joined;
		}
		const shape = selected ? argumentArray(selected) : { arguments: [], unknown: true };
		for (const [index, element] of name.elements.entries()) {
			if (!ts.isBindingElement(element)) continue;
			if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
				const target = projectionTarget(owner, element);
				for (let sourceIndex = index; sourceIndex < shape.arguments.length; sourceIndex++) {
					joined =
						joinPropertyTargets(target, String(sourceIndex - index), shape.arguments[sourceIndex].targets) || joined;
				}
				if (unknownArgument || shape.unknown) {
					joined = joinPropertyTargets(target, unknownProperty, ["primitive:unresolvedInternal"]) || joined;
				}
				continue;
			}
			joined =
				joinParameterBinding(
					element.name,
					shape.arguments[index],
					element.initializer,
					owner,
					unknownArgument || shape.unknown
				) || joined;
		}
		return joined;
	};

	const edges = new Map<string, Set<string>>();
	const operations = new Map<string, SemanticOperation>();
	const joinReturnedExpression = (expression: ts.Expression, owner: FunctionNode): boolean => {
		const targets = returnedTargets.get(owner.id) ?? new Set<SemanticTarget>();
		const changed = joinTargets(targets, expressionTargets(expression, owner));
		returnedTargets.set(owner.id, targets);
		return changed;
	};
	const joinAssignment = (node: ts.BinaryExpression, owner: SemanticOwner): boolean => {
		if (
			node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
			!logicalAssignmentOperators.has(node.operatorToken.kind)
		) {
			return false;
		}
		let joined = false;
		const assignedTargets = expressionTargets(node.right, owner);
		if (ts.isIdentifier(node.left)) {
			const targetBinding = bindingKey(node.left.text, owner);
			const targets = storedTargets.get(targetBinding) ?? new Set<SemanticTarget>();
			joined = joinTargets(targets, assignedTargets) || joined;
			storedTargets.set(targetBinding, targets);
		}
		if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
			const keys = accessKeys(node.left, owner, new Set());
			const slots = new Set<PropertySlot>(keys.values);
			if (keys.unknown) slots.add(unknownProperty);
			for (const containerId of containerIds(node.left.expression, owner)) {
				for (const slot of slots) {
					joined = joinPropertyTargets(containerId, slot, assignedTargets) || joined;
				}
			}
		}
		return joined;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const file of files) {
			const owner = moduleOwner(file.fileName);
			if (!owner) continue;
			const visitModule = (node: ts.Node, evaluationOwner: SemanticOwner = owner): void => {
				if (node !== file && ts.isFunctionLike(node)) return;
				if (ts.isClassLike(node)) {
					for (const heritage of node.heritageClauses ?? []) {
						for (const type of heritage.types) visitModule(type.expression, evaluationOwner);
					}
					const classTarget = semanticClassTarget(file, node);
					const classOwner: SemanticOwner = {
						className:
							node.name?.text ??
							(ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
								? node.parent.name.text
								: undefined),
						file,
						id: `${classTarget}:static-evaluation`,
						staticClassTarget: classTarget,
					};
					for (const member of node.members) {
						if (member.name && ts.isComputedPropertyName(member.name)) {
							visitModule(member.name.expression, evaluationOwner);
						}
						if (ts.isClassStaticBlockDeclaration(member)) {
							visitModule(member.body, classOwner);
							continue;
						}
						const isStatic = Boolean(
							ts.canHaveModifiers(member) &&
								ts.getModifiers(member)?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword)
						);
						if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
							visitModule(member.initializer, classOwner);
						}
					}
					return;
				}
				if (ts.isBinaryExpression(node)) changed = joinAssignment(node, evaluationOwner) || changed;
				ts.forEachChild(node, (child) => visitModule(child, evaluationOwner));
			};
			visitModule(file);
		}
		for (const owner of nodes) {
			if (!ts.isBlock(owner.body)) changed = joinReturnedExpression(owner.body, owner) || changed;
			const visit = (node: ts.Node): void => {
				if (node !== owner.body && ts.isFunctionLike(node)) return;
				if (ts.isReturnStatement(node) && node.expression) {
					changed = joinReturnedExpression(node.expression, owner) || changed;
				}
				if (ts.isBinaryExpression(node)) changed = joinAssignment(node, owner) || changed;
				if (ts.isCallExpression(node)) {
					const initialInvocations = invocations(node, owner);
					if (
						node.expression.kind === ts.SyntaxKind.ImportKeyword &&
						node.arguments[0] &&
						ts.isStringLiteral(node.arguments[0])
					) {
						const specifier = node.arguments[0].text;
						if (["@msgpack/msgpack", "node:v8", "@bufbuild/protobuf"].includes(specifier)) {
							for (const initial of initialInvocations) initial.targets.add("primitive:serialization");
						} else {
							const moduleName = resolveModuleName(owner.file.fileName, specifier, sourceNames);
							if (moduleName || isUnresolvedInternalImport(owner.file.fileName, specifier, moduleName)) {
								for (const initial of initialInvocations) initial.targets.add("primitive:unresolvedInternal");
							}
						}
					}
					for (const resolvedInvocation of initialInvocations.flatMap(expandInvocation)) {
						const target = [...resolvedInvocation.targets][0];
						if (!target) continue;
						if (target === "builtin:jsonParse") {
							if (resolvedInvocation.arguments.some(({ targets }) => targets.has("provenance:jsonString"))) {
								operations.set(`${owner.id}:${node.pos}:json`, { call: node, owner, primitive: "json" });
							}
							continue;
						}
						if (target === "builtin:jsonStringify") continue;
						if (target.startsWith("primitive:")) {
							const primitive = target.slice("primitive:".length) as SemanticPrimitive;
							operations.set(`${owner.id}:${node.pos}:${primitive}`, { call: node, owner, primitive });
							continue;
						}
						if (!target.startsWith("function:")) continue;
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
							const argument = resolvedInvocation.arguments[index];
							changed =
								joinParameterBinding(
									parameter.name,
									argument,
									parameter.initializer,
									targetNode,
									resolvedInvocation.unknownArguments
								) || changed;
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
			return (
				operation.primitive === "cloneDeep" &&
				(body.match(/\.getACLState\s*\(/g) ?? []).length === 1 &&
				(body.match(/\.getDRPState\s*\(/g) ?? []).length === 1
			);
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
	const reachableOperations = [...operations.values()].filter(({ owner }) => reachable.has(owner.id));
	const operationMultiplicity = new Map<string, number>();
	for (const operation of reachableOperations) {
		const id = operationId(operation);
		operationMultiplicity.set(id, (operationMultiplicity.get(id) ?? 0) + 1);
	}
	const expectedMultiplicity = (id: string): number => (id.endsWith("DRPObject.getStates:clone") ? 2 : 1);
	const reportedMultiplicity = new Set<string>();
	for (const operation of operations.values()) {
		if (!reachable.has(operation.owner.id)) continue;
		if (operation.primitive === "cloneDeep" && RESIDUAL_CLONE_SITES.has(residualSite(operation))) continue;
		if (operation.primitive === "stateFromDRP" && RESIDUAL_STATE_CAPTURE_SITES.has(residualSite(operation))) continue;
		if (
			operation.primitive === "cloneDeep" &&
			injectedLeaves.some(({ id }) => id === operation.owner.id) &&
			reachedByBothPublicationRoots(operation.owner)
		) {
			const id = operationId(operation);
			const legacyLeaf = !operation.owner.file.fileName.startsWith("packages/");
			if ((legacyLeaf || qualifiesReviewed(operation)) && operationMultiplicity.get(id) === expectedMultiplicity(id)) {
				if (!legacyLeaf) reviewedOperations.add(id);
			} else if (!reportedMultiplicity.has(id)) {
				reportedMultiplicity.add(id);
				violations.push(`${id} has extra or structurally unreviewed clone operations`);
			}
			continue;
		}
		if (qualifiesReviewed(operation)) {
			const id = operationId(operation);
			if (operationMultiplicity.get(id) === expectedMultiplicity(id)) reviewedOperations.add(id);
			else if (!reportedMultiplicity.has(id)) {
				reportedMultiplicity.add(id);
				violations.push(`${id} has extra operations beyond the reviewed multiplicity`);
			}
			continue;
		}
		violations.push(
			operation.primitive === "unresolvedInternal"
				? `${ownerLabel(operation.owner)} fails closed on unresolved internal workspace import`
				: `${ownerLabel(operation.owner)} reaches forbidden ${operation.primitive === "json" ? "json serialization round-trip" : operation.primitive} operation through the workspace module graph`
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

interface StructureFlowRed8Fixture {
	readonly expectedViolation: RegExp;
	readonly family: string;
	readonly name: string;
	readonly shouldViolate: boolean;
	readonly sources: Readonly<Record<string, string>>;
}

function structureFlowRed8Fixture(
	family: string,
	name: string,
	imports: string,
	mutation: string,
	shouldViolate: boolean
): StructureFlowRed8Fixture {
	return Object.freeze({
		expectedViolation: ENCODE_VIOLATION,
		family,
		name,
		shouldViolate,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			[UTILS_SERIALIZATION_PATH]: RED8_CAPTURE_UTILITY,
		}),
	});
}

const RED8_CAPTURE_UTILITY = `
	import { encode } from "@msgpack/msgpack";
	export type Callback = (value: unknown) => unknown;
	export function capture(value: unknown): Uint8Array { return encode(value); }
	export function safe(value: unknown): unknown { return value; }
`;

const RED8_IMPORTS = 'import { capture, safe, type Callback } from "@ts-drp/utils/serialization";';

const STRUCTURE_FLOW_RED8_MUTANTS = Object.freeze([
	structureFlowRed8Fixture(
		"logical assignment",
		"identifier logical-or assignment stores the selected callback",
		RED8_IMPORTS,
		"let selected: Callback | undefined = undefined; selected ||= capture; selected(state);",
		true
	),
	structureFlowRed8Fixture(
		"logical assignment",
		"identifier logical-and assignment returns the selected callback",
		RED8_IMPORTS,
		"let selected: Callback = safe; (selected &&= capture)(state);",
		true
	),
	structureFlowRed8Fixture(
		"logical assignment",
		"object-property nullish assignment stores the selected callback",
		RED8_IMPORTS,
		"const bag: { selected?: Callback } = {}; bag.selected ??= capture; bag.selected(state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"object-property parameter projects the caller callback",
		RED8_IMPORTS,
		"function run({ selected }: { selected: Callback }, value: unknown): unknown { return selected(value); } run({ selected: capture }, state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"object-rest parameter retains a non-excluded caller callback",
		RED8_IMPORTS,
		"function run({ safe: _ignored, ...rest }: { safe: Callback; selected: Callback }, value: unknown): unknown { return rest.selected(value); } run({ safe, selected: capture }, state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"array-property parameter projects a shifted caller callback",
		RED8_IMPORTS,
		"function run([_first, selected]: readonly [Callback, Callback], value: unknown): unknown { return selected(value); } run([safe, capture], state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"array-rest parameter projects a shifted caller callback",
		RED8_IMPORTS,
		"function run([_first, ...rest]: readonly [Callback, Callback], value: unknown): unknown { return rest[0](value); } run([safe, capture], state);",
		true
	),
	structureFlowRed8Fixture(
		"await wrapper",
		"await transparently retains a non-Promise callback",
		RED8_IMPORTS,
		"async function run(value: unknown): Promise<unknown> { return (await capture)(value); } void run(state);",
		true
	),
	structureFlowRed8Fixture(
		"default selection",
		"explicit undefined selects a forbidden parameter default",
		RED8_IMPORTS,
		"function run(value: unknown, selected: Callback = capture): unknown { return selected(value); } run(state, undefined);",
		true
	),
	structureFlowRed8Fixture(
		"default selection",
		"void zero selects a forbidden parameter default",
		RED8_IMPORTS,
		"function run(value: unknown, selected: Callback = capture): unknown { return selected(value); } run(state, void 0);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"ordinary call property invokes its stored callback",
		RED8_IMPORTS,
		"const bag = { call: capture }; bag.call(state);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"ordinary apply property invokes its stored callback",
		RED8_IMPORTS,
		"const bag = { apply: capture }; bag.apply(state);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"ordinary bind property invokes its stored callback",
		RED8_IMPORTS,
		"const bag = { bind: capture }; bag.bind(state);",
		true
	),
] satisfies readonly StructureFlowRed8Fixture[]);

const STRUCTURE_FLOW_RED8_CONTROLS = Object.freeze([
	structureFlowRed8Fixture(
		"logical assignment",
		"simple property assignment retains the same callback",
		RED8_IMPORTS,
		"const bag: { selected?: Callback } = {}; bag.selected = capture; bag.selected(state);",
		true
	),
	structureFlowRed8Fixture(
		"logical assignment",
		"logical-binary selection retains the same callback",
		RED8_IMPORTS,
		"const selected: Callback | undefined = undefined; (selected || capture)(state);",
		true
	),
	structureFlowRed8Fixture(
		"logical assignment",
		"logical assignment with a safe RHS remains allowed",
		RED8_IMPORTS,
		"let selected: Callback | undefined = undefined; selected ||= safe; selected(state);",
		false
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"same-shape variable object projection retains the callback",
		RED8_IMPORTS,
		"const bag = { selected: capture }; const { selected } = bag; selected(state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"same-shape variable array-rest projection retains the shifted callback",
		RED8_IMPORTS,
		"const callbacks = [safe, capture] as const; const [_first, ...rest] = callbacks; rest[0](state);",
		true
	),
	structureFlowRed8Fixture(
		"function-parameter binding pattern",
		"object-rest parameter excludes a forbidden callback from a safe projection",
		RED8_IMPORTS,
		"function run({ selected: _excluded, ...rest }: { selected: Callback; safe: Callback }, value: unknown): unknown { return rest.safe(value); } run({ selected: capture, safe }, state);",
		false
	),
	structureFlowRed8Fixture(
		"await wrapper",
		"non-await satisfies and parentheses retain the same callback",
		RED8_IMPORTS,
		"((capture) satisfies Callback)(state);",
		true
	),
	structureFlowRed8Fixture(
		"await wrapper",
		"awaiting a safe non-Promise callback remains allowed",
		RED8_IMPORTS,
		"async function run(value: unknown): Promise<unknown> { return (await safe)(value); } void run(state);",
		false
	),
	structureFlowRed8Fixture(
		"default selection",
		"omitting the argument retains the forbidden parameter default",
		RED8_IMPORTS,
		"function run(value: unknown, selected: Callback = capture): unknown { return selected(value); } run(state);",
		true
	),
	structureFlowRed8Fixture(
		"default selection",
		"an explicit safe override remains allowed",
		RED8_IMPORTS,
		"function run(value: unknown, selected: Callback = capture): unknown { return selected(value); } run(state, safe);",
		false
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"genuine Function-prototype call remains detected",
		RED8_IMPORTS,
		"capture.call(undefined, state);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"genuine Function-prototype apply remains detected",
		RED8_IMPORTS,
		"capture.apply(undefined, [state]);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"genuine Function-prototype bind remains detected",
		RED8_IMPORTS,
		"const selected = capture.bind(undefined); selected(state);",
		true
	),
	structureFlowRed8Fixture(
		"ordinary reserved-name object member",
		"same-shape safe object members remain allowed",
		RED8_IMPORTS,
		"const bag = { call: safe, apply: safe, bind: safe }; bag.call(state); bag.apply(state); bag.bind(state);",
		false
	),
] satisfies readonly StructureFlowRed8Fixture[]);

describe("Phase 1d(i) D.92.2 remaining language-flow RED8", () => {
	it.each(STRUCTURE_FLOW_RED8_MUTANTS)("rejects $family bypass: $name", ({ expectedViolation, sources }) => {
		const analysis = analyze(sources);
		expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
	});

	it.each(STRUCTURE_FLOW_RED8_CONTROLS)(
		"preserves $family control: $name",
		({ expectedViolation, shouldViolate, sources }) => {
			const analysis = analyze(sources);
			if (shouldViolate) {
				expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
			} else {
				expect(analysis.violations).toEqual([]);
			}
		}
	);
});

interface StructureFlowRed7Fixture {
	readonly expectedViolation: RegExp;
	readonly family: string;
	readonly name: string;
	readonly shouldViolate: boolean;
	readonly sources: Readonly<Record<string, string>>;
}

function structureFlowRed7Fixture(
	family: string,
	name: string,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>> = {},
	shouldViolate = true
): StructureFlowRed7Fixture {
	return Object.freeze({
		expectedViolation: ENCODE_VIOLATION,
		family,
		name,
		shouldViolate,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		}),
	});
}

const RED7_CAPTURE_UTILITY = `
	import { encode } from "@msgpack/msgpack";
	export type Callback = (value: unknown) => unknown;
	export function capture(value: unknown): Uint8Array { return encode(value); }
	export function safe(value: unknown): unknown { return value; }
`;

const STRUCTURE_FLOW_RED7_MUTANTS = Object.freeze([
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"logical-or concise return retains the fallback callback",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(null); selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (candidate: typeof capture | null) => candidate || capture;
			`,
		}
	),
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"logical-and concise return retains the enabled callback",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(true); if (selected) selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (enabled: boolean) => enabled && capture;
			`,
		}
	),
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"nullish-coalescing alias retains the fallback callback",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(undefined); selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (candidate: typeof capture | undefined) => candidate ?? capture;
			`,
		}
	),
	structureFlowRed7Fixture(
		"default parameter initializer",
		"omitted callback uses the forbidden default",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(value: unknown, callback: (value: unknown) => unknown = capture): unknown { return callback(value); } run(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"satisfies retains a forbidden target alias",
		'import { capture, type Callback } from "@ts-drp/utils/serialization";',
		"const selected = capture satisfies Callback; selected(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"satisfies retains a forbidden callable return",
		'import { capture, type Callback } from "@ts-drp/utils/serialization";',
		"const make = () => capture satisfies Callback; make()(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"satisfies retains a forbidden object container",
		'import { capture, type Callback } from "@ts-drp/utils/serialization";',
		"const bag = ({ capture } satisfies Record<string, Callback>); bag.capture(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"direct call spread",
		"spread call arguments retain the forbidden callback position",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); } run(...[capture, state] as const);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"array-rest destructuring",
		"shifted array rest retains the forbidden callback at rest index zero",
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"const [head, ...callbacks] = [safe, capture]; void head; callbacks[0](state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"lexical binding identity",
		"catch binding does not suppress a sibling forwarding declaration",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); } try { throw state; } catch (run) { void run; } run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"lexical binding identity",
		"loop binding does not suppress a sibling forwarding declaration",
		'import { capture, type Callback } from "@ts-drp/utils/serialization";',
		"function run(callback: Callback, value: unknown): unknown { return callback(value); } for (const run of [] as Callback[]) { void run; } run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"object-rest projection",
		"exported object rest retains the non-excluded forbidden callback",
		'import { project } from "@ts-drp/utils/serialization";',
		"project().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export function project(): Record<string, Callback> {
					const { safe: ignored, ...remaining } = { capture, safe };
					void ignored;
					return remaining;
				}
			`,
		}
	),
	structureFlowRed7Fixture(
		"assignment-expression value",
		"concise assignment return retains its assigned forbidden callback",
		'import { install } from "@ts-drp/utils/serialization";',
		"install()(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				const holder: Record<string, Callback> = { capture: safe };
				export const install = () => (holder.capture = capture);
			`,
		}
	),
	structureFlowRed7Fixture(
		"parameter-aliased container write",
		"callee assignment updates the caller's passed container",
		'import { capture, safe, type Callback } from "@ts-drp/utils/serialization";',
		"const bag: Record<string, Callback> = { capture: safe }; function install(target: Record<string, Callback>): void { target.capture = capture; } install(bag); bag.capture(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
] satisfies readonly StructureFlowRed7Fixture[]);

const STRUCTURE_FLOW_RED7_CONTROLS = Object.freeze([
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"logical-or concise return can retain only safe callbacks",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(null); selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (candidate: typeof safe | null) => candidate || safe;
			`,
		},
		false
	),
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"logical-and concise return can retain only a safe callback",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(true); if (selected) selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (enabled: boolean) => enabled && safe;
			`,
		},
		false
	),
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"nullish concise return can retain only safe callbacks",
		'import { choose } from "@ts-drp/utils/serialization";',
		"const selected = choose(undefined); selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (candidate: typeof safe | undefined) => candidate ?? safe;
			`,
		},
		false
	),
	structureFlowRed7Fixture(
		"logical and nullish value flow",
		"ternary return remains a positive callback-flow control",
		'import { choose } from "@ts-drp/utils/serialization";',
		"choose(true)(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export const choose = (enabled: boolean) => enabled ? capture : safe;
			`,
		}
	),
	structureFlowRed7Fixture(
		"default parameter initializer",
		"explicit forbidden callback remains a positive arity control",
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"function run(value: unknown, callback: (value: unknown) => unknown = safe): unknown { return callback(value); } run(state, capture);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"default parameter initializer",
		"explicit safe callback overrides a forbidden default",
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"function run(value: unknown, callback: (value: unknown) => unknown = capture): unknown { return callback(value); } run(state, safe);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"default parameter initializer",
		"omitted callback can use a safe default",
		'import { safe } from "@ts-drp/utils/serialization";',
		"function run(value: unknown, callback: (value: unknown) => unknown = safe): unknown { return callback(value); } run(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"as assertion remains a positive target-flow control",
		'import { capture, type Callback } from "@ts-drp/utils/serialization";',
		"const selected = capture as Callback; selected(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"parentheses remain a positive target-flow control",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const selected = (capture); selected(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"satisfies wrapper",
		"satisfies can wrap a safe target",
		'import { safe, type Callback } from "@ts-drp/utils/serialization";',
		"const selected = safe satisfies Callback; selected(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"direct call spread",
		"direct callback passage remains a positive control",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); } run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"direct call spread",
		"spread call arguments can carry a safe callback",
		'import { safe } from "@ts-drp/utils/serialization";',
		"function run(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); } run(...[safe, state] as const);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"array-rest destructuring",
		"direct shifted array destructuring remains a positive control",
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"const [head, callback] = [safe, capture]; void head; callback(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"array-rest destructuring",
		"shifted array rest can retain only safe callbacks",
		'import { safe } from "@ts-drp/utils/serialization";',
		"const [head, ...callbacks] = [safe, safe]; void head; callbacks[0](state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"lexical binding identity",
		"direct sibling forwarding declaration remains a positive control",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); } run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"lexical binding identity",
		"same-name catch and loop bindings do not contaminate a safe sibling declaration",
		'import { safe, type Callback } from "@ts-drp/utils/serialization";',
		"function run(callback: Callback, value: unknown): unknown { return callback(value); } try { throw state; } catch (run) { void run; } for (const run of [] as Callback[]) { void run; } run(safe, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
	structureFlowRed7Fixture(
		"object-rest projection",
		"excluded forbidden property does not contaminate the projected safe property",
		'import { project } from "@ts-drp/utils/serialization";',
		"project().safe(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				export function project(): Record<string, Callback> {
					const { capture: ignored, ...remaining } = { capture, safe };
					void ignored;
					return remaining;
				}
			`,
		},
		false
	),
	structureFlowRed7Fixture(
		"assignment-expression value",
		"block return after assignment remains a positive control",
		'import { install } from "@ts-drp/utils/serialization";',
		"install()(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				const holder: Record<string, Callback> = { capture: safe };
				export const install = () => { holder.capture = capture; return holder.capture; };
			`,
		}
	),
	structureFlowRed7Fixture(
		"assignment-expression value",
		"concise assignment return can retain a safe callback",
		'import { install } from "@ts-drp/utils/serialization";',
		"install()(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED7_CAPTURE_UTILITY}
				const holder: Record<string, Callback> = { capture: safe };
				export const install = () => (holder.capture = safe);
			`,
		},
		false
	),
	structureFlowRed7Fixture(
		"parameter-aliased container write",
		"direct post-initializer assignment remains a positive control",
		'import { capture, safe, type Callback } from "@ts-drp/utils/serialization";',
		"const bag: Record<string, Callback> = { capture: safe }; bag.capture = capture; bag.capture(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY }
	),
	structureFlowRed7Fixture(
		"parameter-aliased container write",
		"callee assignment can retain a safe callback",
		'import { safe, type Callback } from "@ts-drp/utils/serialization";',
		"const bag: Record<string, Callback> = { capture: safe }; function install(target: Record<string, Callback>): void { target.capture = safe; } install(bag); bag.capture(state);",
		{ [UTILS_SERIALIZATION_PATH]: RED7_CAPTURE_UTILITY },
		false
	),
] satisfies readonly StructureFlowRed7Fixture[]);

describe("Phase 1d(i) D.92.2 semantic binding-flow RED7", () => {
	it.each(STRUCTURE_FLOW_RED7_MUTANTS)("rejects $family bypass: $name", ({ expectedViolation, sources }) => {
		const analysis = analyze(sources);
		expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
	});

	it.each(STRUCTURE_FLOW_RED7_CONTROLS)(
		"preserves $family control: $name",
		({ expectedViolation, shouldViolate, sources }) => {
			const analysis = analyze(sources);
			if (shouldViolate) {
				expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
			} else {
				expect(analysis.violations).toEqual([]);
			}
		}
	);
});

interface StructureFlowRed6Fixture {
	readonly expectedViolation: RegExp;
	readonly family: string;
	readonly name: string;
	readonly shouldViolate: boolean;
	readonly sources: Readonly<Record<string, string>>;
}

function structureFlowRed6Fixture(
	family: string,
	name: string,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>> = {},
	shouldViolate = true
): StructureFlowRed6Fixture {
	return Object.freeze({
		expectedViolation: ENCODE_VIOLATION,
		family,
		name,
		shouldViolate,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		}),
	});
}

const RED6_CAPTURE_UTILITY = `
	import { encode } from "@msgpack/msgpack";
	export function capture(value: unknown): Uint8Array { return encode(value); }
	export function safe(value: unknown): unknown { return value; }
`;

const STRUCTURE_FLOW_RED6_MUTANTS = Object.freeze([
	structureFlowRed6Fixture(
		"array spread",
		"cross-package spread retains a forbidden callback at index zero",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[0](state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}
				const base = [capture];
				export const bag = [...base];
			`,
		}
	),
	structureFlowRed6Fixture(
		"array spread",
		"cross-package multiple spreads retain a shifted forbidden callback index",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[1](state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}
				const prefix = [safe];
				const base = [capture];
				export const bag = [...prefix, ...base];
			`,
		}
	),
	structureFlowRed6Fixture(
		"nested function declaration",
		"publication-root local declaration forwards a forbidden callback",
		'import { capture } from "@ts-drp/utils/serialization";',
		"function run(fn: (value: unknown) => unknown, value: unknown): unknown { return fn(value); } run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED6_CAPTURE_UTILITY }
	),
	structureFlowRed6Fixture(
		"concise arrow return",
		"cross-package concise arrow returns a forbidden callback",
		'import { make } from "@ts-drp/utils/serialization";',
		"make()(state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const make = () => capture;` }
	),
	structureFlowRed6Fixture(
		"concise arrow return",
		"cross-package concise arrow returns a forbidden bound callback",
		'import { make } from "@ts-drp/utils/serialization";',
		"make(state)();",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const make = (value: unknown) => capture.bind(undefined, value);`,
		}
	),
] satisfies readonly StructureFlowRed6Fixture[]);

const STRUCTURE_FLOW_RED6_CONTROLS = Object.freeze([
	structureFlowRed6Fixture(
		"array spread",
		"direct cross-package array retains the same forbidden callback",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[0](state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const bag = [capture];` }
	),
	structureFlowRed6Fixture(
		"array spread",
		"direct cross-package array retains a shifted forbidden callback index",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[1](state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const bag = [safe, capture];` }
	),
	structureFlowRed6Fixture(
		"array spread",
		"cross-package spread of a safe callback remains allowed",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[0](state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}
				const base = [safe];
				export const bag = [...base];
			`,
		},
		false
	),
	structureFlowRed6Fixture(
		"nested function declaration",
		"publication-root local function expression remains detected",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const run = function (fn: (value: unknown) => unknown, value: unknown): unknown { return fn(value); }; run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED6_CAPTURE_UTILITY }
	),
	structureFlowRed6Fixture(
		"nested function declaration",
		"publication-root local arrow remains detected",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const run = (fn: (value: unknown) => unknown, value: unknown): unknown => fn(value); run(capture, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED6_CAPTURE_UTILITY }
	),
	structureFlowRed6Fixture(
		"nested function declaration",
		"cross-package module declaration remains detected",
		'import { run, capture } from "@ts-drp/utils/serialization";',
		"run(capture, state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}
				export function run(fn: (value: unknown) => unknown, value: unknown): unknown { return fn(value); }
			`,
		}
	),
	structureFlowRed6Fixture(
		"nested function declaration",
		"publication-root local declaration can forward a safe callback",
		"function safe(value: unknown): unknown { return value; }",
		"function run(fn: (value: unknown) => unknown, value: unknown): unknown { return fn(value); } run(safe, state);",
		{},
		false
	),
	structureFlowRed6Fixture(
		"concise arrow return",
		"cross-package block arrow return remains detected",
		'import { make } from "@ts-drp/utils/serialization";',
		"make()(state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const make = () => { return capture; };` }
	),
	structureFlowRed6Fixture(
		"concise arrow return",
		"cross-package concise arrow can return a safe callback",
		'import { make } from "@ts-drp/utils/serialization";',
		"make()(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const make = () => safe;`,
		},
		false
	),
	structureFlowRed6Fixture(
		"concise arrow return",
		"cross-package block arrow bound return remains detected",
		'import { make } from "@ts-drp/utils/serialization";',
		"make(state)();",
		{
			[UTILS_SERIALIZATION_PATH]: `${RED6_CAPTURE_UTILITY}\nexport const make = (value: unknown) => { return capture.bind(undefined, value); };`,
		}
	),
] satisfies readonly StructureFlowRed6Fixture[]);

const RED6_CYCLE_CHILD_ENV = "TS_DRP_STRUCTURE_FLOW_RED6_CYCLE_CHILD";
const RED6_CYCLE_CHILD_TEST = "RED6 child detects a bound callable cycle with a leading argument";
const RED6_CYCLE_CONTROL_CHILD_TEST = "RED6 child detects a bound callable cycle without a leading argument";
const RED6_CYCLE_SOURCE = (leadingArgument: boolean): Readonly<Record<string, string>> => ({
	[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
		'import { capture } from "@ts-drp/utils/serialization";',
		`let g = capture;
		 const holder: { f: typeof g } = { f: g };
		 holder.f = g.bind(undefined${leadingArgument ? ", state" : ""});
		 g = holder.f;
		 g(state);`
	),
	[UTILS_SERIALIZATION_PATH]: RED6_CAPTURE_UTILITY,
});

interface Red6ChildResult {
	readonly durationMs: number;
	readonly errorCode?: string;
	readonly outputTail: string;
	readonly signal: NodeJS.Signals | null;
	readonly status: number | null;
}

async function runRed6CycleChild(testName: string): Promise<Red6ChildResult> {
	const { spawnSync } = await import("node:child_process");
	const startedAt = performance.now();
	const result = spawnSync(
		process.execPath,
		[
			"--max-old-space-size=64",
			path.join(WORKSPACE_DIRECTORY, "node_modules/vitest/vitest.mjs"),
			"run",
			fileURLToPath(import.meta.url),
			"-t",
			testName,
			"--reporter=dot",
			"--coverage.enabled=false",
			"--pool=threads",
			"--maxWorkers=1",
			"--minWorkers=1",
			"--exclude=.logs/**",
		],
		{
			cwd: WORKSPACE_DIRECTORY,
			encoding: "utf8",
			env: { ...process.env, FORCE_COLOR: "0", [RED6_CYCLE_CHILD_ENV]: "1" },
			killSignal: "SIGKILL",
			maxBuffer: 256 * 1024,
			timeout: 4_000,
		}
	);
	const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
	return {
		durationMs: Math.round(performance.now() - startedAt),
		errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
		outputTail: combinedOutput.slice(-2_000),
		signal: result.signal,
		status: result.status,
	};
}

if (process.env[RED6_CYCLE_CHILD_ENV] === "1") {
	describe("Phase 1d(i) D.92.2 bound-callable cycle child", () => {
		it(RED6_CYCLE_CHILD_TEST, () => {
			const analysis = analyze(RED6_CYCLE_SOURCE(true));
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(ENCODE_VIOLATION)]));
		});

		it(RED6_CYCLE_CONTROL_CHILD_TEST, () => {
			const analysis = analyze(RED6_CYCLE_SOURCE(false));
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(ENCODE_VIOLATION)]));
		});
	});
} else {
	describe("Phase 1d(i) D.92.2 remaining semantic-flow RED", () => {
		it.each(STRUCTURE_FLOW_RED6_MUTANTS)("rejects $family bypass: $name", ({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		});

		it.each(STRUCTURE_FLOW_RED6_CONTROLS)(
			"preserves $family control: $name",
			({ expectedViolation, shouldViolate, sources }) => {
				const analysis = analyze(sources);
				if (shouldViolate) {
					expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
				} else {
					expect(analysis.violations).toEqual([]);
				}
			}
		);

		it("isolates a leading-argument bound-callable cycle in a bounded child", async () => {
			const result = await runRed6CycleChild(RED6_CYCLE_CHILD_TEST);
			console.info(`[structure-flow-red6-child] leading=true ${JSON.stringify(result)}`);
			expect(result).toMatchObject({ errorCode: undefined, signal: null, status: 0 });
		});

		it("proves the bounded child detects a no-leading-argument cycle", async () => {
			const result = await runRed6CycleChild(RED6_CYCLE_CONTROL_CHILD_TEST);
			console.info(`[structure-flow-red6-child] leading=false ${JSON.stringify(result)}`);
			expect(result).toMatchObject({ errorCode: undefined, signal: null, status: 0 });
		});
	});
}

interface StructureFlowRed5Fixture {
	readonly expectedViolation: RegExp;
	readonly family: string;
	readonly name: string;
	readonly sources: Readonly<Record<string, string>>;
}

interface StructureFlowRed5Control extends StructureFlowRed5Fixture {
	readonly shouldViolate: boolean;
}

function structureFlowRed5Fixture(
	family: string,
	name: string,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>> = {}
): StructureFlowRed5Fixture {
	return Object.freeze({
		expectedViolation: ENCODE_VIOLATION,
		family,
		name,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		}),
	});
}

const RED5_CAPTURE_UTILITY = `
	import { encode } from "@msgpack/msgpack";
	export function capture(value: unknown): Uint8Array { return encode(value); }
	export function safe(value: unknown): unknown { return value; }
`;

const STRUCTURE_FLOW_RED5_MUTANTS = Object.freeze([
	structureFlowRed5Fixture(
		"bind-of-call/apply",
		"Function.prototype.call.bind retains the captured callable receiver",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const invoke = Function.prototype.call.bind(capture); invoke(undefined, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED5_CAPTURE_UTILITY }
	),
	structureFlowRed5Fixture(
		"bind-of-call/apply",
		"capture.call.bind retains the captured callable receiver",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const invoke = capture.call.bind(capture); invoke(undefined, state);",
		{ [UTILS_SERIALIZATION_PATH]: RED5_CAPTURE_UTILITY }
	),
	structureFlowRed5Fixture(
		"bind-of-call/apply",
		"Function.prototype.apply.bind retains the captured callable receiver",
		'import { capture } from "@ts-drp/utils/serialization";',
		"const invoke = Function.prototype.apply.bind(capture); invoke(undefined, [state]);",
		{ [UTILS_SERIALIZATION_PATH]: RED5_CAPTURE_UTILITY }
	),
	structureFlowRed5Fixture(
		"cross-module imported-binding mutation",
		"separate importer mutates an exported bag consumed by the publisher",
		'import { bag } from "@ts-drp/utils/bag"; import { install } from "@ts-drp/utils/mutator";',
		"install(); bag.capture(state);",
		{
			"packages/utils/src/bag.ts": `
				export const bag: Record<string, (value: unknown) => unknown> = {};
			`,
			"packages/utils/src/mutator.ts": `
				import { encode } from "@msgpack/msgpack";
				import { bag } from "./bag.js";
				export function install(): void {
					bag.capture = (value: unknown): Uint8Array => encode(value);
				}
			`,
		}
	),
	structureFlowRed5Fixture(
		"exported array callable identity",
		"exported array element retains a forbidden callback",
		'import { bag } from "@ts-drp/utils/serialization";',
		"bag[0](state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED5_CAPTURE_UTILITY}\nexport const bag = [capture];` }
	),
	structureFlowRed5Fixture(
		"exported array callable identity",
		"nested exported array element retains a forbidden callback",
		'import { api } from "@ts-drp/utils/serialization";',
		"api.helpers[0](state);",
		{ [UTILS_SERIALIZATION_PATH]: `${RED5_CAPTURE_UTILITY}\nexport const api = { helpers: [capture] };` }
	),
	structureFlowRed5Fixture(
		"class static-block assignment",
		"static block installs a forbidden callable used by the publisher",
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"SnapshotHelper.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					static capture: (value: unknown) => unknown;
					static {
						SnapshotHelper.capture = (value: unknown): Uint8Array => encode(value);
					}
				}
			`,
		}
	),
] satisfies readonly StructureFlowRed5Fixture[]);

const STRUCTURE_FLOW_RED5_CONTROLS = Object.freeze([
	{
		...structureFlowRed5Fixture(
			"bind-of-call/apply",
			"Function.prototype.call.bind with a safe target remains allowed",
			"function safe(value: unknown): unknown { return value; }",
			"const invoke = Function.prototype.call.bind(safe); invoke(undefined, state);"
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"bind-of-call/apply",
			"safe.call.bind with a safe target remains allowed",
			"function safe(value: unknown): unknown { return value; }",
			"const invoke = safe.call.bind(safe); invoke(undefined, state);"
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"bind-of-call/apply",
			"Function.prototype.apply.bind with a safe target remains allowed",
			"function safe(value: unknown): unknown { return value; }",
			"const invoke = Function.prototype.apply.bind(safe); invoke(undefined, [state]);"
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"cross-module imported-binding mutation",
			"separate importer can install a safe exported-bag callback",
			'import { bag } from "@ts-drp/utils/bag"; import { install } from "@ts-drp/utils/mutator";',
			"install(); bag.select(state);",
			{
				"packages/utils/src/bag.ts": `
					export const bag: Record<string, (value: unknown) => unknown> = {};
				`,
				"packages/utils/src/mutator.ts": `
					import { bag } from "./bag.js";
					export function install(): void {
						bag.select = (value: unknown): unknown => value;
					}
				`,
			}
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"exported array callable identity",
			"direct local array retains the same forbidden callback",
			'import { capture } from "@ts-drp/utils/serialization";',
			"const bag = [capture]; bag[0](state);",
			{ [UTILS_SERIALIZATION_PATH]: RED5_CAPTURE_UTILITY }
		),
		shouldViolate: true,
	},
	{
		...structureFlowRed5Fixture(
			"exported array callable identity",
			"exported array with a safe callback remains allowed",
			'import { bag } from "@ts-drp/utils/serialization";',
			"bag[0](state);",
			{ [UTILS_SERIALIZATION_PATH]: "export const bag = [(value: unknown): unknown => value];" }
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"exported array callable identity",
			"nested exported array with a safe callback remains allowed",
			'import { api } from "@ts-drp/utils/serialization";',
			"api.helpers[0](state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					export const api = { helpers: [(value: unknown): unknown => value] };
				`,
			}
		),
		shouldViolate: false,
	},
	{
		...structureFlowRed5Fixture(
			"class static-block assignment",
			"ordinary static post-declaration assignment remains detected",
			'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
			"SnapshotHelper.capture(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					export class SnapshotHelper {
						static capture: (value: unknown) => unknown;
					}
					SnapshotHelper.capture = (value: unknown): Uint8Array => encode(value);
				`,
			}
		),
		shouldViolate: true,
	},
	{
		...structureFlowRed5Fixture(
			"class static-block assignment",
			"static block can install a safe callback",
			'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
			"SnapshotHelper.select(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					export class SnapshotHelper {
						static select: (value: unknown) => unknown;
						static {
							SnapshotHelper.select = (value: unknown): unknown => value;
						}
					}
				`,
			}
		),
		shouldViolate: false,
	},
] satisfies readonly StructureFlowRed5Control[]);

describe("Phase 1d(i) D.92.2 final ordinary structure-flow RED", () => {
	it.each(STRUCTURE_FLOW_RED5_MUTANTS)("rejects $family bypass: $name", ({ expectedViolation, sources }) => {
		const analysis = analyze(sources);
		expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
	});

	it.each(STRUCTURE_FLOW_RED5_CONTROLS)(
		"preserves $family control: $name",
		({ expectedViolation, shouldViolate, sources }) => {
			const analysis = analyze(sources);
			if (shouldViolate) {
				expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
			} else {
				expect(analysis.violations).toEqual([]);
			}
		}
	);
});

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

function frozenWorkspaceFixture(
	name: string,
	expectedViolation: RegExp,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>>
): WorkspaceMutationFixture {
	return Object.freeze({
		expectedViolation,
		name,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		}),
	});
}

const CALLABLE_EXPORT_DISCOVERY_MUTANTS = Object.freeze([
	frozenWorkspaceFixture(
		"exported const arrow",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	frozenWorkspaceFixture(
		"exported const function expression",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const capture = function (value: unknown): Uint8Array { return encode(value); };
			`,
		}
	),
	frozenWorkspaceFixture(
		"local nested arrow",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array {
					const inner = (item: unknown): Uint8Array => encode(item);
					return inner(value);
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"local nested function expression",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array {
					const inner = function (item: unknown): Uint8Array { return encode(item); };
					return inner(value);
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"anonymous default export",
		ENCODE_VIOLATION,
		'import capture from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export default function (value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"local declaration exported by export list",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				function capture(value: unknown): Uint8Array { return encode(value); }
				export { capture };
			`,
		}
	),
	frozenWorkspaceFixture(
		"one-hop export-star barrel",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils";',
		"capture(state);",
		{
			"packages/utils/src/index.ts": 'export * from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"multi-hop export-star barrel",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils";',
		"capture(state);",
		{
			"packages/utils/src/index.ts": 'export * from "./bridge.js";',
			"packages/utils/src/bridge.ts": 'export * from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	Object.freeze({
		expectedViolation: CLONE_VIOLATION,
		name: "class-property arrow at DRPObject.getStates",
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/object/src/index.ts": `
				export class DRPObject {
					private readonly detach = (value: unknown): unknown => structuredClone(value);
					getStates(value: unknown): unknown { return this.detach(value); }
				}
			`,
		}),
	}),
	Object.freeze({
		expectedViolation: CLONE_VIOLATION,
		name: "static class helper reached by DRPObject.getStates",
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/object/src/index.ts": `
				export class DRPObject {
					private static detach(value: unknown): unknown { return structuredClone(value); }
					getStates(value: unknown): unknown { return DRPObject.detach(value); }
				}
			`,
		}),
	}),
] satisfies readonly WorkspaceMutationFixture[]);

const INDIRECT_CALL_MUTANTS = Object.freeze([
	frozenWorkspaceFixture(
		"destructured namespace alias",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		"const { capture } = snapshots; capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"destructured object alias",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		"const holder = { capture: snapshots.capture }; const { capture } = holder; capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"callback returned across a function",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 function retain(callback: (value: unknown) => unknown): (value: unknown) => unknown { return callback; }`,
		"const deferred = retain(capture); deferred(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"callback stored across a function",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 let retained: ((value: unknown) => unknown) | undefined;
		 function retain(callback: (value: unknown) => unknown): void { retained = callback; }`,
		"retain(capture); retained?.(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"Reflect.apply indirection",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"Reflect.apply(capture, undefined, [state]);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"comma-expression call",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"(0, capture)(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"exported helper object method",
		ENCODE_VIOLATION,
		'import { helpers } from "@ts-drp/utils/serialization";',
		"helpers.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const helpers = {
					capture(value: unknown): Uint8Array { return encode(value); },
				};
			`,
		}
	),
] satisfies readonly WorkspaceMutationFixture[]);

const MODULE_AND_PRIMITIVE_MUTANTS = Object.freeze([
	frozenWorkspaceFixture(
		"unresolved internal workspace import",
		/unresolved|fail.?closed|@ts-drp\/does-not-exist/,
		'import { capture } from "@ts-drp/does-not-exist/serialization";',
		"capture(state);",
		{}
	),
	frozenWorkspaceFixture(
		"dynamic import of known MessagePack serializer",
		ENCODE_VIOLATION,
		"",
		'void import("@msgpack/msgpack").then(({ encode }) => encode(state));',
		{}
	),
	frozenWorkspaceFixture(
		"node:v8 serialize-deserialize round trip",
		ROUND_TRIP_VIOLATION,
		'import { cloneThroughBytes } from "@ts-drp/utils/serialization";',
		"cloneThroughBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { deserialize, serialize } from "node:v8";
				export function cloneThroughBytes(value: unknown): unknown {
					return deserialize(serialize(value));
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"Bufbuild protobuf toBinary-fromBinary round trip",
		ROUND_TRIP_VIOLATION,
		'import { cloneThroughProtobuf } from "@ts-drp/utils/serialization";',
		"cloneThroughProtobuf(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { fromBinary, toBinary } from "@bufbuild/protobuf";
				export function cloneThroughProtobuf(schema: unknown, value: unknown): unknown {
					return fromBinary(schema, toBinary(schema, value));
				}
			`,
		}
	),
] satisfies readonly WorkspaceMutationFixture[]);

const REVIEWED_OWNER_MULTIPLICITY_MUTANTS = Object.freeze([
	Object.freeze({
		expectedViolation: CLONE_VIOLATION,
		name: "extra discarded and full clone inside reviewed publication copy owner",
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: `
				import { cloneDeep } from "es-toolkit";
				class DRPVertexApplier {
					private readonly sink: (event: unknown) => unknown;
					constructor({ publicationObserver }: { publicationObserver: (event: unknown) => unknown }) {
						this.sink = publicationObserver;
					}
					assignState(): void { this.copyPublicationPayload({ value: 1 }); }
					advanceCheckpointIfNeeded(): void { this.copyPublicationPayload({ value: 1 }); }
					private copyPublicationPayload(value: unknown): unknown {
						cloneDeep({ discarded: value });
						const full = cloneDeep({ changed: value, ballast: { stable: true } });
						this.sink({ type: "copy", value });
						return full;
					}
				}
			`,
		}),
	}),
	Object.freeze({
		expectedViolation: CLONE_VIOLATION,
		name: "reviewed ownership path-name-body mimic",
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/object/src/index.ts": `
				import { cloneDeep } from "es-toolkit";
				export class DRPObject {
					getStates(value: unknown): unknown {
						void this.getACLState;
						void this.getDRPState;
						return cloneDeep(value);
					}
				}
			`,
		}),
	}),
] satisfies readonly WorkspaceMutationFixture[]);

const SYMBOLIC_INVOCATION_MUTANTS = Object.freeze([
	frozenWorkspaceFixture(
		"Function.prototype.call on an imported callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture.call(undefined, state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"Function.prototype.apply on an imported callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture.apply(undefined, [state]);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"Function.prototype.bind followed by invocation",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const bound = capture.bind(undefined); bound(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"constructed imported helper instance method",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"new SnapshotHelper().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"constructed imported helper class-field arrow",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"new SnapshotHelper().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					capture = (value: unknown): Uint8Array => encode(value);
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"imported static helper method",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"SnapshotHelper.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					static capture(value: unknown): Uint8Array { return encode(value); }
				}
			`,
		}
	),
	frozenWorkspaceFixture(
		"exported class-expression helper",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"new SnapshotHelper().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const SnapshotHelper = class {
					capture(value: unknown): Uint8Array { return encode(value); }
				};
			`,
		}
	),
	frozenWorkspaceFixture(
		"variable-key computed namespace call",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		'const key = "capture"; snapshots[key](state);',
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"ternary callable alias",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const selected = state.changed ? capture : capture; selected(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"getter escape",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const holder = { get deferred() { return capture; } }; holder.deferred(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"namespace spread escape",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		"const holder = { ...snapshots }; holder.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"object spread escape",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const source = { capture }; const holder = { ...source }; holder.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"array-stored callback",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const callbacks = [capture]; callbacks[0](state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		}
	),
	frozenWorkspaceFixture(
		"IIFE wrapping direct MessagePack encode",
		ENCODE_VIOLATION,
		'import { encode } from "@msgpack/msgpack";',
		"(() => encode(state))();",
		{}
	),
	frozenWorkspaceFixture(
		"globalThis.JSON stringify-parse clone",
		ROUND_TRIP_VIOLATION,
		"",
		"globalThis.JSON.parse(globalThis.JSON.stringify(state));",
		{}
	),
] satisfies readonly WorkspaceMutationFixture[]);

const FAIL_CLOSED_MODULE_MUTANTS = Object.freeze([
	frozenWorkspaceFixture(
		"missing named export from a resolvable workspace module",
		/missing|unresolved|fail.?closed|export/i,
		'import { missingCapture } from "@ts-drp/utils/serialization";',
		"missingCapture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: "export function available(value: unknown): unknown { return value; }",
		}
	),
	frozenWorkspaceFixture(
		"missing default export from a resolvable workspace module",
		/missing|unresolved|fail.?closed|export/i,
		'import missingCapture from "@ts-drp/utils/serialization";',
		"missingCapture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: "export function available(value: unknown): unknown { return value; }",
		}
	),
	frozenWorkspaceFixture(
		"dynamic import of a resolvable internal workspace module",
		/missing|unresolved|fail.?closed|dynamic|import/i,
		"",
		'void import("@ts-drp/utils/serialization").then(({ capture }) => capture(state));',
		{
			[UTILS_SERIALIZATION_PATH]: "export function capture(value: unknown): unknown { return value; }",
		}
	),
] satisfies readonly WorkspaceMutationFixture[]);

interface SemanticFlowFixture extends WorkspaceMutationFixture {
	readonly family: string;
}

interface SemanticFlowControl {
	readonly family: string;
	readonly name: string;
	readonly shouldViolate: boolean;
	readonly sources: Readonly<Record<string, string>>;
}

function semanticFlowFixture(
	family: string,
	name: string,
	expectedViolation: RegExp,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>> = {}
): SemanticFlowFixture {
	return Object.freeze({
		expectedViolation,
		family,
		name,
		sources: Object.freeze({
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation),
			...dependencies,
		}),
	});
}

const FLOW_CAPTURE_UTILITY = `
	import { encode } from "@msgpack/msgpack";
	export function capture(value: unknown): Uint8Array { return encode(value); }
	export function safe(value: unknown): unknown { return value; }
`;

const SEMANTIC_FLOW_CLOSURE_MUTANTS = Object.freeze([
	semanticFlowFixture(
		"callback apply/bind argument flow",
		"relay.apply with an inline argument array",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 function relay(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); }`,
		"relay.apply(null, [capture, state]);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"callback apply/bind argument flow",
		"relay.apply with a tracked argument-array alias",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 function relay(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); }`,
		"const args = [capture, state] as const; relay.apply(null, args);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"callback apply/bind argument flow",
		"partially bound relay invoked immediately",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 function relay(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); }`,
		"relay.bind(null, capture)(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"callback apply/bind argument flow",
		"partially bound relay retained behind an alias",
		ENCODE_VIOLATION,
		`import { capture } from "@ts-drp/utils/serialization";
		 function relay(callback: (value: unknown) => unknown, value: unknown): unknown { return callback(value); }`,
		"const boundRelay = relay.bind(null, capture); boundRelay(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"class heritage",
		"imported derived class inherits a forbidden base member",
		ENCODE_VIOLATION,
		'import { DerivedCapture } from "@ts-drp/utils/serialization";',
		"new DerivedCapture().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class BaseCapture {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
				export class DerivedCapture extends BaseCapture {}
			`,
		}
	),
	semanticFlowFixture(
		"class heritage",
		"local derived class inherits an imported forbidden member",
		ENCODE_VIOLATION,
		`import { BaseCapture } from "@ts-drp/utils/serialization";
		 class DerivedCapture extends BaseCapture {}`,
		"new DerivedCapture().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class BaseCapture {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
			`,
		}
	),
	semanticFlowFixture(
		"class heritage",
		"this dispatch reaches an inherited forbidden member",
		ENCODE_VIOLATION,
		`import { BaseCapture } from "@ts-drp/utils/serialization";
		 class DerivedCapture extends BaseCapture {
			publish(value: unknown): unknown { return this.capture(value); }
		 }`,
		"new DerivedCapture().publish(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class BaseCapture {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
			`,
		}
	),
	semanticFlowFixture(
		"class heritage",
		"super dispatch reaches an inherited forbidden member",
		ENCODE_VIOLATION,
		`import { BaseCapture } from "@ts-drp/utils/serialization";
		 class DerivedCapture extends BaseCapture {
			publish(value: unknown): unknown { return super.capture(value); }
		 }`,
		"new DerivedCapture().publish(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class BaseCapture {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
			`,
		}
	),
	semanticFlowFixture(
		"class heritage",
		"unknown heritage fails closed instead of inventing a safe member",
		/unresolved|unknown|fail.?closed|heritage|base/i,
		`declare const UnknownBase: new () => { capture(value: unknown): unknown };
		 class DerivedCapture extends UnknownBase {}`,
		"new DerivedCapture().capture(state);"
	),
	semanticFlowFixture(
		"global primitive provenance",
		"JSON namespace retained behind a local alias",
		ROUND_TRIP_VIOLATION,
		'import { cloneViaJson } from "@ts-drp/utils/serialization";',
		"cloneViaJson(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				export function cloneViaJson(value: unknown): unknown {
					const J = JSON;
					return J.parse(J.stringify(value));
				}
			`,
		}
	),
	semanticFlowFixture(
		"global primitive provenance",
		"destructured JSON parse and stringify retain round-trip provenance",
		ROUND_TRIP_VIOLATION,
		'import { cloneViaJson } from "@ts-drp/utils/serialization";',
		"cloneViaJson(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				export function cloneViaJson(value: unknown): unknown {
					const { parse, stringify } = JSON;
					return parse(stringify(value));
				}
			`,
		}
	),
	semanticFlowFixture(
		"global primitive provenance",
		"globalThis.JSON retained behind a local alias",
		ROUND_TRIP_VIOLATION,
		'import { cloneViaJson } from "@ts-drp/utils/serialization";',
		"cloneViaJson(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				export function cloneViaJson(value: unknown): unknown {
					const J = globalThis.JSON;
					return J.parse(J.stringify(value));
				}
			`,
		}
	),
	semanticFlowFixture(
		"global primitive provenance",
		"destructured globalThis.structuredClone in a transitive helper",
		CLONE_VIOLATION,
		'import { detach } from "@ts-drp/utils/serialization";',
		"detach(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				export function detach(value: unknown): unknown {
					const { structuredClone: copy } = globalThis;
					return copy(value);
				}
			`,
		}
	),
	semanticFlowFixture(
		"computed-key uncertainty",
		"divergent namespace key unions a forbidden candidate",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		'snapshots[state.changed ? "capture" : "safe"](state);',
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"computed-key uncertainty",
		"unknown object key fails closed when a forbidden candidate is present",
		ENCODE_VIOLATION,
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		`const holder = { capture, safe };
		 const key = (globalThis as { publicationKey?: string }).publicationKey ?? "safe";
		 holder[key](state);`,
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"stored callback flow",
		"array destructuring preserves stored callback provenance",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const callbacks = [capture]; const [callback] = callbacks; callback(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"stored callback flow",
		"mutable local assignment joins callable targets",
		ENCODE_VIOLATION,
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"let callback = safe; callback = capture; callback(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"stored callback flow",
		"object-property assignment joins callable targets",
		ENCODE_VIOLATION,
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"const holder = { callback: safe }; holder.callback = capture; holder.callback(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"unsupported callback storage",
		"module reassignment to a fresh callback arrow fails closed",
		ENCODE_VIOLATION,
		`import { capture, safe } from "@ts-drp/utils/serialization";
		 let retained: (value: unknown) => unknown = safe;
		 function install(): void { retained = (value: unknown) => capture(value); }`,
		"install(); retained(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"unsupported callback storage",
		"getter returning a fresh callback arrow fails closed",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		`const holder = { get deferred() { return (value: unknown) => capture(value); } };
		 holder.deferred(state);`,
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"unsupported callback storage",
		"object-rest storage preserves a forbidden callback",
		ENCODE_VIOLATION,
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		"const source = { capture, safe }; const { safe: ignored, ...rest } = source; void ignored; rest.capture(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"unsupported callback storage",
		"constant string concatenation resolves a forbidden namespace member",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		'const key = "cap" + "ture"; snapshots[key](state);',
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"nested Function.prototype invocation",
		"Function.prototype.call.call preserves the target callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"Function.prototype.call.call(capture, null, state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"nested Function.prototype invocation",
		"Function.prototype.apply.call preserves the target callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"Function.prototype.apply.call(capture, null, [state]);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
] satisfies readonly SemanticFlowFixture[]);

const SEMANTIC_FLOW_SAFE_CONTROLS = Object.freeze([
	{
		family: "callback apply/bind argument flow",
		name: "direct capture.apply remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"callback apply/bind argument flow",
			"direct apply",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"capture.apply(null, [state]);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "callback apply/bind argument flow",
		name: "direct capture.bind alias remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"callback apply/bind argument flow",
			"direct bind",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const bound = capture.bind(null); bound(state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "class heritage",
		name: "own forbidden member remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"class heritage",
			"own member",
			ENCODE_VIOLATION,
			'import { OwnCapture } from "@ts-drp/utils/serialization";',
			"new OwnCapture().capture(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					export class OwnCapture {
						capture(value: unknown): Uint8Array { return encode(value); }
					}
				`,
			}
		).sources,
	},
	{
		family: "class heritage",
		name: "safe inherited member remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"class heritage",
			"safe inherited member",
			ENCODE_VIOLATION,
			'import { SafeDerived } from "@ts-drp/utils/serialization";',
			"new SafeDerived().select(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					export class SafeBase { select(value: unknown): unknown { return value; } }
					export class SafeDerived extends SafeBase {}
				`,
			}
		).sources,
	},
	{
		family: "global primitive provenance",
		name: "direct JSON round trip remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"global primitive provenance",
			"direct JSON",
			ROUND_TRIP_VIOLATION,
			'import { cloneViaJson } from "@ts-drp/utils/serialization";',
			"cloneViaJson(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					export function cloneViaJson(value: unknown): unknown {
						return JSON.parse(JSON.stringify(value));
					}
				`,
			}
		).sources,
	},
	{
		family: "global primitive provenance",
		name: "direct structuredClone remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"global primitive provenance",
			"direct structuredClone",
			CLONE_VIOLATION,
			'import { detach } from "@ts-drp/utils/serialization";',
			"detach(state);",
			{
				[UTILS_SERIALIZATION_PATH]:
					"export function detach(value: unknown): unknown { return structuredClone(value); }",
			}
		).sources,
	},
	{
		family: "global primitive provenance",
		name: "stringify-only hash remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"global primitive provenance",
			"stringify-only hash",
			ROUND_TRIP_VIOLATION,
			'import { hashLength } from "@ts-drp/utils/serialization";',
			"void hashLength(state);",
			{
				[UTILS_SERIALIZATION_PATH]:
					"export function hashLength(value: unknown): number { return JSON.stringify(value).length; }",
			}
		).sources,
	},
	{
		family: "computed-key uncertainty",
		name: "stable literal namespace member remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"computed-key uncertainty",
			"stable literal",
			ENCODE_VIOLATION,
			'import * as snapshots from "@ts-drp/utils/serialization";',
			'const key = "capture"; snapshots[key](state);',
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "computed-key uncertainty",
		name: "unknown key on a safe-only object remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"computed-key uncertainty",
			"safe object",
			ENCODE_VIOLATION,
			'import { safe } from "@ts-drp/utils/serialization";',
			`const holder = { safe };
			 const key = (globalThis as { publicationKey?: string }).publicationKey ?? "safe";
			 holder[key](state);`,
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "computed-key uncertainty",
		name: "unknown key on a safe-only namespace remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"computed-key uncertainty",
			"safe namespace",
			ENCODE_VIOLATION,
			'import * as safeHelpers from "@ts-drp/utils/safe";',
			`const key = (globalThis as { publicationKey?: string }).publicationKey ?? "select";
			 safeHelpers[key](state);`,
			{ "packages/utils/src/safe.ts": "export function select(value: unknown): unknown { return value; }" }
		).sources,
	},
	{
		family: "stored callback flow",
		name: "direct callback initializer remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"stored callback flow",
			"direct initializer",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const callback = capture; callback(state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "stored callback flow",
		name: "direct array index remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"stored callback flow",
			"direct index",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const callbacks = [capture]; callbacks[0](state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "stored callback flow",
		name: "getter returning an existing callback remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"stored callback flow",
			"existing getter callback",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const holder = { get deferred() { return capture; } }; holder.deferred(state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "stored callback flow",
		name: "same-file safe callback storage remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"stored callback flow",
			"same-file safe storage",
			ENCODE_VIOLATION,
			"function select(value: unknown): unknown { return value; }",
			"const holder = { callback: select }; holder.callback(state);"
		).sources,
	},
	{
		family: "safe encode names",
		name: "resolved logger encode remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"safe encode names",
			"logger encode",
			ENCODE_VIOLATION,
			'import { encode } from "@ts-drp/logger";',
			"encode(state);",
			{ "packages/logger/src/index.ts": "export function encode(value: unknown): unknown { return value; }" }
		).sources,
	},
	{
		family: "safe encode names",
		name: "resolved tracer encode remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"safe encode names",
			"tracer encode",
			ENCODE_VIOLATION,
			'import { encode } from "@ts-drp/tracer";',
			"encode(state);",
			{ "packages/tracer/src/index.ts": "export function encode(value: unknown): unknown { return value; }" }
		).sources,
	},
	{
		family: "safe encode names",
		name: "local encode remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"safe encode names",
			"local encode",
			ENCODE_VIOLATION,
			"function encode(value: unknown): unknown { return value; }",
			"encode(state);"
		).sources,
	},
] satisfies readonly SemanticFlowControl[]);

const STRUCTURE_FLOW_RED3_MUTANTS = Object.freeze([
	semanticFlowFixture(
		"exported object-bag identifier properties",
		"exported shorthand property wrapping a forbidden helper",
		ENCODE_VIOLATION,
		'import { snapshots } from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				function capture(value: unknown): Uint8Array { return encode(value); }
				export const snapshots = { capture };
			`,
		}
	),
	semanticFlowFixture(
		"exported object-bag identifier properties",
		"exported explicit identifier property wrapping a forbidden helper",
		ENCODE_VIOLATION,
		'import { snapshots } from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				function capture(value: unknown): Uint8Array { return encode(value); }
				export const snapshots = { capture: capture };
			`,
		}
	),
	semanticFlowFixture(
		"default-export object properties",
		"default-export object method reaches a forbidden helper",
		ENCODE_VIOLATION,
		'import snapshots from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export default {
					capture(value: unknown): Uint8Array { return encode(value); },
				};
			`,
		}
	),
	semanticFlowFixture(
		"default-export object properties",
		"property access on a missing default export fails closed",
		/unresolved|missing|fail.?closed|default|export/i,
		'import snapshots from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: "export function available(value: unknown): unknown { return value; }",
		}
	),
	semanticFlowFixture(
		"nested Function.prototype invocation",
		"Function.prototype.bind.call preserves the target callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const bound = Function.prototype.bind.call(capture, null); bound(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"nested object property chains",
		"nested exported object method reaches a forbidden helper",
		ENCODE_VIOLATION,
		'import { api } from "@ts-drp/utils/serialization";',
		"api.snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const api = {
					snapshots: {
						capture(value: unknown): Uint8Array { return encode(value); },
					},
				};
			`,
		}
	),
	semanticFlowFixture(
		"module-scope callable reassignment",
		"exported callable joins a forbidden module-scope reassignment",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export let capture = (value: unknown): unknown => value;
				capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"bodyless class members",
		"ambient base member call fails closed",
		/unresolved|unknown|fail.?closed|ambient|declare|member/i,
		'import { DerivedCapture } from "@ts-drp/utils/serialization";',
		"new DerivedCapture().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				export declare class ExternalCapture {
					capture(value: unknown): unknown;
				}
				export class DerivedCapture extends ExternalCapture {}
			`,
		}
	),
	semanticFlowFixture(
		"constructor field assignment",
		"constructor this-field callable assignment reaches a forbidden helper",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"new SnapshotHelper().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					capture: (value: unknown) => Uint8Array;
					constructor() {
						this.capture = (value: unknown): Uint8Array => encode(value);
					}
				}
			`,
		}
	),
	semanticFlowFixture(
		"unresolved relative imports",
		"unresolved relative workspace import fails closed",
		/unresolved|missing|fail.?closed|relative|import/i,
		'import { capture } from "../missing.js";',
		"capture(state);"
	),
] satisfies readonly SemanticFlowFixture[]);

const STRUCTURE_FLOW_RED3_SAFE_OBJECT_BAG = semanticFlowFixture(
	"safe object bags",
	"shorthand, explicit, nested, and default safe bags remain allowed",
	ENCODE_VIOLATION,
	`import safeDefault, { safeBags } from "@ts-drp/utils/serialization";`,
	`safeBags.shorthand(state);
	 safeBags.explicit(state);
	 safeBags.nested.select(state);
	 safeDefault.select(state);`,
	{
		[UTILS_SERIALIZATION_PATH]: `
			function select(value: unknown): unknown { return value; }
			export const safeBags = {
				shorthand: select,
				explicit: select,
				nested: { select(value: unknown): unknown { return value; } },
			};
			export default { select(value: unknown): unknown { return value; } };
		`,
	}
);

const STRUCTURE_FLOW_RED3_POSITIVE_CONTROLS = Object.freeze([
	semanticFlowFixture(
		"exported object-bag identifier properties",
		"flat exported object method remains detected",
		ENCODE_VIOLATION,
		'import { snapshots } from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const snapshots = {
					capture(value: unknown): Uint8Array { return encode(value); },
				};
			`,
		}
	),
	semanticFlowFixture(
		"nested Function.prototype invocation",
		"direct bind alias remains detected",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const bound = capture.bind(null); bound(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"module-scope callable reassignment",
		"forbidden exported callable initializer remains detected",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export let capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"bodyless class members",
		"bodyful base member remains detected",
		ENCODE_VIOLATION,
		'import { DerivedCapture } from "@ts-drp/utils/serialization";',
		"new DerivedCapture().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class BaseCapture {
					capture(value: unknown): Uint8Array { return encode(value); }
				}
				export class DerivedCapture extends BaseCapture {}
			`,
		}
	),
	semanticFlowFixture(
		"default-export object properties",
		"direct missing default call remains fail closed",
		/unresolved|missing|fail.?closed|default|export/i,
		'import missingCapture from "@ts-drp/utils/serialization";',
		"missingCapture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: "export function available(value: unknown): unknown { return value; }",
		}
	),
	semanticFlowFixture(
		"constructor field assignment",
		"class-field callable initializer remains detected",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"new SnapshotHelper().capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					capture = (value: unknown): Uint8Array => encode(value);
				}
			`,
		}
	),
	semanticFlowFixture(
		"unresolved relative imports",
		"unresolved workspace package import remains fail closed",
		/unresolved|missing|fail.?closed|import/i,
		'import { capture } from "@ts-drp/does-not-exist/serialization";',
		"capture(state);"
	),
] satisfies readonly SemanticFlowFixture[]);

function backwardAssignmentChain(hops: number): string {
	const declarations = Array.from({ length: hops }, (_value, index) => `let v${index + 1} = safe;`).join("\n");
	const assignments = Array.from(
		{ length: hops - 1 },
		(_value, index) => `v${hops - index} = v${hops - index - 1};`
	).join("\n");
	return `${declarations}\n${assignments}\nv1 = snap;\nv${hops}(state);`;
}

const STRUCTURE_FLOW_RED4_MUTANTS = Object.freeze([
	semanticFlowFixture(
		"cross-module post-initializer object properties",
		"empty exported bag receives a forbidden property after initialization",
		ENCODE_VIOLATION,
		'import { snapshots } from "@ts-drp/utils/serialization";',
		"snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const snapshots: Record<string, (value: unknown) => unknown> = {};
				snapshots.capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"cross-module post-initializer object properties",
		"nested exported bag receives a forbidden property after initialization",
		ENCODE_VIOLATION,
		'import { api } from "@ts-drp/utils/serialization";',
		"api.snapshots.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export const api: any = { snapshots: {} };
				api.snapshots.capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"cross-module post-initializer object properties",
		"initialized exported bag receives a later forbidden extra property",
		ENCODE_VIOLATION,
		'import { snapshots } from "@ts-drp/utils/serialization";',
		"snapshots.extra(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				function select(value: unknown): unknown { return value; }
				export const snapshots: any = { select };
				snapshots.extra = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"bind indirection",
		"call through an imported callable bind method",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const bound = capture.bind.call(capture, null); bound(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"bind indirection",
		"Function.prototype.bind.apply creates a forbidden bound callable",
		ENCODE_VIOLATION,
		'import { capture } from "@ts-drp/utils/serialization";',
		"const bound = Function.prototype.bind.apply(capture, [null]); bound(state);",
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"imported class static post-declaration assignment",
		"imported class receives a forbidden static callable after declaration",
		ENCODE_VIOLATION,
		'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
		"SnapshotHelper.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				export class SnapshotHelper {
					static capture: (value: unknown) => unknown;
				}
				SnapshotHelper.capture = (value: unknown): Uint8Array => encode(value);
			`,
		}
	),
	semanticFlowFixture(
		"finite fixpoint boundary",
		"exact backward-ordered 12-hop assignment chain reaches a forbidden callable",
		ENCODE_VIOLATION,
		'import { capture as snap, safe } from "@ts-drp/utils/serialization";',
		backwardAssignmentChain(12),
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
	semanticFlowFixture(
		"runtime-unknown computed-key write",
		"unknown computed write can replace the later literal-read callback",
		ENCODE_VIOLATION,
		'import { capture, safe } from "@ts-drp/utils/serialization";',
		`const holder: Record<string, (value: unknown) => unknown> = { capture: safe };
		 const key = (globalThis as { publicationKey?: string }).publicationKey ?? "capture";
		 holder[key] = capture;
		 holder.capture(state);`,
		{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
	),
] satisfies readonly SemanticFlowFixture[]);

const STRUCTURE_FLOW_RED4_CONTROLS = Object.freeze([
	{
		family: "cross-module post-initializer object properties",
		name: "initializer property wrapping the same forbidden helper remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"cross-module post-initializer object properties",
			"initializer property",
			ENCODE_VIOLATION,
			'import { snapshots } from "@ts-drp/utils/serialization";',
			"snapshots.capture(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					function capture(value: unknown): Uint8Array { return encode(value); }
					export const snapshots = { capture };
				`,
			}
		).sources,
	},
	{
		family: "cross-module post-initializer object properties",
		name: "safe post-initializer exported property remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"cross-module post-initializer object properties",
			"safe post-initializer property",
			ENCODE_VIOLATION,
			'import { snapshots } from "@ts-drp/utils/serialization";',
			"snapshots.select(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					export const snapshots: Record<string, (value: unknown) => unknown> = {};
					snapshots.select = (value: unknown): unknown => value;
				`,
			}
		).sources,
	},
	{
		family: "bind indirection",
		name: "direct callable.bind remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"bind indirection",
			"direct callable.bind",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const bound = capture.bind(null); bound(state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "bind indirection",
		name: "Function.prototype.bind.call remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"bind indirection",
			"Function.prototype.bind.call",
			ENCODE_VIOLATION,
			'import { capture } from "@ts-drp/utils/serialization";',
			"const bound = Function.prototype.bind.call(capture, null); bound(state);",
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "imported class static post-declaration assignment",
		name: "static field initializer remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"imported class static post-declaration assignment",
			"static field initializer",
			ENCODE_VIOLATION,
			'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
			"SnapshotHelper.capture(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					export class SnapshotHelper {
						static capture = (value: unknown): Uint8Array => encode(value);
					}
				`,
			}
		).sources,
	},
	{
		family: "imported class static post-declaration assignment",
		name: "static method remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"imported class static post-declaration assignment",
			"static method",
			ENCODE_VIOLATION,
			'import { SnapshotHelper } from "@ts-drp/utils/serialization";',
			"SnapshotHelper.capture(state);",
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					export class SnapshotHelper {
						static capture(value: unknown): Uint8Array { return encode(value); }
					}
				`,
			}
		).sources,
	},
	{
		family: "finite fixpoint boundary",
		name: "exact backward-ordered 10-hop assignment chain remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"finite fixpoint boundary",
			"exact 10-hop chain",
			ENCODE_VIOLATION,
			'import { capture as snap, safe } from "@ts-drp/utils/serialization";',
			backwardAssignmentChain(10),
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "runtime-unknown computed-key write",
		name: "statically resolvable computed write remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"runtime-unknown computed-key write",
			"resolvable computed write",
			ENCODE_VIOLATION,
			'import { capture, safe } from "@ts-drp/utils/serialization";',
			`const holder = { capture: safe };
			 const key = "capture";
			 holder[key] = capture;
			 holder.capture(state);`,
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "runtime-unknown computed-key write",
		name: "literal write followed by an unknown read remains detected",
		shouldViolate: true,
		sources: semanticFlowFixture(
			"runtime-unknown computed-key write",
			"literal write and unknown read",
			ENCODE_VIOLATION,
			'import { capture, safe } from "@ts-drp/utils/serialization";',
			`const holder: Record<string, (value: unknown) => unknown> = { capture: safe };
			 holder.capture = capture;
			 const key = (globalThis as { publicationKey?: string }).publicationKey ?? "capture";
			 holder[key](state);`,
			{ [UTILS_SERIALIZATION_PATH]: FLOW_CAPTURE_UTILITY }
		).sources,
	},
	{
		family: "runtime-unknown computed-key write",
		name: "safe dynamic write remains allowed",
		shouldViolate: false,
		sources: semanticFlowFixture(
			"runtime-unknown computed-key write",
			"safe dynamic write",
			ENCODE_VIOLATION,
			"function select(value: unknown): unknown { return value; }",
			`const holder: Record<string, (value: unknown) => unknown> = { select };
			 const key = (globalThis as { publicationKey?: string }).publicationKey ?? "select";
			 holder[key] = select;
			 holder.select(state);`
		).sources,
	},
] satisfies readonly SemanticFlowControl[]);

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

	it.each(CALLABLE_EXPORT_DISCOVERY_MUTANTS)(
		"kills callable/export discovery bypass: $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(INDIRECT_CALL_MUTANTS)("kills indirect call bypass: $name", ({ expectedViolation, sources }) => {
		const analysis = analyze(sources);
		expect(analysis.injectedCopyLeaves).toHaveLength(1);
		expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
	});

	it.each(MODULE_AND_PRIMITIVE_MUTANTS)(
		"fails closed on module/provenance bypass: $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(REVIEWED_OWNER_MULTIPLICITY_MUTANTS)(
		"does not grant reviewed status by deduplication or mimicry: $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(SYMBOLIC_INVOCATION_MUTANTS)(
		"kills symbolic invocation or callable escape bypass: $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(FAIL_CLOSED_MODULE_MUTANTS)(
		"fails closed rather than silently dropping provenance: $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(SEMANTIC_FLOW_CLOSURE_MUTANTS)(
		"closes semantic flow family '$family': $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(SEMANTIC_FLOW_SAFE_CONTROLS)(
		"preserves discriminating control for '$family': $name",
		({ shouldViolate, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations.length > 0).toBe(shouldViolate);
		}
	);

	it.each(STRUCTURE_FLOW_RED3_MUTANTS)(
		"closes ordinary TypeScript structure-flow family '$family': $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it("keeps shorthand, explicit, nested, and default-export safe object bags clean", () => {
		const analysis = analyze(STRUCTURE_FLOW_RED3_SAFE_OBJECT_BAG.sources);
		expect(analysis.injectedCopyLeaves).toHaveLength(1);
		expect(analysis.violations).toEqual([]);
	});

	it.each(STRUCTURE_FLOW_RED3_POSITIVE_CONTROLS)(
		"preserves adjacent supported structure-flow control for '$family': $name",
		({ expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(STRUCTURE_FLOW_RED4_MUTANTS)(
		"RED4 rejects ordinary D.92.2 structure-flow bypass '$family': $name",
		({ expectedViolation, family, sources }) => {
			const publisher = sources[WORKSPACE_PUBLISHER_PATH];
			if (family === "finite fixpoint boundary") {
				expect(publisher.match(/\blet v\d+ = safe;/g)).toHaveLength(12);
				expect(publisher.match(/\bv\d+ = (?:v\d+|snap);/g)).toHaveLength(12);
			}
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			expect(analysis.violations, "unsafe RED4 mutant must not be accepted with no violation").not.toEqual([]);
			expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(expectedViolation)]));
		}
	);

	it.each(STRUCTURE_FLOW_RED4_CONTROLS)(
		"RED4 preserves adjacent control for '$family': $name",
		({ family, shouldViolate, sources }) => {
			const publisher = sources[WORKSPACE_PUBLISHER_PATH];
			if (family === "finite fixpoint boundary") {
				expect(publisher.match(/\blet v\d+ = safe;/g)).toHaveLength(10);
				expect(publisher.match(/\bv\d+ = (?:v\d+|snap);/g)).toHaveLength(10);
			}
			const analysis = analyze(sources);
			expect(analysis.injectedCopyLeaves).toHaveLength(1);
			if (shouldViolate) {
				expect(analysis.violations).toEqual(expect.arrayContaining([expect.stringMatching(ENCODE_VIOLATION)]));
			} else {
				expect(analysis.violations).toEqual([]);
			}
		}
	);

	it("retains stable literal computed namespace calls as a positive violation control", () => {
		const fixture = frozenWorkspaceFixture(
			"stable literal computed namespace call",
			ENCODE_VIOLATION,
			'import * as snapshots from "@ts-drp/utils/serialization";',
			'snapshots["capture"](state);',
			{
				[UTILS_SERIALIZATION_PATH]: `
					import { encode } from "@msgpack/msgpack";
					export function capture(value: unknown): Uint8Array { return encode(value); }
				`,
			}
		);
		expect(analyze(fixture.sources).violations).toEqual(
			expect.arrayContaining([expect.stringMatching(fixture.expectedViolation)])
		);
	});

	it.each([
		{
			expectedViolation: false,
			name: "JSON stringify used only as deterministic hash input",
			source: `
				export function computeHash(value: unknown): number {
					return JSON.stringify(value).length;
				}
			`,
		},
		{
			expectedViolation: true,
			name: "JSON stringify-parse used as a payload clone",
			source: `
				export function computeHash(value: unknown): unknown {
					return JSON.parse(JSON.stringify(value));
				}
			`,
		},
	] as const)("classifies $name without treating all JSON use as cloning", ({ expectedViolation, source }) => {
		const sources = {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { computeHash } from "@ts-drp/utils/hash";',
				"void computeHash(state);"
			),
			"packages/utils/src/hash/index.ts": source,
		};
		const hasJsonViolation = analyze(sources).violations.some((violation) => /json|round.?trip/i.test(violation));
		expect(hasJsonViolation).toBe(expectedViolation);
	});

	it("keeps same-named callables scoped per file instead of colliding globally", () => {
		const sources = {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { capture } from "@ts-drp/utils/serialization";',
				"capture(state);"
			),
			[UTILS_SERIALIZATION_PATH]: "export function capture(value: unknown): unknown { return value; }",
			"packages/tracer/src/index.ts": `
				import { encode } from "@msgpack/msgpack";
				export function capture(value: unknown): Uint8Array { return encode(value); }
			`,
		};
		expect(analyze(sources).violations).toEqual([]);
	});

	it("rejects extra serialization work inside the reviewed serializeValue owner", () => {
		const sources = {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { serializedValuesEqual } from "@ts-drp/utils/serialization";',
				"serializedValuesEqual(state, state.changed);"
			),
			[UTILS_SERIALIZATION_PATH]: `
				import { encode } from "@msgpack/msgpack";
				const extensionCodec = {};
				export function serializeValue(value: unknown): Uint8Array {
					encode(value, { extensionCodec });
					return encode(value, { extensionCodec });
				}
				export function serializedValuesEqual(left: unknown, right: unknown): boolean {
					return serializeValue(left).byteLength === serializeValue(right).byteLength;
				}
			`,
		};
		expect(analyze(sources).violations).toEqual(
			expect.arrayContaining([expect.stringMatching(/serialization|encode|extra|reviewed/)])
		);
	});

	it("pins the exact normalized eleven-site residual clone census in workspace mode", () => {
		expect(analyze(realGovernedWorkspaceSources()).residualCloneSites).toEqual([...RESIDUAL_CLONE_SITES].sort());
	});

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
