# Commands

Author worktree semantic RED:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=verbose
```

Detached reproduction:

```sh
git worktree add --detach /private/tmp/ts-drp-f5b0b-repro.q04hc0/repo 882a3dc1de1a550003b0e105fbbb89444e915b2e
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm build:packages
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=verbose
```

Durable reporter capture in the main worktree at the same commit:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5b0b-red-882a3dc1/vitest-result.json
```

Static custody:

```sh
git verify-commit 882a3dc1de1a550003b0e105fbbb89444e915b2e
git diff --name-status 0cf461041fbfc0191030ed563b727edb0453008a..882a3dc1de1a550003b0e105fbbb89444e915b2e
git diff --check 0cf461041fbfc0191030ed563b727edb0453008a..882a3dc1de1a550003b0e105fbbb89444e915b2e
```
