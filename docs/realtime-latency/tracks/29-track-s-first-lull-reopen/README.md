# Track S: reopen right after the first maintained lull

**Outcome:** Merged in 19caa468 (5a7491f8..40d50ea3). The creator's first maintained lull replayed its finished signing summary, whose stored resume basis then went stale as the epoch's moves landed, so a persisted reopen was refused floor-stale. One removed condition in `classifyClosedSigningSummaries`: a finished summary is never replayed, and the same pass makes a fresh decision. The floor-stale check is unchanged. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 21:08 UTC)

Track S: fix a pre-existing bug where a room reopened right after the creator's first maintained lull cannot continue. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track. It unblocks Track Q (Canvas and Chat lull), which is held because of this bug.

THE BUG (found by Track Q)
- A persisted reopen right after the creator's first maintained lull is refused with `floor-stale`.
  - On the room-database host, the reopen succeeds and the first seal after it throws `creator snapshot role reconciliation refused: floor-stale`.
  - On the Node SQLite host, the reopen itself fails, in the startup readiness preparation.
- The check that refuses is in packages/node/src/internal/creator-closed-rollback-data.ts, at about lines 19350-19351 at c67c66b7; lines may have shifted after the Track M and O merge. A stored signing-summary `resumeBasisDigest` differs from the one recomputed on resume.
  - It is reached through `installClosedRetirementSourceInRoom` (about :19209), from `reconcileSnapshotRecoveryRoles` (about :21826).
- It is not Canvas-specific. The unchanged Grid composition fails the same way: a copy of tests/recipient-long-room-issuance-retention-native.test.ts with the reopen moved to epoch 4 reproduces it.
- Track G recorded the same symptom earlier: docs/realtime-latency/tracks/16-track-g-presentation-overlay/README.md, around line 154.
- Reopening after two or more maintained lulls works, as in R3's 5-rollover case and every reopen after epoch 8.
- Before Track Q, Canvas never ran a creator lull, so R3's test tests/room-database-retirement-native.test.ts "(4 rollovers)" could not reach the bug. With Q's change it fails.
- Track Q's notes include a lead: the lull's early-turnover token is kept only in memory, so after a reopen the first seal runs one inline retirement selection. Check whether state that exists only in memory, and is lost at reopen, is part of what the resume basis is computed from.
- Evidence, under <evidence>/track-q/:
  - logs: logs/rdr-head-1.log, logs/rdr-probe-1.log, logs/grid-reopen4-1.log, logs/reopen4-node-1.log;
  - the probe test copies, in trash/;
  - RESULT.md, on Q's branch `worktree-agent-afc8a0b30ff709f24` at docs/realtime-latency/tracks/27-track-q-canvas-chat-lull/RESULT.md.
- <evidence> = <evidence>
- The refusal fails closed, so nothing is deleted wrongly, but the room stops: a reopen must lead to continued play.
- Guarantees at stake, from specs/bounded-storage-lifecycle/golden-path-guarantees.md:
  - G3: crash and reopen recovery;
  - G14: one resumable intent;
  - G17: monotone state across reopen;
  - G24: the startup floor is never repaired;
  - G26: never relax a check for speed or convenience.
  - The digest check must stay. Find out why the two digests differ, and make them agree only when the state truly agrees.

READ FIRST
- docs/realtime-latency/README.md, tracks/22 (Track L: reopen and close; L's resume fixes), tracks/20 RESULT.md (R3: residuals 1 and 2 at reopen), and tracks/21 (Track K's method).
- How the signing summary source and its resume basis are written and checked: where `resumeBasisDigest` is computed at write time and at resume, and over which inputs.

BASE
- codex/phase3a1b-p6-golden-path at d7f8c39b, which includes Tracks M and O (merge 8c61863e).
- Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. RED first, committed before the fix, at node level and failing on base:
   - (a) the Grid composition, creator plus Writer recipient, native SQLite, reopened right after the creator's first maintained lull, then sealing and playing on;
   - (b) the same on the room-database host, with a FIFO lock manager as R3's tests install;
   - (c) the same with the opt-in retention path (`roomRetention: true`, Tracks M and O), if it reaches the same state; or a test showing it doesn't, and why.
   Assert continued gameplay and seals after the reopen, not just the absence of the error.
2. Root-cause with code citations. Which inputs to the resume basis differ between write and resume? Is it in-memory state lost at reopen, a post-state that later steps in the same lull change without updating the stored digest, or a different source selection on resume? Why does a reopen after two or more lulls work?
3. Fix with the smallest change on the shared path that keeps every guarantee, and argue each one, as Track K's RESULT.md §3.2 does.
   - If the stored digest is wrong at write time, fix the write.
   - If resume recomputes from different inputs, make resume use the same authenticated inputs.
   - Never accept a mismatched digest, and never repair the floor.
4. Evidence:
   - Your RED tests GREEN.
   - Track Q's change on top of yours. In a scratch branch, rebase or cherry-pick Q's commits (9c0cffaa, 0bc1aae5, ef13154a, c47400a7) onto your head. Show that tests/room-database-retirement-native.test.ts passes, all 4 tests including "(4 rollovers)", and that Q's tests/canvas-chat-creator-lull-native.test.ts passes. Don't commit that scratch branch, and don't touch Q's branch.
   - The K, L, R3, N, M and O room tests:
     - tests/recipient-*-native.test.ts;
     - tests/room-database-retirement-native.test.ts;
     - tests/track-m-*.test.ts;
     - tests/track-o-*.test.ts.
   - One browser Grid run with LULL=1 (docs/realtime-latency/README.md recipe).
5. Suites: compare per test against base (node; storage-node retirement; root room tests; packages/node/tests/creator-closed-rollback-proof-accounting.test.ts, which has 21 known failures on base). `pnpm -r typecheck` must report 0 errors.
6. Commit your RESULT.md into docs/realtime-latency/tracks/29-track-s-first-lull-reopen/, with local paths written as <evidence>/…. Keep <evidence>/track-s/PROGRESS.md current.

PARALLEL WORK
- Track P: Canvas issuance growth and O(outbox) issue cost, in issuance retention and `creatorFilteredIssuanceStore` in packages/node/src/v3-live.ts.
- Track M2: 14b stage 2 (a verified-fact ledger) on the opt-in retention path.
- Track Q: held; it will rebase onto you.
- Keep your change local to the resume basis and reopen path. List every file and function you touch.
- Don't edit docs/realtime-latency/README.md.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
  - Some node tests evaluate the original source text of CRD and v3-live.ts functions, or count names and call sites there (Track M's finding 15, Track O's bc193d75). Keep new code outside that text, and keep local names unique where those tests require it.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-s/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`. It reads canonical, storage, storage-browser and compaction from dist. Rebuild them; build protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- Node has no Web Locks: room-host node tests install a FIFO lock manager.
- The machine is heavily loaded. Compare per test against base, and rerun timeouts alone. Never kill processes you did not start.
- Known pre-existing race (Track M's finding 5): a seal immediately after a received move can fail with NATIVE_READ_RESERVATION_BUSY on fake-indexeddb with a Writer recipient. Wait 300 ms before each seal in fixtures, as Tracks M and Q do.

FINAL REPORT
- The commit list.
- The RED tests.
- The root cause, with code citations, including why two or more lulls work.
- The fix, and why it is safe.
- The guarantee argument.
- Track Q on top: R3's test and Q's tests.
- The Grid run.
- Per-test suite diff against base; typecheck.
- What remains, and the risks.

### Report returned by the agent

#### Track S: fixed. A room reopened right after the creator's first maintained lull now seals and plays on

The bug is fixed with one changed condition in one function. The `floor-stale` resume-basis check is untouched. Track Q can now rebase: R3's "(4 rollovers)" test passes with Track Q's commits on top.

Branch `worktree-agent-a2f612353d58c46ea` at <worktree agent-a2f612353d58c46ea>/, base d7f8c39b. Nothing was pushed. Each commit ends with the brief's `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

##### Commits
- **5a7491f8** test (RED): tests/track-s-first-lull-reopen-native.test.ts and tests/fixtures/track-s/first-lull-reopen.ts.
- **ef57d107** fix: packages/node/src/internal/creator-closed-rollback-data.ts (CRD), `classifyClosedSigningSummaries` only. One condition removed, four comment lines added.
- **40d50ea3** docs: docs/realtime-latency/tracks/29-track-s-first-lull-reopen/RESULT.md.

##### RED tests
There are 6 tests: 3 hosts × 2 reopen points.
- **Composition:** the Grid settlement room with the creator and a Writer recipient, in Grid's LULL=1 order.
- **Hosts:** node SQLite; the room-database host on fake-indexeddb with R3's FIFO lock manager; the same host with `roomRetention: true`.
- **Reopen points:** right after the creator's first maintained lull (epoch 4), or after one more move each at that epoch.
- **Assertions after the reopen:** epoch, both projections, and the stored control (no intent, nothing gone backwards). Then two rollovers with both lulls not deferred, one more move each, and the control has advanced.
- **Retention host:** it reaches the same state. The retention path declines the boundary with a `*-birth` reason, and the test asserts that, so the existing path owns it.
- **Result:**
  - Base: 6/6 fail with `floor-stale`. The first variant fails at the first seal after the reopen, the second at the reopen itself.
  - Fix: 6/6 pass.

##### Root cause
Instrumenting the check (CRD:19362-19363 at head, 19360 at base) showed the stored digest and the recomputed one differ only in four inputs: the journal image, the journal rows (18 → 23), and the issuance rows and image (7 → 9 issued). Those are the creator's lawful moves at epoch 4, made after the lull's decision.
- The stored digest is correct when written.
- No in-memory state is an input to the resume basis.
- The fault is that a later reconciliation at the same floor replays the stored, already-completed summary source.

Why the summary is replayed:
- `classifyClosedSigningSummaries` (CRD:10306-10389) hands a finished ("terminal") summary to a fresh selection only under generation pressure. At base that was the condition `input.reader.generations.length > maxObjectGenerations - 2` (more than 5 AHE generations).
- The first maintained lull has exactly 5 generations, so its last pass replays the terminal summary as a no-op. The completed control then carries that summary source.

When the replay happens:
- **In session it never does.** The lull captures an early-turnover token, so the close skips re-running reconciliation (creator-recovery-pool.ts:37-75; creator-close.ts:3791-3805).
- **After a reopen, two reconciliations replay it**, because the token is process-local (creator-recovery-pool.ts:31-32):
  - **The reopen's readiness resume** (v3-live.ts:11299-11310). It refuses if moves were admitted after the lull and before the close.
  - **The first close after the reopen**, which has no token. It refuses once the epoch's next moves have changed the state.
- The token's loss exposes the bug but is not the cause. Recreating the token at reopen would be unsound, and it would not cover the readiness case.

**Why reopening after two or more lulls works:** from epoch 5 on there are 6–7 generations. The terminal summary is then handed off, and the boundary ends on a generation decision that has no summary source. Later reconciliations make a fresh decision. This matches the existing rule for completed generation sources (CRD:9049-9052).

##### The fix, and why it is safe
The generation-pressure condition is gone, so a terminal summary is never replayed:
- Its exact residual rows are still checked (`checkClosedSigningSummaryImage`, CRD:10994).
- The same pass then makes a fresh, fully authenticated decision. At the first boundary that decision is classification-only and deletes nothing.
- Unfinished work still resumes through the unchanged digest check: an active intent, a summary whose drain is unplanned or unfinished, and a same-decision residual summary.
- Unchanged: the basis computation, the pass bound, the token and close rule, the readiness resume, the retention path, and every stored format.
- No test reads this function's source text, and no name was added.

##### Guarantee argument (RESULT.md §3.3)
- **G26:** no check is weakened; a mismatched digest still refuses.
- **G3:** proven by the RED tests, Track Q's runs and the Grid runs.
- **G14:** one intent per boundary, and unfinished work resumes as before.
- **G17:** the tests assert the state is monotone across the reopen; the fresh decision is at the same floor and retires nothing.
- **G24:** no floor or control is rewritten to pass a check.
- Also argued: G7, G10, G9/G15, G18, G21/G22 (pass count unchanged at 4), G5, G23 and G28.

##### Track Q on top
On a local scratch branch `track-s-scratch-q-on-s` (never merged or pushed, Track Q's branch untouched), Q's 4 commits cherry-pick onto ef57d107 with no conflicts.

| Test | Result |
| --- | --- |
| room-database-retirement-native | 4/4 pass, including "(4 rollovers)" |
| canvas-chat-creator-lull-native | 2/2 pass |
| canvas-chat-resource-bound | 13/13 pass |
| canvas-chat-long-room, reopen after epoch 4, 8 epochs, node and room hosts, both recipient modes | 8/8 pass, Canvas and Chat; Q's own reopen-at-4 probe had failed |

##### Grid (Chromium)
- **The brief's run** (LULL=1, 8 rollovers, persisted reopen): passes.
- **Reopen right after the first maintained lull** (4 rollovers):

| Lull mode | Base | Fix |
| --- | --- | --- |
| LULL=1, default host and room database | passes | passes |
| LULL=concurrent, default host | fails: `phase:"persisted-reopen" … floor-stale` | passes, twice |
| LULL=concurrent, room database | fails the same way | passes |

- With LULL=1 the Grid's continuation after the reopen issues a move but never seals, so base can't reach the bug.
- The concurrent-lull failure is the one Track G recorded.
- An 8-rollover concurrent run also passes with the fix.

##### Suites against base (per test)
Base is my branch with the fix swapped out of the working tree, so the product code is identical to d7f8c39b.

| Set | Result |
| --- | --- |
| node | identical (48 failures in both) |
| creator-closed-rollback-proof-accounting | 20 failures in both runs, the same tests (Track O also saw 20, not the 21 the brief expected) |
| storage-node retirement | identical (49 in both) |
| root room set | identical (337 in both) |
| K/L/R3/N/M/O/S room tests | base 6 fail (the Track S RED), head 0 fail; 97 pass and 67 env-gated skips, the same in both |

- `pnpm -r typecheck`: 0 errors.
- Prettier passes on the new files, and the shadowed-source guard exits 0.

##### What remains, and risks
- **Cost:** the first maintained boundary now writes one classification-only metadata decision instead of doing a no-op replay. That happens in the lull, or inside the seal when there is no lull.
  - Lull at t4: +35 to +63 ms in single runs.
  - No-lull seal at t4, two ABBA pairs: +17 and +161 ms, within run-to-run noise.
  - Later boundaries are unchanged.
- **Not covered:** a SIGKILL crash inside that new install (it is the existing classification-only install), and Firefox/WebKit Grid runs.
- **One evidence note:** I edited suite.sh while the base root run was going, and zsh printed a parse error after the root report had been written. The report itself is complete and valid.

Evidence is under <evidence>/track-s/ (PROGRESS.md, logs, test reports and comparisons, Grid runs, scripts, and the never-committed diagnostic patch). The Grid bench inputs copied into the worktree's .logs/ are untracked and were not committed.
