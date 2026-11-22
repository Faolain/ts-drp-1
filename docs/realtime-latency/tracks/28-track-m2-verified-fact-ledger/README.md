# Track M2: verified-fact ledger (14b stage 2)

**Outcome:** Merged in e0494c5a (111889d6..262f5fa5, on Track O's 099db6ce). An in-memory ledger of verified facts, one per plane chain and never persisted, lets each retention boundary skip the cold acquisition, with stage 1 as the fallback on any mismatch. Steady lull: creator 632.5 -> 441.6 ms, recipient 490.6 -> 251.9 ms; the <= 100 ms target is not met (readiness capture needs its own slice). Two questions go to Track U. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 16:11 UTC)

Track M2: build slice 14b stage 2, the in-memory ledger of verified facts, on Track M's verified retention path. The goal is millisecond recovery-pool maintenance. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track.

WHY
- Track M built 14b stage 1 and 14e on the opt-in path `createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })`.
  - Creator lull per epoch: 2441 → 623 ms. Recipient lull: 1253 → 466 ms.
  - The ≤ 100 ms p50 target (stretch ≤ 20 ms) is not met.
- Where the creator's ~400 ms retention pass goes:
  - about 282 ms is one cold `acquireClosedData` acquisition per boundary (its currency checks, protected union, role observation and journal classification);
  - about 107 ms is plan, floor fence and step B.
  - Readiness capture is a further ~130 ms, unchanged.
- Track M estimates stage 2 at about 107 ms with the ledger, and 55–60 ms with one read pass. Its design is in its RESULT.md §7 and <evidence>/track-m/maps/arrival-ledger.md.
- Slice 14b (specs/bounded-storage-lifecycle/slices/14b-retention-trust.md) is the contract:
  - Facts are verified on arrival and on every open, and held in one bounded in-memory ledger per room session.
  - The ledger holds only immutable syntax and signed facts, keyed by the exact bytes they were verified from.
  - It never holds currency, controls, census, floor state, accounting or authorization.
  - Exact bytes are checked inside the acting transaction.
  - Follow its "Runnable RED and acceptance" and "Feedback and stop conditions" sections exactly.

READ FIRST
- specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1–G28; no trade for speed, G26), and slices 14, 14a–14f.
- Track M's RESULT.md, on its branch at docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/RESULT.md. Read all of it, especially §3, §5, §6.1, §7, §13 and §14.
- Track M's working notes: <evidence>/track-m/ (PROGRESS.md, PLAN.md, maps/, bin/).
- docs/realtime-latency/README.md and tracks/14 (Track E's root cause) and 20 (R2/R3).
- <evidence> = <evidence>

BASE
- Track M's branch `worktree-agent-a6747ca659c74d66c` at 07849f85, which sits on codex/phase3a1b-p6-golden-path at 5c6b949d.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> worktree-agent-a6747ca659c74d66c`. (`git reset --hard` is blocked.)
- Track M is NOT merged. It has a crash bug, 14f case 8: a SIGKILL between a creator boundary's two decisions, D1 and D2, halts maintenance (G3/G14).
  - Track O is fixing that on the same branch, in parallel.
  - When O lands, the coordinator will tell you to rebase onto it.
  - Stay out of D1 and D2's signing control, summary source and resume code, which O owns.
  - If your design needs to change how a boundary is split into decisions, stop and report before doing it.

ORDER OF WORK
1. Plan. Write <evidence>/track-m2/PLAN.md:
   - what moves into the ledger, with its capture point per arrival verifier and the bytes it is keyed by;
   - how verification at open seeds it;
   - which parts of the cold acquisition it replaces, and which currency, control and census reads must stay per boundary (14b forbids ledgering them);
   - how one transaction per epoch is reached, or why not yet;
   - the ledger's memory bound, its eviction rule, and its 14e charges.
   Map each step to 14b and 14e and to the guarantees.
2. RED tests per requirement, committed before the code. Include adversarial cases:
   - durable bytes poisoned or rolled back after a fact was ledgered;
   - a ledger fact whose stored bytes no longer hash to its key;
   - a reopen with no carried facts, which must verify at open before deciding;
   - a fact crossing a non-genuine handoff;
   - an over-budget ledger or charge, which must refuse before the first delete;
   - ledger eviction under its bound, which must fall back to a cold verified read and never trust a stale fact.
3. Implementation, on the opt-in retention path only.
   - The default host and R3's room path without retention must behave exactly as before.
   - Every decision must equal stage 1's and the existing planner's on the same inputs. Extend Track M's differential:
     - seeded random histories;
     - the settlement room with Track N's cold recipient drain;
     - Canvas;
     - and ledger-path against stage 1.
   - Deleting something the existing planner keeps is a stop condition.
   - Track N's recipient issuance drain depends on the completed AHE and issuance retirement decisions matching. Keep that, and re-run Track N's test.
4. Evidence:
   - 14f cases on Chromium, Firefox and WebKit with Track M's harness (tests/fixtures/track-m/native/), including SIGKILL inside and between every transaction you add or change.
   - Track M's and Track N's tests, and the K, L and R3 native tests.
5. Benchmark at 8 rollovers, LULL=1 and LULL=concurrent: at least 3 interleaved ABBA pairs against Track M's head (stage 1), and one pair against base 5c6b949d on the room path.
   - Per transition, report:
     - creator and recipient lull;
     - seal, adoption and install;
     - per-move durable latency during lulls;
     - longest main-thread task;
     - readiness capture.
   - Say whether readiness capture can shrink too.
   - Then run a 100-rollover endurance run on room plus retention with concurrent moves, as Track M's §12 did (the harness allows up to 128). Report per-epoch slopes, flat storage, and heap.
     - Track M could not separate the harness's retained proof events from product heap. If you can, count or drop harness records in a measurement-only commit.
   - Run Canvas and Chat long-room checks with Track M's harness (tests/fixtures/track-m-apps/, `TRACK_M_APPS=1`).
6. Commit your RESULT.md into docs/realtime-latency/tracks/28-track-m2-verified-fact-ledger/, with local paths written as <evidence>/…. Keep <evidence>/track-m2/PROGRESS.md current.

PARALLEL WORK
- Track O: crash resume on the same branch (above).
- Track P: Canvas issuance growth and O(outbox) issue cost, on the shared path from codex/phase3a1b-p6-golden-path. It may change `creatorFilteredIssuanceStore` in packages/node/src/v3-live.ts and issuance retention.
- Track Q: give the shipped Canvas and Chat creators an ordinary application resource bound, so their lull runs.
- Don't fix their issues. List every file and function you touch.
- Don't edit docs/realtime-latency/README.md.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
  - Some node tests evaluate the original source text of CRD and v3-live.ts functions (Track M's finding 15). Keep new code outside that text.
  - Governance pins the `@ts-drp/storage` root keys, package export maps and each IDB owner's allowed calls (Track M's finding 6).
- If a requirement cannot be met without weakening a guarantee, stop that step, record the counterexample, and hand back.
- `pnpm -r typecheck` must stay at 0 errors. Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-m2/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`.
  - It reads canonical, storage, storage-browser and compaction from dist. Rebuild them per variant; build protocol-v3 before compaction.
  - Run recipe: docs/realtime-latency/README.md. Summary scripts: <evidence>/track-k/bench/summary.py and Track M's <evidence>/track-m/bin/.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`. Compare per test against base.
- Node has no Web Locks: room-host node tests install a FIFO lock manager.
- The machine is heavily loaded (load average 20–250). Make timing claims only from interleaved pairs. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- Per requirement: test and status.
- A G1–G28 table, each with status and evidence.
- Differential results.
- Per-engine results, including SIGKILL.
- Benchmark tables against stage 1 and base.
- Endurance metrics.
- Canvas and Chat.
- What remains for the default flip, and the risks.

### Follow-up instruction — Tell Track M2: Track O landed, rebase (2026-10-20 18:47 UTC)

Track O has finished. Rebase onto its branch `worktree-agent-a5e3fefad3208def1` at 099db6ce at your next safe point (between commits). It isn't merged to the main branch yet: the user must first accept its spec amendment, and I'm verifying it now. Build on it anyway; M and O will merge together.

What O changed (07849f85..099db6ce):
- Spec, 96bc9b3c: amends 14b and 14e. Read specs/bounded-storage-lifecycle/slices/14b-retention-trust.md, "Units and resume (amendment, Track O, 2026-10-20)".
  - Each boundary is ONE decision. Track M's D1/D2 split is gone.
  - One epoch's signing work (its whole evidence and its whole summaries) is one unit, never split.
  - New dependency: an epoch's signing evidence retires before, or with, that epoch's journal prefix, because the evidence classifier admits an epoch only while its prefix is collectible (CRD:10588).
  - Units commit in this order: snapshot turnover, journal headers, signing by epoch, journal prefixes, AHE units.
  - Continuations split only between units. Every committed prefix of continuations must be a state from which the next acquisition reselects the rest, with no durable resume record.
- Fix, 31a274fd and bc193d75:
  - `reconcileSnapshotRecoveryRoles`: decision construction only.
  - `roomRetentionItems`: the unit order.
  - `browserRoomSigningRetentionSection`: a summary key is accepted when its epoch's whole evidence retires in the same section.
  - A local rename to `unitEpochs`. `creator-closed-rollback-proof-accounting.test.ts` requires the name `signingEpochs` to be unique in CRD's source text.
- Tests:
  - tests/track-o-room-retention-resume.test.ts;
  - tests/track-o-room-retention-split.test.ts and -split-recipient.test.ts;
  - 14f harness options `TRACK_O_14F_CONTINUATION=k` and `TRACK_O_14F_ONE_UNIT=1`, which put a kill or refusal between any two units.

What you must keep when the ledger changes where facts come from:
1. One decision per boundary, one epoch's signing work per unit, and the unit order. If your design needs anything else, stop and report before changing it. It would be another 14b amendment.
2. Every split point must stay resumable from a fresh acquisition.
   - Before handing back, re-run Track O's three test files.
   - Re-run the one-unit 14f death cases (5–8 at continuations 1, 2 and 3) on all three engines.
   - Re-run packages/node/tests/creator-closed-rollback-proof-accounting.test.ts.
3. Any transaction or decision you add is a new split point. It needs kill and refusal tests between it and its neighbours, in the same style.

O's lull check: creator lull t5–t8 median 549 ms against Track M's 601 ms in one quiet pair. Use O's head as your stage-1 baseline for the ABBA pairs.

### Follow-up instruction — Resume Track M2 after rate limit (2026-10-20 21:01 UTC)

You were cut off by an API rate limit. It has reset, so continue from where you stopped: you were building the Track O stage-1 baseline from a detached checkout of 099db6ce. Check `git status` and your PROGRESS.md first. The user has accepted Track O's 14b/14e amendment, and I'm merging Tracks M and O once verification finishes. Keep building on O's 099db6ce as before.

### Report returned by the agent (2026-10-20 23:46 UTC)

#### Track M2: slice 14b stage 2, the verified-fact ledger on the room retention path

The ledger is built, committed and verified, and it never weakens a guarantee. On every input compared, its decisions equal stage 1's. It does not reach the ≤ 100 ms lull target: against Track O's head, the steady creator lull drops from 632.5 to 441.6 ms and the recipient lull from 490.6 to 251.9 ms. No stop condition was hit. Track O's structure is unchanged: one decision per boundary, one epoch's signing work per unit, the same unit order. No transaction, decision, split point or durable state was added.

Branch `worktree-agent-a7a653ac48415a524`, based on Track O's 099db6ce, nothing pushed. Every commit ends with your line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The report is `docs/realtime-latency/tracks/28-track-m2-verified-fact-ledger/RESULT.md` in the worktree. Evidence is under `<evidence>/track-m2/` (PLAN.md, PROGRESS.md, logs/, tests/, sub-14f/, grid/, apps/, bin/).

##### Commits
| Commit | Kind | What |
|---|---|---|
| 111889d6 | test (RED) | RED tests and differential, committed before any code |
| 3794be41 | feat | The ledger module, its lifetime in VL, the ledger planner and seeding in CRD, the creator lull entry |
| 42f21f29 | test | Three RED premises corrected and the applied-twins oracle, each checked against stage 1 with the ledger off |
| 1582ef8c | test | Track O's split points on a ledger decision (`track-m2-ledger-split.test.ts`); Canvas (`track-m2-ledger-apps.test.ts`) |
| 84f50751 | fix | Drop the ledger before a refused, failed or short pass reports (14f case 2) |
| f30bad5a | measurement only | The 14f worker keeps `acquisition`, `action`, `source` and `role` of retention events |
| 2908fc79 | measurement only | `STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS`: a Grid realm keeps only the named proof-event kinds and counts the rest. Unset, nothing changes |
| 262f5fa5 | docs | RESULT.md |

##### Design
- **What it is:** one in-memory ledger per plane chain, never persisted.
  - It is created by the first complete verified boundary. It is passed to the next plane only on a genuine handoff (the transport-reusing branch of `activateV3LivePlane`) and released when the plane is deactivated.
  - After a reopen, a startup, an archive restore or a non-genuine recovery there is no ledger, so the first decision is stage 1's.
- **What it holds:**
  - historical generations, keyed by a digest of their exact record without state;
  - retained cuts, keyed by epoch, anchor digest and source key;
  - excluded keys, and the identities the applied decision retired.
  - It also holds the genuine trust objects that opening produced, and charges their bytes.
- **What it never holds:** currency, controls, census, floor, publication state, accounting or authority.
- **What is still read at every boundary:** inventory, floor, the journal, snapshot and floor images, the AHE control, the AHE bounded read, the original `authenticate` of the two newest epochs and their certificate, both dependency borrows, the received certificates and every classifier. Then Track O's `buildRoomRetentionPassPlan` builds the plan and stage 1's unchanged `applyRoomRetentionPass` applies it (step A and step B).
- **Fallbacks:** any mismatch, evicted key, stale or broken chain, rollback, refusal, budget overrun or shape it does not handle falls back to stage 1 for the same boundary.
- **Bounds:** 8 epochs and 256 KiB; on the Grid it stays at 17.3–17.4 KB per role. The planner charges every byte it reads into a fresh proof book and declines before planning if over budget. Nothing is refunded.
- **Not reached:** one transaction per epoch. It would mean changing Track M and O's step-B plumbing in storage-browser.
- **Not wired:** recording facts at arrival. It would move CPU into seal and install.

##### Requirements and tests (all pass)
| Requirement | Test and status |
|---|---|
| Ledger decides with no cold acquisition | red, pass |
| Same decision as stage 1 (shadow, 16 epochs) | red, pass |
| Durable bytes poisoned after a fact was ledgered | red, pass |
| Stored bytes no longer hash to the fact's key | red, pass |
| Store rolled back after recording | red, pass |
| Reopen with no carried facts verifies at open first | red, pass |
| A fact crossing a non-genuine handoff | red, pass (plus the reopen test) |
| Over-budget charge refuses before the first delete | red, pass |
| Ledger over its byte cap is dropped, never trusted in part | red, pass |
| Fact evicted under the window falls back to a cold verified read | red, pass |
| Host without retention creates no ledger | red, pass |
| Track O's split points on a ledger decision | split: 9 pass, 5 skipped (no unit of that kind) |
| Differential: shadow, seeds 1 and 2, settlement, applied twins, Canvas | pass |

##### Differential
- **Node shadow:** decisions equal at every compared boundary, for both roles, on:
  - a 16-epoch room;
  - two seeded random histories;
  - Track N's settlement room, including its cold recipient drain (Track N's test also passes);
  - Canvas.
- **Applied twins:** the same rows per store at every epoch.
- **Grid:**
  - LULL=1: identical decisions at all 19 boundaries in 6 runs, including step B's charged bytes.
  - Concurrent: identical rows deleted per owner and identical writes.
- **Canvas and Chat:** 0 row differences, on fake-indexeddb (8 cases) and in Chromium.
- **Against the existing planner:** Track M's own differential (stage 1 against it) still passes, so the ledger never deletes a row the existing planner keeps.

##### Native 14f (Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5)
- **First chain, at 1582ef8c:** case 2 (refusal) failed on Chromium. The ledger's drop event came between the refused pass and the fallback's decline. 84f50751 fixed it in the product; the test is unchanged.
- **Second chain, at f30bad5a, all pass:**
  - whole file: 9 pass, 1 skip on each engine;
  - Track O's one-unit cases (reference and 5–8) at continuations 1, 2 and 3: 5 pass each, on each engine;
  - case 11 (long room) on Chromium: pass.
- **The killed boundaries were ledger decisions:** in all 48 death cases the killed boundary is the creator's epoch-6 boundary, decided by the ledger. The case 2 refusal and abort also hit a ledger pass.
- **Crash outcomes:** old XOR new in every case, the fence never lags, recovery converges.
- **No new split points:** the planner only reads, and runs before step A.

##### Suites (compared per test with Track O's reports)
- node 1023/48, root 678/336, snr 158/49, obs 23/0: the same as Track O, 0 new failures, after rerunning load timeouts alone.
  - Two tests of `creator-closed-rollback-proof-accounting` timed out in the full run. The file alone gives Track O's result for all 351 tests (331/20).
  - In root, the settlement codec file run alone gives Track O's 9/1.
- sb 625/0: Track O had 624/1. The extra pass is a packaging gate this track does not touch.
- The cross-track set (16 files) all passes, 116 passed and 65 skipped:
  - Track O's three files: 43/60, the same as Track O's own run.
  - Track M's five files, Track N's, K's journal test, L's, and R3's two.
  - Track K's `recipient-long-room-red-symptom-native` is not on this branch.
- `pnpm -r typecheck`: 0 errors. The stale-compiled-source guard passes. New files are prettier-clean. Files that were not prettier-clean before (CRD, VL, creator-close.ts, runtime-reclamation.ts, the three Grid harness files) were left unformatted.

##### Grid benchmark, 8 rollovers
Against Track O's head, 3 interleaved pairs per mode, 12 runs, all pass. Steady medians in ms:

| | LULL=1 stage 1 | LULL=1 ledger | concurrent stage 1 | concurrent ledger |
|---|---|---|---|---|
| Creator lull | 632.5 | 441.6 | 755.2 | 542.3 |
| Recipient lull | 490.6 | 251.9 | 634.2 | 287.5 |
| Creator retention pass | 406.5 | 191.1 | 468.1 | 216.2 |
| Readiness capture | 138.9 | 157.3 | | |
| Seal | 288.1 | 303.1 | 311.4 | 319.5 |
| Adoption | 554.5 | 573.1 | 633.5 | 632.4 |
| Install | 396.8 | 382.9 | 469.0 | 468.8 |

- **Per move, concurrent mode, p50:**
  - creator lull: remote admission 423.9 → 213.9 ms;
  - recipient lull: local issue 121.1 → 78.2 ms, remote admission 406.9 → 116.4 ms.
- **Longest main-thread task:** unchanged.
- **Against base 5c6b949d** (one pair, load 60–90): creator lull 3163 → 670 (LULL=1) and 3083 → 633 (concurrent); recipient lull 1615 → 303 and 1658 → 335.
- **Where the creator lull goes now:** readiness capture ~160, the planner's read pass ~125, step A and B ~30, plan ~25, the dependency hold ~13, and ~64 ms of other lull work.
- **Readiness capture:** it is ~20 ms slower after a ledger boundary, because it now reads cold what the cold acquisition used to warm. It can shrink, but 14b excludes it and its output feeds admission. It needs its own slice; the estimate is 60–90 ms saved.

##### Endurance, 100 rollovers with concurrent moves (all pass)
- **Storage:** rows flat on every client (227/199/207/199); IndexedDB flat.
- **Latency:** slopes about 0 per epoch.
- **Ledger:** decides 383 of 387 passes. The other 4 are each role's first boundary. No drop in 100 epochs; size flat.
- **Heap after forced GC:**
  - all proof events kept: 0.831 MB per epoch;
  - only the named kinds kept: 0.356 MB per epoch (425,636 events dropped);
  - stage 1 with the same option (Track O's export with the three harness files applied only for the bundle build, then restored; it still matches 099db6ce file for file): also 0.356.
  - So the ledger adds no heap growth. The remaining 0.36 MB per epoch is common to both paths and not yet attributed; it still includes the harness's spans.

##### Canvas and Chat (Track M's harness, `TRACK_M_APPS=1`)
- **Fake-indexeddb, 8 cases per tree:** all pass, 0 row differences.
  - Recipient lull falls to 0.35–0.76 of stage 1's.
  - Creator lull falls to 0.50–0.91 with the reader lull.
  - With the shipped lull, seal does not change: the shipped apps have no ordinary resource bound yet, so they retire inline at seal on stage 1 (Track Q fixes this).
- **Chromium, one pair:** Canvas and Chat creator lull 0.62–0.80, recipient lull 0.36–0.41; rows identical.

##### Guarantees
- **Held:** G1, G3, G5, G7, G10, G11, G14, G15, G18, G19, G21, G22, G26, G27, G28.
- **Unchanged** (the ledger does not touch the mechanism): G2, G4, G6, G8, G9, G12, G13, G16, G17, G20, G23, G24, G25.
- None weakened. The per-guarantee evidence table is RESULT §11.

##### What remains before the default flip, and risks
1. **Lull target:** readiness capture needs its own slice. The planner's read pass could be cut by recording facts at arrival, or by one read pass shared with step B; both are new design decisions.
2. **Seal-time retention is still stage 1:** creators without an ordinary resource bound retire at seal on the cold path.
3. **Unexplained slowdown:** in LULL=1 runs, seal (×1.04–1.54) and adoption (×1.03–1.14) were slower with the ledger in all three pairs, with no direction in concurrent mode. Neither path runs ledger code. It needs a quiet paired check before the flip.
4. **Merge:** only textual conflicts are possible with Track P, which edits a different function in VL.
5. **Heap:** the residual 0.36 MB per epoch needs attributing.
6. **Risks:**
   - The planner assembles the same classifier inputs as stage 1's acquisition, so future changes must be mirrored. The shadow differential catches a divergence and should stay in CI.
   - No test drives an in-session `recoverSettlementOwner`.
   - The node mechanism counters are fake-indexeddb only.

##### Files and functions touched
- **New:** `packages/node/src/internal/room-retention-ledger.ts`.
- **CRD, new functions:** `buildRoomRetentionPassPlan` (stage 1's plan block, moved verbatim so both paths call it), `planRoomRetentionFromLedger`, `seedRoomRetentionLedger`, `reconcileCreatorRoomRetentionFromLedger`, `reconcileCreatorReceivedRoomRetentionFromLedger`, the key and charge helpers, and the shadow test hook.
- **CRD, changed:** `applyRoomRetentionPass`, `RoomRetentionPassPlan`, `roomRetentionTestMode`, `observeRoomRetention`, `planRoomRetentionBesideExistingPass`, `reconcileSnapshotRecoveryRoles`, `reconcileCreatorReceivedSnapshotRecoveryRoles`.
  - Every new name is outside the source text the pinned node tests read; the pinned tests fail exactly as at RED-commit time (logs/pinned-2.log against logs/pinned-base.log).
- **VL:** `V3PlaneRegistration.roomRetentionLedger`, `deactivateRegistration`, `activateV3LivePlane`, `resolveRecoveryCloseHold`.
- **runtime-reclamation.ts:** optional `captureRoomRetentionLedger`.
- **creator-close.ts:** `bindCreatorLiveClose`.
- **Tests (new):** `track-m2-ledger-red`, `-differential`, `-split`, `-apps`.
- **Harness (measurement only):** `tests/fixtures/track-m/native/worker.ts`; `critical-observer.ts`, `healthy-grid.ts` and `r8-source-binding.pw.ts` in `tests/fixtures/startup-discovery/`.
- **Not touched:** the storage packages, protocol formats, governance pins, frozen artifacts, registries, vectors, existing RED or governance tests, Track O's signing, summary and resume code, `creatorFilteredIssuanceStore`, and docs/realtime-latency/README.md.
- **Untracked:** the bench inputs in `.logs/bounded-storage-lifecycle/r8-warm-capacity-01/` remain untracked and were not committed.
