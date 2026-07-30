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

export interface EquivocationScope {
	readonly author: string;
	readonly authorSequence: number;
	readonly objectId: string;
}

export interface PersistedVertexWitness {
	readonly digest: Uint8Array;
	readonly witness: Omit<VerifyReceivedVertexInput, "resolveAuthorPublicKey">;
}

export interface PersistedEquivocationProof {
	readonly canonicalProofBytes: Uint8Array;
	readonly proofId: string;
}

export interface MaterializeCurrentEquivocationProofInput {
	readonly scope: EquivocationScope;
	readonly vertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

export interface AuthorProjectionSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

export interface PendingEquivocationPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
	readonly pairId: string;
}

export interface DurableAuthorProjectionState {
	readonly slots: readonly AuthorProjectionSlot[];
	readonly pending: readonly PendingEquivocationPair[];
}

export interface AuthorProjectionDecision<Result> {
	readonly state: DurableAuthorProjectionState;
	readonly result: Result;
}

export interface DurableAuthorEquivocationProjectionOptions {
	readCommittedSlotState(scope: EquivocationScope): Promise<PersistedEquivocationState>;
	enumerateCommittedAuthorSlots(author: string): Promise<readonly EquivocationScope[]>;
	transactAuthorProjection<Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result>;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	handoffProof(proof: PersistedEquivocationProof): Promise<void>;
}

export interface ReconcileAuthorProjectionResult {
	readonly enqueuedPairIds: readonly string[];
	readonly newDigestCount: number;
}

export interface RecoverAuthorProjectionResult {
	readonly reconciledSlotCount: number;
}

export interface DrainAuthorProjectionResult {
	readonly handedOff: boolean;
	readonly remainingPending: number;
}

export interface DurableAuthorEquivocationProjection {
	reconcile(scope: EquivocationScope): Promise<ReconcileAuthorProjectionResult>;
	recover(author: string): Promise<RecoverAuthorProjectionResult>;
	drainOne(author: string): Promise<DrainAuthorProjectionResult>;
}

export interface SlotAdvisorySignal {
	readonly author: string;
	readonly observedForkCount: number;
	readonly advisoryLimitReached: boolean;
	readonly withinAdvisoryLimitProofCount: number;
	readonly overAdvisoryLimitProofCount: number;
}

export interface EquivocationResolution {
	readonly orderedDigests: readonly string[];
	readonly preferredDigest: string;
}

export interface PersistedEquivocationState {
	readonly proofs: readonly PersistedEquivocationProof[];
	readonly slotSignal: SlotAdvisorySignal;
	readonly vertices: readonly PersistedVertexWitness[];
}

export interface RemoteObservationResult {
	readonly admitted: boolean;
	readonly disposition: "duplicate" | "equivocation" | "invalid" | "new";
	readonly digest?: Uint8Array;
	readonly newlyPersistedProofIds: readonly string[];
	readonly resolution?: EquivocationResolution;
	readonly slotSignal?: SlotAdvisorySignal;
}

export interface EquivocationTransactionDecision {
	readonly result: RemoteObservationResult;
	readonly state: PersistedEquivocationState;
}

export type ApplyEquivocationPolicy = (state: PersistedEquivocationState) => EquivocationTransactionDecision;

export type TransactObservation = (
	scope: EquivocationScope,
	apply: ApplyEquivocationPolicy
) => Promise<RemoteObservationResult>;

export interface RemoteEquivocationObserver {
	observe(input: VerifyReceivedVertexInput): Promise<RemoteObservationResult>;
}

export interface RemoteEquivocationObserverOptions {
	readonly perSlotAdvisoryProofLimit: number;
	readonly transactObservation: TransactObservation;
}

export interface VerifyEquivocationProofInput {
	readonly canonicalProofBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

export interface EquivocationProofVerification {
	readonly digests?: readonly [string, string];
	readonly proofId?: string;
	readonly scope?: EquivocationScope;
	readonly verified: boolean;
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
const EQUIVOCATION_PROFILE_ID = "equivocation-digest-identity-v1";
const EQUIVOCATION_PROOF_KIND = "drp-equivocation-proof";
const EQUIVOCATION_PROOF_DOMAIN = "ts-drp/equivocation-proof/v1";
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

function detachPersistedVertex(vertex: PersistedVertexWitness): PersistedVertexWitness {
	if (vertex === null || typeof vertex !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const digest = vertex.digest;
	const witness = vertex.witness;
	if (witness === null || typeof witness !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const domain = witness.domain;
	const expectedAnchor = witness.expectedAnchor;
	const receivedCanonicalPreimageBytes = witness.receivedCanonicalPreimageBytes;
	const signature = witness.signature;
	const suiteId = witness.suiteId;
	if (
		!(digest instanceof Uint8Array) ||
		digest.byteLength !== 32 ||
		typeof domain !== "string" ||
		typeof expectedAnchor !== "string" ||
		!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
		!(signature instanceof Uint8Array) ||
		signature.byteLength !== 64 ||
		typeof suiteId !== "string"
	) {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	return {
		digest: new Uint8Array(digest),
		witness: {
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
			signature: new Uint8Array(signature),
			suiteId,
		},
	};
}

function canonicalWitnessBytes(vertex: PersistedVertexWitness): Uint8Array {
	return encodeCanonical({
		domain: vertex.witness.domain,
		expectedAnchor: vertex.witness.expectedAnchor,
		preimage: vertex.witness.receivedCanonicalPreimageBytes,
		signature: vertex.witness.signature,
		suiteId: vertex.witness.suiteId,
	});
}

function proofIdForDigests(left: Uint8Array, right: Uint8Array): string {
	const [first, second] = compareBytes(left, right) < 0 ? [left, right] : [right, left];
	return bytesToHex(hashDomain(EQUIVOCATION_PROOF_DOMAIN, first, second));
}

/**
 * Derives the frozen proof identity for an unordered pair of distinct digests.
 * @param leftDigest - One registered 32-byte vertex digest.
 * @param rightDigest - The other registered 32-byte vertex digest.
 * @returns The lowercase hexadecimal proof identity.
 */
export function deriveEquivocationProofId(leftDigest: Uint8Array, rightDigest: Uint8Array): string {
	if (!(leftDigest instanceof Uint8Array) || !(rightDigest instanceof Uint8Array)) {
		throw new TypeError("equivocation proof digests must be Uint8Array values");
	}
	const left = new Uint8Array(leftDigest);
	const right = new Uint8Array(rightDigest);
	if (left.byteLength !== 32 || right.byteLength !== 32) {
		throw new TypeError("equivocation proof digests must each be 32 bytes");
	}
	if (compareBytes(left, right) === 0) {
		throw new TypeError("equivocation proof digests must be distinct");
	}
	return proofIdForDigests(left, right);
}

function canonicalEquivocationProof(
	scope: EquivocationScope,
	left: PersistedVertexWitness,
	right: PersistedVertexWitness
): PersistedEquivocationProof {
	const [first, second] = compareBytes(left.digest, right.digest) < 0 ? [left, right] : [right, left];
	return {
		canonicalProofBytes: encodeCanonical({
			kind: EQUIVOCATION_PROOF_KIND,
			profile: EQUIVOCATION_PROFILE_ID,
			protocolMajor: 3,
			slot: scope,
			vertices: [first, second].map((vertex) => ({
				digest: vertex.digest,
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				preimage: vertex.witness.receivedCanonicalPreimageBytes,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			})),
		}),
		proofId: proofIdForDigests(first.digest, second.digest),
	};
}

function detachCurrentEquivocationVertex(value: unknown): PersistedVertexWitness | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as PersistedVertexWitness;
	const capturedDigest = candidate.digest;
	if (!(capturedDigest instanceof Uint8Array)) return undefined;
	const digest = new Uint8Array(capturedDigest);
	if (digest.byteLength !== 32) return undefined;

	const capturedWitness = candidate.witness;
	if (capturedWitness === null || typeof capturedWitness !== "object") return undefined;
	const domain = capturedWitness.domain;
	const expectedAnchor = capturedWitness.expectedAnchor;
	const capturedPreimage = capturedWitness.receivedCanonicalPreimageBytes;
	if (!(capturedPreimage instanceof Uint8Array)) return undefined;
	const receivedCanonicalPreimageBytes = new Uint8Array(capturedPreimage);
	const capturedSignature = capturedWitness.signature;
	if (!(capturedSignature instanceof Uint8Array)) return undefined;
	const signature = new Uint8Array(capturedSignature);
	if (signature.byteLength !== 64) return undefined;
	const suiteId = capturedWitness.suiteId;
	if (typeof domain !== "string" || typeof expectedAnchor !== "string" || typeof suiteId !== "string") {
		return undefined;
	}
	return {
		digest,
		witness: {
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes,
			signature,
			suiteId,
		},
	};
}

/**
 * Reconstructs the current canonical proof from two current persisted witnesses.
 * @param input - Current slot scope, witnesses and authoritative key resolver.
 * @returns A verifier-compatible canonical proof, or undefined when validation fails.
 */
export function materializeCurrentEquivocationProof(
	input: MaterializeCurrentEquivocationProofInput
): PersistedEquivocationProof | undefined {
	try {
		if (input === null || typeof input !== "object") return undefined;
		const capturedScope = input.scope;
		const capturedVertices = input.vertices;
		const capturedResolver = input.resolveAuthorPublicKey;
		if (
			capturedScope === null ||
			typeof capturedScope !== "object" ||
			!Array.isArray(capturedVertices) ||
			capturedVertices.length !== 2 ||
			typeof capturedResolver !== "function"
		) {
			return undefined;
		}

		const author = capturedScope.author;
		const authorSequence = capturedScope.authorSequence;
		const objectId = capturedScope.objectId;
		if (typeof author !== "string" || !Number.isSafeInteger(authorSequence) || typeof objectId !== "string") {
			return undefined;
		}
		const scope: EquivocationScope = { author, authorSequence, objectId };

		const first = detachCurrentEquivocationVertex(capturedVertices[0]);
		if (first === undefined) return undefined;
		const second = detachCurrentEquivocationVertex(capturedVertices[1]);
		if (second === undefined || compareBytes(first.digest, second.digest) === 0) return undefined;

		const resolveAuthorPublicKey = (candidateAuthor: string): RawEd25519PublicKey | undefined =>
			Reflect.apply(capturedResolver, input, [candidateAuthor]);
		for (const vertex of [first, second]) {
			const authenticated = authenticateReceivedVertex({
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				receivedCanonicalPreimageBytes: vertex.witness.receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			});
			if (authenticated === undefined || compareBytes(authenticated.digest, vertex.digest) !== 0) {
				return undefined;
			}
			if (
				authenticated.preimage.author !== scope.author ||
				authenticated.preimage.authorSequence !== scope.authorSequence ||
				authenticated.preimage.objectId !== scope.objectId
			) {
				return undefined;
			}
		}
		return canonicalEquivocationProof(scope, first, second);
	} catch {
		return undefined;
	}
}

interface MutableDurableAuthorProjectionState {
	readonly slots: AuthorProjectionSlot[];
	readonly pending: PendingEquivocationPair[];
}

function captureAuthorProjectionScope(value: unknown): EquivocationScope | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<EquivocationScope>;
	const author = candidate.author;
	const authorSequence = candidate.authorSequence;
	const objectId = candidate.objectId;
	if (
		typeof author !== "string" ||
		!Number.isSafeInteger(authorSequence) ||
		(authorSequence as number) < 0 ||
		typeof objectId !== "string"
	) {
		return undefined;
	}
	return { author, authorSequence: authorSequence as number, objectId };
}

function copyAuthorProjectionScope(scope: EquivocationScope): EquivocationScope {
	return {
		author: scope.author,
		authorSequence: scope.authorSequence,
		objectId: scope.objectId,
	};
}

function equalAuthorProjectionScopes(left: EquivocationScope, right: EquivocationScope): boolean {
	return (
		left.author === right.author && left.authorSequence === right.authorSequence && left.objectId === right.objectId
	);
}

function isDigestHex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function copyAuthorProjectionStrings(values: readonly string[]): string[] {
	const copied: string[] = [];
	const length = values.length;
	for (let index = 0; index < length; index++) {
		copied[index] = values[index] as string;
	}
	return copied;
}

function authorProjectionIncludes(values: readonly string[], sought: string): boolean {
	for (let index = 0; index < values.length; index++) {
		if (values[index] === sought) return true;
	}
	return false;
}

function copyDurableAuthorProjectionState(state: DurableAuthorProjectionState): MutableDurableAuthorProjectionState {
	if (state === null || typeof state !== "object") {
		throw new TypeError("durable author projection is malformed");
	}
	const capturedSlots = state.slots;
	const capturedPending = state.pending;
	if (!Array.isArray(capturedSlots) || !Array.isArray(capturedPending)) {
		throw new TypeError("durable author projection is malformed");
	}

	const slots: AuthorProjectionSlot[] = [];
	const slotCount = capturedSlots.length;
	for (let index = 0; index < slotCount; index++) {
		const candidate = capturedSlots[index] as AuthorProjectionSlot;
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("durable author projection slot is malformed");
		}
		const scope = captureAuthorProjectionScope(candidate.scope);
		const capturedDigestHexes = candidate.digestHexes;
		if (scope === undefined || !Array.isArray(capturedDigestHexes)) {
			throw new TypeError("durable author projection slot is malformed");
		}
		const digestHexes: string[] = [];
		const digestCount = capturedDigestHexes.length;
		for (let digestIndex = 0; digestIndex < digestCount; digestIndex++) {
			const digestHex = capturedDigestHexes[digestIndex];
			if (!isDigestHex(digestHex)) {
				throw new TypeError("durable author projection digest is malformed");
			}
			digestHexes[digestIndex] = digestHex;
		}
		slots[index] = { scope, digestHexes };
	}

	const pending: PendingEquivocationPair[] = [];
	const pendingCount = capturedPending.length;
	for (let index = 0; index < pendingCount; index++) {
		const candidate = capturedPending[index] as PendingEquivocationPair;
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("durable author projection pending row is malformed");
		}
		const scope = captureAuthorProjectionScope(candidate.scope);
		const lesserDigestHex = candidate.lesserDigestHex;
		const greaterDigestHex = candidate.greaterDigestHex;
		const pairId = candidate.pairId;
		if (
			scope === undefined ||
			typeof lesserDigestHex !== "string" ||
			typeof greaterDigestHex !== "string" ||
			typeof pairId !== "string"
		) {
			throw new TypeError("durable author projection pending row is malformed");
		}
		pending[index] = { scope, lesserDigestHex, greaterDigestHex, pairId };
	}
	return { pending, slots };
}

function captureAuthenticatedAuthorProjectionVertices(
	value: unknown,
	scope: EquivocationScope,
	resolveAuthorPublicKey: VerifyReceivedVertexInput["resolveAuthorPublicKey"]
): readonly PersistedVertexWitness[] | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const capturedVertices = (value as PersistedEquivocationState).vertices;
	if (!Array.isArray(capturedVertices)) return undefined;

	const vertices: PersistedVertexWitness[] = [];
	const vertexCount = capturedVertices.length;
	for (let index = 0; index < vertexCount; index++) {
		const vertex = detachCurrentEquivocationVertex(capturedVertices[index]);
		if (vertex === undefined) return undefined;
		vertices[index] = vertex;
	}

	for (let index = 0; index < vertexCount; index++) {
		const vertex = vertices[index] as PersistedVertexWitness;
		const authenticated = authenticateReceivedVertex({
			domain: vertex.witness.domain,
			expectedAnchor: vertex.witness.expectedAnchor,
			receivedCanonicalPreimageBytes: vertex.witness.receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey,
			signature: vertex.witness.signature,
			suiteId: vertex.witness.suiteId,
		});
		if (authenticated === undefined || compareBytes(authenticated.digest, vertex.digest) !== 0) {
			return undefined;
		}
		if (
			authenticated.preimage.author !== scope.author ||
			authenticated.preimage.authorSequence !== scope.authorSequence ||
			authenticated.preimage.objectId !== scope.objectId
		) {
			return undefined;
		}
	}
	return vertices;
}

function canonicalAuthorProjectionPair(
	leftDigestHex: string,
	rightDigestHex: string
): readonly [lesserDigestHex: string, greaterDigestHex: string] | undefined {
	if (!isDigestHex(leftDigestHex) || !isDigestHex(rightDigestHex) || leftDigestHex === rightDigestHex) {
		return undefined;
	}
	return leftDigestHex < rightDigestHex ? [leftDigestHex, rightDigestHex] : [rightDigestHex, leftDigestHex];
}

function bytesFromDigestHex(value: string): Uint8Array | undefined {
	if (!isDigestHex(value)) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function authorProjectionPairId(
	pair: readonly [lesserDigestHex: string, greaterDigestHex: string]
): string | undefined {
	const lesser = bytesFromDigestHex(pair[0]);
	const greater = bytesFromDigestHex(pair[1]);
	if (lesser === undefined || greater === undefined) return undefined;
	return deriveEquivocationProofId(lesser, greater);
}

/**
 * Creates a deep-only durable projection over injected authoritative slot and author stores.
 * @param options - Authoritative reads, recovery enumeration, transaction, resolver and handoff capabilities.
 * @returns A coordinator with reconciliation, recovery and one-row draining operations.
 */
export function createDurableAuthorEquivocationProjection(
	options: DurableAuthorEquivocationProjectionOptions
): DurableAuthorEquivocationProjection {
	if (options === null || typeof options !== "object") {
		throw new TypeError("projection options are required");
	}
	const readCommittedSlotState = options.readCommittedSlotState;
	const enumerateCommittedAuthorSlots = options.enumerateCommittedAuthorSlots;
	const transactAuthorProjection = options.transactAuthorProjection;
	const resolveAuthorPublicKey = options.resolveAuthorPublicKey;
	const handoffProof = options.handoffProof;
	if (
		typeof readCommittedSlotState !== "function" ||
		typeof enumerateCommittedAuthorSlots !== "function" ||
		typeof transactAuthorProjection !== "function" ||
		typeof resolveAuthorPublicKey !== "function" ||
		typeof handoffProof !== "function"
	) {
		throw new TypeError("all projection capabilities are required");
	}

	const resolveAuthor = (author: string): RawEd25519PublicKey | undefined =>
		Reflect.apply(resolveAuthorPublicKey, options, [author]) as RawEd25519PublicKey | undefined;
	const readSlot = (scope: EquivocationScope): Promise<PersistedEquivocationState> =>
		Reflect.apply(readCommittedSlotState, options, [scope]) as Promise<PersistedEquivocationState>;
	const enumerateSlots = (author: string): Promise<readonly EquivocationScope[]> =>
		Reflect.apply(enumerateCommittedAuthorSlots, options, [author]) as Promise<readonly EquivocationScope[]>;
	const transact = <Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result> => Reflect.apply(transactAuthorProjection, options, [author, apply]) as Promise<Result>;
	const handoff = (proof: PersistedEquivocationProof): Promise<void> =>
		Reflect.apply(handoffProof, options, [proof]) as Promise<void>;

	const reconcile = async (requestedScope: EquivocationScope): Promise<ReconcileAuthorProjectionResult> => {
		const scope = captureAuthorProjectionScope(requestedScope);
		if (scope === undefined) throw new TypeError("projection scope is malformed");
		const committed = await readSlot(copyAuthorProjectionScope(scope));
		const vertices = captureAuthenticatedAuthorProjectionVertices(committed, scope, resolveAuthor);
		if (vertices === undefined) {
			throw new TypeError("authoritative committed slot is invalid");
		}

		const committedDigestHexes: string[] = [];
		for (let index = 0; index < vertices.length; index++) {
			const digestHex = bytesToHex((vertices[index] as PersistedVertexWitness).digest);
			if (!authorProjectionIncludes(committedDigestHexes, digestHex)) {
				committedDigestHexes[committedDigestHexes.length] = digestHex;
			}
		}
		committedDigestHexes.sort();

		return transact(scope.author, (durableState) => {
			const next = copyDurableAuthorProjectionState(durableState);
			let slotIndex = -1;
			for (let index = 0; index < next.slots.length; index++) {
				if (equalAuthorProjectionScopes((next.slots[index] as AuthorProjectionSlot).scope, scope)) {
					slotIndex = index;
					break;
				}
			}

			const priorDigestHexes =
				slotIndex === -1
					? []
					: copyAuthorProjectionStrings((next.slots[slotIndex] as AuthorProjectionSlot).digestHexes);
			const newDigestHexes: string[] = [];
			for (let index = 0; index < committedDigestHexes.length; index++) {
				const digestHex = committedDigestHexes[index] as string;
				if (!authorProjectionIncludes(priorDigestHexes, digestHex)) {
					newDigestHexes[newDigestHexes.length] = digestHex;
				}
			}
			const postUnionDigestHexes = copyAuthorProjectionStrings(priorDigestHexes);
			for (let index = 0; index < committedDigestHexes.length; index++) {
				const digestHex = committedDigestHexes[index] as string;
				if (!authorProjectionIncludes(postUnionDigestHexes, digestHex)) {
					postUnionDigestHexes[postUnionDigestHexes.length] = digestHex;
				}
			}
			postUnionDigestHexes.sort();

			const enqueuedPairIds: string[] = [];
			for (let newIndex = 0; newIndex < newDigestHexes.length; newIndex++) {
				for (let unionIndex = 0; unionIndex < postUnionDigestHexes.length; unionIndex++) {
					const pair = canonicalAuthorProjectionPair(
						newDigestHexes[newIndex] as string,
						postUnionDigestHexes[unionIndex] as string
					);
					if (pair === undefined) continue;
					let pendingExists = false;
					for (let pendingIndex = 0; pendingIndex < next.pending.length; pendingIndex++) {
						const row = next.pending[pendingIndex] as PendingEquivocationPair;
						if (
							equalAuthorProjectionScopes(row.scope, scope) &&
							row.lesserDigestHex === pair[0] &&
							row.greaterDigestHex === pair[1]
						) {
							pendingExists = true;
							break;
						}
					}
					if (pendingExists) continue;
					const pairId = authorProjectionPairId(pair);
					if (pairId === undefined) continue;
					next.pending[next.pending.length] = {
						scope: copyAuthorProjectionScope(scope),
						lesserDigestHex: pair[0],
						greaterDigestHex: pair[1],
						pairId,
					};
					enqueuedPairIds[enqueuedPairIds.length] = pairId;
				}
			}

			const slot: AuthorProjectionSlot = {
				scope: copyAuthorProjectionScope(scope),
				digestHexes: postUnionDigestHexes,
			};
			if (slotIndex === -1) next.slots[next.slots.length] = slot;
			else next.slots[slotIndex] = slot;
			return {
				state: next,
				result: {
					enqueuedPairIds,
					newDigestCount: newDigestHexes.length,
				},
			};
		});
	};

	const recover = async (author: string): Promise<RecoverAuthorProjectionResult> => {
		if (typeof author !== "string") throw new TypeError("author is malformed");
		const enumerated = await enumerateSlots(author);
		if (!Array.isArray(enumerated)) {
			throw new TypeError("author recovery enumeration is malformed");
		}
		const scopeCount = enumerated.length;
		const scopes: EquivocationScope[] = [];
		for (let index = 0; index < scopeCount; index++) {
			const scope = captureAuthorProjectionScope(enumerated[index]);
			if (scope === undefined || scope.author !== author) {
				throw new TypeError("author recovery enumeration returned an invalid scope");
			}
			scopes[index] = scope;
		}
		for (let index = 0; index < scopeCount; index++) {
			await reconcile(scopes[index] as EquivocationScope);
		}
		return { reconciledSlotCount: scopeCount };
	};

	const pendingCount = (author: string): Promise<number> =>
		transact(author, (durableState) => {
			const captured = copyDurableAuthorProjectionState(durableState);
			return { state: durableState, result: captured.pending.length };
		});

	const drainOne = async (author: string): Promise<DrainAuthorProjectionResult> => {
		if (typeof author !== "string") throw new TypeError("author is malformed");
		const selection = await transact(author, (durableState) => {
			const captured = copyDurableAuthorProjectionState(durableState);
			return {
				state: durableState,
				result: {
					row: captured.pending[0],
				},
			};
		});
		const row = selection.row;
		if (row === undefined) return { handedOff: false, remainingPending: 0 };

		const scope = captureAuthorProjectionScope(row.scope);
		const pair = canonicalAuthorProjectionPair(row.lesserDigestHex, row.greaterDigestHex);
		const expectedPairId = pair === undefined ? undefined : authorProjectionPairId(pair);
		if (
			scope === undefined ||
			scope.author !== author ||
			pair === undefined ||
			row.lesserDigestHex !== pair[0] ||
			row.greaterDigestHex !== pair[1] ||
			row.pairId !== expectedPairId
		) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}

		const committed = await readSlot(copyAuthorProjectionScope(scope));
		const vertices = captureAuthenticatedAuthorProjectionVertices(committed, scope, resolveAuthor);
		let lesser: PersistedVertexWitness | undefined;
		let greater: PersistedVertexWitness | undefined;
		if (vertices !== undefined) {
			for (let index = 0; index < vertices.length; index++) {
				const vertex = vertices[index] as PersistedVertexWitness;
				const digestHex = bytesToHex(vertex.digest);
				if (digestHex === pair[0]) lesser = vertex;
				if (digestHex === pair[1]) greater = vertex;
			}
		}
		if (lesser === undefined || greater === undefined) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}

		const proof = materializeCurrentEquivocationProof({
			scope: copyAuthorProjectionScope(scope),
			vertices: [lesser, greater],
			resolveAuthorPublicKey: resolveAuthor,
		});
		if (proof === undefined || proof.proofId !== expectedPairId) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}
		await handoff({
			canonicalProofBytes: new Uint8Array(proof.canonicalProofBytes),
			proofId: proof.proofId,
		});

		const remainingPending = await transact(author, (durableState) => {
			const next = copyDurableAuthorProjectionState(durableState);
			let removeIndex = -1;
			for (let index = 0; index < next.pending.length; index++) {
				const candidate = next.pending[index] as PendingEquivocationPair;
				if (
					equalAuthorProjectionScopes(candidate.scope, scope) &&
					candidate.lesserDigestHex === pair[0] &&
					candidate.greaterDigestHex === pair[1] &&
					candidate.pairId === expectedPairId
				) {
					removeIndex = index;
					break;
				}
			}
			if (removeIndex !== -1) next.pending.splice(removeIndex, 1);
			return { state: next, result: next.pending.length };
		});
		return { handedOff: true, remainingPending };
	};

	return { drainOne, reconcile, recover };
}

function allCanonicalEquivocationProofs(
	scope: EquivocationScope,
	vertices: readonly PersistedVertexWitness[]
): PersistedEquivocationProof[] {
	const proofs: PersistedEquivocationProof[] = [];
	for (let leftIndex = 0; leftIndex < vertices.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < vertices.length; rightIndex++) {
			proofs.push(
				canonicalEquivocationProof(
					scope,
					vertices[leftIndex] as PersistedVertexWitness,
					vertices[rightIndex] as PersistedVertexWitness
				)
			);
		}
	}
	return proofs.sort((left, right) => compareCodePointStrings(left.proofId, right.proofId));
}

function slotAdvisorySignal(
	author: string,
	vertexCount: number,
	proofCount: number,
	perSlotAdvisoryProofLimit: number
): SlotAdvisorySignal {
	const withinAdvisoryLimitProofCount = Math.min(proofCount, perSlotAdvisoryProofLimit);
	return {
		author,
		observedForkCount: Math.max(0, vertexCount - 1),
		advisoryLimitReached: proofCount >= perSlotAdvisoryProofLimit,
		withinAdvisoryLimitProofCount,
		overAdvisoryLimitProofCount: proofCount - withinAdvisoryLimitProofCount,
	};
}

function observationDecision(
	scope: EquivocationScope,
	candidate: PersistedVertexWitness,
	perSlotAdvisoryProofLimit: number,
	trustedProofs: readonly PersistedEquivocationProof[],
	authenticatedVertices: readonly PersistedVertexWitness[]
): EquivocationTransactionDecision {
	const previousProofIds = new Set(trustedProofs.map(({ proofId }) => proofId));
	const authenticatedVertexCount = authenticatedVertices.length;
	const vertices: PersistedVertexWitness[] = [];
	let existingIndex = -1;
	for (let index = 0; index < authenticatedVertexCount; index++) {
		const vertex = authenticatedVertices[index] as PersistedVertexWitness;
		vertices[index] = vertex;
		if (existingIndex === -1 && compareBytes(vertex.digest, candidate.digest) === 0) {
			existingIndex = index;
		}
	}
	const disposition = existingIndex === -1 ? (vertices.length === 0 ? "new" : "equivocation") : "duplicate";

	if (existingIndex === -1) {
		vertices[authenticatedVertexCount] = detachPersistedVertex(candidate);
	} else {
		const existing = vertices[existingIndex] as PersistedVertexWitness;
		if (compareBytes(canonicalWitnessBytes(candidate), canonicalWitnessBytes(existing)) < 0) {
			vertices[existingIndex] = detachPersistedVertex(candidate);
		}
	}
	vertices.sort((left, right) => compareBytes(left.digest, right.digest));

	const proofs = allCanonicalEquivocationProofs(scope, vertices);
	const slotSignal = slotAdvisorySignal(scope.author, vertices.length, proofs.length, perSlotAdvisoryProofLimit);
	const orderedDigests = vertices.map(({ digest }) => bytesToHex(digest));
	const result: RemoteObservationResult = {
		admitted: true,
		digest: new Uint8Array(candidate.digest),
		disposition,
		newlyPersistedProofIds: proofs.map(({ proofId }) => proofId).filter((proofId) => !previousProofIds.has(proofId)),
		resolution: {
			orderedDigests,
			preferredDigest: orderedDigests[0] as string,
		},
		slotSignal,
	};
	return {
		result,
		state: {
			proofs,
			slotSignal,
			vertices,
		},
	};
}

function assertPersistedVerticesAuthenticated(
	scope: EquivocationScope,
	state: PersistedEquivocationState,
	resolveAuthorPublicKey: VerifyReceivedVertexInput["resolveAuthorPublicKey"]
): readonly PersistedVertexWitness[] {
	if (state === null || typeof state !== "object") {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertices = state.vertices;
	if (!Array.isArray(capturedVertices)) {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertexCount = capturedVertices.length;
	const detachedVertices: PersistedVertexWitness[] = [];
	for (let index = 0; index < capturedVertexCount; index++) {
		const capturedVertex = capturedVertices[index] as PersistedVertexWitness;
		const vertex = detachPersistedVertex(capturedVertex);
		const digest = vertex.digest;
		const witness = vertex.witness;
		const domain = witness.domain;
		const expectedAnchor = witness.expectedAnchor;
		const receivedCanonicalPreimageBytes = witness.receivedCanonicalPreimageBytes;
		const signature = witness.signature;
		const suiteId = witness.suiteId;

		const authenticated = authenticateReceivedVertex({
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey,
			signature,
			suiteId,
		});
		if (authenticated === undefined || compareBytes(authenticated.digest, digest) !== 0) {
			throw new TypeError("persisted equivocation vertex digest is unauthenticated");
		}
		if (
			authenticated.preimage.author !== scope.author ||
			authenticated.preimage.authorSequence !== scope.authorSequence ||
			authenticated.preimage.objectId !== scope.objectId
		) {
			throw new TypeError("persisted equivocation vertex is outside transaction scope");
		}
		detachedVertices[index] = vertex;
	}
	return detachedVertices;
}

/**
 * Creates a stateless remote equivocation observer over an injected exact-slot transaction.
 *
 * Authentication and input detachment complete before the coordinator is entered.
 * The coordinator owns serialization and durability; this primitive supplies only
 * a pure deterministic transition over the coordinator-provided slot state.
 * @param options - Slot advisory accounting and transaction coordinator.
 * @returns A remote observer with no default or module-local store.
 */
export function createRemoteEquivocationObserver(
	options: RemoteEquivocationObserverOptions
): RemoteEquivocationObserver {
	if (options === null || typeof options !== "object") {
		throw new TypeError("observer options must be an object");
	}
	const perSlotAdvisoryProofLimit = options.perSlotAdvisoryProofLimit;
	const transactObservation = options.transactObservation;
	if (typeof transactObservation !== "function") {
		throw new TypeError("transactObservation must be a function");
	}
	if (!Number.isSafeInteger(perSlotAdvisoryProofLimit) || perSlotAdvisoryProofLimit < 1) {
		throw new TypeError("perSlotAdvisoryProofLimit must be a positive safe integer");
	}

	return {
		async observe(input: VerifyReceivedVertexInput): Promise<RemoteObservationResult> {
			let snapshot: VerifyReceivedVertexInput;
			try {
				if (input === null || typeof input !== "object") {
					throw new TypeError("received vertex input is malformed");
				}
				const domain = input.domain;
				const expectedAnchor = input.expectedAnchor;
				const receivedCanonicalPreimageBytes = input.receivedCanonicalPreimageBytes;
				const capturedResolver = input.resolveAuthorPublicKey;
				const signature = input.signature;
				const suiteId = input.suiteId;
				if (
					!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
					!(signature instanceof Uint8Array) ||
					signature.byteLength !== 64 ||
					typeof capturedResolver !== "function"
				) {
					throw new TypeError("received vertex input is malformed");
				}
				const resolveAuthorPublicKey = capturedResolver.bind(input);
				snapshot = {
					domain,
					expectedAnchor,
					receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
					resolveAuthorPublicKey,
					signature: new Uint8Array(signature),
					suiteId,
				};
			} catch {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}

			const authenticated = authenticateReceivedVertex(snapshot);
			if (authenticated === undefined) {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}

			const author = authenticated.preimage.author;
			const authorSequence = authenticated.preimage.authorSequence;
			const objectId = authenticated.preimage.objectId;
			if (typeof author !== "string" || typeof objectId !== "string" || typeof authorSequence !== "number") {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}
			const scope: EquivocationScope = { author, authorSequence, objectId };
			const candidate: PersistedVertexWitness = {
				digest: new Uint8Array(authenticated.digest),
				witness: {
					domain: snapshot.domain,
					expectedAnchor: snapshot.expectedAnchor,
					receivedCanonicalPreimageBytes: new Uint8Array(snapshot.receivedCanonicalPreimageBytes),
					signature: new Uint8Array(snapshot.signature),
					suiteId: snapshot.suiteId,
				},
			};
			return transactObservation(scope, (state) => {
				const authenticatedVertices = assertPersistedVerticesAuthenticated(
					scope,
					state,
					snapshot.resolveAuthorPublicKey
				);
				// Coordinator proofs are a trusted residual until the phase 0o-b policy boundary.
				return observationDecision(scope, candidate, perSlotAdvisoryProofLimit, state.proofs, authenticatedVertices);
			});
		},
	};
}

function invalidEquivocationProof(): EquivocationProofVerification {
	return { verified: false };
}

/**
 * Verifies a canonical standalone same-slot equivocation proof.
 *
 * Both included exact preimages are authenticated through the strict received
 * vertex verifier and the caller's authoritative author-key resolver.
 * @param input - Canonical proof bytes and authoritative key resolver.
 * @returns The verified scope, ordered digest pair and pair-derived proof ID.
 */
export function verifyEquivocationProof(input: VerifyEquivocationProofInput): EquivocationProofVerification {
	if (input === null || typeof input !== "object") {
		return invalidEquivocationProof();
	}

	let capturedCanonicalProofBytes: unknown;
	let capturedResolver: unknown;
	let inputCaptureFailed = false;
	try {
		capturedCanonicalProofBytes = input.canonicalProofBytes;
	} catch {
		inputCaptureFailed = true;
	}
	try {
		capturedResolver = input.resolveAuthorPublicKey;
	} catch {
		inputCaptureFailed = true;
	}
	if (
		inputCaptureFailed ||
		!(capturedCanonicalProofBytes instanceof Uint8Array) ||
		typeof capturedResolver !== "function"
	) {
		return invalidEquivocationProof();
	}

	try {
		const canonicalProofBytes = new Uint8Array(capturedCanonicalProofBytes);
		const resolveAuthorPublicKey = capturedResolver.bind(input);
		const decoded = decodeCanonical(canonicalProofBytes);
		if (compareBytes(encodeCanonical(decoded), canonicalProofBytes) !== 0) {
			return invalidEquivocationProof();
		}
		assertClosedRecord(decoded, ["kind", "profile", "protocolMajor", "slot", "vertices"], "equivocation proof");
		if (
			ownDataProperty(decoded, "kind", "equivocation proof") !== EQUIVOCATION_PROOF_KIND ||
			ownDataProperty(decoded, "profile", "equivocation proof") !== EQUIVOCATION_PROFILE_ID ||
			ownDataProperty(decoded, "protocolMajor", "equivocation proof") !== 3
		) {
			return invalidEquivocationProof();
		}

		const slot = ownDataProperty(decoded, "slot", "equivocation proof");
		assertClosedRecord(slot, ["author", "authorSequence", "objectId"], "equivocation proof.slot");
		const author = ownDataProperty(slot, "author", "equivocation proof.slot");
		const authorSequence = ownDataProperty(slot, "authorSequence", "equivocation proof.slot");
		const objectId = ownDataProperty(slot, "objectId", "equivocation proof.slot");
		if (
			typeof author !== "string" ||
			typeof objectId !== "string" ||
			typeof authorSequence !== "number" ||
			!Number.isSafeInteger(authorSequence)
		) {
			return invalidEquivocationProof();
		}
		const scope: EquivocationScope = { author, authorSequence, objectId };

		const vertices = ownDataProperty(decoded, "vertices", "equivocation proof");
		if (!Array.isArray(vertices) || vertices.length !== 2) return invalidEquivocationProof();
		const verifiedDigests: Uint8Array[] = [];
		for (const [index, vertex] of vertices.entries()) {
			assertClosedRecord(
				vertex,
				["digest", "domain", "expectedAnchor", "preimage", "signature", "suiteId"],
				`equivocation proof.vertices[${index}]`
			);
			const digest = ownDataProperty(vertex, "digest", `equivocation proof.vertices[${index}]`);
			const domain = ownDataProperty(vertex, "domain", `equivocation proof.vertices[${index}]`);
			const expectedAnchor = ownDataProperty(vertex, "expectedAnchor", `equivocation proof.vertices[${index}]`);
			const preimageBytes = ownDataProperty(vertex, "preimage", `equivocation proof.vertices[${index}]`);
			const signature = ownDataProperty(vertex, "signature", `equivocation proof.vertices[${index}]`);
			const suiteId = ownDataProperty(vertex, "suiteId", `equivocation proof.vertices[${index}]`);
			if (
				!(digest instanceof Uint8Array) ||
				digest.byteLength !== 32 ||
				typeof domain !== "string" ||
				typeof expectedAnchor !== "string" ||
				!(preimageBytes instanceof Uint8Array) ||
				!(signature instanceof Uint8Array) ||
				typeof suiteId !== "string"
			) {
				return invalidEquivocationProof();
			}

			const authenticated = authenticateReceivedVertex({
				domain,
				expectedAnchor,
				receivedCanonicalPreimageBytes: preimageBytes,
				resolveAuthorPublicKey,
				signature,
				suiteId,
			});
			if (authenticated === undefined || compareBytes(authenticated.digest, digest) !== 0) {
				return invalidEquivocationProof();
			}
			if (
				authenticated.preimage.author !== scope.author ||
				authenticated.preimage.authorSequence !== scope.authorSequence ||
				authenticated.preimage.objectId !== scope.objectId
			) {
				return invalidEquivocationProof();
			}
			verifiedDigests.push(new Uint8Array(digest));
		}

		const left = verifiedDigests[0] as Uint8Array;
		const right = verifiedDigests[1] as Uint8Array;
		if (compareBytes(left, right) >= 0) return invalidEquivocationProof();
		const digests: [string, string] = [bytesToHex(left), bytesToHex(right)];
		return {
			digests,
			proofId: proofIdForDigests(left, right),
			scope,
			verified: true,
		};
	} catch {
		return invalidEquivocationProof();
	}
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
