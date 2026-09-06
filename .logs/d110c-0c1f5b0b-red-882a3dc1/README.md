# D.110c-0c1f5b0b Node RED evidence

This root records the tests-only RED at signed commit
`882a3dc1de1a550003b0e105fbbb89444e915b2e`.

The corrected semantic RED and a detached clean-worktree reproduction each
selected exactly one file and 27 tests: 6 controls passed and 21 intended
product obligations failed. There were no missing-import, missing-export,
module-load, fixture-setup, skipped, or unexpected failures.

The earlier authoring run selected the same 27 tests but contained fixture
mistakes. It is diagnostic only and is not represented as the semantic RED.
After those tests-only fixture corrections, the semantic and isolated runs
matched exactly.

`vitest-result.json` is a direct machine-readable rerun at the same signed
commit for durable reporter capture. It is evidence capture, not a changed RED
expectation. The original semantic and isolated summaries and the complete
title matrix are recorded in `result.json` and `causal-matrix.md`.
