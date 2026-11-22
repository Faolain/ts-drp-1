# Track M: verified retention decisions on the room path (slices 14b stage 1 and 14e)

- Worktree: `<worktree agent-a6747ca659c74d66c>/`, branch `worktree-agent-a6747ca659c74d66c`. Nothing was pushed.
- Base: `codex/phase3a1b-p6-golden-path` at **5c6b949d** (Track R3 and Track N landed).
- Working notes: `<evidence>/track-m/PLAN.md` and `PROGRESS.md`. Logs: `<evidence>/track-m/logs/` and
  `<evidence>/track-m/tests/`. Grid runs and tables: `<evidence>/track-m/grid/`. Scripts: `<evidence>/track-m/bin/`.
  Maps of the code read for the design: `<evidence>/track-m/maps/`. Sub-studies: `<evidence>/track-m/sub-14f/`
  (native evidence) and `<evidence>/track-m/sub-cc/` (Canvas and Chat).
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
  `CRD` is packages/node/src/internal/creator-closed-rollback-data.ts. Line numbers are at HEAD.

## 1. Outcome in brief

- **What landed, opt-in:** 14b stage 1 and 14e, on R3's room database. Stage 1 is the slice's "allowed
  intermediate" (14b, "Allowed intermediate").
  - The host opts in with `createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })`. In the Grid this is
    `STARTUP_HEALTHY_GRID_ROOM_RETENTION=1` on top of `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1`.
  - On that host, each closed-epoch boundary is retired by verified retention decisions. Each decision is applied as
    one strict room transaction (step B), after a floor fence of its labels (step A). This replaces the four
    per-class passes, each with its own acquisition, two-phase install, `verifyCompleted` readbacks and drains.
  - The decision still starts from one complete cold acquisition per boundary: the existing `acquireClosedData` and
    the existing classifiers. That is 14b's "open verification", run at every boundary instead of only after an open.
  - Every other host, including the default six-database host and R3's room host without the option, runs the
    existing code unchanged.
- **The ledger (stage 2) is not built.** It is designed and mapped (§7), not implemented. Without it, the
  per-boundary cold acquisition remains, and it is now the largest cost.
- **Latency: about 4x faster, but the ≤ 100 ms target is not met.**
  - Creator lull, steady median (3 ABBA pairs, 8 rollovers, room path): 2441 → 623 ms with `LULL=1`, and
    2743 → 715 ms with concurrent moves (0.26 of base in both).
  - Recipient lull: 1253 → 466 ms and 1456 → 588 ms (0.37 and 0.40).
  - Moves issued during a creator lull reach the other peers in 493 ms instead of 1914 ms (p50).
  - Seal, creator adoption and recipient install are unchanged.
  - The creator's retention work per epoch is now about 400 ms (`LULL=1`). About 280 ms of that is the cold
    acquisition; plan, floor fence and step B for the two decisions take about 107 ms. Readiness capture adds
    about 130 ms, unchanged (§6).
  - Stage 2 would remove the acquisition. That leaves about 107 ms on the creator and about 50 ms on a recipient,
    from this track's measurements. Reusing the planned drafts in step B would cut about half of that (§7).
- **Safety.** No decision deletes a row that the existing planner keeps.
  - The differential test compares both on the same pre-state at every lull: a Canvas room for 16 epochs, two
    seeded random histories, and a Grid-application settlement room for 16 epochs that includes Track N's cold
    recipient drain.
  - Every 14b and 14e RED passes. That includes poisoned or rolled-back bytes, a fact whose bytes no longer hash
    to its key, foreign writers, stale writers, reopen, a forged authority across a non-genuine handoff, and
    over-budget or over-cap decisions refused before the first delete.
- **Crash recovery is broken on the opt-in path (14f case 8). This blocks any default flip.**
  - A SIGKILL after a creator boundary's first decision commits, and before its second, leaves signing rows
    (the epoch's signer state and votes) whose seal evidence is gone, with no durable record that their
    retirement is pending.
  - After reopen, the next acquisition cannot classify them (`UNCLASSIFIED_SIGNING_DEPENDENCY`). The creator's
    lull then refuses `internal-invariant` and maintenance stops.
  - Nothing is deleted wrongly, and each transaction is old XOR new. But G3 (crash recovery) and G14 (one
    resumable intent) do not hold on this path (§10). It reproduces on Chromium, Firefox and WebKit.
  - It is recorded and not fixed (the brief's stop rule). Fix options are in §14.
- **Native evidence (14f), at the final code (8a09ceb8):** cases 2, 3 and 5–7 pass on Chromium, Firefox and WebKit,
  and case 11 passes on Chromium. Case 8 is the counterexample above, in all three engines. Cases 1 and 4 are R3's
  session properties (passed in R3's run); case 9 belongs to 14d (§8).
- **Canvas and Chat (§11).** The six native tests give identical results on base and the branch, and the default
  hosts store identical rows and bytes for 16 epochs. Retention cuts the lulls (or, with the shipped apps, the
  seal that carries the creator's retirement) to 0.26–0.41 of the room path in Chromium. Canvas issuance grows by
  one row per move on every path, base included, and Canvas latency grows with it: a pre-existing gap, recorded,
  not fixed.
- **100 epochs (§12).** The room path with retention passed 100 continuous rollovers with every check. Row counts
  are constant from epoch 8 to 100 on every client, and no latency grows with room age. The default host also
  passed 100. R10 is not closed by this.
- `pnpm -r typecheck`: 0 errors at 8a09ceb8 (`logs/typecheck-4.log`). `node scripts/check-shadowed-sources.mjs`:
  clean. Suites: no new failures against base in any set (§9).

## 2. Commits

All are on `worktree-agent-a6747ca659c74d66c`, oldest first. The RED commit precedes the commit that turns it
green.

| Commit      | Kind             | What                                                                                                                                                                                                            |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a301cbe0    | RED              | The 14b and 14e RED tests and their fixtures (trust, bounds, differential, long room).                                                                                                                          |
| 51d007eb    | product          | 14b stage 1 and 14e on the opt-in room path.                                                                                                                                                                    |
| de1d64cc    | test             | The settlement-room differential, including Track N's cold recipient drain.                                                                                                                                     |
| 9514ff21    | measurement only | The Grid allows up to 128 rollovers.                                                                                                                                                                            |
| 55dbf18a    | product fix      | Retention formats move off the pinned `@ts-drp/storage` root; the AHE census uses only the owner's governed IndexedDB calls; two Track M RED files change their import path only.                               |
| 05b5d706    | measurement only | The Grid's delivery and proof-event telemetry scale for runs over 32 rollovers.                                                                                                                                 |
| 8fd92c99    | test             | The 14f native evidence harness.                                                                                                                                                                                |
| da3704ac    | measurement only | The Canvas and Chat long-room harness (skipped unless `TRACK_M_APPS=1`).                                                                                                                                        |
| 8a09ceb8    | product fix      | Existing node tests that run the original text of the resume predicates, the acquisition prefix and the generation comparator pass again: the opt-in code moves out of that text, with the same behaviour (§9). |
| (this file) | docs             | This result.                                                                                                                                                                                                    |

## 3. Design as built

### 3.1 Where it runs

- `reconcileSnapshotRecoveryRoles` (CRD) is the existing entry for every boundary: seal-inline, the creator's lull,
  recipient turnover, and the recipient lull. On an opted-in room host it now takes the retention path once per
  boundary (CRD, `applyRoomRetentionPass` and the branch that builds `RoomRetentionPassPlan`).
- It keeps the existing path for the whole boundary when any of these holds (`roomRetentionDeclineReason`, CRD):
  - an owner control does not exist yet (`ahe-birth`, `snapshot-birth`, `journal-birth`, `issuance-birth`);
  - work of the existing path is in flight: an active control, a pending drain or summary, or a pending floor
    (`*-active`, `*-drain`, `signing-summary`, `floor-active`);
  - the existing path already retired this closed epoch, and its own resume owns the rest (`*-same-epoch`);
  - `requireClosedWorkflowCompletion`, legacy snapshot scopes, or a retention refusal in the previous pass (the
    next pass then runs the existing path from a fresh acquisition).
- In a healthy room, each role's first retention-capable lull declines with `ahe-birth` and runs the existing path.
  From the next boundary on, the retention path runs. In the 8-rollover Grid that is t5 onward on the creator.

### 3.2 The decision

- One cold acquisition per boundary: the existing `acquireClosedData` with its currency checks, protected union,
  role observation and journal classification. Nothing is carried between boundaries or across an open.
- Each owner's existing rule selects from that acquisition:
  - snapshot role turnover;
  - journal prefixes and empty headers;
  - signing evidence;
  - AHE generations, one at a time: each unit is the existing classifier's own selection
    (`classifyClosedGenerationSource`) on the post-image of the previous unit, up to the count the existing pass
    loop would reach (`roomRetentionGenerationUnits`);
  - issuance protected holes.
- Two decisions per creator boundary, ordered by 14b's real dependencies:
  - **D1:** snapshot turnover, journal, signing evidence, AHE and issuance.
  - **D2:** signing summaries, only for epochs whose evidence D1 retired (14b: "summaries only for epochs whose
    evidence retirement completed earlier").
  - A recipient needs only D1.
- Dropped scheduling policies, as 14b allows: one class per pass, one generation per pass, 16-row batches, and
  prefix suppression. The rules are not dropped.

### 3.3 Step A and step B

- Per decision, in one held strict room transaction (R3's session):
  1. `planRetention`: every owner section reads, charges and digests the exact rows it would delete or rewrite,
     and its control. This gives the decision record and its digest. Nothing is written.
  2. **Step A:** the floor fences the decision's labels (`throughEpoch`, `decisionDigest`, `sourceProofDigest`)
     with prepare and commit in **one** floor transaction (`fenceDecision`, new in storage-browser and
     storage-node `room-head.ts`). No crash leaves the floor's control active. A floor without `fenceDecision`
     keeps the existing path.
  3. **Step B:** `applyRetention` re-plans the same selection in the same transaction. It requires the planned
     digest, which covers every control base, every deleted row's exact bytes, every rewrite and the owners'
     censuses. It charges every byte into a fresh proof book, checks the write cap, and only then writes the
     deletes, the rewrites and each owner's target control.
  4. `checkpoint()` commits the transaction whole. The next decision starts a new one.
- A mismatch refuses `RETENTION_STALE` with zero writes, and the transaction aborts whole. The next pass runs the
  existing path from a fresh acquisition. Nothing is repaired.
- Survivors that the decision relies on are compared exactly: the AHE head and its two rollbacks, the protected
  snapshot scopes, journal headers, rewritten journal headers and the prefix header's frame digest.
- The snapshot turnover still holds the existing exclusive dependency claim (`acquireRecoveryRetirementExclusion`)
  through step B. It consumes the existing turnover authority once.
- The AHE section completes a kind-3 control without `domains` or a generation drain. On reopen, the original
  rules treat only a completion with `domains` as a completed-boundary request, so a reopened room halted on
  "creator readiness maintenance boundary is unavailable". v3-live.ts now decides once, at activation and only on
  an opted-in room host, whether such a control (with its addressed turnover receipt) is a retention-completed
  boundary (`roomRetentionCompletedBoundary`). If so, it halts exactly like the original checkpoint and records
  the control's identity (`roomRetentionResumeControl`). That marker only lets the original reconstruction
  discharge the same request; the original predicates are otherwise unchanged (§9).

### 3.4 Bounds and charges (14e)

- `ROOM_RETENTION_LIMITS` (packages/storage/src/room-retention.ts): 512 writes (deletes plus rewrites) per
  transaction, the new policy proposed by 14e and pending review. Charged reads are limited to
  `maintenanceProofBytes` (4,194,304).
- The planner splits a decision over the cap into continuations of whole units. Each continuation is a complete
  decision with its own step A and step B. A single unit over the cap retains and the existing path runs.
- Census reads are bounded before they are issued. The AHE census reads `getAll(undefined, bound + 1)` over the
  whole store and refuses `RETENTION_CAPACITY` when there are more rows than the bound or any row belongs to
  another object (a room database holds one object). It uses only the IndexedDB calls the AHE owner is allowed
  (the IDB ownership checker); a first version used `IDBKeyRange.bound` and `count()`, which the governance tests
  rejected.
- Every byte read in step B is charged before the first write, and nothing is refunded.
- Steady state on the Grid: 45–52 writes per creator boundary, summed over its two decisions, and 17–38 per
  recipient boundary (one decision). One continuation per decision; the cap is never reached.
- The retention formats are exported from `@ts-drp/storage/room-head`, not from the package root, whose runtime
  keys are pinned (adapter-facade-red). storage-browser composes the AHE section in `maintenance.ts`, so its
  root declarations never name a retention type (the pack tests use a stub `@ts-drp/storage`).

### 3.5 What did not change

- The default host and R3's room host without the option.
- Owner rules, arrival verifiers, protocol formats, signatures and digests, every existing limit, and
  `cleanupCreatorSettlementSuccessor` (Track N's function).
- No existing RED or governance test, frozen artifact, registry or vector was edited. Two of this track's own RED
  files changed their import path only (55dbf18a). One existing test fixture,
  tests/fixtures/phase-3a1b/grid-room-head-authority.ts, passes the floor's new `fenceDecision` through its RPC.
- docs/realtime-latency/README.md was not edited (the coordinator maintains it).

## 4. Requirements and tests

New test files only. "Base" is 5c6b949d with the test files copied in (`<evidence>/track-m/logs/red-base-1.log`).
"HEAD" is the branch.

| Requirement                                                                             | Test (file `tests/track-m-room-retention-*.test.ts`)                                                                                                                                                                                        | Base                        | HEAD                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14b RED 1: poisoned bytes refuse `RETENTION_STALE`, zero writes                         | trust: a deleted signing evidence row, journal row, snapshot chunk; a protected journal header (creator and recipient); a surviving AHE generation; each of the five owner controls; a prefix header's closed-membership carrier (12 tests) | fail (path absent)          | pass                                                                                                                                                                                                                              |
| 14b RED 1: a tampered mark claiming more retirement than the floor fails closed at open | trust RED 4, "a tampered mark…"                                                                                                                                                                                                             | pass (fails closed on both) | pass                                                                                                                                                                                                                              |
| 14b RED 2: foreign writer between decision and step B                                   | trust: append to a retired range; adoption (new generation); control rolled back to the one before the previous decision; a writer during step B is serialised after the commit (4 tests)                                                   | fail                        | pass                                                                                                                                                                                                                              |
| 14b RED 3: stale writers refuse after step B                                            | trust RED 3: the same existing codes as after the existing path (`SIGNING_RETIRED`, `retirement-fenced`, `stale-scope`, `RETIREMENT_FENCED`), and both paths retire the identical rows                                                      | fail                        | pass                                                                                                                                                                                                                              |
| 14b RED 4: reopen runs the open verification first                                      | trust RED 4: no fact the first decision after a reopen acts on predates the open; a poisoned retained row found there fails closed                                                                                                          | fail / pass                 | pass                                                                                                                                                                                                                              |
| 14b adversarial: a fact crossing a non-genuine handoff                                  | trust: a forged snapshot turnover authority refuses, zero writes                                                                                                                                                                            | fail                        | pass                                                                                                                                                                                                                              |
| 14b RED 5: differential, ≥ 16 epochs, creator and recipient                             | differential: Canvas room, 16 epochs; seeded random histories 1 and 2. settlement: Grid application, settlement profile, 16 epochs (plan-only subset; applied issuance rows)                                                                | fail                        | pass                                                                                                                                                                                                                              |
| 14b RED 6: long-room bounds on the new path                                             | long-room: creator and recipient, 16 retention lulls                                                                                                                                                                                        | fail                        | pass                                                                                                                                                                                                                              |
| 14b RED 6: the SQLite journal long-room test stays green                                | tests/recipient-long-room-journal-retention-native.test.ts (unchanged)                                                                                                                                                                      | pass                        | pass (2/2, root set, §9)                                                                                                                                                                                                          |
| 14b RED 7: Grid acceptance                                                              | Grid, room path with retention: 8 rollovers (6 bench runs), 16 rollovers, 100 rollovers (§12)                                                                                                                                               | n/a                         | pass: 6 bench runs (51d007eb), 16 rollovers `LULL=1`, 100 rollovers concurrent (`run-endure3`, after the governance fix), 16 rollovers `LULL=1` at 8a09ceb8; every recipient lull, persisted close, reopen and continued gameplay |
| 14e RED 1: 513 deletes refuse `RETENTION_CAPACITY`; planner splits                      | bounds (3 tests, incl. a single unit over the cap retains)                                                                                                                                                                                  | fail                        | pass                                                                                                                                                                                                                              |
| 14e RED 2: reads over budget refuse `RETENTION_BUDGET`                                  | bounds (2 tests, incl. the lull retains on a lowered budget)                                                                                                                                                                                | fail                        | pass                                                                                                                                                                                                                              |
| 14e RED 3: charges precede the first delete, never refunded                             | bounds: proof-book trace                                                                                                                                                                                                                    | fail                        | pass                                                                                                                                                                                                                              |
| 14e RED 4: over-bound census refuses without materialising more than bound + 1 rows     | bounds: over-bound AHE census                                                                                                                                                                                                               | fail                        | pass                                                                                                                                                                                                                              |
| 14e RED 5: over-bound legacy database refuses migration                                 | not run: migration is slice 14d, out of scope                                                                                                                                                                                               | —                           | —                                                                                                                                                                                                                                 |

The brief's adversarial cases, in stage 1 terms (there is no ledger yet, so a "fact" is what the boundary's
verification established and the decision names by key and digest):

- poisoned or rolled-back durable bytes after the fact was established: RED 1 (12 tests) and RED 2 (a control
  rolled back to the one before the previous decision);
- a fact whose stored bytes no longer hash to its key: RED 1, "a deleted signing evidence row whose bytes no longer
  hash to its verified fact" (and the same check for every named row);
- a session reopened with no carried facts: RED 4 (the first decision after a reopen acts only on facts verified
  after the open; a poisoned retained row found there fails closed);
- a fact crossing a non-genuine handoff: the forged snapshot turnover authority test;
- over-budget charges refuse before the first delete: 14e RED 2 and RED 3.

Logs: trust `<evidence>/track-m/logs/trust-4.log` (21/21), bounds and differential `bounds-3.log` (10/10),
long-room `long-6.log` (1/1), settlement `settle-2.log` (2/2). On base 30 of 32 fail. The two that pass on base
are fail-closed reopen cases, which already fail closed on the existing path.

After the governance fix (55dbf18a), all five files were run again: 34 of 34 pass (`logs/trackm-final-1.log`,
33 of 34; the forged-handoff case failed only on its own stale dynamic import path, fixed in the same commit and
passing in `logs/trackm-final-2.log`). At the final code (8a09ceb8) the five files, Track N's issuance test and the
SQLite journal long-room test pass 38 of 38 (`logs/trackm-pins-2.log`).

How the trust tests observe step B: the fixture hosts are real room hosts on fake-indexeddb. Hooks fire between
the decision and step B, or inside the held transaction, to poison, roll back or append. Every refusal is checked
for zero writes by dumping the whole room database before and after.

## 5. Differential safety

Stop condition: deleting something the existing planner keeps. It never happened.

- **Method (plan-only probe).** At each lull the retention path plans its first decision from the same
  acquisition, in a room transaction that is then discarded (`planRoomRetentionBesideExistingPass`, CRD). Then the
  existing path runs its whole lull. The test compares the rows the decision names with the rows the existing lull
  deleted, from database dumps before and after.
- **Canvas room, 16 epochs, creator and recipient** (`tests/track-m-room-retention-differential.test.ts`): subset at
  every lull. The only gap is retention keeping more: the recipient's journal header lags one lull.
- **Seeded random histories 1 and 2:** each lull runs the existing or the retention path at random. At every
  existing lull, the probe on the same pre-state is a subset.
- **Settlement room, 16 epochs** (`tests/track-m-room-retention-settlement.test.ts`, coordinator's request). It uses
  the Grid application (`createV3ZoneApplication`), `creator-trusted-settlement-v1`, Ed25519, and a Writer
  recipient on the room host, so it covers Track N's cold recipient drain:
  - Plan-only, 32 lulls: the subset holds at every lull and the issuance protected holes equal the existing path's.
    The recipient's gap is one journal header from epoch 7 on (the one-lull lag).
  - Applied, one room per path, same name: at every epoch both peers' issuance rows (`issuedRecords`, `issuanceOutbox`)
    are identical on both paths. Both peers hold 26 rows (13 issued, 13 outbox) from epoch 6 to epoch 16. Total rows:
    creator 131 on both; recipient 124 (existing) and 125 (retention, the extra journal header) from epoch 7,
    constant.
- Track N's test (`tests/recipient-long-room-issuance-retention-native.test.ts`) passes on the branch, 2/2
  (`logs/trackn-1.log`).
- All of the above pass again at 8a09ceb8 (`logs/trackm-pins-2.log`), where each later AHE unit is chosen by the
  existing classifier itself on the previous unit's post-image.
- The retention path decides issuance retirement only through the issuance owner's protected holes. The cold
  recipient drain itself still runs in `cleanupCreatorSettlementSuccessor`, unchanged. It keys on the completed AHE
  and issuance decisions agreeing, and they agree on this path: both carry the same labels from step A.
- **What the differential does not check:** the owner controls' contents, and the durable states between a
  boundary's decisions. It compares deleted rows only. Case 8 (§8) is exactly such a gap: every row D1 deletes
  is one the existing planner deletes, but the signing control D1 leaves is not one the existing machinery can
  resume from.

## 6. Benchmark against base

**Setup.**

- Healthy native Grid, Chromium, 8 rollovers. Three interleaved ABBA pairs per mode: `LULL=1`, and concurrent
  moves during the lulls (`LULL=concurrent`). That is 12 runs, and all passed: continued gameplay at epoch 8,
  `proofEventsTruncated === false`.
- Base: 5c6b949d on the room path (`STARTUP_HEALTHY_GRID_ROOM_DATABASE=1`). HEAD: the same plus
  `STARTUP_HEALTHY_GRID_ROOM_RETENTION=1`, built from 51d007eb. Each variant has its own bundle, built from its
  own tree (`bin/gridbuild.sh`).
- Order within pairs: base first in pairs 1 and 3, HEAD first in pair 2. Load average 10–33 during the runs.
- Raw data: `<evidence>/track-m/grid/run-m1-*`. Table: `<evidence>/track-m/grid/bench-m1-table.txt` (`bin/bench.sh`,
  `bin/bench_table.py`, `bin/grid_summary.py`).

**Per-transition latency.** Each figure is the median, over the steady transitions, of the per-transition median
over 3 runs, in ms. Steady is t3–t7 for seal, adoption and install, and t4–t8 for the lulls. Install and recipient
lull take the max over the three recipients.

| Window            | `LULL=1` base | `LULL=1` HEAD | HEAD/base | concurrent base | concurrent HEAD | HEAD/base |
| ----------------- | ------------- | ------------- | --------- | --------------- | --------------- | --------- |
| Seal              | 276           | 278           | 1.01      | 317             | 300             | 0.95      |
| Creator adoption  | 506           | 503           | 0.99      | 596             | 589             | 0.99      |
| Recipient install | 343           | 347           | 1.01      | 447             | 428             | 0.96      |
| Creator lull      | 2441          | **623**       | **0.26**  | 2743            | **715**         | **0.26**  |
| Recipient lull    | 1253          | **466**       | **0.37**  | 1456            | **588**         | **0.40**  |

- t4 is the same on both: each role's first retention-capable lull declines `ahe-birth` and runs the existing
  path. That is creator 2111 and 2074 ms (`LULL=1`). From t5 the creator lull is 612–625 ms (`LULL=1`) and
  696–736 ms (concurrent), at every transition, against 2249–2995 ms on base.
- The recipient lull drops at t4 already: the recipients' births land at t3.
- Base committed 54 closed-retirement room sessions per run. HEAD committed 11: the existing-path passes at the
  births. Every other boundary was one retention pass.

**Per-move latency during lulls** (concurrent mode, epochs 4 and later, ms). Issue is the issuing call. Without the
presentation overlay that is the local durable commit and the durable publication. Remote accept is the latest
durable live admission over the other peers. Per-move receipt stages are not recorded in this mode.

| Moves issued during | n per variant | Issue p50 base → HEAD | Issue max   | Remote accept p50 | Remote accept max |
| ------------------- | ------------- | --------------------- | ----------- | ----------------- | ----------------- |
| Creator lull        | 60            | 66 → 59               | 3206 → 2848 | 1914 → **493**    | 3131 → 2758       |
| Recipient lull      | 30            | 102 → 122             | 165 → 549   | 970 → **329**     | 1781 → **517**    |

- Moves queue FIFO behind the lull (G23), so remote acceptance follows the lull's length. The creator-lull maxima
  are at t4, where both variants run the existing path.
- Recipient-lull issue: p50 +20 ms, p90 139 → 145 ms, and one outlier of 549 ms (run 1, t4). These moves come from
  peers that are not running the lull, but all four clients share one renderer. Thirty samples per variant cannot
  separate this from load. It should be re-measured before the default flip.

**Longest main-thread task per window** (task trace, toplevel `RunTask` on the renderer main thread, ms, median and
max over windows the trace covers):

| Window            | `LULL=1` base | `LULL=1` HEAD | concurrent base | concurrent HEAD |
| ----------------- | ------------- | ------------- | --------------- | --------------- |
| Seal              | 14.4 / 22.7   | 14.6 / 22.6   | 17.1 / 22.8     | 17.4 / 24.8     |
| Creator adoption  | 23.9 / 32.2   | 27.1 / 32.6   | 22.4 / 36.4     | 31.9 / 39.6     |
| Recipient install | 6.5 / 9.1     | 7.3 / 9.5     | 6.3 / 9.7       | 7.8 / 11.3      |
| Creator lull      | 8.1 / 21.4    | 16.7 / 24.0   | 0.3 / 21.5      | 14.9 / 24.6     |
| Recipient lull    | 9.3 / 12.3    | 9.6 / 13.4    | 4.3 / 11.9      | 8.3 / 11.2      |

- No window gains a long task. The maxima are within 3 ms of base.
- The lull medians are not comparable. The task trace buffer ends before the last windows, and base's longer lulls
  are covered less, so some base windows count as 0 (the 0.3 ms median). Which task is the 24 ms one in HEAD's
  lulls was not attributed.

### 6.1 Where the time goes now

Retention pass per boundary, from the `room-retention-pass` proof events of the 6 HEAD runs
(`<evidence>/track-m/grid/passes-m1.txt`), p50 in ms:

| Role and mode                              | Pass total | Cold acquisition | Plan | Floor fence | Step B | Writes |
| ------------------------------------------ | ---------- | ---------------- | ---- | ----------- | ------ | ------ |
| Creator, `LULL=1` (n=12, 2 decisions each) | 400        | 282              | 53   | 5           | 49     | 46     |
| Creator, concurrent (n=12)                 | 462        | 355              | 45   | 5           | 53     | 52     |
| Recipient, `LULL=1` (n=45, 1 decision)     | 384        | 328              | 21   | 3           | 25     | 31     |
| Recipient, concurrent (n=45)               | 430        | 362              | 24   | 3           | 30     | 37     |

- Of a creator lull of about 620 ms: about 400 ms is the retention pass, about 133 ms the readiness proof capture,
  about 13 ms the dependency hold, and about 75 ms other boundary work before and after.
- Inside the cold acquisition (diagnostic marks build, `<evidence>/track-m/grid/run-marks-mine-1`,
  `bin/marks.py`): on the creator, `acquireClosedData` is about 160 ms. Then come journal classification (about
  36 ms), images and scopes (about 32 ms), currency checks (lifetime, union, source and the second checks, about
  75 ms) and the plan build (about 13 ms).
- A CPU profile (`run-prof-mine2-1`, `bin/retprof.py`) shows the main thread about 77% idle in both the acquisition
  and plan-plus-apply windows. The time goes to IndexedDB round trips, not to CPU.

### 6.2 Readiness capture

- `captureCreatorOrdinarySourceWithoutForecast` (creator-close.ts:2459) runs after maintenance in the lull. It is
  another cold authenticated read lifetime (`acquireCreatorIssuanceMaintenanceProof`), separate from retirement.
- Measured as the `creator-maintenance-proof-capture-inclusive` span inside the creator lull (`bin/readiness.py`,
  `LULL=1`, steady t4–t8): base p50 129 ms (112–151), HEAD p50 134 ms (111–225). The dependency hold is 13 ms on
  both.
- 14b stage 1 does not change it. Its share of the creator lull rises from about 5% to about 21%.
- Whether 14b lets it shrink: not with stage 1. A ledger could hand it the immutable verified source facts. But
  its currency reads and its operation-local charges must stay fresh (G10, G11, G22), and showing that the capture
  is equal on ledger facts would be its own differential. This track did not attempt it. After stage 2 the capture
  would be the largest single part of the creator lull.

## 7. Stage 2: what it would take

Stage 2 is the ledger: the facts the boundary's decision acts on are verified once, on arrival or at open, and
carried in memory. The cold acquisition at every boundary goes away. It is designed and its hooks are mapped
(`<evidence>/track-m/maps/arrival-ledger.md`, line numbers at 5c6b949d). It is not implemented.

**Where the ledger lives.**

- On the per-plane `V3PlaneRegistration` (v3-live.ts, beside `vertexFacts`). It is forked only in
  `activateV3LivePlane`'s `reusesTransport` branch, which runs only for a genuine creator or received handoff
  (`creatorSuccessorTransportHandoff`: the same store, journal, issuance store, message queue, scope, latched ACL
  and trust). It is released wherever `vertexFacts` is released.
- It reaches CRD through a new optional `captureRetentionLedger?()` on `CreatorSnapshotRecoveryCloseLifetime`,
  implemented in `resolveRecoveryCloseHold` the same way as `captureVertexVerificationFacts`. Both the creator's
  and the recipient's lull holds carry the registration, so both roles reach the same per-plane ledger.
- It must not be keyed on the AHE store object. `recoverSettlementOwner` (v3-room.ts) reuses the same stores with
  a cold plane, so a store-keyed ledger would cross a non-genuine recovery (14b's "fact crossing a non-genuine
  handoff").
- Absent ledger (reopen, startup pending classification, archive restore, in-session recovery): the cold
  `acquireClosedData` path, as today. That is 14b's open verification.

**Where facts are recorded.**

| Fact (14b ledger)                                                                    | Creator                                                                                                                                    | Recipient                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Closed epoch: Cut, commit QC, successor trust, roles and classified scopes, transfer | creator-close.ts, just before `return result` (after `installCreatorAdoptionFacts`), through a new close-registration method               | creator-adoption.ts, after the `retainForRecovery` check and before `installCreatorAdoptionFacts`        |
| Journal scope: membership set and local witnesses                                    | the same creator hook (not at `recordClosedMembership`, where no QC exists yet)                                                            | inside `recordCreatorReceivedClosedMembership`, only after `recorded.ok` (its caller ignores the result) |
| AHE generations: identity and authenticated-as-historical                            | L*e and Q_e at the creator hook; L*{e+1} needs `authenticatedTerminal` (creator-adoption-commit.ts) widened to return the verified lineage | `candidate` (L\_{e+1}) at install                                                                        |
| Snapshot scope: manifest digest                                                      | `persistedSnapshot` at close                                                                                                               | `manifest` after `verifySnapshot`                                                                        |
| Issuance record: preimage digest                                                     | the existing `vertexFacts` retain path (not inherited by receive-only successors, so the ledger fork cannot ride on it)                    | the same                                                                                                 |
| Signing epoch: QCs that rebuild the evidence                                         | `finalized` QCs, signing identity, incarnation and Cut at the creator hook                                                                 | not applicable                                                                                           |

**What the boundary would still read.** Currency is never carried (G10, G11). The decision's transaction still
reads the owner controls, the exact bytes of each row it deletes or rewrites, the survivors it relies on, and
each retired range's census, and pays for all of them (G22). That is what step B already does. The planner's
own reads would move into the same held transaction, so step B's re-plan could reuse them instead of reading
twice.

**Estimate, from this track's measurements** (creator, `LULL=1`, p50 per boundary):

- today: about 282 ms acquisition + 53 plan + 5 floor fence + 49 step B ≈ 400 ms;
- with the ledger: about 107 ms (plan, fence and step B; no acquisition);
- with the ledger and one read pass (plan and step B in the same held transaction share reads): about 55–60 ms;
- recipient: about 50 ms with the ledger, about 30 ms with one read pass.

The creator lull would still include readiness capture (about 130 ms, §6.2), so the lull itself would land near
200 ms, not ≤ 100 ms, unless readiness capture also moves onto ledger facts. The target "creator lull maintenance
≤ 100 ms" is met for retirement alone only with the one-read-pass variant.

**Before stage 2 is built**, the case-8 counterexample (§8, §13) has to be fixed: the ledger changes where facts
come from, not which durable states a crash can leave.

## 8. Native evidence (14f)

**Harness.** `tests/fixtures/track-m/native/` (commit 8fd92c99), run with
`playwright test --config tests/fixtures/track-m/native/playwright.config.ts --project <engine>`
(wrapper `<evidence>/track-m/sub-14f/pw.sh`). It follows the death harness pattern of
`packages/storage-browser/tests/phase-3a1b-p4-browser-live-journal-death-red.pw.ts`:

- a detached Node child launches a persistent context per case;
- the worker blocks with `Atomics.wait` at an instrumented edge of the session the node opens (`trap.ts`: before
  the first plan, after each plan, between step A and step B, after `applyRetention`, after each checkpoint);
- the parent SIGKILLs the child's whole process group (plus the profile's lock holders), checks that no killed
  process survives, and a fresh child reopens the profile in recover mode.

The hooks observe, block or throw; they never change what the node decides or writes. Creator and recipient run
in separate origins (the product's per-origin Web Lock serialises adoption and install), with RPC relayed through
the Node child. The global setup bundles the browser side from source on every run and records HEAD, dirty state
and a digest of every bundled source file.

**Assertions.**

- Case 2 (atomicity): a retention transaction trapped at its last request leaves every room store
  byte-identical; the pass reports `retained`, the same lull falls back to the existing path, and the next
  boundary's passes all apply. A variant aborts natively instead (see the observation below).
- Case 3 (serialisation): a strict read-write transaction from a second connection in another worker is ordered
  after the retention commit. After it, the signing evidence put, journal `appendAccepted`, snapshot `openScope`
  and AHE `beginGeneration` each refuse with their existing code.
- Cases 5–8 (process death): the room database and the floor database are each old XOR exact new, with no other
  row changed. The planned decision matches the checkpointed digests exactly. Floor fences and marks lead or
  match, never lag (14c). After reopen and two more rollovers with both lulls, per-store row counts equal a
  crash-free reference run at every epoch.
- Case 11 (Chromium, optional): 16 epochs on the retention path; the long-room bounds hold (no finding).

**Results.** Engines: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5.

Runs at the final product code: HEAD 8a09ceb8, bundled-source digest `e61ac279…`, one run per engine
(`<evidence>/track-m/sub-14f/runs/commit2-{cr,ff,wk}-01/`, case 11 in `commit2-cr-long-01` with
`TRACK_M_14F_LONG=1`; table by `bin/commit2_table.py`). The tree was dirty only with untracked files outside the
bundle (this result and the bench inputs). Durations in seconds.

| Case                                               | Chromium              | Firefox               | WebKit                |
| -------------------------------------------------- | --------------------- | --------------------- | --------------------- |
| Smoke (steady lulls apply on native IndexedDB)     | pass 11               | pass 27               | pass 21               |
| 2, refusal at the last request                     | pass 14               | pass 29               | pass 25               |
| 2, native abort (extra variant)                    | pass 13               | pass 24               | pass 19               |
| 3, serialisation and stale owner writers           | pass 25               | pass 44               | pass 35               |
| Crash-free reference for 5–8                       | pass 18               | pass 34               | pass 29               |
| 5, SIGKILL inside step A                           | pass 17               | pass 32               | pass 31               |
| 6, SIGKILL after A, before B                       | pass 16               | pass 30               | pass 29               |
| 7, SIGKILL inside step B                           | pass 16               | pass 30               | pass 28               |
| **8, SIGKILL after B, before the caller observes** | **counterexample** 15 | **counterexample** 27 | **counterexample** 28 |
| 11, long room, 16 epochs (Chromium only, optional) | pass 39               | not run               | not run               |

Every case 8 failure has the same inner cause, `UNCLASSIFIED_SIGNING_DEPENDENCY:3`. Two earlier sets gave the
same verdicts in all three engines: the runs at 8fd92c99 (`commit-{cr,ff,wk}-01`, digest `5cc5be7a…`, before
8a09ceb8 moved the opt-in code) and the subagent's runs at 9514ff21 (`final-*`, `final-case2-*`).

- Cases 1 (strict durability) and 4 (version fencing) are properties of R3's room retirement session, which the
  retention transaction uses unchanged. They passed on all three engines in R3's run (6c18b0c2) and were not
  re-run here.
- Case 9 (migration) belongs to 14d and is OPEN.
- Case 10 (the healthy Grid with the new path) passed on Chromium: the 6 benchmark runs, the 16-rollover runs and
  the 100-rollover run (§6, §12), and a 16-rollover `LULL=1` run at 8a09ceb8 (`grid/run-fix-room-ret-l1-16`:
  every retention pass applied, creator lull 577–625 ms from t5, issuance 13 rows per client from epoch 6 through
  reopen).

**Case 8, the counterexample** (the same in all three engines; 15 reproductions: 9 during development, 3 at
8fd92c99 and 3 at 8a09ceb8):

- What committed: continuation 0 (D1). It retired epoch 3's seal evidence and moved the signing control from
  `throughEpoch 4, protectedEpochs [3, 4]` (revision 16) to `throughEpoch 5, protectedEpochs [4, 5]` (revision 18),
  with no drain and no summary source. Epoch 3's signer state and votes were left for continuation 1 (D2), which
  never ran. Old XOR new holds: the room database is exactly "new" for continuation 0, and the floor fence is
  exactly "new".
- After reopen and one boundary: signer state 3 rows against 2 in the reference, vote outbox 6 against 4, vote
  slots 6 against 4.
- At the second boundary (rollover 7, creator lull) the retention pass applies, and then readiness capture
  (`captureCreatorOrdinarySourceWithoutForecast`, creator-close.ts:2459, through
  `acquireCreatorIssuanceMaintenanceProof`, CRD:6897) refuses `internal-invariant`. The inner cause, from the
  product's own `closed-data-acquisition-refused` event, is `TypeError: UNCLASSIFIED_SIGNING_DEPENDENCY:3` in
  `acquireSigningDependencies` (packages/seal/src/creator.ts:775): epoch 3's signer rows exist, but no
  authenticated material for epoch 3 does. Admission is then blocked.
- Evidence: `<evidence>/track-m/sub-14f/counterexamples/case8-after-b/` (`death-cr-01`, `death-cr-02`,
  `death8-cr-01` to `03`, `death-wk-01`, `death-ff-01`) and `<engine>-death-after-b.json` in every run directory.
  Each JSON has `assertion.convergenceByRollover`, `recovery.laws` (with the inner error and stack) and
  `recovery.failedObserved`.

**Observation (not a failure).** In the native-abort variant of case 2, the creator's live plane fails closed for
the rest of the session: the next lull returns busy and issue refuses `not-active`. It converges only after the
creator is closed and reopened. The spec's case 2 (a refusal) converges in the same session.

**Harness limitations.** WebKit's WebContent processes are not signalled directly; they exit when their connection
dies, and the networking process is killed through `lsof`. Persistent-profile children report no browser version,
so the version comes from Playwright's browser fixture.

## 9. Suites against base

Recipe (Track N's): vitest from the repository root with `--exclude ".claude/**" --no-coverage` and a JSON report
per set (`<evidence>/track-m/bin/suite.sh`), compared per test with `<evidence>/track-n/bin/vcompare.py`. All
workspace dists were rebuilt first (`logs/pkgbuild-1.log`, then node again after 8a09ceb8). "Base" is Track N's
final report for each set (its product code is that of 5c6b949d, which adds only docs), except sb, which was run
fresh on the 5c6b949d export. A "new failure" is a test that fails on the branch and did not fail on base.

| Set                                        | Base passed / failed | Branch passed / failed | New failures                                                                                                       | Branch report                          |
| ------------------------------------------ | -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| node (packages/node)                       | 1023 / 48            | 1023 / 48              | 0                                                                                                                  | `tests/head4-node.json` (8a09ceb8)     |
| root (Track N's root set, 188 suites)      | 669 / 345            | 678 / 336              | 0 (9 pass that failed on base, all in `d110c-0c1f5b0a-settlement-codec-red.test.ts`, which Track M does not touch) | `tests/head4-root.json` (8a09ceb8)     |
| sb (storage-browser and storage)           | 621 / 4              | 621 / 4                | 0                                                                                                                  | `tests/head2-sb.json` (55dbf18a code)  |
| snr (six storage-node retirement files)    | 158 / 49             | 158 / 49               | 0                                                                                                                  | `tests/head3-snr.json` (da3704ac)      |
| obs (startup observation files)            | 23 / 0               | 23 / 0                 | 0                                                                                                                  | `tests/head2-obs.json` (55dbf18a code) |
| The six Canvas and Chat native tests (§11) | 35 / 15              | 35 / 15                | 0                                                                                                                  | `sub-cc/` (55dbf18a code)              |

- sb, snr and obs exercise only storage packages, which 8a09ceb8 does not touch.
- The failures on base are pre-existing and identical per test: for example the node files that fail to load
  (`creator-ordinary-generation-closure-capacity`, `proptest/spawn-scaling`) and the sb environment failures.
- **An interim run found 14 new node failures, now fixed without editing any test.** At da3704ac, two node files
  failed 14 tests that pass on base: 3 in `creator-closed-rollback-proof-accounting.test.ts` and 11 in
  `creator-ordinary-readiness-producer.test.ts` (`tests/head3-node.json`). These tests take the source text of
  original functions and run it with fixed bindings, or count call sites. Stage 1 had put new identifiers
  (`v3RoomRetentionOpener`, a v3-live helper) and edited conditions into that text, and had added a third
  `compareClosedGenerationSources` call. 8a09ceb8 moves the opt-in code out of that text with the same
  behaviour:
  - the activation checkpoint is restored byte for byte, and the opt-in rule is decided in a separate statement
    that sets the `roomRetentionResumeControl` marker (§3.3);
  - the retention lookup runs after the acquisition prefix instead of before it;
  - the retention path's readback bracket is a separate branch, and the original branch is unchanged;
  - each later AHE unit now comes from the existing classifier on the previous unit's post-image, instead of a new
    comparator call site.
- After 8a09ceb8 the node set has 0 new failures, the Track M and Track N tests pass 38 of 38, and the 14f verdicts
  and the 16-rollover Grid run are unchanged (§8).
- Not run as suites: the Playwright Grid (run as acceptance, §6 and §12) and the 14f harness (§8).

## 10. Guarantees G1–G28

Scope: the opt-in room path with `roomRetention: true`. The default host and R3's room host without the option
run unchanged code, so every guarantee holds there exactly as on base.

| Id  | Guarantee (short)                                                        | Status on the opt-in path                           | How                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Hot state does not grow with room age                                    | Held to 100 epochs on the Grid; unchanged elsewhere | §12: every store's rows constant from epoch 8 to 100 on every client; IndexedDB flat. The heap slope (0.9 MB per epoch) includes the harness's retained records and is not attributed. Canvas issuance grows on every path, base included (§13, finding 12); retention neither causes nor fixes it.                                                 |
| G2  | Backpressure; accepted work finishable                                   | Held                                                | Admission and lull queueing unchanged. Every refusal retains and the next pass runs the existing path.                                                                                                                                                                                                                                              |
| G3  | Golden path, including crash recovery                                    | **Not held**                                        | **14f case 8 (§8):** a SIGKILL after the first decision commits and before the second leaves signing rows that the next acquisition cannot classify. The creator's next lull then refuses `internal-invariant` and maintenance stops. Nothing is deleted wrongly. Without a crash, the Grid, the Canvas and Chat checks and the 100-epoch run pass. |
| G4  | Terminal sessions cannot be resurrected                                  | Held                                                | Retention runs inside the session's held room transaction. Terminal handling is unchanged.                                                                                                                                                                                                                                                          |
| G5  | Durable bytes are untrusted; trust re-verified on every open             | Held                                                | Every boundary starts from the existing cold authenticated acquisition. Step B compares every byte it relies on. Trust RED 1 and RED 4.                                                                                                                                                                                                             |
| G6  | No in-origin rollback defence; fail closed                               | Held                                                | Step A fences the floor before any room write. A tampered mark claiming more retirement than the floor fails closed at open (trust RED 4).                                                                                                                                                                                                          |
| G7  | One decision owner, no sweeper; labels are not deletion proof            | Held                                                | The node planner decides from the existing classifiers. Owners only apply. Labels fence; they never select rows.                                                                                                                                                                                                                                    |
| G8  | A watermark or physical deletion alone is not authority                  | Held                                                | As G7. The differential shows the decision is a subset of the existing planner's.                                                                                                                                                                                                                                                                   |
| G9  | Each owner rechecks its own facts transactionally before deleting        | Held                                                | Each owner section re-plans in step B inside the same strict transaction, and requires the planned digest.                                                                                                                                                                                                                                          |
| G10 | Only immutable and signed facts outlive a stage                          | Held                                                | Stage 1 carries nothing between boundaries. Plan and step B share one held transaction.                                                                                                                                                                                                                                                             |
| G11 | Currency reused only inside the same held native transaction             | Held                                                | Step B re-reads every control, row and survivor inside the transaction that writes. The acquisition's currency is not reused for writes.                                                                                                                                                                                                            |
| G12 | Foreign read-write is natively excluded                                  | Held                                                | One strict IndexedDB read-write transaction on the room database (R3's session). A writer during step B is serialised after the commit (trust RED 2).                                                                                                                                                                                               |
| G13 | Web Locks are advisory only                                              | Held                                                | Not used for any decision.                                                                                                                                                                                                                                                                                                                          |
| G14 | One bounded, resumable retirement intent; an absent receipt means retain | **Not held**                                        | The boundary's two decisions are not one resumable intent. After the first commits, the durable state carries no record from which the existing machinery can resume the summaries (case 8). Each single transaction is bounded and atomic.                                                                                                         |
| G15 | Crash atomicity: old XOR new; may retain too much, never delete too much | Held per transaction                                | 14f cases 5–8: every killed transaction left exactly the old or exactly the new state. In case 8 the left-over rows are retained, not deleted.                                                                                                                                                                                                      |
| G16 | Strict durability; no relaxed write                                      | Held                                                | Room and floor transactions are strict. Downgrade paths unchanged.                                                                                                                                                                                                                                                                                  |
| G17 | No resurrection: fences against old writers                              | Held                                                | Trust RED 3: stale writers refuse with the same codes as after the existing path.                                                                                                                                                                                                                                                                   |
| G18 | Protected set: head, two rollbacks, pending work, shared bytes           | Held                                                | Survivors (AHE head and its two rollbacks, protected scopes and headers) are compared exactly in step B. Differential subset at every lull.                                                                                                                                                                                                         |
| G19 | Issuance: only paired, published, epoch-bound rows                       | Held                                                | The owner's existing protected-hole rule. The settlement differential shows identical issuance rows on both paths.                                                                                                                                                                                                                                  |
| G20 | Snapshot lifecycle                                                       | Held                                                | The existing turnover authority and exclusive dependency claim are consumed once in step B.                                                                                                                                                                                                                                                         |
| G21 | Bounded work, reviewed limits                                            | Held, one limit pending review                      | The 512-write cap is the policy 14e proposes; it is pending review. Census reads bounded before issue.                                                                                                                                                                                                                                              |
| G22 | Full operation-local charges; no refunds; reservation before effects     | Held                                                | Fresh proof book per step B, every byte charged before the first write, no refunds (14e RED 2 and 3).                                                                                                                                                                                                                                               |
| G23 | Ingress queues FIFO during a lull                                        | Held                                                | Unchanged. Per-move remote acceptance during lulls improved (§6).                                                                                                                                                                                                                                                                                   |
| G24 | Startup floor is never repaired                                          | Held                                                | Step A requires the floor's stable epoch to equal the boundary's, and refuses otherwise.                                                                                                                                                                                                                                                            |
| G25 | Authenticated migrations                                                 | Not exercised                                       | 14d is out of scope. No format migration ships.                                                                                                                                                                                                                                                                                                     |
| G26 | Latency never justifies relaxing safety                                  | Held                                                | Nothing was traded. Case 8 is a defect to fix, not a trade.                                                                                                                                                                                                                                                                                         |
| G27 | No game-specific carve-outs                                              | Held                                                | One code path for Grid, Canvas and Chat (§11).                                                                                                                                                                                                                                                                                                      |
| G28 | Native requirements need native evidence                                 | Provided; one case fails                            | §8: three-engine cases 2, 3, 5–8 with real SIGKILL; case 8 is the counterexample behind G3 and G14. Case 9 (migration) is OPEN with 14d.                                                                                                                                                                                                            |

The two "not held" rows are one defect. It is reachable only on the opt-in path, and only when the second
decision of a creator boundary does not commit after the first did (a crash between them; a refusal of the second
decision should leave the same durable state, but that was not tested). Per the brief's stop rule, it is
recorded with its counterexample and not fixed in this track (§13, §14).

## 11. Canvas and Chat

Measurement only. Study notes, scripts and data: `<evidence>/track-m/sub-cc/` (tables in
`sub-cc/report/long-room-tables-*.txt`, data in `sub-cc/data/<run>/*.jsonl`).

**Harness** (new files only, committed as measurement-only; the vitest files run only with `TRACK_M_APPS=1`):

- `tests/fixtures/track-m-apps/long-room-driver.ts`, `long-room-core.ts`, `app-long-room.ts`: one long room of the
  shipped Canvas (creator-trusted-v1, signed ACL, 10×10) or Chat (creator-trusted-settlement-v1) composition, with
  genuine seal, adoption, install and both roles' `maintainRecoveryPool()` lulls, on the Node SQLite host, the
  six-database browser host, R3's room host, or the room host with retention. Per epoch it records every store's
  rows and bytes per role, and per-transition latency.
- `tests/track-m-canvas-long-room.test.ts`, `tests/track-m-chat-long-room.test.ts`,
  `tests/track-m-apps-creator-issue-profile.test.ts` (a V8 profile of the creator's issue calls).
- `tests/fixtures/track-m-apps/browser/`: the same driver in Chromium on real IndexedDB, one page per role on two
  origins (the per-origin Web Lock `ts-drp:<topic>` serialises adoption and install, as in the 14f harness).
- Two lull variants: the shipped lull, and a measurement-only "reader" lull that supplies the resource bound the
  shipped apps lack (finding 4 below).

**The six native tests, base against the branch.** Statuses and failure messages are identical, per test, in two
runs (at low load, and at load about 120 on the code of 55dbf18a): 35 pass and 15 fail on both trees. The 15
failures predate Track M ("truncated canonical value" 5, `createShippingChatAdmissionPolicy is not a function` 4,
`shippingChatCanonicalStateBytes is not a function` 2, state mismatch 4). Both runs set `SHIPPING_CHAT_CATALOG_DIR`
to a catalog materialised from the embedded one; without it both trees fail 32 of 50 identically.

| File                          | Base pass/fail | Branch pass/fail |
| ----------------------------- | -------------- | ---------------- |
| r9-canvas-receive-only-native | 14/0           | 14/0             |
| v3-canvas-equivalence         | 2/0            | 2/0              |
| r9-chat-capacity-room-native  | 15/4           | 15/4             |
| r9-chat-metadata-native       | 2/6            | 2/6              |
| r9-chat-role-network-native   | 2/0            | 2/0              |
| r9-chat-shipping-room-native  | 0/5            | 0/5              |

**Default paths are unchanged.** On the Node SQLite host and the six-database host, base and branch (05b5d706)
give identical rows, bytes and lull kinds for all 16 epochs in all 8 cases per host (Canvas and Chat, receive-only
and Writer recipient, shipped and reader lull). Latency ratios branch/base are 0.77–1.30 with no direction.

**Long-room flatness, 16 epochs** (rows at e2/e4/e8/e12/e16; the same on every path unless stated):

- **Canvas creator: issuance grows without bound.** Issuance outbox and issued records are 5/9/17/25/33: +2 rows
  per epoch with 2 moves per epoch (+8 with 8 moves), about +1.6 kB per epoch on IndexedDB. This holds on every
  path, base and branch, with and without retention. Canvas has no settlement profile, so nothing ever retires
  the creator's issued rows. A Canvas Writer recipient's own outbox grows the same way. Every other Canvas store is
  flat from epoch 5 to 7 (journal scopes 8, accepted entries 6, AHE generations 7, promotions 49, blobs 37,
  snapshot scopes and chunks 3, signing rows 3/3/6/6).
- **Canvas receive-only recipient: flat** on every path.
- **Chat: flat on every path, both roles.** Creator issuance 13 rows from epoch 6; a Writer recipient's issuance
  13 rows from epoch 5 (Track N's drain works); settlement plans 1. Snapshot chunk bytes grow while rows stay flat:
  +0.6 to +1.7 kB per epoch depending on recipient and lull.
- **Retention against the room path:** the only row difference is the recipient's journal scopes, 8 against 7
  from epoch 7, flat (finding 2 in §13). Fake-indexeddb rows equal Chromium rows exactly.

**Latency.**

- Chromium, real IndexedDB, room path against room path with retention, 2 interleaved ABBA pairs per case, p50
  over epochs ≥ 3, 16 epochs, load 90–190:

  | Transition              | Canvas, shipped lull             | Chat Writer, shipped lull | Canvas, reader lull | Chat Writer, reader lull |
  | ----------------------- | -------------------------------- | ------------------------- | ------------------- | ------------------------ |
  | Seal                    | 2672 → 769 (0.29)                | 2668 → 760 (0.29)         | 272 → 267           | 231 → 214                |
  | Adoption                | 208 → 193                        | 488 → 424                 | 494 → 470           | 639 → 613                |
  | Install                 | 196 → 182                        | 319 → 274                 | 184 → 188           | 265 → 252                |
  | Creator lull            | not run (`deferred:unsupported`) | not run                   | 2553 → 787 (0.31)   | 2135 → 546 (0.26)        |
  | Recipient lull          | 992 → 371 (0.38)                 | 1082 → 423 (0.39)         | 924 → 383 (0.41)    | 1058 → 380 (0.36)        |
  | Creator issue, per move | 394 → 409                        | 587 → 475                 | 334 → 346           | 367 → 301                |

  With the shipped lull, the creator's retirement runs inline at seal, so the saving shows in seal. The shipped-lull
  runs used an intermediate state of the governance fix; the reader-lull runs used 55dbf18a.

- **Canvas latency grows with room age because of the issuance growth**, on base too, with or without retention.
  In Chromium (slope over epochs 6–16): seal +120 ms per epoch on the room path and +43 with retention; creator
  issue +39 and +33; creator lull (reader) +134 and +59. Chat is flat (−35 to +31 ms per epoch, noise).
- **Mechanism** (V8 profile, base, Node host, Canvas, 8 moves per epoch): creator per-move issue time went from
  829 ms to 6,686 ms between epochs 2 and 16 under load about 110. The growth is in the `readOutboxPage` wrapper of
  `creatorFilteredIssuanceStore` (packages/node/src/v3-live.ts, near line 12485): it reads the native outbox in
  64-row pages and authenticates every retained historical row (`authenticateRecoveryVertex` →
  `extractAuthorizedV3Vertex`, `copyIssuedRow`, canonical decode) before skipping it. Each issue therefore costs
  O(outbox), and a room's issue work is O(n²) in its age.
- Fake-indexeddb ratios under load agree on the lulls and seal (0.22–0.56). They also showed retention's adoption,
  install and creator issue as slower in some cases (up to 1.37×), which Chromium does not reproduce (0.82–1.04).
  Treat that as load noise until a quiet paired rerun.

**Browser run via the shipped path.** Done in Chromium (the `tests/fixtures/track-m-apps/browser/` harness, 8 of 8
passing in each of two full runs). Firefox and WebKit are configured but were not run.

**Commands** (from the worktree root; Writer cases on fake-indexeddb need `TRACK_M_APPS_SETTLE_MS=300`, see
finding 5 in §13):

```
TRACK_M_APPS=1 TRACK_M_APPS_HOSTS=node,browser,room,room-retention TRACK_M_APPS_LULLS=product,reader \
TRACK_M_APPS_CANVAS_RECIPIENTS=receive-only,writer TRACK_M_APPS_CHAT_RECIPIENTS=writer,receive-only \
TRACK_M_APPS_EPOCHS=16 TRACK_M_APPS_SETTLE_MS=300 TRACK_M_APPS_OUT=<dir> \
pnpm exec vitest run tests/track-m-canvas-long-room.test.ts tests/track-m-chat-long-room.test.ts \
  --exclude ".claude/**" --no-coverage
TRACK_M_APPS_EVIDENCE=<dir> TRACK_M_APPS_OUT=<dir> TRACK_M_APPS_LULLS=product TRACK_M_APPS_REPEAT=2 \
pnpm exec playwright test -c tests/fixtures/track-m-apps/browser/playwright.config.ts --project=chromium
```

## 12. Endurance: 100 epochs

**Is a 100-epoch run sensible?** Yes. The healthy Grid already runs warm rollovers back to back with
per-transition assertions, so it only needed a higher rollover limit and telemetry buffers that scale with it.

**Harness changes (measurement only, separate commits).**

- 9514ff21 allows up to 128 rollovers and scales the test and fixture deadlines for runs over 32 rollovers.
- A second commit scales two telemetry buffers for runs over 32 rollovers: the delivery observation map
  (1,024 digests; it saturated near rollover 73 in the first attempt) and the proof-event buffer (4k per
  rollover; the room-retention creator emits about 4.3k per rollover, so it truncated near rollover 94 in the
  second attempt).
- Every per-transition assertion stays, and so do the saturation and truncation checks. Runs of up to 32
  rollovers are unchanged.

**Runs** (Chromium, 4 clients in one renderer, concurrent moves during every lull, `TRACE=0`; summaries by
`bin/endurance.py`, steady from epoch 8):

| Run (`<evidence>/track-m/grid/`) | Path                      | Outcome                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-endure-room-conc-100`       | room + retention          | Gameplay healthy to rollover 73, then the harness's delivery telemetry map saturated (fixed by the measurement-only commit).                                                                                                   |
| `run-endure2-room-conc-100`      | room + retention          | All 100 transitions, reopen and continued gameplay passed; the creator realm's proof-event buffer truncated near rollover 94 (fixed by the same commit). Figures agree with the clean run below (`endure2-room-conc-100.txt`). |
| `run-endure3-room-conc-100`      | room + retention          | **Passed**, every check, `proofEventsTruncated === false`. 1,132 s.                                                                                                                                                            |
| `run-endure-default-conc-100`    | default six-database host | **Passed**, every check. 1,594 s. Ran at the same time as `run-endure3`.                                                                                                                                                       |

**Room path with retention, 100 rollovers** (`run-endure3-room-conc-100`, build `build-m3`, the code of this
branch after the governance fix; summary `endure3-room-conc-100.txt`):

- All 100 transitions, the persisted reopen and continued gameplay passed (epoch 100, `continued-gameplay`, 804
  ordinary operations, 100 snapshots, every join ok, every per-transition assertion).
- Latency per transition (window medians in ms; least-squares slope in ms per epoch over epochs 8–100, then over
  the late half):

  | Window            | t8–15 | t16–31 | t32–49 | t50–74 | t75–100 | Slope | Late slope | Max  |
  | ----------------- | ----- | ------ | ------ | ------ | ------- | ----- | ---------- | ---- |
  | Seal              | 357   | 360    | 356    | 346    | 335     | −0.39 | −0.75      | 540  |
  | Creator adoption  | 782   | 789    | 829    | 815    | 868     | 0.67  | 0.53       | 1633 |
  | Recipient install | 539   | 510    | 517    | 506    | 498     | −0.75 | −0.85      | 1069 |
  | Creator lull      | 912   | 887    | 899    | 888    | 872     | 0.04  | 0.98       | 2812 |
  | Recipient lull    | 765   | 690    | 682    | 674    | 660     | −0.93 | −0.75      | 1153 |

  - Creator adoption has the only consistently positive slope: 0.67 ms per epoch, about 60 ms over 92 epochs
    (782 → 868 ms between the first and last windows). In the truncated run it was 0.53 ms per epoch with a last
    window of 811 ms. This is small, but it is the one figure to watch in a longer run.
  - These lulls are longer than in the 8-rollover benchmark (§6) because these runs had concurrent moves in
    every lull and a load average of 110–150. They are not a paired comparison.

- Per-move latency during lulls (concurrent moves):
  - creator lulls: local durable issue p50 54–60 ms in every window; remote durable admission p50 397–494 ms;
    slopes +0.12 and +0.16 ms per epoch;
  - recipient lulls: issue p50 104–117 ms; remote admission p50 422–507 ms; slopes −0.05 and −0.94 ms per epoch.
- Retention passes: creator 96, all applied, 2 decisions each, 52 writes, p50 549 ms, slope −0.41 ms per epoch.
  Recipients 291, all applied, 38 writes, p50 530 ms, slope −0.36 ms per epoch. Declines: `ahe-birth` 4,
  `signing-same-epoch` 2, `journal-same-epoch` 1, all at the births.
- Storage per client at each checkpoint (epochs 8, 16, 32, 50, 64, 75, 90 and 100):
  - every store's row count is constant from epoch 8 to epoch 100 on every client (creator 227 rows, recipients
    199–207);
  - binary bytes grow 10–11 bytes per epoch, about 0.004% per epoch;
  - issued records are constant (21 on two clients, 17 on two).
- IndexedDB allocation (sampled): 5–18 MB at the checkpoints, slope −0.01 MB per epoch.
- Heap after forced GC: 88 MB at epoch 8 and 177 MB at epoch 100, about 0.89 MB per epoch (0.79 in the late
  half). The page also holds the harness's records: 428,590 proof events in the creator realm (about 4.2k per
  epoch), about 42,000 in each recipient realm, and spans. At that rate the slope would be about 210 bytes per
  creator proof event, which is the right order for these records, but this run cannot separate product heap
  from harness records.
- Long tasks (≥ 50 ms): 1 of 500 windows, a creator adoption (50 ms, late window). None in any lull.

**Default six-database host, 100 rollovers** (`run-endure-default-conc-100`, same build, no room database and no
retention; summary `endure-default-conc-100.txt`). It ran at the same time as `run-endure3`, so both saw similar
load. It is not a paired benchmark, and it uses the six-database host, not base's room path (§6 has the paired
comparison):

- Passed every check (epoch 100, continued gameplay, no truncation). 1,594 s.
- Window medians, t8–15 → t75–100, in ms: seal 391 → 344, adoption 771 → 848, install 517 → 451, creator lull
  3816 → 3382, recipient lull 1845 → 1690. Slopes: −1.2, +0.36, −0.8, −4.0 and −1.9 ms per epoch. No latency grows
  with room age on either path.
- Moves during creator lulls: issue p50 66–73 ms; remote durable admission p50 2829–3272 ms, against 397–494 ms on
  the room path with retention. During recipient lulls: 1435–1557 ms against 422–507 ms.
- Rows are constant from epoch 8 to 100 on every client (225, 196, 204, 196). Bytes grow 10–11 bytes per epoch,
  as on the room path.
- Heap after forced GC: 88 → 195 MB, 1.08 MB per epoch (1.02 late). This run's page holds 520,424 proof events in
  the creator realm and about 83,000 in each recipient realm: about 770,000 in all, against about 554,000 on the
  room path. The heap slopes differ in the same direction (1.08 against 0.89 MB per epoch). That supports, but does
  not prove, that most of the heap slope is the harness's retained records.
- Long tasks (≥ 50 ms): 4 of 500 windows, all creator adoptions (at most 52 ms). None in any lull.

**Against R10** (requirements-to-evidence.md, row 10: "continuous ≥ 100 transitions, … exact
world/ACL/authority/history/op digest, native storage saturation and fresh-process late-window post-GC
slopes/absolute ceilings"):

- Shown: 100 continuous transitions in one room with gameplay, persisted reopen and continuation, every
  per-transition assertion of the Grid passing, flat row counts per store and client, flat IndexedDB
  allocation, no latency growth with room age, and late-window slopes for every latency.
- Not shown:
  - exact world, ACL, authority, history and operation digests compared per transition (the Grid asserts its
    own per-transition checks and the operation and snapshot counts, not a digest ledger);
  - native storage saturation (no quota pressure was applied);
  - fresh-process post-GC slopes and absolute ceilings (one renderer for the whole run, and the harness's
    retained records are inside the heap figure);
  - the thousand-epoch and 64-writer obligations.
- R10 is not closed by this run.

## 13. Findings

1. **Case 8: a crash between a creator boundary's two decisions stops maintenance (blocking).**
   - What happens: the first decision (D1) retires epoch e's seal evidence and completes the signing control with
     `{decisionDigest, sourceProofDigest, throughEpoch, protectedEpochs}`. Epoch e is no longer protected. The
     second decision (D2) retires e's summaries: one `signerState` row and two each of `voteOutbox` and
     `voteSlots`.
   - The existing path's evidence pass records a durable summary source (`completed.summarySource` with its
     eligibility fence) that its summary pass resumes from. D1 records none.
   - After a kill between D1 and D2, `acquireSigningDependencies` (packages/seal/src/creator.ts:775) finds e's
     signer rows but no authenticated material for e, and throws `UNCLASSIFIED_SIGNING_DEPENDENCY:e`. CRD
     converts that to `internal-invariant` in `acquireCreatorIssuanceMaintenanceProof` (readiness capture).
   - The same durable state should follow if D2 is refused after D1 commits (stale, budget or capacity), since a
     refusal writes nothing. That case was not tested.
   - Evidence: `<evidence>/track-m/sub-14f/counterexamples/case8-after-b/` (Chromium `death8-cr-03`, the product's
     own `closed-data-acquisition-refused` proof event; the signing control before and after).
2. **The recipient's journal header lags one lull** on the retention path: the header becomes collectible one
   boundary later than on the existing path. The differential shows it as retention keeping one more row
   (125 against 124 recipient rows from epoch 7, constant). It is safe, and it does not grow.
3. **A domains-less kind-3 AHE completion** (the retention path's AHE control) was rejected by reopen
   reconstruction until v3-live.ts recognised it at activation on opted-in rooms (`roomRetentionCompletedBoundary`,
   §3.3). Any future change to the AHE control's shape needs the same reopen check.
4. **Empty decisions.** After a reopen, a cold boundary at the transition plans a decision with no rows. It still
   advances every owner control with its labels, as the existing pass does. It costs a floor fence and a
   transaction.
5. **A pre-existing race, `NATIVE_READ_RESERVATION_BUSY`**, when a seal immediately follows a received move
   (fake-indexeddb, with a Writer recipient). The seal fails with "creator recovery role transfer source failed:
   internal-invariant". It reproduces on base at the same rate (Canvas Writer on the room host: 8 of 8 with no
   yield on both trees, 5–6 of 8 with a 0 ms yield, 0 of 8 with 300 ms). It was never seen on the Node host or in
   Chromium. The settlement fixture and the Canvas and Chat runs wait 300 ms before each seal.
6. **Governance constraints that a 14b implementation must respect** (found by the storage-browser suite, fixed
   here): the `@ts-drp/storage` root runtime keys are pinned; package export maps are pinned (no new subpath);
   the pack tests stub `@ts-drp/storage` with the published root names, so storage-browser's root-reachable
   declarations must not name new storage types; and the IDB ownership checker fixes each owner's allowed
   IndexedDB calls (the AHE owner may not use `IDBKeyRange.bound` or `count()`).
7. **The heap grows about 0.9 MB per epoch in the 100-epoch run** on the room path with retention, and 1.1 MB per
   epoch on the default host. The harness keeps every proof event and span in the page (about 554,000 and 770,000
   proof events in all), and the slopes differ in the same direction as the event counts. These runs cannot
   separate the two. A fresh-process measurement with the harness records dropped (or counted) is needed before
   anyone reads this as product growth.
8. **The harness's proof-event budget (4k per rollover) is too small for 100-rollover runs on either path.** With
   concurrent moves, the creator realm recorded about 4.3k proof events per rollover on the room path with
   retention and about 5.2k on the default host (the harness comment cites about 3.7k from Track R3's 16-rollover
   runs). The retention path emits fewer than the default host, not more. The measurement-only commit allows 6k
   per rollover for runs over 32 rollovers.
9. **Recipient-lull move issue p50 was 20 ms higher on HEAD** (102 → 122 ms, n = 30 per variant, one 549 ms
   outlier). The 100-epoch run shows 102–113 ms in every window. It should be re-measured with more samples
   before the default flip.
10. **The benchmark ran at 51d007eb**, before the governance fix. That fix changed the AHE census reads and
    import paths. The 100-epoch run used the fixed code; its lull figures are from a different load and mode
    and are not a paired comparison.
11. **14e RED 5** (an over-bound legacy database refuses migration) belongs to slice 14d and was not run.
12. **Canvas issuance grows without bound on every path, base included (a G1 gap that predates Track M).** The
    creator's issuance outbox and issued records gain one row each per move (33 rows at epoch 16 with 2 moves per
    epoch), and a Canvas Writer recipient's own outbox grows the same way. Canvas (creator-trusted-v1) has no
    settlement profile, so nothing retires them. Chat and the Grid (settlement profiles) are flat. Not fixed here;
    it needs an owner rule for issued rows without settlement.
13. **Because of 12, Canvas latency grows with room age** (§11): creator per-move issue time went from 829 to
    6,686 ms between epochs 2 and 16 in the profile run (8 moves per epoch, high load), and Chromium seal and lull
    times rise 43–134 ms per epoch. The cause is `creatorFilteredIssuanceStore`'s `readOutboxPage` wrapper
    (packages/node/src/v3-live.ts), which authenticates every retained historical outbox row before skipping it,
    so each issue is O(outbox).
14. **The shipped Canvas and Chat creators never run their lull.** They do not supply
    `readOrdinaryApplicationResourceBound`, so the creator lull is always `deferred:unsupported` and the creator's
    retirement runs inline at seal (seal about 2.7 s on the room path from epoch 5; about 0.77 s with retention).
    With a measurement-only bound supplied, the lull runs and retention cuts it to 0.26–0.31 of the room path.
15. **Existing node tests run the original text of the code 14b touches** (§9). They take the source of
    `runCreatorOrdinaryReadinessMaintenance`, `creatorRetirementResumeRequested`, the activation checkpoint, the
    prefix of `reconcileSnapshotRecoveryRoles` and its readback bracket, and evaluate it with fixed bindings; one
    also counts the call sites of `compareClosedGenerationSources`. Any new free identifier or edited node there
    breaks them. Stage 1 now keeps its code outside that text (8a09ceb8). Stage 2, 14c and the default flip will
    change the default path itself, so those tests will need their owners' review then; moving code aside will
    not be enough.

## 14. What remains for the default flip, and risks

**Must be done before the default flip, in order:**

1. **Fix case 8.** Three options, none tried here:
   - (a) D1's signing control records the evidence decision in the existing durable form: the completed summary
     source with its eligibility fence, as the existing evidence pass writes it. A crash after D1 then leaves a
     state the existing summary resume already handles, and the retention path declines it (`signing-summary`).
     D2 must then complete the control the way the existing summary pass does. This keeps 14b's text. It needs
     the exact digests of the existing summary source, and the differential has to cover the control's contents,
     not only the deleted rows.
   - (b) Retire an epoch's evidence and its summaries in one decision, ordered inside the transaction. The only
     durable states are then the pre-state and the state after both, which is what every passing run already
     reaches. This is the smallest change, but 14b says "summaries only for epochs whose evidence retirement
     completed earlier", so the slice owner must accept it first. Continuation splitting must then keep an
     epoch's evidence and summaries in one unit.
   - (c) Retire left-over summaries through the existing `authenticateClosedSigningSummaryEpoch` path, which
     authenticates residual summaries from the signed Cut and QC in the AHE closures. This needs differential
     proof that the existing planner makes the same decision from that state.
   - Whichever is chosen, re-run 14f case 8 on all three engines, plus a test that refuses D2 after D1 commits.
2. **Stage 2 (the ledger, §7).** Without it the creator's retention pass is about 400 ms, not ≤ 100 ms.
3. **14c wiring into the node** (step A per owner is here only as the floor's one-transaction `fenceDecision`)
   and **14d migration** (out of scope; 14e RED 5 belongs there).
4. **Review of the 512-write cap** (14e's proposed policy).
5. **Re-measure** recipient-lull move issue latency with more samples, and the heap in a fresh process without the
   harness's retained records.
6. **Review the source-evaluating node tests with their owners** (finding 15). Making the retention path the
   default changes the code those tests run as the original.

**Risks.**

- Case 8 shows that the per-transaction tests (old XOR new) do not catch states that are valid per transaction
  but unknown to the existing resume logic. Every boundary that is split into more than one transaction
  (two decisions, or continuations over the cap) needs a crash test between its transactions, not only inside
  them. The continuation split over the cap (14e) has the same exposure in principle: only per-transaction
  crashes were tested for it.
- The retention path depends on the existing classifiers staying the authority (G7). A change to an existing
  owner rule must be mirrored in the retention selection, or the differential will flag it. The differential
  is the guard, and it must keep running.
- The opt-in host is the only configuration where these decisions run. Nothing here was run on Firefox or WebKit
  in the Grid; native per-engine evidence is the 14f harness only (§8).
- Readiness capture (about 130 ms) stays outside retirement and becomes the largest part of the creator lull
  after stage 2.

## Files touched

Against 5c6b949d (`git diff --shortstat 5c6b949d 8a09ceb8`: 56 files, 11,901 lines added, 45 removed), plus
this file.

- **Product (opt-in path only):**
  - packages/storage/src/room-retention.ts (new: limits, decision records and digests, proof book, refusals);
    packages/storage/src/room-head.ts (exports them).
  - packages/storage-browser/src/internal/room-retention.ts (new: `planRetention` and `applyRetention` on the room
    session); the owner sections in snapshot-transfer.ts, live-journal.ts, internal/signing-retirement.ts,
    internal/browser-issuance-store.ts and internal/ahe-reclamation.ts; their composition in maintenance.ts;
    internal/idb-adapter.ts (room AHE store identity); room-head.ts (the floor's `fenceDecision`).
  - packages/storage-node/src/room-head.ts (the floor's `fenceDecision`).
  - packages/node/src/internal/creator-closed-rollback-data.ts (decline reasons, selection, the pass and the
    plan-only probe); internal/room-retirement.ts (session options); v3-room-host.ts (`roomRetention`);
    v3-live.ts (`roomRetentionCompletedBoundary` and the `roomRetentionResumeControl` marker for reopen).
  - examples/v3-room/src/index.ts (the `roomRetention` option of `createBrowserV3RoomDatabaseStorageHost`).
- **Tests and fixtures:** tests/track-m-room-retention-{trust,bounds,differential,long-room,settlement}.test.ts;
  tests/fixtures/track-m/ (fixture, probe, settlement room, native harness); tests/fixtures/track-m-apps/ and
  tests/track-m-{canvas,chat}-long-room.test.ts, tests/track-m-apps-creator-issue-profile.test.ts;
  tests/fixtures/phase-3a1b/grid-room-head-authority.ts (passes the floor's `fenceDecision` through).
- **Grid harness (measurement only):** tests/fixtures/startup-discovery/healthy-grid.ts, playwright.config.ts,
  r8-source-binding.pw.ts.
- **Docs:** this file.
