# Track B: take recipient install off the critical path

**Outcome:** Landed in de70325e (recipient lull boundary; install t3+ 1.5-2.2 s -> 0.49-0.75 s).

### Brief (plan given to the agent) (2026-10-19 14:16 UTC)

You are a fork of me. Everything up to commit 4c4f192c is committed; your worktree starts from it. Objective: a real-time game must never stall on epoch transitions. You own TRACK B: recipient install.

Recipient install is now the largest transition stall: about 1.1–1.8 s at t3–t7, against 0.27–0.37 s at t0–t2. From t3, prepareReceivedRecoveryTurnover (creator-adoption.ts ~971-1034) runs recovery-pool turnover inline in install. The redesign DESIGN.md (scratchpad/agent-redesign/DESIGN.md §4) explains why recipients need no resume token: their turnover predicate is state-based, so early retirement simply makes it false at install.

Do:
1. Build a recipient early-maintenance boundary and expose it through the same `V3RoomSession.maintainRecoveryPool()` for recipient sessions, which today return deferred/unsupported. Use the same soft watermark and deferral semantics as the creator. A peer move arriving during it must not halt the room: queue it or defer cleanly. Coordinate the semantics with the creator side described in that DESIGN.md.
2. Profile what remains of install after turnover moves out, including the 0.27–0.37 s baseline (snapshot transfer/verification, accepted publication, settlement), and cut the biggest remaining costs, whether redundant re-authentication or serial IDB reads.
3. Wire the benchmark lull so it also calls the recipient API after each rollover. With the env var unset, the benchmark must behave as before.

Scope: packages/node/src/creator-adoption*.ts, recipient paths in v3-live.ts and v3-room.ts (the recipient session's maintainRecoveryPool), plus tests and the benchmark hook. Another agent owns creator-side maintenance (v3-live ingress, the creator maintainRecoveryPool region) and another owns per-move admission (creator-closed-rollback-data.ts admission code). Keep your hunks out of those regions. Do not touch packages/storage-browser/src/internal/native-read-reservation.ts.

Rules:
- Build dists first: canonical, storage, storage-browser and control-plane. Copy the gitignored benchmark .logs inputs from the main tree if needed.
- Never use rm -rf. Commit only in your worktree branch; do not push.
- Name benchmark runs with an `rb-` prefix and use interleaved paired runs at 8 rollovers.
- Report install per transition, plus recipient move p50/p95 and remote accept, before and after.
- Tests: affected node suites before and after (`--exclude ".claude/**"`), plus new tests for the recipient boundary.

Deliverables in scratchpad/track-b/: DESIGN.md, patch.diff (against 4c4f192c), the test comparison, and the numbers. Keep the final report concise.

### Follow-up instruction — Resume Track B after turn limit (2026-10-19 14:57 UTC)

Continue Track B from where you stopped (you hit the turn limit mid-profiling). Be economical with turns: finish the diagnosis of where recipient install t3+ time goes with what you already have (diag1/diag2 runs), land the recipient early-maintenance boundary plus any clear cuts, get the worktree typechecking, run the affected node tests against your tests-base baseline, and do one or two interleaved paired bench runs (rb- prefix) against your base build with the lull enabled. Then write scratchpad/track-b/REPORT.md (what changed, soundness argument, measured before/after numbers, test delta) and finish with a concise final report. Do not commit; leave changes in the worktree.

### Report returned by the agent (2026-10-19 15:14 UTC)

I've built the recipient early-maintenance boundary and cut the biggest remaining install costs. From t3 onward, recipient install dropped from 1.5–2.2 s to 0.49–0.75 s. Per your instruction nothing is committed: the changes are in the worktree against `4c4f192c`, and the patch is in `<evidence>/track-b/patch.diff`. The harness refused to let me write `REPORT.md` as a subagent, so the report is below instead.

The node package typechecks (`tsc -p tsconfig.build.json`, exit 0). No test that passed at baseline fails now.

#### Where t3+ install time went (diag1/diag2 runs)
- **Before:** the inline recovery-pool turnover took 1.1–1.4 s of each install.
- **After moving it out (t7, about 525–700 ms per install):**
  - stage plus publish: 175–225 ms, because each install re-authenticates five times.
  - accepted publication: 85–124 ms. The new plane re-scans the whole outbox from row 0, and this grows about 3 rows per epoch.
  - activation: 66–82 ms.
  - settlement: 65–108 ms, of which issuing the fence is 45.
  - receive authentication: 110–133 ms.
  - repeat-install check: 30–38 ms.
- The installing recipient's own CPU is only 50–70 ms per install. Most of the rest is waiting on one-at-a-time IndexedDB reads, plus CPU from the other roles: all four iframes in the benchmark share one browser thread, so this part is a benchmark artifact.

#### What changed
1. **Recipient boundary.** `V3RoomSession.maintainRecoveryPool()` now runs turnover for recipient sessions instead of returning unsupported.
   - It closes the same gate an install closes and runs the same seal, the same turnover predicate and the same pass loop. Install and the lull now share these helpers, in `creator-adoption.ts`, `v3-live.ts`, `creator-close.ts` and `v3-room.ts`.
   - It runs in the lifecycle queue and holds the recipient's own moves behind the issue barrier, the same as the creator.
2. **Install cuts:**
   - **Publication cursor carried across the epoch handoff** (`v3-live.ts`): this only applies when the same issuance store, object and author are involved.
   - **Repeat-install precheck** (`v3-room.ts`): an offer for a different epoch or anchor than the current room head skips reading the full successor export.
   - **Lighter "has the head changed" checks** (`creator-adoption.ts`): the three checks inside receive now read the head record only, instead of reloading every closure blob.
   - **Closure blob reads run concurrently** (`creator-adoption-commit.ts`): checks, accounting charges and failures still happen in the original order. One duplicate load is dropped when no proof accounting is counting reads.
3. **Benchmark hook** (`healthy-grid.ts`): after each rollover the lull also calls `maintain` on the three recipients, except after the last rollover. With `STARTUP_HEALTHY_GRID_POOL_LULL` unset, behaviour is unchanged.

#### Why it is safe
- **Deferral before entry.** If the boundary isn't available, the call returns `deferred: busy` and touches no state. If turnover isn't due it returns `not-needed` after read-only work.
- **Failure after entry.** Any failure halts the plane with the gate still closed, and the next install recovers custody first. This is the same rule as a failed install.
- **Peer moves during the lull don't halt the room.** They are dropped at the gate exactly as during an install, then the session requests retained history so peers republish them.
- **No resume token needed.** Turnover is triggered by current state, so a completed lull makes the next install's check false. Measured: receive authentication at t3–t7 fell from 1.1–1.4 s to 0.13–0.17 s.
- **Cursor carry.** The previous plane only moves its cursor past rows it has already verified and that are published or belong to earlier epochs, and the new epoch publishes none of those. The only thing lost is a one-time re-check of old rows; on a corrupted store that re-check would have failed install, and now it doesn't.
- **Precheck.** Treating an install as a repeat still requires exact byte equality with the fully verified export, so this only lets it return "not a repeat" early.
- **Head-only checks.** The first inspection still verifies every blob, and an identical head record pins the same content-addressed blobs.
- **Concurrent reads.** The reads have no side effects, and checks, charges and failures are applied in the original order.

#### Measured: 2 interleaved pairs, 8 rollovers, lull on (`rb-base` vs `rb-b3`, all 4 runs passed)

| Install (ms) | t0 | t1 | t2 | t3 | t4 | t5 | t6 | t7 |
|---|---|---|---|---|---|---|---|---|
| base | 331 | 372 | 427 | 1536 | 1830 | 1928 | 1967 | 2189 |
| after | 318 | 357 | 376 | 492 | 548 | 643 | 555 | 750 |

| Per-move latency (ms) | base, pair 1 / pair 2 | after, pair 1 / pair 2 |
|---|---|---|
| Recipient move p50 / p95 | 50.1 / 81.3, 53.3 / 79.1 | 45.4 / 77.1, 47.3 / 75.8 |
| Remote accept p50 / p95 | 76.0 / 153.6, 81.7 / 170.6 | 75.7 / 155.1, 78.0 / 158.8 |

- At t7, receive authentication went from 1442 to 154 ms and accepted publication from 134 to 24 ms.
- The recipient lull itself costs 0.86–1.23 s per recipient per epoch. It is off the install path, but the recipient's own moves wait while it runs.

#### Tests: 75 affected suites plus the new one, `--exclude ".claude/**"`
- **Before:** 1117 tests, 1009 passed, 104 failed.
- **After:** 1122 tests, 1036 passed, 82 failed.
- **No new failures.** The 22 tests that now pass all failed with timeouts at baseline, so that is load flakiness, not something I fixed.
- **Five new tests** in `packages/node/tests/creator-recipient-recovery-pool.test.ts`. One is a real call: a plane with no recipient registration returns unsupported without touching anything. The other four only check the source code's shape (the gate, the halt rule, the FIFO and barrier, and what the cuts are bound to). There is no real-network test of the boundary yet.

#### Open issues
- **Epoch-8 bug, also in base.** Recipient turnover at epoch 8 fails with "journal retirement refused: malformed-input": the protected scopes exceed the journal retirement limit of 7. A 10-rollover base run (`run-rb-base-r10c`) fails the same way at install t8, which is why the benchmark skips the recipient lull after the last rollover.
- **Reopen untested.** Reopening right after a maintained lull isn't tested, and the activation resume rule may apply there. The benchmark's later persisted reopen passed.
- **Remaining levers, largest first:**
  - Stop re-authenticating five times in stage/publish (about 180 ms).
  - Activation (about 70 ms).
  - Fence issue (45 ms): that is in the per-move admission track.
  - The outbox scan in `readRebaseOutbox` (about 14 ms and growing): the same cursor approach should work.
  - The one-at-a-time blob reads in `inspectHead` in `creator-close.ts`: shared with the creator side, so I left it alone.

The diagnostic phase lists were only inserted for those builds. `build.ts` was restored from `4c4f192c` and has no diff.

Everything is in `<evidence>/track-b/`:
- patch.diff
- tests-after.json
- testcmp.py
- run-rb-pair-l1-base-1/ and run-rb-pair-l1-base-2/
- run-rb-pair-l1-b3-1/ and run-rb-pair-l1-b3-2/
- run-rb-diag1-l1/ and run-rb-diag2-l1/
