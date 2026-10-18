# D.110c-0c1b accepted commands

Focused:

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1b-green-0873dfd0/focused.json
```

Retained:

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/e5-01-v3-operation-admission-red.test.ts tests/phase-6a-creator-adoption-commit-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-epoch-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts tests/phase-6b-d110c-b-hot-adoption.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1b-green-0873dfd0/retained.json
```

Static and build:

```text
pnpm exec eslint packages/node/src/v3-live.ts tests/fixtures/phase-6a-v3/creator-adoption-contract.ts tests/fixtures/phase-6b/runtime-reclamation-contract.ts tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts tests/fixtures/phase-6b-d110c-0c1b/committed-issuance-recovery-contract.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts
pnpm exec prettier --check packages/node/src/v3-live.ts tests/fixtures/phase-6a-v3/creator-adoption-contract.ts tests/fixtures/phase-6b/runtime-reclamation-contract.ts tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts tests/fixtures/phase-6b-d110c-0c1b/committed-issuance-recovery-contract.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts
git diff --check
pnpm --filter @ts-drp/node build
pnpm exec tsc -p packages/node/tsconfig.build.json --noEmit --pretty false
```
