/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODE = process.argv[2] ?? "owner";
if (MODE !== "owner" && MODE !== "retain-mutant") throw new Error(`unknown memory mode ${MODE}`);
const RESOLVED_IMPORTS = JSON.parse(process.argv[3] ?? "null");
if (
	RESOLVED_IMPORTS === null ||
	typeof RESOLVED_IMPORTS !== "object" ||
	Array.isArray(RESOLVED_IMPORTS) ||
	Reflect.ownKeys(RESOLVED_IMPORTS).sort().join("\n") !==
		["@ts-drp/canonical", "@ts-drp/compaction/snapshot-stream"].sort().join("\n")
) {
	throw new Error("missing exact workspace package resolutions");
}
const [{ encodeCanonical }, { verifySnapshotStream }] = await Promise.all([
	import(RESOLVED_IMPORTS["@ts-drp/canonical"]),
	import(RESOLVED_IMPORTS["@ts-drp/compaction/snapshot-stream"]),
]);

const CHUNK_BYTES = 131_072;
const PAYLOAD_BYTES = 67_108_864;
const CHUNK_COUNT = PAYLOAD_BYTES / CHUNK_BYTES;
const MAX_MEMORY_BYTES = 262_144;
const DIRECTORY = await mkdtemp(join(tmpdir(), "ts-drp-phase4c-memory-"));
const sourceBodies = new Map();
const verifierBodies = new Set();
let baselineMemoryBytes;
let retainedBodyMutantDetected = false;
let peakProcessDeltaBytes = 0;
let peakVerifierBodyBytes = 0;

function hex(bytes) {
	return Buffer.from(bytes).toString("hex");
}

function u32be(value) {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value) {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function independentDomainHasher(domain, exactPartLength) {
	const domainBytes = new TextEncoder().encode(domain);
	const hasher = createHash("sha256")
		.update(Uint8Array.of(0x44, 0x52, 0x50, 0x00))
		.update(u32be(domainBytes.byteLength))
		.update(domainBytes)
		.update(u64be(exactPartLength));
	let updated = 0;
	return {
		digest() {
			if (updated !== exactPartLength) throw new Error("independent oracle length mismatch");
			return hasher.digest();
		},
		update(bytes) {
			updated += bytes.byteLength;
			if (updated > exactPartLength) throw new Error("independent oracle overflow");
			hasher.update(bytes);
		},
	};
}

function independentDigest(domain, ...parts) {
	const domainBytes = new TextEncoder().encode(domain);
	const hasher = createHash("sha256")
		.update(Uint8Array.of(0x44, 0x52, 0x50, 0x00))
		.update(u32be(domainBytes.byteLength))
		.update(domainBytes);
	for (const part of parts) hasher.update(u64be(part.byteLength)).update(part);
	return hasher.digest();
}

function generatedChunk(index) {
	const bytes = new Uint8Array(CHUNK_BYTES);
	const start = index * CHUNK_BYTES;
	for (let offset = 0; offset < bytes.byteLength; offset += 1) bytes[offset] = (start + offset) % 251;
	return bytes;
}

function memoryBytes() {
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.arrayBuffers;
}

function observe() {
	let verifierBodyBytes = 0;
	for (const bytes of verifierBodies) verifierBodyBytes += bytes.byteLength;
	peakVerifierBodyBytes = Math.max(peakVerifierBodyBytes, verifierBodyBytes);
	if (baselineMemoryBytes !== undefined) {
		peakProcessDeltaBytes = Math.max(peakProcessDeltaBytes, Math.max(0, memoryBytes() - baselineMemoryBytes));
	}
}

const payloadHasher = independentDomainHasher("ts-drp/snapshot-payload/v3", PAYLOAD_BYTES);
const chunks = [];
for (let index = 0; index < CHUNK_COUNT; index += 1) {
	const bytes = generatedChunk(index);
	payloadHasher.update(bytes);
	chunks.push({
		byteLength: bytes.byteLength,
		digest: hex(independentDigest("ts-drp/snapshot-chunk/v3", encodeCanonical(index), bytes)),
		index,
	});
}
const payloadDigest = hex(payloadHasher.digest());
const manifest = {
	aclDigest: "36".repeat(32),
	anchor: "34".repeat(32),
	chunks,
	encodingVersion: "drp-canonical-profile-1",
	epoch: 7,
	kind: "drp-snapshot-manifest",
	objectId: "object:phase-4c-memory",
	payloadDigest,
	protocolMajor: 3,
	schemaVersion: 1,
	stateDigest: "35".repeat(32),
	totalBytes: PAYLOAD_BYTES,
};
const exactCanonicalManifestBytes = encodeCanonical(manifest);
const expectedManifestDigest = hex(independentDigest("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes));

const source = {
	async read(descriptor, { signal }) {
		if (signal.aborted) throw signal.reason;
		if (baselineMemoryBytes === undefined) {
			global.gc?.();
			baselineMemoryBytes = memoryBytes();
		}
		const bytes = generatedChunk(descriptor.index);
		sourceBodies.set(descriptor.index, bytes);
		observe();
		await new Promise((resolveTick) => setTimeout(resolveTick, 1));
		return bytes;
	},
};
const quarantine = {
	async discard() {
		await rm(DIRECTORY, { force: true, recursive: true });
	},
	async read(descriptor) {
		try {
			return new Uint8Array(await readFile(join(DIRECTORY, String(descriptor.index))));
		} catch (error) {
			if (error !== null && typeof error === "object" && error.code === "ENOENT") return undefined;
			throw error;
		}
	},
	async write(descriptor, exactBytes) {
		const sourceBytes = sourceBodies.get(descriptor.index);
		if (sourceBytes === exactBytes || sourceBytes?.buffer === exactBytes.buffer) {
			throw new Error("verifier retained the source carrier");
		}
		if (
			Object.getPrototypeOf(exactBytes) !== Uint8Array.prototype ||
			exactBytes.byteOffset !== 0 ||
			exactBytes.byteLength !== exactBytes.buffer.byteLength
		) {
			throw new Error("quarantine received a non-plain or partial carrier");
		}
		verifierBodies.add(exactBytes);
		observe();
		await new Promise((resolveTick) => setTimeout(resolveTick, 1));
		await writeFile(join(DIRECTORY, String(descriptor.index)), exactBytes);
		sourceBodies.delete(descriptor.index);
		if (MODE === "retain-mutant" && descriptor.index === CHUNK_COUNT - 1) {
			observe();
			await new Promise((resolveTick) => setTimeout(resolveTick, 2));
			retainedBodyMutantDetected = peakVerifierBodyBytes >= PAYLOAD_BYTES;
			verifierBodies.clear();
		} else if (MODE === "owner") {
			verifierBodies.delete(exactBytes);
		}
		observe();
	},
};

try {
	const stream = verifySnapshotStream({
		exactCanonicalManifestBytes,
		expectedManifestDigest,
		profile: {
			maxManifestBytes: 212_387,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: CHUNK_BYTES,
		},
		quarantine,
		source,
	});
	const completion = await stream.completion;
	if (
		completion.chunkCount !== CHUNK_COUNT ||
		completion.exactByteLength !== PAYLOAD_BYTES ||
		completion.manifestDigest !== expectedManifestDigest ||
		completion.payloadDigest !== payloadDigest
	) {
		throw new Error("completion did not bind the independently computed transcript");
	}

	async function verifyIteration() {
		let count = 0;
		for await (const bytes of stream) {
			if (
				Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
				bytes.byteOffset !== 0 ||
				bytes.byteLength !== bytes.buffer.byteLength ||
				bytes.byteLength !== CHUNK_BYTES
			) {
				throw new Error("verified iteration returned a non-plain or malformed chunk");
			}
			const expected = chunks[count];
			if (hex(independentDigest("ts-drp/snapshot-chunk/v3", encodeCanonical(count), bytes)) !== expected.digest) {
				throw new Error("verified iteration changed chunk bytes");
			}
			count += 1;
			observe();
		}
		return count;
	}

	const chunkCount = await verifyIteration();
	const reopenedChunkCount = await verifyIteration();
	global.gc?.();
	observe();
	process.stdout.write(
		`${JSON.stringify({
			chunkBodyBytes: CHUNK_BYTES,
			chunkCount,
			exactByteLength: completion.exactByteLength,
			manifestDigest: completion.manifestDigest,
			maxMemoryBytes: MAX_MEMORY_BYTES,
			payloadDigest: completion.payloadDigest,
			peakProcessDeltaBytes,
			peakVerifierBodyBytes,
			retainedBodyMutantDetected,
			reopenedChunkCount,
			settledMemoryBytes: baselineMemoryBytes === undefined ? 0 : Math.max(0, memoryBytes() - baselineMemoryBytes),
			settledVerifierBodyBytes: [...verifierBodies].reduce((sum, bytes) => sum + bytes.byteLength, 0),
		})}\n`
	);
} finally {
	await rm(DIRECTORY, { force: true, recursive: true });
}
