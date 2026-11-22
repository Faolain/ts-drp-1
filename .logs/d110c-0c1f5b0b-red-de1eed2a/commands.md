# Commands

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm build:packages
pnpm exec prettier --check tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
pnpm exec eslint tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
git diff --check
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=verbose
git worktree add --detach /private/tmp/ts-drp-f5b0b-red-correction-repro.78COqM/repo de1eed2a6be65ed022f8b502e4cdd6208a234dd1
```

The detached worktree repeated the offline frozen install, package build, and
focused Vitest command.

Durable reporter capture on the same signed commit:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5b0b-red-de1eed2a/vitest-result.json
```
