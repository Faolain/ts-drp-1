import { bytesEqual, concatBytes, sha256 } from "./hash.js";

export const EMPTY_MERKLE_ROOT = await sha256(new Uint8Array());

export async function merkleLeafHash(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return sha256(concatBytes(Uint8Array.of(0x00), bytes));
}

export async function merkleNodeHash(left, right) {
  if (!(left instanceof Uint8Array) || left.byteLength !== 32 || !(right instanceof Uint8Array) || right.byteLength !== 32) {
    throw new TypeError("Merkle nodes must be 32-byte hashes");
  }
  return sha256(concatBytes(Uint8Array.of(0x01), left, right));
}

function largestPowerOfTwoLessThan(value) {
  if (!Number.isSafeInteger(value) || value <= 1) throw new RangeError("value must be an integer greater than one");
  return 2 ** Math.floor(Math.log2(value - 1));
}

export async function buildMerkleTree(inputs, { batchSize = 256, yieldTask } = {}) {
  if (!Array.isArray(inputs)) throw new TypeError("inputs must be an array");
  const leafHashes = new Array(inputs.length);
  for (let start = 0; start < inputs.length; start += batchSize) {
    const end = Math.min(inputs.length, start + batchSize);
    const batch = [];
    for (let index = start; index < end; index++) batch.push(merkleLeafHash(inputs[index]));
    const hashes = await Promise.all(batch);
    for (let index = 0; index < hashes.length; index++) leafHashes[start + index] = hashes[index];
    if (yieldTask && end < inputs.length) await yieldTask();
  }
  const memo = new Map();
  const hashRange = async (start, length) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > leafHashes.length) {
      throw new RangeError("invalid Merkle range");
    }
    if (length === 0) return EMPTY_MERKLE_ROOT;
    if (length === 1) return leafHashes[start];
    const key = `${start}:${length}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const split = largestPowerOfTwoLessThan(length);
    const value = await merkleNodeHash(await hashRange(start, split), await hashRange(start + split, length - split));
    memo.set(key, value);
    return value;
  };
  const root = await hashRange(0, leafHashes.length);
  return Object.freeze({ inputs: [...inputs], leafHashes, size: inputs.length, root, hashRange });
}

async function inclusionPath(tree, index, start, length) {
  if (length === 1) return [];
  const split = largestPowerOfTwoLessThan(length);
  if (index < split) {
    return [...(await inclusionPath(tree, index, start, split)), await tree.hashRange(start + split, length - split)];
  }
  return [...(await inclusionPath(tree, index - split, start + split, length - split)), await tree.hashRange(start, split)];
}

export async function inclusionProof(tree, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= tree.size) throw new RangeError("leaf index is outside the tree");
  return { leafIndex: index, treeSize: tree.size, auditPath: await inclusionPath(tree, index, 0, tree.size) };
}

export async function verifyInclusion(input, proof, expectedRoot) {
  const { leafIndex, treeSize, auditPath } = proof ?? {};
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize) || leafIndex < 0 || leafIndex >= treeSize) return false;
  if (!Array.isArray(auditPath) || auditPath.length > Math.ceil(Math.log2(Math.max(1, treeSize))) + 1) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let root = await merkleLeafHash(input);
  for (const sibling of auditPath) {
    if (!(sibling instanceof Uint8Array) || sibling.byteLength !== 32 || sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      root = await merkleNodeHash(sibling, root);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      root = await merkleNodeHash(root, sibling);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(root, expectedRoot);
}

async function subproof(tree, m, start, n, complete) {
  if (m === n) return complete ? [] : [await tree.hashRange(start, n)];
  const split = largestPowerOfTwoLessThan(n);
  if (m <= split) {
    return [...(await subproof(tree, m, start, split, complete)), await tree.hashRange(start + split, n - split)];
  }
  return [...(await subproof(tree, m - split, start + split, n - split, false)), await tree.hashRange(start, split)];
}

export async function consistencyProof(tree, firstSize) {
  if (!Number.isSafeInteger(firstSize) || firstSize < 0 || firstSize > tree.size) throw new RangeError("invalid prior tree size");
  if (firstSize === 0 || firstSize === tree.size) return { firstSize, secondSize: tree.size, path: [] };
  return { firstSize, secondSize: tree.size, path: await subproof(tree, firstSize, 0, tree.size, true) };
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

export async function verifyConsistency(firstSize, secondSize, firstRoot, secondRoot, path) {
  if (!Number.isSafeInteger(firstSize) || !Number.isSafeInteger(secondSize) || firstSize < 0 || secondSize < firstSize) return false;
  if (!(firstRoot instanceof Uint8Array) || firstRoot.byteLength !== 32 || !(secondRoot instanceof Uint8Array) || secondRoot.byteLength !== 32) return false;
  if (!Array.isArray(path) || path.some((hash) => !(hash instanceof Uint8Array) || hash.byteLength !== 32)) return false;
  if (firstSize === 0) return path.length === 0 && bytesEqual(firstRoot, EMPTY_MERKLE_ROOT);
  if (firstSize === secondSize) return path.length === 0 && bytesEqual(firstRoot, secondRoot);
  if (path.length === 0 || path.length > Math.ceil(Math.log2(Math.max(1, secondSize))) + 1) return false;

  const nodes = [...path];
  if (isPowerOfTwo(firstSize)) nodes.unshift(firstRoot);
  let fn = firstSize - 1;
  let sn = secondSize - 1;
  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let oldRoot = nodes[0];
  let newRoot = nodes[0];
  for (let index = 1; index < nodes.length; index++) {
    const node = nodes[index];
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      oldRoot = await merkleNodeHash(node, oldRoot);
      newRoot = await merkleNodeHash(node, newRoot);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      newRoot = await merkleNodeHash(newRoot, node);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(oldRoot, firstRoot) && bytesEqual(newRoot, secondRoot);
}

export class CompactMerkleAccumulator {
  constructor({ size = 0, peaks = [] } = {}) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("invalid accumulator size");
    this.size = size;
    this.peaks = peaks.map((peak) => (peak == null ? null : new Uint8Array(peak)));
  }

  async append(input) {
    let carry = await merkleLeafHash(input);
    let level = 0;
    let count = this.size;
    while ((count & 1) === 1) {
      const left = this.peaks[level];
      if (!(left instanceof Uint8Array)) throw new Error("corrupt compact Merkle accumulator");
      carry = await merkleNodeHash(left, carry);
      this.peaks[level] = null;
      count >>= 1;
      level++;
    }
    this.peaks[level] = carry;
    this.size++;
    return this;
  }

  async appendMany(inputs, { batchSize = 256, yieldTask } = {}) {
    for (let index = 0; index < inputs.length; index++) {
      await this.append(inputs[index]);
      if (yieldTask && (index + 1) % batchSize === 0) await yieldTask();
    }
    return this;
  }

  async root() {
    if (this.size === 0) return EMPTY_MERKLE_ROOT;
    let root = null;
    for (let level = 0; level < this.peaks.length; level++) {
      const peak = this.peaks[level];
      if (!peak) continue;
      root = root == null ? peak : await merkleNodeHash(peak, root);
    }
    if (root == null) throw new Error("corrupt compact Merkle accumulator");
    return new Uint8Array(root);
  }

  snapshot() {
    return { size: this.size, peaks: this.peaks.map((peak) => (peak == null ? null : new Uint8Array(peak))) };
  }

  static fromSnapshot(snapshot) {
    return new CompactMerkleAccumulator(snapshot);
  }
}
