# Commands and results

All ordinary commands ran from
`/Users/aristotle/Documents/Projects/ts-drp-1`. Coverage was disabled for the
bounded Vitest gates.

## Focused

```sh
pnpm vitest run /Users/aristotle/Documents/Projects/ts-drp-1/tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-0c1f5b0c-green-focused.json
```

Result: 9/9 passed. `focused.json` is the complete reporter.

An earlier verbose invocation omitted `--coverage.enabled=false`: all 9 tests
passed, then the repository-wide coverage threshold returned nonzero. It was a
command diagnostic, not a test or product failure; the corrected command above
is the accepted focused gate.

## Static and package gates

```sh
pnpm --filter @ts-drp/example-v3-room build
pnpm --filter @ts-drp/example-v3-room typecheck
pnpm exec eslint /Users/aristotle/Documents/Projects/ts-drp-1/examples/v3-room/src/index.ts
pnpm exec prettier --check /Users/aristotle/Documents/Projects/ts-drp-1/examples/v3-room/src/index.ts
git diff --check
```

All passed. The production commit changes exactly
`examples/v3-room/src/index.ts`.

## Retained

```sh
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts tests/phase-3a1b-d9336-authorized-recovery-red.test.ts tests/phase-5e-creator-close-red.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-3h-v3-terminal-transition-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-0c1f5b0c-retained87.json
```

Result: 87/87 passed.

```sh
pnpm exec vitest run tests/phase-3f-b-v3-frontier-reduction-red.test.ts tests/phase-3f-b-chat-zone-causal-join-red.test.ts tests/phase-3f-c-v3-application-batching-red.test.ts tests/phase-3f-c-v3-room-batching-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-0c1f5b0c-legacy26.json
```

Result: 26/26 passed.

## Detached clean checkout

A fresh detached worktree at production commit `3b6a66a9` ran:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @ts-drp/example-v3-room... --filter @ts-drp/storage-node... build
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts --coverage.enabled=false --reporter=json
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts tests/phase-3a1b-d9336-authorized-recovery-red.test.ts tests/phase-5e-creator-close-red.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-3h-v3-terminal-transition-red.test.ts --coverage.enabled=false --reporter=json
```

The freshly built focused result is 9/9 and retained result is 87/87. The first
retained attempt had not built `storage-node`; its two module-load failures
were removed by the corrected source-build prerequisite. A supplemental legacy
selection reached 25/26; its sole failure was the same missing-build diagnostic
for `@ts-drp/outcome-commit`, outside the room dependency closure. Local
legacy coverage is complete at 26/26.

## Inherited comparison

The three older room selections were run both in the current workspace and in
a fresh detached checkout at signed parent `9f55370c` after an offline install
and source build. The current tree reports 43 tests, 9 passes and 34 failures.
The parent reports the same 34 source/expectation failures plus one isolated
missing-build diagnostic for `@ts-drp/outcome-commit`. The 15 d9346 room
failures and 18 Phase-3g room failures stop at
`assertSupportedGenesisLineagePolicy` with `truncated canonical value`; the
single Phase-6a failure is the same inherited cold-successor expectation.
