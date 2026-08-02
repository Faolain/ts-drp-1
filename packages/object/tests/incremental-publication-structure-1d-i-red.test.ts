import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
	"packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy:detach",
	"packages/object/src/index.ts:DRPObject.getStates:detach",
	"packages/object/src/index.ts:DRPObject.setACLState:detach",
	"packages/object/src/index.ts:DRPObject.setDRPState:detach",
	"packages/utils/src/serialization/equality.ts:serializeValue:serialization",
] as const;

const RESIDUAL_CLONE_SITES = [
	"packages/object/src/drp-applier.ts:captureBatchVertexOperation:detachStatePayload#1",
	"packages/object/src/drp-applier.ts:cloneEnumerableInstance:detachReplicaLocalContext#1",
	"packages/object/src/drp-applier.ts:cloneEnumerableInstance:detachStatePayload#1",
	"packages/object/src/drp-applier.ts:DRPVertexApplier.createVertex:detachStatePayload#1",
	"packages/object/src/drp-applier.ts:callDRP:detachStatePayload#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:detachReplicaLocalContext#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:detachReplicaLocalContext#2",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromStates:detachReplicaLocalContext#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromStates:detachReplicaLocalContext#2",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.fromHashACL:detachReplicaLocalContext#1",
	"packages/object/src/state-materialize.ts:DRPObjectStateManager.applyState:detachStatePayload#1",
	"packages/object/src/state-materialize.ts:stateFromDRP:detachStatePayload#1",
	"packages/object/src/state-payload.ts:detachStateSnapshot:detachStatePayload#1",
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
	return [candidate, candidate.replace(/\.js$/, ".ts"), `${candidate}.ts`, `${candidate}/index.ts`].find(
		(resolved) => sources[resolved] !== undefined
	);
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
			return source ? { resolvedFileName: path.resolve("/workspace", source), extension: ts.Extension.Ts } : undefined;
		});
	const rootNames = Object.keys(sources).map((name) => path.resolve("/workspace", name));
	const program = ts.createProgram(rootNames, options, host);
	return { checker: program.getTypeChecker(), program };
}

const sourcePath = (file: ts.SourceFile): string =>
	path.relative("/workspace", file.fileName).split(path.sep).join(path.posix.sep);

const EXTERNAL_SINK_EXPORTS = [
	{
		module: "@msgpack/msgpack",
		manifest: "packages/utils/node_modules/@msgpack/msgpack/package.json",
		wildcardLabel: "msgpack.*",
		members: [
			["decode", "msgpack.decode"],
			["encode", "msgpack.encode"],
		],
	},
	{
		module: "es-toolkit",
		manifest: "packages/object/node_modules/es-toolkit/package.json",
		wildcardLabel: "toolkit.*",
		members: [["cloneDeep", "cloneDeep"]],
	},
] as const;

function externalExportSink(declaration: ts.ExportDeclaration): (typeof EXTERNAL_SINK_EXPORTS)[number] | undefined {
	const moduleSpecifier = declaration.moduleSpecifier;
	if (declaration.isTypeOnly || !moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return undefined;
	if (declaration.exportClause && !ts.isNamespaceExport(declaration.exportClause)) return undefined;
	return EXTERNAL_SINK_EXPORTS.find((sink) => sink.module === moduleSpecifier.text);
}

function lexicalOwner(node: ts.Node): string {
	for (let owner = node.parent; owner; owner = owner.parent) {
		if (ts.isConstructorDeclaration(owner)) return `${owner.parent.name?.text ?? "<anonymous>"}.constructor`;
		if (ts.isMethodDeclaration(owner) && owner.name) {
			const name = owner.name.getText(owner.getSourceFile()).replace(/["']/g, "");
			const className = ts.isClassLike(owner.parent) ? owner.parent.name?.text : undefined;
			if (className && ["DRPObject", "DRPVertexApplier", "DRPObjectStateManager"].includes(className))
				return `${className}.${name}`;
			const enclosing = ts.findAncestor(owner, ts.isFunctionDeclaration);
			return enclosing?.name ? `${enclosing.name.text}.${name}` : name;
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

function referenceSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
	return ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
		? checker.getShorthandAssignmentValueSymbol(node.parent)
		: checker.getSymbolAtLocation(node);
}

function moduleIdentity(
	symbol: ts.Symbol | undefined,
	checker: ts.TypeChecker,
	seen = new Set<ts.Symbol>()
): string | undefined {
	if (!symbol || seen.has(symbol)) return undefined;
	seen.add(symbol);
	for (const declaration of symbol.declarations ?? []) {
		const edge = ts.findAncestor(
			declaration,
			(node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
		) as ts.ImportDeclaration | ts.ExportDeclaration | undefined;
		if (!edge?.moduleSpecifier || !ts.isStringLiteral(edge.moduleSpecifier)) continue;
		if (
			ts.isExportDeclaration(edge) &&
			(edge.isTypeOnly || (ts.isExportSpecifier(declaration) && declaration.isTypeOnly))
		)
			continue;
		let name: string | undefined;
		if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration))
			name = declaration.propertyName?.text ?? declaration.name.text;
		else if (ts.isNamespaceImport(declaration)) name = "*";
		else if (ts.isImportClause(declaration)) name = "default";
		if (!name) continue;
		const moduleSymbol = checker.getSymbolAtLocation(edge.moduleSpecifier);
		const target = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((item) => item.name === name);
		return moduleIdentity(target, checker, seen) ?? `${edge.moduleSpecifier.text}:${name}`;
	}
	return undefined;
}

function canonicalSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
	return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolIdentity(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined {
	const canonical = canonicalSymbol(symbol, checker);
	const declaration = canonical?.declarations?.[0];
	return declaration ? `${sourcePath(declaration.getSourceFile())}:${canonical.name}` : undefined;
}

function knownSymbolLabel(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined {
	const canonical = canonicalSymbol(symbol, checker);
	const identity = symbolIdentity(canonical, checker);
	const known = [
		"packages/object/src/state-materialize.ts:stateFromDRP",
		"packages/object/src/state-payload.ts:detachStatePayload",
		"packages/object/src/state-payload.ts:detachStateSnapshot",
		"packages/object/src/publication/copy-capability.ts:createPublicationCapability",
		"packages/object/src/publication/copy-capability.ts:copy",
		"packages/object/src/publication/publisher.ts:assignState",
		"packages/object/src/publication/publisher.ts:advanceCheckpointIfNeeded",
		"packages/object/src/publication/publisher.ts:capturePublishedState",
		"packages/utils/src/serialization/equality.ts:serializeValue",
		"packages/utils/src/serialization/index.ts:serializeDRPState",
		"packages/utils/src/serialization/index.ts:deserializeDRPState",
		"packages/utils/src/serialization/index.ts:deserializeValue",
	];
	return known.includes(identity ?? "") ? canonical?.name : undefined;
}

function referenceLabel(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
	if (ts.findAncestor(expression.parent, ts.isTypeNode)) return undefined;
	if (ts.isIdentifier(expression)) {
		const symbol = referenceSymbol(expression, checker);
		const imported = moduleIdentity(symbol, checker);
		if (imported === "es-toolkit:cloneDeep") return "cloneDeep";
		if (imported === "@msgpack/msgpack:encode") return "msgpack.encode";
		if (imported === "@msgpack/msgpack:decode") return "msgpack.decode";
		if (imported === "node:v8:serialize") return "node:v8.serialize";
		if (imported === "node:v8:deserialize") return "node:v8.deserialize";
		if (ts.isExportSpecifier(expression.parent)) return undefined;
		if (expression.text === "structuredClone") {
			const identity = symbolIdentity(symbol, checker);
			if (!identity?.startsWith("packages/")) return "structuredClone";
		}
		return knownSymbolLabel(symbol, checker);
	}
	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
		const member = ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression;
		if (!ts.isIdentifier(member) && !ts.isStringLiteralLike(member)) return undefined;
		const name = member.text;
		const receiver = expression.expression;
		if (ts.isIdentifier(receiver)) {
			const imported = moduleIdentity(referenceSymbol(receiver, checker), checker);
			if (imported === "@msgpack/msgpack:*" && (name === "encode" || name === "decode")) return `msgpack.${name}`;
			if (imported === "es-toolkit:*" && name === "cloneDeep") return "cloneDeep";
		}
		const memberSymbol = referenceSymbol(member, checker) ?? referenceSymbol(expression, checker);
		const known = knownSymbolLabel(memberSymbol, checker);
		if (known) return known;
		const canonicalReceiver = canonicalSymbol(referenceSymbol(receiver, checker), checker);
		const receiverIdentity = symbolIdentity(canonicalReceiver, checker);
		if (ts.isIdentifier(receiver) && receiver.text === "globalThis" && name === "structuredClone" && !receiverIdentity)
			return "structuredClone";
		if ((name === "encode" || name === "decode") && /_pb\.ts:/.test(receiverIdentity ?? ""))
			return `${canonicalReceiver?.name}.${name}`;
		if (name === "create" && /object_pb\.ts:/.test(receiverIdentity ?? "")) return `${canonicalReceiver?.name}.create`;
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
			const exportSink = ts.isExportDeclaration(node) ? externalExportSink(node) : undefined;
			if (exportSink) {
				record(fileName, node, exportSink.wildcardLabel);
			} else if (ts.isExportSpecifier(node)) {
				record(fileName, node, referenceLabel(node.name, checker));
			} else if (ts.isCallExpression(node)) {
				record(fileName, node, referenceLabel(node.expression, checker));
			} else if (
				(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				!(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
				!(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
				!((node.parent as ts.NamedDeclaration).name === node && !ts.isShorthandPropertyAssignment(node.parent)) &&
				!ts.findAncestor(node, ts.isImportDeclaration)
			) {
				record(fileName, node, referenceLabel(node, checker));
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
			const edge = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement : undefined;
			if (!edge?.moduleSpecifier || !ts.isStringLiteral(edge.moduleSpecifier)) continue;
			if (ts.isExportDeclaration(edge) ? edge.isTypeOnly : edge.importClause?.isTypeOnly) continue;
			const bindings = ts.isImportDeclaration(edge) ? edge.importClause?.namedBindings : undefined;
			if (bindings && ts.isNamedImports(bindings) && bindings.elements.every((element) => element.isTypeOnly)) continue;
			const resolved = normalizeModule(current, edge.moduleSpecifier.text, sources);
			if (resolved) pending.push(resolved);
			else if (edge.moduleSpecifier.text.startsWith(".") || edge.moduleSpecifier.text.startsWith("@ts-drp/"))
				unresolved.push(`${current}:${edge.moduleSpecifier.text}`);
		}
	}
	return { files: result, unresolved: unresolved.sort() };
}

function measuredCopyLeafRoots(references: readonly string[]): string[] {
	const hasEdge = (site: string): boolean => references.includes(`${site}#1`);
	return D922C_ROOTS.filter(
		(root) =>
			hasEdge("packages/object/src/publication/publisher.ts:capturePublishedState:copy") &&
			hasEdge(`packages/object/src/drp-applier.ts:DRPVertexApplier.${root}:${root}`) &&
			hasEdge(`packages/object/src/publication/publisher.ts:${root}:capturePublishedState`)
	);
}

function externalSurface(references: readonly string[]): string[] {
	const result: string[] = [];
	const version = (relativeManifest: string): string =>
		(JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, relativeManifest), "utf8")) as { version: string })
			.version;
	for (const sink of EXTERNAL_SINK_EXPORTS) {
		const installedVersion = version(sink.manifest);
		for (const [member, label] of sink.members) {
			if (references.some((site) => site.includes(`:${label}#`)))
				result.push(`${sink.module}@${installedVersion}:${member}`);
		}
		if (references.some((site) => site.includes(`:${sink.wildcardLabel}#`)))
			result.push(`${sink.module}@${installedVersion}:*`);
	}
	return result.sort();
}

const analysisCache = new WeakMap<object, D922cAnalysis>();
const SINK_REFERENCE =
	/(?:cloneDeep|structuredClone|detachReplicaLocalContext|detachStatePayload|detachStateSnapshot|stateFromDRP|serializeDRPState|deserializeDRPState|serializeValue|deserializeValue|node:v8\.(?:serialize|deserialize)|msgpack\.(?:encode|decode)|[^:]+\.(?:encode|decode))#/;

function analyze(sources: GovernedSources): D922cAnalysis {
	const cached = analysisCache.get(sources);
	if (cached) return cached;
	const { checker, program } = programFor(sources);
	const allSites = sites(sources, checker, program);
	const real = sources["packages/object/src/publication/publisher.ts"] !== undefined;
	const closure = runtimeClosure(sources, real ? D922D_RUNTIME_ROOTS : [WORKSPACE_PUBLISHER_PATH]);
	const packageReferences = allSites.filter((site) => SINK_REFERENCE.test(site));
	const closureReferences = packageReferences.filter((site) => closure.files.has(site.slice(0, site.indexOf(":"))));
	const violations = closure.unresolved.map((site) => `unresolved internal acquisition ${site}`);
	for (const site of allSites) {
		const fileName = site.slice(0, site.indexOf(":"));
		const externalSink = EXTERNAL_SINK_EXPORTS.find((sink) => site.includes(`:${sink.wildcardLabel}#`));
		if (externalSink) violations.push(`external wildcard acquisition ${fileName}:${externalSink.module}`);
	}
	const approved = new Set(real ? D922C_PACKAGE_REFERENCE_SITES : []);
	for (const site of packageReferences)
		if (!approved.has(site)) violations.push(`serialization/clone reference ${site}`);
	for (const fileName of closure.files) {
		const text = sources[fileName];
		if (/\bJSON\s*\.\s*(?:parse|stringify)\s*\(/.test(text)) violations.push(`serialization JSON in ${fileName}`);
		if (/\b(?:eval|Function|require)\s*\(|\bimport\s*\(/.test(text))
			violations.push(`dynamic acquisition in ${fileName}`);
		if (/\b(?:encode|decode)\s*\]\s*\(/.test(text) || /\[[A-Za-z_$][\w$]*\]\s*\(/.test(text))
			violations.push(`computed acquisition in ${fileName}`);
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
	const reviewedOperations = REVIEWED_WORKSPACE_OPERATIONS.filter((operation) => {
		const separator = operation.lastIndexOf(":");
		const category = operation.slice(separator + 1);
		const label = category === "detach" ? "detachState" : "msgpack.encode";
		const referencePrefix = `${operation.slice(0, separator)}:${label}`;
		return packageReferences.some((site) => site.startsWith(referencePrefix));
	}).sort();
	const analysis: D922cAnalysis = {
		violations: [...new Set(violations)].sort(),
		residualCloneSites: packageReferences.filter(
			(site) =>
				(site.includes(":cloneDeep#") ||
					site.includes(":detachReplicaLocalContext#") ||
					site.includes(":detachStatePayload#")) &&
				!site.includes("copy-capability.ts") &&
				!site.includes("src/index.ts")
		),
		residualStateCaptureSites: packageReferences.filter((site) => site.includes(":stateFromDRP#")),
		reviewedOperations,
		analyzedSourcePaths: Object.keys(sources).sort(),
		authority: {
			loadedSourcePaths: Object.keys(sources).sort(),
			analyzedSourcePaths: Object.keys(sources).sort(),
			capabilityExports,
			capabilityConstructionSites,
			measuredCopyLeaf: "packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy",
			measuredCopyLeafRoots: real ? measuredCopyLeafRoots(allSites) : [],
			packageReferenceSites: packageReferences,
			closureReferenceSites: closureReferences,
			codecReferenceSites: packageReferences.filter(
				(site) => !site.includes(":cloneDeep#") && !site.includes(":detachState") && !site.includes(":stateFromDRP#")
			),
			externalRuntimeSurface: externalSurface(allSites),
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
	"packages/object/src/state-payload.ts",
	"packages/object/src/state-store.ts",
	"packages/utils/src/serialization/equality.ts",
] as const;

const D922C_CAPABILITY_EXPORTS = [
	"ComparisonCounters",
	"ComparisonEvent",
	"ComparisonMetadata",
	"ComparisonPhase",
	"PublicationCapability",
	"createPublicationCapability",
	"proxyValuesEqual",
] as const;
const D922C_ROOTS = ["advanceCheckpointIfNeeded", "assignState"] as const;
const D922D_RUNTIME_ROOTS = [
	"packages/object/src/publication/publisher.ts",
	"packages/object/src/publication/copy-capability.ts",
] as const;
const D922D_EXPECTED_RUNTIME_CLOSURE = [
	"packages/object/src/publication/copy-capability.ts",
	"packages/object/src/publication/publisher.ts",
	"packages/object/src/state-payload.ts",
	"packages/object/src/state-store.ts",
	"packages/utils/src/serialization/equality.ts",
] as const;

function d922dMutateSource(
	sources: GovernedSources,
	sourcePath: string,
	before: string,
	after: string
): Record<string, string> {
	const source = sources[sourcePath];
	if (source === undefined || source.split(before).length !== 2) {
		throw new Error(`Expected one mutation target in ${sourcePath}`);
	}
	return { ...sources, [sourcePath]: source.replace(before, after) };
}

function d922dStaticReferenceFixture(
	name: string,
	expectedReference: string,
	imports: string,
	reference: string,
	dependencies: Readonly<Record<string, string>>
): WorkspaceMutationFixture & { readonly expectedReference: string } {
	return { ...workspaceFixture(name, ENCODE_VIOLATION, imports, reference, dependencies), expectedReference };
}

const D922D_STATIC_REFERENCE_MUTANTS = [
	d922dStaticReferenceFixture(
		"imported shorthand packing",
		"packages/object/src/drp-applier.ts:publish:msgpack.encode#1",
		'import { encode } from "@msgpack/msgpack";',
		"const hold = { encode }; void hold;",
		{}
	),
	d922dStaticReferenceFixture(
		"aliased internal serializer import",
		"packages/object/src/drp-applier.ts:publish:serializeValue#1",
		'import { serializeValue as sv } from "@ts-drp/utils/serialization/equality";',
		"void sv;",
		{
			"packages/utils/src/serialization/equality.ts":
				"export function serializeValue(value: unknown): unknown { return value; }",
		}
	),
	d922dStaticReferenceFixture(
		"namespace member reference to an internal serializer",
		"packages/object/src/drp-applier.ts:publish:serializeValue#1",
		'import * as serialization from "@ts-drp/utils/serialization/equality";',
		"void serialization.serializeValue;",
		{
			"packages/utils/src/serialization/equality.ts":
				"export function serializeValue(value: unknown): unknown { return value; }",
		}
	),
	d922dStaticReferenceFixture(
		"direct string-literal generated-member access",
		"packages/object/src/drp-applier.ts:publish:DRPStateEntry.encode#1",
		'import { DRPStateEntry } from "@ts-drp/types/proto/drp/v1/object_pb";',
		'void DRPStateEntry["encode"];',
		{
			"packages/types/src/proto/drp/v1/object_pb.ts":
				"export const DRPStateEntry = { encode(value: unknown): unknown { return value; } };",
		}
	),
	d922dStaticReferenceFixture(
		"namespace string-literal access to an internal serializer",
		"packages/object/src/drp-applier.ts:publish:serializeValue#1",
		'import * as serialization from "@ts-drp/utils/serialization/equality";',
		'void serialization["serializeValue"];',
		{
			"packages/utils/src/serialization/equality.ts":
				"export function serializeValue(value: unknown): unknown { return value; }",
		}
	),
] as const;

const D922D_STATIC_REFERENCE_CONTROLS = [
	workspaceFixture(
		"same-shape local shorthand and members",
		/never/,
		"",
		'const encode = (value: unknown): unknown => value; const local = { encode, serializeValue: encode }; const hold = { encode }; void hold; void local.serializeValue; void local["serializeValue"];',
		{}
	),
	workspaceFixture(
		"type-only named, namespace and string-member references",
		/never/,
		'import type { DRPStateEntry } from "@ts-drp/types/proto/drp/v1/object_pb"; import type * as serialization from "@ts-drp/utils/serialization/equality";',
		'type GeneratedEncoder = typeof DRPStateEntry["encode"]; type Serializer = typeof serialization.serializeValue; void (undefined as GeneratedEncoder | Serializer | undefined);',
		{
			"packages/types/src/proto/drp/v1/object_pb.ts":
				"export const DRPStateEntry = { encode(value: unknown): unknown { return value; } };",
			"packages/utils/src/serialization/equality.ts":
				"export function serializeValue(value: unknown): unknown { return value; }",
		}
	),
] as const;

interface D922dModuleExportCase {
	readonly expectedExternalRuntimeSurface: readonly string[];
	readonly expectedPackageReferences: readonly string[];
	readonly expectedViolations: readonly string[];
	readonly name: string;
	readonly sources: GovernedSources;
}

const D922D_KNOWN_EXTERNAL_SINKS = [
	{ module: "@msgpack/msgpack", namespace: "msgpack", member: "encode", version: "3.1.1" },
	{ module: "es-toolkit", namespace: "toolkit", member: "cloneDeep", version: "1.30.1" },
] as const;

const D922D_TYPED_EXPORT_FORMS = [
	{ kind: "runtime star", namespace: false, typeOnly: false },
	{ kind: "runtime namespace", namespace: true, typeOnly: false },
	{ kind: "type-only star", namespace: false, typeOnly: true },
	{ kind: "type-only namespace", namespace: true, typeOnly: true },
] as const;

const D922D_TYPED_EXPORT_DECLARATION_MATRIX: readonly D922dModuleExportCase[] = D922D_KNOWN_EXTERNAL_SINKS.flatMap(
	(sink) =>
		D922D_TYPED_EXPORT_FORMS.map(({ kind, namespace, typeOnly }) => {
			const exportedName = namespace ? sink.namespace : sink.member;
			const runtime = !typeOnly;
			return {
				name: `${sink.module} ${kind}`,
				expectedPackageReferences: [],
				expectedExternalRuntimeSurface: runtime ? [`${sink.module}@${sink.version}:*`] : [],
				expectedViolations: runtime ? [`external wildcard acquisition ${UTILS_SERIALIZATION_PATH}:${sink.module}`] : [],
				sources: {
					[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
						runtime ? `import { ${exportedName} } from "@ts-drp/utils/serialization";` : "",
						runtime ? `${exportedName}${namespace ? `.${sink.member}` : ""}(state);` : "void state;"
					),
					[UTILS_SERIALIZATION_PATH]: `export ${typeOnly ? "type " : ""}*${
						namespace ? ` as ${sink.namespace}` : ""
					} from "${sink.module}";`,
				},
			};
		})
);

const D922D_MODULE_EXPORT_MATRIX: readonly D922dModuleExportCase[] = [
	{
		name: "renamed external MessagePack encode re-export with first-party consumer",
		expectedPackageReferences: [
			"packages/object/src/drp-applier.ts:publish:msgpack.encode#1",
			"packages/utils/src/serialization/index.ts:<module>:msgpack.encode#1",
		],
		expectedExternalRuntimeSurface: ["@msgpack/msgpack@3.1.1:encode"],
		expectedViolations: [
			"serialization/clone reference packages/object/src/drp-applier.ts:publish:msgpack.encode#1",
			"serialization/clone reference packages/utils/src/serialization/index.ts:<module>:msgpack.encode#1",
		],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { snapshotValueBytes } from "@ts-drp/utils/serialization";',
				"snapshotValueBytes(state);"
			),
			[UTILS_SERIALIZATION_PATH]: 'export { encode as snapshotValueBytes } from "@msgpack/msgpack";',
		},
	},
	{
		name: "renamed external cloneDeep re-export with first-party consumer",
		expectedPackageReferences: [
			"packages/object/src/drp-applier.ts:publish:cloneDeep#1",
			"packages/utils/src/serialization/index.ts:<module>:cloneDeep#1",
		],
		expectedExternalRuntimeSurface: ["es-toolkit@1.30.1:cloneDeep"],
		expectedViolations: [
			"serialization/clone reference packages/object/src/drp-applier.ts:publish:cloneDeep#1",
			"serialization/clone reference packages/utils/src/serialization/index.ts:<module>:cloneDeep#1",
		],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { detachSnapshot } from "@ts-drp/utils/serialization";',
				"detachSnapshot(state);"
			),
			[UTILS_SERIALIZATION_PATH]: 'export { cloneDeep as detachSnapshot } from "es-toolkit";',
		},
	},
	{
		name: "declaration-level type-only cloneDeep re-export",
		expectedPackageReferences: [],
		expectedExternalRuntimeSurface: [],
		expectedViolations: [],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			[UTILS_SERIALIZATION_PATH]: 'export type { cloneDeep as detach } from "es-toolkit";',
		},
	},
	{
		name: "specifier-level type-only MessagePack encode re-export",
		expectedPackageReferences: [],
		expectedExternalRuntimeSurface: [],
		expectedViolations: [],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "void state;"),
			[UTILS_SERIALIZATION_PATH]: 'export { type encode as pack } from "@msgpack/msgpack";',
		},
	},
	...D922D_TYPED_EXPORT_DECLARATION_MATRIX,
	{
		name: "imported exported DRP-state deserializer",
		expectedPackageReferences: ["packages/object/src/drp-applier.ts:publish:deserializeDRPState#1"],
		expectedExternalRuntimeSurface: [],
		expectedViolations: [
			"serialization/clone reference packages/object/src/drp-applier.ts:publish:deserializeDRPState#1",
		],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { deserializeDRPState as restoreState } from "@ts-drp/utils/serialization";',
				"restoreState(state);"
			),
			[UTILS_SERIALIZATION_PATH]: "export function deserializeDRPState(value: unknown): unknown { return value; }",
		},
	},
	{
		name: "known globalThis structuredClone form",
		expectedPackageReferences: ["packages/object/src/drp-applier.ts:publish:structuredClone#1"],
		expectedExternalRuntimeSurface: [],
		expectedViolations: ["serialization/clone reference packages/object/src/drp-applier.ts:publish:structuredClone#1"],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher("", "globalThis.structuredClone(state);"),
		},
	},
	{
		name: "benign external named member re-export with first-party consumer",
		expectedPackageReferences: [],
		expectedExternalRuntimeSurface: [],
		expectedViolations: [],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { SnapshotMetadata } from "@ts-drp/utils/serialization";',
				"void SnapshotMetadata;"
			),
			[UTILS_SERIALIZATION_PATH]: 'export { ExtensionCodec as SnapshotMetadata } from "@msgpack/msgpack";',
		},
	},
	{
		name: "locally shadowed globalThis object",
		expectedPackageReferences: [],
		expectedExternalRuntimeSurface: [],
		expectedViolations: [],
		sources: {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				"",
				"const globalThis = { structuredClone: (value: unknown): unknown => value }; globalThis.structuredClone(state);"
			),
		},
	},
];

function d922cSites(sourcePath: string, owner: string, callee: string, count = 1): string[] {
	return Array.from({ length: count }, (_, index) => `${sourcePath}:${owner}:${callee}#${index + 1}`);
}

// Discovered source-first from the real workspace at RED d763fad. A site is an
// alias-resolved call node, identified by source/lexical owner/callee/ordinal rather
// than a brittle line number. Declarations and type-only references are not calls.
const D922C_CODEC_REFERENCE_SITES = [
	...d922cSites("packages/interval-discovery/src/index.ts", "_broadcastDiscoveryRequest", "DRPDiscovery.encode"),
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
	...d922cSites(
		"packages/object/src/publication/copy-capability.ts",
		"createPublicationCapability.copy",
		"detachStatePayload"
	),
	...d922cSites("packages/object/src/drp-applier.ts", "captureBatchVertexOperation", "detachStatePayload"),
	...d922cSites("packages/object/src/drp-applier.ts", "cloneEnumerableInstance", "detachReplicaLocalContext"),
	...d922cSites("packages/object/src/drp-applier.ts", "cloneEnumerableInstance", "detachStatePayload"),
	...d922cSites("packages/object/src/drp-applier.ts", "DRPVertexApplier.createVertex", "detachStatePayload"),
	...d922cSites("packages/object/src/drp-applier.ts", "callDRP", "detachStatePayload"),
	...d922cSites("packages/object/src/index.ts", "DRPObject.getStates", "detachStateSnapshot", 2),
	...d922cSites("packages/object/src/index.ts", "DRPObject.setACLState", "detachStateSnapshot"),
	...d922cSites("packages/object/src/index.ts", "DRPObject.setDRPState", "detachStateSnapshot"),
	...d922cSites(
		"packages/object/src/state-materialize.ts",
		"DRPObjectStateManager.constructor",
		"detachReplicaLocalContext",
		2
	),
	...d922cSites(
		"packages/object/src/state-materialize.ts",
		"DRPObjectStateManager.fromStates",
		"detachReplicaLocalContext",
		2
	),
	...d922cSites(
		"packages/object/src/state-materialize.ts",
		"DRPObjectStateManager.fromHashACL",
		"detachReplicaLocalContext"
	),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.applyState", "detachStatePayload"),
	...d922cSites("packages/object/src/state-materialize.ts", "stateFromDRP", "detachStatePayload"),
	...d922cSites("packages/object/src/state-payload.ts", "detachStateSnapshot", "detachStatePayload"),
	...d922cSites("packages/object/src/state-materialize.ts", "DRPObjectStateManager.constructor", "stateFromDRP", 2),
	...d922cSites("packages/object/src/drp-applier.ts", "DRPVertexApplier.computeOperationUntraced", "stateFromDRP", 2),
].sort();

const D922C_PACKAGE_REFERENCE_SITES = [...D922C_CODEC_REFERENCE_SITES, ...D922C_COPY_CAPTURE_REFERENCE_SITES].sort();

const D922C_CLOSURE_REFERENCE_SITES = [
	...d922cSites(
		"packages/object/src/publication/copy-capability.ts",
		"createPublicationCapability.copy",
		"detachStatePayload"
	),
	...d922cSites("packages/object/src/state-payload.ts", "detachStateSnapshot", "detachStatePayload"),
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

	it.each([
		[
			"assignState",
			"this.publicationPublisher.assignState(operation, adoption, publicationAttempts, publicationFrontier);",
			["advanceCheckpointIfNeeded"],
		],
		[
			"advanceCheckpointIfNeeded",
			"this.publicationPublisher.advanceCheckpointIfNeeded(journal, force, publicationAttempts);",
			["assignState"],
		],
	] as const)("derives the %s root-to-measured-copy-leaf fact from its delegate", (_, delegate, expectedRoots) => {
		const sources = d922dMutateSource(
			realGovernedWorkspaceSources(),
			WORKSPACE_PUBLISHER_PATH,
			delegate,
			"void this.publicationPublisher;"
		);
		expect(d922cAuthority(analyze(sources)).measuredCopyLeafRoots).toEqual(expectedRoots);
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
		expect(D922C_PACKAGE_REFERENCE_SITES).toHaveLength(116);
		expect(new Set(D922C_PACKAGE_REFERENCE_SITES).size).toBe(116);
		expect([...authority.packageReferenceSites].sort()).toEqual(D922C_PACKAGE_REFERENCE_SITES);
		expect([...authority.closureReferenceSites].sort()).toEqual(D922C_CLOSURE_REFERENCE_SITES);
		expect(authority.externalRuntimeSurface).toEqual([
			"@msgpack/msgpack@3.1.1:decode",
			"@msgpack/msgpack@3.1.1:encode",
		]);
		expect(authority.unresolvedAcquisitions).toEqual([]);
	});

	it("keeps materialization and decode-capable serialization outside the publisher runtime closure", () => {
		const sources = realGovernedWorkspaceSources();
		const closure = runtimeClosure(sources, D922D_RUNTIME_ROOTS);
		expect(closure.unresolved).toEqual([]);
		expect([...closure.files].sort()).toEqual([...D922D_EXPECTED_RUNTIME_CLOSURE].sort());
	});

	it("uses one exported equality-only subpath from the capability", () => {
		const capabilitySource = realGovernedWorkspaceSources()[D922D_RUNTIME_ROOTS[1]];
		const capabilityFile = ts.createSourceFile("copy-capability.ts", capabilitySource, ts.ScriptTarget.Latest, true);
		const runtimeUtilsImports = capabilityFile.statements
			.filter(ts.isImportDeclaration)
			.filter((statement) => !statement.importClause?.isTypeOnly)
			.map((statement) =>
				ts.isStringLiteral(statement.moduleSpecifier)
					? statement.moduleSpecifier.text
					: statement.moduleSpecifier.getText()
			)
			.filter((specifier) => specifier.startsWith("@ts-drp/utils"));
		const manifest = JSON.parse(
			fs.readFileSync(path.join(WORKSPACE_DIRECTORY, "packages/utils/package.json"), "utf8")
		) as {
			exports: Record<string, unknown>;
		};
		expect({ runtimeUtilsImports, equalityExport: manifest.exports["./serialization/equality"] }).toEqual({
			runtimeUtilsImports: ["@ts-drp/utils/serialization/equality"],
			equalityExport: {
				types: "./dist/src/serialization/equality.d.ts",
				import: "./dist/src/serialization/equality.js",
			},
		});
		const viteConfig = fs.readFileSync(path.join(WORKSPACE_DIRECTORY, "vite.config.mts"), "utf8");
		const equalityAlias = viteConfig.indexOf('"@ts-drp/utils/serialization/equality"');
		const serializationAlias = viteConfig.indexOf('"@ts-drp/utils/serialization"');
		expect(equalityAlias).toBeGreaterThan(-1);
		expect(serializationAlias).toBeGreaterThan(equalityAlias);
	});

	it("keeps generated state codecs out of the capability through type-only structural shapes", () => {
		const sources = realGovernedWorkspaceSources();
		const capabilitySource = sources[D922D_RUNTIME_ROOTS[1]];
		const capabilityFile = ts.createSourceFile("copy-capability.ts", capabilitySource, ts.ScriptTarget.Latest, true);
		const stateImports = capabilityFile.statements
			.filter(ts.isImportDeclaration)
			.filter(
				(statement) =>
					ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@ts-drp/types"
			);
		expect(
			stateImports.every((statement) => {
				const importClause = statement.importClause;
				if (!importClause || importClause.isTypeOnly) return importClause?.isTypeOnly ?? false;
				const bindings = importClause.namedBindings;
				return (
					bindings !== undefined &&
					ts.isNamedImports(bindings) &&
					bindings.elements.every((element) => element.isTypeOnly)
				);
			})
		).toBe(true);
		expect(d922cAuthority(analyze(sources)).snapshotConstructionSites).not.toEqual(
			expect.arrayContaining([
				"packages/object/src/publication/copy-capability.ts:createPublicationCapability.createEntry:DRPStateEntry.create#1",
				"packages/object/src/publication/copy-capability.ts:createPublicationCapability.createSnapshot:DRPState.create#1",
			])
		);
	});

	it("includes generated runtime dependencies in the closure reference tier without a filename carve-out", () => {
		const generatedPath = "packages/types/src/proto/drp/v1/review_fixture_pb.ts";
		const sources = {
			[WORKSPACE_PUBLISHER_PATH]: workspacePublisher(
				'import { wireEncode } from "@ts-drp/types/proto/drp/v1/review_fixture_pb";',
				"void wireEncode;"
			),
			[generatedPath]:
				'import { encode } from "@msgpack/msgpack"; export function wireEncode(value: unknown): unknown { return encode(value); }',
		};
		const authority = d922cAuthority(analyze(sources));
		const generatedReference = `${generatedPath}:wireEncode:msgpack.encode#1`;
		expect(authority.packageReferenceSites).toContain(generatedReference);
		expect(authority.closureReferenceSites).toContain(generatedReference);
	});

	it("pins the exact package-wide snapshot constructors and admits no third root", () => {
		const authority = d922cAuthority(analyze(realGovernedWorkspaceSources()) as D922cAnalysis);
		expect(authority.snapshotConstructionSites).toEqual([
			"packages/object/src/state-materialize.ts:DRPObjectStateManager.constructor:DRPState.create#1",
			"packages/object/src/state-materialize.ts:stateFromDRP:DRPState.create#1",
			"packages/object/src/state-materialize.ts:stateFromDRP:DRPStateEntry.create#1",
			"packages/utils/src/serialization/index.ts:deserializeDRPState:DRPState.create#1",
			"packages/utils/src/serialization/index.ts:deserializeDRPState:DRPStateEntry.create#1",
		]);
	});

	it("makes the restricted lint file set equal the exact first-party publisher runtime closure", async () => {
		const lintConfig = fs.readFileSync(path.join(WORKSPACE_DIRECTORY, "eslint.config.mjs"), "utf8");
		for (const rule of [
			"no-restricted-globals",
			"no-restricted-imports",
			"no-restricted-properties",
			"no-restricted-syntax",
		]) {
			expect(lintConfig).toContain(`"${rule}"`);
		}
		const closure = runtimeClosure(realGovernedWorkspaceSources(), D922D_RUNTIME_ROOTS);
		const module = (await import(pathToFileURL(path.join(WORKSPACE_DIRECTORY, "eslint.config.mjs")).href)) as {
			default: readonly {
				files?: readonly string[];
				rules?: Readonly<Record<string, unknown>>;
			}[];
		};
		const lintFiles = module.default.flatMap((entry) => {
			if (
				!entry.files?.some((file) => closure.files.has(file)) ||
				!Object.keys(entry.rules ?? {}).some((rule) => rule.startsWith("no-restricted-"))
			)
				return [];
			return entry.files;
		});
		expect([...new Set(lintFiles)].sort()).toEqual([...closure.files].sort());

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

	it("retains the exact 0 / 5 / 13 / 4 detach/capture tuple beside the fifth census", () => {
		const analysis = analyze(realGovernedWorkspaceSources()) as D922cAnalysis;
		expect(analysis.violations).toEqual([]);
		expect(analysis.reviewedOperations).toEqual([...REVIEWED_WORKSPACE_OPERATIONS].sort());
		expect(analysis.residualCloneSites).toEqual([...RESIDUAL_CLONE_SITES].sort());
		expect(analysis.residualStateCaptureSites).toEqual([...RESIDUAL_STATE_CAPTURE_SITES].sort());
		expect(d922cAuthority(analysis).codecReferenceSites).toHaveLength(94);
	});

	it("derives reviewed operations from the governed operation that remains in source", () => {
		const sources = d922dMutateSource(
			realGovernedWorkspaceSources(),
			"packages/object/src/publication/copy-capability.ts",
			'return observer ? emit({ type: "copy", value, metadata }) : detachStatePayload(value);',
			"return value;"
		);
		expect(analyze(sources).reviewedOperations).toEqual(
			REVIEWED_WORKSPACE_OPERATIONS.filter(
				(operation) =>
					operation !== "packages/object/src/publication/copy-capability.ts:createPublicationCapability.copy:detach"
			).sort()
		);
	});

	it.each(D922D_STATIC_REFERENCE_MUTANTS)(
		"counts canonical known-sink reference shape: $name",
		({ expectedReference, expectedViolation, sources }) => {
			const analysis = analyze(sources);
			expect(d922cAuthority(analysis).packageReferenceSites).toContain(expectedReference);
			expect(analysis.violations.some((violation) => expectedViolation.test(violation))).toBe(true);
		}
	);

	it.each(D922D_STATIC_REFERENCE_CONTROLS)("keeps canonical-symbol control clean: $name", ({ sources }) => {
		const analysis = analyze(sources);
		expect(d922cAuthority(analysis).packageReferenceSites).toEqual([]);
		expect(analysis.violations).toEqual([]);
	});

	it.each(D922D_MODULE_EXPORT_MATRIX)(
		"classifies causal module/export edge: $name",
		({ expectedExternalRuntimeSurface, expectedPackageReferences, expectedViolations, sources }) => {
			const analysis = analyze(sources);
			const authority = d922cAuthority(analysis);
			expect(authority.packageReferenceSites).toEqual(expectedPackageReferences);
			expect(authority.externalRuntimeSurface).toEqual(expectedExternalRuntimeSurface);
			expect(analysis.violations).toEqual(expectedViolations);
		}
	);

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
	});
});
