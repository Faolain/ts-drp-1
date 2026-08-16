# Protocol v3 freeze successor

This owner proves a bounded release-provenance claim: the governed files at the
checked release commit are the reviewed regular Git blobs, required workflows
still route through the genuine checker, and current root-checker failures are
not suppressed. It does not claim runtime protocol or product security.

The checker accepts a clean linear release tip or a genuine two-parent GitHub
merge ref rooted at the caller-supplied upstream. It authenticates the release
tree, exact governed path inventory, regular-blob mode/type, full Git object ID,
raw blob SHA-256, and two current root-checker process results. Missing, mixed,
malformed, wrong-mode, wrong-type, wrong-parent, wrong-tree, dirty or suppressed
evidence fails closed.

The final v3 bootstrap is one exact transition from signed ordinary-CI owner
`eb84a71ee5e55bc7aecafab8a80a4dde07aa0ec0`: checker, policy and spec plus the
ordinary Git harness, routing analyzer and their semantic tests whose obsolete
workflow-string or root-resolution assumptions were retired. Once the caller-
supplied upstream contains this v3 policy, that upstream policy and every
governed Git object are the immutable descendant authority. A candidate cannot
authorize coordinated policy-and-artifact drift by rewriting its own hashes.

Human-readable `git diff` output and exact planning/RED/GREEN choreography are
not release authority. The exhaustive historical mutation corpus remains an
explicit certification/release test and is not part of ordinary developer CI.
Its frozen executable baseline is signed commit
`5872fae3c57f0d16d2c45ad2d66f1f12d7152dd5`; certification materializes that
commit in an isolated clean worktree and runs its successor test with one
worker. Current default discovery never invokes that roughly 40-minute lane.
