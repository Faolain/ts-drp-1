import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
	BATCH_OPTIONS,
	BINDING_MUTATIONS,
	CALL_BINDINGS,
	CONFORMING_OPERATIONS,
	D93_56_HISTORY_LEAF_CANONICAL_HEX,
	DOMAIN,
	DRIVER_CONTRACT_IMPORTS,
	DRIVER_NAMESPACE_IMPORTS,
	EXCLUDED_BEHAVIORS,
	EXECUTED_REFERENCE_CLOSURE,
	EXPANDED_GRAPH_COUNT,
	EXPANDED_PERMUTATION_COUNT,
	EXPANDED_RELATION_OBSERVATION_COUNT,
	EXPANDED_SEED,
	EXPANDED_TRANSCRIPT_SHA256,
	EXPANDED_VALUE_COUNT,
	HASH_DOMAINS,
	HASH_PART_BOUNDARY_LENGTHS,
	materializePeerSlots,
	MERKLE_BOUNDARY_SIZES,
	MUTATION_KINDS,
	ORDER_OPTIONS,
	ORDINARY_GRAPH_COUNT,
	ORDINARY_MERKLE_BOUNDARY_SIZES,
	ORDINARY_PERMUTATION_COUNT,
	ORDINARY_RELATION_OBSERVATION_COUNT,
	ORDINARY_TRANSCRIPT_SHA256,
	type PeerSlot,
	type PeerSlots,
	RANGE_START,
	REFERENCE_LOCK_ENTRIES,
	REFERENCE_LOCK_SHA256,
	type ReferenceConformanceDriverModule,
	transcriptSha256,
} from "./fixtures/phase-3-exit-reference-conformance/contract.js";
import {
	bytesEqual,
	compareBytes,
	deterministicValues,
	domainHash,
	expectedAncestor,
	expectedRelated,
	hex,
	rfcAccumulatorSnapshot,
	rfcConsistencyPath,
	rfcInclusionPath,
	rfcLeafHash,
	rfcNodeHash,
	rfcRoot,
	semanticEqual,
} from "./fixtures/phase-3-exit-reference-conformance/oracle.js";
import type { EpochVertex } from "../packages/compaction/tests/contract.js";
import {
	enumerateCorpus,
	hashForIndex,
	insertionPermutations,
	makeGraph,
	NIGHTLY_CORPUS_COUNT,
	PR_CORPUS_COUNT,
	referenceOrder,
} from "../packages/compaction/tests/corpus.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const REFERENCE_DIRECTORY = path.join(ROOT, "packages/protocol-v2/conformance/ahe-reference/src");
const REFERENCE_LOCK_PATH = path.join(ROOT, "packages/protocol-v2/conformance/reference.lock.json");
const DRIVER_PATH = path.join(ROOT, "tests/fixtures/phase-3-exit-reference-conformance", ["dri", "ver.ts"].join(""));
const DRIVER_URL = pathToFileURL(DRIVER_PATH).href;
const RUN_EXPANDED = process.env.RUN_PHASE_3_EXIT_REFERENCE_CONFORMANCE === "true";

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function executedReferenceClosure(entrypoints: readonly string[]): readonly string[] {
	const pending = [...entrypoints];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const fileName = pending.pop() as string;
		if (visited.has(fileName)) continue;
		visited.add(fileName);
		const source = readFileSync(path.join(REFERENCE_DIRECTORY, fileName), "utf8");
		for (const match of source.matchAll(/from\s+["']\.\/([^"']+\.js)["']/gu)) {
			const dependency = match[1];
			if (dependency !== undefined) pending.push(dependency);
		}
	}
	return [...visited].sort();
}

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("expected lowercase even-length hex");
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
	);
}

async function loadDriver(): Promise<ReferenceConformanceDriverModule | undefined> {
	try {
		return (await import(DRIVER_URL)) as ReferenceConformanceDriverModule;
	} catch (error) {
		const message = typeof error === "object" && error !== null ? String(Reflect.get(error, "message")) : "";
		const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
		const exactNodeMiss =
			code === "ERR_MODULE_NOT_FOUND" &&
			(message.includes(`Cannot find module '${DRIVER_PATH}'`) ||
				message.includes(`Cannot find module '${DRIVER_URL}'`));
		const exactViteMiss =
			message.includes(`Failed to load url ${DRIVER_PATH}`) && message.includes("Does the file exist?");
		if (exactNodeMiss || exactViteMiss) return undefined;
		throw error;
	}
}

function baseSlot(graph: Map<string, EpochVertex>, order: readonly string[]): PeerSlot {
	const leaves = Array.from({ length: 9 }, (_, index) => new TextEncoder().encode(`phase-3-exit-e-${index}`));
	const firstSize = 4;
	const inclusionIndex = 3;
	const inclusionPath = rfcInclusionPath(leaves, inclusionIndex);
	return {
		aliasedInclusionProof: {
			auditPath: inclusionPath,
			leafIndex: 2 ** 32 + inclusionIndex,
			treeSize: 2 ** 32 + leaves.length,
		},
		anchorHash: order[0] as string,
		compareLeft: Uint8Array.of(0, 1, 2),
		compareRight: Uint8Array.of(0, 1, 3),
		decodeBytes: Uint8Array.of(0),
		firstRoot: rfcRoot(leaves.slice(0, firstSize)),
		firstSize,
		graph,
		hashDomain: DOMAIN,
		hashParts: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
		inclusionIndex,
		inclusionProof: {
			auditPath: inclusionPath,
			leafIndex: inclusionIndex,
			treeSize: leaves.length,
		},
		leaves,
		linearizeOptions: Object.freeze({ anchorHash: order[0] as string, mode: "none", vertices: graph }),
		missingResolverOptions: Object.freeze({ anchorHash: order[0] as string, mode: "pair", vertices: graph }),
		order: [...order],
		proofPath: rfcConsistencyPath(leaves, firstSize),
		queryLeft: order[0] as string,
		queryRight: order.at(-1) as string,
		secondRoot: rfcRoot(leaves),
		value: new Map<unknown, unknown>([["nested", { bytes: Uint8Array.of(5, 6, 7), values: [1, 2, 3] }]]),
	};
}

function hashPartsForCase(index: number): Uint8Array[] {
	return Array.from({ length: index % 5 }, (_, partIndex) => {
		const length = HASH_PART_BOUNDARY_LENGTHS[(index + partIndex * 7) % HASH_PART_BOUNDARY_LENGTHS.length] as number;
		return Uint8Array.from({ length }, (_value, offset) => (index * 31 + partIndex * 17 + offset) & 0xff);
	});
}

function hashDomainForCase(index: number): string {
	return HASH_DOMAINS[index % HASH_DOMAINS.length] as string;
}

function expectSlotsIsolated(slots: PeerSlots): void {
	const { currentSlot, originalSlot } = slots;
	expectDisjointMutableGraph(currentSlot, originalSlot);
	expect(currentSlot).not.toBe(originalSlot);
	expect(currentSlot.graph).not.toBe(originalSlot.graph);
	expect(currentSlot.order).not.toBe(originalSlot.order);
	expect(currentSlot.linearizeOptions).not.toBe(originalSlot.linearizeOptions);
	expect(currentSlot.linearizeOptions.vertices).toBe(currentSlot.graph);
	expect(originalSlot.linearizeOptions.vertices).toBe(originalSlot.graph);
	for (const hash of currentSlot.graph.keys()) {
		expect(currentSlot.graph.get(hash)).not.toBe(originalSlot.graph.get(hash));
		expect(currentSlot.graph.get(hash)?.dependencies).not.toBe(originalSlot.graph.get(hash)?.dependencies);
	}
	expect(currentSlot.decodeBytes).not.toBe(originalSlot.decodeBytes);
	expect(currentSlot.decodeBytes.buffer).not.toBe(originalSlot.decodeBytes.buffer);
	expect(currentSlot.inclusionProof).not.toBe(originalSlot.inclusionProof);
	expect(currentSlot.inclusionProof.auditPath).not.toBe(originalSlot.inclusionProof.auditPath);
	for (const [index, hash] of currentSlot.inclusionProof.auditPath.entries()) {
		expect(hash).not.toBe(originalSlot.inclusionProof.auditPath[index]);
		expect(hash.buffer).not.toBe(originalSlot.inclusionProof.auditPath[index]?.buffer);
	}
	expect(currentSlot.leaves).not.toBe(originalSlot.leaves);
	for (const [index, leaf] of currentSlot.leaves.entries()) {
		expect(leaf).not.toBe(originalSlot.leaves[index]);
		expect(leaf.buffer).not.toBe(originalSlot.leaves[index]?.buffer);
	}
}

function expectDisjointMutableGraph(
	left: unknown,
	right: unknown,
	seen: WeakMap<object, WeakSet<object>> = new WeakMap()
): void {
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return;
	expect(left).not.toBe(right);
	const prior = seen.get(left);
	if (prior?.has(right) === true) return;
	const rights = prior ?? new WeakSet<object>();
	rights.add(right);
	seen.set(left, rights);
	if (ArrayBuffer.isView(left)) {
		expect(ArrayBuffer.isView(right)).toBe(true);
		if (ArrayBuffer.isView(right)) expect(left.buffer).not.toBe(right.buffer);
		return;
	}
	if (left instanceof ArrayBuffer || left instanceof SharedArrayBuffer) return;
	if (Array.isArray(left)) {
		expect(Array.isArray(right)).toBe(true);
		if (Array.isArray(right)) {
			for (const [index, value] of left.entries()) expectDisjointMutableGraph(value, right[index], seen);
		}
		return;
	}
	if (left instanceof Map) {
		expect(right).toBeInstanceOf(Map);
		if (right instanceof Map) {
			const rightEntries = [...right.entries()];
			for (const [index, [key, value]] of [...left.entries()].entries()) {
				const candidate = rightEntries[index];
				if (candidate === undefined) continue;
				expectDisjointMutableGraph(key, candidate[0], seen);
				expectDisjointMutableGraph(value, candidate[1], seen);
			}
		}
		return;
	}
	if (left instanceof Set) {
		expect(right).toBeInstanceOf(Set);
		if (right instanceof Set) {
			const rightValues = [...right.values()];
			for (const [index, value] of [...left.values()].entries())
				expectDisjointMutableGraph(value, rightValues[index], seen);
		}
		return;
	}
	const leftRecord = left as Record<PropertyKey, unknown>;
	const rightRecord = right as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(leftRecord)) {
		expectDisjointMutableGraph(leftRecord[key], rightRecord[key], seen);
	}
}

function expectDetachedClone(source: unknown, clone: unknown): void {
	if (source === null || typeof source !== "object") return;
	expect(clone).not.toBe(source);
	if (ArrayBuffer.isView(source)) {
		expect(ArrayBuffer.isView(clone)).toBe(true);
		if (!ArrayBuffer.isView(clone)) return;
		expect(clone.buffer).not.toBe(source.buffer);
		return;
	}
	if (Array.isArray(source)) {
		expect(Array.isArray(clone)).toBe(true);
		if (!Array.isArray(clone)) return;
		for (const [index, value] of source.entries()) expectDetachedClone(value, clone[index]);
		return;
	}
	if (source instanceof Map) {
		expect(clone).toBeInstanceOf(Map);
		if (!(clone instanceof Map)) return;
		const cloneEntries = [...clone];
		for (const [[key, value], candidate] of [...source].map((entry, index) => [entry, cloneEntries[index]] as const)) {
			if (candidate === undefined) continue;
			expectDetachedClone(key, candidate[0]);
			expectDetachedClone(value, candidate[1]);
		}
		return;
	}
	if (source instanceof Set) {
		expect(clone).toBeInstanceOf(Set);
		if (!(clone instanceof Set)) return;
		const cloneValues = [...clone];
		for (const [index, value] of [...source].entries()) expectDetachedClone(value, cloneValues[index]);
		return;
	}
	const sourceRecord = source as Record<string, unknown>;
	const cloneRecord = clone as Record<string, unknown>;
	for (const key of Object.keys(sourceRecord)) expectDetachedClone(sourceRecord[key], cloneRecord[key]);
}

function mutateFirstMutable(value: unknown): boolean {
	if (ArrayBuffer.isView(value) && value.byteLength > 0) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		bytes[0] = (bytes[0] as number) ^ 0xff;
		return true;
	}
	if (Array.isArray(value)) {
		for (const item of value) if (mutateFirstMutable(item)) return true;
		value.push("phase-3-exit-e-mutation");
		return true;
	}
	if (value instanceof Map) {
		for (const [key, item] of value) {
			if (mutateFirstMutable(key) || mutateFirstMutable(item)) return true;
		}
		value.set("phase-3-exit-e-mutation", true);
		return true;
	}
	if (value instanceof Set) {
		for (const item of value) if (mutateFirstMutable(item)) return true;
		value.add("phase-3-exit-e-mutation");
		return true;
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) if (mutateFirstMutable(item)) return true;
	}
	return false;
}

function flipFirstByte(bytes: Uint8Array): Uint8Array {
	const output = new Uint8Array(bytes);
	if (output.byteLength === 0) throw new TypeError("cannot flip an empty byte string");
	output[0] = (output[0] as number) ^ 1;
	return output;
}

function corpusTranscript(maxVertices: number): readonly string[] {
	const lines: string[] = [];
	for (const [graphIndex, shape] of enumerateCorpus(maxVertices).entries()) {
		const graph = makeGraph(shape);
		const expected = referenceOrder(graph);
		lines.push(
			`g:${graphIndex}:${shape.dependencies.map((dependencies) => dependencies.join(".")).join(",")}:${shape.ancestorMasks.join(",")}:${expected.join(",")}`
		);
		for (const [permutationIndex, permutation] of insertionPermutations(graph).entries()) {
			lines.push(`p:${graphIndex}:${permutationIndex}:${[...permutation.keys()].join(",")}`);
		}
		for (let left = 0; left < shape.ancestorMasks.length; left++) {
			for (let right = 0; right < shape.ancestorMasks.length; right++) {
				lines.push(
					`r:${graphIndex}:${left}:${right}:${Number(expectedAncestor(shape.ancestorMasks, left, right))}:${Number(
						expectedRelated(shape.ancestorMasks, left, right)
					)}`
				);
			}
		}
	}
	return lines;
}

function valueTranscript(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "bool:1" : "bool:0";
	if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return `${value.constructor.name}:${hex(bytes)}`;
	}
	if (Array.isArray(value)) return `array:[${value.map(valueTranscript).join(",")}]`;
	if (value instanceof Map) {
		return `map:{${[...value].map(([key, item]) => `${valueTranscript(key)}=>${valueTranscript(item)}`).join(",")}}`;
	}
	if (value instanceof Set) return `set:{${[...value].map(valueTranscript).join(",")}}`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `record:{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${valueTranscript(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("value transcript received an excluded value");
}

function expandedTranscript(): readonly string[] {
	return [
		...corpusTranscript(7),
		...deterministicValues(EXPANDED_VALUE_COUNT, EXPANDED_SEED).flatMap((value, index) => {
			const domain = hashDomainForCase(index);
			const parts = hashPartsForCase(index);
			return [
				`v:${index}:${valueTranscript(value)}`,
				`h:${index}:${JSON.stringify(domain)}:${new TextEncoder().encode(domain).byteLength}:${parts.length}:${parts
					.map(({ length }) => length)
					.join(",")}:${hex(domainHash(domain, parts))}`,
			];
		}),
		...MERKLE_BOUNDARY_SIZES.map((size) => `m:${size}`),
	];
}

function auditDriverSource(source: string): void {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const namespaceImports: string[] = [];
	const contractImports: string[] = [];
	const unexpectedImports: string[] = [];
	for (const statement of parsed.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		const clause = statement.importClause;
		if (clause?.name !== undefined) unexpectedImports.push(`${specifier}:default:${clause.name.text}`);
		const bindings = clause?.namedBindings;
		if (bindings === undefined) {
			unexpectedImports.push(`${specifier}:side-effect`);
			continue;
		}
		if (ts.isNamespaceImport(bindings)) {
			namespaceImports.push(`${bindings.name.text}\0${specifier}`);
			continue;
		}
		if (specifier !== "./contract.js") {
			unexpectedImports.push(`${specifier}:named`);
			continue;
		}
		for (const binding of bindings.elements) {
			if (binding.propertyName !== undefined) unexpectedImports.push(`${specifier}:alias:${binding.getText(parsed)}`);
			contractImports.push(binding.name.text);
		}
	}
	expect(unexpectedImports, "driver import forms").toEqual([]);
	expect(namespaceImports.sort(), "driver namespace imports").toEqual(
		DRIVER_NAMESPACE_IMPORTS.map(([name, specifier]) => `${name}\0${specifier}`).sort()
	);
	expect(contractImports.sort(), "driver contract imports").toEqual([...DRIVER_CONTRACT_IMPORTS].sort());

	const expectedFunctionNames = new Set(CALL_BINDINGS.map(({ functionName }) => functionName));
	const functions = new Map<string, ts.FunctionDeclaration>();
	const unexpectedTopLevel: string[] = [];
	for (const statement of parsed.statements) {
		if (ts.isImportDeclaration(statement)) continue;
		if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) {
			unexpectedTopLevel.push(ts.SyntaxKind[statement.kind]);
			continue;
		}
		const functionName = statement.name.text;
		if (!expectedFunctionNames.has(functionName)) unexpectedTopLevel.push(`function:${functionName}`);
		if (functions.has(functionName)) unexpectedTopLevel.push(`duplicate-function:${functionName}`);
		if (!statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
			unexpectedTopLevel.push(`unexported-function:${functionName}`);
		}
		if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) {
			unexpectedTopLevel.push(`default-function:${functionName}`);
		}
		functions.set(functionName, statement);
	}
	expect(unexpectedTopLevel, "driver exact exported function surface").toEqual([]);
	expect([...functions.keys()].sort(), "driver exact exported function roster").toEqual(
		[...expectedFunctionNames].sort()
	);
	const protectedImportNames = new Set<string>([
		...DRIVER_NAMESPACE_IMPORTS.map(([name]) => name),
		...DRIVER_CONTRACT_IMPORTS,
	]);
	for (const functionName of expectedFunctionNames) {
		const declaration = functions.get(functionName);
		expect(declaration, `CALL_BINDINGS function ${functionName}`).toBeDefined();
		if (declaration === undefined) continue;
		const forbidden: string[] = [];
		const shadowedImports: string[] = [];
		const stateWrites: string[] = [];
		const inspectBindingName = (name: ts.BindingName | undefined): void => {
			if (name === undefined) return;
			if (ts.isIdentifier(name)) {
				if (protectedImportNames.has(name.text)) shadowedImports.push(name.text);
				return;
			}
			for (const element of name.elements) {
				if (ts.isBindingElement(element)) inspectBindingName(element.name);
			}
		};
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) || ts.isParameter(node)) inspectBindingName(node.name);
			if (
				(ts.isBinaryExpression(node) &&
					node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
					node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
				((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
					(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
				(ts.isDeleteExpression(node) && node.expression !== undefined)
			) {
				stateWrites.push(node.getText(parsed));
			}
			if (
				(ts.isFunctionDeclaration(node) ||
					ts.isFunctionExpression(node) ||
					ts.isClassDeclaration(node) ||
					ts.isClassExpression(node)) &&
				node.name !== undefined &&
				protectedImportNames.has(node.name.text)
			) {
				shadowedImports.push(node.name.text);
			}
			if (
				ts.isIfStatement(node) ||
				ts.isSwitchStatement(node) ||
				ts.isTryStatement(node) ||
				ts.isForStatement(node) ||
				ts.isForInStatement(node) ||
				ts.isForOfStatement(node) ||
				ts.isWhileStatement(node) ||
				ts.isDoStatement(node) ||
				ts.isConditionalExpression(node)
			) {
				forbidden.push(ts.SyntaxKind[node.kind]);
			}
			if (node !== declaration && ts.isFunctionLike(node)) forbidden.push(ts.SyntaxKind[node.kind]);
			ts.forEachChild(node, visit);
		};
		visit(declaration);
		expect(forbidden, `${functionName} control flow`).toEqual([]);
		expect(shadowedImports, `${functionName} imported binding shadows`).toEqual([]);
		expect(stateWrites, `${functionName} straight-line SSA writes`).toEqual([]);
		const returns: ts.ReturnStatement[] = [];
		const collectReturns = (node: ts.Node): void => {
			if (ts.isReturnStatement(node)) returns.push(node);
			ts.forEachChild(node, collectReturns);
		};
		collectReturns(declaration);
		expect(returns, `${functionName} terminal return`).toHaveLength(1);
		expect(declaration.body?.statements.at(-1), `${functionName} final return`).toBe(returns[0]);

		const expected = CALL_BINDINGS.filter((binding) => binding.functionName === functionName);
		const expectedParameters = (["original", "current"] as const)
			.filter((peer) => expected.some((binding) => binding.peer === peer))
			.map((peer) => `${peer}Slot`);
		expect(
			declaration.parameters.map(({ name }) => (ts.isIdentifier(name) ? name.text : name.getText(parsed))),
			`${functionName} ordered peer parameters`
		).toEqual(expectedParameters);
		const calls: Array<ts.CallExpression | ts.NewExpression> = [];
		const collect = (node: ts.Node): void => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
			ts.forEachChild(node, collect);
		};
		collect(declaration);
		expect(calls, `${functionName} primitive-call parity`).toHaveLength(expected.length);

		const matched = new Set<ts.CallExpression | ts.NewExpression>();
		const allowedSlotRoots = new Set<ts.Identifier>();
		const observationPath = (identifier: ts.Identifier): string | undefined => {
			let node: ts.Node = identifier;
			const projections: string[] = [];
			while (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
				projections.push(node.parent.name.text);
				node = node.parent;
			}
			const properties: string[] = [];
			while (true) {
				if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
					properties.unshift(node.parent.name.getText(parsed));
					node = node.parent.parent;
					continue;
				}
				if (ts.isObjectLiteralExpression(node.parent)) {
					node = node.parent;
					continue;
				}
				break;
			}
			if (!ts.isReturnStatement(node.parent) || node.parent.expression !== node) return undefined;
			const path = [...properties, ...projections].join(".");
			return path.length === 0 ? "return" : path;
		};
		for (const binding of expected) {
			const candidates = calls.filter((call) => {
				if (call.expression.getText(parsed) !== binding.callee) return false;
				if ((call.arguments?.length ?? 0) !== binding.arguments.length) return false;
				if (
					!binding.arguments.every(
						({ expression, position }) => call.arguments?.[position]?.getText(parsed) === expression
					)
				) {
					return false;
				}
				const resolved = ts.isAwaitExpression(call.parent);
				if (resolved !== binding.awaited) return false;
				const value = resolved ? call.parent : call;
				const declarationNode = value.parent;
				if (!ts.isVariableDeclaration(declarationNode) || !ts.isIdentifier(declarationNode.name)) return false;
				return binding.destinationKind !== "ssa" || declarationNode.name.text === binding.destination;
			});
			expect(candidates, `${binding.functionName}:${binding.callId}:${binding.callee}`).toHaveLength(1);
			const candidate = candidates[0];
			if (candidate === undefined) continue;
			expect(matched.has(candidate), `${binding.callId} duplicate binding`).toBe(false);
			matched.add(candidate);
			for (const argument of candidate.arguments ?? []) {
				const collectSlotRoots = (node: ts.Node): void => {
					if (ts.isIdentifier(node) && (node.text === "currentSlot" || node.text === "originalSlot")) {
						allowedSlotRoots.add(node);
					}
					ts.forEachChild(node, collectSlotRoots);
				};
				collectSlotRoots(argument);
			}
			const value = ts.isAwaitExpression(candidate.parent) ? candidate.parent : candidate;
			const declarationNode = value.parent;
			if (!ts.isVariableDeclaration(declarationNode) || !ts.isIdentifier(declarationNode.name)) continue;
			const resultName = declarationNode.name.text;
			let occurrences = 0;
			const count = (node: ts.Node): void => {
				if (ts.isIdentifier(node) && node.text === resultName) occurrences++;
				ts.forEachChild(node, count);
			};
			count(declaration);
			expect(occurrences, `${binding.callId}:${resultName} single destination`).toBe(2);
			if (binding.destinationKind === "observation") {
				const uses: ts.Identifier[] = [];
				const collectUses = (node: ts.Node): void => {
					if (ts.isIdentifier(node) && node.text === resultName && node !== declarationNode.name) uses.push(node);
					ts.forEachChild(node, collectUses);
				};
				collectUses(declaration);
				expect(uses, `${binding.callId}:${resultName} observation use`).toHaveLength(1);
				const use = uses[0];
				if (use !== undefined) {
					const expectedPath = binding.destination.endsWith(".value")
						? binding.destination.slice(0, -".value".length)
						: binding.destination;
					expect(observationPath(use), `${binding.callId}:${resultName} observation path`).toBe(expectedPath);
				}
			}
		}
		expect(matched.size, `${functionName} zero extra primitive calls`).toBe(calls.length);
		const parameterSlots = new Set(
			declaration.parameters
				.map(({ name }) => (ts.isIdentifier(name) ? name : undefined))
				.filter((name): name is ts.Identifier => name !== undefined)
		);
		const slotViolations: string[] = [];
		const validateSlotRoots = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && (node.text === "currentSlot" || node.text === "originalSlot")) {
				if (!parameterSlots.has(node) && !allowedSlotRoots.has(node)) {
					slotViolations.push(node.getText(parsed));
				}
			}
			ts.forEachChild(node, validateSlotRoots);
		};
		validateSlotRoots(declaration);
		expect(slotViolations, `${functionName} exclusive slot roots`).toEqual([]);
	}
}

function auditFails(source: string): boolean {
	try {
		auditDriverSource(source);
		return false;
	} catch {
		return true;
	}
}

function mutateDriverParameterOrder(source: string, functionName: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
	);
	if (declaration === undefined || declaration.parameters.length !== 2) {
		throw new TypeError(`expected two peer parameters for ${functionName}`);
	}
	const [first, second] = declaration.parameters;
	if (first === undefined || second === undefined) throw new TypeError(`missing peer parameters for ${functionName}`);
	return `${source.slice(0, first.getStart(parsed))}${second.getText(parsed)}, ${first.getText(parsed)}${source.slice(
		second.end
	)}`;
}

function mutateExportAlias(source: string): string {
	const needle = "export async function runCanonicalPair";
	if (!source.includes(needle)) throw new TypeError("missing exported runCanonicalPair");
	return `${source.replace(needle, "async function runCanonicalPair")}\nasync function phase3ExitRunCanonicalPairWrapper(originalSlot: PeerSlot, currentSlot: PeerSlot) { return runCanonicalPair(originalSlot, currentSlot); }\nexport { phase3ExitRunCanonicalPairWrapper as runCanonicalPair };\n`;
}

function mutateNamespaceShadow(source: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "runCanonicalPair"
	);
	if (declaration?.body === undefined) throw new TypeError("missing runCanonicalPair");
	return `${source.slice(
		0,
		declaration.body.getStart(parsed) + 1
	)}\n\tconst originalCanonical = currentCanonical;${source.slice(declaration.body.getStart(parsed) + 1)}`;
}

function mutateProtectedPrototypeWrite(source: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "runAncestorPair"
	);
	if (declaration?.body === undefined) throw new TypeError("missing runAncestorPair");
	return `${source.slice(
		0,
		declaration.body.getStart(parsed) + 1
	)}\n\tcurrentLinearize.CausalityIndex.prototype.isAncestor = originalLinearize.CausalityIndex.prototype.isAncestor;${source.slice(
		declaration.body.getStart(parsed) + 1
	)}`;
}

function mutateBindingArgument(
	source: string,
	binding: (typeof CALL_BINDINGS)[number],
	position: number,
	kind:
		| "default"
		| "duplicate-binding"
		| "extra"
		| "extra-option-property"
		| "same-peer-position-swap"
		| "wrong-binding"
		| "wrong-literal"
): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let declaration: ts.FunctionDeclaration | undefined;
	for (const statement of parsed.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === binding.functionName) declaration = statement;
	}
	if (declaration === undefined) throw new TypeError(`missing ${binding.functionName}`);
	const candidates: Array<ts.CallExpression | ts.NewExpression> = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const resolved = ts.isAwaitExpression(node.parent);
			const value = resolved ? node.parent : node;
			const declarationNode = value.parent;
			const result =
				ts.isVariableDeclaration(declarationNode) && ts.isIdentifier(declarationNode.name)
					? declarationNode.name.text
					: undefined;
			if (
				node.expression.getText(parsed) === binding.callee &&
				(node.arguments?.length ?? 0) === binding.arguments.length &&
				binding.arguments.every(
					({ expression, position: argumentPosition }) =>
						node.arguments?.[argumentPosition]?.getText(parsed) === expression
				) &&
				(binding.destinationKind !== "ssa" || result === binding.destination)
			) {
				candidates.push(node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(declaration);
	if (candidates.length !== 1) throw new TypeError(`ambiguous binding mutation ${binding.callId}`);
	const call = candidates[0] as ts.CallExpression | ts.NewExpression;
	if (kind === "extra") {
		const close = call.end - 1;
		const insertion = call.arguments?.length === 0 ? "undefined" : ", undefined";
		return `${source.slice(0, close)}${insertion}${source.slice(close)}`;
	}
	const argument = call.arguments?.[position];
	if (argument === undefined) throw new TypeError(`missing binding position ${binding.callId}:${position}`);
	if (kind === "duplicate-binding" || kind === "same-peer-position-swap") {
		const arguments_ = [...(call.arguments ?? [])];
		if (arguments_.length < 2) throw new TypeError(`binding has no same-peer sibling ${binding.callId}`);
		const otherPosition = position === 0 ? 1 : 0;
		const other = arguments_[otherPosition];
		if (other === undefined) throw new TypeError(`missing sibling binding ${binding.callId}:${position}`);
		if (kind === "duplicate-binding") {
			return `${source.slice(0, argument.getStart(parsed))}${other.getText(parsed)}${source.slice(argument.end)}`;
		}
		const texts = arguments_.map((candidate) => candidate.getText(parsed));
		[texts[position], texts[otherPosition]] = [texts[otherPosition] as string, texts[position] as string];
		return `${source.slice(0, arguments_[0]?.getStart(parsed))}${texts.join(", ")}${source.slice(
			arguments_.at(-1)?.end
		)}`;
	}
	const expression = argument.getText(parsed);
	if (kind === "wrong-literal") {
		const replacement =
			expression === "DOMAIN"
				? '"ts-drp/phase-3-exit-e/wrong"'
				: expression === "RANGE_START"
					? "1"
					: expression === "BATCH_OPTIONS"
						? "{ batchSize: 128 }"
						: expression === "ORDER_OPTIONS"
							? "{ enforceDependencyAntichain: false }"
							: "undefined";
		return `${source.slice(0, argument.getStart(parsed))}${replacement}${source.slice(argument.end)}`;
	}
	if (kind === "extra-option-property") {
		if (expression !== "BATCH_OPTIONS" && expression !== "ORDER_OPTIONS") {
			throw new TypeError(`binding is not an options literal ${binding.callId}:${position}`);
		}
		const replacement = `{ ...${expression}, phase3ExitUnexpected: true }`;
		return `${source.slice(0, argument.getStart(parsed))}${replacement}${source.slice(argument.end)}`;
	}
	const replacement =
		kind === "default"
			? "undefined"
			: expression.includes("original")
				? expression.replaceAll("original", "current")
				: expression.includes("current")
					? expression.replaceAll("current", "original")
					: "undefined";
	return `${source.slice(0, argument.getStart(parsed))}${replacement}${source.slice(argument.end)}`;
}

function mutateBindingResult(
	source: string,
	binding: (typeof CALL_BINDINGS)[number],
	kind:
		| "dead-result"
		| "observation-substitution"
		| "overwritten-result"
		| "pre-call-rebinding"
		| "unreachable-call"
		| "unresolved"
		| "wrong-opposite-peer-result"
		| "wrong-same-peer-result"
		| "wrong-stateful-result"
): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let declaration: ts.FunctionDeclaration | undefined;
	for (const statement of parsed.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === binding.functionName) declaration = statement;
	}
	if (declaration?.body === undefined) throw new TypeError(`missing ${binding.functionName}`);
	if (kind === "pre-call-rebinding") {
		return `${source.slice(0, declaration.body.getStart(parsed) + 1)}\n\toriginalSlot.value = currentSlot.value;${source.slice(
			declaration.body.getStart(parsed) + 1
		)}`;
	}
	let selected:
		| Readonly<{
				call: ts.CallExpression | ts.NewExpression;
				declaration: ts.VariableDeclaration;
				result: string;
		  }>
		| undefined;
	const visit = (node: ts.Node): void => {
		if (selected !== undefined) return;
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const resolved = ts.isAwaitExpression(node.parent);
			const value = resolved ? node.parent : node;
			const declarationNode = value.parent;
			if (
				node.expression.getText(parsed) === binding.callee &&
				(node.arguments?.length ?? 0) === binding.arguments.length &&
				binding.arguments.every(
					({ expression, position }) => node.arguments?.[position]?.getText(parsed) === expression
				) &&
				ts.isVariableDeclaration(declarationNode) &&
				ts.isIdentifier(declarationNode.name) &&
				(binding.destinationKind !== "ssa" || declarationNode.name.text === binding.destination)
			) {
				selected = { call: node, declaration: declarationNode, result: declarationNode.name.text };
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(declaration);
	if (selected === undefined) throw new TypeError(`missing result mutation ${binding.callId}`);
	const selection = selected as Readonly<{
		call: ts.CallExpression | ts.NewExpression;
		declaration: ts.VariableDeclaration;
		result: string;
	}>;
	if (kind === "unresolved") {
		if (!ts.isAwaitExpression(selection.call.parent)) throw new TypeError(`call is synchronous ${binding.callId}`);
		return `${source.slice(0, selection.call.parent.getStart(parsed))}${selection.call.getText(parsed)}${source.slice(
			selection.call.parent.end
		)}`;
	}
	const variableStatement = selection.declaration.parent.parent;
	if (kind === "unreachable-call") {
		if (!ts.isVariableStatement(variableStatement)) throw new TypeError(`result has no statement ${binding.callId}`);
		return `${source.slice(0, variableStatement.getStart(parsed))}if (false) { ${variableStatement.getText(
			parsed
		)} }${source.slice(variableStatement.end)}`;
	}
	if (kind === "overwritten-result") {
		if (!ts.isVariableStatement(variableStatement)) throw new TypeError(`result has no statement ${binding.callId}`);
		return `${source.slice(0, variableStatement.end)}\n\t${selection.result} = ${selection.result};${source.slice(
			variableStatement.end
		)}`;
	}
	const uses: ts.Identifier[] = [];
	const findUses = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === selection.result && node !== selection.declaration.name) {
			uses.push(node);
		}
		ts.forEachChild(node, findUses);
	};
	findUses(declaration);
	if (uses.length !== 1) throw new TypeError(`result is not single-use ${binding.callId}`);
	const use = uses[0] as ts.Identifier;
	let replacement = "undefined";
	if (kind !== "dead-result") {
		if (kind === "wrong-same-peer-result") {
			const prefix = selection.result.startsWith("original") ? "original" : "current";
			const alternatives = declaration.body.statements.flatMap((statement) =>
				ts.isVariableStatement(statement)
					? statement.declarationList.declarations
							.filter(
								(candidate): candidate is ts.VariableDeclaration & { name: ts.Identifier } =>
									ts.isIdentifier(candidate.name) &&
									candidate.name.text.startsWith(prefix) &&
									candidate.name.text !== selection.result
							)
							.map((candidate) => candidate.name.text)
					: []
			);
			replacement = alternatives[0] as string;
			if (replacement === undefined) throw new TypeError(`no same-peer result ${binding.callId}`);
		} else {
			replacement = selection.result.startsWith("original")
				? selection.result.replace(/^original/u, "current")
				: selection.result.startsWith("current")
					? selection.result.replace(/^current/u, "original")
					: "phase3ExitOppositeResult";
		}
	}
	return `${source.slice(0, use.getStart(parsed))}${replacement}${source.slice(use.end)}`;
}

function mutateBindingCallee(source: string, binding: (typeof CALL_BINDINGS)[number]): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === binding.functionName
	);
	if (declaration === undefined) throw new TypeError(`missing callee function ${binding.functionName}`);
	let selected: ts.CallExpression | ts.NewExpression | undefined;
	const visit = (node: ts.Node): void => {
		if (selected !== undefined) return;
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const value = ts.isAwaitExpression(node.parent) ? node.parent : node;
			const declaration = value.parent;
			const result =
				ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
			if (
				node.expression.getText(parsed) === binding.callee &&
				(node.arguments?.length ?? 0) === binding.arguments.length &&
				binding.arguments.every(
					({ expression, position }) => node.arguments?.[position]?.getText(parsed) === expression
				) &&
				(binding.destinationKind !== "ssa" || result === binding.destination)
			) {
				selected = node;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(declaration);
	if (selected === undefined) throw new TypeError(`missing callee mutation ${binding.callId}`);
	const callee = (selected as ts.CallExpression | ts.NewExpression).expression;
	const replacement = binding.callee.includes("original")
		? binding.callee.replaceAll("original", "current")
		: binding.callee.replaceAll("current", "original");
	return `${source.slice(0, callee.getStart(parsed))}${replacement}${source.slice(callee.end)}`;
}

function mutateControlForm(source: string, functionName: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
	);
	if (declaration?.body === undefined) throw new TypeError(`missing control mutation ${functionName}`);
	const start = declaration.body.getStart(parsed) + 1;
	return `${source.slice(0, start)}\n\tif (true) {}${source.slice(start)}`;
}

function mutateDriverImport(source: string, namespace: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.ImportDeclaration =>
			ts.isImportDeclaration(statement) &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamespaceImport(statement.importClause.namedBindings) &&
			statement.importClause.namedBindings.name.text === namespace
	);
	if (declaration === undefined || !ts.isStringLiteral(declaration.moduleSpecifier)) {
		throw new TypeError(`missing namespace import ${namespace}`);
	}
	return `${source.slice(0, declaration.moduleSpecifier.getStart(parsed))}"./wrong-reference.js"${source.slice(
		declaration.moduleSpecifier.end
	)}`;
}

function mutateWrapperDecoy(source: string): string {
	const parsed = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "runOrderPair"
	);
	const returnStatement = declaration?.body?.statements.at(-1);
	if (
		declaration?.body === undefined ||
		returnStatement === undefined ||
		!ts.isReturnStatement(returnStatement) ||
		returnStatement.expression === undefined
	) {
		throw new TypeError("missing runOrderPair return");
	}
	const replacement = `const phase3ExitDecoy = ${returnStatement.expression.getText(
		parsed
	)};\n\treturn phase3ExitHelper(currentSlot);`;
	return `${source.slice(0, returnStatement.getStart(parsed))}${replacement}${source.slice(
		returnStatement.end
	)}\nfunction phase3ExitHelper(slot: PeerSlot) { return { current: [], original: [] }; }`;
}

describe("D.93.60 pinned-original primitive conformance RED", () => {
	it("freezes the complete reference lock and exact executed transitive closure", () => {
		expect(sha256File(REFERENCE_LOCK_PATH)).toBe(REFERENCE_LOCK_SHA256);
		const lock = JSON.parse(readFileSync(REFERENCE_LOCK_PATH, "utf8")) as {
			algorithm?: unknown;
			files?: Record<string, string>;
		};
		expect(lock.algorithm).toBe("sha256");
		expect(lock.files).toEqual(REFERENCE_LOCK_ENTRIES);
		for (const [fileName, digest] of Object.entries(REFERENCE_LOCK_ENTRIES)) {
			expect(sha256File(path.join(REFERENCE_DIRECTORY, fileName)), fileName).toBe(digest);
		}
		expect(EXECUTED_REFERENCE_CLOSURE).toEqual([
			"canonical.js",
			"ct-merkle.js",
			"hash.js",
			"linearize.js",
			"protocol.js",
		]);
		expect(executedReferenceClosure(["canonical.js", "ct-merkle.js", "hash.js", "linearize.js"])).toEqual(
			EXECUTED_REFERENCE_CLOSURE
		);
	});

	it("freezes one closed overlap, exclusion, call-binding and mutation manifest", () => {
		expect(BATCH_OPTIONS).toEqual({ batchSize: 256 });
		expect(ORDER_OPTIONS).toEqual({ enforceDependencyAntichain: true });
		expect(RANGE_START).toBe(0);
		expect(DOMAIN).toBe("ts-drp/phase-3-exit-e/v2");
		expect(DRIVER_NAMESPACE_IMPORTS).toHaveLength(7);
		expect(DRIVER_CONTRACT_IMPORTS).toEqual(["BATCH_OPTIONS", "ORDER_OPTIONS", "RANGE_START", "PeerSlot"]);
		expect(HASH_DOMAINS.map((domain) => new TextEncoder().encode(domain).byteLength)).toEqual([0, 1, 2, 4, 255, 256]);
		expect(HASH_PART_BOUNDARY_LENGTHS).toEqual([0, 1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256]);
		expect(new Set(CONFORMING_OPERATIONS).size).toBe(CONFORMING_OPERATIONS.length);
		expect(new Set(EXCLUDED_BEHAVIORS).size).toBe(EXCLUDED_BEHAVIORS.length);
		expect(new Set(MUTATION_KINDS).size).toBe(MUTATION_KINDS.length);
		expect(new Set(CALL_BINDINGS.map(({ callId }) => callId)).size).toBe(CALL_BINDINGS.length);
		for (const operation of CONFORMING_OPERATIONS) {
			const peers = new Set(CALL_BINDINGS.filter((binding) => binding.operation === operation).map(({ peer }) => peer));
			expect(peers, operation).toEqual(new Set(["current", "original"]));
		}
		for (const binding of CALL_BINDINGS) {
			for (const { expression, kind, position } of binding.arguments) {
				const kinds = new Set(
					BINDING_MUTATIONS.filter(
						(mutation) =>
							mutation.callId === binding.callId && mutation.peer === binding.peer && mutation.position === position
					).map(({ kind }) => kind)
				);
				expect(kinds, `${binding.callId}:${binding.peer}:${position}`).toEqual(
					new Set([
						"default",
						kind === "literal" ? "wrong-literal" : "wrong-binding",
						...(["BATCH_OPTIONS", "ORDER_OPTIONS"].includes(expression) ? ["extra-option-property"] : []),
						...(binding.arguments.length > 1 ? ["duplicate-binding", "same-peer-position-swap"] : []),
					])
				);
			}
			expect(
				BINDING_MUTATIONS.filter(
					(mutation) =>
						mutation.callId === binding.callId && mutation.peer === binding.peer && mutation.position === "call"
				).map(({ kind }) => kind),
				`${binding.callId}:${binding.peer}:call`
			).toEqual(["extra"]);
			const resultKinds = new Set(
				BINDING_MUTATIONS.filter(
					(mutation) =>
						mutation.callId === binding.callId && mutation.peer === binding.peer && mutation.position === "result"
				).map(({ kind }) => kind)
			);
			expect(resultKinds.has("pre-call-rebinding")).toBe(true);
			expect(resultKinds.has("unreachable-call")).toBe(true);
			expect(resultKinds.has("dead-result")).toBe(true);
			expect(resultKinds.has("overwritten-result")).toBe(true);
			expect(resultKinds.has("wrong-opposite-peer-result")).toBe(true);
			expect(resultKinds.has("wrong-same-peer-result")).toBe(
				CALL_BINDINGS.some(
					(candidate) =>
						candidate.functionName === binding.functionName &&
						candidate.peer === binding.peer &&
						candidate.destination !== binding.destination
				)
			);
			expect(
				resultKinds.has(binding.destinationKind === "ssa" ? "wrong-stateful-result" : "observation-substitution")
			).toBe(true);
			expect(resultKinds.has("unresolved"), `${binding.callId}:await`).toBe(binding.awaited);
		}
	});

	it("pins corpus identities, LF transcripts and independent primitive expectations", () => {
		const ordinary = enumerateCorpus(6);
		const expanded = enumerateCorpus(7);
		expect(PR_CORPUS_COUNT).toBe(ORDINARY_GRAPH_COUNT);
		expect(NIGHTLY_CORPUS_COUNT).toBe(EXPANDED_GRAPH_COUNT);
		expect(ordinary).toHaveLength(ORDINARY_GRAPH_COUNT);
		expect(expanded).toHaveLength(EXPANDED_GRAPH_COUNT);
		expect(ordinary.reduce((count, shape) => count + insertionPermutations(makeGraph(shape)).length, 0)).toBe(
			ORDINARY_PERMUTATION_COUNT
		);
		expect(expanded.reduce((count, shape) => count + insertionPermutations(makeGraph(shape)).length, 0)).toBe(
			EXPANDED_PERMUTATION_COUNT
		);
		expect(ordinary.reduce((count, shape) => count + 2 * shape.ancestorMasks.length ** 2, 0)).toBe(
			ORDINARY_RELATION_OBSERVATION_COUNT
		);
		expect(expanded.reduce((count, shape) => count + 2 * shape.ancestorMasks.length ** 2, 0)).toBe(
			EXPANDED_RELATION_OBSERVATION_COUNT
		);
		expect(transcriptSha256(corpusTranscript(6))).toBe(ORDINARY_TRANSCRIPT_SHA256);
		expect(transcriptSha256(expandedTranscript())).toBe(EXPANDED_TRANSCRIPT_SHA256);
		expect(ORDINARY_TRANSCRIPT_SHA256).not.toBe("RED_REGENERATE_BEFORE_SIGNING");
		expect(EXPANDED_TRANSCRIPT_SHA256).not.toBe("RED_REGENERATE_BEFORE_SIGNING");
		expect(MERKLE_BOUNDARY_SIZES).toEqual([
			0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256,
		]);
		expect(ORDINARY_MERKLE_BOUNDARY_SIZES).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]);
		expect(hex(rfcLeafHash(Uint8Array.of(1, 2, 3)))).toHaveLength(64);
		expect(rfcNodeHash(rfcLeafHash(Uint8Array.of(1)), rfcLeafHash(Uint8Array.of(2)))).toHaveLength(32);
		expect(compareBytes(Uint8Array.of(1), Uint8Array.of(2))).toBe(-1);
		expect(semanticEqual(new Map([["phase", 3]]), new Set([3]))).toBe(false);
		expect(semanticEqual(new Map([["phase", 3]]), Object.create(null))).toBe(false);
		expect(semanticEqual(new Set([3]), Object.create(null))).toBe(false);
		expect(semanticEqual(new Uint8Array(), Object.create(null))).toBe(false);
		expect(deterministicValues(EXPANDED_VALUE_COUNT, EXPANDED_SEED)).toHaveLength(EXPANDED_VALUE_COUNT);
	});

	it("materializes complete peer inputs twice without shared mutable carriers", () => {
		const graph = makeGraph(enumerateCorpus(6)[0]);
		const order = referenceOrder(graph);
		const input = baseSlot(graph, order);
		expectSlotsIsolated(materializePeerSlots(input));
		const sharedValue = materializePeerSlots(input);
		sharedValue.originalSlot.value = sharedValue.currentSlot.value;
		expect(() => expectSlotsIsolated(sharedValue), "shared canonical value mutant").toThrow();
		const sharedBuffer = materializePeerSlots(input);
		sharedBuffer.originalSlot.hashParts[0] = new Uint8Array(
			sharedBuffer.currentSlot.hashParts[0]?.buffer as ArrayBuffer
		);
		expect(() => expectSlotsIsolated(sharedBuffer), "shared backing buffer mutant").toThrow();
	});

	it(
		"requires the sole test-only driver and activates the independent differential",
		async () => {
			const driver = await loadDriver();
			expect(driver?.runAccumulatorPair, "PHASE3_EXIT_REFERENCE_DRIVER_READINESS").toBeTypeOf("function");
			expect(driver?.runCanonicalPair, "PHASE3_EXIT_REFERENCE_DRIVER_READINESS").toBeTypeOf("function");
			expect(driver?.runConsistencyPair, "PHASE3_EXIT_REFERENCE_DRIVER_READINESS").toBeTypeOf("function");
			expect(driver?.runDecodePair, "PHASE3_EXIT_REFERENCE_DRIVER_READINESS").toBeTypeOf("function");
			expect(driver?.runInclusionPair, "PHASE3_EXIT_REFERENCE_DRIVER_READINESS").toBeTypeOf("function");
			if (driver === undefined) throw new TypeError("PHASE3_EXIT_REFERENCE_DRIVER_READINESS");
			const driverSource = readFileSync(DRIVER_PATH, "utf8");
			auditDriverSource(driverSource);
			for (const [namespace] of DRIVER_NAMESPACE_IMPORTS) {
				expect(auditFails(mutateDriverImport(driverSource, namespace)), `${namespace}:wrong-import`).toBe(true);
			}
			expect(auditFails(mutateExportAlias(driverSource)), "export-alias/decoy-implementation").toBe(true);
			expect(auditFails(mutateNamespaceShadow(driverSource)), "shadowed-imported-namespace").toBe(true);
			expect(auditFails(mutateProtectedPrototypeWrite(driverSource)), "protected-prototype-write").toBe(true);
			expect(auditFails(mutateWrapperDecoy(driverSource)), "wrapper-decoy/bare-slot").toBe(true);
			for (const functionName of new Set(CALL_BINDINGS.map(({ functionName: name }) => name))) {
				expect(auditFails(mutateControlForm(driverSource, functionName)), `${functionName}:invalid-control-form`).toBe(
					true
				);
				const peers = new Set(
					CALL_BINDINGS.filter((binding) => binding.functionName === functionName).map(({ peer }) => peer)
				);
				if (peers.size === 2) {
					expect(
						auditFails(mutateDriverParameterOrder(driverSource, functionName)),
						`${functionName}:swapped-peer-parameters`
					).toBe(true);
				}
			}
			for (const binding of CALL_BINDINGS) {
				expect(
					auditFails(mutateBindingCallee(driverSource, binding)),
					`${binding.callId}:${binding.peer}:wrong-callee/call-parity`
				).toBe(true);
				for (const { expression, kind: bindingKind, position } of binding.arguments) {
					const argumentKinds = [
						"default",
						bindingKind === "literal" ? "wrong-literal" : "wrong-binding",
						...(["BATCH_OPTIONS", "ORDER_OPTIONS"].includes(expression) ? (["extra-option-property"] as const) : []),
						...(binding.arguments.length > 1 ? (["same-peer-position-swap", "duplicate-binding"] as const) : []),
					] as const;
					for (const kind of argumentKinds) {
						expect(
							auditFails(mutateBindingArgument(driverSource, binding, position, kind)),
							`${binding.callId}:${binding.peer}:${position}:${kind}`
						).toBe(true);
					}
				}
				expect(
					auditFails(mutateBindingArgument(driverSource, binding, 0, "extra")),
					`${binding.callId}:${binding.peer}:call:extra`
				).toBe(true);
				const hasSamePeerAlternative = CALL_BINDINGS.some(
					(candidate) =>
						candidate.functionName === binding.functionName &&
						candidate.peer === binding.peer &&
						candidate.destination !== binding.destination
				);
				const resultKinds = [
					"pre-call-rebinding",
					"unreachable-call",
					"dead-result",
					"overwritten-result",
					"wrong-opposite-peer-result",
					...(hasSamePeerAlternative ? (["wrong-same-peer-result"] as const) : []),
					binding.destinationKind === "ssa" ? "wrong-stateful-result" : "observation-substitution",
				] as const;
				for (const kind of resultKinds) {
					expect(
						auditFails(mutateBindingResult(driverSource, binding, kind)),
						`${binding.callId}:${binding.peer}:${kind}`
					).toBe(true);
				}
				if (binding.awaited) {
					expect(
						auditFails(mutateBindingResult(driverSource, binding, "unresolved")),
						`${binding.callId}:${binding.peer}:unresolved`
					).toBe(true);
				}
			}

			const compareCases = [
				[Uint8Array.of(), Uint8Array.of()],
				[Uint8Array.of(1, 2), Uint8Array.of(2, 2)],
				[Uint8Array.of(2, 2), Uint8Array.of(1, 2)],
				[Uint8Array.of(1, 2), Uint8Array.of(1, 3)],
				[Uint8Array.of(1, 3), Uint8Array.of(1, 2)],
				[Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0)],
				[Uint8Array.of(1, 2, 0), Uint8Array.of(1, 2)],
			] as const;
			const ordinaryValue = new Map<unknown, unknown>([["phase", { nested: Uint8Array.of(3, 6, 0) }]]);
			const values = RUN_EXPANDED
				? deterministicValues(EXPANDED_VALUE_COUNT, EXPANDED_SEED)
				: compareCases.map(() => ordinaryValue);
			const baseGraph = makeGraph(enumerateCorpus(6)[0]);
			const baseOrder = referenceOrder(baseGraph);
			const observedCompareSigns = new Set<number>();
			const observedHashArities = new Set<number>();
			const observedHashDomainByteLengths = new Set<number>();
			const observedHashPartLengths = new Set<number>();
			for (const [valueIndex, value] of values.entries()) {
				const [compareLeft, compareRight] = compareCases[valueIndex % compareCases.length] as readonly [
					Uint8Array,
					Uint8Array,
				];
				const hashDomain = hashDomainForCase(valueIndex);
				const hashParts = hashPartsForCase(valueIndex);
				observedHashArities.add(hashParts.length);
				observedHashDomainByteLengths.add(new TextEncoder().encode(hashDomain).byteLength);
				for (const { length } of hashParts) observedHashPartLengths.add(length);
				const slots = materializePeerSlots({
					...baseSlot(baseGraph, baseOrder),
					compareLeft,
					compareRight,
					hashDomain,
					hashParts,
					value,
				});
				expectSlotsIsolated(slots);
				const observed = await driver.runCanonicalPair(slots.originalSlot, slots.currentSlot);
				observedCompareSigns.add(observed.current.compare);
				expect(observed.current.encoded).toEqual(observed.original.encoded);
				expect(semanticEqual(observed.current.clone, observed.original.clone)).toBe(true);
				expect(
					semanticEqual(observed.current.clone, slots.currentSlot.value),
					`current clone semantic equality ${valueIndex}:${value?.constructor?.name ?? typeof value}`
				).toBe(true);
				expect(
					semanticEqual(observed.original.clone, slots.originalSlot.value),
					`original clone semantic equality ${valueIndex}:${value?.constructor?.name ?? typeof value}`
				).toBe(true);
				const decodeSlots = materializePeerSlots({
					...baseSlot(baseGraph, baseOrder),
					decodeBytes: observed.original.encoded,
					value,
				});
				const decoded = await driver.runDecodePair(decodeSlots.originalSlot, decodeSlots.currentSlot);
				expect(semanticEqual(decoded.current, decoded.original)).toBe(true);
				expect(semanticEqual(decoded.current, value)).toBe(true);
				expect(semanticEqual(decoded.original, value)).toBe(true);
				const reencodeSlots = materializePeerSlots({ ...baseSlot(baseGraph, baseOrder), value: decoded.original });
				const reencoded = await driver.runCanonicalPair(reencodeSlots.originalSlot, reencodeSlots.currentSlot);
				expect(reencoded.current.encoded).toEqual(observed.current.encoded);
				expect(reencoded.original.encoded).toEqual(observed.original.encoded);
				expect(observed.current.compare).toBe(
					compareBytes(slots.currentSlot.compareLeft, slots.currentSlot.compareRight)
				);
				expect(observed.original.compare).toBe(
					compareBytes(slots.originalSlot.compareLeft, slots.originalSlot.compareRight)
				);
				expect(observed.current.digest).toEqual(domainHash(slots.currentSlot.hashDomain, slots.currentSlot.hashParts));
				expect(observed.original.digest).toEqual(
					domainHash(slots.originalSlot.hashDomain, slots.originalSlot.hashParts)
				);
				expect(flipFirstByte(observed.current.encoded)).not.toEqual(observed.original.encoded);
				expect(observed.current.compare + 1).not.toBe(
					compareBytes(slots.currentSlot.compareLeft, slots.currentSlot.compareRight)
				);
				expect(flipFirstByte(observed.current.digest)).not.toEqual(
					domainHash(slots.currentSlot.hashDomain, slots.currentSlot.hashParts)
				);
				expect(semanticEqual({ wrongDecode: true }, decoded.original)).toBe(false);
				const currentSourceSnapshot = structuredClone(slots.currentSlot.value);
				const originalSourceSnapshot = structuredClone(slots.originalSlot.value);
				expectDetachedClone(slots.currentSlot.value, observed.current.clone);
				expectDetachedClone(slots.originalSlot.value, observed.original.clone);
				mutateFirstMutable(observed.current.clone);
				mutateFirstMutable(observed.original.clone);
				expect(semanticEqual(slots.currentSlot.value, currentSourceSnapshot)).toBe(true);
				expect(semanticEqual(slots.originalSlot.value, originalSourceSnapshot)).toBe(true);
			}
			expect(
				[...observedCompareSigns].sort((left, right) => left - right),
				"byte comparison signs"
			).toEqual([-1, 0, 1]);
			expect(
				[...observedHashArities].sort((left, right) => left - right),
				"domain-hash arities"
			).toEqual([0, 1, 2, 3, 4]);
			expect(
				[...observedHashDomainByteLengths].sort((left, right) => left - right),
				"domain-hash domain byte lengths"
			).toEqual([0, 1, 2, 4, 255, 256]);
			expect(
				[...observedHashPartLengths].sort((left, right) => left - right),
				"domain-hash part lengths"
			).toEqual(RUN_EXPANDED ? [...HASH_PART_BOUNDARY_LENGTHS] : [0, 1, 2, 15, 16, 31, 33, 63, 64, 65]);
			const d2Slots = materializePeerSlots({
				...baseSlot(baseGraph, baseOrder),
				value: Float32Array.of(-0),
			});
			const d2 = await driver.runD2Pair(d2Slots.originalSlot, d2Slots.currentSlot);
			expect(bytesEqual(d2.original, d2.current), "D2_PROVENANCE_PEER_SUBSTITUTION").toBe(false);
			const aliasedProof = await driver.runAliasedInclusionPair(d2Slots.originalSlot, d2Slots.currentSlot);
			expect(aliasedProof).toEqual({ current: false, original: true });
			expect((await driver.runOriginalMissingResolver(d2Slots.originalSlot)).map(({ hash }) => hash)).toEqual(
				baseOrder.slice(1)
			);
			await expect(
				Promise.resolve().then(() => driver.runCurrentMissingResolver(d2Slots.currentSlot))
			).rejects.toMatchObject({
				code: "MISSING_CONFLICT_RESOLVER",
			});

			const corpus = enumerateCorpus(RUN_EXPANDED ? 7 : 6);
			for (const shape of corpus) {
				for (const graph of insertionPermutations(makeGraph(shape))) {
					const expected = referenceOrder(graph);
					const slots = materializePeerSlots(baseSlot(graph, expected));
					const ordered = await driver.runOrderPair(slots.originalSlot, slots.currentSlot);
					expect(ordered).toEqual({
						current: expected,
						original: expected,
					});
					if (expected.length > 1) expect([...ordered.current].reverse()).not.toEqual(expected);
					expect(ordered.current.slice(0, -1)).not.toEqual(expected);
					const linearized = await driver.runLinearizePair(slots.originalSlot, slots.currentSlot);
					expect(linearized.current.map(({ hash }) => hash)).toEqual(expected.slice(1));
					expect(linearized.original.map(({ hash }) => hash)).toEqual(expected.slice(1));
					expect([expected[0], ...linearized.current.map(({ hash }) => hash)]).not.toEqual(expected.slice(1));
				}
				const graph = makeGraph(shape);
				const expected = referenceOrder(graph);
				for (let left = 0; left < shape.ancestorMasks.length; left++) {
					for (let right = 0; right < shape.ancestorMasks.length; right++) {
						const slots = materializePeerSlots({
							...baseSlot(graph, expected),
							queryLeft: hashForIndex(left),
							queryRight: hashForIndex(right),
						});
						const ancestor = expectedAncestor(shape.ancestorMasks, left, right);
						const related = expectedRelated(shape.ancestorMasks, left, right);
						const observedAncestor = await driver.runAncestorPair(slots.originalSlot, slots.currentSlot);
						expect(observedAncestor).toEqual({
							current: ancestor,
							original: ancestor,
						});
						const observedRelated = await driver.runRelatedPair(slots.originalSlot, slots.currentSlot);
						expect(observedRelated).toEqual({
							current: related,
							original: related,
						});
						expect({ ...observedAncestor, current: !observedAncestor.current }).not.toEqual({
							current: ancestor,
							original: ancestor,
						});
						expect({ ...observedRelated, original: !observedRelated.original }).not.toEqual({
							current: related,
							original: related,
						});
					}
				}
			}

			const merkleBoundarySizes = RUN_EXPANDED ? MERKLE_BOUNDARY_SIZES : ORDINARY_MERKLE_BOUNDARY_SIZES;
			for (const size of merkleBoundarySizes) {
				const leaves = Array.from({ length: size }, (_, index) => new TextEncoder().encode(`leaf-${index}`));
				const graph = makeGraph(enumerateCorpus(6)[0]);
				const order = referenceOrder(graph);
				const common = {
					...baseSlot(graph, order),
					aliasedInclusionProof:
						size === 0
							? { auditPath: [], leafIndex: 2 ** 32, treeSize: 2 ** 32 }
							: {
									auditPath: rfcInclusionPath(leaves, size - 1),
									leafIndex: 2 ** 32 + size - 1,
									treeSize: 2 ** 32 + size,
								},
					firstRoot: rfcRoot([]),
					firstSize: 0,
					inclusionIndex: Math.max(0, size - 1),
					inclusionProof:
						size === 0
							? { auditPath: [], leafIndex: 0, treeSize: 0 }
							: {
									auditPath: rfcInclusionPath(leaves, size - 1),
									leafIndex: size - 1,
									treeSize: size,
								},
					leaves,
					proofPath: rfcConsistencyPath(leaves, 0),
					secondRoot: rfcRoot(leaves),
				};
				const slots = materializePeerSlots(common);
				const roots = await driver.runMerkleRootPair(slots.originalSlot, slots.currentSlot);
				expect(roots.current).toEqual(rfcRoot(leaves));
				expect(roots.original).toEqual(rfcRoot(leaves));
				expect(bytesEqual(roots.original, roots.current)).toBe(true);
				const range = await driver.runMerkleRangePair(slots.originalSlot, slots.currentSlot);
				for (const peer of [range.original, range.current]) {
					expect(peer.rangeHash).toEqual(rfcRoot(leaves));
					expect(flipFirstByte(peer.rangeHash)).not.toEqual(rfcRoot(leaves));
				}
				if (size > 0) {
					const observed = await driver.runMerklePair(slots.originalSlot, slots.currentSlot);
					for (const peer of [observed.original, observed.current]) {
						expect(peer.leafHash).toEqual(rfcLeafHash(leaves[0] as Uint8Array));
						expect(peer.nodeHash).toEqual(rfcNodeHash(common.firstRoot, common.secondRoot));
						expect(flipFirstByte(peer.leafHash)).not.toEqual(rfcLeafHash(leaves[0] as Uint8Array));
						expect(rfcNodeHash(common.secondRoot, common.firstRoot)).not.toEqual(peer.nodeHash);
					}
					for (let inclusionIndex = 0; inclusionIndex < size; inclusionIndex++) {
						const proof = {
							auditPath: rfcInclusionPath(leaves, inclusionIndex),
							leafIndex: inclusionIndex,
							treeSize: size,
						};
						const inclusionSlots = materializePeerSlots({ ...common, inclusionIndex, inclusionProof: proof });
						const inclusion = await driver.runInclusionPair(inclusionSlots.originalSlot, inclusionSlots.currentSlot);
						for (const peer of [inclusion.original, inclusion.current]) {
							expect(peer.proof).toEqual(proof);
							expect(peer.valid).toBe(true);
							if (proof.auditPath.length > 0) {
								expect(peer.proof.auditPath.slice(0, -1)).not.toEqual(proof.auditPath);
							}
							expect([...peer.proof.auditPath, new Uint8Array(32)]).not.toEqual(proof.auditPath);
							if (proof.auditPath.length > 1) {
								expect([...peer.proof.auditPath].reverse()).not.toEqual(proof.auditPath);
							}
							expect({ ...peer.proof, leafIndex: peer.proof.leafIndex + 1 }).not.toEqual(proof);
						}
					}
				}
				const prefixSizes = [
					...new Set([
						...Array.from({ length: Math.min(size, 33) + 1 }, (_, prefix) => prefix),
						...MERKLE_BOUNDARY_SIZES.filter((prefix) => prefix <= size),
						size,
					]),
				].sort((left, right) => left - right);
				for (const firstSize of prefixSizes) {
					const proofPath = rfcConsistencyPath(leaves, firstSize);
					const consistencySlots = materializePeerSlots({
						...common,
						firstRoot: rfcRoot(leaves.slice(0, firstSize)),
						firstSize,
						proofPath,
					});
					const consistency = await driver.runConsistencyPair(
						consistencySlots.originalSlot,
						consistencySlots.currentSlot
					);
					for (const peer of [consistency.original, consistency.current]) {
						expect(peer.proof).toEqual({ firstSize, path: proofPath, secondSize: size });
						expect(peer.valid).toBe(true);
						if (proofPath.length > 0) expect(peer.proof.path.slice(0, -1)).not.toEqual(proofPath);
						expect([...peer.proof.path, new Uint8Array(32)]).not.toEqual(proofPath);
						if (proofPath.length > 1) expect([...peer.proof.path].reverse()).not.toEqual(proofPath);
						expect({ ...peer.proof, firstSize: firstSize + 1 }).not.toEqual({
							firstSize,
							path: proofPath,
							secondSize: size,
						});
					}
				}
			}

			const historyLeaf = bytesFromHex(D93_56_HISTORY_LEAF_CANONICAL_HEX);
			const historyGraph = makeGraph(enumerateCorpus(6)[0]);
			const historyOrder = referenceOrder(historyGraph);
			const historyRoot = rfcRoot([historyLeaf]);
			const historyProof = { auditPath: [], leafIndex: 0, treeSize: 1 };
			const historySlots = materializePeerSlots({
				...baseSlot(historyGraph, historyOrder),
				aliasedInclusionProof: { auditPath: [], leafIndex: 2 ** 32, treeSize: 2 ** 32 + 1 },
				firstRoot: rfcRoot([]),
				firstSize: 0,
				inclusionIndex: 0,
				inclusionProof: historyProof,
				leaves: [historyLeaf],
				proofPath: [],
				secondRoot: historyRoot,
			});
			expect(await driver.runMerkleRootPair(historySlots.originalSlot, historySlots.currentSlot)).toEqual({
				current: historyRoot,
				original: historyRoot,
			});
			expect(await driver.runInclusionPair(historySlots.originalSlot, historySlots.currentSlot)).toEqual({
				current: { proof: historyProof, valid: true },
				original: { proof: historyProof, valid: true },
			});
			expect(await driver.runAccumulatorPair(historySlots.originalSlot, historySlots.currentSlot)).toEqual({
				current: { root: historyRoot, snapshot: rfcAccumulatorSnapshot([historyLeaf]) },
				original: { root: historyRoot, snapshot: rfcAccumulatorSnapshot([historyLeaf]) },
			});

			for (let size = 0; size <= 256; size++) {
				const leaves = Array.from({ length: size }, (_, index) =>
					new TextEncoder().encode(`phase-3-exit-e-accumulator-${index}`)
				);
				const graph = makeGraph(enumerateCorpus(6)[0]);
				const order = referenceOrder(graph);
				const slots = materializePeerSlots({ ...baseSlot(graph, order), leaves });
				const observed = await driver.runAccumulatorPair(slots.originalSlot, slots.currentSlot);
				const expectedSnapshot = rfcAccumulatorSnapshot(leaves);
				expect(observed.current).toEqual(observed.original);
				for (const peer of [observed.original, observed.current]) {
					expect(peer.root).toEqual(rfcRoot(leaves));
					expect(peer.snapshot).toEqual(expectedSnapshot);
					expect(flipFirstByte(peer.root)).not.toEqual(rfcRoot(leaves));
					if (peer.snapshot.peaks.length > 1) {
						expect([...peer.snapshot.peaks].reverse()).not.toEqual(peer.snapshot.peaks);
					}
				}
			}
		},
		RUN_EXPANDED ? 600_000 : 120_000
	);
});
