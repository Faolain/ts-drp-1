import { normalizeDigest } from "./protocol.js";

export class LinearizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinearizationError";
    this.code = code;
  }
}

class MinHeap {
  constructor(compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)) {
    this.values = [];
    this.compare = compare;
  }
  get size() {
    return this.values.length;
  }
  push(value) {
    const values = this.values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(values[parent], value) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }
  pop() {
    if (this.values.length === 0) return undefined;
    const root = this.values[0];
    const last = this.values.pop();
    if (this.values.length !== 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        let child = left;
        if (right < this.values.length && this.compare(this.values[right], this.values[left]) < 0) child = right;
        if (this.compare(this.values[child], last) >= 0) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return root;
  }
}

function validateGraph(vertices, anchorHash) {
  if (!(vertices instanceof Map)) throw new TypeError("vertices must be a Map keyed by hash");
  normalizeDigest(anchorHash, "anchorHash");
  const anchor = vertices.get(anchorHash);
  if (!anchor || anchor.kind !== "drp-epoch-anchor") throw new LinearizationError("MISSING_ANCHOR", "the active epoch anchor is missing");
  if ((anchor.dependencies?.length ?? 0) !== 0) throw new LinearizationError("INVALID_ANCHOR", "epoch anchor must have no dependencies");
  for (const [hash, vertex] of vertices) {
    if (hash !== vertex.hash) throw new LinearizationError("KEY_HASH_MISMATCH", `map key does not match vertex hash ${hash}`);
    if (hash === anchorHash) continue;
    if (vertex.kind !== "drp-vertex") throw new LinearizationError("INVALID_VERTEX_KIND", `unexpected active vertex kind at ${hash}`);
    if (vertex.objectId !== anchor.objectId || vertex.epoch !== anchor.epoch || vertex.anchor !== anchorHash) {
      throw new LinearizationError("WRONG_EPOCH", `vertex ${hash} is outside the active hard epoch`);
    }
    if (!Array.isArray(vertex.dependencies) || vertex.dependencies.length === 0) {
      throw new LinearizationError("MULTIPLE_ROOTS", `ordinary vertex ${hash} has no dependencies`);
    }
    for (const dependency of vertex.dependencies) {
      if (!vertices.has(dependency)) throw new LinearizationError("MISSING_DEPENDENCY", `vertex ${hash} is missing dependency ${dependency}`);
    }
  }
  return anchor;
}

export function topologicalOrder(vertices, anchorHash, { enforceDependencyAntichain = true } = {}) {
  validateGraph(vertices, anchorHash);
  const indegree = new Map();
  const children = new Map([...vertices.keys()].map((hash) => [hash, []]));
  for (const [hash, vertex] of vertices) {
    indegree.set(hash, vertex.dependencies.length);
    for (const dependency of vertex.dependencies) children.get(dependency).push(hash);
  }
  for (const list of children.values()) list.sort();
  const ready = new MinHeap();
  for (const [hash, degree] of indegree) if (degree === 0) ready.push(hash);
  const order = [];
  while (ready.size !== 0) {
    const hash = ready.pop();
    order.push(hash);
    for (const child of children.get(hash)) {
      const degree = indegree.get(child) - 1;
      indegree.set(child, degree);
      if (degree === 0) ready.push(child);
    }
  }
  if (order.length !== vertices.size) throw new LinearizationError("CYCLE", "active epoch graph contains a cycle or unreachable component");
  if (order[0] !== anchorHash) throw new LinearizationError("MULTIPLE_ROOTS", "epoch anchor is not the unique graph origin");
  if (new Set(order).size !== order.length) throw new LinearizationError("DUPLICATE_EMISSION", "topological order contains duplicate vertices");

  if (enforceDependencyAntichain) {
    const causality = new CausalityIndex(vertices, order);
    for (const hash of order) {
      if (hash === anchorHash) continue;
      const dependencies = vertices.get(hash).dependencies;
      for (let left = 0; left < dependencies.length; left++) {
        for (let right = left + 1; right < dependencies.length; right++) {
          if (causality.areRelated(dependencies[left], dependencies[right])) {
            throw new LinearizationError("NON_ANTICHAIN_DEPENDENCIES", `vertex ${hash} has causally related dependencies`);
          }
        }
      }
    }
  }
  return order;
}

export class CausalityIndex {
  constructor(vertices, order = [...vertices.keys()]) {
    this.vertices = vertices;
    this.order = order;
    this.index = new Map(order.map((hash, position) => [hash, position]));
    this.wordCount = Math.ceil(order.length / 32);
    this.ancestors = new Array(order.length);
    for (let position = 0; position < order.length; position++) {
      const hash = order[position];
      const bits = new Uint32Array(this.wordCount);
      const vertex = vertices.get(hash);
      if (!vertex) throw new LinearizationError("MISSING_VERTEX", `missing ordered vertex ${hash}`);
      for (const dependency of vertex.dependencies ?? []) {
        const dependencyPosition = this.index.get(dependency);
        if (dependencyPosition == null || dependencyPosition >= position) {
          throw new LinearizationError("INVALID_ORDER", `dependency ${dependency} does not precede ${hash}`);
        }
        const dependencyBits = this.ancestors[dependencyPosition];
        for (let word = 0; word < this.wordCount; word++) bits[word] |= dependencyBits[word];
        bits[dependencyPosition >>> 5] |= 1 << (dependencyPosition & 31);
      }
      this.ancestors[position] = bits;
    }
  }

  isAncestor(ancestorHash, descendantHash) {
    if (ancestorHash === descendantHash) return false;
    const ancestor = this.index.get(ancestorHash);
    const descendant = this.index.get(descendantHash);
    if (ancestor == null || descendant == null) return false;
    return (this.ancestors[descendant][ancestor >>> 5] & (1 << (ancestor & 31))) !== 0;
  }

  areRelated(leftHash, rightHash) {
    return leftHash === rightHash || this.isAncestor(leftHash, rightHash) || this.isAncestor(rightHash, leftHash);
  }
}

function normalizeAction(result) {
  const action = typeof result === "string" ? result : result?.action ?? "Nop";
  if (!["Nop", "DropLeft", "DropRight", "Swap"].includes(action)) {
    throw new LinearizationError("INVALID_CONFLICT_ACTION", `unknown conflict action ${action}`);
  }
  return action;
}

function applyPairSemantics(order, vertices, causality, resolveConflicts, maxPasses) {
  if (typeof resolveConflicts !== "function") return order;
  const output = [...order];
  const passLimit = maxPasses ?? Math.max(16, output.length * 4);
  for (let pass = 0; pass < passLimit; pass++) {
    let changed = false;
    outer: for (let left = 0; left < output.length; left++) {
      for (let right = left + 1; right < output.length; right++) {
        const leftHash = output[left];
        const rightHash = output[right];
        if (causality.areRelated(leftHash, rightHash)) continue;
        const action = normalizeAction(resolveConflicts([vertices.get(leftHash), vertices.get(rightHash)], { left, right, pass }));
        if (action === "Nop") continue;
        changed = true;
        if (action === "DropLeft") {
          output.splice(left, 1);
          break outer;
        }
        if (action === "DropRight") {
          output.splice(right, 1);
          right--;
          continue;
        }
        [output[left], output[right]] = [output[right], output[left]];
        break outer;
      }
    }
    if (!changed) return output;
  }
  throw new LinearizationError("NON_CONVERGENT_CONFLICT_POLICY", "pair conflict policy did not converge within the deterministic pass bound");
}

function applyMultipleSemantics(order, vertices, causality, resolveConflicts) {
  if (typeof resolveConflicts !== "function") return order;
  const output = [];
  const consumed = new Set();
  for (const hash of order) {
    if (consumed.has(hash)) continue;
    const key = vertices.get(hash).operation?.conflictKey;
    const group = [hash];
    if (key !== undefined) {
      for (const candidate of order) {
        if (candidate === hash || consumed.has(candidate)) continue;
        if (vertices.get(candidate).operation?.conflictKey === key && group.every((member) => !causality.areRelated(member, candidate))) group.push(candidate);
      }
    }
    const result = resolveConflicts(group.map((member) => vertices.get(member)), { conflictKey: key });
    const retained = result == null ? group : Array.isArray(result) ? result.map((item) => (typeof item === "string" ? item : item.hash)) : group;
    const allowed = new Set(group);
    for (const retainedHash of retained) {
      if (!allowed.has(retainedHash)) throw new LinearizationError("INVALID_MULTIPLE_RESULT", "multiple conflict policy returned a vertex outside its group");
      output.push(retainedHash);
    }
    for (const member of group) consumed.add(member);
  }
  return output;
}

export function linearizeEpoch({ vertices, anchorHash, mode = "none", resolveConflicts, maxPasses } = {}) {
  const all = topologicalOrder(vertices, anchorHash);
  const base = all.filter((hash) => hash !== anchorHash);
  if (mode === "none") return base.map((hash) => vertices.get(hash));
  const causality = new CausalityIndex(vertices, all);
  if (mode === "pair") return applyPairSemantics(base, vertices, causality, resolveConflicts, maxPasses).map((hash) => vertices.get(hash));
  if (mode === "multiple") return applyMultipleSemantics(base, vertices, causality, resolveConflicts).map((hash) => vertices.get(hash));
  throw new LinearizationError("UNKNOWN_MODE", `unknown linearization mode ${mode}`);
}
