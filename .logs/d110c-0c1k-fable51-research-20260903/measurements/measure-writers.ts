import { encodeCanonical } from "/Users/aristotle/Documents/Projects/ts-drp-1/packages/canonical/src/index.ts";

function hex64(i: number): string {
  return i.toString(16).padStart(8, "0").repeat(8);
}

function measure(n: number) {
  // ACL snapshot, writer-only shape
  const membersW = Array.from({ length: n }, (_, i) => ({
    author: hex64(i), finalityKey: null, groups: ["writer"],
  })).sort((a, b) => (a.author < b.author ? -1 : 1));
  const aclW = encodeCanonical({
    epoch: 4096, kind: "drp-v3-latched-acl", members: membersW,
    objectId: "room-abcdefgh", permissionless: false, version: 2,
  }, { maxBytes: 64 * 1024 * 1024, maxItems: 1 << 24 }).byteLength;

  // ACL snapshot, full shape (finality key + all 4 groups)
  const membersF = Array.from({ length: n }, (_, i) => ({
    author: hex64(i), finalityKey: hex64(i + 1_000_000), groups: ["admin", "finality", "referee", "writer"],
  })).sort((a, b) => (a.author < b.author ? -1 : 1));
  const aclF = encodeCanonical({
    epoch: 4096, kind: "drp-v3-latched-acl", members: membersF,
    objectId: "room-abcdefgh", permissionless: false, version: 2,
  }, { maxBytes: 64 * 1024 * 1024, maxItems: 1 << 24 }).byteLength;

  // Settlement checkpoint with N frontier triples, worst realistic widths
  const frontiers = Array.from({ length: n }, (_, i) => [hex64(i), 9_007_199_254_740_991 - 1, 9_007_199_254_740_991 - 1])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  const d = "f".repeat(64);
  const ckpt = encodeCanonical({
    closedAnchorDigest: d, closedEpoch: 9_007_199_254_740_990, commitQcRef: { byteLength: 4096, digest: d },
    currentAclDigest: d, cutValueDigest: d,
    frontiers,
    genesisAnchorDigest: d, historyRoot: d, historySize: 9_007_199_254_740_990,
    kind: "drp-creator-author-settlement-state", objectId: "room-abcdefgh",
    priorCheckpointDigest: d, priorCheckpointKind: "settled-v1",
    protocolMajor: 3, snapshotManifestDigest: d, successorAclDigest: d,
    successorAnchorDigest: d, successorEpoch: 9_007_199_254_740_991, version: 1,
  }, { maxBytes: 64 * 1024 * 1024, maxItems: 1 << 24 }).byteLength;

  // frontier triples alone (typical widths: epoch ~4 digits, boundary ~6 digits)
  const frontiersTypical = Array.from({ length: n }, (_, i) => [hex64(i), 1234, 654_321])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  const ckptTypical = encodeCanonical({ frontiers: frontiersTypical }, { maxBytes: 64 * 1024 * 1024, maxItems: 1 << 24 }).byteLength;

  console.log(`N=${n}\tACL(writer-only)=${aclW}B\tACL(full)=${aclF}B\tcheckpoint(max-widths)=${ckpt}B\tfrontiers-only(typical)=${ckptTypical}B\tper-triple(max)=${((ckpt - 831) / n).toFixed(1)}B`);
}

for (const n of [40, 64, 128, 256, 1024, 10000]) measure(n);
