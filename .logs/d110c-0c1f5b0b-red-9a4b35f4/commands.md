# Commands and statuses

All commands ran against `/Users/aristotle/Documents/Projects/ts-drp-1`.

The baseline was signed, pushed, and tracked-clean at
`f4be51cecbbaa989a557db6e060e2e157e5812b3`. The supplied candidate patch
validated at SHA-256
`a0e72eee874611eba8bb1703c6ee28a1ad6064b200701efeb6991b78c7e50db0`.

One bounded two-test diagnostic temporarily applied that patch, printed the
complete returned pages, and exited 1 because both old expectations failed:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=verbose -t 'preserves legacy join|surfaces a published same-key'
```

After removing temporary diagnostics and reversing the candidate patch,
`git diff --exit-code --` exited 0. The only final edit was the tests-only
response-shape correction.

Prettier, ESLint, and diff whitespace checks exited 0:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec prettier --check tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/fixtures/phase-3g/rebase-outbox-fixture.ts
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec eslint tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts tests/fixtures/phase-3g/rebase-outbox-fixture.ts
git -C /Users/aristotle/Documents/Projects/ts-drp-1 diff --check
```

The single post-correction combined RED exited 1 with exactly
39 = 25 pass / 14 causal fail / 0 skip:

```sh
pnpm --dir /Users/aristotle/Documents/Projects/ts-drp-1 exec vitest run tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts --coverage.enabled=false --reporter=json --outputFile=/tmp/d110c-f5b0b-final-corrected-red-v2.json
```

The signed tests-only commit and push both exited 0:

```sh
git -C /Users/aristotle/Documents/Projects/ts-drp-1 commit -S --only tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts -m "test(node): correct settlement rebase response shape"
git -C /Users/aristotle/Documents/Projects/ts-drp-1 push origin codex/phase3a1b-p6-golden-path
```

