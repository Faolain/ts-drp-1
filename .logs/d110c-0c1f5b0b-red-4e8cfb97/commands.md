# Commands and statuses

All commands ran against `/Users/aristotle/Documents/Projects/ts-drp-1`.

The starting HEAD was signed, pushed, and tracked-clean:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 log --format='%H %G? %s' -1
git -C /Users/aristotle/Documents/Projects/ts-drp-1 status --porcelain=v1 -uno
git -C /Users/aristotle/Documents/Projects/ts-drp-1 rev-parse @{u}
```

Prettier, ESLint, and diff whitespace checks exited 0:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec prettier --check tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec eslint tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
```

The single authorized combined RED exited 1 with the accepted exact
39 = 25 pass / 14 causal fail / 0 skip matrix:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-corrected-red.json
```

The signed tests-only commit and remote push exited 0:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 commit -S --only tests/fixtures/phase-3g/rebase-outbox-fixture.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts -m "test(node): correct settlement source identity"
git -C /Users/aristotle/Documents/Projects/ts-drp-1 push origin codex/phase3a1b-p6-golden-path
```
