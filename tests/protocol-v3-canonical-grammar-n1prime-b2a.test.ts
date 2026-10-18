import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contractPath = join(repositoryRoot, "tests/fixtures/phase-n1prime-b2a/canonical-grammar-contract.json");
const predecessorModulePath: string = "../packages/protocol-v2/src/canonical.js";

interface TagRow {
	name: string;
	octet: number;
	payload: string;
}

interface CorpusValue {
	[key: string]: unknown;
}

interface PositiveCase {
	id: string;
	value: unknown;
	hex: string;
	workedExample: boolean;
}

interface NegativeCase {
	id: string;
	hex: string;
	limits?: Partial<Limits>;
	category: string;
	predecessorMessage: string;
}

interface EncodingNegativeCase {
	id: string;
	case: string;
	category: string;
}

interface PrecedenceObservation {
	phase: string;
	category: string;
	elementIndex?: number;
}

interface PrecedenceProbe {
	id: string;
	stage: keyof Grammar["rejectionPrecedence"];
	observations: PrecedenceObservation[];
	expectedCategory: string;
}

interface GrammarLimits {
	defaults: Limits;
	depth: { root: number; comparison: string };
	items: {
		comparison: string;
		valueCharge: number;
		containerPrecharge: boolean;
		arraySetMultiplier: number;
		objectMapMultiplier: number;
		typedArrayMultiplier: number;
		encodeImmediateKinds: string[];
	};
	bytes: { comparison: string };
}

interface Contract {
	profile: string;
	planSha256: string;
	status: string;
	targets: { markdown: string; grammar: string };
	predecessorEvidence: Record<string, { path: string; sha256: string }>;
	expectedTags: TagRow[];
	requiredRuleIds: string[];
	positiveCorpus: PositiveCase[];
	decodeNegativeCorpus: NegativeCase[];
	encodeNegativeCorpus: EncodingNegativeCase[];
	expectedRejectionPrecedence: Grammar["rejectionPrecedence"];
	expectedPayloadTruncation: {
		string: { category: string; predecessorMessage: string };
		bytesAndContainers: { category: string };
	};
	precedenceProbes: PrecedenceProbe[];
	expectedLimitSemantics: GrammarLimits;
	encodeLimitControls: {
		id: string;
		kind: string;
		maxItems: number;
		expectedHex?: string;
		expectedCategory?: string;
	}[];
	workedExampleIds: string[];
	workedExampleBindings: Record<string, string[]>;
	novelRuleCombinationId: string;
	excludedCases: { id: string; disposition: string; reason: string }[];
	prRuntime: {
		positiveCases: number;
		decodeNegativeCases: number;
		encodeNegativeCases: number;
		goldenVectorCases: number;
		goldenVectorCanonicalBytes: number;
		goldenVectorExecution: string;
		goldenVectorMaxRuntimeMs: number;
		largeFuzzingInThisSlice: boolean;
		seededLargeDifferentialTier: string;
	};
}

interface Limits {
	maxBytes: number;
	maxDepth: number;
	maxItems: number;
}

interface Grammar {
	schemaVersion: number;
	profile: string;
	format: string;
	authoritativeMarkdown: { path: string; sha256: string };
	recursiveProduction: {
		start: string;
		alternatives: string[];
		children: Record<string, string[]>;
	};
	tags: TagRow[];
	primitives: {
		varuint: {
			groupBits: number;
			payloadMask: number;
			continuationMask: number;
			groupOrder: string;
			minimal: boolean;
			maxBytes: number;
			maxValue: string;
		};
		zigzag: {
			nonNegative: string;
			negative: string;
			minimum: string;
			maximum: string;
		};
		numbers: {
			byteOrder: string;
			scalarFloatWidth: number;
			integerBeforeFloat: boolean;
			finiteOnly: boolean;
			negativeZero: string;
			unsafeIntegralFloatDecode: string;
		};
		strings: {
			encoding: string;
			lengthUnit: string;
			fatalDecode: boolean;
			rejectUnpairedSurrogates: boolean;
		};
	};
	collections: {
		lengthEncoding: string;
		arrays: { dense: boolean; children: string };
		objects: {
			sourcePrototypes: string[];
			keys: string;
			properties: string;
			decodedPrototype: string;
		};
		maps: { key: string; value: string };
		sets: { value: string };
		typedArrays: Record<
			string,
			{ width: number; element: string; byteOrder: string; finiteOnly: boolean; negativeZero: string }
		>;
	};
	ordering: {
		comparator: string;
		direction: string;
		mapObjectBy: string;
		setBy: string;
		duplicates: string;
	};
	limits: GrammarLimits;
	rejectionPrecedence: {
		outer: string[];
		valueEntry: string[];
		varuint: string[];
		integer: string[];
		float: string[];
		keyValueEntry: string[];
		set: string[];
		typedArray: string[];
		finish: string[];
	};
	rules: { id: string; statement: string }[];
	workedExamples: { id: string; value: unknown; hex: string; bindsRules: string[] }[];
	conformance: {
		examples: string;
		novelCombinations: string;
		decoderProperty: string;
		implementationImports: boolean;
		executableSource: boolean;
	};
}

interface PredecessorCodec {
	decodeCanonical(input: Uint8Array, limits?: Partial<Limits>): unknown;
	encodeCanonical(value: unknown, limits?: Partial<Limits>): Uint8Array;
}

interface GoldenVector {
	id: string;
	kind: string;
	domain: string;
	input: unknown;
	value: unknown;
	canonicalHex: string;
	digestHex: string;
	partsHex: string[];
}

interface GoldenVectorRegistry {
	registryVersion: number;
	canonicalHexSemantics: string;
	partsHexSemantics: string;
	vectors: GoldenVector[];
}

const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Contract;
const goldenVectorRegistryPath = join(repositoryRoot, contract.predecessorEvidence.goldenVectors.path);
const goldenVectorRegistry = readGoldenVectorRegistry(goldenVectorRegistryPath);

class GrammarError extends TypeError {
	public constructor(
		public readonly category: string,
		message = category
	) {
		super(message);
	}
}

function limitExceeded(value: number, maximum: number, comparison: string): boolean {
	if (comparison === "greater-than") return value > maximum;
	throw new TypeError(`unsupported declarative limit comparison ${comparison}`);
}

function selectPrecedence(
	grammar: Grammar,
	stage: keyof Grammar["rejectionPrecedence"],
	observations: readonly PrecedenceObservation[]
): PrecedenceObservation | undefined {
	const order = grammar.rejectionPrecedence[stage];
	const ranked = observations.map((observation, inputIndex) => {
		const exact = order.indexOf(observation.phase);
		const elementPhase = order.indexOf("ELEMENT_ORDER");
		const category = order.indexOf(observation.category);
		requireCondition(
			exact >= 0 || (observation.phase === "ELEMENT_ORDER" && elementPhase >= 0),
			`${stage} precedence does not classify phase ${observation.phase}`
		);
		return {
			observation,
			phaseRank: exact >= 0 ? exact : elementPhase,
			elementRank: observation.phase === "ELEMENT_ORDER" ? (observation.elementIndex ?? Number.MAX_SAFE_INTEGER) : -1,
			categoryRank: category >= 0 ? category : Number.MAX_SAFE_INTEGER,
			inputIndex,
		};
	});
	ranked.sort(
		(left, right) =>
			left.phaseRank - right.phaseRank ||
			left.elementRank - right.elementRank ||
			left.categoryRank - right.categoryRank ||
			left.inputIndex - right.inputIndex
	);
	return ranked[0]?.observation;
}

function throwByPrecedence(
	grammar: Grammar,
	stage: keyof Grammar["rejectionPrecedence"],
	observations: readonly PrecedenceObservation[]
): void {
	const selected = selectPrecedence(grammar, stage, observations);
	if (selected !== undefined) throw new GrammarError(selected.category);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readGoldenVectorRegistry(path: string): GoldenVectorRegistry {
	const parsed = readJson<unknown>(path);
	requireCondition(isRecord(parsed), "golden-vector registry root must be an object");
	requireCondition(
		sameJson(Object.keys(parsed).sort(), ["canonicalHexSemantics", "partsHexSemantics", "registryVersion", "vectors"]),
		"golden-vector registry root schema drift"
	);
	requireCondition(parsed.registryVersion === 5, "golden-vector registry version drift");
	requireCondition(typeof parsed.canonicalHexSemantics === "string", "golden canonical semantics must be text");
	requireCondition(typeof parsed.partsHexSemantics === "string", "golden parts semantics must be text");
	requireCondition(Array.isArray(parsed.vectors), "golden-vector registry vectors must be an array");
	for (const [index, candidate] of parsed.vectors.entries()) {
		requireCondition(isRecord(candidate), `golden vector ${index} must be an object`);
		requireCondition(
			sameJson(Object.keys(candidate).sort(), [
				"canonicalHex",
				"digestHex",
				"domain",
				"id",
				"input",
				"kind",
				"partsHex",
				"value",
			]),
			`golden vector ${index} schema drift`
		);
		requireCondition(typeof candidate.id === "string" && candidate.id.length > 0, `golden vector ${index} id drift`);
		requireCondition(typeof candidate.kind === "string", `${candidate.id}: golden kind drift`);
		requireCondition(typeof candidate.domain === "string", `${candidate.id}: golden domain drift`);
		requireCondition(
			typeof candidate.canonicalHex === "string" && /^(?:[0-9a-f]{2})+$/u.test(candidate.canonicalHex),
			`${candidate.id}: golden canonicalHex drift`
		);
		requireCondition(
			typeof candidate.digestHex === "string" && /^[0-9a-f]{64}$/u.test(candidate.digestHex),
			`${candidate.id}: golden digestHex drift`
		);
		requireCondition(
			Array.isArray(candidate.partsHex) &&
				candidate.partsHex.every((part) => typeof part === "string" && /^(?:[0-9a-f]{2})*$/u.test(part)),
			`${candidate.id}: golden partsHex drift`
		);
		requireCondition(
			Object.hasOwn(candidate, "input") && Object.hasOwn(candidate, "value"),
			`${candidate.id}: golden value drift`
		);
	}
	return parsed as unknown as GoldenVectorRegistry;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("expected lowercase hexadecimal bytes");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index++) {
		const leftByte = left[index] as number;
		const rightByte = right[index] as number;
		if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
	}
	return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

function tag(grammar: Grammar, name: string): number {
	const row = grammar.tags.find((candidate) => candidate.name === name);
	if (row === undefined) throw new TypeError(`grammar omits tag ${name}`);
	return row.octet;
}

function assertWellFormedString(value: string): void {
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

function encodeVaruint(grammar: Grammar, input: number | bigint): Uint8Array {
	const specification = grammar.primitives.varuint;
	let value = typeof input === "bigint" ? input : BigInt(input);
	if (value < 0n) throw new GrammarError("VARUINT_RANGE");
	const groups: number[] = [];
	const mask = BigInt(specification.payloadMask);
	do {
		groups.push(Number(value & mask));
		value >>= BigInt(specification.groupBits);
	} while (value !== 0n);
	if (specification.groupOrder === "most-significant-first") groups.reverse();
	return Uint8Array.from(
		groups.map((group, index) => (index === groups.length - 1 ? group : group | specification.continuationMask))
	);
}

function hydrateValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateValue);
	if (value === null || typeof value !== "object") return value;
	const record = value as CorpusValue;
	if (record.$number === "-0") return -0;
	if (
		typeof record.$bytesHex === "string" &&
		Object.keys(record).length === 1 &&
		/^(?:[0-9a-f]{2})*$/u.test(record.$bytesHex)
	) {
		return bytesFromHex(record.$bytesHex);
	}
	if (record.$type === "bytes") return bytesFromHex(String(record.hex));
	if (record.$type === "typed-array") {
		const values = (record.values as unknown[]).map(hydrateValue) as number[];
		switch (record.name) {
			case "float32-array":
				return Float32Array.from(values);
			case "float64-array":
				return Float64Array.from(values);
			case "int32-array":
				return Int32Array.from(values);
			case "uint32-array":
				return Uint32Array.from(values);
			default:
				throw new TypeError("unknown typed-array descriptor");
		}
	}
	if (record.$type === "map") {
		return new Map(
			(record.entries as [unknown, unknown][]).map(([key, item]) => [hydrateValue(key), hydrateValue(item)])
		);
	}
	if (record.$type === "set") return new Set((record.values as unknown[]).map(hydrateValue));
	if (record.$type === "null-prototype") {
		const output = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of record.entries as [string, unknown][]) output[key] = hydrateValue(item);
		return output;
	}
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, hydrateValue(item)]));
}

function encodingNegativeValue(name: string): unknown {
	switch (name) {
		case "nan":
			return Number.NaN;
		case "positive-infinity":
			return Number.POSITIVE_INFINITY;
		case "unsafe-integer":
			return Number.MAX_SAFE_INTEGER + 1;
		case "unpaired-high-surrogate":
			return "\ud800";
		case "unpaired-low-surrogate":
			return "\udfff";
		case "bigint":
			return 1n;
		case "sparse-array": {
			const value: unknown[] = [];
			value.length = 1;
			return value;
		}
		case "cyclic-array": {
			const value: unknown[] = [];
			value.push(value);
			return value;
		}
		case "class-instance":
			return Object.create({ inherited: true }) as object;
		case "date":
			return new Date(0);
		case "symbol-key":
			return { [Symbol("key")]: true };
		case "accessor":
			return Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		case "duplicate-canonical-map-key":
			return new Map<unknown, unknown>([
				[{}, 1],
				[{}, 2],
			]);
		case "duplicate-canonical-set-value":
			return new Set([{}, {}]);
		case "typed-array-nan":
			return Float64Array.of(Number.NaN);
		case "data-view":
			return new DataView(new ArrayBuffer(1));
		default:
			throw new TypeError(`unknown encoding-negative case ${name}`);
	}
}

function encodeLimitValue(kind: string): unknown {
	switch (kind) {
		case "object":
			return { k0: 0, k1: 1, k2: 2 };
		case "array":
			return [0, 1, 2];
		case "map":
			return new Map<unknown, unknown>([
				[0, 0],
				[1, 1],
				[2, 2],
			]);
		case "set":
			return new Set([0, 1, 2]);
		default:
			throw new TypeError(`unknown encode-limit control kind ${kind}`);
	}
}

function typedArrayName(value: object): string | undefined {
	if (value instanceof Float32Array) return "float32-array";
	if (value instanceof Float64Array) return "float64-array";
	if (value instanceof Int32Array) return "int32-array";
	if (value instanceof Uint32Array) return "uint32-array";
	return undefined;
}

function grammarEncode(
	grammar: Grammar,
	value: unknown,
	overrides: Partial<Limits> = {},
	active = new Set<object>(),
	depth = grammar.limits.depth.root
): Uint8Array {
	const limits = { ...grammar.limits.defaults, ...overrides };
	if (limitExceeded(depth, limits.maxDepth, grammar.limits.depth.comparison)) {
		throw new GrammarError("DEPTH_LIMIT");
	}
	let encoded: Uint8Array;
	if (value === null) encoded = Uint8Array.of(tag(grammar, "null"));
	else if (value === false) encoded = Uint8Array.of(tag(grammar, "false"));
	else if (value === true) encoded = Uint8Array.of(tag(grammar, "true"));
	else if (typeof value === "string") {
		if (grammar.primitives.strings.rejectUnpairedSurrogates) assertWellFormedString(value);
		const payload = new TextEncoder().encode(value);
		const declaredLength =
			grammar.primitives.strings.lengthUnit === "bytes"
				? payload.length
				: grammar.primitives.strings.lengthUnit === "utf-16-code-units"
					? value.length
					: ((): never => {
							throw new TypeError(
								`unsupported declarative string length unit ${grammar.primitives.strings.lengthUnit}`
							);
						})();
		encoded = concat([Uint8Array.of(tag(grammar, "string")), encodeVaruint(grammar, declaredLength), payload]);
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
			encoded = concat([Uint8Array.of(tag(grammar, "integer")), encodeVaruint(grammar, zigzag)]);
		} else {
			const payload = new Uint8Array(8);
			new DataView(payload.buffer).setFloat64(0, normalized, grammar.primitives.numbers.byteOrder === "little");
			encoded = concat([Uint8Array.of(tag(grammar, "float64")), payload]);
		}
	} else {
		if (typeof value !== "object") throw new GrammarError("UNSUPPORTED_SOURCE");
		if (active.has(value)) throw new GrammarError("CYCLIC_SOURCE");
		active.add(value);
		try {
			if (value instanceof Uint8Array) {
				encoded = concat([
					Uint8Array.of(tag(grammar, "bytes")),
					encodeVaruint(grammar, value.byteLength),
					new Uint8Array(value),
				]);
			} else {
				const typedName = typedArrayName(value);
				if (typedName !== undefined) {
					const specification = grammar.collections.typedArrays[typedName];
					if (specification === undefined) throw new GrammarError("UNSUPPORTED_SOURCE");
					for (const item of value as Iterable<number>) {
						if (specification.finiteOnly && !Number.isFinite(item)) throw new GrammarError("NON_FINITE_SOURCE");
					}
					const payload = new Uint8Array((value as { length: number }).length * specification.width);
					const view = new DataView(payload.buffer);
					for (let index = 0; index < (value as { length: number }).length; index++) {
						let item = (value as unknown as ArrayLike<number>)[index] as number;
						if (specification.negativeZero.startsWith("normalize") && Object.is(item, -0)) item = 0;
						const offset = index * specification.width;
						const little = specification.byteOrder === "little";
						if (specification.element === "float32") view.setFloat32(offset, item, little);
						else if (specification.element === "float64") view.setFloat64(offset, item, little);
						else if (specification.element === "int32") view.setInt32(offset, item, little);
						else view.setUint32(offset, item, little);
					}
					encoded = concat([
						Uint8Array.of(tag(grammar, typedName)),
						encodeVaruint(grammar, (value as { length: number }).length),
						payload,
					]);
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
						limitExceeded(value.length, limits.maxItems, grammar.limits.items.comparison)
					) {
						throw new GrammarError("ITEM_LIMIT");
					}
					const parts = [Uint8Array.of(tag(grammar, "array")), encodeVaruint(grammar, value.length)];
					for (let index = 0; index < value.length; index++) {
						if (grammar.collections.arrays.dense && !Object.hasOwn(value, index)) {
							throw new GrammarError("SPARSE_ARRAY");
						}
						parts.push(grammarEncode(grammar, value[index], limits, active, depth + 1));
					}
					encoded = concat(parts);
				} else if (value instanceof Map) {
					if (
						grammar.limits.items.encodeImmediateKinds.includes("map") &&
						limitExceeded(value.size, limits.maxItems, grammar.limits.items.comparison)
					) {
						throw new GrammarError("ITEM_LIMIT");
					}
					const entries = [...value].map(([key, item]) => ({
						key: grammarEncode(grammar, key, limits, active, depth + 1),
						value: grammarEncode(grammar, item, limits, active, depth + 1),
					}));
					entries.sort((left, right) => compareBytes(left.key, right.key));
					if (grammar.ordering.direction === "descending") entries.reverse();
					for (let index = 1; index < entries.length; index++) {
						const previous = entries[index - 1];
						const current = entries[index];
						if (
							previous !== undefined &&
							current !== undefined &&
							compareBytes(previous.key, current.key) === 0 &&
							grammar.ordering.duplicates === "reject-equal-encoded-bytes"
						) {
							throw new GrammarError("DUPLICATE_KEY");
						}
					}
					encoded = concat([
						Uint8Array.of(tag(grammar, "map")),
						encodeVaruint(grammar, entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				} else if (value instanceof Set) {
					if (
						grammar.limits.items.encodeImmediateKinds.includes("set") &&
						limitExceeded(value.size, limits.maxItems, grammar.limits.items.comparison)
					) {
						throw new GrammarError("ITEM_LIMIT");
					}
					const items = [...value].map((item) => grammarEncode(grammar, item, limits, active, depth + 1));
					items.sort(compareBytes);
					if (grammar.ordering.direction === "descending") items.reverse();
					for (let index = 1; index < items.length; index++) {
						const previous = items[index - 1];
						const current = items[index];
						if (
							previous !== undefined &&
							current !== undefined &&
							compareBytes(previous, current) === 0 &&
							grammar.ordering.duplicates === "reject-equal-encoded-bytes"
						) {
							throw new GrammarError("DUPLICATE_SET_VALUE");
						}
					}
					encoded = concat([Uint8Array.of(tag(grammar, "set")), encodeVaruint(grammar, items.length), ...items]);
				} else {
					const prototype = Object.getPrototypeOf(value) as object | null;
					const allowed =
						(prototype === Object.prototype &&
							grammar.collections.objects.sourcePrototypes.includes("ordinary-object-prototype")) ||
						(prototype === null && grammar.collections.objects.sourcePrototypes.includes("null-prototype"));
					if (!allowed) throw new GrammarError("NON_PLAIN_OBJECT");
					if (Object.getOwnPropertySymbols(value).length !== 0) throw new GrammarError("SYMBOL_KEY");
					const entries: { key: Uint8Array; value: Uint8Array }[] = [];
					for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
						if (!descriptor.enumerable) continue;
						if (!Object.hasOwn(descriptor, "value")) throw new GrammarError("ACCESSOR_PROPERTY");
						assertWellFormedString(key);
						entries.push({
							key: grammarEncode(grammar, key, limits, active, depth + 1),
							value: grammarEncode(grammar, descriptor.value, limits, active, depth + 1),
						});
					}
					if (
						grammar.limits.items.encodeImmediateKinds.includes("object") &&
						limitExceeded(entries.length, limits.maxItems, grammar.limits.items.comparison)
					) {
						throw new GrammarError("ITEM_LIMIT");
					}
					entries.sort((left, right) => compareBytes(left.key, right.key));
					if (grammar.ordering.direction === "descending") entries.reverse();
					encoded = concat([
						Uint8Array.of(tag(grammar, "object")),
						encodeVaruint(grammar, entries.length),
						...entries.flatMap((entry) => [entry.key, entry.value]),
					]);
				}
			}
		} finally {
			active.delete(value);
		}
	}
	if (limitExceeded(encoded.byteLength, limits.maxBytes, grammar.limits.bytes.comparison)) {
		throw new GrammarError("BYTE_LIMIT");
	}
	return encoded;
}

class GrammarReader {
	public offset = 0;
	public items = 0;

	public constructor(
		public readonly grammar: Grammar,
		public readonly bytes: Uint8Array,
		public readonly limits: Limits
	) {}

	public take(length: number): Uint8Array {
		if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
			throw new GrammarError("TRUNCATED");
		}
		const output = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return output;
	}

	public byte(): number {
		return this.take(1)[0] as number;
	}

	public countItems(count = 1): void {
		this.items += count;
		if (limitExceeded(this.items, this.limits.maxItems, this.grammar.limits.items.comparison)) {
			throw new GrammarError("ITEM_LIMIT");
		}
	}

	public varuint(): bigint {
		const specification = this.grammar.primitives.varuint;
		const groups: number[] = [];
		while (true) {
			const byte = this.byte();
			groups.push(byte & specification.payloadMask);
			if (groups.length > specification.maxBytes) {
				throwByPrecedence(this.grammar, "varuint", [{ phase: "VARUINT_RANGE_OCTETS", category: "VARUINT_RANGE" }]);
			}
			if ((byte & specification.continuationMask) === 0) break;
		}
		const ordered = specification.groupOrder === "least-significant-first" ? groups : [...groups].reverse();
		let result = 0n;
		for (const [index, group] of ordered.entries()) {
			result |= BigInt(group) << (BigInt(index) * BigInt(specification.groupBits));
		}
		const observations: PrecedenceObservation[] = [];
		if (specification.minimal && groups.length > 1 && groups[groups.length - 1] === 0) {
			observations.push({ phase: "VARUINT_NON_MINIMAL", category: "VARUINT_NON_MINIMAL" });
		}
		if (result > BigInt(specification.maxValue)) {
			observations.push({ phase: "VARUINT_RANGE_VALUE", category: "VARUINT_RANGE" });
		}
		throwByPrecedence(this.grammar, "varuint", observations);
		return result;
	}
}

interface Decoded {
	value: unknown;
	bytes: Uint8Array;
}

function grammarDecodeValue(reader: GrammarReader, depth: number): Decoded {
	if (limitExceeded(depth, reader.limits.maxDepth, reader.grammar.limits.depth.comparison)) {
		throw new GrammarError("DEPTH_LIMIT");
	}
	reader.countItems(reader.grammar.limits.items.valueCharge);
	const start = reader.offset;
	const octet = reader.byte();
	const row = reader.grammar.tags.find((candidate) => candidate.octet === octet);
	if (row === undefined) throw new GrammarError("UNKNOWN_TAG");
	let value: unknown;
	switch (row.name) {
		case "null":
			value = null;
			break;
		case "false":
			value = false;
			break;
		case "true":
			value = true;
			break;
		case "integer": {
			const encoded = reader.varuint();
			const magnitude = encoded >> 1n;
			const decoded = (encoded & 1n) === 0n ? magnitude : -(magnitude + 1n);
			const minimum = BigInt(reader.grammar.primitives.zigzag.minimum);
			const maximum = BigInt(reader.grammar.primitives.zigzag.maximum);
			const observations: PrecedenceObservation[] = [];
			if (decoded < minimum || decoded > maximum) {
				observations.push({ phase: "INTEGER_RANGE", category: "INTEGER_RANGE" });
			}
			throwByPrecedence(reader.grammar, "integer", observations);
			value = Number(decoded);
			break;
		}
		case "float64": {
			const bytes = reader.take(reader.grammar.primitives.numbers.scalarFloatWidth);
			const decoded = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(
				0,
				reader.grammar.primitives.numbers.byteOrder === "little"
			);
			const observations: PrecedenceObservation[] = [];
			if (reader.grammar.primitives.numbers.finiteOnly && !Number.isFinite(decoded)) {
				observations.push({ phase: "FLOAT_NON_FINITE", category: "FLOAT_NON_FINITE" });
			}
			if (reader.grammar.primitives.numbers.negativeZero.endsWith("reject-decode") && Object.is(decoded, -0)) {
				observations.push({ phase: "FLOAT_NEGATIVE_ZERO", category: "FLOAT_NEGATIVE_ZERO" });
			}
			if (reader.grammar.primitives.numbers.integerBeforeFloat && Number.isSafeInteger(decoded)) {
				observations.push({ phase: "FLOAT_SAFE_INTEGRAL", category: "FLOAT_SAFE_INTEGRAL" });
			}
			throwByPrecedence(reader.grammar, "float", observations);
			value = decoded;
			break;
		}
		case "string": {
			const length = Number(reader.varuint());
			try {
				const bytes = reader.take(length);
				value = new TextDecoder(reader.grammar.primitives.strings.encoding, {
					fatal: reader.grammar.primitives.strings.fatalDecode,
				}).decode(bytes);
			} catch {
				throw new GrammarError("UTF8_INVALID");
			}
			if (reader.grammar.primitives.strings.rejectUnpairedSurrogates) assertWellFormedString(value as string);
			break;
		}
		case "bytes":
			value = new Uint8Array(reader.take(Number(reader.varuint())));
			break;
		case "array": {
			const length = Number(reader.varuint());
			if (reader.grammar.limits.items.containerPrecharge) {
				reader.countItems(length * reader.grammar.limits.items.arraySetMultiplier);
			}
			const children: Decoded[] = [];
			for (let index = 0; index < length; index++) children.push(grammarDecodeValue(reader, depth + 1));
			value = children.map((child) => child.value);
			break;
		}
		case "set": {
			const length = Number(reader.varuint());
			if (reader.grammar.limits.items.containerPrecharge) {
				reader.countItems(length * reader.grammar.limits.items.arraySetMultiplier);
			}
			const children: Decoded[] = [];
			let previous: Uint8Array | undefined;
			for (let index = 0; index < length; index++) {
				const current = grammarDecodeValue(reader, depth + 1);
				const observations: PrecedenceObservation[] = [];
				if (previous !== undefined) {
					const comparison = compareBytes(previous, current.bytes);
					const duplicateAllowed =
						comparison === 0 && reader.grammar.ordering.duplicates === "allow-equal-encoded-bytes";
					const canonical =
						duplicateAllowed || (reader.grammar.ordering.direction === "ascending" ? comparison < 0 : comparison > 0);
					if (!canonical) {
						observations.push({
							phase: "SET_ORDER_OR_DUPLICATE",
							category: "SET_ORDER_OR_DUPLICATE",
						});
					}
				}
				throwByPrecedence(reader.grammar, "set", observations);
				previous = current.bytes;
				children.push(current);
			}
			value = new Set(children.map((child) => child.value));
			break;
		}
		case "object":
		case "map": {
			const length = Number(reader.varuint());
			if (reader.grammar.limits.items.containerPrecharge) {
				reader.countItems(length * reader.grammar.limits.items.objectMapMultiplier);
			}
			const object = Object.create(null) as Record<string, unknown>;
			const map = new Map<unknown, unknown>();
			let previous: Uint8Array | undefined;
			for (let index = 0; index < length; index++) {
				const key = grammarDecodeValue(reader, depth + 1);
				if (previous !== undefined) {
					const comparison = compareBytes(previous, key.bytes);
					const duplicateAllowed =
						comparison === 0 && reader.grammar.ordering.duplicates === "allow-equal-encoded-bytes";
					const canonical =
						duplicateAllowed || (reader.grammar.ordering.direction === "ascending" ? comparison < 0 : comparison > 0);
					if (!canonical) throw new GrammarError("KEY_ORDER_OR_DUPLICATE");
				}
				previous = key.bytes;
				const item = grammarDecodeValue(reader, depth + 1).value;
				if (row.name === "object") {
					if (typeof key.value !== "string") throw new GrammarError("OBJECT_KEY_TYPE");
					object[key.value] = item;
				} else {
					map.set(key.value, item);
				}
			}
			value = row.name === "object" ? object : map;
			break;
		}
		case "float32-array":
		case "float64-array":
		case "int32-array":
		case "uint32-array": {
			const specification = reader.grammar.collections.typedArrays[row.name];
			if (specification === undefined) throw new GrammarError("UNKNOWN_TAG");
			const length = Number(reader.varuint());
			if (reader.grammar.limits.items.containerPrecharge) {
				reader.countItems(length * reader.grammar.limits.items.typedArrayMultiplier);
			}
			const payloadLength = length * specification.width;
			if (specification.finiteOnly) {
				const available = reader.bytes.subarray(reader.offset);
				const completeElements = Math.min(length, Math.floor(available.byteLength / specification.width));
				const preview = new DataView(available.buffer, available.byteOffset, completeElements * specification.width);
				const observations: PrecedenceObservation[] = [];
				if (available.byteLength < payloadLength) {
					observations.push({ phase: "TRUNCATED", category: "TRUNCATED" });
				}
				for (let index = 0; index < completeElements; index++) {
					const offset = index * specification.width;
					const little = specification.byteOrder === "little";
					const item =
						specification.element === "float32"
							? preview.getFloat32(offset, little)
							: preview.getFloat64(offset, little);
					if (!Number.isFinite(item)) {
						observations.push({
							phase: "ELEMENT_ORDER",
							elementIndex: index,
							category: "TYPED_NON_FINITE",
						});
					}
					if (specification.negativeZero.endsWith("reject-decode") && Object.is(item, -0)) {
						observations.push({
							phase: "ELEMENT_ORDER",
							elementIndex: index,
							category: "TYPED_NEGATIVE_ZERO",
						});
					}
				}
				throwByPrecedence(reader.grammar, "typedArray", observations);
			}
			const bytes = reader.take(payloadLength);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const values = Array.from({ length }, (_unused, index) => {
				const offset = index * specification.width;
				const little = specification.byteOrder === "little";
				if (specification.element === "float32") return view.getFloat32(offset, little);
				if (specification.element === "float64") return view.getFloat64(offset, little);
				if (specification.element === "int32") return view.getInt32(offset, little);
				return view.getUint32(offset, little);
			});
			if (row.name === "float32-array") value = Float32Array.from(values);
			else if (row.name === "float64-array") value = Float64Array.from(values);
			else if (row.name === "int32-array") value = Int32Array.from(values);
			else value = Uint32Array.from(values);
			break;
		}
		default:
			throw new GrammarError("UNKNOWN_TAG");
	}
	return { value, bytes: reader.bytes.subarray(start, reader.offset) };
}

function grammarDecode(grammar: Grammar, bytes: Uint8Array, overrides: Partial<Limits> = {}): unknown {
	const limits = { ...grammar.limits.defaults, ...overrides };
	if (limitExceeded(bytes.byteLength, limits.maxBytes, grammar.limits.bytes.comparison)) {
		throw new GrammarError("BYTE_LIMIT");
	}
	const reader = new GrammarReader(grammar, bytes, limits);
	const decoded = grammarDecodeValue(reader, grammar.limits.depth.root).value;
	if (reader.offset !== bytes.byteLength) throw new GrammarError("TRAILING_BYTES");
	return decoded;
}

function expectGrammarCategory(action: () => unknown, category: string): void {
	try {
		action();
	} catch (error) {
		if (!(error instanceof GrammarError)) throw error;
		expect(error.category).toBe(category);
		return;
	}
	throw new TypeError(`grammar unexpectedly accepted ${category} case`);
}

function makeControlGrammar(): Grammar {
	const children: Record<string, string[]> = {
		array: ["value"],
		object: ["string", "value"],
		map: ["value", "value"],
		set: ["value"],
	};
	return {
		schemaVersion: 1,
		profile: contract.profile,
		format: "declarative-data-v1",
		authoritativeMarkdown: {
			path: contract.targets.markdown,
			sha256: "0".repeat(64),
		},
		recursiveProduction: {
			start: "value",
			alternatives: contract.expectedTags.map((row) => row.name),
			children,
		},
		tags: structuredClone(contract.expectedTags),
		primitives: {
			varuint: {
				groupBits: 7,
				payloadMask: 127,
				continuationMask: 128,
				groupOrder: "least-significant-first",
				minimal: true,
				maxBytes: 9,
				maxValue: "18014398509481983",
			},
			zigzag: {
				nonNegative: "2*n",
				negative: "-2*n-1",
				minimum: "-9007199254740991",
				maximum: "9007199254740991",
			},
			numbers: {
				byteOrder: "big",
				scalarFloatWidth: 8,
				integerBeforeFloat: true,
				finiteOnly: true,
				negativeZero: "normalize-encode-reject-decode",
				unsafeIntegralFloatDecode: "unresolved-outside-governed-corpus",
			},
			strings: {
				encoding: "utf-8",
				lengthUnit: "bytes",
				fatalDecode: true,
				rejectUnpairedSurrogates: true,
			},
		},
		collections: {
			lengthEncoding: "varuint",
			arrays: { dense: true, children: "value" },
			objects: {
				sourcePrototypes: ["ordinary-object-prototype", "null-prototype"],
				keys: "string-only",
				properties: "own-enumerable-data-only",
				decodedPrototype: "null",
			},
			maps: { key: "value", value: "value" },
			sets: { value: "value" },
			typedArrays: {
				"float32-array": {
					width: 4,
					element: "float32",
					byteOrder: "big",
					finiteOnly: true,
					negativeZero: "normalize-encode-reject-decode",
				},
				"float64-array": {
					width: 8,
					element: "float64",
					byteOrder: "big",
					finiteOnly: true,
					negativeZero: "normalize-encode-reject-decode",
				},
				"int32-array": {
					width: 4,
					element: "int32",
					byteOrder: "big",
					finiteOnly: false,
					negativeZero: "not-applicable",
				},
				"uint32-array": {
					width: 4,
					element: "uint32",
					byteOrder: "big",
					finiteOnly: false,
					negativeZero: "not-applicable",
				},
			},
		},
		ordering: {
			comparator: "unsigned-lexicographic-full-encoded-bytes",
			direction: "ascending",
			mapObjectBy: "encoded-key-bytes",
			setBy: "encoded-value-bytes",
			duplicates: "reject-equal-encoded-bytes",
		},
		limits: structuredClone(contract.expectedLimitSemantics),
		rejectionPrecedence: structuredClone(contract.expectedRejectionPrecedence),
		rules: contract.requiredRuleIds.map((id) => ({
			id,
			statement: `Language-neutral normative production and rejection requirement for ${id}.`,
		})),
		workedExamples: contract.positiveCorpus
			.filter((entry) => entry.workedExample)
			.map((entry) => ({
				id: entry.id,
				value: structuredClone(entry.value),
				hex: entry.hex,
				bindsRules: structuredClone(contract.workedExampleBindings[entry.id] ?? []),
			})),
		conformance: {
			examples: "binding-but-subordinate-to-production-rules",
			novelCombinations: "evaluate-from-recursive-production-only",
			decoderProperty: "accepted-bytes-reencode-identically",
			implementationImports: false,
			executableSource: false,
		},
	};
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function requireCondition(condition: boolean, message: string): asserts condition {
	if (!condition) throw new TypeError(message);
}

function validateGrammar(grammar: Grammar): void {
	const topLevelKeys = [
		"authoritativeMarkdown",
		"collections",
		"conformance",
		"format",
		"limits",
		"ordering",
		"primitives",
		"profile",
		"recursiveProduction",
		"rejectionPrecedence",
		"rules",
		"schemaVersion",
		"tags",
		"workedExamples",
	].sort();
	requireCondition(
		sameJson(Object.keys(grammar).sort(), topLevelKeys),
		"machine grammar must be bounded declarative data with the exact top-level contract"
	);
	requireCondition(grammar.schemaVersion === 1, "grammar schemaVersion must be 1");
	requireCondition(grammar.profile === contract.profile, "grammar profile drift");
	requireCondition(grammar.format === "declarative-data-v1", "grammar must identify declarative data");
	requireCondition(
		grammar.authoritativeMarkdown.path === contract.targets.markdown &&
			/^[0-9a-f]{64}$/u.test(grammar.authoritativeMarkdown.sha256),
		"machine grammar must bind the authoritative Markdown by path and sha256"
	);
	requireCondition(sameJson(grammar.tags, contract.expectedTags), "tag octet or payload-layout drift");
	requireCondition(
		grammar.recursiveProduction.start === "value" &&
			sameJson(
				grammar.recursiveProduction.alternatives,
				contract.expectedTags.map((row) => row.name)
			) &&
			sameJson(grammar.recursiveProduction.children, {
				array: ["value"],
				object: ["string", "value"],
				map: ["value", "value"],
				set: ["value"],
			}),
		"recursive production is missing, incomplete, or ambiguous"
	);
	const control = makeControlGrammar();
	for (const key of ["varuint", "zigzag", "numbers", "strings"] as const) {
		requireCondition(sameJson(grammar.primitives[key], control.primitives[key]), `primitive grammar drift: ${key}`);
	}
	requireCondition(sameJson(grammar.collections, control.collections), "collection layout grammar drift");
	requireCondition(sameJson(grammar.ordering, control.ordering), "encoded-byte ordering grammar drift");
	requireCondition(sameJson(grammar.limits, control.limits), "resource-limit grammar drift");
	requireCondition(
		sameJson(grammar.rejectionPrecedence, control.rejectionPrecedence),
		"rejection precedence is absent or ambiguous"
	);
	const ruleIds = grammar.rules.map((rule) => rule.id);
	requireCondition(sameJson(ruleIds, contract.requiredRuleIds), "required rule omitted, duplicated, or reordered");
	for (const rule of grammar.rules) {
		requireCondition(
			typeof rule.statement === "string" && rule.statement.length >= 24,
			`${rule.id} lacks a substantive language-neutral statement`
		);
	}
	requireCondition(
		grammar.conformance.examples === "binding-but-subordinate-to-production-rules" &&
			grammar.conformance.novelCombinations === "evaluate-from-recursive-production-only" &&
			grammar.conformance.decoderProperty === "accepted-bytes-reencode-identically" &&
			grammar.conformance.implementationImports === false &&
			grammar.conformance.executableSource === false,
		"examples must not override rules and executable implementation shortcuts are prohibited"
	);
	requireCondition(
		sameJson(
			grammar.workedExamples.map((example) => example.id),
			contract.workedExampleIds
		),
		"binding worked-example coverage drift"
	);
	const ruleIdSet = new Set(ruleIds);
	for (const example of grammar.workedExamples) {
		const corpus = contract.positiveCorpus.find((entry) => entry.id === example.id);
		requireCondition(corpus !== undefined, `worked example ${example.id} is not a frozen binding case`);
		requireCondition(
			sameJson(example.value, corpus.value) && example.hex === corpus.hex,
			`worked example ${example.id} does not bind its frozen value and bytes`
		);
		requireCondition(
			sameJson(example.bindsRules, contract.workedExampleBindings[example.id]) &&
				example.bindsRules.length > 0 &&
				example.bindsRules.every((id) => ruleIdSet.has(id)),
			`worked example ${example.id} must cite governed grammar rules`
		);
	}
	const serialized = JSON.stringify(grammar);
	requireCondition(
		!/(?:packages\/canonical|protocol-v2\/|conformance\/ahe-reference|\bimport\s*\(|\brequire\s*\(|=>|\bfunction\s*\()/u.test(
			serialized
		),
		"machine grammar cannot import, embed, or point at an implementation"
	);
}

function validateMarkdown(markdown: string): void {
	requireCondition(
		/^# drp-canonical-profile-1 canonical tag codec$/mu.test(markdown),
		"Markdown must name the exact canonical profile"
	);
	requireCondition(
		/authoritative recursive grammar/iu.test(markdown),
		"Markdown must declare itself the authoritative recursive grammar"
	);
	requireCondition(
		/<value>\s*::=/u.test(markdown) && /<array>\s*::=.*<value>/u.test(markdown),
		"Markdown must contain a recursive, language-neutral value production"
	);
	requireCondition(
		/binding conformance examples/iu.test(markdown) &&
			/(?:never|do not|cannot) override (?:the )?(?:grammar|production rules)/iu.test(markdown),
		"Markdown must subordinate binding examples to production rules"
	);
	for (const row of contract.expectedTags) {
		const octet = `0x${row.octet.toString(16).padStart(2, "0")}`;
		requireCondition(
			markdown.includes(octet) && markdown.includes(row.name),
			`Markdown omits tag ${row.name} ${octet}`
		);
	}
	for (const id of contract.requiredRuleIds) {
		requireCondition(markdown.includes(id), `Markdown omits governed rule ${id}`);
	}
	const stringUtf8Rule = markdown.match(/`STRING_UTF8`[\s\S]*?(?=\n`STRING_UNPAIRED_SURROGATE`)/u)?.[0] ?? "";
	requireCondition(
		/(?:(?:unavailable|truncated) declared string payload|declared string payload[\s\S]{0,80}(?:unavailable|truncated))[\s\S]{0,160}UTF8_INVALID[\s\S]{0,160}(?:whereas|while|but|rather than|instead of)[\s\S]{0,160}(?:bytes?|containers?|collections?)[\s\S]{0,160}TRUNCATED/iu.test(
			stringUtf8Rule
		) &&
			stringUtf8Rule.includes(contract.expectedPayloadTruncation.string.category) &&
			stringUtf8Rule.includes(contract.expectedPayloadTruncation.bytesAndContainers.category),
		"STRING_UTF8 must explicitly remap unavailable declared string payloads to UTF8_INVALID while bytes/container payloads remain TRUNCATED"
	);
	requireCondition(
		/unsafe-integral scalar Float64/iu.test(markdown) && /unresolved-outside-governed-corpus/iu.test(markdown),
		"Markdown must preserve the scoped unsafe-integral Float64 non-decision"
	);
	requireCondition(
		!/(?:packages\/canonical|protocol-v2\/|conformance\/ahe-reference|\bimport\s*\(|\brequire\s*\()/u.test(markdown),
		"authoritative Markdown cannot defer to or import an implementation"
	);
}

interface GrammarCorpusMetrics {
	goldenVectorCases: number;
	goldenVectorCanonicalBytes: number;
	goldenVectorElapsedMs: number;
}

function runGrammarCorpus(grammar: Grammar): GrammarCorpusMetrics {
	for (const entry of contract.positiveCorpus) {
		const value = hydrateValue(entry.value);
		const encoded = grammarEncode(grammar, value);
		if (hex(encoded) !== entry.hex) throw new TypeError(`${entry.id}: grammar encoding mismatch`);
		const decoded = grammarDecode(grammar, bytesFromHex(entry.hex));
		const reencoded = grammarEncode(grammar, decoded);
		if (hex(reencoded) !== entry.hex) throw new TypeError(`${entry.id}: decode/re-encode mismatch`);
		if (entry.id === "null-prototype-proto-data") {
			requireCondition(
				decoded !== null && typeof decoded === "object" && Object.getPrototypeOf(decoded) === null,
				"decoded object must have a null prototype"
			);
			requireCondition(
				Object.hasOwn(decoded, "__proto__") && ({} as Record<string, unknown>).polluted === undefined,
				"__proto__ must remain inert own data"
			);
		}
	}
	for (const entry of contract.decodeNegativeCorpus) {
		try {
			grammarDecode(grammar, bytesFromHex(entry.hex), entry.limits);
		} catch (error) {
			if (error instanceof GrammarError && error.category === entry.category) continue;
			throw new TypeError(
				`${entry.id}: expected ${entry.category}, received ${
					error instanceof GrammarError ? error.category : String(error)
				}`
			);
		}
		throw new TypeError(`${entry.id}: grammar accepted a frozen forbidden byte sequence`);
	}
	const goldenVectorStart = performance.now();
	let goldenVectorCanonicalBytes = 0;
	for (const vector of goldenVectorRegistry.vectors) {
		const canonical = bytesFromHex(vector.canonicalHex);
		goldenVectorCanonicalBytes += canonical.byteLength;
		const encodedFromRegistryValue = grammarEncode(grammar, hydrateValue(vector.value));
		requireCondition(
			hex(encodedFromRegistryValue) === vector.canonicalHex,
			`${vector.id}: grammar encoding disagrees with pinned registry-v5 canonicalHex`
		);
		const decoded = grammarDecode(grammar, canonical);
		const reencoded = grammarEncode(grammar, decoded);
		requireCondition(
			hex(reencoded) === vector.canonicalHex,
			`${vector.id}: pinned registry-v5 decode/re-encode lost exact byte identity`
		);
	}
	const goldenVectorElapsedMs = performance.now() - goldenVectorStart;
	requireCondition(
		goldenVectorRegistry.vectors.length === contract.prRuntime.goldenVectorCases,
		"pinned registry-v5 golden-vector count drift"
	);
	requireCondition(
		goldenVectorCanonicalBytes === contract.prRuntime.goldenVectorCanonicalBytes,
		"pinned registry-v5 canonical-byte total drift"
	);
	requireCondition(
		goldenVectorElapsedMs <= contract.prRuntime.goldenVectorMaxRuntimeMs,
		`pinned registry-v5 grammar execution exceeded ${contract.prRuntime.goldenVectorMaxRuntimeMs} ms`
	);
	if (process.env.PHASE_N1PRIME_B2A_REPORT_METRICS === "1") {
		process.stdout.write(
			`phase-n1prime-b2a registry-v5: ${goldenVectorRegistry.vectors.length} vectors, ${goldenVectorCanonicalBytes} canonical bytes, ${goldenVectorElapsedMs.toFixed(3)} ms\n`
		);
	}
	for (const entry of contract.encodeNegativeCorpus) {
		try {
			grammarEncode(grammar, encodingNegativeValue(entry.case));
		} catch (error) {
			if (error instanceof GrammarError && error.category === entry.category) continue;
			throw new TypeError(
				`${entry.id}: expected ${entry.category}, received ${
					error instanceof GrammarError ? error.category : String(error)
				}`
			);
		}
		throw new TypeError(`${entry.id}: grammar accepted a forbidden source value`);
	}
	for (const example of grammar.workedExamples) {
		const encoded = grammarEncode(grammar, hydrateValue(example.value));
		requireCondition(hex(encoded) === example.hex, `${example.id}: binding example disagrees with grammar`);
	}
	const novel = contract.positiveCorpus.find((entry) => entry.id === contract.novelRuleCombinationId);
	requireCondition(novel !== undefined && !novel.workedExample, "novel corpus case cannot be a worked example");
	requireCondition(
		!grammar.workedExamples.some((example) => example.id === novel.id) &&
			hex(grammarEncode(grammar, hydrateValue(novel.value))) === novel.hex,
		"novel recursive combination must be governed by productions, not an example lookup"
	);
	for (const probe of contract.precedenceProbes) {
		const selected = selectPrecedence(grammar, probe.stage, probe.observations);
		requireCondition(
			selected?.category === probe.expectedCategory,
			`${probe.id}: precedence classifier selected ${selected?.category ?? "no category"}`
		);
	}
	for (const control of contract.encodeLimitControls) {
		const action = (): Uint8Array =>
			grammarEncode(grammar, encodeLimitValue(control.kind), { maxItems: control.maxItems });
		if (control.expectedHex !== undefined) {
			requireCondition(hex(action()) === control.expectedHex, `${control.id}: accepted bytes drift`);
		} else {
			expectGrammarCategory(action, control.expectedCategory as string);
		}
	}
	expectGrammarCategory(() => grammarEncode(grammar, [0], { maxItems: 0 }), "ITEM_LIMIT");
	expectGrammarCategory(() => grammarEncode(grammar, [[0]], { maxDepth: 1 }), "DEPTH_LIMIT");
	expectGrammarCategory(() => grammarEncode(grammar, "a", { maxBytes: 2 }), "BYTE_LIMIT");
	return {
		goldenVectorCases: goldenVectorRegistry.vectors.length,
		goldenVectorCanonicalBytes,
		goldenVectorElapsedMs,
	};
}

interface MutationCase {
	id: string;
	killStage: "behavioral-corpus" | "structural-validation";
	expectedKillerId?: string;
	mutate(grammar: Grammar): void;
}

function expectMutationKilled(mutation: MutationCase): void {
	const mutant = makeControlGrammar();
	mutation.mutate(mutant);
	let killed = false;
	let cause: unknown;
	try {
		if (mutation.killStage === "behavioral-corpus") runGrammarCorpus(mutant);
		else validateGrammar(mutant);
	} catch (error) {
		killed = true;
		cause = error;
	}
	expect(killed, `${mutation.id} must be killed by ${mutation.killStage}, not an earlier unrelated gate`).toBe(true);
	if (mutation.expectedKillerId !== undefined) {
		expect(cause).toBeInstanceOf(Error);
		expect((cause as Error).message, `${mutation.id} must die on its targeted corpus discriminator`).toContain(
			`${mutation.expectedKillerId}:`
		);
	}
}

function caughtError(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new TypeError("predecessor threw a non-Error value");
	}
	throw new TypeError("predecessor accepted a frozen forbidden case");
}

describe("Phase -1 prime b2a canonical grammar RED controls", () => {
	it("pins the bounded falsification corpus and executes the frozen predecessor only as extraction evidence", async () => {
		expect(contract).toMatchObject({
			profile: "drp-canonical-profile-1",
			planSha256: "ea31bdd9760106efc27c743976ab16f19167a109522aab4e0f11378b7d1d2831",
			status: "non-normative-falsification-contract",
		});
		expect(contract.expectedTags).toHaveLength(15);
		expect(contract.positiveCorpus).toHaveLength(contract.prRuntime.positiveCases);
		expect(contract.decodeNegativeCorpus).toHaveLength(contract.prRuntime.decodeNegativeCases);
		expect(contract.encodeNegativeCorpus).toHaveLength(contract.prRuntime.encodeNegativeCases);
		expect(contract.prRuntime).toMatchObject({
			goldenVectorCases: 26,
			goldenVectorCanonicalBytes: 10490,
			goldenVectorExecution: "required-in-pr",
			goldenVectorMaxRuntimeMs: 1000,
			largeFuzzingInThisSlice: false,
			seededLargeDifferentialTier: "nightly-or-weekly",
		});
		expect(contract.expectedPayloadTruncation).toEqual({
			string: { category: "UTF8_INVALID", predecessorMessage: "invalid UTF-8 string" },
			bytesAndContainers: { category: "TRUNCATED" },
		});
		expect(goldenVectorRegistry).toMatchObject({
			registryVersion: 5,
			canonicalHexSemantics: "canonical encoding of the normalized preimage record",
			partsHexSemantics: "ordered bytes passed to hashDomain after the domain",
		});
		expect(goldenVectorRegistry.vectors).toHaveLength(contract.prRuntime.goldenVectorCases);
		expect(contract.excludedCases).toEqual([
			expect.objectContaining({
				id: "unsafe-integral-scalar-float64-decode",
				disposition: "unresolved-outside-governed-corpus",
			}),
		]);
		for (const evidence of Object.values(contract.predecessorEvidence)) {
			const path = join(repositoryRoot, evidence.path);
			expect(existsSync(path), evidence.path).toBe(true);
			expect(sha256File(path), evidence.path).toBe(evidence.sha256);
		}

		const predecessor = (await import(predecessorModulePath)) as PredecessorCodec;
		for (const entry of contract.positiveCorpus) {
			expect(hex(predecessor.encodeCanonical(hydrateValue(entry.value))), entry.id).toBe(entry.hex);
		}
		for (const entry of contract.decodeNegativeCorpus) {
			const error = caughtError(() => predecessor.decodeCanonical(bytesFromHex(entry.hex), entry.limits));
			expect(error.message, entry.id).toBe(entry.predecessorMessage);
		}
		for (const entry of contract.encodeNegativeCorpus) {
			expect(() => predecessor.encodeCanonical(encodingNegativeValue(entry.case)), entry.id).toThrow();
		}
		for (const control of contract.encodeLimitControls) {
			const action = (): Uint8Array =>
				predecessor.encodeCanonical(encodeLimitValue(control.kind), { maxItems: control.maxItems });
			if (control.expectedHex !== undefined) {
				expect(hex(action()), control.id).toBe(control.expectedHex);
			} else {
				expect(action, control.id).toThrow();
			}
		}
	});

	it("runs a generic grammar interpreter over controls, novel recursion, limits, and canonical round trips", () => {
		const grammar = makeControlGrammar();
		validateGrammar(grammar);
		const metrics = runGrammarCorpus(grammar);
		expect(metrics).toMatchObject({
			goldenVectorCases: contract.prRuntime.goldenVectorCases,
			goldenVectorCanonicalBytes: contract.prRuntime.goldenVectorCanonicalBytes,
		});
		expect(metrics.goldenVectorElapsedMs).toBeLessThanOrEqual(contract.prRuntime.goldenVectorMaxRuntimeMs);
	});

	it("kills byte-affecting mutants behaviorally and labels structural-only mutants honestly", () => {
		const floatPrecedenceMutant = makeControlGrammar();
		floatPrecedenceMutant.rejectionPrecedence.float = [
			"TRUNCATED",
			"FLOAT_NON_FINITE",
			"FLOAT_SAFE_INTEGRAL",
			"FLOAT_NEGATIVE_ZERO",
		];
		expectGrammarCategory(
			() => grammarDecode(floatPrecedenceMutant, bytesFromHex("048000000000000000")),
			"FLOAT_SAFE_INTEGRAL"
		);

		const setPrecedenceMutant = makeControlGrammar();
		setPrecedenceMutant.rejectionPrecedence.set = ["DECODE_ELEMENT", "NEXT_ELEMENT", "SET_ORDER_OR_DUPLICATE"];
		const setProbe = contract.precedenceProbes.find((probe) => probe.id === "set-order-before-later-element-defect");
		if (setProbe === undefined) throw new TypeError("missing set precedence probe");
		expect(selectPrecedence(setPrecedenceMutant, setProbe.stage, setProbe.observations)?.category).toBe("UNKNOWN_TAG");

		const typedPrecedenceMutant = makeControlGrammar();
		typedPrecedenceMutant.rejectionPrecedence.typedArray = [
			"ELEMENT_ORDER",
			"TYPED_NON_FINITE",
			"TYPED_NEGATIVE_ZERO",
			"TRUNCATED",
		];
		expectGrammarCategory(() => grammarDecode(typedPrecedenceMutant, bytesFromHex("0b027fc00000")), "TYPED_NON_FINITE");

		const valueChargeMutant = makeControlGrammar();
		valueChargeMutant.limits.items.valueCharge = 0;
		expect(grammarDecode(valueChargeMutant, bytesFromHex("07010300"), { maxItems: 2 })).toEqual([0]);

		const rootDepthMutant = makeControlGrammar();
		rootDepthMutant.limits.depth.root = 1;
		expectGrammarCategory(() => grammarDecode(rootDepthMutant, bytesFromHex("00"), { maxDepth: 0 }), "DEPTH_LIMIT");

		const objectLimitMutant = makeControlGrammar();
		objectLimitMutant.limits.items.encodeImmediateKinds.push("object");
		expectGrammarCategory(
			() => grammarEncode(objectLimitMutant, encodeLimitValue("object"), { maxItems: 2 }),
			"ITEM_LIMIT"
		);

		const mutations: MutationCase[] = [
			{
				id: "tag-octet-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					const integer = grammar.tags.find((row) => row.name === "integer");
					if (integer === undefined) throw new TypeError("control grammar omits integer");
					integer.octet = 0x13;
				},
			},
			{
				id: "float-precedence-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.rejectionPrecedence.float = [
						"TRUNCATED",
						"FLOAT_SAFE_INTEGRAL",
						"FLOAT_NEGATIVE_ZERO",
						"FLOAT_NON_FINITE",
					];
				},
			},
			{
				id: "non-minimal-varuint-acceptance",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.varuint.minimal = false;
				},
			},
			{
				id: "varuint-post-terminator-precedence-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.rejectionPrecedence.varuint = [
						"TRUNCATED",
						"VARUINT_RANGE_OCTETS",
						"VARUINT_RANGE_VALUE",
						"VARUINT_NON_MINIMAL",
					];
				},
			},
			{
				id: "varuint-value-range-widening",
				killStage: "behavioral-corpus",
				expectedKillerId: "varuint-post-terminator-value-range",
				mutate(grammar): void {
					grammar.primitives.varuint.maxValue = "18014398509481984";
				},
			},
			{
				id: "encoded-ordering-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.ordering.direction = "descending";
				},
			},
			{
				id: "scalar-endianness-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.numbers.byteOrder = "little";
				},
			},
			{
				id: "typed-array-endianness-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					const uint32 = grammar.collections.typedArrays["uint32-array"];
					if (uint32 === undefined) throw new TypeError("control grammar omits uint32-array");
					uint32.byteOrder = "little";
				},
			},
			{
				id: "decoder-item-precharge-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.limits.items.containerPrecharge = false;
				},
			},
			{
				id: "zigzag-negative-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.zigzag.negative = "-2*n";
				},
			},
			{
				id: "integer-safe-bound-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.zigzag.minimum = "-9007199254740992";
				},
			},
			{
				id: "varuint-group-order-drift",
				killStage: "behavioral-corpus",
				expectedKillerId: "string-length-128-multi-octet-varuint",
				mutate(grammar): void {
					grammar.primitives.varuint.groupOrder = "most-significant-first";
				},
			},
			{
				id: "string-length-unit-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.strings.lengthUnit = "utf-16-code-units";
				},
			},
			{
				id: "negative-zero-policy-drift",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.primitives.numbers.negativeZero = "preserve-encode-accept-decode";
				},
			},
			{
				id: "duplicate-canonical-value-acceptance",
				killStage: "behavioral-corpus",
				mutate(grammar): void {
					grammar.ordering.duplicates = "allow-equal-encoded-bytes";
				},
			},
			{
				id: "required-rule-omission",
				killStage: "structural-validation",
				mutate(grammar): void {
					grammar.rules.splice(
						grammar.rules.findIndex((rule) => rule.id === "VARUINT_MINIMAL"),
						1
					);
				},
			},
			{
				id: "example-override-declaration",
				killStage: "structural-validation",
				mutate(grammar): void {
					grammar.conformance.examples = "examples-override-production-rules";
				},
			},
			{
				id: "implementation-import-shortcut",
				killStage: "structural-validation",
				mutate(grammar): void {
					const rule = grammar.rules[0];
					if (rule === undefined) throw new TypeError("control grammar omits rules");
					rule.statement = 'import("../packages/canonical/src/index.ts") supplies executable implementation source';
				},
			},
		];
		for (const mutation of mutations) expectMutationKilled(mutation);
	});
});

describe("Phase -1 prime b2a authoritative canonical grammar tuple", () => {
	it("supplies language-neutral Markdown plus executable declarative grammar reproducing the frozen corpus", () => {
		const markdownPath = join(repositoryRoot, contract.targets.markdown);
		const grammarPath = join(repositoryRoot, contract.targets.grammar);
		const missing = [
			...(!existsSync(markdownPath) ? [contract.targets.markdown] : []),
			...(!existsSync(grammarPath) ? [contract.targets.grammar] : []),
		];
		expect(
			missing,
			"causal RED: the authoritative drp-canonical-profile-1 Markdown/data-grammar tuple is absent"
		).toEqual([]);
		if (missing.length !== 0) return;

		expect(lstatSync(markdownPath).isFile()).toBe(true);
		expect(lstatSync(markdownPath).isSymbolicLink()).toBe(false);
		expect(lstatSync(grammarPath).isFile()).toBe(true);
		expect(lstatSync(grammarPath).isSymbolicLink()).toBe(false);
		const markdown = readFileSync(markdownPath, "utf8");
		const grammar = readJson<Grammar>(grammarPath);
		validateMarkdown(markdown);
		expect(
			grammar.rejectionPrecedence,
			"causal corrected RED: machine precedence must split varuint octet/value range phases and include INTEGER_RANGE"
		).toEqual(contract.expectedRejectionPrecedence);
		expect(
			grammar.limits,
			"causal corrected RED: machine limits must preserve predecessor object-encode behavior and expose only executed fields"
		).toEqual(contract.expectedLimitSemantics);
		validateGrammar(grammar);
		expect(grammar.authoritativeMarkdown.sha256).toBe(sha256File(markdownPath));
		runGrammarCorpus(grammar);

		for (const candidate of [markdownPath, grammarPath]) {
			expect(resolve(dirname(candidate), candidate)).toBe(candidate);
		}
	});
});
