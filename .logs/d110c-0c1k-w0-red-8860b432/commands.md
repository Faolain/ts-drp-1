# D.110c-0c1k W0 authoritative RED commands

Tests-only RED commit: `8860b4321938512180444ba0aa6adfbffbfdf810`, superseding the impossible full-shape boundary expectation while preserving the earlier RED history.

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec prettier --check <six exact RED test/fixture paths>
pnpm exec eslint <six exact RED test/fixture paths>
git diff --check
```

The focused command ran in the isolated authoritative RED worktree before any W0 production change.
