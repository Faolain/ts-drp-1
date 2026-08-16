# Slice 03: Local Issue, Apply and Publish

Add one local durable operation path using the P6-resolved author, the shipped
admission-bound issuer and the same serialized apply gate.

The order is durable issue, journal local reference, index append, visible
observation and pending publication. Recovery must collapse every crash boundary
without fabricating a row, reusing a sequence or repeating an effect.

## Shipped checkpoint

The tests-only RED is signed at `2aa68ce`; the bounded issuance-page fixture
correction is `b1519c6`, and the predecessor live-plane contract migration is
`3c54ba9`. The one-owner production GREEN is signed at `8ec5baf`.

The active handle now resolves the recovered author, uses the genuine
admission-bound transactional issuer, appends the durable local journal
reference, extends the retained causality index, and only then exposes the
accepted vertex. Pending publication uses the existing outbox path and the same
registration gate, so it cannot overtake local apply.

Final evidence was 79/79 across nine focused and preservation files in 19.87
seconds, plus the node build, ESLint, Prettier, and diff checks. The package-wide
typecheck still reports only the previously recorded compact-history helper
union errors. Slice 03 is closed; Slice 04 owns the first two-client room
exchange and this checkpoint does not claim reconnect convergence.
