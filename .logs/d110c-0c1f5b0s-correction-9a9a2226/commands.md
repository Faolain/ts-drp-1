# D.110c-0c1f5b0s P1 correction commands

```text
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/storage-browser build
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec playwright test --config packages/storage-browser/tests/playwright.phase-2l-b-browser-issuance.config.ts phase-2l-b-browser-issuance-red.pw.ts --reporter=line
pnpm exec eslint packages/storage-browser/tests/fixtures/phase-2l-b-browser-issuance-contract.ts packages/storage-browser/tests/fixtures/phase-2l-b-browser-issuance-entry.ts packages/storage-browser/tests/phase-2l-b-browser-issuance-red.pw.ts
pnpm exec prettier --check packages/storage-browser/tests/fixtures/phase-2l-b-browser-issuance-contract.ts packages/storage-browser/tests/fixtures/phase-2l-b-browser-issuance-entry.ts packages/storage-browser/tests/phase-2l-b-browser-issuance-red.pw.ts
git diff --check
```
