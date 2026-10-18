# D.110c-0c1f5b0a corrective RED commands

Tests-only corrective commit: `6921ec6518c61bc853c41b0044832801671f2121` (integrated form of signed agent commit `cbd5d7047b7b1798e40b26da7f9d2cdc359b64f6`).

```text
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/d110c-0c1f5b0a-corrective-red.test.ts --coverage.enabled=false --reporter=dot
pnpm build:packages
pnpm exec eslint tests/d110c-0c1f5b0a-corrective-red.test.ts
pnpm exec prettier --check tests/d110c-0c1f5b0a-corrective-red.test.ts
pnpm exec tsc <targeted strict test configuration>
git diff --check
git verify-commit HEAD
```

The same focused selection ran in the isolated corrective RED worktree rooted at `9ad3d9577369691f05da4d2dad666109fc1d97bf`.
