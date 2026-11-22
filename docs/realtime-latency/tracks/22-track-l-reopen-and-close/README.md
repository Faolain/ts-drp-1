# Track L: reopen admission failure and close race

**Outcome:** Landed in dcab6d12..88467723. Full write-up and guarantee argument: [RESULT.md](RESULT.md).

### Brief (plan given to the agent) (2026-10-19 23:25 UTC)

Track L: fix two game-breaking bugs on the current maintenance path of the ts-drp repo (a TypeScript local-first CRDT meant to power real-time games). The user approved this track.

REPO AND BASE
- Main checkout: <repo>. You work in your own git worktree.
- Base: branch codex/phase3a1b-p6-golden-path at 9f606ce8. First check that your worktree HEAD is 9f606ce8. If it isn't, move to it with `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. `git reset --hard` is blocked by a hook.
- Recent history on that branch:
  - 4c4f192c, de70325e: added the opt-in lull API (`V3RoomSession.maintainRecoveryPool()`), the recipient lull boundary and FIFO-queued ingress during deferrable lulls.
  - 719e4732: Track G presentation overlay.
  - 75aa8807: Track H long-task cuts.
  - 742a517e..9f606ce8: Track K, recipient journal retention bounded past epoch 8.

THE TWO BUGS
Both were found by Track K; both predate it and reproduce on de70325e. Read Track K's write-up first, especially §5 "The recipient-lull skip" and §6: <evidence>/track-k/RESULT.md
K's bench scripts and runs are in <evidence>/track-k/bench/. Relevant runs: run-fix2-r12-lull and run-base2b-r5-lull. The test-only quiesce variant is healthy-grid.quiesce-variant.ts.

1. Reopen admission failure.
   - Sequence: a recipient's lull (`maintainRecoveryPool`) completes a retirement, then the room is closed (persisted), then reopened.
   - The close and the reopen succeed and the world matches. But no recipient ever receives or admits the creator's first continued-gameplay move: no delivery-branch events at all, and the test times out.
   - In a game, play silently stops after a restart.
   - K's lead (UNVERIFIED): a completed retirement control with throughEpoch + 1 === currentEpoch satisfies `creatorRetirementResumeRequested` in packages/node/src/v3-live.ts (K cited ~19170-19183; lines moved ~+80 since). That makes `needsOrdinaryReadinessRecovery` true (K cited ~19669-19672), and in the healthy flow only the next install clears it.
   - Verify or refute the lead with evidence before fixing anything.
2. Close race.
   - A `maintained` recipient lull fires an unawaited `roomTransport.requestRetainedHistory()` (packages/node/src/v3-room.ts ~6541-6544).
   - Peers serve that request while the room is closing. Their queued `republishRetained` finds the plane deactivated and fails with `not-active` (v3-live.ts ~16304, v3-room.ts ~3941).
   - The transport counts that as a join fault, so the persisted close fails.
   - A real game closing right after a lull would hit this, so fix it in the product, not only in the harness. Decide and justify: should close join or cancel the in-flight repair, or should a not-active republish during an orderly close not count as a fault? Never hide real faults.

ORDER OF WORK
1. Reproduce each bug deterministically at node level, as a new test that fails at 9f606ce8 (RED). Commit the RED tests first.
   - Model them on existing node tests that use real SQLite stores, e.g. tests/recipient-long-room-journal-retention-native.test.ts and the creator-recipient-recovery-pool tests.
2. Root-cause each bug with code citations.
3. Fix each with the smallest product change that keeps every guarantee. Commit each fix separately. Make the RED tests GREEN.
4. Remove the harness skip of the final recipient lull in tests/fixtures/startup-discovery/healthy-grid.ts (see the comment Track K corrected in 86dc4004), and commit that separately.
5. Grid acceptance, with the skip removed. Each of these must pass, including persisted close, reopen and continued gameplay:
   - 5, 8 and 12 rollovers with STARTUP_HEALTHY_GRID_POOL_LULL=1;
   - 8 rollovers with STARTUP_HEALTHY_GRID_POOL_LULL=concurrent;
   - 8 rollovers with STARTUP_HEALTHY_GRID_PRESENTATION=1.
   Also show with one paired comparison that seal, adoption, install and lull timings didn't regress.

GUARANTEES
- The golden-path guarantees G1–G28 are listed in <evidence>/track-r/GUARANTEES.md. Never weaken any of them.
- In your report, argue each guarantee your change touches, as Track K's RESULT.md §3.2 does.
- In particular, never let a reopened room admit moves before its readiness and recovery state is genuinely re-established; fix the condition, don't bypass it.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a fix cannot keep a guarantee, stop, write down the counterexample and report. Don't work around it.

PARALLEL WORK
Track R3 is rewriting retirement into a single-database watermark design on another branch (worktree-agent-aeb6ebdfc4584ace2). It will rebase onto whatever you land. Keep your change minimal and local to the two bugs: no restructuring of retirement or maintenance code. List every file and function you touched.

HOW TO RUN THINGS
- Grid bench recipe:
  - Build a bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`. The outdir must not exist.
  - Run: `STARTUP_HEALTHY_GRID_ROLLOVERS=<n> STARTUP_HEALTHY_GRID_POOL_LULL=1 STARTUP_EVIDENCE=<dir> STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<outdir> pnpm exec playwright test --config tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g "healthy native Grid integrates"`.
  - Summarize with `python3 <evidence>/track-k/bench/summary.py <dir>/report.json`.
- The bundle reads canonical, storage, storage-browser and compaction from dist, and node, protocol-v3 and seal from src.
  - Build dists in your worktree before bundling: `pnpm --filter @ts-drp/<pkg> build` for canonical, protocol-v3, compaction, storage, storage-browser, in that order. Compaction's build reads protocol-v3's dist.
- The Grid build imports untracked files under .logs/bounded-storage-lifecycle/r8-warm-capacity-01/. Copy that directory from the main checkout into your worktree, with the same path. Never commit it.
- Tests: run vitest from the repo root with `--exclude ".claude/**" --no-coverage`.
  - Compare suites per test against the base: node, plus the storage-node retirement tests.
  - Many RED/governance tests already fail on this branch, so judge only passed→failed changes, and rerun alone anything that looks like a timeout.
  - The machine is heavily loaded (load average 30–120), so expect timeouts, and use interleaved pairs for any timing claim.

HARD RULES
- `pnpm -r typecheck` must end at 0 errors. Run prettier on new files.
- Never run bare `tsc -p` without `--noEmit`. Compiled .js next to .ts shadows sources; the guard is `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into your own scratch directory: <evidence>/track-l/
- Never delete logs.
- Don't kill processes you didn't start.
- Don't touch the main checkout, except to copy the .logs bench inputs out of it.
- Commit only on your own worktree branch. Never push.
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Keep PROGRESS.md in <evidence>/track-l/ current, and put the final write-up in RESULT.md there.

FINAL REPORT
- The commit list.
- For each bug:
  - reproduction;
  - root cause with code citations, including whether K's lead was right;
  - the fix and why it is safe;
  - the guarantee argument.
- Per-test suite diff against base.
- Typecheck result.
- A Grid acceptance table: each run, pass/fail, per-rollover costs.
- What remains, and the risks.

### Follow-up instruction — Tell Track L about repo records (2026-10-19 23:36 UTC)

New on codex/phase3a1b-p6-golden-path: commit 1c6a8259 adds docs only, no code. You can rebase onto it whenever convenient.

- The G1–G28 checklist is now at specs/bounded-storage-lifecycle/golden-path-guarantees.md. Cite it in your guarantee argument.
- Your plan is recorded in docs/realtime-latency/tracks/22-track-l-reopen-and-close/README.md. When you finish, add your final write-up there as RESULT.md, as well as in your scratchpad. Write local paths as `<evidence>/...` (that placeholder stands for the scratchpad root). I'll update the decision log when I merge.

### Report returned by the agent (2026-10-20 01:31 UTC)

#### Track L report: reopen admission failure and close race

Both bugs are fixed in the product. The harness skip of the final recipient lull is removed, and every Grid acceptance run passed, including persisted close, reopen and continued gameplay. `pnpm -r typecheck` ends at 0 errors, and the suite diff against base has no passed→failed tests. Nothing was pushed.

- Branch: `track-l-reopen-close-fixes`, in worktree `<worktree agent-a90ae1ab4635254fc>/`, fast-forwarded to 1c6a8259.
- Full write-up:
  - committed at `docs/realtime-latency/tracks/22-track-l-reopen-and-close/RESULT.md`;
  - a copy at `<evidence>/track-l/RESULT.md`, which also lists the docs commit hash;
  - `<evidence>` is `<evidence>`.
- PROGRESS.md in `<evidence>/track-l/` is current.

##### Commits (oldest first)

| commit | what |
|---|---|
| dcab6d12 | RED tests for reopen admission and the orderly-close repair. File: `tests/recipient-lull-reopen-close-native.test.ts` (new) |
| dd70af0c | RED test for an orderly close whose own revoked transport refuses a retained send |
| f9828cd0 | Fix, bug 2: an orderly close cancels the retained publication it is serving |
| 2cb1a9fc | Fix, bug 1: a reopened recipient discharges its completed-retirement halt |
| 504e4035 | Harness: runs the final recipient lull in the Grid bench again (`healthy-grid.ts`, `recipientLull = lull`) |
| 9379fc48 | Bug 1 follow-up: skips the post-resume retained request once the room is closing |
| 88467723 | docs: RESULT.md |

##### Bug 1: no reopened recipient admits the creator's next move

**Reproduction.** Test 1 runs five rollovers with lulls on native SQLite and Keychain. The last recipient lull is `maintained` and completes the retirement through epoch 4 at epoch 5, which the test asserts from the stored control. After a persisted close and reopen, the creator issues a move. At base the recipient never admits it (`LULL_REOPEN_REMOTE_ADMISSION_TIMEOUT`).

**Root cause** (line numbers at base, verified with instrumentation):
1. Reopen gets a reconstruction receipt (creator-adoption.ts:2923).
2. Activation sees the completed control (v3-live.ts:20908-20923) and sets `operationAdmissionHalted`.
3. Halted ingress is rejected (v3-live.ts:7562).
4. Only a creator can discharge the halt: `prepareCurrentCreatorOrdinaryReadiness` returns early for receive-only peers (v3-room.ts:5645). The discharge itself is `runCreatorOrdinaryReadinessMaintenance`, whose completed-resume path clears the halt (v3-live.ts:11273 and 11390-11400).
5. A recipient has no such path, and its install is refused too. The recipient resolver's `creatorCloseRegistration(…, "recipient")` refuses a halted plane (v3-live.ts:19573). So the next install fails with "creator recipient current authority is unavailable" (creator-adoption.ts:1029).

**K's lead.** The trigger is right: the completed control satisfies `creatorRetirementResumeRequested` and halts the plane. The mechanism is wrong: `needsOrdinaryReadinessRecovery` is only the creator's hook, and nothing on a recipient calls it. "The next install clears it" is also wrong: that install is refused.

**Fix.** A recipient twin of the creator's completed-resume discharge:
- **When it runs:** once, at reopen, in the lifecycle FIFO, before startup reports ready. Local issues are held meanwhile.
- **What it runs:** the original received reconstruction, with `requireClosedWorkflowCompletion = true` and at least one sealed census.
- **Admission check:** the creator's `completedRequestMatches` predicate, term for term, re-checked at every boundary.
- **When the halt clears:** only after every admitted hold has joined.
- **Afterwards:** the room requests retained history, so moves dropped while halted are re-fetched through authentication.
- **What it leaves alone:** an active intent, or a request that doesn't match, returns `"deferred"` and stays halted. Installs and lulls still cannot resolve a halted plane.

##### Bug 2: the persisted close fails on the final lull's retained repair

**Reproduction.**
- Test 2: publisher calls in flight during an orderly close reject at base with `publication-state-unknown` and `not-active`.
- Test 3: a send refused by the close's own revoked transport rejects with `publish-failed`.

**Root cause.**
1. The retained publisher throws on every non-ok result (v3-room.ts:4103-4112).
2. `closeSession` revokes the transport synchronously first, and only later retires the plane (v3-room.ts:6902, 3525, 3540; v3-live.ts:21405 and 7152).
3. So a repair in flight during the close ends non-ok by construction. The bench transport counts that rejection as a fault, and its close join fails.

**Decision: cancel.**
- **Rule:** during this session's own orderly close (`sessionCloseTask` set, no `terminalFailure`), the outcomes `not-active`, `publication-state-unknown` and `publish-failed` return as cancelled.
- **Still rejected:** `store-failed` and `record-rejected`, everything outside a close, and everything after a terminal failure. Test 2's guards assert this.
- **Why not join:** it would invert the revoke-first close order (G4), could hang a close on a remote peer, and fails anyway when the requester is closing too.
- **Why not "not-active is never a fault":** that would hide real faults outside a close.
- **Nothing is lost:** a requester that misses the repair asks for retained history again when it next opens (v3-room.ts:4194).

##### Guarantees

RESULT.md §3.4 argues each touched guarantee with its evidence, citing `specs/bounded-storage-lifecycle/golden-path-guarantees.md`. The touched ones are G2, G3, G4, G5, G7, G9, G10, G14, G15, G21, G22, G23, G24, G26 and G28, plus the "reopened room" rule. The rest are untouched.
- No guarantee is weakened, no limit changed, and no existing test, registry or frozen artifact edited.
- The governance counts stay at 3 and 3, and creator-recipient-recovery-pool passes 6/6.

##### Suite diff against base (packages and tests/fixtures temporarily reverted to 1c6a8259, then restored)

| set | base pass/fail/skip | head pass/fail/skip | passed → failed |
|---|---|---|---|
| node | 1023/48/0 | 1022/48/0 | 0 |
| storage-node retirement (6 files) | 158/49/2 | 158/49/2 | 0, identical per test |
| root room (19 files) | 58/135/4 | 61/132/4 | 0; the 3 new tests went from failing to passing |

- The node difference is `interval-reconnect`, which failed to load in the head run. It passes alone; most likely a test in the same run was building the node dist at that moment.
- One head root-room run hung with idle workers, so I stopped it (it was my own process). A rerun with a verbose reporter completed normally.

##### Typecheck and guards

- `pnpm -r typecheck`: exit 0, 0 errors. Two dists had to be built first (the node dist and the network-spike dist); without the network-spike dist, `examples/network-spike` reports 71 module-resolution errors.
- The shadow guard exits 0, and the new files are prettier-clean.

##### Grid acceptance (skip removed; all passed)

The final recipient lull was `maintained` in every lull run. Times are in ms. Means are over rollovers; "final" is the lull after the last rollover.

| run | seal mean / max | adopt mean | install mean | recipient lull mean / final | close C / R | reopen C / R |
|---|---|---|---|---|---|---|
| r5, LULL=1 | 265 / 511 | 471 | 347 | 1000 / 1423 | 7.5 / 8.3 | 1084 / 963 |
| r8, LULL=1, pair 1 | 238 / 370 | 453 | 368 | 1163 / 1498 | 4.0 / 3.7 | 1164 / 1057 |
| r8, LULL=1, pair 2 | 225 / 308 | 454 | 306 | 1035 / 1190 | 2.7 / 3.1 | 905 / 833 |
| r12, LULL=1 | 275 / 429 | 527 | 436 | 1417 / 1725 | 7.5 / 8.3 | 1283 / 1143 |
| r8, LULL=concurrent | 283 / 405 | 571 | 372 | 1331 / 1516 | 3.1 / 3.8 | 1155 / 1218 |
| r8, PRESENTATION=1 + LULL=1 | 261 / 454 | 488 | 366 | 1186 / 1676 | 3.3 / 3.3 | 1195 / 1174 |
| r8, PRESENTATION=1 only (no lull) | 1376 / 2886 | 428 | 966 | – | 0.9 / 0.6 | 528 / 790 |
| r8, LULL=1, final HEAD 9379fc48 | 220 / 285 | 431 | 333 | 1093 / 1372 | 2.8 / 3.6 | 976 / 915 |

- The other runs used a bundle built at 504e4035, one commit before the final HEAD.
- The slow seal in the no-lull run is that configuration's inline maintenance, not this change: a base/fix no-lull pair shows the same costs on both sides.
- Per-rollover costs for every run are in RESULT.md §5.

**Paired comparison** (LULL=1, 8 rollovers, two interleaved pairs; base keeps its skip). Fix/base totals:

| measure | fix / base |
|---|---|
| seal | 0.89 |
| adoption | 0.85 |
| install | 0.92 |
| creator lull | 0.93 |
| recipient lull, rollovers 1–7 | 0.90 |

No regression; the lower fix side is load noise. The cost of the change is:
- recipient reopen: about 0.4–0.6 s more (398–436 → 833–1057 ms), only after a final lull;
- close: about 2–3 ms more.

Without a lull, close and reopen are unchanged.

##### What remains, and the risks

1. **A third bug, not fixed (R3's area).** With `LULL_REOPEN_EPOCHS=4`, the recipient's reopen is refused with RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE. It comes from `acquireCreatorSnapshotRetirementReconstructionRequest`, which passes no `previousCertificate`. The same happens at base and at HEAD; 5 and 8 epochs pass. It fails closed.
2. **An active retirement intent at recipient reopen still halts the recipient permanently, as at base.** A receive-only peer has no way to resume an active intent.
3. **Moves arriving during the ~0.5 s resume are dropped, then re-fetched** through retained history rather than queued. They arrive one round trip late.
4. **A close during a reopened room's startup transition is recorded as a terminal failure.** This follows the creator rebase transition's existing shape. In that narrow window the bug 2 cancellation doesn't apply, so a strict transport would count a fault. The Grid never closes during startup.
5. **Pre-existing failure:** creator-ordinary-readiness-producer "uses the genuine same-head pair..." fails at base as well.

##### Files and functions touched

| file | functions |
|---|---|
| `packages/node/src/v3-room.ts` | retained publisher callback; new recipient resume block; diagnostics startup waiter; import |
| `packages/node/src/v3-live.ts` | recipient resolver; `runCreatorReceivedRecoveryMaintenance`; `creatorCloseRegistration` |
| `packages/node/src/creator-adoption.ts` | `runReceivedRecoveryTurnoverPasses` (input field); new `creatorRecipientRetirementResumeRequested`; `maintainCreatorRecipientRecoveryPool` (`resume`) |
| `packages/node/src/creator-close.ts` | `V3CreatorCloseRegistration.runReceivedRecoveryMaintenance` type |
| `packages/node/src/internal/creator-closed-rollback-data.ts` | `reconcileCreatorReceivedSnapshotRecoveryRoles` (flag forwarded) |
| `packages/node/src/internal/creator-recipient-provenance.ts` | resolver type; `resolveCreatorRecipientRegistration` |
| `tests/fixtures/startup-discovery/healthy-grid.ts` | `runHealthyGrid` |

The new test file is `tests/recipient-lull-reopen-close-native.test.ts`.

The untracked `.logs/` bench inputs were not committed. I didn't edit the track README's "Outcome" line, since you're updating the decision log at merge.

Evidence, all under `<evidence>/track-l/`:
- `bench/acceptance.log`, `bench/compare-pairs.txt`, `bench/nolull-pair.log`
- `tests/diff-base-head.txt`, `typecheck-final2.log`
- `red-base-final.log`, `red-base-revoked.log`, `evidence-lead-*.log`, `fix1-evidence.log`, `epochs-4-head.log`, `epochs-8-head.log`
