import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import registryJson from "../registry/registry-v1.json" with { type: "json" };

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

/** A value does not satisfy the registered protocol-v3 vertex field contract. */
export class VertexValidationError extends TypeError {}

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
const vertexFields = vertexRegistry.fields;
const vertexFieldNames = new Set(vertexFields.map(({ name }) => name));
const anchorFieldCandidate = vertexFields.find(({ name }) => name === "anchor");
if (anchorFieldCandidate === undefined) throw new Error("protocol-v3 vertex registry is missing anchor");
const anchorField: RegistryField = anchorFieldCandidate;

const textEncoder = new TextEncoder();

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
			const detachedInput: LocalVertexInput = {
				anchor: input.anchor,
				dependencies: [...input.dependencies],
				epoch: input.epoch,
				logicalTime: input.logicalTime,
				objectId: input.objectId,
				operation: detachCanonicalRecord(input.operation),
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
 * Verifies a received v3 vertex without ever substituting re-encoded bytes.
 *
 * Domain, suite, signature shape, canonical syntax, registered fields and
 * anchor scope all fail closed before author-key resolution.
 * @param input - Received bytes, signature, expected scope and author-key resolver.
 * @returns Acceptance and, on success, the exact-received-byte digest.
 */
export function verifyReceivedVertex(input: VerifyReceivedVertexInput): RegisteredVertexVerification {
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
		return { accepted: false };
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
		if (preimage.anchor !== input.expectedAnchor) return { accepted: false };

		const digest = digestReceivedVertexPreimage(input.receivedCanonicalPreimageBytes);
		const author = preimage.author;
		if (typeof author !== "string") return { accepted: false };
		const publicKey = input.resolveAuthorPublicKey(author);
		if (publicKey?.format !== "raw" || !(publicKey.bytes instanceof Uint8Array) || publicKey.bytes.byteLength !== 32) {
			return { accepted: false };
		}

		return verifyEd25519RegisteredDigest(input.signature, digest, publicKey.bytes)
			? { accepted: true, digest }
			: { accepted: false };
	} catch {
		return { accepted: false };
	}
}
