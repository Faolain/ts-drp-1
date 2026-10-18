# D.109c GREEN command and result ledger

Date: 2026-09-01 AST

## Focused gates

- `pnpm exec tsc -b packages/storage/tsconfig.build.json packages/storage-node/tsconfig.build.json packages/storage-browser/tsconfig.build.json --force` — PASS.
- `pnpm exec vitest run tests/phase-6b-ahe-reclamation-red.test.ts packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/phase-6b-d109c-green/focused-vitest.json` — PASS: 48/48, zero failed/skipped.
- `PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/.logs/phase-6b-d109c-green/focused-browser.json" pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-ahe-reclamation.config.ts --project=chromium --reporter=json` — PASS: one file, four tests, four expected, zero unexpected/flaky/skipped/top-level errors. The four tests execute 28 mutation/count cases, six global-reference cases, six worker-termination edges, empty/replay/reopen/two-handle/successor controls and strict identity/lifecycle checks.

## Builds and source-only typechecks

- `pnpm --filter @ts-drp/storage build` — PASS.
- `pnpm --filter @ts-drp/storage-node build` — PASS.
- `pnpm --filter @ts-drp/storage-browser build` — PASS.
- `pnpm --filter @ts-drp/node build` — PASS.
- `pnpm exec tsc -p <storage|storage-node|storage-browser|node>/tsconfig.build.json --noEmit --pretty false` for all four affected packages — PASS.

## Retained gates

- Initial 17-file Vitest diagnostic — 197 passed, one failed, one skipped. The sole failure was the already-declared D.109f stale complete-export assertion `reports the exact frozen strict capability pair` in `packages/storage-node/tests/sqlite-contract-red.test.ts`; it rejects the reviewed additive `./maintenance` subpath. This is retained honestly in `retained-vitest.json` and is not a D.109c product failure.
- Corrected same 17-file selection with only that exact D.109f assertion and the unrelated long repeated-SIGKILL campaign filtered — PASS: 197 selected passed, zero failed, two filtered; `retained-vitest-final.json`.
- Conditional current export-census plus D.109a selection — PASS: 15 selected passed, zero failed, 38 filtered; `retained-export-planner.json`.
- Chromium Phase-2d1 schema/lifecycle — PASS: 12/12.
- Chromium Phase-2d2a adapter plus Phase-2e1/2/3/4 bounded-read, poison, recovery and lifecycle — PASS: 22/22.
- Chromium Phase-2e6 real process death — PASS: 1/1.
- Chromium Phase-6a creator-adoption commit/reopen — PASS: 2/2.

## Static, custody and refactor checks

- Exact changed-owner/test ESLint — PASS, zero errors/warnings after JSDoc cleanup.
- Exact changed-owner/test/package/slice Prettier and the large plan with `node --max-old-space-size=8192 ... prettier.cjs --check` — PASS.
- `git diff --check` and Node child `node --check` — PASS.
- Source pins from D.109b for the lockfile, memory `TransitionOwner`, package roots, Node schema and browser schema/version — unchanged.
- Package export maps gain only `./maintenance`; package roots contain no `reclaimClosedEpoch`; the ordinary facade remains 12 keys; `D109C_GREEN_PATHS` contains the exact 11 production/integration owners.
- `refactor-clean` audit — PASS: one shared classifier, one physical transaction per backend, no duplicate production lineage walker, compatibility wrapper, temporary export or generic adapter-command growth.
- Corrected read-only source-shape diagnostic — PASS. The first diagnostic used an invalid Unicode regex escape and is classified as a diagnostic error, not a code failure.
- Protected untracked paths all remain present; stash count remains 26; fixed ports 4174/4175/51000/51002 are clear; no ts-drp reviewer/test/profiler process remains.
- No D.109c retained campaign ran.

## Review policy

The sole formal GREEN review must use Grok 4.6/high, exact Kimi K3 thinking/high with both `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and `--max-steps-per-turn 100`, and Opus xhigh. Kimi occupies the middle external-CLI reviewer slot; Codex `gpt-5.6-sol` is not a substitute. These external CLI runs are not collaboration subagents. No Fable or collaboration subagent is authorized.
