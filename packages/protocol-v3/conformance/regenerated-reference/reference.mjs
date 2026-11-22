#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as ed25519Sign,
	verify as ed25519Verify,
} from "node:crypto";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DEFAULT_LIMITS = {
	maxBytes: 268_435_456,
	maxDepth: 128,
	maxItems: 1_000_000,
};
const TAG = {
	null: 0x00,
	false: 0x01,
	true: 0x02,
	integer: 0x03,
	float64: 0x04,
	string: 0x05,
	bytes: 0x06,
	array: 0x07,
	object: 0x08,
	map: 0x09,
	set: 0x0a,
	float32Array: 0x0b,
	float64Array: 0x0c,
	int32Array: 0x0d,
	uint32Array: 0x0e,
};

const REGISTRY = {
	signerSet: ["ts-drp/signer-set/v3", "canonical-array", ["signers"]],
	parameters: [
		"ts-drp/parameters/v3",
		"canonical-object",
		[
			"maxEpochVertices",
			"maxEpochBytes",
			"maxDependencies",
			"snapshotChunkBytes",
			"maxSnapshotBytes",
			"maxPendingEntries",
			"maxPendingBytes",
		],
	],
	vertex: [
		"ts-drp/vertex/v3",
		"canonical-object",
		[
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
		],
	],
	cutValue: [
		"ts-drp/hard-epoch-cut/v3",
		"canonical-object",
		[
			"kind",
			"protocolMajor",
			"encodingVersion",
			"objectId",
			"epoch",
			"previousAnchor",
			"previousCutDigest",
			"previousHistoryRoot",
			"previousHistorySize",
			"closeSetRoot",
			"closeSetCount",
			"historyRoot",
			"historySize",
			"stateDigest",
			"aclDigest",
			"snapshotManifestDigest",
			"blueprintDigest",
			"archiveIndexRoot",
			"availabilityPolicyDigest",
			"nextSignerSet",
			"parameters",
			"closeReason",
		],
	],
	epochAnchor: [
		"ts-drp/epoch-anchor/v3",
		"canonical-object",
		[
			"kind",
			"protocolMajor",
			"objectId",
			"epoch",
			"previousAnchor",
			"cutDigest",
			"stateDigest",
			"aclDigest",
			"historyRoot",
			"historySize",
			"archiveIndexRoot",
			"blueprintDigest",
			"signerSetDigest",
			"parametersDigest",
			"profileDigest",
			"cryptoSuiteId",
		],
	],
	historyLeaf: [
		"ts-drp/history-leaf/v3",
		"canonical-object",
		["kind", "protocolMajor", "objectId", "epoch", "ordinal", "vertexHash"],
	],
	snapshotPayload: [
		"ts-drp/snapshot-payload/v3",
		"canonical-object-as-single-part",
		[
			"kind",
			"protocolMajor",
			"objectId",
			"epoch",
			"anchor",
			"schemaVersion",
			"blueprintDigest",
			"archiveIndexRoot",
			"application",
			"acl",
		],
	],
	snapshotChunk: ["ts-drp/snapshot-chunk/v3", "domain-framed-parts", ["index", "bytes"]],
	snapshotManifest: [
		"ts-drp/snapshot-manifest/v3",
		"canonical-object",
		[
			"kind",
			"protocolMajor",
			"encodingVersion",
			"objectId",
			"epoch",
			"anchor",
			"schemaVersion",
			"stateDigest",
			"aclDigest",
			"payloadDigest",
			"totalBytes",
			"chunks",
		],
	],
	archivePayload: [
		"ts-drp/archive-payload/v3",
		"canonical-object-as-single-part",
		["kind", "protocolMajor", "schemaVersion", "objectId", "epoch", "startOrdinal", "records"],
	],
	archiveChunk: ["ts-drp/archive-chunk/v3", "domain-framed-parts", ["objectId", "startOrdinal", "index", "bytes"]],
	archiveSegment: [
		"ts-drp/archive-segment/v3",
		"canonical-object",
		[
			"kind",
			"protocolMajor",
			"encodingVersion",
			"schemaVersion",
			"objectId",
			"epoch",
			"startOrdinal",
			"endOrdinal",
			"recordCount",
			"payloadDigest",
			"totalBytes",
			"chunks",
		],
	],
	sealProposal: ["ts-drp/seal-proposal/v3", "canonical-object", ["kind", "objectId", "epoch", "round", "valueDigest"]],
	sealVote: [
		"ts-drp/seal-vote/v3",
		"canonical-object",
		["kind", "objectId", "epoch", "round", "phase", "proposalDigest", "proposalHash", "signerId"],
	],
	sealQC: [
		"ts-drp/seal-qc/v3",
		"canonical-object",
		["kind", "objectId", "epoch", "round", "phase", "proposalDigest", "proposalHash", "votes"],
	],
	roundChange: [
		"ts-drp/round-change/v3",
		"canonical-object",
		["kind", "objectId", "epoch", "anchor", "round", "phase", "highestPrepareQC", "signerId"],
	],
	profile: ["ts-drp/profile/v3", "canonical-object", ["profileId", "signers", "quorum", "cryptoSuiteId"]],
	availabilityPolicy: [
		"ts-drp/availability-policy/v3",
		"canonical-object",
		["mode", "minRollbackGenerations", "minLocalCopies", "minMirrorReceipts"],
	],
	state: ["ts-drp/state/v3", "canonical-value-as-single-part", ["state"]],
};

const CONSTANTS = {
	vertex: { kind: "drp-vertex", protocolMajor: 3 },
	cutValue: {
		kind: "drp-hard-epoch-cut",
		protocolMajor: 3,
		encodingVersion: "drp-canonical-profile-1",
	},
	epochAnchor: { kind: "drp-epoch-anchor", protocolMajor: 3 },
	historyLeaf: { kind: "drp-history-leaf", protocolMajor: 3 },
	snapshotPayload: { kind: "drp-snapshot-payload", protocolMajor: 3 },
	snapshotManifest: {
		kind: "drp-snapshot-manifest",
		protocolMajor: 3,
		encodingVersion: "drp-canonical-profile-1",
	},
	archivePayload: { kind: "drp-archive-segment-payload", protocolMajor: 3 },
	archiveSegment: {
		kind: "drp-archive-segment",
		protocolMajor: 3,
		encodingVersion: "drp-canonical-profile-1",
	},
	sealProposal: { kind: "drp-seal-proposal" },
	sealVote: { kind: "drp-seal-vote" },
	sealQC: { kind: "drp-seal-qc" },
	roundChange: { kind: "drp-round-change", phase: "round-change" },
};

class CanonicalError extends Error {
	constructor(category) {
		super(category);
		this.category = category;
	}
}

function fail(category) {
	throw new CanonicalError(category);
}

function isCanonicalHex(value, byteLength) {
	return (
		typeof value === "string" &&
		/^(?:[0-9a-f]{2})*$/u.test(value) &&
		(byteLength === undefined || value.length === byteLength * 2)
	);
}

function canonicalHexBytes(value, name, byteLength) {
	if (!isCanonicalHex(value, byteLength)) throw new Error(`${name} must contain canonical lowercase hexadecimal`);
	return Buffer.from(value, "hex");
}

function compareBytes(a, b) {
	return Buffer.compare(a, b);
}

function varuint(value) {
	let n = BigInt(value);
	const bytes = [];
	do {
		let byte = Number(n & 0x7fn);
		n >>= 7n;
		if (n !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (n !== 0n);
	return Buffer.from(bytes);
}

function encodeCount(tag, count) {
	return Buffer.concat([Buffer.from([tag]), varuint(count)]);
}

function sourceValue(value) {
	if (value && typeof value === "object") {
		if (
			Buffer.isBuffer(value) ||
			value instanceof Float32Array ||
			value instanceof Float64Array ||
			value instanceof Int32Array ||
			value instanceof Uint32Array
		)
			return value;
		if (value instanceof Map) return new Map([...value].map(([key, item]) => [sourceValue(key), sourceValue(item)]));
		if (value instanceof Set) return new Set([...value].map(sourceValue));
		if (value.$number === "-0") return -0;
		if (value.$bytesHex !== undefined) return canonicalHexBytes(value.$bytesHex, "$bytesHex");
		if (value.$type === "bytes") return canonicalHexBytes(value.hex, "bytes hex");
		if (value.$type === "map")
			return new Map(value.entries.map(([key, item]) => [sourceValue(key), sourceValue(item)]));
		if (value.$type === "set") return new Set(value.values.map(sourceValue));
		if (value.$type === "null-prototype") {
			const result = Object.create(null);
			for (const [key, item] of value.entries) result[key] = sourceValue(item);
			return result;
		}
		if (value.$type === "typed-array") {
			const items = value.values.map(sourceValue);
			if (value.name === "float32-array") return new Float32Array(items);
			if (value.name === "float64-array") return new Float64Array(items);
			if (value.name === "int32-array") return new Int32Array(items);
			if (value.name === "uint32-array") return new Uint32Array(items);
		}
		if (Array.isArray(value)) return value.map(sourceValue);
		const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
		for (const [key, item] of Object.entries(value))
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: sourceValue(item),
				writable: true,
			});
		return result;
	}
	return value;
}

function jsonValue(value) {
	if (typeof value === "number" && Object.is(value, -0)) return { $number: "-0" };
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytesHex: Buffer.from(value).toString("hex") };
	if (value instanceof Map)
		return {
			$type: "map",
			entries: [...value].map(([key, item]) => [jsonValue(key), jsonValue(item)]),
		};
	if (value instanceof Set) return { $type: "set", values: [...value].map(jsonValue) };
	const typedNames = new Map([
		[Float32Array, "float32-array"],
		[Float64Array, "float64-array"],
		[Int32Array, "int32-array"],
		[Uint32Array, "uint32-array"],
	]);
	for (const [constructor, name] of typedNames)
		if (value instanceof constructor) return { $type: "typed-array", name, values: [...value].map(jsonValue) };
	if (Array.isArray(value)) return value.map(jsonValue);
	if (value && typeof value === "object") {
		const result = Object.create(null);
		for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item);
		return result;
	}
	return value;
}

function encodeCanonical(input, state = { depth: 0, counter: { items: 0 }, limits: DEFAULT_LIMITS }) {
	const value = sourceValue(input);
	const next = (item) =>
		encodeCanonical(item, {
			depth: state.depth + 1,
			counter: state.counter,
			limits: state.limits,
		});
	if (state.depth > state.limits.maxDepth) fail("DEPTH_LIMIT");
	state.counter.items += 1;
	if (state.counter.items > state.limits.maxItems) fail("ITEM_LIMIT");
	if (value === null) return Buffer.from([TAG.null]);
	if (value === false) return Buffer.from([TAG.false]);
	if (value === true) return Buffer.from([TAG.true]);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("FLOAT_NON_FINITE");
		if (Number.isInteger(value) && Number.isSafeInteger(value)) {
			const n = BigInt(Object.is(value, -0) ? 0 : value);
			const zigzag = n >= 0n ? n * 2n : -n * 2n - 1n;
			return Buffer.concat([Buffer.from([TAG.integer]), varuint(zigzag)]);
		}
		const result = Buffer.alloc(9);
		result[0] = TAG.float64;
		result.writeDoubleBE(Object.is(value, -0) ? 0 : value, 1);
		return result;
	}
	if (typeof value === "string") {
		const encoded = Buffer.from(value, "utf8");
		if (encoded.toString("utf8") !== value) fail("UTF8_INVALID");
		return Buffer.concat([encodeCount(TAG.string, encoded.length), encoded]);
	}
	if (Buffer.isBuffer(value) || value instanceof Uint8Array)
		return Buffer.concat([encodeCount(TAG.bytes, value.byteLength), Buffer.from(value)]);
	if (Array.isArray(value)) {
		if (value.length > state.limits.maxItems) fail("ITEM_LIMIT");
		return Buffer.concat([encodeCount(TAG.array, value.length), ...value.map(next)]);
	}
	if (value instanceof Map) {
		if (value.size > state.limits.maxItems) fail("ITEM_LIMIT");
		const pairs = [...value].map(([key, item]) => [next(key), next(item)]);
		pairs.sort((a, b) => compareBytes(a[0], b[0]));
		for (let i = 1; i < pairs.length; i++)
			if (compareBytes(pairs[i - 1][0], pairs[i][0]) === 0) fail("MAP_DUPLICATE_KEY");
		return Buffer.concat([encodeCount(TAG.map, pairs.length), ...pairs.flat()]);
	}
	if (value instanceof Set) {
		if (value.size > state.limits.maxItems) fail("ITEM_LIMIT");
		const values = [...value].map(next).sort(compareBytes);
		for (let i = 1; i < values.length; i++)
			if (compareBytes(values[i - 1], values[i]) === 0) fail("SET_DUPLICATE_VALUE");
		return Buffer.concat([encodeCount(TAG.set, values.length), ...values]);
	}
	if (
		value instanceof Float32Array ||
		value instanceof Float64Array ||
		value instanceof Int32Array ||
		value instanceof Uint32Array
	) {
		if (value.length > state.limits.maxItems) fail("ITEM_LIMIT");
		const width = value.BYTES_PER_ELEMENT;
		const tag =
			value instanceof Float32Array
				? TAG.float32Array
				: value instanceof Float64Array
					? TAG.float64Array
					: value instanceof Int32Array
						? TAG.int32Array
						: TAG.uint32Array;
		const payload = Buffer.alloc(value.length * width);
		for (let i = 0; i < value.length; i++) {
			const item = Object.is(value[i], -0) ? 0 : value[i];
			if ((tag === TAG.float32Array || tag === TAG.float64Array) && !Number.isFinite(item)) fail("FLOAT_NON_FINITE");
			if (tag === TAG.float32Array) payload.writeFloatBE(item, i * width);
			else if (tag === TAG.float64Array) payload.writeDoubleBE(item, i * width);
			else if (tag === TAG.int32Array) payload.writeInt32BE(item, i * width);
			else payload.writeUInt32BE(item, i * width);
		}
		return Buffer.concat([encodeCount(tag, value.length), payload]);
	}
	if (value && typeof value === "object") {
		const pairs = Object.keys(value).map((key) => [next(key), next(value[key])]);
		pairs.sort((a, b) => compareBytes(a[0], b[0]));
		return Buffer.concat([encodeCount(TAG.object, pairs.length), ...pairs.flat()]);
	}
	fail("UNSUPPORTED_VALUE");
}

class Decoder {
	constructor(bytes, limits = {}) {
		this.bytes = bytes;
		this.offset = 0;
		this.items = 0;
		this.limits = { ...DEFAULT_LIMITS, ...limits };
		if (bytes.length > this.limits.maxBytes) fail("BYTE_LIMIT");
	}
	take(length, category = "TRUNCATED") {
		if (this.offset + length > this.bytes.length) fail(category);
		const result = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return result;
	}
	count(depth) {
		if (depth > this.limits.maxDepth) fail("DEPTH_LIMIT");
		this.items += 1;
		if (this.items > this.limits.maxItems) fail("ITEM_LIMIT");
	}
	varuint() {
		let value = 0n;
		let shift = 0n;
		let octets = 0;
		let last = 0;
		while (true) {
			if (this.offset >= this.bytes.length) fail("TRUNCATED");
			const byte = this.bytes[this.offset++];
			octets++;
			if (octets > 9) fail("VARUINT_RANGE");
			last = byte;
			value |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) break;
			shift += 7n;
		}
		if (octets > 1 && (last & 0x7f) === 0) fail("VARUINT_NON_MINIMAL");
		if (value > 18_014_398_509_481_983n) fail("VARUINT_RANGE");
		return value;
	}
	containerCount(multiplier = 1) {
		const count = this.varuint();
		if (count > BigInt(MAX_SAFE)) fail("VARUINT_RANGE");
		const charge = count * BigInt(multiplier);
		if (charge > BigInt(this.limits.maxItems - this.items)) fail("ITEM_LIMIT");
		this.items += Number(charge);
		return Number(count);
	}
	value(depth = 0) {
		this.count(depth);
		const tag = this.take(1)[0];
		if (tag === TAG.null) return null;
		if (tag === TAG.false) return false;
		if (tag === TAG.true) return true;
		if (tag === TAG.integer) {
			const zigzag = this.varuint();
			const signed = (zigzag & 1n) === 0n ? zigzag / 2n : -(zigzag + 1n) / 2n;
			if (signed < -9007199254740991n || signed > 9007199254740991n) fail("INTEGER_RANGE");
			return Number(signed);
		}
		if (tag === TAG.float64) {
			const value = this.take(8).readDoubleBE();
			if (!Number.isFinite(value)) fail("FLOAT_NON_FINITE");
			if (Object.is(value, -0)) fail("FLOAT_NEGATIVE_ZERO");
			if (Number.isSafeInteger(value)) fail("FLOAT_SAFE_INTEGRAL");
			return value;
		}
		if (tag === TAG.string) {
			const length = Number(this.varuint());
			const raw = this.take(length, "UTF8_INVALID");
			const value = raw.toString("utf8");
			if (Buffer.from(value, "utf8").compare(raw) !== 0) fail("UTF8_INVALID");
			return value;
		}
		if (tag === TAG.bytes) return Buffer.from(this.take(Number(this.varuint())));
		if (tag === TAG.array) {
			const count = this.containerCount();
			return Array.from({ length: count }, () => this.value(depth + 1));
		}
		if (tag === TAG.object || tag === TAG.map) {
			const count = this.containerCount(2);
			const object = tag === TAG.object ? Object.create(null) : new Map();
			let previous;
			for (let i = 0; i < count; i++) {
				const start = this.offset;
				const key = this.value(depth + 1);
				const keyBytes = this.bytes.subarray(start, this.offset);
				if (previous) {
					const order = compareBytes(previous, keyBytes);
					if (order >= 0) fail("KEY_ORDER_OR_DUPLICATE");
				}
				const item = this.value(depth + 1);
				if (tag === TAG.object) {
					if (typeof key !== "string") fail("OBJECT_KEY_TYPE");
					object[key] = item;
				} else object.set(key, item);
				previous = keyBytes;
			}
			return object;
		}
		if (tag === TAG.set) {
			const count = this.containerCount();
			const result = new Set();
			let previous;
			for (let i = 0; i < count; i++) {
				const start = this.offset;
				const item = this.value(depth + 1);
				const raw = this.bytes.subarray(start, this.offset);
				if (previous) {
					const order = compareBytes(previous, raw);
					if (order >= 0) fail("SET_ORDER_OR_DUPLICATE");
				}
				result.add(item);
				previous = raw;
			}
			return result;
		}
		if (tag === TAG.float32Array || tag === TAG.float64Array || tag === TAG.int32Array || tag === TAG.uint32Array) {
			const count = this.containerCount();
			const width = tag === TAG.float32Array || tag === TAG.int32Array || tag === TAG.uint32Array ? 4 : 8;
			const raw = this.take(count * width);
			const values = [];
			for (let i = 0; i < count; i++) {
				const at = i * width;
				const item =
					tag === TAG.float32Array
						? raw.readFloatBE(at)
						: tag === TAG.float64Array
							? raw.readDoubleBE(at)
							: tag === TAG.int32Array
								? raw.readInt32BE(at)
								: raw.readUInt32BE(at);
				if (tag === TAG.float32Array || tag === TAG.float64Array) {
					if (!Number.isFinite(item)) fail("TYPED_NON_FINITE");
					if (Object.is(item, -0)) fail("TYPED_NEGATIVE_ZERO");
				}
				values.push(item);
			}
			if (tag === TAG.float32Array) return new Float32Array(values);
			if (tag === TAG.float64Array) return new Float64Array(values);
			if (tag === TAG.int32Array) return new Int32Array(values);
			return new Uint32Array(values);
		}
		fail("UNKNOWN_TAG");
	}
}

function decodeCanonical(hex, limits) {
	const bytes = Buffer.isBuffer(hex) ? hex : canonicalHexBytes(hex, "canonicalHex");
	const decoder = new Decoder(bytes, limits);
	const value = decoder.value();
	if (decoder.offset !== bytes.length) fail("TRAILING_BYTES");
	return value;
}

function compareCodepoints(a, b) {
	const aa = [...a];
	const bb = [...b];
	for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
		const difference = aa[i].codePointAt(0) - bb[i].codePointAt(0);
		if (difference) return difference;
	}
	return aa.length - bb.length;
}

function normalize(kind, input) {
	const record = sourceValue(input);
	const descriptor = REGISTRY[kind];
	if (!descriptor) throw new Error(`unknown kind: ${kind}`);
	const fields = descriptor[2];
	const expected = new Set(fields);
	if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("record must be object");
	for (const key of Object.keys(record)) if (!expected.has(key)) throw new Error(`unknown field: ${key}`);
	for (const field of fields) if (!Object.hasOwn(record, field)) throw new Error(`missing field: ${field}`);
	const constants = CONSTANTS[kind] ?? {};
	for (const [field, constant] of Object.entries(constants))
		if (record[field] !== constant) throw new Error(`wrong constant: ${field}`);
	const result = Object.create(null);
	for (const field of fields) result[field] = record[field];
	for (const field of ["signers", "nextSignerSet"])
		if (Array.isArray(result[field]))
			result[field] = [...result[field]].sort((a, b) => compareCodepoints(a.signerId, b.signerId));
	if (Array.isArray(result.dependencies)) result.dependencies = [...result.dependencies].sort(compareCodepoints);
	if (Array.isArray(result.chunks)) result.chunks = [...result.chunks].sort((a, b) => a.index - b.index);
	if (Array.isArray(result.votes))
		result.votes = [...result.votes].sort((a, b) => compareCodepoints(a.signerId, b.signerId));
	if (kind === "state" && result.state && typeof result.state === "object") {
		const { context: _context, ...replicatedState } = result.state;
		result.state = replicatedState;
	}
	return result;
}

function partsFor(kind, normalized) {
	const encoding = REGISTRY[kind][1];
	if (encoding === "canonical-array") return [encodeCanonical(normalized.signers)];
	if (encoding === "canonical-value-as-single-part") return [encodeCanonical(normalized.state)];
	if (encoding === "domain-framed-parts")
		return REGISTRY[kind][2].map((field) =>
			field === "bytes" ? Buffer.from(normalized[field]) : encodeCanonical(normalized[field])
		);
	return [encodeCanonical(normalized)];
}

function frame(domain, parts) {
	const domainBytes = Buffer.from(domain, "utf8");
	const domainLength = Buffer.alloc(4);
	domainLength.writeUInt32BE(domainBytes.length);
	const framed = [Buffer.from("44525000", "hex"), domainLength, domainBytes];
	for (const part of parts) {
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(part.length));
		framed.push(length, part);
	}
	return Buffer.concat(framed);
}

function digestDomain(domain, parts) {
	return createHash("sha256").update(frame(domain, parts)).digest();
}

function digest(kind, parts) {
	return digestDomain(REGISTRY[kind][0], parts);
}

function caseKind(item) {
	return item.registryKind ?? item.kindName ?? item.kind;
}

function caseRecord(item) {
	return item.record ?? item.input ?? item.value ?? item.preimage;
}

function encodeCase(item) {
	const kind = caseKind(item);
	const normalized = normalize(kind, caseRecord(item));
	const parts = partsFor(kind, normalized);
	return {
		id: item.id,
		normalized: jsonValue(normalized),
		canonicalHex: encodeCanonical(normalized).toString("hex"),
		partsHex: parts.map((part) => part.toString("hex")),
		digestHex: digest(kind, parts).toString("hex"),
	};
}

function validateRecord(kind, input) {
	try {
		const record = normalize(kind, input);
		for (const value of Object.values(record))
			if (typeof value === "number" && !Number.isSafeInteger(value)) return "INVALID_TYPE";
		if (record.authorSequence !== undefined && (record.authorSequence < 0 || record.authorSequence > MAX_SAFE))
			return "OUT_OF_RANGE";
		if (record.phase !== undefined) {
			const values = kind === "roundChange" ? ["round-change"] : ["prepare", "commit"];
			if (!values.includes(record.phase)) return "INVALID_ENUM";
		}
		if (record.cryptoSuiteId !== undefined && !["ed25519-sha256-v3", "ed25519-seal-v3"].includes(record.cryptoSuiteId))
			return "INVALID_ENUM";
		return null;
	} catch (error) {
		if (/missing field/.test(error.message)) return "MISSING_FIELD";
		if (/unknown field/.test(error.message)) return "UNKNOWN_FIELD";
		if (/wrong constant/.test(error.message)) return "WRONG_CONSTANT";
		return "INVALID_TYPE";
	}
}

function validateCase(item) {
	const request = sourceValue(item.request ?? item);
	let reason;
	if (request.field === "cryptoSuiteId" && request.value === "p256-sha256-v3") reason = "reserved-enum";
	else if (
		request.kind === "vertex" &&
		Object.hasOwn(request, "authorSequence") &&
		(!Number.isSafeInteger(request.authorSequence) || request.authorSequence < 0)
	)
		reason = "malformed-author-sequence";
	else if (request.kind === "state" && request.key === "context") reason = "replica-local-context-on-wire";
	else if (request.expectedMajor === 3 && request.candidateDomain?.endsWith("/v2")) reason = "v2-domain-on-v3";
	else if (request.expectedMajor === 2 && request.candidateDomain?.endsWith("/v3")) reason = "v3-domain-on-v2";
	else if (request.expectedMajor === 3 && /^ed25519-(?:sha256|seal)-v1$/u.test(request.candidateSuite))
		reason = "v2-suite-on-v3";
	else if (request.expectedMajor === 2 && /^ed25519-(?:sha256|seal)-v3$/u.test(request.candidateSuite))
		reason = "v3-suite-on-v2";
	else if (request.kind === "vertex" && !Object.hasOwn(request, "authorSequence"))
		reason = "mechanical-v2-author-sequence-omission";
	else if (request.kind === "roundChange" && !Object.hasOwn(request, "anchor"))
		reason = "mechanical-v2-anchor-omission";
	else {
		const kind = caseKind(request);
		reason = kind ? validateRecord(kind, caseRecord(request)) : "INVALID_TYPE";
	}
	return { id: item.id, accepted: reason === null, reason };
}

function privateKeyFromHex(hex) {
	const seed = canonicalHexBytes(hex, "privateKeyHex", 32);
	return createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
}

function publicKeyFromHex(hex) {
	const raw = canonicalHexBytes(hex, "publicKeyHex", 32);
	return createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
		format: "der",
		type: "spki",
	});
}

function publicKeyBytesFromPrivateHex(hex) {
	const der = createPublicKey(privateKeyFromHex(hex)).export({ format: "der", type: "spki" });
	return der.subarray(der.length - 32);
}

function rejectedIssue(item, before, instrumentation) {
	return {
		id: item.id,
		accepted: false,
		after: jsonValue(before),
		instrumentation,
		published: false,
		registeredDigestHex: null,
		signatureHex: null,
	};
}

function issueCase(item) {
	const request = sourceValue(item.request ?? item);
	const before = sourceValue(request.before ?? request.state);
	const current = before?.current ?? before?.authorSequence ?? before?.currentAuthorSequence ?? before?.lastIssued;
	if (!before || !Number.isSafeInteger(current)) throw new Error("invalid issuance state");
	const instrumentation = { digestCalls: 0, publicationCalls: 0, signCalls: 0 };
	if (before.exhausted === true || current >= MAX_SAFE) return rejectedIssue(item, before, instrumentation);
	const next = current + 1;
	if (!Number.isSafeInteger(next)) return rejectedIssue(item, before, instrumentation);
	const template = sourceValue(
		request.candidate ?? request.vertex ?? request.record ?? request.template ?? request.value
	);
	if (
		!template ||
		template.authorSequence !== next ||
		!isCanonicalHex(request.privateKeyHex, 32) ||
		!isCanonicalHex(request.publicKeyHex, 32) ||
		!publicKeyBytesFromPrivateHex(request.privateKeyHex).equals(Buffer.from(request.publicKeyHex, "hex"))
	)
		return rejectedIssue(item, before, instrumentation);
	const normalized = normalize("vertex", template);
	const parts = partsFor("vertex", normalized);
	const digestBytes = digest("vertex", parts);
	instrumentation.digestCalls++;
	const signature = ed25519Sign(null, digestBytes, privateKeyFromHex(request.privateKeyHex));
	instrumentation.signCalls++;
	const after = { ...before, current: next, authorSequence: next, exhausted: next === MAX_SAFE };
	if (!Object.hasOwn(before, "current")) delete after.current;
	if (!Object.hasOwn(before, "authorSequence")) delete after.authorSequence;
	if (Object.hasOwn(before, "currentAuthorSequence")) after.currentAuthorSequence = next;
	if (Object.hasOwn(before, "lastIssued")) after.lastIssued = next;
	instrumentation.publicationCalls++;
	return {
		id: item.id,
		accepted: true,
		after: jsonValue(after),
		instrumentation,
		published: true,
		registeredDigestHex: digestBytes.toString("hex"),
		signatureHex: signature.toString("hex"),
	};
}

function digestReceivedCase(item) {
	const receivedDigest = digestDomain(item.domain, [canonicalHexBytes(item.receivedHex, "receivedHex")]);
	const reencodedDigest = digestDomain(item.domain, [canonicalHexBytes(item.reencodedHex, "reencodedHex")]);
	return {
		id: item.id,
		receivedDigestHex: receivedDigest.toString("hex"),
		reencodedDigestHex: reencodedDigest.toString("hex"),
	};
}

function verifyReceivedCase(item) {
	const parts = [canonicalHexBytes(item.receivedHex, "receivedHex")];
	const digestBytes = digestDomain(item.domain, parts);
	let accepted = false;
	try {
		accepted = ed25519Verify(
			null,
			digestBytes,
			publicKeyFromHex(item.publicKeyHex),
			canonicalHexBytes(item.signatureHex, "signatureHex", 64)
		);
	} catch {
		accepted = false;
	}
	return { id: item.id, accepted, digestHex: digestBytes.toString("hex") };
}

function decodeCase(item) {
	try {
		const value = decodeCanonical(item.canonicalHex ?? item.hex ?? item.inputHex, item.limits);
		return { id: item.id, value: jsonValue(value) };
	} catch (error) {
		if (error instanceof CanonicalError) return { id: item.id, errorCategory: error.category };
		throw error;
	}
}

const OPERATIONS = {
	"encode-corpus": encodeCase,
	"decode-corpus": decodeCase,
	"validate-cases": validateCase,
	"issue-next": issueCase,
	"digest-received": digestReceivedCase,
	"verify-received": verifyReceivedCase,
};

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const request = JSON.parse(input);
	const operation = OPERATIONS[request.operation];
	if (!operation || !Array.isArray(request.cases)) throw new Error("invalid neutral request");
	process.stdout.write(`${JSON.stringify({ results: request.cases.map(operation) })}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error.category ?? error.message}\n`);
	process.exitCode = 1;
});
