# Commands and results

## Design and source custody

- `env -C .logs/d110c-0c1f5b0r-design-3a156aca sha256sum -c manifest.sha256`
  — exit 0; `design.md`, `pre-review.md`, and `next-prompt.md` verified.
- `git log --format='%H %G? %s' -1` — GREEN signature status `G`.
- `git rev-parse origin/codex/phase3a1b-p6-golden-path` — exact GREEN hash
  after push.
- `git stash list | wc -l` — 27.
- `git diff --name-only 1063feca^ 1063feca` — exactly the five production
  owners in `owner-blobs.txt`.

## Runtime tests

- Focused f5b0d Vitest with coverage disabled — exit 0; 21/21, no skipped or
  top-level errors (`focused.json`).
- Focused plus issuance retention, settlement-plan, cleanup eligibility,
  runtime reclamation, and Node retention — exit 0; 124/124
  (`retained-core.json`).
- Settlement codec, f5b0b Node, f5b0c room, authorized recovery, creator close,
  rebase outbox, terminal transition, and f5b0d — exit 0; 112/112
  (`retained-settlement-recovery.json`).
- Browser Playwright `playwright.phase-6b-issuance-retention.config.ts` — exit
  0; 4/4 (`browser-retained.json`).

## Build and static gates

- Builds for `@ts-drp/issuance-store`, `@ts-drp/storage-browser`,
  `@ts-drp/storage-node`, and `@ts-drp/node` — all exit 0.
- `@ts-drp/issuance-store` typecheck — exit 0.
- Exact-owner ESLint, Prettier check, and committed diff check — all exit 0.
- The broader package typecheck scripts for storage-browser, storage-node, and
  node remain nonzero on inherited test-root, test-alias, and old fixture
  typing errors. Their production build configurations typecheck successfully;
  none of the diagnostics is a semantic error in a changed owner. Full output
  and exit codes are retained in `typecheck-*.log` and
  `typecheck-status.txt`.

## Isolated checkout

- Detached worktree at exact signed GREEN.
- `pnpm install --offline --frozen-lockfile --ignore-scripts` — exit 0.
- Topological dependency-closure builds for issuance-store, storage-browser,
  storage-node, and node — all exit 0.
- Isolated focused — 21/21; isolated retained — 124/124.
- A first package-local issuance-store build before its workspace dependency
  closure was built failed to resolve freshly absent `@ts-drp/canonical`
  output. The corrected topological build is the deterministic clean-workspace
  command and passed; no stale main-checkout `dist` artifact was used.

## Corrected diagnostics

- One early focused command omitted the slice's `--coverage.enabled=false` and
  consequently hit the repository-wide coverage threshold after its tests
  passed. The accepted commands include the flag.
- One broad retained command supplied obsolete/nonexistent file names; Vitest
  selected only the two existing names. The final 112-test command uses the
  exact current paths.
- A shell capture initially used zsh's read-only `status` name and a macOS
  `env` invocation initially used GNU `--chdir`. Both diagnostics were
  corrected (`f5b0a_status` and `env -C`) and the intended commands were run.
