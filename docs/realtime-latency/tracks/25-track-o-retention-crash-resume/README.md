# Track O: crash resume on the retention path (14f case 8)

**Outcome:** Landed with Track M in merge 8c61863e (c6eff8e7..099db6ce). One decision per boundary and one unit per epoch's signing work (14b/14e amendment 96bc9b3c, accepted by the user), so a crash or refusal between continuations resumes. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 16:10 UTC)

Track O: fix the crash-resume bug (14f case 8) in Track M's verified retention path, so that Track M can be merged. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track: "fix first, then merge" Track M.

THE BUG (Track M's finding 1, reproduced 15 times on Chromium, Firefox and WebKit)
- On the opt-in path, `createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })`, each creator boundary retires in two decisions, each in its own room transaction:
  - D1 covers snapshot turnover, journal, signing evidence, AHE and issuance;
  - D2 covers signing summaries for the epochs whose evidence D1 retired.
- D1 completes the signing control `{decisionDigest, sourceProofDigest, throughEpoch, protectedEpochs}`, so epoch e is no longer protected. Unlike the existing path, D1 records no `completed.summarySource` with its eligibility fence.
- If the process is SIGKILLed after D1 commits and before D2, these happen in order:
  - The next acquisition finds e's `signerState`, `voteOutbox` and `voteSlots` rows with no authenticated material for e.
  - `acquireSigningDependencies` (packages/seal/src/creator.ts:775) throws `UNCLASSIFIED_SIGNING_DEPENDENCY:e`.
  - CRD turns that into `internal-invariant` in `acquireCreatorIssuanceMaintenanceProof`.
  - The creator's maintenance halts for good.
- Guarantees broken on the opt-in path, from specs/bounded-storage-lifecycle/golden-path-guarantees.md:
  - G3: crash recovery;
  - G14: one resumable intent.
  - Nothing is deleted wrongly. Old XOR new holds per transaction.
- Likely the same state (not tested): D2 refused after D1 commits, for stale, budget or capacity. A refusal writes nothing.
- Track M's fix options, none tried:
  - (a) D1 writes the existing path's `summarySource` / eligibility-fence form, so the existing summary resume applies;
  - (b) one decision per epoch covering both evidence and summaries; this needs a change to the 14b spec;
  - (c) use `authenticateClosedSigningSummaryEpoch`, with differential proof.

READ FIRST
- Track M's RESULT.md, on its branch at docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/RESULT.md. Read §3 (design as built), §5, §8 (14f), §10, §13 and §14.
- Track M's evidence, under <evidence>/track-m/:
  - PROGRESS.md;
  - sub-14f/counterexamples/case8-after-b/, the counterexample with the signing control before and after;
  - maps/.
- <evidence> = <evidence>
- specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1–G28), and specs/bounded-storage-lifecycle/slices/14b-retention-trust.md, 14e and 14f.
- How the existing path's signing evidence and summary passes record and resume: packages/storage-browser/src/internal/signing-retirement.ts, and the summary source and eligibility fence it writes.

BASE
- Track M's branch `worktree-agent-a6747ca659c74d66c` at 07849f85, which sits on codex/phase3a1b-p6-golden-path at 5c6b949d.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> worktree-agent-a6747ca659c74d66c`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. RED tests first, committed before the fix:
   - A deterministic node-level or fake-IDB test: D1 commits, D2 never runs. The next boundary must resume and complete, with no `UNCLASSIFIED_SIGNING_DEPENDENCY` and no halt, and must reach the same durable end state as the crash-free run.
   - The same with D2 refused after D1 commits, once for each refusal kind you can induce (stale, budget, capacity).
   - Every other split boundary in the retention path: continuations over the 512-write cap, and any other place where one boundary spans more than one transaction. Kill or refuse between each pair of transactions, and assert resume. Track M flagged this as a risk class; enumerate the split points from the code and list them.
2. Fix with the smallest change that restores G3 and G14 without weakening anything.
   - Prefer (a): it reuses the existing path's durable resume form, which existing owners already authenticate.
   - If (a) cannot be made sound, record why with a counterexample before considering (b). (b) changes the 14b spec, so write the spec change as its own commit first and argue it.
   - Never make the next acquisition skip or tolerate unclassified rows. G19 and G26 require that unknown material blocks.
3. Argue every guarantee you touch, as Track K's RESULT.md §3.2 does (docs/realtime-latency/tracks/21-track-k-epoch8-retention/RESULT.md).
4. Evidence:
   - 14f case 8 with a real SIGKILL on Chromium, Firefox and WebKit. Use Track M's harness in tests/fixtures/track-m/native/ (room-retention-native.pw.ts, death-harness pattern).
   - Re-run cases smoke, 2, 3 and 5–7 on all three engines at your head.
   - Track M's 5 test files, Track N's tests/recipient-long-room-issuance-retention-native.test.ts, and the K, L and R3 native tests.
   - Track M's differential (tests/track-m-room-retention-differential.test.ts and the settlement differential). It must still show retention never deletes what the existing planner keeps.
   - One 16-rollover Grid run with STARTUP_HEALTHY_GRID_ROOM_DATABASE=1, the room retention option as Track M's harness sets it, and LULL=1. Recipient issuance must stay flat; check with <evidence>/track-n/bin/issuance_series.py.
   - Confirm the creator lull did not regress versus Track M's 623 ms. One interleaved pair is enough unless it looks worse.
5. Suites: compare per test against Track M's head (07849f85) for node, root, sb, snr and obs, as Track M's §9 does. `pnpm -r typecheck` must report 0 errors.
6. Commit your RESULT.md into docs/realtime-latency/tracks/25-track-o-retention-crash-resume/, with local paths written as <evidence>/…. Keep <evidence>/track-o/PROGRESS.md current.

PARALLEL WORK
- Track M2 builds slice 14b stage 2 (the in-memory verified-fact ledger) on the same Track M branch. It will rebase onto you.
  - Keep your change local to D1 and D2's signing control, summary source and resume handling, plus whatever split-point resume needs.
  - Don't restructure acquisition or the decision planner.
  - List every file and function you touch.
- Tracks P (Canvas issuance growth) and Q (Canvas/Chat lull) work from codex/phase3a1b-p6-golden-path on the shared path. Don't touch their areas.
- Don't edit docs/realtime-latency/README.md; the coordinator maintains it.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
  - Some node tests evaluate the original source text of functions in CRD and v3-live.ts (Track M's finding 15). Keep new code outside that text, as Track M's 8a09ceb8 did.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-o/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`.
  - It reads canonical, storage, storage-browser and compaction from dist. Rebuild them; build protocol-v3 before compaction.
  - Run recipe: docs/realtime-latency/README.md. Summary script: <evidence>/track-k/bench/summary.py.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- Node has no Web Locks: room-host node tests install a FIFO lock manager, as R3's and M's tests do.
- The machine is heavily loaded. Compare per test against base, and rerun timeouts alone. Make timing claims only from interleaved pairs. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- The split points you found, and the RED test for each.
- The root cause and the fix, with code citations.
- The guarantee argument, including G3, G14, G15, G19 and G26.
- 14f per engine, including SIGKILL.
- Differential results.
- Per-test suite diff against Track M's head; typecheck.
- The Grid run and lull check.
- What remains before Track M plus O can merge, and the risks.

### Report returned by the agent (2026-10-20 18:46 UTC)

#### Track O: Track M's crash-resume bug (14f case 8) is fixed

A crash or a refusal partway through one retention boundary on the opt-in path now resumes to the crash-free end state. There is no `UNCLASSIFIED_SIGNING_DEPENDENCY` and maintenance does not halt. I used option (b), with the 14b/14e spec amendment committed first. Option (a) cannot be made sound; there are two counterexamples below. Nothing that makes unknown material block was relaxed.

- Branch `worktree-agent-a5e3fefad3208def1`, on Track M's 07849f85. Nothing pushed.
- RESULT: `docs/realtime-latency/tracks/25-track-o-retention-crash-resume/RESULT.md`.
- PROGRESS: `<evidence>/track-o/PROGRESS.md`.

##### Commits
- c6eff8e7: RED tests (node level, fake-indexeddb).
- 96bc9b3c: spec amendment to 14b and 14e. Its message was amended once before the fix was committed, to remove a false claim that no pass runs at the kill's floor.
- 31a274fd: the fix.
- a99d8abe: additive 14f harness options (`TRACK_O_14F_CONTINUATION`, `TRACK_O_14F_ONE_UNIT`), defaults unchanged.
- bc193d75: renames a local in the fix. Without it, the node test file `creator-closed-rollback-proof-accounting.test.ts` (351 tests) failed to load, because it requires the variable name `signingEpochs` to be unique in CRD's source text.
- a66a0dea: stale and budget refusals added at every split point (capacity was already covered).
- 099db6ce: RESULT.md.

##### Two root causes, not one
1. **Track M's.** D1 retired epoch e's evidence and moved the signing control past e. D2 was to retire e's summaries. After a kill or refusal between them, nothing selects those summary rows:
   - retention takes summaries only together with same-pass evidence;
   - the existing fresh summary rule needs the same-floor evidence drain (base CRD:10395).
   A later AHE unit then retires the generation that supplies e's trust. The next acquisition throws `UNCLASSIFIED_SIGNING_DEPENDENCY:e` (seal creator.ts:775).
2. **New.** Track M retired journal prefixes before signing evidence. The evidence classifier admits epoch e only while prefix e is still collectible (base CRD:10588). A split between those two continuations strands e's evidence, with the same halt.

##### Split points (from `applyRoomRetentionPass`) and their RED tests
- Between decisions (D1 / D2). The fix removes this split point.
- Between continuations at unit boundaries, when the 512-write cap halves `take`.
- Between step A and step B (14f cases 5–7).
- Between passes of one boundary.
- After a refusal, which falls back to the existing path.

Tests:
- `tests/track-o-room-retention-resume.test.ts`: default caps; a kill after D1, and D2 refused as stale, budget or capacity.
- `tests/track-o-room-retention-split.test.ts` and `-split-recipient.test.ts`: one unit per transaction, so a kill or a refusal of each kind can land between any two consecutive units.
- At base, three creator points fail with `UNCLASSIFIED_SIGNING_DEPENDENCY:3`: D1/D2, prefix/evidence and evidence/summaries. Each fails on kill and on refusal; D1/D2 was refused all three ways, the other two with capacity only.
- At HEAD all pass: 43 passed, 60 skipped (points this room does not have), 0 failed.

##### The fix (31a274fd, plus the rename in bc193d75)
- **One decision per boundary.** In `reconcileSnapshotRecoveryRoles` (CRD:22437-22445), the decision carries the evidence plus `roomRetentionSummarySelection(...)`, with the same inputs base D2 used. The change is after `transferRoles`, so it stays outside the source text the node tests read.
- **Unit order.** In `roomRetentionItems` (CRD:20781-20803) the order is now snapshot, headers, signing by epoch (evidence and summaries together), prefixes, AHE.
- **Signing section.** In `browserRoomSigningRetentionSection` (SR:1412-1429) a summary key is accepted when the control already retires its epoch, or when the same section retires that epoch's whole evidence. The existing census check (SR:1438-1445) then forces every row of that epoch to retire in the same transaction.
- **Doc comments:** `roomRetentionSummarySelection` and `RoomRetentionSigningSelection` (storage/room-retention.ts).
- **Unchanged:** acquisition, every classifier, the planner and cap, step A/B, `acquireSigningDependencies`, and the existing path.

Why (a) fails:
- It does not touch the prefix/evidence split.
- If D1 records the evidence drain, the next same-floor acquisition must rebuild each drained entry. That rebuild needs prefix e, which D1 already retired, so it fails `chain-invalid` (CRD:10557/10603/10588).
- If D1 stores the summary source, the install needs a resume-basis digest over every owner's post-state, which D1 cannot compute (CRD:19353/19360). While stored, D2's own section refuses `signing:summary-debt` (SR:1349) and every signing writer refuses `SIGNING_MAINTENANCE_DEBT` (SR:186).

Option (c) only runs on (a)'s stored summary source. It also needs the AHE closure that the next AHE unit retires, and it refuses epochs that still hold evidence.

##### Guarantees
- **G3:** every committed prefix of continuations is a state the next acquisition reselects the rest from, and no AHE unit commits before all signing units.
- **G14:** one decision, no new durable record; a refusal writes nothing; step A still leads.
- **G15:** each continuation is one transaction, whole epochs are enforced by the census, and the differential holds.
- **G19 and G26:** unknown material still blocks. The fix removes the state that caused the halt instead of tolerating it, and the summary check is the same rule, now inside one transaction.
- **G7, G9, G17, G21, G22, G1 and G28** are argued in RESULT §6.

##### 14f with real SIGKILL (Chromium 151, Firefox 153, WebKit 26.5): all pass
- Full file on all three engines: smoke, both case 2 variants, case 3, the reference, and cases 5–8. Case 8 now passes everywhere.
- Cases 5–8, each with a fresh reference, at one-unit continuation 1 (epoch 3's signing unit, the 6 rows case 8 stranded at base), 2 (the journal prefix) and 3 (the first AHE unit), on all three engines.
- Case 11 passes on Chromium.
- At default caps a boundary is one continuation (5 units, 38 writes). Default-cap case 8 therefore now kills after the whole boundary; the one-unit runs are what cover kills between units.

##### Differential and pinned tests
Track M's differential and settlement differential pass: retention never deletes a row the existing planner keeps. The pinned tests pass 48/48 (Track M ×5, N, K, L ×2, R3).

##### Suites against Track M's own reports
- 0 new failures in node, root, sb, snr and obs, after rerunning alone two files that failed only from load: the heap test, whose `beforeAll` timed out, and 9 timeouts in the d110c settlement-codec file.
- Node 1023/48 and root 678/336, both equal to Track M's head. sb 624/1, where 3 environment gates pass that failed in Track M's report. snr 158/49 and obs 23/0, both equal.
- `pnpm -r typecheck` reports 0 errors at a66a0dea; the shadow guard passes.

##### Grid
- **16 rollovers** (room database, retention, `LULL=1`): passed.
  - Creator retention 12/12 applied, one continuation each (45–46 writes); recipients 39/39 applied.
  - `issuance_series.py` shows 13 rows per client from adopted-6 through the reopen, flat.
- **Lull check.** The base bundle is Track M's `build-m4`; its `entry.mjs` differs from mine only in the fix's hunks.
  - Quiet interleaved pair (head first, then base): creator lull t5–t8 median 549 ms for Track O against 601 ms for base (Track M reported 623).
  - Creator retention pass 352 against 391 ms.
  - An earlier pair overlapped my own final vitest run and is not used for the figure.

##### What remains before Track M plus O can merge, and the risks
- The 14b/14e amendment (96bc9b3c) needs the slice owner's acceptance.
- Track M2 must rebase onto this branch. Conflicts will be in the decision construction and `roomRetentionItems`. M2 must keep one decision per boundary, one epoch's signing work per unit, and the unit order. It should re-run the Track O tests, the one-unit 14f cases and the proof-accounting test file.
- Track M's other pre-flip items (§14, items 2–6) still stand.
- Risks:
  - A committee of more than about 85 signers makes one signing unit exceed the 512-write cap. That boundary then falls back to the existing path: safe, but slow.
  - The existing summary rule can decline an epoch's summaries; that leaves the same state as on the existing path.
  - Journal-header split points were not exercised (this room never retires headers).
  - Boundaries with several evidence epochs were argued, not exercised.

##### Files and functions touched
- packages/node/src/internal/creator-closed-rollback-data.ts: `reconcileSnapshotRecoveryRoles` (decision construction only), `roomRetentionItems`, and the `roomRetentionSummarySelection` doc comment.
- packages/storage-browser/src/internal/signing-retirement.ts: `browserRoomSigningRetentionSection` (the summary-key condition and its doc comment).
- packages/storage/src/room-retention.ts: doc comment only.
- specs 14b and 14e.
- New tests: `tests/track-o-room-retention-{resume,split,split-recipient}.test.ts` and `tests/fixtures/track-o/{resume,split}.ts`.
- Track M's native harness, additive only: `room-retention-native.pw.ts`, `trap.ts` (`beforePlan`) and `worker.ts` (`unitCount`, `oneUnit`).

No existing RED or governance test, frozen artifact or `docs/realtime-latency/README.md` was edited. The untracked bench inputs in `.logs/` were not committed.
