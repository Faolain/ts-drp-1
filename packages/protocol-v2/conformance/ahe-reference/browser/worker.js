import { encodeCanonical } from "../src/canonical.js";
import { CompactMerkleAccumulator } from "../src/ct-merkle.js";
import { createEpochAnchor } from "../src/protocol.js";
import { topologicalOrder } from "../src/linearize.js";
import { buildSnapshotChunks } from "../src/snapshot.js";

const H = (value) => Number(value).toString(16).padStart(64, "0");
const encoder = new TextEncoder();

function makeGraph(anchor, count) {
  const vertices = new Map([[anchor.hash, anchor]]);
  const hashes = [anchor.hash];
  for (let index = 1; index <= count; index++) {
    const hash = H(index + 50_000);
    const parent = hashes[Math.floor((index - 1) / 2)];
    vertices.set(hash, {
      kind: "drp-vertex",
      protocolMajor: 2,
      objectId: anchor.objectId,
      epoch: anchor.epoch,
      anchor: anchor.hash,
      author: `peer-${index % 16}`,
      logicalTime: Math.floor(Math.log2(index)) + 1,
      dependencies: [parent],
      operation: { type: "add", value: 1 },
      hash,
    });
    hashes.push(hash);
  }
  return vertices;
}

self.onmessage = async () => {
  try {
    const state = {
      messages: Array.from({ length: 5000 }, (_, index) => ({
        id: H(index + 1000),
        author: `peer-${index % 64}`,
        text: `browser-message-${index}-` + "x".repeat(48),
        reactions: new Set(index % 19 === 0 ? ["ok", "seen"] : []),
      })),
    };
    let start = performance.now();
    const bytes = encodeCanonical(state);
    const encodeMs = performance.now() - start;

    start = performance.now();
    const chunks = await buildSnapshotChunks(bytes, { chunkSize: 128 * 1024 });
    const chunkMs = performance.now() - start;

    const anchor = await createEpochAnchor({
      objectId: "browser-room",
      epoch: 4,
      stateDigest: H(1),
      aclDigest: H(2),
      historyRoot: H(3),
      historySize: 100_000,
    });
    const graph = makeGraph(anchor, 4096);
    start = performance.now();
    const order = topologicalOrder(graph, anchor.hash);
    const linearizeMs = performance.now() - start;

    start = performance.now();
    const accumulator = new CompactMerkleAccumulator();
    for (let index = 0; index < 2048; index++) {
      await accumulator.append(encoder.encode(`leaf-${index}`));
    }
    const merkleMs = performance.now() - start;

    self.postMessage({
      ok: true,
      encodedBytes: bytes.byteLength,
      chunks: chunks.length,
      orderLength: order.length,
      compactMerklePeaks: accumulator.snapshot().peaks.filter(Boolean).length,
      timings: { encodeMs, chunkMs, linearizeMs, merkleMs },
    });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.stack ?? String(error) });
  }
};
