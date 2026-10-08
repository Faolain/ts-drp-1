# D.109b GREEN evidence

This evidence belongs to the D.109b issuance-retention GREEN checkpoint on
2026-08-31 AST. No retained campaign ran.

The immutable causal RED remains commit
`db84a1addf28e655f7b5850fd540c4b9b6f5ca48`. GREEN added executable
verification for the migration and native-mutant cases already frozen by the
RED roster. Those additions are GREEN acceptance coverage; they do not
retroactively claim that every added assertion executed at RED.

Final results:

- focused Vitest: three reported files, 45/45 assertions passed, no skips or
  top-level errors;
- focused Chromium: 4/4 passed, including eleven genuine IndexedDB native-row
  mutants, no skips, unexpected results, flaky results or top-level errors;
- retained Vitest: 22 reported files, 183/183 assertions passed;
- retained Phase-2l Chromium lifecycle/death: 8/8 passed;
- retained Phase-2l Chromium parity: 3/3 passed;
- affected package builds and source-only typechecks: all passed; and
- exact-owner ESLint, Prettier and `git diff --check`: all passed.

Two expected-check corrections are retained honestly. The first Phase-2l
Vitest sweep passed 88/90 and found only stale schema-v1 expectations after the
reviewed v1-to-v2 migration. The first p2 contract sweep passed 9/10 and found
only its intentionally pinned terminal-owner hash. Both expectations were
updated to the reviewed current owners, then their final retained selections
passed. A read-only custody command also used the zsh-special loop variable
`path`, which erased `PATH` only inside that subprocess; the corrected command
used `protected_entry` and passed. None of these was a product failure.

The cleanup audit consolidated lineage equality/consumption in the shared
maintenance owner and removed two unused wrapper exports. Backend-specific
native row decoding, transactions and schema compatibility remain in their
own adapters.

The manifest is self-excluding: it hashes every other regular file directly
inside this evidence root and never hashes itself.
