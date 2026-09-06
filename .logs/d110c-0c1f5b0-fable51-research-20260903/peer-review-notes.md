# Peer review of solution.md (received 2026-09-03, verbatim)

Verdict: the peer found the right simplification, but the proposed solution is not safe enough to implement exactly as written.

The path should change from `per-gap settlement + retired-key Merkle dictionary` to something closer to `author fence + membership incarnation + one terminal boundary`. But two serious issues must be corrected first.

## What the peer got right

1. The motivating "11 admitted while 10 is missing" case is unreachable for an honest local author (verified at v3-live.ts:3711, :3862, :6217). A Byzantine author could sign 11 without depending on 10, but that should stall or fence that author, not block the room. The large per-source settlement grammar is probably unnecessary.
2. A coarse author-signed fence ("everything below sequence m is now terminal: it was either admitted or I am abandoning it") can replace per-gap source lists, replacement references in the creator checkpoint, `already-present`, `coveredStateDigest`, application-level presence queries, zero-intent records, and settlement-control supersession chains.
3. One boundary is probably sufficient. It must mean "every sequence at or below this number is terminal and must never be replayed", NOT "every row was admitted". The solution's sentence claiming all rows below `settledThrough` were admitted is incorrect and contradicts fence semantics. Rename to `terminalThrough` or `accountedThrough`.
4. The retired-author AVL structure is likely unnecessary if removal means never-admitted operations from the old membership incarnation can no longer be introduced directly.

## Blocking problem 1: the fence is published too early

Proposed ordering `fence published -> replacements issued -> sources completed` is unsafe:

1. Author publishes fence saying old operation 10 is abandoned.
2. Creator closes the epoch containing the fence.
3. Client crashes before issuing replacement R.
4. On restart, operation 10 is below the terminal boundary.
5. The terminal rule forbids rebasing it. The operation is silently lost.

"Partial evidence survives because the source remains pending" does not help: after the fence is in a checkpoint, that source is terminal and must not be processed again.

Correct ordering per the peer: choose base sequence m; durably decide every displaced source; issue and durably link replacements at sequences >= m; issue the fence last; fence causally depends on all replacements; creator checkpoint incorporates fence; old sources become terminal; prune only after adoption/rollback gates. Example: displaced 10, 11; lineage next 12; replacement for 10 = seq 12; for 11 = seq 13; fence outer seq 14 with fenceSequence 12. Because the fence causally depends on 12 and 13, any causally closed graph containing the fence also contains the replacements.

A crash after replacement but before the fence still needs idempotency: the issuance store must durably remember `old source -> replacement identity`, or perform source completion and replacement issuance in one atomic transaction; otherwise restart could issue the replacement twice. The link can remain private to the author; the creator does not need the replacement-reference grammar, but the crash-safe ownership must be designed explicitly.

## Blocking problem 2: the global sequence floor is the weakest part

Kafka, MLS etc. use `identity + incarnation/epoch + local counter`; they do not make one producer's counter determine every other producer's start. A global floor couples authors (Alice active -> floor 5,000,000 -> new Bob starts above it), requires the `K x epochs` bound against a malicious author pushing the floor toward MAX_SAFE_INTEGER, and the report has not proved `maxEpochVertices + maxPendingEntries` is the true per-epoch maximum of durable author sequences (`maxPendingEntries` primarily bounds network pending ingress, not every local issuance/crash outcome). The floor only dominates sequences accounted by a checkpoint, not every never-admitted sequence issued on another device, so the claimed lifetime uniqueness is already weakened.

## Prefer `admissionEpoch` over the global floor

Effective author identity = public key + admission epoch/incarnation. `(Alice, admissionEpoch 4, seq 10)` and `(Alice, admissionEpoch 19, seq 10)` are different incarnations. Checkpoint frontier `[author, admissionEpoch, terminalThrough]`. The current ACL record carries `admissionEpoch`; a continuously retained member keeps it; a fully removed and re-added key receives the new admission epoch. Then old-incarnation vertices stay bound to their old epoch/anchor; old-incarnation ops cannot enter the new incarnation; no retired-key dictionary; a malicious author exhausts only its own incarnation's sequence space; no shared floor; no invented `K x epochs` bound; matches prior art. Requires explicit changes to: ACL schema, issuance-store scope, recovery classification, pruning watermarks, equivocation identity. Wider mechanical change than one integer but conceptually cleaner.

## Recommended corrected construction

1. Membership incarnation: creator-authenticated `admissionEpoch` per ACL member.
2. Incarnation-scoped sequence: durable operation identity = object + author + admissionEpoch + authorSequence; whether the sequence resets on re-entry or continues locally is irrelevant to security.
3. One terminal frontier `[author, admissionEpoch, terminalThrough]`.
4. Replacement-first processing at successor open: load displaced rows; classify expire/rebase/transform/manual-review; manual review blocks the fence; durably issue/link replacements first; issue the fence last; fence causally depends on replacements.
5. Author fence `{ action: "$drp.author-fence.v1", fenceSequence: m }` declaring older unresolved slots terminal; creator validates it from the complete causally closed graph.
6. Safe cleanup only after the fence is in the authenticated checkpoint, the successor is adopted, and rollback/availability gates pass.

## Retained findings from solution.md

Inverted admitted/settled rules; `readRebaseOutbox` excludes published rows; rows older than one predecessor unclassifiable; missing lineage/incarnation init owner; closure validators reject the new profile; prior-less writer check can block close; `completeRebaseSource` conflicting authority; cleanup not wired; cold reopen scans too much; non-creator hot-follow missing; journal/snapshot/seal scopes not reclaimed; >=100-transition gate absent; Phase 7 archive-root producer missing.

## This does not replace WRAPS

Fence/incarnation solves per-author epoch settlement, not cold-client trust in a rotating root authority. Separate layer.

## Final recommendation

Do not continue with the per-gap grammar and retired-key AVL. Do not implement the exact `sequenceFloor` proposal. Next design checkpoint: compact author fence + admissionEpoch incarnation + one terminal boundary + replacement-before-fence causal ordering + crash-safe local source/replacement custody. Then deterministic RED cases for: delayed dependency; crash before replacement; crash after replacement but before fence; crash after fence but before checkpoint; fence admitted without replacement (must be impossible); author absent for multiple epochs; full removal and same-key re-entry; fresh-device re-entry; stale old-incarnation delivery; duplicate replacement prevention; manual-review hold; Byzantine fence jump; pruning only after authenticated adoption; repeated restart/reopen across at least three transitions.
