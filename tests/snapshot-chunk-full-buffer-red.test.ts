import { describe, expect, it } from "vitest";

import { encodeCanonical } from "../packages/canonical/src/index.js";
import { type SnapshotChunkDescriptor, verifySnapshotStream } from "../packages/compaction/src/snapshot-stream.js";
import {
	encodeSnapshotTransfer,
	SNAPSHOT_MANIFEST_MAX_BYTES,
} from "../packages/protocol-v3/src/snapshot-transfer.js";

// RED (room state limit, finding C): a snapshot payload larger than one chunk (131,072 bytes) can
// never be sealed or transferred. encodeSnapshotTransfer cuts the payload into chunks with
// `subarray`, so with two or more chunks every chunk is a view into the payload's buffer. The
// stream verifier (rightly) accepts only a full, attached, non-resizable buffer per chunk, so it
// refuses the producer's own chunks: "snapshot chunk carrier is invalid". With one chunk the view
// covers the whole buffer and passes, which is why no room under 128 KiB ever met this.

const PROFILE = Object.freeze({
	maxManifestBytes: SNAPSHOT_MANIFEST_MAX_BYTES,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const DIGEST = "a".repeat(64);

function encoded(payloadBytes: number) {
	// A canonical byte-string payload of the requested total size.
	const bytesOf = (length: number) => encodeCanonical(new Uint8Array(length).map((_, index) => index % 251));
	const header = bytesOf(payloadBytes).byteLength - payloadBytes;
	const payload = bytesOf(payloadBytes - header);
	expect(payload.byteLength).toBe(payloadBytes);
	return encodeSnapshotTransfer({
		aclDigest: DIGEST,
		anchor: DIGEST,
		epoch: 3,
		exactCanonicalPayloadBytes: payload,
		objectId: "creator:snapshot-chunk-full-buffer",
		profile: PROFILE,
		schemaVersion: 1,
		stateDigest: DIGEST,
	});
}

async function verify(transfer: ReturnType<typeof encoded>) {
	const writes = new Map<number, Uint8Array>();
	const verified = verifySnapshotStream({
		exactCanonicalManifestBytes: transfer.exactCanonicalManifestBytes,
		expectedManifestDigest: transfer.manifestDigest,
		profile: PROFILE,
		quarantine: {
			discard: () => {
				writes.clear();
				return Promise.resolve();
			},
			read: (descriptor: SnapshotChunkDescriptor) => Promise.resolve(writes.get(descriptor.index)),
			write: (descriptor: SnapshotChunkDescriptor, bytes: Uint8Array) => {
				writes.set(descriptor.index, bytes);
				return Promise.resolve();
			},
		},
		source: { read: (descriptor: SnapshotChunkDescriptor) => Promise.resolve(transfer.chunks[descriptor.index]) },
	});
	const completion = await verified.completion;
	const yielded: Uint8Array[] = [];
	for await (const chunk of verified) yielded.push(chunk);
	return { completion, yielded };
}

describe("snapshot chunks are full-buffer carriers", () => {
	for (const payloadBytes of [131_072, 131_073, 300_001]) {
		it(`a ${payloadBytes}-byte payload's own chunks verify`, async () => {
			const transfer = encoded(payloadBytes);
			expect(transfer.chunks.length).toBe(Math.ceil(payloadBytes / 131_072));
			for (const chunk of transfer.chunks) {
				expect(chunk.byteOffset, "chunk starts its own buffer").toBe(0);
				expect(chunk.buffer.byteLength, "chunk owns its whole buffer").toBe(chunk.byteLength);
			}
			const { completion, yielded } = await verify(transfer);
			expect(completion).toMatchObject({
				chunkCount: transfer.chunks.length,
				exactByteLength: payloadBytes,
				manifestDigest: transfer.manifestDigest,
				payloadDigest: transfer.payloadDigest,
			});
			expect(yielded.map((chunk) => chunk.byteLength)).toEqual(transfer.chunks.map((chunk) => chunk.byteLength));
		});
	}
});
