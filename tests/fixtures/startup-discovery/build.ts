import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { builtinsPolyfills } from "@esbuild-plugins/node-modules-polyfill/dist/polyfills.js";
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import {originalPositionFor, TraceMap} from "@jridgewell/trace-mapping";

import { requireValue } from "./assert.js";
import { pendingNativeTransform } from "../pending-discovery/native-transform.js";

const root = resolve(import.meta.dirname, "../../.."),
	destination = process.argv[2];
if (destination === undefined) throw new Error("STARTUP_NEW_ARTIFACT_DIRECTORY_REQUIRED");
const selectedEntry = process.env.STARTUP_ENTRY;
if (selectedEntry !== undefined && selectedEntry !== "r8-source-binding") throw new Error("STARTUP_ENTRY_INVALID");
const migrationFault = process.env.STARTUP_MIGRATION_FAULT;
const criticalProfiling=process.env.STARTUP_HEALTHY_GRID_CRITICAL_PROFILE==="1";
const fullFunctionCalls = process.env.STARTUP_HEALTHY_GRID_FULL_CALLS === "1";
const clockedFunctionOwners = process.env.STARTUP_HEALTHY_GRID_CLOCKED_OWNERS === "1";
if (clockedFunctionOwners && !fullFunctionCalls) throw Error("CLOCKED_OWNERS_REQUIRE_FULL_FUNCTION_CALLS");
if (fullFunctionCalls && !criticalProfiling) throw Error("FULL_FUNCTION_CALLS_REQUIRE_CRITICAL_BUILD");
const incrementalNativeControls=process.env.STARTUP_HEALTHY_GRID_INCREMENTAL_CONTROLS==="1";
if(incrementalNativeControls&&!criticalProfiling)throw new Error("INCREMENTAL_NATIVE_CONTROLS_REQUIRE_CRITICAL_BUILD");
const finishingEnvelopeShadow = process.env.STARTUP_FINISHING_ENVELOPE_SHADOW === "1";
if (finishingEnvelopeShadow && (selectedEntry !== "r8-source-binding" || migrationFault !== undefined || criticalProfiling))
	throw new Error("FINISHING_ENVELOPE_SHADOW_REQUIRES_UNPROFILED_CURRENT_SOURCE");
if(criticalProfiling && (selectedEntry!=="r8-source-binding" || migrationFault!==undefined))throw new Error("CRITICAL_PROFILING_REQUIRES_HEALTHY_CURRENT_SOURCE");
if (
	migrationFault !== undefined &&
	(selectedEntry !== "r8-source-binding" || !["after-apply", "pending-publication"].includes(migrationFault))
)
	throw new Error("STARTUP_MIGRATION_FAULT_INVALID");
mkdirSync(destination); // Existing artifacts cannot be overwritten.
const observer = join(root, "tests/fixtures/startup-discovery/observation.ts");
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const functions = new Set([
	"prepareV3LiveGeneration",
	"recoverV3LiveReplica",
	"activateV3LivePlane",
	"stageCreatorSuccessorAdoption",
	"publishStagedCreatorSuccessorAdoption",
	"activateCreatorSuccessorAdoption",
	"reopenCreatorSuccessorAdoption",
	"recoverPendingCreatorSuccessorAdoption",
	"bindV3BlueprintLivePlane",
]);
const originalObservationPath = /(?:(?:packages\/node\/src\/(?:v3-room|v3-live|creator-close|internal\/(?:creator-closed-rollback-data|creator-snapshot-data|creator-transition-advance|closed-epoch-cleanup)|creator-adoption|creator-adoption-stage|creator-adoption-activate|creator-adoption-recover)|examples\/v3-room\/src\/index)\.ts|packages\/storage-browser\/(?:dist\/)?src\/(?:room-head|live-journal|snapshot-transfer|internal\/(?:idb-adapter|native-read-reservation))\.(?:ts|js)|packages\/(?:canonical\/(?:dist\/)?src\/internal\/codec|protocol-v3\/(?:dist\/)?src\/index|storage\/(?:dist\/)?src\/maintenance|live-journal\/(?:dist\/)?src\/retirement|compaction\/(?:dist\/)?src\/blueprint-fold)\.(?:ts|js))$/;
type ObservationInsertion = { offset: number; text: string; end?: number; priority?: number };
type CanonicalCallsite = {
	label: string; source: string; owner: string; line: number; column: number;
	codec: "decode" | "encode";
	start: number; end: number; callee: string; receiver: "direct" | "module-member";
	typeArguments: readonly string[];
};
/** Static callee-only observation: arguments (including await/yield) remain in
 * their original lexical position. No stack capture or asynchronous context. */
function canonicalCallsites(ast: ts.SourceFile, path: string): CanonicalCallsite[] {
	const identifiers = new Map<string, "decode" | "encode">();
	const namespaces = new Set<string>();
	for (const statement of ast.statements) {
		if (ts.isFunctionDeclaration(statement) && (statement.name?.text === "decodeCanonical" || statement.name?.text === "encodeCanonical"))
			identifiers.set(statement.name.text, statement.name.text === "decodeCanonical" ? "decode" : "encode");
		if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
		const bindings = statement.importClause.namedBindings;
		if (ts.isNamedImports(bindings)) {
			for (const binding of bindings.elements) {
				const name = (binding.propertyName ?? binding.name).text;
				if (name === "decodeCanonical" || name === "encodeCanonical") identifiers.set(binding.name.text, name === "decodeCanonical" ? "decode" : "encode");
			}
		} else if (ts.isNamespaceImport(bindings) && ts.isStringLiteral(statement.moduleSpecifier) &&
			/(?:^@ts-drp\/canonical(?:\/|$)|(?:^|\/)canonical(?:\/|$))/.test(statement.moduleSpecifier.text))
			namespaces.add(bindings.name.text);
	}
	const source = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
	const sites: CanonicalCallsite[] = [];
	const ownerOf = (call: ts.CallExpression): string => {
		const owners: string[] = [];
		for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
			if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
				ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
				ts.isConstructorDeclaration(node))) continue;
			const parent = node.parent;
			const name = "name" in node && node.name !== undefined ? node.name.getText(ast) :
				(ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) ? parent.name.getText(ast) :
				`callback@${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`;
			owners.push(name.slice(0, 128));
			if (owners.length === 4) break;
		}
		return owners.reverse().join("/") || "module";
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && node.questionDotToken === undefined) {
			const callee = node.expression;
			const direct = ts.isIdentifier(callee) ? identifiers.get(callee.text) : undefined;
			const member = ts.isPropertyAccessExpression(callee) && callee.questionDotToken === undefined &&
				(callee.name.text === "decodeCanonical" || callee.name.text === "encodeCanonical") && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text);
			if (direct || member) {
				const codec = direct ?? ((callee as ts.PropertyAccessExpression).name.text === "decodeCanonical" ? "decode" : "encode");
				const position = ast.getLineAndCharacterOfPosition(callee.getStart(ast));
				const owner = ownerOf(node), line = position.line + 1, column = position.character + 1;
				sites.push({ label: `canonical-${codec}-callsite:${source}:${owner}:${line}:${column}`,
					source, owner, line, column, codec, start: callee.getStart(ast), end: callee.end,
					callee: callee.getText(ast), receiver: member ? "module-member" : "direct",
					typeArguments: node.typeArguments?.map(argument => argument.getText(ast)) ?? [] });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	const starts = new Set(sites.map(site => site.start));
	if (starts.size !== sites.length || sites.some((site, index) => index !== 0 && sites[index - 1]!.end > site.start))
		throw new Error("CRITICAL_CANONICAL_CALLSITE_OVERLAP");
	// The codec's local clone/resource calls are not imported bindings. Definitions
	// are never wrapped as callsites; the original definition metrics remain.
	if (/\/packages\/canonical\/(?:dist\/)?src\/internal\/codec\.(?:ts|js)$/.test(path) &&
		(sites.length !== 4 || sites.filter(site => site.owner === "deepCloneCanonical").length !== 2 ||
			sites.filter(site => site.owner === "canonicalPrimitiveResourceForSizing" && site.codec === "encode").length !== 1 ||
			sites.filter(site => site.owner === "canonicalValueResourceForSizing" && site.codec === "encode").length !== 1 ||
			sites.filter(site => site.codec === "decode").length !== 1 || sites.filter(site => site.codec === "encode").length !== 3))
		throw new Error("CRITICAL_CANONICAL_LOCAL_CLONE_CALLSITE_CHANGED");
	return sites;
}
function addCanonicalCallsites(sites: readonly CanonicalCallsite[], insertions: ObservationInsertion[]): void {
	for (const site of sites) {
		if (insertions.some(insertion => insertion.offset > site.start && insertion.offset < site.end))
			throw new Error("CRITICAL_CANONICAL_CALLSITE_INSERTION_OVERLAP");
		const method = `${site.codec}Canonical`;
		const receiver = site.receiver === "module-member" ? site.callee.slice(0, -(method.length + 1)) : undefined;
		const invocationReceiver = receiver === undefined ? "this" : "__criticalReceiver";
		const wrapper = `function(this:unknown,...__criticalArguments:Parameters<typeof __criticalCodec>):ReturnType<typeof __criticalCodec>{
 const __criticalCallsite=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(site.label)},0,true);
 try{return Reflect.apply(__criticalCodec,${invocationReceiver},__criticalArguments);}
 catch(error){(globalThis as any).__warmMetricFailure?.(__criticalCallsite);throw error;}
 finally{(globalThis as any).__warmMetricEnd?.(__criticalCallsite);}
}`;
		const text = receiver === undefined
			? `((__criticalCodec:typeof ${site.callee})=>(${wrapper}) as typeof ${site.callee})(${site.callee})`
			: `((__criticalReceiver:typeof ${receiver})=>{const __criticalCodec=__criticalReceiver.${method};return (${wrapper}) as typeof ${site.callee};})(${receiver})`;
		insertions.push({ offset: site.start, end: site.end, text });
	}
}
function applyObservationInsertions(raw: string, insertions: ObservationInsertion[]): string {
	let code = raw;
	// Callee replacement precedes an outer observation insertion at the SAME
	// start. The latter then wraps the already-replaced callee, never vice versa.
	for (const insertion of insertions.sort((a, b) => b.offset - a.offset || Number(b.end !== undefined) - Number(a.end !== undefined) || (b.priority ?? 0) - (a.priority ?? 0)))
		code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.end ?? insertion.offset);
	return code;
}

/** Observe existing capture/compose/fragment boundaries, never byte recursion. */
function canonicalCaptureObservationInsertions(ast: ts.SourceFile): ObservationInsertion[] {
	const factories = ast.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "createCanonicalEncodingCapture");
	const encoders = ast.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "encodeInternal");
	if (factories.length !== 1 || encoders.length !== 1) throw Error("CRITICAL_CANONICAL_CAPTURE_OWNERS_CHANGED");
	const methods: ts.MethodDeclaration[] = [], reused: ts.ReturnStatement[] = [];
	const find = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && ["capture", "encode"].includes(node.name.getText(ast))) methods.push(node);
		ts.forEachChild(node, find);
	}; find(factories[0]!);
	const findReuse = (node: ts.Node): void => {
		if (ts.isReturnStatement(node) && node.expression?.getText(ast) === "original.encoded") reused.push(node);
		ts.forEachChild(node, findReuse);
	}; findReuse(encoders[0]!);
	if (methods.length !== 2 || new Set(methods.map(node => node.name.getText(ast))).size !== 2 || reused.length !== 1)
		throw Error("CRITICAL_CANONICAL_CAPTURE_BOUNDARIES_CHANGED");
	const edits: ObservationInsertion[] = [];
	for (const method of methods) {
		if (method.body === undefined || method.asteriskToken !== undefined ||
			method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
			throw Error("CRITICAL_CANONICAL_CAPTURE_BODY_MISSING");
		const name = method.name.getText(ast), returned = method.body.statements.filter(ts.isReturnStatement);
		if (returned.length !== 1 || returned[0]!.expression === undefined ||
			returned[0]!.expression!.getText(ast).replace(/\s/gu, "") !==
			(name === "capture" ? "handle" : "flattenEncoded(traverse(value,limits).encoded)"))
			throw Error("CRITICAL_CANONICAL_CAPTURE_RETURN_CHANGED");
		const id = "__criticalCanonicalCapture" + method.pos, value = id + "Output";
		const phase = name === "capture" ? "canonical-capture-row" : "canonical-capture-compose";
		edits.push({offset: method.body.getStart(ast) + 1,
			text: `const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)},0,true);try{`},
			{offset: method.body.end - 1,
				text: `}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;}finally{(globalThis as any).__warmMetricEnd?.(${id});}`},
			{offset: returned[0]!.getStart(ast), end: returned[0]!.expression!.getStart(ast), text: `{const ${value}=`},
			{offset: returned[0]!.end, text: `;(globalThis as any).__warmMetricBytes?.(${id},${value}.byteLength,true);return ${value};}`});
	}
	// This point is reached only after the original exact-fragment ownership,
	// dominating limits and insertion-depth checks. Never probe byte recursion.
	edits.push({offset: reused[0]!.getStart(ast), text:
		`(globalThis as any).__warmMetricEnd?.((globalThis as any).__warmMetricBegin?.("canonical-capture-reused-fragment",original.encoded.byteLength,true));`});
	return edits;
}

/** Diagnostic-only final-bundle pass. The original source map is evidence, not
 * attached to changed output. Every body is visited, including bundled deps and
 * esbuild helpers; the observer implementation itself is explicitly excluded. */
function instrumentFullFunctionBundle(raw: string, clockedOwners = false): {code: string; manifest: Record<string, unknown>; sourceMap: unknown} {
	const mapPrefix = "//# sourceMappingURL=data:application/json;base64,";
	const mapStart = raw.lastIndexOf(mapPrefix);
	if (mapStart < 0 || mapStart > 0 && raw.charCodeAt(mapStart - 1) !== 10)
		throw Error("FULL_FUNCTION_CALLS_INLINE_SOURCE_MAP_REQUIRED");
	let mapEnd = raw.length;
	while (mapEnd > mapStart && (raw.charCodeAt(mapEnd - 1) === 10 || raw.charCodeAt(mapEnd - 1) === 13)) mapEnd--;
	const encodedMap = raw.slice(mapStart + mapPrefix.length, mapEnd);
	if (encodedMap.length === 0) throw Error("FULL_FUNCTION_CALLS_INLINE_SOURCE_MAP_REQUIRED");
	// A quantified regexp over esbuild's multi-megabyte inline map can overflow
	// V8's regexp stack. Scan once without recursive/backtracking machinery.
	for (let i = 0; i < encodedMap.length; i++) {
		const c = encodedMap.charCodeAt(i);
		if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47 || c === 61))
			throw Error("FULL_FUNCTION_CALLS_INLINE_SOURCE_MAP_REQUIRED");
	}
	const sourceMap = JSON.parse(Buffer.from(encodedMap, "base64").toString("utf8"));
	const mapping = new TraceMap(sourceMap);
	const input = raw.slice(0, mapStart), inputHash = hash(raw);
	if (input.includes("__r8FullCallGlobal") || input.includes("__r8FullCall_")) throw Error("FULL_FUNCTION_CALLS_GLOBAL_ALIAS_COLLISION");
	const ast = ts.createSourceFile("entry.before-full-calls.mjs", input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	if ((ast as ts.SourceFile & {parseDiagnostics: readonly unknown[]}).parseDiagnostics.length !== 0)
		throw Error("FULL_FUNCTION_CALLS_INPUT_PARSE_REFUSED");
	type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration |
		ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
	type Row = {id: number; key: string; name: string; kind: string; source: string; sourceHash: string;
		sourceLine: number | null; sourceColumn: number | null; inputBundleLine: number; inputBundleColumn: number;
		start: number; end: number; token: string; async: boolean; generator: boolean; excluded: boolean;
		vmCountOnly: boolean; clockCoverage: string;
		lexicalParentId?: number; parametersPreBody: {start: number; end: number}[];
		awaits: string[]; yields: {id: string; delegated: boolean}[]; returns: number; generatedFinalLine?: number; generatedFinalColumn?: number;
		generatedFunctionStart?: number; generatedFunctionEnd?: number; generatedFunctionLine?: number; generatedFunctionColumn?: number};
	const functions: Row[] = [], owners = new Map<ts.Node, Row>(), byId = new Map<number, Row>(), boundaryRanges: Record<string, unknown>[] = [];
	const sourceHashes = new Map<number, string>();
	const runnable = (node: ts.Node): node is FunctionNode =>
		(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body !== undefined;
	const arithmeticLeaf = (node: FunctionNode): boolean => {
		if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || "asteriskToken" in node && node.asteriskToken !== undefined ||
			node.parameters.length === 0 || node.parameters.some(p => !ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken !== undefined)) return false;
		const parameters = new Set(node.parameters.map(p => p.name.getText(ast)));
		const arithmetic = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
			ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanLessThanToken,
			ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
			ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken]);
		const expression = (value: ts.Expression): boolean => ts.isParenthesizedExpression(value) ? expression(value.expression) :
			ts.isIdentifier(value) ? parameters.has(value.text) : ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) ? true :
			ts.isPrefixUnaryExpression(value) ? [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(value.operator) && expression(value.operand) :
			ts.isBinaryExpression(value) && arithmetic.has(value.operatorToken.kind) && expression(value.left) && expression(value.right);
		const body = node.body!;
		return ts.isBlock(body) ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!) &&
			body.statements[0].expression !== undefined && expression(body.statements[0].expression) : expression(body);
	};
	const locate = (node: ts.Node) => {
		const p = ast.getLineAndCharacterOfPosition(node.getStart(ast));
		const mapped = originalPositionFor(mapping, {line: p.line + 1, column: p.character});
		const index = mapped.source === null ? -1 : mapping.resolvedSources.indexOf(mapped.source);
		const contents = index < 0 ? undefined : mapping.sourcesContent?.[index];
		let sourceHash = sourceHashes.get(index);
		if (sourceHash === undefined) {sourceHash = contents == null ? inputHash : hash(contents); sourceHashes.set(index, sourceHash);}
		return {source: mapped.source ?? "<esbuild-generated>", sourceHash,
			sourceLine: mapped.line, sourceColumn: mapped.column, inputBundleLine: p.line + 1, inputBundleColumn: p.character + 1};
	};
	const bodyOwner = (node: ts.Node): Row | undefined => {
		for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
			const owner = owners.get(parent);
			if (owner !== undefined && runnable(parent) && node.pos >= parent.body!.pos && node.end <= parent.body!.end) return owner;
		}
		return undefined;
	};
	const collect = (node: ts.Node): void => {
		if (runnable(node)) {
			const position = locate(node), parent = bodyOwner(node);
			const name = "name" in node && node.name !== undefined ? node.name.getText(ast) :
				(ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) ? node.parent.name.getText(ast) :
				`anonymous@${position.inputBundleLine}:${position.inputBundleColumn}`;
			const key = `${position.sourceHash.slice(0, 16)}:${position.source}:${position.sourceLine ?? "generated"}:${position.sourceColumn ?? 0}:${node.getStart(ast)}`;
			const id = functions.length;
			const token = `__r8FullCall_${node.getStart(ast)}`;
			const row: Row = {id, key, name, kind: ts.SyntaxKind[node.kind], ...position, start: node.getStart(ast), end: node.end,
				token, async: node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
				generator: "asteriskToken" in node && node.asteriskToken !== undefined,
				vmCountOnly: false, clockCoverage: "body-entry-exit-and-await-wall",
				excluded: /(?:^|\/)(?:critical-observer|observation)\.ts$/u.test(position.source) ||
					/(?:^|\/)healthy-grid\.ts$/u.test(position.source) && name === "product",
				...(parent === undefined ? {} : {lexicalParentId: parent.id}),
				parametersPreBody: node.parameters.filter(p => p.initializer !== undefined).map(p => ({start: p.initializer!.getStart(ast), end: p.initializer!.end})),
				awaits: [], yields: [], returns: 0};
			row.vmCountOnly = clockedOwners && !row.excluded && /(?:^|\/)@noble\/hashes\//u.test(position.source) &&
				/^(?:rotr|Chi|Maj)\d*$/u.test(name) && arithmeticLeaf(node);
			if (row.excluded) row.clockCoverage = "observer-excluded";
			else if (row.vmCountOnly) row.clockCoverage = "vm-count-only: single synchronous arithmetic return over parameters; parent clock includes leaf; operator coercion/native execution opaque";
			owners.set(node, row); byId.set(id, row); functions.push(row);
		}
		if (ts.isClassStaticBlockDeclaration(node) || ts.isComputedPropertyName(node) || ts.isDecorator(node))
			boundaryRanges.push({kind: ts.SyntaxKind[node.kind], ...locate(node), start: node.getStart(ast), end: node.end,
				qualification: "Non-function execution; called functions are instrumented, raw execution belongs to enclosing body or module evaluation."});
		if (ts.isPropertyDeclaration(node) && node.initializer !== undefined)
			boundaryRanges.push({kind: "ClassFieldInitializer", ...locate(node), start: node.initializer.getStart(ast), end: node.initializer.end,
				qualification: "Implicit initializer execution; nested runnable function bodies are instrumented. V8 profile/coverage owns the implicit initializer frame."});
		if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && !node.members.some(ts.isConstructorDeclaration))
			boundaryRanges.push({kind: "ImplicitConstructor", ...locate(node), start: node.getStart(ast), end: node.end,
				qualification: "No source constructor body; V8 implicit constructor is an opaque engine frame."});
		if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && /^(?:eval|Function|WebAssembly(?:\.|$))/u.test(node.expression.getText(ast)))
			boundaryRanges.push({kind: "DynamicOrNativeCode", ...locate(node), start: node.getStart(ast), end: node.end,
				qualification: "Dynamically generated/native/WASM code is not statically present in the bundle; CPU/coverage must report it as opaque or unmapped."});
		ts.forEachChild(node, collect);
	};
	collect(ast);
	const f = ts.factory;
	const absent = () => f.createVoidExpression(f.createNumericLiteral(0));
	const globalCall = (name: string, args: readonly ts.Expression[]) => f.createCallExpression(
		f.createPropertyAccessExpression(f.createIdentifier("__r8FullCallGlobal"), `__r8Function${name}`), undefined, args);
	const token = (row: Row) => f.createIdentifier(row.token);
	const present = (row: Row) => f.createBinaryExpression(token(row), f.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken), absent());
	const statement = (name: string, row: Row, args: readonly ts.Expression[] = []) => f.createIfStatement(present(row),
		f.createExpressionStatement(globalCall(name, [token(row), ...args])));
	const returned = (row: Row, value: ts.Expression) => {
		const captured = f.createIdentifier(`${row.token}_return`);
		return f.createParenthesizedExpression(f.createCommaListExpression([
			f.createAssignment(captured, value),
			f.createConditionalExpression(present(row), undefined, globalCall("Returned", [token(row), captured]), undefined, captured),
		]));
	};
	const transformed = ts.transform(ast, [context => {
		const forAwait = (updated: ts.ForOfStatement, original: ts.Node, owner: Row, labels: readonly ts.Identifier[] = []): ts.Block => {
			const site = `${owner.id}:for-await:${original.getStart(ast)}`; owner.awaits.push(site);
			const body = ts.isBlock(updated.statement) ? [...updated.statement.statements] : [updated.statement];
			const resume = statement("ResumeOnError", owner), suspend = statement("Suspend", owner,
				[absent(), f.createStringLiteral("for-await"), f.createStringLiteral(site)]);
			let loop: ts.Statement = f.updateForOfStatement(updated, updated.awaitModifier, updated.initializer,
				globalCall("Suspend", [token(owner), updated.expression, f.createStringLiteral("for-await"), f.createStringLiteral(site)]),
				f.createBlock([resume, f.createTryStatement(f.createBlock(body, true), undefined, f.createBlock([suspend], true))], true));
			for (const label of [...labels].reverse()) loop = f.createLabeledStatement(label, loop);
			return f.createBlock([f.createTryStatement(f.createBlock([loop], true), undefined,
				f.createBlock([resume], true))], true);
		};
		const visit: ts.Visitor = node => {
			const owner = bodyOwner(node);
			if (owner !== undefined && !owner.excluded && ts.isLabeledStatement(node)) {
				const labels: ts.Identifier[] = [];
				let inner: ts.Statement = node;
				while (ts.isLabeledStatement(inner)) {labels.push(inner.label); inner = inner.statement;}
				if (ts.isForOfStatement(inner) && inner.awaitModifier !== undefined)
					return forAwait(ts.visitEachChild(inner, visit, context) as ts.ForOfStatement, inner, owner, labels);
			}
			if (runnable(node)) {
				const row = owners.get(node)!;
				if (row.excluded || row.vmCountOnly) return node;
				const updated = ts.visitEachChild(node, visit, context) as FunctionNode;
				const originalBody = updated.body!;
				let statements = ts.isBlock(originalBody) ? [...originalBody.statements] : [f.createReturnStatement(returned(row, originalBody))];
				if (!ts.isBlock(originalBody)) row.returns++;
				const directives: ts.Statement[] = [];
				while (statements[0] !== undefined && ts.isExpressionStatement(statements[0]) && ts.isStringLiteral(statements[0].expression))
					directives.push(statements.shift()!);
				const lexical = row.lexicalParentId === undefined ? undefined : byId.get(row.lexicalParentId);
				const flags = Number(row.async) + 2 * Number(row.generator);
				const enter = globalCall("Enter", [f.createNumericLiteral(row.id),
						lexical === undefined || lexical.excluded ? absent() : token(lexical),
						f.createNumericLiteral(flags)]);
				const entry = f.createVariableStatement(undefined, f.createVariableDeclarationList([
					f.createVariableDeclaration(row.token, undefined, undefined, flags !== 0 ? enter :
						f.createConditionalExpression(f.createBinaryExpression(f.createPropertyAccessExpression(
							f.createIdentifier("__r8FullCallGlobal"), "__r8FunctionWindowActive"), f.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
							f.createTrue()), undefined, enter, undefined, absent())),
				], ts.NodeFlags.Const));
				const returnLocal = row.returns === 0 ? [] : [f.createVariableStatement(undefined,
					f.createVariableDeclarationList([f.createVariableDeclaration(`${row.token}_return`)], ts.NodeFlags.Let))];
				const error = f.createIdentifier(`${row.token}_error`);
				const body = f.createBlock([...directives, entry, ...returnLocal, f.createTryStatement(f.createBlock([...statements,
					statement("Returned", row, [absent()])], true),
					f.createCatchClause(f.createVariableDeclaration(error), f.createBlock([
						statement("ResumeOnError", row), statement("Thrown", row, [error]), f.createThrowStatement(error),
					], true)), f.createBlock([statement("Exit", row)], true))], true);
				if (ts.isFunctionDeclaration(updated)) return f.updateFunctionDeclaration(updated, updated.modifiers, updated.asteriskToken, updated.name, updated.typeParameters, updated.parameters, updated.type, body);
				if (ts.isFunctionExpression(updated)) return f.updateFunctionExpression(updated, updated.modifiers, updated.asteriskToken, updated.name, updated.typeParameters, updated.parameters, updated.type, body);
				if (ts.isArrowFunction(updated)) return f.updateArrowFunction(updated, updated.modifiers, updated.typeParameters, updated.parameters, updated.type, updated.equalsGreaterThanToken, body);
				if (ts.isMethodDeclaration(updated)) return f.updateMethodDeclaration(updated, updated.modifiers, updated.asteriskToken, updated.name, updated.questionToken, updated.typeParameters, updated.parameters, updated.type, body);
				if (ts.isConstructorDeclaration(updated)) return f.updateConstructorDeclaration(updated, updated.modifiers, updated.parameters, body);
				if (ts.isGetAccessorDeclaration(updated)) return f.updateGetAccessorDeclaration(updated, updated.modifiers, updated.name, updated.parameters, updated.type, body);
				return f.updateSetAccessorDeclaration(updated as ts.SetAccessorDeclaration, updated.modifiers, updated.name, updated.parameters, body);
			}
			const updated = ts.visitEachChild(node, visit, context);
			if (owner === undefined || owner.excluded) {
				if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isForOfStatement(node) && node.awaitModifier !== undefined) boundaryRanges.push({kind: ts.SyntaxKind[node.kind], ...locate(node),
					start: node.getStart(ast), end: node.end, qualification: "Module/pre-body execution outside a runnable body; no function token exists."});
				return updated;
			}
			if (ts.isAwaitExpression(updated)) {
				const site = `${owner.id}:await:${node.getStart(ast)}`; owner.awaits.push(site);
				return globalCall("Resume", [token(owner), f.updateAwaitExpression(updated,
					globalCall("Suspend", [token(owner), updated.expression, f.createStringLiteral("await"), f.createStringLiteral(site)]))]);
			}
			if (ts.isForOfStatement(updated) && updated.awaitModifier !== undefined) {
				return forAwait(updated, node, owner);
			}
			if (ts.isYieldExpression(updated)) {
				const site = `${owner.id}:yield:${node.getStart(ast)}`, delegated = updated.asteriskToken !== undefined;
				owner.yields.push({id: site, delegated});
				return globalCall("Resume", [token(owner), f.updateYieldExpression(updated, updated.asteriskToken,
					globalCall("Suspend", [token(owner), updated.expression ?? absent(),
						f.createStringLiteral(delegated ? "yield*" : "yield"), f.createStringLiteral(site)]))]);
			}
			if (ts.isReturnStatement(updated)) {
				owner.returns++;
				return f.updateReturnStatement(updated, returned(owner, updated.expression ?? absent()));
			}
			if (ts.isCatchClause(updated)) return f.updateCatchClause(updated, updated.variableDeclaration,
				f.updateBlock(updated.block, [statement("ResumeOnError", owner), ...updated.block.statements]));
			if (ts.isTryStatement(updated) && updated.finallyBlock !== undefined) return f.updateTryStatement(updated,
				updated.tryBlock, updated.catchClause, f.updateBlock(updated.finallyBlock, [statement("ResumeOnError", owner), ...updated.finallyBlock.statements]));
			return updated;
		};
		return node => ts.visitNode(node, visit) as ts.SourceFile;
	}]);
	const bootstrap = `"use strict";\n// Diagnostic observer bootstrap: module evaluation precedes observer installation.\n` +
		`const __r8FullCallGlobal = globalThis;\n` +
		`globalThis.__r8FunctionManifestSize = ${functions.length};\n` +
		`globalThis.__r8FunctionEnter ??= function(){return undefined;};\n` +
		`globalThis.__r8FunctionSuspend ??= function(_token,value){return value;};\n` +
		`globalThis.__r8FunctionResume ??= function(_token,value){return value;};\n` +
		`globalThis.__r8FunctionReturned ??= function(_token,value){return value;};\n` +
		`globalThis.__r8FunctionResumeOnError ??= function(){};\n` +
		`globalThis.__r8FunctionThrown ??= function(){};\n` +
		`globalThis.__r8FunctionExit ??= function(){};\n`;
	const code = bootstrap + ts.createPrinter({newLine: ts.NewLineKind.LineFeed}).printFile(transformed.transformed[0] as ts.SourceFile);
	transformed.dispose();
	const output = ts.createSourceFile("entry.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	if ((output as ts.SourceFile & {parseDiagnostics: readonly unknown[]}).parseDiagnostics.length !== 0)
		throw Error("FULL_FUNCTION_CALLS_OUTPUT_PARSE_REFUSED");
	let entries = 0, outputFunctions = 0;
	const audit = (node: ts.Node): void => {
		if (runnable(node)) {
			outputFunctions++;
			// The transform creates no runnable bodies except the seven leading
			// bootstrap no-ops. Preorder therefore binds ALL original bodies,
			// including explicit VM-only/excluded bodies, to final exact ranges.
			if (outputFunctions > 7) {
				const row = functions[outputFunctions - 8];
				if (row === undefined || row.kind !== ts.SyntaxKind[node.kind]) throw Error("FULL_FUNCTION_CALLS_FINAL_BODY_ORDER_DIFFERS");
				const start = node.getStart(output), p = output.getLineAndCharacterOfPosition(start);
				row.generatedFunctionStart = start; row.generatedFunctionEnd = node.end;
				row.generatedFunctionLine = p.line + 1; row.generatedFunctionColumn = p.character + 1;
			}
		}
		if (ts.isCallExpression(node) && node.expression.getText(output) === "__r8FullCallGlobal.__r8FunctionEnter") {
			const id = node.arguments[0];
			const row = id !== undefined && ts.isNumericLiteral(id) ? byId.get(Number(id.text)) : undefined;
			if (row === undefined || row.excluded || row.vmCountOnly || row.generatedFinalLine !== undefined) throw Error("FULL_FUNCTION_CALLS_OUTPUT_ENTRY_NOT_UNIQUE");
			const p = output.getLineAndCharacterOfPosition(node.getStart(output));
			row.generatedFinalLine = p.line + 1; row.generatedFinalColumn = p.character + 1; entries++;
			let owner: ts.Node | undefined = node.parent;
			while (owner !== undefined && !runnable(owner)) owner = owner.parent;
			if (owner === undefined) throw Error("FULL_FUNCTION_CALLS_FINAL_ENTRY_OWNER_MISSING");
			if (row.generatedFunctionStart !== owner.getStart(output) || row.generatedFunctionEnd !== owner.end)
				throw Error("FULL_FUNCTION_CALLS_FINAL_ENTRY_OWNER_DIFFERS");
		}
		ts.forEachChild(node, audit);
	};
	audit(output);
	if (entries !== functions.filter(row => !row.excluded && !row.vmCountOnly).length) throw Error("FULL_FUNCTION_CALLS_BODY_COVERAGE_INCOMPLETE");
	if (outputFunctions !== functions.length + 7) throw Error("FULL_FUNCTION_CALLS_FINAL_BODY_CENSUS_DIFFERS");
	return {code, sourceMap, manifest: {version: 2, inputHash, outputHash: hash(code), eligibleFunctions: entries,
		coverageMode: clockedOwners ? "vm-all-clocked-owners" : "full-body-clocks", eligibleProductFunctions: functions.filter(row => !row.excluded).length,
		vmCountOnlyFunctions: functions.filter(row => row.vmCountOnly).length,
		excludedObserverFunctions: functions.filter(row => row.excluded).length, excludedBootstrapFunctions: 7, functions, boundaryRanges,
		qualification: "All final-bundle runnable bodies enumerated for VM precise call counts, including dependencies/generated helpers. Clocked-owner mode explicitly leaves selected syntax-only arithmetic hash leaves VM-count-only; their time belongs to the clocked parent, not a separately clocked leaf. This is not a numeric-type/purity proof. Observer runtime excluded. Parameters execute before body entry. yield* is one opaque delegation interval. Native builtins remain CPU-profile opaque. Original inline map saved separately; output has no stale source map. Source locations/hash identify esbuild's phase-observed inputs; original raw source pins are preserved in the existing archive."}};
}
function observation(directory: string, classificationFault = false, pendingPublication = false): Plugin {
	return {
		name: "startup-room-effect-entry-observation",
		setup(context): void {
			context.onLoad(
				{
					filter: classificationFault
						? /packages\/node\/src\/internal\/creator-closed-rollback-data\.ts$/
						: pendingPublication
							? /(?:packages\/node\/src\/(?:v3-room|v3-live|creator-adoption|creator-adoption-stage|creator-adoption-activate|creator-adoption-recover)|examples\/v3-room\/src\/index)\.ts$/
							: criticalProfiling
								? /(?:packages\/[^/]+\/(?:dist\/)?src\/.*|examples\/[^/]+\/src\/.*|tests\/fixtures\/.*)\.(?:ts|js)$/
								: originalObservationPath,
				},
				({ path }) => {
					if(!criticalProfiling && (/\/packages\/(?:canonical|protocol-v3|compaction|storage)\//u.test(path) || /\/internal\/(?:creator-snapshot-data|creator-transition-advance)\.ts$/u.test(path)))return undefined;
					if(!criticalProfiling&&/\/packages\/storage-browser\/.*\/(?:live-journal|snapshot-transfer|idb-adapter|native-read-reservation)\.(?:ts|js)$/u.test(path))return undefined;
					const raw = readFileSync(path, "utf8"),
						ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
					const codecSites = criticalProfiling ? canonicalCallsites(ast, path) : [];
					if (criticalProfiling && !originalObservationPath.test(path) && !path.endsWith("/packages/seal/src/creator.ts")) {
						const edits: ObservationInsertion[] = [];
						addCanonicalCallsites(codecSites, edits);
						if(/\/packages\/storage-browser\/(?:dist\/)?src\/internal\/retirement-control\.(?:ts|js)$/u.test(path)){
						 const load=ast.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="loadBrowserBoundedReadRequest");
						 if(load.length!==1||!load[0]!.body)throw Error("CRITICAL_NATIVE_CENSUS_LOADER_NOT_UNIQUE");
						 edits.push({offset:load[0]!.body!.getStart(ast)+1,text:'(globalThis as any).__warmMetricCount?.("native-ahe-census-request:"+request.kind);'});
						 const gets:ts.CallExpression[]=[];const visitGets=(node:ts.Node):void=>{
						  if(ts.isCallExpression(node)&&node.expression.getText(ast)==="transaction.objectStore(PHASE_2D_BLOBS_STORE).get")gets.push(node);
						  ts.forEachChild(node,visitGets);
						 };visitGets(load[0]!);
						 if(gets.length!==2)throw Error("CRITICAL_NATIVE_CENSUS_BLOB_GET_SEAMS_CHANGED");
						 for(const get of gets)edits.push({offset:get.getStart(ast),text:'((globalThis as any).__warmMetricCount?.("native-ahe-census-actual-blob-get"),'},{offset:get.end,text:")"});
						}
						if(path.endsWith("/examples/grid/src/zone-state.js")){
						 const nodes:ts.Node[]=[];const visit=(node:ts.Node):void=>{nodes.push(node);ts.forEachChild(node,visit);};visit(ast);
						 const owners=nodes.filter((node):node is ts.VariableDeclaration=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==="includeOperation"&&node.initializer!==undefined&&ts.isArrowFunction(node.initializer));
						 if(owners.length!==1||!ts.isArrowFunction(owners[0]!.initializer!))throw new Error("CRITICAL_GRID_RESOURCE_DECLINE_OWNER_CHANGED");
						 const owner=owners[0]!.initializer as ts.ArrowFunction;
						 const returns=nodes.filter((node):node is ts.ReturnStatement=>ts.isReturnStatement(node)&&node.expression?.getText(ast)==="false"&&node.pos>owner.pos&&node.end<owner.end);
						 const vectors=nodes.filter((node):node is ts.ReturnStatement=>ts.isReturnStatement(node)&&node.expression?.getText(ast)==="undefined"&&ts.isIfStatement(node.parent)&&
						  ["!includeOperation(operation, includeBlock, includeRoster)","!includeOperation(operation, addBlock, addRoster)"].includes(node.parent.expression.getText(ast)));
						 if(returns.length!==5||vectors.length!==2)throw new Error("CRITICAL_GRID_RESOURCE_DECLINE_SITES_CHANGED");
						 const source=path.slice(root.length+1),sourceHash=hash(raw);
						 for(const [index,part] of returns.entries()){
						  const line=ast.getLineAndCharacterOfPosition(part.getStart(ast)).line+1;
						  edits.push({offset:part.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"application-resource-decline",source:${JSON.stringify(source)},sourceHash:${JSON.stringify(sourceHash)},site:${JSON.stringify("grid-include-operation-false-"+index)},line:${line},actionCategory:operation!==null&&typeof operation==="object"&&typeof operation.action==="string"?operation.action.slice(0,64):"non-string-or-non-object"});}catch{} `},{offset:part.end,text:"}"});
						 }
						 for(const part of vectors){
						  const line=ast.getLineAndCharacterOfPosition(part.getStart(ast)).line+1,full=part.parent.getText(ast).includes("includeBlock, includeRoster");
						  edits.push({offset:part.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"application-resource-decline",source:${JSON.stringify(source)},sourceHash:${JSON.stringify(sourceHash)},site:"grid-operation-vector-unsupported",line:${line},vectorCategory:${full?'group===groups[0]?"current":group===groups[1]?"protected":"recovery"':'"incremental-prepare"'}});}catch{} `},{offset:part.end,text:"}"});
						 }
						}
						if(edits.length===0)return undefined;
						const code = applyObservationInsertions(raw, edits), label = path.replaceAll("/", "_");
						writeFileSync(join(directory, label + ".raw"), raw, {flag:"wx"});
						writeFileSync(join(directory, label + ".observed"), code, {flag:"wx"});
						writeFileSync(join(directory, label + ".insertions.json"), JSON.stringify(edits), {flag:"wx"});
						writeFileSync(join(directory, label + ".canonical-callsite-manifest.json"), JSON.stringify({
							sourceHash: hash(raw), source: path.startsWith(root+"/")?path.slice(root.length+1):path, count: codecSites.length, sites: codecSites,
							qualification:"Static decode/encode callee callsites only; existing synchronous codec metrics retain original counts/bytes/time. No asynchronous causal attribution."}), {flag:"wx"});
						return {contents:code, loader:"ts", resolveDir:dirname(path)};
					}
					if (classificationFault) {
						const offsets: number[] = [];
						const visit = (node: ts.Node): void => {
							if (
								ts.isExpressionStatement(node) &&
								node.getText(ast) === 'requireLaw(receipt.retiredScopes.length === 0, "snapshot-invalid");'
							)
								offsets.push(node.end);
							ts.forEachChild(node, visit);
						};
						visit(ast);
						if (offsets.length !== 1) throw new Error("STARTUP_MIGRATION_POST_APPLY_FAULT_SEAM_NOT_UNIQUE");
						const offset = requireValue(offsets[0], "unique classification offset absent");
						const text =
							'\nif (source.inheritedClassification?.phase === "apply" && Reflect.get(globalThis, "__r8MigrationFault") === "after-apply") { Reflect.deleteProperty(globalThis, "__r8MigrationFault"); Reflect.set(globalThis, "__r8MigrationFaultCount", 1); throw new Error("R8_NATIVE_CLASSIFICATION_AFTER_APPLY_INTERRUPTION"); }';
						const code = raw.slice(0, offset) + text + raw.slice(offset),
							label = "creator-closed-rollback-data.ts";
						writeFileSync(join(directory, label + ".raw"), raw, { flag: "wx" });
						writeFileSync(join(directory, label + ".observed"), code, { flag: "wx" });
						writeFileSync(join(directory, label + ".insertions.json"), JSON.stringify([{ offset, text }]), {
							flag: "wx",
						});
						return { contents: code, loader: "ts", resolveDir: dirname(path) };
					}
					const insertions: ObservationInsertion[] = [
						{
							offset: 0,
							text: `import {event as __startupEvent, control as __startupControl} from ${JSON.stringify(observer)};\n`,
						},
					];
					const criticalSites:Record<string,number>={};
					if (criticalProfiling && /\/packages\/canonical\/(?:dist\/)?src\/internal\/codec\.(?:ts|js)$/u.test(path)) {
						insertions.push(...canonicalCaptureObservationInsertions(ast));
						criticalSites["canonical-capture-counters"] = 1;
					}
					if (finishingEnvelopeShadow && path.endsWith("/internal/creator-closed-rollback-data.ts")) {
						const owners = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "readProspectiveCreatorMaintenancePrefixesForSizing");
						if (owners.length !== 1 || owners[0]?.body === undefined) throw new Error("FINISHING_ENVELOPE_SHADOW_OWNER_NOT_UNIQUE");
						const body = owners[0].body;
						const initialStatements = body.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) &&
							node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "result" &&
								declaration.initializer !== undefined && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === "composeProspectiveCreatorMaintenancePrefixesForSizing"));
						const finalReturns = body.statements.filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node) && node.expression?.getText(ast) === "result");
						const fitBranches = body.statements.filter((node): node is ts.IfStatement => ts.isIfStatement(node) &&
							node.expression.getText(ast) === "result.ok && result.capacityEnvelope === true" && ts.isBlock(node.thenStatement));
						if (initialStatements.length !== 1 || finalReturns.length !== 1 || fitBranches.length !== 1)
							throw new Error("FINISHING_ENVELOPE_SHADOW_SELECTED_RESULT_NOT_UNIQUE");
						const initial = requireValue(initialStatements[0], "shadow initial result absent");
						const declaration = requireValue(initial.declarationList.declarations.find(node => ts.isIdentifier(node.name) && node.name.text === "result"), "shadow result declaration absent");
						const call = declaration.initializer, fitBranch = requireValue(fitBranches[0], "shadow I branch absent");
						const fallbackReturns: ts.ReturnStatement[] = [], composeCalls: ts.CallExpression[] = [], laterAwaits: ts.AwaitExpression[] = [];
						const inspect = (node: ts.Node): void => {
							if (ts.isCallExpression(node) && node.expression.getText(ast) === "composeProspectiveCreatorMaintenancePrefixesForSizing") composeCalls.push(node);
							if (ts.isAwaitExpression(node) && node.getStart(ast) > initial.getStart(ast)) laterAwaits.push(node);
							if (ts.isReturnStatement(node) && node.expression !== undefined && ts.isCallExpression(node.expression) &&
								node.expression.expression.getText(ast) === "composeProspectiveCreatorMaintenancePrefixesForSizing") fallbackReturns.push(node);
							ts.forEachChild(node, inspect);
						};
						inspect(body);
						const fallback = fallbackReturns[0], fallbackCall = fallback?.expression;
						if (call === undefined || !ts.isCallExpression(call) || call.arguments.length !== 9 ||
							call.arguments[0]?.getText(ast) !== "input" || call.arguments[7]?.getText(ast) !== "syntax" ||
							call.arguments[8]?.getText(ast) !== "conservativeCurrentFuture" || composeCalls.length !== 2 || laterAwaits.length !== 0 ||
							fallbackReturns.length !== 1 || fallback === undefined || fallbackCall === undefined || !ts.isCallExpression(fallbackCall) ||
							fallbackCall.arguments.length !== 9 || fallbackCall.arguments[8]?.getText(ast) !== "false" ||
							call.arguments.slice(0, 8).some((argument, index) => argument.getText(ast) !== fallbackCall.arguments[index]?.getText(ast)) ||
							!ts.isIfStatement(fallback.parent) || fallback.parent.expression.getText(ast) !== "!fit || total > input.proof.accounting.maxBytes" ||
							fallback.getStart(ast) <= fitBranch.thenStatement.getStart(ast) || fallback.end >= fitBranch.thenStatement.end ||
							requireValue(finalReturns[0], "shadow final result absent").getStart(ast) < fitBranch.end)
							throw new Error("FINISHING_ENVELOPE_SHADOW_ARGUMENT_OR_I_SELECTION_CHANGED");
						// Insertion-only NON-ACCEPTANCE diagnostic: capture the actual
						// initial call's arguments once. Preserve the complete original
						// ordinary-I projection/fallback and observe BOTH selected returns.
						insertions.push({offset: initial.getStart(ast), text: "let __finishingShadowArgs!: Parameters<typeof composeProspectiveCreatorMaintenancePrefixesForSizing>;\n"},
							{offset: requireValue(call.arguments[0], "shadow first argument absent").getStart(ast), text: "...(__finishingShadowArgs = ["},
							{offset: requireValue(call.arguments[8], "shadow last argument absent").end, text: "])"});
						insertions.push({offset: initial.end, text: `
 const __finishingExactArgs: Parameters<typeof composeProspectiveCreatorMaintenancePrefixesForSizing> = [...__finishingShadowArgs];
 __finishingExactArgs[7] = createCreatorMaintenanceSizingSyntax();
 __finishingExactArgs[8] = false;
 let __finishingExact: ReturnType<typeof composeProspectiveCreatorMaintenancePrefixesForSizing>;
 try {
  __finishingExact = composeProspectiveCreatorMaintenancePrefixesForSizing(...__finishingExactArgs);
 } catch (__finishingCause) {
  __startupEvent("maintenance-finishing-envelope-shadow", {diagnosticOnly:true,returnedPath:"exact",evaluation:"exact",thrown:String(__finishingCause)});
  throw __finishingCause;
 }
 const __finishingLengths = (values: readonly number[]) => {
  let sum=0,maximum=0;
  for (const value of values) {
   if (!Number.isSafeInteger(value) || value<0 || !Number.isSafeInteger(sum+value)) throw new TypeError("FINISHING_ENVELOPE_SHADOW_INVALID_LENGTH_VECTOR");
   sum+=value; maximum=Math.max(maximum,value);
  }
  return {count:values.length,lengths:[...values],sum,maximum};
 };
 const __finishingDescribe = (value: ReturnType<typeof composeProspectiveCreatorMaintenancePrefixesForSizing>) => value.ok ? {
  ok:true,capacityEnvelope:value.capacityEnvelope===true, unknown:__finishingLengths(value.unknownEncodedLengths), fullFuture:__finishingLengths(value.fullFutureProofEnvelopeByteLengths),
  knownCount:value.knownCarriers.length, known:value.knownCarriers.map((bytes,index)=>({index,length:bytes.byteLength,digest:closedRetirementDigest("ts-drp/test-finishing-envelope-shadow/v1",bytes)}))
 } : {ok:false,reason:value.reason};
 const __finishingCompare = (candidate: ReturnType<typeof composeProspectiveCreatorMaintenancePrefixesForSizing>) => {
 const violations: string[] = [], knownCoverage: {exactIndex:number;candidateIndex:number}[] = [];
 if (candidate.ok && !__finishingExact.ok) violations.push("FAST_ACCEPTS_EXACT_REFUSAL");
 if (candidate.ok && __finishingExact.ok) {
  // Unknowns are complete occurrence sums: no content equality/refund.
  if (__finishingLengths(candidate.unknownEncodedLengths).sum < __finishingLengths(__finishingExact.unknownEncodedLengths).sum) violations.push("UNKNOWN_SUM_UNDERBOUND");
  if (__finishingLengths(candidate.fullFutureProofEnvelopeByteLengths).maximum < __finishingLengths(__finishingExact.fullFutureProofEnvelopeByteLengths).maximum) violations.push("FULL_FUTURE_MAXIMUM_UNDERBOUND");
  for (const [exactIndex,bytes] of __finishingExact.knownCarriers.entries()) {
   const candidateIndex=candidate.knownCarriers.findIndex(carrier=>compareBytes(carrier,bytes)===0);
   knownCoverage.push({exactIndex,candidateIndex});
   if (candidateIndex<0) violations.push("EXACT_KNOWN_CARRIER_MISSING:"+exactIndex);
  }
 }
 return {violations,knownCoverage};
 };
 const __finishingSelect = (selected: ReturnType<typeof composeProspectiveCreatorMaintenancePrefixesForSizing>, selection: "initial-result" | "ordinary-I-exact-fallback"): ReturnType<typeof composeProspectiveCreatorMaintenancePrefixesForSizing> => {
 const rawComparison=__finishingCompare(result), selectedComparison=__finishingCompare(selected);
 const capacityMatch=__finishingExact.ok ? null : /^MAINTENANCE_(?:NATIVE_IMAGE|FUTURE_PROOF_ENVELOPE)_EXHAUSTED:(\\d+)\\/(\\d+)$/u.exec(__finishingExact.reason);
 const numericCapacityRefusal=capacityMatch!==null && Number.isSafeInteger(Number(capacityMatch[1])) &&
  Number.isSafeInteger(Number(capacityMatch[2])) && Number(capacityMatch[1])>Number(capacityMatch[2]) && Number(capacityMatch[2])>0;
 const rawCapacityInconclusive=result.ok && !__finishingExact.ok && numericCapacityRefusal && selection==="ordinary-I-exact-fallback" && !selected.ok && selected.reason===__finishingExact.reason;
 const rawAuditViolations=rawComparison.violations.filter(violation=>!(rawCapacityInconclusive && violation==="FAST_ACCEPTS_EXACT_REFUSAL"));
 const enforcedViolations=[...new Set([...selectedComparison.violations,...rawAuditViolations.map(violation=>"RAW:"+violation)])];
 if (!selected.ok && !__finishingExact.ok && selected.reason!==__finishingExact.reason) enforcedViolations.push("SELECTED_EXACT_REFUSAL_IDENTITY");
 __startupEvent("maintenance-finishing-envelope-shadow", {
  diagnosticOnly:true,returnedPath:"exact",selection,owner:(globalThis as any).__warmProofIdentity?.(input.proof.accounting),
  epoch:facts.forward.currentTrust.currentEpoch,preclose:__finishingShadowArgs[2],adoptionDrain:__finishingShadowArgs[5],candidateFlag:__finishingShadowArgs[8],
  unsignedLength:input.exactCanonicalUnsignedVertexBytes.byteLength,unsignedDigest:closedRetirementDigest("ts-drp/test-finishing-envelope-shadow-input/v1",input.exactCanonicalUnsignedVertexBytes),
  rawCandidate:__finishingDescribe(result),rawComparison,selectedCandidate:__finishingDescribe(selected),selectedComparison,exact:__finishingDescribe(__finishingExact),
  rawCapacityInconclusive,numericCapacityRefusal,enforcedViolations,
  diagnosticOutcome:enforcedViolations.length!==0 ? "abort-for-audit" : rawCapacityInconclusive ? "raw-capacity-inconclusive" : !selected.ok && __finishingExact.ok ? "candidate-refusal-exact-acceptance-inconclusive" : selected.ok && __finishingExact.ok ? "vector-dominance-only" : "refusal-agreement-only",
  refusalMismatch:selected.ok!==__finishingExact.ok,
  qualification:"Synchronous same-held detached quote basis, fresh exact syntax. Original ordinary-I fit/fallback executes intact before selected-return comparison. Raw underbounds and raw structural/source/codec/progress refusals abort even on fallback. Only a named numeric capacity refusal with a selected exact refusal is inconclusive, never fast PASS. No native/network write or proof charge; no unknown equality credit. Double evaluation is NOT performance or candidate acceptance. Every selected fast acceptance over exact refusal aborts for owner audit."
 });
 if (enforcedViolations.length!==0) throw new TypeError("FINISHING_ENVELOPE_SHADOW_REFUSED:"+enforcedViolations.join(","));
 return __finishingExact;
 };
`});
						for (const [statement, selection] of [[fallback, "ordinary-I-exact-fallback"], [requireValue(finalReturns[0], "shadow final result absent"), "initial-result"]] as const) {
							const expression = requireValue(statement.expression, "shadow selected expression absent");
							insertions.push({offset: expression.getStart(ast), text: "__finishingSelect("}, {offset: expression.end, text: `, ${JSON.stringify(selection)})`});
						}
						// Observe only actual widening exits and original fallback choices.
						// Comma stage markers preserve short-circuiting: no comparison,
						// codec, sizing branch or native read is evaluated a second time.
						const widenOwners = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "widenProspectiveMaintenanceCapacityControls");
						const composeOwners = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "composeProspectiveCreatorMaintenancePrefixesForSizing");
						if (widenOwners.length !== 1 || composeOwners.length !== 1 || widenOwners[0]?.body === undefined || composeOwners[0]?.body === undefined)
							throw new Error("FINISHING_ENVELOPE_SHADOW_CAPACITY_OWNERS_NOT_UNIQUE");
						const widenBody = widenOwners[0].body, composeBody = composeOwners[0].body;
						const descendants = (owner: ts.Node): ts.Node[] => {
							const nodes: ts.Node[] = [];
							const collect = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, collect); };
							collect(owner); return nodes;
						};
						const widenNodes = descendants(widenBody), composeNodes = descendants(composeBody);
						const undefinedReturns = widenNodes.filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node) && node.expression?.getText(ast) === "undefined");
						const anonymousCatches = widenNodes.filter((node): node is ts.CatchClause => ts.isCatchClause(node) && node.variableDeclaration === undefined);
						const initialGuards = widenNodes.filter((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(ast).startsWith("next.participants.length !== 4 ||"));
						const contextGuards = widenNodes.filter((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(ast).startsWith("!sameMaintenanceCapacityData(base.generations, next.generations) ||"));
						const helpers = new Map<string, ts.ArrowFunction>();
						for (const node of widenNodes) if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
							["child", "protectedCompletion", "counter"].includes(node.name.text) && node.initializer !== undefined && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
							if (helpers.has(node.name.text)) throw new Error("FINISHING_ENVELOPE_SHADOW_CAPACITY_HELPER_NOT_UNIQUE");
							helpers.set(node.name.text, node.initializer);
						}
						const participantCallbacks = widenNodes.filter((node): node is ts.ArrowFunction => ts.isArrowFunction(node) && ts.isBlock(node.body) &&
							node.parameters.map(parameter => parameter.name.getText(ast)).join(",") === "old,index" && ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === "a.map");
						if (undefinedReturns.length !== 3 || anonymousCatches.length !== 1 || initialGuards.length !== 1 || contextGuards.length !== 1 || helpers.size !== 3 || participantCallbacks.length !== 1)
							throw new Error("FINISHING_ENVELOPE_SHADOW_CAPACITY_EXIT_SHAPE_CHANGED");
						const widenCatch = requireValue(anonymousCatches[0], "capacity catch absent");
						const initialGuard = requireValue(initialGuards[0], "capacity initial guard absent"), contextGuard = requireValue(contextGuards[0], "capacity context guard absent");
						const orOperands = (expression: ts.Expression): ts.Expression[] => ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
							? [...orOperands(expression.left), ...orOperands(expression.right)] : [expression];
						const initialOperands = orOperands(initialGuard.expression), contextOperands = orOperands(contextGuard.expression);
						if (initialOperands.length !== 2 || initialOperands[0]?.getText(ast) !== "next.participants.length !== 4" ||
							!initialOperands[1]?.getText(ast).startsWith("!next.signingPhysicalRows.every") || contextOperands.length !== 7 ||
							contextOperands.map(node => node.getText(ast)).join("|") !== '!sameMaintenanceCapacityData(base.generations, next.generations)|!sameMaintenanceCapacityData(base.signingProtection, next.signingProtection)|!exactExcept(base.floor, next.floor, ["revision"])|!exactExcept(base.ahe, next.ahe, ["revision", "sequence", "completed"])|base.ahe.active !== null|next.ahe.active !== null|(base.ahe.completed == null) !== (next.ahe.completed == null)')
							throw new Error("FINISHING_ENVELOPE_SHADOW_CAPACITY_PREDICATES_CHANGED");
						insertions.push({offset: widenBody.getStart(ast) + 1, text: `
 let __finishingWidenCategory="initialshape/PRE", __finishingParticipantIndex: number | undefined;
 let __finishingCompletionPresence: {leftNull:boolean;rightNull:boolean;leftAbsent:boolean;rightAbsent:boolean} | undefined;
 const __finishingWidenTrace=(outcome:string,caughtMessage?:string)=>__startupEvent("maintenance-finishing-envelope-capacity-diagnostic",{
  diagnosticOnly:true,phase:"widen-exit",outcome,category:__finishingWidenCategory,caughtMessage,
  previousPresent:previous!==undefined,participantCount:next.participants.length,participantIndex:__finishingParticipantIndex,
  completionPresence:__finishingCompletionPresence,completeSigningPreCount:completeSigningPre.length,
  residualSigningPreCount:next.signingPhysicalRows.length,generationCount:next.generations.length,
  qualification:"Original short-circuit predicates and caught cause only; scalar/null presence, no repeated validation or carrier bytes."
 });
`});
						for (const [operands, categories] of [[initialOperands, ["initialshape", "PRE"]], [contextOperands, ["generationrows", "signingProtection", "floorcontext", "AHEcontext", "AHEcontext", "AHEcontext", "AHEpresence"]]] as const)
							for (const [index, expression] of operands.entries()) insertions.push({offset: expression.getStart(ast), text: `(__finishingWidenCategory=${JSON.stringify(categories[index])},`}, {offset: expression.end, text: ")"});
						for (const [name, category] of [["child", "childcodec"], ["protectedCompletion", "protectedCompletion"], ["counter", "counter"]] as const) {
							const helperBody = requireValue(helpers.get(name), "capacity helper absent").body;
							insertions.push({offset: helperBody.getStart(ast) + 1, text: `__finishingWidenCategory=${JSON.stringify(category)};`});
						}
						const participantBody = requireValue(participantCallbacks[0], "capacity participant callback absent").body;
						if (!ts.isBlock(participantBody)) throw new Error("FINISHING_ENVELOPE_SHADOW_PARTICIPANT_BODY_CHANGED");
						const nextStatements = participantBody.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "next" && declaration.initializer?.getText(ast) === "b[index]"));
						if (nextStatements.length !== 1) throw new Error("FINISHING_ENVELOPE_SHADOW_PARTICIPANT_CAPTURE_CHANGED");
						insertions.push({offset: requireValue(nextStatements[0], "capacity participant next absent").end, text: `
 __finishingWidenCategory="participantcontext";__finishingParticipantIndex=index;
 __finishingCompletionPresence={leftNull:old.completed===null,rightNull:next?.completed===null,leftAbsent:old.completed===undefined,rightAbsent:next?.completed===undefined};
`});
						insertions.push({offset: widenCatch.getStart(ast) + "catch".length, text: " (__finishingWidenCause)"});
						for (const statement of undefinedReturns) {
							const caught = statement.getStart(ast) > widenCatch.block.getStart(ast) && statement.end < widenCatch.block.end;
							insertions.push({offset: statement.getStart(ast), text: caught ? '{__finishingWidenTrace("caught-undefined",__finishingWidenCause instanceof Error ? __finishingWidenCause.message : String(__finishingWidenCause));' : '{__finishingWidenTrace("guard-undefined");'}, {offset: statement.end, text: "}"});
						}
						const outputReturns = widenBody.statements.filter(ts.isTryStatement).flatMap(node => node.tryBlock.statements.filter((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && statement.expression?.getText(ast) === "output"));
						const finalControlCodecs = widenNodes.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.getText(ast) === "maintenanceEncodedWidth(maintenanceCanonicalWidth(control))");
						if (outputReturns.length !== 1 || finalControlCodecs.length !== 1) throw new Error("FINISHING_ENVELOPE_SHADOW_CAPACITY_OUTPUT_NOT_UNIQUE");
						const finalControlCodec = requireValue(finalControlCodecs[0], "capacity final codec absent");
						insertions.push({offset: finalControlCodec.getStart(ast), text: '(__finishingWidenCategory="childcodec",'}, {offset: finalControlCodec.end, text: ")"});
						insertions.push({offset: requireValue(outputReturns[0], "capacity output absent").getStart(ast), text: '__finishingWidenTrace("bounded-tuple");'});
						const exactFallbacks = composeNodes.filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node) && node.expression?.getText(ast) === "exact()");
						const incompleteFallbacks = composeNodes.filter((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(ast) === "(!complete || result === undefined) && preclose && conservativeCurrentFuture && !adoptionDrain");
						if (exactFallbacks.length !== 2 || incompleteFallbacks.length !== 1 || !ts.isReturnStatement(incompleteFallbacks[0]!.thenStatement))
							throw new Error("FINISHING_ENVELOPE_SHADOW_COMPOSER_FALLBACKS_CHANGED");
						const fallbackChoices: [ts.ReturnStatement, string, string][] = [[incompleteFallbacks[0]!.thenStatement, "current-alternative-refusal", "undefined"]];
						for (const statement of exactFallbacks) {
							if (!ts.isIfStatement(statement.parent)) throw new Error("FINISHING_ENVELOPE_SHADOW_COMPOSER_FALLBACK_PARENT_CHANGED");
							const predicate = statement.parent.expression.getText(ast);
							if (predicate === "capacityInconclusive || widenedContinuation === undefined") fallbackChoices.push([statement, "capacity-tuple-unavailable", "undefined"]);
							else if (predicate === "!future.ok") fallbackChoices.push([statement, "future-refusal", "future.reason"]);
							else throw new Error("FINISHING_ENVELOPE_SHADOW_COMPOSER_FALLBACK_PREDICATE_CHANGED");
						}
						for (const [statement, category, futureReason] of fallbackChoices) insertions.push({offset: statement.getStart(ast), text: `{__startupEvent("maintenance-finishing-envelope-capacity-diagnostic",{diagnosticOnly:true,phase:"composer-fallback",category:${JSON.stringify(category)},epoch:facts.forward.currentTrust.currentEpoch,preclose,adoptionDrain,conservativeCurrentFuture,complete,resultPresent:result!==undefined,capacityInconclusive,boundedTuplePresent:widenedContinuation!==undefined,refusedBranch,futureReason:${futureReason}});`}, {offset: statement.end, text: "}"});
					}
					if(criticalProfiling){
						if(path.endsWith("/creator-closed-rollback-data.ts")){
						 const materialOwner=ast.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="creatorOrdinaryApplicationResourceMaterialForSizing")
						  ?"creatorOrdinaryApplicationResourceMaterialForSizing":"creatorOrdinaryApplicationResourceInput";
						 const owner=ast.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===materialOwner);
						 if(owner.length!==1||owner[0]!.body===undefined)throw new Error("CRITICAL_APPLICATION_INPUT_DECLINE_OWNER_CHANGED");
						 const nodes:ts.Node[]=[];const visit=(node:ts.Node):void=>{nodes.push(node);ts.forEachChild(node,visit);};visit(owner[0]!.body!);
						 const direct=nodes.filter((node):node is ts.ReturnStatement=>{
						  if(!ts.isReturnStatement(node)||node.expression?.getText(ast)!=="undefined")return false;
						  let parent:ts.Node|undefined=node.parent;while(parent&&!ts.isFunctionDeclaration(parent)&&!ts.isArrowFunction(parent)&&!ts.isFunctionExpression(parent))parent=parent.parent;
						  return parent===owner[0];
						 });
						 const terminal=owner[0]!.body!.statements.find(ts.isTryStatement)?.catchClause;
						 if(direct.length!==16||terminal===undefined||terminal.variableDeclaration!==undefined||terminal.block.statements.length!==1||!ts.isReturnStatement(terminal.block.statements[0]))throw new Error("CRITICAL_APPLICATION_INPUT_DECLINE_SITES_CHANGED");
						 const source=path.slice(root.length+1),sourceHash=hash(raw);
						 insertions.push({offset:terminal.getStart(ast)+"catch".length,text:" (__applicationInputError)"});
						 for(const [index,part] of direct.entries()){
						  const line=ast.getLineAndCharacterOfPosition(part.getStart(ast)).line+1,caught=part.parent===terminal.block;
						  const ownMessage=caught?'const descriptor=__applicationInputError!==null&&typeof __applicationInputError==="object"?Object.getOwnPropertyDescriptor(__applicationInputError,"message"):undefined;const message=descriptor!==undefined&&"value" in descriptor&&typeof descriptor.value==="string"?descriptor.value.slice(0,512):undefined;':'';
						  insertions.push({offset:part.getStart(ast),text:`{try{${ownMessage}(globalThis as any).__warmProofEvent?.({kind:"application-resource-decline",source:${JSON.stringify(source)},sourceHash:${JSON.stringify(sourceHash)},site:${JSON.stringify(caught?"application-input-catch":"application-input-undefined-"+index)},line:${line}${caught?",message":""}});}catch{} `},{offset:part.end,text:"}"});
						 }
						 const declarations:ts.VariableDeclaration[]=[];const find=(node:ts.Node):void=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==="captureResource")declarations.push(node);ts.forEachChild(node,find);};find(ast);
						 if(declarations.length!==1||declarations[0]!.initializer===undefined||!ts.isArrowFunction(declarations[0]!.initializer!))throw new Error("CRITICAL_APPLICATION_RESOURCE_CAPTURE_OWNER_CHANGED");
						 const capture=declarations[0]!.initializer as ts.ArrowFunction,parts:ts.ReturnStatement[]=[];
						 const collect=(node:ts.Node):void=>{if(ts.isReturnStatement(node))parts.push(node);if(node!==capture.body&&(ts.isArrowFunction(node)||ts.isFunctionExpression(node)||ts.isFunctionDeclaration(node)))return;ts.forEachChild(node,collect);};collect(capture.body);
						 if(parts.length!==3||parts[0]!.expression?.getText(ast)!=="undefined"||parts[1]!.expression?.getText(ast)!=="undefined"||parts[2]!.expression===undefined||!ts.isConditionalExpression(parts[2]!.expression)||parts[2]!.expression.whenFalse.getText(ast)!=="undefined")throw new Error("CRITICAL_APPLICATION_RESOURCE_CAPTURE_SITES_CHANGED");
						 for(const [index,part] of parts.slice(0,2).entries()){
						  const line=ast.getLineAndCharacterOfPosition(part.getStart(ast)).line+1;
						  insertions.push({offset:part.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"application-resource-decline",source:${JSON.stringify(source)},sourceHash:${JSON.stringify(sourceHash)},site:${JSON.stringify(index===0?"capture-resource-result-shape":"capture-resource-descriptor-or-integer")},line:${line}${index===0?',resultCategory:result===undefined?"undefined":result===null?"null":typeof result!=="object"?"non-object":"prototype-or-key-count"':""}});}catch{} `},{offset:part.end,text:"}"});
						 }
						 const range=(parts[2]!.expression as ts.ConditionalExpression).whenFalse,line=ast.getLineAndCharacterOfPosition(range.getStart(ast)).line+1;
						 insertions.push({offset:range.getStart(ast),text:`(()=>{try{(globalThis as any).__warmProofEvent?.({kind:"application-resource-decline",source:${JSON.stringify(source)},sourceHash:${JSON.stringify(sourceHash)},site:"capture-resource-range",line:${line},byteLength,items,maxDepth});}catch{} return `},{offset:range.end,text:";})()"});
						}
						const functionPhases:Record<string,string>={
						 maintenanceCanonicalWidth:"maintenance-canonical-width",composeProspectiveCreatorMaintenancePrefixesForSizing:"maintenance-compose-total",evaluateSchedule:"maintenance-schedule",
						 createCreatorCanonicalSyntaxReader:"maintenance-syntax-owner-create",canonicalCreatorDataRecord:"maintenance-record-parse-and-detach",copyProspectiveMaintenanceBranchSeeds:"maintenance-branch-detach",
						 closedGenerationSourceFromSelected:"maintenance-generation-source-classification",classifyAheReclamation:"maintenance-ahe-classifier",copyBlobFacts:"maintenance-ahe-all-blob-hash",
						 issueOneVertex:"local-issue-native-job",issueLocal:"local-issue-inclusive",authenticateV3Ingress:"remote-authentication-inclusive",handleV3IngressWithSource:"remote-admission-delivery-inclusive",
						 readRetainedCloseSignedCurrentAdmission:"ordinary-retained-signed-fact-read",
						 retainedCloseSignedCurrentAdmission:"ordinary-retained-signed-fact-capture",
						 authenticateRecoveryVertex:"current-recovery-envelope-authentication",
						 verifyEd25519RegisteredDigest:"registered-signature-verification",
						 prepareCreatorIssuanceMaintenanceQuote:"maintenance-quote-prepare",chargeCreatorIssuanceMaintenanceQuote:"maintenance-forecast-charge",
						 prepareCreatorOrdinaryIssuanceMaintenanceQuote:"maintenance-ordinary-quote-prepare",
						 prepareCreatorIncrementalIssuanceMaintenanceQuote:"maintenance-incremental-quote",
						 reserveCreatorOrdinaryFinishingCapacity:"maintenance-combined-ordinary-bound",
						 captureCreatorOrdinaryCurrentDimensionsForSizing:"maintenance-ordinary-dimension-capture",
						 deriveCreatorOrdinaryApplicationResourceForSizing:"maintenance-application-growth-derivation",
						 deriveCreatorOrdinaryFinishingCapacityForSizing:"maintenance-incremental-finishing-core",
						 deriveCreatorOrdinaryFinishingCapacityScalarForSizing:"maintenance-incremental-finishing-scalar-core",
						 buildCreatorOrdinaryFinishingResourceProgramForSizing:"maintenance-boundary-future-schema-construction",
						 creatorOrdinaryApplicationResourceMaterialForSizing:"maintenance-application-complete-material",
						 prepareCreatorOrdinarySourceReadinessForSizing:"maintenance-boundary-source-preparation",
						 prepareCreatorOrdinaryReadiness:"maintenance-explicit-room-readiness",
						 refreshCreatorOrdinarySourceReadiness:"maintenance-readiness-fresh-source-refresh",
						 prepareCreatorOrdinaryIssuanceProofSourceReadiness:"maintenance-readiness-fresh-source-baseline",
						 creatorOrdinaryMandatoryFencePlansCorrespond:"maintenance-readiness-exact-fence-postimage",
						 deriveCreatorOrdinarySourceResourceProgramForSizing:"maintenance-incremental-finishing-program-core",
						 evaluateCreatorOrdinaryFinishingCapacity:"maintenance-incremental-finishing-bound",
						 evaluateCreatorOrdinaryFinishingCapacityScalar:"maintenance-incremental-finishing-scalar-certification",
						 evaluateCreatorOrdinarySourceResourceProgram:"maintenance-incremental-finishing-program-evaluation",
						 evaluateCreatorNoneResourceProgramForSizing:"maintenance-numerical-program-evaluation-only",
						 readCreatorOrdinaryApplicationResourceBound:"maintenance-application-growth-bound",
						 creatorOrdinaryIssuanceDimensionFacts:"maintenance-ordinary-dimension-owner-check",
						 chargeCreatorOrdinaryIssuanceMaintenanceQuote:"maintenance-ordinary-forecast-charge",
						 prepareProspectiveCreatorCloseMaterialFromPreview:"maintenance-material-shared-construction",
						 creatorIssuanceMaintenanceQuoteSizing:"maintenance-quote-sizing-fields",
						 sealCreatorRecoveryDependencies:"maintenance-capture-seal-recovery",acquireCreatorIssuanceMaintenanceProof:"maintenance-capture-proof-acquisition",
						 acquireCreatorOrdinaryIssuanceMaintenanceProof:"maintenance-ordinary-fresh-proof-acquisition",
						 readCreatorReplayRows:"maintenance-ordinary-journal-replay-read",
						 captureCreatorOrdinarySourceLinkedApplicationEffects:"maintenance-ordinary-source-linked-application-read",
						 captureCreatorOrdinaryIssuanceProofSource:"maintenance-ordinary-source-capture",
						 captureCreatorOrdinarySourceWithoutForecast:"maintenance-ordinary-source-prime-without-forecast",
						 captureCreatorOrdinaryFinishingCapacityTemplate:"maintenance-ordinary-bound-certification",
						 evaluateCreatorOrdinaryFinishingCapacityTemplate:"maintenance-ordinary-bound-evaluation",
						 acquireClosedData:"maintenance-capture-closed-data",prepareProspectiveCreatorCloseMaterial:"maintenance-material-prepare",
						 reconcileSnapshotRecoveryRoles:"maintenance-reconcile-authenticated-roles",
						 observeCreatorProtectedRecoveryRoles:"maintenance-observe-authenticated-roles",
						 applyClosedEpochRetirementIntent:"maintenance-retirement-intent-sequencing",
						 installClosedRetirementSource:"maintenance-install-retirement-source",
						 drainClosedJournalDetails:"maintenance-drain-journal-details",
						 acknowledgeClosedJournalDrain:"maintenance-acknowledge-journal-drain",
						 drainClosedSigningEvidence:"maintenance-drain-signing-details",
						 drainClosedSigningSummaries:"maintenance-drain-signing-summaries",
						 captureJournalRetirementDrainPlan:"journal-retirement-full-plan-capture",
						 decodeCapturedJournalRetirementNativeCarriers:"journal-retirement-native-progress-decode",
						 runControl:"native-ahe-retirement-control",
						 collectSourceOwnedClosedJournalMembershipPrefixes:"source-owned-membership-collection",
						 classifySourceOwnedClosedJournalDetails:"source-owned-journal-classification",
						 classifyClosedJournalDetails:"journal-retirement-classification",
						 decodeCanonical:"canonical-decode",encodeCanonical:"canonical-encode",decodeUtf8String:"canonical-string-decode",
						 canonicalCarrierResourceForSizing:"canonical-resource-read",
						 foldBlueprintEpoch:"application-complete-epoch-fold",validatedApplicationState:"application-state-encode-validate",applicationStateBytes:"application-state-encode-validate",deepCloneCanonical:"application-canonical-clone",
						 applyPreparedBlueprintOperation:"application-prepared-runtime",previewCreatorIssuanceClose:"maintenance-application-preview",
						 closedJournalMembershipPrefix:"membership-prefix-authentication",readHeldSourcePreimage:"source-held-anchor-read",readProspectiveCreatorMaintenancePrefixesForSizing:"maintenance-prefix-read-and-compose",
						 readCreatorRecoveryDependencyCensus:"recovery-complete-census-read",
						 prepareCreatorUnchangedHeldCensusRead:"recovery-census-unchanged-input-prepare",
						 checkCreatorHeldRecoveryJournal:"recovery-census-held-journal-current-check",
						 ...(path.endsWith("/creator-closed-rollback-data.ts") ? {
						  authenticate:"maintenance-capture-authentication",
						  acquireRecoveryRoleCertificate:"maintenance-capture-certificate-readback",
						  readTarget:"maintenance-capture-snapshot-target",
						 } : {}),
						 ...(path.endsWith("/packages/seal/src/creator.ts") ? {
						  acquireSigningDependencies:"maintenance-signing-dependency-acquire",
						  recoveryEvidenceFailure:"maintenance-signing-evidence-verification",
						 } : {}),
						 ...(path.endsWith("/creator-transition-advance.ts") ? {
						  openCreatorSnapshotRecoverySourceTrust:"maintenance-source-public-boundary",
						  openCreatorSnapshotRecoverySourceTrustOwned:"maintenance-capture-source-chain-trust",
						  verifyCreatorRecoveryBranch:"maintenance-source-full-branch-verification",
						  openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch:"maintenance-source-cut-qc-from-verified-branch",
						  openCreatorSnapshotRecoveryRoleReadback:"maintenance-readback-public-boundary",
						  openCreatorSnapshotRecoveryRoleReadbackOwned:"maintenance-semantic-role-readback",
						  openVerifiedCreatorHistoricalIssuance:"historical-issuance-single-author-open",
						  resolveVerifiedHistoricalSettlementFrontiers:"historical-settlement-many-frontiers",
						  openCreatorTransitionSettlement:"transition-settlement-control-open",
						  prepareCreatorTransitionAdvanceRecheck:"transition-frame-recheck-prepare",
						  recheck:"transition-frame-recheck",
						 } : {}),
						};
						const observeExpression=(expression:ts.Expression,phase:string):void=>{
						 criticalSites[phase]=(criticalSites[phase]??0)+1;
						 insertions.push({offset:expression.getStart(ast),text:`((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))(${JSON.stringify(phase)},()=>`},
						  {offset:expression.end,text:")"});
						};
						// One fixed mature transition, through the existing observer. Sibling
						// statements partition a blocking owner rather than adding nested
						// inclusive helper times. Keep original scopes, returns and promises.
						const observeSequentialOwner=(body:ts.Block,owner:string,onlyCommand?:string):void=>{
						 const id="__criticalSequential"+body.pos,step=id+"Step";
						 criticalSites[owner]=(criticalSites[owner]??0)+1;
						 insertions.push({offset:body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(owner+"-sequential-owner")});let ${step}:any;try {`},
						  // At a named function's shared closing offset this inner
						  // finally must precede the generic outer metric's catch/finally.
						  // Applying it last prepends it, keeping its lexical tokens live.
						  {offset:body.end-1,priority:-1,text:`}finally{(globalThis as any).__warmMetricEnd?.(${step});(globalThis as any).__warmMetricEnd?.(${id});}`});
						 if(body.statements.length>256)throw new Error("CRITICAL_SEQUENTIAL_OWNER_BOUND_CHANGED:"+owner);
						 for(const [index,statement] of body.statements.entries()){
						  const name=ts.isVariableStatement(statement)?statement.declarationList.declarations.map(row=>row.name.getText(ast)).join(","):
						   ts.isIfStatement(statement)?"if "+statement.expression.getText(ast):statement.getText(ast);
						  const line=ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line+1;
						  const phase=owner+"-step:"+String(index+1).padStart(3,"0")+":"+name.replace(/\s+/gu," ").slice(0,88)+"@L"+line;
						  insertions.push({offset:statement.getStart(ast),text:`(globalThis as any).__warmMetricEnd?.(${step});${step}=${id}?.token.role==="creator"&&${id}?.token.transition===4${onlyCommand===undefined?"":`&&${id}.token.command===${JSON.stringify(onlyCommand)}`}?(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)},0,false,${id}.token):undefined;\n`});
						 }
						};
						const instrument=(node:ts.Node):void=>{
						 if(path.endsWith("/creator-transition-advance.ts")&&ts.isCallExpression(node)&&
						  node.expression.getText(ast)==="inspectCreatorHistoricalAnchorChain"){
						  let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						  if(owner&&ts.isFunctionDeclaration(owner)&&["verifyCreatorRecoveryBranch"].includes(owner.name?.text??""))
						   observeExpression(node,"recovery-anchor-chain:"+owner.name!.text);
						 }
						 if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isFunctionDeclaration(node)&&node.body&&
						  ["acquireClosedData","acquireRecoveryRoleCertificate","readTarget"].includes(node.name?.text??"")){
						  const owner="sealing-source-"+node.name!.text;
						  observeSequentialOwner(node.body,owner,"sealing-inclusive");
						  node.body.statements.filter(ts.isTryStatement).forEach((statement,index)=>
						   observeSequentialOwner(statement.tryBlock,owner+"-try"+(index+1),"sealing-inclusive"));
						 }
						 if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isFunctionDeclaration(node)&&node.body&&
						  ["reconcileSnapshotRecoveryRoles","installClosedRetirementSource"].includes(node.name?.text??"")){
						  // The reconciliation body returns installation's promise without
						  // awaiting it. Partition its executed prefix separately; the
						  // corrected named-function metric observes actual settlement.
						  const owner=node.name!.text==="reconcileSnapshotRecoveryRoles"?"reconciliation-prefix":"retirement-installation";
						  observeSequentialOwner(node.body,owner,"sealing-inclusive");
						  node.body.statements.filter(ts.isTryStatement).forEach((statement,index)=>
						   observeSequentialOwner(statement.tryBlock,owner+"-try"+(index+1),"sealing-inclusive"));
						 }
						 if(path.endsWith("/creator-close.ts")&&ts.isIfStatement(node)&&ts.isBlock(node.thenStatement)){
						  const condition=node.expression.getText(ast);
						  if(condition==="persistedSnapshot === undefined && input.promotionContext !== undefined")observeSequentialOwner(node.thenStatement,"sealing-maintenance","sealing-inclusive");
						  if(condition==="owner.recoveryScopes >= owner.limits.maxRecoveryScopes || resume || capacityMaintenance")observeSequentialOwner(node.thenStatement,"sealing-maintenance-turnover","sealing-inclusive");
						 }
						 if(path.endsWith("/creator-close.ts")&&ts.isFunctionDeclaration(node)&&node.name?.text==="reconcileCreatorBoundedRecoveryMaintenance"&&node.body){
						  observeSequentialOwner(node.body,"sealing-maintenance-job","sealing-inclusive");
						  for(const statement of node.body.statements)if(ts.isForStatement(statement)&&ts.isBlock(statement.statement))
						   observeSequentialOwner(statement.statement,"sealing-maintenance-pass","sealing-inclusive");
						 }
						 if(path.endsWith("/v3-room.ts")&&ts.isIfStatement(node)&&ts.isBlock(node.thenStatement)&&
						  node.expression.getText(ast)==='!input.receiveOnly && settlementProfile === "v1"'){
						  let parent:ts.Node|undefined=node.parent;while(parent&&!ts.isArrowFunction(parent)&&!ts.isFunctionDeclaration(parent))parent=parent.parent;
						  if(parent&&ts.isArrowFunction(parent)&&ts.isVariableDeclaration(parent.parent)&&parent.parent.name.getText(ast)==="performCreatorSuccessorAdoption")
						   observeSequentialOwner(node.thenStatement,"adoption-settlement","creator-adoption-inclusive");
						 }
						 if(path.endsWith("/creator-close.ts")&&ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&
						  ts.isIdentifier(node.left)&&node.left.text==="closeTask"&&ts.isCallExpression(node.right)){
						  const call=ts.isPropertyAccessExpression(node.right.expression)&&node.right.expression.name.text==="catch"&&
						   ts.isCallExpression(node.right.expression.expression)?node.right.expression.expression:node.right;
						  if(ts.isParenthesizedExpression(call.expression)&&ts.isArrowFunction(call.expression.expression)&&ts.isBlock(call.expression.expression.body))
						   observeSequentialOwner(call.expression.expression.body,"sealing");
						 }
						 if(path.endsWith("/v3-room.ts")&&ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&
						  node.name.text==="performCreatorSuccessorAdoption"&&node.initializer&&ts.isArrowFunction(node.initializer)&&ts.isBlock(node.initializer.body)){
						  observeSequentialOwner(node.initializer.body,"adoption");
						  node.initializer.body.statements.filter(ts.isTryStatement).forEach((statement,index)=>
						   observeSequentialOwner(statement.tryBlock,"adoption-try"+(index+1)));
						 }
						 if(path.endsWith("/v3-room.ts")&&ts.isCallExpression(node)&&node.expression.getText(ast)==="enqueueLifetimeTransition"&&
						  node.arguments[0]&&ts.isArrowFunction(node.arguments[0])&&ts.isBlock(node.arguments[0].body)){
						  let owner:ts.Node|undefined=node.parent;while(owner&&!(ts.isMethodDeclaration(owner)&&owner.name?.getText(ast)==="sealEpoch")&&
						   !(ts.isVariableDeclaration(owner)&&owner.name.getText(ast)==="adoptCreatorSuccessor"))owner=owner.parent;
						  if(owner&&ts.isMethodDeclaration(owner)&&owner.name?.getText(ast)==="sealEpoch")observeSequentialOwner(node.arguments[0].body,"seal-room");
						  if(owner&&ts.isVariableDeclaration(owner)&&owner.name.getText(ast)==="adoptCreatorSuccessor")observeSequentialOwner(node.arguments[0].body,"adoption-room");
						 }
						 if(path.endsWith("/v3-room.ts")&&ts.isVariableDeclaration(node)&&node.name.getText(ast)==="enqueueLifetimeTransition"&&
						  node.initializer&&ts.isArrowFunction(node.initializer)&&ts.isBlock(node.initializer.body)){
						  const body=node.initializer.body,id="__criticalQueue"+node.pos;
						  const dispatch=body.statements.filter(ts.isVariableStatement).flatMap(row=>[...row.declarationList.declarations]).find(row=>row.name.getText(ast)==="dispatch");
						  if(!dispatch?.initializer||!ts.isArrowFunction(dispatch.initializer)||!ts.isBlock(dispatch.initializer.body))throw Error("CRITICAL_ROOM_DISPATCH_OWNER_CHANGED");
						  const starts:ts.ArrowFunction[]=[];const find=(child:ts.Node):void=>{if(ts.isCallExpression(child)&&child.expression.getText(ast)==="lifetimeTransitionTail.then"&&child.arguments[0]&&ts.isArrowFunction(child.arguments[0]))starts.push(child.arguments[0]);ts.forEachChild(child,find);};find(dispatch.initializer.body);
						  if(starts.length!==1||!ts.isBlock(starts[0]!.body))throw Error("CRITICAL_ROOM_QUEUE_START_CHANGED");
						  criticalSites["room-lifetime-queue-waits"]=(criticalSites["room-lifetime-queue-waits"]??0)+1;
						  insertions.push({offset:body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.("room-lifetime-lease-wait");let ${id}Tail:any;`},
						   {offset:dispatch.initializer.body.getStart(ast)+1,text:`(globalThis as any).__warmMetricEnd?.(${id});${id}Tail=(globalThis as any).__warmMetricBegin?.("room-lifetime-tail-wait",0,false,${id}?.token);`},
						   {offset:starts[0]!.body.getStart(ast)+1,text:`(globalThis as any).__warmMetricEnd?.(${id}Tail);`});
						 }
						 if(/\/internal\/idb-adapter\.(?:ts|js)$/.test(path)&&ts.isCallExpression(node)&&
						  node.expression.getText(ast)==="admitBrowserRetirementControl")
						  observeExpression(node,"native-ahe-complete-retirement-admission");
						 if(path.endsWith("/v3-live.ts")){
						  if(ts.isFunctionDeclaration(node)&&node.name?.text==="checkCreatorHeldRecoveryJournal"&&node.body){
						   const guard=node.body.statements.find(ts.isIfStatement);
						   const operands=(value:ts.Expression):ts.Expression[]=>ts.isBinaryExpression(value)&&value.operatorToken.kind===ts.SyntaxKind.BarBarToken?[...operands(value.left),...operands(value.right)]:[value];
						   const parts=guard?operands(guard.expression):[];
						   const reasons=["no-enrollment","awaiting-original-replay","foreign-held-view","revoked-held-view","changed-journal-owner","changed-journal-producer"];
						   if(parts.length!==reasons.length)throw Error("CRITICAL_JOURNAL_PROBE_GUARDS_CHANGED");
						   for(const [index,part] of parts.entries())insertions.push({offset:part.getStart(ast),text:`((__value:boolean)=>{if(__value)(globalThis as any).__warmMetricCount?.(${JSON.stringify("held-journal-decline:"+reasons[index])});return __value;})(`},{offset:part.end,text:")"});
						   const failed=node.body.statements.find((row):row is ts.IfStatement=>ts.isIfStatement(row)&&row.expression.getText(ast)==="!result.ok");
						   if(!failed)throw Error("CRITICAL_JOURNAL_PROBE_RESULT_CHANGED");
						   insertions.push({offset:failed.thenStatement.getStart(ast),text:'{(globalThis as any).__warmMetricCount?.("held-journal-decline:native-"+result.kind);'},{offset:failed.thenStatement.end,text:"}"});
						   const returned=node.body.statements.filter(ts.isReturnStatement).at(-1)?.expression;
						   if(!returned||!ts.isConditionalExpression(returned))throw Error("CRITICAL_JOURNAL_PROBE_POST_GUARD_CHANGED");
						   insertions.push({offset:returned.condition.getStart(ast),text:'((__value:boolean)=>{(globalThis as any).__warmMetricCount?.(__value?"held-journal-probe-hit":"held-journal-decline:post-await-binding");return __value;})('},{offset:returned.condition.end,text:")"});
						  }
						  if(ts.isCallExpression(node)&&node.expression.getText(ast)==="current.probe.checkCurrent")
						   observeExpression(node,"recovery-census-held-journal-native-probe");
						  if(ts.isFunctionDeclaration(node)&&node.name?.text==="prepareCreatorUnchangedHeldCensusRead"){
						   const body=node.body;if(!body)throw Error("CRITICAL_UNCHANGED_CENSUS_OWNER_MISSING");
						   insertions.push({offset:body.getStart(ast)+1,text:'\ntry{(globalThis as any).__warmProofEvent?.({kind:"unchanged-census-eligibility",policy:captured.applicationPolicyRead,overCapacity:captured.overCapacity,pages:captured.pages.length,live:live(),held:preparedHeld.available(),sourceBound:runtime.sourceBound,branch:runtime.nativeBranchSource!==undefined,migration:runtime.migrationSource!==undefined,pending:registration.pendingIngress.size,pendingBytes:registration.pendingIngressBytes,rebaseLength:registration.rebaseSnapshot?.length??0,rebaseCursor:registration.rebaseCursor??null,floor:preparedMigrationTargetFloors.has(registration),storeFrozen:ObjectIsFrozen(registration.issuanceStore),maintenanceFrozen:ObjectIsFrozen(durableIssuancePruningMaintenanceForStore(registration.issuanceStore)??{} )});}catch{}\n'});
						  }
						  if(ts.isCallExpression(node)&&node.expression.getText(ast)==="fast"&&node.arguments.length===1&&node.arguments[0]?.getText(ast)==="held")
						   observeExpression(node,"recovery-census-unchanged-input-check");
						  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>ts.isIdentifier(value.name)&&value.name.text==="unchanged"&&value.initializer?.getText(ast)==="await fast(held)"))
						   insertions.push({offset:node.end,text:'\n(globalThis as any).__warmMetricCount?.("recovery-census-unchanged-input-"+(unchanged===true?"hit":unchanged===false?"stale":"miss"));'});
						 }
						 if(path.endsWith("/creator-close.ts")&&ts.isCallExpression(node)){
						  let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						  if(owner&&ts.isFunctionDeclaration(owner)&&owner.name?.text==="captureCreatorOrdinarySourceWithoutForecast"){
						   const phase:Record<string,string>={
						    "registration.sealIssuanceMaintenanceDependencies":"readiness-prime-seal",
						    acquireCreatorIssuanceMaintenanceProof:"readiness-prime-authenticated-proof",
						    captureCreatorOrdinaryIssuanceProofSource:"readiness-prime-source-and-capacity",
						    "proof.release":"readiness-prime-joined-release"};
						   const selected=phase[node.expression.getText(ast)];if(selected)observeExpression(node,selected);
						  }
						 }
						 if(path.endsWith("/creator-closed-rollback-data.ts")){
						  let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						  if(owner&&ts.isFunctionDeclaration(owner)&&owner.name?.text==="acquireCreatorOrdinaryIssuanceMaintenanceProof"){
						   if(ts.isCallExpression(node)){
						    const callee=node.expression.getText(ast);
						    if(callee==="runtime.readNativeIssuance")observeExpression(node,"maintenance-ordinary-native-issuance-capture");
						    if(callee==="runtime.checkCurrentJournal")observeExpression(node,"maintenance-ordinary-current-journal-validation");
						    if(callee==="input.anchorRead")observeExpression(node,"maintenance-ordinary-source-anchor-read");
						    if(callee==="runtime.borrowSigningDependencies")observeExpression(node,"maintenance-ordinary-signing-borrow");
						    if(callee==="snapshotCall"&&node.getText(ast).includes('"captureRecoveryRoleInventory"'))
						     observeExpression(node,"maintenance-ordinary-snapshot-inventory-capture");
						   }
						   if(ts.isForOfStatement(node)&&node.expression.getText(ast)==="seed.knownMaterial.entries()"){
						    const phase="maintenance-ordinary-material-reenrollment",id="__criticalReenrollment"+node.pos;
						    criticalSites[phase]=(criticalSites[phase]??0)+1;
						    // Observe the existing loop, including refusal, without another
						    // pass, native read, charge, detached copy or authorization check.
						    insertions.push({offset:node.getStart(ast),text:`{const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});const __chargedBefore=accounting.chargedBytes;try{`},
						     {offset:node.end,text:`}finally{(globalThis as any).__warmMetricEnd?.(${id});try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-proof-material-reenrollment",entries:seed.knownMaterial.length,chargedBefore:__chargedBefore,chargedAfter:accounting.chargedBytes});}catch{}}}`});
						   }
						  }
						 }
						 if(path.endsWith("/v3-live.ts")&&(ts.isVariableStatement(node)||ts.isExpressionStatement(node))){
						  let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						  const ownerName=owner&&ts.isFunctionDeclaration(owner)?owner.name?.text:undefined;
						  const commit=ts.isVariableStatement(node)&&node.declarationList.declarations.find(row=>
						   ts.isIdentifier(row.name)&&row.name.text==="committed"&&row.initializer&&ts.isAwaitExpression(row.initializer)&&
						   ts.isCallExpression(row.initializer.expression)&&row.initializer.expression.expression.getText(ast)==="registration.issuanceStore.transactIssue");
						  const ack=ts.isExpressionStatement(node)&&ts.isAwaitExpression(node.expression)&&ts.isCallExpression(node.expression.expression)&&
						   node.expression.expression.expression.getText(ast)==="registration.issuanceStore.compareAndMarkOutboxPublished";
						  if((ownerName==="issueOneVertex"&&commit)||(ownerName==="publishPending"&&ack)){
						   const committed=ownerName==="issueOneVertex",kind=committed?"healthy-local-native-commit-completed":"healthy-durable-publication-ack-completed";
						   criticalSites[kind]=(criticalSites[kind]??0)+1;
						   // Observe only the ORIGINAL successful await continuation. No
						   // extra reads, hashes, waits, transactions or product callbacks.
						   insertions.push({offset:node.end,text:`\ntry{const __healthyNativeCompletedAt=performance.now();(globalThis as any).__warmProofEvent?.({kind:${JSON.stringify(kind)},nativeCompletedAt:__healthyNativeCompletedAt,timeOrigin:performance.timeOrigin,objectId:${committed?"selectedScope.objectId":"row.scope.objectId"},author:${committed?"selectedScope.author":"row.scope.author"},epoch:registration.payload.provenance.epoch,authorSequence:${committed?"committed.authorSequence":"row.authorSequence"},digest:lowerHexDigest(${committed?"committed.envelope.digest":"row.digest"})});}catch{}\n`});
						  }
						 }
						 if(path.endsWith("/v3-live.ts")&&ts.isCallExpression(node)&&
						  ts.isIdentifier(node.expression)&&node.expression.text==="openVerifiedCreatorHistoricalIssuance"&&
						  node.arguments.length===1&&ts.isObjectLiteralExpression(node.arguments[0]!)&&
						  node.arguments[0]!.properties.some(property=>ts.isPropertyAssignment(property)&&
						   ts.isIdentifier(property.name)&&property.name.text==="author"&&
						   property.initializer.getText(ast)==="member.author"))
						   observeExpression(node,"adoption-policy-frontier-cold-member");
						 if(path.endsWith("/v3-live.ts")&&ts.isArrowFunction(node)&&ts.isBlock(node.body)&&
						  ts.isPropertyAssignment(node.parent)&&ts.isIdentifier(node.parent.name)&&node.parent.name.text==="check"&&
						  node.body.getText(ast).includes("const held = issuanceRead")&&node.body.getText(ast).includes("const reopened =")){
						  let owner:ts.Node|undefined=node.parent;
						  while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						  if(owner&&ts.isFunctionDeclaration(owner)&&owner.name?.text==="sealCreatorRecoveryDependencies"){
						   const phase="recovery-close-complete-census-check",id="__criticalCensus"+node.pos;
						   criticalSites[phase]=(criticalSites[phase]??0)+1;
						   insertions.push({offset:node.body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});try {`},
						    {offset:node.body.end-1,text:`}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;}finally{(globalThis as any).__warmMetricEnd?.(${id});}`});
						  }
						 }
						 if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isArrowFunction(node)){
						  if(ts.isPropertyAssignment(node.parent)&&ts.isIdentifier(node.parent.name)&&node.parent.name.text==="checkCurrent"&&!ts.isBlock(node.body)&&node.body.getText(ast).startsWith("throughCurrentSource("))observeExpression(node.body,"source-original-current-check");
						  if(ts.isVariableDeclaration(node.parent)&&ts.isIdentifier(node.parent.name)&&["checkSnapshots","checkCurrentSource"].includes(node.parent.name.text)&&ts.isBlock(node.body)){
						   const phase=node.parent.name.text==="checkSnapshots"?"source-protected-snapshots-check":"source-current-core-validation";
						   const id="__criticalSnapshots"+node.pos;criticalSites[phase]=(criticalSites[phase]??0)+1;
						   insertions.push({offset:node.body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});try {`},
						    {offset:node.body.end-1,text:`}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;}finally{(globalThis as any).__warmMetricEnd?.(${id});}`});
						  }
						 }
						 if(/\/storage-browser\//u.test(path)){
						  if(/\/packages\/storage-browser\/(?:dist\/)?src\/internal\/idb-adapter\.(?:ts|js)$/u.test(path)&&
						   ts.isMethodDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="acquireBoundedRecoveryRoleRead"&&node.body&&
						   ts.isClassDeclaration(node.parent)&&node.parent.name?.text==="IdbAheDurableStore"){
						   const phase="maintenance-capture-native-ahe-reader-open";
						   criticalSites[phase]=(criticalSites[phase]??0)+1;
						   // This owner returns a Promise without async syntax. Observe
						   // its exact original return, not only synchronous preparation;
						   // lexical this/input and all original refusals remain intact.
						   insertions.push({offset:node.body.getStart(ast)+1,text:`\nreturn ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))(${JSON.stringify(phase)},()=>{\n`},
						    {offset:node.body.end-1,text:"\n});\n"});
						  }
						  const carrier=(ts.isArrowFunction(node)||ts.isFunctionExpression(node))?node:undefined;
						  const parent=carrier?.parent,name=parent&&(ts.isVariableDeclaration(parent)||ts.isPropertyAssignment(parent))&&ts.isIdentifier(parent.name)?parent.name.text:undefined;
						  if(carrier&&name&&["readRetirementImage","readRetirementAdmissionImage","checkCurrent"].includes(name)){
						   if(!ts.isBlock(carrier.body))observeExpression(carrier.body,"native:"+path.split("/").at(-1)+":"+name);
						   else{
						    const id="__criticalNative"+node.pos,phase="native:"+path.split("/").at(-1)+":"+name;
						    criticalSites[phase]=(criticalSites[phase]??0)+1;
						    if(carrier.modifiers?.some(row=>row.kind===ts.SyntaxKind.AsyncKeyword))insertions.push({offset:carrier.body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});try {`},
						     {offset:carrier.body.end-1,text:`}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;}finally{(globalThis as any).__warmMetricEnd?.(${id});}`});
						    else for(const statement of carrier.body.statements)if(ts.isReturnStatement(statement)&&statement.expression)observeExpression(statement.expression,phase);
						   }
						  }
						  if(ts.isMethodDeclaration(node)&&node.body&&ts.isIdentifier(node.name)&&["check","readRetirementImagePoint"].includes(node.name.text)){
						   const className=ts.isClassDeclaration(node.parent)?node.parent.name?.text:undefined;
						   if((className==="HeldReadView"&&node.name.text==="check")||(path.endsWith("idb-adapter.ts")||path.endsWith("idb-adapter.js"))&&node.name.text==="readRetirementImagePoint"){
						    const phase="native:"+className+":"+node.name.text,id="__criticalNativeMethod"+node.pos;
						    criticalSites[phase]=(criticalSites[phase]??0)+1;
						    if(node.modifiers?.some(row=>row.kind===ts.SyntaxKind.AsyncKeyword)){
						     const heldCheck=className==="HeldReadView"&&node.name.text==="check";
						     if(heldCheck)for(const label of ["native-currency-read-turn-queue","native-currency-fresh-request-service","native-currency-promise-continuation"])
						      criticalSites[label]=(criticalSites[label]??0)+1;
						     if(heldCheck){
						      const first=node.body.statements[0];
						      if(first?.getText(ast)!=="this.assertOpen();")throw new Error("CRITICAL_NATIVE_CURRENCY_ADMISSION_SEAM_CHANGED");
						      insertions.push({offset:first.end,text:'__nativeCurrencyToken=(globalThis as any).__warmNativeCurrencyAdmit?.(this);'});
						     }
						     insertions.push({offset:node.body.getStart(ast)+1,text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});${heldCheck?'let __nativeCheckQueue=(globalThis as any).__warmMetricBegin?.("native-currency-read-turn-queue"),__nativeCheckService:any,__nativeCheckContinuation:any,__nativeCurrencyToken:any;':''}try {`},
						      {offset:node.body.end-1,text:`}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;}finally{${heldCheck?'(globalThis as any).__warmNativeCurrencyEnd?.(__nativeCurrencyToken);(globalThis as any).__warmMetricEnd?.(__nativeCheckQueue);(globalThis as any).__warmMetricEnd?.(__nativeCheckService);(globalThis as any).__warmMetricEnd?.(__nativeCheckContinuation);':''}(globalThis as any).__warmMetricEnd?.(${id});}`});
						    }
						    else for(const statement of node.body.statements)if(ts.isReturnStatement(statement)&&statement.expression)observeExpression(statement.expression,phase);
						   }
						  }
						  if(path.endsWith("native-read-reservation.ts")||path.endsWith("native-read-reservation.js")){
						   if(ts.isNewExpression(node)&&node.expression.getText(ast)==="Promise"){
						    let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isMethodDeclaration(owner))owner=owner.parent;
						    if(owner&&ts.isMethodDeclaration(owner)&&ts.isIdentifier(owner.name)&&owner.name.text==="check"&&
						     ts.isClassDeclaration(owner.parent)&&owner.parent.name?.text==="HeldReadView"){
						     criticalSites["native-currency-fresh-request-issuance"]=(criticalSites["native-currency-fresh-request-issuance"]??0)+1;
						     // Ends queue timing only when the ORIGINAL run callback starts.
						     // Service includes request creation through its success callback,
						     // not exclusive backend time or CPU; no extra native request.
						     insertions.push({offset:node.getStart(ast),text:'((globalThis as any).__warmNativeCurrencyIssued?.(__nativeCurrencyToken),(globalThis as any).__warmMetricEnd?.(__nativeCheckQueue),__nativeCheckQueue=undefined,__nativeCheckService=(globalThis as any).__warmMetricBegin?.("native-currency-fresh-request-service"),'},
						      {offset:node.end,text:")"});
						    }
						   }
						   const pump=ts.isMethodDeclaration(node)&&ts.isPrivateIdentifier(node.name)&&node.name.text==="#pump"?node:
						    ts.isFunctionExpression(node)&&node.name?.text==="_HeldReadView_pump"?node:undefined;
						   if(pump?.body){criticalSites["native-keepalive-pump"]=(criticalSites["native-keepalive-pump"]??0)+1;insertions.push({offset:pump.body.getStart(ast)+1,text:'(globalThis as any).__warmMetricCount?.("native-keepalive-pump");'});}
						   if(ts.isArrowFunction(node)&&ts.isCallExpression(node.parent)&&node.parent.expression.getText(ast)==="request.addEventListener"&&node.parent.arguments[0]?.getText(ast)==='"success"'){
						    let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isMethodDeclaration(owner)&&!(ts.isFunctionExpression(owner)&&owner.name?.text==="_HeldReadView_pump"))owner=owner.parent;
						    const name=owner&&ts.isMethodDeclaration(owner)?owner.name.getText(ast):owner&&ts.isFunctionExpression(owner)?owner.name?.text:undefined;
						    if(name==="#pump"||name==="_HeldReadView_pump"||name==="check"){
						     const phase=name==="check"?"native-currency-check-success-callback":"native-keepalive-success-callback";criticalSites[phase]=(criticalSites[phase]??0)+1;
						     const serviceEnd=name==="check"?'(globalThis as any).__warmNativeCurrencyPoint?.(__nativeCurrencyToken),(globalThis as any).__warmMetricEnd?.(__nativeCheckService),__nativeCheckService=undefined,__nativeCheckContinuation=(globalThis as any).__warmMetricBegin?.("native-currency-promise-continuation"),':"";
						     if(ts.isBlock(node.body))insertions.push({offset:node.body.getStart(ast)+1,text:`${serviceEnd}(globalThis as any).__warmMetricCount?.(${JSON.stringify(phase)});`});
						     else insertions.push({offset:node.body.getStart(ast),text:`(${serviceEnd}(globalThis as any).__warmMetricCount?.(${JSON.stringify(phase)}),`},{offset:node.body.end,text:")"});
						    }
						   }
						  }
						 }
						  if(path.endsWith("/creator-close.ts")&&ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="plan")){
						   let owner:ts.Node|undefined=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
						   if(owner&&ts.isFunctionDeclaration(owner)&&owner.name?.text==="prepareCreatorIssuanceMaintenanceQuote")insertions.push({offset:node.getStart(ast),text:'\ntry{(globalThis as any).__warmProofEvent?.({kind:"causal-issuance-maintenance-owner",owner:(globalThis as any).__warmProofIdentity?.(proof.accounting),author:unsigned.author,authorSequence:unsigned.authorSequence,epoch:unsigned.epoch,dependencies:Array.isArray(unsigned.dependencies)?unsigned.dependencies.length:undefined,operationKind:unsigned.operation!==null&&typeof unsigned.operation==="object"?Object.getOwnPropertyDescriptor(unsigned.operation,"kind")?.value:undefined,operationAction:unsigned.operation!==null&&typeof unsigned.operation==="object"?Object.getOwnPropertyDescriptor(unsigned.operation,"action")?.value:undefined,planEffectKind:planEffect?.kind,received:receivedReceipt!==undefined,unsignedBytes:unsignedBytes.byteLength});}catch{}\n'});
						  }
						  if(incrementalNativeControls&&path.endsWith("/creator-close.ts")&&ts.isExpressionStatement(node)&&
						   ts.isBinaryExpression(node.expression)&&node.expression.left.getText(ast)==="quote"&&
						   ts.isAwaitExpression(node.expression.right)&&ts.isCallExpression(node.expression.right.expression)&&
						   node.expression.right.expression.expression.getText(ast)==="prepareCreatorIncrementalIssuanceMaintenanceQuote"){
						   criticalSites["incremental-native-pre-effect-controls"]=(criticalSites["incremental-native-pre-effect-controls"]??0)+1;
						   insertions.push({offset:node.getStart(ast),text:`
if((globalThis as any).__r8IncrementalNativeControls!==true)throw new Error("INCREMENTAL_NATIVE_CONTROL_BUILD_RUNTIME_MISMATCH");
(globalThis as any).__r8IncrementalNativeControlSourcePin=${JSON.stringify(hash(raw))};
let __incrementalPositiveControl=false;
const __incrementalControlTimer=(globalThis as any).__warmMetricBegin?.("test-only-incremental-native-controls",0,false);
try{
 const __futurePhases=["maintenance-quote-prepare","maintenance-material-prepare","maintenance-material-shared-construction","maintenance-application-preview","maintenance-compose-total","maintenance-schedule"];
 const __futureCount=()=>{const snapshot=(globalThis as any).__r8CriticalSnapshot?.();if(snapshot===undefined||snapshot.metricsTruncated)throw new Error("INCREMENTAL_FUTURE_OBSERVATIONS_INCOMPLETE");return snapshot.metrics.reduce((sum:number,row:any)=>sum+(__futurePhases.includes(row.phase)?row.entered:0),0);};
 const __futureBefore=__futureCount();
 const __copiedSource=await prepareCreatorIncrementalIssuanceMaintenanceQuote(registration,input,unsignedBytes,{...ordinaryProofSource!},receivedReceipt);
 if(__copiedSource!==undefined)throw new Error("INCREMENTAL_COPIED_SOURCE_ACCEPTED");
 (globalThis as any).__warmProofEvent?.({kind:"incremental-native-copied-source-control",ok:true,joined:true,epoch:registration.currentTrust.currentEpoch,phase:candidate.kind});
 const __baseline=await prepareCreatorIncrementalIssuanceMaintenanceQuote(registration,input,unsignedBytes,ordinaryProofSource!,receivedReceipt,undefined,undefined,true);
 if(__baseline!==undefined){
  if(__baseline.kind!=="native-probe-only")throw new Error("INCREMENTAL_CONTROL_BOOK_ALREADY_SPENT");
  __incrementalPositiveControl=true;
  const __proof=__baseline.proof,__before=__proof.accounting.chargedBytes;
  let __primary:unknown,__failed=false,__controlEnvelopes:readonly number[]|undefined;
  try{
   const __dimensions=await __proof.readCurrentDimensions(unsignedBytes);
   if(__dimensions===undefined||await readCreatorOrdinaryApplicationResourceBound(__dimensions,__proof,unsignedBytes,input.readOrdinaryApplicationResourceBound!)===undefined)throw new Error("INCREMENTAL_POSITIVE_CONTROL_READOUT_UNAVAILABLE");
   const __options={reader:input.readOrdinaryApplicationResourceBound!,storageIncarnation:input.storageIncarnation,actualProducerChunkBytes:131_072 as const,
    ...(input.ordinaryFinishingWindow===undefined?{}:{window:input.ordinaryFinishingWindow}),
    ...(registration.currentTrust.profileId==="creator-trusted-settlement-v1"?{settlementPreview:input.prospectiveSettlementPreview}:{})};
   if(registration.currentTrust.profileId==="creator-trusted-settlement-v1"&&typeof __options.settlementPreview!=="function")throw new Error("INCREMENTAL_ORIGINAL_SETTLEMENT_PREVIEW_UNAVAILABLE");
   const __capacity=await evaluateCreatorOrdinaryFinishingCapacity(__dimensions,__proof,unsignedBytes,__options);
   if(__capacity===undefined||__proof.accounting.chargedBytes!==__before)throw new Error("INCREMENTAL_POSITIVE_CONTROL_CAPACITY_UNAVAILABLE_OR_CHARGED");
   // Detached numbers only survive joined release, never native rows, custody
   // or a runtime-only handle reclassified as a full observation capability.
   __controlEnvelopes=Object.freeze([...__capacity.fullFutureProofEnvelopeByteLengths]);
   if(await evaluateCreatorOrdinaryFinishingCapacity({...__dimensions},__proof,unsignedBytes,__options)!==undefined||
    await evaluateCreatorOrdinaryFinishingCapacity(__dimensions,{...__proof},unsignedBytes,__options)!==undefined||__proof.accounting.chargedBytes!==__before)throw new Error("INCREMENTAL_COPIED_DIMENSION_OR_PROOF_ACCEPTED_OR_CHARGED");
   if(!__proof.accounting.chargeUnknownEncodedLength(__proof.accounting.maxBytes-__before))throw new Error("INCREMENTAL_TEST_UNKNOWN_SATURATION_FAILED");
   const __exhausted=__proof.accounting.chargedBytes,__freshDimensions=await __proof.readCurrentDimensions(unsignedBytes);
   if(__freshDimensions===undefined||await readCreatorOrdinaryApplicationResourceBound(__freshDimensions,__proof,unsignedBytes,input.readOrdinaryApplicationResourceBound!)===undefined)throw new Error("INCREMENTAL_EXHAUSTED_CURRENT_READOUT_UNAVAILABLE");
   if(await evaluateCreatorOrdinaryFinishingCapacity(__freshDimensions,__proof,unsignedBytes,__options)!==undefined||__proof.accounting.chargedBytes!==__exhausted)throw new Error("INCREMENTAL_CURRENT_UNKNOWN_EXHAUSTION_ACCEPTED_OR_CHARGED");
   await __proof.check();
   if(__proof.accounting.chargedBytes!==__exhausted||__futureCount()!==__futureBefore)throw new Error("INCREMENTAL_CONTROL_CHANGED_BOOK_OR_CONSTRUCTED_FUTURE");
  }catch(error){__primary=error;__failed=true;}
  try{await __proof.release();}catch(cleanup){if(__failed)throw new AggregateError([__primary,cleanup],"incremental native control and joined release failed",{cause:__primary});throw cleanup;}
  if(__failed)throw __primary;
  (globalThis as any).__warmProofEvent?.({kind:"incremental-native-current-book-control",ok:true,joined:true,noFutureConstructors:true,nativeCurrencyUnchanged:true,chargedBefore:__before,chargedAfter:__proof.accounting.chargedBytes,maxBytes:__proof.accounting.maxBytes,epoch:registration.currentTrust.currentEpoch,profileId:registration.currentTrust.profileId,phase:candidate.kind,sourcePin:${JSON.stringify(hash(raw))}});
  // Original COMPLETE factory on its own fresh, non-nested native book. All
  // original preview/material/adoption/settlement/census/source checks execute.
  // A missing/refused original result is failure, never scalar parity evidence.
  await ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))("test-only-finishing-original-factory-dominance",async()=>{
   const __factory=await prepareCreatorIssuanceMaintenanceQuote(registration,input,unsignedBytes,undefined,receivedReceipt);
   if(__factory===undefined)throw new Error("INCREMENTAL_ORIGINAL_FACTORY_UNAVAILABLE");
   const __factoryProof=__factory.proof,__factoryBefore=__factoryProof.accounting.chargedBytes;
   let __factoryPrimary:unknown,__factoryFailed=false,__factoryEnvelopes:readonly number[]|undefined,__factoryAfter=__factoryBefore;
   try{
    if(__factoryProof===__proof||__factoryProof.accounting===__proof.accounting)throw new Error("INCREMENTAL_ORIGINAL_FACTORY_BOOK_NOT_DISTINCT");
    // The original full book has a terminal-custody checker, not the ordinary
    // proof's public check method. Its existing nominal source capture brackets
    // ALL native reservations and also supports legitimate empty-history genesis.
    // Discard these data tokens; never replace the product's source cell.
    if(await captureCreatorOrdinaryIssuanceProofSource(__factoryProof)===undefined)throw new Error("INCREMENTAL_ORIGINAL_FACTORY_SOURCE_UNAVAILABLE");
    const {fields}=creatorIssuanceMaintenanceQuoteSizing(__factory,unsignedBytes);
    // Remove ONLY the optional conservative current-future/ordinary-I hint.
    // Whole material stays retained; original exact composer owns all PRE and
    // UNKNOWN occurrences. Neither factory book nor charges are reconstructed.
    const {ordinaryFinishingCapacityDimensions:__diagnostic,ordinaryChargeBasis:__ordinaryHint,...__exactFields}=fields;
    const __exact=await readProspectiveCreatorMaintenancePrefixesForSizing({...__exactFields,proof:__factoryProof,retainWholeMaterialForCapacity:true});
    if(!__exact.ok)throw new TypeError("incremental original factory prefix refused: "+__exact.reason,{cause:__exact});
    __factoryEnvelopes=Object.freeze([...__exact.fullFutureProofEnvelopeByteLengths]);
    const __valid=(values:readonly number[]|undefined)=>values!==undefined&&values.length>0&&values.every(value=>Number.isSafeInteger(value)&&value>=0);
    if(!__valid(__controlEnvelopes)||!__valid(__factoryEnvelopes)||__factoryEnvelopes.some(value=>value>Math.max(...__controlEnvelopes!)))throw new Error("INCREMENTAL_ORIGINAL_FACTORY_FULL_ENVELOPE_UNDERBOUND");
    if(await captureCreatorOrdinaryIssuanceProofSource(__factoryProof)===undefined)throw new Error("INCREMENTAL_ORIGINAL_FACTORY_SOURCE_DELIVERY_UNAVAILABLE");
    __factoryAfter=__factoryProof.accounting.chargedBytes;
    if(__factoryAfter<__factoryBefore)throw new Error("INCREMENTAL_ORIGINAL_FACTORY_BOOK_REFUNDED");
   }catch(error){__factoryPrimary=error;__factoryFailed=true;}
   try{await __factoryProof.release();}catch(cleanup){if(__factoryFailed)throw new AggregateError([__factoryPrimary,cleanup],"incremental original factory control and joined release failed",{cause:__factoryPrimary});throw cleanup;}
   if(__factoryFailed)throw __factoryPrimary;
   (globalThis as any).__warmProofEvent?.({kind:"incremental-original-factory-native-dominance",ok:true,joined:true,distinctBook:true,exactComposer:true,
    epoch:registration.currentTrust.currentEpoch,profileId:registration.currentTrust.profileId,phase:candidate.kind,
    programEnvelopeByteLengths:[...__controlEnvelopes!],originalFactoryEnvelopeByteLengths:[...__factoryEnvelopes!],chargedBefore:__factoryBefore,chargedAfter:__factoryAfter,
    qualification:"Maximum dominance of whole finishing lifetimes, not per-index phase equality. Distinct fresh original complete factory after joined runtime-only proof release, same candidate/registration/input/received receipt and original preview. Exact composer retains whole PRE/UNKNOWN; no native write, refund or authority conversion. Extra factory work is correctness-only overhead, not product latency."});
  });
 }
}finally{(globalThis as any).__warmMetricEnd?.(__incrementalControlTimer);}
`},{offset:node.end,text:`
if(__incrementalPositiveControl){if(quote===undefined||!("kind" in quote)||quote.kind!=="incremental")throw new Error("INCREMENTAL_VALID_CONTINUATION_UNAVAILABLE");(globalThis as any).__warmProofEvent?.({kind:"incremental-native-valid-continuation-control",ok:true,epoch:registration.currentTrust.currentEpoch,phase:candidate.kind});}
`});
						  }
						  if(incrementalNativeControls&&path.endsWith("/creator-close.ts")&&ts.isFunctionDeclaration(node)&&node.name?.text==="prepareCreatorIncrementalIssuanceMaintenanceQuote"&&node.body){
						   const bodyNodes:ts.Node[]=[];const collect=(child:ts.Node):void=>{bodyNodes.push(child);ts.forEachChild(child,collect);};collect(node.body);
						   const capacity=bodyNodes.filter((child):child is ts.VariableStatement=>ts.isVariableStatement(child)&&child.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="capacity"));
						   if(capacity.length!==1||!capacity[0]!.getText(ast).includes("await reserveCreatorOrdinaryFinishingCapacity("))throw new Error("INCREMENTAL_RESERVATION_CALL_SEAM_CHANGED");
						   const lastParameter=node.parameters.at(-1);
						   if(node.parameters.length!==7||lastParameter?.name.getText(ast)!=="suffix")throw new Error("INCREMENTAL_UNSPENT_PROBE_SEAM_CHANGED");
						   // Test-only branch inside the SAME existing acquisition/quote
						   // owner. No admission context is delivered. The real invocation
						   // without this private flag still spends every known/UNKNOWN
						   // occurrence and performs the original post-spend currency.
						   insertions.push({offset:lastParameter.end,text:", __nativeProbeOnly?: boolean"},
						    {offset:capacity[0]!.getStart(ast),text:`if(__nativeProbeOnly===true){
 if(suffix!==undefined)throw new Error("INCREMENTAL_UNSPENT_PROBE_SUFFIX_UNSUPPORTED");
 const __probeOptions={reader,storageIncarnation:input.storageIncarnation,actualProducerChunkBytes:131_072 as const,
  ...(input.ordinaryFinishingWindow===undefined?{}:{window:input.ordinaryFinishingWindow}),
  ...(registration.currentTrust.profileId==="creator-trusted-settlement-v1"?{settlementPreview:input.prospectiveSettlementPreview}:{})};
 const __probeReadout=await proof.readCurrentDimensions(unsignedBytes);
 if(__probeReadout===undefined||await readCreatorOrdinaryApplicationResourceBound(__probeReadout,proof,unsignedBytes,reader)===undefined||
  await evaluateCreatorOrdinaryFinishingCapacity(__probeReadout,proof,unsignedBytes,__probeOptions)===undefined)return await joinDeclined();
 await proof.check();return Object.freeze({kind:"native-probe-only",proof});
}\n`});
						  }
						  if(path.endsWith("/v3-live.ts")&&ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&
						   node.name.text==="readDimensions"&&node.initializer!==undefined&&ts.isArrowFunction(node.initializer)&&ts.isBlock(node.initializer.body)){
						   // Observe the actual old whole-context branches, not merely a
						   // wrapper whose prepared path might return earlier. No extra
						   // graph walk, parsing, native read, charge or authorization.
						   const statements:ts.Node[]=[];const collect=(part:ts.Node):void=>{statements.push(part);ts.forEachChild(part,collect);};collect(node.initializer.body);
						   const graph=statements.filter((part):part is ts.ForOfStatement=>ts.isForOfStatement(part)&&
						    part.expression.getText(ast)==="registration.closeVertices");
						   const projection=statements.filter(ts.isVariableStatement).filter(part=>
						    part.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="applicationProjection"&&
						     row.initializer!==undefined&&ts.isCallExpression(row.initializer)&&row.initializer.expression.getText(ast)==="deriveApplicationProjectionOrder"));
						   if(graph.length!==1||projection.length!==1)throw new Error("CRITICAL_ORDINARY_FULL_CONTEXT_BRANCH_CHANGED");
						   for(const [phase,statement] of [["ordinary-full-dimension-graph-reconstruction",graph[0]!],
						    ["ordinary-full-dimension-application-projection",projection[0]!]] as const){
						    criticalSites[phase]=(criticalSites[phase]??0)+1;
						    insertions.push({offset:statement.getStart(ast),text:`(globalThis as any).__warmMetricCount?.(${JSON.stringify(phase)});\n`});
						   }
						  }
						  if(path.endsWith("/creator-snapshot-data.ts")&&ts.isArrowFunction(node)&&ts.isBlock(node.body)){
						   const parent=node.parent,name=(ts.isVariableDeclaration(parent)||ts.isPropertyAssignment(parent))&&ts.isIdentifier(parent.name)?parent.name.text:undefined;
						   if(name==="record"||name==="read"||name==="selection"){
						    const id="__criticalSyntax"+node.pos,phase="maintenance-syntax-"+name;criticalSites[phase]=(criticalSites[phase]??0)+1;
						    insertions.push({offset:node.body.getStart(ast)+1,text:`\nconst ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)},0,true);try {\n`},
						     {offset:node.body.end-1,text:`\n}finally{(globalThis as any).__warmMetricEnd?.(${id});}\n`});
						   }
						  }
						  if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isFunctionExpression(node)&&ts.isBlock(node.body)&&
						   ts.isPropertyAssignment(node.parent)&&ts.isIdentifier(node.parent.name)&&node.parent.name.text==="readCurrentDimensions"){
						   const phase="maintenance-ordinary-dimension-readout";criticalSites[phase]=(criticalSites[phase]??0)+1;
						   insertions.push({offset:node.body.getStart(ast)+1,text:`\nreturn ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))(${JSON.stringify(phase)},()=>{\n`},
						    {offset:node.body.end-1,text:"\n});\n"});
						  }
						 const method=path.includes("/blueprint-fold.")&&ts.isMethodDeclaration(node)&&ts.isIdentifier(node.name)&&["apply","fork","adopt","snapshot"].includes(node.name.text)?"application-machine-"+node.name.text:undefined;
						 if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isFunctionDeclaration(node)&&
						  node.name?.text==="buildCreatorOrdinaryFinishingResourceProgramForSizing"&&node.body){
						  const declines:ts.ReturnStatement[]=[];
						  const collect=(part:ts.Node):void=>{
						   if(part!==node.body&&(ts.isFunctionDeclaration(part)||ts.isArrowFunction(part)||ts.isFunctionExpression(part)))return;
						   if(ts.isReturnStatement(part)&&part.expression?.getText(ast)==="undefined")declines.push(part);
						   ts.forEachChild(part,collect);
						  };collect(node.body);
						  for(const part of declines){
						   const line=ast.getLineAndCharacterOfPosition(part.getStart(ast)).line+1;
						   insertions.push({offset:part.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-boundary-program-declined",epoch:input.current.runtime.epoch,line:${line},sourceHash:${JSON.stringify(hash(raw))}});}catch{} `},
						    {offset:part.end,text:"}"});
						  }
						 }
						 if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))&&node.name&&node.body&&(method||(ts.isIdentifier(node.name)&&functionPhases[node.name.text]))){
						  const phase=method??functionPhases[(node.name as ts.Identifier).text]!,id="__criticalMetric"+node.pos;
						  criticalSites[phase]=(criticalSites[phase]??0)+1;
						  if(path.endsWith("/creator-closed-rollback-data.ts")&&ts.isFunctionDeclaration(node)&&node.name?.text==="captureCreatorOrdinaryIssuanceProofSource"){
						   // This async owner returns an admitted task. A body-finally ends
						   // at task construction, not joined completion; observe the actual
						   // promise without changing the product owner's pending/join logic.
						   insertions.push({offset:node.body.getStart(ast)+1,text:`\nreturn ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))(${JSON.stringify(phase)},async()=>{\n`},
						    {offset:node.body.end-1,text:"\n});\n"});
						   const calls:ts.CallExpression[]=[];const collect=(part:ts.Node):void=>{if(ts.isCallExpression(part))calls.push(part);ts.forEachChild(part,collect);};collect(node.body);
						   const selected:Record<string,string>={"custody.check":"readiness-source-complete-currency",captureCreatorOrdinaryReadOnlySourceWitnesses:"readiness-source-journal-witnesses",captureCreatorOrdinaryIssuanceRuntimeApplicationControls:"readiness-source-runtime-controls",prepareCreatorOrdinarySourceReadinessForSizing:"readiness-source-capacity-compilation"};
						   for(const call of calls){const ownerPhase=selected[call.expression.getText(ast)];if(ownerPhase)observeExpression(call,ownerPhase);}
						   ts.forEachChild(node,instrument);return;
						  }
						  if(path.endsWith("/v3-live.ts")&&ts.isFunctionDeclaration(node)&&node.name?.text==="readRetainedCloseSignedCurrentAdmission"){
						   const returns:ts.ReturnStatement[]=[];const collect=(part:ts.Node):void=>{if(ts.isReturnStatement(part))returns.push(part);ts.forEachChild(part,collect);};collect(node.body);
						   if(returns.length!==4||returns.filter(part=>part.expression?.getText(ast)==="verified").length!==1||
						    returns.some(part=>!["verified","undefined"].includes(part.expression?.getText(ast)??"")))
						    throw new Error("CRITICAL_RETAINED_SIGNED_FACT_RESULT_SEAM_CHANGED");
						   for(const part of returns)insertions.push({offset:part.getStart(ast),text:`{(globalThis as any).__warmMetricCount?.(${JSON.stringify(part.expression!.getText(ast)==="verified"?"ordinary-retained-signed-fact-hit":"ordinary-retained-signed-fact-miss")});`},
						    {offset:part.end,text:"}"});
						  }
						  if(ts.isFunctionDeclaration(node)&&["readCreatorOrdinaryApplicationResourceBound","reserveCreatorOrdinaryFinishingCapacity"].includes(node.name?.text??"")){
						   const combined=node.name!.text==="reserveCreatorOrdinaryFinishingCapacity";
						   const calls:ts.CallExpression[]=[];const collect=(child:ts.Node):void=>{if(ts.isCallExpression(child))calls.push(child);ts.forEachChild(child,collect);};collect(node.body);
						   const currency=calls.filter(call=>call.expression.getText(ast)===(combined?"owner.check":"proof.check")).sort((a,b)=>a.getStart(ast)-b.getStart(ast));
						   if(currency.length!==2||currency.some(call=>call.arguments.length!==0||!ts.isAwaitExpression(call.parent)||!ts.isExpressionStatement(call.parent.parent)))
						    throw new Error("CRITICAL_APPLICATION_GROWTH_CURRENCY_SEAMS_CHANGED");
						   observeExpression(currency[0]!,combined?"maintenance-combined-currency-initial":"maintenance-application-growth-currency-initial");
						   observeExpression(currency[1]!,combined?"maintenance-combined-currency-final":"maintenance-application-growth-currency-final");
						   // These non-async owners return joined work. Observe the actual
						   // Promise, not just synchronous task construction.
						   insertions.push({offset:node.body.getStart(ast)+1,text:`\nreturn ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))(${JSON.stringify(phase)},()=>{\n`},
						    {offset:node.body.end-1,text:"\n});\n"});
						   if(combined){
						    const returns:ts.ReturnStatement[]=[];const find=(part:ts.Node):void=>{if(ts.isReturnStatement(part)&&part.expression?.getText(ast)==="derived.capacity")returns.push(part);ts.forEachChild(part,find);};find(node.body);
						    if(returns.length!==1)throw new Error("CRITICAL_COMBINED_CAPACITY_RETURN_NOT_UNIQUE");
						    if(incrementalNativeControls){
						     const charges:ts.ForOfStatement[]=[];const findCharges=(part:ts.Node):void=>{if(ts.isForOfStatement(part))charges.push(part);ts.forEachChild(part,findCharges);};findCharges(node.body);
						     const known=charges.filter(part=>part.expression.getText(ast)==="derived.capacity.knownCarriers"),unknown=charges.filter(part=>part.expression.getText(ast)==="derived.capacity.unknownEncodedLengths");
						     if(known.length!==1||unknown.length!==1)throw new Error("INCREMENTAL_RESERVED_CHARGE_SEAMS_CHANGED");
						     const capture=calls.filter(call=>call.expression.getText(ast)==="captureCreatorOrdinaryCurrentDimensionsForSizing");
						     if(capture.length!==1||!ts.isBinaryExpression(capture[0]!.parent)||!ts.isExpressionStatement(capture[0]!.parent.parent))
						      throw new Error("INCREMENTAL_RESERVED_DIMENSION_CAPTURE_SEAM_CHANGED");
						     criticalSites["incremental-native-current-charge-control"]=1;
						     insertions.push({offset:node.body.getStart(ast)+1,text:'let __incrementalScalarControl:any,__incrementalScalarBook:number|undefined,__incrementalChargeBefore:number|undefined,__incrementalKnownAfter:number|undefined;const __incrementalFuturePhases=["maintenance-quote-prepare","maintenance-material-prepare","maintenance-material-shared-construction","maintenance-application-preview","maintenance-compose-total","maintenance-schedule"];const __incrementalFutureCount=()=>{const snapshot=(globalThis as any).__r8CriticalSnapshot?.();if(snapshot===undefined||snapshot.metricsTruncated)throw new Error("INCREMENTAL_FUTURE_OBSERVATIONS_INCOMPLETE");return snapshot.metrics.reduce((sum:number,row:any)=>sum+(__incrementalFuturePhases.includes(row.phase)?row.entered:0),0);};const __incrementalFutureBefore=__incrementalFutureCount();\n'},
						      {offset:unknown[0]!.getStart(ast),text:'__incrementalKnownAfter=proof.accounting.chargedBytes;\n'},
						      {offset:returns[0]!.getStart(ast),text:'if(__incrementalChargeBefore===undefined||__incrementalKnownAfter===undefined||proof.accounting.chargedBytes!==__incrementalKnownAfter+derived.capacity.unknownEncodedLengths.reduce((sum,length)=>sum+length,0)||__incrementalKnownAfter<__incrementalChargeBefore)throw new Error("INCREMENTAL_CURRENT_KNOWN_UNKNOWN_CHARGE_DIFFERS");if(__incrementalFutureCount()!==__incrementalFutureBefore)throw new Error("INCREMENTAL_POSITIVE_CONSTRUCTED_FUTURE");(globalThis as any).__warmProofEvent?.({kind:"incremental-native-current-charge-control",ok:true,noFutureConstructors:true,chargedBefore:__incrementalChargeBefore,knownChargedBytes:__incrementalKnownAfter-__incrementalChargeBefore,unknownOccurrenceCount:derived.capacity.unknownEncodedLengths.length,unknownChargedBytes:proof.accounting.chargedBytes-__incrementalKnownAfter,chargedAfter:proof.accounting.chargedBytes,epoch:creatorOrdinaryIssuanceSourceFacts(proof.source)?.currentTrust.currentEpoch,phase:facts!.current.runtime.kind});\n'});
						     // The runtime deliberately retains ONE current readout. Finish
						     // this genuine control before the product captures its own, so
						     // instrumentation cannot invalidate a pending product stamp.
						     // Only detached numerical results survive this control capture.
						     insertions.push({offset:capture[0]!.parent.parent.getStart(ast),text:`
await ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))("test-only-finishing-program-parity",async()=>{
 __incrementalScalarBook=proof.accounting.chargedBytes;
 // Only genuine guarded control primitives mint this test readout. Never
 // fabricate a nominal handle from the combined task's provisional facts.
 const __controlReadout=await proof.readCurrentDimensions(exactUnsignedBytes);
 if(__controlReadout===undefined||await readCreatorOrdinaryApplicationResourceBound(__controlReadout,proof,exactUnsignedBytes,options.reader)===undefined)throw new Error("INCREMENTAL_COMBINED_CONTROL_READOUT_UNAVAILABLE");
 __incrementalScalarControl=await evaluateCreatorOrdinaryFinishingCapacityScalar(__controlReadout,proof,exactUnsignedBytes,options);
 if(proof.accounting.chargedBytes!==__incrementalScalarBook)throw new Error("INCREMENTAL_FINISHING_PROGRAM_CONTROL_SPENT_BOOK");
});
`},{offset:known[0]!.getStart(ast),text:`
 const __paidBefore=proof.accounting.chargedBytes,__capacity=derived!.capacity,__scalar=__incrementalScalarControl;
 const __sameBytes=(a:Uint8Array,b:Uint8Array)=>a.byteLength===b.byteLength&&a.every((value,index)=>value===b[index]);
 const __knownCovered=__scalar!==undefined&&(options.window===undefined
  ?__scalar.knownCarriers.length===__capacity.knownCarriers.length&&__capacity.knownCarriers.every((value,index)=>__sameBytes(value,__scalar.knownCarriers[index]!))
  :__scalar.knownCarriers.every(value=>__capacity.knownCarriers.some(carrier=>__sameBytes(value,carrier))));
 if(__scalar===undefined||__scalar.fullFutureProofEnvelopeByteLengths.length!==__capacity.fullFutureProofEnvelopeByteLengths.length||
  __capacity.fullFutureProofEnvelopeByteLengths.some((value,index)=>value<__scalar.fullFutureProofEnvelopeByteLengths[index]!)||
  !__knownCovered||__scalar.unknownEncodedLengths.length!==__capacity.unknownEncodedLengths.length||
  __capacity.unknownEncodedLengths.some((value,index)=>options.window===undefined?value!==__scalar.unknownEncodedLengths[index]:value<__scalar.unknownEncodedLengths[index]!)||
  __paidBefore!==__incrementalScalarBook)throw new Error("INCREMENTAL_FINISHING_PROGRAM_NATIVE_PARITY_FAILED:"+JSON.stringify({
   window:options.window!==undefined,scalarAvailable:__scalar!==undefined,knownCovered:__knownCovered,
   programFuture:__capacity.fullFutureProofEnvelopeByteLengths,scalarFuture:__scalar?.fullFutureProofEnvelopeByteLengths,
   programUnknown:__capacity.unknownEncodedLengths,scalarUnknown:__scalar?.unknownEncodedLengths,
   programKnown:__capacity.knownCarriers.map(value=>value.byteLength),scalarKnown:__scalar?.knownCarriers.map(value=>value.byteLength),
   before:__paidBefore,expected:__incrementalScalarBook}));
 (globalThis as any).__warmProofEvent?.({kind:"incremental-finishing-program-native-parity",ok:true,epoch:creatorOrdinaryIssuanceSourceFacts(proof.source)?.currentTrust.currentEpoch,
  programEnvelopeByteLengths:[...__capacity.fullFutureProofEnvelopeByteLengths],scalarEnvelopeByteLengths:[...__scalar.fullFutureProofEnvelopeByteLengths],
  chargedBefore:__paidBefore,chargedAfter:proof.accounting.chargedBytes});
__incrementalChargeBefore=proof.accounting.chargedBytes;
`});
						    }
						    insertions.push({offset:returns[0]!.getStart(ast),text:`{const __capacity=derived!.capacity;(globalThis as any).__warmProofEvent?.({kind:"incremental-finishing-capacity-bound",owner:(globalThis as any).__warmProofIdentity?.(proof.accounting),epoch:creatorOrdinaryIssuanceSourceFacts(proof.source)?.currentTrust.currentEpoch,fullFutureProofEnvelopeByteLengths:[...__capacity.fullFutureProofEnvelopeByteLengths],chargedBytes:proof.accounting.chargedBytes,knownCarrierByteLengths:__capacity.knownCarriers.map(bytes=>bytes.byteLength),unknownEncodedLengths:[...__capacity.unknownEncodedLengths],qualification:"Four conservative complete finishing proof-lifetime envelopes after complete combined delivery,not actual encoded work,peak memory,native storage quotas or indefinite admission credit."});}\n`});
						   }
						   ts.forEachChild(node,instrument);return;
						  }
						  if(ts.isFunctionDeclaration(node)&&node.name?.text==="deriveCreatorOrdinaryApplicationResourceForSizing"){
						   const children:ts.Node[]=[];const collect=(child:ts.Node):void=>{children.push(child);ts.forEachChild(child,collect);};collect(node.body);
						   const calls=children.filter(ts.isCallExpression),
						    material=calls.filter(call=>call.getText(ast)==="creatorOrdinaryApplicationResourceInput(facts)"),
						    callback=calls.filter(call=>call.getText(ast)==="reader(input)"),
						    inputEncodes=calls.filter(call=>call.getText(ast)==="closedRetirementBytes(input)").sort((a,b)=>a.getStart(ast)-b.getStart(ast)),
						    mutation=calls.filter(call=>call.getText(ast)==="compareBytes(closedRetirementBytes(input), exactInputBytes)");
						   // Fail closed on source drift: observe the same fresh brackets,
						   // full fallback and both full/seed mutation comparisons. Warm
						   // projection reuse legitimately skips the full input/callback.
						   if(material.length!==1||!ts.isConditionalExpression(material[0]!.parent)||material[0]!.parent.whenTrue!==material[0]||
						    !ts.isVariableDeclaration(material[0]!.parent.parent)||material[0]!.parent.parent.name.getText(ast)!=="input"||
						    callback.length!==1||!ts.isCallExpression(callback[0]!.parent)||callback[0]!.parent.expression.getText(ast)!=="captureResource"||
						    !ts.isConditionalExpression(callback[0]!.parent.parent)||callback[0]!.parent.parent.whenFalse!==callback[0]!.parent||
						    callback[0]!.parent.parent.condition.getText(ast)!=="unchangedApplication"||
						    !ts.isVariableDeclaration(callback[0]!.parent.parent.parent)||callback[0]!.parent.parent.parent.name.getText(ast)!=="result"||
						    inputEncodes.length!==3||mutation.length!==2||mutation.some((call,index)=>call.arguments[0]!==inputEncodes[index+1])||
						    !ts.isBinaryExpression(inputEncodes[0]!.parent)||inputEncodes[0]!.parent.left.getText(ast)!=="exactInputBytes"||
						    inputEncodes[0]!.parent.operatorToken.kind!==ts.SyntaxKind.EqualsToken)
						    throw new Error("CRITICAL_APPLICATION_GROWTH_SUBPHASE_SEAMS_CHANGED");
						   // observeExpression returns each exact original result/Promise.
						   // The mutation phase includes its re-encode and byte comparison;
						   // all rows are inclusive elapsed metrics, not additive CPU time.
						   observeExpression(material[0]!,"maintenance-application-growth-material-preparation");
						   observeExpression(callback[0]!,"maintenance-application-growth-callback");
						   observeExpression(inputEncodes[0]!,"maintenance-application-growth-input-encode");
						   observeExpression(mutation[0]!,"maintenance-application-growth-input-mutation-compare");
						   observeExpression(mutation[1]!,"maintenance-application-growth-seed-mutation-compare");
						  }
						  if(incrementalNativeControls&&ts.isFunctionDeclaration(node)&&node.name?.text==="evaluateCreatorOrdinaryFinishingCapacity"){
						   const returns:ts.ReturnStatement[]=[];const find=(part:ts.Node):void=>{if(ts.isReturnStatement(part)&&part.expression?.getText(ast)==="derived.capacity")returns.push(part);ts.forEachChild(part,find);};find(node.body);
						   if(returns.length!==1)throw new Error("CRITICAL_STANDALONE_CAPACITY_RETURN_NOT_UNIQUE");
						   // Preserve parity for the independently delivered native control.
						   insertions.push({offset:returns[0]!.getStart(ast),text:`
await ((globalThis as any).__warmObserveMetric??((_phase:any,action:any)=>action()))("test-only-finishing-program-parity",async()=>{
 const __paidBefore=proof.accounting.chargedBytes,{knownCarriers,unknownEncodedLengths,fullFutureProofEnvelopeByteLengths:envelopes}=derived!.capacity;
 const __scalar=await evaluateCreatorOrdinaryFinishingCapacityScalar(readout,proof,unsignedBytes,options);
 const __sameBytes=(a:Uint8Array,b:Uint8Array)=>a.byteLength===b.byteLength&&a.every((value,index)=>value===b[index]);
 const __knownCovered=__scalar!==undefined&&(options.window===undefined
  ?__scalar.knownCarriers.length===knownCarriers.length&&knownCarriers.every((value,index)=>__sameBytes(value,__scalar.knownCarriers[index]!))
  :__scalar.knownCarriers.every(value=>knownCarriers.some(carrier=>__sameBytes(value,carrier))));
 if(__scalar===undefined||__scalar.fullFutureProofEnvelopeByteLengths.length!==envelopes.length||
  envelopes.some((value,index)=>value<__scalar.fullFutureProofEnvelopeByteLengths[index]!)||
  !__knownCovered||__scalar.unknownEncodedLengths.length!==unknownEncodedLengths.length||
  unknownEncodedLengths.some((value,index)=>options.window===undefined?value!==__scalar.unknownEncodedLengths[index]:value<__scalar.unknownEncodedLengths[index]!)||
  proof.accounting.chargedBytes!==__paidBefore)throw new Error("INCREMENTAL_FINISHING_PROGRAM_NATIVE_PARITY_FAILED:"+JSON.stringify({
   owner:"standalone",window:options.window!==undefined,scalarAvailable:__scalar!==undefined,knownCovered:__knownCovered,
   programFuture:envelopes,scalarFuture:__scalar?.fullFutureProofEnvelopeByteLengths,
   programUnknown:unknownEncodedLengths,scalarUnknown:__scalar?.unknownEncodedLengths,
   programKnown:knownCarriers.map(value=>value.byteLength),scalarKnown:__scalar?.knownCarriers.map(value=>value.byteLength),
   before:proof.accounting.chargedBytes,expected:__paidBefore}));
 (globalThis as any).__warmProofEvent?.({kind:"incremental-finishing-program-native-parity",ok:true,epoch:creatorOrdinaryIssuanceSourceFacts(proof.source)?.currentTrust.currentEpoch,
  programEnvelopeByteLengths:[...envelopes],scalarEnvelopeByteLengths:[...__scalar.fullFutureProofEnvelopeByteLengths],chargedBefore:__paidBefore,chargedAfter:proof.accounting.chargedBytes});
});
`});
						  }
						  const finishingSchemaOwner=ast.statements.some(part=>ts.isFunctionDeclaration(part)&&part.name?.text==="buildCreatorOrdinaryFinishingResourceProgramForSizing")
						   ?"buildCreatorOrdinaryFinishingResourceProgramForSizing":"deriveCreatorOrdinaryFinishingCapacityScalarForSizing";
						  if(ts.isFunctionDeclaration(node)&&["deriveCreatorOrdinaryFinishingCapacityForSizing",finishingSchemaOwner,"deriveCreatorOrdinarySourceResourceProgramForSizing"].includes(node.name?.text??"")){
						   const successfulReturns:ts.ReturnStatement[]=[];
						   const findSuccessfulReturn=(part:ts.Node):void=>{
						    if(ts.isReturnStatement(part)&&part.expression?.getText(ast).includes("Object.freeze({knownCarriers, unknownEncodedLengths, fullFutureProofEnvelopeByteLengths: envelopes})"))successfulReturns.push(part);
						    ts.forEachChild(part,findSuccessfulReturn);
						   };findSuccessfulReturn(node.body);
						   if(successfulReturns.length!==1)throw new Error("CRITICAL_INCREMENTAL_CAPACITY_RETURN_NOT_UNIQUE");
						   const capacityOwner=node.name!.text;
						   criticalSites["incremental-finishing-capacity-bound-observation:"+capacityOwner]=1;
						   // Pure-core results are provisional until the surrounding owner
						   // joins complete delivery currency. Do not label them accepted.
						   const boundKind=capacityOwner==="deriveCreatorOrdinarySourceResourceProgramForSizing"?"incremental-finishing-program-provisional":"incremental-finishing-capacity-provisional";
						   const context=capacityOwner==="buildCreatorOrdinaryFinishingResourceProgramForSizing"
						    ?'owner:(globalThis as any).__warmProofIdentity?.(input.source),epoch:input.current.runtime.epoch,capturedBookBytes:input.knownResourceTotals.knownBytes+input.knownResourceTotals.unknownEncodedBytes'
						    :'owner:(globalThis as any).__warmProofIdentity?.(proof.accounting),epoch:creatorOrdinaryIssuanceSourceFacts(proof.source)?.currentTrust.currentEpoch,chargedBytes:proof.accounting.chargedBytes';
						   insertions.push({offset:successfulReturns[0]!.getStart(ast),text:`(globalThis as any).__warmProofEvent?.({kind:${JSON.stringify(boundKind)},${context},fullFutureProofEnvelopeByteLengths:[...envelopes],knownCarrierByteLengths:knownCarriers.map(bytes=>bytes.byteLength),unknownEncodedLengths:[...unknownEncodedLengths],qualification:"Provisional numerical finishing proof-lifetime envelopes before complete delivery;not accepted authority,actual encoded work,peak memory,native storage quotas or indefinite admission credit."});\n`});
						  }
						  if(phase==="canonical-string-decode"){insertions.push({offset:node.body.getStart(ast)+1,text:'\n(globalThis as any).__warmMetricCount?.("canonical-string-decode");\n'});ts.forEachChild(node,instrument);return;}
						  const synchronous=!node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword);
						  if(!synchronous){
						   const collectReturns=(part:ts.Node):void=>{
						    if(part!==node.body&&(ts.isFunctionDeclaration(part)||ts.isArrowFunction(part)||ts.isFunctionExpression(part)||ts.isMethodDeclaration(part)||
						     ts.isGetAccessorDeclaration(part)||ts.isSetAccessorDeclaration(part)||ts.isConstructorDeclaration(part)))return;
						    if(ts.isReturnStatement(part)){
						     if(part.expression)insertions.push({offset:part.expression.getStart(ast),text:`((globalThis as any).__warmMetricReturned??((_token:any,value:any)=>value))(${id},`},{offset:part.expression.end,text:")"});
						     else insertions.push({offset:part.getStart(ast),text:`{(globalThis as any).__warmMetricReturned?.(${id},undefined);`},{offset:part.end,text:"}"});
						    }
						    ts.forEachChild(part,collectReturns);
						   };collectReturns(node.body);
						  }
						  insertions.push({offset:node.body.getStart(ast)+1,text:`\nconst ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)},0,${synchronous});try {\n`},
						   {offset:node.body.end-1,text:`\n}catch(error){(globalThis as any).__warmMetricFailure?.(${id});throw error;} finally {(globalThis as any).${synchronous?"__warmMetricEnd":"__warmMetricFinish"}?.(${id});}\n`});
						  if(ts.isFunctionDeclaration(node)&&(node.name?.text==="decodeCanonical"||node.name?.text==="canonicalCarrierResourceForSizing")){
						   const bytes=node.body.statements.find(row=>ts.isVariableStatement(row)&&row.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==="bytes"));
						   if(!bytes)throw new Error("CRITICAL_DECODE_BYTES_SEAM_MISSING");
						   insertions.push({offset:bytes.end,text:`\n(globalThis as any).__warmMetricBytes?.(${id},bytes.byteLength);\n`});
						  }
						  if(ts.isFunctionDeclaration(node)&&node.name?.text==="encodeCanonical")for(const row of node.body.statements)
						   if(ts.isReturnStatement(row)&&row.expression?.getText(ast)==="bytes")insertions.push({offset:row.getStart(ast),text:`\n(globalThis as any).__warmMetricBytes?.(${id},bytes.byteLength,true);\n`});
						 }
						 ts.forEachChild(node,instrument);
						};instrument(ast);
						if(/\/live-journal\/(?:dist\/)?src\/retirement\.(?:ts|js)$/u.test(path))
						 for(const phase of ["journal-retirement-full-plan-capture","journal-retirement-native-progress-decode"])
						  if(criticalSites[phase]!==1)throw new Error(`CRITICAL_JOURNAL_REPLAY_SEAM_NOT_UNIQUE:${phase}:${criticalSites[phase]??0}`);
						if(incrementalNativeControls&&path.endsWith("/creator-close.ts")){
						 // Production now imports only its combined owner. These existing
						 // independently guarded primitives are test-only negative controls.
						 insertions.push({offset:0,text:'import {readCreatorOrdinaryApplicationResourceBound,evaluateCreatorOrdinaryFinishingCapacity} from "./internal/creator-closed-rollback-data.js";\n'});
						}
						if(path.endsWith("/creator-closed-rollback-data.ts")){
						 const acquisition=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="acquireCreatorOrdinaryIssuanceMaintenanceProof");
						 const acquisitionTry=acquisition?.body?.statements.find(ts.isTryStatement);
						 if(!acquisitionTry)throw new Error("CRITICAL_ORDINARY_ACQUISITION_BODY_CHANGED");
						 const statements=acquisitionTry.tryBlock.statements;
						 const acquisitionBoundary=(prefix:string):ts.Statement=>{
						  const matches=statements.filter(statement=>statement.getText(ast).startsWith(prefix));
						  if(matches.length!==1)throw new Error(`CRITICAL_ORDINARY_ACQUISITION_BOUNDARY_CHANGED:${prefix}`);
						  return matches[0]!;
						 };
						 for(const [phase,first,after] of [
						  ["maintenance-ordinary-native-exclusion-acquire",'for (const [role, owner]',"const objectId ="],
						  ["maintenance-ordinary-source-plane-observation","const objectId =","const nativeIssuance ="],
						  ["maintenance-ordinary-row-correspondence","const nativeRows =","const accounting ="],
						  ["maintenance-ordinary-anchor-and-signing-read","for (const dependency of seed.anchorPreimages)","for (const bytes of creatorIssuanceMaintenanceObservationCarriers"],
						  ["maintenance-ordinary-observation-carriers","for (const bytes of creatorIssuanceMaintenanceObservationCarriers","frame = {ordinarySource: source"],
						 ] as const){
						  const start=acquisitionBoundary(first),stop=acquisitionBoundary(after),id="__criticalAcquisition"+start.pos;
						  if(stop.getStart(ast)<=start.getStart(ast))throw new Error(`CRITICAL_ORDINARY_ACQUISITION_REGION_REVERSED:${phase}`);
						  // Successful-region timings only. An original early refusal
						  // leaves entered>completed; no new try/finally scope or await.
						  insertions.push({offset:start.getStart(ast),text:`const ${id}=(globalThis as any).__warmMetricBegin?.(${JSON.stringify(phase)});\n`},
						   {offset:stop.getStart(ast),text:`(globalThis as any).__warmMetricEnd?.(${id});\n`});
						 }
						 for(const [phase,count] of [["maintenance-ordinary-native-issuance-capture",2],
						  ["maintenance-ordinary-current-journal-validation",1],["maintenance-ordinary-snapshot-inventory-capture",2],
						  ["maintenance-ordinary-source-anchor-read",1],["maintenance-ordinary-signing-borrow",1],
						  ["maintenance-ordinary-material-reenrollment",1]] as const)
						  if(criticalSites[phase]!==count)throw new Error(`CRITICAL_ORDINARY_ACQUISITION_SEAM_CHANGED:${phase}:${criticalSites[phase]??0}`);
						 for(const phase of ["maintenance-application-growth-currency-initial","maintenance-application-growth-currency-final",
						  "maintenance-application-growth-material-preparation","maintenance-application-growth-callback",
						  "maintenance-application-growth-input-encode","maintenance-application-growth-input-mutation-compare",
						  "maintenance-application-growth-seed-mutation-compare"])
						  if(criticalSites[phase]!==1)throw new Error(`CRITICAL_APPLICATION_GROWTH_SUBPHASE_NOT_UNIQUE:${phase}:${criticalSites[phase]??0}`);
						 if(criticalSites["source-original-current-check"]!==1)throw new Error(`CRITICAL_ORIGINAL_SOURCE_CHECK_SEAM_NOT_UNIQUE:${criticalSites["source-original-current-check"]??0}`);
						 for(const required of ["maintenance-canonical-width","maintenance-compose-total","maintenance-schedule","maintenance-generation-source-classification",
						  "maintenance-capture-proof-acquisition","maintenance-capture-closed-data",
						  "maintenance-ordinary-dimension-readout","maintenance-ordinary-dimension-owner-check","maintenance-application-growth-bound",
						  "source-owned-membership-collection","source-current-core-validation",
						  "maintenance-observe-authenticated-roles",
						  "maintenance-capture-authentication","maintenance-capture-certificate-readback","maintenance-capture-snapshot-target"])
						  if(criticalSites[required]!==1)throw new Error(`CRITICAL_FUNCTION_SEAM_NOT_UNIQUE:${required}:${criticalSites[required]??0}`);
						 // Common setup stops at the original branch-seed declaration,
						 // before synchronous schedule enumeration; recursion owns a new
						 // span. The total/COMMON/schedule inclusive times overlap.
						 const common=raw.indexOf("const commonBranchSeeds = copyProspectiveMaintenanceBranchSeeds(");
						 const compose=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="composeProspectiveCreatorMaintenancePrefixesForSizing") as ts.FunctionDeclaration|undefined;
						 if(common<0||common!==raw.lastIndexOf("const commonBranchSeeds = copyProspectiveMaintenanceBranchSeeds(")||!compose?.body)throw new Error("CRITICAL_COMMON_SETUP_SEAM_NOT_UNIQUE");
						 insertions.push({offset:compose.body.getStart(ast)+1,text:'\nconst __criticalCommon=(globalThis as any).__warmBegin?.();\n'},
						 {offset:common,text:'\nif(__criticalCommon!==undefined)(globalThis as any).__warmEnd?.("maintenance-common-setup-inclusive",__criticalCommon);\n'});
						}
						if(path.endsWith("/closed-epoch-cleanup.ts") && criticalSites["maintenance-retirement-intent-sequencing"]!==1)
						 throw new Error(`CRITICAL_RETIREMENT_INTENT_SEAM_NOT_UNIQUE:${criticalSites["maintenance-retirement-intent-sequencing"]??0}`);
						if(/\/internal\/idb-adapter\.(?:ts|js)$/.test(path)&&
						 (criticalSites["native-ahe-retirement-control"]!==1||!(criticalSites["native-ahe-complete-retirement-admission"]>0)))
						 throw new Error("CRITICAL_NATIVE_AHE_CONTROL_SEAMS_CHANGED");
						if(path.endsWith("/creator-close.ts")&&criticalSites.sealing!==1)throw Error("CRITICAL_SEQUENTIAL_SEAL_OWNER_NOT_UNIQUE");
						 if(path.endsWith("/creator-closed-rollback-data.ts")&&["reconciliation-prefix","retirement-installation",
						  "maintenance-readiness-fresh-source-baseline"].some(name=>criticalSites[name]!==1))
						  throw Error("CRITICAL_RECONCILIATION_AND_READINESS_OWNERS_NOT_UNIQUE");
						if(path.endsWith("/creator-close.ts")&&["sealing-maintenance","sealing-maintenance-turnover","sealing-maintenance-job","sealing-maintenance-pass"].some(name=>criticalSites[name]!==1))
						 throw Error("CRITICAL_SEQUENTIAL_MAINTENANCE_OWNERS_NOT_UNIQUE");
						if(path.endsWith("/v3-room.ts")&&["adoption","adoption-room","seal-room","room-lifetime-queue-waits"].some(name=>criticalSites[name]!==1))
						 throw Error("CRITICAL_SEQUENTIAL_ROOM_OWNERS_NOT_UNIQUE");
						if(path.endsWith("/v3-room.ts")&&criticalSites["adoption-settlement"]!==1)throw Error("CRITICAL_SEQUENTIAL_SETTLEMENT_OWNER_NOT_UNIQUE");
						if(path.endsWith("/v3-live.ts")){
						 for(const phase of ["ordinary-full-dimension-graph-reconstruction","ordinary-full-dimension-application-projection"])
						  if(criticalSites[phase]!==1)throw new Error(`CRITICAL_ORDINARY_FULL_CONTEXT_NOT_UNIQUE:${phase}:${criticalSites[phase]??0}`);
						 for(const phase of ["maintenance-ordinary-journal-replay-read","maintenance-ordinary-source-linked-application-read"])
						  if(criticalSites[phase]!==1)throw new Error(`CRITICAL_ORDINARY_ACQUISITION_OWNER_CHANGED:${phase}:${criticalSites[phase]??0}`);
						 if(criticalSites["recovery-census-held-journal-current-check"]!==1)throw new Error("CRITICAL_HELD_JOURNAL_CHECK_SEAM_NOT_UNIQUE");
						 if(criticalSites["recovery-census-held-journal-native-probe"]!==1)throw new Error("CRITICAL_HELD_JOURNAL_PROBE_SEAM_NOT_UNIQUE");
						 if(criticalSites["healthy-local-native-commit-completed"]!==2||criticalSites["healthy-durable-publication-ack-completed"]!==1)
						  throw new Error("CRITICAL_HEALTHY_NATIVE_COMPLETION_SEAMS_CHANGED");
						 if(criticalSites["adoption-policy-frontier-cold-member"]!==1)throw new Error("CRITICAL_ADOPTION_FRONTIER_COLD_MEMBER_SEAM_NOT_UNIQUE");
						 if(criticalSites["maintenance-capture-seal-recovery"]!==1)throw new Error(`CRITICAL_FUNCTION_SEAM_NOT_UNIQUE:maintenance-capture-seal-recovery:${criticalSites["maintenance-capture-seal-recovery"]??0}`);
						 if(criticalSites["recovery-close-complete-census-check"]!==1)throw new Error(`CRITICAL_RECOVERY_CENSUS_SEAM_NOT_UNIQUE:${criticalSites["recovery-close-complete-census-check"]??0}`);
						 const censusOwners=ast.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="readCreatorRecoveryDependencyCensus");
						 if(censusOwners.length!==1||censusOwners[0]?.body===undefined||criticalSites["recovery-complete-census-read"]!==1)throw new Error("CRITICAL_RECOVERY_CENSUS_OWNER_NOT_UNIQUE");
						 const censusBody=censusOwners[0].body,censusNodes:ts.Node[]=[];
						 const censusFirst=censusBody.statements[0],censusReturn=censusBody.statements.at(-1);
						 const collectCensus=(node:ts.Node):void=>{censusNodes.push(node);ts.forEachChild(node,collectCensus);};collectCensus(censusBody);
						 const censusDeclarations=censusBody.statements.filter(ts.isVariableStatement).flatMap(statement=>statement.declarationList.declarations.filter(declaration=>declaration.name.getText(ast)==="exactCanonicalCensusBytes"));
						 const censusConditional=censusDeclarations[0]?.initializer;
						 const captures=censusNodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&node.expression.getText(ast)==="maintenance.readBoundedRecoveryCensus");
						 const finalChecks=censusNodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&node.expression.getText(ast)==="replay.verify");
						 if(censusFirst===undefined||!ts.isVariableStatement(censusFirst)||!censusFirst.getText(ast).startsWith("const vertexFacts = creatorReplayReads.get(observation.replay)?.vertexFacts;")||
						  censusReturn===undefined||!ts.isReturnStatement(censusReturn)||!censusReturn.expression?.getText(ast).startsWith("exactCanonicalCensusBytes === undefined")||
						  censusDeclarations.length!==1||censusConditional===undefined||!ts.isConditionalExpression(censusConditional)||
						  censusConditional.condition.getText(ast)!=="live() && (await replay.verify())"||censusConditional.whenFalse.getText(ast)!=="undefined"||
						  !ts.isCallExpression(censusConditional.whenTrue)||censusConditional.whenTrue.expression.getText(ast)!=="encodeCanonical"||
						  censusConditional.whenTrue.arguments.length!==1||!ts.isObjectLiteralExpression(censusConditional.whenTrue.arguments[0]!)||
						  !censusConditional.whenTrue.arguments[0]!.getText(ast).includes("nativeIssuance:")||captures.length!==1||finalChecks.length!==1||
						  !ts.isAwaitExpression(captures[0]!.parent)||!ts.isAwaitExpression(finalChecks[0]!.parent))throw new Error("CRITICAL_RECOVERY_CENSUS_SERIALIZATION_OR_NATIVE_BOUNDARY_CHANGED");
						 // Partition this SAME fresh census owner without omitting a read.
						 // The pre-encode interval includes native capture/auth/currency and
						 // early refusals. It ends only after the original final replay gate,
						 // before constructing the serialization argument. The synchronous
						 // encode interval starts AFTER that argument is fully constructed;
						 // nested canonical metrics get this exact caller, not an async stack.
						 insertions.push({offset:censusFirst.getStart(ast),text:`
const __criticalCensusRead=(globalThis as any).__warmMetricBegin?.("recovery-complete-census-read-and-validation",0,false);
let __criticalCensusReadEnded=false;
const __criticalCensusReadEnd=()=>{if(!__criticalCensusReadEnded){__criticalCensusReadEnded=true;(globalThis as any).__warmMetricEnd?.(__criticalCensusRead);}};
try {
`},{offset:censusReturn.end,text:`
}catch(error){if(!__criticalCensusReadEnded)(globalThis as any).__warmMetricFailure?.(__criticalCensusRead);throw error;}finally{__criticalCensusReadEnd();}
`});
						 const censusEncode=censusConditional.whenTrue.expression;
						 insertions.push({offset:censusEncode.getStart(ast),text:`((__criticalCensusEncoder:typeof encodeCanonical)=>{
__criticalCensusReadEnd();
return (__criticalCensusValue:Parameters<typeof encodeCanonical>[0])=>{
 const __criticalCensusEncode=(globalThis as any).__warmMetricBegin?.("recovery-complete-census-full-encode",0,true);
 try{const bytes=__criticalCensusEncoder(__criticalCensusValue);(globalThis as any).__warmMetricBytes?.(__criticalCensusEncode,bytes.byteLength,true);return bytes;}
 catch(error){(globalThis as any).__warmMetricFailure?.(__criticalCensusEncode);throw error;}
 finally{(globalThis as any).__warmMetricEnd?.(__criticalCensusEncode);}
};})(`},{offset:censusEncode.end,text:")"});
						 observeExpression(captures[0]!,"recovery-complete-census-native-issuance-capture");
						 observeExpression(finalChecks[0]!,"recovery-complete-census-final-replay-check");
						 for(const phase of ["recovery-complete-census-read-and-validation","recovery-complete-census-full-encode"])criticalSites[phase]=1;
						 // Static SAME-owner cohorts, one observation per original call.
						 // Existing four plan timings are subdivided, not double-counted.
						 const nativeCohorts=[
						  ["selectedStore.readIssued","recovery-census-read-issued:active-source"],
						  ["registration.issuanceStore.readSettlementPlan","recovery-settlement-plan-read:unheld-fallback"],
						  ["registration.issuanceStore.readSettlementPlan","recovery-settlement-plan-read:owned-first-author"],
						  ["registration.issuanceStore.readOutboxPage","recovery-census-read-outbox-page:enumeration"],
						  ["registration.issuanceStore.readIssued","recovery-census-read-issued:visible-outbox-pair"],
						  ["readPlan","recovery-census-plan-access:inheritance-per-row"],
						  ["readPlan","recovery-census-plan-access:active-author-plan"],
						  ["readPlan","recovery-census-plan-access:completed-branch-plan"],
						  ["registration.issuanceStore.readIssued","recovery-census-read-issued:completed-branch-replacement"],
						  ["registration.issuanceStore.readLineage","recovery-census-read-lineage:settlement-author"],
						  ["registration.issuanceStore.readSettlementPlan","recovery-settlement-plan-read:settlement-author"],
						  ["registration.issuanceStore.readIssued","recovery-census-read-issued:settlement-replacement"],
						  ["registration.issuanceStore.readOutboxPage","recovery-census-read-outbox-page:settlement-replacement"],
						 ] as const;
						 const nativeNames=new Set(nativeCohorts.map(([callee])=>callee));
						 const nativeCalls=censusNodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&nativeNames.has(node.expression.getText(ast) as typeof nativeCohorts[number][0])).sort((a,b)=>a.getStart(ast)-b.getStart(ast));
						 if(nativeCalls.length!==nativeCohorts.length||nativeCalls.some((call,index)=>call.expression.getText(ast)!==nativeCohorts[index]?.[0]||
						  !(ts.isAwaitExpression(call.parent)||(index===1&&ts.isReturnStatement(call.parent)))))throw new Error("CRITICAL_RECOVERY_CENSUS_NATIVE_CALL_COHORTS_CHANGED");
						 for(const [index,call] of nativeCalls.entries())observeExpression(call,nativeCohorts[index]![1]);
						 // Logical plan accesses are not native invocations. Observe the
						 // existing hit return directly, without additional reads/copies.
						 const planGetters=censusNodes.filter((node):node is ts.VariableDeclaration=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==="readPlan");
						 const planGetter=planGetters[0]?.initializer;
						 if(planGetters.length!==1||planGetter===undefined||!ts.isArrowFunction(planGetter)||!ts.isBlock(planGetter.body))throw new Error("CRITICAL_RECOVERY_PLAN_GETTER_NOT_UNIQUE");
						 const planHits=planGetter.body.statements.filter((node):node is ts.IfStatement=>ts.isIfStatement(node)&&node.expression.getText(ast)==="reusablePlanAuthors.has(scope.author)");
						 const planHit=planHits[0]?.thenStatement;
						 if(planHits.length!==1||planHit===undefined||!ts.isBlock(planHit))throw new Error("CRITICAL_RECOVERY_PLAN_HIT_NOT_UNIQUE");
						 const planReturns=planHit.statements.filter(ts.isReturnStatement);
						 if(planReturns.length!==1||planReturns[0]?.expression===undefined)throw new Error("CRITICAL_RECOVERY_PLAN_HIT_RETURN_NOT_UNIQUE");
						 observeExpression(planReturns[0].expression,"recovery-census-plan-reuse-hit");
						 const classifiers=censusNodes.filter((node):node is ts.CallExpression=>ts.isCallExpression(node)&&node.expression.getText(ast)==="classifyPlaneVertex");
						 if(classifiers.length!==1||classifiers[0]!.arguments.length!==13||classifiers[0]!.arguments[6]?.getText(ast)!=="row.canonicalPreimageBytes"||
						  classifiers[0]!.arguments[12]?.getText(ast)!=="vertexFacts"||!ts.isVariableDeclaration(classifiers[0]!.parent)||classifiers[0]!.parent.name.getText(ast)!=="classified")throw new Error("CRITICAL_RECOVERY_CENSUS_CLASSIFICATION_COHORT_CHANGED");
						 // observeExpression preserves the original synchronous return;
						 // entered/completed count actual calls, not sampled occurrences.
						 observeExpression(classifiers[0]!,"recovery-census-classify-plane-vertex:visible-outbox");
						 const owners=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="enqueueRegistrationTask");
						 if(owners.length!==1||!ts.isFunctionDeclaration(owners[0]!)||!owners[0]!.body)throw new Error("CRITICAL_QUEUE_OWNER_NOT_UNIQUE");
						 const queueBody=(owners[0] as ts.FunctionDeclaration).body!,queueStart=queueBody.getStart(ast),queueText=raw.slice(queueStart,queueBody.end);
						 const seam=(marker:string,text:string)=>{const local=queueText.indexOf(marker);if(local<0||local!==queueText.lastIndexOf(marker))throw new Error(`CRITICAL_QUEUE_SEAM_NOT_UNIQUE:${marker}`);insertions.push({offset:queueStart+local,text});};
						 seam("const predecessor = registration.gate;",'const __criticalQueue=(globalThis as any).__warmBegin?.();\n');
						 seam("result = predecessor === undefined ? task() : predecessor.then(task);",'const __criticalTask=task; task=()=>{if(__criticalQueue!==undefined)(globalThis as any).__warmEnd?.("queue:fifo-predecessor-wait",__criticalQueue);const __criticalRun=(globalThis as any).__warmBegin?.();let __criticalResult;try{__criticalResult=__criticalTask();}catch(error){if(__criticalRun!==undefined)(globalThis as any).__warmEnd?.("queue:task-rejected-before-promise",__criticalRun);throw error;}void __criticalResult.then(()=>{if(__criticalRun!==undefined)(globalThis as any).__warmEnd?.("queue:admitted-task-inclusive",__criticalRun);},()=>{if(__criticalRun!==undefined)(globalThis as any).__warmEnd?.("queue:admitted-task-rejected-inclusive",__criticalRun);});return __criticalResult;};\n');
						}
						if(path.endsWith("/creator-close.ts")&&criticalSites["maintenance-material-prepare"]!==1)
						 throw new Error(`CRITICAL_FUNCTION_SEAM_NOT_UNIQUE:maintenance-material-prepare:${criticalSites["maintenance-material-prepare"]??0}`);
						if(incrementalNativeControls&&path.endsWith("/creator-close.ts")&&
						 criticalSites["incremental-native-pre-effect-controls"]!==2)
						 throw new Error("INCREMENTAL_NATIVE_CONTROL_CALLER_SEAMS_CHANGED");
						if(incrementalNativeControls&&path.endsWith("/creator-closed-rollback-data.ts")&&
						 criticalSites["incremental-native-current-charge-control"]!==1)
						 throw new Error("INCREMENTAL_NATIVE_CONTROL_RESERVATION_SEAMS_CHANGED");
						if(path.endsWith("/creator-transition-advance.ts")&&criticalSites["maintenance-capture-source-chain-trust"]!==1)
						 throw new Error(`CRITICAL_FUNCTION_SEAM_NOT_UNIQUE:maintenance-capture-source-chain-trust:${criticalSites["maintenance-capture-source-chain-trust"]??0}`);
						if(/\/packages\/storage-browser\/(?:dist\/)?src\/internal\/idb-adapter\.(?:ts|js)$/u.test(path)&&criticalSites["maintenance-capture-native-ahe-reader-open"]!==1)
						 throw new Error(`CRITICAL_FUNCTION_SEAM_NOT_UNIQUE:maintenance-capture-native-ahe-reader-open:${criticalSites["maintenance-capture-native-ahe-reader-open"]??0}`);
						writeFileSync(join(directory,path.replaceAll("/","_")+".critical-sites.json"),JSON.stringify(criticalSites),{flag:"wx"});
					}
					if (/\/room-head\.(?:ts|js)$/u.test(path)) {
						const offsets: number[] = [];
						const findRead = (node: ts.Node): void => {
							if (
								ts.isPropertyAssignment(node) &&
								ts.isIdentifier(node.name) &&
								node.name.text === "read" &&
								ts.isArrowFunction(node.initializer)
							) {
								const body = node.initializer.body;
								const lowered =
									ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === "__awaiter"
										? body.arguments[3]
										: undefined;
								const block = ts.isBlock(body)
									? body
									: lowered !== undefined && ts.isFunctionExpression(lowered)
										? lowered.body
										: undefined;
								const capture = block?.statements[0];
								if (capture !== undefined && capture.getText(ast).includes('inputScope(input, ["scope"])'))
									offsets.push(capture.end);
							}
							ts.forEachChild(node, findRead);
						};
						findRead(ast);
						if (offsets.length !== 1) throw new Error("STARTUP_NATIVE_HEAD_READ_OBSERVATION_NOT_UNIQUE");
						insertions.push({
							offset: requireValue(offsets[0], "unique native head offset absent"),
							text: '\n__startupEvent("floor-read", { objectId: scope.objectId });\n',
						});
					}
					// Keep only original accounting readouts after the phase diagnosis.
					if (selectedEntry === "r8-source-binding" && path.endsWith("/creator-close.ts")) {
						const marker = "const compiled = await chargeCreatorIssuanceMaintenanceQuote(cold, unsignedBytes, planEffect, capture);";
						const offset = raw.indexOf(marker);
						if (offset < 0 || offset !== raw.lastIndexOf(marker))
							throw new Error("STARTUP_MIGRATION_QUOTE_CHARGE_NOT_UNIQUE");
						insertions.push({
							offset,
							text: '\nif (Reflect.get(globalThis, "__r8TerminalContinuationDiagnostic") === true) __startupEvent("migration-proof-capture", {censusBytes:cold.proof.censusBytes.byteLength, chargedBytes:cold.proof.accounting.chargedBytes, maxBytes:cold.proof.accounting.maxBytes});\n',
						});
						insertions.push({
							offset: offset + marker.length,
							text: '\nif (Reflect.get(globalThis, "__r8TerminalContinuationDiagnostic") === true) __startupEvent("migration-proof-enforced-forecast", {chargedBytes:cold.proof.accounting.chargedBytes, maxBytes:cold.proof.accounting.maxBytes, runtimeCensusOverheadByteLength:cold.runtimeCensusOverheadByteLength});\n',
						});
					}
					const healthyBranchSites = new Map<string,number>();
					const healthyBranch = (site:string,digest:string,epoch:string,operation:string,fields=""):string => {
						healthyBranchSites.set(site,(healthyBranchSites.get(site)??0)+1);
						return `try { if(Reflect.get(globalThis,"__r8HealthyAdmissionDiagnosis")===true && Reflect.get(globalThis,"__r8HealthyAcceptedDigestPresent")?.(${digest})!==true) { const epoch=${epoch}; if(Reflect.get(globalThis,"__r8HealthyDeliveryBranchEpoch")!==epoch) { Reflect.set(globalThis,"__r8HealthyDeliveryBranchEpoch",epoch); Reflect.set(globalThis,"__r8HealthyDeliveryBranchCount",0); } const n=Number(Reflect.get(globalThis,"__r8HealthyDeliveryBranchCount")??0); Reflect.set(globalThis,"__r8HealthyDeliveryBranchCount",Math.min(n+1,33)); if(n<32) { const descriptor=Object.getOwnPropertyDescriptor(${operation},"action"); const action=descriptor!==undefined && "value" in descriptor && typeof descriptor.value==="string" ? descriptor.value.slice(0,128) : "unavailable-own-data-action"; const value={site:${JSON.stringify(site)},digest:${digest},epoch,action${fields}}; __startupEvent("healthy-delivery-branch",value); console.warn(JSON.stringify({kind:"healthy-delivery-branch",...value})); } else if(n===32) console.warn(JSON.stringify({kind:"healthy-delivery-branch",truncated:true,limit:32,epoch})); } } catch {}`;
					};
					const healthyErrorSites=new Map<string,number>();
					let completeForecastSites=0;
					let journalPrefixSites=0;
					const healthyError=(site:string,digest:string,epoch:string,action:string,error:string):string=>{
						healthyErrorSites.set(site,(healthyErrorSites.get(site)??0)+1);
						return `try { if(Reflect.get(globalThis,"__r8HealthyAdmissionDiagnosis")===true) { const n=Number(Reflect.get(globalThis,"__r8HealthyPostAuthErrorCount")??0); Reflect.set(globalThis,"__r8HealthyPostAuthErrorCount",Math.min(n+1,9)); if(n<8) { const scalar=(error:unknown,key:string,limit:number)=>{if(error===null||typeof error!=="object")return undefined;const d=Object.getOwnPropertyDescriptor(error,key);return d!==undefined&&"value" in d&&typeof d.value==="string"?d.value.slice(0,limit):undefined;}; const facts=(error:unknown,stackLimit:number)=>({name:scalar(error,"name",128),message:scalar(error,"message",512),stack:scalar(error,"stack",stackLimit)}); const caught=${error}; const nested=[]; const cause=caught!==null&&typeof caught==="object"?Object.getOwnPropertyDescriptor(caught,"cause"):undefined; if(cause!==undefined&&"value" in cause)nested.push({kind:"cause",...facts(cause.value,1024)}); const errors=caught!==null&&typeof caught==="object"?Object.getOwnPropertyDescriptor(caught,"errors"):undefined; if(errors!==undefined&&"value" in errors&&Array.isArray(errors.value)){const length=Object.getOwnPropertyDescriptor(errors.value,"length");const count=length!==undefined&&"value" in length&&typeof length.value==="number"?Math.min(length.value,2):0;for(let i=0;i<count;i++){const d=Object.getOwnPropertyDescriptor(errors.value,String(i));if(d!==undefined&&"value" in d)nested.push({kind:"aggregate",index:i,...facts(d.value,1024)});}} const suppliedAction=${action};const value={digest:${digest},epoch:${epoch},action:typeof suppliedAction==="string"?suppliedAction.slice(0,128):undefined,error:facts(caught,2048),nested}; __startupEvent(${JSON.stringify(site)},value); console.warn(JSON.stringify({kind:${JSON.stringify(site)},...value})); } } } catch {}`;
					};
					const visit = (node: ts.Node): void => {
						// Reuse the accepted warm benchmark's primitive observers.
						// Observe exact counters/numbers; never change enforcing guards.
						if (selectedEntry === "r8-source-binding") {
							// Observe the original application-contained error channel;
							// no product behavior or accepted/addition ordering changes.
							if (path.endsWith("/v3-room.ts") && ts.isExpressionStatement(node) &&
								node.getText(ast)==="acceptedOperationRows.set(addition.identity, null);") {
								insertions.push({offset:node.end,text:'\ntry { if (Reflect.get(globalThis,"__r8HealthyAdmissionDiagnosis") === true) { const n=Number(Reflect.get(globalThis,"__r8HealthyContainedErrorCount")??0); Reflect.set(globalThis,"__r8HealthyContainedErrorCount",Math.min(n+1,33)); if(n<32) { const name=Object.getOwnPropertyDescriptor(error,"name"), message=Object.getOwnPropertyDescriptor(error,"message"); __startupEvent("healthy-application-contained", {digest:addition.identity,action,name:name!==undefined && "value" in name && typeof name.value==="string" ? name.value.slice(0,128) : "TypeError",message:message!==undefined && "value" in message && typeof message.value==="string" ? message.value.slice(0,2048) : "unavailable-own-data-message"}); } } } catch {}\n'});
							}
							let owner: ts.Node | undefined = node.parent;
							while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
							const ownerName = owner && ts.isFunctionDeclaration(owner) ? owner.name?.text : undefined;
							if(path.endsWith("/v3-live.ts")) {
								if(ownerName==="handleV3IngressWithSource"&&ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="disposition"))
									insertions.push({offset:node.end,text:'\nlet __r8HealthyDeliveryStage="native-custody-check";\n'});
								if(ownerName==="handleV3IngressWithSource"&&ts.isExpressionStatement(node)&&node.getText(ast)==="disposition = await registration.onAdmittedVertex(delivery);")
									insertions.push({offset:node.getStart(ast),text:'\n__r8HealthyDeliveryStage="application-callback";\n'});
								if(ts.isFunctionDeclaration(node)&&node.name?.text==="authenticateV3Ingress"&&node.body!==undefined)
									insertions.push({offset:node.body.getStart(ast)+1,text:"\nlet __r8HealthyIngressDigest:string|undefined;let __r8HealthyIngressAction:string|undefined;\n"});
								if(ownerName==="authenticateV3Ingress"&&ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==="evidence"))
									insertions.push({offset:node.getStart(ast),text:'\ntry { __r8HealthyIngressDigest=authenticated.digest; const __r8Action=Object.getOwnPropertyDescriptor(authenticated.admitted.operation,"action"); __r8HealthyIngressAction=__r8Action!==undefined&&"value" in __r8Action&&typeof __r8Action.value==="string"?__r8Action.value:undefined; } catch {}\n'});
								if(ts.isCatchClause(node)&&node.variableDeclaration===undefined&&ts.isTryStatement(node.parent)) {
									if(ownerName==="handleV3IngressWithSource"&&node.parent.tryBlock.getText(ast).includes("disposition = await registration.onAdmittedVertex(delivery);")) {
										const args=["authenticated.digest","authenticated.admitted.epoch","Object.getOwnPropertyDescriptor(authenticated.admitted.operation,\"action\")?.value","__r8HealthyDeliveryError"] as const;
										insertions.push({offset:node.getStart(ast)+"catch".length,text:" (__r8HealthyDeliveryError)"},
											{offset:node.block.getStart(ast)+1,text:'\nif(__r8HealthyDeliveryStage==="native-custody-check") {'+healthyError("healthy-ingress-custody-check-error",...args)+'} else {'+healthyError("healthy-ingress-application-callback-error",...args)+'}\n'});
									}
									if(ownerName==="authenticateV3Ingress"&&ts.isBlock(node.parent.parent)&&ts.isFunctionDeclaration(node.parent.parent.parent)&&node.parent.parent.parent.name?.text==="authenticateV3Ingress") {
										insertions.push({offset:node.getStart(ast)+"catch".length,text:" (__r8HealthyCaughtError)"},
											{offset:node.block.getStart(ast)+1,text:"\nif(__r8HealthyIngressDigest!==undefined){"+healthyError("healthy-ingress-post-auth-error","__r8HealthyIngressDigest","registration.payload.provenance.epoch","__r8HealthyIngressAction","__r8HealthyCaughtError")+"}\n"});
									}
									if(ownerName==="handleV3IngressWithSource"&&node.parent.tryBlock.getText(ast).includes("appended = await registration.liveJournalStore.appendAccepted")) {
										insertions.push({offset:node.getStart(ast)+"catch".length,text:" (__r8HealthyJournalError)"},
											{offset:node.block.getStart(ast)+1,text:"\n"+healthyError("healthy-ingress-journal-error","authenticated.digest","authenticated.admitted.epoch","Object.getOwnPropertyDescriptor(authenticated.admitted.operation,\"action\")?.value","__r8HealthyJournalError")+"\n"});
									}
								}
							}
							if(path.endsWith("/v3-live.ts") && ownerName==="handleV3IngressWithSource") {
								if(ts.isReturnStatement(node)&&node.expression!==undefined) {
									let branch:ts.Node|undefined=node.parent;
									while(branch&&!ts.isIfStatement(branch)&&!ts.isFunctionDeclaration(branch))branch=branch.parent;
									const condition=branch&&ts.isIfStatement(branch)?branch.expression.getText(ast):undefined;
									const names:Record<string,string>={alreadyAccepted:"native-already-indexed", "!commitOperationReservation(reservation)":"native-policy-commit-refused", "!currentRegistration(registration)":"native-registration-not-current", controlOperation:"native-control-no-delivery"};
									if(condition!==undefined&&names[condition]!==undefined&&
										(condition!=="!currentRegistration(registration)"||node.expression.getText(ast)==="true")) {
										const marker=healthyBranch(names[condition]!,"authenticated.digest","authenticated.admitted.epoch","authenticated.vertex.operation",",alreadyAccepted,controlOperation");
										insertions.push({offset:node.expression.getStart(ast),text:`((()=>{${marker}})(),`},{offset:node.expression.end,text:")"});
									}
								}
								if(ts.isExpressionStatement(node)&&node.getText(ast)==="disposition = await registration.onAdmittedVertex(delivery);")
									insertions.push({offset:node.end,text:"\n"+healthyBranch("native-delivery-returned-without-callback","authenticated.digest","authenticated.admitted.epoch","authenticated.vertex.operation",",alreadyAccepted,controlOperation,dispositionKind:disposition?.kind??null")+"\n"});
							}
							if(path.endsWith("/v3-room.ts")) {
								if(ts.isIfStatement(node)&&ts.isBlock(node.thenStatement)&&node.expression.getText(ast)==="startupReplay !== undefined"&&node.thenStatement.getText(ast).includes("startupReplay.push(vertex)"))
									insertions.push({offset:node.thenStatement.getStart(ast)+1,text:"\n"+healthyBranch("room-startup-replay-buffered","hex(vertex.digest)","vertex.epoch","vertex.operation")+"\n"});
								if(ts.isIfStatement(node)&&ts.isContinueStatement(node.thenStatement)) {
									const condition=node.expression.getText(ast);
									if(condition==="candidate.has(identity)"||condition==="expanded === undefined") {
										const cache='acceptedOperationRows.get(identity)';
										const marker=healthyBranch(condition==="candidate.has(identity)"?"room-stage-existing-candidate":"room-stage-unexpanded","identity","vertex.epoch","vertex.operation",`,acceptedVerticesMembership:acceptedVertices.has(identity),selectedControlMembership:false,expandedStatus:${cache}===null?"cached-null":${cache}===undefined?"absent":"present"`);
										insertions.push({offset:node.thenStatement.getStart(ast),text:`{${marker}`},{offset:node.thenStatement.end,text:"}"});
									}
								}
								if(ts.isArrowFunction(node)&&node.body.getText(ast)==="!controls.has(hex(vertex.digest))") {
									const cache='acceptedOperationRows.get(hex(vertex.digest))';
									const marker=healthyBranch("room-stage-filtered-control","hex(vertex.digest)","vertex.epoch","vertex.operation",`,acceptedVerticesMembership:acceptedVertices.has(hex(vertex.digest)),selectedControlMembership:true,expandedStatus:${cache}===null?"cached-null":${cache}===undefined?"absent":"present"`);
									insertions.push({offset:node.body.getStart(ast),text:"(()=>{const kept="},{offset:node.body.end,text:`;if(!kept){${marker}}return kept;})()`});
								}
							}
							const emit = (offset: number, value: string): number =>
								insertions.push({
									offset,
									text: `\ntry { (globalThis as any).__warmProofEvent?.(${value}); } catch {}\n`,
								});
							if ((path.endsWith("/v3-live.ts")||path.endsWith("/creator-closed-rollback-data.ts")) &&
								ts.isReturnStatement(node)&&node.expression?.getText(ast)==="undefined") {
								let dimensionOwner:ts.Node|undefined=node.parent;
								while(dimensionOwner&&!ts.isPropertyAssignment(dimensionOwner)&&!ts.isFunctionDeclaration(dimensionOwner))dimensionOwner=dimensionOwner.parent;
								if(dimensionOwner&&ts.isPropertyAssignment(dimensionOwner)&&dimensionOwner.name.getText(ast)==="readCurrentDimensions") {
									const line=ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1;
									insertions.push({offset:node.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-dimensions-inconclusive-boundary",owner:${JSON.stringify(path.endsWith("/v3-live.ts")?"runtime":"proof")},line:${line}});}catch{} `},
										{offset:node.end,text:"}"});
								}
							}
							// Observe the demonstrated unavailable-source boundary without
							// adding native reads or changing the original fallback law.
							if (ownerName === "acquireCreatorOrdinaryIssuanceMaintenanceProof" && ts.isIfStatement(node) &&
								node.expression.getText(ast).startsWith("!closedRetirementEqual(nativeRows.plans, oldNativeRows.plans)")) {
								const predicates:ts.Expression[]=[];
								const split=(value:ts.Expression):void=>{if(ts.isBinaryExpression(value)&&value.operatorToken.kind===ts.SyntaxKind.BarBarToken){split(value.left);split(value.right);}else predicates.push(value);};
								split(node.expression);
								const reasons=["plans","control","pending-lineage","issued-outbox-correspondence"];
								if(predicates.length!==reasons.length)throw new Error("ORDINARY_NATIVE_REFUSAL_PREDICATES_CHANGED");
								predicates.forEach((predicate,index)=>insertions.push({offset:predicate.getStart(ast),text:"(("},
									{offset:predicate.end,text:`)&&(()=>{try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-source-native-refusal",reason:${JSON.stringify(reasons[index])},epoch:currentTrust.currentEpoch});}catch{}return true;})())`}));
							}
							if (ownerName === "acquireCreatorOrdinaryIssuanceMaintenanceProof" &&
								ts.isThrowStatement(node) && node.expression.getText(ast) === "unavailable") {
								const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
								insertions.push({offset:node.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-source-unavailable-boundary",line:${line},epoch:currentTrust.currentEpoch});}catch{} `},
									{offset:node.end,text:"}"});
							}
							if (ownerName === "evaluateCreatorOrdinaryFinishingCapacity" &&
								ts.isCatchClause(node)&&node.variableDeclaration===undefined) {
								insertions.push({offset:node.getStart(ast)+"catch".length,text:" (__ordinarySizingError)"},
									{offset:node.block.getStart(ast)+1,text:'try{const descriptors=__ordinarySizingError!==null&&typeof __ordinarySizingError==="object"?Object.getOwnPropertyDescriptors(__ordinarySizingError):{};const ownString=(key:string,limit:number)=>{const row=descriptors[key];return row!==undefined&&"value" in row&&typeof row.value==="string"?row.value.slice(0,limit):undefined;};(globalThis as any).__warmProofEvent?.({kind:"ordinary-finishing-caught-error",message:ownString("message",512),stack:ownString("stack",2048)});}catch{} '});
							}
							if (ownerName === "evaluateCreatorOrdinaryFinishingCapacity" &&
								ts.isReturnStatement(node) && node.expression?.getText(ast) === "undefined") {
								const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
								const generationGuard=ts.isIfStatement(node.parent)&&node.parent.expression.getText(ast).startsWith("excludedIds.size !== excluded.length");
								const tuple=generationGuard?',generations:source.generations.length,beforeBirthGenerationDrains,afterBirthGenerationDrains,excludedCount:excluded.length,excludedUniqueCount:excludedIds.size,generationReplayUnclassified:maintenance.generationReplayUnclassified,hasCurrentNativeAdvance:advance!==undefined,hasRecoverySourcePair:recoveryPair!==undefined':"";
								insertions.push({offset:node.getStart(ast),text:`{try{(globalThis as any).__warmProofEvent?.({kind:"ordinary-finishing-inconclusive-boundary",line:${line}${tuple}});}catch{} `},
									{offset:node.end,text:"}"});
							}
							if (ownerName === "createCreatorClosedRollbackProofAccounting") {
								if (
									ts.isVariableStatement(node) &&
									node.declarationList.declarations.some(
										(row) => ts.isIdentifier(row.name) && row.name.text === "unknownBytes"
									)
								)
									insertions.push({
										offset: node.end,
										text: '\nconst __warmProofOwner = (globalThis as any).__warmProofOwner?.();\ntry {(globalThis as any).__warmProofEvent?.({kind:"proof-owner-start",owner:__warmProofOwner,chargedBytes,unknownBytes,entitlement:maxBytes});}catch{}\n',
									});
								if (ts.isExpressionStatement(node) && node.getText(ast) === "chargedBytes += exactBytes.byteLength;")
									emit(
										node.end,
										'{kind:"actual-proof-charge",owner:__warmProofOwner,bytes:exactBytes.byteLength,chargedBytes,unknownBytes}'
									);
								if (ts.isExpressionStatement(node) && node.getText(ast) === "unknownBytes += length;")
									emit(
										node.end,
										'{kind:"actual-unknown-charge",owner:__warmProofOwner,bytes:length,chargedBytes,unknownBytes}'
									);
								if (
									ts.isVariableStatement(node) &&
									node.declarationList.declarations.some(
										(row) => ts.isIdentifier(row.name) && row.name.text === "accounting"
									)
								)
									insertions.push({
										offset: node.end,
										text: "\ntry {(globalThis as any).__warmBindProofOwner?.(accounting,__warmProofOwner);}catch{}\n",
									});
							}
							let sizingOwner=owner;
							while(sizingOwner && !(ts.isFunctionDeclaration(sizingOwner) && sizingOwner.name?.text==="composeProspectiveCreatorMaintenancePrefixesForSizing")) sizingOwner=sizingOwner.parent;
							if (ownerName === "composeProspectiveCreatorMaintenancePrefixesForSizing" && ts.isVariableStatement(node) &&
								node.declarationList.declarations.some(row => ts.isIdentifier(row.name) && row.name.text === "journal" &&
									row.initializer !== undefined && ts.isCallExpression(row.initializer) &&
									["journalFutureAppendPostimageWidths", "syntax.journalFutureWidths"].includes(row.initializer.expression.getText(ast)))) {
								journalPrefixSites++;
								const id = "__warmJournalPrefix" + node.pos;
								insertions.push({offset:node.getStart(ast),text:`const ${id}=(globalThis as any).__warmBegin?.();\n`},
									{offset:node.end,text:`\nif(${id}!==undefined)(globalThis as any).__warmEnd?.("creator-maintenance-journal-prefix-inclusive",${id});\n`});
							}
							if (
								(ownerName === "composeProspectiveCreatorMaintenancePrefixesForSizing" || (ownerName === "evaluateSchedule" && sizingOwner!==undefined)) &&
								ts.isVariableStatement(node) &&
								node.declarationList.declarations.some(row =>
									ts.isIdentifier(row.name) && row.name.text === "exhaustedNative" &&
									row.initializer?.getText(ast) === "nativeObservations.find(({width, maxBytes}) => width > maxBytes)"
								)
							) {
								completeForecastSites++;
								emit(
									node.getStart(ast),
									'{kind:"complete-proof-forecast",owner:(globalThis as any).__warmProofIdentity?.(input.proof.accounting),currentEpoch:forward.currentTrust.currentEpoch,preclose,adoptionDrain,generationOnly,entitlement:input.proof.accounting.maxBytes,maintenanceEntitlement:CREATOR_MAINTENANCE_PROOF_MAX_BYTES,currentJobPhaseCount:currentJobProofEnvelopeByteLengths.length,currentJobJournalComputations:currentJobJournal===undefined?0:currentJobJournal.jobIndex+1,nativeObservations:[...nativeObservations],fullFutureProofEnvelopeByteLengths:[...fullFutureProofEnvelopeByteLengths]}'
								);
							}
							if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
								const phases: Record<string, string> = {
									"consumer": "creator-maintenance-admission-inclusive",
									"maintenanceAdmission.beginWrite": "creator-maintenance-write-reservation-inclusive",
									"registration.sealIssuanceMaintenanceDependencies": "creator-maintenance-dependency-hold-inclusive",
									"acquireCreatorIssuanceMaintenanceProof": "creator-maintenance-proof-capture-inclusive",
									"prepareCreatorIssuanceMaintenanceQuote": "creator-maintenance-quote-inclusive",
									"chargeCreatorIssuanceMaintenanceQuote": "creator-maintenance-forecast-and-reservation-inclusive",
									"readProspectiveCreatorMaintenancePrefixesForSizing": "creator-maintenance-prefix-sizing-inclusive",
									"receiveCreatorSuccessorAdoption": "receive-authentication-retention-inclusive",
									"transfer.receiveBytes": "snapshot-byte-transfer-and-native-verification-inclusive",
									"verifySnapshot": "snapshot-decode-verification-inclusive",
									"drainRebaseOutbox": "settlement-rebase-inclusive",
									"drainSettlementOutbox": "settlement-plan-and-fence-inclusive",
									"cleanupCreatorSettlementSuccessor": "settlement-native-cleanup-inclusive",
									"publishAccepted": "accepted-publication-inclusive",
								};
								const phase = phases[node.expression.expression.getText(ast)];
								let statement: ts.Node = node;
								while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
								const direct =
									(ts.isVariableStatement(statement) &&
										statement.declarationList.declarations.some((row) => row.initializer === node)) ||
									(ts.isExpressionStatement(statement) &&
										(statement.expression === node ||
											(ts.isBinaryExpression(statement.expression) && statement.expression.right === node)));
								if (phase && direct && ts.isBlock(statement.parent)) {
									const id = "__warmNativePhase" + node.pos;
									insertions.push({
										offset: statement.getStart(ast),
										text: `const ${id}=(globalThis as any).__warmBegin?.();\n`,
									});
									insertions.push({
										offset: statement.end,
										text: `\nif(${id}!==undefined)(globalThis as any).__warmEnd?.(${JSON.stringify(phase)},${id});\n`,
									});
								}
							}
						}
						if (
							ts.isFunctionDeclaration(node) &&
							node.name !== undefined &&
							functions.has(node.name.text) &&
							node.body !== undefined
						) {
							const name = node.name.text;
							let text = `\n__startupEvent(${JSON.stringify(name)});`;
							if (name === "publishStagedCreatorSuccessorAdoption")
								text += `\nif (__startupControl.publicationFault) { __startupControl.publicationFault = false; __startupEvent("publication-fault"); return Promise.resolve(Object.freeze({ok:false, kind:"startup-injected-publication"})); }`;
							insertions.push({ offset: node.body.getStart(ast) + 1, text });
						}
						ts.forEachChild(node, visit);
					};
					visit(ast);
					if(selectedEntry==="r8-source-binding"&&path.endsWith("/internal/creator-closed-rollback-data.ts")&&completeForecastSites!==1)
						throw new Error(`HEALTHY_COMPLETE_FORECAST_SEAM_NOT_UNIQUE:${completeForecastSites}`);
					if(selectedEntry==="r8-source-binding"&&path.endsWith("/internal/creator-closed-rollback-data.ts")&&journalPrefixSites!==1)
						throw new Error(`HEALTHY_JOURNAL_PREFIX_SEAM_NOT_UNIQUE:${journalPrefixSites}`);
					if(selectedEntry==="r8-source-binding"&&(path.endsWith("/v3-live.ts")||path.endsWith("/v3-room.ts"))) {
						const expected=path.endsWith("/v3-live.ts")?["native-already-indexed","native-policy-commit-refused","native-registration-not-current","native-control-no-delivery","native-delivery-returned-without-callback"]:["room-startup-replay-buffered","room-stage-existing-candidate","room-stage-unexpanded","room-stage-filtered-control"];
						for(const site of expected)if(healthyBranchSites.get(site)!==1)throw new Error(`HEALTHY_DELIVERY_BRANCH_SEAM_NOT_UNIQUE:${site}:${healthyBranchSites.get(site)??0}`);
						if(path.endsWith("/v3-live.ts"))for(const site of ["healthy-ingress-post-auth-error","healthy-ingress-journal-error","healthy-ingress-custody-check-error","healthy-ingress-application-callback-error"])
							if(healthyErrorSites.get(site)!==1)throw new Error(`HEALTHY_POST_AUTH_ERROR_SEAM_NOT_UNIQUE:${site}:${healthyErrorSites.get(site)??0}`);
					}
					if (pendingPublication && path.endsWith("/creator-adoption.ts")) {
						const offsets: number[] = [];
						const capture = (node: ts.Node): void => {
							if (
								ts.isTryStatement(node) &&
								node.tryBlock.statements[0] !== undefined &&
								ts.isIfStatement(node.tryBlock.statements[0]) &&
								node.tryBlock.statements[0].expression.getText(ast) === "nativeFuture !== undefined"
							)
								offsets.push(node.getStart(ast));
							else ts.forEachChild(node, capture);
						};
						const pending = ast.statements.find(
							(node) => ts.isFunctionDeclaration(node) && node.name?.text === "recoverPendingCreatorSuccessorMaterial"
						);
						if (pending !== undefined) capture(pending);
						if (offsets.length !== 1) throw new Error("STARTUP_PENDING_PUBLICATION_READINESS_SEAM_NOT_UNIQUE");
						insertions.push({
							offset: requireValue(offsets[0], "unique pending publication offset absent"),
							text: '\nconst __r8SnapshotRouting = Reflect.get(globalThis, "__r8InheritedSnapshotNamespace"); __startupEvent("pending-publication-readiness", {status: await input.snapshotStore.recoveryStatus(), expectedHead: previous, candidateHead: selected.head, floor: __r8SnapshotRouting === undefined ? undefined : await __r8SnapshotRouting.readFloor(), applicationImage: __r8SnapshotRouting === undefined ? undefined : await __r8SnapshotRouting.readApplication()});\n',
						});
					}
					if (pendingPublication && path.endsWith("/packages/node/src/v3-room.ts")) {
						// The fixture inherited namespace contains genuine individually
						// received v1 rows. Route only this room's two original snapshot
						// constructors; all other native stores/owner identities stay put.
						const names: ts.Expression[] = [];
						const recoveryResults: number[] = [];
						const captureNames = (node: ts.Node): void => {
							if (
								ts.isVariableDeclaration(node) &&
								node.name.getText(ast) === "recoveredHead" &&
								node.initializer?.getText(ast).includes("recoveredPending") &&
								node.parent.parent !== undefined
							)
								recoveryResults.push(node.parent.parent.getStart(ast));
							if (
								ts.isCallExpression(node) &&
								node.expression.getText(ast) === "createBrowserSnapshotQuarantineStore"
							) {
								const argument = node.arguments[0];
								if (argument !== undefined && ts.isObjectLiteralExpression(argument))
									for (const property of argument.properties)
										if (
											ts.isPropertyAssignment(property) &&
											property.name.getText(ast) === "primaryDatabaseName" &&
											property.initializer.getText(ast) === "input.databaseName"
										)
											names.push(property.initializer);
							}
							ts.forEachChild(node, captureNames);
						};
						captureNames(ast);
						if (names.length !== 2) throw new Error("STARTUP_PENDING_SNAPSHOT_NAMESPACE_SEAM_NOT_UNIQUE");
						if (recoveryResults.length !== 1) throw new Error("STARTUP_PENDING_RECOVERY_RESULT_SEAM_NOT_UNIQUE");
						insertions.push({
							offset: requireValue(recoveryResults[0], "unique pending recovery offset absent"),
							text: '\nconst __r8PendingCause = Reflect.get(recoveredPending, "cause"); __startupEvent("pending-recovery-result", {result: recoveredPending, cause: __r8PendingCause instanceof Error ? {name: __r8PendingCause.name, message: __r8PendingCause.message, stack: __r8PendingCause.stack, result: Reflect.get(__r8PendingCause, "result")} : __r8PendingCause});\n',
						});
						for (const name of names) {
							insertions.push({
								offset: name.getStart(ast),
								text: '((__r8OriginalName: string) => { const configured = Reflect.get(globalThis, "__r8InheritedSnapshotNamespace"); return configured?.roomIdentity === __r8OriginalName ? configured.snapshotIdentity : __r8OriginalName; })(',
							});
							insertions.push({ offset: name.end, text: ")" });
						}
					}
					if (path.endsWith("/v3-live.ts")) {
						if (selectedEntry === undefined) {
							const catches = [...raw.matchAll(/const issuanceOutcomeUnknown =/gu)];
							const site = catches[0]?.index;
							if (catches.length !== 1 || site === undefined)
								throw new Error("STARTUP_TERMINAL_ISSUANCE_CATCH_NOT_UNIQUE");
							insertions.push({
								offset: site,
								text: '\nconsole.error(JSON.stringify({lane:"native-issue-error", error:String(error), code:error !== null && typeof error === "object" ? Reflect.get(error,"code") : undefined, stack:error instanceof Error ? error.stack : undefined, terminalTransactionStarted, cryptoEntered, signerResolved}));\n',
							});
						}
						if (selectedEntry === "r8-source-binding") {
							// Existing public terminal refusal deliberately hides native
							// transaction uncertainty. Observe the original catch only;
							// never change its classification, effects or lifetime.
							const terminalCatch = [...raw.matchAll(/const issuanceOutcomeUnknown =/gu)];
							if (terminalCatch.length !== 1) throw new Error("STARTUP_TERMINAL_ISSUANCE_CATCH_NOT_UNIQUE");
							insertions.push({
								offset: requireValue(
									requireValue(terminalCatch[0], "unique terminal catch absent").index,
									"terminal catch offset absent"
								),
								text: '\nif (requireTerminalAuthorization || Reflect.get(globalThis, "__r8TerminalContinuationDiagnostic") === true) __startupEvent("terminal-native-issue-error", {error:String(error), stack:error instanceof Error ? error.stack : undefined, terminalTransactionStarted, cryptoEntered, signerResolved});\n',
							});
							// Reuse this launcher's primitive observer at the ORIGINAL
							// nonempty dependency/native-census consumers. No new read,
							// future authority, encoding copy or lifetime boundary.
							const resourceSites: { offset: number; text: string }[] = [];
							for (const declaration of ast.statements) {
								if (!ts.isFunctionDeclaration(declaration) || declaration.body === undefined) continue;
								for (const statement of declaration.body.statements) {
									// The dependency charge is inside the function's original try.
									if (declaration.name?.text === "withActiveRebaseDependencies" && ts.isTryStatement(statement)) {
										for (const inner of statement.tryBlock.statements)
											if (
												ts.isIfStatement(inner) &&
												inner.expression.getText(ast) === "!accounting.charge(exactCensus)"
											) {
												resourceSites.push({
													offset: inner.end,
													text: '\n__startupEvent("active-rebase-proof-charge", {objectId: registration.payload.provenance.objectId, epoch: registration.payload.provenance.epoch, proofByteCharge: accounting.chargedBytes, proofLimit: accounting.maxBytes, ownedIssue: ownedIssueCustody !== undefined});\n',
												});
											}
									}
									if (declaration.name?.text === "ownedReplacementSignContext" && ts.isReturnStatement(statement)) {
										resourceSites.push({
											offset: statement.getStart(ast),
											text: '\n__startupEvent("replacement-native-census", {objectId: registration.payload.provenance.objectId, epoch: registration.payload.provenance.epoch, logicalBytes: census.image.logicalBytes, issuedCount: census.image.issuedCount, outboxCount: census.image.outboxCount, planCount: census.image.planCount, maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes, intentCount: derived.operations.length, replacementChunks: entry.replacementProgress?.chunks.length ?? 0, creatorMaintenanceBound: registration.creatorMaintenanceBound});\n',
										});
									}
								}
							}
							if (resourceSites.length !== 2) throw new Error("STARTUP_SOURCE_RESOURCE_CONSUMERS_NOT_UNIQUE");
							insertions.push(...resourceSites);
						}
						const marker = "signerResolved = true;";
						const offsets = [...raw.matchAll(/signerResolved = true;/gu)].map(
							(match) => requireValue(match.index, "STARTUP_FIXTURE_PRECONDITION") + marker.length
						);
						if (offsets.length !== 2) throw new Error("STARTUP_POST_SIGN_FAULT_SEAM_NOT_UNIQUE");
						for (const offset of offsets)
							insertions.push({
								offset,
								text: '\nif (__startupControl.issueAfterSignFault && planEffect?.kind === "fence") { __startupControl.issueAfterSignFault = false; __startupEvent("issue-after-sign-fault"); throw new Error("STARTUP_SETTLEMENT_SIGNED_ISSUE_FAILURE"); }',
							});
					}
					if (criticalProfiling) addCanonicalCallsites(codecSites, insertions);
					const code = applyObservationInsertions(raw, insertions);
					const label = (criticalProfiling?hash(path).slice(0,16)+"-":"")+requireValue(path.split("/").at(-1), "STARTUP_FIXTURE_PRECONDITION");
					if (criticalProfiling) writeFileSync(join(directory, label + ".canonical-callsite-manifest.json"), JSON.stringify({
						sourceHash: hash(raw), source: path.startsWith(root + "/") ? path.slice(root.length + 1) : path,
						count: codecSites.length, sites: codecSites,
						qualification:"Static decode/encode callee callsites only; existing synchronous codec metrics retain original counts/bytes/time. No asynchronous causal attribution."}), {flag:"wx"});
					writeFileSync(join(directory, label + ".raw"), raw, { flag: "wx" });
					writeFileSync(join(directory, label + ".observed"), code, { flag: "wx" });
					writeFileSync(join(directory, label + ".insertions.json"), JSON.stringify(insertions), { flag: "wx" });
					return { contents: code, loader: "ts", resolveDir: dirname(path) };
				}
			);
		},
	};
}
const loaded = (await import(new URL("../../../vite.config.mts", import.meta.url).href)) as {
	workspaceAliases: Record<string, string>;
};
const alias = { ...loaded.workspaceAliases };
if (selectedEntry === "r8-source-binding") {
	for (const [name, file] of [
		["node", "packages/node/src/index.ts"],
		["types", "packages/types/src/index.ts"],
		["storage-browser", "packages/storage-browser/src/index.ts"],
		["storage-browser/issuance", "packages/storage-browser/src/issuance.ts"],
		["storage-browser/live-journal", "packages/storage-browser/src/live-journal.ts"],
		["storage-browser/room-head", "packages/storage-browser/src/room-head.ts"],
		["storage-browser/snapshot-transfer", "packages/storage-browser/src/snapshot-transfer.ts"],
		["storage-browser/seal-signing", "packages/storage-browser/src/seal-signing.ts"],
		["live-journal", "packages/live-journal/src/index.ts"],
		["issuance-store/maintenance", "packages/issuance-store/src/maintenance.ts"],
		["example-v3-room", "examples/v3-room/src/index.ts"],
		["message-queue", "packages/message-queue/src/index.ts"],
		["node/snapshot-transfer", "packages/node/src/snapshot-transfer.ts"],
	])
		alias["@ts-drp/" + name] = join(root, file);
}
for (const name of [
	"creator-adoption",
	"creator-adoption-activate",
	"creator-adoption-commit",
	"creator-adoption-recover",
	"creator-adoption-stage",
	"creator-close",
	"v3-live",
])
	alias["@ts-drp/node/" + name] = join(root, "packages/node/src", name + ".ts");
const entries = [];
for (const name of selectedEntry === undefined ? ["setup", "recovery", "lifecycle", "shipped"] : [selectedEntry]) {
	const archive = join(destination, name);
	mkdirSync(archive);
	const native = selectedEntry === undefined ? pendingNativeTransform("browser", join(archive, "native")) : undefined;
	// Entry observers emit distinct immutable archives for each actual executable.
	const result = await build({
		entryPoints: [join(root, "tests/fixtures/startup-discovery", name + ".ts")],
		alias,
		nodePaths: [join(root, "packages/storage-browser/node_modules")],
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "es2022",
		write: false,
		metafile: true,
		sourcemap:criticalProfiling?"inline":false,
		plugins: [
			{
				name: "current-chat-catalog-entry",
				setup(context): void {
					// Match the existing current-source lane: never combine generated
					// JS and TS copies of the SDK/protocol singleton owners. Native
					// dist stores have no sibling TS and retain their original observers.
					context.onResolve({ filter: /^\..*\.js$/ }, (args) => {
						const source = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
						return source.startsWith(join(root, "packages") + "/") && existsSync(source) ? { path: source } : undefined;
					});
					// Current measurements share the tested bounded observer, while
					// the accepted historical corpus/transport files stay immutable.
					context.onResolve({filter: /^(?:\.\/critical-observer\.js|\.\/observer\.js)$/}, (args) =>
						args.importer === join(root, "tests/fixtures/startup-discovery/healthy-grid.ts") ||
						args.importer === join(root, ".logs/bounded-storage-lifecycle/r8-warm-capacity-01/worker-transport.ts")
							? {path: join(root, "tests/fixtures/startup-discovery/critical-observer.ts")} : undefined);
					context.onResolve({ filter: /^\.\.\/.*examples\/v3-chat\/src\/index\.js$/ }, (args) => ({
						path: resolve(args.resolveDir, args.path.slice(0, -3) + ".ts"),
					}));
					context.onResolve({ filter: /^@ts-drp\/blueprint-catalog\/bytes$/ }, () => ({
						path: join(root, "packages/blueprint-catalog/src/bytes.ts"),
					}));
				},
			} satisfies Plugin,
			...(migrationFault === undefined
				? []
				: [observation(archive, migrationFault === "after-apply", migrationFault === "pending-publication")]),
			...(selectedEntry === "r8-source-binding" && migrationFault === undefined ? [observation(archive)] : []),
			...(native === undefined
				? [
						{
							name: "current-source-native-entry",
							setup(context): void {
								// Reuse the original SQLite scenario with native IndexedDB
								// factories only; protocol/authentication code is unchanged.
								if (selectedEntry === "r8-source-binding") {
									context.onResolve({ filter: /^node:assert\/strict$/ }, (args) =>
										args.importer ===
										join(root, ".logs/bounded-storage-lifecycle/r8-warm-capacity-01/worker-transport.ts")
											? { path: join(root, "tests/fixtures/startup-discovery/browser-strict-assert.ts") }
											: undefined
									);
									context.onResolve({ filter: /^node:worker_threads$/ }, (args) =>
										args.importer ===
										join(root, ".logs/bounded-storage-lifecycle/r8-warm-capacity-01/worker-transport.ts")
											? { path: join(root, "tests/fixtures/startup-discovery/browser-parent-port.ts") }
											: undefined
									);
									context.onResolve({ filter: /^\.\/native-backend\.js$/ }, (args) =>
										args.resolveDir === join(root, "tests/fixtures/phase-3g")
											? { path: join(args.resolveDir, "native-backend.browser.ts") }
											: undefined
									);
									context.onResolve({ filter: /^node:crypto$/ }, (args) =>
										args.importer === join(root, "tests/fixtures/phase-3a0-v3/controlled-anchor-trust.ts")
											? {
													path: realpathSync(
														join(
															root,
															"node_modules/.pnpm/crypto-browserify@3.12.1/node_modules/crypto-browserify/index.js"
														)
													),
												}
											: undefined
									);
								}
								context.onResolve({ filter: /^\..*\.js$/ }, (args) => {
									const source = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
									const current =
										source.startsWith(join(root, "packages") + "/") ||
										source.startsWith(join(root, "tests/fixtures/phase-3g") + "/") ||
										source === join(root, "tests/fixtures/phase-3a0-v3/controlled-anchor-trust.ts");
									return current && existsSync(source) ? { path: source } : undefined;
								});
							},
						} satisfies Plugin,
						NodeGlobalsPolyfillPlugin({ buffer: true, process: true }),
						NodeModulesPolyfillPlugin(),
					]
				: [observation(archive), native.plugin]),
			{
				name: "shipped-grid-raw-kernel",
				setup(context): void {
					context.onLoad({ filter: /\?raw$/ }, ({ path }) => ({
						contents: "export default " + JSON.stringify(readFileSync(path.slice(0, -4), "utf8")),
						loader: "js",
					}));
					context.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path) }));
				},
			},
		],
	});
	let bytes = requireValue(result.outputFiles[0], "STARTUP_FIXTURE_PRECONDITION").contents;
	if (fullFunctionCalls) {
		writeFileSync(join(archive, "entry.before-full-calls.mjs"), bytes, {flag: "wx"});
		const instrumented = instrumentFullFunctionBundle(Buffer.from(bytes).toString("utf8"), clockedFunctionOwners);
		writeFileSync(join(archive, "full-call-manifest.json"), JSON.stringify(instrumented.manifest), {flag: "wx"});
		writeFileSync(join(archive, "full-call-input-sourcemap.json"), JSON.stringify(instrumented.sourceMap), {flag: "wx"});
		bytes = Buffer.from(instrumented.code);
	}
	writeFileSync(join(archive, "entry.mjs"), bytes, { flag: "wx" });
	writeFileSync(join(archive, "metafile.json"), JSON.stringify(result.metafile), { flag: "wx" });
	entries.push({
		name,
		sha256: hash(bytes),
		native: native?.finish() ?? null,
		...(selectedEntry === undefined
			? {}
			: {
					inputs: Object.keys(requireValue(result.metafile, "STARTUP_FIXTURE_PRECONDITION").inputs).map((file) => {
						const virtual = /^node-modules-polyfills(?:-commonjs)?:/.test(file);
						const source = virtual
							? requireValue(
									builtinsPolyfills().get(file.slice(file.indexOf(":") + 1)),
									"STARTUP_VIRTUAL_MODULE_SOURCE_REQUIRED"
								)
							: resolve(root, file.replace(/\?raw$/u, ""));
						const actual = realpathSync(source);
						const generator = virtual
							? realpathSync(join(root, "node_modules/@esbuild-plugins/node-modules-polyfill/dist/index.js"))
							: undefined;
						return {
							file,
							actual,
							sha256: hash(readFileSync(actual)),
							external: !actual.startsWith(realpathSync(root) + "/"),
							...(generator === undefined
								? {}
								: { virtual: true, generator: { actual: generator, sha256: hash(readFileSync(generator)) } }),
						};
					}),
				}),
	});
}
writeFileSync(join(destination, "artifacts.json"), JSON.stringify({ entries }), { flag: "wx" });
console.log(JSON.stringify({ destination, entries }));
