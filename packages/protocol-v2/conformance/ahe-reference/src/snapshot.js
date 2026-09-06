import { decodeCanonical, encodeCanonical } from "./canonical.js";
import { bytesEqual, bytesToHex, concatBytes, hashDomain } from "./hash.js";
import { digestCanonical, normalizeDigest, PROTOCOL_MAJOR } from "./protocol.js";

export async function snapshotPayloadDigest(bytes) {
  return bytesToHex(await hashDomain("ts-drp/snapshot-payload/v2", bytes));
}

export async function snapshotChunkDigest(index, bytes) {
  return bytesToHex(await hashDomain("ts-drp/snapshot-chunk/v2", encodeCanonical(index), bytes));
}

export async function buildSnapshotChunks(payload, { chunkSize = 128 * 1024, maxBytes = 256 * 1024 * 1024, yieldTask } = {}) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 16 * 1024 || chunkSize > 1024 * 1024) throw new RangeError("invalid snapshot chunk size");
  if (bytes.byteLength > maxBytes) throw new RangeError("snapshot exceeds configured maximum");
  const chunks = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index++) {
    const chunkBytes = new Uint8Array(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
    chunks.push(Object.freeze({ index, digest: await snapshotChunkDigest(index, chunkBytes), bytes: chunkBytes }));
    if (yieldTask) await yieldTask();
  }
  if (bytes.byteLength === 0) chunks.push(Object.freeze({ index: 0, digest: await snapshotChunkDigest(0, new Uint8Array()), bytes: new Uint8Array() }));
  return chunks;
}

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

function manifestPreimage(input) {
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) throw new TypeError("snapshot chunks must be a non-empty array");
  const chunks = input.chunks.map((chunk, index) => {
    if (chunk.index !== index) throw new TypeError("snapshot chunks must be contiguous and ordered");
    return Object.freeze({ index, digest: normalizeDigest(chunk.digest, "chunk digest"), byteLength: chunk.bytes?.byteLength ?? chunk.byteLength });
  });
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (input.totalBytes != null && input.totalBytes !== totalBytes) throw new TypeError("snapshot byte count mismatch");
  return Object.freeze({
    kind: "drp-snapshot-manifest",
    protocolMajor: input.protocolMajor ?? PROTOCOL_MAJOR,
    encodingVersion: input.encodingVersion ?? "drp-canonical-profile-1",
    objectId: requireString(input.objectId, "objectId"),
    epoch: requireSafeInteger(input.epoch, "epoch"),
    anchor: normalizeDigest(input.anchor, "anchor"),
    schemaVersion: requireSafeInteger(input.schemaVersion ?? 1, "schemaVersion", 1),
    stateDigest: normalizeDigest(input.stateDigest, "stateDigest"),
    aclDigest: normalizeDigest(input.aclDigest, "aclDigest"),
    payloadDigest: normalizeDigest(input.payloadDigest, "payloadDigest"),
    totalBytes,
    chunks,
  });
}

export async function snapshotManifest(input) {
  const chunks = input.chunks;
  const payload = concatBytes(...chunks.map((chunk) => chunk.bytes));
  const preimage = manifestPreimage({ ...input, payloadDigest: input.payloadDigest ?? (await snapshotPayloadDigest(payload)) });
  const digest = await digestCanonical("ts-drp/snapshot-manifest/v2", preimage);
  return Object.freeze({ ...preimage, digest });
}

export async function verifyManifest(manifest, { maxChunks = 65536, maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!Array.isArray(manifest?.chunks) || manifest.chunks.length === 0 || manifest.chunks.length > maxChunks) throw new TypeError("invalid snapshot chunk list");
  if (manifest.totalBytes > maxBytes) throw new RangeError("snapshot manifest exceeds maximum bytes");
  const expected = await digestCanonical("ts-drp/snapshot-manifest/v2", manifestPreimage(manifest));
  if (expected !== manifest.digest) throw new Error("snapshot manifest digest mismatch");
  return true;
}

export async function verifyAndAssembleSnapshot(manifest, chunksByDigest, limits = {}) {
  await verifyManifest(manifest, limits);
  const parts = [];
  let total = 0;
  for (const descriptor of manifest.chunks) {
    const bytes = chunksByDigest instanceof Map ? chunksByDigest.get(descriptor.digest) : chunksByDigest[descriptor.digest];
    if (!(bytes instanceof Uint8Array)) throw new Error(`missing snapshot chunk ${descriptor.digest}`);
    if (bytes.byteLength !== descriptor.byteLength) throw new Error(`snapshot chunk length mismatch at ${descriptor.index}`);
    const digest = await snapshotChunkDigest(descriptor.index, bytes);
    if (digest !== descriptor.digest) throw new Error(`snapshot chunk digest mismatch at ${descriptor.index}`);
    parts.push(bytes);
    total += bytes.byteLength;
  }
  if (total !== manifest.totalBytes) throw new Error("snapshot total length mismatch");
  const payload = concatBytes(...parts);
  if ((await snapshotPayloadDigest(payload)) !== manifest.payloadDigest) throw new Error("snapshot payload digest mismatch");
  return payload;
}

export async function verifyAndDecodeSnapshot(manifest, chunksByDigest, limits = {}) {
  return decodeCanonical(await verifyAndAssembleSnapshot(manifest, chunksByDigest, limits));
}

export async function encodeSnapshotPayload({ application, acl, objectId, epoch, anchor, schemaVersion = 1 }) {
  return encodeCanonical({ kind: "drp-snapshot-payload", protocolMajor: PROTOCOL_MAJOR, objectId, epoch, anchor, schemaVersion, application, acl });
}

export { bytesEqual };
