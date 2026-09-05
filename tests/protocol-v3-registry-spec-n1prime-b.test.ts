import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-b/registry-spec-contract.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const frozenArrayFieldTypes = new Set([
	"array<canonical-value>",
	"array<digest-hex>",
	"array<signed-seal-vote>",
	"array<signer>",
	"array<{index,digest,byteLength}>",
	"array<{signerId:string,publicKey:string}>",
]);
const frozenRegistryFieldTypes = [
	...frozenArrayFieldTypes,
	"bytes",
	"canonical-object",
	"canonical-safe-integer",
	"canonical-string",
	"canonical-value",
	"digest-hex",
	"enum",
	"parameters",
	"safe-integer",
	"seal-qc|null",
	"string",
].sort();

interface RegistryField {
	const: unknown;
	constraints: {
		initial?: number;
		maximum?: number;
		minimum?: number;
		overflow?: string;
		reset?: string;
		values?: unknown[];
	} & Record<string, unknown>;
	name: string;
	required: boolean;
	type: string;
}

interface SignedEnvelopeMetadata {
	classification: "signed" | "unsigned";
	suiteRole: string | null;
}

interface RegistryKind {
	domain: string;
	encoding: string;
	fields: RegistryField[];
	signedEnvelope?: SignedEnvelopeMetadata;
}

interface CryptoSuite {
	domainKinds: string[];
	role: string;
	suiteId: string;
}

interface PredecessorSuiteAudit {
	disposition: string;
	predecessorSuiteId: string;
	role: string;
	successorSuiteId: string;
}

interface DecisionBinding {
	decisionId: string;
	decisionType: string;
	registryPaths: string[];
}

interface WireFormat {
	canonicalPreimage: string;
	digestVerification: string;
	reencodeBeforeDigest: boolean;
	signature: string;
}

interface Registry {
	canonicalObjectKeyOrder: string;
	cryptoSuites: {
		active: CryptoSuite[];
		predecessorAudit: PredecessorSuiteAudit[];
	};
	decisionBindings: DecisionBinding[];
	kinds: Record<string, RegistryKind>;
	packageName: string;
	protocolMajor: number;
	registryVersion: number;
	wireFormat: WireFormat;
}

interface JsonSchemaProperty {
	"const"?: unknown;
	"contentEncoding"?: string;
	"contentMediaType"?: string;
	"enum"?: unknown[];
	"format"?: string;
	"maxItems"?: number;
	"maxLength"?: number;
	"maximum"?: number;
	"minItems"?: number;
	"minLength"?: number;
	"minimum"?: number;
	"pattern"?: string;
	"type"?: string | string[];
	"uniqueItems"?: boolean;
	"x-initial"?: number;
	"x-overflow"?: string;
	"x-registry-constraints"?: Record<string, unknown>;
	"x-registry-type"?: string;
	"x-reset"?: string;
}

interface KindSchema {
	"additionalProperties": boolean;
	"properties": Record<string, JsonSchemaProperty>;
	"required": string[];
	"type": string;
	"x-canonical-key-order": string;
}

interface RegistrySchema {
	$defs: Record<string, KindSchema>;
	$id: string;
	$schema: string;
}

interface SchemaTypeControl {
	field: RegistryField;
	name: string;
	schema: JsonSchemaProperty;
}

interface DecisionRecord {
	decision: number;
	decisionType: string;
	id: string;
	normativeSource?: string;
	registryPaths: string[];
	requirements: Record<string, unknown>;
	status?: string;
}

interface AmendmentLog {
	entries: DecisionRecord[];
	normativeDocument: string;
	protocolMajor: number;
	registryVersion: number;
	status: string;
}

interface FieldMapping {
	envelopeKind: string;
	field: string;
	modelVariable: string;
	registryPath: string;
}

interface RegistryModelSignoff {
	acceptedActionModel: Provenance;
	classification: {
		allRegistryKinds: string[];
		kindSuiteRoles?: Record<string, string | null>;
		mode: "explicit-scoped" | "registry-metadata";
		rationaleDecisionId: string;
		signedEnvelopeKinds: string[];
		unsignedEnvelopeKinds: string[];
	};
	fieldMappings: FieldMapping[];
	protocolMajor: number;
	reviewedArtifacts: Provenance[];
	schemaVersion: string;
	status: string;
}

interface Provenance {
	path: string;
	sha256: string;
}

interface SequenceCase {
	accepted: boolean;
	name: string;
	value?: number;
}

interface LineageTransition {
	accepted: boolean;
	after: LineageState;
	before: LineageState;
	candidate: number;
	name: string;
}

interface LineageState {
	anchor: string;
	epoch: number;
	next: number;
}

interface CrossMajorCase {
	accepted: boolean;
	candidateDomain: string;
	candidateMajor: number;
	candidateSuite: string;
	expectedDomain: string;
	expectedSuite: string;
	name: string;
	registryMajor: number;
}

interface QuintType {
	fields?: {
		fields: Array<{
			fieldName: string;
			fieldType: QuintType;
		}>;
		kind: string;
		other: {
			kind: string;
		};
	};
	kind: string;
}

interface QuintDeclaration {
	kind: string;
	name: string;
	type?: QuintType;
}

interface QuintModule {
	declarations: QuintDeclaration[];
	name: string;
}

interface QuintParseDocument {
	errors: unknown[];
	modules: QuintModule[];
	stage: string;
}

interface Contract {
	acceptedActionModel: {
		module: string;
		path: string;
		sha256: string;
		signedVertexType: string;
	};
	illustrativeControls: {
		crossMajorCases: CrossMajorCase[];
		decisionRecords: DecisionRecord[];
		formalVariableNames: string[];
		lineageTransitions: LineageTransition[];
		notice: string;
		registry: Registry;
		reviewedArtifactHashes: Record<string, string>;
		schema: RegistrySchema;
		schemaTypeControls: SchemaTypeControl[];
		sequenceCases: SequenceCase[];
		signoff: RegistryModelSignoff;
	};
	requiredDecisionTypes: string[];
	schemaVersion: string;
	targetArtifacts: {
		amendmentLog: string;
		formalVariables: string;
		registry: string;
		registryModelSignoff: string;
		schema: string;
		specification: string;
	};
}

interface V2Registry {
	domains: Record<string, string>;
	kinds: Record<string, RegistryKind>;
	packageName: string;
	protocolMajor: number;
	registryVersion: number;
	wireFormat: WireFormat;
}

interface V2AmendmentLog {
	entries: Array<{
		id: string;
		requirements: {
			activeSuites?: Record<string, string>;
		};
	}>;
}

interface V2VariableMap {
	signedEnvelopeKinds: string[];
}

const contract = contractDocument as unknown as Contract;
const artifactPaths = Object.values(contract.targetArtifacts);
const allGreenArtifactsExist = artifactPaths.every((path) => existsSync(absolutePath(path)));
const v2RegistryPath = "packages/protocol-v2/registry/field-registry.json";
const v2AmendmentLogPath = "docs/protocol/amendments-v2.json";
const v2VariableMapPath = "packages/protocol-v2/formal/ahe-v2-variable-map.json";

function absolutePath(path: string): string {
	return `${repositoryRoot}/${path}`;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(absolutePath(path), "utf8")) as T;
}

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(absolutePath(path)))
		.digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function semanticJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => semanticJson(item)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${semanticJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function parseQuint(path: string): QuintParseDocument {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-n1prime-b-quint-"));
	const parseOutputPath = join(temporaryDirectory, "parsed.json");

	try {
		const parsed = spawnSync("pnpm", ["exec", "quint", "parse", path, "--out", parseOutputPath], {
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		expect(parsed.status, `Quint must parse ${path} through --out\n${parsed.stdout}\n${parsed.stderr}`).toBe(0);
		expect(existsSync(parseOutputPath), "Quint 0.32 parse --out must create the requested AST artifact").toBe(true);
		const document = JSON.parse(readFileSync(parseOutputPath, "utf8")) as QuintParseDocument;
		expect(document.stage).toBe("parsing");
		expect(document.errors).toEqual([]);
		return document;
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

function parseAcceptedSignedVertexFields(): string[] {
	expect(
		sha256(contract.acceptedActionModel.path),
		"Phase -1 prime a accepted action model is an immutable input to registry derivation"
	).toBe(contract.acceptedActionModel.sha256);
	const document = parseQuint(contract.acceptedActionModel.path);
	const module = document.modules.find(({ name }) => name === contract.acceptedActionModel.module);
	expect(module, `missing accepted Quint module ${contract.acceptedActionModel.module}`).toBeDefined();
	const declarations =
		module?.declarations.filter(
			({ kind, name }) => kind === "typedef" && name === contract.acceptedActionModel.signedVertexType
		) ?? [];
	expect(declarations, "accepted model must declare exactly one closed SignedVertex").toHaveLength(1);
	expect(declarations[0]?.type).toMatchObject({
		kind: "rec",
		fields: {
			kind: "row",
			other: { kind: "empty" },
		},
	});
	const fields = declarations[0]?.type?.fields?.fields.map(({ fieldName }) => fieldName) ?? [];
	expect(new Set(fields).size, "accepted SignedVertex must not contain duplicate fields").toBe(fields.length);
	return fields;
}

function expectedJsonType(fieldType: string): string | string[] | undefined {
	if (fieldType === "safe-integer" || fieldType === "canonical-safe-integer") {
		return "integer";
	}
	if (
		fieldType === "string" ||
		fieldType === "canonical-string" ||
		fieldType === "digest-hex" ||
		fieldType === "enum"
	) {
		return "string";
	}
	if (fieldType === "canonical-object" || fieldType === "parameters") {
		return "object";
	}
	if (frozenArrayFieldTypes.has(fieldType)) {
		return "array";
	}
	if (fieldType === "seal-qc|null") {
		return ["object", "null"];
	}
	if (fieldType === "bytes" || fieldType === "canonical-value") {
		return undefined;
	}
	throw new Error(`unknown registry field type: ${fieldType}`);
}

function schemaTypesEqual(actual: string | string[] | undefined, expected: string | string[] | undefined): boolean {
	if (Array.isArray(actual) || Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			Array.isArray(expected) &&
			new Set(actual).size === actual.length &&
			new Set(expected).size === expected.length &&
			JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
		);
	}
	return actual === expected;
}

function fieldSchemaErrors(field: RegistryField, schema: JsonSchemaProperty, path: string): string[] {
	const errors: string[] = [];
	if (!schemaTypesEqual(schema.type, expectedJsonType(field.type))) {
		errors.push(`${path}: schema type does not match registry type ${field.type}`);
	}
	if (schema["x-registry-type"] !== field.type) {
		errors.push(`${path}: schema x-registry-type does not exactly preserve the native registry type`);
	}
	if (semanticJson(schema["x-registry-constraints"]) !== semanticJson(field.constraints)) {
		errors.push(`${path}: schema x-registry-constraints provenance differs from the registry`);
	}
	if (
		(field.type === "bytes" || field.type === "canonical-value") &&
		(schema.contentEncoding !== undefined ||
			schema.contentMediaType !== undefined ||
			schema.format !== undefined ||
			schema.pattern !== undefined)
	) {
		errors.push(`${path}: native bytes/canonical-value schema must not invent a JSON projection or encoding`);
	}
	if ((field.const === null && schema.const !== undefined) || (field.const !== null && schema.const !== field.const)) {
		errors.push(`${path}: schema const does not match registry const`);
	}
	const activeEnumValues = field.constraints.values;
	if (field.type === "enum") {
		if (!Array.isArray(activeEnumValues) || semanticJson(schema.enum) !== semanticJson(activeEnumValues)) {
			errors.push(`${path}: schema enum does not exactly match active registry constraint values`);
		}
	} else if (schema.enum !== undefined) {
		errors.push(`${path}: non-enum registry field is unexpectedly narrowed by schema enum`);
	}
	for (const constraint of ["minimum", "maximum"] as const) {
		const expected = field.constraints[constraint];
		if (schema[constraint] !== expected) {
			errors.push(`${path}: schema ${constraint} does not match registry`);
		}
	}
	return errors;
}

function validateRegistrySchemaBijection(registry: Registry, schema: RegistrySchema): string[] {
	const errors: string[] = [];
	if (
		schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
		!schema.$id.endsWith("/registry-v1.schema.json")
	) {
		errors.push("registry schema must have a stable draft-2020-12 v1 identity");
	}
	const kindNames = Object.keys(registry.kinds);
	if (JSON.stringify(Object.keys(schema.$defs)) !== JSON.stringify(kindNames)) {
		errors.push("schema kind definitions are not an exact registry-kind bijection");
	}

	for (const kindName of kindNames) {
		const kind = registry.kinds[kindName];
		const kindSchema = schema.$defs[kindName];
		if (kindSchema === undefined) {
			continue;
		}
		const fieldNames = kind.fields.map(({ name }) => name);
		if (new Set(fieldNames).size !== fieldNames.length) {
			errors.push(`${kindName}: duplicate registry field`);
		}
		if (JSON.stringify(Object.keys(kindSchema.properties)) !== JSON.stringify(fieldNames)) {
			errors.push(`${kindName}: schema properties are not in exact registry review order`);
		}
		const requiredFields = kind.fields.filter(({ required }) => required).map(({ name }) => name);
		if (JSON.stringify(kindSchema.required) !== JSON.stringify(requiredFields)) {
			errors.push(`${kindName}: schema required set does not match registry`);
		}
		if (kindSchema.additionalProperties !== false) {
			errors.push(`${kindName}: schema must reject unregistered fields`);
		}
		if (kindSchema["x-canonical-key-order"] !== "encoded-key-bytes") {
			errors.push(`${kindName}: schema must preserve encoded-key-byte canonical ordering`);
		}
		for (const field of kind.fields) {
			const fieldSchema = kindSchema.properties[field.name];
			if (fieldSchema === undefined) {
				continue;
			}
			errors.push(...fieldSchemaErrors(field, fieldSchema, `${kindName}.${field.name}`));
		}
	}
	return errors;
}

function validateVertexSurface(registry: Registry, schema: RegistrySchema, modelFields: string[]): string[] {
	const errors: string[] = [];
	const vertex = registry.kinds.vertex;
	if (vertex === undefined) {
		return ["registry is missing vertex kind"];
	}
	const fieldNames = vertex.fields.map(({ name }) => name);
	if (JSON.stringify(fieldNames) !== JSON.stringify(modelFields)) {
		errors.push("vertex review order is not the exact accepted SignedVertex AST field order");
	}
	const authorIndex = fieldNames.indexOf("author");
	if (fieldNames[authorIndex + 1] !== "authorSequence") {
		errors.push("authorSequence is not immediately after author");
	}
	const sequence = vertex.fields.find(({ name }) => name === "authorSequence");
	if (sequence === undefined) {
		return [...errors, "vertex is missing authorSequence"];
	}
	if (
		sequence.type !== "safe-integer" ||
		sequence.required !== true ||
		sequence.constraints.minimum !== 0 ||
		sequence.constraints.maximum !== maximumSafeInteger ||
		sequence.constraints.initial !== 0 ||
		sequence.constraints.reset !== "never" ||
		sequence.constraints.overflow !== "reject"
	) {
		errors.push("registry authorSequence contract is not safe-integer 0..MAX_SAFE, initial 0, no-reset/no-wrap");
	}
	const schemaSequence = schema.$defs.vertex?.properties.authorSequence;
	if (
		schemaSequence?.type !== "integer" ||
		schemaSequence.minimum !== 0 ||
		schemaSequence.maximum !== maximumSafeInteger ||
		schemaSequence["x-initial"] !== 0 ||
		schemaSequence["x-reset"] !== "never" ||
		schemaSequence["x-overflow"] !== "reject"
	) {
		errors.push("schema authorSequence contract does not exactly mirror registry boundaries");
	}
	return errors;
}

function validateWireAndIdentity(registry: Registry): string[] {
	const errors: string[] = [];
	if (registry.protocolMajor !== 3 || registry.registryVersion !== 1 || registry.packageName !== "protocol-v3") {
		errors.push("registry identity must be protocolMajor 3, registryVersion 1, packageName protocol-v3");
	}
	if (
		registry.wireFormat.canonicalPreimage !== "bytes" ||
		registry.wireFormat.signature !== "bytes" ||
		registry.wireFormat.digestVerification !== "received-bytes" ||
		registry.wireFormat.reencodeBeforeDigest !== false
	) {
		errors.push("wireFormat must sign canonical-preimage bytes and digest received bytes without re-encoding");
	}
	if (registry.canonicalObjectKeyOrder !== "encoded-key-bytes") {
		errors.push("canonical object ordering must use encoded key bytes, not declaration/review order");
	}
	for (const [kindName, kind] of Object.entries(registry.kinds)) {
		if (!kind.domain.endsWith("/v3") || kind.domain.includes("/v2")) {
			errors.push(`${kindName}: registered domain is not exclusively /v3`);
		}
	}
	const suiteIds = registry.cryptoSuites.active.map(({ suiteId }) => suiteId);
	const suiteRoles = registry.cryptoSuites.active.map(({ role }) => role);
	if (suiteIds.some((suiteId) => suiteId.trim() === "") || new Set(suiteIds).size !== suiteIds.length) {
		errors.push("active v3 suite identifiers must be nonempty and unique");
	}
	if (new Set(suiteRoles).size !== suiteRoles.length) {
		errors.push("active v3 suite roles must be unique");
	}
	const auditRoles = registry.cryptoSuites.predecessorAudit.map(({ role }) => role);
	if (new Set(auditRoles).size !== auditRoles.length) {
		errors.push("predecessor suite audit roles must be unique");
	}
	for (const audit of registry.cryptoSuites.predecessorAudit) {
		const activeForRole = registry.cryptoSuites.active.filter(({ role }) => role === audit.role);
		if (
			audit.disposition !== "replaced" ||
			audit.predecessorSuiteId === audit.successorSuiteId ||
			activeForRole.length !== 1 ||
			activeForRole[0].suiteId !== audit.successorSuiteId
		) {
			errors.push(`${audit.role}: predecessor suite audit does not select a distinct active successor`);
		}
	}
	const registryCarriesClassificationMetadata = Object.values(registry.kinds).some(
		({ signedEnvelope }) => signedEnvelope !== undefined
	);
	for (const [kindName, kind] of Object.entries(registry.kinds)) {
		if (!registryCarriesClassificationMetadata || kind.signedEnvelope === undefined) {
			continue;
		}
		if (kind.signedEnvelope?.classification === "signed") {
			const role = kind.signedEnvelope.suiteRole;
			const matchingSuites = registry.cryptoSuites.active.filter(
				({ domainKinds, role: suiteRole }) => suiteRole === role && domainKinds.includes(kindName)
			);
			if (role === null || matchingSuites.length !== 1) {
				errors.push(`${kindName}: signed envelope is not bound to exactly one active suite role`);
			}
		} else if (kind.signedEnvelope?.suiteRole !== null) {
			errors.push(`${kindName}: unsigned envelope unexpectedly carries a suite role`);
		}
	}
	if (registryCarriesClassificationMetadata) {
		for (const suite of registry.cryptoSuites.active) {
			for (const kindName of suite.domainKinds) {
				const metadata = registry.kinds[kindName]?.signedEnvelope;
				if (metadata?.classification !== "signed" || metadata.suiteRole !== suite.role) {
					errors.push(`${suite.role}/${kindName}: suite domain maps an unknown, unsigned, or wrong-role kind`);
				}
			}
		}
	}
	return errors;
}

function validateSequenceCases(cases: SequenceCase[]): string[] {
	const errors: string[] = [];
	for (const sequenceCase of cases) {
		const accepted =
			sequenceCase.value !== undefined &&
			Number.isSafeInteger(sequenceCase.value) &&
			sequenceCase.value >= 0 &&
			sequenceCase.value <= maximumSafeInteger;
		if (accepted !== sequenceCase.accepted) {
			errors.push(`${sequenceCase.name}: malformed/boundary sequence classification is wrong`);
		}
	}
	const requiredNames = ["initial-zero", "large-safe", "maximum-safe", "negative", "fractional", "unsafe", "missing"];
	if (JSON.stringify(cases.map(({ name }) => name)) !== JSON.stringify(requiredNames)) {
		errors.push("sequence controls do not cover the required malformed and safe-integer boundaries");
	}
	return errors;
}

function validateLineageTransitions(transitions: LineageTransition[]): string[] {
	const errors: string[] = [];
	for (const transition of transitions) {
		const canAdvance =
			Number.isSafeInteger(transition.before.next) &&
			transition.before.next >= 0 &&
			transition.before.next < maximumSafeInteger &&
			transition.candidate === transition.before.next;
		if (transition.accepted !== canAdvance) {
			errors.push(`${transition.name}: transition acceptance violates the no-wrap counter rule`);
			continue;
		}
		if (transition.accepted) {
			if (transition.after.next !== transition.before.next + 1) {
				errors.push(`${transition.name}: successful issuance does not advance exactly once`);
			}
			if (
				(transition.after.epoch !== transition.before.epoch || transition.after.anchor !== transition.before.anchor) &&
				transition.after.next <= transition.before.next
			) {
				errors.push(`${transition.name}: epoch/anchor transition reset authorSequence`);
			}
		} else if (transition.after.next !== transition.before.next) {
			errors.push(`${transition.name}: rejected exhaustion wrapped or mutated authorSequence`);
		}
	}
	return errors;
}

function validateCrossMajorCases(cases: CrossMajorCase[]): string[] {
	const errors: string[] = [];
	for (const crossCase of cases) {
		const accepted =
			crossCase.candidateMajor === crossCase.registryMajor &&
			crossCase.candidateDomain === crossCase.expectedDomain &&
			crossCase.candidateSuite === crossCase.expectedSuite;
		if (accepted !== crossCase.accepted) {
			errors.push(`${crossCase.name}: cross-major/domain/suite classifier result is wrong`);
		}
	}
	const requiredNames = [
		"v3-valid",
		"v2-domain-on-v3",
		"v2-suite-on-v3",
		"v3-domain-on-v2",
		"v3-suite-on-v2",
		"major-mismatch",
	];
	if (JSON.stringify(cases.map(({ name }) => name)) !== JSON.stringify(requiredNames)) {
		errors.push("cross-major controls are missing a bidirectional domain/suite/major case");
	}
	return errors;
}

function normalizeQc(value: string): string {
	return value.replaceAll("QC", "Qc");
}

function modelVariableName(envelopeKind: string, field: string): string {
	const normalizedKind = normalizeQc(envelopeKind);
	const normalizedField = normalizeQc(field);
	return `${normalizedKind}${normalizedField.slice(0, 1).toUpperCase()}${normalizedField.slice(1)}`;
}

function signedKindClassification(
	registry: Registry,
	signoff: RegistryModelSignoff,
	decisionRecords: DecisionRecord[]
): {
	errors: string[];
	signedKinds: string[];
	unsignedKinds: string[];
} {
	const errors: string[] = [];
	const allKinds = Object.keys(registry.kinds);
	let signedKinds: string[] = [];
	let unsignedKinds: string[] = [];

	if (signoff.classification.mode === "registry-metadata") {
		for (const [kindName, kind] of Object.entries(registry.kinds)) {
			if (kind.signedEnvelope === undefined) {
				errors.push(`${kindName}: missing mechanical signed-envelope classification`);
			} else if (kind.signedEnvelope.classification === "signed") {
				signedKinds.push(kindName);
			} else if (kind.signedEnvelope.classification === "unsigned") {
				unsignedKinds.push(kindName);
			} else {
				errors.push(`${kindName}: unknown signed-envelope classification`);
			}
		}
	} else if (signoff.classification.mode === "explicit-scoped") {
		const rationale = decisionRecords.find(({ id }) => id === signoff.classification.rationaleDecisionId);
		if (
			rationale?.decisionType !== "signed-envelope-classification" ||
			rationale.requirements.allKindsAudited !== true
		) {
			errors.push("explicit-scoped classification lacks a normative rationale and all-kind audit");
		}
		signedKinds = signoff.classification.signedEnvelopeKinds;
		unsignedKinds = signoff.classification.unsignedEnvelopeKinds;
	} else {
		errors.push("sign-off uses an unknown signed-kind classification mode");
	}

	if (JSON.stringify(signoff.classification.allRegistryKinds) !== JSON.stringify(allKinds)) {
		errors.push("sign-off all-kind audit is missing, extra, or out of registry order");
	}
	if (JSON.stringify(signoff.classification.signedEnvelopeKinds) !== JSON.stringify(signedKinds)) {
		errors.push("sign-off signed-kind classification does not match its mechanical source");
	}
	if (JSON.stringify(signoff.classification.unsignedEnvelopeKinds) !== JSON.stringify(unsignedKinds)) {
		errors.push("sign-off unsigned-kind classification does not match its mechanical source");
	}
	const classifiedKinds = [...signedKinds, ...unsignedKinds];
	if (
		new Set(classifiedKinds).size !== classifiedKinds.length ||
		JSON.stringify([...new Set(classifiedKinds)].sort()) !== JSON.stringify([...allKinds].sort())
	) {
		errors.push("sign-off classification duplicates or omits a registry kind");
	}
	return {
		errors,
		signedKinds: signedKinds.filter((kindName) => registry.kinds[kindName] !== undefined),
		unsignedKinds: unsignedKinds.filter((kindName) => registry.kinds[kindName] !== undefined),
	};
}

function requiredMappings(registry: Registry, signedKinds: string[]): FieldMapping[] {
	return signedKinds.flatMap((envelopeKind) =>
		registry.kinds[envelopeKind].fields.map(({ name }, index) => ({
			envelopeKind,
			field: name,
			modelVariable: modelVariableName(envelopeKind, name),
			registryPath: `kinds.${envelopeKind}.fields[${index}]`,
		}))
	);
}

function validateExplicitSuiteBindings(
	registry: Registry,
	signoff: RegistryModelSignoff,
	signedKinds: string[],
	unsignedKinds: string[]
): string[] {
	if (signoff.classification.mode !== "explicit-scoped") {
		return [];
	}
	const roles = signoff.classification.kindSuiteRoles;
	const allKinds = Object.keys(registry.kinds);
	if (roles === undefined || JSON.stringify(Object.keys(roles).sort()) !== JSON.stringify([...allKinds].sort())) {
		return ["explicit-scoped classification lacks an exact all-kind suite-role audit"];
	}
	const errors: string[] = [];
	for (const kindName of signedKinds) {
		const role = roles[kindName];
		const matches = registry.cryptoSuites.active.filter(
			({ domainKinds, role: suiteRole }) => suiteRole === role && domainKinds.includes(kindName)
		);
		if (typeof role !== "string" || role.trim() === "" || matches.length !== 1) {
			errors.push(`${kindName}: explicitly signed kind is not bound to exactly one active suite role`);
		}
	}
	for (const kindName of unsignedKinds) {
		const mapped = registry.cryptoSuites.active.some(({ domainKinds }) => domainKinds.includes(kindName));
		if (roles[kindName] !== null || mapped) {
			errors.push(`${kindName}: explicitly unsigned kind unexpectedly maps to an active suite`);
		}
	}
	return errors;
}

function validateSignoff(
	registry: Registry,
	signoff: RegistryModelSignoff,
	decisionRecords: DecisionRecord[],
	formalVariableNames: string[],
	reviewedArtifactHashes: Record<string, string>
): string[] {
	const classification = signedKindClassification(registry, signoff, decisionRecords);
	const errors = [...classification.errors];
	errors.push(
		...validateExplicitSuiteBindings(registry, signoff, classification.signedKinds, classification.unsignedKinds)
	);
	const expectedMappings = requiredMappings(registry, classification.signedKinds);
	if (JSON.stringify(signoff.fieldMappings) !== JSON.stringify(expectedMappings)) {
		errors.push("registry-to-formal mappings are missing, extra, duplicate, unmapped, reordered, or name-swapped");
	}
	const mappedVariables = signoff.fieldMappings.map(({ modelVariable }) => modelVariable);
	if (new Set(mappedVariables).size !== mappedVariables.length) {
		errors.push("one formal variable is mapped more than once");
	}
	if (
		JSON.stringify([...formalVariableNames].sort()) !==
		JSON.stringify(expectedMappings.map(({ modelVariable }) => modelVariable).sort())
	) {
		errors.push("parsed formal variables are not an exact signed-registry-field bijection");
	}
	const reviewedPaths = signoff.reviewedArtifacts.map(({ path }) => path);
	if (new Set(reviewedPaths).size !== reviewedPaths.length) {
		errors.push("sign-off reviewed artifacts contain duplicate paths");
	}
	for (const reviewed of signoff.reviewedArtifacts) {
		if (reviewedArtifactHashes[reviewed.path] !== reviewed.sha256) {
			errors.push(`${reviewed.path}: stale reviewed-artifact hash`);
		}
	}
	if (Object.keys(reviewedArtifactHashes).some((path) => !reviewedPaths.includes(path))) {
		errors.push("sign-off omits a required reviewed artifact");
	}
	if (
		signoff.protocolMajor !== 3 ||
		signoff.status !== "complete" ||
		signoff.schemaVersion !== "phase-n1prime-b-registry-model-signoff-v1"
	) {
		errors.push("registry-model sign-off identity/status is incomplete");
	}
	if (
		signoff.acceptedActionModel.path !== contract.acceptedActionModel.path ||
		signoff.acceptedActionModel.sha256 !== contract.acceptedActionModel.sha256
	) {
		errors.push("registry-model sign-off carries a stale or substituted accepted action-model hash");
	}
	if (
		signoff.classification.rationaleDecisionId !== decisionByType(decisionRecords, "signed-envelope-classification")?.id
	) {
		errors.push("sign-off signed-kind classification is not bound to its numbered normative decision");
	}
	const classificationDecision = decisionByType(decisionRecords, "signed-envelope-classification");
	if (
		JSON.stringify(classificationDecision?.requirements.signedEnvelopeKinds) !==
			JSON.stringify(signoff.classification.signedEnvelopeKinds) ||
		JSON.stringify(classificationDecision?.requirements.unsignedEnvelopeKinds) !==
			JSON.stringify(signoff.classification.unsignedEnvelopeKinds)
	) {
		errors.push("sign-off signed/unsigned kind sets differ from the numbered normative classification");
	}
	return errors;
}

function decisionByType(records: DecisionRecord[], decisionType: string): DecisionRecord | undefined {
	const matches = records.filter((record) => record.decisionType === decisionType);
	return matches.length === 1 ? matches[0] : undefined;
}

function validateRoundChangeResolution(registry: Registry, decisionRecords: DecisionRecord[]): string[] {
	const decision = decisionByType(decisionRecords, "round-change-anchor-resolution");
	if (decision === undefined) {
		return ["missing unique numbered roundChange/anchor resolution"];
	}
	const resolution = decision.requirements.resolution;
	const binding = decision.requirements.roundChangeAnchorBinding;
	if (typeof resolution !== "string" || resolution.trim() === "") {
		return ["roundChange/anchor resolution is not explicit"];
	}
	const roundFields = registry.kinds.roundChange?.fields.map(({ name }) => name) ?? [];
	if (binding === "direct" && !roundFields.includes("anchor")) {
		return ["direct roundChange anchor resolution is absent from registry"];
	}
	if (binding === "not-required") {
		if (roundFields.includes("anchor") || typeof decision.requirements.normativeRationale !== "string") {
			return ["not-required roundChange anchor resolution contradicts registry or lacks rationale"];
		}
	}
	if (binding === "transitive") {
		const path = decision.requirements.anchorEvidencePath;
		const resolvedSegments =
			Array.isArray(path) && path.every((segment) => typeof segment === "string")
				? path.map((segment) => {
						const [kindName, fieldName, ...extra] = segment.split(".");
						return {
							extra,
							fieldName,
							kindName,
							resolves:
								extra.length === 0 && registry.kinds[kindName]?.fields.some(({ name }) => name === fieldName) === true,
						};
					})
				: [];
		if (
			resolvedSegments.length === 0 ||
			resolvedSegments.some(({ resolves }) => !resolves) ||
			resolvedSegments[0].kindName !== "roundChange" ||
			resolvedSegments.at(-1)?.fieldName !== "anchor"
		) {
			return ["transitive roundChange anchor resolution has no mechanically resolvable registry evidence path"];
		}
	}
	if (!["direct", "not-required", "transitive"].includes(`${binding}`)) {
		return ["roundChange anchor binding is not a recognized explicit resolution"];
	}
	if (decision.requirements.registryModelSpecConsequences !== "consistent") {
		return ["roundChange decision does not declare internally consistent registry/spec/model consequences"];
	}
	return [];
}

function validateDecisions(
	registry: Registry,
	amendmentRecords: DecisionRecord[],
	specificationRecords: DecisionRecord[]
): string[] {
	const errors: string[] = [];
	if (amendmentRecords.length !== specificationRecords.length) {
		errors.push("amendment/spec decision counts differ");
	}
	const numbers = amendmentRecords.map(({ decision }) => decision);
	if (new Set(numbers).size !== numbers.length || numbers.some((number, index) => number !== index + 1)) {
		errors.push("normative amendments are not uniquely and consecutively numbered");
	}
	for (const decisionType of contract.requiredDecisionTypes) {
		if (amendmentRecords.filter((record) => record.decisionType === decisionType).length !== 1) {
			errors.push(`${decisionType}: missing or duplicate normative amendment`);
		}
	}
	for (const amendment of amendmentRecords) {
		const specification = specificationRecords.find(({ id }) => id === amendment.id);
		if (
			specification === undefined ||
			semanticJson({
				decision: specification.decision,
				decisionType: specification.decisionType,
				registryPaths: specification.registryPaths,
				requirements: specification.requirements,
			}) !==
				semanticJson({
					decision: amendment.decision,
					decisionType: amendment.decisionType,
					registryPaths: amendment.registryPaths,
					requirements: amendment.requirements,
				})
		) {
			errors.push(`${amendment.id}: amendment and structured normative spec decision differ`);
		}
		const binding = registry.decisionBindings.find(({ decisionId }) => decisionId === amendment.id);
		if (
			binding === undefined ||
			binding.decisionType !== amendment.decisionType ||
			JSON.stringify(binding.registryPaths) !== JSON.stringify(amendment.registryPaths)
		) {
			errors.push(`${amendment.id}: registry decision binding is missing or inconsistent`);
		}
	}
	if (registry.decisionBindings.length !== amendmentRecords.length) {
		errors.push("registry/amendment/spec decision binding is not bijective");
	}

	const identity = decisionByType(amendmentRecords, "protocol-identity");
	if (
		identity?.requirements.protocolMajor !== 3 ||
		identity.requirements.registryVersion !== 1 ||
		identity.requirements.packageName !== "protocol-v3" ||
		identity.requirements.distinctSuccessorSuites !== true
	) {
		errors.push("protocol identity decision does not normatively bind the v3 tuple and distinct suites");
	}
	const sequence = decisionByType(amendmentRecords, "vertex-author-sequence");
	if (
		sequence?.requirements.field !== "authorSequence" ||
		sequence.requirements.reviewPosition !== "immediately-after-author" ||
		sequence.requirements.type !== "safe-integer" ||
		sequence.requirements.minimum !== 0 ||
		sequence.requirements.maximum !== maximumSafeInteger ||
		sequence.requirements.initial !== 0 ||
		sequence.requirements.reset !== "never" ||
		sequence.requirements.overflow !== "reject"
	) {
		errors.push("authorSequence decision does not normatively bind review position and full boundary semantics");
	}
	const wire = decisionByType(amendmentRecords, "wire-format");
	if (semanticJson(wire?.requirements) !== semanticJson(registry.wireFormat)) {
		errors.push("wire-format decision is not an exact registry bijection");
	}
	const canonical = decisionByType(amendmentRecords, "canonical-map-order");
	if (
		canonical?.requirements.rule !== "encoded-key-bytes" ||
		canonical.requirements.declarationOrderControlsEncoding !== false
	) {
		errors.push("canonical-map decision does not exclude declaration/review order");
	}
	const classification = decisionByType(amendmentRecords, "signed-envelope-classification");
	const registrySignedKinds = Object.entries(registry.kinds)
		.filter(([, kind]) => kind.signedEnvelope?.classification === "signed")
		.map(([kindName]) => kindName);
	const registryUnsignedKinds = Object.entries(registry.kinds)
		.filter(([, kind]) => kind.signedEnvelope?.classification === "unsigned")
		.map(([kindName]) => kindName);
	const classificationMode = classification?.requirements.classificationMode;
	const decisionSignedKinds = classification?.requirements.signedEnvelopeKinds;
	const decisionUnsignedKinds = classification?.requirements.unsignedEnvelopeKinds;
	const decisionAllKinds =
		Array.isArray(decisionSignedKinds) && Array.isArray(decisionUnsignedKinds)
			? [...decisionSignedKinds, ...decisionUnsignedKinds]
			: [];
	const explicitScopedValid =
		classificationMode === "explicit-scoped" &&
		typeof classification?.requirements.scopeRationale === "string" &&
		classification.requirements.scopeRationale.trim() !== "" &&
		JSON.stringify([...new Set(decisionAllKinds)].sort()) === JSON.stringify(Object.keys(registry.kinds).sort());
	const metadataValid =
		classificationMode === "registry-metadata" &&
		JSON.stringify(decisionSignedKinds) === JSON.stringify(registrySignedKinds) &&
		JSON.stringify(decisionUnsignedKinds) === JSON.stringify(registryUnsignedKinds);
	if (classification?.requirements.allKindsAudited !== true || (!metadataValid && !explicitScopedValid)) {
		errors.push("signed-envelope decision is not an exact normative classification of every registry kind");
	}
	errors.push(...validateRoundChangeResolution(registry, amendmentRecords));
	return errors;
}

function extractNormativeDecisionRecords(markdown: string): DecisionRecord[] {
	const records: DecisionRecord[] = [];
	const pattern = /```json normative-decision\s*\n([\s\S]*?)\n```/gu;
	for (const match of markdown.matchAll(pattern)) {
		records.push(JSON.parse(match[1]) as DecisionRecord);
	}
	return records;
}

function validateNormativeSourceResolution(
	amendmentRecords: DecisionRecord[],
	specification: string,
	specificationPath: string
): string[] {
	const errors: string[] = [];
	for (const amendment of amendmentRecords) {
		const anchor = `decision-v3-${String(amendment.decision).padStart(2, "0")}`;
		if (
			amendment.status !== "normative" ||
			amendment.normativeSource !== `./${basename(specificationPath)}#${anchor}`
		) {
			errors.push(`${amendment.id}: numbered normative source is not mechanically resolvable`);
			continue;
		}
		const marker = `<a id="${anchor}"></a>`;
		const markerIndex = specification.indexOf(marker);
		const nextFenceStart = specification.indexOf("```json normative-decision", markerIndex + marker.length);
		const nextFenceEnd = specification.indexOf("\n```", nextFenceStart);
		if (markerIndex < 0 || nextFenceStart < 0 || nextFenceEnd < 0) {
			errors.push(`${amendment.id}: normative specification anchor has no structured decision record`);
			continue;
		}
		const jsonStart = specification.indexOf("\n", nextFenceStart) + 1;
		try {
			const record = JSON.parse(specification.slice(jsonStart, nextFenceEnd)) as DecisionRecord;
			if (record.id !== amendment.id || record.decision !== amendment.decision) {
				errors.push(`${amendment.id}: normative source anchor resolves to a different decision`);
			}
		} catch {
			errors.push(`${amendment.id}: normative source anchor resolves to invalid structured JSON`);
		}
	}
	return errors;
}

function declaredQuintVariables(document: QuintParseDocument): string[] {
	return document.modules.flatMap(({ declarations }) =>
		declarations.filter(({ kind }) => kind === "var").map(({ name }) => name)
	);
}

function invalidQuintIsRejected(): boolean {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-n1prime-b-invalid-quint-"));
	const invalidModelPath = join(temporaryDirectory, "invalid.qnt");
	const parseOutputPath = join(temporaryDirectory, "invalid.json");
	try {
		writeFileSync(invalidModelPath, "module invalidRegistryVariables { var broken: }", "utf8");
		const parsed = spawnSync("pnpm", ["exec", "quint", "parse", invalidModelPath, "--out", parseOutputPath], {
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		return parsed.status !== 0;
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

function actualReviewedArtifactHashes(): Record<string, string> {
	const paths = [
		contract.targetArtifacts.registry,
		contract.targetArtifacts.schema,
		contract.targetArtifacts.specification,
		contract.targetArtifacts.amendmentLog,
		contract.targetArtifacts.formalVariables,
	];
	return Object.fromEntries(paths.map((path) => [path, sha256(path)]));
}

function validateV2SuiteAudit(registry: Registry): string[] {
	const v2Amendments = readJson<V2AmendmentLog>(v2AmendmentLogPath);
	const activeSuites = v2Amendments.entries.find(({ id }) => id === "PH-N1-D12")?.requirements.activeSuites;
	if (activeSuites === undefined) {
		return ["frozen v2 suite oracle is missing its active-suite decision"];
	}
	const errors: string[] = [];
	for (const [role, predecessorSuiteId] of Object.entries(activeSuites)) {
		const audits = registry.cryptoSuites.predecessorAudit.filter((audit) => audit.role === role);
		if (
			audits.length !== 1 ||
			audits[0].predecessorSuiteId !== predecessorSuiteId ||
			audits[0].successorSuiteId === predecessorSuiteId
		) {
			errors.push(`${role}: v2-domain-bound suite lacks one exact distinct-successor audit`);
		}
	}
	return errors;
}

function validateSignedKindPredecessorDisposition(registry: Registry, decisionRecords: DecisionRecord[]): string[] {
	const v2VariableMap = readJson<V2VariableMap>(v2VariableMapPath);
	const classification = decisionByType(decisionRecords, "signed-envelope-classification");
	const omittedRationales = classification?.requirements.omittedPredecessorRationales;
	const unsignedRationales = classification?.requirements.unsignedPredecessorRationales;
	const errors: string[] = [];
	for (const kindName of v2VariableMap.signedEnvelopeKinds) {
		const successorKind = registry.kinds[kindName];
		if (successorKind?.signedEnvelope?.classification === "signed") {
			continue;
		}
		const rationaleSource = successorKind === undefined ? omittedRationales : unsignedRationales;
		const rationale =
			typeof rationaleSource === "object" && rationaleSource !== null
				? (rationaleSource as Record<string, unknown>)[kindName]
				: undefined;
		if (typeof rationale !== "string" || rationale.trim() === "") {
			errors.push(
				`${kindName}: v2-signed predecessor was omitted or reclassified unsigned without a numbered normative rationale`
			);
		}
	}
	return errors;
}

function validateActualCrossMajorSeparation(registry: Registry): string[] {
	const v2Registry = readJson<V2Registry>(v2RegistryPath);
	const errors: string[] = [];
	for (const [kindName, v3Kind] of Object.entries(registry.kinds)) {
		const v2Domain = v2Registry.domains[kindName];
		if (v2Domain === undefined) {
			continue;
		}
		if (v2Domain === v3Kind.domain) {
			errors.push(`${kindName}: v2 and v3 domains are identical`);
		}
		if (!v2Domain.endsWith("/v2") || !v3Kind.domain.endsWith("/v3")) {
			errors.push(`${kindName}: cross-major domain pair is not /v2 versus /v3`);
		}
	}
	const v2Amendments = readJson<V2AmendmentLog>(v2AmendmentLogPath);
	const v2Suites = v2Amendments.entries.find(({ id }) => id === "PH-N1-D12")?.requirements.activeSuites ?? {};
	for (const suite of registry.cryptoSuites.active) {
		const v2Suite = v2Suites[suite.role];
		if (v2Suite !== undefined && suite.suiteId === v2Suite) {
			errors.push(`${suite.role}: v3 suite reuses a v2-domain-bound identifier`);
		}
		for (const kindName of suite.domainKinds) {
			if (registry.kinds[kindName]?.signedEnvelope?.suiteRole !== suite.role) {
				errors.push(`${suite.role}/${kindName}: suite-domain classification is unmapped`);
			}
		}
	}
	return errors;
}

describe("Phase -1 prime b registry/spec RED controls", () => {
	it("mechanically derives the accepted closed SignedVertex review surface from the immutable Quint AST", () => {
		const modelFields = parseAcceptedSignedVertexFields();
		expect(modelFields).toEqual(contract.illustrativeControls.registry.kinds.vertex.fields.map(({ name }) => name));
		expect(modelFields[modelFields.indexOf("author") + 1]).toBe("authorSequence");
	}, 120_000);

	it("maps every frozen registry field type without narrowing native bytes or canonical values", () => {
		const controls = contract.illustrativeControls.schemaTypeControls;
		expect(
			controls.map(({ field }) => field.type).sort(),
			"nonnormative controls must cover every distinct frozen registry field type exactly once"
		).toEqual(frozenRegistryFieldTypes);
		for (const control of controls) {
			expect(fieldSchemaErrors(control.field, control.schema, `type-control.${control.name}`)).toEqual([]);
		}

		const byName = (name: string): SchemaTypeControl => {
			const control = controls.find((candidate) => candidate.name === name);
			expect(control, `missing schema type control ${name}`).toBeDefined();
			return clone(control as (typeof controls)[number]);
		};

		const canonicalIntegerAsString = byName("canonical-safe-integer");
		canonicalIntegerAsString.schema.type = "string";
		expect(fieldSchemaErrors(canonicalIntegerAsString.field, canonicalIntegerAsString.schema, "mutant")).toContain(
			"mutant: schema type does not match registry type canonical-safe-integer"
		);

		const parametersAsString = byName("parameters");
		parametersAsString.schema.type = "string";
		expect(fieldSchemaErrors(parametersAsString.field, parametersAsString.schema, "mutant")).toContain(
			"mutant: schema type does not match registry type parameters"
		);

		for (const nativeType of ["bytes", "canonical-value"]) {
			const narrowedNative = byName(nativeType);
			narrowedNative.schema.type = "string";
			expect(fieldSchemaErrors(narrowedNative.field, narrowedNative.schema, "mutant")).toContain(
				`mutant: schema type does not match registry type ${nativeType}`
			);
		}
		const inventedByteEncoding = byName("bytes");
		inventedByteEncoding.schema.contentEncoding = "base64";
		expect(fieldSchemaErrors(inventedByteEncoding.field, inventedByteEncoding.schema, "mutant")).toContain(
			"mutant: native bytes/canonical-value schema must not invent a JSON projection or encoding"
		);

		const nullableMemberLoss = byName("seal-qc|null");
		nullableMemberLoss.schema.type = ["object"];
		expect(fieldSchemaErrors(nullableMemberLoss.field, nullableMemberLoss.schema, "mutant")).toContain(
			"mutant: schema type does not match registry type seal-qc|null"
		);
		const nullableOrder = byName("seal-qc|null");
		nullableOrder.schema.type = ["object", "null"];
		expect(fieldSchemaErrors(nullableOrder.field, nullableOrder.schema, "mutant")).toEqual([]);

		const arrayAsObject = byName("array<signed-seal-vote>");
		arrayAsObject.schema.type = "object";
		expect(fieldSchemaErrors(arrayAsObject.field, arrayAsObject.schema, "mutant")).toContain(
			"mutant: schema type does not match registry type array<signed-seal-vote>"
		);

		const missingNativeType = byName("digest-hex");
		delete missingNativeType.schema["x-registry-type"];
		expect(fieldSchemaErrors(missingNativeType.field, missingNativeType.schema, "mutant")).toContain(
			"mutant: schema x-registry-type does not exactly preserve the native registry type"
		);
		const wrongNativeType = byName("digest-hex");
		wrongNativeType.schema["x-registry-type"] = "canonical-string";
		expect(fieldSchemaErrors(wrongNativeType.field, wrongNativeType.schema, "mutant")).toContain(
			"mutant: schema x-registry-type does not exactly preserve the native registry type"
		);

		const staleConstraints = byName("canonical-string");
		staleConstraints.schema["x-registry-constraints"] = {};
		expect(fieldSchemaErrors(staleConstraints.field, staleConstraints.schema, "mutant")).toContain(
			"mutant: schema x-registry-constraints provenance differs from the registry"
		);
		const missingConstraints = byName("canonical-string");
		delete missingConstraints.schema["x-registry-constraints"];
		expect(fieldSchemaErrors(missingConstraints.field, missingConstraints.schema, "mutant")).toContain(
			"mutant: schema x-registry-constraints provenance differs from the registry"
		);

		const enumDrift = byName("enum");
		enumDrift.schema.enum = ["alpha", "future"];
		expect(fieldSchemaErrors(enumDrift.field, enumDrift.schema, "mutant")).toContain(
			"mutant: schema enum does not exactly match active registry constraint values"
		);

		const unknownType = byName("string");
		unknownType.field.type = "future-scalar";
		expect(() => fieldSchemaErrors(unknownType.field, unknownType.schema, "mutant")).toThrow(
			"unknown registry field type: future-scalar"
		);
		const unknownArray = byName("array<signer>");
		unknownArray.field.type = "array<unknown>";
		expect(() => fieldSchemaErrors(unknownArray.field, unknownArray.schema, "mutant")).toThrow(
			"unknown registry field type: array<unknown>"
		);
	});

	it("accepts the nonnormative registry/schema/spec/sign-off controls", () => {
		const controls = contract.illustrativeControls;
		const modelFields = controls.registry.kinds.vertex.fields.map(({ name }) => name);
		expect(controls.notice).toContain("NONNORMATIVE");
		expect(validateWireAndIdentity(controls.registry)).toEqual([]);
		expect(validateRegistrySchemaBijection(controls.registry, controls.schema)).toEqual([]);
		expect(validateVertexSurface(controls.registry, controls.schema, modelFields)).toEqual([]);
		expect(validateDecisions(controls.registry, controls.decisionRecords, clone(controls.decisionRecords))).toEqual([]);
		expect(
			validateSignoff(
				controls.registry,
				controls.signoff,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toEqual([]);
		expect(validateSequenceCases(controls.sequenceCases)).toEqual([]);
		expect(validateLineageTransitions(controls.lineageTransitions)).toEqual([]);
		expect(validateCrossMajorCases(controls.crossMajorCases)).toEqual([]);
		expect(validateSignedKindPredecessorDisposition(controls.registry, controls.decisionRecords)).toEqual([]);
		expect(invalidQuintIsRejected(), "the pinned Quint parser must reject a malformed formal source mutant").toBe(true);
	});

	it("kills sequence review-order, boundary, reset, and wrap mutants", () => {
		const controls = contract.illustrativeControls;
		const modelFields = controls.registry.kinds.vertex.fields.map(({ name }) => name);
		const moved = clone(controls.registry);
		const sequence = moved.kinds.vertex.fields.splice(6, 1)[0];
		moved.kinds.vertex.fields.push(sequence);
		expect(validateVertexSurface(moved, controls.schema, modelFields)).toContain(
			"authorSequence is not immediately after author"
		);

		const unsafeMaximum = clone(controls.registry);
		const unsafeSequence = unsafeMaximum.kinds.vertex.fields.find(({ name }) => name === "authorSequence");
		expect(unsafeSequence).toBeDefined();
		if (unsafeSequence !== undefined) {
			unsafeSequence.constraints.maximum = maximumSafeInteger + 1;
		}
		expect(validateVertexSurface(unsafeMaximum, controls.schema, modelFields)).toContain(
			"registry authorSequence contract is not safe-integer 0..MAX_SAFE, initial 0, no-reset/no-wrap"
		);

		const reset = clone(controls.lineageTransitions);
		reset[1].after.next = 0;
		expect(validateLineageTransitions(reset)).toContain(
			"new-anchor-does-not-reset: successful issuance does not advance exactly once"
		);

		const wrap = clone(controls.lineageTransitions);
		wrap[2].after.next = 0;
		expect(validateLineageTransitions(wrap)).toContain(
			"maximum-does-not-wrap: rejected exhaustion wrapped or mutated authorSequence"
		);
	});

	it("kills wire, domain, suite, and declaration-order mutants", () => {
		const controls = contract.illustrativeControls;
		const reencode = clone(controls.registry);
		reencode.wireFormat.reencodeBeforeDigest = true;
		expect(validateWireAndIdentity(reencode)).toContain(
			"wireFormat must sign canonical-preimage bytes and digest received bytes without re-encoding"
		);

		const v2Domain = clone(controls.registry);
		v2Domain.kinds.vertex.domain = "illustrative/vertex/v2";
		expect(validateWireAndIdentity(v2Domain)).toContain("vertex: registered domain is not exclusively /v3");

		const reusedSuite = clone(controls.registry);
		reusedSuite.cryptoSuites.predecessorAudit[0].successorSuiteId =
			reusedSuite.cryptoSuites.predecessorAudit[0].predecessorSuiteId;
		expect(validateWireAndIdentity(reusedSuite)).toContain(
			"identityAndVertex: predecessor suite audit does not select a distinct active successor"
		);

		const unmappedSignedKind = clone(controls.registry);
		unmappedSignedKind.cryptoSuites.active[0].domainKinds = [];
		expect(validateWireAndIdentity(unmappedSignedKind)).toContain(
			"vertex: signed envelope is not bound to exactly one active suite role"
		);

		const swappedAuditSuccessors = clone(controls.registry);
		[
			swappedAuditSuccessors.cryptoSuites.predecessorAudit[0].successorSuiteId,
			swappedAuditSuccessors.cryptoSuites.predecessorAudit[1].successorSuiteId,
		] = [
			swappedAuditSuccessors.cryptoSuites.predecessorAudit[1].successorSuiteId,
			swappedAuditSuccessors.cryptoSuites.predecessorAudit[0].successorSuiteId,
		];
		expect(validateWireAndIdentity(swappedAuditSuccessors)).toContain(
			"identityAndVertex: predecessor suite audit does not select a distinct active successor"
		);

		const mappedUnsignedKind = clone(controls.registry);
		const diagnosticMetadata = mappedUnsignedKind.kinds.diagnostic.signedEnvelope;
		expect(diagnosticMetadata).toBeDefined();
		if (diagnosticMetadata !== undefined) {
			diagnosticMetadata.suiteRole = "identityAndVertex";
		}
		mappedUnsignedKind.cryptoSuites.active[0].domainKinds.push("diagnostic");
		expect(validateWireAndIdentity(mappedUnsignedKind)).toContain(
			"diagnostic: unsigned envelope unexpectedly carries a suite role"
		);
		expect(validateWireAndIdentity(mappedUnsignedKind)).toContain(
			"identityAndVertex/diagnostic: suite domain maps an unknown, unsigned, or wrong-role kind"
		);

		const declarationOrder = clone(controls.registry);
		declarationOrder.canonicalObjectKeyOrder = "registry-declaration-order";
		expect(validateWireAndIdentity(declarationOrder)).toContain(
			"canonical object ordering must use encoded key bytes, not declaration/review order"
		);

		const crossMajor = clone(controls.crossMajorCases);
		crossMajor[1].accepted = true;
		expect(validateCrossMajorCases(crossMajor)).toContain(
			"v2-domain-on-v3: cross-major/domain/suite classifier result is wrong"
		);
	});

	it("kills schema, numbered-evidence, all-kind, mapping, name-swap, and stale-hash mutants", () => {
		const controls = contract.illustrativeControls;
		const missingSchemaField = clone(controls.schema);
		delete missingSchemaField.$defs.vertex.properties.authorSequence;
		expect(validateRegistrySchemaBijection(controls.registry, missingSchemaField)).toContain(
			"vertex: schema properties are not in exact registry review order"
		);

		const vocabularyOnly = clone(controls.decisionRecords);
		vocabularyOnly[2].requirements.digestVerification = "reencoded-bytes";
		expect(validateDecisions(controls.registry, vocabularyOnly, clone(vocabularyOnly))).toContain(
			"wire-format decision is not an exact registry bijection"
		);

		const unsafeNormativeMaximum = clone(controls.decisionRecords);
		unsafeNormativeMaximum[1].requirements.maximum = maximumSafeInteger + 1;
		expect(validateDecisions(controls.registry, unsafeNormativeMaximum, clone(unsafeNormativeMaximum))).toContain(
			"authorSequence decision does not normatively bind review position and full boundary semantics"
		);

		const noAnchorDecision = clone(controls.decisionRecords);
		noAnchorDecision.splice(4, 1);
		expect(validateDecisions(controls.registry, noAnchorDecision, clone(noAnchorDecision))).toContain(
			"round-change-anchor-resolution: missing or duplicate normative amendment"
		);

		const omittedWithoutRationale = clone(controls.decisionRecords);
		delete omittedWithoutRationale[5].requirements.omittedPredecessorRationales;
		expect(validateSignedKindPredecessorDisposition(controls.registry, omittedWithoutRationale)).toContain(
			"sealVote: v2-signed predecessor was omitted or reclassified unsigned without a numbered normative rationale"
		);

		const omittedKind = clone(controls.signoff);
		omittedKind.classification.allRegistryKinds.pop();
		expect(
			validateSignoff(
				controls.registry,
				omittedKind,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("sign-off all-kind audit is missing, extra, or out of registry order");

		const unknownClassification = clone(controls.registry);
		const vertexClassification = unknownClassification.kinds.vertex.signedEnvelope;
		expect(vertexClassification).toBeDefined();
		if (vertexClassification !== undefined) {
			(vertexClassification as unknown as { classification: string }).classification = "ambiguous";
		}
		expect(
			validateSignoff(
				unknownClassification,
				controls.signoff,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("vertex: unknown signed-envelope classification");

		const swappedNames = clone(controls.signoff);
		[swappedNames.fieldMappings[0].modelVariable, swappedNames.fieldMappings[1].modelVariable] = [
			swappedNames.fieldMappings[1].modelVariable,
			swappedNames.fieldMappings[0].modelVariable,
		];
		expect(
			validateSignoff(
				controls.registry,
				swappedNames,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("registry-to-formal mappings are missing, extra, duplicate, unmapped, reordered, or name-swapped");

		const missingMapping = clone(controls.signoff);
		missingMapping.fieldMappings.pop();
		expect(
			validateSignoff(
				controls.registry,
				missingMapping,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("registry-to-formal mappings are missing, extra, duplicate, unmapped, reordered, or name-swapped");

		const duplicateVariables = clone(controls.formalVariableNames);
		duplicateVariables[1] = duplicateVariables[0];
		expect(
			validateSignoff(
				controls.registry,
				controls.signoff,
				controls.decisionRecords,
				duplicateVariables,
				controls.reviewedArtifactHashes
			)
		).toContain("parsed formal variables are not an exact signed-registry-field bijection");

		const staleHash = clone(controls.signoff);
		staleHash.reviewedArtifacts[0].sha256 = "0".repeat(64);
		expect(
			validateSignoff(
				controls.registry,
				staleHash,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("illustrative-registry.json: stale reviewed-artifact hash");

		const staleModel = clone(controls.signoff);
		staleModel.acceptedActionModel.sha256 = "f".repeat(64);
		expect(
			validateSignoff(
				controls.registry,
				staleModel,
				controls.decisionRecords,
				controls.formalVariableNames,
				controls.reviewedArtifactHashes
			)
		).toContain("registry-model sign-off carries a stale or substituted accepted action-model hash");
	});
});

describe("Phase -1 prime b future registry/spec integration", () => {
	it("requires the pinned future v3 registry, schema, normative spec/amendments, and all-kind formal sign-off", () => {
		const missingArtifacts = artifactPaths.filter((path) => !existsSync(absolutePath(path)));
		expect(
			missingArtifacts,
			`Phase -1 prime b remains RED only because these future GREEN artifacts are absent:\n${missingArtifacts.join("\n")}`
		).toEqual([]);
	});

	it.runIf(allGreenArtifactsExist)(
		"enforces the registry/model/schema/spec bijection and v2-v3 separation over the future artifacts",
		() => {
			const registry = readJson<Registry>(contract.targetArtifacts.registry);
			const schema = readJson<RegistrySchema>(contract.targetArtifacts.schema);
			const amendments = readJson<AmendmentLog>(contract.targetArtifacts.amendmentLog);
			const signoff = readJson<RegistryModelSignoff>(contract.targetArtifacts.registryModelSignoff);
			const specification = readFileSync(absolutePath(contract.targetArtifacts.specification), "utf8");
			const specificationRecords = extractNormativeDecisionRecords(specification);
			const acceptedModelFields = parseAcceptedSignedVertexFields();
			const formalParse = parseQuint(contract.targetArtifacts.formalVariables);
			const formalVariables = declaredQuintVariables(formalParse);
			const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", contract.targetArtifacts.formalVariables], {
				cwd: repositoryRoot,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			});

			expect(amendments).toMatchObject({
				protocolMajor: 3,
				registryVersion: 1,
				status: "normative",
				normativeDocument: `./${basename(contract.targetArtifacts.specification)}`,
			});
			expect(typecheck.status, `invalid future Quint formal source\n${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
			expect(validateWireAndIdentity(registry)).toEqual([]);
			expect(validateRegistrySchemaBijection(registry, schema)).toEqual([]);
			expect(validateVertexSurface(registry, schema, acceptedModelFields)).toEqual([]);
			expect(validateDecisions(registry, amendments.entries, specificationRecords)).toEqual([]);
			expect(
				validateNormativeSourceResolution(amendments.entries, specification, contract.targetArtifacts.specification)
			).toEqual([]);
			expect(
				validateSignoff(registry, signoff, amendments.entries, formalVariables, actualReviewedArtifactHashes())
			).toEqual([]);
			expect(validateV2SuiteAudit(registry)).toEqual([]);
			expect(validateSignedKindPredecessorDisposition(registry, amendments.entries)).toEqual([]);
			expect(validateActualCrossMajorSeparation(registry)).toEqual([]);
		},
		120_000
	);
});
