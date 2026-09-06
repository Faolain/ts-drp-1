You are an independent adversarial material confirmation reviewer for ts-drp D.110c-0c1k stage W0. Work read-only. Do not edit, run tests/builds, consult other reviewer outputs, or widen scope.

Repository: /Users/aristotle/Documents/Projects/ts-drp-1
Authoritative plan: docs/production-hardening/production-hardening-tdd-plan-v2.md, D.110c-0c1k and correction 909f4f5c. The legacy v1/v2 byte ceiling remains exactly 8192. Correct boundary matrix: 31/64 writer-only accept, 65 writer-only rejects by cap, 41 full-shape rejects by bytes. Settlement v3 remains 65536/maxItems8192/cap256.
Authoritative RED: 8860b4321938512180444ba0aa6adfbffbfdf810 with evidence .logs/d110c-0c1k-w0-red-8860b432/.
Initial GREEN: 0d6e38c2175806738cc568a56e19e9101a025d05 with evidence .logs/d110c-0c1k-w0-green-0d6e38c2/ and evidence commit 9ad3d9577369691f05da4d2dad666109fc1d97bf.
Initial Grok review passed. Initial Opus and Kimi reviews found one shared P1: W0 widened legacy version-1 ACL snapshot acceptance to allow an exact [admin,finality,referee,writer] tuple solely to support a faulty full-shape fixture.
Corrective tests-only RED: f511a18bdb35f56a31757f9739338f48572f00df. It removes referee from the v1 writer-only fixture and pins all referee-bearing v1 members, including the four-group tuple, as snapshot-mismatch. Against the initial GREEN the focused W0 tests remained 10/10 but the new direct ACL control failed 1/7 because production returned ok:true.
Corrective GREEN: a7a643ceb70ce5c6551de9920c01d2bc96edd464. It changes only packages/protocol-v3/src/latched-acl.ts, deletes the v1-to-v2 snapshot vocabulary exception, and makes validation/sorting use groupsForVersion(version). Recorded gates: W0 10/10, direct ACL 7/7, retained five-file ACL/settlement/close/adoption 49/49, protocol-v3 build/typecheck, Node build, exact lint/format/diff, and a fresh detached-worktree repetition all pass. Broad Node failures reproduce at the untouched parent and are unrelated.

Confirm the complete plan -> causal RED -> initial GREEN -> reviewer P1 -> corrective RED -> corrective GREEN history. Verify the sole P1 is closed without changing any boundary, profile, fence, share, close, wire/schema/API/dependency/crypto behavior. Recheck W0 cases 1-4 and fail-closed legacy compatibility. Do not demand W1/W2 or future settlement integration. Only P0/P1 block. Every P2 needs an owner/disposition.

Return exactly one JSON object and no prose:
{
  "verdict":"PASS|BLOCK",
  "redCausal":true,
  "scopePreserved":true,
  "p0":[{"id":"...","finding":"...","evidence":"path:line","requiredFix":"..."}],
  "p1":[{"id":"...","finding":"...","evidence":"path:line","requiredFix":"..."}],
  "p2":[{"id":"...","finding":"...","evidence":"path:line","owner":"...","disposition":"..."}],
  "notes":["..."]
}
