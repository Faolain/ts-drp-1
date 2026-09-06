# D.110c-0c1f2/f4 combined GREEN command ledger

Recorded at `2026-09-03T19:26:25Z` against signed/pushed RED anchor
`fcd8735c8316b048166560ab904704102ce90705` (tree
`34a03882ac6d4940d5ca29b317ab59a9c42edb01`).

## Focused runtime gates

- `pnpm exec vitest run tests/protocol-v3-creator-author-issuance-frontiers.test.ts tests/phase-6b-d110c-0c1f2-multi-author-frontier.test.ts tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-adoption-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-0c1f24-green-working-fcd8735c/focused-vitest.json` — exit 0; 6 files, 41/41 passed.
- `PLAYWRIGHT_JSON_OUTPUT_NAME=/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f24-green-working-fcd8735c/playwright.json pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts --project=chromium --grep 'D\.110c-0c1f4 exact configured bootstrap authority is required on epoch-N cold reopen|D\.110c-0c1f2 non-creator writer requires an authenticated historical frontier' --reporter=json --fail-on-flaky-tests` — exit 0; exactly 2 tests, 2 passed, 0 skipped/unexpected/flaky/top-level errors.

## Retained runtime gate

- `pnpm exec vitest run tests/e5-01-v3-operation-admission-red.test.ts tests/phase-3a1b-p2-outbox-publication-contract.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-4b-v3-live-snapshot-composition-red.test.ts tests/phase-6a-creator-adoption-commit-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-epoch-red.test.ts tests/phase-6b-ahe-reclamation-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts tests/phase-6b-d110c-b-hot-adoption.test.ts tests/phase-6b-issuance-retention-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts tests/protocol-v3-creator-author-issuance-frontiers.test.ts tests/phase-6b-d110c-0c1f2-multi-author-frontier.test.ts tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts tests/phase-6a-creator-adoption-red.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-0c1f24-green-working-fcd8735c/retained-vitest.json` — exit 0; 20 files, 195/195 passed.

## Build and static gates

- `pnpm --filter @ts-drp/protocol-v3 build && pnpm --filter @ts-drp/protocol-v3 typecheck` — exit 0, including public-entry audits.
- `pnpm --filter @ts-drp/node build` — exit 0.
- `pnpm --filter @ts-drp/example-v3-room build && pnpm --filter @ts-drp/example-v3-room typecheck` — exit 0.
- `pnpm --filter @ts-drp/storage-browser build` — exit 0.
- Exact-owner `pnpm exec eslint ...` over every changed TypeScript/MTS owner and focused test — exit 0 after correcting one import-order diagnostic in the retained compatibility test.
- Exact-owner `pnpm exec prettier --check ...` — exit 0. The first combined invocation exhausted Node's default heap while reading the approximately 98,000-line plan; the corrected bounded checks split code from the plan and used `NODE_OPTIONS=--max-old-space-size=8192` only for the plan. Both passed. This was a diagnostic-resource failure, not a source-format failure.
- `git diff --check` — exit 0.

## Custody checks

- Corrected protected-path check reports `.agents`, `.claude`, and `.pnpm-store` present.
- `git stash list | wc -l` reports 27.
- `git rev-parse HEAD HEAD^{tree} origin/codex/phase3a1b-p6-golden-path` reports the RED anchor, tree above, and the same remote commit before GREEN sealing.
- An initial zsh loop used the special variable name `path`, which temporarily shadowed `PATH` inside that one shell and caused its trailing `git` command to be unavailable. The corrected check uses `protected_item` and passes. No repository or persistent environment state changed.

No D.110a invocation, long campaign, dependency install, threshold/workload change, Fable rerun, or collaboration subagent was used.
