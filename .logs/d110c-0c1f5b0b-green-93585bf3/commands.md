# Commands and results

## Focused

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --coverage.enabled=false --reporter=verbose
```

Result: 1 file, 27/27 passed, exit 0. A prior diagnostic without the coverage
override passed all 27 assertions but exited 1 solely because single-file line
coverage was 11.94%, below the inherited repository-wide 70% threshold.

## Retained

Each command exited 0:

```sh
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/phase-3a1b-d9336-authorized-recovery-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/phase-5e-creator-close-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/phase-3h-v3-terminal-transition-red.test.ts --coverage.enabled=false --reporter=dot
```

Results: 10/10, 45/45, 2/2, 11/11, 14/14 and 5/5 respectively; 87/87
total.

The evidence-capture invocation combined the same six files with the JSON
reporter and also passed 87/87.

## Build, type and package boundary

```sh
pnpm --filter @ts-drp/protocol-v3 build
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/protocol-v3 smoke:public-package
pnpm --filter @ts-drp/node build
```

All passed. The public-package smoke retained the exact 12-symbol root export
set and confirmed `verifyReceivedVertex` is absent.

From `packages/node`:

```sh
node --input-type=module -e "const internal = await import('@ts-drp/protocol-v3/internal/received-vertex-authentication'); if (typeof internal.verifyReceivedVertex !== 'function') throw new Error('internal verifier absent'); const root = await import('@ts-drp/protocol-v3'); if ('verifyReceivedVertex' in root) throw new Error('root verifier leak'); await import('@ts-drp/node/v3-live'); console.log('built package imports: internal verifier + node v3-live; root verifier absent')"
```

Result: exit 0.

## Static custody

```sh
pnpm exec eslint packages/node/src/internal/creator-transition-advance.ts packages/node/src/v3-live.ts packages/protocol-v3/src/internal/received-vertex-authentication.ts vite.config.mts
pnpm exec prettier --check packages/node/src/internal/creator-transition-advance.ts packages/node/src/v3-live.ts packages/protocol-v3/package.json packages/protocol-v3/src/internal/received-vertex-authentication.ts vite.config.mts
git diff --check
```

All passed.

## Untouched-parent comparison

At detached parent `504ca351653701af9dd45ad99f725307994c8e1f`:

```sh
pnpm install --offline --ignore-scripts --frozen-lockfile
pnpm --filter @ts-drp/node... build
pnpm --filter @ts-drp/node typecheck
```

The dependency/Node build passed and typecheck exited 2. GREEN's exact Node
typecheck also exited 2 with the same inherited categories only: worker-host
`rootDir`/file-list errors, absent WebRTC route `.emit`, and compact-history
configuration-union errors. No GREEN-owned source error appeared.

## Detached GREEN checkout

```sh
git worktree add --detach /tmp/ts-drp-d110c-green-check.Nt1noO 93585bf3ba62ae662c2963fd13be2ee051451fa2
pnpm install --offline --ignore-scripts --frozen-lockfile
pnpm --filter @ts-drp/node... build
pnpm --filter @ts-drp/storage-browser... build
pnpm --filter @ts-drp/storage-node... build
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --coverage.enabled=false --reporter=dot
pnpm --filter @ts-drp/protocol-v3 smoke:public-package
```

Final result: offline install and explicit fixture-dependency builds passed;
focused 27/27 passed; public smoke and built import smoke passed; status was
clean. Two preceding setup diagnostics were retained honestly: before the
explicit fixture dependencies were built, collection first found unbuilt
`storage-browser` and then 12 cases found unbuilt `storage-node`. They were
build-order diagnostics, not product or assertion failures.
