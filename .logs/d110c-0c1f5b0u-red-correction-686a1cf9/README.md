# Corrective migration RED — not GREEN

Signed/pushed tests-only correction `686a1cf9de5fbde64b990199e5ba2df9e5dac2e5`
replaces only the invalid migration-success construction. The former two
33,000-byte transformed messages exceeded the existing 32,768-byte migration
state cap. Every large settlement split/fault test body remains unchanged.

The migration control now uses two 100-byte messages, a one-shot signed
legacy-replacement lost receipt through the real store, per-object room-head
custody, and explicit success assertions for both rehearsal and activation.
Prettier, ESLint and diff checks passed before its signed commit and push.

The exact correction was run once in isolated checkout
`/tmp/d110c-f5b0u-corrective-red-zN4Qas/checkout` with only the frozen rejected
seven-path candidate overlay. Patch SHA-256 remains
`1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9`.
All seven resulting source hashes were checked before/after. No current GREEN
production edits were copied to that checkout. `identity.json` captures the
unchanged main dirty-worktree and 27-stash hashes separately.

Frozen offline install, fresh package builds, and exact listing passed. The
one focused run failed causally: queued public issue, migration rehearsal,
and migration activation all rejected because the rejected implementation
does not recover the signed failure onto a fresh handle. There was no timeout,
state ceiling, floor mismatch, import failure, or top-level loader failure.
Exactly one test was selected in one file, with eight unselected tests skipped.
`validation.json` preserves all three complete assertion failures and records
`CAUSAL_CORRECTIVE_RED_NOT_GREEN`. Commands, complete stdout/stderr and reporter
JSON are retained. This root supersedes only the invalid migration fixture's
RED attribution, not any prior immutable evidence or acceptance result.

Combined GREEN and all static/retained/isolated/review gates remain due.
