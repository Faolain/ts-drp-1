# D.110c-0c1f5a first focused diagnostic

- Signed/pushed source anchor: `eeaaaca8d7a30a84fda321b37544d57b6cc1c1f4`
- Source tree: `ed189c8fd4cfae67be1937e5f5799769ea2a6449`
- Started and completed on 2026-09-03 under the one authorized focused RED execution.
- Runner status: `1`.
- Exact selection: one test file and one test title.
- Classification: `NONCAUSAL_DIAGNOSTIC`; this is not an accepted RED.

The first null-prior treatment completed its setup and observed the exact current
`D110C_0C1F1_LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED` close error. The following
absent-prior treatment did not reach issuance-frontier classification. It failed
earlier with `creator snapshot export failed: not-active`.

Read-only source tracing establishes the ordering. Creator close calls
`registration.stageSnapshot()` before `authorIssuanceFrontiersCandidate()`.
`stageSnapshot()` calls `stageBlueprintEpoch()`, whose `foldBlueprintEpoch()`
authorization callback evaluates each graph operation against the current
latched ACL. The fixture had revoked the foreign writer in the current epoch and
only staged a grant for the successor ACL. Its current-epoch application row was
therefore unauthorized and the snapshot failed closed before the intended
author-reentry branch.

The corrected plan does not relabel this as a product failure. It removes the
noncausal absent-prior treatment from f5a, retains the current authorization
refusal, and assigns the reachability/meaning of an authenticated writer absent
from the prior aggregate to the f5b admitted-set and membership audit. The
corrected f5a RED substitutes a current-writer removal case: the foreign writer
is valid under the current ACL, the same close removes it from the successor
writer set, and duplicate classification currently aborts before successor-set
filtering.

The correction also makes the coverage obligation precise. A valid authorized
application vertex remains in the authenticated close-set/history and is not
rewritten or discarded by f5a. Only the aggregate issuance frontier must refuse
to advance across the anomalous sequence range.
