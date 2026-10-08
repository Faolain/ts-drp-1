# D.110c-0c1f5b0t deterministic RED correction

Tests-only correction commit: `c1d602f6566d6a5a5743170efd62ef1aa7685712`

The first room split test no longer samples `nextSequence` after an arbitrary
number of microtasks. It awaits the independently requested public issue,
closes the session, and then requires the deterministic final cursor `24`:
fence `20`, replacement chunks `21` and `22`, and public issue `23` are the
only allocations. The rejected `split-required` attempt must allocate none.

Verification used a detached temporary worktree at the signed correction
commit, so none of the seven concurrent, uncommitted GREEN production changes
could affect the result. The checkout installed from the offline lockfile,
built all workspace packages, listed exactly two focused files and 35 tests,
and ran the same causal RED matrix: 23 intended behavioral failures and 12
passing controls. The corrected assertion observed cursor `21` rather than
required cursor `24` only after the awaited issue and deterministic close,
because the RED product path still stops at the first split. This is the
intended missing segmented-settlement behavior, not event-loop timing.

No failure came from a missing import or export. No product, plan, dependency,
wire contract, workload, threshold, stash, or protected untracked path was
changed by the correction. The seven authorized concurrent production paths
were left unstaged and uncommitted; all 27 stashes were preserved.
