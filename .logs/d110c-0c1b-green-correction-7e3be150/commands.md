# D.110c-0c1b final-review correction commands

Initial final review:

```text
Grok 4.6/high session 01a06598-227d-7781-9714-51f30d4b4934
KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi --model kimi-code/k3 --prompt "$review_prompt" --output-format stream-json
CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude -p --model opus --effort xhigh --permission-mode dontAsk --allowedTools Read,Grep,Glob --disallowedTools Bash,Write,Edit,NotebookEdit,Agent,WebFetch,WebSearch --output-format json --json-schema "$review_schema"
```

Accepted focused test:

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1b-green-correction-7e3be150/focused/final-tree.json
```

Accepted retained test:

```text
pnpm exec vitest run tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/e5-01-v3-operation-admission-red.test.ts tests/phase-6a-creator-adoption-commit-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-epoch-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts tests/phase-6b-d110c-b-hot-adoption.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-3a1b-p2-outbox-publication-contract.test.ts tests/phase-6b-issuance-retention-red.test.ts tests/phase-6b-ahe-reclamation-red.test.ts tests/phase-4b-v3-live-snapshot-composition-red.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=.logs/d110c-0c1b-green-correction-7e3be150/retained.json
```

Static/build gates:

```text
pnpm exec eslint packages/node/src/v3-live.ts tests/fixtures/phase-3a1b-p3/live-fixture.ts tests/fixtures/phase-6a-v3/creator-adoption-contract.ts tests/fixtures/phase-6b-d110c-0c1b/committed-issuance-recovery-contract.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts
pnpm exec prettier --check packages/node/src/v3-live.ts tests/fixtures/phase-3a1b-p3/live-fixture.ts tests/fixtures/phase-6a-v3/creator-adoption-contract.ts tests/fixtures/phase-6b-d110c-0c1b/committed-issuance-recovery-contract.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts
pnpm exec tsc -p packages/node/tsconfig.build.json --noEmit --pretty false
pnpm --filter @ts-drp/node build
git diff --check
```

The combined code-plus-plan Prettier check exhausted Node's default 4 GiB heap
while parsing the large plan, before returning a formatting verdict. Code-file
Prettier had already passed. The plan was therefore checked directly with:

```text
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check docs/production-hardening/production-hardening-tdd-plan-v2.md
```

The first attempted focused command named nonexistent `vitest.config.ts` and
selected no tests. Two later focused diagnostics exposed missing per-test
`navigator.storage` setup and an operation that was rejected by the closed
blueprint schema before issuance. A fourth diagnostic proved that the parameter
profile cannot be varied. These results are retained under `focused/`; only
`final-tree.json` is acceptance evidence.
