# D.110c-b GREEN evidence ledger

- Recorded UTC: `2026-09-02T18:01:06Z`
- Signed/pushed RED parent: `90147e3c7af4fe008a7d973372f28678cc7e2400`
- Parent tree: `03cc689d928b6adf94296b8a1f024b9807f6ce05`
- Runtime: Node `v22.15.0`, pnpm `10.24.0`
- Scope: D.110c-b epoch-relative hot adoption, exact-next active ownership, product close rebinding, and retained redirect ordering
- No D.110a preflight/full invocation, retained campaign, cold multi-epoch campaign, dependency change, wire/schema change, threshold change, or workload change ran.

## Focused GREEN

- Batch 1 final reporter: `batch1-vitest-isolated.json`; one test in one file passed and emitted `D110C_B_HOT_ADOPTION_COMPLETE`.
- Batch 2 reporter: `batch2-chromium.json`; expected=1, skipped=0, unexpected=0, flaky=0 and emitted `D110C_B_PRODUCT_HOT_LOOP_COMPLETE`.
- The anchored Playwright selector selected zero and executed no test. The corrected literal selector selected and executed the one intended title.

## Diagnostic custody

- `batch1-vitest.json`, `batch1-vitest-corrected.json`, `batch1-vitest-final.json`, `batch1-vitest-complete.json`, and `batch1-vitest-green.json` retain the bounded Batch-1 diagnostic sequence.
- `retained-product-browser.json`, `retained-product-browser-corrected.json`, and `retained-product-browser-final.json` retain the three complete retained passes that exposed stale pre-verification expectations and the redirected adoption ordering defect.
- `retained-ordering-focused.json` retains the causal ordering failure. `retained-ordering-focused-corrected.json` is the corrected three-engine pass.
- Failed diagnostic reporters are not represented as GREEN results.

## Final retained results

- `retained-node.json`: success=true, 62/62 suites and 282/282 tests, zero failed or pending.
- `retained-product-browser-green.json`: expected=30, skipped=0, unexpected=0, flaky=0.
- `retained-activation-browser.json`: expected=24, skipped=0, unexpected=0, flaky=0.
- `retained-live-close-browser.json`: expected=9, skipped=0, unexpected=0, flaky=0.

## Commands that exited zero

```text
pnpm exec vitest run --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-b-green-working-90147e3c/retained-node.json <25 frozen retained files>
pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts --reporter=json --fail-on-flaky-tests
pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-activation.config.ts --reporter=json --fail-on-flaky-tests
pnpm exec playwright test --config packages/storage-browser/playwright.phase-5e-creator-live-close.config.ts --reporter=json --fail-on-flaky-tests
pnpm --filter @ts-drp/node build
pnpm exec tsc -p packages/node/tsconfig.build.json --noEmit --pretty false
pnpm --filter @ts-drp/storage-browser build
pnpm exec tsc -p packages/storage-browser/tsconfig.build.json --noEmit --pretty false
pnpm --dir examples/v3-room typecheck
pnpm --dir examples/v3-room build
pnpm --dir examples/v3-chat typecheck
pnpm exec tsc -p tests/fixtures/phase-6b-d110c-a/tsconfig.json --noEmit --pretty false
pnpm exec eslint --max-warnings 0 <all exact changed TypeScript/JavaScript owners>
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec prettier --check <plan and all exact changed owners>
node tests/fixtures/phase-6b-d110c-b/source-shape.mjs
git diff --check
```

The broad storage-browser test-root typecheck diagnostic remained nonzero only in its already-recorded unrelated Phase-6b branded fixture/private-alias owners. The exact production build-source typecheck exited zero.

## Workspace custody

- Protected untracked roots `.agents/`, `.claude/`, and `.pnpm-store/` remain present.
- All 27 stashes remain present.
- Ports 4174, 4175, 51000, and 51002 were clear at final evidence capture.
- No protected root, stash, immutable prior evidence root, or consumed invocation identity was changed.
