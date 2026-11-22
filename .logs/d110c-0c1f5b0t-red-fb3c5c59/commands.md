# Commands and statuses

1. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec vitest list tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`
   - exit 0; exactly 2 files and 35 tests selected.
2. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts --reporter=dot`
   - exit 1 as required by RED; 2 failed files, 23 failed tests, 12 passed tests.
3. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-settlement-progress.config.ts --reporter=line`
   - exit 1 as required by RED; exactly 1 Chromium test selected and failed with `accepted:false`, `errorCode:"ISSUANCE_INVALID_ARGUMENT"`, `plan:null`.
4. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check tests/fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.ts tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts packages/storage-browser/tests/phase-6b-settlement-progress-global-setup.ts packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts packages/storage-browser/playwright.phase-6b-settlement-progress.config.ts`
   - exit 0.
5. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint tests/fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.ts tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts packages/storage-browser/tests/phase-6b-settlement-progress-global-setup.ts packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts packages/storage-browser/playwright.phase-6b-settlement-progress.config.ts`
   - exit 0, zero warnings and zero errors.
6. `git diff fb3c5c59^ fb3c5c59 --check`
   - exit 0.
7. `git diff --check`
   - exit 0.
8. `git log --format='%H %G? %s' -1`
   - `fb3c5c599b8c50db55fcf361ea465531fbc90b2b G test(hardening): freeze segmented settlement progress red`.
9. `git stash list | wc -l`
   - `27`.
10. `git push origin codex/phase3a1b-p6-golden-path`
    - pushed `c70910a3..fb3c5c59`.
