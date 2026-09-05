# Commands and results

All primary commands ran under `/Users/aristotle/Documents/Projects/ts-drp-1`.
Vitest coverage was disabled for bounded focused and retained gates.

## Focused and retained

```sh
pnpm exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-compat-focused27.json
```

Result: 27/27 passed.

```sh
pnpm exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-compat-phase3g.json
```

Result: 14/14 passed.

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-compat-focused39.json
```

Result: 40/40 passed. The inherited command name says `focused39`, but the
latest compatibility RED adds one assertion, so the exact selected count is 40.

```sh
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts tests/phase-3a1b-d9336-authorized-recovery-red.test.ts tests/phase-5e-creator-close-red.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-3h-v3-terminal-transition-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-compat-retained87.json
```

Result: 87/87 passed.

```sh
pnpm exec vitest run tests/phase-3f-b-v3-frontier-reduction-red.test.ts tests/phase-3f-b-chat-zone-causal-join-red.test.ts tests/phase-3f-c-v3-application-batching-red.test.ts tests/phase-3f-c-v3-room-batching-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-compat-legacy26.json
```

Result: 26/26 passed.

## Built child and shared consumers

Before any fresh child:

```sh
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/protocol-v3 build
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/protocol-v3 smoke:public-package
```

All passed. The nine shared `live-snapshot` consumers then passed 64/64, and
the selected `private custody alone selects installEpochAnchor` title passed
1/1 with 16 filtered. Built imports for the internal verifier,
`@ts-drp/protocol-v3`, and `@ts-drp/node/v3-live` passed with no root verifier
leak.

## Static and typecheck

```sh
pnpm exec eslint packages/node/src/v3-live.ts
pnpm exec prettier --check packages/node/src/v3-live.ts
git diff --check
git diff --name-only
```

The first ESLint pass reported only Prettier's multiline preference for the
new condition. That hunk was formatted mechanically. The final ESLint,
Prettier, diff, one-path, and source-shape checks passed.

```sh
pnpm --filter @ts-drp/node typecheck
```

Current and detached untouched parent `eb302c07` both exited 2. After the
parent dependency build and absolute-root normalization, their 61-line outputs
were byte-identical with SHA-256
`f1fe7cb5fed31ebcd1b48e34eaae0c2b5518d2deeafd8c1914967312d25171c8`.

## Detached checkout

A fresh detached checkout of `eb302c07` used an offline frozen install. The
exact two-hunk patch SHA-256 was
`45d768ccace40f95ee88130342e4e2aea30df9cdda0557c0a0cf9d5caf4d4436`.
After Node, storage-browser, and storage-node dependency builds, detached
focused gates passed 27/27 and 40/40; the built-child title passed 1/1; public
and built-import smokes passed; diff check passed; and the only tracked
difference was `packages/node/src/v3-live.ts`.

## Commit and push

```sh
git commit -S --only packages/node/src/v3-live.ts -m 'fix(node): preserve legacy settlement compatibility'
git push origin codex/phase3a1b-p6-golden-path
```

Both passed; production is `802a647ea412df7dcfe6284f2b62bfd66554ae23`.
