# Track N: recipient issuance growth

**Outcome:** Landed in 60161b4a..7464f875. A Writer recipient now drains its own classified, published, settled issuance; every recipient stays flat (13 rows) from epoch 5 through 16 on both paths. The Grid's proof-event budget scales with rollovers. Full write-up and guarantee argument: [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 03:53 UTC)

Track N: stop each recipient's issuance store growing with room age, a G1 violation that predates this work. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The user approved this track.

THE BUG
- Track R3 compared stores between adopted-8 and adopted-16 in 16-rollover Grid runs. Every recipient's issuance store grows by 3 issued records and 3 outbox rows per epoch: from 26 to 50 rows, and from 33 to 56 KB of issuance image.
- The creator is flat (193 rows). Every other store is flat.
- It happens on the default six-database path as well as R3's room path.
- Evidence: <evidence>/track-r3/grid/ (16-rollover runs) and the script <evidence>/track-r3/bin/growth_diff.py.
- <evidence> = <evidence>
- Guarantees at stake, from specs/bounded-storage-lifecycle/golden-path-guarantees.md:
  - G1: no growth with room age.
  - G19: issuance retention keeps only paired, published, epoch-bound rows; pending or malformed rows block the owner with no writes.
  - G18: the protected set is the head, two usable rollbacks, bounded pending work and shared bytes.

READ FIRST
- docs/realtime-latency/README.md and tracks/21-track-k-epoch8-retention/. Track K fixed the same kind of leak for the recipient journal: a scope that never became collectible on a recipient stayed protected forever. Its root-cause method and fix shape are the model to follow.
- specs/phase-6b-bounded-pruning/slices/01-issuance-retention.md: the issuance retention rules.
- tests/recipient-long-room-journal-retention-native.test.ts (Track K): a 16-epoch, native SQLite, creator-plus-recipient test. Extend that pattern.

BASE
- Your worktree starts at codex/phase3a1b-p6-golden-path HEAD: 9ae59c2e.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. Reproduce deterministically at node level: a RED test asserting that a recipient's issued and outbox row counts stay constant from the first steady epoch through epoch 16, and that the creator's do too. Commit it first.
2. Root-cause with code citations. Which rows are they: the recipient's own issued moves, outbox entries awaiting publication or acknowledgement, or received records? Why are they never paired, published or epoch-retired on a recipient while the creator's are?
   - Check whether the recipient lacks a publication or acknowledgement fact the creator has (as with K's missing carrier).
   - Check whether a recipient turnover pass is spent before issuance classification can run.
3. Fix with the smallest change on the shared path that keeps every guarantee. Argue each guarantee you touch, as Track K's RESULT.md §3.2 does.
   - Never retire a row that the issuance rules say to keep.
   - Unknown or unpaired rows still block, as G19 requires.
   - If the correct answer is an explicit reviewed bound rather than retirement, stop and report it with the reasoning; don't invent a limit (G21).
4. Grid proof at 16 rollovers, with LULL=1, on both the default path and the room path (STARTUP_HEALTHY_GRID_ROOM_DATABASE=1). Recipient issuance must stay flat from the first steady epoch on.
   - Runs past ~13 rollovers fail the harness check `proofEventsTruncated === false`: a 50,000-event cap at tests/fixtures/startup-discovery/critical-observer.ts:297, about 3.8k events per rollover.
   - Make that observer budget scale with the configured rollovers, in its own commit, as a measurement-only harness change. Justify it, and assert the same check with the scaled budget. Never just disable the check.
5. Suites: compare per test against base (node; storage-node retirement; the root room tests including Tracks K and L's native tests). Run `pnpm -r typecheck`; it must report 0 errors.
6. Commit your RESULT.md into docs/realtime-latency/tracks/24-track-n-recipient-issuance-growth/, with local paths written as <evidence>/…. Keep <evidence>/track-n/PROGRESS.md current.

PARALLEL WORK
Track M is building slice 14b (a retirement decision from a verified-fact ledger) on the opt-in room path, on its own branch. It will rebase onto you.
- Keep your change local to issuance retention and classification.
- Don't restructure the planner.
- List every file and function you touch.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-n/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`.
  - It reads canonical, storage, storage-browser and compaction from dist. Rebuild them, and build protocol-v3 before compaction.
  - Run recipe: docs/realtime-latency/README.md. Summary script: <evidence>/track-k/bench/summary.py. Store growth: <evidence>/track-r3/bin/growth_diff.py.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: compare per test against base, and rerun timeouts alone. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- Reproduction.
- Root cause with code citations.
- The fix, and why it is safe.
- The guarantee argument.
- Per-test suite diff against base; typecheck result.
- Grid at 16 rollovers: store counts per epoch on both paths.
- What remains, and the risks.

### Report returned by the agent (2026-10-20 05:36 UTC)

Track N is finished. Each recipient's issuance store now stays flat with room age. One function changed, every guarantee is kept, and nothing needed an explicit bound. Everything is committed on `track-n-recipient-issuance-growth` (worktree <worktree agent-aacbd4e4ceff4b065>/, parent 9ae59c2e). Nothing was pushed, and the copied `.logs/.../r8-warm-capacity-01/` bench inputs are not committed.

#### Commits
- 60161b4a test: RED for a Writer recipient's local issuance growing with room age
- 94cef38a fix: let a Writer recipient drain its own classified settled issuance
- eca9b1c2 test: a recipient with retired issuance keeps issuing across lulls and reopen
- 8d00935d test(grid): scale the proof-event observer budget with configured rollovers (measurement-only harness change)
- af83570a fix: a cold recipient drains only published issuance rows
- 7464f875 docs: record the Track N result (docs/realtime-latency/tracks/24-track-n-recipient-issuance-growth/RESULT.md)

#### Reproduction
New test file: tests/recipient-long-room-issuance-retention-native.test.ts.
- It uses native SQLite, the Grid application and the settlement-v1 profile, with the creator and one Writer recipient exchanging signed rows over 16 epochs.
- At base it is RED and matches R3 exactly: the recipient goes from 26 rows at epoch 8 to 50 at epoch 16, 3 per epoch, and its pruning watermark is never set. The creator stays flat at 13.
- The leak also breaks play, not just storage. An untracked probe with 20 moves per epoch shows the recipient's next move refused at epoch 24 at base, after 506 rows: `unsigned postimage exceeds row bound` (the issuance store's 1,024-row bound).
  - At the Grid's rate of 3 rows per epoch, that refusal would come around epoch 170.
  - At HEAD the same probe stays flat at 85 rows through epoch 30.

#### Root cause
- **Which rows:** they are the recipient's own moves and author fences. All are published, paired and settled. No publication or acknowledgement fact is missing.
- **Where the drain stops:** the only drain on this profile is `cleanupCreatorSettlementSuccessor` (v3-live.ts:20218), called at the end of every activation (v3-live.ts:21002). At base it returned early at the cold-material guard (base:20283-20290), before the issuance scan (base:20457).
- **What the recipient lacks:** the guard requires `certifiedRecoverySourceGenerations`. Only the creator's own close mints that (creator-close.ts:4280, 4408), or a recipient's forward promotion (creator-adoption.ts:1323, 1425, 2963, 3790, 4167). A Writer recipient never closes, so its material is always "cold". This is the same shape as Track K's missing carrier.
- **Classification is not starved:** the recipient's own coordinated retirement does complete and does classify these rows (CCRD:19066-19111). A temporary trace confirmed it at every install from epoch 4. No turnover pass is spent; only the drain was unreachable.
- **The lull does not help:** with lulls the recipient still holds 38 rows at epoch 12 at base.

#### The fix, and why it is safe
The change is entirely inside `cleanupCreatorSettlementSuccessor`:
- Cold material now continues only when its own completed AHE retirement decision matches the issuance control's completed decision. This is the creator's existing precondition: same throughEpoch, decision digest and source digest, and no pending generation drain.
- Even then it reaches only the existing coordinated branch, which calls `pruneAuthenticatedSettledPrefix`. It never reaches generation or source reclamation, and it never reads role or promotion references.
- Its scan additionally stops at the first row admitted after the decision's throughEpoch, and at the first row that is not published (v3-live.ts:20496-20499).
- Warm (creator) material is unchanged.

Guarantees:
- **G1:** the recipient is flat at 13/13 rows from epoch 5, identical to the creator.
- **G19:** only published, paired, classified, settled rows are drained. A pending row stops the scan. A malformed or unpaired row throws before any write, which blocks the owner exactly as it already does for the creator.
- **G9 and G15:** unchanged. The native pruner does all its checks and deletes in one transaction: watermark CAS, plan, protected holes, pairs, epoch, exact counts and the watermark update.
- **G18 and G7:** no generation effect and no new decision.
- **G17:** the watermark only moves forward. After a persisted reopen the recipient's issuance census is identical, field for field.
- **G21:** no limit was added or changed.
- **G26:** nothing was relaxed.

#### Suites (per test, base vs HEAD)
- **node:** 1023/48 at both, identical per test.
- **storage-node retirement:** 158/49 (2 skipped) at both, identical per test.
- **observer unit tests:** 23/0. Both runs used the HEAD observer file, because writing the base version over it was refused by the permission classifier. With no budget global set, the observer still uses 50,000 as before.
- **root (R3's 92 files plus the new test):**
  - Base 676 pass / 338 fail; HEAD 669 / 345.
  - Fixed: the 2 Track N tests.
  - New failures: 9, all in d110c-0c1f5b0a-settlement-codec-red (8 timeouts and one module-initialisation race). Rerun alone twice at HEAD, it matches base exactly (9 pass, the same 1 pre-existing failure).
  - Tracks K and L, room-database-retirement and r9-grid-outcome-transfer pass on both sides.
- **Typecheck:** `pnpm -r typecheck` exits 0 with 0 errors. The Grid harness project (`tsc --noEmit`) shows 123 errors, the same pre-existing count Track K recorded, none on lines I touched. The shadowed-sources guard is clean.

#### Grid at 16 rollovers, LULL=1
The budget change scales the harness's per-frame cap with rollovers: max(50,000, 4,000 × (rollovers + 1)). It also asserts that every role used the scaled budget. `proofEventsTruncated === false` is still asserted. The creator logs 3,730 events per rollover once steady, 53,320 at 16 rollovers against a budget of 68,000.

All four interleaved runs (base and HEAD on each path) pass, including persisted reopen and continued play. The three recipients are identical at every checkpoint.

| Checkpoint | Base recipients (both paths) | HEAD recipients (both paths) | Creator (all runs) |
|---|---|---|---|
| adopted-4 | 14/14 | 14/14 | 7/7 |
| adopted-5 | 17/17 | 13/13 | 10/10 |
| adopted-6 | 20/20 | 13/13 | 13/13 |
| adopted-8 | 26/26 | 13/13 | 13/13 |
| adopted-12 | 38/38 | 13/13 | 13/13 |
| adopted-16 | 50/50 | 13/13 | 13/13 |
| reopened | 50/50 | 13/13 | 13/13 |
| continued-gameplay | 51/51 | 14/14 | 14/14 |

- From adopted-8 to adopted-16, no store changes row count on any client at HEAD. At base, only the recipients' issued and outbox rows change.
- I make no latency claim: there is one pair per path at load 25–101. Median recipient install from t8 to t15 was 522 ms at base vs 360 ms at HEAD on the default path, and 458 vs 444 ms on the room path.

#### What remains, and risks
1. **Moves-per-epoch cap (predates this track):** the 1,024-row issuance bound limits any Writer, including the creator, to roughly 100 moves per epoch. Whether to raise it is a reviewed-limit (G21) decision, not something I changed.
2. **Rooms that already leaked:** a recipient below the bound drains its backlog on its next install. One already past the bound is untested and may need an authenticated repair.
3. **Creator path:** a creator whose material is cold now drains the same way, under the same restrictions. No test or run exercised that case.
4. **Track M:** the drain depends on the recipient's completed AHE and issuance decisions matching. If slice 14b changes that, the drain fails safe (keeps everything) and the growth returns on that path. Track M should re-run the Track N test and a 16-rollover room-path Grid after rebasing. A conflict is possible only if 14b edits `cleanupCreatorSettlementSuccessor`.
5. **Room-path coverage:** only the Grid covers it; the node tests run on the SQLite host.
6. **Budget:** the 4,000-per-rollover budget is based on today's event volume. If it grows, the truncation check fails loudly.

#### Files and functions touched
- packages/node/src/v3-live.ts: `cleanupCreatorSettlementSuccessor` only.
- tests/recipient-long-room-issuance-retention-native.test.ts (new; 2 tests).
- tests/fixtures/startup-discovery/critical-observer.ts: new `proofEventBudget` export, used by `proofEvent`.
- tests/fixtures/startup-discovery/healthy-grid.ts: the role observer reports the budget.
- tests/fixtures/startup-discovery/r8-source-binding.pw.ts: sets the scaled budget and asserts it.
- docs/realtime-latency/tracks/24-track-n-recipient-issuance-growth/RESULT.md.

The planner, the classification, the native stores, RED and governance tests, and all limits are untouched.

Evidence is in <evidence>/track-n/ (PROGRESS.md and the full patch track-n.patch are there):
- logs/: test, probe, typecheck and rerun logs
- grid/: builds and runs
- tests/: suite JSON reports
- bin/: scripts
- probe/: the probe test
