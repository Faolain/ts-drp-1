import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import registry from "../registry/field-registry.json" with { type: "json" };
import { encodeCanonical, hashDomain, makeRegistryPreimageBuilder, registryPreimageParts } from "../src/index.js";

const goldenVectorDirectory = fileURLToPath(new URL("./fixtures/golden-vectors", import.meta.url));
const currentVectorsPath = join(goldenVectorDirectory, `registry-v${registry.registryVersion}.json`);
const referenceDirectory = fileURLToPath(new URL("../conformance/ahe-reference/src", import.meta.url));
const referenceLockPath = fileURLToPath(new URL("../conformance/reference.lock.json", import.meta.url));
const freezePolicyPath = fileURLToPath(new URL("../conformance/freeze-policy.json", import.meta.url));
const freezeCheckerPath = fileURLToPath(new URL("../scripts/check-protocol-freeze.mjs", import.meta.url));
const sourceChecksumsPath = fileURLToPath(
	new URL("../../../docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt", import.meta.url)
);
const codeownersPath = fileURLToPath(new URL("../../../CODEOWNERS", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../../.github/workflows/protocol-v2-registry.yml", import.meta.url));

const requiredCodeownersPatterns = [
	"/CODEOWNERS",
	"/packages/protocol-v2/registry/**",
	"/packages/protocol-v2/tests/fixtures/golden-vectors/**",
	"/packages/protocol-v2/conformance/reference.lock.json",
	"/packages/protocol-v2/conformance/freeze-policy.json",
	"/packages/protocol-v2/conformance/ahe-reference/src/**",
	"/packages/protocol-v2/conformance/ahe-reference-regen/**",
	"/packages/protocol-v2/conformance/reference-regen.lock.json",
	"/packages/protocol-v2/scripts/check-protocol-freeze.mjs",
	"/.github/workflows/protocol-v2-registry.yml",
] as const;

const requiredProtectedPaths = [
	"packages/protocol-v2/conformance/ahe-reference/src/**",
	"packages/protocol-v2/conformance/reference.lock.json",
	"packages/protocol-v2/conformance/ahe-reference-regen/**",
	"packages/protocol-v2/conformance/reference-regen.lock.json",
	"packages/protocol-v2/tests/fixtures/golden-vectors/**",
	"packages/protocol-v2/registry/**",
	"packages/protocol-v2/scripts/check-protocol-freeze.mjs",
	"packages/protocol-v2/conformance/freeze-policy.json",
	"docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt",
	".github/CODEOWNERS",
	"docs/CODEOWNERS",
] as const;

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
	canonicalHexSemantics: string;
	partsHexSemantics: string;
	registryVersion: number;
	vectors: GoldenVector[];
}

interface ReferenceLock {
	algorithm: "sha256";
	files: Record<string, string>;
}

interface FreezePolicy {
	checker: { path: string; sha256: string };
	protectedPaths: string[];
	regenReferencePath: string;
	regenLockPath: string;
	sourceChecksumsPath: string;
	version: number;
}

interface FreezeSnapshot {
	files: Record<string, string>;
	policy: FreezePolicy | undefined;
	registryVersion: number;
	vectorBytes: Record<string, string>;
	vectorDocuments: Record<string, { records: Record<string, string>; registryVersion: number }>;
}

type FreezeEvaluator = (input: { base: FreezeSnapshot; current: FreezeSnapshot }) => void;

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

function versionedVectorPaths(): readonly { path: string; version: number }[] {
	if (!existsSync(goldenVectorDirectory)) return [];
	return readdirSync(goldenVectorDirectory)
		.map((entry) => ({ entry, match: /^registry-v([1-9][0-9]*)\.json$/u.exec(entry) }))
		.filter((candidate): candidate is { entry: string; match: RegExpExecArray } => candidate.match !== null)
		.map(({ entry, match }) => ({ path: join(goldenVectorDirectory, entry), version: Number(match[1]) }))
		.sort((left, right) => left.version - right.version);
}

function hydrateJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateJsonValue);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 1 && keys[0] === "$bytesHex") {
		const hexValue = record.$bytesHex;
		if (typeof hexValue !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(hexValue)) {
			throw new TypeError("$bytesHex must be an even-length lowercase hexadecimal string");
		}
		return Uint8Array.from(hexValue.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
	}
	if (keys.length === 1 && keys[0] === "$typedArray") {
		const typed = record.$typedArray;
		if (typed === null || typeof typed !== "object") throw new TypeError("$typedArray must name a typed-array value");
		const descriptor = typed as { type?: unknown; values?: unknown };
		if (!Array.isArray(descriptor.values)) throw new TypeError("$typedArray.values must be an array");
		const values = descriptor.values.map((entry) => {
			if (typeof entry !== "number") throw new TypeError("$typedArray.values must contain numbers");
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
				throw new TypeError("$typedArray.type is not a canonical typed array");
		}
	}
	return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, hydrateJsonValue(nested)]));
}

function hydrateRecord(value: unknown, label: string): Record<string, unknown> {
	const hydrated = hydrateJsonValue(value);
	if (hydrated === null || typeof hydrated !== "object" || Array.isArray(hydrated) || hydrated instanceof Uint8Array) {
		throw new TypeError(`${label} must be a JSON object`);
	}
	return hydrated as Record<string, unknown>;
}

function containsNonByteTypedArray(value: unknown): boolean {
	if (value instanceof Uint8Array) return false;
	if (ArrayBuffer.isView(value)) return true;
	if (Array.isArray(value)) return value.some(containsNonByteTypedArray);
	if (value !== null && typeof value === "object") return Object.values(value).some(containsNonByteTypedArray);
	return false;
}

function codeownersEntries(source: string): Map<string, string[]> {
	return new Map(
		source
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.map((line) => line.split(/\s+/u))
			.filter((parts) => parts.length > 1)
			.map(([pattern, ...owners]) => [pattern as string, owners] as const)
	);
}

function originalReferenceSourceSums(): Record<string, string> {
	const entries = readFileSync(sourceChecksumsPath, "utf8")
		.split(/\r?\n/u)
		.map((line) => /^([0-9a-f]{64}) {2}\.\/reference-implementation\/(src\/[^\s]+)$/u.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => [(match[2] as string).replace(/^src\//u, ""), match[1] as string] as const);
	return Object.fromEntries(entries);
}

async function freezeEvaluator(): Promise<FreezeEvaluator> {
	expect(existsSync(freezeCheckerPath), `missing pure-Node freeze checker: ${freezeCheckerPath}`).toBe(true);
	const moduleUrl = new URL("../scripts/check-protocol-freeze.mjs", import.meta.url).href;
	const checker = (await import(moduleUrl)) as { evaluateFreezePolicy?: unknown };
	expect(checker.evaluateFreezePolicy, "freeze checker must export evaluateFreezePolicy").toBeTypeOf("function");
	return checker.evaluateFreezePolicy as FreezeEvaluator;
}

function policy(overrides: Partial<FreezePolicy> = {}): FreezePolicy {
	return {
		checker: {
			path: "packages/protocol-v2/scripts/check-protocol-freeze.mjs",
			sha256: "a".repeat(64),
		},
		protectedPaths: [
			"packages/protocol-v2/conformance/ahe-reference/src/**",
			"packages/protocol-v2/conformance/reference.lock.json",
			"packages/protocol-v2/tests/fixtures/golden-vectors/**",
			"packages/protocol-v2/registry/**",
		],
		regenReferencePath: "packages/protocol-v2/conformance/ahe-reference-regen/**",
		regenLockPath: "packages/protocol-v2/conformance/reference-regen.lock.json",
		sourceChecksumsPath: "docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt",
		version: 1,
		...overrides,
	};
}

function snapshot(
	overrides: Partial<Omit<FreezeSnapshot, "policy">> & { policy?: FreezePolicy | undefined } = {}
): FreezeSnapshot {
	return {
		files: {
			"packages/protocol-v2/conformance/ahe-reference/src/canonical.js": "canonical-vendor-sha",
			"packages/protocol-v2/conformance/reference.lock.json": "original-lock-sha",
			"packages/protocol-v2/registry/field-registry.json": "registry-v5-sha",
		},
		policy: policy(),
		registryVersion: 5,
		vectorBytes: { "registry-v5.json": "vectors-v5" },
		vectorDocuments: {
			"registry-v5.json": { records: { baseline: "record-v5" }, registryVersion: 5 },
		},
		...overrides,
	};
}

describe("Phase -1e(ii) golden-vector and oracle-freeze gates", () => {
	it("pins non-empty, registry-versioned vectors against both the TypeScript codec and the reference codec", async () => {
		expect(existsSync(currentVectorsPath), `missing minted vector artifact: ${currentVectorsPath}`).toBe(true);

		const document = readJson<GoldenVectorDocument>(currentVectorsPath);
		expect(document.registryVersion).toBe(registry.registryVersion);
		expect(document.canonicalHexSemantics).toBe("canonical encoding of the normalized preimage record");
		expect(document.partsHexSemantics).toBe("ordered bytes passed to hashDomain after the domain");
		expect(document.vectors.length).toBeGreaterThan(0);
		expect(new Set(document.vectors.map((vector) => vector.id)).size).toBe(document.vectors.length);
		expect(new Set(document.vectors.map((vector) => vector.kind))).toEqual(new Set(Object.keys(registry.kinds)));
		for (const [kind, definition] of Object.entries(registry.kinds)) {
			for (const field of definition.fields) {
				const permitted = (field.constraints as Record<string, unknown>).values;
				if (!Array.isArray(permitted)) continue;
				const observed = document.vectors
					.filter((vector) => vector.kind === kind)
					.map((vector) => hydrateRecord(vector.input, `${vector.id}.input`)[field.name]);
				expect(new Set(observed), `${kind}.${field.name}: every enum value needs a positive vector`).toEqual(
					new Set(permitted)
				);
			}
		}

		const referencePath: string = "../conformance/ahe-reference/src/canonical.js";
		const referenceHashPath: string = "../conformance/ahe-reference/src/hash.js";
		const referenceCanonical = (await import(referencePath)) as { encodeCanonical(value: unknown): Uint8Array };
		const referenceHash = (await import(referenceHashPath)) as {
			hashDomain(domain: string, ...parts: Uint8Array[]): Promise<Uint8Array>;
		};
		const registeredDomains = new Set(Object.values(registry.domains));

		for (const vector of document.vectors) {
			expect(registry.domains[vector.kind as keyof typeof registry.domains], `${vector.id}: unregistered kind`).toBe(
				vector.domain
			);
			expect(registeredDomains.has(vector.domain), `${vector.id}: unregistered domain`).toBe(true);
			const definition = registry.kinds[vector.kind as keyof typeof registry.kinds];
			expect(definition, `${vector.id}: missing registry definition`).toBeDefined();
			const input = hydrateRecord(vector.input, `${vector.id}.input`);
			const expectedPreimage = hydrateJsonValue(vector.value);
			const build = makeRegistryPreimageBuilder(registry, vector.kind);
			const preimage = build(input);
			expect(preimage, `${vector.id}: vector value must be the registry-normalized preimage`).toEqual(expectedPreimage);
			for (const field of definition?.fields ?? []) {
				const supplied = Object.hasOwn(input, field.name);
				if (field.required) {
					expect(supplied, `${vector.id}: input omits required registered field ${field.name}`).toBe(true);
				}
				if (!supplied) continue;
				if (field.type === "bytes") {
					expect(
						input[field.name],
						`${vector.id}: byte-bearing ${field.name} must hydrate from $bytesHex`
					).toBeInstanceOf(Uint8Array);
				}
				if (field.type === "canonical-value" || field.type === "array<canonical-value>") {
					expect(
						containsNonByteTypedArray(input[field.name]),
						`${vector.id}: original-reference vectors cannot place typed arrays in open canonical slots`
					).toBe(false);
				}
				if (field.required && field.const === null) {
					const missing = { ...input };
					delete missing[field.name];
					expect(() => build(missing), `${vector.id}: omitted ${field.name}`).toThrow();
				}
				expect(() => build({ ...input, [field.name]: undefined }), `${vector.id}: wrong-typed ${field.name}`).toThrow();
			}
			expect(() => build({ ...input, unregisteredGoldenVectorField: true }), `${vector.id}: unknown field`).toThrow();
			expect(vector.canonicalHex, `${vector.id}: canonicalHex must be lowercase hex`).toMatch(/^(?:[0-9a-f]{2})+$/u);
			expect(vector.digestHex, `${vector.id}: digestHex must be a SHA-256 digest`).toMatch(/^[0-9a-f]{64}$/u);
			expect(hex(encodeCanonical(preimage)), `${vector.id}: TypeScript canonical bytes`).toBe(vector.canonicalHex);
			expect(hex(referenceCanonical.encodeCanonical(preimage)), `${vector.id}: reference canonical bytes`).toBe(
				vector.canonicalHex
			);
			const parts = registryPreimageParts(registry, vector.kind, input);
			expect(parts.map(hex), `${vector.id}: registered hash parts`).toEqual(vector.partsHex);
			const frozenParts = vector.partsHex.map(bytesFromHex);
			expect(hex(hashDomain(vector.domain, ...frozenParts)), `${vector.id}: TypeScript digest`).toBe(vector.digestHex);
			expect(hex(await referenceHash.hashDomain(vector.domain, ...frozenParts)), `${vector.id}: reference digest`).toBe(
				vector.digestHex
			);
		}
	});

	it("keeps every vector from an earlier registry version byte-identical and present", () => {
		expect(existsSync(goldenVectorDirectory), `missing golden-vector directory: ${goldenVectorDirectory}`).toBe(true);
		const versions = versionedVectorPaths();
		expect(versions.some(({ version }) => version === registry.registryVersion)).toBe(true);
		const current = readJson<GoldenVectorDocument>(currentVectorsPath);
		const currentById = new Map(current.vectors.map((vector) => [vector.id, vector] as const));

		for (const prior of versions.filter(({ version }) => version < registry.registryVersion)) {
			const priorDocument = readJson<GoldenVectorDocument>(prior.path);
			expect(priorDocument.registryVersion, prior.path).toBe(prior.version);
			for (const vector of priorDocument.vectors) {
				expect(currentById.get(vector.id), `${vector.id}: deleted or mutated after registry v${prior.version}`).toEqual(
					vector
				);
			}
		}
	});

	it("pins a complete SHA-256 manifest for every reference source file", () => {
		expect(existsSync(referenceLockPath), `missing reference lock artifact: ${referenceLockPath}`).toBe(true);

		const lock = readJson<ReferenceLock>(referenceLockPath);
		expect(lock.algorithm).toBe("sha256");
		const expectedFiles = regularFiles(referenceDirectory)
			.map((path) => relative(referenceDirectory, path).replaceAll("\\", "/"))
			.sort();
		expect(Object.keys(lock.files).sort()).toEqual(expectedFiles);
		for (const relativePath of expectedFiles) {
			const sourcePath = join(referenceDirectory, relativePath);
			expect(statSync(sourcePath).isFile(), relativePath).toBe(true);
			expect(lock.files[relativePath], relativePath).toBe(
				createHash("sha256").update(readFileSync(sourcePath)).digest("hex")
			);
		}
	});

	it("preserves the original reference as an exact bijection to the thirteen vendored SHA256SUMS source entries", () => {
		const expectedSums = originalReferenceSourceSums();
		const actualFiles = regularFiles(referenceDirectory)
			.map((path) => relative(referenceDirectory, path).replaceAll("\\", "/"))
			.sort();
		expect(Object.keys(expectedSums).sort()).toEqual(actualFiles);
		expect(Object.keys(expectedSums)).toHaveLength(13);
		for (const relativePath of actualFiles) {
			expect(
				createHash("sha256")
					.update(readFileSync(join(referenceDirectory, relativePath)))
					.digest("hex")
			).toBe(expectedSums[relativePath]);
		}
	});

	it("pins a self-governing freeze policy and the exact pure-Node checker bytes", () => {
		expect(existsSync(freezePolicyPath), `missing base-pinned freeze policy: ${freezePolicyPath}`).toBe(true);
		expect(existsSync(freezeCheckerPath), `missing pure-Node freeze checker: ${freezeCheckerPath}`).toBe(true);
		const configured = readJson<FreezePolicy>(freezePolicyPath);
		expect(configured.version).toBe(1);
		expect(configured.protectedPaths).toEqual(expect.arrayContaining([...requiredProtectedPaths]));
		expect(configured.protectedPaths).not.toContain("CODEOWNERS");
		expect(configured.protectedPaths).not.toContain(".github/workflows/protocol-v2-registry.yml");
		expect(configured.regenReferencePath).toBe("packages/protocol-v2/conformance/ahe-reference-regen/**");
		expect(configured.regenLockPath).toBe("packages/protocol-v2/conformance/reference-regen.lock.json");
		expect(configured.sourceChecksumsPath).toBe("docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt");
		expect(configured.checker).toEqual({
			path: "packages/protocol-v2/scripts/check-protocol-freeze.mjs",
			sha256: createHash("sha256").update(readFileSync(freezeCheckerPath)).digest("hex"),
		});
	});

	it("routes every consensus-freeze artifact to the same explicit protocol-owner group", () => {
		expect(existsSync(fileURLToPath(new URL("../../../.github/CODEOWNERS", import.meta.url)))).toBe(false);
		expect(existsSync(fileURLToPath(new URL("../../../docs/CODEOWNERS", import.meta.url)))).toBe(false);
		const entries = codeownersEntries(readFileSync(codeownersPath, "utf8"));
		const ownerGroups = requiredCodeownersPatterns.map((pattern) => {
			const owners = entries.get(pattern);
			expect(owners, `missing explicit CODEOWNERS rule for ${pattern}`).toBeDefined();
			expect(
				owners?.every((owner) => owner.startsWith("@")),
				`${pattern}: owners must be GitHub handles`
			).toBe(true);
			return owners as string[];
		});

		for (const owners of ownerGroups.slice(1)) expect(owners).toEqual(ownerGroups[0]);
	});

	it("rejects immutable-reference, vector-history, policy, and closed-registry drift from base snapshots", async () => {
		const evaluate = await freezeEvaluator();
		const base = snapshot();
		const expectReject = (current: FreezeSnapshot): void => expect(() => evaluate({ base, current })).toThrow();

		// No version bump may ever authorize a modification, deletion, or rename of the original reference or lock.
		expectReject(
			snapshot({
				files: { ...base.files, "packages/protocol-v2/conformance/ahe-reference/src/canonical.js": "mutated" },
				registryVersion: 6,
			})
		);
		expectReject(
			snapshot({
				files: {
					"packages/protocol-v2/conformance/ahe-reference/src/renamed.js": "canonical-vendor-sha",
					"packages/protocol-v2/registry/field-registry.json": "registry-v5-sha",
				},
				registryVersion: 6,
			})
		);

		// Bootstrap may add only vectors, the original lock, and the policy. Registry and vendor bytes predate it.
		const bootstrapBase = snapshot({
			files: {
				"packages/protocol-v2/conformance/ahe-reference/src/canonical.js": "canonical-vendor-sha",
				"packages/protocol-v2/registry/field-registry.json": "registry-v5-sha",
			},
			policy: undefined,
			vectorBytes: {},
			vectorDocuments: {},
		});
		expect(() =>
			evaluate({
				base: bootstrapBase,
				current: snapshot(),
			})
		).not.toThrow();
		expect(() =>
			evaluate({
				base: bootstrapBase,
				current: snapshot({
					files: {
						...snapshot().files,
						"packages/protocol-v2/registry/field-registry.json": "mutated-registry-v5-sha",
					},
				}),
			})
		).toThrow(/registry/);
		expectReject(snapshot({ policy: undefined }));
		expectReject(
			snapshot({
				files: {
					...base.files,
					"packages/protocol-v2/registry/field-registry.json": "same-version-registry-drift",
				},
			})
		);

		// Later vectors are append-only, exact +1, and byte-identical supersets.
		expect(() =>
			evaluate({
				base,
				current: snapshot({
					registryVersion: 6,
					vectorBytes: { ...base.vectorBytes, "registry-v6.json": "new" },
					vectorDocuments: {
						...base.vectorDocuments,
						"registry-v6.json": {
							records: { ...base.vectorDocuments["registry-v5.json"]?.records, added: "record-v6" },
							registryVersion: 6,
						},
					},
				}),
			})
		).not.toThrow();
		expectReject(snapshot({ registryVersion: 7, vectorBytes: { ...base.vectorBytes, "registry-v7.json": "new" } }));
		expectReject(snapshot({ registryVersion: 6, vectorBytes: { "registry-v6.json": "new" } }));
		expectReject(snapshot({ vectorBytes: { "registry-v5.json": "mutated" } }));
		expectReject(snapshot({ vectorBytes: { ...base.vectorBytes, "notes.md": "untracked-policy-hole" } }));
		expectReject(
			snapshot({
				registryVersion: 6,
				vectorBytes: { ...base.vectorBytes, "registry-v6.json": "new" },
				vectorDocuments: {
					...base.vectorDocuments,
					"registry-v6.json": { records: { baseline: "mutated-record" }, registryVersion: 6 },
				},
			})
		);
		expectReject(
			snapshot({
				files: {
					...base.files,
					"packages/protocol-v2/registry/unregistered-schema.json": "rider",
				},
				registryVersion: 6,
				vectorBytes: { ...base.vectorBytes, "registry-v6.json": "new" },
				vectorDocuments: {
					...base.vectorDocuments,
					"registry-v6.json": {
						records: { ...base.vectorDocuments["registry-v5.json"]?.records, added: "record-v6" },
						registryVersion: 6,
					},
				},
			})
		);

		// The policy may only add protections and must keep its base-pinned checker digest/path unchanged.
		expectReject(snapshot({ policy: policy({ protectedPaths: ["packages/protocol-v2/registry/**"] }) }));
		expectReject(snapshot({ policy: policy({ checker: { path: "different.mjs", sha256: "b".repeat(64) } }) }));
		expect(() =>
			evaluate({
				base,
				current: snapshot({
					policy: policy({ protectedPaths: [...(base.policy?.protectedPaths ?? []), "new-protection/**"] }),
				}),
			})
		).not.toThrow();

		// −1f adds the regenerated tree and its distinct lock together without changing registryVersion.
		const regenerated = snapshot({
			files: {
				...base.files,
				"packages/protocol-v2/conformance/ahe-reference-regen/src/canonical.js": "regenerated-source-sha",
				"packages/protocol-v2/conformance/reference-regen.lock.json": "regenerated-lock-sha",
			},
		});
		expect(() => evaluate({ base, current: regenerated })).not.toThrow();
		expectReject(
			snapshot({
				files: { ...base.files, "packages/protocol-v2/conformance/ahe-reference-regen/src/canonical.js": "only-tree" },
			})
		);

		// Once the regeneration pair is at the merge base, the registry window is closed forever.
		expect(() =>
			evaluate({
				base: regenerated,
				current: {
					...regenerated,
					registryVersion: 6,
					vectorBytes: { ...regenerated.vectorBytes, "registry-v6.json": "new" },
					vectorDocuments: {
						...regenerated.vectorDocuments,
						"registry-v6.json": {
							records: {
								...regenerated.vectorDocuments["registry-v5.json"]?.records,
								added: "record-v6",
							},
							registryVersion: 6,
						},
					},
				},
			})
		).toThrow(/registry is closed/);
	});

	it("runs the base-governed freeze checker on every pull request with Node alone", () => {
		const workflow = readFileSync(workflowPath, "utf8");
		expect(workflow).toContain("pull_request");
		expect(workflow).toContain("types: [opened, synchronize, reopened, edited, ready_for_review]");
		expect(workflow).not.toMatch(/^\s*paths:/mu);
		expect(workflow).not.toContain("pull_request_target");
		expect(workflow).toContain("permissions:");
		expect(workflow).toContain("contents: read");
		expect(workflow).toContain("timeout-minutes:");
		expect(workflow).toContain("ref: ${{ github.sha }}");
		expect(workflow).toContain("registry-version:");
		expect(workflow).toContain("name: Require protocol-v2 registryVersion bump");
		expect(workflow).toContain('git cat-file -e "$BASE_SHA:$REGISTRY"');
		expect(workflow).toContain('git cat-file -e "$BASE_SHA:$ORIGINAL_REFERENCE"');
		expect(workflow).toContain('git cat-file -e "$BASE_SHA:$POLICY"');
		expect(workflow).toContain("exit 1");
		expect(workflow).toContain("node packages/protocol-v2/scripts/check-protocol-freeze.mjs");
		expect(workflow).not.toContain("pnpm install");
		expect(workflow).not.toContain("pnpm --filter");
	});
});
