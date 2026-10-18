# Commands and results

## Runtime gates

- Focused `tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts` with
  coverage disabled and one worker: exit 0; 19/19 passed.
- Unchanged `tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts`: exit 0;
  12/12 passed.
- Chromium issuance-retention config filtered to `authenticates settlement
  refusal`: exit 0; exactly 1 expected pass, zero unexpected, flaky or skipped.
- Seven-file retained store/reclamation selector in `retained-files.md`: exit
  0; 134/134 passed. This is the recalculated total after removal of two
  invalid source/comment oracles; it does not reuse the former 136 count.
- Ten-file retained settlement/recovery selector in `retained-files.md`: exit
  0; 122/122 passed. This is the corresponding recalculated total, not the
  former 124 count.

## Build and static gates

- `pnpm --filter @ts-drp/node build`: exit 0.
- `pnpm --filter @ts-drp/node typecheck`: nonzero on the same 13 inherited
  test-root, worker-host, WebRTC fixture and compact-history helper diagnostics
  as the accepted earlier baseline. The normalized diagnostic hashes match;
  see `typecheck-baseline.md` and the complete `node-typecheck.log`.
- `pnpm exec eslint packages/node/src/v3-live.ts`: exit 0, zero errors and
  warnings (`eslint.json`).
- `pnpm exec prettier --check packages/node/src/v3-live.ts`: exit 0.
- `git diff --check`, `git show --check --oneline b384c7d9`, and the exact
  owner diff check: exit 0; only `packages/node/src/v3-live.ts` changed.

## Detached clean checkout

- Added a detached temporary worktree at exact signed GREEN `b384c7d9`.
- `pnpm install --offline --frozen-lockfile --ignore-scripts`: exit 0.
- Topological builds for `@ts-drp/node...`, `@ts-drp/storage-browser...`, and
  `@ts-drp/storage-node...`: exit 0.
- Isolated focused: 19/19; isolated seven-file retained store/reclamation:
  134/134; isolated ten-file retained settlement/recovery: 122/122.
- The temporary worktree was removed after completion.

The first isolated retained diagnostic built only the Node dependency closure.
Eleven fixtures then failed because the sibling storage package `dist` outputs
were freshly absent. That result was rejected as a build-order diagnostic. The
corrected topological command built both storage closures before rerunning; all
retained tests then passed without using main-checkout artifacts.

