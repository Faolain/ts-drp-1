import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const sourceEntryPath = join(packageDirectory, "src/index.ts");
const sourceExists = existsSync(sourceEntryPath);
const sourceModulePath: string = "../src/index.js";
const originalCanonicalPath: string = "../../protocol-v2/conformance/ahe-reference/src/canonical.js";
const vectorsPath = fileURLToPath(
	new URL("../../protocol-v2/tests/fixtures/golden-vectors/registry-v5.json", import.meta.url)
);

interface CanonicalLimits {
	maxBytes?: number;
	maxDepth?: number;
	maxItems?: number;
}

interface CanonicalModule {
	CanonicalDecodingError: new (message?: string) => TypeError;
	CanonicalEncodingError: new (message?: string) => TypeError;
	compareBytes(left: Uint8Array, right: Uint8Array): number;
	decodeCanonical(input: Uint8Array, limits?: CanonicalLimits): unknown;
	deepCloneCanonical<T>(value: T): T;
	encodeCanonical(value: unknown, limits?: CanonicalLimits): Uint8Array;
	hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array;
}

interface OriginalCanonicalModule {
	decodeCanonical(input: Uint8Array, limits?: CanonicalLimits): unknown;
	encodeCanonical(value: unknown, limits?: CanonicalLimits): Uint8Array;
}

interface GoldenVector {
	canonicalHex: string;
	digestHex: string;
	domain: string;
	id: string;
	partsHex: string[];
	value: unknown;
}

interface GoldenVectorDocument {
	registryVersion: number;
	vectors: GoldenVector[];
}

interface PackageDocument {
	dependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
	files?: string[];
	name?: string;
	scripts?: Record<string, string>;
	type?: string;
	types?: string;
}

interface DecodeFailure {
	bytes: Uint8Array;
	id: string;
	limits?: CanonicalLimits;
}

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("expected lowercase hexadecimal bytes");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hydrateJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateJsonValue);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 1 && keys[0] === "$bytesHex") {
		if (typeof record.$bytesHex !== "string") throw new TypeError("$bytesHex must be a string");
		return bytesFromHex(record.$bytesHex);
	}
	if (keys.length === 1 && keys[0] === "$typedArray") {
		const descriptor = record.$typedArray as { type?: unknown; values?: unknown };
		if (!Array.isArray(descriptor.values)) throw new TypeError("$typedArray.values must be an array");
		const values = descriptor.values.map((item) => {
			if (typeof item !== "number") throw new TypeError("$typedArray values must be numbers");
			return item;
		});
		switch (descriptor.type) {
			case "Float32Array":
				return Float32Array.from(values);
			case "Float64Array":
				return Float64Array.from(values);
			case "Int32Array":
				return Int32Array.from(values);
			case "Uint32Array":
				return Uint32Array.from(values);
			default:
				throw new TypeError("unknown frozen typed-array descriptor");
		}
	}
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, hydrateJsonValue(item)]));
}

function sourceFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

function hasTopLevelAwait(sourceFile: ts.SourceFile): boolean {
	let found = false;
	const visit = (node: ts.Node, insideFunction: boolean): void => {
		if (found) return;
		const functionBoundary = insideFunction || ts.isFunctionLike(node);
		if (!functionBoundary && ts.isAwaitExpression(node)) {
			found = true;
			return;
		}
		if (!functionBoundary && ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
			found = true;
			return;
		}
		ts.forEachChild(node, (child) => visit(child, functionBoundary));
	};
	visit(sourceFile, false);
	return found;
}

function deterministicValues(count: number, seed: number): unknown[] {
	let state = seed >>> 0;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	const strings = ["", "a", "Peer-A", "peer-ä", "peer_😀", "\u{10ffff}"] as const;
	const output: unknown[] = [];
	for (let index = 0; index < count; index++) {
		const first = next();
		const second = next();
		const signed = (first & 0x7fff_ffff) - 0x4000_0000;
		switch (first % 13) {
			case 0:
				output.push(null);
				break;
			case 1:
				output.push((second & 1) === 0);
				break;
			case 2:
				output.push(signed);
				break;
			case 3:
				output.push(signed + 0.25);
				break;
			case 4:
				output.push(strings[second % strings.length]);
				break;
			case 5:
				output.push(Uint8Array.of(first & 0xff, second & 0xff, (second >>> 8) & 0xff));
				break;
			case 6:
				output.push([signed, strings[second % strings.length], (first & 1) === 0]);
				break;
			case 7:
				output.push({ z: signed, a: strings[second % strings.length] });
				break;
			case 8:
				output.push(
					new Map<unknown, unknown>([
						["z", signed],
						["a", strings[second % strings.length]],
					])
				);
				break;
			case 9:
				output.push(new Set<unknown>([signed, signed + 1]));
				break;
			case 10:
				output.push(Float32Array.of((signed % 1024) + 0.5, (second % 1024) + 0.25));
				break;
			case 11:
				output.push(Float64Array.of((signed % 4096) + 0.5, (second % 4096) + 0.25));
				break;
			default:
				output.push(Int32Array.of(signed, second | 0));
		}
	}
	return output;
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
	const shuffled = [...values];
	let state = seed >>> 0;
	for (let index = shuffled.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		const target = state % (index + 1);
		[shuffled[index], shuffled[target]] = [shuffled[target] as T, shuffled[index] as T];
	}
	return shuffled;
}

function caughtError(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new TypeError("canonical decoder threw a non-Error value");
	}
	throw new TypeError("canonical decoder unexpectedly accepted a frozen forbidden form");
}

async function loadCanonical(): Promise<CanonicalModule> {
	return (await import(sourceModulePath)) as CanonicalModule;
}

async function loadOriginalCanonical(): Promise<OriginalCanonicalModule> {
	return (await import(originalCanonicalPath)) as OriginalCanonicalModule;
}

describe("Phase 0a @ts-drp/canonical RED contract", () => {
	it("declares the package boundary but remains RED until the new package owns a source entry", () => {
		const document = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as PackageDocument;

		expect(document).toMatchObject({
			dependencies: { "@noble/hashes": "^1.7.1" },
			exports: {
				".": {
					import: "./dist/src/index.js",
					types: "./dist/src/index.d.ts",
				},
			},
			files: ["src", "dist", "!dist/test", "!**/*.tsbuildinfo"],
			name: "@ts-drp/canonical",
			type: "module",
			types: "./dist/src/index.d.ts",
		});
		expect(document.scripts).toMatchObject({
			build: "tsc -b tsconfig.build.json",
			test: "vitest run",
			typecheck: "tsc --noEmit",
		});
		expect(sourceExists, "GREEN must add packages/canonical/src/index.ts; protocol-v2 is not the codec owner").toBe(
			true
		);
	});
});

describe.skipIf(!sourceExists)("Phase 0a canonical public API and runtime shape", () => {
	it("exports only the seven runtime primitives needed by protocol consumers", async () => {
		const canonical = await loadCanonical();

		expect(Object.keys(canonical).sort()).toEqual([
			"CanonicalDecodingError",
			"CanonicalEncodingError",
			"compareBytes",
			"decodeCanonical",
			"deepCloneCanonical",
			"encodeCanonical",
			"hashDomain",
		]);
		expect(canonical.CanonicalDecodingError.prototype).toBeInstanceOf(TypeError);
		expect(canonical.CanonicalEncodingError.prototype).toBeInstanceOf(TypeError);
	});

	it("uses the sync noble backend with no top-level await or runtime-specific crypto fallback", async () => {
		const canonical = await loadCanonical();
		const files = sourceFiles(join(packageDirectory, "src"));
		const combinedSource = files.map((path) => readFileSync(path, "utf8")).join("\n");

		expect(files.length).toBeGreaterThan(0);
		expect(combinedSource).toContain('"@noble/hashes/sha2"');
		expect(combinedSource).not.toMatch(/(?:node:crypto|crypto\.subtle|localeCompare|\bBuffer\b)/u);
		for (const path of files) {
			const source = readFileSync(path, "utf8");
			const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			expect(hasTopLevelAwait(parsed), `${basename(path)} must not use top-level await`).toBe(false);
		}

		const encoded: Uint8Array = canonical.encodeCanonical({ ready: true });
		const digest: Uint8Array = canonical.hashDomain("ts-drp/phase-0a/v2", encoded);
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(digest).toBeInstanceOf(Uint8Array);
		expect("then" in (digest as unknown as Record<string, unknown>)).toBe(false);
	});
});

describe.skipIf(!sourceExists)("Phase 0a frozen vectors and pinned-reference differential", () => {
	it("reproduces canonical bytes and registered framed digests for every registry-v5 vector", async () => {
		const canonical = await loadCanonical();
		const document = JSON.parse(readFileSync(vectorsPath, "utf8")) as GoldenVectorDocument;

		expect(document.registryVersion).toBe(5);
		expect(document.vectors).toHaveLength(26);
		for (const vector of document.vectors) {
			const value = hydrateJsonValue(vector.value);
			const parts = vector.partsHex.map(bytesFromHex);
			expect(hex(canonical.encodeCanonical(value)), `${vector.id}: canonical bytes`).toBe(vector.canonicalHex);
			expect(hex(canonical.hashDomain(vector.domain, ...parts)), `${vector.id}: digest`).toBe(vector.digestHex);
		}
	});

	it("matches the immutable original reference over a bounded seeded PR corpus", async () => {
		const canonical = await loadCanonical();
		const reference = await loadOriginalCanonical();
		const corpus = deterministicValues(256, 0x50a_2026);

		expect(corpus).toHaveLength(256);
		for (const [index, value] of corpus.entries()) {
			expect(canonical.encodeCanonical(value), `seed 0x50a2026 case ${index}`).toEqual(
				reference.encodeCanonical(value)
			);
		}
	});
});

describe.skipIf(!sourceExists)("Phase 0a frozen amendments and ordering", () => {
	it("implements D2 by normalizing Float32Array -0 to the frozen +0 bytes", async () => {
		const canonical = await loadCanonical();
		const reference = await loadOriginalCanonical();
		const originalNegative = reference.encodeCanonical(Float32Array.of(-0));
		const frozenPositive = reference.encodeCanonical(Float32Array.of(+0));

		expect(originalNegative).not.toEqual(frozenPositive);
		expect(canonical.encodeCanonical(Float32Array.of(-0))).toEqual(frozenPositive);
		expect(canonical.encodeCanonical(Float32Array.of(+0))).toEqual(frozenPositive);
		expect(canonical.decodeCanonical(frozenPositive)).toEqual(Float32Array.of(0));
		expect(() => canonical.decodeCanonical(originalNegative)).toThrow();
	});

	it("sorts objects, maps, and sets by canonical bytes without consulting the host locale", async () => {
		const canonical = await loadCanonical();
		const values = ["peer-B", "peer-a", "Peer-a", "peer_a", "peerä", "peer-😀"];
		const expectedObject = canonical.encodeCanonical(Object.fromEntries(values.map((value) => [value, value])));
		const expectedMap = canonical.encodeCanonical(new Map(values.map((value) => [value, value])));
		const expectedSet = canonical.encodeCanonical(new Set(values));
		const localeSpy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
			throw new TypeError("canonical ordering must be locale-free");
		});
		try {
			for (let seed = 1; seed <= 32; seed++) {
				const shuffled = deterministicShuffle(values, seed);
				expect(canonical.encodeCanonical(Object.fromEntries(shuffled.map((value) => [value, value])))).toEqual(
					expectedObject
				);
				expect(canonical.encodeCanonical(new Map(shuffled.map((value) => [value, value])))).toEqual(expectedMap);
				expect(canonical.encodeCanonical(new Set(shuffled))).toEqual(expectedSet);
			}
			expect(canonical.compareBytes(Uint8Array.of(0, 255), Uint8Array.of(1, 0))).toBe(-1);
		} finally {
			localeSpy.mockRestore();
		}
	});
});

describe.skipIf(!sourceExists)("Phase 0a frozen negative decoder corpus", () => {
	it("rejects only already-frozen forbidden forms with the immutable reference reason", async () => {
		const canonical = await loadCanonical();
		const reference = await loadOriginalCanonical();
		const failures: DecodeFailure[] = [
			{ id: "negative-zero", bytes: bytesFromHex("048000000000000000") },
			{ id: "nan", bytes: bytesFromHex("047ff8000000000000") },
			{ id: "positive-infinity", bytes: bytesFromHex("047ff0000000000000") },
			{ id: "negative-infinity", bytes: bytesFromHex("04fff0000000000000") },
			// Safe integral Float64 is frozen non-canonical. Unsafe integral Float64 remains deliberately unclassified.
			{ id: "safe-integral-float64", bytes: bytesFromHex("043ff0000000000000") },
			{ id: "unpaired-surrogate-utf8", bytes: bytesFromHex("0503eda080") },
			{ id: "duplicate-map-key", bytes: bytesFromHex("090205016103000501610302") },
			{ id: "out-of-order-map-key", bytes: bytesFromHex("090205016203000501610302") },
			{ id: "non-minimal-varuint", bytes: bytesFromHex("058000") },
			{ id: "trailing-bytes", bytes: bytesFromHex("00ff") },
			{ id: "unknown-tag", bytes: bytesFromHex("0f") },
			{ id: "depth-limit", bytes: bytesFromHex("070107010300"), limits: { maxDepth: 1 } },
			{ id: "item-limit", bytes: bytesFromHex("07010300"), limits: { maxItems: 1 } },
			{ id: "byte-limit", bytes: bytesFromHex("060100"), limits: { maxBytes: 2 } },
		];

		for (const failure of failures) {
			const expected = caughtError(() => reference.decodeCanonical(failure.bytes, failure.limits));
			const actual = caughtError(() => canonical.decodeCanonical(failure.bytes, failure.limits));
			expect(actual, failure.id).toBeInstanceOf(canonical.CanonicalDecodingError);
			expect(actual.message, failure.id).toBe(expected.message);
		}
	});

	it("rejects unpaired surrogate input before encoding", async () => {
		const canonical = await loadCanonical();
		const reference = await loadOriginalCanonical();

		for (const value of ["\ud800", "\udfff"]) {
			const expected = caughtError(() => reference.encodeCanonical(value));
			const actual = caughtError(() => canonical.encodeCanonical(value));
			expect(actual).toBeInstanceOf(canonical.CanonicalEncodingError);
			expect(actual.message).toBe(expected.message);
		}
	});

	it("decodes __proto__ as inert data without prototype pollution", async () => {
		const canonical = await loadCanonical();
		const reference = await loadOriginalCanonical();
		const value = Object.create(null) as Record<string, unknown>;
		value.__proto__ = { polluted: true };
		const frozenBytes = reference.encodeCanonical(value);
		const decoded = canonical.decodeCanonical(frozenBytes) as Record<string, unknown>;

		expect(Object.getPrototypeOf(decoded)).toBeNull();
		expect(decoded.polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
	});
});
