/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */

import { compareByteSequences } from "./bytes.js";
import { encodeCanonical } from "./canonical.js";

const utf8 = new TextEncoder();
const parameterDefaults = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
});
const understoodConstraints = new Set([
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
	"reservedValues",
	"signerIdCharset",
	"unique",
	"uniqueBy",
	"values",
]);

function record(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be a plain object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`);
	}
	return value;
}

function scalarString(value, label) {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
			throw new TypeError(`${label} contains a control character`);
		}
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const second = value.charCodeAt(index + 1);
			if (second < 0xdc00 || second > 0xdfff) throw new TypeError(`${label} contains an unpaired surrogate`);
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new TypeError(`${label} contains an unpaired surrogate`);
		}
	}
	return value;
}

function digest(value, label, length = 32) {
	if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length * 2}}$`, "u").test(value)) {
		throw new TypeError(`${label} must be a lowercase ${length}-byte digest`);
	}
	return value;
}

function onlyDeclared(definition, value) {
	return Object.fromEntries(
		definition.fields
			.filter((field) => Object.hasOwn(value, field.name))
			.map((field) => [field.name, value[field.name]])
	);
}

function signer(value, label) {
	const source = record(value, label);
	if (typeof source.signerId !== "string" || typeof source.publicKey !== "string") {
		throw new TypeError(`${label} must contain signerId and publicKey`);
	}
	return { signerId: source.signerId, publicKey: source.publicKey };
}

function chunk(value, label) {
	const source = record(value, label);
	if (!Number.isSafeInteger(source.index) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
		throw new TypeError(`${label} has an invalid index or byteLength`);
	}
	return {
		index: source.index,
		digest: digest(source.digest, `${label}.digest`),
		byteLength: source.byteLength,
	};
}

function normalizeType(document, kind, field, value) {
	const label = `${kind}.${field.name}`;
	switch (field.type) {
		case "safe-integer":
		case "canonical-safe-integer":
			if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
			return value;
		case "string":
		case "canonical-string":
			if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
			return value;
		case "enum":
			if (!Array.isArray(field.constraints.values) || field.constraints.values.length === 0) {
				throw new TypeError(`${label} enum must declare non-empty active values`);
			}
			return value;
		case "digest-hex":
			return digest(value, label, typeof field.constraints.bytes === "number" ? field.constraints.bytes : 32);
		case "bytes":
			if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
			return value;
		case "canonical-object":
			record(value, label);
			encodeCanonical(value);
			return value;
		case "canonical-value":
			encodeCanonical(value);
			return value;
		case "parameters": {
			const supplied = record(value, label);
			const definition = document.kinds.parameters;
			return makeRegistryPreimageBuilder(
				document,
				"parameters"
			)({
				...parameterDefaults,
				...onlyDeclared(definition, supplied),
			});
		}
		case "seal-qc|null": {
			if (value === null) return null;
			const definition = document.kinds.sealQC;
			return makeRegistryPreimageBuilder(document, "sealQC")(onlyDeclared(definition, record(value, label)));
		}
		case "array<digest-hex>":
			if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
			return value.map((item, index) => digest(item, `${label}[${index}]`));
		case "array<signer>":
		case "array<{signerId:string,publicKey:string}>":
			if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
			return value.map((item, index) => signer(item, `${label}[${index}]`));
		case "array<{index,digest,byteLength}>":
			if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
			return value.map((item, index) => chunk(item, `${label}[${index}]`));
		case "array<signed-seal-vote>":
			if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
			return value.map((item, index) => {
				const source = record(item, `${label}[${index}]`);
				if (typeof source.signature !== "string") throw new TypeError(`${label}[${index}] has no signature`);
				const definition = document.kinds.sealVote;
				return {
					...makeRegistryPreimageBuilder(document, "sealVote")(onlyDeclared(definition, source)),
					signature: source.signature,
				};
			});
		case "array<canonical-value>":
			if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
			value.forEach((item) => encodeCanonical(item));
			return [...value];
		default:
			throw new TypeError(`unsupported registry type ${field.type}`);
	}
}

function sortValue(rule, value, label) {
	if (rule === null) return value;
	if (!Array.isArray(value)) throw new TypeError(`${label} sort requires an array`);
	if (rule === "linearized-order") return [...value];
	if (rule === "index-ascending") return [...value].sort((left, right) => left.index - right.index);
	if (rule === "codepoint") {
		return [...value].sort((left, right) => {
			const leftKey = typeof left === "string" ? left : left.signerId;
			const rightKey = typeof right === "string" ? right : right.signerId;
			if (typeof leftKey !== "string" || typeof rightKey !== "string") {
				throw new TypeError(`${label} values cannot be sorted`);
			}
			return compareByteSequences(utf8.encode(leftKey), utf8.encode(rightKey));
		});
	}
	throw new TypeError(`unsupported sort rule ${rule}`);
}

function canonicalIdentity(value) {
	return Array.from(encodeCanonical(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateConstraints(kind, field, value) {
	const constraints = field.constraints;
	const label = `${kind}.${field.name}`;
	for (const name of Object.keys(constraints)) {
		if (!understoodConstraints.has(name)) throw new TypeError(`${label} has an unknown constraint ${name}`);
	}
	if (
		Object.hasOwn(constraints, "minimum") &&
		(typeof constraints.minimum !== "number" || typeof value !== "number" || value < constraints.minimum)
	) {
		throw new TypeError(`${label} has an invalid or unsatisfied minimum`);
	}
	if (
		Object.hasOwn(constraints, "maximum") &&
		(typeof constraints.maximum !== "number" || typeof value !== "number" || value > constraints.maximum)
	) {
		throw new TypeError(`${label} has an invalid or unsatisfied maximum`);
	}
	if (
		Object.hasOwn(constraints, "minimumUtf16Units") &&
		(typeof constraints.minimumUtf16Units !== "number" ||
			typeof value !== "string" ||
			value.length < constraints.minimumUtf16Units)
	) {
		throw new TypeError(`${label} has an invalid or unsatisfied minimum string length`);
	}
	if (
		Object.hasOwn(constraints, "maximumUtf16Units") &&
		(typeof constraints.maximumUtf16Units !== "number" ||
			typeof value !== "string" ||
			value.length > constraints.maximumUtf16Units)
	) {
		throw new TypeError(`${label} has an invalid or unsatisfied maximum string length`);
	}
	if (field.type === "bytes" && Object.hasOwn(constraints, "bytes") && value.byteLength !== constraints.bytes) {
		throw new TypeError(`${label} has the wrong byte length`);
	}
	if (constraints.case === "lower" && value !== value.toLowerCase()) {
		throw new TypeError(`${label} must be lowercase`);
	}
	if (
		Object.hasOwn(constraints, "values") &&
		(!Array.isArray(constraints.values) || constraints.values.length === 0 || !constraints.values.includes(value))
	) {
		throw new TypeError(`${label} has invalid active values or is not an active enum value`);
	}
	if (Object.hasOwn(constraints, "reservedValues")) {
		if (
			!Array.isArray(constraints.reservedValues) ||
			constraints.reservedValues.some((reserved) => typeof reserved !== "string")
		) {
			throw new TypeError(`${label} has invalid reserved values`);
		}
		if (
			Array.isArray(constraints.values) &&
			constraints.reservedValues.some((reserved) => constraints.values.includes(reserved))
		) {
			throw new TypeError(`${label} has overlapping active and reserved values`);
		}
	}
	if (Object.hasOwn(constraints, "negotiatedAt") && constraints.negotiatedAt !== "genesis-only") {
		throw new TypeError(`${label} has an unsupported negotiation point`);
	}
	if (
		Object.hasOwn(constraints, "minimumItems") &&
		(typeof constraints.minimumItems !== "number" || !Array.isArray(value) || value.length < constraints.minimumItems)
	) {
		throw new TypeError(`${label} has an invalid or unsatisfied minimum item count`);
	}
	if (constraints.unique === true) {
		const identities = value.map(canonicalIdentity);
		if (new Set(identities).size !== identities.length) throw new TypeError(`${label} contains duplicates`);
	}
	if (Object.hasOwn(constraints, "uniqueBy")) {
		if (typeof constraints.uniqueBy !== "string" || !Array.isArray(value)) {
			throw new TypeError(`${label} has invalid unique-key metadata`);
		}
		const identities = value.map((item, index) => {
			const source = record(item, `${label}[${index}]`);
			const identity = source[constraints.uniqueBy];
			if (typeof identity !== "string") {
				throw new TypeError(`${label}[${index}] has a non-string unique key`);
			}
			return identity;
		});
		if (new Set(identities).size !== identities.length) throw new TypeError(`${label} contains duplicate keys`);
	}
	if (constraints.contiguous === true) {
		value.forEach((item, index) => {
			if (item.index !== index) throw new TypeError(`${label} is not contiguous`);
		});
	}
	if (constraints.charset === "unicode-scalar-excluding-controls") scalarString(value, label);
	if (constraints.signerIdCharset === "unicode-scalar-excluding-controls") {
		value.forEach((item, index) => scalarString(item.signerId, `${label}[${index}].signerId`));
	}
	if (Object.hasOwn(constraints, "maxSignerIdUtf16Units")) {
		if (typeof constraints.maxSignerIdUtf16Units !== "number" || !Array.isArray(value)) {
			throw new TypeError(`${label} has invalid signer identifier length metadata`);
		}
		value.forEach((item, index) => {
			const source = record(item, `${label}[${index}]`);
			if (typeof source.signerId !== "string" || source.signerId.length > constraints.maxSignerIdUtf16Units) {
				throw new TypeError(`${label} signer identifier is too long`);
			}
		});
	}
}

function validateComposite(kind, value, document) {
	if (kind === "parameters" && value.snapshotChunkBytes > value.maxSnapshotBytes) {
		throw new TypeError("snapshot chunks exceed snapshot maximum");
	}
	if (kind === "cutValue") {
		if (value.historySize !== value.previousHistorySize + value.closeSetCount) {
			throw new TypeError("history size does not match close set");
		}
		if (value.nextSignerSet.length !== 0 && value.nextSignerSet.length < 4) {
			throw new TypeError("next signer set is too small");
		}
	}
	if (kind !== "profile") return;
	const quorumField = document.kinds.profile.fields.find((field) => field.name === "quorum");
	if (
		quorumField === undefined ||
		!Number.isSafeInteger(quorumField.constraints.creator) ||
		!Number.isSafeInteger(quorumField.constraints.delegatedMinimum) ||
		quorumField.constraints.attestedFormula !== "ceil(2*n/3)"
	) {
		throw new TypeError("profile quorum constraint metadata is invalid");
	}
	if (value.profileId === "creator-trusted-v1" && value.quorum !== quorumField.constraints.creator) {
		throw new TypeError("creator quorum mismatch");
	}
	if (
		value.profileId === "delegated-trusted-v1" &&
		(value.quorum < quorumField.constraints.delegatedMinimum || value.quorum > value.signers.length)
	) {
		throw new TypeError("delegated quorum mismatch");
	}
	if (value.profileId === "attested-bft-v1" && value.quorum !== Math.ceil((2 * value.signers.length) / 3)) {
		throw new TypeError("attested quorum mismatch");
	}
}

export function makeRegistryPreimageBuilder(document, kind) {
	const definition = document?.kinds?.[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind ${kind}`);
	const allowed = new Set(definition.fields.map((field) => field.name));
	return (input) => {
		record(input, `${kind} input`);
		for (const name of Object.keys(input)) {
			if (!allowed.has(name)) throw new TypeError(`unknown field ${kind}.${name}`);
		}
		const output = {};
		for (const field of definition.fields) {
			const supplied = Object.hasOwn(input, field.name);
			if (!supplied && field.const == null && field.required) {
				throw new TypeError(`missing field ${kind}.${field.name}`);
			}
			if (!supplied && field.const == null) continue;
			const value = supplied ? input[field.name] : field.const;
			if (supplied && field.const != null && value !== field.const) {
				throw new TypeError(`constant mismatch for ${kind}.${field.name}`);
			}
			const typed = normalizeType(document, kind, field, value);
			const normalized = sortValue(field.sortRule, typed, `${kind}.${field.name}`);
			validateConstraints(kind, field, normalized);
			output[field.name] = normalized;
		}
		validateComposite(kind, output, document);
		return Object.freeze(output);
	};
}

export function registryPreimageParts(document, kind, input) {
	const definition = document?.kinds?.[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind ${kind}`);
	const value = makeRegistryPreimageBuilder(document, kind)(input);
	if (definition.encoding === "canonical-object" || definition.encoding === "canonical-object-as-single-part") {
		return [encodeCanonical(value)];
	}
	if (definition.encoding === "canonical-array" || definition.encoding === "canonical-value-as-single-part") {
		if (definition.fields.length !== 1) throw new TypeError(`${kind} requires one registry field`);
		return [encodeCanonical(value[definition.fields[0].name])];
	}
	if (definition.encoding === "domain-framed-parts") {
		return definition.fields.map((field) => {
			const item = value[field.name];
			return field.type === "bytes" ? item : encodeCanonical(item);
		});
	}
	throw new TypeError(`unsupported registry encoding ${definition.encoding}`);
}
