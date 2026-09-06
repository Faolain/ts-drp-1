# D.110c-0c1f5b0d corrective GREEN

This immutable packet records the narrow backend correction at signed and
pushed production commit `292fc14f15a27befcd782a0eddf9aed23551619c`, based
on the signed and pushed corrective RED `0cafd35762a8a1c3c5767c89227f9f42c5e89729`
and ownership reslice `adab0f56428bf0290a4437c83083db18e17eb2dc`.

All three authenticated pruning owners now reject a candidate issuance row
whose decoded epoch is newer than `closedEpoch`, before either row table or
the pruning watermark is mutated. The existing invalid-argument owner emits
`ISSUANCE_INVALID_ARGUMENT`. Authenticated pruning continues to accept mixed
pending/published rows from epochs at or below the authenticated close;
legacy pruning retains its exact-epoch and published-only rules.

The focused matrix is 12/12 and the real Chromium IndexedDB case is 1/1. The
retained store/reclamation matrix is 136/136, the retained settlement and
recovery matrix is 124/124, and the corrected detached-checkout proof is
12/12 focused plus 136/136 retained after an offline frozen install and
topological dependency builds.

This checkpoint deliberately does not claim a genuine close/adopt production
caller or the settlement-profile recovery-scan correction. Those obligations
remain assigned to parent f5b by `adab0f56`; no comment, source-text match, or
manufactured receipt is used as reachability evidence here.
