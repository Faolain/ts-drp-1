import { decodeCanonical, encodeCanonical } from "./canonical.js";
import { bytesToHex, concatBytes, hashDomain, hexToBytes } from "./hash.js";
import { buildMerkleTree, inclusionProof, verifyInclusion } from "./ct-merkle.js";
import { digestCanonical, normalizeDigest, PROTOCOL_MAJOR } from "./protocol.js";

function requireString(value, name, maxLength = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

export async function archivePayloadDigest(bytes) {
  return bytesToHex(await hashDomain("ts-drp/archive-payload/v2", bytes));
}

export async function archiveChunkDigest(objectId, startOrdinal, index, bytes) {
  return bytesToHex(
    await hashDomain(
      "ts-drp/archive-chunk/v2",
      encodeCanonical(requireString(objectId, "objectId")),
      encodeCanonical(requireSafeInteger(startOrdinal, "startOrdinal")),
      encodeCanonical(requireSafeInteger(index, "chunk index")),
      bytes
    )
  );
}

function archiveDescriptorPreimage(input) {
  const objectId = requireString(input.objectId, "objectId");
  const epoch = requireSafeInteger(input.epoch, "epoch");
  const startOrdinal = requireSafeInteger(input.startOrdinal, "startOrdinal");
  const recordCount = requireSafeInteger(input.recordCount, "recordCount", 1);
  const endOrdinal = requireSafeInteger(input.endOrdinal, "endOrdinal");
  if (endOrdinal !== startOrdinal + recordCount - 1) throw new TypeError("archive ordinal range does not match record count");
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) throw new TypeError("archive chunks must be non-empty");
  const chunks = input.chunks.map((chunk, index) => {
    if (chunk.index !== index) throw new TypeError("archive chunks must be contiguous and ordered");
    const byteLength = chunk.bytes?.byteLength ?? chunk.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError("invalid archive chunk byte length");
    return Object.freeze({ index, digest: normalizeDigest(chunk.digest, "archive chunk digest"), byteLength });
  });
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (input.totalBytes != null && input.totalBytes !== totalBytes) throw new TypeError("archive total byte count mismatch");
  return Object.freeze({
    kind: "drp-archive-segment",
    protocolMajor: input.protocolMajor ?? PROTOCOL_MAJOR,
    encodingVersion: input.encodingVersion ?? "drp-canonical-profile-1",
    schemaVersion: requireSafeInteger(input.schemaVersion ?? 1, "schemaVersion", 1),
    objectId,
    epoch,
    startOrdinal,
    endOrdinal,
    recordCount,
    payloadDigest: normalizeDigest(input.payloadDigest, "archive payload digest"),
    totalBytes,
    chunks,
  });
}

export async function buildArchiveSegment({
  objectId,
  epoch,
  startOrdinal,
  records,
  schemaVersion = 1,
  chunkSize = 128 * 1024,
  maxBytes = 256 * 1024 * 1024,
  yieldTask,
}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("archive segment records must be a non-empty array");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 16 * 1024 || chunkSize > 1024 * 1024) throw new RangeError("invalid archive chunk size");
  const payload = encodeCanonical({
    kind: "drp-archive-segment-payload",
    protocolMajor: PROTOCOL_MAJOR,
    schemaVersion,
    objectId,
    epoch,
    startOrdinal,
    records,
  });
  if (payload.byteLength > maxBytes) throw new RangeError("archive segment exceeds configured maximum");
  const chunks = [];
  for (let offset = 0, index = 0; offset < payload.byteLength; offset += chunkSize, index++) {
    const bytes = new Uint8Array(payload.subarray(offset, Math.min(payload.byteLength, offset + chunkSize)));
    chunks.push(Object.freeze({ index, digest: await archiveChunkDigest(objectId, startOrdinal, index, bytes), bytes }));
    if (yieldTask) await yieldTask();
  }
  const preimage = archiveDescriptorPreimage({
    objectId,
    epoch,
    startOrdinal,
    endOrdinal: startOrdinal + records.length - 1,
    recordCount: records.length,
    schemaVersion,
    payloadDigest: await archivePayloadDigest(payload),
    chunks,
  });
  const digest = await digestCanonical("ts-drp/archive-segment/v2", preimage);
  return Object.freeze({ descriptor: Object.freeze({ ...preimage, digest }), chunks, payload });
}

export async function verifyArchiveDescriptor(descriptor, { maxChunks = 65536, maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!Array.isArray(descriptor?.chunks) || descriptor.chunks.length === 0 || descriptor.chunks.length > maxChunks) {
    throw new TypeError("invalid archive chunk list");
  }
  if (descriptor.totalBytes > maxBytes) throw new RangeError("archive segment exceeds configured maximum");
  const expected = await digestCanonical("ts-drp/archive-segment/v2", archiveDescriptorPreimage(descriptor));
  if (descriptor.digest !== expected) throw new Error("archive descriptor digest mismatch");
  return true;
}

export async function verifyArchiveSegment(descriptor, chunksByDigest, limits = {}) {
  await verifyArchiveDescriptor(descriptor, limits);
  const parts = [];
  let total = 0;
  for (const chunk of descriptor.chunks) {
    const bytes = chunksByDigest instanceof Map ? chunksByDigest.get(chunk.digest) : chunksByDigest[chunk.digest];
    if (!(bytes instanceof Uint8Array)) throw new Error(`missing archive chunk ${chunk.digest}`);
    if (bytes.byteLength !== chunk.byteLength) throw new Error(`archive chunk length mismatch at ${chunk.index}`);
    if ((await archiveChunkDigest(descriptor.objectId, descriptor.startOrdinal, chunk.index, bytes)) !== chunk.digest) {
      throw new Error(`archive chunk digest mismatch at ${chunk.index}`);
    }
    parts.push(bytes);
    total += bytes.byteLength;
  }
  if (total !== descriptor.totalBytes) throw new Error("archive total length mismatch");
  const payload = concatBytes(...parts);
  if ((await archivePayloadDigest(payload)) !== descriptor.payloadDigest) throw new Error("archive payload digest mismatch");
  const decoded = decodeCanonical(payload);
  if (
    decoded?.kind !== "drp-archive-segment-payload" ||
    decoded.objectId !== descriptor.objectId ||
    decoded.epoch !== descriptor.epoch ||
    decoded.startOrdinal !== descriptor.startOrdinal ||
    decoded.schemaVersion !== descriptor.schemaVersion ||
    !Array.isArray(decoded.records) ||
    decoded.records.length !== descriptor.recordCount
  ) {
    throw new Error("archive payload metadata mismatch");
  }
  return decoded.records;
}

export function archiveIndexEntry(descriptor) {
  return Object.freeze({
    objectId: requireString(descriptor.objectId, "objectId"),
    startOrdinal: requireSafeInteger(descriptor.startOrdinal, "startOrdinal"),
    endOrdinal: requireSafeInteger(descriptor.endOrdinal, "endOrdinal"),
    recordCount: requireSafeInteger(descriptor.recordCount, "recordCount", 1),
    segmentDigest: normalizeDigest(descriptor.segmentDigest ?? descriptor.digest, "segmentDigest"),
    payloadDigest: normalizeDigest(descriptor.payloadDigest, "payloadDigest"),
  });
}

export async function buildArchiveIndex(descriptors, { requireContiguous = true, batchSize = 256, yieldTask } = {}) {
  if (!Array.isArray(descriptors)) throw new TypeError("archive descriptors must be an array");
  const entries = descriptors.map(archiveIndexEntry).sort((left, right) => left.startOrdinal - right.startOrdinal || left.segmentDigest.localeCompare(right.segmentDigest));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.endOrdinal !== entry.startOrdinal + entry.recordCount - 1) throw new TypeError("invalid archive index ordinal range");
    if (index > 0) {
      const previous = entries[index - 1];
      if (entry.startOrdinal <= previous.endOrdinal) throw new TypeError("archive segments overlap");
      if (requireContiguous && entry.startOrdinal !== previous.endOrdinal + 1) throw new TypeError("archive segment index contains a gap");
    }
  }
  const inputs = entries.map((entry) => encodeCanonical(entry));
  const tree = await buildMerkleTree(inputs, { batchSize, yieldTask });
  return Object.freeze({
    kind: "drp-archive-index",
    entryCount: entries.length,
    totalRecords: entries.reduce((sum, entry) => sum + entry.recordCount, 0),
    root: bytesToHex(tree.root),
    entries,
    tree,
  });
}

export async function archiveIndexProof(index, entryIndex) {
  const proof = await inclusionProof(index.tree, entryIndex);
  return Object.freeze({ ...proof, auditPath: proof.auditPath.map((hash) => new Uint8Array(hash)) });
}

export async function verifyArchiveIndexEntry(entry, proof, root) {
  try {
    return verifyInclusion(encodeCanonical(archiveIndexEntry(entry)), proof, hexToBytes(normalizeDigest(root, "archive index root")));
  } catch {
    return false;
  }
}
