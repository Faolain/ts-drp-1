# D.110c-b GREEN review-correction evidence ledger

- Recorded UTC: `2026-09-02T18:54:54Z`
- Reviewed signed/pushed GREEN base: `f2066512f0311a56863be0d769531c6b783d9fef`
- Runtime: Node `v22.15.0`, pnpm `10.24.0`
- Scope: close the first final-review P1 union with exact authority/lock/fault proof, current-owner lock release, terminal close cleanup, and signed evidence custody.
- No D.110a invocation, long campaign, cold-reopen workload, dependency, wire/schema, public API, threshold, or product workload changed or ran.

## Formal review disposition

- Grok 4.6/high completed normally after 660.123 seconds. Its runner retained `NO_VERDICT` because prose preceded the terminal schema; its embedded terminal JSON was `APPROVED`, P0=0/P1=0/P2=2.
- Kimi K3 session `session_45264236-ae29-4ee8-9692-d980b386192e` returned `CHANGES_REQUIRED`, P0=0/P1=1/P2=5. The P1 required behavioral close-bind failure proof.
- Opus xhigh session `c68e57d2-9ca6-4801-992b-4e7bb5e81fc9` returned `CHANGES_REQUIRED`, P0=0/P1=4/P2=5. Its P1 union required explicit Chromium lock/fault proof, full static artifacts, tracked evidence, and an exact expected-epoch authority oracle.
- The correction implements that P1 union. P2 alias-cleanup mutation, stall-title/token hygiene, exact durable-head tuple precision, and the disclosed third-adoption boundary remain explicitly owned by D.110c-c.

## Executable correction

- The tests-only exact-key authority oracle validates the unchanged seven-key roster at an exact caller-supplied positive safe epoch.
- The browser fixture independently decodes the raw AHE authority at epochs 1 and 2.
- Chromium queries native Web Locks: zero successor-owner locks at genesis, one stable lock after epoch 1, and the same sole lock after epoch 2 and the pending 2->3 close.
- One genuine direct-room adoption injects `bindCreatorLiveClose()` refusal and proves exact `D110C_B_CLOSE_REBIND_FAILED`, retained replacement authority, stalled/unavailable close custody, one predecessor deactivation, refusal of another close, two distinct room locks while the failed replacement remains active, and restoration to the sole main-room lock after shutdown.
- The production close-rebind failure path best-effort stops the terminal predecessor close handle.
- `deactivateOwner()` deletes and releases only while its ownership token is current.
- D.110c-specific counters are exposed by `d110cBSnapshot()` and do not widen retained D.108 snapshot contracts.

## Runtime results

- `focused-browser-final.json`: expected=1, skipped=0, unexpected=0, flaky=0, top-level errors=0; emitted `D110C_B_PRODUCT_HOT_LOOP_COMPLETE`.
- `retained-product-browser-final.json`: expected=30, skipped=0, unexpected=0, flaky=0, top-level errors=0 across Chromium, Firefox, and WebKit.
- `retained-activation-browser.json`: expected=24, skipped=0, unexpected=0, flaky=0.
- `retained-live-close-browser.json`: expected=9, skipped=0, unexpected=0, flaky=0.
- `retained-node-correction.json`: 6/6 suites and 9/9 tests passed with zero failed or pending tests.
- The retained initial snapshot failures and focused expectation diagnostics are preserved under diagnostic filenames and are not represented as GREEN passes.

## Static and custody results

The following commands each have separate `.stdout`, `.stderr`, and `.status` artifacts and exited zero:

```text
pnpm --filter @ts-drp/node build
pnpm exec tsc -p packages/node/tsconfig.build.json --noEmit --pretty false
pnpm --filter @ts-drp/storage-browser build
pnpm exec tsc -p packages/storage-browser/tsconfig.build.json --noEmit --pretty false
pnpm --dir examples/v3-room typecheck
pnpm --dir examples/v3-room build
pnpm --dir examples/v3-chat typecheck
pnpm exec tsc -p tests/fixtures/phase-6b-d110c-a/tsconfig.json --noEmit --pretty false
pnpm exec eslint --max-warnings 0 <14 exact TypeScript/JavaScript owners>
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec prettier --check <plan and 14 exact owners>
node tests/fixtures/phase-6b-d110c-b/source-shape.mjs
git diff --check
```

The corrected source-shape result passes all seventeen predicates. Focused listings prove one Playwright test in one file and one Vitest test in one file. `reporter-summary.json`, `test-assertion-inventory.txt`, `changed-paths.txt`, `changed-paths.sha256`, and `runtime-identity.json` provide machine-readable inventories and source identity.

The first runtime probe imported the private fixture directly under raw Node/tsx and encountered its bare-workspace import outside the test launcher. That read-only probe is retained under `runtime-identity-diagnostic.*`; the corrected non-loading identity check resolves the intended source and built artifact paths and proves that each exists. It is a diagnostic correction, not a product or test failure.

At pre-commit capture, HEAD and origin both equal the reviewed GREEN base, all 27 stashes remain, protected `.agents`, `.claude`, and `.pnpm-store` paths remain present, fixed ports 4174, 4175, 51000, and 51002 are clear, and no ts-drp reviewer, test, or profiler process is active. Signed correction and pushed-ref identity are recorded in the follow-up custody checkpoint after this evidence-bearing commit exists.
