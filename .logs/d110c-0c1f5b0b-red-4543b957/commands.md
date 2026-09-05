# Commands and statuses

All commands ran against `/Users/aristotle/Documents/Projects/ts-drp-1` from
signed and pushed baseline `a0ffa071245ee27fa07fd8b2a685922b95a0f167`.

The one authorized Phase-3g retained-file RED exited 1:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-3g-v3-rebase-outbox-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-retained-structural-red-canonical.json
```

Prettier, ESLint, and diff whitespace checks exited 0:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec prettier --check tests/phase-3g-v3-rebase-outbox-red.test.ts
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec eslint tests/phase-3g-v3-rebase-outbox-red.test.ts
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
```

The signed tests-only commit and push exited 0:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 commit -S --only tests/phase-3g-v3-rebase-outbox-red.test.ts -m "test(node): pin legacy causal join intent shape"
git -C /Users/aristotle/Documents/Projects/ts-drp-1 push origin codex/phase3a1b-p6-golden-path
```
