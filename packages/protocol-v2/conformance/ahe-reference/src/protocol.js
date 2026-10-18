import { encodeCanonical } from "./canonical.js";
import { bytesToHex, hashDomain, hexToBytes } from "./hash.js";

export const PROTOCOL_MAJOR = 2;
export const ENCODING_VERSION = "drp-canonical-profile-1";
export const ZERO_DIGEST = "0".repeat(64);
export const DEFAULT_PROTOCOL_PARAMETERS = Object.freeze({
  maxEpochVertices: 8192,
  maxEpochBytes: 8 * 1024 * 1024,
  maxDependencies: 16,
  snapshotChunkBytes: 128 * 1024,
  maxSnapshotBytes: 256 * 1024 * 1024,
  maxPendingEntries: 4096,
  maxPendingBytes: 16 * 1024 * 1024,
});

function assertString(value, name, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function normalizeDigest(value, name = "digest") {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} must be a lowercase 32-byte hex digest`);
  return value;
}

function normalizeSafeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

export function normalizeParameters(parameters = {}) {
  const merged = { ...DEFAULT_PROTOCOL_PARAMETERS, ...parameters };
  const constraints = {
    maxEpochVertices: [32, 1_000_000],
    maxEpochBytes: [64 * 1024, 1024 * 1024 * 1024],
    maxDependencies: [1, 256],
    snapshotChunkBytes: [16 * 1024, 1024 * 1024],
    maxSnapshotBytes: [1024 * 1024, 4 * 1024 * 1024 * 1024],
    maxPendingEntries: [1, 1_000_000],
    maxPendingBytes: [64 * 1024, 1024 * 1024 * 1024],
  };
  const output = Object.create(null);
  for (const [key, [minimum, maximum]] of Object.entries(constraints)) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${key} must be an integer in [${minimum}, ${maximum}]`);
    output[key] = value;
  }
  if (output.snapshotChunkBytes > output.maxSnapshotBytes) throw new TypeError("snapshotChunkBytes cannot exceed maxSnapshotBytes");
  return output;
}

export function normalizeSignerSet(signers) {
  if (!Array.isArray(signers)) throw new TypeError("signer set must be an array");
  const normalized = signers.map((entry) => {
    if (typeof entry === "string") return Object.freeze({ signerId: assertString(entry, "signerId", 512), publicKey: "" });
    if (entry == null || typeof entry !== "object") throw new TypeError("invalid signer entry");
    return Object.freeze({
      signerId: assertString(entry.signerId, "signerId", 512),
      publicKey: typeof entry.publicKey === "string" ? entry.publicKey : "",
    });
  });
  normalized.sort((left, right) => left.signerId.localeCompare(right.signerId));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index - 1].signerId === normalized[index].signerId) throw new TypeError("signer set contains duplicate signer ids");
  }
  return normalized;
}

export async function digestCanonical(domain, value) {
  return bytesToHex(await hashDomain(domain, encodeCanonical(value)));
}

export async function signerSetDigest(signers) {
  return digestCanonical("ts-drp/signer-set/v2", normalizeSignerSet(signers));
}

export async function parametersDigest(parameters) {
  return digestCanonical("ts-drp/parameters/v2", normalizeParameters(parameters));
}

export function vertexPreimage(vertex) {
  const objectId = assertString(vertex.objectId, "objectId", 1024);
  const protocolMajor = normalizeSafeInteger(vertex.protocolMajor ?? PROTOCOL_MAJOR, "protocolMajor", 1);
  const epoch = normalizeSafeInteger(vertex.epoch, "epoch", 0);
  const anchor = normalizeDigest(vertex.anchor, "anchor");
  const author = assertString(vertex.author, "author", 1024);
  const logicalTime = normalizeSafeInteger(vertex.logicalTime, "logicalTime", 1);
  if (!Array.isArray(vertex.dependencies) || vertex.dependencies.length === 0) throw new TypeError("ordinary vertices require at least one dependency");
  const maxDependencies = vertex.maxDependencies ?? DEFAULT_PROTOCOL_PARAMETERS.maxDependencies;
  if (vertex.dependencies.length > maxDependencies) throw new TypeError("vertex exceeds dependency limit");
  const dependencies = vertex.dependencies.map((dep) => normalizeDigest(dep, "dependency")).sort();
  for (let index = 1; index < dependencies.length; index++) {
    if (dependencies[index - 1] === dependencies[index]) throw new TypeError("vertex contains duplicate dependencies");
  }
  if (vertex.operation == null || typeof vertex.operation !== "object") throw new TypeError("operation must be a canonical object");
  return Object.freeze({
    kind: "drp-vertex",
    protocolMajor,
    objectId,
    epoch,
    anchor,
    author,
    logicalTime,
    dependencies,
    operation: vertex.operation,
  });
}

export async function createUnsignedVertex(fields) {
  const preimage = vertexPreimage(fields);
  const hash = await digestCanonical("ts-drp/vertex/v2", preimage);
  return Object.freeze({ ...preimage, hash });
}

export async function verifyVertexHash(vertex) {
  try {
    return vertex.hash === (await digestCanonical("ts-drp/vertex/v2", vertexPreimage(vertex)));
  } catch {
    return false;
  }
}

export function cutDescriptorPreimage(input) {
  const objectId = assertString(input.objectId, "objectId", 1024);
  const protocolMajor = normalizeSafeInteger(input.protocolMajor ?? PROTOCOL_MAJOR, "protocolMajor", 1);
  const encodingVersion = assertString(input.encodingVersion ?? ENCODING_VERSION, "encodingVersion", 128);
  const epoch = normalizeSafeInteger(input.epoch, "epoch", 0);
  const round = normalizeSafeInteger(input.round, "round", 0);
  const previousAnchor = normalizeDigest(input.previousAnchor, "previousAnchor");
  const previousCutDigest = normalizeDigest(input.previousCutDigest ?? ZERO_DIGEST, "previousCutDigest");
  const previousHistoryRoot = normalizeDigest(input.previousHistoryRoot ?? ZERO_DIGEST, "previousHistoryRoot");
  const previousHistorySize = normalizeSafeInteger(input.previousHistorySize ?? 0, "previousHistorySize", 0);
  const closeSetRoot = normalizeDigest(input.closeSetRoot, "closeSetRoot");
  const closeSetCount = normalizeSafeInteger(input.closeSetCount, "closeSetCount", 0);
  const historyRoot = normalizeDigest(input.historyRoot, "historyRoot");
  const historySize = normalizeSafeInteger(input.historySize, "historySize", 0);
  if (historySize !== previousHistorySize + closeSetCount) throw new TypeError("history size must equal previous size plus close-set count");
  const stateDigest = normalizeDigest(input.stateDigest, "stateDigest");
  const aclDigest = normalizeDigest(input.aclDigest, "aclDigest");
  const snapshotManifestDigest = normalizeDigest(input.snapshotManifestDigest, "snapshotManifestDigest");
  const blueprintDigest = normalizeDigest(input.blueprintDigest ?? ZERO_DIGEST, "blueprintDigest");
  const nextSignerSet = normalizeSignerSet(input.nextSignerSet);
  if (nextSignerSet.length !== 0 && nextSignerSet.length < 4) throw new TypeError("attested compaction requires at least four signers");
  const parameters = normalizeParameters(input.parameters);
  const closeReason = input.closeReason == null ? "size" : assertString(input.closeReason, "closeReason", 128);
  return Object.freeze({
    kind: "drp-hard-epoch-cut",
    protocolMajor,
    encodingVersion,
    objectId,
    epoch,
    round,
    previousAnchor,
    previousCutDigest,
    previousHistoryRoot,
    previousHistorySize,
    closeSetRoot,
    closeSetCount,
    historyRoot,
    historySize,
    stateDigest,
    aclDigest,
    snapshotManifestDigest,
    blueprintDigest,
    nextSignerSet,
    parameters,
    closeReason,
  });
}

export async function computeCutDigest(descriptor) {
  return digestCanonical("ts-drp/hard-epoch-cut/v2", cutDescriptorPreimage(descriptor));
}

export function epochAnchorPreimage(fields) {
  const objectId = assertString(fields.objectId, "objectId", 1024);
  const protocolMajor = normalizeSafeInteger(fields.protocolMajor ?? PROTOCOL_MAJOR, "protocolMajor", 1);
  const epoch = normalizeSafeInteger(fields.epoch, "epoch", 0);
  const previousAnchor = normalizeDigest(fields.previousAnchor ?? ZERO_DIGEST, "previousAnchor");
  const cutDigest = normalizeDigest(fields.cutDigest ?? ZERO_DIGEST, "cutDigest");
  const stateDigest = normalizeDigest(fields.stateDigest, "stateDigest");
  const aclDigest = normalizeDigest(fields.aclDigest, "aclDigest");
  const historyRoot = normalizeDigest(fields.historyRoot ?? ZERO_DIGEST, "historyRoot");
  const historySize = normalizeSafeInteger(fields.historySize ?? 0, "historySize", 0);
  const signerDigest = normalizeDigest(fields.signerSetDigest ?? ZERO_DIGEST, "signerSetDigest");
  const paramsDigest = normalizeDigest(fields.parametersDigest ?? ZERO_DIGEST, "parametersDigest");
  return Object.freeze({
    kind: "drp-epoch-anchor",
    protocolMajor,
    objectId,
    epoch,
    previousAnchor,
    cutDigest,
    stateDigest,
    aclDigest,
    historyRoot,
    historySize,
    signerSetDigest: signerDigest,
    parametersDigest: paramsDigest,
  });
}

export async function createEpochAnchor(fields) {
  const preimage = epochAnchorPreimage(fields);
  const hash = await digestCanonical("ts-drp/epoch-anchor/v2", preimage);
  return Object.freeze({
    ...preimage,
    hash,
    author: "system",
    logicalTime: 0,
    dependencies: Object.freeze([]),
    operation: Object.freeze({ type: "epoch-anchor" }),
  });
}

export async function verifyEpochAnchorHash(anchor) {
  try {
    if (anchor.kind !== "drp-epoch-anchor" || anchor.logicalTime !== 0) return false;
    if (!Array.isArray(anchor.dependencies) || anchor.dependencies.length !== 0) return false;
    return anchor.hash === (await digestCanonical("ts-drp/epoch-anchor/v2", epochAnchorPreimage(anchor)));
  } catch {
    return false;
  }
}

export async function createAnchorFromCut(descriptor) {
  const preimage = cutDescriptorPreimage(descriptor);
  const cutDigest = await computeCutDigest(preimage);
  return createEpochAnchor({
    objectId: preimage.objectId,
    protocolMajor: preimage.protocolMajor,
    epoch: preimage.epoch + 1,
    previousAnchor: preimage.previousAnchor,
    cutDigest,
    stateDigest: preimage.stateDigest,
    aclDigest: preimage.aclDigest,
    historyRoot: preimage.historyRoot,
    historySize: preimage.historySize,
    signerSetDigest: await signerSetDigest(preimage.nextSignerSet),
    parametersDigest: await parametersDigest(preimage.parameters),
  });
}

export async function historyLeafInput({ objectId, epoch, ordinal, vertexHash }) {
  normalizeDigest(vertexHash, "vertexHash");
  return encodeCanonical({
    kind: "drp-history-leaf",
    protocolMajor: PROTOCOL_MAJOR,
    objectId: assertString(objectId, "objectId", 1024),
    epoch: normalizeSafeInteger(epoch, "epoch", 0),
    ordinal: normalizeSafeInteger(ordinal, "ordinal", 0),
    vertexHash,
  });
}

export function digestBytes(hex) {
  return hexToBytes(normalizeDigest(hex));
}
