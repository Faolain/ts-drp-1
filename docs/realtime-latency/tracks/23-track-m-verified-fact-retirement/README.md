# Track M: verified-fact retirement (slices 14b and 14e)

**Outcome:** Landed with Track O in merge 8c61863e (a301cbe0..07849f85): 14b stage 1 and 14e, opt-in via `roomRetention: true` on the room-database host; creator lull 2441 -> 623 ms, recipient 1253 -> 466 ms. Its 14f case 8 (a crash between its two decisions halted maintenance) was fixed by Track O before the merge. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 03:53 UTC)

Track M: make recovery-pool maintenance take milliseconds by implementing slice 14b (retirement decided from verified facts carried in memory) and slice 14e (bounds and charges), on Track R3's room-database executor. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track.

WHY
- Transitions no longer stall: seal ~220–350 ms, adoption ~430–590 ms. Moves are visible in 1–9 ms with the presentation overlay.
- But each epoch's background maintenance (the "lull") still takes 2.1–2.8 s on the creator and ~1.0–1.4 s on recipients. Durable admission waits behind it.
- Track E proved the cost is architectural. Each epoch runs four passes that re-acquire and re-authenticate the whole recovery state (~45% of a lull), plus the two-phase commit steps, the verifyCompleted readbacks and the drains.
- Track R3 built the single room database and a one-transaction session executor (slice 14a stage 1a). It is correct, but it saved only 3–9%, because every per-pass re-proof is still there.
- Slice 14b is the fix the specs call for:
  - decide retirement from facts verified on arrival and on every open;
  - keep those facts in one bounded in-memory ledger per room session;
  - check exact bytes inside the acting transaction;
  - run one retirement per epoch as one room transaction.
- Targets on the Grid, LULL=1, 8 rollovers:
  - creator lull maintenance per epoch ≤ 100 ms p50; stretch ≤ 20 ms.
  - Track R2's prototype measured retire p50 ~7 ms and verify-on-open 6–7 ms; Track E modelled 2.5 ms.
  - Readiness capture (~200–270 ms) is outside retirement. Say what it costs after your change, and whether 14b also lets it shrink.

READ FIRST, in the repository on branch codex/phase3a1b-p6-golden-path:
- specs/bounded-storage-lifecycle/golden-path-guarantees.md: G1–G28, the safety bar. No trade for speed (G26).
- specs/bounded-storage-lifecycle/slices/14-single-database-watermark-retirement.md and 14a–14f. 14b and 14e are your contract.
  - 14b defines: the threat model; where authority comes from (arrival verifiers, open verification by `acquireClosedData`); what the ledger may hold (immutable syntax and signed facts only, keyed by the exact bytes they were verified from); what it must never hold (currency, controls, census, floor state, accounting, authorization); the decision; and the in-transaction checks.
  - Follow its "Runnable RED and acceptance" and "Feedback and stop conditions" sections exactly.
- docs/realtime-latency/README.md and tracks/14 (Track E's root cause), 18 (Track R), 20 (Tracks R2 and R3, including R3's RESULT.md), 21 (Track K), 22 (Track L): what has been decided, and why.
- R3's working notes: <evidence>/track-r3/ (PROGRESS.md, map-*.md, grid/, bin/), where <evidence> = <evidence>.

BASE
- Your worktree starts at codex/phase3a1b-p6-golden-path HEAD: 9ae59c2e, which includes Track R3.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. Plan. Write <evidence>/track-m/PLAN.md:
   - which planner paths in packages/node/src/internal/creator-closed-rollback-data.ts (CRD) and the creator, recipient and lull callers change;
   - what moves into the ledger, with its capture point per arrival verifier;
   - how the open verification seeds the ledger;
   - how one transaction per epoch is reached on R3's session.
   Map each step to the 14b and 14e requirements and to the guarantees.
2. RED tests per 14b and 14e requirement, committed before the code that turns them green. Include adversarial cases:
   - poisoned or rolled-back durable bytes after a fact was ledgered;
   - a ledger fact whose stored bytes no longer hash to its key;
   - a session reopened with no carried facts;
   - a fact crossing a non-genuine handoff;
   - over-budget charges, which must refuse before the first delete.
3. Implementation, on the opt-in room path (room host / STARTUP_HEALTHY_GRID_ROOM_DATABASE=1).
   - The default six-database path must behave exactly as before.
   - Every decision the ledger path makes must be one the existing planner would make. Prove this with a differential test against the existing planner on the same inputs, including seeded random histories.
   - Deleting something the existing planner keeps is a stop condition.
4. Evidence:
   - 14f cases that cover the single retirement transaction, on Chromium, Firefox and WebKit;
   - SIGKILL inside and around the one transaction, using the death harness pattern of packages/storage-browser/tests/phase-3a1b-p4-browser-live-journal-death-red.pw.ts.
5. Benchmark: at least 3 interleaved ABBA pairs, base (room path at 68b4168e, or 9ae59c2e which differs only in docs) vs yours, for LULL=1 and LULL=concurrent, 8 rollovers. Report per transition:
   - creator and recipient lull maintenance;
   - seal, adoption and install;
   - per-move durable latency during the lull;
   - longest main-thread task per window.
6. Commit your RESULT.md into docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/, with local paths written as <evidence>/…. Keep <evidence>/track-m/PROGRESS.md current throughout.

NOT IN SCOPE (later tracks): wiring 14c into the node, 14d migration of existing rooms, and flipping the default. Note anything you learn that affects them.

PARALLEL WORK
Track N is fixing recipient issuance growth (3 issued + 3 outbox rows per epoch; a G1 issue) on the shared path, on its own branch. It touches issuance retention, which your ledger also covers.
- Don't fix the growth yourself.
- Keep your issuance handling compatible with "issuance retention is bounded".
- You will rebase onto N when it lands.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a requirement cannot be met without weakening a guarantee, stop that step, record the counterexample, and hand back.
- `pnpm -r typecheck` must stay at 0 errors. Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-m/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`.
  - It reads canonical, storage, storage-browser and compaction from dist. Rebuild them per variant, and build protocol-v3 before compaction.
  - Run recipe and summary script: docs/realtime-latency/README.md "Reproducing the benchmark"; <evidence>/track-k/bench/summary.py.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`. Many RED and governance tests already fail on this branch, so compare per test against base.
- Node has no Web Locks: room-host node tests install a FIFO lock manager, as R3's tests do.
- The machine is heavily loaded (load average 20–250). Make timing claims only from interleaved pairs. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- Per requirement: test and status.
- A G1–G28 table, each with status and evidence.
- Results of the differential test against the existing planner.
- Per-engine results, including SIGKILL.
- Benchmark tables against base.
- What remains for the default flip, and the risks.

### Follow-up instruction — Tell Track M: Track N landed, rebase (2026-10-20 05:43 UTC)

Track N has landed: codex/phase3a1b-p6-golden-path is now 7464f875. Rebase your branch onto it at your next safe point (between commits, not mid-step).

What N changed (9ae59c2e..7464f875):
- packages/node/src/v3-live.ts, `cleanupCreatorSettlementSuccessor` only. Cold material (a Writer recipient, which never closes, so `certifiedRecoverySourceGenerations` is undefined) used to return at the cold-roles guard. It now continues only when its completed AHE retirement decision matches the issuance control's completed decision: same throughEpoch, decisionDigest and sourceProofDigest, and no pending generation drain. It then reaches only the existing coordinated branch, `pruneAuthenticatedSettledPrefix`, never generation reclamation. Its scan stops at the first row admitted after that decision's throughEpoch and at the first non-published row. Warm (creator) material is unchanged. Result: every recipient is flat at 13/13 issuance rows from epoch 5 through 16 on both the default and the room path (I re-verified the room path at 16 rollovers).
- New test: tests/recipient-long-room-issuance-retention-native.test.ts (2 tests, 16 epochs, native SQLite).
- Grid harness: the proof-event budget now scales with rollovers, max(50,000, 4,000 × (rollovers + 1)), and it is asserted per role. 16-rollover Grid runs now pass the `proofEventsTruncated === false` check.

What this means for you:
1. The recipient drain depends on the recipient's completed AHE decision and its completed issuance decision matching. If your 14b path changes how either is recorded, the drain fails safe (it keeps everything) and the growth comes back silently on that path. After rebasing, re-run Track N's test, and run one 16-rollover room-path Grid with LULL=1. Check recipient issuance stays flat with <evidence>/track-n/bin/issuance_series.py <run dir>.
2. If your ledger decides issuance retirement, its decisions must still match the existing planner's, including this cold-recipient drain. Add it to your differential test.
3. A conflict is possible only if you edit `cleanupCreatorSettlementSuccessor`. If you do, keep N's restrictions exactly.
4. You can now run 16 rollovers for your long-room evidence (14f case 11).

Use 7464f875 as the base for your ABBA pairs as well (room path). Base timings at 68b4168e are no longer the right comparison, because N changes what recipients do at the end of each activation.

### Follow-up instruction — Tell Track M: rebase onto 5c6b949d (2026-10-20 05:44 UTC)

Correction to the rebase target: codex/phase3a1b-p6-golden-path is now 5c6b949d. That is 7464f875 plus one docs-only commit, which edits docs/realtime-latency/README.md and adds tracks/24-…/README.md. Rebase onto 5c6b949d so your branch can fast-forward later. Don't edit docs/realtime-latency/README.md yourself; I maintain it. Only commit your RESULT.md under tracks/23-track-m-verified-fact-retirement/.

### Follow-up instruction — Tell Track M: Canvas/Chat checks and 100-epoch run (2026-10-20 07:59 UTC)

Additional request from the user for the end of your track. Don't change your current plan; do these after your own Grid checks pass.

1. Run your checks for Canvas and Chat as well as the Grid.
   - At minimum, run their native tests before and after your change, comparing per test against base:
     - tests/r9-canvas-receive-only-native.test.ts
     - tests/v3-canvas-equivalence.test.ts
     - tests/r9-chat-capacity-room-native.test.ts
     - tests/r9-chat-metadata-native.test.ts
     - tests/r9-chat-role-network-native.test.ts
     - tests/r9-chat-shipping-room-native.test.ts
   - Also run a long-room check per application: store rows stay flat from the first steady epoch to epoch 16, following the pattern of tests/recipient-long-room-issuance-retention-native.test.ts.
   - Canvas and Chat may use profiles other than the Grid's settlement-v1. Track N's recipient drain is in the settlement (frontier) branch of `cleanupCreatorSettlementSuccessor`. Check whether their recipients stay flat, on both base and your branch.
   - If Canvas or Chat grows with room age, that is a finding. Record it with numbers, and don't fix it in this track.
   - tests/fixtures/startup-discovery/shipped.ts already builds Canvas and Chat rooms in the browser harness. If a browser run for them is cheap to add, do it as a measurement-only commit; otherwise say what it would take.
   - Report latency (seal, adoption or install, lull maintenance, per-move) for Canvas and Chat wherever the harness can measure it.

2. If it makes sense once your change is green, do a 100-epoch endurance run and record the metrics.
   - The Grid harness only accepts 4, 5 or 8–32 rollovers (tests/fixtures/startup-discovery/r8-source-binding.pw.ts:178). Allowing 100 is a measurement-only harness change: put it in its own commit and keep every per-transition assertion. N's proof-event budget already scales with rollovers.
   - Measure per transition:
     - seal, adoption and install;
     - creator and recipient lull maintenance;
     - per-move durable latency;
     - longest main-thread task;
     - per-store rows and bytes per client at each checkpoint (flatness);
     - heap or memory if it is observable.
   - Look for any trend across epochs (a slope), not just medians.
   - Do it on the room path, and on the default path if time allows.
   - The spec's continuous-endurance requirement is slice 10 / R10 (specs/bounded-storage-lifecycle/requirements-to-evidence.md:372). It asks for ≥100 continuous transitions, exact world/ACL/authority/history/op digests, storage saturation and late-window post-GC slopes. Report which of those your run does and does not show. A diagnostic run does not close R10, so don't claim it does.
   - If a 100-epoch run isn't sensible yet (for example, too slow on this machine, or blocked by something else), say why and what it would need, rather than forcing it.

Put both in your RESULT.md, in their own sections.

### Report returned by the agent (2026-10-20 12:22 UTC)

#### Track M final report (14b stage 1 and 14e on the opt-in room path)

**Bottom line**
- The opt-in room path now retires each boundary with verified retention decisions. The creator lull is about 4x faster: 2441 → 623 ms with LULL=1.
- The ≤ 100 ms target is **not** met.
- **One crash case (14f case 8) breaks G3 and G14 on the opt-in path**, in all three engines. It is recorded with its counterexample and not fixed, per the stop rule. It blocks any default flip.
- The ledger (stage 2) is designed but not built.
- The default host is unchanged. No suite has new failures against base.

**Where things are**
- Worktree: `<worktree agent-a6747ca659c74d66c>/`, branch `worktree-agent-a6747ca659c74d66c`. Nothing was pushed. README.md was not edited.
- Result: `<worktree agent-a6747ca659c74d66c>/docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/RESULT.md` (prettier-clean; local paths are written as `<evidence>/…`).
- Progress: `<evidence>/track-m/PROGRESS.md`. All evidence is under `<evidence>/track-m/`.
- Every commit ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the brief requires (not the reminder's "(1M context)" variant).

##### Commits (oldest first, on top of base 5c6b949d)
| Commit | Kind | What |
| --- | --- | --- |
| a301cbe0 | RED | 14b and 14e RED tests and fixtures, committed before the code |
| 51d007eb | product | 14b stage 1 and 14e on the opt-in path, `createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })` |
| de1d64cc | test | Settlement-room differential, including Track N's cold recipient drain |
| 9514ff21 | measurement only | The Grid allows up to 128 rollovers |
| 55dbf18a | product fix | Retention formats move to `@ts-drp/storage/room-head` (the root keys are pinned); the AHE census uses only governed IDB calls |
| 05b5d706 | measurement only | Delivery and proof-event telemetry scale for runs over 32 rollovers |
| 8fd92c99 | test | 14f native harness (`tests/fixtures/track-m/native/`) |
| da3704ac | measurement only | Canvas and Chat long-room harness, gated by `TRACK_M_APPS=1` |
| 8a09ceb8 | product fix | Pinned-source node tests pass again (details below) |
| 07849f85 | docs | RESULT.md |

**The 8a09ceb8 fix (new since your last update).**
- An interim node-suite run had 14 new failures:
  - 3 in `creator-closed-rollback-proof-accounting.test.ts`;
  - 11 in `creator-ordinary-readiness-producer.test.ts`.
- Cause: these tests take the source text of original functions and run it with fixed bindings, or count call sites. Stage 1 had put new identifiers and edited conditions into that text, and added a third `compareClosedGenerationSources` call.
- No test was edited. The opt-in code moved out of that text with the same behaviour:
  - The activation `resumeCheckpoint` is restored byte for byte. The opt-in reopen rule is decided once at activation (`roomRetentionCompletedBoundary`) and carried as a `roomRetentionResumeControl` identity marker.
  - The retention lookup now runs after the acquisition prefix.
  - The retention readback bracket is a separate branch; the original branch is unchanged.
  - Each later AHE unit is now chosen by the existing `classifyClosedGenerationSource` on the previous unit's post-image.
- After the fix, every check was rerun:
  - node suite: 0 new failures;
  - Track M plus Track N tests: 38/38;
  - all 14f cases on three engines;
  - a 16-rollover Grid run.

##### Requirements (§4)
| Requirement | Status |
| --- | --- |
| 14b RED 1: poisoned or rolled-back bytes; a fact whose bytes no longer hash to its key | pass (12 tests) |
| 14b RED 2: foreign writer between decision and step B (4 tests) | pass |
| 14b RED 3: stale writers refuse with the existing codes | pass |
| 14b RED 4: reopen with no carried facts verifies at open first | pass |
| Forged non-genuine handoff | refuses with zero writes |
| 14b RED 5: differential | pass |
| 14b RED 6: long room | pass; SQLite journal test 2/2 |
| 14b RED 7: Grid acceptance | pass (8 rollovers ×6, 16, 100, and 16 at 8a09ceb8) |
| 14e RED 1–4: cap 512 with continuations, budget, charges before the first delete with no refunds, census bound+1 | pass; over-budget refuses before the first delete |
| 14e RED 5 | not run (belongs to 14d) |

- Before the code: 30 of 32 failed on base.
- At 8a09ceb8: the 5 Track M files plus Track N's test and the journal test pass 38/38 (`logs/trackm-pins-2.log`).

##### Differential
- No decision ever deleted a row the existing planner keeps.
- Coverage:
  - Canvas room, 16 epochs, creator and recipient;
  - seeded random histories 1 and 2;
  - Grid settlement room, 16 epochs, with a Writer recipient (Track N's cold drain).
- Issuance protected holes equal the existing planner's. Applied issuance rows are identical on both paths (26 per peer).
- Only gap: retention keeps one more recipient journal header (one-lull lag; 125 vs 124 rows, flat).
- The differential compares deleted rows, not controls or the states between decisions. Case 8 lives in that gap.
- It passes again at 8a09ceb8.

##### 14f native evidence at 8a09ceb8 (digest e61ac279; real SIGKILL via the death-harness pattern)
| Case | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Smoke, 2 (refusal and native abort), 3, crash-free reference | pass | pass | pass |
| 5, SIGKILL inside step A | pass | pass | pass |
| 6, SIGKILL after A, before B | pass | pass | pass |
| 7, SIGKILL inside step B | pass | pass | pass |
| **8, SIGKILL after B** | **counterexample** | **counterexample** | **counterexample** |
| 11, long room, 16 epochs | pass | not run | not run |

- Case 8 reproduced 15 times in total (development runs, 8fd92c99 and 8a09ceb8).
- What happens:
  - D1 commits: it retires epoch 3's evidence and completes the signing control `{throughEpoch 5, protectedEpochs [4,5]}`, with no summarySource or drain.
  - D2, which would retire epoch 3's signerState and votes, never runs.
  - The next acquisition throws `UNCLASSIFIED_SIGNING_DEPENDENCY:3` (seal/src/creator.ts:775).
  - Readiness capture then refuses `internal-invariant` (CRD acquireCreatorIssuanceMaintenanceProof), and the creator's maintenance stops.
- Old XOR new holds per transaction, and nothing is deleted wrongly.
- Fix options, none tried:
  - (a) D1 writes the existing summarySource / eligibility-fence form;
  - (b) one decision per epoch for evidence and summaries; needs a 14b spec change;
  - (c) use `authenticateClosedSigningSummaryEpoch`, with differential proof.
- A D2 refusal after D1 commits likely leaves the same state. Not tested.

##### G1–G28 (opt-in path; the default host is unchanged)
- **Not held:** G3 (crash recovery) and G14 (one resumable intent), both from case 8.
- **Partial:**
  - G15 held per transaction;
  - G21 held, but the 512-write cap is pending review;
  - G28 provided, with case 8 failing.
- **Not exercised:** G25 (14d is out of scope).
- **G1:** held to 100 epochs on the Grid. Canvas issuance grows on every path, base included; this is pre-existing.
- **All others held.** G26: nothing was traded for speed.

##### Benchmark vs base
Setup: 3 interleaved ABBA pairs per mode, 8 rollovers, Chromium, built at 51d007eb. Base = 5c6b949d room path. Steady medians in ms.

| Window | LULL=1 base → HEAD | concurrent base → HEAD |
| --- | --- | --- |
| Seal | 276 → 278 | 317 → 300 |
| Creator adoption | 506 → 503 | 596 → 589 |
| Recipient install | 343 → 347 | 447 → 428 |
| Creator lull | **2441 → 623 (0.26)** | **2743 → 715 (0.26)** |
| Recipient lull | **1253 → 466 (0.37)** | **1456 → 588 (0.40)** |

- **Per-move latency during lulls:**
  - moves issued during a creator lull reach the other peers in 1914 → 493 ms (p50);
  - during a recipient lull, 970 → 329 ms;
  - recipient-lull issue p50 went 102 → 122 ms (n = 30). Re-measure before the default flip.
- **Longest main-thread task:** no window gains one; maxima are within 3 ms of base.
- **Where the creator's ~400 ms retention pass goes:** about 282 ms is the cold acquisition. Plan, floor fence and step B take about 107 ms.
- **Readiness capture:** about 130 ms, unchanged by stage 1, and not shrunk by it.
- **Stage 2 estimate:** about 107 ms with the ledger, 55–60 ms with one read pass.
- The 16-rollover run at 8a09ceb8 shows the same creator lull (577–625 ms) and recipient issuance flat at 13 rows from epoch 6 through reopen.

##### Suites (§9; 8a09ceb8 unless noted)
| Set | Base passed/failed | Branch passed/failed | New failures |
| --- | --- | --- | --- |
| node | 1023/48 | 1023/48 | 0 |
| root | 669/345 | 678/336 | 0 (9 codec RED tests pass that failed on base) |
| sb | 621/4 | 621/4 | 0 |
| snr | 158/49 | 158/49 | 0 |
| obs | 23/0 | 23/0 | 0 |
| Six Canvas and Chat native tests | 35/15 | 35/15 | 0 |

- `pnpm -r typecheck`: 0 errors.
- Shadow guard: clean.

##### Canvas and Chat (§11)
- Default hosts give identical rows and bytes for 16 epochs on base and the branch.
- With retention, seal and lulls in Chromium are 0.26–0.41 of the room path.
- **Pre-existing G1 gap:** Canvas issuance grows +1 row per move on every path, including base. Issue latency grows with it (O(outbox) in the `creatorFilteredIssuanceStore` wrapper). Recorded, not fixed.
- The shipped apps' creator lull is always `deferred:unsupported`, so their retirement runs inline at seal.
- Chat is flat.

##### Endurance (§12): 100 rollovers, concurrent moves
- **Room path with retention:** passed every check in 1,132 s.
  - Window medians: seal 357 → 335 ms, creator lull 912 → 872, recipient lull 765 → 660.
  - Creator adoption has the only positive slope: +0.67 ms/epoch.
  - Rows are flat from epoch 8 to 100 on every client.
  - Heap grows 0.89 MB/epoch, mostly attributable to the harness's 428k retained proof events (not separated).
  - One long task in 500 windows.
- **Default host:** also passed.
  - Creator lull is about 3.4–3.8 s. Remote admission during creator lulls is 2.8–3.3 s, against 0.4–0.5 s with retention.
- **R10:** 100 continuous transitions and flat storage are shown. Not shown: per-transition digest ledgers, storage saturation, and fresh-process post-GC ceilings. R10 is not closed.

##### What remains for the default flip, and risks
1. Fix case 8. Then re-run 14f case 8 on all three engines, and add a test that refuses D2 after D1 commits.
2. Stage 2 (the ledger).
3. 14c and 14d wiring.
4. Review of the 512-write cap.
5. Re-measure recipient-lull issue latency, and the heap in a fresh process.
6. Owners of the source-pinned node tests must review them: a default flip changes the code those tests treat as the original.

**Risks.**
- Every split boundary (two decisions, or continuations over the cap) needs crash tests *between* its transactions, not only inside them.
- The differential must keep running so the retention selection keeps matching the owner rules.
- Grid evidence is Chromium only.
- Readiness capture becomes the largest part of the creator lull after stage 2.
