# Commands and results

All primary-worktree commands ran under
`/Users/aristotle/Documents/Projects/ts-drp-1`; coverage was disabled for all
focused and retained Vitest commands.

## Mandatory test gates

```sh
pnpm exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-phase3g.json
```

Result: 14/14 passed, exit 0.

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-focused39.json
```

Result: 39/39 passed, exit 0.

```sh
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts tests/phase-3a1b-d9336-authorized-recovery-red.test.ts tests/phase-5e-creator-close-red.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-3h-v3-terminal-transition-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-retained87.json
```

Result: 87/87 passed, exit 0. The prior Phase-3h 10-second combined-run timeout
was not reproduced and remains recorded scheduling variance; no timeout changed.

## Additional retained consumers

```sh
pnpm exec vitest run tests/phase-3f-b-v3-frontier-reduction-red.test.ts tests/phase-3f-b-chat-zone-causal-join-red.test.ts tests/phase-3f-c-v3-application-batching-red.test.ts tests/phase-3f-c-v3-room-batching-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-legacy-consumers.json
```

Result: 26/26 passed, exit 0.

The nine shared `live-snapshot` consumers were run together. The first run was
63/64 because its Phase-6a child imported stale gitignored Node dist. Dist was
older than the exact source and lacked the corrective shapes. After:

```sh
pnpm --filter @ts-drp/node build
```

the compiled file contained the expected profile-aware control predicate,
`copySettlementPlan`, legacy join/causalJoin intent exceptions, and activation
digest exclusion. One authorized replacement title passed:

```sh
pnpm exec vitest run tests/phase-6a-creator-successor-activation-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-phase6a-replacement.json -t 'private custody alone selects installEpochAnchor'
```

The same nine-file command then passed 64/64:

```sh
pnpm exec vitest run tests/e5-01-v3-operation-admission-red.test.ts tests/phase-4a-v3-live-blueprint-fold.test.ts tests/phase-4b-v3-live-snapshot-composition-red.test.ts tests/phase-4c-snapshot-pull-red.test.ts tests/phase-4c-v3-snapshot-transfer-composition-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-handle-identity-red.test.ts tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts tests/protocol-v3-latched-acl-referee-successor-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-shared-consumers-built.json
```

## Builds, types and public boundary

The following passed:

```sh
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/protocol-v3 build
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/protocol-v3 smoke:public-package
```

The public smoke retained the exact 12-symbol root export set and confirmed
that `verifyReceivedVertex` remains internal. From `packages/node`, the built
internal verifier, public protocol root, and `@ts-drp/node/v3-live` imports all
succeeded while the root verifier remained absent.

```sh
pnpm --filter @ts-drp/node typecheck
```

Result: exit 2. At detached untouched parent `449b95a3`, an offline frozen
install followed by `pnpm --filter @ts-drp/node... build` and the same typecheck
also exited 2. After absolute-root normalization, both 61-line outputs had
SHA-256 `f1fe7cb5fed31ebcd1b48e34eaae0c2b5518d2deeafd8c1914967312d25171c8`
and `diff -u` exited 0.

## Static and source shape

```sh
pnpm exec eslint packages/node/src/v3-live.ts
pnpm exec prettier --check packages/node/src/v3-live.ts
git diff --check
git diff --name-only
rg -n 'copySettlementPlan|function isControlOperation|action !== "causalJoin"|action !== "join"|displacedSource\?\.activationVertexDigest' packages/node/src/v3-live.ts
```

All passed. The only changed production path was `packages/node/src/v3-live.ts`.

## Fresh detached checkout

At detached parent `449b95a3`, the exact patch SHA-256
`6b56222c273f487d5e35bcc0acc30327bd43f4eeb28a33d8bb65fa079a9f359a`
was applied with `apply_patch`. Then:

```sh
pnpm install --offline --ignore-scripts --frozen-lockfile
pnpm --filter @ts-drp/node... build
pnpm --filter @ts-drp/storage-browser... build
pnpm --filter @ts-drp/storage-node... build
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-isolated-focused39.json
pnpm exec vitest run tests/phase-6a-creator-successor-activation-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final4-isolated-phase6a.json -t 'private custody alone selects installEpochAnchor'
pnpm --filter @ts-drp/protocol-v3 smoke:public-package
```

Offline install and all builds passed; focused passed 39/39; the built-child
title passed 1/1 with 16 filtered; public and built import smokes passed; the
only tracked checkout difference was the exact intended Node source patch.

## Commit and push

```sh
git commit -S --only packages/node/src/v3-live.ts -m 'fix(node): restore profile-safe settlement behavior'
git push origin codex/phase3a1b-p6-golden-path
```

Both exited 0; production commit is `e07f8a94d5e2449289bebd7aa89f1dcdbd4d9536`.
