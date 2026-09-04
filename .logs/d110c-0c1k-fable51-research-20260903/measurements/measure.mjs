import { encodeCanonical } from "/Users/aristotle/Documents/Projects/ts-drp-1/packages/canonical/dist/src/index.js";
const H = "f".repeat(64);
const MAX = Number.MAX_SAFE_INTEGER;
// --- settlement operation max shape: 8 application sources, 8 transform intents (1 per source), 8 replacement refs (1 per intent), entryCount 16
const ref = { entryCount: 16, entryIndex: 15, operationDigest: H, vertex: [MAX, H, MAX, H] };
const intent = { coveredStateDigest: null, operationDigest: H, operationIndex: 0, outcome: "transform", replacements: [ref], semanticIdentityDigest: H };
const src = (i) => ({ dispositions: [intent], kind: "application", operationCount: 1, source: [MAX, H, MAX, H] });
const op = { action: "$drp.author-settlement.v1", statement: { kind: "source-dispositions", sources: Array.from({length: 8}, (_, i) => src(i)), version: 1 } };
console.log("settlement op 8/8/8 transform:", encodeCanonical(op).byteLength);
// alt: 1 source with 8 intents each 1 replacement
const op2 = { action: "$drp.author-settlement.v1", statement: { kind: "source-dispositions", sources: [{ dispositions: Array(8).fill(intent), kind: "application", operationCount: 8, source: [MAX,H,MAX,H] }], version: 1 } };
console.log("settlement op 1 source/8 intents/8 refs:", encodeCanonical(op2).byteLength);
// alt: 8 sources, 1 intent each with 8 replacement refs? that would be 64 refs > 8 total; not allowed. 8 sources: 7 zero-intent + 1 application with 8 intents/8 refs
const zi = { kind: "zero-intent", source: [MAX,H,MAX,H], sourceAction: "causalJoin" };
const op3 = { action: "$drp.author-settlement.v1", statement: { kind: "source-dispositions", sources: [ ...Array(7).fill(zi), { dispositions: Array(8).fill(intent), kind: "application", operationCount: 8, source: [MAX,H,MAX,H] } ], version: 1 } };
console.log("settlement op 7 zero-intent + 1 app(8 intents/8 refs):", encodeCanonical(op3).byteLength);
// 8 sources, 8 intents distributed, plus already-present with covered digest (longer than null)
const ap = { coveredStateDigest: H, operationDigest: H, operationIndex: 0, outcome: "already-present", replacements: [], semanticIdentityDigest: H };
const op4 = { action: "$drp.author-settlement.v1", statement: { kind: "source-dispositions", sources: Array.from({length:8}, () => ({ dispositions: [ap], kind: "application", operationCount: 1, source: [MAX,H,MAX,H] })), version: 1 } };
console.log("settlement op 8 sources already-present (no refs):", encodeCanonical(op4).byteLength);
// mixed: 8 sources; 7 app each 1 transform intent w/1 ref, 1 app w/1 transform intent w/1 ref => 8 intents/8 refs (same as op). Try 4 sources with 2 intents each, 8 refs
const op5 = { action: "$drp.author-settlement.v1", statement: { kind: "source-dispositions", sources: Array.from({length:4}, () => ({ dispositions: [intent,intent], kind: "application", operationCount: 2, source: [MAX,H,MAX,H] })), version: 1 } };
console.log("settlement op 4 sources x2 intents:", encodeCanonical(op5).byteLength);
// --- checkpoint max shape
const cp = {
 closedAnchorDigest: H, closedEpoch: MAX, commitQcRef: { byteLength: MAX, digest: H }, currentAclDigest: H, cutValueDigest: H,
 frontiers: Array.from({length: 64}, (_, i) => [i.toString(16).padStart(64, "0"), MAX, MAX]),
 genesisAnchorDigest: H, historyRoot: H, historySize: MAX, kind: "drp-creator-author-settlement-state",
 objectId: "x".repeat(256), priorCheckpointDigest: H, priorCheckpointKind: "settled-v1", protocolMajor: 3,
 retiredAuthorRegistryRoot: H, retiredAuthorRegistrySize: MAX, snapshotManifestDigest: H, successorAclDigest: H,
 successorAnchorDigest: H, successorEpoch: MAX, version: 1, detachedCreatorSignature: new Uint8Array(64),
};
console.log("checkpoint 64 frontiers signed:", encodeCanonical(cp).byteLength);
// v1 aggregate for comparison
const v1 = { closedAnchorDigest: H, closedEpoch: MAX, commitQcRef: { byteLength: MAX, digest: H }, currentAclDigest: H, cutValueDigest: H, frontiers: Array.from({length: 64}, (_, i) => [i.toString(16).padStart(64, "0"), MAX]), genesisAnchorDigest: H, kind: "drp-creator-author-issuance-frontiers-state", objectId: "x".repeat(256), priorAggregateCandidateDigest: H, protocolMajor: 3, snapshotManifestDigest: H, successorAclDigest: H, successorAnchorDigest: H, successorEpoch: MAX, version: 1, detachedCreatorSignature: new Uint8Array(64) };
console.log("v1 aggregate 64 signed:", encodeCanonical(v1).byteLength);
// --- registry node max shape
const child = { byteLength: MAX, digest: H, height: MAX, maxAuthor: H, minAuthor: H, subtreeSize: MAX };
const node = { author: H, admittedThrough: MAX, height: MAX, kind: "drp-retired-author-registry-node", left: child, right: child, settledThrough: MAX, subtreeSize: MAX, version: 1 };
console.log("registry node 2-child:", encodeCanonical(node).byteLength);
