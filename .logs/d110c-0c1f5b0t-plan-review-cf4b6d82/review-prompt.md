You are an independent read-only design reviewer for ts-drp production hardening.

Review signed commit cf4b6d820031a546a8013b500be7bfac100a8a3f against its parent, focusing only on the new D.110c-0c1f5b0t segmented settlement replacement-progress prerequisite and its effect on the blocked parent f5b integration. Inspect the named production seams in packages/issuance-store/src/types.ts, packages/issuance-store/src/contract.ts, packages/storage-memory, packages/storage-browser, packages/storage-node, packages/node/src/v3-live.ts, and examples/v3-room/src/index.ts. Also inspect the accepted design at .logs/d110c-0c1f5b0r-design-3a156aca/design.md and the 64-writer/f5b/D.110c-d acceptance text in the plan.

Judge whether the proposed contract is sufficiently exact, causal, compatible, bounded, and testable before tests-only RED. In particular check:

1. crash-safe exactly-once progress across genuine split-required replacement vertices;
2. binding of the ordered replacement operations, progress ranges, issued operation count, allocated replacement sequence, CAS revision, outbox/lineage, and ambiguous-outcome readback;
3. whether 16 is the correct bound derived from the existing application-batch contract and whether transform/rebase can exceed it;
4. legacy four-key entry and two-key effect compatibility, old unlinked migration, old linked completion, browser schema and Node storage compatibility, and old-reader fail-closed behavior;
5. whether the room can safely resume after crashes around partial issue, publication, close, and reopen without duplicate, skipped, or substituted intents;
6. stable error ownership and pre-mutation rejection;
7. hidden changes to wire/protobuf, authority, cryptography, thresholds, workloads, public Node APIs, or the already frozen 64-writer/repeated-room obligations;
8. whether the RED matrix will fail for the intended missing behavior rather than missing imports/exports.

Do not propose hostile-local-operator evidence machinery or unrelated redesign. Findings must cite concrete file/line or plan evidence and state the smallest correction. Classify only material correctness/security/scope blockers as P0/P1. P2 is nonblocking but must be actionable.

Return exactly one JSON object with this shape and no markdown:
{"verdict":"PASS|CHANGES_REQUIRED","p0":[{"title":"...","evidence":"...","correction":"..."}],"p1":[{"title":"...","evidence":"...","correction":"..."}],"p2":[{"title":"...","evidence":"...","disposition":"..."}],"summary":"..."}
