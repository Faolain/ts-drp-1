# Commands

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm build:packages
pnpm exec prettier --check tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
pnpm exec eslint tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
git diff --check
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=verbose
git worktree add --detach /private/tmp/ts-drp-f5b0b-public-repro.CTla5m/repo f7f693b7ec3eddcc68694ad093e807067b9333a7
```

The detached worktree repeated the offline frozen install, package build, and
focused Vitest command.

Durable reporter capture on the same signed commit:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5b0b-red-f7f693b7/vitest-result.json
```
