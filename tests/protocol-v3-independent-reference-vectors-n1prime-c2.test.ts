import { ed25519 } from "@noble/curves/ed25519.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-c2/independent-reference-vector-contract.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface Provenance {
	path: string;
	sha256: string;
}

interface Grammar {
	authoritativeMarkdown: Provenance;
	collections: {
		arrays: { dense: boolean };
		objects: {
			decodedPrototype: string;
			properties: string;
			sourcePrototypes: string[];
		};
		typedArrays: Record<
			string,
			{
				byteOrder: string;
				element: string;
				finiteOnly: boolean;
				negativeZero: string;
				width: number;
			}
		>;
	};
	conformance: {
		examples: string;
		executableSource: boolean;
		implementationImports: boolean;
		novelCombinations: string;
	};
	format: string;
	limits: {
		bytes: { comparison: string };
		defaults: { maxBytes: number; maxDepth: number; maxItems: number };
		depth: { comparison: string; root: number };
		items: { comparison: string; encodeImmediateKinds: string[] };
	};
	ordering: {
		comparator: string;
		direction: string;
		duplicates: string;
		mapObjectBy: string;
		setBy: string;
	};
	primitives: {
		numbers: {
			byteOrder: string;
			finiteOnly: boolean;
			integerBeforeFloat: boolean;
			negativeZero: string;
			scalarFloatWidth: number;
		};
		strings: {
			encoding: string;
			lengthUnit: string;
			rejectUnpairedSurrogates: boolean;
		};
		varuint: {
			continuationMask: number;
			groupBits: number;
			groupOrder: string;
			maxBytes: number;
			maxValue: string;
			minimal: boolean;
			payloadMask: number;
		};
		zigzag: {
			maximum: string;
			minimum: string;
			negative: string;
			nonNegative: string;
		};
	};
	profile: string;
	recursiveProduction: {
		alternatives: string[];
		children: Record<string, string[]>;
		start: string;
	};
	rules: Array<{ id: string; statement: string }>;
	schemaVersion: number;
	tags: Array<{ name: string; octet: number; payload: string }>;
	workedExamples: Array<{ hex: string; id: string; value: unknown }>;
}

interface RegistryField {
	const: unknown;
	constraints: Record<string, unknown>;
	name: string;
	required: boolean;
	sortRule: string | null;
	type: string;
}

interface RegistryKind {
	domain: string;
	encoding: string;
	fields: RegistryField[];
	signedEnvelope: {
		classification: "signed" | "unsigned";
		suiteRole: string | null;
	};
}

interface Registry {
	canonicalObjectKeyOrder: string;
	codec: { id: string };
	cryptoSuites: {
		active: Array<{ domainKinds: string[]; role: string; suiteId: string }>;
		predecessorAudit: Array<{
			predecessorSuiteId: string;
			role: string;
			successorSuiteId: string;
		}>;
		reserved: Array<{ role: string; suiteId: string }>;
	};
	domains: Record<string, string>;
	endianness: string;
	framing: {
		domainEncoding: string;
		domainLength: string;
		formula: string;
		magicHex: string;
		partLength: string;
	};
	kinds: Record<string, RegistryKind>;
	protocolMajor: number;
	registryVersion: number;
	wireFormat: {
		canonicalPreimage: string;
		digestVerification: string;
		reencodeBeforeDigest: boolean;
		signature: string;
	};
}

interface GoldenVector {
	canonicalHex: string;
	id: string;
	value: unknown;
}

interface GoldenRegistry {
	registryVersion: number;
	vectors: GoldenVector[];
}

interface Vector {
	canonicalHex: string;
	digestHex: string;
	domain: string;
	id: string;
	input: unknown;
	kind: string;
	normalized: unknown;
	partsHex: string[];
	suiteId: string | null;
}

interface NegativeCase {
	category: string;
	id: string;
	request: Record<string, unknown>;
}

interface IssuanceResult {
	accepted: boolean;
	after: Record<string, unknown>;
	instrumentation: {
		digestCalls: number;
		publicationCalls: number;
		signCalls: number;
	};
	published: boolean;
	registeredDigestHex: string | null;
	signatureHex: string | null;
}

interface IssuanceCase {
	expected: IssuanceResult;
	id: string;
	request: {
		before: Record<string, unknown>;
		candidate: Record<string, unknown>;
		privateKeyHex?: string;
		publicKeyHex: string;
	};
}

interface ReceivedCase {
	domain: string;
	expected: { accepted: boolean; digestHex: string };
	id: string;
	publicKeyHex: string;
	receivedHex: string;
	reencodedHex: string;
	signatureHex: string;
}

interface VectorDocument {
	antiCopyDiscriminator: {
		cases: Record<string, string>;
	};
	issuanceCases: IssuanceCase[];
	negativeCases: NegativeCase[];
	protocolMajor: number;
	provenance: {
		grammarMachineSha256: string;
		grammarMarkdownSha256: string;
		originalReferenceSourceSha256: string;
		referenceFixedAt: string;
		registrySha256: string;
		vectorsMintedAt: string;
	};
	receivedCases: ReceivedCase[];
	registryVersion: number;
	schemaVersion: string;
	vectors: Vector[];
}

interface ReferenceProvenance {
	author: {
		agentId: string;
		didNotAuthorNormativeTuple: boolean;
		didNotAuthorRed: boolean;
		readNoImplementationSource: boolean;
		usedExecutionAssistedReconstruction: boolean;
		willNotAuthorRegeneratedReference: boolean;
		willNotAuthorTypescriptPort: boolean;
		willNotMintVectors: boolean;
	};
	normativeInputs: Record<string, Provenance>;
	schemaVersion: string;
	source: {
		fixedAt: string;
		fixedBeforeVectorMinting: boolean;
		path: string;
		sha256: string;
	};
}

interface Contract {
	acceptedInputs: Record<string, Provenance>;
	contextExclusion: {
		excludedKey: string;
		excludedMarker: string;
		kind: string;
		retainedKey: string;
		retainedMarker: string;
		stateCarrierField: string;
		vectorId: string;
	};
	historicalBlockedPair: Record<string, Provenance>;
	opaqueV2Preservation: {
		authority: string;
		corpus: Provenance & {
			expectedCanonicalBytes: number;
			expectedVectorCount: number;
		};
		executionCwd: string;
		packageManifest: Provenance;
		packageName: string;
		resolvedArtifact: Provenance;
	};
	prRuntime: {
		largeFuzzingInThisSlice: boolean;
		opaqueDifferentialMaxMs: number;
		referenceInvocationMaxMs: number;
	};
	redAuthorAttestation: {
		agentId: string;
		oracleAuthority: string;
		readNoImplementationSource: boolean;
		usedExecutionAssistedReconstruction: boolean;
		willNeverAuthor: string[];
	};
	referenceProtocol: {
		operations: string[];
		transport: string;
	};
	requiredAntiCopyMutations: Record<string, string>;
	requiredNegativeCategories: string[];
	schemaVersion: string;
	sequenceContract: {
		exhaustedAt: number;
		lastDurableBeforeSuccess: number;
		rejectionInstrumentation: string[];
		stateField: string;
		successfulNext: number;
	};
	targetArtifacts: Record<string, string>;
}

const contract = contractDocument as Contract;

class GrammarError extends TypeError {}

function readJson<T>(relativePath: string): T {
	return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8")) as T;
}

function sha256File(relativePath: string): string {
	return createHash("sha256")
		.update(readFileSync(join(repositoryRoot, relativePath)))
		.digest("hex");
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`${label} is required`);
	return value;
}

function bytesFromHex(value: string, label = "hex"): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError(`${label} must be lowercase even-length hex`);
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	return Buffer.compare(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function hydrate(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrate);
	if (!isRecord(value)) return value;
	if (Object.keys(value).length === 1 && typeof value.$bytesHex === "string") {
		return bytesFromHex(value.$bytesHex, "$bytesHex");
	}
	if (value.$type === "typed-array" && Array.isArray(value.values)) {
		const values = value.values.map((item) => (isRecord(item) && item.$number === "-0" ? -0 : item)) as number[];
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

function dehydrate(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $bytesHex: hex(value) };
	if (value instanceof Float32Array) return { $type: "typed-array", name: "float32-array", values: [...value] };
	if (value instanceof Float64Array) return { $type: "typed-array", name: "float64-array", values: [...value] };
	if (value instanceof Int32Array) return { $type: "typed-array", name: "int32-array", values: [...value] };
	if (value instanceof Uint32Array) return { $type: "typed-array", name: "uint32-array", values: [...value] };
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

function grammarTag(grammar: Grammar, name: string): number {
	return required(
		grammar.tags.find((candidate) => candidate.name === name),
		`grammar tag ${name}`
	).octet;
}

function encodeVaruint(grammar: Grammar, input: number | bigint): Uint8Array {
	const specification = grammar.primitives.varuint;
	let value = typeof input === "bigint" ? input : BigInt(input);
	if (value < 0n || value > BigInt(specification.maxValue)) throw new GrammarError("VARUINT_RANGE");
	const groups: number[] = [];
	do {
		groups.push(Number(value & BigInt(specification.payloadMask)));
		value >>= BigInt(specification.groupBits);
	} while (value !== 0n);
	if (specification.groupOrder === "most-significant-first") groups.reverse();
	if (groups.length > specification.maxBytes) throw new GrammarError("VARUINT_RANGE");
	return Uint8Array.from(
		groups.map((group, index) => (index === groups.length - 1 ? group : group | specification.continuationMask))
	);
}

function assertScalarString(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new GrammarError("UNPAIRED_SURROGATE");
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new GrammarError("UNPAIRED_SURROGATE");
		}
	}
}

function typedArrayName(value: object): string | undefined {
	if (value instanceof Float32Array) return "float32-array";
	if (value instanceof Float64Array) return "float64-array";
	if (value instanceof Int32Array) return "int32-array";
	if (value instanceof Uint32Array) return "uint32-array";
	return undefined;
}

function limitExceeded(value: number, limit: number, comparison: string): boolean {
	if (comparison !== "greater-than") throw new TypeError(`unsupported grammar comparison ${comparison}`);
	return value > limit;
}

function grammarEncode(
	grammar: Grammar,
	value: unknown,
	active = new Set<object>(),
	depth = grammar.limits.depth.root
): Uint8Array {
	if (limitExceeded(depth, grammar.limits.defaults.maxDepth, grammar.limits.depth.comparison)) {
		throw new GrammarError("DEPTH_LIMIT");
	}
	let encoded: Uint8Array;
	if (value === null) encoded = Uint8Array.of(grammarTag(grammar, "null"));
	else if (value === false) encoded = Uint8Array.of(grammarTag(grammar, "false"));
	else if (value === true) encoded = Uint8Array.of(grammarTag(grammar, "true"));
	else if (typeof value === "string") {
		if (grammar.primitives.strings.rejectUnpairedSurrogates) assertScalarString(value);
		if (grammar.primitives.strings.encoding !== "utf-8" || grammar.primitives.strings.lengthUnit !== "bytes") {
			throw new TypeError("unsupported grammar string production");
		}
		const payload = new TextEncoder().encode(value);
		encoded = concat([
			Uint8Array.of(grammarTag(grammar, "string")),
			encodeVaruint(grammar, payload.byteLength),
			payload,
		]);
	} else if (typeof value === "number") {
		if (grammar.primitives.numbers.finiteOnly && !Number.isFinite(value)) {
			throw new GrammarError("NON_FINITE_SOURCE");
		}
		const normalized =
			grammar.primitives.numbers.negativeZero.startsWith("normalize") && Object.is(value, -0) ? 0 : value;
		if (grammar.primitives.numbers.integerBeforeFloat && Number.isInteger(normalized)) {
			if (!Number.isSafeInteger(normalized)) throw new GrammarError("UNSAFE_INTEGER_SOURCE");
			const integer = BigInt(normalized);
			const zigzag =
				integer >= 0n
					? grammar.primitives.zigzag.nonNegative === "2*n"
						? integer * 2n
						: integer
					: grammar.primitives.zigzag.negative === "-2*n-1"
						? -integer * 2n - 1n
						: -integer * 2n;
			encoded = concat([Uint8Array.of(grammarTag(grammar, "integer")), encodeVaruint(grammar, zigzag)]);
		} else {
			if (grammar.primitives.numbers.scalarFloatWidth !== 8) {
				throw new TypeError("unsupported scalar float width");
			}
			const payload = new Uint8Array(8);
			new DataView(payload.buffer).setFloat64(0, normalized, grammar.primitives.numbers.byteOrder === "little");
			encoded = concat([Uint8Array.of(grammarTag(grammar, "float64")), payload]);
		}
	} else {
		if (typeof value !== "object") throw new GrammarError("UNSUPPORTED_SOURCE");
		if (active.has(value)) throw new GrammarError("CYCLIC_SOURCE");
		active.add(value);
		try {
			if (value instanceof Uint8Array) {
				encoded = concat([
					Uint8Array.of(grammarTag(grammar, "bytes")),
					encodeVaruint(grammar, value.byteLength),
					new Uint8Array(value),
				]);
			} else {
				const typedName = typedArrayName(value);
				if (typedName !== undefined) {
					const specification = required(grammar.collections.typedArrays[typedName], `typed array ${typedName}`);
					const length = (value as { length: number }).length;
					const payload = new Uint8Array(length * specification.width);
					const view = new DataView(payload.buffer);
					for (let index = 0; index < length; index++) {
						let item = (value as unknown as ArrayLike<number>)[index] as number;
						if (specification.finiteOnly && !Number.isFinite(item)) {
							throw new GrammarError("NON_FINITE_SOURCE");
						}
						if (specification.negativeZero.startsWith("normalize") && Object.is(item, -0)) {
							item = 0;
						}
						const offset = index * specification.width;
						const littleEndian = specification.byteOrder === "little";
						if (specification.element === "float32") {
							view.setFloat32(offset, item, littleEndian);
						} else if (specification.element === "float64") {
							view.setFloat64(offset, item, littleEndian);
						} else if (specification.element === "int32") {
							view.setInt32(offset, item, littleEndian);
						} else if (specification.element === "uint32") {
							view.setUint32(offset, item, littleEndian);
						} else {
							throw new TypeError(`unknown typed element ${specification.element}`);
						}
					}
					encoded = concat([Uint8Array.of(grammarTag(grammar, typedName)), encodeVaruint(grammar, length), payload]);
				} else if (
					ArrayBuffer.isView(value) ||
					value instanceof ArrayBuffer ||
					value instanceof Date ||
					value instanceof RegExp
				) {
					throw new GrammarError("UNSUPPORTED_SOURCE");
				} else if (Array.isArray(value)) {
					if (
						grammar.limits.items.encodeImmediateKinds.includes("array") &&
						limitExceeded(value.length, grammar.limits.defaults.maxItems, grammar.limits.items.comparison)
					) {
						throw new GrammarError("ITEM_LIMIT");
					}
					const parts = [Uint8Array.of(grammarTag(grammar, "array")), encodeVaruint(grammar, value.length)];
					for (let index = 0; index < value.length; index++) {
						if (grammar.collections.arrays.dense && !Object.hasOwn(value, index)) {
							throw new GrammarError("SPARSE_ARRAY");
						}
						parts.push(grammarEncode(grammar, value[index], active, depth + 1));
					}
					encoded = concat(parts);
				} else if (value instanceof Map) {
					const entries = [...value].map(([key, item]) => ({
						key: grammarEncode(grammar, key, active, depth + 1),
						value: grammarEncode(grammar, item, active, depth + 1),
					}));
					entries.sort((left, right) => compareBytes(left.key, right.key));
					if (grammar.ordering.direction === "descending") entries.reverse();
					for (let index = 1; index < entries.length; index++) {
						const previous = required(entries[index - 1], "previous map entry");
						const current = required(entries[index], "current map entry");
						if (
							compareBytes(previous.key, current.key) === 0 &&
							grammar.ordering.duplicates === "reject-equal-encoded-bytes"
						) {
							throw new GrammarError("DUPLICATE_KEY");
						}
					}
					encoded = concat([
						Uint8Array.of(grammarTag(grammar, "map")),
						encodeVaruint(grammar, entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				} else if (value instanceof Set) {
					const items = [...value].map((item) => grammarEncode(grammar, item, active, depth + 1));
					items.sort(compareBytes);
					if (grammar.ordering.direction === "descending") items.reverse();
					for (let index = 1; index < items.length; index++) {
						if (
							compareBytes(
								required(items[index - 1], "previous set item"),
								required(items[index], "current set item")
							) === 0 &&
							grammar.ordering.duplicates === "reject-equal-encoded-bytes"
						) {
							throw new GrammarError("DUPLICATE_SET_VALUE");
						}
					}
					encoded = concat([Uint8Array.of(grammarTag(grammar, "set")), encodeVaruint(grammar, items.length), ...items]);
				} else {
					const prototype = Object.getPrototypeOf(value) as object | null;
					const ordinaryAllowed =
						prototype === Object.prototype &&
						grammar.collections.objects.sourcePrototypes.includes("ordinary-object-prototype");
					const nullAllowed =
						prototype === null && grammar.collections.objects.sourcePrototypes.includes("null-prototype");
					if (!ordinaryAllowed && !nullAllowed) throw new GrammarError("NON_PLAIN_OBJECT");
					if (Object.getOwnPropertySymbols(value).length !== 0) {
						throw new GrammarError("SYMBOL_KEY");
					}
					const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
					for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
						if (!descriptor.enumerable) continue;
						if (!Object.hasOwn(descriptor, "value")) {
							throw new GrammarError("ACCESSOR_PROPERTY");
						}
						entries.push({
							key: grammarEncode(grammar, key, active, depth + 1),
							value: grammarEncode(grammar, descriptor.value, active, depth + 1),
						});
					}
					entries.sort((left, right) => compareBytes(left.key, right.key));
					if (grammar.ordering.direction === "descending") entries.reverse();
					encoded = concat([
						Uint8Array.of(grammarTag(grammar, "object")),
						encodeVaruint(grammar, entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				}
			}
		} finally {
			active.delete(value);
		}
	}
	if (limitExceeded(encoded.byteLength, grammar.limits.defaults.maxBytes, grammar.limits.bytes.comparison)) {
		throw new GrammarError("BYTE_LIMIT");
	}
	return encoded;
}

function u32be(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("U64BE input must be safe");
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function hashDomain(registry: Registry, domain: string, ...parts: Uint8Array[]): Uint8Array {
	if (
		registry.framing.magicHex !== "44525000" ||
		registry.framing.domainEncoding !== "utf8" ||
		registry.framing.domainLength !== "U32BE" ||
		registry.framing.partLength !== "U64BE" ||
		registry.endianness !== "big-endian"
	) {
		throw new TypeError("unsupported registry framing");
	}
	const domainBytes = new TextEncoder().encode(domain);
	const framed = concat([
		bytesFromHex(registry.framing.magicHex, "framing magic"),
		u32be(domainBytes.byteLength),
		domainBytes,
		...parts.flatMap((part) => [u64be(part.byteLength), part]),
	]);
	return createHash("sha256").update(framed).digest();
}

const opaqueCodecHelper = String.raw`
import { encodeCanonical, decodeCanonical } from "@ts-drp/canonical";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(chunks.join(""));
const fromHex = value => Uint8Array.from(Buffer.from(value, "hex"));
const hydrate = value => {
  if (Array.isArray(value)) return value.map(hydrate);
  if (value === null || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && typeof value.$bytesHex === "string") return fromHex(value.$bytesHex);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
};
const results = request.vectors.map(vector => {
  const encoded = encodeCanonical(hydrate(vector.value));
  const decoded = decodeCanonical(fromHex(vector.canonicalHex));
  return {
    id: vector.id,
    encodedHex: Buffer.from(encoded).toString("hex"),
    decodedReencodedHex: Buffer.from(encodeCanonical(decoded)).toString("hex")
  };
});
process.stdout.write(JSON.stringify({ resolved: import.meta.resolve("@ts-drp/canonical"), results }));
`;

function runOpaqueV2Differential(expected: Array<{ canonicalHex: string; id: string; value: unknown }>): {
	elapsedMs: number;
	resolved: string;
	results: Array<Record<string, string>>;
} {
	const startedAt = performance.now();
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", opaqueCodecHelper], {
		cwd: join(repositoryRoot, contract.opaqueV2Preservation.executionCwd),
		encoding: "utf8",
		input: JSON.stringify({ vectors: expected }),
		timeout: contract.prRuntime.opaqueDifferentialMaxMs,
	});
	expect(result.error, "opaque v2 package process error").toBeUndefined();
	expect(result.status, `opaque v2 package stderr: ${result.stderr}`).toBe(0);
	expect(result.stderr, "opaque v2 package must keep stderr empty").toBe("");
	return {
		...(JSON.parse(result.stdout) as {
			resolved: string;
			results: Array<Record<string, string>>;
		}),
		elapsedMs: performance.now() - startedAt,
	};
}

function compareProtocolStrings(left: string, right: string): number {
	return compareBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

function normalizeField(grammar: Grammar, value: unknown, field: RegistryField, label: string): unknown {
	const constraints = field.constraints;
	switch (field.type) {
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
			grammarEncode(grammar, value);
			break;
		case "canonical-value":
			grammarEncode(grammar, value);
			break;
		case "seal-qc|null":
			if (value !== null && !isRecord(value)) {
				throw new TypeError(`${label} must be a seal QC or null`);
			}
			if (value !== null) grammarEncode(grammar, value);
			break;
		default:
			if (!field.type.startsWith("array<") || !Array.isArray(value)) {
				throw new TypeError(`${label} does not match ${field.type}`);
			}
			grammarEncode(grammar, value);
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
	if (constraints.unique === true && Array.isArray(value)) {
		const keys = value.map((entry) => hex(grammarEncode(grammar, entry)));
		if (new Set(keys).size !== keys.length) throw new TypeError(`${label} violates unique`);
	}
	if (Array.isArray(value) && typeof constraints.uniqueBy === "string") {
		const keys = value.map((entry) => (isRecord(entry) ? entry[constraints.uniqueBy as string] : undefined));
		if (keys.some((entry) => typeof entry !== "string") || new Set(keys).size !== keys.length) {
			throw new TypeError(`${label} violates uniqueBy`);
		}
	}
	if (!Array.isArray(value) || field.sortRule === null) return value;
	switch (field.sortRule) {
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
				return (left.index as number) - (right.index as number);
			});
		case "linearized-order":
			return [...value];
		default:
			throw new TypeError(`${label} has unknown sort rule`);
	}
}

function buildRegistryValue(
	registry: Registry,
	grammar: Grammar,
	kind: string,
	carrierInput: unknown
): Record<string, unknown> {
	const definition = registry.kinds[kind];
	const hydrated = hydrate(carrierInput);
	if (definition === undefined || !isRecord(hydrated)) {
		throw new TypeError(`${kind} input is not registered`);
	}
	const prepared = { ...hydrated };
	if (kind === contract.contextExclusion.kind) {
		const carrier = prepared[contract.contextExclusion.stateCarrierField];
		if (isRecord(carrier)) {
			const replicatedState = { ...carrier };
			delete replicatedState[contract.contextExclusion.excludedKey];
			prepared[contract.contextExclusion.stateCarrierField] = replicatedState;
		}
	}
	const allowed = new Set(definition.fields.map(({ name }) => name));
	for (const name of Object.keys(prepared)) {
		if (!allowed.has(name)) throw new TypeError(`${kind} has unregistered field ${name}`);
	}
	const output: Record<string, unknown> = {};
	for (const field of definition.fields) {
		if (!Object.hasOwn(prepared, field.name)) {
			if (field.required) throw new TypeError(`${kind} omits ${field.name}`);
			continue;
		}
		const value = prepared[field.name];
		if (field.const !== null && value !== field.const) {
			throw new TypeError(`${kind}.${field.name} const drift`);
		}
		output[field.name] = normalizeField(grammar, value, field, `${kind}.${field.name}`);
	}
	return output;
}

function registryParts(
	registry: Registry,
	grammar: Grammar,
	kind: string,
	value: Record<string, unknown>
): Uint8Array[] {
	const definition = required(registry.kinds[kind], `registry kind ${kind}`);
	switch (definition.encoding) {
		case "canonical-object":
		case "canonical-object-as-single-part":
			return [grammarEncode(grammar, value)];
		case "canonical-array":
		case "canonical-value-as-single-part": {
			const field = required(definition.fields[0], `${kind} single field`);
			if (definition.fields.length !== 1) throw new TypeError(`${kind} single-part shape drift`);
			return [grammarEncode(grammar, value[field.name])];
		}
		case "domain-framed-parts":
			return definition.fields.map((field) => {
				const fieldValue = value[field.name];
				if (field.type === "bytes") {
					if (!(fieldValue instanceof Uint8Array)) {
						throw new TypeError(`${kind}.${field.name} is not bytes`);
					}
					return fieldValue;
				}
				return grammarEncode(grammar, fieldValue);
			});
		default:
			throw new TypeError(`${kind} unknown encoding ${definition.encoding}`);
	}
}

function expectedSuite(registry: Registry, kind: string): string | null {
	const envelope = registry.kinds[kind]?.signedEnvelope;
	if (envelope?.classification !== "signed" || envelope.suiteRole === null) return null;
	return registry.cryptoSuites.active.find(({ role }) => role === envelope.suiteRole)?.suiteId ?? null;
}

function vectorRecordErrors(registry: Registry, grammar: Grammar, vector: Vector): string[] {
	const errors: string[] = [];
	try {
		const normalized = buildRegistryValue(registry, grammar, vector.kind, vector.input);
		const canonical = grammarEncode(grammar, normalized);
		const parts = registryParts(registry, grammar, vector.kind, normalized);
		const definition = required(registry.kinds[vector.kind], `${vector.kind} definition`);
		if (vector.domain !== definition.domain) errors.push("domain");
		if (vector.suiteId !== expectedSuite(registry, vector.kind)) errors.push("suite");
		if (vector.canonicalHex !== hex(canonical)) errors.push("canonical");
		if (JSON.stringify(vector.partsHex) !== JSON.stringify(parts.map(hex))) errors.push("parts");
		if (vector.digestHex !== hex(hashDomain(registry, vector.domain, ...parts))) {
			errors.push("digest");
		}
		if (hex(grammarEncode(grammar, hydrate(vector.normalized))) !== hex(grammarEncode(grammar, normalized))) {
			errors.push("normalized");
		}
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

function negativeCaseLocallyRejects(registry: Registry, candidate: NegativeCase): boolean {
	const request = candidate.request;
	const kind = typeof request.kind === "string" ? request.kind : "";
	const domain = registry.domains[kind];
	switch (candidate.category) {
		case "reserved-enum": {
			const field = registry.kinds[kind]?.fields.find(({ name }) => name === request.field);
			return (
				Array.isArray(field?.constraints.reservedValues) && field.constraints.reservedValues.includes(request.value)
			);
		}
		case "malformed-author-sequence":
			return (
				!Number.isSafeInteger(request.authorSequence) ||
				(request.authorSequence as number) < 0 ||
				(request.authorSequence as number) > Number.MAX_SAFE_INTEGER
			);
		case "mechanical-v2-author-sequence-omission":
			return request.kind === "vertex" && request.authorSequence === undefined;
		case "mechanical-v2-anchor-omission":
			return request.kind === "roundChange" && request.anchor === undefined;
		case "replica-local-context-on-wire":
			return request.kind === contract.contextExclusion.kind && request.key === contract.contextExclusion.excludedKey;
		case "v2-domain-on-v3":
			return (
				request.expectedMajor === 3 &&
				request.expectedDomain === domain &&
				domain?.endsWith("/v3") === true &&
				request.candidateDomain === domain.replace(/\/v3$/u, "/v2")
			);
		case "v3-domain-on-v2":
			return (
				request.expectedMajor === 2 &&
				request.candidateDomain === domain &&
				domain?.endsWith("/v3") === true &&
				request.expectedDomain === domain.replace(/\/v3$/u, "/v2")
			);
		case "v2-suite-on-v3":
			return registry.cryptoSuites.predecessorAudit.some(
				({ predecessorSuiteId, successorSuiteId }) =>
					request.expectedMajor === 3 &&
					request.candidateSuite === predecessorSuiteId &&
					request.expectedSuite === successorSuiteId
			);
		case "v3-suite-on-v2":
			return registry.cryptoSuites.predecessorAudit.some(
				({ predecessorSuiteId, successorSuiteId }) =>
					request.expectedMajor === 2 &&
					request.candidateSuite === successorSuiteId &&
					request.expectedSuite === predecessorSuiteId
			);
		default:
			return false;
	}
}

function antiCopyErrors(discriminator: VectorDocument["antiCopyDiscriminator"], cases: NegativeCase[]): string[] {
	const errors: string[] = [];
	if (
		JSON.stringify(Object.keys(discriminator.cases).sort()) !==
		JSON.stringify(Object.keys(contract.requiredAntiCopyMutations).sort())
	) {
		errors.push("anti-copy mutation set drift");
	}
	if (new Set(Object.values(discriminator.cases)).size !== Object.keys(discriminator.cases).length) {
		errors.push("anti-copy cases must be distinct");
	}
	for (const [mutation, category] of Object.entries(contract.requiredAntiCopyMutations)) {
		const id = discriminator.cases[mutation];
		if (cases.find((candidate) => candidate.id === id)?.category !== category) {
			errors.push(`${mutation} is not bound to ${category}`);
		}
	}
	return errors;
}

function deriveIssuance(registry: Registry, grammar: Grammar, request: IssuanceCase["request"]): IssuanceResult {
	const before = request.before;
	const current = before[contract.sequenceContract.stateField];
	const rejected: IssuanceResult = {
		accepted: false,
		after: clone(before),
		instrumentation: { digestCalls: 0, publicationCalls: 0, signCalls: 0 },
		published: false,
		registeredDigestHex: null,
		signatureHex: null,
	};
	if (
		!Number.isSafeInteger(current) ||
		before.exhausted === true ||
		(current as number) >= contract.sequenceContract.exhaustedAt
	) {
		return rejected;
	}
	const next = (current as number) + 1;
	if (request.candidate.authorSequence !== next || request.privateKeyHex === undefined) {
		return rejected;
	}
	let value: Record<string, unknown>;
	try {
		value = buildRegistryValue(registry, grammar, "vertex", request.candidate);
	} catch {
		return rejected;
	}
	const parts = registryParts(registry, grammar, "vertex", value);
	const digest = hashDomain(registry, required(registry.domains.vertex, "vertex domain"), ...parts);
	const privateKey = bytesFromHex(request.privateKeyHex, "privateKeyHex");
	if (privateKey.byteLength !== 32 || hex(ed25519.getPublicKey(privateKey)) !== request.publicKeyHex) {
		return rejected;
	}
	return {
		accepted: true,
		after: {
			...before,
			exhausted: next === contract.sequenceContract.exhaustedAt,
			[contract.sequenceContract.stateField]: next,
		},
		instrumentation: { digestCalls: 1, publicationCalls: 1, signCalls: 1 },
		published: true,
		registeredDigestHex: hex(digest),
		signatureHex: hex(ed25519.sign(digest, privateKey)),
	};
}

function deriveReceived(registry: Registry, candidate: ReceivedCase): { accepted: boolean; digestHex: string } {
	const digest = hashDomain(
		registry,
		candidate.domain,
		bytesFromHex(candidate.receivedHex, `${candidate.id}.receivedHex`)
	);
	return {
		accepted: ed25519.verify(
			bytesFromHex(candidate.signatureHex, `${candidate.id}.signatureHex`),
			digest,
			bytesFromHex(candidate.publicKeyHex, `${candidate.id}.publicKeyHex`),
			{ zip215: false }
		),
		digestHex: hex(digest),
	};
}

function provenanceErrors(provenance: ReferenceProvenance, sourceBytes: Buffer, vectors: VectorDocument): string[] {
	const errors: string[] = [];
	const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
	if (
		provenance.schemaVersion !== "protocol-v3-original-reference-provenance-v2" ||
		provenance.source.path !== contract.targetArtifacts.referenceSource ||
		provenance.source.sha256 !== sourceHash ||
		!provenance.source.fixedBeforeVectorMinting
	) {
		errors.push("reference source provenance is stale");
	}
	if (
		provenance.author.agentId.length === 0 ||
		provenance.author.agentId === contract.redAuthorAttestation.agentId ||
		!provenance.author.didNotAuthorNormativeTuple ||
		!provenance.author.didNotAuthorRed ||
		!provenance.author.readNoImplementationSource ||
		provenance.author.usedExecutionAssistedReconstruction ||
		!provenance.author.willNotAuthorRegeneratedReference ||
		!provenance.author.willNotAuthorTypescriptPort ||
		!provenance.author.willNotMintVectors
	) {
		errors.push("reference author independence/firewall is not attested");
	}
	if (JSON.stringify(provenance.normativeInputs) !== JSON.stringify(contract.acceptedInputs)) {
		errors.push("reference normative provenance is stale or circular");
	}
	const fixedAt = Date.parse(provenance.source.fixedAt);
	const mintedAt = Date.parse(vectors.provenance.vectorsMintedAt);
	if (
		vectors.provenance.originalReferenceSourceSha256 !== sourceHash ||
		vectors.provenance.referenceFixedAt !== provenance.source.fixedAt ||
		!Number.isFinite(fixedAt) ||
		!Number.isFinite(mintedAt) ||
		fixedAt >= mintedAt
	) {
		errors.push("reference was not fixed before vector minting");
	}
	const sourceText = sourceBytes.toString("utf8");
	if (
		[
			/packages\/(?:canonical|protocol-v2)\/(?:src|dist)/u,
			/@ts-drp\/(?:canonical|protocol-v2)/u,
			/conformance\/(?:ahe-reference|reference-regen)/u,
			/registry-v1\.json/u,
			/conformance\/vectors/u,
		].some((pattern) => pattern.test(sourceText))
	) {
		errors.push("reference imports or points at a forbidden implementation/vector owner");
	}
	const outputs = vectors.vectors.flatMap(({ canonicalHex, digestHex, partsHex }) => [
		canonicalHex,
		digestHex,
		...partsHex,
	]);
	if (outputs.some((output) => output.length >= 32 && sourceText.includes(output))) {
		errors.push("reference bakes vector output bytes");
	}
	return errors;
}

function runReference(sourcePath: string, request: Record<string, unknown>): unknown {
	const directory = mkdtempSync(join(tmpdir(), "protocol-v3-original-reference-c2-"));
	const isolatedSource = join(directory, "reference.mjs");
	try {
		writeFileSync(isolatedSource, readFileSync(sourcePath));
		const result = spawnSync(process.execPath, [isolatedSource], {
			cwd: directory,
			encoding: "utf8",
			input: `${JSON.stringify(request)}\n`,
			timeout: contract.prRuntime.referenceInvocationMaxMs,
		});
		expect(result.error, "independent reference process error").toBeUndefined();
		expect(result.status, `reference stderr: ${result.stderr}`).toBe(0);
		expect(result.stderr, "reference stderr").toBe("");
		return JSON.parse(result.stdout) as unknown;
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

describe("Phase -1'c corrected independent original v3 reference and vectors RED", () => {
	it("pins the accepted seven-decision tuple, grammar and preserved historical RED pair", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-c2-independent-reference-vectors-v1");
		expect(contract.redAuthorAttestation).toMatchObject({
			readNoImplementationSource: true,
			usedExecutionAssistedReconstruction: false,
		});
		expect(new Set(contract.redAuthorAttestation.willNeverAuthor)).toEqual(
			new Set(["original-v3-reference", "v3-vector-mint", "regenerated-v3-reference", "typescript-v3-codec-port"])
		);
		for (const provenance of [
			...Object.values(contract.acceptedInputs),
			...Object.values(contract.historicalBlockedPair),
			contract.opaqueV2Preservation.corpus,
			contract.opaqueV2Preservation.packageManifest,
			contract.opaqueV2Preservation.resolvedArtifact,
		]) {
			expect(existsSync(join(repositoryRoot, provenance.path)), provenance.path).toBe(true);
			expect(sha256File(provenance.path), provenance.path).toBe(provenance.sha256);
		}
		const grammar = readJson<Grammar>(contract.acceptedInputs.grammarMachine?.path ?? "");
		expect(grammar.authoritativeMarkdown).toEqual(contract.acceptedInputs.grammarMarkdown);
		expect(grammar.profile).toBe("drp-canonical-profile-1");
		expect(grammar.conformance).toMatchObject({
			executableSource: false,
			implementationImports: false,
			novelCombinations: "evaluate-from-recursive-production-only",
		});
		expect(contract.prRuntime.largeFuzzingInThisSlice).toBe(false);

		const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
		expect(source).not.toMatch(
			/from ["'][^"']*(?:packages\/canonical|packages\/protocol-v2)\/(?:src|dist)|import\(["'][^"']*(?:packages\/canonical|packages\/protocol-v2)\/(?:src|dist)/u
		);
		expect(source).not.toMatch(
			/conformance\/(?:ahe-reference|original-reference|reference-regen)\/[^"']+\.(?:mjs|js|ts)/u
		);
	});

	it("derives bytes from grammar data, kills semantic grammar mutants, then executes the full opaque v2 corpus", () => {
		const grammar = readJson<Grammar>(required(contract.acceptedInputs.grammarMachine, "grammar").path);
		const golden = readJson<GoldenRegistry>(contract.opaqueV2Preservation.corpus.path);
		expect(golden.registryVersion).toBe(5);
		expect(golden.vectors).toHaveLength(contract.opaqueV2Preservation.corpus.expectedVectorCount);

		const integerExpected = hex(grammarEncode(grammar, 8192));
		const floatExpected = hex(grammarEncode(grammar, 1.5));
		const objectExpected = hex(grammarEncode(grammar, { aa: 1, z: 2 }));
		const longStringExpected = hex(grammarEncode(grammar, "x".repeat(130)));
		expect(integerExpected).toBe("03808001");
		expect(floatExpected).toBe("043ff8000000000000");
		expect(objectExpected).toBe("080205017a0304050261610302");
		expect(longStringExpected.startsWith("058201")).toBe(true);

		const tagMutant = clone(grammar);
		required(
			tagMutant.tags.find(({ name }) => name === "integer"),
			"integer tag"
		).octet = 15;
		expect(hex(grammarEncode(tagMutant, 8192))).not.toBe(integerExpected);

		const varuintMutant = clone(grammar);
		varuintMutant.primitives.varuint.groupOrder = "most-significant-first";
		expect(hex(grammarEncode(varuintMutant, 8192))).not.toBe(integerExpected);
		expect(hex(grammarEncode(varuintMutant, "x".repeat(130)))).not.toBe(longStringExpected);

		const endianMutant = clone(grammar);
		endianMutant.primitives.numbers.byteOrder = "little";
		endianMutant.collections.typedArrays["float32-array"] = {
			...required(endianMutant.collections.typedArrays["float32-array"], "float32-array grammar"),
			byteOrder: "little",
		};
		expect(hex(grammarEncode(endianMutant, 1.5))).not.toBe(floatExpected);
		expect(hex(grammarEncode(endianMutant, Float32Array.of(1.5)))).not.toBe(
			hex(grammarEncode(grammar, Float32Array.of(1.5)))
		);

		const orderMutant = clone(grammar);
		orderMutant.ordering.direction = "descending";
		expect(hex(grammarEncode(orderMutant, { aa: 1, z: 2 }))).not.toBe(objectExpected);

		const vectorOverride = { canonicalHex: "00", value: { aa: 1, z: 2 } };
		expect(hex(grammarEncode(grammar, vectorOverride.value))).toBe(objectExpected);
		expect(hex(grammarEncode(grammar, vectorOverride.value))).not.toBe(vectorOverride.canonicalHex);

		const fixedOracle = golden.vectors.map((vector) => {
			const encoded = grammarEncode(grammar, hydrate(vector.value));
			expect(hex(encoded), `${vector.id}: grammar versus pinned v2 corpus`).toBe(vector.canonicalHex);
			return { id: vector.id, canonicalHex: hex(encoded), value: vector.value };
		});
		const canonicalBytes = fixedOracle.reduce((total, vector) => total + vector.canonicalHex.length / 2, 0);
		expect(canonicalBytes).toBe(contract.opaqueV2Preservation.corpus.expectedCanonicalBytes);

		// The black box executes only after every expected byte above is fixed by the grammar oracle.
		const opaque = runOpaqueV2Differential(fixedOracle);
		expect(fileURLToPath(opaque.resolved)).toBe(
			resolve(repositoryRoot, contract.opaqueV2Preservation.resolvedArtifact.path)
		);
		expect(opaque.elapsedMs).toBeLessThanOrEqual(contract.prRuntime.opaqueDifferentialMaxMs);
		expect(opaque.results).toEqual(
			fixedOracle.map(({ canonicalHex, id }) => ({
				decodedReencodedHex: canonicalHex,
				encodedHex: canonicalHex,
				id,
			}))
		);
	});

	it("proves context exclusion, corrected exhaustion, exact-byte Ed25519 and anti-copy semantics before GREEN exists", () => {
		const grammar = readJson<Grammar>(required(contract.acceptedInputs.grammarMachine, "grammar").path);
		const registry = readJson<Registry>(required(contract.acceptedInputs.registry, "registry").path);
		expect(registry.protocolMajor).toBe(3);
		expect(registry.registryVersion).toBe(1);
		expect(registry.codec.id).toBe(grammar.profile);
		expect(registry.endianness).toBe("big-endian");
		expect(Object.keys(registry.kinds)).toHaveLength(19);

		const contextInput = {
			state: {
				context: {
					caller: contract.contextExclusion.excludedMarker,
				},
				semanticsType: "map",
				values: {
					message: contract.contextExclusion.retainedMarker,
				},
			},
		};
		const normalizedState = buildRegistryValue(registry, grammar, "state", contextInput);
		const stateCarrier = required(
			normalizedState[contract.contextExclusion.stateCarrierField] as Record<string, unknown> | undefined,
			"normalized state carrier"
		);
		expect(Object.hasOwn(stateCarrier, contract.contextExclusion.excludedKey)).toBe(false);
		expect(Object.hasOwn(stateCarrier, contract.contextExclusion.retainedKey)).toBe(true);
		const stateBytes = grammarEncode(grammar, stateCarrier);
		expect(Buffer.from(stateBytes).includes(Buffer.from(contract.contextExclusion.excludedKey))).toBe(false);
		expect(Buffer.from(stateBytes).includes(Buffer.from(contract.contextExclusion.excludedMarker))).toBe(false);
		expect(Buffer.from(stateBytes).includes(Buffer.from(contract.contextExclusion.retainedKey))).toBe(true);
		expect(Buffer.from(stateBytes).includes(Buffer.from(contract.contextExclusion.retainedMarker))).toBe(true);

		const stateParts = registryParts(registry, grammar, "state", normalizedState);
		const stateVector: Vector = {
			canonicalHex: hex(grammarEncode(grammar, normalizedState)),
			digestHex: hex(hashDomain(registry, registry.domains.state as string, ...stateParts)),
			domain: registry.domains.state as string,
			id: contract.contextExclusion.vectorId,
			input: contextInput,
			kind: "state",
			normalized: normalizedState,
			partsHex: stateParts.map(hex),
			suiteId: null,
		};
		expect(vectorRecordErrors(registry, grammar, stateVector)).toEqual([]);
		const byteMutant = clone(stateVector);
		byteMutant.canonicalHex = "00";
		expect(vectorRecordErrors(registry, grammar, byteMutant)).toContain("canonical");
		const digestMutant = clone(stateVector);
		digestMutant.digestHex = "00".repeat(32);
		expect(vectorRecordErrors(registry, grammar, digestMutant)).toContain("digest");

		const anchor = "00".repeat(32);
		const privateKey = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);
		const candidate = {
			anchor,
			author: "independent-reference-author",
			authorSequence: contract.sequenceContract.successfulNext,
			dependencies: ["11".repeat(32)],
			epoch: 7,
			kind: "drp-vertex",
			logicalTime: 9,
			objectId: "object:sequence-boundary",
			operation: { action: "set", key: "boundary", value: true },
			protocolMajor: 3,
		};
		expect(
			buildRegistryValue(registry, grammar, "vertex", candidate).authorSequence,
			"receiving MAX_SAFE is valid"
		).toBe(Number.MAX_SAFE_INTEGER);
		const successfulRequest: IssuanceCase["request"] = {
			before: {
				anchor,
				epoch: 7,
				exhausted: false,
				lastIssued: contract.sequenceContract.lastDurableBeforeSuccess,
			},
			candidate,
			privateKeyHex: hex(privateKey),
			publicKeyHex: hex(ed25519.getPublicKey(privateKey)),
		};
		const issued = deriveIssuance(registry, grammar, successfulRequest);
		expect(issued).toMatchObject({
			accepted: true,
			after: {
				exhausted: true,
				lastIssued: Number.MAX_SAFE_INTEGER,
			},
			instrumentation: { digestCalls: 1, publicationCalls: 1, signCalls: 1 },
			published: true,
		});
		expect(
			ed25519.verify(
				bytesFromHex(required(issued.signatureHex ?? undefined, "issued signature")),
				bytesFromHex(required(issued.registeredDigestHex ?? undefined, "issued digest")),
				ed25519.getPublicKey(privateKey),
				{ zip215: false }
			)
		).toBe(true);

		const exhaustedRequest = clone(successfulRequest);
		exhaustedRequest.before = {
			...successfulRequest.before,
			exhausted: true,
			lastIssued: Number.MAX_SAFE_INTEGER,
		};
		delete exhaustedRequest.privateKeyHex;
		const rejected = deriveIssuance(registry, grammar, exhaustedRequest);
		expect(rejected).toEqual({
			accepted: false,
			after: exhaustedRequest.before,
			instrumentation: { digestCalls: 0, publicationCalls: 0, signCalls: 0 },
			published: false,
			registeredDigestHex: null,
			signatureHex: null,
		});

		const vertexValue = buildRegistryValue(registry, grammar, "vertex", candidate);
		const vertexParts = registryParts(registry, grammar, "vertex", vertexValue);
		const receivedBytes = grammarEncode(grammar, vertexValue);
		const receivedDigest = hashDomain(registry, registry.domains.vertex as string, receivedBytes);
		const received: ReceivedCase = {
			domain: registry.domains.vertex as string,
			expected: { accepted: true, digestHex: hex(receivedDigest) },
			id: "received-vertex-exact-preimage",
			publicKeyHex: hex(ed25519.getPublicKey(privateKey)),
			receivedHex: hex(receivedBytes),
			reencodedHex: hex(concat([...vertexParts, Uint8Array.of(0)])),
			signatureHex: hex(ed25519.sign(receivedDigest, privateKey)),
		};
		expect(deriveReceived(registry, received)).toEqual(received.expected);
		const changedBytes = clone(received);
		changedBytes.receivedHex = `${received.receivedHex.slice(0, -2)}${
			received.receivedHex.endsWith("00") ? "01" : "00"
		}`;
		expect(deriveReceived(registry, changedBytes).accepted).toBe(false);

		const reserved = required(
			required(
				registry.kinds.epochAnchor?.fields.find(({ name }) => name === "cryptoSuiteId"),
				"epochAnchor.cryptoSuiteId"
			).constraints.reservedValues as unknown[] | undefined,
			"reserved suite values"
		)[0];
		const identityAudit = required(
			registry.cryptoSuites.predecessorAudit.find(({ role }) => role === "identityAndVertex"),
			"identity suite audit"
		);
		const negativeCases: NegativeCase[] = [
			{
				category: "mechanical-v2-author-sequence-omission",
				id: "anti-copy-sequence",
				request: { kind: "vertex" },
			},
			{
				category: "mechanical-v2-anchor-omission",
				id: "anti-copy-anchor",
				request: { kind: "roundChange" },
			},
			{
				category: "reserved-enum",
				id: "anti-copy-reserved",
				request: { field: "cryptoSuiteId", kind: "epochAnchor", value: reserved },
			},
			{
				category: "replica-local-context-on-wire",
				id: "anti-copy-context",
				request: { key: "context", kind: "state" },
			},
			{
				category: "v2-domain-on-v3",
				id: "anti-copy-domain",
				request: {
					candidateDomain: (registry.domains.vertex as string).replace(/\/v3$/u, "/v2"),
					expectedDomain: registry.domains.vertex,
					expectedMajor: 3,
					kind: "vertex",
				},
			},
			{
				category: "v2-suite-on-v3",
				id: "anti-copy-suite",
				request: {
					candidateSuite: identityAudit.predecessorSuiteId,
					expectedMajor: 3,
					expectedSuite: identityAudit.successorSuiteId,
					kind: "vertex",
				},
			},
		];
		const discriminator: VectorDocument["antiCopyDiscriminator"] = {
			cases: {
				"activate-reserved-suite": "anti-copy-reserved",
				"omit-authorSequence": "anti-copy-sequence",
				"omit-roundChange-anchor": "anti-copy-anchor",
				"retain-replica-context": "anti-copy-context",
				"reuse-v2-domain": "anti-copy-domain",
				"reuse-v2-suite": "anti-copy-suite",
			},
		};
		expect(antiCopyErrors(discriminator, negativeCases)).toEqual([]);
		expect(negativeCases.every((entry) => negativeCaseLocallyRejects(registry, entry))).toBe(true);
		expect(
			negativeCases.map(({ id }) => ({ accepted: true, id })),
			"a mechanical v2 transliteration accepts every discriminator and therefore cannot pass"
		).not.toEqual(negativeCases.map(({ category, id }) => ({ accepted: false, id, reason: category })));
	});

	it("kills reference-firewall, chronology and claimed-output override mutants without target files", () => {
		const source = Buffer.from("export const profile = 'drp-canonical-profile-1';\n", "utf8");
		const sourceHash = createHash("sha256").update(source).digest("hex");
		const provenance: ReferenceProvenance = {
			author: {
				agentId: "fresh-independent-green-reference-author",
				didNotAuthorNormativeTuple: true,
				didNotAuthorRed: true,
				readNoImplementationSource: true,
				usedExecutionAssistedReconstruction: false,
				willNotAuthorRegeneratedReference: true,
				willNotAuthorTypescriptPort: true,
				willNotMintVectors: true,
			},
			normativeInputs: clone(contract.acceptedInputs),
			schemaVersion: "protocol-v3-original-reference-provenance-v2",
			source: {
				fixedAt: "2026-07-27T20:00:00.000Z",
				fixedBeforeVectorMinting: true,
				path: required(contract.targetArtifacts.referenceSource, "reference source"),
				sha256: sourceHash,
			},
		};
		const vectors: VectorDocument = {
			antiCopyDiscriminator: { cases: {} },
			issuanceCases: [],
			negativeCases: [],
			protocolMajor: 3,
			provenance: {
				grammarMachineSha256: required(contract.acceptedInputs.grammarMachine, "grammar machine").sha256,
				grammarMarkdownSha256: required(contract.acceptedInputs.grammarMarkdown, "grammar markdown").sha256,
				originalReferenceSourceSha256: sourceHash,
				referenceFixedAt: provenance.source.fixedAt,
				registrySha256: required(contract.acceptedInputs.registry, "registry").sha256,
				vectorsMintedAt: "2026-07-27T20:00:01.000Z",
			},
			receivedCases: [],
			registryVersion: 1,
			schemaVersion: "protocol-v3-registry-v1-vectors-v2",
			vectors: [],
		};
		expect(provenanceErrors(provenance, source, vectors)).toEqual([]);

		const firewallMutant = clone(provenance);
		firewallMutant.author.readNoImplementationSource = false;
		expect(provenanceErrors(firewallMutant, source, vectors)).toContain(
			"reference author independence/firewall is not attested"
		);
		const importedSource = Buffer.from('import "@ts-drp/canonical";\n', "utf8");
		expect(provenanceErrors(provenance, importedSource, vectors)).toContain(
			"reference imports or points at a forbidden implementation/vector owner"
		);
		const chronologyMutant = clone(vectors);
		chronologyMutant.provenance.vectorsMintedAt = provenance.source.fixedAt;
		expect(provenanceErrors(provenance, source, chronologyMutant)).toContain(
			"reference was not fixed before vector minting"
		);

		const directory = mkdtempSync(join(tmpdir(), "protocol-v3-claimed-output-mutant-"));
		const sourcePath = join(directory, "claimed-output.mjs");
		try {
			writeFileSync(
				sourcePath,
				'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({results:[{id:"claim",canonicalHex:"00"}]})));\n'
			);
			const claimed = runReference(sourcePath, { operation: "encode-corpus", cases: [] });
			const grammar = readJson<Grammar>(required(contract.acceptedInputs.grammarMachine, "grammar").path);
			const expected = {
				results: [{ id: "claim", canonicalHex: hex(grammarEncode(grammar, { aa: 1, z: 2 })) }],
			};
			expect(claimed).not.toEqual(expected);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("requires an independently fixed reference and separately minted registry-built vectors to reproduce the oracle", () => {
		const missing = Object.entries(contract.targetArtifacts)
			.filter(([, relativePath]) => !existsSync(join(repositoryRoot, relativePath)))
			.map(([name, relativePath]) => `${name}: ${relativePath}`);
		expect(
			missing,
			"Phase -1'c GREEN must supply all three independently governed artifacts; later assertions prove semantic and byte reproduction"
		).toEqual([]);

		const grammar = readJson<Grammar>(required(contract.acceptedInputs.grammarMachine, "grammar").path);
		const registry = readJson<Registry>(required(contract.acceptedInputs.registry, "registry").path);
		const sourcePath = join(repositoryRoot, required(contract.targetArtifacts.referenceSource, "referenceSource"));
		const provenance = readJson<ReferenceProvenance>(
			required(contract.targetArtifacts.referenceProvenance, "referenceProvenance")
		);
		const vectorDocument = readJson<VectorDocument>(required(contract.targetArtifacts.vectors, "vectors"));
		const sourceBytes = readFileSync(sourcePath);
		expect(provenanceErrors(provenance, sourceBytes, vectorDocument)).toEqual([]);
		expect(vectorDocument).toMatchObject({
			protocolMajor: registry.protocolMajor,
			registryVersion: registry.registryVersion,
			schemaVersion: "protocol-v3-registry-v1-vectors-v2",
		});
		expect(vectorDocument.provenance).toMatchObject({
			grammarMachineSha256: contract.acceptedInputs.grammarMachine?.sha256,
			grammarMarkdownSha256: contract.acceptedInputs.grammarMarkdown?.sha256,
			registrySha256: contract.acceptedInputs.registry?.sha256,
		});

		expect(new Set(vectorDocument.vectors.map(({ id }) => id)).size).toBe(vectorDocument.vectors.length);
		expect(new Set(vectorDocument.vectors.map(({ kind }) => kind))).toEqual(new Set(Object.keys(registry.kinds)));
		const enumCoverage = new Map<string, Set<unknown>>();
		const sequenceCoverage = new Set<unknown>();
		for (const vector of vectorDocument.vectors) {
			expect(vectorRecordErrors(registry, grammar, vector), vector.id).toEqual([]);
			const normalized = buildRegistryValue(registry, grammar, vector.kind, vector.input);
			for (const field of required(registry.kinds[vector.kind], vector.kind).fields.filter(
				({ type }) => type === "enum"
			)) {
				const key = `${vector.kind}.${field.name}`;
				const observed = enumCoverage.get(key) ?? new Set<unknown>();
				observed.add(normalized[field.name]);
				enumCoverage.set(key, observed);
			}
			if (vector.kind === "vertex") sequenceCoverage.add(normalized.authorSequence);
		}
		for (const [kind, definition] of Object.entries(registry.kinds)) {
			for (const field of definition.fields.filter(({ type }) => type === "enum")) {
				expect(enumCoverage.get(`${kind}.${field.name}`), `${kind}.${field.name}`).toEqual(
					new Set(field.constraints.values as unknown[])
				);
			}
		}
		for (const boundary of [0, 1, Number.MAX_SAFE_INTEGER]) {
			expect(sequenceCoverage.has(boundary), `vertex authorSequence ${boundary}`).toBe(true);
		}

		const contextVector = required(
			vectorDocument.vectors.find(({ id }) => id === contract.contextExclusion.vectorId),
			"context exclusion state vector"
		);
		expect(contextVector.kind).toBe(contract.contextExclusion.kind);
		const rawContextInput = hydrate(contextVector.input);
		const rawState = required(
			isRecord(rawContextInput)
				? (rawContextInput[contract.contextExclusion.stateCarrierField] as Record<string, unknown> | undefined)
				: undefined,
			"raw context state"
		);
		expect(rawState[contract.contextExclusion.excludedKey]).toBeDefined();
		const normalizedContext = buildRegistryValue(registry, grammar, contextVector.kind, contextVector.input);
		const normalizedState = required(
			normalizedContext[contract.contextExclusion.stateCarrierField] as Record<string, unknown> | undefined,
			"normalized context state"
		);
		expect(Object.hasOwn(normalizedState, contract.contextExclusion.excludedKey)).toBe(false);
		const contextBytes = bytesFromHex(contextVector.canonicalHex, "context canonicalHex");
		expect(Buffer.from(contextBytes).includes(Buffer.from(contract.contextExclusion.excludedMarker))).toBe(false);
		expect(Buffer.from(contextBytes).includes(Buffer.from(contract.contextExclusion.retainedMarker))).toBe(true);

		const categories = new Set(vectorDocument.negativeCases.map(({ category }) => category));
		for (const category of contract.requiredNegativeCategories) {
			expect(categories.has(category), `negative category ${category}`).toBe(true);
		}
		expect(vectorDocument.negativeCases.every((candidate) => negativeCaseLocallyRejects(registry, candidate))).toBe(
			true
		);
		expect(antiCopyErrors(vectorDocument.antiCopyDiscriminator, vectorDocument.negativeCases)).toEqual([]);

		for (const issuance of vectorDocument.issuanceCases) {
			expect(issuance.expected, issuance.id).toEqual(deriveIssuance(registry, grammar, issuance.request));
		}
		const lastSuccess = required(
			vectorDocument.issuanceCases.find(
				({ expected, request }) =>
					expected.accepted &&
					request.before[contract.sequenceContract.stateField] === contract.sequenceContract.lastDurableBeforeSuccess &&
					request.candidate.authorSequence === contract.sequenceContract.successfulNext
			),
			"last successful local issuance"
		);
		expect(lastSuccess.expected.after).toMatchObject({
			exhausted: true,
			[contract.sequenceContract.stateField]: contract.sequenceContract.exhaustedAt,
		});
		const exhaustionRejections = vectorDocument.issuanceCases.filter(
			({ expected, request }) =>
				!expected.accepted &&
				request.before[contract.sequenceContract.stateField] === contract.sequenceContract.exhaustedAt
		);
		expect(exhaustionRejections.length).toBeGreaterThanOrEqual(2);
		for (const rejection of exhaustionRejections) {
			expect(rejection.request.candidate.authorSequence).toBe(Number.MAX_SAFE_INTEGER);
			expect(buildRegistryValue(registry, grammar, "vertex", rejection.request.candidate).authorSequence).toBe(
				Number.MAX_SAFE_INTEGER
			);
			expect(rejection.expected).toEqual({
				accepted: false,
				after: rejection.request.before,
				instrumentation: { digestCalls: 0, publicationCalls: 0, signCalls: 0 },
				published: false,
				registeredDigestHex: null,
				signatureHex: null,
			});
		}
		expect(
			exhaustionRejections.some(
				({ request }) =>
					request.candidate.epoch !== request.before.epoch || request.candidate.anchor !== request.before.anchor
			),
			"epoch/anchor changes cannot reset exhaustion"
		).toBe(true);

		expect(vectorDocument.receivedCases.length).toBeGreaterThan(0);
		for (const received of vectorDocument.receivedCases) {
			const derived = deriveReceived(registry, received);
			expect(received.expected, received.id).toEqual(derived);
			expect(derived.accepted, received.id).toBe(true);
			expect(received.receivedHex, received.id).not.toBe(received.reencodedHex);
			const registeredVector = required(
				vectorDocument.vectors.find(
					({ canonicalHex, digestHex, domain }) =>
						canonicalHex === received.receivedHex &&
						digestHex === received.expected.digestHex &&
						domain === received.domain
				),
				`${received.id} registered vector`
			);
			expect(registeredVector.suiteId).not.toBeNull();
			const reencodedDigest = hashDomain(
				registry,
				received.domain,
				bytesFromHex(received.reencodedHex, `${received.id}.reencodedHex`)
			);
			expect(
				ed25519.verify(bytesFromHex(received.signatureHex), reencodedDigest, bytesFromHex(received.publicKeyHex), {
					zip215: false,
				})
			).toBe(false);
		}

		const encodeExpected = vectorDocument.vectors.map((vector) => {
			const normalized = buildRegistryValue(registry, grammar, vector.kind, vector.input);
			const parts = registryParts(registry, grammar, vector.kind, normalized);
			return {
				canonicalHex: hex(grammarEncode(grammar, normalized)),
				digestHex: hex(hashDomain(registry, vector.domain, ...parts)),
				id: vector.id,
				normalized: dehydrate(normalized),
				partsHex: parts.map(hex),
			};
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.vectors.map(({ id, input, kind }) => ({ id, input, kind })),
				operation: "encode-corpus",
			})
		).toEqual({ results: encodeExpected });
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.negativeCases.map(({ id, request }) => ({ id, request })),
				operation: "validate-cases",
			})
		).toEqual({
			results: vectorDocument.negativeCases.map(({ category, id }) => ({
				accepted: false,
				id,
				reason: category,
			})),
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.issuanceCases.map(({ id, request }) => ({ id, request })),
				operation: "issue-next",
			})
		).toEqual({
			results: vectorDocument.issuanceCases.map(({ id, request }) => ({
				id,
				...deriveIssuance(registry, grammar, request),
			})),
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.receivedCases.map(({ domain, id, receivedHex, reencodedHex }) => ({
					domain,
					id,
					receivedHex,
					reencodedHex,
				})),
				operation: "digest-received",
			})
		).toEqual({
			results: vectorDocument.receivedCases.map(({ domain, id, receivedHex, reencodedHex }) => ({
				id,
				receivedDigestHex: hex(hashDomain(registry, domain, bytesFromHex(receivedHex))),
				reencodedDigestHex: hex(hashDomain(registry, domain, bytesFromHex(reencodedHex))),
			})),
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.receivedCases.map(({ domain, id, publicKeyHex, receivedHex, signatureHex }) => ({
					domain,
					id,
					publicKeyHex,
					receivedHex,
					signatureHex,
				})),
				operation: "verify-received",
			})
		).toEqual({
			results: vectorDocument.receivedCases.map((received) => ({
				id: received.id,
				...deriveReceived(registry, received),
			})),
		});
	});
});
