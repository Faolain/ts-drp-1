import { compareBytes, encodeCanonical } from "./canonical.js";
import { hashDomain } from "./hash.js";
import registryJson from "../registry/field-registry.json" with { type: "json" };

/** One normative field in a registered protocol structure. */
export interface RegistryField {
	const?: unknown;
	constraints: Readonly<Record<string, unknown>>;
	name: string;
	required: boolean;
	sortRule: string | null;
	type: string;
}

/** One normative hashed or encoded protocol structure. */
export interface RegistryKind {
	domain: string;
	encoding: string;
	fields: readonly RegistryField[];
}

/** Minimum shape consumed by registry-driven builders. */
export interface RegistryDocument {
	domains: Readonly<Record<string, string>>;
	kinds: Readonly<Record<string, RegistryKind>>;
	quorum: {
		callerSuppliedMaxByzantine: boolean;
		f: string;
		q: string;
	};
	registryVersion: number;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

const registry = deepFreeze(registryJson as RegistryDocument);
const textEncoder = new TextEncoder();
const defaultParameters = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
});

/** Compares protocol strings by their UTF-8 bytes without host locale state. */
export function compareProtocolStrings(left: string, right: string): number {
	return compareBytes(textEncoder.encode(left), textEncoder.encode(right));
}

function sortCodepoint(value: unknown, fieldName: string): unknown {
	if (!Array.isArray(value)) throw new TypeError(`registry field ${fieldName} requires an array for codepoint sort`);
	return Object.freeze(
		[...value].sort((left, right) => {
			if (typeof left === "string" && typeof right === "string") {
				return compareProtocolStrings(left, right);
			}
			if (
				left !== null &&
				right !== null &&
				typeof left === "object" &&
				typeof right === "object" &&
				Object.hasOwn(left, "signerId") &&
				Object.hasOwn(right, "signerId")
			) {
				const leftId = (left as { signerId: unknown }).signerId;
				const rightId = (right as { signerId: unknown }).signerId;
				if (typeof leftId === "string" && typeof rightId === "string") {
					return compareProtocolStrings(leftId, rightId);
				}
			}
			throw new TypeError(`registry field ${fieldName} requires codepoint-sortable values`);
		})
	);
}

function sortIndexAscending(value: unknown, fieldName: string): unknown {
	if (!Array.isArray(value)) {
		throw new TypeError(`registry field ${fieldName} requires an array for index-ascending sort`);
	}
	return Object.freeze(
		[...value].sort((left, right) => {
			if (
				left === null ||
				right === null ||
				typeof left !== "object" ||
				typeof right !== "object" ||
				!Object.hasOwn(left, "index") ||
				!Object.hasOwn(right, "index")
			) {
				throw new TypeError(`registry field ${fieldName} requires indexed values`);
			}
			const leftIndex = (left as { index: unknown }).index;
			const rightIndex = (right as { index: unknown }).index;
			if (!Number.isSafeInteger(leftIndex) || !Number.isSafeInteger(rightIndex)) {
				throw new TypeError(`registry field ${fieldName} requires safe-integer indexes`);
			}
			return (leftIndex as number) - (rightIndex as number);
		})
	);
}

function applySortRule(value: unknown, field: RegistryField, kind: string): unknown {
	const fieldName = `${kind}.${field.name}`;
	switch (field.sortRule) {
		case null:
			return value;
		case "codepoint":
			return sortCodepoint(value, fieldName);
		case "index-ascending":
			return sortIndexAscending(value, fieldName);
		case "linearized-order":
			if (!Array.isArray(value)) {
				throw new TypeError(`registry field ${fieldName} requires an array for linearized-order`);
			}
			return Object.freeze([...value]);
		default:
			throw new TypeError(`unknown sortRule ${field.sortRule} for registry field ${fieldName}`);
	}
}

function assertUnicodeScalarExcludingControls(value: unknown, fieldName: string): string {
	if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string`);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			throw new TypeError(`${fieldName} must contain Unicode scalar values and no control characters`);
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const trailing = value.charCodeAt(index + 1);
			if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
				throw new TypeError(`${fieldName} must contain Unicode scalar values and no control characters`);
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new TypeError(`${fieldName} must contain Unicode scalar values and no control characters`);
		}
	}
	return value;
}

function assertPlainObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${fieldName} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) {
		throw new TypeError(`${fieldName} must be a canonical plain object`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function assertDigestHex(value: unknown, fieldName: string, bytes = 32): string {
	if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError(`${fieldName} must be a lowercase ${bytes}-byte hex digest`);
	}
	return value;
}

function normalizeSigner(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
	const signer = assertPlainObject(value, fieldName);
	if (typeof signer.signerId !== "string" || typeof signer.publicKey !== "string") {
		throw new TypeError(`${fieldName} must contain string signerId and publicKey fields`);
	}
	return Object.freeze({ signerId: signer.signerId, publicKey: signer.publicKey });
}

function normalizeChunk(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
	const chunk = assertPlainObject(value, fieldName);
	if (
		!Number.isSafeInteger(chunk.index) ||
		!Number.isSafeInteger(chunk.byteLength) ||
		(chunk.byteLength as number) < 0
	) {
		throw new TypeError(`${fieldName} must contain safe-integer index and byteLength fields`);
	}
	const digest = assertDigestHex(chunk.digest, `${fieldName}.digest`);
	return Object.freeze({ index: chunk.index, digest, byteLength: chunk.byteLength });
}

function declaredInput(
	document: RegistryDocument,
	kind: string,
	value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	const definition = document.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind: ${kind}`);
	return Object.fromEntries(
		definition.fields
			.filter((field) => Object.hasOwn(value, field.name))
			.map((field) => [field.name, value[field.name]])
	);
}

function normalizeRegisteredObject(
	document: RegistryDocument,
	kind: string,
	value: unknown,
	fieldName: string
): Readonly<Record<string, unknown>> {
	const record = assertPlainObject(value, fieldName);
	return makeRegistryPreimageBuilder(document, kind)(declaredInput(document, kind, record));
}

function normalizeSignedVote(
	document: RegistryDocument,
	value: unknown,
	fieldName: string
): Readonly<Record<string, unknown>> {
	const vote = assertPlainObject(value, fieldName);
	if (typeof vote.signature !== "string") throw new TypeError(`${fieldName}.signature must be a string`);
	const preimage = makeRegistryPreimageBuilder(document, "sealVote")(declaredInput(document, "sealVote", vote));
	return Object.freeze({ ...preimage, signature: vote.signature });
}

function normalizeFieldType(document: RegistryDocument, value: unknown, field: RegistryField, kind: string): unknown {
	const fieldName = `${kind}.${field.name}`;
	switch (field.type) {
		case "safe-integer":
		case "canonical-safe-integer":
			if (!Number.isSafeInteger(value)) throw new TypeError(`${fieldName} must be a safe integer`);
			return value;
		case "string":
		case "canonical-string":
			if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string`);
			return value;
		case "enum": {
			const values = field.constraints.values;
			if (!Array.isArray(values) || values.length === 0) {
				throw new TypeError(`${fieldName} enum requires non-empty values`);
			}
			return value;
		}
		case "digest-hex":
			return assertDigestHex(
				value,
				fieldName,
				typeof field.constraints.bytes === "number" ? field.constraints.bytes : 32
			);
		case "bytes":
			if (!(value instanceof Uint8Array)) throw new TypeError(`${fieldName} must be a Uint8Array`);
			return value;
		case "canonical-object":
			assertPlainObject(value, fieldName);
			encodeCanonical(value);
			return value;
		case "parameters":
			return normalizeRegisteredObject(
				document,
				"parameters",
				{ ...defaultParameters, ...declaredInput(document, "parameters", assertPlainObject(value, fieldName)) },
				fieldName
			);
		case "canonical-value":
			encodeCanonical(value);
			return value;
		case "seal-qc|null":
			return value === null ? null : normalizeRegisteredObject(document, "sealQC", value, fieldName);
		case "array<digest-hex>":
			if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
			value.forEach((item, index) => assertDigestHex(item, `${fieldName}[${index}]`));
			return Object.freeze([...value]);
		case "array<signer>":
		case "array<{signerId:string,publicKey:string}>":
			if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
			return Object.freeze(value.map((item, index) => normalizeSigner(item, `${fieldName}[${index}]`)));
		case "array<{index,digest,byteLength}>":
			if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
			return Object.freeze(value.map((item, index) => normalizeChunk(item, `${fieldName}[${index}]`)));
		case "array<signed-seal-vote>":
			if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
			return Object.freeze(value.map((item, index) => normalizeSignedVote(document, item, `${fieldName}[${index}]`)));
		case "array<canonical-value>":
			if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
			value.forEach((item) => encodeCanonical(item));
			return Object.freeze([...value]);
		default:
			throw new TypeError(`unknown registry type ${field.type} for ${fieldName}`);
	}
}

const recognizedConstraintNames = new Set([
	"attestedFormula",
	"bytes",
	"case",
	"charset",
	"contiguous",
	"creator",
	"delegatedMinimum",
	"maxSignerIdUtf16Units",
	"maximum",
	"maximumUtf16Units",
	"minimum",
	"minimumItems",
	"minimumUtf16Units",
	"negotiatedAt",
	"signerIdCharset",
	"unique",
	"uniqueBy",
	"values",
]);

function canonicalKey(value: unknown): string {
	return Array.from(encodeCanonical(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertFieldConstraints(value: unknown, field: RegistryField, kind: string): void {
	const fieldName = `${kind}.${field.name}`;
	for (const name of Object.keys(field.constraints)) {
		if (!recognizedConstraintNames.has(name)) {
			throw new TypeError(`unknown constraint ${name} for registry field ${fieldName}`);
		}
	}
	const { constraints } = field;
	if (Object.hasOwn(constraints, "minimum")) {
		if (typeof constraints.minimum !== "number" || typeof value !== "number" || value < constraints.minimum) {
			throw new TypeError(`${fieldName} violates minimum ${String(constraints.minimum)}`);
		}
	}
	if (Object.hasOwn(constraints, "maximum")) {
		if (typeof constraints.maximum !== "number" || typeof value !== "number" || value > constraints.maximum) {
			throw new TypeError(`${fieldName} violates maximum ${String(constraints.maximum)}`);
		}
	}
	if (Object.hasOwn(constraints, "minimumUtf16Units")) {
		if (
			typeof constraints.minimumUtf16Units !== "number" ||
			typeof value !== "string" ||
			value.length < constraints.minimumUtf16Units
		) {
			throw new TypeError(`${fieldName} violates minimumUtf16Units ${String(constraints.minimumUtf16Units)}`);
		}
	}
	if (Object.hasOwn(constraints, "maximumUtf16Units")) {
		if (
			typeof constraints.maximumUtf16Units !== "number" ||
			typeof value !== "string" ||
			value.length > constraints.maximumUtf16Units
		) {
			throw new TypeError(`${fieldName} violates maximumUtf16Units ${String(constraints.maximumUtf16Units)}`);
		}
	}
	if (Object.hasOwn(constraints, "bytes") && field.type === "bytes") {
		if (
			typeof constraints.bytes !== "number" ||
			!(value instanceof Uint8Array) ||
			value.byteLength !== constraints.bytes
		) {
			throw new TypeError(`${fieldName} must contain exactly ${String(constraints.bytes)} bytes`);
		}
	}
	if (constraints.case === "lower" && (typeof value !== "string" || value !== value.toLowerCase())) {
		throw new TypeError(`${fieldName} must be lowercase`);
	}
	if (Object.hasOwn(constraints, "values")) {
		if (!Array.isArray(constraints.values) || constraints.values.length === 0 || !constraints.values.includes(value)) {
			throw new TypeError(`${fieldName} must be one of ${(constraints.values as readonly unknown[]).join(", ")}`);
		}
	}
	if (Object.hasOwn(constraints, "negotiatedAt") && constraints.negotiatedAt !== "genesis-only") {
		throw new TypeError(`${fieldName} has unsupported negotiatedAt ${String(constraints.negotiatedAt)}`);
	}
	if (Object.hasOwn(constraints, "minimumItems")) {
		if (
			typeof constraints.minimumItems !== "number" ||
			!Array.isArray(value) ||
			value.length < constraints.minimumItems
		) {
			const quantity = constraints.minimumItems === 1 ? "one" : String(constraints.minimumItems);
			throw new TypeError(`${fieldName} must contain at least ${quantity} item(s)`);
		}
	}
	if (constraints.unique === true && Array.isArray(value)) {
		const keys = value.map(canonicalKey);
		if (new Set(keys).size !== keys.length) throw new TypeError(`${fieldName} contains a duplicate value`);
	}
	if (Object.hasOwn(constraints, "uniqueBy")) {
		if (typeof constraints.uniqueBy !== "string" || !Array.isArray(value)) {
			throw new TypeError(`${fieldName} has an invalid uniqueBy constraint`);
		}
		const keys = value.map((item, index) => {
			const record = assertPlainObject(item, `${fieldName}[${index}]`);
			const key = record[constraints.uniqueBy as string];
			if (typeof key !== "string") {
				throw new TypeError(`${fieldName}[${index}].${constraints.uniqueBy} must be a string`);
			}
			return key;
		});
		if (new Set(keys).size !== keys.length) {
			throw new TypeError(`${fieldName} contains a duplicate ${constraints.uniqueBy}`);
		}
	}
	if (constraints.contiguous === true && Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const record = assertPlainObject(value[index], `${fieldName}[${index}]`);
			if (record.index !== index) throw new TypeError(`${fieldName} indexes must be contiguous from zero`);
		}
	}
	if (constraints.charset === "unicode-scalar-excluding-controls") {
		assertUnicodeScalarExcludingControls(value, fieldName);
	}
	if (constraints.signerIdCharset === "unicode-scalar-excluding-controls") {
		if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be an array`);
		value.forEach((item, index) => {
			const signer = assertPlainObject(item, `${fieldName}[${index}]`);
			assertUnicodeScalarExcludingControls(signer.signerId, `${fieldName}[${index}].signerId`);
		});
	}
	if (Object.hasOwn(constraints, "maxSignerIdUtf16Units")) {
		if (typeof constraints.maxSignerIdUtf16Units !== "number" || !Array.isArray(value)) {
			throw new TypeError(`${fieldName} has an invalid maxSignerIdUtf16Units constraint`);
		}
		const maximum = constraints.maxSignerIdUtf16Units;
		value.forEach((item, index) => {
			const signer = assertPlainObject(item, `${fieldName}[${index}]`);
			if (typeof signer.signerId !== "string" || signer.signerId.length > maximum) {
				throw new TypeError(`${fieldName}[${index}].signerId must be at most ${maximum} UTF-16 units`);
			}
		});
	}
}

function assertProfileConstraints(document: RegistryDocument, output: Readonly<Record<string, unknown>>): void {
	const signers = output.signers;
	const quorum = output.quorum;
	if (!Array.isArray(signers) || !Number.isSafeInteger(quorum)) {
		throw new TypeError("profile signers and quorum are invalid");
	}
	const quorumField = document.kinds.profile?.fields.find((field) => field.name === "quorum");
	if (quorumField === undefined) throw new TypeError("profile.quorum registry field is missing");
	const creator = quorumField.constraints.creator;
	const delegatedMinimum = quorumField.constraints.delegatedMinimum;
	const attestedFormula = quorumField.constraints.attestedFormula;
	if (!Number.isSafeInteger(creator) || !Number.isSafeInteger(delegatedMinimum) || attestedFormula !== "ceil(2*n/3)") {
		throw new TypeError("profile quorum constraints are invalid");
	}
	switch (output.profileId) {
		case "creator-trusted-v1":
			if (quorum !== creator) throw new TypeError(`profile.quorum must equal creator quorum ${String(creator)}`);
			break;
		case "delegated-trusted-v1":
			if ((quorum as number) < (delegatedMinimum as number) || (quorum as number) > signers.length) {
				throw new TypeError(`profile.quorum must satisfy delegated minimum ${String(delegatedMinimum)}`);
			}
			break;
		case "attested-bft-v1":
			if (quorum !== Math.ceil((2 * signers.length) / 3)) {
				throw new TypeError("profile.quorum must satisfy ceil(2*n/3)");
			}
			break;
		default:
			break;
	}
}

function assertKindConstraints(
	document: RegistryDocument,
	kind: string,
	output: Readonly<Record<string, unknown>>
): void {
	if (kind === "profile") {
		assertProfileConstraints(document, output);
		return;
	}
	if (kind === "parameters") {
		if ((output.snapshotChunkBytes as number) > (output.maxSnapshotBytes as number)) {
			throw new TypeError("parameters.snapshotChunkBytes cannot exceed maxSnapshotBytes");
		}
		return;
	}
	if (kind === "cutValue") {
		if ((output.historySize as number) !== (output.previousHistorySize as number) + (output.closeSetCount as number)) {
			throw new TypeError("cutValue history size must equal previous size plus close-set count");
		}
		const signers = output.nextSignerSet;
		if (!Array.isArray(signers) || (signers.length !== 0 && signers.length < 4)) {
			throw new TypeError("cutValue.nextSignerSet must be empty or contain at least four signers");
		}
	}
}

/** Constructs a preimage solely from the selected registry field sequence. */
export function makeRegistryPreimageBuilder(
	document: RegistryDocument,
	kind: string
): (input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> {
	const definition = document.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind: ${kind}`);
	const fields = definition.fields;
	const allowed = new Set(fields.map(({ name }) => name));

	return (input) => {
		for (const name of Object.keys(input)) {
			if (!allowed.has(name)) throw new TypeError(`unknown field ${name} for registry kind ${kind}`);
		}
		const output: Record<string, unknown> = {};
		for (const field of fields) {
			const supplied = Object.hasOwn(input, field.name);
			let value: unknown;
			if (supplied) {
				value = input[field.name];
				if (field.const !== null && field.const !== undefined && value !== field.const) {
					throw new TypeError(`field ${kind}.${field.name} must equal its registry constant`);
				}
			} else if (field.const !== null && field.const !== undefined) {
				value = field.const;
			} else if (field.required) {
				throw new TypeError(`missing required registry field ${kind}.${field.name}`);
			} else {
				continue;
			}
			const typed = normalizeFieldType(document, value, field, kind);
			const normalized = applySortRule(typed, field, kind);
			assertFieldConstraints(normalized, field, kind);
			output[field.name] = normalized;
		}
		assertKindConstraints(document, kind, output);
		return Object.freeze(output);
	};
}

const buildCutValue = makeRegistryPreimageBuilder(registry, "cutValue");

/** Builds the current cut preimage and rejects fields absent from the registry. */
export function cutValuePreimage(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return buildCutValue(input);
}

/** Enforces the registry path/version change-control gate. */
export function assertRegistryVersionBump(input: {
	baseVersion: number;
	changedPaths: readonly string[];
	currentVersion: number;
}): void {
	const changesRegistry = input.changedPaths.some((path) => /(^|\/)registry\//u.test(path));
	if (changesRegistry && input.currentVersion <= input.baseVersion) {
		throw new Error("registryVersion bump is required for changes under /registry/**");
	}
}

/** Resolves one kind's domain through domains{} and rejects duplicated-registry drift. */
export function registryDomain(document: RegistryDocument, kind: string): string {
	const definition = document.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind: ${kind}`);
	const domain = document.domains[kind];
	if (typeof domain !== "string" || domain.length === 0) {
		throw new TypeError(`missing registry domain for kind ${kind}`);
	}
	if (definition.domain !== domain) {
		throw new TypeError(`registry domain for kind ${kind} mismatch: domains{}=${domain}, kind=${definition.domain}`);
	}
	const owner = Object.entries(document.domains).find(([candidate, candidateDomain]) => {
		return candidate !== kind && candidateDomain === domain;
	});
	if (owner !== undefined) {
		throw new TypeError(`duplicate registry domain ${domain} for kinds ${owner[0]} and ${kind}`);
	}
	return domain;
}

/** Encodes a validated preimage into the exact hash parts declared by its registry encoding. */
export function registryPreimageParts(
	document: RegistryDocument,
	kind: string,
	input: Readonly<Record<string, unknown>>
): readonly Uint8Array[] {
	const definition = document.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind: ${kind}`);
	const preimage = makeRegistryPreimageBuilder(document, kind)(input);
	switch (definition.encoding) {
		case "canonical-object":
		case "canonical-object-as-single-part":
			return Object.freeze([encodeCanonical(preimage)]);
		case "canonical-array":
		case "canonical-value-as-single-part": {
			if (definition.fields.length !== 1) {
				throw new TypeError(`registry encoding ${definition.encoding} for ${kind} requires exactly one field`);
			}
			const field = definition.fields[0];
			if (field === undefined) throw new TypeError(`registry kind ${kind} has no encodable field`);
			return Object.freeze([encodeCanonical(preimage[field.name])]);
		}
		case "domain-framed-parts":
			return Object.freeze(
				definition.fields.map((field) => {
					const value = preimage[field.name];
					if (field.type === "bytes") {
						if (!(value instanceof Uint8Array)) {
							throw new TypeError(`registry field ${kind}.${field.name} must be a Uint8Array`);
						}
						return value;
					}
					return encodeCanonical(value);
				})
			);
		default:
			throw new TypeError(`unknown registry encoding ${definition.encoding} for kind ${kind}`);
	}
}

/** Builds, registry-encodes, and domain-hashes a registry kind. */
export function digestRegistryPreimage(
	document: RegistryDocument,
	kind: string,
	input: Readonly<Record<string, unknown>>
): Uint8Array {
	return hashDomain(registryDomain(document, kind), ...registryPreimageParts(document, kind, input));
}

/** Returns the checked-in normative registry to internal protocol modules. */
export function protocolRegistry(): RegistryDocument {
	return registry;
}
