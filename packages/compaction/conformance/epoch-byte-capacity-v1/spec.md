# Compaction epoch byte capacity v1

This additive, opt-in `CausalityIndex` profile accounts for inert numeric charges supplied by its caller.
It is provenance-neutral: it does not discover, authenticate, decode, encode or measure a carrier, verify
`parametersDigest`, select a supported profile or invoke a lazy charge authority. Phase 3a exclusively
owns those live bindings. Primitive acceptance proves only that caller-supplied charges fit.

`maxEpochBytes`, `initialByteCharges` and append's third `byteCharge` argument are optional so the existing
constructor and two-argument append calls remain valid. When `maxEpochBytes` is absent, byte accounting is
absent and legacy/Phase-0p-1 behavior is preserved. The append return remains exactly
`undefined | EpochFullOutcome`; byte saturation reuses the same frozen, closed, non-terminal and
non-latched `{ status: "pending", code: "EPOCH_FULL", latchByHash: false }`.

When `maxEpochBytes` is present it is a positive safe integer and `initialByteCharges` must be a Map whose
exact graph keyset is identical to the initial vertex Map's keyset, including the anchor without anchor
discovery. Membership and values are read exactly once from the Map's intrinsic entries and snapshotted
before snapshotting the graph keys and before vertex observation, traversal or bitset allocation. Therefore
an `initialByteCharges` accessor that mutates the graph produces an inconsistent charge/key snapshot and
stable `INVALID_BYTE_CHARGES`, rather than admitting an uncharged vertex. Overridden `size`, `keys`,
`entries`, `has`, `get` and iterator operations are ignored. An incompatible Proxy or Map pretender is
rejected with stable `INVALID_BYTE_CHARGES` before vertex observation; later mutation of a caller-owned Map
cannot change accounting. Every snapshotted charge is a positive safe integer. Initial precedence is
ceiling domain, invalid charge shape or keyset, count oversize, then byte oversize. `INVALID_BYTE_CHARGES`
identifies charge failures and `EPOCH_CAPACITY_EXCEEDED` identifies either initial capacity oversize.

This accessor-order behavior first went RED after GREEN in the corrective review's temporary
reversed-order module, which reported `ACCEPTED-BYPASS size=2 childCharged=false` while all then-frozen
17 rows still passed. The equivalent wrong ordering is now frozen as the controlled
`stale-initial-graph-snapshot` mutant; production was not reverted to manufacture a second RED.

The invariant is the anchor-inclusive sum of published charges at or below `maxEpochBytes`. Equality is
accepted. The normative exact test is `charge <= maxEpochBytes - total`; 32-bit coercion, truncation and
wrapping are forbidden. An exact duplicate charges zero. Any candidate refused by validation or capacity
charges zero and is freshly reevaluated on retry.

Append preserves duplicate-before-capacity and count-first O(1) saturation. If count capacity is already
full, it returns the shared `EPOCH_FULL` before observing the candidate or validating its byte charge.
Otherwise it once-captures and validates the inert charge and performs the byte precheck before candidate
observation. After all candidate fields and dependencies are captured, it rechecks both current ceilings
before bitset allocation or publication. A nested append therefore cannot overfill either capacity.

Publication is atomic. An exception after allocation rolls back the ancestor row, index row and byte total:
a three-way rollback. No refusal publishes a hash or relation, leaks capacity or latches a classification.
Opposing arrival orders may retain different transient vertices at saturation, but this primitive does not
name a winner or confer finality. Phase 5 owns certified final membership and its authenticated byte proof.

This family does not restamp or widen the frozen `epoch-capacity-v1` profile. In particular, that
predecessor remains an exact four-file directory and continues to state `claims.maxEpochBytes: false`.
