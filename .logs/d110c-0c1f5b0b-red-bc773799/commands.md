# Commands and statuses

All commands ran from `/Users/aristotle/Documents/Projects/ts-drp-1` through
`pnpm --dir` or `git -C`; no branch switch, campaign, or long workload ran.

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec prettier --write tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/fixtures/phase-3f-b/frontier-reduction-fixture.ts tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec eslint tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/fixtures/phase-3f-b/frontier-reduction-fixture.ts tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
```

Static gates exited 0.

Initial diagnostic, exit 1:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-corrective-red.json
```

Corrected 11-test diagnostic, exit 1:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-corrective-red-corrected.json
```

Final accepted RED, exit 1:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-corrective-red-final.json
```

The Node experimental-SQLite warning was the only stderr diagnostic in each
run. Commit `bc773799` was signed and pushed before this evidence root was
authored.

