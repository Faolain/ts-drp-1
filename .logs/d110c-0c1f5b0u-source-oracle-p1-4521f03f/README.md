# Final-review P1 A: returned binary operands

Entry was signed commit `60548549219378b30548c3c638da178561c17875` with a clean tracked worktree. This is tests-only governance repair; no production source, configuration, workload, threshold or dependency changed.

Before changing the oracle, the added mutant test ran once with:

```text
pnpm exec vitest run tests/phase-6a-creator-successor-product-red.test.ts -t 'tracks the returned operands of assignment, comma and logical assignment expressions' --no-file-parallelism --coverage.enabled=false --reporter=json
```

`red-result.json` preserves the complete tool-captured output (combined stream capture, not independently separated stdout/stderr), status 1, and JSON reporter. `red.patch` is the tests-only mutation against the clean entry. One selected test failed with exactly nine soft assertions `expected true to be false`: assignment, comma, three logical assignments returning the right operand, those same three potentially returning the left operand, and a nested assignment/comma/object return. Four safe primitive/right-value controls did not fail. This is causal oracle RED, not a missing import/export or product defect.

The fix inspects only the right operand for `=` and comma, and either operand for `&&=`, `||=` and `??=` alongside existing logical operators. Other binary operators produce primitives. No additional alias analysis or ownership boundary is introduced. The entire existing `d108d2SourceGovernance` function remains unchanged; syntax validation is preserved in `source-check.json`.

The tests/oracle correction was signed and pushed at `4521f03f` before one focused GREEN invocation. `run.mjs` records exact format/lint/diff/list/selected-test commands, statuses and separate GREEN stdout/stderr. Five selected tests cover the new nine-negative/four-positive table, the existing seven forbidden-name and alias/global/private-computation controls, and the retained product-source assertion. Seven unrelated file tests are filtered out, not rerun. No other retained test, campaign or reviewer was invoked.

Before/after custody preserves all 27 stashes, 81 protected entries and clean tracked state. The self-excluding manifest covers every other file. The parent owns final-review disposition and overall GREEN closure; this packet addresses P1 A only. The runner and evidence generator are write-once and must not be rerun into this root.
