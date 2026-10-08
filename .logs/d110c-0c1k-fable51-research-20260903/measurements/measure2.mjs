import { encodeCanonical } from "/Users/aristotle/Documents/Projects/ts-drp-1/packages/canonical/dist/src/index.js";
const H = "f".repeat(64); const MAX = Number.MAX_SAFE_INTEGER;
for (const [label, h] of [["height=MAX", MAX], ["height=76", 76], ["height=1", 1]]) {
  const child = { byteLength: MAX, digest: H, height: h, maxAuthor: H, minAuthor: H, subtreeSize: MAX };
  const node = { author: H, admittedThrough: MAX, height: h, kind: "drp-retired-author-registry-node", left: child, right: child, settledThrough: MAX, subtreeSize: MAX, version: 1 };
  console.log("registry node", label, encodeCanonical(node).byteLength);
}
const child = { byteLength: 1024, digest: H, height: 76, maxAuthor: H, minAuthor: H, subtreeSize: MAX };
const node = { author: H, admittedThrough: MAX, height: 76, kind: "drp-retired-author-registry-node", left: child, right: child, settledThrough: MAX, subtreeSize: MAX, version: 1 };
console.log("registry node byteLength<=1024,height 76:", encodeCanonical(node).byteLength);
console.log("int enc sizes:", encodeCanonical(MAX).byteLength, encodeCanonical(76).byteLength, encodeCanonical(1024).byteLength);
