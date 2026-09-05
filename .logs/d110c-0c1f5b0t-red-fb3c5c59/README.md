# D.110c-0c1f5b0t causal RED evidence

Tests-only source commit: `fb3c5c599b8c50db55fcf361ea465531fbc90b2b`

The bounded RED selected exactly two Vitest files and 35 tests. Twelve retained
or compatibility controls passed and 23 new positive obligations failed. The
failures are behavioral: current validators reject the additive progress value
and effect, all three stores reject progress-plan installation, Node treats
progress effects as malformed, and the room treats `split-required` as
terminal and ignores durable progress. No test failed because a future symbol
was imported or because a future export was missing.

The independent Chromium test selected exactly one test and failed at the same
boundary: IndexedDB returned `ISSUANCE_INVALID_ARGUMENT`, retained no plan, and
therefore did not round-trip the progress value. The actual Node batch-boundary
control returned a nonmutating `split-required` and passed.

No production file, plan file, wire contract, dependency, threshold, workload,
stash, or protected untracked path was changed. The source commit is signed and
pushed.
