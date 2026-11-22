# Commands and results

Temporary checkout: `/tmp/d110c-f5b0t-red-correction.lAIya8/checkout`

1. `git worktree add --detach /tmp/d110c-f5b0t-red-correction.lAIya8/checkout c1d602f6566d6a5a5743170efd62ef1aa7685712`
   - exit 0; detached at the signed correction commit.
2. `pnpm install --offline --frozen-lockfile --ignore-scripts`
   - exit 0.
3. `NODE_OPTIONS=--max-old-space-size=8192 pnpm build:packages`
   - exit 0.
4. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec vitest list tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`
   - exit 0; exactly 2 files and 35 tests selected.
5. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts --reporter=dot`
   - exit 1 as required by RED; exactly 23 failed and 12 passed tests.
   - corrected final-cursor assertion: actual `21`, required `24`, after awaited public issue and close.
   - unexpected, missing-import/export, and timing-only failures: 0.
6. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`
   - exit 0.
7. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`
   - exit 0, zero warnings and errors.
8. `git diff c1d602f6^ c1d602f6 --check`
   - exit 0.
9. `git log --format='%H %G? %s' -1`
   - `c1d602f6566d6a5a5743170efd62ef1aa7685712 G test(hardening): make settlement split cursor deterministic`.
10. `git ls-remote origin refs/heads/codex/phase3a1b-p6-golden-path`
    - remote ref equals `c1d602f6566d6a5a5743170efd62ef1aa7685712` before this evidence commit.
11. `git stash list | wc -l`
    - `27`.
