import { ed25519 } from "@noble/curves/ed25519.js";
import type { CanonicalLimits } from "@ts-drp/canonical";
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import contract from "./fixtures/phase-0g2t/registered-byte-contract.json" with { type: "json" };
import { verifyRegisteredSignature as verifyV2RegisteredSignature } from "../packages/protocol-v2/src/index.js";
import registryJson from "../packages/protocol-v3/registry/registry-v1.json" with { type: "json" };

type CanonicalModule = Record<string, unknown> & {
	encodeCanonical(value: unknown, limits?: Partial<CanonicalLimits>): Uint8Array;
};

const canonicalInstrumentation = vi.hoisted(() => ({ encodeCalls: 0 }));

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const actual = await importOriginal<CanonicalModule>();
	return {
		...actual,
		encodeCanonical(value: unknown, limits?: Partial<CanonicalLimits>): Uint8Array {
			canonicalInstrumentation.encodeCalls++;
			return actual.encodeCanonical(value, limits);
		},
	};
});

const { encodeCanonical } = await import("@ts-drp/canonical");

interface RegisteredVertexVerification {
	accepted: boolean;
	digest?: Uint8Array;
}

interface VerifyReceivedVertexInput {
	domain: string;
	expectedAnchor: string;
	receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): { bytes: Uint8Array; format: "raw" } | undefined;
	signature: Uint8Array;
	suiteId: string;
}

interface ProtocolV3Surface {
	digestReceivedVertexPreimage?(receivedCanonicalPreimageBytes: Uint8Array): Uint8Array;
	verifyReceivedVertex?(input: VerifyReceivedVertexInput): RegisteredVertexVerification;
	vertexCanonicalBytes?(input: Readonly<Record<string, unknown>>): Uint8Array;
	vertexDigest?(input: Readonly<Record<string, unknown>>): Uint8Array;
	vertexPreimage?(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

interface MalformedAuthorSequence {
	id: string;
	representation: "decimal-number" | "literal" | "missing" | "nan" | "positive-infinity";
	value?: number | string;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_PATH =
	process.env.PHASE_0G2T_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, "fixtures/phase-0g2t", contract.implementationModule)
		: resolve(CURRENT_DIRECTORY, "..", process.env.PHASE_0G2T_IMPLEMENTATION_MODULE);
const IMPLEMENTATION_URL = pathToFileURL(IMPLEMENTATION_PATH).href;
const V3_SOURCE_DIRECTORY =
	process.env.PHASE_0G2T_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, "../packages/protocol-v3/src")
		: dirname(IMPLEMENTATION_PATH);
const PKCS8_ED25519_SEED_PREFIX = fromHex("302e020100300506032b657004220420");
const SPKI_ED25519_PUBLIC_KEY_PREFIX_BYTES = 12;
const U32_MAX = 0xffff_ffff;

const surfaceLoad = import(IMPLEMENTATION_URL)
	.then((loaded: unknown) => ({ loaded: loaded as ProtocolV3Surface }))
	.catch((error: unknown) => ({ error }));

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsignedBigEndian(value: number | bigint, bytes: 4 | 8): Uint8Array {
	const maximum = bytes === 4 ? BigInt(U32_MAX) : (BigInt(1) << BigInt(64)) - BigInt(1);
	const integer = typeof value === "bigint" ? value : BigInt(value);
	if (integer < BigInt(0) || integer > maximum) throw new RangeError(`value does not fit U${bytes * 8}BE`);
	const output = new Uint8Array(bytes);
	const view = new DataView(output.buffer);
	if (bytes === 4) view.setUint32(0, Number(integer), false);
	else view.setBigUint64(0, integer, false);
	return output;
}

function independentHashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	const framed = [
		fromHex("44525000"),
		unsignedBigEndian(domainBytes.byteLength, 4),
		domainBytes,
		...parts.flatMap((part) => [unsignedBigEndian(part.byteLength, 8), part]),
	];
	return new Uint8Array(createHash("sha256").update(concatBytes(framed)).digest());
}

function keyMaterial(): {
	privateKey: ReturnType<typeof createPrivateKey>;
	publicKey: Uint8Array;
} {
	const seed = fromHex(contract.privateKeySeedHex);
	const privateKey = createPrivateKey({
		key: concatBytes([PKCS8_ED25519_SEED_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const spki = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
	return {
		privateKey,
		publicKey: spki.slice(SPKI_ED25519_PUBLIC_KEY_PREFIX_BYTES),
	};
}

function normalizeFixtureVertex(
	input: Readonly<Record<string, unknown>> = contract.vertex
): Readonly<Record<string, unknown>> {
	const fields = registryJson.kinds.vertex.fields;
	const output: Record<string, unknown> = {};
	for (const field of fields) {
		if (Object.hasOwn(input, field.name)) output[field.name] = input[field.name];
		else if (field.const !== null) output[field.name] = field.const;
	}
	const dependencies = output.dependencies;
	if (Array.isArray(dependencies)) {
		output.dependencies = [...dependencies].sort((left, right) => {
			if (typeof left !== "string" || typeof right !== "string") return 0;
			return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
		});
	}
	return output;
}

function materializeMalformed(input: MalformedAuthorSequence): Readonly<Record<string, unknown>> {
	const vertex: Record<string, unknown> = { ...contract.vertex };
	switch (input.representation) {
		case "missing":
			delete vertex.authorSequence;
			break;
		case "literal":
			vertex.authorSequence = input.value;
			break;
		case "decimal-number":
			vertex.authorSequence = Number(input.value);
			break;
		case "nan":
			vertex.authorSequence = Number.NaN;
			break;
		case "positive-infinity":
			vertex.authorSequence = Number.POSITIVE_INFINITY;
			break;
	}
	return vertex;
}

async function requireSurfaceFunction<Key extends keyof ProtocolV3Surface>(
	name: Key
): Promise<NonNullable<ProtocolV3Surface[Key]>> {
	const result = await surfaceLoad;
	if ("error" in result) {
		throw new Error(`PHASE_0G2T_IMPLEMENTATION_MODULE_UNAVAILABLE:${String(name)}`, { cause: result.error });
	}
	const candidate = result.loaded[name];
	if (typeof candidate !== "function") throw new Error(`PHASE_0G2T_MISSING_EXPORT:${String(name)}`);
	return candidate as NonNullable<ProtocolV3Surface[Key]>;
}

function sourceFiles(directory: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = resolve(directory, entry);
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
		else if (path.endsWith(".ts")) files.push(path);
	}
	return files;
}

describe("Phase 0g(ii-T) v3 registered-byte RED", () => {
	it("keeps the fixture input-only and independently authenticates its key and framing controls", () => {
		expect(Object.keys(contract)).toEqual([
			"implementationModule",
			"registryPath",
			"domains",
			"suites",
			"privateKeySeedHex",
			"vertex",
			"changedAuthorSequence",
			"wrongExpectedAnchor",
			"malformedExpectedAnchor",
			"validAuthorSequenceBoundaries",
			"malformedAuthorSequences",
		]);
		expect(contract).not.toHaveProperty("expected");
		expect(contract).not.toHaveProperty("canonicalHex");
		expect(contract).not.toHaveProperty("digestHex");
		expect(contract).not.toHaveProperty("signatureHex");

		const bytes = encodeCanonical(normalizeFixtureVertex());
		const digest = independentHashDomain(contract.domains.v3, bytes);
		const { privateKey, publicKey } = keyMaterial();
		const signature = new Uint8Array(nodeSign(null, digest, privateKey));

		expect(bytes.byteLength).toBeGreaterThan(0);
		expect(digest).toHaveLength(32);
		expect(publicKey).toHaveLength(32);
		expect(signature).toHaveLength(64);
		expect(
			verifyV2RegisteredSignature({
				expectedScope: { anchor: contract.vertex.anchor, domain: contract.domains.v2 },
				publicKey: { bytes: publicKey, format: "raw" },
				registeredDigest: {
					anchor: contract.vertex.anchor,
					bytes: digest,
					domain: contract.domains.v3,
				},
				signature,
				suiteId: contract.suites.v2,
			})
		).toBe(false);
	});

	it("derives the exact ten-field vertex preimage and review position from registry v1", async () => {
		const vertexPreimage = await requireSurfaceFunction("vertexPreimage");
		const reviewOrder = registryJson.kinds.vertex.fields.map(({ name }) => name);
		const preimage = vertexPreimage(contract.vertex);

		expect(reviewOrder).toEqual([
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
		]);
		expect(reviewOrder.indexOf("authorSequence")).toBe(reviewOrder.indexOf("author") + 1);
		expect(Object.keys(preimage)).toEqual(reviewOrder);
		expect(preimage).toEqual(normalizeFixtureVertex());
	});

	it("makes a sequence-only change alter exact canonical bytes and the registered digest", async () => {
		const vertexCanonicalBytes = await requireSurfaceFunction("vertexCanonicalBytes");
		const vertexDigest = await requireSurfaceFunction("vertexDigest");
		const changed = { ...contract.vertex, authorSequence: contract.changedAuthorSequence };
		const expectedBaseBytes = encodeCanonical(normalizeFixtureVertex(contract.vertex));
		const expectedChangedBytes = encodeCanonical(normalizeFixtureVertex(changed));
		const expectedBaseDigest = independentHashDomain(contract.domains.v3, expectedBaseBytes);
		const expectedChangedDigest = independentHashDomain(contract.domains.v3, expectedChangedBytes);

		const baseBytes = vertexCanonicalBytes(contract.vertex);
		const changedBytes = vertexCanonicalBytes(changed);
		const baseDigest = vertexDigest(contract.vertex);
		const changedDigest = vertexDigest(changed);

		expect(baseBytes).toEqual(expectedBaseBytes);
		expect(changedBytes).toEqual(expectedChangedBytes);
		expect(changedBytes).not.toEqual(baseBytes);
		expect(baseDigest).toEqual(expectedBaseDigest);
		expect(changedDigest).toEqual(expectedChangedDigest);
		expect(changedDigest).not.toEqual(baseDigest);
	});

	it("accepts both inclusive registry sequence boundaries with authenticated exact bytes", async () => {
		const vertexCanonicalBytes = await requireSurfaceFunction("vertexCanonicalBytes");
		const vertexDigest = await requireSurfaceFunction("vertexDigest");
		const vertexPreimage = await requireSurfaceFunction("vertexPreimage");
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const { privateKey, publicKey } = keyMaterial();

		for (const authorSequence of contract.validAuthorSequenceBoundaries) {
			const vertex = { ...contract.vertex, authorSequence };
			const expectedPreimage = normalizeFixtureVertex(vertex);
			const expectedBytes = encodeCanonical(expectedPreimage);
			const expectedDigest = independentHashDomain(contract.domains.v3, expectedBytes);
			const signature = new Uint8Array(nodeSign(null, expectedDigest, privateKey));
			const resolveAuthorPublicKey = vi.fn((author: string) =>
				author === contract.vertex.author ? { bytes: publicKey, format: "raw" as const } : undefined
			);

			expect(vertexPreimage(vertex), `preimage at ${authorSequence}`).toEqual(expectedPreimage);
			expect(vertexCanonicalBytes(vertex), `bytes at ${authorSequence}`).toEqual(expectedBytes);
			expect(vertexDigest(vertex), `digest at ${authorSequence}`).toEqual(expectedDigest);
			expect(
				verifyReceivedVertex({
					domain: contract.domains.v3,
					expectedAnchor: contract.vertex.anchor,
					receivedCanonicalPreimageBytes: expectedBytes,
					resolveAuthorPublicKey,
					signature,
					suiteId: contract.suites.v3,
				}),
				`verification at ${authorSequence}`
			).toMatchObject({ accepted: true, digest: expectedDigest });
			expect(resolveAuthorPublicKey).toHaveBeenCalledOnce();
			expect(resolveAuthorPublicKey).toHaveBeenCalledWith(contract.vertex.author);
		}
	});

	it("authenticates authorSequence under the active v3 Ed25519 suite", async () => {
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const baseBytes = encodeCanonical(normalizeFixtureVertex(contract.vertex));
		const changed = { ...contract.vertex, authorSequence: contract.changedAuthorSequence };
		const changedBytes = encodeCanonical(normalizeFixtureVertex(changed));
		const baseDigest = independentHashDomain(contract.domains.v3, baseBytes);
		const changedDigest = independentHashDomain(contract.domains.v3, changedBytes);
		const { privateKey, publicKey } = keyMaterial();
		const baseSignature = new Uint8Array(nodeSign(null, baseDigest, privateKey));
		const changedSignature = new Uint8Array(nodeSign(null, changedDigest, privateKey));
		const resolveAuthorPublicKey = vi.fn((author: string) =>
			author === contract.vertex.author ? { bytes: publicKey, format: "raw" as const } : undefined
		);
		const common = {
			domain: contract.domains.v3,
			expectedAnchor: contract.vertex.anchor,
			resolveAuthorPublicKey,
			suiteId: contract.suites.v3,
		};

		expect(
			verifyReceivedVertex({
				...common,
				receivedCanonicalPreimageBytes: baseBytes,
				signature: baseSignature,
			})
		).toMatchObject({ accepted: true, digest: baseDigest });
		expect(
			verifyReceivedVertex({
				...common,
				receivedCanonicalPreimageBytes: changedBytes,
				signature: baseSignature,
			})
		).toMatchObject({ accepted: false });
		expect(
			verifyReceivedVertex({
				...common,
				receivedCanonicalPreimageBytes: changedBytes,
				signature: changedSignature,
			})
		).toMatchObject({ accepted: true, digest: changedDigest });
		expect(resolveAuthorPublicKey).toHaveBeenCalledTimes(3);
		expect(resolveAuthorPublicKey).toHaveBeenNthCalledWith(1, contract.vertex.author);
	});

	it("rejects the ZIP-215 identity-key/signature case under strict Ed25519 verification", async () => {
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const receivedCanonicalPreimageBytes = encodeCanonical(normalizeFixtureVertex());
		const digest = independentHashDomain(contract.domains.v3, receivedCanonicalPreimageBytes);
		const identityPublicKey = new Uint8Array(32);
		const identitySignature = new Uint8Array(64);
		identityPublicKey[0] = 1;
		identitySignature[0] = 1;
		const resolveAuthorPublicKey = vi.fn(() => ({ bytes: identityPublicKey, format: "raw" as const }));

		expect(ed25519.verify(identitySignature, digest, identityPublicKey, { zip215: true })).toBe(true);
		expect(ed25519.verify(identitySignature, digest, identityPublicKey, { zip215: false })).toBe(false);
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: identitySignature,
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(resolveAuthorPublicKey).toHaveBeenCalledOnce();
		expect(resolveAuthorPublicKey).toHaveBeenCalledWith(contract.vertex.author);
	});

	it("rejects malformed sequence values and noncanonical bytes before key resolution", async () => {
		const vertexPreimage = await requireSurfaceFunction("vertexPreimage");
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const { privateKey, publicKey } = keyMaterial();
		const resolveAuthorPublicKey = vi.fn(() => ({ bytes: publicKey, format: "raw" as const }));
		const encodableMalformed: Readonly<Record<string, unknown>>[] = [];

		for (const malformedCase of contract.malformedAuthorSequences as readonly MalformedAuthorSequence[]) {
			const malformed = materializeMalformed(malformedCase);
			expect(() => vertexPreimage(malformed), malformedCase.id).toThrow(/authorSequence|safe integer|required/i);
			if (malformedCase.representation === "missing" || malformedCase.representation === "literal") {
				encodableMalformed.push(malformed);
			}
		}

		for (const malformed of encodableMalformed) {
			const receivedCanonicalPreimageBytes = encodeCanonical(malformed);
			const digest = independentHashDomain(contract.domains.v3, receivedCanonicalPreimageBytes);
			const result = verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, digest, privateKey)),
				suiteId: contract.suites.v3,
			});
			expect(result).toMatchObject({ accepted: false });
		}

		const canonicalBytes = encodeCanonical(normalizeFixtureVertex());
		const noncanonicalTrailingBytes = concatBytes([canonicalBytes, Uint8Array.of(0)]);
		const trailingDigest = independentHashDomain(contract.domains.v3, noncanonicalTrailingBytes);
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes: noncanonicalTrailingBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, trailingDigest, privateKey)),
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(resolveAuthorPublicKey).not.toHaveBeenCalled();
	});

	it("rejects the bounded registered-field matrix before key resolution", async () => {
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const validPreimage = normalizeFixtureVertex();
		const firstDependency = contract.vertex.dependencies[0];
		const malformedReceived: readonly [string, Readonly<Record<string, unknown>>][] = [
			["protocolMajor", { ...validPreimage, protocolMajor: 2 }],
			["objectId-empty", { ...validPreimage, objectId: "" }],
			["epoch-negative", { ...validPreimage, epoch: -1 }],
			["anchor-uppercase", { ...validPreimage, anchor: contract.vertex.anchor.toUpperCase() }],
			["author-empty", { ...validPreimage, author: "" }],
			["authorSequence-negative", { ...validPreimage, authorSequence: -1 }],
			["logicalTime-zero", { ...validPreimage, logicalTime: 0 }],
			["dependencies-empty", { ...validPreimage, dependencies: [] }],
			["dependencies-duplicate", { ...validPreimage, dependencies: [firstDependency, firstDependency] }],
			["dependencies-out-of-order", { ...validPreimage, dependencies: [...contract.vertex.dependencies] }],
			["dependencies-uppercase-digest", { ...validPreimage, dependencies: [firstDependency.toUpperCase()] }],
			["operation-array", { ...validPreimage, operation: [] }],
			["unknown-eleventh-field", { ...validPreimage, extra: true }],
		];
		const { privateKey, publicKey } = keyMaterial();

		for (const [label, malformed] of malformedReceived) {
			const receivedCanonicalPreimageBytes = encodeCanonical(malformed);
			const digest = independentHashDomain(contract.domains.v3, receivedCanonicalPreimageBytes);
			const resolveAuthorPublicKey = vi.fn(() => ({ bytes: publicKey, format: "raw" as const }));
			const result = verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, digest, privateKey)),
				suiteId: contract.suites.v3,
			});

			expect(result, label).toMatchObject({ accepted: false });
			expect(resolveAuthorPublicKey, `${label} reached the resolver`).not.toHaveBeenCalled();
		}
	});

	it("rejects malformed expected-anchor width and protocolMajor 2 under v3 labels before key resolution", async () => {
		const vertexPreimage = await requireSurfaceFunction("vertexPreimage");
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const protocolMajorTwo = { ...contract.vertex, protocolMajor: 2 };
		const protocolMajorTwoBytes = encodeCanonical(normalizeFixtureVertex(protocolMajorTwo));
		const validBytes = encodeCanonical(normalizeFixtureVertex());
		const protocolMajorTwoDigest = independentHashDomain(contract.domains.v3, protocolMajorTwoBytes);
		const validDigest = independentHashDomain(contract.domains.v3, validBytes);
		const { privateKey, publicKey } = keyMaterial();
		const resolveAuthorPublicKey = vi.fn(() => ({ bytes: publicKey, format: "raw" as const }));

		expect(contract.malformedExpectedAnchor).toMatch(/^[0-9a-f]{62}$/u);
		expect(() => vertexPreimage(protocolMajorTwo)).toThrow(/protocolMajor.*(?:3|constant)/i);
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes: protocolMajorTwoBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, protocolMajorTwoDigest, privateKey)),
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.malformedExpectedAnchor,
				receivedCanonicalPreimageBytes: validBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, validDigest, privateKey)),
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(resolveAuthorPublicKey).not.toHaveBeenCalled();
	});

	it("rejects a well-formed wrong expected anchor before key resolution", async () => {
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const validBytes = encodeCanonical(normalizeFixtureVertex());
		const validDigest = independentHashDomain(contract.domains.v3, validBytes);
		const { privateKey, publicKey } = keyMaterial();
		const resolveAuthorPublicKey = vi.fn(() => ({ bytes: publicKey, format: "raw" as const }));

		expect(contract.wrongExpectedAnchor).toMatch(/^[0-9a-f]{64}$/u);
		expect(contract.wrongExpectedAnchor).not.toBe(contract.vertex.anchor);
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.wrongExpectedAnchor,
				receivedCanonicalPreimageBytes: validBytes,
				resolveAuthorPublicKey,
				signature: new Uint8Array(nodeSign(null, validDigest, privateKey)),
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(resolveAuthorPublicKey).not.toHaveBeenCalled();
	});

	it("rejects v2 domain and suite substitution while frozen v2 rejects v3 substitution", async () => {
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const bytes = encodeCanonical(normalizeFixtureVertex());
		const v3Digest = independentHashDomain(contract.domains.v3, bytes);
		const v2Digest = independentHashDomain(contract.domains.v2, bytes);
		const { privateKey, publicKey } = keyMaterial();
		const v3Signature = new Uint8Array(nodeSign(null, v3Digest, privateKey));
		const v2Signature = new Uint8Array(nodeSign(null, v2Digest, privateKey));
		const resolveAuthorPublicKey = vi.fn(() => ({ bytes: publicKey, format: "raw" as const }));

		expect(
			verifyReceivedVertex({
				domain: contract.domains.v2,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes: bytes,
				resolveAuthorPublicKey,
				signature: v2Signature,
				suiteId: contract.suites.v3,
			})
		).toMatchObject({ accepted: false });
		expect(
			verifyReceivedVertex({
				domain: contract.domains.v3,
				expectedAnchor: contract.vertex.anchor,
				receivedCanonicalPreimageBytes: bytes,
				resolveAuthorPublicKey,
				signature: v3Signature,
				suiteId: contract.suites.v2,
			})
		).toMatchObject({ accepted: false });
		expect(resolveAuthorPublicKey).not.toHaveBeenCalled();

		expect(
			verifyV2RegisteredSignature({
				expectedScope: { anchor: contract.vertex.anchor, domain: contract.domains.v2 },
				publicKey: { bytes: publicKey, format: "raw" },
				registeredDigest: {
					anchor: contract.vertex.anchor,
					bytes: v3Digest,
					domain: contract.domains.v3,
				},
				signature: v3Signature,
				suiteId: contract.suites.v2,
			})
		).toBe(false);
		expect(
			verifyV2RegisteredSignature({
				expectedScope: { anchor: contract.vertex.anchor, domain: contract.domains.v2 },
				publicKey: { bytes: publicKey, format: "raw" },
				registeredDigest: {
					anchor: contract.vertex.anchor,
					bytes: v2Digest,
					domain: contract.domains.v2,
				},
				signature: v2Signature,
				suiteId: contract.suites.v3 as never,
			})
		).toBe(false);
	});

	it("hashes exact received bytes and performs no decode-to-encode verification round trip", async () => {
		const digestReceivedVertexPreimage = await requireSurfaceFunction("digestReceivedVertexPreimage");
		const verifyReceivedVertex = await requireSurfaceFunction("verifyReceivedVertex");
		const bytes = encodeCanonical(normalizeFixtureVertex());
		const expectedDigest = independentHashDomain(contract.domains.v3, bytes);
		const wrongSurrogateDigest = independentHashDomain(contract.domains.v3, concatBytes([bytes, Uint8Array.of(0)]));
		const { privateKey, publicKey } = keyMaterial();
		const signature = new Uint8Array(nodeSign(null, expectedDigest, privateKey));

		expect(digestReceivedVertexPreimage(bytes)).toEqual(expectedDigest);
		expect(digestReceivedVertexPreimage(bytes)).not.toEqual(wrongSurrogateDigest);

		canonicalInstrumentation.encodeCalls = 0;
		const result = verifyReceivedVertex({
			domain: contract.domains.v3,
			expectedAnchor: contract.vertex.anchor,
			receivedCanonicalPreimageBytes: bytes,
			resolveAuthorPublicKey: () => ({ bytes: publicKey, format: "raw" }),
			signature,
			suiteId: contract.suites.v3,
		});

		expect(result).toMatchObject({ accepted: true, digest: expectedDigest });
		expect(canonicalInstrumentation.encodeCalls).toBe(0);
	});

	it("keeps the future TypeScript port behind the reference and predecessor source firewall", async () => {
		const result = await surfaceLoad;
		if ("error" in result) {
			expect(result.error).toBeDefined();
			return;
		}

		const sources = sourceFiles(V3_SOURCE_DIRECTORY);
		expect(sources.length).toBeGreaterThan(0);
		const joined = sources.map((path) => readFileSync(path, "utf8")).join("\n");
		expect(joined).toContain("@ts-drp/canonical");
		expect(joined).not.toMatch(
			/(?:from\s+|import\s*\()["'][^"']*(?:conformance|vectors|reference\.mjs|protocol-v2\/src)/u
		);
		expect(joined).not.toMatch(/(?:function|const|let|var)\s+encodeCanonical\b/u);
	});
});
