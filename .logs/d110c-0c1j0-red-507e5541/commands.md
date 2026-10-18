# D.110c-0c1j-0 RED commands

Baseline: signed tests-only commit `507e5541f6831cfc39d0963efc0d8c5f7233b64b` (agent source commit `0d10ceea0b431efedb52a25acc03e1520e33354a`), before D.110c-0c1j-0 production changes.

```text
pnpm exec vitest run tests/d110c-0c1j0-lineage-policy-red.test.ts --reporter=verbose
pnpm exec prettier --check tests/d110c-0c1j0-lineage-policy-red.test.ts
pnpm exec eslint tests/d110c-0c1j0-lineage-policy-red.test.ts
pnpm --filter @ts-drp/protocol-v2 typecheck
pnpm --filter @ts-drp/example-v3-room typecheck
git diff --check
```

The focused test was also executed in the isolated RED worktree rooted at commit `faf0932e17aeafc0a5a25f0959e14beb32d87490` before integration.
