# D.110c-0c1k W0 corrective RED commands

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/protocol-v3-latched-acl-referee-successor-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec eslint tests/fixtures/phase-3a1b-p3/live-fixture.ts tests/protocol-v3-latched-acl-referee-successor-red.test.ts
pnpm exec prettier --check tests/fixtures/phase-3a1b-p3/live-fixture.ts tests/protocol-v3-latched-acl-referee-successor-red.test.ts
git diff --check
git verify-commit f511a18bdb35f56a31757f9739338f48572f00df
```
