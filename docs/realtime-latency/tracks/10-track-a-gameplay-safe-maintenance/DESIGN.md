# Track A: gameplay-safe recovery-pool maintenance

Task: make creator `maintainRecoveryPool()` safe to run while a real-time game is
being played. Remote moves must queue and be admitted afterwards instead of being
lost or halting the room, local moves must keep a bounded path, main-thread long
tasks must be measured, and an opt-in idle trigger must exist. Inline close
maintenance stays as the backstop.

## What actually happened before (measured, 4c4f192c)

`maintainRecoveryPool()` runs in three phases on the creator:

| Phase | Where | Gate state | What a remote move did |
|---|---|---|---|
| P1 pre-checks | creator-close, outside the registration queue | the maintenance job is registered (`maintenanceJobs`) | consumer refuses it; parked in `pendingIngress`; the boundary then defers |
| P2 boundary (~2.9–3.7 s) | `runCreatorOrdinaryReadinessMaintenance`, one registration-queue task | `blueprintClosing = true` | **dropped** in `enqueueV3Ingress` (`blueprintClosing` gate) |
| P3 post-capture | creator-close, outside the queue | the maintenance job is still registered | consumer refuses it; parked; nothing drains it until a later admission |

The "halt" in the earlier note was the fail-closed rule for a census that changes
after entry. That cannot happen from ingress, because ingress runs in the same
FIFO queue. What did happen was a **silent drop**. The concurrent benchmark
(`STARTUP_HEALTHY_GRID_POOL_LULL=concurrent`) on the base build fails at epoch 4
with `healthy exact digest not live-admitted/projected before seal`: the creator
never admitted a recipient's move that arrived during P2. A move parked in
P1/P3 stayed parked until some later move triggered a drain.

## Changes

1. **Queue, do not drop, during a pool boundary** (`v3-live.ts`).
   - New registration flag `readinessMaintenanceEntered`. It is true only while an
     entered *deferrable* (pool) readiness boundary owns the closing gate.
   - `enqueueV3Ingress` drops on `blueprintClosing` only when that flag is not
     set. Under a pool boundary, an arrival is captured into the same bounded
     input pool and waits FIFO behind the boundary task.
   - Real closes, received transitions and the non-deferrable adoption-time
     readiness boundary keep the original drop rule.
2. **Post-boundary capture inside the same queue slot**
   (`runCreatorOrdinaryReadinessMaintenance(..., {after})`, `creator-close.ts`
   pool region).
   - P3 (retirement-control read, early-turnover token, native metadata, cold
     ordinary source capture) now runs after the boundary releases but before
     the slot is released.
   - Without this, a queued arrival ran during P3, was refused by the consumer and
     parked. That changed `pendingIngress` under the capture, and the capture
     failed (`creator recovery dependency hold unavailable:object-issuance-census`,
     measured with the queue fix alone, ma-fix1).
3. **Drain parked arrivals when the job joins**
   (`V3CreatorCloseRegistration.resumePendingIngress`).
   - After `maintainRecoveryPool` and the adoption readiness job remove their
     maintenance job, `drainPendingIngress` is scheduled through the original
     registration queue.
   - That covers moves parked in P1, or moves that start before the job's
     `finally` runs.
4. **Opt-in automatic trigger** (`internal/recovery-pool-auto.ts`, `v3-room.ts`).
   - `createV3RoomSession({recoveryPoolAutoMaintenance: {idleMilliseconds?, maxBackoffMilliseconds?, onResult?}})`.
   - It polls every `idleMilliseconds` (default 1000). It calls the public
     `maintainRecoveryPool()` only after a full idle period with no new
     projection, logical time, plane or redirect, no queued or draining local
     issue, no admitted lifetime transition and no migration barrier.
   - A `busy` result backs off exponentially, capped at `maxBackoffMilliseconds`
     (default 30 s). `maintained`, `not-needed` and `unsupported` settle the
     epoch until the epoch changes.
   - A failure stops the scheduler; the room's own halt and recovery rules apply
     unchanged. The timer is `unref`'d and stopped at close.
   - Seals keep their inline maintenance as the hard-cap backstop.

## Soundness

- **Census unaffected by queued arrivals.**
  - Enqueuing changes only the queue gate, the input-pool counters/bytes and
    `joinedWork`. `captureCreatorRecoveryRuntime` and the boundary's
    `available()` read none of these.
  - The boundary's census, holds and native reconciliation run exactly as before.
- **Same admission semantics.**
  - A queued arrival runs `authenticateV3Ingress` and then `handleV3Ingress` after
    the boundary and P3 finish: decode/re-encode, signature, ACL, latched
    operation, graph and epoch-byte capacity, operation reservation, the
    maintenance consumer, and the durable journal append.
  - Parked arrivals were already authenticated, and are re-admitted by the
    original `drainPendingIngress` through `handleV3Ingress`.
  - No new grant, quote or bypass exists. Refusals keep their original reasons
    and logs.
- **Ordering.**
  - FIFO within the registration queue.
  - Parked moves drain in the original dependency-ready digest order.
  - DAG causality is enforced by the existing dependency checks.
- **Failure.**
  - A boundary that fails after entry sets `operationAdmissionHalted` and leaves
    `blueprintClosing` set; the flag is cleared.
  - Queued arrivals then reach `authenticateV3Ingress`, which drops on
    `blueprintClosing`. This is the original behavior for a halted room. Nothing
    is admitted under a halt.
  - A failed P3 propagates to the caller exactly as before. `ordinaryProofSource`
    is cleared, the early-turnover token is cleared, and the next close resumes
    normally.
- **Deferral.** A pool boundary unavailable at entry returns `deferred` before
  any freeze; `after` never runs. Parked arrivals are drained by the `finally`.
- **Crash.**
  - Queued arrivals are in memory only, like any in-flight gossip. Nothing about
    them is durable before admission.
  - After a crash, retained-history replay or repair re-delivers them, and they
    go through full admission.
  - The boundary's durable effects and the close-time resume rule are unchanged.
    The early-turnover token is process-local and is not captured on failure.
- **Local moves.**
  - `V3RoomSession.issue` already waits on `poolMaintenanceBarrier`. Moves queue
    in order and run right after maintenance with the original checks.
  - None are refused because of maintenance.
- **Bounds.**
  - Arrivals beyond the existing input pools (32 gossip-queue jobs and 32
    registration input jobs, plus byte budgets) are refused with the original
    `admission-rejected` log, as before. A very long maintenance under heavy
    traffic can still drop moves.
  - `requestRetainedRepair()` recovers them.

## Local moves cannot run concurrently with retirement

The boundary's reconciliation binds the live journal and issuance native images
into its census. Its native retirement transactions compare against them. An
ordinary admission appends to the live journal and the issuance outbox, so
admitting one mid-boundary would invalidate the census, and the original rules
would halt the room.

Two other options were not used:
- Running admission between reconciliation passes (sliced maintenance) needs a
  proof that ordinary admission is valid with an active retirement intent or a
  pending generation drain. That proof does not exist in this code, and building
  it means changing retirement/admission code owned by other tracks.
- Preemption before the first durable write needs a yield point inside
  `reconcileSnapshotRecoveryRoles` (rollback-data), also out of scope.

The bounded alternative implemented here:
- moves queue and are admitted right after (worst-case added latency = the
  remaining maintenance time);
- the auto trigger only starts after an idle period;
- inline close maintenance stays as the backstop.

Real concurrency needs one of:
- retirement transactions that do not bind the current-epoch journal image;
- a Worker-hosted retirement against per-epoch stores;
- shrinking maintenance itself (the CPU track).

## Measurements (paired, interleaved, 8 rollovers, 4 clients, ma-base5 = 4c4f192c vs ma-fix4)

The machine was noisy: load averages ranged 22–133, and the parent's agents were running
suites. Compare runs within a pair, not across pairs. Each run's raw output is
`run-ma-p-*.log`, with `report.json` under `run-ma-p-*/`.

| Mode | Run (load) | Pool maint e4–e8 | Seal t4–t7 ms | Adoption t4–t7 ms | Install t4–t7 s | Creator move p50/p95 | Recipient move p50/p95 | Remote accept p50/p95 |
|---|---|---|---|---|---|---|---|---|
| inline only | base (74) | in seal | 2961–3677 | 615–795 | 1.27–1.74 | 103/234 | 44/93 | 79/146 |
| inline only | fix (76) | in seal | 2873–3358 | 647–725 | 1.31–1.62 | 93/260 | 40/71 | 64/146 |
| lull | base-1 (26) | 2.73–3.05 s | 368–394 | 617–945 | 1.19–1.62 | 84/148 | 39/71 | 67/130 |
| lull | fix-1 (23) | 2.68–3.27 s | 392–478 | 657–1075 | 1.16–1.49 | 83/210 | 40/75 | 63/133 |
| lull | base-2 (44) | 3.96–5.33 s | 486–585 | 777–1030 | 1.66–2.09 | 112/509 | 53/104 | 85/210 |
| lull | fix-2 (61) | 3.71–4.66 s | 535–747 | 802–925 | 1.52–2.25 | 111/157 | 55/125 | 81/175 |
| lull+trace | base (74) | 3.04–3.91 s | 435–748 | 763–902 | 1.58–2.29 | 111/169 | 49/73 | 74/166 |
| lull+trace | fix (53) | 3.37–3.84 s | 457–600 | 739–760 | 1.54–1.63 | 102/198 | 47/74 | 72/146 |
| concurrent | base (133) | **FAIL e4**: "healthy exact digest not live-admitted/projected before seal" | | | | | | |
| concurrent | fix-1 (28) | 3.00–4.77 s, pass | 417–524 | 774–1213 | 1.45–2.19 | 98/159 | 47/110 | 70/159 |
| concurrent | fix-2 (47) | 3.62–4.70 s, pass | 449–495 | 765–944 | 1.69–2.06 | 101/259 | 50/82 | 78/153 |
| auto (fix only) | fix-1 (41) | 4.97–6.22 s at idle | 433–515 | 730–918 | 2.03–2.48 | 107/205 | 49/133 | 90/193 |
| auto (fix only) | fix-2 (42) | 4.60–5.78 s at idle | 463–722 | 652–774 | 1.89–2.59 | 118/226 | 47/75 | 85/171 |

An earlier unpaired base concurrent run (ma-base-conc-1) failed the same way at epoch 4.

Move p50/p95 counts only the ordinary moves issued outside maintenance.

Concurrent-mode moves issued during maintenance (fix):
- **Recipient moves** keep their local issue latency (56–127 ms). Every peer receives them at
  maintenance end plus about 0.1–0.2 s, i.e. a wait of up to the remaining maintenance time
  (634–4611 ms after issue).
- **The creator's own move** waits the whole remaining maintenance: 3.06–4.91 s.

**Reading.**
- Lull and inline-only modes are at parity. They have no ingress during maintenance, so the
  fix is not on their path.
- Concurrent play goes from fail (a lost move) to pass.
- Auto removes about 2.5–3 s of inline maintenance from every seal without the game
  calling anything: seal t4–t7 is 433–722 ms vs 2873–3677 ms inline-only.

**Main-thread tasks.**

Chrome `toplevel` trace windows (t4 seal through the e5 lull), base vs fix:

| Window | Max task, base / fix | Tasks over 16 ms, base / fix | Site (V8 samples, same in both) |
|---|---|---|---|
| seal | 26 / 26 ms | 1 / 1 | `stageClosedBlueprintEpoch → foldBlueprintEpoch → encodeCanonical` |
| adoption | 44 / 44 ms | 3 / 2 | `readProspectiveCreatorMaintenancePrefixesForSizing` (`compose…/includeSchedule`); `prepareCreatorOrdinarySourceReadinessForSizing → buildCreatorOrdinaryFinishingResourceProgramForSizing` |
| install | 13 / 11 ms | 0 / 0 | |
| pool maintenance | 40 / 40 ms | 1 / 1 | `prepareCreatorOrdinarySourceReadinessForSizing` (P3 cold capture) |
| per move | ≤11 ms | | earlier full trace, ma-fix3 |

Long Tasks API (over 50 ms):
- 13–19 per run.
- The 607–838 ms maxima fall outside every product window (script load, harness RPC
  accept, forced GC).
- The only product-window long task is creator adoption t2/t3 at 50–56 ms, on both builds.

The ≤16 ms target is not met in the seal, adoption or maintenance windows.
- Every remaining task over 16 ms is one synchronous sizing or canonical-encoding pass.
- They live in `creator-closed-rollback-data.ts` (sizing/admission) and the blueprint fold,
  both outside Track A's scope. A yield at the Track A call sites cannot split them.
- Splitting them needs yield points or verify-once caching inside those passes (the CPU track).
