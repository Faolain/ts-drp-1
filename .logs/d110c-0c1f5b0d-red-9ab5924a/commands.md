# Commands and results

- `sha256sum -c manifest.sha256` in
  `.logs/d110c-0c1f5b0r-design-3a156aca/` — exit 0; `design.md`,
  `pre-review.md`, and `next-prompt.md` all verified.
- `pnpm --filter @ts-drp/issuance-store build` — exit 0.
- `pnpm --filter @ts-drp/storage-browser build` — exit 0.
- `pnpm --filter @ts-drp/storage-node build` — exit 0.
- `pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5b0d-red-9ab5924a/focused.json`
  — expected exit 1; one file, 21 tests, 2 passed, 19 failed, 0 skipped,
  no top-level error.
- `pnpm exec eslint tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts -f json -o .logs/d110c-0c1f5b0d-red-9ab5924a/eslint.json`
  — exit 0; zero messages.
- `pnpm exec prettier --check tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`
  — exit 0.
- `git diff --check -- tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`
  before commit and `git show --check 9ab5924a` after commit — exit 0.
- `git diff --name-only 325e2c31..9ab5924a` — exactly
  `tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`.
- `git log --format='%H %G? %s' -1` — signed status `G` for
  `9ab5924a34faf9cd1e0f42b79026ef5313318da8`.
- `git rev-parse origin/codex/phase3a1b-p6-golden-path` —
  `9ab5924a34faf9cd1e0f42b79026ef5313318da8` after the RED push.
- `git stash list | wc -l` — 27 before and after the RED.
