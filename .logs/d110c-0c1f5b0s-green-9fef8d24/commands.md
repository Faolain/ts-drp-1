# D.110c-0c1f5b0s GREEN commands

Production commit: `9fef8d2470d45442a74c43b895e6d83c03c60533`. Retained harness corrections: `6cc120eb0901c112535037b64e9c39edf0c984eb` and `0508133f07becf980bfd19384c26e117ac7e9a36`.

```text
pnpm --filter @ts-drp/issuance-store build
pnpm --filter @ts-drp/storage-browser build
pnpm --filter @ts-drp/storage-node build
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run --coverage.enabled=false tests/phase-2l-a-shared-issuance-contract.test.ts tests/phase-3a1b-p2-outbox-publication-contract.test.ts packages/storage-node/tests/phase-2l-c-node-issuance-red.test.ts packages/storage-node/tests/phase-3a1b-p2-node-outbox-publication-red.test.ts packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts --reporter=dot
pnpm exec playwright test --config packages/storage-browser/tests/playwright.phase-2l-b-browser-issuance.config.ts phase-2l-b-browser-issuance-red.pw.ts
pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts
```
