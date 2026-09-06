# Compaction epoch capacity v1

This opt-in `CausalityIndex` constructor profile bounds one append-only active-epoch index. The
The third constructor argument, when present, must be a non-null non-array object. Its
`maxEpochVertices` positive safe-integer ceiling is anchor-inclusive: the anchor at position zero consumes
one slot, so an index admits at most `maxEpochVertices - 1` ordinary vertices. An omitted options argument,
`{}`, or `{ maxEpochVertices: undefined }` preserves the existing unbounded constructor and `append`
behavior. `Number.MAX_SAFE_INTEGER` is valid; larger, fractional and nonpositive ceilings reject.

An initially oversized graph is rejected with `EPOCH_CAPACITY_EXCEEDED` after the Map and option invariants
are checked but before anchor discovery, topological traversal, vertex access or bitset allocation. An
initial graph exactly at capacity is valid. This constructor refusal describes an unsupported local index
shape; it is not the ordinary append saturation outcome.

For a distinct candidate at capacity, `append` returns the exact frozen closed value
`{ status: "pending", code: "EPOCH_FULL", latchByHash: false }` before publication. The index publishes no
hash or ancestor row, creates no invalid tombstone and records no permanent classification. Redelivery is
therefore re-evaluated. An exact duplicate retains the existing `DUPLICATE_VERTEX` result and consumes no
additional capacity.

Caller re-entrancy cannot overfill the index. If candidate observation invokes a nested append that
consumes the final slot, the outer append rechecks capacity after all candidate fields and dependencies
have been captured but before dependency-bitset allocation or publication. The nested vertex remains
published and the outer vertex receives the frozen pending capacity outcome.

This primitive does not name or certify a final winner. Opposing delivery orders may have different
transient local membership at saturation; Phase 5 owns certified close-set membership. The capacity result
contains no candidate, member, winner, hash, finality or close identity.

This profile selects no desktop/mobile support ceiling and owns no live binding, subscription, transport
frame bytes, `maxEpochBytes`, blueprint operation bytes, execution meter, wall clock, instruction/fuel
budget, reducer work, collection-touch bound, finality or epoch close.
