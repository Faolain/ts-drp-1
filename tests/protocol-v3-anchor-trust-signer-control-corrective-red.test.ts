import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
	bytesHex,
	contract,
	type CreatorMaterial,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
	makeTrustStateRecord,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	authenticateCurrentEpochAnchor,
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	openCurrentAnchorTrust,
} from "../packages/protocol-v3/src/public.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const PROTOCOL_V3_SOURCE_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/index.ts");
const UTF16_HELPER_NAME = "isWellFormedUtf16Text";
const UTF16_HELPER_CALLERS = ["isAnchorRecord", "isSignerId", "isStorageObjectIdText"] as const;
const CONTROL_SIGNER_IDS = [
	["C0", "creator\u0000suffix"],
	["DEL", "creator\u007fsuffix"],
	["C1", "creator\u0085suffix"],
] as const;
const TERMINAL_HIGH_SURROGATE = "creator\ud800";
const VALID_PAIRED_SURROGATE = "creator😀";

type Utf16Predicate = (value: string) => boolean;

interface Utf16HelperEvidence {
	readonly callers: readonly string[];
	readonly mutant: Utf16Predicate;
	readonly production: Utf16Predicate;
}

function installInput(material: CreatorMaterial): InstallCreatorAnchorTrustRootInput {
	return {
		detachedGenesisSignature: new Uint8Array(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isFalseReturn(statement: ts.Statement): boolean {
	return ts.isReturnStatement(statement) && statement.expression?.kind === ts.SyntaxKind.FalseKeyword;
}

function isTerminalEndBoundGuard(statement: ts.Statement): statement is ts.IfStatement {
	if (
		!ts.isIfStatement(statement) ||
		statement.elseStatement !== undefined ||
		!isFalseReturn(statement.thenStatement)
	) {
		return false;
	}
	const condition = statement.expression;
	if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken) {
		return false;
	}
	const left = condition.left;
	const right = condition.right;
	return (
		ts.isBinaryExpression(left) &&
		left.operatorToken.kind === ts.SyntaxKind.PlusToken &&
		ts.isIdentifier(left.left) &&
		left.left.text === "index" &&
		ts.isNumericLiteral(left.right) &&
		left.right.text === "1" &&
		ts.isPropertyAccessExpression(right) &&
		ts.isIdentifier(right.expression) &&
		right.expression.text === "value" &&
		right.name.text === "length"
	);
}

function enclosingFunctionName(node: ts.Node): string | undefined {
	for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
		if (ts.isFunctionDeclaration(current)) return current.name?.text;
	}
	return undefined;
}

function compileIsolatedPredicate(source: string, label: string): Utf16Predicate {
	const transpiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
		fileName: `${label}.ts`,
		reportDiagnostics: true,
	});
	const errors = (transpiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error);
	invariant(errors.length === 0, `${label}:TRANSPILE_ERRORS:${errors.length}`);
	const evaluated = runInNewContext(
		`"use strict";\n${transpiled.outputText}\n${UTF16_HELPER_NAME};`,
		Object.create(null) as object,
		{ contextCodeGeneration: { strings: false, wasm: false }, timeout: 1_000 }
	) as unknown;
	invariant(typeof evaluated === "function", `${label}:PREDICATE_NOT_FUNCTION`);
	return evaluated as Utf16Predicate;
}

function extractUtf16HelperEvidence(): Utf16HelperEvidence {
	const sourceText = readFileSync(PROTOCOL_V3_SOURCE_PATH, "utf8");
	const sourceFile = ts.createSourceFile(
		PROTOCOL_V3_SOURCE_PATH,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const helpers = sourceFile.statements.filter(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === UTF16_HELPER_NAME
	);
	invariant(helpers.length === 1, `EXPECTED_ONE_PRIVATE_UTF16_HELPER:${helpers.length}`);
	const helper = helpers[0] as ts.FunctionDeclaration;
	invariant(
		helper.modifiers?.every(
			({ kind }) => kind !== ts.SyntaxKind.ExportKeyword && kind !== ts.SyntaxKind.DefaultKeyword
		) ?? true,
		"UTF16_HELPER_MUST_BE_PRIVATE"
	);
	invariant(helper.body !== undefined, "UTF16_HELPER_BODY_MISSING");
	invariant(helper.parameters.length === 1, `UTF16_HELPER_PARAMETER_COUNT:${helper.parameters.length}`);
	const parameter = helper.parameters[0] as ts.ParameterDeclaration;
	invariant(ts.isIdentifier(parameter.name) && parameter.name.text === "value", "UTF16_HELPER_PARAMETER_NAME");
	invariant(parameter.type?.kind === ts.SyntaxKind.StringKeyword, "UTF16_HELPER_PARAMETER_TYPE");
	invariant(helper.type?.kind === ts.SyntaxKind.BooleanKeyword, "UTF16_HELPER_RETURN_TYPE");
	invariant(helper.asteriskToken === undefined, "UTF16_HELPER_MUST_NOT_BE_GENERATOR");

	const declaredIdentifiers = new Set([UTF16_HELPER_NAME, "value"]);
	const identifierReferences: ts.Identifier[] = [];
	const calls: ts.CallExpression[] = [];
	const guards: ts.IfStatement[] = [];
	const propertyAccesses: ts.PropertyAccessExpression[] = [];
	let forbiddenAmbientSyntax: ts.Node | undefined;
	const visitHelper = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declaredIdentifiers.add(node.name.text);
		if (ts.isIdentifier(node)) identifierReferences.push(node);
		if (ts.isCallExpression(node)) calls.push(node);
		if (ts.isPropertyAccessExpression(node)) propertyAccesses.push(node);
		if (ts.isIfStatement(node) && isTerminalEndBoundGuard(node)) guards.push(node);
		if (
			node !== helper &&
			(ts.isFunctionLike(node) ||
				ts.isElementAccessExpression(node) ||
				ts.isNewExpression(node) ||
				node.kind === ts.SyntaxKind.ThisKeyword ||
				node.kind === ts.SyntaxKind.ImportKeyword ||
				ts.isAwaitExpression(node) ||
				ts.isYieldExpression(node))
		) {
			forbiddenAmbientSyntax = node;
		}
		ts.forEachChild(node, visitHelper);
	};
	visitHelper(helper);
	invariant(forbiddenAmbientSyntax === undefined, `UTF16_HELPER_AMBIENT_SYNTAX:${forbiddenAmbientSyntax?.kind}`);

	for (const reference of identifierReferences) {
		const isDeclaration =
			(ts.isFunctionDeclaration(reference.parent) && reference.parent.name === reference) ||
			(ts.isParameter(reference.parent) && reference.parent.name === reference) ||
			(ts.isVariableDeclaration(reference.parent) && reference.parent.name === reference);
		const isPropertyName = ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference;
		if (!isDeclaration && !isPropertyName) {
			invariant(declaredIdentifiers.has(reference.text), `UTF16_HELPER_FREE_IDENTIFIER:${reference.text}`);
		}
	}
	for (const call of calls) {
		invariant(ts.isPropertyAccessExpression(call.expression), "UTF16_HELPER_AMBIENT_CALL");
		invariant(ts.isIdentifier(call.expression.expression), "UTF16_HELPER_AMBIENT_RECEIVER");
		invariant(call.expression.expression.text === "value", "UTF16_HELPER_NON_INPUT_RECEIVER");
		invariant(call.expression.name.text === "charCodeAt", "UTF16_HELPER_UNEXPECTED_METHOD");
		invariant(call.arguments.length === 1, `UTF16_HELPER_CALL_ARGUMENTS:${call.arguments.length}`);
	}
	for (const access of propertyAccesses) {
		invariant(
			ts.isIdentifier(access.expression) && access.expression.text === "value",
			"UTF16_HELPER_PROPERTY_RECEIVER"
		);
		invariant(
			access.name.text === "charCodeAt" || access.name.text === "length",
			`UTF16_HELPER_UNEXPECTED_PROPERTY:${access.name.text}`
		);
	}
	invariant(guards.length === 1, `EXPECTED_ONE_TERMINAL_END_BOUND_GUARD:${guards.length}`);

	const helperReferences: ts.Identifier[] = [];
	const helperCalls: ts.CallExpression[] = [];
	const visitSource = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === UTF16_HELPER_NAME) helperReferences.push(node);
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === UTF16_HELPER_NAME) {
			helperCalls.push(node);
		}
		ts.forEachChild(node, visitSource);
	};
	visitSource(sourceFile);
	invariant(helperReferences.length === helperCalls.length + 1, "UTF16_HELPER_NON_CALL_REFERENCE");
	const callers = helperCalls.map((call) => enclosingFunctionName(call));
	invariant(
		callers.every((name): name is string => name !== undefined),
		"UTF16_HELPER_TOP_LEVEL_CALL"
	);
	callers.sort();
	invariant(
		JSON.stringify(callers) === JSON.stringify(UTF16_HELPER_CALLERS),
		`UTF16_HELPER_CALLERS:${callers.join(",")}`
	);

	const helperStart = helper.getStart(sourceFile);
	const helperSource = sourceText.slice(helperStart, helper.end);
	const guard = guards[0] as ts.IfStatement;
	const guardStart = guard.getStart(sourceFile) - helperStart;
	const guardEnd = guard.end - helperStart;
	const mutantSource = helperSource.slice(0, guardStart) + helperSource.slice(guardEnd);
	invariant(
		mutantSource.length === helperSource.length - (guardEnd - guardStart),
		"MUTANT_MUST_REMOVE_ONLY_TERMINAL_GUARD"
	);
	return {
		callers,
		mutant: compileIsolatedPredicate(mutantSource, "missing-terminal-end-bound-mutant"),
		production: compileIsolatedPredicate(helperSource, "production-utf16-helper"),
	};
}

function replaceTerminalAsciiWithHighSurrogateBytes(bytes: Uint8Array): Uint8Array {
	const encoded = new TextEncoder().encode("creatorX");
	const needle = Uint8Array.of(0x05, encoded.byteLength, ...encoded);
	const replacement = Uint8Array.of(0x05, 10, ...encoded.subarray(0, -1), 0xed, 0xa0, 0x80);
	const matches: number[] = [];
	for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset++) {
		if (needle.every((byte, index) => bytes[offset + index] === byte)) matches.push(offset);
	}
	if (matches.length !== 1) throw new Error(`EXPECTED_ONE_SIGNER_ID_MATCH:${matches.length}`);
	const offset = matches[0] as number;
	return new Uint8Array([...bytes.subarray(0, offset), ...replacement, ...bytes.subarray(offset + needle.byteLength)]);
}

function containsFatalUtf8LoneHighEncoding(bytes: Uint8Array): boolean {
	return bytes.some((byte, index) => byte === 0xed && bytes[index + 1] === 0xa0 && bytes[index + 2] === 0x80);
}

function makeFatalUtf8CarrierMaterial(): CreatorMaterial {
	const base = makeCreatorMaterial();
	const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
	const encodedSigner = { ...baseSigner, signerId: "creatorX" };
	const encodedMaterial = makeCreatorMaterial({ profileSigners: [encodedSigner], signerSet: [encodedSigner] });
	const signerSetBytes = replaceTerminalAsciiWithHighSurrogateBytes(encodedMaterial.signerSetBytes);
	const profileBytes = replaceTerminalAsciiWithHighSurrogateBytes(encodedMaterial.profileBytes);
	const anchor = {
		...encodedMaterial.anchor,
		profileDigest: bytesHex(independentHashDomain(contract.profileDigestDomain, profileBytes)),
		signerSetDigest: bytesHex(independentHashDomain(contract.signerSetDigestDomain, signerSetBytes)),
	};
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
	return {
		...encodedMaterial,
		anchor,
		anchorBytes,
		anchorDigest,
		profile: encodedMaterial.profile,
		profileBytes,
		signature: ed25519.sign(hexBytes(anchorDigest), hexBytes(contract.privateKeySeedHex)),
		signerSet: encodedMaterial.signerSet,
		signerSetBytes,
	};
}

function expectClosedFailure(result: unknown, reason: string): void {
	expect.soft(result).toEqual({ ok: false, reason });
	expect.soft(Object.isFrozen(result)).toBe(true);
	expect.soft(result).not.toHaveProperty("trust");
	expect.soft(result).not.toHaveProperty("exactCanonicalTrustStateRecordBytes");
	expect.soft(result).not.toHaveProperty("provenance");
}

describe("Phase 3a-0-A signer-control corrective causal evidence", () => {
	it("[registry-control] binds and executes the actual private UTF-16 helper and its exact old guard mutant", () => {
		const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
			kinds: {
				signerSet: {
					fields: readonly {
						constraints: Readonly<Record<string, unknown>>;
						name: string;
					}[];
				};
			};
		};
		const signerConstraints = registry.kinds.signerSet.fields.find(({ name }) => name === "signers")?.constraints;
		expect(signerConstraints).toEqual({
			maxSignerIdUtf16Units: 512,
			signerIdCharset: "unicode-scalar-excluding-controls",
			uniqueBy: "signerId",
		});
		const evidence = extractUtf16HelperEvidence();
		expect(evidence.callers).toEqual(UTF16_HELPER_CALLERS);
		const cases = [
			["empty", "", true],
			["ascii", "creator", true],
			["terminal high", "creator\ud800", false],
			["lone low", "creator\udc00", false],
			["high followed by non-low", "creator\ud800x", false],
			["paired units", "creator\ud83d\ude00", true],
			["non-BMP emoji", "😀", true],
			["C0/DEL/C1 scalars", "\u0000\u007f\u0085", true],
		] as const;
		for (const [caseName, value, expected] of cases) {
			expect(evidence.production(value), caseName).toBe(expected);
		}
		expect(evidence.mutant(TERMINAL_HIGH_SURROGATE)).toBe(true);
		expect(evidence.mutant(VALID_PAIRED_SURROGATE)).toBe(true);
	});

	it("rejects fatal UTF-8 ED A0 80 carrier bytes with existing taxonomy and no authority", () => {
		const material = makeFatalUtf8CarrierMaterial();
		expect(containsFatalUtf8LoneHighEncoding(material.signerSetBytes)).toBe(true);
		expect(containsFatalUtf8LoneHighEncoding(material.profileBytes)).toBe(true);
		expect(material.anchor.signerSetDigest).toBe(
			bytesHex(independentHashDomain(contract.signerSetDigestDomain, material.signerSetBytes))
		);
		expect(material.anchor.profileDigest).toBe(
			bytesHex(independentHashDomain(contract.profileDigestDomain, material.profileBytes))
		);
		expect(
			ed25519.verify(material.signature, hexBytes(material.anchorDigest), hexBytes(contract.publicKeyHex), {
				zip215: false,
			})
		).toBe(true);

		const install = installInput(material);
		const installSnapshots = Object.values(install)
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.map((bytes) => new Uint8Array(bytes));
		expectClosedFailure(installCreatorAnchorTrustRoot(install), "signer-set-profile-mismatch");
		Object.values(install)
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.forEach((bytes, index) => expect.soft(bytes).toEqual(installSnapshots[index]));

		const recordBytes = makeTrustStateRecord(material);
		const recordSnapshot = new Uint8Array(recordBytes);
		expectClosedFailure(
			openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: recordBytes,
				expectedObjectId: contract.objectId,
				pinnedGenesisAnchorDigest: material.anchorDigest,
			}),
			"trust-state-inconsistent"
		);
		expect(recordBytes).toEqual(recordSnapshot);
	});

	it("accepts a paired non-BMP signer identity through install, open and authenticate", () => {
		const base = makeCreatorMaterial();
		const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
		const signer = { ...baseSigner, signerId: VALID_PAIRED_SURROGATE };
		const material = makeCreatorMaterial({ profileSigners: [signer], signerSet: [signer] });
		const installed = installCreatorAnchorTrustRoot(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const opened = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
			expectedObjectId: contract.objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(
			authenticateCurrentEpochAnchor({
				detachedSignature: material.signature,
				exactCanonicalAnchorPreimageBytes: material.anchorBytes,
				trust: opened.trust,
			})
		).toMatchObject({
			ok: true,
			provenance: { anchorDigest: material.anchorDigest, objectId: contract.objectId },
		});
	});

	it("accepts 512 UTF-16 signer units and rejects 513 without minting authority", () => {
		const base = makeCreatorMaterial();
		const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
		const maximumSigner = { ...baseSigner, signerId: "a".repeat(512) };
		const maximumMaterial = makeCreatorMaterial({
			profileSigners: [maximumSigner],
			signerSet: [maximumSigner],
		});
		const installed = installCreatorAnchorTrustRoot(installInput(maximumMaterial));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const opened = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
			expectedObjectId: contract.objectId,
			pinnedGenesisAnchorDigest: maximumMaterial.anchorDigest,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(
			authenticateCurrentEpochAnchor({
				detachedSignature: maximumMaterial.signature,
				exactCanonicalAnchorPreimageBytes: maximumMaterial.anchorBytes,
				trust: opened.trust,
			})
		).toMatchObject({ ok: true, provenance: { anchorDigest: maximumMaterial.anchorDigest } });

		const oversizedSigner = { ...baseSigner, signerId: "a".repeat(513) };
		const oversizedMaterial = makeCreatorMaterial({
			profileSigners: [oversizedSigner],
			signerSet: [oversizedSigner],
		});
		expectClosedFailure(installCreatorAnchorTrustRoot(installInput(oversizedMaterial)), "signer-set-profile-mismatch");
	});

	it.each(CONTROL_SIGNER_IDS)(
		"[%s] rejects self-consistent signed control-bearing carriers before capability minting",
		(_controlClass, signerId) => {
			const base = makeCreatorMaterial();
			const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
			const signer = { ...baseSigner, signerId };
			const material = makeCreatorMaterial({ profileSigners: [signer], signerSet: [signer] });
			const signerPublicKey = hexBytes(String(signer.publicKey));
			expect(material.profile).toMatchObject({ quorum: 1, signers: material.signerSet });
			expect(material.anchor.signerSetDigest).toBe(
				bytesHex(independentHashDomain(contract.signerSetDigestDomain, material.signerSetBytes))
			);
			expect(material.anchor.profileDigest).toBe(
				bytesHex(independentHashDomain(contract.profileDigestDomain, material.profileBytes))
			);
			expect(
				ed25519.verify(material.signature, hexBytes(material.anchorDigest), signerPublicKey, { zip215: false })
			).toBe(true);

			const input = installInput(material);
			const inputSnapshots = Object.values(input)
				.filter((value): value is Uint8Array => value instanceof Uint8Array)
				.map((bytes) => new Uint8Array(bytes));
			const installResult = installCreatorAnchorTrustRoot(input);
			expectClosedFailure(installResult, "signer-set-profile-mismatch");
			Object.values(input)
				.filter((value): value is Uint8Array => value instanceof Uint8Array)
				.forEach((bytes, index) => expect.soft(bytes).toEqual(inputSnapshots[index]));
			expectClosedFailure(
				installCreatorAnchorTrustRoot({ ...installInput(material), pinnedGenesisAnchorDigest: "f".repeat(64) }),
				"genesis-pin-mismatch"
			);
			expectClosedFailure(
				installCreatorAnchorTrustRoot({ ...installInput(material), detachedGenesisSignature: new Uint8Array(64) }),
				"signer-set-profile-mismatch"
			);

			const recordBytes = makeTrustStateRecord(material);
			const recordSnapshot = new Uint8Array(recordBytes);
			expectClosedFailure(
				openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: recordBytes,
					expectedObjectId: contract.objectId,
					pinnedGenesisAnchorDigest: material.anchorDigest,
				}),
				"trust-state-inconsistent"
			);
			expect.soft(recordBytes).toEqual(recordSnapshot);
			expectClosedFailure(
				openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: recordBytes,
					expectedObjectId: contract.objectId,
					pinnedGenesisAnchorDigest: "f".repeat(64),
				}),
				"genesis-pin-mismatch"
			);
		}
	);
});
