import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-4c-v3/snapshot-stream-contract.json" with { type: "json" };
import type {
	DomainHashStreamModule,
	SnapshotChunkDescriptor,
	SnapshotChunkSource,
	SnapshotQuarantinePort,
	SnapshotStreamFailureCode,
	SnapshotStreamModule,
	SnapshotTransferCodecModule,
	SnapshotTransferProfile,
	VerifiedSnapshotStream,
} from "./fixtures/phase-4c-v3/snapshot-stream-types.js";
import {
	EXPECTED_CANONICAL_EXPORTS,
	EXPECTED_PROTOCOL_EXPORTS,
	EXPECTED_STREAM_EXPORTS,
	typeContractSource,
} from "./fixtures/phase-4c-v3/snapshot-stream-types.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

interface RegistryField {
	readonly constraints?: Readonly<Record<string, unknown>>;
	readonly const: unknown;
	readonly name: string;
	readonly required: boolean;
	readonly sortRule: string | null;
	readonly type: string;
}

interface RegistryKind {
	readonly domain: string;
	readonly encoding: string;
	readonly fields: readonly RegistryField[];
}

interface Registry {
	readonly kinds: Readonly<Record<string, RegistryKind>>;
}

interface RegistryVector {
	readonly canonicalHex: string;
	readonly digestHex: string;
	readonly domain: string;
	readonly id: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly partsHex?: readonly string[];
}

interface VectorFile {
	readonly vectors: readonly RegistryVector[];
}

interface SnapshotFixture {
	readonly chunks: readonly Uint8Array[];
	readonly descriptors: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const VECTOR_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/vectors/registry-v1.json");
const CANONICAL_OWNER = resolve(REPOSITORY_ROOT, "packages/canonical/src/domain-hash-stream.ts");
const PROTOCOL_OWNER = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/snapshot-transfer.ts");
const STREAM_OWNER = resolve(REPOSITORY_ROOT, "packages/compaction/src/snapshot-stream.ts");
const MEMORY_CHILD = resolve(CURRENT_DIRECTORY, "fixtures/phase-4c-v3/snapshot-stream-memory-child.mjs");
const TYPE_CONTRACT = resolve(CURRENT_DIRECTORY, "fixtures/phase-4c-v3/snapshot-stream-types.ts");
const CANONICAL_MODULE_PATH: string = "../packages/canonical/src/domain-hash-stream.js";
const PROTOCOL_MODULE_PATH: string = "../packages/protocol-v3/src/snapshot-transfer.js";
const STREAM_MODULE_PATH: string = "../packages/compaction/src/snapshot-stream.js";
const PROFILE: SnapshotTransferProfile = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const ownerExists = existsSync(CANONICAL_OWNER) && existsSync(PROTOCOL_OWNER) && existsSync(STREAM_OWNER);

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function bytesFromHex(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

function digest(domain: string, ...parts: readonly Uint8Array[]): string {
	return hex(hashDomain(domain, ...parts));
}

function chunkDigest(index: number, bytes: Uint8Array): string {
	return digest(contract.domains.chunk, encodeCanonical(index), bytes);
}

function splitPayload(payload: Uint8Array, chunkBytes = PROFILE.snapshotChunkBytes): readonly Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
		chunks.push(new Uint8Array(payload.slice(offset, Math.min(payload.byteLength, offset + chunkBytes))));
	}
	return chunks;
}

function fixture(payload = new Uint8Array(300_001).map((_, index) => index % 251)): SnapshotFixture {
	const chunks = splitPayload(payload);
	const descriptors = chunks.map((bytes, index) =>
		Object.freeze({ byteLength: bytes.byteLength, digest: chunkDigest(index, bytes), index })
	);
	const payloadDigest = digest(contract.domains.payload, payload);
	const manifest = Object.freeze({
		...contract.metadata,
		chunks: descriptors,
		payloadDigest,
		totalBytes: payload.byteLength,
	});
	const exactCanonicalManifestBytes = encodeCanonical(manifest);
	return Object.freeze({
		chunks,
		descriptors,
		exactCanonicalManifestBytes,
		manifest,
		manifestDigest: digest(contract.domains.manifest, exactCanonicalManifestBytes),
		payloadDigest,
	});
}

function worstManifest(): Readonly<Record<string, unknown>> {
	const maximumDigest = "f".repeat(64);
	return Object.freeze({
		aclDigest: maximumDigest,
		anchor: maximumDigest,
		chunks: Array.from({ length: contract.profile.maxChunks }, (_, index) =>
			Object.freeze({ byteLength: contract.profile.snapshotChunkBytes, digest: maximumDigest, index })
		),
		encodingVersion: "drp-canonical-profile-1",
		epoch: Number.MAX_SAFE_INTEGER,
		kind: "drp-snapshot-manifest",
		objectId: "\uFFFF".repeat(1024),
		payloadDigest: maximumDigest,
		protocolMajor: 3,
		schemaVersion: Number.MAX_SAFE_INTEGER,
		stateDigest: maximumDigest,
		totalBytes: contract.profile.maxSnapshotBytes,
	});
}

function manifestVariant(
	selected: SnapshotFixture,
	overrides: Readonly<Record<string, unknown>>
): Readonly<{ readonly exactCanonicalManifestBytes: Uint8Array; readonly manifestDigest: string }> {
	const exactCanonicalManifestBytes = encodeCanonical({ ...selected.manifest, ...overrides });
	return Object.freeze({
		exactCanonicalManifestBytes,
		manifestDigest: digest(contract.domains.manifest, exactCanonicalManifestBytes),
	});
}

function manifestBytes(value: Readonly<Record<string, unknown>>): Readonly<{
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly manifestDigest: string;
}> {
	const exactCanonicalManifestBytes = encodeCanonical(value);
	return Object.freeze({
		exactCanonicalManifestBytes,
		manifestDigest: digest(contract.domains.manifest, exactCanonicalManifestBytes),
	});
}

function packageExports(path: string): Readonly<Record<string, unknown>> {
	return (
		(
			JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")) as {
				readonly exports?: Readonly<Record<string, unknown>>;
			}
		).exports ?? {}
	);
}

async function loadOwners(): Promise<{
	readonly canonical: DomainHashStreamModule;
	readonly protocol: SnapshotTransferCodecModule;
	readonly stream: SnapshotStreamModule;
}> {
	const [canonical, protocol, stream] = await Promise.all([
		import(CANONICAL_MODULE_PATH),
		import(PROTOCOL_MODULE_PATH),
		import(STREAM_MODULE_PATH),
	]);
	return {
		canonical: canonical as DomainHashStreamModule,
		protocol: protocol as SnapshotTransferCodecModule,
		stream: stream as SnapshotStreamModule,
	};
}

function assertTypeContract(): void {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4c-types-"));
	try {
		const source = resolve(directory, "contract.ts");
		const project = resolve(directory, "tsconfig.json");
		writeFileSync(
			source,
			typeContractSource({
				canonicalModule: CANONICAL_OWNER,
				expectedModule: TYPE_CONTRACT,
				protocolModule: PROTOCOL_OWNER,
				streamModule: STREAM_OWNER,
			})
		);
		writeFileSync(
			project,
			JSON.stringify({
				compilerOptions: {
					allowImportingTsExtensions: true,
					composite: false,
					declaration: false,
					declarationMap: false,
					noEmit: true,
				},
				extends: resolve(REPOSITORY_ROOT, "tsconfig.json"),
				files: [source],
			})
		);
		execFileSync("pnpm", ["exec", "tsc", "--project", project, "--pretty", "false"], {
			cwd: REPOSITORY_ROOT,
			stdio: "pipe",
		});
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

class MemoryQuarantine implements SnapshotQuarantinePort {
	readonly #chunks = new Map<number, Uint8Array>();
	readonly writes: number[] = [];
	discarded = false;

	seed(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): void {
		this.#chunks.set(descriptor.index, new Uint8Array(exactBytes));
	}

	discard(): Promise<void> {
		this.discarded = true;
		this.#chunks.clear();
		return Promise.resolve();
	}

	read(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined> {
		const selected = this.#chunks.get(descriptor.index);
		return Promise.resolve(selected === undefined ? undefined : new Uint8Array(selected));
	}

	write(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void> {
		this.writes.push(descriptor.index);
		this.#chunks.set(descriptor.index, new Uint8Array(exactBytes));
		return Promise.resolve();
	}
}

function sourceFor(
	selected: SnapshotFixture,
	overrides: ReadonlyMap<number, Uint8Array | undefined> = new Map()
): SnapshotChunkSource & { readonly reads: number[] } {
	const reads: number[] = [];
	return Object.freeze({
		reads,
		read(descriptor: SnapshotChunkDescriptor, options: Readonly<{ readonly signal: AbortSignal }>) {
			if (options.signal.aborted) return Promise.reject(options.signal.reason);
			reads.push(descriptor.index);
			const overridden = overrides.has(descriptor.index)
				? overrides.get(descriptor.index)
				: selected.chunks[descriptor.index];
			if (overrides.has(descriptor.index)) return Promise.resolve(overridden);
			return Promise.resolve(overridden === undefined ? undefined : new Uint8Array(overridden));
		},
	});
}

async function collect(stream: VerifiedSnapshotStream): Promise<readonly Uint8Array[]> {
	await stream.completion;
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

function expectExactPlainBytes(actual: Uint8Array, expected: Uint8Array): void {
	expect(Object.getPrototypeOf(actual)).toBe(Uint8Array.prototype);
	expect(actual.byteOffset).toBe(0);
	expect(actual.byteLength).toBe(actual.buffer.byteLength);
	expect(compareBytes(actual, expected)).toBe(0);
}

async function expectFailure(stream: VerifiedSnapshotStream, code: SnapshotStreamFailureCode): Promise<void> {
	try {
		await stream.completion;
		throw new Error(`expected snapshot stream failure ${code}`);
	} catch (error) {
		expect(error).toMatchObject({ code });
	}
}

describe("Phase 4c-a frozen snapshot stream RED", () => {
	it("preserves the frozen registry schemas, domains, ordering, and golden vector", () => {
		const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
		const vectors = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as VectorFile;
		const chunk = registry.kinds.snapshotChunk;
		const manifest = registry.kinds.snapshotManifest;
		expect(chunk.domain).toBe(contract.domains.chunk);
		expect(chunk.encoding).toBe("domain-framed-parts");
		expect(chunk.fields.map(({ name }) => name)).toEqual(["index", "bytes"]);
		expect(manifest.domain).toBe(contract.domains.manifest);
		expect(manifest.encoding).toBe("canonical-object");
		expect(manifest.fields.map(({ name }) => name).sort()).toEqual([...contract.manifestFields].sort());
		expect(manifest.fields.find(({ name }) => name === "chunks")?.sortRule).toBe("index-ascending");

		const vector = vectors.vectors.find(({ id }) => id === "snapshot-manifest-basic");
		expect(vector).toBeDefined();
		if (vector === undefined) return;
		const canonical = bytesFromHex(vector.canonicalHex);
		expect(decodeCanonical(canonical)).toEqual(vector.input);
		expect(compareBytes(encodeCanonical(vector.input), canonical)).toBe(0);
		expect(digest(vector.domain, canonical)).toBe(vector.digestHex);

		const chunkVector = vectors.vectors.find(({ id }) => id === "snapshot-chunk-basic");
		expect(chunkVector).toBeDefined();
		if (chunkVector === undefined) return;
		expect(chunkVector.domain).toBe(contract.domains.chunk);
		expect(chunkVector.partsHex).toEqual(["0300", "001122ff"]);
		expect(chunkDigest(0, bytesFromHex("001122ff"))).toBe(chunkVector.digestHex);
	});

	it("derives the exact pre-copy manifest ceiling from the shipped frozen profile", () => {
		const maximum = encodeCanonical(worstManifest());
		expect(maximum.byteLength).toBe(contract.profile.maxManifestBytes);
		expect(contract.profile.maxChunks).toBe(contract.profile.maxSnapshotBytes / contract.profile.snapshotChunkBytes);
		expect(maximum.byteLength).toBeLessThan(contract.profile.maxVerifierMemoryBytes);
	});

	it("keeps independent payload, chunk, and manifest digest oracles nontrivial", () => {
		const selected = fixture();
		expect(selected.chunks).toHaveLength(3);
		expect(selected.descriptors.map(({ byteLength }) => byteLength)).toEqual([131_072, 131_072, 37_857]);
		expect(Object.keys(selected.descriptors[0] ?? {}).sort()).toEqual([...contract.chunkFields].sort());
		expect(selected.descriptors[0]?.digest).not.toBe(selected.descriptors[1]?.digest);
		expect(selected.manifestDigest).not.toBe(selected.payloadDigest);
		const withoutIndex = digest(contract.domains.chunk, selected.chunks[1] as Uint8Array);
		expect(withoutIndex).not.toBe(selected.descriptors[1]?.digest);
	});

	it("binds the signed lineage and closed failure roster without reward fields", () => {
		for (const commit of Object.values(contract.lineage)) {
			expect(
				execFileSync("git", ["cat-file", "-t", `${commit}^{commit}`], {
					cwd: REPOSITORY_ROOT,
					encoding: "utf8",
				}).trim()
			).toBe("commit");
		}
		expect(new Set(contract.failureCodes).size).toBe(contract.failureCodes.length);
		expect(contract.failureCodes).toEqual([...contract.failureCodes].sort());
	});

	it("has exactly one readiness failure for the missing non-root owners", () => {
		expect(ownerExists).toBe(true);
	});

	describe.skipIf(!ownerExists)("dormant GREEN contract", () => {
		it("keeps the three production owners on explicit non-root routes", async () => {
			const owners = await loadOwners();
			expect(owners.protocol.SNAPSHOT_MANIFEST_MAX_BYTES).toBe(contract.profile.maxManifestBytes);
			expect(Object.keys(owners.canonical).sort()).toEqual(EXPECTED_CANONICAL_EXPORTS);
			expect(Object.keys(owners.protocol).sort()).toEqual(EXPECTED_PROTOCOL_EXPORTS);
			expect(Object.keys(owners.stream).sort()).toEqual(EXPECTED_STREAM_EXPORTS);
			expect(packageExports("packages/canonical/package.json")).toHaveProperty("./domain-hash-stream");
			expect(packageExports("packages/protocol-v3/package.json")).toHaveProperty("./snapshot-transfer");
			expect(packageExports("packages/compaction/package.json")).toHaveProperty("./snapshot-stream");
			assertTypeContract();
		});

		it("differentially matches hashDomain across arbitrary update segmentations", async () => {
			const { canonical, protocol } = await loadOwners();
			const bytes = new Uint8Array(1_000_003).map((_, index) => (index * 17) % 251);
			for (const widths of [[bytes.byteLength], [1, bytes.byteLength - 1], [17, 131_072, 7, 868_907]]) {
				const owner = canonical.createDomainHashStream(contract.domains.payload, bytes.byteLength);
				let offset = 0;
				for (const width of widths) {
					owner.update(bytes.subarray(offset, offset + width));
					offset += width;
				}
				expect(offset).toBe(bytes.byteLength);
				expect(owner.digest()).toEqual(hashDomain(contract.domains.payload, bytes));
			}

			const under = canonical.createDomainHashStream(contract.domains.payload, bytes.byteLength);
			under.update(bytes.subarray(0, bytes.byteLength - 1));
			expect(() => under.digest()).toThrow();

			const over = canonical.createDomainHashStream(contract.domains.payload, bytes.byteLength);
			expect(() => over.update(new Uint8Array(bytes.byteLength + 1))).toThrow();

			const terminal = canonical.createDomainHashStream(contract.domains.payload, bytes.byteLength);
			terminal.update(bytes);
			const terminalDigest = terminal.digest();
			expect(terminalDigest).toEqual(hashDomain(contract.domains.payload, bytes));
			expect(() => terminal.digest()).toThrow();
			expect(() => terminal.update(Uint8Array.of(1))).toThrow();

			const chunk = bytes.subarray(0, 997);
			expect(protocol.snapshotChunkDigest(17, chunk)).toBe(chunkDigest(17, chunk));
		});

		it("rejects manifest carriers before copy/hash/decode beyond the exact bound", async () => {
			const { protocol } = await loadOwners();
			const selected = fixture();
			const maximum = manifestBytes(worstManifest());
			expect(maximum.exactCanonicalManifestBytes.byteLength).toBe(contract.profile.maxManifestBytes);
			const decodedMaximum = protocol.decodeSnapshotManifest({
				exactCanonicalManifestBytes: maximum.exactCanonicalManifestBytes,
				expectedManifestDigest: maximum.manifestDigest,
				profile: PROFILE,
			});
			expect(decodedMaximum.manifest).toEqual(worstManifest());
			expect(() =>
				protocol.decodeSnapshotManifest({
					exactCanonicalManifestBytes: new Uint8Array(contract.profile.maxManifestBytes + 1),
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
				})
			).toThrowError(expect.objectContaining({ code: "manifest-too-large" }));
			if (typeof SharedArrayBuffer === "function") {
				const sharedOversize = new Uint8Array(new SharedArrayBuffer(contract.profile.maxManifestBytes + 1));
				expect(() =>
					protocol.decodeSnapshotManifest({
						exactCanonicalManifestBytes: sharedOversize,
						expectedManifestDigest: selected.manifestDigest,
						profile: PROFILE,
					})
				).toThrowError(expect.objectContaining({ code: "manifest-too-large" }));
			}
			const decoded = protocol.decodeSnapshotManifest({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
			});
			expect(decoded.manifest).toEqual(selected.manifest);
			expect(decoded.exactCanonicalManifestBytes).not.toBe(selected.exactCanonicalManifestBytes);
			selected.exactCanonicalManifestBytes.fill(0);
			expect(decoded.exactCanonicalManifestBytes.some((byte) => byte !== 0)).toBe(true);
		});

		it("gates iteration on full payload verification and writes only verified chunks", async () => {
			const { stream } = await loadOwners();
			const selected = fixture();
			let releaseLast: (() => void) | undefined;
			const lastGate = new Promise<void>((resolveGate) => {
				releaseLast = resolveGate;
			});
			const source = sourceFor(selected);
			const gatedSource: SnapshotChunkSource = {
				async read(descriptor, options) {
					if (descriptor.index === selected.descriptors.length - 1) await lastGate;
					return source.read(descriptor, options);
				},
			};
			const quarantine = new MemoryQuarantine();
			const verified = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
				quarantine,
				source: gatedSource,
			});
			let yielded = false;
			const iterator = verified[Symbol.asyncIterator]();
			const first = iterator.next().then((result) => {
				yielded = true;
				return result;
			});
			await new Promise((resolveTick) => setTimeout(resolveTick, 10));
			expect(yielded).toBe(false);
			releaseLast?.();
			const firstResult = await first;
			expect(firstResult.done).toBe(false);
			const completion = await verified.completion;
			expect(completion).toMatchObject({
				chunkCount: selected.chunks.length,
				exactByteLength: 300_001,
				manifestDigest: selected.manifestDigest,
				payloadDigest: selected.payloadDigest,
			});
			expect(quarantine.writes).toEqual([0, 1, 2]);
			const all = [firstResult.value as Uint8Array];
			for (;;) {
				const result = await iterator.next();
				if (result.done) break;
				all.push(result.value);
			}
			expect(all).toHaveLength(selected.chunks.length);
			for (const [index, bytes] of all.entries()) {
				expectExactPlainBytes(bytes, selected.chunks[index] as Uint8Array);
			}
			all[0]?.fill(255);
			const reopened = await collect(verified);
			for (const [index, bytes] of reopened.entries()) {
				expectExactPlainBytes(bytes, selected.chunks[index] as Uint8Array);
			}
		});

		it("resumes an arbitrary existing set and requests only exact missing descriptors", async () => {
			const { stream } = await loadOwners();
			const selected = fixture();
			for (const present of [[1], [0, 2]] as const) {
				const presentSet = new Set<number>(present);
				const quarantine = new MemoryQuarantine();
				for (const index of present) {
					quarantine.seed(selected.descriptors[index] as SnapshotChunkDescriptor, selected.chunks[index] as Uint8Array);
				}
				const source = sourceFor(selected);
				const verified = stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine,
					source,
				});
				const output = await collect(verified);
				for (const [index, bytes] of output.entries()) {
					expectExactPlainBytes(bytes, selected.chunks[index] as Uint8Array);
				}
				const missing = selected.descriptors.map(({ index }) => index).filter((index) => !presentSet.has(index));
				expect(source.reads).toEqual(missing);
				expect(quarantine.writes).toEqual(missing);
			}
		});

		it("rejects hostile carriers and never retains source bodies", async () => {
			const { stream } = await loadOwners();
			const selected = fixture();
			const mutations: ReadonlyArray<readonly [SnapshotStreamFailureCode, Uint8Array | undefined]> = [
				["chunk-missing", undefined],
				["chunk-length-mismatch", new Uint8Array(1)],
				["chunk-digest-mismatch", new Uint8Array(selected.chunks[1] as Uint8Array).fill(9)],
			];
			for (const [code, bytes] of mutations) {
				const quarantine = new MemoryQuarantine();
				const verified = stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine,
					source: sourceFor(selected, new Map([[1, bytes]])),
				});
				await expectFailure(verified, code);
				expect(quarantine.discarded).toBe(true);
				if (code !== "chunk-missing") expect(quarantine.writes).not.toContain(1);
			}

			if (typeof SharedArrayBuffer === "function") {
				const shared = new Uint8Array(new SharedArrayBuffer(selected.chunks[0]?.byteLength ?? 0));
				shared.set(selected.chunks[0] as Uint8Array);
				await expectFailure(
					stream.verifySnapshotStream({
						exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
						expectedManifestDigest: selected.manifestDigest,
						profile: PROFILE,
						quarantine: new MemoryQuarantine(),
						source: sourceFor(selected, new Map([[0, shared]])),
					}),
					"chunk-invalid-carrier"
				);
			}

			const first = selected.chunks[0] as Uint8Array;
			const partialBacking = new Uint8Array(first.byteLength + 2);
			partialBacking.set(first, 1);
			const partial = partialBacking.subarray(1, partialBacking.byteLength - 1);
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: sourceFor(selected, new Map([[0, partial]])),
				}),
				"chunk-invalid-carrier"
			);

			const resize = Reflect.get(ArrayBuffer.prototype, "resize");
			if (typeof resize === "function") {
				const resizable = new Uint8Array(new ArrayBuffer(first.byteLength, { maxByteLength: first.byteLength + 1 }));
				resizable.set(first);
				await expectFailure(
					stream.verifySnapshotStream({
						exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
						expectedManifestDigest: selected.manifestDigest,
						profile: PROFILE,
						quarantine: new MemoryQuarantine(),
						source: sourceFor(selected, new Map([[0, resizable]])),
					}),
					"chunk-invalid-carrier"
				);
			}

			const detached = new Uint8Array(first);
			structuredClone(detached.buffer, { transfer: [detached.buffer] });
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: sourceFor(selected, new Map([[0, detached]])),
				}),
				"chunk-invalid-carrier"
			);

			const mutable = selected.chunks.map((bytes) => new Uint8Array(bytes));
			const verified = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
				quarantine: new MemoryQuarantine(),
				source: {
					read(descriptor) {
						return Promise.resolve(mutable[descriptor.index]);
					},
				},
			});
			await verified.completion;
			for (const bytes of mutable) bytes.fill(0);
			const output = await collect(verified);
			for (const [index, bytes] of output.entries()) {
				expectExactPlainBytes(bytes, selected.chunks[index] as Uint8Array);
			}
		});

		it("aborts before read, during read, after read, before completion, and on consumer abandonment", async () => {
			const { stream } = await loadOwners();
			const selected = fixture();

			const preController = new AbortController();
			preController.abort(new Error("phase4c-pre-abort"));
			const preSource = sourceFor(selected);
			const preQuarantine = new MemoryQuarantine();
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: preQuarantine,
					signal: preController.signal,
					source: preSource,
				}),
				"aborted"
			);
			expect(preSource.reads).toEqual([]);
			expect(preQuarantine.writes).toEqual([]);

			let beganRead: (() => void) | undefined;
			const readBegan = new Promise<void>((resolveRead) => {
				beganRead = resolveRead;
			});
			const duringController = new AbortController();
			const duringQuarantine = new MemoryQuarantine();
			const during = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
				quarantine: duringQuarantine,
				signal: duringController.signal,
				source: {
					read(_descriptor, { signal }) {
						beganRead?.();
						return new Promise((_resolveRead, rejectRead) => {
							signal.addEventListener("abort", () => rejectRead(signal.reason), { once: true });
						});
					},
				},
			});
			const duringNext = during[Symbol.asyncIterator]().next();
			await readBegan;
			duringController.abort(new Error("phase4c-during-read"));
			await expectFailure(during, "aborted");
			await expect(duringNext).rejects.toMatchObject({ code: "aborted" });
			expect(duringQuarantine.discarded).toBe(true);

			const afterReadController = new AbortController();
			const afterReadQuarantine = new MemoryQuarantine();
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: afterReadQuarantine,
					signal: afterReadController.signal,
					source: {
						read(descriptor) {
							queueMicrotask(() => afterReadController.abort(new Error("phase4c-after-read")));
							return Promise.resolve(new Uint8Array(selected.chunks[descriptor.index] as Uint8Array));
						},
					},
				}),
				"aborted"
			);
			expect(afterReadQuarantine.writes).toEqual([]);

			const completionController = new AbortController();
			const completionQuarantine = new MemoryQuarantine();
			const abortingQuarantine: SnapshotQuarantinePort = {
				discard: () => completionQuarantine.discard(),
				read: (descriptor) => completionQuarantine.read(descriptor),
				async write(descriptor, bytes) {
					await completionQuarantine.write(descriptor, bytes);
					if (descriptor.index === selected.descriptors.length - 1) {
						completionController.abort(new Error("phase4c-before-completion"));
					}
				},
			};
			const beforeCompletion = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
				quarantine: abortingQuarantine,
				signal: completionController.signal,
				source: sourceFor(selected),
			});
			const beforeCompletionNext = beforeCompletion[Symbol.asyncIterator]().next();
			await expectFailure(beforeCompletion, "aborted");
			await expect(beforeCompletionNext).rejects.toMatchObject({ code: "aborted" });
			expect(completionQuarantine.discarded).toBe(true);

			const abandonment = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.manifestDigest,
				profile: PROFILE,
				quarantine: new MemoryQuarantine(),
				source: sourceFor(selected),
			});
			await abandonment.completion;
			const abandonedIterator = abandonment[Symbol.asyncIterator]();
			expect((await abandonedIterator.next()).done).toBe(false);
			await abandonedIterator.return?.();
			const reopened = await collect(abandonment);
			expect(reopened).toHaveLength(selected.chunks.length);
		});

		it("validates every frozen manifest boundary and descriptor invariant", async () => {
			const { protocol, stream } = await loadOwners();
			const selected = fixture();
			expect(() =>
				protocol.decodeSnapshotManifest({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: "0".repeat(64),
					profile: PROFILE,
				})
			).toThrowError(expect.objectContaining({ code: "manifest-digest-mismatch" }));

			const base = selected.manifest;
			const descriptors = selected.descriptors;
			const withoutPayloadDigest = { ...base } as Record<string, unknown>;
			delete withoutPayloadDigest.payloadDigest;
			const tooManyChunks = Array.from({ length: contract.profile.maxChunks + 1 }, (_, index) => ({
				byteLength: 1,
				digest: "a".repeat(64),
				index,
			}));
			const invalidCases: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
				["extra-field", { ...base, unexpected: true }],
				["missing-field", withoutPayloadDigest],
				["wrong-kind", { ...base, kind: "snapshot" }],
				["wrong-protocol", { ...base, protocolMajor: 4 }],
				["wrong-encoding", { ...base, encodingVersion: "drp-canonical-profile-2" }],
				["empty-chunks", { ...base, chunks: [], totalBytes: 0 }],
				["zero-total", { ...base, totalBytes: 0 }],
				["duplicate-index", { ...base, chunks: [descriptors[0], { ...descriptors[1], index: 0 }, descriptors[2]] }],
				["out-of-order", { ...base, chunks: [descriptors[1], descriptors[0], descriptors[2]] }],
				[
					"index-gap",
					{ ...base, chunks: [descriptors[0], { ...descriptors[1], index: 2 }, { ...descriptors[2], index: 3 }] },
				],
				[
					"short-non-final",
					{
						...base,
						chunks: [{ ...descriptors[0], byteLength: 1 }, descriptors[1], descriptors[2]],
						totalBytes: 168_930,
					},
				],
				[
					"zero-final",
					{
						...base,
						chunks: [descriptors[0], descriptors[1], { ...descriptors[2], byteLength: 0 }],
						totalBytes: 262_144,
					},
				],
				[
					"oversize-final",
					{
						...base,
						chunks: [descriptors[0], descriptors[1], { ...descriptors[2], byteLength: PROFILE.snapshotChunkBytes + 1 }],
						totalBytes: 393_217,
					},
				],
				["sum-mismatch", { ...base, totalBytes: 300_000 }],
				["too-many-chunks", { ...base, chunks: tooManyChunks, totalBytes: tooManyChunks.length }],
				["over-payload", { ...base, totalBytes: PROFILE.maxSnapshotBytes + 1 }],
			];
			for (const [id, value] of invalidCases) {
				const mutated = manifestBytes(value);
				expect(compareBytes(mutated.exactCanonicalManifestBytes, selected.exactCanonicalManifestBytes), id).not.toBe(0);
				await expectFailure(
					stream.verifySnapshotStream({
						exactCanonicalManifestBytes: mutated.exactCanonicalManifestBytes,
						expectedManifestDigest: mutated.manifestDigest,
						profile: PROFILE,
						quarantine: new MemoryQuarantine(),
						source: sourceFor(selected),
					}),
					"manifest-invalid"
				);
			}

			const maximum = manifestBytes(worstManifest());
			let maximumReads = 0;
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: maximum.exactCanonicalManifestBytes,
					expectedManifestDigest: maximum.manifestDigest,
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: {
						read() {
							maximumReads += 1;
							return Promise.reject(new Error("maximum-manifest-reached-source"));
						},
					},
				}),
				"source-failed"
			);
			expect(maximumReads).toBe(1);

			const oversize = new Uint8Array(contract.profile.maxManifestBytes + 1);
			const oversizeSource = sourceFor(selected);
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: oversize,
					expectedManifestDigest: digest(contract.domains.manifest, oversize),
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: oversizeSource,
				}),
				"manifest-too-large"
			);
			expect(oversizeSource.reads).toEqual([]);

			const noncanonicalBytes = new Uint8Array(selected.exactCanonicalManifestBytes.byteLength + 1);
			noncanonicalBytes.set(selected.exactCanonicalManifestBytes);
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: noncanonicalBytes,
					expectedManifestDigest: digest(contract.domains.manifest, noncanonicalBytes),
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: sourceFor(selected),
				}),
				"manifest-noncanonical"
			);
		});

		it("keeps failed streams inert across payload, source, and quarantine failures", async () => {
			const { stream } = await loadOwners();
			const selected = fixture();

			const wrongPayload = manifestVariant(selected, { payloadDigest: "f".repeat(64) });
			const payloadFailure = stream.verifySnapshotStream({
				exactCanonicalManifestBytes: wrongPayload.exactCanonicalManifestBytes,
				expectedManifestDigest: wrongPayload.manifestDigest,
				profile: PROFILE,
				quarantine: new MemoryQuarantine(),
				source: sourceFor(selected),
			});
			const failedNext = payloadFailure[Symbol.asyncIterator]().next();
			await expectFailure(payloadFailure, "payload-digest-mismatch");
			await expect(failedNext).rejects.toMatchObject({ code: "payload-digest-mismatch" });

			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: new MemoryQuarantine(),
					source: { read: () => Promise.reject(new Error("source-failure")) },
				}),
				"source-failed"
			);

			const failedQuarantine: SnapshotQuarantinePort = {
				discard: () => Promise.resolve(),
				read: () => Promise.resolve(undefined),
				write: () => Promise.reject(new Error("quarantine-failure")),
			};
			await expectFailure(
				stream.verifySnapshotStream({
					exactCanonicalManifestBytes: selected.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.manifestDigest,
					profile: PROFILE,
					quarantine: failedQuarantine,
					source: sourceFor(selected),
				}),
				"quarantine-failed"
			);
		});

		it("proves peak verifier ownership on 64 MiB and kills retained-body accumulation", () => {
			const run = (mode: "owner" | "retain-mutant"): string =>
				execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", MEMORY_CHILD, mode], {
					cwd: REPOSITORY_ROOT,
					encoding: "utf8",
					maxBuffer: 1024 * 1024,
				});
			const owner = JSON.parse(run("owner")) as {
				readonly chunkCount: number;
				readonly exactByteLength: number;
				readonly maxMemoryBytes: number;
				readonly manifestDigest: string;
				readonly payloadDigest: string;
				readonly peakVerifierBodyBytes: number;
				readonly reopenedChunkCount: number;
				readonly settledVerifierBodyBytes: number;
			};
			const mutant = JSON.parse(run("retain-mutant")) as {
				readonly peakVerifierBodyBytes: number;
				readonly retainedBodyMutantDetected: boolean;
			};
			expect(owner.chunkCount).toBe(512);
			expect(owner.reopenedChunkCount).toBe(512);
			expect(owner.exactByteLength).toBe(contract.profile.memoryProofBytes);
			expect(owner.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(owner.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(owner.maxMemoryBytes).toBe(contract.profile.maxVerifierMemoryBytes);
			expect(owner.peakVerifierBodyBytes).toBeLessThan(contract.profile.maxVerifierMemoryBytes);
			expect(owner.settledVerifierBodyBytes).toBe(0);
			expect(mutant.retainedBodyMutantDetected).toBe(true);
			expect(mutant.peakVerifierBodyBytes).toBeGreaterThanOrEqual(contract.profile.maxVerifierMemoryBytes);
		});
	});
});
