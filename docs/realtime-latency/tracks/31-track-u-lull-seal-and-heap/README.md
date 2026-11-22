# Track U: lull-mode seal and adoption, and the residual heap slope

**Outcome:** Merged in d60a08af (6f1db125..0711a8fb, measurement only). Seal and adoption are not slower with Track M2's ledger (21 LULL=1 pairs: seal 0.98, adoption 1.03, CPU 0.99), and idle gaps before seal change nothing. The residual heap slope is bounded library caches filling to constant ceilings, V8 code and the harness, not growth with room age. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-21 00:13 UTC)

Your brief is in <evidence>/track-u/BRIEF.md. Read it in full before doing anything and follow it exactly. It holds the whole task, the order of work, the hard rules and the final report format. The task is Track U, which settles two open questions from Track M2:
- whether seal and adoption are really slower with the verified-fact ledger in LULL=1 mode;
- what makes up the residual 0.36 MB per epoch heap growth in 100-rollover runs.

First check that your worktree is at e0494c5a; the brief says what to do if it isn't. Keep <evidence>/track-u/PROGRESS.md current as you go, so the work can resume if you are interrupted.

### Follow-up instruction — Resume Track U after the usage-limit pause (2026-10-21 04:31 UTC)

Resume Track U: you were stopped at 00:09 for a usage limit, and it's safe to continue now.

1. Run `git status` and `git log -1` in your worktree to see what state the stop left.
2. Read <evidence>/track-u/PROGRESS.md (<evidence> = <evidence>).
3. Any benchmark, endurance run or test run that was in flight was killed. Rerun it rather than using partial output. Don't kill processes you didn't start; if leftover workers from your own killed runs are still alive, record them in PROGRESS.md.
4. You were writing RESULT.md §4.6 with a corrected attribution. Finish that, then continue your brief from where PROGRESS.md says you are.

Main is now 725f291b. Tracks P, M2, T, S and Q are merged; none of them touch your harness files. Your base, e0494c5a, stays your comparison base.

### Report returned by the agent (2026-10-21 04:34 UTC)

Track U is done. Seal and the work in adoption are not slower with the ledger, and the residual heap growth is not library growth with room age. No product code changed. 6 commits on branch `track-u-lull-seal-and-heap` (from e0494c5a), not pushed. RESULT is in `docs/realtime-latency/tracks/31-track-u-lull-seal-and-heap/RESULT.md`. <evidence> = <evidence>.

**Resume after the 00:09 stop**
- Worktree state: last commit was 470392f2 and RESULT.md was not yet committed.
- No processes of mine were left running.
- The only run killed by the stop was a short test rerun (Tracks P and K tests). Its partial log is in `<evidence>/track-u/trash/killed-0009/`, and I reran it in full.
- I finished §4.6 with the corrected attribution and committed RESULT.

**Commits** (all measurement only, off by default, harness files only):
- 6f1db125: `STARTUP_HEALTHY_GRID_SEAL_IDLE_GAP_MS` (fixed idle wait before each seal).
- c5175a0d: `STARTUP_HEALTHY_GRID_HARNESS_RECORDS=counted` (spans, proof summaries, trace, the parent's records and the transport records are counted, not kept).
- 9986a215: `STARTUP_HEALTHY_GRID_HEAP_SNAPSHOTS` (V8 heap snapshot at named checkpoints).
- acc6a2a2: `STARTUP_HEALTHY_GRID_TASK_TRACE_CATEGORIES` (extra trace categories).
- 470392f2: Track M apps browser long room, `TRACK_M_APPS_HEAP` / `TRACK_M_APPS_HEAP_SNAPSHOTS`.
- 0711a8fb: RESULT.md.

**Q1: seal and adoption in LULL=1 mode — noise; M2's overlap idea rejected**
- **Setup:** A = stage 1 (093a367f), B = ledger (e0494c5a). Both bundles were built from exported trees, and `verifybuild.py` shows the inputs differ only in M2's files.
- **Pairs:** 6 LULL=1 + 3 concurrent with no gap, 6 LULL=1 with a 500 ms gap, 6 LULL=1 with a 2 s gap. All ABBA, load recorded at start and end of every run.
- **Load:** 6–143 (no gap), 25–140 (500 ms), 11–120 (2 s). One pair per set is flagged for a large load swing.

| Set | Seal wall | Seal CPU | Adoption wall | Adoption CPU |
|---|---|---|---|---|
| no gap | 321.2 → 311.8 ms (×0.97) | ×1.02 | 564.8 → 548.7 ms (×0.97) | ×1.01 |
| 500 ms gap | 343.1 → 349.2 (×1.02) | ×0.99 | 640.7 → 635.1 (×0.99) | ×0.98 |
| 2 s gap | 335.2 → 326.6 (×0.97) | ×1.01 | 615.1 → 682.3 (×1.11, ledger slower 6/6) | ×1.01 |
| concurrent | 328.8 → 289.3 | — | 594.3 → 655.5 | ×0.98 |

- **Pooled 21 LULL=1 pairs (with M2's 3):** median ratio 0.98 for seal and 1.03 for adoption; main-thread CPU 0.99 for both.
- **Where wall differences come from:** idle and IndexedDB wait, not work.
  - Main-thread CPU is equal, and so are task counts and IndexedDB requests per adoption (~4,900).
  - The 2 s set's adoption excess sits at transitions 6 and 7. The 500 ms set shows the opposite sign at those same transitions.
- **The one systematic difference:** LevelDB cleanup tasks (same count, same offsets) move a few ms of cost from seal into adoption at t6/t7. Seal plus adoption is equal (85.3 vs 85.2 ms per run).
- **Overlap ruled out:** the lull ends 0.8–1.1 s before seal in both trees, and the idle gaps don't move seal. The library does not need to finish the lull's IndexedDB work before reporting the lull done; nothing changed.
- **Lull gain holds in every pair:** creator ×0.67–0.75, recipient ×0.46–0.51.
- **Not done:** V8 CPU profiles (brief step 3), because the difference did not survive.

**Q2: what makes up the 0.36 MB per epoch** (100 rollovers, concurrent moves, M2's proof-event kinds)

| Run | Result | Slope (late) |
|---|---|---|
| A: room database + retention, harness records kept | pass | 0.353 MB/epoch (0.248) — reproduces M2 |
| B: same, records counted | pass | 0.189 (0.082) |
| C: default six databases, records counted | game passes 100 rollovers; Playwright fails afterwards on a harness check | 0.141 (0.078); rows flat |

- Run C's failing check (spec line 781) wants at least one retained proof event. M2's kind list names only room-path kinds, so none occur on the default path.
- **Breakdown of A's 0.353:**
  - harness records 0.164;
  - canonical hash memo filling to its ceiling, about 0.105 (3.1 → 13.3 MB JS between e8 and e50, flat after);
  - the steady 0.08 of run B.
- **Heap snapshots, run B, adopted-50 → adopted-90:** JS heap grows 80.3 KB per epoch. Strings shared by the four realms were charged to their holders.
  - **Library, bounded caches still filling (about 53 KB per epoch):**
    - `transitionMemo` 28.8 (creator-transition-advance.ts:1388-1396, 1508-1543; 16 MiB per realm, full around e190);
    - `trustRecordVerdicts` 20.0 (protocol-v3/src/index.ts:1176-1203; 2,097,152 characters, full around e106);
    - ed25519 `memo` 3.2 (4,096 entries);
    - `closureDigests` 1.0 (storage/src/values.ts:119).
  - **Browser:** V8 optimized code, about 17 KB per epoch.
  - **Harness:** about 11 KB per epoch (deliveryObservations, visibleAt, proofEvents, admitted, Playwright callbacks, transport streams).
  - **Run A also keeps:** checkpoints 49, spans 55, trace 20.5, transport records about 18 KB per epoch.
  - **Run C:** 71 KB per epoch, same caches.
- **G1 holds:** every library grower is a cache with a constant ceiling. At their ceilings a client carries about 37 MB hash memo, 17 MB transition memo and 2 MB of trust-record keys. Old-epoch transition entries are probably dead weight.
- **Options, not done** (they are memory-budget decisions): prune the transition memo by epoch, lower the hash-memo ceiling, lower the trust-verdict ceiling.
- **Canvas and Chat** (40 epochs; room retention with lull deferred, with lulls, and default host):
  - JS heap slopes 0.04–0.14 MB per epoch per page late in the run, from the same caches.
  - Canvas issuance rows grow 4 per epoch by design, and no heap holder tracks them.
  - Chat rows are flat.
  - Snapshot chunks grow 1.1–1.7 KB per epoch in both apps: that is app state.
  - The default host's seal is 3–4 s; not investigated.

**Other findings**
- **Pre-existing failure, not Track U or M2:** 4 rollovers with concurrent moves and room retention fail at persisted reopen ("floor-stale") on both trees. 8 and 100 rollovers pass. It's worth rerunning on main now that Track S is merged.
- **Endurance cap left at 128:** I drafted a raise of the Grid cap to 256 rollovers to see the transition memo plateau. Auto mode refused my next step as weakening a test check, so I undid the change before any run, without committing it.

**Suites vs M2's head reports** (load 130–260; M2's reports predate the Track P merge)

| Set | New failures | Fixed |
|---|---|---|
| node | 0 | 2 |
| root | 0 | 1 |
| snr | 0 | 0 |
| obs | 0 | 0 |
| tracks | 0 | 0 (same vitest onTaskUpdate error as M2) |
| sb | 1 timeout at load 225; passes alone | 0 |

- The harness-reading tests (7 files, 147 tests) have the same 4 failures as M2's reports.
- Track P's Canvas test: (b) passes and (a) stays RED, matching Track P's recorded state.
- `pnpm -r typecheck`: 0 errors. `check-shadowed-sources`: clean.

**Guarantees:** no product change, so G1–G28 stand as at e0494c5a. With the options unset, every harness record and assertion is as before.

**What remains and risks:**
- The cache plateau (~e190) is projected, not observed: the harness allows at most 128 rollovers.
- The V8 code growth is expected to level off but was not followed far enough to show it.
- The default-host seal time and the 4-rollover reopen failure belong to other tracks.

**Files touched** (harness only):
- `tests/fixtures/startup-discovery/critical-observer.ts`: `end`, `proofEvent`, new count exports.
- `tests/fixtures/startup-discovery/observation.ts`: `event`, `traceCount`.
- `tests/fixtures/startup-discovery/healthy-grid.ts`: `createHealthyGridRole`, the `measure` handler, `runHealthyGrid`.
- `tests/fixtures/startup-discovery/r8-source-binding.pw.ts`: the Grid test.
- `tests/fixtures/track-m-apps/browser/long-room.pw.ts`: `measureHeap`, CDP sessions, `drainEvents` wrapper.

Evidence: `<evidence>/track-u/` (PROGRESS.md, grid/, heap/, apps/, tests/, bin/).
