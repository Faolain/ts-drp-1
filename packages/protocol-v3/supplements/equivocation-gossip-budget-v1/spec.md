# Equivocation gossip budget v1

This additive deep-only profile composes `equivocation-author-projection-v1` without amending its
durable projection, recovery, pending-handoff, or at-least-once consequences. It consumes only an
author and detached digest sets grouped by full `(objectId, author, authorSequence)` scope. It does not
consume the durable author-projection object itself.

The composer once-captures all scalar fields and caller-owned arrays by index. It never dispatches a
caller-owned Array method or iterator. Duplicate slot entries are merged by scope, duplicate digests
collapse, self-pairs are absent, and every selected item is the existing structured identity:
`(scope, canonical unordered distinct digest pair)`. This profile creates no second pair-ID namespace.

All normalized pair tuples across the author are ordered by `objectId` code-unit order, numeric
`authorSequence`, lesser digest code-unit order, then greater digest code-unit order. No locale API or
locale-sensitive comparator participates. `maxGossipPairCount` is an explicit nonnegative safe integer.
The result is the canonical first N tuples and exact derived `totalPairCount`, `suppressedPairCount` and
`saturated` values. Caller-provided counts are never authority. Below and at the pair total, nothing is
suppressed; above the budget, saturation changes the composition output only.

The explicit count bounds the selected output, not the already-detached input or the work required to
derive every exact pair. Pair derivation remains quadratic in the digest count of each slot. This
profile therefore claims no global evidence bound and no global computation bound. A smaller
protocol-wide input ceiling requires separate governance; this profile does not invent one.

The composer reads no pending rows, proof bodies, `Uint8Array` evidence, `state.proofs`, received
vertices, admission result, verification result, materialization result, resolver output, ACL state,
reputation or future reputation, `slotSignal`, durable transaction, recovery, handoff, transport,
clock, randomness, locale, default store, or mutable module state. It neither mutates caller inputs nor
any durable state, and duplicate, reordered, retried or concurrently derived equivalent projections
produce byte/deep-equal output.

This slice adds no v2 implementation, no reputation composition, no ACL mutation, no gossip transport,
no persistence, no payload outbox, no witness or proof compaction, no acknowledgement API, no token
bucket, and no Phase 0n math work.
