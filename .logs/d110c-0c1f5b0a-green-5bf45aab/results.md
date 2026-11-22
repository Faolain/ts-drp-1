# D.110c-0c1f5b0a GREEN result

- Completed: `2026-09-04T04:41:54Z` on the integrated branch.
- Focused corrected suite: 10/10 passed.
- Retained batches: 44/44 protocol-v3, 31/31 Node/adoption/0c1a, 21/21 protocol-v2 registry, 25/25 anchor trust, and 16/16 current-author authorization.
- Frozen pnpm 10.24.0 install and package build passed. The lockfile change is the three-line protocol-v2 to protocol-v3 workspace edge only.
- Package public-surface smoke, settlement subpath import, typechecks, exact-owner lint, format, and diff checks passed. Protocol-v2 lint retained 20 pre-existing JSDoc warnings and no errors.
- Baseline-confirmed inherited failures remain outside this slice: Phase-6a unsupported-composition ordering (7/8) and the older 0b1 aggregate-retirement/cold-reopen fixture (1/2 and 1/3).
- No wire envelope, protobuf, cryptographic dependency, or root public API changed.
