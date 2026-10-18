# D.110c-0c1k W0 GREEN commands

Production commit: `0d6e38c2175806738cc568a56e19e9101a025d05` (integrated form of signed agent commit `06d04b698b46347ea83c9371781c2d78422e6a3c`).

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts --coverage.enabled=false --reporter=dot
pnpm exec vitest run <seven retained ACL/admission/settlement/live-close/adoption files> --coverage.enabled=false --reporter=dot
pnpm exec vitest run <two retained creator-close/adoption-commit files> --coverage.enabled=false --reporter=dot
pnpm --filter @ts-drp/protocol-v3 build
pnpm --filter @ts-drp/control-plane build
pnpm --filter @ts-drp/node build
pnpm --filter @ts-drp/protocol-v3 typecheck
pnpm --filter @ts-drp/control-plane typecheck
pnpm --filter @ts-drp/example-v3-room typecheck
pnpm --filter @ts-drp/example-grid build
pnpm --filter @ts-drp/example-v3-chat build
pnpm exec eslint <exact changed TypeScript paths>
pnpm exec prettier --check <exact changed paths>
git diff --check
git verify-commit HEAD
```
