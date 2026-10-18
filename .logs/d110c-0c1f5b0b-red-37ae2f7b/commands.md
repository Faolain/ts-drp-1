# Commands and statuses

All commands ran against
`/Users/aristotle/Documents/Projects/ts-drp-1`; no production source, plan,
campaign, long workload, branch switch, stash, or protected untracked path was
changed.

Static checks before the first combined diagnostic exited 0:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec prettier --check tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec eslint tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
```

First combined diagnostic exited 1 with 39 selected, 31 passed, 8 failed, and
0 skipped. Its count was rejected because one test contained both expected
sequence-zero failures and stopped at the first assertion:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-corrective-red-final-39.json
```

After the authorized mechanical structure correction, Prettier, ESLint, and
`git diff --check` exited 0. The single replacement combined RED exited 1 with
the exact accepted 39 = 30 pass / 9 causal fail / 0 skip matrix:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-corrective-red-replacement-39.json
```

The Node experimental-SQLite warning was the only stderr diagnostic.

The signed tests-only commit and remote push succeeded:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 commit -S --only tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts -m "test(node): correct settlement regression expectations"
git -C /Users/aristotle/Documents/Projects/ts-drp-1 push origin codex/phase3a1b-p6-golden-path
```
