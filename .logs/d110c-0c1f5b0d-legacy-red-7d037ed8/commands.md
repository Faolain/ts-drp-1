# Commands and results

- `pnpm exec vitest list tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts --json=.logs/d110c-0c1f5b0d-legacy-red-7d037ed8/listing.json`
  — exit 0; exactly one file and 19 tests.
- `pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5b0d-legacy-red-7d037ed8/focused.json`
  — expected exit 1; one file, 19 tests, 18 passed, one failed, zero skipped,
  zero todo, and no module-load or top-level error.
- `pnpm exec eslint tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts -f json -o .logs/d110c-0c1f5b0d-legacy-red-7d037ed8/eslint.json`
  — exit 0; zero errors and zero warnings.
- `pnpm exec prettier --check tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`
  — exit 0.
- `git show --check --oneline 7d037ed8` — exit 0.
- `git diff --name-only 721d1c0e..7d037ed8` — exactly
  `tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`.
- `git diff --quiet 721d1c0e..7d037ed8 -- tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts`
  — exit 0; the retained 12-case corrective backend suite is byte-identical.
- `pnpm exec vitest list tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts --json`
  — exit 0; exactly 12 retained tests listed.
- `git log --format='%H %G? %s' -1` at the RED commit — signed status `G`.
- `git rev-parse origin/codex/phase3a1b-p6-golden-path` after the RED push —
  `7d037ed825a092cf985d1a271d3f56d965992ed3`.
- `git stash list | wc -l` — 27 before and after the RED.
