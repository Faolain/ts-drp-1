import test from "node:test";
import assert from "node:assert/strict";

import {
  CanonicalEncodingError,
  bytesEqual,
  decodeCanonical,
  encodeCanonical,
  legacySnapshotRecord,
} from "../src/canonical.js";
import { bytesToHex } from "../src/hash.js";
import {
  buildMerkleTree,
  CompactMerkleAccumulator,
  consistencyProof,
  inclusionProof,
  verifyConsistency,
  verifyInclusion,
} from "../src/ct-merkle.js";
import {
  computeCutDigest,
  createAnchorFromCut,
  createEpochAnchor,
  createUnsignedVertex,
  cutDescriptorPreimage,
  historyLeafInput,
  parametersDigest,
  signerSetDigest,
  ZERO_DIGEST,
} from "../src/protocol.js";
import { classifyVertex, PendingPool } from "../src/admission.js";
import { DeterministicStateMachine, replaceEnumerableState, stateDigest } from "../src/state.js";
import { FoldError, foldEpoch } from "../src/fold.js";
import { CausalityIndex, linearizeEpoch, LinearizationError, topologicalOrder } from "../src/linearize.js";
import {
  buildSnapshotChunks,
  encodeSnapshotPayload,
  snapshotManifest,
  snapshotPayloadDigest,
  verifyAndAssembleSnapshot,
  verifyAndDecodeSnapshot,
} from "../src/snapshot.js";
import { buildQC, quorumSize, SealProtocolError, SealSignerState, verifyQC } from "../src/seal.js";
import {
  archiveIndexProof,
  buildArchiveIndex,
  buildArchiveSegment,
  verifyArchiveIndexEntry,
  verifyArchiveSegment,
} from "../src/archive.js";

const H = (value) => Number(value).toString(16).padStart(64, "0");

async function makeAnchor(objectId = "room", epoch = 1, suffix = epoch) {
  return createEpochAnchor({
    objectId,
    epoch,
    previousAnchor: epoch === 0 ? ZERO_DIGEST : H(1000 + suffix),
    cutDigest: H(2000 + suffix),
    stateDigest: H(3000 + suffix),
    aclDigest: H(4000 + suffix),
    historyRoot: H(5000 + suffix),
    historySize: epoch * 10,
    signerSetDigest: H(6000 + suffix),
    parametersDigest: H(7000 + suffix),
  });
}

const fakeSignature = (vote) =>
  `sig:${vote.signerId}:${vote.objectId}:${vote.epoch}:${vote.round}:${vote.phase}:${vote.proposalDigest}:${vote.proposalHash}`;
const signVote = (vote) => ({ ...vote, signature: fakeSignature(vote) });
const verifyFakeSignature = (vote) => vote.signature === fakeSignature(vote);

test("canonical encoding ignores object/map/set insertion order", () => {
  const left = {
    z: new Set(["b", "a"]),
    a: new Map([
      ["z", 1],
      ["a", 2],
    ]),
    bytes: Uint8Array.of(3, 2, 1),
    physics: new Float32Array([1.25, -2.5]),
  };
  const right = Object.create(null);
  right.physics = new Float32Array([1.25, -2.5]);
  right.bytes = Uint8Array.of(3, 2, 1);
  right.a = new Map([
    ["a", 2],
    ["z", 1],
  ]);
  right.z = new Set(["a", "b"]);
  assert.ok(bytesEqual(encodeCanonical(left), encodeCanonical(right)));
  const decoded = decodeCanonical(encodeCanonical(left));
  assert.equal(decoded.a.get("a"), 2);
  assert.deepEqual([...decoded.z], ["a", "b"]);
  assert.deepEqual([...decoded.physics], [1.25, -2.5]);
  assert.equal(Object.getPrototypeOf(decoded), null);
});

test("canonical domain rejects ambiguous and executable values without invoking getters", () => {
  assert.throws(() => encodeCanonical({ bad: undefined }), CanonicalEncodingError);
  assert.throws(() => encodeCanonical({ bad: Number.NaN }), CanonicalEncodingError);
  assert.throws(() => encodeCanonical({ bad: 1n }), CanonicalEncodingError);
  assert.throws(() => encodeCanonical({ bad: "\ud800" }), /surrogate/);
  assert.throws(() => encodeCanonical({ bad: Number.MAX_SAFE_INTEGER + 1 }), /safe/);
  assert.ok(bytesEqual(encodeCanonical(-0), encodeCanonical(0)));
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => encodeCanonical(cycle), /cyclic/);
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  assert.throws(() => encodeCanonical(accessor), /accessor/);
  assert.equal(reads, 0);
  assert.throws(() => encodeCanonical(new Date()), /explicit protocol codec/);
  assert.throws(
    () =>
      encodeCanonical(
        new Map([
          [{ a: 1 }, "left"],
          [{ a: 1 }, "right"],
        ])
      ),
    /duplicate canonical keys/
  );
});

test("canonical decoder rejects non-minimal, non-canonical, and trailing wire encodings", () => {
  assert.throws(() => decodeCanonical(Uint8Array.of(0x03, 0x80, 0x00)), /non-minimal/);
  const floatInteger = new Uint8Array(9);
  floatInteger[0] = 0x04;
  new DataView(floatInteger.buffer).setFloat64(1, 1, false);
  assert.throws(() => decodeCanonical(floatInteger), /integer tag/);
  assert.throws(() => decodeCanonical(Uint8Array.of(0xff)), /unknown canonical tag/);
  assert.throws(() => decodeCanonical(Uint8Array.of(0x00, 0x00)), /trailing/);
});

test("legacy snapshot excludes replica-local context and replacement deletes phantom keys", () => {
  const target = { context: { caller: "peer-a" }, keep: 1, deleted: 2 };
  const snapshot = legacySnapshotRecord({ context: { caller: "peer-b" }, keep: 3 });
  assert.equal("context" in snapshot, false);
  replaceEnumerableState(target, snapshot);
  assert.deepEqual(target.context, { caller: "peer-a" });
  assert.equal(target.keep, 3);
  assert.equal("deleted" in target, false);
});

test("deterministic reducer rejects async execution and stages batches atomically", async () => {
  const machine = new DeterministicStateMachine({
    initialState: { count: 0 },
    reduce(state, operation) {
      if (operation.fail) throw new Error("boom");
      state.count += operation.delta;
    },
  });
  machine.apply({ delta: 2 }, { author: "p" });
  assert.equal(machine.snapshot().count, 2);
  assert.equal(await machine.digest(), await stateDigest({ count: 2 }));
  assert.throws(
    () => machine.applyBatch([{ operation: { delta: 3 } }, { operation: { delta: 0, fail: true } }]),
    /boom/
  );
  assert.equal(machine.snapshot().count, 2);
  const asyncMachine = new DeterministicStateMachine({ initialState: {}, reduce: async () => ({}) });
  assert.throws(() => asyncMachine.apply({}, {}), /synchronous/);
});

test("RFC 9162-style Merkle inclusion proofs verify and detect tampering", async () => {
  const leaves = Array.from({ length: 37 }, (_, index) => new TextEncoder().encode(`leaf-${index}`));
  const tree = await buildMerkleTree(leaves, { batchSize: 8 });
  for (let index = 0; index < leaves.length; index++) {
    const proof = await inclusionProof(tree, index);
    assert.equal(await verifyInclusion(leaves[index], proof, tree.root), true, `proof ${index}`);
  }
  const bad = await inclusionProof(tree, 3);
  bad.auditPath[0] = new Uint8Array(32);
  assert.equal(await verifyInclusion(leaves[3], bad, tree.root), false);
});

test("RFC 9162-style consistency proofs verify exhaustively for append histories", async () => {
  const leaves = Array.from({ length: 40 }, (_, index) => new TextEncoder().encode(`entry-${index}`));
  const trees = [await buildMerkleTree([])];
  for (let size = 1; size <= leaves.length; size++) trees.push(await buildMerkleTree(leaves.slice(0, size)));
  for (let second = 1; second <= leaves.length; second++) {
    for (let first = 0; first <= second; first++) {
      const proof = await consistencyProof(trees[second], first);
      assert.equal(
        await verifyConsistency(first, second, trees[first].root, trees[second].root, proof.path),
        true,
        `${first}->${second}`
      );
    }
  }
  const proof = await consistencyProof(trees[40], 17);
  proof.path[0] = new Uint8Array(32);
  assert.equal(await verifyConsistency(17, 40, trees[17].root, trees[40].root, proof.path), false);
});

test("compact Merkle accumulator matches materialized roots with O(log n) retained peaks", async () => {
  const leaves = Array.from({ length: 65 }, (_, index) => new TextEncoder().encode(`v-${index}`));
  const accumulator = new CompactMerkleAccumulator();
  for (let size = 1; size <= leaves.length; size++) {
    await accumulator.append(leaves[size - 1]);
    const full = await buildMerkleTree(leaves.slice(0, size));
    assert.equal(bytesToHex(await accumulator.root()), bytesToHex(full.root), `size=${size}`);
  }
  const restored = CompactMerkleAccumulator.fromSnapshot(accumulator.snapshot());
  assert.equal(bytesToHex(await restored.root()), bytesToHex(await accumulator.root()));
  assert.ok(restored.snapshot().peaks.filter(Boolean).length <= Math.ceil(Math.log2(leaves.length + 1)));
});

test("vertex hash is separated by room, protocol, epoch, and anchor", async () => {
  const common = {
    epoch: 1,
    anchor: H(11),
    author: "peer-a",
    logicalTime: 1,
    dependencies: [H(11)],
    operation: { type: "message", text: "hello" },
  };
  const a = await createUnsignedVertex({ ...common, objectId: "room-a" });
  const b = await createUnsignedVertex({ ...common, objectId: "room-b" });
  const c = await createUnsignedVertex({ ...common, objectId: "room-a", anchor: H(22), dependencies: [H(22)] });
  const d = await createUnsignedVertex({ ...common, objectId: "room-a", epoch: 2 });
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.notEqual(a.hash, d.hash);
});

test("cut descriptors chain state/history/configuration and deterministically derive next anchor", async () => {
  const descriptor = {
    objectId: "room",
    epoch: 4,
    round: 2,
    previousAnchor: H(1),
    previousCutDigest: H(2),
    previousHistoryRoot: H(3),
    previousHistorySize: 10,
    closeSetRoot: H(4),
    closeSetCount: 3,
    historyRoot: H(5),
    historySize: 13,
    stateDigest: H(6),
    aclDigest: H(7),
    snapshotManifestDigest: H(8),
    blueprintDigest: H(9),
    nextSignerSet: ["d", "b", "a", "c"],
    parameters: { maxEpochVertices: 4096, maxEpochBytes: 8_000_000, maxDependencies: 16, snapshotChunkBytes: 131072 },
  };
  const canonical = cutDescriptorPreimage(descriptor);
  assert.deepEqual(canonical.nextSignerSet.map((entry) => entry.signerId), ["a", "b", "c", "d"]);
  assert.equal(await computeCutDigest(descriptor), await computeCutDigest({ ...descriptor, nextSignerSet: ["a", "b", "c", "d"] }));
  assert.throws(() => cutDescriptorPreimage({ ...descriptor, historySize: 14 }), /history size/);
  const anchor = await createAnchorFromCut(descriptor);
  assert.equal(anchor.epoch, 5);
  assert.equal(anchor.cutDigest, await computeCutDigest(descriptor));
  assert.equal(anchor.signerSetDigest, await signerSetDigest(descriptor.nextSignerSet));
  assert.equal(anchor.parametersDigest, await parametersDigest(descriptor.parameters));
});

test("hard-epoch admission makes stale history objectively terminal without a covered-hash set", async () => {
  const anchor = await makeAnchor("room", 3);
  const active = new Map([[anchor.hash, anchor]]);
  const current = await createUnsignedVertex({
    objectId: "room",
    epoch: 3,
    anchor: anchor.hash,
    author: "peer-a",
    logicalTime: 1,
    dependencies: [anchor.hash],
    operation: { type: "message" },
  });
  const context = {
    objectId: "room",
    protocolMajor: 2,
    currentEpoch: 3,
    currentAnchor: anchor.hash,
    parameters: { maxDependencies: 16 },
    activeVertices: active,
    batchVertices: new Map(),
    suppliedDependencies: new Map(),
    isAncestor: () => false,
  };
  assert.equal((await classifyVertex(current, context)).status, "accept");
  const stale = await createUnsignedVertex({ ...current, epoch: 2, anchor: H(77), dependencies: [H(77)] });
  const staleResult = await classifyVertex(stale, context);
  assert.deepEqual([staleResult.status, staleResult.code], ["terminal", "STALE_EPOCH"]);
  const wrongAnchor = await createUnsignedVertex({ ...current, anchor: H(78), dependencies: [H(78)] });
  assert.equal((await classifyVertex(wrongAnchor, context)).code, "WRONG_ANCHOR");
});

test("unknown current-epoch dependencies remain schedule-independent pending and later apply", async () => {
  const anchor = await makeAnchor("room", 2);
  const parent = await createUnsignedVertex({
    objectId: "room",
    epoch: 2,
    anchor: anchor.hash,
    author: "p",
    logicalTime: 1,
    dependencies: [anchor.hash],
    operation: { id: "parent" },
  });
  const child = await createUnsignedVertex({
    objectId: "room",
    epoch: 2,
    anchor: anchor.hash,
    author: "p",
    logicalTime: 2,
    dependencies: [parent.hash],
    operation: { id: "child" },
  });
  const active = new Map([[anchor.hash, anchor]]);
  const base = {
    objectId: "room",
    protocolMajor: 2,
    currentEpoch: 2,
    currentAnchor: anchor.hash,
    parameters: { maxDependencies: 16 },
    activeVertices: active,
    batchVertices: new Map(),
    suppliedDependencies: new Map(),
    isAncestor: () => false,
  };
  assert.deepEqual(await classifyVertex(child, base), await classifyVertex(child, base));
  assert.equal((await classifyVertex(child, base)).status, "pending");
  active.set(parent.hash, parent);
  assert.equal((await classifyVertex(child, base)).status, "accept");
});

test("admission rejects non-antichain direct dependencies", async () => {
  const anchor = await makeAnchor("room", 5);
  const a = await createUnsignedVertex({ objectId: "room", epoch: 5, anchor: anchor.hash, author: "p", logicalTime: 1, dependencies: [anchor.hash], operation: { id: "a" } });
  const b = await createUnsignedVertex({ objectId: "room", epoch: 5, anchor: anchor.hash, author: "p", logicalTime: 2, dependencies: [a.hash], operation: { id: "b" } });
  const c = await createUnsignedVertex({ objectId: "room", epoch: 5, anchor: anchor.hash, author: "p", logicalTime: 3, dependencies: [a.hash, b.hash], operation: { id: "c" } });
  const context = {
    objectId: "room",
    protocolMajor: 2,
    currentEpoch: 5,
    currentAnchor: anchor.hash,
    parameters: { maxDependencies: 16 },
    activeVertices: new Map([[anchor.hash, anchor], [a.hash, a], [b.hash, b]]),
    batchVertices: new Map(),
    suppliedDependencies: new Map(),
    isAncestor(left, right) { return left === a.hash && right === b.hash; },
  };
  assert.equal((await classifyVertex(c, context)).code, "NON_ANTICHAIN_DEPENDENCIES");
});

test("pending pool bounds memory without converting eviction into semantic invalidity", () => {
  const pool = new PendingPool({ maxEntries: 2, maxBytes: 10, maxPerPeer: 2 });
  assert.equal(pool.add("a", "p", 1, 4).stored, true);
  assert.equal(pool.add("b", "p", 2, 4).stored, true);
  assert.equal(pool.add("peer-limit", "p", 9, 1).stored, false);
  const result = pool.add("c", "q", 3, 4);
  assert.deepEqual(result.evicted, ["a"]);
  assert.equal(pool.stats().entries, 2);
  assert.equal(pool.take("a"), undefined);
});

test("deterministic Kahn linearization ignores map insertion order and exposes causality", async () => {
  const anchor = await makeAnchor("room", 7);
  const a = await createUnsignedVertex({ objectId: "room", epoch: 7, anchor: anchor.hash, author: "p", logicalTime: 1, dependencies: [anchor.hash], operation: { id: "a" } });
  const b = await createUnsignedVertex({ objectId: "room", epoch: 7, anchor: anchor.hash, author: "q", logicalTime: 1, dependencies: [anchor.hash], operation: { id: "b" } });
  const c = await createUnsignedVertex({ objectId: "room", epoch: 7, anchor: anchor.hash, author: "p", logicalTime: 2, dependencies: [a.hash, b.hash], operation: { id: "c" } });
  const first = new Map([[anchor.hash, anchor], [a.hash, a], [b.hash, b], [c.hash, c]]);
  const second = new Map([[c.hash, c], [b.hash, b], [anchor.hash, anchor], [a.hash, a]]);
  assert.deepEqual(topologicalOrder(first, anchor.hash), topologicalOrder(second, anchor.hash));
  const order = topologicalOrder(first, anchor.hash);
  const causality = new CausalityIndex(first, order);
  assert.equal(causality.areRelated(a.hash, c.hash), true);
  assert.equal(causality.areRelated(a.hash, b.hash), false);
  assert.deepEqual(linearizeEpoch({ vertices: first, anchorHash: anchor.hash }).map((vertex) => vertex.hash), order.slice(1));
});

test("linearizer fails closed on missing ancestors, multiple roots, cycles, and related deps", async () => {
  const anchor = await makeAnchor("room", 8);
  const missing = { hash: H(20), kind: "drp-vertex", objectId: "room", epoch: 8, anchor: anchor.hash, dependencies: [H(999)], logicalTime: 1, operation: {} };
  assert.throws(
    () => topologicalOrder(new Map([[anchor.hash, anchor], [missing.hash, missing]]), anchor.hash),
    (error) => error instanceof LinearizationError && error.code === "MISSING_DEPENDENCY"
  );
  const root = { ...missing, hash: H(21), dependencies: [] };
  assert.throws(() => topologicalOrder(new Map([[anchor.hash, anchor], [root.hash, root]]), anchor.hash), /no dependencies/);
  const a = { ...missing, hash: H(22), dependencies: [H(23)] };
  const b = { ...missing, hash: H(23), dependencies: [a.hash] };
  assert.throws(() => topologicalOrder(new Map([[anchor.hash, anchor], [a.hash, a], [b.hash, b]]), anchor.hash), /cycle/);
});

test("pair conflict resolution is deterministic and detects non-convergent swap policies", async () => {
  const anchor = await makeAnchor("room", 9);
  const a = await createUnsignedVertex({ objectId: "room", epoch: 9, anchor: anchor.hash, author: "p", logicalTime: 1, dependencies: [anchor.hash], operation: { key: "x" } });
  const b = await createUnsignedVertex({ objectId: "room", epoch: 9, anchor: anchor.hash, author: "q", logicalTime: 1, dependencies: [anchor.hash], operation: { key: "x" } });
  const vertices = new Map([[anchor.hash, anchor], [a.hash, a], [b.hash, b]]);
  const kept = linearizeEpoch({
    vertices,
    anchorHash: anchor.hash,
    mode: "pair",
    resolveConflicts: ([left, right]) => (left.hash < right.hash ? { action: "DropRight" } : { action: "DropLeft" }),
  });
  assert.equal(kept.length, 1);
  assert.throws(
    () => linearizeEpoch({ vertices, anchorHash: anchor.hash, mode: "pair", maxPasses: 4, resolveConflicts: () => ({ action: "Swap" }) }),
    /did not converge/
  );
});

test("hard-epoch fold latches authority, stages reducers, and adopts with one pointer transition", async () => {
  const anchor = await makeAnchor("room", 10);
  const grant = await createUnsignedVertex({ objectId: "room", epoch: 10, anchor: anchor.hash, author: "admin", logicalTime: 1, dependencies: [anchor.hash], operation: { plane: "acl", type: "grant", peer: "new-writer" } });
  const unauthorized = await createUnsignedVertex({ objectId: "room", epoch: 10, anchor: anchor.hash, author: "new-writer", logicalTime: 2, dependencies: [grant.hash], operation: { plane: "application", type: "add", value: 1 } });
  const application = new DeterministicStateMachine({ initialState: { total: 0 }, reduce(state, operation) { state.total += operation.value; } });
  const acl = new DeterministicStateMachine({ initialState: { admins: new Set(["admin"]), writers: new Set(["admin"]) }, reduce(state, operation) { if (operation.type === "grant") state.writers.add(operation.peer); } });
  await assert.rejects(
    () => foldEpoch({
      vertices: new Map([[anchor.hash, anchor], [grant.hash, grant], [unauthorized.hash, unauthorized]]),
      anchorHash: anchor.hash,
      application,
      acl,
      authorize(vertex, plane, epochAcl) { return plane === "acl" ? epochAcl.admins.has(vertex.author) : epochAcl.writers.has(vertex.author); },
    }),
    (error) => error instanceof FoldError && error.code === "UNAUTHORIZED"
  );
  assert.equal(application.snapshot().total, 0);
  assert.deepEqual([...acl.snapshot().writers], ["admin"]);
  const authorized = await createUnsignedVertex({ ...unauthorized, author: "admin" });
  const folded = await foldEpoch({
    vertices: new Map([[anchor.hash, anchor], [grant.hash, grant], [authorized.hash, authorized]]),
    anchorHash: anchor.hash,
    application,
    acl,
    authorize(vertex, plane, epochAcl) { return plane === "acl" ? epochAcl.admins.has(vertex.author) : epochAcl.writers.has(vertex.author); },
  });
  assert.equal(application.snapshot().total, 0);
  assert.equal(folded.applicationState.total, 1);
  folded.adopt();
  assert.equal(application.snapshot().total, 1);
  assert.equal(acl.snapshot().writers.has("new-writer"), true);
});

test("snapshot chunks, manifest, payload digest, and canonical state are verified end to end", async () => {
  const anchor = await makeAnchor("room", 11);
  const payloadValue = { application: { messages: Array.from({ length: 500 }, (_, index) => ({ id: index, text: `m-${index}` })) }, acl: { admins: new Set(["a"]) } };
  const bytes = await encodeSnapshotPayload({ ...payloadValue, objectId: "room", epoch: 11, anchor: anchor.hash });
  const chunks = await buildSnapshotChunks(bytes, { chunkSize: 16 * 1024 });
  const manifest = await snapshotManifest({
    objectId: "room",
    epoch: 11,
    anchor: anchor.hash,
    chunks,
    stateDigest: await stateDigest(payloadValue.application),
    aclDigest: await stateDigest(payloadValue.acl),
  });
  assert.equal(manifest.payloadDigest, await snapshotPayloadDigest(bytes));
  const map = new Map(chunks.map((chunk) => [chunk.digest, chunk.bytes]));
  assert.ok(bytesEqual(await verifyAndAssembleSnapshot(manifest, map), bytes));
  const decoded = await verifyAndDecodeSnapshot(manifest, map);
  assert.equal(decoded.application.messages.length, 500);
  const tampered = new Map(map);
  const firstDigest = chunks[0].digest;
  const first = new Uint8Array(chunks[0].bytes);
  first[0] ^= 1;
  tampered.set(firstDigest, first);
  await assert.rejects(() => verifyAndAssembleSnapshot(manifest, tampered), /chunk digest mismatch/);
});

test("archive segments let compact peers retain only an index root and fetch old history with proofs", async () => {
  const first = await buildArchiveSegment({
    objectId: "chat-room",
    epoch: 12,
    startOrdinal: 0,
    records: Array.from({ length: 40 }, (_, index) => ({ id: `m-${index}`, author: index % 2 ? "b" : "a", text: `message-${index}` })),
    chunkSize: 16 * 1024,
  });
  const second = await buildArchiveSegment({
    objectId: "chat-room",
    epoch: 13,
    startOrdinal: 40,
    records: Array.from({ length: 35 }, (_, index) => ({ id: `m-${40 + index}`, author: "c", text: `message-${40 + index}` })),
    chunkSize: 16 * 1024,
  });
  const index = await buildArchiveIndex([second.descriptor, first.descriptor]);
  assert.equal(index.totalRecords, 75);
  assert.equal(index.entries[0].startOrdinal, 0);
  const proof = await archiveIndexProof(index, 0);
  assert.equal(await verifyArchiveIndexEntry(index.entries[0], proof, index.root), true);
  assert.equal(await verifyArchiveIndexEntry({ ...index.entries[0], recordCount: 39 }, proof, index.root), false);

  const firstChunks = new Map(first.chunks.map((chunk) => [chunk.digest, chunk.bytes]));
  const records = await verifyArchiveSegment(first.descriptor, firstChunks);
  assert.equal(records.length, 40);
  assert.equal(records[17].id, "m-17");
  const tampered = new Map(firstChunks);
  const digest = first.chunks[0].digest;
  const bytes = new Uint8Array(first.chunks[0].bytes);
  bytes[bytes.length - 1] ^= 1;
  tampered.set(digest, bytes);
  await assert.rejects(() => verifyArchiveSegment(first.descriptor, tampered), /chunk digest mismatch/);
});

test("seal votes are signed, value-bound, quorum-checked, lock-safe, and non-retroactive", async () => {
  const signers = ["a", "b", "c", "d"];
  assert.equal(quorumSize(signers.length), 3);
  const states = new Map(signers.map((signerId) => [signerId, new SealSignerState({ objectId: "room", epoch: 1, signerId, validateProposal: async () => true })]));
  const proposal = { objectId: "room", epoch: 1, round: 0, digest: H(111), proposalHash: H(112), validRound: -1 };
  const prepares = [];
  for (const signerId of signers.slice(0, 3)) prepares.push(signVote(await states.get(signerId).prepareVote(proposal)));
  const prepareQC = await buildQC(prepares, signers, verifyFakeSignature);
  await verifyQC(prepareQC, signers, verifyFakeSignature, { phase: "prepare", proposalDigest: proposal.digest });
  const commits = [];
  for (const signerId of signers.slice(0, 3)) commits.push(signVote(await states.get(signerId).commitVote(prepareQC, { signerSet: signers, verifySignature: verifyFakeSignature })));
  const commitQC = await buildQC(commits, signers, verifyFakeSignature);
  assert.equal(await states.get("a").observeCommitQC(commitQC, { signerSet: signers, verifySignature: verifyFakeSignature }), proposal.digest);
  const forged = { ...prepares[0], signature: "forged" };
  await assert.rejects(() => buildQC([forged, prepares[1], prepares[2]], signers, verifyFakeSignature), /invalid vote signature/);
  await assert.rejects(
    () => buildQC([prepares[0], prepares[1], signVote({ ...prepares[2], proposalDigest: H(222) })], signers, verifyFakeSignature),
    (error) => error instanceof SealProtocolError && error.code === "MIXED_QC"
  );
  const late = new SealSignerState({ objectId: "room", epoch: 2, signerId: "a", validateProposal: async () => true });
  late.enterRound(2);
  const roundOneVotes = signers.slice(0, 3).map((signerId) => signVote({ objectId: "room", epoch: 2, round: 1, phase: "prepare", proposalDigest: H(333), proposalHash: H(334), signerId }));
  const roundOneQC = await buildQC(roundOneVotes, signers, verifyFakeSignature);
  await assert.rejects(
    () => late.commitVote(roundOneQC, { signerSet: signers, verifySignature: verifyFakeSignature }),
    (error) => error instanceof SealProtocolError && error.code === "RETROACTIVE_VOTE"
  );
});

test("locked signer accepts another value only with a verified higher/equal-lock prepare QC", async () => {
  const signers = ["a", "b", "c", "d"];
  const signer = new SealSignerState({ objectId: "room", epoch: 9, signerId: "a", validateProposal: async () => true });
  const aVotes = signers.slice(0, 3).map((signerId) => signVote({ objectId: "room", epoch: 9, round: 0, phase: "prepare", proposalDigest: H(501), proposalHash: H(511), signerId }));
  const aQC = await buildQC(aVotes, signers, verifyFakeSignature);
  await signer.commitVote(aQC, { signerSet: signers, verifySignature: verifyFakeSignature });
  signer.enterRound(1);
  await assert.rejects(
    () => signer.prepareVote({ objectId: "room", epoch: 9, round: 1, digest: H(502), proposalHash: H(512), validRound: -1 }),
    (error) => error instanceof SealProtocolError && error.code === "LOCKED_OTHER_VALUE"
  );
  const bVotes = signers.slice(0, 3).map((signerId) => signVote({ objectId: "room", epoch: 9, round: 1, phase: "prepare", proposalDigest: H(502), proposalHash: H(513), signerId }));
  const bQC = await buildQC(bVotes, signers, verifyFakeSignature);
  signer.enterRound(2);
  const vote = await signer.prepareVote(
    { objectId: "room", epoch: 9, round: 2, digest: H(502), proposalHash: H(514), validRound: 1, prepareQC: bQC },
    { signerSet: signers, verifySignature: verifyFakeSignature }
  );
  assert.equal(vote.proposalDigest, H(502));
});
