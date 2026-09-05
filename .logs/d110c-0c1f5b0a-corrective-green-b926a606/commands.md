# D.110c-0c1f5b0a corrective GREEN commands

Production commit: `b926a60658b7ce244f4ef159d634077e0cba3b49` (integrated form of signed agent commit `e8cb75a808074940ac7c600a76a95b9e245f2e5f`). Test corrections are separately signed at `6423364c` and `5418e05e`.

```text
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts tests/d110c-0c1f5b0a-corrective-red.test.ts --coverage.enabled=false --reporter=dot
pnpm install --offline --frozen-lockfile
pnpm build:packages
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/protocol-v2 typecheck
pnpm --filter @ts-drp/control-plane typecheck
pnpm --filter @ts-drp/protocol-v3 build
pnpm exec vitest run <retained trust/authorization/ACL/equivocation selection> --coverage.enabled=false --reporter=dot
pnpm exec vitest run <retained closure/0c1a/5e/6a selection> --coverage.enabled=false --reporter=dot
pnpm exec eslint packages/protocol-v3/src/index.ts packages/node/src/internal/creator-transition-advance.ts
pnpm exec prettier --check packages/protocol-v3/src/index.ts packages/node/src/internal/creator-transition-advance.ts
git diff --check
git verify-commit HEAD
```

The offline install, all package builds, public-package smoke, focused selection, and static gates also ran in a fresh detached worktree.
