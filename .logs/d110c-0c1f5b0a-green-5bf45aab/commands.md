# D.110c-0c1f5b0a GREEN commands

Production commit: `5bf45aabc390efcb04a8034062899531c971508d` (integrated form of signed agent commit `286b5a8daee371a6fdf3f5206ea86666823b3af0`).

```text
pnpm install --offline --frozen-lockfile
pnpm exec vitest run tests/d110c-0c1f5b0a-settlement-codec-red.test.ts --coverage.enabled=false --reporter=dot
pnpm build:packages
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/protocol-v2 typecheck
pnpm --filter @ts-drp/control-plane typecheck
pnpm exec eslint <exact changed TypeScript paths>
pnpm exec prettier --check <exact changed paths>
git diff --check
```

Retained selections covered protocol-v3 settlement/legacy frontier/ACL/registry, Node close/adoption/0c1a, protocol-v2 registry, anchor trust, and current-author authorization.
