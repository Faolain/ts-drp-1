import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { encodeCanonical } from "../src/canonical.js";
import { buildArchiveIndex, buildArchiveSegment, verifyArchiveSegment } from "../src/archive.js";
import { buildMerkleTree, CompactMerkleAccumulator } from "../src/ct-merkle.js";
import { bytesToHex } from "../src/hash.js";
import { foldEpoch } from "../src/fold.js";
import { topologicalOrder } from "../src/linearize.js";
import { createEpochAnchor } from "../src/protocol.js";
import { buildSnapshotChunks, snapshotManifest, verifyAndAssembleSnapshot } from "../src/snapshot.js";
import { DeterministicStateMachine, stateDigest } from "../src/state.js";

const H = (value) => Number(value).toString(16).padStart(64, "0");
const encoder = new TextEncoder();

async function measure(name, operation, { iterations = 5, warmup = 1 } = {}) {
  for (let index = 0; index < warmup; index++) await operation();
  const values = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    name,
    iterations,
    minMs: Number(sorted[0].toFixed(3)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
  };
}

function makeState(messageCount) {
  return {
    room: { name: "browser-first-benchmark", topic: "hard epoch compaction" },
    members: new Map(Array.from({ length: 128 }, (_, index) => [`peer-${index}`, { role: index < 4 ? "moderator" : "member" }])),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: H(index + 100),
      author: `peer-${index % 128}`,
      logicalTime: index + 1,
      text: `message-${index}-` + "x".repeat(48),
      reactions: new Set(index % 17 === 0 ? ["ok", "seen"] : []),
    })),
  };
}

function makeEpochGraph(anchor, count) {
  const vertices = new Map([[anchor.hash, anchor]]);
  const hashes = [anchor.hash];
  for (let index = 1; index <= count; index++) {
    const hash = H(index + 10_000);
    // One-parent graph is enough to price deterministic graph traversal while avoiding
    // any accidental non-antichain direct dependency.
    const parent = hashes[Math.floor((index - 1) / 2)];
    const logicalTime = Math.floor(Math.log2(index)) + 1;
    const vertex = Object.freeze({
      kind: "drp-vertex",
      protocolMajor: 2,
      objectId: anchor.objectId,
      epoch: anchor.epoch,
      anchor: anchor.hash,
      author: `peer-${index % 32}`,
      logicalTime,
      dependencies: Object.freeze([parent]),
      operation: Object.freeze({ type: "add", value: 1 }),
      hash,
    });
    vertices.set(hash, vertex);
    hashes.push(hash);
  }
  return vertices;
}

const state = makeState(10_000);
let encodedState;
const anchor = await createEpochAnchor({
  objectId: "benchmark-room",
  epoch: 12,
  stateDigest: H(1),
  aclDigest: H(2),
  historyRoot: H(3),
  historySize: 1_000_000,
});
const graph = makeEpochGraph(anchor, 8192);
const foldGraph = new Map([...graph].slice(0, 4097));

const metrics = [];
metrics.push(
  await measure("canonical_encode_10000_messages", async () => {
    encodedState = encodeCanonical(state);
  })
);
encodedState = encodeCanonical(state);
metrics.push(
  await measure("state_sha256_10000_messages", async () => {
    await stateDigest(state);
  })
);
metrics.push(
  await measure("snapshot_chunk_and_hash", async () => {
    const chunks = await buildSnapshotChunks(encodedState, { chunkSize: 128 * 1024 });
    await snapshotManifest({
      objectId: "benchmark-room",
      epoch: 12,
      anchor: anchor.hash,
      stateDigest: H(4),
      aclDigest: H(5),
      chunks,
    });
  }, { iterations: 3, warmup: 0 })
);
const chunks = await buildSnapshotChunks(encodedState, { chunkSize: 128 * 1024 });
const manifest = await snapshotManifest({
  objectId: "benchmark-room",
  epoch: 12,
  anchor: anchor.hash,
  stateDigest: H(4),
  aclDigest: H(5),
  chunks,
});
const chunkMap = new Map(chunks.map((chunk) => [chunk.digest, chunk.bytes]));
metrics.push(
  await measure("snapshot_verify_and_assemble", async () => {
    await verifyAndAssembleSnapshot(manifest, chunkMap);
  }, { iterations: 3, warmup: 0 })
);

async function buildChatArchive() {
  const segments = [];
  for (let offset = 0; offset < state.messages.length; offset += 1000) {
    segments.push(
      await buildArchiveSegment({
        objectId: "benchmark-room",
        epoch: 12,
        startOrdinal: offset,
        records: state.messages.slice(offset, offset + 1000),
        chunkSize: 128 * 1024,
      })
    );
  }
  const index = await buildArchiveIndex(segments.map((segment) => segment.descriptor));
  return { segments, index };
}
metrics.push(
  await measure("archive_segment_and_index_10000_messages", async () => {
    await buildChatArchive();
  }, { iterations: 3, warmup: 0 })
);
const chatArchive = await buildChatArchive();
const archiveSegment = chatArchive.segments[0];
const archiveChunks = new Map(archiveSegment.chunks.map((chunk) => [chunk.digest, chunk.bytes]));
metrics.push(
  await measure("archive_verify_1000_messages", async () => {
    await verifyArchiveSegment(archiveSegment.descriptor, archiveChunks);
  }, { iterations: 3, warmup: 0 })
);

const leaves = Array.from({ length: 8192 }, (_, index) => encoder.encode(`history-${index}-${H(index)}`));
metrics.push(
  await measure("merkle_materialize_8192", async () => {
    await buildMerkleTree(leaves, { batchSize: 256 });
  }, { iterations: 3, warmup: 0 })
);
metrics.push(
  await measure("merkle_compact_accumulator_8192", async () => {
    const accumulator = new CompactMerkleAccumulator();
    for (const leaf of leaves) await accumulator.append(leaf);
    await accumulator.root();
  }, { iterations: 3, warmup: 0 })
);
metrics.push(
  await measure("kahn_linearize_8192", async () => {
    topologicalOrder(graph, anchor.hash);
  }, { iterations: 5, warmup: 1 })
);

const application = new DeterministicStateMachine({
  initialState: { total: 0 },
  reduce(draft, operation) {
    draft.total += operation.value;
  },
});
const acl = new DeterministicStateMachine({
  initialState: { writers: new Set(Array.from({ length: 32 }, (_, index) => `peer-${index}`)) },
  reduce() {},
});
metrics.push(
  await measure("fold_4096_vertices", async () => {
    await foldEpoch({
      vertices: foldGraph,
      anchorHash: anchor.hash,
      application,
      acl,
      authorize(vertex, plane, epochAcl) {
        return plane === "system" || epochAcl.writers.has(vertex.author);
      },
    });
  }, { iterations: 3, warmup: 0 })
);

const accumulator = new CompactMerkleAccumulator();
for (const leaf of leaves) await accumulator.append(leaf);
const result = {
  environment: {
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  inputs: {
    messages: 10_000,
    canonicalStateBytes: encodedState.byteLength,
    snapshotChunks: chunks.length,
    snapshotChunkBytes: 128 * 1024,
    archiveSegments: chatArchive.segments.length,
    archiveIndexRoot: chatArchive.index.root,
    activeVertices: graph.size,
    foldVertices: foldGraph.size,
    merkleLeaves: leaves.length,
    compactMerklePeaks: accumulator.snapshot().peaks.filter(Boolean).length,
    compactMerkleRoot: bytesToHex(await accumulator.root()),
  },
  metrics,
  memory: {
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    externalBytes: process.memoryUsage().external,
  },
};
const output = new URL("../../results/node-benchmark.json", import.meta.url);
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
