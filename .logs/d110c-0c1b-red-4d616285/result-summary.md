# D.110c-0c1b RED result

The sole focused invocation is accepted as causal RED with one explicitly
recorded evidence-wrapper defect.

- Vitest selected exactly one test in exactly one file and reported one failure,
  zero passes, zero pending tests, and `success=false`.
- The failure is a rejected promise whose runtime message begins unique prefix
  `D110C_0C1B_COMMITTED_ISSUANCE_…`.
- The executed source contains exactly one literal with that prefix:
  `D110C_0C1B_COMMITTED_ISSUANCE_RECOVERY_REQUIRED`, and exactly one throw site
  for its constant.
- That throw is reached only after the fixture has proved the injected local
  journal append was not delegated, the issue returned `journal-rejected`, one
  additional pending outbox row exists in the exact issuance scope, current
  production completed genuine epoch 1→2 close, verified/adopted the successor,
  and the next genuine close returned exact
  `D110C_0C1A_RETIREMENT_CHECKPOINT_UNAVAILABLE` for the stale row.
- No fixture inserts, rewrites, deletes, republishes, or privately reclassifies
  the durable row. The dormant decorator delegates every operation except the
  one armed target append, which it blocks and rejects without writing.

The JSON reporter abbreviates long rejected-promise values for display, so the
complete token is established by the unique runtime prefix plus the exact
source-token/throw-site checks retained in `validation.txt`; no other source
token shares that prefix. The post-run zsh variable error lost only the saved
numeric exit code and wrapper timestamp after the complete reporter JSON was
already durable. It does not convert the failed report into a pass, and no
rerun is permitted or needed.

RED therefore demonstrates the intended production defect: an adopted active
room can close across a durably committed local issuance that failed before
live journal/graph admission, leaving a stale row that blocks the following
close. GREEN may now change only the frozen `v3-live.ts` halt/bind/fold checks.
