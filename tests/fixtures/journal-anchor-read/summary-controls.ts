import assert from "node:assert/strict";

import { summarize } from "./material.js";

const scope = Object.freeze({ objectId: "pure-control", epoch: 0, anchorDigest: "0".repeat(64) });
const bytes = Uint8Array.of(1, 2, 3);
const nativeFrozen = Object.freeze({ kind: "present", ok: true, scope, exactCanonicalAnchorPreimageBytes: bytes });
const first = summarize(nativeFrozen) as Record<string, unknown>;
assert.equal(first.frozen, true);
assert.equal(Object.isFrozen(first), false);
assert.equal((summarize(first) as Record<string, unknown>).frozen, false);
console.log("PASS old double-summary counterexample: the native true observation is overwritten by wrapper false");

assert.equal(first.scopeFrozen, true);
const unfrozenScope = { ...scope };
const nativeUnfrozen = { ...nativeFrozen, scope: unfrozenScope };
assert.deepEqual(summarize(nativeUnfrozen), {
	...nativeUnfrozen,
	exactCanonicalAnchorPreimageBytes: [1, 2, 3],
	frozen: false,
	scopeFrozen: false,
});
const forged = { ...nativeUnfrozen, frozen: true, scopeFrozen: true };
assert.deepEqual(summarize(forged), {
	...forged,
	exactCanonicalAnchorPreimageBytes: [1, 2, 3],
	frozen: false,
	scopeFrozen: false,
});
console.log("PASS native frozen/unfrozen provenance: forged transport fields cannot override actual observations");

bytes.fill(99);
assert.deepEqual(first.exactCanonicalAnchorPreimageBytes, [1, 2, 3]);
assert.deepEqual(Array.from(bytes), [99, 99, 99]);
assert.equal(first.frozen, true);
const independentBytes = Uint8Array.of(1, 2, 3);
const second = summarize(
	Object.freeze({ ...nativeFrozen, exactCanonicalAnchorPreimageBytes: independentBytes })
) as Record<string, unknown>;
assert.deepEqual(second.exactCanonicalAnchorPreimageBytes, first.exactCanonicalAnchorPreimageBytes);
assert.notEqual(second.exactCanonicalAnchorPreimageBytes, first.exactCanonicalAnchorPreimageBytes);
independentBytes.fill(88);
assert.deepEqual(second.exactCanonicalAnchorPreimageBytes, [1, 2, 3]);
console.log("PASS capture-before-mutation timing and detached pure observation copies; not native accessor GREEN");
