# Track F: admit moves concurrently with maintenance

**Outcome:** NOT MERGED: sound, but maintenance per epoch grew 3.8 s -> 5.2-6.9 s and the creator's issue() 3.9 -> 5.1 s.

### Brief (plan given to the agent) (2026-10-19 15:43 UTC)

You are Track F. Goal: during recovery-pool maintenance, both remote and local moves must be durably admitted and delivered, with no wait for maintenance to end.

Problem, measured by Track A on ma-fix4 in concurrent mode:
- Peers' moves go through locally in 56–127 ms, but reach the other clients only after maintenance ends: up to about 4.8 s at epochs 6–8.
- The creator's own moves wait out the whole maintenance run, 3.1–4.9 s.
- The cause, per Track A's DESIGN.md: the boundary's reconciliation binds the live journal and issuance native images into its census, and its native retirement transactions compare against them. An ordinary admission appends to the live journal and the issuance outbox, so admitting one mid-boundary would invalidate the census and halt the room. Track A therefore queues moves behind the boundary.
- The same applies to the recipient lull (runCreatorReceivedRecoveryMaintenance) and to inline seal and install turnover.

Setup:
- Your worktree starts at 4c4f192c. Apply `git apply <evidence>/track-e/base-int.patch` first. It contains Tracks A, B and D, recipient queueing and the paged reads.
- Rebuild the canonical, storage and storage-browser dists, then build a base bench bundle.
- Use the `cf-` prefix and scratch dir `<evidence>/track-f/`.
- Do not commit.
- Other agents run concurrently:
  - Track E: maintenance cost and pass structure. Do not redesign the pass loop.
  - Track G: optimistic presentation.
  - Track H: long tasks.
- The machine is loaded, so use interleaved paired runs.
- You have about 200 turns; budget them.

Work:
1. Find exactly which census and image facts an ordinary admission would invalidate, and which the retirement actually needs. Retirement retires closed, older epochs, while admission appends current-epoch rows.
2. Design a scheme that lets current-epoch appends proceed while maintenance runs. For example:
   - a census that binds only retired and closed scopes plus an append watermark for the current epoch;
   - retirement transactions that compare only the rows they delete or move;
   - admissions run between short maintenance slices, with a cheap revalidation that proves the bound facts did not change.
3. State the safety invariant and prove it:
   - argue why no retirement decision depends on rows an admission can add;
   - write tests where moves are admitted mid-maintenance, including failure injection on both sides, and the final durable state and refusals match the serialized order;
   - run the affected node and storage-browser suites against your base and report the test delta.
4. Measure with paired Grid runs, STARTUP_HEALTHY_GRID_POOL_LULL=concurrent, base vs yours, at least 2 pairs. Report:
   - peer delivery time for moves issued during maintenance;
   - creator own-move latency during maintenance;
   - ordinary move p50/p95;
   - whether everything still passes.

If no sound scheme exists within this codebase's safety model, show why with concrete evidence, and quantify the best sound bound you can reach (e.g. bounded slices that admit queued moves every N ms).

Deliverables: a patch file in your scratch dir, against base-int.patch applied, and a concise final report in your reply. Subagents can't write REPORT.md.

### Follow-up instruction — Resume Track F with tighter brief (2026-10-19 16:18 UTC)

Resume Track F: you hit the 200-turn limit mid-implementation ("Now add the boundary predicate next to the maintenance job"). Finish in at most ~60 more turns. Priorities, in order:
1. Complete the in-progress change in your worktree so it typechecks: `pnpm --dir packages/node exec tsc -p tsconfig.build.json --noEmit`, plus any other package you touched.
2. Add or adjust focused unit tests that prove soundness: a move admitted during maintenance is never lost, duplicated or reordered against the maintenance census or seal; any gate or flag is cleared on every exit path, including halt and throw.
3. Run the affected node tests, and compare before/after failure sets against base-int.
4. Only if time allows, run ONE paired concurrent bench (STARTUP_HEALTHY_GRID_POOL_LULL=concurrent). Report the creator's own-move latency and peer delivery latency during maintenance, against base.
Do NOT commit. Don't write REPORT.md. Reply with: (a) the design, explaining why it's safe against the census/journal/issuance image binding; (b) the patch path (write `git diff` output to <evidence>/track-f/patch.diff); (c) test results; (d) bench numbers, if run; (e) known risks.

### Report returned by the agent

Track F: let both remote and local moves be durably admitted and delivered during recovery-pool maintenance, with no wait for maintenance to end; no commit.

#### Report

**(a) Design and why it is safe**

What an admitted move invalidates (measured, not assumed):
- **Within one stage:** the census sealed by `sealCreatorRecoveryDependencies` (journal replay, issuance census, outbox, `graphVersion`, `pendingIngress`), the boundary's `enteredGraph`, and the native retirement images it compare-and-swaps against (journal `retirementSnapshot` and issuance `browserRetirementRows`, which cover all epochs, current one included).
- **Across stages:** two saved resume-basis digests, the signing `summarySource.resumeBasisDigest` and the AHE generation-drain basis. Both hash the whole `journalImage`, the issuance rows and `journal.canonicalRows`, current epoch included.
- **Evidence:** a build that let moves in after every pass failed at epoch 4 with `floor-stale`, because the summary→generation drain is bound across stages.

The scheme is called rest-point stage slicing:
- **One stage per queue slot.** Each stage runs as its own FIFO slot, seals a fresh census, and does its compare-and-swap inside that slot.
- **Moves wait at rest points only.** Between slots, queued local issues and received ingress run the full original admission path against a freshly captured readiness source.
- **Bound stages stay together.** The new predicate `creatorRecoveryStageBoundaryBound` treats a boundary as bound if anything is active, nominated or pending, if the frames are unrecognised, or if a signing summary is bound to a matching AHE preparation. Bound stages stay in the same slot.
- **Inside a slot nothing changes:** the pool job is the only job the consumer accepts, and the source is detached until the stage ends.
- **The public preflight** may queue behind an entered pool stage, but `issueLocal` still refuses any closing gate inside its task.

Why this holds against the census/journal/issuance image binding:
- Every census→compare-and-swap happens in one exclusive slot.
- Moves land only at saved states that carry no cross-stage basis.
- `installClosedRetirementSource`'s `floor-stale` check stays as a fail-closed backstop.
- Any stage failure halts admission, as in base.
- The resulting order is: stage 1 → moves → stages 2+3 → moves → stage 4.

**(b) Patch:** `<evidence>/track-f/patch.diff`
- It covers 9 files (+745/−104), including the new test file `creator-recovery-pool-staged.test.ts`.
- I checked that it applies cleanly to the base-int sources and that the result is byte-identical to the worktree.
- The worktree is uncommitted.

**(c) Tests**
- **Typecheck:** `pnpm --dir packages/node exec tsc -p tsconfig.build.json --noEmit` reports 0 errors.
- **New staged tests: 21/21 pass.** They cover:
  - each stage's census equals exactly the moves serialized before it (census `[0,2,3,6]`), with each move once and in order;
  - no move inside a stage;
  - a later stage failure halts admission, earlier moves stay durable and later ones are refused;
  - the gates are cleared on every exit path: continue, throw, a `between` throw, deferral, and a `continue` that sealed nothing;
  - bound stages stay in one slot;
  - readiness is re-proven after every slot;
  - exactly one release on failure;
  - classification by the predicate.
- **Other pool suites pass:**

  | Suite | Result |
  |---|---|
  | recovery-pool | 5/5 |
  | recipient-recovery-pool | 6/6 |
  | recovery-pool-gameplay | 12/12 |
  | readiness-producer | 69/70 |

  The one readiness-producer failure ("genuine same-head pair…") also fails on base.
- **Full node suite, fix vs base-int:**

  | | Passed | Failed |
  |---|---|---|
  | Fix | 906 | 49 |
  | Base-int | 890 | 44 |

  - 44 failures are shared by both, and none fail only on base.
  - The 5 fix-only failures were rerun on the fix:
    - **firewall:** now passes. It had failed because the base swap rebuilt `dist` mid-run.
    - **accepted-effect-index and AHE metadata width:** now pass.
    - **journal-capacity `sql=true 124` and proof-accounting "same sizing owner":** these are 10 s timeouts at load 65–135. The journal one now passes; a sibling variant timed out instead. Both take about 9.5 s on base too, and neither runs code I changed.
  - So the run shows no failures caused by the change.
- **storage-browser:** not touched, so no change by construction.

**(d) Bench:** one interleaved pair with `STARTUP_HEALTHY_GRID_POOL_LULL=concurrent`, run at load average 106–135, so it is very noisy. Both runs passed (8 rollovers, persisted reopen, continued gameplay).

| Measure | Base | Fix |
|---|---|---|
| Creator maintenance per epoch | 3.7–3.9 s | 5.2–6.9 s |
| Peer move issued at +250 ms, delivered | 3.5–3.8 s | **2.55–2.77 s** |
| Peer move at +1500 ms | 2.4–2.7 s | 3.1–4.0 s |
| Peer move at +2700 ms | 1.3–1.6 s | 1.9–2.8 s |
| Delivery during maintenance, p50 / max | 2434 / 3944 ms | 2585 / 4023 ms |
| Creator's own move, `issue()` resolves (p50) | 3928 ms | 5097 ms |
| Creator's own move, delivered to peers | ~3.9 s | **~2.6–2.8 s** |
| Ordinary issue / accept latency | | unchanged (creator p50 120–126 ms) |

**Verdict:** the change is sound but only partly helps. It does not reach the ms range:
- A move made during maintenance can wait as long as the longest bound slot. Stages 2+3 stay together, about 2.4–3.1 s per slot including re-capture and moves.
- Total maintenance gets longer, and moves issued later in the run are worse than base.

**(e) Known risks**
1. Re-capturing readiness after each slot adds about 1.5–3 s of total maintenance per epoch.
2. The creator's `issue()` promise still resolves late (~5 s), even though the move is admitted and delivered at about 2.6 s.
3. `betweenStages` uses a 500 ms cap with a `Promise.race`. A drain that takes longer is left running behind the next stage, which is safe but slower.
4. The predicate depends on the control-frame layout. If it misclassifies a bound boundary as unbound, the result is `floor-stale`, which fails closed and halts admission: correct, but it stops play.
5. Continuation deferral leaves partial maintenance to the seal backstop.
6. The recipient mid-lull local-issue path has unit tests but was never benchmarked.
7. There is only one bench pair, at extreme load.
8. Real ms-level latency needs a narrower resume basis: closed-scope rows plus a current-epoch classification, a v3 digest domain in `creator-closed-rollback-data`. That would allow a yield after every stage (≈0.5–0.8 s bound). It is a protocol change with a resume/upgrade compatibility risk, and it is not implemented.
