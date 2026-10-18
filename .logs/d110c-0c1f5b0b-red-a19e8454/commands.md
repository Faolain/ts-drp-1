# Commands and results

All repository commands used `/Users/aristotle/Documents/Projects/ts-drp-1` as their working directory or used `git -C` with that absolute path.

## Focused RED — exactly once

```sh
pnpm exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --reporter=json --outputFile=/tmp/d110c-0c1f5b0b-final-corrective-red.json
```

Exit 1, expected RED. The complete reporter is `focused-red.json`.

## Static checks

```sh
pnpm exec prettier --check tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts
pnpm exec eslint tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
```

The first ESLint check found only one import-order error. The import was reordered without changing behavior. Final statuses were Prettier 0, ESLint 0, and diff-check 0. Initial and final ESLint outputs are retained.

## Commit and remote

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 commit -S --only tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts -m "test(hardening): pin legacy settlement compatibility red"
git -C /Users/aristotle/Documents/Projects/ts-drp-1 push origin codex/phase3a1b-p6-golden-path
git -C /Users/aristotle/Documents/Projects/ts-drp-1 log --format='%H %G? %s' -1
git -C /Users/aristotle/Documents/Projects/ts-drp-1 rev-parse origin/codex/phase3a1b-p6-golden-path
```

Both local and remote resolved to `a19e84549e5d0a946ebf084bcbcecf72b4cc2df4`; the signature marker was `G`.
