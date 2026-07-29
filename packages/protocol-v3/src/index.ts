import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { init as initializeModuleLexer, parse as parseModule } from "es-module-lexer";

import registryJson from "../registry/registry-v1.json" with { type: "json" };
import blueprintArtifactProfileJson from "../supplements/blueprint-artifact-profile-v1/profile.json" with { type: "json" };

interface RegistryField {
	readonly name: string;
	readonly type: string;
	readonly const: unknown;
	readonly constraints: Readonly<Record<string, unknown>>;
	readonly required: boolean;
	readonly sortRule: string | null;
}

interface ProtocolRegistry {
	readonly domains: Readonly<Record<string, string>>;
	readonly kinds: Readonly<
		Record<
			string,
			{
				readonly domain: string;
				readonly fields: readonly RegistryField[];
			}
		>
	>;
	readonly cryptoSuites: {
		readonly active: readonly {
			readonly role: string;
			readonly suiteId: string;
		}[];
	};
}

export interface RawEd25519PublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

export interface VerifyReceivedVertexInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

export interface RegisteredVertexVerification {
	readonly accepted: boolean;
	readonly digest?: Uint8Array;
}

export interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

export interface LocalVertexInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

export interface SignedVertexEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface IssuedVertexRecord {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

export interface IssuanceOutboxEntry {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

export interface IssueCommit {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly issuedRecord: IssuedVertexRecord;
	readonly outboxEntry: IssuanceOutboxEntry;
}

export type BuildAndSign = (authorSequence: number) => Promise<IssueCommit>;

export type TransactIssue = (scope: IssueScope, buildAndSign: BuildAndSign) => Promise<IssueCommit>;

export interface TransactionalVertexIssuer {
	issue(input: LocalVertexInput): Promise<IssueCommit>;
}

export interface TransactionalIssuerOptions {
	readonly author: string;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: RawEd25519PublicKey;
	readonly transactIssue: TransactIssue;
}

export interface AdmitReceivedVertexInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

export interface AdmissionDecision {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
}

export interface AdmissionBoundTransactionalIssuerOptions {
	readonly author: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: RawEd25519PublicKey;
	readonly transactIssue: TransactIssue;
}

export interface BlueprintPreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}

export interface BlueprintRuntimePreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
}

/**
 * An admission capability prepared from a canonical, digest-bound blueprint package.
 *
 * Its public digest is informational. Consumer authorization is established by
 * module-private runtime provenance, so copying or reconstructing this value
 * does not produce a usable capability.
 */
export interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

/**
 * A package-owned runtime capability bound to exact package and artifact bytes.
 *
 * Public fields are informational. Module-private provenance, distinct from the
 * admission capability provenance, establishes whether the capability is genuine.
 */
export interface PreparedBlueprintRuntime {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly reducers: Readonly<
		Record<
			string,
			(input: { readonly operation: unknown; readonly state: unknown }) => {
				readonly output: unknown;
				readonly state: unknown;
			}
		>
	>;
	readonly runtimeProfile: string;
}

/** A value does not satisfy the registered protocol-v3 vertex field contract. */
export class VertexValidationError extends TypeError {}

type BlueprintArgumentType = "canonical-object" | "safe-integer" | "string";

interface CompiledArgumentField {
	readonly name: string;
	readonly required: boolean;
	readonly type: BlueprintArgumentType;
}

interface CompiledOperationSchema {
	readonly allowedNames: ReadonlySet<string>;
	readonly fields: readonly CompiledArgumentField[];
}

interface PreparedBlueprintAdmissionState {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly discriminator: string;
	readonly operations: ReadonlyMap<string, CompiledOperationSchema>;
	readonly runtimeProfile: string;
}

interface CompiledBlueprintPackage {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly discriminator: string;
	readonly operations: ReadonlyMap<string, CompiledOperationSchema>;
	readonly runtimeProfile: string;
}

interface PreparedBlueprintRuntimeState {
	readonly admission: PreparedBlueprintAdmissionState;
	readonly exactArtifactBytes: Uint8Array;
	readonly namespace: object;
}

interface BlueprintArtifactProfile {
	readonly artifactDigestDomain: string;
	readonly runtimeProfile: string;
}

interface AuthenticatedReceivedVertex {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
}

const registry = registryJson as ProtocolRegistry;
const vertexRegistry = registry.kinds.vertex;
if (vertexRegistry === undefined) throw new Error("protocol-v3 registry is missing the vertex kind");

const VERTEX_DOMAIN = registry.domains.vertex;
if (VERTEX_DOMAIN === undefined || VERTEX_DOMAIN !== vertexRegistry.domain) {
	throw new Error("protocol-v3 registry has inconsistent vertex domains");
}

const identitySuite = registry.cryptoSuites.active.find(({ role }) => role === "identityAndVertex");
if (identitySuite === undefined) {
	throw new Error("protocol-v3 registry is missing the active identityAndVertex suite");
}

const VERTEX_SUITE_ID = identitySuite.suiteId;
const BLUEPRINT_ADMISSION_DOMAIN = "ts-drp/blueprint-admission/v3";
const textEncoder = new TextEncoder();
const blueprintArtifactProfile = compileBlueprintArtifactProfile(blueprintArtifactProfileJson);
const BLUEPRINT_ARTIFACT_DOMAIN = blueprintArtifactProfile.artifactDigestDomain;
const BLUEPRINT_RUNTIME_PROFILE = blueprintArtifactProfile.runtimeProfile;
const vertexFields = vertexRegistry.fields;
const vertexFieldNames = new Set(vertexFields.map(({ name }) => name));
const anchorFieldCandidate = vertexFields.find(({ name }) => name === "anchor");
if (anchorFieldCandidate === undefined) throw new Error("protocol-v3 vertex registry is missing anchor");
const anchorField: RegistryField = anchorFieldCandidate;

const preparedBlueprintAdmissions = new WeakMap<object, PreparedBlueprintAdmissionState>();
const preparedBlueprintRuntimes = new WeakMap<object, PreparedBlueprintRuntimeState>();

function ownDataProperty(input: Readonly<Record<string, unknown>>, name: string, context: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(input, name);
	if (descriptor === undefined) throw new TypeError(`${context}.${name} is required`);
	if (!Object.hasOwn(descriptor, "value")) {
		throw new TypeError(`${context}.${name} must be an own data property`);
	}
	return descriptor.value;
}

function assertClosedRecord(
	value: unknown,
	expectedKeys: readonly string[],
	context: string
): asserts value is Readonly<Record<string, unknown>> {
	if (!isPlainRecord(value)) throw new TypeError(`${context} must be a plain object`);
	const expected = new Set(expectedKeys);
	const keys = Reflect.ownKeys(value);
	if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
		throw new TypeError(`${context} must contain exactly ${expectedKeys.join(", ")}`);
	}
	for (const key of expectedKeys) ownDataProperty(value, key, context);
}

function assertNonEmptyString(value: unknown, context: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${context} must be a non-empty string`);
	}
	assertWellFormedString(value, context);
}

function assertClosedStringArray(value: unknown, context: string): asserts value is readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
	let previous: string | undefined;
	for (const entry of value) {
		assertNonEmptyString(entry, `${context} entry`);
		if (previous !== undefined && compareCodePointStrings(previous, entry) >= 0) {
			throw new TypeError(`${context} must contain unique strings in codepoint order`);
		}
		previous = entry;
	}
}

function compileBlueprintArtifactProfile(value: unknown): BlueprintArtifactProfile {
	assertClosedRecord(
		value,
		[
			"schemaVersion",
			"profileId",
			"protocolMajor",
			"artifactDigestDomain",
			"runtimeProfiles",
			"pureAllowlist",
			"frozenTuple",
		],
		"blueprint artifact profile"
	);
	if (
		ownDataProperty(value, "schemaVersion", "blueprint artifact profile") !== "ts-drp-blueprint-artifact-profile-v1" ||
		ownDataProperty(value, "profileId", "blueprint artifact profile") !== "ts-drp-blueprint-artifact-profile-v1" ||
		ownDataProperty(value, "protocolMajor", "blueprint artifact profile") !== 3
	) {
		throw new TypeError("blueprint artifact profile identity is unsupported");
	}
	const artifactDigestDomain = ownDataProperty(value, "artifactDigestDomain", "blueprint artifact profile");
	assertNonEmptyString(artifactDigestDomain, "blueprint artifact profile.artifactDigestDomain");
	const runtimeProfiles = ownDataProperty(value, "runtimeProfiles", "blueprint artifact profile");
	assertClosedStringArray(runtimeProfiles, "blueprint artifact profile.runtimeProfiles");
	if (runtimeProfiles.length !== 1) {
		throw new TypeError("blueprint artifact profile must define exactly one runtime profile");
	}

	const pureAllowlist = ownDataProperty(value, "pureAllowlist", "blueprint artifact profile");
	assertClosedRecord(pureAllowlist, ["identifiers", "mathMembers"], "blueprint artifact profile.pureAllowlist");
	assertClosedStringArray(
		ownDataProperty(pureAllowlist, "identifiers", "blueprint artifact profile.pureAllowlist"),
		"blueprint artifact profile.pureAllowlist.identifiers"
	);
	assertClosedStringArray(
		ownDataProperty(pureAllowlist, "mathMembers", "blueprint artifact profile.pureAllowlist"),
		"blueprint artifact profile.pureAllowlist.mathMembers"
	);
	const frozenTuple = ownDataProperty(value, "frozenTuple", "blueprint artifact profile");
	assertClosedRecord(
		frozenTuple,
		["checkpoint", "freezePolicyPath", "freezePolicySha256", "protectedPathCount", "protectedPathStatesSha256"],
		"blueprint artifact profile.frozenTuple"
	);
	assertNonEmptyString(
		ownDataProperty(frozenTuple, "checkpoint", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.checkpoint"
	);
	assertNonEmptyString(
		ownDataProperty(frozenTuple, "freezePolicyPath", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.freezePolicyPath"
	);
	assertDigestHexValue(
		ownDataProperty(frozenTuple, "freezePolicySha256", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.freezePolicySha256"
	);
	if (ownDataProperty(frozenTuple, "protectedPathCount", "blueprint artifact profile.frozenTuple") !== 47) {
		throw new TypeError("blueprint artifact profile.frozenTuple.protectedPathCount is unsupported");
	}
	assertDigestHexValue(
		ownDataProperty(frozenTuple, "protectedPathStatesSha256", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.protectedPathStatesSha256"
	);
	return Object.freeze({ artifactDigestDomain, runtimeProfile: runtimeProfiles[0] as string });
}

function assertDigestHexValue(value: unknown, context: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError(`${context} must be 32-byte lowercase digest hex`);
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function detachCanonicalRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const detached = decodeCanonical(encodeCanonical(value));
	if (!isPlainRecord(detached)) {
		throw new VertexValidationError("operation must be a canonical object");
	}
	return detached;
}

function assertWellFormedString(value: string, fieldName: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new VertexValidationError(`${fieldName} contains an unpaired surrogate`);
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new VertexValidationError(`${fieldName} contains an unpaired surrogate`);
		}
	}
}

function numericConstraint(field: RegistryField, name: string): number | undefined {
	const value = field.constraints[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new Error(`protocol-v3 registry ${field.name}.${name} must be a safe integer`);
	}
	return value;
}

function validateString(field: RegistryField, value: unknown): asserts value is string {
	if (typeof value !== "string") throw new VertexValidationError(`${field.name} must be a string`);
	assertWellFormedString(value, field.name);
	const minimum = numericConstraint(field, "minimumUtf16Units");
	const maximum = numericConstraint(field, "maximumUtf16Units");
	if (minimum !== undefined && value.length < minimum) {
		throw new VertexValidationError(`${field.name} is shorter than its registry minimum`);
	}
	if (maximum !== undefined && value.length > maximum) {
		throw new VertexValidationError(`${field.name} exceeds its registry maximum`);
	}
}

function validateSafeInteger(field: RegistryField, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new VertexValidationError(`${field.name} must be a safe integer`);
	}
	const minimum = numericConstraint(field, "minimum");
	const maximum = numericConstraint(field, "maximum");
	if (minimum !== undefined && value < minimum) {
		throw new VertexValidationError(`${field.name} is below its registry minimum`);
	}
	if (maximum !== undefined && value > maximum) {
		throw new VertexValidationError(`${field.name} exceeds its registry maximum`);
	}
}

function validateDigestHex(field: RegistryField, value: unknown): asserts value is string {
	if (typeof value !== "string") {
		throw new VertexValidationError(`${field.name} must be lowercase digest hex`);
	}
	const bytes = numericConstraint(field, "bytes");
	if (bytes === undefined) throw new Error(`protocol-v3 registry ${field.name} is missing digest width`);
	if (field.constraints.case !== "lower") {
		throw new Error(`protocol-v3 registry ${field.name} must require lowercase digest hex`);
	}
	if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value)) {
		throw new VertexValidationError(`${field.name} must be ${bytes}-byte lowercase digest hex`);
	}
}

function compareCodePointStrings(left: string, right: string): number {
	return compareBytes(textEncoder.encode(left), textEncoder.encode(right));
}

function validateDigestArray(
	field: RegistryField,
	value: unknown,
	requireRegisteredOrder: boolean
): asserts value is string[] {
	if (!Array.isArray(value)) throw new VertexValidationError(`${field.name} must be an array`);
	const minimumItems = numericConstraint(field, "minimumItems");
	if (minimumItems !== undefined && value.length < minimumItems) {
		throw new VertexValidationError(`${field.name} has fewer than its registry minimum items`);
	}

	const itemField: RegistryField = {
		name: `${field.name} item`,
		type: "digest-hex",
		const: null,
		constraints: { bytes: 32, case: "lower" },
		required: true,
		sortRule: null,
	};
	const seen = new Set<string>();
	for (const item of value) {
		validateDigestHex(itemField, item);
		if (seen.has(item)) throw new VertexValidationError(`${field.name} must be unique`);
		seen.add(item);
	}

	if (field.constraints.unique !== true) {
		throw new Error(`protocol-v3 registry ${field.name} must require uniqueness`);
	}
	if (field.sortRule !== "codepoint") {
		throw new Error(`protocol-v3 registry ${field.name} must use codepoint order`);
	}
	if (requireRegisteredOrder) {
		for (let index = 1; index < value.length; index++) {
			if (compareCodePointStrings(value[index - 1] as string, value[index] as string) >= 0) {
				throw new VertexValidationError(`${field.name} are not in registry order`);
			}
		}
	}
}

function validateField(field: RegistryField, value: unknown, requireRegisteredOrder: boolean): void {
	if (field.const !== null && !Object.is(value, field.const)) {
		throw new VertexValidationError(`${field.name} must equal registry constant ${String(field.const)}`);
	}

	switch (field.type) {
		case "string":
			validateString(field, value);
			return;
		case "safe-integer":
			validateSafeInteger(field, value);
			return;
		case "digest-hex":
			validateDigestHex(field, value);
			return;
		case "array<digest-hex>":
			validateDigestArray(field, value, requireRegisteredOrder);
			return;
		case "canonical-object":
			if (!isPlainRecord(value)) {
				throw new VertexValidationError(`${field.name} must be a canonical object`);
			}
			return;
		default:
			throw new Error(`unsupported protocol-v3 vertex field type ${field.type}`);
	}
}

function ownDataValue(
	input: Readonly<Record<string, unknown>>,
	field: RegistryField,
	allowConstantDefault: boolean
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(input, field.name);
	if (descriptor === undefined) {
		if (allowConstantDefault && field.const !== null) return field.const;
		throw new VertexValidationError(`${field.name} is required`);
	}
	if (!Object.hasOwn(descriptor, "value")) {
		throw new VertexValidationError(`${field.name} must be an own data property`);
	}
	return descriptor.value;
}

function registeredVertex(
	input: unknown,
	options: {
		readonly allowConstantDefaults: boolean;
		readonly rejectUnknownFields: boolean;
		readonly requireRegisteredOrder: boolean;
		readonly sortRegisteredArrays: boolean;
	}
): Readonly<Record<string, unknown>> {
	if (!isPlainRecord(input)) throw new VertexValidationError("vertex preimage must be a plain object");
	if (Object.getOwnPropertySymbols(input).length !== 0) {
		throw new VertexValidationError("vertex preimage cannot contain symbol fields");
	}
	if (options.rejectUnknownFields) {
		for (const key of Object.keys(input)) {
			if (!vertexFieldNames.has(key)) {
				throw new VertexValidationError(`vertex preimage contains unregistered field ${key}`);
			}
		}
	}

	const output: Record<string, unknown> = {};
	for (const field of vertexFields) {
		const value = ownDataValue(input, field, options.allowConstantDefaults);
		validateField(field, value, options.requireRegisteredOrder);
		output[field.name] =
			options.sortRegisteredArrays && field.sortRule === "codepoint"
				? [...(value as string[])].sort(compareCodePointStrings)
				: value;
	}
	return output;
}

function compileArgumentField(value: unknown, context: string): CompiledArgumentField {
	assertClosedRecord(value, ["name", "required", "type"], context);
	const name = ownDataProperty(value, "name", context);
	const required = ownDataProperty(value, "required", context);
	const type = ownDataProperty(value, "type", context);
	assertNonEmptyString(name, `${context}.name`);
	if (typeof required !== "boolean") throw new TypeError(`${context}.required must be a boolean`);
	if (type !== "canonical-object" && type !== "safe-integer" && type !== "string") {
		throw new TypeError(`${context}.type is unsupported`);
	}
	return Object.freeze({ name, required, type });
}

function compileOperation(
	value: unknown,
	discriminator: string,
	previousOperationName: string | undefined,
	context: string
): readonly [string, CompiledOperationSchema] {
	assertClosedRecord(value, ["name", "argumentSchema"], context);
	const name = ownDataProperty(value, "name", context);
	const argumentSchema = ownDataProperty(value, "argumentSchema", context);
	assertNonEmptyString(name, `${context}.name`);
	if (previousOperationName !== undefined && compareCodePointStrings(previousOperationName, name) >= 0) {
		throw new TypeError("blueprint manifest operations must have unique names in codepoint order");
	}
	assertClosedRecord(argumentSchema, ["kind", "fields"], `${context}.argumentSchema`);
	if (ownDataProperty(argumentSchema, "kind", `${context}.argumentSchema`) !== "closed-record") {
		throw new TypeError(`${context}.argumentSchema.kind must be closed-record`);
	}
	const fields = ownDataProperty(argumentSchema, "fields", `${context}.argumentSchema`);
	if (!Array.isArray(fields)) throw new TypeError(`${context}.argumentSchema.fields must be an array`);

	const compiledFields: CompiledArgumentField[] = [];
	let previousFieldName: string | undefined;
	for (let index = 0; index < fields.length; index++) {
		const compiled = compileArgumentField(fields[index], `${context}.argumentSchema.fields[${index}]`);
		if (compiled.name === discriminator) {
			throw new TypeError(`${context} cannot redeclare the operation discriminator`);
		}
		if (previousFieldName !== undefined && compareCodePointStrings(previousFieldName, compiled.name) >= 0) {
			throw new TypeError(`${context} argument fields must have unique names in codepoint order`);
		}
		compiledFields.push(compiled);
		previousFieldName = compiled.name;
	}
	const allowedNames = new Set<string>([discriminator, ...compiledFields.map((field) => field.name)]);
	return Object.freeze([
		name,
		Object.freeze({
			allowedNames,
			fields: Object.freeze(compiledFields),
		}),
	]);
}

function compileBlueprintPackage(value: unknown): CompiledBlueprintPackage {
	assertClosedRecord(
		value,
		["kind", "protocolMajor", "schemaVersion", "implementation", "manifest"],
		"blueprint package"
	);
	if (ownDataProperty(value, "kind", "blueprint package") !== "drp-blueprint-admission-package") {
		throw new TypeError("blueprint package.kind is unsupported");
	}
	if (ownDataProperty(value, "protocolMajor", "blueprint package") !== 3) {
		throw new TypeError("blueprint package.protocolMajor must be 3");
	}
	if (ownDataProperty(value, "schemaVersion", "blueprint package") !== 1) {
		throw new TypeError("blueprint package.schemaVersion must be 1");
	}

	const implementation = ownDataProperty(value, "implementation", "blueprint package");
	assertClosedRecord(
		implementation,
		["artifactId", "artifactDigest", "runtimeProfile"],
		"blueprint package.implementation"
	);
	const artifactId = ownDataProperty(implementation, "artifactId", "blueprint package.implementation");
	const artifactDigest = ownDataProperty(implementation, "artifactDigest", "blueprint package.implementation");
	const runtimeProfile = ownDataProperty(implementation, "runtimeProfile", "blueprint package.implementation");
	assertNonEmptyString(artifactId, "blueprint package.implementation.artifactId");
	assertDigestHexValue(artifactDigest, "blueprint package.implementation.artifactDigest");
	assertNonEmptyString(runtimeProfile, "blueprint package.implementation.runtimeProfile");

	const manifest = ownDataProperty(value, "manifest", "blueprint package");
	assertClosedRecord(manifest, ["schemaVersion", "operationDiscriminator", "operations"], "blueprint package.manifest");
	if (ownDataProperty(manifest, "schemaVersion", "blueprint package.manifest") !== 1) {
		throw new TypeError("blueprint package.manifest.schemaVersion must be 1");
	}
	const discriminator = ownDataProperty(manifest, "operationDiscriminator", "blueprint package.manifest");
	assertNonEmptyString(discriminator, "blueprint package.manifest.operationDiscriminator");
	const operations = ownDataProperty(manifest, "operations", "blueprint package.manifest");
	if (!Array.isArray(operations) || operations.length === 0) {
		throw new TypeError("blueprint package.manifest.operations must be a non-empty array");
	}

	const compiledOperations = new Map<string, CompiledOperationSchema>();
	let previousOperationName: string | undefined;
	for (let index = 0; index < operations.length; index++) {
		const [name, schema] = compileOperation(
			operations[index],
			discriminator,
			previousOperationName,
			`blueprint package.manifest.operations[${index}]`
		);
		compiledOperations.set(name, schema);
		previousOperationName = name;
	}
	return Object.freeze({
		artifactDigest,
		artifactId,
		discriminator,
		operations: compiledOperations,
		runtimeProfile,
	});
}

function preparedAdmissionState(value: unknown): PreparedBlueprintAdmissionState | undefined {
	return value !== null && typeof value === "object" ? preparedBlueprintAdmissions.get(value) : undefined;
}

function consumerPreparedAdmissionState(input: object): PreparedBlueprintAdmissionState | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(input, "preparedBlueprintAdmission");
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
	return preparedAdmissionState(descriptor.value);
}

function operationMatchesPreparedAdmission(operation: unknown, state: PreparedBlueprintAdmissionState): boolean {
	if (!isPlainRecord(operation) || Object.getOwnPropertySymbols(operation).length !== 0) return false;
	const discriminatorDescriptor = Object.getOwnPropertyDescriptor(operation, state.discriminator);
	if (
		discriminatorDescriptor === undefined ||
		!Object.hasOwn(discriminatorDescriptor, "value") ||
		typeof discriminatorDescriptor.value !== "string"
	) {
		return false;
	}
	const schema = state.operations.get(discriminatorDescriptor.value);
	if (schema === undefined) return false;

	const keys = Reflect.ownKeys(operation);
	if (keys.some((key) => typeof key !== "string" || !schema.allowedNames.has(key))) return false;

	for (const field of schema.fields) {
		const descriptor = Object.getOwnPropertyDescriptor(operation, field.name);
		if (descriptor === undefined) {
			if (field.required) return false;
			continue;
		}
		if (!Object.hasOwn(descriptor, "value")) return false;
		switch (field.type) {
			case "canonical-object":
				if (!isPlainRecord(descriptor.value)) return false;
				break;
			case "safe-integer":
				if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)) return false;
				break;
			case "string":
				if (typeof descriptor.value !== "string") return false;
				try {
					assertWellFormedString(descriptor.value, field.name);
				} catch {
					return false;
				}
				break;
		}
	}
	return true;
}

/**
 * Prepares an unforgeable admission capability from exact canonical package bytes.
 * @param input - Canonical package bytes and the digest proven by the caller.
 * @returns A capability accepted by admitReceivedVertex and createAdmissionBoundTransactionalVertexIssuer.
 */
export function prepareBlueprintAdmission(input: BlueprintPreparationInput): PreparedBlueprintAdmission {
	assertClosedRecord(
		input,
		["canonicalBlueprintPackageBytes", "expectedBlueprintDigest"],
		"blueprint preparation input"
	);
	const suppliedBytes = ownDataProperty(input, "canonicalBlueprintPackageBytes", "blueprint preparation input");
	const expectedBlueprintDigest = ownDataProperty(input, "expectedBlueprintDigest", "blueprint preparation input");
	if (!(suppliedBytes instanceof Uint8Array)) {
		throw new TypeError("canonicalBlueprintPackageBytes must be a Uint8Array");
	}
	assertDigestHexValue(expectedBlueprintDigest, "expectedBlueprintDigest");

	const canonicalBlueprintPackageBytes = new Uint8Array(suppliedBytes);
	const decoded = decodeCanonical(canonicalBlueprintPackageBytes);
	const reencoded = encodeCanonical(decoded);
	if (compareBytes(reencoded, canonicalBlueprintPackageBytes) !== 0) {
		throw new TypeError("blueprint package bytes must use the canonical encoding");
	}
	const actualBlueprintDigest = bytesToHex(hashDomain(BLUEPRINT_ADMISSION_DOMAIN, canonicalBlueprintPackageBytes));
	if (actualBlueprintDigest !== expectedBlueprintDigest) {
		throw new TypeError("blueprint package digest does not match expectedBlueprintDigest");
	}

	const compiled = compileBlueprintPackage(decoded);
	const prepared = Object.freeze({ blueprintDigest: actualBlueprintDigest });
	preparedBlueprintAdmissions.set(
		prepared,
		Object.freeze({
			...compiled,
			blueprintDigest: actualBlueprintDigest,
			canonicalBlueprintPackageBytes,
		})
	);
	return prepared;
}

function bytesToBase64(bytes: Uint8Array): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
		output += alphabet[(packed >>> 18) & 0x3f];
		output += alphabet[(packed >>> 12) & 0x3f];
		output += second === undefined ? "=" : alphabet[(packed >>> 6) & 0x3f];
		output += third === undefined ? "=" : alphabet[packed & 0x3f];
	}
	return output;
}

function assertSamePreparedPackage(
	actualBlueprintDigest: string,
	canonicalBlueprintPackageBytes: Uint8Array,
	compiled: CompiledBlueprintPackage,
	prepared: PreparedBlueprintAdmissionState,
	expectedBlueprintDigest: string
): void {
	if (
		actualBlueprintDigest !== expectedBlueprintDigest ||
		actualBlueprintDigest !== prepared.blueprintDigest ||
		compareBytes(canonicalBlueprintPackageBytes, prepared.canonicalBlueprintPackageBytes) !== 0 ||
		compiled.artifactDigest !== prepared.artifactDigest ||
		compiled.artifactId !== prepared.artifactId ||
		compiled.runtimeProfile !== prepared.runtimeProfile
	) {
		throw new TypeError("blueprint package does not match the prepared admission capability");
	}
}

function prepareReducerTable(
	value: unknown,
	expectedOperationNames: readonly string[]
): PreparedBlueprintRuntime["reducers"] {
	assertClosedRecord(value, expectedOperationNames, "blueprint export.reducers");
	const prepared = Object.create(null) as Record<string, (...arguments_: readonly unknown[]) => unknown>;
	for (const name of expectedOperationNames) {
		const reducer = ownDataProperty(value, name, "blueprint export.reducers");
		if (typeof reducer !== "function" || Object.getPrototypeOf(reducer) !== Function.prototype) {
			throw new TypeError(`blueprint export.reducers.${name} must be a synchronous non-generator function`);
		}
		prepared[name] = reducer as (...arguments_: readonly unknown[]) => unknown;
	}
	return Object.freeze(prepared) as PreparedBlueprintRuntime["reducers"];
}

function prepareRuntimeExport(
	namespace: Readonly<Record<string, unknown>>,
	expectedOperationNames: readonly string[],
	compiled: CompiledBlueprintPackage
): PreparedBlueprintRuntime["reducers"] {
	const namespaceKeys = Object.getOwnPropertyNames(namespace);
	if (namespaceKeys.length !== 1 || namespaceKeys[0] !== "blueprint") {
		throw new TypeError("blueprint artifact must export only blueprint");
	}
	const envelope = ownDataProperty(namespace, "blueprint", "blueprint artifact namespace");
	assertClosedRecord(envelope, ["exportSchemaVersion", "artifactId", "runtimeProfile", "reducers"], "blueprint export");
	if (ownDataProperty(envelope, "exportSchemaVersion", "blueprint export") !== 1) {
		throw new TypeError("blueprint export.exportSchemaVersion must be 1");
	}
	if (ownDataProperty(envelope, "artifactId", "blueprint export") !== compiled.artifactId) {
		throw new TypeError("blueprint export.artifactId does not match the canonical package");
	}
	if (ownDataProperty(envelope, "runtimeProfile", "blueprint export") !== compiled.runtimeProfile) {
		throw new TypeError("blueprint export.runtimeProfile does not match the canonical package");
	}
	return prepareReducerTable(ownDataProperty(envelope, "reducers", "blueprint export"), expectedOperationNames);
}

/**
 * Prepares a runtime capability from a genuine admission capability, its exact
 * canonical package bytes, and the exact self-contained ESM artifact bytes.
 *
 * Both byte arrays are copied before the first asynchronous boundary. The
 * package digest, known runtime profile, artifact digest, UTF-8 source, import
 * closure and export shape are then checked in that order before reducers are
 * exposed. Reducers are never invoked by this preparation step.
 * @param input - The closed package-owned runtime preparation input.
 * @returns A distinct runtime capability carrying exact-byte provenance.
 */
export async function prepareBlueprintRuntime(
	input: BlueprintRuntimePreparationInput
): Promise<PreparedBlueprintRuntime> {
	assertClosedRecord(
		input,
		["preparedBlueprintAdmission", "canonicalBlueprintPackageBytes", "expectedBlueprintDigest", "exactArtifactBytes"],
		"blueprint runtime preparation input"
	);
	const preparedBlueprintAdmission = ownDataProperty(
		input,
		"preparedBlueprintAdmission",
		"blueprint runtime preparation input"
	);
	const suppliedPackageBytes = ownDataProperty(
		input,
		"canonicalBlueprintPackageBytes",
		"blueprint runtime preparation input"
	);
	const expectedBlueprintDigest = ownDataProperty(
		input,
		"expectedBlueprintDigest",
		"blueprint runtime preparation input"
	);
	const suppliedArtifactBytes = ownDataProperty(input, "exactArtifactBytes", "blueprint runtime preparation input");
	if (!(suppliedPackageBytes instanceof Uint8Array)) {
		throw new TypeError("canonicalBlueprintPackageBytes must be a Uint8Array");
	}
	if (!(suppliedArtifactBytes instanceof Uint8Array)) {
		throw new TypeError("exactArtifactBytes must be a Uint8Array");
	}
	assertDigestHexValue(expectedBlueprintDigest, "expectedBlueprintDigest");

	const canonicalBlueprintPackageBytes = new Uint8Array(suppliedPackageBytes);
	const exactArtifactBytes = new Uint8Array(suppliedArtifactBytes);
	const preparedAdmission = preparedAdmissionState(preparedBlueprintAdmission);
	if (preparedAdmission === undefined) {
		throw new TypeError("preparedBlueprintAdmission must be produced by prepareBlueprintAdmission");
	}

	const decodedPackage = decodeCanonical(canonicalBlueprintPackageBytes);
	const reencodedPackage = encodeCanonical(decodedPackage);
	if (compareBytes(reencodedPackage, canonicalBlueprintPackageBytes) !== 0) {
		throw new TypeError("blueprint package bytes must use the canonical encoding");
	}
	const actualBlueprintDigest = bytesToHex(hashDomain(BLUEPRINT_ADMISSION_DOMAIN, canonicalBlueprintPackageBytes));
	const compiled = compileBlueprintPackage(decodedPackage);
	assertSamePreparedPackage(
		actualBlueprintDigest,
		canonicalBlueprintPackageBytes,
		compiled,
		preparedAdmission,
		expectedBlueprintDigest
	);

	if (compiled.runtimeProfile !== BLUEPRINT_RUNTIME_PROFILE) {
		throw new TypeError(`unsupported blueprint runtime profile: ${compiled.runtimeProfile}`);
	}
	const actualArtifactDigest = bytesToHex(hashDomain(BLUEPRINT_ARTIFACT_DOMAIN, exactArtifactBytes));
	if (actualArtifactDigest !== compiled.artifactDigest) {
		throw new TypeError("blueprint artifact digest does not match the canonical package");
	}
	if (exactArtifactBytes[0] === 0xef && exactArtifactBytes[1] === 0xbb && exactArtifactBytes[2] === 0xbf) {
		throw new TypeError("blueprint artifact must not begin with a UTF-8 BOM");
	}
	const source = new TextDecoder("utf-8", { fatal: true }).decode(exactArtifactBytes);

	await initializeModuleLexer;
	const [imports, exports] = parseModule(source);
	if (imports.length !== 0) {
		throw new TypeError("blueprint artifact imports and import.meta are forbidden");
	}
	if (exports.length !== 1 || exports[0]?.n !== "blueprint") {
		throw new TypeError("blueprint artifact must declare only the blueprint export");
	}

	const exactByteUrl = `data:text/javascript;base64,${bytesToBase64(exactArtifactBytes)}`;
	const namespace = (await import(exactByteUrl)) as Readonly<Record<string, unknown>>;
	const operationNames = [...preparedAdmission.operations.keys()];
	const reducers = prepareRuntimeExport(namespace, operationNames, compiled);
	const prepared = Object.freeze({
		artifactDigest: actualArtifactDigest,
		artifactId: compiled.artifactId,
		blueprintDigest: actualBlueprintDigest,
		reducers,
		runtimeProfile: compiled.runtimeProfile,
	});
	preparedBlueprintRuntimes.set(
		prepared,
		Object.freeze({
			admission: preparedAdmission,
			exactArtifactBytes,
			namespace,
		})
	);
	return prepared;
}

/**
 * Derives the registry-v1 signed vertex field set in review order.
 *
 * Canonical object key order remains owned by `@ts-drp/canonical`; registry
 * order controls field selection and review only.
 * @param input - Candidate vertex fields.
 * @returns The validated registered field set in registry review order.
 */
export function vertexPreimage(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return registeredVertex(input, {
		allowConstantDefaults: true,
		rejectUnknownFields: false,
		requireRegisteredOrder: false,
		sortRegisteredArrays: true,
	});
}

/**
 * Encodes one validated registry-v1 vertex preimage.
 * @param input - Candidate vertex fields.
 * @returns Frozen-profile canonical bytes.
 */
export function vertexCanonicalBytes(input: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical(vertexPreimage(input));
}

/**
 * Computes the registered v3 vertex digest from a locally built preimage.
 * @param input - Candidate vertex fields.
 * @returns The registered 32-byte digest.
 */
export function vertexDigest(input: Readonly<Record<string, unknown>>): Uint8Array {
	return digestReceivedVertexPreimage(vertexCanonicalBytes(input));
}

/**
 * Hashes the exact supplied bytes using the registry-selected v3 vertex domain.
 * @param receivedCanonicalPreimageBytes - Exact received or locally encoded preimage bytes.
 * @returns The registered 32-byte digest.
 */
export function digestReceivedVertexPreimage(receivedCanonicalPreimageBytes: Uint8Array): Uint8Array {
	if (!(receivedCanonicalPreimageBytes instanceof Uint8Array)) {
		throw new TypeError("receivedCanonicalPreimageBytes must be a Uint8Array");
	}
	return hashDomain(VERTEX_DOMAIN, receivedCanonicalPreimageBytes);
}

/**
 * Verifies an Ed25519 signature under the protocol-v3 acceptance profile.
 *
 * The message is the raw registered digest, not its hexadecimal text or a
 * wrapper object. Shape errors and invalid encodings fail closed.
 * @param signature - The 64-byte `R || S` Ed25519 signature.
 * @param rawRegisteredDigest - The exact 32-byte registered digest.
 * @param publicKey - The 32-byte compressed Edwards-y public key.
 * @returns Whether noble 2.2.0 strict verification accepts the tuple.
 */
export function verifyEd25519RegisteredDigest(
	signature: Uint8Array,
	rawRegisteredDigest: Uint8Array,
	publicKey: Uint8Array
): boolean {
	if (
		!(signature instanceof Uint8Array) ||
		signature.byteLength !== 64 ||
		!(rawRegisteredDigest instanceof Uint8Array) ||
		rawRegisteredDigest.byteLength !== 32 ||
		!(publicKey instanceof Uint8Array) ||
		publicKey.byteLength !== 32
	) {
		return false;
	}

	try {
		return ed25519.verify(signature, rawRegisteredDigest, publicKey, { zip215: false });
	} catch {
		return false;
	}
}

/**
 * Creates a local v3 issuer over one injected transaction boundary.
 *
 * Sequence selection, atomic commit and durable storage remain owned by the
 * injected coordinator. The issuer only snapshots the request, builds the
 * registered bytes for the coordinator-selected ordinal and signs their exact
 * registered digest.
 * @param options - Author key material and transaction coordinator.
 * @returns A stateless transactional issuer.
 */
export function createTransactionalVertexIssuer(options: TransactionalIssuerOptions): TransactionalVertexIssuer {
	return createTransactionalVertexIssuerCore(options);
}

function createTransactionalVertexIssuerCore(
	options: TransactionalIssuerOptions,
	operationAdmission?: (operation: Readonly<Record<string, unknown>>) => boolean
): TransactionalVertexIssuer {
	if (!(options.privateKeySeed instanceof Uint8Array) || options.privateKeySeed.byteLength !== 32) {
		throw new TypeError("private key seed must be a 32-byte Uint8Array");
	}
	if (
		options.publicKey.format !== "raw" ||
		!(options.publicKey.bytes instanceof Uint8Array) ||
		options.publicKey.bytes.byteLength !== 32
	) {
		throw new TypeError("public key must be a 32-byte raw Ed25519 key");
	}
	if (typeof options.transactIssue !== "function") {
		throw new TypeError("transactIssue must be a function");
	}

	const privateKeySeed = new Uint8Array(options.privateKeySeed);
	const publicKeyBytes = new Uint8Array(options.publicKey.bytes);
	if (compareBytes(ed25519.getPublicKey(privateKeySeed), publicKeyBytes) !== 0) {
		throw new TypeError("public and private Ed25519 keys do not match");
	}

	const author = options.author;
	const transactIssue = options.transactIssue;

	return {
		async issue(input: LocalVertexInput): Promise<IssueCommit> {
			if (operationAdmission !== undefined && !operationAdmission(input.operation)) {
				throw new VertexValidationError("operation does not match the prepared blueprint ABI");
			}
			const operation = detachCanonicalRecord(input.operation);
			if (operationAdmission !== undefined && !operationAdmission(operation)) {
				throw new VertexValidationError("operation does not match the prepared blueprint ABI");
			}
			const detachedInput: LocalVertexInput = {
				anchor: input.anchor,
				dependencies: [...input.dependencies],
				epoch: input.epoch,
				logicalTime: input.logicalTime,
				objectId: input.objectId,
				operation,
			};
			const scope: IssueScope = { author, objectId: detachedInput.objectId };

			return transactIssue(scope, (authorSequence) => {
				const canonicalPreimageBytes = vertexCanonicalBytes({
					kind: "drp-vertex",
					protocolMajor: 3,
					objectId: detachedInput.objectId,
					epoch: detachedInput.epoch,
					anchor: detachedInput.anchor,
					author,
					authorSequence,
					logicalTime: detachedInput.logicalTime,
					dependencies: detachedInput.dependencies,
					operation: detachedInput.operation,
				});
				const digest = digestReceivedVertexPreimage(canonicalPreimageBytes);
				const envelope: SignedVertexEnvelope = {
					canonicalPreimageBytes,
					digest,
					signature: ed25519.sign(digest, privateKeySeed),
				};

				return Promise.resolve({
					authorSequence,
					envelope,
					issuedRecord: { authorSequence, envelope, scope },
					outboxEntry: { authorSequence, envelope, scope },
				});
			});
		},
	};
}

/**
 * Creates an application issuer bound to a genuine prepared blueprint admission.
 *
 * Both the caller-provided operation and its canonical detached copy must match
 * the prepared ABI before the transaction coordinator is entered.
 * @param options - Prepared admission, author key material and transaction coordinator.
 * @returns A stateless admission-bound transactional issuer.
 */
export function createAdmissionBoundTransactionalVertexIssuer(
	options: AdmissionBoundTransactionalIssuerOptions
): TransactionalVertexIssuer {
	const preparedState = consumerPreparedAdmissionState(options);
	if (preparedState === undefined) {
		throw new TypeError("preparedBlueprintAdmission must be produced by prepareBlueprintAdmission");
	}
	return createTransactionalVertexIssuerCore(options, (operation) =>
		operationMatchesPreparedAdmission(operation, preparedState)
	);
}

function authenticateReceivedVertex(input: VerifyReceivedVertexInput): AuthenticatedReceivedVertex | undefined {
	if (
		input === null ||
		typeof input !== "object" ||
		input.domain !== VERTEX_DOMAIN ||
		input.suiteId !== VERTEX_SUITE_ID ||
		!(input.receivedCanonicalPreimageBytes instanceof Uint8Array) ||
		!(input.signature instanceof Uint8Array) ||
		input.signature.byteLength !== 64 ||
		typeof input.resolveAuthorPublicKey !== "function"
	) {
		return undefined;
	}

	try {
		validateDigestHex(anchorField, input.expectedAnchor);
		const decoded = decodeCanonical(input.receivedCanonicalPreimageBytes);
		const preimage = registeredVertex(decoded, {
			allowConstantDefaults: false,
			rejectUnknownFields: true,
			requireRegisteredOrder: true,
			sortRegisteredArrays: false,
		});
		if (preimage.anchor !== input.expectedAnchor) return undefined;

		const digest = digestReceivedVertexPreimage(input.receivedCanonicalPreimageBytes);
		const author = preimage.author;
		if (typeof author !== "string") return undefined;
		const publicKey = input.resolveAuthorPublicKey(author);
		if (publicKey?.format !== "raw" || !(publicKey.bytes instanceof Uint8Array) || publicKey.bytes.byteLength !== 32) {
			return undefined;
		}

		if (!verifyEd25519RegisteredDigest(input.signature, digest, publicKey.bytes)) {
			return undefined;
		}
		return { digest, preimage };
	} catch {
		return undefined;
	}
}

/**
 * Verifies a received v3 vertex without ever substituting re-encoded bytes.
 *
 * Domain, suite, signature shape, canonical syntax, registered fields and
 * anchor scope all fail closed before author-key resolution.
 * @param input - Received bytes, signature, expected scope and author-key resolver.
 * @returns Acceptance and, on success, the exact-received-byte digest.
 */
export function verifyReceivedVertex(input: VerifyReceivedVertexInput): RegisteredVertexVerification {
	const authenticated = authenticateReceivedVertex(input);
	return authenticated === undefined ? { accepted: false } : { accepted: true, digest: authenticated.digest };
}

/**
 * Authenticates exact received bytes and then applies a genuine prepared ABI.
 * @param input - Received vertex data and prepared application admission.
 * @returns Admission and, on success, the exact-received-byte digest.
 */
export function admitReceivedVertex(input: AdmitReceivedVertexInput): AdmissionDecision {
	const authenticated = authenticateReceivedVertex(input);
	if (authenticated === undefined) return { admitted: false };
	const preparedState = consumerPreparedAdmissionState(input);
	if (
		preparedState === undefined ||
		!operationMatchesPreparedAdmission(authenticated.preimage.operation, preparedState)
	) {
		return { admitted: false };
	}
	return { admitted: true, digest: authenticated.digest };
}
