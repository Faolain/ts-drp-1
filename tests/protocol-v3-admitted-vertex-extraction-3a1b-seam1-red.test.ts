import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import protocolV3Package from "../packages/protocol-v3/package.json" with { type: "json" };
import admissionContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import budgetContract from "./fixtures/phase-0p2-v3/blueprint-operation-budget-contract.json" with { type: "json" };

interface CanonicalModule {
	decodeCanonical(bytes: Uint8Array): unknown;
	encodeCanonical(value: unknown): Uint8Array;
	hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array;
}

interface Ed25519Module {
	ed25519: {
		verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options?: unknown): boolean;
	};
}

const calls = vi.hoisted(() => ({
	decode: 0,
	encode: 0,
	hash: 0,
	resolver: 0,
	verify: 0,
	lastDecodeInput: undefined as Uint8Array | undefined,
	lastDecodedVertex: undefined as Record<string, unknown> | undefined,
	lastVertexHashInput: undefined as Uint8Array | undefined,
	lastVertexDigest: undefined as Uint8Array | undefined,
	verifyOptions: undefined as unknown,
	afterEncode: undefined as (() => void) | undefined,
}));

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const actual = await importOriginal<CanonicalModule>();
	return {
		...actual,
		decodeCanonical(bytes: Uint8Array): unknown {
			calls.decode++;
			calls.lastDecodeInput = bytes;
			const decoded = actual.decodeCanonical(bytes);
			if (
				decoded !== null &&
				typeof decoded === "object" &&
				(decoded as Record<string, unknown>).kind === "drp-vertex"
			) {
				calls.lastDecodedVertex = decoded as Record<string, unknown>;
			}
			return decoded;
		},
		encodeCanonical(value: unknown): Uint8Array {
			calls.encode++;
			const bytes = actual.encodeCanonical(value);
			calls.afterEncode?.();
			return bytes;
		},
		hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
			if (domain === VERTEX_DOMAIN) calls.hash++;
			if (domain === VERTEX_DOMAIN) calls.lastVertexHashInput = parts[0];
			const digest = actual.hashDomain(domain, ...parts);
			if (domain === VERTEX_DOMAIN) calls.lastVertexDigest = digest;
			return digest;
		},
	};
});

vi.mock("../packages/protocol-v3/node_modules/@noble/curves/ed25519.js", async (importOriginal) => {
	const actual = await importOriginal<Ed25519Module>();
	return {
		...actual,
		ed25519: {
			...actual.ed25519,
			verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options?: unknown): boolean {
				calls.verify++;
				calls.verifyOptions = options;
				return actual.ed25519.verify(signature, message, publicKey, options);
			},
		},
	};
});

const { decodeCanonical, encodeCanonical } = await import("@ts-drp/canonical");

interface RawPublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

interface AdmitInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission: unknown;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawPublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

interface AdmissionDecision {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
}

type FailureReason = "malformed-input" | "not-authenticated" | "admission-rejected";

interface AdmittedView {
	readonly kind: "drp-vertex";
	readonly protocolMajor: 3;
	readonly objectId: string;
	readonly epoch: number;
	readonly anchor: string;
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly dependencies: readonly string[];
	readonly operation: Readonly<Record<string, unknown>>;
	readonly digest: Uint8Array;
}

type ExtractResult =
	| Readonly<{ readonly ok: false; readonly reason: FailureReason }>
	| Readonly<{ readonly ok: true; readonly vertex: AdmittedView }>;

interface ProtocolSurface {
	readonly [name: string]: unknown;
	admitReceivedVertex?(input: AdmitInput): AdmissionDecision;
	extractAdmittedReceivedVertex?(input: AdmitInput): ExtractResult;
	prepareBlueprintAdmission?(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): unknown;
}

interface RemoteCase {
	readonly bytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_ENTRY = resolve(ROOT, "packages/protocol-v3/src/public.ts");
const INDEX_ENTRY = resolve(ROOT, "packages/protocol-v3/src/index.ts");
const surfaceLoad = import(pathToFileURL(PUBLIC_ENTRY).href) as Promise<ProtocolSurface>;
const VERTEX_DOMAIN = "ts-drp/vertex/v3";
const VERTEX_SUITE = "ed25519-sha256-v3";
const EXPECTED_RUNTIME_EXPORTS = [
	"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
	"admitReceivedVertex",
	"authenticateCurrentEpochAnchor",
	"createAdmissionBoundTransactionalVertexIssuer",
	"extractAdmittedReceivedVertex",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCurrentAnchorTrust",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
] as const;
const EXPECTED_FORBIDDEN_RUNTIME_EXPORTS = [
	"authenticateCertifiedCurrentEpochAnchor",
	"composeAuthorGossipBudget",
	"createCurrentAnchorTrustStore",
	"createDurableAuthorEquivocationProjection",
	"createRemoteEquivocationObserver",
	"createTransactionalVertexIssuer",
	"deriveEquivocationProofId",
	"inspectTrustClosure",
	"installCertifiedAnchorTrustRoot",
	"materializeCurrentEquivocationProof",
	"openCertifiedAnchorTrust",
	"prepareAnchorTrustAdvance",
	"verifyEquivocationProof",
	"verifyReceivedVertex",
	"verifyTrustRecord",
] as const;
const EXPECTED_VERTEX_KEYS = [
	"kind",
	"protocolMajor",
	"objectId",
	"epoch",
	"anchor",
	"author",
	"authorSequence",
	"logicalTime",
	"dependencies",
	"operation",
	"digest",
] as const;
const PKCS8_PREFIX = fromHex("302e020100300506032b657004220420");
const SPKI_PREFIX_BYTES = 12;

function resetCalls(): void {
	calls.decode = 0;
	calls.encode = 0;
	calls.hash = 0;
	calls.resolver = 0;
	calls.verify = 0;
	calls.lastDecodeInput = undefined;
	calls.lastDecodedVertex = undefined;
	calls.lastVertexHashInput = undefined;
	calls.lastVertexDigest = undefined;
	calls.verifyOptions = undefined;
	calls.afterEncode = undefined;
}

interface ProtocolCallCounts {
	readonly decode: number;
	readonly encode: number;
	readonly hash: number;
	readonly resolver: number;
	readonly verify: number;
}

const ONE_PROTOCOL_PASS: ProtocolCallCounts = Object.freeze({ decode: 1, encode: 1, hash: 1, resolver: 1, verify: 1 });
const ZERO_PROTOCOL_WORK: ProtocolCallCounts = Object.freeze({ decode: 0, encode: 0, hash: 0, resolver: 0, verify: 0 });

function protocolCallCounts(): ProtocolCallCounts {
	return {
		decode: calls.decode,
		encode: calls.encode,
		hash: calls.hash,
		resolver: calls.resolver,
		verify: calls.verify,
	};
}

function expectFrozenFailure(result: ExtractResult, reason: FailureReason, label?: string): void {
	expect(result, label).toEqual({ ok: false, reason });
	expect(Reflect.ownKeys(result), label).toEqual(["ok", "reason"]);
	expect(Object.getPrototypeOf(result), label).toBe(Object.prototype);
	expect(Object.isFrozen(result), label).toBe(true);
}

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsigned(value: number, width: 4 | 8): Uint8Array {
	const output = new Uint8Array(width);
	const view = new DataView(output.buffer);
	if (width === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function independentHashDomain(domain: string, bytes: Uint8Array): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(
				concat([
					Uint8Array.of(0x44, 0x52, 0x50, 0),
					unsigned(domainBytes.byteLength, 4),
					domainBytes,
					unsigned(bytes.byteLength, 8),
					bytes,
				])
			)
			.digest()
	);
}

function keyMaterial(): { readonly privateKey: ReturnType<typeof createPrivateKey>; readonly publicKey: Uint8Array } {
	const seed = fromHex(admissionContract.privateKeySeedHex);
	const privateKey = createPrivateKey({ key: Buffer.from(concat([PKCS8_PREFIX, seed])), format: "der", type: "pkcs8" });
	const spki = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
	return { privateKey, publicKey: spki.slice(SPKI_PREFIX_BYTES) };
}

function complexOperation(): Readonly<Record<string, unknown>> {
	return {
		action: "append",
		nested: {
			array: ["alpha", Uint8Array.of(1, 2, 3), { deep: true }],
			bytes: Uint8Array.of(4, 5, 6),
			float32: new Float32Array([1.5, -0]),
			float64: new Float64Array([2.5, -0]),
			int32: new Int32Array([-3, 4]),
			map: new Map<unknown, unknown>([["key", { value: Uint8Array.of(7, 8) }]]),
			primitives: [null, false, 42, -1.25, "text"],
			set: new Set<unknown>(["set-value", new Uint32Array([9, 10])]),
		},
		requestOrdinal: 7,
		value: "phase-3a1b-seam1",
	};
}

function assertDetachedCanonicalCopy(actual: unknown, source: unknown, path = "operation"): void {
	if (source === null || typeof source !== "object") {
		expect(Object.is(actual, source), path).toBe(true);
		return;
	}
	if (ArrayBuffer.isView(source)) {
		expect(ArrayBuffer.isView(actual), path).toBe(true);
		if (!ArrayBuffer.isView(actual)) return;
		expect(actual.constructor, path).toBe(source.constructor);
		expect(actual, path).not.toBe(source);
		expect(actual.buffer, path).not.toBe(source.buffer);
		expect(actual.byteOffset, path).toBe(0);
		expect(actual.buffer.byteLength, path).toBe(actual.byteLength);
		expect(Object.isFrozen(actual), path).toBe(false);
		expect(actual, path).toEqual(source);
		return;
	}
	if (Array.isArray(source)) {
		expect(Array.isArray(actual), path).toBe(true);
		if (!Array.isArray(actual)) return;
		expect(actual, path).not.toBe(source);
		expect(Object.isFrozen(actual), path).toBe(true);
		expect(actual).toHaveLength(source.length);
		for (let index = 0; index < source.length; index++) {
			assertDetachedCanonicalCopy(actual[index], source[index], `${path}[${index}]`);
		}
		return;
	}
	if (source instanceof Map) {
		expect(actual, path).toBeInstanceOf(Map);
		if (!(actual instanceof Map)) return;
		expect(actual, path).not.toBe(source);
		expect(Object.isFrozen(actual), path).toBe(true);
		expect(actual.size, path).toBe(source.size);
		const actualEntries = [...actual.entries()];
		const sourceEntries = [...source.entries()];
		for (let index = 0; index < sourceEntries.length; index++) {
			assertDetachedCanonicalCopy(actualEntries[index]?.[0], sourceEntries[index]?.[0], `${path}.key[${index}]`);
			assertDetachedCanonicalCopy(actualEntries[index]?.[1], sourceEntries[index]?.[1], `${path}.value[${index}]`);
		}
		return;
	}
	if (source instanceof Set) {
		expect(actual, path).toBeInstanceOf(Set);
		if (!(actual instanceof Set)) return;
		expect(actual, path).not.toBe(source);
		expect(Object.isFrozen(actual), path).toBe(true);
		expect(actual.size, path).toBe(source.size);
		const actualValues = [...actual.values()];
		const sourceValues = [...source.values()];
		for (let index = 0; index < sourceValues.length; index++) {
			assertDetachedCanonicalCopy(actualValues[index], sourceValues[index], `${path}.set[${index}]`);
		}
		return;
	}
	expect(actual !== null && typeof actual === "object", path).toBe(true);
	if (actual === null || typeof actual !== "object") return;
	expect(actual, path).not.toBe(source);
	expect(Object.getPrototypeOf(actual), path).toBe(Object.prototype);
	expect(Object.isFrozen(actual), path).toBe(true);
	expect(Object.keys(actual), path).toEqual(Object.keys(source));
	for (const key of Object.keys(source)) {
		assertDetachedCanonicalCopy(
			(actual as Record<string, unknown>)[key],
			(source as Record<string, unknown>)[key],
			`${path}.${key}`
		);
	}
}

function assertCanonicalZeroNormalization(vertex: Readonly<Record<string, unknown>>): void {
	const nested = (vertex.operation as Record<string, unknown>).nested as Record<string, unknown>;
	expect(Object.is((nested.float32 as Float32Array)[1], 0)).toBe(true);
	expect(Object.is((nested.float32 as Float32Array)[1], -0)).toBe(false);
	expect(Object.is((nested.float64 as Float64Array)[1], 0)).toBe(true);
	expect(Object.is((nested.float64 as Float64Array)[1], -0)).toBe(false);
}

function vertexPreimage(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: admissionContract.vertex.objectId,
		epoch: admissionContract.vertex.epoch,
		anchor: admissionContract.vertex.anchor,
		author: admissionContract.vertex.author,
		authorSequence: admissionContract.vertex.authorSequence,
		logicalTime: admissionContract.vertex.logicalTime,
		dependencies: admissionContract.vertex.dependencies,
		operation,
	};
}

function signedRemote(operation: Readonly<Record<string, unknown>>): RemoteCase {
	const bytes = encodeCanonical(vertexPreimage(operation));
	const digest = independentHashDomain(VERTEX_DOMAIN, bytes);
	return {
		bytes,
		digest,
		signature: new Uint8Array(nodeSign(null, Buffer.from(digest), keyMaterial().privateKey)),
	};
}

async function preparedAdmission(limit = 16_384, operationName = "append"): Promise<unknown> {
	const packageValue = structuredClone(budgetContract.budgetedPackage);
	const operation = packageValue.manifest.operations[0];
	if (operation === undefined) throw new Error("SEAM1_BUDGET_OPERATION_MISSING");
	operation.maxCanonicalOperationBytes = limit;
	operation.name = operationName;
	const bytes = encodeCanonical(packageValue);
	const expectedBlueprintDigest = Buffer.from(
		independentHashDomain(budgetContract.blueprintDigestDomain, bytes)
	).toString("hex");
	const prepare = (await surfaceLoad).prepareBlueprintAdmission;
	if (typeof prepare !== "function") throw new Error("SEAM1_PREPARER_MISSING");
	return prepare({ canonicalBlueprintPackageBytes: bytes, expectedBlueprintDigest });
}

function exactInput(remote: RemoteCase, admission: unknown): AdmitInput {
	const material = keyMaterial();
	const input: AdmitInput = {
		domain: VERTEX_DOMAIN,
		expectedAnchor: admissionContract.vertex.anchor,
		preparedBlueprintAdmission: admission,
		receivedCanonicalPreimageBytes: remote.bytes,
		resolveAuthorPublicKey(this: AdmitInput, author: string): RawPublicKey | undefined {
			calls.resolver++;
			if (this !== input || this.expectedAnchor !== admissionContract.vertex.anchor) {
				throw new Error("SEAM1_RESOLVER_THIS_LOST");
			}
			return author === admissionContract.vertex.author ? { bytes: material.publicKey, format: "raw" } : undefined;
		},
		signature: remote.signature,
		suiteId: VERTEX_SUITE,
	};
	return input;
}

function copyInput(input: AdmitInput, overrides: Partial<AdmitInput> = {}): AdmitInput {
	const copied = { ...input, ...overrides };
	if (overrides.resolveAuthorPublicKey === undefined) {
		const material = keyMaterial();
		copied.resolveAuthorPublicKey = function (this: AdmitInput, author: string): RawPublicKey | undefined {
			calls.resolver++;
			if (this !== copied) throw new Error("SEAM1_RESOLVER_THIS_LOST");
			return author === admissionContract.vertex.author ? { bytes: material.publicKey, format: "raw" } : undefined;
		};
	}
	return copied;
}

async function extractFunction(): Promise<(input: AdmitInput) => ExtractResult> {
	const candidate = (await surfaceLoad).extractAdmittedReceivedVertex;
	if (typeof candidate !== "function") throw new Error("PHASE_3A1B_SEAM1_MISSING_EXPORT");
	return candidate;
}

async function admitFunction(): Promise<(input: AdmitInput) => AdmissionDecision> {
	const candidate = (await surfaceLoad).admitReceivedVertex;
	if (typeof candidate !== "function") throw new Error("PHASE_3A1B_ADMIT_MISSING_EXPORT");
	return candidate;
}

async function validCase(
	operation = complexOperation(),
	limit = 16_384
): Promise<{
	readonly admission: unknown;
	readonly independentlyDecodedVertex: Readonly<Record<string, unknown>>;
	readonly input: AdmitInput;
	readonly remote: RemoteCase;
}> {
	const admission = await preparedAdmission(limit);
	const remote = signedRemote(operation);
	const independentlyDecodedVertex = decodeCanonical(remote.bytes);
	if (
		independentlyDecodedVertex === null ||
		typeof independentlyDecodedVertex !== "object" ||
		Array.isArray(independentlyDecodedVertex)
	)
		throw new TypeError("SEAM1_INDEPENDENT_DECODE_NOT_RECORD");
	const input = exactInput(remote, admission);
	resetCalls();
	return {
		admission,
		independentlyDecodedVertex: independentlyDecodedVertex as Readonly<Record<string, unknown>>,
		input,
		remote,
	};
}

function resolvedCallNames(declaration: ts.FunctionDeclaration): readonly string[] {
	const aliases = new Map<string, string>();
	const names: string[] = [];
	const resolveAlias = (name: string): string => {
		const visited = new Set<string>();
		while (aliases.has(name) && !visited.has(name)) {
			visited.add(name);
			name = aliases.get(name) as string;
		}
		return name;
	};
	const expressionName = (expression: ts.Expression): string | undefined => {
		if (ts.isIdentifier(expression)) return resolveAlias(expression.text);
		if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
		if (
			ts.isElementAccessExpression(expression) &&
			expression.argumentExpression !== undefined &&
			ts.isStringLiteral(expression.argumentExpression)
		)
			return expression.argumentExpression.text;
		return undefined;
	};
	const visit = (node: ts.Node): void => {
		if (node !== declaration && ts.isFunctionLike(node)) return;
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
			const target = expressionName(node.initializer);
			if (target !== undefined) aliases.set(node.name.text, target);
		}
		if (ts.isCallExpression(node)) {
			const name = expressionName(node.expression);
			if (name !== undefined) names.push(name);
		}
		ts.forEachChild(node, visit);
	};
	visit(declaration);
	return names;
}

function auditDecisionOwnership(sourceText: string): readonly string[] {
	const source = ts.createSourceFile("index.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const functions = new Map<string, ts.FunctionDeclaration[]>();
	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
		const entries = functions.get(statement.name.text) ?? [];
		entries.push(statement);
		functions.set(statement.name.text, entries);
	}
	const violations: string[] = [];
	for (const name of ["decideReceivedVertex", "admitReceivedVertex", "extractAdmittedReceivedVertex"] as const) {
		if ((functions.get(name)?.length ?? 0) !== 1) violations.push(`owner-count:${name}`);
	}
	const decide = functions.get("decideReceivedVertex")?.[0];
	const admit = functions.get("admitReceivedVertex")?.[0];
	const extract = functions.get("extractAdmittedReceivedVertex")?.[0];
	if (decide !== undefined) {
		if (decide.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) violations.push("core-exported");
	}
	const semanticAuthorityCalls = new Set([
		"authenticateReceivedVertex",
		"consumerPreparedAdmissionState",
		"decodeCanonical",
		"detachCanonicalRecord",
		"digestReceivedVertexPreimage",
		"encodeCanonical",
		"operationSchemaForPreparedAdmission",
		"operationWithinCanonicalByteBudget",
		"resolveAuthorPublicKey",
		"verifyEd25519RegisteredDigest",
		"verifyReceivedVertex",
		"vertexCanonicalBytes",
		"vertexDigest",
		"vertexPreimage",
	]);
	const reachableCalls = (declaration: ts.FunctionDeclaration): readonly string[] => {
		const output: string[] = [];
		const walk = (current: ts.FunctionDeclaration, active: ReadonlySet<string>): void => {
			for (const called of resolvedCallNames(current)) {
				output.push(called);
				const target = functions.get(called)?.[0];
				if (target !== undefined && !active.has(called)) walk(target, new Set([...active, called]));
			}
		};
		walk(declaration, new Set([declaration.name?.text ?? "<anonymous>"]));
		return output;
	};
	for (const [name, declaration] of [
		["admit", admit],
		["extract", extract],
	] as const) {
		if (declaration === undefined) continue;
		const names = resolvedCallNames(declaration);
		if (names.filter((value) => value === "decideReceivedVertex").length !== 1) {
			violations.push(`${name}-decision-count`);
		}
		const graph = reachableCalls(declaration);
		for (const semantic of semanticAuthorityCalls) {
			if (graph.filter((called) => called === semantic).length > 1) {
				violations.push(`${name}-duplicates:${semantic}`);
			}
		}
	}
	if (extract !== undefined && reachableCalls(extract).includes("admitReceivedVertex")) {
		violations.push("extract-routes-through-admit");
	}
	return violations.sort();
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	while (
		ts.isAsExpression(expression) ||
		ts.isParenthesizedExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	)
		expression = expression.expression;
	return expression;
}

function stringArray(expression: ts.Expression): readonly string[] | undefined {
	const unwrapped = unwrapExpression(expression);
	if (!ts.isArrayLiteralExpression(unwrapped) || !unwrapped.elements.every(ts.isStringLiteral)) return undefined;
	return unwrapped.elements.map((element) => (element as ts.StringLiteral).text);
}

function namedVariableStringArray(source: ts.SourceFile, ownerName: string): readonly string[] {
	const matches: Array<readonly string[]> = [];
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === ownerName &&
				declaration.initializer !== undefined
			) {
				const values = stringArray(declaration.initializer);
				if (values !== undefined) matches.push(values);
			}
		}
	}
	expect(matches, `${source.fileName}:${ownerName}`).toHaveLength(1);
	return matches[0] ?? [];
}

type PublicRootOwner =
	| Readonly<{ kind: "identifier"; name: string }>
	| Readonly<{ kind: "awaited-value"; name: string }>;

function isPublicRootOwner(expression: ts.Expression, owner: PublicRootOwner): boolean {
	if (owner.kind === "identifier") return ts.isIdentifier(expression) && expression.text === owner.name;
	return (
		ts.isAwaitExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === owner.name
	);
}

function isSortedPublicRootKeysExpectation(call: ts.CallExpression, owner: PublicRootOwner): boolean {
	if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "toEqual") return false;
	const expectCall = call.expression.expression;
	if (
		!ts.isCallExpression(expectCall) ||
		!ts.isIdentifier(expectCall.expression) ||
		expectCall.expression.text !== "expect"
	)
		return false;
	const sortCall = expectCall.arguments[0];
	if (
		sortCall === undefined ||
		!ts.isCallExpression(sortCall) ||
		!ts.isPropertyAccessExpression(sortCall.expression) ||
		sortCall.expression.name.text !== "sort"
	)
		return false;
	const keysCall = sortCall.expression.expression;
	return (
		ts.isCallExpression(keysCall) &&
		ts.isPropertyAccessExpression(keysCall.expression) &&
		ts.isIdentifier(keysCall.expression.expression) &&
		keysCall.expression.expression.text === "Object" &&
		keysCall.expression.name.text === "keys" &&
		keysCall.arguments.length === 1 &&
		keysCall.arguments[0] !== undefined &&
		isPublicRootOwner(keysCall.arguments[0], owner)
	);
}

function namedPublicSurfaceTestArray(
	source: ts.SourceFile,
	testName: string,
	owner: PublicRootOwner
): readonly string[] {
	const matches: Array<readonly string[]> = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "it" &&
			ts.isStringLiteral(node.arguments[0]) &&
			node.arguments[0].text === testName &&
			node.arguments[1] !== undefined &&
			ts.isFunctionLike(node.arguments[1])
		) {
			const findAllowlist = (candidate: ts.Node): void => {
				if (
					ts.isCallExpression(candidate) &&
					isSortedPublicRootKeysExpectation(candidate, owner) &&
					candidate.arguments[0] !== undefined
				) {
					const values = stringArray(candidate.arguments[0]);
					if (values?.[0] === "ANCHOR_TRUST_STATE_MAX_RECORD_BYTES") matches.push(values);
				}
				ts.forEachChild(candidate, findAllowlist);
			};
			findAllowlist(node.arguments[1]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	expect(matches, `${source.fileName}:${testName}`).toHaveLength(1);
	return matches[0] ?? [];
}

function runtimeAllowlist(path: string): readonly string[] {
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	if (path.endsWith("public-export-contract.mjs")) return namedVariableStringArray(source, "expected");
	if (path.endsWith("protocol-v3-anchor-trust-3a0.test.ts"))
		return namedVariableStringArray(source, "EXPECTED_RUNTIME_EXPORTS");
	if (path.endsWith("phase-3a1-a-live-preparation-red.test.ts"))
		return namedVariableStringArray(source, "PROTOCOL_V3_RUNTIME_EXPORTS");
	if (path.endsWith("protocol-v3-blueprint-operation-budget-0p2.test.ts"))
		return namedPublicSurfaceTestArray(
			source,
			"[public-surface] preserves exactly the ten package-root runtime exports",
			{ kind: "awaited-value", name: "packageSurfaceLoad" }
		);
	if (path.endsWith("protocol-v3-blueprint-work-budget-0p0.test.ts"))
		return namedPublicSurfaceTestArray(
			source,
			"[public-surface] keeps governance inside the existing preparer with no new runtime helper export",
			{ kind: "identifier", name: "publicEntry" }
		);
	if (path.endsWith("protocol-v3-equivocation-gossip-budget-0o-b2.test.ts"))
		return namedPublicSurfaceTestArray(
			source,
			"[public-boundary] pins source, built and runtime closure for the deep-only composer",
			{ kind: "identifier", name: "sourceRuntime" }
		);
	if (path.endsWith("protocol-v3-equivocation-author-projection-0o-b1b.test.ts"))
		return namedPublicSurfaceTestArray(
			source,
			"[public-boundary] pins the closed source/built/runtime root and all three deep helpers",
			{ kind: "identifier", name: "sourceRuntime" }
		);
	throw new Error(`SEAM1_UNKNOWN_RUNTIME_PIN_OWNER:${path}`);
}

function assertExactRuntimePins(path: string): void {
	expect(runtimeAllowlist(path), path).toEqual(EXPECTED_RUNTIME_EXPORTS);
}

describe("D.93.27 public extraction seam tests-only RED", () => {
	beforeEach(() => resetCalls());

	it("pins the exact runtime root and all nine live source/type owners", async () => {
		for (const path of [
			resolve(ROOT, "tests/fixtures/phase-3a0-v3/public-entry-type-audit.ts"),
			resolve(ROOT, "tests/fixtures/phase-3a0-v3/built-package-type-audit.ts"),
		]) {
			const audit = readFileSync(path, "utf8");
			for (const name of [
				"AdmittedReceivedVertexView",
				"ExtractAdmittedReceivedVertexFailureReason",
				"ExtractAdmittedReceivedVertexResult",
				"extractAdmittedReceivedVertex",
			])
				expect(audit, `${path}:${name}`).toMatch(new RegExp(`\\b${name}\\b`, "u"));
			expect(audit).toContain("resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;");
			expect(audit).not.toMatch(/readonly resolveAuthorPublicKey\s*:/u);
		}

		for (const path of [
			resolve(ROOT, "tests/fixtures/phase-3a0-v3/public-export-contract.mjs"),
			resolve(ROOT, "tests/protocol-v3-anchor-trust-3a0.test.ts"),
			resolve(ROOT, "tests/protocol-v3-blueprint-operation-budget-0p2.test.ts"),
			resolve(ROOT, "tests/protocol-v3-blueprint-work-budget-0p0.test.ts"),
			resolve(ROOT, "tests/protocol-v3-equivocation-gossip-budget-0o-b2.test.ts"),
			resolve(ROOT, "tests/protocol-v3-equivocation-author-projection-0o-b1b.test.ts"),
			resolve(ROOT, "tests/phase-3a1-a-live-preparation-red.test.ts"),
		]) {
			assertExactRuntimePins(path);
		}
		expect(readFileSync(resolve(ROOT, "tests/phase-3a1-a-live-preparation-red.test.ts"), "utf8")).toContain(
			'"extractAdmittedReceivedVertex"'
		);

		const smoke = protocolV3Package.scripts["smoke:public-package"];
		expect(smoke).toContain("extractAdmittedReceivedVertex");
		expect(smoke).not.toContain("verifyReceivedVertex', 'extractAdmittedReceivedVertex");
		const requiredLiteral = /const required = \[(?<values>[^\]]*)\]/u.exec(smoke)?.groups?.values;
		expect(requiredLiteral).toBeDefined();
		expect(requiredLiteral?.match(/'([^']+)'/gu)?.map((quoted) => quoted.slice(1, -1))).toEqual(
			EXPECTED_RUNTIME_EXPORTS
		);
		const forbiddenLiteral = /const forbidden = \[(?<values>[^\]]*)\]/u.exec(smoke)?.groups?.values;
		expect(forbiddenLiteral).toBeDefined();
		expect(forbiddenLiteral?.match(/'([^']+)'/gu)?.map((quoted) => quoted.slice(1, -1))).toEqual(
			EXPECTED_FORBIDDEN_RUNTIME_EXPORTS
		);

		const publicSource = readFileSync(PUBLIC_ENTRY, "utf8");
		for (const name of [
			"extractAdmittedReceivedVertex",
			"AdmittedReceivedVertexView",
			"ExtractAdmittedReceivedVertexFailureReason",
			"ExtractAdmittedReceivedVertexResult",
		]) {
			expect(publicSource, name).toMatch(new RegExp(`\\b${name}\\b`, "u"));
		}
		expect(Object.keys(await surfaceLoad).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
	});

	it("preserves the old facade exact shapes, unfrozen results, digest identity, throws and single-pass counts", async () => {
		const admit = await admitFunction();
		const valid = await validCase();
		assertCanonicalZeroNormalization(valid.independentlyDecodedVertex);
		const success = admit(valid.input);
		expect(Object.keys(success)).toEqual(["admitted", "digest"]);
		expect(success).toEqual({ admitted: true, digest: valid.remote.digest });
		expect(success.digest).toBe(calls.lastVertexDigest);
		expect(Object.isFrozen(success)).toBe(false);
		expect(calls).toMatchObject({ decode: 1, encode: 1, hash: 1, resolver: 1, verify: 1 });
		expect(calls.verifyOptions).toEqual({ zip215: false });

		const openRecordInputs: AdmitInput[] = [];
		const extra = copyInput(valid.input) as AdmitInput & { extra: boolean };
		extra.extra = true;
		openRecordInputs.push(extra);
		const inherited = copyInput(valid.input) as AdmitInput & { domain?: string };
		delete (inherited as unknown as { domain?: string }).domain;
		Object.setPrototypeOf(inherited, { domain: VERTEX_DOMAIN });
		openRecordInputs.push(inherited);
		const nonenumerable = copyInput(valid.input);
		Object.defineProperty(nonenumerable, "domain", { enumerable: false, value: VERTEX_DOMAIN });
		openRecordInputs.push(nonenumerable);
		for (const input of openRecordInputs) {
			resetCalls();
			const openRecord = admit(input);
			expect(openRecord).toEqual({ admitted: true, digest: valid.remote.digest });
			expect(openRecord.digest).toBe(calls.lastVertexDigest);
			expect(calls).toMatchObject({ decode: 1, encode: 1, hash: 1, resolver: 1, verify: 1 });
		}

		resetCalls();
		const rejected = admit(copyInput(valid.input, { domain: "wrong" }));
		expect(rejected).toEqual({ admitted: false });
		expect(Object.keys(rejected)).toEqual(["admitted"]);
		expect(Object.isFrozen(rejected)).toBe(false);
		expect(calls).toMatchObject({ decode: 0, encode: 0, hash: 0, resolver: 0, verify: 0 });

		const badSignature = valid.input.signature.slice();
		badSignature[0] ^= 0xff;
		const forgedAdmission = Object.create(Object.getPrototypeOf(valid.admission)) as object;
		Object.defineProperties(forgedAdmission, Object.getOwnPropertyDescriptors(valid.admission as object));
		for (const input of [
			copyInput(valid.input, { signature: badSignature }),
			copyInput(valid.input, { preparedBlueprintAdmission: forgedAdmission }),
		]) {
			resetCalls();
			expect(admit(input)).toEqual({ admitted: false });
		}
		const unknown = await validCase({ action: "not-declared" });
		expect(admit(unknown.input)).toEqual({ admitted: false });
		const overBudget = await validCase({ action: "append", value: "x".repeat(300) }, 100);
		expect(admit(overBudget.input)).toEqual({ admitted: false });

		const marker = new Error("SEAM1_EXISTING_GETTER_THROW");
		const hostile = copyInput(valid.input);
		Object.defineProperty(hostile, "domain", {
			enumerable: true,
			get: () => {
				throw marker;
			},
		});
		expect(() => admit(hostile)).toThrow(marker);
		const proxyMarker = new Error("SEAM1_EXISTING_PROXY_THROW");
		const hostileProxy = new Proxy(valid.input, {
			get(target, key, receiver): unknown {
				if (key === "domain") throw proxyMarker;
				return Reflect.get(target, key, receiver);
			},
		});
		expect(() => admit(hostileProxy)).toThrow(proxyMarker);
	});

	it("returns the exact detached frozen eleven-key view with exclusive mutable canonical leaves", async () => {
		const extract = await extractFunction();
		const valid = await validCase();
		const first = extract(valid.input);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(Object.keys(first)).toEqual(["ok", "vertex"]);
		expect(Object.keys(first.vertex)).toEqual(EXPECTED_VERTEX_KEYS);
		expect(Reflect.ownKeys(first.vertex)).toEqual(EXPECTED_VERTEX_KEYS);
		expect(Object.getPrototypeOf(first.vertex)).toBe(Object.prototype);
		expect(
			Object.values(Object.getOwnPropertyDescriptors(first.vertex)).every(
				(descriptor) =>
					descriptor.enumerable && "value" in descriptor && !("get" in descriptor) && !("set" in descriptor)
			)
		).toBe(true);
		expect(first.vertex).toMatchObject({
			kind: "drp-vertex",
			protocolMajor: 3,
			objectId: admissionContract.vertex.objectId,
			epoch: admissionContract.vertex.epoch,
			anchor: admissionContract.vertex.anchor,
			author: admissionContract.vertex.author,
			authorSequence: admissionContract.vertex.authorSequence,
			logicalTime: admissionContract.vertex.logicalTime,
			dependencies: admissionContract.vertex.dependencies,
			digest: valid.remote.digest,
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.vertex)).toBe(true);
		expect(Object.isFrozen(first.vertex.dependencies)).toBe(true);
		expect(Object.isFrozen(first.vertex.operation)).toBe(true);
		expect(first.vertex.digest).not.toBe(valid.remote.digest);
		expect(first.vertex.digest.buffer).not.toBe(valid.input.receivedCanonicalPreimageBytes.buffer);
		expect(Object.isFrozen(first.vertex.digest)).toBe(false);
		expect(calls).toMatchObject({ decode: 1, encode: 1, hash: 1, resolver: 1, verify: 1 });
		const decodedVertex = calls.lastDecodedVertex;
		expect(decodedVertex).toBeDefined();
		if (decodedVertex === undefined) throw new TypeError("SEAM1_DECODED_VERTEX_MISSING");
		expect(first.vertex.dependencies).not.toBe(decodedVertex.dependencies);
		expect(first.vertex.operation).not.toBe(decodedVertex.operation);
		expect(first.vertex.dependencies).toEqual(valid.independentlyDecodedVertex.dependencies);
		expect(first.vertex.operation).toEqual(valid.independentlyDecodedVertex.operation);
		assertDetachedCanonicalCopy(first.vertex.dependencies, decodedVertex.dependencies, "dependencies");
		assertDetachedCanonicalCopy(first.vertex.operation, decodedVertex.operation, "operation");

		const nested = first.vertex.operation.nested as Record<string, unknown>;
		const independentlyDecodedNested = (valid.independentlyDecodedVertex.operation as Record<string, unknown>)
			.nested as Record<string, unknown>;
		assertCanonicalZeroNormalization(valid.independentlyDecodedVertex);
		const decodedNested = (decodedVertex.operation as Record<string, unknown>).nested as Record<string, unknown>;
		expect(nested).not.toBe(decodedNested);
		const array = nested.array as unknown[];
		const map = nested.map as Map<unknown, unknown>;
		const set = nested.set as Set<unknown>;
		const bytes = nested.bytes as Uint8Array;
		const arrayBytes = array[1] as Uint8Array;
		const float32 = nested.float32 as Float32Array;
		const float64 = nested.float64 as Float64Array;
		const int32 = nested.int32 as Int32Array;
		const setBytes = [...set].find((value) => value instanceof Uint32Array) as Uint32Array;
		expect([nested, array, map, set].every(Object.isFrozen)).toBe(true);
		expect([bytes, arrayBytes, float32, float64, int32, setBytes].every((value) => !Object.isFrozen(value))).toBe(true);
		const mapValue = map.get("key") as Record<string, unknown>;
		const mapBytes = mapValue.value as Uint8Array;
		expect(Object.isFrozen(mapValue)).toBe(true);
		expect(Object.isFrozen(mapBytes)).toBe(false);
		expect(mapBytes.buffer).not.toBe(valid.input.receivedCanonicalPreimageBytes.buffer);

		const receivedBeforeMutation = first.vertex.digest.slice();
		valid.input.receivedCanonicalPreimageBytes[0] ^= 0xff;
		valid.input.signature[0] ^= 0xff;
		expect(first.vertex.digest).toEqual(receivedBeforeMutation);
		valid.input.receivedCanonicalPreimageBytes[0] ^= 0xff;
		valid.input.signature[0] ^= 0xff;

		bytes[0] = 255;
		map.set("mutant", true);
		set.add("mutant");
		mapBytes[0] = 255;
		arrayBytes[0] = 255;
		float32[0] = 255;
		float64[0] = 255;
		int32[0] = 255;
		setBytes[0] = 255;
		first.vertex.digest[0] ^= 0xff;

		resetCalls();
		const second = extract(valid.input);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.vertex).not.toBe(first.vertex);
		expect(second.vertex.digest).toEqual(valid.remote.digest);
		expect(second.vertex.digest).not.toBe(first.vertex.digest);
		const secondNested = second.vertex.operation.nested as Record<string, unknown>;
		expect(second.vertex.dependencies).toEqual(valid.independentlyDecodedVertex.dependencies);
		expect(second.vertex.operation).toEqual(valid.independentlyDecodedVertex.operation);
		expect(secondNested.bytes).toEqual(independentlyDecodedNested.bytes);
		expect((secondNested.array as unknown[])[1]).toEqual((independentlyDecodedNested.array as readonly unknown[])[1]);
		expect(secondNested.float32).toEqual(independentlyDecodedNested.float32);
		expect(secondNested.float64).toEqual(independentlyDecodedNested.float64);
		expect(secondNested.int32).toEqual(independentlyDecodedNested.int32);
		expect(secondNested.primitives).toEqual(independentlyDecodedNested.primitives);
		expect((secondNested.map as Map<unknown, unknown>).has("mutant")).toBe(false);
		expect((secondNested.set as Set<unknown>).has("mutant")).toBe(false);
		expect([...(secondNested.set as Set<unknown>)]).toContainEqual(new Uint32Array([9, 10]));
	});

	it("contains every hostile structural input as malformed before protocol work", async () => {
		const extract = await extractFunction();
		const valid = await validCase(admissionContract.validOperation);
		const malformed: Array<readonly [string, unknown]> = [];
		malformed.push(["null", null], ["array", []]);
		malformed.push(["extra", { ...copyInput(valid.input), extra: true }]);
		const missing = copyInput(valid.input) as unknown as Record<string, unknown>;
		delete missing.domain;
		malformed.push(["missing", missing]);
		const symbol = copyInput(valid.input) as AdmitInput & { [key: symbol]: boolean };
		symbol[Symbol("extra")] = true;
		malformed.push(["symbol", symbol]);
		let getterCalls = 0;
		const accessor = copyInput(valid.input);
		Object.defineProperty(accessor, "domain", {
			enumerable: true,
			get() {
				getterCalls++;
				return VERTEX_DOMAIN;
			},
		});
		malformed.push(["accessor", accessor]);
		const nonenumerable = copyInput(valid.input);
		Object.defineProperty(nonenumerable, "domain", { enumerable: false, value: VERTEX_DOMAIN });
		malformed.push(["nonenumerable", nonenumerable]);
		malformed.push(["inherited", Object.assign(Object.create({ inherited: true }), copyInput(valid.input))]);
		malformed.push(["empty-preimage", copyInput(valid.input, { receivedCanonicalPreimageBytes: new Uint8Array() })]);
		malformed.push(["short-signature", copyInput(valid.input, { signature: new Uint8Array(63) })]);
		const shared = new Uint8Array(new SharedArrayBuffer(valid.remote.bytes.byteLength));
		shared.set(valid.remote.bytes);
		malformed.push(["shared-preimage", copyInput(valid.input, { receivedCanonicalPreimageBytes: shared })]);
		const sharedSignature = new Uint8Array(new SharedArrayBuffer(64));
		sharedSignature.set(valid.remote.signature);
		malformed.push(["shared-signature", copyInput(valid.input, { signature: sharedSignature })]);
		malformed.push(["array-preimage", { ...copyInput(valid.input), receivedCanonicalPreimageBytes: [] }]);
		malformed.push(["array-signature", { ...copyInput(valid.input), signature: [] }]);
		malformed.push(["nonstring-domain", { ...copyInput(valid.input), domain: 3 }]);
		malformed.push(["nonfunction-resolver", { ...copyInput(valid.input), resolveAuthorPublicKey: 3 }]);
		malformed.push([
			"proxy-ownkeys",
			new Proxy(copyInput(valid.input), {
				ownKeys: (): ArrayLike<string | symbol> => {
					throw new Error("SEAM1_PROXY_OWNKEYS");
				},
			}),
		]);
		malformed.push([
			"proxy-descriptor",
			new Proxy(copyInput(valid.input), {
				getOwnPropertyDescriptor: (): PropertyDescriptor | undefined => {
					throw new Error("SEAM1_PROXY_DESCRIPTOR");
				},
			}),
		]);
		malformed.push([
			"proxy-prototype",
			new Proxy(copyInput(valid.input), {
				getPrototypeOf: (): object | null => {
					throw new Error("SEAM1_PROXY_PROTOTYPE");
				},
			}),
		]);

		for (const [label, input] of malformed) {
			resetCalls();
			let result: ExtractResult | undefined;
			expect(() => {
				result = extract(input as AdmitInput);
			}, label).not.toThrow();
			if (result === undefined) throw new TypeError(`SEAM1_MALFORMED_RESULT_MISSING:${label}`);
			expectFrozenFailure(result, "malformed-input", label);
			expect(calls, label).toMatchObject({ decode: 0, encode: 0, hash: 0, resolver: 0, verify: 0 });
		}
		expect(getterCalls).toBe(0);
	});

	it("captures numeric property-key conversion before valid extractor projection without changing the old facade", async () => {
		const admit = await admitFunction();
		const extract = await extractFunction();
		const valid = await validCase();
		const stringDescriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
		if (stringDescriptor === undefined) throw new TypeError("SEAM1_GLOBAL_STRING_DESCRIPTOR_MISSING");
		const originalString = String;
		let numericStringCalls = 0;
		let oldResult: AdmissionDecision | undefined;
		let oldDigestIdentity: Uint8Array | undefined;
		let oldCounts: ProtocolCallCounts | undefined;
		let extracted: ExtractResult | undefined;
		let extractCounts: ProtocolCallCounts | undefined;
		try {
			Object.defineProperty(globalThis, "String", {
				...stringDescriptor,
				value: ((value?: unknown): string => {
					if (typeof value === "number") {
						numericStringCalls++;
						throw new Error("SEAM1_POISON_NUMERIC_STRING");
					}
					return Reflect.apply(originalString, undefined, [value]);
				}) as unknown as StringConstructor,
			});

			resetCalls();
			oldResult = admit(valid.input);
			oldDigestIdentity = calls.lastVertexDigest;
			oldCounts = protocolCallCounts();
			resetCalls();
			extracted = extract(valid.input);
			extractCounts = protocolCallCounts();
		} finally {
			Object.defineProperty(globalThis, "String", stringDescriptor);
		}

		expect(oldResult).toEqual({ admitted: true, digest: valid.remote.digest });
		expect(oldResult?.digest).toBe(oldDigestIdentity);
		expect(oldCounts).toEqual(ONE_PROTOCOL_PASS);
		expect.soft(extracted?.ok).toBe(true);
		expect.soft(extractCounts).toEqual(ONE_PROTOCOL_PASS);
		expect.soft(numericStringCalls).toBe(0);
	});

	it("captures byte-key membership so copies and shared-backing rejection survive Set.has poison", async () => {
		const admit = await admitFunction();
		const extract = await extractFunction();
		const valid = await validCase();
		const material = keyMaterial();
		const mutatingInput = copyInput(valid.input, {
			resolveAuthorPublicKey(this: AdmitInput, author: string): RawPublicKey | undefined {
				calls.resolver++;
				this.receivedCanonicalPreimageBytes[0] ^= 0xff;
				this.signature[0] ^= 0xff;
				return author === admissionContract.vertex.author ? { bytes: material.publicKey, format: "raw" } : undefined;
			},
		});
		const originalPreimageByte = mutatingInput.receivedCanonicalPreimageBytes[0];
		const originalSignatureByte = mutatingInput.signature[0];
		const sharedPreimage = new Uint8Array(new SharedArrayBuffer(valid.remote.bytes.byteLength));
		sharedPreimage.set(valid.remote.bytes);
		const sharedSignature = new Uint8Array(new SharedArrayBuffer(64));
		sharedSignature.set(valid.remote.signature);
		const sharedPreimageInput = copyInput(valid.input, { receivedCanonicalPreimageBytes: sharedPreimage });
		const sharedSignatureInput = copyInput(valid.input, { signature: sharedSignature });
		const originalSetHas = Set.prototype.has;
		let byteKeyDispatches = 0;
		let oldResult: AdmissionDecision | undefined;
		let oldDigestIdentity: Uint8Array | undefined;
		let copiedResult: ExtractResult | undefined;
		let copiedCounts: ProtocolCallCounts | undefined;
		let copiedDecodeInput: Uint8Array | undefined;
		let copiedHashInput: Uint8Array | undefined;
		let sharedPreimageResult: ExtractResult | undefined;
		let sharedPreimageCounts: ProtocolCallCounts | undefined;
		let sharedSignatureResult: ExtractResult | undefined;
		let sharedSignatureCounts: ProtocolCallCounts | undefined;
		try {
			Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
				const isByteKeySet =
					this.size === 2 &&
					Reflect.apply(originalSetHas, this, ["receivedCanonicalPreimageBytes"]) &&
					Reflect.apply(originalSetHas, this, ["signature"]);
				if (isByteKeySet && (value === "receivedCanonicalPreimageBytes" || value === "signature")) {
					byteKeyDispatches++;
					return false;
				}
				return Reflect.apply(originalSetHas, this, [value]);
			} as typeof Set.prototype.has;

			resetCalls();
			oldResult = admit(valid.input);
			oldDigestIdentity = calls.lastVertexDigest;
			resetCalls();
			copiedResult = extract(mutatingInput);
			copiedCounts = protocolCallCounts();
			copiedDecodeInput = calls.lastDecodeInput;
			copiedHashInput = calls.lastVertexHashInput;
			mutatingInput.receivedCanonicalPreimageBytes[0] = originalPreimageByte;
			mutatingInput.signature[0] = originalSignatureByte;
			resetCalls();
			sharedPreimageResult = extract(sharedPreimageInput);
			sharedPreimageCounts = protocolCallCounts();
			resetCalls();
			sharedSignatureResult = extract(sharedSignatureInput);
			sharedSignatureCounts = protocolCallCounts();
		} finally {
			Set.prototype.has = originalSetHas;
			mutatingInput.receivedCanonicalPreimageBytes[0] = originalPreimageByte;
			mutatingInput.signature[0] = originalSignatureByte;
		}

		expect(oldResult).toEqual({ admitted: true, digest: valid.remote.digest });
		expect(oldResult?.digest).toBe(oldDigestIdentity);
		expect.soft(copiedResult?.ok).toBe(true);
		expect.soft(copiedCounts).toEqual(ONE_PROTOCOL_PASS);
		expect.soft(copiedDecodeInput).toEqual(valid.remote.bytes);
		expect.soft(copiedDecodeInput).not.toBe(mutatingInput.receivedCanonicalPreimageBytes);
		expect.soft(copiedHashInput).toEqual(valid.remote.bytes);
		expect.soft(copiedHashInput).not.toBe(mutatingInput.receivedCanonicalPreimageBytes);
		if (sharedPreimageResult === undefined || sharedSignatureResult === undefined) {
			throw new TypeError("SEAM1_SHARED_BACKING_RESULT_MISSING");
		}
		expect.soft(sharedPreimageResult, "shared-preimage-poisoned-membership").toEqual({
			ok: false,
			reason: "malformed-input",
		});
		expect.soft(Reflect.ownKeys(sharedPreimageResult), "shared-preimage-poisoned-membership").toEqual(["ok", "reason"]);
		expect.soft(Object.isFrozen(sharedPreimageResult), "shared-preimage-poisoned-membership").toBe(true);
		expect.soft(sharedSignatureResult, "shared-signature-poisoned-membership").toEqual({
			ok: false,
			reason: "malformed-input",
		});
		expect
			.soft(Reflect.ownKeys(sharedSignatureResult), "shared-signature-poisoned-membership")
			.toEqual(["ok", "reason"]);
		expect.soft(Object.isFrozen(sharedSignatureResult), "shared-signature-poisoned-membership").toBe(true);
		expect.soft(sharedPreimageCounts).toEqual(ZERO_PROTOCOL_WORK);
		expect.soft(sharedSignatureCounts).toEqual(ZERO_PROTOCOL_WORK);
		expect.soft(byteKeyDispatches).toBe(0);
	});

	it("uses setter-proof snapshot writes and preserves fail-closed numeric-setter behavior", async () => {
		const admit = await admitFunction();
		const extract = await extractFunction();
		const valid = await validCase();
		const domainDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "domain");
		const numericDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "0");
		let namedSetterCalls = 0;
		let numericSetterCalls = 0;
		let namedOldResult: AdmissionDecision | undefined;
		let namedOldDigestIdentity: Uint8Array | undefined;
		let namedExtracted: ExtractResult | undefined;
		let namedExtractCounts: ProtocolCallCounts | undefined;
		try {
			Object.defineProperty(Object.prototype, "domain", {
				configurable: true,
				set: (): void => {
					namedSetterCalls++;
					throw new Error("SEAM1_POISON_NAMED_SETTER");
				},
			});

			resetCalls();
			namedOldResult = admit(valid.input);
			namedOldDigestIdentity = calls.lastVertexDigest;
			resetCalls();
			namedExtracted = extract(valid.input);
			namedExtractCounts = protocolCallCounts();
		} finally {
			if (domainDescriptor === undefined) Reflect.deleteProperty(Object.prototype, "domain");
			else Object.defineProperty(Object.prototype, "domain", domainDescriptor);
		}

		let numericOldResult: AdmissionDecision | undefined;
		let numericExtracted: ExtractResult | undefined;
		let numericExtractCounts: ProtocolCallCounts | undefined;
		try {
			Object.defineProperty(Object.prototype, "0", {
				configurable: true,
				set: (): void => {
					numericSetterCalls++;
					throw new Error("SEAM1_POISON_NUMERIC_SETTER");
				},
			});
			resetCalls();
			numericOldResult = admit(valid.input);
			resetCalls();
			numericExtracted = extract(valid.input);
			numericExtractCounts = protocolCallCounts();
		} finally {
			if (numericDescriptor === undefined) Reflect.deleteProperty(Object.prototype, "0");
			else Object.defineProperty(Object.prototype, "0", numericDescriptor);
		}

		expect(namedOldResult).toEqual({ admitted: true, digest: valid.remote.digest });
		expect(namedOldResult?.digest).toBe(namedOldDigestIdentity);
		expect.soft(namedExtracted?.ok).toBe(true);
		expect.soft(namedExtractCounts).toEqual(ONE_PROTOCOL_PASS);
		expect.soft(namedSetterCalls).toBe(0);
		expect(numericOldResult).toEqual({ admitted: false });
		if (numericExtracted === undefined) throw new TypeError("SEAM1_NUMERIC_SETTER_RESULT_MISSING");
		expectFrozenFailure(numericExtracted, "not-authenticated", "numeric-setter-poison");
		expect(numericExtractCounts).toMatchObject({ resolver: 0, verify: 0 });
		expect(numericSetterCalls).toBeGreaterThan(0);
	});

	it("keeps authentication and admission failure classes distinct with exact precedence", async () => {
		const extract = await extractFunction();
		const valid = await validCase(admissionContract.validOperation);
		const badSignature = new Uint8Array(valid.input.signature);
		badSignature[0] ^= 0xff;
		const badBytes = new Uint8Array([...valid.input.receivedCanonicalPreimageBytes, 0]);
		for (const [label, input] of [
			["domain", copyInput(valid.input, { domain: "wrong" })],
			["suite", copyInput(valid.input, { suiteId: "wrong" })],
			["malformed-anchor", copyInput(valid.input, { expectedAnchor: "wrong" })],
			["anchor-mismatch", copyInput(valid.input, { expectedAnchor: "02".repeat(32) })],
			["canonical", copyInput(valid.input, { receivedCanonicalPreimageBytes: badBytes })],
			["signature", copyInput(valid.input, { signature: badSignature })],
			["unresolved-author", copyInput(valid.input, { resolveAuthorPublicKey: () => undefined })],
			[
				"malformed-author-key",
				copyInput(valid.input, {
					resolveAuthorPublicKey: () => ({ bytes: new Uint8Array(31), format: "raw" }),
				}),
			],
			[
				"throwing-resolver",
				copyInput(valid.input, {
					resolveAuthorPublicKey: () => {
						throw new Error("SEAM1_RESOLVER_THROW");
					},
				}),
			],
		] as const) {
			resetCalls();
			expectFrozenFailure(extract(input), "not-authenticated", label);
		}

		const forgedAdmission = Object.create(Object.getPrototypeOf(valid.admission)) as object;
		Object.defineProperties(forgedAdmission, Object.getOwnPropertyDescriptors(valid.admission as object));
		resetCalls();
		expectFrozenFailure(
			extract(copyInput(valid.input, { preparedBlueprintAdmission: forgedAdmission })),
			"admission-rejected"
		);
		expect(calls).toMatchObject({ decode: 1, hash: 1, resolver: 1, verify: 1 });

		const unknown = await validCase({ action: "not-declared" });
		expectFrozenFailure(extract(unknown.input), "admission-rejected");
		const crossPackageAdmission = await preparedAdmission(16_384, "different-operation");
		resetCalls();
		expectFrozenFailure(
			extract(copyInput(valid.input, { preparedBlueprintAdmission: crossPackageAdmission })),
			"admission-rejected"
		);

		const overBudgetOperation = { action: "append", value: "x".repeat(300) };
		const overBudget = await validCase(overBudgetOperation, 100);
		expectFrozenFailure(extract(overBudget.input), "admission-rejected");

		const multifault = {
			...copyInput(valid.input, { domain: "wrong", preparedBlueprintAdmission: forgedAdmission }),
			extra: 1,
		};
		expectFrozenFailure(extract(multifault as unknown as AdmitInput), "malformed-input");
		expectFrozenFailure(
			extract(copyInput(valid.input, { domain: "wrong", preparedBlueprintAdmission: forgedAdmission })),
			"not-authenticated"
		);
	});

	it("uses module-captured intrinsics and preserves resolver original-input binding", async () => {
		const extract = await extractFunction();
		const valid = await validCase();
		const originals = {
			arrayIterator: Array.prototype[Symbol.iterator],
			defineProperty: Object.defineProperty,
			freeze: Object.freeze,
			getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			getPrototypeOf: Object.getPrototypeOf,
			mapIterator: Map.prototype[Symbol.iterator],
			ownKeys: Reflect.ownKeys,
			mapEntries: Map.prototype.entries,
			setIterator: Set.prototype[Symbol.iterator],
			setValues: Set.prototype.values,
			typedArraySet: Uint8Array.prototype.set,
			float32Set: Float32Array.prototype.set,
			float64Set: Float64Array.prototype.set,
			int32Set: Int32Array.prototype.set,
			uint32Set: Uint32Array.prototype.set,
		};
		const numericDescriptor = originals.getOwnPropertyDescriptor(Array.prototype, "0");
		let inheritedNumericSets = 0;
		let projectionPoisonInstalled = false;
		calls.afterEncode = (): void => {
			if (projectionPoisonInstalled) return;
			projectionPoisonInstalled = true;
			originals.defineProperty(Array.prototype, "0", {
				configurable: true,
				set: (): void => {
					inheritedNumericSets++;
				},
			});
			Array.prototype[Symbol.iterator] = (() => {
				throw new Error("SEAM1_POISON_ARRAY_ITERATOR");
			}) as (typeof Array.prototype)[typeof Symbol.iterator];
			Object.defineProperty = (() => {
				throw new Error("SEAM1_POISON_DEFINE");
			}) as typeof Object.defineProperty;
			Object.freeze = (() => {
				throw new Error("SEAM1_POISON_FREEZE");
			}) as typeof Object.freeze;
			Object.getOwnPropertyDescriptor = (() => {
				throw new Error("SEAM1_POISON_DESCRIPTOR");
			}) as typeof Object.getOwnPropertyDescriptor;
			Object.getPrototypeOf = (() => {
				throw new Error("SEAM1_POISON_PROTOTYPE");
			}) as typeof Object.getPrototypeOf;
			Reflect.ownKeys = (() => {
				throw new Error("SEAM1_POISON_KEYS");
			}) as typeof Reflect.ownKeys;
			Map.prototype[Symbol.iterator] = (() => {
				throw new Error("SEAM1_POISON_MAP_ITERATOR");
			}) as (typeof Map.prototype)[typeof Symbol.iterator];
			Map.prototype.entries = (() => {
				throw new Error("SEAM1_POISON_MAP");
			}) as typeof Map.prototype.entries;
			Set.prototype[Symbol.iterator] = (() => {
				throw new Error("SEAM1_POISON_SET_ITERATOR");
			}) as (typeof Set.prototype)[typeof Symbol.iterator];
			Set.prototype.values = (() => {
				throw new Error("SEAM1_POISON_SET");
			}) as typeof Set.prototype.values;
			Uint8Array.prototype.set = (() => {
				throw new Error("SEAM1_POISON_TYPED_SET");
			}) as typeof Uint8Array.prototype.set;
			Float32Array.prototype.set = (() => {
				throw new Error("SEAM1_POISON_FLOAT32_SET");
			}) as typeof Float32Array.prototype.set;
			Float64Array.prototype.set = (() => {
				throw new Error("SEAM1_POISON_FLOAT64_SET");
			}) as typeof Float64Array.prototype.set;
			Int32Array.prototype.set = (() => {
				throw new Error("SEAM1_POISON_INT32_SET");
			}) as typeof Int32Array.prototype.set;
			Uint32Array.prototype.set = (() => {
				throw new Error("SEAM1_POISON_UINT32_SET");
			}) as typeof Uint32Array.prototype.set;
		};
		let result: ExtractResult;
		try {
			result = extract(valid.input);
		} finally {
			if (numericDescriptor === undefined) delete Array.prototype[0];
			else originals.defineProperty(Array.prototype, "0", numericDescriptor);
			Array.prototype[Symbol.iterator] = originals.arrayIterator;
			Object.defineProperty = originals.defineProperty;
			Object.freeze = originals.freeze;
			Object.getOwnPropertyDescriptor = originals.getOwnPropertyDescriptor;
			Object.getPrototypeOf = originals.getPrototypeOf;
			Reflect.ownKeys = originals.ownKeys;
			Map.prototype[Symbol.iterator] = originals.mapIterator;
			Map.prototype.entries = originals.mapEntries;
			Set.prototype[Symbol.iterator] = originals.setIterator;
			Set.prototype.values = originals.setValues;
			Uint8Array.prototype.set = originals.typedArraySet;
			Float32Array.prototype.set = originals.float32Set;
			Float64Array.prototype.set = originals.float64Set;
			Int32Array.prototype.set = originals.int32Set;
			Uint32Array.prototype.set = originals.uint32Set;
		}
		expect(result.ok).toBe(true);
		expect(projectionPoisonInstalled).toBe(true);
		expect(calls.resolver).toBe(1);
		expect(inheritedNumericSets).toBe(0);

		resetCalls();
		const material = keyMaterial();
		const mutatingInput = copyInput(valid.input, {
			resolveAuthorPublicKey(this: AdmitInput, author: string): RawPublicKey | undefined {
				calls.resolver++;
				this.receivedCanonicalPreimageBytes[0] ^= 0xff;
				this.signature[0] ^= 0xff;
				return author === admissionContract.vertex.author ? { bytes: material.publicKey, format: "raw" } : undefined;
			},
		});
		expect(extract(mutatingInput).ok).toBe(true);
		expect(calls).toMatchObject({ decode: 1, encode: 1, hash: 1, resolver: 1, verify: 1 });
	});

	it("binds both facades to one private decision owner", () => {
		const source = readFileSync(INDEX_ENTRY, "utf8");
		expect(auditDecisionOwnership(source)).toEqual([]);
	});

	it("causally kills duplicate, aliased and facade-routed authority mutants", () => {
		const pinOwnerControl = ts.createSourceFile(
			"pin-owner-control.ts",
			`const EXPECTED_RUNTIME_EXPORTS = ${JSON.stringify(EXPECTED_RUNTIME_EXPORTS)} as const;
			 function unrelatedFilter() { return ["admitReceivedVertex", "prepareBlueprintAdmission", "prepareBlueprintRuntime"]; }`,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		expect(namedVariableStringArray(pinOwnerControl, "EXPECTED_RUNTIME_EXPORTS")).toEqual(EXPECTED_RUNTIME_EXPORTS);
		expect(
			namedVariableStringArray(
				ts.createSourceFile(
					"pin-owner-mutant.ts",
					pinOwnerControl.text.replace('"extractAdmittedReceivedVertex",', ""),
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS
				),
				"EXPECTED_RUNTIME_EXPORTS"
			)
		).not.toEqual(EXPECTED_RUNTIME_EXPORTS);
		const publicRootControl = ts.createSourceFile(
			"public-root-control.ts",
			`it("[public-root]", () => {
				const sourceRuntime = {};
				const unrelatedRuntime = {};
				expect(Object.keys(unrelatedRuntime).sort()).toEqual(${JSON.stringify(EXPECTED_RUNTIME_EXPORTS)});
				expect(Object.keys(sourceRuntime).sort()).toEqual(${JSON.stringify(EXPECTED_RUNTIME_EXPORTS)});
			});`,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		expect(
			namedPublicSurfaceTestArray(publicRootControl, "[public-root]", {
				kind: "identifier",
				name: "sourceRuntime",
			})
		).toEqual(EXPECTED_RUNTIME_EXPORTS);
		expect(() =>
			namedPublicSurfaceTestArray(
				ts.createSourceFile(
					"public-root-mutant.ts",
					publicRootControl.text.replace("Object.keys(sourceRuntime)", "Object.keys(unrelatedRuntime)"),
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS
				),
				"[public-root]",
				{ kind: "identifier", name: "sourceRuntime" }
			)
		).toThrow();

		const good = `
			function authenticateReceivedVertex(input) {
				decodeCanonical(); digestReceivedVertexPreimage(); input.resolveAuthorPublicKey(); verifyEd25519RegisteredDigest();
			}
			function consumerPreparedAdmissionState() {}
			function operationSchemaForPreparedAdmission() {}
			function operationWithinCanonicalByteBudget() { encodeCanonical(); }
			function decideReceivedVertex(input) {
				authenticateReceivedVertex(input); consumerPreparedAdmissionState();
				operationSchemaForPreparedAdmission(); operationWithinCanonicalByteBudget();
			}
			export function admitReceivedVertex(input) { return decideReceivedVertex(input); }
			export function extractAdmittedReceivedVertex(input) { return decideReceivedVertex(input); }
		`;
		expect(auditDecisionOwnership(good)).toEqual([]);
		for (const [label, mutant] of [
			[
				"second-decode",
				good.replace(
					"return decideReceivedVertex(input); }\n\t\t",
					"decodeCanonical(); return decideReceivedVertex(input); }\n\t\t"
				),
			],
			[
				"second-hash",
				good.replace(
					"return decideReceivedVertex(input); }\n\t\t",
					"digestReceivedVertexPreimage(); return decideReceivedVertex(input); }\n\t\t"
				),
			],
			[
				"second-encode",
				good.replace(
					"return decideReceivedVertex(input); }\n\t\t",
					"encodeCanonical(); return decideReceivedVertex(input); }\n\t\t"
				),
			],
			[
				"second-verify",
				good.replace(
					"return decideReceivedVertex(input); }\n\t\t",
					"verifyEd25519RegisteredDigest(); return decideReceivedVertex(input); }\n\t\t"
				),
			],
			[
				"second-resolver",
				good.replace(
					"return decideReceivedVertex(input); }\n\t\t",
					"input.resolveAuthorPublicKey(); return decideReceivedVertex(input); }\n\t\t"
				),
			],
			[
				"extract-through-admit",
				good.replace(
					"export function extractAdmittedReceivedVertex(input) { return decideReceivedVertex(input); }",
					"export function extractAdmittedReceivedVertex(input) { admitReceivedVertex(input); return decideReceivedVertex(input); }"
				),
			],
			[
				"double-admission",
				good.replace(
					"consumerPreparedAdmissionState();",
					"consumerPreparedAdmissionState(); consumerPreparedAdmissionState();"
				),
			],
			[
				"aliased-second-authentication",
				good.replace(
					"authenticateReceivedVertex(input); consumerPreparedAdmissionState();",
					"const authenticateAgain = authenticateReceivedVertex; authenticateReceivedVertex(input); authenticateAgain(input); consumerPreparedAdmissionState();"
				),
			],
			[
				"double-budget",
				good.replace(
					"operationWithinCanonicalByteBudget();",
					"operationWithinCanonicalByteBudget(); operationWithinCanonicalByteBudget();"
				),
			],
			[
				"exported-core",
				good.replace("function decideReceivedVertex(input)", "export function decideReceivedVertex(input)"),
			],
		] as const) {
			expect(auditDecisionOwnership(mutant), label).not.toEqual([]);
		}
	});

	it("adds no subpath, dependency, legacy mapping, capability or live-effect owner", () => {
		expect(protocolV3Package.exports).toEqual({
			".": { types: "./dist/src/public.d.ts", import: "./dist/src/public.js" },
			"./author-authorization": {
				types: "./dist/src/author-authorization.d.ts",
				import: "./dist/src/author-authorization.js",
			},
			"./registry/registry-v1.json": "./registry/registry-v1.json",
		});
		expect(protocolV3Package.dependencies).toEqual({
			"@noble/curves": "2.2.0",
			"@ts-drp/canonical": "0.11.0",
			"es-module-lexer": "1.6.0",
		});
		const source = readFileSync(INDEX_ENTRY, "utf8");
		for (const forbidden of [
			"@ts-drp/node",
			"@ts-drp/object",
			"@ts-drp/types",
			"PreparedV3Live",
			"Vertex_Operation",
			"applyVertices",
			"authenticateIncomingVertices",
		]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
