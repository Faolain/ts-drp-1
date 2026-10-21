# Track U: seal and adoption after a ledger lull, and the residual endurance heap growth

- Worktree: `<worktree agent-a4a865e0207f6cab8>/`, branch `track-u-lull-seal-and-heap`, from
  `codex/phase3a1b-p6-golden-path` at **e0494c5a** (Track M2 merged). Nothing was pushed.
- Working notes: `<evidence>/track-u/PROGRESS.md`. Grid runs: `<evidence>/track-u/grid/`. Heap diffs:
  `<evidence>/track-u/heap/`. Canvas and Chat: `<evidence>/track-u/apps/`. Suite reports:
  `<evidence>/track-u/tests/`. Logs: `<evidence>/track-u/logs/`. Scripts: `<evidence>/track-u/bin/`.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
- "Stage 1" is 093a367f (Track M's retention decision with a cold acquisition per boundary, Track P merged). "The
  ledger" is e0494c5a (Track M2's verified-fact ledger). Pairs are A = stage 1, B = the ledger.
- **No product code changed.** Every commit is a measurement-only harness option, off by default.
- Main has since moved to 725f291b (Tracks P, M2, T, S and Q merged). None of them touches Track U's harness
  files. The comparison base stays e0494c5a.

## 1. Outcome in brief

- **Q1: seal is not slower with the ledger, and neither is the work in adoption. M2's observation was noise,
  apart from a few milliseconds of LevelDB cleanup that moves from seal into adoption.**
  - 18 new interleaved ABBA pairs with LULL=1 (8 rollovers, room database with retention), plus 3 concurrent
    pairs. Builds are from exported trees, checked blob for blob.
  - Pooled with M2's 3 pairs (21 LULL=1 pairs), the median per-pair ratio is 0.98 for seal (main-thread CPU 0.99)
    and 1.03 for adoption (main-thread CPU 0.99). The ledger was slower in 6 of 18 new pairs for seal and 11 of 18
    for adoption.
  - Adoption is the weaker case. Its wall time was longer on the ledger in all 6 pairs with a 2 s gap (×1.11),
    but shorter in 4 of 6 with a 500 ms gap and in 3 of 6 with no gap. The extra time is idle and IndexedDB
    wait at equal CPU, at the same two transitions where the other sets show the opposite sign.
  - Main-thread CPU in seal and adoption is equal. The IndexedDB request count per adoption is equal (~4,900).
    Wall-time differences come from idle and IndexedDB wait, and they change sign between sets.
  - M2's overlap hypothesis is rejected. The lull ends 0.8–1.1 s before the next seal in both trees. A fixed idle
    gap of 500 ms or 2 s before each seal does not move seal in either tree. No IndexedDB work from the lull is
    still running at seal start that differs between trees.
  - The only systematic difference is where some LevelDB cleanup tasks run. At transitions 6 and 7, part of the
    cost moves from seal to adoption. Totals are equal (85.3 vs 85.2 ms per run), with the same number of tasks at
    the same offsets. This comes from the LevelDB files on disk, not from the ledger's code.
  - The lull speed-up holds in every pair: creator lull ×0.67–0.75, recipient lull ×0.46–0.51.
  - The library does not need to finish the lull's IndexedDB work before it reports the lull done. No change is
    proposed.
- **Q2: the residual heap growth is the harness, bounded library caches that are still filling, and V8. No
  library growth with room age was found.**
  - Slope on e0494c5a, 100 rollovers, concurrent moves, room database with retention, M2's proof-event kinds:
    **0.353 MB per epoch (late 0.248)**. This is M2's result (0.356 / 0.251).
  - With the harness's other per-epoch records counted instead of kept: **0.189 MB per epoch (late 0.082)**.
    Harness records were 0.164 MB per epoch of the 0.353.
  - Heap snapshots at adopted-50 and adopted-90, with records counted: the JS heap grows 80 KB per epoch.
    - **53 KB is four bounded library caches still filling**: the transition memo 29, trust-record verdicts 20,
      the ed25519 verify memo 3 and the closure-digest memo 1.
    - **About 17 KB is V8's optimized code.**
    - **About 11 KB is harness telemetry** that counted mode still keeps.
  - Every library cache has a fixed ceiling:
    - the canonical hash memo is full by epoch 50 (about 37 MB per realm, 3.9 MB of it JS heap);
    - trust-record verdicts fill at about epoch 106;
    - the ed25519 memo and the transition memo fill at about epoch 190.
  - None of them grows with room age past its ceiling, so G1 holds. How big the ceilings should be is a
    memory-budget question; §6 gives the options.
  - Default six-database path (no room database, records counted): passes 100 rollovers on the game's side.
    Slope **0.141 MB per epoch (late 0.078)**, rows flat. The JS heap grows 71 KB per epoch between e50 and e90,
    with the same caches, the same harness telemetry and less optimized code. The run is marked failed only
    because of a harness check after the game: none of M2's room-path proof-event kinds occurs on the default
    path (§4.4).
  - Canvas and Chat (Track M's browser long room, 40 epochs): the JS heap grows 0.04–0.14 MB per epoch late in the
    run, from the same caches filling. Canvas's legacy-profile issuance rows grow 4 per epoch (1.6 KB of
    IndexedDB per epoch) by design; no heap grower tracks them. Chat rows stay flat. Both apps' snapshot chunks
    grow 1.1–1.7 KB per epoch: that is application state (the messages and strokes the driver adds), not protocol
    overhead.
- **Pre-existing failure found on the way (not Track U, not M2):** with 4 rollovers, concurrent moves and room
  retention, the persisted reopen refuses with "creator snapshot role reconciliation refused: floor-stale". It
  fails on stage 1 too. 8 and 100 rollovers pass (§5).

## 2. Commits

| Commit   | Kind             | What                                                                                                                                                                                                                                                                               |
| -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6f1db125 | measurement only | `STARTUP_HEALTHY_GRID_SEAL_IDLE_GAP_MS`: a fixed idle wait before each seal, as its own `test-only-seal-idle-gap` span. Unset, no wait.                                                                                                                                            |
| c5175a0d | measurement only | `STARTUP_HEALTHY_GRID_HARNESS_RECORDS=counted`: every realm counts spans, per-owner proof summaries, startup trace events, the parent's per-move, per-checkpoint, per-snapshot and per-transition records and the transport fixture's per-message records instead of keeping them. |
| 9986a215 | measurement only | `STARTUP_HEALTHY_GRID_HEAP_SNAPSHOTS=<labels>`: after that checkpoint's forced GC, a V8 heap snapshot of the renderer goes to `STARTUP_EVIDENCE/heap-<label>.heapsnapshot`.                                                                                                        |
| acc6a2a2 | measurement only | `STARTUP_HEALTHY_GRID_TASK_TRACE_CATEGORIES`: extra categories for the whole-run task trace (for example `IndexedDB`).                                                                                                                                                             |
| 470392f2 | measurement only | Track M apps browser long room: `TRACK_M_APPS_HEAP=1` (forced-GC used heap per page per epoch in the JSONL) and `TRACK_M_APPS_HEAP_SNAPSHOTS=<epochs>`.                                                                                                                            |
| RESULT   | docs             | This file.                                                                                                                                                                                                                                                                         |

Each option builds on M2's (`critical-observer.ts`, `healthy-grid.ts`, `r8-source-binding.pw.ts`). With the option
unset, every record and assertion is as before. With `counted`, the spec checks the same facts through the counts
(transitions = rollovers, ordinary moves = 8 × rollovers + 4, one snapshot per rollover, transport bytes > 0).

## 3. Q1: seal and adoption in LULL=1 mode

### 3.1 Method

- Bundles: `grid/s1-1` (stage 1, from `git archive 093a367f`) and `grid/led-1` (the worktree at 9986a215). The
  three bundled harness files are the same in both. `bin/verifybuild.py s1-1 led-1`: the bundle inputs differ
  only in M2's 4 node files and the new ledger module (`<evidence>/track-u/grid/verifybuild-s1-1-led-1.txt`).
- Healthy native Grid: 4 clients, 8 rollovers, room database with retention, task trace on. Pairs run in ABBA
  order. The load average was recorded at the start and end of every run.
- Per seal, adoption, install and lull window (`bin/tu_trace.py`), from the whole-run task trace:
  - renderer main-thread task wall and CPU (`ThreadControllerImpl::RunTask` dur and tdur);
  - browser IndexedDB tasks, split into request processing (`bucket_context.cc`), LevelDB scope cleanup
    (`leveldb_scopes.cc`, posted by Commit) and compaction (`env_chromium.cc`);
  - the gap from lull end to the next seal, and the IndexedDB work in that gap.
- Steady state is t3 onwards. Medians are over transitions per run, then over runs per tree. "B>A" counts the
  pairs where the ledger was slower.

### 3.2 Results (wall and main-thread CPU, ms)

| Set (pairs)             | Window   | Wall A → B (ratio, B>A)   | Main-thread CPU A → B (ratio, B>A) | Idle A → B (ratio, B>A)   |
| ----------------------- | -------- | ------------------------- | ---------------------------------- | ------------------------- |
| M2's traces, LULL=1 (3) | seal     | 288.1 → 303.1 (1.05, 3/3) | 210.4 → 220.8 (1.05, 2/3)          | 72.4 → 81.5 (1.12, 3/3)   |
| M2's traces, LULL=1 (3) | adoption | 556.0 → 573.1 (1.03, 3/3) | 429.4 → 424.6 (0.99, 1/3)          | 117.3 → 148.3 (1.26, 3/3) |
| ab1 LULL=1 (6)          | seal     | 321.2 → 311.8 (0.97, 1/6) | 216.3 → 221.3 (1.02, 3/6)          | 97.0 → 79.0 (0.81, 3/6)   |
| ab1 LULL=1 (6)          | adoption | 564.8 → 548.7 (0.97, 3/6) | 417.1 → 420.4 (1.01, 2/6)          | 136.3 → 121.0 (0.89, 3/6) |
| gap 500 ms LULL=1 (6)   | seal     | 343.1 → 349.2 (1.02, 2/6) | 227.5 → 225.1 (0.99, 2/6)          | 101.4 → 117.3 (1.16, 3/6) |
| gap 500 ms LULL=1 (6)   | adoption | 640.7 → 635.1 (0.99, 2/6) | 454.8 → 445.2 (0.98, 1/6)          | 175.6 → 185.8 (1.06, 5/6) |
| gap 2 s LULL=1 (6)      | seal     | 335.2 → 326.6 (0.97, 3/6) | 221.2 → 223.1 (1.01, 1/6)          | 102.8 → 95.9 (0.93, 3/6)  |
| gap 2 s LULL=1 (6)      | adoption | 615.1 → 682.3 (1.11, 6/6) | 448.1 → 452.4 (1.01, 2/6)          | 158.1 → 213.6 (1.35, 5/6) |
| ab1 concurrent (3)      | seal     | 328.8 → 289.3 (0.88, 0/3) | 216.8 → 212.2 (0.98, 0/3)          | 77.2 → 76.7 (0.99, 1/3)   |
| ab1 concurrent (3)      | adoption | 594.3 → 655.5 (1.10, 2/3) | 484.6 → 477.3 (0.98, 2/3)          | 134.3 → 150.1 (1.12, 2/3) |

Lulls, every set: creator lull ×0.67 (ab1), ×0.70 (gap 500 ms), ×0.75 (gap 2 s); recipient lull ×0.47, ×0.46,
×0.51. The ledger was faster in every pair.

Load (1-minute average, start → end of each run; `grid/bench-*.out`):

- ab1: 6–143. Pair 4 is flagged: led-4 39 → 143, s1-4 142 → 124. It is the only ab1 pair where the ledger was
  slower in both seal (×1.14) and adoption (×1.18).
- gap 500 ms: 25–140. Pair 4 is flagged: led-4 140 → 107, s1-4 87 → 114.
- gap 2 s: 11–120. Pair 3 is flagged: led-3 106 → 120, while s1-3 started at 28. That pair has the largest
  adoption ratio (×1.23).
- ab1 concurrent: 9–39.

Without the flagged pairs (`grid/cmp-*-nop*.txt`), the seal ratio is 0.97 (ab1), 0.98 (gap 500 ms) and 0.94
(gap 2 s). The adoption ratio is 0.97, 0.98 and 1.04, with the ledger slower in 5 of 5 pairs in gap 2 s.
Main-thread CPU ratios are 0.97–1.01.

### 3.3 Where the wall-time differences come from

- **Main thread.** Seal and adoption main-thread CPU agree within 2% in every set. The number of renderer tasks
  and of IndexedDB requests per adoption are equal.
- **Idle and IndexedDB wait.** The wall differences are idle time (no main-thread task running). In gap 2 s, the
  ledger's adoption excess is at transitions 6 and 7 only (+108 and +114 ms per run). It is time with neither a
  main-thread task nor a browser IndexedDB task running, plus IndexedDB-only time (`bin/tu_adopt.py`,
  `bin/adopt_by_t.py`). In ab1, stage 1 has the same large gap at t7 instead. In gap 500 ms, the ledger's t6 and
  t7 adoptions are faster (sums 4,422 → 3,908 and 4,219 → 3,760 ms). The cost follows the run, not the tree.
- **LevelDB cleanup placement, the one systematic difference.** IndexedDB commits post LevelDB scope cleanup tasks
  (`leveldb_scopes.cc:297`). Both trees run the same number (813 vs 816 per run) at the same offsets. At t6 and
  t7, the ledger's cleanup in seal is cheaper (t6 about 32 → 21 ms, t7 23 → 18) and its cleanup at the end of
  adoption is dearer (t6 12 → 24, t7 13 → 20). Seal plus adoption is equal (gap 500 ms: 85.3 vs 85.2 ms per
  run; `bin/scopes_by_t.py`, `bin/scopes_tasks.py`). Per-task cost depends on the LevelDB files' state on disk,
  and the two trees leave different files after their different lulls. It is a few milliseconds, it does not
  change the total, and it is not code in seal or adoption.
- **No overlap with the lull.** Lull end to seal start is 0.8–1.1 s in both trees (ab1 912 vs 880 ms). The
  cleanup work in that gap is the same (pre-seal scope cleanup wall 26.5 vs 24.5 ms). The IndexedDB-category
  traces (2 pairs, gap 2 s) filled the trace buffer by t5 and have no events inside the cleanup tasks, so they
  add nothing.
- **No ledger code in seal or adoption.** The ledger runs only in the lull path
  (`reconcileCreatorRoomRetentionFromLedger`, from `runOrdinaryReadinessMaintenance` in creator-close.ts) and in
  its fork on handoff (v3-live.ts). Seal and adoption call the same functions in both trees.

V8 CPU profiles of seal and adoption (step 3 of the brief) were not taken, because the difference does not
survive: main-thread CPU is equal and the wall difference changes sign between sets.

### 3.4 What the game sees

The ledger's lull is 25–33% faster on the creator and 49–54% on recipients. The next seal and adoption take the
same time as with stage 1, within the machine's noise (±10% per pair at these loads). At transitions 6 and 7,
roughly 7–12 ms of LevelDB cleanup lands in adoption instead of seal. Neither the player nor the total sees a
difference from that.

The library does not need to wait for the lull's IndexedDB work before reporting the lull done:

- that work is over well before the next seal;
- waiting for it would not change what seal and adoption run;
- the cleanup that moves is LevelDB's own, posted by commits in seal and adoption, not by the lull.

Nothing was changed.

## 4. Q2: the residual heap growth

### 4.1 Slopes on e0494c5a (100 rollovers, concurrent moves, M2's proof-event kinds, forced GC per checkpoint)

| Run                                                     | Result                                                   | Heap after GC, MB (e8 / e50 / e100) | Slope MB/epoch (late) | Evidence                                     |
| ------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- | --------------------- | -------------------------------------------- |
| A: room database + retention, harness records kept      | pass, 884 s                                              | 85.8 / 112.6 / 124.9                | 0.353 (0.248)         | `grid/endureA-kinds-snaps-100.txt`           |
| B: room database + retention, harness records counted   | pass, 776 s                                              | 84.5 / 104.5 / 108.5                | 0.189 (0.082)         | `grid/endureB-kinds-counted-snaps-100.txt`   |
| C: default six databases, no retention, records counted | game passes all 100; harness check fails (§4.4), 1,262 s | 83.1 / 99.5 / 103.5                 | 0.141 (0.078)         | `grid/endureC-default-counted-snaps-100.txt` |

- In B, the counted records at e100 in the creator realm were 13,699 spans, 418,945 per-owner proof events,
  3,763 startup trace events and 4,551 transport publications. In the parent, they were 203 checkpoints,
  804 moves, 100 snapshots, 100 transitions and 10,387 spans.
- Store rows stay flat on every client after adopted-8 in A and B. IndexedDB slope is about 0. Each run's retention
  passes all apply (creator 96, recipients 291).
- Latency is not reported from these runs. Counted runs keep no spans, and A's heap snapshots and rising load
  (16 → 58) perturb timing.

### 4.2 Heap snapshots (adopted-50 → adopted-90, one renderer, all five realms)

`bin/heapdiff.mjs` builds the dominator tree for snapshot B and compares the two by node id. Both snapshots come
from the same CDP session, so a node id names the same object in both. "JS heap" excludes ArrayBuffer backing
stores and external strings; it is what the forced-GC heap figure measures. The diff's JS-heap total matches
the forced-GC slope in both runs.

**Run A (records kept), JS heap +0.237 MB per epoch** (`heap/endureA-a50-a90.txt`). Per epoch:

| Grower                                                                                        | KB/epoch (JS heap) | Class   |
| --------------------------------------------------------------------------------------------- | ------------------ | ------- |
| parent `checkpoints` (each checkpoint's per-client measure values, healthy-grid.ts `measure`) | 49                 | harness |
| `spans` in five realms (critical-observer.ts `end`)                                           | 55                 | harness |
| startup `trace` in four realms (observation.ts `event`)                                       | 20.5               | harness |
| transport fixture `publications`, `retainedEvents` and the rest (worker-transport.ts, .logs)  | ~18                | harness |
| parent `ordinary` (7.7) and `transitions` (2.1)                                               | 9.8                | harness |
| `deliveryObservations` (3.7) and per-owner proof summaries (1.5)                              | 5.2                | harness |
| everything in run B's table                                                                   | ~80                | below   |

**Run B (records counted), JS heap +80.3 KB per epoch.** Evidence: `heap/endureB-a50-a90.txt`; per owner
`-owners.txt`; root-dominated strings `-rootstrings-holders.txt`; cache tables `-tablestrings.txt`. With
ArrayBuffer data counted, all memory grows 420 KB per epoch.

Each new object is charged to its nearest dominator that exists in both snapshots, and each freed object is
subtracted the same way. Strings that several realms share have only the root as dominator. They are charged to
the holder of their first retainer. Many cache keys are such strings: the four client realms run in one isolate,
and V8 internalizes Map keys, so one key object can sit in four realms' tables. Per epoch:

| Grower (allocating and retaining code)                                                                                                                                                                                                                                                                                                                                                                                                       | KB/epoch, JS heap (all memory) | Class            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------- |
| `transitionMemo`, set by `inspectCreatorTransitionAdvanceExact` (packages/node/src/internal/creator-transition-advance.ts:1508-1543). Called from creator-adoption.ts, creator-adoption-commit.ts and creator-close.ts. Keeps a private copy of every candidate, material and ACL byte of each successful E→E+1 check, plus a ~2.7 KB key string: 4.41 → 7.97 MB per realm, 2 entries of ~44 KB per epoch. Values 4 × 5.83, shared keys 5.5. | 28.8 (362)                     | library, bounded |
| `trustRecordVerdicts`, set by `isAnchorTrustStateRecordBytes` (packages/protocol-v3/src/index.ts:1176-1203) on every trust-record scan. The keys are canonical record encodings, about 2.8 K characters on average: 0.99 → 1.78 M characters per realm, shared by the realms. Keys 19.1, table 0.9.                                                                                                                                          | 20.0                           | library, bounded |
| ed25519 verify `memo` (packages/protocol-v3/src/internal/ed25519-verify.ts:7-33): 1,053 → 1,893 entries per realm, keys shared                                                                                                                                                                                                                                                                                                               | 3.2                            | library, bounded |
| `closureDigests` (packages/storage/src/values.ts:104-119): 106–206 → 186–366 entries                                                                                                                                                                                                                                                                                                                                                         | 1.0                            | library, bounded |
| Optimized code (InstructionStream, deoptimization data, Code, dependent-code lists): about 7 new code objects per epoch, for functions V8 optimizes late (for example `readRetirementControl`, `unsignedRecordShape`, `validSuccessorBinding`, `settlementFrontiers`, `hashDomain`)                                                                                                                                                          | ~17                            | browser (V8)     |
| Harness: `deliveryObservations` 2.7, `visibleAt` 2.5 (healthy-grid.ts:131, ≤ 8,192), `proofEvents` 1.6 (M2's kinds, budgeted), Playwright's binding callback map in the parent 1.7, `admitted` 1.6 (capped at 1,024 when counted), the transport fixture's `streams` 1.0 (never pruned, .logs/worker-transport.ts)                                                                                                                           | ~11                            | harness          |
| `hashMemo` (packages/canonical/src/internal/codec.ts:1397-1405, LRU in `hashDomain`): 37.4 MB per realm, flat                                                                                                                                                                                                                                                                                                                                | 0 (full)                       | library, bounded |

Sum: 81 KB per epoch against a measured 80.3. No holder in the library grows without a bound. Only the four
realms' module scopes and their transition memos grew by 64 KB or more between the snapshots (retained size of
the same object). Each module scope grew 9.8–11.2 KB per epoch: 5.83 is its transition memo, and the rest is
mostly code newly optimized for its closures.

### 4.3 The bounded library caches, and their ceilings per realm

| Cache                 | Where                                                                         | Bound                                          | Size at e90 (Grid, B)                  | Full at (Grid) |
| --------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | -------------- |
| `hashMemo`            | packages/canonical/src/internal/codec.ts:1397-1405, 1483-1505                 | 32 MiB of hashed parts and 32,768 entries, LRU | 37.4 MB, 3.9 MB of it JS heap          | before e50     |
| `transitionMemo`      | packages/node/src/internal/creator-transition-advance.ts:1388-1396, 1508-1543 | 16 MiB of copied bytes, entry ≤ 4 MiB, LRU     | 7.97 MB + 0.49 MB of keys, 180 entries | about e190     |
| `trustRecordVerdicts` | packages/protocol-v3/src/index.ts:1176-1203                                   | 1,024 entries and 2,097,152 key characters     | 1.78 M key characters, 632 entries     | about e106     |
| ed25519 `memo`        | packages/protocol-v3/src/internal/ed25519-verify.ts:7-33                      | 4,096 entries, message ≤ 256 B                 | 1,893 entries, 0.29 MB of keys         | about e190     |
| `closureDigests`      | packages/storage/src/values.ts:104-119                                        | 4,096 entries of ≤ 64 references               | ≤ 366 entries, 0.09 MB                 | well past e100 |

G1 holds: each ceiling is a constant, not a function of room age. But at their ceilings a client carries about
37 MB of hash memo, 17 MB of transition memo and 2 MB of trust-record keys. The transition memo fills with
E→E+1 checks of epochs the room has left. §6 gives the options. They are a memory-budget decision, so nothing was
changed.

### 4.4 Default six-database path (run C)

The setup is as for run B (concurrent moves, M2's proof-event kinds, records counted, snapshots at adopted-50 and
adopted-90), without the room database or retention. Evidence: `grid/endureC-default-counted-snaps-100.txt`,
`heap/endureC-a50-a90.txt`, `heap/endureC-a50-a90-owners.txt`.

- **The game passes all 100 rollovers:** receipt ok, phase continued-gameplay, epoch 100.
- **Playwright marks the test failed afterwards, because of a harness check.** The spec asserts that at least
  one proof event was retained (r8-source-binding.pw.ts:781). M2's kind list names only kinds that occur on the
  room path, and none occurs on the default path. So the check fails for this configuration, not for the game.
- **Heap after GC:** e8 83.1, e50 99.5, e100 103.5 MB. Slope 0.141 MB per epoch (late 0.078).
- **Rows:** flat on every client after adopted-8. IndexedDB slope about 0.
- **Snapshots:** the JS heap grows 71 KB per epoch.
  - Library caches about 52 KB per epoch: `transitionMemo` 4 × 5.69 plus 5.5 of keys, `trustRecordVerdicts`
    19.1 plus 0.9, ed25519 `memo` 3.2, `closureDigests` 1.0. All are the same as in run B.
  - Harness telemetry about 10 KB per epoch.
  - Optimized code about 10 KB per epoch.
  - The hash memo is full: 36.1–36.2 MB per realm, flat.
- Load rose from 14 to 177 during this run (other tracks), so its 1,262 s duration says nothing about speed.

### 4.5 Canvas and Chat (Track M's browser long room, 40 epochs, heap snapshots at e20 and e40)

Forced-GC used heap per page (MB per epoch, epochs ≥ 8, with the late half in brackets); `apps/e40-*`,
`heap/appdiff-e40-*.txt`, `heap/e40-*-e20-e40.txt`.

| Run (host)                                  | Canvas creator | Canvas recipient | Chat creator  | Chat recipient |
| ------------------------------------------- | -------------- | ---------------- | ------------- | -------------- |
| e40-product (room retention, lull deferred) | 0.160 (0.141)  | 0.107 (0.097)    | 0.166 (0.101) | 0.140 (0.130)  |
| e40-reader (room retention, lulls run)      | 0.167 (0.142)  | 0.107 (0.096)    | 0.169 (0.103) | 0.139 (0.130)  |
| e40-browser (default host)                  | 0.118 (0.039)  | 0.092 (0.069)    | 0.120 (0.049) | 0.127 (0.109)  |

- The snapshot JS-heap delta equals the getHeapUsage delta (for example Chat creator 0.105 MB per epoch).
- Growers between e20 and e40: `hashMemo` still filling (46–85 KB per epoch JS, 0.57–1.0 MB per epoch with its
  ArrayBuffer data; full at about 36–37 MB on the default host's creators), `transitionMemo` 6–11 KB per epoch,
  `trustRecordVerdicts` about 9 KB per epoch (bounded), and the harness's `events` and `track.ports`
  (long-room-core.ts) 3–6 KB per epoch. All library growers are bounded caches.
- Canvas issuance: the creator's issuance rows grow 4 per epoch (8 → 164 at e40; outbox 2 and issued records 2 per
  epoch, 1.6 KB per epoch). This is the shipped legacy profile, by design, and Track T is moving it. No heap holder
  grows with the issuance rows: the Canvas creator's heap slope is within the Chat creator's, whose rows are flat.
- Chat: rows flat on both pages. Snapshot chunk bytes grow 1.7 KB per epoch on the creator and 1.1 KB on the
  recipient (rows constant), and Canvas's the same 1.1 KB. That is the app state the driver adds each epoch.
- The default host's seal is 3.0–3.8 s p50 in these runs, against 0.3–0.8 s with room retention. This was not
  investigated.

### 4.6 What makes up M2's 0.36 MB per epoch

At 100 rollovers with records kept (run A, 0.353 MB per epoch, least squares over e8–e100):

- **Harness records: 0.164** (A minus B; late 0.166).
- **The hash memo filling to its ceiling: about 0.105.** Its JS heap goes from 3.1 MB at e8 (all realms;
  `heap/smoke-counted-8-a4-a8-names.txt`) to 13.3 MB at e50, and stays there. A 10.2 MB ramp over e8–e50,
  flat afterwards, adds 0.105 to a least-squares slope over e8–e100. This is why run B's slope (0.189) is much
  larger than its late slope (0.082).
- **The steady 0.08 MB per epoch of run B (§4.2):**
  - library caches still filling, about 0.053: transition memo 0.029, trust-record verdicts 0.020, ed25519
    memo 0.003, closure digests 0.001;
  - V8's optimized code, about 0.017;
  - harness telemetry that counted mode keeps, about 0.011.

Total: 0.164 + 0.105 + 0.080 = 0.349. The trust-record verdicts reach their ceiling at about e106, and the ed25519
memo and the transition memo at about e190. After that, the snapshots leave about 0.03 MB per epoch: V8's code,
which should level off as the set of hot functions settles, and harness telemetry. No run went past 128
rollovers, so this plateau is projected, not observed.

## 5. Pre-existing failure: 4 rollovers, concurrent, room retention

The first smoke (4 rollovers, concurrent moves, room database with retention) failed in the persisted reopen:
"creator snapshot role reconciliation refused: floor-stale". It failed with harness records counted and kept, on
the ledger (led-1) and on stage 1 (s1-1): `grid/run-smoke-counted-4`, `grid/run-smoke-retained-4`,
`grid/run-smoke-retained-4-s1`, `grid/q2-attempt1.out`. 8 and 100 rollovers pass. It is older than Track U and
M2; it looks like the first-lull reopen problem Track S is working on.

## 6. Options for the cache ceilings (not done)

1. Keep the caches as they are. G1 holds, and a full hash memo is part of what keeps seal and adoption fast.
2. Drop transition-memo entries for epochs the room has left, keeping the current and next boundary. The memo's
   own comment says the verifiers re-inspect the same E→E+1 closures many times within a transition. Entries for
   epochs below the retained cut are probably never hit again, but nobody has measured that. This would hold
   about 2–4 entries (about 0.1–0.2 MB) instead of 16 MiB. It needs a hit-rate measurement per epoch age first,
   then a RED test (WeakRef and forced GC across many epochs).
3. Lower the hash memo's ceiling (32 MiB of parts per realm) after measuring its hit rate per seal and adoption.
   This trades memory against the hashing the memo saves.
4. Lower the trust-record verdict ceiling. It is 2,097,152 latin1 characters, about 2 MB per realm. The key
   must stay the exact record bytes (the code says never a digest or identity), so only the ceiling can change.

Each is a memory-budget decision for the coordinator.

## 7. Suites and typecheck

Track U changed no product code, so the suites run the product at e0494c5a. Track U's sets run in its worktree
(`bin/suite.sh`, Track M2's file lists). The base for the comparison is Track M2's head reports
(`<evidence>/track-m2/tests/head1-*.json`), compared per test with Track N's `vcompare.py`. M2's reports predate
the merge with Track P's line, so they are not exactly e0494c5a. The machine load was 130–260 during these runs,
from other tracks.

| Set                                                   | Base (M2 head1): passed / failed / skipped | Track U head: passed / failed / skipped | New failures | Fixed |
| ----------------------------------------------------- | ------------------------------------------ | --------------------------------------- | ------------ | ----- |
| node (packages/node)                                  | 1021 / 50 / 0                              | 1023 / 48 / 0                           | 0            | 2     |
| root (Track N's root set)                             | 677 / 337 / 24                             | 678 / 336 / 24                          | 0            | 1     |
| sb (storage-browser, storage)                         | 625 / 0 / 0                                | 624 / 1 / 0                             | 1, see below | 0     |
| snr (storage-node retirement and room head)           | 158 / 49 / 2                               | 158 / 49 / 2                            | 0            | 0     |
| obs (startup-discovery observers)                     | 23 / 0 / 0                                 | 23 / 0 / 0                              | 0            | 0     |
| tracks (Tracks K, L, M, N, O, M2 and room retirement) | 116 / 0 / 65                               | 116 / 0 / 65                            | 0            | 0     |

- **sb:** `phase-2e7-publication-component-red.test.ts` timed out at its own 30 s limit at load 225. Run alone it
  passes, 5 of 5 (`tests/rerun-sb-2e7`).
- **Fixed relative to M2's reports:** two tests in `creator-closed-rollback-proof-accounting.test.ts` and one in
  `d110c-0c1f5b0a-settlement-codec-red.test.ts` pass at head. The difference is between M2's run and this one;
  Track U's change cannot cause it. It was not investigated.
- **Load errors:** the same files fail to load as in M2's reports: `creator-ordinary-generation-closure-capacity`,
  `proptest/spawn-scaling`, `protected-recovery-role-node-red`, `r11-real-game-terminal-native` and
  `r9-rpc-v3-room-native`. Both tracks runs end with the same vitest "Timeout calling onTaskUpdate" error.
- **The harness files Track U changed:** seven test files read or import them (`bin/suite.sh harness`). They are
  `healthy-grid-profiler-validation`, `creator-ordinary-readiness-producer`, `phase-4a-v3-live-blueprint-fold`,
  `full-function-transform` and the three observer tests. 147 tests: 143 pass. The 4 failures are the same tests
  as in M2's reports, with the same messages: three in `phase-4a-v3-live-blueprint-fold`, one in
  `creator-ordinary-readiness-producer`. The 11 `full-function-transform` tests have no base in M2's sets, and
  they pass.
- `pnpm -r typecheck`: 0 errors (`logs/typecheck-head.log`). `node scripts/check-shadowed-sources.mjs`: exit 0,
  no findings. Under the startup tsconfig there are 123 tsc errors, none on a line Track U changed
  (`logs/tsc-startup-3.log`). long-room.pw.ts has 0 errors.
- **Tracks P and K tests outside these sets** (`tests/head-pk`):
  - `canvas-long-room-issuance-retention-native.test.ts`: (b) passes and (a) fails on "oldest kept row: expected
    0 to be greater than 0". That is Track P's recorded state at its head: (a) stays RED until Canvas issuance
    retirement is decided.
  - `track-m-canvas-long-room.test.ts` and `track-m-chat-long-room.test.ts` skip without `TRACK_M_APPS`. Track U
    ran Canvas and Chat through the browser long room instead (§4.5).
  - `recipient-long-room-red-symptom-native.test.ts`, named in Track K's result, is not in the tree at e0494c5a.
- Prettier was run on RESULT.md and on long-room.pw.ts.

## 8. Guarantees G1–G28

No product code changed, so every guarantee stands as at e0494c5a. The harness options are measurement only, off
by default, and with them unset every record, assertion and deadline is as before. G1 is the one Q2 bears on:
the growth found is the harness, V8, or library caches with constant ceilings (§4.3).

## 9. What remains, and risks

- The transition memo's plateau was not observed. A run past about 190 epochs would show whether the JS heap
  then flattens to V8's own growth. The Grid harness allows at most 128 rollovers, and Track U did not change that
  limit. A raise was drafted, but it was undone before any run, because it loosens an existing in-page check.
- The V8 code growth (about 17 KB per epoch) is expected to level off but was not followed far enough to show it.
- The default host's seal (3–4 s in Canvas and Chat) and the 4-rollover floor-stale reopen failure are open and
  belong to other tracks. Track S is now merged into main, so the 4-rollover smoke (concurrent moves, room
  retention) is worth rerunning there.
- Machine load during the Q1 runs ranged 6–143. The Q1 conclusion rests on CPU equality and on the sign changing
  between sets, not on any one pair.

## Files and functions touched

All are test harness files; no file in packages/ or examples/ changed. None of Track S's, Track T's or Track Q's
files was touched.

- tests/fixtures/startup-discovery/critical-observer.ts: `harnessRecordsCounted`, `spansCounted`,
  `proofOwnerEventsCounted` (new exports); `end`, `proofEvent`.
- tests/fixtures/startup-discovery/observation.ts: `traceCount` (new export); `event`.
- tests/fixtures/startup-discovery/healthy-grid.ts: `createHealthyGridRole` (`onAcceptedVertex`,
  `drainTransportRecords`, `observer`); the frame message handler (`measure` case); `runHealthyGrid` (`keep`,
  `measure`, the seal idle gap, the receipt).
- tests/fixtures/startup-discovery/r8-source-binding.pw.ts: the healthy native Grid test (harness-records mode,
  `takeHeapSnapshot`, the seal idle gap, extra trace categories, counted-mode checks).
- tests/fixtures/track-m-apps/browser/long-room.pw.ts: `measureHeap`, the per-test CDP sessions, the wrapped
  `drainEvents`, the JSONL `heap` field.
