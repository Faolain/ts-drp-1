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

The final v3 bootstrap is one exact checker, policy and spec transition from
signed ordinary-CI RED `6692cd4ff2aaf008d059b9f38b5c73f50e544831`.
When the caller-supplied upstream predates the policy, the checker derives that
transition as the first commit on the release tip's first-parent line, verifies
its exact parent and scope, and uses its policy and governed Git objects as the
immutable authority for the checked release tip. This accepts GitHub's
two-parent checkout merge and later product commits only while every governed
object remains identical to the reviewed bootstrap. Once the caller-supplied
upstream contains the policy, that upstream policy and its governed Git objects
remain the descendant authority. A candidate cannot authorize coordinated
policy-and-artifact drift by rewriting its own hashes.

Human-readable `git diff` output and exact planning/RED/GREEN choreography are
not release authority. The exhaustive historical mutation corpus remains an
explicit certification/release test and is not part of ordinary developer CI.
Its frozen executable baseline is signed commit
`5872fae3c57f0d16d2c45ad2d66f1f12d7152dd5`; certification materializes that
commit in an isolated clean worktree and runs its successor test with one
worker. Current default discovery never invokes that roughly 40-minute lane.
