import { encodeCanonical } from "./canonical.js";
import { inclusionProof, verifyInclusion } from "./ct-merkle.js";
import { bytesToHex, hexToBytes } from "./hash.js";
import {
  historyLeafInput,
  normalizeDigest,
  PROTOCOL_MAJOR,
  verifyEpochAnchorHash,
  verifyVertexHash,
} from "./protocol.js";

function result(status, code, details = {}) {
  return Object.freeze({ status, code, ...details });
}

async function validateKnownDependency(vertex, dependencyHash, dependency, context) {
  if (!dependency || dependency.hash !== dependencyHash) {
    return result("terminal", "INVALID_DEPENDENCY_ENVELOPE", { dependency: dependencyHash });
  }
  const hashValid =
    dependency.kind === "drp-epoch-anchor"
      ? await verifyEpochAnchorHash(dependency)
      : await verifyVertexHash(dependency);
  if (!hashValid) return result("terminal", "INVALID_DEPENDENCY_ENVELOPE", { dependency: dependencyHash });
  if (dependency.objectId !== context.objectId || dependency.protocolMajor !== context.protocolMajor) {
    return result("terminal", "DEPENDENCY_DOMAIN_MISMATCH", { dependency: dependencyHash });
  }
  if (dependency.kind === "drp-epoch-anchor") {
    if (dependency.hash !== context.currentAnchor || dependency.epoch !== context.currentEpoch) {
      return result("terminal", "DEPENDENCY_WRONG_ANCHOR", { dependency: dependencyHash });
    }
  } else if (dependency.epoch !== context.currentEpoch || dependency.anchor !== context.currentAnchor) {
    return result("terminal", "DEPENDENCY_WRONG_EPOCH", { dependency: dependencyHash });
  }
  if (dependency.logicalTime >= vertex.logicalTime && dependency.kind !== "drp-epoch-anchor") {
    return result("terminal", "NON_MONOTONE_LOGICAL_TIME", { dependency: dependencyHash });
  }
  return null;
}

export async function classifyVertex(vertex, context) {
  if (context == null || typeof context !== "object") throw new TypeError("admission context is required");
  const protocolMajor = context.protocolMajor ?? PROTOCOL_MAJOR;
  if (!(await verifyVertexHash(vertex))) return result("terminal", "INVALID_HASH");
  if (vertex.objectId !== context.objectId) return result("terminal", "WRONG_OBJECT");
  if (vertex.protocolMajor < protocolMajor) return result("terminal", "LEGACY_PROTOCOL");
  if (vertex.protocolMajor > protocolMajor) return result("pending", "FUTURE_PROTOCOL");
  if (vertex.epoch < context.currentEpoch) return result("terminal", "STALE_EPOCH", { currentEpoch: context.currentEpoch });
  if (vertex.epoch > context.currentEpoch) return result("pending", "FUTURE_EPOCH", { currentEpoch: context.currentEpoch });
  if (vertex.anchor !== context.currentAnchor) return result("terminal", "WRONG_ANCHOR", { currentAnchor: context.currentAnchor });
  if (!Array.isArray(vertex.dependencies) || vertex.dependencies.length === 0) return result("terminal", "MISSING_DEPENDENCIES");
  if (vertex.dependencies.length > context.parameters.maxDependencies) return result("terminal", "TOO_MANY_DEPENDENCIES");

  const dependencySources = [context.activeVertices, context.batchVertices, context.suppliedDependencies].filter((source) => source instanceof Map);
  const known = new Map();
  const missing = [];
  for (const dependencyHash of vertex.dependencies) {
    normalizeDigest(dependencyHash, "dependency");
    let dependency;
    for (const source of dependencySources) {
      dependency = source.get(dependencyHash);
      if (dependency) break;
    }
    if (!dependency) {
      missing.push(dependencyHash);
      continue;
    }
    known.set(dependencyHash, dependency);
    const invalid = await validateKnownDependency(vertex, dependencyHash, dependency, context);
    if (invalid) return invalid;
  }
  if (missing.length !== 0) return result("pending", "MISSING_CURRENT_EPOCH_DEPENDENCIES", { missing: Object.freeze(missing.sort()) });

  const dependencies = [...known.keys()];
  for (let left = 0; left < dependencies.length; left++) {
    for (let right = left + 1; right < dependencies.length; right++) {
      const a = dependencies[left];
      const b = dependencies[right];
      if (context.isAncestor?.(a, b) || context.isAncestor?.(b, a)) {
        return result("terminal", "NON_ANTICHAIN_DEPENDENCIES", { left: a, right: b });
      }
    }
  }
  if (!vertex.dependencies.includes(context.currentAnchor)) {
    const reachesAnchor = vertex.dependencies.every((dependency) => {
      const envelope = known.get(dependency);
      return envelope.kind === "drp-epoch-anchor" || envelope.anchor === context.currentAnchor;
    });
    if (!reachesAnchor) return result("terminal", "NOT_GROUNDED_IN_ANCHOR");
  }
  return result("accept", "ADMISSIBLE");
}

export class PendingPool {
  constructor({ maxEntries = 4096, maxBytes = 16 * 1024 * 1024, maxPerPeer = 256 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxPerPeer = maxPerPeer;
    this.entries = new Map();
    this.perPeer = new Map();
    this.totalBytes = 0;
    this.sequence = 0;
  }

  add(hash, peerId, value, byteLength = encodeCanonical(value).byteLength) {
    if (this.entries.has(hash)) return { stored: true, duplicate: true, evicted: [] };
    const peerCount = this.perPeer.get(peerId) ?? 0;
    if (peerCount >= this.maxPerPeer || byteLength > this.maxBytes) return { stored: false, duplicate: false, evicted: [] };
    const entry = { hash, peerId, value, byteLength, sequence: this.sequence++ };
    this.entries.set(hash, entry);
    this.perPeer.set(peerId, peerCount + 1);
    this.totalBytes += byteLength;
    const evicted = [];
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.values().next().value;
      if (!oldest) break;
      this._remove(oldest.hash);
      evicted.push(oldest.hash);
    }
    return { stored: this.entries.has(hash), duplicate: false, evicted };
  }

  _remove(hash) {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    this.entries.delete(hash);
    this.totalBytes -= entry.byteLength;
    const count = (this.perPeer.get(entry.peerId) ?? 1) - 1;
    if (count <= 0) this.perPeer.delete(entry.peerId);
    else this.perPeer.set(entry.peerId, count);
    return entry;
  }

  take(hash) {
    return this._remove(hash)?.value;
  }

  has(hash) {
    return this.entries.has(hash);
  }

  stats() {
    return Object.freeze({ entries: this.entries.size, bytes: this.totalBytes, peers: this.perPeer.size });
  }
}

// Archival inclusion proofs are deliberately an audit primitive, not an admission
// oracle. Hard-epoch admission needs only the signed epoch and anchor envelope.
export class HistoryWitnessVerifier {
  async verify({ objectId, epoch, ordinal, vertexHash, root, treeSize, leafIndex, auditPath }) {
    try {
      const input = await historyLeafInput({ objectId, epoch, ordinal, vertexHash });
      return verifyInclusion(input, { treeSize, leafIndex, auditPath }, hexToBytes(root));
    } catch {
      return false;
    }
  }

  async create(tree, { objectId, epoch, ordinal, vertexHash, leafIndex }) {
    const proof = await inclusionProof(tree, leafIndex);
    return Object.freeze({
      objectId,
      epoch,
      ordinal,
      vertexHash,
      root: bytesToHex(tree.root),
      treeSize: tree.size,
      ...proof,
    });
  }
}
