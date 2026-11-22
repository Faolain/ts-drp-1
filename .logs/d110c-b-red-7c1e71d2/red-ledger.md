# D.110c-b deterministic RED ledger

- Reviewed plan base: signed/pushed `7c1e71d28180fa561f8730ac39dcf41277eccd31`.
- Scope: tests and evidence only. No production source, product API, wire/schema, dependency, threshold, workload, or campaign change.
- Focused executable custody: each selected executable ran exactly once with coverage disabled where applicable. Neither was retried.

## Node causal observation

Command:

```text
pnpm exec vitest run tests/phase-6b-d110c-b-hot-adoption.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-b-red-7c1e71d2/vitest.json
```

Result: exit `0`; one test in one file; no failed, pending, or todo test; no top-level error. The genuine retained D.110c-a path performed hot 0→1 adoption/activation, real epoch-1 issue and publication, and a genuine epoch-1 close whose authenticated successor epoch is `2`. The new tests-only one-use observation called `verifyCreatorSuccessorAdoption()` exactly once with that real close handle. It returned exactly `{ ok:false, kind:"chain-invalid", detail:"creator successor trust chain is invalid" }`; independently read durable heads before and after were equal. Stdout contains `D110C_B_EPOCH_PINNED_PREDECESSOR`.

## Browser causal observation

The first read-only listing used start/end anchors and selected zero because Playwright matches the grep against a larger full-title representation. It did not execute a test and is preserved as a selector diagnostic, not a code failure. The corrected literal-title listing selected exactly one Chromium test in one file:

```text
pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts --project=chromium --grep 'D\.110c-b advances one genuine room through hot epoch 0 to 1 to 2 and rebinds epoch 2 close custody' --list
```

The sole executable command was:

```text
PLAYWRIGHT_JSON_OUTPUT_NAME=.logs/d110c-b-red-7c1e71d2/playwright.json pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts --project=chromium --grep 'D\.110c-b advances one genuine room through hot epoch 0 to 1 to 2 and rebinds epoch 2 close custody' --reporter=json --fail-on-flaky-tests --output=.logs/d110c-b-red-7c1e71d2/playwright-artifacts
```

Result: exit `0`; expected `1`, skipped `0`, unexpected `0`, flaky `0`, top-level errors `[]`. The independent fourth server/realm used exact database `d110c-b-hot-creator` and channel `d110c-b-hot-rollover`, performed the real 0→1 close/adoption and epoch-1 send, then its first post-adoption `sealEpoch()` rejected exactly `creator close authority is unavailable`. Its epoch-1 authority, room id, accepted state, and all three retained realm snapshots remained unchanged. Reporter stdout contains `D110C_B_CLOSE_NOT_REBOUND`. Playwright resolved the JSON path relative to its config directory; it was relocated into this evidence root without byte change, with matching pre/post SHA-256 `f07c46ffb95228d2d8ca95ecf569b8373ff38b2c52c7411c1445bb715ddd0951`.

## Source shape and static gates

- `node tests/fixtures/phase-6b-d110c-b/source-shape.mjs`: exit `0`; all 14 frozen RED predicates true. These cover epoch-1 projection literals, generation-1 predecessor selectors, same-bindings stale-wrapper return, unconditional topic deletion/lock release, literal product epoch, the one-transition latch, and absence of post-adoption close rebinding.
- Runtime/import probe: corrected exit `0`; Node `v22.15.0`; creator verifier loaded from `packages/node/src/creator-adoption.ts`; storage fixture owner loaded from freshly present `packages/storage-node/dist/src/index.js`. The first probe guessed a nonexistent storage export after both imports succeeded; its exit `1` is preserved as a corrected diagnostic, not a module-resolution or code failure.
- Exact-owner ESLint: corrected exit `0`. The initial pass reported only missing explicit return annotations in the plain-JavaScript evidence script; a bounded file-level rule explanation corrected it.
- Exact-owner Prettier: exit `0`.
- The final plan-inclusive Prettier check exhausted the formatter's default 4 GiB Node heap before emitting a formatting verdict; the identical check with formatter-only `NODE_OPTIONS=--max-old-space-size=12288` exited `0` and reported every selected file formatted. No product/test resource contract changed.
- `git diff --check`: exit `0`.
- `tsc -b packages/node/tsconfig.build.json --noEmit`: exit `0`.
- `tsc -b packages/storage-browser/tsconfig.build.json --noEmit`: exit `0`.
- `pnpm --filter @ts-drp/example-v3-room typecheck`: exit `0`.
- The broader root/package typechecks remain exit `1`/`2` only on inherited owners outside this RED: `packages/object` compact-history configuration typing; existing Node worker-host rootDir, E3-02 route, and compact-history helper typing; and existing storage-browser Phase-6b reclamation aliases/branded fixture IDs. Their complete outputs are retained. They do not name any D.110c-b changed file, and the affected production build configurations are green.

## Custody

- Reviewed base HEAD and origin were identical and the HEAD signature verified.
- Protected `.agents`, `.claude`, and `.pnpm-store` remained present and untouched; all 27 stashes remained.
- No ts-drp Vitest, Playwright, reviewer, or profiler process remained; fixed ports 4174, 4175, 51000, and 51002 were clear. Other users' unrelated browser/model processes were not interrupted.
- No D.110a invocation, preflight, profile, long campaign, reviewer, Fable, or collaboration subagent ran.
