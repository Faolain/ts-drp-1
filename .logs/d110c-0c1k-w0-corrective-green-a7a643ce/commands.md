# D.110c-0c1k W0 corrective GREEN commands

Production commit: `a7a643ceb70ce5c6551de9920c01d2bc96edd464`.

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/protocol-v3-latched-acl-referee-successor-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run tests/protocol-v3-latched-acl-semantics-3d-red.test.ts tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/phase-5e-creator-close-red.test.ts tests/phase-6a-creator-adoption-red.test.ts tests/phase-6a-creator-adoption-commit-red.test.ts --coverage.enabled=false --reporter=dot
pnpm --filter @ts-drp/protocol-v3 build
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/node typecheck
pnpm --filter @ts-drp/node test
pnpm --dir /private/tmp/ts-drp-d110c-0c1k-w0-parent.3pdUQx/repo --filter @ts-drp/node test
pnpm exec vitest run tests/outcome-commit-e5-02-referee-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec eslint packages/protocol-v3/src/latched-acl.ts
pnpm exec prettier --check packages/protocol-v3/src/latched-acl.ts
git diff --check
git verify-commit a7a643ceb70ce5c6551de9920c01d2bc96edd464
git rev-parse origin/codex/d110c-0c1k-w0-green
```

The focused, direct ACL and protocol-v3 typecheck gates were repeated in a
fresh detached worktree after an offline frozen install.
