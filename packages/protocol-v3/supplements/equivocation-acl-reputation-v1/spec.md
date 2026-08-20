# Equivocation ACL-visible reputation v1

This additive deep-only profile consumes exactly one once-detached single-author digest-set projection
from `equivocation-author-projection-v1`. It is a reputation observation for an ACL consumer, not ACL mutation or admission authority. It does not consume 0o-b2 selected pairs or saturation.

The composer once-captures scalar fields and caller-owned arrays by index, never dispatches a caller
Array, Set, or Map method or iterator, and returns a fresh closed aggregate:
`{ author, equivocatingSlotCount, totalCanonicalPairCount, reputationPenalty, saturated }`.
It accepts empty and single-digest scopes. Duplicate full scopes are unioned collision-safely; duplicate
digests collapse. For each normalized scope with `n` distinct digests, the independently auditable
contribution is `C(n,2)`, its canonical unordered distinct digest-pair count. `equivocatingSlotCount`
counts contributions greater than zero and the total is their exact safe-integer sum. No per-slot detail,
selected-pair list, or second pair identity is exposed.

`maxReputationPenalty` is an explicit nonnegative safe integer in canonical unordered distinct digest-pair
units. Higher penalty means worse reputation. The natural unweighted formula is
`min(totalCanonicalPairCount, maxReputationPenalty)`; there is no baseline, magic constant, or weight.
The cap changes composition output only. Empty total with cap zero is unsaturated; nonempty total with cap
zero is saturated. Any unsafe per-scope or aggregate count fails closed.

Normalization is expected O(total captured digest entries) work with local implementation-owned membership
structures; it does not materialize or sort all pairs. There is no global input, computation, or evidence
bound. This profile cannot infer recovery completeness: trusted-store/FIFO starvation, conditional recovery,
and at-least-once handoff remain D.65 residuals, not inputs.

The composer reads no pending rows, proof bodies, received vertices, admission, verification,
materialization, resolver, durable projection, recovery, handoff, ACL contents, policy storage, gossip
budget, clock, locale, randomness, transport, store, cache, or mutable global state. It never mutates
caller input, ACLs, admission, resolution, `slotSignal`, proof verification, durable state, or gossip.

This slice adds no v2, no live ACL binder, no admission rule, no transport, no persistence, no token bucket,
no compaction, no global evidence bound, no Phase 0n work, and keeps `@ts-drp/math` and broader Rapier-WASM
out of scope.
