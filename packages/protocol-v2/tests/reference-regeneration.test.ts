import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import registry from "../registry/field-registry.json" with { type: "json" };
import {
	encodeCanonical,
	hashDomain,
	makeRegistryPreimageBuilder as makeTypeScriptRegistryPreimageBuilder,
	type RegistryDocument,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const originalReferenceDirectory = fileURLToPath(new URL("../conformance/ahe-reference", import.meta.url));
const originalReferenceSourceDirectory = fileURLToPath(new URL("../conformance/ahe-reference/src", import.meta.url));
const regeneratedReferenceDirectory = fileURLToPath(new URL("../conformance/ahe-reference-regen", import.meta.url));
const regeneratedReferenceSourceDirectory = fileURLToPath(
	new URL("../conformance/ahe-reference-regen/src", import.meta.url)
);
const regeneratedCanonicalPath = fileURLToPath(
	new URL("../conformance/ahe-reference-regen/src/canonical.js", import.meta.url)
);
const regeneratedHashPath = fileURLToPath(new URL("../conformance/ahe-reference-regen/src/hash.js", import.meta.url));
const regeneratedRegistryPath = fileURLToPath(
	new URL("../conformance/ahe-reference-regen/src/registry.js", import.meta.url)
);
const regeneratedLockPath = fileURLToPath(new URL("../conformance/reference-regen.lock.json", import.meta.url));
const registryPath = fileURLToPath(new URL("../registry/field-registry.json", import.meta.url));
const vectorsPath = fileURLToPath(new URL("./fixtures/golden-vectors/registry-v5.json", import.meta.url));
const originalLockPath = fileURLToPath(new URL("../conformance/reference.lock.json", import.meta.url));
const freezeCheckerPath = fileURLToPath(new URL("../scripts/check-protocol-freeze.mjs", import.meta.url));
const originalCanonicalSpecifier: string = "../conformance/ahe-reference/src/canonical.js";
const originalHashSpecifier: string = "../conformance/ahe-reference/src/hash.js";
const regeneratedCanonicalSpecifier: string = "../conformance/ahe-reference-regen/src/canonical.js";
const regeneratedHashSpecifier: string = "../conformance/ahe-reference-regen/src/hash.js";
const regeneratedRegistrySpecifier: string = "../conformance/ahe-reference-regen/src/registry.js";

const provenancePaths = {
	originalReferenceLock: "packages/protocol-v2/conformance/reference.lock.json",
	registry: "packages/protocol-v2/registry/field-registry.json",
	vectors: "packages/protocol-v2/tests/fixtures/golden-vectors/registry-v5.json",
} as const;

interface GoldenVector {
	canonicalHex: string;
	digestHex: string;
	domain: string;
	id: string;
	input: unknown;
	kind: string;
	partsHex: string[];
	value: unknown;
}

interface GoldenVectorDocument {
	registryVersion: number;
	vectors: GoldenVector[];
}

interface RegeneratedReferenceLock {
	algorithm: "sha256";
	files: Record<string, string>;
	provenance: Record<keyof typeof provenancePaths, { path: string; sha256: string }>;
}

interface CanonicalOracle {
	decodeCanonical(bytes: Uint8Array): unknown;
	encodeCanonical(value: unknown): Uint8Array;
}

interface HashOracle {
	hashDomain(domain: string, ...parts: Uint8Array[]): Promise<Uint8Array> | Uint8Array;
}

interface RegistryOracle {
	makeRegistryPreimageBuilder(registryDocument: unknown, kind: string): (input: Record<string, unknown>) => unknown;
	registryPreimageParts(registryDocument: unknown, kind: string, input: Record<string, unknown>): Uint8Array[];
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("expected lowercase hexadecimal bytes");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function regularFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return regularFiles(path);
		return entry.isFile() ? [path] : [];
	});
}

function treeEntries(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? [path, ...treeEntries(path)] : [path];
	});
}

function moduleSpecifiers(source: string): string[] {
	const patterns = [
		/\bimport\s+(?:[^"'();]+?\s+from\s+)?["']([^"']+)["']/gu,
		/\bexport\s+(?:\*[^;"']*|\{[^}]*\})\s+from\s*["']([^"']+)["']/gu,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
	];
	return [
		...new Set(
			patterns.flatMap((pattern) =>
				Array.from(source.matchAll(pattern), (match) => {
					const specifier = match[1];
					if (specifier === undefined) throw new TypeError("module specifier capture is absent");
					return specifier;
				})
			)
		),
	];
}

function hydrateJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateJsonValue);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 1 && keys[0] === "$bytesHex") {
		const valueHex = record.$bytesHex;
		if (typeof valueHex !== "string") throw new TypeError("$bytesHex must be a string");
		return bytesFromHex(valueHex);
	}
	if (keys.length === 1 && keys[0] === "$typedArray") {
		const descriptor = record.$typedArray as { type?: unknown; values?: unknown };
		if (!Array.isArray(descriptor.values)) throw new TypeError("$typedArray.values must be an array");
		const values = descriptor.values.map((entry) => {
			if (typeof entry !== "number") throw new TypeError("$typedArray values must be numbers");
			return entry;
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
				throw new TypeError("$typedArray.type is not canonical");
		}
	}
	return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, hydrateJsonValue(nested)]));
}

function hydrateRecord(value: unknown, label: string): Record<string, unknown> {
	const hydrated = hydrateJsonValue(value);
	if (hydrated === null || typeof hydrated !== "object" || Array.isArray(hydrated)) {
		throw new TypeError(`${label} must be an object`);
	}
	return hydrated as Record<string, unknown>;
}

const deleteConstraint = Symbol("delete constraint");
const constraintMutations = [
	{ label: "deleted", value: deleteConstraint },
	{ label: "undefined", value: undefined },
	{ label: "null", value: null },
	{ label: "boolean:false", value: false },
	{ label: "boolean:true", value: true },
	{ label: "integer:-1", value: -1 },
	{ label: "integer:0", value: 0 },
	{ label: "integer:1", value: 1 },
	{ label: "integer:2", value: 2 },
	{ label: "non-integer:1.5", value: 1.5 },
	{ label: "string:not-a-number", value: "not-a-number" },
	{ label: "array:empty", value: [] },
	{ label: "object:empty", value: {} },
] as const;

const frozenConstraintNames = [
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
] as const;

function registryWithConstraintMutation(
	kind: string,
	fieldName: string,
	constraintName: string,
	mutation: (typeof constraintMutations)[number]
): RegistryDocument {
	const document = structuredClone(registry) as RegistryDocument;
	const definition = document.kinds[kind];
	if (definition === undefined) throw new TypeError(`missing registry kind ${kind}`);
	const field = definition.fields.find((candidate) => candidate.name === fieldName);
	if (field === undefined) throw new TypeError(`missing registry field ${kind}.${fieldName}`);
	if (mutation.value === deleteConstraint) delete (field.constraints as Record<string, unknown>)[constraintName];
	else (field.constraints as Record<string, unknown>)[constraintName] = structuredClone(mutation.value);
	return document;
}

function rejects(operation: () => unknown): boolean {
	try {
		operation();
		return false;
	} catch {
		return true;
	}
}

async function loadOracle(
	canonicalSpecifier: string,
	hashSpecifier: string
): Promise<{
	canonical: CanonicalOracle;
	hash: HashOracle;
}> {
	return {
		canonical: (await import(canonicalSpecifier)) as CanonicalOracle,
		hash: (await import(hashSpecifier)) as HashOracle,
	};
}

describe("Phase -1f independently regenerated reference", () => {
	it("keeps the v5 mint and original-reference ratchet byte-identical", () => {
		expect(registry.registryVersion).toBe(5);
		expect(existsSync(fileURLToPath(new URL("./fixtures/golden-vectors/registry-v6.json", import.meta.url)))).toBe(
			false
		);
		expect(sha256File(registryPath)).toBe("d073c5b01dc31c121de5fcd0925697a8a3f0839bf9fcf2c7ddde15489b49f724");
		expect(sha256File(vectorsPath)).toBe("2635989755ac300c1643f327ee7278d7aa0c72c67310b80ef56bb1eabe42b13e");
		expect(sha256File(originalLockPath)).toBe("ada22a8aa8c5e190e41d5cd8de84ed288d5a0047b10ef579602c28e50f294ffd");
	});

	it("coexists in a physically distinct source tree without copied bytes or outside imports", () => {
		expect(existsSync(originalReferenceDirectory)).toBe(true);
		expect(existsSync(regeneratedReferenceDirectory), "missing separately regenerated oracle tree").toBe(true);
		if (!existsSync(regeneratedReferenceDirectory)) return;

		expect(lstatSync(regeneratedReferenceDirectory).isSymbolicLink()).toBe(false);
		expect(realpathSync(regeneratedReferenceDirectory)).not.toBe(realpathSync(originalReferenceDirectory));
		expect(existsSync(regeneratedReferenceSourceDirectory), "missing regenerated source tree").toBe(true);
		if (!existsSync(regeneratedReferenceSourceDirectory)) return;

		const originalSourceHashes = new Set(regularFiles(originalReferenceSourceDirectory).map(sha256File));
		const regeneratedRoot = realpathSync(regeneratedReferenceDirectory);
		const regeneratedEntries = treeEntries(regeneratedReferenceSourceDirectory);
		const regeneratedSources = regeneratedEntries.filter((path) => lstatSync(path).isFile());
		expect(regeneratedSources.length).toBeGreaterThan(0);
		for (const path of regeneratedEntries) {
			const metadata = lstatSync(path);
			expect(metadata.isSymbolicLink(), `${path}: regenerated entries cannot be symlinks`).toBe(false);
			expect(
				metadata.isDirectory() || metadata.isFile(),
				`${path}: regenerated entries must be regular files or directories`
			).toBe(true);
		}
		for (const path of regeneratedSources) {
			expect(lstatSync(path).isFile(), `${path}: regenerated source must be a regular file`).toBe(true);
			expect(
				originalSourceHashes.has(sha256File(path)),
				`${path}: regenerated source bytes duplicate an original source file`
			).toBe(false);
			if (!path.endsWith(".js")) continue;
			for (const specifier of moduleSpecifiers(readFileSync(path, "utf8"))) {
				if (specifier.startsWith("node:")) continue;
				expect(specifier.startsWith("."), `${path}: outside or bare import ${specifier}`).toBe(true);
				if (!specifier.startsWith(".")) continue;
				const target = resolve(dirname(path), specifier);
				expect(existsSync(target), `${path}: unresolved relative import ${specifier}`).toBe(true);
				if (!existsSync(target)) continue;
				const realTarget = realpathSync(target);
				expect(
					realTarget === regeneratedRoot || realTarget.startsWith(`${regeneratedRoot}${sep}`),
					`${path}: relative import escapes regenerated tree: ${specifier}`
				).toBe(true);
			}
		}

		for (const path of [regeneratedCanonicalPath, regeneratedHashPath, regeneratedRegistryPath]) {
			expect(existsSync(path), `missing regenerated oracle module: ${path}`).toBe(true);
			if (existsSync(path)) expect(lstatSync(path).isSymbolicLink(), path).toBe(false);
		}
	});

	it("reproduces every applicable v5 vector from frozen partsHex in all three implementations", async () => {
		expect(existsSync(regeneratedCanonicalPath), "missing regenerated canonical oracle").toBe(true);
		expect(existsSync(regeneratedHashPath), "missing regenerated hash oracle").toBe(true);
		expect(existsSync(regeneratedRegistryPath), "missing regenerated registry oracle").toBe(true);
		if (
			!existsSync(regeneratedCanonicalPath) ||
			!existsSync(regeneratedHashPath) ||
			!existsSync(regeneratedRegistryPath)
		) {
			return;
		}

		const original = await loadOracle(originalCanonicalSpecifier, originalHashSpecifier);
		const regenerated = await loadOracle(regeneratedCanonicalSpecifier, regeneratedHashSpecifier);
		const regeneratedRegistry = (await import(regeneratedRegistrySpecifier)) as RegistryOracle;
		const document = readJson<GoldenVectorDocument>(vectorsPath);
		expect(document.registryVersion).toBe(5);
		expect(document.vectors.length).toBeGreaterThan(0);

		for (const vector of document.vectors) {
			const input = hydrateRecord(vector.input, `${vector.id}.input`);
			const value = hydrateJsonValue(vector.value);
			const build = regeneratedRegistry.makeRegistryPreimageBuilder(registry, vector.kind);
			expect(build(input), `${vector.id}: regenerated normalized preimage`).toEqual(value);
			expect(
				regeneratedRegistry.registryPreimageParts(registry, vector.kind, input).map(hex),
				`${vector.id}: regenerated registry parts`
			).toEqual(vector.partsHex);
			expect(hex(encodeCanonical(value)), `${vector.id}: TypeScript canonical bytes`).toBe(vector.canonicalHex);
			expect(hex(original.canonical.encodeCanonical(value)), `${vector.id}: original canonical bytes`).toBe(
				vector.canonicalHex
			);
			expect(hex(regenerated.canonical.encodeCanonical(value)), `${vector.id}: regenerated canonical bytes`).toBe(
				vector.canonicalHex
			);
			expect(
				regenerated.canonical.decodeCanonical(bytesFromHex(vector.canonicalHex)),
				`${vector.id}: regenerated canonical round trip`
			).toEqual(value);

			const frozenParts = vector.partsHex.map(bytesFromHex);
			expect(hex(hashDomain(vector.domain, ...frozenParts)), `${vector.id}: TypeScript frozen-parts digest`).toBe(
				vector.digestHex
			);
			expect(
				hex(await original.hash.hashDomain(vector.domain, ...frozenParts)),
				`${vector.id}: original frozen-parts digest`
			).toBe(vector.digestHex);
			expect(
				hex(await regenerated.hash.hashDomain(vector.domain, ...frozenParts)),
				`${vector.id}: regenerated frozen-parts digest`
			).toBe(vector.digestHex);
		}
	});

	it("matches TypeScript rejection across the bounded registry-derived constraint mutation matrix", async () => {
		const regeneratedRegistry = (await import(regeneratedRegistrySpecifier)) as RegistryOracle;
		const document = readJson<GoldenVectorDocument>(vectorsPath);
		const vectorsByKind = new Map<string, GoldenVector[]>();
		for (const vector of document.vectors) {
			const vectors = vectorsByKind.get(vector.kind) ?? [];
			vectors.push(vector);
			vectorsByKind.set(vector.kind, vectors);
		}
		const vectorsById = new Map(document.vectors.map((vector) => [vector.id, vector] as const));
		const exercisedConstraintNames = new Set<string>();
		const divergences = new Map<string, Set<string>>();
		let constraintOccurrences = 0;
		let probeCount = 0;
		let typeScriptRejectionCount = 0;

		const recordDivergence = (signature: string, vectorId: string): void => {
			const vectorIds = divergences.get(signature) ?? new Set<string>();
			vectorIds.add(vectorId);
			divergences.set(signature, vectorIds);
		};
		const runDifferentialProbe = (
			signature: string,
			alteredRegistry: RegistryDocument,
			kind: string,
			input: Record<string, unknown>,
			vectorId: string
		): void => {
			const typeScriptRejected = rejects(() => makeTypeScriptRegistryPreimageBuilder(alteredRegistry, kind)(input));
			if (!typeScriptRejected) return;
			typeScriptRejectionCount++;
			if (!rejects(() => regeneratedRegistry.makeRegistryPreimageBuilder(alteredRegistry, kind)(input))) {
				recordDivergence(signature, vectorId);
			}
		};

		for (const [kind, definition] of Object.entries(registry.kinds)) {
			const vectors = vectorsByKind.get(kind);
			expect(vectors, `${kind}: mutation matrix requires a frozen v5 vector`).toBeDefined();
			if (vectors === undefined) continue;
			for (const field of definition.fields) {
				for (const [constraintName, originalValue] of Object.entries(field.constraints)) {
					constraintOccurrences++;
					exercisedConstraintNames.add(constraintName);
					for (const vector of vectors) {
						const input = hydrateRecord(vector.input, `${vector.id}.input`);
						for (const mutation of constraintMutations) {
							if (mutation.value !== deleteConstraint && isDeepStrictEqual(mutation.value, originalValue)) {
								continue;
							}
							probeCount++;
							const alteredRegistry = registryWithConstraintMutation(kind, field.name, constraintName, mutation);
							runDifferentialProbe(
								`${kind}.${field.name}.${constraintName} <- ${mutation.label}`,
								alteredRegistry,
								kind,
								input,
								vector.id
							);
						}
					}
				}
			}
		}

		const namedProbes = [
			{
				constraint: "values",
				field: "profileId",
				input: { profileId: "bogus-profile-id" },
				kind: "profile",
				label: "OPUS: enum values deleted permits bogus profileId",
				mutation: constraintMutations[0],
				vectorId: "profile-baseline",
			},
			{
				constraint: "maxSignerIdUtf16Units",
				field: "signers",
				input: {},
				kind: "signerSet",
				label: "OPUS: maxSignerIdUtf16Units='not-a-number'",
				mutation: constraintMutations[10],
				vectorId: "signerSet-baseline",
			},
			{
				constraint: "uniqueBy",
				field: "signers",
				input: {},
				kind: "profile",
				label: "OPUS: uniqueBy non-string on one-signer profile",
				mutation: constraintMutations[8],
				vectorId: "profile-baseline",
			},
		] as const;
		const exercisedNamedProbes = new Set<string>();
		for (const named of namedProbes) {
			const vector = vectorsById.get(named.vectorId);
			if (vector === undefined) throw new TypeError(`missing frozen vector ${named.vectorId}`);
			const input = { ...hydrateRecord(vector.input, `${vector.id}.input`), ...named.input };
			const alteredRegistry = registryWithConstraintMutation(named.kind, named.field, named.constraint, named.mutation);
			exercisedNamedProbes.add(named.label);
			runDifferentialProbe(named.label, alteredRegistry, named.kind, input, vector.id);
		}

		expect([...exercisedConstraintNames].sort()).toEqual([...frozenConstraintNames]);
		expect(constraintOccurrences).toBe(147);
		expect(probeCount).toBe(2662);
		expect(typeScriptRejectionCount).toBeGreaterThanOrEqual(1_000);
		expect([...exercisedNamedProbes].sort()).toEqual(namedProbes.map(({ label }) => label).sort());
		expect(
			[...divergences.entries()]
				.map(([signature, vectorIds]) => `${signature} :: ${[...vectorIds].sort().join(",")}`)
				.sort(),
			`${divergences.size} regenerated metadata-validation signatures accepted inputs rejected by TypeScript`
		).toEqual([]);
	});

	it("implements the amended Float32 negative-zero rule instead of copying the original oracle", async () => {
		expect(existsSync(regeneratedCanonicalPath), "missing regenerated canonical oracle").toBe(true);
		if (!existsSync(regeneratedCanonicalPath)) return;

		const original = (await import(originalCanonicalSpecifier)) as CanonicalOracle;
		const regenerated = (await import(regeneratedCanonicalSpecifier)) as CanonicalOracle;
		const positive = encodeCanonical(Float32Array.of(+0));
		expect(regenerated.encodeCanonical(Float32Array.of(-0))).toEqual(positive);
		expect(original.encodeCanonical(Float32Array.of(-0))).not.toEqual(positive);
		expect(() => regenerated.decodeCanonical(Uint8Array.of(0x0b, 0x01, 0x80, 0x00, 0x00, 0x00))).toThrow();
	});

	it("content-addresses the complete regenerated tree and exactly three frozen provenance inputs", () => {
		expect(existsSync(regeneratedLockPath), "missing regenerated-reference lock").toBe(true);
		expect(existsSync(regeneratedReferenceDirectory), "missing regenerated-reference tree").toBe(true);
		if (!existsSync(regeneratedLockPath) || !existsSync(regeneratedReferenceDirectory)) return;

		const lock = readJson<RegeneratedReferenceLock>(regeneratedLockPath);
		expect(lock.algorithm).toBe("sha256");
		const expectedFiles = regularFiles(regeneratedReferenceDirectory)
			.map((path) => relative(regeneratedReferenceDirectory, path).replaceAll("\\", "/"))
			.sort();
		expect(expectedFiles.length).toBeGreaterThan(0);
		expect(Object.keys(lock.files).sort()).toEqual(expectedFiles);
		for (const path of expectedFiles) {
			expect(lock.files[path], path).toBe(sha256File(join(regeneratedReferenceDirectory, path)));
		}

		expect(Object.keys(lock.provenance).sort()).toEqual(Object.keys(provenancePaths).sort());
		for (const [name, path] of Object.entries(provenancePaths)) {
			const entry = lock.provenance[name as keyof typeof provenancePaths];
			expect(entry.path, name).toBe(path);
			expect(entry.sha256, name).toBe(sha256File(join(repositoryRoot, path)));
		}
	});

	it("is accepted as the valid atomic pair by the actual base-governed freeze CLI", () => {
		expect(existsSync(regeneratedReferenceDirectory), "missing regenerated-reference tree").toBe(true);
		expect(existsSync(regeneratedLockPath), "missing regenerated-reference lock").toBe(true);
		if (!existsSync(regeneratedReferenceDirectory) || !existsSync(regeneratedLockPath)) return;

		const result = spawnSync(process.execPath, [freezeCheckerPath, "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: { ...process.env, PROTOCOL_FREEZE_REPOSITORY_ROOT: repositoryRoot },
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("protocol freeze policy passed");
	});
});
