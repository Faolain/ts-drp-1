# D.110c-0c1f3 corrected local audit

The bounded audit ran against the plan/evidence correction before commit.

- Prettier, with only the large plan formatter given an 8 GiB Node heap:
  `PASS` for the plan, `review-results.md`, and `source-audit.md`.
- `git diff --check`: `PASS`.
- Exact source-shape counts: one room `bootstrapOperation` field, one initial
  bootstrap issue site, one pinned-genesis helper, one covered-historical
  helper, one generic `reserve(operation)` signature, and zero occurrences of
  the proposed
  `exactCanonicalPinnedGenesisBootstrapOperationBytes` recovery field:
  `PASS`.
- Protected `.agents/`, `.claude/`, and `.pnpm-store/`: present.
- Stashes: exactly `27`.
- The diagnostic GREEN paths remain modified/untracked and were not staged as
  plan evidence.

The first combined shell diagnostic used `path` as a zsh loop variable. In zsh
that special array controls executable lookup, so the trailing stash/status
commands reported `command not found` after all formatter, diff, source-shape,
and protected-path checks had already passed. The corrected command used
`protected_item`; protected paths, stash count, and status then passed. This was
a read-only diagnostic error, not a code, plan, or product failure.
