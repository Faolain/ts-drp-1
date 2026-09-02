# D.110c-0b0a GREEN evidence ledger

- RED base: `c1e443fc9676187c4b02dcd23459a23119de8146`
- Scope: Node-only staged successor adoption, publication, and non-activating pending recovery.
- Long or consuming invocations: none.
- Product/provider orchestration, wire records, dependencies, thresholds, and existing root exports: unchanged.

## Accepted runtime results

The final focused command disabled the repository-wide coverage percentage gate because this is a single-file semantic execution:

```text
pnpm exec vitest run tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-0b0a-green-c1e443fc/focused.json
```

Result: status 0; JSON `success:true`; 3/3 tests passed; 0 failed; 0 pending.

The retained command selected these exact eight files:

```text
tests/phase-3a1b-p3-live-transport-red.test.ts
tests/phase-3h-v3-room-rehearsal-red.test.ts
tests/phase-6a-creator-adoption-commit-red.test.ts
tests/phase-6a-creator-adoption-red.test.ts
tests/phase-6a-creator-successor-activation-red.test.ts
tests/phase-6a-creator-successor-handle-identity-red.test.ts
tests/phase-6b-cleanup-eligibility-red.test.ts
tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts
```

Result: status 0; JSON `success:true`; 86/86 tests passed; 0 failed; 0 pending. Vitest reports 14 suites for those eight result files.

## Accepted static and build results

All of the following exited 0:

```text
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/node exec tsc --noEmit -p tsconfig.build.json
node_modules/.bin/tsc -p tests/fixtures/phase-3a1b-p3/tsconfig.test.json
pnpm exec eslint <the exact twelve changed source/test paths>
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check <the exact twelve changed source/test paths>
git diff --check
```

The built self-reference probe was executed from `packages/node`, where the workspace package resolves itself, and observed the exact new non-root export rosters:

```text
@ts-drp/node/creator-adoption-recover => ["recoverPendingCreatorSuccessorAdoption"]
@ts-drp/node/creator-adoption-stage => ["publishStagedCreatorSuccessorAdoption","stageCreatorSuccessorAdoption"]
```

The corrected source audit found no provider import, provider call, product source edit, protocol-v3 edit, dependency/lockfile edit, activation binding, or root-export widening in this slice. The existing examples and package root owners were unchanged.

## Diagnostic corrections

- The first focused GREEN run passed 2/3. The sole failure was tests-only: the fixture returned the raw AHE backend rather than its decorated swap-observing store. The fixture was corrected without changing product behavior.
- The next focused report was semantically 3/3 but the command exited nonzero only because the repository's global 70% coverage threshold is inapplicable to one focused file. The final focused command disabled coverage and is the accepted result.
- The first retained run passed 83/86. Its three failures identified: retained one-call commit-then-throw semantics, a no-mutation diagnostic that scanned a multi-owner file instead of the verifier function, and mixed source/dist unique-symbol storage types in the private exact compile fixture. Each was corrected narrowly; the next and final retained runs passed 86/86.
- A first read-only provider source-shape regex searched every occurrence of the word `provider`, including documentation, and was corrected to inspect actual imports and calls. This was a faulty diagnostic, not a code failure.
- A first built-export probe ran from the repository root, which does not link `@ts-drp/node`; rerunning from `packages/node` proved the intended package self-resolution. This was a wrong working directory, not an export failure.
- The broad `pnpm --filter @ts-drp/node typecheck` command remains unsuitable as an exact slice gate because it includes inherited repository test/config errors (worker-host `rootDir`, retained WebRTC emit typing, and a compact-history helper). The exact production source typecheck and the affected private compile fixture both pass; this slice does not widen to those inherited owners.

## Exact changed source/test roster and SHA-256

```text
39af3f8a7a9765d006acdd1b7969a4ba550ee6da9794189980f605bc627510c5  packages/node/package.json
34c035497e7f052d8331b348aea5fa95287d6db090aed92a132e8855df1ca71f  packages/node/src/creator-adoption-commit.ts
71d0026c76bcf9c88725757d5c062b27df7515da4d375d96216f28563c708735  packages/node/src/creator-adoption-recover.ts
26bc75d921d48f41eb49f34dd556d4cac2f9dec1ebb56a8420026369fda2c52e  packages/node/src/creator-adoption-stage.ts
07e8c680dfd520a1ce45e10081561a4014d4ce0003aa4ffba06c8aade4e5c7db  packages/node/src/creator-adoption.ts
daedadf8236793dcdb5472b336bb9230bc480b806879113527785d2193019f82  packages/node/src/internal/creator-adoption-intent.ts
01fb852eab12c8110075694bacbbddf20f8a6bf81321d3413ee7bab19337535e  packages/node/src/internal/creator-adoption-recover.ts
8e5e6018e555e97bc1211914f76712abad623e442a509b8b23a0a4ffb0e56cd7  packages/node/src/internal/creator-adoption-stage.ts
423fc5b34f931be24d9af73b60f293279b3febddfbb2b6f44794bd34226d9a93  tests/fixtures/phase-3a1b-p3/tsconfig.test.json
e1236d4e13ab6c1c04854afe805e7a2d5820f02928c07e8fa223fe138e61ca02  tests/fixtures/phase-6a-v3/creator-adoption-contract.ts
af39a32b2aa4e1ad372c01e60d33aba8776197e36f63324f8d8c42c8869490b5  tests/phase-3a1b-p3-live-transport-red.test.ts
c2815d6831837f7845e55479e560b266aa185dd441b3e1e4dfcc05a867cb122a  tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts
```

Final report hashes:

```text
dea13e05881f9563d051b9e024ae669f53204a8fe53b4f402e14b6e514243349  focused.json
65cba8d8d13b1ded81b9e9506ef419f9313273b7b8d2646efcacd85f42892059  retained.json
```

Protected `.agents`, `.claude`, and `.pnpm-store` remain untracked and unstaged. All 27 stashes remain present, including the explicitly named recoverable `d110c-0b0 exploratory pre-0b0a` stash. No D.110a identity was invoked.
