/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone audited JavaScript reference */

import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as signMessage,
	verify as verifyMessage,
} from "node:crypto";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_VARUINT = 18_014_398_509_481_983n;
const LIMITS = Object.freeze({
	maxBytes: 268_435_456,
	maxDepth: 128,
	maxItems: 1_000_000,
});

const TAG = Object.freeze({
	"null": 0,
	"false": 1,
	"true": 2,
	"integer": 3,
	"float64": 4,
	"string": 5,
	"bytes": 6,
	"array": 7,
	"object": 8,
	"map": 9,
	"set": 10,
	"float32-array": 11,
	"float64-array": 12,
	"int32-array": 13,
	"uint32-array": 14,
});

const NO_CONST = Symbol("no-const");

function field(name, type, constraints = {}, constant = NO_CONST, sortRule = null) {
	return Object.freeze({ name, type, constraints, constant, required: true, sortRule });
}

function kind(domain, encoding, fields, suiteRole = null) {
	return Object.freeze({
		domain,
		encoding,
		fields: Object.freeze(fields),
		suiteRole,
	});
}

const digest = (name) => field(name, "digest-hex", { bytes: 32 });
const safe = (name, constraints = {}) => field(name, "safe-integer", constraints);
const text = (name, constraints = {}, constant = NO_CONST) => field(name, "string", constraints, constant);

const KINDS = Object.freeze({
	signerSet: kind("ts-drp/signer-set/v3", "canonical-array", [
		field(
			"signers",
			"array<{signerId:string,publicKey:string}>",
			{
				uniqueBy: "signerId",
				signerIdCharset: "unicode-scalar-excluding-controls",
				maxSignerIdUtf16Units: 512,
			},
			NO_CONST,
			"codepoint"
		),
	]),
	parameters: kind("ts-drp/parameters/v3", "canonical-object", [
		safe("maxEpochVertices", { minimum: 32, maximum: 1_000_000 }),
		safe("maxEpochBytes", { minimum: 65_536, maximum: 1_073_741_824 }),
		safe("maxDependencies", { minimum: 1, maximum: 256 }),
		safe("snapshotChunkBytes", { minimum: 16_384, maximum: 1_048_576 }),
		safe("maxSnapshotBytes", { minimum: 1_048_576, maximum: 4_294_967_296 }),
		safe("maxPendingEntries", { minimum: 1, maximum: 1_000_000 }),
		safe("maxPendingBytes", { minimum: 65_536, maximum: 1_073_741_824 }),
	]),
	vertex: kind(
		"ts-drp/vertex/v3",
		"canonical-object",
		[
			text("kind", {}, "drp-vertex"),
			field("protocolMajor", "safe-integer", {}, 3),
			text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
			safe("epoch", { minimum: 0 }),
			digest("anchor"),
			text("author", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
			safe("authorSequence", {
				minimum: 0,
				maximum: MAX_SAFE,
				initial: 0,
				reset: "never",
				overflow: "reject",
			}),
			safe("logicalTime", { minimum: 1 }),
			field("dependencies", "array<digest-hex>", { minimumItems: 1, unique: true }, NO_CONST, "codepoint"),
			field("operation", "canonical-object"),
		],
		"identityAndVertex"
	),
	cutValue: kind("ts-drp/hard-epoch-cut/v3", "canonical-object", [
		text("kind", {}, "drp-hard-epoch-cut"),
		field("protocolMajor", "safe-integer", {}, 3),
		text("encodingVersion", {}, "drp-canonical-profile-1"),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		digest("previousAnchor"),
		digest("previousCutDigest"),
		digest("previousHistoryRoot"),
		safe("previousHistorySize", { minimum: 0 }),
		digest("closeSetRoot"),
		safe("closeSetCount", { minimum: 0 }),
		digest("historyRoot"),
		safe("historySize", { minimum: 0 }),
		digest("stateDigest"),
		digest("aclDigest"),
		digest("snapshotManifestDigest"),
		digest("blueprintDigest"),
		digest("archiveIndexRoot"),
		digest("availabilityPolicyDigest"),
		field("nextSignerSet", "array<signer>", { uniqueBy: "signerId" }, NO_CONST, "codepoint"),
		field("parameters", "parameters"),
		text("closeReason", { maximumUtf16Units: 128 }),
	]),
	epochAnchor: kind(
		"ts-drp/epoch-anchor/v3",
		"canonical-object",
		[
			text("kind", {}, "drp-epoch-anchor"),
			field("protocolMajor", "safe-integer", {}, 3),
			text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
			safe("epoch", { minimum: 0 }),
			digest("previousAnchor"),
			digest("cutDigest"),
			digest("stateDigest"),
			digest("aclDigest"),
			digest("historyRoot"),
			safe("historySize", { minimum: 0 }),
			digest("archiveIndexRoot"),
			digest("blueprintDigest"),
			digest("signerSetDigest"),
			digest("parametersDigest"),
			digest("profileDigest"),
			field("cryptoSuiteId", "enum", {
				values: ["ed25519-sha256-v3", "ed25519-seal-v3"],
				reservedValues: ["p256-sha256-v3"],
				negotiatedAt: "genesis-only",
			}),
		],
		"identityAndVertex"
	),
	historyLeaf: kind("ts-drp/history-leaf/v3", "canonical-object", [
		text("kind", {}, "drp-history-leaf"),
		field("protocolMajor", "safe-integer", {}, 3),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		safe("ordinal", { minimum: 0 }),
		digest("vertexHash"),
	]),
	snapshotPayload: kind("ts-drp/snapshot-payload/v3", "canonical-object-as-single-part", [
		text("kind", {}, "drp-snapshot-payload"),
		field("protocolMajor", "safe-integer", {}, 3),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		digest("anchor"),
		safe("schemaVersion", { minimum: 1 }),
		digest("blueprintDigest"),
		digest("archiveIndexRoot"),
		field("application", "canonical-value"),
		field("acl", "canonical-value"),
	]),
	snapshotChunk: kind("ts-drp/snapshot-chunk/v3", "domain-framed-parts", [
		field("index", "canonical-safe-integer", { minimum: 0 }),
		field("bytes", "bytes"),
	]),
	snapshotManifest: kind("ts-drp/snapshot-manifest/v3", "canonical-object", [
		text("kind", {}, "drp-snapshot-manifest"),
		field("protocolMajor", "safe-integer", {}, 3),
		text("encodingVersion", {}, "drp-canonical-profile-1"),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		digest("anchor"),
		safe("schemaVersion", { minimum: 1 }),
		digest("stateDigest"),
		digest("aclDigest"),
		digest("payloadDigest"),
		safe("totalBytes", { minimum: 0 }),
		field(
			"chunks",
			"array<{index,digest,byteLength}>",
			{ minimumItems: 1, contiguous: true },
			NO_CONST,
			"index-ascending"
		),
	]),
	archivePayload: kind("ts-drp/archive-payload/v3", "canonical-object-as-single-part", [
		text("kind", {}, "drp-archive-segment-payload"),
		field("protocolMajor", "safe-integer", {}, 3),
		safe("schemaVersion", { minimum: 1 }),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		safe("startOrdinal", { minimum: 0 }),
		field("records", "array<canonical-value>", { minimumItems: 1 }, NO_CONST, "linearized-order"),
	]),
	archiveChunk: kind("ts-drp/archive-chunk/v3", "domain-framed-parts", [
		field("objectId", "canonical-string", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		field("startOrdinal", "canonical-safe-integer", { minimum: 0 }),
		field("index", "canonical-safe-integer", { minimum: 0 }),
		field("bytes", "bytes"),
	]),
	archiveSegment: kind("ts-drp/archive-segment/v3", "canonical-object", [
		text("kind", {}, "drp-archive-segment"),
		field("protocolMajor", "safe-integer", {}, 3),
		text("encodingVersion", {}, "drp-canonical-profile-1"),
		safe("schemaVersion", { minimum: 1 }),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		safe("startOrdinal", { minimum: 0 }),
		safe("endOrdinal", { minimum: 0 }),
		safe("recordCount", { minimum: 1 }),
		digest("payloadDigest"),
		safe("totalBytes", { minimum: 0 }),
		field(
			"chunks",
			"array<{index,digest,byteLength}>",
			{ minimumItems: 1, contiguous: true },
			NO_CONST,
			"index-ascending"
		),
	]),
	sealProposal: kind("ts-drp/seal-proposal/v3", "canonical-object", [
		text("kind", {}, "drp-seal-proposal"),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		safe("round", { minimum: 0 }),
		digest("valueDigest"),
	]),
	sealVote: kind(
		"ts-drp/seal-vote/v3",
		"canonical-object",
		[
			text("kind", {}, "drp-seal-vote"),
			text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
			safe("epoch", { minimum: 0 }),
			safe("round", { minimum: 0 }),
			field("phase", "enum", { values: ["prepare", "commit"] }),
			digest("proposalDigest"),
			digest("proposalHash"),
			text("signerId", { charset: "unicode-scalar-excluding-controls", maximumUtf16Units: 512 }),
		],
		"sealVote"
	),
	sealQC: kind("ts-drp/seal-qc/v3", "canonical-object", [
		text("kind", {}, "drp-seal-qc"),
		text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
		safe("epoch", { minimum: 0 }),
		safe("round", { minimum: 0 }),
		field("phase", "enum", { values: ["prepare", "commit"] }),
		digest("proposalDigest"),
		digest("proposalHash"),
		field("votes", "array<signed-seal-vote>", { uniqueBy: "signerId" }, NO_CONST, "codepoint"),
	]),
	roundChange: kind(
		"ts-drp/round-change/v3",
		"canonical-object",
		[
			text("kind", {}, "drp-round-change"),
			text("objectId", { minimumUtf16Units: 1, maximumUtf16Units: 1024 }),
			safe("epoch", { minimum: 0 }),
			digest("anchor"),
			safe("round", { minimum: 0 }),
			text("phase", {}, "round-change"),
			field("highestPrepareQC", "seal-qc|null"),
			text("signerId", { charset: "unicode-scalar-excluding-controls", maximumUtf16Units: 512 }),
		],
		"sealVote"
	),
	profile: kind("ts-drp/profile/v3", "canonical-object", [
		field("profileId", "enum", {
			values: ["creator-trusted-v1", "delegated-trusted-v1", "attested-bft-v1"],
		}),
		field("signers", "array<signer>", { uniqueBy: "signerId" }, NO_CONST, "codepoint"),
		safe("quorum", { creator: 1, delegatedMinimum: 2, attestedFormula: "ceil(2*n/3)" }),
		field("cryptoSuiteId", "enum", {
			values: ["ed25519-sha256-v3", "ed25519-seal-v3"],
			reservedValues: ["p256-sha256-v3"],
			negotiatedAt: "genesis-only",
		}),
	]),
	availabilityPolicy: kind("ts-drp/availability-policy/v3", "canonical-object", [
		text("mode"),
		safe("minRollbackGenerations", { minimum: 0 }),
		safe("minLocalCopies", { minimum: 0 }),
		safe("minMirrorReceipts", { minimum: 0 }),
	]),
	state: kind("ts-drp/state/v3", "canonical-value-as-single-part", [field("state", "canonical-value")]),
});

const ACTIVE_SUITES = Object.freeze({
	identityAndVertex: "ed25519-sha256-v3",
	sealVote: "ed25519-seal-v3",
});

const PREDECESSOR_SUITES = Object.freeze({
	identityAndVertex: "ed25519-sha256-v1",
	sealVote: "ed25519-seal-v1",
});

class CanonicalError extends TypeError {
	constructor(category) {
		super(category);
		this.name = "CanonicalError";
		this.category = category;
	}
}

function required(value, label) {
	if (value === undefined) throw new TypeError(`${label} is required`);
	return value;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value) {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function bytesFromHex(value, label = "hex") {
	if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(value)) {
		throw new TypeError(`${label} must be lowercase even-length hex`);
	}
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function hex(value) {
	return Buffer.from(value).toString("hex");
}

function concat(parts) {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function compareBytes(left, right) {
	return Buffer.compare(left, right);
}

function hydrate(value) {
	if (Array.isArray(value)) return value.map(hydrate);
	if (!isRecord(value)) return value;
	if (Object.keys(value).length === 1 && typeof value.$bytesHex === "string") {
		return bytesFromHex(value.$bytesHex, "$bytesHex");
	}
	if (Object.keys(value).length === 1 && typeof value.$number === "string") {
		switch (value.$number) {
			case "-0":
				return -0;
			case "NaN":
				return Number.NaN;
			case "+Infinity":
				return Number.POSITIVE_INFINITY;
			case "-Infinity":
				return Number.NEGATIVE_INFINITY;
			default:
				throw new TypeError("unknown number carrier");
		}
	}
	if (value.$type === "typed-array" && Array.isArray(value.values)) {
		const values = value.values.map(hydrate);
		switch (value.name) {
			case "float32-array":
				return Float32Array.from(values);
			case "float64-array":
				return Float64Array.from(values);
			case "int32-array":
				return Int32Array.from(values);
			case "uint32-array":
				return Uint32Array.from(values);
			default:
				throw new TypeError("unknown typed-array carrier");
		}
	}
	if (value.$type === "map" && Array.isArray(value.entries)) {
		return new Map(
			value.entries.map((entry) => {
				if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("invalid map carrier");
				return [hydrate(entry[0]), hydrate(entry[1])];
			})
		);
	}
	if (value.$type === "set" && Array.isArray(value.values)) {
		return new Set(value.values.map(hydrate));
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
}

function dehydrate(value) {
	if (value instanceof Uint8Array) return { $bytesHex: hex(value) };
	if (value instanceof Float32Array) {
		return {
			$type: "typed-array",
			name: "float32-array",
			values: [...value].map(dehydrateNumber),
		};
	}
	if (value instanceof Float64Array) {
		return {
			$type: "typed-array",
			name: "float64-array",
			values: [...value].map(dehydrateNumber),
		};
	}
	if (value instanceof Int32Array) {
		return { $type: "typed-array", name: "int32-array", values: [...value] };
	}
	if (value instanceof Uint32Array) {
		return { $type: "typed-array", name: "uint32-array", values: [...value] };
	}
	if (typeof value === "number") return dehydrateNumber(value);
	if (Array.isArray(value)) return value.map(dehydrate);
	if (value instanceof Map) {
		return {
			$type: "map",
			entries: [...value].map(([key, item]) => [dehydrate(key), dehydrate(item)]),
		};
	}
	if (value instanceof Set) return { $type: "set", values: [...value].map(dehydrate) };
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dehydrate(item)]));
}

function dehydrateNumber(value) {
	if (Object.is(value, -0)) return { $number: "-0" };
	if (Number.isNaN(value)) return { $number: "NaN" };
	if (value === Number.POSITIVE_INFINITY) return { $number: "+Infinity" };
	if (value === Number.NEGATIVE_INFINITY) return { $number: "-Infinity" };
	return value;
}

function assertScalarString(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new CanonicalError("UNPAIRED_SURROGATE");
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new CanonicalError("UNPAIRED_SURROGATE");
		}
	}
}

function encodeVaruint(input) {
	let value = typeof input === "bigint" ? input : BigInt(input);
	if (value < 0n || value > MAX_VARUINT) throw new CanonicalError("VARUINT_RANGE");
	const output = [];
	do {
		let octet = Number(value & 0x7fn);
		value >>= 7n;
		if (value !== 0n) octet |= 0x80;
		output.push(octet);
	} while (value !== 0n);
	return Uint8Array.from(output);
}

function typedArrayShape(value) {
	if (value instanceof Float32Array) return ["float32-array", 4, "float"];
	if (value instanceof Float64Array) return ["float64-array", 8, "double"];
	if (value instanceof Int32Array) return ["int32-array", 4, "int"];
	if (value instanceof Uint32Array) return ["uint32-array", 4, "uint"];
	return undefined;
}

function encodeCanonical(value, active = new Set(), depth = 0) {
	if (depth > LIMITS.maxDepth) throw new CanonicalError("DEPTH_LIMIT");
	let encoded;
	if (value === null) {
		encoded = Uint8Array.of(TAG.null);
	} else if (value === false) {
		encoded = Uint8Array.of(TAG.false);
	} else if (value === true) {
		encoded = Uint8Array.of(TAG.true);
	} else if (typeof value === "string") {
		assertScalarString(value);
		const payload = new TextEncoder().encode(value);
		encoded = concat([Uint8Array.of(TAG.string), encodeVaruint(payload.byteLength), payload]);
	} else if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalError("NON_FINITE_SOURCE");
		const normalized = Object.is(value, -0) ? 0 : value;
		if (Number.isInteger(normalized)) {
			if (!Number.isSafeInteger(normalized)) throw new CanonicalError("UNSAFE_INTEGER_SOURCE");
			const integer = BigInt(normalized);
			const zigzag = integer >= 0n ? integer * 2n : -integer * 2n - 1n;
			encoded = concat([Uint8Array.of(TAG.integer), encodeVaruint(zigzag)]);
		} else {
			const payload = new Uint8Array(8);
			new DataView(payload.buffer).setFloat64(0, normalized, false);
			encoded = concat([Uint8Array.of(TAG.float64), payload]);
		}
	} else {
		if (typeof value !== "object") throw new CanonicalError("UNSUPPORTED_SOURCE");
		if (active.has(value)) throw new CanonicalError("CYCLIC_SOURCE");
		active.add(value);
		try {
			if (value instanceof Uint8Array) {
				encoded = concat([Uint8Array.of(TAG.bytes), encodeVaruint(value.byteLength), value]);
			} else {
				const typed = typedArrayShape(value);
				if (typed !== undefined) {
					const [name, width, numericKind] = typed;
					const payload = new Uint8Array(value.length * width);
					const view = new DataView(payload.buffer);
					for (let index = 0; index < value.length; index++) {
						let item = value[index];
						const offset = index * width;
						if (numericKind === "float" || numericKind === "double") {
							if (!Number.isFinite(item)) throw new CanonicalError("NON_FINITE_SOURCE");
							if (Object.is(item, -0)) item = 0;
							if (numericKind === "float") view.setFloat32(offset, item, false);
							else view.setFloat64(offset, item, false);
						} else if (numericKind === "int") {
							view.setInt32(offset, item, false);
						} else {
							view.setUint32(offset, item, false);
						}
					}
					encoded = concat([Uint8Array.of(TAG[name]), encodeVaruint(value.length), payload]);
				} else if (
					ArrayBuffer.isView(value) ||
					value instanceof ArrayBuffer ||
					value instanceof Date ||
					value instanceof RegExp
				) {
					throw new CanonicalError("UNSUPPORTED_SOURCE");
				} else if (Array.isArray(value)) {
					if (value.length > LIMITS.maxItems) throw new CanonicalError("ITEM_LIMIT");
					const parts = [Uint8Array.of(TAG.array), encodeVaruint(value.length)];
					for (let index = 0; index < value.length; index++) {
						if (!Object.hasOwn(value, index)) throw new CanonicalError("SPARSE_ARRAY");
						parts.push(encodeCanonical(value[index], active, depth + 1));
					}
					encoded = concat(parts);
				} else if (value instanceof Map) {
					if (value.size > LIMITS.maxItems) throw new CanonicalError("ITEM_LIMIT");
					const entries = [...value].map(([key, item]) => ({
						key: encodeCanonical(key, active, depth + 1),
						value: encodeCanonical(item, active, depth + 1),
					}));
					entries.sort((left, right) => compareBytes(left.key, right.key));
					rejectEqualEncoded(
						entries.map(({ key }) => key),
						"DUPLICATE_KEY"
					);
					encoded = concat([
						Uint8Array.of(TAG.map),
						encodeVaruint(entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				} else if (value instanceof Set) {
					if (value.size > LIMITS.maxItems) throw new CanonicalError("ITEM_LIMIT");
					const items = [...value].map((item) => encodeCanonical(item, active, depth + 1));
					items.sort(compareBytes);
					rejectEqualEncoded(items, "DUPLICATE_SET_VALUE");
					encoded = concat([Uint8Array.of(TAG.set), encodeVaruint(items.length), ...items]);
				} else {
					if (!isPlainRecord(value)) throw new CanonicalError("NON_PLAIN_OBJECT");
					if (Object.getOwnPropertySymbols(value).length !== 0) {
						throw new CanonicalError("SYMBOL_KEY");
					}
					const entries = [];
					for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
						if (!descriptor.enumerable) continue;
						if (!Object.hasOwn(descriptor, "value")) {
							throw new CanonicalError("ACCESSOR_PROPERTY");
						}
						entries.push({
							key: encodeCanonical(key, active, depth + 1),
							value: encodeCanonical(descriptor.value, active, depth + 1),
						});
					}
					entries.sort((left, right) => compareBytes(left.key, right.key));
					encoded = concat([
						Uint8Array.of(TAG.object),
						encodeVaruint(entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				}
			}
		} finally {
			active.delete(value);
		}
	}
	if (encoded.byteLength > LIMITS.maxBytes) throw new CanonicalError("BYTE_LIMIT");
	return encoded;
}

function rejectEqualEncoded(items, category) {
	for (let index = 1; index < items.length; index++) {
		if (compareBytes(items[index - 1], items[index]) === 0) {
			throw new CanonicalError(category);
		}
	}
}

function decodeCanonical(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (bytes.byteLength > LIMITS.maxBytes) throw new CanonicalError("BYTE_LIMIT");
	const cursor = { bytes, offset: 0, items: 0 };
	const value = decodeValue(cursor, 0);
	if (cursor.offset !== bytes.byteLength) throw new CanonicalError("TRAILING_BYTES");
	return value;
}

function charge(cursor, count = 1) {
	cursor.items += count;
	if (cursor.items > LIMITS.maxItems) throw new CanonicalError("ITEM_LIMIT");
}

function take(cursor, count, category = "TRUNCATED") {
	if (!Number.isSafeInteger(count) || count < 0 || cursor.offset + count > cursor.bytes.byteLength) {
		throw new CanonicalError(category);
	}
	const start = cursor.offset;
	cursor.offset += count;
	return cursor.bytes.subarray(start, cursor.offset);
}

function readVaruint(cursor) {
	let value = 0n;
	let finalGroup = 0;
	for (let index = 0; index < 9; index++) {
		if (cursor.offset >= cursor.bytes.byteLength) throw new CanonicalError("TRUNCATED");
		const octet = cursor.bytes[cursor.offset++];
		const group = octet & 0x7f;
		value |= BigInt(group) << BigInt(index * 7);
		finalGroup = group;
		if ((octet & 0x80) === 0) {
			if (index > 0 && finalGroup === 0) throw new CanonicalError("VARUINT_NON_MINIMAL");
			if (value > MAX_VARUINT) throw new CanonicalError("VARUINT_RANGE");
			return value;
		}
	}
	throw new CanonicalError("VARUINT_RANGE");
}

function hostSize(value) {
	if (value > BigInt(MAX_SAFE)) throw new CanonicalError("VARUINT_RANGE");
	return Number(value);
}

function decodeValue(cursor, depth) {
	if (depth > LIMITS.maxDepth) throw new CanonicalError("DEPTH_LIMIT");
	charge(cursor);
	const tag = take(cursor, 1)[0];
	switch (tag) {
		case TAG.null:
			return null;
		case TAG.false:
			return false;
		case TAG.true:
			return true;
		case TAG.integer: {
			const zigzag = readVaruint(cursor);
			const integer = (zigzag & 1n) === 0n ? zigzag / 2n : -(zigzag + 1n) / 2n;
			if (integer < -BigInt(MAX_SAFE) || integer > BigInt(MAX_SAFE)) {
				throw new CanonicalError("INTEGER_RANGE");
			}
			return Number(integer);
		}
		case TAG.float64: {
			const payload = take(cursor, 8);
			const value = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, false);
			if (!Number.isFinite(value)) throw new CanonicalError("FLOAT_NON_FINITE");
			if (Object.is(value, -0)) throw new CanonicalError("FLOAT_NEGATIVE_ZERO");
			if (Number.isSafeInteger(value)) throw new CanonicalError("FLOAT_SAFE_INTEGRAL");
			return value;
		}
		case TAG.string: {
			const length = hostSize(readVaruint(cursor));
			const payload = take(cursor, length, "UTF8_INVALID");
			try {
				const value = new TextDecoder("utf-8", { fatal: true }).decode(payload);
				assertScalarString(value);
				return value;
			} catch (error) {
				if (error instanceof CanonicalError && error.category !== "UNPAIRED_SURROGATE") throw error;
				throw new CanonicalError("UTF8_INVALID");
			}
		}
		case TAG.bytes: {
			const length = hostSize(readVaruint(cursor));
			return new Uint8Array(take(cursor, length));
		}
		case TAG.array: {
			const count = hostSize(readVaruint(cursor));
			charge(cursor, count);
			return Array.from({ length: count }, () => decodeValue(cursor, depth + 1));
		}
		case TAG.object:
			return decodeObjectOrMap(cursor, depth, true);
		case TAG.map:
			return decodeObjectOrMap(cursor, depth, false);
		case TAG.set: {
			const count = hostSize(readVaruint(cursor));
			charge(cursor, count);
			const output = new Set();
			let previous;
			for (let index = 0; index < count; index++) {
				const start = cursor.offset;
				const value = decodeValue(cursor, depth + 1);
				const encoded = cursor.bytes.subarray(start, cursor.offset);
				if (previous !== undefined && compareBytes(previous, encoded) >= 0) {
					throw new CanonicalError("SET_ORDER_OR_DUPLICATE");
				}
				previous = encoded;
				output.add(value);
			}
			return output;
		}
		case TAG["float32-array"]:
			return decodeTypedArray(cursor, "float32-array", 4);
		case TAG["float64-array"]:
			return decodeTypedArray(cursor, "float64-array", 8);
		case TAG["int32-array"]:
			return decodeTypedArray(cursor, "int32-array", 4);
		case TAG["uint32-array"]:
			return decodeTypedArray(cursor, "uint32-array", 4);
		default:
			throw new CanonicalError("UNKNOWN_TAG");
	}
}

function decodeObjectOrMap(cursor, depth, objectMode) {
	const count = hostSize(readVaruint(cursor));
	charge(cursor, count * 2);
	const output = objectMode ? Object.create(null) : new Map();
	let previous;
	for (let index = 0; index < count; index++) {
		const keyStart = cursor.offset;
		const key = decodeValue(cursor, depth + 1);
		const keyBytes = cursor.bytes.subarray(keyStart, cursor.offset);
		if (previous !== undefined && compareBytes(previous, keyBytes) >= 0) {
			throw new CanonicalError("KEY_ORDER_OR_DUPLICATE");
		}
		previous = keyBytes;
		const value = decodeValue(cursor, depth + 1);
		if (objectMode) {
			if (typeof key !== "string") throw new CanonicalError("OBJECT_KEY_TYPE");
			Object.defineProperty(output, key, {
				configurable: true,
				enumerable: true,
				value,
				writable: true,
			});
		} else {
			output.set(key, value);
		}
	}
	return output;
}

function decodeTypedArray(cursor, name, width) {
	const count = hostSize(readVaruint(cursor));
	charge(cursor, count);
	if (count > Math.floor(MAX_SAFE / width)) throw new CanonicalError("TRUNCATED");
	const payload = take(cursor, count * width);
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const values = [];
	for (let index = 0; index < count; index++) {
		const offset = index * width;
		let value;
		switch (name) {
			case "float32-array":
				value = view.getFloat32(offset, false);
				break;
			case "float64-array":
				value = view.getFloat64(offset, false);
				break;
			case "int32-array":
				value = view.getInt32(offset, false);
				break;
			case "uint32-array":
				value = view.getUint32(offset, false);
				break;
			default:
				throw new TypeError("unknown typed array");
		}
		if (name.startsWith("float")) {
			if (!Number.isFinite(value)) throw new CanonicalError("TYPED_NON_FINITE");
			if (Object.is(value, -0)) throw new CanonicalError("TYPED_NEGATIVE_ZERO");
		}
		values.push(value);
	}
	switch (name) {
		case "float32-array":
			return Float32Array.from(values);
		case "float64-array":
			return Float64Array.from(values);
		case "int32-array":
			return Int32Array.from(values);
		case "uint32-array":
			return Uint32Array.from(values);
		default:
			throw new TypeError("unknown typed array");
	}
}

function compareProtocolStrings(left, right) {
	return compareBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

function normalizeField(value, definition, label) {
	const { constraints, type } = definition;
	switch (type) {
		case "safe-integer":
		case "canonical-safe-integer":
			if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
			break;
		case "string":
		case "canonical-string":
			if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
			assertScalarString(value);
			break;
		case "digest-hex": {
			const byteLength = typeof constraints.bytes === "number" ? constraints.bytes : 32;
			if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, "u").test(value)) {
				throw new TypeError(`${label} must be a lowercase digest`);
			}
			break;
		}
		case "bytes":
			if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
			break;
		case "enum":
			if (!Array.isArray(constraints.values) || !constraints.values.includes(value)) {
				throw new TypeError(`${label} must be an active enum value`);
			}
			break;
		case "canonical-object":
		case "parameters":
			if (!isRecord(value)) throw new TypeError(`${label} must be a canonical object`);
			encodeCanonical(value);
			break;
		case "canonical-value":
			encodeCanonical(value);
			break;
		case "seal-qc|null":
			if (value !== null && !isRecord(value)) throw new TypeError(`${label} must be a seal QC or null`);
			if (value !== null) encodeCanonical(value);
			break;
		default:
			if (!type.startsWith("array<") || !Array.isArray(value)) {
				throw new TypeError(`${label} does not match ${type}`);
			}
			encodeCanonical(value);
	}
	if (typeof constraints.minimum === "number" && (typeof value !== "number" || value < constraints.minimum)) {
		throw new TypeError(`${label} violates minimum`);
	}
	if (typeof constraints.maximum === "number" && (typeof value !== "number" || value > constraints.maximum)) {
		throw new TypeError(`${label} violates maximum`);
	}
	if (
		typeof constraints.minimumUtf16Units === "number" &&
		(typeof value !== "string" || value.length < constraints.minimumUtf16Units)
	) {
		throw new TypeError(`${label} violates minimumUtf16Units`);
	}
	if (
		typeof constraints.maximumUtf16Units === "number" &&
		(typeof value !== "string" || value.length > constraints.maximumUtf16Units)
	) {
		throw new TypeError(`${label} violates maximumUtf16Units`);
	}
	if (
		typeof constraints.minimumItems === "number" &&
		(!Array.isArray(value) || value.length < constraints.minimumItems)
	) {
		throw new TypeError(`${label} violates minimumItems`);
	}
	if (
		typeof constraints.maximumItems === "number" &&
		(!Array.isArray(value) || value.length > constraints.maximumItems)
	) {
		throw new TypeError(`${label} violates maximumItems`);
	}
	if (constraints.charset === "unicode-scalar-excluding-controls" && /[\p{Cc}]/u.test(value)) {
		throw new TypeError(`${label} contains a control character`);
	}
	if (constraints.unique === true && Array.isArray(value)) {
		const keys = value.map((entry) => hex(encodeCanonical(entry)));
		if (new Set(keys).size !== keys.length) throw new TypeError(`${label} violates unique`);
	}
	if (Array.isArray(value) && typeof constraints.uniqueBy === "string") {
		const keys = value.map((entry) => (isRecord(entry) ? entry[constraints.uniqueBy] : undefined));
		if (keys.some((entry) => typeof entry !== "string") || new Set(keys).size !== keys.length) {
			throw new TypeError(`${label} violates uniqueBy`);
		}
	}
	if (Array.isArray(value) && constraints.contiguous === true) {
		const indices = value
			.map((entry) => (isRecord(entry) ? entry.index : undefined))
			.sort((left, right) => (typeof left === "number" && typeof right === "number" ? left - right : 0));
		if (indices.some((entry, index) => entry !== index)) throw new TypeError(`${label} violates contiguous`);
	}
	if (!Array.isArray(value) || definition.sortRule === null) return value;
	switch (definition.sortRule) {
		case "codepoint":
			return [...value].sort((left, right) => {
				const leftKey = typeof left === "string" ? left : isRecord(left) ? left.signerId : undefined;
				const rightKey = typeof right === "string" ? right : isRecord(right) ? right.signerId : undefined;
				if (typeof leftKey !== "string" || typeof rightKey !== "string") {
					throw new TypeError(`${label} cannot be codepoint sorted`);
				}
				return compareProtocolStrings(leftKey, rightKey);
			});
		case "index-ascending":
			return [...value].sort((left, right) => {
				if (
					!isRecord(left) ||
					!isRecord(right) ||
					!Number.isSafeInteger(left.index) ||
					!Number.isSafeInteger(right.index)
				) {
					throw new TypeError(`${label} cannot be index sorted`);
				}
				return left.index - right.index;
			});
		case "linearized-order":
			return [...value];
		default:
			throw new TypeError(`${label} has unknown sort rule`);
	}
}

function buildRegistryValue(kindName, carrierInput) {
	const definition = KINDS[kindName];
	const hydrated = hydrate(carrierInput);
	if (definition === undefined || !isRecord(hydrated)) {
		throw new TypeError(`${kindName} input is not registered`);
	}
	const prepared = { ...hydrated };
	if (kindName === "state") {
		const carrier = prepared.state;
		if (isPlainRecord(carrier)) {
			const replicatedState = { ...carrier };
			delete replicatedState.context;
			prepared.state = replicatedState;
		}
	}
	const allowed = new Set(definition.fields.map(({ name }) => name));
	for (const name of Object.keys(prepared)) {
		if (!allowed.has(name)) throw new TypeError(`${kindName} has unregistered field ${name}`);
	}
	const output = {};
	for (const definitionField of definition.fields) {
		if (!Object.hasOwn(prepared, definitionField.name)) {
			if (definitionField.required) throw new TypeError(`${kindName} omits ${definitionField.name}`);
			continue;
		}
		const value = prepared[definitionField.name];
		if (definitionField.constant !== NO_CONST && value !== definitionField.constant) {
			throw new TypeError(`${kindName}.${definitionField.name} const drift`);
		}
		output[definitionField.name] = normalizeField(value, definitionField, `${kindName}.${definitionField.name}`);
	}
	return output;
}

function registryParts(kindName, value) {
	const definition = required(KINDS[kindName], `registered kind ${kindName}`);
	switch (definition.encoding) {
		case "canonical-object":
		case "canonical-object-as-single-part":
			return [encodeCanonical(value)];
		case "canonical-array":
		case "canonical-value-as-single-part": {
			if (definition.fields.length !== 1) throw new TypeError(`${kindName} single-part shape drift`);
			return [encodeCanonical(value[definition.fields[0].name])];
		}
		case "domain-framed-parts":
			return definition.fields.map((definitionField) => {
				const part = value[definitionField.name];
				if (definitionField.type === "bytes") {
					if (!(part instanceof Uint8Array)) throw new TypeError(`${kindName}.${definitionField.name} is not bytes`);
					return part;
				}
				return encodeCanonical(part);
			});
		default:
			throw new TypeError(`${kindName} has unknown encoding`);
	}
}

function u32be(value) {
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value, false);
	return output;
}

function u64be(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("U64BE input must be safe");
	const output = new Uint8Array(8);
	new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
	return output;
}

function registeredDigest(domain, ...parts) {
	const domainBytes = new TextEncoder().encode(domain);
	const framed = concat([
		bytesFromHex("44525000", "framing magic"),
		u32be(domainBytes.byteLength),
		domainBytes,
		...parts.flatMap((part) => [u64be(part.byteLength), part]),
	]);
	return new Uint8Array(createHash("sha256").update(framed).digest());
}

function validateNegative(request) {
	const kindName = typeof request.kind === "string" ? request.kind : "";
	const definition = KINDS[kindName];
	if (
		typeof request.field === "string" &&
		definition?.fields.find(({ name }) => name === request.field)?.constraints.reservedValues?.includes(request.value)
	) {
		return "reserved-enum";
	}
	if (
		Object.hasOwn(request, "authorSequence") &&
		(!Number.isSafeInteger(request.authorSequence) || request.authorSequence < 0 || request.authorSequence > MAX_SAFE)
	) {
		return "malformed-author-sequence";
	}
	if (kindName === "state" && request.key === "context") {
		return "replica-local-context-on-wire";
	}
	if (
		request.expectedMajor === 3 &&
		request.expectedDomain === definition?.domain &&
		request.candidateDomain === definition.domain.replace(/\/v3$/u, "/v2")
	) {
		return "v2-domain-on-v3";
	}
	if (
		request.expectedMajor === 2 &&
		request.candidateDomain === definition?.domain &&
		request.expectedDomain === definition.domain.replace(/\/v3$/u, "/v2")
	) {
		return "v3-domain-on-v2";
	}
	const suiteRole = definition?.suiteRole;
	if (
		typeof suiteRole === "string" &&
		request.expectedMajor === 3 &&
		request.expectedSuite === ACTIVE_SUITES[suiteRole] &&
		request.candidateSuite === PREDECESSOR_SUITES[suiteRole]
	) {
		return "v2-suite-on-v3";
	}
	if (
		typeof suiteRole === "string" &&
		request.expectedMajor === 2 &&
		request.expectedSuite === PREDECESSOR_SUITES[suiteRole] &&
		request.candidateSuite === ACTIVE_SUITES[suiteRole]
	) {
		return "v3-suite-on-v2";
	}
	if (kindName === "vertex" && request.authorSequence === undefined) {
		return "mechanical-v2-author-sequence-omission";
	}
	if (kindName === "roundChange" && request.anchor === undefined) {
		return "mechanical-v2-anchor-omission";
	}
	return "invalid-registered-value";
}

function privateKeyFromSeed(seed) {
	const prefix = bytesFromHex("302e020100300506032b657004220420", "Ed25519 PKCS8 prefix");
	return createPrivateKey({ key: Buffer.from(concat([prefix, seed])), format: "der", type: "pkcs8" });
}

function publicKeyFromRaw(raw) {
	const prefix = bytesFromHex("302a300506032b6570032100", "Ed25519 SPKI prefix");
	return createPublicKey({ key: Buffer.from(concat([prefix, raw])), format: "der", type: "spki" });
}

function rawPublicKey(privateKey) {
	const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return new Uint8Array(der.subarray(der.byteLength - 32));
}

function rejectedIssuance(before) {
	return {
		accepted: false,
		after: structuredClone(before),
		instrumentation: { digestCalls: 0, publicationCalls: 0, signCalls: 0 },
		published: false,
		registeredDigestHex: null,
		signatureHex: null,
	};
}

function issueNext(request) {
	const before = request.before;
	const current = before?.lastIssued;
	if (!isRecord(before) || !Number.isSafeInteger(current) || before.exhausted === true || current >= MAX_SAFE) {
		return rejectedIssuance(before);
	}
	const next = current + 1;
	if (request.candidate?.authorSequence !== next || typeof request.privateKeyHex !== "string") {
		return rejectedIssuance(before);
	}
	let value;
	try {
		value = buildRegistryValue("vertex", request.candidate);
	} catch {
		return rejectedIssuance(before);
	}
	const privateSeed = bytesFromHex(request.privateKeyHex, "privateKeyHex");
	if (privateSeed.byteLength !== 32) return rejectedIssuance(before);
	let privateKey;
	try {
		privateKey = privateKeyFromSeed(privateSeed);
		if (hex(rawPublicKey(privateKey)) !== request.publicKeyHex) return rejectedIssuance(before);
	} catch {
		return rejectedIssuance(before);
	}
	const digestBytes = registeredDigest(KINDS.vertex.domain, ...registryParts("vertex", value));
	const signature = signMessage(null, digestBytes, privateKey);
	return {
		accepted: true,
		after: {
			...structuredClone(before),
			exhausted: next === MAX_SAFE,
			lastIssued: next,
		},
		instrumentation: { digestCalls: 1, publicationCalls: 1, signCalls: 1 },
		published: true,
		registeredDigestHex: hex(digestBytes),
		signatureHex: hex(signature),
	};
}

function digestReceived(candidate) {
	const received = bytesFromHex(candidate.receivedHex, `${candidate.id}.receivedHex`);
	const reencoded = bytesFromHex(candidate.reencodedHex, `${candidate.id}.reencodedHex`);
	return {
		id: candidate.id,
		receivedDigestHex: hex(registeredDigest(candidate.domain, received)),
		reencodedDigestHex: hex(registeredDigest(candidate.domain, reencoded)),
	};
}

function verifyReceived(candidate) {
	const digestBytes = registeredDigest(
		candidate.domain,
		bytesFromHex(candidate.receivedHex, `${candidate.id}.receivedHex`)
	);
	let accepted = false;
	try {
		const signature = bytesFromHex(candidate.signatureHex, `${candidate.id}.signatureHex`);
		const publicKey = publicKeyFromRaw(bytesFromHex(candidate.publicKeyHex, `${candidate.id}.publicKeyHex`));
		accepted = verifyMessage(null, digestBytes, publicKey, signature);
	} catch {
		accepted = false;
	}
	return { id: candidate.id, accepted, digestHex: hex(digestBytes) };
}

function encodeCase(candidate) {
	const definition = required(KINDS[candidate.kind], `registered kind ${candidate.kind}`);
	const normalized = buildRegistryValue(candidate.kind, candidate.input);
	const parts = registryParts(candidate.kind, normalized);
	return {
		canonicalHex: hex(encodeCanonical(normalized)),
		digestHex: hex(registeredDigest(definition.domain, ...parts)),
		id: candidate.id,
		normalized: dehydrate(normalized),
		partsHex: parts.map(hex),
	};
}

function handle(request) {
	if (!isRecord(request) || !Array.isArray(request.cases)) {
		throw new TypeError("request must contain a cases array");
	}
	switch (request.operation) {
		case "encode-corpus":
			return { results: request.cases.map(encodeCase) };
		case "decode-corpus":
			return {
				results: request.cases.map(({ canonicalHex, id }) => ({
					id,
					value: dehydrate(decodeCanonical(bytesFromHex(canonicalHex, `${id}.canonicalHex`))),
				})),
			};
		case "validate-cases":
			return {
				results: request.cases.map(({ id, request: candidate }) => ({
					accepted: false,
					id,
					reason: validateNegative(candidate),
				})),
			};
		case "issue-next":
			return { results: request.cases.map(({ id, request: candidate }) => ({ id, ...issueNext(candidate) })) };
		case "digest-received":
			return { results: request.cases.map(digestReceived) };
		case "verify-received":
			return { results: request.cases.map(verifyReceived) };
		default:
			throw new TypeError(`unknown operation ${String(request.operation)}`);
	}
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(chunks.join(""));
process.stdout.write(JSON.stringify(handle(request)));
