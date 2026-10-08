# D.110c-0c1j-0 GREEN commands

Production/retained-coverage commit: `b136a603d40d0265ef5a40135cef9c9943e1cfd1` (integrated form of signed agent commit `0ee3d9ea78f3a1a2fb592cff0891c8a62e9f5f85`).

```text
pnpm exec vitest run tests/d110c-0c1j0-lineage-policy-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run packages/protocol-v2/tests/golden-vectors.test.ts packages/protocol-v2/tests/hardening-gates.test.ts packages/protocol-v2/tests/registry.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run <lineage-policy coverage semantic gate> --coverage.enabled=false --reporter=dot
pnpm --filter @ts-drp/protocol-v2 build
pnpm --filter @ts-drp/protocol-v2 typecheck
pnpm --filter @ts-drp/example-v3-room build
pnpm --filter @ts-drp/example-v3-room typecheck
pnpm --filter @ts-drp/example-grid build
pnpm --filter @ts-drp/example-grid typecheck
pnpm --filter @ts-drp/example-v3-chat build
pnpm --filter @ts-drp/example-v3-chat typecheck
pnpm exec eslint <exact changed TypeScript paths>
pnpm exec prettier --check <exact changed paths>
node -e <validate changed golden fixture JSON>
git diff --check
git verify-commit HEAD
```
