# Node callback wording: source-only corrective RED

Entry: signed/pushed `d9d9487c8d67d5955849c6fa85b4aed401de439b`, clean tracked worktree. Read the final-review prompt under `.logs/d110c-0c1f5b0v-final-review-d9d9487c/` and the supplied P1 finding. Tests-only commit `e8e7b027` was signed/pushed before the single focused execution. Only `tests/phase-6b-d110c-0c1f5b0v-callback-contract.test.ts` changed.

The existing TypeScript AST lookup identifies the room input callback and exported Node sink alias. Shared replayability and digest-deduplication guidance stays pinned. Room retains its exact current-session close-on-rejection wording. The Node surface instead requires these exact statements:

```text
Successor-recovery callback rejection rejects and deactivates activation.
Ordinary authenticated ingress and local issue retain legacy log-and-continue behavior on rejection.
Failure, crash or cold reopen may replay notifications.
```

It also refuses the old blanket session-closure sentence on Node. The room callback signature and Node function-type shape checks remain; the complete consumer-inventory test is unchanged and was not selected for execution.

One source-only selected test/file failed with exactly one token: `NODE_CALLBACK_REJECTION_GUIDANCE_IS_SURFACE_SPECIFIC`. Room guidance, common guidance and type-shape controls passed. The untouched Node comment lacks the three replacement statements and still contains the blanket claim. No product code was executed by this selected test: it parses source text. The result is not an import/export, loader or timeout failure and does not claim a new runtime experiment.

Mechanical inspection motivating the distinction: ordinary authenticated ingress catches sink rejection and logs `sink-rejected` (`packages/node/src/v3-live.ts` around 4120); local issue also catches/logs and then returns `localIssueSuccess` (around 6691). Existing review evidence owns the successor-recovery activation and room cleanup semantics. This RED freezes accurate surface-specific documentation, not altered runtime semantics.

Format/lint/diff/list/syntax/source-owner checks passed. `run.mjs` records exact commands, statuses, timestamps, reporter and separate stdout/stderr. `source-check.json` records unchanged production and consumer-inventory custody. All 27 stashes and 81 protected entries remain unchanged; tracked worktree is clean. The self-excluding manifest covers every other file in this root. No production/plan change, reviewer, Fable, long test or runtime behavior change occurred. Parent owns the narrow JSDoc GREEN correction and review disposition.
