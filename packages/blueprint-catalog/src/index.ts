import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { DRPError, type DRPErrorCode } from "@ts-drp/errors";
import { prepareBlueprintAdmission } from "@ts-drp/protocol-v3";
import * as moduleLexer from "es-module-lexer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HEX = /^[0-9a-f]{64}$/u;
const ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"] as const;
const CONTROL_NAMES = [
	"ambientBad",
	"thenable",
	"intrinsicMutation",
	"moduleGlobalDrift",
	"noncanonicalIntermediate",
	"sparseIntermediate",
] as const;

type CatalogCode = Extract<DRPErrorCode, `BLUEPRINT_${string}`>;
type PlainRecord = Record<string, unknown>;

interface CatalogEntry {
	readonly blueprintDigest: string;
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly runtimeProfile: string;
	readonly lintEvidenceDigest: string;
	readonly conformanceReceiptDigest: string;
}

interface StoredEntry extends CatalogEntry {
	readonly packageBytes: Uint8Array;
	readonly artifactBytes: Uint8Array;
	readonly conformanceDigest: string;
	readonly engines: readonly { readonly name: (typeof ENGINE_NAMES)[number]; readonly build: string }[];
}

export interface TrustedBlueprintCatalogOptions {
	readonly catalogDirectory: string;
}

export interface ResolvedBlueprintBytes {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly evidence: {
		readonly catalogDigest: string;
		readonly lintEvidenceDigest: string;
		readonly conformanceReceiptDigest: string;
		readonly conformanceDigest: string;
		readonly conformanceTier: "nightly";
		readonly conformanceResult: "passed";
		readonly engines: readonly {
			readonly name: "node" | "chromium" | "firefox" | "webkit";
			readonly build: string;
		}[];
	};
}

export interface TrustedBlueprintCatalog {
	readonly blueprintDigests: readonly string[];
	readonly catalogDigest: string;
	resolve(blueprintDigest: string): ResolvedBlueprintBytes;
}

/** A closed, machine-classifiable catalog failure. */
export class BlueprintCatalogError extends DRPError {
	/**
	 * Creates a catalog failure.
	 * @param code - Stable catalog error code.
	 * @param message - Path-free diagnostic message.
	 */
	constructor(code: CatalogCode, message = "trusted blueprint catalog rejected") {
		super(code, message);
		this.name = "BlueprintCatalogError";
	}
}

try {
	moduleLexer.initSync();
} catch {
	throw new BlueprintCatalogError("BLUEPRINT_ARTIFACT_BYTES_INVALID", "artifact lexer initialization failed");
}

function fail(code: CatalogCode, message: string): never {
	throw new BlueprintCatalogError(code, message);
}

function isRecord(value: unknown): value is PlainRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: CatalogCode, label: string): PlainRecord {
	if (!isRecord(value)) fail(code, `${label} must be a plain record`);
	const actual = Reflect.ownKeys(value);
	if (
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		keys.some((key) => !Object.hasOwn(value, key))
	) {
		fail(code, `${label} has an invalid schema`);
	}
	return value;
}

function digest(value: unknown, code: CatalogCode, label: string): string {
	if (typeof value !== "string" || !HEX.test(value)) fail(code, `${label} must be lowercase digest hex`);
	return value;
}

function text(value: unknown, code: CatalogCode, label: string): string {
	if (typeof value !== "string" || value.length === 0) fail(code, `${label} must be a nonempty string`);
	return value;
}

function artifactId(value: unknown, code: CatalogCode): string {
	const candidate = text(value, code, "artifactId");
	if (
		Buffer.byteLength(candidate, "ascii") > 128 ||
		!/^[\x21-\x7e]+$/u.test(candidate) ||
		candidate.includes("\\") ||
		candidate === "." ||
		candidate === ".." ||
		candidate.includes("../") ||
		candidate.includes("/..")
	) {
		fail(code, "artifactId is invalid");
	}
	return candidate;
}

function printableAscii(value: unknown, code: CatalogCode, label: string, maximumBytes: number): string {
	const candidate = text(value, code, label);
	if (Buffer.byteLength(candidate, "ascii") > maximumBytes || !/^[\x20-\x7e]+$/u.test(candidate)) {
		fail(code, `${label} must be bounded printable ASCII`);
	}
	return candidate;
}

function integer(value: unknown, code: CatalogCode, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail(code, `${label} must be a nonnegative safe integer`);
	}
	return value;
}

function bytesHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return bytesHex(hashDomain(domain, bytes));
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return compareBytes(left, right) === 0;
}

function decodeExact(bytes: Uint8Array, noncanonical: CatalogCode, schema: CatalogCode): unknown {
	let value: unknown;
	try {
		value = decodeCanonical(bytes);
	} catch {
		fail(noncanonical, "canonical bytes could not be decoded");
	}
	try {
		if (!equalBytes(encodeCanonical(value), bytes)) fail(noncanonical, "canonical bytes were not exact");
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail(schema, "decoded canonical value could not be re-encoded");
	}
	return value;
}

function validateCatalog(value: unknown): readonly CatalogEntry[] {
	const catalog = exactRecord(
		value,
		["schemaVersion", "kind", "entries"],
		"BLUEPRINT_CATALOG_SCHEMA_INVALID",
		"catalog"
	);
	if (catalog.schemaVersion !== 1 || catalog.kind !== "ts-drp-trusted-blueprint-catalog") {
		fail("BLUEPRINT_CATALOG_SCHEMA_INVALID", "catalog literals are invalid");
	}
	if (!Array.isArray(catalog.entries)) fail("BLUEPRINT_CATALOG_SCHEMA_INVALID", "catalog entries must be an array");
	const entries = catalog.entries.map((candidate, index): CatalogEntry => {
		const entry = exactRecord(
			candidate,
			[
				"blueprintDigest",
				"artifactDigest",
				"artifactId",
				"runtimeProfile",
				"lintEvidenceDigest",
				"conformanceReceiptDigest",
			],
			"BLUEPRINT_CATALOG_SCHEMA_INVALID",
			`catalog entry ${index}`
		);
		return {
			blueprintDigest: digest(entry.blueprintDigest, "BLUEPRINT_CATALOG_SCHEMA_INVALID", "blueprintDigest"),
			artifactDigest: digest(entry.artifactDigest, "BLUEPRINT_CATALOG_SCHEMA_INVALID", "artifactDigest"),
			artifactId: artifactId(entry.artifactId, "BLUEPRINT_CATALOG_SCHEMA_INVALID"),
			runtimeProfile: text(entry.runtimeProfile, "BLUEPRINT_CATALOG_SCHEMA_INVALID", "runtimeProfile"),
			lintEvidenceDigest: digest(entry.lintEvidenceDigest, "BLUEPRINT_CATALOG_SCHEMA_INVALID", "lintEvidenceDigest"),
			conformanceReceiptDigest: digest(
				entry.conformanceReceiptDigest,
				"BLUEPRINT_CATALOG_SCHEMA_INVALID",
				"conformanceReceiptDigest"
			),
		};
	});
	for (let index = 1; index < entries.length; index++) {
		if ((entries[index - 1]?.blueprintDigest ?? "") >= (entries[index]?.blueprintDigest ?? "")) {
			fail("BLUEPRINT_CATALOG_ORDER_INVALID", "catalog entries are not in strict digest order");
		}
	}
	for (const field of ["artifactDigest", "artifactId"] as const) {
		if (new Set(entries.map((entry) => entry[field])).size !== entries.length) {
			fail("BLUEPRINT_CATALOG_DUPLICATE_IDENTITY", `catalog contains a duplicate ${field}`);
		}
	}
	return entries;
}

function validatePackage(value: unknown): {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly runtimeProfile: string;
} {
	const packageValue = exactRecord(
		value,
		["kind", "protocolMajor", "schemaVersion", "implementation", "manifest"],
		"BLUEPRINT_PACKAGE_SCHEMA_INVALID",
		"package"
	);
	if (
		packageValue.kind !== "drp-blueprint-admission-package" ||
		packageValue.protocolMajor !== 3 ||
		packageValue.schemaVersion !== 1
	) {
		fail("BLUEPRINT_PACKAGE_SCHEMA_INVALID", "package literals are invalid");
	}
	const implementation = exactRecord(
		packageValue.implementation,
		["artifactId", "artifactDigest", "runtimeProfile"],
		"BLUEPRINT_PACKAGE_SCHEMA_INVALID",
		"package implementation"
	);
	if (!isRecord(packageValue.manifest)) fail("BLUEPRINT_PACKAGE_SCHEMA_INVALID", "package manifest is invalid");
	return {
		artifactId: artifactId(implementation.artifactId, "BLUEPRINT_PACKAGE_SCHEMA_INVALID"),
		artifactDigest: digest(implementation.artifactDigest, "BLUEPRINT_PACKAGE_SCHEMA_INVALID", "artifactDigest"),
		runtimeProfile: text(implementation.runtimeProfile, "BLUEPRINT_PACKAGE_SCHEMA_INVALID", "runtimeProfile"),
	};
}

function validateArtifact(bytes: Uint8Array): {
	readonly artifactId: string | undefined;
	readonly runtimeProfile: string | undefined;
} {
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		fail("BLUEPRINT_ARTIFACT_BYTES_INVALID", "artifact is not UTF-8");
	}
	if (source.charCodeAt(0) === 0xfeff || source.includes("\r") || !source.endsWith("\n")) {
		fail("BLUEPRINT_ARTIFACT_BYTES_INVALID", "artifact text framing is invalid");
	}
	let imports: readonly unknown[];
	let exports: readonly { readonly n?: string }[];
	try {
		[imports, exports] = moduleLexer.parse(source) as unknown as [
			readonly unknown[],
			readonly { readonly n?: string }[],
		];
	} catch {
		fail("BLUEPRINT_ARTIFACT_BYTES_INVALID", "artifact is not valid ESM");
	}
	if (imports.length !== 0 || exports.length !== 1 || exports[0]?.n !== "blueprint") {
		fail("BLUEPRINT_ARTIFACT_BYTES_INVALID", "artifact must have zero imports and sole blueprint export");
	}
	const epilogue = source.slice(source.lastIndexOf("\nexport const blueprint = {\n") + 1);
	const match =
		/^export const blueprint = \{\n {2}exportSchemaVersion: 1,\n {2}artifactId: ("(?:[^"\\]|\\.)*"),\n {2}runtimeProfile: ("(?:[^"\\]|\\.)*"),\n/u.exec(
			epilogue
		);
	let embeddedArtifactId: unknown;
	let embeddedRuntimeProfile: unknown;
	try {
		embeddedArtifactId = match === null ? undefined : JSON.parse(match[1] as string);
		embeddedRuntimeProfile = match === null ? undefined : JSON.parse(match[2] as string);
	} catch {
		embeddedArtifactId = undefined;
		embeddedRuntimeProfile = undefined;
	}
	return {
		artifactId: typeof embeddedArtifactId === "string" ? embeddedArtifactId : undefined,
		runtimeProfile: typeof embeddedRuntimeProfile === "string" ? embeddedRuntimeProfile : undefined,
	};
}

function validateLint(value: unknown, artifactDigest: string, artifactSha256: string): void {
	const code = "BLUEPRINT_LINT_EVIDENCE_INVALID" as const;
	const lint = exactRecord(
		value,
		[
			"schemaVersion",
			"kind",
			"artifactDigest",
			"artifactSha256",
			"sourceSha256",
			"authoringSha256",
			"ruleId",
			"rulePackage",
			"ruleSourceSha256",
			"lintContractSha256",
			"eslintVersion",
			"parserVersion",
			"targets",
			"result",
		],
		code,
		"lint evidence"
	);
	if (
		lint.schemaVersion !== 1 ||
		lint.kind !== "ts-drp-blueprint-lint-evidence" ||
		lint.ruleId !== "drp/no-ambient-in-reducer" ||
		lint.rulePackage !== "eslint-plugin-ts-drp" ||
		lint.result !== "clean"
	) {
		fail(code, "lint evidence literals are invalid");
	}
	for (const key of [
		"artifactDigest",
		"artifactSha256",
		"sourceSha256",
		"authoringSha256",
		"ruleSourceSha256",
		"lintContractSha256",
	] as const) {
		digest(lint[key], code, key);
	}
	text(lint.eslintVersion, code, "eslintVersion");
	text(lint.parserVersion, code, "parserVersion");
	if (!Array.isArray(lint.targets) || lint.targets.length !== 2) fail(code, "lint targets are invalid");
	const expectedKinds = ["artifact", "source"];
	for (let index = 0; index < lint.targets.length; index++) {
		const target = exactRecord(lint.targets[index], ["kind", "sha256", "diagnosticCount"], code, "lint target");
		if (target.kind !== expectedKinds[index] || target.diagnosticCount !== 0) fail(code, "lint target is invalid");
		digest(target.sha256, code, "lint target sha256");
	}
	const artifactTarget = lint.targets[0] as PlainRecord;
	const sourceTarget = lint.targets[1] as PlainRecord;
	if (
		lint.artifactDigest !== artifactDigest ||
		lint.artifactSha256 !== artifactSha256 ||
		artifactTarget.sha256 !== artifactSha256 ||
		sourceTarget.sha256 !== lint.sourceSha256
	) {
		fail("BLUEPRINT_LINT_EVIDENCE_UNBOUND", "lint evidence is not bound to the artifact");
	}
}

function validateAccounting(value: unknown): { readonly pr: PlainRecord; readonly nightly: PlainRecord } {
	const code = "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID" as const;
	const accounting = exactRecord(value, ["pr", "nightly"], code, "corpus accounting");
	for (const tier of ["pr", "nightly"] as const) {
		const item = exactRecord(accounting[tier], ["total", "selected", "dropped"], code, `${tier} accounting`);
		for (const key of ["total", "selected", "dropped"] as const) integer(item[key], code, `${tier}.${key}`);
		if ((item.selected as number) + (item.dropped as number) !== item.total) {
			fail(code, `${tier} accounting does not balance`);
		}
	}
	return accounting as { readonly pr: PlainRecord; readonly nightly: PlainRecord };
}

function validateControls(digests: unknown, outcomes: unknown): void {
	const code = "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID" as const;
	const digestRecord = exactRecord(digests, CONTROL_NAMES, code, "control artifact digests");
	for (const name of CONTROL_NAMES) digest(digestRecord[name], code, `${name} digest`);
	const outcomeRecord = exactRecord(outcomes, CONTROL_NAMES, code, "control outcomes");
	const shapes: Readonly<Record<(typeof CONTROL_NAMES)[number], readonly string[]>> = {
		ambientBad: ["lintRejected", "crossEngineDigestDisagreement"],
		thenable: ["executed", "rejected"],
		intrinsicMutation: ["detected"],
		moduleGlobalDrift: ["detected"],
		noncanonicalIntermediate: ["executed", "rejected"],
		sparseIntermediate: ["executed", "rejected"],
	};
	for (const name of CONTROL_NAMES) {
		const outcome = exactRecord(outcomeRecord[name], shapes[name], code, `${name} outcome`);
		if (shapes[name].some((key) => outcome[key] !== true)) fail(code, `${name} outcome is invalid`);
	}
}

function validateReceipt(
	value: unknown,
	entry: CatalogEntry,
	packageInfo: ReturnType<typeof validatePackage>,
	receiptEvidenceDigest: string
): {
	readonly conformanceDigest: string;
	readonly engines: StoredEntry["engines"];
} {
	const code = "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID" as const;
	const receipt = exactRecord(
		value,
		[
			"schemaVersion",
			"kind",
			"artifactId",
			"runtimeProfile",
			"blueprintDigest",
			"artifactDigest",
			"lintEvidenceDigest",
			"corpusDigest",
			"executionTier",
			"result",
			"conformanceDigest",
			"corpusVersion",
			"seed",
			"operationOrder",
			"selectedCaseIds",
			"corpusAccounting",
			"engines",
			"controlArtifactDigests",
			"controlOutcomes",
			"runnerSha256",
		],
		code,
		"conformance receipt"
	);
	if (receipt.schemaVersion !== 1 || receipt.kind !== "ts-drp-blueprint-conformance-receipt") {
		fail(code, "receipt literals are invalid");
	}
	for (const key of [
		"blueprintDigest",
		"artifactDigest",
		"lintEvidenceDigest",
		"corpusDigest",
		"conformanceDigest",
		"runnerSha256",
	] as const)
		digest(receipt[key], code, key);
	for (const key of ["artifactId", "runtimeProfile", "corpusVersion", "seed"] as const) {
		if (key === "artifactId") artifactId(receipt[key], code);
		else text(receipt[key], code, key);
	}
	if (receipt.executionTier !== "pr" && receipt.executionTier !== "nightly") {
		fail(code, "receipt execution tier is invalid");
	}
	text(receipt.result, code, "result");
	for (const key of ["operationOrder", "selectedCaseIds"] as const) {
		if (!Array.isArray(receipt[key]) || receipt[key].some((item) => typeof item !== "string" || item.length === 0)) {
			fail(code, `${key} is invalid`);
		}
	}
	if (
		new Set(receipt.selectedCaseIds as readonly string[]).size !== (receipt.selectedCaseIds as readonly string[]).length
	) {
		fail(code, "selected case ids are not unique");
	}
	const accounting = validateAccounting(receipt.corpusAccounting);
	const selectedAccounting = receipt.executionTier === "pr" ? accounting.pr : accounting.nightly;
	if (
		selectedAccounting.selected !== (receipt.selectedCaseIds as readonly string[]).length ||
		selectedAccounting.selected !== (receipt.operationOrder as readonly string[]).length ||
		typeof accounting.pr.selected !== "number" ||
		accounting.pr.selected >= (accounting.nightly.selected as number)
	) {
		fail(code, "receipt corpus accounting is inconsistent");
	}
	validateControls(receipt.controlArtifactDigests, receipt.controlOutcomes);
	if (!Array.isArray(receipt.engines)) fail(code, "receipt engines must be an array");
	const parsedEngines = receipt.engines.map((candidate): { readonly name: string; readonly build: string } => {
		const engine = exactRecord(candidate, ["name", "build", "conformanceDigest"], code, "receipt engine");
		const name = text(engine.name, code, "engine name");
		const build = printableAscii(engine.build, code, "engine build", 512);
		digest(engine.conformanceDigest, code, "engine conformanceDigest");
		return { name, build };
	});
	if (receiptEvidenceDigest !== entry.conformanceReceiptDigest) {
		fail("BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND", "receipt digest does not match catalog");
	}
	for (const candidate of receipt.engines) {
		if ((candidate as PlainRecord).conformanceDigest !== receipt.conformanceDigest) {
			fail("BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND", "engine digest is not bound to receipt");
		}
	}
	if (
		receipt.artifactId !== entry.artifactId ||
		receipt.artifactId !== packageInfo.artifactId ||
		receipt.runtimeProfile !== entry.runtimeProfile ||
		receipt.blueprintDigest !== entry.blueprintDigest ||
		receipt.artifactDigest !== entry.artifactDigest ||
		receipt.lintEvidenceDigest !== entry.lintEvidenceDigest
	) {
		fail("BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND", "receipt is not bound to its catalog entry");
	}
	if (receipt.executionTier !== "nightly") {
		fail("BLUEPRINT_CONFORMANCE_TIER_INSUFFICIENT", "catalog requires nightly evidence");
	}
	if (
		parsedEngines.length !== ENGINE_NAMES.length ||
		parsedEngines.some((engine, index) => engine.name !== ENGINE_NAMES[index])
	) {
		fail("BLUEPRINT_CONFORMANCE_ENGINE_MATRIX_INCOMPLETE", "receipt engine matrix is incomplete");
	}
	if (receipt.result !== "passed") {
		fail("BLUEPRINT_CONFORMANCE_RESULT_NOT_PASSED", "conformance result was not passed");
	}
	return {
		conformanceDigest: receipt.conformanceDigest as string,
		engines: parsedEngines as StoredEntry["engines"],
	};
}

function safeRead(root: string, filename: string, code: CatalogCode): Uint8Array {
	try {
		const before = fs.lstatSync(filename);
		if (!before.isFile() || before.isSymbolicLink() || before.size === 0)
			fail(code, "catalog asset is not a regular file");
		const real = fs.realpathSync(filename);
		if (path.dirname(real) !== root) fail(code, "catalog asset escapes its directory");
		const bytes = fs.readFileSync(filename);
		const after = fs.lstatSync(filename);
		if (
			!after.isFile() ||
			after.isSymbolicLink() ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			bytes.length !== before.size
		) {
			fail(code, "catalog asset changed while being read");
		}
		return new Uint8Array(bytes);
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail(code, "catalog asset is unreadable");
	}
}

function openDirectory(options: TrustedBlueprintCatalogOptions): string {
	try {
		if (!isRecord(options) || typeof options.catalogDirectory !== "string") {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		const supplied = options.catalogDirectory;
		if (supplied.length === 0 || !path.isAbsolute(supplied)) {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		const stat = fs.lstatSync(supplied);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
		}
		return fs.realpathSync(supplied);
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail("BLUEPRINT_CATALOG_DIRECTORY_INVALID", "catalog directory is invalid");
	}
}

function resolveValue(stored: StoredEntry, catalogDigest: string): ResolvedBlueprintBytes {
	const engines = Object.freeze(stored.engines.map((engine) => Object.freeze({ ...engine })));
	const evidence = Object.freeze({
		catalogDigest,
		lintEvidenceDigest: stored.lintEvidenceDigest,
		conformanceReceiptDigest: stored.conformanceReceiptDigest,
		conformanceDigest: stored.conformanceDigest,
		conformanceTier: "nightly" as const,
		conformanceResult: "passed" as const,
		engines,
	});
	return Object.freeze({
		artifactDigest: stored.artifactDigest,
		artifactId: stored.artifactId,
		blueprintDigest: stored.blueprintDigest,
		runtimeProfile: "ecmascript-2024-sync-v1" as const,
		canonicalBlueprintPackageBytes: Buffer.from(stored.packageBytes),
		exactArtifactBytes: Buffer.from(stored.artifactBytes),
		evidence,
	});
}

/**
 * Opens and validates a trusted local blueprint catalog synchronously.
 * @param options - The caller-supplied absolute catalog directory.
 * @returns A frozen, zero-I/O resolver over copied catalog bytes.
 */
export function openTrustedBlueprintCatalog(options: TrustedBlueprintCatalogOptions): TrustedBlueprintCatalog {
	try {
		const root = openDirectory(options);
		const catalogBytes = safeRead(root, path.join(root, "catalog.bin"), "BLUEPRINT_CATALOG_FILE_UNREADABLE");
		const catalogValue = decodeExact(
			catalogBytes,
			"BLUEPRINT_CATALOG_BYTES_NONCANONICAL",
			"BLUEPRINT_CATALOG_SCHEMA_INVALID"
		);
		const entries = validateCatalog(catalogValue);
		const catalogDigest = domainHex("ts-drp/blueprint-catalog/v1", catalogBytes);
		const stored = new Map<string, StoredEntry>();
		for (const entry of entries) {
			const prefix = path.join(root, entry.blueprintDigest);
			const artifactBytes = safeRead(root, `${prefix}.artifact.mjs`, "BLUEPRINT_ENTRY_FILE_UNREADABLE");
			const packageBytes = safeRead(root, `${prefix}.package.bin`, "BLUEPRINT_ENTRY_FILE_UNREADABLE");
			const lintBytes = safeRead(root, `${prefix}.lint.bin`, "BLUEPRINT_ENTRY_FILE_UNREADABLE");
			const receiptBytes = safeRead(root, `${prefix}.receipt.bin`, "BLUEPRINT_ENTRY_FILE_UNREADABLE");

			const packageValue = decodeExact(
				packageBytes,
				"BLUEPRINT_PACKAGE_BYTES_NONCANONICAL",
				"BLUEPRINT_PACKAGE_SCHEMA_INVALID"
			);
			const actualBlueprintDigest = domainHex("ts-drp/blueprint-admission/v3", packageBytes);
			if (actualBlueprintDigest !== entry.blueprintDigest) {
				fail("BLUEPRINT_PACKAGE_DIGEST_MISMATCH", "package digest does not match catalog entry");
			}
			const packageInfo = validatePackage(packageValue);
			try {
				prepareBlueprintAdmission({
					canonicalBlueprintPackageBytes: Buffer.from(packageBytes),
					expectedBlueprintDigest: entry.blueprintDigest,
				});
			} catch {
				fail("BLUEPRINT_PACKAGE_SCHEMA_INVALID", "package admission validation failed");
			}

			const embeddedArtifact = validateArtifact(artifactBytes);
			const actualArtifactDigest = domainHex("ts-drp/blueprint-artifact/v3", artifactBytes);
			if (actualArtifactDigest !== packageInfo.artifactDigest || actualArtifactDigest !== entry.artifactDigest) {
				fail("BLUEPRINT_ARTIFACT_DIGEST_MISMATCH", "artifact digest does not match package and catalog");
			}
			if (embeddedArtifact.artifactId !== packageInfo.artifactId || embeddedArtifact.artifactId !== entry.artifactId) {
				fail("BLUEPRINT_ARTIFACT_PACKAGE_CROSS_PAIR", "artifact identity does not match package and catalog");
			}
			if (
				packageInfo.runtimeProfile !== "ecmascript-2024-sync-v1" ||
				entry.runtimeProfile !== "ecmascript-2024-sync-v1" ||
				embeddedArtifact.runtimeProfile !== "ecmascript-2024-sync-v1"
			) {
				fail("BLUEPRINT_RUNTIME_PROFILE_UNSUPPORTED", "blueprint runtime profile is unsupported");
			}

			const lintValue = decodeExact(lintBytes, "BLUEPRINT_LINT_EVIDENCE_INVALID", "BLUEPRINT_LINT_EVIDENCE_INVALID");
			validateLint(lintValue, actualArtifactDigest, sha256Hex(artifactBytes));
			if (domainHex("ts-drp/blueprint-lint-evidence/v1", lintBytes) !== entry.lintEvidenceDigest) {
				fail("BLUEPRINT_LINT_EVIDENCE_UNBOUND", "lint evidence digest does not match catalog");
			}

			const receiptValue = decodeExact(
				receiptBytes,
				"BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
				"BLUEPRINT_CONFORMANCE_RECEIPT_INVALID"
			);
			const receipt = validateReceipt(
				receiptValue,
				entry,
				packageInfo,
				domainHex("ts-drp/blueprint-conformance-receipt/v1", receiptBytes)
			);
			stored.set(entry.blueprintDigest, {
				...entry,
				packageBytes: new Uint8Array(packageBytes),
				artifactBytes: new Uint8Array(artifactBytes),
				conformanceDigest: receipt.conformanceDigest,
				engines: Object.freeze(receipt.engines.map((engine) => Object.freeze({ ...engine }))),
			});
		}
		const blueprintDigests = Object.freeze(entries.map((entry) => entry.blueprintDigest));
		return Object.freeze({
			blueprintDigests,
			catalogDigest,
			resolve(blueprintDigest: string): ResolvedBlueprintBytes {
				if (typeof blueprintDigest !== "string" || !HEX.test(blueprintDigest)) {
					fail("BLUEPRINT_REQUEST_MALFORMED", "blueprint digest request is malformed");
				}
				const entry = stored.get(blueprintDigest);
				if (entry === undefined) fail("BLUEPRINT_NOT_CATALOGUED", "blueprint digest is not catalogued");
				return resolveValue(entry, catalogDigest);
			},
		});
	} catch (error) {
		if (error instanceof BlueprintCatalogError) throw error;
		fail("BLUEPRINT_CATALOG_SCHEMA_INVALID", "catalog validation failed");
	}
}
