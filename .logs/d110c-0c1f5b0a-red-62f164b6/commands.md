# D.110c-0c1f5b0a corrected RED commands

Baseline: signed test commits `47a883775b2f092c2cf910626120400f03cbc850` and `62f164b6cfff22983963846f4f164c23f7ae62de`, before f5b0a production changes.

```text
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts --reporter=verbose
pnpm exec prettier --check tests/d110c-0c1f5b0a-settlement-codec-red.test.ts
pnpm exec eslint tests/d110c-0c1f5b0a-settlement-codec-red.test.ts
git diff --check
```
