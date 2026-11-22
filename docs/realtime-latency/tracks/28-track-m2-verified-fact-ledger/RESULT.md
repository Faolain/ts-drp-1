# Track M2: the verified-fact ledger on the room retention path (slice 14b stage 2)

- Worktree: `<worktree agent-a7a653ac48415a524>/`, branch `worktree-agent-a7a653ac48415a524`. Nothing was pushed.
- Base: Track O's branch `worktree-agent-a5e3fefad3208def1` at **099db6ce** (on Track M's 07849f85, on
  `codex/phase3a1b-p6-golden-path` at 5c6b949d), by the coordinator's instruction. Track O's 14b and 14e amendment
  ("Units and resume") is in force: one decision per boundary, one epoch's signing work per unit, the unit order,
  and every committed prefix resumable from a fresh acquisition.
- Working notes: `<evidence>/track-m2/PLAN.md` and `PROGRESS.md`. Logs: `<evidence>/track-m2/logs/`. Suite reports:
  `<evidence>/track-m2/tests/`. Native runs: `<evidence>/track-m2/sub-14f/runs/`. Grid: `<evidence>/track-m2/grid/`.
  Canvas and Chat: `<evidence>/track-m2/apps/`. Scripts: `<evidence>/track-m2/bin/`.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
  `CRD` is packages/node/src/internal/creator-closed-rollback-data.ts, `VL` is packages/node/src/v3-live.ts.
  "Stage 1" is Track M's verified retention decision as amended by Track O (a complete cold acquisition per
  boundary); "the ledger" is this track's stage 2.

## 1. Outcome in brief

- **Built: one bounded in-memory ledger of verified facts per room session, on the opt-in retention path only**
  (`createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })`). A boundary is decided from the ledger plus
  that boundary's fresh reads, and applied by stage 1's own step A and step B. The default host and R3's room path
  without retention create no ledger and run exactly as before.
- **Every decision equals stage 1's.** Shadow oracle on the same pre-state: 16-epoch room, two seeded random
  histories, Track N's settlement room, Canvas. Grid: identical decisions at all 19 boundaries in 6 runs per mode.
  Canvas and Chat: identical rows in every store at every epoch, on fake-indexeddb and in Chromium. No stop
  condition was hit: the ledger never deletes anything stage 1 or the existing planner keeps.
- **Track O's structure is kept.** The ledger planner calls O's one-decision builder; no transaction, decision or
  split point is added; the ledger is never persisted. Track O's three test files and the one-unit 14f death cases
  at continuations 1–3 on three engines pass, and `creator-closed-rollback-proof-accounting.test.ts` gives Track
  O's result for every test (§6, §7).
- **Lull, Grid, 3 interleaved ABBA pairs against Track O's head** (LULL=1, steady t5+):
  - creator lull 632.5 → 441.6 ms (0.70);
  - recipient lull 490.6 → 251.9 ms (0.51);
  - retention pass 406.5 → 191.1 ms on the creator, about 395 → 186 on each recipient.
  - With concurrent moves: creator lull 755.2 → 542.3, recipient 634.2 → 287.5; remote admission of a move made
    during the creator lull 423.9 → 213.9 ms p50, during the recipient lull 406.9 → 116.4.
  - Against base 5c6b949d (one pair, high load): creator lull 3163 → 670, recipient 1615 → 303.
- **The ≤ 100 ms target is not met.** The steady creator lull is now readiness capture (~160 ms, outside 14b), the
  planner's read pass (~125), step A and B (~30), plan (~25), the dependency hold (~13) and ~64 ms of the lull's own
  work (§8.2). One transaction per epoch was not reached (§3.8).
- **Readiness capture can shrink too, but not under 14b** (§8.3). It is the same acquisition family, but 14b
  excludes it and its product is an admission input. It needs its own slice. It also got ~20 ms slower after a
  ledger boundary (it now reads cold what the cold acquisition used to warm).
- **One observation was not explained:** in LULL=1 runs, seal (×1.04–1.54) and adoption (×1.03–1.14) were slower
  with the ledger in all three pairs (steady medians: seal 288 → 303, adoption 555 → 573). In concurrent runs they
  had no direction. No ledger code runs in either path (§8.1, §12).
- **Endurance, 100 rollovers with concurrent moves:** passes; rows flat on every client (the same counts as Track
  M's stage-1 run); latency slopes about 0; ledger 17.4 KB per role, flat. The ledger decides 383 of the 387
  passes (each role's first boundary is the open verification) with no drop in 100 epochs. With the harness
  keeping only the proof events the summary needs, the heap slope falls from 0.83 to 0.36 MB per epoch, and stage 1
  under the same option has the same 0.36: the ledger adds no heap growth (§9).
- **One harness finding fixed on the way:** Track M's 14f case 2 (refusal) failed at 1582ef8c because the ledger's
  drop event came between the refused pass and the fallback's decline. 84f50751 drops before the pass reports; the
  test is unchanged (§6).

## 2. Commits

| Commit   | Kind             | What                                                                                                                                                     |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 111889d6 | RED              | `tests/track-m2-ledger-red.test.ts` (11 tests) and `tests/track-m2-ledger-differential.test.ts`, before any code.                                        |
| 3794be41 | feat             | The ledger module, its plane lifetime in VL, the ledger planner and seeding in CRD, the creator lull entry in creator-close.ts.                          |
| 42f21f29 | test             | Three RED premises corrected and the applied-twins oracle, each checked against stage 1 with the ledger off (§4).                                        |
| 1582ef8c | test             | `tests/track-m2-ledger-split.test.ts` (Track O's split points on a ledger decision) and `tests/track-m2-ledger-apps.test.ts` (Canvas, `TRACK_M_APPS=1`). |
| 84f50751 | fix              | Drop the ledger before a refused, failed or short pass reports (14f case 2).                                                                             |
| f30bad5a | measurement only | The 14f worker keeps `acquisition`, `action`, `source` and `role` of room-retention events.                                                              |
| 2908fc79 | measurement only | `STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS`: a Grid realm retains only the named proof-event kinds and counts the rest. Unset, unchanged.                   |
| RESULT   | docs             | This file.                                                                                                                                               |

## 3. Design as built

### 3.1 What the ledger holds, and the bytes each fact is keyed by

One `RoomRetentionLedger` per plane chain (packages/node/src/internal/room-retention-ledger.ts, new). Plain data
plus the genuine trust objects that opening produced. One record per boundary, replaced whole.

| Fact (14b list)                                                    | Held as                                                              | Key: exact bytes it was verified from                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AHE generation authenticated as historical (excluded from the set) | its key, and the genuine trust pair opening produced                 | digest of the generation record without its state: objectId, generationId, baseExpectedHead, closureDigest, closure refs (`roomRetentionGenerationKey`); a closed Q's key also binds its unique predecessor's record, since its verification was an advance from it (`roomRetentionExcludedKey`) |
| retained closed cut's source proof (successor trust of epoch k)    | its key, and the genuine trust pair                                  | the cut's epoch, closed anchor digest and its source generation's key (`roomRetentionCutKey`)                                                                                                                                                                                                    |
| the boundary itself                                                | objectId, pin, boundary epoch, authenticated anchor digest           | identity only; the next boundary's authenticated chain must extend it                                                                                                                                                                                                                            |
| eviction and rollback detectors                                    | every excluded key recorded; identities the applied decision retired | digests                                                                                                                                                                                                                                                                                          |

Narrower than the plan (PLAN §1). Not ledgered after all: cut summaries, the recovery-role certificate,
membership authorities, snapshot scopes. The planner re-authenticates the two newest closed epochs and their
certificate at every boundary with the original `authenticate`. The measured cost of stage 1 was its repeated
currency checks, the protected-union re-reads and the native preparation's double capture, not these openings.

Never held (14b, G10, G11): head or row state, census, controls, incarnations, floor state, publication state,
pending ingress, unsettled work, accounting, authorization. A generation's `state` (Adopted, Superseded) is
currency and is not part of its key.

Trust objects are identity-branded (a WeakMap registry; a copy is "foreign"). The ledger holds the genuine
objects and charges their registered material bytes (`roomRetentionTrustBytes`).

### 3.2 Lifetime (G10)

- Field `roomRetentionLedger?` on VL's `V3PlaneRegistration`, beside `vertexFacts`.
- Created lazily by the first complete verified boundary on a host that opted in (`captureRoomRetentionLedger(true)`
  on the lull's close lifetime, implemented in VL's `resolveRecoveryCloseHold`).
- Forked to the successor plane only in `activateV3LivePlane`'s transport-reusing branch (a genuine creator or
  received handoff). Released in `deactivateRegistration`.
- A reopen, a startup classification, an archive restore, a non-genuine recovery or a cold plane starts with no
  ledger. Its first boundary runs stage 1.

### 3.3 How facts enter

- **Open verification.** A boundary that runs stage 1 (the complete cold `acquireClosedData`) records the facts that
  acquisition verified, from its own composites (`seedRoomRetentionLedger`, source `open-verification`). It is
  recorded only when the decision applies. Seeding never changes stage 1's decision.
- **Ledger boundary.** Facts the ledger held and used again under the same keys, plus the newest epoch's facts
  opened fresh by the same openers on this boundary's bytes (source `boundary`). Recorded only when the decision
  applies.
- **Arrival capture: not wired.** PLAN §3 maps the capture points in creator-close.ts and creator-adoption.ts.
  Moving verification to arrival would put CPU into seal and install, which are also latency-critical, and gains
  little: the newest epoch's openings are a small part of the planner (§8.3).

### 3.4 What a ledger boundary reads (per boundary, never ledgered)

`planRoomRetentionFromLedger`, in order: snapshot role inventory; floor (stable and pending); journal retirement
image; snapshot retirement image; AHE control; floor image; AHE bounded recovery-role read; the original
`authenticate` of the two newest closed epochs and their certificate; the close census (`borrowDependencies`) and
signing rows (`borrowSigningDependencies`) from the lull hold; the signing evidence owners; the received
certificate per protected scope; header scopes; every classifier and O's one-decision builder
(`buildRoomRetentionPassPlan`). Step A and step B are stage 1's (`applyRoomRetentionPass`), unchanged: step B
re-reads every control, every deleted row's exact bytes, every survivor and each retired range's census in its own
transaction and refuses `RETENTION_STALE` on any difference.

Every generation in the census must match a ledger key exactly, or be opened fresh. A key the ledger recorded but no
longer holds (evicted) is never re-trusted: the boundary declines to stage 1.

### 3.5 Declines and drops

Any decline runs stage 1 for the same boundary, in the same lull, on the same hold.

- Drop the ledger: foreign object or pin, stale (not the previous boundary or this one), discontinuous anchor
  chain, rollback (a retired identity is present again), any refusal or failure in the planner or in step B,
  a shortfall, a record over the byte cap.
- Keep it: shape (pending promotion, installed promotion, more than one certificate), test mode, pre-flight, plan,
  budget, missing (an evicted key), inherited classification, pending floor or role.

### 3.6 Bound, eviction, charges (14e)

- Window: epochs at or above boundary − 8 (`ROOM_RETENTION_LEDGER_LIMITS.maxEpochs`); byte cap 256 KiB
  (`maxBytes`). Grid steady state: 17.3–17.4 KB per role, flat over 100 epochs.
- A record over the cap clears the ledger whole; nothing is trusted in part.
- The planner charges every byte it reads into a fresh proof book; a charge over `maintenanceProofBytes` declines
  before its plan applies. Step B keeps its own fresh book. Nothing is refunded; a ledger hit credits nothing.
- Test hooks may only lower the bounds.

### 3.7 Track O's invariants (coordinator's list)

1. One decision per boundary, one epoch's signing work per unit, the unit order: the ledger planner calls O's
   builder `buildRoomRetentionPassPlan` (stage 1's plan block moved verbatim into a function both paths call).
2. Every split point resumable from a fresh acquisition: the ledger adds no durable state. A refused or killed
   unit leaves the ledger dropped (refusal) or gone (kill), and the next acquisition is stage 1's.
3. No transaction or decision is added. The planner's read pass is reads only, before step A.

### 3.8 One transaction per epoch: not reached

The planner's read pass is separate from step B's held transaction. Reaching one transaction per epoch needs the
planner's reads inside step B's transaction (one read pass for plan and apply), which changes Track M and O's
step-B plumbing in storage-browser. Not attempted in this track.

## 4. RED tests and their status

All in new files. The RED file was committed before any code (111889d6). Node, fake-indexeddb, the retention
fixture, a FIFO lock manager. Status at f30bad5a: `logs/fix1-m2.log` (RED and split), `logs/diff-1.log`,
`logs/diff-twins-1.log`, `logs/apps-1.log`, and the tracks suite (§7).

| Requirement (brief, 14b, 14e)                                                   | Test                                                                                                                                                       | Status                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| The ledger decides in session, with no cold acquisition                         | red: "after the open verification seeds the ledger, later lulls decide from the ledger without a cold acquisition"                                         | pass                                                     |
| Every decision equals stage 1's on the same inputs                              | red: "the ledger planner's decision equals stage 1's on the same pre-state at every boundary (shadow, 16 epochs)"                                          | pass                                                     |
| Durable bytes poisoned after a fact was ledgered                                | red: "a ledgered survivor (a protected snapshot scope's chunk) poisoned after recording: no deletion, the ledger is dropped"                               | pass                                                     |
| A ledger fact whose stored bytes no longer hash to its key                      | red: "a ledgered fact whose stored bytes no longer hash to its key (an AHE closure blob) is never used"                                                    | pass                                                     |
| Durable bytes rolled back after a fact was ledgered                             | red: "a store rolled back after recording (retired AHE rows reinserted): the ledger never decides over it"                                                 | pass                                                     |
| Reopen with no carried facts: verify at open before deciding                    | red: "after a close and reopen the first decision is an open verification; no fact predates the open"                                                      | pass                                                     |
| A fact crossing a non-genuine handoff                                           | red: "the ledger crosses only genuine handoffs: one ledger per session, its generation grows by one per handoff"; plus the reopen test (a cold activation) | pass                                                     |
| Over-budget charge: refuse before the first delete                              | red: "an over-budget ledger decision refuses before its first plan, and the boundary runs stage 1"                                                         | pass                                                     |
| Over-budget ledger                                                              | red: "a ledger over its byte cap is dropped, never trusted partially; the next boundary verifies cold"                                                     | pass                                                     |
| Eviction under the bound: fall back to a cold verified read, never a stale fact | red: "a fact evicted under the ledger's window is never trusted: the boundary falls back to a cold verified read"                                          | pass                                                     |
| The default host and R3's room path without retention are unchanged             | red: "a room host without retention creates no ledger"; plus the suites (§7)                                                                               | pass                                                     |
| Track O's split points on a ledger decision (coordinator item 3)                | split: reference, and a stale refusal after each unit kind, creator and observer                                                                           | 9 pass, 5 skipped (no unit of that kind to refuse after) |
| Differential (§5)                                                               | differential: shadow 16 epochs, seeds 1 and 2, settlement room, applied twins; apps: Canvas                                                                | pass                                                     |

Corrections after the RED commit (42f21f29), each checked against stage 1 with the ledger off first:

- The lull's public result is `{kind: "maintained"}`, not `false`.
- After a reopen the first retention pass runs inside the seal's own maintenance, so "the first decision after
  reopen" is observed from the reopen, not from the first lull.
- A poison refusal revokes the plane in stage 1 too (`logs/poison-off.log`), so the restored retry asserts "no
  ledger decision", not "a cold pass".
- Applied twins compared row identities across two runs. Generation identities carry fresh signatures, so even
  epoch 1, before any retention, differed. The oracle now compares per-store row counts and epochs.

## 5. Differential

Node, fake-indexeddb, the retention fixture (`tests/track-m2-ledger-differential.test.ts`, `logs/diff-1.log`,
`logs/diff-twins-1.log`; `tests/track-m2-ledger-apps.test.ts`, `logs/apps-1.log`):

- **Shadow.** Stage 1 decides every boundary. Beside it, on the same pre-state, the ledger planner decides and the
  two are compared field by field (selections, survivors, controls, turnover; test-only hook
  `__roomRetentionLedgerMode = "shadow"`). Equal at every compared boundary, for both roles, on: a 16-epoch room;
  seeded random histories 1 and 2 (skipped lulls, swapped lull order, a persisted reopen); Track N's settlement room
  over 16 epochs, which includes Track N's cold recipient issuance drain; and Canvas over 16 epochs.
- **Track N's drain.** The drain depends on completed AHE and issuance retirement decisions matching. They match
  in the settlement shadow, and Track N's `recipient-long-room-issuance-retention-native.test.ts` passes (§7).
- **Applied twins.** The same settlement history with the ledger deciding and with stage 1 alone: both peers hold
  the same rows per store at every epoch (count, and epochs for rows keyed by epoch). Canvas twins: equal row counts
  per store.
- **Against the existing planner.** The ledger's decisions equal stage 1's, and Track M's differential (stage 1
  against the existing planner) still passes (§7). So the ledger never deletes a row the existing planner keeps.
- **Grid and the apps:** §8.5 and §10.

## 6. Native evidence (14f)

Track M's harness (`tests/fixtures/track-m/native/`), from this worktree, Playwright's Chromium 151.0.7922.34,
Firefox 153.0 and WebKit 26.5, one worker. `bin/f14-chain.sh`: the whole file on each engine; then Track O's one-unit
death cases (the reference and cases 5–8, `TRACK_O_14F_ONE_UNIT=1`) at continuations 1, 2 and 3 on each engine;
then case 11 (`TRACK_M_14F_LONG=1`) on Chromium. Runs in `<evidence>/track-m2/sub-14f/runs/<run>/`, each with the
HEAD and a digest of every bundled source (all at f30bad5a, no uncommitted tracked change).

**First chain, at 1582ef8c (stopped):** case 2 (refusal) failed on Chromium (`m2-full-chromium-01`). After the
refused pass, the next room-retention event was the ledger's drop, where the test requires the existing path's
fallback decline. The decision, the writes and every store were right. The ledger's drop is part of handling the
refused pass, so 84f50751 drops before the pass reports (for a refusal, a failure and a shortfall alike). The test
was not changed.

**Second chain, at f30bad5a:**

| Run                                               | Chromium       | Firefox        | WebKit         |
| ------------------------------------------------- | -------------- | -------------- | -------------- |
| Whole file (smoke, cases 2–3, reference, 5–8, 11) | 9 pass, 1 skip | 9 pass, 1 skip | 9 pass, 1 skip |
| One unit, continuation 1: reference, cases 5–8    | 5 pass         | 5 pass         | 5 pass         |
| One unit, continuation 2                          | 5 pass         | 5 pass         | 5 pass         |
| One unit, continuation 3                          | 5 pass         | 5 pass         | 5 pass         |
| Case 11, long room                                | 1 pass         |                |                |

The skip is case 11 in the whole-file runs (it needs `TRACK_M_14F_LONG=1`).

**The trapped boundaries are ledger decisions** (`bin/f14ledger.py`, `sub-14f/f14ledger-02.txt`; f30bad5a keeps the
pass's `acquisition` in the evidence):

- Cases 5–8, all 48 (4 cases × 3 engines × 4 runs: the whole file and continuations 1–3): the trapped boundary is
  the creator's epoch-6 lull boundary. The creator's ledger holds the epoch-5 open verification, no ledger decline
  or drop comes before the kill, and the crash-free twin in the same run's death reference is
  `acquisition: "ledger"`.
- Case 2 refusal and native abort, on each engine: the trapped pass reports `acquisition: "ledger"` (outcome
  `retained` and `failed`).
- Every case: the room is old XOR exact new (SIGKILL inside A: old/old; between A and B: old room, new floor;
  inside B: old/new; after B: new/new), the fence never lags, and recovery converges. The killed process's ledger
  dies with it (memory only); the reopened room starts with none, so its first decision is stage 1's (the reopen RED
  test shows this in node).

**Split points added by this track: none.** The ledger planner is reads only and runs before step A; the
decision is applied by stage 1's `applyRoomRetentionPass`. So there is no new transaction to kill between. A kill
during the planner's read pass is a kill before any write: the room is old, as after case 5 (inside A, whose
writes never commit), and the reopen starts cold (the reopen RED test).
The node split test (`tests/track-m2-ledger-split.test.ts`) refuses after each of Track O's unit kinds on a ledger
decision, for the creator and the observer, and the same session converges to the reference.

## 7. Suites and typecheck

Recipe: Track M's and O's. Vitest from the repository root with `--exclude ".claude/**" --no-coverage`, one JSON
report per set (`bin/suite.sh`), compared per test with `<evidence>/track-n/bin/vcompare.py` against Track O's
reports at its head. The node dist was built from the product source of 84f50751, the last product change (this
track does not change the storage packages). A test that timed out under load was rerun alone. All at 2908fc79.

| Set                                     | Track O passed / failed (its report, with its reruns) | This track, with reruns | New failures | Report                                            |
| --------------------------------------- | ----------------------------------------------------- | ----------------------- | ------------ | ------------------------------------------------- |
| node (packages/node)                    | 1023 / 48 (`head2-node`)                              | 1023 / 48               | 0            | `tests/head1-node.json`, `head1-proofacct`        |
| root (Track N's root set, 188 files)    | 678 / 336 (`head1-root`)                              | 678 / 336               | 0            | `tests/head1-root.json`, `head1-root-d110c-rerun` |
| sb (storage-browser and storage)        | 624 / 1 (`head1-sb`)                                  | 625 / 0                 | 0            | `tests/head1-sb.json`                             |
| snr (six storage-node retirement files) | 158 / 49 (`head1-snr`)                                | 158 / 49                | 0            | `tests/head1-snr.json`                            |
| obs (startup observation files)         | 23 / 0 (`head1-obs`)                                  | 23 / 0                  | 0            | `tests/head1-obs.json`                            |
| tracks (16 files, below)                | (no set)                                              | 116 / 0, 65 skipped     | 0            | `tests/head1-tracks.json`                         |

Per test against Track O's reports (`tests/cmp-head1-node.txt`, `tests/cmp-head1-root.txt`):

- node, whole set at load 66–128: 1021 / 50. Two tests of `creator-closed-rollback-proof-accounting.test.ts` timed
  out (192 s and 269 s against a 120 s limit). The file alone (`tests/head1-proofacct.json`): 331 / 20, Track O's
  result for every test. The 3 failures of `sync-state-heap-recharacterization-1o-f-ii-red.test.ts` (its heap
  worker cannot find `dist/src/sync-state.js`) are Track O's alone rerun exactly; Track O's whole-set run skipped
  them.
- root: 677 / 337 in the set. 8 of the 9 settlement codec tests that timed out in Track O's set pass here; the
  ninth failed with a module initialisation error
  (`Cannot access '__vite_ssr_import_8__' before initialization`). The file alone
  (`tests/head1-root-d110c-rerun.json`): 9 / 1, Track O's rerun exactly.
- sb: one more pass than Track O, `phase-2e7-publication-component-red` (a packaging gate that depends on the
  environment; this track does not change the storage packages).
- The same files fail to load on both trees (node: `creator-ordinary-generation-closure-capacity`,
  `proptest/spawn-scaling`; root: `protected-recovery-role-node-red`, `r11-real-game-terminal-native`,
  `r9-rpc-v3-room-native`).
- tracks: one vitest RPC timeout ("Timeout calling onTaskUpdate", at load 225) was reported as an unhandled error;
  every file and test passed.

- **Track O's must-keep checks (coordinator):** Track O's three files (`track-o-room-retention-resume`, `-split`,
  `-split-recipient`): 43 passed, 60 skipped, as in Track O's final run.
  `packages/node/tests/creator-closed-rollback-proof-accounting.test.ts`: Track O's result for every test (331 /
  20). The one-unit 14f death cases 5–8 at continuations 1, 2 and 3 on three engines: all pass (§6).
- **The tracks set**, all passing: Track M's five files (`track-m-room-retention-bounds`, `-differential`,
  `-long-room`, `-settlement`, `-trust`); Track O's three; Track N's `recipient-long-room-issuance-retention-native`;
  Track K's `recipient-long-room-journal-retention-native`; Track L's `recipient-lull-reopen-close-native`; R3's
  `room-database-retirement-native` and `recipient-lull-reopen-four-epochs-native`; and this track's RED,
  differential and split files. Track K's `recipient-long-room-red-symptom-native.test.ts` is not on this branch.
  `tests/track-m2-ledger-apps.test.ts` needs `TRACK_M_APPS=1` and ran on its own (`logs/apps-1.log`, §10).
- **Source-text tests (Track M finding 15).** Every new CRD function is outside the text the pinned node tests read.
  The pinned files fail exactly as on base (`logs/pinned-2.log` against `logs/pinned-base.log`), and
  `creator-closed-rollback-proof-accounting.test.ts`, which requires CRD's private statements to be unique, gives
  Track O's result for every test. Track O's `namecheck.py` lists 24 identifiers whose whole-word counts in CRD
  rise (`logs/namecheck-final.txt`), all ordinary words or calls (`apply`, `get`, `store`, `freeze`,
  `createCreatorClosedRollbackProofAccounting` 7 → 8); the files that look these names up give Track O's results
  (node and root: 0 new failures).
- `pnpm -r typecheck`: exit 0, 0 errors at 2908fc79 (`logs/typecheck-final.log`).
  `node scripts/check-shadowed-sources.mjs`: exit 0.
- Prettier: the new product module and the four new test files are formatted, and so is the 14f worker edit.
  `healthy-grid.ts`, `r8-source-binding.pw.ts` and `critical-observer.ts` were not prettier-clean before
  2908fc79, so they were not reformatted. CRD, VL, creator-close.ts and runtime-reclamation.ts were not
  prettier-clean at Track O's head and are not reformatted (that would change the source text tests read).

## 8. Grid benchmark

Healthy native Grid, Chromium, 4 clients, 8 rollovers, room database with retention (`bin/grid.sh`, the recipe in
the latency README). Steady state is t3 and later for seal, adoption and install, and t5 and later for the lulls
(the first retention boundary is t4). Medians over runs, then over transitions. Bundles (`bin/verifybuild.py`
checks each bundle's input roots, and that only M2's carries the ledger planner):

| Bundle      | Tree                                                                 | Commit   |
| ----------- | -------------------------------------------------------------------- | -------- |
| `o-head-3`  | Track O's head, exported (`git archive`) and checked blob for blob   | 099db6ce |
| `m2-head-1` | this branch                                                          | 1582ef8c |
| `m2-head-2` | this branch (the 14f-order fix and the 14f evidence keys)            | f30bad5a |
| `base-1`    | base, Track M's export, checked blob for blob                        | 5c6b949d |
| `m2-head-3` | this branch, with the harness option (endurance, §9)                 | 2908fc79 |
| `o-head-4`  | Track O's export plus 2908fc79's three harness files (endurance, §9) | 099db6ce |

`m2-head-1` and `m2-head-2` differ only in the order of two observations on refusal paths, which the Grid never
takes. `m2-head-3` adds only the harness option, and `o-head-4` differs from `o-head-3` only by it.

### 8.1 Against stage 1 (Track O's head): 3 interleaved ABBA pairs per mode

`grid/run-ab1-<lull|conc>-<o|m2>-<i>`, table `grid/bench-ab1-table.txt`, per pair `grid/pairs-ab1.txt`, creator
lull composition `grid/capture-ab1-lull.txt`. Load 13–48. All 12 runs pass.

| Steady median (ms)                       | LULL=1: stage 1 | LULL=1: ledger | ratio | concurrent: stage 1 | concurrent: ledger | ratio |
| ---------------------------------------- | --------------- | -------------- | ----- | ------------------- | ------------------ | ----- |
| Creator lull                             | 632.5           | 441.6          | 0.70  | 755.2               | 542.3              | 0.72  |
| Recipient lull                           | 490.6           | 251.9          | 0.51  | 634.2               | 287.5              | 0.45  |
| Creator retention pass                   | 406.5           | 191.1          | 0.47  | 468.1               | 216.2              | 0.46  |
| Recipient retention pass (per recipient) | 391–415         | 183–190        | ≈0.46 | 425–595             | 193–248            | ≈0.45 |
| Readiness capture (in the creator lull)  | 138.9           | 157.3          | 1.13  | (no span)           | (no span)          |       |
| Dependency hold (in the creator lull)    | 14.2            | 13.1           |       |                     |                    |       |
| Seal                                     | 288.1           | 303.1          | 1.05  | 311.4               | 319.5              | 1.03  |
| Adoption                                 | 554.5           | 573.1          | 1.03  | 633.5               | 632.4              | 1.00  |
| Install                                  | 396.8           | 382.9          | 0.96  | 469.0               | 468.8              | 1.00  |

Per pair (`grid/pairs-ab1.txt`): the creator lull ratio is 0.62–0.71 (LULL=1) and 0.53–0.83 (concurrent), the
recipient lull 0.49–0.58 and 0.37–0.51, in every pair. In LULL=1, seal (1.04, 1.06, 1.54) and adoption (1.03,
1.09, 1.14) were slower with the ledger in all three pairs. In concurrent mode they have no direction (seal 1.24,
0.79, 0.98; adoption 1.20, 0.71, 1.04). Neither the seal nor the adoption path runs ledger code (the fork at a
genuine handoff only moves a reference). A cause is not established. One candidate is background IndexedDB work
from the same deletes overlapping the next transition now that the lull ends about 190 ms sooner. It needs a
quiet paired check before the default flip (§12).

Per move during the lulls (concurrent mode, epochs ≥ 5):

| p50 (max), ms                            | stage 1       | ledger        |
| ---------------------------------------- | ------------- | ------------- |
| Creator lull: local durable issue        | 59.9 (980.5)  | 51.3 (836.0)  |
| Creator lull: remote durable admission   | 423.9 (975.9) | 213.9 (831.3) |
| Recipient lull: local durable issue      | 121.1 (520.3) | 78.2 (152.2)  |
| Recipient lull: remote durable admission | 406.9 (851.9) | 116.4 (208.7) |

Longest main-thread task per window (median / max, ms; LULL=1): creator lull 17.2 / 22.8 → 17.7 / 19.4; recipient
lull 10.2 / 12.8 → 11.1 / 13.3; seal, adoption and install unchanged within 1 ms of median.

### 8.2 Where the creator lull goes now

Per run and transition (`grid/capture-ab1-lull.txt`), steady ledger boundaries t6–t8: lull 390–525 ms = readiness
capture 137–208 + dependency hold 12–18 + retention pass 179–223 (of which the planner's read pass, `acquiredMs`,
119–153; plan 23–27; floor 3; step A and step B 30–34) + about 64 ms of the lull's own work.

- The ≤ 100 ms p50 target is not met (441.6 ms; 251.9 ms on the recipient).
- **Readiness capture is about 20 ms slower after a ledger boundary than after a cold one**, in every run: at t5
  (cold in both trees) 122–148 ms, at t6–t8 after a ledger pass 137–208 ms against Track O's 130–187. The capture
  reads the same records the cold acquisition used to read just before it; with the ledger it reads them cold. The
  saving is net of this.

### 8.3 Can readiness capture shrink too

Yes in principle; not in this slice.

- It is the same acquisition family: `captureCreatorOrdinarySourceWithoutForecast` (creator-close.ts) runs
  `acquireCreatorIssuanceMaintenanceProof`, a full closed-data acquisition with role observation and the
  protected union. Fake-indexeddb counters: 757 requests in 165 transactions per creator lull at epoch 8, unchanged
  by the ledger (`logs/count-apply.json`). The ledger planner cut the comparable retention acquisition from 930 /
  200 to 457 / 111, so a ledger-fed capture could plausibly save a similar share: an estimate of 60–90 ms of its
  ~150 ms.
- 14b excludes it: "Readiness capture ... and adoption are outside retirement". Its product is an ordinary
  issuance proof source that later admission calls rely on, so facts reaching it would cross from retirement into
  admission. That needs its own slice or a 14b amendment (contract, RED tests, a differential of the captured
  source against the cold one), not a change here.

### 8.4 Against base (5c6b949d, room path without retention): 1 interleaved ABBA pair per mode

`grid/run-ab2-<lull|conc>-<base|m2b>-1`, table `grid/bench-ab2-table.txt`. Load 60–90 during this pair, so
absolute values are higher than in §8.1.

| Steady median (ms)                        | LULL=1: base | LULL=1: ledger | ratio | concurrent: base | concurrent: ledger | ratio |
| ----------------------------------------- | ------------ | -------------- | ----- | ---------------- | ------------------ | ----- |
| Creator lull                              | 3163.2       | 670.0          | 0.21  | 3082.8           | 633.2              | 0.21  |
| Recipient lull                            | 1614.5       | 303.1          | 0.19  | 1657.5           | 335.3              | 0.20  |
| Readiness capture                         | 173.2        | 220.2          | 1.27  |                  |                    |       |
| Seal                                      | 373.9        | 400.2          | 1.07  | 386.1            | 354.8              | 0.92  |
| Adoption                                  | 657.5        | 707.5          | 1.08  | 641.8            | 720.8              | 1.12  |
| Install                                   | 438.3        | 464.9          | 1.06  | 432.6            | 461.1              | 1.07  |
| Creator lull, remote admission per move   |              |                |       | 2291.2           | 256.7              | 0.11  |
| Recipient lull, remote admission per move |              |                |       | 1277.2           | 134.6              | 0.11  |

### 8.5 Grid differential

`bin/gridcmp.py` reduces every applied retention pass to its decision report without timing, per role and epoch.

- LULL=1: all six runs (three stage 1, three ledger) have identical decisions at all 19 boundaries, including
  step B's charged bytes.
- Concurrent: identical rows deleted per owner and writes at all 19 boundaries in all six runs. Step B's charged
  bytes differ run to run on both trees, because concurrent moves differ.
- Steady boundaries in the ledger runs: 15 of 19 are ledger decisions; the 4 cold ones are each role's first
  boundary (the open verification).
- Ledger size: 17.3–17.4 KB per role, 4 to 5 epochs, flat from epoch 6 (bound 256 KiB).

## 9. Endurance: 100 rollovers

Healthy native Grid, Chromium, 4 clients, room database with retention, concurrent moves, 100 rollovers, `TRACE=0`
(`bin/grid.sh`, summary `bin/endurance.py`, Track M's script with two lines added for the harness counts).
Epochs ≥ 8 are steady.

| Run                                      | Bundle      | Harness records                                | Result | Duration |
| ---------------------------------------- | ----------- | ---------------------------------------------- | ------ | -------- |
| `grid/endure1-room-conc-100.txt`         | `m2-head-2` | all proof events retained                      | pass   | 892 s    |
| `grid/endure2-kinds-room-conc-100.txt`   | `m2-head-3` | only the named kinds (2908fc79)                | pass   | 981 s    |
| `grid/endure3-kinds-o-room-conc-100.txt` | `o-head-4`  | only the named kinds (stage 1, Track O's head) | pass   | 903 s    |

**Storage: flat.** All three runs: every client's rows are constant from epoch 8 to 100 (227, 199, 207 and 199,
the same counts as Track M's stage-1 run), no store's rows change, issued records constant (21 and 17), binary bytes
about +10 B per epoch per client, IndexedDB allocation slope −0.03 to 0.01 MB per epoch.

**Latency: no growth.** Slopes over epochs ≥ 8, ms per epoch (endure1 / endure2): seal 0.21 / −0.12, adoption
0.73 / −0.49, install 0.06 / −0.84, creator lull −0.39 / −0.23, recipient lull −0.20 / −0.62. Per move during the
lulls: issue −0.02 / −0.14 and remote admission −0.14 / −0.25 (creator lull), −0.11 / −0.21 and −0.06 / −0.34
(recipient lull). The window medians move with the machine's load, not with epoch.

**Retention: the ledger decides every boundary after the first, for 100 epochs.** Both ledger runs, identically
(`grid/endure1-ledger.txt`, `grid/endure2-ledger.txt`, `bin/endure_ledger.py`):

- A pass at every boundary from the first one (creator epoch 5, recipients epoch 4) to epoch 100: creator 96,
  recipients 291, all `applied`, each in one continuation. Writes per pass 51–52 (creator) and 23–38 (recipient).
- 383 of the 387 passes are ledger decisions. The 4 cold ones are each role's first boundary, the open
  verification. No ledger drop and no ledger decline in 100 epochs.
- The 7 declines (4 `ahe-birth`, 1 `journal-same-epoch`, 2 `signing-same-epoch`) are all before the first pass.
- Pass p50 281.9 / 312.6 ms (creator) and 258.3 / 320.6 (recipient), slopes −0.29 to 0.12 ms per epoch.
- Ledger size at epochs ≥ 8: creator 17,441–17,464 bytes, each recipient 17,371–17,396 bytes. Flat.

**Heap: the harness's records are most of the growth, and the ledger adds none.** Forced-GC JS heap at each
checkpoint:

| Run                           | e8   | e16   | e32   | e50   | e64   | e75   | e90   | e100  | slope MB/epoch (late half) | proof events retained (creator realm) | dropped (counted only) |
| ----------------------------- | ---- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | -------------------------- | ------------------------------------- | ---------------------- |
| endure1, all retained         | 88.9 | 102.4 | 120.8 | 135.7 | 146.1 | 153.8 | 164.5 | 172.1 | 0.831 (0.729)              | 425,836                               | (no option)            |
| endure2, named kinds only     | 85.7 | 95.4  | 106.1 | 112.6 | 116.0 | 118.7 | 122.5 | 125.1 | 0.356 (0.251)              | 200                                   | 425,636                |
| endure3, stage 1, named kinds | 84.9 | 94.6  | 105.5 | 111.9 | 115.4 | 118.1 | 122.0 | 124.6 | 0.356 (0.255)              | 104                                   | 428,486                |

- Not retaining the other proof events removes 0.48 MB per epoch of the slope (0.831 → 0.356), and the sampled
  peak heap falls from 667 to 174 MB. The retained events carry everything the summary needs: the same 96 and 291
  passes and the same per-move counts in each window as endure1.
- The rest, 0.36 MB per epoch (0.25 in the late half), is not attributed. It still includes the harness's spans,
  which grow with the room (13,726 in the creator realm at epoch 100), and its other records.
- **The ledger adds no heap growth.** Stage 1 under the same harness option (`o-head-4`: Track O's export with
  2908fc79's harness edit applied for the bundle build only, then restored; the export still matches 099db6ce
  blob for blob) has the same slope, 0.356 MB per epoch (0.255 late), and ends at 124.6 MB against the ledger's
  125.1. The residual slope is common to both paths and is not this track's.
- The stage-1 run has the same rows per client at every checkpoint, the same 96 and 291 passes, the same writes and
  the same 7 declines, and no ledger record. Its retention passes took p50 515.4 ms (creator) and 536.9
  (recipient), against the ledger run's 312.6 and 320.6. The two runs are not a pair and ran at different loads, so
  this is direction only (§8 has the paired numbers).

## 10. Canvas and Chat

Track M's long-room harness (`tests/fixtures/track-m-apps/`, `TRACK_M_APPS=1`), unchanged. Data in
`<evidence>/track-m2/apps/`.

**Node, fake-indexeddb, the room host with retention, 16 epochs** (`bin/apps.sh`): Canvas (receive-only and
Writer recipient) and Chat (Writer and receive-only), each with the shipped lull and the reader lull: 8 cases per
tree. Both trees ran at the same time (load 20–48), the ledger tree (f30bad5a) and Track O's export (stage 1).

- 8 of 8 pass on both trees.
- **Rows: identical.** Track M's `rowdiff.py`: 0 differences in every store's rows per role, per stage (installed,
  lulled) and per epoch, and 0 differences in lull kinds, over all 16 epochs of all 8 cases.
- `tests/track-m2-ledger-apps.test.ts` (Canvas, reader lull, shadow): the ledger decision equals stage 1's at every
  compared boundary, and the applied twins hold equal row counts per store (`logs/apps-1.log`).

Latency, p50 over epochs ≥ 5, stage 1 → ledger (`apps/treelat-1.txt`; fake-indexeddb under load, so only
direction):

| Case                         | Seal        | Creator lull | Recipient lull |
| ---------------------------- | ----------- | ------------ | -------------- |
| Canvas receive-only, shipped | 1431 → 1668 | not run      | 539 → 232      |
| Canvas receive-only, reader  | 452 → 428   | 1162 → 919   | 461 → 200      |
| Canvas Writer, shipped       | 1568 → 1603 | not run      | 775 → 481      |
| Canvas Writer, reader        | 431 → 467   | 1008 → 922   | 609 → 463      |
| Chat receive-only, shipped   | 1190 → 1057 | not run      | 578 → 210      |
| Chat receive-only, reader    | 558 → 427   | 1206 → 599   | 687 → 238      |
| Chat Writer, shipped         | 963 → 1041  | not run      | 588 → 247      |
| Chat Writer, reader          | 440 → 472   | 913 → 563    | 644 → 267      |

- The recipient lull is 0.35–0.76 of stage 1's in all 8 cases.
- With the shipped lull the shipped apps have no ordinary resource bound, so the creator lull is
  `deferred:unsupported` and the creator's retirement runs inline at seal, on stage 1: the ledger is consulted only
  in the lull. Seal is unchanged there (0.89–1.17). Track Q gives these creators a bound, after which they take
  the lull path.
- The Canvas creator lull shrinks less (0.79, 0.91) than Chat's (0.50, 0.62). Track M measured the Canvas
  creator's lull growing with its unbounded issuance (Track M §11); that cost is not retention's and is Track P's.

**Chromium, real IndexedDB** (`tests/fixtures/track-m-apps/browser/`, `bin/pwapps.sh`, one interleaved ABBA pair:
ledger, stage 1, stage 1, ledger; load 39–156): Canvas receive-only and Chat Writer, reader lull, 16 epochs, room
host with retention. Each tree's bundle is built from that tree. All 8 runs pass (2 cases each).

- **Rows: identical** in both pairs (0 row and 0 lull-kind differences over 16 epochs; `apps/pw-treelat.txt`).
- p50 over epochs ≥ 5, stage 1 → ledger, pair 1 / pair 2:

| Case                | Creator lull          | Recipient lull        | Seal                  | Adoption              | Creator issue per move |
| ------------------- | --------------------- | --------------------- | --------------------- | --------------------- | ---------------------- |
| Canvas receive-only | 936 → 626 / 905 → 725 | 429 → 164 / 431 → 162 | 319 → 303 / 306 → 308 | 566 → 522 / 554 → 594 | 428 → 404 / 390 → 426  |
| Chat Writer         | 602 → 377 / 605 → 375 | 556 → 202 / 483 → 197 | 260 → 254 / 265 → 254 | 741 → 879 / 743 → 739 | 402 → 480 / 533 → 470  |

- Creator lull 0.62–0.80, recipient lull 0.36–0.41 in both pairs. Seal, adoption, install and issue have no
  direction.

## 11. Guarantees G1–G28

Status of each guarantee on the opt-in retention path with the ledger. "Unchanged" means the ledger does not touch
the mechanism that keeps it, and the evidence is the existing suites and native tests passing as on Track O's head.

| G   | Short name                                               | Status    | How, and evidence                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | No growth with room age                                  | Held      | Ledger bounded by window and byte cap; 17.4 KB per role, flat (§8.5). 100 epochs: rows flat on every client, latency slopes about 0, heap slope equal to stage 1's under the same harness option (§9).                                            |
| G2  | Backpressure before exhaustion                           | Unchanged | No admission or capacity rule touched.                                                                                                                                                                                                            |
| G3  | Golden path incl. crash recovery                         | Held      | Every Grid run passes (8 ledger runs at 8 rollovers, 2 at 100); 14f on three engines incl. SIGKILL at every split point with the trapped boundary decided by the ledger (§6); Track O's tests (§7).                                               |
| G4  | No resurrection of terminal sessions                     | Unchanged | The ledger is released with its plane and forked only on a genuine handoff; a released ledger refuses records.                                                                                                                                    |
| G5  | Durable bytes untrusted; reverified on every open        | Held      | Facts enter only from a complete verification (open) or fresh openings; every use is an exact key match; poison, key mismatch and rollback RED tests (§4).                                                                                        |
| G6  | Whole-origin rollback not prevented by same-origin state | Unchanged | The ledger is memory only and is never persisted; reopen is cold.                                                                                                                                                                                 |
| G7  | One retirement decision owner                            | Held      | Same classifiers and O's one-decision builder; shadow oracle equal at every compared boundary; Grid decisions identical (§5, §8.5).                                                                                                               |
| G8  | Watermarks and deletion are not authority                | Unchanged | The ledger holds no marks; a retired identity reappearing declines (rollback).                                                                                                                                                                    |
| G9  | Each owner rechecks its monotone facts before deleting   | Unchanged | Step B unchanged.                                                                                                                                                                                                                                 |
| G10 | Only immutable syntax and signed facts outlive a stage   | Held      | Keys are digests of exact records without state; trusts are the genuine objects opening produced; no currency, control, census, floor, accounting or authority (§3.1). One ledger per plane chain; reopen and non-genuine activation start empty. |
| G11 | Currency reuse only inside the same held transaction     | Held      | Every currency fact is read at the boundary and re-checked by step B in its own transaction; the ledger holds none.                                                                                                                               |
| G12 | Foreign READWRITE natively excluded                      | Unchanged | Step A and step B unchanged; 14f case 3 passes on three engines.                                                                                                                                                                                  |
| G13 | Web Locks advisory only                                  | Unchanged |                                                                                                                                                                                                                                                   |
| G14 | One bounded resumable intent                             | Held      | No transaction, decision or durable resume record added; Track O's split points resume with the ledger deciding (split test, one-unit 14f cases 5–8 at continuations 1–3 on three engines).                                                       |
| G15 | Crash atomicity: old XOR new                             | Held      | 14f cases 5–8 on three engines (§6).                                                                                                                                                                                                              |
| G16 | Strict durability everywhere                             | Unchanged | 14f case 2 asserts strict durability.                                                                                                                                                                                                             |
| G17 | No resurrection of old writers                           | Unchanged | 14f case 3.                                                                                                                                                                                                                                       |
| G18 | Protected set                                            | Held      | Protected union computed by the original rules every boundary; survivors checked exactly in step B; decisions identical to stage 1.                                                                                                               |
| G19 | Issuance retention                                       | Held      | Issuance selection unchanged (from the sealed census bytes); Track N's cold recipient drain matches in the settlement differential and Track N's test passes.                                                                                     |
| G20 | Snapshot lifecycle                                       | Unchanged | Snapshot turnover selectors unchanged.                                                                                                                                                                                                            |
| G21 | Bounded work                                             | Held      | Window 8 epochs, byte cap 256 KiB; the planner reads at most what stage 1 reads (fake-indexeddb counters halve).                                                                                                                                  |
| G22 | Proof budget: full charges, no refunds                   | Held      | The planner charges every byte it reads into a fresh book and declines over budget before its plan; step B keeps its own; a ledger hit credits nothing (RED budget test).                                                                         |
| G23 | Ingress queues FIFO during a deferrable lull             | Unchanged | Same lull slot; concurrent-mode Grid runs pass with every move admitted.                                                                                                                                                                          |
| G24 | Startup floor is an expectation, never repaired          | Unchanged | Floor read fresh every boundary; a pending floor declines to stage 1.                                                                                                                                                                             |
| G25 | Authenticated migrations                                 | Unchanged | No format or migration change; inherited classification declines to stage 1.                                                                                                                                                                      |
| G26 | Latency never justifies relaxing safety                  | Held      | No verification removed: the newest epochs are re-authenticated every boundary, replays require exact keys, step B is unchanged, and every mismatch falls back to the complete cold acquisition.                                                  |
| G27 | No game-specific carve-outs                              | Held      | One code path; Grid, Canvas and Chat (§10).                                                                                                                                                                                                       |
| G28 | Native requirements need native evidence                 | Held      | 14f on Chromium, Firefox and WebKit with SIGKILL (§6).                                                                                                                                                                                            |

## 12. What remains before the default flip, and risks

**Before the default flip:**

1. **The lull target.** Steady creator lull 442 ms and recipient lull 252 ms against ≤ 100 (stretch ≤ 20). In order
   of size, what is left in the creator's lull (§8.2):
   - Readiness capture, ~160 ms. Outside 14b; a ledger-fed capture needs its own slice (§8.3).
   - The planner's read pass, ~125 ms. Most of it re-opens the two newest closed epochs and their certificate with
     the original `authenticate`, and reads each currency fact once. Two ways to cut it, both new design decisions:
     record the newest epoch's facts at arrival (the capture points in PLAN §3, which move CPU into seal and
     install), and share one read pass with step B (one transaction per epoch, §3.8, which changes Track M and O's
     step-B plumbing in storage-browser).
   - Step A and step B ~30, plan ~25, the dependency hold ~13 and ~64 ms of the lull's own work: unchanged here.
2. **Seal-time retention is still stage 1.** The ledger is consulted only in the lull. A creator without an
   ordinary resource bound (the shipped Canvas and Chat today) retires inline at seal on the cold path, so its seal
   does not improve (§10). Track Q's bound moves those creators to the lull.
3. **Lull-mode seal and adoption.** Slower with the ledger in all three LULL=1 pairs (seal ×1.04–1.54, adoption
   ×1.03–1.14), with no direction in concurrent mode. Neither path runs ledger code. Needs a quiet paired check, for
   example with a fixed idle gap after each lull, before the flip.
4. **Merge order.** This branch is Track O on Track M; it merges with them. Track P may change
   `creatorFilteredIssuanceStore` in VL; this track touches other VL functions (§Files), so only textual conflicts
   are possible.
5. **The residual heap slope.** 0.36 MB per epoch on both stage 1 and the ledger once the harness keeps only the
   named proof events (§9). It still includes the harness's spans. A run that also stops retaining spans, or a heap
   snapshot diff between two late checkpoints, would attribute it.

**Risks:**

- **Two assemblers of the same classifier inputs.** The ledger planner assembles the inputs that stage 1's
  acquisition assembles, and then calls the same classifiers and O's builder. No owner rule is duplicated, but a
  future change to the acquisition must be mirrored in the planner. The shadow oracle catches a divergence as a
  test failure (`__roomRetentionLedgerMode = "shadow"`); the differential tests should stay in CI.
- **Non-genuine in-session activation.** The ledger is forked only in `activateV3LivePlane`'s transport-reusing
  branch; any other activation deactivates the old plane, which releases its ledger. The reopen RED test drives a
  non-genuine activation in the same process; an in-session `recoverSettlementOwner` is covered by the same
  construction but no test drives it.
- **Trust identity.** The ledger holds the genuine trust objects (copies are "foreign" and refused). Releasing the
  ledger with its plane is what ends their lifetime; a leak there would hold small objects, not authority (each use
  still requires an exact key match and step B's re-checks).
- **Fake-indexeddb for the node RED tests.** The native behaviour is covered by 14f on three engines (§6); the
  mechanism counters (`logs/count-*.json`) are fake-indexeddb only.

## Files and functions touched

Product (opt-in retention path only):

- `packages/node/src/internal/room-retention-ledger.ts` (new): `RoomRetentionLedger`, `RoomRetentionLedgerRecord`,
  `RoomRetentionLedgerEpochFacts`, `RoomRetentionLedgerBounds`, `createRoomRetentionLedger`,
  `roomRetentionLedgerRecordBytes`.
- CRD:
  - new: `buildRoomRetentionPassPlan` (stage 1's plan block, moved verbatim so both paths call it),
    `ROOM_RETENTION_LEDGER_LIMITS`, `roomRetentionLedgerMode`, `roomRetentionLedgerLimits`,
    `observeRoomRetentionLedger`, `roomRetentionGenerationKey`, `roomRetentionCutKey`, `roomRetentionExcludedKey`,
    `roomRetentionTrustBytes`, `roomRetentionLedgerCollector`, `roomRetentionRetiredIdentities`,
    `roomRetentionLedgerCommit`, `seedRoomRetentionLedger`, `compareRoomRetentionShadow` (test hook only),
    `RoomRetentionLedgerDecline`, `roomRetentionLedgerDeclineOf`, `roomRetentionLedgerCandidate`,
    `authenticateRoomRetentionExcludedGenerations`, `authenticateRoomRetentionRetainedCuts`,
    `planRoomRetentionFromLedger`, `reconcileRoomRetentionLedgerBoundary`,
    `reconcileCreatorRoomRetentionFromLedger` (exported), `reconcileCreatorReceivedRoomRetentionFromLedger`;
  - changed: `applyRoomRetentionPass` (reports `acquisition`; records or drops the ledger), `RoomRetentionPassPlan`
    (`acquisition`, `ledger`), `roomRetentionTestMode` (optional store), `observeRoomRetention`,
    `planRoomRetentionBesideExistingPass`, `reconcileSnapshotRecoveryRoles` (calls the builder and seeds),
    `reconcileCreatorReceivedSnapshotRecoveryRoles` (the recipient's ledger entry).
  - Every new name is outside the source text the pinned node tests read (Track M finding 15); the pinned files
    fail exactly as on base (`logs/pinned-2.log` against `logs/pinned-base.log`).
- VL: `V3PlaneRegistration.roomRetentionLedger`; `deactivateRegistration` (release); `activateV3LivePlane` (fork on
  the transport-reusing handoff only); `resolveRecoveryCloseHold` (`captureRoomRetentionLedger`).
- `packages/node/src/internal/runtime-reclamation.ts`: optional `captureRoomRetentionLedger?(create)` on
  `CreatorSnapshotRecoveryCloseLifetime`.
- `packages/node/src/creator-close.ts`: `bindCreatorLiveClose`, in the creator lull's readiness maintenance: the
  ledger attempt before the original maintenance run.

Tests (new files): `tests/track-m2-ledger-red.test.ts`, `tests/track-m2-ledger-differential.test.ts`,
`tests/track-m2-ledger-split.test.ts`, `tests/track-m2-ledger-apps.test.ts`.

Harness (measurement only): `tests/fixtures/track-m/native/worker.ts` (`SLIM` keys);
`tests/fixtures/startup-discovery/critical-observer.ts`, `healthy-grid.ts`, `r8-source-binding.pw.ts`
(`STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS`).

Not touched: storage, storage-browser, storage-node, protocol formats, governance pins, frozen artifacts, registries,
vectors, existing RED or governance tests, Track O's signing control, summary source and resume code,
`creatorFilteredIssuanceStore`, `docs/realtime-latency/README.md`.
