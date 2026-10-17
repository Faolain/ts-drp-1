import { generateKeyPairSync, sign, verify } from "node:crypto";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	digestReceivedVertexPreimage,
	vertexCanonicalBytes,
} from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { describe, expect, it } from "vitest";

import {
	appendArchiveIndex,
	deriveClosedEpochArchiveAppend,
	produceClosedEpochArchive,
	measureArchiveAppendCapacityForSizing,
	readArchiveSegment,
	verifyArchiveIndexEntry,
	type ArchiveLimits,
	type ClosedArchiveSourceRecord,
} from "../src/archive.js";
import { buildMerkleTree, CompactMerkleAccumulator, EMPTY_MERKLE_ROOT, inclusionProof } from "../src/ct-merkle.js";
import { deriveCloseSetHistoryCommitment, type CloseSetHistoryCommitmentInput } from "../src/history-commitment.js";
import type { AccumulatorSnapshot, EpochVertex } from "../src/types.js";

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const LIMITS: ArchiveLimits = {
	maxSegmentBytes: 4096,
	maxRecordsPerSegment: 1,
	chunkBytes: 256,
	maxChunks: 16,
	maxSegments: 4,
};

it("archive scalar capacity sizing matches complete signed-source construction without fabricating preimages", async () => {
	const source = fixture();
	const produced = await produceClosedEpochArchive({close:source.close,sourceRecords:source.sources,limits:LIMITS});
	const commitment = await deriveCloseSetHistoryCommitment(source.close);
	const measured = measureArchiveAppendCapacityForSizing({objectId:produced.objectId,epoch:produced.epoch,limits:LIMITS,
		records:commitment.closeSetEntries.map(row => ({ordinal:row.ordinal,preimageByteLength:row.authenticatedCanonicalPreimageByteLength}))});
	const artifacts = produced.segments.flatMap(segment => [segment.exactCanonicalDescriptorBytes,segment.exactCanonicalIndexEntryBytes,...segment.chunks.map(chunk => chunk.bytes)]);
	expect(measured).toEqual({artifactBytes:artifacts.reduce((n,bytes) => n + bytes.byteLength,0),artifactCount:artifacts.length,
		indexEntries:produced.segments.length,maxArtifactBytes:Math.max(...artifacts.map(bytes => bytes.byteLength)),
		segments:produced.segments.map(segment => ({descriptorByteLength:segment.exactCanonicalDescriptorBytes.byteLength,indexEntryByteLength:segment.exactCanonicalIndexEntryBytes.byteLength}))});
});

/** Codec fixtures, not native lifecycle/source-authentication acceptance evidence. */
function fixture(
	epoch = 0,
	previousHistorySnapshot: AccumulatorSnapshot = new CompactMerkleAccumulator().snapshot(),
	archiveRoot = hex(EMPTY_MERKLE_ROOT)
) {
	const previous = CompactMerkleAccumulator.fromSnapshot(previousHistorySnapshot);
	const anchorBytes = encodeCanonical({
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId: "creator:archive-unit",
		epoch,
		aclDigest: "11".repeat(32),
		archiveIndexRoot: archiveRoot,
		blueprintDigest: "22".repeat(32),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "33".repeat(32),
		historyRoot: hex(previous.root()),
		historySize: previous.size,
		parametersDigest: "44".repeat(32),
		previousAnchor: "55".repeat(32),
		profileDigest: "66".repeat(32),
		signerSetDigest: "77".repeat(32),
		stateDigest: "88".repeat(32),
	});
	const anchor = hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertices = new Map<string, EpochVertex>([
		[
			anchor,
			{
				kind: "drp-epoch-anchor",
				objectId: "creator:archive-unit",
				epoch,
				hash: anchor,
				dependencies: [],
			},
		],
	]);
	const sources: ClosedArchiveSourceRecord[] = [];
	const keys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
	let dependency = anchor;
	for (let index = 0; index < keys.length; index++) {
		const operation = { kind: "archive-fixture-message", text: `epoch ${epoch} member ${index}` };
		const exactCanonicalPreimageBytes = vertexCanonicalBytes({
			kind: "drp-vertex",
			protocolMajor: 3,
			objectId: "creator:archive-unit",
			epoch,
			anchor,
			author: `writer-${index}`,
			authorSequence: 0,
			logicalTime: index + 1,
			dependencies: [dependency],
			operation,
		});
		const vertexDigest = hex(digestReceivedVertexPreimage(exactCanonicalPreimageBytes));
		const detachedSignature = new Uint8Array(
			sign(null, digestReceivedVertexPreimage(exactCanonicalPreimageBytes), keys[index]!.privateKey)
		);
		vertices.set(vertexDigest, {
			kind: "drp-vertex",
			objectId: "creator:archive-unit",
			epoch,
			anchor,
			dependencies: [dependency],
			hash: vertexDigest,
			operation,
		});
		sources.push({ vertexDigest, exactCanonicalPreimageBytes, detachedSignature });
		dependency = vertexDigest;
	}
	const close: CloseSetHistoryCommitmentInput = {
		exactCanonicalEpochAnchorPreimageBytes: anchorBytes,
		vertices,
		frontier: [dependency],
		authenticatedCanonicalPreimageByteLengths: new Map(
			sources.map((source) => [source.vertexDigest, source.exactCanonicalPreimageBytes.byteLength])
		),
		maxEpochBytes: 8192,
		maxEpochVertices: 4,
		previousHistorySnapshot,
	};
	return { close, sources, keys };
}

describe("Phase 7 closed-epoch archive byte producer (unit scope)", () => {
	it("source-directed append captures exact immutable artifact identities and computes its target from the certified prefix", async () => {
		const first = fixture();
		const archive = await produceClosedEpochArchive({ close: first.close, sourceRecords: first.sources, limits: LIMITS });
		const plan = await deriveClosedEpochArchiveAppend({ archive, expectedPreviousRoot: hex(EMPTY_MERKLE_ROOT),
			previousSnapshot: new CompactMerkleAccumulator().snapshot(), previousEndOrdinal: -1, limits: LIMITS });
		expect(plan.binding).toMatchObject({ objectId: archive.objectId, sourceEpoch: 0,
			sourceAnchorDigest: archive.sourceAnchorDigest, sourceCloseSetRoot: archive.closeSetRoot,
			sourceHistoryRoot: archive.historyRoot, previousHistorySize: 0, historySize: 2,
			previousIndexSize: 0, indexSize: 2, previousArchiveIndexRoot: hex(EMPTY_MERKLE_ROOT) });
		expect(plan.binding.targetArchiveIndexRoot).toBe(hex(CompactMerkleAccumulator.fromSnapshot(plan.snapshot).root()));
		const sourceChunk = archive.segments[0]!.chunks[0]!, retained = plan.artifacts.find(artifact => artifact.ref.kind === "chunk" && artifact.ref.digest === sourceChunk.digest)!;
		const exact = retained.bytes.slice();
		sourceChunk.bytes.fill(0);
		expect(retained.bytes).toEqual(exact);
		for (const artifact of plan.artifacts.filter(artifact => artifact.ref.kind === "index-entry"))
			expect(artifact.ref.digest).toBe(hex(hashDomain("ts-drp-storage/blob/v1", artifact.bytes)));
	});

	it("source-directed append continues a second whole epoch and refuses a substituted or incomplete source", async () => {
		const first = fixture();
		const archive0 = await produceClosedEpochArchive({ close: first.close, sourceRecords: first.sources, limits: LIMITS });
		const plan0 = await deriveClosedEpochArchiveAppend({ archive: archive0, expectedPreviousRoot: hex(EMPTY_MERKLE_ROOT),
			previousSnapshot: new CompactMerkleAccumulator().snapshot(), previousEndOrdinal: -1, limits: LIMITS });
		const tree = await buildMerkleTree(archive0.segments.map(segment => segment.exactCanonicalIndexEntryBytes));
		const previousLastEntry = { exactCanonicalEntryBytes: archive0.segments[1]!.exactCanonicalIndexEntryBytes,
			proof: inclusionProof(tree, 1) };
		const history = await deriveCloseSetHistoryCommitment(first.close);
		const second = fixture(1, history.historySnapshot, plan0.binding.targetArchiveIndexRoot);
		const archive1 = await produceClosedEpochArchive({ close: second.close, sourceRecords: second.sources, limits: LIMITS });
		const input = { archive: archive1, expectedPreviousRoot: plan0.binding.targetArchiveIndexRoot,
			previousSnapshot: plan0.snapshot, previousEndOrdinal: 1, previousLastEntry, limits: LIMITS };
		const plan1 = await deriveClosedEpochArchiveAppend(input);
		expect(plan1.binding).toMatchObject({ sourceEpoch: 1, previousHistorySize: 2, historySize: 4, previousIndexSize: 2, indexSize: 4 });
		await expect(deriveClosedEpochArchiveAppend({ ...input, archive: { ...archive1, sourceAnchorDigest: "f".repeat(64) } })).rejects.toThrow(/foreign/);
		await expect(deriveClosedEpochArchiveAppend({ ...input, archive: { ...archive1, segments: archive1.segments.slice(1) } })).rejects.toThrow(/incomplete|noncontiguous/);
		await expect(deriveClosedEpochArchiveAppend({ ...input, expectedPreviousRoot: "f".repeat(64) })).rejects.toThrow(/predecessor root/);
		await expect(deriveClosedEpochArchiveAppend({ ...input, previousLastEntry: undefined })).rejects.toThrow(/frontier/);
	});
	it("preserves every original source byte/signature, history order and exact encoded categories", async () => {
		const { close, sources, keys } = fixture();
		const archive = await produceClosedEpochArchive({ close, sourceRecords: [...sources].reverse(), limits: LIMITS });
		expect(archive.segments).toHaveLength(2);
		const restored = archive.segments.flatMap((segment) =>
			readArchiveSegment({
				exactCanonicalDescriptorBytes: segment.exactCanonicalDescriptorBytes,
				expectedSegmentDigest: segment.segmentDigest,
				chunks: new Map(segment.chunks.map((chunk) => [chunk.digest, chunk.bytes])),
				limits: LIMITS,
			})
		);
		expect(restored.map((entry) => entry.ordinal)).toEqual([0, 1]);
		for (const [index, entry] of restored.entries()) {
			expect(entry.exactCanonicalPreimageBytes).toEqual(sources[index]!.exactCanonicalPreimageBytes);
			expect(entry.detachedSignature).toEqual(sources[index]!.detachedSignature);
			expect(
				verify(
					null,
					digestReceivedVertexPreimage(entry.exactCanonicalPreimageBytes),
					keys[index]!.publicKey,
					entry.detachedSignature
				)
			).toBe(true);
		}
		expect(archive.encodedBytes.sourcePreimages).toBe(
			sources.reduce((sum, source) => sum + source.exactCanonicalPreimageBytes.byteLength, 0)
		);
		expect(archive.encodedBytes.sourceSignatures).toBe(128);
		expect(archive.encodedBytes.segmentPayloads).toBe(
			archive.segments.reduce(
				(sum, segment) => sum + segment.chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0),
				0
			)
		);
		expect(archive.encodedBytes.segmentDescriptors).toBe(
			archive.segments.reduce((sum, segment) => sum + segment.exactCanonicalDescriptorBytes.byteLength, 0)
		);
		expect(archive.encodedBytes.indexEntries).toBe(
			archive.segments.reduce((sum, segment) => sum + segment.exactCanonicalIndexEntryBytes.byteLength, 0)
		);
	});

	it("refuses missing/duplicate membership, projected operation changes and mismatched source byte census", async () => {
		const { close, sources } = fixture();
		await expect(produceClosedEpochArchive({ close, sourceRecords: sources.slice(1), limits: LIMITS })).rejects.toThrow(
			/keyset/
		);
		await expect(
			produceClosedEpochArchive({ close, sourceRecords: [sources[0]!, sources[0]!], limits: LIMITS })
		).rejects.toThrow(/duplicate/);
		const altered = new Map(close.vertices);
		altered.set(sources[0]!.vertexDigest, {
			...altered.get(sources[0]!.vertexDigest)!,
			operation: { kind: "altered" },
		});
		await expect(
			produceClosedEpochArchive({ close: { ...close, vertices: altered }, sourceRecords: sources, limits: LIMITS })
		).rejects.toThrow(/operation\/dependencies/);
		const charges = new Map(close.authenticatedCanonicalPreimageByteLengths);
		charges.set(sources[0]!.vertexDigest, charges.get(sources[0]!.vertexDigest)! - 1);
		await expect(
			produceClosedEpochArchive({
				close: { ...close, authenticatedCanonicalPreimageByteLengths: charges },
				sourceRecords: sources,
				limits: LIMITS,
			})
		).rejects.toThrow(/byte charges/);
	});

	it("rejects withheld, altered and substituted segment bytes before exposing records", async () => {
		const { close, sources } = fixture();
		const archive = await produceClosedEpochArchive({ close, sourceRecords: sources, limits: LIMITS });
		const segment = archive.segments[0]!;
		const chunks = new Map(segment.chunks.map((chunk) => [chunk.digest, chunk.bytes]));
		const request = {
			exactCanonicalDescriptorBytes: segment.exactCanonicalDescriptorBytes,
			expectedSegmentDigest: segment.segmentDigest,
			chunks,
			limits: LIMITS,
		};
		expect(() => readArchiveSegment({ ...request, chunks: new Map() })).toThrow(/missing/);
		const altered = new Map(chunks);
		const bytes = new Uint8Array(segment.chunks[0]!.bytes);
		bytes[0] ^= 1;
		altered.set(segment.chunks[0]!.digest, bytes);
		expect(() => readArchiveSegment({ ...request, chunks: altered })).toThrow(/digest/);
		expect(() => readArchiveSegment({ ...request, expectedSegmentDigest: archive.segments[1]!.segmentDigest })).toThrow(
			/descriptor digest/
		);
	});

	it("extends a compact multi-epoch index and verifies demand-page descriptor inclusion", async () => {
		const first = fixture();
		const archive0 = await produceClosedEpochArchive({
			close: first.close,
			sourceRecords: first.sources,
			limits: LIMITS,
		});
		const index0 = await appendArchiveIndex({
			objectId: archive0.objectId,
			expectedPreviousRoot: hex(EMPTY_MERKLE_ROOT),
			previousSnapshot: new CompactMerkleAccumulator().snapshot(),
			previousEndOrdinal: -1,
			segments: archive0.segments,
			limits: LIMITS,
		});
		const history0 = await deriveCloseSetHistoryCommitment(first.close);
		const second = fixture(1, history0.historySnapshot, index0.root);
		const archive1 = await produceClosedEpochArchive({
			close: second.close,
			sourceRecords: second.sources,
			limits: LIMITS,
		});
		const priorTree = await buildMerkleTree(archive0.segments.map((segment) => segment.exactCanonicalIndexEntryBytes));
		const previousLastEntry = {
			exactCanonicalEntryBytes: archive0.segments[1]!.exactCanonicalIndexEntryBytes,
			proof: inclusionProof(priorTree, 1),
		};
		const index1 = await appendArchiveIndex({
			objectId: archive1.objectId,
			expectedPreviousRoot: index0.root,
			previousSnapshot: index0.snapshot,
			previousEndOrdinal: 1,
			previousLastEntry,
			segments: archive1.segments,
			limits: LIMITS,
		});
		const leaves = [...archive0.segments, ...archive1.segments].map((segment) => segment.exactCanonicalIndexEntryBytes);
		const independentTree = await buildMerkleTree(leaves);
		expect(index1.root).toBe(hex(independentTree.root));
		expect(index1.snapshot.size).toBe(4);
		expect(verifyArchiveIndexEntry(leaves[0]!, inclusionProof(independentTree, 0), index1.root)).toBe(true);
		expect(verifyArchiveIndexEntry(leaves[1]!, inclusionProof(independentTree, 0), index1.root)).toBe(false);
		await expect(
			appendArchiveIndex({
				objectId: archive0.objectId,
				expectedPreviousRoot: index1.root,
				previousSnapshot: index0.snapshot,
				previousEndOrdinal: 1,
				previousLastEntry,
				segments: archive1.segments,
				limits: LIMITS,
			})
		).rejects.toThrow(/predecessor root/);
		await expect(
			appendArchiveIndex({
				objectId: archive0.objectId,
				expectedPreviousRoot: index0.root,
				previousSnapshot: index0.snapshot,
				previousEndOrdinal: 1,
				previousLastEntry,
				segments: archive0.segments,
				limits: LIMITS,
			})
		).rejects.toThrow(/noncontiguous/);
		// Frozen registered descriptors contain no new final Cut/QC: the source context stays in original preimages.
		const descriptor = decodeCanonical(archive1.segments[0]!.exactCanonicalDescriptorBytes) as Record<string, unknown>;
		expect(Object.hasOwn(descriptor, "cutDigest")).toBe(false);
		expect(Object.hasOwn(descriptor, "qcDigest")).toBe(false);
	});

	it("refuses explicit segment/chunk ceilings without producing any effect", async () => {
		const { close, sources } = fixture();
		await expect(
			produceClosedEpochArchive({ close, sourceRecords: sources, limits: { ...LIMITS, maxSegments: 1 } })
		).rejects.toThrow(/segment capacity/);
		await expect(
			produceClosedEpochArchive({ close, sourceRecords: sources, limits: { ...LIMITS, maxChunks: 1 } })
		).rejects.toThrow(/chunk capacity/);
	});
});
