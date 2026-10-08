# D.110c-0c1f5b0s accepted RED commands

RED lineage: `b41bafb382db94c626dba5a8c6491826c097196c`, corrected by `b207e40ea196036b0f8cca357a50fce5fe154531` and retained-expectation commit `5b286468c184da76a8c48941e8874056abd29fb4` before the production GREEN.

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run --coverage.enabled=false <five retained Node/shared files> -t <superseded exactness titles>
pnpm exec playwright test --config packages/storage-browser/tests/playwright.phase-2l-b-browser-issuance.config.ts phase-2l-b-browser-issuance-red.pw.ts --grep <settlement titles>
pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts --grep 'prunes, reopens and preserves v2'
pnpm exec prettier --check <exact changed test paths>
pnpm exec eslint <exact changed test paths>
git diff --check
```
