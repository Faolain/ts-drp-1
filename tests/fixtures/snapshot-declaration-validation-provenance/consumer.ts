import assert from "node:assert/strict";

import { openCurrentAnchorTrust } from "../../../packages/protocol-v3/dist/src/public.js";

const cases = [
	{ id: "malformed-utf8", bytes: [5, 1, 255], reason: "record-decode-failed" },
	{ id: "truncated-string", bytes: [5, 1], reason: "record-decode-failed" },
	{ id: "nonminimal-length", bytes: [5, 128, 0], reason: "noncanonical-record" },
	{ id: "valid-string-schema-control", bytes: [5, 1, 65], reason: "record-schema-invalid" },
];
const results = cases.map((item) => {
	const observed = openCurrentAnchorTrust({
		expectedObjectId: `obj:${"a".repeat(32)}`,
		pinnedGenesisAnchorDigest: "a".repeat(64),
		exactCanonicalTrustStateRecordBytes: Uint8Array.from(item.bytes),
	});
	assert.deepEqual(observed, { ok: false, reason: item.reason });
	return { ...item, observed };
});
console.log(JSON.stringify({ owner: "actual public openCurrentAnchorTrust -> private decodeExact", results }));
