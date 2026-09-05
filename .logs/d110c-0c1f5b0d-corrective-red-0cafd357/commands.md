# Commands and results

- `shasum -a 256 -c manifest.sha256` in the accepted f5b0r design root —
  exit 0; `design.md`, `pre-review.md` and `next-prompt.md` verified.
- `pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts --no-coverage --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1f5b0d-corrective-red-0cafd357/focused.json`
  — expected exit 1; 12 tests, 9 passed, 3 failed, 0 skipped, no top-level
  error.
- `PLAYWRIGHT_JSON_OUTPUT_FILE=.logs/d110c-0c1f5b0d-corrective-red-0cafd357/browser.json pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts --grep 'authenticates settlement refusal' --reporter=json`
  — expected exit 1; one Chromium test, one expected causal failure, no retry,
  skip or flaky result.
- `pnpm exec eslint <four exact test owners> -f json -o .../eslint.json` —
  exit 0; zero errors. The shared inherited f5b0s fixture reports its existing
  JSDoc warnings; the three other owners report zero messages.
- `pnpm exec prettier --check <four exact test owners>` — exit 0.
- `git diff --check -- <four exact test owners>` before commit and
  `git show --check --oneline 0cafd357` after commit — exit 0.
- `git diff --name-only adab0f56..0cafd357` — exactly the four paths in
  `changed-paths.txt`.
- `git log --format='%H %G? %s' -1` — signed status `G` for the RED commit.
- `git rev-parse origin/codex/phase3a1b-p6-golden-path` — the RED commit after
  push.
- `git stash list | wc -l` — 27.

