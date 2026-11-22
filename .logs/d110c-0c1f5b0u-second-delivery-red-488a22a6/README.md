# Second recovered callback: external delivery custody RED

Entry: signed `22e909b91f2a840cd8283319f7c7277c10c168ac`, clean tracked worktree. Tests-only RED commit `488a22a6` was signed and pushed before the sole focused execution. Only `tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts` changed. No production, plan, workload, threshold, dependency or authority changes.

The existing genuine fixture creates a room, issues a snapshot operation, seals and adopts epoch 1 through the product path, then issues two real above-snapshot operations. It retains the resulting two signed deliveries, closes the room, and reopens that same durable room with its genuinely produced snapshot declaration. Nothing fabricates authority, recovery records or expected operation digests.

The new fault fires once on the second room `onAcceptedVertex` callback, after the first callback appends its digest to the external observer ledger. The ledger is not reset, rolled back or deduplicated by the fixture. After refusal, the fault is disabled and the same room is cold-reopened again. There is no second-sink variation or scope expansion.

One focused execution, one file/test, status 1; three unrelated tests filtered out. Exact complete soft-failure set:

| Predicate | Required | Observed |
| --- | --- | --- |
| `REPLAY_SECOND_FAILURE_ATOMIC_EXTERNAL_LEDGER` | empty external ledger after failed open | one callback effect remains |
| `REPLAY_COLD_REOPEN_IDEMPOTENT_EXTERNAL_LEDGER` | two expected ordered digests | three external deliveries |

The callback appends the delivered digest directly; the first attempt reaches callbacks 1 and 2 in exact expected sequence but throws before appending callback 2. The successful replay appends both retained deliveries again, explaining the `d1,d1,d2` trajectory. The reporter preserves cardinalities and exact failure tokens; it abbreviates the digest arrays rather than printing their individual values. No claim is made that the JSON reporter contains those full digest values.

All other selected-case assertions passed: first reopen refuses, the fault is consumed once, no active owner remains and its transport closes, cold reopen succeeds, canonical application bytes equal the original projection, the three application operation IDs (snapshot plus two retained) each occur exactly once, authority is unchanged, and only one recovered owner is active. The demonstrated failure is external observer delivery custody, not duplicate durable issuance or recovered application state.

Format, lint, diff, syntax/source-owner and exact listing checks passed. `run.mjs` records complete commands, statuses/timestamps and separate stdout/stderr; `reporter.json` records the complete soft-failure set with no loader/timeout/top-level error. Before/after custody preserves all 27 stashes, 81 protected entries and clean tracked state. The self-excluding manifest covers every other evidence file. No reviewers, broader retained tests or long workloads ran. The parent owns disposition/reslicing and any production repair; this is RED only.
