# Track Q: Canvas and Chat lull (ordinary application resource bound)

**Outcome:** Merged in 46eb7821 (ff22665c..30937f29, rebased onto 19caa468), after the owner approved both bounds. Canvas and Chat supply their ordinary resource bound, so their creator lull runs instead of inline retirement at seal: seal 0.09-0.12x of base in Chromium (about 0.2 s), adoption +190-255 ms, seal plus adoption 0.32-0.42x. It was held until Track S fixed the reopen bug it exposed. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 16:12 UTC)

Track Q: move Canvas and Chat retirement off the seal path, as the Grid already does, so their seals stop stalling. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track.

THE PROBLEM (Track M's finding 14)
- The shipped Canvas and Chat creators never run their recovery-pool lull.
  - They don't supply `readOrdinaryApplicationResourceBound`, so the creator lull is always `deferred:unsupported`.
  - The creator's retirement therefore runs inline at seal: about 2.7 s per seal on the room path from epoch 5.
- All the latency work so far (the lull API, Tracks A, B, D, H, K, L, R3 and N) helped only the Grid, because the Grid supplies that bound.
- With a measurement-only bound supplied, Track M saw the Canvas and Chat lull run, with seal back off the retirement path.
- Guarantees at stake, from specs/bounded-storage-lifecycle/golden-path-guarantees.md:
  - G21: bounded work, with reviewed limits, not post-hoc constants.
  - G22: proof budget and charges.
  - G23: ingress during a deferrable lull queues FIFO, nothing dropped, provenance rechecked at admission.
  - G27: no game-specific carve-outs.
  - G26: no trade for speed.

READ FIRST
- Track M's RESULT.md §11 and §13, on Track M's branch (not merged). Read it with:
  `git show worktree-agent-a6747ca659c74d66c:docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/RESULT.md`
  Its evidence is in <evidence>/track-m/sub-cc/. Find how Track M supplied its measurement-only bound there.
- Track M's Canvas and Chat measurement harness is commit da3704ac on that branch:
  - tests/fixtures/track-m-apps/;
  - tests/track-m-canvas-long-room.test.ts, tests/track-m-chat-long-room.test.ts.
  - You may cherry-pick or adapt it. Check that it does not depend on Track M's unmerged retention host option; use only what runs on the default host and the room host without retention.
- How the Grid supplies `readOrdinaryApplicationResourceBound`, and what the bound means: who reads it, what it bounds, and which spec or review governs it. Look at R8's ordinary admission and resource bounds in specs/bounded-storage-lifecycle/requirements-to-evidence.md, and at the docs/realtime-latency/README.md track history (Tracks A and B: the lull boundary and FIFO ingress).
- packages/node/src/applications/canvas.ts, examples/v3-chat, and tests/fixtures/startup-discovery/shipped.ts, which builds Canvas and Chat rooms in the browser harness.
- <evidence> = <evidence>

BASE
- codex/phase3a1b-p6-golden-path at 5c6b949d.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. Establish what the bound must express. Write <evidence>/track-q/BOUND.md with:
   - its contract and its consumers;
   - how the Grid's value was derived and reviewed;
   - what the equivalent quantity is for Canvas and for Chat, derived from each application's own semantics and existing reviewed limits (operation sizes, per-epoch caps, capacity ledgers).
   If no principled, reviewable derivation exists for an application, stop that application and report the options. Don't invent a number (G21).
2. RED first, committed before the change: for each of Canvas and Chat, a test that the creator lull runs (not `deferred:unsupported`) and that seal no longer runs retirement inline once the pool is full.
3. Implement each bound with its justification in code comments and commits.
   - Any product-wide bound must be the same rule applied to each application's own reviewed limits, never a per-game carve-out (G27).
   - The Grid's behaviour must not change.
4. Evidence:
   - Canvas and Chat node long-room runs through 16 epochs:
     - lull ran each epoch;
     - seal time no longer includes retirement;
     - moves during the lull are queued FIFO and all admitted (G23);
     - persisted reopen and continued play.
   - Browser runs for Canvas and Chat, if the harness allows: 3 interleaved pairs against base at 8 rollovers, reporting seal, adoption or install, lull, per-move latency and longest task.
   - The six Canvas and Chat native tests:
     - tests/r9-canvas-receive-only-native.test.ts
     - tests/v3-canvas-equivalence.test.ts
     - tests/r9-chat-capacity-room-native.test.ts
     - tests/r9-chat-metadata-native.test.ts
     - tests/r9-chat-role-network-native.test.ts
     - tests/r9-chat-shipping-room-native.test.ts
   - One 8-rollover Grid run with LULL=1 (docs/realtime-latency/README.md recipe) unchanged.
5. Suites: compare per test against base (node; storage-node retirement; root room tests including the K, L, R3 and N native tests). `pnpm -r typecheck` must report 0 errors.
6. Commit your RESULT.md into docs/realtime-latency/tracks/27-track-q-canvas-chat-lull/, with local paths written as <evidence>/…. Keep <evidence>/track-q/PROGRESS.md current.

PARALLEL WORK
- Track P fixes Canvas issuance growth and O(outbox) issue cost, in issuance retention and the `creatorFilteredIssuanceStore` wrapper in packages/node/src/v3-live.ts. Canvas will still grow until P lands, so report Canvas lull cost per epoch and note that growth.
- Tracks O and M2 work on Track M's unmerged retention path.
- Keep your change local to the application resource bounds and their wiring. List every file and function you touch.
- Don't edit docs/realtime-latency/README.md.
- Known pre-existing race (Track M's finding 5): a seal immediately after a received move can fail with NATIVE_READ_RESERVATION_BUSY on fake-indexeddb with a Writer recipient. Track M's fixtures wait 300 ms before each seal. Do the same, and record it if you hit it.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
  - Some node tests evaluate original source text of v3-live.ts functions. If one breaks, keep your code outside that text rather than editing the test.
- If a requirement cannot be met without weakening a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-q/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`. It reads canonical, storage, storage-browser and compaction from dist. Rebuild them; build protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded. Compare per test against base, and rerun timeouts alone. Make timing claims only from interleaved pairs. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- BOUND.md's derivation per application, and its review status.
- RED and GREEN tests.
- The guarantee argument (G21, G22, G23, G26, G27).
- Canvas and Chat seal and lull before and after, from pairs.
- Grid unchanged.
- Per-test suite diff against base; typecheck.
- What remains, and the risks.

### Report returned by the agent

Track Q is built and measured, but don't merge it yet. Canvas and Chat now supply their resource bound, their lull runs, and seal no longer runs retirement inline. One existing test now fails: tests/room-database-retirement-native.test.ts "(4 rollovers)" (Track R3). It passes on base and fails on this branch with `creator snapshot role reconciliation refused: floor-stale`. The cause is a bug in the room code that predates this track, and fixing it is outside the brief's scope (application bounds and wiring). I didn't edit that test, so I'm stopping here with the counterexample.

**The blocking bug**
- A persisted reopen right after the creator's first maintained lull fails with `floor-stale`.
- The check that refuses is in packages/node/src/internal/creator-closed-rollback-data.ts:19350-19351: a stored signing-summary `resumeBasisDigest` differs from the one recomputed on resume. It is reached through `installClosedRetirementSourceInRoom` (:19209) from `reconcileSnapshotRecoveryRoles` (:21826).
- In R3's test (room-database host), it is the first seal after the reopen that throws. On the Node SQLite host, the reopen itself fails, in the startup readiness preparation.
- It is not Canvas-specific:
  - the unchanged Grid composition fails the same way. A copy of Track N's tests/recipient-long-room-issuance-retention-native.test.ts with the reopen moved to epoch 4 reproduces it.
  - Track G already recorded the symptom (docs/realtime-latency/tracks/16-track-g-presentation-overlay/README.md:154).
- Reopening after two or more maintained lulls works: R3's 5-rollover case, and every reopen after epoch 8 in my runs.
- On base, Canvas never ran a creator lull, so R3's test couldn't reach the bug.
- The refusal fails closed, so no guarantee is weakened, but the room stops.
- Whoever fixes the retirement-resume path can use R3's 4-rollover test and the Grid probe as the RED.

Logs: `<evidence>/track-q/logs/rdr-head-1.log`, `rdr-probe-1.log`, `grid-reopen4-1.log`, `reopen4-node-1.log`. The probe test copies are in `<evidence>/track-q/trash/`. `<evidence>` is <evidence>.

**Commits** (branch worktree-agent-afc8a0b30ff709f24, base c67c66b7; the base had moved by one docs-only commit from 5c6b949d)
- 9c0cffaa RED tests
- 0bc1aae5 the two resource bounds
- ef13154a harness fix (moves now really arrive during the lull) and the browser harness
- c47400a7 harness counts every proof-event kind per window
- 60db6bc0 RESULT.md at docs/realtime-latency/tracks/27-track-q-canvas-chat-lull/RESULT.md

**How the bound was derived** (`<evidence>/track-q/BOUND.md`)
- The reader is a planning bound; only the creator gets it.
  - The lull gate, the readiness boundary and the ordinary issue path only check that it exists.
  - Its value is read only on the "prepared" path, which needs `createIncrementalProjection`. Neither app supplies one, so the shipped flows never call it.
  - Its one obligation is to dominate every state the material can produce.
- One rule for every application: the bound covers every state the app's own capture accepts, using only limits that capture already enforces. The Grid's capture has no ceiling, so its bound counts the material. Canvas and Chat each have a fixed ceiling, so their bound is that ceiling.
- **Canvas:** the exact footprint of the widest admitted state (every counter at `CANVAS_LIMITS.maxCounter`), computed under `CANVAS_SNAPSHOT_LIMITS`. 10×10 is {2944 bytes, 817 items, depth 3}; 2×2 is 160/49/3; 64×64 is 118831/32785/3.
- **Chat:** {32768, 16384, 16}, the limits `captureShippingChatCapacityState` enforces. This holds for the shipped composition with its admission policy installed (examples/chat/src/index.ts:291), and the reader's comment says so.
- **Review status:** all inputs are existing reviewed limits. The Canvas widest-state derivation, and the claim that every Chat state passes its capture, are new. Only tests review them so far; both need the owner's review before anything consumes the value.
- examples/v3-chat (the demo) has no ceiling and was left alone.

**Files and functions touched**
- packages/node/src/applications/canvas.ts: `createV3CanvasApplication`; new `resourceDataRecord`, `resourceBoundBases`, `RESOURCE_*_KEYS`.
- examples/chat/src/v3-chat-application.ts: `createShippingV3ChatApplication`, plus the same helpers.
- examples/chat/src/v3-chat-capacity.ts: export `SHIPPING_CHAT_CAPACITY_STATE_LIMITS` (no value change).
- Everything else is new test and fixture files. No Grid, room, existing-test or README edits.

**RED and GREEN**
- tests/canvas-chat-resource-bound.test.ts: 13 tests, all fail on base, all pass now.
- tests/canvas-chat-creator-lull-native.test.ts: 2 tests, both fail on base and pass now. On base every lull is `deferred:unsupported` and the seals at epochs 5–6 run 4 retirement selections each (1.9–4.7 s).
- tests/canvas-chat-long-room.test.ts is the evidence test; it runs only with `CANVAS_CHAT_LULL=1`.
- The first shakeout showed my timer-based delivery never reached the lull: SQLite blocks the event loop during it. Delivery is now triggered from inside the lull by its own retirement-selection event.

**Guarantees**
- **G21:** both values come from limits the apps already enforce. The lull is unchanged, and the seal's inline maintenance stays as the hard-cap backstop.
- **G22:** no charge or budget changed. Retirement work is the same (4 selections per epoch), moved from seal into the lull.
- **G23:** in every epoch whose lull did retirement, the moves were handed over while the lull ran (13/13 per Node run, 5/5 per browser run). All were admitted after the lull, in delivery order, through the normal authenticated ingress.
- **G26:**
  - no check was removed;
  - after each lull, shipped stores hold fewer rows than without the reader, because retirement already ran;
  - Canvas issuance grows identically in both arms (Track P's issue).
- **G27:** one rule; same optional field as the Grid; no app-specific branch and no product-wide constant.

**Before and after (with the reader vs without, interleaved pairs)**

| Measure | Node SQLite, 16 epochs, 2 pairs × 4 cases, reopen after 8 | Chromium, room path, 8 rollovers, 3 pairs |
| --- | --- | --- |
| Seal | 170–307 vs 1548–3987 ms (0.07–0.14×) | 268–322 vs 2639–3260 ms (0.09–0.12×) |
| Seal retirement selections | 0 vs 44 | — |
| Creator lull | 1.6–3.9 s, ran every epoch 4–16 | 2.6–2.8 s |
| Adoption | slower: Canvas 233–532 vs 78–116 ms, Chat 567–998 vs 263–670 ms | about 2× |
| Install | — | unchanged |
| Per-move latency | no direction (0.52–1.50) | 0.78–0.95 |
| Longest task per epoch | — | roughly halved: Canvas 52–54 vs 89–104 ms; Chat 136–156 vs 297–368 ms (max 170 vs 576) |

- Adoption is slower because the cold ordinary-source capture moves from the epoch's first move to the adoption boundary, as the Grid already does. Seal plus adoption is still 2.3–5.1× shorter.
- Moves that arrive during a lull wait for it: p50 1.6–6.9 s, worst 17 s under a load spike.
- After the reopen at epoch 8, play continued in all 16 Node runs. The first seal after a reopen runs 1 retirement selection (vs 4 without the reader).
- Canvas creator outbox grows 13 → 49 rows (epochs 4 → 16) in both arms (Track P).

**Grid unchanged**
- The Grid bundle's sha256 is identical to base's (Track N's final build); neither changed file is a Grid input.
- One 8-rollover LULL=1 run passed with the usual lull pattern. Seal, adoption, install and lull medians are within noise of Track N's run of the same bundle.

**Suites, per test against base**
- Six Canvas/Chat native tests: 35/15 on both, identical (same as Track M's table).
- storage-node retirement: 158/49/2 on both, identical.
- packages/node: 1023/48 on both, identical.
- Root (100 files): 712 pass/333 fail on base, 719/326 at head.
  - 16 newly passing: my 15 RED tests plus one flaky child-process test.
  - 9 newly failing: 8 settlement-codec timeouts at load 155 (rerun alone, those 8 pass and the other 2 fail on base too), and the R3 regression above.
- `pnpm -r typecheck` exits 0 with 0 errors; the shadow guard, prettier and eslint are clean.

**What remains**
- The blocking bug above.
- Higher adoption cost. Avoiding it would be a room change shared with the Grid.
- The one inline selection after a reopen: the lull's early-turnover token is kept only in memory.
- Lull length is Track M/M2's work.
- Supplying `createIncrementalProjection` for Canvas and Chat. It needs per-move evidence and a tighter Chat footprint.
- Chat's bound relies on its admission policy being installed.
- Canvas growth until Track P lands.
- examples/v3-chat would need a material-based bound like the Grid's.

The untracked bench inputs in .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ were copied into the worktree for the Grid run and not committed. PROGRESS.md is current, and the full write-up is RESULT.md.

### Follow-up instruction — Unhold Track Q: rebase onto main 19caa468 (2026-10-21 00:55 UTC)

Track Q is unheld: Track S's fix for the first-lull reopen bug is merged, so rebase your branch onto codex/phase3a1b-p6-golden-path at 19caa468 and finish.

What changed on main since your base (d7f8c39b):
- Track P (a3f3f6b0): a hot successor now wraps its source's native issuance store, so per-move work no longer compounds with room age.
- Track M2 (e0494c5a): verified-fact ledger on the opt-in room retention path.
- Track T (merged before 19caa468): shipped Canvas now signs `creator-trusted-settlement-v1` with a version-3 latched ACL. The single source of truth is examples/canvas/src/profile.ts (`CANVAS_GENESIS_PROFILE`). Track T edited `creatorInvite` in examples/canvas/src/index.ts, and `openRole` in tests/fixtures/track-m-apps/long-room-core.ts. Track P's test is tests/canvas-long-room-issuance-retention-native.test.ts, now with the owner-approved fence count. On settlement, Canvas's creator prunes its settled issuance at adoption (`cleanupCreatorSettlementSuccessor`, about +150-280 ms per adoption, flat). Its lull still reports `deferred:unsupported` without your resource bound.
- Track S (19caa468): `classifyClosedSigningSummaries` in CRD no longer replays a terminal SAME-P signing summary. Its scratch branch `track-s-scratch-q-on-s` showed your four product commits cherry-pick cleanly onto its fix, and that R3's "(4 rollovers)" test and your Canvas/Chat reopen-at-epoch-4 runs pass.

Please:
1. Rebase onto 19caa468 (`git rebase` on your own branch is fine; `git reset --hard` is blocked). Resolve any conflicts with Track T's Canvas changes so that Canvas keeps the settlement profile from examples/canvas/src/profile.ts.
2. Rerun your checks on the rebased branch:
   - canvas-chat-resource-bound, canvas-chat-creator-lull-native, canvas-chat-long-room (including reopen after epoch 4, node and room hosts);
   - room-database-retirement-native (all 4, including "(4 rollovers)");
   - Track P's Canvas test and Track S's test;
   - Tracks K, L, N, M, O and M2's room tests;
   - your suite comparison against the new base;
   - `pnpm -r typecheck`.
3. Re-measure Canvas and Chat seal, adoption, lull and per-move latency in Chromium, base 19caa468 against your head. Canvas now runs the settlement profile, so your earlier numbers no longer describe the shipped app. Report seal and adoption separately, because settlement moved Canvas's pruning into adoption.
4. Your resource bounds need the repository owner's review. In your final report, add a short section, "Bounds for owner review", in plain language. For each app, give the bound's values and how you derived them, what happens when an app exceeds them (refusal, deferral, or something else), and which guarantee each one serves (G21/G22).
5. Update your RESULT.md (folder 27) for the rebased branch and commit it. Then hand back with the commit list, the check results, the latency tables and the bounds section.

All of your brief's hard rules still apply. Don't edit docs/realtime-latency/README.md, and don't touch the main checkout. Tracks U and V are running in parallel. Track V is moving the Grid example and the v3-chat demo to settlement, so stay out of examples/grid and examples/v3-chat. Track U may add measurement-only options to tests/fixtures/startup-discovery.

### Report returned by the agent

#### Track Q: rebased onto 19caa468, checks rerun, result committed

The branch `worktree-agent-afc8a0b30ff709f24` is rebased onto 19caa468, and all requested checks pass. The earlier blocker is gone: R3's "(4 rollovers)" test, Track S's tests, and Canvas/Chat reopen-after-epoch-4 on the node and room hosts all pass. The rebase had no conflicts. Canvas keeps `CANVAS_GENESIS_PROFILE` from examples/canvas/src/profile.ts, and my harness now reads its profile and latched-ACL version from there. No product file changed after the rebase. Nothing was pushed.

##### Commits (19caa468..HEAD)

| Commit | Change |
|---|---|
| ff22665c | test: RED for the Canvas and Chat creator lull |
| 17eb3afa | feat: Canvas and Chat supply their ordinary resource bound (the only product change) |
| 494a1454 | test: deliver lull-time moves inside the creator lull; browser harness |
| 08e416e6 | test: record every proof-event kind per long-room window |
| fafa66c4 | docs: first RESULT.md (now superseded) |
| 74801275 | test: Canvas long rooms use the shipped settlement profile; persisted reopen on every host |
| f4919f12 | test: browser long room can alternate prebuilt base/head bundles (measurement-only env vars) |
| 30937f29 | docs: RESULT.md rewritten for the rebased branch |

All commits end with the requested trailer.

##### Check results

| Check | Result |
|---|---|
| canvas-chat-resource-bound | 13/13 |
| canvas-chat-creator-lull-native | 2/2 |
| room-database-retirement-native | 4/4, including "(4 rollovers)" |
| Track P canvas-long-room-issuance-retention-native | 2/2 (1 measurement test skipped) |
| Track S track-s-first-lull-reopen-native | 6/6 |
| canvas-chat-long-room, reopen after epoch 4 (6 epochs, node + room hosts, both apps, both recipients, with/without the bound) | 16/16 |
| canvas-chat-long-room, 16 epochs, reopen after 8 (node) | 16/16 |
| K, L, N | 2/2, 3/3, 2/2 |
| M room-retention | 34/34 |
| M2 | 25/25 |
| O | 43/43 |
| `pnpm -r typecheck` | 0 errors |
| shadow guard | exit 0 |
| prettier | clean |

**Suites against 19caa468, per test** (the base run writes the three product files at 19caa468 in the same worktree):

| Set | Base pass/fail/skip | Head pass/fail/skip | Per test |
|---|---|---|---|
| Six Canvas/Chat native tests | 35/15/0 | 35/15/0 | identical |
| storage-node retirement | 158/49/2 | 158/49/2 | identical |
| packages/node | 1023/48/0 | 1023/48/0 | identical |
| Root, 117 files (adds the 17 new P/M/M2/O/S files) | 823/332/112 | 838/317/112 | 0 new failures; the 15 that now pass are all this track's RED tests |

**Track M's application long rooms** (`TRACK_M_APPS=1`, measurement tests). Their "product" mode now picks up my bound reader, so I ran them separately at head and base:
- At 6 epochs the outcomes are identical on both trees.
  - Canvas passes on the node, room and room-retention hosts.
  - **Chat fails on the room and room-retention hosts on both trees**, at epoch 3's seal: "creator recovery role transfer source failed: internal-invariant". The failure is inside Track M's harness and is not caused by this track; worth a look by Track M or Track V. My own harness runs Chat with a Writer recipient on the room host without failing.
  - M2's ledger-apps test fails at 6 epochs on both trees only because its thresholds assume 16 epochs.
- At its default 16 epochs, M2's ledger-apps test passes 2/2 at head.

##### Chromium latency: base 19caa468 bundle against head bundle
Real IndexedDB, room path, 8 rollovers, 3 interleaved pairs (head-base, base-head, head-base). 12/12 runs pass, load 10–14, medians over epochs 4–8. Canvas runs the settlement profile. Each cell is head/base for repeats 0, 1, 2, in ms.

| Measure | Canvas, receive-only | Chat, Writer |
|---|---|---|
| Seal | 229/1946, 193/1902, 191/1974 | 195/2065, 214/1930, 201/2063 |
| Seal retirement selections | 0/16 in each | 0/16 in each |
| Creator adoption | 588/360, 571/334, 563/372 | 618/395, 613/358, 601/385 |
| Seal + adoption | 827/2341, 763/2236, 781/2329 | 826/2428, 961/2279, 783/2448 |
| Recipient install | 148/176, 183/152, 159/154 | 252/251, 273/248, 262/247 |
| Creator lull (head only) | 1895, 2031, 1951 | 1894, 1922, 1996 |
| Recipient lull | 760/796, 793/745, 762/873 | 990/918, 952/936, 999/916 |
| Creator issue per move | 213/268, 208/229, 200/255 | 93/104, 94/100, 87/103 |
| Creator admits a remote move | – | 90/107, 97/100, 96/104 |
| Longest task per epoch, p50 (max) | none ≥50 ms at head; base max 66–70 | 128–146 (max 149) vs 280–315 (max 505) |

- **Seal** is 0.09–0.12× of base.
- **Adoption** is 190–255 ms slower (1.5–1.7×). The adoption boundary now runs the cold ordinary-source capture that base runs at the epoch's first move. Track T's settlement pruning is in both arms: base Canvas adoption rose from 202–224 ms before Track T to 334–372 ms now.
- **Seal + adoption** is 0.32–0.42× of base.
- **Per-move latency** ratios are 0.78–1.10, so no regression.

##### Node SQLite, 16 epochs, reopen after epoch 8
Each case compares the shipped composition with the same composition minus the bound reader, which is the base shape. One interleaved pair per case, 16/16 runs pass.
- **Lull:** maintained at epochs 4–16.
- **Seal:** 178–296 ms against 1655–2816 ms (0.08–0.12×), with 0 retirement selections against 44.
- **Adoption:** 459–1026 ms against 284–544 ms; seal + adoption 0.24–0.44×.
- **Moves during the lull (G23):** delivered while the lull ran, then all admitted after it, in order, in 13 of 13 maintained epochs per run.
- **After the reopen:** the first seal runs 1 retirement selection against 4; every later seal runs 0.
- **Growth:** with Track P and settlement landed, the creator outbox stays flat at 18 rows from epoch 8. Total creator rows are flat at 143 against 177.

##### Grid unchanged
- The r8-source-binding bundle has the same sha256 (f0afa06d…) built at base and at head. Its inputs include none of the files this track changed.
- The 8-rollover LULL=1 run passes with the usual pattern: lull deferred at epochs 1–2, not-needed at 3, maintained at 4–8. Medians: seal 330 ms, adoption 528, install 404, creator lull 2701.

##### Bounds for owner review

**What the bound is for.** The creator's lull only runs for an app that supplies an upper limit on the size of any state it can reach (bytes, items, nesting depth). Today the room only checks that the limit exists and never reads its value. A future setup that adds `createIncrementalProjection` would size a reservation from it. So the value must be at least as big as any real state (G22), and must come from limits the app already enforces, not from measurements (G21).

**Canvas** (`createV3CanvasApplication`)
- **Values:** 2944 bytes / 817 items / depth 3 at 10×10. Other sizes: 1×1 is 73/25/3, 2×2 is 160/49/3, 64×64 is 118831/32785/3.
- **Derivation:** a Canvas state always has the same shape (version, width, height, one counter triple per pixel). Only the size of the numbers varies, and the app never admits a counter above `MAX_SAFE_INTEGER` (`CANVAS_LIMITS`). The bound is the exact encoded size of the state with every counter at that maximum. Tests show it equals that widest real state and covers every reachable state. It fits inside the documented `CANVAS_SNAPSHOT_LIMITS`.
- **If exceeded:** no Canvas state can exceed it, because the app refuses other shapes and counters past the maximum. Above 2,045 pixels the bound itself exceeds the room's 16,384-item ceiling; the room then refuses the value and takes its original exact path, which costs only speed.
- **Serves:** G21 (built from existing reviewed limits) and G22 (it covers every reachable state).

**Chat** (`createShippingV3ChatApplication`)
- **Values:** 32768 / 16384 / 16.
- **Derivation:** these are exactly the limits Chat's own state check already enforces (the reviewed 32 KiB retained-state limit), used unchanged and now exported as `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`.
- **If exceeded:** no Chat state can exceed it while Chat's admission policy (`createShippingChatCapacityAdmissionPolicy`) is installed, as the shipped app does. The policy refuses any message that would push state over the limit. A host that drops the policy already breaks Chat's own invariant, and the reader's comment says so.
- **Serves:** G21 and G22.

**Both:**
- Each reader answers only for its own app (exact catalog entry, every stored state passes the app's own check); anything else gets `undefined`, and the room takes the original exact path.
- Neither bound changes a limit, an admission rule, a retirement decision or a proof charge.
- The inputs are existing reviewed limits. The two derivations (Canvas's widest state; "every Chat state passes its check") are new and covered only by this track's tests. They need your review before anything reads the value.

##### What remains, and risks
- Owner review of both bounds.
- Adoption costs +190–255 ms in Chromium and +118–482 ms on the Node host. Removing it would need a change to shared room code (`prepareOrdinaryReadiness`).
- The first seal after a persisted reopen still runs one retirement selection, because the lull's early-turnover token is kept in memory only. This also applies to the Grid.
- The lull takes about 2 s, and moves arriving during it wait. Track M/M2's work is what shortens it.
- The Chat room-host failure in Track M's harness, above.

##### Files
- **Product:**
  - packages/node/src/applications/canvas.ts: `createV3CanvasApplication`, plus new helpers `resourceDataRecord`, `resourceBoundBases` and three `RESOURCE_*_KEYS` constants
  - examples/chat/src/v3-chat-application.ts: `createShippingV3ChatApplication`, plus the same helpers
  - examples/chat/src/v3-chat-capacity.ts: new export `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`
- **Tests and harness:** tests/canvas-chat-*.test.ts and tests/fixtures/canvas-chat-lull/.
- **Not touched:** docs/realtime-latency/README.md, examples/grid, examples/v3-chat, examples/canvas, tests/fixtures/startup-discovery, and any existing test.
- **Untracked, never committed:** .logs/bounded-storage-lifecycle/r8-warm-capacity-01/.

The full write-up is in docs/realtime-latency/tracks/27-track-q-canvas-chat-lull/RESULT.md. Evidence is under <evidence>/track-q/, which also holds PROGRESS.md and BOUND.md (BOUND.md is marked as rechecked at 19caa468). The Chromium runs are in its browser/pairs-2/ folder, the Node runs in data/, and the suite comparisons in tests/.
