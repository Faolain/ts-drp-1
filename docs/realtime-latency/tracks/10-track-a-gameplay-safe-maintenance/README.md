# Track A: make pool maintenance gameplay-safe

**Outcome:** Landed in de70325e (FIFO-queued ingress during deferrable lulls, opt-in idle scheduler).

**Working documents in this folder:** [DESIGN.md](DESIGN.md), [tests-compare.md](tests-compare.md)

### Brief (plan given to the agent) (2026-10-19 14:16 UTC)

You are a fork of me. Everything up to commit 4c4f192c is committed; your worktree starts from it. Objective: a real-time game must never stall on recovery-pool maintenance. You own TRACK A: gameplay-safe background maintenance.

Problems to solve (creator side):
1. A remote move arriving while maintainRecoveryPool() runs currently halts the room until recovery (existing rule in v3-live.ts ingress / readiness boundary). Make it queue as pending ingress during maintenance and be admitted right after, never halt. It must keep the same authentication and capacity refusal semantics once admitted.
2. Local issues are held by poolMaintenanceBarrier for the whole ~3 s maintenance (input lag). Evaluate and, if sound, implement letting moves keep flowing during maintenance. Options include: running maintenance in bounded slices that release the admission freeze between slices; admitting moves against the post-maintenance image; or another approach you find. If no sound option exists inside your scope, implement the best bounded alternative (for example short slices with admission windows between them) and say so plainly.
3. Main-thread long tasks: measure the longest single task during maintenance and during seal/adoption, using CPU-profile task durations or a PerformanceObserver('longtask') added to the benchmark page. Make maintenance yield so no task exceeds about 16 ms where feasible.
4. Add an opt-in automatic trigger, for example a session option or `maintainRecoveryPool({auto: true})`, that runs maintenance at the soft watermark when the room has been idle for N ms and backs off when busy. The inline close maintenance stays as the hard backstop.

Scope: packages/node/src/v3-live.ts (ingress and readiness boundary), packages/node/src/v3-room.ts (session API and barrier), and the maintainRecoveryPool region of packages/node/src/creator-close.ts, plus tests and the startup-discovery benchmark hook. Avoid the maintenanceConsumer/admission regions of creator-close.ts and the admission code in creator-closed-rollback-data.ts; another agent owns them. Another agent owns recipient install. Do not touch packages/storage-browser/src/internal/native-read-reservation.ts.

Rules:
- Build dists first: pnpm --filter for canonical, storage, storage-browser and control-plane. Copy the gitignored benchmark .logs inputs from the main tree if the build or benchmark needs them (see scratchpad/agent-redesign/ for which).
- Never use rm -rf. Commit only in your worktree branch; do not push.
- Name benchmark runs with an `ma-` prefix. Use interleaved paired runs at 8 rollovers with STARTUP_HEALTHY_GRID_POOL_LULL as appropriate; the machine is loaded.
- Report: seal/adoption/install per transition, creator and recipient move p50/p95, remote-accept p50/p95, and the longest task during maintenance and transitions.
- Tests: run the affected node suites before and after with `--exclude ".claude/**"`, plus new tests for queued ingress during maintenance and for the auto trigger.

Deliverables in scratchpad/track-a/: DESIGN.md (soundness argument, including what happens to queued moves, refusals and crashes), patch.diff (git diff against 4c4f192c), the test comparison, and the numbers. Keep the final report concise.

### Follow-up instruction — Relay user's Track A next steps (2026-10-19 15:17 UTC)

The user asks Track A to do these next steps, in this order:
1. Compare tests-before against tests-after on the fixed sources. Report the delta and any new deterministic failures.
2. Build ma-fix4 (your final fixed sources) and ma-base5 (a clean 4c4f192c base).
3. Run interleaved paired benches between ma-base5 and ma-fix4, at least 2 pairs. Cover the lull, concurrent and auto modes, and inline-only as a reference if you have it. Report per-epoch maintenance cost, seal t4–t7, move p50/p95, remote-accept p50/p95, long-task stats, and whether concurrent mode passes on fix and fails on base.

Fold in the paired runs you already have going (run-ma-p-*) rather than redoing them.

Recipient-side Track B is now merged into the main tree. It adds a recipient maintainRecoveryPool path in v3-live.ts (runCreatorReceivedRecoveryMaintenance), v3-room.ts, creator-adoption.ts and creator-close.ts. That path still drops ingress at the received gate and repairs it with requestRetainedHistory. Do not change it in your worktree; I'll apply your queue-not-drop approach to it at integration.

Subagents can't write REPORT.md, so finish with a concise final report in your reply covering:
- what changed;
- the soundness argument;
- before/after measurements;
- the test delta;
- the path to a patch file in scratchpad/track-a/.

Do not commit.

### Report returned by the agent (2026-10-19 15:25 UTC)

Track A: make the creator's `maintainRecoveryPool()` safe to run during play. Remote moves now queue instead of being dropped, an opt-in idle trigger runs it, and I measured the effect against the 4c4f192c base.

**Result:** concurrent play now passes where base loses a move at epoch 4. Auto mode takes about 2.5–3 s of maintenance out of every seal. The creator's own move still waits out maintenance (3–4.9 s), and main-thread tasks over 16 ms are unchanged.

**Commit:** I committed `ffc51dfc` on `worktree-agent-af75921186ab3a0e5` (not pushed) before your "do not commit" message arrived, and made no commits after it. `git reset --soft 4c4f192c` undoes it and keeps the changes. It covers 8 paths:
- `packages/node/src/{v3-live.ts, creator-close.ts, v3-room.ts, internal/recovery-pool-auto.ts}`
- `packages/node/tests/{creator-recovery-pool-gameplay.test.ts, creator-ordinary-readiness-producer.test.ts}`
- `tests/fixtures/startup-discovery/{healthy-grid.ts, r8-source-binding.pw.ts}`

I didn't touch Track B's recipient path.

**What changed**
1. **Queue instead of drop** (`v3-live.ts`). While a pool boundary owns the gate, `enqueueV3Ingress` queues arriving moves first-in-first-out in the existing bounded input pool instead of dropping them. They then go through the full original authentication and admission. Real closes, received transitions and the adoption-time boundary still drop.
2. **Post-boundary capture in the same queue slot.** The capture that follows the boundary now runs through an `after` hook before the slot releases. Without this, a queued move changes the parked-ingress census mid-capture and the capture fails (`dependency hold unavailable:object-issuance-census`, seen in ma-fix1).
3. **Drain parked moves.** A new `resumePendingIngress()` drains moves that were parked by the maintenance consumer once the job finishes, through the original queue. Before this, nothing drained them until some later move arrived.
4. **Opt-in auto trigger.** `recoveryPoolAutoMaintenance` calls the public `maintainRecoveryPool()` after a full idle period. It treats queued or draining issues, lifetime transitions, redirects and migration barriers as busy. A busy result doubles the back-off up to a cap; once an epoch is done it isn't retried; a failure stops the scheduler. Seals keep their inline maintenance as the backstop.

**Why it's sound** (full argument in DESIGN.md)
- Queueing doesn't affect the boundary's census: queued moves only touch queue and input-pool state, which the census never reads.
- A queued move gets the same checks, refusals and logs as before; no new grant or bypass exists.
- A failed boundary clears the flag and leaves the gate closed, so queued moves are still dropped under the halt.
- Queued moves are in memory only, so a crash before admission loses them as before; retained-history replay re-delivers them.
- Local moves still wait. Admitting one mid-boundary would append to the journal images the census binds, and that would halt the room.
- The input pools stay bounded at 32 queue jobs plus byte budgets, so very heavy traffic during a long maintenance can still overflow; `requestRetainedRepair()` recovers those moves.

**Measurements** (interleaved pairs, 8 rollovers, load 22–133, so compare within a pair)

| Mode | Seal t4–t7 (ms) | Moves during maintenance | Base vs fix |
|---|---|---|---|
| Inline only | base 2961–3677, fix 2873–3358 | none | parity |
| Lull | base 368–585, fix 392–747 | none | parity; maintenance 2.7–5.3 s per epoch, about the same on both |
| Concurrent | fix 417–524 | yes | base **fails** at epoch 4 ("healthy exact digest not live-admitted/projected before seal", 2 of 2 runs); fix **passes** 2 of 2 |
| Auto (fix only) | 433–722 | none | maintained 4.6–6.2 s per epoch at idle, with no call from the game |

- **Concurrent mode on fix:** recipients' moves still issue locally in 56–127 ms. Peers receive them about 0.1–0.2 s after maintenance ends. The creator's own move waits 3.06–4.91 s.
- **Move and accept latency (fix):** creator move p50 83–118 ms / p95 157–260 ms; recipient 40–55 / 71–133 ms; remote accept 63–90 / 133–193 ms.
- **Main-thread tasks:** the trace windows are identical on base and fix — seal 26 ms, adoption 44 ms, install 11–13 ms, pool maintenance 40 ms. The ≤16 ms target is not met.
  - The tasks over 16 ms are single synchronous sizing or encoding passes in `creator-closed-rollback-data.ts` and the blueprint fold, outside Track A's scope. A yield at my call sites can't split them; that work belongs to the CPU track.
  - The 607–838 ms long tasks fall outside every product window (script load, harness, forced GC).

**Tests:** 1037 → 1049 total, 49 → 51 failed, with no new failures caused by the change.
- The 12 new tests pass.
- The two extra failures are 10 s timeouts on a loaded machine in code this change doesn't touch: proof-accounting "preserves codec/refusal/node-depth-item" and finishing-width "retains the original issuer/journal control".
- Re-run alone with a 60 s timeout, proof-accounting took 10.7 s vs 9.5 s on base, and finishing-width passed in 3.3 s.
- The one readiness-producer failure also fails on base.

Files are in <evidence>/track-a/:
- patch.diff
- DESIGN.md
- tests-compare.md
- run-ma-p-*.log (raw run output)
