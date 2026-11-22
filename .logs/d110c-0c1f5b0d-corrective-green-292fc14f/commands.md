# Commands and results

## Causal runtime gates

- `pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts --no-coverage --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1f5b0d-corrective-green-292fc14f/focused.json`
  — exit 0; exactly one file and 12/12 tests passed.
- `PLAYWRIGHT_JSON_OUTPUT_FILE=.logs/d110c-0c1f5b0d-corrective-green-292fc14f/browser.json pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts --grep 'authenticates settlement refusal' --reporter=json`
  — exit 0; one expected Chromium test, zero unexpected, flaky or skipped.
- The seven-file retained f5b0d/store/reclamation command listed in
  `retained-files.md` — exit 0; 136/136.
- The ten-file retained settlement/recovery command listed in
  `retained-files.md` — exit 0; 124/124.

## Build and static gates

- `pnpm --filter @ts-drp/issuance-store build` — exit 0.
- `pnpm --filter @ts-drp/storage-browser build` — exit 0.
- `pnpm --filter @ts-drp/storage-node build` — exit 0.
- `pnpm --filter @ts-drp/issuance-store typecheck` — exit 0.
- `pnpm --filter @ts-drp/storage-browser typecheck` — inherited exit 2 from
  pre-existing test-only alias and branded fixture diagnostics; the production
  build configuration passed.
- `pnpm --filter @ts-drp/storage-node typecheck` — inherited exit 2 from
  pre-existing cross-package test-root and fixture diagnostics; the production
  build configuration passed.
- Exact three-owner ESLint — exit 0.
- Exact three-owner Prettier check — exit 0.
- `git diff --check` before commit and `git show --check --oneline 292fc14f`
  after commit — exit 0.
- The deterministic source-shape audit found exactly one authenticated
  future-epoch predicate and one unchanged legacy exact-epoch predicate in
  each changed backend.

## Detached clean checkout

- Added a detached temporary worktree at exact commit `292fc14f`.
- `pnpm install --offline --frozen-lockfile --ignore-scripts` — exit 0.
- Topological `@ts-drp/storage-browser...` and `@ts-drp/storage-node...`
  builds — exit 0.
- Worktree-relative focused selector — exit 0; exactly 1 file, 12/12.
- Worktree-relative seven-file retained selector — exit 0; exactly 7 files,
  136/136.
- The temporary worktree was removed after completion.

An initial detached diagnostic passed absolute test paths to Vitest. Vitest
selected zero files and emitted `success:false`; it is rejected as a gate.
The command was corrected to worktree-relative selectors and exact nonzero
file/test assertions before the results above were accepted.

## Custody

- `git log --format='%H %G? %s' -1 292fc14f` — signature status `G`.
- `git rev-parse origin/codex/phase3a1b-p6-golden-path` — exact production
  commit after push.
- `git diff --name-only 292fc14f^ 292fc14f` — exactly the three production
  owners in `changed-paths.txt`.
- `git stash list | wc -l` — 27 before and after the work.
