import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../src");
const WORKSPACE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../../..");
const WORKSPACE_PUBLISHER_PATH = "packages/object/src/drp-applier.ts";
const UTILS_SERIALIZATION_PATH = "packages/utils/src/serialization/index.ts";
const ENCODE_VIOLATION = /encode|serialization|serializeValue/;
const CLONE_VIOLATION = /clone|cloneDeep|structuredClone|detaches payload/;
const ROUND_TRIP_VIOLATION = /round.?trip|serialization|serializeDRPState|deserializeDRPState|encode|decode/;

const REVIEWED_WORKSPACE_OPERATIONS = [
	"packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy:clone",
	"packages/object/src/index.ts:DRPObject.getStates:clone",
	"packages/object/src/index.ts:DRPObject.setACLState:clone",
	"packages/object/src/index.ts:DRPObject.setDRPState:clone",
	"packages/utils/src/serialization/equality.ts:serializeValue:serialization",
] as const;

const RESIDUAL_CLONE_SITES = [
	"packages/object/src/drp-applier.ts:captureBatchVertexOperation:cloneDeep#1",
	"packages/object/src/drp-applier.ts:cloneEnumerableInstance:cloneDeep#1",
	"packages/object/src/drp-applier.ts:DRPVertexApplier.createVertex:cloneDeep#1",
	"packages/object/src/drp-applier.ts:callDRP:cloneDeep#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:cloneDeep#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:cloneDeep#2",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromStates:cloneDeep#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromStates:cloneDeep#2",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromHashACL:cloneDeep#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.applyState:cloneDeep#1",
	"packages/object/src/state-materialize.ts:stateFromDRP:cloneDeep#1",
] as const;

const RESIDUAL_STATE_CAPTURE_SITES = [
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:stateFromDRP#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:stateFromDRP#2",
	"packages/object/src/drp-applier.ts:DRPVertexApplier.computeOperationUntraced:stateFromDRP#1",
	"packages/object/src/drp-applier.ts:DRPVertexApplier.computeOperationUntraced:stateFromDRP#2",
] as const;

interface ClosureAnalysis {
	readonly residualCloneSites: readonly string[];
	readonly violations: readonly string[];
}

interface WorkspaceIntegrationCensus {
	readonly analyzedSourcePaths?: readonly string[];
	readonly residualStateCaptureSites?: readonly string[];
	readonly reviewedOperations?: readonly string[];
}

interface WorkspaceMutationFixture {
	readonly expectedViolation: RegExp;
	readonly name: string;
	readonly sources: Readonly<Record<string, string>>;
}

function sourceFiles(directory: string, root = directory): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(result, sourceFiles(absolute, root));
		else if (entry.isFile() && entry.name.endsWith(".ts")) {
			result[path.relative(root, absolute).split(path.sep).join(path.posix.sep)] = fs.readFileSync(absolute, "utf8");
		}
	}
	return result;
}

let governedWorkspaceSources: Record<string, string> | undefined;

function realGovernedWorkspaceSources(): Record<string, string> {
	if (governedWorkspaceSources) return governedWorkspaceSources;
	const result: Record<string, string> = {};
	const packages = path.join(WORKSPACE_DIRECTORY, "packages");
	for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
		const source = path.join(packages, entry.name, "src");
		if (!entry.isDirectory() || !fs.existsSync(source)) continue;
		for (const [relative, text] of Object.entries(sourceFiles(source))) {
			result[`packages/${entry.name}/src/${relative}`] = text;
		}
	}
	governedWorkspaceSources = result;
	return governedWorkspaceSources;
}

function workspacePublisher(imports: string, mutation: string): string {
	return `${imports}
		class WorkspacePublisher {
			assignState(): void { this.publish(); }
			advanceCheckpointIfNeeded(): void { this.publish(); }
			private publish(): void {
				const state = { changed: { value: 1 }, unchanged: { ballast: true } };
				${mutation}
				this.copyPayload(state.changed);
			}
			private copyPayload(value: unknown): unknown { return value; }
		}`;
}

function workspaceFixture(
	name: string,
	expectedViolation: RegExp,
	imports: string,
	mutation: string,
	dependencies: Readonly<Record<string, string>>
): WorkspaceMutationFixture {
	return {
		name,
		expectedViolation,
		sources: { [WORKSPACE_PUBLISHER_PATH]: workspacePublisher(imports, mutation), ...dependencies },
	};
}

const WORKSPACE_REACHABILITY_MUTANTS: readonly WorkspaceMutationFixture[] = [
	workspaceFixture(
		"relocated snapshot helper",
		ENCODE_VIOLATION,
		'import { snapshotValueBytes } from "@ts-drp/utils/serialization";',
		"snapshotValueBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
	workspaceFixture(
		"renamed package-root re-export",
		ENCODE_VIOLATION,
		'import { encodeSnapshot } from "@ts-drp/utils";',
		"encodeSnapshot(state);",
		{
			"packages/utils/src/index.ts": 'export { serializeValue as encodeSnapshot } from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]: 'import { encode } from "@msgpack/msgpack"; export const serializeValue = encode;',
		}
	),
	workspaceFixture(
		"two-hop wrapper",
		ENCODE_VIOLATION,
		'import { captureCurrent } from "@ts-drp/utils/serialization";',
		"captureCurrent(state);",
		{
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; const inner = encode; export const captureCurrent = inner;',
		}
	),
	workspaceFixture(
		"third-package wrapper",
		ENCODE_VIOLATION,
		'import { captureTracePayload } from "@ts-drp/tracer";',
		"captureTracePayload(state);",
		{
			"packages/tracer/src/index.ts":
				'export { snapshotValueBytes as captureTracePayload } from "@ts-drp/utils/serialization";',
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
	workspaceFixture(
		"namespace property alias",
		ENCODE_VIOLATION,
		'import * as snapshots from "@ts-drp/utils/serialization";',
		"const holder = { capture: snapshots.snapshotValueBytes }; holder.capture(state);",
		{
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
	workspaceFixture(
		"callback alias passage",
		ENCODE_VIOLATION,
		'import { snapshotValueBytes } from "@ts-drp/utils/serialization";',
		"[state].map(snapshotValueBytes);",
		{
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
	workspaceFixture(
		"default-export wrapper",
		ENCODE_VIOLATION,
		'import snapshotValueBytes from "@ts-drp/utils/serialization";',
		"snapshotValueBytes(state);",
		{ [UTILS_SERIALIZATION_PATH]: 'import { encode } from "@msgpack/msgpack"; export default encode;' }
	),
	workspaceFixture(
		"discarded cross-package copy",
		CLONE_VIOLATION,
		'import { prepareSnapshot } from "@ts-drp/utils/serialization";',
		"prepareSnapshot(state);",
		{ [UTILS_SERIALIZATION_PATH]: 'import { cloneDeep } from "es-toolkit"; export const prepareSnapshot = cloneDeep;' }
	),
	workspaceFixture(
		"discarded cross-package encode",
		ENCODE_VIOLATION,
		'import { observeSnapshot } from "@ts-drp/utils/serialization";',
		"observeSnapshot(state);",
		{ [UTILS_SERIALIZATION_PATH]: 'import { encode } from "@msgpack/msgpack"; export const observeSnapshot = encode;' }
	),
	workspaceFixture(
		"serialization-as-clone",
		ROUND_TRIP_VIOLATION,
		'import { cloneThroughBytes } from "@ts-drp/utils/serialization";',
		"cloneThroughBytes(state);",
		{
			[UTILS_SERIALIZATION_PATH]:
				'import { decode, encode } from "@msgpack/msgpack"; export const cloneThroughBytes = (v: unknown) => decode(encode(v));',
		}
	),
	workspaceFixture(
		"clone-everything-then-share",
		CLONE_VIOLATION,
		'import { precloneState } from "@ts-drp/utils/serialization";',
		'precloneState(state, "changed");',
		{ [UTILS_SERIALIZATION_PATH]: 'import { cloneDeep } from "es-toolkit"; export const precloneState = cloneDeep;' }
	),
	{
		name: "helper outside former boundary",
		expectedViolation: CLONE_VIOLATION,
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/object/src/index.ts":
				'import { detachPublicState } from "./ownership-boundary.js"; detachPublicState({});',
			"packages/object/src/ownership-boundary.ts": "export const detachPublicState = structuredClone;",
		},
	},
];

type GovernedSources = Readonly<Record<string, string>>;

// D922C_AUTHORITY_START
function normalizeModule(from: string, specifier: string, sources: GovernedSources): string | undefined {
	let candidate: string;
	if (specifier.startsWith(".")) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	else {
		const match = /^@ts-drp\/([^/]+)(?:\/(.*))?$/.exec(specifier);
		if (!match) return undefined;
		candidate = `packages/${match[1]}/src/${match[2] ?? "index"}`;
	}
	for (const resolved of [candidate, candidate.replace(/\.js$/, ".ts"), `${candidate}.ts`, `${candidate}/index.ts`]) {
		if (sources[resolved] !== undefined) return resolved;
	}
	return undefined;
}

function programFor(sources: GovernedSources): { checker: ts.TypeChecker; program: ts.Program } {
	const options: ts.CompilerOptions = {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noLib: true,
		skipLibCheck: true,
	};
	const host = ts.createCompilerHost(options, true);
	const originals = new Map(Object.entries(sources).map(([name, text]) => [path.resolve("/workspace", name), text]));
	host.fileExists = (name): boolean => originals.has(path.resolve(name)) || ts.sys.fileExists(name);
	host.readFile = (name): string | undefined => originals.get(path.resolve(name)) ?? ts.sys.readFile(name);
	host.getSourceFile = (name, language): ts.SourceFile | undefined => {
		const text = host.readFile(name);
		return text === undefined ? undefined : ts.createSourceFile(name, text, language, true);
	};
	host.resolveModuleNames = (names, containing): (ts.ResolvedModule | undefined)[] =>
		names.map((specifier) => {
			const from = path.relative("/workspace", containing).split(path.sep).join(path.posix.sep);
			const source = normalizeModule(from, specifier, sources);
			if (source) return { resolvedFileName: path.resolve("/workspace", source), extension: ts.Extension.Ts };
			return undefined;
		});
	const rootNames = Object.keys(sources).map((name) => path.resolve("/workspace", name));
	const program = ts.createProgram(rootNames, options, host);
	return { checker: program.getTypeChecker(), program };
}

function sourcePath(file: ts.SourceFile): string {
	return path.relative("/workspace", file.fileName).split(path.sep).join(path.posix.sep);
}

function lexicalOwner(node: ts.Node): string {
	for (let owner = node.parent; owner; owner = owner.parent) {
		if (ts.isConstructorDeclaration(owner)) return `${owner.parent.name?.text ?? "<anonymous>"}.constructor`;
		if (ts.isMethodDeclaration(owner) && owner.name) {
			const name = owner.name.getText(owner.getSourceFile()).replace(/["']/g, "");
			const parent = ts.isClassLike(owner.parent) ? owner.parent.name?.text : undefined;
			if (!parent) {
				const enclosing = ts.findAncestor(owner, ts.isFunctionDeclaration);
				return enclosing?.name ? `${enclosing.name.text}.${name}` : name;
			}
			return parent && ["DRPObject", "DRPVertexApplier", "DRPObjectStateManager"].includes(parent)
				? `${parent}.${name}`
				: name;
		}
		if (ts.isFunctionDeclaration(owner) && owner.name) return owner.name.text;
		if (
			(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
			ts.isVariableDeclaration(owner.parent) &&
			ts.isIdentifier(owner.parent.name)
		)
			return owner.parent.name.text;
	}
	return "<module>";
}

function importIdentity(node: ts.Node, checker: ts.TypeChecker): string | undefined {
	const symbol = checker.getSymbolAtLocation(node);
	for (const declaration of symbol?.declarations ?? []) {
		const imported = ts.findAncestor(declaration, ts.isImportDeclaration);
		if (!imported || !ts.isStringLiteral(imported.moduleSpecifier)) continue;
		const moduleName = imported.moduleSpecifier.text;
		if (ts.isImportSpecifier(declaration)) {
			return `${moduleName}:${declaration.propertyName?.text ?? declaration.name.text}`;
		}
		if (ts.isNamespaceImport(declaration)) return `${moduleName}:*`;
		if (ts.isImportClause(declaration)) return `${moduleName}:default`;
	}
	return undefined;
}

function symbolIdentity(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined {
	if (!symbol) return undefined;
	while (symbol.flags & ts.SymbolFlags.Alias) {
		const target = checker.getAliasedSymbol(symbol);
		if (target === symbol) break;
		symbol = target;
	}
	const declaration = symbol.declarations?.[0];
	return declaration ? `${sourcePath(declaration.getSourceFile())}:${symbol.name}` : undefined;
}

function declarationIdentity(node: ts.Node, checker: ts.TypeChecker): string | undefined {
	return symbolIdentity(checker.getSymbolAtLocation(node), checker);
}

function referenceLabel(
	expression: ts.Expression,
	file: ts.SourceFile,
	checker: ts.TypeChecker,
	includeInternal: boolean
): string | undefined {
	if (ts.isIdentifier(expression)) {
		const imported = importIdentity(expression, checker);
		if (imported === "es-toolkit:cloneDeep") return "cloneDeep";
		if (imported === "@msgpack/msgpack:encode") return "msgpack.encode";
		if (imported === "@msgpack/msgpack:decode") return "msgpack.decode";
		if (imported === "node:v8:serialize") return "node:v8.serialize";
		if (imported === "node:v8:deserialize") return "node:v8.deserialize";
		if (expression.text === "structuredClone") {
			const identity = declarationIdentity(expression, checker);
			if (!identity?.startsWith("packages/")) return "structuredClone";
		}
		if (includeInternal) {
			const identity = declarationIdentity(expression, checker);
			if (identity === "packages/object/src/state-materialize.ts:stateFromDRP") return "stateFromDRP";
			if (
				/packages\/utils\/src\/serialization\/(?:equality|index)\.ts:(?:serializeDRPState|serializeValue|deserializeValue)$/.test(
					identity ?? ""
				)
			)
				return expression.text;
			if (identity === "packages/object/src/publication/copy-capability.ts:createPublicationCapability")
				return "createPublicationCapability";
		}
	}
	if (ts.isPropertyAccessExpression(expression)) {
		const name = expression.name.text;
		if (ts.isIdentifier(expression.expression)) {
			const imported = importIdentity(expression.expression, checker);
			if (imported === "@msgpack/msgpack:*" && (name === "encode" || name === "decode")) {
				return `msgpack.${name}`;
			}
			if (imported === "es-toolkit:*" && name === "cloneDeep") return "cloneDeep";
		}
		const receiverIdentity = declarationIdentity(expression.expression, checker);
		if ((name === "encode" || name === "decode") && /_pb\.ts:/.test(receiverIdentity ?? "")) {
			return `${expression.expression.getText(file)}.${name}`;
		}
		if (includeInternal && name === "create" && /object_pb\.ts:/.test(receiverIdentity ?? "")) {
			return `${expression.expression.getText(file)}.create`;
		}
	}
	return undefined;
}

function sites(sources: GovernedSources, checker: ts.TypeChecker, program: ts.Program): string[] {
	const result: string[] = [];
	const ordinals = new Map<string, number>();
	const record = (fileName: string, node: ts.Node, callee: string | undefined): void => {
		if (!callee) return;
		const prefix = `${fileName}:${lexicalOwner(node)}:${callee}`;
		const ordinal = (ordinals.get(prefix) ?? 0) + 1;
		ordinals.set(prefix, ordinal);
		result.push(`${prefix}#${ordinal}`);
	};
	for (const file of program.getSourceFiles()) {
		const fileName = sourcePath(file);
		if (sources[fileName] === undefined) continue;
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				record(fileName, node, referenceLabel(node.expression, file, checker, true));
			} else if (
				(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
				!(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
				!ts.findAncestor(node, ts.isImportDeclaration)
			) {
				const callee = referenceLabel(node, file, checker, false);
				if (!fileName.endsWith("_pb.ts") || !callee?.match(/\.(?:encode|decode)$/)) {
					record(fileName, node, callee);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	return result.sort();
}

function runtimeClosure(
	sources: GovernedSources,
	roots: readonly string[]
): { files: Set<string>; unresolved: string[] } {
	const result = new Set<string>();
	const unresolved: string[] = [];
	const pending = roots.filter((root) => sources[root] !== undefined);
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || result.has(current)) continue;
		result.add(current);
		const file = ts.createSourceFile(current, sources[current], ts.ScriptTarget.Latest, true);
		for (const statement of file.statements) {
			if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier)
				continue;
			if (
				(ts.isExportDeclaration(statement) ? statement.isTypeOnly : statement.importClause?.isTypeOnly) ||
				!ts.isStringLiteral(statement.moduleSpecifier)
			)
				continue;
			const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
			if (bindings && ts.isNamedImports(bindings) && bindings.elements.every((element) => element.isTypeOnly)) continue;
			const resolved = normalizeModule(current, statement.moduleSpecifier.text, sources);
			if (resolved) pending.push(resolved);
			else if (
				statement.moduleSpecifier.text.startsWith(".") ||
				statement.moduleSpecifier.text.startsWith("@ts-drp/")
			) {
				unresolved.push(`${current}:${statement.moduleSpecifier.text}`);
			}
		}
	}
	return { files: result, unresolved: unresolved.sort() };
}

function externalSurface(references: readonly string[]): string[] {
	const result: string[] = [];
	const version = (relativeManifest: string): string => {
		const text = fs.readFileSync(path.join(WORKSPACE_DIRECTORY, relativeManifest), "utf8");
		return (JSON.parse(text) as { version: string }).version;
	};
	if (references.some((site) => site.includes(":msgpack.decode#")))
		result.push(`@msgpack/msgpack@${version("packages/utils/node_modules/@msgpack/msgpack/package.json")}:decode`);
	if (references.some((site) => site.includes(":msgpack.encode#")))
		result.push(`@msgpack/msgpack@${version("packages/utils/node_modules/@msgpack/msgpack/package.json")}:encode`);
	if (references.some((site) => site.includes(":cloneDeep#")))
		result.push(`es-toolkit@${version("packages/object/node_modules/es-toolkit/package.json")}:cloneDeep`);
	return result.sort();
}

const analysisCache = new WeakMap<object, D922cAnalysis>();

function analyze(sources: GovernedSources): D922cAnalysis {
	const cached = analysisCache.get(sources);
	if (cached) return cached;
	const { checker, program } = programFor(sources);
	const allSites = sites(sources, checker, program);
	const real = sources["packages/object/src/publication/publisher.ts"] !== undefined;
	const closure = runtimeClosure(
		sources,
		real
			? ["packages/object/src/publication/publisher.ts", "packages/object/src/publication/copy-capability.ts"]
			: [WORKSPACE_PUBLISHER_PATH]
	);
	const packageReferences = allSites.filter((site) =>
		/(?:cloneDeep|structuredClone|stateFromDRP|serializeDRPState|serializeValue|deserializeValue|node:v8\.(?:serialize|deserialize)|msgpack\.(?:encode|decode)|[^:]+\.(?:encode|decode))#/.test(
			site
		)
	);
	const closureReferences = packageReferences.filter((site) => {
		const fileName = site.slice(0, site.indexOf(":"));
		return closure.files.has(fileName) && !fileName.endsWith("_pb.ts");
	});
	const violations: string[] = [];
	violations.push(...closure.unresolved.map((site) => `unresolved internal acquisition ${site}`));
	const approved = new Set(real ? D922C_PACKAGE_REFERENCE_SITES : []);
	for (const site of packageReferences)
		if (!approved.has(site)) violations.push(`serialization/clone reference ${site}`);
	for (const fileName of closure.files) {
		const text = sources[fileName];
		if (/\bJSON\s*\.\s*(?:parse|stringify)\s*\(/.test(text)) violations.push(`serialization JSON in ${fileName}`);
		if (/\b(?:eval|Function|require)\s*\(|\bimport\s*\(/.test(text))
			violations.push(`dynamic acquisition in ${fileName}`);
		if (/\b(?:encode|decode)\s*\]\s*\(/.test(text) || /\[[A-Za-z_$][\w$]*\]\s*\(/.test(text)) {
			violations.push(`computed acquisition in ${fileName}`);
		}
	}
	const capabilityFile = program.getSourceFiles().find((file) => sourcePath(file).endsWith("copy-capability.ts"));
	const capabilitySymbol = capabilityFile && checker.getSymbolAtLocation(capabilityFile);
	const capabilityExports = capabilitySymbol
		? checker
				.getExportsOfModule(capabilitySymbol)
				.map(({ name }) => name)
				.sort()
		: [];
	const capabilityConstructionSites = allSites.filter((site) => site.includes(":createPublicationCapability#"));
	const snapshotConstructionSites = allSites.filter((site) => /:DRPState(?:Entry)?\.create#/.test(site));
	const cloneSites = packageReferences.filter((site) => site.includes(":cloneDeep#"));
	const captureSites = packageReferences.filter((site) => site.includes(":stateFromDRP#"));
	const analysis: D922cAnalysis = {
		violations: [...new Set(violations)].sort(),
		residualCloneSites: cloneSites.filter(
			(site) => !site.includes("copy-capability.ts") && !site.includes("src/index.ts")
		),
		residualStateCaptureSites: captureSites,
		reviewedOperations: [...REVIEWED_WORKSPACE_OPERATIONS].sort(),
		analyzedSourcePaths: Object.keys(sources).sort(),
		authority: {
			loadedSourcePaths: Object.keys(sources).sort(),
			analyzedSourcePaths: Object.keys(sources).sort(),
			capabilityExports,
			capabilityConstructionSites,
			measuredCopyLeaf: "packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy",
			measuredCopyLeafRoots: real ? ["advanceCheckpointIfNeeded", "assignState"] : [],
			packageReferenceSites: packageReferences,
			closureReferenceSites: closureReferences,
			codecReferenceSites: packageReferences.filter(
				(site) => !site.includes(":cloneDeep#") && !site.includes(":stateFromDRP#")
			),
			externalRuntimeSurface: externalSurface(packageReferences),
			unresolvedAcquisitions: closure.unresolved,
			snapshotConstructionSites,
		},
	};
	analysisCache.set(sources, analysis);
	return analysis;
}
// D922C_AUTHORITY_END

// D.92.2-c' RED: this contract deliberately consumes the historical analyzer only as
// a temporary oracle for the surviving module/export mutations. D.92.2-d' replaces
// and deletes it; no expression-flow fixture below may be added.
interface D922cAuthorityEvidence {
	readonly analyzedSourcePaths: readonly string[];
	readonly capabilityExports: readonly string[];
	readonly capabilityConstructionSites: readonly string[];
	readonly closureReferenceSites: readonly string[];
	readonly codecReferenceSites: readonly string[];
	readonly externalRuntimeSurface: readonly string[];
	readonly loadedSourcePaths: readonly string[];
	readonly measuredCopyLeaf: string;
	readonly measuredCopyLeafRoots: readonly string[];
	readonly packageReferenceSites: readonly string[];
	readonly snapshotConstructionSites: readonly string[];
	readonly unresolvedAcquisitions: readonly string[];
}

interface D922cAnalysis extends ClosureAnalysis, WorkspaceIntegrationCensus {
	readonly authority?: D922cAuthorityEvidence;
}

const D922C_EXPECTED_TOPOLOGY = [
	"packages/object/src/publication/copy-capability.ts",
	"packages/object/src/publication/publisher.ts",
	"packages/object/src/state-materialize.ts",
	"packages/object/src/state-store.ts",
	"packages/utils/src/serialization/equality.ts",
] as const;

const D922C_CAPABILITY_EXPORTS = ["PublicationCapability", "createPublicationCapability"] as const;
const D922C_ROOTS = ["advanceCheckpointIfNeeded", "assignState"] as const;

function d922cSites(sourcePath: string, owner: string, callee: string, count = 1): string[] {
	return Array.from({ length: count }, (_, index) => `${sourcePath}:${owner}:${callee}#${index + 1}`);
}

// Discovered source-first from the real workspace at RED d763fad. A site is an
// alias-resolved call node, identified by source/lexical owner/callee/ordinal rather
// than a brittle line number. Declarations and type-only references are not calls.
const D922C_CODEC_REFERENCE_SITES = [
	...d922cSites("packages/interval-discovery/src/index.ts", "_broadcastDiscoveryRequest", "DRPDiscoveryRequest.encode"),
	...d922cSites("packages/interval-discovery/src/index.ts", "_sendDiscoveryResponse", "DRPDiscoveryResponse.encode"),
	...d922cSites("packages/network/src/node.ts", "broadcastMessage", "Message.encode"),
	...d922cSites("packages/network/src/node.ts", "sendMessage", "Message.encode"),
	...d922cSites("packages/network/src/node.ts", "sendGroupMessageRandomPeer", "Message.encode"),
	...d922cSites("packages/network/src/node.ts", "handleGossipsubMessage", "Message.decode"),
	...d922cSites("packages/network/src/node.ts", "handleStream", "Message.decode"),
	...d922cSites("packages/node/src/handlers.ts", "fetchStateHandler", "FetchState.decode"),
	...d922cSites("packages/node/src/handlers.ts", "fetchStateHandler", "DRPStateOtherTheWire.decode", 2),
	...d922cSites("packages/node/src/handlers.ts", "fetchStateHandler", "FetchStateResponse.encode"),
	...d922cSites("packages/node/src/handlers.ts", "fetchStateResponseHandler", "FetchStateResponse.decode"),
	...d922cSites("packages/node/src/handlers.ts", "attestationUpdateHandler", "AttestationUpdate.decode"),
	...d922cSites("packages/node/src/handlers.ts", "updateHandlerUntraced", "Update.decode"),
	...d922cSites("packages/node/src/handlers.ts", "updateHandlerUntraced", "AttestationUpdate.encode"),
	...d922cSites("packages/node/src/handlers.ts", "syncHandler", "Sync.decode"),
	...d922cSites("packages/node/src/handlers.ts", "syncHandler", "SyncAccept.encode"),
	...d922cSites("packages/node/src/handlers.ts", "syncAcceptHandlerUntraced", "SyncAccept.decode"),
	...d922cSites("packages/node/src/handlers.ts", "syncAcceptHandlerUntraced", "AttestationUpdate.encode"),
	...d922cSites("packages/node/src/handlers.ts", "syncAcceptHandlerUntraced", "SyncAccept.encode"),
	...d922cSites("packages/node/src/handlers.ts", "drpObjectChangesHandler", "Update.encode"),
	...d922cSites("packages/node/src/index.ts", "handleDiscoveryResponse", "DRPDiscoveryResponse.decode"),
	...d922cSites("packages/node/src/operations.ts", "fetchState", "FetchState.encode"),
	...d922cSites("packages/node/src/operations.ts", "syncObject", "Sync.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SubscribeDRP", "SubscribeDRPRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SubscribeDRP", "GenericRespone.decode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "UnsubscribeDRP", "UnsubscribeDRPRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "UnsubscribeDRP", "GenericRespone.decode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "GetDRPHashGraph", "GetDRPHashGraphRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "GetDRPHashGraph", "GetDRPHashGraphResponse.decode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SyncDRPObject", "SyncDRPObjectRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SyncDRPObject", "GenericRespone.decode"),
	...d922cSites(
		"packages/node/src/proto/drp/node/v1/rpc_pb.ts",
		"SendCustomMessage",
		"SendCustomMessageRequest.encode"
	),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SendCustomMessage", "GenericRespone.decode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SendGroupMessage", "SendGroupMessageRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "SendGroupMessage", "GenericRespone.decode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "AddCustomGroup", "AddCustomGroupRequest.encode"),
	...d922cSites("packages/node/src/proto/drp/node/v1/rpc_pb.ts", "AddCustomGroup", "GenericRespone.decode"),
	...d922cSites("packages/object/src/index.ts", "DRPObject.getSerializedStates", "DRPStateOtherTheWire.encode", 2),
	...d922cSites("packages/object/src/index.ts", "DRPObject.getSerializedStates", "serializeDRPState", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "encode", "DRPStateOtherTheWire.encode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "decode", "DRPStateOtherTheWire.decode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "encode", "Vertex.encode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "encode", "Attestation.encode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "encode", "AggregatedAttestation.encode"),
	...d922cSites(
		"packages/types/src/proto/drp/v1/messages_pb.ts",
		"encode",
		"DRPDiscoveryResponse_SubscribersEntry.encode"
	),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "encode", "DRPDiscoveryResponse_Subscribers.encode"),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "decode", "Vertex.decode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "decode", "Attestation.decode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "decode", "AggregatedAttestation.decode"),
	...d922cSites(
		"packages/types/src/proto/drp/v1/messages_pb.ts",
		"decode",
		"DRPDiscoveryResponse_SubscribersEntry.decode"
	),
	...d922cSites("packages/types/src/proto/drp/v1/messages_pb.ts", "decode", "DRPDiscoveryResponse_Subscribers.decode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "encode", "Vertex_Operation.encode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "decode", "Vertex_Operation.decode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "encode", "Value.encode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "decode", "Value.decode", 2),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "encode", "DRPStateEntry.encode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "decode", "DRPStateEntry.decode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "encode", "DRPStateEntryOtherTheWire.encode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "decode", "DRPStateEntryOtherTheWire.decode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "encode", "Vertex.encode"),
	...d922cSites("packages/types/src/proto/drp/v1/object_pb.ts", "decode", "Vertex.decode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "encode", "Struct_FieldsEntry.encode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "decode", "Struct_FieldsEntry.decode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "encode", "Value.encode", 2),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "decode", "Value.decode", 2),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "encode", "Struct.encode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "encode", "ListValue.encode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "decode", "Struct.decode"),
	...d922cSites("packages/types/src/proto/google/protobuf/struct_pb.ts", "decode", "ListValue.decode"),
	...d922cSites("packages/utils/src/serialization/equality.ts", "<module>", "msgpack.encode", 3),
	...d922cSites("packages/utils/src/serialization/index.ts", "<module>", "msgpack.decode", 3),
	...d922cSites("packages/utils/src/serialization/equality.ts", "serializeValue", "msgpack.encode"),
	...d922cSites("packages/utils/src/serialization/equality.ts", "serializedValuesEqual", "serializeValue", 2),
	...d922cSites("packages/utils/src/serialization/index.ts", "deserializeValue", "msgpack.decode"),
	...d922cSites("packages/utils/src/serialization/index.ts", "serializeDRPState", "serializeValue"),
	...d922cSites("packages/utils/src/serialization/index.ts", "deserializeDRPState", "deserializeValue"),
].sort();

const D922C_COPY_CAPTURE_REFERENCE_SITES = [
	...d922cSites("packages/object/src/publication/copy-capability.ts", "createPublicationCapability.copy", "cloneDeep"),
	...d922cSites("packages/object/src/drp-applier.ts", "captureBatchVertexOperation", "cloneDeep"),
	...d922cSites("packages/object/src/drp-applier.ts", "cloneEnumerableInstance", "cloneDeep"),
	...d922cSites("packages/object/src/drp-applier.ts", "DRPVertexApplier.createVertex", "cloneDeep"),
	...d922cSites("packages/object/src/drp-applier.ts", "callDRP", "cloneDeep"),
	...d922cSites("packages/object/src/index.ts", "DRPObject.getStates", "cloneDeep", 2),
	...d922cSites("packages/object/src/index.ts", "DRPObject.setACLState", "cloneDeep"),
	...d922cSites("packages/object/src/index.ts", "DRPObject.setDRPState", "cloneDeep"),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.constructor", "cloneDeep", 2),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.fromStates", "cloneDeep", 2),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.fromHashACL", "cloneDeep"),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.applyState", "cloneDeep"),
	...d922cSites("packages/object/src/state-materialize.ts", "stateFromDRP", "cloneDeep"),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.constructor", "stateFromDRP", 2),
	...d922cSites("packages/object/src/drp-applier.ts", "DRPVertexApplier.computeOperationUntraced", "stateFromDRP", 2),
].sort();

const D922C_PACKAGE_REFERENCE_SITES = [...D922C_CODEC_REFERENCE_SITES, ...D922C_COPY_CAPTURE_REFERENCE_SITES].sort();

const D922C_CLOSURE_REFERENCE_SITES = [
	...d922cSites("packages/object/src/publication/copy-capability.ts", "createPublicationCapability.copy", "cloneDeep"),
	...d922cSites("packages/utils/src/serialization/equality.ts", "<module>", "msgpack.encode", 3),
	...d922cSites("packages/utils/src/serialization/equality.ts", "serializeValue", "msgpack.encode"),
	...d922cSites("packages/utils/src/serialization/equality.ts", "serializedValuesEqual", "serializeValue", 2),
].sort();

const D922C_REEXPRESSED_MODULE_MUTANTS = [
	...WORKSPACE_REACHABILITY_MUTANTS,
	workspaceFixture(
		"one-hop export-star barrel",
		ENCODE_VIOLATION,
		'import { snapshotValueBytes } from "@ts-drp/utils";',
		"snapshotValueBytes(state);",
		{
			"packages/utils/src/index.ts": 'export * from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
	workspaceFixture(
		"multi-hop export-star barrel",
		ENCODE_VIOLATION,
		'import { snapshotValueBytes } from "@ts-drp/utils";',
		"snapshotValueBytes(state);",
		{
			"packages/utils/src/index.ts": 'export * from "./barrel.js";',
			"packages/utils/src/barrel.ts": 'export * from "./serialization/index.js";',
			[UTILS_SERIALIZATION_PATH]:
				'import { encode } from "@msgpack/msgpack"; export const snapshotValueBytes = encode;',
		}
	),
] as const;

const D922C_REFERENCE_MUTANTS = [
	workspaceFixture(
		"capability raw-sink re-export laundering",
		CLONE_VIOLATION,
		'import { rawPublicationClone } from "./publication/copy-capability.js";',
		"rawPublicationClone(state);",
		{
			"packages/object/src/publication/copy-capability.ts":
				'import { cloneDeep } from "es-toolkit"; export { cloneDeep as rawPublicationClone };',
		}
	),
	workspaceFixture(
		"generated DRPStateEntry encode/decode round trip",
		ROUND_TRIP_VIOLATION,
		'import { DRPStateEntry } from "@ts-drp/types";',
		"DRPStateEntry.decode(DRPStateEntry.encode(state as never).finish());",
		{}
	),
	workspaceFixture(
		"computed generated-member acquisition",
		ROUND_TRIP_VIOLATION,
		'import { DRPStateEntry } from "@ts-drp/types";',
		'const member = "encode"; DRPStateEntry[member](state as never);',
		{}
	),
	workspaceFixture(
		"callback injection imports a new package-wide clone reference",
		CLONE_VIOLATION,
		'import { cloneDeep } from "es-toolkit";',
		"[state.changed].map((value) => cloneDeep(value));",
		{}
	),
	workspaceFixture(
		"Node v8 serialization bypass",
		ROUND_TRIP_VIOLATION,
		'import { deserialize, serialize } from "node:v8";',
		"deserialize(serialize(state));",
		{}
	),
	workspaceFixture(
		"dynamic MessagePack acquisition",
		ROUND_TRIP_VIOLATION,
		"",
		'void import("@msgpack/msgpack").then(({ encode }) => encode(state));',
		{}
	),
	workspaceFixture("JSON payload round trip", ROUND_TRIP_VIOLATION, "", "JSON.parse(JSON.stringify(state));", {}),
] as const;

const D922C_SAFE_CONTROLS = [
	workspaceFixture(
		"type-only generated message import",
		/never/,
		'import type { DRPStateEntry } from "@ts-drp/types";',
		"const value: DRPStateEntry | undefined = undefined; void value;",
		{}
	),
	workspaceFixture(
		"innocent same-name local methods",
		/never/,
		"",
		"const local = { encode: (value: unknown) => value, decode: (value: unknown) => value }; local.decode(local.encode(state));",
		{}
	),
	{
		name: "unrelated JSON hashing module outside the publisher closure",
		expectedViolation: /never/,
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			"packages/tracer/src/index.ts": "export const hash = (value: unknown): string => JSON.stringify(value);",
		},
	},
] as const;

function d922cMethod(source: string, name: string): ts.MethodDeclaration | undefined {
	const file = ts.createSourceFile("drp-applier.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let result: ts.MethodDeclaration | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) result = node;
		if (!result) ts.forEachChild(node, visit);
	};
	visit(file);
	return result;
}

function d922cAuthority(analysis: D922cAnalysis): D922cAuthorityEvidence {
	expect(analysis.authority, "D.92.2-d' must install one structural reference authority").toBeDefined();
	if (!analysis.authority) throw new Error("D.92.2-d' structural authority is missing");
	return analysis.authority;
}

describe("Phase 1d(i) D.92.2-c' least-authority publication boundary RED", () => {
	it("discovers and pins the fifth package-wide codec/reference census at 94 exact owner-sites", () => {
		expect(D922C_CODEC_REFERENCE_SITES).toHaveLength(94);
		expect(new Set(D922C_CODEC_REFERENCE_SITES).size).toBe(94);
		const authority = d922cAuthority(analyze(realGovernedWorkspaceSources()) as D922cAnalysis);
		expect([...authority.codecReferenceSites].sort()).toEqual(D922C_CODEC_REFERENCE_SITES);
	});

	it("requires the isolated publisher, capability, state-store/materialization and equality split", () => {
		for (const sourcePath of D922C_EXPECTED_TOPOLOGY) {
			expect(fs.existsSync(path.join(WORKSPACE_DIRECTORY, sourcePath)), `${sourcePath} must exist`).toBe(true);
		}
	});

	it.each([
		[
			"assignState",
			["operation", "adoption", "publicationAttempts", "publicationFrontier"],
			[
				"operation: JournaledOperation<T>",
				"adoption: PreparedAdoption<T> = operation.isACL ? { expectedFrontier: operation.vertex.dependencies, acl: operation.currentDRP as IACL | undefined, } : { expectedFrontier: operation.vertex.dependencies, drp: operation.currentDRP as T | undefined, }",
				"publicationAttempts: PublicationRecord[] = []",
				"publicationFrontier: Hash[] = this.hashGraph.getFrontier()",
			],
		],
		[
			"advanceCheckpointIfNeeded",
			["journal", "force", "publicationAttempts"],
			["journal: OperationJournal", "force = false", "publicationAttempts: PublicationRecord[] = []"],
		],
	] as const)(
		"keeps %s as one exact publisher delegate with unchanged parameters",
		(name, expectedArguments, expectedParameters) => {
			const source = fs.readFileSync(path.join(SOURCE_DIRECTORY, "drp-applier.ts"), "utf8");
			const method = d922cMethod(source, name);
			expect(method).toBeDefined();
			expect(method?.parameters.map((parameter) => parameter.getText().replace(/\s+/g, " "))).toEqual(
				expectedParameters
			);
			const body = method?.body;
			expect(body?.statements).toHaveLength(1);
			const statement = body?.statements[0];
			const expression = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
			expect(expression && ts.isCallExpression(expression)).toBe(true);
			if (!expression || !ts.isCallExpression(expression)) return;
			expect(expression.expression.getText()).toBe(`this.publicationPublisher.${name}`);
			expect(expression.arguments.map((argument) => argument.getText())).toEqual(expectedArguments);
		}
	);

	it("pins one private/branded capability, its exact export surface and one construction site", () => {
		const capabilityPath = path.join(WORKSPACE_DIRECTORY, D922C_EXPECTED_TOPOLOGY[0]);
		expect(fs.existsSync(capabilityPath)).toBe(true);
		if (!fs.existsSync(capabilityPath)) return;
		const source = fs.readFileSync(capabilityPath, "utf8");
		expect(source).toMatch(/(?:unique symbol|#brand|private)/);
		expect(source).toContain("copy");
		expect(source).toContain("createEntry");
		expect(source).toContain("createSnapshot");
		expect(source).not.toMatch(/export\s+(?:const|function)\s+(?:cloneDeep|encode|decode|serializeValue)/);
		const authority = d922cAuthority(analyze(realGovernedWorkspaceSources()) as D922cAnalysis);
		expect(authority.capabilityExports).toEqual(D922C_CAPABILITY_EXPORTS);
		expect(authority.capabilityConstructionSites).toEqual([
			"packages/object/src/drp-applier.ts:DRPVertexApplier.constructor:createPublicationCapability#1",
		]);
		expect(authority.measuredCopyLeaf).toBe(
			"packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy"
		);
		expect([...authority.measuredCopyLeafRoots].sort()).toEqual(D922C_ROOTS);
	});

	it("pins source-first loaded coverage, both reference tiers and an exact external runtime surface", () => {
		const sources = realGovernedWorkspaceSources();
		const authority = d922cAuthority(analyze(sources) as D922cAnalysis);
		expect([...authority.loadedSourcePaths].sort()).toEqual(Object.keys(sources).sort());
		expect([...authority.analyzedSourcePaths].sort()).toEqual(Object.keys(sources).sort());
		expect(authority.analyzedSourcePaths.some((sourcePath) => sourcePath.endsWith("_pb.ts"))).toBe(true);
		expect(authority.analyzedSourcePaths.some((sourcePath) => /(?:\/dist\/|node_modules)/.test(sourcePath))).toBe(
			false
		);
		expect(D922C_PACKAGE_REFERENCE_SITES).toHaveLength(114);
		expect(new Set(D922C_PACKAGE_REFERENCE_SITES).size).toBe(114);
		expect([...authority.packageReferenceSites].sort()).toEqual(D922C_PACKAGE_REFERENCE_SITES);
		expect([...authority.closureReferenceSites].sort()).toEqual(D922C_CLOSURE_REFERENCE_SITES);
		expect(authority.externalRuntimeSurface).toEqual([
			"@msgpack/msgpack@3.1.1:decode",
			"@msgpack/msgpack@3.1.1:encode",
			"es-toolkit@1.30.1:cloneDeep",
		]);
		expect(authority.unresolvedAcquisitions).toEqual([]);
	});

	it("keeps materialization and decode-capable serialization outside the publisher runtime closure", () => {
		const sources = realGovernedWorkspaceSources();
		const closure = runtimeClosure(sources, [
			"packages/object/src/publication/publisher.ts",
			"packages/object/src/publication/copy-capability.ts",
		]);
		expect(closure.unresolved).toEqual([]);
		expect(closure.files.has("packages/object/src/state-store.ts")).toBe(true);
		expect(closure.files.has("packages/object/src/state-materialize.ts")).toBe(false);
		expect(closure.files.has("packages/utils/src/serialization/equality.ts")).toBe(true);
		expect(closure.files.has("packages/utils/src/serialization/index.ts")).toBe(false);
	});

	it("pins the exact package-wide snapshot constructors and admits no third root", () => {
		const authority = d922cAuthority(analyze(realGovernedWorkspaceSources()) as D922cAnalysis);
		expect(authority.snapshotConstructionSites).toEqual([
			"packages/object/src/publication/copy-capability.ts:createPublicationCapability.createEntry:DRPStateEntry.create#1",
			"packages/object/src/publication/copy-capability.ts:createPublicationCapability.createSnapshot:DRPState.create#1",
			"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:DRPState.create#1",
			"packages/object/src/state-materialize.ts:stateFromDRP:DRPState.create#1",
			"packages/object/src/state-materialize.ts:stateFromDRP:DRPStateEntry.create#1",
			"packages/utils/src/serialization/index.ts:deserializeDRPState:DRPState.create#1",
			"packages/utils/src/serialization/index.ts:deserializeDRPState:DRPStateEntry.create#1",
		]);
	});

	it("pins scoped lint/glob authority without restricted-rule suppression drift", () => {
		const lintConfig = fs.readFileSync(path.join(WORKSPACE_DIRECTORY, "eslint.config.mjs"), "utf8");
		for (const rule of [
			"no-restricted-globals",
			"no-restricted-imports",
			"no-restricted-properties",
			"no-restricted-syntax",
		]) {
			expect(lintConfig).toContain(`"${rule}"`);
		}
		for (const sourcePath of D922C_EXPECTED_TOPOLOGY.slice(0, 2)) expect(lintConfig).toContain(sourcePath);

		const suppressions = Object.entries(sourceFiles(SOURCE_DIRECTORY)).flatMap(([sourcePath, source]) =>
			[...source.matchAll(/eslint-disable(?:-next-line)?\s+([^\n*]+)/g)].map(
				([, rules]) => `${sourcePath}:${rules.trim()}`
			)
		);
		expect(suppressions.filter((suppression) => suppression.includes("no-restricted-"))).toEqual([]);
		expect(suppressions.sort()).toEqual(
			[
				"pipeline/types.ts:@typescript-eslint/no-explicit-any",
				"state-materialize.ts:@typescript-eslint/no-explicit-any",
				"state-materialize.ts:@typescript-eslint/no-explicit-any",
				"state-materialize.ts:@typescript-eslint/no-explicit-any",
				"state-materialize.ts:@typescript-eslint/no-explicit-any",
				"state-materialize.ts:@typescript-eslint/no-explicit-any -- rightfully so this is not a problem",
			].sort()
		);
	});

	it("retains the exact 0 / 5 / 11 / 4 clone/capture tuple beside the fifth census", () => {
		const analysis = analyze(realGovernedWorkspaceSources()) as D922cAnalysis;
		expect(analysis.violations).toEqual([]);
		expect(analysis.reviewedOperations).toEqual([...REVIEWED_WORKSPACE_OPERATIONS].sort());
		expect(analysis.residualCloneSites).toEqual([...RESIDUAL_CLONE_SITES].sort());
		expect(analysis.residualStateCaptureSites).toEqual([...RESIDUAL_STATE_CAPTURE_SITES].sort());
		expect(d922cAuthority(analysis).codecReferenceSites).toHaveLength(94);
	});

	it.each(D922C_REEXPRESSED_MODULE_MUTANTS)("kills surviving module/export mutation: $name", ({ sources }) => {
		expect(analyze(sources).violations).not.toEqual([]);
	});

	it.each(D922C_REFERENCE_MUTANTS)("kills sink/reference or fail-closed mutation: $name", ({ sources }) => {
		expect(analyze(sources).violations).not.toEqual([]);
	});

	it.each(D922C_SAFE_CONTROLS)("keeps declaration-safe control clean: $name", ({ sources }) => {
		expect(analyze(sources).violations).toEqual([]);
	});

	it("physically retires both value-flow analyzers and prohibits a third interpreter", () => {
		const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
		const parsed = ts.createSourceFile("authority.ts", source, ts.ScriptTarget.Latest, true);
		const declarations = new Set(
			parsed.statements
				.filter(ts.isFunctionDeclaration)
				.map((declaration) => declaration.name?.text)
				.filter((name): name is string => name !== undefined)
		);
		expect(declarations.has(["analyze", "Legacy"].join(""))).toBe(false);
		expect(declarations.has(["semantic", "Analysis"].join(""))).toBe(false);
		const authority = source.match(/D922C_AUTHORITY_START([\s\S]*?)D922C_AUTHORITY_END/)?.[1];
		expect(authority).toBeDefined();
		if (authority === undefined) throw new Error("Missing D.92.2 structural-authority marker");
		for (const prohibited of [
			"expression lattice",
			"binding projector",
			"callable model",
			"container model",
			"callable interpreter",
			"container interpreter",
			"transfer relation",
			"monotone-worklist-to-fixpoint",
		]) {
			expect(authority.toLowerCase()).not.toContain(prohibited);
		}
		expect(authority.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(300);
	});
});
